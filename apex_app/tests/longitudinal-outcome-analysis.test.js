// Batch AP-03: longitudinal outcome analysis as evidence, and the one approval that may use it.
//
// Batch AP-02 let one evaluated prediction propose one candidate. This suite covers the narrower
// question that follows several evaluations of the same capability: does their recorded order support
// a repeated or directional statement, which records may not be counted, and what may a supported
// pattern do? It may propose a candidate in the same typed shape; it may never approve, activate, or
// retire anything, and it may never bypass the plan's own authorization.
//
// What is real here: the assembled app, the prediction and experience stores with their validators and
// write locks, the deterministic evaluation rule, the derivation, the action registry's authorization,
// the independent verifiers, the audit log, and the candidate comparison. The only doubles are the
// existing NoBackend gateway (never contacted) and injected store failures used to prove fail-closed
// behavior. No model is contacted, no inference is run, and every expectation in this file is the
// user's own record. A repeated association is never described as a cause, a probability, or a forecast.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { StoreError } from '../src/errors.js';
import { validateExperienceRecord } from '../src/experience/experience-store.js';
import {
  LONGITUDINAL_DERIVATION_METHOD, LONGITUDINAL_PROPOSAL_TYPE, PREDICTION_DECISION_DIMENSION,
} from '../src/experience/prediction-derivation.js';
import {
  analyzeLongitudinal, longitudinalProposalFor, longitudinalRule,
  LONGITUDINAL_PATTERN_KINDS, MIN_REPEATED_OBSERVATIONS, MIN_SEQUENCE_OBSERVATIONS,
  MAX_LONGITUDINAL_OBSERVATIONS, MAX_LONGITUDINAL_GROUPS,
} from '../src/prediction/longitudinal.js';
import { MIN_CALIBRATION_EVALUATIONS } from '../src/prediction/prediction-engine.js';
import {
  ADAPTATION_DECISION_DIMENSION, evaluateCandidates, renderAdaptationDecision,
} from '../src/plans/evaluation.js';
import { guidanceFrom } from '../src/plans/guidance.js';
import { planRisk, validatePlanContent } from '../src/plans/model.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
const dir = () => { const d = makeTempDataDir(); dirs.push(d); return d; };

function clock(start = '2026-11-05T09:00:00.000Z') {
  let ms = Date.parse(start);
  const now = () => new Date(ms);
  now.advance = (days) => { ms += days * 86_400_000; };
  now.iso = () => new Date(ms).toISOString();
  return now;
}

const appIn = (dataDir, now = clock()) => createApp({
  dataDir,
  now,
  gateway: new ModelGateway({ backend: new NoBackend() }),
  experienceCapture: CAPTURE_OFF,
});

const data = (res) => res?.operation?.steps?.[0]?.result?.data ?? res?.result?.data ?? {};
const display = (res) => String(res?.display ?? res?.result?.display ?? res?.output ?? '');
const bytes = (d, name) => (fs.existsSync(path.join(d, name)) ? fs.readFileSync(path.join(d, name)) : Buffer.alloc(0));
const lines = (d, name) => {
  const raw = bytes(d, name).toString('utf8');
  return raw.trim() === '' ? [] : raw.trim().split('\n').map((line) => JSON.parse(line));
};

// ---- pure fixtures: one projection, stated exactly --------------------------------------------

const BASE = Date.parse('2026-11-05T00:00:00.000Z');
const at = (index) => new Date(BASE + index * 3_600_000).toISOString();
let seq = 0;
const nextId = () => { seq += 1; return `pred-${String(seq).padStart(3, '0')}`; };

function observationOfShape({
  id = null, capability = 'calc.evaluate', outcomeClass = 'success', invalidation = null, index = 0,
} = {}) {
  const pid = id ?? nextId();
  const evidence = [`exp-${pid}`];
  return {
    id: pid,
    capability,
    expectation: 'success',
    status: invalidation ? 'invalidated' : 'evaluated',
    provenance: { origin: 'user_recorded' },
    invalidation: invalidation ? { reason: invalidation } : null,
    retired: false,
    supersededBy: [],
    evaluation: {
      id: `eval-${pid}`,
      verdict: outcomeClass === 'success' ? 'matched' : 'contradicted',
      decidingExperienceId: evidence[0],
      outcomeExperienceIds: evidence,
      createdAt: at(index),
    },
    evaluationStale: false,
    deciding: { id: evidence[0], occurredAt: at(index), outcomeClass },
    lineage: { available: true, atCreation: { unresolvedExperienceIds: [], unresolvedFeedbackIds: [], unavailableDeclared: false } },
    createdAt: at(index),
    expiresAt: at(index + 1),
  };
}

function unevaluatedOfShape({ status, capability = 'calc.evaluate', index = 0 } = {}) {
  const pid = nextId();
  return {
    id: pid,
    capability,
    expectation: 'success',
    status,
    provenance: { origin: 'user_recorded' },
    invalidation: null,
    retired: false,
    supersededBy: [],
    evaluation: null,
    evaluationStale: false,
    deciding: null,
    lineage: { available: true, atCreation: { unresolvedExperienceIds: [], unresolvedFeedbackIds: [], unavailableDeclared: false } },
    createdAt: at(index),
    expiresAt: at(index + 1),
  };
}

const experiencesFor = (projections) => new Map(
  projections
    .flatMap((p) => p.evaluation?.outcomeExperienceIds ?? [])
    .map((id) => [id, { id, active: true }]),
);

const analyse = (projections, extra = {}) => analyzeLongitudinal({
  projections,
  experiencesById: experiencesFor(projections),
  now: '2026-11-20T00:00:00.000Z',
  ...extra,
});

const groupOfKinds = (classes) => analyse(
  classes.map((outcomeClass, index) => observationOfShape({ outcomeClass, index })),
).groups[0];

// ---- real-store fixtures ---------------------------------------------------------------------

let note = 0;
function successMemory() {
  note += 1;
  return `remember that the AP03 note ${note} holds`;
}
const BLOCKED_MEMORY = 'remember that the token is sk-synthetic-abcdef0123456789';
const CALC_SUCCESS = 'calc 2+2';
const CALC_FAILURE = 'calc 1/0';

// One real operation, recorded as an experience with the capability and outcome the audit log holds.
async function observed(app, text) {
  const res = await app.controller.handle(text, { origin: 'user' });
  assert.ok(
    [Outcome.SUCCESS_VERIFIED, Outcome.EXECUTION_FAILED, Outcome.INPUT_REJECTED].includes(res.status),
    res.output,
  );
  const recorded = await app.controller.experienceRecord({ operationId: res.operation.id, subject: 'an AP03 recorded outcome' });
  assert.equal(recorded.status, Outcome.SUCCESS_VERIFIED, recorded.output);
  return { status: res.status, experience: data(recorded) };
}

// The complete evidence chain through the real controller: the user's expectation, one recorded
// outcome, and the deterministic evaluation of the two. A two-day spacing keeps one horizon from
// overlapping the next, so the only event inside a window is the one this expectation was about.
async function evaluated(app, now, {
  capability = 'calc.evaluate', expectation = 'success', action = CALC_SUCCESS, inDays = 1,
} = {}) {
  const recorded = await app.controller.predictionRecord({
    capability, expectation, subject: `an AP03 expectation about ${capability}`, inDays,
  });
  assert.equal(recorded.status, Outcome.SUCCESS_VERIFIED, recorded.output);
  const predictionId = data(recorded).id;
  now.advance(1);
  const outcome = await observed(app, action);
  const evaluation = await app.controller.predictionEvaluate({ target: predictionId });
  assert.equal(evaluation.status, Outcome.SUCCESS_VERIFIED, evaluation.output);
  const result = data(evaluation);
  assert.equal(result.recorded, true, evaluation.output);
  now.advance(1);
  return {
    predictionId,
    evaluationId: result.evaluationId,
    experienceId: outcome.experience.id,
    verdict: result.verdict,
    operationStatus: outcome.status,
  };
}

async function longitudinal(app, capability = null) {
  const res = await app.controller.predictionLongitudinal({ capability });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
  return { report: data(res).report, display: display(res) };
}

