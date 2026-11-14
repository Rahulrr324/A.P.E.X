// Batch AP-11 Priority 1: the retrieval-quality benchmark must measure the corpus size it reports.
//
// The AP-10 benchmark shared one monotonically grown corpus across phases. growTo() never shrank it, so
// when a later phase asked for a smaller size it silently measured the larger corpus an earlier phase
// had left behind, and every request row was labelled with a size it did not use. These tests drive the
// real fixture builder and the real controller against real persisted stores. No inference, no network.
//
// The corpora are deliberately small: every record is a validated, locked append, and the fillers form
// one growing conflict group, so the cost is quadratic in the size. The invariant under test is the
// label, not the scale, and a shrink from 16 to 6 reproduces the defect exactly as 200 to 20 did.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeState, countRecords, removeDir, dirs, QUESTION,
} from '../benchmarks/run-retrieval-quality-benchmark.mjs';

after(() => { while (dirs.length) removeDir(dirs.pop()); });

describe('AP-11 benchmark corpus size is the size actually measured', () => {
  test('growTo persists exactly the requested number of records in each store', async () => {
    const state = await makeState();
    for (const size of [2, 6, 12]) {
      const actual = await state.growTo(size);
      assert.equal(actual.memory, size, `memory at ${size}`);
      assert.equal(actual.knowledge, size, `knowledge at ${size}`);
      assert.deepEqual(state.counts(), { memory: size, knowledge: size });
      assert.deepEqual(countRecords(state.app), { memory: size, knowledge: size });
    }
  });

  test('a smaller size after a larger one rebuilds instead of measuring the larger corpus', async () => {
    const state = await makeState();
    await state.growTo(16);
    assert.deepEqual(state.counts(), { memory: 16, knowledge: 16 });
    // This is the AP-10 defect: the request phase asked for the smaller size and measured the larger.
    const actual = await state.growTo(6);
    assert.equal(actual.memory, 6, 'the reported size must be the persisted size');
    assert.equal(actual.knowledge, 6);
    assert.deepEqual(state.counts(), { memory: 6, knowledge: 6 });
  });

  test('the controller request runs against the rebuilt corpus, not the previous one', async () => {
    const state = await makeState();
    await state.growTo(16);
    const discarded = new Set((await state.app.memory.list({ limit: 200 })).map((record) => record.id));
    assert.equal(discarded.size, 16);
    await state.growTo(6);
    const current = await state.app.memory.list({ limit: 200 });
    assert.equal(current.length, 6, 'the rebuilt corpus holds exactly the requested records');
    const currentIds = new Set(current.map((record) => record.id));
    for (const id of currentIds) {
      assert.ok(!discarded.has(id), 'the rebuild did not reuse the discarded corpus');
    }

    const before = countRecords(state.app);
    const res = await state.app.controller.handle(QUESTION, { origin: 'user' });
    assert.ok(res.operation, 'the real controller handled the request');
    assert.deepEqual(countRecords(state.app), before, 'a read changes no record');
    assert.deepEqual(before, { memory: 6, knowledge: 6 });

    // Every identifier the request put in its prompt must come from the corpus it actually read. An
    // id from the discarded larger corpus would prove the row was measured against the wrong store.
    const cited = res.operation.prompt?.memoryIds ?? [];
    assert.ok(cited.length > 0, 'the request contributed memory evidence');
    for (const id of cited) {
      assert.ok(currentIds.has(id), `evidence ${id} belongs to the 6-record corpus`);
      assert.ok(!discarded.has(id), `evidence ${id} is not from the discarded 16-record corpus`);
    }

    const report = res.operation.prompt?.retrievalReport ?? null;
    assert.ok(report, 'the request produced a retrieval report');
    for (const source of ['memory', 'knowledge']) {
      const entry = report.sources.find((item) => item.source === source);
      assert.ok(entry, `${source} was searched`);
      assert.equal(entry.searched, true);
      // The audit projection carries counts, not the corpus size; the bound is what it can state.
      assert.ok(entry.returned === null || entry.returned <= 5, `${source} stayed inside its bound`);
      assert.ok(entry.matched === null || entry.matched <= 6, `${source} matched inside the 6-record corpus`);
    }
  });

  test('ascending growth keeps one corpus and never duplicates a record', async () => {
    const state = await makeState();
    await state.growTo(6);
    const dir = state.dir;
    await state.growTo(14);
    assert.equal(state.dir, dir, 'ascending growth reuses the same isolated directory');
    assert.deepEqual(state.counts(), { memory: 14, knowledge: 14 });
  });

  test('two states are isolated from each other', async () => {
    const a = await makeState();
    const b = await makeState();
    await a.growTo(10);
    await b.growTo(6);
    assert.deepEqual(a.counts(), { memory: 10, knowledge: 10 });
    assert.deepEqual(b.counts(), { memory: 6, knowledge: 6 });
    assert.notEqual(a.dir, b.dir);
  });

  test('a size below the two seeded target records is refused, not silently mislabelled', async () => {
    const state = await makeState();
    await assert.rejects(() => state.growTo(1), /size must be an integer >= 2/);
    await assert.rejects(() => state.growTo(0), /size must be an integer >= 2/);
  });
});