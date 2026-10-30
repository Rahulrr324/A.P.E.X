// Implementation 098: safe recovery of abandoned lock elections.
//
// The task lock and the summary-queue lock elect a taker with create-once tokens. A
// process killed during that election leaves a token whose holder has exited; sixteen
// such tokens occupy every epoch and the next takeover is refused rather than retried
// forever. This suite drives the real CLI and the real stores against that state.
//
// The property under test is narrow: recovery removes abandoned tokens and nothing else.
// It never removes a claim (the ordinary election is the only path that removes a lock),
// never displaces a live holder or a live takeover, and is serialised by a guard so
// concurrent recoveries cannot both remove the same token.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { SummaryQueue } from '../src/tasks/summary-queue.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const TASK_LOCK = (dir) => path.join(dir, 'tasks.jsonl.lock');
const QUEUE = (dir) => path.join(dir, 'task-summary-queue.json');
const QUEUE_LOCK = (dir) => `${QUEUE(dir)}.lock`;
const SIGNATURE = 'a'.repeat(64);

function envFor(dir) {
  return cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
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

function claim(pid, nonce = 'stale') {
  return JSON.stringify({ pid, nonce, at: new Date().toISOString() });
}

function keyOf(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

function writeTokens(lockPath, raw, { count = 16, pid, bodyAt } = {}) {
  const key = keyOf(raw);
  const dead = pid ?? exitedPid();
  const tokens = [];
  for (let epoch = 0; epoch < count; epoch += 1) {
    const token = `${lockPath}.takeover.${key}.${epoch}`;
    fs.writeFileSync(token, bodyAt?.(epoch) ?? claim(dead));
    tokens.push(token);
  }
  return { key, tokens };
}

async function seedQueueEntry(dir, taskId) {
  const queue = new SummaryQueue(QUEUE(dir));
  const result = await queue.add({ sessionId: 'session-1', taskId, signature: SIGNATURE, text: 'summary for the queued task', verified: true });
  assert.equal(result.queued, true);
  return fs.readFileSync(QUEUE(dir), 'utf8');
}

describe('098: abandoned takeover tokens are recovered explicitly and safely', () => {
  test('a fresh data directory: nothing to recover, and no lock file is created', async () => {
    const dir = tempDir();
    const res = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Task lock: no lock file; nothing to recover/, res.stdout);
    assert.match(res.stdout, /Summary queue lock: no lock file; nothing to recover/, res.stdout);
    assert.equal(fs.existsSync(TASK_LOCK(dir)), false, 'inspection created no task lock');
    assert.equal(fs.existsSync(QUEUE_LOCK(dir)), false, 'inspection created no queue lock');
    assert.equal(fs.existsSync(`${TASK_LOCK(dir)}.recover`), false, 'no recovery guard was left behind');
  });

  test('sixteen abandoned tokens are reported by diagnostics and removed; the claims are left for normal takeover', async () => {
    const dir = tempDir();
    const queueBytes = await seedQueueEntry(dir, 'task-queued');

    const taskRaw = claim(exitedPid());
    fs.writeFileSync(TASK_LOCK(dir), taskRaw);
    const task = writeTokens(TASK_LOCK(dir), taskRaw);

    const queueRaw = claim(exitedPid());
    fs.writeFileSync(QUEUE_LOCK(dir), queueRaw);
    const queue = writeTokens(QUEUE_LOCK(dir), queueRaw);

    // Diagnostics is read-only and must say what is blocked before anything is removed.
    const before = await runCli(['diagnose'], envFor(dir));
    assert.equal(before.code, 1, before.stdout + before.stderr);
    assert.match(before.stdout, /Task lock: recovery required - 16 takeover token\(s\)/, before.stdout);
    assert.match(before.stdout, /Summary queue lock: recovery required - 16 takeover token\(s\)/, before.stdout);
    assert.match(before.stdout, /"apex repair locks"/, before.stdout);
    for (const token of [...task.tokens, ...queue.tokens]) assert.equal(fs.existsSync(token), true, 'diagnostics removed nothing');
    assert.equal(fs.readFileSync(TASK_LOCK(dir), 'utf8'), taskRaw);
    assert.equal(fs.readFileSync(QUEUE_LOCK(dir), 'utf8'), queueRaw);

    const res = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Task lock: removed 16 abandoned takeover token\(s\)/, res.stdout);
    assert.match(res.stdout, /Summary queue lock: removed 16 abandoned takeover token\(s\)/, res.stdout);
    for (const token of [...task.tokens, ...queue.tokens]) assert.equal(fs.existsSync(token), false, 'every abandoned token was removed');
    assert.equal(fs.readFileSync(TASK_LOCK(dir), 'utf8'), taskRaw, 'the task claim itself was not removed');
    assert.equal(fs.readFileSync(QUEUE_LOCK(dir), 'utf8'), queueRaw, 'the queue claim itself was not removed');
    assert.equal(fs.readFileSync(QUEUE(dir), 'utf8'), queueBytes, 'the deferred summary was not touched');
    assert.equal(fs.existsSync(`${TASK_LOCK(dir)}.recover`), false, 'the recovery guard was released');

    // A normal task write takes the dead claim over through the ordinary election.
    const planned = await runCli(['task', 'plan', 'calc 1+1; calc 2+2'], envFor(dir));
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    assert.equal(fs.existsSync(TASK_LOCK(dir)), false, 'the elected taker removed the dead claim and released its own');

    // A normal queue update does the same, and the existing entry survives.
    const reopened = new SummaryQueue(QUEUE(dir));
    const added = await reopened.add({ sessionId: 'session-1', taskId: 'task-after-repair', signature: SIGNATURE, text: 'summary after repair', verified: true });
    assert.equal(added.queued, true, added.reason);
    assert.equal((await reopened.entries()).length, 2);
    assert.equal(fs.existsSync(QUEUE_LOCK(dir)), false, 'the queue claim was taken over and released');
  });

  test('the queue remains readable while its lock is stale or held', async () => {
    const dir = tempDir();
    await seedQueueEntry(dir, 'task-readable');
    const raw = claim(exitedPid());
    fs.writeFileSync(QUEUE_LOCK(dir), raw);
    writeTokens(QUEUE_LOCK(dir), raw);

    const listed = await runCli(['queue'], envFor(dir));
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    assert.match(listed.stdout, /Queue: 1 deferred task summary/, listed.stdout);
    assert.match(listed.stdout, /task task-rea /, listed.stdout);
    assert.match(listed.stdout, /Queue lock: holder process \d+ is not running/, listed.stdout);
    assert.equal(fs.readFileSync(QUEUE_LOCK(dir), 'utf8'), raw, 'the read took and removed nothing');
  });

  test('a live holder is never displaced, and its tokens are not touched', async () => {
    const dir = tempDir();
    const raw = claim(process.pid, 'held-now');
    fs.writeFileSync(TASK_LOCK(dir), raw);
    const { tokens } = writeTokens(TASK_LOCK(dir), raw);

    const res = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stderr, new RegExp(`Task lock: not recovered: the task lock is held by live process ${process.pid}`), res.stderr);
    assert.match(res.stderr, /No live holder or takeover was displaced/, res.stderr);
    assert.equal(fs.readFileSync(TASK_LOCK(dir), 'utf8'), raw, 'the live claim survived');
    for (const token of tokens) assert.equal(fs.existsSync(token), true, 'no token was removed while its claim is held');
  });

  test('a live takeover is never displaced', async () => {
    const dir = tempDir();
    const raw = claim(exitedPid(), 'dead-claim');
    fs.writeFileSync(TASK_LOCK(dir), raw);
    const { key } = writeTokens(TASK_LOCK(dir), raw, { count: 1 });
    const liveToken = `${TASK_LOCK(dir)}.takeover.${key}.0`;
    const liveBody = claim(process.pid, 'taking-over');
    fs.writeFileSync(liveToken, liveBody);

    const res = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stderr, new RegExp(`a task lock takeover is in progress by process ${process.pid}`), res.stderr);
    assert.equal(fs.readFileSync(TASK_LOCK(dir), 'utf8'), raw, 'the claim was left for the live taker');
    assert.equal(fs.readFileSync(liveToken, 'utf8'), liveBody, 'the live token survived');
  });

  test('an unidentifiable holder is refused and preserved', async () => {
    const dir = tempDir();
    const raw = '{ half-written';
    fs.writeFileSync(TASK_LOCK(dir), raw);

    const res = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /the task lock holder cannot be identified; refusing recovery/, res.stderr);
    assert.equal(fs.readFileSync(TASK_LOCK(dir), 'utf8'), raw, 'the damaged claim was preserved');
  });

  test('a recovery already in progress refuses a second recovery', async () => {
    const dir = tempDir();
    const raw = claim(exitedPid(), 'dead-claim');
    fs.writeFileSync(TASK_LOCK(dir), raw);
    const { tokens } = writeTokens(TASK_LOCK(dir), raw);
    fs.writeFileSync(`${TASK_LOCK(dir)}.recover`, claim(process.pid, 'recovering'));

    const res = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stderr, new RegExp(`task lock recovery is already in progress by process ${process.pid}`), res.stderr);
    for (const token of tokens) assert.equal(fs.existsSync(token), true, 'nothing was removed while another recovery holds the guard');
    assert.equal(fs.existsSync(`${TASK_LOCK(dir)}.recover`), true, 'the other recovery guard was preserved');
  });

  test('an unfinished recovery claim from a dead process names the file and changes nothing', async () => {
    const dir = tempDir();
    const raw = claim(exitedPid(), 'dead-claim');
    fs.writeFileSync(TASK_LOCK(dir), raw);
    const { tokens } = writeTokens(TASK_LOCK(dir), raw);
    const guard = `${TASK_LOCK(dir)}.recover`;
    fs.writeFileSync(guard, claim(exitedPid(), 'abandoned-recovery'));

    const res = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /blocked by an unfinished recovery claim at .*tasks\.jsonl\.lock\.recover/, res.stderr);
    assert.match(res.stderr, /remove it only if no recovery or task run is active/, res.stderr);
    for (const token of tokens) assert.equal(fs.existsSync(token), true, 'the abandoned token was not removed');
    assert.equal(fs.readFileSync(guard, 'utf8').includes('abandoned-recovery'), true, 'the guard was preserved for the operator');
  });

  test('a refused recovery leaves a corrupt queue untouched and still blocking', async () => {
    const dir = tempDir();
    const queueBytes = await seedQueueEntry(dir, 'task-held');
    const raw = claim(exitedPid(), 'dead-claim');
    fs.writeFileSync(QUEUE_LOCK(dir), raw);
    // The last token cannot be attributed to a holder, so recovery must refuse before
    // removing any token: a partial clean-up would be evidence of nothing.
    const dead = exitedPid();
    writeTokens(QUEUE_LOCK(dir), raw, { count: 16, bodyAt: (epoch) => (epoch === 15 ? 'not json' : claim(dead)) });

    const res = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /takeover token .* has no readable holder; refusing recovery/, res.stderr);
    assert.equal(fs.readFileSync(QUEUE(dir), 'utf8'), queueBytes, 'the queue file was not rewritten');
    assert.equal(fs.readFileSync(QUEUE_LOCK(dir), 'utf8'), raw, 'the claim was not removed');
    assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.takeover.')).length, 16, 'no token was partially removed');

    const blocked = await new SummaryQueue(QUEUE(dir)).add({ sessionId: 'session-1', taskId: 'task-blocked', signature: SIGNATURE, text: 'blocked', verified: true })
      .then(() => null, (err) => err);
    assert.ok(blocked, 'the update is still blocked until the token is resolved');
    assert.match(String(blocked.message), /in use by process unknown|cannot update/, String(blocked.message));
  });

  test('two concurrent recoveries never both remove, and leave the claim for one elected taker', async () => {
    const dir = tempDir();
    const raw = claim(exitedPid(), 'dead-claim');
    fs.writeFileSync(TASK_LOCK(dir), raw);
    const { tokens } = writeTokens(TASK_LOCK(dir), raw);

    const results = await Promise.all([
      runCli(['repair', 'locks'], envFor(dir)),
      runCli(['repair', 'locks'], envFor(dir)),
    ]);
    for (const res of results) {
      assert.ok(res.code === 0 || res.code === 1, res.stdout + res.stderr);
      if (res.code === 1) assert.match(res.stderr, /already in progress|unfinished recovery claim|not recovered/, res.stderr);
    }
    assert.ok(results.some((r) => r.code === 0), `at least one recovery reported a result: ${JSON.stringify(results.map((r) => r.stderr))}`);
    for (const token of tokens) assert.equal(fs.existsSync(token), false, 'the abandoned tokens are gone');
    assert.equal(fs.readFileSync(TASK_LOCK(dir), 'utf8'), raw, 'the claim was never removed by recovery');
    assert.equal(fs.existsSync(`${TASK_LOCK(dir)}.recover`), false, 'no guard was left behind');
  });
});