async function newGoal(app, { required = 'list my memory', suggested = 'remember that the release note holds' } = {}) {
  const created = await app.controller.goalAdd({
    request: 'keep the release note current',
    criteria: [
      { description: required, basis: 'user_stated' },
      { description: suggested, requirement: 'suggested' },
    ],
  });
  assert.equal(created.status, Outcome.GOAL_CREATED, created.output);
  const goalId = data(created).goalId;
  for (const status of ['accepted', 'active']) {
    assert.equal((await app.controller.goalUpdate({ target: goalId, status })).status, Outcome.GOAL_UPDATED);
  }
  return goalId;
}

// =================================================================================================
// The closed vocabulary and the one classification rule
// =================================================================================================
describe('AP-03 pattern vocabulary: eight kinds, one deterministic definition each', () => {
  test('the vocabulary is closed and the repeat/sequence counts are stated, not tuned', () => {
    assert.deepEqual([...LONGITUDINAL_PATTERN_KINDS], [
      'repeated_success',
      'repeated_failure',
      'alternating_outcomes',
      'consistent_improvement',
      'consistent_regression',
      'mixed_outcomes',
      'insufficient_evidence',
      'conflicting_evidence',
    ]);
    assert.equal(MIN_REPEATED_OBSERVATIONS, 2, 'two observations can repeat');
    assert.equal(MIN_SEQUENCE_OBSERVATIONS, 3, 'an order needs three observations');
    assert.equal(MIN_CALIBRATION_EVALUATIONS, 20, 'the existing calibration floor is untouched');
  });

  test('each class sequence produces exactly the kind its definition names', () => {
    const kindOf = (classes) => groupOfKinds(classes).pattern.kind;
    assert.equal(kindOf(['success']), 'insufficient_evidence');
    assert.equal(kindOf(['failure']), 'insufficient_evidence');
    assert.equal(kindOf(['blocked']), 'insufficient_evidence');
    assert.equal(kindOf(['success', 'success']), 'repeated_success');
    assert.equal(kindOf(['failure', 'failure']), 'repeated_failure');
    assert.equal(kindOf(['blocked', 'blocked']), 'mixed_outcomes', 'a blocked pair has no repeated kind in this vocabulary');
    assert.equal(kindOf(['success', 'failure']), 'mixed_outcomes', 'two observations cannot alternate');
    assert.equal(kindOf(['success', 'blocked']), 'mixed_outcomes');
    assert.equal(kindOf(['success', 'failure', 'success']), 'alternating_outcomes');
    assert.equal(kindOf(['success', 'failure', 'success', 'failure']), 'alternating_outcomes');
    assert.equal(kindOf(['failure', 'success', 'success']), 'consistent_improvement');
    assert.equal(kindOf(['success', 'failure', 'failure']), 'consistent_regression');
    assert.equal(kindOf(['success', 'success', 'failure', 'success']), 'mixed_outcomes', 'two changes are not one direction');
    assert.equal(kindOf(['failure', 'success', 'failure']), 'alternating_outcomes');
  });

  test('the sequence is read in recorded order, not in array order', () => {
    const early = observationOfShape({ outcomeClass: 'success', index: 0 });
    const middle = observationOfShape({ outcomeClass: 'failure', index: 1 });
    const late = observationOfShape({ outcomeClass: 'success', index: 2 });
    const report = analyse([late, early, middle]);
    const group = report.groups[0];
    assert.equal(group.pattern.kind, 'alternating_outcomes');
    assert.deepEqual(group.evidenceRefs.predictionIds, [early.id, middle.id, late.id]);
    assert.deepEqual(group.observations.map((o) => o.outcomeClass), ['success', 'failure', 'success']);
  });

  test('only a direction-stating pattern has a rule, and its text is the recorded text', () => {
    const success = groupOfKinds(['success', 'success']);
    assert.equal(success.pattern.sufficient, true);
    assert.equal(success.pattern.proposalField, 'prefer');
    assert.equal(success.pattern.causalClaim, false);
    assert.equal(success.pattern.confidence, null);
    assert.equal(
      longitudinalRule('calc.evaluate', 'repeated_success', 2),
      'prefer work that names calc.evaluate: 2 recorded outcomes in this scope were each a success',
    );
    assert.equal(
      longitudinalRule('calc.evaluate', 'repeated_failure', 2),
      'avoid work that names calc.evaluate: 2 recorded outcomes in this scope were each a failure',
    );
    for (const kind of ['mixed_outcomes', 'insufficient_evidence', 'alternating_outcomes', 'conflicting_evidence']) {
      assert.equal(longitudinalRule('calc.evaluate', kind, 3), null, kind);
    }
    assert.equal(longitudinalProposalFor(groupOfKinds(['success', 'failure', 'success'])), null);
    assert.equal(longitudinalProposalFor(groupOfKinds(['success'])), null);
  });

  test('conflicting evidence withholds the pattern instead of preferring the current set', () => {
    const first = observationOfShape({ outcomeClass: 'success', index: 0 });
    const second = observationOfShape({ outcomeClass: 'success', index: 1 });
    const withdrawn = observationOfShape({ outcomeClass: 'failure', index: -1, invalidation: 'withdrawn' });
    const report = analyse([withdrawn, first, second]);
    const group = report.groups[0];
    assert.equal(group.pattern.kind, 'conflicting_evidence');
    assert.equal(group.pattern.sufficient, false);
    assert.equal(longitudinalProposalFor(group), null, 'a conflict proposes nothing');
    assert.equal(group.counts.eligibleScored, 2);
    assert.equal(group.counts.failure, 0, 'the withdrawn record is not counted as an observation');
    assert.deepEqual(
      [group.exclusions[0].state, group.exclusions[0].evaluated, group.exclusions[0].outcomeClass],
      ['invalidated', true, 'failure'],
    );
  });
});

