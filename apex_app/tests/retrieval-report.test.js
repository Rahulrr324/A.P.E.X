// Batch AP-10 §6: the retrieval report. Every state is reachable and asserted, the aggregate rules
// are checked, and the load-bearing distinctions (absence vs bound, unavailable vs damaged, the three
// exclusion kinds, the moving window) are driven both through the pure builder and through the real
// retrieveEvidence coordinator with deterministic fake stores. No model, no inference, no network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readReport, sourceRead, absenceProven } from '../src/evidence/read-contract.js';
import {
  RETRIEVAL_REPORT_SCHEMA, RETRIEVAL_STATES, buildRetrievalReport, finalizeRetrievalReport,
  retrievalBudgetNotice, worstRetrievalState, isRetrievalState,
} from '../src/retrieval/report.js';
import { retrieveEvidence } from '../src/cognition/evidence.js';
import { analyzeRequest, analysisAudit } from '../src/cognition/engine.js';

const NOW = '2026-05-01T00:00:00.000Z';
const src = (source, status = 'ok', count = 0, detail = null) => ({ source, status, count, detail });
const ev = (source, recordId) => ({ evidenceId: `ev:${source}:${recordId}`, source, recordId });
const prof = (over = {}) => ({
  returned: 0, matched: 0, eligible: 0, limit: 6, corpusSize: 0,
  queryTokens: 2, droppedTokens: 0, unmatched: [], belowRelevance: 0, ...over,
});
const readOf = (reads, window = null) => readReport({ subject: 'test', reads, window });
const entryOf = (report, source) => report.sources.find((entry) => entry.source === source);

function build({ sources, reads, kept = [], profiles = {}, window = null }) {
  return buildRetrievalReport({ sources, read: readOf(reads, window), kept, profiles });
}

