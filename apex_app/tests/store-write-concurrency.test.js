// Batch W (W-06): cross-process coordination of the memory and knowledge stores, tested with
// real child processes.
//
// Before Batch W a store write read the whole authoritative log, derived one decision from it
// (is this claim already corrected, already superseded, already retracted, already resolved,
// already conflicting?), and appended - with nothing separating two processes across that
// sequence. Two writers could each read before either wrote, so both "succeeded" and one logical
// outcome was lost: two replacements of one claim, two retractions of one target, a resolution
// recorded twice, or a claim stored as `supported` beside the claim that contradicts it.
// `src/memory/writer-lock.js` now covers the whole read-derive-append section per store.
//
// The numbered scenarios below are the eighteen this milestone has to prove. Each one asserts the
// authoritative records and lifecycle states, not just exit codes, and every legitimate loser of a
// race is asserted to return a truthful refusal rather than a pretend success:
//   1  add-memory x2      2  correct-memory x2     3  add-knowledge x2   4  conflict group x2
//   5  supersede x2       6  retract x2            7  resolve x2         8  live lock met
//   9  ambiguous lock    10  killed holder        11  recovery limits   12  bounded timeout
//  13  append failure    14  corrupt store        15  external change  16  many writers
//  17  repeated rounds   18  read-only readers   plus the operational surface for both locks.
//
// The last group is the authorization review: coordination must not become authority. An
// unauthorized request is refused before a lock is ever sought, a model cannot make a store take
// a lock, private content stays out of the audit trail on a coordinated write, and a failure after
// the append (LOCK_LOST, the record exists) stays distinguishable from a refusal before it (LOCKED,
// nothing was written).
//
// Dead lock holders are always produced by the shared fixtures (`deadPid`, `rebindDeadHolder`),
// never by assuming a recently exited Windows pid stays unused. Fixtures are temporary
// directories; no real user data is read or changed, and no model is involved.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { makeTempDataDir, cleanup, cleanEnv, runCli, APP_ROOT, deadPid, rebindDeadHolder } from './helpers.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { KnowledgeStore } from '../src/knowledge/knowledge-store.js';
import { WriterLock, WRITE_LOCK_WAIT_MS } from '../src/memory/writer-lock.js';
import { TAKEOVER_EPOCHS } from '../src/tasks/lock-recovery.js';
import { ActionRegistry } from '../src/actions/registry.js';
import { builtinActions } from '../src/actions/builtin.js';
import { knowledgeActions } from '../src/actions/knowledge-actions.js';
import { executeAction } from '../src/actions/executor.js';
import { checkSteps } from '../src/tasks/planner.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'store-writer-child.mjs');
const MEMORY = (dir) => path.join(dir, 'memory.jsonl');
const KNOWLEDGE = (dir) => path.join(dir, 'knowledge.jsonl');
const MEM_LOCK = (dir) => `${MEMORY(dir)}.lock`;
const KN_LOCK = (dir) => `${KNOWLEDGE(dir)}.lock`;

function envFor(dir) {
  return cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
}

function claim(pid, nonce = 'fixture') {
  return JSON.stringify({ pid, nonce, at: new Date().toISOString() });
}

function keyOf(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

function writeTokens(lockPath, raw, count = TAKEOVER_EPOCHS) {
  const key = keyOf(raw);
  const tokens = [];
  for (let epoch = 0; epoch < count; epoch += 1) {
    const token = `${lockPath}.takeover.${key}.${epoch}`;
    fs.writeFileSync(token, claim(deadPid()));
    tokens.push(token);
  }
  return { key, tokens };
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

// Anything a coordinated write is expected to clean up. A refusal that leaves a claim behind is
// correct only when the claim belongs to a live holder that the test itself installed.
function residue(dir) {
  return fs.readdirSync(dir).filter((name) => (
    name.endsWith('.lock') || name.includes('.takeover.') || name.endsWith('.recover') || name.endsWith('.tmp')
  ));
}

function resultsOf(out) {
  return out.split('\n').filter((line) => line.startsWith('RESULT ')).map((line) => JSON.parse(line.slice('RESULT '.length)));
}

function startChild(args, { racers = 1, waitMs = null } = {}) {
  const env = cleanEnv({ APEX_RACERS: String(racers) });
  if (waitMs !== null) env.APEX_WAIT_MS = String(waitMs);
  const child = spawn(process.execPath, [CHILD, ...args], { env, cwd: APP_ROOT, windowsHide: true });
  let out = '';
  let exitInfo = null;
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const exit = new Promise((resolve) => child.on('exit', (code, signal) => { exitInfo = { code, signal }; resolve(exitInfo); }));
  const waitFor = (predicate, ceilingMs = 25000) => new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const hit = predicate(out);
      if (hit) { clearInterval(timer); resolve(hit); return; }
      if (exitInfo || Date.now() - startedAt > ceilingMs) {
        clearInterval(timer);
        reject(new Error(`child ${args.join(' ')} did not report what was expected (exit ${exitInfo?.code ?? 'still running'}):\n${out}`));
      }
    }, 10);
  });
  return {
    child,
    exit,
    waitFor,
    get out() { return out; },
    // The RESULT lines seen so far. Read it after `exit` to collect a finished run's reports.
    get results() { return resultsOf(out); },
  };
}

async function runChild(args, opts) {
  const handle = startChild(args, opts);
  const done = await handle.exit;
  return { ...done, out: handle.out, results: handle.results };
}

function memory(dir, options = {}) { return new MemoryStore(MEMORY(dir), options); }
function knowledge(dir, options = {}) { return new KnowledgeStore(KNOWLEDGE(dir), options); }

