// Batch AO: typed cognitive artifacts.
//
// These tests pin the artifact contracts themselves: the deterministic stage outputs, the model's
// grounded response, the typed action proposal, and the executive handoff. Every fixture is local and
// deterministic; no model is contacted. The point of each rejection case is that a malformed or
// self-contradictory artifact is refused whole rather than read field by field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRequest, analysisAudit } from '../src/cognition/engine.js';
import { understandRequest } from '../src/cognition/request.js';
import { retrieveEvidence } from '../src/cognition/evidence.js';
import { parseModelOutput } from '../src/controller/proposals.js';
import {
  ARTIFACT_SCHEMA, ArtifactKind, ArtifactOwner, assertArtifact, validateAnalysisArtifacts, validateArtifact,
} from '../src/cognition/artifacts.js';
import { BOUNDS, ClaimKind } from '../src/cognition/vocabulary.js';

const NOW = new Date('2026-05-01T00:00:00.000Z');
const REQUEST = 'what do you remember about the harbour depth';

function memoryHit(id, content) {
  return { record: { id, content, createdAt: '2026-04-01T00:00:00.000Z' } };
}

async function realAnalysis() {
  return analyzeRequest({
    request: REQUEST,
    now: NOW,
    seeds: { memoryHits: [memoryHit('m-1', 'the harbour depth is four metres')] },
  });
}

function clone(value) {
  // Maps and arrays survive a structured clone; this is test-only tampering, not a production path.
  return structuredClone(value);
}

function claimFixture(index, overrides = {}) {
  return {
    claimId: `cl:${index + 1}`,
    text: `claim ${index + 1}`,
    kind: ClaimKind.SUPPORTED,
    evidenceIds: ['ev:memory:m-1'],
    source: 'memory',
    type: 'memory',
    subject: null,
    current: true,
    material: true,
    retrievalReason: 'test-fixture',
    note: null,
    contradicts: [],
    duplicateOf: [],
    groupId: null,
    subjectKey: 'memory:m-1',
    evidenceState: 'directly_supported',
    ...overrides,
  };
}

function claimSetFixture(claims) {
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  const forEvidence = new Map();
  for (const claim of claims) {
    for (const id of claim.evidenceIds) {
      const list = forEvidence.get(id) ?? [];
      list.push(claim.claimId);
      forEvidence.set(id, list);
    }
  }
  return {
    claims,
    byId,
    forEvidence,
    counts: { total: claims.length, material: claims.length },
  };
}

test('a real request produces every deterministic artifact under a valid contract', async () => {
  const analysis = await realAnalysis();
  assert.equal(analysis.available, true);
  assert.equal(analysis.artifacts.ok, true, JSON.stringify(analysis.artifacts.problems));
  assert.equal(analysis.artifacts.schema, ARTIFACT_SCHEMA);

  const kinds = analysis.artifacts.artifacts.map((entry) => entry.kind);
  assert.deepEqual(kinds, [
    ArtifactKind.REQUEST_INTERPRETATION,
    ArtifactKind.RETRIEVED_EVIDENCE,
    ArtifactKind.EXTRACTED_CLAIMS,
    ArtifactKind.DELIBERATION_RESULT,
    ArtifactKind.CLARIFICATION_REQUEST,
    ArtifactKind.CLAIM_ASSESSMENT,
  ]);
  for (const entry of analysis.artifacts.artifacts) {
    assert.equal(entry.owner, ArtifactOwner.COGNITIVE);
    assert.equal(entry.ok, true);
  }
  assert.equal(analysis.artifacts.artifacts[1].count, analysis.retrieval.evidence.length);
  assert.equal(analysis.artifacts.artifacts[2].count, analysis.claims.claims.length);

  const audit = analysisAudit(analysis);
  assert.equal(audit.artifacts.ok, true);
  assert.equal(audit.artifacts.entries.length, 6);
  assert.equal(audit.artifacts.problemCount, 0);
});

