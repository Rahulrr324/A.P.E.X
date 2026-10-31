// Batch V (V-05, V-08): the incremental validated state the write path maintains must stay a
// performance aid, never a second source of truth.
//
// An ordinary append used to re-read, re-parse and re-validate the whole store. It now keeps the
// records it parsed and validated, keyed by the SHA-256 of the exact bytes that produced them, and
// advances that key with only the bytes one of its own confirmed appends wrote. The tests below pin
// what that buys and what it must never cost:
//   1. equivalence. Every reused read returns exactly what a fresh replay of the authoritative
//      records returns, for both stores and across the lifecycle (conflict, supersession,
//      retraction, resolution, correction);
//   2. proof before reuse. The file is read on every write read and hashed before any retained
//      record is handed out, so an external append, a same-length rewrite of history, a
//      truncation, a replaced file, or another instance's append re-derives the whole store;
//   3. derived state is never ahead of the log. An append whose fsync did not return, or that
//      leaves bytes this instance did not account for, or that stores a record the current rules
//      reject, cannot leave the state describing more than the file contains;
//   4. damage still refuses. A corrupt store is refused on the read, and is represented by no
//      retained records at all;
//   5. bounds. Nothing is persisted, a restart rebuilds, and neither a store that never opted in
//      nor one above the cap tracks anything;
//   6. concurrency. Two real processes appending while a third instance holds a warm store, two
//      instances writing the same target, and a foreign retraction between two of this instance's
//      writes all show that no new claim, retraction, correction or piece of damage is hidden from
//      a subsequent write read. Batch W coordinates the public write paths through
//      `src/memory/writer-lock.js`, which is what `tests/store-write-concurrency.test.js` proves;
//      the tests here that need two instances to read before either writes drive the log primitives
//      directly, and pin that derived state neither causes that interleaving nor hides its result.
//
// Fixtures are temporary directories and controlled records. No real user data is read, damaged,
// or modified, and no model inference is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { makeTempDataDir, cleanup, cleanEnv, APP_ROOT } from './helpers.js';
import { JsonlStore } from '../src/memory/jsonl-store.js';
import { MemoryStore, sha256Hex, validateMemoryRecord } from '../src/memory/memory-store.js';
import { KnowledgeStore, validateKnowledgeRecord } from '../src/knowledge/knowledge-store.js';
import { buildWorldState } from '../src/world/world-state.js';

const AT = '2026-02-02T00:00:00.000Z';
const FIXED_NOW = () => new Date(AT);
const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'storage-writer-child.mjs');

function tempDir() {
  return makeTempDataDir();
}

function memoryPath(dir) {
  return path.join(dir, 'memory.jsonl');
}

function knowledgePath(dir) {
  return path.join(dir, 'knowledge.jsonl');
}

function line(record) {
  return `${JSON.stringify(record)}\n`;
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

// A fresh replay of the authoritative records: the same parser and the same integrity rules, on a
// store instance that has never seen this file and holds no derived state of any kind.
function replay(file, validateRecord) {
  return new JsonlStore(file, { validateRecord }).load({ maintainSnapshot: false });
}

function memoryRecord(content, overrides = {}) {
  return {
    schema: 1,
    id: randomUUID(),
    kind: 'user_fact',
    source: 'user',
    sensitivity: 'normal',
    content,
    contentSha256: sha256Hex(content),
    createdAt: AT,
    provenance: { origin: 'user_request', updateMode: 'user_confirmed' },
    ...overrides,
  };
}

function statsFor(store) {
  return store.log.appendStateStats;
}

function provenance(store) {
  const s = statsFor(store);
  return `${s.reuses} reuse(s), ${s.rebuilds} re-derivation(s), ${s.trackedRecords} tracked record(s)`;
}

// The assertion that matters everywhere in this file: what the instance's derived state holds is
// exactly what a fresh replay of the log holds. Counted as an extra write read, so callers must
// expect one more reuse (or rebuild) than the writes alone account for.
async function assertDerivedEqualsLog(store, validateRecord, label) {
  const derived = await store.log.loadForAppend();
  const authoritative = await replay(store.filePath, validateRecord);
  assert.deepEqual(
    derived.records,
    authoritative.records,
    `${label}: derived state must equal a fresh replay (${provenance(store)})`,
  );
  assert.deepEqual(derived.corrupt, authoritative.corrupt, `${label}: and report the same damage`);
  return derived;
}

function spawnWriter(args, { racers, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, ...args], {
      env: cleanEnv({ APEX_RACERS: String(racers) }),
      cwd,
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code, signal) => resolve({ code, signal, out }));
  });
}

