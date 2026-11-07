// Batch AM, work packages F and G: whether a goal stays completed only as long as its proof does, and
// whether a run's success is ever allowed to become the goal's completion by itself.
//
// The planning loop the earlier batches built ends at verified execution: a plan runs, its steps are
// re-read from their own audit records, and the plan is closed. What that establishes is about APEX's
// records. A goal is closed for a different reason - every required criterion satisfied against a
// verified operation, decided by the user - and the two must not be confused. So this suite proves the
// separation in both directions. Nothing that runs a plan completes a goal. And a goal the record calls
// completed stops being reported as settled as soon as the proof it was closed on is withdrawn from the
// knowledge store, because `completed` is a claim about that proof, not a fact frozen at the moment the
// button was pressed.
//
// The second half holds the lifecycle rules the batch asked to be preserved: expiry is never counted or
// worded as a wrong prediction, and no accuracy figure appears unless there are scored observations to
// put under it. Those claims are checked against the records, and against what a read writes - a goal
// whose proof fell away is still the same bytes in `goals.jsonl`, because APEX reports what the records
// say and leaves the decision to reopen where it belongs.
//
// Real controller, real append-only stores, real action registry and audit log, against a temporary
// data directory. The gateway is the no-backend one and capture is off: no model is contacted, no
// inference runs, and nothing here is evidence about a real model's behaviour.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { EvidenceVerdict, completionConsistency } from '../src/goals/assess.js';
import { evaluateCandidates } from '../src/plans/evaluation.js';
import { GoalStatus } from '../src/goals/model.js';
import { shortId } from '../src/util.js';
import { makeTempDataDir, cleanup } from './helpers.js';

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
const opId = (res) => res.operation.id;

