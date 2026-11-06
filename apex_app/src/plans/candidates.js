// Candidate planning: turning a recorded goal into alternative plans, deterministically.
//
// A goal records what the user wants to be true; a plan records work that could make it true. The
// gap between them is filled here from the two sources APEX can actually read: the goal's own
// recorded criteria, and the live action registry. Each unit of work is resolved through the
// existing bounded mapping (`mapWorkText`), so a step either names a registered, plannable
// capability or the criterion is reported as work no capability can carry. An invented action name
// is the failure mode this module exists to prevent, so it is not reachable here: no step carries
// an action that did not come out of the registry.
//
// A criterion is only ever claimed as settled by a step whose capability was matched to that
// criterion's own words. When a criterion names no capability and only the goal's recorded request
// does, the step is still offered - it is the user's wording and a real capability - but it carries
// no criterion attribution, and the criterion is disclosed as matched from the goal rather than
// from itself. Without that separation a plan could look like it completed a goal by doing
// something vaguely related to it.
//
// Where several approaches are genuinely available, up to MAX_CANDIDATES_PER_GOAL candidates come
// from named strategies that differ in what they attempt and in what they touch, never in how
// confidently they are worded. An approach that is the same sequence of steps under another name is
// reported as not offered rather than presented as a choice. Each candidate records the trade-off it
// makes: the criteria it settles, the criteria it leaves, the capabilities it needs, how far each
// step can be undone, what happens if a step fails, and an effort estimate only where a recorded
// duration supports one.
//
// This module owns no store, registers no action, and grants nothing. It returns candidate content
// plus the reasoning behind it. Recording a candidate is the existing `plan.add` write, approval is
// the existing `plan.approve`, and execution is the existing task runner: a candidate that has not
// been through those is inert text. `readyForApproval` reports what read-only validation found; it
// is not a permission, and nothing here can start work.
import { createHash } from 'node:crypto';
import { mapWorkText, stepExpectation } from '../executive/mapping.js';
import { checkSteps } from '../tasks/planner.js';
import { stableStringify } from '../tasks/model.js';
import { singleLine } from '../util.js';
import { Requirement, basisOf, requirementOf } from '../goals/model.js';
import {
  MAX_ASSERTIONS, MAX_ASSERTION_CHARS, MAX_CANDIDATES_PER_GOAL, MAX_ESTIMATE_SECONDS,
  MAX_EXPECTED_CHARS, MAX_PLAN_OUTCOME_CHARS, MAX_PLAN_STEPS, MAX_PRECONDITION_CHARS,
  MAX_PRECONDITIONS, MAX_RECOVERY_CHARS, MAX_VERIFICATION_CHARS, planRisk, validatePlanContent,
} from './model.js';

export const CANDIDATE_NOTE = 'a candidate is a plan that has been read and validated, not approved: recording it is a write, and running it needs the user approval of the recorded content';

// The approaches, in the order they are offered. They differ in what work they take on and what
// they change, which is a trade-off a reader can act on; they do not differ in confidence.
export const CandidateStrategy = Object.freeze({
  REQUIRED_ONLY: 'required_only',
  ALL_OPEN_CRITERIA: 'all_open_criteria',
  READ_BEFORE_WRITE: 'read_before_write',
});

export const STRATEGY_NOTE = Object.freeze({
  [CandidateStrategy.REQUIRED_ONLY]: 'works on the criteria the user made required, and leaves any criterion APEX only suggested out',
  [CandidateStrategy.ALL_OPEN_CRITERIA]: 'works on every open criterion, including ones APEX put forward, and marks which those are',
  [CandidateStrategy.READ_BEFORE_WRITE]: 'runs every read-only step before any write, so a wrong assumption surfaces before a record is made',
});

// What happens when a step fails, stated as the existing task runner actually behaves: the task
// stops and the later steps do not run. A read leaves nothing to correct; a write appends a record a
// later record can correct but cannot erase, so calling it reversible would overstate it.
const READ_RECOVERY = 'the task stops here and later steps do not run; this step changed nothing, so it can be retried once the cause is fixed';
const WRITE_RECOVERY = 'the task stops here and later steps do not run; the record this step appended stays and a later record corrects it, so it is corrected rather than erased';

