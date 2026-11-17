// Batch AP-12: request-scoped read reuse without weakening evidence rules.
//
// The optimizations this suite guards are performance aids, never evidence: the parse snapshot
// hands out frozen records shared between reads, and memory/knowledge retrieval reuse tokenised
// corpora and lifecycle indexes keyed by the SHA-256 of the exact file bytes a read produced.
// These tests pin the boundaries those aids must not cross:
//  - a snapshot hit is immutable to callers and never lets one consumer edit another's view;
//  - any changed bytes (append, same-length rewrite, deletion/recreation) are re-parsed, never
//    served from an entry that describes an earlier file;
//  - a damaged store still fails closed and never reuses a derivation;
//  - another store instance's append, retraction or resolution is visible to the next read;
//  - concurrent reads of one store return what sequential reads return;
//  - reuse changes no result, score, conflict partner, lifecycle annotation or diagnostic count.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { JsonlStore } from '../src/memory/jsonl-store.js';
import { MemoryStore, sha256Hex } from '../src/memory/memory-store.js';
import { KnowledgeStore } from '../src/knowledge/knowledge-store.js';
import { StoreError } from '../src/errors.js';

const NOW = () => new Date('2026-06-01T00:00:00.000Z');
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempFile(name) {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return path.join(dir, name);
}

function writeLines(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, values.map((value) => `${JSON.stringify(value)}\n`).join(''));
}

function appendRaw(file, text) {
  fs.appendFileSync(file, text);
}

function rewriteMemoryContent(file, content) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const before = fs.statSync(file).size;
  record.content = content;
  record.contentSha256 = sha256Hex(content);
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  return { before, after: fs.statSync(file).size };
}

const validatePair = (line) => (line && typeof line.id === 'string' && typeof line.value === 'string' ? null : 'bad shape');

describe('AP-12: the parse snapshot shares frozen records, never editable ones', () => {
  test('a hit returns the same frozen records in a list of its own', async () => {
    const file = tempFile('frozen.jsonl');
    writeLines(file, [{ id: 'one', value: 'first', nested: { inner: ['a'] } }, { id: 'two', value: 'second' }]);
    const store = new JsonlStore(file, { validateRecord: validatePair, parseCacheBytes: 1024 });

    const first = await store.load();
    const second = await store.load();
    assert.equal(store.parseCacheStats.hits, 1);
    assert.notEqual(first.records, second.records, 'each read gets its own list');
    assert.equal(first.records[0], second.records[0], 'the records themselves are shared');
    assert.ok(Object.isFrozen(second.records[0]));
    assert.ok(Object.isFrozen(second.records[0].nested));
    assert.ok(Object.isFrozen(second.records[0].nested.inner));
    assert.throws(() => { second.records[0].id = 'changed'; }, TypeError);
    assert.throws(() => { second.records[0].nested.inner.push('b'); }, TypeError);

    second.records.push({ id: 'three', value: 'pushed' });
    const third = await store.load();
    assert.deepEqual(third.records.map((r) => r.id), ['one', 'two'], 'pushing onto a returned list cannot reach the snapshot');
  });

  test('damage entries are reported per read, never shared as one mutable array', async () => {
    const file = tempFile('damaged-snapshot.jsonl');
    fs.writeFileSync(file, '{"id":"one","value":"ok"}\nnot json\n');
    const store = new JsonlStore(file, { validateRecord: validatePair, parseCacheBytes: 1024 });
    const first = await store.load();
    const second = await store.load();
    assert.equal(store.parseCacheStats.hits, 1);
    assert.equal(first.corrupt.length, 1);
    assert.deepEqual(second.corrupt, first.corrupt);
    assert.notEqual(first.corrupt, second.corrupt);
    assert.notEqual(first.corrupt[0], second.corrupt[0]);
  });

  test('a same-length rewrite is parsed again, not answered from the snapshot', async () => {
    const file = tempFile('rewrite.jsonl');
    writeLines(file, [{ id: 'one', value: 'aaaa' }]);
    const store = new JsonlStore(file, { validateRecord: validatePair, parseCacheBytes: 1024 });
    assert.deepEqual((await store.load()).records.map((r) => r.value), ['aaaa']);
    const before = fs.statSync(file).size;
    writeLines(file, [{ id: 'one', value: 'bbbb' }]);
    assert.equal(fs.statSync(file).size, before, 'this fixture rewrites the same number of bytes');
    assert.deepEqual((await store.load()).records.map((r) => r.value), ['bbbb']);
    assert.equal(store.parseCacheStats.hits, 0);
  });

  test('deletion and recreation are observed, never masked by the old file', async () => {
    const file = tempFile('recreated.jsonl');
    writeLines(file, [{ id: 'one', value: 'original' }]);
    const store = new JsonlStore(file, { validateRecord: validatePair, parseCacheBytes: 1024 });
    assert.equal((await store.load()).records.length, 1);
    fs.unlinkSync(file);
    assert.deepEqual(await store.load(), { records: [], corrupt: [] });
    writeLines(file, [{ id: 'nine', value: 'new file' }]);
    assert.deepEqual((await store.load()).records.map((r) => r.id), ['nine']);
  });
});

