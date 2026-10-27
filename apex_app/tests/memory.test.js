// Persistent memory: storage, retrieval, provenance, restart survival, and
// safe handling of invalid or damaged data.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MemoryStore, sha256Hex } from '../src/memory/memory-store.js';
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

  test('a damaged line is reported and skipped, never deleted, and new records do not merge into it', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'memory.jsonl');
    const store = new MemoryStore(file);
    const good = await store.add({ content: 'Good record before damage' });
    await fs.appendFile(file, '{"schema":1,"id":"partial');   // crash mid-write, no newline
    const after = await store.add({ content: 'Good record after damage' });
    const status = await store.status();
    assert.equal(status.records, 2);
    assert.equal(status.corrupt, 1);
    assert.equal((await store.get(good.id)).content, 'Good record before damage');
    assert.equal((await store.get(after.id)).content, 'Good record after damage');
    const raw = await fs.readFile(file, 'utf8');
    assert.ok(raw.includes('{"schema":1,"id":"partial'), 'damaged bytes must be preserved, not rewritten');
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
