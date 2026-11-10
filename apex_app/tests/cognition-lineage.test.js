// Batch AO, work package D: evidence lineage and claim lifecycle.
//
// Every extracted claim keeps a bounded record of what it rested on. Re-reading a claim against a
// changed store produces a new assessment; the recorded one is never rewritten. Missing or unreadable
// evidence is unverified, not false, and a contradiction stays distinguishable from an absence of
// support. All fixtures are synthetic and deterministic; no model is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractClaims } from '../src/cognition/claims.js';
import { analyzeRequest, analysisAudit } from '../src/cognition/engine.js';
import {
  claimLineageSnapshot, reassessClaims, responseLineageSnapshot, validateLineageSnapshot,
} from '../src/cognition/lineage.js';
import { cognitionAudit } from '../src/cognition/protocol.js';
import { validateStructuredResponse } from '../src/cognition/response.js';
import {
  BOUNDS, ClaimKind, EvidenceState, EvidenceValidity, Intent,
} from '../src/cognition/vocabulary.js';

const NOW = new Date('2026-05-01T00:00:00.000Z');

function evidence(source, recordId, claim, extra = {}) {
  return {
    evidenceId: `ev:${source}:${recordId}`,
    source,
    recordId,
    type: extra.type ?? 'memory',
    subject: extra.subject ?? null,
    claim,
    observedAt: null,
    recordedAt: null,
    provenance: { origin: 'user', operationId: null, updateMode: null },
    status: extra.status ?? 'recorded',
    current: extra.current !== false,
    validity: extra.validity,
    retrievalReason: 'test-fixture',
    relationships: { supports: [], contradicts: extra.contradicts ?? [] },
    contradicts: extra.contradicts ?? [],
  };
}

function analysisOf(evidenceList, { conflicts = [] } = {}) {
  const byId = new Map(evidenceList.map((item) => [item.evidenceId, item]));
  return {
    understanding: { intent: Intent.STORED_INFORMATION },
    retrieval: {
      evidence: evidenceList, byId, conflicts, omitted: [],
      counts: { total: evidenceList.length, dropped: 0, unavailable: [], damaged: [] },
    },
    claims: extractClaims({ evidence: evidenceList, conflicts }),
    deliberation: {
      decision: 'answer',
      conclusion: { kind: 'supported' },
      uncertainty: null,
      disclosures: [],
      contradicting: [],
      missing: [],
      interpretations: [],
      assumptions: [],
      recommendation: null,
    },
  };
}

function responseWith(claim) {
  return {
    schema: 1,
    decision: 'answer',
    answer: 'A grounded answer.',
    claims: [claim],
  };
}

function record(source, recordId, extra = {}) {
  return {
    evidenceId: `ev:${source}:${recordId}`,
    source,
    recordId,
    type: extra.type ?? 'memory',
    claim: 'a record',
    current: extra.current !== false,
    validity: extra.validity,
    status: extra.status ?? 'recorded',
  };
}

function claimFor(claimSet, evidenceId) {
  return claimSet.claims.find((claim) => claim.evidenceIds.includes(evidenceId));
}

test('each extracted claim keeps a bounded lineage of the records it rested on', () => {
  const many = Array.from({ length: 12 }, (_, index) => `ev:knowledge:k-${index}`);
  const list = [
    evidence('memory', 'm-1', 'the audit is open'),
    evidence('knowledge', 'k-1', 'Atlas owner is Nadia', { type: 'knowledge', status: ClaimKind.SUPPORTED }),
    evidence('knowledge', 'k-2', 'Atlas owner is Bruno', {
      type: 'knowledge', status: ClaimKind.CONTRADICTED, contradicts: ['ev:knowledge:k-1'],
    }),
    evidence('knowledge', 'k-many', 'many links', {
      type: 'knowledge', status: ClaimKind.SUPPORTED, contradicts: many,
    }),
  ];
  const claims = extractClaims({ evidence: list });

  for (const claim of claims.claims) {
    assert.ok(claim.lineage, 'every claim carries a lineage');
    assert.ok(claim.lineage.supports.includes(claim.evidenceIds[0]));
    assert.ok(claim.lineage.supports.length <= BOUNDS.maxLineageRefs);
    assert.ok(claim.lineage.contradicts.length <= BOUNDS.maxLineageRefs);
  }
  const contradicted = claimFor(claims, 'ev:knowledge:k-2');
  assert.ok(contradicted.lineage.contradicts.includes('ev:knowledge:k-1'),
    'the evidence it opposes is kept in the lineage');
  assert.ok(contradicted.lineage.claimLinks.includes('cl:2'),
    'the contradictory claim it links to is kept as a claim link');
  assert.equal(contradicted.evidenceState, EvidenceState.CONFLICTING);

  const overflow = claimFor(claims, 'ev:knowledge:k-many');
  assert.equal(overflow.lineage.contradicts.length, BOUNDS.maxLineageRefs,
    'a lineage is bounded instead of growing with the record');

  const snapshot = claimLineageSnapshot(claims);
  assert.equal(snapshot.source, 'claim_set');
  assert.equal(snapshot.claimCount, claims.claims.length);
  assert.equal(snapshot.truncated, false);
  assert.equal(validateLineageSnapshot(snapshot).ok, true);
  assert.equal(JSON.stringify(snapshot).includes('the audit'), false,
    'a snapshot carries identifiers and states, not claim text');
  assert.equal(JSON.stringify(snapshot).includes('Atlas'), false);
});

