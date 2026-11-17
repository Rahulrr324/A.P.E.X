// Implementation Batch U: the world-state read optimization must not weaken cognition.
//
// Batch U removed duplicate whole-file reads and added an optional, per-process derived
// parse snapshot keyed by the SHA-256 of the exact file bytes. These tests pin the five
// properties that make that safe:
//   1. a cached read and a cold read return the same records, the same damage, and the same
//      projection — the snapshot is a performance aid, never a second source of truth;
//   2. any change to the stored bytes invalidates it, including a change that keeps the file
//      exactly the same length, which a size- or mtime-based check would silently miss;
//   3. damage and unavailability are re-reported rather than masked by a healthy result;
//   4. independent verification still re-reads, so a write that lands between the two reads
//      fails verification instead of being confirmed;
//   5. a write pays no snapshot work at all. The read that inspects the store before writing is
//      the incremental validated read, which is accounted in `appendStateStats` and neither
//      consults nor rewrites the snapshot (its own safety is pinned in
//      tests/incremental-write-state.test.js); the read that follows the append skips snapshot
//      work too, because a match cannot exist against bytes this instance just changed. Each of
//      those reads still parses and validates the file exactly as it currently is, and the first
//      unchanged read after them both returns and stores the current file.
//
// All fixtures are temporary directories and controlled records. No test here touches a
// real user data directory, and no live model inference is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { JsonlStore } from '../src/memory/jsonl-store.js';
import { MemoryStore, sha256Hex, validateMemoryRecord, MEMORY_PARSE_CACHE_BYTES } from '../src/memory/memory-store.js';
import { KnowledgeStore, validateKnowledgeRecord } from '../src/knowledge/knowledge-store.js';
import { buildWorldState, renderWorldState } from '../src/world/world-state.js';
import { worldActions } from '../src/actions/world-actions.js';
import { Verifier } from '../src/verify/verifier.js';
import { Outcome } from '../src/outcomes.js';

const AT = '2026-02-02T00:00:00.000Z';
const FIXED_NOW = () => new Date(AT);
const PROVENANCE = { origin: 'user_request', updateMode: 'user_confirmed' };

function tempDir() {
  return makeTempDataDir();
}

function envFor(dataDir) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
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

function memoryRecord(content, createdAt = AT) {
  return {
    schema: 1,
    id: randomUUID(),
    kind: 'user_fact',
    source: 'user',
    sensitivity: 'normal',
    content,
    contentSha256: sha256Hex(content),
    createdAt,
    provenance: PROVENANCE,
  };
}

// Memory records are written through the store so the stored shape is the real one.
async function seedMemory(dir, contents) {
  const store = new MemoryStore(memoryPath(dir), { now: FIXED_NOW });
  for (const content of contents) {
    await store.add({ content, source: 'user', provenance: { origin: 'user_request' } });
  }
  return store;
}

async function seedKnowledge(dir, triples) {
  const store = new KnowledgeStore(knowledgePath(dir), { now: FIXED_NOW });
  const ids = [];
  for (const triple of triples) {
    const { record } = await store.add({ ...triple, origin: 'user' });
    ids.push(record.id);
  }
  return { store, ids };
}

function ctxFor(memory, knowledge) {
  return { memory, knowledge, now: FIXED_NOW };
}

const definition = worldActions()[0];
const verifier = new Verifier();

// ---- group A: the derived snapshot returns exactly what a cold read returns ------------

test('performance - a cold memory read and a warm memory read are identical', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  await seedMemory(dir, ['The build runs on Node 26', 'The registry is private']);
  // A new instance: no snapshot carried over, so the counters start at zero.
  const store = new MemoryStore(memoryPath(dir), { now: FIXED_NOW });

  assert.equal(store.log.parseCacheStats.enabled, true);
  assert.equal(store.log.parseCacheStats.cached, false, 'a new store instance holds no snapshot');
  assert.equal(store.log.parseCacheStats.hits, 0);
  assert.equal(store.log.parseCacheStats.misses, 0);

  const cold = await store.log.load();
  assert.equal(store.log.parseCacheStats.cached, true);
  assert.equal(store.log.parseCacheStats.misses, 1);
  assert.equal(store.log.parseCacheStats.hits, 0);

  const warm = await store.log.load();
  assert.deepEqual(warm, cold, 'the snapshot must not change what a read returns');
  assert.equal(store.log.parseCacheStats.hits, 1);
  // AP-12: a hit returns its own list around the snapshot's deeply frozen records. A caller can
  // reorder or extend its list, but cannot edit a record the snapshot still holds, so the old
  // copy-per-hit guarantee is replaced by immutability rather than dropped.
  assert.notEqual(warm.records, cold.records, 'each read gets its own list');
  assert.equal(warm.records[0], cold.records[0], 'the records are shared, not copied');
  assert.ok(Object.isFrozen(warm.records[0]), 'a shared record is frozen');
  assert.ok(Object.isFrozen(warm.records[0].provenance), 'a nested field is frozen too');
  assert.throws(() => { warm.records[0].content = 'tampered'; }, TypeError);
  warm.records.reverse();
  const reread = await store.log.load();
  assert.equal(reread.records[0], cold.records[0], 'the snapshot kept its own order and record');
  assert.equal(reread.records[0].content, 'The build runs on Node 26');

  const coldHealth = await store.health();
  const warmHealth = await store.health();
  assert.deepEqual(warmHealth, coldHealth);

  const read = await store.projectionRead({ limit: 10, includePrivate: true });
  assert.deepEqual(read.records.map((record) => record.content), ['The registry is private', 'The build runs on Node 26']);
  assert.equal(read.health.records, 2);
});

