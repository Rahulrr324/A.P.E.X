// Executive plan model: the lifecycle and reducer for plans.jsonl. Pure functions only.
//
// A plan is a proposal the user approves, not permission to act. It records what is intended,
// what is assumed, what is merely inferred, what is still unknown, and which registered
// capabilities its steps would need. Every step is still authorized separately when it runs.
//
// The plan has a content hash. Approval is bound to that hash, so a revision can never inherit
// an earlier approval, and activation re-checks the hash against the plan it is activating.
// Plan completion is evidence-based: the reducer refuses `completed` until every step has a
// recorded outcome of `completed` with the operation record that verified it.
import { createHash } from 'node:crypto';
import { singleLine } from '../util.js';
import { MAX_STEPS, STEP_ID_RE, StepStatus, dependencyProblems, stableStringify } from '../tasks/model.js';

export const PLAN_SCHEMA = 1;
export const MAX_PLAN_STEPS = MAX_STEPS;
export const MAX_PLAN_OUTCOME_CHARS = 300;
export const MAX_PRECONDITIONS = 8;
export const MAX_PRECONDITION_CHARS = 200;
export const MAX_ASSERTIONS = 8;
export const MAX_ASSERTION_CHARS = 200;
export const MAX_EXPECTED_CHARS = 200;
export const MAX_VERIFICATION_CHARS = 200;
export const MAX_STEP_INPUT_CHARS = 4000;
export const MAX_ESTIMATE_SECONDS = 86400;
export const PLAN_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const CRITERION_ID_RE = /^c[1-9][0-9]?$/;

export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const RISK_ORDER = Object.freeze({ low: 0, medium: 1, high: 2 });
// The epistemic classes a plan may record. `stored_knowledge`, `retrieved_evidence`, `world_fact`
// and `world_entity` must name the record they came from; `user_fact` is the user's own statement
// as recorded here; an inference or an unknown is never presented as established fact.
export const ASSERTION_KINDS = Object.freeze([
  'user_fact', 'stored_knowledge', 'retrieved_evidence', 'world_fact', 'world_entity', 'inference', 'unknown',
]);
// Assertions that name a record whose live state can be re-checked. A world assertion may also
// carry an expected value; a change is reported against the plan, and never applied to the world.
export const WORLD_ASSERTION_KINDS = Object.freeze(['world_fact', 'world_entity']);

export const PlanStatus = Object.freeze({
  DRAFT: 'draft',
  APPROVED: 'approved',
  ACTIVE: 'active',
  BLOCKED: 'blocked',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  SUPERSEDED: 'superseded',
});

// `plan_status` events move a plan between these states. Activation is not in the table: it is
// the separate `plan_activated` event, because it must name the task it created and re-check the
// approved content hash.
export const PLAN_TRANSITIONS = Object.freeze({
  draft: ['cancelled', 'superseded'],
  approved: ['blocked', 'cancelled', 'superseded'],
  active: ['completed', 'failed', 'blocked', 'cancelled', 'superseded'],
  blocked: ['active', 'failed', 'cancelled', 'superseded'],
  completed: [],
  failed: ['cancelled', 'superseded'],
  cancelled: [],
  superseded: [],
});

export const OUTCOME_STEP_STATUSES = Object.freeze([
  StepStatus.COMPLETED, StepStatus.FAILED, StepStatus.UNCERTAIN, StepStatus.SKIPPED,
]);

export function isOpenPlan(status) {
  return status === PlanStatus.DRAFT || status === PlanStatus.APPROVED
    || status === PlanStatus.ACTIVE || status === PlanStatus.BLOCKED;
}

export function planRisk(steps) {
  let worst = 'low';
  for (const s of steps ?? []) {
    if ((RISK_ORDER[s.risk] ?? 0) > RISK_ORDER[worst]) worst = s.risk;
  }
  return worst;
}

export function planProgress(plan) {
  const results = plan.stepResults ?? {};
  const count = (status) => plan.steps.filter((s) => results[s.id]?.status === status).length;
  const completed = count(StepStatus.COMPLETED);
  return {
    completed,
    failed: count(StepStatus.FAILED),
    uncertain: count(StepStatus.UNCERTAIN),
    skipped: count(StepStatus.SKIPPED),
    pending: plan.steps.length - completed - count(StepStatus.FAILED) - count(StepStatus.UNCERTAIN) - count(StepStatus.SKIPPED),
    total: plan.steps.length,
  };
}

