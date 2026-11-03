// Goal store: an append-only JSON Lines event log (goals.jsonl). Goal state is the result of
// replaying the log, so a lifecycle survives a restart after every recorded decision.
//
// Every mutation runs under the store's WriterLock, because each one is a read-modify-write:
// the current goal state is read, the transition is validated against it, and one event is
// appended. Without the lock two processes could each validate against a state the other has
// not written yet, and both decisions would be recorded (two active goals for one request,
// two completions, or evidence recorded against a goal that was cancelled meanwhile).
//
// Completion proof is not stored in this file alone. A supporting evidence record names an
// operation id, and completion re-opens the audit log and requires that operation to be a
// verified success. A goal therefore cannot be completed by asserting that it is: the same
// append-only audit that the rest of APEX uses must hold the evidence.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { WriterLock } from '../memory/writer-lock.js';
import { ValidationError, StoreError } from '../errors.js';
import { Outcome } from '../outcomes.js';
import { shortId, singleLine } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { maskSecretLeaves } from '../security/secrets.js';
import {
  GOAL_SCHEMA,
  GoalStatus,
  MAX_CRITERIA,
  MAX_CRITERION_CHARS,
  MAX_GOAL_DETAIL_CHARS,
  MAX_GOAL_REQUEST_CHARS,
  MAX_GOAL_REASON_CHARS,
  isOpenStatus,
  reduceEvents,
  validateEventShape,
} from './model.js';

function assertNoSecret(value, name) {
  if (containsSecret(String(value ?? ''))) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  }
}

export class GoalStore {
  constructor(filePath, { now = () => new Date(), idFactory = randomUUID, operations = null } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.idFactory = idFactory;
    this.operations = operations;
    this.log = new JsonlStore(filePath, { validateRecord: validateEventShape });
    this.lock = new WriterLock(filePath, { label: path.basename(filePath), now, idFactory });
  }

