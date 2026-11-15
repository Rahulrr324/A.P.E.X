// Work review: one read-only portfolio over the recorded goals, plans, and tasks. The tests
// below drive the real controller, action registry, stores, router, and CLI against a temporary
// data directory. Attention items are checked against recorded status and recorded deadlines
// only, never against a model or an inferred priority.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { route } from '../src/controller/router.js';

const NOW = new Date('2026-11-15T12:00:00.000Z');

async function appOn(dir) {
  return createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF, now: () => NOW });
}

function planStep(id) {
  return {
    id,
    description: 'list the memory records',
    action: 'memory.list',
    input: {},
    dependsOn: [],
    expectedResult: 'the memory records are listed',
    verification: 'the listing is read back from the memory store',
  };
}

function taskReadStep(id) {
  return {
    id,
    description: 'list the memory records',
    action: 'memory.list',
    permission: 'read',
    input: {},
    dependsOn: [],
  };
}

async function createTask(app, { taskId, goal = 'a recorded task', origin = 'user', write = false }) {
  const step = write
    ? { id: 's1', description: 'remember a fact', action: 'memory.add', permission: 'write', input: { content: 'fixture' }, dependsOn: [] }
    : taskReadStep('s1');
  await app.taskStore.createTask({ taskId, goal, origin, planner: 'deterministic', steps: [step], reason: 'recorded for the review fixture' });
  return taskId;
}

async function pauseTask(app, taskId) {
  await app.taskStore.transition(taskId, {
    reason: 'the task was started',
    task: { from: 'pending', to: 'running' },
  });
  await app.taskStore.transition(taskId, {
    reason: 'the write step waits for the owner',
    task: { from: 'running', to: 'paused' },
    steps: [{ id: 's1', from: 'pending', to: 'awaiting_approval' }],
  });
}

async function failTask(app, taskId) {
  await app.taskStore.transition(taskId, {
    reason: 'the task was started',
    task: { from: 'pending', to: 'running' },
    steps: [{ id: 's1', from: 'pending', to: 'running' }],
  });
  await app.taskStore.transition(taskId, {
    reason: 'the step failed',
    task: { from: 'running', to: 'failed' },
    steps: [{ id: 's1', from: 'running', to: 'failed' }],
  });
}

function attentionKinds(res) {
  return res.operation.steps[0].result.data.attention.map((item) => item.kind);
}

test('an empty board says nothing is recorded, not that nothing is due', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appOn(dir);
    const res = await app.controller.workReview();
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    const data = res.operation.steps[0].result.data;
    assert.deepEqual(
      [data.counts.goals.total, data.counts.plans.total, data.counts.tasks.total],
      [0, 0, 0],
    );
    assert.deepEqual(data.attention, []);
    assert.equal(data.sources.goals.state, 'ok');
    assert.match(res.display, /Needs attention: nothing derived/);
    assert.match(res.display, /Goals: none recorded/);
    assert.match(res.display, /Tasks: none recorded/);
    // The note is what keeps an empty board from reading as a verdict on the owner's work.
    assert.match(res.display, /empty board is not evidence that nothing needs doing/);
  } finally {
    cleanup(dir);
  }
});