// Why a criterion has no step of its own. `no-capability` means nothing registered can carry it;
// `from-goal-request` means the criterion's own words name no capability, and any step offered for
// it came from the goal's recorded request instead.
const NoCapability = 'no-capability';
const FromGoalRequest = 'from-goal-request';

function refusal(reason, problems, extra = {}) {
  return {
    ok: false,
    reason,
    problems,
    candidates: [],
    skipped: [],
    unaddressed: [],
    assumedFromGoalRequest: [],
    metCriteria: [],
    declinedCriteria: [],
    clarificationNeeded: true,
    note: CANDIDATE_NOTE,
    ...extra,
  };
}

function dedupe(values) {
  return [...new Set(values.filter((v) => typeof v === 'string' && v.length > 0))];
}

// The median of recorded durations, or null when nothing has been recorded. An estimate is a
// measurement APEX has made of its own stores, not a guess about how long something takes.
function medianSeconds(samples) {
  const values = (Array.isArray(samples) ? samples : [])
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= MAX_ESTIMATE_SECONDS);
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return Number.isInteger(value) && value >= 0 && value <= MAX_ESTIMATE_SECONDS ? value : null;
}

// The open units of work in a goal, in recorded order. A satisfied criterion needs no step; a
// criterion the user declined stays in the record as what was suggested and takes no work.
function openUnits(goal) {
  const units = [];
  const met = [];
  const declined = [];
  for (const c of goal.criteria ?? []) {
    const requirement = requirementOf(c);
    if (c.status === 'satisfied') {
      met.push({ criterionId: c.id, description: singleLine(c.description, MAX_EXPECTED_CHARS), basis: basisOf(c) });
      continue;
    }
    if (requirement === Requirement.DECLINED) {
      declined.push({ criterionId: c.id, description: singleLine(c.description, MAX_EXPECTED_CHARS) });
      continue;
    }
    units.push({
      criterionId: c.id,
      description: singleLine(c.description, MAX_EXPECTED_CHARS),
      requirement,
      basis: basisOf(c),
      requiredEvidence: typeof c.requiredEvidence === 'string' ? singleLine(c.requiredEvidence, MAX_EXPECTED_CHARS) : null,
    });
  }
  return { units, met, declined };
}

// One unit resolved against the registry through the existing mapping. The criterion's own words are
// tried first, because a step is only evidence about the criterion it was matched to. If they name
// no capability, the goal's recorded request is tried - still the user's wording, not something
// invented here - and any step it yields is marked as derived and settles nothing by itself. A
// capability this generation was told cannot run is never substituted for: the criterion is reported
// as unaddressed with that reason instead.
function resolveUnit(unit, goal, registry, excluded) {
  const split = (rows) => [rows.filter((m) => !excluded.has(m.action)), rows.filter((m) => excluded.has(m.action))];
  const own = mapWorkText(unit.description, registry);
  const [ownUsable, ownDropped] = split(own.mapped);
  if (own.mapped.length > 0 && ownDropped.length === 0) {
    return { unit, attributable: true, steps: ownUsable.map((mapped) => ({ mapped, derived: false })), problem: null };
  }
  const reasons = own.unmapped.map((u) => u.reason);
  const refused = ownDropped.map((d) => d.action);
  let fallbackUsable = [];
  if (ownUsable.length === 0 && goal.request) {
    const fallback = mapWorkText(singleLine(goal.request, MAX_PLAN_OUTCOME_CHARS), registry);
    const [usable, dropped] = split(fallback.mapped);
    fallbackUsable = usable;
    refused.push(...dropped.map((d) => d.action));
    if (usable.length === 0) reasons.push(...fallback.unmapped.map((u) => u.reason));
  }
  const refusedActions = dedupe(refused);
  if (refusedActions.length > 0) {
    reasons.push(`this generation answers a recorded failure, so ${refusedActions.join(', ')} is not offered again`);
  }
  if (ownUsable.length > 0) {
    // Part of what this criterion asks for is refused, so no step here can be claimed to settle it.
    return { unit, attributable: false, steps: ownUsable.map((mapped) => ({ mapped, derived: false })), problem: { kind: NoCapability, reasons: dedupe(reasons) } };
  }
  if (fallbackUsable.length === 0) {
    return { unit, attributable: false, steps: [], problem: { kind: NoCapability, reasons: dedupe(reasons) } };
  }
  return {
    unit,
    attributable: false,
    steps: fallbackUsable.map((mapped) => ({ mapped, derived: true })),
    problem: {
      kind: FromGoalRequest,
      reasons: ['the criterion\'s own words name no registered capability, so the step offered for it comes from the goal\'s recorded request and settles no criterion by itself'],
    },
  };
}

