// Batch AP-02: an evaluated prediction as learning evidence, one user approval, one decision.
//
// Batch AP-01 let one user-approved adaptation, shaped by a guidance record the user wrote, move the
// ordered dimension `approved_adaptation_fit` in a candidate comparison. This suite covers the second,
// separate derivation: a prediction the user recorded and a deterministic evaluation later judged can
// propose one bounded candidate in the same typed guidance vocabulary, and that candidate changes a
// later comparison only after the user approves it - and only in the same one dimension.
//
// What is real here: the assembled app, the prediction and experience stores with their write locks
// and validators, the derivation rules, the action registry's authorization, the independent verifiers,
// the audit log, and the comparison. The only test doubles are a NoBackend gateway (the existing
// deterministic infrastructure), a gateway stub that is never called, and two injected store failures
// used to prove fail-closed behavior. No model is contacted, no inference is run, and nothing here is
// described as a prediction APEX made on its own: every expectation is the user's own record.
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
  PREDICTION_DERIVATION_METHOD, PREDICTION_DECISION_DIMENSION, PREDICTION_PROPOSAL_TYPE,
  predictionEligibility,
} from '../src/experience/prediction-derivation.js';
import {
  ADAPTATION_DECISION_DIMENSION, evaluateCandidates, renderAdaptationDecision,
} from '../src/plans/evaluation.js';
import { guidanceFrom } from '../src/plans/guidance.js';
import { selectCandidate } from '../src/executive/selection.js';
import { planRisk, validatePlanContent } from '../src/plans/model.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
const dir = () => { const d = makeTempDataDir(); dirs.push(d); return d; };

// A clock the tests move rather than sleep: a horizon is a statement about time.
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

// One outcome the evaluation can read. A refused write is an outcome of a different class (blocked),
// which is what lets the same success expectation be contradicted without inventing an observation.
let note = 0;
async function outcomeExperience(app, outcome) {
  note += 1;
  const text = outcome === 'success'
    ? `remember that the AP02 note ${note} holds`
    : 'remember that the token is sk-synthetic-abcdef0123456789';
  const res = await app.controller.handle(text, { origin: 'user' });
  assert.equal(res.status, outcome === 'success' ? Outcome.SUCCESS_VERIFIED : Outcome.INPUT_REJECTED, res.output);
  const recorded = await app.controller.experienceRecord({ operationId: res.operation.id, subject: `an AP02 ${outcome} outcome` });
  assert.equal(recorded.status, Outcome.SUCCESS_VERIFIED, recorded.output);
  return data(recorded);
}

// The complete evidence chain: the user's expectation, the outcome record, and the deterministic
// evaluation of the two. Nothing here approves, derives, or changes a plan.
async function evaluatedPrediction(app, now, {
  capability = 'memory.add', expectation = 'success', outcome = 'success', days = 7,
} = {}) {
  const recorded = await app.controller.predictionRecord({
    capability, expectation, subject: `an expectation about ${capability}`, inDays: days,
  });
  assert.equal(recorded.status, Outcome.SUCCESS_VERIFIED, recorded.output);
  const predictionId = data(recorded).id;
  now.advance(1);
  const experience = await outcomeExperience(app, outcome);
  const evaluated = await app.controller.predictionEvaluate({ target: predictionId });
  assert.equal(evaluated.status, Outcome.SUCCESS_VERIFIED, evaluated.output);
  const result = data(evaluated);
  assert.equal(result.recorded, true, evaluated.output);
  return {
    predictionId,
    evaluationId: result.evaluationId,
    experienceId: experience.id,
    verdict: result.verdict,
  };
}

const candidateFor = async (app, predictionId) => (await app.experience.adaptations({ limit: 20 }))
  .find((a) => (a.support?.predictionIds ?? []).includes(predictionId)) ?? null;

