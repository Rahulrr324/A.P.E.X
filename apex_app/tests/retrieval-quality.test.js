// Batch AP-10: retrieval-quality evaluation. Deterministic metrics, a synthetic fixture corpus run
// through the real stores, normalization distinctions, size stability, and the measured precision
// trade-off. No model, no network, no inference: every record is a synthetic fixture and every clock
// is fixed. The metric functions are asserted against hand-computed values including every
// not-computable branch; the corpus is asserted against the labels and the scores the stores produce.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { MemoryStore, PROMPT_RELEVANCE_MIN, tokenize as memoryTokenize } from '../src/memory/memory-store.js';
import { KnowledgeStore } from '../src/knowledge/knowledge-store.js';
import { normalizeTokens, queryTokens, MAX_QUERY_TOKENS } from '../src/retrieval/normalize.js';
import { isIdentifierToken } from '../src/retrieval/relevance.js';
import { selectPromptKnowledge, selectPromptMemory, KNOWLEDGE_PROMPT_RELEVANCE_MIN, dedupeKnowledge } from '../src/controller/context.js';
import {
  precisionAtK, recallAtK, reciprocalRank, relevantCoverage, irrelevantInclusion,
  citationCoverage, latencyStats, truncationCounts, evaluateRetrieval, buildSyntheticCorpus,
} from '../src/retrieval/evaluate.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const NOW = () => new Date('2026-06-01T00:00:00.000Z');
const FLOOR = 0.2;
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);