function stepFrom({ id, stepRow, registry, durations, fallbackText }) {
  const { mapped, unit } = stepRow;
  const def = registry.get(mapped.action);
  const expectation = stepExpectation(def);
  const write = def.permission === 'write';
  // A criterion that records the evidence it needs has that requirement carried into the step's
  // verification condition, so the plan checks what the goal asked to be shown rather than only
  // that the action returned something. An unattributed step has no criterion to take that from.
  const requiredEvidence = stepRow.attributed ? unit?.requiredEvidence : null;
  const verification = requiredEvidence
    ? `${expectation.verification}; and ${requiredEvidence}`
    : expectation.verification;
  return {
    id,
    description: singleLine(mapped.description || fallbackText || mapped.action, MAX_EXPECTED_CHARS),
    action: mapped.action,
    input: mapped.input,
    dependsOn: [],
    expectedResult: singleLine(expectation.expectedResult, MAX_EXPECTED_CHARS),
    verification: singleLine(verification, MAX_VERIFICATION_CHARS),
    ...(stepRow.attributed && unit?.criterionId ? { criterionId: unit.criterionId } : {}),
    risk: expectation.risk,
    estimate: { seconds: medianSeconds(durations) },
    reversibility: write ? 'reversible' : 'read_only',
    recovery: singleLine(write ? WRITE_RECOVERY : READ_RECOVERY, MAX_RECOVERY_CHARS),
  };
}

// Sequential dependencies, because the task runner has no parallel path: each step depends on the
// one before it in the order this candidate runs in.
function chain(steps) {
  return steps.map((s, i) => ({ ...s, dependsOn: i === 0 ? [] : [steps[i - 1].id] }));
}

function isWrite(row, registry) {
  return registry.get(row.mapped.action).permission === 'write';
}

// The steps one approach takes on, with one step per action-and-input pair however many criteria ask
// for it: recording the same append twice because two criteria mention it would double the work.
// Attribution is decided here, per approach, so a criterion can only ever share a step that this
// candidate actually contains.
function draftSteps(rows, registry) {
  const draft = [];
  const atByKey = new Map();
  const covered = [];
  const shared = [];
  const unaddressed = [];
  const assumed = [];
  for (const row of rows) {
    if (row.problem?.kind === NoCapability) {
      unaddressed.push({ criterionId: row.unit.criterionId, text: row.unit.description, reasons: row.problem.reasons });
    } else if (row.problem?.kind === FromGoalRequest) {
      assumed.push({ criterionId: row.unit.criterionId, text: row.unit.description, reasons: row.problem.reasons });
    }
    for (const s of row.steps) {
      const key = `${s.mapped.action}|${stableStringify(s.mapped.input ?? {})}`;
      const attributed = row.attributable && !s.derived;
      const at = atByKey.get(key);
      if (at !== undefined) {
        if (attributed && draft[at].criterionId === null) {
          // A step first offered as the goal's own request is taken over by the criterion whose words
          // match it, so the claim attaches to the one that earned it.
          draft[at].criterionId = row.unit.criterionId;
          covered.push(row.unit.criterionId);
        } else if (attributed && draft[at].criterionId !== null) {
          shared.push({ criterionId: row.unit.criterionId, anchor: draft[at].criterionId });
        }
        continue;
      }
      atByKey.set(key, draft.length);
      draft.push({
        mapped: s.mapped,
        unit: row.unit,
        attributed,
        derived: s.derived,
        criterionId: attributed ? row.unit.criterionId : null,
      });
      if (attributed) covered.push(row.unit.criterionId);
    }
  }
  return { draft, covered, shared, unaddressed, assumed };
}