test('validation reads an artifact in place and returns no copied value', async () => {
  const analysis = await realAnalysis();
  const before = analysis.retrieval.evidence.map((item) => item.evidenceId);
  const result = validateArtifact(ArtifactKind.RETRIEVED_EVIDENCE, analysis.retrieval);
  assert.equal(result.ok, true);
  assert.equal(result.authorizes, false);
  assert.equal('value' in result, false, 'a valid artifact is not copied across the boundary');
  assert.deepEqual(analysis.retrieval.evidence.map((item) => item.evidenceId), before);
  assert.equal(validateArtifact(ArtifactKind.RETRIEVED_EVIDENCE, analysis.retrieval).ok, true);
});

test('an interpretation that grants authority is rejected, and a valid one is accepted', async () => {
  const understanding = understandRequest({ request: REQUEST, now: NOW });
  assert.equal(validateArtifact(ArtifactKind.REQUEST_INTERPRETATION, understanding).ok, true);

  const granting = { ...understanding, authorization: { granted: true } };
  const rejected = validateArtifact(ArtifactKind.REQUEST_INTERPRETATION, granting);
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join(' '), /authorization\.granted must be false/);

  const unknownMissing = { ...understanding, missing: [{ code: 'not_a_code' }] };
  assert.equal(validateArtifact(ArtifactKind.REQUEST_INTERPRETATION, unknownMissing).ok, false);

  const executing = { ...understanding, executionRequested: 'yes' };
  assert.equal(validateArtifact(ArtifactKind.REQUEST_INTERPRETATION, executing).ok, false);
});

test('retrieved evidence must index what it claims and never report an unreadable source as read', async () => {
  const understanding = understandRequest({ request: REQUEST, now: NOW });
  const retrieval = await retrieveEvidence({
    request: REQUEST,
    understanding,
    now: NOW,
    seeds: { memoryHits: [memoryHit('m-1', 'the harbour depth is four metres')] },
  });
  assert.equal(validateArtifact(ArtifactKind.RETRIEVED_EVIDENCE, retrieval).ok, true);

  const wrongCount = clone(retrieval);
  wrongCount.counts.total += 1;
  assert.match(
    validateArtifact(ArtifactKind.RETRIEVED_EVIDENCE, wrongCount).problems.join(' '),
    /counts\.total must equal/,
  );

  const duplicated = clone(retrieval);
  duplicated.evidence = [...duplicated.evidence, { ...duplicated.evidence[0] }];
  assert.equal(validateArtifact(ArtifactKind.RETRIEVED_EVIDENCE, duplicated).ok, false, 'a duplicated id must not be counted twice');

  const unavailable = clone(retrieval);
  unavailable.counts.unavailable = ['memory'];
  assert.match(
    validateArtifact(ArtifactKind.RETRIEVED_EVIDENCE, unavailable).problems.join(' '),
    /reported unavailable but supplied a record/,
  );

  const noIndex = clone(retrieval);
  noIndex.byId = new Map();
  assert.match(validateArtifact(ArtifactKind.RETRIEVED_EVIDENCE, noIndex).problems.join(' '), /byId must index/);
});

test('an evidence reference is a fixed grammar, not any string that looks like an id', () => {
  assert.equal(validateArtifact(ArtifactKind.EVIDENCE_REFERENCE, 'ev:memory:m-1').ok, true);
  for (const bad of ['memory:m-1', 'ev:not_a_source:m-1', 'ev:memory:', 'ev:memory:m-1\n']) {
    const result = validateArtifact(ArtifactKind.EVIDENCE_REFERENCE, bad);
    assert.equal(result.ok, false, bad);
  }
});

test('a material claim with no evidence is a contradiction, not a weaker claim', () => {
  const valid = claimSetFixture([claimFixture(0)]);
  assert.equal(validateArtifact(ArtifactKind.EXTRACTED_CLAIMS, valid).ok, true);

  const unsupported = claimSetFixture([claimFixture(0, { evidenceIds: [], material: true })]);
  const rejected = validateArtifact(ArtifactKind.EXTRACTED_CLAIMS, unsupported);
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join(' '), /material but cites no evidence/);

  const tooMany = claimSetFixture(Array.from({ length: BOUNDS.maxClaims + 1 }, (_, index) => claimFixture(index)));
  assert.match(
    validateArtifact(ArtifactKind.EXTRACTED_CLAIMS, tooMany).problems.join(' '),
    /must hold at most/,
  );

  const unindexed = { ...valid, byId: new Map() };
  assert.match(validateArtifact(ArtifactKind.EXTRACTED_CLAIMS, unindexed).problems.join(' '), /byId must index/);
});

