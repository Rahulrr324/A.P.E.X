// Batch AL, work packages C and E at the plan layer: candidate plans and outcome assessments.
//
// Two rules are tested here and nowhere else, because they belong to the plan record itself:
//   1. Several candidate drafts may exist for one goal - comparing approaches is the point - but
//      only one plan per goal may be *live* (approved, active, or blocked), because two authorized
//      intentions for one goal cannot both decide what happens next.
//   2. An outcome assessment is a record *about* a plan. It is bound to the version and the exact
//      bytes it assessed, it never changes those bytes, and every finding must cite an audit
//      operation that exists. That a plan ran is not the same as that it worked.
//
// Everything runs through the real app, the real plan store, the live action registry and the real
// audit log. The only test doubles are a deterministic clock and a store constructed without an
// audit reader, both labelled where they are used. No model service is contacted; no inference is
// performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { PlanStore } from '../src/plans/store.js';
import { stableStringify } from '../src/tasks/model.js';
import { renderPlan } from '../src/plans/format.js';
import { comparePlanVersions } from '../src/plans/history.js';
import {
  PLAN_SCHEMA,
  PlanStatus,
  MAX_CANDIDATES_PER_GOAL,
  MAX_FINDINGS,
  MAX_CITED_IDS,
  MAX_ASSESSMENT_SUMMARY_CHARS,
  REVERSIBILITY_LEVELS,
  ASSESSMENT_ASPECTS,
  ASSESSMENT_VERDICTS,
  isLivePlan,
  plansForGoal,
  planContent,
  planContentHash,
  reduceEvents,
  validateEventShape,
  assessmentProblems,
} from '../src/plans/model.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const OUTCOME = 'the plan candidate test facts are stored';

async function appIn(dir) {
  return createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF });
}

function dataOf(res) {
  return res.operation.steps[0].result.data;
}

async function newGoal(app, request = 'the plan candidate test goal') {
  const res = await app.controller.goalAdd({ request, criteria: ['the recorded fact is stored'] });
  assert.equal(res.status, Outcome.GOAL_CREATED, `goal add failed: ${res.output}`);
  return { goalId: dataOf(res).goalId, operationId: res.operation.id };
}

// memory.add is a registered, plannable write; calc.evaluate is a registered, plannable read.
// Neither is invented for this suite: both are capabilities the shipped registry already offers.
function writeStep(id, tag = id) {
  return {
    id,
    description: `remember the ${tag} fact`,
    action: 'memory.add',
    input: { content: `the plan candidate test fact ${tag}` },
    dependsOn: [],
    expectedResult: `the ${tag} fact is stored`,
    verification: 'the stored record is read back and matches',
    criterion: null,
    risk: 'medium',
    estimateSeconds: 2,
  };
}

function readStep(id) {
  return {
    id,
    description: `compute the ${id} figure`,
    action: 'calc.evaluate',
    input: { expression: '(2+3)*4' },
    dependsOn: [],
    expectedResult: 'the figure is produced',
    verification: 'an independent evaluation agrees with the value',
    criterion: null,
    risk: 'low',
    estimateSeconds: 1,
  };
}

async function addDraft(app, { goalId, steps = [writeStep('s1')], tag = 'a' } = {}) {
  const res = await app.controller.planAdd({ goalId, outcome: `${OUTCOME} (${tag})`, steps });
  assert.equal(res.status, Outcome.PLAN_STORED, `plan add failed: ${res.output}`);
  return dataOf(res).planId;
}

// Records a plan, approves it and runs it through the existing task runner, so the plan that comes
// back carries a real activation and step outcomes that cite real audit operations.
async function runPlan(app, { goalId, steps = [writeStep('s1')] } = {}) {
  const planId = await addDraft(app, { goalId, steps, tag: 'run' });
  const ok = await app.controller.planApprove({ target: planId });
  assert.equal(ok.status, Outcome.PLAN_STORED, ok.output);
  const run = await app.controller.planActivate(planId, { mode: 'run' });
  assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.display);
  return app.plans.get(planId);
}

// [aspect, statement, operation ids, record ids] -> one finding, so the shape is written once.
function findings(...rows) {
  return rows.map(([aspect, statement, operations, records]) => ({
    aspect,
    statement,
    operations: [...operations],
    ...(records?.length ? { records: [...records] } : {}),
  }));
}