describe('AP-10 metric functions report a value or an explicit reason, never a fake number', () => {
  test('precisionAtK', () => {
    close(precisionAtK(['a', 'b', 'c'], ['a', 'c'], 2).value, 0.5, 'one of top two relevant');
    close(precisionAtK(['a', 'b'], ['a', 'b'], 5).value, 1, 'all retrieved relevant');
    close(precisionAtK(['a', 'b', 'c'], [], 2).value, 0, 'empty relevant set is precision 0, not null');
    assert.equal(precisionAtK([], ['a'], 3).value, null);
    assert.match(precisionAtK([], ['a'], 3).reason, /nothing was retrieved/);
    assert.equal(precisionAtK(['a'], ['a'], 0).value, null);
    assert.match(precisionAtK(['a'], ['a'], 0).reason, /positive integer/);
    assert.equal(precisionAtK(['a'], ['a'], -1).value, null);
    assert.equal(precisionAtK(['a'], ['a'], 1.5).value, null);
  });

  test('recallAtK needs a relevant denominator', () => {
    close(recallAtK(['a', 'b'], ['a', 'b', 'c'], 2).value, 2 / 3, 'two of three relevant in top two');
    close(recallAtK(['a', 'b', 'c', 'd'], ['a', 'c'], 2).value, 0.5, 'K cut limits recall');
    close(recallAtK([], ['a'], 3).value, 0, 'nothing retrieved with a relevant set is recall 0');
    assert.equal(recallAtK(['a'], [], 3).value, null);
    assert.match(recallAtK(['a'], [], 3).reason, /no denominator/);
    assert.equal(recallAtK(['a'], ['a'], 0).value, null);
    assert.match(recallAtK(['a'], ['a'], 0).reason, /positive integer/);
  });

  test('reciprocalRank', () => {
    close(reciprocalRank(['x', 'a', 'y'], ['a']).value, 0.5, 'first relevant at rank 2');
    close(reciprocalRank(['a'], ['a']).value, 1, 'first relevant at rank 1');
    close(reciprocalRank(['x', 'y'], ['a']).value, 0, 'no relevant retrieved is 0');
    close(reciprocalRank([], ['a']).value, 0, 'empty retrieval is 0');
    assert.equal(reciprocalRank(['a'], []).value, null);
    assert.match(reciprocalRank(['a'], []).reason, /relevant set is empty/);
  });

  test('relevantCoverage is before any K cut', () => {
    close(relevantCoverage(['a', 'b'], ['a', 'b', 'c']).value, 2 / 3, 'two of three surfaced');
    close(relevantCoverage(['a', 'b', 'c', 'd'], ['a', 'c']).value, 1, 'all relevant surfaced regardless of rank');
    close(relevantCoverage([], ['a']).value, 0, 'none surfaced');
    assert.equal(relevantCoverage(['a'], []).value, null);
    assert.match(relevantCoverage(['a'], []).reason, /relevant set is empty/);
  });

  test('irrelevantInclusion separates unlabelled from irrelevant', () => {
    const r = irrelevantInclusion(['a', 'b', 'c'], ['a'], ['b']);
    assert.equal(r.count, 1);
    close(r.fraction, 1 / 3, 'one of three retrieved is known-irrelevant');
    assert.equal(r.unlabelled, 1, 'c is in neither labelled set');
    const none = irrelevantInclusion(['a', 'b'], ['a'], []);
    assert.equal(none.count, 0);
    close(none.fraction, 0, 'no known-irrelevant retrieved');
    assert.equal(none.unlabelled, 1);
    const empty = irrelevantInclusion([], ['a'], ['b']);
    assert.equal(empty.count, 0);
    assert.equal(empty.fraction, null);
    assert.match(empty.reason, /nothing was retrieved/);
    const dup = irrelevantInclusion(['b', 'b'], [], ['b']);
    assert.equal(dup.count, 2);
    close(dup.fraction, 1, 'every retrieved record is irrelevant');
  });

  test('citationCoverage resolves, dangles, and does not treat retrieved as should-be-cited', () => {
    const claims = [
      { claimId: 'c1', citedRecordIds: ['a', 'z'] },
      { claimId: 'c2', citedRecordIds: ['b'] },
    ];
    const r = citationCoverage(claims, ['a', 'b'], ['a', 'b']);
    assert.equal(r.claims[0].resolved, 1);
    assert.equal(r.claims[0].dangling, 1);
    assert.deepEqual(r.claims[0].danglingIds, ['z']);
    assert.equal(r.claims[1].resolved, 1);
    assert.equal(r.overall.totalCitations, 3);
    assert.equal(r.overall.resolved, 2);
    assert.equal(r.overall.dangling, 1);
    assert.equal(r.overall.uncitedRelevant, 0, 'both relevant retrieved records were cited');
    assert.equal(r.overall.reason, null);

    const uncited = citationCoverage([{ claimId: 'c1', citedRecordIds: ['a'] }], ['a', 'b'], ['a', 'b', 'c']);
    assert.deepEqual(uncited.overall.uncitedRelevantIds, ['b'], 'b retrieved and relevant but never cited; c not retrieved');
    assert.equal(uncited.overall.uncitedRelevant, 1);

    const noLabels = citationCoverage(claims, ['a', 'b']);
    assert.equal(noLabels.overall.uncitedRelevant, null);
    assert.match(noLabels.overall.reason, /not treated as should-be-cited/);

    const noClaims = citationCoverage([], ['a'], ['a']);
    assert.equal(noClaims.overall.totalCitations, 0);
    assert.equal(noClaims.overall.uncitedRelevant, 1, 'a relevant retrieved record with no claim citing it');
  });

  test('latencyStats reports median, min, max, count and no mean', () => {
    const odd = latencyStats([10, 20, 30]);
    assert.equal(odd.median, 20); assert.equal(odd.min, 10); assert.equal(odd.max, 30); assert.equal(odd.count, 3);
    const even = latencyStats([10, 20, 30, 40]);
    assert.equal(even.median, 25); assert.equal(even.count, 4);
    const one = latencyStats([5]);
    assert.equal(one.median, 5); assert.equal(one.min, 5); assert.equal(one.max, 5); assert.equal(one.count, 1);
    const unsorted = latencyStats([3, 1, 2]);
    assert.equal(unsorted.median, 2);
    const empty = latencyStats([]);
    assert.equal(empty.median, null); assert.equal(empty.count, 0);
    assert.match(empty.reason, /no finite latency samples/);
    const junk = latencyStats([NaN, Infinity, 'x']);
    assert.equal(junk.count, 0); assert.equal(junk.median, null);
    assert.ok(!('mean' in odd), 'no mean-only reporting');
  });

  test('truncationCounts', () => {
    const cut = truncationCounts({ matched: 10, returned: 5, limit: 5, droppedTokens: 3 });
    assert.equal(cut.resultsCut, 5); assert.equal(cut.tokensDropped, 3); assert.equal(cut.reason, null);
    const none = truncationCounts({ matched: 3, returned: 3, limit: 5, droppedTokens: 0 });
    assert.equal(none.resultsCut, 0); assert.equal(none.tokensDropped, 0);
    const missing = truncationCounts({ returned: 5 });
    assert.equal(missing.resultsCut, null);
    assert.match(missing.reason, /must be integers/);
    const noTokens = truncationCounts({ matched: 5, returned: 5 });
    assert.equal(noTokens.tokensDropped, 0);
  });

  test('evaluateRetrieval returns separate named metrics and no aggregate score', async () => {
    const dir = tempDir();
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'), { now: NOW });
    const a = await store.add({ content: 'lighthouse project status green', kind: 'user_fact', source: 'user' });
    await store.add({ content: 'banana bread recipe guide', kind: 'user_fact', source: 'user' });
    const ev = await evaluateRetrieval({
      store, query: 'lighthouse project status', relevantIds: [a.id], irrelevantIds: [], k: 5, limit: 5,
      claims: [{ claimId: 'c1', citedRecordIds: [a.id] }],
    });
    assert.deepEqual(ev.retrievedIds, [a.id]);
    close(ev.precisionAtK.value, 1, 'precision');
    close(ev.recallAtK.value, 1, 'recall');
    close(ev.reciprocalRank.value, 1, 'rr');
    assert.equal(ev.citationCoverage.overall.resolved, 1);
    assert.ok(ev.latencyStats.count >= 1);
    assert.equal(ev.truncationCounts.reason, null);
    for (const forbidden of ['accuracy', 'overallScore', 'score', 'f1', 'combined']) {
      assert.ok(!(forbidden in ev), `no aggregate field ${forbidden}`);
    }
    await assert.rejects(() => evaluateRetrieval({ query: 'x' }), /requires a store/);
  });
});

