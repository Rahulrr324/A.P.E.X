// T-17 lifecycle: milestones as recorded checkpoints, and the pause/resume hold.
//
// A milestone is a plan-level record the user can inspect on its own - the steps grouped under it and
// the checkpoint that settles it - so these tests drive it through the same controller commands a user
// types. The hold is the new state: `plan pause` records a decision, `plan resume` lifts it only when
// the approval still binds the content and the plan's own task is not running, and a continuation
// refuses to take a held plan up while the hold stands. Every record here is synthetic and no model is
// contacted.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { PlanStatus, planContentHash } from '../src/plans/model.js';
import { continuationOf } from '../src/plans/continuation.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
after(() => { while (dirs.length) cleanup(dirs.pop()); });

async function appIn(extraActions = []) {
  const dir = makeTempDataDir();
  dirs.push(dir);
  const app = await createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF, extraActions });
  return { app, dir };
}

function dataOf(res) {
  return res.operation.steps[0].result.data;
}

const MEMORY_READ = (id, milestoneId) => ({
  id,
  description: `read the memory list for ${id}`,
  action: 'memory.list',
  input: {},
  dependsOn: [],
  expectedResult: 'the stored list is read back',
  verification: 'the operation record names memory.list',
  risk: 'low',
  ...(milestoneId ? { milestoneId } : {}),
});

const MILESTONE = (id, title, dependsOn = []) => ({
  id,
  title,
  description: `${title}: the phase the steps under it carry out`,
  dependsOn,
  checkpoint: `${title} is settled when its steps hold verified outcomes`,
  verification: 'every step grouped under this milestone holds an operation record whose outcome is verified',
});

async function draftPlan(app, { milestones = [], steps = [MEMORY_READ('s1')], outcome = 'the list is read back' } = {}) {
  const res = await app.controller.planAdd({ outcome, steps, milestones });
  assert.equal(res.status, Outcome.PLAN_STORED, `plan add failed: ${res.output}`);
  return dataOf(res).planId;
}

test('milestones are recorded, grouped, and shown with the checkpoint that settles each', async () => {
  const { app } = await appIn();
  const planId = await draftPlan(app, {
    milestones: [MILESTONE('m1', 'Read'), MILESTONE('m2', 'Confirm', ['m1'])],
    steps: [MEMORY_READ('s1', 'm1'), MEMORY_READ('s2', 'm2')],
  });

  const shown = await app.controller.showPlan(planId);
  const text = shown.display;
  assert.match(text, /^Milestones \(2\):$/m);
  assert.match(text, /^ {2}m1 {2}Read$/m);
  assert.match(text, /^ {2}m2 {2}Confirm \| after m1$/m);
  assert.match(text, /checkpoint: Read is settled when its steps hold verified outcomes/);
  assert.match(text, /steps: s1/);
  assert.match(text, /steps: s2/);
  assert.match(text, /milestone m1/);
  assert.equal(shown.plan.milestones.length, 2);
  assert.equal(shown.plan.milestones[1].dependsOn[0], 'm1');
});

test('a milestone that groups nothing, cycles, or names a dependency outside the plan is refused before it is stored', async () => {
  const { app, dir } = await appIn();
  // One valid plan first, so the file exists and a later append would be visible.
  await draftPlan(app);
  const before = fs.readFileSync(path.join(dir, 'plans.jsonl'), 'utf8');

  // A recorded milestone must group at least one step; otherwise the checkpoint settles nothing.
  const ungrouped = await app.controller.planAdd({
    outcome: 'the list is read back',
    milestones: [MILESTONE('m1', 'Read')],
    steps: [MEMORY_READ('s1')],
  });
  assert.notEqual(ungrouped.status, Outcome.PLAN_STORED);

  // A step naming a milestone the plan does not record.
  const unknown = await app.controller.planAdd({
    outcome: 'the list is read back',
    steps: [MEMORY_READ('s1', 'm9')],
  });
  assert.notEqual(unknown.status, Outcome.PLAN_STORED);

  // A cycle between milestones is refused by the reducer's own dependency walk.
  const cycle = await app.controller.planAdd({
    outcome: 'the list is read back',
    milestones: [MILESTONE('m1', 'Read', ['m2']), MILESTONE('m2', 'Confirm', ['m1'])],
    steps: [MEMORY_READ('s1', 'm1'), MEMORY_READ('s2', 'm2')],
  });
  assert.notEqual(cycle.status, Outcome.PLAN_STORED);

  assert.equal(fs.readFileSync(path.join(dir, 'plans.jsonl'), 'utf8'), before, 'a refused plan wrote nothing');
});