function linesOf(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

// A plan store over its own file, wired to the app's live registry, goal store and audit log, on a
// deterministic clock. Used where a test needs an activation and a revision in the same plan without
// running a task; no task is created and nothing executes.
function sideStore(dir, name, app) {
  let t = Date.parse('2026-03-03T03:03:03.000Z');
  return new PlanStore(path.join(dir, name), {
    now: () => new Date((t += 1000)),
    registry: app.registry,
    goals: app.goals,
    operations: app.operations,
  });
}

test('candidate drafts for one goal are bounded, and the bound is reported as it is enforced', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId } = await newGoal(app);
    const ids = [];
    for (let i = 0; i < MAX_CANDIDATES_PER_GOAL; i += 1) {
      const { plan, candidates } = await app.plans.createPlan({
        goalId,
        outcome: `${OUTCOME} (approach ${i + 1})`,
        steps: [writeStep('s1', `approach${i + 1}`)],
      });
      ids.push(plan.id);
      assert.equal(plan.status, PlanStatus.DRAFT, 'a candidate is a draft: recording it authorizes nothing');
      assert.equal(candidates.maxDrafts, MAX_CANDIDATES_PER_GOAL);
      assert.equal(candidates.drafts.length, i + 1);
      assert.equal(candidates.draftsRemaining, MAX_CANDIDATES_PER_GOAL - i - 1);
      assert.deepEqual(candidates.live, [], 'no candidate is live until the user approves one');
    }
    await assert.rejects(
      () => app.plans.createPlan({ goalId, outcome: `${OUTCOME} (approach 4)`, steps: [writeStep('s1', 'approach4')] }),
      /already holds 3 candidate drafts/,
    );
    const state = await app.plans.candidateState(goalId);
    assert.deepEqual(state.drafts.slice().sort(), ids.slice().sort());
    assert.equal(state.draftsRemaining, 0);
    assert.equal((await app.plans.list()).length, MAX_CANDIDATES_PER_GOAL, 'the refused candidate stored nothing');
  } finally {
    cleanup(dir);
  }
});

test("a plan that names no goal is nobody's candidate, so the draft bound counts only goal-bound plans", async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    for (let i = 0; i < MAX_CANDIDATES_PER_GOAL + 1; i += 1) {
      const { plan } = await app.plans.createPlan({
        goalId: null,
        outcome: `${OUTCOME} (unbound ${i + 1})`,
        steps: [writeStep('s1', `unbound${i + 1}`)],
      });
      assert.equal(plan.goalId, null);
    }
    const state = await app.plans.candidateState(null);
    assert.equal(state.goalId, null);
    assert.equal(state.drafts.length, 0, 'an unbound plan is not held as a candidate of any goal');
    assert.equal(state.draftsRemaining, MAX_CANDIDATES_PER_GOAL);
  } finally {
    cleanup(dir);
  }
});

test('approving a draft frees its candidate slot but not the goal\'s single live slot', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId } = await newGoal(app);
    const a = await addDraft(app, { goalId, steps: [writeStep('s1', 'a')], tag: 'a' });
    const b = await addDraft(app, { goalId, steps: [writeStep('s1', 'b')], tag: 'b' });
    await addDraft(app, { goalId, steps: [writeStep('s1', 'c')], tag: 'c' });
    assert.equal((await app.plans.candidateState(goalId)).draftsRemaining, 0);

    await app.plans.approve(a);
    const afterApprove = await app.plans.candidateState(goalId);
    assert.deepEqual(afterApprove.live.map((p) => p.id), [a]);
    assert.equal(afterApprove.live[0].status, PlanStatus.APPROVED);
    assert.equal(afterApprove.drafts.length, 2, 'an approved plan is no longer one of the candidate drafts');

    // Room for one more alternative, because drafts are what the bound counts.
    const d = await addDraft(app, { goalId, steps: [writeStep('s1', 'd')], tag: 'd' });
    assert.ok(d);
    assert.equal((await app.plans.candidateState(goalId)).drafts.length, 3);

    // A second authorized plan for the same goal is refused, and says what holds the slot.
    await assert.rejects(() => app.plans.approve(b), (err) => {
      assert.equal(err.code, 'ILLEGAL_TRANSITION');
      assert.match(err.message, /already has a live plan/);
      assert.match(err.message, /is approved/);
      return true;
    });
    assert.equal((await app.plans.get(b)).status, PlanStatus.DRAFT, 'the refused approval stored nothing');
    assert.equal((await app.plans.get(a)).status, PlanStatus.APPROVED);
    assert.equal((await app.plans.candidateState(goalId)).live.length, 1);
    await app.plans.setStatus(d, PlanStatus.CANCELLED, { reason: 'not needed by this test' });
    assert.equal((await app.plans.candidateState(goalId)).drafts.length, 2, 'a cancelled draft stops holding a slot');
  } finally {
    cleanup(dir);
  }
});