test('re-evaluation follows each record transition without rewriting the recorded assessment', () => {
  const recorded = extractClaims({
    evidence: [
      evidence('memory', 'm-ok', 'the audit is open'),
      evidence('memory', 'm-retracted', 'the audit was closed'),
      evidence('memory', 'm-superseded', 'the audit owner is Nadia'),
      evidence('knowledge', 'k-contra', 'the audit owner is Bruno', { type: 'knowledge', status: ClaimKind.CONTRADICTED }),
      evidence('memory', 'm-stale', 'the audit was open last month'),
      evidence('memory', 'm-missing', 'the audit had no findings'),
      evidence('experience', 'e-unreadable', 'the audit completed', { type: 'experience' }),
      evidence('prediction', 'p-1', 'the deploy will succeed', { type: 'expectation', status: ClaimKind.EXPECTATION }),
      evidence('temporal', 't-1', 'failures cluster on Mondays', { type: 'temporal-pattern', status: ClaimKind.INFERENCE }),
    ],
  });
  const frozen = JSON.stringify(recorded);

  const laterById = new Map([
    ['ev:memory:m-ok', record('memory', 'm-ok')],
    ['ev:memory:m-retracted', record('memory', 'm-retracted', { validity: EvidenceValidity.RETRACTED, current: false })],
    ['ev:memory:m-superseded', record('memory', 'm-superseded', { validity: EvidenceValidity.SUPERSEDED, current: false })],
    ['ev:knowledge:k-contra', record('knowledge', 'k-contra', { type: 'knowledge', status: ClaimKind.CONTRADICTED })],
    ['ev:memory:m-stale', record('memory', 'm-stale', { validity: EvidenceValidity.HISTORICAL, current: false })],
    // ev:memory:m-missing is deliberately absent: the record cannot be read.
    ['ev:experience:e-unreadable', record('experience', 'e-unreadable', { type: 'experience' })],
    ['ev:prediction:p-1', record('prediction', 'p-1', { type: 'expectation' })],
    ['ev:temporal:t-1', record('temporal', 't-1', { type: 'temporal-pattern' })],
  ]);

  const result = reassessClaims(recorded, { evidenceById: laterById, unavailable: ['experience'] });
  const byClaim = new Map(result.claims.map((entry) => [entry.claimId, entry]));
  const stateOf = (evidenceId) => byClaim.get(claimFor(recorded, evidenceId).claimId);

  assert.equal(stateOf('ev:memory:m-ok').evidenceState, EvidenceState.DIRECTLY_SUPPORTED);
  assert.equal(stateOf('ev:memory:m-ok').changed, false);

  assert.equal(stateOf('ev:memory:m-retracted').previousState, EvidenceState.DIRECTLY_SUPPORTED);
  assert.equal(stateOf('ev:memory:m-retracted').evidenceState, EvidenceState.RETRACTED);
  assert.deepEqual(stateOf('ev:memory:m-retracted').reasons,
    [{ code: 'retracted', evidenceId: 'ev:memory:m-retracted', side: 'supporting' }]);

  assert.equal(stateOf('ev:memory:m-superseded').evidenceState, EvidenceState.SUPERSEDED);
  assert.equal(stateOf('ev:memory:m-stale').evidenceState, EvidenceState.TEMPORALLY_STALE);

  assert.equal(stateOf('ev:knowledge:k-contra').evidenceState, EvidenceState.CONFLICTING,
    'contradictory evidence stays distinct from no support');
  assert.equal(stateOf('ev:knowledge:k-contra').changed, false);

  const missing = stateOf('ev:memory:m-missing');
  assert.equal(missing.evidenceState, EvidenceState.UNVERIFIED,
    'a missing record makes the claim unverified, never unsupported');
  assert.notEqual(missing.evidenceState, EvidenceState.UNSUPPORTED);
  assert.deepEqual(missing.reasons,
    [{ code: 'missing', evidenceId: 'ev:memory:m-missing', side: 'supporting' }]);

  const unreadable = stateOf('ev:experience:e-unreadable');
  assert.equal(unreadable.evidenceState, EvidenceState.UNVERIFIED);
  assert.deepEqual(unreadable.reasons,
    [{ code: 'unreadable', evidenceId: 'ev:experience:e-unreadable', side: 'supporting' }]);

  assert.equal(stateOf('ev:prediction:p-1').evidenceState, EvidenceState.UNSUPPORTED,
    'a kind-derived state does not become supported merely because its record was read again');
  assert.equal(stateOf('ev:temporal:t-1').evidenceState, EvidenceState.UNVERIFIED);

  assert.deepEqual(result.counts, {
    total: 9,
    changed: 5,
    unchanged: 4,
    previouslySupported: 6,
    stillSupported: 1,
    weakened: 5,
    restored: 0,
    byState: {
      directly_supported: 1,
      conflicting: 1,
      unverified: 3,
      unsupported: 1,
      temporally_stale: 1,
      retracted: 1,
      superseded: 1,
    },
    reasons: { contradicted: 1, retracted: 1, superseded: 1, stale: 1, missing: 1, unreadable: 1 },
  });
  assert.equal(JSON.stringify(recorded), frozen, 'the recorded assessment is history, not a working copy');
});