describe('AP-03 eligibility: grouping, dedupe, missing evidence, and provenance', () => {
  test('a capability is its own group; a parent name never absorbs a child', () => {
    const parent = observationOfShape({ capability: 'memory', index: 0 });
    const child = observationOfShape({ capability: 'memory.add', index: 1 });
    const report = analyse([parent, child]);
    assert.deepEqual(report.groups.map((g) => g.capability), ['memory', 'memory.add']);
    assert.ok(report.groups.every((g) => g.pattern.kind === 'insufficient_evidence'));
    assert.deepEqual(report.groups.map((g) => g.counts.eligibleScored), [1, 1]);
  });

  test('a duplicate reference is reported and counted once; many outcome records are one observation', () => {
    const prediction = observationOfShape({ outcomeClass: 'success', index: 0 });
    prediction.evaluation.outcomeExperienceIds = ['exp-a', 'exp-b'];
    prediction.evaluation.decidingExperienceId = 'exp-b';
    prediction.deciding = { id: 'exp-b', occurredAt: at(0), outcomeClass: 'success' };
    const report = analyse([prediction, { ...prediction }]);
    assert.equal(report.read.considered, 1);
    assert.deepEqual(report.read.duplicateReferences, [prediction.id]);
    assert.equal(report.groups[0].counts.eligibleScored, 1, 'one prediction is one observation');
    assert.equal(report.groups[0].evidenceRefs.experienceIds.length, 2, 'both records it cites stay in the reference set');
    assert.deepEqual(report.groups[0].observations[0].evidenceIds, ['exp-a', 'exp-b']);
  });

  test('expiry and awaiting evaluation keep their own names, and neither is a failed outcome', () => {
    const expired = unevaluatedOfShape({ status: 'expired', index: 0 });
    const awaiting = unevaluatedOfShape({ status: 'awaiting_evaluation', index: 1 });
    const report = analyse([expired, awaiting]);
    const group = report.groups[0];
    assert.equal(group.pattern.kind, 'insufficient_evidence');
    assert.equal(group.counts.eligibleScored, 0);
    assert.equal(group.counts.failure, 0, 'missing evidence is never counted as failure');
    assert.equal(group.counts.success, 0);
    assert.deepEqual(group.counts.byExclusionState, { expired: 1, awaiting_evaluation: 1 });
    const reasons = Object.fromEntries(group.exclusions.map((e) => [e.state, e.reason]));
    assert.match(reasons.expired, /horizon passed/i);
    assert.match(reasons.expired, /not a failed outcome|not a wrong prediction/i);
    assert.match(reasons.awaiting_evaluation, /no evaluation was recorded/i);
  });

  test('a model-origin projection cannot become an observation through aggregation', () => {
    const model = observationOfShape({ outcomeClass: 'success', index: 0 });
    model.provenance = { origin: 'model_generated' };
    const user = observationOfShape({ outcomeClass: 'success', index: 1 });
    const report = analyse([model, user]);
    const group = report.groups[0];
    assert.equal(group.counts.eligibleScored, 1);
    assert.equal(group.pattern.kind, 'insufficient_evidence', 'the user record alone is one observation');
    assert.equal(group.exclusions[0].state, 'provenance_not_user');
    assert.equal(group.exclusions[0].evaluated, true);
    assert.equal(longitudinalProposalFor(group), null);
  });

  test('bounds are stated: twenty observations and twenty groups, with truncation disclosed', () => {
    const many = Array.from({ length: 25 }, (_, index) => observationOfShape({ outcomeClass: 'success', index }));
    const report = analyse(many);
    const group = report.groups[0];
    assert.equal(group.counts.eligibleScored, 25, 'the count is the whole group');
    assert.equal(group.observations.length, MAX_LONGITUDINAL_OBSERVATIONS);
    assert.equal(group.observationsTruncated, true);
    assert.equal(group.evidenceRefs.truncated, true);
    assert.equal(group.evidenceRefs.predictionIds.length, MAX_LONGITUDINAL_OBSERVATIONS);
    assert.equal(group.pattern.observations, 25, 'the pattern states the full count it was read from');
    const proposal = longitudinalProposalFor(group);
    assert.equal(proposal.verdicts.length, MAX_LONGITUDINAL_OBSERVATIONS);
    assert.equal(proposal.pattern.observations, MAX_LONGITUDINAL_OBSERVATIONS, 'a candidate carries only what it cites');
    assert.equal(proposal.evidenceDigest.length, 64);
    assert.notEqual(analyse(many).digest, '', 'the analysis is deterministic and carries a digest');

    const groups = Array.from({ length: 25 }, (_, index) => {
      const projection = observationOfShape({ capability: `scope${String(index).padStart(2, '0')}.a`, index });
      return projection;
    });
    const bounded = analyse(groups);
    assert.equal(bounded.totals.groups, 25);
    assert.equal(bounded.groups.length, MAX_LONGITUDINAL_GROUPS);
    assert.equal(bounded.groupsTruncated, true);
    assert.deepEqual(bounded.groups.map((g) => g.capability).slice(0, 2), ['scope00.a', 'scope01.a']);
  });

  test('the analysis states what it does not claim, and authorizes nothing', () => {
    const report = analyse([observationOfShape({ index: 0 }), observationOfShape({ index: 1 })]);
    assert.equal(report.authorizes, false);
    assert.equal(report.groups[0].authorizes, false);
    assert.match(report.note, /makes no causal claim/i);
    assert.match(report.groups[0].limitations.join(' '), /association in recorded order, not evidence that the capability caused/i);
    assert.match(report.groups[0].limitations.join(' '), /not a forecast/i);
    assert.equal(report.groups[0].pattern.confidence, null);
    assert.equal(report.groups[0].calibration.usedForPattern, false);
    assert.equal(report.groups[0].calibration.confidence.available, false);
  });
});

// =================================================================================================
// The comparison discloses whether a rule rests on a pattern or on one evaluation
// =================================================================================================
const NAMES = ['memory.add', 'knowledge.add', 'memory.list', 'calc.evaluate'];
const registry = {
  names: () => [...NAMES],
  get: (name) => (NAMES.includes(name)
    ? { name, permission: name === 'memory.add' || name === 'knowledge.add' ? 'write' : 'read', plannable: true }
    : null),
  authorize: () => ({ decision: 'allow' }),
};

function candidateOf(strategy, steps) {
  const writes = steps.filter((s) => registry.get(s.action)?.permission === 'write').length;
  const content = {
    goalId: 'goal-1',
    outcome: 'the recorded criteria are settled',
    steps: steps.map((s, i) => ({
      id: `s${i + 1}`,
      description: `${s.action} is the ${i + 1} step of this approach`,
      action: s.action,
      input: {},
      dependsOn: i === 0 ? [] : [`s${i}`],
      expectedResult: `the ${s.action} result is recorded`,
      verification: 'the action re-checks its own result',
      risk: 'medium',
      estimate: { seconds: null },
      reversibility: registry.get(s.action)?.permission === 'write' ? 'reversible' : 'read_only',
      recovery: 'the task stops here and later steps do not run',
    })),
    preconditions: [],
    assertions: [],
    resources: { estimatedSeconds: null },
  };
  validatePlanContent(content);
  return {
    strategy,
    note: `${strategy} as an approach`,
    outcome: content.outcome,
    content,
    digest: `${strategy.padEnd(64, '0')}`.slice(0, 64),
    steps: content.steps.length,
    writes,
    reads: content.steps.length - writes,
    risk: planRisk(content.steps),
    reversibility: content.steps.map((s) => ({ id: s.id, action: s.action, reversibility: s.reversibility })),
    failurePaths: content.steps.map((s) => ({ id: s.id, action: s.action, recovery: s.recovery })),
    validation: { ok: true, problems: [] },
    capabilities: content.steps.map((s) => ({ action: s.action, permission: registry.get(s.action)?.permission, hasVerifier: false })),
    criteriaCovered: [],
    criteriaLeftUnaddressed: [],
    criteriaAssumedFromTheGoalRequest: [],
    criteriaSharedWithAnEarlierStep: [],
    criteriaBeyondThePlanBound: [],
    criteriaFromInference: [],
    criteriaLeftOutOfThisApproach: [],
    stepsBeyondThePlanBound: [],
    estimatedSeconds: null,
    executable: false,
    approved: false,
    readyForApproval: true,
  };
}

const withAdd = () => candidateOf('with_add', [{ action: 'memory.list' }, { action: 'memory.add' }]);
const withoutAdd = () => candidateOf('without_add', [{ action: 'memory.list' }, { action: 'knowledge.add' }]);
const goal = { id: 'goal-1', revision: 1, status: 'active', criteria: [] };
const compare = (adaptations, candidates = [withAdd(), withoutAdd()]) => evaluateCandidates({
  result: { ok: true, candidates, skipped: [], unaddressed: [], assumedFromGoalRequest: [] },
  goal,
  registry,
  guidance: guidanceFrom({ adaptations, candidates, registry }),
});

const longitudinalRow = (extra = {}) => ({
  id: extra.id ?? 'adapt-longitudinal1',
  capability: extra.capability ?? 'memory.add',
  rule: extra.rule ?? 'prefer work that names memory.add: 2 recorded outcomes in this scope were each a success',
  ruleHash: 'hash-longitudinal',
  method: LONGITUDINAL_DERIVATION_METHOD,
  source: 'prediction',
  basis: 'longitudinal_pattern',
  pattern: { kind: 'repeated_success', observations: 2 },
  supportCount: 2,
  support: {
    experienceIds: ['exp-1', 'exp-2'],
    feedbackIds: [],
    predictionIds: ['pred-1', 'pred-2'],
    evaluationIds: ['eval-1', 'eval-2'],
  },
  decidedAt: '2026-11-06T00:00:00.000Z',
  decisionState: extra.decisionState ?? 'approved',
  active: extra.active ?? true,
  conflicts: 0,
  conflictsWith: [],
  guidance: { id: 'adapt-longitudinal1', order: null, avoid: [], prefer: ['memory.add'], maxSteps: null, createdAt: '2026-11-06T00:00:00.000Z', source: 'proposal' },
  guidanceCount: 0,
  shapeVersion: 1,
  predictionEvidence: { eligible: true, state: 'eligible', reason: null },
});

