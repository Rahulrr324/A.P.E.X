// Scenario D: a real process is terminated inside an approved plan step, and a second real
// process reports and recovers what the first one left. The child is a real APEX app
// (tests/fixtures/executive-interruption-child.mjs) that records a goal, activates an approved
// plan, and blocks inside the second step; the parent terminates it once the child's READY
// marker proves the side effect happened and the task log holds that step as running.
//
// The synchronization is by marker, not by waiting. After the child's exit is awaited, the dead
// task-lock holder's pid is rewritten to one the allocator cannot reach (deadPid in helpers),
// so a recycled pid cannot make the next process believe a live run still holds the task.
//
// TEST FIXTURE: `probe.ok` and `probe.block` are deterministic readers, not real actions. The
// side-effect file is the observable effect; no model, service, or download is involved.
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDataDir, cleanup, cleanEnv, runCli, APP_ROOT, rebindDeadHolder } from './helpers.js';
import { shortId } from '../src/util.js';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { GoalStatus } from '../src/goals/model.js';
import { PlanStatus } from '../src/plans/model.js';

const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'executive-interruption-child.mjs');
const READY_CEILING_MS = 90000;

const dirs = [];
const children = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => {
  for (const c of children) {
    c.child.kill();
    await Promise.race([c.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
});

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

function snapshot(dir) {
  const names = ['goals.jsonl', 'plans.jsonl', 'tasks.jsonl', 'operations.jsonl'];
  return Object.fromEntries(names.map((name) => {
    const file = path.join(dir, name);
    return [name, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null];
  }));
}

async function startInterruptedChild(dataDir, effectFile) {
  const child = spawn(process.execPath, [CHILD, dataDir, effectFile], {
    env: cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
  children.push({ child, exited });
  const ready = new Promise((resolve) => {
    const check = () => { if (out.includes('READY\n')) resolve('ready'); };
    child.stdout.on('data', check);
    check();
  });
  const ceiling = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`the child never reached its step within ${READY_CEILING_MS} ms. stdout: ${out} stderr: ${err}`)), READY_CEILING_MS);
    child.once('exit', () => clearTimeout(timer));
  });
  const lost = exited.then((info) => {
    throw new Error(`the child exited before the test terminated it (exit ${info.code ?? info.signal}). stdout: ${out} stderr: ${err}`);
  });
  await Promise.race([ready, lost, ceiling]);
  return { child, exited };
}

