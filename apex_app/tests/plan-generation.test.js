// Batch AL, work packages C, G, J and L at the planning layer: candidate generation and replanning.
//
// `src/plans/candidates.js` is the deterministic half of "which plan is appropriate". Four claims
// are tested here, because they are the ones that would be easy to get wrong and hard to notice:
//   1. Every step names a capability the live registry actually holds, and a criterion no capability
//      can carry is reported as unknown instead of being filled in with an invented action.
//   2. A criterion is claimed as settled only when the capability was matched to that criterion's
//      own words. A step generated from the goal's recorded request is offered, but settles nothing
//      by itself and is disclosed as such.
//   3. A candidate is inert: generating one writes nothing, approves nothing, and runs nothing.
//      Recording, approving and executing stay the existing user acts through the existing stores.
//   4. A revision responds to recorded evidence - it refuses the capability that failed, leaves the
//      plan it responds to untouched, and cannot inherit that plan's approval.
//
// Everything runs through the real app, the live action registry, the real goal and plan stores and
// the real task runner. Failure and recovery text is asserted against what the task runner actually
// did in these same tests. No model service is contacted; no inference is performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { CONTROL_CHARS, SINGLE_LINE_FORBIDDEN } from '../src/util.js';
import { planContentHash } from '../src/plans/model.js';
import { stableStringify } from '../src/tasks/model.js';
import {
  MAX_ASSERTIONS, MAX_ASSERTION_CHARS, MAX_CANDIDATES_PER_GOAL, MAX_ESTIMATE_SECONDS,
  MAX_EXPECTED_CHARS, MAX_PLAN_STEPS, MAX_PRECONDITIONS, MAX_RECOVERY_CHARS,
  MAX_VERIFICATION_CHARS,
} from '../src/plans/model.js';
import {
  candidatesForGoal, revisedCandidates, renderCandidates,
  CandidateStrategy, CANDIDATE_NOTE,
} from '../src/plans/candidates.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dataOf = (res) => res.operation.steps[0].result.data;

async function appIn(dir) {
  return createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF });
}

async function addGoal(app, { request, criteria }) {
  const res = await app.controller.goalAdd({ request, criteria });
  assert.equal(res.status, Outcome.GOAL_CREATED, `goal add failed: ${res.output}`);
  return app.goals.get(dataOf(res).goalId);
}

// A goal whose criteria reach three different capabilities, one of them only as an APEX suggestion,
// plus one criterion nothing registered can carry. Written with capabilities the shipped registry
// already offers (memory.add, memory.search, calc.evaluate) - none of these names is invented here.
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

const strategyOf = (result, strategy) => result.candidates.find((c) => c.strategy === strategy);
const seq = (candidate) => candidate.content.steps.map((s) => `${s.action}${s.criterionId ? `(${s.criterionId})` : ''}`).join(', ');

// A store that has never been written to has no file: that is the evidence the test is after.
function linesOf(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

// Every string in a candidate, however deep, is a value APEX is about to show the user.
function everyString(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) everyString(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) everyString(v, out);
  return out;
}

test('every step a candidate offers is a capability the live registry actually holds', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    const result = candidatesForGoal({ goal, registry: app.registry });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.candidates.length, 3, 'three genuinely different approaches are available for this goal');
    const names = new Set(app.registry.names());
    for (const c of result.candidates) {
      assert.ok(c.steps > 0 && c.steps <= MAX_PLAN_STEPS);
      assert.equal(c.steps, c.content.steps.length);
      let previous = null;
      for (const [i, s] of c.content.steps.entries()) {
        assert.ok(names.has(s.action), `${s.action} is not a registered action`);
        const def = app.registry.get(s.action);
        // The registry marks only what a plan may not use, so "plannable" is the absence of that mark.
        assert.notEqual(def.plannable, false, `${s.action} is not plannable, so it cannot carry a step`);
        assert.equal(typeof def.verify, 'function', `${s.action} has no independent verifier`);
        assert.equal(s.id, `s${i + 1}`);
        assert.deepEqual(s.dependsOn, previous === null ? [] : [previous], 'the runner is sequential: each step depends on the one before');
        previous = s.id;
        assert.ok(s.description.length > 0 && s.expectedResult.length > 0 && s.verification.length > 0);
        assert.ok(['low', 'medium', 'high'].includes(s.risk));
        assert.ok(['read_only', 'reversible', 'not_reversible', 'unknown'].includes(s.reversibility));
        assert.ok(s.recovery.includes('the task stops here and later steps do not run'));
        assert.equal(s.estimate.seconds, null, 'nothing has been measured for this action, so nothing is estimated');
        // Reversibility and risk agree with the registry's own permission class, not with a guess.
        if (def.permission === 'write') {
          assert.equal(s.reversibility, 'reversible');
          assert.equal(s.risk, 'medium');
          assert.match(s.recovery, /corrected rather than erased/);
          assert.match(s.expectedResult, /appends one persistent record/);
        } else {
          assert.equal(s.reversibility, 'read_only');
          assert.equal(s.risk, 'low');
          assert.match(s.recovery, /changed nothing/);
          assert.match(s.expectedResult, /no APEX store changes/);
        }
      }
      assert.equal(c.writes + c.reads, c.steps);
      assert.deepEqual(c.capabilities.map((k) => k.action).sort(), [...new Set(c.content.steps.map((s) => s.action))].sort());
      for (const k of c.capabilities) {
        assert.equal(k.permission, app.registry.get(k.action).permission);
        assert.equal(k.hasVerifier, true);
      }
      assert.deepEqual(c.reversibility.map((r) => r.reversibility), c.content.steps.map((s) => s.reversibility));
      assert.deepEqual(c.failurePaths.map((f) => f.id), c.content.steps.map((s) => s.id));
    }
  } finally {
    cleanup(dir);
  }
});

