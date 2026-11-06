// Batch AL, work package E: evaluating the outcome of a plan as something other than "it ran".
//
// `src/plans/assessment.js` answers seven questions, each from a different record, and `plan.outcome`
// and `plan.assess` are the two actions that read and record that answer. Four separations carry the
// suite, and every one is asserted against the text a user reads:
//   1. A step that executed and verified is a fact about the audit log. It is not the same fact as the
//      step's expected output existing, nor as the condition the step named holding in the world, nor
//      as the goal's criterion being met.
//   2. A verdict is chosen by a disclosed precedence over the records and is one of six named states.
//      It is not a score, a probability, or a percentage, and it grants nothing.
//   3. Every finding cites operations this read actually found. An answer with nothing behind it is
//      reported as unrecordable rather than written, and the plan store refuses it independently too.
//   4. Recording changes no plan status, no approval, and no timestamp, and completes or reopens no
//      goal. The caller cannot supply a verdict: the write re-derives it.
//
// Everything runs through the real app: the live registry, the goal and plan stores, the task runner,
// the verifier and the audit log. Where a step must fail or go unverified, the labelled test doubles
// in tests/helpers.js report what they did; they are not evidence about a real action. Two further
// doubles are declared below and labelled at their definition, because the shipped writes they stand
// in for are not plannable. No model service is contacted; no inference is performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { PlanStatus } from '../src/plans/model.js';
import { GoalStatus } from '../src/goals/model.js';
import {
  ASSESSMENT_ASPECTS, MAX_ASSERTION_CHARS, MAX_ASSESSMENT_SUMMARY_CHARS, MAX_CITED_IDS, MAX_FINDINGS,
} from '../src/plans/model.js';
import {
  ASSESSMENT_NOTE, VERDICT_RULE, assessOutcome, renderAssessment,
} from '../src/plans/assessment.js';
import { renderPlan } from '../src/plans/format.js';
import { makeTempDataDir, cleanup, makeFakeTaskActions } from './helpers.js';

const stepData = (step) => step.result.data;

async function appIn(dir, extraActions = []) {
  return createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF, extraActions });
}

