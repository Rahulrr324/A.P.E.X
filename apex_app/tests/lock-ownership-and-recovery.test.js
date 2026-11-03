// Batch AF (AF-16): lock ownership and recovery across every store.
//
// APEX coordinates writers with three different protocols, because they guard different critical
// sections: `WriterLock` (memory, knowledge, experience, prediction) holds a read-derive-append
// section and waits a bounded time for it; `TaskStore#withLock` guards a whole task run and refuses
// immediately; `SummaryQueue#withLock` guards one small queue rewrite with its own shorter budget.
// All three elect a single taker for a dead claim through the shared protocol in
// `src/tasks/lock-recovery.js`. Existing suites already prove the ordinary races (concurrent
// writers, a killed holder, exhausted takeover epochs, the two recovery guards). This suite covers
// the ownership questions those suites leave open, and it pins the budgets so a later change cannot
// quietly loosen a timeout or an ownership check to make a test pass:
//   1  corrupt lock metadata - every shape a claim can have, in every namespace;
//   2  the measured wait of each protocol, next to its exported budget;
//   3  the task lock's bounded publication attempts when a claim keeps vanishing;
//   4  a foreign live process id, which is refused on liveness and later taken over;
//   5  the two release paths that report lost ownership only after the record is durable;
//   6  what a release does when the claim is no longer its own (task and queue: leave it, say nothing);
//   7  a staging file another process left behind, which nobody adopts or deletes;
//   8  recovery held simultaneously over all six namespaces.
//
// Everything runs in a temporary directory through the real stores; no real user data is read or
// changed, no model is contacted, and dead holders come from the shared fixtures (`deadPid`,
// `rebindDeadHolder`) rather than from a pid that recently exited.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { makeTempDataDir, cleanup, cleanEnv, runCli, APP_ROOT, deadPid, rebindDeadHolder } from './helpers.js';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { KnowledgeStore } from '../src/knowledge/knowledge-store.js';
import { ExperienceStore } from '../src/experience/experience-store.js';
import { PredictionStore } from '../src/prediction/prediction-store.js';
import { OperationLog } from '../src/operations/operation-log.js';
import { TaskStore } from '../src/tasks/store.js';
import { SummaryQueue } from '../src/tasks/summary-queue.js';
import { WriterLock, WRITE_LOCK_WAIT_MS, WRITE_LOCK_RETRY_MIN_MS, WRITE_LOCK_RETRY_MAX_MS } from '../src/memory/writer-lock.js';
import { LOCK_WAIT_MS, LOCK_RETRY_MS, MAX_QUEUED_SUMMARIES, SUMMARIES_PER_DELIVERY } from '../src/tasks/summary-queue.js';
import { TAKEOVER_EPOCHS } from '../src/tasks/lock-recovery.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const CLOCK = () => new Date('2026-11-01T09:00:00.000Z');
const DAY = 86_400_000;
const SIGNATURE = 'a'.repeat(64);
const EXHAUST_CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'task-lock-exhaust-child.mjs');

const FILE = {
  memory: (dir) => path.join(dir, 'memory.jsonl'),
  knowledge: (dir) => path.join(dir, 'knowledge.jsonl'),
  experience: (dir) => path.join(dir, 'experiences.jsonl'),
  prediction: (dir) => path.join(dir, 'predictions.jsonl'),
  task: (dir) => path.join(dir, 'tasks.jsonl'),
  queue: (dir) => path.join(dir, 'task-summary-queue.json'),
  operations: (dir) => path.join(dir, 'operations.jsonl'),
};
const LOCK = {
  memory: (dir) => `${FILE.memory(dir)}.lock`,
  knowledge: (dir) => `${FILE.knowledge(dir)}.lock`,
  experience: (dir) => `${FILE.experience(dir)}.lock`,
  prediction: (dir) => `${FILE.prediction(dir)}.lock`,
  task: (dir) => `${FILE.task(dir)}.lock`,
  queue: (dir) => `${FILE.queue(dir)}.lock`,
};
const ALL_NAMESPACES = ['memory', 'knowledge', 'experience', 'prediction', 'task', 'queue'];

function envFor(dir) {
  return cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
}

function claim(pid, nonce = 'fixture') {
  return JSON.stringify({ pid, nonce, at: new Date().toISOString() });
}

