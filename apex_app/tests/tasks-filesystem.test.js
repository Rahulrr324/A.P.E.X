// Filesystem actions inside controlled task execution: planning, authorization,
// execution, independent verification, audit records, failure statuses, CLI exit
// codes, and restart/recovery. Every fixture is a temporary directory.
//
// TEST DOUBLES in this file are labelled as such. They exist to inject a timing or
// failure condition deterministically (a file changing between the real read and the
// real verification, a failing audit write, a model-proposed plan). The filesystem
// action code and the verifier are the real implementations.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { TaskStatus, StepStatus, progressOf } from '../src/tasks/model.js';
import { checkSteps } from '../src/tasks/planner.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const d = makeTempDataDir();
  dirs.push(d);
  return d;
}

function tempRoot() {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'notes.txt'), 'hello apex\n');
  fs.writeFileSync(path.join(root, 'empty.txt'), '');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'inner.txt'), 'inner\n');
  return root;
}

// TEST DOUBLE: a model backend that returns `reply` and records each request.
function testDoubleModel(reply, captured = []) {
  const backend = {
    name: 'test-double',
    provider: 'test-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'test-double', endpoint: 'test-double', model: 'test-double' }),
    health: async () => ({ available: true, detail: 'test double' }),
    complete: async (req) => {
      captured.push(req);
      return {
        ok: true, backend: 'test-double', provider: 'test-double', model: 'test-double',
        text: reply, finishReason: 'stop', truncated: false, latencyMs: 0,
      };
    },
  };
  return new ModelGateway({ backend });
}

function appOn(dataDir, root, gateway = new ModelGateway({ backend: new NoBackend() })) {
  return createApp({ dataDir, gateway, filesystemRoot: root });
}

async function opsFor(app, capability) {
  const { records } = await app.operations.list({ limit: 1000 });
  return records.filter((r) => r.capability === capability);
}

async function onlyTask(app) {
  const tasks = await app.taskStore.list();
  assert.equal(tasks.length, 1, `expected one task, found ${tasks.length}`);
  return tasks[0];
}

const SHORT_ID = /Task ([0-9a-f]{8})/;