describe('W-06 scenario 1-4: concurrent distinct writes are all preserved', () => {
  // 1. Two processes add distinct memory facts.
  test('two processes adding distinct memory facts both persist, with no malformed line', async () => {
    const dir = tempDir();
    const runs = await Promise.all([0, 1].map((w) => runChild(['add-memory', dir, String(w), '3'], { racers: 2 })));
    for (const run of runs) assert.equal(run.code, 0, run.out);
    assert.equal(runChildResultsOk(runs), 6);

    const records = readRecords(MEMORY(dir));
    assert.equal(records.length, 6, 'every fact from both writers is in the store');
    assert.equal(new Set(records.map((r) => r.id)).size, 6, 'no record was overwritten');
    assert.deepEqual(
      records.map((r) => r.content).sort(),
      [0, 1].flatMap((w) => [0, 1, 2].map((i) => `fact from writer ${w} number ${i}`)).sort(),
      'the store holds exactly the two writers own facts',
    );
    for (const record of records) assert.equal(record.source, 'user');
    assert.deepEqual(residue(dir), [], 'coordination left no claim, token or temp file');
  });

  // 3. Two processes add distinct knowledge claims.
  test('two processes adding distinct knowledge claims both persist as supported', async () => {
    const dir = tempDir();
    const runs = await Promise.all([0, 1].map((w) => runChild(['add-knowledge', dir, String(w), '3'], { racers: 2 })));
    for (const run of runs) assert.equal(run.code, 0, run.out);
    assert.equal(runChildResultsOk(runs), 6);

    const claims = readRecords(KNOWLEDGE(dir));
    assert.equal(claims.length, 6);
    assert.equal(new Set(claims.map((c) => c.subject)).size, 6, 'each writer claimed its own subject');
    for (const claim of claims) assert.equal(claim.status, 'supported', 'a distinct claim is not a conflict');
    assert.deepEqual(residue(dir), []);
  });

  // 4. Two processes change the same knowledge conflict group.
  test('two processes adding claims to one conflict group both persist and are both reported conflicting', async () => {
    const dir = tempDir();
    const runs = await Promise.all([
      runChild(['conflict-knowledge', dir, '0', 'Falcon'], { racers: 2 }),
      runChild(['conflict-knowledge', dir, '1', 'Zephyr'], { racers: 2 }),
    ]);
    for (const run of runs) assert.equal(run.code, 0, run.out);
    for (const result of runs.map((r) => r.results[0])) assert.equal(result.ok, true, JSON.stringify(result));

    const claims = readRecords(KNOWLEDGE(dir));
    assert.equal(claims.length, 2, 'neither value was dropped, merged or reordered');
    assert.deepEqual(claims.map((c) => c.object).sort(), ['Falcon', 'Zephyr']);

    // The stored status is what the writer knew at its own append; a reader derives the group from
    // the authoritative log, so the second claim cannot silence the first one.
    const store = knowledge(dir);
    const hits = await store.search('launch code name', { limit: 10 });
    assert.equal(hits.length, 2);
    for (const hit of hits) assert.equal(hit.record.status, 'conflicting', `read view of ${hit.record.object}`);
    const health = await store.health();
    assert.equal(health.conflicts.groups, 1, 'one contested subject, not one entry per pair');
    assert.equal(health.conflicts.claims, 2);
    assert.deepEqual(residue(dir), []);
  });

  function runChildResultsOk(runs) {
    return runs.reduce((sum, run) => sum + run.results.filter((r) => r.ok).length, 0);
  }
});

describe('W-06 scenario 2, 5-7: one logical decision survives a race, and the loser says so', () => {
  // 2. Two processes correct the same memory subject.
  test('two processes correcting the same claim record one replacement and refuse the other truthfully', async () => {
    const dir = tempDir();
    const seed = await memory(dir).add({ content: 'the launch code name is original' });

    const runs = await Promise.all([0, 1].map((w) => runChild(['correct-memory', dir, String(w), seed.id], { racers: 2 })));
    const results = runs.flatMap((run) => run.results);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    assert.equal(winners.length, 1, `exactly one correction was recorded: ${JSON.stringify(results)}`);
    assert.equal(losers.length, 1);
    assert.match(losers[0].message, /already corrected/, 'the loser reports the real reason, not success');

    const records = readRecords(MEMORY(dir));
    assert.equal(records.length, 2, 'the original claim is kept and one replacement appended');
    const replacements = records.filter((r) => r.provenance?.replaces?.includes(seed.id));
    assert.equal(replacements.length, 1, 'the same claim was not corrected twice');
    assert.equal(replacements[0].id, winners[0].id);
    assert.deepEqual(residue(dir), []);
  });

  // 5. Two processes supersede the same target.
  test('two processes superseding the same claim record one supersession and refuse the other', async () => {
    const dir = tempDir();
    const seed = await knowledge(dir).add({ subject: 'the launch code name', relationship: 'is', object: 'Falcon', origin: 'user' });
    const target = seed.record.id;

    const runs = await Promise.all([0, 1].map((w) => runChild(['supersede-knowledge', dir, String(w), target], { racers: 2 })));
    const results = runs.flatMap((run) => run.results);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(losers.length, 1);
    assert.match(losers[0].message, /already superseded/);

    const claims = readRecords(KNOWLEDGE(dir));
    assert.equal(claims.length, 2);
    const superseding = claims.filter((c) => Array.isArray(c.supersededBy) && c.supersededBy.length > 0);
    assert.equal(superseding.length, 1, 'the target was retired once');
    assert.deepEqual(superseding[0].supersededBy, [target]);
    const store = knowledge(dir);
    const history = await store.history(target);
    assert.equal(history.replacedBy.length, 1, 'the read view shows one successor');
    assert.deepEqual(residue(dir), []);
  });

  // 6. Two processes retract the same target.
  test('two processes retracting the same claim record one retraction event and refuse the other', async () => {
    const dir = tempDir();
    const seed = await knowledge(dir).add({ subject: 'the launch code name', relationship: 'is', object: 'Falcon', origin: 'user' });
    const target = seed.record.id;

    const runs = await Promise.all([0, 1].map((w) => runChild(['retract-knowledge', dir, String(w), target], { racers: 2 })));
    const results = runs.flatMap((run) => run.results);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(losers.length, 1);
    assert.match(losers[0].message, /already retracted/);

    const records = readRecords(KNOWLEDGE(dir));
    const events = records.filter((r) => r.kind === 'retraction');
    assert.equal(events.length, 1, 'one retraction event for one target');
    assert.equal(events[0].targetId, target);
    const store = knowledge(dir);
    const history = await store.history(target);
    assert.equal(history.retractions.length, 1);
    assert.equal(history.retractions[0].id, events[0].id);
    assert.deepEqual(await store.search('launch code name', { limit: 10 }), [], 'the retracted claim is no longer retrievable');
    assert.deepEqual(residue(dir), []);
  });

  // 7. Two processes resolve the same conflict group.
  test('two processes resolving one conflict group record one decision and refuse the duplicate', async () => {
    const dir = tempDir();
    const store = knowledge(dir);
    const first = await store.add({ subject: 'the launch code name', relationship: 'is', object: 'Falcon', origin: 'user' });
    const second = await store.add({ subject: 'the launch code name', relationship: 'is', object: 'Zephyr', origin: 'user' });
    const [a, b] = [first.record.id, second.record.id].sort();

    const runs = await Promise.all([0, 1].map((w) => runChild(['resolve-knowledge', dir, String(w), a, a], { racers: 2 })));
    const results = runs.flatMap((run) => run.results);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(losers.length, 1);
    assert.match(losers[0].message, /already been recorded/);

    const events = readRecords(KNOWLEDGE(dir)).filter((r) => r.kind === 'resolution');
    assert.equal(events.length, 1, 'a group cannot acquire two identical decisions from two processes');
    assert.equal(events[0].chosenId, a);
    assert.deepEqual(events[0].targetIds.sort(), [a, b], 'the decision names the whole group it settled');
    assert.deepEqual(residue(dir), []);
  });
});

