// Batch AP-09: semantic grounding, claim consistency, and adversarial response verification.
//
// Every fixture here is deterministic: synthetic records, fixed claim strings, and the same retrieval
// map the response pipeline builds. No model is contacted and no inference is started. The suite
// exercises the closed finding vocabulary, the precedence order, each supported dimension, the
// response-level contradiction pass, all twenty-eight §8 attack classes, the AP-07 read window, and
// the bounded audit. Expected values are APEX's own rule outcomes, not judgements about prose quality.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEMANTIC_AUTHORITY,
  SEMANTIC_DIMENSIONS,
  SEMANTIC_FINDINGS,
  SEMANTIC_PRECEDENCE,
  SEMANTIC_SCHEMA,
  SemanticDimension,
  SemanticDimensionStatus,
  SemanticFinding,
  assessClaimSemantics,
  assessResponseConsistency,
  contentTokens,
} from '../src/cognition/semantic-consistency.js';
import {
  ResponseDegradation,
  ResponseTrustState,
  assessResponseIntegrity,
  responseIntegrityAudit,
  semanticNotice,
} from '../src/cognition/response-integrity.js';
import { validateStructuredResponse } from '../src/cognition/response.js';
import { extractClaims } from '../src/cognition/claims.js';
import { EvidenceState, EvidenceValidity } from '../src/cognition/vocabulary.js';

// ---- fixtures ----------------------------------------------------------------------------------

function evidence(recordId, claim, extra = {}) {
  return {
    evidenceId: `ev:memory:${recordId}`,
    source: 'memory',
    recordId,
    type: 'memory',
    subject: null,
    claim,
    observedAt: null,
    recordedAt: null,
    provenance: { origin: 'user', operationId: null, updateMode: null },
    status: extra.status ?? 'recorded',
    current: extra.current !== false,
    ...(extra.validity ? { validity: extra.validity } : {}),
    retrievalReason: 'ap09-fixture',
    relationships: { supports: [], contradicts: [] },
    contradicts: [],
  };
}

function byId(list) {
  return new Map(list.map((item) => [item.evidenceId, item]));
}

function assess(records, text, extra = {}) {
  return assessClaimSemantics({
    text,
    evidenceIds: records.map((item) => item.evidenceId),
    evidenceById: byId(records),
    kind: extra.kind ?? 'supported',
    evidenceState: extra.evidenceState ?? null,
    read: extra.read ?? { state: 'complete', complete: true },
  });
}

function analysisFor(records, extra = {}) {
  return {
    available: true,
    retrieval: {
      evidence: records,
      byId: byId(records),
      conflicts: [],
      omitted: [],
      read: extra.read ?? { state: 'complete', complete: true },
      sources: [{ source: 'memory', status: 'ok' }],
      counts: { total: records.length, dropped: 0, unavailable: [], damaged: [] },
    },
    claims: extractClaims({ evidence: records, conflicts: [] }),
    deliberation: { decision: 'answer', uncertainty: null, disclosures: [], missing: [] },
  };
}

function checked(analysis, claims, answer = 'A grounded answer.') {
  const validation = validateStructuredResponse({ schema: 1, decision: 'answer', answer, claims }, { analysis });
  return {
    validation,
    check: validation.ok
      ? { found: true, structure: validation.value, error: null, validation }
      : { found: true, structure: null, error: { code: 'INVALID_STRUCTURE' }, validation },
  };
}

function integrityFor(records, claimText, extra = {}) {
  const analysis = analysisFor(records, extra);
  const { check } = checked(analysis, [{
    text: claimText, evidence: records.map((item) => item.evidenceId), kind: 'supported',
  }], claimText);
  return assessResponseIntegrity({ analysis, text: claimText, check });
}

// ---- the closed vocabulary ---------------------------------------------------------------------

describe('AP-09 §5 closed semantic vocabulary', () => {
  test('exactly thirteen findings are defined, in a fixed order', () => {
    assert.equal(SEMANTIC_SCHEMA, 1);
    assert.deepEqual(SEMANTIC_FINDINGS, [
      'semantically_consistent',
      'partially_consistent',
      'polarity_conflict',
      'numerical_conflict',
      'temporal_conflict',
      'entity_conflict',
      'relationship_conflict',
      'qualifier_conflict',
      'unsupported_transformation',
      'ambiguous',
      'insufficient_evidence',
      'unavailable',
      'not_checked',
    ]);
    for (const finding of SEMANTIC_FINDINGS) {
      assert.equal(typeof finding, 'string');
      assert.match(finding, /^[a-z][a-z0-9_]+$/);
    }
  });

  test('precedence is a total order over the same thirteen findings', () => {
    assert.deepEqual([...SEMANTIC_PRECEDENCE].sort(), [...SEMANTIC_FINDINGS].sort());
    assert.equal(SEMANTIC_PRECEDENCE.length, 13);
    assert.equal(SEMANTIC_PRECEDENCE[0], SemanticFinding.UNAVAILABLE);
    assert.equal(SEMANTIC_PRECEDENCE.at(-1), SemanticFinding.SEMANTICALLY_CONSISTENT);
    // Every conflict outranks ambiguity, every ambiguity outranks partial, partial outranks consistent.
    const index = (finding) => SEMANTIC_PRECEDENCE.indexOf(finding);
    for (const conflict of [
      SemanticFinding.POLARITY_CONFLICT, SemanticFinding.NUMERICAL_CONFLICT,
      SemanticFinding.TEMPORAL_CONFLICT, SemanticFinding.ENTITY_CONFLICT,
      SemanticFinding.RELATIONSHIP_CONFLICT, SemanticFinding.QUALIFIER_CONFLICT,
      SemanticFinding.UNSUPPORTED_TRANSFORMATION,
    ]) {
      assert.ok(index(conflict) < index(SemanticFinding.AMBIGUOUS), `${conflict} before ambiguous`);
      assert.ok(index(conflict) < index(SemanticFinding.PARTIALLY_CONSISTENT), `${conflict} before partial`);
      assert.ok(index(conflict) < index(SemanticFinding.SEMANTICALLY_CONSISTENT), `${conflict} before consistent`);
    }
    assert.ok(index(SemanticFinding.INSUFFICIENT_EVIDENCE) < index(SemanticFinding.POLARITY_CONFLICT));
    assert.ok(index(SemanticFinding.AMBIGUOUS) < index(SemanticFinding.PARTIALLY_CONSISTENT));
    assert.ok(index(SemanticFinding.PARTIALLY_CONSISTENT) < index(SemanticFinding.SEMANTICALLY_CONSISTENT));
  });

  test('eight dimensions and six per-dimension statuses are the whole surface', () => {
    assert.deepEqual(SEMANTIC_DIMENSIONS, [
      'attribution', 'polarity', 'numerical', 'temporal', 'entity', 'relationship', 'qualifier',
      'transformation',
    ]);
    assert.deepEqual(Object.values(SemanticDimensionStatus), [
      'checked', 'conflict', 'ambiguous', 'not_applicable', 'not_checked', 'unavailable',
    ]);
    assert.equal(SemanticDimension.ATTRIBUTION, 'attribution');
  });

  test('the module declares no factual authority and no confidence', () => {
    assert.equal(SEMANTIC_AUTHORITY.authorizes, false);
    assert.equal(SEMANTIC_AUTHORITY.factualAuthority, 'none');
    const result = assess([evidence('m1', 'the lighthouse status is green')], 'the lighthouse status is green');
    assert.equal(result.authorizes, false);
    assert.equal(result.schema, SEMANTIC_SCHEMA);
    assert.deepEqual(Object.keys(result).sort(), [
      'ambiguous', 'authorizes', 'bounded', 'cited', 'claimTokens', 'dimensions', 'evidenceState',
      'finding', 'missing', 'partialAttribution', 'readable', 'reason', 'schema', 'sharedTokens',
    ]);
    for (const key of Object.keys(result)) {
      assert.doesNotMatch(key, /confid|probab|score|truth/i);
    }
    assert.equal('verified' in result, false);
    assert.equal(SEMANTIC_FINDINGS.includes('verified'), false);
  });
});

