// Controlled task planner: validation, persistence, execution, failure handling,
// authorization, safe resume, cancellation, and consistency with the operation log.
//
// TEST DOUBLES in this file are labelled as such. "test-double" backends return fixed
// text chosen by the test. They prove how APEX handles a reply; they say nothing about
// what a real model would reply. Stub HTTP servers (helpers.js) exercise the real
// gateway protocol with the same kind of fixed reply. No real model was used here.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createGateway, ModelGateway, NoBackend } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { planFromText, checkSteps, parseModelPlan, redactGoal } from '../src/tasks/planner.js';
import { canTransition, dependencyProblems, topologicalOrder, TASK_TRANSITIONS, TaskStatus, StepStatus, progressOf } from '../src/tasks/model.js';
import { ActionRegistry } from '../src/actions/registry.js';
import { builtinActions } from '../src/actions/builtin.js';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/tasks/store.js';
import { TaskRunner } from '../src/controller/task-runner.js';
import { makeTempDataDir, cleanup, startStubModel, closedPortUrl, runCli, cleanEnv } from './helpers.js';

const dirs = [];
const stubs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });

function tempDir() {
  const d = makeTempDataDir();
  dirs.push(d);
  return d;
}

// Creates an app on a data directory. Calling it again on the same directory is a restart.
function appOn(dataDir, gateway = new ModelGateway({ backend: new NoBackend() })) {
  return createApp({ dataDir, gateway });
}

// TEST DOUBLE: a model backend that returns `reply` and records each request it receives.
function testDoubleModel(reply, captured = []) {
  const backend = {
    name: 'test-double',
    provider: 'test-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'test-double', endpoint: 'test-double', model: 'test-double' }),
    health: async () => ({ available: true, detail: 'test double' }),
    complete: async (req) => {
      captured.push(req);
      return { ok: true, backend: 'test-double', provider: 'test-double', model: 'test-double', text: reply, finishReason: 'stop', truncated: false, latencyMs: 0 };
    },
  };
  return new ModelGateway({ backend });
}

