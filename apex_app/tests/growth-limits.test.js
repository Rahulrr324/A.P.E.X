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
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { makeTempDataDir, cleanup } from './helpers.js';
import { MemoryStore, sha256Hex } from '../src/memory/memory-store.js';

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
