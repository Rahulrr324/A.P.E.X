// Task-to-plan reconciliation: a task run/resume/retry that belongs to a plan must bring the
// plan's recorded outcomes and status in line with the task, exactly as activation does - and it
// must be able to do so when the plan already holds some of those outcomes.
//
// The plan store's reducer is the rule, not a suggestion: a completed or skipped step outcome is
// final, an uncertain one may be replaced by a later reading, and completing a step that failed
// earlier needs a new plan revision. A synchronization that re-sends every terminal task outcome
// therefore collides with the outcomes an activation or reconcile already recorded, and the whole
// event is refused - leaving the plan stale after the task finished. These tests drive that exact
// collision through the real stores, controller and task log.
//
// TEST DOUBLE faults: one transition wrapper simulates a process death between steps, one throws
// the StoreError a refused task-log write raises, and one plan-store write is made to fail. The
// probe actions are deterministic readers; no model is contacted and no inference runs.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { PlanStatus } from '../src/plans/model.js';
import { TaskStatus } from '../src/tasks/model.js';
import { StoreError } from '../src/errors.js';
import { makeTempDataDir, cleanup, cleanEnv } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'fixtures', 'continuation-child.mjs');

const dirs = [];
const children = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(() => { for (const c of children) { try { c.kill(); } catch { /* already gone */ } } });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }
const appOn = (dataDir, extraActions = []) => createApp({ dataDir, experienceCapture: CAPTURE_OFF, extraActions });

const calcStep = (id, expression, dependsOn = []) => ({
  id, description: `calc ${expression}`, action: 'calc.evaluate', input: { expression }, dependsOn,
  expectedResult: 'the sum', verification: 'recomputed', risk: 'low', estimateSeconds: 1,
});

async function planFor(app, steps, extra = {}) {
  const added = await app.controller.planAdd({ outcome: 'the recorded sums are computed', steps, ...extra });
  assert.equal(added.status, Outcome.PLAN_STORED, added.output);
  const planId = added.operation.steps[0].result.data.planId;
  assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);
  return planId;
}

const outcomeEvents = (plan) => plan.history.filter((h) => h.kind === 'outcome').length;

// A read whose outcome is unverifiable on the first attempt and verified on the second, so an
// uncertain step can be recovered by the user's own retry through the real runner.
function recoveringAction(state) {
  return {
    name: 'probe.recovers',
    description: 'TEST DOUBLE read that is verified only on its second attempt',
    inputHint: '{}',
    permission: 'read',
    origins: ['user', 'model'],
    validate: (input) => input ?? {},
    async execute() {
      state.calls += 1;
      return { summary: `attempt ${state.calls}` };
    },
    async verify() {
      return state.calls === 1 ? null : { ok: true, detail: 'verified on the second attempt' };
    },
  };
}

// A read that fails to execute once and succeeds afterwards. A plan whose step failed earlier may
// not later record that step as completed; this is the action that produces that divergence.
function failThenSucceedAction(state) {
  return {
    name: 'probe.failonce',
    description: 'TEST DOUBLE read that fails on its first attempt and succeeds on its second',
    inputHint: '{}',
    permission: 'read',
    origins: ['user', 'model'],
    validate: (input) => input ?? {},
    async execute() {
      state.calls += 1;
      if (state.calls === 1) throw new Error('the sensor did not answer on the first attempt');
      return { summary: `attempt ${state.calls}` };
    },
    async verify() {
      return { ok: true, detail: 'the sensor answered' };
    },
  };
}

function probeActions(effectFile) {
  const effects = () => (fs.existsSync(effectFile)
    ? fs.readFileSync(effectFile, 'utf8').split('\n').filter((l) => l.trim() !== '')
    : []);
  return [
    {
      name: 'probe.note',
      description: 'TEST DOUBLE write that leaves one observable line behind',
      inputHint: '{"tag":"text"}',
      permission: 'write',
      origins: ['user'],
      validate: (input) => ({ tag: String(input?.tag ?? 'x') }),
      async execute(_ctx, input) {
        fs.appendFileSync(effectFile, `${input.tag}\n`);
        return { summary: `wrote ${input.tag}`, data: { tag: input.tag } };
      },
      async verify(_ctx, input) {
        return effects().includes(input.tag)
          ? { ok: true, detail: `the file holds ${input.tag}` }
          : { ok: false, detail: `the file holds no ${input.tag}` };
      },
    },
    {
      name: 'probe.peek',
      description: 'TEST DOUBLE read that leaves one observable line behind',
      inputHint: '{"tag":"text"}',
      permission: 'read',
      origins: ['user', 'model'],
      validate: (input) => ({ tag: String(input?.tag ?? 'x') }),
      async execute(_ctx, input) {
        fs.appendFileSync(effectFile, `read:${input.tag}\n`);
        return { summary: `read ${input.tag}`, data: { tag: input.tag } };
      },
      async verify(_ctx, input) {
        return effects().includes(`read:${input.tag}`)
          ? { ok: true, detail: `the file holds read:${input.tag}` }
          : { ok: false, detail: `the file holds no read:${input.tag}` };
      },
    },
  ];
}

