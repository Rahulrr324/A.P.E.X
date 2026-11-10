// Batch AN, work package E: continuation across processes.
//
// AM's continuation derivation reads the plan, the approval, the registry, the constraints, the audit
// log and the task record, and then runs the steps the records prove never started. The derivation
// used to be made before the task lock was acquired, which left a time-of-check/time-of-use window:
// another process could record a step's outcome (or close the plan) between the answer and the run,
// and the continuation would act on an answer the records no longer held. The first two tests here
// inject exactly that write at the last moment before the lock, so the window is demonstrated rather
// than described. The third spawns two real APEX processes attempting the same continuation, and
// reads the side-effect file - not either process's claim - to decide what happened.
//
// The probe capabilities are the same synthetic fixtures tests/fixtures/continuation-child.mjs uses:
// one observable line per effect. No model is contacted (NoBackend), and nothing here is evidence
// about a real capability.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { StepStatus } from '../src/tasks/model.js';
import { PlanStatus } from '../src/plans/model.js';
import { makeTempDataDir, cleanup, cleanEnv, APP_ROOT } from './helpers.js';

const dirs = [];
const children = [];

after(async () => {
  for (const c of children) {
    c.child.kill();
    await withCeiling(c.exited, 5000);
  }
  while (dirs.length) cleanup(dirs.pop());
});

const dir = () => { const d = makeTempDataDir(); dirs.push(d); return d; };
const effectFileOf = (dataDir) => path.join(dataDir, 'effects.txt');
const effectsOf = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
  : []);
const display = (res) => String(res?.display ?? res?.output ?? '');
const data = (res) => res?.operation?.steps?.[0]?.result?.data ?? res?.result?.data ?? {};

function probeActions(dataDir) {
  const effectFile = effectFileOf(dataDir);
  const make = (name, permission, mark) => ({
    name,
    description: `fixture ${permission} that leaves one observable line behind`,
    inputHint: '{"tag":"text"}',
    permission,
    origins: permission === 'write' ? ['user'] : ['user', 'model'],
    validate: (input) => ({ tag: String(input?.tag ?? 'x').trim() }),
    async execute(_ctx, input) {
      fs.appendFileSync(effectFile, `${mark(input.tag)}\n`);
      return { summary: `${name} ${input.tag}`, data: { tag: input.tag, effect: mark(input.tag) } };
    },
    async verify(_ctx, input, result) {
      const want = mark(String(input?.tag ?? result?.data?.tag ?? ''));
      return effectsOf(effectFile).includes(want)
        ? { ok: true, detail: `the side-effect file holds ${want}` }
        : { ok: false, detail: `the side-effect file holds no ${want}` };
    },
  });
  return [
    make('probe.note', 'write', (tag) => tag),
    make('probe.peek', 'read', (tag) => `read:${tag}`),
  ];
}

const appIn = (dataDir) => createApp({
  dataDir,
  gateway: new ModelGateway({ backend: new NoBackend() }),
  experienceCapture: CAPTURE_OFF,
  extraActions: probeActions(dataDir),
});

const INTERRUPT_CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'continuation-child.mjs');
const CONTINUE_CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'continue-child.mjs');
const RUN_CEILING_MS = 120000;

// A ceiling that does not keep the test process alive after the child has exited.
async function withCeiling(promise, ms = RUN_CEILING_MS) {
  let timer;
  const ceiling = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ code: null, signal: 'ceiling' }), ms);
  });
  try {
    return await Promise.race([promise, ceiling]);
  } finally {
    clearTimeout(timer);
  }
}

