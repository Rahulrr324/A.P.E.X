// Batch F / 066: JSONL integrity, corruption reporting, and crash recovery.
//
// The stores are append-only JSON Lines. This suite holds the boundary the design
// promises: a missing file is an empty store; a damaged line is counted and preserved,
// never treated as absence and never rewritten; reads and writes that depend on a
// complete store fail closed; an append reports success only when the whole record was
// accepted. Two reporting gaps were fixed alongside these tests: status now prints the
// skipped-line count for conversation and audit records the way it already did for
// memory, and a failed append says when bytes may already be present instead of
// implying the store is unchanged.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempDataDir, cleanup, runCli, cleanEnv, APP_ROOT } from './helpers.js';
import { JsonlStore } from '../src/memory/jsonl-store.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { KnowledgeStore } from '../src/knowledge/knowledge-store.js';
import { ConversationStore, TURN_ORIGINS } from '../src/memory/conversation-store.js';
import { OperationLog } from '../src/operations/operation-log.js';
import { TaskStore } from '../src/tasks/store.js';
import { SummaryQueue } from '../src/tasks/summary-queue.js';
import { StoreError } from '../src/errors.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }
const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'partial-write-child.mjs');

function envFor(dataDir) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
}

// A real process appends the bytes without the terminating newline and exits abruptly.
function crashWithPartialLine(file, text) {
  const r = spawnSync(process.execPath, [CHILD, file, text, '9'], { windowsHide: true });
  assert.equal(r.status, 9, `the crash fixture did not exit as expected: ${r.error?.message ?? r.status}`);
}

function turn(sessionId = 's1') {
  return {
    schema: 1,
    id: 't1',
    sessionId,
    role: 'user',
    origin: TURN_ORIGINS.USER,
    text: 'earlier turn',
    verified: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('066: absence and emptiness are not corruption', () => {
  test('a missing file, a missing parent, an empty file, and blank lines all read as an empty store', async () => {
    const dir = tempDir();
    const missing = new JsonlStore(path.join(dir, 'missing.jsonl'));
    assert.deepEqual(await missing.load(), { records: [], corrupt: [] });

    const missingParent = new JsonlStore(path.join(dir, 'not-created-yet', 'store.jsonl'));
    assert.deepEqual(await missingParent.load(), { records: [], corrupt: [] });

    const emptyFile = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(emptyFile, '');
    assert.deepEqual(await new JsonlStore(emptyFile).load(), { records: [], corrupt: [] });

    const blank = path.join(dir, 'blank.jsonl');
    fs.writeFileSync(blank, '\n   \n\t\n');
    assert.deepEqual(await new JsonlStore(blank).load(), { records: [], corrupt: [] });

    // An empty store accepts its first record and is then normal, not corrupt.
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const record = await store.add({ content: 'the first fact' });
    assert.equal((await store.status()).records, 1);
    assert.equal((await store.get(record.id)).content, 'the first fact');
  });

  test('a parent that is a file is unavailable (ENOTDIR), not an empty store', async () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const store = new JsonlStore(path.join(blocker, 'store.jsonl'));
    await assert.rejects(() => store.load(), (err) => err instanceof StoreError && /ENOTDIR/.test(err.message));
  });

  test('a complete JSON line without a trailing newline is a record, not damage', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'no-newline.jsonl');
    fs.writeFileSync(file, JSON.stringify({ id: 'one', value: 'complete' }));
    const store = new JsonlStore(file);
    const loaded = await store.load();
    assert.deepEqual(loaded, { records: [{ id: 'one', value: 'complete' }], corrupt: [] });

    await store.append({ id: 'two' });
    const after = await store.load();
    assert.equal(after.corrupt.length, 0, 'the missing separator was supplied without manufacturing a corrupt line');
    assert.deepEqual(after.records.map((r) => r.id), ['one', 'two']);
  });
});