describe('AP-03 disclosure: one dimension, and a pattern named as a pattern', () => {
  test('an approved longitudinal rule names its pattern, observations, and every citation', () => {
    const decision = compare([longitudinalRow()]).adaptationDecision;
    assert.equal(decision.dimension, ADAPTATION_DECISION_DIMENSION);
    assert.equal(decision.applied, true);
    assert.deepEqual(decision.after.front, ['with_add']);
    assert.equal(decision.rules.length, 1);
    assert.equal(decision.rules[0].basis, 'longitudinal_pattern');
    assert.equal(decision.rules[0].pattern.kind, 'repeated_success');
    assert.equal(decision.rules[0].pattern.observations, 2);
    assert.deepEqual(decision.rules[0].support.predictionIds, ['pred-1', 'pred-2']);
    assert.deepEqual(decision.rules[0].support.evaluationIds, ['eval-1', 'eval-2']);
    assert.deepEqual(decision.sources.longitudinalDerived, ['adapt-longitudinal1']);
    assert.deepEqual(decision.sources.singleEvaluationDerived, []);
    assert.deepEqual(decision.sources.predictionDerived, ['adapt-longitudinal1']);
    assert.equal(decision.sources.predictionEvidence, 'prediction_derived');
    assert.equal(decision.authorizes, false);
    const rendered = renderAdaptationDecision(decision);
    assert.match(rendered, /longitudinal-pattern-derived; pattern repeated_success over 2 observation\(s\)/);
    assert.match(rendered, /of the prediction-derived records: longitudinal pattern adapt-longitudinal1; single evaluated observation none/);
  });

  test('an unapproved pattern candidate changes nothing, and a stale one is rejected by name', () => {
    const candidate = compare([longitudinalRow({ decisionState: 'candidate', active: false })]).adaptationDecision;
    assert.equal(candidate.applied, false);
    assert.deepEqual(candidate.before, candidate.after);
    assert.equal(candidate.sources.predictionEvidence, 'prediction_rejected');
    assert.deepEqual(candidate.sources.longitudinalDerived, []);

    const stale = longitudinalRow();
    stale.active = false;
    stale.predictionEvidence = { eligible: false, state: 'evaluation_stale', reason: 'the recorded verdict is stale' };
    const decision = compare([stale]).adaptationDecision;
    assert.equal(decision.applied, false);
    assert.deepEqual(decision.before, decision.after);
    assert.deepEqual(decision.sources.predictionRejected.map((r) => [r.id, r.state]), [['adapt-longitudinal1', 'stale']]);
  });
});

