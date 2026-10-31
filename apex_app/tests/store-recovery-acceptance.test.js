// Implementation 105: persistent-store and recovery acceptance. A real process is
// terminated inside a step, its audit evidence is then damaged, a fresh process
// recovers the task, and every store involved must survive byte-for-byte where it is
// damaged. A corrupt work list fails closed. A partial task-log write is reconciled
// from the audit without re-running the step.
//
// These tests use the real stores, the real lock election, and real child processes.
// The probe actions in the fixture are TEST DOUBLES: the side-effect file is what
// they observably did, and it is not evidence about a real action or model.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDataDir, cleanup, cleanEnv, runCli, APP_ROOT, rebindDeadHolder } from './helpers.js';
import { createApp } from '../src/app.js';
import { StoreError } from '../src/errors.js';
import { Outcome } from '../src/outcomes.js';
import { TaskStatus } from '../src/tasks/model.js';

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

const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'interrupted-run-child.mjs');
const READY_CEILING_MS = 90000;

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
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

describe('105: persistent stores survive interruption and refuse to pretend otherwise', () => {
  test('a killed run is recovered by a fresh process; damaged audit lines are preserved and never counted as evidence', async () => {
    const dataDir = tempDir();
    const effectFile = path.join(dataDir, 'side-effects.txt');
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
    const opsFile = path.join(dataDir, 'operations.jsonl');
    const tasksFile = path.join(dataDir, 'tasks.jsonl');

    const running = await startInterruptedChild(dataDir, effectFile);
    assert.deepEqual(readLines(effectFile), ['s1', 'block-start']);
    assert.equal(running.child.kill(), true);
    const exit = await running.exited;
    assert.notEqual(exit.code, 0);
    assert.equal(fs.existsSync(`${tasksFile}.lock`), true, 'the lost process left its lock');
    // The holder is dead (its exit was awaited); rebind its pid so the recovery process's
    // liveness check cannot depend on the OS not having recycled the number.
    rebindDeadHolder(`${tasksFile}.lock`, running.child.pid);

    const taskId = readLines(tasksFile).map((l) => JSON.parse(l)).find((e) => e.type === 'task_created').taskId;
    const short = taskId.slice(0, 8);

    // Damage the only step audit record. The rest of the audit log stays readable, so
    // this is damage in the middle of valid evidence, not an empty log.
    const auditLines = readLines(opsFile);
    const stepIndex = auditLines.findIndex((l) => JSON.parse(l).capability === 'task.step');
    assert.notEqual(stepIndex, -1, 'the completed step has an audit record before the damage');
    const damaged = [...auditLines];
    damaged[stepIndex] = `X${damaged[stepIndex]}`;
    fs.writeFileSync(opsFile, `${damaged.join('\n')}\n`);
    const damagedBytes = fs.readFileSync(opsFile, 'utf8');
    assert.deepEqual(readLines(effectFile), ['s1', 'block-start'], 'the damage itself runs nothing');

    const beforeResume = readLines(tasksFile);
    const resume = await runCli(['task', 'resume', short], env);
    assert.equal(resume.code, 1, resume.stdout + resume.stderr);
    assert.match(resume.stdout, /s2 is uncertain and was not run again/);
    assert.deepEqual(readLines(effectFile), ['s1', 'block-start'], 'recovery re-ran neither step');
    assert.equal(readLines(tasksFile).length, beforeResume.length + 1, 'recovery recorded exactly one event');
    assert.ok(fs.readFileSync(opsFile, 'utf8').includes(`X${auditLines[stepIndex]}`), 'the damaged line was preserved, not rewritten');
    assert.ok(fs.readFileSync(opsFile, 'utf8').startsWith(damagedBytes), 'readable evidence was not truncated or replaced');

    const explained = await runCli(['task', 'explain', short, 'steps'], env);
    assert.equal(explained.code, 1, explained.stdout + explained.stderr);
    assert.match(explained.stdout, /damaged line\(s\)/);
    assert.match(explained.stdout, /cannot establish that s1 has no operation record/);
    assert.doesNotMatch(explained.stdout, /all 1 step result\(s\).*have an operation record/, 'damage is never reported as complete evidence');

    const history = await runCli(['history'], env);
    assert.equal(history.code, 0, history.stdout + history.stderr);
    assert.match(history.stdout, /1 corrupt audit line\(s\) skipped/);
    assert.match(history.stdout, /this list is incomplete/);
    assert.doesNotMatch(history.stdout, /block-start/);

    // The task's own state is recoverable; the damaged evidence remains damaged.
    const show = await runCli(['task', 'show', short], env);
    assert.equal(show.code, 0, show.stdout + show.stderr);
    assert.match(show.stdout, /status: paused/);
    assert.ok(fs.readFileSync(opsFile, 'utf8').includes(`X${auditLines[stepIndex]}`));
  });

  test('a corrupt deferred-summary queue fails closed, is preserved, and repair does not replace it', async () => {
    const dir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
    const queueFile = path.join(dir, 'task-summary-queue.json');
    const raw = '{"schema":1,"entries":[{"id":5}]}';
    fs.writeFileSync(queueFile, raw);

    const listed = await runCli(['queue'], env);
    assert.equal(listed.code, 1, listed.stdout + listed.stderr);
    assert.match(listed.stderr, /Queue: unavailable \(task-summary-queue\.json is corrupt/);

    const diagnosed = await runCli(['diagnose'], env);
    assert.equal(diagnosed.code, 1, diagnosed.stdout + diagnosed.stderr);
    assert.match(diagnosed.stdout, /Queue: corrupt/);

    const repaired = await runCli(['repair', 'locks'], env);
    assert.equal(fs.readFileSync(queueFile, 'utf8'), raw, `repair must not replace queue data: ${repaired.stdout}${repaired.stderr}`);

    const stillCorrupt = await runCli(['queue'], env);
    assert.equal(stillCorrupt.code, 1);
    assert.equal(fs.readFileSync(queueFile, 'utf8'), raw, 'the damaged file is still exactly as it was');
  });

  test('a partial task-log write is reconciled from audit evidence without executing the step again', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const planned = await app.controller.planTask('remember that the sky is blue');
    assert.equal(planned.status, Outcome.PLAN_CREATED);
    const taskId = planned.task.id;
    const tasksFile = path.join(dir, 'tasks.jsonl');
    const before = fs.readFileSync(tasksFile, 'utf8');

    const original = app.taskStore.transition.bind(app.taskStore);
    let injected = false;
    app.taskStore.transition = async (id, event) => {
      if (!injected && event.steps?.some((s) => s.to === 'completed')) {
        injected = true;
        throw new StoreError('injected: task log write failed');
      }
      return original(id, event);
    };
    const lost = await app.controller.runTask(taskId, 'run');
    app.taskStore.transition = original;

    assert.equal(lost.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.match(lost.display, /had already returned success_verified/);
    assert.equal((await app.memory.list()).length, 1, 'the write happened once');
    assert.ok(fs.readFileSync(tasksFile, 'utf8').startsWith(before), 'existing task evidence was not rewritten');
    const stepRecords = (await app.operations.inspect()).records.filter((r) => r.capability === 'task.step');
    assert.equal(stepRecords.length, 1);
    assert.equal(stepRecords[0].status, Outcome.SUCCESS_VERIFIED);

    const reconcile = await app.controller.runTask(taskId, 'run');
    assert.equal(reconcile.status, Outcome.INPUT_REJECTED, 'the run is reconciled, not repeated');
    assert.equal((await app.taskStore.get(taskId)).status, TaskStatus.PAUSED);
    assert.equal((await app.memory.list()).length, 1, 'reconciliation did not execute the write again');

    const done = await app.controller.runTask(taskId, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED);
    assert.equal((await app.taskStore.get(taskId)).status, TaskStatus.COMPLETED);
    assert.equal((await app.memory.list()).length, 1);
    assert.equal((await app.operations.inspect()).records.filter((r) => r.capability === 'task.step').length, 1);
  });
});