describe('AP-02 eligibility: only a completed, current, user-recorded evaluation can propose', () => {
  test('a matched evaluation is eligible and proposes one typed, bounded rule', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const { predictionId, evaluationId } = await evaluatedPrediction(app, now);

    const inspection = await app.controller.adaptationEligibility({});
    assert.equal(inspection.status, Outcome.SUCCESS_VERIFIED, inspection.output);
    const report = data(inspection).report;
    assert.equal(report.available, true);
    assert.equal(report.considered.length, 1);
    const [row] = report.considered;
    assert.equal(row.predictionId, predictionId);
    assert.equal(row.eligible, true);
    assert.equal(row.state, 'eligible');
    assert.equal(row.status, 'evaluated');
    assert.equal(row.verdict, 'matched');
    assert.equal(row.outcomeClass, 'success');
    assert.equal(row.proposal.type, PREDICTION_PROPOSAL_TYPE);
    assert.equal(row.proposal.dimension, PREDICTION_DECISION_DIMENSION);
    assert.deepEqual(row.proposal.guidance.prefer, ['memory.add']);
    assert.deepEqual(row.proposal.guidance.avoid, []);
    assert.equal(row.proposal.guidance.order, null, 'a recorded outcome names no step order');
    assert.equal(row.proposal.guidance.maxSteps, null, 'a recorded outcome names no step bound');
    assert.equal(row.proposal.verdicts[0].evaluationId, evaluationId);
    assert.ok(row.proposal.limitations.length >= 1);
    assert.equal(row.proposal.evidenceDigest.length, 64);
    assert.equal(row.alreadyCandidate, false, 'the inspection derived nothing');
    assert.match(display(inspection), /ELIGIBLE/);
    assert.deepEqual(await app.experience.adaptations({ limit: 5 }), [], 'an eligible record is not yet a candidate');

    const derived = await app.controller.adaptationDerive({});
    assert.equal(derived.status, Outcome.SUCCESS_VERIFIED, derived.output);
    const created = data(derived).created;
    assert.equal(created.length, 1, JSON.stringify(created));
    const [summary] = created;
    assert.equal(summary.method, PREDICTION_DERIVATION_METHOD);
    assert.deepEqual(summary.support.predictionIds, [predictionId]);
    assert.deepEqual(summary.support.evaluationIds, [evaluationId]);
    assert.deepEqual(summary.support.feedbackIds, [], 'no feedback record was invented');

    // The derive answer is a summary; the stored record is what a later read and the decision use.
    const candidate = await app.experience.adaptationDetail(summary.id);
    assert.equal(candidate.minSupport, 1, 'one evaluation is one observation');
    assert.equal(candidate.method, PREDICTION_DERIVATION_METHOD);
    assert.equal(candidate.decisionState, 'candidate');
    assert.equal(candidate.active, false, 'a candidate the user has not approved is inert');
    assert.equal(data(derived).prediction.eligible, 1);
    assert.equal(candidate.proposal.evidenceDigest, row.proposal.evidenceDigest);
    assert.equal(candidate.rule, 'prefer work that names memory.add: the latest live recorded outcome inside the expectation\'s horizon was a success');
  });

  test('a contradicted expectation is eligible only through the same explicit outcome mapping', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const { predictionId, verdict } = await evaluatedPrediction(app, now, { outcome: 'blocked' });
    assert.equal(verdict, 'contradicted');

    const report = data(await app.controller.adaptationEligibility({})).report;
    const [row] = report.considered;
    assert.equal(row.eligible, true);
    assert.equal(row.verdict, 'contradicted');
    assert.equal(row.outcomeClass, 'blocked');
    assert.deepEqual(row.proposal.guidance.avoid, ['memory.add']);
    assert.deepEqual(row.proposal.guidance.prefer, [], 'a blocked outcome never proposes a preference');
    assert.match(row.proposal.limitations.join(' '), /single observation/);

    const created = data(await app.controller.adaptationDerive({})).created;
    assert.equal(created.length, 1);
    assert.match(created[0].rule, /^avoid work that names memory\.add: .* was blocked$/);
    assert.equal((await candidateFor(app, predictionId)).decisionState, 'candidate');
  });

  test('awaiting, expired, invalidated and superseded expectations are inert and say why', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);

    // Awaiting: outcome evidence exists, no evaluation was recorded.
    const awaiting = await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success', subject: 'awaiting an evaluation', inDays: 5,
    });
    const awaitingId = data(awaiting).id;
    now.advance(1);
    await outcomeExperience(app, 'success');

    // Expired: its horizon passes with nothing establishing it. The clock moves before it is recorded
    // so the earlier outcome lies outside its window; an outcome on the boundary would make it awaiting.
    now.advance(1);
    const expiring = await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success', subject: 'a horizon that passes', inDays: 1,
    });
    const expiringId = data(expiring).id;
    now.advance(2);
    assert.equal((await app.predictions.detail(expiringId)).status, 'expired');
    assert.equal((await app.predictions.detail(awaitingId)).status, 'awaiting_evaluation');

    const report = data(await app.controller.adaptationEligibility({})).report;
    for (const id of [awaitingId, expiringId]) {
      const row = report.considered.find((p) => p.predictionId === id);
      assert.equal(row.eligible, false, id);
      assert.equal(row.state, 'evaluation_missing');
      assert.equal(row.proposal, null);
    }
    const derived = data(await app.controller.adaptationDerive({}));
    assert.deepEqual(derived.created, [], 'neither an unevaluated nor an expired expectation proposes a rule');

    // Invalidated: an evaluated expectation the user withdrew.
    const withdrawn = await evaluatedPrediction(app, now);
    assert.equal((await app.controller.predictionInvalidate({ target: withdrawn.predictionId, reason: 'it was a guess' })).status, Outcome.SUCCESS_VERIFIED);
    // Superseded: an evaluated expectation a later record replaced.
    const replaced = await evaluatedPrediction(app, now);
    await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success', subject: 'the later expectation',
      inDays: 10, replaces: [replaced.predictionId],
    });
    const next = data(await app.controller.adaptationEligibility({})).report.considered;
    assert.equal(next.find((p) => p.predictionId === withdrawn.predictionId).state, 'invalidated');
    assert.equal(next.find((p) => p.predictionId === replaced.predictionId).state, 'superseded');
    assert.deepEqual(data(await app.controller.adaptationDerive({})).created.filter(
      (a) => (a.support?.predictionIds ?? []).some((id) => [withdrawn.predictionId, replaced.predictionId].includes(id)),
    ), [], 'neither a withdrawn nor a replaced expectation proposes a rule');
  });

  test('a stale evaluation and an unreadable ledger fail closed', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const evaluated = await evaluatedPrediction(app, now);
    assert.equal(evaluated.verdict, 'matched');

    // A later live outcome inside the same horizon would settle the expectation differently. The
    // recorded verdict stands and is disclosed as stale rather than rewritten; it is not evidence.
    now.advance(1);
    await outcomeExperience(app, 'blocked');
    const projection = await app.predictions.detail(evaluated.predictionId);
    assert.equal(projection.evaluationStale, true);
    const report = data(await app.controller.adaptationEligibility({})).report;
    const row = report.considered.find((p) => p.predictionId === evaluated.predictionId);
    assert.equal(row.eligible, false);
    assert.equal(row.state, 'evaluation_stale');
    assert.deepEqual(data(await app.controller.adaptationDerive({})).created, [], 'stale evidence proposes nothing');

    // A ledger that cannot be read is reported as unreadable, never as empty.
    const originalList = app.predictions.list;
    app.predictions.list = async () => { throw new StoreError('injected: the prediction ledger refused the read'); };
    let unreadable;
    try {
      unreadable = data(await app.controller.adaptationEligibility({})).report;
    } finally {
      app.predictions.list = originalList;
    }
    assert.equal(unreadable.available, true);
    assert.deepEqual(unreadable.considered, []);
    assert.match(unreadable.reason, /injected: the prediction ledger refused the read/);
    assert.equal(report.available, true);
  });

  test('an approved candidate loses its effect when the ledger behind it cannot be read', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const evaluated = await evaluatedPrediction(app, now);
    const [candidate] = data(await app.controller.adaptationDerive({})).created;
    await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved', reason: 'this is how I work' });
    assert.equal((await app.experience.activeAdaptations({ limit: 5 })).adaptations.length, 1);

    const originalDetail = app.predictions.detail;
    const originalDetails = app.predictions.details;
    const unreadableLedger = async () => { throw new StoreError('injected: the prediction ledger is unreadable'); };
    app.predictions.detail = unreadableLedger;
    app.predictions.details = unreadableLedger;
    let view;
    let detail;
    try {
      view = await app.experience.activeAdaptations({ limit: 5 });
      detail = await app.experience.adaptationDetail(candidate.id);
    } finally {
      app.predictions.detail = originalDetail;
      app.predictions.details = originalDetails;
    }
    assert.deepEqual(view.adaptations, [], 'unreadable evidence fails closed rather than staying active');
    assert.equal(detail.active, false);
    assert.equal(detail.predictionEvidence.eligible, false);
    assert.equal(detail.predictionEvidence.state, 'prediction_store_unavailable');
    assert.match(detail.inactiveReason, /prediction evidence no longer supports this candidate/);

    // The approval itself is still on record: the evidence moved, not the user's decision.
    const readable = await app.experience.adaptationDetail(candidate.id);
    assert.equal(readable.decisionState, 'approved');
    assert.equal(readable.active, true, 'a readable ledger restores the approved, current record');
    assert.equal(lines(d, 'experiences.jsonl').filter((r) => r.kind === 'adaptation_decision').length, 1);
    assert.equal((await app.predictions.detail(evaluated.predictionId)).status, 'evaluated');
  });

  test('a model origin cannot record, evaluate, derive, or decide prediction evidence', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const before = lines(d, 'predictions.jsonl').length;

    await assert.rejects(
      () => app.predictions.recordPrediction({
        capability: 'memory.add', expectation: 'success', subject: 'the model expects this',
        expiresAt: new Date(Date.parse(now.iso()) + 86_400_000).toISOString(), origin: 'model',
      }),
      /requires an authorized user-origin operation/,
    );
    const evaluated = await evaluatedPrediction(app, now);
    await assert.rejects(
      () => app.predictions.recordEvaluation({ target: evaluated.predictionId, origin: 'model' }),
      /requires an authorized user-origin operation/,
    );
    for (const [action, input] of [
      ['adaptation.derive', {}],
      ['adaptation.decide', { target: evaluated.predictionId, decision: 'approved' }],
      ['adaptation.guide', { target: evaluated.predictionId, order: 'reads_first' }],
      ['adaptation.retire', { target: evaluated.predictionId, reason: 'the model says so' }],
    ]) {
      const step = await app.controller.runAction(action, input, 'model', `ap02-model-${action.replace('.', '-')}`);
      assert.equal(step.outcome, Outcome.ACTION_DENIED, action);
      assert.equal(step.execution.status, 'not_run', action);
      assert.equal(step.authorization.reason, 'ORIGIN_NOT_PERMITTED', action);
    }
    assert.equal(lines(d, 'predictions.jsonl').length, before + 2, 'one expectation plus one evaluation, both user-origin');
    assert.deepEqual(lines(d, 'experiences.jsonl').filter((r) => r.kind === 'adaptation'), []);
  });

  test('a repeated derivation or a duplicated citation cannot amplify one evaluation', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const evaluated = await evaluatedPrediction(app, now);
    const first = data(await app.controller.adaptationDerive({}));
    assert.equal(first.created.length, 1);
    const after = bytes(d, 'experiences.jsonl');

    const second = data(await app.controller.adaptationDerive({}));
    assert.deepEqual(second.created, [], 'the same evaluation proposes no second candidate');
    assert.ok(second.skipped.some((s) => s.source === 'prediction' && /already states this rule/.test(s.reason)), JSON.stringify(second.skipped));
    assert.deepEqual(bytes(d, 'experiences.jsonl'), after, 'a repeated derivation appended nothing');
    assert.equal(second.prediction.created, 0);

    const report = data(await app.controller.adaptationEligibility({})).report;
    assert.equal(report.considered[0].alreadyCandidate, true);

    // A hand-edited line that cites the same prediction twice is refused before any reader sees it.
    const raw = lines(d, 'experiences.jsonl').find((r) => r.kind === 'adaptation');
    const duplicated = {
      ...raw,
      support: { ...raw.support, predictionIds: [evaluated.predictionId, evaluated.predictionId] },
    };
    const problem = validateExperienceRecord(duplicated);
    assert.ok(problem, 'a duplicated prediction citation is not a valid record');

    // A second evaluation of the same expectation is refused and writes nothing.
    const ledger = bytes(d, 'predictions.jsonl');
    await assert.rejects(
      () => app.predictions.recordEvaluation({ target: evaluated.predictionId, origin: 'user' }),
      /already has a recorded evaluation/,
    );
    assert.deepEqual(bytes(d, 'predictions.jsonl'), ledger);
  });

  test('an evaluation approves and derives nothing on its own', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const evaluated = await evaluatedPrediction(app, now);
    // The outcome experience is a record of the work, and it exists before any evaluation. What an
    // evaluation must not produce is an adaptation, a user decision, or a guidance shape.
    const learningKinds = new Set(['adaptation', 'adaptation_decision', 'adaptation_retirement', 'guidance']);
    assert.deepEqual(
      lines(d, 'experiences.jsonl').filter((r) => learningKinds.has(r.kind)),
      [],
      'an evaluation is a ledger line, not an adaptation or a decision',
    );
    assert.deepEqual(await app.experience.adaptations({ limit: 5 }), []);
    assert.equal((await app.experience.status()).predictionDerivedAdaptations, 0);

    const goalId = await newGoal(app);
    const baseline = data(await app.controller.planCandidates({ goal: goalId })).adaptationDecision;
    assert.equal(baseline.applied, false, 'a successful evaluation changed no comparison by itself');
    assert.equal(baseline.sources.predictionConsidered, 0);
    assert.equal((await candidateFor(app, evaluated.predictionId)), null);
  });
});

