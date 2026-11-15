// Batch AP-17: the executive stores at a cutoff - goals, plans, plan versions, tasks, and the
// operations audit - reconstructed through the same read-only history surface AP-16 introduced.
//
// Every test here is deterministic: the clock is injected, the fixtures are real goal, plan, task,
// and audit records written by the real stores, and no model is contacted. The assertions are about
// the separation the milestone is built on:
//
//   recorded time, not event time   a goal, plan, or task event carries the instant it was written
//                                  (`.at`); an experience or operation carries its own event time.
//                                  A cutoff filters on the first and never quietly on the second.
//   later is never folded back      a completion, acceptance, cancellation, supersession, approval,
//                                  revision, activation, step outcome, assessment, or audit line
//                                  recorded after the cutoff is counted and marked as later. None of
//                                  it decides the past reading.
//   the audit cannot answer a cutoff   its lines have no recorded-at and are appended at
//                                  finalization, so each row is classified against the cutoff and a
//                                  missing line never reads as success.
//   history is not replay          a task open at the cutoff stays open; nothing here resumes,
//                                  retries, executes, approves, or authorizes anything.
//   a source that cannot answer is named   damage, an unapplied event sequence, an unreadable audit
//                                  line, and an unsupported source are disclosed, never omitted into
//                                  an optimistic empty answer.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome, OPERATION_SCHEMA } from '../src/outcomes.js';
import { GOAL_SCHEMA } from '../src/goals/model.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const EARLY = '2026-01-10T09:00:00.000Z';
const MID = '2026-01-12T10:00:00.000Z';
const CUTOFF = '2026-01-15T12:00:00.000Z';
const AFTER = '2026-01-20T10:00:00.000Z';
const LATE = '2026-01-25T00:00:00.000Z';

const STORE_FILES = [
  'goals.jsonl', 'plans.jsonl', 'tasks.jsonl', 'experiences.jsonl', 'predictions.jsonl',
  'world-model.jsonl', 'memory.jsonl', 'knowledge.jsonl',
];
const GOALS = 'goals.jsonl';
const PLANS = 'plans.jsonl';
const TASKS = 'tasks.jsonl';
const OPERATIONS = 'operations.jsonl';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

// The clock is mutable so one fixture can record events at distinct stored times without sleeping.
function appOn(dir, start = EARLY) {
  const state = { now: new Date(start) };
  const app = createApp({
    dataDir: dir,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    experienceCapture: CAPTURE_OFF,
    now: () => state.now,
  });
  return {
    app,
    setNow(iso) { state.now = new Date(iso); },
    now() { return state.now; },
  };
}

const dataOf = (res) => res.operation.steps[0].result.data;
const viewOf = (res) => dataOf(res).view;

async function history(app, at, extra = {}) {
  const res = await app.controller.historyReconstruct({ at, ...extra });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
  return viewOf(res);
}

let seq = 0;
// A real audit line, appended through the audit log's own write path. `requestedAt` and
// `finishedAt` are the only times it carries: the log has no recorded-at field.
async function operation(app, {
  requestedAt = MID, finishedAt = requestedAt, status = Outcome.SUCCESS_VERIFIED, capability = 'memory.list',
} = {}) {
  seq += 1;
  const id = `ap17-op-${String(seq).padStart(4, '0')}`;
  await app.operations.append({
    schema: OPERATION_SCHEMA, id, capability, origin: 'user', decision: 'answer', status,
    requestedAt, finishedAt, output: 'recorded',
  });
  return id;
}

async function addGoal(app, { request = 'Record a note and report where it went', criteria = ['the result is recorded'] } = {}) {
  const { goal } = await app.goals.createGoal({ request, criteria });
  return goal;
}

async function startGoal(app, goalId) {
  await app.goals.transition(goalId, 'accepted');
  await app.goals.transition(goalId, 'active');
}

function planStep() {
  return {
    id: 's1',
    description: 'list the memory records',
    action: 'memory.list',
    input: {},
    dependsOn: [],
    expectedResult: 'the bounded memory listing is returned',
    verification: 'the listing names the records it read',
    risk: 'low',
  };
}

async function addPlan(app, { steps = [planStep()], outcome = 'the memory records are listed', goalId = null } = {}) {
  const { plan } = await app.plans.createPlan({ goalId, outcome, steps, reason: 'recorded for the history fixture' });
  return plan;
}

function taskStep() {
  return {
    id: 't1', description: 'list the memory records', action: 'memory.list', permission: 'read', input: {}, dependsOn: [],
  };
}

async function addTask(app, { taskId = 'ap17-task-0001', goal = 'List the memory records', steps = [taskStep()] } = {}) {
  await app.taskStore.createTask({ taskId, goal, origin: 'user', planner: 'deterministic', steps, reason: 'recorded for the history fixture' });
  return taskId;
}

async function startTask(app, taskId, stepId = 't1') {
  await app.taskStore.transition(taskId, {
    reason: 'the user started it',
    task: { from: 'pending', to: 'running' },
    steps: [{ id: stepId, from: 'pending', to: 'running' }],
  });
}

async function completeTask(app, taskId, operationId, stepId = 't1') {
  await app.taskStore.transition(taskId, {
    reason: 'the step completed and was verified',
    task: { from: 'running', to: 'completed' },
    steps: [{ id: stepId, from: 'running', to: 'completed', operationId, outcome: Outcome.SUCCESS_VERIFIED }],
  });
}