describe('W-06 scenario 8, 10, 12: a held lock is waited for, refused, or taken over', () => {
  // 8. A writer meets an already-held live lock and is admitted when it releases.
  test('a writer meets a live holder, waits within its budget, and writes after the release', async () => {
    const dir = tempDir();
    const seed = await memory(dir).add({ content: 'the launch code name is original' });
    const holder = startChild(['hold-lock', dir, 'memory', '1200'], {});
    await holder.waitFor((out) => out.match(/HELD /));
    assert.equal(fs.existsSync(MEM_LOCK(dir)), true, 'the holder published its claim');

    const writer = startChild(['correct-memory', dir, '9', seed.id], { waitMs: WRITE_LOCK_WAIT_MS });
    const done = await writer.exit;
    const [result] = writer.results;
    assert.equal(result.ok, true, `the writer waited and then wrote: ${JSON.stringify(result)}`);
    assert.equal(done.code, 0, writer.out);
    assert.ok(result.ms >= 100, `the write waited for the holder (took ${result.ms} ms)`);
    await holder.exit;

    const records = readRecords(MEMORY(dir));
    assert.equal(records.length, 2, 'the seeded claim and this one replacement');
    assert.equal(records.filter((r) => r.provenance?.replaces?.includes(seed.id)).length, 1);
    assert.deepEqual(residue(dir), [], 'the holder released and the writer removed its own claim');
  });

  // 10. A process is terminated while holding the lock.
  test('a process killed while holding the lock leaves a claim the next write takes over', async () => {
    const dir = tempDir();
    const seed = await memory(dir).add({ content: 'the office plant is a fern' });
    const holder = startChild(['hold-lock', dir, 'memory', '0'], {});
    await holder.waitFor((out) => out.match(/HELD /));
    const raw = fs.readFileSync(MEM_LOCK(dir), 'utf8');
    assert.equal(JSON.parse(raw).pid, holder.child.pid, 'the claim names the process that wrote it');

    holder.child.kill();
    await holder.exit;
    // The exited pid is not assumed dead: the fixture rebinds the claim to the stable dead pid
    // after checking it still names the process that was just terminated.
    rebindDeadHolder(MEM_LOCK(dir), holder.child.pid);

    const store = memory(dir, { lockWaitMs: 2000 });
    const added = await store.add({ content: 'the launch code name is Falcon' });
    const records = readRecords(MEMORY(dir));
    assert.equal(records.length, 2, 'the interrupted write wrote nothing and the new write is complete');
    assert.equal(records.at(-1).id, added.id);
    assert.equal(fs.existsSync(MEM_LOCK(dir)), false, 'the abandoned claim was taken over');
    assert.deepEqual(residue(dir), [], 'the takeover left no token behind');
    assert.equal(records[0].id, seed.id, 'the pre-existing record is unchanged');
    assert.equal(fs.existsSync(KNOWLEDGE(dir)), false, 'only the contended store was touched');
  });

  // 12. A bounded wait that expires reports a truthful failure.
  test('a writer whose bounded wait expires refuses with nothing written, and the store is unchanged', async () => {
    const dir = tempDir();
    const seed = await memory(dir).add({ content: 'the launch code name is original' });
    const holder = startChild(['hold-lock', dir, 'memory', '2500'], {});
    await holder.waitFor((out) => out.match(/HELD /));

    const before = fs.readFileSync(MEMORY(dir), 'utf8');
    const quick = startChild(['add-memory', dir, '7', '1'], { waitMs: 300 });
    const done = await quick.exit;
    assert.equal(done.code, 1, quick.out);
    const [result] = quick.results;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'LOCKED');
    assert.match(result.message, /it is in use by process \d+; nothing was written/, result.message);
    assert.ok(result.ms < 2000, `the refusal came from the 300 ms budget, not the default one (${result.ms} ms)`);
    assert.equal(fs.readFileSync(MEMORY(dir), 'utf8'), before, 'the refused writer changed no byte');

    // The holder is still live, so the claim is still its own; the store stays usable afterwards.
    assert.equal(fs.existsSync(MEM_LOCK(dir)), true, 'a refusal never removes another process claim');
    await holder.exit;
    const retry = await memory(dir).correct({ targetId: seed.id, content: 'the launch code name is Falcon', origin: 'user' });
    assert.ok(retry.id);
    assert.equal(readRecords(MEMORY(dir)).length, 2);
    assert.deepEqual(residue(dir), []);
  });

  test('the default budget is bounded and disclosed, so a stuck holder cannot hang a command', () => {
    assert.equal(Number.isFinite(WRITE_LOCK_WAIT_MS), true);
    assert.ok(WRITE_LOCK_WAIT_MS > 0 && WRITE_LOCK_WAIT_MS <= 15000, `${WRITE_LOCK_WAIT_MS} ms`);
    const dir = tempDir();
    const store = memory(dir);
    assert.equal(store.writeLock.waitMs, WRITE_LOCK_WAIT_MS, 'a store opts into the bounded default, not an unbounded wait');
  });
});

