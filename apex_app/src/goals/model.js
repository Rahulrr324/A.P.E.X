// Goal model: states, legal transitions, and the reducer that rebuilds goal state from the
// append-only event log (goals.jsonl). Pure functions only: no I/O and no execution here.
//
// A goal is a user's stated intention, not permission to act. Nothing in this file authorizes
// an action: a goal, its plan, and its evidence are records, and every action they lead to is
// still authorized separately by the action registry.
//
// Completion is explicit and evidence-backed. The reducer refuses a `completed` transition
// unless every success criterion is marked satisfied; the store re-checks each criterion's
// supporting operation against the audit log before the event is appended. Contradicting
// evidence on a completed goal does not silently rewrite it: the event must say `reopen`, and
// the goal returns to `blocked` with its whole history intact.
//
// Every part of a goal records who put it there. A criterion the system inferred is stored as
// `suggested`, not as a requirement, because an inference the user never agreed to cannot gate
// the completion of the user's intention; it becomes a requirement only through its own recorded
// user decision (`goal_criterion_decision`), and it can be declined the same way. The goal-level
// decomposition (prerequisites, constraints, resources, time conditions, blockers, unknowns) is
// stored with the same provenance, and a claim recorded as a verified fact must name the record
// that verifies it. Nothing here is derived by guessing: an absent field stays absent, and a
// vague goal is reported as needing clarification by the decomposition view rather than filled in.
import { singleLine } from '../util.js';

export const GOAL_SCHEMA = 1;
export const MAX_GOAL_REQUEST_CHARS = 2000;
export const MAX_CRITERIA = 8;
export const MAX_CRITERION_CHARS = 200;
export const MAX_GOAL_REASON_CHARS = 500;
export const MAX_GOAL_DETAIL_CHARS = 400;
export const MAX_GOAL_DEPENDENCIES = MAX_CRITERIA;
export const CRITERION_ID_RE = /^c[1-9][0-9]?$/;
export const GOAL_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

// The bounded goal-level decomposition. These are the parts of a goal that are not success
// criteria: what has to hold first, what limits the work, what the work needs, when it matters,
// what stands in the way, and what is not known. Each list is capped, and each item carries its
// own provenance, so an inference cannot be printed as a fact the user supplied.
export const MAX_GOAL_ITEMS = 8;
export const MAX_GOAL_ITEM_CHARS = 200;
export const MAX_GOAL_REF_CHARS = 64;

// Where a piece of goal content came from. `user_stated` is the user's own words; `system_inferred`
// is a conclusion APEX drew from the records it holds; `assumption` is something taken to hold
// without evidence; `verified_fact` is a statement a record can be named for, and it must name one.
export const GoalBasis = Object.freeze({
  USER_STATED: 'user_stated',
  SYSTEM_INFERRED: 'system_inferred',
  ASSUMPTION: 'assumption',
  VERIFIED_FACT: 'verified_fact',
});

// A criterion is a condition to be met, so "verified fact" is not a basis for one: a fact does not
// become a requirement the user agreed to by being stated as a criterion.
export const CRITERION_BASES = Object.freeze([
  GoalBasis.USER_STATED, GoalBasis.SYSTEM_INFERRED, GoalBasis.ASSUMPTION,
]);
export const ITEM_BASES = Object.freeze(Object.values(GoalBasis));

// Whether a criterion gates completion. An inferred or assumed criterion starts as `suggested` and
// stays there until the user records a decision, so a plan cannot complete a goal against a
// requirement the user never set. `declined` is a recorded user rejection of an inference: the
// criterion stays in the log as what was suggested and why, and no longer counts toward progress.
export const Requirement = Object.freeze({
  REQUIRED: 'required',
  SUGGESTED: 'suggested',
  DECLINED: 'declined',
});

// The requirements a goal write may record. `declined` is reached only by the user's own recorded
// decision, so it is not a value a goal creation or revision can put in the log.
export const REQUIREMENT_PAYLOADS = Object.freeze([Requirement.REQUIRED, Requirement.SUGGESTED]);

// The decisions `goal_criterion_decision` may record. `suggested` is the way back from a decision
// the user changed; `declined` applies only to a criterion the system put forward.
export const CRITERION_DECISIONS = Object.freeze([
  Requirement.REQUIRED, Requirement.SUGGESTED, Requirement.DECLINED,
]);