// ---- 1. equivalence: the reused read is a replay of the log ---------------------------------

test('equivalence - a memory write loop keeps derived state identical to the authoritative records', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = new MemoryStore(file, { now: FIXED_NOW });

  const blue = await store.add({ content: 'My favourite colour is blue', source: 'user', provenance: { origin: 'user_request' } });
  // The first write read of a store that does not exist yet installs the empty state rather than
  // counting a re-derivation, so 8 writes leave 7 reuses and no rebuild at all.
  for (let i = 0; i < 7; i += 1) {
    await store.add({ content: `Belief number ${i}`, source: 'user', provenance: { origin: 'user_request' } });
  }
  assert.deepEqual(statsFor(store), {
    enabled: true,
    maxBytes: store.log.parseCacheBytes,
    tracked: true,
    trackedRecords: 8,
    trackedBytes: fs.statSync(file).size,
    reuses: 7,
    rebuilds: 0,
  }, 'eight ordinary writes cost one whole-store derivation: none');
  await assertDerivedEqualsLog(store, validateMemoryRecord, 'after eight appends');

  // The write that replaces a record rather than adding one uses the same read, so a correction
  // cannot be the occasion where the state quietly diverges from the file.
  await store.correct({ targetId: blue.id, content: 'My favourite colour is green', origin: 'user' });
  // The verification read above is itself a write read, so 7 + 1 + 1 = 9 reuses for 9 writes.
  assert.equal(statsFor(store).reuses, 9, provenance(store));
  assert.equal(statsFor(store).trackedRecords, 9);
  await assertDerivedEqualsLog(store, validateMemoryRecord, 'after the correction');

  // Nothing was written anywhere but the store itself: no sidecar, no index file, no journal.
  assert.deepEqual(fs.readdirSync(dir), ['memory.jsonl'], 'the state is in-process only');
  assert.equal(readText(file).trimEnd().split('\n').length, 9, 'the log holds exactly its own records');

  const listed = await store.list({ limit: 50 });
  assert.equal(listed.filter((r) => r.provenance?.replaces?.includes(blue.id)).length, 1);

  // A second instance on the same path starts from nothing and re-derives it once.
  const restarted = new MemoryStore(file, { now: FIXED_NOW });
  assert.equal(statsFor(restarted).tracked, false, 'a restart holds no derived state');
  await restarted.add({ content: 'Belief added after the restart', source: 'user', provenance: { origin: 'user_request' } });
  const fresh = statsFor(restarted);
  assert.equal(fresh.rebuilds, 1, 'the first write read after a restart re-derives the whole store');
  assert.equal(fresh.reuses, 0, 'and nothing before it could be reused');
  assert.equal(fresh.trackedRecords, 10);
  assert.equal(fresh.trackedBytes, fs.statSync(file).size);
  const contents = new Set((await restarted.list({ limit: 50 })).map((r) => r.content));
  assert.ok(contents.has('My favourite colour is green'));
  assert.ok(contents.has('Belief number 6'));
  assert.ok(contents.has('Belief added after the restart'));
});

test('equivalence - the knowledge lifecycle keeps derived state identical to the log', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = knowledgePath(dir);
  const knowledge = new KnowledgeStore(file, { now: FIXED_NOW });

  const first = await knowledge.add({ subject: 'The gateway', relationship: 'listens on', object: 'port 8081', origin: 'user' });
  const second = await knowledge.add({ subject: 'The gateway', relationship: 'listens on', object: 'port 9090', origin: 'user' });
  const resolution = await knowledge.resolve({
    target: first.record.id, choose: second.record.id, reason: 'decided during the write test', origin: 'user',
  });
  const superseded = await knowledge.add({ subject: 'The gateway', relationship: 'binds', object: '0.0.0.0', origin: 'user' });
  const successor = await knowledge.add({
    subject: 'The gateway', relationship: 'binds', object: '127.0.0.1', supersedes: [superseded.record.id], origin: 'user',
  });
  const retraction = await knowledge.retract({ target: first.record.id, reason: 'withdrawn during the write test', origin: 'user' });

  // Six writes: the first read derived nothing (no file yet), the other five reused.
  assert.deepEqual(statsFor(knowledge), {
    enabled: true,
    maxBytes: knowledge.log.parseCacheBytes,
    tracked: true,
    trackedRecords: 6,
    trackedBytes: fs.statSync(file).size,
    reuses: 5,
    rebuilds: 0,
  }, 'a conflicting claim, a resolution, a supersession and a retraction all reused the state');
  assert.equal(resolution.event.kind, 'resolution');
  assert.equal(retraction.event.kind, 'retraction');
  assert.equal(retraction.record.id, first.record.id);
  await assertDerivedEqualsLog(knowledge, validateKnowledgeRecord, 'after the lifecycle writes');

  // What the log itself now says, independent of any reader's semantics.
  const authoritative = await replay(file, validateKnowledgeRecord);
  assert.equal(
    authoritative.records.find((r) => r.id === successor.record.id).supersededBy.length, 1,
    'the supersession is recorded on the record that made it',
  );
  assert.equal(authoritative.records.filter((r) => r.kind === 'retraction').length, 1);
  assert.deepEqual(fs.readdirSync(dir), ['knowledge.jsonl'], 'no index or sidecar was created');

  // A fresh instance agrees with this one about the whole store, and never consults it for that.
  const restarted = new KnowledgeStore(file, { now: FIXED_NOW });
  assert.equal(statsFor(restarted).tracked, false);
  assert.deepEqual(await restarted.health(), await knowledge.health());
  assert.deepEqual(await restarted.list({ limit: 50 }), await knowledge.list({ limit: 50 }));
  assert.equal(statsFor(restarted).rebuilds, 0, 'reads are not write reads and track nothing');
});

