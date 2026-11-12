// Batch AP-04: from an approved adaptation to what followed it, and no further.
//
// The claim under test is narrow on purpose: a recorded decision can be traced to the plan it was
// recorded with, that plan to its execution and verification, and that execution to whatever outcome
// evidence still stands. Each step is a separate fact, and the suite exists to prove APEX never lets
// one stand in for the next: approval is not application, application is not success, successful
// execution is not a real-world result, and a correlated record is not a cause.
//
// Everything here runs through the assembled application, the real plan/experience/goal/audit stores
// and their write locks, the action registry and its independent verifiers. The only fixtures are
// NoBackend (the existing deterministic gateway) and a fixed clock. No model is contacted, no
// inference runs, and no synthetic record is presented as a prediction or as outside evidence.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { StoreError } from '../src/errors.js';
import {
  EFFECTIVENESS_SCHEMA,
  EFFECTIVENESS_OUTCOMES,
  EFFECTIVENESS_STATES,
  renderEffectiveness,
} from '../src/plans/effectiveness.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
const dir = () => { const d = makeTempDataDir(); dirs.push(d); return d; };

function clock(start = '2026-11-05T09:00:00.000Z') {
  let ms = Date.parse(start);
  const now = () => new Date(ms);
  now.advance = (days) => { ms += days * 86_400_000; };
  now.iso = () => new Date(ms).toISOString();
  return now;
}

const appIn = (dataDir, now = clock()) => createApp({
  dataDir,
  now,
  gateway: new ModelGateway({ backend: new NoBackend() }),
  experienceCapture: CAPTURE_OFF,
});

const data = (res) => res?.operation?.steps?.[0]?.result?.data ?? res?.result?.data ?? {};
const display = (res) => String(res?.display ?? res?.result?.display ?? res?.output ?? '');
const json = (value) => JSON.parse(JSON.stringify(value ?? null));

const GUIDANCE = 'read the list before adding to it';

// ---- fixtures built from the user's own records ------------------------------------------------

// Two corrected writes derive one candidate, the user approves it, and the user states its shape.
// The last verified write operation is returned so outcome fixtures can cite a real audit record.
async function seedRule(app, { guidance = GUIDANCE, order = 'reads_first', tag = 'AP' } = {}) {
  let writeOperationId = null;
  for (const n of [1, 2]) {
    const write = await app.controller.handle(`remember that the ${tag} note ${n} holds`, { origin: 'user' });
    assert.equal(write.status, Outcome.SUCCESS_VERIFIED, write.output);
    writeOperationId = write.operation.id;
    const experience = await app.controller.experienceRecord({ operationId: write.operation.id, subject: `an ${tag} memory write` });
    assert.equal(experience.status, Outcome.SUCCESS_VERIFIED, experience.output);
    const feedback = await app.controller.feedbackRecord({
      target: data(experience).id, assessment: 'user_correction', guidance, reason: 'done the long way round',
    });
    assert.equal(feedback.status, Outcome.SUCCESS_VERIFIED, feedback.output);
  }
  const derived = data(await app.controller.adaptationDerive({}));
  const adaptation = derived.created.find((a) => a.rule === guidance);
  assert.ok(adaptation, JSON.stringify(derived.created));
  assert.equal((await app.controller.adaptationDecide({
    target: adaptation.id, decision: 'approved', reason: 'this is how I want it done',
  })).status, Outcome.SUCCESS_VERIFIED);
  if (order !== null) {
    assert.equal((await app.controller.adaptationGuide({ target: adaptation.id, order })).status, Outcome.SUCCESS_VERIFIED);
  }
  return { adaptation, writeOperationId };
}

// The goal store refuses a second open goal that repeats an existing request verbatim, so each
// fixture goal states its own request while keeping the same two user-stated criteria.
let goalSeq = 0;
async function twoCriterionGoal(app) {
  goalSeq += 1;
  const created = await app.controller.goalAdd({
    request: `keep the running note current, case ${goalSeq}`,
    criteria: [
      { description: 'remember that the note holds', basis: 'user_stated' },
      { description: 'list my memory', basis: 'user_stated' },
    ],
  });
  assert.equal(created.status, Outcome.GOAL_CREATED, created.output);
  const goalId = data(created).goalId;
  for (const status of ['accepted', 'active']) {
    assert.equal((await app.controller.goalUpdate({ target: goalId, status })).status, Outcome.GOAL_UPDATED);
  }
  return goalId;
}

