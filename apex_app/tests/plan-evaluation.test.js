// Batch AL, work package D: comparing candidate plans, selecting between them, and explaining both.
//
// `src/plans/evaluation.js` is the transparent plan-evaluation mechanism this batch asks for. Four
// claims carry it, and each is tested against the exact text a user would read:
//   1. A gate is a fact that makes a candidate un-runnable, so it removes the candidate and says
//      what is wrong; it never marks it down. Every gate re-reads the candidate's own bytes, because
//      a gate that trusted the candidate's self-report would not be a check.
//   2. Ordering is a Pareto comparison over a short, disclosed list of recorded dimensions. A
//      candidate leads only where nothing else is as good on all of them and better on one; where the
//      dimensions pull in opposite directions both stay and the trade-off is reported unresolved.
//   3. Nothing is scored. No composite number, no weight, no probability, no percentage: the records
//      hold counts and classes, and reporting more would be false precision.
//   4. An evaluation is not a permission. It approves nothing, records nothing and starts nothing,
//      and it is bound to the digests of the candidates it looked at.
//
// Where a defect must be forced - a cycle, a step count over the plan bound, a candidate that claims
// to be valid while its bytes say otherwise - the candidate is a fixture. A generator will not
// produce those, and the gate exists to catch them. Every fixture is built in the shape
// `buildCandidate` returns, with the derived fields computed the way the generator computes them, so
// a fixture cannot pass or fail a gate for a reason production output could not. Everything else runs
// through the real app, the live action registry, the real goal and plan stores, and the shipped read
// actions. No model service is contacted; no inference is performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { stableStringify } from '../src/tasks/model.js';
import { MAX_CANDIDATES_PER_GOAL, MAX_PLAN_STEPS, RISK_ORDER, planContentHash, planRisk, validatePlanContent } from '../src/plans/model.js';
import { candidatesForGoal, CandidateStrategy } from '../src/plans/candidates.js';
import {
  DISCLOSED_DIMENSIONS, EVALUATION_NOTE, EVALUATION_RULE, GATES, RANKED_DIMENSIONS,
  evaluateCandidates, renderEvaluation,
} from '../src/plans/evaluation.js';
import { makeTempDataDir, cleanup } from './helpers.js';

// A controller write wrapper returns `{status, output, operation}`; a `runAction` step returns the
// step itself. The payload is one level deeper in the first shape than in the second.
const commandData = (res) => res.operation.steps[0].result.data;
const stepData = (step) => step.result.data;

async function appIn(dir) {
  return createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF });
}

async function addGoal(app, { request, criteria }) {
  const res = await app.controller.goalAdd({ request, criteria });
  assert.equal(res.status, Outcome.GOAL_CREATED, `goal add failed: ${res.output}`);
  return app.goals.get(commandData(res).goalId);
}

// Same goal tests/plan-generation.test.js uses for the generator: three criteria the live registry
// can carry, one of them only as an APEX suggestion, and one that nothing registered can carry.
const MIXED = {
  request: 'search the notes and remember the release date',
  criteria: [
    'remember the release date',
    'search memory for alpha',
    { description: 'compute (12+7)*3', basis: 'system_inferred' },
    'the vault is archived',
  ],
};

const REQUIRED_ONLY = CandidateStrategy.REQUIRED_ONLY;
const ALL_OPEN = CandidateStrategy.ALL_OPEN_CRITERIA;
const READ_FIRST = CandidateStrategy.READ_BEFORE_WRITE;

function digestOf(content) {
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}

// A step in the shape a plan record holds, naming an action the shipped registry really has.
function fxStep(id, action, { criterion = null, risk = 'medium', reversibility = 'reversible', input = {} } = {}) {
  return {
    id,
    description: `the ${id} step of the fixture plan`,
    action,
    input,
    dependsOn: [],
    expectedResult: `the ${id} result is recorded`,
    verification: 'the action re-checks its own result',
    ...(criterion === null ? {} : { criterionId: criterion }),
    risk,
    estimate: { seconds: null },
    reversibility,
    recovery: 'the task stops here and later steps do not run',
  };
}

// A goal as the evaluator sees it. The store's goals carry more; an evaluation reads an id, a
// revision, a status, the criteria and the blockers, and the tests that need the real record go
// through the real store instead.
function fxGoal(over = {}) {
  return {
    id: 'fx-goal-1',
    revision: 1,
    status: 'active',
    prerequisites: [],
    blockers: [],
    criteria: [
      { id: 'c1', description: 'the first fixture fact is stored', requirement: 'required', status: 'open' },
      { id: 'c2', description: 'the second fixture fact is stored', requirement: 'required', status: 'open' },
      { id: 'c3', description: 'the fixture figure is produced', requirement: 'suggested', status: 'open' },
    ],
    ...over,
  };
}

// A candidate in the shape buildCandidate returns. The counts, the plan risk, the capability rows and
// the digest are derived here exactly as the generator derives them, so a fixture that mutates bytes
// cannot keep a digest that no longer describes them.
function fxCandidate(registry, goal, {
  strategy = 'fixture_approach',
  steps = [],
  covered = [],
  unaddressed = [],
  assumed = [],
  leftOut = [],
  beyond = [],
  seconds = null,
  assertions = [],
  preconditions = [],
  validation = null,
  goalId = undefined,
} = {}) {
  const chained = steps.map((s, i) => ({ ...s, dependsOn: i === 0 ? [] : [steps[Math.max(0, i - 1)].id] }));
  const content = {
    goalId: goalId === undefined ? goal.id : goalId,
    outcome: `the fixture goal settles its recorded criteria`,
    steps: chained,
    preconditions,
    assertions,
    resources: { estimatedSeconds: seconds },
  };
  const problems = validatePlanContent(content);
  const own = validation ?? { ok: problems.length === 0, problems };
  const writes = chained.filter((s) => registry.get(s.action)?.permission === 'write').length;
  const capabilities = [...new Set(chained.map((s) => s.action))].sort().map((action) => {
    const def = registry.get(action) ?? {};
    return {
      action,
      permission: def.permission ?? 'unregistered',
      plannable: def.plannable !== false,
      hasVerifier: typeof def.verify === 'function',
      reversibility: def.permission === 'write' ? 'reversible' : 'read_only',
    };
  });
  return {
    strategy,
    note: `fixture approach ${strategy}`,
    outcome: content.outcome,
    content,
    digest: digestOf(content),
    steps: chained.length,
    writes,
    reads: chained.length - writes,
    risk: planRisk(chained),
    reversibility: chained.map((s) => ({ id: s.id, action: s.action, reversibility: s.reversibility })),
    failurePaths: chained.map((s) => ({ id: s.id, action: s.action, recovery: s.recovery })),
    capabilities,
    criteriaCovered: covered,
    criteriaSharedWithAnEarlierStep: [],
    criteriaLeftUnaddressed: unaddressed,
    criteriaAssumedFromTheGoalRequest: assumed,
    criteriaLeftOutOfThisApproach: leftOut,
    criteriaFromInference: [],
    stepsBeyondThePlanBound: beyond,
    estimatedSeconds: seconds,
    validation: own,
    executable: false,
    approved: false,
    readyForApproval: own.ok,
  };
}

// What candidatesForGoal hands the evaluator, so a fixture set travels through the same call shape.
const fxResult = (candidates, over = {}) => ({
  ok: true,
  reason: null,
  problems: [],
  candidates,
  skipped: [],
  unaddressed: [],
  assumedFromGoalRequest: [],
  clarificationNeeded: false,
  ...over,
});

// A mutated copy, re-digested: the candidate a generator would have produced from these bytes.
function variant(candidate, edit) {
  const copy = structuredClone(candidate);
  edit(copy);
  return { ...copy, digest: digestOf(copy.content) };
}

const ranked = (row, name) => row.assessed.ranked[name];
const disclosed = (row, name) => row.assessed.disclosed[name];
const rowOf = (evaluation, strategy) => evaluation.candidates.find((r) => r.strategy === strategy);
const behindOf = (evaluation, strategy) => evaluation.behind.find((b) => b.strategy === strategy);
const failedGateNames = (row) => Object.entries(row.gates).filter(([, g]) => !g.passed).map(([n]) => n);

// Every string the evaluation holds, however deep: these are the words a user reads.
function everyString(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) everyString(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) everyString(v, out);
  return out;
}

// Every key name, however deep. A composite measure would have to be named somewhere, and a name
// like `score` in a structure the reader is shown would read as knowledge the records do not hold.
function everyKey(value, out = []) {
  if (Array.isArray(value)) for (const v of value) everyKey(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      everyKey(v, out);
    }
  }
  return out;
}