test('equivalence - the world-state projection is identical with and without reused write reads', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = new MemoryStore(memoryPath(dir), { now: FIXED_NOW });
  const knowledge = new KnowledgeStore(knowledgePath(dir), { now: FIXED_NOW });
  for (let i = 0; i < 5; i += 1) {
    await memory.add({ content: `The build runs on Node ${20 + i}`, source: 'user', provenance: { origin: 'user_request' } });
  }
  await knowledge.add({ subject: 'The registry', relationship: 'is', object: 'private', origin: 'user' });
  assert.equal(statsFor(memory).reuses, 4, provenance(memory));

  const written = await buildWorldState({ memory, knowledge, now: FIXED_NOW });

  // Fresh instances hold no derived state at all, so this projection is built purely by replaying
  // the authoritative records. It must be identical, not merely similar.
  const cold = await buildWorldState({
    memory: new MemoryStore(memoryPath(dir), { now: FIXED_NOW }),
    knowledge: new KnowledgeStore(knowledgePath(dir), { now: FIXED_NOW }),
    now: FIXED_NOW,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(cold)), JSON.parse(JSON.stringify(written)));
  assert.ok(written.counts.representedBeliefs >= 6);
});

// ---- 2. reuse is conditional on proof -------------------------------------------------------

test('proof - a reused write read still reads the file and hashes every byte of it', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = new MemoryStore(file, { now: FIXED_NOW });
  await store.add({ content: 'The deploy target is staging', source: 'user', provenance: { origin: 'user_request' } });

  const realReadFile = fsp.readFile;
  let reads = 0;
  fsp.readFile = async (...args) => {
    if (String(args[0]) === file) reads += 1;
    return realReadFile(...args);
  };
  try {
    await store.add({ content: 'The build runs on Node 26', source: 'user', provenance: { origin: 'user_request' } });
  } finally {
    fsp.readFile = realReadFile;
  }
  assert.equal(reads, 1, 'a reuse is not a cached read: the bytes are always read from disk');
  assert.deepEqual(
    { reuses: statsFor(store).reuses, rebuilds: statsFor(store).rebuilds },
    { reuses: 1, rebuilds: 0 },
    'and the reuse was decided by hashing them',
  );
});

test('proof - an external append is seen by the next write read and stops the reuse', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = new MemoryStore(file, { now: FIXED_NOW });
  await store.add({ content: 'The build runs on Node 26', source: 'user', provenance: { origin: 'user_request' } });

  fs.appendFileSync(file, line(memoryRecord('My favourite colour is blue')), 'utf8');
  const view = await store.log.loadForAppend();
  assert.equal(view.records.length, 2, 'the foreign record is in the next write read');
  assert.deepEqual(
    { reuses: statsFor(store).reuses, rebuilds: statsFor(store).rebuilds, tracked: statsFor(store).trackedRecords },
    { reuses: 0, rebuilds: 1, tracked: 2 },
    'the reuse streak stopped instead of serving a stale view',
  );

  // Functionally too: a record this instance never saw is a valid correction target.
  const foreign = view.records.find((r) => r.content === 'My favourite colour is blue');
  const corrected = await store.correct({ targetId: foreign.id, content: 'My favourite colour is green', origin: 'user' });
  assert.deepEqual(corrected.provenance.replaces, [foreign.id]);
  assert.equal(statsFor(store).rebuilds, 1, 'the re-derived state is now the current one');
});

