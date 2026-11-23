// T-38 Step 3 (2026-11-21): the cross-ledger causal trace and memory search.
//
// APEX keeps a separate append-only ledger for each thing it knows how to do: what an operation was
// asked and what it did (operations.jsonl), what a cognitive run recalled and concluded
// (cognition-runs.jsonl), what the Council evaluated (council.jsonl), what the task graph did
// (tasks.jsonl), what a sandbox check measured (workshop-sandbox/<candidate>/verification.json), and
// what the Executive Control Plane decided (the authorization every operation carries).
//
// Six ledgers that each tell the truth about their own slice, and no single view that puts them in
// order. This module is that view, and it is deliberately read-only and deliberately literal:
//
//   * Every entry is a record that exists. Nothing is inferred from a record's absence beyond saying
//     that it is absent, and an absent ledger is reported as `missing` rather than as an empty step
//     in a chain that looks complete.
//   * The ordering is time. Records carry their own timestamps; this module sorts them and says so
//     when two records claim the same instant, rather than inventing a tiebreak that would imply a
//     causality the records do not state.
//   * A link is a link the records actually carry. A cognition run names its task; the Council
//     session names the run's intent as its objective; the task store names the task. Where a link
//     is a match rather than a foreign key the step says `linkedBy` so the reader can judge how
//     strong the connection is.
//
// Nothing in this module writes. The trace of a run is not a new record of that run; it is a reading
// of records that already exist.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const TRACE_SCHEMA = 'apex.memory.trace/1';
export const SEARCH_SCHEMA = 'apex.memory.search/1';

// The kinds a caller may name explicitly. Each one is a ledger this module can read.
export const SEARCH_KINDS = Object.freeze([
  'memory', 'cognition_run', 'council_session', 'task', 'workshop_verification', 'workshop_apply', 'ecp_audit',
  // T-43: a git checkpoint is a record with an id of its own and a place in a chain, so it is a ledger
  // here rather than a private file only the git panel can read.
  'git_checkpoint',
]);

// The epistemic statuses a memory record can carry. The filter is offered on the search surface
// because the difference between a fact and a candidate association is the thing worth filtering on.
export const EPISTEMIC_STATUSES = Object.freeze([
  'asserted', 'observed', 'inferred', 'candidate_association', 'model_output', 'unverified', 'contradicted',
]);

const MAX_SEARCH_RESULTS = 200;
const MAX_TRACE_ENTRIES = 400;
const MAX_QUERY_CHARS = 200;

// --------------------------------------------------------------------------------- reading ---

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { present: false, records: [], corrupt: 0 };
    throw err;
  }
  const records = [];
  let corrupt = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed);
      else corrupt += 1;
    } catch {
      // A corrupt line is counted, never guessed at. The count is surfaced so a reader knows the
      // ledger is damaged rather than believing it is short.
      corrupt += 1;
    }
  }
  return { present: true, records, corrupt };
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// A stable, short, non-secret identifier for a search result: the ledger plus a digest of the
// record's own identity. It is derived, so the same record always answers to the same id.
function resultId(kind, identity) {
  return `${kind}:${sha256(String(identity)).slice(0, 12)}`;
}

