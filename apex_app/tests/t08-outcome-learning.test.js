// T-08 — outcome-driven learning and behaviour adaptation, end to end.
//
// Every scenario drives the public controller workflows: goals, plans, task execution through the real
// plan store and task runner, then the learning commands and the existing adaptation commands. No
// model is configured, none is called, and every action is a deterministic test double or a built-in.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import {
  makeTempDataDir, cleanup, makeFakeTaskActions, cleanEnv, runCli,
} from './helpers.js';

const DIRS = [];
function tempDir() {
  const dir = makeTempDataDir();
  DIRS.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of DIRS) {
    try { cleanup(dir); } catch { /* the harness removes what it can */ }
  }
});

function appOn({ dataDir, extraActions = [] }) {
  return createApp({ dataDir, experienceCapture: CAPTURE_OFF, extraActions });
}

// A read whose outcome the test controls, so the same capability can succeed and then fail without
// the plan or the capability name changing.
function toggleAction(state) {
  return {
    name: 'test.toggle',
    description: 'test-only read whose outcome the test controls',
    inputHint: '{"tag":"text"}',
    permission: 'read',
    origins: ['user', 'model'],
    validate: (input) => ({ tag: String(input?.tag ?? 'x') }),
    async execute(_ctx, input) {
      if (state.fail) throw new Error('the sensor did not answer');
      return { summary: `read ${input.tag ?? 'x'}`, data: { tag: input.tag } };
    },
    async verify() {
      if (state.fail) return null;
      return { ok: true, detail: 'the read was recorded' };
    },
  };
}

function stepList(actions) {
  return actions.map((action, index) => ({
    id: `s${index + 1}`,
    description: `${action} step`,
    action,
    input: action === 'test.fail' ? {} : { tag: `tag-${index + 1}` },
    dependsOn: [],
    expectedResult: `${action} recorded`,
    verification: 'read it back',
    risk: 'low',
  }));
}

// One whole run: record a plan, approve it, execute it. The result carries the plan id and the
// activation operation, exactly as a user would see them.
async function runPlan(app, { outcome, actions, goalId = null }) {
  const planned = await app.controller.planAdd({
    ...(goalId ? { goalId } : {}),
    outcome,
    steps: stepList(actions),
  });
  assert.equal(planned.status, Outcome.PLAN_STORED, `plan add failed: ${planned.output}`);
  const planId = planned.operation.steps[0].result.data.planId;
  const approved = await app.controller.planApprove({ target: planId });
  assert.equal(approved.status, Outcome.PLAN_STORED, `approval failed: ${approved.output}`);
  const activated = await app.controller.planActivate(planId, { mode: 'run' });
  return { planId, activated };
}

async function observe(app, planId) {
  const res = await app.controller.learningObserve({ plan: planId });
  assert.ok(res.operation.steps[0].result?.data, `learning observe failed: ${res.output ?? res.display}`);
  return res.operation.steps[0].result.data;
}

function dataOf(res) {
  return res.operation.steps[0].result?.data;
}

