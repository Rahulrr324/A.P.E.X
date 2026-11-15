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
import { parseIsoInstant, shortId, singleLine } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { maskSecretLeaves } from '../security/secrets.js';
import {
  GOAL_SCHEMA,
  GoalBasis,
  GoalStatus,
  MAX_CRITERIA,
  MAX_CRITERION_CHARS,
  MAX_GOAL_DETAIL_CHARS,
  MAX_GOAL_ITEMS,
  MAX_GOAL_ITEM_CHARS,
  MAX_GOAL_REQUEST_CHARS,
  MAX_GOAL_REASON_CHARS,
  MAX_GOAL_REF_CHARS,
  Requirement,
  isOpenStatus,
  needsUserDecision,
  reduceEvents,
  requirementOf,
  validateEventShape,
} from './model.js';

function assertNoSecret(value, name) {
  if (containsSecret(String(value ?? ''))) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  }
}

function criterionText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ValidationError(`${name} is empty`);
  const text = value.trim();
  if (text.length > MAX_CRITERION_CHARS) throw new ValidationError(`${name} exceeds ${MAX_CRITERION_CHARS} characters`);
  assertNoSecret(text, name);
  return text;
}

// One criterion as the caller stated it. A plain string is the user's own words, which is what a
// criterion has always meant here; an object may say where it came from and what would prove it.
// A non-user basis cannot be recorded as a requirement - the reducer enforces that again, and the
// store does not write a field the log would refuse.
function criterionPayload(raw, i) {
  if (typeof raw === 'string') {
    return { id: `c${i + 1}`, description: criterionText(raw, `criterion ${i + 1}`) };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError(`criterion ${i + 1} is not text or an object`);
  for (const key of Object.keys(raw)) {
    if (!['id', 'description', 'basis', 'requirement', 'ref', 'requiredEvidence'].includes(key)) {
      throw new ValidationError(`criterion ${i + 1}: unexpected field "${singleLine(key, 40)}"`);
    }
  }
  if (raw.id !== undefined && raw.id !== null) {
    throw new ValidationError(`criterion ${i + 1}: ids are assigned by position, so the caller cannot set one`);
  }
  const basis = raw.basis === undefined || raw.basis === null ? GoalBasis.USER_STATED : String(raw.basis).trim();
  if (!Object.values(GoalBasis).includes(basis) || basis === GoalBasis.VERIFIED_FACT) {
    throw new ValidationError(`criterion ${i + 1}: basis must be one of ${GoalBasis.USER_STATED}, ${GoalBasis.SYSTEM_INFERRED}, ${GoalBasis.ASSUMPTION}`);
  }
  const requirement = raw.requirement === undefined || raw.requirement === null
    ? null
    : String(raw.requirement).trim();
  if (requirement !== null && !Object.values(Requirement).includes(requirement)) {
    throw new ValidationError(`criterion ${i + 1}: requirement must be ${Requirement.REQUIRED} or ${Requirement.SUGGESTED}`);
  }
  if (requirement === Requirement.DECLINED) {
    throw new ValidationError(`criterion ${i + 1}: a declined criterion is recorded by goal confirm, not by writing it into the goal`);
  }
  if (basis !== GoalBasis.USER_STATED && requirement === Requirement.REQUIRED) {
    throw new ValidationError(`criterion ${i + 1}: a criterion the system ${basis === GoalBasis.ASSUMPTION ? 'assumed' : 'inferred'} cannot be recorded as a requirement; the user confirms it separately`);
  }
  const entry = {
    id: `c${i + 1}`,
    description: criterionText(raw.description, `criterion ${i + 1}`),
    basis,
    ...(requirement ? { requirement } : {}),
  };
  if (raw.ref !== undefined && raw.ref !== null) {
    const ref = String(raw.ref).trim();
    if (ref.length === 0 || ref.length > MAX_GOAL_REF_CHARS) {
      throw new ValidationError(`criterion ${i + 1}: reference must be between 1 and ${MAX_GOAL_REF_CHARS} characters`);
    }
    assertNoSecret(ref, `criterion ${i + 1} reference`);
    entry.ref = ref;
  }
  if (raw.requiredEvidence !== undefined && raw.requiredEvidence !== null) {
    entry.requiredEvidence = criterionText(raw.requiredEvidence, `criterion ${i + 1} required evidence`);
  }
  return entry;
}

// The decomposition fields a write supplies. A field the caller did not send is left out of the
// event entirely, which is how the reducer tells "nothing to say about this" from "none".
function itemsFor(fields) {
  const out = {};
  for (const [field, list] of Object.entries(fields)) {
    const value = itemPayload(list, field);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

// A goal-level decomposition field, normalised into the shape the log stores. Only the caller's
// own words default to `user_stated`; anything else must say where it came from, and a claim of a
// verified fact must name the record it was verified by.
function itemPayload(list, field) {
  if (list === undefined || list === null) return undefined;
  if (!Array.isArray(list)) throw new ValidationError(`${field} must be a list`);
  if (list.length > MAX_GOAL_ITEMS) throw new ValidationError(`${field} may hold at most ${MAX_GOAL_ITEMS} items`);
  return list.map((raw, i) => {
    const name = `${field} ${i + 1}`;
    const source = typeof raw === 'string' ? { text: raw } : raw;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new ValidationError(`${name} is not text or an object`);
    for (const key of Object.keys(source)) {
      if (!['text', 'basis', 'ref'].includes(key)) throw new ValidationError(`${name}: unexpected field "${singleLine(key, 40)}"`);
    }
    if (typeof source.text !== 'string' || source.text.trim().length === 0) throw new ValidationError(`${name} is empty`);
    const text = source.text.trim();
    if (text.length > MAX_GOAL_ITEM_CHARS) throw new ValidationError(`${name} exceeds ${MAX_GOAL_ITEM_CHARS} characters`);
    assertNoSecret(text, name);
    const basis = source.basis === undefined || source.basis === null ? GoalBasis.USER_STATED : String(source.basis).trim();
    if (!Object.values(GoalBasis).includes(basis)) throw new ValidationError(`${name}: unknown basis "${singleLine(basis, 40)}"`);
    let ref = null;
    if (source.ref !== undefined && source.ref !== null) {
      ref = String(source.ref).trim();
      if (ref.length === 0 || ref.length > MAX_GOAL_REF_CHARS) {
        throw new ValidationError(`${name}: reference must be between 1 and ${MAX_GOAL_REF_CHARS} characters`);
      }
      assertNoSecret(ref, `${name} reference`);
    }
    if (basis === GoalBasis.VERIFIED_FACT && ref === null) {
      throw new ValidationError(`${name}: a verified fact must name the record that verifies it`);
    }
    return { field, text, basis, ...(ref ? { ref } : {}) };
  });
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

  // The log replayed to one cutoff: only events stamped at or before it, derived by the reducer
  // every other read uses. `at` is when the event was recorded, so a completion, cancellation,
  // supersession, evidence record, criterion decision, or revision recorded later is not in the
  // replay and cannot change the past lifecycle.
  //
  // Filtering by `at` preserves append order among the events it keeps. When the clock was not
  // monotonic a surviving subsequence can fail to apply, and those problems are reported rather
  // than hidden: reordering events to make the replay succeed would invent a chronology the
  // records do not carry. A damaged full log still refuses the whole read, as it does everywhere
  // else in this store.
  async historicalView(knownAt, { withCurrent = true } = {}) {
    const cutoff = parseIsoInstant(knownAt);
    if (cutoff === null) {
      throw new ValidationError(`"${singleLine(knownAt, 60)}" is not an ISO date or an ISO date-time with a time zone`);
    }
    const cutoffMs = Date.parse(cutoff);
    const { records } = await this.#readComplete();
    const known = [];
    const later = [];
    let undated = 0;
    for (const record of records) {
      const at = Date.parse(record.at);
      if (Number.isNaN(at)) undated += 1;
      else if (at <= cutoffMs) known.push(record);
      else later.push({ at: record.at, type: record.type, goalId: record.goalId });
    }
    const derived = reduceEvents(known);
    const current = withCurrent ? reduceEvents(records) : null;
    return {
      cutoff,
      records: known.length,
      excluded: later.length,
      undated,
      goals: derived.goals,
      problems: derived.problems,
      later,
      current: withCurrent ? { goals: current.goals, problems: current.problems } : null,
      note: `replayed ${known.length} goal-log event(s) recorded at or before ${cutoff}; ${later.length} later event(s) are not included, so a later completion, cancellation, supersession, evidence record, criterion decision, or revision does not apply`,
    };
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

  async createGoal({
    request, criteria, priority = 3, deadline = null, dependsOn = [], reason = null,
    prerequisites = null, constraints = null, resources = null, timeConditions = null,
    blockers = null, unknowns = null,
  }) {
    assertNoSecret(request, 'the goal');
    if (!Array.isArray(criteria) || criteria.length === 0) throw new ValidationError('at least one success criterion is required');
    if (criteria.length > MAX_CRITERIA) throw new ValidationError(`at most ${MAX_CRITERIA} success criteria are allowed`);
    const goalId = this.idFactory();
    return this.#mutate(() => {
      const entries = criteria.map((raw, i) => criterionPayload(raw, i));
      if (deadline !== null && (typeof deadline !== 'string' || Number.isNaN(Date.parse(deadline)))) {
        throw new ValidationError('deadline must be an ISO date or time');
      }
      return {
        ...this.#base('goal_created', goalId),
        origin: 'user',
        request: String(request).trim(),
        criteria: entries,
        ...itemsFor({ prerequisites, constraints, resources, timeConditions, blockers, unknowns }),
        priority,
        deadline,
        dependsOn: [...dependsOn],
        reason: reason ?? 'recorded by the user',
      };
    });
  }

  // Revising replaces the success criteria (and optionally the request, priority, or deadline).
  // It is accepted only while the goal is open; a completed goal must be reopened with
  // contradicting evidence first. Evidence recorded for the old criteria stays in the log but
  // no longer counts, because the reducer rebuilds the criteria as pending. A decomposition field
  // the revision does not mention keeps its record; one sent as an empty list clears the field.
  async revise(ref, {
    request = undefined, criteria, priority = undefined, deadline = undefined, reason,
    prerequisites = undefined, constraints = undefined, resources = undefined,
    timeConditions = undefined, blockers = undefined, unknowns = undefined,
  }) {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (text.length === 0) throw new ValidationError('a revision needs a reason');
    if (text.length > MAX_GOAL_REASON_CHARS) throw new ValidationError(`reason exceeds ${MAX_GOAL_REASON_CHARS} characters`);
    assertNoSecret(text, 'the reason');
    if (request !== undefined) assertNoSecret(request, 'the goal');
    if (!Array.isArray(criteria) || criteria.length === 0) throw new ValidationError('at least one success criterion is required');
    if (criteria.length > MAX_CRITERIA) throw new ValidationError(`at most ${MAX_CRITERIA} success criteria are allowed`);
    if (deadline !== undefined && deadline !== null && (typeof deadline !== 'string' || Number.isNaN(Date.parse(deadline)))) {
      throw new ValidationError('deadline must be an ISO date or time');
    }
    return this.#mutate((goals) => {
      const goal = this.#pick(goals, ref);
      if (!isOpenStatus(goal.status)) {
        throw new ValidationError(`goal is ${goal.status}; its criteria can be revised only while it is proposed, accepted, active, or blocked`);
      }
      const entries = criteria.map((raw, i) => criterionPayload(raw, i));
      return {
        ...this.#base('goal_revised', goal.id),
        ...(request !== undefined ? { request: String(request).trim() } : {}),
        criteria: entries,
        ...itemsFor({ prerequisites, constraints, resources, timeConditions, blockers, unknowns }),
        ...(priority !== undefined ? { priority } : {}),
        ...(deadline !== undefined ? { deadline } : {}),
        reason: text,
      };
    });
  }

  // The user's own decision about what a criterion requires. This is the only path by which a
  // criterion the system inferred becomes a requirement, and the only path by which a criterion
  // stops counting toward completion without a revision of the whole goal. The reason is required,
  // because a decision that cannot say why it was made cannot be checked later.
  async decideCriterion(ref, { criterionId, decision, reason, operationId = null }) {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (text.length === 0) throw new ValidationError('a criterion decision needs a recorded reason');
    if (text.length > MAX_GOAL_REASON_CHARS) throw new ValidationError(`reason exceeds ${MAX_GOAL_REASON_CHARS} characters`);
    assertNoSecret(text, 'the reason');
    if (!Object.values(Requirement).includes(decision)) {
      throw new ValidationError(`decision must be one of: ${Object.values(Requirement).join(', ')}`);
    }
    if (operationId !== null && (typeof operationId !== 'string' || operationId.length === 0 || operationId.length > 64)) {
      throw new ValidationError('the decision operation reference is not usable');
    }
    // A decision that cites an audit record must cite one that exists, or the citation would be a
    // claim about provenance nothing can confirm. The record's own outcome is not judged: the
    // decision is the user's, and it stands whichever operation it was made during.
    if (operationId !== null) await this.#evidenceOperation(operationId);
    return this.#mutate((goals) => {
      const goal = this.#pick(goals, ref);
      if (!goal.criteria.some((c) => c.id === criterionId)) {
        throw new ValidationError(`no success criterion ${singleLine(criterionId, 40)} in this goal`);
      }
      return {
        ...this.#base('goal_criterion_decision', goal.id),
        criterionId,
        decision,
        reason: text,
        operationId,
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

  // Every criterion the goal requires must be satisfied by a support whose operation is still a
  // verified success in the audit log, and no criterion may be left waiting for the user's
  // decision. This is re-run inside the lock immediately before the completion event is appended,
  // so completion cannot rest on a stale claim about an operation, and the reducer's own gate is
  // not the only thing standing between a suggestion and a completed goal.
  async #verifyCriteria(goal) {
    const problems = [];
    const undecided = goal.criteria.filter((c) => needsUserDecision(c));
    if (undecided.length > 0) {
      problems.push(`${undecided.map((c) => c.id).join(', ')} ${undecided.length === 1 ? 'is' : 'are'} recorded as ${undecided.length === 1 ? 'a suggestion' : 'suggestions'} with no user decision: goal confirm ${shortId(goal.id)} ${undecided[0].id} required|suggested|declined --reason <text>`);
    }
    const required = goal.criteria.filter((c) => requirementOf(c) === Requirement.REQUIRED);
    if (required.length === 0) {
      // Completing a goal that requires nothing would prove nothing, so the record that says
      // "complete" would be a claim with no evidence behind it. The user decides what counts.
      problems.push(`no criterion is recorded as required, so completing this goal would prove nothing: goal confirm ${shortId(goal.id)} <criterion> required --reason <text>, or revise the goal`);
    }
    for (const criterion of required) {
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

  async link(ref, { planId = null, taskId = null, entityId = null, worldEventId = null } = {}) {
    return this.#mutate((goals) => {
      const goal = this.#pick(goals, ref);
      return { ...this.#base('goal_linked', goal.id), planId, taskId, entityId, worldEventId };
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