function assertionContent(a) {
  const content = { kind: a.kind, text: a.text, ref: a.ref ?? null };
  // Included only when recorded, so plans written before world expected values existed keep
  // exactly the bytes, and therefore the hashes, they had before.
  if (a.expected !== undefined && a.expected !== null) content.expected = a.expected;
  return content;
}

// The exact bytes approval is bound to. Status, approvals, activations, and outcomes are
// deliberately excluded: they are records about the plan, not the plan the user approved.
// The goal revision is included when one is recorded, so a plan approved against one wording
// of a goal does not silently remain approved after the goal's criteria change. Plans written
// before the field existed omit it, and their hashes replay exactly as before.
export function planContent(plan) {
  return {
    goalId: plan.goalId ?? null,
    ...(plan.goalRevision != null ? { goalRevision: plan.goalRevision } : {}),
    outcome: plan.outcome,
    steps: plan.steps.map((s) => ({
      id: s.id,
      description: s.description,
      action: s.action,
      input: s.input ?? {},
      dependsOn: [...s.dependsOn],
      expectedResult: s.expectedResult,
      verification: s.verification,
      criterionId: s.criterionId ?? null,
      risk: s.risk,
      estimate: s.estimate ?? { seconds: null },
    })),
    preconditions: [...plan.preconditions],
    assertions: plan.assertions.map(assertionContent),
    resources: { estimatedSeconds: plan.resources?.estimatedSeconds ?? null },
  };
}

export function planContentHash(plan) {
  return createHash('sha256').update(stableStringify(planContent(plan))).digest('hex');
}

// ---- content validation -----------------------------------------------------

function plainText(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function stepProblems(s, i, problems) {
  const label = `step ${i + 1}`;
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    problems.push(`${label} is not an object`);
    return;
  }
  if (typeof s.id !== 'string' || !STEP_ID_RE.test(s.id)) problems.push(`${label} has an invalid id`);
  if (!plainText(s.description, MAX_EXPECTED_CHARS)) problems.push(`${label} needs a plain description`);
  if (typeof s.action !== 'string' || !/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/.test(s.action)) {
    problems.push(`${label} needs an action name`);
  }
  if (s.input !== undefined && s.input !== null && (typeof s.input !== 'object' || Array.isArray(s.input))) {
    problems.push(`${label} input must be an object`);
  } else {
    const size = JSON.stringify(s.input ?? {}).length;
    if (size > MAX_STEP_INPUT_CHARS) problems.push(`${label} input exceeds ${MAX_STEP_INPUT_CHARS} characters`);
  }
  if (!Array.isArray(s.dependsOn)) problems.push(`${label} dependencies must be a list`);
  if (!plainText(s.expectedResult, MAX_EXPECTED_CHARS)) problems.push(`${label} needs a stated expected result`);
  if (!plainText(s.verification, MAX_VERIFICATION_CHARS)) problems.push(`${label} needs a stated verification requirement`);
  if (s.criterionId !== undefined && s.criterionId !== null && (typeof s.criterionId !== 'string' || !CRITERION_ID_RE.test(s.criterionId))) {
    problems.push(`${label} criterion must be an id such as c1`);
  }
  if (!RISK_LEVELS.includes(s.risk)) problems.push(`${label} risk must be low, medium, or high`);
  if (s.estimate !== undefined && s.estimate !== null) {
    if (typeof s.estimate !== 'object' || Array.isArray(s.estimate)) {
      problems.push(`${label} estimate must be an object`);
    } else {
      const seconds = s.estimate.seconds;
      if (seconds !== undefined && seconds !== null && (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_ESTIMATE_SECONDS)) {
        problems.push(`${label} estimate.seconds must be an integer from 0 to ${MAX_ESTIMATE_SECONDS}`);
      }
    }
  }
}