describe('a plan keeps only the outcomes it does not already hold', () => {
  test('1: a reconcile-recorded successful step and a later direct resume complete the plan once', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const planId = await planFor(app, [calcStep('s1', '1+1'), calcStep('s2', '2+2', ['s1'])]);

    const original = app.taskStore.transition.bind(app.taskStore);
    let injected = false;
    app.taskStore.transition = async (taskId, ev) => {
      if (!injected && ev.steps?.some((s) => s.id === 's2' && s.to === 'running')) {
        injected = true;
        throw new Error('simulated process death between steps');
      }
      return original(taskId, ev);
    };
    const activated = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(activated.status, Outcome.INPUT_REJECTED, activated.output);
    const task = (await app.taskStore.inspect()).tasks.find((t) => t.planId === planId);
    assert.ok(task, 'activation created a plan-linked task');
    assert.deepEqual(task.steps.map((s) => s.status), ['completed', 'pending']);

    // The explicit reconcile records the one step the records have settled.
    const reconciled = await app.controller.planReconcile(planId);
    assert.equal(reconciled.status, Outcome.PLAN_STORED, reconciled.output);
    let plan = await app.plans.get(planId);
    assert.equal(plan.stepResults.s1.status, 'completed');
    assert.equal(outcomeEvents(plan), 1);

    // A fresh process resumes the same task directly, not through the plan.
    const restarted = appOn(dataDir);
    await restarted.controller.runTask(task.id, 'run');
    const done = await restarted.controller.runTask(task.id, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED, done.output);
    assert.doesNotMatch(done.display, /were not recorded against the plan/);

    plan = await restarted.plans.get(planId);
    assert.equal(plan.status, PlanStatus.COMPLETED, 'the resumed task completed the plan');
    assert.equal(plan.stepResults.s1.status, 'completed');
    assert.equal(plan.stepResults.s2.status, 'completed');
    assert.equal(outcomeEvents(plan), 2, 'the already-final step was not recorded a second time');
    assert.match(done.display, /is completed against 2 verified step outcome/);
  });

  test('2: partial outcomes recorded by activation are not re-sent by a later task completion', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const planId = await planFor(app, [calcStep('s1', '1+1'), calcStep('s2', '2+2', ['s1'])]);

    // A task-log write is refused after s1 completed, which is the state the activation path
    // records partial outcomes from. s2 never started, so the task is left running.
    const original = app.taskStore.transition.bind(app.taskStore);
    let injected = false;
    app.taskStore.transition = async (taskId, ev) => {
      if (!injected && ev.steps?.some((s) => s.id === 's2' && s.to === 'running')) {
        injected = true;
        throw new StoreError('simulated task-log write failure after s1 was recorded');
      }
      return original(taskId, ev);
    };
    const activated = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(activated.status, Outcome.AUDIT_INTEGRITY_FAILED, activated.output);
    const task = (await app.taskStore.inspect()).tasks.find((t) => t.planId === planId);
    assert.equal(task.status, TaskStatus.RUNNING);
    let plan = await app.plans.get(planId);
    assert.equal(plan.status, PlanStatus.ACTIVE);
    assert.equal(plan.stepResults.s1.status, 'completed', 'activation recorded the one terminal outcome');
    assert.equal(outcomeEvents(plan), 1);

    const restarted = appOn(dataDir);
    await restarted.controller.runTask(task.id, 'run');
    const done = await restarted.controller.runTask(task.id, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED, done.output);
    assert.doesNotMatch(done.display, /were not recorded against the plan/);

    plan = await restarted.plans.get(planId);
    assert.equal(plan.status, PlanStatus.COMPLETED);
    assert.equal(plan.stepResults.s2.status, 'completed');
    assert.equal(outcomeEvents(plan), 2, 'exactly one new outcome event was appended');
  });

  test('3: an uncertain step recovered by the user\'s retry is recorded and completes the plan', async () => {
    const dataDir = tempDir();
    const state = { calls: 0 };
    const action = recoveringAction(state);
    const app = appOn(dataDir, [action]);
    const planId = await planFor(app, [{
      id: 's1', description: 'read that may not verify', action: 'probe.recovers', input: {},
      dependsOn: [], expectedResult: 'the read is verified', verification: 'the verifier answers', risk: 'low',
    }]);

    const activated = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(activated.status, Outcome.VERIFICATION_UNAVAILABLE, activated.output);
    let plan = await app.plans.get(planId);
    assert.equal(plan.status, PlanStatus.BLOCKED);
    assert.equal(plan.stepResults.s1.status, 'uncertain');
    const taskId = plan.activation.taskId;

    const retried = await app.controller.retryTask(taskId, 's1');
    assert.equal(retried.status, Outcome.SUCCESS_VERIFIED, retried.output);
    const done = await app.controller.runTask(taskId, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED, done.output);
    assert.equal((await app.taskStore.get(taskId)).status, TaskStatus.COMPLETED);

    plan = await app.plans.get(planId);
    assert.equal(plan.stepResults.s1.status, 'completed', 'the later verified reading replaced the uncertain one');
    assert.equal(plan.status, PlanStatus.COMPLETED, 'every step now holds a verified outcome, so the plan was completed');
    assert.doesNotMatch(done.display, /were not recorded against the plan/);
    assert.match(done.display, /is completed against 1 verified step outcome/);
  });

  test('4: a step that failed earlier is never silently promoted to completed', async () => {
    const dataDir = tempDir();
    const state = { calls: 0 };
    const action = failThenSucceedAction(state);
    const app = appOn(dataDir, [action]);
    const planId = await planFor(app, [{
      id: 's1', description: 'read that fails once', action: 'probe.failonce', input: {},
      dependsOn: [], expectedResult: 'the read answers', verification: 'the verifier answers', risk: 'low',
    }]);

    const activated = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(activated.status, Outcome.EXECUTION_FAILED, activated.output);
    let plan = await app.plans.get(planId);
    assert.equal(plan.status, PlanStatus.BLOCKED);
    assert.equal(plan.stepResults.s1.status, 'failed');
    const taskId = plan.activation.taskId;

    const retried = await app.controller.retryTask(taskId, 's1');
    assert.equal(retried.status, Outcome.SUCCESS_VERIFIED, retried.output);
    const done = await app.controller.runTask(taskId, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED, done.output);
    assert.equal((await app.taskStore.get(taskId)).status, TaskStatus.COMPLETED,
      'the task itself did complete on its second attempt');

    plan = await app.plans.get(planId);
    assert.equal(plan.stepResults.s1.status, 'failed', 'the plan keeps the failure the user must revise around');
    assert.equal(plan.status, PlanStatus.BLOCKED);
    assert.match(done.display, /failed earlier/);
    assert.match(done.display, /new plan revision/);
    assert.doesNotMatch(done.display, /is completed against/);
  });

  test('5: synchronizing an already-synced task is an idempotent no-op', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const planId = await planFor(app, [calcStep('s1', '1+1')]);
    const activated = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(activated.status, Outcome.SUCCESS_VERIFIED, activated.output);
    const taskId = (await app.plans.get(planId)).activation.taskId;

    const before = await app.plans.load();
    const first = await app.controller.planReconcile(planId);
    assert.equal(first.status, Outcome.PLAN_STORED, first.output);
    assert.match(first.display, /No new terminal outcome was recorded/);
    assert.match(first.display, /already recorded as completed/);
    const second = await app.controller.planReconcile(planId);
    assert.equal(second.status, Outcome.PLAN_STORED, second.output);
    assert.match(second.display, /No new terminal outcome was recorded/);
    assert.equal((await app.plans.load()).events, before.events, 'neither reconcile appended an event');

    const plan = await app.plans.get(planId);
    assert.equal(plan.status, PlanStatus.COMPLETED);
    assert.equal(outcomeEvents(plan), 1, 'the verified outcome was recorded exactly once');
    assert.equal((await app.taskStore.get(taskId)).status, TaskStatus.COMPLETED);
  });

  test('6: a standalone task with no plan is untouched by plan reconciliation', async () => {
    const app = appOn(tempDir());
    const taskId = randomUUID();
    await app.taskStore.createTask({
      taskId, goal: 'a standalone calc', origin: 'user', planner: 'deterministic',
      steps: [{ id: 's1', description: 'add', action: 'calc.evaluate', permission: 'read', input: { expression: '2+2' }, dependsOn: [] }],
    });
    const done = await app.controller.runTask(taskId, 'run');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED, done.output);
    assert.equal((await app.taskStore.get(taskId)).status, TaskStatus.COMPLETED);
    assert.doesNotMatch(done.display, /is completed against/);
    assert.doesNotMatch(done.display, /against the plan/);
  });

  test('7: a plan-write failure leaves the task\'s verified result intact and is disclosed', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const planId = await planFor(app, [calcStep('s1', '1+1'), calcStep('s2', '2+2', ['s1'])]);

    const original = app.taskStore.transition.bind(app.taskStore);
    let injected = false;
    app.taskStore.transition = async (taskId, ev) => {
      if (!injected && ev.steps?.some((s) => s.id === 's2' && s.to === 'running')) {
        injected = true;
        throw new Error('simulated process death between steps');
      }
      return original(taskId, ev);
    };
    assert.equal((await app.controller.planActivate(planId, { mode: 'run' })).status, Outcome.INPUT_REJECTED);
    const task = (await app.taskStore.inspect()).tasks.find((t) => t.planId === planId);

    const restarted = appOn(dataDir);
    const originalRecord = restarted.plans.recordOutcome.bind(restarted.plans);
    restarted.plans.recordOutcome = async () => { throw new StoreError('simulated plan-log write failure'); };
    await restarted.controller.runTask(task.id, 'run');
    const done = await restarted.controller.runTask(task.id, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED, 'the task result is not rewritten by a plan-write problem');
    assert.equal((await restarted.taskStore.get(task.id)).status, TaskStatus.COMPLETED);
    assert.match(done.display, /The step outcomes were not recorded against the plan: simulated plan-log write failure/);
    let plan = await restarted.plans.get(planId);
    assert.equal(plan.status, PlanStatus.ACTIVE, 'no status was claimed from outcomes that were not recorded');

    // The same explicit reconcile, once the store writes again, closes the gap from the records.
    restarted.plans.recordOutcome = originalRecord;
    const reconciled = await restarted.controller.planReconcile(planId);
    assert.equal(reconciled.status, Outcome.PLAN_STORED, reconciled.output);
    plan = await restarted.plans.get(planId);
    assert.equal(plan.status, PlanStatus.COMPLETED);
    assert.equal(plan.stepResults.s1.status, 'completed');
    assert.equal(plan.stepResults.s2.status, 'completed');
  });
});