test('proof - a rewrite that keeps the file exactly the same length re-derives', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = new MemoryStore(file, { now: FIXED_NOW });
  await store.add({ content: 'My favourite colour is blue', source: 'user', provenance: { origin: 'user_request' } });

  const before = readText(file);
  const rewritten = before.replace(AT, '2026-02-03T00:00:00.000Z');
  assert.notEqual(rewritten, before, 'the rewrite changed a stored byte');
  assert.equal(rewritten.length, before.length, 'without changing the file size');
  fs.writeFileSync(file, rewritten, 'utf8');

  const view = await store.log.loadForAppend();
  assert.equal(view.records[0].createdAt, '2026-02-03T00:00:00.000Z', 'history is read as it now is');
  assert.deepEqual(
    { reuses: statsFor(store).reuses, rebuilds: statsFor(store).rebuilds },
    { reuses: 0, rebuilds: 1 },
    'a size- or mtime-based check would have reused here; the digest does not',
  );
});

test('proof - a truncation is reported as damage and retained as nothing', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = new MemoryStore(file, { now: FIXED_NOW });
  await store.add({ content: 'The build runs on Node 26', source: 'user', provenance: { origin: 'user_request' } });
  await store.add({ content: 'My favourite colour is blue', source: 'user', provenance: { origin: 'user_request' } });
  assert.equal(statsFor(store).reuses, 1);

  const bytes = fs.readFileSync(file);
  fs.writeFileSync(file, bytes.subarray(0, bytes.length - 40), 'utf8');
  const view = await store.log.loadForAppend();
  assert.equal(view.corrupt.length, 1, 'the cut tail is damage, not a record');
  assert.equal(view.records.length, 1);
  assert.equal(statsFor(store).tracked, false, 'a damaged file is retained as nothing at all');
  await assert.rejects(
    store.add({ content: 'A belief that cannot be accepted', source: 'user', provenance: { origin: 'user_request' } }),
    /memory store contains 1 corrupt line\(s\); refusing incomplete write/,
  );
});

test('proof - a replaced file is re-derived rather than compared by path', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = new MemoryStore(file, { now: FIXED_NOW });
  await store.add({ content: 'The build runs on Node 26', source: 'user', provenance: { origin: 'user_request' } });

  fs.writeFileSync(file, line(memoryRecord('An unrelated store occupies this path')), 'utf8');
  const view = await store.log.loadForAppend();
  assert.deepEqual(view.records.map((r) => r.content), ['An unrelated store occupies this path']);
  assert.deepEqual(
    { reuses: statsFor(store).reuses, rebuilds: statsFor(store).rebuilds },
    { reuses: 0, rebuilds: 1 },
    'the same path with different bytes is a different store',
  );
});

test('proof - another store instance writing the same file cannot be hidden from the first', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const first = new MemoryStore(file, { now: FIXED_NOW });
  await first.add({ content: 'Written by the first instance', source: 'user', provenance: { origin: 'user_request' } });
  assert.equal(statsFor(first).trackedRecords, 1);

  const second = new MemoryStore(file, { now: FIXED_NOW });
  const bySecond = await second.add({ content: 'My favourite colour is blue', source: 'user', provenance: { origin: 'user_request' } });
  assert.deepEqual(
    { reuses: statsFor(second).reuses, rebuilds: statsFor(second).rebuilds },
    { reuses: 0, rebuilds: 1 },
    'the second instance had to derive the store it found',
  );

  // The first instance writes again. Its state describes the file as it left it, so the length and
  // digest check must fail and the foreign record must reach the write read whole.
  await first.correct({ targetId: bySecond.id, content: 'My favourite colour is green', origin: 'user' });
  const stats = statsFor(first);
  assert.equal(stats.rebuilds, 1, 'the foreign append forced a re-derivation');
  assert.equal(stats.reuses, 0, 'no read of this instance was answered from a state that predates it');
  assert.equal(stats.trackedRecords, 3);
  await assertDerivedEqualsLog(first, validateMemoryRecord, 'after the second instance wrote');
});

// ---- 3. derived state never gets ahead of the log -------------------------------------------

