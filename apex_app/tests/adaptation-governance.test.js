// Batch AP-05: adaptation governance - evidence-bound review records, read-time reconciliation, and
// explicit user lifecycle decisions.
//
// The claim under test is that a governance review is a question, never an answer: opening one records
// the exact evidence it cites and changes no rule; reconciling it says what differs without saying
// whether the difference is good; a decision is the user's and retirement reuses the one existing
// retirement authority. Each state is derived from the append-only log at read time, and every failure
// is reported as the failure it is rather than converted into evidence of success or harm.
//
// Everything runs through the assembled application, the real experience/plan/goal/audit stores and
// their write locks, the action registry and its independent verifiers. The only fixtures are NoBackend
// and a fixed clock. No model is contacted, no inference runs, and no synthetic record is presented as
// a prediction or as outside evidence.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { StoreError } from '../src/errors.js';
import {
  GOVERNANCE_SCHEMA,
  GOVERNANCE_NOTE,
  MAX_GOVERNANCE_ADAPTATIONS,
  governanceDetail,
  prepareReview,
} from '../src/plans/governance.js';
import {
  REVIEW_STATES,
  REVIEW_DECISIONS,
  canonicalReviewEvidence,
  classifyReviewState,
  reconcileReviewEvidence,
  reviewEvidenceDigest,
} from '../src/experience/review.js';
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
const json = (value) => JSON.parse(JSON.stringify(value ?? null));

const GUIDANCE = 'read the list before adding to it';

// ---- fixtures built from the user's own records ------------------------------------------------

// Two corrected writes derive one candidate, the user approves it, and (unless order is null) the user
// states its shape. With no guidance the adaptation's shape version is unrecorded, which is the state a
// later guidance change moves on from.
async function seedRule(app, { guidance = GUIDANCE, order = 'reads_first', tag = 'AP' } = {}) {
  let writeOperationId = null;
  for (const n of [1, 2]) {
    const write = await app.controller.handle(`remember that the ${tag} note ${n} holds`, { origin: 'user' });
    assert.equal(write.status, Outcome.SUCCESS_VERIFIED, write.output);
    writeOperationId = write.operation.id;
    const experience = await app.controller.experienceRecord({ operationId: write.operation.id, subject: `an ${tag} memory write` });
    assert.equal(experience.status, Outcome.SUCCESS_VERIFIED, experience.output);
    const feedback = await app.controller.feedbackRecord({
      target: data(experience).id, assessment: 'user_correction', guidance, reason: 'done the long way round',
    });
    assert.equal(feedback.status, Outcome.SUCCESS_VERIFIED, feedback.output);
  }
  const derived = data(await app.controller.adaptationDerive({}));
  const adaptation = derived.created.find((a) => a.rule === guidance);
  assert.ok(adaptation, JSON.stringify(derived.created));
  assert.equal((await app.controller.adaptationDecide({
    target: adaptation.id, decision: 'approved', reason: 'this is how I want it done',
  })).status, Outcome.SUCCESS_VERIFIED);
  if (order !== null) {
    assert.equal((await app.controller.adaptationGuide({ target: adaptation.id, order })).status, Outcome.SUCCESS_VERIFIED);
  }
  return { adaptation, writeOperationId };
}

let goalSeq = 0;
async function twoCriterionGoal(app) {
  goalSeq += 1;
  const created = await app.controller.goalAdd({
    request: `keep the running note current, case ${goalSeq}`,
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

async function prepare(app, goalId) {
  const prep = await app.controller.handle(`prepare a plan for goal ${goalId}`, { origin: 'user' });
  assert.equal(prep.status, Outcome.PLAN_STORED, prep.output);
  const disclosureStep = prep.operation.steps.find((s) => s.action === 'plan.candidates' || s.action === 'plan.replan');
  const addStep = prep.operation.steps.find((s) => s.action === 'plan.add');
  assert.ok(disclosureStep?.result?.data?.adaptationDecision, 'the comparison is disclosed in the operation');
  assert.ok(addStep?.result?.data?.planId, 'the plan is recorded in the same operation');
  return {
    operationId: prep.operation.id,
    decision: disclosureStep.result.data.adaptationDecision,
    planId: addStep.result.data.planId,
  };
}

async function approvedPlan(app, goalId) {
  const prepared = await prepare(app, goalId);
  assert.equal((await app.controller.planApprove({ target: prepared.planId })).status, Outcome.PLAN_STORED);
  return prepared;
}

// A completed, verified execution whose goal criteria are satisfied on evidence that still stands.
async function successfulUse(app, goalId) {
  const prepared = await approvedPlan(app, goalId);
  const run = await app.controller.planActivate(prepared.planId, { mode: 'run' });
  assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.output ?? display(run));
  const plan = await app.plans.get(prepared.planId);
  const goal = await app.goals.get(goalId);
  for (const criterion of goal.criteria) {
    const step = plan.steps.find((s) => s.criterionId === criterion.id) ?? plan.steps[0];
    const operationId = plan.stepResults[step.id].operationId;
    const evidence = await app.controller.goalEvidence({
      target: goalId, criterion: criterion.id, kind: 'supports', operationId,
    });
    assert.equal(evidence.status, Outcome.GOAL_UPDATED, evidence.output);
  }
  assert.equal((await app.controller.planAssess({ target: prepared.planId })).status, Outcome.SUCCESS_VERIFIED);
  return { planId: prepared.planId, decision: prepared.decision };
}

// Two current assessments that disagree: the report classifies the use as conflicting evidence and
// recommends a review, which is the fixture that makes a recommendation exist at all.
async function conflictingUse(app, goalId) {
  const { adaptation, writeOperationId } = await seedRule(app);
  const prepared = await approvedPlan(app, goalId);
  const taskId = 'task-ap05-conflict';
  await app.plans.activate(prepared.planId, { taskId });
  const plan = await app.plans.get(prepared.planId);
  await app.plans.recordOutcome(prepared.planId, {
    taskId,
    steps: plan.steps.map((s) => ({ stepId: s.id, status: 'completed', operationId: writeOperationId })),
  });
  for (const verdict of ['successful', 'failed']) {
    await app.plans.assessPlan(prepared.planId, {
      verdict,
      summary: `a synthetic assessment fixture records ${verdict}`,
      findings: [{ aspect: 'goal_criteria', statement: `the fixture records ${verdict}`, operations: [writeOperationId] }],
    });
  }
  return { adaptation, prepared };
}

// Two failed uses of the current version: the smallest count that makes a negative summary.
async function repeatedFailure(app) {
  const { adaptation } = await seedRule(app);
  for (const tag of ['one', 'two']) {
    const goalId = await twoCriterionGoal(app);
    const prepared = await approvedPlan(app, goalId);
    const taskId = `task-ap05-${tag}`;
    await app.plans.activate(prepared.planId, { taskId });
    const plan = await app.plans.get(prepared.planId);
    await app.plans.recordOutcome(prepared.planId, {
      taskId,
      steps: plan.steps.map((s) => ({ stepId: s.id, status: 'failed', detail: 'the fixture records a failure' })),
    });
  }
  return adaptation;
}

// ---- governance surface helpers -----------------------------------------------------------------

async function governance(app, opts = {}) {
  const res = await app.controller.adaptationReviews(opts);
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output ?? display(res));
  const report = data(res).report;
  assert.equal(report.schema, GOVERNANCE_SCHEMA);
  return { res, report };
}

async function rowFor(app, adaptationId, opts = {}) {
  const { report } = await governance(app, opts);
  const row = report.adaptations.find((r) => r.id === adaptationId) ?? null;
  assert.ok(row, `the report lists adaptation ${adaptationId.slice(0, 8)}`);
  return row;
}

async function inspect(app, target) {
  const res = await app.controller.adaptationReviewInspect({ target });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output ?? display(res));
  return { res, detail: data(res).detail };
}