describe('AP-10 normalization keeps the distinctions retrieval depends on', () => {
  test('negation is not erased', () => {
    const negated = memoryTokenize('not completed');
    const plain = memoryTokenize('completed');
    assert.ok(negated.includes('not'));
    assert.ok(!plain.includes('not'));
    assert.notDeepEqual(negated, plain);
    assert.notDeepEqual(queryTokens('the task is not completed', { stem: true }).tokens, queryTokens('the task is completed', { stem: true }).tokens);
  });

  test('a number is not merged with a longer number', () => {
    assert.deepEqual(normalizeTokens('10'), ['10']);
    assert.deepEqual(normalizeTokens('100'), ['100']);
    assert.equal(normalizeTokens('10').includes('100'), false);
    assert.equal(normalizeTokens('100').includes('10'), false);
  });

  test('a date is not reordered into another date', () => {
    const june = normalizeTokens('2026-06-01');
    const jan = normalizeTokens('2026-01-06');
    assert.ok(june.includes('2026-06-01'));
    assert.ok(jan.includes('2026-01-06'));
    assert.equal(june.includes('2026-01-06'), false);
    assert.equal(jan.includes('2026-06-01'), false);
    assert.notDeepEqual(june, jan);
  });

  test('an identifier is not folded into a near identifier', () => {
    const ten = normalizeTokens('AP-10');
    const eleven = normalizeTokens('AP-11');
    assert.ok(ten.includes('ap-10'));
    assert.ok(eleven.includes('ap-11'));
    assert.equal(ten.includes('ap-11'), false);
    assert.equal(eleven.includes('ap-10'), false);
    assert.ok(isIdentifierToken('ap-10'));
    assert.ok(isIdentifierToken('2026-06-01'));
    assert.ok(isIdentifierToken('10'));
    assert.equal(isIdentifierToken('lighthouse'), false);
  });

  test('two similar but distinct entity names stay distinct', () => {
    assert.notDeepEqual(normalizeTokens('maria gonzalez'), normalizeTokens('maria gonzales'));
    assert.notDeepEqual(memoryTokenize('maria gonzalez'), memoryTokenize('maria gonzales'));
  });
});