test('the three approaches differ in what they take on and what they touch, not in wording', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    const result = candidatesForGoal({ goal, registry: app.registry });
    const required = strategyOf(result, REQUIRED_ONLY);
    const all = strategyOf(result, ALL_OPEN);
    const readFirst = strategyOf(result, READ_FIRST);
    // required_only leaves the suggested criterion alone; the other two work on it and say so.
    assert.equal(seq(required), 'memory.add(c1), memory.search(c2)');
    assert.deepEqual(required.criteriaCovered, ['c1', 'c2']);
    assert.deepEqual(required.criteriaLeftOutOfThisApproach, ['c3'], 'the suggestion is left out, and named');
    assert.deepEqual(required.criteriaFromInference, []);
    assert.equal(seq(all), 'memory.add(c1), memory.search(c2), calc.evaluate(c3)');
    assert.deepEqual(all.criteriaFromInference, ['c3']);
    assert.ok(all.content.assertions.some((a) => a.kind === 'inference'
      && a.text.includes('c3')
      && a.text.includes('the user has not made required')));
    // read_before_write is the same work in a different order: both checks first, then the record.
    assert.equal(seq(readFirst), 'memory.search(c2), calc.evaluate(c3), memory.add(c1)');
    assert.equal(readFirst.writes, 1);
    assert.equal(readFirst.reads, 2);
    assert.ok(readFirst.content.assertions.some((a) => a.kind === 'inference' && a.text.includes('read-only steps run before any write')));
    assert.equal(new Set(result.candidates.map((c) => c.digest)).size, 3, 'three different plans, not one plan three times');
    // What the goal records as unaddressable is a stated unknown, in every candidate and in the result.
    assert.deepEqual(result.unaddressed.map((u) => u.criterionId), ['c4']);
    assert.match(result.unaddressed[0].reasons.join(' '), /no registered action matches/);
    assert.equal(result.clarificationNeeded, true);
    for (const c of result.candidates) {
      assert.deepEqual(c.criteriaLeftUnaddressed, ['c4']);
      assert.ok(c.content.assertions.some((a) => a.kind === 'unknown' && a.text.includes('the vault is archived')));
    }
  } finally {
    cleanup(dir);
  }
});

test('a step settles only the criterion whose own words matched it', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    // "the release is noted in the log" names no capability; the goal's request does, and is the
    // user's own wording, so a step is still offered for it - but it settles nothing by itself.
    const goal = await addGoal(app, {
      request: 'search memory for alpha and remember the release date',
      criteria: ['remember the release date', 'the release is noted in the log'],
    });
    const result = candidatesForGoal({ goal, registry: app.registry });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.deepEqual(result.unaddressed, [], 'the criterion is not reported as impossible, it is reported as unmatched');
    assert.deepEqual(result.assumedFromGoalRequest.map((a) => a.criterionId), ['c2']);
    assert.equal(result.clarificationNeeded, true);
    for (const c of result.candidates) {
      const attributed = c.content.steps.filter((s) => s.criterionId);
      assert.deepEqual(attributed.map((s) => [s.action, s.criterionId]), [['memory.add', 'c1']]);
      const unattributed = c.content.steps.filter((s) => !s.criterionId);
      assert.equal(unattributed.length, 1, 'the step generated from the goal request carries no criterion');
      assert.equal(unattributed[0].description, goal.request, 'it is the goal request, not a step invented for c2');
      assert.deepEqual(c.criteriaCovered, ['c1'], 'c2 is not claimed as settled');
      assert.deepEqual(c.criteriaAssumedFromTheGoalRequest, ['c2']);
      assert.ok(c.content.assertions.some((a) => a.kind === 'inference'
        && a.text.includes('c2')
        && a.text.includes('settles no criterion by itself')));
    }
    assert.match(renderCandidates(result, { registry: app.registry }), /criterion c2 names no capability in its own words/);

    // Two criteria that ask for one identical append share a single step, disclosed as sharing.
    const twice = await app.goals.get((await app.controller.goalAdd({
      request: 'remember the sprint date',
      criteria: ['remember the sprint date', 'remember the sprint date'],
    })).operation.steps[0].result.data.goalId);
    const sharedResult = candidatesForGoal({ goal: twice, registry: app.registry });
    const shared = strategyOf(sharedResult, REQUIRED_ONLY);
    assert.equal(shared.steps, 1, 'one append is recorded once, not once per criterion');
    assert.deepEqual(shared.criteriaCovered, ['c1']);
    assert.deepEqual(shared.criteriaSharedWithAnEarlierStep, [{ criterionId: 'c2', sameStepAs: 'c1', stepId: 's1' }]);
    assert.match(renderCandidates(sharedResult, { registry: app.registry }), /shares a step: c2 with c1 \(s1\)/);
  } finally {
    cleanup(dir);
  }
});