// ---- the pure comparison: the five disclosures and the one dimension --------------------------------
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

// Two approaches identical in every recorded dimension - two steps, one write, one read - that differ
// only in which write capability they name. That makes `approved_adaptation_fit` the only dimension
// that can separate them.
const withAdd = () => candidateOf('with_add', [{ action: 'memory.list' }, { action: 'memory.add' }]);
const withoutAdd = () => candidateOf('without_add', [{ action: 'memory.list' }, { action: 'knowledge.add' }]);
const goal = { id: 'goal-1', revision: 1, status: 'active', criteria: [] };

const feedbackRow = (extra = {}) => ({
  id: extra.id ?? 'adapt-feedback1',
  capability: extra.capability ?? 'memory.add',
  rule: extra.rule ?? 'read the list before adding to it',
  ruleHash: 'hash-feedback',
  method: 'repeated_user_correction',
  source: 'feedback',
  supportCount: 2,
  support: { experienceIds: ['exp-1', 'exp-2'], feedbackIds: ['fb-1', 'fb-2'], predictionIds: [], evaluationIds: [] },
  decidedAt: '2026-11-01T00:00:00.000Z',
  decisionState: extra.decisionState ?? 'approved',
  active: extra.active ?? true,
  conflicts: 0,
  conflictsWith: [],
  guidance: extra.guidance === undefined ? { id: 'g-1', order: 'reads_first', avoid: [], prefer: [], maxSteps: null, createdAt: '2026-11-01T00:00:00.000Z' } : extra.guidance,
  guidanceCount: 1,
  shapeVersion: 1,
  predictionEvidence: null,
});

