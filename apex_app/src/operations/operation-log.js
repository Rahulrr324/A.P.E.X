// Audit log: one JSON line per Cognitive Controller operation. Append-only.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { JsonlStore } from '../memory/jsonl-store.js';
import { StoreError } from '../errors.js';
import { OPERATION_SCHEMA, OUTCOME_VALUES, Outcome } from '../outcomes.js';
import { findSecrets, redactSecrets, maskSecretLeaves, maskSecretLeaf, containsSecret, SECRET_OMITTED } from '../security/secrets.js';

import { shortId } from '../util.js';

const MAX_HEALTH_SAMPLES = 20;

function validateOperation(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return 'not an object';
  if (op.schema !== OPERATION_SCHEMA) return 'unsupported schema';
  if (typeof op.id !== 'string' || op.id.length === 0) return 'missing id';
  if (!OUTCOME_VALUES.has(op.status)) return 'unknown status';
  return null;
}

// The audit record is evidence, and its text fields can quote untrusted model or user input. The
// whole record, not one field, passes through the credential mask at this write boundary: every
// string leaf is tested by content, so a value that arrived in a field no one declared still cannot
// reach disk unfiltered. Detection is heuristic; see security/secrets.js for the patterns and their
// limits. Everything that identifies the event - status, capability, ids, retrieval, errors, timing -
// is unchanged, and the caller's own object is never rewritten by persistence.
//
// `output` keeps its own rule because it is the model's answer as the user saw it: prose stays and
// only the credential-like substring is removed. A private key is the exception - its pattern names
// only the header, so removing the header would leave the key body on disk and the whole field is
// omitted instead.
function minimizeOutputField(op) {
  if (typeof op.output !== 'string' || op.output.length === 0) return null;
  const kinds = findSecrets(op.output);
  if (kinds.length === 0) return null;
  if (kinds.includes('private-key')) return { output: SECRET_OMITTED };
  const redacted = redactSecrets(op.output);
  if (redacted === op.output) return null;
  return { output: redacted };
}

// A record's fields are read one at a time, and any of them can be a value this build cannot read:
// a getter that throws, a Proxy that refuses. The shell is the last boundary, so it never lets such
// a read take the whole record with it - an unreadable field becomes absent metadata.
function peek(object, key) {
  try {
    return object?.[key];
  } catch {
    return undefined;
  }
}

export function minimizeOperation(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    // There is no metadata to keep, so there is no safe body to fall back to. Fail closed: the
    // caller reports the audit failure, and a line no reader can validate is worse than no line.
    throw new StoreError('audit record is not an object; nothing was written to the audit log');
  }
  try {
    const { ...record } = operation;
    const minimized = minimizeOutputField(operation);
    if (minimized) {
      record.output = minimized.output;
      record.outputMinimized = true;
    }
    // The masked copy, not the shallow one, is what reaches the log: masking a leaf means replacing
    // its whole subtree, so the filtered value only exists in the object the walk returned.
    // `output` is skipped only when this function has already filtered it - a non-string output is
    // still a field that can carry a credential, and skipping it unasked would be a hole.
    const masked = maskSecretLeaves(record, { skipTopLevel: minimized ? ['output'] : [] });
    if (masked.masked > 0) masked.value.secretsMasked = true;
    if (masked.boundReached) masked.value.auditMaskBoundReached = true;
    return masked.value;
  } catch {
    return auditShell(operation);
  }
}

// A record whose body could not be minimized is still an event that happened. The shell keeps the
// structural facts that identify it and drops every text-bearing field, so the fallback can never
// serialize the input it just failed to filter. The markers say what was lost.
const AUDIT_SHELL_OMITTED = '[omitted: audit minimization failed]';
const AUDIT_SHELL_FIELDS = Object.freeze([
  'schema', 'app', 'stage', 'id', 'requestedAt', 'finishedAt', 'origin', 'capability', 'status',
  'decision', 'backend', 'model',
]);