describe('a real process interrupted between steps recovers into a completed plan', () => {
  function runChild(boundary, dataDir, effectFile) {
    const child = spawn(process.execPath, [CHILD, boundary, dataDir, effectFile, 'dependent'], {
      env: cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    return new Promise((resolve, reject) => {
      const ceiling = setTimeout(() => { try { child.kill(); } catch { /* gone */ } reject(new Error(`child at ${boundary} did not exit. stdout: ${out} stderr: ${err}`)); }, 60_000);
      child.once('exit', (code) => {
        clearTimeout(ceiling);
        const results = out.split('\n').filter((l) => l.startsWith('RESULT ')).map((l) => JSON.parse(l.slice(7)));
        if (results.length === 0) return reject(new Error(`the child at ${boundary} reported nothing (exit ${code}). stdout: ${out} stderr: ${err}`));
        resolve({ code, last: results[results.length - 1] });
      });
    });
  }

  test('8: the second process resumes the task directly and completes the plan', async () => {
    const dataDir = tempDir();
    const effectFile = path.join(dataDir, 'effects.txt');

    // The child records a goal, an approved two-step plan and its activation, then dies after s1
    // completed and before s2 started. Nothing of that is described: it is left in the stores.
    const { code, last } = await runChild('between-dependent-steps', dataDir, effectFile);
    assert.equal(code, 9, `the fixture must stop at its boundary (got ${code})`);
    assert.equal(last.boundary, 'between-dependent-steps');
    assert.deepEqual(last.statuses, [['s1', 'completed'], ['s2', 'pending']]);
    const { planId, taskId } = last;

    const app = appOn(dataDir, probeActions(effectFile));
    const recovered = await app.controller.runTask(taskId, 'run');
    assert.equal(recovered.status, Outcome.INPUT_REJECTED, recovered.output);
    assert.equal((await app.taskStore.get(taskId)).status, TaskStatus.PAUSED);
    const done = await app.controller.runTask(taskId, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED, done.output);

    const plan = await app.plans.get(planId);
    assert.equal(plan.status, PlanStatus.COMPLETED);
    assert.equal(plan.stepResults.s1.status, 'completed');
    assert.equal(plan.stepResults.s2.status, 'completed');
    assert.equal(outcomeEvents(plan), 1, 'the two terminal outcomes were recorded in one event');
    assert.equal((await app.taskStore.get(taskId)).status, TaskStatus.COMPLETED);

    const effects = fs.readFileSync(effectFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert.deepEqual(effects, ['note-1', 'read:note-2'], 'no step was replayed by the recovery');
  });
});