test('a claim whose evidence becomes current again is restored, and absent evidence is not disproof', () => {
  const recorded = [{
    claimId: 'cl:1',
    kind: ClaimKind.SUPPORTED,
    evidenceState: EvidenceState.TEMPORALLY_STALE,
    lineage: { supports: ['ev:memory:m-1'], contradicts: [], claimLinks: [] },
  }];
  const restored = reassessClaims(recorded, {
    evidenceById: new Map([['ev:memory:m-1', record('memory', 'm-1')]]),
  });
  assert.equal(restored.claims[0].previousState, EvidenceState.TEMPORALLY_STALE);
  assert.equal(restored.claims[0].evidenceState, EvidenceState.DIRECTLY_SUPPORTED);
  assert.equal(restored.claims[0].changed, true);
  assert.equal(restored.counts.restored, 1);

  const absent = reassessClaims([{
    claimId: 'cl:2',
    kind: ClaimKind.SUPPORTED,
    evidenceState: EvidenceState.DIRECTLY_SUPPORTED,
    lineage: { supports: ['ev:memory:gone'], contradicts: [], claimLinks: [] },
  }], { evidenceById: new Map() });
  assert.equal(absent.claims[0].evidenceState, EvidenceState.UNVERIFIED);
  assert.notEqual(absent.claims[0].evidenceState, EvidenceState.UNSUPPORTED);
});

test('a supported reading becomes stale when its evidence changes, and the stored audit is unchanged', async () => {
  const analysis = await analyzeRequest({
    request: 'what do you remember about the audit?',
    requestId: 'op-lineage-stale',
    now: NOW,
    seeds: {
      memoryHits: [{ record: { id: 'm-1', content: 'the audit is open', createdAt: '2026-04-01T00:00:00.000Z' } }],
      knowledge: [],
    },
  });
  assert.equal(analysis.available, true);
  const recorded = analysisAudit(analysis);
  assert.equal(recorded.lineage.source, 'claim_set');
  assert.equal(validateLineageSnapshot(recorded.lineage).ok, true);

  const memoryClaim = recorded.lineage.claims.find((claim) => claim.evidenceIds.includes('ev:memory:m-1'));
  assert.ok(memoryClaim, 'the supported reading cites the record it rested on');
  assert.equal(memoryClaim.evidenceState, EvidenceState.DIRECTLY_SUPPORTED);
  const frozen = JSON.stringify(recorded.lineage);

  const laterById = new Map(analysis.retrieval.byId);
  laterById.set('ev:memory:m-1', {
    ...analysis.retrieval.byId.get('ev:memory:m-1'),
    current: false,
    validity: EvidenceValidity.HISTORICAL,
  });
  const later = reassessClaims(recorded.lineage, { evidenceById: laterById });
  const entry = later.claims.find((claim) => claim.claimId === memoryClaim.claimId);
  assert.equal(entry.previousState, EvidenceState.DIRECTLY_SUPPORTED);
  assert.equal(entry.evidenceState, EvidenceState.TEMPORALLY_STALE);
  assert.equal(entry.changed, true);
  assert.equal(later.counts.weakened, 1);

  assert.equal(JSON.stringify(recorded.lineage), frozen,
    're-reading a request never rewrites what the request recorded');
});