describe('066: damaged lines are counted, preserved, and fail closed', () => {
  test('a malformed middle line and a truncated final line are reported by line, with valid records kept', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'damaged.jsonl');
    fs.writeFileSync(file, [
      '{"id":"first"}',
      'not json at all',
      '{"id":"truncated","value":',
      '',
      '{"id":"last"}',
      '',
    ].join('\n'));
    const { records, corrupt } = await new JsonlStore(file).load();
    assert.deepEqual(records.map((r) => r.id), ['first', 'last']);
    assert.deepEqual(corrupt, [
      { line: 2, reason: 'invalid JSON' },
      { line: 3, reason: 'invalid JSON' },
    ]);
  });

  test('a schema-invalid line is corrupt evidence, not a stray record', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'memory.jsonl');
    const store = new MemoryStore(file);
    const good = await store.add({ content: 'valid content' });
    // Readable JSON whose content hash does not match: an unacceptable record.
    fs.appendFileSync(file, `${JSON.stringify({ ...good, contentSha256: 'f'.repeat(64) })}\n`);
    const status = await store.status();
    assert.deepEqual(status, { path: file, records: 1, corrupt: 1 });
  });

  test('memory, knowledge, conversation, and tasks refuse to read through damage; bytes are untouched', async () => {
    const dir = tempDir();

    const memoryFile = path.join(dir, 'memory.jsonl');
    fs.writeFileSync(memoryFile, '{"broken\n');
    const memory = new MemoryStore(memoryFile);
    const before = fs.readFileSync(memoryFile);
    await assert.rejects(() => memory.list(), /refusing incomplete retrieval/);
    await assert.rejects(() => memory.add({ content: 'must not be written' }), /refusing incomplete write/);
    assert.deepEqual(fs.readFileSync(memoryFile), before);

    const knowledgeFile = path.join(dir, 'knowledge.jsonl');
    fs.writeFileSync(knowledgeFile, '{"broken\n');
    const knowledge = new KnowledgeStore(knowledgeFile);
    await assert.rejects(() => knowledge.search('anything'), /refusing an incomplete knowledge operation/);
    await assert.rejects(() => knowledge.add({ subject: 'a', relationship: 'is', object: 'b', origin: 'user' }), /refusing an incomplete knowledge operation/);
    assert.equal(fs.readFileSync(knowledgeFile, 'utf8'), '{"broken\n');

    const conversationFile = path.join(dir, 'conversation.jsonl');
    fs.writeFileSync(conversationFile, `${JSON.stringify(turn())}\n{"broken\n`);
    const conversation = new ConversationStore(conversationFile);
    await assert.rejects(() => conversation.recent('s1', 5), /refusing incomplete history/);
    assert.equal((await conversation.status()).corrupt, 1);

    const taskFile = path.join(dir, 'tasks.jsonl');
    fs.writeFileSync(taskFile, [
      JSON.stringify({ schema: 1, eventId: 'e1', type: 'task_created', taskId: 't', at: '2026-01-01T00:00:00.000Z', goal: 'g', origin: 'user', planner: 'deterministic', steps: [{ id: 's1', dependsOn: [], action: 'calc', input: {} }] }) + '\n',
      '{"schema":1,"eventId":"e2"',
    ].join(''));
    const tasks = new TaskStore(taskFile);
    await assert.rejects(() => tasks.load(), /task log contains 1 corrupt line/);
    const inspected = await tasks.inspect();
    assert.equal(inspected.corrupt.length, 1, 'diagnostics can still see the damage and the readable events');
    assert.equal(inspected.events, 1);
  });

  test('the audit log lists readable operations and counts damaged lines without using them as evidence', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'operations.jsonl');
    const log = new OperationLog(file);
    await log.append({ schema: 1, id: 'o1', status: 'success_verified' });
    fs.appendFileSync(file, '{"schema":1,"id":"o2"');
    const listed = await log.list({ limit: 5 });
    assert.deepEqual(listed.records.map((op) => op.id), ['o1']);
    assert.equal(listed.corrupt, 1);
    assert.deepEqual(await log.status(), { records: 1, corrupt: 1 });
    assert.equal((await log.inspect()).corrupt[0].line, 2, 'the damaged line is named by position');
  });
});