test('a claim assessment carries a known state and kind', () => {
  assert.equal(validateArtifact(ArtifactKind.CLAIM_ASSESSMENT, claimFixture(0)).ok, true);
  assert.equal(
    validateArtifact(ArtifactKind.CLAIM_ASSESSMENT, claimFixture(0, { evidenceState: 'mostly_true' })).ok,
    false,
  );
  assert.equal(
    validateArtifact(ArtifactKind.CLAIM_ASSESSMENT, claimFixture(0, { kind: 'certain' })).ok,
    false,
  );
});

test('deliberation cannot require clarification while deciding to answer, or mark advice executed', async () => {
  const analysis = await realAnalysis();
  const real = analysis.deliberation;
  assert.equal(validateArtifact(ArtifactKind.DELIBERATION_RESULT, real, {
    claimIds: analysis.claims.claims.map((claim) => claim.claimId),
  }).ok, true);

  const contradiction = clone(real);
  contradiction.clarification = { needed: true, question: 'Which one?', missing: 'ambiguous_reference', reason: 'two records' };
  contradiction.decision = 'answer';
  assert.match(
    validateArtifact(ArtifactKind.DELIBERATION_RESULT, contradiction).problems.join(' '),
    /decision is not clarify/,
  );

  const executed = clone(real);
  executed.recommendation = {
    kind: 'next-step', text: 'run it', command: null, claimIds: [], evidenceIds: [],
    requiresAuthorization: true, executed: true,
  };
  assert.match(
    validateArtifact(ArtifactKind.DELIBERATION_RESULT, executed).problems.join(' '),
    /never be marked executed/,
  );

  const unknownClaim = clone(real);
  unknownClaim.conclusion = { ...unknownClaim.conclusion, claimIds: ['cl:99'] };
  assert.match(
    validateArtifact(ArtifactKind.DELIBERATION_RESULT, unknownClaim, { claimIds: ['cl:1'] }).problems.join(' '),
    /claim that was not extracted/,
  );
});

test('a clarification request states exactly one of two consistent conditions', () => {
  assert.equal(validateArtifact(ArtifactKind.CLARIFICATION_REQUEST, {
    needed: true, question: 'Which record?', missing: 'ambiguous_reference', reason: 'two records',
  }).ok, true);
  assert.equal(validateArtifact(ArtifactKind.CLARIFICATION_REQUEST, {
    needed: false, question: null, missing: null, reason: null,
  }).ok, true);

  assert.equal(validateArtifact(ArtifactKind.CLARIFICATION_REQUEST, {
    needed: true, question: null, missing: 'ambiguous_reference', reason: 'two records',
  }).ok, false);
  assert.equal(validateArtifact(ArtifactKind.CLARIFICATION_REQUEST, {
    needed: false, question: 'Which record?', missing: null, reason: null,
  }).ok, false);
  assert.equal(validateArtifact(ArtifactKind.CLARIFICATION_REQUEST, {
    needed: true, question: 'Which record?', missing: null, reason: 'two records',
  }).ok, false);
});

test('a grounded response may not escape its claim vocabulary or mark advice executed', async () => {
  const analysis = await realAnalysis();
  const evidenceId = analysis.retrieval.evidence.find((item) => item.source === 'memory').evidenceId;
  const valid = {
    schema: 1,
    decision: 'answer',
    answer: 'The note records that the harbour depth is four metres.',
    claims: [{
      text: 'the harbour depth is four metres', kind: 'supported', evidenceIds: [evidenceId], evidenceState: 'directly_supported',
    }],
    uncertainty: 'supported_but_incomplete',
    disclosures: ['model_output_unverified'],
    missing: [],
    recommendation: null,
  };
  assert.equal(validateArtifact(ArtifactKind.GROUNDED_RESPONSE, valid).ok, true);

  const forbiddenKind = clone(valid);
  forbiddenKind.claims[0].kind = 'fact';
  assert.equal(validateArtifact(ArtifactKind.GROUNDED_RESPONSE, forbiddenKind).ok, false);

  const badRef = clone(valid);
  badRef.claims[0].evidenceIds = ['not-an-id'];
  assert.equal(validateArtifact(ArtifactKind.GROUNDED_RESPONSE, badRef).ok, false);

  const executed = clone(valid);
  executed.recommendation = { text: 'run it', command: null, executed: true };
  assert.match(
    validateArtifact(ArtifactKind.GROUNDED_RESPONSE, executed).problems.join(' '),
    /never be marked executed/,
  );
});