function preconditionsFor({ goal, steps, registry, evidence }) {
  const list = [];
  if (goal.id) {
    list.push(`the goal ${singleLine(String(goal.id).slice(0, 24), 24)} is recorded and is not completed, failed, cancelled, or superseded`);
  }
  for (const item of goal.prerequisites ?? []) list.push(`recorded prerequisite: ${item.text}`);
  for (const item of goal.blockers ?? []) list.push(`recorded blocker to clear first: ${item.text}`);
  for (const blocker of evidence?.knownBlockers ?? []) list.push(`blocker from the records: ${blocker}`);
  if (steps.some((s) => registry.get(s.action)?.permission === 'write')) {
    list.push('the stores these steps write can be written: a corrupt or locked store makes a step fail rather than guess');
  }
  if (steps.some((s) => s.action.startsWith('filesystem.'))) {
    list.push('an authorised filesystem root is configured, or these steps are unavailable');
  }
  return list.slice(0, MAX_PRECONDITIONS).map((p) => singleLine(p, MAX_PRECONDITION_CHARS));
}

function assertionsFor({ goal, steps, strategy, unaddressed, assumed, inferredIds, evidence }) {
  const assertions = [];
  if (goal.request) {
    assertions.push({ kind: 'user_fact', text: singleLine(`the goal asks for: ${goal.request}`, MAX_ASSERTION_CHARS) });
  }
  for (const u of unaddressed.slice(0, MAX_ASSERTIONS - 4)) {
    assertions.push({
      kind: 'unknown',
      text: singleLine(
        `no recorded capability can carry this criterion now: "${u.text}"${u.reasons.length ? ` (${u.reasons.join('; ')})` : ''}`,
        MAX_ASSERTION_CHARS,
      ),
    });
  }
  if (assumed.length > 0) {
    assertions.push({
      kind: 'inference',
      text: singleLine(
        `${assumed.map((a) => a.criterionId ?? '?').join(', ')} matched only from the goal's recorded request, not from their own words: the step offered for them settles no criterion by itself`,
        MAX_ASSERTION_CHARS,
      ),
    });
  }
  if (steps.length > 1) {
    assertions.push({
      kind: 'inference',
      text: 'steps are ordered as written and run one at a time: the task runner has no parallel path, so independence is not assumed',
    });
  }
  if (strategy === CandidateStrategy.ALL_OPEN_CRITERIA && inferredIds.length > 0) {
    assertions.push({
      kind: 'inference',
      text: singleLine(
        `this candidate works on ${inferredIds.join(', ')}, which APEX put forward and the user has not made required`,
        MAX_ASSERTION_CHARS,
      ),
    });
  }
  if (strategy === CandidateStrategy.READ_BEFORE_WRITE) {
    assertions.push({
      kind: 'inference',
      text: 'read-only steps run before any write, so a step that finds the state already wrong stops before anything is recorded',
    });
  }
  for (const failure of (evidence?.failedOperations ?? []).slice(0, 1)) {
    // A record read from the audit log carries its own id, so the citation is that id rather than a
    // text APEX wrote. Handed only a bare id, the revision still cites it; handed neither, it records
    // the gap as an unknown instead of asserting evidence it was not given.
    const operationId = singleLine(typeof failure === 'string' ? failure : (failure?.operationId ?? ''), 64);
    const detail = typeof failure === 'string' ? null : singleLine(failure?.detail ?? '', MAX_ASSERTION_CHARS);
    assertions.push(operationId.length > 0
      ? {
        kind: 'retrieved_evidence',
        text: singleLine(`replanned from a recorded failure: ${detail || operationId}`, MAX_ASSERTION_CHARS),
        ref: operationId,
      }
      : {
        kind: 'unknown',
        text: singleLine(
          `this revision was asked for without an operation to cite${detail ? `: ${detail}` : ''}`,
          MAX_ASSERTION_CHARS,
        ),
      });
  }
  return assertions.slice(0, MAX_ASSERTIONS);
}

function contentDigest(content) {
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}

// Whether two candidates are the same plan. The steps, their inputs, their order and what each is
// for: a candidate that differs only in how its reasoning is worded is not another approach, and
// offering it as one would be a choice with nothing in it.
function structureKey(steps) {
  return stableStringify(steps.map((s) => [s.action, s.input ?? {}, s.criterionId ?? null]));
}