// The executive prepare path records the comparison and the plan in one operation, which is what
// makes the plan's content digest the candidate digest the disclosure reported.
async function prepare(app, goalId) {
  const prep = await app.controller.handle(`prepare a plan for goal ${goalId}`, { origin: 'user' });
  assert.equal(prep.status, Outcome.PLAN_STORED, prep.output);
  const disclosureStep = prep.operation.steps.find((s) => s.action === 'plan.candidates' || s.action === 'plan.replan');
  const addStep = prep.operation.steps.find((s) => s.action === 'plan.add');
  assert.ok(disclosureStep?.result?.data?.adaptationDecision, 'the comparison is disclosed in the operation');
  assert.ok(addStep?.result?.data?.planId, 'the plan is recorded in the same operation');
  return {
    operationId: prep.operation.id,
    decision: disclosureStep.result.data.adaptationDecision,
    candidates: disclosureStep.result.data.candidates,
    planId: addStep.result.data.planId,
    prep,
  };
}

async function approvedPlan(app, goalId) {
  const prepared = await prepare(app, goalId);
  assert.equal((await app.controller.planApprove({ target: prepared.planId })).status, Outcome.PLAN_STORED);
  return prepared;
}

async function activate(app, planId, taskId = 'task-ap04-fixture') {
  await app.plans.activate(planId, { taskId });
  return app.plans.get(planId);
}

async function record(app, planId, taskId, steps) {
  await app.plans.recordOutcome(planId, { taskId, steps });
  return app.plans.get(planId);
}

async function assess(app, planId, verdict, operationId) {
  await app.plans.assessPlan(planId, {
    verdict,
    summary: `a synthetic assessment fixture records ${verdict}`,
    findings: [{ aspect: 'goal_criteria', statement: `the fixture records ${verdict}`, operations: [operationId] }],
  });
}

async function effectiveness(app, target = null) {
  const res = await app.controller.adaptationEffectiveness(target ? { target } : {});
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output ?? display(res));
  const report = data(res).report;
  assert.ok(report, 'the read returns an effectiveness report');
  assert.equal(report.schema, EFFECTIVENESS_SCHEMA);
  return { res, report, row: report.adaptations[0] ?? null };
}

function auditLine(dataDir) {
  const file = path.join(dataDir, 'operations.jsonl');
  return JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).at(-1));
}

// A successful outcome needs both a completed, verified execution and goal criteria satisfied on
// evidence that still stands. This walks the real path for both, and returns the adaptation id.
async function successfulUse(app, goalId) {
  const prepared = await approvedPlan(app, goalId);
  const run = await app.controller.planActivate(prepared.planId, { mode: 'run' });
  assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.output ?? display(run));
  const plan = await app.plans.get(prepared.planId);
  const goal = await app.goals.get(goalId);
  for (const criterion of goal.criteria) {
    const step = plan.steps.find((s) => s.criterionId === criterion.id) ?? plan.steps[0];
    const operationId = plan.stepResults[step.id].operationId;
    const evidence = await app.controller.goalEvidence({
      target: goalId, criterion: criterion.id, kind: 'supports', operationId,
    });
    assert.equal(evidence.status, Outcome.GOAL_UPDATED, evidence.output);
  }
  assert.equal((await app.controller.planAssess({ target: prepared.planId })).status, Outcome.SUCCESS_VERIFIED);
  return { planId: prepared.planId };
}