test('a model proposal cannot assert authorization, and the parser enforces the same contract', () => {
  const typed = {
    type: 'model_action_proposal',
    proposalId: 'mp:1',
    action: 'memory.add',
    input: {},
    origin: 'model',
    trusted: false,
    authority: 'none',
  };
  assert.equal(validateArtifact(ArtifactKind.MODEL_PROPOSAL, typed).ok, true);

  const selfAuthorized = { ...typed, authorization: { granted: true } };
  assert.match(
    validateArtifact(ArtifactKind.MODEL_PROPOSAL, selfAuthorized).problems.join(' '),
    /cannot assert approval, authorization, execution, or verification/,
  );

  const trusted = { ...typed, trusted: true };
  assert.match(validateArtifact(ArtifactKind.MODEL_PROPOSAL, trusted).problems.join(' '), /trusted must be false/);

  const parsed = parseModelOutput('PROPOSE_ACTION {"action":"memory.add","input":{},"authorized":true}');
  assert.equal(parsed.proposals.length, 0);
  assert.equal(parsed.malformed.length, 1);
  assert.match(parsed.malformed[0].reason, /authorization/);
});

test('an executive handoff carries a proposal and nothing that could pass for approval or execution', () => {
  const handoff = {
    proposalId: 'mp:1',
    action: 'memory.add',
    input: {},
    origin: 'model',
    trusted: false,
    authority: 'none',
    authorization: null,
    executed: false,
  };
  assert.equal(validateArtifact(ArtifactKind.EXECUTIVE_HANDOFF, handoff).ok, true);

  const approved = { ...handoff, authorization: { decision: 'allow' } };
  assert.match(
    validateArtifact(ArtifactKind.EXECUTIVE_HANDOFF, approved).problems.join(' '),
    /authorization must be null/,
  );

  const executed = { ...handoff, executed: true };
  assert.match(
    validateArtifact(ArtifactKind.EXECUTIVE_HANDOFF, executed).problems.join(' '),
    /handoff is not an execution/,
  );

  const borrowed = { ...handoff, approved: true };
  assert.match(
    validateArtifact(ArtifactKind.EXECUTIVE_HANDOFF, borrowed).problems.join(' '),
    /approved is not a handoff field/,
  );
});

test('an unknown artifact kind is rejected rather than passed through', () => {
  const result = validateArtifact('free_form', { anything: true });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /unknown artifact kind/);
  assert.throws(
    () => assertArtifact('free_form', {}),
    (err) => err.code === 'ARTIFACT_INVALID' && err.kind === 'free_form',
  );
});

test('the analysis contract catches a tampered deliberation and names the violated contract', async () => {
  const analysis = await realAnalysis();
  const tampered = clone(analysis.deliberation);
  tampered.recommendation = {
    kind: 'next-step', text: 'run it', command: null, claimIds: [], evidenceIds: [],
    requiresAuthorization: true, executed: true,
  };
  const summary = validateAnalysisArtifacts({
    understanding: analysis.understanding,
    retrieval: analysis.retrieval,
    claims: analysis.claims,
    deliberation: tampered,
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.artifacts.find((entry) => entry.kind === ArtifactKind.DELIBERATION_RESULT).ok, false);
  assert.match(summary.problems.join(' '), /never be marked executed/);
});

test('the claim fixtures stay honest about kind and materiality', () => {
  const claims = [claimFixture(0), claimFixture(1, { kind: ClaimKind.INFERENCE, material: false, evidenceIds: [] })];
  const set = claimSetFixture(claims);
  assert.equal(validateArtifact(ArtifactKind.EXTRACTED_CLAIMS, set).ok, true);
  assert.equal(claims[0].kind, ClaimKind.SUPPORTED);
  assert.equal(claims[1].material, false);
});