test('failure - an append that writes nothing leaves a state that is still true of the file', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = new MemoryStore(file, { now: FIXED_NOW });
  await store.add({ content: 'The build runs on Node 26', source: 'user', provenance: { origin: 'user_request' } });

  // A write that accepts no bytes at all: the append fails, nothing reaches the file, and the
  // retained state still describes every byte the file holds.
  //
  // The fault is installed for the store file alone. A store-level `add()` also writes the writer
  // lock's own claim, and a lock body that cannot be written is refused before the store is
  // touched - which would test a different path than the one named in this test's title. The
  // assertions below are the Batch V ones, unchanged.
  const realOpen = fsp.open;
  fsp.open = async (path, ...rest) => {
    const handle = await realOpen(path, ...rest);
    if (path !== file) return handle;
    handle.write = async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) });
    return handle;
  };
  try {
    await assert.rejects(
      store.add({ content: 'Never lands', source: 'user', provenance: { origin: 'user_request' } }),
      /cannot write memory\.jsonl: write accepted 0 of \d+ bytes/,
    );
  } finally {
    fsp.open = realOpen;
  }
  assert.doesNotMatch(readText(file), /Never lands/, 'nothing was reported as stored that is not on disk');
  const stalled = statsFor(store);
  assert.equal(stalled.trackedRecords, 1, 'the failed record is not in the derived state');
  assert.equal(stalled.trackedBytes, fs.statSync(file).size, 'and the state still matches the file byte for byte');
  assert.deepEqual({ reuses: stalled.reuses, rebuilds: stalled.rebuilds }, { reuses: 1, rebuilds: 0 });

  // So the next write reusing that state is sound rather than lucky: the file really is unchanged.
  await store.add({ content: 'My favourite colour is blue', source: 'user', provenance: { origin: 'user_request' } });
  assert.equal(statsFor(store).reuses, 2, provenance(store));
  await assertDerivedEqualsLog(store, validateMemoryRecord, 'after a failed append');
});

test('failure - an append that leaves unaccounted bytes cannot advance derived state', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = new MemoryStore(file, { now: FIXED_NOW });
  await store.add({ content: 'The build runs on Node 26', source: 'user', provenance: { origin: 'user_request' } });

  // Half a record reaches the disk and then the write faults. JsonlStore normally completes short
  // writes; this fault stops the loop, so the residue is exactly what a crash would leave. The
  // fault is scoped to the store file for the reason given in the test above: the lock's own
  // writes are not what this test is about, and are left working normally.
  const realOpen = fsp.open;
  fsp.open = async (path, ...rest) => {
    const handle = await realOpen(path, ...rest);
    if (path !== file) return handle;
    const realWrite = handle.write.bind(handle);
    let firstWrite = true;
    handle.write = async (data, offset = 0, length = data.length - offset) => {
      if (!firstWrite) return realWrite(data, offset, length);
      firstWrite = false;
      await realWrite(data, offset, Math.max(1, Math.floor(length / 2)));
      throw new Error('injected fault after a partial write');
    };
    return handle;
  };
  const sizeBefore = fs.statSync(file).size;
  try {
    await assert.rejects(
      store.add({ content: 'Half a record on purpose', source: 'user', provenance: { origin: 'user_request' } }),
      /cannot write memory\.jsonl: injected fault after a partial write; \d+ byte\(s\) may remain as a partial line/,
    );
  } finally {
    fsp.open = realOpen;
  }
  assert.ok(fs.statSync(file).size > sizeBefore, 'the partial bytes are visible to a reader');
  const afterFault = statsFor(store);
  assert.equal(afterFault.trackedRecords, 1, 'the unconfirmed record never entered the derived state');
  assert.equal(afterFault.trackedBytes, sizeBefore, 'the state was not advanced past the log');

  // The next write read compares the file it finds against that state, fails, and re-derives - so
  // the residue is reported instead of being papered over.
  await assert.rejects(
    store.add({ content: 'Any later belief', source: 'user', provenance: { origin: 'user_request' } }),
    /memory store contains 1 corrupt line\(s\); refusing incomplete write/,
  );
  assert.equal(statsFor(store).rebuilds, 1, 'the mismatch was caught by re-deriving');
  assert.equal(statsFor(store).tracked, false, 'and the damaged file is retained as nothing');
  assert.deepEqual(fs.readdirSync(dir), ['memory.jsonl']);
});

