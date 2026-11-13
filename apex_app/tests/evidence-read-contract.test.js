// Batch AP-07: the bounded-read contract. These tests pin the distinctions a consumer needs before it
// can say anything about a store: complete versus bounded versus truncated, unknown versus empty, and
// absence versus a window that happened to return nothing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  READ_CONTRACT_SCHEMA,
  READ_STATES,
  MAX_READ_SOURCES,
  isReadState,
  worstReadState,
  sourceRead,
  readReport,
  absenceProven,
  readFindings,
} from '../src/evidence/read-contract.js';

describe('AP-07 bounded-read contract: one vocabulary for what a read covered', () => {
  test('a whole store with records is complete, and one without is complete and empty', () => {
    const full = sourceRead({ source: 'memory', returned: 3, total: 3 });
    assert.equal(full.state, 'complete_nonempty');
    assert.equal(full.complete, true);
    const empty = sourceRead({ source: 'memory', status: 'empty' });
    assert.equal(empty.state, 'complete_empty');
    assert.equal(empty.complete, true);
    assert.equal(absenceProven(empty), true);
    assert.equal(absenceProven(full), false);
  });

  test('a caller-requested window is bounded, not complete, and proves no absence', () => {
    const window = sourceRead({ source: 'knowledge', status: 'bounded', returned: 6, total: 40, limit: 6 });
    assert.equal(window.state, 'bounded_usable');
    assert.equal(window.complete, false);
    assert.equal(window.usable, true);
    assert.equal(absenceProven(window), false);
    const emptyWindow = sourceRead({ source: 'knowledge', status: 'bounded', returned: 0, total: 40, limit: 6 });
    assert.equal(emptyWindow.state, 'bounded_usable');
    assert.equal(absenceProven(emptyWindow), false, 'an empty window is not an empty store');
  });

  test('a truncation must name what stopped it', () => {
    assert.throws(() => sourceRead({ source: 'goals', status: 'truncated', returned: 4 }), /must name what stopped it/);
    const read = sourceRead({ source: 'goals', status: 'truncated', returned: 4, stoppedAt: 'MAX_GOAL_LIST=4' });
    assert.equal(read.state, 'truncated');
    assert.equal(read.complete, false);
    assert.equal(read.stoppedAt, 'MAX_GOAL_LIST=4');
    assert.match(read.reason, /stopped at MAX_GOAL_LIST=4/);
  });

  test('fewer records than the source reports is a truncation even when the reader did not say so', () => {
    const read = sourceRead({ source: 'plans', returned: 5, total: 9 });
    assert.equal(read.state, 'truncated');
    assert.equal(read.truncated, true);
  });

  test('a source that could not be read reports unknown counts, never zero', () => {
    const read = sourceRead({ source: 'tasks', status: 'unavailable' });
    assert.equal(read.state, 'unavailable');
    assert.equal(read.returned, null);
    assert.equal(read.total, null);
    assert.equal(read.usable, false);
    assert.equal(absenceProven(read), false);
  });

  test('missing and damaged are distinct from absent and from empty', () => {
    const missing = sourceRead({ source: 'world', status: 'missing' });
    const damaged = sourceRead({ source: 'world', status: 'damaged', returned: 2, total: 5 });
    assert.equal(missing.state, 'missing');
    assert.equal(damaged.state, 'damaged');
    assert.notEqual(missing.state, 'complete_empty');
    assert.equal(damaged.usable, true);
  });

  test('a report is described by its worst source', () => {
    const report = readReport({ reads: [
      sourceRead({ source: 'a', returned: 1, total: 1 }),
      sourceRead({ source: 'b', status: 'truncated', returned: 2, stoppedAt: 'limit 2' }),
    ] });
    assert.equal(report.schema, READ_CONTRACT_SCHEMA);
    assert.equal(report.state, 'truncated');
    assert.deepEqual(report.truncatedSources, ['b']);
    assert.equal(report.complete, false);
    assert.equal(report.patternsAllowed, false, 'a prefix is not a history');
    assert.equal(report.authorizes, false);
  });

  test('patterns are permitted only when every source was read completely', () => {
    const complete = readReport({ reads: [
      sourceRead({ source: 'a', returned: 2, total: 2 }),
      sourceRead({ source: 'b', status: 'empty' }),
    ] });
    assert.equal(complete.patternsAllowed, true);
    const bounded = readReport({ reads: [
      sourceRead({ source: 'a', status: 'bounded', returned: 2, total: 10, limit: 2 }),
    ] });
    assert.equal(bounded.patternsAllowed, false);
  });

  test('an inconsistent window outranks the per-source states and keeps them disclosed', () => {
    const report = readReport({
      reads: [sourceRead({ source: 'a', returned: 3, total: 3 })],
      window: { state: 'concurrent_modification', certification: 'content' },
    });
    assert.equal(report.state, 'inconsistent');
    assert.equal(report.complete, false);
    assert.equal(report.reads[0].state, 'inconsistent');
    assert.equal(report.reads[0].sourceState, 'complete_nonempty');
    assert.equal(report.certification, 'content');
  });

  test('an unverifiable window is the most severe state', () => {
    const report = readReport({
      reads: [sourceRead({ source: 'a', status: 'unavailable' })],
      window: { state: 'unverifiable' },
    });
    assert.equal(report.state, 'unverifiable');
    assert.equal(report.usable, false);
    assert.deepEqual(report.unavailableSources, ['a']);
  });

  test('the digest binds completeness and truncation', () => {
    const complete = readReport({ reads: [sourceRead({ source: 'a', returned: 2, total: 2 })] });
    const cut = readReport({ reads: [sourceRead({ source: 'a', returned: 2, total: 2, status: 'truncated', stoppedAt: 'limit' })] });
    assert.notEqual(complete.digest, cut.digest);
    const again = readReport({ reads: [sourceRead({ source: 'a', returned: 2, total: 2 })] });
    assert.equal(complete.digest, again.digest);
  });

  test('a report refuses more sources than it can describe', () => {
    const reads = Array.from({ length: MAX_READ_SOURCES + 1 }, (_, i) => sourceRead({ source: `s${i}`, status: 'empty' }));
    assert.throws(() => readReport({ reads }), new RegExp(`at most ${MAX_READ_SOURCES} sources`));
  });

  test('an unknown state is rejected rather than sorted into the vocabulary', () => {
    assert.equal(isReadState('complete_empty'), true);
    assert.equal(isReadState('mostly_there'), false);
    assert.throws(() => worstReadState(['complete_empty', 'mostly_there']), /unknown read state/);
    assert.equal(worstReadState([]), 'complete_empty');
    assert.deepEqual(READ_STATES[0], 'complete_empty');
  });

  test('read findings use the closed integrity vocabulary', () => {
    const report = readReport({ reads: [
      sourceRead({ source: 'a', returned: 1, total: 1 }),
      sourceRead({ source: 'b', status: 'truncated', returned: 1, stoppedAt: 'limit' }),
      sourceRead({ source: 'c', status: 'unavailable' }),
    ] });
    const findings = readFindings(report);
    assert.deepEqual(findings.map((finding) => finding.state).sort(), ['truncated_history', 'unverifiable']);
    assert.equal(findings.every((finding) => finding.check === 'bounded_read'), true);
  });
});