const predictionRow = (extra = {}) => ({
  id: extra.id ?? 'adapt-prediction1',
  capability: extra.capability ?? 'memory.add',
  rule: extra.rule ?? 'prefer work that names memory.add: the latest live recorded outcome inside the expectation\'s horizon was a success',
  ruleHash: 'hash-prediction',
  method: PREDICTION_DERIVATION_METHOD,
  source: 'prediction',
  supportCount: 1,
  support: { experienceIds: ['exp-9'], feedbackIds: [], predictionIds: ['pred-1'], evaluationIds: ['eval-1'] },
  decidedAt: '2026-11-02T00:00:00.000Z',
  decisionState: extra.decisionState ?? 'approved',
  active: extra.active ?? true,
  conflicts: 0,
  conflictsWith: [],
  guidance: extra.guidance === undefined
    ? { id: extra.id ?? 'adapt-prediction1', order: null, avoid: [], prefer: ['memory.add'], maxSteps: null, createdAt: '2026-11-02T00:00:00.000Z', source: 'proposal' }
    : extra.guidance,
  guidanceCount: 0,
  shapeVersion: 1,
  predictionEvidence: extra.predictionEvidence === undefined
    ? { eligible: true, state: 'eligible', reason: null }
    : extra.predictionEvidence,
});

const compare = (adaptations, candidates = [withAdd(), withoutAdd()]) => evaluateCandidates({
  result: { ok: true, candidates, skipped: [], unaddressed: [], assumedFromGoalRequest: [] },
  goal,
  registry,
  guidance: guidanceFrom({ adaptations, candidates, registry }),
});