function fileOrEmpty(dir, name) {
  const file = path.join(dir, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

test('a real candidate set is compared under a disclosed rule, and nothing about it is scored', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    const generated = candidatesForGoal({ goal, registry: app.registry });
    assert.equal(generated.candidates.length, 3, 'three genuinely different approaches are available');
    const evaluation = evaluateCandidates({ result: generated, goal, registry: app.registry });

    assert.equal(evaluation.ok, true);
    assert.equal(evaluation.reason, null);
    assert.deepEqual(evaluation.problems, []);
    assert.equal(evaluation.rule, EVALUATION_RULE);
    assert.deepEqual(evaluation.rankedDimensions, RANKED_DIMENSIONS);
    assert.deepEqual(evaluation.disclosedDimensions, DISCLOSED_DIMENSIONS);
    assert.deepEqual(evaluation.gates, GATES);
    assert.equal(evaluation.goalId, goal.id);
    assert.equal(evaluation.goalRevision, goal.revision);
    assert.equal(evaluation.note, EVALUATION_NOTE);

    // The rule says what it does in words the reader is shown, and disowns the number it does not have.
    assert.match(EVALUATION_RULE, /Hard gates first/);
    assert.match(EVALUATION_RULE, /at least as good on all of them and strictly better on at least one/);
    assert.match(EVALUATION_RULE, /No score, weight, or probability is computed/);
    assert.match(EVALUATION_NOTE, /not a prediction, a probability, or an approval/);

    for (const row of evaluation.candidates) {
      assert.deepEqual(Object.keys(row.gates), GATES, 'every gate is reported, passed or not');
      for (const g of Object.values(row.gates)) {
        assert.equal(typeof g.passed, 'boolean');
        assert.ok(g.detail.length > 0, 'a gate that says nothing has checked nothing');
      }
      for (const name of RANKED_DIMENSIONS) assert.ok(ranked(row, name).band.length > 0);
      for (const name of DISCLOSED_DIMENSIONS) assert.ok(disclosed(row, name).band.length > 0);
      assert.equal(row.included, true);
      const source = generated.candidates.find((c) => c.strategy === row.strategy);
      assert.equal(row.digest, source.digest, 'the comparison describes the candidate bytes the generator produced');
      assert.equal(row.steps, source.steps);
      assert.equal(row.readyForApproval, source.readyForApproval, 'readiness is carried through, not re-decided here');
    }

    // Two of the three criteria are carryable and one is not, so no approach settles the whole goal.
    const only = rowOf(evaluation, REQUIRED_ONLY);
    assert.equal(ranked(only, 'criterion_coverage').band, 'settles 2 of the 3 open required criteria; c4 is not settled by this approach');
    assert.equal(ranked(only, 'criterion_coverage').value, 2);
    assert.equal(ranked(only, 'uncertainty').band, 'c4 is taken on without a step that settles it from its own words');
    assert.equal(ranked(only, 'uncertainty').value, 1);
    assert.equal(ranked(only, 'uncertainty').invert, true);
    assert.equal(ranked(only, 'step_risk').band, 'highest recorded step risk medium');
    assert.equal(ranked(only, 'reversibility').band, 'appends 1 record(s); a later record corrects what was written, nothing erases it');
    assert.equal(ranked(only, 'resource_requirements').band, '2 step(s), 1 of them a write; no recorded duration, so no effort estimate');
    assert.deepEqual(ranked(only, 'resource_requirements').value, [1, 2]);
    // The two dimensions Batch AM added to the ordering. Both are counts of records, both reach zero
    // for these approaches, and the second one is not read at all here - which is reported as not read
    // rather than as a clean history.
    assert.equal(ranked(only, 'verification_quality').band, 'no step is left without its action\'s own verifier (2 step(s), each re-checked independently)');
    assert.equal(ranked(only, 'verification_quality').value, 0);
    assert.equal(ranked(only, 'verification_quality').invert, true);
    assert.equal(ranked(only, 'recorded_outcome_history').band,
      'no recorded step outcome was handed to this comparison, so what past runs did ranks nothing');
    assert.equal(ranked(only, 'recorded_outcome_history').value, null);
    assert.deepEqual(evaluation.outcomesRead, { read: false, records: 0, plans: 0, truncated: false, capabilities: [] });
    assert.equal(disclosed(only, 'goal_alignment').band,
      'leaves the APEX suggestion c3 out of the approach; not ranked, because what the approach settles is already counted by criterion_coverage');
    assert.equal(disclosed(only, 'evidence_sufficiency').band,
      '1 established assertion(s) (user_fact); 2 inference or unknown; not ranked, because an assertion\'s kind is what the candidate claims about itself, and a count of self-claims would reward the candidate that claims most');
    assert.equal(disclosed(only, 'dependency_validity').band,
      'each step lists the step before it, as the sequential runner works; not ranked, because a dependency structure that is wrong is a gate and one that is right leaves nothing to compare');
    assert.equal(disclosed(only, 'capability_availability').band,
      'memory.add (write, has its own verifier), memory.search (read, has its own verifier); not ranked, because a capability the registry refuses is a gate, not a drawback, and the verifier count is already ranked');
    assert.equal(disclosed(only, 'expected_verification_quality').band,
      'every step is re-checked by its own action\'s verifier; the verifier count is ranked as verification_quality; the evidence conditions are reported here, because asking for evidence is not a quantity to trade against a count');
    assert.equal(disclosed(only, 'known_blockers').band,
      'no blocker, prerequisite, dependency, or evidence condition is recorded on this goal for the comparison to answer; nothing here is ranked, because a record that stops work is a gate and one that does not is context');

    // The two three-step approaches record the same work in a different order, so the rule can put one
    // ahead of the other on nothing - and the shorter plan is ahead on the one dimension that differs.
    assert.deepEqual(evaluation.included, [REQUIRED_ONLY, ALL_OPEN, READ_FIRST]);
    assert.deepEqual(evaluation.front, [REQUIRED_ONLY]);
    assert.deepEqual(evaluation.behind.map((b) => b.strategy), [ALL_OPEN, READ_FIRST]);
    for (const b of evaluation.behind) {
      assert.deepEqual(b.whyBehind, [{ under: REQUIRED_ONLY, on: ['resource_requirements'] }]);
      assert.deepEqual(b.betterThanThose, []);
    }
    assert.equal(evaluation.selection.leading, REQUIRED_ONLY);
    assert.equal(evaluation.selection.basis, 'no other candidate that passed every gate is as good on all ranked dimensions and better on one');
    assert.equal(evaluation.selection.unresolvedTradeOff, false);
    assert.deepEqual(evaluation.selection.tradeOffs, []);
    assert.deepEqual(evaluation.selection.ties, []);
    assert.equal(evaluation.selection.approved, false);
    assert.equal(evaluation.selection.executable, false);
    assert.equal(evaluation.selection.userDecisionRequired, true);
    assert.equal(evaluation.selection.note, 'leading is a position under the disclosed rule, not a claim that this plan will work');
    assert.equal(evaluation.clarificationNeeded, true, 'a criterion nothing can carry is a question, not a ranking');

    // Why the alternatives are less suitable, in one line each the reader can act on.
    assert.deepEqual(evaluation.whatWouldSettleIt, [
      'a criterion no registered capability can carry: c4 ("the vault is archived")',
    ]);

    // Bound to the bytes compared, so the statement can be checked against the candidates it describes.
    assert.deepEqual(evaluation.boundTo.candidateDigests, evaluation.candidates.map((r) => ({ strategy: r.strategy, digest: r.digest })));
    assert.equal(evaluation.boundTo.candidateSetDigest, stableStringify(evaluation.candidates.map((r) => r.digest)));
    for (const c of generated.candidates) {
      assert.equal(evaluation.boundTo.candidateDigests.find((d) => d.strategy === c.strategy).digest, c.digest);
    }

    // No hidden measure anywhere in the structure, and no number dressed as a share or a chance.
    for (const key of everyKey(evaluation)) {
      assert.doesNotMatch(key, /score|weight|probab|likelihood|percent|confiden|utilit/i, `${key} would be a number the records do not support`);
    }
    for (const text of everyString(evaluation)) {
      assert.doesNotMatch(text, /\d+(?:\.\d+)?\s*%/);
      assert.doesNotMatch(text, /\bis (\d+|\w+) to (1|one)\b/i);
    }

    const rendered = renderEvaluation(evaluation);
    assert.match(rendered, new RegExp(`Plan evaluation for goal ${goal.id.slice(0, 21)}\\.\\.\\. \\(revision ${goal.revision}\\):`));
    assert.ok(rendered.includes(`rule: ${EVALUATION_RULE}`));
    for (const name of RANKED_DIMENSIONS) assert.ok(rendered.includes(`    ${name}: `), `${name} is not printed`);
    for (const name of DISCLOSED_DIMENSIONS) assert.ok(rendered.includes(`    ${name} (reported, not ranked): `), `${name} is not printed`);
    assert.ok(rendered.includes('    no other gated candidate does better everywhere and never worse'));
    assert.ok(rendered.includes('    not recorded, not approved, not started'));
    assert.ok(rendered.includes(`under that rule ${REQUIRED_ONLY} leads: no other candidate that passed every gate is as good on all ranked dimensions and better on one.`));
    assert.ok(rendered.includes('that is a position in the comparison, not a forecast: it is the user who records and approves a plan.'));
    assert.ok(rendered.includes('    - a criterion no registered capability can carry: c4 ("the vault is archived")'));
    assert.ok(rendered.endsWith(EVALUATION_NOTE));
    assert.doesNotMatch(rendered, /\d+(?:\.\d+)?\s*%/);
  } finally {
    cleanup(dir);
  }
});

