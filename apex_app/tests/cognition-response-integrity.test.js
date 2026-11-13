// Batch AP-08: grounded response integrity, the model-output trust boundary, and end-to-end
// cognitive acceptance.
//
// Part one drives the assessment module directly with synthetic evidence and structured replies a
// model could have produced. Part two drives the real controller, task runner, plan store and
// operation log with fixed-output stubs. Nothing here contacts a model, launches inference, or
// asserts anything about the quality of model prose. Every expected value is APEX's own
// deterministic classification of records it can actually read.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { extractClaims } from '../src/cognition/claims.js';
import { validateModelOutput } from '../src/cognition/engine.js';
import { validateStructuredResponse } from '../src/cognition/response.js';
import {
  RESPONSE_STAGES,
  RESPONSE_TRUST_STATES,
  ResponseDegradation,
  ResponseFindingKind,
  ResponseStageStatus,
  ResponseTrustState,
  assessResponseIntegrity,
  attributionNotice,
  buildResponseContract,
  evidenceFinding,
  responseContractAudit,
  responseIntegrityAudit,
} from '../src/cognition/response-integrity.js';
import { ClaimKind, EvidenceState, Intent } from '../src/cognition/vocabulary.js';
import { planContentHash } from '../src/plans/model.js';
import {
  HandoffState,
  buildPlanActivationHandoff,
  validateHandoff,
} from '../src/executive/handoff.js';
import { makeTempDataDir, cleanup, makeFakeTaskActions, makePlanGateway, taskStep } from './helpers.js';

const NOW = '2026-05-01T00:00:00.000Z';
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(() => { while (dirs.length) cleanup(dirs.pop()); });

// ---- synthetic analysis ------------------------------------------------------------------------

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
    ...(extra.validity ? { validity: extra.validity } : {}),
    retrievalReason: 'test-fixture',
    relationships: { supports: [], contradicts: [] },
    contradicts: extra.contradicts ?? [],
  };
}

function analysisOf(evidenceList, options = {}) {
  const {
    conflicts = [],
    read = { state: 'complete', complete: true },
    counts = {},
    uncertainty = null,
    missing = [],
    clarification = null,
    decision = 'answer',
  } = options;
  const byId = new Map(evidenceList.map((item) => [item.evidenceId, item]));
  return {
    available: true,
    understanding: { intent: Intent.STORED_INFORMATION, intents: [Intent.STORED_INFORMATION] },
    retrieval: {
      evidence: evidenceList,
      byId,
      conflicts,
      omitted: [],
      read,
      sources: [{ source: 'memory', status: 'ok' }],
      counts: {
        total: evidenceList.length, dropped: 0, unavailable: [], damaged: [], ...counts,
      },
    },
    claims: extractClaims({ evidence: evidenceList, conflicts }),
    deliberation: {
      decision,
      conclusion: { kind: decision === 'clarify' ? 'clarify' : 'supported' },
      uncertainty,
      disclosures: [],
      contradicting: [],
      missing,
      interpretations: [],
      assumptions: [],
      recommendation: null,
      clarification,
    },
  };
}

function structured(analysis, claims, answer = 'A grounded answer.') {
  const validation = validateStructuredResponse({ schema: 1, decision: 'answer', answer, claims }, { analysis });
  return {
    validation,
    check: validation.ok
      ? { found: true, structure: validation.value, error: null, validation }
      : { found: true, structure: null, error: { code: 'INVALID_STRUCTURE' }, validation },
  };
}

function assess(analysis, options = {}) {
  const {
    claims = [], answer = 'A grounded answer.', classification = 'valid', recheck = null,
    truncated = false, plain = false,
  } = options;
  const built = plain ? null : structured(analysis, claims, answer);
  return {
    ...assessResponseIntegrity({
      analysis,
      text: answer,
      classification,
      check: built?.check ?? null,
      recheck,
      truncated,
    }),
    validation: built?.validation ?? null,
  };
}

function statusOf(contract, order) {
  return contract.stages.find((entry) => entry.order === order)?.status;
}

function checkOf(contract, name) {
  return contract.checks.find((entry) => entry.check === name);
}

const NO_PROPOSALS = { observed: 0, wellFormed: 0, malformed: 0, overflow: 0 };

// ---- the fourteen-stage contract ---------------------------------------------------------------