// The plan log as written: the action results do not carry an event's origin, and the suite has to be
// able to say who a record is attributed to.
const planEvents = (dir) => fs.readFileSync(path.join(dir, 'plans.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));

const eventCount = async (app) => (await app.plans.load()).events;

function memStep(id, dependsOn = [], criterion = null, tag = id) {
  return {
    id,
    description: `remember the ${tag} fact`,
    action: 'memory.add',
    input: { content: `the outcome assessment fact ${tag}` },
    dependsOn,
    expectedResult: `the ${tag} fact is stored`,
    verification: 'the stored record is read back and its content hash matches',
    criterion,
    risk: 'medium',
    estimateSeconds: 2,
  };
}

// Risk must be named on a write step (the plan store refuses a write step classified low), so doubles
// that stand in for a write take it from the caller.
function fakeStep(id, action, dependsOn = [], criterion = null, input = { tag: id }, risk = 'low') {
  return {
    id,
    description: `${action} step ${id}`,
    action,
    input,
    dependsOn,
    expectedResult: `the ${id} read is recorded`,
    verification: 'the sink holds the read',
    criterion,
    risk,
  };
}

// A goal in the state a plan can be approved against, with a plan approved but not yet started.
async function goalAndPlan(app, { criteria = ['the first fact is stored'], steps, outcome = 'the recorded facts are stored', goalId: given = null } = {}) {
  let goalId = given;
  if (!goalId) {
    const res = await app.controller.goalAdd({ request: 'the assessed goal', criteria });
    assert.equal(res.status, Outcome.GOAL_CREATED, res.output);
    goalId = res.operation.steps[0].result.data.goalId;
    for (const status of ['accepted', 'active']) {
      assert.equal((await app.controller.goalUpdate({ target: goalId, status })).status, Outcome.GOAL_UPDATED);
    }
  }
  const res = await app.controller.planAdd({ goalId, outcome, steps });
  assert.equal(res.status, Outcome.PLAN_STORED, res.output);
  const planId = res.operation.steps[0].result.data.planId;
  assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);
  return { goalId, planId };
}

async function runPlan(app, planId) {
  return app.controller.planActivate(planId, { mode: 'run' });
}

// TEST DOUBLE: a plan step that establishes a knowledge claim under the operation that wrote it. The
// shipped knowledge writes are user-origin and not plannable, so no real step can reach the claim
// lifecycle the durability question asks about; this double writes through the real knowledge store
// with the real operation id and is labelled here and in its description.
const claimDouble = [{
  name: 'test.claim',
  description: 'TEST DOUBLE: store one knowledge claim under the operation that wrote it',
  inputHint: '{"subject":"text"}',
  permission: 'write',
  origins: ['user'],
  validate(input) {
    return { subject: String(input?.subject ?? 'the gate') };
  },
  async execute(ctx, { subject }) {
    const { record } = await ctx.knowledge.add({
      subject,
      relationship: 'state',
      object: 'open',
      evidence: 'written by the labelled claim test double',
      provenance: { operationId: ctx.operationId },
      origin: ctx.origin,
    });
    return { summary: `claimed that ${subject} is open`, data: { id: record.id }, display: `claimed ${subject}` };
  },
  async verify(ctx, _input, result) {
    const rec = await ctx.knowledge.get(result.data.id);
    return rec ? { ok: true, detail: 'the claim is stored under this operation' } : { ok: false, detail: 'the claim is not stored' };
  },
}];

async function outcomeStep(app, planRef, origin = 'user') {
  return app.controller.runAction('plan.outcome', { plan: planRef }, origin, `outcome-${origin}`);
}

async function assessStep(app, planId, origin = 'user') {
  return app.controller.runAction('plan.assess', { target: planId }, origin, `assess-${origin}`);
}

const findingFor = (data, aspect) => data.findings.find((f) => f.aspect === aspect);

// A finding has to fit the bound the model's assertion field enforces. What a reader must never get is
// a sentence cut where the rest of the answer was, so the bound is asserted together with the rule that
// an overflow is counted instead of dropped.
function assertBounded(findings) {
  for (const f of findings) {
    assert.ok(f.statement.length > 0, `${f.aspect} answered with an empty statement`);
    assert.ok(f.statement.length <= MAX_ASSERTION_CHARS,
      `${f.aspect} statement is ${f.statement.length} chars, over the ${MAX_ASSERTION_CHARS} bound: ${f.statement}`);
    assert.ok(f.operations.length > 0, `${f.aspect} cites no operation`);
    assert.ok(f.operations.length <= MAX_CITED_IDS, `${f.aspect} cites more operations than the bound allows`);
  }
}

test('plan.outcome answers all seven questions from records and records nothing itself', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId, planId } = await goalAndPlan(app, {
      criteria: ['the first fact is stored', 'the second fact is stored'],
      steps: [memStep('s1', [], 'c1', 'a'), memStep('s2', ['s1'], 'c2', 'b')],
    });
    assert.equal((await runPlan(app, planId)).status, Outcome.SUCCESS_VERIFIED);

    const before = await app.plans.get(planId);
    const eventsBefore = await eventCount(app);
    const step = await outcomeStep(app, planId);
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
    const data = stepData(step);

    assert.equal(data.assessed, true);
    assert.equal(data.recorded, false);
    assert.equal(data.authorizes, false);
    assert.deepEqual(data.progress, { total: 2, completed: 2, failed: 0, uncertain: 0, skipped: 0, pending: 0 });
    assert.equal(data.verdictRule, VERDICT_RULE);
    assert.equal(data.note, ASSESSMENT_NOTE);
    assert.deepEqual(data.auditReads.map((r) => r.state), ['present', 'present']);

    // Each of the seven questions is answered, and by a finding that cites operations.
    assert.deepEqual(data.aspects.map((a) => a.aspect), [...ASSESSMENT_ASPECTS]);
    for (const a of data.aspects) assert.equal(a.answered, true, `${a.aspect} was not answered`);
    assert.equal(data.findings.length, MAX_FINDINGS);
    assert.deepEqual(data.dropped, []);
    assertBounded(data.findings);
    const citedOps = [...new Set(data.findings.flatMap((f) => f.operations))].sort();
    assert.deepEqual(citedOps, Object.values(before.stepResults).map((r) => r.operationId).sort());

    // Execution success is not goal success: the steps all verified, and the criteria are still open.
    assert.equal(data.verdict, 'awaiting_confirmation');
    assert.match(data.basis, /c1 \(pending\), c2 \(pending\) of goal \w{8} is required and not satisfied/);
    assert.match(findingFor(data, 'goal_criteria').statement, /still open and required: c1, c2/);
    assert.match(findingFor(data, 'goal_criteria').statement, /c1 pending \(no evidence recorded\)/);
    assert.match(findingFor(data, 'step_completion').statement, /2 of 2 step\(s\) recorded completed; 2 completed \(s1, s2\)/);
    // A verifier verdict is about the action's own return, and the answer says so.
    assert.match(findingFor(data, 'verification').statement, /2 success_verified/);
    assert.match(findingFor(data, 'verification').statement, /which this verdict does not test/);
    // So is "the expected output exists": it is about the step's own record, not about the world.
    assert.match(findingFor(data, 'expected_output').statement, /2 of 2 step\(s\) have a result payload and a non-empty output in their own record/);
    assert.match(findingFor(data, 'expected_output').statement, /a question for the world, not this log/);
    // What the plan wrote is followed where it can be, and its limit is stated where it cannot.
    assert.match(findingFor(data, 'durability').statement, /s1, s2 wrote memory record\(s\).*that still read back by id/);
    assert.match(findingFor(data, 'durability').statement, /the memory store keeps no index by operation, so a later correction is not visible here/);
    assert.match(findingFor(data, 'external_confirmation').statement, /whether the intended outcome holds outside APEX's records: the recorded facts are stored/);
    assert.match(findingFor(data, 'external_confirmation').statement, /whether a memory record this plan wrote still says what you mean/);

    // The read wrote nothing anywhere.
    assert.equal(await eventCount(app), eventsBefore, 'a read appended to the plan log');
    const after = await app.plans.get(planId);
    assert.equal(after.status, PlanStatus.COMPLETED);
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal((await app.goals.get(goalId)).status, GoalStatus.ACTIVE);
    assert.equal((await app.plans.assessments(planId)).length, 0);
    assert.match(step.display, /This read recorded nothing/);
    assert.equal(step.verification.outcome, Outcome.SUCCESS_VERIFIED, step.verification.detail);
    assert.match(step.verification.detail, /nothing was recorded/);
  } finally {
    cleanup(dir);
  }
});

