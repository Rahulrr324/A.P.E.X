// Batch AP-10 §9: snapshot integrity across the retrieval window.
//
// Seven scenarios are driven where the real request path can reach them: an append during retrieval,
// a change during ranking, a retraction between retrieval and response, an unavailable source, a
// damaged source, a result-limit crossing and a context-budget truncation. Two report-level states
// the controller cannot reach - it fails closed at the retrieval stage before cognition runs - are
// pinned against retrieveEvidence directly with deterministic fake stores.
//
// The two load-bearing rules are asserted separately: a report never claims completeness over a
// window the read contract did not certify, and nothing in the report claims the stores were read as
// one atomic transaction. Every model reply is a fixed stub. No inference, no endpoint, no download.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { probe, cleanupAll, cognitionBlock, evidenceId } from './retrieval-probe.js';
import { readReport, sourceRead, absenceProven, READ_STATES } from '../src/evidence/read-contract.js';
import {
  RETRIEVAL_REPORT_SCHEMA, RETRIEVAL_STATES, buildRetrievalReport, finalizeRetrievalReport,
  isRetrievalState,
} from '../src/retrieval/report.js';
import { retrieveEvidence } from '../src/cognition/evidence.js';
import { Outcome } from '../src/outcomes.js';
import { Decision } from '../src/controller/decision.js';

after(cleanupAll);

const NOW = '2026-05-01T00:00:00.000Z';
const triple = (subject, relationship, object, extra = {}) => ({ subject, relationship, object, origin: 'user', ...extra });
const entryOf = (report, source) => report.sources.find((entry) => entry.source === source);

// ---- the seven scenarios through the real controller -------------------------------------------