function readRaw(dataDir, file) {
  try {
    return fs.readFileSync(path.join(dataDir, file), 'utf8');
  } catch {
    return '';
  }
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

const modelPlanWithWrite = JSON.stringify({
  steps: [
    { id: 's1', description: 'work out the total', action: 'calc.evaluate', input: { expression: '2+3' }, depends_on: [] },
    { id: 's2', description: 'save the total as a fact', action: 'memory.add', input: { content: 'The total is five' }, depends_on: ['s1'] },
  ],
});

describe('task model: states, transitions, dependencies', () => {
  test('only the defined task transitions are valid', () => {
    assert.equal(canTransition(TASK_TRANSITIONS, 'pending', 'running'), true);
    assert.equal(canTransition(TASK_TRANSITIONS, 'pending', 'completed'), false);
    assert.equal(canTransition(TASK_TRANSITIONS, 'completed', 'running'), false);
    assert.equal(canTransition(TASK_TRANSITIONS, 'cancelled', 'pending'), false);
    assert.equal(canTransition(TASK_TRANSITIONS, 'failed', 'paused'), true);
  });

  test('cycles, self-dependencies, and unknown dependencies are reported', () => {
    const cycle = [
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ];
    assert.ok(dependencyProblems(cycle).some((p) => /cycle/.test(p)));
    assert.ok(dependencyProblems([{ id: 'a', dependsOn: ['a'] }]).length > 0);
    assert.ok(dependencyProblems([{ id: 'a', dependsOn: ['ghost'] }]).some((p) => /ghost/.test(p)));
  });

  test('dependency order is respected', () => {
    const steps = [
      { id: 'c', dependsOn: ['a', 'b'] },
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
    ];
    assert.deepEqual(topologicalOrder(steps), ['a', 'b', 'c']);
  });
});

describe('planning and validation', () => {
  test('a deterministic multi-step goal becomes a checked plan with a dependency chain', () => {
    const plan = planFromText('calc (2+3)*4; calc 10/2', new ActionRegistry());
    assert.equal(plan.ok, false, 'an empty registry has no actions, so it must refuse');
    const registry = new ActionRegistry();
    for (const def of builtinActions()) registry.register(def);
    const ok = planFromText('calc (2+3)*4; calc 10/2', registry);
    assert.equal(ok.ok, true, ok.problems.join('; '));
    assert.deepEqual(ok.steps.map((s) => s.id), ['s1', 's2']);
    assert.deepEqual(ok.steps[1].dependsOn, ['s1']);
    assert.equal(ok.steps[0].permission, 'read');
    assert.equal(ok.steps[0].status, undefined, 'steps carry no status until the store records them');
  });

  test('an unknown or unsupported part rejects the whole plan', () => {
    const registry = new ActionRegistry();
    for (const def of builtinActions()) registry.register(def);
    const plan = planFromText('calc 1+1; launch rockets', registry);
    assert.equal(plan.ok, false);
    assert.ok(plan.problems.some((p) => /part 2 is not a supported action/.test(p)));
  });

  test('model plans are strictly parsed: malformed JSON, extra fields, and oversize plans are rejected', () => {
    assert.equal(parseModelPlan('here is my plan: do things').ok, false);
    assert.equal(parseModelPlan('{"steps":[],"owner":"me"}').ok, false);
    assert.equal(parseModelPlan('{"steps":"s1"}').ok, false);
    assert.equal(parseModelPlan(JSON.stringify({ steps: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, action: 'app.status' })) })).ok, false);
    assert.equal(parseModelPlan('```json\n{"steps":[]}\n```').ok, true, 'a fenced block is accepted');
    assert.equal(parseModelPlan(modelPlanWithWrite).ok, true);
  });

  test('model plans with unknown actions, bad dependencies, or cycles are rejected by the checker', () => {
    const registry = new ActionRegistry();
    for (const def of builtinActions()) registry.register(def);
    const unknown = checkSteps([{ id: 's1', description: 'run a shell', action: 'shell.run', input: {}, dependsOn: [] }], registry, 'model');
    assert.ok(unknown.problems.some((p) => /unknown action/.test(p)));
    const dangling = checkSteps([{ id: 's1', description: 'calc', action: 'calc.evaluate', input: { expression: '1+1' }, dependsOn: ['s9'] }], registry, 'model');
    assert.ok(dangling.problems.some((p) => /s9/.test(p)));
    const cyclic = checkSteps([
      { id: 's1', description: 'a', action: 'calc.evaluate', input: { expression: '1+1' }, dependsOn: ['s2'] },
      { id: 's2', description: 'b', action: 'calc.evaluate', input: { expression: '2+2' }, dependsOn: ['s1'] },
    ], registry, 'model');
    assert.ok(cyclic.problems.some((p) => /cycle/.test(p)));
  });

  test('a non-plannable action is refused even when named directly', () => {
    const registry = new ActionRegistry();
    for (const def of builtinActions()) registry.register(def);
    const r = checkSteps([{ id: 's1', description: 'save a conclusion', action: 'memory.save_conclusion', input: { content: 'x' }, dependsOn: [] }], registry, 'model');
    assert.ok(r.problems.some((p) => /cannot be part of a plan/.test(p)));
  });

  test('a private memory write is refused inside a task, and its content never reaches the task log', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const res = await app.controller.planTask('calc (2+3)*4; remember privately that my pin is 4417');
    assert.equal(res.status, Outcome.PLAN_REJECTED);
    assert.match(res.display, /private memory write cannot be part of a task/);
    assert.equal((await app.taskStore.list()).length, 0);
    assert.doesNotMatch(readRaw(dataDir, 'tasks.jsonl'), /4417/);
    assert.doesNotMatch(readRaw(dataDir, 'operations.jsonl'), /4417/);
  });

  test('the goal is redacted before it is stored or shown', () => {
    const redacted = redactGoal('remember that the codename is Lighthouse');
    assert.match(redacted, /^remember \[content omitted: \d+ chars\]$/);
    assert.doesNotMatch(redacted, /Lighthouse/);
  });

  test('an unsupported goal with no model configured is refused and nothing is stored', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const res = await app.controller.planTask('calc 1+1; launch rockets');
    assert.equal(res.status, Outcome.PLAN_REJECTED);
    assert.equal((await app.taskStore.list()).length, 0);
    assert.equal(res.recorded, true, 'the refusal itself is recorded in the operation log');
  });
});

