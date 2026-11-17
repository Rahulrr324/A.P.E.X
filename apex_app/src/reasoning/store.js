// Append-only bounded reasoning sessions. A session stores references and bounded explanations; it
// never copies a source store. Invalidating a conclusion appends a new event, so the original
// reasoning remains auditable and recovery never rewrites history.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { WriterLock } from '../memory/writer-lock.js';
import { StoreError, ValidationError } from '../errors.js';
import { BOUNDS, REASONING_SCHEMA } from './vocabulary.js';

const ID_RE = /^rsn:[0-9a-f]{32}$/;

function text(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function validateReasoningRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'not an object';
  if (record.schema !== REASONING_SCHEMA) return 'unsupported reasoning schema';
  if (!text(record.at, 64) || Number.isNaN(Date.parse(record.at))) return 'invalid timestamp';
  if (record.kind === 'session') {
    if (!ID_RE.test(record.sessionId ?? '')) return 'invalid session id';
    if (!text(record.request, BOUNDS.maxRequestChars)) return 'invalid request';
    if (!['completed', 'failed'].includes(record.status)) return 'invalid session status';
    if (!record.evidence || !Array.isArray(record.evidence.items) || record.evidence.items.length > BOUNDS.maxEvidence) {
      return 'invalid evidence set';
    }
    for (const item of record.evidence.items) {
      if (!item || typeof item.evidenceId !== 'string' || item.evidenceId.length > 320) return 'invalid evidence reference';
      if (!text(item.claim, BOUNDS.maxEvidenceClaimChars)) return 'invalid evidence claim';
      if (typeof item.trust !== 'string') return 'invalid evidence trust';
      if (!['supporting', 'contradicting', 'contextual', 'historical', 'unknown'].includes(item.relation)) return 'invalid evidence relation';
    }
    if (!Array.isArray(record.hypotheses) || record.hypotheses.length > BOUNDS.maxHypotheses) return 'invalid hypotheses';
    if (!record.conclusion || typeof record.conclusion.classification !== 'string') return 'missing conclusion';
    if (typeof record.conclusion.authorizes !== 'boolean' || record.conclusion.authorizes !== false) return 'a conclusion may not authorize';
    if (!Array.isArray(record.trace) || record.trace.length > BOUNDS.maxTraceSteps) return 'invalid trace';
    return null;
  }
  if (record.kind === 'invalidation') {
    if (!ID_RE.test(record.sessionId ?? '')) return 'invalid invalidated session id';
    if (!text(record.reason, BOUNDS.maxReasonChars)) return 'invalid invalidation reason';
    if (record.byOrigin !== 'user') return 'only a user act may invalidate a conclusion';
    return null;
  }
  return 'unknown reasoning record kind';
}

export class ReasoningStore {
  constructor(dataDir, { now = () => new Date(), idFactory = randomUUID, lockWaitMs, lockRetryMs, lockRetryMaxMs } = {}) {
    this.dataDir = dataDir;
    this.logPath = path.join(dataDir, 'reasoning.jsonl');
    this.now = now;
    this.idFactory = idFactory;
    this.log = new JsonlStore(this.logPath, { validateRecord: validateReasoningRecord, parseCacheBytes: 4 * 1024 * 1024 });
    this.lock = new WriterLock(path.join(dataDir, 'reasoning'), { waitMs: lockWaitMs, retryMs: lockRetryMs, retryMaxMs: lockRetryMaxMs });
  }

  async load() {
    try {
      return await this.log.load();
    } catch (err) {
      throw new StoreError(`reasoning sessions could not be read: ${err?.message ?? String(err)}`);
    }
  }