test('a capability gate excludes a candidate and names what is wrong; it does not mark it down', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = fxGoal();
    const base = fxCandidate(app.registry, goal, { strategy: 'writes_then_reads', steps: [fxStep('s1', 'memory.add', { criterion: 'c1' }), fxStep('s2', 'memory.search', { criterion: 'c2' })], covered: ['c1', 'c2'] });
    assert.deepEqual(failedGateNames(rowOf(evaluateCandidates({ result: fxResult([base]), goal, registry: app.registry }), 'writes_then_reads')), []);

    // A step whose action this configuration does not register: the name is well-formed, so nothing but
    // the registry can refuse it, and an invented capability is the failure this layer exists to catch.
    const invented = variant(base, (c) => { c.content.steps[1].action = 'vault.archive'; });
    const unregistered = evaluateCandidates({ result: fxResult([invented]), goal, registry: app.registry });
    const unreg = rowOf(unregistered, 'writes_then_reads');
    assert.deepEqual(failedGateNames(unreg), ['capability_available_now']);
    assert.equal(unreg.gates.capability_available_now.detail, 's2: vault.archive is not registered in this configuration');
    // The excluded row is still described honestly, including that no registered action backs the step.
    assert.equal(disclosed(unreg, 'expected_verification_quality').band,
      'no independent verifier for s2; the verifier count is ranked as verification_quality; the evidence conditions are reported here, because asking for evidence is not a quantity to trade against a count');
    assert.equal(ranked(unreg, 'verification_quality').band, 's2 names an action with no independent verifier, so its completion rests on the action returning');
    assert.equal(ranked(unreg, 'verification_quality').value, 1);

    // An action that is registered but that a plan may not contain.
    const unplannable = variant(base, (c) => { c.content.steps[0].action = 'memory.correct'; });
    const gatedUnplannable = rowOf(evaluateCandidates({ result: fxResult([unplannable]), goal, registry: app.registry }), 'writes_then_reads');
    assert.deepEqual(failedGateNames(gatedUnplannable), ['capability_available_now']);
    assert.equal(gatedUnplannable.gates.capability_available_now.detail, 's1: memory.correct cannot be part of a plan');

    // A capability the handed evidence records as unable to run now. This is what a revision that
    // quietly kept the action which just failed is gated out by.
    const unavailable = evaluateCandidates({
      result: fxResult([base]),
      goal,
      registry: app.registry,
      evidence: { unavailableActions: ['memory.search'], knownBlockers: [] },
    });
    const gatedUnavailable = rowOf(unavailable, 'writes_then_reads');
    assert.deepEqual(failedGateNames(gatedUnavailable), ['capability_available_now']);
    assert.equal(gatedUnavailable.gates.capability_available_now.detail, 's2: memory.search is recorded as unavailable, so this generation does not offer it');

    // Excluded means excluded: nowhere in the ordering, not a lower place in it.
    for (const evaluation of [unregistered, unavailable]) {
      assert.equal(evaluation.ok, false);
      assert.equal(evaluation.reason, 'every-candidate-gated');
      assert.equal(evaluation.selection.leading, null);
      assert.equal(evaluation.selection.basis, null, 'a comparison that compared nothing has no basis to state');
      assert.deepEqual(evaluation.included, []);
      assert.deepEqual(evaluation.front, []);
      assert.deepEqual(evaluation.behind, []);
      assert.deepEqual(evaluation.excluded.map((e) => e.strategy), ['writes_then_reads']);
      assert.deepEqual(evaluation.excluded[0].failedGates, [{ gate: 'capability_available_now', detail: evaluation.candidates[0].gates.capability_available_now.detail }]);
      assert.equal(evaluation.excluded[0].digest, evaluation.candidates[0].digest);
      assert.equal(evaluation.clarificationNeeded, true);
      assert.ok(evaluation.whatWouldSettleIt.includes('what is wrong with each candidate, per gate, is listed above; nothing can be ranked until one of them passes every gate'));
    }

    // One candidate gated out of a set of two leaves the comparison standing on the one that runs.
    const pair = evaluateCandidates({ result: fxResult([base, invented]), goal, registry: app.registry });
    assert.equal(pair.ok, true);
    assert.deepEqual(pair.included, ['writes_then_reads']);
    assert.deepEqual(pair.front, ['writes_then_reads']);
    assert.deepEqual(pair.excluded.map((e) => e.strategy), ['writes_then_reads']);
    assert.equal(pair.candidates.length, 2, 'the excluded candidate is still shown, with its gate');

    const rendered = renderEvaluation(pair);
    assert.ok(rendered.includes('writes_then_reads - EXCLUDED: fixture approach writes_then_reads'));
    assert.ok(rendered.includes('    gate capability_available_now: s2: vault.archive is not registered in this configuration'));
    assert.ok(rendered.includes('  writes_then_reads: fixture approach writes_then_reads'));
  } finally {
    cleanup(dir);
  }
});

test('the structural gates re-read the candidate bytes and do not trust its own report', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = fxGoal();

    // The candidate calls itself valid while its steps form a cycle. A gate that read the self-report
    // would rank an un-runnable plan.
    const cyclic = fxCandidate(app.registry, goal, {
      strategy: 'circular',
      steps: [fxStep('s1', 'memory.add'), fxStep('s2', 'memory.search')],
      validation: { ok: true, problems: [] },
    });
    cyclic.content.steps[0].dependsOn = ['s2'];
    cyclic.content.steps[1].dependsOn = ['s1'];
    cyclic.digest = digestOf(cyclic.content);
    const circle = rowOf(evaluateCandidates({ result: fxResult([cyclic]), goal, registry: app.registry }), 'circular');
    assert.equal(circle.gates.candidate_validation.passed, false, 'the candidate called itself valid; the bytes say otherwise');
    // The cycle path is named from the repeated id and closes on itself, because a cycle that is not
    // closed in the wording is not a statement of what is wrong.
    assert.equal(circle.gates.candidate_validation.detail, 'dependency cycle: s1 -> s2 -> s1');
    assert.equal(circle.gates.dependency_structure.detail, 'dependency cycle: s1 -> s2 -> s1');
    assert.deepEqual(failedGateNames(circle), ['candidate_validation', 'dependency_structure']);

    // And the other direction: the generator reported a problem the re-check cannot reproduce. The
    // report is kept, because the generator may have read something the gate has not.
    const selfRefused = fxCandidate(app.registry, goal, {
      strategy: 'self_refused',
      steps: [fxStep('s1', 'memory.add')],
      validation: { ok: false, problems: ['the archive service refused this write'] },
    });
    const refusedRow = rowOf(evaluateCandidates({ result: fxResult([selfRefused]), goal, registry: app.registry }), 'self_refused');
    assert.equal(refusedRow.gates.candidate_validation.detail, 'the archive service refused this write');
    assert.deepEqual(failedGateNames(refusedRow), ['candidate_validation']);

    // A nameless failure is still a failure: it is not read as a pass.
    const nameless = fxCandidate(app.registry, goal, { strategy: 'nameless', steps: [fxStep('s1', 'memory.add')], validation: { ok: false, problems: [] } });
    assert.equal(rowOf(evaluateCandidates({ result: fxResult([nameless]), goal, registry: app.registry }), 'nameless').gates.candidate_validation.detail, 'the generator reported a problem without naming it');

    // Steps beyond the bound a plan record can hold: a candidate that could never be stored could
    // never be approved, so it is gated rather than ranked.
    const many = fxCandidate(app.registry, goal, {
      strategy: 'too_many_steps',
      steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => fxStep(`s${i + 1}`, 'memory.add')),
      covered: ['c1', 'c2'],
    });
    const manyRow = rowOf(evaluateCandidates({ result: fxResult([many]), goal, registry: app.registry }), 'too_many_steps');
    // The bound is re-measured here, not taken from the generator: both the re-validated content and
    // the dependency structure carry the same over-long step list, and the bound gate names it again
    // as its own measurement rather than as a validation problem it inherited.
    assert.deepEqual(failedGateNames(manyRow), ['candidate_validation', 'dependency_structure', 'plan_bounds']);
    assert.equal(manyRow.gates.candidate_validation.detail, `a plan may have at most ${MAX_PLAN_STEPS} steps`);
    assert.equal(manyRow.gates.dependency_structure.detail, `a plan may have at most ${MAX_PLAN_STEPS} steps`);
    assert.equal(manyRow.gates.plan_bounds.detail, `a plan may have at most ${MAX_PLAN_STEPS} steps`);

    // No steps at all: three separate facts, each reported.
    const none = fxCandidate(app.registry, goal, { strategy: 'empty', steps: [] });
    const emptyRow = rowOf(evaluateCandidates({ result: fxResult([none]), goal, registry: app.registry }), 'empty');
    assert.deepEqual(failedGateNames(emptyRow), ['candidate_validation', 'dependency_structure', 'plan_bounds']);
    assert.equal(emptyRow.gates.plan_bounds.detail, 'a plan needs at least one step');

    // The bounds on what a plan record states, measured again here rather than trusted.
    const overstated = fxCandidate(app.registry, goal, {
      strategy: 'overstated',
      steps: [fxStep('s1', 'memory.add')],
      preconditions: Array.from({ length: 9 }, (_, i) => `precondition ${i + 1}`),
      assertions: Array.from({ length: 9 }, (_, i) => ({ kind: 'inference', text: `assertion ${i + 1}` })),
    });
    const overRow = rowOf(evaluateCandidates({ result: fxResult([overstated]), goal, registry: app.registry }), 'overstated');
    assert.deepEqual(failedGateNames(overRow), ['candidate_validation', 'plan_bounds']);
    assert.equal(overRow.gates.plan_bounds.detail, 'a plan may state at most 8 preconditions; a plan may classify at most 8 assertions');

    // The passing wordings state which bound was measured and against how many capabilities.
    const clean = fxCandidate(app.registry, goal, { strategy: 'clean', steps: [fxStep('s1', 'memory.add')], covered: ['c1'] });
    const cleanRow = rowOf(evaluateCandidates({ result: fxResult([clean]), goal, registry: app.registry }), 'clean');
    assert.deepEqual(failedGateNames(cleanRow), []);
    assert.match(cleanRow.gates.candidate_validation.detail, new RegExp(`^the generator's own read-only validation passed; 1 step\\(s\\) against a registry of \\d+ action\\(s\\)$`));
    assert.equal(cleanRow.gates.dependency_structure.detail, 'each step depends only on steps before it, and the ids are unique');
    assert.equal(cleanRow.gates.capability_available_now.detail, 'every step names a registered, plannable capability this configuration authorizes');
    assert.equal(cleanRow.gates.plan_bounds.detail, 'within the 8-step, 8-precondition and 8-assertion bounds');
  } finally {
    cleanup(dir);
  }
});