test('an APEX suggestion gates nothing until the user decides, and the decision changes what is offered', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    assert.equal(goal.criteria[2].basis, 'system_inferred');
    assert.equal(goal.criteria[2].requirement, 'suggested', 'an inferred criterion is stored as a suggestion');

    const before = candidatesForGoal({ goal, registry: app.registry });
    assert.equal(seq(strategyOf(before, REQUIRED_ONLY)), 'memory.add(c1), memory.search(c2)');

    // The user's own act is the only thing that can make an APEX suggestion into required work.
    const decided = await app.controller.goalConfirm({
      target: goal.id, criterion: 'c3', decision: 'required', reason: 'this is what I meant',
    });
    assert.equal(decided.status, Outcome.GOAL_UPDATED, decided.output);
    const after = candidatesForGoal({ goal: await app.goals.get(goal.id), registry: app.registry });
    assert.equal(seq(strategyOf(after, REQUIRED_ONLY)), 'memory.add(c1), memory.search(c2), calc.evaluate(c3)');
    assert.deepEqual(strategyOf(after, REQUIRED_ONLY).criteriaFromInference, [], 'it is no longer a suggestion being worked on');

    // Declining it takes the step out of every approach, and the criterion stays in the record.
    await app.controller.goalConfirm({ target: goal.id, criterion: 'c3', decision: 'declined', reason: 'not needed' });
    const declinedGoal = await app.goals.get(goal.id);
    const declined = candidatesForGoal({ goal: declinedGoal, registry: app.registry });
    assert.deepEqual(declined.declinedCriteria.map((d) => d.criterionId), ['c3']);
    assert.ok(!declined.candidates.some((c) => seq(c).includes('calc.evaluate')), 'a declined criterion takes no work');
  } finally {
    cleanup(dir);
  }
});

test('at most three candidates per goal, and an approach that is the same steps under another name is not a choice', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    assert.equal(candidatesForGoal({ goal, registry: app.registry }).candidates.length, MAX_CANDIDATES_PER_GOAL);
    const one = candidatesForGoal({ goal, registry: app.registry, max: 1 });
    assert.deepEqual(one.candidates.map((c) => c.strategy), [REQUIRED_ONLY]);
    assert.deepEqual(one.skipped.map((s) => s.strategy), [ALL_OPEN, READ_FIRST]);
    assert.match(one.skipped[0].reason, /the candidate bound for one goal is 1/);
    const two = candidatesForGoal({ goal, registry: app.registry, max: 2 });
    assert.deepEqual(two.candidates.map((c) => c.strategy), [REQUIRED_ONLY, ALL_OPEN]);

    // Only the required approach is available once the suggested and unmatchable criteria are out.
    const narrow = await addGoal(app, {
      request: 'remember the change log date',
      criteria: ['remember the change log date'],
    });
    const only = candidatesForGoal({ goal: narrow, registry: app.registry });
    assert.deepEqual(only.candidates.map((c) => c.strategy), [REQUIRED_ONLY]);
    assert.ok(only.skipped.some((s) => s.strategy === ALL_OPEN
      && /nothing recorded makes its steps differ/.test(s.reason)), JSON.stringify(only.skipped));
    assert.ok(only.skipped.some((s) => s.strategy === READ_FIRST && /is a write/.test(s.reason)), JSON.stringify(only.skipped));

    // The plan bound is enforced rather than silently exceeded. A recorded goal can hold at most
    // MAX_CRITERIA criteria, so ten are supplied as a goal record of the same shape to reach the
    // eight-step bound; the criteria are the goal's own words either way.
    const bound = candidatesForGoal({
      goal: {
        id: 'g-bound',
        request: 'remember many facts',
        criteria: Array.from({ length: 10 }, (_, i) => ({
          id: `c${i + 1}`, description: `remember fact ${i + 1}`, status: 'pending', requirement: 'required', basis: 'user_stated',
        })),
      },
      registry: app.registry,
    });
    const big = strategyOf(bound, REQUIRED_ONLY);
    assert.equal(big.steps, MAX_PLAN_STEPS, 'the plan step bound is applied');
    assert.deepEqual(big.criteriaCovered, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']);
    assert.deepEqual(big.stepsBeyondThePlanBound, ['c9', 'c10'], 'what the bound left out is named, not dropped');
    assert.match(renderCandidates(bound, { registry: app.registry }), /beyond the 8-step plan bound: c9, c10/);
  } finally {
    cleanup(dir);
  }
});