describe('W-06 scenario 9, 11: uncertain ownership and recovery fail closed', () => {
  // 9. A corrupt or ambiguous lock.
  test('an unreadable claim is reported as in use by an unknown process and is never removed', async () => {
    const dir = tempDir();
    const seed = await memory(dir).add({ content: 'the office plant is a fern' });
    const before = fs.readFileSync(MEMORY(dir), 'utf8');
    fs.writeFileSync(MEM_LOCK(dir), 'this claim is not json');

    const store = memory(dir, { lockWaitMs: 300 });
    await assert.rejects(
      () => store.add({ content: 'the launch code name is Falcon' }),
      (err) => {
        assert.equal(err.code, 'LOCKED');
        assert.match(err.message, /it is in use by process unknown; nothing was written/, err.message);
        return true;
      },
    );
    assert.equal(fs.readFileSync(MEMORY(dir), 'utf8'), before, 'a refused write left the store byte for byte as it was');
    assert.equal(fs.readFileSync(MEM_LOCK(dir), 'utf8'), 'this claim is not json', 'an ambiguous claim is not deleted on a guess');
    await assert.rejects(() => store.recover(), /holder cannot be identified/, 'recovery of an unreadable holder refuses');
    assert.equal(readRecords(MEMORY(dir)).length, 1);
    assert.equal(seed.content, 'the office plant is a fern');

    // Once the ambiguous claim is cleared by the operator, the store is writable again.
    fs.rmSync(MEM_LOCK(dir));
    await store.add({ content: 'the launch code name is Falcon' });
    assert.equal(readRecords(MEMORY(dir)).length, 2);
    assert.deepEqual(residue(dir), []);
  });

  // 11. Stale-lock recovery proves a live holder is never removed.
  test('recovery refuses a live holder, a write refuses it, and the claim is untouched', async () => {
    const dir = tempDir();
    const seed = await knowledge(dir).add({ subject: 'the launch code name', relationship: 'is', object: 'Falcon', origin: 'user' });
    const raw = claim(process.pid); // this test process is alive, so the holder is live
    fs.writeFileSync(KN_LOCK(dir), raw);

    const store = knowledge(dir, { lockWaitMs: 300 });
    const before = fs.readFileSync(KNOWLEDGE(dir), 'utf8');
    await assert.rejects(() => store.recover(), new RegExp(`held by live process ${process.pid}; refusing recovery`));
    assert.equal(fs.readFileSync(KN_LOCK(dir), 'utf8'), raw, 'recovery removed nothing and displaced nobody');
    await assert.rejects(
      () => store.retract({ target: seed.record.id, reason: 'would be refused', origin: 'user' }),
      (err) => {
        assert.equal(err.code, 'LOCKED');
        assert.match(err.message, new RegExp(`it is in use by process ${process.pid}; nothing was written`), err.message);
        return true;
      },
    );
    assert.equal(fs.readFileSync(KNOWLEDGE(dir), 'utf8'), before, 'the live holder claim kept the store untouched');
    assert.equal(readRecords(KNOWLEDGE(dir)).length, 1);

    fs.rmSync(KN_LOCK(dir));
    await store.retract({ target: seed.record.id, reason: 'no longer contested', origin: 'user' });
    assert.equal(readRecords(KNOWLEDGE(dir)).length, 2);
    assert.deepEqual(residue(dir), []);
  });

  test('recovery of sixteen abandoned tokens removes tokens only, and the claim stays for the election', async () => {
    const dir = tempDir();
    const seed = await memory(dir).add({ content: 'the office plant is a fern' });
    const raw = claim(deadPid());
    fs.writeFileSync(MEM_LOCK(dir), raw);
    const { tokens } = writeTokens(MEM_LOCK(dir), raw);

    const store = memory(dir, { lockWaitMs: 300 });
    await assert.rejects(() => store.add({ content: 'the launch code name is Falcon' }), /16 takeover attempts are recorded as abandoned; run "apex repair locks"/);
    assert.equal(readRecords(MEMORY(dir)).length, 1, 'the exhausted writer wrote nothing');

    const result = await store.recover();
    assert.equal(result.removedTokens, TAKEOVER_EPOCHS);
    for (const token of tokens) assert.equal(fs.existsSync(token), false, 'the abandoned token was removed');
    assert.equal(fs.readFileSync(MEM_LOCK(dir), 'utf8'), raw, 'the claim itself was not removed by recovery');

    // A normal write then takes the dead claim over through the ordinary election.
    await store.add({ content: 'the launch code name is Falcon' });
    const records = readRecords(MEMORY(dir));
    assert.equal(records.length, 2);
    assert.deepEqual(residue(dir), [], 'the takeover released its own claim');
    assert.equal(seed.kind, 'user_fact');
  });
});

