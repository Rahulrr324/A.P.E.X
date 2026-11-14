// Deterministic retrieval-quality evaluation. Pure metric functions plus a synthetic fixture
// corpus built through the real stores. Every metric is reported separately and says when it is
// not computable (null + reason) rather than inventing a 0 or 1. Nothing here combines precision,
// recall, latency, or citation counts into one overall score: they measure different things and a
// single number would hide which one moved. The scores the stores produce are lexical coverage
// ratios, not probabilities and not semantic understanding; the fixtures label relevance by hand
// and measure how often lexical retrieval agrees with those labels.
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { MemoryStore } from '../memory/memory-store.js';
import { KnowledgeStore } from '../knowledge/knowledge-store.js';
import { MAX_QUERY_TOKENS } from './normalize.js';

const empty = (ids) => (Array.isArray(ids) ? ids : []);

export function precisionAtK(retrievedIds, relevantIds, k) {
  if (!Number.isInteger(k) || k <= 0) return { value: null, reason: 'k must be a positive integer', k };
  const retrieved = empty(retrievedIds);
  if (retrieved.length === 0) return { value: null, reason: 'nothing was retrieved', k };
  const top = retrieved.slice(0, k);
  const relevant = new Set(empty(relevantIds));
  const hits = top.filter((id) => relevant.has(id)).length;
  return { value: hits / top.length, reason: null, k, considered: top.length, relevantHits: hits };
}

// Recall needs a relevant set to divide by. A query with no known-relevant record has no recall,
// which is different from a recall of 0 (relevant records exist but none were retrieved).
export function recallAtK(retrievedIds, relevantIds, k) {
  const relevant = empty(relevantIds);
  if (relevant.length === 0) return { value: null, reason: 'relevant set is empty; recall has no denominator', k };
  if (!Number.isInteger(k) || k <= 0) return { value: null, reason: 'k must be a positive integer', k };
  const top = empty(retrievedIds).slice(0, k);
  const relevantSet = new Set(relevant);
  const hits = top.filter((id) => relevantSet.has(id)).length;
  return { value: hits / relevant.length, reason: null, k, considered: top.length, relevantHits: hits, relevantTotal: relevant.length };
}

export function reciprocalRank(retrievedIds, relevantIds) {
  const relevant = empty(relevantIds);
  if (relevant.length === 0) return { value: null, reason: 'relevant set is empty', rank: null };
  const relevantSet = new Set(relevant);
  const index = empty(retrievedIds).findIndex((id) => relevantSet.has(id));
  return { value: index === -1 ? 0 : 1 / (index + 1), reason: null, rank: index === -1 ? null : index + 1 };
}

// Coverage over the whole retrieved list, before any K cut: did the known-relevant records surface
// at all, regardless of rank.
export function relevantCoverage(retrievedIds, relevantIds) {
  const relevant = empty(relevantIds);
  if (relevant.length === 0) return { value: null, reason: 'relevant set is empty', retrievedRelevant: null, relevantTotal: 0 };
  const retrieved = new Set(empty(retrievedIds));
  const hits = relevant.filter((id) => retrieved.has(id)).length;
  return { value: hits / relevant.length, reason: null, retrievedRelevant: hits, relevantTotal: relevant.length };
}

// A retrieved record in neither labelled set is unlabelled, not irrelevant: counting it as
// irrelevant would punish retrieval for records the fixture never judged.
export function irrelevantInclusion(retrievedIds, relevantIds, irrelevantIds) {
  const retrieved = empty(retrievedIds);
  const relevant = new Set(empty(relevantIds));
  const irrelevant = new Set(empty(irrelevantIds));
  const count = retrieved.filter((id) => irrelevant.has(id)).length;
  const unlabelled = retrieved.filter((id) => !relevant.has(id) && !irrelevant.has(id)).length;
  if (retrieved.length === 0) return { count: 0, fraction: null, unlabelled: 0, retrieved: 0, reason: 'nothing was retrieved' };
  return { count, fraction: count / retrieved.length, unlabelled, retrieved: retrieved.length, reason: null };
}

