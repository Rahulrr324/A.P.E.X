// Outcome evaluation: what a run set out to do, what it actually did, and what the records say about
// whether the objective was met.
//
// The rule this module implements is narrow enough to state in one sentence:
//
//   a run is classified from the plan's recorded step outcomes, the goal's recorded criteria, and the
//   operations the plan store required for each completed step. A step runner's own success is never
//   sufficient for `achieved`; when the objective's criteria are not recorded as met the answer is
//   `partially_achieved`, and when no execution was recorded the answer is `indeterminate`.
//
// Nothing here reads the clock, the model, or the network. The builder is pure; the action layer
// performs the store reads and hands the records in, and the store re-derives the classification from
// the stored counts before accepting a line, so a hand-edited record cannot claim an outcome its own
// step counts do not state.
import { sha256Hex } from '../memory/memory-store.js';
import { stableStringify } from '../tasks/model.js';
import { singleLine } from '../util.js';
import {
  CAPABILITY_OUTCOMES,
  CLASSIFICATIONS,
  CONFIDENCES,
  CRITERION_STATES,
  EVALUATION_KIND,
  MAX_CAPABILITIES,
  MAX_CRITERIA,
  MAX_EVIDENCE_REFS,
  MAX_LIMITATIONS,
  MAX_LIMITATION_CHARS,
  MAX_OBJECTIVE_CHARS,
} from './vocabulary.js';

const CRITERION_ID_RE = /^c[1-9][0-9]?$/;
const CAPABILITY_RE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;

// The statuses a plan store writes for one step outcome.
const PLAN_STEP_STATUSES = new Set(['completed', 'failed', 'uncertain', 'skipped']);
// The statuses a task store may hold for one step. A task step that never reached an outcome is
// `notRun` in the evaluation, which is different from a deliberate skip.
const TASK_STEP_STATUSES = new Set([
  'completed', 'failed', 'uncertain', 'skipped', 'interrupted', 'running', 'pending', 'approved', 'blocked',
]);

