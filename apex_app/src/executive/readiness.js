// Continuation readiness: which of seven states a piece of recorded work is actually in, and the
// record each state was read from.
//
// "Can I take this up now?" has more than one no. A plan can be waiting on an approval the user has
// not given, on a piece of evidence that no longer stands, on a decision APEX cannot make for them,
// on a dependency that has not completed, or on a capability the registry does not hold. Those are
// different situations with different next commands, and a single "blocked" or "not ready" would
// hide the difference. This module names the difference and cites the record for it.
//
// It reads; it decides nothing and authorizes nothing. Every state below is derived from a plan,
// goal, task, operation, or candidate comparison that already exists, and a situation no record
// supports is returned with `readiness: null` and the record's own words rather than forced into one
// of the seven. The precedence is fixed and disclosed, because two states can be supported at once: an
// approved plan whose capability disappeared is both blocked and not feasible, and the honest answer
// is the one that describes why it cannot run at all.
import { shortId, singleLine, truncate } from '../util.js';
import { isOpenPlan, planProgress } from '../plans/model.js';
import { StepStatus } from '../tasks/model.js';
import { isOpenStatus } from '../goals/model.js';
import { PRIORITY_RULE, planCapabilities } from '../continuation/engine.js';
import { CAUTION_NOTE, cautionLine } from '../prediction/caution.js';
import { BOUNDS, ContinuationReadiness, READINESS_BASIS, READINESS_RULE } from './vocabulary.js';

// The order the states are settled in, most decisive first. `not feasible` outranks everything because
// it says no capability can carry the work; `ready` states are only reached when nothing outranks them.
//
// `ready to continue` sits above `blocked` and `waiting for evidence` for one reason: it is not a claim
// that the run went well. It is read from the continuation derivation, which already refuses to say it
// when a capability was refused, a constraint gates the step, an approval moved, or a write's effect
// cannot be established. Where those hold, the derivation says so and the older states stand.
const PRECEDENCE = Object.freeze([
  ContinuationReadiness.NOT_FEASIBLE,
  ContinuationReadiness.REQUIRES_CLARIFICATION,
  ContinuationReadiness.READY_TO_CONTINUE,
  ContinuationReadiness.BLOCKED,
  ContinuationReadiness.WAITING_FOR_EVIDENCE,
  ContinuationReadiness.READY_TO_EXECUTE,
  ContinuationReadiness.READY_FOR_APPROVAL,
]);

// A failed live-validity check, translated by the name of the check that failed. The names are the
// ones `assessPlanValidity` returns, so a readiness state cannot drift from what was actually checked.
const CHECK_STATE = Object.freeze({
  capabilities: ContinuationReadiness.NOT_FEASIBLE,
  goal: ContinuationReadiness.BLOCKED,
  'goal-dependencies': ContinuationReadiness.BLOCKED,
  approval: ContinuationReadiness.BLOCKED,
  'goal-revision': ContinuationReadiness.REQUIRES_CLARIFICATION,
  assertions: ContinuationReadiness.WAITING_FOR_EVIDENCE,
  'recorded-outcomes': ContinuationReadiness.WAITING_FOR_EVIDENCE,
});

// The command the user would run to take the next step, per state. Nothing here runs it.
const NEXT_COMMAND = Object.freeze({
  [ContinuationReadiness.READY_TO_EXECUTE]: (ref) => `node bin/apex.js plan start ${ref}`,
  [ContinuationReadiness.READY_TO_CONTINUE]: (ref) => `node bin/apex.js plan continue ${ref}`,
  [ContinuationReadiness.READY_FOR_APPROVAL]: (ref) => `node bin/apex.js plan approve ${ref}`,
  [ContinuationReadiness.REQUIRES_CLARIFICATION]: (ref) => `node bin/apex.js plan candidates ${ref}`,
  [ContinuationReadiness.BLOCKED]: (ref) => `node bin/apex.js plan validate ${ref}`,
  [ContinuationReadiness.WAITING_FOR_EVIDENCE]: (ref) => `node bin/apex.js plan outcome ${ref}`,
  [ContinuationReadiness.NOT_FEASIBLE]: () => 'node bin/apex.js plan list',
});