test('generating candidates writes nothing, approves nothing and runs nothing', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    const planLines = linesOf(app.plans.filePath).length;
    const goalLines = linesOf(app.goals.filePath).length;
    const operations = (await app.operations.list({ limit: 500 })).records.length;

    const result = candidatesForGoal({ goal, registry: app.registry });
    assert.equal(result.candidates.length, 3);
    for (const c of result.candidates) {
      assert.equal(c.executable, false);
      assert.equal(c.approved, false);
      assert.equal(c.id, undefined, 'a candidate has no plan id: it is not a record yet');
      assert.equal(c.approval, undefined);
      assert.equal(c.activation, undefined);
      assert.equal(c.status, undefined, 'a candidate has no lifecycle status');
      assert.match(c.note, /works on|runs every read-only step/);
    }
    assert.equal(CANDIDATE_NOTE.includes('not approved'), true);

    assert.equal(linesOf(app.plans.filePath).length, planLines, 'plans.jsonl gained nothing');
    assert.equal(linesOf(app.goals.filePath).length, goalLines, 'goals.jsonl gained nothing');
    assert.equal((await app.operations.list({ limit: 500 })).records.length, operations, 'no operation was recorded');
    assert.equal((await app.plans.list()).length, 0);

    // A candidate's digest is not an id: approving the approach it describes is not possible.
    const refused = await app.controller.planApprove({ target: result.candidates[0].digest });
    assert.equal(refused.status, Outcome.EXECUTION_FAILED, refused.output);
    assert.equal((await app.plans.list()).length, 0);
  } finally {
    cleanup(dir);
  }
});

test('an effort estimate is a recorded measurement or it is nothing', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    const bare = strategyOf(candidatesForGoal({ goal, registry: app.registry }), REQUIRED_ONLY);
    assert.equal(bare.estimatedSeconds, null);
    assert.deepEqual(bare.content.steps.map((s) => s.estimate.seconds), [null, null]);
    assert.match(renderCandidates(candidatesForGoal({ goal, registry: app.registry }), { registry: app.registry }), /not estimated: no recorded duration/);

    const measured = candidatesForGoal({
      goal,
      registry: app.registry,
      evidence: { actionDurations: { 'memory.add': [4, 8, 2], 'memory.search': [3] } },
    });
    const both = strategyOf(measured, REQUIRED_ONLY);
    assert.deepEqual(both.content.steps.map((s) => s.estimate.seconds), [4, 3], 'the median of what was recorded');
    assert.equal(both.estimatedSeconds, 7);
    // One unmeasured action is enough to make a total unsupported: a plan estimate that mixes a
    // measurement with a guess would present the guess as a measurement.
    const partial = strategyOf(measured, ALL_OPEN);
    assert.deepEqual(partial.content.steps.map((s) => s.estimate.seconds), [4, 3, null]);
    assert.equal(partial.estimatedSeconds, null);
    assert.equal(strategyOf(measured, READ_FIRST).estimatedSeconds, null);

    const junk = candidatesForGoal({
      goal,
      registry: app.registry,
      evidence: { actionDurations: { 'memory.add': ['soon', -5, MAX_ESTIMATE_SECONDS + 1], 'memory.search': [] } },
    });
    assert.deepEqual(strategyOf(junk, REQUIRED_ONLY).content.steps.map((s) => s.estimate.seconds), [null, null]);
    assert.equal(strategyOf(junk, REQUIRED_ONLY).estimatedSeconds, null);
  } finally {
    cleanup(dir);
  }
});

