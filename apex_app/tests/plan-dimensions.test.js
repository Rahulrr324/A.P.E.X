// Batch AM, work package E: what a comparison of approaches is allowed to rank on, and what it has to
// leave alone.
//
// Batch AL ranked five things and disclosed six, and stopped there. Batch AM adds two ranked dimensions
// - whether an approach's own steps will be re-checked by an action that can check itself, and what the
// records say happened the last time these very capabilities ran - and states, beside each of the six
// disclosed ones, why it stays disclosed rather than leaving the reader to wonder. The rule the batch
// wrote down is the rule these tests hold: goal alignment, criterion coverage, feasibility, dependency
// satisfaction, blocker exposure, evidence availability, adaptation relevance, risk, reversibility,
// resources, verification quality and historical outcomes - every one of them answered from a record,
// none of them turned into a number that means nothing.
//
// Two properties matter more than the counts themselves. Hard facts stay gates: an approach that walks
// into a blocker the user recorded is excluded however good its numbers, and no ranked quantity can
// outweigh one. And an unread record is never read as a clean one: a comparison that was handed no
// outcome history says exactly that and ranks nothing on it, because a system that fills the gap with a
// zero hands an advantage to whichever candidate nobody looked at.
//
// Sections AM-E1 to AM-E4 derive from records handed in, so each claim is checked against the record
// that is supposed to support it. AM-E5 checks what the audit line is able to say. AM-E6 runs the whole
// path through the real plan store, action registry, task runner, audit log and CLI, so the recorded
// failure that moves a ranking is one APEX wrote itself, not one this file describes.
//
// Synthetic fixtures and stub registries throughout, plus the no-backend gateway and capture off: no
// model is contacted and no inference runs.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import {
  DISCLOSED_DIMENSIONS, EVALUATION_NOTE, EVALUATION_RULE, GATES, RANKED_DIMENSIONS,
  evaluateCandidates, renderEvaluation,
} from '../src/plans/evaluation.js';
import { OUTCOME_BOUND, outcomesAudit, outcomesForGoal, recordedStepOutcomes } from '../src/plans/outcomes.js';
import { constraintLedger } from '../src/plans/constraints.js';
import { planRisk, validatePlanContent } from '../src/plans/model.js';
import { StepStatus } from '../src/tasks/model.js';
import { shortId } from '../src/util.js';
import { makeTempDataDir, cleanup, cleanEnv, runCli } from './helpers.js';

const CLOCK = () => new Date('2026-11-05T09:00:00.000Z');
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
const dir = () => { const d = makeTempDataDir(); dirs.push(d); return d; };
const appIn = (dataDir) => createApp({
  dataDir,
  now: CLOCK,
  gateway: new ModelGateway({ backend: new NoBackend() }),
  experienceCapture: CAPTURE_OFF,
});

const data = (res) => res?.operation?.steps?.[0]?.result?.data ?? res?.result?.data ?? {};
const display = (res) => String(res?.display ?? res?.output ?? '');

// A registry whose actions differ on the one thing the new dimension reads: whether the action carries
// its own verifier. `checked` names the actions that do, and a candidate's own claim about a verifier is
// never consulted - the registry answers, because that is the only answer a step can be verified against.
function registryWith(checked = []) {
  const NAMES = ['memory.add', 'memory.list', 'memory.search', 'calc.evaluate'];
  return {
    names: () => [...NAMES],
    get: (name) => (NAMES.includes(name)
      ? {
        name,
        permission: name === 'memory.add' ? 'write' : 'read',
        plannable: true,
        ...(checked.includes(name) ? { verify: async () => ({ ok: true, detail: 're-read' }) } : {}),
      }
      : null),
    authorize: () => ({ decision: 'allow' }),
  };
}

