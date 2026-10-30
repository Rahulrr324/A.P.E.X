// Implementation 061: resource contention and process safety.
//
// These tests drive the real TaskStore lock (src/tasks/store.js) from real processes.
// No lock logic is stubbed: the only doubles are the temporary data directories and the
// fixture child that reports whether it was allowed inside the lock.
//
// The lock is the single serialization point for task work: create, run, resume, approve,
// retry and cancel all take it (src/controller/controller.js), while task list/show/explain
// and every audit read do not. So the property that matters is not "a task is slow" but
// "two processes are never inside the same lock at the same time" - if it fails, two runs
// can execute the same step on one data directory, which is exactly the double execution
// that the interrupted-run recovery in 055 exists to prevent.
//
// The defect this suite holds: the takeover of a stale lock (the path a lost process leaves)
// read the lock, deleted it, and re-created it. The delete was unconditional, so a second
// taker that had read the same stale body could delete the lock the first taker created in
// the meantime, and both then held the task lock. Under the fix the takeover deletes only the
// exact claim it validated as dead, and a holder releases only its own claim.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeTempDataDir, cleanup, runCli, cleanEnv, APP_ROOT } from './helpers.js';

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
const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'lock-race-child.mjs');
const LOCK = (dataDir) => path.join(dataDir, 'tasks.jsonl.lock');

function envFor(dataDir, extra = {}) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir, ...extra });
}

// A pid that is certainly not running: a real process that has already exited.
function exitedPid() {
  const r = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(r.status, 0, `the pid probe failed to run: ${r.error?.message}`);
  assert.ok(r.pid > 0);
  let alive = true;
  try { process.kill(r.pid, 0); } catch (err) { alive = err?.code === 'EPERM'; }
  assert.equal(alive, false, `pid ${r.pid} is still alive; this test needs a dead pid`);
  return r.pid;
}