// Only scalars of a bounded length survive, so a hostile or unexpected metadata field cannot
// smuggle text into the record the shell was written to avoid.
function shellField(key, value) {
  if (key === 'schema') return Number.isInteger(value) ? value : OPERATION_SCHEMA;
  if (key === 'status') return OUTCOME_VALUES.has(value) ? value : Outcome.AUDIT_INTEGRITY_FAILED;
  if (key === 'id') return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : '[id unavailable]';
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return null;
  return maskSecretLeaf(key, value);
}

function auditShell(op) {
  const shell = { auditMinimizationFailed: true };
  try {
    for (const key of AUDIT_SHELL_FIELDS) shell[key] = shellField(key, peek(op, key));
    shell.request = AUDIT_SHELL_OMITTED;
    shell.output = AUDIT_SHELL_OMITTED;
    shell.prompt = AUDIT_SHELL_OMITTED;
    shell.retrievalCount = Array.isArray(peek(op, 'retrieval')) ? peek(op, 'retrieval').length : 0;
    shell.stepCount = Array.isArray(peek(op, 'steps')) ? peek(op, 'steps').length : 0;
    // A task step is identified by its task and step ids; keeping that linkage means a shell is
    // still findable as evidence that the step ran, rather than reading as a missing record.
    const task = peek(op, 'task');
    if (task && typeof task === 'object') {
      const ids = ['id', 'stepId']
        .map((key) => {
          const value = peek(task, key);
          return typeof value === 'string' && value.length <= 200 ? maskSecretLeaf(key, value) : null;
        });
      if (ids.some((value) => value !== null)) shell.task = { id: ids[0], stepId: ids[1] };
    }
    shell.errors = [{
      stage: 'audit',
      code: 'MINIMIZATION_FAILED',
      message: 'the audit record could not be minimized safely; its body is not persisted',
    }];
    return shell;
  } catch {
    // Even the bounded shell could not be built - the input is not a readable object. Failing
    // closed is the audit-integrity contract: no line, and the caller discloses the failure.
    throw new StoreError('audit record could not be minimized or reduced to a shell; nothing was written to the audit log');
  }
}