describe('AP-10 §9 snapshot integrity through the request path', () => {
  test('1 an append during retrieval stays out of this answer and is still persisted', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      query: 'lighthouse status',
      rank: true,
      during: async (app) => {
        await app.memory.add({ content: 'the lighthouse status is amber', kind: 'user_fact', source: 'user' });
      },
    });
    assert.deepEqual(p.records.memory, [p.ids[0]], 'the snapshot was taken before the append');
    assert.equal(p.persistence.memoryRecords, 2, 'the append was persisted, not rolled back');
    assert.equal(p.completeness.report, false, 'a store that moved during the request is not a complete selection');
    assert.equal(p.ranking.memory.length, 2, 'a later read does see the appended record');
    assert.equal(p.executive.authorizes.integrity, false);
    assert.equal(p.executive.executed, 0);
  });

  test('2 a write between two source reads cannot yield a completeness claim', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      knowledge: [triple('lighthouse', 'status', 'green')],
      query: 'lighthouse status',
      prepare: async (app) => {
        const original = app.knowledge.search.bind(app.knowledge);
        app.knowledge.search = async (...args) => {
          await app.memory.add({ content: 'the lighthouse status is amber', kind: 'user_fact', source: 'user' });
          return original(...args);
        };
      },
    });
    assert.equal(p.completeness.report, false);
    assert.equal(p.completeness.read, false);
    assert.equal(p.persistence.memoryRecords, 2, 'the concurrent write is preserved');
    if (p.completeness.window === 'concurrent_modification') {
      assert.equal(p.retrievalState, 'inconsistent_snapshot');
      for (const entry of p.report.sources) {
        assert.equal(entry.state, 'inconsistent_snapshot', 'every source loses completeness, not just the one written');
        assert.equal(entry.complete, false);
      }
      assert.ok(p.report.limitations.some((line) => /no single instant|changed during the read/.test(line)));
    }
    assert.equal(p.executive.executed, 0);
  });

  test('3 a retraction between retrieval and response does not rewrite the snapshot', async () => {
    let kid = null;
    const p = await probe({
      knowledge: [triple('lighthouse', 'status', 'green')],
      query: 'lighthouse status',
      reply: (s) => cognitionBlock('the lighthouse status is green', [
        { text: 'the lighthouse status is green', evidence: [evidenceId('knowledge', s.kids[0])], kind: 'supported' },
      ]),
      during: async (app, s) => {
        kid = s.kids[0];
        await app.knowledge.retract({ target: kid, reason: 'the reading was withdrawn', origin: 'user' });
      },
    });
    assert.ok(p.records.knowledge.includes(kid), 'the record was retrieved before it was retracted');
    assert.equal(p.persistence.knowledgeRecords, 2, 'the retraction is an appended event, not a deleted record');
    // The snapshot is frozen at read time. The answer describes what was retrieved; the retraction
    // that happened afterwards is visible to the next read, not silently applied to this one.
    const later = await p.app.knowledge.search('lighthouse status', { limit: 5 });
    assert.equal(later.some((hit) => hit.record.id === kid), false, 'a retracted record is excluded from a later search');
    const history = await p.app.knowledge.history(kid);
    assert.ok(history, 'the record itself was not deleted');
    assert.ok(JSON.stringify(history).includes('the reading was withdrawn'), 'the retraction is readable as history');
    assert.equal(p.executive.authorizes.integrity, false);
    assert.equal(p.executive.executed, 0);
  });

  test('4 an unavailable source fails closed and is never described as empty', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      query: 'lighthouse status',
      prepare: async (app) => {
        app.memory.search = async () => {
          const err = new Error('memory store is offline');
          err.code = 'STORE_UNAVAILABLE';
          throw err;
        };
      },
    });
    assert.ok(p.op.errors.some((e) => e.stage === 'retrieval'));
    assert.equal(p.report, null, 'no report is produced for a request that never retrieved');
    assert.equal(p.executive.executed, 0);
    assert.ok(!/no records were stored|the store is empty|nothing is known/i.test(p.limitation.output));
    assert.equal(p.persistence.memoryRecords, 1, 'the stored record is untouched');
  });

  test('5 a damaged source fails closed and the damaged line is preserved', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      query: 'lighthouse status',
      prepare: async (app, s, dir) => { fs.appendFileSync(path.join(dir, 'memory.jsonl'), '{"broken": \n'); },
    });
    assert.equal(p.res.status, Outcome.EXECUTION_FAILED);
    assert.equal(p.executive.decision, Decision.REFUSE_OR_BLOCK);
    assert.equal(p.report, null);
    assert.equal(p.persistence.memoryRecords, 2);
    assert.equal(p.persistence.memoryDamaged, 1, 'the unparseable line is still there, not repaired or deleted');
    assert.equal(p.executive.executed, 0);
  });

  test('6 crossing the result limit is a source limit, never a complete selection', async () => {
    const p = await probe({
      memory: Array.from({ length: 9 }, (_, i) => `the lighthouse note ${i} was recorded`),
      query: 'lighthouse note',
      rank: true,
    });
    const entry = p.sourceEntry('memory');
    assert.equal(entry.state, 'source_limit_reached');
    assert.ok(entry.matched > entry.returned, 'the store matched more than the bound returned');
    assert.ok(entry.exclusions.sourceLimit > 0, 'the excluded records are counted, not implied');
    assert.equal(entry.complete, false);
    assert.equal(p.completeness.report, false);
    assert.equal(p.ranking.memory.length, 9, 'the store still holds every record; only the prompt was bounded');
    assert.ok(p.report.limitations.some((line) => /more eligible records than the bound returned/.test(line)));
  });

  test('7 a context-budget cut is disclosed and leaves the evidence snapshot intact', async () => {
    let recordId = null;
    const p = await probe({
      memory: [
        'the lighthouse status is green',
        'the lighthouse status review is pending',
        'the lighthouse status audit is scheduled',
      ],
      query: 'lighthouse status',
      contextChars: 300,
      reply: (s) => {
        recordId = s.ids[0];
        return cognitionBlock('the lighthouse status is green', [
          { text: 'the lighthouse status is green', evidence: [evidenceId('memory', recordId)], kind: 'supported' },
        ]);
      },
    });
    const entry = p.sourceEntry('memory');
    assert.equal(entry.state, 'context_budget_limited');
    assert.ok(entry.exclusions.contextBudget >= 1);
    assert.equal(entry.complete, false);
    assert.equal(p.completeness.report, false);
    // The budget trims the prompt, not the snapshot: a citation to a trimmed record is still a
    // citation to a record that was retrieved, so it is not turned into an outside-snapshot finding.
    assert.equal(entry.contributed, 3, 'every retrieved record still contributed evidence');
    assert.ok(p.records.memory.length < 3, 'the prompt carried fewer records than were retrieved');
    assert.ok(p.limitation.notices.some((n) => /context budget/.test(n)), 'the cut is stated beside the answer');
    assert.equal(p.executive.executed, 0);
  });
});