test('D: an interrupted plan step is reported as uncertain, never re-run, and reconcile blocks the plan', async () => {
  const dataDir = tempDir();
  const effectFile = path.join(dataDir, 'side-effects.txt');
  const env = cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
  const tasksFile = path.join(dataDir, 'tasks.jsonl');
  const lockFile = `${tasksFile}.lock`;
  const taskEvents = () => readLines(tasksFile).map((line) => JSON.parse(line));
  const startedSteps = () => taskEvents().flatMap((e) => (e.steps ?? []).filter((s) => s.to === 'running').map((s) => s.id));

  const running = await startInterruptedChild(dataDir, effectFile);
  assert.deepEqual(readLines(effectFile), ['probe-1', 'block-start'], 'each step ran once before the interruption');
  assert.deepEqual(startedSteps(), ['s1', 's2'], 's1 started and finished; s2 started and did not finish');
  assert.equal(fs.existsSync(lockFile), true, 'the running process holds the task lock');

  assert.equal(running.child.kill(), true, 'the process was signalled');
  const exit = await running.exited;
  assert.notEqual(exit.code, 0, 'the child did not exit cleanly');
  assert.equal(fs.existsSync(lockFile), true, 'and it left its lock file behind');
  rebindDeadHolder(lockFile, running.child.pid);

  // From here every read is a fresh process describing what the first one left.
  const app = createApp({ dataDir, experienceCapture: CAPTURE_OFF });
  const [plan] = await app.plans.list();
  assert.ok(plan, 'the activated plan is readable');
  assert.equal(plan.status, PlanStatus.ACTIVE, 'activation is a recorded fact; no later status was written');
  assert.ok(plan.activation?.taskId);
  assert.deepEqual(Object.keys(plan.stepResults ?? {}), [], 'the lost run recorded no step outcome against the plan');
  const task = await app.taskStore.get(plan.activation.taskId);
  assert.equal(task.status, 'running');
  assert.deepEqual(task.steps.map((s) => s.status), ['completed', 'running']);
  const [goal] = await app.goals.list();
  assert.equal(goal.status, GoalStatus.ACTIVE, 'an interrupted run does not complete its goal');

  // Recovery inspection is read-only and says exactly what is and is not known.
  const before = snapshot(dataDir);
  const report = await app.controller.recoveryReport();
  assert.deepEqual(snapshot(dataDir), before, 'recovery inspection wrote nothing');
  assert.equal(report.attention, true);
  const taskShort = shortId(task.id);
  assert.ok(report.sections.interrupted.some((line) => line.includes(taskShort) && /recorded as running/.test(line)));
  assert.ok(report.sections.interrupted.some((line) => /a step is never run again/.test(line)));

  const recovered = await runCli(['recover'], env);
  assert.equal(recovered.code, 1, recovered.stdout + recovered.stderr);
  assert.match(recovered.stdout, /Interrupted/);
  assert.match(recovered.stdout, new RegExp(taskShort));
  assert.match(recovered.stdout, /interrupted step is never assumed not to have happened/);

  // Resume resolves the interrupted step from its own record; it does not run it again.
  const resume = await runCli(['task', 'resume', taskShort], env);
  assert.equal(resume.code, 1, resume.stdout + resume.stderr);
  assert.match(resume.stdout, /step s2 is uncertain and was not run again/);
  assert.deepEqual(readLines(effectFile), ['probe-1', 'block-start'], 'resuming re-ran nothing');
  assert.deepEqual(startedSteps(), ['s1', 's2'], 'and no step was started a second time');

  const resumed = await app.taskStore.get(task.id);
  assert.equal(resumed.status, 'paused');
  assert.deepEqual(resumed.steps.map((s) => s.status), ['completed', 'uncertain']);
  assert.equal((await app.plans.get(plan.id)).status, PlanStatus.ACTIVE, 'resume alone records no plan outcome');

  // Reconcile reads the task log and records the terminal outcomes. The uncertain step turns
  // the plan blocked; it is never executed, and a second reconcile appends nothing.
  const planShort = shortId(plan.id);
  const reconcile = await runCli(['plan', 'reconcile', planShort], env);
  assert.equal(reconcile.code, 0, reconcile.stdout + reconcile.stderr);
  assert.match(reconcile.stdout, /Recorded 2 new terminal step outcome\(s\)/);
  assert.match(reconcile.stdout, /Plan .* is blocked/);

  const reconciled = await app.plans.get(plan.id);
  assert.equal(reconciled.status, PlanStatus.BLOCKED);
  assert.equal(reconciled.stepResults.s1.status, 'completed');
  assert.ok(reconciled.stepResults.s1.operationId, 'the step that finished cites its own audit record');
  assert.equal(reconciled.stepResults.s2.status, 'uncertain');
  assert.equal(reconciled.stepResults.s2.operationId, resumed.steps[1].operationId,
    'the record names the operation id allocated before the step ran');
  const interruptedOp = await app.operations.findById(reconciled.stepResults.s2.operationId);
  assert.equal(interruptedOp.found, false, 'but that operation has no audit record, so it supports nothing');

  const eventsBefore = (await app.plans.load()).events;
  const again = await runCli(['plan', 'reconcile', planShort], env);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /No new terminal outcome was recorded/);
  assert.equal((await app.plans.load()).events, eventsBefore, 'reconciling twice appends nothing');
  assert.deepEqual(readLines(effectFile), ['probe-1', 'block-start'], 'reconcile executes no step');
  assert.deepEqual(startedSteps(), ['s1', 's2']);

  // The goal is still active: neither resume nor reconcile completed it.
  assert.equal((await app.goals.get(goal.id)).status, GoalStatus.ACTIVE);

  const afterRecovery = await runCli(['recover'], env);
  assert.equal(afterRecovery.code, 1, afterRecovery.stdout);
  assert.match(afterRecovery.stdout, /blocked/);
  assert.match(afterRecovery.stdout, /Resolve the obstacle, then run "node bin\/apex\.js plan reconcile/);
  assert.match(afterRecovery.stdout, /paused, not finished/);
});