// =================================================================================================
// Real stores: supported patterns, missing evidence, and the inert candidate
// =================================================================================================
describe('AP-03 through the real prediction and experience stores', () => {
  test('two evaluated successes are a repeated pattern, and the derived candidate is inert until approved', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const first = await evaluated(app, now, { action: CALC_SUCCESS });
    const second = await evaluated(app, now, { action: CALC_SUCCESS });
    assert.deepEqual([first.verdict, second.verdict], ['matched', 'matched']);
    assert.deepEqual([first.operationStatus, second.operationStatus], [Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED]);

    const ledger = bytes(d, 'predictions.jsonl');
    const experiences = bytes(d, 'experiences.jsonl');
    const { report, display: text } = await longitudinal(app, 'calc.evaluate');
    assert.deepEqual(bytes(d, 'predictions.jsonl'), ledger, 'the analysis wrote no prediction record');
    assert.deepEqual(bytes(d, 'experiences.jsonl'), experiences, 'the analysis wrote no experience record');

    assert.equal(report.groups.length, 1);
    const [group] = report.groups;
    assert.equal(group.capability, 'calc.evaluate');
    assert.equal(group.pattern.kind, 'repeated_success');
    assert.equal(group.pattern.sufficient, true);
    assert.equal(group.counts.eligibleScored, 2);
    assert.equal(group.counts.success, 2);
    assert.deepEqual(group.evidenceRefs.predictionIds, [first.predictionId, second.predictionId]);
    assert.deepEqual(group.evidenceRefs.evaluationIds, [first.evaluationId, second.evaluationId]);
    assert.ok(group.evidenceRefs.experienceIds.includes(first.experienceId));
    // Calibration is reported beside the pattern; below the existing floor it says so and is not used.
    assert.equal(group.calibration.available, false);
    assert.equal(group.calibration.value, null);
    assert.equal(group.calibration.denominator, 2);
    assert.equal(group.calibration.requiredForRate, 20);
    assert.match(group.calibration.reason, /below 20/);
    assert.equal(group.calibration.usedForPattern, false);
    assert.match(text, /not a cause; not a confidence; not an instruction/);

    const derived = data(await app.controller.adaptationDerive({}));
    assert.equal(derived.created.length, 1, JSON.stringify(derived.created));
    const [summary] = derived.created;
    assert.equal(summary.method, LONGITUDINAL_DERIVATION_METHOD);
    assert.deepEqual(summary.support.predictionIds, [first.predictionId, second.predictionId]);
    assert.deepEqual(summary.support.evaluationIds, [first.evaluationId, second.evaluationId]);
    assert.equal(derived.prediction.longitudinal.groups, 1);
    assert.equal(derived.prediction.longitudinal.supported, 1);
    assert.equal(derived.prediction.longitudinal.created, 1);
    assert.deepEqual(derived.prediction.longitudinal.coveredCapabilities, ['calc.evaluate']);
    assert.equal(derived.prediction.longitudinal.skipped.length, 0);

    const candidate = await app.experience.adaptationDetail(summary.id);
    assert.equal(candidate.decisionState, 'candidate');
    assert.equal(candidate.active, false, 'a derived candidate is not approved and not active');
    assert.equal(candidate.method, LONGITUDINAL_DERIVATION_METHOD);
    assert.equal(candidate.minSupport, 2);
    assert.equal(candidate.proposal.type, LONGITUDINAL_PROPOSAL_TYPE);
    assert.equal(candidate.proposal.dimension, PREDICTION_DECISION_DIMENSION);
    assert.equal(candidate.proposal.pattern.kind, 'repeated_success');
    assert.equal(candidate.proposal.pattern.observations, 2);
    assert.deepEqual(candidate.proposal.verdicts.map((v) => v.outcomeClass), ['success', 'success']);
    assert.deepEqual(candidate.proposal.guidance.prefer, ['calc.evaluate']);
    assert.deepEqual(candidate.proposal.guidance.avoid, []);
    assert.equal(candidate.proposal.guidance.order, null);
    assert.equal(candidate.proposal.guidance.maxSteps, null);
    assert.ok(candidate.proposal.limitations.length >= 1);
    assert.match(candidate.proposal.limitations.join(' '), /association in time/);
    assert.equal(candidate.proposal.evidenceDigest.length, 64);
    assert.equal(candidate.rule, longitudinalRule('calc.evaluate', 'repeated_success', 2));
    assert.deepEqual(await app.experience.adaptations({ limit: 5 }).then((r) => r.map((a) => a.decisionState)), ['candidate']);
    assert.deepEqual(await app.experience.activeAdaptations({ limit: 5 }).then((r) => r.adaptations), []);
    assert.equal((await app.experience.status()).longitudinalDerivedAdaptations, 1);

    // A second derivation cannot restate the same pattern, and the scope's members are not also
    // reduced to single-observation rules.
    const before = bytes(d, 'experiences.jsonl');
    const again = data(await app.controller.adaptationDerive({}));
    assert.deepEqual(again.created, []);
    assert.ok(again.prediction.longitudinal.skipped.some((s) => /already states this rule/.test(s.reason)));
    assert.deepEqual(bytes(d, 'experiences.jsonl'), before);
    assert.deepEqual(await app.experience.activeAdaptations({ limit: 5 }).then((r) => r.adaptations), []);
  });

  test('a repeated failure proposes avoidance, and missing evidence beside it is not counted as failure', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const first = await evaluated(app, now, { action: CALC_FAILURE });
    const second = await evaluated(app, now, { action: CALC_FAILURE });
    assert.deepEqual([first.verdict, second.verdict], ['contradicted', 'contradicted']);
    assert.deepEqual([first.operationStatus, second.operationStatus], [Outcome.EXECUTION_FAILED, Outcome.EXECUTION_FAILED]);
    // Drop the evaluation is impossible: the ledger keeps it. A separate expectation is recorded and
    // left unevaluated so the awaiting state is real rather than simulated.
    const pending = await app.controller.predictionRecord({
      capability: 'calc.evaluate', expectation: 'success', subject: 'an expectation still waiting', inDays: 1,
    });
    const pendingId = data(pending).id;
    now.advance(1);
    await observed(app, CALC_SUCCESS);
    now.advance(3);
    assert.equal((await app.predictions.detail(pendingId)).status, 'awaiting_evaluation');
    const expiring = await app.controller.predictionRecord({
      capability: 'calc.evaluate', expectation: 'success', subject: 'a horizon that passes', inDays: 1,
    });
    const expiringId = data(expiring).id;
    now.advance(2);
    assert.equal((await app.predictions.detail(expiringId)).status, 'expired');

    const { report } = await longitudinal(app, 'calc.evaluate');
    const group = report.groups[0];
    // Two evaluated failures and nothing else scored: the awaiting and expired expectations carry no
    // evaluation and are excluded by their own names, so they never enter the sequence.
    assert.equal(group.pattern.kind, 'repeated_failure');
    assert.equal(group.pattern.proposalField, 'avoid');
    assert.equal(group.counts.eligibleScored, 2);
    assert.equal(group.counts.failure, 2);
    assert.equal(group.counts.success, 0);
    assert.equal(group.counts.byExclusionState.awaiting_evaluation, 1);
    assert.equal(group.counts.byExclusionState.expired, 1);
    const waiting = group.exclusions.find((e) => e.predictionId === pendingId);
    assert.equal(waiting.state, 'awaiting_evaluation');
    assert.equal(waiting.evaluated, false, 'a missing evaluation is not a failure');
    const expired = group.exclusions.find((e) => e.predictionId === expiringId);
    assert.equal(expired.state, 'expired');
    assert.match(expired.reason, /horizon passed/i);

    // The repeated failure is the one rule that may be proposed, and it still is only a candidate.
    const derived = data(await app.controller.adaptationDerive({}));
    const longitudinalCreated = derived.created.filter((c) => c.method === LONGITUDINAL_DERIVATION_METHOD);
    assert.equal(longitudinalCreated.length, 1, JSON.stringify(derived.created));
    const candidate = await app.experience.adaptationDetail(longitudinalCreated[0].id);
    assert.equal(candidate.proposal.pattern.kind, 'repeated_failure');
    assert.deepEqual(candidate.proposal.guidance.avoid, ['calc.evaluate']);
    assert.deepEqual(candidate.proposal.guidance.prefer, []);
    assert.equal(candidate.decisionState, 'candidate');
    assert.equal(candidate.active, false);
  });

  test('alternating and mixed sequences propose no aggregated rule', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const kinds = [];
    for (const action of [CALC_SUCCESS, CALC_FAILURE, CALC_SUCCESS]) {
      const item = await evaluated(app, now, { action });
      kinds.push(item.verdict);
    }
    const { report, display: text } = await longitudinal(app, 'calc.evaluate');
    const group = report.groups[0];
    assert.equal(group.pattern.kind, 'alternating_outcomes');
    assert.equal(group.pattern.sufficient, false);
    assert.equal(group.counts.eligibleScored, 3);
    assert.match(text, /\(proposes nothing\)/);

    const derived = data(await app.controller.adaptationDerive({}));
    assert.deepEqual(derived.created.filter((c) => c.method === LONGITUDINAL_DERIVATION_METHOD), []);
    // The scope falls through to the single-evaluation path, and any candidate it makes says so.
    assert.ok(derived.created.every((c) => c.method !== LONGITUDINAL_DERIVATION_METHOD));
    assert.equal(derived.prediction.longitudinal.supported, 0);
  });

  test('a conflict between current and withdrawn evidence is disclosed and withholds the rule', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const failed = await evaluated(app, now, { action: CALC_FAILURE });
    const first = await evaluated(app, now, { action: CALC_SUCCESS });
    const second = await evaluated(app, now, { action: CALC_SUCCESS });
    assert.equal((await app.controller.predictionInvalidate({ target: failed.predictionId, reason: 'that attempt was not comparable' })).status, Outcome.SUCCESS_VERIFIED);

    const { report, display: text } = await longitudinal(app, 'calc.evaluate');
    const group = report.groups[0];
    assert.equal(group.pattern.kind, 'conflicting_evidence');
    assert.equal(group.pattern.sufficient, false);
    assert.equal(group.counts.eligibleScored, 2);
    assert.equal(group.counts.excludedEvaluated, 1);
    assert.deepEqual(group.exclusions.map((e) => [e.predictionId, e.state, e.outcomeClass]), [
      [failed.predictionId, 'invalidated', 'failure'],
    ]);
    assert.match(text, /conflicting_evidence/);
    assert.deepEqual([first.verdict, second.verdict], ['matched', 'matched']);

    const derived = data(await app.controller.adaptationDerive({}));
    assert.deepEqual(derived.created.filter((c) => c.method === LONGITUDINAL_DERIVATION_METHOD), []);
    assert.equal(derived.prediction.longitudinal.supported, 0);
  });

  test('nineteen scored evaluations do not state a rate; twenty do, and neither chooses the pattern', async () => {
    const scored = async (count) => {
      const d = dir();
      const now = clock();
      const app = await appIn(d, now);
      for (let i = 0; i < count; i += 1) {
        const recorded = await app.controller.predictionRecord({
          capability: 'calc.evaluate', expectation: 'success', subject: `calibration expectation ${i}`, inDays: 1,
        });
        assert.equal(recorded.status, Outcome.SUCCESS_VERIFIED, recorded.output);
        const id = data(recorded).id;
        now.advance(1);
        await observed(app, CALC_SUCCESS);
        const evaluatedRes = await app.controller.predictionEvaluate({ target: id });
        assert.equal(evaluatedRes.status, Outcome.SUCCESS_VERIFIED, evaluatedRes.output);
        now.advance(1);
      }
      const { report } = await longitudinal(app, 'calc.evaluate');
      return report.groups[0];
    };

    const nineteen = await scored(19);
    assert.equal(nineteen.counts.eligibleScored, 19);
    assert.equal(nineteen.calibration.available, false);
    assert.equal(nineteen.calibration.value, null);
    assert.equal(nineteen.calibration.denominator, 19);
    assert.equal(nineteen.calibration.requiredForRate, 20);
    assert.match(nineteen.calibration.reason, /below 20/);
    assert.equal(nineteen.calibration.usedForPattern, false, 'calibration availability is not an input to the pattern');
    assert.equal(nineteen.pattern.kind, 'repeated_success');

    const twenty = await scored(20);
    assert.equal(twenty.counts.eligibleScored, 20);
    assert.equal(twenty.calibration.available, true);
    assert.equal(twenty.calibration.value, 1);
    assert.equal(twenty.calibration.numerator, 20);
    assert.equal(twenty.calibration.denominator, 20);
    assert.equal(twenty.calibration.requiredForRate, 20);
    assert.equal(twenty.calibration.usedForPattern, false);
    assert.equal(twenty.calibration.confidence.available, false, 'calibration is not a confidence');
    assert.equal(twenty.pattern.kind, 'repeated_success', 'the rate did not create or strengthen the pattern');
    assert.equal(twenty.pattern.confidence, null);
  });

  test('unrelated capabilities are not merged, and one capability below the repeat count proposes nothing', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    await evaluated(app, now, { action: CALC_SUCCESS });
    await evaluated(app, now, { capability: 'memory.add', action: successMemory() });

    const { report } = await longitudinal(app);
    assert.deepEqual(report.groups.map((g) => g.capability), ['calc.evaluate', 'memory.add']);
    for (const group of report.groups) {
      assert.equal(group.pattern.kind, 'insufficient_evidence');
      assert.equal(group.pattern.sufficient, false);
      assert.equal(group.counts.eligibleScored, 1);
      assert.equal(longitudinalProposalFor(group), null);
    }
    assert.equal(report.totals.eligibleScored, 2);
    const derived = data(await app.controller.adaptationDerive({}));
    assert.deepEqual(derived.created.filter((c) => c.method === LONGITUDINAL_DERIVATION_METHOD), []);
  });

  test('an arbitrary hand-edited longitudinal candidate is refused, not read', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    await evaluated(app, now, { action: CALC_SUCCESS });
    await evaluated(app, now, { action: CALC_SUCCESS });
    await app.controller.adaptationDerive({});
    const raw = lines(d, 'experiences.jsonl').find((r) => r.kind === 'adaptation');
    assert.ok(raw, 'the derivation wrote a candidate');
    assert.equal(validateExperienceRecord(raw), null);

    const wrongType = { ...raw, proposal: { ...raw.proposal, type: 'arbitrary_text' } };
    assert.match(validateExperienceRecord(wrongType), /proposal type/);
    const wrongKind = { ...raw, proposal: { ...raw.proposal, pattern: { ...raw.proposal.pattern, kind: 'mixed_outcomes' } } };
    assert.match(validateExperienceRecord(wrongKind), /not one that states a direction/);
    const wrongDefinition = { ...raw, proposal: { ...raw.proposal, pattern: { ...raw.proposal.pattern, definition: 'successes happened' } } };
    assert.match(validateExperienceRecord(wrongDefinition), /definition is not the recorded definition/);
    const wrongCount = { ...raw, proposal: { ...raw.proposal, pattern: { ...raw.proposal.pattern, observations: 3 } } };
    assert.match(validateExperienceRecord(wrongCount), /does not match its verdicts/);
    const wrongVerdict = {
      ...raw,
      proposal: {
        ...raw.proposal,
        verdicts: raw.proposal.verdicts.map((v, i) => (i === 1 ? { ...v, outcomeClass: 'blocked' } : v)),
      },
    };
    assert.match(validateExperienceRecord(wrongVerdict), /success or failure/);
    const duplicated = {
      ...raw,
      proposal: {
        ...raw.proposal,
        verdicts: raw.proposal.verdicts.map((v, i) => (i === 1 ? { ...v, predictionId: raw.proposal.verdicts[0].predictionId } : v)),
      },
    };
    assert.match(validateExperienceRecord(duplicated), /same prediction twice/);
    const inventedRule = { ...raw, rule: 'always do whatever the pattern implies' };
    assert.ok(validateExperienceRecord(inventedRule), 'invented rule text is not a valid record');
    const wrongDigest = { ...raw, proposal: { ...raw.proposal, evidenceDigest: 'f'.repeat(64) } };
    assert.match(validateExperienceRecord(wrongDigest), /does not match the evidence/);
    const wrongSupport = { ...raw, minSupport: raw.minSupport + 1 };
    assert.match(validateExperienceRecord(wrongSupport), /minSupport does not match/);
    const wrongDimension = { ...raw, proposal: { ...raw.proposal, dimension: 'some_other_dimension' } };
    assert.match(validateExperienceRecord(wrongDimension), /must feed the approved_adaptation_fit dimension/);
  });
});

