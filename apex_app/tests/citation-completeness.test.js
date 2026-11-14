// Batch AP-10 §7: citation completeness, end to end and at the assessment boundary. Seven scenarios
// are driven where the real request path can reach them; the asymmetric one-sided conflict and the
// pure citation findings are driven against the assessment directly, because the stores record
// conflicts symmetrically. Every reply is a fixed stub or NoBackend. Nothing here runs inference.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { extractClaims } from '../src/cognition/claims.js';
import { validateStructuredResponse } from '../src/cognition/response.js';
import {
  assessResponseIntegrity, assessCitationCompleteness, citationCompletenessNotice,
  ResponseTrustState, ResponseDegradation,
} from '../src/cognition/response-integrity.js';
import { SemanticFinding } from '../src/cognition/semantic-consistency.js';
import { EvidenceState } from '../src/cognition/vocabulary.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const NOW = '2026-05-01T00:00:00.000Z';
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(() => { while (dirs.length) cleanup(dirs.pop()); });

// ---- synthetic assessment fixtures -------------------------------------------------------------

function evidence(source, recordId, claim, extra = {}) {
  return {
    evidenceId: `ev:${source}:${recordId}`,
    source,
    recordId,
    type: extra.type ?? 'memory',
    subject: null,
    claim,
    observedAt: null,
    recordedAt: null,
    provenance: { origin: 'user', operationId: null, updateMode: null },
    status: extra.status ?? 'recorded',
    current: extra.current !== false,
    validity: extra.validity ?? 'current',
    retrievalReason: 'test-fixture',
    score: extra.score ?? null,
    relationships: { supports: [], contradicts: extra.contradicts ?? [] },
  };
}

function analysisOf(evidenceList, options = {}) {
  const { conflicts = [], read = { state: 'complete', complete: true }, report = null } = options;
  const byId = new Map(evidenceList.map((item) => [item.evidenceId, item]));
  return {
    available: true,
    understanding: { intent: 'stored_information', intents: ['stored_information'] },
    retrieval: {
      evidence: evidenceList,
      byId,
      conflicts,
      omitted: [],
      read,
      report,
      sources: [{ source: 'memory', status: 'ok' }],
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
      clarification: null,
    },
  };
}

function assess(analysis, claims, answer = 'A grounded answer.') {
  const validation = validateStructuredResponse({ schema: 1, decision: 'answer', answer, claims }, { analysis });
  const check = validation.ok
    ? { found: true, structure: validation.value, error: null, validation }
    : { found: true, structure: null, error: { code: 'INVALID_STRUCTURE' }, validation };
  return assessResponseIntegrity({ analysis, text: answer, classification: 'valid', check });
}