describe('AP-02 disclosure: the five source distinctions, and one ordering dimension', () => {
  test('prediction-derived guidance separates the comparison and names its evidence', () => {
    const evaluation = compare([predictionRow()]);
    const decision = evaluation.adaptationDecision;
    assert.equal(decision.dimension, ADAPTATION_DECISION_DIMENSION);
    assert.equal(decision.applied, true);
    assert.equal(decision.outcome, 'changed');
    assert.deepEqual(decision.after.front, ['with_add'], 'the approach the recorded outcome prefers leads');
    assert.equal(decision.rules.length, 1);
    assert.equal(decision.rules[0].source, 'prediction');
    assert.equal(decision.rules[0].method, PREDICTION_DERIVATION_METHOD);
    assert.deepEqual(decision.rules[0].support.predictionIds, ['pred-1']);
    assert.deepEqual(decision.rules[0].support.evaluationIds, ['eval-1']);
    assert.deepEqual(decision.rules[0].support.feedbackIds, []);
    assert.deepEqual(decision.evidence.predictionIds, ['pred-1']);
    assert.deepEqual(decision.evidence.evaluationIds, ['eval-1']);
    assert.equal(decision.sources.predictionEvidence, 'prediction_derived');
    assert.deepEqual(decision.sources.predictionDerived, ['adapt-prediction1']);
    assert.deepEqual(decision.sources.feedbackDerived, []);
    assert.equal(decision.sources.bothEligible, false);
    assert.equal(decision.sources.predictionConsidered, 1);
    assert.deepEqual(decision.sources.predictionRejected, []);
    assert.equal(decision.authorizes, false);
    const rendered = renderAdaptationDecision(decision);
    assert.match(rendered, /prediction-derived/);
    assert.match(rendered, /prediction pred-1/);
    assert.match(rendered, /evaluation eval-1/);
    assert.match(rendered, /with it: with_add leads/);
  });

  test('no prediction record, feedback only, and both kinds are told apart', () => {
    const none = compare([]).adaptationDecision;
    assert.equal(none.sources.predictionEvidence, 'none');
    assert.equal(none.sources.predictionConsidered, 0);

    const feedback = compare([feedbackRow()]).adaptationDecision;
    assert.equal(feedback.applied, true);
    assert.equal(feedback.sources.predictionEvidence, 'none');
    assert.equal(feedback.sources.predictionConsidered, 0);
    assert.deepEqual(feedback.sources.feedbackDerived, ['adapt-feedback1']);

    const both = compare([feedbackRow(), predictionRow()]).adaptationDecision;
    assert.equal(both.applied, true);
    assert.equal(both.sources.predictionEvidence, 'both');
    assert.equal(both.sources.bothEligible, true);
    assert.deepEqual(both.sources.feedbackDerived, ['adapt-feedback1']);
    assert.deepEqual(both.sources.predictionDerived, ['adapt-prediction1']);
    assert.deepEqual(both.evidence.predictionIds, ['pred-1']);
    assert.deepEqual(both.evidence.evaluationIds, ['eval-1']);
    assert.equal(both.evidence.experienceIds.filter((id) => id === 'exp-9').length, 1, 'the outcome experience is counted once');
    assert.equal(new Set(both.evidence.experienceIds).size, both.evidence.experienceIds.length);
    assert.equal(both.rules.length, 2, 'both records are named, and neither is folded into the other');
  });

  test('prediction evidence that cannot stand is considered, rejected, and applied to nothing', () => {
    const rejected = compare([predictionRow({ decisionState: 'candidate', active: false })]);
    const decision = rejected.adaptationDecision;
    assert.equal(decision.applied, false);
    assert.equal(decision.outcome, 'declined');
    assert.deepEqual(decision.before, decision.after, 'the decision is the unadapted one');
    assert.equal(decision.sources.predictionEvidence, 'prediction_rejected');
    assert.equal(decision.sources.predictionConsidered, 1);
    assert.deepEqual(decision.sources.predictionDerived, []);
    assert.deepEqual(decision.sources.predictionRejected.map((r) => [r.id, r.state]), [['adapt-prediction1', 'candidate']]);
    assert.match(renderAdaptationDecision(decision), /prediction evidence was considered and could not be used/);
  });

  test('two prediction-derived records that disagree withhold the ordering', () => {
    const prefer = predictionRow();
    const avoid = predictionRow({
      id: 'adapt-prediction2',
      rule: 'avoid work that names memory.add: the latest live recorded outcome inside the expectation\'s horizon was blocked',
      guidance: { id: 'adapt-prediction2', order: null, avoid: ['memory.add'], prefer: [], maxSteps: null, source: 'proposal' },
    });
    const evaluation = compare([prefer, avoid]);
    const decision = evaluation.adaptationDecision;
    assert.equal(decision.applied, false);
    assert.match(decision.declinedReason, /two approved records for this scope disagree/);
    assert.deepEqual(decision.before, decision.after);
    assert.equal(decision.sources.predictionEvidence, 'prediction_rejected');
    assert.deepEqual(decision.sources.predictionRejected.map((r) => r.state), ['contradicted', 'contradicted']);
  });

  test('a changed candidate needs a fresh approval, whatever the guidance says', () => {
    const evaluation = compare([predictionRow()]);
    const comparison = {
      ok: evaluation.ok,
      leading: evaluation.selection.leading,
      boundTo: evaluation.boundTo,
      included: evaluation.included,
      excluded: evaluation.excluded,
      behind: [],
    };
    const selection = selectCandidate({
      comparison,
      candidates: [{ strategy: 'with_add', digest: 'different', steps: 2, writes: 1, risk: 'medium' }],
      goalId: 'goal-1',
    });
    assert.equal(selection.ok, false);
    assert.equal(selection.reason, 'candidate-changed');
    assert.equal(selection.chosen, null);
  });
});

