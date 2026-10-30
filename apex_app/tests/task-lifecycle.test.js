// Task lifecycle integrity: states are only changed by the runner, an interrupted
// task can still be stopped, a retry does not inherit the previous attempt's result,
// and a task log that claims an impossible step outcome is refused rather than
// reported as success.
//
// TEST DOUBLES are labelled: the plan gateway returns fixed text, and the crashes are
// injected by failing one store transition. They exercise real state transitions,
// side effects, and persistence; they are not model-inference evidence.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { ValidationError, StoreError } from '../src/errors.js';
import { TaskStore } from '../src/tasks/store.js';
import {
  TaskStatus, StepStatus, TASK_TRANSITIONS, STEP_TRANSITIONS, applyEvent, canTransition,
} from '../src/tasks/model.js';
import { randomUUID } from 'node:crypto';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const d = makeTempDataDir();
  dirs.push(d);
  return d;
}

function appOn(dataDir, gateway) {
  return createApp({ dataDir, gateway, extraActions: [taskWriteAction()] });
}

const writes = [];
function taskWriteAction() {
  return {
    name: 'test.write',
    description: 'test-only write used to check that approval is not execution',
    permission: 'write',
    origins: ['user'],
    inputHint: '{"content":"text"}',
    validate: (input) => input,
    async execute(_ctx, input) {
      writes.push(input.content);
      return { summary: 'test write stored', data: { content: input.content } };
    },
    async verify(_ctx, input) {
      return { ok: writes.includes(input.content), detail: 'write appears in the test sink' };
    },
  };
}

// TEST DOUBLE: fixed plan reply; it proves how a reply is handled, not what a model says.
function planGateway(reply) {
  const backend = {
    name: 'test-double',
    provider: 'test-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'test-double', endpoint: 'test-double', model: 'test-double' }),
    health: async () => ({ available: true, detail: 'test double' }),
    complete: async () => ({ ok: true, backend: 'test-double', provider: 'test-double', model: 'test-double', text: reply, finishReason: 'stop', truncated: false, latencyMs: 0 }),
  };
  return new ModelGateway({ backend });
}

async function onlyTask(app) {
  const tasks = await app.taskStore.list();
  assert.equal(tasks.length, 1, `expected one task, found ${tasks.length}`);
  return tasks[0];
}

async function stepOps(app) {
  const { records } = await app.operations.list({ limit: 1000 });
  return records.filter((r) => r.capability === 'task.step');
}