describe('AP-08 §3: the request-to-response contract names fourteen stages', () => {
  test('the stage table is fixed, ordered, and grants no authority before the executive handoff', () => {
    assert.equal(RESPONSE_STAGES.length, 14);
    assert.deepEqual(RESPONSE_STAGES.map((entry) => entry.order), Array.from({ length: 14 }, (_, i) => i + 1));
    assert.deepEqual(RESPONSE_STAGES.map((entry) => entry.id), [
      'request_received', 'request_classification', 'context_retrieval',
      'evidence_snapshot_validation', 'claim_extraction', 'contradiction_analysis',
      'deliberation', 'uncertainty_assessment', 'model_request_preparation',
      'model_output_classification', 'response_construction', 'grounding_validation',
      'final_response', 'executive_handoff',
    ]);
    for (const entry of RESPONSE_STAGES) {
      assert.ok(entry.owner && entry.evidenceRequirement, `stage ${entry.order} names its owner and evidence requirement`);
      assert.equal(entry.authority, entry.order === 14 ? 'proposal_only' : 'none');
    }
  });

  test('a stage that ran with no result is distinct from a stage that was never reached', () => {
    const analysis = analysisOf([]);
    const contract = buildResponseContract({ requestId: 'r-stages', analysis });
    assert.equal(statusOf(contract, 1), ResponseStageStatus.RAN);
    assert.equal(statusOf(contract, 2), ResponseStageStatus.RAN);
    assert.equal(statusOf(contract, 3), ResponseStageStatus.RAN_NO_RESULT, 'retrieval ran over an empty store');
    assert.equal(statusOf(contract, 4), ResponseStageStatus.RAN);
    assert.equal(statusOf(contract, 5), ResponseStageStatus.RAN_NO_RESULT, 'claim extraction ran with nothing to extract');
    assert.equal(statusOf(contract, 6), ResponseStageStatus.RAN_NO_RESULT);
    assert.equal(statusOf(contract, 8), ResponseStageStatus.RAN_NO_RESULT, 'no uncertainty was assessed');
    for (const order of [9, 10, 11, 12, 13, 14]) {
      assert.equal(statusOf(contract, order), ResponseStageStatus.NOT_REACHED, `stage ${order}`);
    }
    assert.notEqual(statusOf(contract, 3), statusOf(contract, 9));
    assert.equal(contract.ok, true, contract.checks.filter((entry) => !entry.ok).map((entry) => entry.detail).join('; '));
    assert.equal(contract.reachedThrough, 8);
    assert.equal(contract.authorizes, false);
  });

  test('a clarification ends the contract before every model and executive stage', () => {
    const analysis = analysisOf([], { decision: 'clarify' });
    const contract = buildResponseContract({ analysis, clarification: true, finalAnswer: true });
    for (const order of [9, 10, 11, 12, 14]) {
      assert.equal(statusOf(contract, order), ResponseStageStatus.NOT_REACHED, `stage ${order}`);
    }
    assert.equal(statusOf(contract, 13), ResponseStageStatus.RAN, 'the deterministic question is the final answer');
    assert.equal(contract.ok, true);
  });

  test('the audited contract is bounded and carries no model prose', () => {
    const analysis = analysisOf([evidence('memory', 'm-audit', 'the vault code is cobalt')]);
    const built = assess(analysis, {
      claims: [{ text: 'the vault code is cobalt', evidence: ['ev:memory:m-audit'], kind: 'supported' }],
    });
    const contract = buildResponseContract({
      requestId: 'r-audit',
      analysis,
      model: { prepared: true, class: 'valid', ok: true, promptChars: 120 },
      check: built.validation.ok
        ? { found: true, structure: built.validation.value, error: null }
        : null,
      text: built.validation.value.answer,
      proposals: NO_PROPOSALS,
      finalAnswer: true,
      trustState: built.trust.state,
    });
    const audit = responseContractAudit(contract);
    assert.deepEqual(Object.keys(audit).sort(), [
      'authority', 'authorizes', 'checks', 'ok', 'reachedThrough', 'requestId', 'schema', 'stages',
    ]);
    for (const entry of audit.stages) {
      assert.deepEqual(Object.keys(entry).sort(), ['counts', 'id', 'order', 'status']);
    }
    assert.equal(JSON.stringify(audit).includes('cobalt'), false, 'no stored text reaches the audit');
    assert.equal(audit.authority.authorizes, false);
    assert.equal(audit.authorizes, false);
    assert.equal(audit.stages[13].counts.observed, 0);
    assert.equal(audit.stages[13].status, ResponseStageStatus.SKIPPED, 'proposal stage skipped, not reached');
  });

  test('the contract is a pure function of its inputs', () => {
    const analysis = analysisOf([evidence('memory', 'm-pure', 'the audit is open')]);
    const input = { requestId: 'r-pure', analysis, proposals: NO_PROPOSALS, finalAnswer: true };
    assert.deepEqual(buildResponseContract(input).stages, buildResponseContract(input).stages);
  });
});

// ---- §10 deterministic acceptance: 28 scenarios ------------------------------------------------