test('the honest replanning sequence is supersede-then-approve: the old plan and its history survive', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId } = await newGoal(app);
    const first = await addDraft(app, { goalId, steps: [writeStep('s1', 'first')], tag: 'first' });
    const second = await addDraft(app, { goalId, steps: [writeStep('s1', 'second')], tag: 'second' });
    await app.plans.approve(first);
    await assert.rejects(() => app.plans.approve(second), /already has a live plan/);

    // Switching approaches is an explicit user act on the old plan, then an approval of the new one.
    const { plan: superseded } = await app.plans.setStatus(first, PlanStatus.SUPERSEDED, {
      reason: 'the second approach fits the current evidence better',
      by: second,
    });
    assert.equal(superseded.status, PlanStatus.SUPERSEDED);
    assert.equal(superseded.supersededBy, second);
    assert.equal(superseded.approval.version, 1, 'the earlier approval stays on record');

    const { plan: approved } = await app.plans.approve(second);
    assert.equal(approved.status, PlanStatus.APPROVED);
    assert.deepEqual((await app.plans.candidateState(goalId)).live.map((p) => p.id), [second]);
    assert.equal((await app.plans.list()).length, 2, 'replanning never erases the plan it replaced');
    assert.deepEqual(
      (await app.plans.get(first)).history.map((h) => h.kind),
      ['created', 'approved', 'status:superseded'],
    );
  } finally {
    cleanup(dir);
  }
});

test('replay enforces the live-plan bound: a hand-written second approval is refused, not applied', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId } = await newGoal(app);
    const store = sideStore(dir, 'crafted.jsonl', app);
    const a = await store.createPlan({ goalId, outcome: `${OUTCOME} (crafted a)`, steps: [writeStep('s1', 'ca')] });
    const b = await store.createPlan({ goalId, outcome: `${OUTCOME} (crafted b)`, steps: [writeStep('s1', 'cb')] });
    await store.approve(a.plan.id);

    // Retarget that very approval event at the other draft, with that plan's own bytes. It is a
    // well-formed approval in isolation; what makes it illegal is that the goal already has one.
    const records = linesOf(store.filePath);
    const approval = records[records.length - 1];
    assert.equal(approval.type, 'plan_approved');
    const forged = {
      ...approval,
      eventId: 'forged-second-approval',
      planId: b.plan.id,
      contentHash: planContentHash(b.plan),
      validation: store.validatePlan(b.plan),
    };
    assert.equal(validateEventShape(forged), null, 'the forged event is well-formed; only the bound forbids it');
    fs.appendFileSync(store.filePath, `${JSON.stringify(forged)}\n`);

    const { plans, problems } = reduceEvents(linesOf(store.filePath));
    assert.equal(problems.length, 1);
    assert.equal(problems[0].eventId, 'forged-second-approval');
    assert.match(problems[0].reason, /already has a live plan/);
    assert.equal(plans.get(b.plan.id).status, PlanStatus.DRAFT, 'the forged approval applies to nothing');
    await assert.rejects(() => store.load(), /cannot be applied|refusing incomplete/);
  } finally {
    cleanup(dir);
  }
});

test('a plan with no candidate metadata hashes exactly as it did before those fields existed', () => {
  const created = {
    schema: PLAN_SCHEMA,
    eventId: 'pre-al-1',
    type: 'plan_created',
    planId: '11111111-2222-3333-4444-555555555555',
    at: '2026-01-01T00:00:00.000Z',
    origin: 'user',
    goalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    goalRevision: 2,
    version: 1,
    reason: 'written before Batch AL',
    outcome: 'the pre-AL outcome',
    steps: [{
      id: 's1',
      description: 'remember the pre-AL fact',
      action: 'memory.add',
      input: { content: 'pre-AL' },
      dependsOn: [],
      expectedResult: 'the fact is stored',
      verification: 'the record reads back',
      criterionId: 'c1',
      risk: 'medium',
      estimate: { seconds: 5 },
    }],
    preconditions: ['the store is writable'],
    assertions: [{ kind: 'user_fact', text: 'the user asked for this', ref: null }],
    resources: { estimatedSeconds: 5 },
  };
  const { plans, problems } = reduceEvents([created]);
  assert.deepEqual(problems, []);
  const plan = plans.get(created.planId);

  // The step the plan holds is the one written before reversibility and recovery existed: neither
  // key appears when it was not recorded, so no older plan gained a field it never named.
  assert.deepEqual(plan.steps[0], created.steps[0]);
  const preAlContent = {
    goalId: created.goalId,
    goalRevision: created.goalRevision,
    outcome: created.outcome,
    steps: [created.steps[0]],
    preconditions: created.preconditions,
    assertions: created.assertions,
    resources: created.resources,
  };
  assert.equal(stableStringify(planContent(plan)), stableStringify(preAlContent));
  assert.equal(
    planContentHash(plan),
    createHash('sha256').update(stableStringify(preAlContent)).digest('hex'),
    'an approval given before Batch AL still matches these bytes',
  );

  // Key order is irrelevant to the bytes, and a recorded candidate field is not: the hash moves, so
  // an approval given for the older steps cannot cover the new claim.
  const reordered = {
    ...created,
    eventId: 'pre-al-2',
    steps: [{
      risk: 'medium', estimate: { seconds: 5 }, criterionId: 'c1', verification: 'the record reads back',
      expectedResult: 'the fact is stored', dependsOn: [], input: { content: 'pre-AL' },
      action: 'memory.add', description: 'remember the pre-AL fact', id: 's1',
    }],
  };
  assert.equal(planContentHash(reduceEvents([reordered]).plans.get(reordered.planId)), planContentHash(plan));
  const withReversibility = {
    ...created,
    eventId: 'pre-al-3',
    steps: [{ ...created.steps[0], reversibility: 'reversible', recovery: 'correct the record with memory.correct' }],
  };
  const declared = reduceEvents([withReversibility]).plans.get(withReversibility.planId);
  assert.notEqual(planContentHash(declared), planContentHash(plan));
  assert.equal(
    planContentHash(declared),
    createHash('sha256').update(stableStringify({ ...preAlContent, steps: [withReversibility.steps[0]] })).digest('hex'),
  );
});

