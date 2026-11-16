// Batch AJ: evidence normalization, claims, deliberation, uncertainty, response validation,
// the structured protocol, and the bounded reasoning trace.
//
// Every fixture here is deterministic and synthetic. No model is contacted; the structured responses
// are literal strings a model could have produced. These tests pin the layer's honesty rules: a
// contradiction is kept rather than resolved, uncertainty is qualitative, citations must exist, a
// confidence percentage never appears, and a rejected structure is rejected whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRequest } from '../src/cognition/engine.js';
import { retrieveEvidence } from '../src/cognition/evidence.js';
import { understandRequest } from '../src/cognition/request.js';
import { extractClaims, validateClaims } from '../src/cognition/claims.js';
import { deliberate } from '../src/cognition/deliberation.js';
import {
  buildGroundingBrief, validatePlainAnswer, validateStructuredResponse,
} from '../src/cognition/response.js';
import {
  extractCognitionLine, cognitionAudit, validateCognitionModelOutput,
} from '../src/cognition/protocol.js';
import { CognitionTrace } from '../src/cognition/trace.js';
import {
  BOUNDS, ClaimKind, DecisionKind, Disclosure, Intent, Uncertainty,
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
    retrievalReason: 'test-fixture',
    relationships: { supports: [], contradicts: [] },
    contradicts: extra.contradicts ?? [],
  };
}

function retrievalOf(evidenceList, extra = {}) {
  const byId = new Map(evidenceList.map((item) => [item.evidenceId, item]));
  return {
    evidence: evidenceList,
    byId,
    sources: [],
    conflicts: [],
    omitted: [],
    counts: { total: evidenceList.length, dropped: 0, unavailable: [], damaged: [], ...extra },
  };
}

function memoryHit(id, content, extra = {}) {
  return {
    record: {
      id, content, createdAt: '2026-04-01T00:00:00.000Z', ...extra,
    },
  };
}

function claimSetOf(evidenceList, understanding) {
  return extractClaims({ evidence: evidenceList, understanding, conflicts: [] });
}

function analysisOf(evidenceList, {
  uncertainty = null, disclosures = [], intent = Intent.GENERAL_QUESTION,
} = {}) {
  const retrieval = retrievalOf(evidenceList);
  return {
    understanding: { intent },
    retrieval,
    claims: claimSetOf(evidenceList, { intent }),
    deliberation: {
      decision: DecisionKind.ANSWER,
      conclusion: { kind: 'supported' },
      uncertainty: uncertainty ? { category: uncertainty, about: 'fact_truth', reason: 'fixture' } : null,
      disclosures,
      contradicting: [],
      missing: [],
      interpretations: [],
      assumptions: [],
      recommendation: null,
    },
  };
}

