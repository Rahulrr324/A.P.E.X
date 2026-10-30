// Milestone 067: the reporting chain from authorization to execution, verification, the
// audit record, and the user-visible result. These tests cover the one inconsistency that
// was reproduced: when the task log refuses the write that records a step result, the run
// used to be reported as an execution that failed even though the step had executed, been
// verified, and been written to the audit log. They also show the reconciliation that
// follows, which resolves the step from its own audit record and never runs it again.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { StoreError } from '../src/errors.js';
import { Outcome } from '../src/outcomes.js';
import { TaskStatus, StepStatus } from '../src/tasks/model.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const stepOps = async (app) => (await app.operations.inspect()).records.filter((r) => r.capability === 'task.step');
const transitions = (dataDir) => fs.readFileSync(path.join(dataDir, 'tasks.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((e) => e.type === 'transition');

// TEST DOUBLE fault: a store write failure while the process is alive, which is different
// from an abrupt process loss (those tests throw a plain Error and expect a rejection).
function failNextCompletion(app) {
  const original = app.taskStore.transition.bind(app.taskStore);
  let injected = false;
  app.taskStore.transition = async (id, event) => {
    if (!injected && event.steps?.some((s) => s.to === 'completed')) {
      injected = true;
      throw new StoreError('injected: task log write failed');
    }
    return original(id, event);
  };
  return () => { app.taskStore.transition = original; };
}

// Milestone 088: the ordinary request path has its own persistence boundaries. A
// failed conversation write is display-only and covered elsewhere; these cases hold
// the audit boundary itself and the step record's outcome vocabulary.
describe('audit consistency - the operation record boundary', () => {
  test('an audit failure after a user write is disclosed and the write is not repeated', async () => {
    const app = createApp({ dataDir: tempDir() });
    app.operations.append = async () => { throw new StoreError('injected: audit write failed'); };

    const res = await app.controller.handle('remember that the audit boundary is tested', { origin: 'user' });

    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, 'the execution and its verification did happen');
    assert.equal(res.recorded, false, 'but the operation record did not');
    assert.ok(res.recordError);
    assert.match(res.display, /Stored/);
    assert.equal((await app.memory.list()).length, 1, 'the write happened exactly once');
    assert.equal((await app.operations.inspect()).records.length, 0, 'no audit record was invented');
  });

  test('an audit failure on a denied request records nothing and claims nothing ran', async () => {
    const app = createApp({ dataDir: tempDir() });
    app.operations.append = async () => { throw new StoreError('injected: audit write failed'); };

    const res = await app.controller.handle('rm -rf /', { origin: 'user' });

    assert.equal(res.status, Outcome.ACTION_DENIED);
    assert.equal(res.recorded, false);
    assert.match(res.display, /nothing was executed/i);
    assert.equal((await app.operations.inspect()).records.length, 0);
  });

  test('a step record keeps unavailable verification distinct from failed verification', async () => {
    const unavailable = createApp({ dataDir: tempDir() });
    unavailable.controller.verifier.check = async () => ({
      outcome: Outcome.VERIFICATION_UNAVAILABLE,
      detail: 'injected: evidence could not be read',
    });
    const gap = await unavailable.controller.handle('calc 2+2', { origin: 'user' });
    assert.equal(gap.status, Outcome.VERIFICATION_UNAVAILABLE);
    const gapRecord = (await unavailable.operations.inspect()).records.at(-1);
    assert.equal(gapRecord.steps[0].execution.status, 'ok', 'the execution is recorded as having run');
    assert.equal(gapRecord.steps[0].verification.outcome, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(gapRecord.status, Outcome.VERIFICATION_UNAVAILABLE);

    const failed = createApp({ dataDir: tempDir() });
    failed.controller.verifier.check = async () => ({
      outcome: Outcome.VERIFICATION_FAILED,
      detail: 'injected: the postcondition does not hold',
    });
    const mismatch = await failed.controller.handle('calc 2+2', { origin: 'user' });
    assert.equal(mismatch.status, Outcome.VERIFICATION_FAILED);
    const failedRecord = (await failed.operations.inspect()).records.at(-1);
    assert.equal(failedRecord.steps[0].verification.outcome, Outcome.VERIFICATION_FAILED);
    assert.equal(failedRecord.status, Outcome.VERIFICATION_FAILED);
  });
});

describe('audit consistency - a task-log write failure after a step ran', () => {
  test('an executed, verified, audited write step is not reported as an execution failure', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const planned = await app.controller.planTask('remember that the sky is blue');
    assert.equal(planned.status, Outcome.PLAN_CREATED);
    const taskId = planned.task.id;

    const restore = failNextCompletion(app);
    const res = await app.controller.runTask(taskId, 'run');
    restore();

    assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.notEqual(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(res.operation.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.match(res.display, /step s1 \(memory\.add\) had already returned success_verified/);
    assert.match(res.display, /its own audit record [0-9a-f]{8} was written/);
    assert.match(res.display, /APEX will not run it again/);
    assert.match(res.display, /node bin\/apex\.js task run /);
    assert.doesNotMatch(res.display, /execution failed/i);
    assert.ok(res.operation.errors.some((e) => e.stage === 'task' && e.code === 'TASK_LOG_WRITE_FAILED'));

    // The side effect happened, exactly once.
    assert.equal((await app.memory.list()).length, 1);

    // The two audit records agree about what happened: the step record says it ran and was
    // verified, and the task record says the task log could not record that result.
    const records = (await app.operations.inspect()).records;
    const stepRecord = records.find((o) => o.capability === 'task.step');
    assert.equal(stepRecord.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(stepRecord.task.stepId, 's1');
    assert.equal(stepRecord.steps[0].execution.status, 'ok');
    assert.equal(stepRecord.steps[0].verification.outcome, Outcome.SUCCESS_VERIFIED);
    const taskRecord = records.find((o) => o.capability === 'task.run');
    assert.equal(taskRecord.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.equal(taskRecord.task.status, TaskStatus.RUNNING);

    const stuck = await app.taskStore.get(taskId);
    assert.equal(stuck.status, TaskStatus.RUNNING);
    assert.equal(stuck.steps[0].status, StepStatus.RUNNING);

    // Reconciliation resolves the step from its own audit record and never runs it again.
    const reconcile = await app.controller.runTask(taskId, 'run');
    assert.equal(reconcile.status, Outcome.INPUT_REJECTED);
    assert.equal((await app.taskStore.get(taskId)).status, TaskStatus.PAUSED);
    assert.deepEqual(reconcile.operation.errors.filter((e) => e.stage === 'task'), []);
    const done = await app.controller.runTask(taskId, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED);
    assert.equal((await app.taskStore.get(taskId)).status, TaskStatus.COMPLETED);
    assert.equal((await app.memory.list()).length, 1, 'the write step was not executed twice');
    assert.equal((await stepOps(app)).length, 1, 'one audit record for one execution');
  });

  test('the multi-part request path reports the same executed-step evidence', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });

    const restore = failNextCompletion(app);
    const res = await app.controller.handle('calc 1+1; calc 2+2');
    restore();

    assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.match(res.display, /step s1 \(calc\.evaluate\) had already returned success_verified/);
    assert.match(res.display, /its own audit record/);
    assert.doesNotMatch(res.display, /execution failed/i);

    const record = (await app.operations.inspect()).records.find((o) => o.capability === 'task.run');
    assert.equal(record.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.ok(record.errors.some((e) => e.code === 'TASK_LOG_WRITE_FAILED' && e.steps.includes('s1')));

    assert.equal((await stepOps(app)).length, 1);
    const [task] = await app.taskStore.list();
    assert.equal(task.status, TaskStatus.RUNNING);
    assert.equal(task.steps[0].status, StepStatus.RUNNING);
  });

  test('a failure recording the final task state is not reported as an execution failure', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const planned = await app.controller.planTask('calc 1+1');
    const taskId = planned.task.id;

    const original = app.taskStore.transition.bind(app.taskStore);
    let injected = false;
    app.taskStore.transition = async (id, event) => {
      if (!injected && event.reason === 'all steps completed') {
        injected = true;
        throw new StoreError('injected: task log write failed at the end');
      }
      return original(id, event);
    };
    const res = await app.controller.runTask(taskId, 'run');
    app.taskStore.transition = original;

    assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.match(res.display, /step s1 \(calc\.evaluate\) had already returned success_verified/);
    const stuck = await app.taskStore.get(taskId);
    assert.equal(stuck.status, TaskStatus.RUNNING);
    assert.equal(stuck.steps[0].status, StepStatus.COMPLETED);

    const reconcile = await app.controller.runTask(taskId, 'run');
    assert.equal(reconcile.status, Outcome.INPUT_REJECTED);
    const paused = await app.taskStore.get(taskId);
    assert.equal(paused.status, TaskStatus.PAUSED);
    // The recovery note does not claim the interruption came before any step ran: the log
    // shows a completed step.
    const reasons = transitions(dir).map((e) => e.reason);
    assert.ok(reasons.includes('interrupted after a recorded step; no step was left running'));
    assert.equal(reasons.includes('interrupted before any step was recorded as running'), false);

    const done = await app.controller.runTask(taskId, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED);
    assert.equal((await app.taskStore.get(taskId)).status, TaskStatus.COMPLETED);
    assert.equal((await stepOps(app)).length, 1, 'the completed step was not executed again');
  });
});
