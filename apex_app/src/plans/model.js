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
export const MAX_RECOVERY_CHARS = 200;
// How many candidate drafts one goal may hold at once, and how many of its plans may be live at
// once. Drafts are alternatives the user has not approved, so several are useful and a bound keeps
// the comparison readable. A live plan is one the user has authorized: approving a second plan for
// the same goal while one is authorized would put two intentions in charge of it, so the store
// allows one and the transition has to be made explicitly (supersede, then approve).
export const MAX_CANDIDATES_PER_GOAL = 3;
export const MAX_LIVE_PLANS_PER_GOAL = 1;
// How far an outcome assessment may go: the seven questions it answers, the six verdicts it may
// reach, and the bounds on what one assessment may cite. The six verdicts are deliberately not a
// probability, a score, or a percentage - they are the states APEX can distinguish honestly.
export const MAX_FINDINGS = 7;
export const MAX_ASSESSMENT_SUMMARY_CHARS = 300;
export const MAX_CITED_IDS = 8;
export const PLAN_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const CRITERION_ID_RE = /^c[1-9][0-9]?$/;

export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const RISK_ORDER = Object.freeze({ low: 0, medium: 1, high: 2 });
// What a step does to the records or the world, as far as the registry's own permission class can
// say. `unknown` is available because a step may be reversible for a reason the registry does not
// model, and guessing would be false precision.
export const REVERSIBILITY_LEVELS = Object.freeze(['read_only', 'reversible', 'not_reversible', 'unknown']);
// The epistemic classes a plan may record. `stored_knowledge`, `retrieved_evidence`, `world_fact`
// and `world_entity` must name the record they came from; `user_fact` is the user's own statement
// as recorded here; an inference or an unknown is never presented as established fact.
export const ASSERTION_KINDS = Object.freeze([
  'user_fact', 'stored_knowledge', 'retrieved_evidence', 'world_fact', 'world_entity', 'inference', 'unknown',
]);
// Assertions that name a record whose live state can be re-checked. A world assertion may also
// carry an expected value; a change is reported against the plan, and never applied to the world.
export const WORLD_ASSERTION_KINDS = Object.freeze(['world_fact', 'world_entity']);

// The seven questions an outcome assessment answers. They are the separation the milestone asks
// for: that a step ran is not that its expected output exists, which is not that its verification
// condition was satisfied, which is not that the goal's criterion is met.
export const ASSESSMENT_ASPECTS = Object.freeze([
  'step_completion',
  'expected_output',
  'verification',
  'goal_criteria',
  'evidence_state',
  'durability',
  'external_confirmation',
]);

// The verdicts an assessment may reach about what a plan achieved. `awaiting_confirmation` is not a
// failure: it is APEX reporting that the settling evidence lies outside its records. No verdict here
// is a probability, a score, or a percentage.
export const ASSESSMENT_VERDICTS = Object.freeze([
  'successful',
  'partial',
  'failed',
  'blocked',
  'uncertain',
  'awaiting_confirmation',
]);

// A verdict may only be recorded with the question that bears on it answered: `successful` claims
// the goal's criteria were met, and `awaiting_confirmation` claims something is still outside
// APEX's records. Without the rule, either verdict is a word with no finding behind it.
export const VERDICT_REQUIRED_ASPECT = Object.freeze({
  successful: 'goal_criteria',
  awaiting_confirmation: 'external_confirmation',
});

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

// Approved, running, or blocked while running: a plan the user has authorized. A blocked plan still
// holds the slot because the user can put it back into action, so a second authorized plan for the
// same goal would mean two live intentions. Drafts are not live - they authorize nothing.
export function isLivePlan(status) {
  return status === PlanStatus.APPROVED || status === PlanStatus.ACTIVE || status === PlanStatus.BLOCKED;
}

