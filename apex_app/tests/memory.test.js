// Persistent memory: storage, retrieval, provenance, restart survival, and
// safe handling of invalid or damaged data.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MemoryStore, sha256Hex } from '../src/memory/memory-store.js';
import { buildPrompt } from '../src/controller/context.js';
import { StoreError, ValidationError } from '../src/errors.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

describe('memory store', () => {
  test('stores a user fact and retrieves it by id with provenance and timestamp', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'), { now: () => new Date('2026-10-27T00:00:00Z') });
    const rec = await store.add({ content: 'The project codename is Lighthouse', provenance: { origin: 'user_request' } });
    const got = await store.get(rec.id);
    assert.equal(got.content, 'The project codename is Lighthouse');
    assert.equal(got.kind, 'user_fact');
    assert.equal(got.source, 'user');
    assert.equal(got.createdAt, '2026-10-27T00:00:00.000Z');
    assert.equal(got.contentSha256, sha256Hex('The project codename is Lighthouse'));
    assert.equal(got.provenance.origin, 'user_request');
  });

  test('relevant memory is retrieved by keyword and unrelated queries return nothing', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const a = await store.add({ content: 'The project codename is Lighthouse' });
    await store.add({ content: 'Buy oat milk on Tuesday' });
    const hits = await store.search('what is the codename of the project?');
    assert.equal(hits[0].record.id, a.id);
    assert.ok(hits[0].score > 0);
    assert.equal((await store.search('quantum chromodynamics')).length, 0);
  });

  test('duplicate memory entries are collapsed in retrieval results with the newest record winning', async () => {
    const dir = tempDir();
    const times = [
      new Date('2026-10-27T00:00:00.000Z'),
      new Date('2026-10-27T00:05:00.000Z'),
    ];
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'), { now: () => times.shift() ?? new Date('2026-10-27T00:10:00.000Z') });
    const older = await store.add({ content: 'The project codename is Lighthouse' });
    const newer = await store.add({ content: 'The project codename is Lighthouse' });
    const hits = await store.search('what is the project codename?');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].record.id, newer.id);
    assert.equal(hits[0].record.createdAt, newer.createdAt);
    assert.equal((await store.get(older.id))?.content, 'The project codename is Lighthouse');
  });

  test('conflicting memories are flagged conservatively and kept in context without deleting either record', async () => {
    const dir = tempDir();
    const times = [
      new Date('2026-10-27T00:00:00.000Z'),
      new Date('2026-10-27T00:05:00.000Z'),
    ];
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'), { now: () => times.shift() ?? new Date('2026-10-27T00:10:00.000Z') });
    const older = await store.add({ content: 'The project codename is Lighthouse' });
    const newer = await store.add({ content: 'The project codename is Bluebird' });
    const hits = await store.search('what is the project codename?');
    assert.equal(hits.length, 2);
    assert.ok(hits[0].conflict?.includes(older.id) || hits[0].conflict?.includes(newer.id));
    assert.ok(hits[1].conflict?.includes(older.id) || hits[1].conflict?.includes(newer.id));
    const prompt = buildPrompt({ request: 'what is the project codename?', memoryHits: hits, turns: [], maxChars: 6000 }).prompt;
    assert.match(prompt, /conflict|competing claim|disagree/i);
    assert.equal((await store.get(older.id))?.content, 'The project codename is Lighthouse');
    assert.equal((await store.get(newer.id))?.content, 'The project codename is Bluebird');
  });

  test('same-attribute contradictions are flagged while compatible non-contradictions stay clear', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    await store.add({ content: 'The project codename is Lighthouse' });
    await store.add({ content: 'The project code name is Bluebird' });
    await store.add({ content: 'Alice likes tea' });
    await store.add({ content: 'Alice likes coffee' });

    const projectHits = await store.search('project codename');
    assert.equal(projectHits.length, 2);
    assert.ok(projectHits.every((hit) => hit.conflict.length > 0));

    const likesHits = await store.search('Alice likes');
    assert.equal(likesHits.length, 2);
    assert.ok(likesHits.every((hit) => hit.conflict.length === 0));
  });

  test('duplicate claims do not hide a distinct conflicting claim or its conflict metadata', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const first = await store.add({ content: 'The project codename is Lighthouse' });
    const duplicate = await store.add({ content: 'The project codename is Lighthouse' });
    const conflict = await store.add({ content: 'The project codename is Bluebird' });
    const hits = await store.search('project codename', { limit: 10 });
    assert.deepEqual(new Set(hits.map((hit) => hit.record.content)), new Set([
      'The project codename is Lighthouse',
      'The project codename is Bluebird',
    ]));
    assert.equal(hits.length, 2);
    assert.ok(hits.some((hit) => hit.record.id === duplicate.id));
    assert.ok(hits.every((hit) => hit.conflict.length === 1));
    assert.ok(hits.find((hit) => hit.record.id === duplicate.id).conflict.includes(conflict.id));
    assert.equal((await store.get(first.id))?.content, 'The project codename is Lighthouse');
  });

  test('same-predicate compatible elaborations are not automatically marked as conflicts', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    await store.add({ content: 'The project codename is Bluebird' });
    await store.add({ content: 'The project codename is Bluebird for the summer campaign' });
    const hits = await store.search('project codename', { limit: 10 });
    assert.equal(hits.length, 2);
    assert.ok(hits.every((hit) => hit.conflict.length === 0));
  });

  test('private conflicting records do not leak through prompt conflict metadata', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    await store.add({ content: 'The launch phrase is Harbor' });
    await store.add({ content: 'The launch phrase is Seaglass', sensitivity: 'private' });
    const hits = await store.search('launch phrase', { limit: 10 });
    const prompt = buildPrompt({ request: 'what is the launch phrase?', memoryHits: hits, turns: [] }).prompt;
    assert.match(prompt, /Harbor/);
    assert.doesNotMatch(prompt, /Seaglass/);
    assert.doesNotMatch(prompt, /conflict|competing claims|disagree/i);
  });

  test('conflict references remain deterministic when timestamps tie', async () => {
    const dir = tempDir();
    const now = () => new Date('2026-10-27T00:00:00.000Z');
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'), { now });
    const older = await store.add({ content: 'The project codename is Lighthouse' });
    const newer = await store.add({ content: 'The project codename is Bluebird' });
    const hits = await store.search('what is the project codename?');
    assert.equal(hits.length, 2);
    assert.deepEqual(new Set(hits.flatMap((hit) => hit.conflict)).size, 2);
    assert.ok(hits.some((hit) => hit.conflict.includes(older.id)));
    assert.ok(hits.some((hit) => hit.conflict.includes(newer.id)));
  });

  test('explicit user-confirmed updates preserve history and record the replacement metadata', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const older = await store.add({ content: 'The project codename is Lighthouse' });
    const updated = await store.correct({
      targetId: older.id,
      content: 'The project codename is Bluebird',
      origin: 'user',
    });
    assert.equal(updated.provenance.updateMode, 'user_confirmed');
    assert.deepEqual(updated.provenance.replaces, [older.id]);
    assert.equal((await store.get(older.id))?.content, 'The project codename is Lighthouse');
    assert.equal((await store.get(updated.id))?.provenance.updateMode, 'user_confirmed');
    const hits = await store.search('project codename', { limit: 10 });
    assert.equal(hits.length, 2);
    assert.equal(hits.find((hit) => hit.record.id === older.id).status, 'superseded');
    assert.equal(hits.find((hit) => hit.record.id === updated.id).status, 'user_confirmed');
    assert.deepEqual(hits.find((hit) => hit.record.id === older.id).replacedBy, [updated.id]);
    assert.ok(hits.every((hit) => hit.conflict.length === 0));
  });

  test('a displayed short prefix resolves the correction target, and an unknown one is refused', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const older = await store.add({ content: 'The project codename is Lighthouse' });
    assert.equal(await store.resolveId(older.id.slice(0, 8)), older.id);
    assert.equal(await store.resolveId(older.id), older.id);
    await assert.rejects(() => store.resolveId(older.id.slice(0, 3)), ValidationError);
    await assert.rejects(() => store.resolveId('ffffffff'), /no memory record matches/);
  });

  test('a correction only resolves the identified conflict and leaves independent conflicts unresolved', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const oldProject = await store.add({ content: 'The project codename is Lighthouse' });
    await store.add({ content: 'The project codename is Bluebird' });
    await store.add({ content: 'The launch phrase is Harbor' });
    await store.add({ content: 'The launch phrase is Seaglass' });
    const correction = await store.correct({
      targetId: oldProject.id,
      content: 'The project codename is Bluebird',
      origin: 'user',
    });

    const projectHits = await store.search('project codename', { limit: 10 });
    assert.equal(projectHits.find((hit) => hit.record.id === correction.id).status, 'user_confirmed');
    assert.equal(projectHits.filter((hit) => hit.conflict.length > 0).length, 0);

    const launchHits = await store.search('launch phrase', { limit: 10 });
    assert.equal(launchHits.length, 2);
    assert.ok(launchHits.every((hit) => hit.status === 'unresolved_conflict'));
  });

  test('deduplication cannot hide correction metadata behind a future-dated duplicate', async () => {
    const dir = tempDir();
    const times = [
      new Date('2026-10-27T00:00:00.000Z'),
      new Date('2036-10-27T00:00:00.000Z'),
      new Date('2026-10-27T00:05:00.000Z'),
    ];
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'), { now: () => times.shift() });
    const old = await store.add({ content: 'The project codename is Lighthouse' });
    const duplicate = await store.add({ content: 'The project codename is Bluebird' });
    const correction = await store.correct({ targetId: old.id, content: 'The project codename is Bluebird', origin: 'user' });
    const hits = await store.search('project codename', { limit: 10 });
    assert.ok(hits.some((hit) => hit.record.id === correction.id));
    assert.ok(!hits.some((hit) => hit.record.id === duplicate.id));
    assert.equal(hits.find((hit) => hit.record.id === old.id).status, 'superseded');
    assert.equal(hits.find((hit) => hit.record.id === correction.id).status, 'user_confirmed');
  });

  test('a correction does not make an unrelated competing claim authoritative', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const target = await store.add({ content: 'The project codename is Lighthouse' });
    const other = await store.add({ content: 'The project codename is Greenhouse' });
    const correction = await store.correct({
      targetId: target.id,
      content: 'The project codename is Bluebird',
      origin: 'user',
    });
    const hits = await store.search('project codename', { limit: 10 });
    assert.equal(hits.find((hit) => hit.record.id === target.id).status, 'unresolved_conflict');
    assert.ok(hits.find((hit) => hit.record.id === target.id).replacedBy.includes(correction.id));
    assert.equal(hits.find((hit) => hit.record.id === other.id).status, 'unresolved_conflict');
    assert.equal(hits.find((hit) => hit.record.id === correction.id).status, 'unresolved_conflict');
  });

  test('model-origin metadata cannot forge user confirmation', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    await assert.rejects(
      () => store.add({
        content: 'The project codename is Bluebird',
        kind: 'model_conclusion',
        source: 'model',
        provenance: { origin: 'model_output', updateMode: 'user_confirmed' },
      }),
      ValidationError,
    );
    const rec = await store.add({
      content: 'The project codename is Bluebird',
      kind: 'model_conclusion',
      source: 'model',
      provenance: { origin: 'model_output', backend: 'stub' },
    });
    assert.equal(rec.provenance.updateMode, 'model_proposed');
    assert.equal(rec.provenance.replaces, undefined);
  });

  test('replacement references must point to existing records', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    await assert.rejects(
      () => store.add({
        content: 'The project codename is Bluebird',
        provenance: { origin: 'user_request', updateMode: 'user_confirmed', replaces: ['missing-id'] },
      }),
      ValidationError,
    );
    await assert.rejects(
      () => store.add({
        content: 'The project codename is Bluebird',
        provenance: { origin: 'user_request', updateMode: 'user_confirmed', replaces: ['missing-id', 42] },
      }),
      ValidationError,
    );
  });

  test('corrections reject unauthorized origins, malformed IDs, and unrelated targets without writing', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const target = await store.add({ content: 'The project codename is Lighthouse' });
    const before = (await fs.readFile(store.filePath, 'utf8')).split('\n').filter(Boolean).length;
    await assert.rejects(() => store.correct({ targetId: target.id, content: 'The project codename is Bluebird', origin: 'model' }), ValidationError);
    await assert.rejects(() => store.correct({ targetId: 'missing-id', content: 'The project codename is Bluebird', origin: 'user' }), ValidationError);
    await assert.rejects(() => store.correct({ targetId: '00000000-0000-4000-8000-000000000001', content: 'The project codename is Bluebird', origin: 'user' }), ValidationError);
    await assert.rejects(() => store.correct({ targetId: target.id, content: 'Buy oat milk on Tuesday', origin: 'user' }), ValidationError);
    const after = (await fs.readFile(store.filePath, 'utf8')).split('\n').filter(Boolean).length;
    assert.equal(after, before);
  });

  test('an explicit correction may replace a dated claim the clause parser cannot split', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const original = await store.add({ content: 'the vendor ships on Tuesdays' });
    // "ships" is not a copula and the values are date words, so neither the clause parser nor the
    // retrieval conflict rule recognizes this pair; the owner still named the claim to replace.
    const corrected = await store.correct({
      targetId: original.id,
      content: 'the vendor ships on Thursdays',
      origin: 'user',
    });
    assert.deepEqual(corrected.provenance.replaces, [original.id]);
    const hits = await store.search('vendor ships', { limit: 10 });
    assert.equal(hits.find((hit) => hit.record.id === original.id).status, 'superseded');
    assert.equal(hits.find((hit) => hit.record.id === corrected.id).status, 'user_confirmed');
    // Unrelated content is still refused by the bounded fallback.
    await assert.rejects(
      () => store.correct({ targetId: corrected.id, content: 'Buy oat milk on Tuesday', origin: 'user' }),
      ValidationError,
    );
  });

  test('generic writes cannot forge confirmation or replacement provenance', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const target = await store.add({ content: 'The project codename is Lighthouse' });
    await assert.rejects(() => store.add({
      content: 'The project codename is Bluebird',
      provenance: { origin: 'user_request', updateMode: 'user_confirmed', replaces: [target.id] },
    }), ValidationError);
    await assert.rejects(() => store.add({
      content: 'The project codename is Bluebird',
      kind: 'model_conclusion',
      source: 'model',
      provenance: { origin: 'model_output', updateMode: 'user_confirmed' },
    }), ValidationError);
    await assert.rejects(() => store.add({
      content: 'The project codename is Bluebird',
      provenance: { origin: 'user_memory_correction' },
    }), ValidationError);
    assert.equal((await store.list()).length, 1);
  });

  test('failed correction append leaves all existing memory intact', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const target = await store.add({ content: 'The project codename is Lighthouse' });
    const before = await fs.readFile(store.filePath, 'utf8');
    store.log.append = async () => { throw new StoreError('injected append failure'); };
    await assert.rejects(() => store.correct({
      targetId: target.id,
      content: 'The project codename is Bluebird',
      origin: 'user',
    }), StoreError);
    assert.equal(await fs.readFile(store.filePath, 'utf8'), before);
  });

  test('corrupt and unavailable stores reject correction without changing existing bytes', async () => {
    const dir = tempDir();
    const corruptFile = path.join(dir, 'corrupt.jsonl');
    const existing = new MemoryStore(corruptFile);
    const target = await existing.add({ content: 'The project codename is Lighthouse' });
    await fs.appendFile(corruptFile, '{bad json}\n');
    const before = await fs.readFile(corruptFile, 'utf8');
    await assert.rejects(() => existing.correct({ targetId: target.id, content: 'The project codename is Bluebird', origin: 'user' }), StoreError);
    assert.equal(await fs.readFile(corruptFile, 'utf8'), before);

    const blocker = path.join(dir, 'not-a-directory');
    await fs.writeFile(blocker, 'x');
    const unavailable = new MemoryStore(path.join(blocker, 'memory.jsonl'));
    await assert.rejects(() => unavailable.correct({ targetId: target.id, content: 'The project codename is Bluebird', origin: 'user' }), StoreError);
  });

  test('tokenless searches and corrupt stores do not masquerade as empty memory', async () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'not-a-directory');
    await fs.writeFile(blocker, 'x');
    const unavailable = new MemoryStore(path.join(blocker, 'memory.jsonl'));
    await assert.rejects(() => unavailable.search('the'), StoreError);

    const file = path.join(dir, 'corrupt.jsonl');
    await fs.writeFile(file, '{not json}\n');
    const corrupt = new MemoryStore(file);
    await assert.rejects(() => corrupt.search('codename'), StoreError);
    await assert.rejects(() => corrupt.list(), StoreError);
  });

  test('unconfirmed contradictory claims remain unresolved and do not claim user confirmation', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const first = await store.add({ content: 'The project codename is Lighthouse' });
    const second = await store.add({ content: 'The project codename is Bluebird' });
    const hits = await store.search('what is the project codename?');
    assert.equal(hits.length, 2);
    assert.ok(hits.every((hit) => hit.status === 'unresolved_conflict'));
    assert.equal(first.provenance.updateMode, 'user_confirmed');
    assert.equal(second.provenance.updateMode, 'user_confirmed');
  });

  test('model-proposed updates are never treated as confirmed user fact updates', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const modelRec = await store.add({
      content: 'The project codename is Bluebird',
      kind: 'model_conclusion',
      source: 'model',
      provenance: { origin: 'model_output', backend: 'stub' },
    });
    const hits = await store.search('project codename');
    assert.ok(hits.some((hit) => hit.record.id === modelRec.id));
    assert.equal(modelRec.provenance.updateMode, 'model_proposed');
    assert.equal(hits.find((hit) => hit.record.id === modelRec.id)?.status, 'model_proposed');
  });

  test('newer timestamps alone do not establish correctness when a conflict remains', async () => {
    const dir = tempDir();
    const times = [
      new Date('2026-10-27T00:00:00.000Z'),
      new Date('2026-10-27T00:05:00.000Z'),
    ];
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'), { now: () => times.shift() ?? new Date('2026-10-27T00:10:00.000Z') });
    await store.add({ content: 'The project codename is Lighthouse' });
    await store.add({ content: 'The project codename is Bluebird' });
    const hits = await store.search('what is the project codename?');
    assert.equal(hits.length, 2);
    assert.ok(hits.every((hit) => hit.status === 'unresolved_conflict'));
  });

  test('context-dependent historical claims can coexist without false conflict warnings', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    await store.add({ content: 'I lived in Paris from 2020 to 2022' });
    await store.add({ content: 'I lived in Berlin from 2022 to 2025' });
    const hits = await store.search('I lived in');
    assert.equal(hits.length, 2);
    assert.ok(hits.every((hit) => hit.conflict.length === 0));
  });

  test('user facts and model conclusions are kept distinct', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const user = await store.add({ content: 'I prefer morning meetings' });
    const model = await store.add({
      content: 'Likely prefers morning meetings',
      kind: 'model_conclusion',
      source: 'model',
      provenance: { origin: 'model_output_approved_by_user', backend: 'stub' },
    });
    assert.equal((await store.get(user.id)).source, 'user');
    assert.equal((await store.get(model.id)).kind, 'model_conclusion');
    await assert.rejects(
      () => store.add({ content: 'x', kind: 'model_conclusion', source: 'user' }),
      ValidationError,
    );
    await assert.rejects(
      () => store.add({ content: 'x', kind: 'user_fact', source: 'model' }),
      ValidationError,
    );
  });

  test('memory survives a restart (a new store instance reads the same file)', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'memory.jsonl');
    const first = new MemoryStore(file);
    const rec = await first.add({ content: 'Persist me across restarts' });
    const second = new MemoryStore(file);
    assert.equal((await second.get(rec.id)).content, 'Persist me across restarts');
    assert.equal((await second.status()).records, 1);
  });

  test('invalid content is rejected and nothing is written', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'memory.jsonl');
    const store = new MemoryStore(file);
    const bad = [undefined, 42, '', '   ', 'bad\u0000byte', `bell\u0007`, 'x'.repeat(4001)];
    for (const content of bad) {
      await assert.rejects(() => store.add({ content }), ValidationError, `expected rejection for ${String(content).slice(0, 10)}`);
    }
    await assert.rejects(fs.access(file));
  });

  test('a damaged store refuses new records, preserves existing bytes, and reports the corruption', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'memory.jsonl');
    const store = new MemoryStore(file);
    const good = await store.add({ content: 'Good record before damage' });
    await fs.appendFile(file, '{"schema":1,"id":"partial');   // crash mid-write, no newline
    const before = await fs.readFile(file, 'utf8');
    await assert.rejects(() => store.add({ content: 'Good record after damage' }), /refusing incomplete write/);
    assert.equal(await fs.readFile(file, 'utf8'), before, 'a refused write must not change the store');
    const status = await store.status();
    assert.equal(status.records, 1);
    assert.equal(status.corrupt, 1);
    assert.equal((await store.get(good.id)).content, 'Good record before damage');
    assert.ok(before.includes('{"schema":1,"id":"partial'), 'damaged bytes must be preserved, not rewritten');
  });

  test('a record whose content was altered is detected as corrupt', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'memory.jsonl');
    const store = new MemoryStore(file);
    await store.add({ content: 'original text' });
    const tampered = (await fs.readFile(file, 'utf8')).replace('original text', 'edited text');
    await fs.writeFile(file, tampered);
    const status = await store.status();
    assert.equal(status.records, 0);
    assert.equal(status.corrupt, 1);
  });

  test('an unavailable store fails safely with a StoreError', async () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'not-a-directory');
    await fs.writeFile(blocker, 'x');
    const store = new MemoryStore(path.join(blocker, 'memory.jsonl'));
    await assert.rejects(() => store.add({ content: 'cannot be stored' }), StoreError);
    await assert.rejects(() => store.status(), StoreError);
  });
});
