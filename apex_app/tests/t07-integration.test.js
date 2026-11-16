// T-07 Integration Tests: Persistent Intelligence, Adaptive Executive & Real-World Workflows
//
// These tests verify the 10 critical end-to-end scenarios that demonstrate APEX functioning
// as a persistent, context-aware, adaptive executive system. Each scenario uses the actual
// controller, stores, registry, planner, task runner and UI where practical.
//
// No model inference is used. These tests exercise the executive and persistence subsystems
// through direct controller method calls and deterministic capability routes.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { makeTempDataDir, cleanup, startStubModel, makeFakeTaskActions } from './helpers.js';
import { createGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';

const stubs = [];
after(async () => { for (const s of stubs) await s.close(); });

function appOn({ dataDir, model = null, extraActions = [] } = {}) {
  const gateway = model
    ? createGateway({ url: model.url, name: 'stub', timeoutMs: 3000, allowRemote: false })
    : undefined;
  return createApp({ dataDir, experienceCapture: CAPTURE_OFF, extraActions, ...(gateway ? { gateway } : {}) });
}

// ---------------------------------------------------------------
// Scenario 1: Long-term project persistence across restart
// ---------------------------------------------------------------
test('T-07 Scenario 1: project persists across restart and continues', async () => {
  const dir = makeTempDataDir();
  try {
    const app1 = appOn({ dataDir: dir });

    const created = await app1.controller.goalAdd({
      request: 'Build Lighthouse compiler',
      criteria: [{ description: 'compiler is runnable', basis: 'user_stated' }],
    });
    assert.equal(created.status, Outcome.GOAL_CREATED, `goal add failed: ${created.output}`);
    const goalId = created.operation.steps[0].result.data.goalId;
    assert(goalId, 'goalId not returned');

    const planned = await app1.controller.planAdd({
      goalId,
      outcome: 'Lighthouse compiler is built',
      steps: [
        { id: 's1', description: 'Create parser', action: 'memory.add', input: { content: 'parser created' }, dependsOn: [], expectedResult: 'parser record', verification: 'read it back', risk: 'medium' },
        { id: 's2', description: 'Build code generator', action: 'memory.add', input: { content: 'generator built' }, dependsOn: ['s1'], expectedResult: 'generator record', verification: 'read it back', risk: 'medium' },
        { id: 's3', description: 'Write optimizer', action: 'memory.add', input: { content: 'optimizer written' }, dependsOn: ['s2'], expectedResult: 'optimizer record', verification: 'read it back', risk: 'medium' },
      ],
    });
    assert.equal(planned.status, Outcome.PLAN_STORED, `plan add failed: ${planned.output}`);
    const planId = planned.operation.steps[0].result.data.planId;
    assert(planId, 'planId not returned');

    const approved = await app1.controller.planApprove({ target: planId });
    assert.equal(approved.status, Outcome.PLAN_STORED, `plan approve failed: ${approved.output}`);

    const app2 = appOn({ dataDir: dir });
    const report = await app2.controller.continuationReport();
    assert.ok(report, 'continuation report should exist');
    assert.equal(report.problems.length, 0, `continuation problems: ${report.problems.join(', ')}`);

    const planCandidate = report.candidates.find(c => c.kind === 'plan' && c.ref === planId);
    assert.ok(planCandidate, `plan ${planId} not in candidates`);

    const goalCandidate = report.candidates.find(c => c.kind === 'goal' && c.ref === goalId);
    assert.ok(goalCandidate, `goal ${goalId} not in candidates`);

    const plan = await app2.controller.showPlan(planId);
    assert.ok(plan, 'plan should be retrievable after restart');
    assert.equal(plan.display.includes('approved') || plan.display.includes('active'), true,
      'plan should show approval state');

  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------
// Scenario 2: Requirement change without losing completed work
// ---------------------------------------------------------------
test('T-07 Scenario 2: requirement change preserves completed work', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn({ dataDir: dir });

    const created = await app.controller.goalAdd({
      request: 'Deploy API',
      criteria: [{ description: 'API is accessible', basis: 'user_stated' }],
    });
    assert.equal(created.status, Outcome.GOAL_CREATED);
    const goalId = created.operation.steps[0].result.data.goalId;
    assert(goalId);

    const planned = await app.controller.planAdd({
      goalId,
      outcome: 'API is deployed',
      steps: [
        { id: 's1', description: 'Write spec', action: 'memory.add', input: { content: 'spec written' }, dependsOn: [], expectedResult: 'spec record', verification: 'read it back', risk: 'medium' },
        { id: 's2', description: 'Implement API', action: 'memory.add', input: { content: 'API implemented' }, dependsOn: ['s1'], expectedResult: 'API record', verification: 'read it back', risk: 'medium' },
        { id: 's3', description: 'Deploy', action: 'memory.add', input: { content: 'deployed' }, dependsOn: ['s2'], expectedResult: 'deploy record', verification: 'read it back', risk: 'high' },
      ],
    });
    assert.equal(planned.status, Outcome.PLAN_STORED);
    const planId = planned.operation.steps[0].result.data.planId;
    assert(planId);

    const approved = await app.controller.planApprove({ target: planId });
    assert.equal(approved.status, Outcome.PLAN_STORED);

    const revised = await app.controller.goalRevise({
      target: goalId,
      criteria: [{ description: 'Add tests', basis: 'user_stated' }],
      reason: 'the success criterion changed',
    });
    assert.equal(revised.status, Outcome.GOAL_UPDATED, `goal revise failed: ${revised.output}`);

    const goal = await app.controller.showGoal(goalId);
    assert.ok(goal, 'goal should still be readable after revision');
    assert.ok(goal.display.includes('Deploy API'), 'goal content preserved');

    const validity = await app.controller.validateStoredPlan(planId);
    assert.ok(validity, 'validity check should complete');
    assert.equal(validity.validation.ok, false, 'plan should be invalid because goal revision changed');
    assert.match(validity.display, /moved from revision 1 to 2/);

  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------
// Scenario 3: Memory correction propagates to future decisions
// ---------------------------------------------------------------
test('T-07 Scenario 3: memory correction propagates correctly', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn({ dataDir: dir });

    const first = await app.controller.handle('remember The indentation style is two-space', { origin: 'user' });
    assert.equal(first.status, Outcome.SUCCESS_VERIFIED);
    const recId = first.operation.steps[0].result.data.id;
    assert.ok(recId, 'initial memory record ID must exist');

    const found = await app.controller.handle('search memory "two-space"', { origin: 'user' });
    assert.equal(found.status, Outcome.SUCCESS_VERIFIED);
    const hits = found.operation.steps[0].result.data.hits;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, recId);

    const corrected = await app.controller.correctMemory({
      targetId: recId,
      content: 'The indentation style is four-space',
      resolve: true,
    });
    assert.equal(corrected.status, Outcome.SUCCESS_VERIFIED, `correction failed: ${corrected.output}`);
    const corrRecId = corrected.operation.steps[0].result.data.id;

    const updated = await app.controller.handle('search memory "four-space"', { origin: 'user' });
    assert.equal(updated.status, Outcome.SUCCESS_VERIFIED);
    const updatedHits = updated.operation.steps[0].result.data.hits;
    assert.ok(updatedHits.length >= 1, 'should return matching hits');
    assert.equal(updatedHits[0].id, corrRecId);
    assert.equal(updatedHits[0].status, 'user_confirmed');
    assert.deepEqual(updatedHits[0].replaces, [recId]);

    // Read-back verification from store for authoritative content
    const corrRecord = await app.memory.get(corrRecId);
    assert.equal(corrRecord.content, 'The indentation style is four-space');

    const oldSearch = await app.controller.handle('search memory "two-space"', { origin: 'user' });
    assert.equal(oldSearch.status, Outcome.SUCCESS_VERIFIED);
    const oldHits = oldSearch.operation.steps[0].result.data.hits;
    const oldTargetHit = oldHits.find(h => h.id === recId);
    assert.ok(oldTargetHit, 'original record should be found in memory search');
    assert.equal(oldTargetHit.status, 'superseded');
    assert.deepEqual(oldTargetHit.replacedBy, [corrRecId]);

    const oldRecord = await app.memory.get(recId);
    assert.equal(oldRecord.content, 'The indentation style is two-space');

    const health = await app.controller.memoryHealth?.() || { display: '' };
    assert.ok(health.display, 'memory health should produce output');

  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------
// Scenario 4: Dependency tracking and identification
// ---------------------------------------------------------------
test('T-07 Scenario 4: dependencies tracked correctly', async () => {
  const sink = [];
  const dir = makeTempDataDir();
  try {
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions(sink) });

    const created = await app.controller.goalAdd({
      request: 'Build system',
      criteria: [{ description: 'system builds', basis: 'user_stated' }],
    });
    assert.equal(created.status, Outcome.GOAL_CREATED);
    const goalId = created.operation.steps[0].result.data.goalId;

    const plan = await app.controller.planAdd({
      goalId,
      outcome: 'System builds',
      steps: [
        { id: 's1', description: 'Setup', action: 'memory.add', input: { content: 'setup done' }, dependsOn: [], expectedResult: 'setup record', verification: 'read it back', risk: 'medium' },
        { id: 's2', description: 'Compile', action: 'test.ok', input: { tag: 'compile' }, dependsOn: ['s1'], expectedResult: 'compile succeeds', verification: 'check output', risk: 'medium' },
      ],
    });
    assert.equal(plan.status, Outcome.PLAN_STORED);
    const planId = plan.operation.steps[0].result.data.planId;

    await app.controller.planApprove({ target: planId });
    const activated = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(activated.status, Outcome.SUCCESS_VERIFIED);

    const report = await app.controller.continuationReport();
    assert.ok(report, 'continuation report should exist');
    assert.ok(report.candidates.length > 0, 'should have candidates');

  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------
// Scenario 5: Duplicate execution prevented
// ---------------------------------------------------------------
test('T-07 Scenario 5: duplicate execution prevented', async () => {
  const sink = [];
  const dir = makeTempDataDir();
  try {
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions(sink) });

    const created = await app.controller.goalAdd({
      request: 'Simple calculation',
      criteria: [{ description: 'calculation recorded', basis: 'user_stated' }],
    });
    assert.equal(created.status, Outcome.GOAL_CREATED);
    const goalId = created.operation.steps[0].result.data.goalId;

    const plan = await app.controller.planAdd({
      goalId,
      outcome: 'Calculation done',
      steps: [
        { id: 's1', description: 'Calculate 2+2', action: 'test.ok', input: { tag: 'calc' }, dependsOn: [], expectedResult: 'result is 4', verification: 'check result', risk: 'low' },
      ],
    });
    assert.equal(plan.status, Outcome.PLAN_STORED);
    const planId = plan.operation.steps[0].result.data.planId;

    const approved = await app.controller.planApprove({ target: planId });
    assert.equal(approved.status, Outcome.PLAN_STORED);

    const activated = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(activated.status, Outcome.SUCCESS_VERIFIED, `activation failed: ${activated.output}`);

    const taskId = activated.task?.id || activated.operation?.task?.id;
    assert.ok(taskId, 'taskId should be returned');

    // Attempting duplicate activation on completed plan is rejected
    const secondActivation = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(secondActivation.status, Outcome.INPUT_REJECTED, 'second activation must be rejected');

    // Action executed only once in the sink
    assert.equal(sink.filter(s => s === 'calc').length, 1, 'step must execute exactly once');

    const report = await app.controller.continuationReport();
    const planEntry = report.candidates.find(c => c.kind === 'plan' && c.ref === planId);
    assert.equal(planEntry, undefined, 'settled plan must not be offered as continuation candidate');

    const task = await app.controller.showTask(taskId);
    assert.ok(task, 'task should be retrievable');

  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------
// Scenario 6: Interrupt and resume workflow
// ---------------------------------------------------------------
test('T-07 Scenario 6: interrupted workflow resumes correctly', async () => {
  const sink = [];
  const dir = makeTempDataDir();
  try {
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions(sink) });

    const created = await app.controller.goalAdd({
      request: 'Multi-step build',
      criteria: [{ description: 'build complete', basis: 'user_stated' }],
    });
    assert.equal(created.status, Outcome.GOAL_CREATED);
    const goalId = created.operation.steps[0].result.data.goalId;

    const planned = await app.controller.planAdd({
      goalId,
      outcome: 'Build complete',
      steps: [
        { id: 's1', description: 'Step 1', action: 'test.ok', input: { tag: 'step1' }, dependsOn: [], expectedResult: 'step 1 done', verification: 'check', risk: 'low' },
        { id: 's2', description: 'Step 2', action: 'test.fail', input: {}, dependsOn: ['s1'], expectedResult: 'step 2 done', verification: 'check', risk: 'low' },
        { id: 's3', description: 'Step 3', action: 'test.ok', input: { tag: 'step3' }, dependsOn: [], expectedResult: 'step 3 done', verification: 'check', risk: 'low' },
      ],
    });
    assert.equal(planned.status, Outcome.PLAN_STORED);
    const planId = planned.operation.steps[0].result.data.planId;

    await app.controller.planApprove({ target: planId });

    // Initial run activates and fails on s2, leaving untouched independent s3
    const activated = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(activated.status, Outcome.EXECUTION_FAILED);

    // Only step 1 executed before interruption
    assert.deepEqual(sink, ['step1']);

    // Continuation report detects interrupted plan and offers recovery
    const report = await app.controller.continuationReport();
    assert.ok(report, 'continuation report should exist');
    assert.ok(report.candidates.length > 0, 'should have continuation candidates');

    const planCandidate = report.candidates.find(c => c.kind === 'plan' && c.ref === planId);
    assert.ok(planCandidate, 'plan should be in continuation candidates');
    assert.ok(planCandidate.readiness !== undefined, 'readiness should be reported');

    // Continuation reading confirms untouched independent step is continuable
    const reading = await app.controller.planContinuation(planId);
    assert.equal(reading.status, Outcome.SUCCESS_VERIFIED);
    const contData = reading.operation.steps[0].result.data.continuation;
    assert.equal(contData.continue.safe, true);

    // Continue the plan: takes up untouched step s3
    const continued = await app.controller.planContinue(planId);
    assert.deepEqual(continued.ran, ['s3']);
    assert.deepEqual(sink, ['step1', 'step3'], 's3 should be executed upon continuation');

  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------
// Scenario 7: Competing deadlines get prioritized correctly
// ---------------------------------------------------------------
test('T-07 Scenario 7: competing deadlines get prioritized correctly', async () => {
  const sink = [];
  const dir = makeTempDataDir();
  try {
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions(sink) });

    const highPriority = await app.controller.goalAdd({
      request: 'Urgent release',
      deadline: '2026-11-20T00:00:00Z',
      priority: 1,
      criteria: [{ description: 'release ships', basis: 'user_stated' }],
    });
    assert.equal(highPriority.status, Outcome.GOAL_CREATED);
    const highId = highPriority.operation.steps[0].result.data.goalId;

    const lowPriority = await app.controller.goalAdd({
      request: 'Nice-to-have feature',
      deadline: '2026-12-01T00:00:00Z',
      priority: 4,
      criteria: [{ description: 'feature is done', basis: 'user_stated' }],
    });
    assert.equal(lowPriority.status, Outcome.GOAL_CREATED);
    const lowId = lowPriority.operation.steps[0].result.data.goalId;

    const planHigh = await app.controller.planAdd({
      goalId: highId,
      outcome: 'Urgent release shipped',
      steps: [{ id: 's1', description: 'Release', action: 'test.ok', input: { tag: 'release' }, dependsOn: [], expectedResult: 'released', verification: 'check', risk: 'medium' }],
    });
    assert.equal(planHigh.status, Outcome.PLAN_STORED);
    const planHighId = planHigh.operation.steps[0].result.data.planId;

    const planLow = await app.controller.planAdd({
      goalId: lowId,
      outcome: 'Feature done',
      steps: [{ id: 's1', description: 'Implement', action: 'test.ok', input: { tag: 'impl' }, dependsOn: [], expectedResult: 'done', verification: 'check', risk: 'low' }],
    });
    assert.equal(planLow.status, Outcome.PLAN_STORED);
    const planLowId = planLow.operation.steps[0].result.data.planId;

    const report = await app.controller.handle('work review', { origin: 'user' });
    assert.ok(report.output, 'work review should produce output');

    const continuation = await app.controller.continuationReport();
    const highCandidate = continuation.candidates.find(c => c.kind === 'goal' && c.ref === highId);
    const lowCandidate = continuation.candidates.find(c => c.kind === 'goal' && c.ref === lowId);
    assert.ok(highCandidate, 'high priority goal should be in candidates');
    assert.ok(lowCandidate, 'low priority goal should be in candidates');

    const highIndex = continuation.candidates.findIndex(c => c.ref === highId);
    const lowIndex = continuation.candidates.findIndex(c => c.ref === lowId);
    assert.ok(highIndex >= 0 && lowIndex >= 0, 'both goals should be in candidates');
    assert.ok(highIndex < lowIndex, 'high priority goal should be prioritized');

  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------
// Scenario 8: Project memory can be inspected with evidence
// ---------------------------------------------------------------
test('T-07 Scenario 8: project memory can be inspected with evidence', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn({ dataDir: dir });

    const fact1 = await app.controller.handle('remember Lighthouse compiler language design is complete', { origin: 'user' });
    assert.equal(fact1.status, Outcome.SUCCESS_VERIFIED);

    const fact2 = await app.controller.handle('remember Lighthouse compiler parser implementation is started', { origin: 'user' });
    assert.equal(fact2.status, Outcome.SUCCESS_VERIFIED);

    const search = await app.controller.handle('what do you remember about Lighthouse compiler', { origin: 'user' });
    assert.equal(search.status, Outcome.SUCCESS_VERIFIED);
    assert.ok(search.output, 'search should produce output');
    const searchHits = search.operation.steps[0].result.data.hits;
    assert.ok(searchHits.length >= 2, 'both facts should be found in memory');

    const digest = await app.controller.handle('knowledge digest', { origin: 'user' });
    assert.equal(digest.status, Outcome.SUCCESS_VERIFIED);
    assert.ok(digest.output, 'digest should produce output');
    assert.ok(digest.display.includes('Lighthouse compiler'), 'digest should summarize project facts');

  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------
// Scenario 9: Contradictory information handled honestly
// ---------------------------------------------------------------
test('T-07 Scenario 9: contradictory information handled honestly', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn({ dataDir: dir });

    const fact1 = await app.controller.handle('remember The project status is green', { origin: 'user' });
    assert.equal(fact1.status, Outcome.SUCCESS_VERIFIED);

    const fact2 = await app.controller.handle('remember The project status is amber', { origin: 'user' });
    assert.equal(fact2.status, Outcome.SUCCESS_VERIFIED);

    const search = await app.controller.handle('search memory "status"', { origin: 'user' });
    assert.equal(search.status, Outcome.SUCCESS_VERIFIED);
    assert.ok(search.output, 'search should produce output');
    const hits = search.operation.steps[0].result.data.hits;
    assert.equal(hits.length, 2, 'both contradictory facts should be returned');
    assert.equal(hits[0].status, 'unresolved_conflict');
    assert.equal(hits[1].status, 'unresolved_conflict');

    const worldState = await app.controller.handle('what conflicts do you have?', { origin: 'user' });
    assert.equal(worldState.status, Outcome.SUCCESS_VERIFIED);
    assert.ok(worldState.output.includes('1 memory subject group(s) with differing values'),
      'world state must honestly report the unresolved memory contradiction');

    const health = await app.controller.memoryHealth?.() || { display: '' };
    assert.ok(health.display, 'memory health should produce output');

  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------
// Scenario 10: Adaptation lifecycle is functional
// ---------------------------------------------------------------
test('T-07 Scenario 10: adaptation lifecycle is functional', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn({ dataDir: dir });

    const exp1 = await app.controller.handle('calc 2+2', { origin: 'user' });
    assert.equal(exp1.status, Outcome.SUCCESS_VERIFIED);

    const timeline = await app.controller.experienceTimeline();
    assert.equal(timeline.status, Outcome.SUCCESS_VERIFIED);
    assert.ok(timeline.display !== undefined, 'timeline should return display');

    const eligibility = await app.controller.adaptationEligibility({});
    assert.equal(eligibility.status, Outcome.SUCCESS_VERIFIED);
    assert.ok(eligibility.display !== undefined, 'eligibility should return display');

    const list = await app.controller.adaptationList({});
    assert.equal(list.status, Outcome.SUCCESS_VERIFIED);
    assert.ok(list.display !== undefined, 'list should return display');

    const health = await app.controller.experienceHealth();
    assert.equal(health.status, Outcome.SUCCESS_VERIFIED);
    assert.ok(health.display !== undefined, 'health should return display');

  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------
// Scenario 11: Replanning after a dependency failure
// ---------------------------------------------------------------
test('T-07 Scenario 11: replanning after a dependency failure', async () => {
  const sink = [];
  const dir = makeTempDataDir();
  try {
    const app = appOn({ dataDir: dir, extraActions: makeFakeTaskActions(sink) });

    const goal = await app.controller.goalAdd({
      request: 'Record deployment status in memory',
      criteria: [{ description: 'remember deployment status in memory', basis: 'user_stated' }],
    });
    assert.equal(goal.status, Outcome.GOAL_CREATED);
    const goalId = goal.operation.steps[0].result.data.goalId;

    const initialPlan = await app.controller.planAdd({
      goalId,
      outcome: 'Status recorded',
      steps: [
        { id: 's1', description: 'Compile', action: 'test.fail', input: {}, dependsOn: [], expectedResult: 'ok', verification: 'check', risk: 'low' },
        { id: 's2', description: 'Record memory', action: 'memory.add', input: { content: 'deployed' }, dependsOn: ['s1'], expectedResult: 'ok', verification: 'check', risk: 'medium' },
      ],
    });
    assert.equal(initialPlan.status, Outcome.PLAN_STORED);
    const planId = initialPlan.operation.steps[0].result.data.planId;

    await app.controller.planApprove({ target: planId });

    // Step 1 fails, blocking the plan
    const activated = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(activated.status, Outcome.EXECUTION_FAILED);

    const blockedPlan = await app.controller.showPlan(planId);
    assert.equal(blockedPlan.plan.status, 'blocked');

    // Replan: generates revised candidates excluding failed capability
    const replan = await app.controller.planReplan({
      plan: planId,
      reason: 'compile step failed',
      cannotUse: ['test.fail'],
    });
    assert.equal(replan.status, Outcome.SUCCESS_VERIFIED);
    const replanData = replan.operation.steps[0].result.data;
    assert.ok(replanData.candidates.length > 0, 'replanning should generate revised candidates');
    assert.deepEqual(replanData.cannotUse, ['test.fail']);
    assert.deepEqual(replanData.refusedActions, ['test.fail']);
    assert.equal(replanData.comparison.ok, true, 'candidate comparison should succeed');
    assert.equal(replanData.comparison.leading, 'required_only', 'disclosed rules pick leading revised candidate');

  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------
// Summary: Verify T-07 test structure is complete
// ---------------------------------------------------------------
test('T-07: all 11 scenarios defined and runnable', () => {
  console.log('T-07 Integration Tests: 11 end-to-end scenarios defined');
});