// The plans one goal holds, split the way the store's bounds are stated. Used by the reducer, the
// store's reads, and the candidate presentation, so no two of them count differently.
export function plansForGoal(plans, goalId) {
  const forGoal = [...plans.values()].filter((p) => p.goalId === goalId);
  return {
    all: forGoal,
    drafts: forGoal.filter((p) => p.status === PlanStatus.DRAFT),
    live: forGoal.filter((p) => isLivePlan(p.status)),
  };
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

// A step as the plan holds it. The two fields added for candidate planning - how far the step can
// be undone, and what to do if it fails - are present only when recorded, so a plan written before
// them hashes exactly as it did. `stableStringify` sorts keys, so this one mapping serves both the
// stored record and the bytes approval is bound to.
function stepRecord(s) {
  return {
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
    ...(s.reversibility !== undefined && s.reversibility !== null ? { reversibility: s.reversibility } : {}),
    ...(s.recovery !== undefined && s.recovery !== null ? { recovery: s.recovery } : {}),
  };
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
    steps: plan.steps.map(stepRecord),
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
  if (s.reversibility !== undefined && s.reversibility !== null && !REVERSIBILITY_LEVELS.includes(s.reversibility)) {
    problems.push(`${label} reversibility must be one of: ${REVERSIBILITY_LEVELS.join(', ')}`);
  }
  if (s.recovery !== undefined && s.recovery !== null && !plainText(s.recovery, MAX_RECOVERY_CHARS)) {
    problems.push(`${label} recovery must be plain text of at most ${MAX_RECOVERY_CHARS} characters`);
  }
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

// An outcome assessment cites the records it looked at. `operations` names audit records, which is
// what makes a finding evidence rather than an assertion: a finding that cites nothing is refused.
function citedIdsProblems(value, name, problems, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) problems.push(`${name} cites no operation, so its finding has no evidence behind it`);
    return;
  }
  if (!Array.isArray(value)) {
    problems.push(`${name} must be a list of record ids`);
    return;
  }
  if (required && value.length === 0) {
    problems.push(`${name} cites no operation, so its finding has no evidence behind it`);
  }
  if (value.length > MAX_CITED_IDS) problems.push(`${name} may cite at most ${MAX_CITED_IDS} ids`);
  for (const id of value) {
    if (typeof id !== 'string' || id.trim().length === 0 || id.length > 64 || /[\u0000-\u001f\u007f]/.test(id)) {
      problems.push(`${name} cites something that is not a plain record id`);
    }
  }
}

// The shape of one recorded outcome assessment. Which questions were answered is checked here;
// whether the answers are supported by the records they cite is checked when it is written, because
// that needs the audit log and this module is pure.
export function assessmentProblems(e) {
  const problems = [];
  if (e.origin !== 'user') problems.push('unknown origin');
  if (!Number.isInteger(e.planVersion) || e.planVersion < 1) problems.push('an assessment must name the plan version it assessed');
  if (typeof e.contentHash !== 'string' || e.contentHash.length !== 64) problems.push('an assessment must name the plan content it assessed');
  if (!ASSESSMENT_VERDICTS.includes(e.verdict)) problems.push(`verdict must be one of: ${ASSESSMENT_VERDICTS.join(', ')}`);
  if (!plainText(e.summary, MAX_ASSESSMENT_SUMMARY_CHARS)) {
    problems.push(`an assessment needs a plain summary of 1 to ${MAX_ASSESSMENT_SUMMARY_CHARS} characters`);
  }
  if (!Array.isArray(e.findings) || e.findings.length === 0) return problems.length > 0 ? problems : ['an assessment needs at least one finding'];
  if (e.findings.length > MAX_FINDINGS) problems.push(`an assessment may answer at most ${MAX_FINDINGS} question(s)`);
  const answered = new Set();
  e.findings.forEach((f, i) => {
    const label = `finding ${i + 1}`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      problems.push(`${label} is not an object`);
      return;
    }
    if (!ASSESSMENT_ASPECTS.includes(f.aspect)) problems.push(`${label} aspect must be one of: ${ASSESSMENT_ASPECTS.join(', ')}`);
    else if (answered.has(f.aspect)) problems.push(`${label} answers ${f.aspect} twice; an assessment answers each question once`);
    else answered.add(f.aspect);
    if (!plainText(f.statement, MAX_ASSERTION_CHARS)) problems.push(`${label} needs a plain statement of what was found`);
    citedIdsProblems(f.operations, `${label} operations`, problems, { required: true });
    citedIdsProblems(f.records, `${label} records`, problems);
  });
  const required = VERDICT_REQUIRED_ASPECT[e.verdict];
  if (required && !answered.has(required)) {
    problems.push(`a ${e.verdict} assessment must answer ${required}, because that is what the verdict claims`);
  }
  return problems;
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

  if (e.type === 'plan_assessment') {
    const problems = assessmentProblems(e);
    return problems.length > 0 ? problems[0] : null;
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
    steps: e.steps.map(stepRecord),
    preconditions: [...e.preconditions],
    assertions: e.assertions.map(assertionContent),
    resources: { estimatedSeconds: e.resources?.estimatedSeconds ?? null },
    history: [{ version: 1, kind: 'created', at: e.at, reason: e.reason }],
    approval: null,
    activation: null,
    validation: null,
    stepResults: {},
    assessments: [],
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
  plan.steps = e.steps.map(stepRecord);
  plan.preconditions = [...e.preconditions];
  plan.assertions = e.assertions.map(assertionContent);
  plan.resources = { estimatedSeconds: e.resources?.estimatedSeconds ?? null };
}