function keyOf(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

// Takeover tokens are named after the digest of the claim they belong to, so an exhausted-election
// fixture has to derive the same prefix the election does rather than invent one.
function writeTokens(lockPath, raw, count = TAKEOVER_EPOCHS) {
  const key = keyOf(raw);
  const tokens = [];
  for (let epoch = 0; epoch < count; epoch += 1) {
    const token = `${lockPath}.takeover.${key}.${epoch}`;
    fs.writeFileSync(token, claim(deadPid()));
    tokens.push(token);
  }
  return tokens;
}

function leftovers(dir) {
  return fs.readdirSync(dir).filter((name) => (
    name.endsWith('.lock') || name.includes('.takeover.') || name.endsWith('.recover') || name.endsWith('.tmp')
  )).sort();
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

// The four stores that use WriterLock, each with its own shortest legal write. `refusal` is the
// suffix that store's protocol is required to carry: a refusal before the append always says
// nothing was written.
function writerStores(dir, options = {}) {
  const operations = new OperationLog(FILE.operations(dir));
  const experience = new ExperienceStore(FILE.experience(dir), { now: CLOCK, operations, ...options });
  const prediction = new PredictionStore(FILE.prediction(dir), { now: CLOCK, experiences: experience, ...options });
  let n = 0;
  return {
    memory: {
      store: new MemoryStore(FILE.memory(dir), { now: CLOCK, ...options }),
      file: FILE.memory(dir),
      write: () => new MemoryStore(FILE.memory(dir), { now: CLOCK, ...options }).add({ content: `fact ${n++}` }),
    },
    knowledge: {
      store: new KnowledgeStore(FILE.knowledge(dir), { now: CLOCK, ...options }),
      file: FILE.knowledge(dir),
      write: () => new KnowledgeStore(FILE.knowledge(dir), { now: CLOCK, ...options })
        .add({ subject: `subject ${n++}`, relationship: 'is', object: 'Falcon', origin: 'user' }),
    },
    experience: {
      store: experience,
      file: FILE.experience(dir),
      write: () => experience.recordExperience({ operationId: randomUUID(), subject: 'event', origin: 'user' }),
    },
    prediction: {
      store: prediction,
      file: FILE.prediction(dir),
      write: () => prediction.recordPrediction({
        capability: 'race.ambiguous', expectation: 'success', subject: `expectation ${n++}`,
        expiresAt: new Date(CLOCK().getTime() + 30 * DAY).toISOString(), origin: 'user',
      }),
    },
  };
}

// A claim whose holder cannot be identified. None of these may ever be read as "free": the holder
// could be a process that is running and only wrote its claim badly.
const CORRUPT_CLAIMS = [
  ['an empty claim', ''],
  ['an object with no pid', '{}'],
  ['pid zero', '{"pid":0}'],
  ['a negative pid', '{"pid":-7}'],
  ['a fractional pid', '{"pid":1.5}'],
  ['a non-numeric pid', '{"pid":"not-a-number"}'],
  ['a claim that is an array', '[]'],
  ['a half-written claim', 'this claim is not json'],
];

describe('AF-16 1: corrupt lock metadata is an unknown holder, never a free lock', () => {
  test('every WriterLock store refuses every unreadable claim shape and recovery refuses it too', async () => {
    for (const [name, body] of CORRUPT_CLAIMS) {
      const dir = tempDir();
      const stores = writerStores(dir, { lockWaitMs: 60 });
      const planted = [];
      for (const namespace of ['memory', 'knowledge', 'experience', 'prediction']) {
        const { store, file, write } = stores[namespace];
        fs.writeFileSync(LOCK[namespace](dir), body);
        planted.push(path.basename(LOCK[namespace](dir)));
        const failed = await write().then((value) => ({ unexpected: value }), (err) => err);
        assert.equal(failed.code, 'LOCKED', `${namespace} / ${name}: ${JSON.stringify(failed)}`);
        assert.match(failed.message, /it is in use by process unknown; nothing was written/, `${namespace} / ${name}`);
        assert.equal(fs.existsSync(file), false, `${namespace} / ${name}: a refused write created no log`);
        assert.equal(fs.readFileSync(LOCK[namespace](dir), 'utf8'), body, `${namespace} / ${name}: an unreadable claim is never deleted on a guess`);

        const report = await store.lockReport();
        assert.equal(report.present, true, `${namespace} / ${name}`);
        assert.equal(report.pid, null, `${namespace} / ${name}: an unreadable holder is not reported as a pid`);
        assert.equal(report.alive, null, `${namespace} / ${name}: "cannot tell" is not reported as "not running"`);
        await assert.rejects(
          () => store.recover(),
          /holder cannot be identified; refusing recovery/,
          `${namespace} / ${name}: recovery of an unreadable holder refuses`,
        );
        assert.equal(fs.readFileSync(LOCK[namespace](dir), 'utf8'), body, `${namespace} / ${name}: recovery left the claim`);
        assert.deepEqual(leftovers(dir), [...planted].sort(), `${namespace} / ${name}: only the claims this test planted remain, and no token or guard was created`);
      }
    }
  });

  test('the task lock refuses every unreadable claim shape without waiting', async () => {
    const dir = tempDir();
    const store = new TaskStore(FILE.task(dir), { now: CLOCK });
    for (const [name, body] of CORRUPT_CLAIMS) {
      fs.writeFileSync(LOCK.task(dir), body);
      let ran = false;
      const failed = await store.withLock(async () => { ran = true; return 'acquired'; }).then((value) => ({ value }), (err) => err);
      assert.equal(failed.code, 'LOCKED', `${name}: ${JSON.stringify(failed)}`);
      assert.match(failed.message, /tasks are in use by process unknown; try again when it finishes/, name);
      assert.equal(ran, false, `${name}: the protected work never started`);
      assert.equal(fs.existsSync(FILE.task(dir)), false, `${name}: no task log was created`);
      assert.equal(fs.readFileSync(LOCK.task(dir), 'utf8'), body, `${name}: the unreadable claim was preserved`);
      assert.deepEqual(await store.lockState(), { present: true, pid: null, alive: null }, name);
      const report = await store.lockReport();
      assert.equal(report.alive, null, name);
      await assert.rejects(() => store.recover(), /the task lock holder cannot be identified; refusing recovery/, name);
    }
  });

  test('the summary queue refuses an unreadable claim and says nothing was changed', async () => {
    // Two shapes only: this protocol waits its full budget before refusing, so the timing is
    // asserted separately below rather than once per shape.
    for (const [name, body] of [CORRUPT_CLAIMS[7], CORRUPT_CLAIMS[2]]) {
      const dir = tempDir();
      const queue = new SummaryQueue(FILE.queue(dir), { now: CLOCK });
      fs.writeFileSync(LOCK.queue(dir), body);
      const failed = await queue.add({ sessionId: 'session-1', taskId: 'task-1', signature: SIGNATURE, text: 'a summary', verified: true })
        .then((value) => ({ unexpected: value }), (err) => err);
      assert.equal(failed.code, 'LOCKED', `${name}: ${JSON.stringify(failed)}`);
      assert.match(failed.message, /cannot update task-summary-queue\.json: it is in use by process unknown; nothing was changed/, name);
      assert.equal(fs.existsSync(FILE.queue(dir)), false, `${name}: the queue file was not written`);
      assert.equal(fs.readFileSync(LOCK.queue(dir), 'utf8'), body, `${name}: the unreadable claim was preserved`);
      const report = await queue.lockReport();
      assert.equal(report.pid, null, name);
      assert.equal(report.alive, null, name);
      await assert.rejects(() => queue.recover(), /the task summary queue lock holder cannot be identified; refusing recovery/, name);
    }
  });
});

describe('AF-16 2: each protocol waits exactly the budget it advertises', () => {
  test('the exported budgets are the ones the code uses', () => {
    assert.equal(WRITE_LOCK_WAIT_MS, 10000, 'the writer lock wait is the documented 10 s');
    assert.equal(WRITE_LOCK_RETRY_MIN_MS, 10);
    assert.equal(WRITE_LOCK_RETRY_MAX_MS, 250);
    assert.equal(LOCK_WAIT_MS, 2000, 'the queue wait is the documented 2 s');
    assert.equal(LOCK_RETRY_MS, 10);
    assert.equal(TAKEOVER_EPOCHS, 16, 'one bounded election per dead claim');
    assert.equal(MAX_QUEUED_SUMMARIES, 32);
    assert.equal(SUMMARIES_PER_DELIVERY, 4);
  });

  test('a writer waits its own bounded budget for a live holder, then refuses', async () => {
    const dir = tempDir();
    const body = claim(process.pid);
    fs.writeFileSync(LOCK.memory(dir), body);
    const lock = new WriterLock(FILE.memory(dir), { waitMs: 250 });
    const started = Date.now();
    const failed = await lock.run(async () => 'written').then((value) => ({ value }), (err) => err);
    const waited = Date.now() - started;
    assert.equal(failed.code, 'LOCKED');
    assert.match(failed.message, new RegExp(`it is in use by process ${process.pid}; nothing was written`), failed.message);
    assert.ok(waited >= 250, `the 250 ms budget was honoured, not skipped (${waited} ms)`);
    assert.ok(waited < 3000, `the wait is bounded (${waited} ms)`);
    assert.equal(fs.readFileSync(LOCK.memory(dir), 'utf8'), body, 'a refusal never removes a live holder claim');
  });

  test('a task run refuses immediately instead of waiting behind a live holder', async () => {
    const dir = tempDir();
    fs.writeFileSync(LOCK.task(dir), claim(process.pid));
    const store = new TaskStore(FILE.task(dir), { now: CLOCK });
    const started = Date.now();
    const failed = await store.withLock(async () => 'acquired').then((value) => ({ value }), (err) => err);
    const waited = Date.now() - started;
    assert.equal(failed.code, 'LOCKED');
    assert.match(failed.message, new RegExp(`tasks are in use by process ${process.pid}; try again when it finishes`), failed.message);
    assert.ok(waited < 1000, `the task protocol declines to wait at all (${waited} ms)`);
    assert.equal(fs.existsSync(FILE.task(dir)), false, 'the refused run wrote nothing');
  });

  test('a queue update waits its 2 s budget and then discloses that nothing changed', async () => {
    const dir = tempDir();
    fs.writeFileSync(LOCK.queue(dir), claim(process.pid));
    const queue = new SummaryQueue(FILE.queue(dir), { now: CLOCK });
    const started = Date.now();
    const failed = await queue.add({ sessionId: 'session-1', taskId: 'task-1', signature: SIGNATURE, text: 'a summary', verified: true })
      .then((value) => ({ value }), (err) => err);
    const waited = Date.now() - started;
    assert.equal(failed.code, 'LOCKED');
    assert.match(failed.message, new RegExp(`it is in use by process ${process.pid}; nothing was changed`), failed.message);
    assert.ok(waited >= LOCK_WAIT_MS, `the queue honoured its ${LOCK_WAIT_MS} ms budget (${waited} ms)`);
    assert.ok(waited < LOCK_WAIT_MS + 2000, `the queue gave up rather than spinning (${waited} ms)`);
    assert.equal(fs.existsSync(FILE.queue(dir)), false, 'the refused update left the queue absent');
  });
});

describe('AF-16 3: a claim that keeps vanishing exhausts the task lock', () => {
  test('three publication attempts, then an explicit refusal that deletes nothing', async () => {
    const dir = tempDir();
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [EXHAUST_CHILD, dir], { env: cleanEnv(), cwd: APP_ROOT, windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { out += d.toString(); });
      child.on('exit', (code) => resolve({ code, out }));
    });
    const line = run.out.split('\n').find((entry) => entry.startsWith('RESULT ')) || run.out;
    assert.match(line, /code=LOCKED/, run.out);
    assert.match(line, /could not acquire the task lock/, run.out);
    assert.match(line, /ran=false/, 'the protected work never started');
    assert.match(line, /reads=3/, 'the protocol stops after three publication attempts');
    assert.equal(run.code, 1, run.out);
    assert.equal(fs.readFileSync(LOCK.task(dir), 'utf8').includes('exhaust-fixture'), true, 'the claim the waiter could not read was left alone');
    assert.equal(fs.existsSync(FILE.task(dir)), false, 'nothing was appended');
    assert.deepEqual(leftovers(dir).filter((name) => name.endsWith('.tmp')), [], 'the waiter removed its own staging file');
  });
});