describe('task lifecycle integrity', () => {
  test('approving a model plan marks it pending; neither approval nor a run executes the model write', async () => {
    writes.length = 0;
    const reply = JSON.stringify({
      steps: [{ id: 's1', description: 'save a fact', action: 'test.write', input: { content: 'approved later' }, depends_on: [] }],
    });
    const dataDir = tempDir();
    const app = appOn(dataDir, planGateway(reply));

    const planned = await app.controller.planTask('organise my week and save a fact');
    assert.equal(planned.status, Outcome.PLAN_PROPOSED);
    const proposed = await onlyTask(app);
    assert.equal(proposed.status, TaskStatus.PROPOSED);
    assert.deepEqual(proposed.steps.map((s) => s.status), [StepStatus.PENDING]);

    const approved = await app.controller.approveTask(proposed.id);
    assert.equal(approved.status, Outcome.SUCCESS_VERIFIED);
    const pending = await app.taskStore.get(proposed.id);
    assert.equal(pending.status, TaskStatus.PENDING);
    assert.deepEqual(pending.steps.map((s) => s.status), [StepStatus.PENDING]);
    assert.deepEqual(writes, [], 'approving the plan did not execute its write');
    assert.equal((await stepOps(app)).length, 0, 'no step was executed');

    const run = await app.controller.runTask(proposed.id, 'run');
    assert.equal(run.status, Outcome.TASK_PAUSED);
    const paused = await app.taskStore.get(proposed.id);
    assert.deepEqual(paused.steps.map((s) => s.status), [StepStatus.AWAITING_APPROVAL]);
    assert.deepEqual(writes, [], 'a model-origin write still waits for its own approval');
    assert.equal((await stepOps(app)).length, 0);
  });

  test('a retry clears the previous attempt\'s result, and resume never repeats a completed step', async () => {
    const dataDir = tempDir();
    let attempts = 0;
    // TEST DOUBLE: a read that fails once and succeeds on the explicit retry.
    const flaky = {
      name: 'test.flaky',
      description: 'test-only read that fails on its first attempt',
      permission: 'read',
      origins: ['user', 'model'],
      inputHint: '{}',
      validate: (input) => input,
      async execute() {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('transient read failure');
          err.code = 'TRANSIENT';
          throw err;
        }
        return { summary: 'flaky read ok', data: { attempts } };
      },
      async verify(_ctx, _input, result) {
        return { ok: result.data.attempts >= 2, detail: 'second attempt' };
      },
    };
    const app = createApp({ dataDir, extraActions: [flaky] });
    const taskId = randomUUID();
    const step = (id, action, input, dependsOn) => ({ id, description: `${action} ${id}`, action, permission: 'read', input, dependsOn });
    await app.taskStore.createTask({
      taskId,
      goal: 'a flaky read then a calc',
      origin: 'user',
      planner: 'deterministic',
      steps: [
        step('s1', 'test.flaky', {}, []),
        step('s2', 'calc.evaluate', { expression: '2+2' }, ['s1']),
      ],
    });

    const failed = await app.controller.runTask(taskId, 'run');
    assert.equal(failed.status, Outcome.EXECUTION_FAILED);
    const afterFailure = await app.taskStore.get(taskId);
    const failedOperationId = afterFailure.steps[0].operationId;
    assert.equal(afterFailure.steps[0].status, StepStatus.FAILED);
    assert.equal(afterFailure.steps[0].outcome, Outcome.EXECUTION_FAILED);
    assert.match(afterFailure.steps[0].summary, /transient read failure/);
    assert.ok(failedOperationId);
    assert.equal(afterFailure.steps[1].status, StepStatus.SKIPPED);

    const retry = await app.controller.retryTask(taskId, 's1');
    assert.equal(retry.status, Outcome.SUCCESS_VERIFIED);
    const retried = await app.taskStore.get(taskId);
    assert.equal(retried.status, TaskStatus.PAUSED);
    for (const s of retried.steps) {
      assert.equal(s.status, StepStatus.PENDING);
      assert.equal(s.outcome, null, `${s.id}: a pending step must not keep a failed outcome`);
      assert.equal(s.summary, null, `${s.id}: a pending step must not keep the old summary`);
      assert.equal(s.operationId, null, `${s.id}: the re-run gets a new operation id`);
    }
    const shown = (await app.controller.showTask(taskId)).display;
    assert.doesNotMatch(shown, /transient read failure/, 'a pending step is not displayed as failed');

    const done = await app.controller.runTask(taskId, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED);
    const completed = await app.taskStore.get(taskId);
    assert.equal(completed.status, TaskStatus.COMPLETED);

    const ops = await stepOps(app);
    const s1 = ops.filter((r) => r.task.stepId === 's1');
    const s2 = ops.filter((r) => r.task.stepId === 's2');
    assert.equal(s1.length, 2, 'the failed attempt and the explicit retry are both recorded');
    assert.deepEqual(s1.map((r) => r.status).sort(), [Outcome.EXECUTION_FAILED, Outcome.SUCCESS_VERIFIED].sort());
    assert.notEqual(s1[0].id, s1[1].id, 'each attempt has its own operation id');
    assert.equal(s2.length, 1, 'the completed second step ran exactly once');
    for (const r of [...s1, ...s2]) assert.equal(r.task.id, taskId);

    const again = await app.controller.retryTask(taskId, 's1');
    assert.equal(again.status, Outcome.INPUT_REJECTED, 'a completed step cannot be retried');
  });

  test('an interruption between steps keeps the completed step and resumes only the unfinished one', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    await app.controller.planTask('calc 1+1; calc 2+2');
    const task = await onlyTask(app);

    // TEST DOUBLE fault: the process dies after s1 completed, before s2 is marked running.
    const original = app.taskStore.transition.bind(app.taskStore);
    let injected = false;
    app.taskStore.transition = async (taskId, ev) => {
      if (!injected && ev.steps?.some((s) => s.id === 's2' && s.to === 'running')) {
        injected = true;
        throw new Error('simulated process death between steps');
      }
      return original(taskId, ev);
    };
    await assert.rejects(app.controller.runTask(task.id, 'run'), /simulated process death between steps/);
    const interrupted = await app.taskStore.get(task.id);
    assert.equal(interrupted.status, TaskStatus.RUNNING, 'the process did not finish the task');
    assert.deepEqual(interrupted.steps.map((s) => s.status), [StepStatus.COMPLETED, StepStatus.PENDING]);
    assert.equal(interrupted.steps[0].outcome, Outcome.SUCCESS_VERIFIED);
    const completedOperationId = interrupted.steps[0].operationId;

    const before = await stepOps(app);
    assert.equal(before.length, 1, 'only the completed step has an operation record');
    assert.equal(before[0].id, completedOperationId);
    assert.equal(before[0].status, Outcome.SUCCESS_VERIFIED);

    const restarted = appOn(dataDir);
    const runAgain = await restarted.controller.runTask(task.id, 'run');
    assert.equal(runAgain.status, Outcome.INPUT_REJECTED, 'an interrupted task is resumed, not run from scratch');
    const recovered = await restarted.taskStore.get(task.id);
    assert.equal(recovered.status, TaskStatus.PAUSED);
    assert.deepEqual(recovered.steps.map((s) => s.status), [StepStatus.COMPLETED, StepStatus.PENDING]);

    const done = await restarted.controller.runTask(task.id, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED);
    const finished = await restarted.taskStore.get(task.id);
    assert.equal(finished.status, TaskStatus.COMPLETED);
    assert.deepEqual(finished.steps.map((s) => s.status), [StepStatus.COMPLETED, StepStatus.COMPLETED]);

    const after = await stepOps(restarted);
    assert.equal(after.filter((r) => r.task.stepId === 's1').length, 1, 'the completed step was not re-run');
    assert.equal(after.filter((r) => r.task.stepId === 's1')[0].id, completedOperationId);
    assert.equal(after.filter((r) => r.task.stepId === 's2').length, 1);
    assert.equal(finished.steps[1].operationId, after.find((r) => r.task.stepId === 's2').id);
  });

  test('a step executed and audited but not persisted as complete is recovered from its audit record and not re-run', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    await app.controller.planTask('calc 1+1');
    const task = await onlyTask(app);

    // TEST DOUBLE fault: the process dies after the step audit record, before the
    // task log records the step as completed.
    const original = app.taskStore.transition.bind(app.taskStore);
    let injected = false;
    app.taskStore.transition = async (taskId, ev) => {
      if (!injected && ev.steps?.some((s) => s.id === 's1' && s.to === 'completed')) {
        injected = true;
        throw new Error('simulated process death before step completion was recorded');
      }
      return original(taskId, ev);
    };
    await assert.rejects(app.controller.runTask(task.id, 'run'), /simulated process death before step completion/);
    const interrupted = await app.taskStore.get(task.id);
    assert.equal(interrupted.status, TaskStatus.RUNNING);
    assert.equal(interrupted.steps[0].status, StepStatus.RUNNING);
    const operationId = interrupted.steps[0].operationId;
    assert.ok(operationId);

    const audit = (await stepOps(app)).filter((r) => r.id === operationId);
    assert.equal(audit.length, 1, 'the executed step has one audit record');
    assert.equal(audit[0].status, Outcome.SUCCESS_VERIFIED);

    const restarted = appOn(dataDir);
    const resume = await restarted.controller.runTask(task.id, 'resume');
    assert.equal(resume.status, Outcome.SUCCESS_VERIFIED, 'the recorded verification is the evidence APEX has');
    assert.match(resume.display, /recovered from its audit record/);
    const recovered = await restarted.taskStore.get(task.id);
    assert.equal(recovered.status, TaskStatus.COMPLETED);
    assert.equal(recovered.steps[0].status, StepStatus.COMPLETED);
    assert.equal(recovered.steps[0].outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(recovered.steps[0].operationId, operationId, 'the attempt stays linked to its audit record');
    assert.equal((await stepOps(restarted)).filter((r) => r.id === operationId).length, 1, 'no duplicate execution');
  });

  test('an interrupted task can be cancelled: the in-flight step becomes uncertain and nothing else runs', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    await app.controller.planTask('calc 1+1; calc 2+2');
    const task = await onlyTask(app);
    // Simulate a process that died after recording "running" for s1.
    await app.taskStore.transition(task.id, {
      reason: 'simulated interruption',
      task: { from: 'pending', to: 'running' },
      steps: [{ id: 's1', from: 'pending', to: 'running', operationId: 'dead-process' }],
    });

    const restarted = appOn(dataDir);
    const cancelled = await restarted.controller.cancelTask(task.id);
    assert.equal(cancelled.status, Outcome.SUCCESS_VERIFIED);
    const after = await restarted.taskStore.get(task.id);
    assert.equal(after.status, TaskStatus.CANCELLED);
    assert.deepEqual(after.steps.map((s) => s.status), [StepStatus.UNCERTAIN, StepStatus.CANCELLED]);
    assert.equal(after.steps[0].outcome, null);
    assert.match(after.steps[0].summary, /interrupted/);
    assert.match(after.steps[1].summary, /cancelled before it ran/);
    assert.equal((await stepOps(restarted)).length, 0, 'cancelling an interrupted task executed nothing');

    const run = await restarted.controller.runTask(task.id, 'resume');
    assert.equal(run.status, Outcome.INPUT_REJECTED);
    const again = await restarted.controller.cancelTask(task.id);
    assert.equal(again.status, Outcome.INPUT_REJECTED);

    const afterRestart = await appOn(dataDir).taskStore.get(task.id);
    assert.equal(afterRestart.status, TaskStatus.CANCELLED, 'the cancellation survives a restart');
  });
});