function readTrace(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

// ENTER/LEAVE pairs from the trace. maxDepth > 1 means two processes were inside the lock at
// the same time, which is the breach; acquired counts processes that completed a hold.
function analyse(trace) {
  let depth = 0;
  let maxDepth = 0;
  for (const line of trace) {
    if (line.startsWith('ENTER ')) { depth += 1; maxDepth = Math.max(maxDepth, depth); }
    if (line.startsWith('LEAVE ')) depth -= 1;
  }
  return {
    maxDepth,
    acquired: trace.filter((l) => l.startsWith('ACQUIRED')).length,
    refused: trace.filter((l) => l.startsWith('refused')),
  };
}

function spawnRacers(dataDir, { racers, traceFile, holdMs = 120 }) {
  const started = Array.from({ length: racers }, () => {
    const child = spawn(process.execPath, [CHILD, dataDir], {
      env: cleanEnv({
        APEX_DATA_DIR: dataDir,
        HOME: dataDir,
        USERPROFILE: dataDir,
        APEX_TRACE: traceFile,
        APEX_RACERS: String(racers),
        APEX_HOLD_MS: String(holdMs),
      }),
      cwd: APP_ROOT,
      windowsHide: true,
      stdio: 'ignore',
    });
    const exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
    children.push({ child, exited });
    return { child, exited };
  });
  return Promise.all(started.map((c) => c.exited));
}

describe('061: the task lock is exclusive across processes', () => {
  test('real processes racing a stale lock: never two inside, exactly one completes', async () => {
    for (const round of [1, 2, 3]) {
      const dataDir = tempDir();
      const traceFile = path.join(dataDir, 'trace.txt');
      // The state a lost process leaves: a lock naming a pid that no longer exists.
      fs.writeFileSync(LOCK(dataDir), JSON.stringify({ pid: exitedPid(), at: new Date().toISOString() }));

      const exits = await spawnRacers(dataDir, { racers: 6, traceFile });
      assert.equal(exits.filter((e) => e.signal !== null).length, 0, 'no racer was killed by a signal');
      const trace = readTrace(traceFile);
      const { maxDepth, acquired, refused } = analyse(trace);

      assert.equal(trace.length, 8, `every racer reported one outcome: ${JSON.stringify(trace)}`);
      assert.equal(maxDepth, 1, `round ${round}: two processes held the task lock at once: ${JSON.stringify(trace)}`);
      assert.equal(acquired, 1, `round ${round}: exactly one run should complete, trace ${JSON.stringify(trace)}`);
      assert.equal(refused.length, 5, 'the others are refused rather than queued');
      for (const line of refused) assert.match(line, /tasks are in use by process \d+; try again when it finishes/, line);
      assert.equal(fs.existsSync(LOCK(dataDir)), false, 'the winner released the lock');
    }
  });

  test('a takeover cannot destroy a live holder: the second process is refused and the lock survives', async () => {
    const dataDir = tempDir();
    const traceFile = path.join(dataDir, 'trace.txt');
    // A lock held by this test process, which is alive: a takeover must not remove it.
    fs.writeFileSync(LOCK(dataDir), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

    await spawnRacers(dataDir, { racers: 1, traceFile });
    const trace = readTrace(traceFile);
    assert.equal(trace.filter((l) => l.startsWith('refused')).length, 1, JSON.stringify(trace));
    assert.match(trace[0], new RegExp(`tasks are in use by process ${process.pid}`), trace[0]);
    assert.equal(/ENTER/.test(trace.join('')), false, 'the live holder was not displaced');
    assert.equal(fs.existsSync(LOCK(dataDir)), true, 'the live holder still owns its lock');
  });

  test('a holder releases only its own claim: another process lock is left alone', async () => {
    const dataDir = tempDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const { TaskStore } = await import('../src/tasks/store.js');
    const store = new TaskStore(path.join(dataDir, 'tasks.jsonl'));
    const foreign = JSON.stringify({ pid: exitedPid(), nonce: 'not-mine', at: new Date().toISOString() });

    // Inside our own hold, replace the lock with a foreign claim (what a competing taker
    // leaves when it takes over a lock whose holder has just died). Releasing must not
    // delete a claim we did not create.
    await store.withLock(async () => {
      fs.writeFileSync(LOCK(dataDir), foreign);
    });
    assert.equal(fs.readFileSync(LOCK(dataDir), 'utf8'), foreign, 'the foreign claim survived our release');

    fs.rmSync(LOCK(dataDir), { force: true });
    const clean = await store.withLock(async () => 'acquired');
    assert.equal(clean, 'acquired', 'and the lock still works afterwards');
    assert.equal(fs.existsSync(LOCK(dataDir)), false);
  });

  test('repeated recovery: a stale lock is taken over once, then the lock is gone', async () => {
    const dataDir = tempDir();
    fs.writeFileSync(LOCK(dataDir), JSON.stringify({ pid: exitedPid(), at: new Date().toISOString() }));

    const first = await runCli(['task', 'plan', 'calc 1+1; calc 2+2'], envFor(dataDir));
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.equal(fs.existsSync(LOCK(dataDir)), false, 'the takeover released the lock');

    // A second takeover attempt with no stale lock left: the same operation still works.
    const second = await runCli(['task', 'plan', 'calc 3+3; calc 4+4'], envFor(dataDir));
    assert.equal(second.code, 0, second.stdout + second.stderr);
    assert.equal(fs.existsSync(LOCK(dataDir)), false);

    const listed = await runCli(['task', 'list'], envFor(dataDir));
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    assert.match(listed.stdout, /pending\s+0\/2 steps\s+calc 1\+1; calc 2\+2/, listed.stdout);
    assert.match(listed.stdout, /pending\s+0\/2 steps\s+calc 3\+3; calc 4\+4/, listed.stdout);
  });

  test('an unreadable lock fails safe: work is refused, nothing is deleted', async () => {
    const dataDir = tempDir();
    fs.writeFileSync(LOCK(dataDir), '{ half-written');
    const res = await runCli(['task', 'plan', 'calc 1+1; calc 2+2'], envFor(dataDir));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(`${res.stdout}${res.stderr}`, /tasks are in use by process unknown/, `${res.stdout}${res.stderr}`);
    assert.equal(fs.readFileSync(LOCK(dataDir), 'utf8'), '{ half-written', 'the damaged lock was preserved for inspection');
  });

  test('what the lock does NOT protect: reads run while a live holder is in the lock', async () => {
    // Documents the current boundary instead of asserting more than the code does. A
    // reader never takes the lock, so it can observe a task log in the middle of a run.
    const dataDir = tempDir();
    fs.writeFileSync(LOCK(dataDir), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const listed = await runCli(['task', 'list'], envFor(dataDir));
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    const shown = await runCli(['task', 'show', 'ffff'], envFor(dataDir));
    assert.equal(shown.code, 2, shown.stdout + shown.stderr);
    assert.equal(fs.existsSync(LOCK(dataDir)), true, 'a read neither took nor removed the lock');
  });

  test('concurrent runs of one task: each step is recorded exactly once', async () => {
    const dataDir = tempDir();
    const planned = await runCli(['task', 'plan', 'calc 1+1; calc 2+2'], envFor(dataDir));
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    const created = fs.readFileSync(path.join(dataDir, 'tasks.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
    const taskId = created.find((e) => e.type === 'task_created').taskId;
    assert.match(taskId, /^[0-9a-f-]{36}$/, 'the task log holds the full id');

    // Three real processes try to run the same task at the same time.
    const traceFile = path.join(dataDir, 'runners.txt');
    const runs = await Promise.all([1, 2, 3].map(() => runCli(['task', 'run', taskId], envFor(dataDir))));
    const ok = runs.filter((r) => r.code === 0).length;
    assert.ok(ok >= 1, `at least one run must complete: ${JSON.stringify(runs.map((r) => ({ code: r.code, out: r.stdout.slice(0, 200), err: r.stderr })))}`);

    const events = fs.readFileSync(path.join(dataDir, 'tasks.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
    const reasons = events.map((e) => e.reason);
    for (const stepId of ['s1', 's2']) {
      assert.equal(reasons.filter((r) => r === `running ${stepId}`).length, 1, `step ${stepId} was started exactly once: ${JSON.stringify(reasons)}`);
      assert.equal(reasons.filter((r) => r === `${stepId} completed`).length, 1, `step ${stepId} completed exactly once: ${JSON.stringify(reasons)}`);
    }

    const stepOps = fs.readFileSync(path.join(dataDir, 'operations.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
      .filter((op) => op.capability === 'task.step' && op.task?.id === taskId);
    assert.equal(stepOps.length, 2, 'one audit record per executed step');
    assert.deepEqual(stepOps.map((op) => op.task.stepId).sort(), ['s1', 's2']);
    assert.equal(fs.existsSync(LOCK(dataDir)), false, 'no racer left the lock behind');

    const shown = await runCli(['task', 'show', taskId], envFor(dataDir));
    assert.equal(shown.code, 0, shown.stdout + shown.stderr);
    assert.match(shown.stdout, /completed/, shown.stdout);
  });
});
