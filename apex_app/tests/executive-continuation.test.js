// Live plan validity, plan history, executive proposals, and the continuation engine.
//
// Test doubles are labelled: the gateway below is a fixed, in-process object, not evidence about
// a real model. No endpoint is contacted and no inference service is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { ProposalStatus } from '../src/proposals/model.js';
import { assessPlanValidity } from '../src/plans/validity.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const STEP = {
  id: 's1',
  description: 'remember the fact',
  action: 'memory.add',
  input: { content: 'a validity test fact' },
  dependsOn: [],
  expectedResult: 'the fact is stored',
  verification: 'the stored record is read back',
  criterion: 'c1',
  risk: 'medium',
  estimateSeconds: 1,
};

function proposalGateway(lines) {
  const backend = {
    name: 'test-double',
    provider: 'test-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'test-double', endpoint: 'test-double', model: 'test-double' }),
    health: async () => ({ available: true, detail: 'test double' }),
    complete: async () => ({
      ok: true,
      backend: 'test-double',
      provider: 'test-double',
      model: 'test-double',
      text: lines.join('\n'),
      finishReason: 'stop',
      truncated: false,
      latencyMs: 0,
    }),
  };
  return new ModelGateway({ backend });
}

async function appIn(dir, gateway) {
  return createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF, ...(gateway ? { gateway } : {}) });
}

async function newActiveGoal(app, request = 'the validity goal') {
  const created = await app.controller.goalAdd({ request, criteria: ['the recorded fact is stored'] });
  assert.equal(created.status, Outcome.GOAL_CREATED, created.output);
  const goalId = created.operation.steps[0].result.data.goalId;
  assert.equal((await app.controller.goalUpdate({ target: goalId, status: 'accepted' })).status, Outcome.GOAL_UPDATED);
  assert.equal((await app.controller.goalUpdate({ target: goalId, status: 'active' })).status, Outcome.GOAL_UPDATED);
  return goalId;
}

test('activation revalidates the goal revision and does not create a task for a stale plan', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goalId = await newActiveGoal(app);
    const added = await app.controller.planAdd({ goalId, outcome: 'the fact is stored', steps: [STEP] });
    const planId = added.operation.steps[0].result.data.planId;
    assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);

    const revised = await app.controller.goalRevise({
      target: goalId,
      criteria: ['the revised fact is stored'],
      reason: 'the success criterion changed',
    });
    assert.equal(revised.status, Outcome.GOAL_UPDATED, revised.output);

    const validity = await app.controller.validateStoredPlan(planId);
    assert.equal(validity.validation.ok, false);
    assert.match(validity.display, /FAILED {2}goal-revision/);
    assert.match(validity.display, /moved from revision 1 to 2/);
    assert.match(validity.display, /reads the live state only/);

    const before = (await app.taskStore.inspect()).tasks.length;
    const run = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(run.status, Outcome.INPUT_REJECTED);
    assert.match(run.display, /moved from revision 1 to 2/);
    assert.equal((await app.taskStore.inspect()).tasks.length, before, 'a refused activation must not create a task');
    assert.equal((await app.controller.showPlan(planId)).plan.status, 'approved');
  } finally {
    cleanup(dir);
  }
});

