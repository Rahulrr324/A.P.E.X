// T-10 acceptance tests. Every scenario drives the public runtime surface, the controller, the
// registered task/plan stores, the CLI or the local UI. Nothing reaches into a private helper, and
// no test starts an inference process, opens a socket for the runtime, or installs a service.
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { createUiServer } from '../src/ui/server.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const TOKEN = 't10-ui-token-0123456789abcdef';
const dirs = [];
const uis = [];
const runtimes = [];

afterEach(async () => {
  while (runtimes.length) {
    const runtime = runtimes.pop();
    await runtime.stop({ reason: 'test cleanup' }).catch(() => {});
  }
  while (uis.length) await uis.pop().stop().catch(() => {});
  while (dirs.length) cleanup(dirs.pop());
});

function appOn(options = {}) {
  const dir = makeTempDataDir();
  dirs.push(dir);
  const app = createApp({ dataDir: dir, ...options });
  app.__dir = dir;
  return app;
}

const dataOf = (res) => res?.operation?.steps?.[0]?.result?.data ?? null;

async function start(app, options = {}) {
  runtimes.push(app.runtime);
  return app.runtime.start({ intervalMs: 0, ...options });
}

async function makeGoal(app, { request = 'Ship the report', priority = 5, deadline = null, dependsOn = [] } = {}) {
  const res = await app.controller.goalAdd({
    request,
    criteria: ['the report is delivered'],
    priority,
    ...(deadline ? { deadline } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  });
  assert.equal(res.status, Outcome.GOAL_CREATED, res.output ?? res.display);
  return dataOf(res).goalId;
}

function memorySteps(content, id = 's1') {
  return [{
    id,
    description: 'record the delivery',
    action: 'memory.add',
    input: { content },
    dependsOn: [],
    expectedResult: 'a memory record',
    verification: 'read it back',
    risk: 'medium',
  }];
}

async function makePlan(app, goalId, { content = 'report delivered', approve = true } = {}) {
  const res = await app.controller.planAdd({ goalId, outcome: 'the report is delivered', steps: memorySteps(content) });
  assert.equal(res.status, Outcome.PLAN_STORED, res.output ?? res.display);
  const planId = dataOf(res).planId;
  if (approve) {
    const approved = await app.controller.planApprove({ target: planId });
    assert.ok([Outcome.SUCCESS_VERIFIED, Outcome.PLAN_STORED].includes(approved.status), approved.output ?? approved.display);
  }
  return planId;
}

async function seedTask(app, { status = 'completed', planId = null, goalId = null, origin = 'user' } = {}) {
  const taskId = randomUUID();
  await app.taskStore.createTask({
    taskId,
    goal: 'runtime fixture',
    origin,
    planner: 'deterministic',
    ...(goalId ? { goalId } : {}),
    ...(planId ? { planId } : {}),
    steps: [{ id: 's1', description: 'read the status', action: 'app.status', input: {}, permission: 'read', dependsOn: [] }],
  });
  const created = await app.taskStore.get(taskId);
  await app.taskStore.transition(taskId, {
    reason: 'the fixture started',
    task: { from: created.status, to: 'running' },
    steps: [{ id: 's1', from: 'pending', to: 'running' }],
  }).catch(async (err) => {
    // A model-origin task stays proposed until the user approves it; that is the case scenario 13
    // needs. Any other refusal is a fixture error.
    if (origin === 'model') return;
    throw err;
  });
  if (status === 'completed') {
    await app.taskStore.transition(taskId, {
      reason: 'the fixture completed',
      task: { from: 'running', to: 'completed' },
      steps: [{ id: 's1', from: 'running', to: 'completed', outcome: Outcome.SUCCESS_VERIFIED }],
    });
  } else if (status === 'failed') {
    await app.taskStore.transition(taskId, {
      reason: 'the fixture failed',
      task: { from: 'running', to: 'failed' },
      steps: [{ id: 's1', from: 'running', to: 'failed', outcome: Outcome.EXECUTION_FAILED }],
    });
  }
  return taskId;
}

function ingest(app, spec) {
  return app.controller.situationIngest({
    source: 'test_provider',
    sourceEventId: `evt-${randomUUID()}`,
    type: 'observation',
    category: 'external',
    payload: { summary: 'an observation' },
    confidence: 0.9,
    ...spec,
  });
}

async function runtimeEvents(app, type) {
  const page = dataOf(await app.controller.situationEvents({ limit: 100 }));
  return page.rows.filter((row) => row.event.type === type);
}

describe('T-10 continuous executive runtime', () => {
  test('Scenario 1: the runtime starts, ticks and restores its persistent identity and checkpoint', async () => {
    const first = appOn();
    const started = await start(first);
    assert.equal(started.started, true, started.reason);
    assert.equal(started.lifecycle, 'running');
    assert.match(started.runtimeId, /^[0-9a-f-]{36}$/);
    assert.ok(fs.existsSync(path.join(first.__dir, 'runtime.json')), 'no checkpoint was written');
    assert.ok(fs.existsSync(path.join(first.__dir, 'runtime.lock')), 'no lease was written');

    assert.equal((await runtimeEvents(first, 'runtime_started')).length, 1, 'the runtime_started event was not published');
    const ticked = await first.runtime.tick();
    assert.equal(ticked.ran, true, ticked.reason);
    const before = await first.runtime.status();
    assert.ok(before.checkpoint.processed >= 1);
    assert.equal(before.lifecycle, 'running');
    const stopped = await first.runtime.stop({ reason: 'scenario 1' });
    assert.equal(stopped.stopped, true);

    const second = appOn({ dataDir: first.__dir });
    const restarted = await start(second, { intervalMs: 60 });
    assert.equal(restarted.started, true, restarted.reason);
    assert.equal(restarted.runtimeId, started.runtimeId, 'the runtime identity was not persisted');
    assert.equal(restarted.boots, 2);
    // The foreground cycle is a real timer: it advances without another tick call.
    await new Promise((resolve) => setTimeout(resolve, 220));
    const after = await second.runtime.status();
    assert.ok(after.ticks >= 2, `the timed cycle did not run automatically (ticks ${after.ticks})`);
    assert.equal(after.lease.held, true, 'the restarted runtime does not hold its lease');
    assert.ok(after.checkpoint.processed >= before.checkpoint.processed, 'the checkpoint shrank across a restart');
    assert.equal(after.lifecycle, 'running');
  });

  test('Scenario 2: repeated start attempts never create a second worker', async () => {
    const app = appOn();
    const first = await start(app);
    const again = await app.runtime.start({ intervalMs: 0 });
    assert.equal(again.started, false);
    assert.equal(again.duplicate, true);
    assert.match(again.reason, /already active|already running/);

    const second = appOn({ dataDir: app.__dir });
    const other = await second.runtime.start({ intervalMs: 0 });
    assert.equal(other.started, false, 'a second runtime started against the same directory');
    assert.equal(other.duplicate, true);
    assert.equal((await app.runtime.status()).lifecycle, 'running');
    assert.equal((await app.runtime.status()).boots, 1);
    assert.ok(first.started);
  });

  test('Scenario 3: task lifecycle transitions publish events without an explicit ingest call', async () => {
    const app = appOn();
    await start(app);
    const taskId = await seedTask(app, { status: 'completed' });
    await app.runtime.tick();
    const completed = await runtimeEvents(app, 'task_completed');
    assert.ok(completed.some((row) => row.event.taskRefs.includes(taskId)), 'task_completed was not published');
    assert.equal(completed[0].event.source, 'runtime');
    const status = await app.runtime.status();
    assert.ok(status.counts.eventsProcessed >= 1);
  });

  test('Scenario 4: cancelling an approved plan automatically records a plan event', async () => {
    const app = appOn();
    await start(app);
    const goalId = await makeGoal(app);
    const planId = await makePlan(app, goalId, { content: 'cancelled plan fixture' });
    const cancelled = await app.controller.planCancel({ target: planId, reason: 'no longer needed' });
    assert.ok([Outcome.SUCCESS_VERIFIED, Outcome.PLAN_STORED].includes(cancelled.status), cancelled.output ?? cancelled.display);
    await app.runtime.tick();
    const rows = await runtimeEvents(app, 'plan_cancelled');
    assert.ok(rows.some((row) => row.event.planRefs.includes(planId)), 'the plan cancellation was not published');
  });

  test('Scenario 5: ingested events are processed by the runtime, not by a manual decide call', async () => {
    const app = appOn();
    await start(app);
    const res = await ingest(app, { sourceEventId: 'runtime-5', type: 'gate_opened', category: 'observation' });
    const eventId = dataOf(res).id;
    const ticked = await app.runtime.tick();
    assert.ok(ticked.processed >= 1, 'the event was not processed');
    const page = dataOf(await app.controller.situationDecisions({ limit: 20 }));
    const decision = page.decisions.find((row) => row.eventId === eventId);
    assert.ok(decision, 'no decision was recorded for the event');
    assert.notEqual(decision.response, 'execute', 'the runtime must never choose execution');
  });

  test('Scenario 6: a duplicate event is processed only once across repeated ticks', async () => {
    const app = appOn();
    await start(app);
    const spec = { sourceEventId: 'runtime-6', type: 'gate_opened', category: 'observation' };
    await ingest(app, spec);
    await ingest(app, spec);
    await app.runtime.tick();
    const first = await app.runtime.status();
    const secondTick = await app.runtime.tick();
    assert.equal(secondTick.processed, 0, 'a processed event was processed again');
    const page = dataOf(await app.controller.situationDecisions({ limit: 50 }));
    const done = page.decisions.filter((row) => row.eventId === page.decisions[0].eventId);
    assert.equal(done.length, 1);
    assert.equal((await app.runtime.status()).checkpoint.processed, first.checkpoint.processed);
  });

  test('Scenario 7: processing checkpoints survive a restart', async () => {
    const app = appOn();
    await start(app);
    const observationId = dataOf(await ingest(app, { sourceEventId: 'runtime-7', type: 'gate_opened', category: 'observation' })).id;
    await app.runtime.tick();
    const processed = (await app.runtime.status()).checkpoint.processed;
    assert.ok(processed >= 2, 'the event and the runtime_started event were not checkpointed');
    await app.runtime.stop({ reason: 'scenario 7' });

    const restarted = appOn({ dataDir: app.__dir });
    await start(restarted);
    const result = await restarted.runtime.tick();
    // At most this boot's own runtime_started notice is new; the observation that was already
    // decided before the restart is never processed again.
    assert.ok(result.processed <= 1, 'an already-processed event was processed after restart');
    assert.ok((await restarted.runtime.status()).checkpoint.processed >= processed);
    const decisions = dataOf(await restarted.controller.situationDecisions({ limit: 100 }));
    const forObservation = decisions.decisions.filter((row) => row.eventId === observationId);
    assert.equal(forObservation.length, 1, 'the restarted runtime decided the observation again');
  });

  test('Scenario 8: a future schedule is not eligible early, and becomes eligible at its time', async () => {
    const app = appOn();
    await start(app);
    const goalId = await makeGoal(app);
    const planId = await makePlan(app, goalId, { content: 'scheduled delivery' });
    await app.runtime.schedule(planId, { at: new Date(Date.now() + 3600_000).toISOString(), reason: 'later' });
    const early = await app.runtime.tick();
    assert.equal(early.executed.length, 0, 'a future plan was started early');
    assert.ok(early.skipped.some((s) => s.planId === planId && /scheduled/.test(s.reason)));
    assert.equal((await app.plans.get(planId)).status, 'approved');

    await app.runtime.schedule(planId, { at: new Date(Date.now() - 1000).toISOString(), reason: 'now' });
    const due = await app.runtime.tick();
    assert.equal(due.executed.length, 1, 'the due plan was not executed');
    assert.equal(due.executed[0].status, 'completed');
    assert.equal((await app.plans.get(planId)).status, 'completed');
  });

  test('Scenario 9: deadline monitoring identifies an approaching deadline automatically', async () => {
    const app = appOn();
    await start(app);
    await makeGoal(app, { request: 'Due soon', deadline: new Date(Date.now() + 3600_000).toISOString() });
    await app.runtime.tick();
    const rows = await runtimeEvents(app, 'deadline_approaching');
    assert.equal(rows.length, 1, 'the approaching deadline was not published');
    assert.match(rows[0].event.payload.summary, /due within 1 hour/);
  });

  test('Scenario 10: goal dependencies prevent premature execution', async () => {
    const app = appOn();
    await start(app);
    const prerequisite = await makeGoal(app, { request: 'Prerequisite work' });
    const dependent = await makeGoal(app, { request: 'Dependent work', dependsOn: [prerequisite] });
    const planId = await makePlan(app, dependent, { content: 'dependent delivery', approve: false });
    // The existing approval gate refuses the plan before the runtime could ever see it as runnable.
    const refused = await app.controller.planApprove({ target: planId });
    assert.equal(refused.status, Outcome.EXECUTION_FAILED);
    assert.match(refused.output, /unmet_dependency/);
    const ticked = await app.runtime.tick();
    assert.equal(ticked.executed.length, 0, 'a dependent plan ran before its prerequisite completed');
    assert.equal((await app.plans.get(planId)).status, 'draft');
  });

  test('Scenario 11: a failed task produces an executive decision and an attention notice', async () => {
    const app = appOn();
    await start(app);
    const taskId = await seedTask(app, { status: 'failed' });
    const ticked = await app.runtime.tick();
    assert.ok(ticked.decisions >= 1, 'the failed task produced no decision');
    const events = dataOf(await app.controller.situationEvents({ limit: 50 }));
    const failed = events.rows.find((row) => row.event.type === 'task_failed' && row.event.taskRefs.includes(taskId));
    assert.ok(failed, 'task_failed was not published');
    const notice = (await app.runtime.notifications()).notifications.find((n) => n.eventId === failed.event.id);
    assert.ok(notice, 'the failure did not reach the notification surface');
    const state = await app.runtime.status();
    assert.ok(state.notifications.active >= 1);
    assert.ok(state.blockedTasks.some((task) => task.id === taskId));
  });

  test('Scenario 12: an eligible approved plan executes through the existing task and action framework', async () => {
    const app = appOn();
    await start(app);
    const goalId = await makeGoal(app);
    const planId = await makePlan(app, goalId, { content: 'the runtime wrote this' });
    const ticked = await app.runtime.tick();
    assert.equal(ticked.executed.length, 1);
    assert.equal(ticked.executed[0].planId, planId);
    assert.equal(ticked.executed[0].status, 'completed');
    const tasks = await app.taskStore.list();
    const task = tasks.find((row) => row.planId === planId);
    assert.ok(task, 'the plan was not run as an existing task');
    assert.equal(task.status, 'completed');
    const memory = await app.memory.list({ limit: 50 });
    assert.ok(memory.includes('the runtime wrote this') || JSON.stringify(memory).includes('the runtime wrote this'));
    const audit = await app.operations.list({ limit: 20 });
    assert.ok(audit.records.length > 0, 'the execution left no audit record');
  });

  test('Scenario 13: a proposed model task blocks its plan instead of being executed', async () => {
    const app = appOn();
    await start(app);
    const goalId = await makeGoal(app);
    const planId = await makePlan(app, goalId, { content: 'unauthorized fixture' });
    const taskId = await seedTask(app, { status: 'proposed', planId, goalId, origin: 'model' });
    const ticked = await app.runtime.tick();
    assert.equal(ticked.executed.length, 0, 'the plan ran despite an unauthorized task in flight');
    assert.ok(ticked.skipped.some((s) => s.planId === planId && /task for this plan is/.test(s.reason)));
    assert.equal((await app.taskStore.get(taskId)).status, 'proposed');
    assert.equal((await app.plans.get(planId)).status, 'approved');
  });

  test('Scenario 14: a task failure causes a situational reassessment with recovery guidance', async () => {
    const app = appOn();
    await start(app);
    await seedTask(app, { status: 'failed' });
    await app.runtime.tick();
    const state = await app.situation.state({ limit: 20 });
    assert.ok(state.counts.events >= 1);
    assert.ok(state.counts.decisions >= 1, 'no decision was made about the failure');
    const failed = state.recent.find((row) => row.type === 'task_failed');
    assert.ok(failed, 'the failure is missing from the situational state');
    assert.ok(failed.recommended !== null);
    assert.equal(failed.decision.response, 'notify', 'the failure should require attention, not be silently recorded');
    assert.ok(state.alerts.some((alert) => alert.type === 'task_failed') || failed.significance.level === 'medium');
  });

  test('Scenario 15: an interrupted task is reported and left for an explicit decision', async () => {
    const app = appOn();
    await start(app);
    const taskId = await seedTask(app, { status: 'running' });
    await app.runtime.stop({ reason: 'simulated termination' });

    const restarted = appOn({ dataDir: app.__dir });
    const started = await start(restarted);
    assert.ok(started.interrupted.includes(taskId), 'the interrupted task was not reported at start');
    assert.equal((await runtimeEvents(restarted, 'runtime_recovered')).length, 1, 'the restart did not publish a recovery event');
    const status = await restarted.runtime.status();
    assert.ok(status.interrupted.some((task) => task.id === taskId));
    assert.equal((await restarted.taskStore.get(taskId)).status, 'running');
    const recovered = await restarted.taskStore.recover();
    assert.ok(recovered, 'the existing task recovery path did not answer');
  });

  test('Scenario 16: a completed consequential action is not repeated after a restart', async () => {
    const app = appOn();
    await start(app);
    const goalId = await makeGoal(app);
    const planId = await makePlan(app, goalId, { content: 'exactly once delivery' });
    await app.runtime.tick();
    const count = async (instance) => (await instance.memory.list({ limit: 100 })).filter((row) => JSON.stringify(row).includes('exactly once delivery')).length;
    assert.equal(await count(app), 1);
    await app.runtime.stop({ reason: 'scenario 16' });

    const restarted = appOn({ dataDir: app.__dir });
    await start(restarted);
    await restarted.runtime.tick();
    await restarted.runtime.tick();
    assert.equal(await count(restarted), 1, 'the completed action was executed a second time');
    assert.equal((await restarted.plans.get(planId)).status, 'completed');
  });

  test('Scenario 17: retry limits and backoff are enforced, ending in a dead letter', async () => {
    let clock = Date.now();
    const app = appOn({ now: () => new Date(clock) });
    await start(app);
    const goalId = await makeGoal(app);
    const planId = await makePlan(app, goalId, { content: 'retry fixture' });
    app.runtime.config.retry = { maxAttempts: 3, baseDelayMs: 60_000, multiplier: 1 };
    const original = app.controller.planActivate;
    app.controller.planActivate = async () => { throw new Error('simulated activation failure'); };
    try {
      const first = await app.runtime.tick();
      assert.equal(first.retries, 1, 'the failure did not schedule a retry');
      let status = await app.runtime.status();
      assert.equal(status.retries[0].attempts, 1);
      assert.match(status.retries[0].nextAt, /^\d{4}-\d{2}-\d{2}T/);
      const immediate = await app.runtime.tick();
      assert.equal(immediate.executed.length, 0, 'a retry ran before its backoff elapsed');
      clock += 61_000;
      await app.runtime.tick();
      clock += 61_000;
      await app.runtime.tick();
      status = await app.runtime.status();
      assert.ok(status.deadLetters.some((row) => row.kind === 'plan' && row.ref === planId && row.reason === 'retry_exhausted'), 'the retry limit did not dead-letter the plan');
      assert.equal((await app.plans.get(planId)).status, 'approved');
    } finally {
      app.controller.planActivate = original;
    }
  });

  test('Scenario 18: an event storm is bounded by the queue, batch and notification limits', async () => {
    const app = appOn();
    await start(app);
    for (let i = 0; i < 40; i += 1) {
      await ingest(app, { sourceEventId: `storm-${i}`, type: 'gate_opened', category: 'observation' });
    }
    const config = app.runtime.config;
    const first = await app.runtime.tick();
    assert.ok(first.processed <= config.maxEventsPerTick, `processed ${first.processed} events in one tick`);
    const status = await app.runtime.status();
    assert.ok(status.backlog > 0, 'the backlog is not visible');
    assert.ok(status.backlog <= config.maxBacklog, 'the backlog exceeded its bound');
    assert.ok(status.notifications.total <= config.maxNotifications);
    const seen = new Set();
    for (let i = 0; i < 12; i += 1) {
      const tick = await app.runtime.tick();
      if (tick.processed === 0) break;
      for (const execution of tick.executed) seen.add(execution.planId);
    }
    const final = await app.runtime.status();
    assert.ok(final.checkpoint.processed <= 40 + 10, 'the checkpoint grew beyond the event count');
    assert.ok(final.notifications.active <= 40);
  });

  test('Scenario 19: completed runtime work is evaluated by the T-08 learning system', async () => {
    const app = appOn();
    await start(app);
    const goalId = await makeGoal(app);
    await makePlan(app, goalId, { content: 'learning link fixture' });
    const ticked = await app.runtime.tick();
    assert.equal(ticked.executed.length, 1);
    assert.ok(ticked.executed[0].learning, 'the runtime did not record an evaluation');
    assert.equal(ticked.executed[0].learning.planId, ticked.executed[0].planId);
    assert.match(ticked.executed[0].learning.evaluationId, /^[0-9a-f-]{36}$/);
  });

  test('Scenario 20: graceful shutdown preserves queued work and the schedule', async () => {
    const app = appOn();
    await start(app);
    const goalId = await makeGoal(app);
    const planId = await makePlan(app, goalId, { content: 'shutdown fixture' });
    const at = new Date(Date.now() + 3600_000).toISOString();
    await app.runtime.schedule(planId, { at, reason: 'after the shutdown' });
    await ingest(app, { sourceEventId: 'shutdown-queued', type: 'gate_opened', category: 'observation' });
    const stopped = await app.runtime.stop({ reason: 'scenario 20' });
    assert.equal(stopped.stopped, true);
    assert.equal((await app.runtime.status()).lifecycle, 'stopped');

    const restarted = appOn({ dataDir: app.__dir });
    await start(restarted);
    const status = await restarted.runtime.status();
    assert.ok(status.schedule.some((entry) => entry.planId === planId && entry.at === at), 'the schedule was lost');
    const ticked = await restarted.runtime.tick();
    assert.ok(ticked.processed >= 1, 'the queued event was lost');
    assert.equal(ticked.executed.length, 0, 'the future plan ran during recovery');
  });

  test('Scenario 21: a damaged checkpoint is quarantined and recovery is reported', async () => {
    const app = appOn();
    await start(app);
    await app.runtime.tick();
    await app.runtime.stop({ reason: 'scenario 21' });
    fs.writeFileSync(path.join(app.__dir, 'runtime.json'), '{"schema":"apex.runtime/1","lifecycle":"running"');
    const restarted = appOn({ dataDir: app.__dir });
    const started = await start(restarted);
    assert.equal(started.started, true, started.reason);
    assert.ok(started.corruption, 'the damage was not reported');
    assert.match(started.corruption.reason, /not valid JSON/);
    const quarantined = fs.readdirSync(app.__dir).filter((name) => name.startsWith('runtime.corrupt-'));
    assert.equal(quarantined.length, 1, 'the damaged checkpoint was not preserved');
    const report = await restarted.runtime.diagnose();
    assert.ok(report.checks.some((check) => check.name === 'checkpoint readable' && check.ok));
    assert.ok(report.checks.some((check) => check.name === 'inference' && check.ok));
  });

  test('Scenario 22: the CLI and the local UI represent the actual runtime state', async () => {
    const app = appOn();
    await start(app);
    const status = await app.runtime.status();
    const cliStatus = await runCli(['runtime', 'status'], cleanEnv({ APEX_DATA_DIR: app.__dir }));
    assert.equal(cliStatus.code, 0, cliStatus.stderr);
    assert.match(cliStatus.stdout, new RegExp(`Runtime ${status.runtimeId} is running`));
    assert.match(cliStatus.stdout, /lease: held/);
    const diagnose = await runCli(['runtime', 'diagnose'], cleanEnv({ APEX_DATA_DIR: app.__dir }));
    assert.equal(diagnose.code, 0, diagnose.stdout + diagnose.stderr);
    assert.match(diagnose.stdout, /No model or inference handle is held/);

    const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    uis.push(ui);
    const response = await fetch(`http://127.0.0.1:${started.port}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.runtime.lifecycle, 'running');
    assert.equal(body.runtime.runtimeId, status.runtimeId);
    assert.ok(Array.isArray(body.runtime.activePlans));
    const direct = await fetch(`http://127.0.0.1:${started.port}/api/runtime`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(direct.status, 200);
    assert.equal((await direct.json()).lifecycle, 'running');
  });
});