test('a candidate is checked against the goal as it is recorded now, not as it was generated', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    const generated = candidatesForGoal({ goal, registry: app.registry });
    const registry = app.registry;

    const live = evaluateCandidates({ result: generated, goal, registry });
    for (const row of live.candidates) {
      assert.equal(row.gates.goal_still_open.passed, true);
      assert.equal(row.gates.goal_still_open.detail, `the goal is ${goal.status}, and the candidate is bound to goal revision ${goal.revision}`);
    }

    // A candidate for another goal is a statement about an intention this record does not hold.
    const elsewhere = variant(generated.candidates[0], (c) => { c.content.goalId = 'other-goal'; });
    const wrongGoal = rowOf(evaluateCandidates({ result: fxResult([elsewhere]), goal, registry }), elsewhere.strategy);
    assert.deepEqual(failedGateNames(wrongGoal), ['goal_still_open']);
    assert.equal(wrongGoal.gates.goal_still_open.detail, 'the candidate is for goal other-goal, not ' + goal.id.slice(0, 21) + '...');

    // The user's recorded revision moves the binding: the same candidate text is now compared against
    // a different goal record, and its bands describe the goal as it now stands.
    const reviseEvent = await app.goals.revise(goal.id, {
      request: 'search the notes and remember the release date',
      criteria: ['remember the release date', 'search memory for alpha'],
      reason: 'the test narrowed the intention',
    });
    assert.equal(reviseEvent.event.type, 'goal_revised');
    const revised = reviseEvent.goal;
    assert.equal(revised.revision, goal.revision + 1);
    // The goal log the revision left behind is what the comparison below must not change.
    const goalsAfterRevision = fileOrEmpty(dir, 'goals.jsonl');
    const afterRevision = evaluateCandidates({ result: generated, goal: revised, registry });
    for (const row of afterRevision.candidates) {
      assert.equal(row.gates.goal_still_open.passed, true);
      assert.equal(row.gates.goal_still_open.detail, `the goal is ${revised.status}, and the candidate is bound to goal revision ${revised.revision}`);
    }
    // Two required criteria instead of three: c4 has left the goal, so it no longer unsettles anything.
    assert.equal(ranked(rowOf(afterRevision, REQUIRED_ONLY), 'criterion_coverage').band, 'settles all 2 open required criteria (c1, c2)');
    assert.equal(ranked(rowOf(afterRevision, REQUIRED_ONLY), 'criterion_coverage').value, 2);
    assert.equal(ranked(rowOf(afterRevision, REQUIRED_ONLY), 'uncertainty').band, 'no required criterion is left unmatched, unaddressed, or outside the plan bound');
    assert.deepEqual(afterRevision.front, [REQUIRED_ONLY]);
    // The goal no longer records c4, but the generation handed over still reports it as uncarryable:
    // the evaluation repeats what that generation disclosed rather than re-deriving the goal.
    assert.deepEqual(afterRevision.whatWouldSettleIt, [
      'a criterion no registered capability can carry: c4 ("the vault is archived")',
    ]);

    // The comparison read nothing and wrote nothing: the goal log is what the user's revision left it.
    assert.equal(fileOrEmpty(dir, 'goals.jsonl'), goalsAfterRevision, 'only the user revision wrote; the comparison itself wrote nothing');

    // The user's recorded cancellation makes every candidate about work that is no longer open.
    const transitionEvent = await app.goals.transition(goal.id, 'cancelled', { reason: 'the test cancelled the intention' });
    assert.equal(transitionEvent.event.type, 'goal_transition');
    assert.equal(transitionEvent.event.to, 'cancelled');
    const cancelledGoal = transitionEvent.goal;
    assert.equal(cancelledGoal.status, 'cancelled');
    const cancelled = evaluateCandidates({ result: generated, goal: cancelledGoal, registry });
    for (const row of cancelled.candidates) {
      assert.deepEqual(failedGateNames(row), ['goal_still_open']);
      assert.equal(row.gates.goal_still_open.detail, 'the goal is cancelled, so this candidate plans work that is no longer open');
    }
    assert.deepEqual(cancelled.included, []);
    assert.deepEqual(cancelled.front, []);
    assert.equal(cancelled.reason, 'every-candidate-gated');
    assert.equal(cancelled.selection.basis, null);

    assert.equal(rowOf(evaluateCandidates({ result: generated, goal: null, registry }), REQUIRED_ONLY), undefined);
    const noGoal = evaluateCandidates({ result: generated, goal: null, registry });
    assert.equal(noGoal.ok, false);
    assert.equal(noGoal.reason, 'no-goal-or-registry');
    assert.match(noGoal.problems[0], /a goal and the live action registry are both needed/);
  } finally {
    cleanup(dir);
  }
});