test('performance - a cold knowledge read and a warm knowledge read are identical', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const { store } = await seedKnowledge(dir, [
    { subject: 'Meeting', relationship: 'room', object: 'Birch' },
    { subject: 'Meeting', relationship: 'room', object: 'Cedar', evidence: 'email update' },
  ]);

  // The first read follows this instance's own append, so it re-parses without snapshot
  // work; the second read populates the snapshot and the third is served from it.
  await store.list({ limit: 20 });
  const cold = await store.list({ limit: 20 });
  const coldHealth = await store.health();
  assert.ok(store.log.parseCacheStats.hits >= 1, 'a repeated unchanged read is served from the snapshot');

  const warm = await store.list({ limit: 20 });
  assert.deepEqual(warm, cold);
  assert.deepEqual(await store.health(), coldHealth);
});

test('performance - repeated unchanged projection reads are identical and served warm', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['The build runs on Node 26']);
  const { store: knowledge } = await seedKnowledge(dir, [{ subject: 'Meeting', relationship: 'room', object: 'Birch' }]);

  const first = await buildWorldState(ctxFor(memory, knowledge));
  const second = await buildWorldState(ctxFor(memory, knowledge));
  const third = await buildWorldState(ctxFor(memory, knowledge));
  assert.deepEqual(second, first, 'an unchanged store must produce an unchanged projection');
  assert.deepEqual(third, first);

  const hits = memory.log.parseCacheStats.hits + knowledge.log.parseCacheStats.hits;
  assert.ok(hits > 0, 'the repeated read used the snapshot, which is the point of the optimization');
});

test('performance - a memory append is reflected in the next projection', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['The build runs on Node 26']);
  const { store: knowledge } = await seedKnowledge(dir, [{ subject: 'Meeting', relationship: 'room', object: 'Birch' }]);

  const before = await buildWorldState(ctxFor(memory, knowledge));
  const added = await memory.add({ content: 'The deploy target is staging', source: 'user', provenance: { origin: 'user_request' } });
  const after = await buildWorldState(ctxFor(memory, knowledge));

  assert.ok(after.beliefs.userAsserted.some((belief) => belief.id === added.id), 'a new user belief must appear immediately');
  assert.equal(after.counts.userAsserted, before.counts.userAsserted + 1);
  assert.notDeepEqual(after, before);

  // The read right after a write is a full re-parse and deliberately does not maintain the
  // snapshot. The next unchanged read must therefore agree with it and then describe the
  // current file: a write is never answered from the pre-write snapshot.
  const refreshed = await buildWorldState(ctxFor(memory, knowledge));
  assert.deepEqual(refreshed, after, 'deferring snapshot work cannot change what a read returns');
  assert.equal(memory.log.parseCacheStats.cachedRecords, 2, 'the snapshot describes the file, not the moment it was first read');
});

test('performance - a knowledge append is reflected in the next projection', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['The build runs on Node 26']);
  const { store: knowledge, ids } = await seedKnowledge(dir, [{ subject: 'Meeting', relationship: 'room', object: 'Birch' }]);

  const before = await buildWorldState(ctxFor(memory, knowledge));
  assert.equal(before.counts.unresolvedConflicts, 0);

  const { record: second } = await knowledge.add({ subject: 'Meeting', relationship: 'room', object: 'Cedar', origin: 'user' });
  const after = await buildWorldState(ctxFor(memory, knowledge));

  assert.equal(after.counts.unresolvedConflicts, 1, 'a conflicting claim must surface without a restart');
  const group = after.contradictions.find((candidate) => candidate.kind === 'knowledge');
  assert.equal(group.state, 'unresolved');
  assert.deepEqual(group.claimIds, [ids[0], second.id].sort());
});