// ================================================================================================
describe('AP-04 end to end: one approved rule, one decision, one run, one recorded outcome', () => {
  test('the full chain runs, and retirement gives the decision back without erasing the evidence', async () => {
    const d = dir();
    const app = await appIn(d);
    const goalId = await twoCriterionGoal(app);
    // A second goal of the same shape stays open for the whole run, so the reversal at the end is
    // compared against the same candidate set the baseline compared. The first goal's criteria are
    // settled by the time the rule is retired, which changes its candidates for reasons of its own.
    const restoreGoalId = await twoCriterionGoal(app);

    // Read before any learning record exists, so the "without it" side is an ordering the records
    // actually produced rather than one reconstructed afterwards.
    const baseline = data(await app.controller.planCandidates({ goal: goalId }));
    assert.equal(baseline.adaptationDecision.applied, false);
    assert.deepEqual(baseline.adaptationDecision.before, baseline.adaptationDecision.after);
    const restoreBaseline = data(await app.controller.planCandidates({ goal: restoreGoalId }));
    assert.equal(restoreBaseline.adaptationDecision.applied, false);
    assert.deepEqual(restoreBaseline.adaptationDecision.after, baseline.adaptationDecision.after);

    const { adaptation } = await seedRule(app);

    // The decision and the plan are two steps of one operation; approval is a later, separate act.
    const prepared = await prepare(app, goalId);
    assert.equal(prepared.decision.applied, true);
    assert.equal(prepared.decision.changed, true);
    assert.equal(prepared.decision.after.leading, 'read_before_write');
    assert.deepEqual(prepared.decision.rules.map((r) => r.id), [adaptation.id]);
    assert.equal(prepared.decision.rules[0].version, 1);
    assert.equal((await app.plans.get(prepared.planId)).status, 'draft', 'the plan is a draft until the user approves it');
    assert.equal((await app.controller.planApprove({ target: prepared.planId })).status, Outcome.PLAN_STORED);

    // Execution is verified. That is a fact about the audit log, not yet about the goal.
    const run = await app.controller.planActivate(prepared.planId, { mode: 'run' });
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.output ?? display(run));
    const executed = await app.plans.get(prepared.planId);
    assert.ok(executed.steps.every((s) => executed.stepResults[s.id]?.status === 'completed'),
      JSON.stringify(executed.stepResults));
    const ops = (await app.operations.inspect()).records;
    for (const step of executed.steps) {
      const record = ops.find((r) => r.id === executed.stepResults[step.id].operationId);
      assert.equal(record?.status, Outcome.SUCCESS_VERIFIED, `step ${step.id} was verified`);
    }

    const first = await effectiveness(app, adaptation.id);
    assert.equal(first.row.classification.state, 'applied_awaiting_confirmation');
    assert.equal(first.row.uses[0].attribution, 'adapted_unique');
    assert.equal(first.row.uses[0].planId, prepared.planId);
    assert.equal(first.row.uses[0].outcome.kind, 'awaiting_confirmation');
    assert.equal(first.row.uses[0].outcome.source, 'derived');
    assert.equal(first.row.lifecycle.approved, true);
    assert.equal(first.row.lifecycle.applied, true);
    assert.equal(first.row.lifecycle.executed, true);
    assert.equal(first.row.lifecycle.evaluated, true);
    assert.equal(first.row.lifecycle.retired, false);
    assert.equal(first.report.authorizes, false);
    assert.equal(first.row.recommendation.authorizes, false);
    // The unadapted choice was never run, so no baseline outcome is invented for it.
    assert.equal(first.row.uses[0].counterfactual.unadaptedExecuted, false);
    assert.equal(first.row.uses[0].counterfactual.baselineOutcome, 'unavailable');
    assert.match(first.row.uses[0].counterfactual.statement, /was not executed/);

    // Goal evidence settles the criteria; only then does the assessment say successful.
    const goal = await app.goals.get(goalId);
    for (const criterion of goal.criteria) {
      const step = executed.steps.find((s) => s.criterionId === criterion.id) ?? executed.steps[0];
      const operationId = executed.stepResults[step.id].operationId;
      const evidence = await app.controller.goalEvidence({
        target: goalId, criterion: criterion.id, kind: 'supports', operationId,
      });
      assert.equal(evidence.status, Outcome.GOAL_UPDATED, evidence.output);
    }
    assert.equal((await app.controller.planAssess({ target: prepared.planId })).status, Outcome.SUCCESS_VERIFIED);

    const second = await effectiveness(app, adaptation.id);
    assert.equal(second.row.classification.state, 'applied_successful');
    assert.equal(second.row.uses[0].outcome.kind, 'successful');
    assert.equal(second.row.summary.kind, 'too_few_observations');
    assert.deepEqual(second.row.summary.observations, {
      uses: 1, evaluated: 1, adapted: 1, baseline: 0, pending: 0, excluded: 0,
    });

    // The open goal is still moved by the rule before retirement, and only the rule is what moves it.
    const beforeRetirement = data(await app.controller.planCandidates({ goal: restoreGoalId }));
    assert.equal(beforeRetirement.adaptationDecision.applied, true);
    assert.equal(beforeRetirement.adaptationDecision.after.leading, 'read_before_write');

    // The user's review is the retirement, through the existing operation; the report only recommends.
    assert.equal((await app.controller.adaptationRetire({ target: adaptation.id, reason: 'no longer how I work' })).status, Outcome.SUCCESS_VERIFIED);
    const afterRetirement = data(await app.controller.planCandidates({ goal: restoreGoalId }));
    assert.equal(afterRetirement.adaptationDecision.applied, false);
    assert.equal(afterRetirement.adaptationDecision.outcome, 'declined');
    assert.deepEqual(afterRetirement.adaptationDecision.after, restoreBaseline.adaptationDecision.after,
      'reversal restores the unadapted decision');

    const third = await effectiveness(app, adaptation.id);
    assert.equal(third.row.retired, true);
    assert.equal(third.row.active, false);
    assert.equal(third.row.classification.state, 'applied_successful', 'the recorded outcome evidence is not erased by retirement');
    assert.ok(third.row.retirement?.at);
    assert.equal(third.report.authorizes, false);
    assert.match(display(third.res), /This read approves nothing, changes no rule, retires no adaptation/);
  });
});