describe('AP-02 through the real stores, controller, audit log, and comparison', () => {
  test('end to end: record, evaluate, inspect, derive, approve, disclose, retire, restore', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const evaluated = await evaluatedPrediction(app, now);
    assert.equal(evaluated.verdict, 'matched');
    const ledgerAfterEvaluation = bytes(d, 'predictions.jsonl');

    const goalId = await newGoal(app);
    const baselineRes = await app.controller.planCandidates({ goal: goalId });
    const baseline = data(baselineRes);
    assert.equal(baseline.adaptationDecision.applied, false);
    assert.deepEqual(baseline.adaptationDecision.before, baseline.adaptationDecision.after);

    // The user inspects what the evaluation could become, before anything is derived.
    const report = data(await app.controller.adaptationEligibility({ capability: 'memory.add' })).report;
    assert.equal(report.considered.length, 1);
    assert.equal(report.considered[0].eligible, true);
    assert.equal(report.considered[0].alreadyCandidate, false);
    assert.match(report.considered[0].proposal.guidance.prefer.join(','), /memory\.add/);

    const derived = data(await app.controller.adaptationDerive({}));
    const candidate = derived.created.find((a) => a.capability === 'memory.add');
    assert.ok(candidate, JSON.stringify(derived.created));

    // Derived is not approved: the decision is exactly the one the records of the work alone produce.
    const unapproved = data(await app.controller.planCandidates({ goal: goalId }));
    assert.equal(unapproved.adaptationDecision.applied, false);
    assert.deepEqual(unapproved.adaptationDecision.before, baseline.adaptationDecision.after);
    assert.equal(unapproved.adaptationDecision.considered.find((c) => c.id === candidate.id).state, 'candidate');

    const approved = await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved', reason: 'this is how I want this work ordered' });
    assert.equal(approved.status, Outcome.SUCCESS_VERIFIED, approved.output);

    const withItRes = await app.controller.planCandidates({ goal: goalId });
    const withIt = data(withItRes);
    const decision = withIt.adaptationDecision;
    assert.equal(decision.dimension, ADAPTATION_DECISION_DIMENSION);
    assert.equal(decision.applied, true);
    assert.equal(decision.changed, true, JSON.stringify(decision));
    assert.deepEqual(decision.before, baseline.adaptationDecision.after, 'the counterfactual is the decision the baseline read took');
    assert.notDeepEqual(decision.after, decision.before, 'the front moved');
    assert.deepEqual(decision.rules.map((r) => r.id), [candidate.id]);
    assert.equal(decision.rules[0].source, 'prediction');
    assert.equal(decision.rules[0].version, 1, 'a proposal carries shape version one');
    assert.deepEqual(decision.rules[0].support.predictionIds, [evaluated.predictionId]);
    assert.deepEqual(decision.rules[0].support.evaluationIds, [evaluated.evaluationId]);
    assert.deepEqual(decision.evidence.predictionIds, [evaluated.predictionId]);
    assert.equal(decision.sources.predictionEvidence, 'prediction_derived');
    assert.equal(decision.sources.bothEligible, false);
    assert.equal(decision.sources.predictionConsidered, 1);
    assert.equal(decision.authorizes, false);
    assert.equal(decision.digest, withIt.guidance.digest);

    // Only the one dimension moved: bytes, gates, and every other ranked dimension are unchanged.
    assert.equal(withIt.candidateSetDigest, baseline.candidateSetDigest);
    assert.deepEqual(withIt.candidates.map((c) => c.digest), baseline.candidates.map((c) => c.digest));
    assert.deepEqual(withIt.comparison.gates, baseline.comparison.gates);
    assert.deepEqual(withIt.comparison.rankedDimensions, baseline.comparison.rankedDimensions);
    for (const name of baseline.comparison.rankedDimensions.filter((n) => n !== ADAPTATION_DECISION_DIMENSION)) {
      for (const before of baseline.comparison.candidates ?? []) {
        const after = (withIt.comparison.candidates ?? []).find((c) => c.strategy === before.strategy);
        if (after) assert.deepEqual(after.assessed.ranked[name], before.assessed.ranked[name], `${name} did not move`);
      }
    }
    assert.equal(withIt.recorded, false);
    assert.equal(withIt.approved, false);
    assert.equal(withIt.executable, false);
    assert.deepEqual(await app.plans.list(), [], 'the influence recorded no plan');
    assert.match(display(withItRes), /without it:/);
    assert.match(display(withItRes), /with it:/);
    assert.match(display(withItRes), /prediction-derived/);

    // The read is audited with the evidence references it used.
    const audited = JSON.parse(bytes(d, 'operations.jsonl').toString('utf8').trim().split('\n').at(-1));
    assert.deepEqual(audited.steps[0].result.data.adaptationDecision.evidence.predictionIds, [evaluated.predictionId]);

    // Retirement ends the effect and restores the unadapted decision without erasing anything.
    const retired = await app.controller.adaptationRetire({ target: candidate.id, reason: 'not how I work any more' });
    assert.equal(retired.status, Outcome.SUCCESS_VERIFIED, retired.output);
    const after = data(await app.controller.planCandidates({ goal: goalId }));
    assert.equal(after.adaptationDecision.applied, false);
    assert.equal(after.adaptationDecision.outcome, 'declined');
    assert.deepEqual(after.adaptationDecision.before, after.adaptationDecision.after);
    assert.deepEqual(after.adaptationDecision.after, baseline.adaptationDecision.after, 'reversal restores the unadapted decision');
    assert.equal(after.adaptationDecision.considered.find((c) => c.id === candidate.id).state, 'retired');
    assert.equal(after.candidateSetDigest, baseline.candidateSetDigest);
    assert.deepEqual(after.adaptationDecision.sources.predictionDerived, []);
    assert.equal(after.adaptationDecision.sources.predictionEvidence, 'prediction_rejected');

    // The lineage is intact: the expectation, its evaluation, the candidate, the approval, and the
    // retirement all remain readable, and the prediction ledger was never rewritten.
    assert.ok(bytes(d, 'predictions.jsonl').subarray(0, ledgerAfterEvaluation.length).equals(ledgerAfterEvaluation));
    assert.equal((await app.predictions.detail(evaluated.predictionId)).status, 'evaluated');
    assert.equal((await app.predictions.detail(evaluated.predictionId)).evaluation.id, evaluated.evaluationId);
    const detail = await app.experience.adaptationDetail(candidate.id);
    assert.equal(detail.decisionState, 'retired');
    assert.equal(detail.retirement.reason, 'not how I work any more');
    assert.deepEqual(detail.support.predictionIds, [evaluated.predictionId]);
    assert.deepEqual(detail.support.evaluationIds, [evaluated.evaluationId]);
    assert.equal(detail.decisions.length, 1);
    assert.equal(lines(d, 'experiences.jsonl').filter((r) => r.kind === 'adaptation').length, 1);
    assert.equal(lines(d, 'experiences.jsonl').filter((r) => r.kind === 'adaptation_retirement').length, 1);
  });

  test('a withdrawal after approval makes the guidance ineligible, and nothing is rewritten', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const evaluated = await evaluatedPrediction(app, now);
    const goalId = await newGoal(app);
    const [candidate] = data(await app.controller.adaptationDerive({})).created;
    await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    const applied = data(await app.controller.planCandidates({ goal: goalId }));
    assert.equal(applied.adaptationDecision.applied, true);

    const experienceLog = bytes(d, 'experiences.jsonl');
    const ledger = bytes(d, 'predictions.jsonl');
    assert.equal((await app.controller.predictionInvalidate({ target: evaluated.predictionId, reason: 'I no longer stand by that expectation' })).status, Outcome.SUCCESS_VERIFIED);

    // The ledger grew by exactly its own line; every earlier byte is untouched.
    const ledgerNow = bytes(d, 'predictions.jsonl');
    assert.ok(ledgerNow.length > ledger.length);
    assert.ok(ledgerNow.subarray(0, ledger.length).equals(ledger));
    assert.deepEqual(bytes(d, 'experiences.jsonl'), experienceLog, 'a withdrawal writes no experience, decision, or guidance record');

    const after = data(await app.controller.planCandidates({ goal: goalId }));
    assert.equal(after.adaptationDecision.applied, false);
    assert.deepEqual(after.adaptationDecision.before, after.adaptationDecision.after);
    const considered = after.adaptationDecision.considered.find((c) => c.id === candidate.id);
    assert.equal(considered.state, 'stale');
    assert.equal(considered.predictionEvidence.state, 'invalidated');
    assert.match(considered.why, /prediction evidence/);
    assert.equal(after.adaptationDecision.sources.predictionEvidence, 'prediction_rejected');
    assert.deepEqual(after.adaptationDecision.sources.predictionRejected.map((r) => r.state), ['stale']);
    assert.deepEqual(await app.experience.activeAdaptations({ limit: 5 }), { adaptations: [], total: 0, truncated: false, limit: 5 });

    // Future derivations stay ineligible; the user's decision is still on record.
    const derived = data(await app.controller.adaptationDerive({}));
    assert.deepEqual(derived.created, []);
    assert.equal(derived.prediction.eligible, 0);
    assert.equal((await app.experience.adaptationDetail(candidate.id)).decisionState, 'approved');
    assert.equal(lines(d, 'experiences.jsonl').filter((r) => r.kind === 'adaptation_decision').length, 1);
  });

  test('the influence grants no authorization, starts no work, and changes no capability', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const evaluated = await evaluatedPrediction(app, now);
    const goalId = await newGoal(app);
    const [candidate] = data(await app.controller.adaptationDerive({})).created;
    await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });

    const definition = JSON.stringify(app.registry.get('memory.add'));
    const influenced = data(await app.controller.planCandidates({ goal: goalId }));
    assert.equal(influenced.adaptationDecision.applied, true);

    assert.equal(JSON.stringify(app.registry.get('memory.add')), definition, 'the registry definition did not move');
    assert.deepEqual(app.registry.get('memory.add').origins, ['user']);
    assert.equal(app.registry.authorize('memory.add', 'model').decision, 'deny');
    const denied = await app.controller.runAction('memory.add', { content: 'the model wrote this itself' }, 'model', 'ap02-model-write');
    assert.equal(denied.outcome, Outcome.ACTION_DENIED);
    assert.equal(denied.execution.status, 'not_run');
    assert.equal(denied.authorization.reason, 'ORIGIN_NOT_PERMITTED');
    assert.deepEqual(await app.taskStore.list(), [], 'no task was started');
    assert.deepEqual(await app.plans.list(), [], 'no plan was recorded, approved, or made executable');
    assert.equal(influenced.adaptationDecision.authorizes, false);
    assert.equal(lines(d, 'predictions.jsonl').filter((r) => r.kind === 'prediction_evaluation').length, 1,
      'one verdict, not one per read');
    assert.equal(evaluated.verdict, 'matched');
  });

  test('an audit append failure is not reported as a verified successful read', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    await evaluatedPrediction(app, now);
    const goalId = await newGoal(app);
    const [candidate] = data(await app.controller.adaptationDerive({})).created;
    await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });

    const original = app.operations.append.bind(app.operations);
    app.operations.append = async () => { throw new StoreError('injected: the audit log refused plan.candidates'); };
    let res;
    try {
      res = await app.controller.planCandidates({ goal: goalId });
    } finally {
      app.operations.append = original;
    }
    assert.equal(res.recorded, false);
    assert.match(String(res.recordError), /injected: the audit log refused/);
    const carried = res.operation.steps[0].result.data.adaptationDecision;
    assert.equal(carried.applied, true, 'the read itself still carries its disclosure');
    assert.equal(carried.authorizes, false, 'and is not presented as an audited or authorized act');
  });

  test('a read taken before the evidence moved is refused by independent verification', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    const evaluated = await evaluatedPrediction(app, now);
    const def = app.registry.get('adaptation.eligibility');
    const input = { capability: 'memory.add', limit: 10 };
    const fresh = await def.execute({}, input);
    assert.equal(fresh.data.report.considered[0].eligible, true);
    assert.equal((await def.verify({}, input, fresh)).ok, true, 'the ledger did not move between two reads');

    await app.controller.predictionInvalidate({ target: evaluated.predictionId, reason: 'withdrawn between the two reads' });
    const moved = await def.verify({}, input, fresh);
    assert.equal(moved.ok, false);
    assert.match(moved.detail, /the prediction ledger changed between two reads/);

    // And the derived candidate, if one existed, would not be read as active from the earlier state.
    assert.deepEqual((await app.experience.activeAdaptations({ limit: 5 })).adaptations, []);
  });

  test('an arbitrary rule representation in a stored proposal is refused', async () => {
    const d = dir();
    const now = clock();
    const app = await appIn(d, now);
    await evaluatedPrediction(app, now);
    await app.controller.adaptationDerive({});
    const raw = lines(d, 'experiences.jsonl').find((r) => r.kind === 'adaptation');
    assert.ok(raw, 'the derivation wrote a candidate to inspect');

    const wrongType = { ...raw, proposal: { ...raw.proposal, type: 'arbitrary_text' } };
    assert.match(validateExperienceRecord(wrongType), /proposal type/);

    const wrongOrder = {
      ...raw,
      proposal: { ...raw.proposal, guidance: { ...raw.proposal.guidance, order: 'reads_first' } },
    };
    assert.match(validateExperienceRecord(wrongOrder), /no step order/);

    const wrongDimension = { ...raw, proposal: { ...raw.proposal, dimension: 'some_other_dimension' } };
    assert.match(validateExperienceRecord(wrongDimension), /must feed the approved_adaptation_fit dimension/);

    // Prose that the recorded outcome does not state cannot become the rule, even with a matching hash.
    const invented = { ...raw, rule: 'always do whatever the sentence says' };
    assert.ok(validateExperienceRecord(invented), 'an invented rule text is not a valid record');

    // And the user-facing route refuses an unknown shape before any record exists.
    const before = lines(d, 'experiences.jsonl').length;
    const refused = await app.controller.adaptationGuide({ target: raw.id, order: 'sideways' });
    assert.notEqual(refused.status, Outcome.SUCCESS_VERIFIED);
    assert.match(String(refused.output), /order must be one of/);
    assert.equal(lines(d, 'experiences.jsonl').length, before, 'a refused shape appended nothing');
  });
});