test('the comparison ranks recorded facts, and says so when the records do not rank them', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = fxGoal();
    const registry = app.registry;

    // One step carries a criterion the goal records as needing evidence shown. The verification quality
    // is the registry's and the goal's, reported as what is carried and what is not.
    const withEvidence = fxGoal({
      criteria: [
        { id: 'c1', description: 'the first fixture fact is stored', requirement: 'required', status: 'open', requiredEvidence: 'the stored record is read back' },
        { id: 'c2', description: 'the second fixture fact is stored', requirement: 'required', status: 'open', requiredEvidence: 'a second read confirms it' },
      ],
    });
    const carried = fxCandidate(registry, withEvidence, {
      strategy: 'carries_one_condition',
      steps: [
        { ...fxStep('s1', 'memory.add', { criterion: 'c1' }), verification: 'the action re-checks its own result; and the stored record is read back' },
      ],
      covered: ['c1'],
      leftOut: ['c2'],
    });
    const row = rowOf(evaluateCandidates({ result: fxResult([carried]), goal: withEvidence, registry }), 'carries_one_condition');
    assert.equal(disclosed(row, 'expected_verification_quality').band,
      "every step is re-checked by its own action's verifier; the goal's recorded evidence condition is carried for c1 and not for c2, which has no step of its own here; "
      + 'the verifier count is ranked as verification_quality; the evidence conditions are reported here, because asking for evidence is not a quantity to trade against a count');
    assert.equal(disclosed(row, 'goal_alignment').band,
      'leaves required c2 out of the approach; not ranked, because what the approach settles is already counted by criterion_coverage');

    // A blocker the user recorded on the goal is an answer the comparison has to give, not a line of
    // text to carry along: an obstacle that names nothing stops every approach for that goal until the
    // record clears it, and the exclusion names the record, the steps, the reason and the resolution.
    const blocked = fxGoal({ blockers: [{ text: 'the archive service is offline' }] });
    const ignoring = fxCandidate(registry, blocked, { strategy: 'ignores_the_blocker', steps: [fxStep('s1', 'memory.add')], covered: ['c1'] });
    const stating = variant(ignoring, (c) => { c.strategy = 'states_the_blocker'; c.content.preconditions = ['the archive service is offline']; });
    const compared = evaluateCandidates({ result: fxResult([ignoring, stating]), goal: blocked, registry });
    assert.deepEqual(compared.excluded.map((e) => e.strategy), ['ignores_the_blocker', 'states_the_blocker'],
      'a blocker on record stops the work, whether or not the candidate mentions it');
    assert.deepEqual(compared.excluded[0].failedGates.map((g) => g.gate), ['constraints_satisfied'],
      'mentioning an obstacle in the preconditions is not the same as avoiding it');
    assert.match(compared.excluded[0].failedGates[0].detail, /confirmed_blocker con-[0-9a-f]{12} \("the archive service is offline"\) stops every step of this approach/);
    assert.match(compared.excluded[0].failedGates[0].detail, /the user's own words, recorded as a blocker on goal/);
    assert.match(compared.excluded[0].failedGates[0].detail, /what would clear it: /);
    assert.equal(compared.reason, 'every-candidate-gated');
    assert.equal(compared.front.length, 0, 'nothing that is stopped can be ranked');
    assert.match(disclosed(rowOf(compared, 'states_the_blocker'), 'known_blockers').band,
      /^1 confirmed_blocker on record; this approach is stopped by confirmed_blocker con-[0-9a-f]{12} at every step of this approach/);

    // Applicability is part of what a record has to establish. A blocker that names a capability no
    // step of a plan uses stops that plan not at all, and the disclosure says so in those terms.
    const bound = fxGoal({ blockers: [{ text: 'memory.search is disabled on this machine' }] });
    const elsewhere = fxCandidate(registry, bound, { strategy: 'writes_only', steps: [fxStep('s1', 'memory.add')], covered: ['c1'] });
    const unaffected = evaluateCandidates({ result: fxResult([elsewhere]), goal: bound, registry });
    assert.deepEqual(unaffected.included, ['writes_only'], 'a blocker naming a capability no step uses does not gate the plan');
    assert.match(disclosed(rowOf(unaffected, 'writes_only'), 'known_blockers').band,
      /con-[0-9a-f]{12} \(memory\.search\) name a capability no step here uses/);
    const here = fxCandidate(registry, bound, {
      strategy: 'uses_it',
      steps: [fxStep('s1', 'memory.search', { risk: 'low', reversibility: 'read_only' })],
      covered: ['c2'],
    });
    const gated = evaluateCandidates({ result: fxResult([here]), goal: bound, registry });
    assert.match(gated.excluded[0].failedGates[0].detail, /stops s1 -/, 'the exclusion names the step the blocker stops');

    // An effort estimate appears only where durations were recorded, and is then stated as recorded.
    const measured = variant(ignoring, (c) => {
      c.strategy = 'measured';
      c.estimatedSeconds = 40;
      c.content.resources.estimatedSeconds = 40;
    });
    assert.equal(ranked(rowOf(evaluateCandidates({ result: fxResult([measured]), goal: blocked, registry }), 'measured'), 'resource_requirements').band,
      '1 step(s), 1 of them a write; 40s of recorded durations');

    // A write whose reversibility the registry cannot vouch for is not counted as takeable back.
    const stuck = fxCandidate(registry, goal, {
      strategy: 'irreversible_write',
      steps: [{ ...fxStep('s1', 'memory.add'), reversibility: 'not_reversible' }],
      covered: ['c1'],
    });
    const reversible = fxCandidate(registry, goal, { strategy: 'append_only', steps: [fxStep('s1', 'memory.add')], covered: ['c1'] });
    const mixed = evaluateCandidates({ result: fxResult([stuck, reversible]), goal, registry });
    assert.equal(ranked(rowOf(mixed, 'irreversible_write'), 'reversibility').band, 's1 cannot be taken back, or APEX cannot say how far');
    assert.equal(ranked(rowOf(mixed, 'irreversible_write'), 'reversibility').value, 0);
    assert.equal(ranked(rowOf(mixed, 'append_only'), 'reversibility').value, 1);
    assert.deepEqual(mixed.front, ['append_only'], 'a plan whose record cannot be corrected is behind one whose can');
    assert.deepEqual(behindOf(mixed, 'irreversible_write').whyBehind, [{ under: 'append_only', on: ['reversibility'] }]);

    // Reads are the other end: nothing is recorded, so nothing needs taking back.
    const reads = fxCandidate(registry, goal, { strategy: 'reads_only', steps: [fxStep('s1', 'memory.search', { risk: 'low', reversibility: 'read_only' }), fxStep('s2', 'calc.evaluate', { risk: 'low', reversibility: 'read_only' })], covered: ['c1', 'c2'] });
    assert.equal(ranked(rowOf(evaluateCandidates({ result: fxResult([reads]), goal, registry }), 'reads_only'), 'reversibility').band, 'changes no APEX store: every step is a read');
    assert.equal(ranked(rowOf(evaluateCandidates({ result: fxResult([reads]), goal, registry }), 'reads_only'), 'resource_requirements').band, '2 step(s), 0 of them a write; no recorded duration, so no effort estimate');

    // The risk band names which steps are high, not how risky the plan is.
    const risky = fxCandidate(registry, goal, {
      strategy: 'one_high_step',
      steps: [
        fxStep('s1', 'memory.search', { risk: 'low', reversibility: 'read_only' }),
        fxStep('s2', 'calc.evaluate', { risk: 'high', reversibility: 'read_only' }),
      ],
      covered: ['c1', 'c2'],
    });
    const risked = rowOf(evaluateCandidates({ result: fxResult([risky]), goal, registry }), 'one_high_step');
    assert.equal(ranked(risked, 'step_risk').band, 'highest recorded step risk high; high-risk steps s2');
    assert.equal(risked.risk, 'high');
    assert.equal(ranked(risked, 'step_risk').value, -RISK_ORDER.high);

    // A goal whose only open criteria are APEX suggestions has nothing required to measure against,
    // so coverage is disclosed rather than ranked. No candidate can lead on a scale the records lack.
    const suggested = fxGoal({
      criteria: [{ id: 'c1', description: 'the fixture figure is produced', requirement: 'suggested', status: 'open' }],
    });
    const guess = fxCandidate(registry, suggested, { strategy: 'suggestions_only', steps: [fxStep('s1', 'calc.evaluate', { risk: 'low', reversibility: 'read_only' })], covered: ['c1'] });
    const unclear = evaluateCandidates({ result: fxResult([guess]), goal: suggested, registry });
    assert.equal(ranked(rowOf(unclear, 'suggestions_only'), 'criterion_coverage').value, null);
    assert.equal(ranked(rowOf(unclear, 'suggestions_only'), 'criterion_coverage').band, 'the goal records no open required criterion, so nothing is compared here');
    assert.equal(ranked(rowOf(unclear, 'suggestions_only'), 'uncertainty').band, 'no required criterion is left unmatched, unaddressed, or outside the plan bound');
    assert.ok(unclear.whatWouldSettleIt.includes('the goal records no open required criterion: which criteria does the user make required?'));
    assert.equal(disclosed(rowOf(unclear, 'suggestions_only'), 'goal_alignment').band,
      'takes on every open criterion its approach covers; not ranked, because what the approach settles is already counted by criterion_coverage');
  } finally {
    cleanup(dir);
  }
});

test('one candidate leads only where nothing else is as good on all dimensions and better on one', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = fxGoal();
    const registry = app.registry;
    const steps = [fxStep('s1', 'memory.add', { criterion: 'c1' }), fxStep('s2', 'memory.search', { criterion: 'c2' })];
    const steady = fxCandidate(registry, goal, { strategy: 'steady', steps, covered: ['c1', 'c2'] });
    const riskier = variant(steady, (c) => {
      c.strategy = 'riskier';
      c.content.steps[1].risk = 'high';
      c.risk = 'high';
    });

    const evaluation = evaluateCandidates({ result: fxResult([steady, riskier]), goal, registry });
    assert.deepEqual(evaluation.included, ['steady', 'riskier'], 'both run; neither is gated');
    assert.deepEqual(evaluation.front, ['steady']);
    assert.equal(evaluation.selection.leading, 'steady');
    assert.equal(evaluation.selection.unresolvedTradeOff, false);
    assert.deepEqual(evaluation.behind, [{
      strategy: 'riskier',
      digest: riskier.digest,
      whyBehind: [{ under: 'steady', on: ['step_risk'] }],
      betterThanThose: [],
    }]);
    const rendered = renderEvaluation(evaluation);
    assert.ok(rendered.includes('    behind steady on step_risk'), 'why the alternative is less suitable is printed');
    assert.ok(rendered.includes('    no other gated candidate does better everywhere and never worse'));

    // A longer plan that risks no more is behind on the work it adds, and a riskier plan of the same
    // length is behind on the risk. Neither of those two beats the other: they trade off below the
    // front, and a trade-off between two already-behind candidates is not reported as a win.
    const wider = variant(steady, (c) => {
      c.strategy = 'wider';
      c.content.steps.push({ ...fxStep('s3', 'calc.evaluate', { risk: 'low', reversibility: 'read_only' }), dependsOn: ['s2'] });
      c.steps = 3;
      c.reads = 2;
    });
    const three = evaluateCandidates({ result: fxResult([steady, riskier, wider]), goal, registry });
    assert.deepEqual(three.front, ['steady']);
    assert.deepEqual(three.behind.map((b) => [b.strategy, b.whyBehind]), [
      ['riskier', [{ under: 'steady', on: ['step_risk'] }]],
      ['wider', [{ under: 'steady', on: ['resource_requirements'] }]],
    ]);
    assert.deepEqual(behindOf(three, 'wider').betterThanThose, [], 'longer but no riskier: it wins nothing');
    assert.deepEqual(behindOf(three, 'riskier').betterThanThose, [], 'riskier but no longer: it wins nothing either');

    // A plan that is both longer and riskier is behind both of them, and each of those is a recorded
    // fact about it: the comparison says which dimension the win is on rather than that it leads.
    const longerAndRiskier = variant(riskier, (c) => {
      c.strategy = 'longer_and_riskier';
      c.content.steps.push({ ...fxStep('s3', 'calc.evaluate', { risk: 'low', reversibility: 'read_only' }), dependsOn: ['s2'] });
      c.steps = 3;
      c.reads = 2;
    });
    const four = evaluateCandidates({ result: fxResult([steady, riskier, longerAndRiskier]), goal, registry });
    assert.deepEqual(four.front, ['steady']);
    assert.deepEqual(four.behind.map((b) => b.strategy), ['riskier', 'longer_and_riskier']);
    assert.deepEqual(behindOf(four, 'riskier').betterThanThose, [
      { over: 'longer_and_riskier', on: ['resource_requirements'] },
    ]);
    assert.deepEqual(behindOf(four, 'longer_and_riskier').whyBehind, [
      { under: 'steady', on: ['step_risk', 'resource_requirements'] },
      { under: 'riskier', on: ['resource_requirements'] },
    ]);
    assert.ok(renderEvaluation(four).includes('    behind steady on step_risk, resource_requirements'));
    assert.ok(renderEvaluation(four).includes('    behind riskier on resource_requirements'));
  } finally {
    cleanup(dir);
  }
});