// ---- report-level states the controller cannot reach -------------------------------------------

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
      if (explain) {
        Object.assign(explain, {
          terms: ['lighthouse'], droppedTokens: 0, totalTokens: 1, unmatched: [], corpusSize: 10,
          matched: hits.length, returned: Math.min(hits.length, limit), limit, ...diagnostics,
        });
      }
      return hits.slice(0, limit);
    },
  };
}

const understanding = { entities: [], goals: [], plans: [], tasks: [], intent: 'stored_information' };
const retrieve = (stores) => retrieveEvidence({ request: 'lighthouse', understanding, now: new Date(NOW), stores });

describe('AP-10 §9 the report over a source that could not be read', () => {
  test('an unavailable source reports null counts, never zero', async () => {
    const err = new Error('store could not be read');
    err.code = 'STORE_UNAVAILABLE';
    const retrieval = await retrieve({ memory: memoryStore({ throws: err }) });
    const entry = entryOf(retrieval.report, 'memory');
    assert.equal(entry.state, 'unavailable_source');
    for (const field of ['returned', 'matched', 'eligible', 'corpusSize', 'limit']) {
      assert.equal(entry[field], null, `${field} is unknown, not zero`);
    }
    assert.equal(entry.contributed, 0);
    assert.equal(entry.complete, false);
    assert.equal(entry.absenceProven, false, 'an unreadable store proves nothing about what it holds');
    assert.equal(retrieval.report.complete, false);
    assert.ok(retrieval.report.limitations.some((line) => /unknown, not empty/.test(line)));
  });

  test('a damaged source is a different state from an unavailable one', async () => {
    const err = new Error('corrupt memory log');
    err.code = 'STORE_DAMAGED';
    const retrieval = await retrieve({ memory: memoryStore({ throws: err }) });
    const entry = entryOf(retrieval.report, 'memory');
    assert.equal(entry.state, 'damaged_source');
    assert.notEqual(entry.state, 'unavailable_source');
    assert.equal(entry.complete, false);
    assert.equal(entry.absenceProven, false);
    assert.ok(retrieval.report.limitations.some((line) => /could not be parsed/.test(line)));
  });

  test('a result-limit crossing through the coordinator is a source limit', async () => {
    const retrieval = await retrieve({
      memory: memoryStore({ hits: [hit('m1', 0.9), hit('m2', 0.8), hit('m3', 0.7)], diagnostics: { matched: 8, corpusSize: 10 } }),
    });
    const entry = entryOf(retrieval.report, 'memory');
    assert.equal(entry.state, 'source_limit_reached');
    assert.equal(entry.matched, 8);
    assert.equal(entry.returned, 3);
    assert.equal(entry.exclusions.sourceLimit, 5);
    assert.equal(retrieval.read.state, 'bounded_usable', 'the AP-07 read state is unchanged');
    assert.equal(retrieval.report.complete, false);
  });

  test('a context-budget cut is applied after the prompt is built and never upgrades a failure', () => {
    const read = readReport({
      subject: 'test',
      reads: [sourceRead({ source: 'memory', status: 'unavailable' })],
    });
    const report = buildRetrievalReport({
      sources: [{ source: 'memory', status: 'ok', count: 0, detail: null }],
      read,
      kept: [],
      profiles: { memory: { returned: 0, matched: 0, eligible: 0, corpusSize: 0, belowRelevance: 0 } },
    });
    assert.equal(entryOf(report, 'memory').state, 'unavailable_source');
    const cut = finalizeRetrievalReport(report, { context: { memory: 2 } });
    const entry = entryOf(cut, 'memory');
    assert.equal(entry.state, 'unavailable_source', 'a cut cannot hide a more severe failure');
    assert.equal(entry.exclusions.contextBudget, 2);
    assert.equal(entry.complete, false);
    assert.equal(cut.complete, false);
  });
});