test('failure - a record that fails validation never enters derived state', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = new MemoryStore(file, { now: FIXED_NOW });
  const good = await store.add({ content: 'The build runs on Node 26', source: 'user', provenance: { origin: 'user_request' } });
  assert.equal(statsFor(store).trackedRecords, 1);

  // The store itself cannot author an invalid record, so one is written through the append layer
  // directly. The guard that keeps it out of the derived state is the one under test.
  const bad = { ...memoryRecord('A record the rules reject'), schema: 2 };
  await store.log.append(bad);
  assert.equal(statsFor(store).tracked, false, 'the state was dropped rather than advanced');
  assert.equal(statsFor(store).trackedRecords, 0);

  const authoritative = await replay(file, validateMemoryRecord);
  assert.deepEqual(authoritative.records.map((r) => r.id), [good.id], 'the valid record is still there');
  assert.equal(authoritative.corrupt.length, 1);
  assert.equal(authoritative.corrupt[0].reason, 'unsupported schema');

  await assert.rejects(
    store.add({ content: 'Any later belief', source: 'user', provenance: { origin: 'user_request' } }),
    /memory store contains 1 corrupt line\(s\); refusing incomplete write/,
  );
});

// ---- 4. damage and refusal are still re-discovered ------------------------------------------

test('damage - a memory store corrupted after a healthy write read is refused, not masked', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const memory = new MemoryStore(file, { now: FIXED_NOW });
  await memory.add({ content: 'The build runs on Node 26', source: 'user', provenance: { origin: 'user_request' } });
  await memory.add({ content: 'My favourite colour is blue', source: 'user', provenance: { origin: 'user_request' } });
  await assertDerivedEqualsLog(memory, validateMemoryRecord, 'before the damage');
  assert.equal(statsFor(memory).reuses, 2, provenance(memory));

  fs.appendFileSync(file, '{"schema":1,"id":"broken', 'utf8');
  const sizeBefore = fs.statSync(file).size;
  await assert.rejects(
    memory.add({ content: 'A belief that cannot be accepted', source: 'user', provenance: { origin: 'user_request' } }),
    /memory store contains 1 corrupt line\(s\); refusing incomplete write/,
  );
  assert.equal(fs.statSync(file).size, sizeBefore, 'the refused write added nothing');
  const stats = statsFor(memory);
  assert.equal(stats.tracked, false, 'a damaged store is represented by no retained records at all');
  assert.equal(stats.reuses, 2, 'the damage was found on the read, so no reuse followed it');

  // Remove the residue and the same instance re-derives the store and carries on.
  const lines = readText(file).split('\n').filter((l) => l.trim() !== '' && l.endsWith('}'));
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  await memory.add({ content: 'A belief after the damage was removed', source: 'user', provenance: { origin: 'user_request' } });
  assert.equal(statsFor(memory).rebuilds, 2, 'one re-derivation found the damage, the next repaired the state');
  assert.equal(statsFor(memory).trackedRecords, 3);
  await assertDerivedEqualsLog(memory, validateMemoryRecord, 'after the repair');
});

test('damage - a knowledge store damaged mid-lifecycle refuses every later lifecycle write', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = knowledgePath(dir);
  const knowledge = new KnowledgeStore(file, { now: FIXED_NOW });
  const claim = await knowledge.add({ subject: 'The gateway', relationship: 'listens on', object: 'port 8081', origin: 'user' });
  assert.equal(statsFor(knowledge).reuses, 0, 'the only write read so far was the one that created the file');

  fs.appendFileSync(file, '{"schema":1,"id":"half\n', 'utf8');
  await assert.rejects(
    knowledge.retract({ target: claim.record.id, reason: 'cannot be granted', origin: 'user' }),
    /knowledge store contains 1 corrupt line\(s\); refusing an incomplete knowledge operation/,
  );
  assert.equal(statsFor(knowledge).tracked, false);
  await assert.rejects(
    knowledge.add({ subject: 'The gateway', relationship: 'listens on', object: 'port 9090', origin: 'user' }),
    /knowledge store contains 1 corrupt line\(s\); refusing an incomplete knowledge operation/,
  );
  const authoritative = await replay(file, validateKnowledgeRecord);
  assert.equal(authoritative.records.length, 1, 'nothing was appended on the way to either refusal');
  assert.equal(authoritative.corrupt.length, 1);
  assert.equal(statsFor(knowledge).rebuilds, 2, 'both write reads re-derived and both found the damage');
});

// ---- 5. bounds and opt-in -------------------------------------------------------------------