describe('W-06 scenario 13-15: the authoritative read, the append, and the cache', () => {
  // 13. An append failure under coordination.
  test('an append that writes nothing is refused, releases the lock, and leaves the store parseable', async () => {
    const dir = tempDir();
    const file = MEMORY(dir);
    const store = memory(dir);
    await store.add({ content: 'the build runs on Node 26' });
    const before = fs.readFileSync(file, 'utf8');

    const realOpen = fsp.open;
    fsp.open = async (target, ...rest) => {
      const handle = await realOpen(target, ...rest);
      if (path.resolve(String(target)) !== path.resolve(file)) return handle;
      handle.write = async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) });
      return handle;
    };
    let failed;
    try {
      failed = await store.add({ content: 'the launch code name is Falcon' }).then(() => null, (err) => err);
    } finally {
      fsp.open = realOpen;
    }
    assert.ok(failed, 'the short write is not reported as success');
    assert.match(failed.message, /cannot write memory\.jsonl: write accepted 0 of \d+ bytes/, failed.message);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'no partial record reached the file');
    assert.equal(fs.existsSync(`${file}.lock`), false, 'the failure path released the claim');
    assert.deepEqual(residue(dir), []);

    // The next write is sound rather than lucky: the refused record is absent and nothing else is.
    const next = await store.add({ content: 'the office plant is a fern' });
    const records = readRecords(file);
    assert.deepEqual(records.map((r) => r.content), ['the build runs on Node 26', 'the office plant is a fern']);
    assert.equal(records.at(-1).id, next.id);
  });

  test('a confirmed append is followed by release; a claim that cannot be removed is not a lost write', async () => {
    const dir = tempDir();
    const store = memory(dir);
    const record = await store.add({ content: 'the office plant is a fern' });
    const file = MEMORY(dir);

    // Windows can refuse to delete a file another process still holds open for reading. The record
    // is already fsynced when release tries to remove the claim, so the refusal must not be
    // reported as a failed write - and the claim must not be left naming this live process.
    const realRm = fsp.rm;
    fsp.rm = async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(`${file}.lock`)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return realRm(target, options);
    };
    let second;
    try {
      second = await store.add({ content: 'the launch code name is Falcon' });
    } finally {
      fsp.rm = realRm;
    }
    assert.ok(second.id, 'the write whose claim could not be removed still succeeded');
    const records = readRecords(file);
    assert.deepEqual(records.map((r) => r.content).sort(), ['the launch code name is Falcon', 'the office plant is a fern']);

    // The orphaned claim is this instance's own to reclaim, so the next write is not locked out.
    const third = await store.add({ content: 'the meeting room is blue' });
    assert.ok(third.id);
    assert.equal(readRecords(file).length, 3);
    assert.equal(fs.existsSync(`${file}.lock`), false, 'the reclaimed orphan was removed');
  });

  // 14. Corrupt authoritative storage met after the lock is held.
  test('a corrupt store is discovered under the lock and refuses the write, leaving the damage and the claim bookkeeping intact', async () => {
    const dir = tempDir();
    const file = MEMORY(dir);
    const store = memory(dir);
    await store.add({ content: 'the office plant is a fern' });
    fs.appendFileSync(file, '{not a record\n');
    const before = fs.readFileSync(file, 'utf8');

    // Instrumented only to prove *where* the authoritative read happens: the flag is taken after
    // coordination acquired the claim and before the store is read.
    const realRun = store.writeLock.run.bind(store.writeLock);
    let heldDuringRead = null;
    store.writeLock.run = (fn) => realRun(async () => {
      heldDuringRead = fs.existsSync(`${file}.lock`);
      return fn();
    });

    const failed = await store.add({ content: 'the launch code name is Falcon' }).then(() => null, (err) => err);
    assert.ok(failed, 'a damaged store refuses a new record');
    assert.match(failed.message, /corrupt/, failed.message);
    assert.equal(heldDuringRead, true, 'the authoritative read that found the damage ran while the claim was held');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the corrupt line was not skipped, repaired, or buried under a new record');
    assert.equal(fs.existsSync(`${file}.lock`), false, 'the refusal released the claim it acquired');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    assert.equal(lines.length, 2, 'the store still holds its one record plus the damage, and nothing else');
    assert.equal(JSON.parse(lines[0]).content, 'the office plant is a fern');
  });

  // 15. Incremental state invalidated by a different process changing the file.
  test('a warm instance cannot authorize a decision from state another process has already changed', async () => {
    const dir = tempDir();
    const store = memory(dir);
    const seed = await store.add({ content: 'the launch code name is original' });
    // Warm this instance's derived state with a read of the authoritative log.
    assert.equal((await store.list({ limit: 10 })).length, 1);

    const raced = await runChild(['correct-memory', dir, '4', seed.id], {});
    assert.equal(raced.code, 0, raced.out);
    assert.equal(raced.results[0].ok, true);

    // The other process replaced the claim. This instance still holds a state without that
    // replacement, so its own correction of the same target must be refused, not appended.
    const failed = await store.correct({ targetId: seed.id, content: 'the launch code name is Falcon', origin: 'user' })
      .then(() => null, (err) => err);
    assert.ok(failed, 'a stale snapshot cannot authorize a second replacement');
    assert.match(failed.message, /already corrected/, failed.message);

    const records = readRecords(MEMORY(dir));
    assert.equal(records.length, 2, 'the store holds one original and one replacement');
    assert.equal(records.filter((r) => r.provenance?.replaces?.includes(seed.id)).length, 1);
    assert.equal(records[1].id, raced.results[0].id, 'the record that won is the one on disk');

    // The read path is invalidated by the same external change rather than answering from the old state.
    const view = await store.list({ limit: 10 });
    assert.equal(view.length, 2);

    const kdir = tempDir();
    const kstore = knowledge(kdir);
    const first = await kstore.add({ subject: 'the launch code name', relationship: 'is', object: 'Falcon', origin: 'user' });
    await kstore.list({ limit: 10 });
    const other = await runChild(['retract-knowledge', kdir, '4', first.record.id], {});
    assert.equal(other.code, 0, other.out);
    const kfailed = await kstore.retract({ target: first.record.id, reason: 'second attempt', origin: 'user' }).then(() => null, (err) => err);
    assert.ok(kfailed, 'the knowledge store sees a foreign retraction before deciding');
    assert.match(kfailed.message, /already retracted/, kfailed.message);
    assert.equal(readRecords(KNOWLEDGE(kdir)).filter((r) => r.kind === 'retraction').length, 1);
  });
});