// The states whose command acts on a plan record. A readiness reading can reach them from a candidate
// comparison alone, before any plan has been written, and a command naming a plan that does not exist
// is worse than no command: the reader runs it, and APEX reports a record it never made.
const PLAN_LEVEL_STATES = new Set([
  ContinuationReadiness.READY_TO_EXECUTE,
  // Only a recorded plan with a recorded run can be continuable, so this state is never reached from a
  // candidate comparison - there is no plan-level ambiguity to guard against.
  ContinuationReadiness.READY_TO_CONTINUE,
  ContinuationReadiness.READY_FOR_APPROVAL,
  ContinuationReadiness.BLOCKED,
  ContinuationReadiness.WAITING_FOR_EVIDENCE,
]);

function factor(list, text, readFrom) {
  list.push({ factor: singleLine(text, BOUNDS.maxReasonChars), readFrom: singleLine(readFrom, BOUNDS.maxReasonChars) });
}

// The step outcomes that decide a task's contribution to readiness. A step with no recorded outcome is
// missing evidence; a failed or uncertain one is what stopped the run.
function taskFactors(list, task) {
  if (!task) return;
  const pending = (task.steps ?? []).filter((s) => s.status === StepStatus.PENDING);
  const uncertain = (task.steps ?? []).filter((s) => s.status === StepStatus.UNCERTAIN);
  const failed = (task.steps ?? []).filter((s) => s.status === StepStatus.FAILED);
  const held = (task.steps ?? []).filter((s) => s.status === StepStatus.AWAITING_APPROVAL);
  const id = shortId(task.id);
  if (failed.length > 0) {
    factor(list, `${failed.length} step(s) of task ${id} recorded as failed: ${failed.map((s) => s.id).join(', ')}`,
      `task ${id} step status`);
  }
  if (uncertain.length > 0) {
    factor(list, `${uncertain.length} step(s) of task ${id} have no established outcome: ${uncertain.map((s) => s.id).join(', ')}`,
      `task ${id} step status; the audit record of each step is what would settle it`);
  }
  if (held.length > 0) {
    factor(list, `${held.length} step(s) of task ${id} wait for a step-level approval: ${held.map((s) => s.id).join(', ')}`,
      `task ${id} step status`);
  }
  if (pending.length > 0) {
    factor(list, `${pending.length} step(s) of task ${id} have no recorded outcome yet: ${pending.map((s) => s.id).join(', ')}`,
      `task ${id} step status`);
  }
}