// The goal log as bytes: a claim that a read changed nothing is only worth what it can be checked
// against, and the append-only log is what a reader would have to trust.
function goalBytes(dataDir) {
  const file = path.join(dataDir, 'goals.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// A goal with one required criterion, and a verified operation that establishes a knowledge claim -
// the shape a completion is granted on, and the shape a later retraction can take away.
async function goalWithClaim(app, tag) {
  const created = await app.controller.goalAdd({
    request: `the AM evidence goal ${tag}`,
    criteria: [
      { description: `the ${tag} claim holds`, basis: 'user_stated', requiredEvidence: `the ${tag} knowledge record stands` },
    ],
  });
  assert.equal(created.status, Outcome.GOAL_CREATED, display(created));
  const goalId = data(created).goalId;
  for (const status of ['accepted', 'active']) {
    await app.controller.goalUpdate({ target: goalId, status });
  }
  const added = await app.controller.knowledgeAdd({
    subject: `am evidence ${tag}`,
    relationship: 'was checked by',
    object: `${tag} holds`,
  });
  assert.equal(added.status, Outcome.SUCCESS_VERIFIED, display(added));
  return { goalId, claimId: data(added).id, operationId: opId(added) };
}

async function completeOn(app, goalId, criterionId, operationId) {
  const evidence = await app.controller.goalEvidence({
    target: goalId, criterion: criterionId, kind: 'supports', operationId,
  });
  assert.equal(evidence.status, Outcome.GOAL_UPDATED, display(evidence));
  const done = await app.controller.goalComplete({ target: goalId, reason: 'every required criterion is verified' });
  assert.equal(done.status, Outcome.GOAL_COMPLETED, display(done));
}

// The event kinds a goal log holds. A plan that runs appends `goal_linked` records when activation
// links its task, so "nothing was decided about the goal" has to be read as "no transition and no
// completion", not as "the file never grew".
function goalEventTypes(dataDir) {
  return goalBytes(dataDir).split('\n').filter((l) => l !== '')
    .map((l) => JSON.parse(l).type);
}

describe('AM-F1: nothing that runs a plan completes a goal', () => {
  async function planForGoal(app, goalId, steps) {
    const add = await app.controller.planAdd({ goalId, outcome: 'every step of this plan is verified', steps });
    assert.equal(add.status, Outcome.PLAN_STORED, display(add));
    const planId = data(add).planId;
    await app.controller.planApprove({ target: planId });
    return planId;
  }

  const step = (id, action, input, criterionId, risk = 'low') => ({
    id, description: `the ${id} step`, action, input, dependsOn: [], criterionId,
    expectedResult: 'the record holds it', verification: 'the action re-checks its own result', risk,
  });

  test('a plan whose every step verified leaves its goal exactly as it was', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const { goalId } = await goalWithClaim(app, 'run');
    const planId = await planForGoal(app, goalId, [
      step('s1', 'memory.add', { content: 'the AM run note' }, 'c1', 'medium'),
      step('s2', 'memory.list', {}, 'c1'),
    ]);
    // Activation itself links the task into the goal log, which is a record of what was started, not a
    // decision about the intention. Everything after that line is what the run would have to answer for.
    const start = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(start.status, Outcome.SUCCESS_VERIFIED, display(start));
    const typesBefore = goalEventTypes(dataDir);
    assert.equal(typesBefore.filter((t) => t === 'goal_transition').length, 2, 'proposed -> accepted -> active, and nothing since');
    await app.controller.planReconcile(planId);
    const plan = await app.plans.get(planId);
    assert.equal(plan.status, 'completed', 'the plan closed on its verified steps');
    const goal = await app.goals.get(goalId);
    assert.equal(goal.status, GoalStatus.ACTIVE, 'and the goal is still open: a run verifies steps, not intentions');
    assert.deepEqual(goalEventTypes(dataDir), typesBefore, 'the goal log gained no event from a plan completing');
  });

  test('a continuation that finishes the untouched step completes no goal either', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const { goalId } = await goalWithClaim(app, 'continue');
    const planId = await planForGoal(app, goalId, [
      step('s1', 'calc.evaluate', { expression: '1/0' }, 'c1'),
      step('s2', 'memory.add', { content: 'the AM continuation note' }, 'c2', 'medium'),
    ]);
    const start = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(start.status, Outcome.EXECUTION_FAILED, display(start));
    const before = goalBytes(dataDir);
    const cont = await app.controller.planContinue(planId);
    assert.equal(cont.status, Outcome.EXECUTION_FAILED, display(cont));
    assert.deepEqual(cont.ran, ['s2'], 'the step the failure never reached was taken up');
    const goal = await app.goals.get(goalId);
    assert.equal(goal.status, GoalStatus.ACTIVE, 'the continuation ran work; it decided nothing about the intention');
    assert.equal(goalBytes(dataDir), before, 'and wrote nothing to the goal log');
  });

  test('reconciling a finished run copies outcomes onto the plan and stops there', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const { goalId } = await goalWithClaim(app, 'reconcile');
    const planId = await planForGoal(app, goalId, [step('s1', 'memory.add', { content: 'the AM reconcile note' }, 'c1', 'medium')]);
    await app.controller.planActivate(planId, { mode: 'run' });
    const before = goalBytes(dataDir);
    const rec = await app.controller.planReconcile(planId);
    assert.equal(rec.status, Outcome.PLAN_STORED, display(rec));
    assert.equal(goalBytes(dataDir), before, 'a reconcile re-reads the task; it does not touch the goal');
    assert.equal((await app.goals.get(goalId)).status, GoalStatus.ACTIVE);
  });

  test('a goal cannot be completed while a required criterion has no verified supporting operation', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const { goalId } = await goalWithClaim(app, 'refuse');
    const done = await app.controller.goalComplete({ target: goalId, reason: 'nothing supports it' });
    assert.equal(done.status, Outcome.EXECUTION_FAILED, display(done));
    assert.equal((await app.goals.get(goalId)).status, GoalStatus.ACTIVE);
    assert.match(display(done), /c1 is pending/, 'the refusal names the criterion that has no proof');
  });

  test('completion records which operations it was granted on, so a later reader has something to re-open', async () => {
    const app = await appIn(dir());
    const { goalId, operationId } = await goalWithClaim(app, 'snapshot');
    await completeOn(app, goalId, 'c1', operationId);
    const goal = await app.goals.get(goalId);
    assert.equal(goal.status, GoalStatus.COMPLETED);
    assert.deepEqual(goal.completion.criteria.map((c) => c.criterionId), ['c1']);
    assert.equal(goal.completion.criteria[0].operationId, operationId);
  });
});