describe('task execution: filesystem steps', () => {
  test('the composition root and controller are synchronous to build and agree on wiring', () => {
    const app = appOn(tempDir(), tempRoot());
    assert.equal(typeof app.controller.handle, 'function');
    assert.equal(typeof app.controller.runTask, 'function');
    assert.equal(typeof app.then, 'undefined', 'createApp must return the app, not a promise');
    assert.equal(app.filesystemRoot, fs.realpathSync(dirs[dirs.length - 1]));
    assert.deepEqual(app.registry.names().filter((n) => n.startsWith('filesystem.')), ['filesystem.list', 'filesystem.read']);
  });

  test('a valid read-only filesystem task plans, runs, verifies, and is recorded step by step', async () => {
    const root = tempRoot();
    const dataDir = tempDir();
    const app = appOn(dataDir, root);

    const planned = await app.controller.planTask('list sub/ then read notes.txt');
    assert.equal(planned.status, Outcome.PLAN_CREATED, planned.display);
    const task = await onlyTask(app);
    assert.equal(task.status, TaskStatus.PENDING);
    assert.deepEqual(task.steps.map((s) => s.action), ['filesystem.list', 'filesystem.read']);
    assert.deepEqual(task.steps.map((s) => s.permission), ['read', 'read']);
    assert.deepEqual(task.steps[1].dependsOn, ['s1']);
    assert.deepEqual(Object.keys(task.steps[0].input).sort(), ['limit', 'path']);

    const run = await app.controller.runTask(task.id, 'run');
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.display);
    const done = await app.taskStore.get(task.id);
    assert.equal(done.status, TaskStatus.COMPLETED);
    assert.deepEqual(progressOf(done), { completed: 2, total: 2 });
    assert.match(done.steps[0].summary, /listed 1 entry in "sub\/" \(verified\)/);
    assert.match(done.steps[1].summary, /read 11 bytes from "notes.txt" \(verified\)/);
    assert.equal(done.steps[0].outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(done.steps[1].outcome, Outcome.SUCCESS_VERIFIED);

    const ops = await opsFor(app, 'task.step');
    assert.equal(ops.length, 2);
    for (const rec of ops) {
      assert.equal(rec.status, Outcome.SUCCESS_VERIFIED);
      assert.equal(rec.task.id, task.id);
      assert.equal(rec.steps[0].verification.outcome, Outcome.SUCCESS_VERIFIED);
      assert.equal(rec.steps[0].authorization.decision, 'allow');
      assert.ok(!JSON.stringify(rec).includes('hello apex'), 'file content must not reach the audit log');
      assert.ok(!JSON.stringify(rec).includes(root), 'the absolute root must not reach the audit log');
    }
    assert.deepEqual(ops.map((r) => r.task.stepId).sort(), ['s1', 's2']);
  });

  test('a multi-part filesystem request runs as a listing task through the controller', async () => {
    const root = tempRoot();
    const app = appOn(tempDir(), root);

    const res = await app.controller.handle('list sub/; list .');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    const task = await onlyTask(app);
    assert.equal(task.status, TaskStatus.COMPLETED);
    assert.equal(task.planner, 'deterministic');
    assert.deepEqual(task.steps.map((s) => s.action), ['filesystem.list', 'filesystem.list']);
    assert.match(task.steps[1].summary, /listed 3 entries/);
    assert.equal((await opsFor(app, 'task.step')).length, 2);
  });

  test('a model-proposed plan containing a filesystem step is rejected and stores nothing', async () => {
    const root = tempRoot();
    const reply = JSON.stringify({
      steps: [{ id: 's1', description: 'read the notes', action: 'filesystem.read', input: { path: 'notes.txt' }, depends_on: [] }],
    });
    const captured = [];
    const app = appOn(tempDir(), root, testDoubleModel(reply, captured));

    const res = await app.controller.planTask('look at my notes file');
    assert.equal(res.status, Outcome.PLAN_REJECTED);
    assert.match(res.display, /not permitted in this plan|ORIGIN_NOT_PERMITTED/);
    assert.equal(captured.length, 1, 'the model was asked for a plan');
    assert.equal((await app.taskStore.list()).length, 0, 'no task was stored');
    assert.equal((await opsFor(app, 'task.step')).length, 0, 'nothing ran');
  });

  test('a plan step cannot widen the authorised root', async () => {
    const root = tempRoot();
    const reply = JSON.stringify({
      steps: [{ id: 's1', description: 'list everything', action: 'filesystem.list', input: { path: '.', root: 'C:\\' }, depends_on: [] }],
    });
    const app = appOn(tempDir(), root, testDoubleModel(reply));

    // A model-origin filesystem step is refused first, by authorization.
    const res = await app.controller.planTask('list my whole disk');
    assert.equal(res.status, Outcome.PLAN_REJECTED);
    assert.match(res.display, /ORIGIN_NOT_PERMITTED/);
    assert.equal((await app.taskStore.list()).length, 0);

    // If such a step ever reached a user-origin plan, validation refuses the extra field.
    const registry = app.registry;
    const checked = checkSteps(
      [{ id: 's1', description: 'list everything', action: 'filesystem.list', input: { path: '.', root: 'C:\\' }, dependsOn: [] }],
      registry,
      'user',
    );
    assert.equal(checked.steps.length, 0);
    assert.match(checked.problems.join('\n'), /unexpected input field "root"/);
  });
});

describe('task execution: filesystem security failures', () => {
  test('a traversal step fails the task, skips its dependants, and records the refusal', async () => {
    const root = tempRoot();
    const app = appOn(tempDir(), root);

    const planned = await app.controller.planTask('list ../ then read notes.txt');
    assert.equal(planned.status, Outcome.PLAN_CREATED, planned.display);
    const task = await onlyTask(app);

    const run = await app.controller.runTask(task.id, 'run');
    assert.equal(run.status, Outcome.EXECUTION_FAILED);
    const failed = await app.taskStore.get(task.id);
    assert.equal(failed.status, TaskStatus.FAILED);
    assert.deepEqual(failed.steps.map((s) => s.status), ['failed', 'skipped']);
    assert.equal(failed.steps[0].outcome, Outcome.EXECUTION_FAILED);

    const ops = await opsFor(app, 'task.step');
    assert.equal(ops.length, 1, 'the skipped step never ran');
    assert.equal(ops[0].task.stepId, 's1');
    assert.equal(ops[0].steps[0].execution.error.code, 'ACCESS_DENIED');
    assert.equal(ops[0].steps[0].verification.outcome, 'not_run');
    assert.ok(!JSON.stringify(ops).includes('hello apex'));
  });

  test('a task cannot read a file outside the root even when the path is absolute', async () => {
    const root = tempRoot();
    const outside = path.join(tempDir(), 'secret.txt');
    fs.writeFileSync(outside, 'outside secret\n');
    const app = appOn(tempDir(), root);

    // The planner stores the input; containment is enforced when the step runs.
    const planned = await app.controller.planTask(`read ${outside}`);
    if (planned.status === Outcome.PLAN_CREATED) {
      const task = await onlyTask(app);
      const run = await app.controller.runTask(task.id, 'run');
      assert.equal(run.status, Outcome.EXECUTION_FAILED);
      const step = (await app.taskStore.get(task.id)).steps[0];
      assert.equal(step.outcome, Outcome.EXECUTION_FAILED);
      assert.match(step.summary, /not allowed/);
    } else {
      assert.equal(planned.status, Outcome.PLAN_REJECTED);
    }
    assert.ok(!JSON.stringify(await app.operations.list({ limit: 100 })).includes('outside secret'));
  });
});