// ---- A. negation and polarity ------------------------------------------------------------------

describe('AP-09 §4A negation and polarity', () => {
  test('a reversed negation conflicts even though almost every word is shared', () => {
    const result = assess([evidence('m1', 'The operation succeeded.')], 'The operation did not succeed.');
    assert.equal(result.finding, SemanticFinding.POLARITY_CONFLICT);
    assert.equal(result.dimensions.polarity, SemanticDimensionStatus.CONFLICT);
    assert.equal(result.reason, 'a shared predicate has opposite polarity in the claim and the cited records');
  });

  test('an unrelated "not" in another clause is not treated as a reversal', () => {
    const result = assess(
      [evidence('m1', 'The report is ready.')],
      'The report is ready, but the server is not running.',
    );
    assert.notEqual(result.finding, SemanticFinding.POLARITY_CONFLICT);
    assert.equal(result.dimensions.polarity, SemanticDimensionStatus.CHECKED);
  });

  test('negation whose scope cannot be scoped is ambiguous, never negated', () => {
    const result = assess([evidence('m1', 'All tests passed.')], 'Not all tests passed.');
    assert.equal(result.finding, SemanticFinding.AMBIGUOUS);
    assert.equal(result.ambiguous, true);
    assert.equal(result.dimensions.polarity, SemanticDimensionStatus.AMBIGUOUS);
  });

  test('a predicate direction reversal conflicts when no quantity is present', () => {
    const result = assess([evidence('m1', 'Latency is higher than before.')], 'Latency is lower than before.');
    assert.equal(result.finding, SemanticFinding.POLARITY_CONFLICT);
  });

  test('the same polarity is checked and consistent', () => {
    const result = assess([evidence('m1', 'the lighthouse status is green')], 'the lighthouse status is green');
    assert.equal(result.finding, SemanticFinding.SEMANTICALLY_CONSISTENT);
    assert.equal(result.dimensions.polarity, SemanticDimensionStatus.CHECKED);
  });

  test('polarity outranks a simultaneous numerical conflict', () => {
    const result = assess([evidence('m1', 'Revenue increased by 10%.')], 'Revenue did not increase by 90%.');
    assert.equal(result.dimensions.polarity, SemanticDimensionStatus.CONFLICT);
    assert.equal(result.dimensions.numerical, SemanticDimensionStatus.CONFLICT);
    assert.equal(result.finding, SemanticFinding.POLARITY_CONFLICT);
  });
});

// ---- B. numerical ------------------------------------------------------------------------------

describe('AP-09 §4B numerical consistency', () => {
  test('a changed magnitude conflicts', () => {
    const result = assess(
      [evidence('m1', 'The archive retention window is 30 days.')],
      'The archive retention window is 90 days.',
    );
    assert.equal(result.finding, SemanticFinding.NUMERICAL_CONFLICT);
    assert.equal(result.reason, 'the claim states a different quantity from the cited records');
  });

  test('a reversed change of sign conflicts', () => {
    const result = assess([evidence('m1', 'Revenue increased by 10%.')], 'Revenue decreased by 10%.');
    assert.equal(result.finding, SemanticFinding.NUMERICAL_CONFLICT);
  });

  test('the same magnitude in a different unit conflicts and is never converted', () => {
    const result = assess(
      [evidence('m1', 'The request timeout is 30 seconds.')],
      'The request timeout is 30 minutes.',
    );
    assert.equal(result.finding, SemanticFinding.NUMERICAL_CONFLICT);
    assert.equal(result.reason, 'the claim states the same magnitude in a different unit');
    const converted = assess(
      [evidence('m1', 'The request timeout is 30 seconds.')],
      'The request timeout is 0.5 minutes.',
    );
    assert.equal(converted.finding, SemanticFinding.NUMERICAL_CONFLICT, 'no unit conversion is inferred');
  });

  test('a bound stated as an exact value, or a reversed inequality, conflicts', () => {
    const exact = assess([evidence('m1', 'At least 3 tests failed.')], '3 tests failed.');
    assert.equal(exact.finding, SemanticFinding.NUMERICAL_CONFLICT);
    const reversed = assess([evidence('m1', 'The queue holds more than 10 items.')], 'The queue holds fewer than 10 items.');
    assert.equal(reversed.finding, SemanticFinding.NUMERICAL_CONFLICT);
    assert.equal(reversed.reason, 'the claim changes a bound into an exact value or reverses the comparison');
  });

  test('a value inside a recorded range is compatible; outside it conflicts', () => {
    const inside = assess([evidence('m1', 'The batch contains 20 to 30 items.')], 'The batch contains 25 items.');
    assert.equal(inside.finding, SemanticFinding.SEMANTICALLY_CONSISTENT);
    const outside = assess([evidence('m1', 'The batch contains 20 to 30 items.')], 'The batch contains 40 items.');
    assert.equal(outside.finding, SemanticFinding.NUMERICAL_CONFLICT);
  });

  test('a missing value is reported as omission, an added value as conflict', () => {
    const omitted = assess([evidence('m1', 'The archive retention window is 30 days.')], 'The archive retention window is long.');
    assert.equal(omitted.finding, SemanticFinding.PARTIALLY_CONSISTENT);
    assert.equal(omitted.reason, 'the cited records state a value or date the claim omits');
    const added = assess(
      [evidence('m1', 'The archive retention window is 30 days.')],
      'The archive retention window is 30 days and the timeout is 60 seconds.',
    );
    assert.equal(added.finding, SemanticFinding.NUMERICAL_CONFLICT);
  });
});