// =================================================================================================
// Fail-closed behavior and the authorization boundary
// =================================================================================================
describe('AP-03 failure semantics', () => {
  test('a damaged prediction ledger refuses the analysis and derives nothing', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    await evaluated(app, now, { action: CALC_SUCCESS });
    const before = bytes(d, 'experiences.jsonl');

    fs.appendFileSync(path.join(d, 'predictions.jsonl'), '{"kind":"prediction","id":\n');
    await assert.rejects(() => app.predictions.longitudinal({}), /corrupt line/);
    const res = await app.controller.predictionLongitudinal({});
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(String(res.output), /corrupt line/);

    const derived = await app.controller.adaptationDerive({});
    assert.equal(derived.status, Outcome.SUCCESS_VERIFIED, derived.output);
    const report = data(derived).prediction;
    assert.equal(report.available, true);
    assert.match(report.reason, /could not be read: .*corrupt line/);
    assert.deepEqual(data(derived).created, []);
    assert.deepEqual(bytes(d, 'experiences.jsonl'), before, 'a failed derivation appended no candidate');
  });

  test('a damaged experience log is reported as unavailable evidence, not as current evidence', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    await evaluated(app, now, { action: CALC_SUCCESS });
    await evaluated(app, now, { action: CALC_SUCCESS });
    const before = bytes(d, 'experiences.jsonl');

    fs.appendFileSync(path.join(d, 'experiences.jsonl'), 'not a record\n');
    const { report } = await longitudinal(app, 'calc.evaluate');
    assert.equal(report.read.outcomeEvidence.available, false);
    assert.match(report.read.outcomeEvidence.reason, /corrupt line/);
    const group = report.groups[0];
    assert.equal(group.counts.eligibleScored, 0, 'an unreadable log is not shown as current evidence');
    assert.ok(group.exclusions.length >= 2);
    assert.ok(group.exclusions.every((e) => e.state === 'evidence_unavailable'));
    assert.equal(group.pattern.sufficient, false);
    assert.equal(report.authorizes, false);

    const derived = await app.controller.adaptationDerive({});
    assert.equal(derived.status, Outcome.EXECUTION_FAILED);
    assert.match(String(derived.output), /corrupt line/);
    assert.equal(bytes(d, 'experiences.jsonl').length, before.length + 'not a record\n'.length, 'the failed derive appended nothing');
  });

  test('model-origin evidence cannot be aggregated, approved, or used to plan', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    await evaluated(app, now, { action: CALC_SUCCESS });
    await evaluated(app, now, { action: CALC_SUCCESS });
    const [candidate] = data(await app.controller.adaptationDerive({})).created;

    await assert.rejects(
      () => app.predictions.recordPrediction({
        capability: 'calc.evaluate', expectation: 'success', subject: 'the model expects this',
        expiresAt: new Date(Date.parse(now.iso()) + 86_400_000).toISOString(), origin: 'model',
      }),
      /requires an authorized user-origin operation/,
    );
    const before = lines(d, 'experiences.jsonl').filter((r) => r.kind === 'adaptation').length;
    for (const [action, input] of [
      ['adaptation.derive', {}],
      ['adaptation.decide', { target: candidate.id, decision: 'approved' }],
      ['adaptation.guide', { target: candidate.id, order: 'reads_first' }],
      ['adaptation.retire', { target: candidate.id, reason: 'the model says so' }],
    ]) {
      const step = await app.controller.runAction(action, input, 'model', `ap03-model-${action.replace('.', '-')}`);
      assert.equal(step.outcome, Outcome.ACTION_DENIED, action);
      assert.equal(step.execution.status, 'not_run', action);
      assert.equal(step.authorization.reason, 'ORIGIN_NOT_PERMITTED', action);
    }
    // A model may run the read, and the read derives nothing.
    const read = await app.controller.runAction('prediction.longitudinal', {}, 'model', 'ap03-model-read');
    assert.equal(read.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(lines(d, 'experiences.jsonl').filter((r) => r.kind === 'adaptation').length, before);
    assert.deepEqual(await app.experience.activeAdaptations({ limit: 5 }).then((r) => r.adaptations), []);
    assert.equal((await app.experience.adaptationDetail(candidate.id)).decisionState, 'candidate');
  });

  test('an aggregate result cannot bypass plan authorization, approval, execution, or verification', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    await evaluated(app, now, { capability: 'memory.add', action: successMemory() });
    await evaluated(app, now, { capability: 'memory.add', action: successMemory() });
    const goalId = await newGoal(app);
    const [candidate] = data(await app.controller.adaptationDerive({})).created;
    await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });

    const definition = JSON.stringify(app.registry.get('memory.add'));
    const read = data(await app.controller.planCandidates({ goal: goalId }));
    assert.equal(read.adaptationDecision.applied, true);
    assert.equal(read.recorded, false);
    assert.equal(read.approved, false);
    assert.equal(read.executable, false);
    assert.deepEqual(await app.plans.list(), [], 'an influenced comparison stored no plan');
    assert.deepEqual(await app.taskStore.list(), [], 'an influenced comparison started no task');
    assert.equal(JSON.stringify(app.registry.get('memory.add')), definition, 'the capability definition did not move');
    assert.deepEqual(app.registry.get('memory.add').origins, ['user']);

    const denied = await app.controller.runAction('memory.add', { content: 'the model wrote this itself' }, 'model', 'ap03-model-write');
    assert.equal(denied.outcome, Outcome.ACTION_DENIED);
    assert.equal(denied.execution.status, 'not_run');
    assert.equal(denied.authorization.reason, 'ORIGIN_NOT_PERMITTED');
    assert.equal(read.adaptationDecision.authorizes, false);
  });
});

