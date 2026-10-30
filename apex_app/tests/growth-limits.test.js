// Batch F / 071: retrieval under growth. A measured defect was found here: conflict
// detection parsed every record against every other record, so a query matching most of
// a 3,000-record store took about 27 seconds while a narrow query took 171 ms. The fix
// reduces each record to its subject/value claim once and compares only claims that
// share a subject. These tests hold the behaviour that must survive the change:
// conflicts are still reported symmetrically in ranked order, unrelated claims are still
// not conflicts, corrections are still superseded rather than conflicted, and a broad
// query at 3,000 records stays far away from the old cost.
//
// The size guard is deliberately coarse: the measured cost after the fix is well under
// 200 ms on the development machine, so the 15-second bound only catches a return to
// pairwise parsing (measured at 27-30 s). It is not a benchmark.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { MemoryStore, sha256Hex } from '../src/memory/memory-store.js';
import { KnowledgeStore, sha256Hex as knowledgeSha256 } from '../src/knowledge/knowledge-store.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function stored(content, at) {
  return {
    schema: 1,
    id: randomUUID(),
    kind: 'user_fact',
    source: 'user',
    sensitivity: 'normal',
    content,
    contentSha256: sha256Hex(content),
    createdAt: new Date(Date.UTC(2026, 0, 1) + at * 1000).toISOString(),
    provenance: { origin: 'user_request', updateMode: 'user_confirmed' },
  };
}

function writeStore(dir, contents) {
  const file = path.join(dir, 'memory.jsonl');
  fs.writeFileSync(file, `${contents.map((content, i) => JSON.stringify(stored(content, i))).join('\n')}\n`);
  return new MemoryStore(file);
}

function conflictsOf(hits, hit) {
  const order = new Map(hits.map((h) => [h.record.id, h.record.content]));
  return hit.conflict.map((id) => order.get(id));
}

describe('071: conflict detection under growth', () => {
  test('same-subject claims are all mutually flagged, in ranked order', async () => {
    const store = writeStore(tempDir(), [
      'the launch code name is Zephyr',
      'the launch code name is Falcon',
      'the launch code name is Kestrel',
    ]);
    const hits = await store.search('launch code name', { limit: 10 });
    // Equal scores fall back to the newer record first.
    assert.deepEqual(hits.map((h) => h.record.content), [
      'the launch code name is Kestrel',
      'the launch code name is Falcon',
      'the launch code name is Zephyr',
    ]);
    for (const hit of hits) {
      assert.equal(hit.conflict.length, 2);
      assert.deepEqual(conflictsOf(hits, hit), hits.map((h) => h.record.content).filter((c) => c !== hit.record.content));
      assert.equal(hit.status, 'unresolved_conflict');
    }
  });

  test('different subjects, date values, and qualified values are not conflicts', async () => {
    const store = writeStore(tempDir(), [
      'the launch date is Friday',
      'the launch date is Monday',
      'the office is in Boston',
      'the office is in Boston downtown',
      'the launch code name is Zephyr',
    ]);
    const hits = await store.search('launch date office boston code name', { limit: 10 });
    assert.equal(hits.length, 5);
    for (const hit of hits) {
      assert.deepEqual(hit.conflict, [], `${hit.record.content} must not be called a conflict`);
      assert.notEqual(hit.status, 'unresolved_conflict');
    }
  });

  test('a correction is superseded, not also reported as a conflict', async () => {
    const store = writeStore(tempDir(), ['the launch code name is Zephyr']);
    const target = (await store.search('launch code name', { limit: 1 }))[0].record;
    await store.correct({ targetId: target.id, content: 'the launch code name is Falcon', origin: 'user' });

    const hits = await store.search('launch code name', { limit: 10 });
    const replacement = hits.find((h) => h.record.content === 'the launch code name is Falcon');
    const replaced = hits.find((h) => h.record.content === 'the launch code name is Zephyr');
    assert.deepEqual(replacement.conflict, []);
    assert.equal(replacement.status, 'user_confirmed');
    assert.deepEqual(replaced.conflict, []);
    assert.deepEqual(replaced.replacedBy, [replacement.record.id]);
    assert.equal(replaced.status, 'superseded');
  });

  test('a broad query over 3,000 records is bounded and still finds the conflict', async () => {
    const dir = tempDir();
    const contents = [];
    for (let i = 1; i <= 3000; i += 1) {
      contents.push(`note ${i}: the release checklist includes testing module ${i} and reviewing budget item ${i}`);
    }
    contents[2998] = 'the launch code name is Zephyr';
    contents[2999] = 'the launch code name is Falcon';
    const store = writeStore(dir, contents);

    const started = performance.now();
    const broad = await store.search('release checklist budget module', { limit: 5 });
    const elapsed = performance.now() - started;
    assert.equal(broad.length, 5);
    assert.ok(elapsed < 15000, `broad search took ${Math.round(elapsed)} ms; the all-pairs conflict scan may be back`);

    const named = await store.search('launch code name', { limit: 10 });
    assert.deepEqual(named.map((h) => h.record.content).sort(), [
      'the launch code name is Falcon',
      'the launch code name is Zephyr',
    ]);
    for (const hit of named) {
      assert.equal(hit.conflict.length, 1);
      assert.equal(hit.status, 'unresolved_conflict');
    }
  });
});