test('a capability that cannot carry a step is refused, not presented as a candidate to approve', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    // A private memory is a registered capability, and APEX will not put it in a plan: the step
    // checker refuses it, so the candidate reports it rather than softening the step.
    const privateGoal = await addGoal(app, { request: 'keep this to myself', criteria: ['remember privately the appointment'] });
    const result = candidatesForGoal({ goal: privateGoal, registry: app.registry });
    assert.equal(result.ok, true);
    const candidate = result.candidates[0];
    assert.equal(candidate.readyForApproval, false);
    assert.equal(candidate.validation.ok, false);
    assert.match(candidate.validation.problems.join('; '), /private memory write cannot be part of a task/);
    assert.equal(candidate.approved, false);
    assert.match(renderCandidates(result, { registry: app.registry }), /validation: refused - step s1: a private memory write/);

    // The store reaches the same conclusion about the same steps, so the candidate is not claiming a
    // validation the plan store would contradict: a plan whose step can never run is not approvable.
    const stored = await app.plans.createPlan({
      goalId: privateGoal.id, outcome: candidate.outcome, steps: candidate.content.steps,
    });
    const report = app.plans.validatePlan(stored.plan);
    assert.equal(report.ok, false);
    assert.match(report.problems.join('; '), /private memory write cannot be part of a plan/);
    await assert.rejects(() => app.plans.approve(stored.plan.id), /private memory write cannot be part of a plan/);

    // A capability that is not in this configuration at all cannot be reached either: no file access
    // is assumed, and the refusal says what is missing.
    const noFs = candidatesForGoal({
      goal: { id: 'g-fs', request: 'read file notes.txt', criteria: [{ id: 'c1', description: 'read file notes.txt', status: 'pending', requirement: 'required', basis: 'user_stated' }] },
      registry: app.registry,
    });
    assert.equal(noFs.ok, false);
    assert.equal(noFs.reason, 'no-capability');
    assert.match(noFs.unaddressed[0].reasons.join(' '), /filesystem\.read is not available in this configuration/);
    assert.deepEqual(noFs.candidates, []);

    // A goal whose criteria none of the capabilities can carry is asked about, not planned.
    const vague = await addGoal(app, { request: 'make the thing better', criteria: ['the thing is better now'] });
    const none = candidatesForGoal({ goal: vague, registry: app.registry });
    assert.equal(none.ok, false);
    assert.equal(none.reason, 'no-capability');
    assert.equal(none.clarificationNeeded, true);
    assert.match(renderCandidates(none), /APEX does not invent a capability to fill a gap/);

    // No goal, and no registry, are both stated rather than answered with a generic plan.
    assert.equal(candidatesForGoal({ goal: null, registry: app.registry }).reason, 'no-goal');
    assert.equal(candidatesForGoal({ goal: vague, registry: null }).reason, 'no-registry');
    assert.equal(candidatesForGoal({ goal: { id: 'g', request: 'r', criteria: [] }, registry: app.registry }).reason, 'no-open-criteria');
  } finally {
    cleanup(dir);
  }
});

test('a candidate that passes read-only checks records, approves and runs through the existing path', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    const candidate = strategyOf(candidatesForGoal({ goal, registry: app.registry }), REQUIRED_ONLY);
    assert.equal(candidate.readyForApproval, true);

    const add = await app.controller.planAdd({
      goalId: goal.id,
      outcome: candidate.outcome,
      steps: candidate.content.steps,
      preconditions: candidate.content.preconditions,
      assertions: candidate.content.assertions,
      reason: 'recorded from a generated candidate',
    });
    assert.equal(add.status, Outcome.PLAN_STORED, add.output);
    const planId = dataOf(add).planId;
    assert.equal(dataOf(add).validation.ok, true, JSON.stringify(dataOf(add).validation.problems));
    assert.equal(dataOf(add).validation.steps, candidate.steps);
    const plan = await app.plans.get(planId);
    assert.equal(plan.status, 'draft', 'recording a candidate is a write that authorizes nothing');
    assert.equal(plan.steps[0].reversibility, candidate.content.steps[0].reversibility);
    assert.equal(plan.steps[0].recovery, candidate.content.steps[0].recovery);
    assert.equal(plan.steps[0].criterionId, 'c1', 'the criterion the step was matched to travels with it');

    const approved = await app.controller.planApprove({ target: planId });
    assert.equal(approved.status, Outcome.PLAN_STORED, approved.output);
    const run = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.display);
    const done = await app.plans.get(planId);
    assert.equal(done.status, 'completed');
    assert.deepEqual(Object.values(done.stepResults).map((r) => r.status), ['completed', 'completed']);
    // What actually happened matches what the candidate claimed it would: the read changed nothing.
    assert.equal(done.steps[1].reversibility, 'read_only');
    assert.ok(done.stepResults.s1.operationId && done.stepResults.s2.operationId, 'each step has a real audit operation');
    const after = await app.goals.get(goal.id);
    assert.equal(after.status, 'proposed', 'running a plan completes no goal: that is the user\'s act');
    assert.deepEqual(after.criteria.map((c) => c.status), ['pending', 'pending', 'pending', 'pending']);
  } finally {
    cleanup(dir);
  }
});

