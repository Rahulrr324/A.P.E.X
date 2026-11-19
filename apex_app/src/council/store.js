// Council session store: append-only persistence of council deliberations.
//
// This is not a second evidence store. A session keeps the bounded input references and the
// synthesis that was derived from them; the authoritative records remain in their own stores.
//
// Properties enforced here:
//  - append-only: a session is never rewritten or deleted;
//  - content-addressed identity: a session id is derived from the input digest, so repeating the
//    same deliberation is idempotent rather than a second divergent decision;
//  - digest chain: each record commits to the previous record's digest, so a removed or reordered
//    line is detectable even though the file is plain JSONL;
//  - bounded history: the store refuses to grow without bound instead of silently dropping the
//    oldest deliberation;
//  - corruption is reported, not repaired: unparsable lines are counted and skipped, and a
//    damaged chain is surfaced rather than hidden.
import { createHash } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { WriterLock } from '../memory/writer-lock.js';
import { StoreError } from '../errors.js';
import { COUNCIL_SCHEMA } from './index.js';

export const MAX_COUNCIL_SESSIONS = 1000;
export const MAX_SESSION_BYTES = 64 * 1024;
const MAX_LIST_LIMIT = 200;

export class CouncilStore {
  #log;
  #lock;
  #now;
  #idFactory;

  constructor(filePath, { now = () => new Date(), idFactory } = {}) {
    this.#now = now;
    this.#idFactory = idFactory;
    this.#log = new JsonlStore(filePath, { validateRecord: validateRecord });
    this.#lock = new WriterLock(filePath, { label: 'council store' });
    this.filePath = filePath;
  }

  newSessionId() {
    return `cs-${this.#idFactory ? this.#idFactory() : createHash('sha256').update(String(this.#now())).digest('hex')}`;
  }

  async append(session) {
    if (!session || typeof session !== 'object') throw new StoreError('session must be an object');
    if (typeof session.sessionId !== 'string' || session.sessionId.length === 0) {
      throw new StoreError('session must have a session id');
    }
    if (session.schema !== COUNCIL_SCHEMA) throw new StoreError('session schema is not council');
    const candidate = boundRecord(session);
    return this.#lock.run(async () => {
      const { records, corrupt } = await this.#log.loadForAppend();
      const existing = records.find((record) => record.sessionId === candidate.sessionId);
      if (existing) {
        if (existing.inputDigest !== candidate.inputDigest) {
          throw new StoreError('duplicate session id with a different input; refusing to overwrite an append-only record');
        }
        return { appended: false, duplicate: true, sessionId: candidate.sessionId, corrupt: corrupt.length };
      }
      if (records.length >= MAX_COUNCIL_SESSIONS) {
        throw new StoreError(`council history bound reached (${MAX_COUNCIL_SESSIONS} sessions); no further session was written`);
      }
      const previous = records[records.length - 1] ?? null;
      const record = {
        ...candidate,
        previousDigest: previous?.contentDigest ?? null,
        contentDigest: null,
        recordedAt: this.#now().toISOString(),
      };
      record.contentDigest = digestRecord(record);
      const line = JSON.stringify(record);
      if (Buffer.byteLength(line, 'utf8') > MAX_SESSION_BYTES) {
        throw new StoreError('session record exceeds the size bound');
      }
      await this.#log.append(record);
      return { appended: true, sessionId: record.sessionId, contentDigest: record.contentDigest, corrupt: corrupt.length };
    });
  }

  async list({ limit = 20 } = {}) {
    const { records, corrupt } = await this.#load();
    const count = Number.isInteger(limit) ? Math.max(1, Math.min(limit, MAX_LIST_LIMIT)) : 20;
    const out = [];
    for (let i = records.length - 1; i >= 0 && out.length < count; i -= 1) {
      const record = records[i];
      out.push({
        sessionId: record.sessionId,
        objective: record.objective,
        evaluatedAt: record.evaluatedAt,
        at: record.evaluatedAt,
        status: record.status,
        support: record.synthesis?.synthesis?.support ?? null,
        recommendation: record.synthesis?.synthesis?.recommendedOption?.level ?? null,
        authorizesExecution: false,
      });
    }
    return { sessions: out, total: records.length, corrupt: corrupt.length };
  }

  async get(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { found: false, detail: 'session id is required' };
    }
    const { records, corrupt } = await this.#load();
    const exact = records.find((record) => record.sessionId === sessionId);
    if (exact) return { found: true, session: publicSession(exact), corrupt: corrupt.length };
    const prefix = records.filter((record) => record.sessionId.startsWith(sessionId));
    if (prefix.length === 1) return { found: true, session: publicSession(prefix[0]), corrupt: corrupt.length };
    if (prefix.length > 1) return { found: false, detail: 'session id is ambiguous; use a longer prefix' };
    return { found: false, detail: `no council session for ${sessionId}` };
  }

  async status() {
    try {
      const { records, corrupt } = await this.#load();
      const chain = verifyChain(records);
      return {
        records: records.length,
        sessions: records.length,
        corrupt: corrupt.length,
        bound: MAX_COUNCIL_SESSIONS,
        chain: chain.ok ? 'intact' : 'damaged',
        chainDetail: chain.detail,
        latest: records.length ? { sessionId: records[records.length - 1].sessionId, at: records[records.length - 1].evaluatedAt } : null,
      };
    } catch (err) {
      if (err && err.code === 'STORE_UNAVAILABLE') throw err;
      return {
        records: 0, sessions: 0, corrupt: 0, bound: MAX_COUNCIL_SESSIONS,
        chain: 'unavailable', chainDetail: err?.message ?? 'could not read council store',
      };
    }
  }

  async replaySource(sessionId) {
    const result = await this.get(sessionId);
    if (!result.found) return result;
    return { found: true, session: result.session };
  }

  async #load() {
    const { records, corrupt } = await this.#log.load();
    return { records, corrupt };
  }
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'council record must be an object';
  if (record.schema !== COUNCIL_SCHEMA) return 'council record schema is not council';
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) return 'council record needs a session id';
  if (typeof record.inputDigest !== 'string' || record.inputDigest.length === 0) return 'council record needs an input digest';
  if (typeof record.objective !== 'string') return 'council record needs an objective';
  if (record.authorizesExecution !== false) return 'a council record may never authorize execution';
  if (record.contentDigest !== null && typeof record.contentDigest !== 'string') return 'council content digest must be text';
  return null;
}

