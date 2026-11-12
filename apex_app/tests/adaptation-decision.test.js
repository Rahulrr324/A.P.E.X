// Batch AP-01: recorded evidence moving exactly one later decision, reversibly.
//
// The pathway under test already exists in pieces: repeated user corrections derive a candidate
// adaptation, the user approves it, the user states the shape they meant, and the comparison ranks
// `approved_adaptation_fit` beside the rest. What AP-01 adds is the decision-level account - the order
// the same rule would have produced without the record, beside the order it produced with it - and a
// test suite that proves the influence is bounded to that one decision.
//
// What is real here: the assembled app, the experience and prediction stores with their write locks and
// validation, the derivation rule, the action registry's authorization, the independent verifiers, the
// audit log, and the comparison itself. The only fixture is a registry stub for the pure comparison
// tests and a NoBackend gateway, which is the existing deterministic infrastructure. No model is
// contacted, no inference runs, and no fixture is described as a prediction.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { StoreError } from '../src/errors.js';
import {
  ADAPTATION_DECISION_DIMENSION, evaluateCandidates, renderAdaptationDecision,
} from '../src/plans/evaluation.js';
import { guidanceFrom } from '../src/plans/guidance.js';
import { deriveCandidateSpecs } from '../src/experience/derivation.js';
import { selectCandidate } from '../src/executive/selection.js';
import { planRisk, validatePlanContent } from '../src/plans/model.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
const dir = () => { const d = makeTempDataDir(); dirs.push(d); return d; };

// A clock the tests move rather than sleep: an expired horizon is a statement about time.
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