export const GOAL_ITEM_FIELDS = Object.freeze([
  'prerequisites', 'constraints', 'resources', 'timeConditions', 'blockers', 'unknowns',
]);

const GATING = Requirement.REQUIRED;

export const GoalStatus = Object.freeze({
  PROPOSED: 'proposed', // recorded, waiting for the user to accept it
  ACCEPTED: 'accepted', // the user accepted it; nothing has run
  ACTIVE: 'active', // the user is pursuing it
  BLOCKED: 'blocked', // an obstacle, a contradicted criterion, or an unavailable capability
  COMPLETED: 'completed', // every criterion has verified evidence
  FAILED: 'failed', // the user recorded that the goal did not succeed
  CANCELLED: 'cancelled',
  ABANDONED: 'abandoned',
  SUPERSEDED: 'superseded', // another goal replaced it
});

export const GOAL_TRANSITIONS = Object.freeze({
  proposed: ['accepted', 'cancelled', 'abandoned', 'superseded'],
  accepted: ['active', 'blocked', 'failed', 'cancelled', 'abandoned', 'superseded'],
  active: ['blocked', 'completed', 'failed', 'cancelled', 'abandoned', 'superseded'],
  blocked: ['active', 'completed', 'failed', 'cancelled', 'abandoned', 'superseded'],
  completed: [], // reopened only by recorded contradicting evidence (goal_evidence with reopen)
  failed: ['cancelled', 'abandoned', 'superseded'],
  cancelled: [],
  abandoned: [],
  superseded: [],
});

// Statuses a goal can still move out of. Duplicate detection uses this: two open goals with the
// same normalized request would be two answers to one intention.
export const OPEN_GOAL_STATUSES = Object.freeze([
  GoalStatus.PROPOSED, GoalStatus.ACCEPTED, GoalStatus.ACTIVE, GoalStatus.BLOCKED,
]);

export const EVIDENCE_KINDS = Object.freeze(['supports', 'contradicts']);

export function isOpenStatus(status) {
  return OPEN_GOAL_STATUSES.includes(status);
}

// The comparison key for duplicate detection. Case, runs of whitespace, and trailing punctuation
// are presentation, so they are ignored; two goals that differ only in those are the same request.
export function normalizeRequest(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?;:,\s]+$/g, '')
    .trim();
}

// A stable description of what a goal needs in order to be complete. Used by the store for its
// duplicate check and by the renderer for progress; it states counts only, never content.
//
// `satisfied`, `contradicted`, `pending`, and `total` count every criterion as they always did.
// The gating counts answer a different question - what has to be true for this goal to be
// complete - and are kept separate so an unsatisfied suggestion cannot look like unmet work, and
// unmet work cannot look like an unsatisfied suggestion.
export function goalProgress(goal) {
  const criteria = Array.isArray(goal?.criteria) ? goal.criteria : [];
  const satisfied = criteria.filter((c) => c.status === 'satisfied').length;
  const contradicted = criteria.filter((c) => c.status === 'contradicted').length;
  const gating = criteria.filter((c) => requirementOf(c) === GATING);
  const gatingSatisfied = gating.filter((c) => c.status === 'satisfied').length;
  const userStated = criteria.filter((c) => !c.basis || c.basis === GoalBasis.USER_STATED).length;
  return {
    satisfied,
    contradicted,
    pending: criteria.length - satisfied - contradicted,
    total: criteria.length,
    gating: gating.length,
    gatingSatisfied,
    gatingPending: gating.length - gatingSatisfied,
    suggested: criteria.filter((c) => requirementOf(c) === Requirement.SUGGESTED).length,
    declined: criteria.filter((c) => requirementOf(c) === Requirement.DECLINED).length,
    // Inferred or assumed criteria the user has neither accepted nor declined. APEX reports these
    // as needing a decision; it does not decide them, and it does not treat them as requirements.
    needsConfirmation: criteria.filter((c) => needsUserDecision(c)).length,
    userStated,
    inferred: criteria.length - userStated,
  };
}

// A criterion that is still an open question for the user: something APEX put forward, recorded as
// a suggestion, with no decision of the user's own on record. A suggestion the user stated in their
// own words, or one they have since decided with `goal confirm`, is not an open question - it is
// their choice about their own goal, and the goal can complete without it.
export function needsUserDecision(criterion) {
  return requirementOf(criterion) === Requirement.SUGGESTED
    && basisOf(criterion) !== GoalBasis.USER_STATED
    && !criterion?.confirmation;
}