// What the continuation reading of a plan's own run adds to its readiness.
//
// `continue.safe` is a refusal-by-default claim: the derivation sets it only after the plan bytes, the
// approval that binds them, the live registry, the goal's recorded constraints, the dependencies and
// every interrupted step's own audit record have all answered, and it refuses outright when a write's
// effect cannot be established. So where it holds, the steps still without an outcome are proven
// never-started rather than missing evidence - which is a different answer from `waiting for evidence`,
// and the only record that gives it is the reading. Where it does not hold, the reading's own refusals
// are stated as the states they name.
function continuationFactors(list, continuation, plan) {
  if (!continuation) return [];
  if (continuation.ok !== true) {
    for (const p of continuation.problems ?? []) {
      factor(list, `the continuation of this run cannot be read: ${p}`, 'the continuation reading for the plan\'s task');
    }
    return [ContinuationReadiness.WAITING_FOR_EVIDENCE];
  }
  if (continuation.plan?.id !== plan.id) {
    factor(list, `the continuation reading handed to this view is of plan ${shortId(continuation.plan?.id ?? '')}, not ${shortId(plan.id)}, so it says nothing about this plan`,
      'the continuation reading plan field');
    return [];
  }
  const taken = continuation.continue ?? {};
  const live = continuation.task?.lock?.alive === true;
  // A step waiting for the user's own confirmation, or one the run itself refuses because a
  // dependency did not complete, is on record as something the run still waits on. `continue.safe`
  // says only that some step may be taken up, and it is true of a run that also holds such a step;
  // calling that state `ready to continue` would hide what is owed, so the older states stand.
  const held = (taken.awaiting ?? []).length > 0;
  const gated = (taken.blockedByRun ?? []).length > 0;
  if (taken.safe === true && !live && !held && !gated) {
    const runnable = taken.runnable ?? [];
    factor(list, `its continuation reading says the run stopped with ${runnable.length} step(s) its records prove never started - ${runnable.join(', ')} - and with nothing on record that stops taking them up`,
      `continuation reading of plan ${shortId(plan.id)}: continue.safe over ${continuation.revalidation?.length ?? 0} revalidation check(s)`);
    for (const id of taken.neverReplay ?? []) {
      factor(list, `step ${id} of the same run is on record as never to be replayed, and taking the run up again leaves it as it stands`,
        'continuation reading continue.neverReplay, which is read from the step\'s own record');
    }
    return [ContinuationReadiness.READY_TO_CONTINUE];
  }
  const states = [];
  if (live) {
    factor(list, 'the continuation reading proves steps of the run untouched, but a live process holds the task lock, so the run is not this read\'s to take up',
      `continuation reading of plan ${shortId(plan.id)}: task lock ${continuation.task?.lock?.pid ?? 'unknown'}`);
    states.push(ContinuationReadiness.WAITING_FOR_EVIDENCE);
  }
  if (held) {
    factor(list, `step(s) ${(taken.awaiting ?? []).join(', ')} of the same run wait for a confirmation this read cannot give, so the run is not simply ready`,
      'continuation reading continue.awaiting, which is read from the step\'s own record');
    states.push(ContinuationReadiness.WAITING_FOR_EVIDENCE);
  }
  if (gated) {
    factor(list, `step(s) ${(taken.blockedByRun ?? []).join(', ')} of the same run are stopped by a dependency that holds no verified success`,
      'continuation reading continue.blockedByRun, which is read from the step\'s own record');
    states.push(ContinuationReadiness.BLOCKED);
  }
  if (!taken.safe) {
    for (const b of continuation.blockers ?? []) {
      factor(list, `the continuation reading refuses to take the run up: ${b}`, 'the continuation reading revalidation, step by step');
    }
    if ((taken.uncertain ?? []).length > 0 || (taken.neverReplay ?? []).length > 0
      || (taken.running ?? []).length > 0 || (taken.awaiting ?? []).length > 0) {
      states.push(ContinuationReadiness.WAITING_FOR_EVIDENCE);
    }
    if ((taken.requiresUser ?? []).length > 0 || (taken.blockedByRun ?? []).length > 0) {
      states.push(ContinuationReadiness.BLOCKED);
    }
  }
  return states;
}

// The state a closed plan is in: none of the seven, because none of them is about work that can be
// taken up. The record's own words are returned instead.
function closedPlan(plan, list) {
  const progress = planProgress(plan);
  factor(list, `plan ${shortId(plan.id)} is recorded as ${plan.status} with ${progress.completed} of ${progress.total} step outcome(s) recorded`,
    `plan ${shortId(plan.id)} status field`);
  return {
    readiness: null,
    basis: `plan ${shortId(plan.id)} is closed as ${plan.status}; no continuation of it is recorded as waiting. What it established is a different question: "plan outcome".`,
    factors: list,
    next: null,
  };
}

// What the live check says, by the name of each failed check. A check that passed is recorded as a
// factor too, because "ready" has to say what was verified rather than merely assert it.
function validityFactors(list, validity) {
  const states = [];
  for (const c of validity?.checks ?? []) {
    if (c.check === 'status') continue;
    if (c.ok) {
      factor(list, `live check \`${c.check}\` passed: ${c.detail}`, `assessPlanValidity check ${c.check}`);
      continue;
    }
    const state = CHECK_STATE[c.check] ?? null;
    if (state) states.push(state);
    factor(list, `live check \`${c.check}\` failed: ${c.detail}`, `assessPlanValidity check ${c.check}`);
  }
  return states;
}