describe('task execution: verification and audit failures', () => {
  test('a file changing between the read and its verification fails the task', async () => {
    const root = tempRoot();
    const app = appOn(tempDir(), root);
    const planned = await app.controller.planTask('read notes.txt');
    assert.equal(planned.status, Outcome.PLAN_CREATED, planned.display);
    const task = await onlyTask(app);

    // TEST DOUBLE: only the registry read is wrapped, to change the file after the real
    // execute() returns and before the real verify() runs.
    const real = app.registry;
    app.controller.registry = {
      get: (name) => {
        const def = real.get(name);
        if (name !== 'filesystem.read' || !def) return def;
        return {
          ...def,
          execute: async (ctx, input) => {
            const result = await def.execute(ctx, input);
            fs.writeFileSync(path.join(root, 'notes.txt'), 'changed after the read\n');
            return result;
          },
        };
      },
      authorize: (name, origin) => real.authorize(name, origin),
      list: () => real.list(),
      names: () => real.names(),
    };

    const run = await app.controller.runTask(task.id, 'run');
    assert.equal(run.status, Outcome.VERIFICATION_FAILED);
    const failed = await app.taskStore.get(task.id);
    assert.equal(failed.status, TaskStatus.FAILED);
    assert.equal(failed.steps[0].status, StepStatus.FAILED);
    assert.equal(failed.steps[0].outcome, Outcome.VERIFICATION_FAILED);
    assert.match(failed.steps[0].summary, /NOT confirmed/);

    const ops = await opsFor(app, 'task.step');
    assert.equal(ops.length, 1);
    assert.equal(ops[0].status, Outcome.VERIFICATION_FAILED);
    assert.equal(ops[0].steps[0].verification.outcome, Outcome.VERIFICATION_FAILED);
    assert.match(ops[0].steps[0].verification.detail, /changed|bytes/);
  });

  test('a completed filesystem task with missing step audit records is audit_integrity_failed', async () => {
    const root = tempRoot();
    const app = appOn(tempDir(), root);
    const originalAppend = app.operations.append.bind(app.operations);
    let stepWrites = 0;
    app.operations.append = async (record) => {
      if (record.capability === 'task.step') {
        stepWrites += 1;
        throw new Error('injected step audit failure');
      }
      return originalAppend(record);
    };

    const planned = await app.controller.planTask('list sub/ then read notes.txt');
    const task = await onlyTask(app);
    const run = await app.controller.runTask(task.id, 'run');

    assert.equal(run.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.equal(run.underlyingStatus, Outcome.SUCCESS_VERIFIED);
    assert.equal(run.auditGaps, 2);
    assert.match(run.display, /Audit integrity failure/);

    // The task result is preserved even though its records are missing.
    const done = await app.taskStore.get(task.id);
    assert.equal(done.status, TaskStatus.COMPLETED);
    assert.deepEqual(done.steps.map((s) => s.status), ['completed', 'completed']);
    assert.equal(stepWrites, 2);

    // Re-running does not re-execute anything.
    const again = await app.controller.runTask(task.id, 'run');
    assert.equal(again.status, Outcome.INPUT_REJECTED);
    assert.equal(stepWrites, 2, 'no step was executed again');
  });

  test('a failed step keeps its action failure when its audit write also fails', async () => {
    const root = tempRoot();
    const app = appOn(tempDir(), root);
    const originalAppend = app.operations.append.bind(app.operations);
    app.operations.append = async (record) => {
      if (record.capability === 'task.step') throw new Error('injected step audit failure');
      return originalAppend(record);
    };

    await app.controller.planTask('read missing.txt');
    const task = await onlyTask(app);
    const run = await app.controller.runTask(task.id, 'run');
    assert.equal(run.status, Outcome.EXECUTION_FAILED);
    assert.equal(run.auditGaps, 1);
    const failed = await app.taskStore.get(task.id);
    assert.equal(failed.steps[0].outcome, Outcome.EXECUTION_FAILED);
    assert.match(failed.steps[0].summary, /does not exist/);
  });
});

describe('task execution: restart and recovery', () => {
  test('an interrupted filesystem step is never replayed; only an explicit retry runs it again', async () => {
    const root = tempRoot();
    const dataDir = tempDir();
    const app = appOn(dataDir, root);
    await app.controller.planTask('read notes.txt; read sub/inner.txt');
    const task = await onlyTask(app);

    // Simulate a process that died after recording "running" for s1 and before its result.
    await app.taskStore.transition(task.id, {
      reason: 'simulated interruption',
      task: { from: 'pending', to: 'running' },
      steps: [{ id: 's1', from: 'pending', to: 'running', operationId: 'dead-process' }],
    });

    const restarted = appOn(dataDir, root);
    const first = await restarted.controller.runTask(task.id, 'run');
    assert.equal(first.status, Outcome.INPUT_REJECTED, 'a paused task is resumed, not run from scratch');

    const paused = await restarted.taskStore.get(task.id);
    assert.equal(paused.status, TaskStatus.PAUSED);
    assert.equal(paused.steps[0].status, StepStatus.UNCERTAIN);
    assert.equal((await opsFor(restarted, 'task.step')).length, 0, 'the uncertain read was not executed');

    const blocked = await restarted.controller.runTask(task.id, 'resume');
    assert.equal(blocked.status, Outcome.INPUT_REJECTED);
    assert.match(blocked.display, /not run again/);
    assert.equal((await opsFor(restarted, 'task.step')).length, 0);

    // A read-only step may be retried explicitly; the file read is still read-only.
    const retry = await restarted.controller.retryTask(task.id, 's1');
    assert.equal(retry.status, Outcome.SUCCESS_VERIFIED);
    const done = await restarted.controller.runTask(task.id, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED);
    const completed = await restarted.taskStore.get(task.id);
    assert.equal(completed.status, TaskStatus.COMPLETED);
    assert.deepEqual(completed.steps.map((s) => s.status), ['completed', 'completed']);
    assert.equal((await opsFor(restarted, 'task.step')).length, 2);
  });
});

describe('task execution: command line', () => {
  test('a filesystem task plans and runs through bin/apex.js with exit 0', async () => {
    const root = tempRoot();
    const dataDir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, APEX_FILESYSTEM_ROOT: root, HOME: dataDir, USERPROFILE: dataDir });

    const plan = await runCli(['task', 'plan', 'list sub/ then read notes.txt'], env);
    assert.equal(plan.code, 0, plan.stdout + plan.stderr);
    assert.match(plan.stdout, /status: pending/);
    assert.match(plan.stdout, /Nothing has run yet/);
    const short = SHORT_ID.exec(plan.stdout)[1];

    const run = await runCli(['task', 'run', short], env);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /status: completed/);
    assert.match(run.stdout, /\(verified\)/);

    const show = await runCli(['task', 'show', short], env);
    assert.equal(show.code, 0);
    assert.match(show.stdout, /2 of 2 step\(s\) completed/);

    const again = await runCli(['task', 'run', short], env);
    assert.equal(again.code, 1, 'a completed task is not run again');
  });

  test('a failed filesystem step makes task run exit nonzero', async () => {
    const root = tempRoot();
    const dataDir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, APEX_FILESYSTEM_ROOT: root, HOME: dataDir, USERPROFILE: dataDir });

    const plan = await runCli(['task', 'plan', 'list sub/ then read missing.txt'], env);
    assert.equal(plan.code, 0, plan.stdout + plan.stderr);
    const short = SHORT_ID.exec(plan.stdout)[1];

    const run = await runCli(['task', 'run', short], env);
    assert.equal(run.code, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /status: failed/);
    assert.match(run.stdout, /execution failed: path does not exist/);
  });

  test('an audit write failure makes the command exit nonzero and says the result is unrecorded', async () => {
    const root = tempRoot();
    const dataDir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, APEX_FILESYSTEM_ROOT: root, HOME: dataDir, USERPROFILE: dataDir });

    const plan = await runCli(['task', 'plan', 'list sub/ then read notes.txt'], env);
    assert.equal(plan.code, 0, plan.stdout + plan.stderr);
    const short = SHORT_ID.exec(plan.stdout)[1];

    // Fault injection: the audit log can no longer be appended to.
    fs.rmSync(path.join(dataDir, 'operations.jsonl'), { force: true });
    fs.mkdirSync(path.join(dataDir, 'operations.jsonl'));

    const run = await runCli(['task', 'run', short], env);
    assert.equal(run.code, 3, run.stdout + run.stderr);
    assert.match(run.stderr, /NOT RECORDED|could not be written/);
    assert.match(run.stdout, /Audit integrity failure/);
  });

  test('without an authorised root, a filesystem goal is rejected and exits 1', async () => {
    const dataDir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
    const plan = await runCli(['task', 'plan', 'list sub/ then read notes.txt'], env);
    assert.equal(plan.code, 1, plan.stdout + plan.stderr);
    assert.match(plan.stdout, /not available in this configuration/);
    assert.equal(fs.existsSync(path.join(dataDir, 'tasks.jsonl')), false);
  });
});