// ---- C. temporal -------------------------------------------------------------------------------

describe('AP-09 §4C temporal consistency', () => {
  test('a substituted weekday conflicts', () => {
    const result = assess([evidence('m1', 'The backup completed on Monday.')], 'The backup completed on Tuesday.');
    assert.equal(result.finding, SemanticFinding.TEMPORAL_CONFLICT);
    assert.equal(result.reason, 'the claim states a different date or period from the cited records');
  });

  test('a substituted ISO date conflicts', () => {
    const result = assess([evidence('m1', 'The release shipped on 2026-04-01.')], 'The release shipped on 2026-04-02.');
    assert.equal(result.finding, SemanticFinding.TEMPORAL_CONFLICT);
  });

  test('reversed event order conflicts', () => {
    const result = assess([evidence('m1', 'The deploy completed after the tests.')], 'The deploy completed before the tests.');
    assert.equal(result.finding, SemanticFinding.TEMPORAL_CONFLICT);
    assert.equal(result.reason, 'the claim reverses the order of two events recorded in the cited records');
  });

  test('a date the record never states is an unsupported transformation, not a fact', () => {
    const result = assess([evidence('m1', 'The backup completed successfully.')], 'The backup completed successfully on Monday.');
    assert.equal(result.finding, SemanticFinding.UNSUPPORTED_TRANSFORMATION);
    assert.equal(result.dimensions.temporal, SemanticDimensionStatus.CONFLICT);
  });

  test('a stale record cannot support a current claim, but a historical claim may cite it', () => {
    const stale = evidence('m1', 'The lighthouse is green.', { current: false });
    const current = assess([stale], 'The lighthouse is green.');
    assert.equal(current.finding, SemanticFinding.INSUFFICIENT_EVIDENCE);
    assert.equal(current.reason, 'a cited record describes a past state and the claim is not marked historical');
    const historical = assess([stale], 'The lighthouse is green.', { kind: 'historical' });
    assert.equal(historical.finding, SemanticFinding.SEMANTICALLY_CONSISTENT);
  });
});

// ---- D. entity and relationship ----------------------------------------------------------------

describe('AP-09 §4D entity and relationship consistency', () => {
  test('a substituted entity conflicts', () => {
    const result = assess([evidence('m1', 'Atlas owner = Nadia')], 'Atlas owner = Bruno');
    assert.equal(result.finding, SemanticFinding.ENTITY_CONFLICT);
    assert.equal(result.reason, 'the claim names an entity the cited records do not');
  });

  test('a similar name is not the same entity', () => {
    const result = assess([evidence('m1', 'Atlas-One is the active deployment.')], 'Atlas-Two is the active deployment.');
    assert.equal(result.finding, SemanticFinding.ENTITY_CONFLICT);
  });

  test('a swapped subject and object conflicts', () => {
    const result = assess([evidence('m1', 'Atlas owns the lighthouse.')], 'The lighthouse owns Atlas.');
    assert.equal(result.finding, SemanticFinding.RELATIONSHIP_CONFLICT);
    assert.equal(result.reason, 'the claim reverses a relationship recorded in the cited records');
  });

  test('a passive inversion conflicts', () => {
    const result = assess([evidence('m1', 'The Pilot manages the Archive.')], 'The Pilot is managed by the Archive.');
    assert.equal(result.finding, SemanticFinding.RELATIONSHIP_CONFLICT);
  });

  test('the same relationship in the same direction is consistent', () => {
    const result = assess([evidence('m1', 'The pilot manages the archive.')], 'The pilot manages the archive.');
    assert.equal(result.finding, SemanticFinding.SEMANTICALLY_CONSISTENT);
    assert.equal(result.dimensions.relationship, SemanticDimensionStatus.CHECKED);
  });
});

// ---- E. comparative and categorical ------------------------------------------------------------

describe('AP-09 §4E comparative and categorical consistency', () => {
  test('all becoming some conflicts', () => {
    const result = assess([evidence('m1', 'All tests passed.')], 'Some tests passed.');
    assert.equal(result.finding, SemanticFinding.QUALIFIER_CONFLICT);
    assert.equal(result.reason, 'the claim changes a quantifier stated by the cited records');
  });

  test('some becoming all conflicts', () => {
    const result = assess([evidence('m1', 'Some tests passed.')], 'All tests passed.');
    assert.equal(result.finding, SemanticFinding.QUALIFIER_CONFLICT);
  });

  test('possible becoming confirmed conflicts', () => {
    const result = assess([evidence('m1', 'The release is possibly delayed.')], 'The release is confirmed delayed.');
    assert.equal(result.finding, SemanticFinding.QUALIFIER_CONFLICT);
    assert.equal(result.reason, 'the claim states more certainty than the cited records support');
  });

  test('dropping a hedge conflicts even when the claim states no certainty word', () => {
    const result = assess([evidence('m1', 'The release is possibly delayed.')], 'The release is delayed.');
    assert.equal(result.finding, SemanticFinding.QUALIFIER_CONFLICT);
    assert.equal(result.reason, 'the claim states more certainty than the cited records support');
  });

  test('preserved qualifiers stay consistent', () => {
    const result = assess([evidence('m1', 'The release is possibly delayed.')], 'The release is possibly delayed.');
    assert.equal(result.finding, SemanticFinding.SEMANTICALLY_CONSISTENT);
    assert.equal(result.dimensions.qualifier, SemanticDimensionStatus.CHECKED);
  });
});