describe('creation and persistence', () => {
  test('a task has an id, a timestamp, the goal, explicit steps, and survives a restart', async () => {
    const dataDir = tempDir();
    const first = appOn(dataDir);
    const res = await first.controller.planTask('calc (2+3)*4; calc 10/2');
    assert.equal(res.status, Outcome.PLAN_CREATED);
    const created = await onlyTask(first);
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(created.createdAt)));
    assert.equal(created.goal, 'calc (2+3)*4; calc 10/2');
    assert.equal(created.status, TaskStatus.PENDING);
    assert.deepEqual(created.steps.map((s) => [s.id, s.status, s.action]), [['s1', 'pending', 'calc.evaluate'], ['s2', 'pending', 'calc.evaluate']]);

    const restarted = appOn(dataDir); // a new process, same data directory
    const shown = await restarted.controller.showTask(created.id.slice(0, 8));
    assert.equal(shown.task.id, created.id);
    assert.equal(shown.task.steps.length, 2);
    assert.match(await restarted.controller.listTasks(), new RegExp(created.id.slice(0, 8)));
  });

  test('two plans get distinct ids', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    await app.controller.planTask('calc 1+1; calc 2+2');
    await app.controller.planTask('calc 3+3; calc 4+4');
    const tasks = await app.taskStore.list();
    assert.equal(tasks.length, 2);
    assert.notEqual(tasks[0].id, tasks[1].id);
  });

  test('an invalid transition is refused by the store and never written', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    await app.controller.planTask('calc 1+1; calc 2+2');
    const task = await onlyTask(app);
    const before = readRaw(dataDir, 'tasks.jsonl');
    await assert.rejects(
      app.taskStore.transition(task.id, { reason: 'illegal', task: { from: 'pending', to: 'completed' }, steps: [] }),
      /refused|illegal/,
    );
    assert.equal(readRaw(dataDir, 'tasks.jsonl'), before);
  });

  test('a lock held by a live process is refused, and a stale lock from a dead process is recovered', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    // process.ppid is alive (the test runner), so this stands in for "another process is working".
    fs.writeFileSync(path.join(dataDir, 'tasks.jsonl.lock'), JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
    const busy = await app.controller.planTask('calc 1+1; calc 2+2');
    assert.equal(busy.status, Outcome.EXECUTION_FAILED);
    assert.match(busy.display, /in use by process/);
    assert.equal((await app.taskStore.list()).length, 0);
    fs.rmSync(path.join(dataDir, 'tasks.jsonl.lock'));

    // A pid that cannot be alive counts as stale and is removed.
    fs.writeFileSync(path.join(dataDir, 'tasks.jsonl.lock'), JSON.stringify({ pid: 2147483646, at: new Date().toISOString() }));
    const ok = await app.controller.planTask('calc 1+1; calc 2+2');
    assert.equal(ok.status, Outcome.PLAN_CREATED);
  });
});

