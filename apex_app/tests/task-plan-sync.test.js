// Closing the executive loop: a plan-linked task that finishes through `task run`/`resume`/`retry`
// must bring its plan's recorded outcomes and status up to date, exactly as activation does. Before
// this, only planActivate/planContinue recorded outcomes, so a plan whose task was resumed by hand
// stayed active with stale step results until an explicit `plan reconcile`.
//
// TEST DOUBLE fault: a transition wrapper simulates process death between two steps. No model is used.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { TaskStatus } from '../src/tasks/model.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }
const appOn = (dataDir) => createApp({ dataDir, experienceCapture: CAPTURE_OFF });

const calcStep = (id, expression, dependsOn = []) => ({
  id, description: `calc ${expression}`, action: 'calc.evaluate', input: { expression }, dependsOn,
  expectedResult: 'the sum', verification: 'recomputed', risk: 'low', estimateSeconds: 1,
});

describe('a plan-linked task run syncs the plan', () => {
  test('an interrupted plan task resumed to completion completes the plan without a manual reconcile', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const added = await app.controller.planAdd({ outcome: 'two sums', steps: [calcStep('s1', '1+1'), calcStep('s2', '2+2', ['s1'])] });
    assert.equal(added.status, Outcome.PLAN_STORED, added.output);
    const planId = added.operation.steps[0].result.data.planId;
    assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);

    // The process dies after s1 completed, before s2 is marked running, during activation.
    const original = app.taskStore.transition.bind(app.taskStore);
    let injected = false;
    app.taskStore.transition = async (taskId, ev) => {
      if (!injected && ev.steps?.some((s) => s.id === 's2' && s.to === 'running')) {
        injected = true;
        throw new Error('simulated process death between steps');
      }
      return original(taskId, ev);
    };
    // Activation catches a mid-run failure and reports it as a refused run rather than throwing:
    // the activation is already a recorded fact, so the plan stays active and the task keeps s1.
    const activated = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(activated.status, Outcome.INPUT_REJECTED, activated.output);
    assert.match(activated.display, /simulated process death between steps/);
    const task = (await app.taskStore.inspect()).tasks.find((t) => t.planId === planId);
    assert.ok(task, 'activation created a plan-linked task before it was interrupted');
    assert.equal(task.status, TaskStatus.RUNNING, 'the process died mid-run, so the task is left running');
    assert.deepEqual(task.steps.map((s) => s.status), ['completed', 'pending']);

    // A fresh process resumes the task directly (not via plan continue). The completed step is not re-run.
    const restarted = appOn(dataDir);
    await restarted.controller.runTask(task.id, 'run'); // recovers the interrupted task to paused
    const done = await restarted.controller.runTask(task.id, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED, done.output);
    assert.equal((await restarted.taskStore.get(task.id)).status, TaskStatus.COMPLETED);

    // The loop closed: the plan recorded the verified outcomes and moved to completed on its own.
    const plan = (await restarted.controller.showPlan(planId)).plan;
    assert.equal(plan.status, 'completed', 'the resumed task completed the plan without a manual reconcile');
    assert.equal(plan.stepResults.s1?.status, 'completed');
    assert.equal(plan.stepResults.s2?.status, 'completed');
    assert.match(done.display, /is completed against 2 verified step outcome/);
    assert.match(done.display, /No goal is completed by this/);
  });

  test('a standalone task with no plan runs unchanged and records no plan outcome', async () => {
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
    assert.equal((await app.taskStore.inspect()).tasks.find((t) => t.id === taskId).planId ?? null, null);
  });
});