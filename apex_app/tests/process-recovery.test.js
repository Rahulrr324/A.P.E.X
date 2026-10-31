// Implementation 055: a real process, terminated inside a step, and a second real process
// recovering the same data directory.
//
// The suites before this one reached the interrupted state by appending the events an
// interrupted run would have left (a fixture). This one kills an actual running process: the
// child is a real APEX app (tests/fixtures/interrupted-run-child.mjs) that plans, is approved,
// runs, and blocks inside an approved write step; the parent terminates it once the child's own
// READY marker proves the task log holds that step as running.
//
// Termination is deterministic on the platforms APEX supports: `child.kill()` is TerminateProcess
// on Windows and the default SIGTERM disposition on POSIX, and neither lets this child run any
// cleanup - no unwinding, no lock release, no summary write. What the next process finds is
// therefore exactly what a lost process leaves behind, and that is what these assertions check.
//
// The synchronization is by marker, not by waiting: READY is printed after the side effect and
// after the RUNNING event is on disk, and every later step is a separate process whose exit is
// awaited. No timing assumption is made about how long a step takes. The stale-lock check
// identifies a dead holder by numeric pid only, so once the child's exit is awaited the test
// rewrites that pid to one the allocator cannot reach during the test (see deadPid/rebindDeadHolder
// in tests/helpers.js). The original pid is asserted first. Without that, a pid recycled by
// Windows would make the next process refuse the task as "in use" for no real reason.
//
// TEST FIXTURE: the probe actions write one line to a file the test reads back. That file is
// the observable side effect, and it is how these tests show a step ran once, or not at all.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDataDir, cleanup, runCli, cleanEnv, APP_ROOT, rebindDeadHolder } from './helpers.js';
import { shortId } from '../src/util.js';