// =================================================================================================
// Currentness: invalidation, staleness, concurrency, and retirement restore the baseline
// =================================================================================================
describe('AP-03 currentness through the real comparison', () => {
  test('end to end: outcomes, analysis, pattern disclosure, calibration, candidate, approval, influence, invalidation, baseline', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const first = await evaluated(app, now, { capability: 'memory.add', action: successMemory() });
    const second = await evaluated(app, now, { capability: 'memory.add', action: successMemory() });
    assert.deepEqual([first.verdict, second.verdict], ['matched', 'matched']);
    const ledgerAfterEvaluations = bytes(d, 'predictions.jsonl');

    const goalId = await newGoal(app);
    const baselineData = data(await app.controller.planCandidates({ goal: goalId }));
    const baseline = baselineData.adaptationDecision;
    assert.equal(baseline.applied, false);
    assert.deepEqual(baseline.before, baseline.after);

    const { report, display: analysisText } = await longitudinal(app, 'memory.add');
    const group = report.groups[0];
    assert.equal(group.pattern.kind, 'repeated_success');
    assert.equal(group.counts.eligibleScored, 2);
    assert.equal(group.calibration.available, false);
    assert.match(group.calibration.reason, /below 20/);
    assert.match(analysisText, /pattern:        repeated_success/);
    assert.match(analysisText, /not a cause; not a confidence; not an instruction/);

    const derived = data(await app.controller.adaptationDerive({}));
    const candidate = derived.created.find((c) => c.capability === 'memory.add');
    assert.ok(candidate, JSON.stringify(derived.created));
    assert.equal(candidate.method, LONGITUDINAL_DERIVATION_METHOD);
    assert.match(candidate.rule, /2 recorded outcomes in this scope were each a success/);
    assert.equal(derived.created.length, 1, 'the scope is answered by its pattern, not also by each member');

    const unapproved = data(await app.controller.planCandidates({ goal: goalId })).adaptationDecision;
    assert.equal(unapproved.applied, false);
    assert.equal(unapproved.considered.find((c) => c.id === candidate.id).state, 'candidate');

    assert.equal((await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved', reason: 'this is the order I want' })).status, Outcome.SUCCESS_VERIFIED);
    const influencedRes = await app.controller.planCandidates({ goal: goalId });
    const influenced = data(influencedRes).adaptationDecision;
    assert.equal(influenced.dimension, ADAPTATION_DECISION_DIMENSION);
    assert.equal(influenced.applied, true);
    assert.equal(influenced.changed, true, JSON.stringify(influenced));
    assert.deepEqual(influenced.before, baseline.after, 'the counterfactual is the unadapted decision');
    assert.deepEqual(influenced.rules.map((r) => r.id), [candidate.id]);
    assert.equal(influenced.rules[0].basis, 'longitudinal_pattern');
    assert.equal(influenced.rules[0].pattern.kind, 'repeated_success');
    assert.equal(influenced.rules[0].pattern.observations, 2);
    assert.deepEqual(influenced.rules[0].support.predictionIds, [first.predictionId, second.predictionId]);
    assert.deepEqual(influenced.rules[0].support.evaluationIds, [first.evaluationId, second.evaluationId]);
    assert.deepEqual(influenced.sources.longitudinalDerived, [candidate.id]);
    assert.deepEqual(influenced.sources.singleEvaluationDerived, []);
    assert.equal(influenced.sources.predictionEvidence, 'prediction_derived');
    assert.equal(influenced.sources.predictionConsidered, 1);
    assert.equal(influenced.authorizes, false);
    assert.equal(data(influencedRes).candidateSetDigest, baselineData.candidateSetDigest);
    assert.deepEqual(data(influencedRes).comparison.gates, baselineData.comparison.gates);
    assert.deepEqual(data(influencedRes).comparison.rankedDimensions, baselineData.comparison.rankedDimensions);
    assert.equal(data(influencedRes).recorded, false);
    assert.equal(data(influencedRes).approved, false);
    assert.equal(data(influencedRes).executable, false);
    assert.deepEqual(await app.plans.list(), []);
    assert.match(display(influencedRes), /longitudinal-pattern-derived/);
    assert.match(display(influencedRes), /of the prediction-derived records: longitudinal pattern/);

    const audited = JSON.parse(bytes(d, 'operations.jsonl').toString('utf8').trim().split('\n').at(-1));
    assert.deepEqual(audited.steps[0].result.data.adaptationDecision.evidence.predictionIds, [first.predictionId, second.predictionId]);
    assert.deepEqual(await app.experience.activeAdaptations({ limit: 5 }).then((r) => r.adaptations.map((a) => a.id)), [candidate.id]);

    // One supporting evaluation is withdrawn. The approval stands, the evidence does not, and the
    // unadapted decision returns without anything being rewritten.
    assert.equal((await app.controller.predictionInvalidate({ target: first.predictionId, reason: 'that attempt was not comparable' })).status, Outcome.SUCCESS_VERIFIED);
    const restored = data(await app.controller.planCandidates({ goal: goalId }));
    assert.equal(restored.adaptationDecision.applied, false);
    assert.equal(restored.adaptationDecision.outcome, 'declined');
    assert.deepEqual(restored.adaptationDecision.before, restored.adaptationDecision.after);
    assert.deepEqual(restored.adaptationDecision.after, baseline.after, 'invalidation restores the unadapted decision');
    assert.deepEqual(restored.adaptationDecision.sources.longitudinalDerived, []);
    assert.equal(restored.adaptationDecision.sources.predictionEvidence, 'prediction_rejected');
    const considered = restored.adaptationDecision.considered.find((c) => c.id === candidate.id);
    assert.equal(considered.state, 'stale');
    assert.equal(considered.predictionEvidence.state, 'invalidated');
    assert.match(considered.why, /prediction evidence/);
    assert.equal(restored.candidateSetDigest, baselineData.candidateSetDigest);
    assert.deepEqual(await app.experience.activeAdaptations({ limit: 5 }).then((r) => r.adaptations), []);

    const afterWithdrawal = await longitudinal(app, 'memory.add');
    assert.equal(afterWithdrawal.report.groups[0].counts.eligibleScored, 1);
    assert.equal(afterWithdrawal.report.groups[0].pattern.kind, 'insufficient_evidence');
    assert.deepEqual(afterWithdrawal.report.groups[0].counts.byExclusionState, { invalidated: 1 });
    const noNew = data(await app.controller.adaptationDerive({}));
    assert.deepEqual(noNew.created.filter((c) => c.method === LONGITUDINAL_DERIVATION_METHOD), []);
    assert.equal(noNew.prediction.longitudinal.supported, 0);

    // The lineage is intact and the ledger was only appended to.
    const ledgerNow = bytes(d, 'predictions.jsonl');
    assert.ok(ledgerNow.length > ledgerAfterEvaluations.length);
    assert.ok(ledgerNow.subarray(0, ledgerAfterEvaluations.length).equals(ledgerAfterEvaluations));
    assert.equal((await app.predictions.detail(first.predictionId)).status, 'invalidated');
    assert.equal((await app.predictions.detail(second.predictionId)).status, 'evaluated');
    const detail = await app.experience.adaptationDetail(candidate.id);
    assert.equal(detail.decisionState, 'approved', 'the user\'s decision is not rewritten');
    assert.equal(detail.active, false);
    assert.deepEqual(detail.support.predictionIds, [first.predictionId, second.predictionId]);
    assert.equal(lines(d, 'experiences.jsonl').filter((r) => r.kind === 'adaptation_decision').length, 1);
  });

  test('the batched currentness read answers exactly what one read per citation answered', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    for (let i = 0; i < 3; i += 1) await evaluated(app, now, { capability: 'memory.add', action: successMemory() });
    const goalId = await newGoal(app);
    const [candidate] = data(await app.controller.adaptationDerive({})).created;
    assert.equal(candidate.method, LONGITUDINAL_DERIVATION_METHOD);
    await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });

    // `details` resolves each reference by the same rule `detail` applies, including both refusals.
    const stored = await app.experience.adaptationDetail(candidate.id);
    const ids = stored.support.predictionIds;
    assert.equal(ids.length, 3);
    const batch = await app.predictions.details([...ids, 'no-such-prediction']);
    assert.equal(batch.size, ids.length + 1);
    for (const id of ids) assert.deepEqual(batch.get(id), { projection: await app.predictions.detail(id) });
    await assert.rejects(() => app.predictions.detail('no-such-prediction'), /no prediction record matches/);
    assert.match(batch.get('no-such-prediction').error, /no prediction record matches/);

    // The same reads through the store with the batched path, and with it removed so every citation is
    // read on its own. The rows, the currentness judgment, and the status counts must be identical.
    const batched = {
      active: await app.experience.activeAdaptations({ limit: 5 }),
      all: await app.experience.adaptations({ includeRetired: true }),
      detail: await app.experience.adaptationDetail(candidate.id),
      status: await app.experience.status(),
    };
    assert.equal(batched.active.adaptations[0].id, candidate.id);
    assert.equal(batched.active.adaptations[0].predictionEvidence.state, 'eligible');
    const ledger = app.experience.predictions;
    ledger.details = undefined;
    try {
      const perCitation = {
        active: await app.experience.activeAdaptations({ limit: 5 }),
        all: await app.experience.adaptations({ includeRetired: true }),
        detail: await app.experience.adaptationDetail(candidate.id),
        status: await app.experience.status(),
      };
      assert.deepEqual(perCitation, batched);
    } finally {
      delete ledger.details;
    }
    assert.equal(typeof app.experience.predictions.details, 'function');

    // A later withdrawal still makes the batched read judge the rule inert, so batching changed the
    // number of reads and nothing about what the reads conclude.
    await app.controller.predictionInvalidate({ target: ids[0], reason: 'that attempt was not comparable' });
    const after = await app.experience.activeAdaptations({ limit: 5 });
    assert.deepEqual(after.adaptations, []);
    assert.equal((await app.experience.status()).predictionEvidenceStale, 1);
  });

  test('a later outcome inside a cited horizon makes an approved candidate inert until reconciled', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const long = await evaluated(app, now, { capability: 'memory.add', action: successMemory(), inDays: 7 });
    const short = await evaluated(app, now, { capability: 'memory.add', action: successMemory() });
    const goalId = await newGoal(app);
    const [candidate] = data(await app.controller.adaptationDerive({})).created;
    assert.equal(candidate.method, LONGITUDINAL_DERIVATION_METHOD);
    await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    const applied = data(await app.controller.planCandidates({ goal: goalId })).adaptationDecision;
    assert.equal(applied.applied, true);

    // The first expectation's horizon is still open. A blocked outcome there means a fresh read would
    // settle it differently; the recorded verdict stands, and the candidate loses its effect.
    const blocked = await observed(app, BLOCKED_MEMORY);
    assert.equal(blocked.status, Outcome.INPUT_REJECTED);
    assert.equal(blocked.experience.capability, 'memory.add');
    assert.equal((await app.predictions.detail(long.predictionId)).evaluationStale, true);

    const after = data(await app.controller.planCandidates({ goal: goalId })).adaptationDecision;
    assert.equal(after.applied, false);
    assert.deepEqual(after.before, after.after);
    assert.equal(after.sources.predictionEvidence, 'prediction_rejected');
    const considered = after.considered.find((c) => c.id === candidate.id);
    assert.equal(considered.state, 'stale');
    assert.equal(considered.predictionEvidence.state, 'evaluation_stale');
    assert.match(considered.why, /prediction evidence/);
    assert.equal((await app.experience.adaptationDetail(candidate.id)).decisionState, 'approved');
    assert.equal((await app.experience.adaptationDetail(candidate.id)).active, false);

    const { report } = await longitudinal(app, 'memory.add');
    assert.equal(report.groups[0].counts.byExclusionState.evaluation_stale, 1);
    assert.equal(report.groups[0].counts.eligibleScored, 1);
    assert.equal(report.groups[0].pattern.kind, 'insufficient_evidence');
    assert.deepEqual([short.verdict, long.verdict], ['matched', 'matched']);
  });

  test('concurrent withdrawals cannot let a stale aggregation influence a decision', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const first = await evaluated(app, now, { capability: 'memory.add', action: successMemory() });
    const second = await evaluated(app, now, { capability: 'memory.add', action: successMemory() });
    const goalId = await newGoal(app);
    const baseline = data(await app.controller.planCandidates({ goal: goalId })).adaptationDecision;
    const [candidate] = data(await app.controller.adaptationDerive({})).created;
    await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    assert.equal(data(await app.controller.planCandidates({ goal: goalId })).adaptationDecision.applied, true);

    const results = await Promise.all([
      app.controller.predictionInvalidate({ target: first.predictionId, reason: 'concurrent withdrawal one' }),
      app.controller.predictionInvalidate({ target: second.predictionId, reason: 'concurrent withdrawal two' }),
    ]);
    for (const res of results) assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    assert.equal((await app.predictions.detail(first.predictionId)).status, 'invalidated');
    assert.equal((await app.predictions.detail(second.predictionId)).status, 'invalidated');

    const after = data(await app.controller.planCandidates({ goal: goalId })).adaptationDecision;
    assert.equal(after.applied, false);
    assert.deepEqual(after.before, after.after);
    assert.deepEqual(after.after, baseline.after);
    assert.deepEqual(after.sources.longitudinalDerived, []);
    assert.deepEqual(await app.experience.activeAdaptations({ limit: 5 }).then((r) => r.adaptations), []);
  });

  test('retirement restores the baseline while the recorded evidence stays readable', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const first = await evaluated(app, now, { capability: 'memory.add', action: successMemory() });
    const second = await evaluated(app, now, { capability: 'memory.add', action: successMemory() });
    const goalId = await newGoal(app);
    const baselineData = data(await app.controller.planCandidates({ goal: goalId }));
    const baseline = baselineData.adaptationDecision;
    const [candidate] = data(await app.controller.adaptationDerive({})).created;
    await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    assert.equal(data(await app.controller.planCandidates({ goal: goalId })).adaptationDecision.applied, true);

    assert.equal((await app.controller.adaptationRetire({ target: candidate.id, reason: 'not how I work any more' })).status, Outcome.SUCCESS_VERIFIED);
    const after = data(await app.controller.planCandidates({ goal: goalId }));
    assert.equal(after.adaptationDecision.applied, false);
    assert.equal(after.adaptationDecision.outcome, 'declined');
    assert.deepEqual(after.adaptationDecision.before, after.adaptationDecision.after);
    assert.deepEqual(after.adaptationDecision.after, baseline.after, 'retirement restores the unadapted decision');
    assert.equal(after.adaptationDecision.considered.find((c) => c.id === candidate.id).state, 'retired');
    assert.equal(after.candidateSetDigest, baselineData.candidateSetDigest);
    assert.deepEqual(await app.experience.activeAdaptations({ limit: 5 }).then((r) => r.adaptations), []);

    // The evidence itself was not withdrawn, so the analysis still describes the pattern.
    const { report } = await longitudinal(app, 'memory.add');
    assert.equal(report.groups[0].pattern.kind, 'repeated_success');
    assert.deepEqual(report.groups[0].evidenceRefs.predictionIds, [first.predictionId, second.predictionId]);
    assert.equal((await app.predictions.detail(first.predictionId)).status, 'evaluated');
    assert.equal((await app.predictions.detail(second.predictionId)).status, 'evaluated');

    const detail = await app.experience.adaptationDetail(candidate.id);
    assert.equal(detail.decisionState, 'retired');
    assert.equal(detail.retirement.reason, 'not how I work any more');
    assert.deepEqual(detail.support.predictionIds, [first.predictionId, second.predictionId]);
    assert.deepEqual(detail.support.evaluationIds, [first.evaluationId, second.evaluationId]);
    assert.equal(detail.decisions.length, 1);
    assert.equal(lines(d, 'experiences.jsonl').filter((r) => r.kind === 'adaptation').length, 1);
    assert.equal(lines(d, 'experiences.jsonl').filter((r) => r.kind === 'adaptation_retirement').length, 1);
  });
});