function assertionProblems(a, i, problems) {
  const label = `assertion ${i + 1}`;
  if (!a || typeof a !== 'object' || Array.isArray(a)) {
    problems.push(`${label} is not an object`);
    return;
  }
  if (!ASSERTION_KINDS.includes(a.kind)) problems.push(`${label} kind must be one of: ${ASSERTION_KINDS.join(', ')}`);
  if (!plainText(a.text, MAX_ASSERTION_CHARS)) problems.push(`${label} needs plain text`);
  const needsRef = a.kind === 'stored_knowledge' || a.kind === 'retrieved_evidence'
    || WORLD_ASSERTION_KINDS.includes(a.kind);
  if (needsRef && !plainText(a.ref, 64)) problems.push(`${label} of kind ${a.kind} must name the record it came from`);
  if (!needsRef && a.ref !== undefined && a.ref !== null && !plainText(a.ref, 64)) problems.push(`${label} reference is malformed`);
  // Only a world assertion has a live value to compare against; on any other kind an expected
  // value would claim a check this plan cannot perform.
  if (a.expected !== undefined && a.expected !== null) {
    if (!WORLD_ASSERTION_KINDS.includes(a.kind)) problems.push(`${label} of kind ${a.kind} cannot carry an expected value`);
    else if (!plainText(a.expected, MAX_ASSERTION_CHARS)) problems.push(`${label} expected value must be plain text of at most ${MAX_ASSERTION_CHARS} characters`);
  }
}

export function validatePlanContent(content) {
  const problems = [];
  if (!content || typeof content !== 'object' || Array.isArray(content)) return ['the plan content is not an object'];
  if (!plainText(content.outcome, MAX_PLAN_OUTCOME_CHARS)) problems.push(`the intended outcome must be 1 to ${MAX_PLAN_OUTCOME_CHARS} plain characters`);
  if (!Array.isArray(content.steps) || content.steps.length === 0) problems.push('a plan needs at least one step');
  else {
    if (content.steps.length > MAX_PLAN_STEPS) problems.push(`a plan may have at most ${MAX_PLAN_STEPS} steps`);
    content.steps.forEach((s, i) => stepProblems(s, i, problems));
    if (content.steps.every((s) => s && typeof s === 'object' && typeof s.id === 'string')) {
      problems.push(...dependencyProblems(content.steps).filter((p) => !p.startsWith('a plan may have')));
    }
  }
  if (!Array.isArray(content.preconditions)) problems.push('preconditions must be a list');
  else {
    if (content.preconditions.length > MAX_PRECONDITIONS) problems.push(`at most ${MAX_PRECONDITIONS} preconditions are allowed`);
    content.preconditions.forEach((p, i) => {
      if (!plainText(p, MAX_PRECONDITION_CHARS)) problems.push(`precondition ${i + 1} must be plain text of at most ${MAX_PRECONDITION_CHARS} characters`);
    });
  }
  if (!Array.isArray(content.assertions)) problems.push('assertions must be a list');
  else {
    if (content.assertions.length > MAX_ASSERTIONS) problems.push(`at most ${MAX_ASSERTIONS} assertions are allowed`);
    content.assertions.forEach((a, i) => assertionProblems(a, i, problems));
  }
  if (content.resources !== undefined && content.resources !== null) {
    if (typeof content.resources !== 'object' || Array.isArray(content.resources)) {
      problems.push('resources must be an object');
    } else {
      const seconds = content.resources.estimatedSeconds;
      if (seconds !== undefined && seconds !== null && (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_ESTIMATE_SECONDS)) {
        problems.push(`resources.estimatedSeconds must be an integer from 0 to ${MAX_ESTIMATE_SECONDS}`);
      }
    }
  }
  return problems;
}

function contentOf(e) {
  return {
    outcome: e.outcome,
    steps: e.steps,
    preconditions: e.preconditions,
    assertions: e.assertions,
    resources: e.resources ?? { estimatedSeconds: null },
  };
}

// ---- event shapes -----------------------------------------------------------