const dirs = [];
const children = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
// If a check fails before the test terminates the child, the child must not be left blocked
// forever: it holds a lock and would keep the runner alive.
after(async () => {
  for (const c of children) {
    c.child.kill();
    await Promise.race([c.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
});

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'interrupted-run-child.mjs');
// A ceiling on the wait for the marker, not a delay: the wait ends when the child prints it.
const READY_CEILING_MS = 90000;

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

// Starts the fixture and resolves once it has printed READY, which happens only after its step
// is recorded as running and its side effect is on disk. If the child exits or reaches the
// ceiling first, the test fails with everything the child said.
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
  return { child, exited, output: () => `${out}${err}` };
}

describe('a real process interrupted inside a step', () => {
  test('the lost process is recovered by a fresh one, and no step that already ran is run again', async () => {
    const dataDir = tempDir();
    const effectFile = path.join(dataDir, 'side-effects.txt');
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
    const tasksFile = path.join(dataDir, 'tasks.jsonl');
    const lockFile = `${tasksFile}.lock`;
    const opsFile = path.join(dataDir, 'operations.jsonl');
    const historyFile = path.join(dataDir, 'conversation.jsonl');
    const events = () => readLines(tasksFile).map((l) => JSON.parse(l));
    // Every step the log has ever recorded as starting, in the order it recorded them.
    const started = () => events().flatMap((e) => (e.steps ?? []).filter((s) => s.to === 'running').map((s) => s.id));
    const stepRecords = () => readLines(opsFile).map((l) => JSON.parse(l)).filter((r) => r.capability === 'task.step');
    const taskTurns = () => readLines(historyFile).map((l) => JSON.parse(l)).filter((t) => t.origin === 'apex_task');

    const running = await startInterruptedChild(dataDir, effectFile);
    assert.deepEqual(started(), ['s1', 's2'], 's1 started and finished; s2 started and did not finish');
    assert.deepEqual(readLines(effectFile), ['s1', 'block-start'], 'each step that ran did so once, before the interruption');
    assert.equal(fs.existsSync(lockFile), true, 'the running process holds the task lock');

    // The interruption itself: no cleanup runs in the child.
    assert.equal(running.child.kill(), true, 'the process was signalled');
    const exit = await running.exited;
    assert.notEqual(exit.code, 0, 'the child did not exit cleanly');
    assert.equal(fs.existsSync(lockFile), true, 'and it left its lock file behind');
    rebindDeadHolder(lockFile, running.child.pid);

    // From here everything is a second, separate process reading what the first one left.
    const taskId = events().find((e) => e.type === 'task_created').taskId;
    const short = shortId(taskId);
    assert.equal(taskTurns().length, 1, 'the lost run wrote no summary of its own; the earlier pause is all history holds');
    assert.match(taskTurns()[0].text, /paused for your approval/);

    const show = await runCli(['task', 'show', short], env);
    assert.equal(show.code, 0, show.stdout + show.stderr);
    assert.match(show.stdout, /status: running/, 'the raw recorded state is a run nobody finished');
    assert.match(show.stdout, /\[running\] s2/);

    // A read reports the state; it resolves nothing and runs nothing.
    const explained = await runCli(['task', 'explain', short], env);
    assert.equal(explained.code, 1, explained.stdout + explained.stderr);
    assert.match(explained.stdout, /status: running; 1 of 2 step\(s\) verified complete; 1 unresolved/);
    assert.match(explained.stdout, /Evidence: all 1 step result\(s\) the task log records as verified have an operation record of their own\./);
    assert.equal(/2 of 2 step\(s\)/.test(explained.stdout), false, 'a step whose outcome is unknown is never counted as complete');
    assert.deepEqual(readLines(effectFile), ['s1', 'block-start'], 'and it ran nothing');

    const beforeRecovery = readLines(tasksFile);
    const resume = await runCli(['task', 'resume', short], env);
    assert.equal(resume.code, 1, 'a step whose outcome is unknown is not run again');
    assert.match(resume.stdout, /step s2 is uncertain and was not run again/);
    assert.equal(fs.existsSync(lockFile), false, 'the fresh process replaced the dead one');
    assert.deepEqual(readLines(effectFile), ['s1', 'block-start'], 'recovering re-ran neither step');
    assert.equal(readLines(tasksFile).length, beforeRecovery.length + 1, 'the recovery is one recorded event');
    const recovered = events().at(-1);
    assert.deepEqual(recovered.steps.map((s) => `${s.id}:${s.from}->${s.to}`), ['s2:running->uncertain'], 'the step is resolved, not repeated');
    assert.equal(recovered.task.to, 'paused');
    assert.deepEqual(started(), ['s1', 's2'], 'and no step was started a second time');

    assert.equal(stepRecords().length, 1, 'only the step that finished has its own audit record');
    assert.equal(stepRecords()[0].task.stepId, 's1');

    assert.equal(taskTurns().length, 2, 'the fresh process wrote the summary the lost one never reached');
    const recoveredTurn = taskTurns().at(-1);
    assert.match(recoveredTurn.text, /interrupted partway through - 1 of 2 step\(s\) verified complete/);
    assert.match(recoveredTurn.text, /Step s2 was interrupted and no audit record matches it/);
    assert.equal(recoveredTurn.taskId, taskId, 'and it is bound to the task it describes');

    // Asking about it afterwards is answered from the records, and still runs nothing.
    const asked = await runCli(['ask', `task ${short} finished?`], env);
    assert.equal(asked.code, 0, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /No, it stopped before finishing at s2; 1 of 2 step\(s\) were verified/);
    assert.equal(/Yes, it finished/.test(asked.stdout), false);
    assert.deepEqual(readLines(effectFile), ['s1', 'block-start'], 'a question ran nothing');

    // Recovery is idempotent: the same call again establishes no new facts and repeats nothing.
    const eventsAfterRecovery = readLines(tasksFile);
    const historyAfterRecovery = readLines(historyFile);
    const again = await runCli(['task', 'resume', short], env);
    assert.equal(again.code, 1);
    assert.deepEqual(readLines(tasksFile), eventsAfterRecovery, 'a second recovery records nothing new');
    assert.deepEqual(readLines(historyFile), historyAfterRecovery, 'and writes no second summary');
    assert.deepEqual(readLines(effectFile), ['s1', 'block-start'], 'and runs nothing');

    // The uncertain step is a write, so it is never retried: its side effect stays at one line.
    const retry = await runCli(['task', 'retry', short, 's2'], env);
    assert.equal(retry.code, 1);
    assert.match(`${retry.stdout}${retry.stderr}`, /changes data, so it is never retried/);
    assert.deepEqual(readLines(effectFile), ['s1', 'block-start'], 'the refused retry ran nothing');

    const recovery = await runCli(['task', 'explain', short, 'recovery'], env);
    assert.equal(recovery.code, 1);
    assert.match(recovery.stdout, /It cannot continue on its own/);

    // The user's own way out is to stop it, which a fresh process can still do.
    const cancel = await runCli(['task', 'cancel', short], env);
    assert.equal(cancel.code, 0, cancel.stdout + cancel.stderr);
    const cancelled = await runCli(['task', 'show', short], env);
    assert.match(cancelled.stdout, /status: cancelled/);
    assert.deepEqual(readLines(effectFile), ['s1', 'block-start'], 'cancelling ran nothing either');
  });
});
