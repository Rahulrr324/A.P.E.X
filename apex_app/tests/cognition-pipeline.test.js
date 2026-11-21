// T-29 (2026-11-19): the unified cognitive pipeline, tested at its own seams.
//
// These tests are the evidence for the claims the deck makes. They assert that the stages exist
// and are bounded, that a gated step cannot execute without an explicit owner approval, that
// lockdown halts the run before anything is created and leaves an audit record, and that a run
// record describes the task store rather than its own hopes.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { COGNITION_STAGES, PACKET_SCHEMA, RUN_SCHEMA, classifyIntent, epistemicStatus, createCognitivePipeline } from '../src/cognition/pipeline.js';
import { collectHealth } from '../src/health.js';

const dirs = [];
const apps = [];

afterEach(() => {
  while (apps.length) {
    // Nothing global to stop; the objects are garbage once the directory goes.
    apps.pop();
  }
  while (dirs.length) cleanup(dirs.pop());
});

function newApp() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  const app = createApp({ dataDir: dir, gateway: new ModelGateway({ backend: new NoBackend() }) });
  apps.push(app);
  return { app, dir };
}

async function seededApp() {
  const { app, dir } = newApp();
  await app.memory.add({ content: 'the launch checklist covers the staging migration', kind: 'user_fact', source: 'user' });
  await app.knowledge.add({
    claim: 'the staging migration is scheduled before the launch checklist review',
    status: 'supported',
    confidence: 0.82,
    provenance: { origin: 'user_supplied' },
  }).catch(() => null);
  return { app, dir };
}

describe('T-29 stage 1-3: context, salience and Council', () => {
  test('the run record carries a five-stage trace with a context packet and epistemic tags', async () => {
    const { app } = await seededApp();
    const run = await app.cognition.run({ intent: 'what does memory hold about the launch checklist' });

    assert.equal(run.schema, RUN_SCHEMA);
    assert.equal(run.stages.context.schema, PACKET_SCHEMA);
    assert.deepEqual(Object.keys(run.stages), COGNITION_STAGES, 'the trace records exactly the five stages in order');
    const packet = run.stages.context;
    assert.ok(packet.memory.count >= 1, 'the seeded memory record is cited');
    assert.ok(packet.memory.items.every((item) => typeof item.id === 'string'), 'every cited memory item names its record id');
    const tags = packet.epistemic;
    assert.equal(typeof tags.observed, 'number');
    assert.equal(typeof tags.inferred, 'number');
    assert.equal(typeof tags.assumed, 'number');
    assert.equal(typeof tags.predicted, 'number');
    assert.equal(tags.observed + tags.inferred + tags.assumed + tags.predicted,
      packet.knowledge.count + packet.world.count,
      'every knowledge claim and world fact carries exactly one epistemic tag');
    assert.equal(typeof packet.owner.goalCount, 'number');
    assert.ok(Array.isArray(packet.sentinel.advisories));
  });

  test('the salience variables are bounded numbers with a stated basis, and null when unavailable', async () => {
    const { app } = await seededApp();
    const run = await app.cognition.run({ intent: 'what does memory hold about the launch checklist' });
    const salience = run.stages.salience;
    for (const key of ['urgency', 'confidence', 'uncertainty', 'risk_sensitivity', 'novelty']) {
      assert.ok(Number.isFinite(salience[key]), `${key} is a number`);
      assert.ok(salience[key] >= 0 && salience[key] <= 1, `${key} is within 0..1`);
    }
    assert.equal(salience.uncertainty, Math.round((1 - salience.confidence) * 1000) / 1000, 'uncertainty is 1 − confidence');
    assert.equal(salience.goal_progress, null, 'no goal reports criteria, so progress is unavailable rather than invented');
    assert.ok(salience.basis && typeof salience.basis === 'object', 'each variable states its basis');
    assert.equal(typeof salience.basis.goal_progress, 'string');
    assert.ok(Number.isFinite(salience.resource_pressure) || salience.resource_pressure === null, 'resource pressure is a reading or null');
  });

  test('the Council ran with thesis, counter-risk and evidence-check perspectives for a write action', async () => {
    const { app } = await seededApp();
    const run = await app.cognition.run({ intent: 'remember that the launch is friday', action: 'memory.add', input: { content: 'the launch is friday' } });
    const council = run.stages.council;
    assert.equal(council.status, 'ran');
    assert.ok(council.perspectives.thesis, 'a thesis is recorded');
    assert.ok(council.perspectives.counter_risk, 'a counter-risk is recorded');
    assert.ok(council.perspectives.evidence_check, 'an evidence check is recorded');
    assert.equal(council.authorizesExecution, false, 'a recommendation is never an authorization');
    assert.ok(council.recommendation, 'a recommendation is recorded with its own support and confidence');
  });

  test('a read-only intent with low uncertainty may skip the Council, and says why', async () => {
    const { app } = await newApp();
    const run = await app.cognition.run({ intent: 'find the staging migration', action: 'memory.search', input: { query: 'staging migration' } });
    const council = run.stages.council;
    assert.ok(['ran', 'skipped', 'unavailable'].includes(council.status));
    if (council.status === 'skipped') assert.match(council.reason, /not warranted/);
  });
});

