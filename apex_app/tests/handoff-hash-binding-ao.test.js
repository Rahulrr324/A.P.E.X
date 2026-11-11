// Batch AO, work package G: the plan activation handoff hashes the live plan bytes once.
//
// The record's plan identity and its approval binding must describe the same bytes. Hashing once is
// an optimization only if the binding still fails closed: a plan that changed after approval, a
// version that moved, or an approval whose hash no longer matches must still produce a denied
// record, and reference validation must still re-hash the live plan.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { planContentHash } from '../src/plans/model.js';
import {
  HandoffState,
  buildPlanActivationHandoff,
  validateHandoff,
  validateHandoffReferences,
} from '../src/executive/handoff.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const CLOCK = () => new Date('2026-11-11T09:00:00.000Z');
const REQUEST_ID = 'a1b2c3d4-0000-4000-8000-000000000000';
const dirs = [];
afterEach(() => {
  while (dirs.length) {
    try { cleanup(dirs.pop()); } catch { /* already removed */ }
  }
});

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

// TEST DOUBLE: fixed text, no model.
function stubGateway() {
  return new ModelGateway({
    backend: {
      name: 'stub-reply',
      provider: 'stub-reply',
      configured: true,
      describe: () => ({ configured: true, provider: 'stub-reply', endpoint: 'stub-reply', model: 'stub-reply' }),
      health: async () => ({ available: true, detail: 'stub reply' }),
      complete: async () => ({
        ok: true, backend: 'stub-reply', provider: 'stub-reply', model: 'stub-reply',
        text: 'unused', finishReason: 'stop', truncated: false, latencyMs: 0,
      }),
    },
  });
}

async function approvedPlan() {
  const dir = tempDir();
  const app = createApp({ dataDir: dir, gateway: stubGateway(), now: CLOCK, experienceCapture: CAPTURE_OFF });
  const added = await app.controller.planAdd({
    outcome: 'the hash fixture plan is approved',
    reason: 'AO-08 hash fixture',
    steps: [1, 2, 3].map((n) => ({
      id: `s${n}`,
      description: `fixture step ${n}`,
      action: 'memory.search',
      input: { query: 'lighthouse' },
      dependsOn: n === 1 ? [] : [`s${n - 1}`],
      expectedResult: 'records are listed',
      verification: 'a record is named',
      risk: 'low',
    })),
  });
  assert.equal(added.status, Outcome.PLAN_STORED, added.display);
  const planId = added.operation.steps[0].result.data.planId;
  const approved = await app.controller.planApprove({ target: planId });
  assert.equal(approved.status, Outcome.PLAN_STORED, approved.display);
  return { app, planId, plan: await app.plans.get(planId) };
}

// A plan activation always names the user task that would run the plan; the record is built before
// the task is executed, so this is the activation identity rather than an executed task.
function activationTask(plan) {
  return {
    id: 'task-ao08-hash',
    planId: plan.id,
    origin: 'user',
    steps: plan.steps.map((step) => ({ id: step.id, status: 'pending' })),
  };
}