export class OperationLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.store = new JsonlStore(filePath, { validateRecord: validateOperation });
  }

  async append(operation) {
    await this.store.append(minimizeOperation(operation));
  }

  async list({ limit = 10 } = {}) {
    const { records, corrupt } = await this.store.load();
    return { records: records.slice(-Math.max(1, limit)).reverse(), corrupt: corrupt.length };
  }

  // Read-only diagnostics view: valid records plus the lines skipped as corrupt.
  // Unreadable storage still throws a StoreError (unavailable, not empty).
  async inspect() {
    return this.store.load();
  }

  async status() {
    const { records, corrupt } = await this.store.load();
    return { records: records.length, corrupt: corrupt.length };
  }

  // Read-only audit integrity summary. It loads the log, counts what parsed, and reports
  // damage alongside it. It writes no audit record and never reads a request or output
  // body; only structural facts are counted. Parse success is not proof of authenticity:
  // the log has no hash chain, signature, or external anchor, and this summary says so
  // instead of implying tamper evidence it cannot provide.
  async health() {
    let loaded;
    try {
      loaded = await this.store.load();
    } catch (err) {
      return summarizeAuditHealth(null, [], {
        path: this.filePath,
        detail: err?.message ?? String(err),
      });
    }
    return summarizeAuditHealth(loaded.records, loaded.corrupt, { path: this.filePath });
  }

  // One audit record by its exact id, read line by line so the scan stops as soon as the record is
  // found. Absence is different: it takes a read to the end, so it is never inferred from truncated
  // evidence, and `inspected` reports what the answer needed while `stoppedEarly` says whether that
  // was fewer lines than the log holds. Damaged lines are counted and never used as evidence. A log
  // that does not exist yet is a real empty answer; a log that cannot be read throws, because it
  // establishes nothing either way. The first line in append order is the one returned - an id that
  // appears twice is damage, which `health()` reports, and the earlier append is the record that was
  // actually written.
  async findById(id) {
    const result = { found: false, record: null, inspected: 0, corrupt: 0, stoppedEarly: false };
    if (typeof id !== 'string' || id.length === 0) return result;

    const stream = fs.createReadStream(this.filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let streamError = null;
    stream.on('error', (err) => { streamError = err; });
    try {
      for await (const line of lines) {
        result.inspected += 1;
        if (line.trim() === '') continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          result.corrupt += 1;
          continue;
        }
        if (validateOperation(record)) {
          result.corrupt += 1;
          continue;
        }
        if (record.id !== id) continue;
        result.found = true;
        result.record = record;
        result.stoppedEarly = true;
        break;
      }
    } catch (err) {
      // The interface forwards a stream failure as a rejection; either way it is the same signal.
      streamError = streamError ?? err;
    } finally {
      lines.close();
      stream.destroy();
    }

    if (streamError && !(streamError.code === 'ENOENT' && result.inspected === 0)) {
      throw new StoreError(`cannot read ${path.basename(this.filePath)}: ${streamError.code || streamError.message}`);
    }
    return result;
  }

  // Which of these task steps have an operation record of their own. The log is read
  // line by line and the scan stops as soon as every wanted record has been found, so the
  // common case costs one pass over the recent lines rather than a parse of the whole
  // history. Absence is different: it can only be established by reading to the end, so
  // the scan is never cut short and the answer is never built from truncated evidence.
  // `inspected` reports how many lines the answer needed, and `stoppedEarly` says whether
  // that was fewer than the log holds. Damaged lines are counted and never used as
  // evidence; a log that cannot be read throws, because it establishes nothing.
  async missingTaskStepRecords(taskId, steps) {
    const wanted = new Map();
    const missing = [];
    for (const step of steps ?? []) {
      const operationId = typeof step?.operationId === 'string' && step.operationId.length > 0 ? step.operationId : null;
      if (operationId === null) missing.push(step?.id);
      else wanted.set(operationId, step.id);
    }
    const result = { missing, inspected: 0, corrupt: 0, stoppedEarly: false };
    if (wanted.size === 0) return result;

    const stream = fs.createReadStream(this.filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let streamError = null;
    stream.on('error', (err) => { streamError = err; });
    try {
      for await (const line of lines) {
        result.inspected += 1;
        if (line.trim() === '') continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          result.corrupt += 1;
          continue;
        }
        if (validateOperation(record)) {
          result.corrupt += 1;
          continue;
        }
        if (record.capability !== 'task.step') continue;
        const stepId = wanted.get(record.id);
        if (stepId === undefined || record.task?.id !== taskId || record.task?.stepId !== stepId) continue;
        wanted.delete(record.id);
        if (wanted.size === 0) {
          result.stoppedEarly = true;
          break;
        }
      }
    } catch (err) {
      // The interface forwards a stream failure as a rejection; either way it is the same
      // signal, handled after the loop.
      streamError = streamError ?? err;
    } finally {
      lines.close();
      stream.destroy();
    }

    // A log that does not exist yet holds no record, which is a real answer. A read that
    // stopped for any other reason says nothing about the steps it never reached, so it
    // must not be reported as a missing record.
    if (streamError) {
      if (streamError.code === 'ENOENT' && result.inspected === 0) {
        result.missing.push(...wanted.values());
        return result;
      }
      throw new StoreError(`cannot read ${path.basename(this.filePath)}: ${streamError.code || streamError.message}`);
    }
    result.missing.push(...wanted.values());
    return result;
  }
}