describe('AF-16 4: a foreign live process id is refused on liveness, then taken over', () => {
  test('another process number holds the claim closed while it runs and opens it once it has exited', async () => {
    const dir = tempDir();
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { env: cleanEnv(), cwd: APP_ROOT, windowsHide: true });
    holder.stdout.resume();
    holder.stderr.resume();
    const holderPid = holder.pid;
    const body = claim(holderPid, 'another process');
    fs.writeFileSync(LOCK.memory(dir), body);
    try {
      const store = new MemoryStore(FILE.memory(dir), { now: CLOCK, lockWaitMs: 120 });
      const failed = await store.add({ content: 'refused while the number is live' }).then((value) => ({ value }), (err) => err);
      assert.equal(failed.code, 'LOCKED', failed.message);
      assert.match(failed.message, new RegExp(`it is in use by process ${holderPid}; nothing was written`), failed.message);
      const report = await store.lockReport();
      assert.equal(report.alive, true, 'liveness of the number, not identity, is what closes the lock');

      const repaired = await runCli(['repair', 'locks'], envFor(dir));
      assert.equal(repaired.code, 1, repaired.stdout + repaired.stderr);
      assert.match(repaired.stderr, new RegExp(`Memory lock: not recovered: the memory\\.jsonl lock is held by live process ${holderPid}; refusing recovery`), repaired.stderr);
      assert.equal(fs.readFileSync(LOCK.memory(dir), 'utf8'), body, 'recovery displaced nobody');

      holder.kill();
      await new Promise((resolve) => holder.on('exit', resolve));
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill();
    }
    // The number is now free of the process that wrote it. The fixture rebinds the claim to the
    // stable dead pid, because Windows can hand the just-freed number to the next process.
    rebindDeadHolder(LOCK.memory(dir), holderPid);
    const store = new MemoryStore(FILE.memory(dir), { now: CLOCK, lockWaitMs: 4000 });
    const added = await store.add({ content: 'written after the holder exited' });
    assert.ok(added.id);
    const records = readLines(FILE.memory(dir)).map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].content, 'written after the holder exited');
    assert.deepEqual(leftovers(dir), [], 'the takeover released its own claim');
  });

  test('one repair run refuses every namespace whose claim names a live process and deletes nothing', async () => {
    const dir = tempDir();
    const bodies = {};
    for (const namespace of ALL_NAMESPACES) {
      bodies[namespace] = claim(process.pid, `live-${namespace}`);
      fs.writeFileSync(LOCK[namespace](dir), bodies[namespace]);
    }
    const res = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    const expectations = [
      ['Task lock', 'task'],
      ['Summary queue lock', 'task summary queue'],
      ['Memory lock', 'memory.jsonl'],
      ['Knowledge lock', 'knowledge.jsonl'],
      ['Experience lock', 'experiences.jsonl'],
      ['Prediction lock', 'predictions.jsonl'],
    ];
    for (const [label, inner] of expectations) {
      assert.match(
        res.stderr,
        new RegExp(`${label}: not recovered: the ${inner.replace(/\./g, '\\.')} lock is held by live process ${process.pid}; refusing recovery`),
        `${label} should refuse and say why: ${res.stderr}`,
      );
    }
    assert.match(res.stderr, /Recovery did not complete\. No live holder or takeover was displaced, and no lock claim was deleted\./, res.stderr);
    for (const namespace of ALL_NAMESPACES) {
      assert.equal(fs.readFileSync(LOCK[namespace](dir), 'utf8'), bodies[namespace], `${namespace}: its claim survived the refused run`);
    }
    assert.deepEqual(leftovers(dir).filter((name) => !name.endsWith('.lock')), [], 'no token or guard was created by a refused recovery');

    // With the claims gone, every store is writable again: the refusals described the claims, not damage.
    fs.rmSync(LOCK.memory(dir));
    fs.rmSync(LOCK.knowledge(dir));
    fs.rmSync(LOCK.experience(dir));
    fs.rmSync(LOCK.prediction(dir));
    fs.rmSync(LOCK.task(dir));
    fs.rmSync(LOCK.queue(dir));
    const app = createApp({ dataDir: dir, now: CLOCK });
    assert.ok((await app.memory.add({ content: 'memory is writable again' })).id);
    assert.ok((await app.knowledge.add({ subject: 'the launch code name', relationship: 'is', object: 'Falcon', origin: 'user' })).record.id);
    assert.equal(await app.taskStore.withLock(async () => 'task ran'), 'task ran');
    assert.equal((await app.summaryQueue.add({ sessionId: 's', taskId: 't', signature: SIGNATURE, text: 'a summary', verified: true })).queued, true);
    assert.deepEqual(leftovers(dir), [], 'each protocol released exactly its own claim');
  });
});