describe('task log integrity: a step status and its outcome must agree', () => {
  function singleStepTask(taskId) {
    return {
      taskId,
      goal: 'calc one plus one',
      origin: 'user',
      planner: 'deterministic',
      steps: [{
        id: 's1',
        description: 'calc 1+1',
        action: 'calc.evaluate',
        permission: 'read',
        input: { expression: '1+1' },
        dependsOn: [],
      }],
    };
  }

  test('the store refuses events that record a failed or completed step with a contradictory outcome', async () => {
    const dataDir = tempDir();
    const store = new TaskStore(path.join(dataDir, 'tasks.jsonl'));
    const taskId = randomUUID();
    await store.createTask(singleStepTask(taskId));
    await store.transition(taskId, { reason: 'start', task: { from: 'pending', to: 'running' } });
    await store.transition(taskId, { reason: 'run step', steps: [{ id: 's1', from: 'pending', to: 'running', operationId: 'op-1' }] });

    const refused = (from, to, outcome) => assert.rejects(
      store.transition(taskId, { reason: 'bad event', steps: [{ id: 's1', from, to, outcome }] }),
      (err) => err instanceof ValidationError && err.code === 'ILLEGAL_TRANSITION',
    );
    await refused(StepStatus.RUNNING, StepStatus.FAILED, Outcome.SUCCESS_VERIFIED);
    await refused(StepStatus.RUNNING, StepStatus.COMPLETED, Outcome.EXECUTION_FAILED);
    await refused(StepStatus.RUNNING, StepStatus.UNCERTAIN, Outcome.SUCCESS_VERIFIED);
    await refused(StepStatus.RUNNING, StepStatus.COMPLETED, 'not_an_outcome');

    const stillRunning = await store.get(taskId);
    assert.equal(stillRunning.status, TaskStatus.RUNNING);
    assert.equal(stillRunning.steps[0].status, StepStatus.RUNNING);

    // The legitimate completion is still accepted.
    await store.transition(taskId, { reason: 'verified', steps: [{ id: 's1', from: StepStatus.RUNNING, to: StepStatus.COMPLETED, outcome: Outcome.SUCCESS_VERIFIED, summary: '2' }] });
    await store.transition(taskId, { reason: 'done', task: { from: TaskStatus.RUNNING, to: TaskStatus.COMPLETED } });
    assert.equal((await store.get(taskId)).status, TaskStatus.COMPLETED);
  });

  test('a rejected transition leaves the replayed task and its steps unchanged', async () => {
    const dataDir = tempDir();
    const taskId = randomUUID();
    const at = new Date().toISOString();
    const base = { schema: 1, taskId, at };
    const events = [
      { ...base, eventId: randomUUID(), type: 'task_created', ...singleStepTask(taskId) },
      { ...base, eventId: randomUUID(), type: 'transition', reason: 'start', task: { from: 'pending', to: 'running' }, steps: [{ id: 's1', from: 'pending', to: 'running' }] },
      // Shape-valid and legal per the transition table, but impossible: the task
      // cannot be completed while its only step is uncertain.
      { ...base, eventId: randomUUID(), type: 'transition', reason: 'premature completion', task: { from: 'running', to: 'completed' }, steps: [{ id: 's1', from: 'running', to: 'uncertain' }] },
    ];
    const file = path.join(dataDir, 'tasks.jsonl');
    fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

    const store = new TaskStore(file);
    const inspected = await store.inspect();
    assert.equal(inspected.problems.length, 1);
    const task = inspected.tasks[0];
    assert.equal(task.status, TaskStatus.RUNNING, 'a rejected event must not change the task status');
    assert.equal(task.steps[0].status, StepStatus.RUNNING, 'a rejected event must not change step state');
    assert.notEqual(task.lastReason, 'premature completion');
    await assert.rejects(store.load(), StoreError, 'the log is still refused for execution');
  });

  test('a log already containing a contradictory outcome fails closed and is never extended', async () => {
    const dataDir = tempDir();
    const taskId = randomUUID();
    const at = new Date().toISOString();
    const base = { schema: 1, eventId: randomUUID(), taskId, at };
    const events = [
      { ...base, type: 'task_created', ...singleStepTask(taskId) },
      { ...base, eventId: randomUUID(), type: 'transition', reason: 'start', task: { from: 'pending', to: 'running' }, steps: [{ id: 's1', from: 'pending', to: 'running', operationId: 'op-x' }] },
      // Shape-valid but impossible: a failed step cannot be a verified success.
      { ...base, eventId: randomUUID(), type: 'transition', reason: 'tampered', task: null, steps: [{ id: 's1', from: 'running', to: 'failed', outcome: Outcome.SUCCESS_VERIFIED }] },
    ];
    const file = path.join(dataDir, 'tasks.jsonl');
    fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    const before = fs.readFileSync(file, 'utf8');

    const store = new TaskStore(file);
    await assert.rejects(store.load(), (err) => err instanceof StoreError && /cannot be applied/.test(err.message));
    await assert.rejects(store.get(taskId), StoreError);

    const app = createApp({ dataDir });
    const res = await app.controller.cancelTask(taskId);
    assert.equal(res.status, Outcome.EXECUTION_FAILED, 'a damaged log is not treated as an empty task list');
    assert.match(res.display, /task store unavailable/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused read never rewrites the log');
  });
});

describe('078: no impossible lifecycle event can be applied', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const taskStatuses = Object.values(TaskStatus);
  const stepStatuses = Object.values(StepStatus);

  function taskIn(status, stepStatus) {
    return {
      id: 't',
      goal: 'goal',
      origin: 'user',
      planner: 'deterministic',
      createdAt: at,
      updatedAt: at,
      status,
      approvedAt: null,
      lastReason: null,
      steps: [{
        id: 's1',
        description: 'one step',
        action: 'calc.evaluate',
        permission: 'read',
        input: { expression: '1+1' },
        dependsOn: [],
        status: stepStatus,
        operationId: null,
        outcome: null,
        summary: null,
        approval: null,
      }],
    };
  }

  function event({ task = null, steps = [] } = {}) {
    return { schema: 1, eventId: randomUUID(), type: 'transition', taskId: 't', at, reason: 'test', task, steps };
  }

  test('every task transition outside the table is refused, whatever the step state', () => {
    for (const from of taskStatuses) {
      for (const to of taskStatuses) {
        if (canTransition(TASK_TRANSITIONS, from, to)) continue;
        for (const stepStatus of stepStatuses) {
          const tasks = new Map([['t', taskIn(from, stepStatus)]]);
          const problem = applyEvent(tasks, event({ task: { from, to } }));
          assert.match(String(problem), /illegal task transition/, `${from} -> ${to} was not refused (step ${stepStatus})`);
          assert.equal(tasks.get('t').status, from, `${from} -> ${to} changed the task despite being refused`);
        }
      }
    }
  });

  test('every step transition outside the table is refused in a running task', () => {
    for (const from of stepStatuses) {
      for (const to of stepStatuses) {
        if (canTransition(STEP_TRANSITIONS, from, to)) continue;
        const tasks = new Map([['t', taskIn(TaskStatus.RUNNING, from)]]);
        const problem = applyEvent(tasks, event({ steps: [{ id: 's1', from, to }] }));
        assert.match(String(problem), /illegal step transition/, `${from} -> ${to} was not refused`);
        assert.equal(tasks.get('t').steps[0].status, from, `step ${from} -> ${to} changed despite being refused`);
      }
    }
  });

  test('every step transition inside the table still applies', () => {
    for (const from of stepStatuses) {
      for (const to of STEP_TRANSITIONS[from] ?? []) {
        const tasks = new Map([['t', taskIn(TaskStatus.RUNNING, from)]]);
        const outcome = to === StepStatus.COMPLETED ? Outcome.SUCCESS_VERIFIED : undefined;
        const problem = applyEvent(tasks, event({ steps: [{ id: 's1', from, to, outcome }] }));
        assert.equal(problem, null, `${from} -> ${to} was refused: ${problem}`);
        assert.equal(tasks.get('t').steps[0].status, to);
      }
    }
  });

  test('a task cannot be cancelled while a step is still open, even though the task pair is legal', () => {
    for (const stepStatus of [StepStatus.PENDING, StepStatus.RUNNING, StepStatus.AWAITING_APPROVAL]) {
      const tasks = new Map([['t', taskIn(TaskStatus.PENDING, stepStatus)]]);
      const problem = applyEvent(tasks, event({ task: { from: TaskStatus.PENDING, to: TaskStatus.CANCELLED } }));
      assert.match(String(problem), /cancelled while a step is still open/, `cancellation was accepted with a ${stepStatus} step`);
      assert.equal(tasks.get('t').status, TaskStatus.PENDING);
      assert.equal(tasks.get('t').steps[0].status, stepStatus);
    }
  });

  test('a completed transition needs every step completed, and a completed step needs a verified outcome', () => {
    const tasks = new Map([['t', taskIn(TaskStatus.RUNNING, StepStatus.PENDING)]]);
    const problem = applyEvent(tasks, event({ task: { from: TaskStatus.RUNNING, to: TaskStatus.COMPLETED } }));
    assert.match(String(problem), /completed while a step is not completed/);
    assert.equal(tasks.get('t').status, TaskStatus.RUNNING);

    const contradictory = new Map([['t', taskIn(TaskStatus.RUNNING, StepStatus.RUNNING)]]);
    const bad = applyEvent(contradictory, event({
      steps: [{ id: 's1', from: StepStatus.RUNNING, to: StepStatus.COMPLETED, outcome: Outcome.EXECUTION_FAILED }],
    }));
    assert.match(String(bad), /a completed step needs a verified outcome/);
    assert.equal(contradictory.get('t').steps[0].status, StepStatus.RUNNING);
  });
});