test('performance - a memory correction is reflected, and the corrected claim becomes history', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['My favourite colour is blue']);
  const [original] = await memory.list({ limit: 5 });
  const { store: knowledge } = await seedKnowledge(dir, []);

  const before = await buildWorldState(ctxFor(memory, knowledge));
  assert.equal(before.counts.memoryConflictGroups, 0);

  await memory.correct({ targetId: original.id, content: 'My favourite colour is green', origin: 'user' });
  const after = await buildWorldState(ctxFor(memory, knowledge));

  const ids = after.beliefs.userAsserted.map((belief) => belief.id);
  assert.ok(!ids.includes(original.id), 'a superseded memory record is not a current belief');
  assert.equal(ids.length, 1);
  assert.equal(after.beliefs.userAsserted[0].statement, 'My favourite colour is green');
  assert.equal(after.sources.memory.records, 2, 'the correction is stored, so the count must still include it');
});

test('performance - a memory contradiction between two live records is detected on the next read', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['My favourite colour is blue']);
  await memory.add({ content: 'My favourite colour is green', source: 'user', provenance: { origin: 'user_request' } });
  const { store: knowledge } = await seedKnowledge(dir, []);

  const first = await buildWorldState(ctxFor(memory, knowledge));
  assert.equal(first.counts.memoryConflictGroups, 1);
  assert.equal(first.attention, true);

  const second = await buildWorldState(ctxFor(memory, knowledge));
  assert.deepEqual(second, first, 'the same contradiction is reported the same way on a warm read');
});

test('performance - a knowledge retraction is reflected in the next projection', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['The build runs on Node 26']);
  const { store: knowledge, ids } = await seedKnowledge(dir, [
    { subject: 'Contract', relationship: 'status', object: 'active' },
  ]);

  const before = await buildWorldState(ctxFor(memory, knowledge));
  assert.ok(before.beliefs.userAsserted.some((belief) => belief.id === ids[0]));

  await knowledge.retract({ target: ids[0], reason: 'contract ended', origin: 'user' });
  const after = await buildWorldState(ctxFor(memory, knowledge));

  assert.ok(!after.beliefs.userAsserted.map((belief) => belief.id).includes(ids[0]), 'a retracted claim is not current');
  assert.equal(after.history.retracted, 1, 'it is still reported as history');
});

test('performance - a recorded resolution is reflected, and stays a decision rather than truth', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['The build runs on Node 26']);
  const { store: knowledge, ids } = await seedKnowledge(dir, [
    { subject: 'Meeting', relationship: 'room', object: 'Birch' },
    { subject: 'Meeting', relationship: 'room', object: 'Cedar' },
  ]);

  const before = await buildWorldState(ctxFor(memory, knowledge));
  assert.equal(before.counts.unresolvedConflicts, 1);
  assert.equal(before.counts.resolvedConflicts, 0);

  await knowledge.resolve({ target: ids[0], choose: ids[1], reason: 'reception confirmed', origin: 'user' });
  const after = await buildWorldState(ctxFor(memory, knowledge));

  assert.equal(after.counts.unresolvedConflicts, 0);
  assert.equal(after.counts.resolvedConflicts, 1);
  const group = after.contradictions.find((candidate) => candidate.kind === 'knowledge');
  assert.equal(group.state, 'resolved');
  assert.equal(group.chosenId, ids[1]);
  assert.match(renderWorldState(after), /a decision, not verified truth/);
  assert.ok(
    after.beliefs.userAsserted.map((belief) => belief.id).includes(ids[0]),
    'resolving a conflict must not retire the rejected claim',
  );
});

test('performance - a model conclusion keeps its epistemic class on a warm read', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['The user prefers terse answers']);
  const { store: knowledge } = await seedKnowledge(dir, []);

  await memory.add({
    content: 'The user probably wants shorter output',
    kind: 'model_conclusion',
    source: 'model',
    provenance: { origin: 'model_output', operationId: 'op-1', backend: 'stub' },
  });
  const first = await buildWorldState(ctxFor(memory, knowledge));
  assert.equal(first.counts.userAsserted, 1);
  assert.equal(first.counts.unverifiedModel, 1);

  const second = await buildWorldState(ctxFor(memory, knowledge));
  assert.deepEqual(second, first, 'warm and cold reads must classify provenance identically');
  assert.ok(second.unknowns.some((u) => /unverified_model|unverified; they are not treated/.test(u.detail)));
});