test('evidence from memory and knowledge is normalized with provenance and deterministic order', async () => {
  const understanding = understandRequest({ request: 'what do you remember about the audit?', now: NOW });
  const result = await retrieveEvidence({
    request: 'what do you remember about the audit?',
    understanding,
    now: NOW,
    seeds: {
      memoryHits: [memoryHit('m-2', 'the audit is closed'), memoryHit('m-1', 'the audit is open')],
      knowledge: [
        { id: 'k-2', subject: 'audit', relationship: 'owner', object: 'Nadia', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'k-1', subject: 'audit', relationship: 'owner', object: 'Bruno', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    },
  });
  const memory = result.evidence.filter((item) => item.source === 'memory');
  const knowledge = result.evidence.filter((item) => item.source === 'knowledge');
  assert.deepEqual(memory.map((item) => item.recordId), ['m-1', 'm-2']);
  assert.deepEqual(knowledge.map((item) => item.recordId), ['k-1', 'k-2']);
  assert.ok(result.evidence.every((item) => item.evidenceId && item.source && item.recordId));
  assert.ok(result.evidence.every((item) => item.provenance && typeof item.provenance === 'object'));
  assert.ok(result.evidence.every((item) => item.retrievalReason));
  assert.equal(result.byId.size, result.evidence.length);
});

test('private memory and credential-like copies stay out of evidence', async () => {
  const understanding = understandRequest({ request: 'what do you remember about the audit?', now: NOW });
  const result = await retrieveEvidence({
    request: 'what do you remember about the audit?',
    understanding,
    now: NOW,
    seeds: {
      memoryHits: [
        memoryHit('m-private', 'a private note', { sensitivity: 'private' }),
        memoryHit('m-public', 'a public note'),
      ],
    },
  });
  assert.equal(result.evidence.some((item) => item.recordId === 'm-private'), false);
  assert.equal(result.evidence.some((item) => item.recordId === 'm-public'), true);
});

test('retrieval is bounded per source and in total', async () => {
  const understanding = understandRequest({ request: 'what do you remember about the audit?', now: NOW });
  const memoryHits = Array.from({ length: 10 }, (_, i) => memoryHit(`m-${String(i).padStart(2, '0')}`, `note ${i}`));
  const knowledge = Array.from({ length: 40 }, (_, i) => ({
    id: `k-${String(i).padStart(2, '0')}`, subject: 'audit', relationship: 'field', object: `v${i}`,
  }));
  const result = await retrieveEvidence({ request: 'what do you remember about the audit?', understanding, now: NOW, seeds: { memoryHits, knowledge } });
  const memoryCount = result.evidence.filter((item) => item.source === 'memory').length;
  const knowledgeCount = result.evidence.filter((item) => item.source === 'knowledge').length;
  assert.ok(memoryCount <= BOUNDS.maxEvidencePerSource);
  assert.ok(knowledgeCount <= BOUNDS.maxEvidencePerSource);
  assert.ok(result.evidence.length <= BOUNDS.maxEvidenceTotal);
  assert.ok(result.counts.dropped >= 0);
});

test('an unavailable source is not reported as an empty one', async () => {
  const understanding = understandRequest({ request: 'what do you remember about the audit?', now: NOW });
  const base = { request: 'what do you remember about the audit?', understanding, now: NOW };
  const empty = await retrieveEvidence({ ...base, seeds: { knowledge: [] } });
  assert.equal(empty.sources.find((item) => item.source === 'knowledge').status, 'empty');
  assert.deepEqual(empty.counts.unavailable, []);

  const failed = await retrieveEvidence({ ...base, seeds: { knowledge: [], knowledgeUnavailable: true } });
  assert.equal(failed.sources.find((item) => item.source === 'knowledge').status, 'unavailable');
  assert.ok(failed.counts.unavailable.includes('knowledge'));

  const memoryFailed = await retrieveEvidence({ ...base, seeds: { memoryHits: [], memoryUnavailable: true } });
  assert.equal(memoryFailed.sources.find((item) => item.source === 'memory').status, 'unavailable');
});

test('claim kinds preserve what a record is: expectation, inference, observation, rule, and state', () => {
  const claims = extractClaims({
    evidence: [
      evidence('prediction', 'p-1', 'the deploy will succeed', { type: 'expectation', status: ClaimKind.EXPECTATION }),
      evidence('temporal', 't-1', 'a pattern of failures', { type: 'temporal-pattern', status: ClaimKind.INFERENCE }),
      evidence('experience', 'x-1', 'the last run succeeded', { status: 'success_verified' }),
      evidence('adaptation', 'a-1', 'put the date at the top', { type: 'adaptation', status: 'approved' }),
      evidence('goal', 'g-1', 'the goal is active', { status: ClaimKind.GOAL_STATE }),
      evidence('memory', 'm-1', 'an earlier model conclusion', { type: 'model_conclusion', status: 'recorded' }),
    ],
    understanding: { intent: Intent.GENERAL_QUESTION },
  });
  const bySource = new Map(claims.claims.map((claim) => [claim.source, claim]));
  assert.equal(bySource.get('prediction').kind, ClaimKind.EXPECTATION);
  assert.match(bySource.get('prediction').note, /not an observation/);
  assert.equal(bySource.get('temporal').kind, ClaimKind.INFERENCE);
  assert.match(bySource.get('temporal').note, /does not establish a cause/);
  assert.equal(bySource.get('experience').kind, ClaimKind.OBSERVATION);
  assert.equal(bySource.get('adaptation').kind, ClaimKind.RULE);
  assert.equal(bySource.get('adaptation').material, false, 'an approved rule is not a fact');
  assert.equal(bySource.get('goal').kind, ClaimKind.GOAL_STATE);
  assert.equal(bySource.get('memory').kind, ClaimKind.INFERENCE);
  assert.match(bySource.get('memory').note, /unverified/);
});

test('a stored disagreement links both claims symmetrically and resolves neither', () => {
  const facts = [
    evidence('world_fact', 'f-1', 'Atlas owner = Nadia', { status: ClaimKind.SUPPORTED, subject: { entityId: 'e-atlas' } }),
    evidence('world_fact', 'f-2', 'Atlas owner = Bruno', { status: ClaimKind.SUPPORTED, subject: { entityId: 'e-atlas' } }),
  ];
  const conflicts = [{
    id: 'c-1',
    subjectId: 'e-atlas',
    state: 'active',
    members: [{ id: 'f-1' }, { id: 'f-2' }],
  }];
  const claims = extractClaims({ evidence: facts, understanding: { intent: Intent.WORLD_MODEL }, conflicts });
  const first = claims.claims.find((claim) => claim.evidenceIds.includes('ev:world_fact:f-1'));
  const second = claims.claims.find((claim) => claim.evidenceIds.includes('ev:world_fact:f-2'));
  assert.equal(first.kind, ClaimKind.CONTRADICTED);
  assert.equal(second.kind, ClaimKind.CONTRADICTED);
  assert.ok(first.contradicts.includes(second.claimId));
  assert.ok(second.contradicts.includes(first.claimId));
  assert.equal(first.groupId, 'c-1');
});

test('duplicate records are kept but marked as one support group', () => {
  const claims = extractClaims({
    evidence: [
      evidence('memory', 'm-1', 'the report is late'),
      evidence('memory', 'm-2', 'the report is late'),
    ],
    understanding: { intent: Intent.STORED_INFORMATION },
  });
  assert.ok(claims.claims.every((claim) => claim.duplicateOf.length === 1));
});

test('a material claim that cites evidence outside the retrieval is a validation problem', () => {
  const claims = extractClaims({
    evidence: [evidence('memory', 'm-1', 'the report is late')],
    understanding: { intent: Intent.STORED_INFORMATION },
  });
  const result = validateClaims(claims.claims, new Map());
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /not in this retrieval/);
});

function deliberationFor({ request, evidenceList, understanding = null, continuation = null, counts = {} }) {
  const ask = understanding ?? understandRequest({ request, now: NOW });
  const retrieval = retrievalOf(evidenceList, counts);
  const claims = claimSetOf(evidenceList, ask);
  return {
    ask,
    claims,
    result: deliberate({ understanding: ask, retrieval, claims, continuation }),
  };
}

test('deliberation records the fourteen stated steps and links its conclusion to claims', () => {
  const evidenceList = [
    evidence('memory', 'm-1', 'Parcel Locker is operational', { subject: { entityId: 'e-locker', name: 'Parcel Locker' } }),
  ];
  const understanding = understandRequest({
    request: 'is Parcel Locker operational?',
    now: NOW,
    worldState: { entities: new Map([['e-locker', { id: 'e-locker', name: 'Parcel Locker', status: 'active', aliases: [] }]]) },
  });
  const { result } = deliberationFor({ request: 'is Parcel Locker operational?', evidenceList, understanding });
  assert.deepEqual(result.steps.map((step) => step.step), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual(result.steps.map((step) => step.name), [
    'question', 'subquestions', 'scope', 'supporting-evidence', 'contradicting-evidence',
    'missing-evidence', 'known-vs-inferred', 'interpretations', 'hypotheses', 'assumption',
    'clarification', 'proposed-conclusion', 'validation', 'decision',
  ]);
  assert.equal(result.decision, DecisionKind.ANSWER);
  assert.equal(result.conclusion.kind, 'supported');
  assert.ok(result.conclusion.claimIds.length >= 1);
  assert.ok(result.conclusion.evidenceIds.includes('ev:memory:m-1'));
  assert.ok(result.assumptions.some((item) => item.code === 'single-entity-name-match'));
});

test('an ambiguous reference asks for the single most useful clarification', () => {
  const understanding = understandRequest({
    request: 'what is the status of Project Atlas?',
    now: NOW,
    worldState: {
      entities: new Map([
        ['e-a', { id: 'e-a', name: 'Atlas', status: 'active', aliases: ['Project Atlas'] }],
        ['e-b', { id: 'e-b', name: 'Atlas Two', status: 'active', aliases: ['Project Atlas'] }],
      ]),
    },
  });
  const { result } = deliberationFor({ request: 'Project Atlas status', evidenceList: [], understanding });
  assert.equal(result.clarification.needed, true);
  assert.match(result.clarification.question, /Which entity do you mean\?/);
  assert.equal(result.decision, DecisionKind.CLARIFY);
  assert.equal(result.conclusion.kind, 'clarify');
  assert.ok(result.disclosures.includes(Disclosure.CLARIFICATION_REQUIRED));
});

test('an unsupported capability is refused, not answered', () => {
  const { result } = deliberationFor({ request: 'run a shell command to list files', evidenceList: [] });
  assert.equal(result.decision, DecisionKind.REFUSE);
  assert.equal(result.conclusion.kind, 'refuse');
  assert.equal(result.clarification.needed, false);
});

test('a goal without a success criterion asks for the criterion instead of inventing one', () => {
  const { result } = deliberationFor({ request: 'create a goal to get fit', evidenceList: [] });
  assert.equal(result.decision, DecisionKind.CLARIFY);
  assert.match(result.clarification.question, /success criterion/);
  assert.equal(result.clarification.missing, 'missing_goal_success_criteria');
});

test('nothing recorded is an unknown conclusion with a no-evidence disclosure', () => {
  const { result } = deliberationFor({ request: 'hello there', evidenceList: [] });
  assert.equal(result.conclusion.kind, 'unknown');
  assert.ok(result.disclosures.includes(Disclosure.NO_EVIDENCE));
  assert.equal(result.uncertainty.category, Uncertainty.UNKNOWN);
});

test('a disagreement produces a conflicting conclusion, never a chosen side', () => {
  const { result } = deliberationFor({
    request: 'who owns the audit?',
    evidenceList: [
      evidence('knowledge', 'k-1', 'audit owner Nadia', { status: ClaimKind.CONTRADICTED }),
      evidence('knowledge', 'k-2', 'audit owner Bruno', { status: ClaimKind.CONTRADICTED }),
    ],
  });
  assert.equal(result.conclusion.kind, 'conflicting');
  assert.equal(result.uncertainty.category, Uncertainty.CONFLICTING);
  assert.ok(result.disclosures.includes(Disclosure.CONFLICT_UNRESOLVED));
  assert.equal(result.conclusion.claimIds.length, 2);
});

test('uncertainty categories are qualitative and follow the stated rules', () => {
  const cases = [
    {
      label: 'one source',
      list: [evidence('memory', 'm-1', 'the report is late', { subject: { entityId: 'e-1' } })],
      expected: Uncertainty.SUPPORTED_INCOMPLETE,
    },
    {
      label: 'two sources on one subject',
      list: [
        evidence('memory', 'm-1', 'the report is late', { subject: { entityId: 'e-1' } }),
        evidence('knowledge', 'k-1', 'the report is late', { subject: { entityId: 'e-1' }, type: 'knowledge', status: ClaimKind.SUPPORTED }),
      ],
      expected: Uncertainty.STRONGLY_SUPPORTED,
    },
    {
      label: 'historical only',
      list: [evidence('world_fact', 'f-1', 'the owner was Nadia', { status: ClaimKind.HISTORICAL, current: false })],
      expected: Uncertainty.OUTDATED,
    },
    {
      label: 'unknown validity',
      list: [evidence('world_fact', 'f-1', 'the owner might be Nadia', { status: ClaimKind.UNKNOWN, type: 'fact' })],
      expected: Uncertainty.WEAKLY_SUPPORTED,
    },
    {
      label: 'inference only',
      list: [evidence('temporal', 't-1', 'a recorded pattern', { type: 'temporal-pattern', status: ClaimKind.INFERENCE })],
      expected: Uncertainty.INFERRED,
    },
  ];
  for (const item of cases) {
    const { result } = deliberationFor({ request: 'what is recorded?', evidenceList: item.list });
    assert.equal(result.uncertainty.category, item.expected, item.label);
    assert.equal(typeof result.uncertainty.reason, 'string');
    assert.equal('confidence' in result.uncertainty, false, `${item.label} must not carry a confidence number`);
  }

  const damaged = deliberationFor({
    request: 'what is recorded?',
    evidenceList: [evidence('memory', 'm-1', 'the report is late')],
    counts: { damaged: ['knowledge'] },
  });
  assert.equal(damaged.result.uncertainty.category, Uncertainty.UNVERIFIABLE);
  const unavailable = deliberationFor({
    request: 'what is recorded?',
    evidenceList: [evidence('memory', 'm-1', 'the report is late')],
    counts: { unavailable: ['knowledge'] },
  });
  assert.equal(unavailable.result.uncertainty.category, Uncertainty.UNVERIFIABLE);
});

test('a next-step recommendation is marked read-only and never executed', () => {
  const continuation = {
    candidates: [{
      kind: 'accept-goal',
      title: 'accept the goal',
      ready: true,
      reasons: ['suggestion only'],
      command: 'node bin/apex.js goal accept --target g-1',
      requiresAuthorization: true,
    }],
  };
  const understanding = understandRequest({ request: "what's next?", now: NOW });
  const { result } = deliberationFor({
    request: "what's next?",
    evidenceList: [evidence('goal', 'g-1', 'an accepted goal', { status: ClaimKind.GOAL_STATE })],
    understanding,
    continuation,
  });
  assert.equal(result.recommendation.executed, false);
  assert.equal(result.recommendation.requiresAuthorization, true);
  assert.match(result.recommendation.text, /accept the goal/);
  assert.ok(result.disclosures.includes(Disclosure.RECOMMENDATION_NOT_EXECUTED));
});

test('the grounding brief is bounded, cites evidence ids, and requires the unverified-model disclosure', async () => {
  const memoryHits = Array.from({ length: 8 }, (_, i) => memoryHit(`m-${i}`, `audit finding ${i} is closed`));
  const analysis = await analyzeRequest({
    request: 'what do you remember about the audit?',
    requestId: 'op-test',
    now: NOW,
    seeds: { memoryHits, knowledge: [] },
  });
  assert.equal(analysis.available, true);
  const brief = buildGroundingBrief(analysis, { forModelAnswer: true, maxLines: 5, maxChars: 500 });
  assert.ok(brief.lines.length <= 5);
  assert.ok(brief.chars <= 500);
  assert.ok(brief.omitted >= 1);
  assert.ok(brief.requiredDisclosures.includes(Disclosure.MODEL_OUTPUT_UNVERIFIED));
  assert.ok(brief.requiredDisclosures.includes(Disclosure.INFERENCE_MARKED) || brief.totalLines >= 3);
  const lineText = brief.lines.join('\n');
  assert.ok(/ev:memory:/.test(lineText) || brief.omitted > 0);
  assert.match(lineText, /APEX COGNITIVE GROUNDING/);
});

test('a structured response must cite this retrieval and may not claim more certainty', () => {
  const analysis = analysisOf(
    [evidence('memory', 'm-1', 'the report is late')],
    { uncertainty: Uncertainty.SUPPORTED_INCOMPLETE },
  );
  const id = 'ev:memory:m-1';
  const valid = validateStructuredResponse({
    schema: 1,
    decision: 'answer',
    answer: 'The stored record says the report is late.',
    claims: [{ text: 'the report is late', evidence: [id], kind: 'supported' }],
    disclosures: [],
  }, { analysis });
  assert.equal(valid.ok, true, valid.problems.join('; '));
  assert.equal(valid.value.recommendation, null);
  assert.ok(valid.value.disclosures.includes(Disclosure.MODEL_OUTPUT_UNVERIFIED));
  assert.equal(valid.repaired.uncertainty, true);

  const forged = validateStructuredResponse({
    schema: 1,
    decision: 'answer',
    answer: 'The stored record says the report is late.',
    claims: [{ text: 'the report is late', evidence: ['ev:memory:invented'], kind: 'supported' }],
  }, { analysis });
  assert.equal(forged.ok, false);
  assert.ok(forged.problems.some((problem) => /not in this retrieval/.test(problem)));

  const uncited = validateStructuredResponse({
    schema: 1,
    decision: 'answer',
    answer: 'The report is late.',
    claims: [{ text: 'the report is late', kind: 'supported' }],
  }, { analysis });
  assert.equal(uncited.ok, false);
  assert.ok(uncited.problems.some((problem) => /cites no evidence/.test(problem)));

  const overclaimed = validateStructuredResponse({
    schema: 1,
    decision: 'answer',
    answer: 'The report is late.',
    claims: [{ text: 'the report is late', evidence: [id], kind: 'supported' }],
    uncertainty: 'strongly_supported',
  }, { analysis });
  assert.equal(overclaimed.ok, false);
  assert.ok(overclaimed.problems.some((problem) => /more certainty/.test(problem)));

  const root = validateStructuredResponse({
    schema: 1,
    decision: 'answer',
    answer: 'The report is late.',
    authorization: true,
  }, { analysis });
  assert.equal(root.ok, false);
  assert.ok(root.problems.some((problem) => /authorization/.test(problem)));

  const executed = validateStructuredResponse({
    schema: 1,
    decision: 'answer',
    answer: 'The report is late.',
    recommendation: { text: 'store the fact', executed: true },
  }, { analysis });
  assert.equal(executed.ok, false);
  assert.ok(executed.problems.some((problem) => /never be marked executed/.test(problem)));

  const arbitraryCommand = validateStructuredResponse({
    schema: 1,
    decision: 'answer',
    answer: 'The report is late.',
    recommendation: { text: 'run a command', command: 'powershell -c whoami' },
  }, { analysis });
  assert.equal(arbitraryCommand.ok, false);
  assert.ok(arbitraryCommand.problems.some((problem) => /APEX CLI command/.test(problem)));

  const unknownCode = validateStructuredResponse({
    schema: 1,
    decision: 'answer',
    answer: 'The report is late.',
    disclosures: ['made_up_disclosure'],
  }, { analysis });
  assert.equal(unknownCode.ok, false);
});

test('a plain model answer is audited for forged citations and execution claims', () => {
  const analysis = analysisOf([evidence('memory', 'm-1', 'the report is late')]);
  assert.equal(validatePlainAnswer('The report is late [ev:memory:m-1].', analysis).ok, true);
  const forged = validatePlainAnswer('The report is late [ev:memory:made-up].', analysis);
  assert.equal(forged.ok, false);
  assert.match(forged.problems[0], /not in this retrieval/);
  const executed = validatePlainAnswer('I executed memory.add and the report is stored.', analysis);
  assert.equal(executed.ok, false);
});

test('the structured protocol accepts one line, strips it from prose, and rejects malformed input', () => {
  const analysis = analysisOf([evidence('memory', 'm-1', 'the report is late')]);
  const structure = { schema: 1, decision: 'answer', answer: 'The report is late.' };
  const line = `The prose answer.\nCOGNITION ${JSON.stringify(structure)}`;
  const ok = validateCognitionModelOutput(line, analysis);
  assert.equal(ok.found, true);
  assert.equal(ok.error, null);
  assert.equal(ok.structure.decision, 'answer');
  assert.equal(ok.text, 'The prose answer.', 'raw JSON never reaches the user as prose');

  const twoLines = `one\nCOGNITION ${JSON.stringify(structure)}\nCOGNITION ${JSON.stringify(structure)}`;
  assert.equal(extractCognitionLine(twoLines).error.code, 'MULTIPLE_STRUCTURES');
  assert.equal(extractCognitionLine('COGNITION').error.code, 'EMPTY_STRUCTURE');
  assert.equal(extractCognitionLine('COGNITION {not json').error.code, 'MALFORMED_JSON');
  assert.equal(extractCognitionLine('COGNITION [1,2]').error.code, 'NOT_AN_OBJECT');
  assert.equal(extractCognitionLine(`COGNITION ${'x'.repeat(16001)}`).error.code, 'STRUCTURE_TOO_LARGE');
  const plain = extractCognitionLine('just prose');
  assert.equal(plain.found, false);
  assert.equal(plain.text, 'just prose');
});

test('the structured audit carries counts and codes, never answer text', () => {
  const structure = {
    schema: 1,
    decision: 'answer',
    answer: 'a sensitive answer sentence',
    claims: [{ text: 'a sensitive claim', evidence: ['ev:memory:m-1'], kind: 'supported' }],
    disclosures: [Disclosure.MODEL_OUTPUT_UNVERIFIED],
    uncertainty: Uncertainty.SUPPORTED_INCOMPLETE,
    missing: [],
    recommendation: null,
  };
  // The audit is built from the validated value, not the model's raw JSON: citation counts come from
  // the evidence ids the validation kept, so an audit can never report a count the validator rejected.
  const validation = validateStructuredResponse(structure, {
    analysis: analysisOf([evidence('memory', 'm-1', 'the audit is open')]),
  });
  assert.equal(validation.ok, true);
  const audit = cognitionAudit(validation.value, validation);
  const text = JSON.stringify(audit);
  assert.equal(text.includes('sensitive'), false);
  assert.equal(audit.decision, 'answer');
  assert.equal(audit.claims, 1);
  assert.equal(audit.citedEvidence, 1);
  assert.equal(audit.recommendationExecuted, false);
});

test('the reasoning trace is bounded and stores identifiers, not content', () => {
  const trace = new CognitionTrace({ requestId: 'op-1', intent: Intent.WORLD_MODEL });
  for (let i = 0; i < 20; i += 1) trace.stage(`stage-${i}`);
  trace.stage('stage-0');
  trace.evidence(Array.from({ length: 70 }, (_, i) => ({
    evidenceId: `ev:memory:m-${i}`, source: 'memory', type: 'memory', recordId: `m-${i}`,
  })));
  for (let i = 0; i < 10; i += 1) trace.assumption(`assumption-${i}`);
  for (let i = 0; i < 10; i += 1) trace.subquestion({ code: `q-${i}`, answerable: true });
  for (let i = 0; i < 30; i += 1) trace.conclusion({ claimId: `cl-${i}`, kind: 'supported', evidenceIds: ['ev:memory:m-0'] });
  for (let i = 0; i < 20; i += 1) trace.excluded('memory', `reason-${i}`);
  trace.conflict({ id: 'c-1', state: 'active', members: ['f-1', 'f-2'] });
  trace.assumption('a secret memory sentence');
  const audit = trace.toAudit();
  assert.equal(audit.stages.length, BOUNDS.maxTraceStages);
  assert.equal(audit.evidence.length, BOUNDS.maxTraceEvidence);
  assert.equal(audit.assumptions.length, BOUNDS.maxAssumptions);
  assert.equal(audit.subquestions.length, BOUNDS.maxSubquestions);
  assert.equal(audit.conclusions.length, BOUNDS.maxClaims);
  assert.equal(audit.conflicts.length, 1);
  assert.equal(audit.bounds.truncated, true);
  const text = JSON.stringify(audit);
  assert.equal(text.includes('a secret memory sentence'), false, 'trace content must stay identifiers only');
  assert.ok(text.includes('ev:memory:m-0'));
});

test('the engine degrades to an explicit unavailable analysis instead of throwing', async () => {
  const broken = { toString() { throw new Error('unreadable request'); } };
  const result = await analyzeRequest({ request: broken, requestId: 'op-bad', now: NOW });
  assert.equal(result.available, false);
  assert.equal(result.error.code, 'COGNITION_ERROR');
  assert.equal(result.brief, null);
});

test('the engine runs every stage over the seeds it is given', async () => {
  const analysis = await analyzeRequest({
    request: 'what do you remember about the audit?',
    requestId: 'op-ok',
    now: NOW,
    seeds: {
      memoryHits: [memoryHit('m-1', 'the audit is closed')],
      knowledge: [{ id: 'k-1', subject: 'audit', relationship: 'owner', object: 'Nadia' }],
    },
  });
  assert.equal(analysis.available, true);
  assert.ok(analysis.retrieval.counts.total >= 2);
  assert.ok(analysis.claims.counts.total >= 1);
  assert.equal(analysis.deliberation.decision, DecisionKind.ANSWER);
  assert.ok(analysis.brief.lines.length > 0);
  assert.deepEqual(
    analysis.audit.stages.map((stage) => stage.name),
    ['request', 'objective', 'retrieval', 'claims', 'deliberation', 'response'],
  );
  assert.ok(Object.values(analysis.timings).every((value) => Number.isFinite(value)));
});