// The recorded requirement of a criterion. A criterion written before this field existed was
// written by the user, so `required` is what that record already meant.
export function requirementOf(criterion) {
  const value = criterion?.requirement;
  if (value === Requirement.SUGGESTED || value === Requirement.DECLINED) return value;
  return GATING;
}

// The recorded provenance of a criterion, item, or field. An absent basis is the user's own words,
// because that is the only basis a goal could be written with before provenance existed.
export function basisOf(entry) {
  const value = entry?.basis;
  return CRITERION_BASES.includes(value) || value === GoalBasis.VERIFIED_FACT ? value : GoalBasis.USER_STATED;
}

function evidenceEntry(e) {
  return {
    kind: e.kind,
    operationId: e.operationId ?? null,
    detail: e.detail ?? null,
    at: e.at,
  };
}

function criterionEntry(c, at) {
  const basis = c.basis ?? GoalBasis.USER_STATED;
  // The user's own criterion gates completion unless the user says otherwise. Anything the system
  // put forward gates nothing until the user records a decision about it, so `required` is not
  // reachable here for a non-user-stated basis - that is what `goal_criterion_decision` is for.
  const requested = c.requirement === undefined || c.requirement === null
    ? (basis === GoalBasis.USER_STATED ? GATING : Requirement.SUGGESTED)
    : c.requirement;
  const requirement = basis === GoalBasis.USER_STATED ? requested : Requirement.SUGGESTED;
  return {
    id: c.id,
    description: c.description,
    basis,
    requirement,
    ...(c.ref ? { ref: c.ref } : {}),
    ...(c.requiredEvidence ? { requiredEvidence: c.requiredEvidence } : {}),
    // The user's decision, when one was recorded, with the act that recorded it. A criterion with
    // no decision here has never been confirmed by the user; nothing else stands in for one.
    confirmation: null,
    status: 'pending',
    evidence: [],
    updatedAt: at,
  };
}

// One goal-level decomposition item, in the shape the log stores. `verified_fact` must name the
// record it is verified by; the store and the action layer normalise looser input into this.
export function goalItem(raw, field) {
  const text = String(raw?.text ?? '').trim();
  const basis = raw?.basis ?? GoalBasis.USER_STATED;
  const ref = raw?.ref === undefined || raw?.ref === null ? null : String(raw.ref).trim();
  return { field, text, basis, ...(ref ? { ref } : {}) };
}

function itemListProblem(list, field) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) return `${field} must be a list`;
  if (list.length > MAX_GOAL_ITEMS) return `${field} may hold at most ${MAX_GOAL_ITEMS} items`;
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return `a ${field} item is not an object`;
    if (typeof item.text !== 'string' || item.text.trim().length === 0) return `a ${field} item has no text`;
    if (item.text.length > MAX_GOAL_ITEM_CHARS) return `a ${field} item exceeds ${MAX_GOAL_ITEM_CHARS} characters`;
    if (!ITEM_BASES.includes(item.basis)) return `a ${field} item has an unknown basis`;
    if (item.ref !== undefined && item.ref !== null
      && (typeof item.ref !== 'string' || item.ref.trim().length === 0 || item.ref.length > MAX_GOAL_REF_CHARS)) {
      return `a ${field} item has a bad record reference`;
    }
    // A fact is a fact because a record says so. Without a reference the claim is an assumption,
    // and it is stored as one or refused; "verified" is not a word APEX may apply to itself.
    if (item.basis === GoalBasis.VERIFIED_FACT && (item.ref === undefined || item.ref === null)) {
      return `a ${field} item recorded as a verified fact must name the record that verifies it`;
    }
  }
  return null;
}