describe('T-08 outcome learning', { concurrency: false }, () => {
  test('Scenario 1: repeated success yields a supported strategy proposal', async () => {
    const dir = tempDir();
    const sink = [];
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions(sink) });
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Ship the report', actions: ['test.ok'] });
      const evaluation = await observe(app, planId);
      assert.equal(evaluation.classification, 'achieved', `run ${i + 1} was not achieved`);
      ids.push(evaluation.id);
    }
    assert.equal(new Set(ids).size, 3, 'each run recorded its own evaluation');

    const patterns = dataOf(await app.controller.learningPatterns({ capability: 'test.ok' }));
    const success = patterns.patterns.find((p) => p.kind === 'repeated_success' && p.capability === 'test.ok');
    assert.ok(success, 'a repeated-success pattern should be described');
    assert.equal(success.observations.successes, 3);
    assert.equal(success.proposalEligible, true);

    const proposed = dataOf(await app.controller.learningPropose({}));
    const candidate = proposed.created.find((c) => c.capability === 'test.ok');
    assert.ok(candidate, 'a candidate should be proposed for test.ok');
    assert.deepEqual(candidate.guidance.prefer, ['test.ok']);
    assert.equal(candidate.requiredAuthorization, 'user_approval');
    assert.equal(candidate.reversibility, 'reversible');
    assert.ok(candidate.risks.length >= 1);
    assert.equal(candidate.validationCriteria.minObservations >= 2, true);

    const list = await app.controller.adaptationList({});
    assert.match(list.display, /test\.ok/);
    assert.match(list.display, /not approved|NOT APPROVED|candidate/i);

    const detail = await app.experience.adaptationDetail(candidate.id);
    assert.equal(detail.active, false, 'a candidate must not be in force');
    assert.equal(detail.stage, 'evaluated', 'a candidate carrying a proposal is evaluated, not active');

    const status = dataOf(await app.controller.learningStatus({}));
    assert.equal(status.evaluations.counts.achieved, 3);
    assert.ok(status.adaptations.rows.some((row) => row.id === candidate.id && row.stage === 'evaluated'));
  });

  test('Scenario 2: repeated failure identifies a common failure pattern', async () => {
    const dir = tempDir();
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions([]) });
    for (let i = 0; i < 2; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Compile the module', actions: ['test.fail'] });
      const evaluation = await observe(app, planId);
      assert.equal(evaluation.classification, 'not_achieved');
      assert.equal(evaluation.steps.failed, 1);
    }
    const patterns = dataOf(await app.controller.learningPatterns({}));
    const failure = patterns.patterns.find((p) => p.kind === 'repeated_failure' && p.capability === 'test.fail');
    assert.ok(failure, 'a repeated-failure pattern should be described');
    assert.equal(failure.observations.failures, 2);
    assert.equal(failure.confidence !== 'high', true, 'two observations are not high confidence');

    const proposed = dataOf(await app.controller.learningPropose({}));
    const candidate = proposed.created.find((c) => c.capability === 'test.fail');
    assert.ok(candidate, 'a candidate should be proposed to avoid test.fail');
    assert.deepEqual(candidate.guidance.avoid, ['test.fail']);
    assert.match(candidate.rule, /avoid test\.fail/);
  });

  test('Scenario 3: contradictory experiences reduce confidence rather than being discarded', async () => {
    const dir = tempDir();
    const state = { fail: true };
    const app = appOn({ dataDir: dir, extraActions: [...makeFakeTaskActions([]), toggleAction(state)] });
    for (let i = 0; i < 3; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Check the sensor', actions: ['test.toggle'] });
      await observe(app, planId);
    }
    state.fail = false;
    const { planId } = await runPlan(app, { outcome: 'Check the sensor', actions: ['test.toggle'] });
    await observe(app, planId);

    const patterns = dataOf(await app.controller.learningPatterns({ capability: 'test.toggle' }));
    const failure = patterns.patterns.find((p) => p.kind === 'repeated_failure' && p.capability === 'test.toggle');
    assert.ok(failure);
    assert.equal(failure.observations.failures, 3);
    assert.equal(failure.observations.successes, 1);
    assert.equal(failure.contradicting.length, 1, 'the successful run must be preserved as contradicting evidence');
    assert.equal(failure.confidence, 'moderate', 'one contradiction lowers the grade');

    const proposed = dataOf(await app.controller.learningPropose({}));
    const candidate = proposed.created.find((c) => c.capability === 'test.toggle');
    assert.ok(candidate);
    assert.equal(candidate.pattern.contradicting, 1);
    assert.match(candidate.rule, /1 contradicting outcome/);
  });

  test('Scenario 4: insufficient evidence prevents an adaptation from activating', async () => {
    const dir = tempDir();
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions([]) });
    for (let i = 0; i < 2; i += 1) {
      const { planId } = await runPlan(app, { outcome: `Small run ${i + 1}`, actions: ['test.ok'] });
      await observe(app, planId);
    }
    const patterns = dataOf(await app.controller.learningPatterns({}));
    assert.equal(
      patterns.patterns.some((p) => p.kind === 'repeated_success' && p.capability === 'test.ok'),
      false,
      'two observations are not a repeated pattern',
    );
    const proposed = dataOf(await app.controller.learningPropose({}));
    assert.equal(proposed.created.length, 0);
    assert.equal((await app.controller.adaptationList({})).display.includes('test.ok:'), false);

    // An unexecuted plan is not a success and not a failure: it is indeterminate, and recorded as such.
    const planned = await app.controller.planAdd({ outcome: 'Never started', steps: stepList(['test.ok']) });
    const planId = planned.operation.steps[0].result.data.planId;
    const evaluation = await observe(app, planId);
    assert.equal(evaluation.classification, 'indeterminate');
    assert.match(evaluation.limitations.join(' '), /no recorded activation/);
  });

  test('Scenario 5: an unauthorized adaptation is rejected', async () => {
    const dir = tempDir();
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions([]) });
    for (const action of ['learning.observe', 'learning.propose', 'learning.measure', 'learning.rollback']) {
      const decision = app.registry.authorize(action, 'model');
      assert.equal(decision.decision, 'deny', `${action} must not be offered to a model origin`);
      assert.equal(decision.reason, 'ORIGIN_NOT_PERMITTED');
    }
    assert.equal(app.registry.authorize('adaptation.decide', 'model').decision, 'deny');

    const plan = await app.controller.planAdd({ outcome: 'Model attempt', steps: stepList(['test.ok']) });
    const planId = plan.operation.steps[0].result.data.planId;
    const op = await app.controller.runAction('learning.observe', { plan: planId }, 'model', randomUUID());
    assert.equal(op.authorization.decision, 'deny');
    assert.equal(op.execution.status, 'not_run', 'a denied action must not execute');

    await assert.rejects(
      () => app.experience.recordEvaluation({ planId, planVersion: 1 }, { origin: 'model' }),
      /user-origin|user origin/i,
    );

    // Nothing was learned from the denied attempt.
    const read = dataOf(await app.controller.learningStatus({}));
    assert.equal(read.evaluations.total, 0);
  });

  test('Scenario 6: an authorized adaptation becomes active and persists', async () => {
    const dir = tempDir();
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions([]) });
    for (let i = 0; i < 3; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Persist the run', actions: ['test.ok'] });
      await observe(app, planId);
    }
    const candidate = dataOf(await app.controller.learningPropose({})).created.find((c) => c.capability === 'test.ok');
    assert.ok(candidate);

    const decided = await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    assert.equal(decided.status, Outcome.SUCCESS_VERIFIED, `approval failed: ${decided.output}`);

    const detail = await app.experience.adaptationDetail(candidate.id);
    assert.equal(detail.decisionState, 'approved');
    assert.equal(detail.active, true);
    assert.equal(detail.stage, 'active');
    const active = await app.experience.activeAdaptations({ capability: 'test.ok', limit: 10 });
    assert.ok(active.adaptations.some((a) => a.id === candidate.id));

    const restarted = appOn({ dataDir: dir, extraActions: makeFakeTaskActions([]) });
    const afterRestart = await restarted.experience.adaptationDetail(candidate.id);
    assert.equal(afterRestart.active, true, 'the approval and its evidence survive a restart');
    assert.equal(afterRestart.stage, 'active');
    const list = await restarted.controller.adaptationList({});
    assert.match(list.display, /test\.ok/);
    const audit = await restarted.operations.inspect();
    assert.ok(audit.records.some((r) => r.capability === 'learning.propose'), 'the proposal is in the audit log');
    assert.ok(audit.records.some((r) => r.capability === 'learning.observe'), 'each evaluation is in the audit log');
  });

  test('Scenario 7: a subsequent execution records measurable results', async () => {
    const dir = tempDir();
    const state = { fail: true };
    const app = appOn({ dataDir: dir, extraActions: [...makeFakeTaskActions([]), toggleAction(state)] });
    for (let i = 0; i < 2; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Fetch the reading', actions: ['test.toggle'] });
      await observe(app, planId);
    }
    const candidate = dataOf(await app.controller.learningPropose({})).created.find((c) => c.capability === 'test.toggle');
    assert.ok(candidate, 'two failures should propose a rule to avoid the capability');
    await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });

    state.fail = false;
    for (let i = 0; i < 2; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Fetch the reading', actions: ['test.toggle'] });
      await observe(app, planId);
    }

    const measured = await app.controller.learningMeasure({ target: candidate.id });
    assert.equal(measured.status, Outcome.SUCCESS_VERIFIED, `measurement failed: ${measured.output}`);
    const data = dataOf(measured);
    assert.equal(data.baseline.observations, 2);
    assert.equal(data.baseline.achieved, 0);
    assert.equal(data.followUp.observations, 2);
    assert.equal(data.followUp.achieved, 2);
    assert.equal(data.verdict, 'improved');

    const detail = await app.experience.adaptationDetail(candidate.id);
    assert.equal(detail.stage, 'retained');
    assert.equal(detail.measurement.verdict, 'improved');

    const status = dataOf(await app.controller.learningStatus({}));
    assert.equal(status.adaptations.rows[0].measurement.verdict, 'improved');
  });

  test('Scenario 8: a measured regression supports a rollback, and only a regression does', async () => {
    const dir = tempDir();
    const state = { fail: false };
    const app = appOn({ dataDir: dir, extraActions: [...makeFakeTaskActions([]), toggleAction(state)] });
    for (let i = 0; i < 3; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Keep steady', actions: ['test.toggle'] });
      await observe(app, planId);
    }
    const candidate = dataOf(await app.controller.learningPropose({})).created.find((c) => c.capability === 'test.toggle');
    assert.ok(candidate);
    await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });

    // Without a measurement there is nothing a rollback could rest on.
    const noEvidence = await app.controller.learningRollback({ target: candidate.id });
    assert.equal(noEvidence.status, Outcome.EXECUTION_FAILED);
    assert.match(noEvidence.output, /no recorded measurement/i);

    state.fail = true;
    for (let i = 0; i < 2; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Keep steady', actions: ['test.toggle'] });
      await observe(app, planId);
    }
    const measured = dataOf(await app.controller.learningMeasure({ target: candidate.id }));
    assert.equal(measured.verdict, 'regressed');
    assert.equal((await app.experience.adaptationDetail(candidate.id)).stage, 'measured',
      'a regression is reported, not acted on');

    const rolled = await app.controller.learningRollback({ target: candidate.id });
    assert.equal(rolled.status, Outcome.SUCCESS_VERIFIED, `rollback failed: ${rolled.output}`);
    const detail = await app.experience.adaptationDetail(candidate.id);
    assert.equal(detail.rolledBack, true);
    assert.equal(detail.active, false);
    assert.equal(detail.stage, 'rolled_back');
    assert.equal(detail.decisionState, 'approved', 'the approval stays as recorded');
    const active = await app.experience.activeAdaptations({ capability: 'test.toggle', limit: 10 });
    assert.equal(active.adaptations.some((a) => a.id === candidate.id), false,
      'a rolled-back rule is no longer offered');
  });

  test('Scenario 9: restart preserves adaptation state, evidence, and audit history', async () => {
    const dir = tempDir();
    const state = { fail: false };
    const app = appOn({ dataDir: dir, extraActions: [...makeFakeTaskActions([]), toggleAction(state)] });
    for (let i = 0; i < 3; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Restart check', actions: ['test.toggle'] });
      await observe(app, planId);
    }
    const candidate = dataOf(await app.controller.learningPropose({})).created.find((c) => c.capability === 'test.toggle');
    await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    state.fail = true;
    for (let i = 0; i < 2; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Restart check', actions: ['test.toggle'] });
      await observe(app, planId);
    }
    const measured = await app.controller.learningMeasure({ target: candidate.id });
    assert.equal(measured.status, Outcome.SUCCESS_VERIFIED, `measurement failed: ${measured.output}`);
    const rolled = await app.controller.learningRollback({ target: candidate.id, reason: 'the sensor failed' });
    assert.equal(rolled.status, Outcome.SUCCESS_VERIFIED, `rollback failed: ${rolled.output}`);

    const restarted = appOn({ dataDir: dir, extraActions: [...makeFakeTaskActions([]), toggleAction(state)] });
    const detail = await restarted.experience.adaptationDetail(candidate.id);
    assert.equal(detail.stage, 'rolled_back');
    assert.equal(detail.measurement.verdict, 'regressed');
    assert.equal(detail.rollback.reason, 'the sensor failed');
    assert.equal(detail.support.evaluationIds.length, 3, 'the supporting evaluations survive');

    const evaluations = await restarted.experience.evaluations({ limit: 50 });
    assert.equal(evaluations.evaluations.length, 5);
    const health = await restarted.experience.health();
    assert.equal(health.state, 'ok');
    assert.equal(health.outcomeEvaluations, 5);
    assert.equal(health.measurements, 1);
    assert.equal(health.rollbacks, 1);
    assert.equal(health.rolledBackAdaptations, 1);

    const status = dataOf(await restarted.controller.learningStatus({}));
    assert.ok(status.adaptations.rows.some((row) => row.id === candidate.id
      && row.stage === 'rolled_back' && row.rolledBack === true));
  });

  test('Scenario 10: a user correction overrides an unsuitable behavioural preference', async () => {
    const dir = tempDir();
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions([]) });
    for (let i = 0; i < 3; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Override check', actions: ['test.ok'] });
      await observe(app, planId);
    }
    const candidate = dataOf(await app.controller.learningPropose({})).created.find((c) => c.capability === 'test.ok');
    await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    let detail = await app.experience.adaptationDetail(candidate.id);
    assert.equal(detail.guidance.source, 'proposal');
    assert.deepEqual(detail.guidance.prefer, ['test.ok']);

    // The user's own recorded shape wins over the proposal's preference.
    const guided = await app.controller.adaptationGuide({
      target: candidate.id,
      avoid: ['test.ok'],
      reason: 'preferring it made the answer arrive before the record was read',
    });
    assert.equal(guided.status, Outcome.SUCCESS_VERIFIED, `guidance failed: ${guided.output}`);
    detail = await app.experience.adaptationDetail(candidate.id);
    assert.equal(detail.guidance.source, 'record');
    assert.deepEqual(detail.guidance.prefer, []);
    assert.deepEqual(detail.guidance.avoid, ['test.ok']);
    assert.equal(detail.active, true, 'the rule stays in force with the user\'s shape');

    // A correction recorded as feedback does not silently rewrite the approved rule; it is kept as
    // the user's own account of one event beside it.
    const experiences = await app.experience.list({ limit: 10 });
    if (experiences.length > 0) {
      const feedback = await app.controller.feedbackRecord({
        target: experiences[0].id,
        assessment: 'user_correction',
        guidance: 'ask before preferring a capability',
        reason: 'the ordering was wrong',
      });
      assert.equal(feedback.status, Outcome.SUCCESS_VERIFIED);
    }
    detail = await app.experience.adaptationDetail(candidate.id);
    assert.equal(detail.rule, candidate.rule, 'the approved rule text is unchanged');
    assert.equal(detail.guidance.source, 'record');
  });

  test('Scenario 11: different objectives do not share learned strategies', async () => {
    const dir = tempDir();
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions([]) });
    // Objective A: two runs that succeed without test.fail and two that add it and fail.
    for (let i = 0; i < 2; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Compile the module', actions: ['test.ok'] });
      await observe(app, planId);
    }
    for (let i = 0; i < 2; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Compile the module', actions: ['test.ok', 'test.fail'] });
      await observe(app, planId);
    }
    // Objective B uses the first capability successfully and never touches the failing one.
    for (let i = 0; i < 2; i += 1) {
      const { planId } = await runPlan(app, { outcome: 'Publish the note', actions: ['test.ok'] });
      await observe(app, planId);
    }

    const patterns = dataOf(await app.controller.learningPatterns({}));
    const inefficient = patterns.patterns.find((p) => p.kind === 'inefficient_execution');
    assert.ok(inefficient, 'the failing capability that never appears in a success is inefficient');
    assert.equal(inefficient.capability, 'test.fail');
    assert.ok(inefficient.objectiveKey, 'an objective-scoped pattern names its objective');

    const proposed = dataOf(await app.controller.learningPropose({}));
    const candidate = proposed.created.find((c) => c.capability === 'test.fail');
    assert.ok(candidate);
    assert.equal(candidate.pattern.objectiveKey, inefficient.objectiveKey,
      'the candidate is scoped to the objective it was observed under');
    const other = proposed.created.filter((c) => c.capability === 'test.fail' && c.pattern.objectiveKey !== inefficient.objectiveKey);
    assert.equal(other.length, 0, 'no rule is proposed for the other objective');

    const okPatterns = dataOf(await app.controller.learningPatterns({ capability: 'test.ok' }));
    assert.equal(okPatterns.patterns.some((p) => p.capability === 'test.fail'), false,
      'a capability filter never returns another scope\'s pattern');
  });

  test('Scenario 12: malformed records cannot bypass authorization', async () => {
    const dir = tempDir();
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions([]) });
    const { planId } = await runPlan(app, { outcome: 'Honest run', actions: ['test.ok'] });
    await observe(app, planId);

    // A line that claims an outcome its own step counts deny is damage, not evidence.
    const forged = {
      schema: 1,
      kind: 'outcome_evaluation',
      id: randomUUID(),
      planId: 'forged-plan',
      planVersion: 1,
      goalId: null,
      taskId: null,
      objective: 'a run that never happened',
      objectiveKey: null,
      activated: true,
      planStatus: 'completed',
      classification: 'achieved',
      confidence: 'high',
      steps: {
        total: 1, completed: 0, failed: 0, skipped: 0, uncertain: 0, notRun: 1,
      },
      capabilities: [],
      sequence: [],
      criteria: [],
      evidence: {
        operationIds: [], experienceIds: [], feedbackIds: [], predictionIds: [],
      },
      limitations: ['nothing was recorded'],
      evidenceSha256: '0'.repeat(64),
      createdAt: new Date().toISOString(),
      provenance: { origin: 'recorded_evaluation', updateMode: 'user_confirmed' },
    };
    fs.appendFileSync(path.join(dir, 'experiences.jsonl'), `${JSON.stringify(forged)}\n`);
    const health = await app.experience.health();
    assert.equal(health.state, 'damaged');
    assert.ok(health.corruptLines >= 1);
    await assert.rejects(() => app.experience.evaluations({ limit: 10 }), /corrupt/i);
    const blocked = await app.controller.learningPropose({});
    assert.equal(blocked.status, Outcome.EXECUTION_FAILED, 'a damaged log must stop the proposal');
    assert.match(blocked.output, /corrupt/i);

    // The model origin cannot reach any write, and the store refuses it again if it could.
    assert.equal(app.registry.authorize('learning.rollback', 'model').reason, 'ORIGIN_NOT_PERMITTED');
    await assert.rejects(
      () => app.experience.recordOutcomeCandidates({ specs: [] }, { origin: 'model' }),
      /user-origin|user origin/i,
    );
  });

  test('T-08 CLI: learning commands work through the user-facing entry point', async () => {
    const dir = tempDir();
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions([]) });
    const { planId } = await runPlan(app, { outcome: 'CLI run', actions: ['test.ok'] });
    const env = cleanEnv({ APEX_DATA_DIR: dir });

    const observed = await runCli(['learning', 'observe', planId], env);
    assert.equal(observed.code, 0, `learning observe failed: ${observed.stdout}\n${observed.stderr}`);
    assert.match(observed.stdout, /achieved/);

    const patterns = await runCli(['learning', 'patterns'], env);
    assert.equal(patterns.code, 0, `learning patterns failed: ${patterns.stderr}`);
    assert.match(patterns.stdout, /threshold/);

    const status = await runCli(['learning', 'status'], env);
    assert.equal(status.code, 0, `learning status failed: ${status.stderr}`);
    assert.match(status.stdout, /Outcomes: 1 recorded evaluation/);
    assert.match(status.stdout, /Patterns:/);

    const usage = await runCli(['learning', 'measure'], env);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /usage: learning measure/);
  });
});