function capabilityRows(steps, registry) {
  const seen = new Map();
  for (const s of steps) {
    if (seen.has(s.action)) continue;
    const def = registry.get(s.action);
    seen.set(s.action, {
      action: s.action,
      permission: def.permission,
      plannable: def.plannable !== false,
      hasVerifier: typeof def.verify === 'function',
      reversibility: def.permission === 'write' ? 'reversible' : 'read_only',
    });
  }
  return [...seen.values()].sort((a, b) => (a.action < b.action ? -1 : a.action > b.action ? 1 : 0));
}

// Build one candidate from the units its approach takes on. The ordering is the strategy's; step ids
// and dependencies are assigned after ordering, so the record shows the sequence it runs in.
function buildCandidate({ strategy, goal, registry, rows, leftOut, evidence, outcomeText, lineage }) {
  const { draft, covered, shared, unaddressed, assumed } = draftSteps(rows, registry);
  const ordered = strategy === CandidateStrategy.READ_BEFORE_WRITE
    ? draft
      .map((row, index) => ({ row, index, write: isWrite(row, registry) ? 1 : 0 }))
      .sort((a, b) => (a.write - b.write) || (a.index - b.index))
      .map((x) => x.row)
    : draft;
  const inside = ordered.slice(0, MAX_PLAN_STEPS);
  const beyond = ordered.slice(MAX_PLAN_STEPS);
  const steps = chain(inside.map((row, i) => stepFrom({
    id: `s${i + 1}`,
    stepRow: { ...row, unit: row.unit },
    registry,
    durations: evidence?.actionDurations?.[row.mapped.action],
    fallbackText: row.attributed ? row.unit.description : null,
  })));
  const stepIdByCriterion = new Map(steps.filter((s) => s.criterionId).map((s) => [s.criterionId, s.id]));
  // A criterion is only settled by a step this candidate actually contains: one that fell outside the
  // plan bound, or whose anchor step did, is reported as beyond the bound rather than as covered.
  const insideCriterionIds = new Set(inside.map((row) => row.criterionId).filter(Boolean));
  const sharedInside = shared.filter((r) => insideCriterionIds.has(r.anchor));
  const sharedRows = sharedInside.map((r) => ({
    criterionId: r.criterionId,
    sameStepAs: r.anchor,
    stepId: stepIdByCriterion.get(r.anchor) ?? null,
  }));
  const coveredIds = dedupe(covered).filter((id) => insideCriterionIds.has(id));
  const inferredIds = dedupe(rows.filter((r) => r.unit.requirement === Requirement.SUGGESTED).map((r) => r.unit.criterionId));
  const content = {
    goalId: goal.id ?? null,
    outcome: outcomeText,
    steps,
    preconditions: preconditionsFor({ goal, steps, registry, evidence }),
    assertions: assertionsFor({ goal, steps, strategy, unaddressed, assumed, inferredIds, evidence }),
    resources: {
      estimatedSeconds: steps.length > 0 && steps.every((s) => Number.isInteger(s.estimate.seconds))
        ? steps.reduce((n, s) => n + s.estimate.seconds, 0)
        : null,
    },
  };
  const checked = checkSteps(steps, registry, 'user');
  const problems = dedupe([...checked.problems, ...validatePlanContent(content)]);
  return {
    strategy,
    note: STRATEGY_NOTE[strategy],
    outcome: content.outcome,
    content,
    digest: contentDigest(content),
    steps: steps.length,
    writes: steps.filter((s) => registry.get(s.action).permission === 'write').length,
    reads: steps.filter((s) => registry.get(s.action).permission !== 'write').length,
    risk: planRisk(steps),
    reversibility: steps.map((s) => ({ id: s.id, action: s.action, reversibility: s.reversibility })),
    failurePaths: steps.map((s) => ({ id: s.id, action: s.action, recovery: s.recovery })),
    capabilities: capabilityRows(steps, registry),
    criteriaCovered: coveredIds,
    criteriaSharedWithAnEarlierStep: sharedRows,
    criteriaLeftUnaddressed: unaddressed.map((u) => u.criterionId).filter(Boolean),
    criteriaAssumedFromTheGoalRequest: assumed.map((a) => a.criterionId).filter(Boolean),
    criteriaLeftOutOfThisApproach: strategy === CandidateStrategy.REQUIRED_ONLY
      ? dedupe(leftOut.map((r) => r.unit.criterionId))
      : [],
    criteriaFromInference: inferredIds,
    stepsBeyondThePlanBound: dedupe([
      ...beyond.map((row) => row.criterionId),
      ...shared.filter((r) => !insideCriterionIds.has(r.anchor)).map((r) => r.criterionId),
    ]),
    estimatedSeconds: content.resources.estimatedSeconds,
    validation: { ok: problems.length === 0, problems },
    // A candidate is a draft of a plan, never a permission: it carries no approval and no
    // activation, and nothing here can start it. Recording, approval and execution stay user acts.
    executable: false,
    approved: false,
    readyForApproval: problems.length === 0,
    ...(lineage ? { lineage } : {}),
  };
}