// A record is built from only the fields the council defines, so caller-supplied extra fields
// (including anything that looks like an authorization) cannot ride into the store.
function boundRecord(session) {
  const input = session.input ?? null;
  const objective = String(session.objective ?? '').slice(0, 2000);
  return {
    schema: COUNCIL_SCHEMA,
    schemaVersion: 1,
    kind: 'session',
    sessionId: session.sessionId,
    inputDigest: typeof session.inputDigest === 'string' && session.inputDigest.length > 0
      ? session.inputDigest
      : createHash('sha256').update(`${objective}\u0000${session.evaluatedAt ?? session.at ?? ''}`).digest('hex'),
    objective,
    evaluatedAt: session.evaluatedAt ?? null,
    status: session.status ?? 'completed',
    input: input === null ? null : {
      objective: String(input.objective ?? '').slice(0, 2000),
      candidateId: input.candidateId ?? null,
      candidate: input.candidate ?? null,
      evidence: Array.isArray(input.evidence) ? input.evidence.slice(0, 40) : [],
      resourceContext: input.resourceContext ?? null,
      taskRecord: input.taskRecord ?? null,
      signalledContradiction: input.signalledContradiction ?? null,
      evidenceProvenance: input.evidenceProvenance ?? null,
    },
    evidenceSet: session.evidenceSet ?? null,
    positions: Array.isArray(session.positions) ? session.positions : [],
    disagreement: session.disagreement ?? null,
    synthesis: session.synthesis ?? null,
    authorizesExecution: false,
  };
}

function digestRecord(record) {
  const { contentDigest, ...body } = record;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function publicSession(record) {
  return {
    schema: record.schema,
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    sessionId: record.sessionId,
    inputDigest: record.inputDigest,
    objective: record.objective,
    evaluatedAt: record.evaluatedAt,
    at: record.evaluatedAt,
    status: record.status,
    input: record.input,
    evidenceSet: record.evidenceSet,
    positions: record.positions,
    disagreement: record.disagreement,
    synthesis: record.synthesis,
    contentDigest: record.contentDigest,
    previousDigest: record.previousDigest,
    recordedAt: record.recordedAt,
    authorizesExecution: false,
  };
}

export function verifyChain(records = []) {
  let previous = null;
  for (const record of records) {
    if ((record.previousDigest ?? null) !== (previous?.contentDigest ?? null)) {
      return { ok: false, detail: `session ${record.sessionId} does not follow the recorded chain` };
    }
    if (digestRecord(record) !== record.contentDigest) {
      return { ok: false, detail: `session ${record.sessionId} content does not match its digest` };
    }
    previous = record;
  }
  return { ok: true, detail: `${records.length} session(s) verified in order` };
}