describe('W-06 scenario 16-18: many writers, repeated rounds, and readers that never coordinate', () => {
  // 16. Many simultaneous writers on both stores in one directory.
  test('five memory writers and five knowledge writers run together without loss or malformed lines', async () => {
    const dir = tempDir();
    // Every writer here gets a 60 s wait budget instead of the 10 s default, and the reason is the
    // test's own question: it asks whether ten simultaneous writers can lose, duplicate or corrupt
    // a record, so a write that gives up must not be the failure it reports. On this machine, with
    // the whole suite running in parallel, one coordinated write was measured waiting 10,553 ms
    // behind nine other processes and expiring - a truthful `LOCKED` refusal, no data lost, but not
    // the property under test. The default budget is pinned by its own scenarios (the expired
    // refusal and the disclosed-wait cases), which pass the budget they mean to assert.
    const handles = [
      ...[0, 1, 2, 3, 4].map((w) => startChild(['add-memory', dir, String(w), '6'], { racers: 10, waitMs: 60000 })),
      ...[0, 1, 2, 3, 4].map((w) => startChild(['add-knowledge', dir, String(w), '6'], { racers: 10, waitMs: 60000 })),
    ];
    const runs = [];
    for (const handle of handles) runs.push({ ...(await handle.exit), out: handle.out, results: resultsOf(handle.out) });

    for (const run of runs) assert.equal(run.code, 0, run.out);
    assert.equal(runs.reduce((n, run) => n + run.results.filter((r) => r.ok).length, 0), 60);

    const records = readRecords(MEMORY(dir));
    assert.equal(records.length, 30, 'no memory fact was lost');
    assert.equal(new Set(records.map((r) => r.id)).size, 30);
    const claims = readRecords(KNOWLEDGE(dir));
    assert.equal(claims.length, 30, 'no knowledge claim was lost');
    assert.equal(new Set(claims.map((c) => c.id)).size, 30);
    assert.equal(records.filter((r) => !r.content || !r.contentSha256).length, 0, 'every line parsed as a complete record');
    assert.deepEqual(residue(dir), [], 'ten writers left no claim, token or temp file');
  });

  // 17. Repeated stress rounds accumulate rather than drift.
  test('three stress rounds each keep every record and end with no coordination residue', async () => {
    const dir = tempDir();
    for (let round = 1; round <= 3; round += 1) {
      const handles = [
        ...[0, 1, 2].map((w) => startChild(['add-memory', dir, `${round}-${w}`, '4'], { racers: 6, waitMs: 60000 })),
        ...[0, 1, 2].map((w) => startChild(['add-knowledge', dir, `${round}-${w}`, '4'], { racers: 6, waitMs: 60000 })),
      ];
      const runs = [];
      for (const handle of handles) runs.push({ ...(await handle.exit), out: handle.out, results: resultsOf(handle.out) });
      for (const run of runs) assert.equal(run.code, 0, `${round}: ${run.out}`);
      assert.equal(
        readRecords(MEMORY(dir)).length, round * 12,
        `round ${round}: the store holds every fact written so far`,
      );
      assert.equal(readRecords(KNOWLEDGE(dir)).length, round * 12);
      assert.deepEqual(residue(dir), [], `round ${round} left no residue`);
    }
    const contents = readRecords(MEMORY(dir)).map((r) => r.content);
    assert.equal(new Set(contents).size, contents.length, 'no two writers overwrote each other');
  });

  // 18. Read-only operations stay read-only, even while a writer holds the lock.
  test('read-only operations neither take the lock nor disturb a live holder', async () => {
    const dir = tempDir();
    await memory(dir).add({ content: 'fact from writer 0 number 0' });
    await knowledge(dir).add({ subject: 'claim from writer 0', relationship: 'recorded by test', object: 'number 0', origin: 'user' });

    const holder = startChild(['hold-lock', dir, 'memory', '1500'], {});
    await holder.waitFor((out) => out.match(/HELD /));
    const lockBytes = fs.readFileSync(MEM_LOCK(dir), 'utf8');

    const reader = await runChild(['read-only', dir, '0'], {});
    assert.equal(reader.code, 0, reader.out);
    const [view] = reader.results;
    assert.equal(view.ok, true);
    assert.equal(view.memoryRecords, 1);
    assert.equal(view.knowledgeClaims, 1);
    assert.equal(view.memoryMatches, 1, 'a reader is answered while a writer holds the lock');
    assert.equal(view.unchanged, true, 'the reader created no file in the store directory');
    assert.equal(fs.readFileSync(MEM_LOCK(dir), 'utf8'), lockBytes, 'the live holder claim was not read-write disturbed');
    assert.equal(fs.existsSync(KN_LOCK(dir)), false, 'the untouched store gained no lock');
    await holder.exit;
    assert.deepEqual(residue(dir), [], 'the holder released');
  });
});