// The readiness of a plan the user already has, from its own recorded status, the live check, the task
// it was started under, and the continuation reading of that task's run when one was handed over.
function readinessOfPlan({ plan, task = null, validity = null, assessment = null, continuation = null }, list) {
  if (!isOpenPlan(plan.status)) return closedPlan(plan, list);
  if (plan.status === 'blocked') {
    factor(list, `the plan is recorded as blocked${plan.blockedReason ? `: ${plan.blockedReason}` : ', with no reason recorded on it'}`,
      `plan ${shortId(plan.id)} status and blockedReason`);
    return ContinuationReadiness.BLOCKED;
  }
  const states = validityFactors(list, validity);
  taskFactors(list, task);
  if (continuation && task) states.push(...continuationFactors(list, continuation, plan));
  if (plan.status === 'active' && task) {
    const failed = (task.steps ?? []).some((s) => s.status === StepStatus.FAILED);
    const unresolved = (task.steps ?? []).some((s) => s.status === StepStatus.UNCERTAIN);
    const held = (task.steps ?? []).some((s) => s.status === StepStatus.AWAITING_APPROVAL);
    const pending = (task.steps ?? []).some((s) => s.status === StepStatus.PENDING);
    const progress = planProgress(plan);
    if (failed) states.push(ContinuationReadiness.BLOCKED);
    if (unresolved || held || pending) states.push(ContinuationReadiness.WAITING_FOR_EVIDENCE);
    if (task.status === 'completed' && progress.completed !== progress.total) {
      factor(list, `task ${shortId(task.id)} finished while ${progress.total - progress.completed} step outcome(s) are still not recorded on the plan`,
        `plan ${shortId(plan.id)} stepResults against task ${shortId(task.id)} step statuses`);
      states.push(ContinuationReadiness.WAITING_FOR_EVIDENCE);
    }
    if (task.status === 'running') {
      factor(list, `the record says task ${shortId(task.id)} is running, and APEX runs only while a command is running`,
        `task ${shortId(task.id)} status; its lock is what would show a live process`);
      states.push(ContinuationReadiness.WAITING_FOR_EVIDENCE);
    }
  }
  if (plan.status === 'draft') {
    if (states.length === 0) {
      factor(list, `the plan is a draft of ${plan.steps.length} step(s) and every live check passed`,
        `plan ${shortId(plan.id)} status and assessPlanValidity`);
      return ContinuationReadiness.READY_FOR_APPROVAL;
    }
  }
  if (plan.status === 'approved' && states.length === 0) {
    factor(list, `the plan is approved against its current content and every live check passed`,
      `plan ${shortId(plan.id)} approval record and assessPlanValidity`);
    return ContinuationReadiness.READY_TO_EXECUTE;
  }
  if (assessment) {
    const verdictState = {
      failed: ContinuationReadiness.BLOCKED,
      blocked: ContinuationReadiness.BLOCKED,
      uncertain: ContinuationReadiness.WAITING_FOR_EVIDENCE,
      partial: ContinuationReadiness.WAITING_FOR_EVIDENCE,
      awaiting_confirmation: ContinuationReadiness.WAITING_FOR_EVIDENCE,
    }[assessment.verdict];
    if (verdictState) {
      factor(list, `its own outcome reading is \`${assessment.verdict}\`: ${assessment.basis ?? assessment.summary ?? ''}`,
        `the assessment of plan ${shortId(plan.id)}, which cites ${assessment.findings?.length ?? 0} finding(s)`);
      states.push(verdictState);
    }
  }
  if (states.length === 0) {
    // An open plan the checks say nothing about: the approval is what is missing, and the record says so.
    return plan.status === 'approved' ? ContinuationReadiness.READY_TO_EXECUTE : ContinuationReadiness.READY_FOR_APPROVAL;
  }
  for (const state of PRECEDENCE) if (states.includes(state)) return state;
  return null;
}