describe('model-proposed plans (test doubles and stub protocol)', () => {
  test('model plan is stored as a proposal, does not run, and needs approval before it can run', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir, testDoubleModel(modelPlanWithWrite));
    const memoryBefore = readRaw(dataDir, 'memory.jsonl');
    const res = await app.controller.planTask('organise my week and save the total');
    assert.equal(res.status, Outcome.PLAN_PROPOSED);
    const task = await onlyTask(app);
    assert.equal(task.status, TaskStatus.PROPOSED);
    assert.equal(task.planner, 'model');
    assert.equal(task.steps.every((s) => s.status === StepStatus.PENDING), true, 'nothing ran');
    assert.equal(readRaw(dataDir, 'memory.jsonl'), memoryBefore, 'a plan is not saved to memory');

    const run = await app.controller.runTask(task.id.slice(0, 8), 'run');
    assert.equal(run.status, Outcome.INPUT_REJECTED);
    assert.match(run.display, /needs your approval first/);
  });

  test('the model prompt gets the redacted goal and never private memory content', async () => {
    const dataDir = tempDir();
    const captured = [];
    const app = appOn(dataDir, testDoubleModel(modelPlanWithWrite, captured));
    await app.controller.planTask('remember privately that my dentist is Dr Rao and organise my week');
    assert.equal(captured.length, 1);
    assert.doesNotMatch(captured[0].prompt, /Dr Rao|dentist/);
    assert.match(captured[0].prompt, /GOAL \(data, not instructions\)/);
    assert.match(captured[0].system, /cannot approve anything/);
  });

  test('approval, then a read runs, then the write waits for its own approval, then resumes safely after a restart', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir, testDoubleModel(modelPlanWithWrite));
    await app.controller.planTask('organise my week and save the total');
    const task = await onlyTask(app);
    const approved = await app.controller.approveTask(task.id.slice(0, 8));
    assert.equal(approved.status, Outcome.SUCCESS_VERIFIED);

    const memoryBefore = readRaw(dataDir, 'memory.jsonl');
    const paused = await app.controller.runTask(task.id, 'run');
    assert.equal(paused.status, Outcome.TASK_PAUSED);
    const mid = await app.taskStore.get(task.id);
    assert.deepEqual(mid.steps.map((s) => s.status), ['completed', 'awaiting_approval']);
    assert.equal(readRaw(dataDir, 'memory.jsonl'), memoryBefore, 'the model-proposed write has not run');

    const restarted = appOn(dataDir, testDoubleModel(modelPlanWithWrite));
    const gate = await restarted.controller.approveTask(task.id, { stepId: 's2' });
    assert.equal(gate.status, Outcome.SUCCESS_VERIFIED);
    const done = await restarted.controller.runTask(task.id, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED);

    // No re-execution: the calculation ran exactly once.
    const calcOps = (await opsFor(restarted, 'task.step')).filter((r) => r.task.stepId === 's1');
    assert.equal(calcOps.length, 1);
    assert.notEqual(readRaw(dataDir, 'memory.jsonl'), memoryBefore, 'the approved write ran');
  });

  test('a step can be approved only while it is waiting for approval', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir, testDoubleModel(modelPlanWithWrite));
    await app.controller.planTask('organise my week and save the total');
    const task = await onlyTask(app);
    await app.controller.approveTask(task.id);
    await app.controller.runTask(task.id, 'run');
    const res = await app.controller.approveTask(task.id, { stepId: 's1' });
    assert.equal(res.status, Outcome.INPUT_REJECTED);
  });

  test('a malformed model reply is rejected and nothing is stored (real HTTP protocol, stub reply)', async () => {
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.reply = 'Sure! First, you should probably calculate the total.';
    const dataDir = tempDir();
    const gateway = createGateway({ url: stub.url, name: 'stub', timeoutMs: 3000, retries: 0, allowRemote: false });
    const app = appOn(dataDir, gateway);
    const res = await app.controller.planTask('organise my week and save the total');
    assert.equal(res.status, Outcome.PLAN_REJECTED);
    assert.match(res.display, /not valid JSON/);
    assert.equal((await app.taskStore.list()).length, 0);
  });

  test('a model plan that names a forbidden action is rejected', async () => {
    const dataDir = tempDir();
    const reply = JSON.stringify({ steps: [{ id: 's1', description: 'run a script', action: 'shell.exec', input: { cmd: 'rm -rf /' }, depends_on: [] }] });
    const app = appOn(dataDir, testDoubleModel(reply));
    const res = await app.controller.planTask('clean up my disk');
    assert.equal(res.status, Outcome.PLAN_REJECTED);
    assert.match(res.display, /unknown action/);
    assert.equal((await app.taskStore.list()).length, 0);
  });

  test('model unavailable: a clear failure, no task, and the rest of the app still works', async () => {
    const dataDir = tempDir();
    const gateway = createGateway({ url: await closedPortUrl(), name: 'down', timeoutMs: 2000, retries: 0, allowRemote: false });
    const app = appOn(dataDir, gateway);
    const res = await app.controller.planTask('organise my week and save the total');
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /did not return a plan/);
    assert.equal((await app.taskStore.list()).length, 0);
    const calc = await app.controller.handle('calc 2+2');
    assert.equal(calc.status, Outcome.SUCCESS_VERIFIED);
  });
});