describe('066: recovery after a process exits with a partial record', () => {
  test('the fragment survives a real abrupt exit, and the next append separates rather than merges it', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'crash.jsonl');
    const store = new JsonlStore(file);
    await store.append({ id: 'before' });
    crashWithPartialLine(file, '{"id":"partial-record-fragment"');

    const crashed = await store.load();
    assert.equal(crashed.records.length, 1, 'the complete record before the crash is still readable');
    assert.equal(crashed.corrupt.length, 1, 'the fragment is reported as corrupt');
    assert.ok(fs.readFileSync(file, 'utf8').includes('{"id":"partial-record-fragment"'), 'the fragment is preserved');

    await store.append({ id: 'after' });
    const recovered = await store.load();
    assert.deepEqual(recovered.records.map((r) => r.id), ['before', 'after']);
    assert.equal(recovered.corrupt.length, 1, 'the fragment remains one damaged line');
    const raw = fs.readFileSync(file, 'utf8');
    assert.match(raw, /\{"id":"partial-record-fragment"\n/, 'a newline was written before the new record, not merged into it');
    assert.ok(!raw.includes('partial-record-fragment"id'), 'the new record did not join the fragment');
  });

  test('a memory write after a crash is refused: the damaged store is not extended', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'memory.jsonl');
    const store = new MemoryStore(file);
    await store.add({ content: 'a fact before the crash' });
    crashWithPartialLine(file, '{"schema":1,"id":"00000000-0000-4000-8000-00000000');
    const before = fs.readFileSync(file);
    await assert.rejects(() => store.add({ content: 'a fact after the crash' }), /refusing incomplete write/);
    assert.deepEqual(fs.readFileSync(file), before, 'the refused write changed nothing');
  });

  test('conversation turns are still appended after damage, but replay stays blocked', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'conversation.jsonl');
    const store = new ConversationStore(file);
    await store.append({ sessionId: 's1', role: 'user', origin: TURN_ORIGINS.USER, text: 'before' });
    crashWithPartialLine(file, '{"schema":1,"sessionId":"s1"');
    await store.append({ sessionId: 's1', role: 'user', origin: TURN_ORIGINS.USER, text: 'after' });
    await assert.rejects(() => store.recent('s1', 5), /refusing incomplete history/);
    const status = await store.status();
    assert.equal(status.turns, 2);
    assert.equal(status.corrupt, 1);
  });
});

describe('066: read and write failures are unavailable, not empty or successful', () => {
  test('a store path that is a directory cannot be read as an empty store', async () => {
    const dir = tempDir();
    const asDir = path.join(dir, 'memory.jsonl');
    fs.mkdirSync(asDir);
    const store = new JsonlStore(asDir);
    await assert.rejects(() => store.load(), (err) => err instanceof StoreError && /EISDIR/.test(err.message));

    const res = await runCli(['ask', 'hello'], envFor(dir));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /Memory retrieval failed \(STORE_UNAVAILABLE\)/, res.stdout);
  });

  test('a write to a location whose parent is a file fails with the OS reason', async () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const store = new JsonlStore(path.join(blocker, 'memory.jsonl'));
    await assert.rejects(() => store.append({ id: 'never' }), (err) => err instanceof StoreError && /ENOTDIR|EEXIST/.test(err.message));
    assert.equal(fs.readFileSync(blocker, 'utf8'), 'not a directory', 'nothing was replaced');
  });

  test('a failure to make the write durable is reported, and the record is not claimed absent', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'durability.jsonl');
    const store = new JsonlStore(file);
    const realOpen = fsp.open;
    fsp.open = async (...args) => {
      const handle = await realOpen(...args);
      handle.sync = async () => { throw Object.assign(new Error('no space left'), { code: 'ENOSPC' }); };
      return handle;
    };
    try {
      await assert.rejects(
        () => store.append({ id: 'maybe-present', markerEnd: 'END' }),
        /cannot write durability\.jsonl: ENOSPC; the record was written but its durability could not be confirmed, so it may be present/,
      );
    } finally {
      fsp.open = realOpen;
    }
    const loaded = await store.load();
    assert.equal(loaded.records.length, 1, 'the report did not pretend the store was unchanged');
    assert.equal(loaded.records[0].id, 'maybe-present');
  });
});