test('an unresolved trade-off is reported as unresolved, and a tie is reported as a tie', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = fxGoal();
    const registry = app.registry;

    const broad = fxCandidate(registry, goal, {
      strategy: 'settles_everything',
      steps: [fxStep('s1', 'memory.add', { criterion: 'c1' }), fxStep('s2', 'memory.add', { criterion: 'c2', input: { content: 'the second fixture fact' } })],
      covered: ['c1', 'c2'],
    });
    const narrow = fxCandidate(registry, goal, {
      strategy: 'settles_the_first_only',
      steps: [fxStep('s1', 'memory.add', { criterion: 'c1' })],
      covered: ['c1'],
      leftOut: ['c2'],
    });

    const tradeOff = evaluateCandidates({ result: fxResult([broad, narrow]), goal, registry });
    assert.equal(tradeOff.ok, true);
    assert.deepEqual(tradeOff.front, ['settles_everything', 'settles_the_first_only'], 'a genuine trade-off keeps both approaches');
    assert.equal(tradeOff.selection.leading, null, 'APEX does not have a preference it can justify as fact');
    assert.equal(tradeOff.selection.unresolvedTradeOff, true);
    assert.equal(tradeOff.selection.basis, 'the ranked dimensions pull in opposite directions between the candidates that passed every gate');
    assert.equal(tradeOff.clarificationNeeded, true);
    assert.equal(tradeOff.selection.tradeOffs.length, 1);
    const t = tradeOff.selection.tradeOffs[0];
    assert.deepEqual(t.between, ['settles_everything', 'settles_the_first_only']);
    assert.deepEqual(t.settles_everything_better_on, ['criterion_coverage']);
    assert.deepEqual(t.settles_the_first_only_better_on, ['resource_requirements']);
    assert.equal(t.statement, 'settles_everything is better on criterion_coverage; settles_the_first_only is better on resource_requirements. Neither dominates the other, so the choice is a priority the user sets, not a finding APEX has made.');
    assert.ok(tradeOff.whatWouldSettleIt.includes('which of these matters more to the user: settling more of the goal\'s recorded criteria, or recording and risking less'));
    assert.match(renderEvaluation(tradeOff), /unresolved trade-off: settles_everything is better on criterion_coverage/);
    assert.doesNotMatch(renderEvaluation(tradeOff), /leads:/, 'nothing leads when the trade-off is unresolved');

    // Two approaches that record the same on every ranked dimension: the comparison says so.
    const twinA = fxCandidate(registry, goal, { strategy: 'approach_a', steps: [fxStep('s1', 'memory.add', { criterion: 'c1' })], covered: ['c1'] });
    const twinB = variant(twinA, (c) => {
      c.strategy = 'approach_b';
      c.content.steps[0].description = 'a differently worded step that changes the same record';
      c.note = 'fixture approach approach_b';
    });
    const tied = evaluateCandidates({ result: fxResult([twinA, twinB]), goal, registry });
    assert.equal(tied.ok, true);
    assert.deepEqual(tied.front, ['approach_a', 'approach_b']);
    assert.equal(tied.selection.leading, null);
    assert.deepEqual(tied.selection.tradeOffs, []);
    assert.equal(tied.selection.ties[0].statement, 'approach_a and approach_b match on every ranked dimension: the comparison finds nothing recorded that separates them.');
    assert.equal(tied.selection.basis, 'the candidates that passed every gate match on every ranked dimension; nothing recorded separates them');
    assert.ok(tied.whatWouldSettleIt.includes('nothing in the records separates these candidates on the ranked dimensions; the choice rests on their text, which a comparison of recorded facts cannot weigh'));
    assert.match(renderEvaluation(tied), /not separated by the rule: approach_a and approach_b match on every ranked dimension/);

    // A candidate whose only difference is a name is not a choice, and the wording says what is missing.
    assert.notEqual(twinA.digest, twinB.digest, 'the two records differ in bytes even though the comparison cannot separate them');
  } finally {
    cleanup(dir);
  }
});

test('nothing generated is reported as nothing generated, with the generator\'s own reason', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    // Nothing registered archives a vault, and the goal's own request says no more than that.
    const goal = await addGoal(app, { request: 'the vault is archived', criteria: ['the vault is archived'] });
    const generated = candidatesForGoal({ goal, registry: app.registry });
    assert.equal(generated.ok, false);
    assert.equal(generated.reason, 'no-capability');
    assert.equal(generated.candidates.length, 0);

    const evaluation = evaluateCandidates({ result: generated, goal, registry: app.registry });
    assert.equal(evaluation.ok, false);
    assert.equal(evaluation.reason, 'no-capability', 'the honest reason is the generator\'s: no criteria, no capability, or every approach refused');
    assert.deepEqual(evaluation.problems, generated.problems);
    assert.deepEqual(evaluation.candidates, []);
    assert.deepEqual(evaluation.front, []);
    assert.equal(evaluation.selection.leading, null);
    assert.equal(evaluation.selection.basis, null);
    assert.equal(evaluation.clarificationNeeded, true);
    assert.ok(evaluation.whatWouldSettleIt.some((w) => w.startsWith('a criterion no registered capability can carry: c1')), 'which criterion is unanswerable, and its own words');
    assert.doesNotMatch(evaluation.whatWouldSettleIt.join(' '), /listed above/, 'nothing is listed above: there was no candidate to gate');

    const rendered = renderEvaluation(evaluation);
    assert.ok(rendered.startsWith('No candidate plan could be compared: no-capability.'));
    for (const p of generated.problems) assert.ok(rendered.includes(`  - ${p}`));
    for (const w of evaluation.whatWouldSettleIt) assert.ok(rendered.includes(`  what would settle this: ${w}`));
    assert.ok(rendered.endsWith(EVALUATION_NOTE));

    // Through the shipped read action, the same answer is what the user is told.
    const step = await app.controller.runAction('plan.candidates', { goal: goal.id }, 'user', 'op-al-nothing');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
    const data = stepData(step);
    assert.equal(data.comparison.ok, false);
    assert.equal(data.comparison.reason, 'no-capability');
    assert.deepEqual(data.candidates, []);
    assert.match(step.summary, /^0 candidate plan\(s\) for goal .*; none can be compared \(no-capability\)/);
    assert.match(step.display, /No candidate plan could be recorded: no-capability/);
    assert.match(step.display, /No candidate plan could be compared: no-capability\./);

    // And an evaluation handed nothing at all says that, rather than inventing an empty comparison.
    const empty = evaluateCandidates({});
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, 'no-candidates');
    assert.deepEqual(empty.problems, ['nothing was handed to evaluate, so no candidate was generated or given']);
    assert.equal(empty.note, EVALUATION_NOTE);
    assert.match(renderEvaluation(empty), /^No candidate plan could be compared: no-candidates\./);
    assert.match(renderEvaluation(null), /^No candidate plan could be compared: nothing was given to compare\./);
  } finally {
    cleanup(dir);
  }
});