// "Retrieved" is not "should be cited". Without a relevant set the uncited-relevant count is not
// computable, and saying so is the honest answer rather than treating every retrieved record as a
// citation obligation.
export function citationCoverage(claims, retrievedIds, relevantIds = null) {
  const retrieved = new Set(empty(retrievedIds));
  const cited = new Set();
  const perClaim = empty(claims).map((claim) => {
    const ids = empty(claim?.citedRecordIds);
    const resolvedIds = ids.filter((id) => retrieved.has(id));
    const danglingIds = ids.filter((id) => !retrieved.has(id));
    for (const id of ids) cited.add(id);
    return {
      claimId: claim?.claimId ?? null,
      cited: ids.length,
      resolved: resolvedIds.length,
      dangling: danglingIds.length,
      resolvedIds,
      danglingIds,
    };
  });
  const totalCitations = perClaim.reduce((sum, c) => sum + c.cited, 0);
  const resolved = perClaim.reduce((sum, c) => sum + c.resolved, 0);
  const dangling = perClaim.reduce((sum, c) => sum + c.dangling, 0);
  let uncitedRelevantIds = null;
  let reason = null;
  if (relevantIds === null || relevantIds === undefined) {
    reason = 'relevant set not provided; retrieved records are not treated as should-be-cited';
  } else {
    uncitedRelevantIds = empty(relevantIds).filter((id) => retrieved.has(id) && !cited.has(id));
  }
  return {
    claims: perClaim,
    overall: {
      totalCitations,
      resolved,
      dangling,
      uncitedRelevant: uncitedRelevantIds === null ? null : uncitedRelevantIds.length,
      uncitedRelevantIds,
      reason,
    },
  };
}

export function latencyStats(samples) {
  const numbers = empty(samples).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (numbers.length === 0) return { median: null, min: null, max: null, count: 0, reason: 'no finite latency samples' };
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { median, min: sorted[0], max: sorted[sorted.length - 1], count: sorted.length, reason: null };
}

export function truncationCounts({ matched, returned, limit, droppedTokens } = {}) {
  if (!Number.isInteger(matched) || !Number.isInteger(returned)) {
    return { resultsCut: null, tokensDropped: null, reason: 'matched and returned must be integers' };
  }
  return {
    resultsCut: Math.max(0, matched - returned),
    tokensDropped: Number.isInteger(droppedTokens) ? Math.max(0, droppedTokens) : 0,
    matched,
    returned,
    limit: Number.isInteger(limit) ? limit : null,
    reason: null,
  };
}

// Runs one labelled case against a real store and returns every metric as its own named field.
// There is deliberately no aggregate accuracy/score field.
export async function evaluateRetrieval({
  store,
  query,
  relevantIds = [],
  irrelevantIds = [],
  k = 5,
  limit = 5,
  claims = [],
  latencySamples = null,
} = {}) {
  if (!store || typeof store.search !== 'function') throw new Error('evaluateRetrieval requires a store with a search method');
  const diagnostics = {};
  const started = performance.now();
  const hits = await store.search(query, { limit, diagnostics });
  const elapsedMs = performance.now() - started;
  const retrievedIds = hits.map((hit) => hit.record.id);
  const scores = Object.fromEntries(hits.map((hit) => [hit.record.id, hit.score]));
  const samples = Array.isArray(latencySamples) ? latencySamples : [elapsedMs];
  return {
    query,
    k,
    limit,
    retrievedIds,
    scores,
    hits,
    diagnostics,
    elapsedMs,
    precisionAtK: precisionAtK(retrievedIds, relevantIds, k),
    recallAtK: recallAtK(retrievedIds, relevantIds, k),
    reciprocalRank: reciprocalRank(retrievedIds, relevantIds),
    relevantCoverage: relevantCoverage(retrievedIds, relevantIds),
    irrelevantInclusion: irrelevantInclusion(retrievedIds, relevantIds, irrelevantIds),
    citationCoverage: citationCoverage(claims, retrievedIds, relevantIds),
    latencyStats: latencyStats(samples),
    truncationCounts: truncationCounts(diagnostics),
  };
}