// What a candidate set that was never generated says. These are the generator's own reasons, from
// `candidatesForGoal`, so a state is claimed only where a comparison actually refused to produce one.
const GENERATION_STATE = Object.freeze({
  'no-capability': ContinuationReadiness.NOT_FEASIBLE,
  'no-candidate': ContinuationReadiness.NOT_FEASIBLE,
  'no-open-criteria': ContinuationReadiness.REQUIRES_CLARIFICATION,
});

function readinessOfCandidates({ generation = null, comparison = null }, list) {
  if (generation && generation.ok === false) {
    const state = GENERATION_STATE[generation.reason] ?? null;
    for (const p of generation.problems ?? []) factor(list, p, `candidate generation reason \`${generation.reason}\``);
    if (state) return state;
    factor(list, `the generation stopped for a reason this view does not translate: ${generation.reason ?? 'no reason given'}`,
      'the candidate generation result itself');
    return null;
  }
  if (!comparison) return null;
  if (comparison.ok === false) {
    for (const c of comparison.excluded ?? []) {
      factor(list, `${c.strategy} was excluded by ${c.failedGates.map((g) => `${g.gate}: ${g.detail}`).join('; ')}`,
        'the candidate comparison, gate by gate');
    }
    if (comparison.reason === 'every-candidate-gated') return ContinuationReadiness.NOT_FEASIBLE;
    for (const p of comparison.problems ?? []) factor(list, p, `the comparison stopped for the reason \`${comparison.reason}\``);
    return null;
  }
  for (const c of comparison.excluded ?? []) {
    factor(list, `${c.strategy} was excluded by ${c.failedGates.map((g) => `${g.gate}: ${g.detail}`).join('; ')}`,
      'the candidate comparison, gate by gate');
  }
  for (const t of comparison.tradeOffs ?? []) factor(list, t, 'the disclosed comparison rule');
  for (const t of comparison.ties ?? []) factor(list, t, 'the disclosed comparison rule');
  for (const w of comparison.whatWouldSettleIt ?? []) factor(list, `what would settle it: ${w}`, 'the comparison, against the records it read');
  if (comparison.front.length > 1) return ContinuationReadiness.REQUIRES_CLARIFICATION;
  if (comparison.front.length === 1) {
    factor(list, `${comparison.front[0]} is the only candidate that passed every gate and is not dominated`, `the comparison rule: ${comparison.rule}`);
    return ContinuationReadiness.READY_FOR_APPROVAL;
  }
  return ContinuationReadiness.NOT_FEASIBLE;
}

// The answer for one piece of work. Pass the records that exist; anything absent is reported as absent
// rather than assumed. `plan` wins over a candidate set, because a recorded plan is the user's own
// intention and a candidate is a comparison of approaches to it.
function computeReadiness(input = {}) {
  const list = [];
  const { plan = null, goal = null, generation = null, comparison = null } = input;
  if (goal) {
    const open = (goal.criteria ?? []).filter((c) => c.status !== 'satisfied').length;
    factor(list, `the goal is recorded as ${goal.status} with ${open} criterion(s) not satisfied${goal.priority ? `, priority ${goal.priority}` : ', with no priority recorded'}`,
      `goal ${shortId(goal.id)} status, criteria and priority fields`);
    if (goal.status === 'blocked') {
      factor(list, `the goal itself is recorded as blocked${goal.blockedReason ? `: ${goal.blockedReason}` : ''}`,
        `goal ${shortId(goal.id)} status and blockedReason`);
    }
    if (!isOpenStatus(goal.status)) {
      return {
        readiness: null,
        basis: `goal ${shortId(goal.id)} is ${goal.status}, so no plan for it is continuation work`,
        factors: list,
        next: null,
        rule: READINESS_RULE,
      };
    }
  }
  const derived = plan
    ? readinessOfPlan(input, list)
    : readinessOfCandidates({ generation, comparison }, list);
  // A closed plan answers with the record's words rather than a state, and returns them directly.
  if (derived && typeof derived === 'object') return { ...derived, factors: list, rule: READINESS_RULE };
  const readiness = derived;
  if (!readiness) {
    return {
      readiness: null,
      basis: list.length > 0
        ? 'the records describe a situation none of the seven readiness states names, so no state is claimed'
        : 'no plan, goal, or candidate comparison was available to read, so readiness cannot be stated',
      factors: list,
      next: null,
      rule: READINESS_RULE,
    };
  }
  const planRef = plan ? shortId(plan.id) : (goal ? shortId(goal.id) : '<id>');
  const goalRef = goal ? shortId(goal.id) : '<goal-id>';
  const planLevel = PLAN_LEVEL_STATES.has(readiness);
  // Five of the seven states are read from a plan record, and a candidate comparison can reach "ready
  // for approval" before one exists. Naming `plan approve <goal-id>` would be a command for a record
  // nobody has written, so the read that shows the candidate again is offered, and labelled as a read.
  const candidateOnly = planLevel && !plan;
  // The two remaining states point at a read (`plan candidates`, `plan list`), so their reference is
  // the goal's id rather than the plan's: a candidates read asked for a goal ref, and a plan id given
  // to it resolves to nothing.
  const command = candidateOnly
    ? `node bin/apex.js plan candidates ${goalRef}`
    : NEXT_COMMAND[readiness](planLevel ? planRef : goalRef);
  return {
    readiness,
    basis: READINESS_BASIS[readiness],
    factors: list,
    next: command,
    nextIsRead: !planLevel || candidateOnly,
    noPlanRecord: candidateOnly,
    rule: READINESS_RULE,
  };
}