export function normalizeObjective(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// A stable identifier for "the objective this run pursued", so two runs of the same intention can be
// compared and two different intentions cannot be pooled. It hashes the normalised objective text,
// never anything the user did not write.
export function objectiveKeyOf(objective) {
  const normalized = normalizeObjective(objective);
  if (normalized.length === 0) return null;
  return sha256Hex(normalized).slice(0, 16);
}

// The step outcomes as the two stores recorded them. The plan store is authoritative: it refuses a
// completed step without a verified operation. The task is consulted only for steps the plan store
// has no outcome for, which is what an interruption leaves behind.
export function stepCounts({ plan, task = null }) {
  const results = plan?.stepResults ?? {};
  const taskSteps = new Map((task?.steps ?? []).map((s) => [s.id, s]));
  const counts = {
    total: Array.isArray(plan?.steps) ? plan.steps.length : 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    uncertain: 0,
    notRun: 0,
  };
  const perStep = [];
  for (const step of plan?.steps ?? []) {
    const recorded = results[step.id];
    let status = null;
    if (recorded && PLAN_STEP_STATUSES.has(recorded.status)) status = recorded.status;
    else {
      const taskStep = taskSteps.get(step.id);
      if (taskStep && TASK_STEP_STATUSES.has(taskStep.status)) status = taskStep.status;
    }
    const bucket = status === 'completed' ? 'completed'
      : status === 'failed' ? 'failed'
        : status === 'skipped' ? 'skipped'
          : status === 'uncertain' ? 'uncertain'
            : 'notRun';
    counts[bucket] += 1;
    perStep.push({
      id: step.id,
      capability: typeof step.action === 'string' ? step.action : null,
      status: bucket,
      operationId: recorded?.operationId ?? null,
    });
  }
  return { counts, perStep };
}

// One capability's own record inside the run. Capability-level success is about whether its own steps
// completed, not about the run's overall classification: a run can fail at a later step while a
// capability's own work succeeded, and the pattern analysis needs that distinction.
export function capabilityOutcomes(perStep) {
  const byCapability = new Map();
  for (const step of perStep) {
    if (!step.capability) continue;
    const bucket = byCapability.get(step.capability) ?? {
      capability: step.capability, steps: 0, completed: 0, failed: 0, skipped: 0, uncertain: 0, notRun: 0,
    };
    bucket.steps += 1;
    bucket[step.status] += 1;
    byCapability.set(step.capability, bucket);
  }
  return [...byCapability.values()]
    .sort((a, b) => (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0))
    .slice(0, MAX_CAPABILITIES)
    .map((row) => ({
      ...row,
      outcome: row.completed === row.steps ? 'success'
        : row.failed > 0 ? 'failure'
          : row.completed > 0 ? 'partial'
            : 'not_run',
    }));
}

// The order the run's steps name their capabilities, first appearance only. It is kept because an
// ordering pattern is about position, and the sorted capability list above deliberately discards it.
export function capabilitySequence(perStep) {
  const seen = [];
  for (const step of perStep) {
    if (!step.capability || !CAPABILITY_RE.test(step.capability)) continue;
    if (!seen.includes(step.capability)) seen.push(step.capability);
  }
  return seen.slice(0, MAX_CAPABILITIES);
}

// The goal's criteria, reduced to what the goal store actually recorded. `gating` is false only for a
// criterion the user declined; a suggestion the user never decided gates nothing.
export function criteriaStates(goal) {
  const criteria = Array.isArray(goal?.criteria) ? goal.criteria : [];
  return criteria.slice(0, MAX_CRITERIA).map((criterion, index) => ({
    id: CRITERION_ID_RE.test(String(criterion.id)) ? criterion.id : `c${index + 1}`,
    state: criterion.status === 'satisfied' ? 'met'
      : criterion.status === 'contradicted' ? 'not_met'
        : 'unverified',
    gating: criterion.requirement !== 'declined',
  }));
}

// The classification, re-derived from the stored counts. Both the builder and the validator call this,
// so a record whose header disagrees with its own counts is refused.
export function classifyOutcome({ activated, planStatus, steps, criteria }) {
  if (!activated) return 'indeterminate';
  if (!steps || !Number.isInteger(steps.total)) return 'indeterminate';
  const recorded = steps.completed + steps.failed + steps.skipped + steps.uncertain;
  if (recorded === 0) return 'indeterminate';
  if (steps.completed === 0) return 'not_achieved';
  const gating = (criteria ?? []).filter((c) => c.gating !== false);
  const allMet = gating.every((c) => c.state === 'met');
  const contradicted = gating.some((c) => c.state === 'not_met');
  if (contradicted && steps.completed < steps.total) return 'not_achieved';
  // Execution complete is not objective met: the plan must itself be recorded complete, every step
  // must have a completed outcome, and every gating criterion must be recorded as met.
  if (planStatus === 'completed'
    && steps.completed === steps.total
    && steps.failed === 0
    && steps.skipped === 0
    && steps.uncertain === 0
    && steps.notRun === 0
    && allMet) return 'achieved';
  return 'partially_achieved';
}

export function confidenceOf({ activated, steps, criteria, operationIds, planStatus }) {
  if (!activated) return 'low';
  const total = steps.total;
  const recorded = steps.completed + steps.failed + steps.skipped + steps.uncertain;
  const full = total > 0 && recorded === total;
  const gating = (criteria ?? []).filter((c) => c.gating !== false);
  if (operationIds.length >= 2 && full && gating.length > 0 && gating.every((c) => c.state !== 'unverified')) {
    return 'high';
  }
  if (operationIds.length >= 1 && full) return 'moderate';
  if (planStatus === 'completed' && full) return 'moderate';
  return 'low';
}

function limitationsFor({
  activated, planStatus, steps, criteria, operationIds, goal, truncatedCapabilities, predictionsConsidered,
}) {
  const out = [];
  const push = (text) => {
    if (out.length < MAX_LIMITATIONS) out.push(singleLine(text, MAX_LIMITATION_CHARS));
  };
  if (!activated) push('the plan has no recorded activation, so there is no execution to evaluate');
  else if (steps.completed + steps.failed + steps.skipped + steps.uncertain === 0) {
    push('the plan was activated but no step outcome was recorded, so nothing about the run is settled');
  }
  if (steps.notRun > 0 && activated) push(`${steps.notRun} step(s) have no recorded outcome; they are counted as not run, never as success`);
  if (!goal) push('the run names no goal, so no success criteria were recorded and the classification is about execution only');
  else {
    const gating = (criteria ?? []).filter((c) => c.gating !== false);
    const unverified = gating.filter((c) => c.state === 'unverified');
    if (unverified.length > 0) {
      push(`${unverified.length} of ${gating.length} criterion(s) have no recorded evidence either way, so objective success is unverified`);
    }
    const unmet = gating.filter((c) => c.state === 'not_met');
    if (unmet.length > 0) push(`${unmet.length} criterion(s) are recorded as contradicted`);
  }
  if (goal && planStatus === 'completed' && (criteria ?? []).some((c) => c.state !== 'met')) {
    push('the plan is recorded complete, but execution success is not objective success: the goal\'s criteria are not all met');
  }
  push('step completion is as the plan store recorded it, where a completed step required a verified audit operation; APEX re-ran nothing');
  if (operationIds.length === 0) push('no audit operation is named by any step outcome, so this evaluation rests on plan state alone');
  if (truncatedCapabilities) push(`more than ${MAX_CAPABILITIES} capabilities appear in this run; only the first ${MAX_CAPABILITIES} are listed`);
  if (predictionsConsidered > 0) push('a recorded prediction is the user\'s expectation, not an observation, and is cited only to connect the two');
  return out;
}

export function evaluationDigest(evaluation) {
  return sha256Hex(stableStringify({
    planId: evaluation.planId,
    planVersion: evaluation.planVersion,
    goalId: evaluation.goalId ?? null,
    taskId: evaluation.taskId ?? null,
    objectiveKey: evaluation.objectiveKey ?? null,
    classification: evaluation.classification,
    criteria: evaluation.criteria,
    steps: evaluation.steps,
    capabilities: evaluation.capabilities,
    sequence: evaluation.sequence,
    evidence: evaluation.evidence,
    confidence: evaluation.confidence,
    limitations: evaluation.limitations,
  }));
}

// The evidence pointer block. Only ids of records that exist are accepted by the action layer; this
// builder deduplicates, bounds, and orders them so the digest is stable.
export function evidenceBlock({
  operationIds = [], experienceIds = [], feedbackIds = [], predictionIds = [],
} = {}) {
  const uniq = (values) => [...new Set(values.filter((v) => typeof v === 'string' && v.length > 0))].slice(0, MAX_EVIDENCE_REFS);
  return {
    operationIds: uniq(operationIds),
    experienceIds: uniq(experienceIds),
    feedbackIds: uniq(feedbackIds),
    predictionIds: uniq(predictionIds),
  };
}

// Build one evaluation record (without id, createdAt, or provenance; the store adds those).
export function buildEvaluation({
  plan, goal = null, task = null, experiences = [], feedback = [], predictions = [], now = null,
} = {}) {
  if (!plan || typeof plan !== 'object') throw new TypeError('an evaluation needs a plan record');
  const activated = Boolean(plan.activation);
  const { counts, perStep } = stepCounts({ plan, task });
  const capabilities = capabilityOutcomes(perStep);
  const criteria = criteriaStates(goal);
  const operationIds = perStep.map((s) => s.operationId).filter(Boolean);
  const evaluation = {
    planId: plan.id,
    planVersion: plan.version,
    goalId: plan.goalId ?? null,
    taskId: plan.activation?.taskId ?? task?.id ?? null,
    objective: singleLine(plan.outcome ?? '', MAX_OBJECTIVE_CHARS),
    objectiveKey: objectiveKeyOf(plan.outcome),
    activated,
    planStatus: plan.status ?? null,
    steps: counts,
    capabilities,
    sequence: capabilitySequence(perStep),
    criteria,
    evidence: evidenceBlock({
      operationIds,
      experienceIds: experiences.map((e) => e.id),
      feedbackIds: feedback.map((f) => f.id),
      predictionIds: predictions.map((p) => p.id),
    }),
  };
  evaluation.classification = classifyOutcome({
    activated, planStatus: plan.status, steps: counts, criteria,
  });
  evaluation.confidence = confidenceOf({
    activated, steps: counts, criteria, operationIds: evaluation.evidence.operationIds, planStatus: plan.status,
  });
  evaluation.limitations = limitationsFor({
    activated,
    planStatus: plan.status,
    steps: counts,
    criteria,
    operationIds: evaluation.evidence.operationIds,
    goal,
    truncatedCapabilities: capabilities.length === MAX_CAPABILITIES,
    predictionsConsidered: evaluation.evidence.predictionIds.length,
  });
  evaluation.evidenceSha256 = evaluationDigest(evaluation);
  if (now) evaluation.createdAt = now;
  return evaluation;
}

// ---- stored-record validation ----------------------------------------------

function textProblem(value, name, max, { optional = false } = {}) {
  if (value === undefined || value === null) return optional ? null : `missing ${name}`;
  if (typeof value !== 'string' || value.length === 0) return `missing ${name}`;
  if (value.length > max) return `${name} is too long`;
  return null;
}

export function idListProblem(value, name, max, { min = 0 } = {}) {
  if (!Array.isArray(value)) return `${name} must be a list`;
  if (value.length < min) return `${name} lists ${value.length} entries, and at least ${min} are required`;
  if (value.length > max) return `${name} lists more than ${max} entries`;
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) return `${name} holds an invalid id`;
    if (seen.has(id)) return `${name} names the same id twice`;
    seen.add(id);
  }
  return null;
}