describe('AP-10 §6 the eleven retrieval states', () => {
  test('the vocabulary is exactly eleven frozen states', () => {
    assert.equal(RETRIEVAL_STATES.length, 11);
    assert.ok(Object.isFrozen(RETRIEVAL_STATES));
    assert.deepEqual([...RETRIEVAL_STATES].sort(), [
      'below_relevance_threshold', 'bounded_results', 'complete_empty', 'complete_with_results',
      'context_budget_limited', 'damaged_source', 'incomplete_source', 'inconsistent_snapshot',
      'not_searched', 'source_limit_reached', 'unavailable_source',
    ]);
    for (const state of RETRIEVAL_STATES) assert.ok(isRetrievalState(state));
    assert.equal(isRetrievalState('complete'), false);
  });

  test('complete_with_results: every match returned below the bound and all became evidence', () => {
    const report = build({
      sources: [src('memory', 'ok', 2)],
      reads: [sourceRead({ source: 'memory', status: 'bounded', returned: 2, limit: 6 })],
      kept: [ev('memory', 'm1'), ev('memory', 'm2')],
      profiles: { memory: prof({ returned: 2, matched: 2, eligible: 2, corpusSize: 5 }) },
    });
    const entry = entryOf(report, 'memory');
    assert.equal(entry.state, 'complete_with_results');
    assert.equal(entry.complete, true);
    assert.equal(entry.contributed, 2);
    assert.equal(report.state, 'complete_with_results');
    assert.equal(report.complete, true);
  });

  test('complete_empty: an empty corpus is complete, but a bounded read still proves no absence', () => {
    const report = build({
      sources: [src('memory', 'empty', 0)],
      reads: [sourceRead({ source: 'memory', status: 'bounded', returned: 0, limit: 6 })],
      profiles: { memory: prof({ returned: 0, matched: 0, corpusSize: 0 }) },
    });
    const entry = entryOf(report, 'memory');
    assert.equal(entry.state, 'complete_empty');
    assert.equal(entry.complete, true);
    assert.equal(entry.absenceProven, false, 'a bounded window that returned nothing is not proof of absence');
    assert.equal(report.complete, true);
  });

  test('absence is proven only when the read contract itself reports complete_empty', () => {
    const report = build({
      sources: [src('memory', 'empty', 0)],
      reads: [sourceRead({ source: 'memory', status: 'empty' })],
      profiles: { memory: prof({ returned: 0, matched: 0, corpusSize: 0 }) },
    });
    const entry = entryOf(report, 'memory');
    assert.equal(entry.state, 'complete_empty');
    assert.equal(entry.absenceProven, true);
    assert.equal(absenceProven(readOf([sourceRead({ source: 'memory', status: 'empty' })]).reads[0]), true);
  });

  test('not_searched: a skipped source was never read', () => {
    const report = build({ sources: [src('audit', 'skipped', 0)], reads: [] });
    const entry = entryOf(report, 'audit');
    assert.equal(entry.state, 'not_searched');
    assert.equal(entry.searched, false);
    assert.equal(entry.complete, false);
    assert.equal(report.state, 'not_searched');
  });

  test('below_relevance_threshold: returned records all fell below the floor, not an empty store', () => {
    const report = build({
      sources: [src('memory', 'empty', 0)],
      reads: [sourceRead({ source: 'memory', status: 'bounded', returned: 3, limit: 6 })],
      profiles: { memory: prof({ returned: 3, matched: 3, eligible: 0, corpusSize: 10, belowRelevance: 3 }) },
    });
    const entry = entryOf(report, 'memory');
    assert.equal(entry.state, 'below_relevance_threshold');
    assert.notEqual(entry.state, 'complete_empty');
    assert.equal(entry.exclusions.belowRelevance, 3);
    assert.equal(entry.complete, false);
    assert.equal(entry.absenceProven, false);
  });

  test('bounded_results: a full window is never complete', () => {
    const report = build({
      sources: [src('memory', 'ok', 2)],
      reads: [sourceRead({ source: 'memory', status: 'bounded', returned: 2, limit: 2 })],
      kept: [ev('memory', 'm1'), ev('memory', 'm2')],
      profiles: { memory: prof({ returned: 2, matched: 2, eligible: 2, limit: 2, corpusSize: 10 }) },
    });
    const entry = entryOf(report, 'memory');
    assert.equal(entry.state, 'bounded_results');
    assert.equal(entry.complete, false);
  });

  test('source_limit_reached: the store matched more than the bound returned', () => {
    const report = build({
      sources: [src('memory', 'ok', 2)],
      reads: [sourceRead({ source: 'memory', status: 'bounded', returned: 2, limit: 2 })],
      kept: [ev('memory', 'm1'), ev('memory', 'm2')],
      profiles: { memory: prof({ returned: 2, matched: 5, eligible: 2, limit: 2, corpusSize: 10 }) },
    });
    const entry = entryOf(report, 'memory');
    assert.equal(entry.state, 'source_limit_reached');
    assert.equal(entry.exclusions.sourceLimit, 3);
    assert.equal(entry.complete, false);
  });

  test('context_budget_limited: finalization records the prompt-budget cut', () => {
    const base = build({
      sources: [src('memory', 'ok', 2)],
      reads: [sourceRead({ source: 'memory', status: 'bounded', returned: 2, limit: 6 })],
      kept: [ev('memory', 'm1'), ev('memory', 'm2')],
      profiles: { memory: prof({ returned: 2, matched: 2, eligible: 2, corpusSize: 5 }) },
    });
    assert.equal(entryOf(base, 'memory').state, 'complete_with_results');
    const report = finalizeRetrievalReport(base, { context: { memory: 1, knowledge: 0 } });
    const entry = entryOf(report, 'memory');
    assert.equal(entry.state, 'context_budget_limited');
    assert.equal(entry.exclusions.contextBudget, 1);
    assert.equal(entry.complete, false);
    assert.equal(report.complete, false);
    assert.match(retrievalBudgetNotice(report), /context budget/);
  });

  test('incomplete_source: a truncated or missing read is incomplete', () => {
    const report = build({
      sources: [src('memory', 'ok', 2)],
      reads: [sourceRead({ source: 'memory', status: 'truncated', returned: 2, total: 5, stoppedAt: 'record 2' })],
      kept: [ev('memory', 'm1'), ev('memory', 'm2')],
      profiles: { memory: prof({ returned: 2, matched: 2, eligible: 2, corpusSize: 5 }) },
    });
    assert.equal(entryOf(report, 'memory').state, 'incomplete_source');
  });

  test('unavailable_source: counts are null, never zero', () => {
    const report = build({
      sources: [src('memory', 'unavailable', 0, 'store could not be read')],
      reads: [sourceRead({ source: 'memory', status: 'unavailable' })],
      profiles: { memory: prof({ returned: 0, matched: 0, corpusSize: 0 }) },
    });
    const entry = entryOf(report, 'memory');
    assert.equal(entry.state, 'unavailable_source');
    assert.equal(entry.returned, null);
    assert.equal(entry.matched, null);
    assert.equal(entry.eligible, null);
    assert.equal(entry.corpusSize, null);
    assert.equal(entry.absenceProven, false);
    assert.equal(report.counts.unavailable, 1);
  });

  test('damaged_source is distinct from unavailable_source', () => {
    const report = build({
      sources: [src('memory', 'damaged', 1, 'invalid line')],
      reads: [sourceRead({ source: 'memory', status: 'damaged', returned: 1 })],
      kept: [ev('memory', 'm1')],
      profiles: { memory: prof({ returned: 1, matched: 1, eligible: 1, corpusSize: 3 }) },
    });
    const entry = entryOf(report, 'memory');
    assert.equal(entry.state, 'damaged_source');
    assert.notEqual(entry.state, 'unavailable_source');
    assert.equal(entry.returned, 1, 'a damaged read still reports what it parsed');
    assert.equal(report.counts.damaged, 1);
    assert.equal(report.counts.unavailable, 0);
  });

  test('inconsistent_snapshot: a moving window blocks completeness for every source', () => {
    const report = build({
      sources: [src('memory', 'ok', 2), src('knowledge', 'ok', 1)],
      reads: [
        sourceRead({ source: 'memory', status: 'ok', returned: 2, total: 2 }),
        sourceRead({ source: 'knowledge', status: 'ok', returned: 1, total: 1 }),
      ],
      kept: [ev('memory', 'm1'), ev('memory', 'm2'), ev('knowledge', 'k1')],
      profiles: {
        memory: prof({ returned: 2, matched: 2, eligible: 2, corpusSize: 2 }),
        knowledge: prof({ returned: 1, matched: 1, eligible: 1, corpusSize: 1 }),
      },
      window: { state: 'concurrent_modification' },
    });
    assert.equal(report.state, 'inconsistent_snapshot');
    assert.equal(report.complete, false);
    for (const entry of report.sources) {
      assert.equal(entry.state, 'inconsistent_snapshot');
      assert.equal(entry.complete, false);
    }
    assert.ok(report.limitations.some((line) => /no single instant/.test(line)));
  });

  test('an unverifiable window also blocks completeness', () => {
    const report = build({
      sources: [src('memory', 'ok', 1)],
      reads: [sourceRead({ source: 'memory', status: 'ok', returned: 1, total: 1 })],
      kept: [ev('memory', 'm1')],
      profiles: { memory: prof({ returned: 1, matched: 1, eligible: 1, corpusSize: 1 }) },
      window: { state: 'unverifiable' },
    });
    assert.equal(report.state, 'inconsistent_snapshot');
    assert.equal(report.complete, false);
    assert.equal(entryOf(report, 'memory').readState, 'unverifiable');
  });
});