describe('AF-16 5: lost ownership is reported only where the record is already durable', () => {
  test('a claim removed before release is reported as a write that happened', async () => {
    const dir = tempDir();
    const store = new MemoryStore(FILE.memory(dir), { now: CLOCK });
    const realAppend = store.log.append.bind(store.log);
    store.log.append = async (record) => {
      await realAppend(record);
      fs.rmSync(LOCK.memory(dir), { force: true }); // somebody else cleared our claim after the append
    };
    const failed = await store.add({ content: 'the record is already durable' }).then(() => null, (err) => err);
    store.log.append = realAppend;
    assert.equal(failed.code, 'LOCK_LOST', 'a post-append ownership failure is not a refusal');
    assert.match(failed.message, /the claim is gone before it could be removed/, failed.message);
    assert.match(failed.message, /The record was written, so do not repeat the write/, failed.message);
    assert.doesNotMatch(failed.message, /nothing was written/, 'and it never claims that nothing happened');
    const records = readLines(FILE.memory(dir)).map((line) => JSON.parse(line));
    assert.equal(records.length, 1, 'the record the store reported as written really is on disk');
    assert.equal(records[0].content, 'the record is already durable');
  });

  test('a claim that cannot be read at release is reported as a write that happened', async () => {
    const dir = tempDir();
    const store = new MemoryStore(FILE.memory(dir), { now: CLOCK });
    const realAppend = store.log.append.bind(store.log);
    store.log.append = async (record) => {
      await realAppend(record);
      fs.rmSync(LOCK.memory(dir), { force: true });
      fs.mkdirSync(LOCK.memory(dir)); // the claim path is no longer a file the reader can open
    };
    const failed = await store.add({ content: 'durable while the claim was unreadable' }).then(() => null, (err) => err);
    store.log.append = realAppend;
    assert.equal(failed.code, 'LOCK_LOST');
    assert.match(failed.message, /the claim cannot be read \(/, failed.message);
    assert.match(failed.message, /The record was written, so do not repeat the write/, failed.message);
    assert.doesNotMatch(failed.message, /nothing was written/, 'and it never claims that nothing happened');
    const records = readLines(FILE.memory(dir)).map((line) => JSON.parse(line));
    assert.equal(records.length, 1, 'the record survives an unreadable claim');
    assert.equal(records[0].content, 'durable while the claim was unreadable');
    fs.rmSync(LOCK.memory(dir), { recursive: true, force: true });
  });
});

describe('AF-16 6: what a task or queue release does with a claim it cannot prove', () => {
  test('the task lock removes only its own claim and reports no lost ownership', async () => {
    const dir = tempDir();
    const store = new TaskStore(FILE.task(dir), { now: CLOCK });
    const foreign = claim(deadPid(), 'a claim that is not ours');
    const value = await store.withLock(async () => {
      fs.writeFileSync(LOCK.task(dir), foreign); // hand-edited or externally replaced mid-run
      return 'ran';
    });
    assert.equal(value, 'ran', 'the run itself completed under a section it opened');
    assert.equal(fs.readFileSync(LOCK.task(dir), 'utf8'), foreign, 'the release left a claim it could not prove was its own');
    assert.deepEqual(await store.lockState(), { present: true, pid: deadPid(), alive: false }, 'the surviving claim is a dead holder the next run takes over');
    assert.equal(await store.withLock(async () => 'ran again'), 'ran again', 'the next run takes it over');
    assert.equal(fs.existsSync(LOCK.task(dir)), false, 'and releases its own claim');
  });

  test('the queue removes only its own claim and reports no lost ownership', async () => {
    const dir = tempDir();
    const queue = new SummaryQueue(FILE.queue(dir), { now: CLOCK });
    const lockPath = LOCK.queue(dir);
    const foreign = claim(deadPid(), 'a claim that is not ours');
    const realReadFile = fs.promises.readFile.bind(fs.promises);
    let patched = false;
    fs.promises.readFile = async (file, ...rest) => {
      if (!patched && file === lockPath) {
        patched = true;
        fs.writeFileSync(lockPath, foreign); // the claim is no longer the queue's own at release time
        return foreign;
      }
      return realReadFile(file, ...rest);
    };
    let result;
    try {
      result = await queue.add({ sessionId: 'session-1', taskId: 'task-1', signature: SIGNATURE, text: 'a summary', verified: true });
    } finally {
      fs.promises.readFile = realReadFile;
    }
    assert.equal(result.queued, true, 'the queue update completed inside its own section');
    assert.equal(patched, true, 'the release really did read a foreign claim');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), foreign, 'the release left the foreign claim in place');
    assert.equal(fs.existsSync(FILE.queue(dir)), true, 'the entry it wrote is on disk');
    // The claim it left behind names a process that is not running, so recovery reports
    // nothing to clean and the next queue update takes the claim over normally.
    const recovery = await queue.recover();
    assert.equal(recovery.recovered, false);
    assert.equal(recovery.reason, 'no-abandoned-tokens');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), foreign, 'recovery removed no claim');
    const second = await queue.add({ sessionId: 'session-1', taskId: 'task-2', signature: SIGNATURE, text: 'a later summary', verified: true });
    assert.equal(second.queued, true, 'the surviving claim is taken over by the next update');
    assert.equal(fs.existsSync(lockPath), false, 'and the new claim was released');
    const entries = JSON.parse(fs.readFileSync(FILE.queue(dir), 'utf8')).entries;
    assert.deepEqual(entries.map((entry) => entry.taskId), ['task-1', 'task-2'], 'both queue updates are recorded');
  });
});