// The validator the experience log runs on every line. It re-derives the classification from the
// record's own counts, so a line that claims `achieved` with no completed step is refused as damage
// rather than read as an outcome.
export function validateEvaluationRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if (r.kind !== EVALUATION_KIND) return 'not an outcome evaluation';
  if (typeof r.id !== 'string' || r.id.length === 0) return 'evaluation has missing or invalid id';
  if (typeof r.planId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(r.planId)) return 'evaluation has missing or invalid planId';
  if (!Number.isInteger(r.planVersion) || r.planVersion < 1) return 'evaluation has invalid planVersion';
  if (r.goalId !== null && (typeof r.goalId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(r.goalId))) return 'evaluation has invalid goalId';
  if (r.taskId !== null && (typeof r.taskId !== 'string' || r.taskId.length > 64)) return 'evaluation has invalid taskId';
  const objective = textProblem(r.objective, 'objective', MAX_OBJECTIVE_CHARS);
  if (objective) return objective;
  if (r.objectiveKey !== null && (typeof r.objectiveKey !== 'string' || !/^[0-9a-f]{16}$/.test(r.objectiveKey))) return 'evaluation has invalid objectiveKey';
  if (typeof r.activated !== 'boolean') return 'evaluation must record whether the plan was activated';
  if (r.planStatus !== null && typeof r.planStatus !== 'string') return 'evaluation has invalid planStatus';
  if (!CLASSIFICATIONS.includes(r.classification)) return 'evaluation has an unknown classification';
  if (!CONFIDENCES.includes(r.confidence)) return 'evaluation has an unknown confidence grade';
  const steps = r.steps;
  if (!steps || typeof steps !== 'object' || Array.isArray(steps)) return 'evaluation has no step counts';
  for (const key of ['total', 'completed', 'failed', 'skipped', 'uncertain', 'notRun']) {
    if (!Number.isInteger(steps[key]) || steps[key] < 0) return `evaluation step count ${key} is invalid`;
  }
  if (steps.completed + steps.failed + steps.skipped + steps.uncertain + steps.notRun !== steps.total) {
    return 'evaluation step counts do not add up to its total';
  }
  if (!Array.isArray(r.criteria) || r.criteria.length > MAX_CRITERIA) return `evaluation must list at most ${MAX_CRITERIA} criteria`;
  for (const criterion of r.criteria) {
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) return 'evaluation criterion is not an object';
    if (!CRITERION_ID_RE.test(String(criterion.id))) return 'evaluation criterion has an invalid id';
    if (!CRITERION_STATES.includes(criterion.state)) return 'evaluation criterion has an unknown state';
    if (typeof criterion.gating !== 'boolean') return 'evaluation criterion must say whether it gates completion';
  }
  if (!Array.isArray(r.capabilities) || r.capabilities.length > MAX_CAPABILITIES) return `evaluation must list at most ${MAX_CAPABILITIES} capabilities`;
  for (const row of r.capabilities) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return 'evaluation capability is not an object';
    if (typeof row.capability !== 'string' || !CAPABILITY_RE.test(row.capability)) return 'evaluation capability name is invalid';
    for (const key of ['steps', 'completed', 'failed', 'skipped', 'uncertain', 'notRun']) {
      if (!Number.isInteger(row[key]) || row[key] < 0) return `evaluation capability count ${key} is invalid`;
    }
    if (row.completed + row.failed + row.skipped + row.uncertain + row.notRun !== row.steps) {
      return 'evaluation capability counts do not add up to its step count';
    }
    if (!CAPABILITY_OUTCOMES.includes(row.outcome)) return 'evaluation capability has an unknown outcome';
  }
  if (!Array.isArray(r.sequence) || r.sequence.length > MAX_CAPABILITIES) return `evaluation must list at most ${MAX_CAPABILITIES} capabilities in order`;
  if (r.sequence.some((name) => typeof name !== 'string' || !CAPABILITY_RE.test(name))) return 'evaluation sequence holds an invalid capability name';
  if (new Set(r.sequence).size !== r.sequence.length) return 'evaluation sequence names the same capability twice';
  if (!r.evidence || typeof r.evidence !== 'object' || Array.isArray(r.evidence)) return 'evaluation has no evidence block';
  for (const key of ['operationIds', 'experienceIds', 'feedbackIds', 'predictionIds']) {
    const problem = idListProblem(r.evidence[key], `evaluation evidence ${key}`, MAX_EVIDENCE_REFS);
    if (problem) return problem;
  }
  if (!Array.isArray(r.limitations) || r.limitations.length > MAX_LIMITATIONS) return `evaluation must record at most ${MAX_LIMITATIONS} limitations`;
  if (r.limitations.some((item) => typeof item !== 'string' || item.length === 0 || item.length > MAX_LIMITATION_CHARS)) {
    return 'evaluation limitation text is invalid';
  }
  const expected = classifyOutcome({
    activated: r.activated, planStatus: r.planStatus, steps, criteria: r.criteria,
  });
  if (r.classification !== expected) return `evaluation claims ${r.classification}, but its own step counts and criteria state ${expected}`;
  if (typeof r.evidenceSha256 !== 'string' || r.evidenceSha256.length !== 64) return 'evaluation has a missing or invalid evidence digest';
  if (r.evidenceSha256 !== evaluationDigest(r)) return 'evaluation digest does not match the evaluation it summarises';
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return 'evaluation has a bad createdAt';
  if (!r.provenance || typeof r.provenance !== 'object') return 'evaluation has no provenance';
  return null;
}