// ---- F. attribution integrity ------------------------------------------------------------------

describe('AP-09 §4F attribution integrity', () => {
  test('a fabricated citation is disclosed as partial attribution, never as support', () => {
    const result = assessClaimSemantics({
      text: 'The operation succeeded.',
      evidenceIds: ['ev:memory:ghost'],
      evidenceById: byId([]),
      kind: 'supported',
    });
    assert.equal(result.finding, SemanticFinding.INSUFFICIENT_EVIDENCE);
    assert.equal(result.reason, 'a cited record is not in this retrieval');
    assert.equal(result.partialAttribution, true);
    assert.equal(result.missing, 1);
    assert.equal(result.dimensions.attribution, SemanticDimensionStatus.CONFLICT);
  });

  test('one valid and one fabricated citation still discloses the invalid one', () => {
    const valid = evidence('m1', 'The operation succeeded.');
    const result = assessClaimSemantics({
      text: 'The operation succeeded.',
      evidenceIds: ['ev:memory:m1', 'ev:memory:ghost'],
      evidenceById: byId([valid]),
      kind: 'supported',
    });
    assert.equal(result.finding, SemanticFinding.INSUFFICIENT_EVIDENCE);
    assert.equal(result.partialAttribution, true);
    assert.equal(result.readable, 1);
    assert.equal(result.missing, 1);
  });

  test('retracted and superseded records cannot support a claim', () => {
    for (const [label, record] of [
      ['retracted', evidence('m1', 'The operation succeeded.', { status: 'retracted' })],
      ['superseded', evidence('m1', 'The operation succeeded.', { validity: EvidenceValidity.SUPERSEDED })],
    ]) {
      const result = assess([record], 'The operation succeeded.');
      assert.equal(result.finding, SemanticFinding.INSUFFICIENT_EVIDENCE, label);
      assert.equal(result.reason, 'a cited record was retracted or replaced and no longer stands', label);
      assert.equal(result.dimensions.attribution, SemanticDimensionStatus.CONFLICT, label);
    }
  });

  test('a contested evidence state cannot support a claim', () => {
    const result = assess(
      [evidence('m1', 'The lighthouse is green.')],
      'The lighthouse is green.',
      { evidenceState: EvidenceState.CONFLICTING },
    );
    assert.equal(result.finding, SemanticFinding.INSUFFICIENT_EVIDENCE);
    assert.equal(result.reason, 'a cited record is contested or unverified');
  });

  test('an unreadable record is unavailable, not empty support', () => {
    const result = assessClaimSemantics({
      text: 'The lighthouse is green.',
      evidenceIds: ['ev:memory:bad'],
      evidenceById: byId([evidence('bad', '')]),
      kind: 'supported',
    });
    assert.equal(result.finding, SemanticFinding.UNAVAILABLE);
    assert.equal(result.reason, 'a cited record has no readable statement');
    assert.equal(result.dimensions.attribution, SemanticDimensionStatus.UNAVAILABLE);
  });

  test('a relevant-looking record that does not restate the claim is insufficient', () => {
    const result = assess([evidence('m1', 'The lighthouse status is green.')], 'The quarterly budget was approved.');
    assert.equal(result.finding, SemanticFinding.INSUFFICIENT_EVIDENCE);
    assert.equal(result.reason, 'the claim does not restate the cited records closely enough to check its meaning');
  });

  test('a model cannot submit its own evidence state, semantic result, or verification', () => {
    const record = evidence('m1', 'The operation succeeded.');
    const analysis = analysisFor([record]);
    for (const [label, claim] of [
      ['verified', { text: 'The operation succeeded.', kind: 'supported', evidence: ['ev:memory:m1'], verified: true }],
      ['authorized', { text: 'The operation succeeded.', kind: 'supported', evidence: ['ev:memory:m1'], authorized: true }],
      ['semantic', { text: 'The operation succeeded.', kind: 'supported', evidence: ['ev:memory:m1'], semantic: { finding: 'semantically_consistent' } }],
      ['evidenceState', { text: 'The operation succeeded.', kind: 'supported', evidence: ['ev:memory:m1'], evidenceState: 'directly_supported' }],
    ]) {
      const result = validateStructuredResponse(
        { schema: 1, decision: 'answer', answer: 'The operation succeeded.', claims: [claim] },
        { analysis },
      );
      assert.equal(result.ok, false, label);
      assert.ok(result.problems.length > 0, label);
    }
  });

  test('a forged structure field is re-derived from records, not trusted', () => {
    const record = evidence('m1', 'The operation succeeded.');
    const analysis = analysisFor([record]);
    const forged = {
      found: true,
      structure: {
        schema: 1,
        decision: 'answer',
        answer: 'The operation did not succeed.',
        claims: [{
          text: 'The operation did not succeed.',
          kind: 'supported',
          evidenceIds: ['ev:memory:m1'],
          attribution: 'attributed',
          evidenceState: EvidenceState.DIRECTLY_SUPPORTED,
          semantic: { finding: SemanticFinding.SEMANTICALLY_CONSISTENT },
        }],
      },
      error: null,
    };
    const result = assessResponseIntegrity({ analysis, text: 'The operation did not succeed.', check: forged });
    assert.equal(result.trust.claims[0].semantic.finding, SemanticFinding.POLARITY_CONFLICT);
    assert.equal(result.trust.state, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.equal(result.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
    assert.ok(result.limitations.includes('semantic_polarity_conflict'));
  });
});

// ---- AP-07 read window -------------------------------------------------------------------------

describe('AP-09 §9 evidence window states', () => {
  test('missing, unavailable, and damaged reads make the check unavailable', () => {
    for (const state of ['missing', 'unavailable', 'damaged']) {
      const result = assess(
        [evidence('m1', 'the lighthouse status is green')],
        'the lighthouse status is green',
        { read: { state } },
      );
      assert.equal(result.finding, SemanticFinding.UNAVAILABLE, state);
      assert.equal(result.reason, 'the request did not finish retrieving its evidence', state);
      assert.equal(result.dimensions.attribution, SemanticDimensionStatus.UNAVAILABLE, state);
    }
  });

  test('inconsistent and unverifiable snapshots are not checked, never successful', () => {
    for (const state of ['inconsistent', 'unverifiable']) {
      const result = assess(
        [evidence('m1', 'the lighthouse status is green')],
        'the lighthouse status is green',
        { read: { state } },
      );
      assert.equal(result.finding, SemanticFinding.NOT_CHECKED, state);
      assert.equal(result.reason, 'the contributing stores could not be checked as one consistent snapshot', state);
      assert.equal(result.dimensions.attribution, SemanticDimensionStatus.NOT_CHECKED, state);
    }
  });

  test('a truncated window downgrades a consistent claim to partial', () => {
    const result = assess(
      [evidence('m1', 'the lighthouse status is green')],
      'the lighthouse status is green',
      { read: { state: 'truncated' } },
    );
    assert.equal(result.finding, SemanticFinding.PARTIALLY_CONSISTENT);
    assert.equal(result.bounded, true);
    assert.equal(result.reason, 'the retrieval was bounded, so the cited records are not a complete statement');
  });

  test('dropped records or partial records also bound the assessment', () => {
    const dropped = assess(
      [evidence('m1', 'the lighthouse status is green')],
      'the lighthouse status is green',
      { read: { state: 'complete', complete: true, dropped: 2 } },
    );
    assert.equal(dropped.finding, SemanticFinding.PARTIALLY_CONSISTENT);
    const partialRecord = evidence('m1', 'the lighthouse status is green');
    partialRecord.partial = true;
    const partial = assess([partialRecord], 'the lighthouse status is green');
    assert.equal(partial.finding, SemanticFinding.PARTIALLY_CONSISTENT);
  });
});

// ---- response-level consistency ----------------------------------------------------------------

describe('AP-09 §7 response-level consistency', () => {
  test('two contradictory factual claims are paired with the dimension that caught them', () => {
    const result = assessResponseConsistency({
      claims: [
        { text: 'The lighthouse status is green.', kind: 'supported' },
        { text: 'The lighthouse status is not green.', kind: 'supported' },
      ],
    });
    assert.equal(result.finding, SemanticFinding.POLARITY_CONFLICT);
    assert.deepEqual(result.contradictions, [{ a: 0, b: 1, dimension: SemanticFinding.POLARITY_CONFLICT }]);
    assert.equal(result.authorizes, false);
  });

  test('two claims with incompatible values are paired', () => {
    const result = assessResponseConsistency({
      claims: [
        { text: 'The archive retention window is 30 days.', kind: 'supported' },
        { text: 'The archive retention window is 90 days.', kind: 'supported' },
      ],
    });
    assert.equal(result.finding, SemanticFinding.NUMERICAL_CONFLICT);
    assert.equal(result.contradictions.length, 1);
    assert.equal(result.contradictions[0].dimension, SemanticFinding.NUMERICAL_CONFLICT);
  });

  test('unrelated facts are not forced into a contradiction', () => {
    const result = assessResponseConsistency({
      claims: [
        { text: 'The lighthouse status is green.', kind: 'supported' },
        { text: 'The quarterly budget is 4000 dollars.', kind: 'supported' },
      ],
    });
    assert.deepEqual(result.contradictions, []);
  });

  test('an inference beside a fact is not a contradiction', () => {
    const result = assessResponseConsistency({
      claims: [
        { text: 'The deploy completed.', kind: 'supported' },
        { text: 'The deploy did not complete.', kind: 'inference' },
      ],
    });
    assert.deepEqual(result.contradictions, []);
    assert.equal(result.claims[1].kind, null);
  });

  test('a response with no factual claims reports no aggregate finding', () => {
    const result = assessResponseConsistency({
      claims: [{ text: 'Perhaps the deploy completed.', kind: 'general_knowledge' }],
    });
    assert.equal(result.finding, null);
    assert.equal(result.checked, 0);
    assert.equal(result.total, 1);
  });

  test('a conflict outranks a not-checked claim in the same response', () => {
    const result = assessResponseConsistency({
      claims: [
        { text: 'The lighthouse status is green.', kind: 'supported', semantic: { finding: SemanticFinding.SEMANTICALLY_CONSISTENT } },
        { text: 'The lighthouse status is not green.', kind: 'supported' },
      ],
    });
    assert.equal(result.finding, SemanticFinding.POLARITY_CONFLICT);
  });

  test('claim and pair counts are bounded', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      text: `The sample value is ${index} units.`,
      kind: 'supported',
    }));
    const result = assessResponseConsistency({ claims: many });
    assert.equal(result.total, 12);
    assert.ok(result.claims.length <= 12);
    assert.ok(result.contradictions.length <= 6);
  });

  test('overstatement counts a supported claim that did not read as consistent', () => {
    const result = assessResponseConsistency({
      claims: [
        { text: 'The operation succeeded.', kind: 'supported', semantic: { finding: SemanticFinding.POLARITY_CONFLICT } },
        { text: 'The operation is complete.', kind: 'supported', semantic: { finding: SemanticFinding.SEMANTICALLY_CONSISTENT } },
      ],
    });
    assert.equal(result.overstated, 1);
    assert.equal(result.checked, 2);
  });

  test('a missing semantic record is not treated as a success', () => {
    const result = assessResponseConsistency({ claims: [{ text: 'The operation succeeded.', kind: 'supported' }] });
    assert.equal(result.finding, SemanticFinding.NOT_CHECKED);
    assert.equal(result.claims[0].finding, SemanticFinding.NOT_CHECKED);
  });
});