test('plan.outcome on a plan that never ran says there is no outcome, without inventing one', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { planId } = await goalAndPlan(app, { steps: [memStep('s1')] });
    const eventsBefore = await eventCount(app);
    const step = await outcomeStep(app, planId);
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
    const data = stepData(step);
    assert.equal(data.assessed, false);
    assert.match(data.reason, /has not been started, so there is no execution outcome to assess/);
    assert.equal(data.recordable, false);
    assert.equal(data.recorded, false);
    // Nothing is invented: with no outcome to read back the answer carries no verdict, no findings and
    // no seven answered questions, only the reason and the plan snapshot the reason is stated against.
    assert.equal(data.verdict, undefined);
    assert.equal(data.basis, undefined);
    assert.equal(data.summary, undefined);
    assert.equal(data.findings, undefined);
    assert.equal(data.aspects, undefined);
    assert.equal(data.dropped, undefined);
    assert.deepEqual(data.priorAssessments, []);
    assert.equal(data.planSnapshot.status, PlanStatus.APPROVED);
    assert.match(step.display, /This plan's outcome cannot be assessed/);
    assert.match(step.display, /Recording an assessment is plan\.assess, and it needs an outcome to assess/);

    const refused = await assessStep(app, planId);
    assert.equal(refused.outcome, Outcome.EXECUTION_FAILED, refused.summary);
    assert.match(refused.summary, /has no execution outcome to assess/);
    assert.equal(await eventCount(app), eventsBefore, 'the read or the refused write moved the plan log');
    assert.equal((await app.plans.get(planId)).status, PlanStatus.APPROVED);
  } finally {
    cleanup(dir);
  }
});

test('plan.assess records the derived verdict and touches no status, approval, or timestamp', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId, planId } = await goalAndPlan(app, {
      criteria: ['the first fact is stored'],
      steps: [memStep('s1', [], 'c1', 'a')],
    });
    await runPlan(app, planId);
    const before = await app.plans.get(planId);
    const derived = stepData(await outcomeStep(app, planId));

    const step = await assessStep(app, planId);
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
    const data = stepData(step);
    assert.equal(data.verdict, derived.verdict, 'the recorded verdict differs from the derived one');
    assert.equal(data.summary, derived.summary);
    assert.deepEqual(data.findings, derived.findings);
    assert.equal(data.after.contentHash, data.before.contentHash);
    assert.equal(data.after.updatedAt, data.before.updatedAt);
    assert.equal(data.after.status, data.before.status);
    assert.equal(data.beforeApproval, data.afterApproval);
    assert.equal(data.afterApproval, `${before.approval.version}:${before.approval.contentHash}`);

    const events = planEvents(dir).filter((e) => e.type === 'plan_assessment');
    assert.equal(events.length, 1);
    assert.equal(events[0].origin, 'user', 'an assessment is not recorded as a user act');
    assert.equal(events[0].verdict, derived.verdict);
    assert.equal(events[0].planVersion, before.version);
    assert.equal(events[0].contentHash, derived.planSnapshot.contentHash);
    assert.equal(events[0].findings.length, MAX_FINDINGS);

    const list = await app.plans.assessments(planId);
    assert.equal(list.length, 1);
    assert.equal(list[0].stale, false);
    assert.equal(list[0].findings.length, MAX_FINDINGS);
    for (const f of list[0].findings) assert.ok(f.operations.length > 0);

    const after = await app.plans.get(planId);
    assert.equal(after.status, PlanStatus.COMPLETED, 'recording an assessment changed the plan status');
    assert.equal(after.updatedAt, before.updatedAt, 'recording an assessment moved the plan timestamp');
    assert.equal(after.approval.contentHash, before.approval.contentHash);
    assert.equal((await app.goals.get(goalId)).status, GoalStatus.ACTIVE, 'an assessment completed the goal');

    // The plan's own rendering now separates its status from the recorded reading of its outcome.
    const shown = renderPlan(after);
    assert.match(shown, /Outcome assessments: 1 recorded/);
    assert.match(shown, /awaiting_confirmation \(v1\)/);
    assert.match(shown, /goal_criteria: /);
    assert.equal(step.verification.outcome, Outcome.SUCCESS_VERIFIED, step.verification.detail);
    assert.match(step.verification.detail, /bound to its content hash/);
    assert.match(step.verification.detail, /approval and timestamp unchanged/);

    // Reading again shows what is recorded, and still records nothing itself.
    const second = await outcomeStep(app, planId);
    assert.equal(planEvents(dir).filter((e) => e.type === 'plan_assessment').length, 1, 'a read recorded an assessment');
    assert.equal(stepData(second).priorAssessments.length, 1);
    assert.equal(stepData(second).priorAssessments[0].findings, MAX_FINDINGS);
    assert.match(second.display, /Already recorded against this plan/);
  } finally {
    cleanup(dir);
  }
});