describe('AP-08 §10 deterministic acceptance', () => {
  test('1 directly supported fact is factually supported and presented as-is', () => {
    const analysis = analysisOf([evidence('memory', 'm-1', 'the lighthouse status is green')]);
    const result = assess(analysis, {
      claims: [{ text: 'the lighthouse status is green', evidence: ['ev:memory:m-1'], kind: 'supported' }],
      answer: 'The lighthouse status is green.',
    });
    assert.equal(result.finding.kind, null);
    assert.equal(result.trust.state, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.equal(result.degradation, ResponseDegradation.PRESENT_AS_IS);
    assert.deepEqual(result.limitations, ['model_output_unverified']);
    assert.equal(result.verified, false);
    assert.equal(result.authorizes, false);
    assert.equal(result.trust.claims[0].attribution, 'attributed');
  });

  test('2 relevant but insufficient evidence is reported as insufficient, not as support', () => {
    const analysis = analysisOf([evidence('memory', 'm-2', 'the audit result was recorded without usable validity', { status: ClaimKind.UNKNOWN })]);
    assert.equal(analysis.claims.claims[0].evidenceState, EvidenceState.UNVERIFIED);
    const result = assess(analysis, { plain: true, answer: 'The record does not settle the audit result.' });
    assert.equal(result.finding.kind, ResponseFindingKind.INSUFFICIENT_EVIDENCE);
    assert.equal(result.trust.state, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.equal(result.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
  });

  test('3 a complete empty read is not_found; a bounded empty read is unknown', () => {
    const complete = analysisOf([]);
    assert.equal(evidenceFinding(complete).kind, ResponseFindingKind.NOT_FOUND);
    const bounded = analysisOf([], { read: { state: 'bounded_usable', complete: false } });
    assert.equal(evidenceFinding(bounded).kind, ResponseFindingKind.UNKNOWN);
    const result = assess(complete, { plain: true, answer: 'Nothing matching is stored.' });
    assert.equal(result.trust.state, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
  });

  test('4 contradictory records stay conflicting and both sides remain evidence', () => {
    const list = [
      evidence('world_fact', 'f-1', 'Atlas owner = Nadia', { type: 'fact', status: ClaimKind.CONTRADICTED }),
      evidence('world_fact', 'f-2', 'Atlas owner = Bruno', { type: 'fact', status: ClaimKind.CONTRADICTED }),
    ];
    const analysis = analysisOf(list, {
      conflicts: [{ id: 'c-1', members: [{ id: 'f-1' }, { id: 'f-2' }] }],
    });
    assert.deepEqual(analysis.claims.claims.map((claim) => claim.evidenceState), [
      EvidenceState.CONFLICTING, EvidenceState.CONFLICTING,
    ]);
    const result = assess(analysis, { plain: true, answer: 'The records disagree.' });
    assert.equal(result.finding.kind, ResponseFindingKind.CONFLICTING);
    assert.ok(result.limitations.includes('evidence_conflicting'));
    assert.equal(result.trust.state, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
  });

  test('5 a stale record cannot support a current answer', () => {
    const analysis = analysisOf([
      evidence('memory', 'm-3', 'the audit was open last month', { status: ClaimKind.HISTORICAL, current: false }),
    ]);
    assert.equal(analysis.claims.claims[0].evidenceState, EvidenceState.TEMPORALLY_STALE);
    const result = assess(analysis, {
      claims: [{ text: 'the audit was open last month', evidence: ['ev:memory:m-3'], kind: 'historical' }],
      answer: 'The audit was open last month.',
    });
    assert.equal(result.finding.kind, ResponseFindingKind.INSUFFICIENT_EVIDENCE);
    assert.equal(result.trust.state, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.equal(result.trust.claims[0].evidenceState, EvidenceState.TEMPORALLY_STALE);
  });

  test('6 a retracted record is not evidence at all', () => {
    const analysis = analysisOf([
      evidence('memory', 'm-4', 'the audit is open', { status: 'retracted', current: false, validity: 'retracted' }),
    ]);
    assert.equal(analysis.claims.claims[0].evidenceState, EvidenceState.RETRACTED);
    const result = assess(analysis, { plain: true, answer: 'That record was withdrawn.' });
    assert.equal(result.finding.kind, ResponseFindingKind.INSUFFICIENT_EVIDENCE);
  });

  test('7 a truncated retrieval qualifies a supported answer', () => {
    const analysis = analysisOf(
      [evidence('memory', 'm-5', 'the archive batch is ready')],
      { read: { state: 'truncated', complete: false }, counts: { dropped: 4 } },
    );
    const result = assess(analysis, {
      claims: [{ text: 'the archive batch is ready', evidence: ['ev:memory:m-5'], kind: 'supported' }],
      answer: 'The archive batch is ready.',
    });
    assert.equal(result.finding.kind, null);
    assert.ok(result.limitations.includes('evidence_truncated'));
    assert.equal(result.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
  });

  test('8 an unavailable source is unavailable, not empty', () => {
    const analysis = analysisOf([], {
      read: { state: 'bounded_usable', complete: false },
      counts: { unavailable: ['knowledge'] },
    });
    const result = assess(analysis, { plain: true, answer: 'The knowledge store could not be read.' });
    assert.equal(result.finding.kind, ResponseFindingKind.UNAVAILABLE);
    assert.ok(result.limitations.includes('evidence_unavailable'));
  });

  test('9 a damaged source is unavailable, not empty', () => {
    const analysis = analysisOf([], {
      read: { state: 'bounded_usable', complete: false },
      counts: { damaged: ['memory'] },
    });
    assert.equal(evidenceFinding(analysis).kind, ResponseFindingKind.UNAVAILABLE);
    const result = assess(analysis, { plain: true, answer: 'Part of the store could not be read.' });
    assert.ok(result.limitations.includes('evidence_unavailable'));
  });

  test('10 an inconsistent cross-store snapshot fails the snapshot stage and is not_checked', () => {
    const analysis = analysisOf([], { read: { state: 'inconsistent', complete: false } });
    const result = assess(analysis, { plain: true, answer: 'The stores could not be checked as one snapshot.' });
    assert.equal(result.finding.kind, ResponseFindingKind.NOT_CHECKED);
    const contract = buildResponseContract({
      analysis,
      model: { prepared: true, class: 'valid', ok: true },
      text: 'The stores could not be checked as one snapshot.',
      proposals: NO_PROPOSALS,
      finalAnswer: true,
    });
    assert.equal(statusOf(contract, 4), ResponseStageStatus.FAILED);
  });

  test('11 an ambiguous reference is clarified before any model stage', async () => {
    const { app, calls } = appWith('this reply must never be used');
    await addEntity(app, 'atlas-one', 'Atlas One', { aliases: ['Atlas'] });
    await addEntity(app, 'atlas-two', 'Atlas Two', { aliases: ['Atlas'] });

    const res = await app.controller.handle('what is the status of Atlas?', { origin: 'user' });
    assert.equal(res.status, Outcome.CLARIFICATION_REQUIRED);
    assert.equal(calls.length, 0, 'a clarification is asked before a model can answer past it');
    const contract = res.operation.cognition.responseContract;
    for (const order of [9, 10, 11, 12, 14]) {
      assert.equal(statusOf(contract, order), ResponseStageStatus.NOT_REACHED, `stage ${order}`);
    }
    assert.equal(statusOf(contract, 13), ResponseStageStatus.RAN);
    const integrity = res.operation.cognition.responseIntegrity;
    assert.equal(integrity.trust, null);
    assert.equal(integrity.degradation, ResponseDegradation.NO_OUTPUT);
    assert.deepEqual(integrity.limitations, []);
  });

  test('12 a missing capability is refused before any model call', async () => {
    const { app, calls } = appWith('this reply must never be used');
    const res = await app.controller.handle('delete the production database', { origin: 'user' });
    assert.equal(res.status, Outcome.ACTION_DENIED);
    assert.equal(calls.length, 0, 'no model was asked to carry out a capability APEX does not have');
    assert.equal(res.operation.steps.length, 0);
    assert.ok(res.operation.errors.some((error) => error.code === 'UNSUPPORTED_OPERATION'));
    assert.equal(res.operation.cognition?.responseContract ?? null, null,
      'the refusal never entered the model-bearing cognitive path');
  });

  test('13 an unsupported model claim is presented with its limitation, never as support', () => {
    const analysis = analysisOf([evidence('memory', 'm-6', 'the lighthouse status is green')]);
    const result = assess(analysis, {
      claims: [{ text: 'the market will recover next quarter', kind: 'general_knowledge' }],
      answer: 'The market will recover next quarter.',
    });
    assert.equal(result.trust.state, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.ok(result.limitations.includes('claims_general_knowledge'));
    assert.equal(result.verified, false);
  });

  test('14 a model claim contradicting evidence is rejected whole', () => {
    const list = [
      evidence('world_fact', 'f-1', 'Atlas owner = Nadia', { type: 'fact', status: ClaimKind.CONTRADICTED }),
      evidence('world_fact', 'f-2', 'Atlas owner = Bruno', { type: 'fact', status: ClaimKind.CONTRADICTED }),
    ];
    const analysis = analysisOf(list, {
      conflicts: [{ id: 'c-1', members: [{ id: 'f-1' }, { id: 'f-2' }] }],
    });
    const built = structured(analysis, [
      { text: 'Atlas is owned by Nadia', evidence: ['ev:world_fact:f-1'], kind: 'supported' },
    ], 'Atlas is owned by Nadia.');
    assert.equal(built.validation.ok, false);
    assert.ok(built.validation.problems.some((problem) => /disagree and the disagreement is unresolved/.test(problem)));
    const result = assessResponseIntegrity({
      analysis, text: 'Atlas is owned by Nadia.', classification: 'valid', check: built.check,
    });
    assert.equal(result.trust.state, ResponseTrustState.RECEIVED);
    assert.ok(result.limitations.includes('structured_response_rejected'));
  });

  test('15 a fabricated evidence id is rejected and reaches the answer as no citation', () => {
    const analysis = analysisOf([evidence('memory', 'm-7', 'the audit is open')]);
    const built = structured(analysis, [
      { text: 'the audit is open', evidence: ['ev:memory:not-this-request'], kind: 'supported' },
    ], 'The audit is open.');
    assert.equal(built.validation.ok, false);
    assert.ok(built.validation.problems.some((problem) => /is not in this retrieval/.test(problem)));
    const result = assessResponseIntegrity({
      analysis, text: 'The audit is open.', classification: 'valid', check: built.check,
    });
    assert.equal(result.trust.state, ResponseTrustState.RECEIVED);
    assert.equal(result.attributionFailures, 0, 'no claim from a rejected structure is counted as attribution');
  });

  test('16 a model-declared verification or authority field is rejected', () => {
    const analysis = analysisOf([evidence('memory', 'm-8', 'the audit is open')]);
    for (const field of ['verified', 'authorization', 'provenance', 'authorized', 'trusted']) {
      const response = {
        schema: 1, decision: 'answer', answer: 'The audit is open.',
        claims: [{ text: 'the audit is open', evidence: ['ev:memory:m-8'], kind: 'supported' }],
        [field]: true,
      };
      const validation = validateStructuredResponse(response, { analysis });
      assert.equal(validation.ok, false, field);
      assert.ok(validation.problems.some((problem) => problem.includes(field)), `${field}: ${validation.problems.join('; ')}`);
    }
    const result = assess(analysis, {
      claims: [{ text: 'the audit is open', evidence: ['ev:memory:m-8'], kind: 'supported' }],
      answer: 'The audit is open. APEX has verified this statement.',
    });
    assert.equal(result.verified, false, 'the trust ladder has no top rung for model prose');
    assert.equal(result.trust.ladder.at(-1).ok, false);
  });

  test('17 malformed gateway output is rejected as a structured response', () => {
    const analysis = analysisOf([evidence('memory', 'm-9', 'the audit is open')]);
    const check = validateModelOutput('The audit is open.\nCOGNITION {not json', analysis);
    assert.equal(check.error?.code, 'MALFORMED_JSON');
    const result = assessResponseIntegrity({
      analysis, text: check.text, classification: 'valid', check,
    });
    assert.equal(result.trust.state, ResponseTrustState.RECEIVED);
    assert.ok(result.limitations.includes('structured_response_rejected'));
  });

  test('18 an empty output has no trust state and no wording to qualify', () => {
    const analysis = analysisOf([]);
    const result = assessResponseIntegrity({ analysis, text: '', classification: 'empty' });
    assert.equal(result.trust.state, null);
    assert.equal(result.degradation, ResponseDegradation.NO_OUTPUT);
    assert.deepEqual(result.limitations, []);
    assert.equal(result.accepted, false);
  });

  test('19 a refusal never climbs past syntax, and a textual refusal still is not accepted', () => {
    const analysis = analysisOf([]);
    const silent = assessResponseIntegrity({ analysis, text: '', classification: 'refused' });
    assert.equal(silent.trust.state, null);
    assert.equal(silent.degradation, ResponseDegradation.NO_OUTPUT);
    const spoken = assessResponseIntegrity({
      analysis, text: 'I cannot help with that request.', classification: 'refused',
    });
    assert.equal(spoken.trust.state, ResponseTrustState.SYNTACTICALLY_VALID);
    assert.equal(spoken.accepted, false);
    assert.equal(spoken.verified, false);
  });

  test('20 a cancelled request records a failed model stage and constructs no response', async () => {
    const dataDir = makeTempDataDir();
    dirs.push(dataDir);
    const gateway = stubGateway('PROPOSE_ACTION {"action":"memory.add","input":{"content":"never runs"}}');
    const app = createApp({ dataDir, gateway, now: () => new Date(NOW), experienceCapture: CAPTURE_OFF });
    const controller = new AbortController();
    controller.abort();

    const res = await app.controller.handle('tell me something about the sky', {
      origin: 'user', signal: controller.signal,
    });
    assert.equal(res.status, Outcome.REQUEST_CANCELLED);
    assert.equal(res.operation.steps.length, 0);
    const contract = res.operation.cognition.responseContract;
    assert.equal(statusOf(contract, 10), ResponseStageStatus.FAILED);
    assert.equal(statusOf(contract, 11), ResponseStageStatus.RAN_NO_RESULT);
    assert.equal(statusOf(contract, 12), ResponseStageStatus.SKIPPED);
    assert.equal(statusOf(contract, 13), ResponseStageStatus.RAN);
    assert.equal(statusOf(contract, 14), ResponseStageStatus.SKIPPED);
    assert.equal(contract.checks.find((entry) => entry.check === 'execution_requires_registry_allow').ok, true);
    const integrity = res.operation.cognition.responseIntegrity;
    assert.equal(integrity.trust, null);
    assert.equal(integrity.degradation, ResponseDegradation.NO_OUTPUT);
  });

  test('21 an unavailable transport is a failed model stage, not an empty answer', () => {
    const analysis = analysisOf([]);
    const result = assessResponseIntegrity({ analysis, text: '', classification: 'unavailable' });
    assert.equal(result.trust.state, null);
    assert.equal(result.degradation, ResponseDegradation.NO_OUTPUT);
    const contract = buildResponseContract({
      analysis,
      model: { prepared: true, class: 'unavailable', ok: false },
      text: '',
      proposals: NO_PROPOSALS,
      finalAnswer: true,
    });
    assert.equal(statusOf(contract, 10), ResponseStageStatus.FAILED);
    assert.equal(statusOf(contract, 11), ResponseStageStatus.SKIPPED);
    assert.equal(statusOf(contract, 12), ResponseStageStatus.SKIPPED);
    assert.equal(contract.ok, true);
  });

  test('22 a valid response with an unsupported secondary claim stays at presentation', () => {
    const analysis = analysisOf([evidence('memory', 'm-10', 'the lighthouse status is green')]);
    const result = assess(analysis, {
      claims: [
        { text: 'the lighthouse status is green', evidence: ['ev:memory:m-10'], kind: 'supported' },
        { text: 'the market will recover next quarter', kind: 'general_knowledge' },
      ],
      answer: 'The lighthouse status is green. The market will recover next quarter.',
    });
    assert.equal(result.trust.state, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.equal(result.trust.state === ResponseTrustState.FACTUALLY_SUPPORTED, false);
    assert.equal(result.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
    assert.ok(result.limitations.includes('claims_general_knowledge'));
  });

  test('23 a claim that cites a record it does not restate is an attribution failure', () => {
    const analysis = analysisOf([
      evidence('memory', 'm-11', 'the archive retention window is 30 days'),
    ]);
    const result = assess(analysis, {
      claims: [{
        text: 'the archive retention window is 90 days',
        evidence: ['ev:memory:m-11'],
        kind: 'supported',
      }],
      answer: 'The archive retention window is 90 days.',
    });
    assert.equal(result.trust.state, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.equal(result.attributionFailures, 1);
    assert.equal(result.trust.claims[0].attribution, 'unattributed');
    assert.ok(result.limitations.includes('claim_attribution_unverified'));
    assert.match(attributionNotice(result), /do not restate those records/);
  });

  test('24 a model proposal attempting execution runs nothing without the registry', async () => {
    const { app, dataDir } = appWith([
      'I have executed the memory write.',
      'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the model decided this"}}',
    ].join('\n'));
    const before = readJsonl(path.join(dataDir, 'memory.jsonl')).length;

    const res = await app.controller.handle('tell me about the release plan', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.operation.steps.length, 1);
    const [step] = res.operation.steps;
    assert.equal(step.origin, 'model');
    assert.equal(step.authorization.decision, 'deny');
    assert.equal(step.execution.status, 'not_run');
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.equal(readJsonl(path.join(dataDir, 'memory.jsonl')).length, before, 'the denied proposal wrote nothing');
    assert.match(res.output, /did not execute/);
    const audit = res.operation.cognition.responseContract;
    assert.equal(statusOf(audit, 14), ResponseStageStatus.RAN);
    assert.deepEqual(audit.stages[13].counts, {
      observed: 1, well_formed: 1, malformed: 0, overflow: 0, executed: 0, denied: 1,
    });
    assert.equal(audit.checks.find((entry) => entry.check === 'handoff_claims_no_authority').ok, true);
    assert.equal(step.handoff.authorizes, false);
    assert.notEqual(step.handoff.authorization.owner, 'model');
  });

  test('25 an approved plan whose content changed is denied at activation', async () => {
    const dataDir = makeTempDataDir();
    dirs.push(dataDir);
    const app = createApp({
      dataDir, gateway: stubGateway('unused'), now: () => new Date(NOW), experienceCapture: CAPTURE_OFF,
    });
    const added = await app.controller.planAdd({
      outcome: 'the changed-content fixture plan runs',
      reason: 'AP-08 changed content',
      steps: [1, 2].map((n) => ({
        id: `s${n}`,
        description: `fixture step ${n}`,
        action: 'memory.search',
        input: { query: 'lighthouse' },
        dependsOn: n === 1 ? [] : ['s1'],
        expectedResult: 'records are listed',
        verification: 'a record is named',
        risk: 'low',
      })),
    });
    assert.equal(added.status, Outcome.PLAN_STORED, added.display);
    const planId = added.operation.steps[0].result.data.planId;
    const approved = await app.controller.planApprove({ target: planId });
    assert.equal(approved.status, Outcome.PLAN_STORED, approved.display);
    const live = await app.plans.get(planId);
    assert.equal(live.approval.contentHash, planContentHash(live));

    const changed = {
      ...live,
      steps: live.steps.map((step, i) => (i === 0 ? { ...step, description: 'changed after approval' } : step)),
    };
    assert.notEqual(planContentHash(changed), planContentHash(live));
    const task = { id: 'task-ap08-changed', planId, origin: 'user', steps: changed.steps.map((s) => ({ id: s.id })) };
    const record = buildPlanActivationHandoff({ requestId: 'r-changed', plan: changed, task });
    assert.equal(record.authorization.decision, 'deny');
    assert.equal(record.authorization.reason, 'APPROVAL_NOT_BOUND_TO_PLAN');
    assert.equal(record.approval, null);
    assert.equal(record.authorizes, false);
    assert.equal(validateHandoff(record, { phase: 'prepared' }).ok, true, 'a denial is still a well-formed record');
  });

  test('26 a grounded answer and a separate proposal keep their authority separate', async () => {
    let recordId = null;
    const { app } = appWith(() => [
      'The lighthouse project status is green.',
      `PROPOSE_ACTION ${JSON.stringify({ action: 'memory.search', input: { query: 'lighthouse' } })}`,
      `COGNITION ${JSON.stringify({
        schema: 1,
        decision: 'answer',
        answer: 'The lighthouse project status is green.',
        claims: [{
          text: 'the lighthouse project status is green',
          evidence: [`ev:memory:${recordId}`],
          kind: 'supported',
        }],
      })}`,
    ].join('\n'));
    const record = await app.memory.add({
      content: 'the lighthouse project status is green', kind: 'user_fact', source: 'user',
    });
    recordId = record.id;

    const res = await app.controller.handle('tell me about the lighthouse project status', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    const integrity = res.operation.cognition.responseIntegrity;
    assert.equal(integrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.equal(integrity.degradation, ResponseDegradation.PRESENT_AS_IS);
    assert.equal(res.operation.steps.length, 1);
    const [step] = res.operation.steps;
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(step.authorization.decision, 'allow');
    assert.equal(step.handoff.authorizes, false);
    assert.equal(step.handoff.authorization.owner, 'action_registry');
    assert.equal(step.handoff.state, HandoffState.VERIFIED);
    const audit = res.operation.cognition.responseContract;
    assert.deepEqual(audit.stages[13].counts, {
      observed: 1, well_formed: 1, malformed: 0, overflow: 0, executed: 1, denied: 0,
    });
    assert.equal(audit.checks.every((entry) => entry.ok), true);
  });

  test('27 repeated identical requests produce identical assessments', async () => {
    async function run() {
      const { app } = appWith(() => [
        'The lighthouse project status is green.',
        'COGNITION ' + JSON.stringify({
          schema: 1,
          decision: 'answer',
          answer: 'The lighthouse project status is green.',
          claims: [{
            text: 'the lighthouse project status is green',
            evidence: [`ev:memory:${recordId}`],
            kind: 'supported',
          }],
        }),
      ].join('\n'));
      const record = await app.memory.add({
        content: 'the lighthouse project status is green', kind: 'user_fact', source: 'user',
      });
      recordId = record.id;
      const res = await app.controller.handle('tell me about the lighthouse project status', { origin: 'user' });
      return res.operation.cognition;
    }
    let recordId = null;
    const first = await run();
    const second = await run();
    assert.deepEqual(first.responseIntegrity, second.responseIntegrity);
    assert.deepEqual(first.responseContract.stages, second.responseContract.stages);
    assert.deepEqual(first.responseContract.checks, second.responseContract.checks);
  });

  test('28 evidence changed between retrieval and final validation weakens the assessment', async () => {
    const dataDir = makeTempDataDir();
    dirs.push(dataDir);
    const capture = captureBackend('placeholder');
    const app = createApp({
      dataDir,
      gateway: new ModelGateway({ backend: capture.backend }),
      experienceCapture: CAPTURE_OFF,
      now: () => new Date(NOW),
    });
    const record = await app.memory.add({
      content: 'the lighthouse project status is green', kind: 'user_fact', source: 'user',
    });
    capture.backend.complete = async () => {
      await app.memory.correct({
        targetId: record.id, content: 'the lighthouse project status is red', origin: 'user',
      });
      return {
        ok: true,
        backend: 'cognition-capture',
        provider: 'cognition-capture',
        model: 'synthetic',
        text: [
          'The lighthouse project status is green.',
          `COGNITION ${JSON.stringify({
            schema: 1,
            decision: 'answer',
            answer: 'The lighthouse project status is green.',
            claims: [{
              text: 'the lighthouse project status is green',
              evidence: [`ev:memory:${record.id}`],
              kind: 'supported',
            }],
          })}`,
        ].join('\n'),
        finishReason: 'stop',
        truncated: false,
        latencyMs: 0,
      };
    };

    const res = await app.controller.handle('tell me about the lighthouse project status', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    const cognition = res.operation.cognition;
    assert.ok(cognition.evidenceRecheck.weakened > 0, 'the old record no longer stands');
    assert.equal(cognition.responseIntegrity.limitations.includes('evidence_changed'), true);
    assert.notEqual(cognition.responseIntegrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.equal(cognition.responseContract.checks.find((entry) => entry.check === 'evidence_recheck_is_observation_only').ok, true);
    assert.match(res.output, /changed while the answer was being produced/);
  });
});

// ---- §11 adversarial boundaries -----------------------------------------------------------------

describe('AP-08 §11 adversarial response boundaries', () => {
  test('forged, duplicated, oversized, and unknown-field structures are refused whole', () => {
    const analysis = analysisOf([evidence('memory', 'm-adv', 'the audit is open')]);
    const base = { text: 'the audit is open', evidence: ['ev:memory:m-adv'], kind: 'supported' };

    const forged = validateStructuredResponse({
      schema: 1, decision: 'answer', answer: 'The audit is open.',
      claims: [{ ...base, evidence: ['ev:memory:forged'] }],
    }, { analysis });
    assert.equal(forged.ok, false);

    const unknown = validateStructuredResponse({
      schema: 1, decision: 'answer', answer: 'The audit is open.', claims: [{ ...base, confidence: 0.99 }],
    }, { analysis });
    assert.equal(unknown.ok, false);

    const rootUnknown = validateStructuredResponse({
      schema: 1, decision: 'answer', answer: 'The audit is open.', truth: 'verified',
    }, { analysis });
    assert.equal(rootUnknown.ok, false);

    const tooMany = validateStructuredResponse({
      schema: 1, decision: 'answer', answer: 'Many claims.',
      claims: Array.from({ length: 13 }, (_, i) => ({ ...base, text: `claim ${i} about the audit` })),
    }, { analysis });
    assert.equal(tooMany.ok, false);
    assert.ok(tooMany.problems.some((problem) => /must not exceed 12 entries/.test(problem)));

    const duplicate = validateStructuredResponse({
      schema: 1, decision: 'answer', answer: 'The audit is open.',
      claims: [base, { ...base }],
    }, { analysis });
    assert.equal(duplicate.ok, true, 'a duplicate is kept and counted, not silently merged');
    assert.equal(duplicate.value.claims.length, 2);
  });

  test('a model-origin attempt to authorize or execute is rejected or denied, never allowed', () => {
    const analysis = analysisOf([evidence('memory', 'm-adv2', 'the audit is open')]);
    for (const field of ['action', 'execute', 'approve', 'permission', 'run']) {
      const validation = validateStructuredResponse({
        schema: 1, decision: 'answer', answer: 'The audit is open.',
        claims: [{ text: 'the audit is open', evidence: ['ev:memory:m-adv2'], kind: 'supported' }],
        [field]: 'memory.add',
      }, { analysis });
      assert.equal(validation.ok, false, field);
    }

    const denial = buildResponseContract({
      model: { prepared: true, class: 'valid', ok: true },
      text: 'a reply',
      proposals: { observed: 1, wellFormed: 1, malformed: 0, overflow: 0 },
      steps: [{ authorization: { decision: 'deny' }, execution: { status: 'not_run' } }],
      finalAnswer: true,
    });
    assert.equal(checkOf(denial, 'execution_requires_registry_allow').ok, true);

    const forgedExecution = buildResponseContract({
      model: { prepared: true, class: 'valid', ok: true },
      steps: [{ authorization: null, execution: { status: 'ok' } }],
      finalAnswer: true,
    });
    assert.equal(checkOf(forgedExecution, 'execution_requires_registry_allow').ok, false);
  });

  test('a handoff that authorizes itself fails the contract, while a registry decision passes', () => {
    const selfAuthorized = buildResponseContract({
      model: { prepared: true, class: 'valid', ok: true },
      proposals: { observed: 1, wellFormed: 1, malformed: 0, overflow: 0 },
      steps: [{ handoff: { authorizes: true } }],
    });
    assert.equal(checkOf(selfAuthorized, 'handoff_claims_no_authority').ok, false);

    const modelOwned = buildResponseContract({
      model: { prepared: true, class: 'valid', ok: true },
      proposals: { observed: 1, wellFormed: 1, malformed: 0, overflow: 0 },
      steps: [{ handoff: { authorizes: false, authorization: { owner: 'model', decision: 'allow' } } }],
    });
    assert.equal(checkOf(modelOwned, 'handoff_claims_no_authority').ok, false);

    const registry = buildResponseContract({
      model: { prepared: true, class: 'valid', ok: true },
      proposals: { observed: 1, wellFormed: 1, malformed: 0, overflow: 0 },
      steps: [{ handoff: { authorizes: false, authorization: { owner: 'action_registry', decision: 'allow' } } }],
    });
    assert.equal(checkOf(registry, 'handoff_claims_no_authority').ok, true);
  });

  test('a rejected grounding check can never be paired with factual support', () => {
    const analysis = analysisOf([]);
    const contract = buildResponseContract({
      analysis,
      model: { prepared: true, class: 'valid', ok: true },
      check: { found: false, structure: null, error: { code: 'INVALID_STRUCTURE' } },
      text: 'a reply',
      trustState: ResponseTrustState.FACTUALLY_SUPPORTED,
      finalAnswer: true,
    });
    assert.equal(checkOf(contract, 'grounding_precedes_final_answer').ok, false);
    assert.equal(statusOf(contract, 12), ResponseStageStatus.FAILED);
    assert.equal(contract.ok, false);
  });

  test('the integrity audit is bounded and never carries the request, a record, or model prose', () => {
    const analysis = analysisOf([evidence('memory', 'm-secret', 'the vault password is hunter2')]);
    const result = assess(analysis, {
      claims: [{
        text: 'the vault password is hunter2', evidence: ['ev:memory:m-secret'], kind: 'supported',
      }],
      answer: 'The vault password is hunter2.',
    });
    const audit = responseIntegrityAudit(result);
    assert.deepEqual(Object.keys(audit).sort(), [
      'authorizes', 'claims', 'degradation', 'finding', 'findingReason', 'limitations', 'schema', 'trust', 'verified',
    ]);
    const serialized = JSON.stringify(audit);
    assert.equal(serialized.includes('hunter2'), false);
    assert.equal(serialized.includes('m-secret'), false);
    assert.equal(serialized.includes('The vault password'), false);
    assert.equal(audit.verified, false);
    assert.equal(audit.authorizes, false);
    assert.deepEqual(Object.keys(audit.claims).sort(), [
      'factual', 'generalKnowledge', 'inferred', 'partial', 'partialAttribution', 'supported', 'total', 'unattributed',
    ]);
  });

  test('diagnostics that are unavailable are recorded instead of silently deciding', () => {
    const contract = buildResponseContract({ requestId: 'r-diag', analysis: { available: false } });
    for (const order of [2, 3, 4, 5, 6, 7, 8]) {
      assert.equal(statusOf(contract, order), ResponseStageStatus.UNAVAILABLE, `stage ${order}`);
    }
    for (const order of [9, 10, 11, 12, 13, 14]) {
      assert.equal(statusOf(contract, order), ResponseStageStatus.NOT_REACHED, `stage ${order}`);
    }
    assert.equal(contract.ok, true);
    assert.equal(contract.reachedThrough, 1);
    const assessment = assessResponseIntegrity({
      analysis: { available: false }, text: 'A plain answer.', classification: 'valid',
    });
    assert.equal(assessment.trust.state, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.equal(assessment.verified, false);
  });

  test('a malformed trace or missing assessment does not invent a result or throw', () => {
    assert.equal(responseContractAudit(null), null);
    assert.equal(responseIntegrityAudit(null), null);
    const contract = buildResponseContract({
      lifecycle: { stages: 'not-an-array' },
      model: { prepared: true, class: 'valid', ok: true },
      text: 'A reply.',
      proposals: { observed: 'three', wellFormed: null },
      steps: [null, { execution: null }],
      finalAnswer: true,
    });
    assert.equal(contract.ok, true);
    assert.equal(statusOf(contract, 14), ResponseStageStatus.UNAVAILABLE,
      'a proposal tally that is not a count is unavailable, never read as zero proposals');
  });

  test('every trust state is reachable as a distinct label, and none is numeric', () => {
    assert.deepEqual(RESPONSE_TRUST_STATES, [
      'received', 'syntactically_valid', 'accepted_for_presentation', 'factually_supported', 'verified',
    ]);
    const analysis = analysisOf([evidence('memory', 'm-conf', 'the audit is open')]);
    const supported = assess(analysis, {
      claims: [{ text: 'the audit is open', evidence: ['ev:memory:m-conf'], kind: 'supported' }],
      answer: 'The audit is open.',
    });
    assert.equal(supported.verified, false);
    for (const entry of supported.trust.ladder) {
      assert.equal(typeof entry.ok, 'boolean');
      assert.equal(typeof entry.reason, 'string');
    }
    assert.equal(JSON.stringify(supported).includes('"confidence"'), false);
  });
});

// ---- §9 end-to-end handoff lifecycle -----------------------------------------------------------

describe('AP-08 §9 request -> proposal -> approval -> execution -> verification -> audit', () => {
  test('a model-proposed task cannot run before approval, then records that approval once', async () => {
    const dataDir = makeTempDataDir();
    dirs.push(dataDir);
    const sink = [];
    const app = createApp({
      dataDir,
      now: () => new Date(NOW),
      experienceCapture: CAPTURE_OFF,
      extraActions: makeFakeTaskActions(sink),
      gateway: makePlanGateway([taskStep('s1', 'test.ok', [], { tag: 'ap08-model-proposed' })]),
    });

    const proposed = await app.controller.planTask('do the whole thing for me');
    assert.equal(proposed.status, Outcome.PLAN_PROPOSED, proposed.display ?? proposed.output);
    assert.equal(proposed.task.origin, 'model');

    const refused = await app.controller.runTask(proposed.task.id);
    assert.equal(refused.status, Outcome.INPUT_REJECTED);
    assert.equal(refused.operation.handoff.state, HandoffState.DENIED);
    assert.equal(refused.operation.handoff.authorization.reason, 'TASK_APPROVAL_MISSING');
    assert.deepEqual(sink, [], 'a model proposal ran without the user');

    const approved = await app.controller.approveTask(proposed.task.id);
    assert.equal(approved.status, Outcome.SUCCESS_VERIFIED, approved.display);
    const task = await app.taskStore.get(proposed.task.id);
    assert.ok(task.approvedAt);

    const run = await app.controller.runTask(proposed.task.id);
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.output);
    assert.deepEqual(sink, ['ap08-model-proposed']);
    const handoff = run.operation.handoff;
    assert.equal(handoff.authorizes, false);
    assert.equal(handoff.authorization.owner, 'task_status');
    assert.equal(handoff.authorization.decision, 'allow');
    assert.equal(handoff.state, HandoffState.VERIFIED);
    assert.equal(handoff.verification.verified, 1);
    assert.equal(handoff.approval.scope, 'task_approval');
    assert.equal(handoff.approval.at, task.approvedAt);

    const stored = readJsonl(path.join(dataDir, 'operations.jsonl'));
    const crossings = stored.filter((op) => op.handoff?.kind === 'task_run');
    assert.equal(crossings.length, 2, 'the refused attempt and the approved run are both audited');
    assert.equal(crossings.filter((op) => op.handoff.authorization?.decision === 'allow').length, 1,
      'the approved run crossed once, not once per attempt');
    assert.equal(crossings.filter((op) => op.handoff.state === HandoffState.DENIED).length, 1,
      'the pre-approval refusal is recorded as denied');
  });
});

// ---- controller fixtures -----------------------------------------------------------------------

function captureBackend(text) {
  const calls = [];
  return {
    calls,
    backend: {
      name: 'cognition-capture',
      provider: 'cognition-capture',
      configured: true,
      describe: () => ({ configured: true, provider: 'cognition-capture', endpoint: 'synthetic', model: 'synthetic' }),
      health: async () => ({ available: true, detail: 'synthetic capture' }),
      complete: async (request) => {
        calls.push(request);
        return {
          ok: true,
          backend: 'cognition-capture',
          provider: 'cognition-capture',
          model: 'synthetic',
          text: typeof text === 'function' ? text(request, calls.length) : text,
          finishReason: 'stop',
          truncated: false,
          latencyMs: 0,
        };
      },
    },
  };
}

function stubGateway(text) {
  return new ModelGateway({ backend: captureBackend(text).backend });
}

function appWith(text) {
  const dataDir = makeTempDataDir();
  dirs.push(dataDir);
  const capture = captureBackend(text);
  const app = createApp({
    dataDir,
    gateway: new ModelGateway({ backend: capture.backend }),
    experienceCapture: CAPTURE_OFF,
    now: () => new Date(NOW),
  });
  return { app, dataDir, calls: capture.calls };
}

async function worldWrite(app, action, input) {
  const res = await app.controller.worldWrite(action, input);
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, JSON.stringify(res.operation?.errors ?? res));
  return res.operation.steps[0].result.data;
}

async function addEntity(app, id, name, extra = {}) {
  return worldWrite(app, 'world.entity.add', {
    id, category: 'project', name,
    evidence: [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }],
    ...extra,
  });
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}
