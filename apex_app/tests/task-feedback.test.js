// User-confirmed task outcome feedback: the assessment is the user's, it is tied to a run the
// audit log shows as verified, and an execution that succeeded is never treated as proof of the
// intended outcome on its own. These tests drive the real controller, task store, audit log,
// experience store, router and CLI; nothing is a model inference.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { TaskStatus, StepStatus } from '../src/tasks/model.js';
import { route } from '../src/controller/router.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
function appOn(dir) {
  return createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF });
}

function readStep(id = 's1') {
  return { id, description: 'list the memory records', action: 'memory.list', permission: 'read', input: {}, dependsOn: [] };
}

async function createTask(app, { taskId, goal = 'list the memory records', origin = 'user', steps = [readStep()] } = {}) {
  const id = taskId ?? `feedback-task-${randomUUID().slice(0, 8)}`;
  await app.taskStore.createTask({ taskId: id, goal, origin, planner: 'deterministic', steps, reason: 'recorded for the feedback fixture' });
  return id;
}

async function completedTask(app, options = {}) {
  const taskId = await createTask(app, options);
  const run = await app.controller.runTask(taskId, 'run');
  assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.display);
  return { taskId, run };
}

function stepResult(res) {
  return res.operation.steps[0].result;
}

test('a completed task with a verified run carries the user\'s assessment, kept separate from the evidence', async () => {
  const app = appOn(tempDir());
  const { taskId } = await completedTask(app, { goal: 'publish the weekly notes' });

  const scan = await app.operations.findTaskRuns(taskId);
  assert.equal(scan.runs.length, 1, 'the completed run is in the audit log');
  assert.equal(scan.runs[0].status, Outcome.SUCCESS_VERIFIED);
  assert.equal(scan.runs[0].taskStatus, TaskStatus.COMPLETED);

  const res = await app.controller.taskFeedback(taskId, { assessment: 'useful', guidance: 'keep listing before writing' });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
  assert.equal(res.recorded, true);
  assert.equal(res.operation.capability, 'task.feedback');
  assert.match(res.display, /Recorded your feedback/);
  assert.match(res.display, /assessment: useful/);
  assert.match(res.display, /Nothing changes yet: a behaviour change needs a derived candidate and your explicit approval\./);

  const data = stepResult(res).data;
  assert.equal(data.task.id, taskId);
  assert.equal(data.task.status, TaskStatus.COMPLETED);
  assert.equal(data.run.id, scan.runs[0].id);
  assert.equal(data.run.status, Outcome.SUCCESS_VERIFIED);
  assert.deepEqual(data.steps, { completed: 1, total: 1 });
  assert.equal(data.experience.created, true);

  const view = await app.experience.feedbackFor(data.experience.id);
  assert.equal(view.experience.operationId, scan.runs[0].id, 'the experience cites the verified run');
  assert.equal(view.experience.provenance.origin, 'user_recorded');
  assert.equal(view.experience.adaptationEligible, true);
  assert.equal(view.current.length, 1);
  assert.equal(view.current[0].assessment, 'useful');
  assert.equal(view.current[0].guidance, 'keep listing before writing');
  assert.equal(view.current[0].provenance.origin, 'user_feedback');
  assert.equal(view.current[0].provenance.updateMode, 'user_confirmed');
  assert.equal(view.current[0].operationId, res.operation.id, 'the feedback names the operation that recorded it');
  assert.equal((await app.experience.list()).length, 1, 'one experience, not a second account of the run');
});

test('a later assessment corrects the earlier one and the earlier record stays readable', async () => {
  const app = appOn(tempDir());
  const { taskId } = await completedTask(app);

  const first = await app.controller.taskFeedback(taskId, { assessment: 'useful' });
  assert.equal(first.status, Outcome.SUCCESS_VERIFIED, first.display);
  const firstData = stepResult(first).data;

  const second = await app.controller.taskFeedback(taskId, {
    assessment: 'incorrect',
    reason: 'the notes were stored under the wrong heading',
    supersedes: [firstData.feedback.id],
  });
  assert.equal(second.status, Outcome.SUCCESS_VERIFIED, second.display);
  const secondData = stepResult(second).data;
  assert.equal(secondData.experience.created, false, 'the same experience is reused');
  assert.deepEqual(secondData.feedback.supersededIds, [firstData.feedback.id]);

  const view = await app.experience.feedbackFor(secondData.experience.id);
  assert.equal(view.experience.id, firstData.experience.id);
  assert.ok(view.history.some((entry) => entry.id === firstData.feedback.id), 'the corrected feedback is still in history');
  assert.ok(!view.current.some((entry) => entry.id === firstData.feedback.id), 'the corrected feedback is no longer current');
  assert.ok(view.current.some((entry) => entry.id === secondData.feedback.id));
});

test('a task that is not completed is refused and nothing is written', async () => {
  const app = appOn(tempDir());
  const taskId = await createTask(app);

  const res = await app.controller.taskFeedback(taskId, { assessment: 'useful' });
  assert.equal(res.status, Outcome.EXECUTION_FAILED);
  assert.match(res.display, /is pending, not completed/);
  assert.equal((await app.experience.list()).length, 0);
});