// ---- §8 the twenty-eight adversarial classes ---------------------------------------------------

describe('AP-09 §8 deterministic adversarial classes', () => {
  test('class 1: negation reversal', () => {
    const result = assess([evidence('m1', 'The operation succeeded.')], 'The operation did not succeed.');
    assert.equal(result.finding, SemanticFinding.POLARITY_CONFLICT);
  });

  test('class 2: numerical sign reversal', () => {
    const result = assess([evidence('m1', 'Revenue increased by 10%.')], 'Revenue decreased by 10%.');
    assert.equal(result.finding, SemanticFinding.NUMERICAL_CONFLICT);
  });

  test('class 3: numerical magnitude alteration', () => {
    const result = assess([evidence('m1', 'The archive retention window is 30 days.')], 'The archive retention window is 90 days.');
    assert.equal(result.finding, SemanticFinding.NUMERICAL_CONFLICT);
  });

  test('class 4: unit alteration', () => {
    const result = assess([evidence('m1', 'The request timeout is 30 seconds.')], 'The request timeout is 30 minutes.');
    assert.equal(result.finding, SemanticFinding.NUMERICAL_CONFLICT);
    assert.equal(result.reason, 'the claim states the same magnitude in a different unit');
  });

  test('class 5: date substitution', () => {
    const result = assess([evidence('m1', 'The backup completed on Monday.')], 'The backup completed on Tuesday.');
    assert.equal(result.finding, SemanticFinding.TEMPORAL_CONFLICT);
  });

  test('class 6: event-order reversal', () => {
    const result = assess([evidence('m1', 'The deploy completed after the tests.')], 'The deploy completed before the tests.');
    assert.equal(result.finding, SemanticFinding.TEMPORAL_CONFLICT);
  });

  test('class 7: entity substitution', () => {
    const result = assess([evidence('m1', 'Atlas owner = Nadia')], 'Atlas owner = Bruno');
    assert.equal(result.finding, SemanticFinding.ENTITY_CONFLICT);
  });

  test('class 8: subject/object reversal', () => {
    const result = assess([evidence('m1', 'Atlas owns the lighthouse.')], 'The lighthouse owns Atlas.');
    assert.equal(result.finding, SemanticFinding.RELATIONSHIP_CONFLICT);
  });

  test('class 9: relationship inversion', () => {
    const result = assess([evidence('m1', 'The Pilot manages the Archive.')], 'The Pilot is managed by the Archive.');
    assert.equal(result.finding, SemanticFinding.RELATIONSHIP_CONFLICT);
  });

  test('class 10: unsupported causal inference', () => {
    const result = assess([evidence('m1', 'The deploy completed after the tests.')], 'The deploy completed because the tests passed.');
    assert.equal(result.finding, SemanticFinding.UNSUPPORTED_TRANSFORMATION);
    assert.equal(result.reason, 'the claim asserts a causal link the cited records do not');
  });

  test('class 11: unsupported certainty upgrade', () => {
    const result = assess([evidence('m1', 'The release is possibly delayed.')], 'The release is confirmed delayed.');
    assert.equal(result.finding, SemanticFinding.QUALIFIER_CONFLICT);
  });

  test('class 12: qualifier removal', () => {
    const result = assess([evidence('m1', 'The release is possibly delayed.')], 'The release is delayed.');
    assert.equal(result.finding, SemanticFinding.QUALIFIER_CONFLICT);
  });

  test('class 13: unsupported universal claim', () => {
    const result = assess([evidence('m1', 'Some tests passed.')], 'All tests passed.');
    assert.equal(result.finding, SemanticFinding.QUALIFIER_CONFLICT);
  });

  test('class 14: contradictory claims in one response', () => {
    const result = assessResponseConsistency({
      claims: [
        { text: 'The lighthouse status is green.', kind: 'supported' },
        { text: 'The lighthouse status is not green.', kind: 'supported' },
      ],
    });
    assert.equal(result.finding, SemanticFinding.POLARITY_CONFLICT);
    assert.equal(result.contradictions.length, 1);
  });

  test('class 15: fabricated evidence references', () => {
    const result = assessClaimSemantics({
      text: 'The operation succeeded.', evidenceIds: ['ev:memory:ghost'], evidenceById: byId([]), kind: 'supported',
    });
    assert.equal(result.finding, SemanticFinding.INSUFFICIENT_EVIDENCE);
    assert.equal(result.partialAttribution, true);
  });

  test('class 16: existing but irrelevant evidence references', () => {
    const result = assess([evidence('m1', 'The lighthouse status is green.')], 'The quarterly budget was approved.');
    assert.equal(result.finding, SemanticFinding.INSUFFICIENT_EVIDENCE);
    assert.equal(result.sharedTokens, 0);
  });

  test('class 17: retracted evidence references', () => {
    const result = assess([evidence('m1', 'The operation succeeded.', { status: 'retracted' })], 'The operation succeeded.');
    assert.equal(result.finding, SemanticFinding.INSUFFICIENT_EVIDENCE);
    assert.equal(result.reason, 'a cited record was retracted or replaced and no longer stands');
  });

  test('class 18: superseded evidence references', () => {
    const result = assess(
      [evidence('m1', 'The operation succeeded.', { validity: EvidenceValidity.SUPERSEDED })],
      'The operation succeeded.',
    );
    assert.equal(result.finding, SemanticFinding.INSUFFICIENT_EVIDENCE);
    assert.equal(result.reason, 'a cited record was retracted or replaced and no longer stands');
  });

  test('class 19: truncated evidence presented as complete', () => {
    const result = assess(
      [evidence('m1', 'the lighthouse status is green')],
      'the lighthouse status is green',
      { read: { state: 'truncated' } },
    );
    assert.equal(result.finding, SemanticFinding.PARTIALLY_CONSISTENT);
    assert.equal(result.bounded, true);
    const integrity = integrityFor(
      [evidence('m1', 'the lighthouse status is green')],
      'the lighthouse status is green',
      { read: { state: 'truncated' } },
    );
    assert.notEqual(integrity.trust.state, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.equal(integrity.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
  });

  test('class 20: inconsistent snapshot during response construction', () => {
    const result = assess(
      [evidence('m1', 'the lighthouse status is green')],
      'the lighthouse status is green',
      { read: { state: 'inconsistent' } },
    );
    assert.equal(result.finding, SemanticFinding.NOT_CHECKED);
    const integrity = integrityFor(
      [evidence('m1', 'the lighthouse status is green')],
      'the lighthouse status is green',
      { read: { state: 'inconsistent' } },
    );
    assert.equal(integrity.trust.state, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.equal(integrity.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
    assert.ok(integrity.limitations.includes('semantic_not_checked'));
  });

  test('class 21: model self-declared verification', () => {
    const record = evidence('m1', 'The operation succeeded.');
    const analysis = analysisFor([record]);
    const result = validateStructuredResponse({
      schema: 1,
      decision: 'answer',
      answer: 'The operation succeeded.',
      claims: [{ text: 'The operation succeeded.', kind: 'supported', evidence: ['ev:memory:m1'], verified: true }],
    }, { analysis });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes('verified')));
  });

  test('class 22: model-generated authority or authorization fields', () => {
    const record = evidence('m1', 'The operation succeeded.');
    const analysis = analysisFor([record]);
    for (const field of ['authorization', 'authorized', 'permission', 'approve', 'execute']) {
      const result = validateStructuredResponse({
        schema: 1,
        decision: 'answer',
        answer: 'The operation succeeded.',
        claims: [{ text: 'The operation succeeded.', kind: 'supported', evidence: ['ev:memory:m1'], [field]: true }],
      }, { analysis });
      assert.equal(result.ok, false, field);
    }
    const claimLevel = validateStructuredResponse({
      schema: 1,
      decision: 'answer',
      answer: 'The operation succeeded.',
      claims: [{ text: 'The operation succeeded.', kind: 'supported', evidence: ['ev:memory:m1'], semantic: { finding: 'semantically_consistent' } }],
    }, { analysis });
    assert.equal(claimLevel.ok, false);
    assert.ok(claimLevel.problems.some((problem) => problem.includes('semantic')));
  });

  test('class 23: malformed structured response', () => {
    const record = evidence('m1', 'The operation succeeded.');
    const analysis = analysisFor([record]);
    for (const claims of ['not-an-array', [{ text: '' }], [{ text: 'A claim.', evidence: 'ev:memory:m1' }]]) {
      const result = validateStructuredResponse({
        schema: 1, decision: 'answer', answer: 'The operation succeeded.', claims,
      }, { analysis });
      assert.equal(result.ok, false, JSON.stringify(claims));
    }
    const malformed = assessResponseIntegrity({
      analysis,
      text: 'The operation succeeded.',
      check: { found: true, structure: null, error: { code: 'INVALID_STRUCTURE' } },
    });
    assert.equal(malformed.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
    assert.ok(malformed.limitations.includes('structured_response_rejected'));
    assert.equal(malformed.trust.claims.length, 0);
  });

  test('class 24: empty, refused, cancelled, or unavailable model response', () => {
    const empty = assessResponseIntegrity({ analysis: null, text: '' });
    assert.equal(empty.trust.state, null);
    assert.equal(empty.degradation, ResponseDegradation.NO_OUTPUT);
    assert.deepEqual(empty.limitations, []);
    for (const classification of ['refused', 'cancelled', 'unavailable', 'empty']) {
      const result = assessResponseIntegrity({ analysis: null, text: 'A reply that must not be presented as support.', classification });
      assert.equal(result.trust.state, ResponseTrustState.SYNTACTICALLY_VALID, classification);
      assert.equal(result.trust.verified, false, classification);
      assert.notEqual(result.degradation, ResponseDegradation.PRESENT_AS_IS, classification);
    }
  });

  test('class 25: unsupported claim mixed with supported claims', () => {
    const supported = evidence('m1', 'The lighthouse status is green.');
    const unrelated = evidence('m2', 'The server rebooted overnight.');
    const analysis = analysisFor([supported, unrelated]);
    const { check } = checked(analysis, [
      { text: 'The lighthouse status is green.', evidence: ['ev:memory:m1'], kind: 'supported' },
      { text: 'The quarterly budget was approved.', evidence: ['ev:memory:m2'], kind: 'supported' },
    ], 'The lighthouse status is green. The quarterly budget was approved.');
    assert.ok(check.structure, 'the validator accepts both citations; relevance is a separate check');
    const result = assessResponseIntegrity({
      analysis, text: 'The lighthouse status is green. The quarterly budget was approved.', check,
    });
    assert.equal(result.trust.claims[0].semantic.finding, SemanticFinding.SEMANTICALLY_CONSISTENT);
    assert.equal(result.trust.claims[1].semantic.finding, SemanticFinding.INSUFFICIENT_EVIDENCE);
    assert.equal(result.trust.state, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.equal(result.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
    assert.ok(result.limitations.includes('semantic_insufficient_evidence'));
    assert.equal(result.consistency.overstated, 1);
  });

  test('class 26: misleading paraphrase with high lexical overlap', () => {
    const record = evidence('m1', 'The operation succeeded.');
    const claim = 'The operation did not succeed.';
    const result = assess([record], claim);
    const claimTokens = contentTokens(claim);
    const recordTokens = contentTokens(record.claim);
    let shared = 0;
    for (const token of claimTokens) if (recordTokens.has(token)) shared += 1;
    assert.ok(shared / claimTokens.size >= 0.5, 'the claim really is lexically close');
    assert.equal(result.finding, SemanticFinding.POLARITY_CONFLICT);
    const integrity = integrityFor([record], claim);
    assert.equal(integrity.trust.state, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.equal(integrity.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
  });

  test('class 27: valid paraphrase with low lexical overlap stays uncertain', () => {
    const result = assess([evidence('m1', 'The batch finished without error.')], 'The job ended successfully.');
    assert.equal(result.finding, SemanticFinding.INSUFFICIENT_EVIDENCE);
    assert.equal(result.sharedTokens, 0);
  });

  test('class 28: an ambiguous claim that cannot be deterministically classified', () => {
    const result = assess([evidence('m1', 'All tests passed.')], 'Not all tests passed.');
    assert.equal(result.finding, SemanticFinding.AMBIGUOUS);
    assert.equal(result.ambiguous, true);
    const integrity = integrityFor([evidence('m1', 'All tests passed.')], 'Not all tests passed.');
    assert.equal(integrity.trust.state, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.ok(integrity.limitations.includes('semantic_ambiguous'));
  });

  test('the class list is complete and unique', () => {
    const names = [
      'negation reversal', 'numerical sign reversal', 'numerical magnitude alteration',
      'unit alteration', 'date substitution', 'event-order reversal', 'entity substitution',
      'subject/object reversal', 'relationship inversion', 'unsupported causal inference',
      'unsupported certainty upgrade', 'qualifier removal', 'unsupported universal claim',
      'contradictory claims in one response', 'fabricated evidence references',
      'existing but irrelevant evidence references', 'retracted evidence references',
      'superseded evidence references', 'truncated evidence presented as complete',
      'inconsistent snapshot during response construction', 'model self-declared verification',
      'model-generated authority or authorization fields', 'malformed structured response',
      'empty, refused, cancelled, or unavailable model response', 'unsupported claim mixed with supported claims',
      'misleading paraphrase with high lexical overlap', 'valid paraphrase with low lexical overlap',
      'ambiguous claim that cannot be deterministically classified',
    ];
    assert.equal(names.length, 28);
    assert.equal(new Set(names).size, 28);
  });
});

// ---- conservative trust and bounded audit ------------------------------------------------------

describe('AP-09 §6/§10 conservative trust and bounded audit', () => {
  test('a checked, consistent claim reaches factual support but never verification', () => {
    const record = evidence('m1', 'the lighthouse status is green');
    const integrity = integrityFor([record], 'The lighthouse status is green.');
    assert.equal(integrity.trust.state, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.equal(integrity.degradation, ResponseDegradation.PRESENT_AS_IS);
    assert.equal(integrity.verified, false);
    assert.equal(integrity.authorizes, false);
    const verified = integrity.trust.ladder.find((entry) => entry.state === ResponseTrustState.VERIFIED);
    assert.equal(verified.ok, false);
    assert.deepEqual(integrity.limitations, ['model_output_unverified']);
    assert.equal(semanticNotice(integrity), '');
  });

  test('a semantic conflict cannot be presented as unqualified support', () => {
    const record = evidence('m1', 'The archive retention window is 30 days.');
    const integrity = integrityFor([record], 'The archive retention window is 90 days.');
    assert.notEqual(integrity.trust.state, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.equal(integrity.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
    assert.ok(integrity.limitations.includes('semantic_numerical_conflict'));
    const notice = semanticNotice(integrity);
    assert.match(notice, /APEX check/);
    assert.match(notice, /numerical_conflict/);
    assert.equal(notice.includes('90 days'), false);
    assert.equal(notice.includes('30 days'), false);
  });

  test('a response with contradictory claims is disclosed once', () => {
    const record = evidence('m1', 'The lighthouse status is green.');
    const analysis = analysisFor([record]);
    const { check } = checked(analysis, [
      { text: 'The lighthouse status is green.', evidence: ['ev:memory:m1'], kind: 'supported' },
      { text: 'The lighthouse status is not green.', evidence: ['ev:memory:m1'], kind: 'supported' },
    ], 'The lighthouse status is green. The lighthouse status is not green.');
    const result = assessResponseIntegrity({ analysis, text: 'The lighthouse status is green. The lighthouse status is not green.', check });
    assert.ok(result.limitations.includes('response_inconsistent'));
    assert.ok(result.limitations.includes('semantic_polarity_conflict'));
    assert.equal(result.consistency.contradictions.length, 1);
    assert.match(semanticNotice(result), /contradict each other/);
  });

  test('the integrity audit carries findings and counts, never text or identifiers', () => {
    const record = evidence('m-secret', 'the vault password is hunter2');
    const claim = 'The vault password is not hunter2.';
    const integrity = integrityFor([record], claim);
    const audit = responseIntegrityAudit(integrity);
    assert.deepEqual(Object.keys(audit.semantic).sort(), [
      'authorizes', 'bounded', 'claims', 'contradictions', 'dimensions', 'finding', 'overstated', 'schema',
    ]);
    assert.deepEqual(Object.keys(audit.semantic.dimensions).sort(), [
      'attribution', 'entity', 'numerical', 'polarity', 'qualifier', 'relationship', 'temporal', 'transformation',
    ]);
    assert.equal(audit.semantic.finding, SemanticFinding.POLARITY_CONFLICT);
    assert.equal(audit.semantic.claims.conflict, 1);
    assert.equal(audit.semantic.dimensions.polarity.conflict, 1);
    assert.equal(audit.semantic.authorizes, false);
    const serialized = JSON.stringify(audit);
    assert.equal(serialized.includes('hunter2'), false);
    assert.equal(serialized.includes('m-secret'), false);
    assert.equal(serialized.includes(claim), false);
  });

  test('checked, not-checked, and unavailable remain distinct in the audit', () => {
    const record = evidence('m1', 'The lighthouse is green.');
    const unavailable = responseIntegrityAudit(integrityFor([record], 'The lighthouse is green.', { read: { state: 'damaged' } }));
    assert.equal(unavailable.semantic.claims.unavailable, 1);
    assert.equal(unavailable.semantic.dimensions.attribution.unavailable, 1);
    const notChecked = responseIntegrityAudit(integrityFor([record], 'The lighthouse is green.', { read: { state: 'inconsistent' } }));
    assert.equal(notChecked.semantic.claims.not_checked, 1);
    assert.equal(notChecked.semantic.dimensions.attribution.not_checked, 1);
    const checkedAudit = responseIntegrityAudit(integrityFor([record], 'The lighthouse is green.'));
    assert.equal(checkedAudit.semantic.claims.consistent, 1);
    assert.equal(checkedAudit.semantic.dimensions.polarity.checked, 1);
  });

  test('the audit records a bounded window and caps contradiction pairs', () => {
    const record = evidence('m1', 'the lighthouse status is green');
    const bounded = responseIntegrityAudit(integrityFor([record], 'The lighthouse status is green.', { read: { state: 'truncated' } }));
    assert.equal(bounded.semantic.bounded, true);
    const synthetic = responseIntegrityAudit({
      trust: { claims: [] },
      consistency: {
        schema: SEMANTIC_SCHEMA,
        finding: SemanticFinding.POLARITY_CONFLICT,
        contradictions: Array.from({ length: 9 }, (_, index) => ({ a: index, b: index + 1, dimension: SemanticFinding.POLARITY_CONFLICT })),
      },
    });
    assert.equal(synthetic.semantic.contradictions.length, 6);
  });

  test('a missing assessment produces no audit and no invented result', () => {
    assert.equal(responseIntegrityAudit(null), null);
    assert.equal(responseIntegrityAudit(undefined), null);
    assert.equal(semanticNotice(null), '');
  });
});