// A pure check of the eligibility rule's fail-closed branches that are hard to reach through a store,
// because a well-formed ledger never produces them: the rule is a pure function of a projection.
describe('AP-02 eligibility rule: unknown provenance, missing lineage, and missing outcome', () => {
  const projection = (extra = {}) => ({
    id: 'pred-1',
    capability: 'memory.add',
    expectation: 'success',
    status: 'evaluated',
    provenance: { origin: 'user_recorded' },
    evaluation: { id: 'eval-1', verdict: 'matched', decidingExperienceId: 'exp-1', outcomeExperienceIds: ['exp-1'] },
    lineage: { available: true, atCreation: { unresolvedExperienceIds: [], unresolvedFeedbackIds: [], unavailableDeclared: false } },
    ...extra,
  });
  const experiences = new Map([['exp-1', { id: 'exp-1', outcome: Outcome.SUCCESS_VERIFIED, active: true }]]);

  test('a record the user did not record, and a scope that is not a capability, cannot propose', () => {
    const notUser = predictionEligibility({ projection: projection({ provenance: { origin: 'model_generated' } }), experiencesById: experiences });
    assert.deepEqual([notUser.eligible, notUser.state], [false, 'provenance_not_user']);
    const notScopable = predictionEligibility({ projection: projection({ capability: 'not a capability' }), experiencesById: experiences });
    assert.deepEqual([notScopable.eligible, notScopable.state], [false, 'not_scopable']);
  });

  test('damaged lineage and a missing outcome class fail closed', () => {
    const damaged = predictionEligibility({
      projection: projection({ lineage: { available: false, reason: 'the experience log could not be read' } }),
      experiencesById: experiences,
    });
    assert.deepEqual([damaged.eligible, damaged.state], [false, 'evidence_unavailable']);
    const unresolved = predictionEligibility({
      projection: projection({ lineage: { available: true, atCreation: { unresolvedExperienceIds: ['exp-gone'], unresolvedFeedbackIds: [], unavailableDeclared: false } } }),
      experiencesById: experiences,
    });
    assert.deepEqual([unresolved.eligible, unresolved.state], [false, 'unresolved_citation']);
    const noClass = predictionEligibility({
      projection: projection({ evaluation: { id: 'eval-1', verdict: 'matched', decidingExperienceId: 'exp-other', outcomeExperienceIds: ['exp-1'] } }),
      experiencesById: experiences,
    });
    assert.deepEqual([noClass.eligible, noClass.state], [false, 'outcome_evidence_not_current']);
    const corrected = predictionEligibility({
      projection: projection(),
      experiencesById: new Map([['exp-1', { id: 'exp-1', outcome: Outcome.SUCCESS_VERIFIED, active: false }]]),
    });
    assert.deepEqual([corrected.eligible, corrected.state], [false, 'outcome_evidence_not_current']);
    assert.deepEqual([predictionEligibility({ projection: projection(), experiencesById: experiences }).eligible], [true]);
  });
});