// Batch G / 081: the same defect was measured in the knowledge store. Search and list
// annotated every candidate by scanning the whole store, so a 3,000-record store took
// about 7.5 seconds even for a narrow query. Conflicts now come from an index built once
// per call. These tests hold the behaviour that must survive: the reported conflict ids
// and their order are unchanged, and both queries stay far away from the old cost.
function knowledgeRecord(subject, relationship, object, evidence, at, provenance = { origin: 'user_supplied', updateMode: 'user_confirmed' }) {
  return {
    schema: 1,
    id: randomUUID(),
    subject,
    relationship,
    object,
    evidence,
    tripleHash: knowledgeSha256(`${subject}\x00${relationship}\x00${object}`),
    status: 'supported',
    createdAt: new Date(Date.UTC(2026, 0, 1) + at * 1000).toISOString(),
    provenance,
  };
}

function writeKnowledgeStore(dir, records) {
  const file = path.join(dir, 'knowledge.jsonl');
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return new KnowledgeStore(file);
}

describe('081: knowledge retrieval under growth', () => {
  test('search over 1,000 and 3,000 records is bounded and conflict ids stay exact', async () => {
    for (const size of [1000, 3000]) {
      const records = [];
      for (let i = 1; i <= size; i += 1) {
        records.push(knowledgeRecord(
          `module ${i}`,
          'owned by',
          `team ${i}`,
          `the release checklist covers module ${i} and budget item ${i}`,
          i,
        ));
      }
      const zephyr = knowledgeRecord('the launch code name', 'is', 'Zephyr', 'planning notes', size + 1);
      const falcon = knowledgeRecord('the launch code name', 'is', 'Falcon', 'later planning notes', size + 2);
      records.push(zephyr, falcon);
      const store = writeKnowledgeStore(tempDir(), records);

      const started = performance.now();
      const broad = await store.search('release checklist budget module', { limit: 5 });
      const broadElapsed = performance.now() - started;
      assert.equal(broad.length, 5);
      assert.ok(broadElapsed < 5000, `broad knowledge search at ${size} took ${Math.round(broadElapsed)} ms; whole-store annotation may be back`);

      const narrowStarted = performance.now();
      const named = await store.search('launch code name', { limit: 10 });
      const narrowElapsed = performance.now() - narrowStarted;
      assert.ok(narrowElapsed < 5000, `narrow knowledge search at ${size} took ${Math.round(narrowElapsed)} ms`);
      assert.deepEqual(named.map((h) => h.record.id).sort(), [falcon.id, zephyr.id].sort());
      const byId = new Map(named.map((h) => [h.record.id, h.record]));
      assert.deepEqual(byId.get(zephyr.id).conflictsWith, [falcon.id]);
      assert.deepEqual(byId.get(falcon.id).conflictsWith, [zephyr.id]);
      for (const hit of named) assert.equal(hit.record.status, 'conflicting');
    }
  });

  test('adding a contradictory triple at 3,000 records reports the same conflicts as before', async () => {
    const records = [];
    for (let i = 1; i <= 3000; i += 1) {
      records.push(knowledgeRecord(`module ${i}`, 'owned by', `team ${i}`, null, i));
    }
    const first = knowledgeRecord('the launch code name', 'is', 'Zephyr', null, 3001);
    records.push(first);
    const store = writeKnowledgeStore(tempDir(), records);

    const { record, conflictingIds } = await store.add({
      subject: 'the launch code name',
      relationship: 'is',
      object: 'Falcon',
      origin: 'user',
    });
    assert.equal(record.status, 'conflicting');
    assert.deepEqual(conflictingIds, [first.id]);
    // Repeating an existing triple is not a conflict with itself, but it still
    // conflicts with the other live object under the same subject and relationship.
    const duplicate = await store.add({
      subject: 'the launch code name',
      relationship: 'is',
      object: 'Zephyr',
      origin: 'user',
    });
    assert.equal(duplicate.record.status, 'conflicting');
    assert.deepEqual(duplicate.conflictingIds, [record.id]);
  });
});