export function validateEventShape(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'not an object';
  if (e.schema !== PLAN_SCHEMA) return 'unsupported schema';
  if (typeof e.eventId !== 'string' || e.eventId.length === 0) return 'missing event id';
  if (typeof e.planId !== 'string' || !PLAN_ID_RE.test(e.planId)) return 'missing plan id';
  if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) return 'bad timestamp';

  if (e.type === 'plan_created') {
    if (e.origin !== 'user') return 'unknown origin';
    if (e.goalId !== null && (typeof e.goalId !== 'string' || !PLAN_ID_RE.test(e.goalId))) return 'bad goal reference';
    if (e.goalRevision !== undefined && (!Number.isInteger(e.goalRevision) || e.goalRevision < 1)) return 'bad goal revision';
    if (e.version !== 1) return 'a new plan starts at version 1';
    if (typeof e.reason !== 'string') return 'missing reason';
    const problems = validatePlanContent(contentOf(e));
    return problems.length > 0 ? problems[0] : null;
  }

  if (e.type === 'plan_revised') {
    if (e.version !== undefined && !Number.isInteger(e.version)) return 'bad version';
    if (e.goalRevision !== undefined && (!Number.isInteger(e.goalRevision) || e.goalRevision < 1)) return 'bad goal revision';
    if (typeof e.reason !== 'string' || e.reason.trim().length === 0) return 'a revision needs a reason';
    const problems = validatePlanContent(contentOf(e));
    return problems.length > 0 ? problems[0] : null;
  }

  if (e.type === 'plan_approved') {
    if (!Number.isInteger(e.version) || typeof e.contentHash !== 'string' || e.contentHash.length !== 64) return 'bad approval record';
    if (!e.validation || typeof e.validation !== 'object' || typeof e.validation.ok !== 'boolean') return 'bad validation record';
    return null;
  }

  if (e.type === 'plan_activated') {
    if (!Number.isInteger(e.version)) return 'bad version';
    if (typeof e.taskId !== 'string' || e.taskId.length === 0 || e.taskId.length > 64) return 'bad task reference';
    if (typeof e.contentHash !== 'string' || e.contentHash.length !== 64) return 'bad content hash';
    return null;
  }

  if (e.type === 'plan_status') {
    if (typeof e.from !== 'string' || typeof e.to !== 'string') return 'missing transition states';
    if (typeof e.reason !== 'string') return 'missing reason';
    if (e.by !== undefined && e.by !== null && (typeof e.by !== 'string' || !PLAN_ID_RE.test(e.by))) return 'bad replacement plan';
    return null;
  }

  if (e.type === 'plan_outcome') {
    if (typeof e.taskId !== 'string' || e.taskId.length === 0 || e.taskId.length > 64) return 'bad task reference';
    if (!Array.isArray(e.steps) || e.steps.length === 0) return 'an outcome needs step results';
    if (e.steps.length > MAX_PLAN_STEPS) return 'too many step results';
    for (const s of e.steps) {
      if (!s || typeof s.stepId !== 'string' || !STEP_ID_RE.test(s.stepId)) return 'bad outcome step id';
      if (!OUTCOME_STEP_STATUSES.includes(s.status)) return 'bad outcome step status';
      if (s.status === StepStatus.COMPLETED && (typeof s.operationId !== 'string' || s.operationId.length === 0)) {
        return 'a completed step outcome must name its operation record';
      }
      if (s.operationId !== undefined && s.operationId !== null && (typeof s.operationId !== 'string' || s.operationId.length > 64)) {
        return 'bad outcome operation reference';
      }
      if (s.detail !== undefined && s.detail !== null && (typeof s.detail !== 'string' || s.detail.length > MAX_PLAN_OUTCOME_CHARS)) {
        return 'bad outcome detail';
      }
    }
    return null;
  }

  return 'unknown event type';
}

// ---- reducer ----------------------------------------------------------------

function newPlan(e) {
  return {
    id: e.planId,
    goalId: e.goalId ?? null,
    goalRevision: e.goalRevision ?? null,
    origin: 'user',
    version: 1,
    status: PlanStatus.DRAFT,
    outcome: e.outcome,
    steps: e.steps.map((s) => ({
      id: s.id,
      description: s.description,
      action: s.action,
      input: s.input ?? {},
      dependsOn: [...s.dependsOn],
      expectedResult: s.expectedResult,
      verification: s.verification,
      criterionId: s.criterionId ?? null,
      risk: s.risk,
      estimate: { seconds: s.estimate?.seconds ?? null },
    })),
    preconditions: [...e.preconditions],
    assertions: e.assertions.map(assertionContent),
    resources: { estimatedSeconds: e.resources?.estimatedSeconds ?? null },
    history: [{ version: 1, kind: 'created', at: e.at, reason: e.reason }],
    approval: null,
    activation: null,
    validation: null,
    stepResults: {},
    blockedReason: null,
    failureReason: null,
    cancelledReason: null,
    supersededBy: null,
    createdAt: e.at,
    updatedAt: e.at,
  };
}