// A candidate in the shape the comparison is handed: the generator's own fields, because an evaluation
// reads the criteria a candidate says it covers and its own validation result, and a fixture that left
// either out would be a candidate the gates refuse for reasons that have nothing to do with the
// dimension under test.
function candidateOf(registry, strategy, steps, extra = {}) {
  const content = {
    goalId: 'goal-1',
    outcome: 'the recorded criteria are settled',
    steps: steps.map((s, i) => ({
      id: s.id ?? `s${i + 1}`,
      description: `${s.action} is the ${i + 1} step of this approach`,
      action: s.action,
      input: {},
      dependsOn: i === 0 ? [] : [`s${i}`],
      expectedResult: `the ${s.action} result is recorded`,
      verification: 'the action re-checks its own result',
      risk: s.risk ?? 'medium',
      estimate: { seconds: null },
      reversibility: s.reversibility ?? (registry.get(s.action)?.permission === 'write' ? 'reversible' : 'read_only'),
      recovery: 'the task stops here and later steps do not run',
    })),
    preconditions: extra.preconditions ?? [],
    assertions: [],
    resources: { estimatedSeconds: extra.seconds ?? null },
  };
  const writes = content.steps.filter((s) => registry.get(s.action)?.permission === 'write').length;
  const problems = validatePlanContent(content);
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
    validation: problems.length === 0 ? { ok: true, problems: [] } : { ok: false, problems },
    // The candidate's own claim, which the comparison is not allowed to believe.
    capabilities: content.steps.map((s) => ({
      action: s.action,
      permission: registry.get(s.action)?.permission,
      hasVerifier: extra.claimsVerifiers === true,
    })),
    criteriaCovered: extra.covered ?? [],
    criteriaLeftUnaddressed: [],
    criteriaAssumedFromTheGoalRequest: [],
    criteriaSharedWithAnEarlierStep: [],
    criteriaBeyondThePlanBound: [],
    criteriaFromInference: [],
    criteriaLeftOutOfThisApproach: extra.leftOut ?? [],
    stepsBeyondThePlanBound: [],
    estimatedSeconds: extra.seconds ?? null,
    executable: false,
    approved: false,
    readyForApproval: problems.length === 0,
  };
}

const goalWith = (criteria = []) => ({ id: 'goal-1', revision: 1, status: 'active', criteria });

// One comparison, built the way the read builds it: gates and constraints from the live registry, the
// guidance and outcome channels handed in rather than read here.
function compare({ registry, candidates, goal = goalWith(), constraints = null, guidance = null, outcomes = null }) {
  return evaluateCandidates({
    result: { ok: true, candidates, skipped: [], unaddressed: [], assumedFromGoalRequest: [] },
    goal,
    registry,
    constraints: constraints ?? constraintLedger({ goal, registry }),
    guidance,
    outcomes,
  });
}
const rowOf = (evaluation, strategy) => evaluation.candidates.find((c) => c.strategy === strategy);
const ranked = (row, name) => row.assessed.ranked[name];
const disclosed = (row, name) => row.assessed.disclosed[name];

// A plan store holding exactly the given plan records, so the outcome read is a read of a store rather
// than a hand-built list - the caller cannot tell the two apart, and neither can the dimension.
function planStore(plans) {
  return { list: async () => plans.map((p) => ({ goalId: 'goal-1', steps: [], stepResults: {}, ...p })) };
}
const planWith = (results, extra = {}) => ({
  id: extra.id ?? 'plan-aaaa1111',
  goalId: 'goal-1',
  status: extra.status ?? 'blocked',
  steps: Object.keys(results).map((id) => ({ id, action: results[id].action ?? 'memory.add' })),
  stepResults: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, {
    status: r.status, operationId: r.operationId ?? `op-${id}`, detail: r.detail ?? null,
  }])),
});