test('performance - a new store instance reads the same projection, with or without a snapshot', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['The build runs on Node 26', 'The registry is private']);
  const { store: knowledge } = await seedKnowledge(dir, [{ subject: 'Meeting', relationship: 'room', object: 'Birch' }]);

  const warm = await buildWorldState(ctxFor(memory, knowledge));
  const again = await buildWorldState(ctxFor(memory, knowledge));
  assert.deepEqual(again, warm);
  assert.equal(memory.log.parseCacheStats.cached, true, 'the unchanged read after the write refreshes the snapshot');

  // A restart: nothing carried over, so every read is cold. The projection must be the same.
  const restarted = await buildWorldState(ctxFor(
    new MemoryStore(memoryPath(dir), { now: FIXED_NOW }),
    new KnowledgeStore(knowledgePath(dir), { now: FIXED_NOW }),
  ));
  assert.deepEqual(restarted, warm, 'a cold process must not see a different world than a warm one');

  // And a snapshot cannot be kept alive by an instance that no longer owns the file: the
  // restarted instance sees an appended record immediately.
  await memory.add({ content: 'The deploy target is staging', source: 'user', provenance: { origin: 'user_request' } });
  const afterAppend = await buildWorldState(ctxFor(
    new MemoryStore(memoryPath(dir), { now: FIXED_NOW }),
    new KnowledgeStore(knowledgePath(dir), { now: FIXED_NOW }),
  ));
  assert.equal(afterAppend.counts.representedBeliefs, restarted.counts.representedBeliefs + 1);
});

// ---- group B: external modification of the stored bytes ---------------------------------

test('performance - a same-length external rewrite invalidates the snapshot', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const record = memoryRecord('The deploy target is staging');
  fs.writeFileSync(file, line(record), 'utf8');

  const store = new MemoryStore(file, { now: FIXED_NOW });
  const { store: knowledge } = await seedKnowledge(dir, []);
  const before = await buildWorldState(ctxFor(store, knowledge));
  assert.match(renderWorldState(before), /The deploy target is staging/);
  assert.equal(store.log.parseCacheStats.misses, 1);
  assert.equal(store.log.parseCacheStats.hits, 0);

  // Same id, same byte length, different content and its matching hash: a cache keyed on
  // size or mtime would keep serving the old record here.
  const replacement = 'The deploy target is prod-01';
  const rewrittenLine = line({ ...record, content: replacement, contentSha256: sha256Hex(replacement) });
  assert.equal(rewrittenLine.length, fs.readFileSync(file, 'utf8').length, 'the fixture must stay exactly the same length');
  fs.writeFileSync(file, rewrittenLine, 'utf8');

  const after = await buildWorldState(ctxFor(store, knowledge));
  assert.match(renderWorldState(after), /The deploy target is prod-01/);
  assert.doesNotMatch(renderWorldState(after), /staging/, 'the replaced belief must not be reported as current');
  assert.equal(store.log.parseCacheStats.misses, 2, 'the changed bytes were parsed and validated again');
  assert.equal(store.log.parseCacheStats.cachedBytes, fs.statSync(file).size, 'the snapshot describes the rewritten file');
});

test('performance - an externally replaced store file is read fresh', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = await seedMemory(dir, ['The build runs on Node 26']);
  const { store: knowledge } = await seedKnowledge(dir, []);
  const before = await buildWorldState(ctxFor(store, knowledge));
  assert.equal(before.counts.representedBeliefs, 1);

  const replacement = memoryRecord('An entirely different belief written by another process');
  fs.writeFileSync(file, line(replacement), 'utf8');

  const after = await buildWorldState(ctxFor(store, knowledge));
  assert.equal(after.counts.representedBeliefs, 1);
  const [belief] = after.beliefs.userAsserted;
  assert.equal(belief.statement, 'An entirely different belief written by another process');
  assert.equal(belief.id, replacement.id, 'the old record id must not survive a file replacement');
  assert.notEqual(after.beliefs.userAsserted[0].id, before.beliefs.userAsserted[0].id);
});

test('performance - a truncated tail is reported, not hidden by a healthy cached read', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = await seedMemory(dir, ['The build runs on Node 26']);
  const { store: knowledge } = await seedKnowledge(dir, []);
  const healthy = await buildWorldState(ctxFor(store, knowledge));
  assert.equal(healthy.complete, true);
  // One unchanged read later the snapshot is populated: that is the healthy cached state the
  // damage must not be hidden behind.
  await buildWorldState(ctxFor(store, knowledge));
  assert.equal(store.log.parseCacheStats.cached, true);

  // What an interrupted append leaves behind: a partial line with no terminating newline.
  fs.appendFileSync(file, '{"schema":1,"id":"partial', 'utf8');

  const damaged = await buildWorldState(ctxFor(store, knowledge));
  assert.equal(damaged.complete, false, 'a cached healthy read cannot outrank the damage on disk');
  assert.equal(damaged.attention, true);
  assert.equal(damaged.sources.memory.corruptLines, 1);
  assert.ok(damaged.unknowns.some((u) => /corrupt line/.test(u.detail)));
  assert.match(renderWorldState(damaged), /corrupt/);

  const cli = await runCli(['world'], envFor(dir));
  assert.equal(cli.code, 1, 'a damaged store is not a healthy world');
});

