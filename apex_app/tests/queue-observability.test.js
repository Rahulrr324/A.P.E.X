// Implementation 099: the deferred-summary queue is observable and its refusals are honest.
//
// The queue is a work list, not evidence: it holds task summaries that conversation
// history refused, and a later task write offers them again. Its failure modes used to be
// visible only inside an operation's notices. This suite checks the read-only views and
// that a refused update is never reported as queued, using the real store and the real CLI.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { SummaryQueue, MAX_QUEUED_SUMMARIES } from '../src/tasks/summary-queue.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const QUEUE = (dir) => path.join(dir, 'task-summary-queue.json');
const LOCK = (dir) => `${QUEUE(dir)}.lock`;
const SIGNATURE = 'a'.repeat(64);
const entry = (i) => ({ sessionId: 'session-1', taskId: `task-${i}`, signature: SIGNATURE, text: `summary ${i}`, verified: true });

function envFor(dir) {
  return cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
}

describe('099: deferred task summaries are observable and refusals are disclosed', () => {
  test('an absent queue is empty, and reading it creates nothing', async () => {
    const dir = tempDir();
    const res = await runCli(['queue'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Queue: empty/, res.stdout);
    assert.match(res.stdout, /Queue lock: no lock file/, res.stdout);
    assert.equal(fs.existsSync(QUEUE(dir)), false, 'the read did not create the queue file');
  });

  test('entries are listed by identity and size, never by their stored text', async () => {
    const dir = tempDir();
    const queue = new SummaryQueue(QUEUE(dir));
    await queue.add(entry(1));
    await queue.add({ ...entry(2), text: 'a stored summary that must not be printed verbatim' });

    const res = await runCli(['queue'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Queue: 2 deferred task summaries/, res.stdout);
    assert.match(res.stdout, /task task-1 /, res.stdout);
    assert.match(res.stdout, /task task-2 /, res.stdout);
    assert.match(res.stdout, /text \d+ char\(s\)/, res.stdout);
    assert.equal(/must not be printed verbatim/.test(res.stdout), false, 'stored text is not echoed');

    const limited = await runCli(['queue', '--limit', '1'], envFor(dir));
    assert.equal(limited.code, 0, limited.stdout + limited.stderr);
    assert.match(limited.stdout, /showing 1/, limited.stdout);
  });

  test('a corrupt queue is reported as damage, not as empty, and is preserved', async () => {
    const dir = tempDir();
    const raw = '{ "schema": 1, "entries": [ { "id": 5 } ] }';
    fs.writeFileSync(QUEUE(dir), raw);

    const res = await runCli(['queue'], envFor(dir));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /Queue: unavailable \(task-summary-queue\.json is corrupt/, res.stderr);
    assert.equal(fs.readFileSync(QUEUE(dir), 'utf8'), raw, 'the damaged file was preserved');

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.equal(diag.code, 1, diag.stdout + diag.stderr);
    assert.match(diag.stdout, /Queue: corrupt \(task-summary-queue\.json is corrupt/, diag.stdout);
    assert.match(diag.stdout, /queue blocks only the reissue of unsaved task summaries/, diag.stdout);
    assert.equal(fs.readFileSync(QUEUE(dir), 'utf8'), raw);
  });

  test('a full queue is stated as full; a further intent is refused, not displaced', async () => {
    const dir = tempDir();
    const queue = new SummaryQueue(QUEUE(dir));
    for (let i = 0; i < MAX_QUEUED_SUMMARIES; i += 1) {
      const added = await queue.add({ ...entry(i), signature: String(i).padStart(64, '0') });
      assert.equal(added.queued, true, `entry ${i}`);
    }
    const overflow = await queue.add({ ...entry('overflow'), signature: 'f'.repeat(64) });
    assert.deepEqual({ queued: overflow.queued, reason: overflow.reason }, { queued: false, reason: 'queue-full' });
    assert.equal((await queue.entries()).length, MAX_QUEUED_SUMMARIES, 'no older intent was displaced');

    const res = await runCli(['queue'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, new RegExp(`Queue: full \\(${MAX_QUEUED_SUMMARIES}/${MAX_QUEUED_SUMMARIES}\\);`), res.stdout);
    assert.match(res.stdout, /a further task summary will be refused and disclosed, not queued/, res.stdout);

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.match(diag.stdout, /Queue: full/, diag.stdout);
    assert.match(diag.stdout, /entries are reissued at the next successful task write/, diag.stdout);
  });

  test('a held queue lock blocks an update but not the read-only view', async () => {
    const dir = tempDir();
    const queue = new SummaryQueue(QUEUE(dir));
    await queue.add(entry(1));
    const held = JSON.stringify({ pid: process.pid, nonce: 'held', at: new Date().toISOString() });
    fs.writeFileSync(LOCK(dir), held);

    const listed = await runCli(['queue'], envFor(dir));
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    assert.match(listed.stdout, /Queue: 1 deferred task summary/, listed.stdout);
    assert.match(listed.stdout, new RegExp(`Queue lock: holder process ${process.pid} is live`), listed.stdout);

    // The update is refused with the lock-specific code, so the CLI does not suggest that
    // APEX_DATA_DIR permissions are the problem.
    const refused = await new SummaryQueue(QUEUE(dir))
      .add({ ...entry(2), signature: 'b'.repeat(64) })
      .then(() => null, (err) => err);
    assert.ok(refused, 'the update did not silently claim to be queued');
    assert.equal(refused.code, 'LOCKED');
    assert.match(refused.message, /in use by process \d+; nothing was changed/);
    assert.equal(fs.readFileSync(LOCK(dir), 'utf8'), held, 'the live lock was not touched');
    assert.equal((await new SummaryQueue(QUEUE(dir)).entries()).length, 1, 'nothing was added or lost');
  });

  test('queue options are validated instead of ignored', async () => {
    const dir = tempDir();
    const bad = await runCli(['queue', '--limit', 'x'], envFor(dir));
    assert.equal(bad.code, 2, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /--limit needs a whole number/);

    const unknown = await runCli(['queue', '--nope'], envFor(dir));
    assert.equal(unknown.code, 2, unknown.stdout + unknown.stderr);
    assert.match(unknown.stderr, /unknown option --nope/);

    const extra = await runCli(['queue', 'extra'], envFor(dir));
    assert.equal(extra.code, 2, extra.stdout + extra.stderr);
    assert.match(extra.stderr, /usage: queue \[--limit N\]/);
  });
});