// Expected quality per fixture class, measured against the real stores. memory and knowledge agree
// except where lifecycle or deduplication differs. P@5 / R@5 / reciprocal rank.
const EXPECTED = {
  exact_match: { memory: [1, 1, 1], knowledge: [1, 1, 1] },
  partial_match: { memory: [1, 1, 1], knowledge: [1, 1, 1] },
  synonym_lexical: { memory: [0.5, 1, 1], knowledge: [0.5, 1, 1] },
  word_order_varied: { memory: [1, 1, 1], knowledge: [1, 1, 1] },
  short_query: { memory: [1, 1, 1], knowledge: [1, 1, 1] },
  long_query: { memory: [1, 1, 1], knowledge: [1, 1, 1] },
  common_term: { memory: [0.25, 1, 0.25], knowledge: [0.25, 1, 0.25] },
  rare_term: { memory: [1, 1, 1], knowledge: [1, 1, 1] },
  numbers: { memory: [1, 1, 1], knowledge: [1, 1, 1] },
  dates: { memory: [0.5, 1, 1], knowledge: [0.5, 1, 1] },
  entity_names: { memory: [0.5, 1, 1], knowledge: [0.5, 1, 1] },
  related_but_irrelevant: { memory: [0.5, 1, 1], knowledge: [0.5, 1, 1] },
  misleading_lexical_overlap: { memory: [0.5, 1, 1], knowledge: [0.5, 1, 1] },
  contradictory: { memory: [1, 1, 1], knowledge: [1, 1, 1] },
  superseded: { memory: [0.5, 1, 1], knowledge: [1, 1, 1] },
  retracted: { memory: [1, 1, 1], knowledge: [1, 1, 1] },
  duplicate_near_duplicate: { memory: [1, 2 / 3, 1], knowledge: [1, 1, 1] },
};