test('reversibility is grounded in the registry: a write is not read_only and a read is not irreversible', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId } = await newGoal(app);
    const store = app.plans;

    const misgrounded = await store.createPlan({
      goalId,
      outcome: `${OUTCOME} (misgrounded)`,
      steps: [
        { ...writeStep('s1', 'ro'), reversibility: 'read_only' },
        { ...readStep('s2'), reversibility: 'not_reversible' },
      ],
    });
    const report = store.validatePlan(misgrounded.plan);
    assert.equal(report.ok, false);
    assert.deepEqual(report.problems, [
      'step s1: memory.add is a write, so the step cannot be recorded as read_only',
      'step s2: calc.evaluate changes no record, so the step cannot be recorded as not_reversible',
    ], JSON.stringify(report.problems));
    await assert.rejects(() => store.approve(misgrounded.plan.id), (err) => {
      assert.equal(err.code, 'PLAN_INVALID');
      assert.match(err.message, /cannot be recorded as read_only/);
      return true;
    });

    // `unknown` and `reversible` stand on either class: APEX may genuinely not know how far a step
    // can be undone, and a record it wrote can be corrected.
    const honest = await store.createPlan({
      goalId,
      outcome: `${OUTCOME} (honest)`,
      steps: [
        { ...writeStep('s1', 'h1'), reversibility: 'reversible' },
        { ...readStep('s2'), reversibility: 'read_only' },
        { ...writeStep('s3', 'h3'), reversibility: 'unknown', risk: 'high' },
        { ...readStep('s4'), reversibility: 'reversible' },
      ],
    });
    const honestReport = store.validatePlan(honest.plan);
    assert.equal(honestReport.ok, true, JSON.stringify(honestReport.problems));
    assert.deepEqual(REVERSIBILITY_LEVELS, ['read_only', 'reversible', 'not_reversible', 'unknown']);
  } finally {
    cleanup(dir);
  }
});

test('reversibility and recovery are recorded, disclosed in the plan, and visible in a version diff', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId } = await newGoal(app);
    const planId = await addDraft(app, {
      goalId,
      tag: 'disclosed',
      steps: [{
        ...writeStep('s1', 'rev'),
        reversibility: 'reversible',
        recovery: 'correct the record with memory.correct and re-check it',
      }],
    });
    const shown = await app.controller.showPlan(planId);
    assert.match(shown.display, /reversibility: reversible/);
    assert.match(shown.display, /if it fails: correct the record with memory\.correct/);
    assert.equal(shown.plan.steps[0].reversibility, 'reversible');
    assert.equal(shown.plan.steps[0].recovery, 'correct the record with memory.correct and re-check it');

    const before = await app.plans.history(planId);
    const hashBefore = planContentHash(before.plan);
    const revised = await app.controller.planRevise({
      target: planId,
      outcome: `${OUTCOME} (disclosed)`,
      steps: [{ ...writeStep('s1', 'rev'), reversibility: 'not_reversible', recovery: 'nothing undoes it; escalate to the user' }],
      reason: 'the approach writes a record that cannot be taken back',
    });
    assert.equal(revised.status, Outcome.PLAN_STORED, revised.output);
    const after = await app.plans.history(planId);
    assert.equal(after.plan.version, 2);
    assert.equal(after.plan.approval, null, 'the new claim is not covered by an older approval');
    assert.notEqual(planContentHash(after.plan), hashBefore);

    const diff = comparePlanVersions(before.versions[0].snapshot, after.versions[1].snapshot);
    const modified = diff.steps.modified.find((m) => m.id === 's1');
    assert.ok(modified, JSON.stringify(diff));
    assert.deepEqual(
      modified.fields.find((f) => f.field === 'reversibility'),
      { field: 'reversibility', from: 'reversible', to: 'not_reversible' },
    );
    assert.ok(
      modified.fields.some((f) => f.field === 'recovery' && f.to === 'nothing undoes it; escalate to the user'),
      JSON.stringify(modified.fields),
    );
    assert.match(renderPlan(after.plan), /if it fails: nothing undoes it/);
  } finally {
    cleanup(dir);
  }
});

