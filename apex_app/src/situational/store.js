// Append-only situational log. Events, assessments, decisions and responses are separate lines in
// one JSON Lines file, so a restart replays the same picture and no line is ever rewritten. The
// writer lock covers read-derive-append: two processes cannot both accept the same event or record
// two decisions from a state the other has not written yet.
import { randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { WriterLock } from '../memory/writer-lock.js';
import { StoreError, ValidationError } from '../errors.js';
import { shortId, singleLine } from '../util.js';
import {
  DECISION_REPLAY_WINDOW_MS, DEFAULT_DECISIONS_READ, DEFAULT_EVENTS_READ, MAX_DECISIONS_READ,
  MAX_EVENTS_READ, SITUATION_SCHEMA,
} from './vocabulary.js';
import { latestDecisionFor, reduceSituation, validateSituationRecord } from './model.js';

const MAX_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

function bounded(value, fallback, max) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new ValidationError('limit must be a positive integer');
  return Math.min(value, max);
}

export class SituationStore {
  constructor(filePath, { now = () => new Date(), idFactory = randomUUID, operations = null, lockWaitMs, lockRetryMs, lockRetryMaxMs } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.idFactory = idFactory;
    this.operations = operations;
    this.log = new JsonlStore(filePath, { validateRecord: validateSituationRecord });
    this.lock = new WriterLock(filePath, { waitMs: lockWaitMs, retryMs: lockRetryMs, retryMaxMs: lockRetryMaxMs });
  }