test('AP-10 fixture corpus: relevant retrieved and ranked, irrelevant excluded, quality reported', async (t) => {
  // The corpus is shared by every subtest, so it must outlive them: the per-test afterEach would
  // otherwise delete the store files after the first subtest and every later search would read an
  // empty store. t.after cleans it once, after all subtests have run.
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const { cases } = await buildSyntheticCorpus({ dir });
  assert.equal(cases.length, 17, 'every named fixture class is present');
  const byName = Object.fromEntries(cases.map((c) => [c.name, c]));
  const rows = [];

  await t.test('per-class precision/recall/RR match the measured quality and labels hold', async () => {
    for (const c of cases) {
      for (const side of ['memory', 'knowledge']) {
        const s = c[side];
        const ev = await evaluateRetrieval({ store: s.store, query: c.query, relevantIds: s.relevant, irrelevantIds: s.irrelevant, k: 5, limit: 5 });
        const rank = (id) => ev.retrievedIds.indexOf(id) + 1;
        const [p, r, rr] = EXPECTED[c.name][side];
        close(ev.precisionAtK.value, p, `${c.name}/${side} precision@5`);
        close(ev.recallAtK.value, r, `${c.name}/${side} recall@5`);
        close(ev.reciprocalRank.value, rr, `${c.name}/${side} reciprocal rank`);
        // Every known-relevant record surfaces, except the deduplicated green copy in memory.
        if (!(c.name === 'duplicate_near_duplicate' && side === 'memory')) {
          assert.equal(ev.relevantCoverage.value, 1, `${c.name}/${side} covers all relevant`);
        }
        for (const id of s.irrelevant) {
          if (c.irrelevantRetrievedByDesign) {
            assert.ok(rank(id) > 0, `${c.name}/${side} related/misleading record is retrieved by lexical overlap`);
          } else {
            assert.equal(rank(id), 0, `${c.name}/${side} known-irrelevant record must not be retrieved`);
          }
        }
        if (c.irrelevantRetrievedByDesign) {
          assert.equal(ev.irrelevantInclusion.count, 1, `${c.name}/${side} reports the irrelevant inclusion`);
          assert.ok(ev.precisionAtK.value < 1, `${c.name}/${side} precision degraded by lexical overlap`);
        }
        rows.push([c.name, side, ev.precisionAtK.value, ev.recallAtK.value, ev.reciprocalRank.value, ev.relevantCoverage.value, ev.irrelevantInclusion.count, ev.irrelevantInclusion.unlabelled]);
      }
    }
    const header = ['class', 'store', 'P@5', 'R@5', 'RR', 'cov', 'irr', 'unlab'];
    const table = [header, ...rows.map((row) => row.map((v) => (typeof v === 'number' ? Number(v.toFixed(4)) : v)))];
    console.log('\nAP-10 retrieval quality (lexical coverage, not semantic understanding):');
    console.log(table.map((row) => row.map((cell) => String(cell).padEnd(26)).join('')).join('\n'));
  });

  await t.test('long query discloses token truncation', async () => {
    const c = byName.long_query;
    for (const side of ['memory', 'knowledge']) {
      const ev = await evaluateRetrieval({ store: c[side].store, query: c.query, relevantIds: c[side].relevant, k: 5, limit: 5 });
      assert.ok(ev.truncationCounts.tokensDropped > 0, `${side} dropped tokens disclosed`);
      assert.equal(ev.truncationCounts.tokensDropped, ev.diagnostics.totalTokens - MAX_QUERY_TOKENS);
      assert.ok(ev.retrievedIds.length > 0, `${side} still retrieves the relevant record from the kept prefix`);
    }
  });

  await t.test('numbers and dates keep their distinctions in retrieval', async () => {
    const num = byName.numbers;
    for (const side of ['memory', 'knowledge']) {
      const ev = await evaluateRetrieval({ store: num[side].store, query: num.query, relevantIds: num[side].relevant, irrelevantIds: num[side].irrelevant, k: 5, limit: 5 });
      assert.equal(ev.irrelevantInclusion.count, 0, `${side} 10 does not retrieve 100`);
    }
    const dates = byName.dates;
    for (const side of ['memory', 'knowledge']) {
      const ev = await evaluateRetrieval({ store: dates[side].store, query: dates.query, relevantIds: dates[side].relevant, k: 5, limit: 5 });
      const nearRank = ev.retrievedIds.indexOf(dates[side].neutral[0]) + 1;
      assert.equal(ev.retrievedIds[0], dates[side].relevant[0], `${side} exact date ranks first`);
      assert.ok(nearRank > 1, `${side} reordered date ranks below the exact date`);
    }
  });

  await t.test('contradictory claims stay retrievable and marked, never merged', async () => {
    const c = byName.contradictory;
    const mHits = await c.memory.store.search(c.query, { limit: 5 });
    assert.equal(mHits.length, 2);
    for (const h of mHits) {
      assert.equal(h.status, 'unresolved_conflict');
      assert.equal(h.conflict.length, 1, 'each memory claim names its contradicting partner');
    }
    assert.notEqual(mHits[0].conflict[0], mHits[0].record.id);
    const kHits = await c.knowledge.store.search(c.query, { limit: 5 });
    assert.equal(kHits.length, 2);
    for (const h of kHits) {
      assert.equal(h.record.status, 'conflicting');
      assert.equal(h.record.conflictsWith.length, 1);
    }
  });

  await t.test('superseded: knowledge excludes the retired claim, memory keeps it annotated', async () => {
    const c = byName.superseded;
    const kHits = await c.knowledge.store.search(c.query, { limit: 5 });
    assert.ok(kHits.some((h) => h.record.id === c.knowledge.relevant[0]), 'successor retrieved');
    assert.equal(kHits.some((h) => h.record.id === c.knowledge.retired[0]), false, 'superseded claim out of knowledge retrieval');
    const mHits = await c.memory.store.search(c.query, { limit: 5 });
    const old = mHits.find((h) => h.record.id === c.memory.retired[0]);
    assert.ok(old, 'memory keeps the superseded record retrievable');
    assert.equal(old.status, 'superseded');
    assert.deepEqual(old.replacedBy, [c.memory.relevant[0]]);
    assert.equal(mHits[0].record.id, c.memory.relevant[0], 'the correction ranks first');
  });

  await t.test('retracted: knowledge excludes the claim; memory has no retraction API', async () => {
    const c = byName.retracted;
    const kHits = await c.knowledge.store.search(c.query, { limit: 5 });
    assert.ok(kHits.some((h) => h.record.id === c.knowledge.relevant[0]), 'live claim retrieved');
    assert.equal(kHits.some((h) => h.record.id === c.knowledge.retired[0]), false, 'retracted claim out of retrieval');
    assert.equal(typeof c.memory.store.retract, 'undefined', 'memory store exposes no retraction API; the state is not faked');
  });

  await t.test('duplicates do not dominate the top-K', async () => {
    const c = byName.duplicate_near_duplicate;
    const mHits = await c.memory.store.search(c.query, { limit: 5 });
    const contents = mHits.map((h) => h.record.content);
    assert.equal(new Set(contents).size, contents.length, 'memory dedupes identical content');
    assert.ok(contents.includes('weekly report status green'));
    assert.ok(contents.includes('weekly report status amber'), 'a distinct relevant record is not pushed out by duplicates');
    const kHits = await c.knowledge.store.search(c.query, { limit: 5 });
    assert.equal(kHits.length, 3, 'knowledge keeps both copies');
    assert.equal(dedupeKnowledge(kHits.map((h) => h.record)).length, 2, 'the prompt layer collapses the duplicate triple');
  });
});