describe('AO-08 G7: one hash serves the record identity and the approval binding', () => {
  test('G7.1 the record names the live plan bytes and the stored approval binds them', async () => {
    const { app, plan, planId } = await approvedPlan();
    const hash = planContentHash(plan);
    const record = buildPlanActivationHandoff({ requestId: REQUEST_ID, plan, task: activationTask(plan) });
    assert.equal(record.plan.id, planId);
    assert.equal(record.plan.version, plan.version);
    assert.equal(record.plan.contentHash, hash);
    assert.equal(record.task.planId, planId);
    assert.equal(record.task.stepCount, plan.steps.length);
    assert.equal(record.authorization.decision, 'allow');
    assert.equal(record.authorization.owner, 'plan_approval');
    assert.equal(record.approval.version, plan.version);
    assert.equal(record.approval.contentHash, hash);
    assert.equal(record.approval.at, plan.approval.at);
    assert.equal(record.approval.scope, 'plan_approval');
    const check = validateHandoff(record, { phase: 'prepared' });
    assert.equal(check.ok, true, check.problems?.[0]);
    assert.equal(record.authorizes, false);
    assert.ok(app);
  });

  test('G7.2 two builds over unchanged bytes produce the same record', async () => {
    const { plan } = await approvedPlan();
    const task = activationTask(plan);
    const first = buildPlanActivationHandoff({ requestId: REQUEST_ID, plan, task });
    const second = buildPlanActivationHandoff({ requestId: REQUEST_ID, plan, task });
    assert.deepEqual(first, second);
  });

  test('G7.3 a plan that changed after approval is denied, and the record says why', async () => {
    const { plan } = await approvedPlan();
    const changed = {
      ...plan,
      steps: plan.steps.map((step, i) => (i === 0 ? { ...step, description: 'a description changed after approval' } : step)),
    };
    assert.notEqual(planContentHash(changed), planContentHash(plan));
    const record = buildPlanActivationHandoff({ requestId: REQUEST_ID, plan: changed, task: activationTask(changed) });
    assert.equal(record.approval, null);
    assert.equal(record.authorization.decision, 'deny');
    assert.equal(record.authorization.reason, 'APPROVAL_NOT_BOUND_TO_PLAN');
    assert.equal(record.plan.contentHash, planContentHash(changed), 'the record names the bytes it was built from');
    const check = validateHandoff(record, { phase: 'prepared' });
    assert.equal(check.ok, true, 'a denied record is a structurally valid record');
  });

  test('G7.4 a version that moved after approval is denied', async () => {
    const { plan } = await approvedPlan();
    const moved = { ...plan, version: plan.version + 1 };
    const record = buildPlanActivationHandoff({ requestId: REQUEST_ID, plan: moved, task: activationTask(moved) });
    assert.equal(record.approval, null);
    assert.equal(record.authorization.decision, 'deny');
    assert.equal(validateHandoff(record, { phase: 'prepared' }).ok, true);
  });

  test('G7.5 an approval hash that no longer matches the bytes is denied', async () => {
    const { plan } = await approvedPlan();
    const tampered = { ...plan, approval: { ...plan.approval, contentHash: 'f'.repeat(64) } };
    const record = buildPlanActivationHandoff({ requestId: REQUEST_ID, plan: tampered, task: activationTask(tampered) });
    assert.equal(record.approval, null);
    assert.equal(record.authorization.decision, 'deny');
    assert.equal(validateHandoff(record, { phase: 'prepared' }).ok, true);
  });

  test('G7.6 reference validation still re-hashes the live plan and the live approval', async () => {
    const { app, plan, planId } = await approvedPlan();
    const run = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.display);
    const task = await app.taskStore.get(run.operation.task.id);
    const stepOperations = (task.steps ?? []).filter((s) => s.operationId).map((s) => ({
      id: s.operationId, capability: 'task.step', task: { id: task.id, stepId: s.id }, status: s.outcome,
    }));
    const live = { ...plan, activation: { taskId: task.id, version: plan.version, contentHash: planContentHash(plan) } };
    const record = buildPlanActivationHandoff({ requestId: run.operation.id, plan: live, task });
    assert.equal(record.state, HandoffState.PREPARED);
    assert.equal(validateHandoff(record, { phase: 'prepared' }).ok, true);
    const ok = validateHandoffReferences(record, { plan: live, task, stepOperations });
    assert.equal(ok.ok, true, ok.problems[0]);

    const changed = { ...live, steps: live.steps.map((step, i) => (i === 1 ? { ...step, description: 'changed after the fact' } : step)) };
    const changedCheck = validateHandoffReferences(record, { plan: changed, task, stepOperations });
    assert.equal(changedCheck.ok, false);
    assert.ok(changedCheck.problems.some((problem) => /content hash differs from the live plan/.test(problem)));

    const unapproved = { ...live, approval: null };
    const unapprovedCheck = validateHandoffReferences(record, { plan: unapproved, task, stepOperations });
    assert.equal(unapprovedCheck.ok, false);
    assert.ok(unapprovedCheck.problems.some((problem) => /no recorded approval/.test(problem)));
  });
});