test('a plan records the hold and gives it back: pause needs a reason, resume restores the state the record supports', async () => {
  const { app } = await appIn();
  const planId = await draftPlan(app);
  assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);

  const hold = await app.controller.planPause({ target: planId, reason: 'user asked to hold it' });
  assert.equal(hold.status, Outcome.PLAN_STORED, hold.output);
  assert.equal((await app.controller.showPlan(planId)).plan.status, PlanStatus.PAUSED);

  const resumed = await app.controller.planResume({ target: planId });
  assert.equal(resumed.status, Outcome.PLAN_STORED, resumed.output);
  const after = await app.controller.showPlan(planId);
  assert.equal(after.plan.status, PlanStatus.APPROVED, 'a plan that never ran resumes to approved, not active');
  assert.equal(after.plan.activation ?? null, null);

  // The hold and the lift are both in the plan's own history, with the reason the user gave.
  assert.ok(after.plan.history.some((h) => h.kind === 'status:paused' && h.reason === 'user asked to hold it'));
  assert.ok(after.plan.history.some((h) => h.kind === 'status:approved'));
});

test('a pause with no reason, or a resume of a plan that is not paused, is refused and changes nothing', async () => {
  const { app, dir } = await appIn();
  const planId = await draftPlan(app);
  assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);
  const before = fs.readFileSync(path.join(dir, 'plans.jsonl'), 'utf8');

  const noReason = await app.controller.planPause({ target: planId });
  assert.notEqual(noReason.status, Outcome.PLAN_STORED);
  const notPaused = await app.controller.planResume({ target: planId });
  assert.notEqual(notPaused.status, Outcome.PLAN_STORED, 'an approved plan has no hold to lift');

  assert.equal(fs.readFileSync(path.join(dir, 'plans.jsonl'), 'utf8'), before, 'refusals wrote no plan record');
});

test('a plan whose own task is running cannot be recorded as paused', async () => {
  const { PlanStore } = await import('../src/plans/store.js');
  const { ActionRegistry } = await import('../src/actions/registry.js');
  const dir = makeTempDataDir();
  dirs.push(dir);
  const registry = new ActionRegistry();
  registry.register({
    name: 'test.read',
    description: 'test-only read',
    inputHint: '{}',
    permission: 'read',
    origins: ['user', 'model'],
    validate: (input) => input ?? {},
    async execute() { return { summary: 'read', data: {}, display: 'read' }; },
    verify: null,
  });
  // The plan store reads the bound task read-only. A running task is the one state a hold cannot be
  // written into: the step already in flight cannot be stopped by recording a decision about it.
  const store = new PlanStore(path.join(dir, 'plans.jsonl'), {
    registry,
    tasks: { get: async () => ({ id: 't-running', status: 'running' }) },
  });
  const created = await store.createPlan({
    outcome: 'the list is read back',
    steps: [{ ...MEMORY_READ('s1'), action: 'test.read' }],
  });
  await store.approve(created.plan.id);
  await store.activate(created.plan.id, { taskId: 't-running' });
  await assert.rejects(
    () => store.pause(created.plan.id, { reason: 'hold it' }),
    /running/,
  );
  assert.equal((await store.get(created.plan.id)).status, PlanStatus.ACTIVE);
});

test('a continuation reading refuses a held plan and names the command that lifts it', async () => {
  const approvalPlan = {
    id: 'p1',
    goalId: null,
    version: 1,
    status: PlanStatus.PAUSED,
    outcome: 'the list is read back',
    steps: [MEMORY_READ('s1')],
    stepResults: {},
    preconditions: [],
    assertions: [],
    history: [],
  };
  approvalPlan.approval = { version: 1, contentHash: planContentHash(approvalPlan) };
  const task = {
    id: 't1',
    planId: 'p1',
    status: 'paused',
    origin: 'user',
    steps: [{ id: 's1', status: 'pending', action: 'memory.list', input: {}, dependsOn: [], approval: null }],
  };

  const reading = continuationOf({ plan: approvalPlan, task, operations: [], registry: null });
  assert.equal(reading.ok, true);
  assert.equal(reading.continue.safe, false, 'a held plan is not taken up');
  assert.ok(reading.blockers.some((b) => b.startsWith('plan_held:')), reading.blockers.join('\n'));
  assert.match(reading.blockers.join('\n'), /"plan resume"/);
  assert.equal(reading.nextCommand, 'plan resume p1');
});

test('a resumed plan can be approved again by the same approval, and its content hash did not move', async () => {
  const { app } = await appIn();
  const planId = await draftPlan(app);
  assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);
  const approved = await app.controller.showPlan(planId);
  const hash = planContentHash(approved.plan);

  assert.equal((await app.controller.planPause({ target: planId, reason: 'hold' })).status, Outcome.PLAN_STORED);
  const paused = await app.controller.showPlan(planId);
  assert.equal(planContentHash(paused.plan), hash, 'a hold is a status, not a content change');
  assert.equal(paused.plan.approval.contentHash, hash);

  assert.equal((await app.controller.planResume({ target: planId })).status, Outcome.PLAN_STORED);
  const resumed = await app.controller.showPlan(planId);
  assert.equal(planContentHash(resumed.plan), hash);
  assert.equal(resumed.plan.status, PlanStatus.APPROVED);

  // The approval is still the one that bound these bytes, so starting it is the user's next act.
  const started = await app.controller.planActivate(planId, { mode: 'run' });
  assert.equal(started.status, Outcome.SUCCESS_VERIFIED, started.output);
});