  async #readComplete({ beforeAppend = false } = {}) {
    const { records, corrupt } = beforeAppend ? await this.log.loadForAppend() : await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`situational log contains ${corrupt.length} corrupt line(s); refusing an incomplete picture`);
    }
    const state = reduceSituation(records);
    if (state.problems.length > 0) {
      throw new StoreError(`situational log contains ${state.problems.length} record(s) that cannot be applied; refusing an incomplete picture`);
    }
    return { records, state };
  }

  async load() {
    return this.#readComplete();
  }

  // Diagnostic read: damage is reported, not thrown, so a damaged log is never shown as an empty
  // environment. An unreadable file still throws.
  async inspect() {
    const { records, corrupt } = await this.log.load();
    const state = reduceSituation(records);
    return {
      path: this.filePath,
      records: records.length,
      corrupt,
      problems: state.problems,
      complete: corrupt.length === 0 && state.problems.length === 0,
      counts: {
        events: state.events.size,
        assessments: state.assessments.size,
        decisions: state.decisions.length,
        responses: state.responses.length,
      },
    };
  }

  async status() {
    try {
      const inspected = await this.inspect();
      return {
        ...inspected,
        available: true,
        detail: inspected.complete ? null : 'the situational log has damage; reads that present the environment are refused',
      };
    } catch (err) {
      return { path: this.filePath, available: false, complete: false, detail: err?.message ?? String(err), counts: null, corrupt: [], problems: [] };
    }
  }

  async lockReport() {
    return this.lock.state();
  }

  async recover() {
    return this.lock.recover();
  }

  // Reads one event by full id or a unique prefix.
  async event(ref) {
    const { state } = await this.#readComplete();
    const text = String(ref ?? '').trim();
    if (text.length === 0) throw new ValidationError('an event id is required');
    if (state.events.has(text)) return state.events.get(text);
    if (text.length < 4) throw new ValidationError(`event id "${singleLine(text, 40)}" is too short; use at least 4 characters`);
    const matches = [...state.events.values()].filter((event) => event.id.startsWith(text));
    if (matches.length === 0) throw new ValidationError(`no event matches "${singleLine(text, 40)}"`);
    if (matches.length > 1) throw new ValidationError(`"${singleLine(text, 40)}" matches ${matches.length} events; use a longer id`);
    return matches[0];
  }

  // The identity check used before a world write, so a replay cannot append a second world fact.
  async findEvent({ source, sourceEventId, fingerprint, withinMs = MAX_DEDUPE_WINDOW_MS }) {
    const { state } = await this.#readComplete();
    const nowMs = this.now().getTime();
    const sameIdentity = [...state.events.values()].find((event) => event.source === source && event.sourceEventId === sourceEventId);
    if (sameIdentity) {
      return {
        event: sameIdentity,
        duplicate: sameIdentity.fingerprint === fingerprint,
        inconsistent: sameIdentity.fingerprint !== fingerprint,
      };
    }
    const sameContent = [...state.events.values()].find((event) => event.fingerprint === fingerprint
      && event.source === source
      && nowMs - Date.parse(event.ingestedAt) <= withinMs);
    if (sameContent) return { event: sameContent, duplicate: true, inconsistent: false };
    return { event: null, duplicate: false, inconsistent: false };
  }

  async observe(record) {
    const problem = validateSituationRecord(record);
    if (problem) throw new ValidationError(`the event cannot be recorded: ${problem}`);
    return this.lock.run(async () => {
      const { records, state } = await this.#readComplete({ beforeAppend: true });
      const existing = [...state.events.values()].find((event) => event.source === record.source && event.sourceEventId === record.sourceEventId);
      if (existing) {
        if (existing.fingerprint !== record.fingerprint) {
          throw new ValidationError(
            `source event ${singleLine(record.sourceEventId, 40)} is already recorded with different content; a replay must carry the same payload`,
            'EVENT_REPLAY_INCONSISTENT',
          );
        }
        return { record: existing, duplicate: true };
      }
      await this.log.append(record);
      return { record, duplicate: false };
    });
  }

  async recordAssessment({ eventId, assessmentId, spec }) {
    return this.lock.run(async () => {
      const { records, state } = await this.#readComplete({ beforeAppend: true });
      if (!state.events.has(eventId)) throw new ValidationError(`event ${shortId(eventId)} is not recorded; it cannot be assessed`);
      const record = {
        schema: SITUATION_SCHEMA,
        kind: 'event_assessed',
        id: assessmentId,
        assessmentId,
        eventId,
        at: this.now().toISOString(),
        origin: 'user',
        ...spec,
      };
      const problem = validateSituationRecord(record);
      if (problem) throw new ValidationError(`the assessment cannot be recorded: ${problem}`);
      if (records.some((r) => r.id === record.id)) throw new StoreError('identifier collision; nothing written');
      await this.log.append(record);
      return record;
    });
  }

  async recordDecision({ eventId, assessmentId, decisionId, response, action = null, inputDigest = null, reason, notification }) {
    return this.lock.run(async () => {
      const { records, state } = await this.#readComplete({ beforeAppend: true });
      const assessment = state.assessments.get(eventId);
      if (!assessment || assessment.id !== assessmentId) {
        throw new ValidationError('a decision must name the latest assessment of its event; re-evaluate first');
      }
      const nowMs = this.now().getTime();
      const replay = state.decisions.find((decision) => decision.eventId === eventId
        && decision.response === response
        && decision.action === action
        && decision.inputDigest === inputDigest
        && nowMs - Date.parse(decision.at) <= DECISION_REPLAY_WINDOW_MS);
      if (replay) {
        throw new ValidationError(
          `this decision is already recorded as ${shortId(replay.id)}; the same response was not recorded twice`,
          'DECISION_REPLAY',
        );
      }
      const record = {
        schema: SITUATION_SCHEMA,
        kind: 'response_decided',
        id: decisionId,
        decisionId,
        eventId,
        assessmentId,
        at: this.now().toISOString(),
        origin: 'user',
        response,
        action,
        inputDigest,
        reason,
        notification,
      };
      const problem = validateSituationRecord(record);
      if (problem) throw new ValidationError(`the decision cannot be recorded: ${problem}`);
      if (records.some((r) => r.id === record.id)) throw new StoreError('identifier collision; nothing written');
      await this.log.append(record);
      return record;
    });
  }

  // One response per decision, and only for a decision that authorized execution. The audit record
  // the response cites must exist, so a response cannot claim a run nothing can confirm.
  async recordResponse(record) {
    return this.lock.run(async () => {
      const { records, state } = await this.#readComplete({ beforeAppend: true });
      const decision = state.decisions.find((d) => d.id === record.decisionId);
      if (!decision) throw new ValidationError(`decision ${shortId(record.decisionId)} is not recorded`);
      if (decision.response !== 'execute') throw new ValidationError('only a decision that chose execute can have a response record');
      if (state.responseByDecision.has(decision.id)) {
        throw new ValidationError(`decision ${shortId(decision.id)} already has a recorded response; it is not run twice`, 'RESPONSE_EXISTS');
      }
      if (!this.operations || typeof this.operations.findById !== 'function') {
        throw new ValidationError('the audit log is not available, so a response cannot cite what ran');
      }
      const found = await this.operations.findById(record.operationId);
      if (!found?.found) throw new ValidationError(`operation ${shortId(record.operationId)} is not in the audit log; the response was not accepted`);
      const problem = validateSituationRecord(record);
      if (problem) throw new ValidationError(`the response cannot be recorded: ${problem}`);
      if (records.some((r) => r.id === record.id)) throw new StoreError('identifier collision; nothing written');
      await this.log.append(record);
      return record;
    });
  }

  async decision(ref) {
    const { state } = await this.#readComplete();
    const text = String(ref ?? '').trim();
    if (text.length === 0) throw new ValidationError('a decision id is required');
    const exact = state.decisions.find((d) => d.id === text);
    if (exact) return { ...exact, responseRecord: state.responseByDecision.get(exact.id) ?? null };
    if (text.length < 4) throw new ValidationError(`decision id "${singleLine(text, 40)}" is too short; use at least 4 characters`);
    const matches = state.decisions.filter((d) => d.id.startsWith(text));
    if (matches.length === 0) throw new ValidationError(`no decision matches "${singleLine(text, 40)}"`);
    if (matches.length > 1) throw new ValidationError(`"${singleLine(text, 40)}" matches ${matches.length} decisions; use a longer id`);
    return { ...matches[0], responseRecord: state.responseByDecision.get(matches[0].id) ?? null };
  }

  // One bounded page of events with the latest assessment, decision and response for each.
  async events({ limit = DEFAULT_EVENTS_READ } = {}) {
    const bound = bounded(limit, DEFAULT_EVENTS_READ, MAX_EVENTS_READ);
    const { state } = await this.#readComplete();
    const rows = [...state.events.values()]
      .sort((a, b) => (a.ingestedAt < b.ingestedAt ? 1 : a.ingestedAt > b.ingestedAt ? -1 : (a.id < b.id ? 1 : -1)))
      .slice(0, bound)
      .map((event) => {
        const assessment = state.assessments.get(event.id) ?? null;
        const decision = latestDecisionFor(state.decisions, event.id);
        return {
          event,
          assessment,
          decision,
          response: decision ? state.responseByDecision.get(decision.id) ?? null : null,
        };
      });
    return { rows, total: state.events.size, truncated: state.events.size > bound, limit: bound };
  }

  async decisions({ limit = DEFAULT_DECISIONS_READ, eventId = null } = {}) {
    const bound = bounded(limit, DEFAULT_DECISIONS_READ, MAX_DECISIONS_READ);
    const { state } = await this.#readComplete();
    const all = [...state.decisions].reverse().filter((d) => eventId === null || d.eventId === eventId);
    return {
      decisions: all.slice(0, bound).map((decision) => ({
        ...decision,
        responseRecord: state.responseByDecision.get(decision.id) ?? null,
      })),
      total: all.length,
      truncated: all.length > bound,
      limit: bound,
    };
  }

  async snapshot({ limit = 10 } = {}) {
    const bound = bounded(limit, 10, MAX_EVENTS_READ);
    const { state } = await this.#readComplete();
    return {
      events: [...state.events.values()],
      assessments: state.assessments,
      decisions: state.decisions,
      responses: state.responses,
      responseByDecision: state.responseByDecision,
      limit: bound,
    };
  }
}

export { reduceSituation };