describe('AP-10 §6 aggregate rules', () => {
  test('the report is described by its worst source', () => {
    const report = build({
      sources: [src('memory', 'ok', 1), src('knowledge', 'unavailable', 0)],
      reads: [
        sourceRead({ source: 'memory', status: 'bounded', returned: 1, limit: 6 }),
        sourceRead({ source: 'knowledge', status: 'unavailable' }),
      ],
      kept: [ev('memory', 'm1')],
      profiles: { memory: prof({ returned: 1, matched: 1, eligible: 1, corpusSize: 3 }) },
    });
    assert.equal(report.state, 'unavailable_source');
    assert.equal(report.complete, false);
    assert.equal(worstRetrievalState(['complete_with_results', 'unavailable_source']), 'unavailable_source');
  });

  test('a retrieval with results is never described as empty', () => {
    const report = build({
      sources: [src('memory', 'ok', 1), src('knowledge', 'empty', 0)],
      reads: [
        sourceRead({ source: 'memory', status: 'bounded', returned: 1, limit: 6 }),
        sourceRead({ source: 'knowledge', status: 'bounded', returned: 0, limit: 6 }),
      ],
      kept: [ev('memory', 'm1')],
      profiles: {
        memory: prof({ returned: 1, matched: 1, eligible: 1, corpusSize: 3 }),
        knowledge: prof({ returned: 0, matched: 0, corpusSize: 0 }),
      },
    });
    assert.equal(entryOf(report, 'knowledge').state, 'complete_empty');
    assert.equal(report.state, 'complete_with_results');
    assert.equal(report.complete, true);
  });

  test('a skipped source keeps the aggregate from claiming whole-retrieval completeness', () => {
    const report = build({
      sources: [src('memory', 'ok', 1), src('audit', 'skipped', 0)],
      reads: [sourceRead({ source: 'memory', status: 'bounded', returned: 1, limit: 6 })],
      kept: [ev('memory', 'm1')],
      profiles: { memory: prof({ returned: 1, matched: 1, eligible: 1, corpusSize: 3 }) },
    });
    assert.equal(entryOf(report, 'memory').complete, true);
    assert.equal(report.complete, false);
    assert.equal(report.state, 'not_searched');
  });

  test('the report carries a schema, counts, limitations, and no authority', () => {
    const report = build({
      sources: [src('memory', 'ok', 1)],
      reads: [sourceRead({ source: 'memory', status: 'bounded', returned: 1, limit: 6 })],
      kept: [ev('memory', 'm1')],
      profiles: { memory: prof({ returned: 1, matched: 4, eligible: 1, corpusSize: 9, queryTokens: 5, droppedTokens: 2, unmatched: ['zzz'] }) },
    });
    assert.equal(report.schema, RETRIEVAL_REPORT_SCHEMA);
    assert.equal(report.authorizes, false);
    assert.equal(report.counts.sourceLimit, 3);
    assert.equal(report.counts.contributed, 1);
    const entry = entryOf(report, 'memory');
    assert.equal(entry.queryTokens, 5);
    assert.equal(entry.droppedTokens, 2);
    assert.deepEqual(entry.unmatched, ['zzz']);
    assert.ok(report.limitations.length > 0);
  });
});