function criterionProblem(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'bad criterion';
  if (typeof c.id !== 'string' || !CRITERION_ID_RE.test(c.id)) return 'bad criterion id';
  if (typeof c.description !== 'string' || c.description.trim().length === 0 || c.description.length > MAX_CRITERION_CHARS) {
    return 'bad criterion description';
  }
  if (c.basis !== undefined && c.basis !== null && !CRITERION_BASES.includes(c.basis)) return 'bad criterion basis';
  if (c.requirement !== undefined && c.requirement !== null && !REQUIREMENT_PAYLOADS.includes(c.requirement)) {
    return 'bad criterion requirement';
  }
  if (c.basis && c.basis !== GoalBasis.USER_STATED && c.requirement === GATING) {
    return 'a criterion the system inferred cannot be recorded as a requirement';
  }
  if (c.ref !== undefined && c.ref !== null
    && (typeof c.ref !== 'string' || c.ref.trim().length === 0 || c.ref.length > MAX_GOAL_REF_CHARS)) {
    return 'bad criterion reference';
  }
  if (c.requiredEvidence !== undefined && c.requiredEvidence !== null
    && (typeof c.requiredEvidence !== 'string' || c.requiredEvidence.trim().length === 0
      || c.requiredEvidence.length > MAX_GOAL_ITEM_CHARS)) {
    return 'bad required-evidence description';
  }
  return null;
}

function itemsOf(event) {
  const out = {};
  for (const field of GOAL_ITEM_FIELDS) {
    if (Array.isArray(event[field])) out[field] = event[field].map((item) => goalItem(item, field));
  }
  return out;
}

// ---- reducer ----------------------------------------------------------------