test('the same goal, registry and constraint give the same comparison, and the read starts nothing', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    const plansBefore = fileOrEmpty(dir, 'plans.jsonl');
    const goalsBefore = fileOrEmpty(dir, 'goals.jsonl');

    const first = await app.controller.runAction('plan.candidates', { goal: goal.id }, 'user', 'op-al-cmp-1');
    assert.equal(first.outcome, Outcome.SUCCESS_VERIFIED, first.summary);
    const second = await app.controller.runAction('plan.candidates', { goal: goal.id }, 'model', 'op-al-cmp-2');
    assert.equal(second.outcome, Outcome.SUCCESS_VERIFIED, second.summary, 'a model may ask for a comparison; it may not act on it');

    for (const step of [first, second]) {
      const data = stepData(step);
      assert.equal(data.recorded, false);
      assert.equal(data.approved, false);
      assert.equal(data.executable, false);
      assert.equal(data.comparison.approved, false);
      assert.equal(data.comparison.executable, false);
      // The compact audit form carries the rule it applied, so a later reader can check the statement
      // against the rule instead of taking the ranking on trust.
      assert.equal(data.comparison.rule, EVALUATION_RULE);
      assert.deepEqual(data.comparison.gates, GATES);
      assert.deepEqual(data.comparison.rankedDimensions, RANKED_DIMENSIONS);
      assert.deepEqual(data.comparison.disclosedDimensions, DISCLOSED_DIMENSIONS);
      assert.equal(data.comparison.leading, REQUIRED_ONLY);
      assert.equal(data.comparison.basis, 'no other candidate that passed every gate is as good on all ranked dimensions and better on one');
      assert.deepEqual(data.comparison.included, [REQUIRED_ONLY, ALL_OPEN, READ_FIRST]);
      assert.deepEqual(data.comparison.excluded, []);
      assert.equal(data.comparison.userDecisionRequired, undefined, 'the compact form states the position, not a decision it cannot make');
      assert.deepEqual(data.occupancy, { goalId: goal.id, drafts: [], live: [], maxDrafts: MAX_CANDIDATES_PER_GOAL, draftsRemaining: MAX_CANDIDATES_PER_GOAL });
      assert.equal(data.goalStatus, goal.status);
      assert.equal(data.goalRevision, goal.revision);
      assert.equal(data.work, null);
      assert.deepEqual(data.cannotUse, []);
      assert.match(step.verification.detail, /^3 candidate\(s\) reproduce byte for byte from the recorded goal, the live registry, and the constraints its records state; the store holds 0 draft\(s\) for this goal, none added by this read/);
      assert.match(step.display, /These are drafts on screen\. Recording one is plan\.add, approving it is plan\.approve, and both are user acts\./);
      assert.match(step.display, /No effort estimate appears above because the audit log holds no per-action duration to average; a number here would be a guess\./);
      assert.match(step.display, /The plan store holds 0 draft candidate\(s\) for this goal of at most 3, and 0 live plan\(s\)/);
    }
    assert.equal(stepData(first).candidateSetDigest, stepData(second).candidateSetDigest);
    assert.equal(JSON.stringify(stepData(first).comparison), JSON.stringify(stepData(second).comparison));

    // Nothing was written: the goal and plan stores are byte for byte what they were.
    assert.equal(fileOrEmpty(dir, 'plans.jsonl'), plansBefore);
    assert.equal(fileOrEmpty(dir, 'goals.jsonl'), goalsBefore);

    // The store itself agrees: no draft, no live plan, nothing started.
    const occupancy = await app.plans.candidateState(goal.id);
    assert.deepEqual(occupancy.drafts, []);
    assert.deepEqual(occupancy.live, []);

    // A constraint the user states narrows what is offered, and the narrowing changes the comparison.
    // The refused capability is removed before the comparison, so no candidate is marked down for a
    // step it does not contain; what is lost with it is disclosed as a criterion nothing can carry.
    const narrowed = await app.controller.runAction('plan.candidates', { goal: goal.id, cannot_use: ['memory.add'] }, 'user', 'op-al-narrow');
    assert.equal(narrowed.outcome, Outcome.SUCCESS_VERIFIED, narrowed.summary);
    const nd = stepData(narrowed);
    assert.notEqual(nd.candidateSetDigest, stepData(first).candidateSetDigest, 'a different constraint is a different answer');
    assert.deepEqual(nd.cannotUse, ['memory.add']);
    for (const c of nd.candidates) assert.equal(c.writes, 0, 'the refused capability is gone from every candidate, not marked down for it');
    assert.match(narrowed.summary, /^2 candidate plan\(s\) for goal .*; required_only leads under the disclosed rule/);
    // Only one approach is left to compare: with no write in any candidate, the read-first ordering
    // has nothing to reorder, and that is reported as an approach not offered rather than hidden.
    assert.deepEqual(nd.skipped.map((s) => s.strategy), [READ_FIRST]);
    assert.deepEqual(nd.comparison.included, [REQUIRED_ONLY, ALL_OPEN]);
    assert.deepEqual(nd.comparison.excluded, []);
    assert.deepEqual(nd.comparison.front, [REQUIRED_ONLY]);
    assert.deepEqual(nd.comparison.whatWouldSettleIt, [
      'a criterion no registered capability can carry: c1 ("remember the release date"), c4 ("the vault is archived")',
    ]);
    assert.match(narrowed.display, /changes no APEX store: every step is a read/);
    assert.match(narrowed.display, /no capability for: c1, c4/);
    assert.match(narrowed.display, /this generation answers a recorded failure, so memory\.add is not offered again/);
    assert.ok(fileOrEmpty(dir, 'plans.jsonl') === plansBefore && fileOrEmpty(dir, 'goals.jsonl') === goalsBefore, 'the narrowed read wrote nothing either');

    // A constraint naming something this configuration does not register is refused, not ignored: an
    // ignored typo would leave the excluded capability in the plan.
    const invented = await app.controller.runAction('plan.candidates', { goal: goal.id, cannot_use: ['notes.archive'] }, 'user', 'op-al-invented');
    assert.equal(invented.outcome, Outcome.EXECUTION_FAILED);
    assert.match(invented.summary, /cannot_use names an action this configuration does not register: notes\.archive/);
    assert.equal(invented.result, null);
    assert.equal(invented.authorization.decision, 'allow', 'the refusal is the constraint check, not a permission decision');
  } finally {
    cleanup(dir);
  }
});

test('a comparison is verified against a fresh generation, and stale answers are named', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    const def = app.registry.get('plan.candidates');
    const ctx = { registry: app.registry, goals: app.goals, plans: app.plans, operationId: 'op-al-verify', origin: 'user' };
    const input = { goalRef: goal.id, work: null, cannotUse: [] };

    const fresh = await def.execute(ctx, input);
    assert.equal((await def.verify(ctx, input, fresh)).ok, true);

    // The user's recorded revision changes what the goal asks for, so the answer on screen describes a
    // goal that has since moved.
    await app.goals.revise(goal.id, {
      request: 'remember the sprint date',
      criteria: ['remember the sprint date'],
      reason: 'the test changed the intention',
    });
    const afterGoal = await def.verify(ctx, input, fresh);
    assert.equal(afterGoal.ok, false);
    assert.equal(afterGoal.detail, 'an independent generation gives different candidate bytes, so this answer describes a goal, a registry, or a constraint that has since moved');

    // A draft recorded for the same goal: the candidates still reproduce, but the store no longer holds
    // what the read said it held.
    const again = await def.execute(ctx, input);
    assert.equal((await def.verify(ctx, input, again)).ok, true);
    const stored = await app.controller.planAdd({
      goalId: goal.id,
      outcome: 'the sprint date is remembered',
      steps: [{ id: 's1', description: 'remember the sprint date', action: 'memory.add', input: { content: 'the sprint date' }, dependsOn: [], expectedResult: 'the date is stored', verification: 'the record is read back', criterion: 'c1', risk: 'medium' }],
    });
    assert.equal(stored.status, Outcome.PLAN_STORED, stored.output);
    const afterDraft = await def.verify(ctx, input, again);
    assert.equal(afterDraft.ok, false);
    assert.equal(afterDraft.detail, 'the plan store now holds a different set of drafts for this goal than this read reported');
    assert.deepEqual(again.data.candidates.map((c) => c.strategy), [REQUIRED_ONLY], 'the revised goal carries one required criterion, so one approach is offered');
    assert.equal(again.data.occupancy.drafts.length, 0, 'the read keeps its own statement about the store at the moment it ran');

    // The verifier cannot be the reader's only check: the store really did gain a draft.
    const occupancy = await app.plans.candidateState(goal.id);
    assert.deepEqual(occupancy.drafts, [commandData(stored).planId]);
    assert.equal(occupancy.draftsRemaining, MAX_CANDIDATES_PER_GOAL - 1);

    // A goal reference that resolves to nothing is refused by the verifier rather than reported as
    // empty: an empty comparison would read as "this goal has no options", which is not what happened.
    await assert.rejects(() => def.verify(ctx, { goalRef: 'no-such-goal', work: null, cannotUse: [] }, again), /no goal matches "no-such-goal"/);
  } finally {
    cleanup(dir);
  }
});

