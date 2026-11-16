// T-02: competing hypotheses, contradiction explanations, and the facts/assumptions/unknowns ledger.
//
// Every fixture is deterministic and synthetic. No model is contacted. These tests pin the honesty
// rules of the reasoning layer: a disagreement produces more than one reading rather than a verdict,
// support is a fixed label rather than a probability, the only selection rule is observation over
// expectation, and a hypothesis record never authorizes anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRequest, analysisAudit } from '../src/cognition/engine.js';
import { extractClaims } from '../src/cognition/claims.js';
import { deliberate } from '../src/cognition/deliberation.js';
import {
  deriveHypotheses, hypothesisAudit, ExplanationKind, ReadingKind, SupportLevel,
} from '../src/cognition/hypotheses.js';
import { validateArtifact, ArtifactKind } from '../src/cognition/artifacts.js';
import { buildGroundingBrief } from '../src/cognition/response.js';
import { Disclosure } from '../src/cognition/vocabulary.js';

const NOW = new Date('2026-05-01T00:00:00.000Z');

function evidence(source, recordId, claim, extra = {}) {
  return {
    evidenceId: `ev:${source}:${recordId}`,
    source,
    recordId,
    type: extra.type ?? (source === 'memory' ? 'memory' : 'knowledge'),
    subject: null,
    claim,
    observedAt: null,
    recordedAt: extra.recordedAt ?? null,
    provenance: { origin: 'user', operationId: null, updateMode: null },
    status: extra.status ?? 'recorded',
    current: extra.current !== false,
    retrievalReason: 'test-fixture',
    relationships: { supports: [], contradicts: extra.contradicts ?? [] },
    contradicts: extra.contradicts ?? [],
  };
}

function claimSetOf(evidenceList, understanding = { missing: [] }) {
  return extractClaims({ evidence: evidenceList, understanding, conflicts: [] });
}

function retrievalOf(evidenceList, extra = {}) {
  return {
    evidence: evidenceList,
    byId: new Map(evidenceList.map((item) => [item.evidenceId, item])),
    sources: [],
    conflicts: [],
    counts: {
      total: evidenceList.length, dropped: 0, unavailable: [], damaged: [], ...extra,
    },
  };
}

function derive(evidenceList, {
  understanding = { missing: [] }, assumptions = [], counts = {},
} = {}) {
  const claims = claimSetOf(evidenceList, understanding);
  const retrieval = retrievalOf(evidenceList, counts);
  return {
    set: deriveHypotheses({ understanding, retrieval, claims: claims.claims, assumptions }),
    claims,
  };
}

test('two disagreeing records produce one reading each, and no reading is chosen', () => {
  const list = [
    evidence('memory', 'm-1', 'the audit is open', { contradicts: ['ev:knowledge:k-1'] }),
    evidence('knowledge', 'k-1', 'the audit is closed', {
      status: 'supported', contradicts: ['ev:memory:m-1'],
    }),
  ];
  const { set } = derive(list);

  assert.equal(set.schema, 'apex.hypotheses.v1');
  assert.equal(set.authorizes, false);
  assert.equal(set.hypotheses.length, 2);
  assert.ok(set.hypotheses.every((item) => item.kind === ReadingKind.RECORD_HOLDS));
  assert.ok(set.hypotheses.every((item) => item.support.level === SupportLevel.CONTRADICTED));
  assert.equal(set.counts.contested, 2);
  assert.equal(set.selection.chosen, null);
  assert.ok(set.selection.basis.includes('no_rule_selects_between_contested_records'));
  assert.ok(set.hypotheses.every((item) => item.chosen === false));

  const kinds = set.explanations.map((item) => item.kind);
  assert.ok(kinds.includes(ExplanationKind.SOURCE_DIVERGENCE), kinds.join(','));
  assert.ok(kinds.includes(ExplanationKind.UNEXPLAINED), kinds.join(','));
  assert.ok(set.explanations.every((item) => item.settles === false));
  assert.ok(!set.explanations.some((item) => item.explains), 'nothing in the metadata explains this pair');
});