// Batch H / 095: the same retrieval path is exercised at several store sizes, with
// claims that carry different provenance, with partially damaged records, and while a
// record is being appended. A fourth measured defect is held by the first two tests:
// retrieval compared every query term with every word of every record, so a request at
// the controller's own 4,000-character limit took about 32 seconds against 1,000
// memories. A term now compares only against words reached from its trigrams, and the
// 5-second bounds below are coarse guards against a return to the quadratic form - they
// are not benchmarks. The 4,500-record size sits beyond the 3,000-record sizes already
// exercised by 071 and 081.
function noteRecord(i, at) {
  const content = `note ${i}: the release checklist includes testing module ${i} and reviewing budget item ${i}`;
  return stored(content, at);
}

function appendLine(file, value) {
  fs.appendFileSync(file, `${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

// Splits the first append into two writes and holds the second until the caller
// releases it, so a reader deterministically observes the half-written line.
async function duringSplitAppend(run) {
  const realOpen = fsp.open;
  let reachedResolve;
  const reached = new Promise((resolve) => { reachedResolve = resolve; });
  let releaseResolve;
  const gate = new Promise((resolve) => { releaseResolve = resolve; });
  let split = false;
  fsp.open = async (...args) => {
    const handle = await realOpen(...args);
    const realWrite = handle.write.bind(handle);
    handle.write = async (data, offset = 0, length = data.length - offset) => {
      if (split) return realWrite(data, offset, length);
      split = true;
      const first = Math.max(1, Math.floor(length / 2));
      const result = await realWrite(data, offset, first);
      reachedResolve();
      await gate;
      return result;
    };
    return handle;
  };
  try {
    return await run({ reached, release: releaseResolve });
  } finally {
    fsp.open = realOpen;
  }
}

describe('095: memory and knowledge integrity under growth', () => {
  test('a request at the 4,000-character limit stays bounded and still retrieves its exact match', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'memory.jsonl');
    const records = [];
    for (let i = 1; i <= 1000; i += 1) records.push(noteRecord(i, i));
    records.push(stored('the launch code name is Zephyr', 1001));
    fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const store = new MemoryStore(file);

    const noise = Array.from({ length: 380 }, (_, i) => `phras${String(i).padStart(4, '0')}`).join(' ');
    assert.ok(noise.length < 4000);
    const started = performance.now();
    const hits = await store.search(`${noise} launch code name`, { limit: 5 });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 5000, `a bounded long request took ${Math.round(elapsed)} ms; the per-word comparison may be back`);
    assert.deepEqual(hits.map((h) => h.record.content), ['the launch code name is Zephyr']);

    const noiseStarted = performance.now();
    const none = await store.search(noise, { limit: 5 });
    const noiseElapsed = performance.now() - noiseStarted;
    assert.deepEqual(none, [], 'a request of unrelated words retrieves nothing');
    assert.ok(noiseElapsed < 5000, `an unrelated long request took ${Math.round(noiseElapsed)} ms`);
  });

  test('broad retrieval is bounded at 750, 3,000, and 4,500 records, and conflicts survive at the largest size', async () => {
    for (const size of [750, 3000, 4500]) {
      const dir = tempDir();
      const memRecords = [];
      const knowledgeRecords = [];
      for (let i = 1; i <= size; i += 1) {
        memRecords.push(noteRecord(i, i));
        knowledgeRecords.push(knowledgeRecord(`module ${i}`, 'owned by', `team ${i}`, `the release checklist covers module ${i} and budget item ${i}`, i));
      }
      memRecords.push(stored('the launch code name is Zephyr', size + 1));
      memRecords.push(stored('the launch code name is Falcon', size + 2));
      knowledgeRecords.push(knowledgeRecord('the launch code name', 'is', 'Zephyr', null, size + 1));
      knowledgeRecords.push(knowledgeRecord('the launch code name', 'is', 'Falcon', null, size + 2));
      const memFile = path.join(dir, 'memory.jsonl');
      fs.writeFileSync(memFile, `${memRecords.map((r) => JSON.stringify(r)).join('\n')}\n`);
      const knowledgeFile = path.join(dir, 'knowledge.jsonl');
      fs.writeFileSync(knowledgeFile, `${knowledgeRecords.map((r) => JSON.stringify(r)).join('\n')}\n`);
      const memory = new MemoryStore(memFile);
      const knowledge = new KnowledgeStore(knowledgeFile);

      const memStarted = performance.now();
      const memHits = await memory.search('release checklist budget module', { limit: 5 });
      const memElapsed = performance.now() - memStarted;
      assert.equal(memHits.length, 5);
      assert.ok(memElapsed < 5000, `memory search at ${size} took ${Math.round(memElapsed)} ms`);

      const knStarted = performance.now();
      const knHits = await knowledge.search('release checklist budget module', { limit: 5 });
      const knElapsed = performance.now() - knStarted;
      assert.equal(knHits.length, 5);
      assert.ok(knElapsed < 5000, `knowledge search at ${size} took ${Math.round(knElapsed)} ms`);

      if (size !== 4500) continue;
      const named = await memory.search('launch code name', { limit: 10 });
      assert.deepEqual(named.map((h) => h.record.content).sort(), [
        'the launch code name is Falcon',
        'the launch code name is Zephyr',
      ]);
      for (const hit of named) {
        assert.equal(hit.conflict.length, 1);
        assert.equal(hit.status, 'unresolved_conflict');
      }
      const namedKnowledge = await knowledge.search('launch code name', { limit: 10 });
      assert.deepEqual(namedKnowledge.map((h) => h.record.object).sort(), ['Falcon', 'Zephyr']);
      for (const hit of namedKnowledge) {
        assert.equal(hit.record.status, 'conflicting');
        assert.equal(hit.record.conflictsWith.length, 1);
      }
    }
  });

  test('conflicting claims with distinct provenance are preserved as unresolved, not resolved by origin', async () => {
    const dir = tempDir();
    const memory = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const userFact = await memory.add({ content: 'the launch code name is Zephyr' });
    const modelClaim = await memory.add({
      content: 'the launch code name is Falcon',
      kind: 'model_conclusion',
      source: 'model',
      provenance: { origin: 'model_output', backend: 'stub' },
    });
    const hits = await memory.search('launch code name', { limit: 10 });
    assert.equal(hits.length, 2);
    for (const hit of hits) {
      assert.equal(hit.conflict.length, 1);
      assert.equal(hit.status, 'unresolved_conflict');
    }
    const byId = new Map(hits.map((h) => [h.record.id, h.record]));
    assert.equal(byId.get(userFact.id).source, 'user');
    assert.equal(byId.get(userFact.id).provenance.updateMode, 'user_confirmed');
    assert.equal(byId.get(modelClaim.id).kind, 'model_conclusion');
    assert.equal(byId.get(modelClaim.id).provenance.updateMode, 'model_proposed');

    const knowledge = writeKnowledgeStore(dir, [
      knowledgeRecord('the launch code name', 'is', 'Zephyr', null, 1),
      knowledgeRecord('the launch code name', 'is', 'Falcon', 'model planning note', 2, {
        origin: 'model_proposed',
        updateMode: 'model_proposed',
      }),
    ]);
    const khits = await knowledge.search('launch code name', { limit: 10 });
    assert.equal(khits.length, 2);
    for (const hit of khits) {
      assert.equal(hit.record.status, 'conflicting');
      assert.equal(hit.record.conflictsWith.length, 1);
    }
    assert.deepEqual(khits.map((h) => h.record.provenance.origin).sort(), ['model_proposed', 'user_supplied']);
    assert.deepEqual(khits.map((h) => h.record.provenance.updateMode).sort(), ['model_proposed', 'user_confirmed']);
  });

  test('partially damaged records are counted and preserved, and reads fail closed', async () => {
    const dir = tempDir();
    const knowledgeFile = path.join(dir, 'knowledge.jsonl');
    const good = knowledgeRecord('Server', 'default_port', '8080', null, 1);
    fs.writeFileSync(knowledgeFile, `${JSON.stringify(good)}\n`);
    appendLine(knowledgeFile, { ...knowledgeRecord('Server', 'default_port', '9090', null, 2), tripleHash: 'f'.repeat(64) });
    appendLine(knowledgeFile, { ...knowledgeRecord('Server', 'owner', 'ops', null, 3), status: 'maybe' });
    appendLine(knowledgeFile, knowledgeRecord('Server', 'owner', 'ops', null, 4, {
      origin: 'model_proposed',
      updateMode: 'user_confirmed',
    }));
    const before = fs.readFileSync(knowledgeFile, 'utf8');
    const knowledge = new KnowledgeStore(knowledgeFile);
    const knowledgeStatus = await knowledge.status();
    assert.equal(knowledgeStatus.records, 1);
    assert.equal(knowledgeStatus.corrupt, 3, 'a bad hash, unknown status, or forged provenance is damage too');
    const isUnavailable = (err) => err.code === 'STORE_UNAVAILABLE';
    await assert.rejects(() => knowledge.list(), isUnavailable);
    await assert.rejects(() => knowledge.search('server'), isUnavailable);
    await assert.rejects(
      () => knowledge.add({ subject: 'Server', relationship: 'owner', object: 'ops', origin: 'user' }),
      isUnavailable,
    );
    assert.equal(fs.readFileSync(knowledgeFile, 'utf8'), before, 'a refused write did not rewrite the damaged bytes');

    const memoryFile = path.join(dir, 'memory.jsonl');
    const goodMemory = stored('Good record before damage', 1);
    fs.writeFileSync(memoryFile, `${JSON.stringify(goodMemory)}\n`);
    appendLine(memoryFile, '{"schema":1,"id":"partial');
    appendLine(memoryFile, { ...stored('the launch code name is Falcon', 2), contentSha256: 'f'.repeat(64) });
    const memoryBefore = fs.readFileSync(memoryFile, 'utf8');
    const memory = new MemoryStore(memoryFile);
    const memoryStatus = await memory.status();
    assert.equal(memoryStatus.records, 1);
    assert.equal(memoryStatus.corrupt, 2);
    await assert.rejects(() => memory.search('launch code name'), /refusing incomplete retrieval/);
    await assert.rejects(() => memory.add({ content: 'another record' }), /refusing incomplete write/);
    assert.equal((await memory.get(goodMemory.id)).content, 'Good record before damage', 'valid records are still readable by id');
    assert.equal(fs.readFileSync(memoryFile, 'utf8'), memoryBefore);
  });

  test('a search during an interrupted append fails closed, then sees the whole record', async () => {
    const dir = tempDir();
    const memory = new MemoryStore(path.join(dir, 'memory.jsonl'));
    await memory.add({ content: 'the launch code name is Zephyr' });
    await duringSplitAppend(async ({ reached, release }) => {
      const adding = memory.add({ content: 'the launch code name is Falcon' });
      await reached;
      await assert.rejects(() => memory.search('launch code name'), /refusing incomplete retrieval/);
      release();
      await adding;
    });
    const hits = await memory.search('launch code name', { limit: 10 });
    assert.deepEqual(hits.map((h) => h.record.content).sort(), [
      'the launch code name is Falcon',
      'the launch code name is Zephyr',
    ]);
    for (const hit of hits) assert.equal(hit.status, 'unresolved_conflict');

    const knowledge = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));
    await knowledge.add({ subject: 'the launch code name', relationship: 'is', object: 'Zephyr', origin: 'user' });
    await duringSplitAppend(async ({ reached, release }) => {
      const adding = knowledge.add({ subject: 'the launch code name', relationship: 'is', object: 'Falcon', origin: 'user' });
      await reached;
      await assert.rejects(() => knowledge.search('launch code name'), (err) => err.code === 'STORE_UNAVAILABLE');
      release();
      await adding;
    });
    const khits = await knowledge.search('launch code name', { limit: 10 });
    assert.deepEqual(khits.map((h) => h.record.object).sort(), ['Falcon', 'Zephyr']);
    for (const hit of khits) assert.equal(hit.record.status, 'conflicting');
  });

  test('empty, stopword-only, and irrelevant queries retrieve nothing, and a broad query does not pull in unrelated records', async () => {
    const dir = tempDir();
    const memory = new MemoryStore(path.join(dir, 'memory.jsonl'));
    await memory.add({ content: 'the launch code name is Zephyr' });
    await memory.add({ content: 'the launch code name is Falcon' });
    await memory.add({ content: 'the office plant is a fern' });
    assert.deepEqual(await memory.search(''), []);
    assert.deepEqual(await memory.search('   '), []);
    assert.deepEqual(await memory.search('what is it?'), []);
    assert.deepEqual(await memory.search('quantum chromodynamics'), []);
    const broad = await memory.search('launch office plant', { limit: 10 });
    const fern = broad.find((h) => h.record.content === 'the office plant is a fern');
    assert.ok(fern, 'an exact word match is still retrieved');
    assert.equal(fern.conflict.length, 0);
    assert.equal(broad.filter((h) => h.status === 'unresolved_conflict').length, 2);

    const knowledge = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));
    await knowledge.add({ subject: 'France', relationship: 'capital', object: 'Paris', origin: 'user' });
    await knowledge.add({ subject: 'Weekly sync', relationship: 'notes', object: 'Bring what you need', origin: 'user' });
    assert.deepEqual(await knowledge.search(''), []);
    assert.deepEqual(await knowledge.search('  '), []);
    assert.deepEqual(await knowledge.search('what is it?'), []);
    assert.deepEqual((await knowledge.search('capital France')).map((h) => h.record.subject), ['France']);
  });

  test('a damaged retrieval store does not block a deterministic operation or make a refused write look verified', async () => {
    const dir = tempDir();
    const memoryFile = path.join(dir, 'memory.jsonl');
    fs.writeFileSync(memoryFile, 'not json\n');
    fs.writeFileSync(path.join(dir, 'knowledge.jsonl'), '{"schema":1,"id":"broken"}\n');
    const app = createApp({ dataDir: dir });

    const calc = await app.controller.handle('calc 2+2');
    assert.equal(calc.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(calc.display, '2+2 = 4');
    assert.equal(calc.operation.prompt, null, 'a deterministic action retrieves no stored context');

    const remembered = await app.controller.handle('remember that the project codename is Lighthouse');
    assert.equal(remembered.status, Outcome.EXECUTION_FAILED);
    assert.equal(remembered.recorded, true);
    assert.match(remembered.display, /memory store contains 1 corrupt line\(s\); refusing incomplete write/);
    assert.equal(fs.readFileSync(memoryFile, 'utf8'), 'not json\n', 'the damaged store was not rewritten');
  });
});