test('replanning refuses the capability that failed and cannot inherit the old approval', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, {
      request: 'remember the release date and compute a figure',
      criteria: ['remember the release date', 'compute 1/0'],
    });
    const before = candidatesForGoal({ goal, registry: app.registry });
    const candidate = strategyOf(before, REQUIRED_ONLY);
    const planId = dataOf(await app.controller.planAdd({
      goalId: goal.id,
      outcome: candidate.outcome,
      steps: candidate.content.steps,
      preconditions: candidate.content.preconditions,
      assertions: candidate.content.assertions,
    })).planId;
    await app.controller.planApprove({ target: planId });
    const run = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(run.status, Outcome.EXECUTION_FAILED, 'the recorded step fails: 1/0');
    const prior = await app.plans.get(planId);
    assert.equal(prior.status, 'blocked');
    assert.equal(prior.stepResults.s1.status, 'completed');
    assert.equal(prior.stepResults.s2.status, 'failed');
    const failureOperation = prior.stepResults.s2.operationId;

    const planLines = linesOf(app.plans.filePath).length;
    const result = revisedCandidates({
      goal: await app.goals.get(goal.id),
      registry: app.registry,
      prior,
      evidence: { failedOperations: [{ operationId: failureOperation, detail: 'calc.evaluate returned division by zero' }] },
      reason: 'the compute step failed in the recorded run',
    });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    // The refused capability comes from the recorded outcome, not from a guess about the cause.
    assert.deepEqual(result.revision.refusedActions, ['calc.evaluate']);
    assert.equal(result.revision.supersedes, prior.id);
    assert.equal(result.revision.priorVersion, 1);
    assert.equal(result.revision.priorApprovalHash, prior.approval.contentHash);
    assert.equal(result.revision.freshApprovalRequired, true);
    assert.equal(result.revision.priorPlanChanged, false);
    assert.deepEqual(result.revision.criteriaTheEarlierPlanAttempted, ['c1', 'c2']);
    assert.deepEqual(result.revision.criteriaNoCandidateCovers, ['c2'], 'the criterion only the failed capability could settle is named');
    assert.equal(result.clarificationNeeded, true);
    for (const c of result.candidates) {
      assert.ok(c.content.steps.every((s) => s.action !== 'calc.evaluate'), 'the refused action is not offered again');
      assert.equal(c.lineage.supersedes, prior.id);
      assert.equal(c.lineage.reason, 'the compute step failed in the recorded run');
      const evidence = c.content.assertions.find((a) => a.kind === 'retrieved_evidence');
      assert.ok(evidence, 'the revision records which failure it answers');
      assert.equal(evidence.ref, failureOperation, 'citing the operation the run actually left behind');
      // Fresh work: an approval of the old content cannot cover these bytes.
      assert.notEqual(c.digest, prior.approval.contentHash);
      assert.notEqual(c.digest, planContentHash(prior));
      assert.notEqual(c.digest, strategyOf(before, c.strategy)?.digest, 'the evidence changed the plan, not only its explanation');
    }
    assert.ok(result.candidates.every((c) => c.digest !== strategyOf(before, c.strategy)?.digest));

    // The plan being responded to stays exactly as it was: no new version, no status change, no edit.
    const after = await app.plans.get(planId);
    assert.equal(after.version, prior.version);
    assert.equal(after.status, prior.status);
    assert.equal(after.approval.contentHash, prior.approval.contentHash);
    assert.deepEqual(after.history.map((h) => h.kind), prior.history.map((h) => h.kind));
    assert.equal(linesOf(app.plans.filePath).length, planLines, 'a revision is text until the user records it');
    assert.equal((await app.plans.list()).length, 1);
    assert.match(renderCandidates(result, { registry: app.registry }), /revises .* version 1: the compute step failed in the recorded run; a fresh approval is required/);

    // Recording the revision is the ordinary write, and it becomes a second plan for the goal, not
    // a replacement of the first: the old plan and its history are kept.
    const revised = result.candidates.find((c) => c.readyForApproval);
    const stored = await app.controller.planAdd({
      goalId: goal.id,
      outcome: revised.outcome,
      steps: revised.content.steps,
      preconditions: revised.content.preconditions,
      assertions: revised.content.assertions,
      reason: `revised after ${failureOperation.slice(0, 8)}`,
    });
    assert.equal(stored.status, Outcome.PLAN_STORED, stored.output);
    assert.notEqual(dataOf(stored).planId, prior.id);
    assert.equal((await app.plans.get(planId)).version, 1, 'the old plan was not rewritten');
    // Two live plans cannot both decide the goal, so the revision must be approved after a decision.
    await assert.rejects(() => app.plans.approve(dataOf(stored).planId), /already has a live plan/);
    const { plan: superseded } = await app.plans.setStatus(planId, 'superseded', {
      reason: 'revised after the recorded failure', by: dataOf(stored).planId,
    });
    assert.equal(superseded.status, 'superseded');
    assert.equal((await app.plans.approve(dataOf(stored).planId)).plan.status, 'approved');
    assert.equal((await app.plans.list()).length, 2, 'both plans and both histories are on record');
  } finally {
    cleanup(dir);
  }
});