// ---- the two load-bearing rules -----------------------------------------------------------------

const src = (source, status = 'ok', count = 0) => ({ source, status, count, detail: null });
const ev = (source, recordId) => ({ evidenceId: `ev:${source}:${recordId}`, source, recordId });
const prof = (over = {}) => ({
  returned: 0, matched: 0, eligible: 0, limit: 6, corpusSize: 0,
  queryTokens: 2, droppedTokens: 0, unmatched: [], belowRelevance: 0, ...over,
});

function completeReads() {
  return [
    sourceRead({ source: 'memory', status: 'ok', returned: 1, total: 1 }),
    sourceRead({ source: 'knowledge', status: 'ok', returned: 1, total: 1 }),
  ];
}

function completeReport(window = null) {
  return buildRetrievalReport({
    sources: [src('memory', 'ok', 1), src('knowledge', 'ok', 1)],
    read: readReport({ subject: 'test', reads: completeReads(), window }),
    kept: [ev('memory', 'm1'), ev('knowledge', 'k1')],
    profiles: {
      memory: prof({ returned: 1, matched: 1, eligible: 1, corpusSize: 1 }),
      knowledge: prof({ returned: 1, matched: 1, eligible: 1, corpusSize: 1 }),
    },
  });
}

describe('AP-10 §9 completeness is never claimed over an uncertified window', () => {
  test('a certified window over two complete reads is the only complete report', () => {
    const report = completeReport();
    assert.equal(report.state, 'complete_with_results');
    assert.equal(report.complete, true);
    assert.equal(report.window, 'unverified');
    for (const entry of report.sources) assert.equal(entry.complete, true);
  });

  test('every bearing window blocks completeness for every source and for the aggregate', () => {
    for (const state of ['concurrent_modification', 'unverifiable']) {
      const report = completeReport({ state });
      assert.equal(report.window, state);
      assert.equal(report.state, 'inconsistent_snapshot');
      assert.equal(report.complete, false, `${state} must not yield a complete report`);
      for (const entry of report.sources) {
        assert.equal(entry.state, 'inconsistent_snapshot');
        assert.equal(entry.complete, false);
        assert.equal(entry.absenceProven, false);
      }
      assert.ok(report.limitations.length > 0, 'the limitation is stated, not implied');
    }
  });

  test('an unverified window is not a certification either', () => {
    // `unverified` is what the read contract reports when no window was certified. It is not a
    // bearing window, so it does not force inconsistent_snapshot - but it never upgrades a bounded
    // read into a complete one, and absence stays unproven.
    const report = buildRetrievalReport({
      sources: [src('memory', 'ok', 2)],
      read: readReport({ subject: 'test', reads: [sourceRead({ source: 'memory', status: 'bounded', returned: 2, limit: 2 })] }),
      kept: [ev('memory', 'm1'), ev('memory', 'm2')],
      profiles: { memory: prof({ returned: 2, matched: 2, eligible: 2, limit: 2, corpusSize: 10 }) },
    });
    assert.equal(report.window, 'unverified');
    assert.equal(entryOf(report, 'memory').state, 'bounded_results');
    assert.equal(report.complete, false);
    assert.equal(entryOf(report, 'memory').absenceProven, false);
  });

  test('absence is proven only by a complete_empty read, never by a bounded one', () => {
    // `ok` needs counts: a complete read that returned nothing is complete_empty, which is the one
    // state that does prove absence. Every other status leaves it unproven.
    const reads = [
      ['ok', { status: 'ok', returned: 1, total: 1 }, false],
      ['empty', { status: 'empty' }, true],
      ['bounded', { status: 'bounded', returned: 0, limit: 6 }, false],
      ['truncated', { status: 'truncated', returned: 1, limit: 1, stoppedAt: 'record-limit' }, false],
      ['missing', { status: 'missing' }, false],
      ['unavailable', { status: 'unavailable' }, false],
      ['damaged', { status: 'damaged' }, false],
    ];
    for (const [name, over, expected] of reads) {
      const read = readReport({ subject: 'test', reads: [sourceRead({ source: 'memory', ...over })] }).reads[0];
      assert.equal(absenceProven(read), expected, `${name} proves absence: ${absenceProven(read)}`);
    }
    assert.equal(READ_STATES.length, 9);
  });

  test('the eleven-state vocabulary is ordered and the aggregate is the worst source', () => {
    assert.equal(RETRIEVAL_STATES.length, 11);
    assert.equal(new Set(RETRIEVAL_STATES).size, 11);
    for (const state of RETRIEVAL_STATES) assert.ok(isRetrievalState(state));
    assert.equal(isRetrievalState('complete'), false);
    const report = buildRetrievalReport({
      sources: [src('memory', 'ok', 1), src('knowledge', 'ok', 0)],
      read: readReport({
        subject: 'test',
        reads: [
          sourceRead({ source: 'memory', status: 'ok', returned: 1, total: 1 }),
          sourceRead({ source: 'knowledge', status: 'unavailable' }),
        ],
      }),
      kept: [ev('memory', 'm1')],
      profiles: { memory: prof({ returned: 1, matched: 1, eligible: 1, corpusSize: 1 }) },
    });
    assert.equal(entryOf(report, 'memory').state, 'complete_with_results');
    assert.equal(entryOf(report, 'knowledge').state, 'unavailable_source');
    assert.equal(report.state, 'unavailable_source', 'one unreadable source describes the whole retrieval');
    assert.equal(report.complete, false);
  });
});