test('performance - a corrupt record added after a healthy read is not masked', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = await seedMemory(dir, ['The build runs on Node 26', 'The registry is private']);
  const { store: knowledge } = await seedKnowledge(dir, []);
  const healthy = await buildWorldState(ctxFor(store, knowledge));
  assert.equal(healthy.sources.memory.records, 2);

  // Valid JSON, but a record the validator rejects: integrity checking must still run.
  fs.appendFileSync(file, line({ schema: 1, id: randomUUID(), kind: 'nonsense', source: 'user' }), 'utf8');

  const damaged = await buildWorldState(ctxFor(store, knowledge));
  assert.equal(damaged.sources.memory.corruptLines, 1);
  assert.equal(damaged.complete, false);
  assert.equal(damaged.counts.representedBeliefs, 0, 'a damaged store yields no beliefs rather than a partial list');
  assert.deepEqual(damaged.beliefs.userAsserted, []);
});

test('performance - an unreadable store is never reported healthy from a previous read', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = await seedMemory(dir, ['The build runs on Node 26']);
  const { store: knowledge } = await seedKnowledge(dir, []);
  const healthy = await buildWorldState(ctxFor(store, knowledge));
  assert.equal(healthy.complete, true);
  // One unchanged read later the snapshot is populated: that is the healthy cached state the
  // damage must not be hidden behind.
  await buildWorldState(ctxFor(store, knowledge));
  assert.equal(store.log.parseCacheStats.cached, true);

  const saved = fs.readFileSync(file, 'utf8');
  fs.rmSync(file);
  fs.mkdirSync(file);
  try {
    const unavailable = await buildWorldState(ctxFor(store, knowledge));
    assert.equal(unavailable.complete, false);
    assert.equal(unavailable.attention, true);
    assert.equal(unavailable.sources.memory.inspected, false);
    assert.equal(unavailable.counts.representedBeliefs, 0, 'cached beliefs must not be presented as current');
    assert.deepEqual(unavailable.beliefs.userAsserted, []);
    assert.ok(unavailable.unknowns.some((u) => /memory store is unavailable/.test(u.detail)));

    // Reproducible does not mean healthy: the second read agrees, and both say incomplete.
    const executed = await definition.execute(ctxFor(store, knowledge), { limit: undefined });
    const verified = await definition.verify(ctxFor(store, knowledge), { limit: undefined }, executed);
    assert.equal(verified.ok, true, 'the unavailable projection is what a fresh read also reports');
    assert.equal(executed.data.complete, false, 'and it is never reported as a healthy world');
    assert.equal(executed.data.beliefIds.length, 0);
  } finally {
    fs.rmdirSync(file);
    fs.writeFileSync(file, saved, 'utf8');
  }

  const recovered = await buildWorldState(ctxFor(store, knowledge));
  assert.deepEqual(recovered, healthy, 'once the file is readable again the same beliefs return');
});

test('performance - a deleted store file reads as empty, not as its last cached contents', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  const store = await seedMemory(dir, ['The build runs on Node 26']);
  const { store: knowledge } = await seedKnowledge(dir, []);
  assert.equal((await buildWorldState(ctxFor(store, knowledge))).counts.representedBeliefs, 1);

  fs.rmSync(file);
  const emptied = await buildWorldState(ctxFor(store, knowledge));
  assert.equal(emptied.counts.representedBeliefs, 0);
  assert.equal(emptied.sources.memory.records, 0);
  assert.equal(emptied.complete, true, 'an absent file is a defined empty store, not a damaged one');
});

// ---- group C: verification, concurrency, bounds ------------------------------------------

test('performance - a write between the executed read and the verifying read fails verification', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['The build runs on Node 26']);
  const { store: knowledge } = await seedKnowledge(dir, [{ subject: 'Meeting', relationship: 'room', object: 'Birch' }]);
  const ctx = ctxFor(memory, knowledge);

  const executed = await definition.execute(ctx, { limit: undefined });
  assert.equal(executed.data.beliefIds.length, 2, 'one memory belief and one knowledge claim');

  // The write lands after the projection was built and before it is verified.
  await memory.add({ content: 'A belief recorded between the two reads', source: 'user', provenance: { origin: 'user_request' } });

  const step = await definition.verify(ctx, { limit: undefined }, executed);
  assert.equal(step.ok, false, 'the second read must see the new record and disagree with the first projection');
  assert.match(step.detail, /second read produced a different world-state projection/);

  const checked = await verifier.check(definition, ctx, { limit: undefined }, executed);
  assert.equal(checked.outcome, Outcome.VERIFICATION_FAILED);
  assert.notEqual(checked.outcome, Outcome.SUCCESS_VERIFIED);

  // Re-running the whole step now that the stores are stable confirms verification again.
  const fresh = await definition.execute(ctx, { limit: undefined });
  assert.equal(fresh.data.beliefIds.length, 3, 'the appended belief is now in both reads');
  assert.equal((await definition.verify(ctx, { limit: undefined }, fresh)).ok, true);
});