  #derive(records, corrupt) {
    const sessions = [];
    const invalidations = new Map();
    for (const record of records) {
      if (record.kind === 'invalidation') {
        if (!invalidations.has(record.sessionId)) invalidations.set(record.sessionId, record);
      } else if (record.kind === 'session') {
        sessions.push(record);
      }
    }
    const current = sessions
      .sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : (a.sessionId < b.sessionId ? -1 : 1)))
      .map((session) => {
        const invalidation = invalidations.get(session.sessionId) ?? null;
        return {
          ...session,
          invalidated: invalidation !== null,
          invalidatedAt: invalidation?.at ?? null,
          invalidationReason: invalidation?.reason ?? null,
        };
      });
    return { sessions: current, invalidations: [...invalidations.values()], corrupt };
  }

  async list({ limit = 20 } = {}) {
    const loaded = await this.load();
    const derived = this.#derive(loaded.records, loaded.corrupt);
    const bounded = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 20, BOUNDS.maxSessions));
    return {
      sessions: derived.sessions.slice(0, bounded).map((session) => ({
        sessionId: session.sessionId,
        request: session.request,
        at: session.at,
        status: session.status,
        summary: session.summary,
        conclusion: session.conclusion,
        invalidated: session.invalidated,
        invalidatedAt: session.invalidatedAt,
      })),
      total: derived.sessions.length,
      truncated: derived.sessions.length > bounded,
      corrupt: loaded.corrupt.length,
      limits: { maxSessions: BOUNDS.maxSessions },
    };
  }

  async get(sessionId) {
    if (!ID_RE.test(String(sessionId ?? ''))) return { found: false, detail: 'not a reasoning session id' };
    const loaded = await this.load();
    const derived = this.#derive(loaded.records, loaded.corrupt);
    const session = derived.sessions.find((item) => item.sessionId === sessionId);
    if (!session) return { found: false, detail: `no reasoning session ${sessionId} is recorded` };
    return { found: true, session };
  }

  async appendSession(session) {
    const problem = validateReasoningRecord(session);
    if (problem) throw new ValidationError(`refusing invalid reasoning session: ${problem}`);
    return this.lock.run(async () => {
      const loaded = await this.log.load({ maintainSnapshot: false });
      const count = loaded.records.filter((record) => record.kind === 'session').length;
      if (count >= BOUNDS.maxSessions) {
        throw new ValidationError(`the bounded reasoning history is full (${BOUNDS.maxSessions} sessions); invalidate or export old sessions before starting another`, 'REASONING_HISTORY_FULL');
      }
      await this.log.append(session);
      return session;
    });
  }

  async invalidate(sessionId, reason, { byOrigin = 'user' } = {}) {
    if (byOrigin !== 'user') throw new ValidationError('only a user act may invalidate a reasoning conclusion', 'AUTHORIZATION');
    if (!text(reason, BOUNDS.maxReasonChars)) throw new ValidationError(`reason must be non-empty text up to ${BOUNDS.maxReasonChars} characters`);
    const record = {
      schema: REASONING_SCHEMA,
      kind: 'invalidation',
      sessionId,
      reason: reason.trim(),
      byOrigin: 'user',
      at: this.now().toISOString(),
    };
    const problem = validateReasoningRecord(record);
    if (problem) throw new ValidationError(problem);
    return this.lock.run(async () => {
      // Check under the write lock so two concurrent invalidations cannot both append.
      const loaded = await this.log.load({ maintainSnapshot: false });
      const session = loaded.records.find((item) => item.kind === 'session' && item.sessionId === sessionId);
      if (!session) throw new ValidationError(`no reasoning session ${sessionId} is recorded`);
      if (loaded.records.some((item) => item.kind === 'invalidation' && item.sessionId === sessionId)) {
        throw new ValidationError('that reasoning conclusion is already invalidated');
      }
      await this.log.append(record);
      return record;
    });
  }

  newSessionId() {
    return `rsn:${String(this.idFactory()).replace(/-/g, '').slice(0, 32)}`;
  }

  async status() {
    const loaded = await this.load();
    const derived = this.#derive(loaded.records, loaded.corrupt);
    return {
      sessions: derived.sessions.length,
      invalidated: derived.sessions.filter((session) => session.invalidated).length,
      corrupt: loaded.corrupt.length,
      maxSessions: BOUNDS.maxSessions,
      note: 'sessions are append-only; invalidation is an event, not a deletion',
    };
  }
}