describe('W-06 operational surface: the two new locks are visible and repairable', () => {
  test('a fresh data directory reports both write locks and creates neither of them', async () => {
    const dir = tempDir();
    const res = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Memory lock: no lock file; nothing to recover/, res.stdout);
    assert.match(res.stdout, /Knowledge lock: no lock file; nothing to recover/, res.stdout);
    assert.equal(fs.existsSync(MEM_LOCK(dir)), false, 'inspection created no memory lock');
    assert.equal(fs.existsSync(KN_LOCK(dir)), false, 'inspection created no knowledge lock');
  });

  test('diagnose reports a stuck memory lock as needing recovery, and repair locks clears only the tokens', async () => {
    const dir = tempDir();
    const seed = await memory(dir).add({ content: 'the office plant is a fern' });
    const raw = claim(deadPid());
    fs.writeFileSync(MEM_LOCK(dir), raw);
    const { tokens } = writeTokens(MEM_LOCK(dir), raw);

    const before = await runCli(['diagnose'], envFor(dir));
    assert.match(before.stdout, /Memory lock: recovery required - 16 takeover token\(s\)/, before.stdout);
    assert.match(before.stdout, /"apex repair locks"/, before.stdout);
    for (const token of tokens) assert.equal(fs.existsSync(token), true, 'diagnose removed nothing');
    assert.equal(fs.readFileSync(MEM_LOCK(dir), 'utf8'), raw, 'diagnose left the claim as it found it');

    const repaired = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr);
    assert.match(repaired.stdout, /Memory lock: removed 16 abandoned takeover token\(s\)/, repaired.stdout);
    for (const token of tokens) assert.equal(fs.existsSync(token), false);
    assert.equal(fs.readFileSync(MEM_LOCK(dir), 'utf8'), raw, 'repair never deletes a claim');

    const res = await runCli(['memory', 'correct', '--resolve', seed.id, 'the office plant is a cactus'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Stored correction [0-9a-f-]{36}/, res.stdout);
    assert.match(res.stdout, /Audit:\s+recorded/, res.stdout);
    const after = readRecords(MEMORY(dir));
    assert.equal(after.length, 2, 'the CLI write took the dead claim over');
    assert.deepEqual(after[1].provenance.replaces, [seed.id], 'and the correction replaced the record it named');
    assert.deepEqual(residue(dir), [], 'the recovered store is left with no lock bookkeeping');
  });

  // The write lock's refusal is the case §7 cares about most: it must read as a refusal that
  // changed nothing, never as a write whose outcome is unknown. `ask` is the path that prints the
  // classification; "remember that …" is routed deterministically, so no model is contacted.
  test('a memory write refused by a live holder is reported as refused before writing, not as a possible partial write', async () => {
    const dir = tempDir();
    await memory(dir).add({ content: 'the launch code name is original' });
    const raw = claim(process.pid);
    fs.writeFileSync(MEM_LOCK(dir), raw);
    const before = fs.readFileSync(MEMORY(dir), 'utf8');

    const res = await runCli(['ask', 'remember that the launch code name is Zephyr'], envFor(dir));
    assert.notEqual(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /cannot write memory\.jsonl: it is in use by process \d+; nothing was written/, res.stdout);
    assert.match(res.stdout, /refused before it began, so nothing was written/, res.stdout);
    assert.doesNotMatch(res.stdout, /cannot establish whether it changed stored data/, 'a refusal before coordination is not a partial write');
    assert.equal(fs.readFileSync(MEMORY(dir), 'utf8'), before, 'the store was not touched');
    assert.equal(fs.readFileSync(MEM_LOCK(dir), 'utf8'), raw, 'the refused writer left the live holder claim exactly as it found it');
    assert.equal(readRecords(MEMORY(dir)).length, 1);

    // The audit trail keeps the same distinction the terminal does: a coordination refusal is
    // recorded as a failure that never ran verification, so a later reader can tell that nothing
    // was written without asking this process.
    const audit = readRecords(path.join(dir, 'operations.jsonl'));
    const step = audit.at(-1).steps.find((s) => s.action === 'memory.add');
    assert.equal(step.execution.status, 'failed');
    assert.equal(step.execution.error.code, 'LOCKED', 'the audit names the refusal class, not a generic failure');
    assert.match(step.execution.error.message, /nothing was written/);
    assert.equal(step.verification.outcome, 'not_run', 'verification never ran, because there was nothing to verify');
    assert.equal(audit.at(-1).status, 'execution_failed');

    fs.rmSync(MEM_LOCK(dir));
    assert.deepEqual(residue(dir), [], 'the only lock bookkeeping was the claim this test installed');
  });

  test('a knowledge CLI write refused by a live holder names the store and says nothing was written', async () => {
    const dir = tempDir();
    await knowledge(dir).add({ subject: 'the launch code name', relationship: 'is', object: 'Falcon', origin: 'user' });
    fs.writeFileSync(KN_LOCK(dir), claim(process.pid));
    const before = fs.readFileSync(KNOWLEDGE(dir), 'utf8');

    const res = await runCli(['knowledge', 'add', '--subject', 'the launch code name', '--relationship', 'is', '--object', 'Zephyr'], envFor(dir));
    assert.notEqual(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /execution failed: cannot write knowledge\.jsonl: it is in use by process \d+; nothing was written/, res.stdout);
    assert.equal(fs.readFileSync(KNOWLEDGE(dir), 'utf8'), before, 'the live holder claim kept the store untouched');
    assert.equal(readRecords(KNOWLEDGE(dir)).length, 1);
    const audit = readRecords(path.join(dir, 'operations.jsonl')).at(-1);
    assert.equal(audit.steps.find((s) => s.action === 'knowledge.add').execution.error.code, 'LOCKED');
    assert.equal(audit.status, 'execution_failed', 'a refused write is never audited as a success');

    fs.rmSync(KN_LOCK(dir));
    assert.deepEqual(residue(dir), []);
  });
});