test('open work is listed with the recorded status, and attention is derived only from records', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appOn(dir);

    // A goal whose recorded deadline is inside the default horizon, and no plan linked yet.
    const near = await app.controller.goalAdd({
      request: 'ship the release notes',
      criteria: ['the notes are published'],
      deadline: '2026-11-18T00:00:00.000Z',
    });
    assert.equal(near.status, Outcome.GOAL_CREATED, near.output);
    const nearId = near.operation.steps[0].result.data.goalId;
    assert.equal((await app.controller.goalUpdate({ target: nearId, status: 'accepted' })).status, Outcome.GOAL_UPDATED);

    // A goal whose recorded deadline passed while the goal is still open.
    const late = await app.controller.goalAdd({
      request: 'renew the vendor contract',
      criteria: ['the contract is signed'],
      deadline: '2026-11-10T00:00:00.000Z',
    });
    const lateId = late.operation.steps[0].result.data.goalId;
    assert.equal((await app.controller.goalUpdate({ target: lateId, status: 'accepted' })).status, Outcome.GOAL_UPDATED);

    // A linked plan that is approved but has not been activated.
    const planned = await app.controller.planAdd({
      goalId: nearId,
      outcome: 'the release notes are published',
      steps: [planStep('s1')],
    });
    assert.equal(planned.status, Outcome.PLAN_STORED, planned.output);
    const nearPlanId = planned.operation.steps[0].result.data.planId;
    assert.equal((await app.controller.planApprove({ target: nearPlanId })).status, Outcome.PLAN_STORED);

    // A blocked plan records its own reason.
    const blockedPlan = await app.controller.planAdd({
      outcome: 'the migration runs',
      steps: [planStep('s1')],
    });
    const blockedPlanId = blockedPlan.operation.steps[0].result.data.planId;
    assert.equal((await app.controller.planApprove({ target: blockedPlanId })).status, Outcome.PLAN_STORED);
    await app.plans.setStatus(blockedPlanId, 'blocked', { reason: 'waiting on the vendor window' });

    await createTask(app, { taskId: 'work-review-paused', goal: 'publish the notes', write: true });
    await pauseTask(app, 'work-review-paused');
    await createTask(app, { taskId: 'work-review-failed', goal: 'refresh the index' });
    await failTask(app, 'work-review-failed');
    await createTask(app, { taskId: 'work-review-proposed', goal: 'a model suggestion', origin: 'model' });

    const res = await app.controller.workReview();
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    const data = res.operation.steps[0].result.data;

    assert.equal(data.counts.goals.total, 2);
    assert.equal(data.counts.goals.open, 2);
    assert.equal(data.counts.plans.total, 2);
    assert.equal(data.counts.tasks.total, 3);
    assert.equal(data.counts.tasks.open, 3);

    const kinds = attentionKinds(res);
    assert.ok(kinds.includes('goal_deadline'), 'a near recorded deadline is called out');
    assert.ok(kinds.includes('goal_overdue'), 'a passed recorded deadline is called out');
    assert.ok(kinds.includes('goal_without_plan'), 'an accepted goal with no plan is called out');
    assert.ok(kinds.includes('plan_approved_not_active'), 'an approved plan nobody started is waiting');
    assert.ok(kinds.includes('plan_blocked'));
    assert.ok(kinds.includes('task_paused'));
    assert.ok(kinds.includes('task_failed'));
    assert.ok(kinds.includes('task_awaiting_approval'));

    const byKind = Object.fromEntries(data.attention.map((item) => [item.kind, item]));
    assert.match(byKind.goal_overdue.detail, /passed \d+ day\(s\) ago/);
    assert.match(byKind.plan_blocked.detail, /waiting on the vendor window/);
    // The linked goal names its plan, so the linkage is visible without a second read.
    const nearGoal = data.goals.find((goal) => goal.id === nearId);
    assert.deepEqual(nearGoal.plans, [nearPlanId.slice(0, 8)]);
    assert.equal(data.goals.find((goal) => goal.id === lateId).blockedReason, null);

    assert.match(res.display, /\[blocked\] plan /);
    assert.match(res.display, /\[overdue\] goal /);
    assert.match(res.display, /\[waiting\] task work-rev/);
  } finally {
    cleanup(dir);
  }
});

test('a deadline outside the horizon is not called out, and the horizon is reported', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appOn(dir);
    const far = await app.controller.goalAdd({
      request: 'plan next year',
      criteria: ['the year is planned'],
      deadline: '2027-06-01T00:00:00.000Z',
    });
    const farId = far.operation.steps[0].result.data.goalId;
    await app.controller.goalUpdate({ target: farId, status: 'accepted' });

    const wide = await app.controller.workReview({ horizonDays: 365 });
    assert.equal(wide.status, Outcome.SUCCESS_VERIFIED, wide.output);
    const wideData = wide.operation.steps[0].result.data;
    assert.equal(wideData.horizonDays, 365);
    assert.ok(attentionKinds(wide).includes('goal_deadline'));

    const narrow = await app.controller.workReview({ horizonDays: 7 });
    const narrowData = narrow.operation.steps[0].result.data;
    assert.equal(narrowData.horizonDays, 7);
    assert.ok(!attentionKinds(narrow).includes('goal_deadline'));
  } finally {
    cleanup(dir);
  }
});