// Every staged candidate has a directory under this name, and each directory that holds a
// verification.json is a verification worth searching. The directory is read only.
// T-39 Step 1: the Workshop's apply ledger, read in place. It holds both kinds a chain needs - an
// apply and the rollback that undid it - and it is the only ledger that records the digests that make
// a write into the owner's tree checkable after the fact.
function readWorkshopApplies(dataDir) {
  const { present, records, corrupt } = readJsonl(path.join(dataDir, 'workshop-applies.jsonl'));
    // T-40 Step 2: a changeset is ONE ledger record that touches several files, so a single flat
    // record cannot describe it - there is no `relativePath` and no `candidateId` at the top level.
    // It is expanded into one entry per file here, at the point the ledger is read, so every reader
    // above - search, chain assembly, counts - keeps working with the per-file shape it already
    // understood. The alternative was teaching each of those readers about batches, and a chain that
    // has to branch on record kind is a chain that will eventually forget one.
    const expanded = [];
    for (const r of records) {
      if (r.kind === 'changeset_apply' || r.kind === 'changeset_rollback') {
        const isRollback = r.kind === 'changeset_rollback';
        // A changeset rollback record written before this version has no per-file candidateId. The
        // apply record for the same batch does, so it is used as the fallback: a chain must link by
        // candidate, and a batch written yesterday is not less readable today.
        const boundCandidates = new Map();
        if (isRollback) {
          const applied = records.find((candidate) => candidate.kind === 'changeset_apply' && candidate.changesetId === r.changesetId);
          for (const file of Array.isArray(applied?.files) ? applied.files : []) {
            boundCandidates.set(file.relativePath, file.candidateId ?? null);
          }
        }
        for (const file of Array.isArray(r.files) ? r.files : []) {
          expanded.push({
            kind: 'workshop_apply',
            recordKind: r.kind,
            at: r.at ?? null,
            id: r.changesetId ?? null,
            applyId: r.changesetId ?? null,
            rollbackId: isRollback ? (r.changesetRollbackId ?? null) : null,
            candidateId: file.candidateId ?? null,
            relativePath: file.relativePath ?? null,
            beforeSha256: isRollback ? (file.restoredSha256 ?? null) : (file.beforeSha256 ?? null),
            appliedSha256: file.appliedSha256 ?? null,
            restoredSha256: isRollback ? (file.restoredSha256 ?? null) : null,
            existedBefore: file.existedBefore ?? null,
            rolledBack: isRollback,
            // The batch identity travels with every file, so a chain can say "file 1 of a 2-file
            // changeset" rather than pretending the write was independent.
            changesetId: r.changesetId ?? null,
            changesetFileCount: r.fileCount ?? null,
            changesetTitle: r.title ?? null,
            record: r,
          });
        }
        continue;
      }
      expanded.push({
        kind: 'workshop_apply',
        recordKind: r.kind ?? null,
        at: r.at ?? null,
        id: r.applyId ?? r.rollbackId ?? null,
        applyId: r.kind === 'rollback' ? (r.applyId ?? null) : (r.applyId ?? null),
        rollbackId: r.rollbackId ?? null,
        candidateId: r.candidateId ?? null,
        relativePath: r.relativePath ?? null,
        beforeSha256: r.beforeSha256 ?? null,
        appliedSha256: r.appliedSha256 ?? null,
        restoredSha256: r.restoredSha256 ?? null,
        existedBefore: r.existedBefore ?? null,
        rolledBack: r.kind === 'rollback' ? true : false,
        changesetId: null,
        changesetFileCount: null,
        changesetTitle: null,
        record: r,
      });
    }
    return {
      present,
      corrupt,
      records: expanded,
    };
}

function readWorkshopVerifications(dataDir) {
  const sandboxDir = path.join(dataDir, 'workshop-sandbox');
  let names;
  try {
    names = fs.readdirSync(sandboxDir);
  } catch {
    return { present: false, records: [], corrupt: 0 };
  }
  const records = [];
  for (const name of names) {
    if (!name.startsWith('wsc-')) continue;
    const record = readJson(path.join(sandboxDir, name, 'verification.json'));
    if (!record) continue;
    const candidate = readJson(path.join(sandboxDir, name, 'candidate.json'));
    // The verification names its candidate and its relative path; the candidate record adds the
    // rationale and the base digest. Both are read, and neither is required: a verification whose
    // candidate record is gone is still a verification that happened.
    records.push({
      kind: 'workshop_verification',
      at: record.at ?? null,
      id: record.id ?? `wsv-${name.slice(4)}`,
      candidateId: record.candidateId ?? (candidate?.candidateId ?? null),
      relativePath: record.relativePath ?? candidate?.relativePath ?? null,
      rationale: candidate?.rationale ?? null,
      verified: record.verified === true,
      passed: record.passed ?? null,
      total: record.total ?? null,
      failed: Array.isArray(record.failed) ? record.failed : [],
      stagedDigest: record.stagedDigest ?? null,
      baseDigest: record.baseDigest ?? null,
      parser: record.parser ?? null,
      // T-41 Step 3: a candidate staged from an Evolution Lab proposal carries the proposal's id on its
      // candidate record. Reading it here is what lets the causal trace follow proposal -> candidate
      // -> verification -> apply without the owner having to match digests by eye.
      sourceProposalId: candidate?.sourceProposalId ?? null,
      sandboxTestResult: record.sandboxTestResult ?? null,
      checks: Array.isArray(record.checks) ? record.checks : [],
      promotion: readJson(path.join(sandboxDir, name, 'promotion.json')),
      ledgerPath: path.join('workshop-sandbox', name, 'verification.json'),
    });
  }
  records.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return { present: true, records, corrupt: 0 };
}