// ---- the pure comparison ------------------------------------------------------------------------
const NAMES = ['memory.add', 'memory.list', 'memory.search', 'calc.evaluate'];
const registry = {
  names: () => [...NAMES],
  get: (name) => (NAMES.includes(name)
    ? { name, permission: name === 'memory.add' ? 'write' : 'read', plannable: true }
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

// Two approaches identical in every recorded fact except the order of the same two steps, so the
// guidance dimension is the only one that can separate them.
const writesFirst = () => candidateOf('write_then_read', [{ action: 'memory.add' }, { action: 'memory.list' }]);
const readsFirst = () => candidateOf('read_then_write', [{ action: 'memory.list' }, { action: 'memory.add' }]);
const goal = { id: 'goal-1', revision: 1, status: 'active', criteria: [] };

const row = (extra = {}) => ({
  id: extra.id ?? 'adapt-aaaa1111',
  capability: extra.capability ?? 'memory.add',
  rule: extra.rule ?? 'read the list before adding to it',
  ruleHash: extra.ruleHash ?? 'hash-1',
  supportCount: extra.supportCount ?? 2,
  support: extra.support ?? { experienceIds: ['exp-1', 'exp-2'], feedbackIds: ['fb-1', 'fb-2'] },
  decidedAt: '2026-11-01T00:00:00.000Z',
  decisionState: extra.decisionState ?? 'approved',
  active: extra.active ?? true,
  conflicts: (extra.conflictsWith ?? []).length,
  conflictsWith: extra.conflictsWith ?? [],
  guidance: extra.guidance === undefined ? shape() : extra.guidance,
  guidanceCount: extra.guidanceCount ?? 1,
});
const shape = (extra = {}) => ({
  id: extra.id ?? 'guide-1',
  order: extra.order === undefined ? 'reads_first' : extra.order,
  avoid: extra.avoid ?? [],
  prefer: extra.prefer ?? [],
  maxSteps: extra.maxSteps ?? null,
});

function compare(guidance) {
  return evaluateCandidates({
    result: { ok: true, candidates: [writesFirst(), readsFirst()], skipped: [], unaddressed: [], assumedFromGoalRequest: [] },
    goal,
    registry,
    guidance,
  });
}

const shaped = (rows = [row()]) => guidanceFrom({ adaptations: rows, candidates: [writesFirst(), readsFirst()], registry });

describe('AP-01 eligibility: only an approved, relevant, intact record can move the decision', () => {
  test('an approved applicable shape moves the ordering and discloses both decisions', () => {
    const evaluation = compare(shaped());
    const decision = evaluation.adaptationDecision;
    assert.equal(decision.dimension, ADAPTATION_DECISION_DIMENSION);
    assert.equal(decision.applied, true);
    assert.equal(decision.outcome, 'changed');
    assert.deepEqual(decision.before, { leading: null, front: ['write_then_read', 'read_then_write'] });
    assert.deepEqual(decision.after, { leading: 'read_then_write', front: ['read_then_write'] });
    assert.equal(decision.rules.length, 1);
    assert.equal(decision.rules[0].id, 'adapt-aaaa1111');
    assert.equal(decision.rules[0].version, 1);
    assert.equal(decision.rules[0].ruleHash, 'hash-1');
    assert.deepEqual(decision.evidence.experienceIds, ['exp-1', 'exp-2']);
    assert.deepEqual(decision.evidence.feedbackIds, ['fb-1', 'fb-2']);
    assert.equal(decision.declinedReason, null);
    assert.equal(decision.authorizes, false);
    // The candidate bytes and the gates the rule applies first are the same either way.
    assert.deepEqual(evaluation.front, ['read_then_write']);
    const rendered = renderAdaptationDecision(decision);
    assert.match(rendered, /without it: no single leading candidate/);
    assert.match(rendered, /with it: read_then_write leads/);
    assert.match(rendered, /approved record adapt-aaaa1111 version 1/);
    assert.match(rendered, /authorized no step, and started nothing/);
  });

  test('a candidate adaptation the user never approved ranks nothing and says why', () => {
    const evaluation = compare(shaped([row({ decisionState: 'candidate', active: false, guidance: shape() })]));
    const decision = evaluation.adaptationDecision;
    assert.equal(decision.applied, false);
    assert.equal(decision.outcome, 'declined');
    assert.deepEqual(decision.before, decision.after, 'the decision is exactly the unadapted one');
    assert.match(decision.declinedReason, /not approved, active, and intact/);
    assert.deepEqual(decision.considered.map((c) => c.state), ['candidate']);
    assert.deepEqual(evaluation.front, ['write_then_read', 'read_then_write']);
  });

  test('rejected, retired, ambiguous, and stale records are each reported and none applies', () => {
    for (const [state, active] of [['rejected', false], ['retired', false], ['ambiguous', false], ['approved', false]]) {
      const evaluation = compare(shaped([row({ decisionState: state, active })]));
      const decision = evaluation.adaptationDecision;
      assert.equal(decision.applied, false, state);
      assert.equal(decision.considered[0].state, state === 'approved' ? 'stale' : state);
      assert.deepEqual(decision.before, decision.after, state);
    }
  });

  test('a record whose scope no step names is out of scope and moves nothing', () => {
    const evaluation = compare(shaped([row({ capability: 'calc.evaluate' })]));
    assert.equal(evaluation.adaptationDecision.applied, false);
    assert.equal(evaluation.adaptationDecision.considered[0].state, 'out_of_scope');
    assert.deepEqual(evaluation.front, ['write_then_read', 'read_then_write']);
  });

  test('two approved records that disagree leave the ordering withheld, and both are disclosed', () => {
    const evaluation = compare(shaped([
      row({ id: 'adapt-one', guidance: shape({ order: 'reads_first' }) }),
      row({ id: 'adapt-two', guidance: shape({ order: 'writes_first' }) }),
    ]));
    const decision = evaluation.adaptationDecision;
    assert.equal(decision.applied, false);
    assert.match(decision.declinedReason, /two approved records for this scope disagree/);
    assert.deepEqual(decision.before, decision.after);
    assert.deepEqual([...new Set(decision.considered.map((c) => c.id))].sort(), ['adapt-one', 'adapt-two']);
  });

  test('an approved shape that every candidate satisfies is applied and changes nothing', () => {
    // Both candidates use memory.list, so `prefer` is met by both and separates neither.
    const evaluation = compare(shaped([row({ guidance: shape({ order: null, prefer: ['memory.list'] }) })]));
    const decision = evaluation.adaptationDecision;
    assert.equal(decision.applied, true);
    assert.equal(decision.changed, false);
    assert.equal(decision.outcome, 'applied_not_changed');
    assert.deepEqual(decision.before, decision.after);
    assert.match(renderAdaptationDecision(decision), /applied, and it changed nothing/);
  });

  test('a malformed shape is void rather than a ranking read out of the records', () => {
    const evaluation = compare(shaped([row({ guidance: { id: 'g', order: 'sideways', avoid: [], prefer: [], maxSteps: null } })]));
    const decision = evaluation.adaptationDecision;
    assert.equal(decision.applied, false, 'an unanswerable shape separates nothing');
    assert.deepEqual(evaluation.front, ['write_then_read', 'read_then_write']);
  });

  test('duplicate evidence references cannot amplify the record they cite', () => {
    const evaluation = compare(shaped([row({ support: { experienceIds: ['exp-1', 'exp-1', 'exp-2'], feedbackIds: ['fb-1', 'fb-1'] } })]));
    assert.deepEqual(evaluation.adaptationDecision.evidence.experienceIds, ['exp-1', 'exp-2']);
    assert.deepEqual(evaluation.adaptationDecision.evidence.feedbackIds, ['fb-1']);
  });

  test('the derivation needs two distinct experiences, so a repeated citation is not support', () => {
    const specs = deriveCandidateSpecs({
      experiences: [{ id: 'exp-1', capability: 'memory.add' }],
      feedback: [
        { id: 'fb-1', experienceId: 'exp-1', assessment: 'user_correction', guidance: 'read first' },
        { id: 'fb-2', experienceId: 'exp-1', assessment: 'incorrect', guidance: 'read first' },
      ],
    });
    assert.deepEqual(specs.created, [], 'one experience cited twice is still one observation');
  });

  test('no guidance read at all is declined with the reason, not reported as an absence of records', () => {
    const evaluation = compare(null);
    const decision = evaluation.adaptationDecision;
    assert.equal(decision.applied, false);
    assert.match(decision.declinedReason, /no guidance read/);
    assert.deepEqual(decision.considered, []);
    assert.equal(decision.digest, evaluation.guidance.digest, 'the empty ledger is disclosed, not left null');
  });
});

describe('AP-01 bounded influence: no other decision moves', () => {
  test('applying guidance changes no candidate byte, gate, ranked dimension, or verification record', () => {
    const plain = compare(null);
    const adapted = compare(shaped());
    assert.deepEqual(adapted.included, plain.included);
    assert.deepEqual(adapted.excluded, plain.excluded);
    assert.deepEqual(adapted.boundTo, plain.boundTo, 'the candidates are bound to the same bytes');
    assert.deepEqual(adapted.rankedDimensions, plain.rankedDimensions);
    for (const p of plain.candidates) {
      const a = adapted.candidates.find((c) => c.strategy === p.strategy);
      assert.deepEqual(a.gates, p.gates, `${p.strategy} passed the same gates`);
      assert.deepEqual(a.digest, p.digest);
      assert.deepEqual(a.steps, p.steps);
    }
    // Only the one dimension moved: it is the last ranked dimension and nothing before it differs.
    for (const name of plain.rankedDimensions.filter((d) => d !== ADAPTATION_DECISION_DIMENSION)) {
      for (const p of plain.candidates) {
        const a = adapted.candidates.find((c) => c.strategy === p.strategy);
        assert.deepEqual(a.assessed.ranked[name], p.assessed.ranked[name], `${name} did not move`);
      }
    }
  });

  test('a guidance record cannot readmit work a hard constraint excluded', () => {
    const blocked = {
      ...goal,
      blockers: [{ field: 'blockers', text: 'memory.add is disabled here', basis: 'user_stated' }],
    };
    const evaluation = evaluateCandidates({
      result: { ok: true, candidates: [writesFirst(), readsFirst()], skipped: [], unaddressed: [], assumedFromGoalRequest: [] },
      goal: blocked,
      registry,
      guidance: shaped(),
    });
    // Both candidates use memory.add, so both are excluded; the decision names no leader either way.
    assert.equal(evaluation.ok, false);
    assert.deepEqual(evaluation.adaptationDecision.before, { leading: null, front: [] });
    assert.deepEqual(evaluation.adaptationDecision.after, { leading: null, front: [] });
    assert.equal(evaluation.adaptationDecision.changed, false);
  });

  test('selection refuses a candidate whose bytes changed after the comparison', () => {
    const evaluation = compare(shaped());
    const comparison = {
      ok: evaluation.ok,
      leading: evaluation.selection.leading,
      boundTo: evaluation.boundTo,
      included: evaluation.included,
      excluded: evaluation.excluded,
      behind: [],
    };
    const candidates = [{ strategy: 'read_then_write', digest: 'different', steps: 2, writes: 1, risk: 'medium' }];
    const selection = selectCandidate({ comparison, candidates, goalId: 'goal-1' });
    assert.equal(selection.ok, false);
    assert.equal(selection.reason, 'candidate-changed');
    assert.equal(selection.chosen, null);
  });
});

describe('AP-01 through the real stores, controller, and audit log', () => {
  const data = (res) => res?.operation?.steps?.[0]?.result?.data ?? res?.result?.data ?? {};
  const display = (res) => String(res?.display ?? res?.result?.display ?? res?.output ?? '');

  async function approvedGuidance(app, { guidance = 'read the list before adding to it', decide = true, shapeArgs = { order: 'reads_first' } } = {}) {
    for (const n of [1, 2]) {
      const write = await app.controller.handle(`remember that the AP note ${n} holds`, { origin: 'user' });
      assert.equal(write.status, Outcome.SUCCESS_VERIFIED, write.output);
      const exp = await app.controller.experienceRecord({ operationId: write.operation.id, subject: 'an AP memory write' });
      assert.equal(exp.status, Outcome.SUCCESS_VERIFIED, exp.output);
      const fb = await app.controller.feedbackRecord({
        target: data(exp).id, assessment: 'user_correction', guidance, reason: 'done the long way round',
      });
      assert.equal(fb.status, Outcome.SUCCESS_VERIFIED, fb.output);
    }
    const derived = data(await app.controller.adaptationDerive({}));
    const adaptation = derived.created.find((a) => a.rule === guidance);
    assert.ok(adaptation, JSON.stringify(derived.created));
    if (decide) {
      const decided = await app.controller.adaptationDecide({ target: adaptation.id, decision: 'approved', reason: 'this is how I want it done' });
      assert.equal(decided.status, Outcome.SUCCESS_VERIFIED, decided.output);
    }
    if (shapeArgs) {
      const guided = await app.controller.adaptationGuide({ target: adaptation.id, ...shapeArgs });
      assert.equal(guided.status, Outcome.SUCCESS_VERIFIED, guided.output);
    }
    return adaptation;
  }

  async function twoCriterionGoal(app) {
    const created = await app.controller.goalAdd({
      request: 'keep the running note current',
      criteria: [
        { description: 'remember that the note holds', basis: 'user_stated' },
        { description: 'list my memory', basis: 'user_stated' },
      ],
    });
    assert.equal(created.status, Outcome.GOAL_CREATED, created.output);
    const goalId = data(created).goalId;
    for (const status of ['accepted', 'active']) {
      assert.equal((await app.controller.goalUpdate({ target: goalId, status })).status, Outcome.GOAL_UPDATED);
    }
    return goalId;
  }

  test('before, with, and after reversal: one decision moves and the candidate bytes do not', async () => {
    const d = dir();
    const app = await appIn(d);
    const goalId = await twoCriterionGoal(app);

    // The baseline is read before any learning record exists, so the "without it" side of every later
    // answer can be checked against a decision that was actually taken rather than only reconstructed.
    const beforeRes = await app.controller.planCandidates({ goal: goalId });
    const before = data(beforeRes);
    assert.equal(before.adaptationDecision.applied, false);
    assert.deepEqual(before.adaptationDecision.before, before.adaptationDecision.after);
    assert.equal(before.adaptationDecision.outcome, 'declined');

    const adaptation = await approvedGuidance(app);
    const withItRes = await app.controller.planCandidates({ goal: goalId });
    const withIt = data(withItRes);
    assert.equal(withIt.adaptationDecision.applied, true);
    assert.equal(withIt.adaptationDecision.changed, true);
    assert.equal(withIt.adaptationDecision.before.leading, null);
    assert.equal(withIt.adaptationDecision.after.leading, 'read_before_write');
    assert.deepEqual(withIt.adaptationDecision.rules.map((r) => r.id), [adaptation.id]);
    assert.equal(withIt.adaptationDecision.rules[0].version, 1);
    assert.equal(withIt.adaptationDecision.rules[0].support.experienceIds.length, 2);
    assert.ok(withIt.adaptationDecision.evidence.experienceIds.length >= 2);
    assert.equal(withIt.adaptationDecision.digest, withIt.guidance.digest);
    // The counterfactual the "with it" answer states is the decision the baseline read actually took.
    assert.deepEqual(withIt.adaptationDecision.before, before.adaptationDecision.after);
    assert.match(display(beforeRes), /Approved guidance and this decision \(approved_adaptation_fit\)/);
    assert.match(display(withItRes), /without it: no single leading candidate/);
    assert.match(display(withItRes), /with it: read_before_write leads/);

    const retired = await app.controller.adaptationRetire({ target: adaptation.id, reason: 'no longer how I work' });
    assert.equal(retired.status, Outcome.SUCCESS_VERIFIED, retired.output);
    const after = data(await app.controller.planCandidates({ goal: goalId }));
    assert.equal(after.adaptationDecision.applied, false);
    assert.equal(after.adaptationDecision.outcome, 'declined');
    assert.deepEqual(after.adaptationDecision.before, after.adaptationDecision.after,
      'the decision goes back to the one the records of the work alone produce');
    assert.equal(after.adaptationDecision.considered.find((c) => c.id === adaptation.id).state, 'retired');
    assert.deepEqual(after.adaptationDecision.after, before.adaptationDecision.after,
      'reversal restores the unadapted decision');

    // The candidate bytes are the same through all three reads: nothing about the approaches moved.
    assert.equal(after.candidateSetDigest, before.candidateSetDigest);
    assert.deepEqual(after.candidates.map((c) => c.digest), before.candidates.map((c) => c.digest));
    assert.deepEqual(after.comparison.gates, before.comparison.gates);
    assert.deepEqual(after.comparison.rankedDimensions, before.comparison.rankedDimensions);
    // And nothing was recorded, approved, started, or made executable by any of it.
    for (const res of [before, withIt, after]) {
      assert.equal(res.recorded, false);
      assert.equal(res.approved, false);
      assert.equal(res.executable, false);
      assert.equal(res.adaptationDecision.authorizes, false);
      assert.deepEqual(res.occupancy.drafts, []);
    }
    assert.deepEqual(await app.plans.list(), [], 'no plan was recorded by the influence');
  });

  test('reversal keeps the adaptation, its evidence, and its history readable', async () => {
    const d = dir();
    const app = await appIn(d);
    const adaptation = await approvedGuidance(app);
    const goalId = await twoCriterionGoal(app);
    await app.controller.planCandidates({ goal: goalId });
    await app.controller.adaptationRetire({ target: adaptation.id, reason: 'not how I work now' });

    const detail = await app.experience.adaptationDetail(adaptation.id);
    assert.equal(detail.decisionState, 'retired');
    assert.equal(detail.retirement.reason, 'not how I work now');
    assert.equal(detail.guidanceHistory.length, 1, 'the shape the user recorded is still there');
    assert.equal(detail.support.experienceIds.length, 2, 'the evidence it was derived from is still there');
    const rows = await app.experience.adaptations({ limit: 10, includeRetired: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decisionState, 'retired');
  });

  test('a model origin cannot record evidence, decide, or shape a rule', async () => {
    const d = dir();
    const app = await appIn(d);
    const adaptation = await approvedGuidance(app, { shapeArgs: null });
    const before = await app.experience.health();
    for (const [action, input] of [
      ['feedback.record', { target: 'anything', assessment: 'incorrect', guidance: 'do this instead' }],
      ['adaptation.decide', { target: adaptation.id, decision: 'approved' }],
      ['adaptation.guide', { target: adaptation.id, order: 'reads_first' }],
      ['adaptation.retire', { target: adaptation.id, reason: 'the model says so' }],
    ]) {
      const step = await app.controller.runAction(action, input, 'model', `ap-model-${action.replace('.', '-')}`);
      assert.equal(step.execution.status, 'not_run', `${action} never reached its body`);
      assert.equal(step.outcome, Outcome.ACTION_DENIED);
      assert.equal(step.authorization.reason, 'ORIGIN_NOT_PERMITTED');
    }
    assert.equal((await app.experience.health()).records, before.records, 'no model-origin learning record exists');
  });

  test('an unapproved record changes no decision', async () => {
    const d = dir();
    const app = await appIn(d);
    const candidate = await approvedGuidance(app, { decide: false });
    const goalId = await twoCriterionGoal(app);
    const unapproved = data(await app.controller.planCandidates({ goal: goalId }));
    assert.equal(unapproved.adaptationDecision.applied, false);
    assert.equal(unapproved.adaptationDecision.outcome, 'declined');
    assert.equal(unapproved.adaptationDecision.considered.find((c) => c.id === candidate.id).state, 'candidate');
    assert.deepEqual(unapproved.adaptationDecision.before, unapproved.adaptationDecision.after);
  });

  test('expired and awaiting-evaluation predictions never move the ordering', async () => {
    const now = clock();
    const d = dir();
    const app = await appIn(d, now);
    const goalId = await twoCriterionGoal(app);
    const baseline = data(await app.controller.planCandidates({ goal: goalId }));

    const awaiting = await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success', subject: 'the next write lands', inDays: 3,
    });
    assert.equal(awaiting.status, Outcome.SUCCESS_VERIFIED, awaiting.output);
    const afterAwaiting = data(await app.controller.planCandidates({ goal: goalId }));
    assert.deepEqual(afterAwaiting.adaptationDecision, baseline.adaptationDecision);

    const expiring = await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success', subject: 'a horizon that will pass', inDays: 1,
    });
    assert.equal(expiring.status, Outcome.SUCCESS_VERIFIED, expiring.output);
    now.advance(3);
    const afterExpired = data(await app.controller.planCandidates({ goal: goalId }));
    assert.deepEqual(afterExpired.adaptationDecision, baseline.adaptationDecision);
    const projection = (await app.predictions.list({ limit: 10 })).projections.find(
      (p) => p.id === data(expiring).id,
    );
    assert.equal(projection.status, 'expired');
    assert.equal(afterExpired.adaptationDecision.applied, false);
  });

  test('an unknown or out-of-range rule representation is refused and writes nothing', async () => {
    const d = dir();
    const app = await appIn(d);
    const adaptation = await approvedGuidance(app, { shapeArgs: null });
    const before = await app.experience.health();
    for (const [input, expected] of [
      [{ order: 'sideways' }, /order must be one of/],
      [{ maxSteps: 0 }, /maxSteps must be an integer from 1 to 8/],
      [{ maxSteps: 9 }, /maxSteps must be an integer from 1 to 8/],
      [{ prefer: ['memory.nosuch'] }, /must name registered capabilities/],
    ]) {
      const res = await app.controller.adaptationGuide({ target: adaptation.id, ...input });
      assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED, JSON.stringify(input));
      assert.match(res.output, expected, JSON.stringify(input));
      assert.equal((await app.experience.health()).records, before.records, 'a refused shape appended nothing');
    }
  });

  test('the influence grants no authorization and changes no capability definition', async () => {
    const d = dir();
    const app = await appIn(d);
    await approvedGuidance(app);
    const goalId = await twoCriterionGoal(app);
    const before = JSON.stringify(app.registry.get('memory.add'));
    const res = data(await app.controller.planCandidates({ goal: goalId }));
    assert.equal(res.adaptationDecision.applied, true);

    assert.equal(JSON.stringify(app.registry.get('memory.add')), before, 'the registry definition did not move');
    assert.deepEqual(app.registry.get('memory.add').origins, ['user']);
    assert.equal(app.registry.authorize('memory.add', 'model').decision, 'deny');
    const step = await app.controller.runAction('memory.add', { content: 'the model wrote this itself' }, 'model', 'ap-model-write');
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.equal(step.execution.status, 'not_run');
    assert.equal(step.authorization.reason, 'ORIGIN_NOT_PERMITTED');
  });

  test('a stale guidance read is refused by the independent verification', async () => {
    const d = dir();
    const app = await appIn(d);
    const adaptation = await approvedGuidance(app);
    const goalId = await twoCriterionGoal(app);
    const def = app.registry.get('plan.candidates');
    const ctx = {
      registry: app.registry, goals: app.goals, plans: app.plans, experience: app.experience,
      predictions: app.predictions, knowledge: app.knowledge, memory: app.memory,
      operations: app.operations, operationId: 'ap-verify',
    };
    const input = { goalRef: goalId, work: null, cannotUse: [] };
    const fresh = await def.execute(ctx, input);
    assert.equal(fresh.data.adaptationDecision.applied, true);
    assert.equal((await def.verify(ctx, input, fresh)).ok, true);

    await app.controller.adaptationRetire({ target: adaptation.id, reason: 'changed my mind' });
    const moved = await def.verify(ctx, input, fresh);
    assert.equal(moved.ok, false, 'a decision read before the record moved is not the current decision');
    assert.match(moved.detail, /guidance that ranked these candidates no longer reads the same/);
  });

  test('an audit append failure leaves the answer unrecorded rather than silently successful', async () => {
    const d = dir();
    const app = await appIn(d);
    await approvedGuidance(app);
    const goalId = await twoCriterionGoal(app);

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
    // The read itself carries its disclosure, and that disclosure is not presented as an audited record.
    assert.ok(res.operation.steps[0].result.data.adaptationDecision);
    assert.equal(res.operation.steps[0].result.data.adaptationDecision.authorizes, false);
  });

  test('the audit record of the read carries the evidence references it used', async () => {
    const d = dir();
    const app = await appIn(d);
    await approvedGuidance(app);
    const goalId = await twoCriterionGoal(app);
    const res = await app.controller.planCandidates({ goal: goalId });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    const recorded = JSON.parse(fs.readFileSync(path.join(d, 'operations.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).at(-1));
    const data = recorded.steps[0].result.data;
    assert.equal(data.adaptationDecision.applied, true);
    assert.equal(data.adaptationDecision.authorizes, false);
    assert.ok(data.adaptationDecision.rules.length > 0);
    assert.equal(data.adaptationDecision.rules[0].version, 1);
    assert.ok(data.adaptationDecision.evidence.experienceIds.length >= 2);
    assert.ok(data.adaptationDecision.evidence.feedbackIds.length >= 2);
    assert.equal(data.adaptationDecision.changed, true);
  });
});