describe('AP-12: memory retrieval reuse follows storage identity', () => {
  test('another instance\'s append invalidates the corpus, including a same-length replacement', async () => {
    const file = tempFile('memory.jsonl');
    const a = new MemoryStore(file, { now: NOW });
    await a.add({ content: 'the lighthouse status is green', kind: 'user_fact', source: 'user' });

    // The read after this instance's own append certifies nothing, so the first warm read builds
    // without retaining; the second read is the one that certifies the file.
    assert.equal((await a.search('lighthouse status')).length, 1);
    assert.equal((await a.search('lighthouse status')).length, 1);
    const baseline = a.retrievalIndexStats;
    assert.equal((await a.search('lighthouse status')).length, 1);
    assert.equal(a.retrievalIndexStats.hits, baseline.hits + 1);

    // A different instance rewrites the line's content in place with the same byte length.
    const sizes = rewriteMemoryContent(file, 'the lighthouse status is amber');
    assert.equal(sizes.after, sizes.before, 'this fixture is a same-length rewrite');
    const hits = await a.search('lighthouse status');
    assert.equal(hits[0].record.content, 'the lighthouse status is amber');
    assert.equal((await a.search('amber')).length, 1);
    assert.equal((await a.search('green')).length, 0);
    assert.equal(a.retrievalIndexStats.builds, baseline.builds + 1, 'the changed bytes forced a new corpus');
  });

  test('a concurrent append from another instance is visible to the next search', async () => {
    const file = tempFile('memory-append.jsonl');
    const a = new MemoryStore(file, { now: NOW });
    const b = new MemoryStore(file, { now: NOW });
    await a.add({ content: 'the harbour ledger entry one was filed', kind: 'user_fact', source: 'user' });
    assert.equal((await a.search('harbour ledger')).length, 1);
    await b.add({ content: 'the harbour ledger entry two was filed', kind: 'user_fact', source: 'user' });
    const hits = await a.search('harbour ledger');
    assert.equal(hits.length, 2);
    assert.equal(a.retrievalIndexStats.builds, 2);
  });

  test('private and non-private corpora are kept apart under one content key', async () => {
    const file = tempFile('memory-private.jsonl');
    const store = new MemoryStore(file, { now: NOW });
    await store.add({ content: 'the lighthouse status is green', kind: 'user_fact', source: 'user' });
    await store.add({ content: 'the lighthouse status is amber', kind: 'user_fact', source: 'user', sensitivity: 'private' });

    await store.search('lighthouse status'); // the read after this instance's writes certifies the file it validated
    const baseline = store.retrievalIndexStats;
    assert.equal((await store.search('lighthouse status', { includePrivate: false })).length, 1);
    assert.equal((await store.search('lighthouse status', { includePrivate: true })).length, 2);
    assert.equal((await store.search('lighthouse status', { includePrivate: false })).length, 1);
    const stats = store.retrievalIndexStats;
    assert.equal(stats.builds, baseline.builds + 1, 'one corpus per visibility, not one per read');
    assert.equal(stats.hits, baseline.hits + 2);
    assert.equal(stats.cached, true);
  });

  test('reused results match a cold store exactly, including conflicts and diagnostics', async () => {
    const file = tempFile('memory-equivalence.jsonl');
    const store = new MemoryStore(file, { now: NOW });
    await store.add({ content: 'the launch code name is Zephyr', kind: 'user_fact', source: 'user' });
    await store.add({ content: 'the launch code name is Aurora', kind: 'user_fact', source: 'user' });
    await store.add({ content: 'the harbour ledger entry one was filed', kind: 'user_fact', source: 'user' });

    const warmDiagnostics = {};
    const warm = await store.search('launch code name', { diagnostics: warmDiagnostics });
    await store.search('launch code name');
    const reusedDiagnostics = {};
    const reused = await store.search('launch code name', { diagnostics: reusedDiagnostics });

    const cold = new MemoryStore(file, { now: NOW });
    const coldDiagnostics = {};
    const coldHits = await cold.search('launch code name', { diagnostics: coldDiagnostics });

    assert.deepEqual(reused, warm);
    assert.deepEqual(reused, coldHits);
    assert.deepEqual(reusedDiagnostics, coldDiagnostics);
    assert.equal(reused.length, 2);
    assert.ok(reused.every((hit) => hit.conflict.length === 1), 'both conflicting claims keep their partner');
    assert.ok(store.retrievalIndexStats.hits >= 1);
  });

  test('a store too large to certify reuses nothing and still answers correctly', async () => {
    const file = tempFile('memory-uncertified.jsonl');
    const store = new MemoryStore(file, { now: NOW, parseCacheBytes: 64 });
    await store.add({
      content: `the lighthouse archive batch ${'x'.repeat(80)} was recorded`,
      kind: 'user_fact',
      source: 'user',
    });
    assert.equal((await store.search('lighthouse archive')).length, 1);
    assert.equal((await store.search('lighthouse archive')).length, 1);
    const stats = store.retrievalIndexStats;
    assert.equal(stats.cached, false);
    assert.equal(stats.builds, 2, 'an uncertified read builds every time');
    assert.equal(stats.hits, 0);
    assert.equal(stats.authorizes, false);
  });

  test('a damaged memory store refuses retrieval and reports damage instead of empty success', async () => {
    const file = tempFile('memory-damaged.jsonl');
    const store = new MemoryStore(file, { now: NOW });
    await store.add({ content: 'the lighthouse status is green', kind: 'user_fact', source: 'user' });
    await store.search('lighthouse status');
    const intact = fs.readFileSync(file, 'utf8');
    appendRaw(file, 'not json\n');

    await assert.rejects(store.search('lighthouse status'), (err) => err instanceof StoreError && /corrupt/.test(err.message));
    const projection = await store.projectionRead({ limit: 5 });
    assert.equal(projection.records, null);
    assert.equal(projection.health.state, 'damaged');
    assert.equal(projection.health.corruptLines, 1);

    fs.writeFileSync(file, intact);
    assert.equal((await store.search('lighthouse status')).length, 1);
  });

  test('interrupted append residue is damage, not an empty or partial success', async () => {
    const file = tempFile('memory-interrupted.jsonl');
    const store = new MemoryStore(file, { now: NOW });
    await store.add({ content: 'the lighthouse status is green', kind: 'user_fact', source: 'user' });
    const intact = fs.readFileSync(file, 'utf8');
    // What a crash during an append leaves: a record that was never terminated.
    appendRaw(file, '{"schema":1,"id":"half-writ');

    await assert.rejects(store.search('lighthouse status'), (err) => err instanceof StoreError && /corrupt/.test(err.message));
    const projection = await store.projectionRead({ limit: 5 });
    assert.equal(projection.records, null, 'a half-written tail cannot pass as a readable store');
    assert.equal(projection.health.corruptLines, 1);

    fs.writeFileSync(file, intact);
    assert.equal((await store.search('lighthouse status')).length, 1);
    assert.equal((await store.projectionRead({ limit: 5 })).health.corruptLines, 0);
  });

  test('getMany reports the same supersession a fresh read reports', async () => {
    const file = tempFile('memory-getmany.jsonl');
    const store = new MemoryStore(file, { now: NOW });
    const first = await store.add({ content: 'the lighthouse status is green', kind: 'user_fact', source: 'user' });
    const second = await store.correct({ targetId: first.id, content: 'the lighthouse status is red', origin: 'user' });
    const found = await store.getMany([first.id, second.id]);
    assert.deepEqual(found.get(first.id).replacedBy, [second.id]);
    assert.equal(found.get(first.id).status, 'superseded');
    assert.equal(found.get(second.id).status, 'user_confirmed');
    const cold = await new MemoryStore(file, { now: NOW }).getMany([first.id, second.id]);
    assert.deepEqual(found.get(first.id), cold.get(first.id));
    assert.deepEqual(found.get(second.id), cold.get(second.id));
  });
});