describe('AP-10 size stability and the measured precision trade-off', () => {
  const QUERY = 'tell me about the lighthouse project status';
  const triple = (subject, relationship, object) => ({ subject, relationship, object });
  const contentOf = (r) => `${r.subject} ${r.relationship} ${r.object}`;
  function newStore(kind, dir) {
    const file = path.join(dir, `${kind}.jsonl`);
    return kind === 'memory' ? new MemoryStore(file, { now: NOW }) : new KnowledgeStore(file, { now: NOW });
  }
  async function add(kind, store, r) {
    return kind === 'memory'
      ? store.add({ content: contentOf(r), kind: 'user_fact', source: 'user' })
      : store.add({ subject: r.subject, relationship: r.relationship, object: r.object, origin: 'user' });
  }
  const idOf = (kind, result) => (kind === 'memory' ? result.id : result.record.id);
  const kept = (kind, hits) => (kind === 'memory' ? selectPromptMemory(hits) : selectPromptKnowledge(hits));
  // memory keeps {record,...} hits, knowledge keeps bare records; normalize to ids.
  const keptIds = (kind, hits) => kept(kind, hits).map((x) => (x.record ?? x).id);

  test('a fixed query/record score is exactly invariant as the store grows (all terms observed)', async () => {
    for (const kind of ['memory', 'knowledge']) {
      const dir = tempDir();
      const store = newStore(kind, dir);
      const filler = (i) => triple('lighthouse project', 'status archive', `${i}`);
      const target = triple('lighthouse project', 'green', 'note');
      for (let i = 1; i <= 19; i += 1) await add(kind, store, filler(i));
      const targetId = idOf(kind, await add(kind, store, target));
      const at = async (size) => {
        const hits = await store.search('lighthouse project status', { limit: size });
        return hits.find((h) => h.record.id === targetId).score;
      };
      const s20 = await at(20);
      for (let i = 20; i <= 199; i += 1) await add(kind, store, filler(i));
      const s200 = await at(200);
      assert.equal(s20, 2 / 3, `${kind} target matches two of three ubiquitous terms`);
      assert.equal(s200, 2 / 3, `${kind} score unchanged at 200 records`);
      assert.equal(s20, s200, `${kind} adding unrelated records did not change the score`);
    }
  });

  test('an absent query term does not push a relevant record below the floor as the store grows', async () => {
    for (const kind of ['memory', 'knowledge']) {
      const dir = tempDir();
      const store = newStore(kind, dir);
      const filler = (i) => triple('lighthouse archive', 'status batch', `${i}`);
      const target = triple('lighthouse', 'status', 'green');
      for (let i = 1; i <= 19; i += 1) await add(kind, store, filler(i));
      const targetId = idOf(kind, await add(kind, store, target));
      // Score is limit-independent, but equal-score fillers added later win the index-desc tie-break
      // and push the target out of a small window, so retrieve the whole store to read its score.
      const at = async (size) => {
        const hits = await store.search(QUERY, { limit: size });
        const hit = hits.find((h) => h.record.id === targetId);
        assert.ok(hit, `${kind} target retrieved at ${size}`);
        return { score: hit.score, rank: hits.indexOf(hit) + 1, hits };
      };
      const a20 = await at(20);
      close(a20.score, 0.3485735730804195, `${kind} two-of-three at n=20`);
      assert.ok(a20.score >= FLOOR, `${kind} above the floor at 20`);
      assert.equal(a20.rank, 1);
      assert.ok(keptIds(kind, a20.hits).includes(targetId), `${kind} the relevant record is prompt-eligible at 20`);
      for (let i = 20; i <= 199; i += 1) await add(kind, store, filler(i));
      const a200 = await at(200);
      close(a200.score, 1 / 3, `${kind} two-of-three at n=200`);
      for (let i = 200; i <= 999; i += 1) await add(kind, store, filler(i));
      const a1000 = await at(1000);
      close(a1000.score, 1 / 3, `${kind} two-of-three at n=1000`);
      assert.ok(a1000.score >= FLOOR, `${kind} still above the floor at 1000 (the defect crossed it between 1000 and 4000)`);
      assert.equal(a200.score, a1000.score, `${kind} the capped absent-term weight is exactly stable from 200 to 1000`);
      assert.ok(keptIds(kind, a1000.hits).includes(targetId), `${kind} the relevant record stays prompt-eligible at 1000`);
    }
  });

  test('a one-of-three match stays below the floor: the precision trade-off is kept, not weakened', async () => {
    for (const kind of ['memory', 'knowledge']) {
      const dir = tempDir();
      const store = newStore(kind, dir);
      const filler = (i) => triple('weekly report', 'status', `${i}`);
      for (let i = 1; i <= 20; i += 1) await add(kind, store, filler(i));
      const hits20 = await store.search(QUERY, { limit: 5 });
      close(hits20[0].score, 0.11798937742639416, `${kind} one-of-three at n=20`);
      assert.ok(hits20[0].score < FLOOR, `${kind} below the floor at 20`);
      assert.equal(kept(kind, hits20).length, 0, `${kind} no weekly-report record is prompt-eligible at 20`);
      for (let i = 21; i <= 1000; i += 1) await add(kind, store, filler(i));
      const hits1000 = await store.search(QUERY, { limit: 5 });
      close(hits1000[0].score, 1 / 9, `${kind} one-of-three at n=1000`);
      assert.ok(hits1000[0].score < FLOOR, `${kind} below the floor at 1000`);
      assert.equal(kept(kind, hits1000).length, 0, `${kind} no weekly-report record is prompt-eligible at 1000`);
    }
  });

  test('the floor constants are the measured 0.2', () => {
    assert.equal(PROMPT_RELEVANCE_MIN, FLOOR);
    assert.equal(KNOWLEDGE_PROMPT_RELEVANCE_MIN, FLOOR);
  });
});