test('a model response cannot rest on a retracted or superseded record, and its lineage can be re-read', () => {
  const list = [
    evidence('memory', 'm-1', 'the audit is open'),
    evidence('knowledge', 'k-retracted', 'Atlas owner is Nadia', {
      type: 'knowledge', status: ClaimKind.SUPPORTED, validity: EvidenceValidity.RETRACTED, current: false,
    }),
    evidence('knowledge', 'k-superseded', 'Atlas revenue is 12', {
      type: 'knowledge', status: ClaimKind.SUPPORTED, validity: EvidenceValidity.SUPERSEDED, current: false,
    }),
  ];
  const analysis = analysisOf(list);

  const retracted = validateStructuredResponse(responseWith({
    text: 'Atlas owner is Nadia', evidence: ['ev:knowledge:k-retracted'], kind: 'supported',
  }), { analysis });
  assert.equal(retracted.ok, false);
  assert.ok(retracted.problems.some((problem) => /retracted and no longer stands/.test(problem)),
    retracted.problems.join('; '));

  const superseded = validateStructuredResponse(responseWith({
    text: 'Atlas revenue is 12', evidence: ['ev:knowledge:k-superseded'], kind: 'supported',
  }), { analysis });
  assert.equal(superseded.ok, false);
  assert.ok(superseded.problems.some((problem) => /later record replaced the cited one/.test(problem)),
    superseded.problems.join('; '));

  const accepted = validateStructuredResponse(responseWith({
    text: 'the audit is open', evidence: ['ev:memory:m-1'], kind: 'supported',
  }), { analysis });
  assert.equal(accepted.ok, true, accepted.problems.join('; '));
  const audit = cognitionAudit(accepted.value, accepted);
  assert.equal(audit.lineage.source, 'model_response');
  assert.equal(validateLineageSnapshot(audit.lineage).ok, true);
  assert.equal(JSON.stringify(audit.lineage).includes('the audit is open'), false,
    'the response lineage carries citations, not the answer text');

  const laterById = new Map(analysis.retrieval.byId);
  laterById.set('ev:memory:m-1', {
    ...analysis.retrieval.byId.get('ev:memory:m-1'),
    validity: EvidenceValidity.RETRACTED,
    current: false,
  });
  const citedIndex = audit.lineage.claims.findIndex((claim) => claim.evidenceIds.includes('ev:memory:m-1'));
  assert.ok(citedIndex >= 0);
  const later = reassessClaims(audit.lineage, { evidenceById: laterById });
  const entry = later.claims[citedIndex];
  assert.ok(entry);
  assert.equal(entry.previousState, EvidenceState.DIRECTLY_SUPPORTED);
  assert.equal(entry.evidenceState, EvidenceState.RETRACTED);
  assert.equal(entry.changed, true);
  assert.equal(later.counts.weakened, 1);
});

test('a lineage snapshot is validated at the boundary where it is read', () => {
  const snapshot = claimLineageSnapshot([{
    claimId: 'cl:1',
    kind: ClaimKind.SUPPORTED,
    evidenceState: EvidenceState.DIRECTLY_SUPPORTED,
    lineage: { supports: ['ev:memory:m-1'], contradicts: [], claimLinks: [] },
  }]);
  assert.equal(validateLineageSnapshot(snapshot).ok, true);

  const wrongSchema = validateLineageSnapshot({ ...snapshot, schema: 2 });
  assert.equal(wrongSchema.ok, false);
  assert.ok(wrongSchema.problems.some((problem) => /schema must be 1/.test(problem)));

  const wrongSource = validateLineageSnapshot({ ...snapshot, source: 'elsewhere' });
  assert.equal(wrongSource.ok, false);
  assert.ok(wrongSource.problems.some((problem) => /source must be claim_set or model_response/.test(problem)));

  const badRef = validateLineageSnapshot({
    ...snapshot,
    claims: [{ ...snapshot.claims[0], evidenceIds: ['not-an-evidence-id'] }],
  });
  assert.equal(badRef.ok, false);

  const modelSnapshot = responseLineageSnapshot({
    claims: [{ text: 'x', kind: 'general_knowledge', evidenceIds: [], evidenceState: 'unsupported' }],
  });
  assert.equal(validateLineageSnapshot(modelSnapshot).ok, true);
  assert.equal(modelSnapshot.source, 'model_response');
});