// What a live contradicted expectation adds to a plan's readiness: disclosure, and nothing else.
//
// The states above answer "can this be taken up", and a caution does not bear on that question. The
// plan's approval, its content, the live registry, the goal's constraints and every step's own record
// decide it, and none of them moves because an expectation was contradicted. So the caution is added as
// a factor beside the state, never as a state of its own, and `renderReadiness` says in words that the
// state did not move. Pushing it through PRECEDENCE would silently turn a read into a gate.
//
// `expectationCautions` is `null` when no read was attempted (nothing was claimed either way), and an
// array - possibly empty - when one was. `cautionRead.unavailable` is reported rather than swallowed:
// a log that could not be read is not the same record as one that holds no contradiction.
function withExpectationCautions(reading, input) {
  const plan = input.plan ?? null;
  const cautionRead = input.cautionRead ?? null;
  const provided = Array.isArray(input.cautions) ? input.cautions : (cautionRead?.cautions ?? null);
  if (!plan || !isOpenPlan(plan.status) || provided === null) {
    return { ...reading, expectationCautions: null, cautionRead };
  }
  const capabilities = new Set(planCapabilities(plan));
  const cautions = provided.filter((c) => c && capabilities.has(c.capability));
  const list = reading.factors;
  for (const caution of cautions) {
    factor(list, `a recorded expectation for ${caution.capability} was contradicted at ${caution.decidedAt ?? 'an unrecorded time'}, and a fresh read still confirms the verdict`,
      `prediction ${shortId(caution.id)} evaluation ${shortId(caution.evaluationId ?? '')}, re-derived by the prediction store`);
  }
  if (cautions.length > 0) {
    factor(list, 'the caution is disclosed beside the state and changes nothing about it: the same records decide whether the work can be taken up',
      'the expectation caution rule (src/prediction/caution.js)');
  }
  if (cautionRead?.unavailable) {
    factor(list, `the expectation read did not complete, so no caution could be confirmed or withdrawn: ${cautionRead.unavailable}`,
      'the prediction log read this view attempted');
  }
  return { ...reading, expectationCautions: cautions, cautionRead };
}

export function readinessOf(input = {}) {
  return withExpectationCautions(computeReadiness(input), input);
}