describe('AM-F2: a goal is completed only while its proof stands', () => {
  test('a retracted proof makes `goal show` report the goal as not settled, and changes no record', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const { goalId, claimId, operationId } = await goalWithClaim(app, 'withdraw');
    await completeOn(app, goalId, 'c1', operationId);
    const settled = await app.controller.showGoal(goalId);
    assert.match(display(settled), /Re-checked: all 1 recorded completion criterion\(s\) still hold/);

    const closedBytes = goalBytes(dataDir);
    const retraction = await app.controller.knowledgeRetract({ target: claimId, reason: 'it was wrong about the deploy window' });
    assert.equal(retraction.status, Outcome.SUCCESS_VERIFIED, display(retraction));

    const shown = await app.controller.showGoal(goalId);
    assert.equal(shown.completion.holds, false, 'the completion no longer rests on anything');
    assert.deepEqual(shown.completion.withdrawn.map((w) => w.criterionId), ['c1']);
    assert.match(display(shown), /NOT SETTLED/);
    assert.match(display(shown), /goal evidence .* --kind contradicts --reopen/, 'the record names the command that can act on it');
    assert.equal((await app.goals.get(goalId)).status, GoalStatus.COMPLETED,
      'and APEX left the decision where it belongs: the goal is still recorded as completed');
    assert.equal(goalBytes(dataDir), closedBytes, 'withdrawing a knowledge claim appended to the knowledge log, never to the goal log');
  });

  test('the goal log grew only from the retraction itself, never from the read that noticed it', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const { goalId, claimId, operationId } = await goalWithClaim(app, 'bytes');
    await completeOn(app, goalId, 'c1', operationId);
    const before = goalBytes(dataDir);
    await app.controller.knowledgeRetract({ target: claimId, reason: 'replaced by a later check' });
    const afterRetraction = goalBytes(dataDir);
    assert.equal(afterRetraction, before, 'retracting a knowledge claim appends to the knowledge log, not the goal log');
    await app.controller.showGoal(goalId);
    await app.controller.assessStoredGoal(goalId);
    assert.equal(goalBytes(dataDir), afterRetraction, 'two reads that noticed the withdrawal wrote nothing');
  });

  test('`goal assess` answers the same question as `goal show`, from the same records', async () => {
    const app = await appIn(dir());
    const { goalId, claimId, operationId } = await goalWithClaim(app, 'assess');
    await completeOn(app, goalId, 'c1', operationId);
    await app.controller.knowledgeRetract({ target: claimId, reason: 'the test replaced it' });
    const assessed = await app.controller.assessStoredGoal(goalId);
    assert.equal(assessed.assessment.ok, false);
    assert.equal(assessed.assessment.criteria[0].verdict, EvidenceVerdict.STALE);
    assert.equal(assessed.completion.holds, false);
    assert.deepEqual(assessed.completion.withdrawn.map((w) => w.criterionId), ['c1']);
    assert.equal(assessed.goal.status, GoalStatus.COMPLETED, 'the assessment did not reopen the goal');
  });

  test('a superseded proof is withdrawn proof: the replacement record does not carry the old completion', async () => {
    const app = await appIn(dir());
    const { goalId, claimId, operationId } = await goalWithClaim(app, 'supersede');
    await completeOn(app, goalId, 'c1', operationId);
    const over = await app.controller.knowledgeAdd({
      subject: 'am evidence supersede', relationship: 'was checked by', object: 'the second answer holds', supersedes: [claimId],
    });
    assert.equal(over.status, Outcome.SUCCESS_VERIFIED, display(over));
    const shown = await app.controller.showGoal(goalId);
    assert.equal(shown.completion.holds, false);
    assert.match(shown.completion.detail, /no longer stands/);
  });

  test('a withdrawn proof is not papered over: evidence cannot be added to a closed goal', async () => {
    const app = await appIn(dir());
    const { goalId, claimId, operationId } = await goalWithClaim(app, 'restore');
    await completeOn(app, goalId, 'c1', operationId);
    await app.controller.knowledgeRetract({ target: claimId, reason: 'wrong the first time' });
    assert.equal((await app.controller.showGoal(goalId)).completion.holds, false);
    const fresh = await app.controller.knowledgeAdd({
      subject: 'am evidence restore', relationship: 'was checked by', object: 'the claim holds after the correction',
    });
    const added = await app.controller.goalEvidence({
      target: goalId, criterion: 'c1', kind: 'supports', operationId: opId(fresh),
    });
    assert.notEqual(added.status, Outcome.SUCCESS_VERIFIED, display(added));
    assert.equal((await app.controller.showGoal(goalId)).completion.holds, false,
      'the new record does not silently re-settle a completion the user has to decide about');

    // The way back is the user's own reopen, and after it the fresh proof does settle the goal again.
    const contradiction = await app.controller.knowledgeAdd({
      subject: 'am evidence reopen restore', relationship: 'was checked by', object: 'the corrected claim does not hold as completed',
    });
    const reopened = await app.controller.goalEvidence({
      target: goalId, criterion: 'c1', kind: 'contradicts', operationId: opId(contradiction), reopen: true,
    });
    assert.equal(reopened.status, Outcome.GOAL_UPDATED, display(reopened));
    await app.controller.goalUpdate({ target: goalId, status: 'active', reason: 'the proof was withdrawn; pursuing it again' });
    await app.controller.goalEvidence({ target: goalId, criterion: 'c1', kind: 'supports', operationId: opId(fresh) });
    const done = await app.controller.goalComplete({ target: goalId, reason: 'verified again' });
    assert.equal(done.status, Outcome.GOAL_COMPLETED, display(done));
    assert.equal((await app.controller.showGoal(goalId)).completion.holds, true,
      'and this time the completion is checked against a record that stands');
  });

  test('a completed goal with no recorded snapshot is reported as unprovable, not as settled', async () => {
    const goal = {
      id: 'goal-aaaa1111', status: GoalStatus.COMPLETED, revision: 1, criteria: [],
      completion: null, statusHistory: [], planIds: [], taskIds: [], dependsOn: [],
    };
    const out = completionConsistency(goal, { criteria: [], uncheckable: [] });
    assert.equal(out.holds, null);
    assert.equal(out.checked, false);
    assert.match(out.detail, /no completion-evidence snapshot/);
  });

  test('an unread or unreadable evidence read never comes back as a clean completion', () => {
    const goal = {
      id: 'goal-bbbb2222', status: GoalStatus.COMPLETED, revision: 1, criteria: [], statusHistory: [],
      completion: { criteria: [{ criterionId: 'c1', operationId: 'op-1' }] },
    };
    const notRead = completionConsistency(goal, null);
    assert.equal(notRead.holds, null);
    assert.match(notRead.detail, /were not read/);

    const unreadable = completionConsistency(goal, {
      criteria: [{
        id: 'c1', requirement: 'required', verdict: EvidenceVerdict.UNVERIFIABLE, reason: 'the audit log could not be read',
      }],
      uncheckable: ['the audit log could not be read'],
    });
    assert.equal(unreadable.holds, false, 'a proof that cannot be checked is not a proof that holds');
    assert.match(unreadable.detail, /could not be checked/);

    const open = completionConsistency({ id: 'g', status: GoalStatus.ACTIVE, criteria: [] }, null);
    assert.equal(open.completed, false);
    assert.equal(open.holds, null, 'a goal that was never completed has nothing to lose');
  });

  test('the comparison says which of the two it found: closed, or closed on a proof that fell away', () => {
    const NAMES = ['memory.add', 'memory.list'];
    const registry = {
      names: () => [...NAMES],
      get: (name) => ({ name, permission: name === 'memory.add' ? 'write' : 'read', plannable: true }),
      authorize: () => ({ decision: 'allow' }),
    };
    const candidate = {
      strategy: 'one_approach',
      digest: 'c'.repeat(64),
      note: 'an approach',
      steps: 1, writes: 0, reads: 1, risk: 'low', readyForApproval: true,
      validation: { ok: true, problems: [] },
      content: {
        goalId: 'goal-1', outcome: 'the criterion is settled', preconditions: [], assertions: [],
        resources: { estimatedSeconds: null },
        steps: [{ id: 's1', description: 'read', action: 'memory.list', input: {}, dependsOn: [], expectedResult: 'a list', verification: 're-read', risk: 'low' }],
      },
      criteriaCovered: [], criteriaLeftUnaddressed: [], criteriaAssumedFromTheGoalRequest: [],
      criteriaLeftOutOfThisApproach: [], stepsBeyondThePlanBound: [], criteriaBeyondThePlanBound: [],
      criteriaSharedWithAnEarlierStep: [], criteriaFromInference: [], capabilities: [],
    };
    const closed = { id: 'goal-1', revision: 1, status: GoalStatus.COMPLETED, criteria: [], completion: { criteria: [] } };
    const plain = evaluateCandidates({
      result: { ok: true, candidates: [candidate], skipped: [] }, goal: closed, registry,
    });
    assert.match(plain.candidates[0].gates.goal_still_open.detail, /no longer open \(the completion evidence was not re-read/);

    const disproven = evaluateCandidates({
      result: { ok: true, candidates: [candidate], goal: closed, skipped: [] },
      goal: closed, registry,
      goalEvidence: {
        completed: true, checked: true, holds: false,
        withdrawn: [{ criterionId: 'c1', requirement: 'required', verdict: 'stale', operationId: 'op-1', reason: 'retracted' }],
        unsupported: [], uncheckable: [],
        detail: 'the goal is recorded as completed, c1 (stale, operation op-1): the proof the goal was closed on no longer stands',
        command: 'node bin/apex.js goal evidence goal-1 --criterion c1 --kind contradicts --reopen',
      },
    });
    const detail = disproven.candidates[0].gates.goal_still_open.detail;
    assert.match(detail, /completed on record, c1 \(stale, operation op-1\): the proof the goal was closed on no longer stands/);
    assert.match(detail, /stays closed until the user reopens it, and no candidate reopens it/);
    assert.equal(disproven.goalEvidenceRead.holds, false);
    assert.deepEqual(disproven.goalEvidenceRead.withdrawn, ['c1']);
  });
});