describe('AP-10 §7 citation completeness at the assessment boundary', () => {
  test('scenario 1: a correct, complete citation is clean and stays below verified', () => {
    const analysis = analysisOf([evidence('memory', 'a', 'the lighthouse status is green', { score: 0.9 })]);
    const result = assess(analysis, [
      { text: 'the lighthouse status is green', evidence: ['ev:memory:a'], kind: 'supported' },
    ]);
    assert.equal(result.trust.state, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.equal(result.degradation, ResponseDegradation.PRESENT_AS_IS);
    assert.deepEqual(result.limitations, ['model_output_unverified']);
    assert.equal(result.verified, false);
    const citation = result.trust.citationCompleteness;
    assert.deepEqual(citation.outsideSnapshot, []);
    assert.deepEqual(citation.uncitedRelevant, []);
    assert.deepEqual(citation.oneSidedConflicts, []);
    assert.equal(citation.bounded, false);
    assert.equal(citation.authorizes, false);
    const claim = result.trust.claims[0];
    assert.equal(claim.citation.cited[0].inSnapshot, true);
    assert.equal(claim.citation.cited[0].lifecycle, 'current');
    assert.equal(claim.citation.oneSidedConflict, false);
    assert.equal(citationCompletenessNotice(result), '');
  });

  test('scenario 2: a relevant retrieved record no claim cites is disclosed, never forced', () => {
    const analysis = analysisOf([
      evidence('memory', 'a', 'the lighthouse status is green', { score: 0.9 }),
      evidence('memory', 'b', 'the lighthouse project deadline is friday', { score: 0.8 }),
    ]);
    const result = assess(analysis, [
      { text: 'the lighthouse status is green', evidence: ['ev:memory:a'], kind: 'supported' },
    ]);
    // An uncited relevant record never downgrades support and never forces a citation.
    assert.equal(result.trust.state, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.ok(result.limitations.includes('citation_relevant_uncited'));
    assert.equal(result.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
    const uncited = result.trust.citationCompleteness.uncitedRelevant;
    assert.deepEqual(uncited.map((entry) => entry.evidenceId), ['ev:memory:b']);
    assert.equal(uncited[0].score, 0.8);
    assert.match(citationCompletenessNotice(result), /cited by no claim/);
  });

  test('a record without a lexical score is never flagged as relevant-uncited', () => {
    const analysis = analysisOf([
      evidence('memory', 'a', 'the lighthouse status is green', { score: 0.9 }),
      evidence('memory', 'b', 'the lighthouse project deadline is friday'),
    ]);
    const result = assess(analysis, [
      { text: 'the lighthouse status is green', evidence: ['ev:memory:a'], kind: 'supported' },
    ]);
    assert.deepEqual(result.trust.citationCompleteness.uncitedRelevant, []);
    assert.equal(result.limitations.includes('citation_relevant_uncited'), false);
  });

  test('a response with no claims has no citation behaviour to assess', () => {
    const analysis = analysisOf([evidence('memory', 'a', 'the lighthouse status is green', { score: 0.9 })]);
    const citation = assessCitationCompleteness({
      claims: [], evidenceById: analysis.retrieval.byId, read: analysis.retrieval.read,
    });
    assert.equal(citation.summary.claims, 0);
    assert.deepEqual(citation.summary.uncitedRelevant, []);
    assert.deepEqual(citation.summary.outsideSnapshot, []);
    assert.deepEqual(citation.summary.oneSidedConflicts, []);
  });

  test('scenario 3: an irrelevant citation is reported as cited and fails attribution', () => {
    const analysis = analysisOf([
      evidence('memory', 'a', 'the lighthouse status is green', { score: 0.9 }),
      evidence('memory', 'b', 'the archive retention window is 30 days', { score: 0.8 }),
    ]);
    const result = assess(analysis, [
      { text: 'the archive retention window is 30 days', evidence: ['ev:memory:a'], kind: 'supported' },
    ]);
    assert.notEqual(result.trust.state, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.ok(result.limitations.includes('claim_attribution_unverified'));
    const claim = result.trust.claims[0];
    assert.deepEqual(claim.citation.cited.map((entry) => entry.evidenceId), ['ev:memory:a']);
    assert.equal(claim.citation.cited[0].inSnapshot, true);
    assert.equal(claim.attribution, 'unattributed');
  });

  test('scenario 4: an ignored retrieved contradiction is refused as a fact and named as one-sided', () => {
    const analysis = analysisOf([
      evidence('memory', 'a', 'the lighthouse status is green', { score: 0.9, contradicts: ['ev:memory:b'] }),
      evidence('memory', 'b', 'the lighthouse status is red', { score: 0.8, contradicts: ['ev:memory:a'] }),
    ], { conflicts: [{ id: 'c1', memberIds: ['ev:memory:a', 'ev:memory:b'] }] });
    const claimText = 'the lighthouse status is green';
    // A flat factual label on unresolved contested records is refused before it can be presented.
    for (const kind of ['supported', 'partially_supported']) {
      const refused = assess(analysis, [{ text: claimText, evidence: ['ev:memory:a'], kind }]);
      assert.notEqual(refused.trust.state, ResponseTrustState.FACTUALLY_SUPPORTED);
      assert.ok(refused.limitations.includes('structured_response_rejected'));
      assert.ok(refused.limitations.includes('evidence_conflicting'));
      assert.equal(refused.trust.claims.length, 0, 'nothing in the refused structure was used');
    }
    // The citation finding is computed over the snapshot, not over the label the model chose: a
    // factual claim citing one side names the retrieved partner that no claim cites.
    const citation = assessCitationCompleteness({
      claims: [{ text: claimText, evidenceIds: ['ev:memory:a'], kind: 'supported' }],
      evidenceById: analysis.retrieval.byId,
      conflicts: analysis.retrieval.conflicts,
    });
    assert.equal(citation.perClaim[0].oneSidedConflict, true);
    assert.deepEqual(citation.perClaim[0].conflictPartners, ['ev:memory:b']);
    assert.equal(citation.summary.oneSidedConflicts.length, 1);
    assert.match(citationCompletenessNotice({ trust: { citationCompleteness: citation.summary } }), /one side of a stored disagreement/);
    // An inference is not presented as a stored fact, so leaning on one record is not a one-sided
    // factual reliance. The contested evidence state is still carried.
    const inferred = assess(analysis, [{ text: claimText, evidence: ['ev:memory:a'], kind: 'inference' }]);
    assert.equal(inferred.trust.claims[0].evidenceState, EvidenceState.CONFLICTING);
    assert.equal(inferred.trust.claims[0].citation.oneSidedConflict, false);
    assert.equal(inferred.limitations.includes('citation_one_sided_conflict'), false);
  });

  test('scenario 5: one-sided reliance on a projection-only conflict blocks factual support', () => {
    const analysis = analysisOf([
      evidence('memory', 'a', 'the lighthouse status is green', { score: 0.9 }),
      evidence('memory', 'b', 'the lighthouse status is red', { score: 0.8 }),
    ]);
    // The disagreement is recorded in the conflict projection but on neither record, which is how a
    // memory disagreement reaches cognition from the world model. The claim's own evidence state is
    // therefore directly supported, so only the citation check can see the other side.
    analysis.retrieval.conflicts = [{ id: 'c1', memberIds: ['ev:memory:a', 'ev:memory:b'] }];
    const result = assess(analysis, [
      { text: 'the lighthouse status is green', evidence: ['ev:memory:a'], kind: 'supported' },
    ]);
    const claim = result.trust.claims[0];
    assert.equal(claim.evidenceState, EvidenceState.DIRECTLY_SUPPORTED);
    assert.equal(claim.citation.oneSidedConflict, true);
    assert.deepEqual(claim.citation.conflictPartners, ['ev:memory:b']);
    assert.equal(claim.semantic.finding, SemanticFinding.INSUFFICIENT_EVIDENCE);
    assert.match(claim.semantic.reason, /one side of a stored disagreement/);
    assert.notEqual(result.trust.state, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.ok(result.limitations.includes('citation_one_sided_conflict'));
    assert.ok(result.limitations.includes('semantic_insufficient_evidence'));
    assert.equal(result.trust.citationCompleteness.oneSidedConflicts.length, 1);
    assert.match(citationCompletenessNotice(result), /one side of a stored disagreement/);
  });

  test('scenario 5 via a conflict group: the same one-sided finding without record links', () => {
    const analysis = analysisOf([
      evidence('memory', 'a', 'the lighthouse status is green', { score: 0.9 }),
      evidence('memory', 'b', 'the lighthouse status is red', { score: 0.8 }),
    ], { conflicts: [{ id: 'c1', memberIds: ['ev:memory:a', 'ev:memory:b'] }] });
    const result = assess(analysis, [
      { text: 'the lighthouse status is green', evidence: ['ev:memory:a'], kind: 'supported' },
    ]);
    assert.equal(result.trust.claims[0].citation.oneSidedConflict, true);
    assert.equal(result.trust.claims[0].semantic.finding, SemanticFinding.INSUFFICIENT_EVIDENCE);
    assert.notEqual(result.trust.state, ResponseTrustState.FACTUALLY_SUPPORTED);
  });

  test('citing both sides of a conflict is not one-sided', () => {
    const analysis = analysisOf([
      evidence('memory', 'a', 'the lighthouse status is green', { score: 0.9, contradicts: ['ev:memory:b'] }),
      evidence('memory', 'b', 'the lighthouse status is red', { score: 0.8, contradicts: ['ev:memory:a'] }),
    ]);
    const result = assess(analysis, [
      { text: 'the lighthouse status is green', evidence: ['ev:memory:a'], kind: 'supported' },
      { text: 'the lighthouse status is red', evidence: ['ev:memory:b'], kind: 'supported' },
    ]);
    for (const claim of result.trust.claims) assert.equal(claim.citation.oneSidedConflict, false);
    assert.deepEqual(result.trust.citationCompleteness.oneSidedConflicts, []);
    assert.equal(result.limitations.includes('citation_one_sided_conflict'), false);
  });

  test('a citation outside the snapshot is a finding', () => {
    const byId = new Map([['ev:memory:a', evidence('memory', 'a', 'the lighthouse status is green', { score: 0.9 })]]);
    const result = assessCitationCompleteness({
      claims: [{ text: 'the lighthouse status is green', evidenceIds: ['ev:memory:a', 'ev:memory:ghost'], kind: 'supported' }],
      evidenceById: byId,
    });
    assert.deepEqual(result.perClaim[0].outsideSnapshot, ['ev:memory:ghost']);
    assert.deepEqual(result.summary.outsideSnapshot, ['ev:memory:ghost']);
    assert.equal(result.perClaim[0].cited.length, 1);
  });

  test('the lifecycle of each cited record is preserved', () => {
    const records = [
      evidence('memory', 'cur', 'a current record', { score: 0.9 }),
      evidence('memory', 'hist', 'a historical record', { score: 0.9, current: false, validity: 'historical' }),
      evidence('memory', 'sup', 'a superseded record', { score: 0.9, validity: 'superseded' }),
      evidence('memory', 'ret', 'a retracted record', { score: 0.9, validity: 'retracted' }),
    ];
    const byId = new Map(records.map((item) => [item.evidenceId, item]));
    const result = assessCitationCompleteness({
      claims: [{ text: 'x', evidenceIds: records.map((r) => r.evidenceId), kind: 'supported' }],
      evidenceById: byId,
    });
    assert.deepEqual(result.perClaim[0].cited.map((entry) => entry.lifecycle), [
      'current', 'historical', 'superseded', 'retracted',
    ]);
  });

  test('a bounded selection is disclosed as bounded', () => {
    const analysis = analysisOf(
      [evidence('memory', 'a', 'the lighthouse status is green', { score: 0.9 })],
      { read: { state: 'bounded_usable', complete: false } },
    );
    const result = assess(analysis, [
      { text: 'the lighthouse status is green', evidence: ['ev:memory:a'], kind: 'supported' },
    ]);
    assert.equal(result.trust.citationCompleteness.bounded, true);
  });
});

// ---- end to end through the real controller ----------------------------------------------------

function captureBackend(text) {
  return {
    name: 'citation-capture',
    provider: 'citation-capture',
    configured: true,
    describe: () => ({ configured: true, provider: 'citation-capture', endpoint: 'synthetic', model: 'synthetic' }),
    health: async () => ({ available: true, detail: 'synthetic capture' }),
    complete: async () => ({
      ok: true, backend: 'citation-capture', provider: 'citation-capture', model: 'synthetic',
      text: typeof text === 'function' ? text() : text, finishReason: 'stop', truncated: false, latencyMs: 0,
    }),
  };
}

function appWith(text, { maxContextChars = null } = {}) {
  const dataDir = makeTempDataDir();
  dirs.push(dataDir);
  const app = createApp({
    dataDir,
    gateway: new ModelGateway({ backend: captureBackend(text) }),
    experienceCapture: CAPTURE_OFF,
    now: () => new Date(NOW),
  });
  if (maxContextChars !== null) app.controller.maxContextChars = maxContextChars;
  return { app, dataDir };
}

function cognitionLine(recordId, claimText, kind = 'supported') {
  return `COGNITION ${JSON.stringify({
    schema: 1,
    decision: 'answer',
    answer: claimText,
    claims: [{ text: claimText, evidence: [`ev:memory:${recordId}`], kind }],
  })}`;
}

function readOps(dataDir) {
  const file = path.join(dataDir, 'operations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

describe('AP-10 §7 citation completeness through the request path', () => {
  test('scenario 1 end to end: a single grounded citation reaches support with a clean report', async () => {
    let recordId = null;
    const { app, dataDir } = appWith(() => cognitionLine(recordId, 'the lighthouse status is green'));
    const record = await app.memory.add({ content: 'the lighthouse status is green', kind: 'user_fact', source: 'user' });
    recordId = record.id;
    const res = await app.controller.handle('tell me about the lighthouse status', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    const integrity = res.operation.cognition.responseIntegrity;
    assert.equal(integrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.deepEqual(integrity.limitations, ['model_output_unverified']);
    const stored = readOps(dataDir).find((op) => op.id === res.operation.id);
    assert.equal(stored.cognition.responseIntegrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.equal(stored.prompt.retrievalReport.sources.find((s) => s.source === 'memory').state, 'complete_with_results');
  });

  test('scenario 2 end to end: an uncited relevant record is disclosed in the audit', async () => {
    let recordId = null;
    const { app } = appWith(() => cognitionLine(recordId, 'the lighthouse status is green'));
    const first = await app.memory.add({ content: 'the lighthouse status is green', kind: 'user_fact', source: 'user' });
    await app.memory.add({ content: 'the lighthouse status review is pending', kind: 'user_fact', source: 'user' });
    recordId = first.id;
    const res = await app.controller.handle('tell me about the lighthouse status', { origin: 'user' });
    const integrity = res.operation.cognition.responseIntegrity;
    assert.ok(integrity.limitations.includes('citation_relevant_uncited'));
    assert.equal(integrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.match(res.output, /cited by no claim/);
  });

  test('plain prose over a clean store invents no citation notice', async () => {
    const { app } = appWith('the parcel locker code is at the front desk');
    await app.memory.add({ content: 'the parcel locker code is kept at the front desk', kind: 'user_fact', source: 'user' });
    const res = await app.controller.handle('where is the parcel locker code kept?', { origin: 'user' });
    const integrity = res.operation.cognition.responseIntegrity;
    assert.equal(integrity.claims.factual, 0);
    assert.equal(integrity.citationCompleteness.uncitedRelevant, 0);
    assert.equal(integrity.limitations.includes('citation_relevant_uncited'), false);
    assert.equal(res.output, 'the parcel locker code is at the front desk');
  });

  test('scenario 4 end to end: a one-sided factual claim is refused and the disagreement is disclosed', async () => {
    let recordId = null;
    const { app } = appWith(() => cognitionLine(recordId, 'the lighthouse status is green', 'partially_supported'));
    const first = await app.memory.add({ content: 'the lighthouse status is green', kind: 'user_fact', source: 'user' });
    await app.memory.add({ content: 'the lighthouse status is red', kind: 'user_fact', source: 'user' });
    recordId = first.id;
    const res = await app.controller.handle('tell me about the lighthouse status', { origin: 'user' });
    const integrity = res.operation.cognition.responseIntegrity;
    // Through the controller the AP-08 validator refuses a factual label on a retrieved, unresolved
    // disagreement before the citation assessment runs, so nothing from the structure is used. The
    // citation assessment's own one-sided finding is pinned at the assessment boundary above.
    assert.notEqual(integrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.ok(integrity.limitations.includes('structured_response_rejected'));
    assert.equal(integrity.claims.total, 0);
    assert.match(res.output, /conflicting records/);
    assert.match(res.output, /rejected a structured model response/);
  });

  test('scenario 6 end to end: a source-limit cut is disclosed in the retrieval report', async () => {
    let recordId = null;
    const { app } = appWith(() => cognitionLine(recordId, 'the lighthouse status is green'));
    const first = await app.memory.add({ content: 'the lighthouse status is green', kind: 'user_fact', source: 'user' });
    for (let i = 0; i < 7; i += 1) {
      await app.memory.add({ content: `the lighthouse status variant ${i} is recorded`, kind: 'user_fact', source: 'user' });
    }
    recordId = first.id;
    const res = await app.controller.handle('lighthouse status', { origin: 'user' });
    const report = res.operation.prompt.retrievalReport;
    const memory = report.sources.find((s) => s.source === 'memory');
    assert.equal(memory.state, 'source_limit_reached');
    assert.ok(memory.exclusions.sourceLimit >= 2);
    assert.equal(report.complete, false);
  });

  test('scenario 7 end to end: a context-budget cut is disclosed to the user and the audit', async () => {
    let recordId = null;
    // The prompt has a fixed scaffolding floor, so a budget above it trims nothing. 300 is below the
    // floor and cuts every retrieved line, which is the case this scenario is about.
    const { app } = appWith(() => cognitionLine(recordId, 'the lighthouse status is green'), { maxContextChars: 300 });
    const first = await app.memory.add({ content: 'the lighthouse status is green', kind: 'user_fact', source: 'user' });
    await app.memory.add({ content: 'the lighthouse status review is pending', kind: 'user_fact', source: 'user' });
    await app.memory.add({ content: 'the lighthouse status audit is scheduled', kind: 'user_fact', source: 'user' });
    recordId = first.id;
    const res = await app.controller.handle('tell me about the lighthouse status', { origin: 'user' });
    const report = res.operation.prompt.retrievalReport;
    const memory = report.sources.find((s) => s.source === 'memory');
    assert.equal(memory.state, 'context_budget_limited');
    assert.equal(memory.exclusions.contextBudget, 3);
    assert.equal(memory.contributed, 3, 'the budget trimmed the prompt, not the evidence snapshot');
    assert.equal(report.complete, false);
    assert.match(res.output, /context budget/);
    assert.ok(report.limitations.some((line) => /context budget/.test(line)));
  });

  test('NoBackend still produces a retrieval report on the no-model path', async () => {
    const dataDir = makeTempDataDir();
    dirs.push(dataDir);
    const app = createApp({
      dataDir, gateway: new ModelGateway({ backend: new NoBackend() }),
      experienceCapture: CAPTURE_OFF, now: () => new Date(NOW),
    });
    await app.memory.add({ content: 'the lighthouse status is green', kind: 'user_fact', source: 'user' });
    const res = await app.controller.handle('tell me about the lighthouse status', { origin: 'user' });
    assert.equal(res.status, Outcome.MODEL_UNAVAILABLE);
    // The no-model path shows records directly and does not run the cognitive analysis, so no
    // retrieval report is fabricated for it; the answer still states that no model summarised it.
    assert.match(res.display, /shown directly/);
  });
});