// The live-plan bound, stated once and applied both where the user authorizes a plan and where it
// is put into action. Checking it again at activation matters for a log that was not written by
// this store: replay applies the same rule, so an already-approved pair cannot be started either.
function livePlanProblem(plans, plan) {
  if (plan.goalId === null) return null;
  const other = plansForGoal(plans, plan.goalId).live.filter((p) => p.id !== plan.id);
  if (other.length < MAX_LIVE_PLANS_PER_GOAL) return null;
  return `goal ${singleLine(plan.goalId, 40)} already has a live plan (${other.map((p) => `${singleLine(p.id, 40)} is ${p.status}`).join(', ')}); supersede or cancel it before authorizing another`;
}

// One recorded outcome assessment, as the plan holds it. It cites the audit operations behind each
// finding; the cited records themselves stay in the audit log, so nothing is copied here.
function assessmentEntry(e) {
  return {
    at: e.at,
    verdict: e.verdict,
    summary: e.summary,
    planVersion: e.planVersion,
    contentHash: e.contentHash,
    findings: e.findings.map((f) => ({
      aspect: f.aspect,
      statement: f.statement,
      operations: [...f.operations],
      records: [...(f.records ?? [])],
    })),
  };
}

export function applyEvent(plans, e) {
  const shape = validateEventShape(e);
  if (shape) return shape;

  if (e.type === 'plan_created') {
    if (plans.has(e.planId)) return 'plan id already exists';
    if (e.goalId !== null) {
      // Comparing approaches needs several drafts for one goal, so drafts are bounded rather than
      // forbidden. A goal may hold at most MAX_CANDIDATES_PER_GOAL of them at once; the bound is on
      // the record, not on a caller that read the count first, so a hand-written log replays the
      // same rule. Approval is where the other bound applies: one live plan per goal.
      const { drafts } = plansForGoal(plans, e.goalId);
      if (drafts.length >= MAX_CANDIDATES_PER_GOAL) {
        return `goal ${singleLine(e.goalId, 40)} already holds ${MAX_CANDIDATES_PER_GOAL} candidate drafts (${drafts.map((p) => singleLine(p.id, 40)).join(', ')}); approve, cancel, or supersede one before recording another`;
      }
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
    // The live-plan bound is checked here, at the moment the user authorizes a plan, rather than
    // when a draft is recorded: recording three approaches authorizes nothing, while authorizing a
    // second one while another is authorized would give one goal two live intentions.
    const alreadyLive = livePlanProblem(plans, plan);
    if (alreadyLive) return alreadyLive;
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
    const alreadyLive = livePlanProblem(plans, plan);
    if (alreadyLive) return alreadyLive;
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

  if (e.type === 'plan_assessment') {
    // An assessment is a record *about* the plan, not part of it: it is absent from `planContent`,
    // so recording one cannot change what the user approved or invalidate an approval. It is bound
    // to the version and the bytes it assessed, which is what lets a reader see that an older
    // conclusion no longer describes the plan after a revision.
    if (!plan.activation) return 'the plan has no recorded activation, so there is no execution outcome to assess';
    if (e.planVersion !== plan.version) {
      return `the assessment names version ${e.planVersion}, but the plan is version ${plan.version}; an assessment describes the plan as it was then`;
    }
    if (e.contentHash !== planContentHash(plan)) return 'the assessment does not match the current plan content';
    const entry = assessmentEntry(e);
    const prior = (plan.assessments ?? []).find((a) => a.planVersion === entry.planVersion && a.verdict === entry.verdict && a.summary === entry.summary);
    if (prior) return `that assessment of version ${entry.planVersion} is already recorded at ${prior.at}`;
    plan.assessments = [...(plan.assessments ?? []), entry];
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