test('criteria satisfied on evidence that stands read as successful; the goal is still the user\'s to complete', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId, planId } = await goalAndPlan(app, {
      criteria: ['the first fact is stored', 'the second fact is stored'],
      steps: [memStep('s1', [], 'c1', 'a'), memStep('s2', ['s1'], 'c2', 'b')],
    });
    await runPlan(app, planId);
    const plan = await app.plans.get(planId);
    for (const [stepId, criterion] of [['s1', 'c1'], ['s2', 'c2']]) {
      const res = await app.controller.goalEvidence({
        target: goalId,
        criterion,
        kind: 'supports',
        operationId: plan.stepResults[stepId].operationId,
        detail: `the ${stepId} step verified`,
      });
      assert.equal(res.status, Outcome.GOAL_UPDATED, res.output);
    }

    // The read puts the basis in words; the write records the same reading and re-derives it, so both
    // have to be asserted and neither can be allowed to state success more strongly than the other.
    const read = stepData(await outcomeStep(app, planId));
    assert.equal(read.verdict, 'successful');
    assert.match(read.basis, /every required criterion of goal \w{8} is satisfied on evidence that still stands/);
    assert.match(findingFor(read, 'external_confirmation').statement, /outside APEX's records/);

    const step = await assessStep(app, planId);
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
    const data = stepData(step);
    assert.equal(data.verdict, 'successful');
    assert.equal(data.verdict, read.verdict);
    assert.equal(data.summary, read.summary);
    assert.deepEqual(data.findings, read.findings);
    assert.match(findingFor(data, 'goal_criteria').statement, /c1 satisfied \(evidence stands\)/);
    assert.match(findingFor(data, 'goal_criteria').statement, /c2 satisfied \(evidence stands\)/);
    // Even here the answer keeps the two facts apart: the record is stored, the world is not checked.
    assert.match(findingFor(data, 'external_confirmation').statement, /whether the intended outcome holds outside APEX's records/);
    assertBounded(data.findings);
    // The goal keeps its own lifecycle: a successful outcome reading does not complete it.
    assert.equal((await app.goals.get(goalId)).status, GoalStatus.ACTIVE);
    assert.equal((await app.plans.get(planId)).status, PlanStatus.COMPLETED);
  } finally {
    cleanup(dir);
  }
});

test('a failed step gives a failed verdict that names the step, not a completed plan', async () => {
  const dir = makeTempDataDir();
  try {
    const sink = [];
    const app = await appIn(dir, makeFakeTaskActions(sink));
    const { planId } = await goalAndPlan(app, {
      criteria: ['the read is recorded'],
      steps: [fakeStep('s1', 'test.ok', [], 'c1'), fakeStep('s2', 'test.fail', ['s1'])],
    });
    const run = await runPlan(app, planId);
    await app.controller.planReconcile(planId);
    assert.equal(run.status, Outcome.EXECUTION_FAILED, run.display);

    const step = await outcomeStep(app, planId);
    const data = stepData(step);
    assert.equal(data.verdict, 'failed');
    assert.match(data.basis, /1 step\(s\) recorded a failed outcome/);
    assert.match(findingFor(data, 'step_completion').statement, /1 completed \(s1\); 1 failed \(s2\)/);
    assert.match(findingFor(data, 'evidence_state').statement, /not a verified success: s2 as execution_failed/);
    assert.match(findingFor(data, 'expected_output').statement, /s2 do not/);
    // A step that failed is reported as a step that failed, whatever the plan's status says.
    assert.equal(data.planSnapshot.status, PlanStatus.BLOCKED);
    assertBounded(data.findings);

    const recorded = await assessStep(app, planId);
    assert.equal(recorded.outcome, Outcome.SUCCESS_VERIFIED, recorded.summary);
    assert.equal(stepData(recorded).verdict, 'failed');
    assert.equal((await app.plans.get(planId)).status, PlanStatus.BLOCKED, 'recording a failed outcome changed the plan status');
  } finally {
    cleanup(dir);
  }
});

test('a step whose verification was unavailable is uncertain, and says what is unknown', async () => {
  const dir = makeTempDataDir();
  try {
    const sink = [];
    const app = await appIn(dir, makeFakeTaskActions(sink));
    const { planId } = await goalAndPlan(app, {
      criteria: ['the read is recorded'],
      steps: [fakeStep('s1', 'test.unverified', [], 'c1')],
    });
    await runPlan(app, planId);
    await app.controller.planReconcile(planId);

    const data = stepData(await outcomeStep(app, planId));
    assert.equal(data.verdict, 'uncertain');
    assert.match(data.basis, /s1 recorded an uncertain outcome/);
    assert.match(findingFor(data, 'verification').statement, /1 verification_unavailable/);
    assert.match(findingFor(data, 'evidence_state').statement, /s1 as verification_unavailable/);
    // Uncertain is not failed: the records do not say the step went wrong, only that nothing checked it.
    assert.doesNotMatch(JSON.stringify(data.findings), /recorded a failed outcome/);
    assertBounded(data.findings);
  } finally {
    cleanup(dir);
  }
});