function outcomeFor(goal, workText) {
  return singleLine(workText || goal.request || 'the recorded goal criteria are met', MAX_PLAN_OUTCOME_CHARS);
}

// Generate the candidate plans a goal currently supports.
//
// `evidence` is what the caller has actually read: `actionDurations` (recorded durations per action,
// so an estimate exists only where one was measured), `knownBlockers`, `unavailableActions` (actions
// a record says cannot run now) and `failedOperations` (the failure records this generation answers,
// each as the audit log holds it: `{operationId, detail}`, or the bare operation id on its own).
// Nothing here opens a store, so it can only use what it is handed.
export function candidatesForGoal({ goal, registry, evidence = null, workText = null, max = MAX_CANDIDATES_PER_GOAL }) {
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) {
    return refusal('no-goal', ['a candidate is generated against a recorded goal, and none was given']);
  }
  if (!registry || typeof registry.get !== 'function') {
    return refusal('no-registry', ['the action registry is not available, so no capability could be checked']);
  }
  const excluded = new Set((evidence?.unavailableActions ?? []).map((a) => String(a)));
  const { units, met, declined } = openUnits(goal);
  if (units.length === 0) {
    return refusal('no-open-criteria', [
      met.length + declined.length > 0
        ? 'every criterion of this goal is already satisfied or has been declined, so there is nothing to plan'
        : 'the goal records no criteria, so APEX cannot say what a plan would have to settle: the criteria are needed, not guessed',
    ], { metCriteria: met, declinedCriteria: declined, clarificationNeeded: met.length === 0 && declined.length === 0 });
  }

  const resolved = units.map((unit) => resolveUnit(unit, goal, registry, excluded));
  const unaddressed = resolved.filter((r) => r.problem?.kind === NoCapability)
    .map((r) => ({ criterionId: r.unit.criterionId, text: r.unit.description, reasons: r.problem.reasons }));
  const assumed = resolved.filter((r) => r.problem?.kind === FromGoalRequest)
    .map((r) => ({ criterionId: r.unit.criterionId, text: r.unit.description, reasons: r.problem.reasons }));
  if (resolved.every((r) => r.steps.length === 0)) {
    return refusal('no-capability', [
      'no part of this goal can be carried by a registered capability now, so APEX records no candidate rather than inventing steps',
    ], { unaddressed, assumedFromGoalRequest: assumed, metCriteria: met, declinedCriteria: declined });
  }

  const outcome = outcomeFor(goal, workText);
  const lineage = evidence?.lineage ?? null;
  const required = resolved.filter((r) => r.unit.requirement !== Requirement.SUGGESTED);
  const suggested = resolved.filter((r) => r.unit.requirement === Requirement.SUGGESTED);
  const candidates = [];
  const skipped = [];
  const offeredKeys = new Map();
  for (const strategy of [
    CandidateStrategy.REQUIRED_ONLY,
    CandidateStrategy.ALL_OPEN_CRITERIA,
    CandidateStrategy.READ_BEFORE_WRITE,
  ]) {
    if (candidates.length >= max) {
      skipped.push({ strategy, reason: `the candidate bound for one goal is ${max}, so this approach was not offered` });
      continue;
    }
    if (strategy === CandidateStrategy.REQUIRED_ONLY && required.length === 0) {
      skipped.push({ strategy, reason: 'the goal has no criterion the user made required, only suggestions awaiting a decision' });
      continue;
    }
    const rows = strategy === CandidateStrategy.REQUIRED_ONLY ? required : resolved;
    if (rows.every((r) => r.steps.length === 0)) {
      skipped.push({ strategy, reason: 'no criterion this approach takes on can be carried by a registered capability now' });
      continue;
    }
    if (strategy === CandidateStrategy.READ_BEFORE_WRITE) {
      const { draft } = draftSteps(rows, registry);
      const writes = draft.filter((row) => isWrite(row, registry)).length;
      if (writes === 0 || writes === draft.length) {
        skipped.push({
          strategy,
          reason: draft.length === 0
            ? 'there is no step to order'
            : `every step this approach takes on ${writes === 0 ? 'changes no record' : 'is a write'}, so there is no read-before-write order to choose`,
        });
        continue;
      }
    }
    const candidate = buildCandidate({
      strategy,
      goal,
      registry,
      rows,
      leftOut: strategy === CandidateStrategy.REQUIRED_ONLY ? suggested : [],
      evidence,
      outcomeText: outcome,
      lineage,
    });
    const sameAs = offeredKeys.get(structureKey(candidate.content.steps));
    if (sameAs !== undefined) {
      skipped.push({ strategy, reason: `this approach is the plan already offered as ${sameAs}: nothing recorded makes its steps differ` });
      continue;
    }
    offeredKeys.set(structureKey(candidate.content.steps), strategy);
    candidates.push(candidate);
  }

  if (candidates.length === 0) {
    return refusal('no-candidate', ['every approach was refused, unavailable, or the same plan under another name'], {
      unaddressed,
      assumedFromGoalRequest: assumed,
      metCriteria: met,
      declinedCriteria: declined,
      skipped,
    });
  }

  return {
    ok: true,
    reason: null,
    problems: [],
    goalId: goal.id ?? null,
    goalRevision: goal.revision ?? null,
    candidates,
    skipped,
    unaddressed,
    assumedFromGoalRequest: assumed,
    metCriteria: met,
    declinedCriteria: declined,
    clarificationNeeded: unaddressed.length > 0 || assumed.length > 0,
    note: CANDIDATE_NOTE,
  };
}