test('a revision responds to what the records say is unavailable, and refuses to answer without a prior plan', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    const draft = strategyOf(candidatesForGoal({ goal, registry: app.registry }), REQUIRED_ONLY);
    const planId = dataOf(await app.controller.planAdd({ goalId: goal.id, outcome: draft.outcome, steps: draft.content.steps })).planId;
    const prior = await app.plans.get(planId);
    assert.deepEqual(prior.stepResults, {}, 'nothing has run, so nothing failed');

    // A record that says a capability cannot run now is enough: no failure is invented to justify it.
    const result = revisedCandidates({
      goal, registry: app.registry, prior,
      evidence: { unavailableActions: ['memory.search'] },
      reason: 'the memory store is locked',
    });
    assert.deepEqual(result.revision.refusedActions, ['memory.search']);
    assert.deepEqual(result.revision.priorApprovalHash, null, 'an unapproved plan has no approval to inherit');
    assert.ok(result.candidates.every((c) => c.content.steps.every((s) => s.action !== 'memory.search')));
    assert.deepEqual(result.revision.criteriaNoCandidateCovers, ['c2']);
    assert.match(result.unaddressed.find((u) => u.criterionId === 'c2').reasons.join(' '), /memory\.search is not offered again/);
    assert.equal(result.revision.freshApprovalRequired, true);

    // A revision with no plan behind it is refused rather than generated as a fresh start.
    assert.equal(revisedCandidates({ goal, registry: app.registry, prior: null }).reason, 'no-prior-plan');
    assert.equal(revisedCandidates({ goal, registry: app.registry, prior: { steps: 'not a plan' } }).reason, 'no-prior-plan');
    // Evidence that removes every capability leaves no candidate, and says so plainly.
    const nothing = revisedCandidates({
      goal, registry: app.registry, prior,
      evidence: { unavailableActions: ['memory.add', 'memory.search', 'calc.evaluate'] },
      reason: 'every store is locked',
    });
    assert.equal(nothing.ok, false);
    assert.equal(nothing.reason, 'no-capability');
    assert.deepEqual(nothing.candidates, []);
  } finally {
    cleanup(dir);
  }
});

test('candidate text is one line, bounded, and carries no credential', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    // goal.add refuses a credential in the request, so the crafted record stands for a goal whose
    // text reached APEX by another path: the candidate must not echo it back.
    const secret = 'remember the deploy password: hunter2secret';
    const leaky = candidatesForGoal({
      goal: {
        id: 'g-leak',
        request: secret,
        criteria: [{ id: 'c1', description: secret, status: 'pending', requirement: 'required', basis: 'user_stated' }],
      },
      registry: app.registry,
    });
    assert.equal(leaky.ok, true);
    assert.equal(stableStringify(leaky).includes('hunter2secret'), false, 'the secret is not repeated anywhere in the candidate');
    assert.ok(stableStringify(leaky).includes('[redacted-secret]'), 'and the redaction is visible rather than silent');

    const messy = candidatesForGoal({
      goal: {
        id: 'g-messy',
        request: `remember a\u001b[2Kb\nc\t${'x'.repeat(500)}`,
        criteria: [{ id: 'c1', description: `remember a\u001b[2Kb\nc\t${'y'.repeat(600)}`, status: 'pending', requirement: 'required', basis: 'user_stated' }],
      },
      registry: app.registry,
    });
    const goal = await addGoal(app, MIXED);
    const prereqs = candidatesForGoal({
      goal: {
        ...goal,
        prerequisites: Array.from({ length: 4 }, (_, i) => ({ text: `prerequisite ${i}`, basis: 'user_stated' })),
        blockers: [{ text: 'the archive store is locked', basis: 'user_stated' }],
      },
      registry: app.registry,
      evidence: { knownBlockers: ['the memory store is locked'] },
    });
    for (const result of [leaky, messy, prereqs]) {
      for (const c of result.candidates) {
        for (const s of everyString(c.content)) {
          assert.equal(SINGLE_LINE_FORBIDDEN.test(s), false, `a candidate string carries a control character: ${JSON.stringify(s.slice(0, 40))}`);
          assert.equal(CONTROL_CHARS.test(s), false);
        }
        assert.ok(c.content.steps.length <= MAX_PLAN_STEPS);
        assert.ok(c.content.preconditions.length <= MAX_PRECONDITIONS);
        assert.ok(c.content.assertions.length <= MAX_ASSERTIONS);
        for (const s of c.content.steps) {
          assert.ok(s.description.length <= MAX_EXPECTED_CHARS);
          assert.ok(s.expectedResult.length <= MAX_EXPECTED_CHARS);
          assert.ok(s.verification.length <= MAX_VERIFICATION_CHARS);
          assert.ok(s.recovery.length <= MAX_RECOVERY_CHARS);
        }
        for (const a of c.content.assertions) assert.ok(a.text.length <= MAX_ASSERTION_CHARS);
      }
    }
    // A recorded prerequisite and blocker become preconditions; the caller's evidence does too.
    const withPreconditions = prereqs.candidates[0].content.preconditions;
    assert.ok(withPreconditions.some((p) => p.includes('recorded prerequisite: prerequisite 0')));
    assert.ok(withPreconditions.some((p) => p.includes('recorded blocker to clear first: the archive store is locked')));
    assert.ok(withPreconditions.some((p) => p.includes('blocker from the records: the memory store is locked')));
    assert.ok(withPreconditions.some((p) => p.startsWith(`the goal ${goal.id.slice(0, 24)}`)));
    assert.equal(withPreconditions.length, MAX_PRECONDITIONS, 'the precondition list is bounded and says nothing beyond it');
    // More recorded prerequisites than the bound holds: the list stays at the bound in recorded order,
    // so a candidate cannot present an unbounded list of caveats as if it were complete.
    const overflow = candidatesForGoal({
      goal: {
        ...goal,
        prerequisites: Array.from({ length: 12 }, (_, i) => ({ text: `prerequisite ${i}`, basis: 'user_stated' })),
      },
      registry: app.registry,
    });
    assert.ok(overflow.candidates.every((c) => c.content.preconditions.length === MAX_PRECONDITIONS));
    assert.deepEqual(
      overflow.candidates[0].content.preconditions.slice(1),
      Array.from({ length: MAX_PRECONDITIONS - 1 }, (_, i) => `recorded prerequisite: prerequisite ${i}`),
    );
    // The suggested criterion's own evidence requirement is carried into the step that would settle it.
    const evidenceGoal = await addGoal(app, {
      request: 'remember the release date',
      criteria: [{ description: 'remember the release date', requiredEvidence: 'a record naming the release' }],
    });
    const carried = strategyOf(candidatesForGoal({ goal: evidenceGoal, registry: app.registry }), REQUIRED_ONLY);
    assert.match(carried.content.steps[0].verification, /; and a record naming the release$/);
    assert.ok(carried.content.steps[0].verification.length <= MAX_VERIFICATION_CHARS);
  } finally {
    cleanup(dir);
  }
});