test('performance - verification does not compare a cached projection with itself', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['The build runs on Node 26']);
  const { store: knowledge } = await seedKnowledge(dir, []);
  const ctx = ctxFor(memory, knowledge);

  const executed = await definition.execute(ctx, { limit: undefined });
  // The execute read is the one that follows the seeding write, and the verification that
  // follows it is the first unchanged read. Measure a later verification, when the store is
  // stable, so the count being compared is a real second read of the same bytes.
  await definition.verify(ctx, { limit: undefined }, executed);
  const before = memory.log.parseCacheStats;
  const verified = await definition.verify(ctx, { limit: undefined }, executed);
  const after = memory.log.parseCacheStats;

  assert.equal(verified.ok, true);
  assert.equal(after.hits, before.hits + 1, 'verification issues its own store read instead of reusing the result');

  // Proof that verification rebuilds rather than re-derives: a tampered result disagrees
  // with the fresh read even though the stores never changed.
  const tampered = { ...executed, data: { ...executed.data, counts: { ...executed.data.counts, userAsserted: 999 } } };
  const recheck = await definition.verify(ctx, { limit: undefined }, tampered);
  assert.equal(recheck.ok, false, 'a cached result cannot be confirmed by re-reading the same cached result');
});

test('performance - a caller cannot poison the snapshot by mutating the records it was handed', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['The build runs on Node 26']);
  const { store: knowledge } = await seedKnowledge(dir, []);

  const first = await memory.list({ limit: 10, includePrivate: true });
  assert.equal(first.length, 1);
  // Mutate everything a projection reads, at every depth the schema uses. The list hands out
  // copies, so the top level is writable; the nested objects are shared with the store's
  // retained records and are frozen, which is what makes that sharing safe.
  first[0].content = 'Overwritten by a caller';
  first[0].source = 'model';
  first[0].kind = 'model_conclusion';
  assert.throws(() => { first[0].provenance.origin = 'tampered'; }, TypeError, 'a retained nested field cannot be edited');
  first[0].replacedBy.push('ffffffff-1111-4111-8111-111111111111');
  first[0].status = 'superseded';

  const second = await memory.list({ limit: 10, includePrivate: true });
  assert.equal(second[0].content, 'The build runs on Node 26');
  assert.equal(second[0].provenance.updateMode, 'user_confirmed');
  assert.deepEqual(second[0].replacedBy, []);
  assert.notEqual(second[0].status, 'superseded');

  const world = await buildWorldState(ctxFor(memory, knowledge));
  assert.ok(world.beliefs.userAsserted.some((belief) => belief.statement === 'The build runs on Node 26'));
  assert.equal(world.counts.unverifiedModel, 0, 'a mutated copy cannot reclassify a stored user assertion');
});

test('performance - a write keeps one snapshot that its own next read reuses instead of re-parsing', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  fs.writeFileSync(file, line(memoryRecord('The build runs on Node 26')), 'utf8');

  // A store instance that has not written yet: its first read can and does populate.
  const store = new MemoryStore(file, { now: FIXED_NOW });
  const { store: knowledge } = await seedKnowledge(dir, []);
  const cold = await buildWorldState(ctxFor(store, knowledge));
  assert.equal(cold.counts.representedBeliefs, 1);
  const populated = store.log.parseCacheStats;
  assert.equal(populated.misses, 1);
  assert.equal(populated.cachedRecords, 1);
  assert.equal(
    store.log.appendStateStats.tracked,
    false,
    'a projection read is not a write read: it tracks nothing for the write path',
  );
  assert.deepEqual(
    { ...store.log.appendStateStats },
    { enabled: true, maxBytes: MEMORY_PARSE_CACHE_BYTES, tracked: false, trackedRecords: 0, trackedBytes: 0, reuses: 0, rebuilds: 0 },
  );

  await store.add({ content: 'The deploy target is staging', source: 'user', provenance: { origin: 'user_request' } });
  // The read a write performs is an incremental validated read, so it is accounted in
  // appendStateStats and not here at all: the snapshot is neither consulted (it describes bytes
  // about to be superseded) nor rewritten (copying records the store is about to invalidate is
  // work thrown away).
  const wrote = store.log.parseCacheStats;
  assert.equal(wrote.misses, 1, 'the write read is not a snapshot read');
  assert.equal(wrote.hits, 0);
  assert.equal(wrote.cachedRecords, 1, 'the snapshot still holds the pre-write file, which can only miss');
  assert.equal(store.log.appendStateStats.rebuilds, 1, 'the first write read on this instance derived the whole store');
  assert.equal(store.log.appendStateStats.reuses, 0);
  assert.equal(store.log.appendStateStats.trackedRecords, 2, 'and tracks both the record it derived and the one it appended');

  const afterWrite = await buildWorldState(ctxFor(store, knowledge));
  const deferred = store.log.parseCacheStats;
  assert.equal(deferred.misses, 1, 'the read after the append is not re-parsed: the write path validated exactly these bytes');
  assert.equal(deferred.hits, 1, 'it installs the validated records as the snapshot and is answered from them');
  assert.equal(deferred.cachedRecords, 2, 'so the snapshot describes the file as the append left it');
  assert.equal(afterWrite.counts.representedBeliefs, 2, 'the new record is read');

  const refreshed = await buildWorldState(ctxFor(store, knowledge));
  const refreshedStats = store.log.parseCacheStats;
  assert.equal(refreshedStats.misses, 1);
  assert.equal(refreshedStats.hits, 2);
  assert.equal(refreshedStats.cachedRecords, 2, 'an unchanged read is answered from that snapshot');
  assert.deepEqual(refreshed, afterWrite, 'reusing the write-path records changes nothing a reader sees');

  const hit = await buildWorldState(ctxFor(store, knowledge));
  assert.equal(store.log.parseCacheStats.hits, 3);
  assert.deepEqual(hit, afterWrite);

  // The next write on the same instance reuses what it already validated, and still leaves the
  // snapshot exactly where the last read put it.
  await store.add({ content: 'The rollback plan is the previous image', source: 'user', provenance: { origin: 'user_request' } });
  assert.deepEqual(
    { reuses: store.log.appendStateStats.reuses, rebuilds: store.log.appendStateStats.rebuilds, trackedRecords: store.log.appendStateStats.trackedRecords },
    { reuses: 1, rebuilds: 1, trackedRecords: 3 },
    'a second write on a warm instance reuses its validated records',
  );
  assert.deepEqual(store.log.parseCacheStats.cachedRecords, 2, 'and touched no snapshot');
});

