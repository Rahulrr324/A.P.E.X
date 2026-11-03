// Batch AF (AF-17): corruption and recovery boundaries.
//
// The rule this suite pins is the one the batch states: a damaged store must never be presented
// as an empty store, and recovery must be explicit - no command may delete or rewrite evidence it
// could not read. The existing damage suites (`storage-integrity`, `store-recovery-acceptance`,
// `finalization-interruption`) walk damage store by store. These tests walk it the other way:
// every persistent store in one data directory is damaged at once, and each user-facing surface is
// asked what it says about each store. Then the same directory is re-hashed to prove that reading
// it, diagnosing it, refusing on it, and running lock recovery over it changed no byte of evidence.
//
// Damage is installed by writing bytes directly to the store files - that is what a torn append,
// a hand edit, or a failing disk looks like to a reader - and it is always a malformed line or an
// unsupported schema, never a repairable shape. Every directory is under the OS temporary
// directory, the home directory of the child processes is pinned inside it, and no model runs.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makeTempDataDir, cleanup, cleanEnv, runCli } from './helpers.js';
import { ConversationStore, TURN_ORIGINS } from '../src/memory/conversation-store.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { OperationLog } from '../src/operations/operation-log.js';
import { Outcome } from '../src/outcomes.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function envFor(dir) {
  return cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
}

const JSONL_STORES = Object.freeze([
  'memory.jsonl', 'knowledge.jsonl', 'experiences.jsonl', 'predictions.jsonl',
  'operations.jsonl', 'conversation.jsonl', 'tasks.jsonl',
]);
const WHOLE_FILE_STORES = Object.freeze(['task-summary-queue.json', 'session.json']);

// A damaged line for each reader's own integrity rules: the JSONL stores get either an
// unparseable line or a line that parses but names a schema this build cannot read, and the
// single-document stores get a truncated document.
function damageLine(name) {
  return name === 'memory.jsonl' || name === 'tasks.jsonl'
    ? '{"schema":99,"id":"af17-future-record"}\n'
    : '{"schema":1,"this is not valid json\n';
}