describe('066: the CLI reports skipped lines wherever it counts records', () => {
  test('status shows the skipped-line count for conversation and audit, and history still lists readable records', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'conversation.jsonl'), `${JSON.stringify(turn('s1'))}\n{"broken\n`);
    fs.writeFileSync(path.join(dir, 'operations.jsonl'), [
      JSON.stringify({ schema: 1, id: 'o1', status: 'success_verified', requestedAt: '2026-01-01T00:00:00.000Z', capability: 'calc', request: 'calc 1+1', output: '1+1 = 2' }) + '\n',
      '{"schema":1,"id":"o2"',
    ].join(''));

    const status = await runCli(['status'], envFor(dir));
    assert.equal(status.code, 1, status.stdout + status.stderr);
    assert.match(status.stdout, /Conversation turns: 1 \(corrupt lines skipped: 1\)/, status.stdout);
    assert.match(status.stdout, /Operation records: 1 \(corrupt lines skipped: 1\)/, status.stdout);
    assert.match(status.stdout, /Integrity: attention required/, status.stdout);

    const history = await runCli(['history'], envFor(dir));
    assert.equal(history.code, 0, history.stdout + history.stderr);
    assert.match(history.stdout, /o1\s+success_verified/, history.stdout);
    assert.match(history.stdout, /\(1 corrupt audit line\(s\) skipped\)/, history.stdout);

    const diagnose = await runCli(['diagnose'], envFor(dir));
    assert.equal(diagnose.code, 1, diagnose.stdout + diagnose.stderr);
    assert.match(diagnose.stdout, /conversation\.jsonl: line 2: invalid JSON/, diagnose.stdout);
    assert.match(diagnose.stdout, /operations\.jsonl: line 2: invalid JSON/, diagnose.stdout);
    assert.match(diagnose.stdout, /Preserve conversation\.jsonl/, diagnose.stdout);
  });

  test('a corrupt memory store is reported on the request that needed it, with its readable bytes intact', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'memory.jsonl');
    fs.writeFileSync(file, '{"schema":1,"id":"x","bad":');
    const before = fs.readFileSync(file);

    const res = await runCli(['ask', 'remember that the sky is blue'], envFor(dir));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /memory store contains 1 corrupt line\(s\); refusing incomplete write/, res.stdout);
    assert.deepEqual(fs.readFileSync(file), before, 'the refused write preserved the damaged bytes');
  });
});

describe('076: an interrupted atomic replace leaves residue, never state', () => {
  test('a staging file from a killed replacement is ignored, and the queue keeps working', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'task-summary-queue.json');
    const signature = 'a'.repeat(64);
    fs.writeFileSync(file, `${JSON.stringify({ schema: 1, entries: [] })}\n`);
    // What a process killed between opening its temporary file and renaming it leaves:
    // a complete or partial copy under a private name. It is not the queue's state.
    fs.writeFileSync(`${file}.12345.dead-nonce.tmp`, '{"schema":1,"entries":[{"half":');
    fs.writeFileSync(`${file}.12345.other-nonce.tmp`, JSON.stringify({ schema: 1, entries: [] }));

    const queue = new SummaryQueue(file);
    assert.deepEqual(await queue.entries(), [], 'residue is not read as an entry');

    const result = await queue.add({ sessionId: 's1', taskId: 'task-r', signature, text: 'summary for task-r', verified: true });
    assert.equal(result.queued, true);
    assert.equal((await queue.entries()).length, 1, 'the intact file is the only input to the next change');
    assert.equal(fs.existsSync(`${file}.12345.dead-nonce.tmp`), true, 'another process\'s residue is not deleted');
  });
});