// One reader per kind, so a new kind is a new entry in this table rather than a new branch in five
// places. Each returns normalised records plus whether the ledger exists at all.
function ledgers(dataDir) {
  return {
    memory: () => {
      const { present, records, corrupt } = readJsonl(path.join(dataDir, 'memory.jsonl'));
      return {
        present,
        corrupt,
        records: records.map((r) => ({
          kind: 'memory',
          at: r.createdAt ?? r.at ?? null,
          id: r.id ?? null,
          // `text` is the record's own words. Search matches against this, and the result carries it
          // so a reader can judge the match without a second read.
          text: typeof r.content === 'string' ? r.content : '',
          epistemicStatus: r.epistemicStatus ?? 'asserted',
          source: r.source ?? null,
          tags: Array.isArray(r.tags) ? r.tags : [],
          supersededBy: r.supersededBy ?? null,
          record: r,
        })),
      };
    },
    cognition_run: () => {
      const { present, records, corrupt } = readJsonl(path.join(dataDir, 'cognition-runs.jsonl'));
      return {
        present,
        corrupt,
        records: records.map((r) => ({
          kind: 'cognition_run',
          at: r.at ?? null,
          id: r.runId ?? null,
          runId: r.runId ?? null,
          taskId: r.taskId ?? null,
          intent: typeof r.intent === 'string' ? r.intent : '',
          status: r.status ?? null,
          halted: r.halted === true,
          origin: r.origin ?? null,
          neural: r.neural ?? null,
          stages: r.stages ?? null,
          record: r,
        })),
      };
    },
    council_session: () => {
      const { present, records, corrupt } = readJsonl(path.join(dataDir, 'council.jsonl'));
      return {
        present,
        corrupt,
        records: records.map((r) => ({
          kind: 'council_session',
          at: r.evaluatedAt ?? r.at ?? null,
          id: r.sessionId ?? null,
          sessionId: r.sessionId ?? null,
          objective: r.objective ?? r.input?.objective ?? '',
          status: r.status ?? null,
          // The candidate the Council evaluated, if it resolved one. A deliberation with no
          // candidate is a real outcome and is recorded as null rather than omitted.
          candidate: r.input?.candidate ?? r.candidate ?? null,
          decision: r.synthesis?.decision ?? null,
          record: r,
        })),
      };
    },
    task: () => {
      const { present, records, corrupt } = readJsonl(path.join(dataDir, 'tasks.jsonl'));
      return {
        present,
        corrupt,
        records: records.map((r) => ({
          kind: 'task',
          at: r.at ?? null,
          id: r.taskId ?? null,
          taskId: r.taskId ?? null,
          eventId: r.eventId ?? null,
          type: r.type ?? null,
          goal: r.goal ?? '',
          step: r.step ?? null,
          state: r.state ?? r.to ?? null,
          record: r,
        })),
      };
    },
    workshop_verification: () => readWorkshopVerifications(dataDir),
    workshop_apply: () => readWorkshopApplies(dataDir),
    git_checkpoint: () => readGitCheckpoints(dataDir),
    ecp_audit: () => {
      const { present, records, corrupt } = readJsonl(path.join(dataDir, 'operations.jsonl'));
      return {
        present,
        corrupt,
        records: records.map((r) => ({
          kind: 'ecp_audit',
          at: r.requestedAt ?? r.finishedAt ?? r.at ?? null,
          id: r.id ?? null,
          operationId: r.id ?? null,
          capability: r.capability ?? null,
          origin: r.origin ?? null,
          status: r.status ?? null,
          // The ECP's own decision, as the operation recorded it. `authorization` is what the control
          // plane answered; it is not re-derived here.
          authorization: r.decision ?? r.authorization ?? null,
          request: r.request ?? null,
          output: r.output ?? null,
          steps: Array.isArray(r.steps) ? r.steps : [],
          record: r,
        })),
      };
    },
  };
}

// T-43: the git checkpoint ledger, read in place. A checkpoint is written by the git executive and
// never by this module; this is a reading of it. `restored` is derived from the restore count rather
// than from a separate record, because a checkpoint is one row that changes, not a stream of events.
function readGitCheckpoints(dataDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dataDir, 'git-checkpoints.json'), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { present: false, records: [], corrupt: 0 };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // One unreadable file is one corrupt ledger, counted rather than silently treated as empty.
    return { present: true, records: [], corrupt: 1 };
  }
  const list = Array.isArray(parsed?.checkpoints) ? parsed.checkpoints : [];
  const records = [];
  let corrupt = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || typeof entry.checkpointId !== 'string') { corrupt += 1; continue; }
    records.push({
      kind: 'git_checkpoint',
      at: entry.createdAt ?? null,
      id: entry.checkpointId,
      checkpointId: entry.checkpointId,
      label: entry.label ?? null,
      reason: entry.reason ?? null,
      refName: entry.refName ?? null,
      commitSha: entry.commitSha ?? null,
      headShaAtCreation: entry.headShaAtCreation ?? null,
      treeSha: entry.treeSha ?? null,
      wasDirty: entry.wasDirty === true,
      trackedModifiedCount: Number.isInteger(entry.trackedModifiedCount) ? entry.trackedModifiedCount : null,
      untrackedPaths: Array.isArray(entry.untrackedPaths) ? entry.untrackedPaths : [],
      restoreCount: Number.isInteger(entry.restoreCount) ? entry.restoreCount : 0,
      lastRestoredAt: entry.lastRestoredAt ?? null,
      record: entry,
    });
  }
  return { present: true, records, corrupt };
}

// --------------------------------------------------------------------------------- searching ---

