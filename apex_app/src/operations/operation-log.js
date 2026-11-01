// Audit log: one JSON line per Cognitive Controller operation. Append-only.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { JsonlStore } from '../memory/jsonl-store.js';
import { StoreError } from '../errors.js';
import { OPERATION_SCHEMA, OUTCOME_VALUES } from '../outcomes.js';
import { containsSecret, redactSecrets } from '../security/secrets.js';
import { shortId } from '../util.js';

const MAX_HEALTH_SAMPLES = 20;

function validateOperation(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return 'not an object';
  if (op.schema !== OPERATION_SCHEMA) return 'unsupported schema';
  if (typeof op.id !== 'string' || op.id.length === 0) return 'missing id';
  if (!OUTCOME_VALUES.has(op.status)) return 'unknown status';
  return null;
}

// The audit record is evidence, and its output field can quote untrusted model text. A
// credential-like substring is removed at the write boundary and the record says so, so a
// later reader can tell the stored text is minimized rather than verbatim. Everything that
// identifies the event - status, capability, ids, retrieval, errors, timing - is unchanged.
// Detection is heuristic; see security/secrets.js for the patterns and their limits.
function minimizeOutput(op) {
  if (typeof op.output !== 'string' || op.output.length === 0) return op;
  if (!containsSecret(op.output)) return op;
  return { ...op, output: redactSecrets(op.output), outputMinimized: true };
}

export class OperationLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.store = new JsonlStore(filePath, { validateRecord: validateOperation });
  }

  async append(operation) {
    await this.store.append(minimizeOutput(operation));
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
    // Stated explicitly so a reader cannot mistake a clean parse for tamper evidence.
    integrity: { mode: 'parse-only', hashChain: false, signature: false, externalAnchor: false },
    attention: corrupt.length > 0 || anomalyCount > 0,
  };
}