test('external changes - a write reads the file as it is, never a snapshot of it', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = memoryPath(dir);
  fs.writeFileSync(file, line(memoryRecord('My favourite colour is blue')), 'utf8');
  const store = new MemoryStore(file, { now: FIXED_NOW });

  await store.list({ limit: 10 });
  assert.equal(store.log.parseCacheStats.cachedRecords, 1, 'a stable read populates the snapshot');

  // Another process replaced the whole file while this instance held a healthy snapshot.
  const external = memoryRecord('My favourite colour is blue');
  fs.writeFileSync(file, line(external), 'utf8');

  // The correction writes, so its read is the write-path kind. It must see the external
  // record: if the snapshot answered it, the target would look absent and the correction
  // would be refused against data that is actually on disk.
  const corrected = await store.correct({ targetId: external.id, content: 'My favourite colour is green', origin: 'user' });
  assert.deepEqual(corrected.provenance.replaces, [external.id]);
  assert.equal(store.log.parseCacheStats.hits, 0, 'the snapshot never answered a read of a changed file');

  const records = await store.list({ limit: 10 });
  assert.equal(records.length, 2);
  const rewritten = records.find((r) => r.id === external.id);
  assert.deepEqual(rewritten.replacedBy, [corrected.id], 'the correction retired the record the write read from disk');
});

test('performance - a store larger than the cap is never snapshotted and reads the same', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  await seedMemory(dir, ['The build runs on Node 26', 'The registry is private']);
  const file = memoryPath(dir);

  const uncached = new JsonlStore(file, { validateRecord: validateMemoryRecord });
  const tinyCache = new JsonlStore(file, { validateRecord: validateMemoryRecord, parseCacheBytes: 16 });

  const cold = await uncached.load();
  const first = await tinyCache.load();
  const second = await tinyCache.load();

  assert.deepEqual(first, cold, 'the cache changes no integrity rule');
  assert.deepEqual(second, cold);
  assert.equal(tinyCache.parseCacheStats.enabled, true);
  assert.equal(tinyCache.parseCacheStats.cached, false, 'a file over the cap is not snapshotted');
  assert.equal(tinyCache.parseCacheStats.hits, 0);
  assert.equal(tinyCache.parseCacheStats.cachedBytes, 0);
  assert.equal(uncached.parseCacheStats.enabled, false);
});