test('a revision is compared fresh, needs fresh approval, and leaves the plan it answers alone', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, { request: 'remember the release date', criteria: ['remember the release date', 'search memory for alpha'] });
    const stored = await app.controller.planAdd({
      goalId: goal.id,
      outcome: 'the release date is remembered and the notes are searched',
      steps: [
        { id: 's1', description: 'remember the release date', action: 'memory.add', input: { content: 'the release date' }, dependsOn: [], expectedResult: 'the date is stored', verification: 'the record is read back', criterion: 'c1', risk: 'medium' },
        { id: 's2', description: 'search memory for alpha', action: 'memory.search', input: { query: 'alpha' }, dependsOn: ['s1'], expectedResult: 'the notes are searched', verification: 'the search re-checks its own result', criterion: 'c2', risk: 'low' },
      ],
    });
    assert.equal(stored.status, Outcome.PLAN_STORED, stored.output);
    const planId = commandData(stored).planId;
    const prior = await app.plans.get(planId);
    assert.equal(prior.version, 1);
    assert.equal(prior.status, 'draft');
    assert.equal(prior.goalId, goal.id);

    const plansBeforeReplan = fileOrEmpty(dir, 'plans.jsonl');
    const goalsBeforeReplan = fileOrEmpty(dir, 'goals.jsonl');
    const step = await app.controller.runAction('plan.replan', { plan: planId, reason: 'the memory store is read-only today', cannot_use: ['memory.add'] }, 'user', 'op-al-replan');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
    assert.match(step.summary, /^1 revised candidate plan\(s\) for plan .* v1; required_only leads under the disclosed rule/);
    const data = stepData(step);

    assert.equal(data.recorded, false);
    assert.equal(data.approved, false);
    assert.equal(data.executable, false);
    assert.equal(data.freshApprovalRequired, true);
    assert.equal(data.revision.freshApprovalRequired, true);
    assert.equal(data.revision.priorPlanChanged, false);
    assert.equal(data.revision.supersedes, planId);
    assert.equal(data.revision.priorVersion, 1);
    assert.equal(data.revision.priorApprovalHash, null, 'a draft carries no approval, so a revision inherits none');
    assert.deepEqual(data.revision.criteriaTheEarlierPlanAttempted, ['c1', 'c2']);
    assert.ok(data.refusedActions.includes('memory.add'), 'the capability this revision refuses is stated');
    assert.deepEqual(data.cannotUse, ['memory.add']);
    assert.ok(data.revision.criteriaNoCandidateCovers.includes('c1'), 'what the earlier plan attempted and no candidate now settles');
    assert.deepEqual(data.unaddressed.map((u) => u.criterionId), ['c1'], 'the criterion the refused capability carried is named, not dropped');

    // The snapshot is the plan as the read found it: the same bytes the stored record hashes to now.
    assert.equal(data.planSnapshot.version, 1);
    assert.equal(data.planSnapshot.status, 'draft');
    assert.equal(data.planSnapshot.updatedAt, prior.updatedAt);
    assert.equal(data.planSnapshot.contentHash, planContentHash(prior));
    assert.equal(data.goalRevision, goal.revision);

    // The refused capability is gated out of the comparison as well as left out of the generation.
    assert.equal(data.comparison.ok, true);
    assert.deepEqual(data.comparison.front, [REQUIRED_ONLY]);
    assert.deepEqual(data.candidates.map((c) => c.strategy), [REQUIRED_ONLY], 'once the write is refused the read-first ordering has nothing to reorder');
    assert.deepEqual(data.candidates[0].criteriaCovered, ['c2']);
    assert.equal(data.candidates[0].writes, 0);
    assert.deepEqual(data.comparison.excluded, [], 'what is not offered is disclosed as skipped, not gated');

    // The same plan, answered with no capability refused, gives up nothing and so offers two ways to
    // work. The rule then cannot separate them, and says so instead of inventing a ranking.
    const wide = await app.controller.runAction('plan.replan', { plan: planId, reason: 'the plan needs a fresh look' }, 'user', 'op-al-replan-wide');
    assert.equal(wide.outcome, Outcome.SUCCESS_VERIFIED, wide.summary);
    assert.match(wide.summary, /^2 revised candidate plan\(s\) for plan .* v1; 2 remain, not separated by it/);
    assert.deepEqual(stepData(wide).candidates.map((c) => c.strategy), [REQUIRED_ONLY, READ_FIRST]);
    assert.deepEqual(stepData(wide).comparison.front, [REQUIRED_ONLY, READ_FIRST]);
    assert.equal(stepData(wide).comparison.unresolvedTradeOff, true);

    // The plan being answered is exactly as it was: same version, same status, same bytes, same clock.
    const after = await app.plans.get(planId);
    assert.equal(after.version, 1);
    assert.equal(after.status, 'draft');
    assert.equal(after.updatedAt, data.planSnapshot.updatedAt);
    assert.equal(after.approval ?? null, null, 'the revision read granted nothing');
    assert.equal(fileOrEmpty(dir, 'plans.jsonl'), plansBeforeReplan, 'a revision read writes nothing to the plan log');
    assert.equal(fileOrEmpty(dir, 'goals.jsonl'), goalsBeforeReplan);

    assert.ok(step.display.includes('Revised candidates for plan '), 'the read names the plan it answered');
    assert.ok(step.display.includes('answering: the memory store is read-only today'));
    assert.match(step.display, /The plan record holds no failed or uncertain step outcome, so this revision answers the stated reason and the constraints given, not a recorded failure\./);
    assert.match(step.display, /none of the candidates above inherits it/);
    assert.match(step.display, /A revision is recorded with plan\.add and authorized with plan\.approve, both user acts, after fresh validation\./);
    assert.match(step.verification.detail, /^plan .* is still v1 draft with the same content hash; 1 revised candidate\(s\) reproduce byte for byte; the learning disclosure re-reads to the same records; nothing was recorded, approved, or started$/);

    // Approval moves the plan record, so the revision read is disclosed as a statement about a draft.
    const def = app.registry.get('plan.replan');
    const ctx = { registry: app.registry, goals: app.goals, plans: app.plans, operationId: 'op-al-replan-verify', origin: 'user' };
    const input = { planRef: planId, reason: 'the memory store is read-only today', cannotUse: ['memory.add'] };
    const result = await def.execute(ctx, input);
    assert.equal((await def.verify(ctx, input, result)).ok, true);
    const approved = await app.controller.planApprove({ target: planId });
    assert.equal(approved.status, Outcome.PLAN_STORED, approved.output);
    const stale = await def.verify(ctx, input, result);
    assert.equal(stale.ok, false);
    assert.match(stale.detail, /^the plan being answered changed during the read \(v1 draft -> v1 approved\)$/);

    // A plan that records no goal has no intention to revise an approach for.
    const lonely = await app.controller.planAdd({
      outcome: 'a plan with no goal',
      steps: [{ id: 's1', description: 'remember the lonely fact', action: 'memory.add', input: { content: 'the lonely fact' }, dependsOn: [], expectedResult: 'the fact is stored', verification: 'the record is read back', risk: 'medium' }],
    });
    assert.equal(lonely.status, Outcome.PLAN_STORED, lonely.output);
    assert.equal(commandData(lonely).goalId, null, 'plan.add accepts a plan with no goal, and a revision has nothing to revise it for');
    const refused = await app.controller.runAction('plan.replan', { plan: commandData(lonely).planId, reason: 'nothing to revise it for' }, 'user', 'op-al-lonely');
    assert.equal(refused.outcome, Outcome.EXECUTION_FAILED);
    assert.match(refused.summary, /records no goal, so a revision has no intention to revise an approach for/);
    assert.equal(refused.result, null);
  } finally {
    cleanup(dir);
  }
});

test('an evaluation handed a candidate set and no goal or registry refuses rather than guesses', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = fxGoal();
    const candidate = fxCandidate(app.registry, goal, { strategy: 'lonely', steps: [fxStep('s1', 'memory.add')], covered: ['c1'] });
    const result = fxResult([candidate]);
    assert.equal(evaluateCandidates({ result, goal, registry: null }).reason, 'no-goal-or-registry');
    assert.match(renderEvaluation(evaluateCandidates({ result, goal, registry: null })), /^No candidate plan could be compared: no-goal-or-registry\./);

    // A candidate with no recorded goal is a plan for nothing: the gate that would have checked it
    // against a live goal has nothing to check against.
    const orphan = evaluateCandidates({ result: fxResult([fxCandidate(app.registry, goal, { strategy: 'orphan', steps: [fxStep('s1', 'memory.add')], goalId: null })]), goal: { id: null, revision: null, status: 'active', criteria: [], blockers: [] }, registry: app.registry });
    assert.equal(orphan.candidates[0].gates.goal_still_open.detail, 'no recorded goal is available, so nothing can be checked against it');
    assert.equal(orphan.reason, 'every-candidate-gated');
    assert.equal(orphan.goalRevision, null);

    // A closed goal is the same refusal, named as its own state. Batch AM added one distinction inside
    // it: a completed goal is the only closure that rests on recorded evidence, so when nobody re-read
    // that evidence the gate says so instead of implying the proof was checked.
    for (const status of ['completed', 'failed', 'superseded']) {
      const closed = evaluateCandidates({ result: fxResult([candidate]), goal: fxGoal({ status }), registry: app.registry });
      const suffix = status === 'completed'
        ? ' (the completion evidence was not re-read by this comparison)'
        : '';
      assert.equal(closed.candidates[0].gates.goal_still_open.detail,
        `the goal is ${status}, so this candidate plans work that is no longer open${suffix}`);
    }

    // A blocked goal is still open work, so it is not gated - and the band says which state it is in.
    const blocked = evaluateCandidates({ result: fxResult([candidate]), goal: fxGoal({ status: 'blocked' }), registry: app.registry });
    assert.equal(blocked.candidates[0].gates.goal_still_open.passed, true);
    assert.equal(blocked.candidates[0].gates.goal_still_open.detail, 'the goal is blocked, and the candidate is bound to goal revision 1');

    // A satisfied criterion needs no step, and a declined one is a record of what was suggested;
    // neither is an open requirement to settle.
    const nearly = fxGoal({
      criteria: [
        { id: 'c1', description: 'the first fixture fact is stored', requirement: 'required', status: 'satisfied' },
        { id: 'c2', description: 'the second fixture fact is stored', requirement: 'declined', status: 'open' },
      ],
    });
    const nothing = evaluateCandidates({ result: fxResult([fxCandidate(app.registry, nearly, { strategy: 'nearly_done', steps: [fxStep('s1', 'memory.add')], covered: ['c1'] })]), goal: nearly, registry: app.registry });
    assert.equal(ranked(rowOf(nothing, 'nearly_done'), 'criterion_coverage').value, null);
    assert.ok(nothing.whatWouldSettleIt.includes('the goal records no open required criterion: which criteria does the user make required?'));
  } finally {
    cleanup(dir);
  }
});