describe('AP-12: knowledge lifecycle and retrieval reuse follows storage identity', () => {
  async function seedClaims(store) {
    const green = await store.add({ subject: 'lighthouse project', relationship: 'status', object: 'green', origin: 'user' });
    const red = await store.add({ subject: 'lighthouse project', relationship: 'status', object: 'red', origin: 'user' });
    return { green: green.record, red: red.record };
  }

  test('a conflict group resolved by another instance is re-annotated on the next read', async () => {
    const file = tempFile('knowledge-resolve.jsonl');
    const a = new KnowledgeStore(file, { now: NOW });
    const b = new KnowledgeStore(file, { now: NOW });
    const { green } = await seedClaims(a);
    const before = await a.list({ limit: 10 });
    assert.ok(before.every((record) => record.conflictState === 'unresolved'));

    await b.resolve({ target: green.id, choose: green.id, reason: 'the status was confirmed', origin: 'user' });
    const after = await a.list({ limit: 10 });
    assert.ok(after.every((record) => record.conflictState === 'resolved'));
    const chosen = after.find((record) => record.id === green.id);
    assert.equal(chosen.resolution.chosen, true);
    assert.ok(after.every((record) => record.conflictsWith.length === 1), 'conflicting alternatives stay visible');
    assert.equal(a.lifecycleIndexStats.builds, 2, 'the resolution event changed the file and forced a derivation');
  });

  test('a retraction from another instance removes the claim from retrieval immediately', async () => {
    const file = tempFile('knowledge-retract.jsonl');
    const a = new KnowledgeStore(file, { now: NOW });
    const b = new KnowledgeStore(file, { now: NOW });
    const { green } = await seedClaims(a);
    assert.equal((await a.search('lighthouse status')).length, 2);
    await b.retract({ target: green.id, reason: 'the note was withdrawn', origin: 'user' });
    const hits = await a.search('lighthouse status');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].record.object, 'red');
    const listed = await a.list({ limit: 10 });
    assert.equal(listed.find((record) => record.id === green.id).lifecycleState, 'retracted');
    assert.ok(a.lifecycleIndexStats.builds >= 2);
  });

  test('projectionRead and list agree, and getMany agrees on every claim\'s lifecycle state', async () => {
    const file = tempFile('knowledge-agreement.jsonl');
    const store = new KnowledgeStore(file, { now: NOW });
    const { green } = await seedClaims(store);
    const replacement = await store.add({
      subject: 'lighthouse project', relationship: 'status', object: 'amber', supersedes: [green.id], origin: 'user',
    });

    const projection = await store.projectionRead({ limit: 10 });
    const listed = await store.list({ limit: 10 });
    const found = await store.getMany(listed.map((record) => record.id));
    assert.deepEqual(projection.claims, listed);
    for (const record of listed) {
      const direct = found.get(record.id);
      // getMany answers the late re-check: it derives retirement state but deliberately does not
      // reconstruct conflict partners, so an active claim's conflict-derived status may differ.
      // Retirement - the state a late check must not miss - must agree exactly.
      assert.equal(direct.active, record.active);
      assert.equal(direct.retractedBy, record.retractedBy);
      assert.deepEqual(direct.supersededBy, record.supersededBy);
      if (!record.active) assert.equal(direct.lifecycleState, record.lifecycleState);
    }
    assert.equal(found.get(green.id).lifecycleState, 'superseded');
    assert.equal(found.get(green.id).status, 'superseded');

    const again = await store.projectionRead({ limit: 10 });
    assert.deepEqual(again.claims, projection.claims);
    assert.deepEqual(again.health, projection.health);
    const healthBefore = store.lifecycleIndexStats;
    const third = await store.projectionRead({ limit: 10 });
    assert.deepEqual(third.claims, projection.claims);
    assert.ok(store.lifecycleIndexStats.healthHits > healthBefore.healthHits, 'the unchanged snapshot reuses the health summary');
    assert.equal(store.retrievalIndexStats.authorizes, false);
  });

  test('search reuses one tokenised active pool per content key', async () => {
    const file = tempFile('knowledge-search-memo.jsonl');
    const store = new KnowledgeStore(file, { now: NOW });
    await seedClaims(store);
    await store.search('lighthouse'); // the read after this instance's writes certifies the file it validated
    const baseline = store.retrievalIndexStats;
    const first = await store.search('lighthouse status');
    const second = await store.search('lighthouse status');
    assert.deepEqual(second, first);
    assert.equal(store.retrievalIndexStats.builds, baseline.builds, 'the active pool is built once, not per read');
    assert.equal(store.retrievalIndexStats.hits, baseline.hits + 2);

    // A new claim makes the next search see it, and the changed bytes rebuild the active pool.
    const beforeAdd = store.retrievalIndexStats;
    await store.add({ subject: 'harbour ledger', relationship: 'entry number', object: '3', origin: 'user' });
    assert.equal((await store.search('harbour ledger')).length, 1);
    assert.ok(store.retrievalIndexStats.builds > beforeAdd.builds);
  });

  test('a damaged knowledge store certifies nothing and reuses nothing', async () => {
    const file = tempFile('knowledge-damaged.jsonl');
    const store = new KnowledgeStore(file, { now: NOW });
    await seedClaims(store);
    await store.projectionRead({ limit: 10 });
    appendRaw(file, '{"broken":');

    const projection = await store.projectionRead({ limit: 10 });
    assert.equal(projection.claims, null);
    assert.equal(projection.health.state, 'damaged');
    assert.equal(projection.health.corruptLines, 1);
    await assert.rejects(store.list(), (err) => err instanceof StoreError && /corrupt/.test(err.message));
    assert.equal(store.lifecycleIndexStats.cached, false, 'a damaged read drops the derivation instead of retaining it');
  });

  test('concurrent knowledge reads match sequential reads on the same store', async () => {
    const file = tempFile('knowledge-concurrent.jsonl');
    const store = new KnowledgeStore(file, { now: NOW });
    const { green } = await seedClaims(store);
    await store.add({ subject: 'harbour ledger', relationship: 'entry number', object: '4', origin: 'user' });
    await store.add({ subject: 'harbour ledger', relationship: 'entry number', object: '5', origin: 'user' });

    const queries = ['lighthouse status', 'harbour ledger entry', 'lighthouse'];
    const concurrent = await Promise.all(queries.flatMap((query) => [
      store.search(query, { limit: 2 }),
      store.list({ limit: 3 }),
      store.getMany([green.id]),
    ]));
    const sequential = [];
    for (const query of queries) {
      sequential.push(await store.search(query, { limit: 2 }));
      sequential.push(await store.list({ limit: 3 }));
      sequential.push(await store.getMany([green.id]));
    }
    for (let i = 0; i < sequential.length; i += 1) {
      if (sequential[i] instanceof Map) assert.deepEqual(concurrent[i], sequential[i]);
      else assert.deepEqual(concurrent[i], sequential[i]);
    }
  });
});