// The factors the continuation ranking used for one candidate, each naming the record it came from.
// The score is reported as an ordering device, which is all the records support it being.
export function prioritizationFactors(candidate) {
  if (!candidate) return { factors: [], rule: PRIORITY_RULE, note: 'no candidate was handed to this read, so no factor is claimed' };
  const list = [];
  factor(list, `the next action named is \`${candidate.action}\``, `the continuation rule's own ordering (${PRIORITY_RULE})`);
  factor(list, candidate.priority === null || candidate.priority === undefined
    ? 'no priority is recorded on it, so none was used'
    : `priority ${candidate.priority} is recorded on it, and 1 is the most urgent the records allow`,
  `${candidate.kind} ${shortId(candidate.ref)} priority field`);
  factor(list, candidate.deadline
    ? `a deadline of ${candidate.deadline} is recorded on it`
    : 'no deadline is recorded on it',
  `${candidate.kind} ${shortId(candidate.ref)} deadline field`);
  factor(list, candidate.risk ? `its recorded risk is \`${candidate.risk}\`` : 'no risk is recorded on it',
    candidate.kind === 'plan' ? `plan ${shortId(candidate.ref)} steps, as planRisk() reads them` : `${candidate.kind} ${shortId(candidate.ref)}`);
  for (const b of candidate.blockers ?? []) factor(list, `blocker: ${b}`, `${candidate.kind} ${shortId(candidate.ref)} record and the live check`);
  for (const caution of candidate.cautions ?? []) {
    factor(list, `a recorded expectation for ${caution.capability} was contradicted at ${caution.decidedAt ?? 'an unrecorded time'} and still stands on a fresh read`,
      `prediction ${shortId(caution.id)} evaluation ${shortId(caution.evaluationId ?? '')}`);
  }
  if (candidate.cautionChangedAction) {
    factor(list, 'a caution replaced the recommended start with a read; no approval, readiness state, or authorization changed',
      `prediction ${shortId(candidate.cautions?.[0]?.id ?? '')}, read by the caution rule`);
  }
  if (!candidate.ready) factor(list, 'the ranking marks it not ready, for the blocker named above', 'the continuation engine');
  if (candidate.requiresAuthorization) {
    factor(list, 'taking it up is your own act, and APEX will not take it for you', 'the authorization rule each action runs under');
  }
  return {
    factors: list,
    rule: PRIORITY_RULE,
    score: candidate.score ?? null,
    note: `the score ${candidate.score ?? '-'} orders this list under ${PRIORITY_RULE}. It is not a probability, an importance, or a permission.`,
  };
}

// The printed form: the state, the record it was read from, one line per factor, and the command that
// would take it up. Bounded like every other view in this layer, and says so when it cuts.
export function renderReadiness(reading, { indent = '', command = true } = {}) {
  if (!reading) return `${indent}No readiness reading was derived.`;
  const lines = [];
  if (reading.readiness) {
    lines.push(`${indent}Readiness: ${reading.readiness}.`);
    lines.push(`${indent}  read as: ${reading.basis}`);
  } else {
    lines.push(`${indent}Readiness: not stated - ${reading.basis}`);
  }
  const shown = reading.factors.slice(0, BOUNDS.maxListedRecords);
  for (const f of shown) lines.push(`${indent}  - ${truncate(f.factor, 200)} [from: ${truncate(f.readFrom, 160)}]`);
  if (reading.factors.length > shown.length) {
    lines.push(`${indent}  - ... and ${reading.factors.length - shown.length} more read from the same records`);
  }
  for (const caution of reading.expectationCautions ?? []) {
    lines.push(`${indent}  caution: ${truncate(cautionLine(caution), 200)}`);
  }
  if ((reading.expectationCautions ?? []).length > 0) lines.push(`${indent}  ${CAUTION_NOTE}`);
  if (reading.cautionRead?.unavailable) {
    lines.push(`${indent}  the expectation read did not complete: ${truncate(reading.cautionRead.unavailable, 200)}`);
  }
  if (command && reading.next) {
    const label = reading.nextIsRead
      ? (reading.noPlanRecord
        ? 'no plan record exists to take up, so what is named is the read'
        : 'what answers this state is a read, not an act on a record')
      : 'to take it up';
    lines.push(`${indent}  ${label}: ${reading.next}`);
  }
  lines.push(`${indent}  ${reading.rule ?? READINESS_RULE}`);
  return lines.join('\n');
}