// ================================================================================================
describe('AP-04 lifecycle: approval, application, execution and evaluation are four different facts', () => {
  test('an approved record that no decision ever read is not evaluated', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await twoCriterionGoal(app);

    const { report, row } = await effectiveness(app, adaptation.id);
    assert.equal(row.classification.state, 'approved_never_applied');
    assert.match(row.classification.why, /no recorded decision applied this record/);
    assert.equal(row.readings.usesRead, 0);
    assert.equal(row.lifecycle.applied, false);
    assert.equal(row.lifecycle.executed, false);
    assert.equal(row.lifecycle.evaluated, false);
    assert.equal(row.summary.kind, 'insufficient_evidence');
    assert.equal(report.totals.evaluated, 0);
    assert.equal(report.reads.disclosures, 0);
  });

  test('an eligible rule that the comparison declined is not counted as applied', async () => {
    const d = dir();
    const app = await appIn(d);
    const first = await seedRule(app, { guidance: GUIDANCE, order: 'reads_first', tag: 'AA' });
    const second = await seedRule(app, { guidance: 'add to the list before reading it', order: 'writes_first', tag: 'BB' });
    const goalId = await twoCriterionGoal(app);

    const compared = await app.controller.planCandidates({ goal: goalId });
    assert.equal(compared.status, Outcome.SUCCESS_VERIFIED, compared.output);
    const comparison = data(compared);
    assert.equal(comparison.adaptationDecision.applied, false);
    assert.ok(comparison.adaptationDecision.considered.every((c) => c.state === 'conflicted'));
    assert.equal((await app.plans.list()).length, 0, 'the declined comparison recorded no plan');

    for (const adaptation of [first.adaptation, second.adaptation]) {
      const { row, report } = await effectiveness(app, adaptation.id);
      assert.equal(row.classification.state, 'approved_never_applied');
      assert.match(row.classification.why, /declined to apply it/);
      assert.equal(row.uses[0].attribution, 'declined');
      assert.equal(row.uses[0].decision.applied, false);
      assert.equal(row.lifecycle.applied, false);
      assert.equal(report.totals.evaluated, 0);
    }
  });

  test('an applied record whose plan has not started is pending, not failed', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    const prepared = await approvedPlan(app, goalId);

    const { row, report } = await effectiveness(app, adaptation.id);
    assert.equal(row.classification.state, 'applied_outcome_pending');
    assert.equal(row.uses[0].outcome.state, 'pending');
    assert.equal(row.uses[0].outcome.kind, null);
    assert.match(row.uses[0].outcome.reason, /has not been started/);
    assert.equal(row.lifecycle.executed, false);
    assert.equal(row.lifecycle.evaluated, false);
    assert.equal(report.totals.evaluated, 0);
    assert.equal((await app.plans.get(prepared.planId)).status, 'approved');
    assert.equal((await app.taskStore.inspect()).tasks.length, 0, 'nothing was started by reading');
  });

  test('verified execution without settled criteria is awaiting confirmation, not success', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    const prepared = await approvedPlan(app, goalId);
    assert.equal((await app.controller.planActivate(prepared.planId, { mode: 'run' })).status, Outcome.SUCCESS_VERIFIED);

    const { row, report } = await effectiveness(app, adaptation.id);
    assert.equal(row.uses[0].outcome.kind, 'awaiting_confirmation');
    assert.equal(row.uses[0].outcome.source, 'derived');
    assert.match(row.uses[0].outcome.reason, /awaiting_confirmation|criteria|confirmation/i);
    assert.equal(row.classification.state, 'applied_awaiting_confirmation');
    assert.ok(report.limitations.some((l) => /does not establish real-world success/.test(l)));
  });

  test('failed, blocked and uncertain each stay what the records say', async () => {
    for (const kind of ['failed', 'blocked', 'uncertain']) {
      const d = dir();
      const app = await appIn(d);
      const { adaptation } = await seedRule(app, { tag: `T-${kind}` });
      const goalId = await twoCriterionGoal(app);
      const prepared = await approvedPlan(app, goalId);
      if (kind === 'blocked') {
        await app.plans.setStatus(prepared.planId, 'blocked', { reason: 'the fixture records a blocker' });
      } else {
        const plan = await activate(app, prepared.planId, `task-ap04-${kind}`);
        await record(app, prepared.planId, `task-ap04-${kind}`, plan.steps.map((s) => ({
          stepId: s.id, status: kind, detail: `the fixture records ${kind}`,
        })));
      }
      const { row } = await effectiveness(app, adaptation.id);
      assert.equal(row.uses[0].outcome.kind, kind, kind);
      if (kind === 'failed') {
        assert.equal(row.classification.state, 'applied_failed');
      } else {
        assert.equal(row.classification.state, 'applied_blocked_or_uncertain', kind);
        assert.notEqual(row.classification.state, 'applied_failed', `${kind} is not converted to failure`);
      }
      // A blocked plan that was never started is a recorded disposition, not a missing outcome.
      if (kind === 'blocked') {
        assert.equal(row.uses[0].outcome.source, 'plan_status');
        assert.match(row.uses[0].outcome.reason, /blocked rather than failed/);
      }
    }
  });
});

