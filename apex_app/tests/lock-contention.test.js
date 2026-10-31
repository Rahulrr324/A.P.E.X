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
//
// What is not a defect here: a racer that reaches the lock after its holder has released it takes
// the lock and completes. Exclusivity is "never two inside", not "one process per test run" - under
// a loaded machine, where these files run in parallel with the store-write stress suites, a late
// process is normal and must not be reported as a breach.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { makeTempDataDir, cleanup, runCli, cleanEnv, APP_ROOT, deadPid, rebindDeadHolder } from './helpers.js';

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
const VANISH_CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'lock-vanish-child.mjs');
const TAKEOVER_EXIT_CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'takeover-exit-child.mjs');
const LOCK = (dataDir) => path.join(dataDir, 'tasks.jsonl.lock');

function envFor(dataDir, extra = {}) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir, ...extra });
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
  test('real processes racing a stale lock: never two inside, one taker per claim', async () => {
    for (const round of [1, 2, 3]) {
      const dataDir = tempDir();
      const traceFile = path.join(dataDir, 'trace.txt');
      // The state a lost process leaves: a lock naming a pid that no longer exists.
      fs.writeFileSync(LOCK(dataDir), JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }));

      const exits = await spawnRacers(dataDir, { racers: 6, traceFile });
      assert.equal(exits.filter((e) => e.signal !== null).length, 0, 'no racer was killed by a signal');
      const trace = readTrace(traceFile);
      const { maxDepth, acquired, refused } = analyse(trace);

      // The safety property is that the stale claim is taken over by one process and that no two
      // processes are ever inside the lock together. How many get a hold in total is a timing
      // outcome, not a breach: a racer that reaches the lock only after the winner has released it
      // finds a free lock and takes it, which is exactly what a released lock is for. Under a
      // loaded machine (the whole suite runs these files in parallel, and the store-write stress
      // suites spawn ten writers at once) that late arrival is common, so the assertions here hold
      // the first hold window to one process and require every racer to have reported an outcome.
      assert.equal(maxDepth, 1, `round ${round}: two processes held the task lock at once: ${JSON.stringify(trace)}`);
      const firstHold = trace.findIndex((l) => l.startsWith('LEAVE'));
      assert.ok(firstHold > 0, `round ${round}: a process entered and left the lock: ${JSON.stringify(trace)}`);
      assert.equal(trace.slice(0, firstHold).filter((l) => l.startsWith('ENTER')).length, 1, `round ${round}: exactly one process may take over a stale claim: ${JSON.stringify(trace)}`);
      assert.ok(acquired >= 1, `round ${round}: the takeover let a writer through: ${JSON.stringify(trace)}`);
      assert.equal(acquired + refused.length, 6, `every racer reported exactly one outcome: ${JSON.stringify(trace)}`);
      assert.equal(trace.length, acquired * 3 + refused.length, `the trace holds one report per racer and nothing else: ${JSON.stringify(trace)}`);
      for (const line of refused) assert.match(line, /tasks are in use by process \d+; try again when it finishes/, line);
      assert.equal(fs.existsSync(LOCK(dataDir)), false, 'every holder released the lock');
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
    const foreign = JSON.stringify({ pid: deadPid(), nonce: 'not-mine', at: new Date().toISOString() });

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
    fs.writeFileSync(LOCK(dataDir), JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }));

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

  test('a holder releasing between the failed link and the read is a free lock, not an unknown holder', async () => {
    // The race that made the stale-lock suite intermittently report "process unknown": the
    // holder deletes its lock after our link failed with EEXIST but before we read the lock.
    // The read then fails with ENOENT, which means nobody holds the lock - it must be retried.
    // The fixture removes the lock exactly on that read, so this case is deterministic rather
    // than a timing coincidence in the racer suite above.
    const dataDir = tempDir();
    const child = spawn(process.execPath, [VANISH_CHILD, dataDir], {
      env: envFor(dataDir),
      cwd: APP_ROOT,
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
    const exit = await exited;

    assert.equal(exit.code, 0, `the waiter acquired the released lock. stdout: ${out} stderr: ${err}`);
    assert.match(out, /RESULT acquired/, `stdout: ${out} stderr: ${err}`);
    assert.equal(/ERROR/.test(out), false, 'the released lock was never reported as held');
    assert.equal(fs.existsSync(LOCK(dataDir)), false, 'the acquired lock was released again');
  });

  test('an abandoned takeover token is superseded instead of wedging the lock', async () => {
    // A process killed while it was taking over a stale lock leaves its token behind. The
    // token is keyed to that exact claim and epoch, so a later taker must move to the next
    // epoch rather than be refused forever. This is deterministic: the abandoned token names
    // a pid that has already exited.
    const dataDir = tempDir();
    const raw = JSON.stringify({ pid: deadPid(), nonce: 'stale', at: new Date().toISOString() });
    fs.writeFileSync(LOCK(dataDir), raw);
    const key = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
    const abandoned = `${LOCK(dataDir)}.takeover.${key}.0`;
    fs.writeFileSync(abandoned, JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }));

    const { TaskStore } = await import('../src/tasks/store.js');
    const store = new TaskStore(path.join(dataDir, 'tasks.jsonl'));
    const value = await store.withLock(async () => 'acquired');
    assert.equal(value, 'acquired', 'the next epoch elected a live taker');
    assert.equal(fs.existsSync(LOCK(dataDir)), false, 'the stale claim was taken over and released');
    const epochOne = `${LOCK(dataDir)}.takeover.${key}.1`;
    assert.equal(fs.existsSync(epochOne), false, 'the winner removed its own token');
    assert.equal(fs.existsSync(abandoned), true, 'the abandoned token is inert bookkeeping, not deleted by a stranger');
  });

  test('a takeover in progress refuses a second taker with the live holder pid', async () => {
    // The election's whole point: while one process is taking over, another must be refused
    // and must not delete anything. The token names this live test process.
    const dataDir = tempDir();
    const raw = JSON.stringify({ pid: deadPid(), nonce: 'stale', at: new Date().toISOString() });
    fs.writeFileSync(LOCK(dataDir), raw);
    const key = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
    fs.writeFileSync(`${LOCK(dataDir)}.takeover.${key}.0`, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

    const { TaskStore } = await import('../src/tasks/store.js');
    const store = new TaskStore(path.join(dataDir, 'tasks.jsonl'));
    await assert.rejects(() => store.withLock(async () => 'never'), new RegExp(`tasks are in use by process ${process.pid}`));
    assert.equal(fs.readFileSync(LOCK(dataDir), 'utf8'), raw, 'the stale claim was left for the elected taker');
    assert.equal(fs.existsSync(`${LOCK(dataDir)}.takeover.${key}.0`), true, 'and the live token was not touched');
  });

  test('a numeric pid now held by a different live process keeps the lock fail-closed', async () => {
    // A stale claim is identified only by the numeric pid it recorded. If the original holder
    // exited and the operating system gave that number to another live process - the reuse case
    // seen on Windows - APEX cannot tell the two identities apart. It must not guess: the claim
    // is treated as held, and neither a normal run nor recovery removes it.
    const dataDir = tempDir();
    const raw = JSON.stringify({ pid: process.pid, nonce: 'reused', at: new Date().toISOString() });
    fs.writeFileSync(LOCK(dataDir), raw);

    const { TaskStore } = await import('../src/tasks/store.js');
    const store = new TaskStore(path.join(dataDir, 'tasks.jsonl'));
    await assert.rejects(
      () => store.withLock(async () => 'never'),
      new RegExp(`tasks are in use by process ${process.pid}`),
      'a live pid is treated as a live holder even if this process is not the original one',
    );
    assert.equal(fs.readFileSync(LOCK(dataDir), 'utf8'), raw, 'the claim was not removed');

    const repair = await runCli(['repair', 'locks'], envFor(dataDir));
    assert.equal(repair.code, 1, repair.stdout + repair.stderr);
    assert.match(repair.stderr, new RegExp(`held by live process ${process.pid}; refusing recovery`), repair.stderr);
    assert.equal(fs.readFileSync(LOCK(dataDir), 'utf8'), raw, 'recovery did not remove a claim it cannot prove dead');
  });

  test('a process that exits inside the takeover leaves the claim and one token; the next taker supersedes it', async () => {
    const dataDir = tempDir();
    const raw = JSON.stringify({ pid: deadPid(), nonce: 'stale', at: new Date().toISOString() });
    fs.writeFileSync(LOCK(dataDir), raw);
    const key = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);

    const child = spawn(process.execPath, [TAKEOVER_EXIT_CHILD, dataDir], {
      env: envFor(dataDir),
      cwd: APP_ROOT,
      windowsHide: true,
      stdio: 'ignore',
    });
    const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    assert.equal(exit.code, 9, 'the child exited abruptly inside the election');

    assert.equal(fs.readFileSync(LOCK(dataDir), 'utf8'), raw, 'the dead claim is still there');
    const abandoned = `${LOCK(dataDir)}.takeover.${key}.0`;
    assert.equal(fs.existsSync(abandoned), true, 'the token published before the exit is still there');
    assert.equal(JSON.parse(fs.readFileSync(abandoned, 'utf8')).pid, child.pid, 'and it names the process that is gone');
    // The child's exit was awaited, so it is dead. Rebind only the pid to a number the
    // allocator cannot reach during this test: the next taker's liveness check must not
    // depend on the operating system not having recycled the child's pid.
    rebindDeadHolder(abandoned, child.pid);

    const { TaskStore } = await import('../src/tasks/store.js');
    const store = new TaskStore(path.join(dataDir, 'tasks.jsonl'));
    assert.equal(await store.withLock(async () => 'acquired'), 'acquired', 'the next taker uses the next epoch');
    assert.equal(fs.existsSync(LOCK(dataDir)), false, 'the dead claim was taken over and released');
    assert.equal(fs.existsSync(abandoned), true, 'the abandoned token is inert bookkeeping, not deleted by a stranger');
    assert.equal(fs.existsSync(`${LOCK(dataDir)}.takeover.${key}.1`), false, 'the winner removed its own token');
  });

  test('sixteen abandoned takeover tokens are reported, and work resumes after they are removed', async () => {
    const dataDir = tempDir();
    const raw = JSON.stringify({ pid: deadPid(), nonce: 'stale', at: new Date().toISOString() });
    fs.writeFileSync(LOCK(dataDir), raw);
    const key = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
    const dead = deadPid();
    const tokens = Array.from({ length: 16 }, (_, epoch) => `${LOCK(dataDir)}.takeover.${key}.${epoch}`);
    for (const token of tokens) fs.writeFileSync(token, JSON.stringify({ pid: dead, at: new Date().toISOString() }));

    const { TaskStore } = await import('../src/tasks/store.js');
    const store = new TaskStore(path.join(dataDir, 'tasks.jsonl'));
    await assert.rejects(
      () => store.withLock(async () => 'never'),
      /16 takeover attempts are recorded as abandoned; run "apex repair locks"/,
      'exhaustion is a bounded, reported refusal',
    );
    assert.equal(fs.readFileSync(LOCK(dataDir), 'utf8'), raw, 'the claim was not removed');
    for (const token of tokens) assert.equal(fs.existsSync(token), true, 'no abandoned token was deleted by a stranger');

    for (const token of tokens) fs.rmSync(token, { force: true });
    fs.rmSync(LOCK(dataDir), { force: true });
    assert.equal(await store.withLock(async () => 'acquired'), 'acquired', 'the lock works once the operator clears it');
    assert.equal(fs.existsSync(LOCK(dataDir)), false);
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