async function reconcile(app, target) {
  const res = await app.controller.adaptationReviewReconcile({ target });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output ?? display(res));
  return { res, result: data(res) };
}

async function openReview(app, target, reason = null) {
  const res = await app.controller.adaptationReviewOpen({ target, reason });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output ?? display(res));
  return data(res);
}

async function decide(app, review, decision, reason = null) {
  const res = await app.controller.adaptationReviewDecide({ review, decision, reason });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output ?? display(res));
  return data(res);
}

// The exact bundle a review was recorded with, read back from the store.
async function evidenceOf(app, reviewId) {
  const { review } = await app.experience.reviewDetail(reviewId);
  return { review, evidence: json(review.evidence) };
}

function experienceLines(d) {
  const file = path.join(d, 'experiences.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function appendRecord(d, record) {
  fs.appendFileSync(path.join(d, 'experiences.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
}

function reviewRecord({ targetId, evidence, createdAt = '2026-11-06T09:00:00.000Z', reason = null }) {
  const canonical = canonicalReviewEvidence(evidence);
  return {
    schema: 1,
    kind: 'adaptation_review',
    id: randomUUID(),
    targetId,
    evidence: canonical,
    evidenceDigest: reviewEvidenceDigest(canonical),
    reportDigest: null,
    recommendation: canonical.report.recommendation,
    awaitingEvidence: false,
    ...(reason ? { reason } : {}),
    createdAt,
    provenance: { origin: 'user_review', updateMode: 'user_confirmed' },
  };
}

// ================================================================================================
describe('AP-05 report: the evidence that could need a review, and the authority it does not have', () => {
  test('no adaptation record is stored, so the report is empty and says why', async () => {
    const d = dir();
    const app = await appIn(d);
    const { res, report } = await governance(app);
    assert.equal(report.available, true);
    assert.deepEqual(report.adaptations, []);
    assert.equal(report.totals.adaptations, 0);
    assert.equal(report.totals.requiringReview, 0);
    assert.equal(report.reason, 'no adaptation record is stored');
    assert.equal(report.authorizes, false);
    assert.equal(report.note, GOVERNANCE_NOTE);
    assert.deepEqual(Object.keys(report.totals.states).sort(), [...REVIEW_STATES].sort());
    assert.ok(REVIEW_STATES.every((state) => report.totals.states[state] === 0));
    assert.match(display(res), /no adaptation record is stored/);
  });

  test('an approved rule with no evaluated use is listed, recommends nothing, and requires no review', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const { report } = await governance(app);
    const row = report.adaptations.find((r) => r.id === adaptation.id);
    assert.ok(row);
    assert.equal(row.review, null);
    assert.equal(row.reviewState, 'no_review_required');
    assert.equal(row.reviewCurrent, false);
    assert.equal(row.requiresReview, false);
    assert.equal(row.recommendation.kind, 'none');
    assert.equal(row.recommendation.authorizes, false);
    assert.equal(row.reconciliation, null);
    assert.equal(report.authorizes, false);
    // A second read over an unchanged log returns the same digest: the report is derived, not cached.
    const again = await governance(app);
    assert.equal(again.report.digest, report.digest);
  });

  test('a request to review something that is not recorded is an error, not a review of nothing', async () => {
    const d = dir();
    const app = await appIn(d);
    const opened = await app.controller.adaptationReviewOpen({ target: 'no-such-adaptation' });
    assert.equal(opened.status, Outcome.EXECUTION_FAILED);
    assert.match(opened.output, /no adaptation matches/i);
    const read = await app.controller.adaptationReviewInspect({ target: 'no-such-review-or-adaptation' });
    assert.equal(read.status, Outcome.EXECUTION_FAILED);
    assert.match(read.output, /no review or adaptation matches/i);
    assert.equal(experienceLines(d).length, 0, 'nothing was written by either refusal');
  });

  test('the reported window is bounded, and a larger limit is refused rather than silently widened', async () => {
    const d = dir();
    const app = await appIn(d);
    await seedRule(app);
    const res = await app.controller.adaptationReviews({ limit: MAX_GOVERNANCE_ADAPTATIONS + 500 });
    assert.equal(res.status, Outcome.INPUT_REJECTED);
    assert.match(res.output, new RegExp(`limit must be an integer from 1 to ${MAX_GOVERNANCE_ADAPTATIONS}`));
    const atLimit = await app.controller.adaptationReviews({ limit: MAX_GOVERNANCE_ADAPTATIONS });
    assert.equal(atLimit.status, Outcome.SUCCESS_VERIFIED, atLimit.output);
    assert.equal(data(atLimit).report.scope.limit, MAX_GOVERNANCE_ADAPTATIONS);
  });
});

// ================================================================================================
describe('AP-05 lifecycle: opening, awaiting evidence, and the four user decisions', () => {
  test('a review opened before any evaluated use is awaiting evidence, not successful and not failed', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const opened = await openReview(app, adaptation.id, 'watch this rule');
    assert.equal(opened.awaitingEvidence, true);

    const { detail } = await inspect(app, opened.reviewId);
    assert.equal(detail.reviewState, 'review_awaiting_evidence');
    assert.equal(detail.awaitingEvidence, true);
    assert.equal(detail.review.reason, 'watch this rule');
    assert.equal(detail.review.decision, null);
    assert.equal(detail.review.decisionCount, 0);
    assert.equal(detail.reconciliation.state, 'unchanged');
    assert.equal(detail.authorizes, false);

    // The list read agrees with the detail read, and counts it as needing attention.
    const row = await rowFor(app, adaptation.id);
    assert.equal(row.reviewState, 'review_awaiting_evidence');
    assert.equal(row.requiresReview, true);
    assert.equal(row.review.id, opened.reviewId);
  });

  test('keep_active is a completed review on current evidence and changes no rule', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    await successfulUse(app, goalId);
    const before = await app.experience.adaptationDetail(adaptation.id);

    const opened = await openReview(app, adaptation.id);
    assert.equal(opened.awaitingEvidence, false);
    const decided = await decide(app, opened.reviewId, 'keep_active', 'still how I work');
    assert.equal(decided.decision, 'keep_active');
    assert.equal(decided.retirementId, null);
    assert.equal(decided.reviewedEvidenceDigest, opened.evidenceDigest);

    const { detail } = await inspect(app, opened.reviewId);
    assert.equal(detail.reviewState, 'review_completed');
    assert.equal(detail.reviewCurrent, true);
    assert.equal(detail.review.decision.decision, 'keep_active');
    assert.equal(detail.review.decision.reason, 'still how I work');
    assert.equal(detail.reconciliation.state, 'unchanged');

    const after = await app.experience.adaptationDetail(adaptation.id);
    assert.equal(after.decisionState, before.decisionState);
    assert.equal(after.rule, before.rule);
    assert.equal(after.active, true);
    assert.equal(after.retired, false);
    assert.equal(after.retirement, null, 'keeping an adaptation active records no retirement');

    // The rule still shapes the next decision, exactly as the user approved it.
    const nextGoal = await twoCriterionGoal(app);
    const candidates = data(await app.controller.planCandidates({ goal: nextGoal }));
    assert.equal(candidates.adaptationDecision.applied, true);
    assert.equal(candidates.adaptationDecision.after.leading, 'read_before_write');
  });

  test('dismiss leaves the rule, its scope, and its influence exactly as they were', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const before = await app.experience.adaptationDetail(adaptation.id);
    const activeBefore = await app.experience.activeAdaptations({ capability: adaptation.capability, limit: 10 });

    const opened = await openReview(app, adaptation.id);
    await decide(app, opened.reviewId, 'dismiss', 'the recommendation does not convince me');

    const { detail } = await inspect(app, opened.reviewId);
    assert.equal(detail.reviewState, 'review_dismissed');
    assert.equal(detail.review.decision.decision, 'dismiss');

    const after = await app.experience.adaptationDetail(adaptation.id);
    assert.equal(after.rule, before.rule);
    assert.equal(after.ruleHash, before.ruleHash);
    assert.equal(after.decisionState, before.decisionState);
    assert.equal(after.active, true);
    const activeAfter = await app.experience.activeAdaptations({ capability: adaptation.capability, limit: 10 });
    assert.deepEqual(activeAfter.adaptations.map((a) => a.id), activeBefore.adaptations.map((a) => a.id));
  });

  test('retire records the one existing retirement kind and removes the rule from future influence', async () => {
    const d = dir();
    const app = await appIn(d);
    const adaptation = await repeatedFailure(app);
    const opened = await openReview(app, adaptation.id);
    const decided = await decide(app, opened.reviewId, 'retire', 'no longer how I work');

    assert.match(decided.retirementId, /^[0-9a-f-]{36}$/);
    const records = experienceLines(d);
    const retirements = records.filter((r) => r.kind === 'adaptation_retirement');
    assert.equal(retirements.length, 1, 'a governance retirement is the existing retirement record, not a second kind');
    assert.equal(retirements[0].id, decided.retirementId);
    assert.equal(records.filter((r) => r.kind === 'adaptation_review_decision').length, 1);

    const { detail } = await inspect(app, opened.reviewId);
    assert.equal(detail.reviewState, 'review_completed');
    assert.equal(detail.adaptation.retired, true);
    assert.equal(detail.adaptation.decisionState, 'retired');
    assert.equal(detail.review.decision.retirementId, decided.retirementId);

    const candidates = data(await app.controller.planCandidates({ goal: await twoCriterionGoal(app) }));
    assert.equal(candidates.adaptationDecision.applied, false, 'a retired rule is no longer offered');
    const active = await app.experience.activeAdaptations({ capability: adaptation.capability, limit: 10 });
    assert.ok(!active.adaptations.some((a) => a.id === adaptation.id));

    // The existing operation refuses a second retirement, and no second record appears.
    const again = await app.controller.adaptationRetire({ target: adaptation.id, reason: 'a second attempt' });
    assert.equal(again.status, Outcome.EXECUTION_FAILED);
    assert.match(again.output, /already retired/i);
    assert.equal(experienceLines(d).filter((r) => r.kind === 'adaptation_retirement').length, 1);
  });

  test('a later review supersedes the earlier one, and the earlier one can no longer be decided', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const first = await openReview(app, adaptation.id);

    // A second, current use changes the evidence, so the first review no longer describes it.
    await prepare(app, await twoCriterionGoal(app));
    const second = await openReview(app, adaptation.id);

    const { detail: firstDetail } = await inspect(app, first.reviewId);
    assert.equal(firstDetail.reviewState, 'review_decision_superseded');
    assert.equal(firstDetail.reviewCurrent, false);
    assert.deepEqual(firstDetail.review.supersededBy, [second.reviewId]);

    const refused = await app.controller.adaptationReviewDecide({ review: first.reviewId, decision: 'keep_active' });
    assert.equal(refused.status, Outcome.EXECUTION_FAILED);
    assert.match(refused.output, /superseded/i);

    const row = await rowFor(app, adaptation.id);
    assert.equal(row.review.id, second.reviewId, 'the list read reports the current review');
    assert.equal(row.reviewState, 'review_opened');
  });
});