test('a malformed reversibility or recovery is refused at the action surface and stores nothing', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId } = await newGoal(app);
    const badLevel = await app.controller.planAdd({
      goalId,
      outcome: `${OUTCOME} (bad level)`,
      steps: [{ ...writeStep('s1', 'bad'), reversibility: 'probably' }],
    });
    assert.equal(badLevel.status, Outcome.INPUT_REJECTED, badLevel.output);
    assert.match(badLevel.output, /reversibility must be one of/);

    const tooLong = await app.controller.planAdd({
      goalId,
      outcome: `${OUTCOME} (long recovery)`,
      steps: [{ ...writeStep('s1', 'long'), recovery: 'x'.repeat(201) }],
    });
    assert.equal(tooLong.status, Outcome.INPUT_REJECTED, tooLong.output);
    assert.match(tooLong.output, /recovery exceeds 200 characters/);

    const invented = await app.controller.planAdd({
      goalId,
      outcome: `${OUTCOME} (unknown key)`,
      steps: [{ ...writeStep('s1', 'invented'), undoStrategy: 'rm -rf' }],
    });
    assert.equal(invented.status, Outcome.INPUT_REJECTED, invented.output);
    assert.match(invented.output, /unexpected field "undoStrategy"/);

    assert.equal((await app.plans.list()).length, 0, 'none of the refused plans was stored');
  } finally {
    cleanup(dir);
  }
});

