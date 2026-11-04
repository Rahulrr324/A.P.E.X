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
export function goalProgress(goal) {
  const criteria = Array.isArray(goal?.criteria) ? goal.criteria : [];
  const satisfied = criteria.filter((c) => c.status === 'satisfied').length;
  const contradicted = criteria.filter((c) => c.status === 'contradicted').length;
  return {
    satisfied,
    contradicted,
    pending: criteria.length - satisfied - contradicted,
    total: criteria.length,
  };
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
  return {
    id: c.id,
    description: c.description,
    status: 'pending',
    evidence: [],
    updatedAt: at,
  };
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
      if (!c || typeof c !== 'object') return 'bad criterion';
      if (typeof c.id !== 'string' || !CRITERION_ID_RE.test(c.id)) return 'bad criterion id';
      if (ids.has(c.id)) return 'duplicate criterion id';
      ids.add(c.id);
      if (typeof c.description !== 'string' || c.description.trim().length === 0 || c.description.length > MAX_CRITERION_CHARS) {
        return 'bad criterion description';
      }
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
      if (!c || typeof c !== 'object') return 'bad criterion';
      if (typeof c.id !== 'string' || !CRITERION_ID_RE.test(c.id)) return 'bad criterion id';
      if (ids.has(c.id)) return 'duplicate criterion id';
      ids.add(c.id);
      if (typeof c.description !== 'string' || c.description.trim().length === 0 || c.description.length > MAX_CRITERION_CHARS) {
        return 'bad criterion description';
      }
    }
    if (e.priority !== undefined && (!Number.isInteger(e.priority) || e.priority < 1 || e.priority > 5)) return 'bad priority';
    if (e.deadline !== undefined && e.deadline !== null && (typeof e.deadline !== 'string' || Number.isNaN(Date.parse(e.deadline)))) {
      return 'bad deadline';
    }
    if (typeof e.reason !== 'string' || e.reason.trim().length === 0) return 'a revision needs a reason';
    if (e.reason.length > MAX_GOAL_REASON_CHARS) return 'revision reason too long';
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
      const unsatisfied = goal.criteria.filter((c) => c.status !== 'satisfied');
      if (unsatisfied.length > 0) {
        return `goal cannot be completed: ${unsatisfied.map((c) => c.id).join(', ')} ${unsatisfied.length === 1 ? 'is' : 'are'} not satisfied`;
      }
      if (goal.criteria.some((c) => !c.evidence.some((ev) => ev.kind === 'supports'))) {
        return 'goal cannot be completed without supporting evidence for every criterion';
      }
    }
    const at = e.at;
    goal.status = e.to;
    goal.statusHistory.push({ from: e.from, to: e.to, at, reason: e.reason });
    goal.updatedAt = at;
    if (e.to === GoalStatus.BLOCKED) goal.blockedReason = e.reason;
    if (e.to === GoalStatus.ACTIVE) goal.blockedReason = null;
    if (e.to === GoalStatus.COMPLETED) {
      goal.completion = {
        at,
        criteria: goal.criteria.map((c) => ({
          criterionId: c.id,
          operationId: [...c.evidence].reverse().find((ev) => ev.kind === 'supports')?.operationId ?? null,
        })),
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
    if (e.priority !== undefined) goal.priority = e.priority;
    if (e.deadline !== undefined) goal.deadline = e.deadline;
    goal.revision = (goal.revision ?? 1) + 1;
    goal.revisionHistory.push({ revision: goal.revision, at: e.at, reason: e.reason });
    goal.completion = null;
    goal.contradiction = null;
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