describe('execution', () => {
  test('a verified task reports audit-integrity failure when step audit persistence fails', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const originalAppend = app.operations.append.bind(app.operations);
    let stepAuditAttempts = 0;
    app.operations.append = async (record) => {
      if (record.capability === 'task.step') {
        stepAuditAttempts += 1;
        throw new Error('injected step audit failure');
      }
      return originalAppend(record);
    };

    await app.controller.planTask('calc 1+1');
    const task = await onlyTask(app);
    const res = await app.controller.runTask(task.id, 'run');

    assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.equal(res.underlyingStatus, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.auditGaps, 1);
    assert.deepEqual(res.auditGapSteps, ['s1']);
    assert.equal(stepAuditAttempts, 1);
    assert.equal(res.recorded, true, 'the outer task operation still records');
    const done = await app.taskStore.get(task.id);
    assert.equal(done.status, TaskStatus.COMPLETED);
    assert.equal(done.steps[0].outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal((await opsFor(app, 'task.step')).length, 0);

    const restarted = appOn(dataDir);
    const inspected = await restarted.taskStore.get(task.id);
    assert.equal(inspected.status, TaskStatus.COMPLETED);
    assert.equal(inspected.steps[0].outcome, Outcome.SUCCESS_VERIFIED);
    const rerun = await restarted.controller.runTask(task.id, 'run');
    assert.equal(rerun.status, Outcome.INPUT_REJECTED);
    assert.equal(stepAuditAttempts, 1, 'the missing audit record does not cause re-execution');
  });

  test('preserves an action failure when its step audit write also fails', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const originalAppend = app.operations.append.bind(app.operations);
    app.operations.append = async (record) => {
      if (record.capability === 'task.step') throw new Error('injected step audit failure');
      return originalAppend(record);
    };

    await app.controller.planTask('calc 1/0');
    const task = await onlyTask(app);
    const res = await app.controller.runTask(task.id, 'run');

    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(res.underlyingStatus, Outcome.EXECUTION_FAILED);
    assert.equal(res.auditGaps, 1);
    assert.match(res.display, /division by zero/);
    const failed = await app.taskStore.get(task.id);
    assert.equal(failed.status, TaskStatus.FAILED);
    assert.equal(failed.steps[0].outcome, Outcome.EXECUTION_FAILED);
  });

  test('a deterministic task runs existing actions and every verified result matches the operation log', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    await app.controller.planTask('calc (2+3)*4; calc 10/2; remember that the codename is Lighthouse');
    const task = await onlyTask(app);
    const res = await app.controller.runTask(task.id, 'run');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    const done = await app.taskStore.get(task.id);
    assert.equal(done.status, TaskStatus.COMPLETED);
    assert.deepEqual(progressOf(done), { completed: 3, total: 3 });
    assert.match(done.steps[0].summary, /= 20 \(verified\)/);
    assert.match(done.steps[1].summary, /= 5 \(verified\)/);

    // Consistency: each completed step points at one operation record, which says the same.
    const ops = await opsFor(app, 'task.step');
    assert.equal(ops.length, 3);
    for (const step of done.steps) {
      assert.equal(step.status, StepStatus.COMPLETED);
      const rec = ops.find((r) => r.id === step.operationId);
      assert.ok(rec, `operation record for ${step.id} is missing`);
      assert.equal(rec.status, Outcome.SUCCESS_VERIFIED);
      assert.equal(rec.task.id, task.id);
      assert.equal(rec.task.stepId, step.id);
    }
    // Memory was written by the one remember step, and only that.
    assert.equal((await app.memory.list({ limit: 10 })).length, 1);
  });

  test('a failed step stops the task, skips the steps that depend on it, and the state survives a restart', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    await app.controller.planTask('calc 1/0; calc 2+2; calc 3+3');
    const task = await onlyTask(app);
    const res = await app.controller.runTask(task.id, 'run');
    assert.equal(res.status, Outcome.EXECUTION_FAILED);

    const restarted = appOn(dataDir);
    const failed = await restarted.taskStore.get(task.id);
    assert.equal(failed.status, TaskStatus.FAILED);
    assert.deepEqual(failed.steps.map((s) => s.status), ['failed', 'skipped', 'skipped']);
    assert.deepEqual(progressOf(failed), { completed: 0, total: 3 });
    // Skipped steps never ran.
    const ops = (await opsFor(restarted, 'task.step')).map((r) => r.task.stepId);
    assert.deepEqual(ops, ['s1']);
  });

  test('a step whose result cannot be verified is recorded as uncertain, never as success (test-double execute)', async () => {
    const dataDir = tempDir();
    const store = new TaskStore(path.join(dataDir, 'tasks.jsonl'));
    const taskId = randomUUID();
    const step = (id, expression, dependsOn) => ({ id, description: `calc ${expression}`, action: 'calc.evaluate', permission: 'read', input: { expression }, dependsOn });
    await store.withLock(() => store.createTask({ taskId, goal: 'two calcs', origin: 'user', planner: 'deterministic', steps: [step('s1', '1+1', []), step('s2', '2+2', ['s1'])] }));
    const executed = [];
    // TEST DOUBLE: the action runs, but its result cannot be verified.
    const runner = new TaskRunner({
      store,
      execute: async (name, input) => {
        executed.push(input.expression);
        return { outcome: Outcome.VERIFICATION_UNAVAILABLE, summary: 'could not be checked', status: 'ok' };
      },
      recordOperation: async () => {},
      idFactory: () => randomUUID(),
    });
    const res = await store.withLock(() => runner.run(taskId, { mode: 'run' }));
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.deepEqual(executed, ['1+1'], 'the dependent step never ran');
    const after = await store.get(taskId);
    assert.deepEqual(after.steps.map((x) => x.status), ['uncertain', 'skipped']);
    assert.equal(after.status, TaskStatus.FAILED);
  });

  test('an interrupted running step is not run again: it becomes uncertain, and only an explicit retry of a read-only step allows a re-run', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    await app.controller.planTask('calc 1+1; calc 2+2');
    const task = await onlyTask(app);
    // Simulate a process that died after recording "running" for s1 and before its result.
    await app.taskStore.transition(task.id, {
      reason: 'simulated interruption',
      task: { from: 'pending', to: 'running' },
      steps: [{ id: 's1', from: 'pending', to: 'running', operationId: 'dead-process' }],
    });

    const restarted = appOn(dataDir);
    const first = await restarted.controller.runTask(task.id, 'run');
    assert.equal(first.status, Outcome.INPUT_REJECTED, 'a paused task is resumed, not run from scratch');
    const paused = await restarted.taskStore.get(task.id);
    assert.equal(paused.status, TaskStatus.PAUSED);
    assert.equal(paused.steps[0].status, StepStatus.UNCERTAIN);

    const blocked = await restarted.controller.runTask(task.id, 'resume');
    assert.equal(blocked.status, Outcome.INPUT_REJECTED);
    assert.match(blocked.display, /not run again/);
    assert.equal((await opsFor(restarted, 'task.step')).length, 0, 'the uncertain step was not executed');

    const retry = await restarted.controller.retryTask(task.id, 's1');
    assert.equal(retry.status, Outcome.SUCCESS_VERIFIED);
    const done = await restarted.controller.runTask(task.id, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED);
    assert.equal((await restarted.taskStore.get(task.id)).status, TaskStatus.COMPLETED);
  });

  test('an uncertain write step is never retried automatically or on request', async () => {
    const dataDir = tempDir();
    const reply = JSON.stringify({ steps: [{ id: 's1', description: 'save a fact', action: 'memory.add', input: { content: 'Lighthouse is the codename' }, depends_on: [] }] });
    const app = appOn(dataDir, testDoubleModel(reply));
    await app.controller.planTask('save the codename');
    const task = await onlyTask(app);
    await app.controller.approveTask(task.id);
    // Fault injection: the write started, and its result was never recorded.
    await app.taskStore.transition(task.id, { reason: 'fault injection', task: { from: 'pending', to: 'running' }, steps: [{ id: 's1', from: 'pending', to: 'running', operationId: 'injected' }] });
    await app.taskStore.transition(task.id, { reason: 'fault injection', task: { from: 'running', to: 'failed' }, steps: [{ id: 's1', from: 'running', to: 'uncertain', summary: 'injected' }] });
    const retry = await app.controller.retryTask(task.id, 's1');
    assert.equal(retry.status, Outcome.INPUT_REJECTED);
    assert.match(retry.display, /never retried/);
    assert.equal((await app.memory.list({ limit: 10 })).length, 0, 'the write did not run again');
  });
});