describe('AF-16 7: a staging file another process left behind is inert', () => {
  test('neither the election, a normal write, nor recovery adopts or deletes it', async () => {
    const dir = tempDir();
    const stale = claim(deadPid(), 'a writer that exited mid-staging');
    const staged = `${LOCK.memory(dir)}.${deadPid()}.${randomUUID()}.tmp`;
    // A token for a *different* claim: token names carry the digest of the claim they were elected
    // against, so this one is only residue - it can neither block nor be adopted by an election on
    // the claim planted below.
    const otherClaim = claim(deadPid(), 'a claim that has already been taken over');
    const foreignToken = `${LOCK.memory(dir)}.takeover.${keyOf(otherClaim)}.7`;
    fs.writeFileSync(staged, stale);
    fs.writeFileSync(foreignToken, stale);
    const raw = claim(deadPid(), 'dead-claim');
    fs.writeFileSync(LOCK.memory(dir), raw);

    const report = await new MemoryStore(FILE.memory(dir), { now: CLOCK }).lockReport();
    assert.equal(report.tokens.total, 1, 'a token for another claim is visible as residue');
    assert.equal(report.tokens.current, 0, 'but it is not a takeover of this claim, so it cannot block or be adopted');

    const repaired = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr);
    assert.match(repaired.stdout, /Memory lock: present;.*takeover tokens 1 recorded \(0 for this claim: 0 dead, 0 live, 0 unidentified\)/, repaired.stdout);
    assert.match(repaired.stdout, /Memory lock: no abandoned takeover tokens for this claim; the claim was left for the next normal run to take over/, repaired.stdout);
    assert.equal(fs.readFileSync(staged, 'utf8'), stale, 'repair locks did not touch the staged claim body');
    assert.equal(fs.readFileSync(foreignToken, 'utf8'), stale, 'repair locks did not touch the token for the other claim');
    assert.equal(fs.readFileSync(LOCK.memory(dir), 'utf8'), raw, 'and it removed no claim');

    const store = new MemoryStore(FILE.memory(dir), { now: CLOCK, lockWaitMs: 5000 });
    const added = await store.add({ content: 'written after the dead holder' });
    assert.ok(added.id, 'the dead claim was taken over through the ordinary election');
    assert.equal(fs.readFileSync(staged, 'utf8'), stale, 'the writer never adopted another process staging file as its claim');
    assert.equal(fs.readFileSync(foreignToken, 'utf8'), stale, 'nor did it treat another claim token as its own');
    assert.equal(fs.existsSync(LOCK.memory(dir)), false, 'its own claim was released');
    assert.deepEqual(
      leftovers(dir),
      [path.basename(staged), path.basename(foreignToken)].sort(),
      'the only residue is the two files this fixture planted, which no protocol claims or removes',
    );
  });
});