test('live validity refuses evidence that no longer resolves, before any task is created', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const added = await app.controller.planAdd({
      outcome: 'the fact is stored',
      steps: [STEP],
      assertions: [{ kind: 'stored_knowledge', text: 'the earlier record exists', ref: 'knowledge-record-that-does-not-exist' }],
    });
    const planId = added.operation.steps[0].result.data.planId;
    assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);

    const validity = await app.controller.validateStoredPlan(planId);
    assert.equal(validity.validation.ok, false);
    assert.match(validity.display, /FAILED {2}assertions/);
    assert.match(validity.display, /no longer resolves/);

    const run = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(run.status, Outcome.INPUT_REJECTED);
    assert.match(run.display, /no longer resolves/);
    assert.equal((await app.taskStore.inspect()).tasks.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('a completed step outcome whose audit operation is gone makes the plan invalid', async () => {
  // Unit-level: the state is constructed rather than reached through a run, because a normal
  // revision clears step results and a completed plan cannot be activated again.
  const validity = await assessPlanValidity({
    id: 'p1',
    goalId: null,
    goalRevision: null,
    status: 'approved',
    version: 1,
    outcome: 'x',
    steps: [{ id: 's1', description: 'd', action: 'memory.add', input: {}, dependsOn: [], expectedResult: 'e', verification: 'v', risk: 'medium', estimate: { seconds: null } }],
    preconditions: [],
    assertions: [],
    resources: { estimatedSeconds: null },
    approval: { version: 1, contentHash: 'a'.repeat(64) },
    stepResults: { s1: { status: 'completed', operationId: 'missing-operation' } },
    history: [],
  }, {
    operations: { findById: async () => ({ found: false }) },
    plans: { validatePlan: () => ({ ok: true, problems: [] }) },
    forActivation: true,
  });
  assert.equal(validity.ok, false);
  assert.ok(validity.problems.some((p) => /already records 1 executed step/.test(p)));
  assert.ok(validity.problems.some((p) => /is not in the audit log/.test(p)));
});

test('plan history and comparison describe revisions without approving the later one', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const added = await app.controller.planAdd({ outcome: 'the first outcome', steps: [STEP] });
    const planId = added.operation.steps[0].result.data.planId;
    const revised = await app.controller.planRevise({
      target: planId,
      outcome: 'the second outcome',
      steps: [{ ...STEP, description: 'remember the revised fact' }, {
        ...STEP, id: 's2', dependsOn: ['s1'], description: 'read it back', action: 'memory.list', input: {},
      }],
      reason: 'the first wording was incomplete',
    });
    assert.equal(revised.status, Outcome.PLAN_STORED, revised.output);

    const history = await app.controller.planHistory(planId);
    assert.deepEqual(history.versions.map((v) => v.version), [1, 2]);
    assert.equal(history.versions[1].reason, 'the first wording was incomplete');
    assert.match(history.display, /read-only/);

    const comparison = await app.controller.planCompare(planId, { from: 1, to: 2 });
    assert.equal(comparison.diff.unchanged, false);
    assert.ok(comparison.diff.changes.some((c) => c.field === 'outcome'));
    assert.deepEqual(comparison.diff.steps.added, ['s2']);
    assert.match(comparison.display, /not approved by comparing it/);

    const same = await app.controller.planCompare(planId, { from: 1, to: 1 });
    assert.equal(same.diff.unchanged, true);
  } finally {
    cleanup(dir);
  }
});

test('continuation ranks recorded work deterministically and executes nothing', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const created = await app.controller.goalAdd({ request: 'the continuation goal', criteria: ['it is done'], priority: 1 });
    const goalId = created.operation.steps[0].result.data.goalId;
    const historyBefore = (await app.operations.inspect()).records.length;

    const first = await app.controller.continuationReport();
    const second = await app.controller.continuationReport();
    assert.equal(first.candidates[0].ref, goalId);
    assert.equal(first.candidates[0].action, 'accept-goal');
    assert.deepEqual(first.candidates, second.candidates, 'the ranking must be deterministic');
    assert.match(first.display, /started nothing/);
    assert.equal((await app.operations.inspect()).records.length, historyBefore, 'recommendation must write nothing');

    assert.equal((await app.controller.goalUpdate({ target: goalId, status: 'accepted' })).status, Outcome.GOAL_UPDATED);
    const afterAccept = await app.controller.continuationReport();
    assert.equal(afterAccept.candidates[0].action, 'create-plan');
    assert.match(afterAccept.candidates[0].command, /propose --kind plan_create/);
    assert.ok(afterAccept.candidates[0].reasons.some((r) => /suggestion only/.test(r)));
    assert.equal((await app.operations.inspect()).records.length, historyBefore + 1, 'only the explicit update is recorded');
  } finally {
    cleanup(dir);
  }
});