describe('cancel', () => {
  test('a pending task can be cancelled, its steps are cancelled, and it cannot run afterwards', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    await app.controller.planTask('calc 1+1; calc 2+2');
    const task = await onlyTask(app);
    const res = await app.controller.cancelTask(task.id);
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    const cancelled = await app.taskStore.get(task.id);
    assert.equal(cancelled.status, TaskStatus.CANCELLED);
    assert.deepEqual(cancelled.steps.map((s) => s.status), ['cancelled', 'cancelled']);
    const run = await app.controller.runTask(task.id, 'run');
    assert.equal(run.status, Outcome.INPUT_REJECTED);
    assert.equal((await opsFor(app, 'task.step')).length, 0);
    const again = await app.controller.cancelTask(task.id);
    assert.equal(again.status, Outcome.INPUT_REJECTED);
  });

  test('a paused task can be cancelled after part of it ran; completed steps keep their results', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir, testDoubleModel(modelPlanWithWrite));
    await app.controller.planTask('organise my week and save the total');
    const task = await onlyTask(app);
    await app.controller.approveTask(task.id);
    await app.controller.runTask(task.id, 'run');
    const res = await app.controller.cancelTask(task.id);
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    const after = await app.taskStore.get(task.id);
    assert.deepEqual(after.steps.map((s) => s.status), ['completed', 'cancelled']);
    assert.equal(after.steps[0].outcome, Outcome.SUCCESS_VERIFIED);
  });
});