test('the same goal, registry and evidence give the same bytes; different evidence gives different bytes', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    const a = candidatesForGoal({ goal, registry: app.registry });
    const b = candidatesForGoal({ goal, registry: app.registry });
    assert.equal(stableStringify(a), stableStringify(b), 'generation is a function of the records it is handed');
    const c = candidatesForGoal({ goal: await app.goals.get(goal.id), registry: app.registry });
    assert.equal(stableStringify(c), stableStringify(a), 'a freshly read goal is the same goal');

    const withDurations = candidatesForGoal({ goal, registry: app.registry, evidence: { actionDurations: { 'memory.add': [9] } } });
    assert.notEqual(withDurations.candidates[0].digest, a.candidates[0].digest, 'evidence changes the plan, not only its description');
    const withBlocker = candidatesForGoal({ goal, registry: app.registry, evidence: { knownBlockers: ['the memory store is locked'] } });
    assert.notEqual(withBlocker.candidates[0].digest, a.candidates[0].digest);
    assert.ok(withBlocker.candidates[0].content.preconditions.some((p) => p.includes('the memory store is locked')));

    // Two readers over the same registry agree, because nothing is cached between calls.
    const other = await appIn(dir);
    try {
      assert.equal(
        stableStringify(candidatesForGoal({ goal: await other.goals.get(goal.id), registry: other.registry })),
        stableStringify(a),
      );
    } finally {
      await other.close?.();
    }
  } finally {
    cleanup(dir);
  }
});

test('the candidate view shows the trade-off, and never a score, a probability, or a promise', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const goal = await addGoal(app, MIXED);
    const result = candidatesForGoal({ goal, registry: app.registry });
    const shown = renderCandidates(result, { registry: app.registry });
    const lines = shown.split('\n');
    assert.match(lines[0], new RegExp(`^Candidate plans for goal ${goal.id.slice(0, 24)}`));
    assert.ok(lines[0].includes(`3 offered, at most ${MAX_CANDIDATES_PER_GOAL} per goal`));
    for (const strategy of [REQUIRED_ONLY, ALL_OPEN, READ_FIRST]) {
      assert.ok(shown.includes(`${strategy}: `), strategy);
    }
    assert.ok(shown.includes('settles: c1, c2;'));
    assert.ok(shown.includes('no capability for: c4'));
    assert.ok(shown.includes('works on APEX suggestions the user has not made required: c3'));
    assert.ok(shown.includes('memory.search (read, verifiable)'));
    assert.ok(shown.includes('effort: not estimated: no recorded duration for these actions'));
    assert.ok(shown.includes('validation: passed read-only checks'));
    assert.ok(shown.includes('capabilities were checked against the live registry, which holds 77 action(s) now.')
      || shown.includes(`which holds ${app.registry.names().length} action(s) now`));
    assert.ok(shown.includes('Recording one of these is a write, and running one needs the user approval of the recorded content.'));
    assert.equal((shown.match(/not approved, not started, not executable/g) ?? []).length, 3);
    for (const forbidden of [/score/i, /probability/i, /likelihood/i, /%/, /best plan/i, /guarantee/i, /recommended/i]) {
      assert.equal(forbidden.test(shown), false, `${forbidden} appeared in the candidate view:\n${shown}`);
    }
    // The refusal view says what is missing and what APEX will not do about it.
    const vague = await addGoal(app, { request: 'improve the workflow', criteria: ['the workflow is better'] });
    const refused = renderCandidates(candidatesForGoal({ goal: vague, registry: app.registry }));
    assert.match(refused, /^No candidate plan could be recorded: no-capability/m);
    assert.match(refused, /criterion c1: the workflow is better \(no registered action matches this part of the request\)/);
    assert.match(refused, /APEX does not invent a capability to fill a gap/);
  } finally {
    cleanup(dir);
  }
});