describe('AM-F3: reopening stays the user\'s own act, and the history survives it', () => {
  test('contradicting evidence on a closed goal is refused unless the user states the reopen', async () => {
    const app = await appIn(dir());
    const { goalId, claimId, operationId } = await goalWithClaim(app, 'contradict');
    await completeOn(app, goalId, 'c1', operationId);
    await app.controller.knowledgeRetract({ target: claimId, reason: 'the test replaced it' });
    const contradiction = await app.controller.knowledgeAdd({
      subject: 'am evidence contradict', relationship: 'was checked by', object: 'the claim does not hold',
    });
    const marked = await app.controller.goalEvidence({
      target: goalId, criterion: 'c1', kind: 'contradicts', operationId: opId(contradiction), detail: 'checked again, and it does not hold',
    });
    assert.equal(marked.status, Outcome.EXECUTION_FAILED, display(marked));
    assert.match(display(marked), /must state reopen/, 'the reopen is a decision, and APEX does not take it by implication');
    assert.equal((await app.goals.get(goalId)).status, GoalStatus.COMPLETED, 'a refusal records nothing');
    const shown = await app.controller.showGoal(goalId);
    assert.equal(shown.completion.holds, false, 'and the finding stays visible until the user acts');
  });

  test('the reopen clears completion, keeps the earlier completion record, and lets planning resume', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const { goalId, claimId, operationId } = await goalWithClaim(app, 'reopen');
    await completeOn(app, goalId, 'c1', operationId);
    await app.controller.knowledgeRetract({ target: claimId, reason: 'the test replaced it' });
    const contradiction = await app.controller.knowledgeAdd({
      subject: 'am evidence reopen', relationship: 'was checked by', object: 'the claim does not hold after all',
    });
    const bytesBefore = goalBytes(dataDir);
    const reopened = await app.controller.goalEvidence({
      target: goalId, criterion: 'c1', kind: 'contradicts', operationId: opId(contradiction),
      detail: 're-opened on the user\'s instruction', reopen: true,
    });
    assert.equal(reopened.status, Outcome.GOAL_UPDATED, display(reopened));
    const goal = await app.goals.get(goalId);
    assert.equal(goal.status, GoalStatus.BLOCKED);
    assert.equal(goal.completion, null, 'the completion no longer stands');
    assert.ok(goal.statusHistory.some((h) => h.to === 'completed'), 'the earlier completion is still in the log');
    assert.ok(goalBytes(dataDir).startsWith(bytesBefore), 'the goal log was appended to, never rewritten');
    const shown = await app.controller.showGoal(goalId);
    assert.equal(shown.completion, null, 'a goal that is no longer completed has no completion to check');
    assert.equal(display(shown).includes('NOT SETTLED'), false, 'and the read does not keep reporting a closure it no longer has');
  });

  test('a completed goal cannot be revised underneath the user', async () => {
    const app = await appIn(dir());
    const { goalId, claimId, operationId } = await goalWithClaim(app, 'immutable');
    await completeOn(app, goalId, 'c1', operationId);
    await app.controller.knowledgeRetract({ target: claimId, reason: 'the test replaced it' });
    const revise = await app.controller.goalRevise({
      target: goalId, criteria: ['a criterion invented after the proof fell away'], reason: 'trying to change a closed goal',
    });
    assert.equal(revise.status, Outcome.EXECUTION_FAILED, display(revise));
    assert.equal((await app.goals.get(goalId)).status, GoalStatus.COMPLETED, 'the refusal changed nothing');
  });
});