test('a current and a historical record yield a time-scoped reading, not a winner', () => {
  const list = [
    evidence('memory', 'm-1', 'the audit is open', {
      recordedAt: '2026-04-09T00:00:00.000Z', contradicts: ['ev:memory:m-2'],
    }),
    evidence('memory', 'm-2', 'the audit is closed', {
      status: 'historical',
      current: false,
      recordedAt: '2026-04-01T00:00:00.000Z',
      contradicts: ['ev:memory:m-1'],
    }),
  ];
  const { set } = derive(list);
  const scoped = set.hypotheses.filter((item) => item.kind === ReadingKind.TIME_SCOPED);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].support.level, SupportLevel.PARTIAL);
  assert.ok(scoped[0].support.basis.includes('may_describe_different_periods'));
  assert.equal(set.selection.chosen, null);

  const timeScope = set.explanations.find((item) => item.kind === ExplanationKind.TIME_SCOPE_DIFFERS);
  assert.ok(timeScope, 'the current/historical split is named as a possible explanation');
  assert.equal(timeScope.explains, true);
  assert.equal(timeScope.settles, false);
  const later = set.explanations.find((item) => item.kind === ExplanationKind.RECORDED_LATER);
  assert.ok(later, 'a recording-order difference is reported when it exists');
  assert.equal(later.explains, false, 'a later recording is not offered as a resolution');
  assert.ok(!set.explanations.some((item) => item.kind === ExplanationKind.UNEXPLAINED));
});

test('an observation of an outcome is selected over an expectation, by one stated rule', () => {
  const list = [
    evidence('prediction', 'p-1', 'workspace.read: the user will open the workspace', {
      type: 'prediction', status: 'expectation',
    }),
    evidence('experience', 'x-1', 'opened the workspace [outcome success_verified, capability workspace.read]', {
      type: 'experience', status: 'observation',
    }),
  ];
  const { set } = derive(list);

  const observation = set.hypotheses.find((item) => item.kind === ReadingKind.OBSERVATION_REPORTS);
  const expectation = set.hypotheses.find((item) => item.kind === ReadingKind.EXPECTATION_REPORTS);
  assert.ok(observation && expectation);
  assert.equal(observation.support.level, SupportLevel.DIRECT);
  assert.equal(expectation.support.level, SupportLevel.UNSUPPORTED);
  assert.ok(expectation.support.basis.includes('an_expectation_is_not_evidence_of_its_outcome'));

  assert.equal(set.counts.selected, 1);
  assert.equal(set.selection.chosen, observation.id);
  assert.deepEqual(set.selection.basis, ['observation_of_an_outcome', 'an_expectation_is_not_evidence_of_its_outcome']);
  assert.equal(observation.chosen, true);
  assert.equal(expectation.chosen, false);

  const reason = set.explanations.find((item) => item.kind === ExplanationKind.EXPECTATION_NOT_OBSERVATION);
  assert.ok(reason);
  assert.equal(reason.explains, true);
  assert.equal(reason.settles, false);
});

test('the ledger separates cited facts, stated assumptions, and named unknowns', () => {
  const list = [
    evidence('memory', 'm-1', 'the audit is open'),
    evidence('temporal', 't-1', 'a pattern of recorded order', { type: 'temporal-pattern', status: 'inference' }),
  ];
  const { set } = derive(list, {
    understanding: { missing: [{ code: 'entity' }] },
    assumptions: [{ code: 'assumes_current_time' }],
    counts: { unavailable: ['audit'], damaged: ['memory'] },
  });

  assert.equal(set.reasoning.facts.length, 1);
  assert.equal(set.reasoning.facts[0].claimId, 'cl:1');
  assert.deepEqual(set.reasoning.facts[0].evidenceIds, ['ev:memory:m-1']);
  assert.deepEqual(set.reasoning.assumptions, [{ code: 'assumes_current_time' }]);

  const unknownKinds = set.reasoning.unknowns.map((item) => item.kind);
  assert.ok(unknownKinds.includes('missing_information'));
  assert.ok(unknownKinds.includes('unestablished_claim'));
  assert.ok(unknownKinds.includes('unread_source'));
  assert.deepEqual(set.reasoning.counts, {
    facts: 1, assumptions: 1, unknowns: set.reasoning.unknowns.length,
  });

  const audit = hypothesisAudit(set);
  assert.equal(audit.authorizes, false);
  assert.equal(audit.facts, 1);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes('the audit is open'), false, 'the audit never carries record text');
  assert.equal(serialized.includes('a pattern of recorded order'), false, 'the audit never carries claim text');
});