// ================================================================================================
describe('AP-04 lineage: a use is counted only while its own records still agree', () => {
  test('a plan edited after the comparison is excluded rather than attributed', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    const prepared = await prepare(app, goalId);
    const draft = await app.plans.get(prepared.planId);
    const revised = await app.plans.revise(prepared.planId, {
      outcome: 'a different recorded outcome',
      steps: draft.steps,
      preconditions: draft.preconditions,
      assertions: draft.assertions,
      resources: draft.resources,
      reason: 'the plan was edited after the comparison',
    });
    assert.equal(revised.plan.version, 2);
    assert.equal((await app.controller.planApprove({ target: prepared.planId })).status, Outcome.PLAN_STORED);

    const { row, report } = await effectiveness(app, adaptation.id);
    assert.equal(row.uses[0].attribution, 'plan_content_changed');
    assert.equal(row.uses[0].planId, prepared.planId, 'the plan is still named, and still not tied to the decision');
    assert.match(row.uses[0].why, /no longer matches any candidate/);
    assert.equal(row.classification.state, 'applied_unattributed');
    assert.equal(report.totals.evaluated, 0);
  });

  test('a new shape makes earlier uses belong to the earlier version', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    await approvedPlan(app, goalId);
    assert.equal((await app.controller.adaptationGuide({ target: adaptation.id, order: 'writes_first' })).status, Outcome.SUCCESS_VERIFIED);

    const { row } = await effectiveness(app, adaptation.id);
    assert.equal(row.version, 2);
    assert.equal(row.uses[0].attribution, 'stale_rule_version');
    assert.equal(row.uses[0].ruleVersion, 1);
    assert.equal(row.classification.state, 'applied_to_earlier_version');
    assert.match(row.classification.why, /belong to an earlier shape/);
    const earlier = row.versions.find((v) => v.version === '1');
    assert.equal(earlier.current, false);
    assert.equal(earlier.observations.uses, 1);
  });

  test('a repeated disclosure of the same plan cannot double-count one execution', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    const prepared = await prepare(app, goalId);

    // The same comparison and plan, recorded a second time under a new audit id. This is the shape a
    // duplicated audit line would take; the plan id is the identity that must collapse them.
    const original = auditLine(d);
    const at = Date.parse(original.requestedAt ?? original.finishedAt);
    const later = Number.isFinite(at) ? new Date(at + 60_000).toISOString() : '2026-11-05T10:00:00.000Z';
    await app.operations.append({ ...original, id: 'ap04-duplicate-disclosure', requestedAt: later, finishedAt: later });

    const { report, row } = await effectiveness(app, adaptation.id);
    assert.equal(row.readings.duplicatesSuppressed, 1);
    assert.equal(row.readings.usesKept, 1);
    assert.equal(row.summary.observations.uses, 1);
    assert.equal(report.totals.uses, 1);
    assert.equal(report.totals.evaluated, 0);
    assert.equal(row.uses[0].planId, prepared.planId);
  });
});