// ================================================================================================
describe('AP-05 reconciliation: what changed, and what a change does not mean', () => {
  test('a moved report digest alone is not an evidence change', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    const { evidence } = await evidenceOf(app, opened.reviewId);

    const diff = reconcileReviewEvidence({
      stored: evidence,
      current: evidence,
      storedReportDigest: 'a'.repeat(64),
      currentReportDigest: 'b'.repeat(64),
    });
    assert.equal(diff.changed, false);
    assert.equal(diff.current, true);
    assert.equal(diff.state, 'unchanged');
    assert.equal(diff.reportChanged, true, 'the report digest is tracked separately');
    assert.match(diff.why, /unchanged/);
  });

  test('a rule hash change without a version change is conflicting, not an ordinary edit', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    const { evidence } = await evidenceOf(app, opened.reviewId);

    const current = json(evidence);
    current.rule.hash = 'f'.repeat(64);
    const diff = reconcileReviewEvidence({ stored: evidence, current });
    assert.equal(diff.rule.versionChanged, false);
    assert.equal(diff.rule.hashChanged, true);
    assert.equal(diff.rule.conflict, true);
    assert.equal(diff.state, 'conflicting');
    assert.ok(diff.kinds.includes('conflicting'));
  });

  test('a withdrawn outcome assessment is withdrawn, not a worse outcome', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    const { evidence } = await evidenceOf(app, opened.reviewId);
    assert.ok(evidence.plans[0].assessments.length > 0, 'the fixture reviewed a plan with an assessment');

    const current = json(evidence);
    current.plans[0].assessments = [];
    const diff = reconcileReviewEvidence({ stored: evidence, current });
    assert.ok(diff.kinds.includes('withdrawn'));
    const withdrawn = diff.changes.find((c) => c.area === 'assessments' && c.kind === 'withdrawn');
    assert.ok(withdrawn);
    assert.match(withdrawn.detail, /no longer recorded/);
    assert.equal(diff.state, 'withdrawn');
  });

  test('a prediction that became invalid is superseded evidence, not a failure', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    const { evidence } = await evidenceOf(app, opened.reviewId);

    const predictionId = '11111111-1111-4111-8111-111111111111';
    const stored = json(evidence);
    stored.predictions = [{ predictionId, evaluationId: null, status: 'evaluated', verdict: 'supported', current: true }];
    const current = json(stored);
    current.predictions = [{ predictionId, evaluationId: null, status: 'invalidated', verdict: 'supported', current: false }];

    const diff = reconcileReviewEvidence({ stored, current });
    assert.ok(diff.kinds.includes('superseded'));
    assert.ok(diff.changes.some((c) => c.area === 'predictions' && c.kind === 'superseded'));
  });

  test('verification evidence that can no longer be derived is missing, not successful', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    const { evidence } = await evidenceOf(app, opened.reviewId);
    assert.ok(evidence.uses.length > 0);

    const stored = json(evidence);
    stored.uses[0].outcome.derived = true;
    const current = json(stored);
    current.uses[0].outcome.derived = false;

    const diff = reconcileReviewEvidence({ stored, current });
    assert.ok(diff.kinds.includes('missing'));
    assert.ok(diff.changes.some((c) => c.area === 'verification' && c.kind === 'missing'));
  });

  test('a truncated read marks an absent item unreadable, never withdrawn', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    const { evidence } = await evidenceOf(app, opened.reviewId);
    assert.ok(evidence.uses.length > 0);

    const current = json(evidence);
    current.bounds.truncated = true;
    current.uses.pop();
    const diff = reconcileReviewEvidence({ stored: evidence, current });
    assert.ok(diff.kinds.includes('unreadable'));
    assert.ok(!diff.kinds.includes('withdrawn'), 'truncation is not a withdrawal');
    assert.equal(diff.state, 'unreadable');
  });

  test('a rule version change stales the open review and a review of the old shape cannot be opened', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app, { order: null });
    const opened = await openReview(app, adaptation.id);
    const { evidence } = await evidenceOf(app, opened.reviewId);
    assert.equal(evidence.rule.version, null);

    assert.equal((await app.controller.adaptationGuide({ target: adaptation.id, order: 'writes_first' })).status, Outcome.SUCCESS_VERIFIED);

    // The review was opened before any evaluated use, so it is awaiting evidence rather than being
    // classified as a completed review; the reconciliation still names the rule change as stale.
    const { result } = await reconcile(app, opened.reviewId);
    assert.equal(result.reconciliation.rule.versionChanged, true);
    assert.equal(result.reconciliation.rule.hashChanged, false);
    assert.ok(result.reconciliation.kinds.includes('stale'));
    assert.equal(result.reconciliation.changed, true);
    const { detail } = await inspect(app, opened.reviewId);
    assert.equal(detail.reviewState, 'review_awaiting_evidence');
    assert.equal(detail.reviewCurrent, true);

    const refused = await app.experience.openReview({
      target: adaptation.id, evidence, reportDigest: null, origin: 'user',
    }).then(() => null, (err) => err);
    assert.equal(refused?.code, 'REVIEW_VERSION_MISMATCH',
      'a review opened on the old shape is not rewritten into a review of the new one');
  });

  test('a plan that changed after the review is reported as stale, not as an outcome', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    const goalId = await twoCriterionGoal(app);
    const prepared = await prepare(app, goalId);
    const opened = await openReview(app, adaptation.id);

    const plan = await app.plans.get(prepared.planId);
    await app.plans.revise(prepared.planId, {
      outcome: plan.outcome,
      steps: plan.steps,
      reason: 'the fixture revises the plan after the review',
    });

    // The review cannot classify an unexecuted plan as an outcome, so it stays awaiting evidence; the
    // reconciliation is where the plan change is named, and it is named as stale rather than as failure.
    const { result } = await reconcile(app, opened.reviewId);
    assert.equal(result.reconciliation.changed, true);
    assert.ok(result.reconciliation.changes.some((c) => c.area === 'plans' && c.kind === 'stale'),
      result.reconciliation.changes.map((c) => `${c.area}/${c.kind}`).join(','));
  });

  test('conflicting evidence stays conflicting through the review, and opening one changes nothing', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await conflictingUse(app, await twoCriterionGoal(app));

    const row = await rowFor(app, adaptation.id);
    assert.equal(row.classification.state, 'applied_conflicting_evidence');
    assert.equal(row.recommendation.kind, 'review');
    assert.equal(row.reviewState, 'review_recommended');
    assert.equal(row.requiresReview, true);

    const opened = await openReview(app, adaptation.id);
    const { detail } = await inspect(app, opened.reviewId);
    assert.equal(detail.reconciliation.conflict, true);
    assert.equal(detail.reconciliation.state, 'unchanged');
    assert.equal(detail.reconciliation.changed, false);
    assert.equal(detail.reviewState, 'review_opened');
    assert.equal((await app.experience.adaptationDetail(adaptation.id)).retired, false);
  });

  test('a support record that is missing is reported as missing and never as success or failure', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    const { review, evidence } = await evidenceOf(app, opened.reviewId);
    assert.ok(evidence.support.experienceIds.length > 0);

    // Simulate a store that lost one cited experience line: the record the adaptation cites is simply
    // not there any more. The reader must say "missing", not decide the adaptation worked or failed.
    const victim = evidence.support.experienceIds[0];
    const lines = experienceLines(d).filter((r) => r.id !== victim);
    fs.writeFileSync(path.join(d, 'experiences.jsonl'), `${lines.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

    const { detail } = await inspect(app, review.id);
    assert.equal(detail.reconciliation.state, 'missing');
    assert.ok(detail.reconciliation.kinds.includes('missing'));
    assert.ok(detail.reconciliation.changes.some((c) => c.area === 'support' && c.kind === 'missing'));
    assert.equal(detail.reviewState, 'review_awaiting_evidence');
    assert.notEqual(detail.reviewState, 'review_completed');
    // With its support record gone the report can no longer classify the use: the only honest
    // classification is that the support is invalid, never that the adaptation succeeded or failed.
    assert.match(detail.report.classification.state, /support_invalid/);
    assert.notEqual(detail.report.classification.state, 'applied_successful');
    assert.notEqual(detail.report.classification.state, 'applied_failed');
    assert.match(detail.note, /approves nothing/);
  });

  test('reconciliation is deterministic: two independent reads produce the same change set', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);

    const first = await reconcile(app, opened.reviewId);
    const second = await reconcile(app, opened.reviewId);
    assert.deepEqual(second.result.reconciliation, first.result.reconciliation);
    assert.equal(second.result.reviewedEvidenceDigest, first.result.reviewedEvidenceDigest);
    assert.equal(second.result.currentEvidenceDigest, first.result.currentEvidenceDigest);
    assert.equal(first.result.reconciliation.state, 'unchanged');
    assert.equal(first.result.reviewState, 'review_opened');
  });

  test('a changed digest requires a new explicit decision, not a re-decision of the old review', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);

    // A new recorded use moves the evidence after the review was opened.
    await prepare(app, await twoCriterionGoal(app));
    const { detail } = await inspect(app, opened.reviewId);
    assert.equal(detail.reviewState, 'review_evidence_changed');
    assert.equal(detail.reviewCurrent, false);

    const refused = await app.controller.adaptationReviewDecide({ review: opened.reviewId, decision: 'keep_active' });
    assert.equal(refused.status, Outcome.EXECUTION_FAILED);
    assert.match(refused.output, /evidence changed|reconcile/i);
    assert.equal((await app.experience.reviewDetail(opened.reviewId)).review.decisionCount, 0,
      'the refused decision wrote nothing');

    // The explicit path is a new review on the current evidence, and that one can be decided.
    const current = await openReview(app, adaptation.id);
    assert.notEqual(current.evidenceDigest, opened.evidenceDigest);
    await decide(app, current.reviewId, 'keep_active');
    assert.equal((await app.experience.reviewDetail(current.reviewId)).review.decisionCount, 1);
  });
});

// ================================================================================================
describe('AP-05 record identity: a review names one adaptation, one rule, and one exact bundle', () => {
  test('a review cannot be opened against another adaptation\'s evidence', async () => {
    const d = dir();
    const app = await appIn(d);
    const first = await seedRule(app);
    // Use the first rule before the second exists: the comparison then has one approved rule to read,
    // so the plan is recorded and the use names the adaptation this review is about.
    await successfulUse(app, await twoCriterionGoal(app));
    const second = await seedRule(app, { guidance: 'list the notes before rewriting one', tag: 'BB' });
    const opened = await openReview(app, first.adaptation.id);
    const { review } = await evidenceOf(app, opened.reviewId);

    const refused = await app.experience.openReview({
      target: second.adaptation.id, evidence: review.evidence, reportDigest: null, origin: 'user',
    }).then(() => null, (err) => err);
    assert.equal(refused?.code, 'REVIEW_TARGET_MISMATCH');
    const { reviews } = await app.experience.reviews({ target: second.adaptation.id });
    assert.equal(reviews.length, 0, 'no review was stored for the other adaptation');
  });

  test('the same evidence cannot be reviewed twice, and a rule swap is refused', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    const { review } = await evidenceOf(app, opened.reviewId);

    const duplicate = await app.experience.openReview({
      target: adaptation.id, evidence: review.evidence, reportDigest: null, origin: 'user',
    }).then(() => null, (err) => err);
    assert.equal(duplicate?.code, 'REVIEW_EXISTS');

    const swapped = json(review.evidence);
    swapped.rule.hash = '0'.repeat(64);
    const mismatch = await app.experience.openReview({
      target: adaptation.id, evidence: swapped, reportDigest: null, origin: 'user',
    }).then(() => null, (err) => err);
    assert.equal(mismatch?.code, 'REVIEW_RULE_MISMATCH');
    assert.equal((await app.experience.reviews({ target: adaptation.id })).reviews.length, 1);
  });

  test('a retired adaptation cannot be reviewed again', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    const { review } = await evidenceOf(app, opened.reviewId);
    assert.equal((await app.controller.adaptationRetire({ target: adaptation.id, reason: 'the user retired it outside the review' })).status, Outcome.SUCCESS_VERIFIED);

    const refused = await app.experience.openReview({
      target: adaptation.id, evidence: review.evidence, reportDigest: null, origin: 'user',
    }).then(() => null, (err) => err);
    assert.equal(refused?.code, 'REVIEW_TARGET_RETIRED');

    // The old review is history: it reconciles as changed and cannot be decided afterwards.
    const { detail } = await inspect(app, opened.reviewId);
    assert.equal(detail.reviewState, 'review_evidence_changed');
    assert.equal(detail.adaptation.retired, true);
    const candidates = data(await app.controller.planCandidates({ goal: await twoCriterionGoal(app) }));
    assert.equal(candidates.adaptationDecision.applied, false, 'a stale review cannot return a retired rule to influence');
  });

  test('a review that names an adaptation not in the store can be read as damaged history and decided by nothing', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    const { evidence } = await evidenceOf(app, opened.reviewId);

    // A stored review whose adaptation never existed is damage, not a new adaptation. It is appended
    // with a valid shape so the reader, not the writer, has to state what it can and cannot resolve.
    const orphanTarget = randomUUID();
    const orphan = json(evidence);
    orphan.targetId = orphanTarget;
    const orphanRecord = reviewRecord({ targetId: orphanTarget, evidence: orphan, createdAt: '2026-11-06T10:00:00.000Z' });
    appendRecord(d, orphanRecord);

    const refused = await app.controller.adaptationReviewDecide({ review: orphanRecord.id, decision: 'keep_active' });
    assert.equal(refused.status, Outcome.EXECUTION_FAILED);
    assert.match(refused.output, /not in the store/i);
    const health = await app.experience.health();
    assert.equal(health.reviews, 2, 'both records are still read as history');
  });

  test('a decided review cannot be decided a second time', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    await decide(app, opened.reviewId, 'keep_active');

    const again = await app.controller.adaptationReviewDecide({ review: opened.reviewId, decision: 'retire' });
    assert.equal(again.status, Outcome.EXECUTION_FAILED);
    assert.match(again.output, /already records a decision/i);
    assert.equal((await app.experience.adaptationDetail(adaptation.id)).retired, false);
    assert.equal(experienceLines(d).filter((r) => r.kind === 'adaptation_review_decision').length, 1);
  });

  test('a decision cites the exact evidence it was made on, and the evidence as it stood', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    const decided = await decide(app, opened.reviewId, 'keep_active');

    assert.equal(decided.reviewedEvidenceDigest, opened.evidenceDigest);
    assert.equal(decided.currentEvidenceDigest, opened.evidenceDigest);
    const { review } = await app.experience.reviewDetail(opened.reviewId);
    assert.equal(review.decision.reviewedEvidenceDigest, opened.evidenceDigest);
    assert.equal(review.decision.currentEvidenceDigest, opened.evidenceDigest);
    assert.equal(review.decision.reportDigest, opened.reportDigest);
  });

  test('the review vocabulary is closed: nine reader states and three decisions', async () => {
    assert.deepEqual([...REVIEW_STATES].sort(), [
      'no_review_required', 'review_awaiting_evidence', 'review_completed', 'review_decision_superseded',
      'review_dismissed', 'review_evidence_changed', 'review_opened', 'review_recommended', 'review_unavailable',
    ].sort());
    assert.deepEqual([...REVIEW_DECISIONS], ['keep_active', 'dismiss', 'retire']);
    assert.equal(classifyReviewState({ recommendation: 'none' }).state, 'no_review_required');
    assert.equal(classifyReviewState({ recommendation: 'review' }).state, 'review_recommended');
    assert.equal(classifyReviewState({ recommendation: 'consider_retirement' }).state, 'review_recommended');
    const unavailable = classifyReviewState({ unavailable: 'the plan store is not available in this configuration' });
    assert.equal(unavailable.state, 'review_unavailable');
    assert.match(unavailable.why, /plan store/);
  });
});

// ================================================================================================
describe('AP-05 authority: model output proposes nothing here, and a read executes nothing', () => {
  test('a model cannot open a review, keep, dismiss, or retire', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    const before = experienceLines(d).length;

    for (const [name, input] of [
      ['adaptation.review.open', { target: adaptation.id }],
      ['adaptation.review.decide', { review: opened.reviewId, decision: 'keep_active' }],
      ['adaptation.review.decide', { review: opened.reviewId, decision: 'retire' }],
    ]) {
      const step = await app.controller.runAction(name, input, 'model', `op-model-${name}-${input.decision ?? 'open'}`);
      assert.equal(step.outcome, Outcome.ACTION_DENIED, `${name} must be denied to model output`);
      assert.equal(step.authorization.decision, 'deny');
      assert.equal(step.execution.status, 'not_run', 'a denied request never reaches the store');
      assert.equal(app.registry.get(name).plannable, false, `${name} cannot appear in a model plan`);
    }
    assert.equal(experienceLines(d).length, before, 'nothing was appended by any refused request');
    assert.equal((await app.experience.reviewDetail(opened.reviewId)).review.decisionCount, 0);
  });

  test('the stores refuse a model origin a second time, independently of the registry', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);

    const open = await app.experience.openReview({
      target: adaptation.id, evidence: {}, reportDigest: null, origin: 'model',
    }).then(() => null, (err) => err);
    assert.equal(open?.code, 'WRITE_REQUIRES_USER_ORIGIN');
    const decide = await app.experience.recordReviewDecision({
      review: opened.reviewId, decision: 'retire', evidence: {}, reportDigest: null, origin: 'model',
    }).then(() => null, (err) => err);
    assert.equal(decide?.code, 'WRITE_REQUIRES_USER_ORIGIN');
    assert.equal((await app.experience.adaptationDetail(adaptation.id)).retired, false);
  });

  test('reading the report and reconciling a review writes no evidence, plan, goal, or memory record', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);

    const files = ['experiences.jsonl', 'plans.jsonl', 'goals.jsonl', 'memory.jsonl', 'predictions.jsonl'];
    const before = new Map(files.map((f) => {
      const file = path.join(d, f);
      return [f, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''];
    }));

    const { res: reportRes, report } = await governance(app);
    const { res: inspectRes, detail } = await inspect(app, opened.reviewId);
    const { res: reconcileRes, result } = await reconcile(app, opened.reviewId);

    assert.equal(report.authorizes, false);
    assert.equal(detail.authorizes, false);
    assert.match(GOVERNANCE_NOTE, /approves nothing/);
    assert.match(display(reportRes), /not a decision|authorizes nothing|approves nothing/);
    assert.match(display(reconcileRes), /nothing was approved|No adaptation, rule, or plan was changed/i);
    assert.equal(result.available, true);
    assert.equal(inspectRes.status, Outcome.SUCCESS_VERIFIED);

    for (const f of files) {
      const file = path.join(d, f);
      const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      assert.equal(after, before.get(f), `a read wrote ${f}`);
    }
  });
});

// ================================================================================================
describe('AP-05 coordination and durability: one review, one decision, one honest failure', () => {
  test('two opens of the same evidence in one instant store exactly one review', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));

    const [a, b] = await Promise.all([
      app.controller.adaptationReviewOpen({ target: adaptation.id }),
      app.controller.adaptationReviewOpen({ target: adaptation.id }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [Outcome.SUCCESS_VERIFIED, Outcome.EXECUTION_FAILED].sort());
    const failed = a.status === Outcome.EXECUTION_FAILED ? a : b;
    assert.match(failed.output, /already has a current review/i);
    assert.equal((await app.experience.reviews({ target: adaptation.id })).reviews.length, 1);
  });

  test('opening and retiring concurrently leaves one retirement and no half-recorded decision', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));

    const [opened, retired] = await Promise.all([
      app.controller.adaptationReviewOpen({ target: adaptation.id }),
      app.controller.adaptationRetire({ target: adaptation.id, reason: 'the user retired while the review was opening' }),
    ]);
    assert.equal(retired.status, Outcome.SUCCESS_VERIFIED);
    assert.ok([Outcome.SUCCESS_VERIFIED, Outcome.EXECUTION_FAILED].includes(opened.status));

    const records = experienceLines(d);
    assert.equal(records.filter((r) => r.kind === 'adaptation_retirement').length, 1);
    assert.equal(records.filter((r) => r.kind === 'adaptation_review_decision').length, 0);
    assert.ok(records.filter((r) => r.kind === 'adaptation_review').length <= 1);
    const detail = await app.experience.adaptationDetail(adaptation.id);
    assert.equal(detail.retired, true);
    assert.equal(detail.decisionState, 'retired');
    const active = await app.experience.activeAdaptations({ capability: adaptation.capability, limit: 10 });
    assert.ok(!active.adaptations.some((a) => a.id === adaptation.id));
  });

  test('reconciling while deciding records one decision and no contradiction', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);

    const [reconciled, decided] = await Promise.all([
      app.controller.adaptationReviewReconcile({ target: opened.reviewId }),
      app.controller.adaptationReviewDecide({ review: opened.reviewId, decision: 'keep_active' }),
    ]);
    assert.equal(reconciled.status, Outcome.SUCCESS_VERIFIED, reconciled.output);
    assert.equal(decided.status, Outcome.SUCCESS_VERIFIED, decided.output);
    assert.equal((await app.experience.reviewDetail(opened.reviewId)).review.decisionCount, 1);
    assert.equal(experienceLines(d).filter((r) => r.kind === 'adaptation_review_decision').length, 1);
    assert.equal((await app.experience.adaptationDetail(adaptation.id)).retired, false);
  });

  test('a recorded decision survives a restart and is read from the log, not from memory', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    await decide(app, opened.reviewId, 'dismiss', 'not convinced');

    const restarted = await appIn(d);
    const { detail } = await inspect(restarted, opened.reviewId);
    assert.equal(detail.reviewState, 'review_dismissed');
    assert.equal(detail.review.decision.decision, 'dismiss');
    assert.equal(detail.review.decision.reason, 'not convinced');
    assert.equal(detail.review.evidenceDigest, opened.evidenceDigest);

    const row = await rowFor(restarted, adaptation.id);
    assert.equal(row.reviewState, 'review_dismissed');
    assert.equal(row.reviewCurrent, true);
    assert.equal((await restarted.experience.adaptationDetail(adaptation.id)).active, true);
  });

  test('an audit-append failure is disclosed, and the store decision it already made is not erased', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);

    const original = app.operations.append.bind(app.operations);
    app.operations.append = async () => { throw new StoreError('injected: the audit log refused adaptation.review.decide'); };
    let res;
    try {
      res = await app.controller.adaptationReviewDecide({ review: opened.reviewId, decision: 'keep_active' });
    } finally {
      app.operations.append = original;
    }
    assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.equal(res.recorded, false);
    assert.match(String(res.recordError), /injected: the audit log refused/);
    assert.match(res.output, /may have been recorded.*not reported as verified success/i);
    assert.deepEqual(res.operation.errors.map((e) => e.code), ['AUDIT_WRITE_FAILED']);

    // The decision record itself was written before the audit append failed, and it is still read back:
    // the failure is disclosed rather than hidden by undoing the user's decision.
    const { review } = await app.experience.reviewDetail(opened.reviewId);
    assert.equal(review.decisionCount, 1);
    assert.equal(review.decision.decision, 'keep_active');
    assert.equal((await app.experience.adaptationDetail(adaptation.id)).retired, false);
  });
});

// ================================================================================================
describe('AP-05 damaged or unavailable storage: an unreadable store is not an empty one', () => {
  test('a damaged experience store fails the governance reads instead of inventing a review state', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    fs.appendFileSync(path.join(d, 'experiences.jsonl'), '{not a review record\n', 'utf8');

    const listed = await app.controller.adaptationReviews({});
    assert.equal(listed.status, Outcome.EXECUTION_FAILED);
    assert.match(listed.output, /corrupt|incomplete/i);
    assert.equal(data(listed).report, undefined, 'no report is fabricated from damaged storage');

    const inspected = await app.controller.adaptationReviewInspect({ target: opened.reviewId });
    assert.equal(inspected.status, Outcome.EXECUTION_FAILED);
    assert.equal(data(inspected).detail, undefined);

    const reconciled = await app.controller.adaptationReviewReconcile({ target: opened.reviewId });
    assert.equal(reconciled.status, Outcome.EXECUTION_FAILED);
    assert.equal(data(reconciled).reconciliation, undefined);
  });

  test('a damaged plan store fails the review read instead of reporting the evidence unchanged', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);
    fs.appendFileSync(path.join(d, 'plans.jsonl'), '{not a plan event\n', 'utf8');

    const inspected = await app.controller.adaptationReviewInspect({ target: opened.reviewId });
    assert.equal(inspected.status, Outcome.EXECUTION_FAILED);
    assert.match(inspected.output, /corrupt|incomplete/i);
    assert.equal(data(inspected).detail, undefined);

    const reconciled = await app.controller.adaptationReviewReconcile({ target: opened.reviewId });
    assert.equal(reconciled.status, Outcome.EXECUTION_FAILED);
    assert.equal(data(reconciled).reconciliation, undefined);
  });

  test('a missing plan store makes the evidence unavailable rather than empty', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));

    const prepared = await prepareReview({
      experience: app.experience,
      plans: null,
      operations: app.operations,
      goals: app.goals,
      knowledge: app.knowledge,
      memory: app.memory,
      predictions: app.predictions,
      now: () => new Date('2026-11-06T09:00:00.000Z'),
      target: adaptation.id,
    });
    assert.equal(prepared.evidence, null, 'no bundle is fabricated from a missing store');
    assert.equal(prepared.report.available, false);
    assert.match(prepared.report.reason, /plan store is not available/i);

    // A reader assembled against the same configuration reports the review unavailable, never an
    // empty bundle that would make a missing store look like settled evidence.
    const detail = await governanceDetail({
      experience: app.experience,
      plans: null,
      operations: app.operations,
      goals: app.goals,
      knowledge: app.knowledge,
      memory: app.memory,
      predictions: app.predictions,
      now: () => new Date('2026-11-06T09:00:00.000Z'),
      target: adaptation.id,
    });
    assert.equal(detail.available, true);
    assert.equal(detail.reviewState, 'review_unavailable');
    assert.match(detail.unavailable, /plan store is not available/i);
    assert.equal(detail.reconciliation, null, 'no change set is derived from evidence that was never read');
    assert.equal((await app.experience.reviews({ target: adaptation.id })).reviews.length, 0,
      'a read reports the gap and opens nothing');
  });
});

// ================================================================================================
describe('AP-05 end to end: report, open, inspect, reconcile, decide, audit, fresh report', () => {
  test('keep_active on a recommended review is traceable end to end and leaves the rule in force', async () => {
    const d = dir();
    const app = await appIn(d);
    const adaptation = await repeatedFailure(app);

    // 1. The report recommends a review. The recommendation is a sentence, not a decision.
    const initial = await governance(app);
    const initialRow = initial.report.adaptations.find((r) => r.id === adaptation.id);
    assert.equal(initialRow.recommendation.kind, 'consider_retirement');
    assert.equal(initialRow.reviewState, 'review_recommended');
    assert.equal(initial.report.totals.requiringReview, 1);
    assert.equal(initial.report.authorizes, false);
    assert.equal((await app.experience.adaptationDetail(adaptation.id)).retired, false,
      'the recommendation retired nothing');

    // 2. Opening the review records exactly the evidence the report read.
    const opened = await openReview(app, adaptation.id, 'the report asked me to look');
    assert.equal(opened.recommendation, 'consider_retirement');
    assert.equal(opened.awaitingEvidence, false);

    // 3. Inspect: the open review cites its own bundle and no decision is attached.
    const { detail } = await inspect(app, opened.reviewId);
    assert.equal(detail.reviewState, 'review_opened');
    assert.equal(detail.review.evidenceDigest, opened.evidenceDigest);
    assert.equal(detail.review.decision, null);
    assert.equal(detail.history.length, 1);
    assert.equal(detail.history[0].id, opened.reviewId);

    // 4. Reconcile: nothing moved between the report and the review.
    const { result } = await reconcile(app, opened.reviewId);
    assert.equal(result.reviewedEvidenceDigest, result.currentEvidenceDigest);
    assert.equal(result.reconciliation.state, 'unchanged');
    assert.equal(result.reconciliation.changed, false);
    assert.equal(result.reportChanged, false);

    // 5. Keep it active: the user's decision, recorded against the reviewed evidence.
    const decided = await decide(app, opened.reviewId, 'keep_active', 'still how I work');
    assert.equal(decided.decision, 'keep_active');
    assert.equal(decided.retirementId, null);
    assert.equal(decided.reviewedEvidenceDigest, opened.evidenceDigest);

    // 6. Audit verification: the decision has its own verified operation and one store record.
    const audit = (await app.operations.inspect()).records.find((r) => r.steps?.some((s) => s.action === 'adaptation.review.decide'));
    assert.ok(audit, 'the decision operation was audited');
    assert.equal(audit.capability, 'adaptation.review.keep');
    assert.equal(audit.status, Outcome.SUCCESS_VERIFIED);
    const step = audit.steps.find((s) => s.action === 'adaptation.review.decide');
    assert.equal(step.result.data.decision, 'keep_active');
    assert.equal(step.result.data.reviewId, opened.reviewId);
    assert.equal(experienceLines(d).filter((r) => r.kind === 'adaptation_review_decision').length, 1);
    assert.equal(experienceLines(d).filter((r) => r.kind === 'adaptation_review').length, 1);

    // 7. A fresh report reads the recorded decision as a completed review, not as a new recommendation.
    const fresh = await governance(app);
    const freshRow = fresh.report.adaptations.find((r) => r.id === adaptation.id);
    assert.equal(freshRow.reviewState, 'review_completed');
    assert.equal(freshRow.reviewCurrent, true);
    assert.equal(freshRow.review.decision.decision, 'keep_active');
    assert.equal(freshRow.review.evidenceDigest, opened.evidenceDigest);
    assert.equal(fresh.report.totals.states.review_completed, 1);
    assert.equal(fresh.report.authorizes, false);

    // 8. The lifecycle and the guidance are unchanged: the rule is still approved, active, and leading.
    const adaptationState = await app.experience.adaptationDetail(adaptation.id);
    assert.equal(adaptationState.decisionState, 'approved');
    assert.equal(adaptationState.active, true);
    assert.equal(adaptationState.retired, false);
    assert.equal(adaptationState.retirement, null);
    const nextGoal = await twoCriterionGoal(app);
    const candidates = data(await app.controller.planCandidates({ goal: nextGoal }));
    assert.equal(candidates.adaptationDecision.applied, true);
    assert.equal(candidates.adaptationDecision.after.leading, 'read_before_write');
  });

  test('retire through the review is traceable end to end and the rule stops shaping decisions', async () => {
    const d = dir();
    const app = await appIn(d);
    const { adaptation } = await seedRule(app);
    await successfulUse(app, await twoCriterionGoal(app));
    const opened = await openReview(app, adaptation.id);

    const decided = await decide(app, opened.reviewId, 'retire', 'the recorded failures are enough for me');
    assert.match(decided.retirementId, /^[0-9a-f-]{36}$/);

    const audit = (await app.operations.inspect()).records.find((r) => r.steps?.some((s) => s.action === 'adaptation.review.decide'));
    assert.equal(audit.capability, 'adaptation.review.retire');
    assert.equal(audit.status, Outcome.SUCCESS_VERIFIED);
    const step = audit.steps.find((s) => s.action === 'adaptation.review.decide');
    assert.equal(step.result.data.decision, 'retire');
    assert.equal(step.result.data.retirementId, decided.retirementId);

    const records = experienceLines(d);
    assert.equal(records.filter((r) => r.kind === 'adaptation_retirement').length, 1);
    assert.equal(records.filter((r) => r.kind === 'adaptation_review_decision').length, 1);
    assert.equal(records.find((r) => r.kind === 'adaptation_review_decision').retirementId, decided.retirementId);

    const fresh = await governance(app);
    const row = fresh.report.adaptations.find((r) => r.id === adaptation.id);
    assert.equal(row.retired, true);
    assert.equal(row.active, false);
    assert.equal(row.reviewState, 'review_completed');
    assert.equal(row.review.decision.decision, 'retire');

    const candidates = data(await app.controller.planCandidates({ goal: await twoCriterionGoal(app) }));
    assert.equal(candidates.adaptationDecision.applied, false);
    const active = await app.experience.activeAdaptations({ capability: adaptation.capability, limit: 10 });
    assert.ok(!active.adaptations.some((a) => a.id === adaptation.id));
  });
});