export function validateEventShape(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'not an object';
  if (e.schema !== GOAL_SCHEMA) return 'unsupported schema';
  if (typeof e.eventId !== 'string' || e.eventId.length === 0) return 'missing event id';
  if (typeof e.goalId !== 'string' || !GOAL_ID_RE.test(e.goalId)) return 'missing goal id';
  if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) return 'bad timestamp';

  if (e.type === 'goal_created') {
    if (e.origin !== 'user') return 'unknown origin';
    if (typeof e.request !== 'string' || e.request.trim().length === 0) return 'missing request';
    if (e.request.length > MAX_GOAL_REQUEST_CHARS) return 'request too long';
    if (!Array.isArray(e.criteria) || e.criteria.length === 0) return 'at least one success criterion is required';
    if (e.criteria.length > MAX_CRITERIA) return `at most ${MAX_CRITERIA} success criteria are allowed`;
    const ids = new Set();
    for (const c of e.criteria) {
      const problem = criterionProblem(c);
      if (problem) return problem;
      if (ids.has(c.id)) return 'duplicate criterion id';
      ids.add(c.id);
    }
    for (const field of GOAL_ITEM_FIELDS) {
      const problem = itemListProblem(e[field], field);
      if (problem) return problem;
    }
    if (!Number.isInteger(e.priority) || e.priority < 1 || e.priority > 5) return 'bad priority';
    if (e.deadline !== null && (typeof e.deadline !== 'string' || Number.isNaN(Date.parse(e.deadline)))) return 'bad deadline';
    if (!Array.isArray(e.dependsOn)) return 'missing dependencies';
    if (e.dependsOn.length > MAX_GOAL_DEPENDENCIES) return `at most ${MAX_GOAL_DEPENDENCIES} dependencies are allowed`;
    for (const d of e.dependsOn) {
      if (typeof d !== 'string' || d.length === 0 || d.length > 64) return 'bad dependency';
      if (d === e.goalId) return 'a goal cannot depend on itself';
    }
    if (e.reason !== undefined && e.reason !== null && typeof e.reason !== 'string') return 'bad reason';
    return null;
  }

  if (e.type === 'goal_transition') {
    if (typeof e.from !== 'string' || typeof e.to !== 'string') return 'missing transition states';
    if (typeof e.reason !== 'string') return 'missing reason';
    if (e.by !== undefined && e.by !== null && (typeof e.by !== 'string' || !GOAL_ID_RE.test(e.by))) return 'bad replacement goal';
    if (e.evidence !== undefined && e.evidence !== null) {
      if (!Array.isArray(e.evidence)) return 'bad completion evidence';
      for (const item of e.evidence) {
        if (!item || typeof item.criterionId !== 'string' || typeof item.operationId !== 'string') return 'bad completion evidence entry';
      }
    }
    return null;
  }

  if (e.type === 'goal_evidence') {
    if (typeof e.criterionId !== 'string' || !CRITERION_ID_RE.test(e.criterionId)) return 'bad criterion id';
    if (!EVIDENCE_KINDS.includes(e.kind)) return 'unknown evidence kind';
    if (e.operationId !== undefined && e.operationId !== null && (typeof e.operationId !== 'string' || e.operationId.length === 0 || e.operationId.length > 64)) {
      return 'bad evidence operation';
    }
    if (e.kind === 'supports' && (typeof e.operationId !== 'string' || e.operationId.length === 0)) {
      return 'supporting evidence must name an operation record';
    }
    if (e.detail !== undefined && e.detail !== null && (typeof e.detail !== 'string' || e.detail.length > MAX_GOAL_DETAIL_CHARS)) {
      return 'bad evidence detail';
    }
    if (e.reopen !== undefined && typeof e.reopen !== 'boolean') return 'bad reopen flag';
    return null;
  }

  if (e.type === 'goal_linked') {
    const ok = (v) => v === undefined || v === null || (typeof v === 'string' && v.length > 0 && v.length <= 64);
    if (![e.planId, e.taskId, e.entityId, e.worldEventId].every(ok)) return 'bad link';
    if ([e.planId, e.taskId, e.entityId, e.worldEventId].every((v) => (v ?? null) === null)) {
      return 'a link must name a plan, a task, a world entity, or a world event';
    }
    return null;
  }

  if (e.type === 'goal_revised') {
    if (e.request !== undefined && (typeof e.request !== 'string' || e.request.trim().length === 0 || e.request.length > MAX_GOAL_REQUEST_CHARS)) {
      return 'bad revised request';
    }
    if (!Array.isArray(e.criteria) || e.criteria.length === 0) return 'at least one success criterion is required';
    if (e.criteria.length > MAX_CRITERIA) return `at most ${MAX_CRITERIA} success criteria are allowed`;
    const ids = new Set();
    for (const c of e.criteria) {
      const problem = criterionProblem(c);
      if (problem) return problem;
      if (ids.has(c.id)) return 'duplicate criterion id';
      ids.add(c.id);
    }
    for (const field of GOAL_ITEM_FIELDS) {
      const problem = itemListProblem(e[field], field);
      if (problem) return problem;
    }
    if (e.priority !== undefined && (!Number.isInteger(e.priority) || e.priority < 1 || e.priority > 5)) return 'bad priority';
    if (e.deadline !== undefined && e.deadline !== null && (typeof e.deadline !== 'string' || Number.isNaN(Date.parse(e.deadline)))) {
      return 'bad deadline';
    }
    if (typeof e.reason !== 'string' || e.reason.trim().length === 0) return 'a revision needs a reason';
    if (e.reason.length > MAX_GOAL_REASON_CHARS) return 'revision reason too long';
    return null;
  }

  if (e.type === 'goal_criterion_decision') {
    if (typeof e.criterionId !== 'string' || !CRITERION_ID_RE.test(e.criterionId)) return 'bad criterion id';
    if (!CRITERION_DECISIONS.includes(e.decision)) return 'unknown criterion decision';
    if (typeof e.reason !== 'string' || e.reason.trim().length === 0) return 'a criterion decision needs a recorded reason';
    if (e.reason.length > MAX_GOAL_REASON_CHARS) return 'criterion decision reason too long';
    if (e.operationId !== undefined && e.operationId !== null
      && (typeof e.operationId !== 'string' || e.operationId.length === 0 || e.operationId.length > 64)) {
      return 'bad decision operation';
    }
    return null;
  }

  return 'unknown event type';
}

function finding(goals, excludeId, request) {
  const key = normalizeRequest(request);
  for (const other of goals.values()) {
    if (other.id === excludeId) continue;
    if (!isOpenStatus(other.status)) continue;
    if (normalizeRequest(other.request) === key) return other;
  }
  return null;
}