// A record written before the audit write boundary masked every field can still hold a credential in
// its stored bytes, and historical records are never rewritten. So the leakage is reported instead of
// quietly left out of the picture: this counts the readable records that contain credential-shaped
// text and names nothing but the short operation id. No field name, value, or matched substring is
// returned, because the pattern that matched describes the secret. Bounded because a read-only report
// must not become a full-history scan the user cannot stop, and `partial` says when the bound was hit.
export const MAX_CREDENTIAL_SCAN_RECORDS = 20000;

export function scanCredentialShapedRecords(records, { max = MAX_CREDENTIAL_SCAN_RECORDS, sampleLimit = MAX_HEALTH_SAMPLES } = {}) {
  const result = { matched: 0, scanned: 0, partial: false, samples: [] };
  for (const record of records ?? []) {
    if (result.scanned >= max) {
      result.partial = true;
      break;
    }
    result.scanned += 1;
    let text;
    try {
      text = JSON.stringify(record);
    } catch {
      continue;
    }
    if (!containsSecret(text)) continue;
    result.matched += 1;
    const id = typeof record?.id === 'string' ? record.id : null;
    if (id && result.samples.length < sampleLimit) result.samples.push(shortId(id));
  }
  return result;
}

export function summarizeAuditHealth(records, corrupt = [], { path = null, detail = null } = {}) {
  if (!Array.isArray(records)) {
    return {
      path,
      state: 'unavailable',
      inspected: false,
      complete: false,
      detail,
      records: null,
      corruptLines: null,
      corrupt: [],
      outcomes: null,
      anomalies: { count: null, samples: [], truncated: false },
      credentials: null,
      integrity: { mode: 'parse-only', hashChain: false, signature: false, externalAnchor: false },
      attention: true,
    };
  }

  const outcomes = {};
  for (const status of OUTCOME_VALUES) outcomes[status] = 0;
  const ids = new Set();
  const duplicateIds = new Set();
  for (const record of records) {
    outcomes[record.status] = (outcomes[record.status] ?? 0) + 1;
    if (ids.has(record.id)) duplicateIds.add(record.id);
    ids.add(record.id);
  }

  const samples = [];
  let anomalyCount = 0;
  const anomaly = (message) => {
    anomalyCount += 1;
    if (samples.length < MAX_HEALTH_SAMPLES) samples.push(message);
  };

  for (const id of duplicateIds) anomaly(`operation [${shortId(id)}] appears more than once in the log`);
  for (const record of records) {
    if (typeof record.requestedAt !== 'string' || Number.isNaN(Date.parse(record.requestedAt))) {
      anomaly(`operation [${shortId(record.id)}] has no valid requestedAt timestamp`);
    }
    if (record.finishedAt !== undefined
      && (typeof record.finishedAt !== 'string' || Number.isNaN(Date.parse(record.finishedAt)))) {
      anomaly(`operation [${shortId(record.id)}] has an invalid finishedAt timestamp`);
    }
  }

  // A security finding about stored bytes, kept beside the damage counts rather than folded into
  // them: a credential in an old record says nothing about whether the log can be read. It does
  // raise `attention`, because that field's contract is "this report needs the user", and a value
  // that is on disk for anyone who can read the file needs them even when every line parses.
  const credentials = scanCredentialShapedRecords(records);

  return {
    path,
    state: corrupt.length > 0 ? 'damaged' : 'ok',
    inspected: true,
    complete: corrupt.length === 0,
    detail: null,
    records: records.length,
    corruptLines: corrupt.length,
    corrupt: corrupt.map((entry) => ({
      line: entry.line,
      reason: entry.reason,
      truncatedTail: Boolean(entry.truncatedTail),
    })),
    outcomes,
    anomalies: { count: anomalyCount, samples, truncated: anomalyCount > samples.length },
    credentials,
    // Stated explicitly so a reader cannot mistake a clean parse for tamper evidence.
    integrity: { mode: 'parse-only', hashChain: false, signature: false, externalAnchor: false },
    attention: corrupt.length > 0 || anomalyCount > 0 || credentials.matched > 0,
  };
}