// 094: recovery and failure paths must not repeat a side effect or upgrade an uncertain
// result to success. The denial, timeout, and verifier below are TEST DOUBLES; the task
// log, audit record, and conversation turn they produce are real.
describe('094: denied, timed-out, and unverified steps stay failed and are not repeated', () => {
  const readEvents = (dataDir) => fs.readFileSync(path.join(dataDir, 'tasks.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const taskTurns = (dataDir) => (fs.existsSync(path.join(dataDir, 'conversation.jsonl'))
    ? fs.readFileSync(path.join(dataDir, 'conversation.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []).filter((t) => t.origin === 'apex_task');

  test('a step denied by authorization at run time fails the task, runs nothing, and repeated resume changes nothing', async () => {
    const dataDir = tempDir();
    const app = createApp({ dataDir });
    const planned = await app.controller.planTask('calc 2+2; calc 3+3');
    assert.equal(planned.status, Outcome.PLAN_CREATED);
    const task = await onlyTask(app);

    const realAuthorize = app.registry.authorize.bind(app.registry);
    app.registry.authorize = () => ({ decision: 'deny', reason: 'INJECTED_DENIAL' });
    const denied = await app.controller.runTask(task.id, 'run');
    assert.equal(denied.status, Outcome.ACTION_DENIED);

    const after = await app.taskStore.get(task.id);
    assert.equal(after.status, TaskStatus.FAILED);
    assert.equal(after.steps[0].outcome, Outcome.ACTION_DENIED);
    assert.equal(after.steps[0].status, StepStatus.FAILED);
    assert.equal(after.steps[1].status, StepStatus.SKIPPED, 'the dependent step never started');
    const ops = await stepOps(app);
    assert.equal(ops.length, 1, 'only the denied step has an operation record');
    assert.equal(ops[0].status, Outcome.ACTION_DENIED);
    assert.equal(ops[0].steps[0].execution.status, 'not_run', 'denial is not execution');
    const turn = taskTurns(dataDir).at(-1);
    assert.match(turn.text, /failed/);
    assert.match(turn.text, /0 of 2 step\(s\) verified complete/);
    assert.equal(/verified success|Yes, it finished/.test(turn.text), false);

    const eventsBefore = readEvents(dataDir).length;
    const again = await app.controller.runTask(task.id, 'resume');
    assert.equal(again.status, Outcome.INPUT_REJECTED, 'a failed task is not resumed by accident');
    assert.equal(readEvents(dataDir).length, eventsBefore, 'the refused resume wrote no task events');
    assert.deepEqual((await app.taskStore.get(task.id)).steps.map((s) => s.status), [StepStatus.FAILED, StepStatus.SKIPPED]);

    // The explicit way forward: retry the read-only step, then resume. It now runs once.
    app.registry.authorize = realAuthorize;
    assert.equal((await app.controller.retryTask(task.id, 's1')).status, Outcome.SUCCESS_VERIFIED);
    const done = await app.controller.runTask(task.id, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED);
    assert.equal((await app.taskStore.get(task.id)).status, TaskStatus.COMPLETED);
  });

  test('an execution timeout fails the step and is never retried automatically', async () => {
    const dataDir = tempDir();
    let attempts = 0;
    // TEST DOUBLE: a read whose execution times out.
    const timeout = {
      name: 'test.timeout',
      description: 'test-only read that times out',
      permission: 'read',
      origins: ['user', 'model'],
      inputHint: '{}',
      validate: (input) => input,
      async execute() {
        attempts += 1;
        const err = new Error('the sensor did not answer within 50 ms');
        err.code = 'ETIMEDOUT';
        throw err;
      },
      verify: null,
    };
    const app = createApp({ dataDir, extraActions: [timeout] });
    const taskId = randomUUID();
    const step = (id, dependsOn) => ({ id, description: `timed read ${id}`, action: 'test.timeout', permission: 'read', input: {}, dependsOn });
    await app.taskStore.createTask({
      taskId, goal: 'a read that times out', origin: 'user', planner: 'deterministic',
      steps: [step('s1', []), step('s2', ['s1'])],
    });

    const res = await app.controller.runTask(taskId, 'run');
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(attempts, 1, 'the timed-out read was attempted once');
    const after = await app.taskStore.get(taskId);
    assert.equal(after.status, TaskStatus.FAILED);
    assert.equal(after.steps[0].outcome, Outcome.EXECUTION_FAILED);
    assert.equal(after.steps[0].summary.includes('did not answer within 50 ms'), true);
    assert.equal(after.steps[1].status, StepStatus.SKIPPED);
    assert.equal((await stepOps(app)).length, 1);

    const eventsBefore = readEvents(dataDir).length;
    assert.equal((await app.controller.runTask(taskId, 'resume')).status, Outcome.INPUT_REJECTED);
    assert.equal(attempts, 1, 'a refused resume did not repeat the timeout');
    assert.equal(readEvents(dataDir).length, eventsBefore);
  });

  test('a verifier that rejects the result stops the task and is not converted into success', async () => {
    const dataDir = tempDir();
    let executions = 0;
    // TEST DOUBLE: execution succeeds, but the independent check says it did not.
    const unconfirmed = {
      name: 'test.unconfirmed',
      description: 'test-only read whose verifier rejects the result',
      permission: 'read',
      origins: ['user', 'model'],
      inputHint: '{}',
      validate: (input) => input,
      async execute() {
        executions += 1;
        return { summary: 'the read returned a value', data: { value: 1 } };
      },
      async verify() {
        return { ok: false, detail: 'the postcondition does not hold' };
      },
    };
    const app = createApp({ dataDir, extraActions: [unconfirmed] });
    const taskId = randomUUID();
    await app.taskStore.createTask({
      taskId, goal: 'a read that fails verification', origin: 'user', planner: 'deterministic',
      steps: [{ id: 's1', description: 'unconfirmed read', action: 'test.unconfirmed', permission: 'read', input: {}, dependsOn: [] }],
    });

    const res = await app.controller.runTask(taskId, 'run');
    assert.equal(res.status, Outcome.VERIFICATION_FAILED);
    assert.equal(executions, 1);
    const after = await app.taskStore.get(taskId);
    assert.equal(after.steps[0].status, StepStatus.FAILED);
    assert.equal(after.steps[0].outcome, Outcome.VERIFICATION_FAILED);
    assert.match(after.steps[0].summary, /result NOT confirmed: the postcondition does not hold/);
    const ops = await stepOps(app);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].status, Outcome.VERIFICATION_FAILED);
    const turn = taskTurns(dataDir).at(-1);
    assert.match(turn.text, /failed/);
    assert.equal(/verified success/.test(turn.text), false);

    const eventsBefore = readEvents(dataDir).length;
    assert.equal((await app.controller.runTask(taskId, 'resume')).status, Outcome.INPUT_REJECTED);
    assert.equal(executions, 1, 'the unverified read was not executed again by resume');
    assert.equal(readEvents(dataDir).length, eventsBefore);
  });
});