test('bounds - a store grown past the cap from an empty file never retains more than the cap', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = 1_000;
  const file = memoryPath(dir);
  const store = new MemoryStore(file, { now: FIXED_NOW, parseCacheBytes: cap });
  const oneLine = await store.add({ content: 'My favourite colour is blue', source: 'user', provenance: { origin: 'user_request' } });

  let exceeded = 0;
  for (let i = 0; i < 12; i += 1) {
    await store.add({ content: `Belief number ${i}`, source: 'user', provenance: { origin: 'user_request' } });
    const stats = statsFor(store);
    assert.ok(stats.trackedBytes <= cap, `tracked ${stats.trackedBytes} bytes over a ${cap} byte cap after write ${i}`);
    if (stats.trackedBytes > cap) exceeded += 1;
  }
  assert.equal(exceeded, 0, 'retained bytes never exceed the configured cap');
  const stats = statsFor(store);
  assert.equal(stats.enabled, true);
  assert.equal(stats.tracked, false, 'a file over the cap is not retained at all');
  assert.ok(stats.reuses >= 1, `reuse worked while the store was under the cap (${provenance(store)})`);
  assert.ok(stats.rebuilds >= 1, `and stopped the moment it was not (${provenance(store)})`);
  assert.equal(oneLine.content, 'My favourite colour is blue');

  // The cap changes nothing a reader sees.
  const authoritative = await replay(file, validateMemoryRecord);
  assert.equal(authoritative.records.length, 13);
  assert.deepEqual((await store.list({ limit: 50 })).length, 13);

  const off = new MemoryStore(path.join(dir, 'opt-out.jsonl'), { now: FIXED_NOW, parseCacheBytes: 0 });
  await off.add({ content: 'A store that never opted in', source: 'user', provenance: { origin: 'user_request' } });
  await off.add({ content: 'A second belief', source: 'user', provenance: { origin: 'user_request' } });
  const disabled = statsFor(off);
  assert.deepEqual(
    { enabled: disabled.enabled, tracked: disabled.tracked, reuses: disabled.reuses, maxBytes: disabled.maxBytes },
    { enabled: false, tracked: false, reuses: 0, maxBytes: 0 },
    'a store that leaves the cap at 0 tracks nothing at all',
  );
  await assertDerivedEqualsLog(off, validateMemoryRecord, 'the opted-out store');
});

// ---- 6. concurrent writers ------------------------------------------------------------------

test('concurrency - two real processes append while an instance holds a warm store', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const parent = new MemoryStore(file, { now: FIXED_NOW });
  await parent.add({ content: 'Written before the race', source: 'user', provenance: { origin: 'user_request' } });
  assert.equal(statsFor(parent).tracked, true, 'the parent holds a verified state of its own');

  const racers = await Promise.all([0, 1].map((i) => spawnWriter(
    ['add-memory', dir, String(i), '12'],
    { racers: 2, cwd: APP_ROOT },
  )));
  for (const racer of racers) assert.equal(racer.code, 0, racer.out);

  const afterRace = await replay(file, validateMemoryRecord);
  assert.equal(afterRace.records.length, 25, 'every child record and the parent record are on disk');
  assert.equal(afterRace.corrupt.length, 0, 'no child append interleaved into a partial line');
  for (let writer = 0; writer < 2; writer += 1) {
    assert.equal(
      afterRace.records.filter((r) => r.content.startsWith(`fact from writer ${writer}`)).length,
      12, `writer ${writer} kept all of its records`,
    );
  }

  // The parent writes again. Its state describes the file as the parent left it, so the check must
  // fail and all 24 foreign records must reach the write read whole.
  await parent.add({ content: 'Written after the race', source: 'user', provenance: { origin: 'user_request' } });
  const stats = statsFor(parent);
  assert.equal(stats.rebuilds, 1, 'the foreign appends forced a re-derivation');
  assert.equal(stats.reuses, 0, 'and no reuse answered a read of a file this instance did not write');
  assert.equal(stats.trackedRecords, 26);
  const listed = await parent.list({ limit: 100 });
  assert.equal(listed.filter((r) => r.content.startsWith('fact from writer')).length, 24, 'no child record is hidden');
  assert.equal(listed.filter((r) => r.content === 'Written after the race').length, 1);

  // The same race against the knowledge store, whose write read is used by lifecycle writes too.
  const kFile = knowledgePath(dir);
  const knowledge = new KnowledgeStore(kFile, { now: FIXED_NOW });
  await knowledge.add({ subject: 'The gateway', relationship: 'listens on', object: 'port 8081', origin: 'user' });
  const claimRacers = await Promise.all([0, 1].map((i) => spawnWriter(
    ['add-knowledge', dir, String(i), '10'],
    { racers: 2, cwd: APP_ROOT },
  )));
  for (const racer of claimRacers) assert.equal(racer.code, 0, racer.out);
  const added = await knowledge.add({ subject: 'The gateway', relationship: 'binds', object: '0.0.0.0', origin: 'user' });
  const kStats = statsFor(knowledge);
  assert.equal(kStats.rebuilds, 1, 'the parent re-derived after the children claimed');
  assert.equal(kStats.trackedRecords, 22);
  const claims = await replay(kFile, validateKnowledgeRecord);
  assert.equal(claims.records.length, 22);
  assert.equal(claims.records.filter((r) => r.subject.startsWith('claim from writer')).length, 20, 'every child claim is readable');
  assert.equal(added.record.status, 'supported');
});