// The text a record is matched against. Each kind says what it means by "its text" rather than
// sharing one heuristic: a memory record's text is its content, a run's is its intent, a task's is
// its goal.
function searchableText(entry) {
  switch (entry.kind) {
    case 'memory': return entry.text;
    case 'cognition_run': return entry.intent;
    case 'council_session': return entry.objective;
    case 'task': return entry.goal;
    case 'workshop_verification': return `${entry.relativePath ?? ''} ${entry.rationale ?? ''} ${entry.candidateId ?? ''} ${entry.sourceProposalId ?? ''}`;
    case 'workshop_apply': return `${entry.relativePath ?? ''} ${entry.candidateId ?? ''} ${entry.applyId ?? ''} ${entry.recordKind ?? ''} ${entry.changesetId ?? ''} ${entry.changesetTitle ?? ''}`;
    case 'git_checkpoint': return `${entry.checkpointId ?? ''} ${entry.label ?? ''} ${entry.reason ?? ''} ${entry.commitSha ?? ''}`;
    case 'ecp_audit': return `${entry.capability ?? ''} ${JSON.stringify(entry.request ?? '')}`;
    default: return '';
  }
}

function matches(entry, needle) {
  if (!needle) return true;
  return searchableText(entry).toLowerCase().includes(needle);
}

export class MemoryTraceService {
  constructor({ dataDir, now = () => new Date() } = {}) {
    if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('a trace service needs a data directory');
    this.dataDir = dataDir;
    this.now = now;
  }