describe('AM-G: expiry is not wrong, and no rate without scored observations', () => {
  const later = (days) => () => new Date(Date.parse('2026-11-05T09:00:00.000Z') + days * 86400000);
  const appAt = (dataDir, nowFn) => createApp({
    dataDir,
    now: nowFn,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    experienceCapture: CAPTURE_OFF,
  });

  async function expectation(app, tag, inDays = 1) {
    const recorded = await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success', subject: `the ${tag} expectation`, inDays,
    });
    assert.equal(recorded.status, Outcome.SUCCESS_VERIFIED, display(recorded));
    return data(recorded);
  }

  test('a horizon that passed with no outcome evidence is expired, and never counted or worded as wrong', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const prediction = await expectation(app, 'expired');
    const id = prediction.predictionId ?? prediction.id;
    // A second process whose clock is past the horizon: the expiry comes from the record's own date, not
    // from a test reaching into the engine.
    const after = await appAt(dataDir, later(3));
    const shown = await after.controller.predictionShow({ target: id });
    assert.match(display(shown), /expired/i);
    assert.equal(data(shown).projection.evaluationRecorded, null,
      'no evaluation record exists against it: expiry decided nothing, so there is nothing to count');
    assert.match(display(shown), /expiry is not a wrong prediction|never counted as wrong/i);
    // Listed by state: the expired record belongs to the expired bucket and to no scored bucket, which is
    // the claim the batch asked to be able to make.
    const expired = await after.controller.predictionList({ status: 'expired' });
    assert.equal(expired.status, Outcome.SUCCESS_VERIFIED, display(expired));
    assert.ok(display(expired).includes(shortId(id)), display(expired));
    const evaluated = await after.controller.predictionList({ status: 'evaluated' });
    assert.equal(display(evaluated).includes(shortId(id)), false, 'an expired expectation is not an evaluated one');
    const summary = await after.controller.predictionSummary();
    assert.match(display(summary), /0 matched, 0 contradicted/, 'an expired expectation adds nothing to either side');
    assert.match(display(summary), /Match rate:\s+none stated/, 'and no rate is stated over it');
  });

  test('an empty ledger answers with no rate at all, and says why', async () => {
    const app = await appIn(dir());
    const summary = await app.controller.predictionSummary();
    assert.match(display(summary), /Match rate:\s+none stated \(no prediction has been evaluated yet\)/);
    assert.equal(display(summary).includes('%'), false, 'no percentage is printed over nothing');
    assert.match(display(summary), /Reliability:\s+no_evaluations/);
  });

  test('a recorded expectation moves no candidate byte and no ranked dimension', async () => {
    const app = await appIn(dir());
    const { goalId } = await goalWithClaim(app, 'nomove');
    const before = await app.controller.planCandidates({ goal: goalId });
    assert.equal(before.status, Outcome.SUCCESS_VERIFIED, display(before));
    const digestBefore = data(before).candidateSetDigest;
    const frontBefore = data(before).comparison.front.join(',');
    await expectation(app, 'after');
    const after = await app.controller.planCandidates({ goal: goalId });
    assert.equal(after.status, Outcome.SUCCESS_VERIFIED, display(after));
    assert.equal(data(after).candidateSetDigest, digestBefore, 'an expectation about a later event is not evidence about these steps');
    assert.equal(data(after).comparison.front.join(','), frontBefore);
  });
});