describe('through the controller request path', () => {
  test('a multi-part request runs as a task; a single request does not create one', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const single = await app.controller.handle('calc 2+3');
    assert.equal(single.status, Outcome.SUCCESS_VERIFIED);
    assert.equal((await app.taskStore.list()).length, 0);

    const multi = await app.controller.handle('calc (2+3)*4; calc 10/2');
    assert.equal(multi.status, Outcome.SUCCESS_VERIFIED);
    assert.match(multi.display, /Progress: 2 of 2/);
    const task = await onlyTask(app);
    assert.equal(task.status, TaskStatus.COMPLETED);
    assert.equal(multi.operation.task.id, task.id);
  });

  test('a private memory write combined with other requests is refused before anything is stored or sent to a model', async () => {
    const dataDir = tempDir();
    const captured = [];
    const app = appOn(dataDir, testDoubleModel('an answer', captured));
    const res = await app.controller.handle('what is the capital of France; remember privately that my pin is 4417');
    assert.equal(res.status, Outcome.INPUT_REJECTED);
    assert.match(res.display, /must be sent on its own/);
    assert.equal(captured.length, 0, 'the model was not called');
    assert.equal((await app.memory.list({ limit: 10 })).length, 0);
    assert.doesNotMatch(readRaw(dataDir, 'operations.jsonl'), /4417/);
    assert.doesNotMatch(readRaw(dataDir, 'conversation.jsonl'), /4417/);
    assert.doesNotMatch(readRaw(dataDir, 'tasks.jsonl'), /4417/);
  });

  test('a memory write mixed into a non-task request keeps its text out of the audit', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    await app.controller.handle('what is the capital of France; remember that the codename is Lighthouse');
    assert.doesNotMatch(readRaw(dataDir, 'operations.jsonl'), /Lighthouse/);
  });

  test('task events are kept apart from long-term memory: a task run adds no memory records', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    await app.controller.planTask('calc 1+1; calc 2+2');
    const task = await onlyTask(app);
    await app.controller.runTask(task.id, 'run');
    assert.equal((await app.memory.list({ limit: 10 })).length, 0);
  });
});