test('a plan that was activated but never run has no evidence to cite, so nothing is written', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { planId } = await goalAndPlan(app, { steps: [memStep('s1'), memStep('s2', ['s1'])] });
    // The activation is recorded before the run starts, and a resume against a pending task is refused,
    // which leaves the real state the reader has to be told about: started, and nothing executed.
    const refusedRun = await app.controller.planActivate(planId, { mode: 'resume' });
    assert.equal(refusedRun.status, Outcome.INPUT_REJECTED, refusedRun.output);
    const plan = await app.plans.get(planId);
    assert.equal(plan.status, PlanStatus.ACTIVE);
    assert.ok(plan.activation, 'the plan record shows no activation');
    assert.deepEqual(plan.stepResults, {});

    const data = stepData(await outcomeStep(app, planId));
    assert.equal(data.verdict, 'blocked');
    assert.equal(data.basis, 'no step produced a completed outcome');
    assert.equal(data.recordable, false);
    assert.match(data.unrecordableReason, /no finding rests on an operation this read found in the audit log/);
    // The read still answers every question, and says of each one that it rests on nothing found.
    assert.equal(data.findings.length, 0);
    assert.equal(data.dropped.length, MAX_FINDINGS);
    for (const d of data.dropped) {
      assert.equal(d.reason, 'its answer rests on no operation that this read found in the audit log');
    }
    for (const a of data.aspects) assert.equal(a.answered, false);

    const write = await assessStep(app, planId);
    assert.equal(write.outcome, Outcome.EXECUTION_FAILED, write.summary);
    assert.match(write.summary, /the derived assessment cannot be recorded/);
    assert.equal((await app.plans.assessments(planId)).length, 0, 'an unevidenced assessment was written');

    // Cancelling gives the same verdict a reason the plan record itself states.
    assert.equal((await app.controller.planCancel({ target: planId, reason: 'not needed' })).status, Outcome.PLAN_STORED);
    const cancelled = stepData(await outcomeStep(app, planId));
    assert.equal(cancelled.verdict, 'blocked');
    assert.match(cancelled.basis, /the plan record states why: cancelled: not needed/);
  } finally {
    cleanup(dir);
  }
});

test('a blocked plan whose criterion rests on a sibling plan\'s evidence is recordable', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId, planId: first } = await goalAndPlan(app, {
      criteria: ['the first fact is stored', 'the second fact is stored'],
      steps: [memStep('s1', [], 'c1', 'a'), memStep('s2', ['s1'], 'c2', 'b')],
    });
    await runPlan(app, first);
    const ran = await app.plans.get(first);
    const evidence = await app.controller.goalEvidence({
      target: goalId,
      criterion: 'c1',
      kind: 'supports',
      operationId: ran.stepResults.s1.operationId,
      detail: 'the sibling plan step verified',
    });
    assert.equal(evidence.status, Outcome.GOAL_UPDATED, evidence.output);

    const { planId: second } = await goalAndPlan(app, {
      goalId,
      outcome: 'the second attempt stores nothing yet',
      steps: [memStep('s1', [], 'c1', 'a')],
    });
    await app.controller.planActivate(second, { mode: 'resume' });
    const data = stepData(await outcomeStep(app, second));
    assert.equal(data.verdict, 'blocked');
    assert.equal(data.recordable, true);
    // Only the criterion's own evidence is a record this read found, and only that finding cites it.
    assert.equal(data.findings.length, 1);
    assert.equal(data.findings[0].aspect, 'goal_criteria');
    assert.deepEqual(data.findings[0].operations, [ran.stepResults.s1.operationId]);
    assert.match(data.findings[0].statement, /still open and required: c2/);
    assert.match(data.findings[0].statement, /c1 satisfied \(evidence stands\)/);

    const write = await assessStep(app, second);
    assert.equal(write.outcome, Outcome.SUCCESS_VERIFIED, write.summary);
    assert.equal(stepData(write).verdict, 'blocked');
    assert.match(write.verification.detail, /1 finding\(s\), each citing an operation in the audit log/);
    // A blocked outcome reading closes nothing: the plan is still active and the goal still open.
    assert.equal((await app.plans.get(second)).status, PlanStatus.ACTIVE);
    assert.equal((await app.goals.get(goalId)).status, GoalStatus.ACTIVE);
  } finally {
    cleanup(dir);
  }
});

test('a run that stopped partway is partial, with the unfinished steps named', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId, planId } = await goalAndPlan(app, {
      criteria: ['the first fact is stored'],
      steps: [memStep('s1', [], 'c1', 'a'), memStep('s2', ['s1'], 'c1', 'b')],
    });
    await runPlan(app, planId);
    const plan = await app.plans.get(planId);
    // The shipped user-origin runner finishes every step it starts in one process, so this state is not
    // reachable from it here: it is the state a process that died between the two steps leaves. The real
    // cross-process interruption is exercised in the AL acceptance scenarios, not by this fixture.
    assert.equal(Object.keys(plan.stepResults).length, 2, 'the runner already leaves a step without an outcome');

    const interrupted = JSON.parse(JSON.stringify(plan));
    delete interrupted.stepResults.s2;
    interrupted.status = PlanStatus.ACTIVE;
    const assessment = await assessOutcome(interrupted, {
      goal: await app.goals.get(goalId),
      operations: app.operations,
      knowledge: app.knowledge,
      memory: app.memory,
    });
    assert.equal(assessment.verdict, 'partial');
    assert.equal(assessment.basis, '1 of 2 step(s) completed, s2 with no recorded outcome');
    assert.deepEqual(assessment.progress, { total: 2, completed: 1, failed: 0, uncertain: 0, skipped: 0, pending: 1 });
    assert.equal(assessment.recordable, true);
    assert.match(assessment.findings.find((f) => f.aspect === 'step_completion').statement, /1 completed \(s1\); 1 with no recorded outcome \(s2\)/);
    // The step that never ran cites no operation, and its absence is stated rather than counted as done.
    assert.deepEqual(assessment.findings.find((f) => f.aspect === 'evidence_state').operations, [plan.stepResults.s1.operationId]);
    assertBounded(assessment.findings);
  } finally {
    cleanup(dir);
  }
});