function readLines(dir, file) {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function appendLine(dir, file, record) {
  fs.appendFileSync(path.join(dir, file), `${JSON.stringify(record)}\n`);
}

function bytesOf(dir) {
  const out = {};
  for (const file of STORE_FILES) {
    try {
      out[file] = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      out[file] = null;
    }
  }
  return out;
}

// A record the goal store would have refused at write time: supporting evidence naming an audit
// operation that is not in the log (or one that finalized after the cutoff). Placed directly in the
// log so the reader is asked what such a record means, rather than the writer being asked to make one.
function craftGoalEvidence(dir, { goalId, criterionId = 'c1', operationId, at = MID }) {
  appendLine(dir, GOALS, {
    schema: GOAL_SCHEMA,
    eventId: `ap17-crafted-${operationId}`,
    type: 'goal_evidence',
    goalId,
    at,
    criterionId,
    kind: 'supports',
    operationId,
    detail: null,
    reopen: false,
  });
}

describe('AP-17 the reconstruction is one read-only action', () => {
  test('the history action is read-only, user and model origins, and not plannable', () => {
    const dir = tempDir();
    const { app } = appOn(dir);
    const def = app.registry.get('history.reconstruct');
    assert.equal(def.permission, 'read');
    assert.deepEqual([...def.origins].sort(), ['model', 'user']);
    assert.equal(def.plannable, false);
    assert.equal(app.registry.authorize('history.reconstruct', 'user').decision, 'allow');
    assert.equal(app.registry.authorize('history.reconstruct', 'model').decision, 'allow');
  });

  test('the view names all seven sources, and only operations is not cutoff-capable', async () => {
    const dir = tempDir();
    const { app } = appOn(dir);
    const view = await history(app, CUTOFF);

    assert.equal(view.schema, 'apex.cognitive-history.v1');
    assert.equal(view.cutoff, CUTOFF);
    assert.equal(view.authorizes, false);
    assert.deepEqual(view.asOf.sources.map((entry) => entry.name), ['experience', 'predictions', 'world', 'goals', 'plans', 'tasks', 'operations']);
    assert.deepEqual(
      Object.fromEntries(view.asOf.sources.map((entry) => [entry.name, entry.supportsCutoff])),
      {
        experience: true, predictions: true, world: true, goals: true, plans: true, tasks: true, operations: false,
      },
    );
    assert.equal(view.asOf.state, 'consistent');
    assert.equal(view.asOf.complete, true);
  });

  test('cutoff semantics separate recorded, event, valid, evaluation, and correction time per store', async () => {
    const dir = tempDir();
    const { app } = appOn(dir);
    const view = await history(app, CUTOFF);

    assert.deepEqual(Object.keys(view.cutoffSemantics).sort(), [
      'correctionTime', 'cutoff', 'evaluationTime', 'eventTime', 'goals', 'operations', 'plans', 'recordedTime', 'tasks', 'validTime',
    ]);
    assert.match(view.cutoffSemantics.recordedTime, /\.at` for goal, plan, and task events/);
    assert.match(view.cutoffSemantics.eventTime, /occurredAt/);
    assert.match(view.cutoffSemantics.goals, /goal reducer/);
    assert.match(view.cutoffSemantics.plans, /content hash/);
    assert.match(view.cutoffSemantics.tasks, /open at the cutoff remains open/);
    assert.match(view.cutoffSemantics.operations, /no recorded-at/);
    assert.equal(view.limitations.length, 7);
    assert.ok(view.limitations.some((line) => /historical plan approval.*not a current authorization/.test(line)));
    assert.ok(view.limitations.some((line) => /never resumes, retries, or executes/.test(line)));
    assert.match(view.rule, /a cutoff replays only records stored at or before it/);
    assert.match(view.note, /not what was objectively true/);
  });

  test('sources that cannot answer a cutoff stay disclosed with a reason', async () => {
    const dir = tempDir();
    const { app } = appOn(dir);
    const view = await history(app, CUTOFF);
    assert.deepEqual(view.unsupported.map((entry) => entry.source), ['memory', 'knowledge']);
    for (const entry of view.unsupported) {
      assert.equal(entry.status, 'unsupported');
      assert.ok(entry.reason.length > 20, `${entry.source} must state why it cannot answer`);
    }
  });
});

describe('AP-17 recorded time is not event time', () => {
  test('an experience whose event happened before the cutoff is absent when it was recorded after it', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, AFTER);
    // The audited operation ran at MID; the experience describing it is written at AFTER.
    const opId = await operation(app, { requestedAt: MID, finishedAt: MID });
    const recorded = await app.controller.experienceRecord({ operationId: opId, subject: 'a note was stored' });
    assert.equal(recorded.status, Outcome.SUCCESS_VERIFIED, recorded.output);

    const past = await history(app, CUTOFF);
    assert.equal(past.experience.counts.experiences, 0, 'the record did not exist at the cutoff');
    assert.equal(past.experience.excluded, 1);
    assert.equal(past.later.experiencesRecorded, 1);

    const later = await history(app, LATE);
    const row = later.experience.rows.find((entry) => entry.capability === 'memory.add' || entry.capability === 'memory.list');
    assert.ok(row, 'the experience is visible to a later cutoff');
    assert.equal(row.occurredAt, MID, 'event time is kept as the record states it');
    assert.equal(row.createdAt, AFTER, 'recorded time is when the store wrote it');
    assert.equal(row.timeSource, 'finishedAt');
  });

  test('an operation requested before the cutoff but finished after it provably did not exist then', async () => {
    const dir = tempDir();
    const { app } = appOn(dir, LATE);
    const opId = await operation(app, { requestedAt: EARLY, finishedAt: AFTER });

    const view = await history(app, CUTOFF);
    const row = view.operations.rows.find((entry) => entry.id === opId);
    assert.ok(row);
    assert.equal(row.requestedAt, EARLY);
    assert.equal(row.finishedAt, AFTER);
    assert.equal(row.stateAtCutoff, 'later');
    assert.equal(row.existedAtCutoff, false);
    assert.equal(view.operations.supportsCutoff, false);
    assert.equal(view.operations.recordedAtKnown, false);
    assert.equal(view.later.operationsFinishedLater >= 1, true);
  });
});

describe('AP-17 goals at a cutoff', () => {
  test('a goal active at the cutoff reads active, and a later completion is shown beside it as later', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const goal = await addGoal(app);
    setNow(MID);
    await startGoal(app, goal.id);

    setNow(AFTER);
    const opId = await operation(app, { requestedAt: AFTER });
    await app.goals.addEvidence(goal.id, { criterionId: 'c1', kind: 'supports', operationId: opId });
    await app.goals.transition(goal.id, 'completed');

    const past = await history(app, CUTOFF);
    assert.equal(past.goals.available, true);
    assert.equal(past.goals.counts.goals, 1);
    assert.deepEqual(past.goals.counts.byStatus, { active: 1 });
    assert.equal(past.goals.counts.live, 1);
    assert.equal(past.goals.counts.completed, 0);
    const row = past.goals.rows[0];
    assert.equal(row.status, 'active');
    assert.equal(row.completion, null);
    assert.equal(row.later.statusChangedLater, true);
    assert.equal(row.later.completionRecordedLater, true);
    assert.equal(row.later.stoppedLater, false);
    assert.equal(row.now.status, 'completed');
    assert.equal(row.now.completionAt, AFTER);
    assert.equal(past.later.goalsRecorded, 2, 'the later evidence and completion events are excluded from the past replay');
    assert.equal(past.later.goalsCompletedShownLater, 1);

    const later = await history(app, LATE);
    const laterRow = later.goals.rows[0];
    assert.equal(laterRow.status, 'completed');
    assert.deepEqual(laterRow.completion, { at: AFTER, criteria: [{ criterionId: 'c1', operationId: opId }], declined: [] });
    assert.equal(laterRow.later.statusChangedLater, false);
  });

  test('a goal cancelled after the cutoff did not read as stopped at the cutoff', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const goal = await addGoal(app);
    setNow(AFTER);
    await app.goals.transition(goal.id, 'cancelled', { reason: 'the user stopped it' });

    const past = await history(app, CUTOFF);
    const row = past.goals.rows[0];
    assert.equal(row.status, 'proposed');
    assert.equal(row.later.statusChangedLater, true);
    assert.equal(row.later.stoppedLater, true, 'the cancellation is a terminal stop the past reading did not have');
    assert.equal(row.now.status, 'cancelled');
    assert.equal(past.goals.counts.live, 1);
    assert.equal(past.later.goalsRecorded, 1);
  });

  test('a goal superseded after the cutoff does not carry a replacement at the cutoff', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const goal = await addGoal(app);
    setNow(MID);
    await startGoal(app, goal.id);

    setNow(AFTER);
    const replacement = await addGoal(app, { request: 'Record a different note' });
    await app.goals.transition(goal.id, 'superseded', { reason: 'another goal replaced it', by: replacement.id });

    const past = await history(app, CUTOFF);
    assert.equal(past.goals.counts.goals, 1, 'the replacement was recorded after the cutoff');
    const row = past.goals.rows[0];
    assert.equal(row.status, 'active');
    assert.equal(row.supersededBy, null);
    assert.equal(row.later.stoppedLater, true);
    assert.equal(row.now.status, 'superseded');
    assert.equal(past.later.goalsRecorded, 2);

    const later = await history(app, LATE);
    assert.equal(later.goals.counts.goals, 2);
    assert.equal(later.goals.rows.find((entry) => entry.id === goal.id).supersededBy, replacement.id);
  });

  test('a completion recorded by the cutoff keeps its criterion evidence, declined criteria, and progress', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const { goal } = await app.goals.createGoal({
      request: 'Record a note and confirm the listing',
      criteria: [
        'the listing names the record that was read',
        { description: 'the listing stays inside one page', basis: 'system_inferred' },
      ],
    });
    setNow(MID);
    await startGoal(app, goal.id);
    const opId = await operation(app, { requestedAt: MID });
    await app.goals.addEvidence(goal.id, { criterionId: 'c1', kind: 'supports', operationId: opId });
    await app.goals.decideCriterion(goal.id, { criterionId: 'c2', decision: 'declined', reason: 'the page size is not part of this goal' });
    await app.goals.transition(goal.id, 'completed');

    const view = await history(app, CUTOFF);
    const row = view.goals.rows[0];
    assert.equal(row.status, 'completed');
    assert.deepEqual(row.completion, { at: MID, criteria: [{ criterionId: 'c1', operationId: opId }], declined: ['c2'] });
    assert.deepEqual(row.progress, {
      satisfied: 1, contradicted: 0, pending: 1, total: 2, gating: 1, gatingSatisfied: 1, gatingPending: 0,
      suggested: 0, declined: 1, needsConfirmation: 0, userStated: 1, inferred: 1,
    });
    assert.equal(row.criteria[1].basis, 'system_inferred');
    assert.equal(row.criteria[1].requirement, 'declined');
    assert.equal(row.later.statusChangedLater, false);
    assert.equal(row.later.completionRecordedLater, false);
    assert.equal(row.later.evidenceAddedLater, false);
    assert.equal(view.goals.counts.completed, 1);

    // The completion cites an audit record; resolving it is a statement about existence, not truth.
    const cited = view.operationCitations.rows.find((entry) => entry.id === opId);
    assert.equal(cited.state, 'finished_by_cutoff');
    assert.equal(cited.inconsistent, false);
    assert.deepEqual(cited.citedBy, [`goal:${goal.id}`]);
  });

  test('a criterion the system inferred stays a suggestion needing the user decision', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const { goal } = await app.goals.createGoal({
      request: 'Record a note and check the listing',
      criteria: [{ description: 'the listing stays inside one page', basis: 'system_inferred' }],
    });
    setNow(MID);
    await startGoal(app, goal.id);

    const view = await history(app, CUTOFF);
    const row = view.goals.rows[0];
    assert.equal(row.criteria[0].basis, 'system_inferred');
    assert.equal(row.criteria[0].requirement, 'suggested');
    assert.equal(row.progress.suggested, 1);
    assert.equal(row.progress.gating, 0);
    assert.equal(row.progress.needsConfirmation, 1);
    assert.equal(row.criteria[0].status, 'pending');
  });
});

describe('AP-17 plans at a cutoff', () => {
  test('a plan approved after the cutoff reads as a draft, and its approval is not usable', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const plan = await addPlan(app);
    setNow(AFTER);
    await app.plans.approve(plan.id);

    const past = await history(app, CUTOFF);
    assert.equal(past.plans.counts.plans, 1);
    assert.deepEqual(past.plans.counts.byStatus, { draft: 1 });
    assert.equal(past.plans.counts.approved, 0);
    const row = past.plans.rows[0];
    assert.equal(row.status, 'draft');
    assert.equal(row.approval, null);
    assert.equal(row.later.approvedLater, true);
    assert.equal(row.later.statusChangedLater, true);
    assert.equal(past.later.planApprovalsShownLater, 1);

    const later = await history(app, LATE);
    const approved = later.plans.rows[0];
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approval.version, 1);
    assert.match(approved.approval.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(approved.approval.usable, false, 'a historical approval is never presented as currently usable');
    assert.equal(later.plans.counts.approved, 1);
    assert.equal(later.later.planApprovalsShownLater, 0);
  });

  test('an approval invalidated by a revision after the cutoff is not inherited by the new version', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const plan = await addPlan(app);
    setNow(MID);
    await app.plans.approve(plan.id);

    setNow(AFTER);
    await app.plans.setStatus(plan.id, 'blocked', { reason: 'the next step needs a different input' });
    await app.plans.revise(plan.id, {
      outcome: 'the memory records are listed with a bounded limit',
      steps: [{ ...planStep(), input: { limit: 5 } }],
      reason: 'the listing needed a bound',
    });

    const past = await history(app, CUTOFF);
    const row = past.plans.rows[0];
    assert.equal(row.version, 1);
    assert.equal(row.status, 'approved');
    assert.equal(row.approval.version, 1);
    assert.match(row.approval.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(row.approval.usable, false);
    assert.equal(past.plans.counts.approved, 1);

    const later = await history(app, LATE);
    const revised = later.plans.rows[0];
    assert.equal(revised.version, 2);
    assert.equal(revised.status, 'draft');
    assert.equal(revised.approval, null, 'the revision reset the approval');
    assert.equal(revised.now.approvalAt, null);
    assert.equal(revised.later.revisedLater, false);
    const current = (await app.plans.load()).plans.get(plan.id);
    assert.equal(current.approval, null);
    assert.equal(current.version, 2);
  });

  test('a draft revised after the cutoff keeps the version and content that existed then', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const plan = await addPlan(app);
    setNow(AFTER);
    await app.plans.revise(plan.id, {
      outcome: 'the memory records are listed with a bounded limit',
      steps: [{ ...planStep(), input: { limit: 5 } }],
      reason: 'the listing needed a bound',
    });

    const past = await history(app, CUTOFF);
    const row = past.plans.rows[0];
    assert.equal(row.version, 1);
    assert.equal(row.status, 'draft');
    assert.equal(row.approval, null);
    assert.equal(row.later.revisedLater, true);
    assert.equal(past.plans.counts.plans, 1);
    assert.equal(past.later.planRevisionsShownLater, 1);

    const later = await history(app, LATE);
    assert.equal(later.plans.rows[0].version, 2);
    assert.equal(later.plans.counts.plans, 1);
    assert.equal(later.later.plansRecorded, 0, 'nothing is later than a cutoff at the last recorded event');
  });

  test('a plan that failed and was replaced after the cutoff keeps its failed record apart from the replacement', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const plan = await addPlan(app);
    setNow(MID);
    await app.plans.approve(plan.id);
    await app.plans.activate(plan.id, { taskId: 'ap17-plan-task-1' });
    await app.plans.recordOutcome(plan.id, { taskId: 'ap17-plan-task-1', steps: [{ stepId: 's1', status: 'failed' }] });
    await app.plans.setStatus(plan.id, 'failed', { reason: 'the listing could not be produced' });

    setNow(AFTER);
    const replacement = await addPlan(app, { outcome: 'the memory records are listed differently' });

    const past = await history(app, CUTOFF);
    assert.equal(past.plans.counts.plans, 1);
    assert.deepEqual(past.plans.counts.byStatus, { failed: 1 });
    assert.equal(past.plans.counts.approved, 1, 'the approval survives the failure, as the record does');
    assert.equal(past.plans.counts.active, 1, 'the activation survives the failure, as the record does');
    const row = past.plans.rows[0];
    assert.equal(row.status, 'failed');
    assert.match(row.failureReason, /could not be produced/);
    assert.equal(past.plans.rows.some((entry) => entry.id === replacement.id), false, 'the replacement draft is later');
    assert.equal(past.later.plansRecorded, 1);

    const later = await history(app, LATE);
    assert.equal(later.plans.counts.plans, 2);
    assert.equal(later.plans.rows.find((entry) => entry.id === replacement.id).status, 'draft');
  });

  test('an outcome assessment recorded after the cutoff is absent from the past view and marked later', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const plan = await addPlan(app);
    setNow(MID);
    const opId = await operation(app, { requestedAt: MID, capability: 'memory.list' });
    await app.plans.approve(plan.id);
    await app.plans.activate(plan.id, { taskId: 'ap17-plan-task-2' });
    await app.plans.recordOutcome(plan.id, {
      taskId: 'ap17-plan-task-2',
      steps: [{ stepId: 's1', status: 'completed', operationId: opId }],
    });

    setNow(AFTER);
    await app.plans.assessPlan(plan.id, {
      verdict: 'successful',
      summary: 'the listing was produced by the cited operation',
      findings: [{
        aspect: 'goal_criteria',
        statement: 'the recorded criterion is met by the cited operation',
        operations: [opId],
      }],
    });

    const past = await history(app, CUTOFF);
    const row = past.plans.rows[0];
    assert.equal(row.assessments.count, 0);
    assert.equal(row.later.assessedLater, true);
    assert.equal(row.later.outcomeRecordedLater, false, 'the step outcome was recorded before the cutoff');
    assert.deepEqual(row.progress, { completed: 1, failed: 0, uncertain: 0, skipped: 0, pending: 0, total: 1 });

    const later = await history(app, LATE);
    const assessed = later.plans.rows[0];
    assert.equal(assessed.assessments.count, 1);
    assert.deepEqual(assessed.assessments.latest, { at: AFTER, verdict: 'successful', planVersion: 1 });
    assert.equal(assessed.later.assessedLater, false);
    assert.equal(assessed.operationIds.includes(opId), true);
  });
});

describe('AP-17 tasks at a cutoff', () => {
  test('a task started before the cutoff but completed after it stays running in the past view', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const taskId = await addTask(app);
    setNow(MID);
    await startTask(app, taskId);

    setNow(AFTER);
    const opId = await operation(app, { requestedAt: AFTER });
    await completeTask(app, taskId, opId);

    const past = await history(app, CUTOFF);
    const row = past.tasks.rows[0];
    assert.equal(row.status, 'running');
    assert.deepEqual(row.progress, { completed: 0, total: 1 });
    assert.deepEqual(row.stepCounts, { running: 1 });
    assert.equal(row.steps[0].status, 'running');
    assert.equal(row.interruptedAtCutoff, true);
    assert.equal(row.later.statusChangedLater, true);
    assert.equal(row.later.stepCompletedLater, true);
    assert.equal(row.now.status, 'completed');
    assert.equal(past.tasks.counts.interrupted, 1);
    assert.equal(past.later.taskCompletionsShownLater, 1);

    const later = await history(app, LATE);
    const completed = later.tasks.rows[0];
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.progress, { completed: 1, total: 1 });
    assert.equal(completed.steps[0].status, 'completed');
    assert.equal(completed.steps[0].outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(completed.operationIds.includes(opId), true);
  });

  test('an interrupted step with an uncertain effect is reported interrupted and never as success', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const taskId = await addTask(app);
    setNow(MID);
    await startTask(app, taskId);
    const opId = await operation(app, { requestedAt: MID, status: Outcome.VERIFICATION_UNAVAILABLE });
    await app.taskStore.transition(taskId, {
      reason: 'the outcome could not be verified',
      steps: [{ id: 't1', from: 'running', to: 'uncertain', operationId: opId, outcome: Outcome.VERIFICATION_UNAVAILABLE }],
    });

    const view = await history(app, CUTOFF);
    const row = view.tasks.rows[0];
    assert.equal(row.status, 'running');
    assert.equal(row.interruptedAtCutoff, true);
    assert.equal(row.steps[0].status, 'uncertain');
    assert.equal(row.steps[0].outcome, Outcome.VERIFICATION_UNAVAILABLE);
    assert.notEqual(row.steps[0].outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(row.later.statusChangedLater, false);
    assert.equal(row.later.stepCompletedLater, false);
    assert.equal(row.later.recoveredLater, false);
    assert.equal(row.now.status, 'running');
    assert.deepEqual(row.now.stepCounts, { uncertain: 1 });
  });

  test('a task completed and verified by the cutoff is shown with its recorded outcome and operation', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const taskId = await addTask(app);
    setNow(MID);
    await startTask(app, taskId);
    const opId = await operation(app, { requestedAt: MID });
    await completeTask(app, taskId, opId);

    const view = await history(app, CUTOFF);
    const row = view.tasks.rows[0];
    assert.equal(row.status, 'completed');
    assert.deepEqual(row.progress, { completed: 1, total: 1 });
    assert.equal(row.interruptedAtCutoff, false);
    assert.equal(row.steps[0].status, 'completed');
    assert.equal(row.steps[0].operationId, opId);
    assert.equal(row.steps[0].outcome, Outcome.SUCCESS_VERIFIED);
    assert.deepEqual(row.operationIds, [opId]);

    const cited = view.operationCitations.rows.find((entry) => entry.id === opId);
    assert.equal(cited.state, 'finished_by_cutoff');
    assert.deepEqual(cited.citedBy, [`task:${taskId}`]);
  });

  test('reading the history never resumes, retries, or executes an open task', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const taskId = await addTask(app);
    setNow(MID);
    await startTask(app, taskId);

    const before = bytesOf(dir);
    const res = await app.controller.historyReconstruct({ at: CUTOFF });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    assert.deepEqual(bytesOf(dir), before, 'goals, plans, and tasks were not written');
    assert.equal(res.operation.steps.length, 1, 'the read ran one action, not a task step');

    const task = (await app.taskStore.load()).tasks.get(taskId);
    assert.equal(task.status, 'running');
    assert.equal(task.steps[0].status, 'running');
    const view = viewOf(res);
    assert.equal(view.tasks.rows[0].status, 'running');
    assert.equal(view.tasks.rows[0].interruptedAtCutoff, true);
  });
});

describe('AP-17 the operations audit cannot answer a cutoff', () => {
  test('an operation finished after the cutoff is provably later, not past knowledge', async () => {
    const dir = tempDir();
    const { app } = appOn(dir, LATE);
    const opId = await operation(app, { requestedAt: EARLY, finishedAt: AFTER });

    const view = await history(app, CUTOFF);
    assert.equal(view.operations.supportsCutoff, false);
    assert.equal(view.operations.recordedAtKnown, false);
    assert.match(view.operations.note, /no recorded-at/);
    const row = view.operations.rows.find((entry) => entry.id === opId);
    assert.equal(row.stateAtCutoff, 'later');
    assert.equal(row.existedAtCutoff, false);
    assert.equal(view.operations.counts.byStateAtCutoff.later >= 1, true);
  });

  test('an operation that finished unverified by the cutoff is classified, not counted as past evidence', async () => {
    const dir = tempDir();
    const { app } = appOn(dir, AFTER);
    const opId = await operation(app, { requestedAt: MID, status: Outcome.VERIFICATION_UNAVAILABLE });

    const view = await history(app, CUTOFF);
    const row = view.operations.rows.find((entry) => entry.id === opId);
    assert.equal(row.stateAtCutoff, 'finished_by_cutoff');
    assert.equal(row.existedAtCutoff, 'unknown', 'the append time is not recorded, so existence at the cutoff is unknown');
    assert.equal(row.status, Outcome.VERIFICATION_UNAVAILABLE);
  });

  test('a verification recorded after the cutoff does not settle an operation that finished before it', async () => {
    const dir = tempDir();
    const { app } = appOn(dir, LATE);
    const early = await operation(app, { requestedAt: MID, finishedAt: MID, status: Outcome.SUCCESS_VERIFIED });
    const late = await operation(app, { requestedAt: MID, finishedAt: AFTER, status: Outcome.SUCCESS_VERIFIED });

    const view = await history(app, CUTOFF);
    const earlyRow = view.operations.rows.find((entry) => entry.id === early);
    const lateRow = view.operations.rows.find((entry) => entry.id === late);
    assert.equal(earlyRow.stateAtCutoff, 'finished_by_cutoff');
    assert.equal(lateRow.stateAtCutoff, 'later');
    assert.equal(lateRow.existedAtCutoff, false);
    assert.equal(view.operations.counts.byStateAtCutoff.finished_by_cutoff >= 1, true);
    assert.equal(view.operations.counts.byStateAtCutoff.later >= 1, true);
  });

  test('a citation to an operation with no audit record is resolved as missing', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const goal = await addGoal(app);
    setNow(AFTER);
    craftGoalEvidence(dir, { goalId: goal.id, operationId: 'ap17-op-not-recorded' });

    const view = await history(app, CUTOFF);
    const cited = view.operationCitations.rows.find((entry) => entry.id === 'ap17-op-not-recorded');
    assert.ok(cited);
    assert.equal(cited.state, 'missing');
    assert.match(cited.reason, /no audit record/);
    assert.equal(cited.inconsistent, false);
    assert.equal(view.operationCitations.inconsistent, 0);
  });

  test('an unreadable audit line makes absence of a cited operation unestablished', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const goal = await addGoal(app);
    setNow(AFTER);
    const real = await operation(app, { requestedAt: MID });
    craftGoalEvidence(dir, { goalId: goal.id, operationId: 'ap17-op-ghost' });
    fs.appendFileSync(path.join(dir, OPERATIONS), '{ this is not a record\n');

    const view = await history(app, CUTOFF);
    assert.equal(view.operations.corrupt, 1);
    assert.equal(view.operations.status, 'damaged');
    assert.equal(view.asOf.complete, false);
    assert.equal(view.asOf.verifiable, false);

    const cited = view.operationCitations.rows.find((entry) => entry.id === 'ap17-op-ghost');
    assert.equal(cited.state, 'unavailable');
    assert.match(cited.reason, /unreadable line/);
    assert.equal(view.operations.rows.some((entry) => entry.id === real), true, 'the readable records are still reported');
  });

  test('a citation to an operation finishing after the cutoff is inconsistent and not used as past evidence', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const goal = await addGoal(app);
    setNow(LATE);
    const laterOp = await operation(app, { requestedAt: MID, finishedAt: AFTER });
    craftGoalEvidence(dir, { goalId: goal.id, operationId: laterOp });

    const view = await history(app, CUTOFF);
    const cited = view.operationCitations.rows.find((entry) => entry.id === laterOp);
    assert.equal(cited.state, 'later');
    assert.equal(cited.inconsistent, true);
    assert.match(cited.reason, /not used as past evidence/);
    assert.equal(view.operationCitations.inconsistent, 1);
  });
});

describe('AP-17 integrity, movement, and determinism', () => {
  test('a damaged goal log is named, while the other sources keep answering', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    await addGoal(app);
    setNow(MID);
    const taskId = await addTask(app);
    await startTask(app, taskId);
    fs.appendFileSync(path.join(dir, GOALS), '{ this is not a goal event\n');

    const view = await history(app, CUTOFF);
    assert.equal(view.goals.available, false);
    assert.equal(view.goals.status, 'damaged');
    assert.match(view.goals.reason, /corrupt line/);
    assert.equal(view.asOf.complete, false);
    assert.equal(view.asOf.verifiable, false);
    assert.equal(view.tasks.available, true);
    assert.equal(view.tasks.rows[0].status, 'running');
    assert.equal(view.asOf.sources.find((entry) => entry.name === 'goals').status, 'damaged');
  });

  test('an event sequence that does not apply at the cutoff is reported inconsistent, never reordered', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-01-10T10:00:00.000Z');
    const goal = await addGoal(app);
    // The full log applies cleanly: created, then accepted, then activated. The acceptance is stamped
    // later than the activation, so a cutoff between them keeps create+activate and drops acceptance.
    setNow('2026-01-10T14:00:00.000Z');
    await app.goals.transition(goal.id, 'accepted');
    setNow('2026-01-10T11:00:00.000Z');
    await app.goals.transition(goal.id, 'active');

    const view = await history(app, '2026-01-10T12:00:00.000Z');
    assert.equal(view.goals.available, true);
    assert.equal(view.goals.status, 'inconsistent');
    assert.match(view.goals.reason, /did not apply/);
    assert.equal(view.goals.problemCount, 1);
    assert.match(view.goals.problems[0].reason, /goal is proposed, event expected accepted/);
    assert.equal(view.asOf.complete, false);
    assert.equal(view.asOf.verifiable, false);
    assert.equal(view.asOf.sources.find((entry) => entry.name === 'goals').status, 'inconsistent');

    // The store itself is not damaged: the full replay still applies, which is why the cutoff
    // subsequence - not the file - is what is reported.
    const stored = await app.goals.load();
    assert.equal(stored.goals.get(goal.id).status, 'active');
  });

  test('a store that moves during the read is reported as concurrent_modification, not a complete answer', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const taskId = await addTask(app);
    setNow(MID);
    await startTask(app, taskId);
    const template = readLines(dir, TASKS)[0];
    const original = app.taskStore.historicalView.bind(app.taskStore);
    let writes = 0;
    app.taskStore.historicalView = async (...args) => {
      const result = await original(...args);
      writes += 1;
      // A valid task record dated after the cutoff. The past view is unaffected, but the task file
      // moves between the certification taken at the start of each attempt and the one taken at its end.
      appendLine(dir, TASKS, {
        ...template, eventId: `ap17-concurrent-${writes}`, taskId: `ap17-late-task-${writes}`, at: LATE,
      });
      return result;
    };

    const res = await app.controller.historyReconstruct({ at: CUTOFF });
    assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED);
    const view = viewOf(res);
    assert.equal(view.asOf.state, 'concurrent_modification');
    assert.equal(view.asOf.complete, false);
    assert.equal(view.asOf.attempts >= 2, true, 'the read retried before reporting the movement');
    assert.equal(view.asOf.attempts <= 3, true, 'the retry is bounded and disclosed');
    assert.equal(writes >= 2, true);
    assert.equal(view.tasks.rows.some((row) => row.id === taskId), true, 'the answer is still assembled');
    assert.equal(view.tasks.rows.some((row) => row.id.startsWith('ap17-late-task-')), false);
  });
});

describe('AP-17 cross-process reads, bounds, authority, and the CLI', () => {
  test('a task appended by another process is absent at a past cutoff and visible later', async () => {
    const dir = tempDir();
    const { app } = appOn(dir, EARLY);
    const first = await addTask(app);

    const other = appOn(dir, AFTER);
    const second = await addTask(other.app, { taskId: 'ap17-task-0002', goal: 'List a different record set' });
    other.setNow(LATE);

    const past = await history(app, CUTOFF);
    assert.equal(past.tasks.counts.tasks, 1);
    assert.equal(past.tasks.rows.some((row) => row.id === second), false);
    assert.equal(past.later.tasksRecorded, 1);

    const later = await history(app, LATE);
    assert.equal(later.tasks.counts.tasks, 2);
    assert.equal(later.tasks.rows.some((row) => row.id === first), true);
    assert.equal(later.tasks.rows.some((row) => row.id === second), true);
  });

  test('two reads of one cutoff agree, and a later cutoff reveals a later transition without moving the past', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const goal = await addGoal(app);
    setNow(MID);
    await startGoal(app, goal.id);
    await addPlan(app);
    await addTask(app);
    setNow(AFTER);
    const opId = await operation(app, { requestedAt: AFTER });
    await app.goals.addEvidence(goal.id, { criterionId: 'c1', kind: 'supports', operationId: opId });
    await app.goals.transition(goal.id, 'completed');

    const first = await history(app, CUTOFF);
    const second = await history(app, CUTOFF);
    // Every cutoff-capable section is a pure function of the records stored by the cutoff. The
    // operations section is a current read: each completed reconstruction appends its own audit line,
    // so its totals necessarily grow. That growth is disclosed, not smoothed away.
    const cutoffOnly = (view) => JSON.stringify({
      cutoff: view.cutoff,
      goals: view.goals,
      plans: view.plans,
      tasks: view.tasks,
      operationCitations: view.operationCitations,
      cutoffSemantics: view.cutoffSemantics,
      unsupported: view.unsupported,
      authorizes: view.authorizes,
      limits: view.limits,
      later: { ...view.later, operationsFinishedLater: null },
    });
    assert.equal(cutoffOnly(first), cutoffOnly(second));
    assert.equal(first.goals.rows[0].status, 'active');
    assert.equal(second.operations.counts.total > first.operations.counts.total, true);

    const later = await history(app, LATE);
    assert.equal(later.goals.rows[0].status, 'completed');
    assert.equal(later.goals.rows[0].completion.at, AFTER);
    assert.equal(first.goals.rows[0].status, 'active', 'the earlier cutoff was not rewritten');
    assert.equal(first.goals.rows[0].completion, null);
  });

  test('rows are bounded per section and the bound is stated', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    for (let i = 0; i < 3; i += 1) {
      setNow(`2026-01-10T${String(9 + i).padStart(2, '0')}:00:00.000Z`);
      await addGoal(app, { request: `Record note ${i + 1}` });
    }
    setNow(MID);
    for (let i = 0; i < 3; i += 1) await operation(app, { requestedAt: MID });

    const view = await history(app, CUTOFF, { limit: 2 });
    assert.equal(view.limits.rows, 2);
    assert.equal(view.limits.citations, 40);
    assert.equal(view.goals.rows.length, 2);
    assert.equal(view.goals.total, 3);
    assert.equal(view.goals.counts.goals, 3);
    assert.equal(view.goals.truncated, true);
    assert.equal(view.operations.rows.length <= 2, true);
    assert.equal(view.operations.truncated, true);

    const rendered = String((await app.controller.historyReconstruct({ at: CUTOFF, limit: 2 })).display);
    assert.match(rendered, /1 older goal\(s\) not shown/);
  });

  test('adversarial input and model origin cannot manufacture approval, verification, or authority', async () => {
    const dir = tempDir();
    const { app } = appOn(dir, CUTOFF);
    const before = bytesOf(dir);

    const extra = await app.controller.runAction('history.reconstruct', { at: CUTOFF, authorizes: true }, 'user', 'ap17-adversarial-1');
    assert.equal(extra.outcome, Outcome.INPUT_REJECTED);
    assert.match(extra.summary, /unexpected input field/);

    const tooMany = await app.controller.historyReconstruct({ at: CUTOFF, limit: 1000 });
    assert.notEqual(tooMany.status, Outcome.SUCCESS_VERIFIED);
    assert.match(String(tooMany.display ?? tooMany.output), /limit must be an integer from 1 to 50/);

    const step = await app.controller.runAction('history.reconstruct', { at: CUTOFF }, 'model', 'ap17-model-read');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
    assert.equal(step.result.data.view.authorizes, false);
    assert.equal((await app.goals.load()).goals.size, 0);
    assert.equal((await app.plans.load()).plans.size, 0);
    assert.equal((await app.taskStore.load()).tasks.size, 0);
    assert.deepEqual(bytesOf(dir), before, 'a read that authorizes nothing writes no store');
  });

  test('history --at answers as data and as a bounded listing through the CLI', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, EARLY);
    const goal = await addGoal(app);
    setNow(MID);
    await startGoal(app, goal.id);
    const env = cleanEnv({ APEX_DATA_DIR: dir });

    const res = await runCli(['history', '--at', CUTOFF, '--json'], env);
    assert.equal(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.split('\nAudit: recorded in operations.jsonl')[0]);
    assert.equal(parsed.view.schema, 'apex.cognitive-history.v1');
    assert.equal(parsed.view.cutoff, CUTOFF);
    assert.equal(parsed.view.authorizes, false);
    assert.equal(parsed.view.goals.counts.goals, 1);

    const display = await runCli(['history', '--at', CUTOFF], env);
    assert.equal(display.code, 0, display.stderr);
    assert.match(display.stdout, /Cognitive history at 2026-01-15T12:00:00.000Z/);
    assert.match(display.stdout, /goals: 1 goal\(s\) recorded by then, 1 live, 0 completed/);
    assert.match(display.stdout, /operations: \d+ audit record\(s\), current read only/);
    assert.match(display.stdout, /unsupported: memory, knowledge/);
    assert.match(display.stdout, /rule: a cutoff replays only records stored at or before it/);
  });
});