describe('AP-10 §6 finalizeRetrievalReport is pure', () => {
  const base = () => build({
    sources: [src('memory', 'ok', 2), src('knowledge', 'ok', 1)],
    reads: [
      sourceRead({ source: 'memory', status: 'bounded', returned: 2, limit: 6 }),
      sourceRead({ source: 'knowledge', status: 'bounded', returned: 1, limit: 6 }),
    ],
    kept: [ev('memory', 'm1'), ev('memory', 'm2'), ev('knowledge', 'k1')],
    profiles: {
      memory: prof({ returned: 2, matched: 2, eligible: 2, corpusSize: 5 }),
      knowledge: prof({ returned: 1, matched: 1, eligible: 1, corpusSize: 3 }),
    },
  });

  test('finalization does not mutate the input report', () => {
    const report = base();
    const snapshot = JSON.stringify(report);
    finalizeRetrievalReport(report, { context: { memory: 2, knowledge: 1 } });
    assert.equal(JSON.stringify(report), snapshot);
  });

  test('a null cut is unknown and changes nothing', () => {
    const report = base();
    const finalized = finalizeRetrievalReport(report, { context: { memory: null, knowledge: null } });
    assert.deepEqual(finalized, report);
  });

  test('a budget cut never downgrades a more severe failure state', () => {
    const report = build({
      sources: [src('memory', 'unavailable', 0)],
      reads: [sourceRead({ source: 'memory', status: 'unavailable' })],
    });
    const finalized = finalizeRetrievalReport(report, { context: { memory: 3 } });
    const entry = entryOf(finalized, 'memory');
    assert.equal(entry.state, 'unavailable_source');
    assert.equal(entry.exclusions.contextBudget, 3);
    assert.equal(entry.complete, false);
  });

  test('the aggregate and limitations are recomputed after a cut', () => {
    const report = base();
    assert.equal(report.complete, true);
    const finalized = finalizeRetrievalReport(report, { context: { memory: 0, knowledge: 1 } });
    assert.equal(finalized.state, 'context_budget_limited');
    assert.equal(finalized.complete, false);
    assert.equal(finalized.counts.contextBudget, 1);
    assert.ok(finalized.limitations.some((line) => /knowledge lost 1/.test(line)));
    assert.equal(retrievalBudgetNotice(base()), '');
  });

  test('finalize rejects a foreign object', () => {
    assert.throws(() => finalizeRetrievalReport({ schema: 'other' }, { context: {} }), TypeError);
  });
});

// ---- through the real coordinator --------------------------------------------------------------

function hit(id, score, content = 'the lighthouse status is green') {
  return {
    record: { id, content, kind: 'user_fact', source: 'user', createdAt: NOW, sensitivity: 'public' },
    score, conflict: [], replaces: [], replacedBy: [], status: 'active',
  };
}

function memoryStore({ hits = [], diagnostics = {}, throws = null }) {
  return {
    search: async (_query, { limit, diagnostics: explain }) => {
      if (throws) throw throws;
      if (explain) Object.assign(explain, { terms: ['lighthouse'], droppedTokens: 0, totalTokens: 1, unmatched: [], corpusSize: 10, matched: hits.length, returned: Math.min(hits.length, limit), limit, ...diagnostics });
      return hits.slice(0, limit);
    },
  };
}

const understanding = { entities: [], goals: [], plans: [], tasks: [], intent: 'stored_information' };