describe('command line', () => {
  test('create, list, run, show, re-run, and cancel through bin/apex.js with exit codes', async () => {
    const dataDir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
    const plan = await runCli(['task', 'plan', 'calc (2+3)*4; calc 10/2'], env);
    assert.equal(plan.code, 0, plan.stderr);
    assert.match(plan.stdout, /status: pending/);
    assert.match(plan.stdout, /Nothing has run yet/);
    const short = /Task ([0-9a-f]{8})/.exec(plan.stdout)[1];

    const list = await runCli(['task', 'list'], env);
    assert.equal(list.code, 0);
    assert.match(list.stdout, new RegExp(short));

    const run = await runCli(['task', 'run', short], env);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /status: completed/);
    assert.match(run.stdout, /= 20 \(verified\)/);

    const show = await runCli(['task', 'show', short], env);
    assert.equal(show.code, 0);
    assert.match(show.stdout, /2 of 2 step\(s\) completed/);

    const again = await runCli(['task', 'run', short], env);
    assert.equal(again.code, 1, 'a completed task is not run again');

    const cancel = await runCli(['task', 'cancel', short], env);
    assert.equal(cancel.code, 1, 'a completed task cannot be cancelled');

    const unknown = await runCli(['task', 'show', 'ffffffff'], env);
    assert.equal(unknown.code, 2);
    const usage = await runCli(['task', 'approve'], env);
    assert.equal(usage.code, 2);
  });

  test('a cancelled task is shown as cancelled and cannot run; the audit log records the cancel', async () => {
    const dataDir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
    const plan = await runCli(['task', 'plan', 'calc 1+1; calc 2+2'], env);
    const short = /Task ([0-9a-f]{8})/.exec(plan.stdout)[1];
    const cancel = await runCli(['task', 'cancel', short], env);
    assert.equal(cancel.code, 0, cancel.stdout + cancel.stderr);
    const run = await runCli(['task', 'run', short], env);
    assert.equal(run.code, 1);
    const show = await runCli(['task', 'show', short], env);
    assert.match(show.stdout, /status: cancelled/);
    assert.match(readRaw(dataDir, 'operations.jsonl'), /task\.cancel/);
  });
});