  // A damaged log or an event that cannot be applied refuses the whole read: a replayed goal
  // state built from part of a history would be reported as a different lifecycle.
  async #readComplete() {
    const { records, corrupt } = await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`goal log contains ${corrupt.length} corrupt line(s); refusing incomplete goal state`);
    }
    const { goals, problems } = reduceEvents(records);
    if (problems.length > 0) {
      throw new StoreError(`goal log contains ${problems.length} event(s) that cannot be applied; refusing incomplete goal state`);
    }
    return { records, goals };
  }

  async load() {
    const { records, goals } = await this.#readComplete();
    return { goals, events: records.length };
  }

  // Read-only diagnostics: it reports damage instead of refusing, so an empty store and a
  // damaged one cannot be mistaken for each other. An unreadable file still throws.
  async inspect() {
    const { records, corrupt } = await this.log.load();
    const { goals, problems } = reduceEvents(records);
    return { events: records.length, goals: [...goals.values()], corrupt, problems };
  }

  async status() {
    const { records, corrupt } = await this.log.load();
    const { goals, problems } = reduceEvents(records);
    return { records: records.length, goals: goals.size, corrupt: corrupt.length, problems: problems.length };
  }

  async get(goalId) {
    const { goals } = await this.load();
    return goals.get(goalId) ?? null;
  }

  async list() {
    const { goals } = await this.load();
    return [...goals.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async resolve(ref) {
    const q = String(ref ?? '').trim();
    if (q.length === 0) throw new ValidationError('a goal id is required');
    const { goals } = await this.load();
    if (goals.has(q)) return goals.get(q);
    if (q.length < 4) throw new ValidationError(`goal id "${singleLine(q, 40)}" is too short; use at least 4 characters`);
    const matches = [...goals.values()].filter((g) => g.id.startsWith(q));
    if (matches.length === 0) throw new ValidationError(`no goal matches "${singleLine(q, 40)}"`);
    if (matches.length > 1) throw new ValidationError(`"${singleLine(q, 40)}" matches ${matches.length} goals; use a longer id`);
    return matches[0];
  }

  #pick(goals, ref) {
    const q = String(ref ?? '').trim();
    if (goals.has(q)) return goals.get(q);
    if (q.length < 4) throw new ValidationError(`goal id "${singleLine(q, 40)}" is too short; use at least 4 characters`);
    const matches = [...goals.values()].filter((g) => g.id.startsWith(q));
    if (matches.length === 0) throw new ValidationError(`no goal matches "${singleLine(q, 40)}"`);
    if (matches.length > 1) throw new ValidationError(`"${singleLine(q, 40)}" matches ${matches.length} goals; use a longer id`);
    return matches[0];
  }

  #base(type, goalId) {
    return { schema: GOAL_SCHEMA, eventId: this.idFactory(), type, goalId, at: this.now().toISOString() };
  }

  // Validates by replay, then appends. A refused event is never written, and a damaged log is
  // never extended: its state cannot be trusted as a base.
  async #mutate(build) {
    return this.lock.run(async () => {
      const { records, goals } = await this.#readComplete();
      const event = await build(goals);
      const masked = maskSecretLeaves(event);
      const safe = masked.masked > 0 ? { ...masked.value, secretsMasked: true } : masked.value;
      const next = reduceEvents([...records, safe]);
      const refused = next.problems.find((p) => p.index === records.length);
      if (refused) throw new ValidationError(`refused: ${refused.reason}`, 'ILLEGAL_TRANSITION');
      await this.log.append(safe);
      return { event: safe, goal: next.goals.get(event.goalId) };
    });
  }

  async createGoal({ request, criteria, priority = 3, deadline = null, dependsOn = [], reason = null }) {
    assertNoSecret(request, 'the goal');
    if (!Array.isArray(criteria) || criteria.length === 0) throw new ValidationError('at least one success criterion is required');
    if (criteria.length > MAX_CRITERIA) throw new ValidationError(`at most ${MAX_CRITERIA} success criteria are allowed`);
    const goalId = this.idFactory();
    return this.#mutate(() => {
      const entries = criteria.map((description, i) => {
        assertNoSecret(description, `criterion ${i + 1}`);
        const text = String(description).trim();
        if (text.length === 0) throw new ValidationError(`criterion ${i + 1} is empty`);
        if (text.length > MAX_CRITERION_CHARS) throw new ValidationError(`criterion ${i + 1} exceeds ${MAX_CRITERION_CHARS} characters`);
        return { id: `c${i + 1}`, description: text };
      });
      if (deadline !== null && (typeof deadline !== 'string' || Number.isNaN(Date.parse(deadline)))) {
        throw new ValidationError('deadline must be an ISO date or time');
      }
      return {
        ...this.#base('goal_created', goalId),
        origin: 'user',
        request: String(request).trim(),
        criteria: entries,
        priority,
        deadline,
        dependsOn: [...dependsOn],
        reason: reason ?? 'recorded by the user',
      };
    });
  }

  // Re-opens the audit log for one cited operation. The log is append-only, so a record that is
  // found cannot later disappear; absence, an unreadable log, and a non-success are all refused.
  async #evidenceOperation(operationId) {
    if (!this.operations) throw new ValidationError('the audit log is not available, so evidence cannot be checked');
    const found = await this.operations.findById(operationId);
    if (!found.found) {
      throw new ValidationError(`no operation record ${shortId(operationId)} exists in the audit log; the evidence was not accepted`);
    }
    return found.record;
  }

  // Every criterion must be satisfied by a support whose operation is still a verified success
  // in the audit log. This is re-run inside the lock immediately before the completion event is
  // appended, so completion cannot rest on a stale claim about an operation.
  async #verifyCriteria(goal) {
    const problems = [];
    for (const criterion of goal.criteria) {
      if (criterion.status !== 'satisfied') {
        problems.push(`${criterion.id} is ${criterion.status}`);
        continue;
      }
      const support = [...criterion.evidence].reverse().find((ev) => ev.kind === 'supports');
      if (!support || !support.operationId) {
        problems.push(`${criterion.id} has no supporting operation`);
        continue;
      }
      let op;
      try {
        op = await this.#evidenceOperation(support.operationId);
      } catch (err) {
        problems.push(`${criterion.id}: ${err?.message ?? String(err)}`);
        continue;
      }
      if (op.status !== Outcome.SUCCESS_VERIFIED) {
        problems.push(`${criterion.id}: operation ${shortId(support.operationId)} ended as ${op.status}`);
      } else if (Array.isArray(op.errors) && op.errors.length > 0) {
        problems.push(`${criterion.id}: operation ${shortId(support.operationId)} carries ${op.errors.length} error(s)`);
      }
    }
    if (problems.length > 0) {
      throw new ValidationError(`goal cannot be completed: ${problems.join('; ')}`, 'COMPLETION_UNVERIFIED');
    }
  }

  async transition(ref, to, { reason = null, by = null } = {}) {
    if (!Object.values(GoalStatus).includes(to)) throw new ValidationError(`unknown goal status "${singleLine(to, 40)}"`);
    return this.#mutate(async (goals) => {
      const goal = this.#pick(goals, ref);
      const text = typeof reason === 'string' ? reason.trim() : '';
      if (['blocked', 'failed', 'cancelled', 'abandoned', 'superseded'].includes(to) && text.length === 0) {
        throw new ValidationError(`a ${to} goal needs a recorded reason`);
      }
      if (text.length > MAX_GOAL_REASON_CHARS) throw new ValidationError(`reason exceeds ${MAX_GOAL_REASON_CHARS} characters`);
      assertNoSecret(text, 'the reason');
      if (to === GoalStatus.COMPLETED) await this.#verifyCriteria(goal);
      return {
        ...this.#base('goal_transition', goal.id),
        from: goal.status,
        to,
        reason: text,
        by: by ?? null,
      };
    });
  }

  async addEvidence(ref, { criterionId, kind, operationId = null, detail = null, reopen = false }) {
    return this.#mutate(async (goals) => {
      const goal = this.#pick(goals, ref);
      const criterion = goal.criteria.find((c) => c.id === criterionId);
      if (!criterion) throw new ValidationError(`no success criterion ${singleLine(criterionId, 40)} in this goal`);
      if (typeof detail === 'string' && detail.length > MAX_GOAL_DETAIL_CHARS) {
        throw new ValidationError(`evidence detail exceeds ${MAX_GOAL_DETAIL_CHARS} characters`);
      }
      assertNoSecret(detail ?? '', 'the evidence detail');
      if (kind === 'supports') {
        const op = await this.#evidenceOperation(operationId);
        if (op.status !== Outcome.SUCCESS_VERIFIED) {
          throw new ValidationError(`operation ${shortId(operationId)} ended as ${op.status}, so it cannot support a completed goal`, 'EVIDENCE_NOT_VERIFIED');
        }
        if (Array.isArray(op.errors) && op.errors.length > 0) {
          throw new ValidationError(`operation ${shortId(operationId)} carries ${op.errors.length} error(s), so its evidence is incomplete`, 'EVIDENCE_NOT_VERIFIED');
        }
      } else if (kind === 'contradicts' && operationId) {
        await this.#evidenceOperation(operationId);
      }
      return {
        ...this.#base('goal_evidence', goal.id),
        criterionId,
        kind,
        operationId: operationId ?? null,
        detail: detail ?? null,
        reopen: reopen === true,
      };
    });
  }

  async link(ref, { planId = null, taskId = null } = {}) {
    return this.#mutate((goals) => {
      const goal = this.#pick(goals, ref);
      return { ...this.#base('goal_linked', goal.id), planId, taskId };
    });
  }

  // Read-only view of the write lock, for diagnostics and recovery inspection.
  async lockState() {
    return this.lock.state();
  }

  async recover() {
    return this.lock.recover();
  }
}

export { isOpenStatus };