describe('AF-16 8: simultaneous recovery over all six namespaces', () => {
  test('two repair runs remove the abandoned tokens once and never a claim', async () => {
    const dir = tempDir();
    const bodies = {};
    const tokens = [];
    for (const namespace of ALL_NAMESPACES) {
      bodies[namespace] = claim(deadPid(), `dead-${namespace}`);
      fs.writeFileSync(LOCK[namespace](dir), bodies[namespace]);
      tokens.push(...writeTokens(LOCK[namespace](dir), bodies[namespace]));
    }
    const results = await Promise.all([
      runCli(['repair', 'locks'], envFor(dir)),
      runCli(['repair', 'locks'], envFor(dir)),
    ]);
    const both = results.map((res) => `${res.stdout}${res.stderr}`).join('');
    for (const res of results) {
      assert.ok(res.code === 0 || res.code === 1, res.stdout + res.stderr);
      // The only refusal a simultaneous recovery may report is that another recovery holds the
      // guard. Anything else would mean the two runs disagreed about the state they were reading.
      for (const line of res.stderr.split('\n').filter((entry) => entry.includes('not recovered'))) {
        assert.match(line, /already in progress|unfinished recovery claim/, line);
      }
    }
    // Serialisation is the property: for each namespace exactly one run may report removing the
    // tokens. Two runs reporting it for one claim would mean both believed they owned the cleanup.
    const labels = ['Task lock', 'Summary queue lock', 'Memory lock', 'Knowledge lock', 'Experience lock', 'Prediction lock'];
    for (const label of labels) {
      const cleaned = (both.match(new RegExp(`${label}: removed ${TAKEOVER_EPOCHS} abandoned takeover token\\(s\\)`, 'g')) || []).length;
      assert.equal(cleaned, 1, `${label} should be reported cleaned by exactly one of the two runs: ${both}`);
    }
    for (const token of tokens) assert.equal(fs.existsSync(token), false, 'every abandoned token is gone');
    for (const namespace of ALL_NAMESPACES) {
      assert.equal(fs.readFileSync(LOCK[namespace](dir), 'utf8'), bodies[namespace], `${namespace}: its claim was never removed by recovery`);
      assert.equal(fs.existsSync(`${LOCK[namespace](dir)}.recover`), false, `${namespace}: no recovery guard was left behind`);
    }
    assert.deepEqual(leftovers(dir), ALL_NAMESPACES.map((namespace) => `${path.basename(FILE[namespace](dir))}.lock`).sort(), 'only the six claims remain');
  });

  test('a dead claim in every namespace is taken over by one normal write each', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK });
    const seeded = await app.controller.handle('remember that the pinned fixture note is held', { origin: 'user' });
    assert.equal(seeded.operation.status, 'success_verified', seeded.display ?? seeded.output);
    for (const namespace of ALL_NAMESPACES) {
      fs.writeFileSync(LOCK[namespace](dir), claim(deadPid(), `stale-${namespace}`));
    }
    assert.ok((await app.memory.add({ content: 'memory took over' })).id);
    assert.ok((await app.knowledge.add({ subject: 'the pinned code name', relationship: 'is', object: 'Falcon', origin: 'user' })).record.id);
    assert.ok((await app.experience.recordExperience({ operationId: seeded.operation.id, subject: 'the pinned event', origin: 'user' })).record.id);
    assert.ok((await app.predictions.recordPrediction({
      capability: 'memory.add', expectation: 'success', subject: 'the pinned expectation',
      expiresAt: new Date(CLOCK().getTime() + 30 * DAY).toISOString(), origin: 'user',
    })).record.id);
    assert.equal(await app.taskStore.withLock(async () => 'task took over'), 'task took over');
    assert.equal((await app.summaryQueue.add({ sessionId: 's', taskId: 't', signature: SIGNATURE, text: 'a summary', verified: true })).queued, true);
    assert.deepEqual(leftovers(dir), [], 'no claim, token, guard or staging file survived the six takeovers');
  });
});