// Revised candidates for a plan that has stopped being viable.
//
// `prior` is the plan being responded to and `evidence` says why: the actions that failed or are
// unavailable, the audit operations recording it, and any measured durations. The prior plan is
// read, never touched - superseding it is the user's recorded act through the existing plan store,
// and its history stays where it was written. A revision is fresh work: it carries its own content,
// so an approval bound to the older content approves nothing here.
export function revisedCandidates({ goal, registry, prior, evidence = {}, reason = null, max = MAX_CANDIDATES_PER_GOAL }) {
  if (!prior || typeof prior !== 'object' || !Array.isArray(prior.steps)) {
    return refusal('no-prior-plan', ['a revision responds to a recorded plan, and none was given']);
  }
  const failedActions = dedupe([
    ...(evidence.unavailableActions ?? []),
    ...Object.entries(prior.stepResults ?? {})
      .filter(([, r]) => r?.status === 'failed' || r?.status === 'uncertain')
      .map(([id]) => prior.steps.find((s) => s.id === id)?.action)
      .filter(Boolean),
  ].map(String));
  const lineage = {
    supersedes: prior.id,
    priorVersion: prior.version,
    priorApprovalHash: prior.approval?.contentHash ?? null,
    reason: singleLine(reason ?? 'the recorded plan stopped being viable', MAX_ASSERTION_CHARS),
  };
  const result = candidatesForGoal({
    goal,
    registry,
    workText: prior.outcome,
    max,
    evidence: { ...evidence, unavailableActions: failedActions, lineage },
  });
  if (!result.ok) return result;
  // What the earlier plan attempted still has to be attempted, or the revision answers a different
  // goal. A criterion only a refused action could settle is reported as uncovered, not dropped.
  const attempted = dedupe(prior.steps.map((s) => s.criterionId).filter(Boolean));
  const covered = result.candidates.flatMap((c) => c.criteriaCovered);
  return {
    ...result,
    revision: {
      supersedes: lineage.supersedes,
      priorVersion: lineage.priorVersion,
      priorApprovalHash: lineage.priorApprovalHash,
      refusedActions: failedActions,
      freshApprovalRequired: true,
      priorPlanChanged: false,
      criteriaTheEarlierPlanAttempted: attempted,
      criteriaNoCandidateCovers: attempted.filter((id) => !covered.includes(id)),
    },
  };
}