describe('AP-10 §6 retrieveEvidence builds the report', () => {
  test('a limit cut through the store is source_limit_reached', async () => {
    const retrieval = await retrieveEvidence({
      request: 'lighthouse',
      understanding,
      now: new Date(NOW),
      stores: { memory: memoryStore({ hits: [hit('m1', 0.9), hit('m2', 0.8), hit('m3', 0.7)], diagnostics: { matched: 8, corpusSize: 10 } }) },
    });
    assert.ok(retrieval.report);
    assert.equal(retrieval.report.schema, RETRIEVAL_REPORT_SCHEMA);
    const entry = entryOf(retrieval.report, 'memory');
    assert.equal(entry.state, 'source_limit_reached');
    assert.equal(entry.matched, 8);
    assert.equal(entry.returned, 3);
    assert.equal(entry.exclusions.sourceLimit, 5);
    assert.equal(retrieval.read.state, 'bounded_usable', 'the AP-07 read state is unchanged');
  });

  test('an empty store is complete_empty and the audit source is not_searched', async () => {
    const retrieval = await retrieveEvidence({
      request: 'lighthouse',
      understanding,
      now: new Date(NOW),
      stores: { memory: memoryStore({ hits: [], diagnostics: { matched: 0, corpusSize: 0, returned: 0 } }) },
    });
    assert.equal(entryOf(retrieval.report, 'memory').state, 'complete_empty');
    assert.equal(entryOf(retrieval.report, 'audit').state, 'not_searched');
    assert.equal(entryOf(retrieval.report, 'memory').absenceProven, false);
  });

  test('a single fully returned match is complete_with_results', async () => {
    const retrieval = await retrieveEvidence({
      request: 'lighthouse',
      understanding,
      now: new Date(NOW),
      stores: { memory: memoryStore({ hits: [hit('m1', 0.9)], diagnostics: { matched: 1, corpusSize: 1, returned: 1 } }) },
    });
    const entry = entryOf(retrieval.report, 'memory');
    assert.equal(entry.state, 'complete_with_results');
    assert.equal(entry.complete, true);
    assert.equal(retrieval.report.complete, false, 'the skipped audit source keeps the whole retrieval incomplete');
  });

  test('an unreadable store is unavailable_source with null counts', async () => {
    const err = new Error('store could not be read');
    const retrieval = await retrieveEvidence({
      request: 'lighthouse',
      understanding,
      now: new Date(NOW),
      stores: { memory: memoryStore({ throws: err }) },
    });
    const entry = entryOf(retrieval.report, 'memory');
    assert.equal(entry.state, 'unavailable_source');
    assert.equal(entry.returned, null);
    assert.equal(entry.corpusSize, null);
  });

  test('a corrupt store is damaged_source, distinct from unavailable', async () => {
    const err = new Error('corrupt memory log');
    const retrieval = await retrieveEvidence({
      request: 'lighthouse',
      understanding,
      now: new Date(NOW),
      stores: { memory: memoryStore({ throws: err }) },
    });
    assert.equal(entryOf(retrieval.report, 'memory').state, 'damaged_source');
  });

  test('a seeded search profile carries the floor exclusions the caller observed', async () => {
    const retrieval = await retrieveEvidence({
      request: 'lighthouse',
      understanding,
      now: new Date(NOW),
      seeds: {
        memoryHits: [],
        memorySearch: { returned: 3, matched: 3, corpusSize: 10, limit: 5, totalTokens: 1, droppedTokens: 0, unmatched: [], belowRelevance: 3 },
      },
    });
    const entry = entryOf(retrieval.report, 'memory');
    assert.equal(entry.state, 'below_relevance_threshold');
    assert.equal(entry.exclusions.belowRelevance, 3);
    assert.equal(entry.returned, 3);
  });

  test('the engine surfaces the aggregate report state beside the read fields', async () => {
    const analysis = await analyzeRequest({
      request: 'lighthouse',
      requestId: 'r-report',
      now: new Date(NOW),
      stores: { memory: memoryStore({ hits: [hit('m1', 0.9)], diagnostics: { matched: 1, corpusSize: 1, returned: 1 } }) },
    });
    assert.equal(analysis.available, true);
    const audit = analysisAudit(analysis);
    assert.ok(audit.retrievalReport);
    assert.equal(audit.retrievalReport.state, analysis.retrieval.report.state);
    assert.equal(audit.retrievalReport.complete, analysis.retrieval.report.complete);
    assert.equal(audit.read.state, analysis.retrieval.read.state, 'the existing read block is unchanged');
  });
});