test('readings and explanations are bounded, and truncation is stated', () => {
  const list = [];
  for (let group = 0; group < 2; group += 1) {
    const ids = [1, 2, 3].map((n) => `g${group}-${n}`);
    for (const [index, id] of ids.entries()) {
      list.push(evidence('memory', id, `record ${id} stands`, {
        contradicts: ids.filter((other) => other !== id).map((other) => `ev:memory:${other}`),
      }));
      assert.ok(index < 3);
    }
  }
  const { set } = derive(list);
  assert.equal(set.hypotheses.length, 6);
  assert.equal(set.bounded, true);
  assert.ok(set.hypotheses.length <= 6);
  assert.ok(set.explanations.length <= 6);
});

test('derivation is deterministic for identical inputs', () => {
  const list = [
    evidence('memory', 'm-1', 'the audit is open', { contradicts: ['ev:memory:m-2'] }),
    evidence('memory', 'm-2', 'the audit is closed', { contradicts: ['ev:memory:m-1'] }),
  ];
  const first = derive(list).set;
  const second = derive(list).set;
  assert.deepEqual(second, first);
});

test('a real conflicting request keeps both sides and validates as an artifact', async () => {
  const request = 'what do you remember about the audit';
  const analysis = await analyzeRequest({
    request,
    now: NOW,
    seeds: {
      memoryHits: [
        { record: { id: 'm-1', content: 'the audit is open', createdAt: '2026-04-01T00:00:00.000Z', conflict: ['m-2'] } },
        { record: { id: 'm-2', content: 'the audit is closed', createdAt: '2026-04-02T00:00:00.000Z', conflict: ['m-1'] } },
      ],
    },
  });

  assert.equal(analysis.available, true, JSON.stringify(analysis.error ?? null));
  const hypotheses = analysis.deliberation.hypotheses;
  assert.ok(hypotheses, 'the real deliberation carries competing readings');
  assert.equal(hypotheses.counts.hypotheses, 2);
  assert.equal(hypotheses.selection.chosen, null);
  assert.ok(analysis.deliberation.disclosures.includes(Disclosure.COMPETING_READINGS_NOT_SETTLED));
  assert.ok(analysis.deliberation.disclosures.includes(Disclosure.CONFLICT_UNRESOLVED));

  const steps = analysis.deliberation.steps.map((step) => step.name);
  assert.ok(steps.includes('hypotheses'));
  assert.equal(steps.filter((name) => name === 'hypotheses').length, 1);

  assert.deepEqual(
    validateArtifact(ArtifactKind.DELIBERATION_RESULT, analysis.deliberation, {
      claimIds: analysis.claims.claims.map((claim) => claim.claimId),
    }).problems,
    [],
  );

  const tampered = structuredClone(analysis.deliberation);
  tampered.hypotheses.selection.chosen = tampered.hypotheses.hypotheses[0].id;
  assert.match(
    validateArtifact(ArtifactKind.DELIBERATION_RESULT, tampered).problems.join(' '),
    /selection names a reading not marked chosen/,
  );

  const brief = buildGroundingBrief(analysis);
  assert.match(brief.text, /Competing readings/);
  assert.match(brief.text, /none settled/);

  const audit = analysisAudit(analysis);
  assert.equal(audit.hypotheses.hypotheses, 2);
  assert.equal(audit.hypotheses.contested, 2);
  assert.equal(audit.hypotheses.selected, 0);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes('the audit is open'), false, 'the aggregate audit carries counts, not record text');
  assert.equal(serialized.includes('the audit is closed'), false, 'the aggregate audit carries counts, not record text');
});