test('a store that cannot be read is reported unavailable while the others are still shown', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appOn(dir);
    const goal = await app.controller.goalAdd({ request: 'keep the board readable', criteria: ['it is readable'] });
    assert.equal(goal.status, Outcome.GOAL_CREATED);
    await createTask(app, { taskId: 'work-review-task' });

    // A corrupt line makes the goal log refuse a complete read. The review must say so and
    // must not present the goal log as empty.
    fs.appendFileSync(path.join(dir, 'goals.jsonl'), 'not a json record\n');

    const res = await app.controller.workReview();
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    const data = res.operation.steps[0].result.data;
    assert.equal(data.sources.goals.state, 'unavailable');
    assert.equal(data.sources.goals.records, null);
    assert.equal(data.sources.tasks.state, 'ok');
    assert.equal(data.counts.tasks.total, 1);
    assert.match(res.display, /Goals: unavailable - the store could not be read/);
    assert.match(res.display, /Tasks \(1 shown\):/);
    assert.match(res.display, /A source that could not be read is reported as unavailable, not as empty: goals\./);
  } finally {
    cleanup(dir);
  }
});

test('limit and horizon are bounded, and a rejected request records nothing else', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appOn(dir);
    for (const input of [{ limit: 0 }, { limit: 51 }, { horizonDays: -1 }, { horizonDays: 366 }, { limit: 1.5 }]) {
      const res = await app.controller.workReview(input);
      assert.equal(res.status, Outcome.INPUT_REJECTED, JSON.stringify(input));
      assert.match(res.output, /must be an integer/);
    }
    const accepted = await app.controller.workReview({ limit: 1, horizonDays: 0 });
    assert.equal(accepted.status, Outcome.SUCCESS_VERIFIED, accepted.output);
  } finally {
    cleanup(dir);
  }
});

test('natural-language requests route to the review action and answer through handle', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appOn(dir);
    await app.controller.goalAdd({ request: 'the board is answered in words', criteria: ['it is'] });

    for (const text of [
      'work review',
      'review my work',
      'review work',
      'what am I working on?',
      "what's blocked?",
      'what is blocked now',
      'what needs attention',
      'what needs my attention?',
    ]) {
      const routed = route(text);
      assert.equal(routed.action, 'work.review', text);
    }

    const res = await app.controller.handle('what needs my attention?');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    assert.equal(res.operation.capability, 'work.review');
    assert.match(res.output, /work review:/);
    assert.match(res.display, /the board is answered in words/);
  } finally {
    cleanup(dir);
  }
});

test('the review is available as a CLI command with the same bounds', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appOn(dir);
    const goal = await app.controller.goalAdd({
      request: 'the CLI shows the whole board',
      criteria: ['it does'],
      deadline: '2026-11-10T00:00:00.000Z',
    });
    assert.equal(goal.status, Outcome.GOAL_CREATED);
    await createTask(app, { taskId: 'work-review-cli' });
    const env = cleanEnv({ APEX_DATA_DIR: dir });

    const reviewed = await runCli(['review'], env);
    assert.equal(reviewed.code, 0, reviewed.stderr);
    assert.match(reviewed.stdout, /Work review \(read-only/);
    assert.match(reviewed.stdout, /goals: 1 total, 1 open/);
    assert.match(reviewed.stdout, /the CLI shows the whole board/);
    assert.match(reviewed.stdout, /Needs attention/);

    const bounded = await runCli(['review', '--limit', '1', '--days', '0'], env);
    assert.equal(bounded.code, 0, bounded.stderr);
    assert.match(bounded.stdout, /within 0 day\(s\) for deadlines/);

    const refused = await runCli(['review', '--limit', '0'], env);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr + refused.stdout, /limit must be an integer/);

    const unexpected = await runCli(['review', 'extra'], env);
    assert.equal(unexpected.code, 2);
  } finally {
    cleanup(dir);
  }
});