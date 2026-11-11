// Batch AO, work package G: the retrieval window must not change what a returned record reports.
//
// `search` derives conflict ids only between records that can be shown. A pair of records that both
// fall outside the requested window produced ids no caller could read, so the all-pairs loop now
// skips those pairs. These tests pin the invariant that made that safe: every returned record still
// lists every partner it conflicts with, in the same order, whether the partner is inside the window
// or far outside it.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MemoryStore } from '../src/memory/memory-store.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) {
    try { cleanup(dirs.pop()); } catch { /* already removed */ }
  }
});

const CLOCK = () => new Date('2026-11-11T09:00:00.000Z');
const QUERY = 'lighthouse project status';
const VALUES = ['green', 'amber', 'red', 'paused', 'archived', 'draft'];

async function seededStore() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  const store = new MemoryStore(path.join(dir, 'memory.jsonl'), { now: CLOCK });
  for (const value of VALUES) {
    await store.add({ content: `the lighthouse project status is ${value}`, kind: 'user_fact', source: 'user' });
  }
  await store.add({ content: 'the harbor master is alice', kind: 'user_fact', source: 'user' });
  await store.add({ content: 'the harbor master is bob', kind: 'user_fact', source: 'user' });
  await store.add({ content: 'the private vault combination is sunrise', kind: 'user_fact', source: 'user', sensitivity: 'private' });
  return store;
}

const byId = (results) => new Map(results.map((item) => [item.record.id, item]));

describe('AO-08 G6: the retrieval window reports every conflict partner of a returned record', () => {
  test('G6.1 a record outside the window is still named by every returned partner', async () => {
    const store = await seededStore();
    const wide = await store.search(QUERY, { limit: 50 });
    const narrow = await store.search(QUERY, { limit: 2 });
    assert.equal(narrow.length, 2);
    const wideById = byId(wide);
    const narrowIds = new Set(narrow.map((item) => item.record.id));
    assert.ok(narrow.every((item) => item.conflict.length === 5), 'each returned record conflicts with the other five');
    assert.ok(
      narrow.some((item) => item.conflict.some((id) => !narrowIds.has(id))),
      'at least one partner lies outside the requested window, which is the case the optimization skips',
    );
    for (const item of narrow) {
      assert.deepEqual(item.conflict, wideById.get(item.record.id).conflict, 'the partner list and its order do not depend on the window');
      assert.equal(new Set(item.conflict).size, 5, 'a record names each partner once');
      assert.ok(!item.conflict.includes(item.record.id), 'a record does not conflict with itself');
      assert.equal(item.status, 'unresolved_conflict');
    }
    // The window is the same ranked prefix, not a different sample.
    assert.deepEqual(narrow.map((item) => item.record.id), wide.slice(0, 2).map((item) => item.record.id));
  });

  test('G6.2 records with a different subject are not reported as conflicting', async () => {
    const store = await seededStore();
    const results = await store.search('harbor master', { limit: 5 });
    const harbor = results.filter((item) => String(item.record.content).startsWith('the harbor master'));
    assert.equal(harbor.length, 2);
    assert.deepEqual(harbor.map((item) => item.conflict.length), [1, 1]);
    assert.notEqual(harbor[0].record.id, harbor[1].record.id);
    assert.deepEqual(harbor[0].conflict, [harbor[1].record.id]);
    assert.deepEqual(harbor[1].conflict, [harbor[0].record.id]);
    for (const item of harbor) assert.equal(item.status, 'unresolved_conflict');
  });

  test('G6.3 the same query returns the same ids and partner lists every time', async () => {
    const store = await seededStore();
    const first = await store.search(QUERY, { limit: 2 });
    const second = await store.search(QUERY, { limit: 2 });
    assert.deepEqual(second.map((item) => item.record.id), first.map((item) => item.record.id));
    assert.deepEqual(second.map((item) => item.conflict), first.map((item) => item.conflict));
  });

  test('G6.4 limit semantics are unchanged: zero asks for one record, and the window is a prefix', async () => {
    const store = await seededStore();
    const one = await store.search(QUERY, { limit: 0 });
    const three = await store.search(QUERY, { limit: 3 });
    const six = await store.search(QUERY, { limit: 6 });
    assert.equal(one.length, 1);
    assert.equal(three.length, 3);
    assert.equal(six.length, 6);
    assert.deepEqual(three.map((item) => item.record.id), six.slice(0, 3).map((item) => item.record.id));
    for (const item of one) assert.equal(item.conflict.length, 5);
  });

  test('G6.5 private records are still excluded from a read that must not see them', async () => {
    const store = await seededStore();
    const visible = await store.search('private vault combination', { limit: 50, includePrivate: false });
    const all = await store.search('private vault combination', { limit: 50, includePrivate: true });
    assert.equal(all.length, 1);
    assert.equal(all[0].record.sensitivity, 'private');
    assert.equal(visible.length, 0);
  });

  test('G6.6 replacement lineage is unaffected by the window filter', async () => {
    const dir = makeTempDataDir();
    dirs.push(dir);
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'), { now: CLOCK });
    const original = await store.add({ content: 'the launch code name is sunrise', kind: 'user_fact', source: 'user' });
    const corrected = await store.correct({ targetId: original.id, content: 'the launch code name is sunset', origin: 'user' });
    const results = await store.search('launch code name', { limit: 1 });
    assert.equal(results.length, 1);
    const [item] = results;
    assert.equal(item.record.id, corrected.id);
    assert.deepEqual(item.replaces, [original.id]);
    assert.equal(item.status, 'user_confirmed');
    const wide = await store.search('launch code name', { limit: 50 });
    const old = wide.find((entry) => entry.record.id === original.id);
    assert.deepEqual(old.replacedBy, [corrected.id]);
    assert.equal(old.status, 'superseded');
  });
});