async function seed(dir) {
  const env = envFor(dir);
  const steps = [
    ['ask', 'remember that the af17 marker is 7301'],
    ['knowledge', 'add', '--subject', 'af17-subject', '--relationship', 'relates-to', '--object', 'af17-object'],
  ];
  for (const args of steps) {
    const res = await runCli(args, env);
    assert.equal(res.code, 0, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
  }
  const operations = readLines(path.join(dir, 'operations.jsonl')).map((line) => JSON.parse(line));
  const addOp = operations.find((op) => op.capability === 'memory.add');
  assert.ok(addOp, 'the memory.add operation was audited');
  const recorded = await runCli(['experience', 'record', addOp.id, '--subject', 'the af17 review date'], env);
  assert.equal(recorded.code, 0, `${recorded.stdout}${recorded.stderr}`);
  const predicted = await runCli(
    ['prediction', 'record', '--capability', 'memory.add', '--expect', 'success', '--subject', 'af17-subject', '--in-days', '1'],
    env,
  );
  assert.equal(predicted.code, 0, `${predicted.stdout}${predicted.stderr}`);
  const planned = await runCli(['task', 'plan', 'calc 1+1; calc 2+2'], env);
  assert.equal(planned.code, 0, `${planned.stdout}${planned.stderr}`);
  for (const name of [...JSONL_STORES, 'session.json']) {
    assert.ok(fs.existsSync(path.join(dir, name)), `seeding created ${name}`);
  }
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function hashAll(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (!fs.statSync(p).isFile()) continue;
    out[name] = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
  return out;
}

// The directory's files as bytes, so a later check can prove the same bytes are still the first
// bytes of the same file. A hash alone cannot distinguish "unchanged" from "rewritten from scratch".
function bytesAll(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (!fs.statSync(p).isFile()) continue;
    out[name] = fs.readFileSync(p);
  }
  return out;
}

function damageEverything(dir) {
  for (const name of JSONL_STORES) fs.appendFileSync(path.join(dir, name), damageLine(name));
  fs.writeFileSync(path.join(dir, 'task-summary-queue.json'), '{"schema":7,"entries":"not an array"}\n');
  fs.writeFileSync(path.join(dir, 'session.json'), '{"sessionId":');
}

describe('AF-17: a wholly damaged data directory is reported as damaged by every surface', () => {
  test('each store keeps its readable records, names its damage, and is never called empty', async () => {
    const dir = tempDir();
    await seed(dir);
    damageEverything(dir);
    const before = bytesAll(dir);

    const surfaces = [
      ['status'],
      ['diagnose'],
      ['memory', 'health'],
      ['knowledge', 'health'],
      ['experience', 'health'],
      ['prediction', 'health'],
      ['audit', 'health'],
      ['world'],
      ['history'],
      ['queue'],
      ['knowledge', 'list'],
      ['knowledge', 'search', 'af17-subject'],
      ['experience', 'list'],
      ['prediction', 'list'],
      ['task', 'list'],
      ['adaptation', 'list'],
      ['repair', 'locks'],
      ['ask', 'what is the af17 marker'],
    ];
    const seen = new Map();
    for (const args of surfaces) {
      const res = await runCli(args, envFor(dir));
      seen.set(args.join(' '), { ...res, all: `${res.stdout}${res.stderr}` });
    }

    // 1. The summary surface reports the damage of every store it counts, with the readable count
    //    still in front of it. A count of zero with no damage note would be the false-empty claim.
    const status = seen.get('status');
    assert.equal(status.code, 1, 'a damaged store is not a healthy run');
    for (const [label, count] of [
      ['Memory records', 1],
      ['Conversation turns', 2],
      ['Operation records', 5],
      ['Experiences', 1],
      ['Predictions', 1],
    ]) {
      const line = status.stdout.split('\n').find((l) => l.startsWith(`${label}:`));
      assert.ok(line, `status reports ${label}:\n${status.stdout}`);
      assert.ok(Number(line.match(/\d+/)[0]) >= count, `${line} keeps the records that are readable`);
      assert.match(line, /corrupt lines skipped: 1/, `${line} counts the damaged line`);
    }
    assert.match(status.stdout, /Deferred task summaries: corrupt/);
    assert.match(status.stdout, /Session: corrupt/);
    assert.match(status.stdout, /Integrity: attention required/);
    assert.equal(/: 0 \(/.test(status.stdout), false, 'no store is reported as holding nothing');

    // 2. The detailed report names each damaged file and the line that is damaged, and says what
    //    it cannot establish because of it.
    const diag = seen.get('diagnose');
    assert.equal(diag.code, 1);
    for (const label of ['Session', 'Conversation', 'Memory', 'Knowledge', 'Experience', 'Predictions', 'Tasks', 'Audit', 'Queue']) {
      assert.match(diag.stdout, new RegExp(`  ${label}: (corrupt|unavailable)`), `${label} is not reported as ok or missing`);
    }
    for (const name of JSONL_STORES) assert.ok(diag.stdout.includes(`${name}: line`), `${name} is reported by line`);
    assert.match(diag.stdout, /Recovery guidance/);
    assert.match(diag.stdout, /do not prove exactly-once execution/);

    // 3. Every health command says its inspection is incomplete and keeps its readable counts. The
    //    prediction ledger is the exception by design: a line that does not parse can hide a
    //    lifecycle record, so that surface reports no counts at all rather than partial ones.
    for (const args of [['memory', 'health'], ['knowledge', 'health'], ['experience', 'health'], ['audit', 'health']]) {
      const res = seen.get(args.join(' '));
      assert.equal(res.code, 1, `${args.join(' ')} is attention, not ok:\n${res.all}`);
      assert.match(res.all, /damaged - 1 corrupt line\(s\); inspection incomplete/);
      assert.match(res.all, /Corrupt lines:\s+1/);
      assert.match(res.all, /incomplete/i);
    }
    const predictionHealth = seen.get('prediction health');
    assert.equal(predictionHealth.code, 1, predictionHealth.all);
    assert.match(predictionHealth.all, /Ledger:\s+damaged - 1 corrupt line\(s\); inspection incomplete/);
    assert.match(predictionHealth.all, /no lifecycle state, verdict, or count can be established/);
    assert.match(predictionHealth.all, /the bytes are preserved/);
    assert.equal(/Corrupt lines:/.test(predictionHealth.all), false, 'the ledger surface reports no counts it cannot establish');

    // 4. A read that needs the whole log refuses instead of answering from what survived: it names
    //    its own store and the damaged line, and records its own refusal in the audit log. There is
    //    no `memory search` command - memory retrieval happens inside a request, which item 7 covers.
    for (const [label, store] of [
      ['knowledge list', 'knowledge'],
      ['knowledge search af17-subject', 'knowledge'],
      ['experience list', 'experience'],
      ['adaptation list', 'experience'],
      ['prediction list', 'prediction'],
    ]) {
      const res = seen.get(label);
      assert.equal(res.code, 1, `${label}: ${res.all}`);
      assert.match(res.all, new RegExp(`${store} store contains 1 corrupt line\\(s\\); refusing an incomplete`), `${label} names the damage`);
      assert.match(res.all, /Audit:\s+recorded in operations\.jsonl/, `${label} audited its own refusal`);
    }
    const listed = seen.get('task list');
    assert.equal(listed.code, 1, listed.all);
    assert.match(listed.stderr, /task log contains 1 corrupt line\(s\); refusing incomplete task state/);
    assert.match(listed.stderr, /No file was changed/, 'the task refusal says nothing was changed');

    // 5. The audit list is the one reader that keeps working over damage, so it has to say it is
    //    incomplete and that a missing record proves nothing.
    const history = seen.get('history');
    assert.equal(history.code, 0, history.all);
    assert.match(history.stdout, /\(1 corrupt audit line\(s\) skipped\)/);
    assert.match(history.stdout, /A missing record does not prove an action did not execute/);
    assert.ok(history.stdout.includes('success_verified'), 'the readable audit records are still listed');

    // 6. The projection reports damaged sources rather than an empty world.
    const world = seen.get('world');
    assert.match(world.stdout, /Sources:\s+memory: damaged - 1 corrupt line\(s\); incomplete \| knowledge: damaged/);
    assert.match(world.stdout, /Temporal:\s+unavailable/);
    assert.match(world.stdout, /Expectations:\s+unavailable/);
    assert.match(world.stdout, /Unknowns:/);
    assert.ok(/Beliefs:\s+\d+ user-asserted/.test(world.stdout), 'the projection still prints its own explicit counts');

    // 7. The request path refuses to answer from context it cannot check, and the queue reports
    //    itself unavailable without touching its bytes.
    const asked = seen.get('ask what is the af17 marker');
    assert.equal(asked.code, 1, asked.all);
    assert.match(asked.stdout, /did not generate an answer because stored context could not be checked/);
    assert.match(asked.stdout, /Status:\s+execution_failed/);
    const queue = seen.get('queue');
    assert.equal(queue.code, 1, queue.all);
    assert.match(queue.stderr, /Queue: unavailable \(task-summary-queue\.json is corrupt/);
    assert.match(queue.stderr, /No entry was read or changed\. Preserve task-summary-queue\.json; there is no supported repair command/);

    // 8. Recovery of locks is not repair of data: `repair locks` changed nothing here, because no
    //    lock is evidence and no damaged line is a lock.
    const repaired = seen.get('repair locks');
    assert.equal(repaired.code, 0, repaired.all);
    assert.match(repaired.stdout, /Memory lock: no lock file; nothing to recover/);

    // 9. Reading, diagnosing, refusing on, and running lock recovery over this directory rewrote no
    //    evidence: every file that existed before still begins with exactly the bytes it held, and
    //    only the audit log grew (a refusal that is audited is new evidence, not changed evidence).
    //    Nothing was left behind that could look like a lock.
    for (const name of Object.keys(before)) {
      const after = fs.readFileSync(path.join(dir, name));
      assert.ok(
        after.subarray(0, before[name].length).equals(before[name]),
        `${name} was rewritten or truncated by a surface that should only have read it`,
      );
      if (name !== 'operations.jsonl') {
        assert.equal(after.length, before[name].length, `${name} was not even appended to`);
      }
    }
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.lock') || name.endsWith('.tmp')),
      [],
      'no lock or staged temp file survived the sweep',
    );
  });

  test('the status headline still says attention when only the task log is damaged', async () => {
    // `status` prints per-store counts for six stores and never for the task log, so a damaged
    // task log could otherwise pass unmentioned. It is not: the headline is computed from the same
    // read-only report `diagnose` prints, and that report covers the task log.
    const dir = tempDir();
    await seed(dir);
    fs.appendFileSync(path.join(dir, 'tasks.jsonl'), damageLine('tasks.jsonl'));
    const before = hashAll(dir);

    const status = await runCli(['status'], envFor(dir));
    assert.equal(status.code, 1, status.stdout + status.stderr);
    assert.match(status.stdout, /Integrity: attention required/);
    assert.equal(status.stdout.includes('Tasks:'), false, 'status reports no task count, which is why the headline is checked here');

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.match(diag.stdout, /Tasks: corrupt \(1 readable event\(s\), 1 recoverable task\(s\), 1 corrupt line\(s\)/);
    assert.match(diag.stdout, /tasks\.jsonl: line \d+: unsupported schema/);

    const listed = await runCli(['task', 'list'], envFor(dir));
    assert.equal(listed.code, 1);
    assert.match(listed.stderr, /task log contains 1 corrupt line\(s\); refusing incomplete task state/);
    assert.match(listed.stderr, /there is no supported automatic repair for this store/);
    assert.deepEqual(hashAll(dir), before, 'the task log kept the damaged line and every other byte');
  });

  test('the unreadable stores are unavailable, and a directory in a file path is never empty', async () => {
    const dir = tempDir();
    await seed(dir);
    for (const name of ['memory.jsonl', 'knowledge.jsonl', 'experiences.jsonl', 'predictions.jsonl', 'tasks.jsonl']) {
      const file = path.join(dir, name);
      fs.rmSync(file);
      fs.mkdirSync(file);
      fs.writeFileSync(path.join(file, 'inside.txt'), 'not a store');
    }
    const diag = await runCli(['diagnose'], envFor(dir));
    for (const label of ['Memory', 'Knowledge', 'Experience', 'Predictions', 'Tasks']) {
      assert.match(diag.stdout, new RegExp(`  ${label}: unavailable`), `${label} is unavailable, not empty:\n${diag.stdout}`);
    }
    const listed = await runCli(['knowledge', 'list'], envFor(dir));
    assert.equal(listed.code, 1);
    assert.match(`${listed.stdout}${listed.stderr}`, /EISDIR|not a file|cannot read/i);
    for (const name of ['memory.jsonl', 'knowledge.jsonl', 'experiences.jsonl', 'predictions.jsonl', 'tasks.jsonl']) {
      assert.deepEqual(fs.readdirSync(path.join(dir, name)), ['inside.txt'], `${name} was not read as an empty store or replaced`);
    }
    // The store class itself is the last line of this claim: an unreadable path is an error, and
    // never an empty record list, because an empty list is what a healthy-but-empty store returns.
    await assert.rejects(() => new MemoryStore(path.join(dir, 'memory.jsonl')).status(), /cannot read memory\.jsonl/);
  });
});

describe('AF-17: interrupted appends and refusal to extend damage', () => {
  test('a torn final line in the audit log stays residue, and the next append starts on a fresh line', async () => {
    const dir = tempDir();
    await seed(dir);
    const file = path.join(dir, 'operations.jsonl');
    fs.appendFileSync(file, '{"schema":1,"id":"af17-torn-');
    const residueBytes = fs.readFileSync(file);

    const log = new OperationLog(file);
    const view = await log.inspect();
    assert.equal(view.corrupt.length, 1, 'the torn tail is damage, not a record');
    assert.equal(view.corrupt[0].truncatedTail, true, 'and it is distinguishable as trailing residue');

    const asked = await runCli(['ask', 'remember that the af17 marker is 7305'], envFor(dir));
    assert.equal(asked.code, 0, asked.stdout + asked.stderr);
    const lines = readLines(file);
    assert.ok(lines.some((line) => line === '{"schema":1,"id":"af17-torn-'), 'the torn bytes stayed exactly where they were');
    assert.ok(lines.filter((line) => line.startsWith('{"schema":1,"id":"af17-torn-')).length === 1, 'the next record did not merge into the fragment');
    const parsed = lines.filter((line) => line !== '{"schema":1,"id":"af17-torn-').map((line) => JSON.parse(line));
    assert.equal(parsed.at(-1).capability, 'memory.add', 'the record after the residue is a whole record');
    assert.equal((await new OperationLog(file).status()).corrupt, 1, 'and it is still reported as one damaged line');
    assert.ok(fs.readFileSync(file).subarray(0, residueBytes.length).equals(residueBytes), 'the append extended the file, it did not rewrite or drop the residue');
  });

  test('a torn final line in the task log is refused, and a task write does not extend it', async () => {
    const dir = tempDir();
    await seed(dir);
    const file = path.join(dir, 'tasks.jsonl');
    const before = fs.readFileSync(file);
    fs.appendFileSync(file, '{"schema":1,"eventId":"af17-torn');
    const bytesBefore = fs.readFileSync(file);

    const planned = await runCli(['task', 'plan', 'calc 5+5'], envFor(dir));
    assert.equal(planned.code, 1, `${planned.stdout}${planned.stderr}`);
    assert.match(`${planned.stdout}${planned.stderr}`, /task log contains 1 corrupt line\(s\); refusing incomplete task state/);
    assert.deepEqual(fs.readFileSync(file), bytesBefore, 'the refused write left the task log byte-identical');
    assert.ok(fs.readFileSync(file, 'utf8').startsWith(before.toString()), 'the earlier events are still there');
  });

  test('a damaged store refuses to be extended, discloses it, and still audits its own refusal', async () => {
    const dir = tempDir();
    await seed(dir);
    fs.appendFileSync(path.join(dir, 'memory.jsonl'), damageLine('memory.jsonl'));
    const before = hashAll(dir);
    const opsBefore = readLines(path.join(dir, 'operations.jsonl')).length;

    const added = await runCli(['ask', 'remember that the af17 marker is 7303'], envFor(dir));
    assert.equal(added.code, 1, added.stdout + added.stderr);
    assert.match(added.stdout, /memory store contains 1 corrupt line\(s\); refusing incomplete write/);
    assert.match(added.stdout, /a stored data file is damaged, so this step was refused before it ran/);
    assert.deepEqual(hashAll(dir)['memory.jsonl'], before['memory.jsonl'], 'the damaged memory log was not extended');
    const ops = readLines(path.join(dir, 'operations.jsonl')).map((line) => JSON.parse(line));
    assert.equal(ops.length, opsBefore + 1, 'the refusal is itself evidence in the audit log');
    assert.equal(ops.at(-1).status, Outcome.EXECUTION_FAILED, 'and is recorded as a failure, not as a stored fact');
  });
});

describe('AF-17: the conversation store refuses to answer from damaged history', () => {
  const turn = (text) => ({
    schema: 1,
    id: `af17-${text}`,
    sessionId: 'af17-session',
    role: 'user',
    origin: TURN_ORIGINS.USER,
    text,
    verified: false,
    operationId: null,
    taskId: null,
    signature: null,
    createdAt: new Date().toISOString(),
  });

  test('replay, duplicate checking and counting all refuse; status reports the damage', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'conversation.jsonl');
    const store = new ConversationStore(file);
    await store.append(turn('first'));
    await store.append(turn('second'));
    fs.appendFileSync(file, '{"schema":1,"broken\n');
    const bytes = fs.readFileSync(file);

    await assert.rejects(() => store.recent('af17-session', 6), /conversation store contains 1 corrupt line\(s\); refusing incomplete history/);
    await assert.rejects(
      () => store.summarisedTaskStates('af17-session', 'task-1'),
      /cannot check for an existing task summary/,
    );
    // AF-17 hardening: a count is a presentation of the store too. It used to return the readable
    // turns and drop the damage, which is exactly how a damaged history looks like a shorter one.
    await assert.rejects(() => store.countForSession('af17-session'), /refusing to count an incomplete history/);
    assert.deepEqual(await store.status(), { turns: 2, corrupt: 1 }, 'the operational view keeps both numbers');
    assert.deepEqual(fs.readFileSync(file), bytes, 'every refusal left the damaged history byte-identical');
  });

  test('damage does not stop a turn being appended, and the request records the history gap', async () => {
    const dir = tempDir();
    await seed(dir);
    const file = path.join(dir, 'conversation.jsonl');
    fs.appendFileSync(file, '{"schema":1,"broken\n');
    const before = readLines(file);

    const asked = await runCli(['ask', 'hello'], envFor(dir));
    // The reply needs history this session cannot reconstruct, so the run reports that no answer
    // was produced instead of answering from the part it could read.
    assert.equal(asked.code, 1, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /Status:\s+model_unavailable/);
    const ops = readLines(path.join(dir, 'operations.jsonl')).map((line) => JSON.parse(line));
    const gap = ops.at(-1).errors.find((e) => e.stage === 'context');
    assert.ok(gap, `the request audited that its conversation context could not be read: ${JSON.stringify(ops.at(-1).errors)}`);
    assert.match(gap.message, /conversation store contains 1 corrupt line\(s\); refusing incomplete history/);
    const after = readLines(file);
    assert.ok(after.length > before.length, 'a damaged history is still appended to rather than replaced');
    assert.deepEqual(after.slice(0, before.length), before, 'including every damaged line that was already there');
  });
});