describe('AM-E1: every concern the batch named has a home, and says which one', () => {
  const HOME = {
    goal_alignment: 'disclosed',
    criterion_coverage: 'ranked',
    feasibility: 'gate',
    dependency_satisfaction: 'gate and disclosed',
    blocker_exposure: 'gate and disclosed',
    evidence_availability: 'disclosed',
    adaptation_relevance: 'ranked',
    risk: 'ranked',
    reversibility: 'ranked',
    resources: 'ranked',
    verification_quality: 'ranked',
    historical_outcomes: 'ranked',
  };

  test('the twelve concerns are each answered from a record, and none of them is silently dropped', () => {
    assert.deepEqual(Object.keys(HOME).length, 12);
    // Ranked names, gate names, and the disclosed list are the three homes. Every concern lands in one,
    // and the placement is stated in the code rather than inferred from which list a name happens to be in.
    assert.ok(RANKED_DIMENSIONS.includes('criterion_coverage'));
    assert.ok(RANKED_DIMENSIONS.includes('verification_quality'), 'verification quality is ranked as of Batch AM');
    assert.ok(RANKED_DIMENSIONS.includes('recorded_outcome_history'), 'historical outcomes are ranked as of Batch AM');
    assert.ok(RANKED_DIMENSIONS.includes('approved_adaptation_fit'), 'adaptation relevance is the guidance dimension Batch AM added');
    assert.ok(RANKED_DIMENSIONS.includes('step_risk') && RANKED_DIMENSIONS.includes('reversibility')
      && RANKED_DIMENSIONS.includes('resource_requirements'));
    for (const gate of ['candidate_validation', 'dependency_structure', 'capability_available_now', 'constraints_satisfied', 'plan_bounds', 'goal_still_open']) {
      assert.ok(GATES.includes(gate), `${gate} stays a gate`);
    }
    assert.deepEqual([...DISCLOSED_DIMENSIONS].sort(), [
      'capability_availability', 'dependency_validity', 'evidence_sufficiency', 'expected_verification_quality',
      'goal_alignment', 'known_blockers',
    ]);
    // Nothing named above is missing from the code's own lists, and nothing in the lists is unaccounted
    // for: the ranked and disclosed sets are disjoint, so a dimension cannot both move and merely inform.
    assert.deepEqual(RANKED_DIMENSIONS.filter((n) => DISCLOSED_DIMENSIONS.includes(n)), []);
    assert.equal(new Set(RANKED_DIMENSIONS).size, RANKED_DIMENSIONS.length);
  });

  test('no ranked dimension is a score, a weight, or a probability, and the rule says so in words', () => {
    const registry = registryWith(['memory.list']);
    const evaluation = compare({
      registry,
      candidates: [candidateOf(registry, 'checked_read', [{ action: 'memory.list' }])],
    });
    const json = JSON.stringify(evaluation.candidates.map((r) => r.assessed));
    for (const forbidden of ['"weight"', '"score"', '"probability"', '"confidence"', '"likelihood"', '"percent"']) {
      assert.equal(json.includes(forbidden), false, `the comparison carries ${forbidden}`);
    }
    assert.match(EVALUATION_RULE, /No score, weight, or probability is computed/);
    assert.match(EVALUATION_RULE, /A dimension whose records were not read ranks nothing/);
    assert.match(EVALUATION_RULE, /are facts about whether the work can run at all, and no ranked count outweighs one/);
    assert.match(EVALUATION_NOTE, /not a prediction, a probability, or an approval/);
    for (const name of RANKED_DIMENSIONS) {
      const value = ranked(rowOf(evaluation, 'checked_read'), name).value;
      assert.ok(value === null || typeof value === 'number' || Array.isArray(value),
        `${name} compares a record, not an opinion`);
    }
  });

  test('the print names both new bands for every candidate that passes the gates', () => {
    const registry = registryWith(['memory.list']);
    const evaluation = compare({
      registry,
      candidates: [candidateOf(registry, 'checked_read', [{ action: 'memory.list' }])],
    });
    const text = renderEvaluation(evaluation);
    assert.match(text, /verification_quality: no step is left without its action's own verifier/);
    assert.match(text, /recorded_outcome_history: no recorded step outcome was handed to this comparison/);
  });
});

describe('AM-E2: verification quality, ranked from the registry rather than the candidate', () => {
  test('an approach whose steps cannot be checked by their own action ranks behind one that can', () => {
    const registry = registryWith(['memory.list', 'memory.search']);
    const checked = candidateOf(registry, 'checked_read', [{ action: 'memory.list' }]);
    const unchecked = candidateOf(registry, 'unchecked_read', [{ action: 'calc.evaluate' }]);
    const evaluation = compare({ registry, candidates: [checked, unchecked] });
    assert.equal(ranked(rowOf(evaluation, 'checked_read'), 'verification_quality').value, 0);
    assert.equal(ranked(rowOf(evaluation, 'unchecked_read'), 'verification_quality').value, 1);
    assert.deepEqual(evaluation.front, ['checked_read']);
    assert.deepEqual(evaluation.behind.map((b) => b.strategy), ['unchecked_read']);
    assert.deepEqual(evaluation.behind[0].whyBehind, [{ under: 'checked_read', on: ['verification_quality'] }]);
    assert.match(ranked(rowOf(evaluation, 'unchecked_read'), 'verification_quality').band,
      /s1 names an action with no independent verifier, so its completion rests on the action returning/);
  });

  test('the same coverage on both sides separates nothing, and both stay on the front', () => {
    const registry = registryWith(['memory.list', 'memory.search']);
    const one = candidateOf(registry, 'list_first', [{ action: 'memory.list' }]);
    const two = candidateOf(registry, 'search_first', [{ action: 'memory.search' }]);
    const evaluation = compare({ registry, candidates: [one, two] });
    assert.deepEqual(evaluation.behind, []);
    assert.deepEqual(evaluation.front.sort(), ['list_first', 'search_first']);
    assert.equal(evaluation.selection.leading, null);
    assert.match(evaluation.selection.basis, /match on every ranked dimension/);
  });

  test('the registry answers, not the candidate: a self-reported verifier is not evidence of one', () => {
    const registry = registryWith([]);
    const claiming = candidateOf(registry, 'claims_a_verifier', [{ action: 'memory.list' }], { claimsVerifiers: true });
    const evaluation = compare({ registry, candidates: [claiming] });
    const row = rowOf(evaluation, 'claims_a_verifier');
    assert.equal(ranked(row, 'verification_quality').value, 1, 'the action has no verifier, whatever the candidate says');
    assert.match(disclosed(row, 'capability_availability').band, /memory\.list \(read, no verifier\)/);
  });

  test('a step naming an unregistered action is a gate failure, not a verification drawback', () => {
    const registry = registryWith(['memory.list']);
    const invented = candidateOf(registry, 'invented_action', [{ action: 'vault.archive' }]);
    const evaluation = compare({ registry, candidates: [invented] });
    const row = rowOf(evaluation, 'invented_action');
    assert.deepEqual(row.failedGates.map((g) => g.gate), ['capability_available_now']);
    assert.deepEqual(evaluation.front, [], 'an excluded candidate is not ranked at all');
    assert.match(disclosed(row, 'expected_verification_quality').band, /no independent verifier for s1/);
  });
});

describe('AM-E3: what the last time these capabilities ran actually left on record', () => {
  test('nobody read: the dimension says so and ranks nothing', () => {
    const registry = registryWith(['memory.list', 'memory.search']);
    const evaluation = compare({
      registry,
      candidates: [
        candidateOf(registry, 'uses_read', [{ action: 'memory.list' }]),
        candidateOf(registry, 'uses_other_read', [{ action: 'memory.search' }]),
      ],
      outcomes: null,
    });
    for (const strategy of ['uses_read', 'uses_other_read']) {
      const dim = ranked(rowOf(evaluation, strategy), 'recorded_outcome_history');
      assert.equal(dim.value, null);
      assert.match(dim.band, /no recorded step outcome was handed to this comparison/);
    }
    assert.deepEqual(evaluation.outcomesRead, { read: false, records: 0, plans: 0, truncated: false, capabilities: [] });
    assert.deepEqual(evaluation.behind, [], 'and the two are not separated by a history nobody read');
  });

  test('read, and nothing on record: a zero that is a finding, not an assumption', async () => {
    const registry = registryWith(['memory.list', 'memory.search']);
    const outcomes = await outcomesForGoal(planStore([]), { goalId: 'goal-1' });
    const evaluation = compare({
      registry,
      outcomes,
      candidates: [
        candidateOf(registry, 'uses_read', [{ action: 'memory.list' }]),
        candidateOf(registry, 'uses_other_read', [{ action: 'memory.search' }]),
      ],
    });
    assert.equal(outcomes.read, true);
    assert.equal(outcomes.records.length, 0);
    const band = ranked(rowOf(evaluation, 'uses_read'), 'recorded_outcome_history').band;
    assert.match(band, /nothing on the 0 recorded plan\(s\) for this goal ended failed or uncertain/);
    assert.equal(ranked(rowOf(evaluation, 'uses_read'), 'recorded_outcome_history').value, 0);
  });

  test('a recorded failure ranks the approach that uses that capability behind the one that does not', async () => {
    const registry = registryWith(['memory.list', 'memory.search']);
    const outcomes = await outcomesForGoal(
      planStore([planWith({ s1: { status: StepStatus.FAILED, action: 'memory.list' } })]),
      { goalId: 'goal-1' },
    );
    const evaluation = compare({
      registry,
      outcomes,
      candidates: [
        candidateOf(registry, 'uses_the_troubled_one', [{ action: 'memory.list' }]),
        candidateOf(registry, 'uses_the_other', [{ action: 'memory.search' }]),
      ],
    });
    const troubled = ranked(rowOf(evaluation, 'uses_the_troubled_one'), 'recorded_outcome_history');
    assert.equal(troubled.value, 1);
    assert.equal(troubled.invert, true);
    assert.match(troubled.band, /s1 \(memory\.list, failed, operation op-s1\) name a capability the handed records hold a failed or uncertain outcome for/);
    assert.match(troubled.band, /what happened once, not a claim about this run/);
    assert.equal(ranked(rowOf(evaluation, 'uses_the_other'), 'recorded_outcome_history').value, 0);
    assert.deepEqual(evaluation.front, ['uses_the_other']);
    assert.deepEqual(evaluation.behind[0].whyBehind, [{ under: 'uses_the_other', on: ['recorded_outcome_history'] }]);
  });

  test('an uncertain step counts exactly as a failed one does, and neither is called a success', async () => {
    const registry = registryWith(['memory.list']);
    const outcomes = await outcomesForGoal(
      planStore([planWith({ s1: { status: StepStatus.UNCERTAIN, action: 'memory.list' } })]),
      { goalId: 'goal-1' },
    );
    assert.equal(outcomes.records.length, 1);
    const evaluation = compare({ registry, outcomes, candidates: [candidateOf(registry, 'uses_read', [{ action: 'memory.list' }])] });
    assert.match(ranked(rowOf(evaluation, 'uses_read'), 'recorded_outcome_history').band, /memory\.list, uncertain/);
  });

  test('a completed step outcome is not in the read at all, so it lowers nothing', async () => {
    const registry = registryWith(['memory.list']);
    const outcomes = await outcomesForGoal(
      planStore([planWith({ s1: { status: StepStatus.COMPLETED, action: 'memory.list' } })]),
      { goalId: 'goal-1' },
    );
    assert.deepEqual(outcomes.records, [], 'a success is not a failed or uncertain outcome');
    const evaluation = compare({ registry, outcomes, candidates: [candidateOf(registry, 'uses_read', [{ action: 'memory.list' }])] });
    assert.equal(ranked(rowOf(evaluation, 'uses_read'), 'recorded_outcome_history').value, 0);
  });

  test('two steps on the same troubled capability are one exposure, not two: length decides nothing', async () => {
    const registry = registryWith(['memory.list', 'memory.search']);
    const outcomes = await outcomesForGoal(
      planStore([planWith({
        s1: { status: StepStatus.FAILED, action: 'memory.list' },
        s2: { status: StepStatus.UNCERTAIN, action: 'memory.list' },
      })]),
      { goalId: 'goal-1' },
    );
    assert.equal(outcomes.records.length, 2);
    const both = candidateOf(registry, 'twice_on_one', [{ action: 'memory.list' }, { action: 'memory.list' }]);
    const evaluation = compare({ registry, outcomes, candidates: [both] });
    assert.equal(ranked(rowOf(evaluation, 'twice_on_one'), 'recorded_outcome_history').value, 1,
      'distinct capabilities, so a longer plan is not more exposed for being longer');
  });

  test('the bounded read says where it stopped, in the band and in the audit', async () => {
    const registry = registryWith(['memory.list']);
    const many = {};
    for (let i = 1; i <= OUTCOME_BOUND + 3; i += 1) many[`s${i}`] = { status: StepStatus.FAILED, action: 'memory.list' };
    const outcomes = await outcomesForGoal(planStore([planWith(many)]), { goalId: 'goal-1' });
    assert.equal(outcomes.records.length, OUTCOME_BOUND);
    assert.equal(outcomes.truncated, true);
    const evaluation = compare({ registry, outcomes, candidates: [candidateOf(registry, 'uses_read', [{ action: 'memory.list' }])] });
    assert.match(ranked(rowOf(evaluation, 'uses_read'), 'recorded_outcome_history').band,
      /the read is bounded, so a capability further back in the records is not named here/);
    assert.equal(evaluation.outcomesRead.truncated, true);
    assert.equal(evaluation.outcomesRead.records, OUTCOME_BOUND);
  });

  test('no plan store at all: the read reports that, and the band refuses to treat it as clean', async () => {
    const outcomes = await outcomesForGoal(null, { goalId: 'goal-1' });
    assert.equal(outcomes.read, false);
    assert.match(outcomes.note, /unknown here/);
    const registry = registryWith(['memory.list']);
    const evaluation = compare({ registry, outcomes, candidates: [candidateOf(registry, 'uses_read', [{ action: 'memory.list' }])] });
    assert.equal(ranked(rowOf(evaluation, 'uses_read'), 'recorded_outcome_history').value, null);
    assert.deepEqual(evaluation.outcomesRead.capabilities, []);
  });

  test('the read covers this goal only, and one plan record per capability is enough', async () => {
    const registry = registryWith(['memory.list']);
    const store = planStore([
      { goalId: 'someone-elses-goal', steps: [{ id: 's1', action: 'memory.add' }], stepResults: { s1: { status: StepStatus.FAILED, operationId: 'op-x' } } },
      planWith({ s1: { status: StepStatus.FAILED, action: 'memory.list' } }),
    ]);
    const outcomes = await outcomesForGoal(store, { goalId: 'goal-1' });
    assert.deepEqual(outcomes.records.map((r) => r.capability), ['memory.list']);
    assert.equal(outcomes.plans, 1);
    assert.deepEqual(outcomesAudit(outcomes).capabilities, ['memory.list']);
    const row = recordedStepOutcomes(store.list ? { id: 'p', steps: [{ id: 's1', action: 'memory.list' }], stepResults: { s1: { status: StepStatus.FAILED, operationId: 'op-1' } } } : null);
    assert.deepEqual(row, [{ planId: 'p', stepId: 's1', capability: 'memory.list', status: StepStatus.FAILED, operationId: 'op-1' }]);
    assert.equal(ranked(rowOf(compare({ registry, outcomes, candidates: [candidateOf(registry, 'uses_read', [{ action: 'memory.list' }])] }), 'uses_read'), 'recorded_outcome_history').value, 1);
  });
});

describe('AM-E4: hard facts stay gates, and no count outweighs one', () => {
  test('an approach that leads on every ranked dimension is still excluded by a blocker the user recorded', async () => {
    const registry = registryWith(['memory.list', 'memory.search']);
    const goal = {
      id: 'goal-1', revision: 1, status: 'active', criteria: [],
      blockers: [{ text: 'memory.search is disabled on this machine', basis: 'user_stated' }],
      prerequisites: [], constraints: [], resources: [], timeConditions: [], unknowns: [], dependsOn: [],
    };
    const constraints = constraintLedger({ goal, registry });
    const outcomes = await outcomesForGoal(
      planStore([planWith({ s1: { status: StepStatus.FAILED, action: 'memory.list' } })]),
      { goalId: 'goal-1' },
    );
    const blocked = candidateOf(registry, 'searches_and_is_clean', [{ action: 'memory.search' }]);
    const troubled = candidateOf(registry, 'lists_and_failed_once', [{ action: 'memory.list' }]);
    const evaluation = compare({ registry, goal, constraints, outcomes, candidates: [blocked, troubled] });
    const row = rowOf(evaluation, 'searches_and_is_clean');
    assert.equal(row.included, false, 'its better counts buy it nothing');
    assert.deepEqual(row.failedGates.map((g) => g.gate), ['constraints_satisfied']);
    assert.equal(ranked(row, 'verification_quality').value, 0);
    assert.equal(ranked(row, 'recorded_outcome_history').value, 0);
    assert.deepEqual(evaluation.front, ['lists_and_failed_once'], 'the candidate with the recorded failure wins by being the only one allowed to run');
    assert.match(row.gates.constraints_satisfied.detail, /confirmed_blocker/);
  });

  test('the exclusion names the record, the steps it stops, the reason and the resolution', () => {
    const registry = registryWith(['memory.list']);
    const goal = {
      id: 'goal-1', revision: 1, status: 'active', criteria: [],
      prerequisites: [{ text: 'the export needs a signed release note', basis: 'user_stated' }],
      blockers: [], constraints: [], resources: [], timeConditions: [], unknowns: [], dependsOn: [],
    };
    const evaluation = compare({
      registry, goal, constraints: constraintLedger({ goal, registry }),
      candidates: [candidateOf(registry, 'any_approach', [{ action: 'memory.list' }])],
    });
    const row = rowOf(evaluation, 'any_approach');
    assert.deepEqual(row.failedGates.map((g) => g.gate), ['constraints_satisfied'],
      'a prerequisite the user recorded stops the work rather than marking it down');
    assert.ok(row.constraints.blockedBy.length > 0);
    const item = row.constraints.blockedBy[0];
    assert.ok(item.id && item.text, 'the record is named');
    assert.ok(item.steps.length > 0, 'the steps it stops are named');
    assert.ok(item.reason.length > 0 && item.resolution.length > 0, 'why it stops them, and what clears it');
  });

  test('an action the user told this generation not to offer stays refused however the dimensions fall', () => {
    const registry = registryWith(['memory.list', 'memory.search']);
    const evaluation = compare({
      registry,
      candidates: [candidateOf(registry, 'offers_what_was_refused', [{ action: 'memory.search' }])],
      evidence: null,
    });
    assert.equal(rowOf(evaluation, 'offers_what_was_refused').included, true, 'the ledger, not the ranking, carries the refusal');
    const gated = evaluateCandidates({
      result: { ok: true, candidates: [candidateOf(registry, 'offers_what_was_refused', [{ action: 'memory.search' }])], skipped: [] },
      goal: goalWith(),
      registry,
      evidence: { unavailableActions: ['memory.search'], knownBlockers: [], failedOperations: [] },
    });
    assert.deepEqual(gated.excluded.map((e) => e.strategy), ['offers_what_was_refused']);
    assert.match(gated.candidates[0].gates.capability_available_now.detail, /recorded as unavailable/);
  });
});

describe('AM-E5: what the read is able to say about itself', () => {
  test('the audit line carries counts and capability names, and no prose at all', async () => {
    const outcomes = await outcomesForGoal(
      planStore([
        planWith({ s1: { status: StepStatus.FAILED, action: 'memory.list' } }),
        { id: 'plan-bbbb2222', steps: [{ id: 's1', action: 'calc.evaluate' }], stepResults: { s1: { status: StepStatus.UNCERTAIN, operationId: 'op-9' } } },
      ]),
      { goalId: 'goal-1' },
    );
    const audit = outcomesAudit(outcomes);
    assert.deepEqual(Object.keys(audit).sort(), ['capabilities', 'plans', 'read', 'records', 'truncated']);
    assert.equal(typeof audit.read, 'boolean');
    assert.equal(typeof audit.records, 'number');
    assert.deepEqual(audit.capabilities, ['calc.evaluate', 'memory.list']);
    assert.equal(JSON.stringify(audit).includes('the '), false, 'the audit shape holds no sentences');
  });

  test('two readers of the same records answer identically, and one extra recorded failure moves the answer', async () => {
    const registry = registryWith(['memory.list', 'memory.search']);
    const mk = (plans) => outcomesForGoal(planStore(plans), { goalId: 'goal-1' });
    const base = [planWith({ s1: { status: StepStatus.FAILED, action: 'memory.list' } })];
    const a = compare({ registry, outcomes: await mk(base), candidates: [candidateOf(registry, 'uses_read', [{ action: 'memory.list' }])] });
    const b = compare({ registry, outcomes: await mk(base), candidates: [candidateOf(registry, 'uses_read', [{ action: 'memory.list' }])] });
    assert.equal(JSON.stringify(a.outcomesRead), JSON.stringify(b.outcomesRead));
    assert.equal(renderEvaluation(a), renderEvaluation(b), 'the same records print the same answer');
    // The same capability with nothing recorded any more: the answer moves, because the read moved and
    // not because anything about the approach changed.
    const cleared = compare({
      registry,
      outcomes: await mk([]),
      candidates: [candidateOf(registry, 'uses_read', [{ action: 'memory.list' }])],
    });
    assert.notEqual(JSON.stringify(cleared.outcomesRead), JSON.stringify(a.outcomesRead));
    assert.notEqual(renderEvaluation(cleared), renderEvaluation(a));
    assert.match(ranked(rowOf(cleared, 'uses_read'), 'recorded_outcome_history').band,
      /nothing on the 0 recorded plan\(s\) for this goal ended failed or uncertain/);
  });

  test('the band stays short, and the answer stays bounded however many outcomes are on record', async () => {
    const registry = registryWith(['memory.list']);
    const many = {};
    for (let i = 1; i <= OUTCOME_BOUND; i += 1) many[`s${i}`] = { status: StepStatus.FAILED, action: 'memory.list' };
    const evaluation = compare({
      registry,
      outcomes: await outcomesForGoal(planStore([planWith(many)]), { goalId: 'goal-1' }),
      candidates: [candidateOf(registry, 'uses_read', [{ action: 'memory.list' }])],
    });
    const band = ranked(rowOf(evaluation, 'uses_read'), 'recorded_outcome_history').band;
    assert.ok(band.length < 900, `the band is bounded: ${band.length} characters`);
    assert.ok(renderEvaluation(evaluation).split('\n').length < 40, 'the comparison stays readable');
  });
});

describe('AM-E6: the whole path, with a failure APEX wrote itself', () => {
  // A goal whose criteria the real matcher can ground in registered capabilities, so a candidate is
  // actually produced - and one of those capabilities is calc.evaluate, which is the one the plan below
  // makes fail. The failure is a record APEX wrote by running the plan, not one this file describes.
  const GROUNDED = {
    request: 'search the notes and remember the release date',
    criteria: [
      'remember the release date',
      'search memory for alpha',
      'compute (12+7)*3',
      'the vault is archived',
    ],
  };

  async function goalWithAFailedStep(dataDir) {
    const app = await appIn(dataDir);
    const created = await app.controller.goalAdd({
      request: GROUNDED.request,
      criteria: GROUNDED.criteria.map((description) => ({ description, basis: 'user_stated' })),
    });
    const goalId = data(created).goalId;
    for (const status of ['accepted', 'active']) await app.controller.goalUpdate({ target: goalId, status });
    const add = await app.controller.planAdd({
      goalId,
      outcome: 'the release date is remembered, the notes are searched, and the sum is computed',
      steps: [
        { id: 's1', description: 'compute the sum', action: 'calc.evaluate', input: { expression: '1/0' }, dependsOn: [], expectedResult: 'a result is recorded', verification: 'the action re-checks its own result', risk: 'low', reversibility: 'read_only', criterionId: 'c3' },
        { id: 's2', description: 'remember the release date', action: 'memory.add', input: { content: 'the AM dimension note' }, dependsOn: [], expectedResult: 'the note is in the record', verification: 'the record is read back', risk: 'medium', reversibility: 'reversible', criterionId: 'c1' },
      ],
    });
    const planId = data(add).planId;
    await app.controller.planApprove({ target: planId });
    const start = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(start.status, Outcome.EXECUTION_FAILED, display(start));
    return { app, goalId, planId };
  }

  test('a recorded failure of this configuration makes the comparison say which steps it exposes', async () => {
    const { app, goalId } = await goalWithAFailedStep(dir());
    const read = await app.controller.planCandidates({ goal: goalId });
    assert.equal(read.status, Outcome.SUCCESS_VERIFIED, display(read));
    const comparison = data(read).comparison;
    assert.equal(comparison.outcomes.read, true, 'the read looked, rather than assumed');
    assert.ok(comparison.outcomes.records >= 1, 'and found the failure this configuration wrote');
    assert.deepEqual(comparison.outcomes.capabilities, ['calc.evaluate']);
    assert.equal(comparison.outcomes.truncated, false);
    const bands = read.display.match(/recorded_outcome_history: [^\n]*/g) ?? [];
    assert.ok(bands.length >= 1, 'the band is printed beside every candidate that passed the gates');
    for (const band of bands) {
      assert.match(band, /calc\.evaluate|no step here names|ended failed or uncertain|what past runs did ranks nothing/);
      assert.ok(band.length < 900, 'and stays bounded');
    }
    assert.match(display(read), /verification_quality: /);
  });

  test('a revision of the plan that stopped is ranked against what that plan left on record', async () => {
    const { app, planId } = await goalWithAFailedStep(dir());
    const read = await app.controller.planReplan({ plan: planId, reason: 'the first step divides by zero' });
    assert.equal(read.status, Outcome.SUCCESS_VERIFIED, display(read));
    const comparison = data(read).comparison;
    assert.equal(comparison.outcomes.read, true);
    assert.deepEqual(comparison.outcomes.capabilities, ['calc.evaluate']);
    assert.ok(comparison.rule.includes('recorded_outcome_history'), 'the rule the reader is shown names the dimension');
    assert.match(display(read), /recorded_outcome_history: /);
  });

  test('a goal with no plan record yet is reported as having none, not as clean by luck', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const created = await app.controller.goalAdd({
      request: GROUNDED.request,
      criteria: GROUNDED.criteria.map((description) => ({ description, basis: 'user_stated' })),
    });
    const goalId = data(created).goalId;
    for (const status of ['accepted', 'active']) await app.controller.goalUpdate({ target: goalId, status });
    const read = await app.controller.planCandidates({ goal: goalId });
    assert.equal(read.status, Outcome.SUCCESS_VERIFIED, display(read));
    const comparison = data(read).comparison;
    assert.equal(comparison.outcomes.read, true);
    assert.equal(comparison.outcomes.records, 0);
    assert.equal(comparison.outcomes.plans, 0);
    assert.match(display(read), /ended failed or uncertain/);
  });

  test('the CLI prints both new bands, and a second run of the same records prints the same thing', async () => {
    const dataDir = dir();
    const { goalId } = await goalWithAFailedStep(dataDir);
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
    const first = await runCli(['plan', 'candidates', shortId(goalId)], env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /verification_quality: /);
    assert.match(first.stdout, /recorded_outcome_history: /);
    const second = await runCli(['plan', 'candidates', shortId(goalId)], env);
    assert.equal(second.code, 0, second.stderr);
    // Every line but the audit reference: that id is this run's own operation, and it is the one thing
    // two reads of the same records are allowed to differ over.
    const withoutAudit = (text) => text.split('\n').filter((l) => !l.startsWith('Audit: recorded in operations.jsonl')).join('\n');
    assert.equal(withoutAudit(second.stdout), withoutAudit(first.stdout), 'the same records answer the same way from another process');
  });
});