// ================================================================================================
describe('AP-04 outcomes: the evidence decides, and disagreement is disclosed', () => {
  test('two current assessments that disagree are conflicting evidence, not an average', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation, writeOperationId } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    const prepared = await approvedPlan(app, goalId);
    const plan = await activate(app, prepared.planId, 'task-ap04-conflict');
    await record(app, prepared.planId, 'task-ap04-conflict', plan.steps.map((s) => ({
      stepId: s.id, status: 'completed', operationId: writeOperationId,
    })));
    await assess(app, prepared.planId, 'successful', writeOperationId);
    await assess(app, prepared.planId, 'failed', writeOperationId);

    const { row, report } = await effectiveness(app, adaptation.id);
    assert.equal(row.uses[0].outcome.kind, 'conflicting_evidence');
    assert.equal(row.uses[0].outcome.verdict, null, 'no single recorded verdict is reported');
    assert.match(row.uses[0].outcome.reason, /disagree/);
    assert.equal(row.classification.state, 'applied_conflicting_evidence');
    assert.equal(row.summary.kind, 'conflicting_evidence');
    assert.equal(row.recommendation.kind, 'review');
    assert.equal(row.recommendation.authorizes, false);
    assert.equal(report.totals.evaluated, 1);
  });

  test('a plan cancelled before it ran yields insufficient evidence, never success or failure', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    const prepared = await approvedPlan(app, goalId);
    await app.plans.setStatus(prepared.planId, 'cancelled', { reason: 'the user stopped before it ran' });

    const { row } = await effectiveness(app, adaptation.id);
    assert.equal(row.uses[0].outcome.state, 'not_executed');
    assert.equal(row.uses[0].outcome.kind, 'insufficient_evidence');
    assert.match(row.uses[0].outcome.reason, /cancelled without an activation/);
    assert.equal(row.classification.state, 'applied_insufficient_evidence');
    assert.notEqual(row.classification.state, 'applied_successful');
    assert.notEqual(row.classification.state, 'applied_failed');
  });

  test('damaged plan and audit stores fail closed instead of reporting an outcome', async () => {
    {
      const d = dir();
      const app = await appIn(d);
      const { adaptation } = await seedRule(app);
      const goalId = await twoCriterionGoal(app);
      await approvedPlan(app, goalId);
      fs.appendFileSync(path.join(d, 'plans.jsonl'), '{not a plan event\n', 'utf8');
      const res = await app.controller.adaptationEffectiveness({ target: adaptation.id });
      assert.equal(res.status, Outcome.EXECUTION_FAILED);
      assert.match(res.output, /corrupt|incomplete plan state/i);
      assert.equal(res.operation.steps[0].result, null, 'no report is returned from damaged storage');
    }
    {
      const d = dir();
      const app = await appIn(d);
      const { adaptation } = await seedRule(app);
      await twoCriterionGoal(app);
      fs.appendFileSync(path.join(d, 'operations.jsonl'), 'not an audit record\n', 'utf8');
      const res = await app.controller.adaptationEffectiveness({ target: adaptation.id });
      assert.equal(res.status, Outcome.EXECUTION_FAILED);
      assert.match(res.output, /corrupt|incomplete audit history/i);
      assert.equal(res.operation.steps[0].result, null);
    }
  });
});