describe('T-29 stage 4: governed execution', () => {
  test('a safe read executes end-to-end through the controller and records verified only after completion', async () => {
    const { app } = await seededApp();
    const run = await app.cognition.run({ intent: 'what does memory hold about the launch checklist' });

    assert.equal(run.status, 'completed');
    assert.equal(run.verification.verified, true);
    assert.equal(run.verification.outcome, 'verified');
    assert.equal(run.stages.execution.decision, 'allow');
    assert.equal(run.stages.execution.verified, true);
    const task = await app.taskStore.get(run.taskId);
    assert.equal(task.status, 'completed');
    assert.equal(task.steps[0].outcome, 'success_verified');
    assert.equal(task.steps[0].action, 'memory.search');
  });

  test('a write pauses as awaiting_approval, executes nothing, and runs only after the owner approves', async () => {
    const { app } = await seededApp();
    const probe = 'zulu9c1probe';
    const before = await app.memory.search(probe);
    assert.equal(before.length, 0);

    const run = await app.cognition.run({ intent: `remember that the launch is ${probe}`, action: 'memory.add', input: { content: `the launch is ${probe}` } });
    assert.equal(run.status, 'awaiting_approval');
    assert.equal(run.verification.verified, false, 'nothing is verified before it runs');
    assert.equal(run.approval.required, true);
    assert.deepEqual(run.approval.waitingSteps, ['s1']);
    assert.equal(run.approval.recorded, null, 'no approval is recorded before the owner decides');

    const gatedTask = await app.taskStore.get(run.taskId);
    assert.equal(gatedTask.status, 'paused');
    assert.equal(gatedTask.steps[0].status, 'awaiting_approval');
    assert.equal((await app.memory.search(probe)).length, 0, 'the gated step did not execute');

    const approved = await app.controller.approveTask(run.taskId, { stepId: 's1' });
    assert.equal(approved.status, 'success_verified');
    const afterApproval = await app.taskStore.get(run.taskId);
    assert.equal(afterApproval.steps[0].status, 'pending');
    assert.ok(afterApproval.steps[0].approval, 'the approval is a recorded object, not a UI flag');

    const resumed = await app.controller.runTask(run.taskId, 'resume');
    assert.equal(resumed.status, 'success_verified');
    assert.equal((await app.memory.search(probe)).length, 1, 'the approved step executed');

    const projected = await app.cognition.get(run.runId);
    assert.equal(projected.status, 'completed', 'the run record reflects the task store on read, not a cached hope');
    assert.equal(projected.verification.verified, true);
    assert.equal(projected.approval.recorded.approvedBy, 'user');
    assert.equal(typeof projected.approval.recorded.at, 'string', 'the approval records when the owner decided');
  });

  test('a gated run reads as one approval in health, not as an unexplained paused task', async () => {
    const { app } = await seededApp();
    const run = await app.cognition.run({ intent: 'remember the launch is zulu9c1', action: 'memory.add', input: { content: 'the launch is zulu9c1' } });
    assert.equal(run.status, 'awaiting_approval');
    const health = await collectHealth(app, { checkModel: false });
    const kinds = health.attention.map((item) => item.kind);
    assert.ok(kinds.includes('approval'), 'the waiting step is reported as an approval');
    assert.ok(!kinds.includes('paused-task'), 'the same task is not counted a second time as an unexplained pause');
  });

  test('the run halts fail-closed under an active lockdown, creates no task, and leaves an audit record', async () => {
    const { app } = await seededApp();
    app.ecp.activateKillSwitch({ origin: 'user', reason: 'T-29 lockdown test' });
    const tasksBefore = (await app.taskStore.list({ limit: 50 })).length;

    // The owner-facing path is the registered capability, which is what the UI and CLI call.
    const result = await app.controller.cognitionRun({ intent: 'remember that lockdown blocks writes', action: 'memory.add', input: { content: 'blocked by lockdown' } });
    assert.equal(result.status, 'action_denied', 'the ECP denies the capability while the latch is active');
    const step = result.operation?.steps?.[0];
    assert.equal(step?.authorization?.decision, 'deny');
    assert.equal(step?.authorization?.reason, 'KILL_SWITCH_ACTIVE');

    const operations = await app.operations.list({ limit: 5 });
    assert.match(JSON.stringify(operations), /KILL_SWITCH_ACTIVE/, 'the refusal is in the operation audit trail');
    assert.equal((await app.taskStore.list({ limit: 50 })).length, tasksBefore, 'the task store gained no record');
    assert.equal((await app.memory.search('blocked by lockdown')).length, 0);

    // The pipeline's own latch check is the second layer, for a caller that reaches it directly.
    const direct = await app.cognition.run({ intent: 'remember that lockdown blocks writes', action: 'memory.add', input: { content: 'blocked by lockdown' } });
    assert.equal(direct.status, 'halted');
    assert.equal(direct.halted.reason, 'KILL_SWITCH_ACTIVE');
    assert.equal(direct.taskId, null, 'no task is created under lockdown');
  });

  test('an unreadable kill-switch policy halts the run instead of assuming it is clear', async () => {
    const { app, dir } = await seededApp();
    fs.writeFileSync(path.join(dir, 'kill-switch.json'), '{ this is not json');
    const run = await app.cognition.run({ intent: 'what does memory hold', action: 'memory.search', input: { query: 'launch' } });
    assert.equal(run.status, 'halted');
    assert.equal(run.halted.reason, 'POLICY_UNAVAILABLE');
    assert.equal(run.taskId, null);
  });

  test('an unregistered capability is refused before any stage runs', async () => {
    const { app } = await seededApp();
    await assert.rejects(
      () => app.cognition.run({ intent: 'do something unregistered', action: 'not.a.real.action' }),
      /not registered/,
    );
    assert.equal((await app.cognition.list()).total, 0, 'a refused request records no run');
  });

  test('the capability is registered like any other: owner-only, write, not plannable', async () => {
    const { app } = await newApp();
    const definition = app.registry.get('cognition.run');
    assert.ok(definition, 'cognition.run is registered');
    assert.equal(definition.permission, 'write');
    assert.deepEqual(definition.origins, ['user']);
    assert.equal(definition.plannable, false);
    const modelDecision = app.registry.authorize('cognition.run', 'model', { phase: 'execute' });
    assert.equal(modelDecision.decision, 'deny', 'a model cannot start a cognitive run');
  });
});