function applyContent(plan, e) {
  plan.goalRevision = e.goalRevision ?? null;
  plan.outcome = e.outcome;
  plan.steps = e.steps.map((s) => ({
    id: s.id,
    description: s.description,
    action: s.action,
    input: s.input ?? {},
    dependsOn: [...s.dependsOn],
    expectedResult: s.expectedResult,
    verification: s.verification,
    criterionId: s.criterionId ?? null,
    risk: s.risk,
    estimate: { seconds: s.estimate?.seconds ?? null },
  }));
  plan.preconditions = [...e.preconditions];
  plan.assertions = e.assertions.map(assertionContent);
  plan.resources = { estimatedSeconds: e.resources?.estimatedSeconds ?? null };
}

export function applyEvent(plans, e) {
  const shape = validateEventShape(e);
  if (shape) return shape;

  if (e.type === 'plan_created') {
    if (plans.has(e.planId)) return 'plan id already exists';
    if (e.goalId !== null) {
      const linked = [...plans.values()].filter((p) => p.goalId === e.goalId && isOpenPlan(p.status));
      if (linked.length > 0) return `goal ${singleLine(e.goalId, 40)} already has an open plan (${singleLine(linked[0].id, 40)})`;
    }
    plans.set(e.planId, newPlan(e));
    return null;
  }

  const plan = plans.get(e.planId);
  if (!plan) return 'unknown plan';

  if (e.type === 'plan_revised') {
    if (plan.status !== PlanStatus.DRAFT && plan.status !== PlanStatus.BLOCKED) {
      return `plan is ${plan.status}; a revision is accepted only for a draft or blocked plan`;
    }
    if (e.version !== plan.version + 1) return `revision version must be ${plan.version + 1}`;
    applyContent(plan, e);
    plan.version = e.version;
    plan.status = PlanStatus.DRAFT;
    plan.approval = null;
    plan.activation = null;
    plan.validation = null;
    plan.blockedReason = null;
    plan.failureReason = null;
    plan.stepResults = {};
    plan.history.push({ version: e.version, kind: 'revised', at: e.at, reason: e.reason });
    plan.updatedAt = e.at;
    return null;
  }

  if (e.type === 'plan_approved') {
    if (plan.status !== PlanStatus.DRAFT) return `plan is ${plan.status}; only a draft can be approved`;
    if (e.version !== plan.version) return `approval names version ${e.version}, but the plan is version ${plan.version}`;
    if (e.contentHash !== planContentHash(plan)) return 'approval does not match the current plan content';
    plan.status = PlanStatus.APPROVED;
    plan.approval = { at: e.at, version: e.version, contentHash: e.contentHash, validation: e.validation };
    plan.validation = e.validation;
    plan.history.push({ version: e.version, kind: 'approved', at: e.at, reason: 'approved by the user' });
    plan.updatedAt = e.at;
    return null;
  }

  if (e.type === 'plan_activated') {
    if (plan.status !== PlanStatus.APPROVED) return `plan is ${plan.status}; only an approved plan can be activated`;
    if (!plan.approval) return 'the plan has no recorded approval';
    if (e.version !== plan.version) return `activation names version ${e.version}, but the plan is version ${plan.version}`;
    if (e.contentHash !== planContentHash(plan)) return 'activation does not match the current plan content';
    plan.status = PlanStatus.ACTIVE;
    plan.activation = { at: e.at, taskId: e.taskId, version: e.version, contentHash: e.contentHash };
    plan.history.push({ version: e.version, kind: 'activated', at: e.at, reason: `task ${singleLine(e.taskId, 40)} created` });
    plan.updatedAt = e.at;
    return null;
  }

  if (e.type === 'plan_outcome') {
    if (plan.status !== PlanStatus.ACTIVE && plan.status !== PlanStatus.BLOCKED) {
      return `plan is ${plan.status}; step outcomes are accepted only for an active or blocked plan`;
    }
    if (!plan.activation) return 'the plan has no recorded activation';
    if (e.taskId !== plan.activation.taskId) return 'the outcomes name a task that did not activate this plan';
    const ids = new Set(plan.steps.map((s) => s.id));
    for (const s of e.steps) {
      if (!ids.has(s.stepId)) return `unknown plan step ${singleLine(s.stepId, 40)}`;
      const prior = plan.stepResults[s.stepId];
      if (prior && prior.status !== StepStatus.UNCERTAIN && prior.status !== StepStatus.FAILED) {
        return `step ${singleLine(s.stepId, 40)} already has a final recorded outcome (${prior.status})`;
      }
      if (prior && prior.status === StepStatus.FAILED && s.status === StepStatus.COMPLETED) {
        return `step ${singleLine(s.stepId, 40)} failed earlier; a later completion needs a new plan revision`;
      }
    }
    for (const s of e.steps) {
      plan.stepResults[s.stepId] = {
        status: s.status,
        operationId: s.operationId ?? null,
        detail: s.detail ?? null,
        taskId: e.taskId,
        at: e.at,
      };
    }
    plan.history.push({ version: plan.version, kind: 'outcome', at: e.at, reason: `${e.steps.length} step outcome(s) recorded` });
    plan.updatedAt = e.at;
    return null;
  }

  if (e.type === 'plan_status') {
    if (plan.status !== e.from) return `plan is ${plan.status}, event expected ${e.from}`;
    if (!PLAN_TRANSITIONS[e.from]?.includes(e.to)) return `illegal plan transition ${e.from} -> ${e.to}`;
    if (['blocked', 'failed', 'cancelled', 'superseded'].includes(e.to) && e.reason.trim().length === 0) {
      return `a ${e.to} plan needs a recorded reason`;
    }
    if (e.to === PlanStatus.SUPERSEDED) {
      if (!e.by) return 'a superseded plan must name the plan that replaces it';
      const replacement = plans.get(e.by);
      if (!replacement) return `unknown replacement plan ${singleLine(e.by, 40)}`;
      if (replacement.id === plan.id) return 'a plan cannot supersede itself';
      if (replacement.status === PlanStatus.SUPERSEDED) return 'the replacement plan is itself superseded';
    }
    if (e.to === PlanStatus.COMPLETED) {
      const missing = plan.steps.filter((s) => plan.stepResults[s.id]?.status !== StepStatus.COMPLETED);
      if (missing.length > 0) {
        return `plan cannot be completed: ${missing.map((s) => s.id).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no completed, verified outcome`;
      }
    }
    plan.status = e.to;
    plan.updatedAt = e.at;
    if (e.to === PlanStatus.BLOCKED) plan.blockedReason = e.reason;
    if (e.to === PlanStatus.ACTIVE) { plan.blockedReason = null; plan.failureReason = null; }
    if (e.to === PlanStatus.FAILED) plan.failureReason = e.reason;
    if (e.to === PlanStatus.CANCELLED) plan.cancelledReason = e.reason;
    if (e.to === PlanStatus.SUPERSEDED) plan.supersededBy = e.by ?? null;
    plan.history.push({ version: plan.version, kind: `status:${e.to}`, at: e.at, reason: e.reason });
    return null;
  }

  return 'unknown event type';
}

export function reduceEvents(events) {
  const plans = new Map();
  const problems = [];
  events.forEach((e, index) => {
    const problem = applyEvent(plans, e);
    if (problem) problems.push({ index, eventId: e?.eventId ?? null, reason: problem });
  });
  return { plans, problems };
}

export function planSummary(plan) {
  return {
    id: plan.id,
    goalId: plan.goalId,
    goalRevision: plan.goalRevision ?? null,
    version: plan.version,
    status: plan.status,
    outcome: plan.outcome,
    risk: planRisk(plan.steps),
    steps: plan.steps.length,
    progress: planProgress(plan),
    taskId: plan.activation?.taskId ?? null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}