// ================================================================================================
describe('AP-04 comparison and summary: no baseline is invented and no cause is claimed', () => {
  test('the unadapted counterpart is disclosed as unexecuted with an unavailable outcome', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    const prepared = await approvedPlan(app, goalId);

    const { row, report } = await effectiveness(app, adaptation.id);
    const use = row.uses[0];
    // The two orderings are read from the disclosure itself, where both sides are at a depth the
    // bounded audit record keeps intact; the counterfactual restates them one level deeper.
    assert.equal(prepared.decision.before.leading, null);
    assert.deepEqual(prepared.decision.before.front, ['required_only', 'read_before_write']);
    assert.equal(prepared.decision.after.leading, 'read_before_write');
    assert.equal(use.counterfactual.changed, true);
    assert.equal(use.counterfactual.applied, true);
    assert.equal(use.counterfactual.unadaptedExecuted, false);
    assert.equal(use.counterfactual.baselineOutcome, 'unavailable');
    assert.match(use.counterfactual.note, /not a zero, a failure, or a success/);
    assert.equal(use.counterfactual.recordedStrategy, 'read_before_write');
    assert.match(use.counterfactual.statement, /Without this record the comparison led with no single candidate/);
    assert.match(renderEffectiveness(report), /without it: Without this record the comparison led with no single candidate/);
    assert.equal(row.summary.observations.baseline, 0);
    assert.ok(report.limitations.some((l) => /no baseline outcome exists/.test(l)));
  });

  test('a repeated success is a count of records, not evidence of cause', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    await successfulUse(app, goalId);

    const { row, report } = await effectiveness(app, adaptation.id);
    assert.equal(row.classification.state, 'applied_successful');
    assert.equal(row.summary.kind, 'too_few_observations', 'one observation is not a repeated result');
    assert.match(row.summary.statement, /not evidence that the rule caused it|remains explicitly insufficient/);
    assert.equal(row.recommendation.authorizes, false);
    assert.equal(report.authorizes, false);
    assert.ok(report.limitations.some((l) => /caused it/.test(l)));
    assert.equal('confidence' in row, false);
    assert.equal('probability' in row, false);
    assert.doesNotMatch(JSON.stringify({
      kind: row.summary.kind,
      statement: row.summary.statement,
      recommendation: row.recommendation,
    }), /\d+\s*%|p\s*[<=]\s*0\.|statistically significant/i);
  });

  test('the aggregates change no plan, goal, rule, task, or approval', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    const prepared = await approvedPlan(app, goalId);

    const snapshot = async () => ({
      experience: json(await app.experience.health()),
      goal: json(await app.goals.get(goalId)),
      plans: json(await app.plans.list()),
      adaptation: json(await app.experience.adaptationDetail(adaptation.id)),
      active: json(await app.experience.activeAdaptations({ capability: 'memory.add', limit: 10 })),
      tasks: (await app.taskStore.inspect()).tasks.length,
    });
    const before = await snapshot();
    const { report } = await effectiveness(app, adaptation.id);
    const after = await snapshot();

    assert.deepEqual(after, before, 'the read changed nothing it described');
    assert.equal(report.authorizes, false);
    assert.equal((await app.plans.get(prepared.planId)).status, 'approved',
      'the report did not start, complete, or retire the plan');
  });
});