describe('T-29 helpers and storage', () => {
  test('epistemic tagging is decided by fixed rules over the record, not by the caller', () => {
    assert.equal(epistemicStatus({ confidence: 0.9, provenance: { evidenceIds: ['e1'] } }), 'observed');
    assert.equal(epistemicStatus({ confidence: 0.4 }), 'inferred');
    assert.equal(epistemicStatus({ confidence: 0.95, provenance: { origin: 'prediction' } }), 'predicted');
    assert.equal(epistemicStatus({ status: 'assumed' }), 'assumed');
  });

  test('intent classification is deterministic and only names registered capabilities', async () => {
    const { app } = await newApp();
    for (const intent of ['remember that the release is monday', 'find the release notes', 'what changed last week']) {
      const selected = classifyIntent(intent);
      assert.ok(app.registry.get(selected.action), `${selected.action} is registered`);
      assert.equal(typeof selected.rule, 'string');
    }
  });

  test('the run store is append-only and a corrupt line is reported rather than hidden', async () => {
    const { app, dir } = await seededApp();
    await app.cognition.run({ intent: 'what does memory hold', action: 'memory.search', input: { query: 'launch' } });
    const file = path.join(dir, 'cognition-runs.jsonl');
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
    fs.appendFileSync(file, '{ this line is damaged\n');
    const listed = await app.cognition.list();
    assert.equal(listed.corrupt, 1, 'the damaged line is counted, not silently dropped');
    assert.equal(listed.runs.length, 1, 'the readable run is still returned');
  });

  test('a pipeline cannot be constructed without the ECP, registry and controller', () => {
    assert.throws(() => createCognitivePipeline(), /data directory/);
    const dir = makeTempDataDir();
    dirs.push(dir);
    assert.throws(() => createCognitivePipeline({ dataDir: dir }), /ActionRegistry/);
  });
});