test('a plan with no goal is awaiting confirmation and says the intention is the user\'s to settle', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const res = await app.controller.planAdd({ outcome: 'a probe fact is stored', steps: [memStep('s1', [], null, 'z')] });
    assert.equal(res.status, Outcome.PLAN_STORED, res.output);
    const planId = res.operation.steps[0].result.data.planId;
    assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);
    await runPlan(app, planId);

    const data = stepData(await outcomeStep(app, planId));
    assert.equal(data.verdict, 'awaiting_confirmation');
    assert.equal(data.goalId, null);
    assert.match(findingFor(data, 'goal_criteria').statement, /the plan records no goal, so no criterion is settled by it/);
    assert.match(data.basis, /whether the intention was met is the user's to say/);
    // Every step verified, and the reading still refuses to call that success.
    assert.match(findingFor(data, 'verification').statement, /1 success_verified/);
    assert.match(findingFor(data, 'durability').statement, /the memory store keeps no index by operation/);
    // The recordable verdict's own question has to be answered, and here it is.
    assert.equal(data.recordable, true);
    assertBounded(data.findings);
  } finally {
    cleanup(dir);
  }
});

test('the caller cannot supply a verdict: plan.assess takes a plan id and nothing else', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { planId } = await goalAndPlan(app, { steps: [memStep('s1', [], 'c1', 'a')] });
    await runPlan(app, planId);

    for (const input of [
      { target: planId, verdict: 'successful' },
      { target: planId, findings: [{ aspect: 'verification', statement: 'all good', operations: ['a'.repeat(36)] }] },
      { target: planId, summary: 'the user says it worked' },
      { target: 42 },
      {},
    ]) {
      const step = await app.controller.runAction('plan.assess', input, 'user', 'forged-assess');
      assert.equal(step.outcome, Outcome.INPUT_REJECTED, `${JSON.stringify(input)} was not refused as input`);
    }
    const forged = await app.controller.runAction('plan.assess', { target: planId, verdict: 'successful' }, 'user', 'forged-verdict');
    assert.match(forged.summary, /unexpected input field "verdict"/);
    assert.equal(planEvents(dir).filter((e) => e.type === 'plan_assessment').length, 0);

    // The plan store refuses independently: a finding citing an operation that is not in the audit
    // log cannot be written, however the caller obtained it.
    const plan = await app.plans.get(planId);
    await assert.rejects(
      () => app.plans.assessPlan(planId, {
        verdict: 'successful',
        summary: 'a claimed success with a citation that does not exist',
        findings: [{
          aspect: 'verification',
          statement: 'the steps verified',
          operations: [`${plan.id.slice(0, 8)}ffffffffffffffffffffffffffffffff`],
        }],
      }),
      (err) => err.code === 'EVIDENCE_NOT_VERIFIED' && /is not in the audit log, so a finding cannot cite it/.test(err.message),
    );
    assert.equal((await app.plans.assessments(planId)).length, 0);
  } finally {
    cleanup(dir);
  }
});

test('a model may read an outcome but cannot record an assessment', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { planId } = await goalAndPlan(app, { steps: [memStep('s1', [], 'c1', 'a')] });
    await runPlan(app, planId);
    const before = await app.plans.get(planId);

    assert.deepEqual(app.registry.authorize('plan.assess', 'model'), { decision: 'deny', reason: 'ORIGIN_NOT_PERMITTED' });
    assert.deepEqual(app.registry.authorize('plan.outcome', 'model'), { decision: 'allow', reason: 'PERMITTED' });

    const denied = await assessStep(app, planId, 'model');
    assert.equal(denied.outcome, Outcome.ACTION_DENIED, denied.summary);
    assert.equal(planEvents(dir).filter((e) => e.type === 'plan_assessment').length, 0, 'a model recorded an assessment');
    assert.equal((await app.plans.get(planId)).updatedAt, before.updatedAt);

    // A model-origin read answers the questions from the same records and writes nothing.
    const read = await outcomeStep(app, planId, 'model');
    assert.equal(read.outcome, Outcome.SUCCESS_VERIFIED, read.summary);
    const data = stepData(read);
    assert.equal(data.verdict, 'awaiting_confirmation');
    assert.equal(data.recorded, false);
    assert.equal(data.authorizes, false);
    assert.equal(planEvents(dir).filter((e) => e.type === 'plan_assessment').length, 0);

    // The write is not offered as a step a model could put in a plan...
    assert.equal(app.registry.get('plan.assess').plannable, false, 'an assessment write could be planned');
    assert.equal(app.registry.get('plan.assess').permission, 'write');
    // ...while the read stays a read, which authorizes nothing.
    assert.equal(app.registry.get('plan.outcome').permission, 'read');
    assert.deepEqual([...app.registry.get('plan.outcome').origins].sort(), ['model', 'user']);
  } finally {
    cleanup(dir);
  }
});