// Leaves a real interrupted run on disk: the plan is approved and its task and steps exist, but no
// step has been taken up. The same fixture AM's tests use, so the bytes are a real interruption.
async function interruptedRun(dataDir) {
  const effectFile = effectFileOf(dataDir);
  const child = spawn(process.execPath, [INTERRUPT_CHILD, 'after-step-creation', dataDir, effectFile], {
    env: cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  children.push({ child, exited });
  const info = await withCeiling(exited);
  const results = out.split('\n').filter((l) => l.startsWith('RESULT ')).map((l) => JSON.parse(l.slice(7)));
  if (results.length === 0) throw new Error(`the interruption fixture reported nothing (${info.code ?? info.signal})`);
  return results[results.length - 1];
}

async function runContinue(dataDir, planId, delayMs = 0) {
  const child = spawn(process.execPath, [CONTINUE_CHILD, dataDir, planId, String(delayMs)], {
    env: cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  children.push({ child, exited });
  const info = await withCeiling(exited);
  const results = out.split('\n').filter((l) => l.startsWith('RESULT ')).map((l) => JSON.parse(l.slice(7)));
  return { info, err, result: results[results.length - 1] ?? null };
}

// Replaces the store's lock entry point so that one recorded write lands after the command has read
// its inputs and before it acquires the lock - the window another process races through. The write
// itself goes through the real store and its real lock, so it leaves the bytes a real process would.
function injectBeforeLock(app, write) {
  const store = app.taskStore;
  const realWithLock = store.withLock.bind(store);
  let injected = false;
  let injection = null;
  store.withLock = async (fn) => {
    if (!injected) {
      injected = true;
      injection = realWithLock(write);
      await injection;
    }
    return realWithLock(fn);
  };
  return () => injection;
}

describe('AN-E1: the continuation derivation is made under the lock it runs under', () => {
  test('a step that becomes uncertain before the lock stops the run and the steps beside it', async () => {
    const dataDir = dir();
    const effectFile = effectFileOf(dataDir);
    const { planId, taskId } = await interruptedRun(dataDir);

    const app = appIn(dataDir);
    const before = effectsOf(effectFile);
    injectBeforeLock(app, () => app.taskStore.transition(taskId, {
      reason: 'another process recorded the step as running',
      steps: [{ id: 's1', from: StepStatus.PENDING, to: StepStatus.RUNNING, operationId: 'op-other' }],
    }));

    const cont = await app.controller.planContinue(planId);
    assert.equal(cont.status, Outcome.INPUT_REJECTED, display(cont));
    assert.match(display(cont), /nothing was taken up/);
    assert.match(display(cont), /outcome uncertain/,
      'the refusal quotes the record that moved, not the reading taken before it moved');
    assert.deepEqual(effectsOf(effectFile), before, 'the step that became uncertain ran nothing, and neither did the step beside it');

    const task = await app.taskStore.get(taskId);
    assert.equal(task.steps.find((s) => s.id === 's1').status, StepStatus.RUNNING);
    assert.equal(task.steps.find((s) => s.id === 's2').status, StepStatus.PENDING,
      'the independent step was not taken up past the uncertain one');
  });

  test('a plan cancelled before the lock is not continued, even though the earlier reading was safe', async () => {
    const dataDir = dir();
    const effectFile = effectFileOf(dataDir);
    const { planId } = await interruptedRun(dataDir);

    const app = appIn(dataDir);
    // The reading before the lock says the run is continuable; the cancellation lands after it.
    const reading = await app.controller.planContinuation(planId);
    assert.equal(data(reading).continuation.continue.safe, true);
    const before = effectsOf(effectFile);
    injectBeforeLock(app, () => app.plans.setStatus(planId, PlanStatus.CANCELLED, { reason: 'cancelled in another process' }));

    const cont = await app.controller.planContinue(planId);
    assert.equal(cont.status, Outcome.INPUT_REJECTED, display(cont));
    assert.match(display(cont), /nothing was taken up/);
    assert.match(display(cont), /cancelled/);
    assert.deepEqual(effectsOf(effectFile), before, 'a cancelled plan took up no step');
    assert.equal((await app.plans.get(planId)).status, PlanStatus.CANCELLED);
  });
});

describe('AN-E2: two processes attempt the same continuation', () => {
  test('the side-effect file decides: each step runs once, and only one process reports taken-up work', async () => {
    const dataDir = dir();
    const effectFile = effectFileOf(dataDir);
    const { planId } = await interruptedRun(dataDir);

    const [a, b] = await Promise.all([
      runContinue(dataDir, planId, 0),
      runContinue(dataDir, planId, 25),
    ]);

    for (const run of [a, b]) {
      assert.equal(run.info.code, 0, `continuation child exited ${run.info.code ?? run.info.signal}: ${run.err}`);
      assert.ok(run.result && !run.result.threw, `child reported no result: ${run.err}`);
    }

    assert.deepEqual(effectsOf(effectFile), ['note-1', 'read:note-2'],
      'each effect appears exactly once, whatever either process claims');

    const tookUp = [a, b].filter((run) => Array.isArray(run.result.ran) && run.result.ran.length > 0);
    assert.equal(tookUp.length, 1, `exactly one process ran the steps: ${JSON.stringify([a.result, b.result])}`);
    assert.deepEqual(tookUp[0].result.ran, ['s1', 's2']);

    const other = [a, b].find((run) => run !== tookUp[0]);
    assert.equal(other.result.status, Outcome.INPUT_REJECTED, JSON.stringify(other.result));
    assert.match(other.result.display, /nothing was taken up|nothing to take up|already completed|refused before it ran|not in the task log/);
  });
});