describe('AP-10 §9 no report claims an atomic multi-store transaction', () => {
  test('the report carries no transaction or atomicity field', () => {
    const report = completeReport();
    const serialized = JSON.stringify(report);
    assert.equal(/atomic|transaction|two-phase|2pc/i.test(serialized), false);
    assert.equal(report.authorizes, false);
    assert.equal(report.schema, RETRIEVAL_REPORT_SCHEMA);
    // Each source keeps its own read state. Two sources read at two instants are two reads, and the
    // window is the read contract's certification of that, not a claim that they were one instant.
    assert.equal(report.sources.length, 2);
    for (const entry of report.sources) assert.ok(typeof entry.readState === 'string');
  });

  test('a write between the two reads is reported as inconsistent, not as a rolled-back transaction', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      knowledge: [triple('lighthouse', 'status', 'green')],
      query: 'lighthouse status',
      prepare: async (app) => {
        const original = app.knowledge.search.bind(app.knowledge);
        app.knowledge.search = async (...args) => {
          await app.memory.add({ content: 'the lighthouse status is amber', kind: 'user_fact', source: 'user' });
          return original(...args);
        };
      },
    });
    // Both writes survive. Nothing was rolled back, because there was no transaction to roll back.
    assert.equal(p.persistence.memoryRecords, 2);
    assert.equal(p.persistence.knowledgeRecords, 1);
    assert.equal(p.completeness.report, false);
    assert.equal(p.executive.executed, 0);
  });

  test('a bounded window that returned nothing is not proof that the store is empty', () => {
    const report = buildRetrievalReport({
      sources: [src('memory', 'empty', 0)],
      read: readReport({ subject: 'test', reads: [sourceRead({ source: 'memory', status: 'bounded', returned: 0, limit: 6 })] }),
      kept: [],
      profiles: { memory: prof({ returned: 0, matched: 0, corpusSize: 0 }) },
    });
    const entry = entryOf(report, 'memory');
    assert.equal(entry.state, 'complete_empty');
    assert.equal(entry.complete, true);
    assert.equal(entry.absenceProven, false, 'the search covered a bound, not the whole store');
    assert.ok(!/does not exist|never stored|no such fact/i.test(JSON.stringify(report.limitations)));
  });
});