describe('W-07 §7: coordination grants no authority, and failure keeps its side-effect ordering', () => {
  // Every write path below is instrumented with the same counter: the number of times a writer
  // lock was actually sought. An unauthorized request must be refused before that count moves, so
  // "took the lock" can never be the thing that made a write legitimate.
  function countAcquisitions() {
    const real = WriterLock.prototype.run;
    const counter = { calls: 0 };
    WriterLock.prototype.run = function counted(fn) {
      counter.calls += 1;
      return real.call(this, fn);
    };
    counter.restore = () => { WriterLock.prototype.run = real; };
    return counter;
  }

  test('a request that is not authorized is refused before any store is coordinated', async () => {
    const dir = tempDir();
    const mem = memory(dir);
    const kn = knowledge(dir);
    const counter = countAcquisitions();
    try {
      const refusals = [
        () => mem.add({ content: 'the launch code name is Falcon', source: 'assistant' }),
        () => mem.add({ content: 'the launch code name is Falcon', provenance: { updateMode: 'user_confirmed' } }),
        () => mem.add({ content: 'the launch code name is Falcon', provenance: { replaces: ['x'] } }),
        () => mem.correct({ targetId: '00000000-0000-4000-8000-000000000000', content: 'the launch code name is Falcon', origin: 'model' }),
        () => kn.add({ subject: 'the launch code name', relationship: 'is', object: 'Falcon', origin: 'model' }),
        () => kn.retract({ target: '00000000-0000-4000-8000-000000000000', reason: 'proposed by a model', origin: 'model' }),
        () => kn.resolve({ target: '00000000-0000-4000-8000-000000000000', choose: '00000000-0000-4000-8000-000000000000', reason: 'decided by a model', origin: 'model' }),
      ];
      const messages = [];
      for (const call of refusals) {
        // eslint-disable-next-line no-await-in-loop
        const err = await call().then(() => null, (e) => e);
        assert.ok(err, 'the unauthorized request is refused');
        messages.push(`${err.code ?? 'ERROR'}: ${err.message}`);
      }
      assert.equal(counter.calls, 0, `no refusal sought a lock: ${messages.join(' | ')}`);
      assert.deepEqual(messages.map((m) => m.split(': ')[0]), [
        'INVALID_INPUT', 'INVALID_INPUT', 'INVALID_INPUT', 'INVALID_INPUT',
        'WRITE_REQUIRES_USER_ORIGIN', 'WRITE_REQUIRES_USER_ORIGIN', 'WRITE_REQUIRES_USER_ORIGIN',
      ], 'the refusals are authorization failures, not coordination failures');
    } finally {
      counter.restore();
    }
    assert.equal(fs.existsSync(MEM_LOCK(dir)), false, 'the memory store was never coordinated');
    assert.equal(fs.existsSync(KN_LOCK(dir)), false, 'the knowledge store was never coordinated');
    assert.equal(fs.existsSync(MEMORY(dir)), false, 'nothing was appended by a refused request');
    assert.equal(fs.existsSync(KNOWLEDGE(dir)), false);
    assert.deepEqual(residue(dir), []);
  });

  test('a plan or action proposed by a model cannot reach the write lock even if execution is attempted', async () => {
    const dir = tempDir();
    const registry = new ActionRegistry();
    for (const def of [...builtinActions(), ...knowledgeActions(knowledge(dir))]) registry.register(def);
    const counter = countAcquisitions();
    try {
      const modelWrite = checkSteps(
        [{ id: 's1', description: 'remember a codename', action: 'memory.add', input: { content: 'the launch code name is Falcon' }, dependsOn: [] }],
        registry,
        'model',
      );
      assert.ok(modelWrite.problems.some((p) => /cannot be stored as a user fact/.test(p)), modelWrite.problems.join(' | '));

      for (const name of ['memory.add', 'memory.correct', 'knowledge.add', 'knowledge.retract', 'knowledge.resolve']) {
        assert.notEqual(registry.authorize(name, 'model').decision, 'allow', `${name} is not model-authorizable`);
        assert.equal(registry.authorize(name, 'user').decision, 'allow', `${name} remains available to the user`);
      }

      // Even with authorization bypassed by calling the action body directly, the store's own
      // origin gate fires first, so the lock is never what decides the outcome.
      const executed = await executeAction(registry.get('memory.correct'), {
        memory: memory(dir),
        knowledge: knowledge(dir),
        origin: 'model',
        operationId: 'probe',
      }, {
        targetId: '00000000-0000-4000-8000-000000000000',
        content: 'the launch code name is Falcon',
        resolve: true,
      });
      assert.equal(executed.status, 'failed');
      assert.match(executed.error.message, /require an authorized user-origin operation/);
      assert.equal(counter.calls, 0, 'neither the refused plan nor the refused action sought a lock');
      assert.equal(fs.existsSync(MEMORY(dir)), false, 'and no store file was created');
    } finally {
      counter.restore();
    }
    assert.deepEqual(residue(dir), []);
  });

  test('a private memory write is stored, verified, and kept out of the audit trail while coordination is active', async () => {
    const dir = tempDir();
    // The knowledge lock is held by another live process for the duration: memory and knowledge
    // coordinate independently, so a write to one store never waits on the other.
    const holder = startChild(['hold-lock', dir, 'knowledge', '4000'], {});
    await holder.waitFor((out) => out.match(/HELD /));

    const res = await runCli(['ask', 'remember privately that my door code is 4721-99'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Status:\s+success_verified/, res.stdout);
    await holder.exit;

    const records = readRecords(MEMORY(dir));
    assert.equal(records.length, 1);
    assert.equal(records[0].sensitivity, 'private');
    assert.match(records[0].content, /4721-99/, 'the private claim is stored in the store that holds it');

    const audit = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8');
    assert.doesNotMatch(audit, /4721-99/, 'the audit trail does not carry the secret');
    assert.doesNotMatch(audit, /door code/, 'and not a fragment of the private claim either');
    const step = JSON.parse(audit.trim().split('\n').at(-1)).steps.find((s) => s.action === 'memory.add');
    assert.equal(step.verification.outcome, 'success_verified', 'independent verification still ran on the coordinated write');

    const claims = readRecords(KNOWLEDGE(dir));
    assert.equal(claims.length, 0, 'the contended knowledge store was not written');
    assert.equal(fs.existsSync(KN_LOCK(dir)), false, 'the holder released its own claim');
    assert.deepEqual(residue(dir), []);
  });

  test('an ownership loss after the append is reported as a write that happened, never as nothing was written', async () => {
    const dir = tempDir();
    const file = MEMORY(dir);
    const store = memory(dir);
    const foreign = claim(deadPid(), 'another holder');

    // Replace the claim between the confirmed append and the release, so this process can no
    // longer prove it owned the lock when it comes to give it up - after the record is durable.
    const realAppend = store.log.append.bind(store.log);
    store.log.append = async (record) => {
      await realAppend(record);
      fs.writeFileSync(MEM_LOCK(dir), foreign);
    };
    const failed = await store.add({ content: 'the launch code name is Falcon' }).then(() => null, (err) => err);
    assert.ok(failed, 'the release failure is not reported as success');
    assert.equal(failed.code, 'LOCK_LOST', 'a post-append failure keeps its own code, distinct from LOCKED');
    assert.match(failed.message, /could not be proved ours on release/, failed.message);
    assert.match(failed.message, /The record was written, so do not repeat the write/, failed.message);
    assert.doesNotMatch(failed.message, /nothing was written/, 'and never claims that nothing happened');

    const records = readRecords(file);
    assert.equal(records.length, 1, 'the record the store reported as written really is on disk');
    assert.equal(records[0].content, 'the launch code name is Falcon');
    assert.equal(fs.readFileSync(MEM_LOCK(dir), 'utf8'), foreign, 'the release removed a claim it could not prove, which was not its own');

    fs.rmSync(MEM_LOCK(dir));
    assert.deepEqual(residue(dir), []);
  });
});