  #all(kind = null) {
    const table = ledgers(this.dataDir);
    const kinds = kind ? [kind] : SEARCH_KINDS;
    const out = [];
    const availability = {};
    for (const name of SEARCH_KINDS) {
      if (!kinds.includes(name)) continue;
      const reader = table[name];
      if (!reader) continue;
      const { present, records, corrupt } = reader();
      availability[name] = { present, corrupt, count: records.length };
      out.push(...records);
    }
    return { entries: out, availability };
  }

  // The search surface. `q` is a plain substring match, case-insensitive, against the kind's own
  // text field; `kind` narrows to one ledger; `epistemicStatus` narrows memory records by their
  // declared status; `correlationId` narrows to the records that belong to one chain.
  search({ q = null, kind = null, epistemicStatus = null, correlationId = null, limit = 50 } = {}) {
    if (kind !== null && !SEARCH_KINDS.includes(kind)) {
      return { ok: false, code: 'UNKNOWN_KIND', detail: `kind must be one of ${SEARCH_KINDS.join(', ')}` };
    }
    if (epistemicStatus !== null && !EPISTEMIC_STATUSES.includes(epistemicStatus)) {
      return { ok: false, code: 'UNKNOWN_STATUS', detail: `epistemicStatus must be one of ${EPISTEMIC_STATUSES.join(', ')}` };
    }
    const needle = typeof q === 'string' && q.trim() !== '' ? q.trim().toLowerCase() : null;
    if (needle !== null && needle.length > MAX_QUERY_CHARS) {
      return { ok: false, code: 'QUERY_TOO_LONG', detail: `a query is at most ${MAX_QUERY_CHARS} characters` };
    }
    const bounded = Math.min(Math.max(Number(limit) || 50, 1), MAX_SEARCH_RESULTS);

    let { entries, availability } = this.#all(kind);
    if (correlationId !== null) {
      const keys = this.#correlationKeys(correlationId);
      entries = entries.filter((entry) => this.#belongsTo(entry, keys));
    }
    if (epistemicStatus !== null) {
      // The status filter applies to memory records. Other kinds have no epistemic status, so a
      // status filter excludes them rather than silently including them.
      entries = entries.filter((entry) => entry.kind === 'memory' && entry.epistemicStatus === epistemicStatus);
    }
    entries = entries.filter((entry) => matches(entry, needle));
    entries.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));

    const total = entries.length;
    const page = entries.slice(0, bounded).map((entry) => ({
      id: resultId(entry.kind, entry.kind === 'memory' ? entry.id : (entry.id ?? entry.eventId ?? entry.at)),
      kind: entry.kind,
      at: entry.at,
      // A summary is the record's own words, truncated. It is never a paraphrase.
      summary: searchableText(entry).trim().slice(0, 240),
      epistemicStatus: entry.kind === 'memory' ? entry.epistemicStatus : null,
      // Each kind names its own identifying fields so a caller can follow the link by hand.
      identity: entry.kind === 'memory' ? { recordId: entry.id }
        : entry.kind === 'cognition_run' ? { runId: entry.runId, taskId: entry.taskId }
          : entry.kind === 'council_session' ? { sessionId: entry.sessionId }
            : entry.kind === 'task' ? { taskId: entry.taskId, eventId: entry.eventId, type: entry.type }
              : entry.kind === 'workshop_verification' ? { candidateId: entry.candidateId, verified: entry.verified, sourceProposalId: entry.sourceProposalId ?? null }
                : entry.kind === 'workshop_apply' ? { applyId: entry.applyId, rollbackId: entry.rollbackId, relativePath: entry.relativePath, changesetId: entry.changesetId ?? null, changesetFileCount: entry.changesetFileCount ?? null }
                  : entry.kind === 'git_checkpoint' ? { checkpointId: entry.checkpointId, commitSha: entry.commitSha, restoreCount: entry.restoreCount }
                  : { operationId: entry.operationId, capability: entry.capability },
      traceable: entry.kind !== 'task' || entry.type === 'task_created',
    }));

    return {
      ok: true,
      schema: SEARCH_SCHEMA,
      query: needle,
      kind,
      epistemicStatus,
      correlationId,
      total,
      returned: page.length,
      truncated: total > page.length,
      availability,
      results: page,
      readOnly: true,
      // A search reads ledgers. It writes none of them, and the response says so.
      wroteNothing: true,
      at: this.now().toISOString(),
    };
  }

  // Every identifier that names the same chain. A run's id and its task's id share a suffix by
  // construction (`cog-<x>` / `task-<x>`), so each is registered against the other, and a lookup by
  // any one of them finds all of them.
  #correlationKeys(correlationId) {
    const wanted = String(correlationId).trim();
    const { entries } = this.#all();
    const keys = new Set([wanted]);
    for (const entry of entries) {
      if (entry.kind !== 'cognition_run') continue;
      const ids = [entry.runId, entry.taskId].filter((v) => typeof v === 'string');
      if (!ids.includes(wanted)) continue;
      for (const id of ids) keys.add(id);
    }
    // T-41 Step 3: a trace asked for by proposal id, candidate id or apply id has to include the whole
    // chain that the staging link joins. Each hop is one field on one record, and following it here is
    // what turns four separate ledgers into one readable causal story.
    for (let pass = 0; pass < 4; pass += 1) {
      const before = keys.size;
      for (const entry of entries) {
        if (entry.kind === 'workshop_verification') {
          if (entry.candidateId && keys.has(entry.candidateId) && entry.sourceProposalId) keys.add(entry.sourceProposalId);
          if (entry.sourceProposalId && keys.has(entry.sourceProposalId) && entry.candidateId) keys.add(entry.candidateId);
        } else if (entry.kind === 'workshop_apply') {
          if (entry.candidateId && keys.has(entry.candidateId) && entry.applyId) keys.add(entry.applyId);
          if (entry.applyId && keys.has(entry.applyId) && entry.candidateId) keys.add(entry.candidateId);
        }
      }
      if (keys.size === before) break;
    }
    return keys;
  }

  #belongsTo(entry, keys) {
    if (entry.kind === 'cognition_run') return keys.has(entry.runId) || keys.has(entry.taskId);
    if (entry.kind === 'workshop_verification') {
      return (typeof entry.candidateId === 'string' && keys.has(entry.candidateId))
        || (typeof entry.sourceProposalId === 'string' && keys.has(entry.sourceProposalId));
    }
    if (entry.kind === 'workshop_apply') {
      return (typeof entry.candidateId === 'string' && keys.has(entry.candidateId))
        || (typeof entry.applyId === 'string' && keys.has(entry.applyId));
    }
    if (entry.kind === 'task') return keys.has(entry.taskId);
    if (entry.kind === 'git_checkpoint') return keys.has(entry.checkpointId);
    if (entry.kind === 'council_session') {
      // A session belongs to the chain when its objective is a run's intent. That is a match of
      // text, not a foreign key, and the trace says so where it relies on it.
      const { entries } = this.#all('cognition_run');
      return entries.some((run) => keys.has(run.runId) && run.intent === entry.objective);
    }
    if (entry.kind === 'ecp_audit') {
      // An operation belongs to the chain when one of its steps names a capability that the chain
      // exercised. That is a weaker link than a foreign key, and the trace marks it as a match.
      const { entries } = this.#all('cognition_run');
      const relevant = entries.filter((run) => keys.has(run.runId));
      return relevant.some((run) => {
        const text = JSON.stringify(run.stages ?? '');
        return typeof entry.capability === 'string' && text.includes(entry.capability);
      });
    }
    return false;
  }

  // The chronological chain for one run, task, operation, or candidate id. Steps appear in time
  // order, and each one says what it is and what linked it to the chain.
  trace(id) {
    const wanted = typeof id === 'string' ? id.trim() : '';
    if (wanted === '') return { ok: false, code: 'INVALID_INPUT', detail: 'a trace needs a run, task, or operation id' };

    const all = this.#all();
    const keys = this.#correlationKeys(wanted);

    const runs = all.entries.filter((e) => e.kind === 'cognition_run' && (keys.has(e.runId) || keys.has(e.taskId)));
    const tasks = all.entries.filter((e) => e.kind === 'task' && keys.has(e.taskId));
    const taskIds = new Set(tasks.map((t) => t.taskId));
    // The Council sessions that evaluated one of these runs' intents.
    const intents = new Set(runs.map((r) => r.intent).filter((v) => typeof v === 'string' && v.length > 0));
    const councils = all.entries.filter((e) => e.kind === 'council_session' && intents.has(e.objective));
    // The workshop verifications whose candidate or path this chain names.
    const chainText = JSON.stringify({
      keys: [...keys],
      intents: [...intents],
      taskIds: [...taskIds],
    });
    // T-41 Step 3: this used to test `chainText.includes(k)` where `chainText` was built FROM `keys`,
    // so the first clause was true for every verification ever recorded - a trace naming one candidate
    // returned every candidate's verification in the sandbox. It went unnoticed because every earlier
    // walk had exactly one candidate. The link is now the explicit one: this chain's keys name the
    // candidate, and the staging hop joins a proposal id to the candidate it produced.
    const verifications = all.entries.filter((e) => {
      if (e.kind !== 'workshop_verification') return false;
      if (typeof e.candidateId === 'string' && keys.has(e.candidateId)) return true;
      if (typeof e.sourceProposalId === 'string' && keys.has(e.sourceProposalId)) return true;
      return false;
    });
    // T-39 Step 1: the applies and rollbacks whose candidate this chain names. They are linked by the
    // candidate id the verifications already carry, which is what makes "verified, then applied, then
    // rolled back" one readable sequence rather than three unrelated records.
    const applies = all.entries.filter((e) => {
      if (e.kind !== 'workshop_apply') return false;
      if (typeof e.candidateId === 'string' && chainText.includes(e.candidateId)) return true;
      if (typeof e.applyId === 'string' && [...keys].some((k) => k === e.applyId)) return true;
      // T-40 Step 2: a changeset file is linked by its candidate id (which is how a chain that names a
      // candidate reaches the batch it was written in) and by its changeset id, so a chain opened for
      // any file of a batch shows the whole batch rather than one isolated write.
      if (typeof e.changesetId === 'string' && [...keys].some((k) => k === e.changesetId)) return true;
      return false;
    });
    // T-43: the git checkpoints this chain names, by checkpoint id. A checkpoint is a record with its
    // own id, so the link is exact - there is no text match to fall back on and none is invented.
    const checkpoints = all.entries.filter((e) => e.kind === 'git_checkpoint' && keys.has(e.checkpointId));
    // A chain opened for a checkpoint also names the operation that created or restored it, because the
    // operation's step input carries the same checkpoint id.
    for (const checkpoint of checkpoints) {
      if (typeof checkpoint.checkpointId === 'string') keys.add(checkpoint.checkpointId);
      if (typeof checkpoint.commitSha === 'string' && checkpoint.commitSha.length >= 7) keys.add(checkpoint.commitSha);
    }
    // The operations whose steps or result name one of these runs or tasks.
    const operations = all.entries.filter((e) => {
      if (e.kind !== 'ecp_audit') return false;
      const text = JSON.stringify({ request: e.request, steps: e.steps });
      return [...keys].some((k) => text.includes(k)) || [...taskIds].some((k) => text.includes(k));
    });

    if (runs.length === 0 && tasks.length === 0 && operations.length === 0 && councils.length === 0
      && verifications.length === 0 && applies.length === 0 && checkpoints.length === 0) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        detail: 'no ledger holds a record for that id',
        searched: { id: wanted, keys: [...keys] },
      };
    }

    const steps = [];
    for (const run of runs) {
      steps.push({
        at: run.at,
        kind: 'cognition_run',
        label: 'cognitive run',
        linkedBy: 'the id names this run',
        detail: {
          runId: run.runId,
          taskId: run.taskId,
          intent: run.intent,
          status: run.status,
          halted: run.halted,
          origin: run.origin,
          // The stage names, in the order the pipeline recorded them.
          stages: run.stages === null || run.stages === undefined ? null : Object.keys(run.stages),
          // The neural bridge's contributions, as the run recorded them. A stage that was unavailable
          // says so here rather than appearing empty.
          neural: run.neural === null || run.neural === undefined ? null : {
            available: run.neural.available === true,
            reason: run.neural.reason ?? null,
            contributions: Array.isArray(run.neural.contributions) ? run.neural.contributions.length : null,
          },
        },
      });
    }
    for (const council of councils) {
      steps.push({
        at: council.at,
        kind: 'council_session',
        label: 'Council deliberation',
        // The link is an equality of text, and the trace names it as such rather than implying the
        // Council was called by the run.
        linkedBy: 'the session objective equals a run intent',
        detail: {
          sessionId: council.sessionId,
          objective: council.objective,
          status: council.status,
          // The resolved candidate with the metadata the constraints core read. A record written
          // before T-38 Step 2 carries nulls here, which is the honest reading of that record.
          candidate: council.candidate === null || council.candidate === undefined ? null : {
            id: council.candidate.capability ?? council.candidate.id ?? null,
            permission: council.candidate.permission ?? null,
            reversibility: council.candidate.reversibility ?? null,
            blastRadius: council.candidate.blastRadius ?? null,
            metadataSource: council.candidate.metadataSource ?? null,
          },
          // The constraint core's verdict, read from the position it recorded. This is the step the
          // T-38 brief asks for: a chain shows what the Council concluded about the candidate.
          constraints: (() => {
            const position = Array.isArray(council.record?.positions)
              ? council.record.positions.find((p) => p && p.perspectiveId === 'constraint_check')
              : null;
            if (!position) return null;
            return {
              verdict: position.position?.verdict ?? null,
              // What the core read, as the registry declared it.
              declaration: position.declaration ?? null,
              summary: position.position?.summary ?? null,
              counts: position.evaluation?.counts ?? null,
              rules: Array.isArray(position.evaluation?.evaluations)
                ? position.evaluation.evaluations.map((rule) => ({ id: rule.id, name: rule.name, verdict: rule.verdict }))
                : [],
              authorizesExecution: false,
            };
          })(),
          // The verdict, read from where the Council recorded it.
          decision: council.decision ?? council.record?.synthesis?.decision ?? null,
          constraintCheck: council.record?.constraintCheck ?? null,
        },
      });
    }
    for (const task of tasks) {
      steps.push({
        at: task.at,
        kind: 'task_graph',
        label: task.type === 'task_created' ? 'task graph created' : `task ${task.type ?? 'event'}`,
        linkedBy: "the task id is the run's task",
        detail: {
          taskId: task.taskId,
          eventId: task.eventId,
          type: task.type,
          goal: task.goal,
          step: task.step,
          state: task.state,
        },
      });
    }
    for (const verification of verifications) {
      steps.push({
        at: verification.at,
        kind: 'workshop_verification',
        label: verification.verified ? 'sandbox verification passed' : 'sandbox verification failed',
        linkedBy: 'the chain names this candidate',
        detail: {
          candidateId: verification.candidateId,
          relativePath: verification.relativePath,
          verified: verification.verified,
          passed: verification.passed,
          total: verification.total,
          failed: verification.failed,
          // Both digests, so the staged bytes and the base bytes can be compared by anyone.
          stagedDigest: verification.stagedDigest,
          baseDigest: verification.baseDigest,
          // T-41 Step 3: the proposal this candidate came from, and what the sandbox test measured.
          // Without them the chain would show a verification whose origin the reader has to infer.
          sourceProposalId: verification.sourceProposalId ?? null,
          sandboxTestResult: verification.sandboxTestResult === null || verification.sandboxTestResult === undefined
            ? null
            : {
              exitCode: verification.sandboxTestResult.exitCode ?? null,
              passedCount: verification.sandboxTestResult.passedCount ?? null,
              failedCount: verification.sandboxTestResult.failedCount ?? null,
              durationMs: verification.sandboxTestResult.durationMs ?? null,
              timedOut: verification.sandboxTestResult.timedOut === true,
              mutatedLiveWorkspace: verification.sandboxTestResult.mutatedLiveWorkspace === true,
            },
          parser: verification.parser,
          promotion: verification.promotion === null ? null : {
            id: verification.promotion.id ?? null,
            at: verification.promotion.at ?? null,
            reason: verification.promotion.reason ?? null,
          },
        },
      });
    }
    for (const change of applies) {
      // T-40 Step 2: a changeset rollback is a rollback, and reading only the single-file record kind
      // would have labelled every batch rollback as an apply - a chain that says the opposite of what
      // happened, which is the one thing a causal trace cannot do.
      const rolledBack = change.recordKind === 'rollback' || change.recordKind === 'changeset_rollback';
      const isChangeset = change.recordKind === 'changeset_apply' || change.recordKind === 'changeset_rollback';
      steps.push({
        at: change.at,
        kind: 'workshop_apply',
        label: rolledBack
          ? ((isChangeset ? change.record?.files?.find((f) => f.relativePath === change.relativePath)?.removedFile === true : change.record?.removedFile === true)
            ? 'workspace rollback removed a created file'
            : 'workspace rollback restored the prior file')
          : 'workspace file applied',
        linkedBy: isChangeset
          ? 'the chain names this candidate, or one file of the batch it was written in'
          : 'the chain names this candidate or apply',
        detail: {
          applyId: change.applyId,
          rollbackId: change.rollbackId,
          candidateId: change.candidateId,
          relativePath: change.relativePath,
          // The digests are the point: a reader can recompute the file and see which record it matches.
          beforeSha256: change.beforeSha256,
          appliedSha256: change.appliedSha256,
          restoredSha256: change.restoredSha256,
          existedBefore: change.existedBefore,
          rolledBack,
          // The batch identity, so a reader can see that this file was one of several written together
          // rather than an independent write that happened to land at the same second.
          changesetId: change.changesetId ?? null,
          changesetFileCount: change.changesetFileCount ?? null,
          changesetTitle: change.changesetTitle ?? null,
          // Both of these are stated so a chain can never be read as permission for anything.
          mutatesLiveWorkspace: change.record?.mutatesLiveWorkspace === true,
          authorizesExecution: false,
        },
      });
    }
    for (const checkpoint of checkpoints) {
      steps.push({
        at: checkpoint.at,
        kind: 'git_checkpoint',
        label: 'git checkpoint recorded',
        linkedBy: 'the id names this checkpoint',
        detail: {
          checkpointId: checkpoint.checkpointId,
          label: checkpoint.label,
          reason: checkpoint.reason,
          refName: checkpoint.refName,
          commitSha: checkpoint.commitSha,
          treeSha: checkpoint.treeSha,
          wasDirty: checkpoint.wasDirty,
          trackedModifiedCount: checkpoint.trackedModifiedCount,
          untrackedPaths: checkpoint.untrackedPaths,
          restoreCount: checkpoint.restoreCount,
          lastRestoredAt: checkpoint.lastRestoredAt,
        },
      });
      // A checkpoint with a restore history has a second, later event in its chain. It is derived from
      // the restore count the record carries rather than from an event ledger that does not exist, and
      // it is labelled as derived so a reader knows the timestamp is the last restore, not each one.
      if (checkpoint.restoreCount > 0 && checkpoint.lastRestoredAt) {
        steps.push({
          at: checkpoint.lastRestoredAt,
          kind: 'git_checkpoint',
          label: 'git checkpoint restored',
          linkedBy: 'the restore count on the checkpoint record',
          detail: {
            checkpointId: checkpoint.checkpointId,
            commitSha: checkpoint.commitSha,
            restoreCount: checkpoint.restoreCount,
            derivedFromRecord: true,
          },
        });
      }
    }
    for (const operation of operations) {
      steps.push({
        at: operation.at,
        kind: 'ecp_audit',
        label: 'authorized operation',
        linkedBy: 'an operation step names an id in this chain',
        detail: {
          operationId: operation.operationId,
          capability: operation.capability,
          origin: operation.origin,
          status: operation.status,
          authorization: operation.authorization,
        },
      });
    }

    // Time order, with the records' own timestamps. Two records at the same instant keep the order
    // they were read in and are marked, rather than being silently reordered.
    steps.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    let sameInstant = 0;
    for (let i = 1; i < steps.length; i += 1) {
      if (steps[i].at && steps[i].at === steps[i - 1].at) {
        sameInstant += 1;
        steps[i].sameInstantAsPrevious = true;
      }
    }
    const bounded = steps.slice(0, MAX_TRACE_ENTRIES);

    return {
      ok: true,
      schema: TRACE_SCHEMA,
      id: wanted,
      keys: [...keys],
      // Complete means "every record this kind of chain should hold was found", and what that is
      // depends on what the id names.
      //
      //   - A run chain is complete when it reaches a run and a task graph. A Council session, a
      //     sandbox verification and an operation are recorded when they happened; their absence is
      //     normal.
      //   - A candidate chain is complete when its verifications and its applies are assembled. It
      //     cannot contain a run by construction: a candidate id is never a run id, and T-39 made
      //     that chain worth opening in its own right.
      //
      // Before T-39 the second case reported `complete: false`, which said "a run is missing" about a
      // chain that was never about a run. That is the kind of false negative that teaches a reader to
      // ignore the flag.
      // T-43: a checkpoint chain is complete when the checkpoint record itself was found. It holds no
      // run and no task graph by construction, and calling that incomplete would be the same false
      // negative T-39 removed for candidate chains.
      complete: runs.length > 0 ? tasks.length > 0 : (applies.length > 0 || verifications.length > 0 || checkpoints.length > 0),
      // An incomplete chain says what it could not find rather than omitting the gap.
      missing: [
        runs.length === 0 && (applies.length > 0 || verifications.length > 0)
          ? 'this is a Workshop change chain: a candidate id is never a cognition run id, so no run is expected'
          : null,
        runs.length === 0 && applies.length === 0 && verifications.length === 0
          ? (checkpoints.length > 0
            ? 'this is a git checkpoint chain: a checkpoint id is never a cognition run id, so no run is expected'
            : 'no cognition run names this id')
          : null,
        runs.length > 0 && tasks.length === 0 ? 'no task graph event names this id' : null,
        councils.length === 0 && runs.length > 0 ? 'no Council session evaluated this objective' : null,
      ].filter(Boolean),
      counts: {
        runs: runs.length,
        councilSessions: councils.length,
        taskEvents: tasks.length,
        verifications: verifications.length,
        // T-39 Step 1: the applies and rollbacks linked to this chain, so a count of what the chain
        // did to the workspace is available without walking the entries.
        applies: applies.length,
        // T-43: the checkpoints this chain names.
        checkpoints: checkpoints.length,
        operations: operations.length,
      },
      sameInstant,
      entries: bounded,
      truncated: steps.length > bounded.length,
      readOnly: true,
      wroteNothing: true,
      at: this.now().toISOString(),
    };
  }

  // The verifications recorded for one path, for the workshop surface. A plain read of the sandbox.
  verificationsFor(relativePath) {
    const { records } = readWorkshopVerifications(this.dataDir);
    return records.filter((r) => r.relativePath === relativePath);
  }
}