test('durability follows a knowledge claim: current while it stands, withdrawn after a retraction', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir, claimDouble);
    const { planId } = await goalAndPlan(app, {
      criteria: ['the gate state is recorded'],
      steps: [fakeStep('s1', 'test.claim', [], 'c1', { subject: 'the north gate' }, 'medium')],
    });
    assert.equal((await runPlan(app, planId)).status, Outcome.SUCCESS_VERIFIED);
    const plan = await app.plans.get(planId);
    const audited = await app.operations.findById(plan.stepResults.s1.operationId);
    assert.equal(audited.found, true, 'the step operation is not in the audit log');
    const claimId = audited.record.steps[0].result.data.id;
    assert.ok(claimId, 'the labelled double stored no claim');

    const first = stepData(await outcomeStep(app, planId));
    assert.match(findingFor(first, 'durability').statement, /1 claim\(s\) it established are still current/);
    assert.deepEqual(findingFor(first, 'durability').records, [claimId]);
    // A memory read-back and a claim lifecycle are different answers; this step gets the stronger one.
    assert.doesNotMatch(findingFor(first, 'durability').statement, /memory record\(s\)/);

    const retracted = await app.controller.runAction('knowledge.retract', { target: claimId, reason: 'the gate was found shut' }, 'user', 'retract-claim');
    assert.equal(retracted.outcome, Outcome.SUCCESS_VERIFIED, retracted.summary);

    const second = stepData(await outcomeStep(app, planId));
    assert.match(findingFor(second, 'durability').statement, /withdrawn since written/);
    assert.match(findingFor(second, 'durability').statement, /retracted/);
    assert.deepEqual(findingFor(second, 'durability').records, [claimId]);
    // The verdict precedence is untouched by this: the steps still completed and verified, so the
    // outcome stays where the goal criteria put it, and the withdrawal is reported, not scored.
    assert.equal(second.verdict, first.verdict);
    assert.notEqual(findingFor(first, 'durability').statement, findingFor(second, 'durability').statement);
  } finally {
    cleanup(dir);
  }
});

test('an assessment stays readable after a revision and is marked stale against the new content', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir, makeFakeTaskActions([]));
    const { planId } = await goalAndPlan(app, {
      criteria: ['the read is recorded'],
      steps: [fakeStep('s1', 'test.fail', [], 'c1')],
    });
    await runPlan(app, planId);
    const recorded = await assessStep(app, planId);
    assert.equal(recorded.outcome, Outcome.SUCCESS_VERIFIED, recorded.summary);
    assert.equal(stepData(recorded).verdict, 'failed');
    const v1 = await app.plans.get(planId);
    assert.equal(v1.assessments.length, 1);

    const revised = await app.controller.planRevise({
      target: planId,
      outcome: 'the retried read is recorded',
      steps: [fakeStep('s1', 'test.ok', [], 'c1')],
      reason: 'the first attempt failed',
    });
    assert.equal(revised.status, Outcome.PLAN_STORED, revised.output);
    const v2 = await app.plans.get(planId);
    assert.equal(v2.version, 2);
    assert.equal(v2.status, PlanStatus.DRAFT);
    assert.deepEqual(v2.stepResults, {}, 'a revision kept the old run\'s outcomes as if they were the new ones');

    // The old conclusion is not erased and not re-approved: it becomes a statement about older content.
    const list = await app.plans.assessments(planId);
    assert.equal(list.length, 1, 'a revision erased the earlier reading');
    assert.equal(list[0].planVersion, 1);
    assert.equal(list[0].verdict, 'failed');
    assert.equal(list[0].stale, true, 'an assessment of v1 reads as current against v2');
    assert.equal(list[0].currentVersion, 2);
    assert.match(renderPlan(v2), /failed \(v1, stale: the plan content has since changed\)/);

    // The new version has no recorded step outcomes, so there is nothing to derive from and the write
    // refuses rather than recording a reading with no evidence behind it.
    const refused = await assessStep(app, planId);
    assert.equal(refused.outcome, Outcome.EXECUTION_FAILED, refused.summary);
    assert.match(refused.summary, /no execution outcome to assess/);
    assert.equal((await app.plans.assessments(planId)).length, 1);
  } finally {
    cleanup(dir);
  }
});

test('an outcome whose audit record has gone is reported as unrecordable, not written', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { planId } = await goalAndPlan(app, { steps: [memStep('s1', [], 'c1', 'a')] });
    await runPlan(app, planId);
    const opsFile = path.join(dir, 'operations.jsonl');
    const plan = await app.plans.get(planId);
    const cited = plan.stepResults.s1.operationId;
    const lines = fs.readFileSync(opsFile, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    const kept = lines.filter((l) => !l.includes(cited));
    assert.equal(kept.length, lines.length - 1, 'the step operation record was not found in the audit log');
    fs.writeFileSync(opsFile, `${kept.join('\n')}\n`);

    const step = await outcomeStep(app, planId);
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
    const data = stepData(step);
    // A step whose own record is gone is not a failure and not a success: it is unknown.
    assert.equal(data.verdict, 'uncertain');
    assert.match(data.basis, /s1 name\(s\) an operation that is not in the audit log/);
    // And the absence is stated where it can be, then costs every finding its citation.
    assert.equal(data.auditReads.length, 1);
    assert.equal(data.auditReads[0].operationId, cited);
    assert.equal(data.auditReads[0].state, 'absent');
    assert.match(data.auditReads[0].detail, /not in the log after \d+ line\(s\)/);
    assert.equal(data.findings.length, 0);
    assert.equal(data.dropped.length, MAX_FINDINGS);
    assert.equal(data.recordable, false);

    const refused = await assessStep(app, planId);
    assert.equal(refused.outcome, Outcome.EXECUTION_FAILED, refused.summary);
    assert.match(refused.summary, /the derived assessment cannot be recorded/);
    assert.equal(planEvents(dir).filter((e) => e.type === 'plan_assessment').length, 0);
  } finally {
    cleanup(dir);
  }
});