const IRR = { subject: 'banana bread', relationship: 'recipe', object: 'guide' };
const contentOf = (r) => `${r.subject} ${r.relationship} ${r.object}`;

// Each fixture class lives in its own pair of stores so one class's records cannot shift another
// class's IDF or ranking. Relevance is labelled by hand; the stores are real and unmocked.
export async function buildSyntheticCorpus({ dir, now = () => new Date('2026-06-01T00:00:00.000Z') } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) throw new Error('buildSyntheticCorpus requires a directory');
  const cases = [];

  function stores(name) {
    return {
      memory: new MemoryStore(path.join(dir, `memory-${name}.jsonl`), { now }),
      knowledge: new KnowledgeStore(path.join(dir, `knowledge-${name}.jsonl`), { now }),
    };
  }

  function blank() {
    return { relevant: [], irrelevant: [], neutral: [], retired: [], notes: [] };
  }

  async function simpleCase(name, query, records, extra = {}) {
    const { memory, knowledge } = stores(name);
    const m = { store: memory, ...blank() };
    const k = { store: knowledge, ...blank() };
    for (const record of records) {
      const role = record.role ?? 'neutral';
      const mr = await memory.add({ content: contentOf(record), kind: 'user_fact', source: 'user' });
      const kr = await knowledge.add({ subject: record.subject, relationship: record.relationship, object: record.object, origin: 'user' });
      m[role].push(mr.id);
      k[role].push(kr.record.id);
    }
    const built = { name, query, memory: m, knowledge: k, ...extra };
    cases.push(built);
    return built;
  }

  const rel = (subject, relationship, object) => ({ subject, relationship, object, role: 'relevant' });
  const irr = (subject, relationship, object) => ({ subject, relationship, object, role: 'irrelevant' });
  const neu = (subject, relationship, object) => ({ subject, relationship, object, role: 'neutral' });

  await simpleCase('exact_match', 'lighthouse project status', [
    rel('lighthouse project', 'status', 'green'), irr(IRR.subject, IRR.relationship, IRR.object),
  ]);

  await simpleCase('partial_match', 'lighthouse project status', [
    rel('lighthouse', 'status', 'green'), irr(IRR.subject, IRR.relationship, IRR.object),
  ]);

  await simpleCase('synonym_lexical', 'automobile service', [
    rel('automobile', 'service', 'manual'), neu('car', 'service', 'manual'), irr('bicycle', 'repair', 'guide'),
  ], { note: 'lexical overlap only; the synonym car is not expanded to automobile' });

  await simpleCase('word_order_varied', 'status project lighthouse', [
    rel('lighthouse project', 'status', 'green'), irr(IRR.subject, IRR.relationship, IRR.object),
  ]);

  await simpleCase('short_query', 'lighthouse', [
    rel('lighthouse project', 'status', 'green'), irr(IRR.subject, IRR.relationship, IRR.object),
  ]);

  // The bound is a guard, not a routine truncation, so the query must actually exceed it to exercise
  // the dropped-token disclosure. The informative terms lead, so the kept prefix still matches.
  const longFiller = Array.from({ length: MAX_QUERY_TOKENS + 10 }, (_, i) => `fillerword${i}`).join(' ');
  await simpleCase('long_query', `lighthouse project status ${longFiller}`, [
    rel('lighthouse project', 'status', 'green'), irr(IRR.subject, IRR.relationship, IRR.object),
  ], { note: 'query exceeds MAX_QUERY_TOKENS; the token bound drops the trailing distinct tokens' });

  await simpleCase('common_term', 'report', [
    rel('weekly report', 'status', 'green'),
    neu('weekly report', 'archive', '1'), neu('weekly report', 'archive', '2'), neu('weekly report', 'archive', '3'),
    irr(IRR.subject, IRR.relationship, IRR.object),
  ]);

  await simpleCase('rare_term', 'zylophrantic', [
    rel('zylophrantic', 'calibration', 'note'), irr('weekly report', 'status', 'green'),
  ]);

  await simpleCase('numbers', '10', [
    rel('supply item', 'count', '10'), irr('supply item', 'count', '100'),
  ], { note: '10 must not retrieve 100' });

  await simpleCase('dates', '2026-06-01', [
    rel('meeting', 'on', '2026-06-01'), neu('meeting', 'on', '2026-01-06'), irr(IRR.subject, IRR.relationship, IRR.object),
  ], { note: 'the whole date token distinguishes the reordered date; shared numeric parts still partially match' });

  await simpleCase('entity_names', 'maria gonzalez', [
    rel('maria gonzalez', 'leads', 'team'), neu('maria gonzales', 'leads', 'team'), irr(IRR.subject, IRR.relationship, IRR.object),
  ], { note: 'two similar but distinct names; memory fuzzy matching may still surface the near name' });

  await simpleCase('related_but_irrelevant', 'lighthouse project status', [
    rel('lighthouse project', 'status', 'green'), irr('lighthouse museum', 'opening', 'hours'),
  ], { irrelevantRetrievedByDesign: true, note: 'shares lighthouse lexically; retrieval includes it, measuring the precision trade-off' });

  await simpleCase('misleading_lexical_overlap', 'apple fruit nutrition', [
    rel('apple fruit', 'nutrition', 'facts'), irr('apple computer', 'stock', 'price'),
  ], { irrelevantRetrievedByDesign: true, note: 'shares apple lexically but is about a different subject' });

  // Contradictory: both claims must stay retrievable and marked, never silently merged.
  {
    const { memory, knowledge } = stores('contradictory');
    const m = { store: memory, ...blank() };
    const k = { store: knowledge, ...blank() };
    const mA = await memory.add({ content: 'the project codename is Lighthouse', kind: 'user_fact', source: 'user' });
    const mB = await memory.add({ content: 'the project codename is Bluebird', kind: 'user_fact', source: 'user' });
    const mI = await memory.add({ content: contentOf(IRR), kind: 'user_fact', source: 'user' });
    m.relevant.push(mA.id, mB.id); m.irrelevant.push(mI.id);
    const kA = await knowledge.add({ subject: 'the project codename', relationship: 'is', object: 'Lighthouse', origin: 'user' });
    const kB = await knowledge.add({ subject: 'the project codename', relationship: 'is', object: 'Bluebird', origin: 'user' });
    const kI = await knowledge.add({ subject: IRR.subject, relationship: IRR.relationship, object: IRR.object, origin: 'user' });
    k.relevant.push(kA.record.id, kB.record.id); k.irrelevant.push(kI.record.id);
    cases.push({ name: 'contradictory', query: 'project codename', memory: m, knowledge: k });
  }

  // Superseded: knowledge retires the old claim out of retrieval; memory keeps it retrievable but
  // annotated superseded. Both are produced through the public lifecycle APIs.
  {
    const { memory, knowledge } = stores('superseded');
    const m = { store: memory, ...blank() };
    const k = { store: knowledge, ...blank() };
    const mOld = await memory.add({ content: 'the engine fuel is coal', kind: 'user_fact', source: 'user' });
    const mI = await memory.add({ content: contentOf(IRR), kind: 'user_fact', source: 'user' });
    const mNew = await memory.correct({ targetId: mOld.id, content: 'the engine fuel is electric', origin: 'user' });
    m.relevant.push(mNew.id); m.retired.push(mOld.id); m.irrelevant.push(mI.id);
    m.notes.push('memory keeps the superseded record retrievable with status superseded');
    const kOld = await knowledge.add({ subject: 'engine', relationship: 'fuel', object: 'coal', origin: 'user' });
    const kI = await knowledge.add({ subject: IRR.subject, relationship: IRR.relationship, object: IRR.object, origin: 'user' });
    const kNew = await knowledge.add({ subject: 'engine', relationship: 'fuel', object: 'electric', origin: 'user', supersedes: [kOld.record.id] });
    k.relevant.push(kNew.record.id); k.retired.push(kOld.record.id); k.irrelevant.push(kI.record.id);
    k.notes.push('knowledge excludes the superseded claim from retrieval');
    cases.push({ name: 'superseded', query: 'engine fuel', memory: m, knowledge: k });
  }

  // Retracted: only knowledge has a retraction API. Memory has no retract path, so the retracted
  // state is not producible there and is not faked; the memory side holds only the live record.
  {
    const { memory, knowledge } = stores('retracted');
    const m = { store: memory, ...blank() };
    const k = { store: knowledge, ...blank() };
    const mLive = await memory.add({ content: 'sensor reading 43', kind: 'user_fact', source: 'user' });
    const mI = await memory.add({ content: contentOf(IRR), kind: 'user_fact', source: 'user' });
    m.relevant.push(mLive.id); m.irrelevant.push(mI.id);
    m.notes.push('memory store has no retraction API; a retracted memory record cannot be produced through the public API');
    const kLive = await knowledge.add({ subject: 'sensor', relationship: 'reading', object: '43', origin: 'user' });
    const kRet = await knowledge.add({ subject: 'sensor', relationship: 'reading', object: '42', origin: 'user' });
    const kI = await knowledge.add({ subject: IRR.subject, relationship: IRR.relationship, object: IRR.object, origin: 'user' });
    await knowledge.retract({ target: kRet.record.id, reason: 'sensor was recalibrated', origin: 'user' });
    k.relevant.push(kLive.record.id); k.retired.push(kRet.record.id); k.irrelevant.push(kI.record.id);
    cases.push({ name: 'retracted', query: 'sensor reading', memory: m, knowledge: k });
  }

  // Duplicate / near-duplicate: memory dedupes identical content; knowledge keeps both and the
  // prompt layer dedupes by triple. Duplicates must not dominate the top-K.
  {
    const { memory, knowledge } = stores('duplicate');
    const m = { store: memory, ...blank() };
    const k = { store: knowledge, ...blank() };
    const mA = await memory.add({ content: 'weekly report status green', kind: 'user_fact', source: 'user' });
    const mAc = await memory.add({ content: 'weekly report status green', kind: 'user_fact', source: 'user' });
    const mB = await memory.add({ content: 'weekly report status amber', kind: 'user_fact', source: 'user' });
    const mI = await memory.add({ content: contentOf(IRR), kind: 'user_fact', source: 'user' });
    m.relevant.push(mA.id, mAc.id, mB.id); m.irrelevant.push(mI.id);
    const kA = await knowledge.add({ subject: 'weekly report', relationship: 'status', object: 'green', origin: 'user' });
    const kAc = await knowledge.add({ subject: 'weekly report', relationship: 'status', object: 'green', origin: 'user' });
    const kB = await knowledge.add({ subject: 'weekly report', relationship: 'status', object: 'amber', origin: 'user' });
    const kI = await knowledge.add({ subject: IRR.subject, relationship: IRR.relationship, object: IRR.object, origin: 'user' });
    k.relevant.push(kA.record.id, kAc.record.id, kB.record.id); k.irrelevant.push(kI.record.id);
    cases.push({ name: 'duplicate_near_duplicate', query: 'weekly report status', memory: m, knowledge: k });
  }

  return { cases };
}