// ================================================================================================
describe('AP-04 review and retirement: recommendations inform the user, they do not act', () => {
  // Two linked, failed uses of the current version are the smallest count that makes a negative summary.
  async function repeatedFailure(app) {
    const { adaptation } = await seedRule(app);
    for (const tag of ['one', 'two']) {
      const goalId = await twoCriterionGoal(app);
      const prepared = await approvedPlan(app, goalId);
      const taskId = `task-ap04-${tag}`;
      const plan = await activate(app, prepared.planId, taskId);
      await record(app, prepared.planId, taskId, plan.steps.map((s) => ({
        stepId: s.id, status: 'failed', detail: 'the fixture records a failure',
      })));
    }
    return adaptation;
  }

  test('a repeated-failure summary recommends review and still changes no guidance', async () => {
    const d = dir();
    const app = await appIn(d);
    const adaptation = await repeatedFailure(app);

    const { row } = await effectiveness(app, adaptation.id);
    assert.equal(row.summary.kind, 'repeated_failure');
    assert.equal(row.classification.state, 'applied_failed');
    assert.equal(row.recommendation.kind, 'consider_retirement');
    assert.equal(row.recommendation.authorizes, false);
    assert.match(row.recommendation.why, /still your decision through adaptation\.retire/);

    const detail = await app.experience.adaptationDetail(adaptation.id);
    assert.equal(detail.decisionState, 'approved', 'a negative count did not retire the rule');
    assert.equal(detail.active, true);
    const active = await app.experience.activeAdaptations({ capability: 'memory.add', limit: 10 });
    assert.ok(active.adaptations.some((a) => a.id === adaptation.id), 'the rule is still in effect');

    const goalId = await twoCriterionGoal(app);
    const stillApplied = data(await app.controller.planCandidates({ goal: goalId }));
    assert.equal(stillApplied.adaptationDecision.applied, true, 'guidance still follows the user\'s decision');
  });

  test('retirement happens only through the existing operation, and cannot be undone by a report', async () => {
    const d = dir();
    const app = await appIn(d);
    const adaptation = await repeatedFailure(app);
    const { row: beforeRow } = await effectiveness(app, adaptation.id);
    assert.equal(beforeRow.recommendation.kind, 'consider_retirement');
    assert.equal((await app.experience.adaptationDetail(adaptation.id)).retirement, null,
      'the recommendation recorded no retirement');

    assert.equal((await app.controller.adaptationRetire({ target: adaptation.id, reason: 'the user decided' })).status, Outcome.SUCCESS_VERIFIED);
    const retired = await app.experience.adaptationDetail(adaptation.id);
    assert.equal(retired.decisionState, 'retired');
    assert.ok(retired.retirement?.createdAt);

    const again = await app.controller.adaptationRetire({ target: adaptation.id, reason: 'a second retirement' });
    assert.notEqual(again.status, Outcome.SUCCESS_VERIFIED);
    assert.match(String(again.output ?? display(again)), /already retired/);

    const { row, report } = await effectiveness(app, adaptation.id);
    assert.equal(row.retired, true);
    assert.equal(row.active, false);
    assert.equal(row.retirement.at, retired.retirement.createdAt);
    assert.equal((await app.experience.adaptationDetail(adaptation.id)).retirement.createdAt, retired.retirement.createdAt,
      'the report neither retired nor reinstated anything');
    assert.equal(report.authorizes, false);
  });

  test('a concurrent read and retirement leave no stale active guidance', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    await approvedPlan(app, goalId);

    const [read, retired] = await Promise.all([
      app.controller.adaptationEffectiveness({ target: adaptation.id }),
      app.controller.adaptationRetire({ target: adaptation.id, reason: 'retired while the report was read' }),
    ]);
    assert.equal(retired.status, Outcome.SUCCESS_VERIFIED);
    assert.equal((await app.experience.adaptationDetail(adaptation.id)).active, false);

    // Whichever snapshot the read produced, it authorized nothing; and after both operations finish
    // the guidance path no longer offers the rule.
    if (read.status === Outcome.SUCCESS_VERIFIED) {
      assert.equal(data(read).report.authorizes, false);
    } else {
      assert.match(String(read.output ?? display(read)), /changed between two reads/);
    }
    const active = await app.experience.activeAdaptations({ capability: 'memory.add', limit: 10 });
    assert.equal(active.adaptations.some((a) => a.id === adaptation.id), false, 'no stale active guidance survives');

    const { row } = await effectiveness(app, adaptation.id);
    assert.equal(row.retired, true);
    assert.equal(row.active, false);
  });

  test('an audit-append failure is disclosed instead of being reported as recorded', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    await approvedPlan(app, goalId);

    const before = (await app.operations.inspect()).records.length;
    const original = app.operations.append.bind(app.operations);
    app.operations.append = async () => { throw new StoreError('injected: the audit log refused adaptation.effectiveness'); };
    let res;
    try {
      res = await app.controller.adaptationEffectiveness({ target: adaptation.id });
    } finally {
      app.operations.append = original;
    }
    assert.equal(res.recorded, false);
    assert.match(String(res.recordError), /injected: the audit log refused/);
    // The read's evidence is still shown, but it is not presented as an audited record.
    assert.ok(data(res).report);
    assert.equal(data(res).report.authorizes, false);
    assert.equal((await app.operations.inspect()).records.length, before, 'the failed append wrote nothing');
  });
});

// ================================================================================================
describe('AP-04 vocabulary is closed and the report says what it is', () => {
  test('the module exposes only its declared vocabulary and a bounded, non-authorizing note', async () => {
    const d = dir();
    const app = await appIn(d);
    await twoCriterionGoal(app);
    const { report } = await effectiveness(app);
    assert.equal(report.available, true);
    assert.equal(report.reason, 'no adaptation record is stored');
    assert.deepEqual(report.adaptations, []);
    assert.equal(report.authorizes, false);
    assert.match(report.note, /bounded read of recorded evidence/);
    assert.equal(report.totals.uses, 0);
    for (const kind of ['successful', 'partially_successful', 'failed', 'blocked', 'uncertain', 'awaiting_confirmation', 'insufficient_evidence', 'conflicting_evidence']) {
      assert.ok(EFFECTIVENESS_OUTCOMES.includes(kind));
    }
    assert.ok(EFFECTIVENESS_STATES.includes('retired_before_evaluation'));
    assert.ok(EFFECTIVENESS_STATES.includes('ineligible_support_invalid'));
    assert.equal(report.reads.auditTruncated, false);
    assert.ok(report.limitations.length >= 6);
  });
});