test('a task that stopped on a failure is refused as an outcome that cannot be assessed', async () => {
  const app = appOn(tempDir());
  const taskId = await createTask(app);
  await app.taskStore.transition(taskId, {
    reason: 'the task was started',
    task: { from: TaskStatus.PENDING, to: TaskStatus.RUNNING },
    steps: [{ id: 's1', from: StepStatus.PENDING, to: StepStatus.RUNNING }],
  });
  await app.taskStore.transition(taskId, {
    reason: 'the step failed',
    task: { from: TaskStatus.RUNNING, to: TaskStatus.FAILED },
    steps: [{ id: 's1', from: StepStatus.RUNNING, to: StepStatus.FAILED }],
  });

  const res = await app.controller.taskFeedback(taskId, { assessment: 'outcome_failed' });
  assert.equal(res.status, Outcome.EXECUTION_FAILED);
  assert.match(res.display, /is failed, not completed/);
  assert.equal((await app.experience.list()).length, 0);
});

test('a completed task with no audited run is refused, not assumed', async () => {
  const dir = tempDir();
  const app = appOn(dir);
  const { taskId } = await completedTask(app);

  // Remove the run record from the audit log. The task log still says completed and the step
  // record is there; what is missing is the run that would have to stand behind the assessment.
  const log = path.join(dir, 'operations.jsonl');
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const kept = lines.filter((line) => JSON.parse(line).capability !== 'task.run');
  assert.equal(kept.length, lines.length - 1);
  fs.writeFileSync(log, `${kept.join('\n')}\n`);

  const res = await app.controller.taskFeedback(taskId, { assessment: 'useful' });
  assert.equal(res.status, Outcome.EXECUTION_FAILED);
  assert.match(res.display, /no audited run record names it/);
  assert.equal((await app.experience.list()).length, 0);
});

test('a completed task whose step has no audit record is refused', async () => {
  const app = appOn(tempDir());
  const taskId = await createTask(app);
  // The task log can be moved to completed without a step operation id; the action must notice
  // that no independent account of the step exists rather than trust the status alone.
  await app.taskStore.transition(taskId, {
    reason: 'started outside the runner',
    task: { from: TaskStatus.PENDING, to: TaskStatus.RUNNING },
    steps: [{ id: 's1', from: StepStatus.PENDING, to: StepStatus.RUNNING }],
  });
  await app.taskStore.transition(taskId, {
    reason: 'marked completed without a recorded step operation',
    task: { from: TaskStatus.RUNNING, to: TaskStatus.COMPLETED },
    steps: [{ id: 's1', from: StepStatus.RUNNING, to: StepStatus.COMPLETED }],
  });

  const res = await app.controller.taskFeedback(taskId, { assessment: 'useful' });
  assert.equal(res.status, Outcome.EXECUTION_FAILED);
  assert.match(res.display, /cannot be found in the audit log/);
  assert.equal((await app.experience.list()).length, 0);
});

test('model output cannot write the user\'s assessment', async () => {
  const app = appOn(tempDir());
  const { taskId } = await completedTask(app);

  const step = await app.controller.runAction('task.feedback', { taskId, assessment: 'useful' }, 'model', randomUUID());
  assert.equal(step.outcome, Outcome.ACTION_DENIED);
  assert.equal((await app.experience.list()).length, 0);
});

test('invalid assessments and fields are refused before anything is read or written', async () => {
  const app = appOn(tempDir());
  const { taskId } = await completedTask(app);
  const cases = [
    [{ taskId, assessment: 'pretty good' }, /assessment must be one of/],
    [{ taskId, assessment: 'useful', extra: true }, /unexpected field "extra"/],
    [{ taskId: '', assessment: 'useful' }, /taskId must not be empty/],
    [{ taskId, assessment: 'useful', guidance: 7 }, /guidance must be text/],
    [{ taskId, assessment: 'useful', supersedes: 'f-1' }, /supersedes must be an array/],
  ];
  for (const [input, pattern] of cases) {
    const step = await app.controller.runAction('task.feedback', input, 'user', randomUUID());
    assert.equal(step.outcome, Outcome.INPUT_REJECTED, JSON.stringify(input));
    assert.match(step.summary, pattern);
  }
  assert.equal((await app.experience.list()).length, 0, 'no partial record was written');
});

test('natural-language feedback routes deterministically to the action', async () => {
  const app = appOn(tempDir());
  const { taskId } = await completedTask(app);

  const rating = route(`rate task ${taskId} useful`);
  assert.equal(rating.action, 'task.feedback');
  assert.deepEqual(rating.input, { taskId, assessment: 'useful' });
  assert.deepEqual(route(`judge task ${taskId} as not useful`).input, { taskId, assessment: 'not_useful' });
  assert.deepEqual(route(`feedback on task ${taskId}: partially correct`).input, { taskId, assessment: 'partially_correct' });

  const res = await app.controller.handle(`rate task ${taskId} useful`);
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
  assert.equal(res.operation.capability, 'task.feedback');
  assert.match(res.display, /assessment: useful/);
});

test('the CLI records feedback with the same checks and exit codes', async () => {
  const dir = tempDir();
  const app = appOn(dir);
  const { taskId } = await completedTask(app);
  const env = cleanEnv({ APEX_DATA_DIR: dir });

  const ok = await runCli(['task', 'feedback', taskId, 'outcome_succeeded', '--guidance', 'keep the same order'], env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /Recorded your feedback/);
  assert.match(ok.stdout, /assessment: outcome_succeeded/);
  assert.match(ok.stdout, /guidance: keep the same order/);

  const refused = await runCli(['task', 'feedback', taskId, 'maybe'], env);
  assert.equal(refused.code, 1);
  assert.match(`${refused.stdout}${refused.stderr}`, /assessment must be one of/);

  const usage = await runCli(['task', 'feedback', taskId], env);
  assert.equal(usage.code, 2);
});