// One line per candidate: the approach, the criteria it settles and leaves, its risk, reversibility,
// capabilities, effort and validation result. No score is printed, because a score would look like
// knowledge the records do not contain.
export function renderCandidates(result, { registry = null } = {}) {
  const lines = [];
  if (!result.ok) {
    lines.push(`No candidate plan could be recorded: ${result.reason}`);
    for (const p of result.problems ?? []) lines.push(`  ${p}`);
    for (const u of result.unaddressed ?? []) {
      lines.push(`  criterion ${u.criterionId ?? '-'}: ${u.text}${u.reasons?.length ? ` (${u.reasons.join('; ')})` : ''}`);
    }
    for (const a of result.assumedFromGoalRequest ?? []) {
      lines.push(`  criterion ${a.criterionId ?? '-'} is matched from the goal, not its own words: ${a.text}`);
    }
    for (const s of result.skipped ?? []) lines.push(`  ${s.strategy}: not offered - ${s.reason}`);
    lines.push('APEX does not invent a capability to fill a gap, and does not treat an unrecorded approach as a plan.');
    return lines.join('\n');
  }
  lines.push(`Candidate plans for goal ${singleLine(String(result.goalId ?? '').slice(0, 24), 24)} (${result.candidates.length} offered, at most ${MAX_CANDIDATES_PER_GOAL} per goal):`);
  for (const c of result.candidates) {
    lines.push(`  ${c.strategy}: ${c.note}`);
    lines.push(`    ${c.steps} step(s): ${c.writes} write(s), ${c.reads} read(s); highest step risk ${c.risk}`);
    lines.push(`    settles: ${c.criteriaCovered.join(', ') || 'no recorded criterion'}; no capability for: ${c.criteriaLeftUnaddressed.join(', ') || 'none'}; matched from the goal: ${c.criteriaAssumedFromTheGoalRequest.join(', ') || 'none'}; left out here: ${c.criteriaLeftOutOfThisApproach.join(', ') || 'none'}`);
    if (c.criteriaSharedWithAnEarlierStep.length > 0) {
      lines.push(`    shares a step: ${c.criteriaSharedWithAnEarlierStep.map((r) => `${r.criterionId || '?'} with ${r.sameStepAs || '?'} (${r.stepId ?? 'no step'})`).join(', ')}`);
    }
    if (c.criteriaFromInference.length > 0) {
      lines.push(`    works on APEX suggestions the user has not made required: ${c.criteriaFromInference.join(', ')}`);
    }
    if (c.stepsBeyondThePlanBound.length > 0) {
      lines.push(`    beyond the ${MAX_PLAN_STEPS}-step plan bound: ${c.stepsBeyondThePlanBound.join(', ')}`);
    }
    lines.push(`    capabilities: ${c.capabilities.map((k) => `${k.action} (${k.permission}${k.hasVerifier ? ', verifiable' : ', no verifier'})`).join(', ') || 'none'}`);
    lines.push(`    effort: ${Number.isInteger(c.estimatedSeconds) ? `${c.estimatedSeconds}s, from recorded durations` : 'not estimated: no recorded duration for these actions'}`);
    lines.push(`    validation: ${c.validation.ok ? 'passed read-only checks' : `refused - ${c.validation.problems.join('; ')}`}`);
    if (c.lineage) {
      lines.push(`    revises ${singleLine(c.lineage.supersedes, 24)} version ${c.lineage.priorVersion}: ${c.lineage.reason}; a fresh approval is required`);
    }
    lines.push('    not approved, not started, not executable');
  }
  for (const s of result.skipped ?? []) lines.push(`  ${s.strategy}: not offered - ${s.reason}`);
  for (const u of result.unaddressed ?? []) {
    lines.push(`  no capability for criterion ${u.criterionId ?? '-'}: ${u.text}${u.reasons?.length ? ` (${u.reasons.join('; ')})` : ''}`);
  }
  for (const a of result.assumedFromGoalRequest ?? []) {
    lines.push(`  criterion ${a.criterionId ?? '-'} names no capability in its own words: ${a.text} (a step from the goal's recorded request is offered for it and settles no criterion)`);
  }
  if (registry) lines.push(`  capabilities were checked against the live registry, which holds ${registry.names().length} action(s) now.`);
  lines.push('Recording one of these is a write, and running one needs the user approval of the recorded content.');
  return lines.join('\n');
}