test('performance - a write loop keeps one bounded snapshot and accounts for every read exactly once', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['The build runs on Node 26']);

  const project = () => buildWorldState(ctxFor(memory, new KnowledgeStore(knowledgePath(dir), { now: FIXED_NOW })));
  let reads = 0;
  for (let i = 0; i < 12; i += 1) {
    await memory.add({ content: `Repeated belief ${i}`, source: 'user', provenance: { origin: 'user_request' } });
    const projection = await project();
    reads += 1;
    assert.equal(projection.complete, true, `read ${i} of ${reads}`);
  }

  // The 24 reads here are 12 write reads and 12 projection reads, and each is accounted for in
  // exactly one place: the write reads in appendStateStats, the projection reads in
  // parseCacheStats. A projection read that had to re-parse would show up as a miss; it does not,
  // because the write read immediately before it validated exactly the bytes it finds.
  const stats = memory.log.parseCacheStats;
  const writes = memory.log.appendStateStats;
  assert.equal(stats.misses, 0, 'no projection read re-parses: each follows a write that validated the same bytes');
  assert.equal(stats.hits, 12, 'every projection read is answered from the state the write left');
  assert.equal(stats.misses + stats.hits, 12, 'every snapshot-eligible read is accounted for exactly once');
  assert.equal(writes.reuses + writes.rebuilds, 12, 'and every write read is accounted for once, in its own counter');
  assert.equal(writes.reuses, 12, 'this instance wrote the whole store, so every write read after the seed reused what it had validated');
  assert.equal(writes.rebuilds, 0, 'nothing arrived from outside, so nothing had to be derived again');
  assert.ok(stats.cachedBytes <= stats.maxBytes, 'the snapshot is bounded by the configured cap');
  assert.ok(writes.trackedBytes <= writes.maxBytes, 'and so is the incremental validated state');
  assert.equal(stats.cachedRecords, 13, 'the snapshot describes the seed plus the twelve appends');

  // Two reads now that the writes have stopped, both answered from the snapshot the last
  // projection installed. Nothing was written during either read, so the projection they return
  // is the same one the write loop last saw.
  const refreshed = await project();
  const populated = memory.log.parseCacheStats;
  assert.equal(populated.hits, 13, 'a read after the loop finds the file unchanged');
  assert.equal(populated.cachedRecords, 13, 'and the snapshot still describes the seed plus the 12 appends');
  assert.equal(populated.cached, true);
  const warmed = await project();
  assert.equal(memory.log.parseCacheStats.hits, 14, 'the next unchanged read is served from it');
  assert.deepEqual(warmed, refreshed);
  // The snapshot that just answered a read says nothing about the write state: the records the
  // loop tracked are still tracked, and the next write still verifies the file's bytes.
  assert.deepEqual(
    { reuses: memory.log.appendStateStats.reuses, rebuilds: memory.log.appendStateStats.rebuilds, trackedRecords: memory.log.appendStateStats.trackedRecords },
    { reuses: 12, rebuilds: 0, trackedRecords: 13 },
    'a projection read neither consumes nor rebuilds the write state',
  );
});

test('performance - stores that never opt in keep reporting the snapshot disabled', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = createApp({ dataDir: dir, now: FIXED_NOW, gateway: new ModelGateway({ backend: new NoBackend() }) });
  await app.controller.runAction('memory.add', { content: 'The build runs on Node 26' }, 'user', 'op-seed');
  await app.controller.worldState();

  assert.equal(app.memory.log.parseCacheStats.enabled, true);
  assert.equal(app.knowledge.log.parseCacheStats.enabled, true);
  assert.equal(app.conversation.log.parseCacheStats.enabled, false, 'conversation turns are not projected');
  assert.equal(app.operations.store.parseCacheStats.enabled, false, 'the audit log is not projected');
  assert.equal(app.taskStore.log.parseCacheStats.enabled, false, 'task events are not projected');
});

test('performance - projection reads never write, even when the snapshot is being maintained', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const memory = await seedMemory(dir, ['The build runs on Node 26', 'The registry is private']);
  const { store: knowledge } = await seedKnowledge(dir, [
    { subject: 'Meeting', relationship: 'room', object: 'Birch' },
    { subject: 'Meeting', relationship: 'room', object: 'Cedar' },
  ]);
  const memoryFile = memoryPath(dir);
  const knowledgeFile = knowledgePath(dir);
  const beforeMemory = fs.readFileSync(memoryFile, 'utf8');
  const beforeKnowledge = fs.readFileSync(knowledgeFile, 'utf8');
  const beforeHealth = { memory: await memory.health(), knowledge: await knowledge.health() };

  for (let i = 0; i < 6; i += 1) {
    const world = await buildWorldState(ctxFor(memory, knowledge));
    await renderWorldState(world);
    await definition.execute(ctxFor(memory, knowledge), { limit: undefined });
    await definition.verify(ctxFor(memory, knowledge), { limit: undefined }, await definition.execute(ctxFor(memory, knowledge), { limit: undefined }));
  }

  assert.equal(fs.readFileSync(memoryFile, 'utf8'), beforeMemory, 'the authoritative memory file is untouched');
  assert.equal(fs.readFileSync(knowledgeFile, 'utf8'), beforeKnowledge, 'the authoritative knowledge file is untouched');
  assert.deepEqual(await memory.health(), beforeHealth.memory);
  assert.deepEqual(await knowledge.health(), beforeHealth.knowledge);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['knowledge.jsonl', 'memory.jsonl'], 'and no side files appear');
});