test('concurrency - a foreign retraction between two writes changes what the next write sees', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = knowledgePath(dir);
  const store = new KnowledgeStore(file, { now: FIXED_NOW });
  const claim = await store.add({ subject: 'The ledger', relationship: 'totals', object: '120', origin: 'user' });

  // Another process retracts that claim while this instance holds a verified state of the store.
  const other = new KnowledgeStore(file, { now: FIXED_NOW });
  await other.retract({ target: claim.record.id, reason: 'withdrawn by another process', origin: 'user' });

  // This instance now adds the same triple with a different object. Against a stale view the
  // retracted claim would still be live and the new claim would be recorded as a conflict; seeing
  // the foreign event is what makes the status correct.
  const added = await store.add({ subject: 'The ledger', relationship: 'totals', object: '118', origin: 'user' });
  assert.deepEqual(added.conflictingIds, [], 'the retired claim was not treated as a live conflict');
  assert.equal(added.record.status, 'supported');
  const stats = statsFor(store);
  assert.equal(stats.rebuilds, 1, 'the foreign retraction forced a re-derivation');
  assert.equal(stats.reuses, 0);
  assert.equal(stats.trackedRecords, 3);
  await assertDerivedEqualsLog(store, validateKnowledgeRecord, 'after the foreign retraction');
});

test('concurrency - two instances that read before either writes can duplicate a correction', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const first = new MemoryStore(file, { now: FIXED_NOW });
  const target = await first.add({ content: 'My favourite colour is blue', source: 'user', provenance: { origin: 'user_request' } });
  const second = new MemoryStore(file, { now: FIXED_NOW });

  // The read a write performs, issued by both instances before either appends. This drives the log
  // primitives directly, in the order two uncoordinated writes would have used them: Batch W's
  // public paths take a per-store claim around exactly this sequence, and `correct()` is the test
  // that proves two coordinated corrections cannot interleave. Here the point is Batch V's: both
  // reads are answered from the store as it stood, and neither instance's guard sees the other.
  const [byFirst, bySecond] = await Promise.all([first.log.loadForAppend(), second.log.loadForAppend()]);
  assert.equal(byFirst.records.length, 1);
  assert.equal(bySecond.records.length, 1, 'neither instance was handed a view with a record missing');

  const replacement = (content) => memoryRecord(content, {
    provenance: { origin: 'user_memory_correction', updateMode: 'user_confirmed', replaces: [target.id] },
  });
  await first.log.append(replacement('My favourite colour is green'));
  await second.log.append(replacement('My favourite colour is red'));

  const authoritative = await replay(file, validateMemoryRecord);
  assert.equal(authoritative.records.length, 3);
  assert.equal(
    authoritative.records.filter((r) => r.provenance?.replaces?.includes(target.id)).length,
    2,
    'both corrections landed: two writes that share no claim can duplicate a lifecycle event',
  );

  // What Batch V guarantees about that log is the thing under test: neither instance keeps a state
  // that hides what the other wrote. Each re-derives, and each derived view equals the replay.
  const afterFirst = await assertDerivedEqualsLog(first, validateMemoryRecord, 'the first instance');
  assert.equal(afterFirst.records.length, 3);
  assert.deepEqual(
    { reuses: statsFor(first).reuses, rebuilds: statsFor(first).rebuilds, tracked: statsFor(first).trackedRecords },
    { reuses: 1, rebuilds: 1, tracked: 3 },
    'the interleaved read was a legitimate reuse; the foreign append was not',
  );
  await assertDerivedEqualsLog(second, validateMemoryRecord, 'the second instance');
  assert.deepEqual(
    { reuses: statsFor(second).reuses, rebuilds: statsFor(second).rebuilds },
    { reuses: 0, rebuilds: 2 },
    'an instance never writes blindly from a state it cannot verify',
  );
});