// Applies one event to `goals` (a Map). Returns a problem string, or null when applied.
// Nothing is changed when a problem is returned.
export function applyEvent(goals, e) {
  const shape = validateEventShape(e);
  if (shape) return shape;

  if (e.type === 'goal_created') {
    if (goals.has(e.goalId)) return 'goal id already exists';
    const duplicate = finding(goals, e.goalId, e.request);
    if (duplicate) return `an open goal already records this request (${singleLine(duplicate.id, 40)})`;
    const dependencyIds = new Set();
    for (const d of e.dependsOn) {
      if (dependencyIds.has(d)) return `dependency ${singleLine(d, 40)} is listed twice`;
      dependencyIds.add(d);
      const dep = goals.get(d);
      if (!dep) return `unknown dependency goal ${singleLine(d, 40)}`;
      if (dep.status === GoalStatus.CANCELLED || dep.status === GoalStatus.ABANDONED || dep.status === GoalStatus.SUPERSEDED) {
        return `dependency goal ${singleLine(d, 40)} is ${dep.status}`;
      }
    }
    const goal = {
      id: e.goalId,
      origin: e.origin,
      request: e.request,
      criteria: e.criteria.map((c) => criterionEntry(c, e.at)),
      // The decomposition fields the record carries, and nothing else: a field the user did not
      // state and APEX did not infer is absent, which is what the decomposition view reports as
      // "not recorded" rather than as an empty answer or an invented one.
      ...Object.fromEntries(GOAL_ITEM_FIELDS.map((f) => [f, itemsOf(e)[f] ?? []])),
      priority: e.priority,
      deadline: e.deadline ?? null,
      dependsOn: [...e.dependsOn],
      revision: 1,
      revisionHistory: [{ revision: 1, at: e.at, reason: e.reason ?? 'recorded' }],
      status: GoalStatus.PROPOSED,
      statusHistory: [{ from: null, to: GoalStatus.PROPOSED, at: e.at, reason: e.reason ?? 'recorded' }],
      blockedReason: null,
      contradiction: null,
      completion: null,
      planIds: [],
      taskIds: [],
      entityIds: [],
      worldEventIds: [],
      createdAt: e.at,
      updatedAt: e.at,
    };
    goals.set(goal.id, goal);
    return null;
  }

  const goal = goals.get(e.goalId);
  if (!goal) return 'unknown goal';

  if (e.type === 'goal_transition') {
    if (goal.status !== e.from) return `goal is ${goal.status}, event expected ${e.from}`;
    if (!GOAL_TRANSITIONS[e.from]?.includes(e.to)) return `illegal goal transition ${e.from} -> ${e.to}`;
    // The events that record a reason for stopping must actually carry one.
    if (['blocked', 'failed', 'cancelled', 'abandoned', 'superseded'].includes(e.to) && e.reason.trim().length === 0) {
      return `a ${e.to} goal needs a recorded reason`;
    }
    if (e.to === GoalStatus.SUPERSEDED) {
      if (!e.by) return 'a superseded goal must name the goal that replaces it';
      const replacement = goals.get(e.by);
      if (!replacement) return `unknown replacement goal ${singleLine(e.by, 40)}`;
      if (replacement.id === goal.id) return 'a goal cannot supersede itself';
      if (replacement.status === GoalStatus.SUPERSEDED) return 'the replacement goal is itself superseded';
    }
    if (e.to === GoalStatus.ACTIVE) {
      for (const d of goal.dependsOn) {
        const dep = goals.get(d);
        if (!dep) return `unknown dependency goal ${singleLine(d, 40)}`;
        if (dep.status !== GoalStatus.COMPLETED) return `dependency goal ${singleLine(d, 40)} is ${dep.status}, not completed`;
      }
      const active = finding(goals, goal.id, goal.request);
      if (active && active.status === GoalStatus.ACTIVE) {
        return `another goal already records this request as active (${singleLine(active.id, 40)})`;
      }
    }
    if (e.to === GoalStatus.COMPLETED) {
      // An undecided inference is an open question, not a requirement and not a dismissal.
      // Completion waits for the user's decision either way, which is what keeps an inference APEX
      // made from being completed past - or completed away - without the user saying anything. A
      // suggestion the user stated or has since decided is their own choice, and waits for nothing.
      const undecided = goal.criteria.filter((c) => needsUserDecision(c));
      if (undecided.length > 0) {
        const ids = undecided.map((c) => c.id).join(', ');
        return `goal cannot be completed: ${ids} ${undecided.length === 1 ? 'is' : 'are'} recorded as ${undecided.length === 1 ? 'a suggestion' : 'suggestions'} with no user decision; record goal confirm ${singleLine(goal.id, 40)} ${ids.split(', ')[0]} <required|suggested|declined> --reason <text> first`;
      }
      const gatingCriteria = goal.criteria.filter((c) => requirementOf(c) === GATING);
      // A goal whose every criterion is a suggestion or a dismissal requires nothing, so a
      // completion record would prove nothing. The user decides what the goal counts as done by.
      if (gatingCriteria.length === 0) {
        return `goal cannot be completed: no criterion is recorded as required, so completing it would prove nothing; record goal confirm ${singleLine(goal.id, 40)} <criterion> required --reason <text> or revise the goal`;
      }
      const unsatisfied = gatingCriteria.filter((c) => c.status !== 'satisfied');
      if (unsatisfied.length > 0) {
        return `goal cannot be completed: ${unsatisfied.map((c) => c.id).join(', ')} ${unsatisfied.length === 1 ? 'is' : 'are'} not satisfied`;
      }
      if (gatingCriteria.some((c) => !c.evidence.some((ev) => ev.kind === 'supports'))) {
        return 'goal cannot be completed without supporting evidence for every required criterion';
      }
    }
    const at = e.at;
    goal.status = e.to;
    goal.statusHistory.push({ from: e.from, to: e.to, at, reason: e.reason });
    goal.updatedAt = at;
    if (e.to === GoalStatus.BLOCKED) goal.blockedReason = e.reason;
    if (e.to === GoalStatus.ACTIVE) goal.blockedReason = null;
    if (e.to === GoalStatus.COMPLETED) {
      const gatingCriteria = goal.criteria.filter((c) => requirementOf(c) === GATING);
      goal.completion = {
        at,
        criteria: gatingCriteria.map((c) => ({
          criterionId: c.id,
          operationId: [...c.evidence].reverse().find((ev) => ev.kind === 'supports')?.operationId ?? null,
        })),
        // What the user took out of the goal, recorded at completion rather than dropped, so a
        // later reader can see which criteria the completion did NOT prove and who said so.
        declined: goal.criteria
          .filter((c) => requirementOf(c) === Requirement.DECLINED)
          .map((c) => c.id),
      };
      goal.contradiction = null;
      goal.blockedReason = null;
    }
    if (e.to === GoalStatus.SUPERSEDED) goal.supersededBy = e.by ?? null;
    return null;
  }

  if (e.type === 'goal_evidence') {
    if (goal.status === GoalStatus.CANCELLED || goal.status === GoalStatus.ABANDONED || goal.status === GoalStatus.SUPERSEDED) {
      return `goal is ${goal.status}; no further evidence is accepted`;
    }
    const criterion = goal.criteria.find((c) => c.id === e.criterionId);
    if (!criterion) return `unknown success criterion ${singleLine(e.criterionId, 40)}`;
    const at = e.at;
    const reopen = e.reopen === true;
    if (goal.status === GoalStatus.COMPLETED) {
      if (e.kind === 'supports') return 'goal is completed; supporting evidence is not accepted without reopening it';
      if (!reopen) return 'goal is completed; contradicting evidence must state reopen to reopen it';
    }
    if (e.kind === 'supports' && reopen) return 'reopen applies only to contradicting evidence';
    const duplicate = criterion.evidence.find((ev) => ev.kind === e.kind && ev.operationId === (e.operationId ?? null));
    if (duplicate) return 'this evidence is already recorded for the criterion';
    if (goal.status === GoalStatus.COMPLETED && reopen) {
      goal.status = GoalStatus.BLOCKED;
      goal.statusHistory.push({ from: GoalStatus.COMPLETED, to: GoalStatus.BLOCKED, at, reason: 'contradicting evidence reopened the goal' });
      goal.completion = null;
      goal.blockedReason = 'contradicting evidence reopened a completed goal';
    }
    criterion.evidence.push(evidenceEntry(e));
    criterion.status = e.kind === 'supports' ? 'satisfied' : 'contradicted';
    criterion.updatedAt = at;
    goal.contradiction = e.kind === 'contradicts'
      ? { criterionId: criterion.id, operationId: e.operationId ?? null, detail: e.detail ?? null, at }
      : (goal.contradiction?.criterionId === criterion.id ? null : goal.contradiction);
    goal.updatedAt = at;
    return null;
  }

  if (e.type === 'goal_revised') {
    if (!isOpenStatus(goal.status)) {
      return `goal is ${goal.status}; its criteria can be revised only while it is open`;
    }
    if (e.request !== undefined) {
      const duplicate = finding(goals, goal.id, e.request);
      if (duplicate) return `an open goal already records this request (${singleLine(duplicate.id, 40)})`;
      goal.request = e.request.trim();
    }
    // A revision replaces the success criteria, so evidence for the old wording cannot count
    // toward the new one. The old evidence stays in the event log; it is no longer current.
    goal.criteria = e.criteria.map((c) => criterionEntry(c, e.at));
    // A decomposition field is replaced only when the revision carries that field; an absent field
    // keeps what the record already holds, because the revision said nothing about it. An empty
    // list is a statement, and clears the field.
    const items = itemsOf(e);
    for (const field of GOAL_ITEM_FIELDS) {
      if (items[field]) goal[field] = items[field];
    }
    if (e.priority !== undefined) goal.priority = e.priority;
    if (e.deadline !== undefined) goal.deadline = e.deadline;
    goal.revision = (goal.revision ?? 1) + 1;
    goal.revisionHistory.push({ revision: goal.revision, at: e.at, reason: e.reason });
    goal.completion = null;
    goal.contradiction = null;
    goal.updatedAt = e.at;
    return null;
  }

  if (e.type === 'goal_criterion_decision') {
    // The decision is about what the goal requires, so it is a change to the goal's criteria and is
    // accepted only while the goal is open - the same boundary a criteria revision honours. A
    // completed goal is reopened by contradicting evidence, not by redefining its criteria.
    if (!isOpenStatus(goal.status)) {
      return `goal is ${goal.status}; a criterion decision is accepted only while it is open`;
    }
    const criterion = goal.criteria.find((c) => c.id === e.criterionId);
    if (!criterion) return `unknown success criterion ${singleLine(e.criterionId, 40)}`;
    // The user's own words can be accepted as a requirement or left as a suggestion; they cannot be
    // declined here, because dropping a stated criterion is a revision with its own record and its
    // own consequence for the evidence already gathered.
    if (e.decision === Requirement.DECLINED && basisOf(criterion) === GoalBasis.USER_STATED) {
      return 'a criterion the user stated cannot be declined; revise the goal to remove it';
    }
    if (criterion.confirmation?.decision === e.decision) return 'this decision is already recorded for the criterion';
    criterion.requirement = e.decision;
    criterion.confirmation = {
      decision: e.decision,
      at: e.at,
      reason: e.reason,
      operationId: e.operationId ?? null,
    };
    criterion.updatedAt = e.at;
    goal.updatedAt = e.at;
    return null;
  }

  if (e.type === 'goal_linked') {
    if (goal.status === GoalStatus.CANCELLED || goal.status === GoalStatus.ABANDONED || goal.status === GoalStatus.SUPERSEDED) {
      return `goal is ${goal.status}; no new link is accepted`;
    }
    const at = e.at;
    if (e.planId) {
      if (goal.planIds.includes(e.planId)) return 'the plan is already linked to this goal';
      goal.planIds.push(e.planId);
    }
    if (e.taskId) {
      if (goal.taskIds.includes(e.taskId)) return 'the task is already linked to this goal';
      goal.taskIds.push(e.taskId);
    }
    if (e.entityId) {
      if (goal.entityIds.includes(e.entityId)) return 'the world entity is already linked to this goal';
      goal.entityIds.push(e.entityId);
    }
    if (e.worldEventId) {
      if (goal.worldEventIds.includes(e.worldEventId)) return 'the world event is already linked to this goal';
      goal.worldEventIds.push(e.worldEventId);
    }
    goal.updatedAt = at;
    return null;
  }

  return 'unknown event type';
}

// Rebuilds goals from events in order. An event that does not apply is reported and skipped, so
// one damaged line cannot erase the rest of the history.
export function reduceEvents(events) {
  const goals = new Map();
  const problems = [];
  events.forEach((e, index) => {
    const problem = applyEvent(goals, e);
    if (problem) problems.push({ index, eventId: e?.eventId ?? null, reason: problem });
  });
  return { goals, problems };
}

export function goalSummary(goal) {
  const p = goalProgress(goal);
  return {
    id: goal.id,
    request: goal.request,
    status: goal.status,
    priority: goal.priority,
    deadline: goal.deadline,
    revision: goal.revision ?? 1,
    progress: p,
    plans: goal.planIds.length,
    tasks: goal.taskIds.length,
    entities: goal.entityIds.length,
    worldEvents: goal.worldEventIds.length,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}