test('an outcome assessment has a shape, and every part of it is required', () => {
  const base = {
    schema: PLAN_SCHEMA,
    eventId: 'assess-1',
    type: 'plan_assessment',
    planId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    at: '2026-01-01T00:00:00.000Z',
    origin: 'user',
    planVersion: 1,
    contentHash: '0'.repeat(64),
    verdict: 'partial',
    summary: 'two steps ran, one criterion is still unevidenced',
    findings: findings(
      ['step_completion', 'both steps ran and ended completed', ['op-1', 'op-2']],
      ['goal_criteria', 'only one of the two criteria has evidence', ['op-1']],
    ),
  };
  assert.deepEqual(assessmentProblems(base), []);
  assert.equal(validateEventShape(base), null);
  assert.deepEqual(ASSESSMENT_VERDICTS, ['successful', 'partial', 'failed', 'blocked', 'uncertain', 'awaiting_confirmation']);
  assert.equal(ASSESSMENT_ASPECTS.length, 7);

  const cases = [
    ['an assessment is not a model claim', { origin: 'model' }, 'unknown origin'],
    ['the version assessed is required', { planVersion: 0 }, 'must name the plan version'],
    ['the bytes assessed are required', { contentHash: '0'.repeat(63) }, 'must name the plan content'],
    ['no verdict outside the six', { verdict: 'mostly_successful' }, 'verdict must be one of'],
    ['a summary has a limit', { summary: 'x'.repeat(MAX_ASSESSMENT_SUMMARY_CHARS + 1) }, 'plain summary of 1 to 300 characters'],
    ['a verdict with no words is not an assessment', { summary: '' }, 'plain summary of 1 to 300 characters'],
    ['an assessment with no findings answers nothing', { findings: [] }, 'needs at least one finding'],
    ['an assessment may not answer a question twice',
      { findings: [...base.findings, { aspect: 'step_completion', statement: 'asked again', operations: ['op-1'] }] },
      'answers step_completion twice'],
    ['a finding with no operation has no evidence behind it',
      { findings: findings(['step_completion', 'ran', []]) }, 'cites no operation'],
    ['a cited id must be an id', { findings: findings(['step_completion', 'ran', [17]]) }, 'not a plain record id'],
    ['a cited record id is bounded too',
      { findings: findings(['evidence_state', 'ran', ['op-1'], ['x'.repeat(65)]]) }, 'not a plain record id'],
    ['the ids one finding cites are bounded',
      { findings: findings(['evidence_state', 'ran', Array.from({ length: MAX_CITED_IDS + 1 }, (_, i) => `op-${i}`)]) },
      `may cite at most ${MAX_CITED_IDS} ids`],
    ['too many questions is not a better assessment',
      { findings: findings(...Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => ['verification', `finding ${i}`, ['op-1']])) },
      `at most ${MAX_FINDINGS} question`],
    ['a successful verdict must show the criterion was met',
      { verdict: 'successful', findings: findings(['step_completion', 'ran', ['op-1']]) },
      'a successful assessment must answer goal_criteria'],
    ['an awaiting verdict must say what is still outside',
      { verdict: 'awaiting_confirmation', findings: findings(['step_completion', 'ran', ['op-1']]) },
      'must answer external_confirmation'],
  ];
  for (const [why, patch, expected] of cases) {
    const problems = assessmentProblems({ ...base, ...patch });
    assert.ok(problems.length > 0, `${why}: expected a problem`);
    assert.match(problems.join('; '), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${why}: ${JSON.stringify(problems)}`);
  }
  assert.match(assessmentProblems({ ...base, findings: findings(['step_completion', 'two\nlines', ['op-1']]) }).join('; '), /plain statement/);
  // The rule asks for the question that bears on the verdict, not a fixed set of seven: `base`
  // already answers goal_criteria, so the same findings support a successful verdict too.
  assert.deepEqual(assessmentProblems({ ...base, verdict: 'successful' }), []);
});

test('an assessment is a record about the plan, not part of it: bytes, status, approval and history are untouched', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId } = await newGoal(app);
    const plan = await runPlan(app, { goalId, steps: [writeStep('s1', 'assessed')] });
    const op1 = plan.stepResults.s1.operationId;
    assert.ok(op1, 'the run left a real audit operation to cite');

    const { plan: after } = await app.plans.assessPlan(plan.id, {
      verdict: 'partial',
      summary: 'the step ran and verified, but the goal records no evidence for its criterion',
      findings: findings(
        ['step_completion', 'step s1 ended completed in one verified operation', [op1]],
        ['expected_output', 'the memory record the step promised is present', [op1]],
        ['goal_criteria', 'no evidence is recorded against the goal criterion', [op1]],
      ),
    });
    assert.equal(after.status, plan.status, 'an assessment changes no plan status');
    assert.equal(after.approval.contentHash, plan.approval.contentHash);
    assert.equal(after.activation.taskId, plan.activation.taskId);
    assert.equal(after.updatedAt, plan.updatedAt, 'an assessment is not an update to the plan');
    assert.equal(after.history.length, plan.history.length, 'nor an entry in its version history');
    assert.equal(planContentHash(after), planContentHash(plan));
    assert.equal(stableStringify(planContent(after)).includes('assessment'), false, 'the bound bytes hold no assessment');

    const listed = await app.plans.assessments(plan.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].verdict, 'partial');
    assert.equal(listed[0].stale, false);
    assert.equal(listed[0].currentVersion, plan.version);
    assert.deepEqual(listed[0].findings.map((f) => f.aspect), ['step_completion', 'expected_output', 'goal_criteria']);
    assert.deepEqual(listed[0].findings[0].operations, [op1]);

    // A second reader over the same file replays the assessment from the log.
    const reread = new PlanStore(app.plans.filePath, {
      now: () => new Date(),
      registry: app.registry,
      goals: app.goals,
      operations: app.operations,
    });
    const replayed = await reread.get(plan.id);
    assert.equal(replayed.assessments.length, 1, 'the assessment is in the append-only log, not only in memory');
    assert.equal(replayed.assessments[0].summary, 'the step ran and verified, but the goal records no evidence for its criterion');
  } finally {
    cleanup(dir);
  }
});

test('every finding must cite an operation that exists in the audit log, and a failure may be cited too', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId } = await newGoal(app);
    const plan = await runPlan(app, { goalId, steps: [writeStep('s1', 'cited')] });
    const realOp = plan.stepResults.s1.operationId;

    await assert.rejects(
      () => app.plans.assessPlan(plan.id, {
        verdict: 'uncertain',
        summary: 'a conclusion drawn from an operation that was never recorded',
        findings: findings(['evidence_state', 'cited something that does not exist', ['00000000-0000-4000-8000-000000000000']]),
      }),
      (err) => {
        assert.equal(err.code, 'EVIDENCE_NOT_VERIFIED');
        assert.match(err.message, /is not in the audit log/);
        return true;
      },
    );

    // A refused request still leaves an audit record, and a `failed` assessment must be able to cite
    // exactly that kind of record: an assessment is not assembled only from verified successes.
    const refused = await app.controller.planApprove({ target: 'no-such-plan-at-all' });
    assert.equal(refused.status, Outcome.EXECUTION_FAILED, refused.output);
    const { records } = await app.operations.list({ limit: 200 });
    const refusedOp = records.find((r) => r.capability === 'plan.approve' && r.status === Outcome.EXECUTION_FAILED);
    assert.ok(refusedOp, 'the refusal is itself in the audit log');
    const { plan: assessed } = await app.plans.assessPlan(plan.id, {
      verdict: 'failed',
      summary: 'an approval attempt was refused and the recorded step does not settle the criterion',
      findings: findings(['evidence_state', `the approval attempt is recorded as ${refusedOp.status}`, [refusedOp.id]]),
    });
    assert.equal(assessed.assessments.length, 1);
    assert.equal(assessed.assessments[0].findings[0].operations[0], refusedOp.id);

    // With no audit reader at all nothing can be assessed: the guarantee does not depend on which
    // stores happen to be configured.
    const blind = new PlanStore(app.plans.filePath, { now: () => new Date(), registry: app.registry, goals: app.goals });
    await assert.rejects(
      () => blind.assessPlan(plan.id, {
        verdict: 'uncertain',
        summary: 'no audit log is available to check this against',
        findings: findings(['evidence_state', 'an unverifiable claim', [realOp]]),
      }),
      (err) => {
        assert.equal(err.code, 'EVIDENCE_NOT_VERIFIED');
        assert.match(err.message, /audit log is not available/);
        return true;
      },
    );
    assert.equal((await app.plans.assessments(plan.id)).length, 1, 'the blind attempt stored nothing');
  } finally {
    cleanup(dir);
  }
});

test('an assessment needs a started plan, and the same conclusion cannot be filed twice verbatim', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId } = await newGoal(app);
    const draftId = await addDraft(app, { goalId, steps: [writeStep('s1', 'draft')], tag: 'draft' });
    await assert.rejects(
      () => app.plans.assessPlan(draftId, {
        verdict: 'uncertain',
        summary: 'nothing has run, so there is no outcome to describe',
        findings: findings(['step_completion', 'no step has run', ['any-operation']]),
      }),
      /has not been started/,
    );
    assert.equal((await app.plans.assessments(draftId)).length, 0);

    const plan = await runPlan(app, { goalId, steps: [writeStep('s1', 'twice')] });
    const op = plan.stepResults.s1.operationId;
    const first = {
      verdict: 'successful',
      summary: 'the single step ran, verified, and settled its criterion',
      findings: findings(
        ['step_completion', 'the step completed', [op]],
        ['goal_criteria', 'the criterion is evidenced by that operation', [op]],
      ),
    };
    await app.plans.assessPlan(plan.id, first);
    await assert.rejects(() => app.plans.assessPlan(plan.id, first), /is already recorded/);
    // The same verdict with different words is a new record, not a repeat.
    const second = { ...first, summary: 'reviewed again: the criterion rests on one verified operation only' };
    const { plan: after } = await app.plans.assessPlan(plan.id, second);
    assert.equal(after.assessments.length, 2);
    const listed = await app.plans.assessments(plan.id);
    assert.deepEqual(listed.map((a) => a.summary), [first.summary, second.summary], 'oldest first');
  } finally {
    cleanup(dir);
  }
});

test('an assessment describes the version it assessed: a revision keeps it and marks it stale', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId, operationId } = await newGoal(app);
    const store = sideStore(dir, 'stale.jsonl', app);
    const { plan } = await store.createPlan({ goalId, outcome: `${OUTCOME} (stale)`, steps: [writeStep('s1', 'stale')] });
    await store.approve(plan.id);
    // The store's own activation record. The controller writes it after creating a task; this test
    // needs a started plan without running one, so no task exists and nothing executed.
    await store.activate(plan.id, { taskId: 'task-for-the-staleness-check' });
    await store.assessPlan(plan.id, {
      verdict: 'blocked',
      summary: 'the plan was started but the step outcome was never recorded against it',
      findings: findings(['step_completion', 'no step outcome is recorded', [operationId]]),
    });
    const first = (await store.assessments(plan.id))[0];
    assert.equal(first.stale, false);
    assert.equal(first.planVersion, 1);

    await store.setStatus(plan.id, PlanStatus.BLOCKED, { reason: 'the approach needs a check before the write' });
    const { plan: revised } = await store.revise(plan.id, {
      outcome: `${OUTCOME} (stale)`,
      steps: [writeStep('s1', 'stale'), readStep('s2')],
      reason: 'a check is added before the write',
    });
    assert.equal(revised.version, 2);
    assert.equal(revised.activation, null, 'the revision is not the plan that was started');

    const kept = await store.assessments(plan.id);
    assert.equal(kept.length, 1, 'a revision does not erase the earlier conclusion');
    assert.equal(kept[0].stale, true);
    assert.equal(kept[0].contentHash, first.contentHash);
    assert.equal(kept[0].currentVersion, 2);

    // The old conclusion cannot be filed again as though it described version 2, and the rule is
    // enforced by replay rather than by the caller having read the version first. Version 2 must be
    // authorized and started again before it can carry any conclusion of its own.
    await store.approve(plan.id);
    await store.activate(plan.id, { taskId: 'task-for-the-second-attempt' });
    const recorded = linesOf(store.filePath).filter((e) => e.type === 'plan_assessment');
    assert.equal(recorded.length, 1);
    await store.assessPlan(plan.id, {
      verdict: 'uncertain',
      summary: 'the second version has been started and its own outcome is still unclear',
      findings: findings(['verification', 'no verification is recorded for either step', [operationId]]),
    });
    const now = await store.assessments(plan.id);
    assert.equal(now.length, 2);
    assert.deepEqual(now.map((a) => a.stale), [true, false], 'one conclusion is stale, the current one is not');
    assert.equal(now[1].planVersion, 2);

    // Replaying the v1 assessment after the plan reached v2 is refused on the version, not silently
    // accepted as a statement about the current content.
    const replayed = reduceEvents([...linesOf(store.filePath).filter((e) => e.type !== 'plan_assessment'), ...recorded]);
    assert.equal(replayed.problems.length, 1);
    assert.match(replayed.problems[0].reason, /names version 1, but the plan is version 2/);
  } finally {
    cleanup(dir);
  }
});

test('secrets and control characters in an assessment are refused and persist nothing', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId } = await newGoal(app);
    const plan = await runPlan(app, { goalId, steps: [writeStep('s1', 'secret')] });
    const op = plan.stepResults.s1.operationId;
    const before = linesOf(app.plans.filePath).length;

    await assert.rejects(
      () => app.plans.assessPlan(plan.id, {
        verdict: 'uncertain',
        summary: 'rotate the deploy password: hunter2secret before the next step',
        findings: findings(['evidence_state', 'nothing else', [op]]),
      }),
      /looks like a password, key, or token/,
    );
    await assert.rejects(
      () => app.plans.assessPlan(plan.id, {
        verdict: 'uncertain',
        summary: 'a finding that carries the credential itself',
        findings: findings(['evidence_state', 'api_key: sk-abcdefghij0123456789ABCDEF', [op]]),
      }),
      /looks like a password, key, or token/,
    );
    await assert.rejects(
      () => app.plans.assessPlan(plan.id, {
        verdict: 'uncertain',
        summary: 'a finding whose statement carries a control character',
        findings: findings(['evidence_state', 'embedded\tcontrol', [op]]),
      }),
      /refused:/,
    );
    assert.equal((await app.plans.assessments(plan.id)).length, 0);
    assert.equal(linesOf(app.plans.filePath).length, before, 'no refused assessment was appended');
    const persisted = fs.readFileSync(app.plans.filePath, 'utf8');
    assert.equal(persisted.includes('hunter2secret'), false);
    assert.equal(persisted.includes('sk-abcdefghij0123456789ABCDEF'), false);
  } finally {
    cleanup(dir);
  }
});

test('the plan vocabulary separates a live plan from an open one, and only one counting rule exists', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { goalId } = await newGoal(app);
    const a = await addDraft(app, { goalId, steps: [writeStep('s1', 'v')], tag: 'v' });
    await app.plans.approve(a);
    await app.plans.setStatus(a, PlanStatus.BLOCKED, { reason: 'waiting on a record that has not arrived' });
    const all = await app.plans.list();
    const { drafts, live, all: forGoal } = plansForGoal(new Map(all.map((p) => [p.id, p])), goalId);
    assert.equal(forGoal.length, 1);
    assert.equal(drafts.length, 0, 'a blocked plan is not one of the candidate drafts');
    assert.equal(live.length, 1, 'a blocked plan still holds the goal: the user can put it back into action');
    assert.equal(isLivePlan(PlanStatus.BLOCKED), true);
    assert.equal(isLivePlan(PlanStatus.DRAFT), false);
    assert.equal(isLivePlan(PlanStatus.CANCELLED), false);
    assert.equal(isLivePlan(PlanStatus.SUPERSEDED), false);
    assert.equal(isLivePlan(PlanStatus.COMPLETED), false, 'a finished plan decides nothing about the next one');

    // So a replacement may be approved only once the blocked plan has been set down.
    const b = await addDraft(app, { goalId, steps: [writeStep('s1', 'w')], tag: 'w' });
    await assert.rejects(() => app.plans.approve(b), /already has a live plan/);
    await app.plans.setStatus(a, PlanStatus.CANCELLED, { reason: 'abandoned in favour of the alternative' });
    assert.equal((await app.plans.approve(b)).plan.status, PlanStatus.APPROVED);
  } finally {
    cleanup(dir);
  }
});