test('a proposal generated from a model is a record only, and stale acceptance is refused', async () => {
  const dir = makeTempDataDir();
  try {
    const proposalLine = `PROPOSE_EXECUTIVE ${JSON.stringify({
      kind: 'plan_create',
      title: 'store the fact',
      rationale: 'the goal names a fact that must be stored',
      changes: {
        outcome: 'the fact is stored',
        steps: [{
          id: 's1',
          description: 'store the fact',
          action: 'memory.add',
          input: { content: 'a proposal test fact' },
          dependsOn: [],
          expectedResult: 'the fact is stored',
          verification: 'read it back',
          criterionId: 'c1',
          risk: 'medium',
          estimate: { seconds: 1 },
        }],
        preconditions: [],
        assertions: [],
        resources: { estimatedSeconds: 1 },
      },
      risk: 'medium',
      assumptions: [],
      unknowns: [],
      invalidation: [],
      evidence: [],
    })}`;
    const app = await appIn(dir, proposalGateway([proposalLine]));
    const goalId = await newActiveGoal(app, 'the proposal goal');

    const proposed = await app.controller.proposeExecutive({
      kind: 'plan_create',
      request: 'plan how to store the fact',
      goal: goalId,
    });
    assert.equal(proposed.status, Outcome.PROPOSAL_CREATED, proposed.output);
    const proposals = await app.proposals.list();
    assert.equal(proposals.length, 1);
    const proposalId = proposals[0].id;
    assert.equal(proposals[0].origin, 'model');
    assert.equal((await app.controller.showGoal(goalId)).goal.planIds.length, 0, 'a proposal must not create a plan');
    assert.equal(app.registry.authorize('proposal.accept', 'model').decision, 'deny');

    // The goal moves on after the proposal was written, so the proposal is now stale.
    assert.equal((await app.controller.goalRevise({
      target: goalId,
      criteria: ['a revised criterion'],
      reason: 'the criterion changed',
    })).status, Outcome.GOAL_UPDATED);

    const accepted = await app.controller.acceptProposal({ target: proposalId });
    // The acceptance action validates its input, then refuses against the live goal revision at
    // execution time, so the step outcome is a failed execution rather than a rejected input.
    assert.equal(accepted.status, Outcome.EXECUTION_FAILED);
    assert.match(accepted.display, /moved from revision 1 to 2|cannot be accepted/);
    assert.equal((await app.controller.showProposal(proposalId)).proposal.decision, null);
    assert.equal((await app.controller.showProposal(proposalId)).assessment.status, ProposalStatus.STALE);
    assert.equal((await app.plans.list()).length, 0);
    assert.equal((await app.controller.showGoal(goalId)).goal.planIds.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('the continuation engine exposes blocked candidates without letting them outrank ready work', async () => {
  const { buildContinuation } = await import('../src/continuation/engine.js');
  const now = new Date('2026-01-10T00:00:00Z');
  const goals = [
    { id: 'g-ready', request: 'ready goal', status: 'accepted', priority: 3, deadline: null, dependsOn: [], criteria: [], planIds: [], taskIds: [] },
    { id: 'g-waiting', request: 'waiting goal', status: 'accepted', priority: 1, deadline: null, dependsOn: ['g-missing'], criteria: [], planIds: [], taskIds: [] },
    { id: 'g-done', request: 'done goal', status: 'completed', priority: 1, deadline: null, dependsOn: [], criteria: [], planIds: [], taskIds: [] },
  ];
  const report = buildContinuation({ goals, plans: [], tasks: [], now });
  const waiting = report.candidates.find((c) => c.ref === 'g-waiting');
  assert.equal(waiting.ready, false);
  assert.ok(waiting.blockers.some((b) => /does not exist/.test(b)));
  assert.equal(report.candidates[0].ref, 'g-ready');
  assert.ok(report.excluded.some((e) => e.ref === 'g-done' && /completed/.test(e.reason)));
});