test('a full-width plan keeps every answer inside its bound and counts what it omits', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const steps = [];
    for (let i = 1; i <= 8; i += 1) steps.push(memStep(`s${i}`, i === 1 ? [] : [`s${i - 1}`], `c${i}`, `f${i}`));
    const { planId } = await goalAndPlan(app, {
      criteria: Array.from({ length: 8 }, (_, i) => `fact ${i + 1} is stored and readable`),
      steps,
      outcome: 'every one of the eight facts is stored exactly once in the memory store and each of them still states what the user meant when they read it back to them',
    });
    assert.equal((await runPlan(app, planId)).status, Outcome.SUCCESS_VERIFIED);

    const data = stepData(await outcomeStep(app, planId));
    assert.equal(data.findings.length, MAX_FINDINGS);
    assertBounded(data.findings);
    for (const f of data.findings) {
      // A statement cut at the bound says so, instead of leaving a reader with half a sentence.
      assert.ok(!f.statement.endsWith('...'), `${f.aspect} is cut mid-clause with no count of what is missing`);
    }
    assert.equal(data.summary.length <= MAX_ASSESSMENT_SUMMARY_CHARS, true, `summary is ${data.summary.length} chars`);
    assert.match(findingFor(data, 'goal_criteria').statement, /c1, c2, c3 \+5 more/);
    assert.match(findingFor(data, 'goal_criteria').statement, /7 further item\(s\) not listed here/);
    assert.match(findingFor(data, 'durability').statement, /s1, s2 \+6 more wrote memory record\(s\)/);
    assert.match(findingFor(data, 'durability').statement, /a later correction is not visible here/);
    assert.match(findingFor(data, 'external_confirmation').statement, /^whether the intended outcome holds outside APEX's records/);

    const write = await assessStep(app, planId);
    assert.equal(write.outcome, Outcome.SUCCESS_VERIFIED, write.summary);
    assert.equal(stepData(write).findings.length, MAX_FINDINGS);
  } finally {
    cleanup(dir);
  }
});

test('the derivation module and the read action agree, and both say what an assessment is not', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { planId } = await goalAndPlan(app, { steps: [memStep('s1', [], 'c1', 'a')] });
    await runPlan(app, planId);
    const plan = await app.plans.get(planId);
    const goal = await app.goals.get(plan.goalId);
    const direct = await assessOutcome(plan, {
      goal, operations: app.operations, knowledge: app.knowledge, memory: app.memory,
    });
    const data = stepData(await outcomeStep(app, planId));
    assert.equal(data.verdict, direct.verdict);
    assert.equal(data.summary, direct.summary);
    assert.equal(direct.summary.length <= MAX_ASSESSMENT_SUMMARY_CHARS, true);
    assert.deepEqual(data.findings, direct.findings.map((f) => ({
      aspect: f.aspect,
      statement: f.statement,
      operations: [...f.operations],
      ...((f.records ?? []).length ? { records: [...f.records] } : {}),
    })));

    const shown = renderAssessment(direct);
    assert.match(shown, /Outcome assessment for plan/);
    // The basis is prose with punctuation in it, so it is compared as the exact line it is shown on.
    assert.ok(shown.includes(`verdict: ${direct.verdict} - ${direct.basis}`), shown);
    assert.ok(shown.includes(`rule: ${VERDICT_RULE}`), shown);
    assert.match(shown, /not a real-world confirmation, not a score or probability, and it authorizes nothing/);
    assert.match(shown, /Recording it is `plan\.assess`, a user act/);
    assert.match(renderAssessment({ ok: false, reason: 'nothing ran' }), /cannot be assessed: nothing ran/);

    // The seven questions are the ones a reader is shown, in the words the reader is shown them in.
    for (const a of direct.aspects) assert.ok(a.question.length > 0, `${a.aspect} has no question text`);
  } finally {
    cleanup(dir);
  }
});

test('a second assessment of the same version is refused as a duplicate rather than silently replaced', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { planId } = await goalAndPlan(app, { steps: [memStep('s1', [], 'c1', 'a')] });
    await runPlan(app, planId);
    const first = await assessStep(app, planId);
    assert.equal(first.outcome, Outcome.SUCCESS_VERIFIED, first.summary);
    const at = stepData(first).assessments[0].at;

    // Nothing about the records moved, so the same reading of the same version is the same assessment.
    const again = await assessStep(app, planId);
    assert.equal(again.outcome, Outcome.EXECUTION_FAILED, again.summary);
    assert.match(again.summary, /that assessment of version 1 is already recorded at/);
    assert.ok(again.summary.includes(at), again.summary);
    const list = await app.plans.assessments(planId);
    assert.equal(list.length, 1);
    assert.equal(list[0].verdict, 'awaiting_confirmation');
    assert.equal((await app.plans.get(planId)).status, PlanStatus.COMPLETED);
    assert.equal(planEvents(dir).filter((e) => e.type === 'plan_assessment').length, 1, 'a refused duplicate was appended');
  } finally {
    cleanup(dir);
  }
});
