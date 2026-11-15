// Practical capability evaluation for the personal-assistant sprint. The ten dimensions the
// sprint names are measured one at a time, each through the real controller, router, action
// registry, task store, experience store, audit log and shipped CLI. No language model is
// consulted: the application runs exactly as an offline installation does, and the only fake
// actions are labelled test doubles whose behaviour is a fixed fixture.
//
// Every dimension keeps its own denominator. A request that never plans anything says nothing
// about planning or recovery, so a scenario that does not exercise a dimension does not count
// toward it. Nothing here is combined into one score, and nothing here is a real-world
// intelligence benchmark.
import test, { afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { TaskStatus, StepStatus } from '../src/tasks/model.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv, makeFakeTaskActions } from './helpers.js';

export const DIMENSIONS = Object.freeze([
  'capability_coverage',
  'supported_completion',
  'correct_clarification',
  'unsupported_refusal',
  'authorization_correctness',
  'execution_verification',
  'recovery_correctness',
  'outcome_reporting_accuracy',
  'feedback_adaptation_integrity',
  'multi_step_workflow_completion',
]);

const observed = [];

function check(dimension, id, condition, detail) {
  const passed = Boolean(condition);
  observed.push({ dimension, id, passed, detail });
  assert.ok(passed, `${dimension} / ${id}: ${detail}`);
}

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function appOn(options = {}) {
  const dataDir = options.dataDir ?? tempDir();
  // Capture is off unless a test asks for it, so the experience store holds only what the
  // user's own feedback recorded and a passing run is never mistaken for a confirmed outcome.
  return createApp({ experienceCapture: CAPTURE_OFF, ...options, dataDir });
}

function workspaceFixture() {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nAlpha beta gamma.\n\nAlpha delta.\n');
  fs.writeFileSync(path.join(root, 'docs', 'guide.txt'), 'Guide\n\nFirst sentence.\n');
  fs.writeFileSync(path.join(root, 'docs', 'other.txt'), 'Guide\n\nFirst sentence.\n');
  return root;
}

function taskStep(id, action, dependsOn = [], input = {}, permission = 'read') {
  return { id, description: `${action} for ${id}`, action, input, permission, dependsOn };
}

async function recordTask(app, { taskId, goal, steps, origin = 'user' }) {
  await app.taskStore.createTask({
    taskId, goal, origin, planner: 'deterministic', steps, reason: 'recorded for the practical evaluation fixture',
  });
  return taskId;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// TEST DOUBLE: a read that fails once and then answers. The state object is the only sink, and
// the verifier reads it independently of the value execute returned.
function recoveryActions(state) {
  return [
    {
      name: 'recovery.count',
      description: 'test-only read that counts its own executions',
      inputHint: '{}',
      permission: 'read',
      origins: ['user', 'model'],
      validate: () => ({}),
      async execute() {
        state.counts += 1;
        return { summary: 'counted the read', data: { counts: state.counts } };
      },
      async verify() { return { ok: true, detail: 'the counter holds the read' }; },
    },
    {
      name: 'recovery.flaky',
      description: 'test-only read that fails on its first attempt only',
      inputHint: '{}',
      permission: 'read',
      origins: ['user', 'model'],
      validate: () => ({}),
      async execute() {
        state.flakyAttempts += 1;
        if (state.flakyAttempts === 1) throw new Error('the sensor did not answer on the first attempt');
        return { summary: 'the flaky read answered', data: { attempts: state.flakyAttempts } };
      },
      async verify() { return { ok: true, detail: 'the second attempt is recorded' }; },
    },
    {
      name: 'recovery.writefail',
      description: 'test-only write that fails and must never be retried',
      inputHint: '{}',
      permission: 'write',
      origins: ['user'],
      validate: () => ({}),
      async execute() {
        state.writeAttempts += 1;
        throw new Error('the write did not answer');
      },
      verify: null,
    },
  ];
}

describe('capability coverage: each practical area answers through its own registered path', () => {
  test('memory, calculation, status, knowledge, work, workspace and tasks are all reachable', async () => {
    const root = workspaceFixture();
    const app = appOn({ filesystemRoot: root });

    const cases = [
      ['remember that the launch review is on Thursday', 'memory.add'],
      ['recall launch review', 'memory.search'],
      ['list memory', 'memory.list'],
      ['calc 6*7', 'calc.evaluate'],
      ['status', 'app.status'],
      ['what can you do', 'app.capabilities'],
      ['knowledge digest', 'knowledge.digest'],
      ['work review', 'work.review'],
      ['list files in docs/', 'filesystem.list'],
      ['read notes.md', 'filesystem.read'],
      ['summarize notes.md', 'filesystem.summarize'],
      ['find files with extension txt under docs/', 'filesystem.find'],
      ['compare docs/guide.txt with docs/other.txt', 'filesystem.compare'],
      ['workspace report', 'filesystem.report'],
      ['create file draft.txt with content: draft text', 'filesystem.write'],
    ];
    for (const [request, capability] of cases) {
      const res = await app.controller.handle(request);
      check('capability_coverage', capability,
        res.status === Outcome.SUCCESS_VERIFIED && res.operation.capability === capability,
        `"${request}" ended ${res.status} at ${res.operation.capability}`);
    }

    const planned = await app.controller.planTask('list memory then calc 1+1');
    check('capability_coverage', 'task.plan', planned.status === Outcome.PLAN_CREATED, `plan ended ${planned.status}`);
    const run = await app.controller.runTask(planned.task.id, 'run');
    check('capability_coverage', 'task.run', run.status === Outcome.SUCCESS_VERIFIED, `run ended ${run.status}`);
  });
});

describe('supported completion: the answer states the requested fact', () => {
  test('memory round-trip, calculation, discovery and a file extract are answered, not deflected', async () => {
    const root = workspaceFixture();
    const app = appOn({ filesystemRoot: root });

    const remembered = await app.controller.handle('remember that the launch review is on Thursday');
    check('supported_completion', 'remember',
      remembered.status === Outcome.SUCCESS_VERIFIED && remembered.operation.capability === 'memory.add',
      `remember ended ${remembered.status}`);

    const recalled = await app.controller.handle('recall launch review');
    check('supported_completion', 'recall',
      recalled.status === Outcome.SUCCESS_VERIFIED && /Thursday/.test(recalled.display),
      `recall display: ${recalled.display}`);

    const calculated = await app.controller.handle('calc 2+2');
    check('supported_completion', 'calc',
      calculated.status === Outcome.SUCCESS_VERIFIED && /2\s*\+\s*2\s*=\s*4/.test(calculated.display),
      `calc display: ${calculated.display}`);

    const discovered = await app.controller.handle('what can you do');
    check('supported_completion', 'capability discovery',
      discovered.status === Outcome.SUCCESS_VERIFIED
        && /memory\.search/.test(discovered.display)
        && /filesystem\.summarize/.test(discovered.display),
      'the registry answer names the memory and workspace actions');

    const summarized = await app.controller.handle('summarize notes.md');
    check('supported_completion', 'workspace summarize',
      summarized.status === Outcome.SUCCESS_VERIFIED && /frequent terms/.test(summarized.display),
      `summarize display: ${summarized.display}`);
  });
});

describe('correct clarification: a request missing its target asks instead of guessing', () => {
  test('lookups, file requests, bare questions and unknown follow-ups are clarified and run nothing', async () => {
    const root = workspaceFixture();
    const app = appOn({ filesystemRoot: root });

    const requests = ['recall', 'read the file', 'why', 'do it', 'change it'];
    for (const request of requests) {
      const before = new Set((await app.operations.list({ limit: 1000 })).records.map((r) => r.id));
      const res = await app.controller.handle(request);
      const clarification = (await app.operations.list({ limit: 1000 })).records
        .filter((record) => !before.has(record.id));
      check('correct_clarification', JSON.stringify(request),
        res.status === Outcome.CLARIFICATION_REQUIRED
          && res.operation.decision === 'clarify'
          && res.operation.backend === null
          && res.display.length > 0
          && clarification.length === 1
          && clarification[0].status === Outcome.CLARIFICATION_REQUIRED,
        `"${request}" ended ${res.status} with ${clarification.length} audited record(s)`);
    }

    check('correct_clarification', 'nothing executed',
      (await app.taskStore.list()).length === 0,
      'a clarification never creates a task');
  });
});

describe('unsupported refusal: unavailable operations are refused before anything runs', () => {
  test('deletion, shell execution and disk formatting are refused without a model call', async () => {
    const root = workspaceFixture();
    const app = appOn({ filesystemRoot: root });
    const before = fs.readdirSync(root).sort();

    for (const request of ['delete everything in the workspace', 'run a shell command', 'format the disk']) {
      const res = await app.controller.handle(request);
      check('unsupported_refusal', JSON.stringify(request),
        res.status === Outcome.ACTION_DENIED
          && res.operation.capability === 'none'
          && res.operation.backend === null
          && /no capability|not sent to a model/i.test(res.display),
        `"${request}" ended ${res.status}: ${res.display}`);
    }

    check('unsupported_refusal', 'no side effects',
      JSON.stringify(fs.readdirSync(root).sort()) === JSON.stringify(before),
      'the workspace is unchanged');
  });
});

describe('authorization correctness: the registry decides, and a model never writes', () => {
  test('model-origin writes are denied while the same user-origin request is allowed', async () => {
    const root = workspaceFixture();
    const app = appOn({ filesystemRoot: root });

    check('authorization_correctness', 'write is user-only',
      app.registry.authorize('filesystem.write', 'model').decision === 'deny'
        && app.registry.authorize('filesystem.write', 'user').decision === 'allow',
      'the registry denies a model-origin write');
    check('authorization_correctness', 'write is not plannable',
      app.registry.get('filesystem.write').plannable === false,
      'a model plan cannot include a workspace write');

    const denied = await app.controller.runAction(
      'filesystem.write', { path: 'from-model.txt', content: 'model bytes' }, 'model', 'op-practical-model-write',
    );
    check('authorization_correctness', 'model write denied',
      denied.outcome === Outcome.ACTION_DENIED
        && denied.authorization.decision === 'deny'
        && /WRITE_REQUIRES_USER_APPROVAL|ORIGIN_NOT_PERMITTED/.test(denied.authorization.reason)
        && !fs.existsSync(path.join(root, 'from-model.txt')),
      `model write ended ${denied.outcome}; file exists ${fs.existsSync(path.join(root, 'from-model.txt'))}`);

    const allowed = await app.controller.workspaceWrite({ path: 'from-user.txt', content: 'user bytes' });
    check('authorization_correctness', 'user write allowed',
      allowed.status === Outcome.SUCCESS_VERIFIED
        && fs.readFileSync(path.join(root, 'from-user.txt'), 'utf8') === 'user bytes',
      `user write ended ${allowed.status}`);

    const memoryDenied = await app.controller.runAction(
      'memory.add', { content: 'a model fact' }, 'model', 'op-practical-model-memory',
    );
    check('authorization_correctness', 'model memory write denied',
      memoryDenied.outcome === Outcome.ACTION_DENIED && (await app.memory.list()).length === 0,
      `model memory write ended ${memoryDenied.outcome}`);

    const feedbackDenied = await app.controller.runAction(
      'task.feedback', { taskId: 'any-task', assessment: 'useful' }, 'model', 'op-practical-model-feedback',
    );
    check('authorization_correctness', 'model feedback denied',
      feedbackDenied.outcome === Outcome.ACTION_DENIED && (await app.experience.list()).length === 0,
      `model feedback ended ${feedbackDenied.outcome}`);
  });
});

describe('execution verification: verified, unverified and failed outcomes stay distinct', () => {
  test('an independent check decides verified success; an unavailable check is never reported as success', async () => {
    const sink = [];
    const app = appOn({ extraActions: makeFakeTaskActions(sink) });

    const verified = await app.controller.runAction('test.ok', { tag: 'one' }, 'user', 'op-practical-verified');
    check('execution_verification', 'verified action',
      verified.outcome === Outcome.SUCCESS_VERIFIED
        && verified.verification.outcome === Outcome.SUCCESS_VERIFIED
        && sink.filter((entry) => entry === 'one').length === 1,
      `verified action ended ${verified.outcome} with verification ${verified.verification.outcome}`);

    const unverified = await app.controller.runAction('test.unverified', { tag: 'two' }, 'user', 'op-practical-unverified');
    check('execution_verification', 'unverified action',
      unverified.outcome === Outcome.VERIFICATION_UNAVAILABLE
        && unverified.verification.outcome === Outcome.VERIFICATION_UNAVAILABLE
        && /verification unavailable/.test(unverified.summary),
      `unverified action ended ${unverified.outcome}`);

    const failed = await app.controller.runAction('test.fail', {}, 'user', 'op-practical-failed');
    check('execution_verification', 'failed action',
      failed.outcome === Outcome.EXECUTION_FAILED && failed.result === null,
      `failed action ended ${failed.outcome}`);

    const root = workspaceFixture();
    const workspace = appOn({ filesystemRoot: root });
    const read = await workspace.controller.runAction('filesystem.read', { path: 'notes.md' }, 'user', 'op-practical-read');
    check('execution_verification', 'workspace read verified',
      read.outcome === Outcome.SUCCESS_VERIFIED && read.verification.outcome === Outcome.SUCCESS_VERIFIED,
      `read ended ${read.outcome}`);

    const taskId = 'practical-unverified-task';
    const unverifiedTask = appOn({ extraActions: makeFakeTaskActions([]) });
    await unverifiedTask.taskStore.createTask({
      taskId,
      goal: 'read something that cannot be independently checked',
      origin: 'user',
      planner: 'deterministic',
      steps: [taskStep('s1', 'test.unverified', [], { tag: 'task' })],
      reason: 'recorded for the practical evaluation fixture',
    });
    const run = await unverifiedTask.controller.runTask(taskId, 'run');
    const stored = await unverifiedTask.taskStore.get(taskId);
    check('execution_verification', 'unverified task step',
      run.status === Outcome.VERIFICATION_UNAVAILABLE
        && stored.status === TaskStatus.FAILED
        && stored.steps[0].status === StepStatus.UNCERTAIN
        && /\[uncertain\]/.test(run.display),
      `task run ended ${run.status}; step is ${stored.steps[0].status}`);
  });
});

describe('recovery correctness: a failed read is retried without re-running completed work', () => {
  test('retry marks one step pending, the next run finishes the task, and prior steps never repeat', async () => {
    const state = { counts: 0, flakyAttempts: 0, writeAttempts: 0 };
    const app = appOn({ extraActions: recoveryActions(state) });
    const taskId = await recordTask(app, {
      taskId: 'practical-recovery-task',
      goal: 'count a read and then read the flaky sensor',
      steps: [
        taskStep('s1', 'recovery.count'),
        taskStep('s2', 'recovery.flaky', ['s1']),
      ],
    });

    const first = await app.controller.runTask(taskId, 'run');
    const failedState = await app.taskStore.get(taskId);
    check('recovery_correctness', 'failure stops the task',
      first.status === Outcome.EXECUTION_FAILED
        && failedState.status === TaskStatus.FAILED
        && failedState.steps[0].status === StepStatus.COMPLETED
        && failedState.steps[1].status === StepStatus.FAILED
        && state.flakyAttempts === 1,
      `first run ended ${first.status}; flaky attempts ${state.flakyAttempts}`);

    const retried = await app.controller.retryTask(taskId, 's2');
    const retryState = await app.taskStore.get(taskId);
    check('recovery_correctness', 'retry selects only the failed step',
      retried.status === Outcome.SUCCESS_VERIFIED
        && retryState.status === TaskStatus.PAUSED
        && retryState.steps[0].status === StepStatus.COMPLETED
        && retryState.steps[1].status === StepStatus.PENDING,
      `retry ended ${retried.status}; task is ${retryState.status}`);

    const second = await app.controller.runTask(taskId, 'resume');
    const done = await app.taskStore.get(taskId);
    check('recovery_correctness', 'second run completes without repeating step one',
      second.status === Outcome.SUCCESS_VERIFIED
        && done.status === TaskStatus.COMPLETED
        && state.counts === 1
        && state.flakyAttempts === 2,
      `second run ended ${second.status}; counts ${state.counts}; flaky attempts ${state.flakyAttempts}`);

    const third = await app.controller.retryTask(taskId, 's2');
    check('recovery_correctness', 'a completed task cannot be retried',
      third.status === Outcome.INPUT_REJECTED && /only a failed or paused task/.test(third.display),
      `retry of completed task ended ${third.status}`);

    await recordTask(app, {
      taskId: 'practical-write-failure',
      goal: 'a write that failed',
      steps: [taskStep('s1', 'recovery.writefail', [], {}, 'write')],
    });
    const writeRun = await app.controller.runTask('practical-write-failure', 'run');
    const writeRetry = await app.controller.retryTask('practical-write-failure', 's1');
    check('recovery_correctness', 'a failed write is never retried',
      writeRun.status === Outcome.EXECUTION_FAILED
        && writeRetry.status === Outcome.INPUT_REJECTED
        && /changes data/.test(writeRetry.display)
        && state.writeAttempts === 1,
      `write run ${writeRun.status}; retry ${writeRetry.status}; attempts ${state.writeAttempts}`);
  });
});

describe('outcome reporting: the report matches the records, and a failed run is not a success', () => {
  test('a completed task is reported step by step and a failed task stays failed in the review', async () => {
    const sink = [];
    const app = appOn({ extraActions: makeFakeTaskActions(sink) });

    const planned = await app.controller.planTask('list memory then calc 2+3');
    const run = await app.controller.runTask(planned.task.id, 'run');
    const stored = await app.taskStore.get(planned.task.id);
    const scan = await app.operations.findTaskRuns(planned.task.id);

    check('outcome_reporting_accuracy', 'completed task report',
      run.status === Outcome.SUCCESS_VERIFIED
        && /Progress: 2 of 2 step\(s\) completed/.test(run.display)
        && (run.display.match(/\[completed\]/g) ?? []).length === 2
        && /\(verified\)/.test(run.display),
      `run display: ${run.display}`);

    const stepRecords = (await app.operations.list({ limit: 1000 })).records
      .filter((record) => record.capability === 'task.step' && record.task?.id === planned.task.id);
    check('outcome_reporting_accuracy', 'task log and audit agree',
      stored.status === TaskStatus.COMPLETED
        && stored.steps.every((step) => step.status === StepStatus.COMPLETED && step.outcome === Outcome.SUCCESS_VERIFIED)
        && stepRecords.length === 2
        && stepRecords.every((record) => record.status === Outcome.SUCCESS_VERIFIED)
        && scan.runs[0]?.status === Outcome.SUCCESS_VERIFIED,
      `store ${stored.status}; step records ${stepRecords.length}; run ${scan.runs[0]?.status}`);

    const failedId = await recordTask(app, {
      taskId: 'practical-failed-task',
      goal: 'a step that cannot run',
      steps: [taskStep('s1', 'test.fail', [], {})],
    });
    const failedRun = await app.controller.runTask(failedId, 'run');
    const failedStored = await app.taskStore.get(failedId);
    check('outcome_reporting_accuracy', 'failed run is not success',
      failedRun.status === Outcome.EXECUTION_FAILED
        && failedStored.status === TaskStatus.FAILED
        && failedStored.steps[0].status === StepStatus.FAILED
        && /\[failed\]/.test(failedRun.display)
        && !/success/i.test(failedRun.display),
      `failed run ended ${failedRun.status} with display: ${failedRun.display}`);

    const review = await app.controller.workReview();
    const reviewData = review.operation.steps[0].result.data;
    check('outcome_reporting_accuracy', 'portfolio review names the failed task',
      review.status === Outcome.SUCCESS_VERIFIED
        && reviewData.counts.tasks.total === 2
        && reviewData.attention.some((item) => item.kind === 'task_failed'),
      `review counts ${JSON.stringify(reviewData.counts.tasks)}; attention ${reviewData.attention.map((item) => item.kind).join(',')}`);
  });
});

describe('feedback and adaptation integrity: user judgement is recorded, nothing adapts on its own', () => {
  test('a verified run is not a confirmed outcome until the user says so, and feedback alone changes nothing', async () => {
    const app = appOn();
    const planned = await app.controller.planTask('list memory then calc 4+4');
    const run = await app.controller.runTask(planned.task.id, 'run');
    const before = await app.controller.adaptationList();

    check('feedback_adaptation_integrity', 'verified run alone records no outcome',
      run.status === Outcome.SUCCESS_VERIFIED
        && (await app.experience.list()).length === 0
        && before.operation.steps[0].result.data.records.length === 0,
      'a verified run did not become an experience or an adaptation by itself');

    const feedback = await app.controller.taskFeedback(planned.task.id, {
      assessment: 'useful', guidance: 'keep listing before calculating',
    });
    const data = feedback.operation.steps[0].result.data;
    const view = await app.experience.feedbackFor(data.experience.id);
    check('feedback_adaptation_integrity', 'feedback keeps user provenance',
      feedback.status === Outcome.SUCCESS_VERIFIED
        && view.current[0]?.assessment === 'useful'
        && view.current[0]?.provenance.origin === 'user_feedback'
        && view.current[0]?.provenance.updateMode === 'user_confirmed'
        && view.experience.provenance.origin === 'user_recorded',
      `view: ${JSON.stringify(view.current[0]?.provenance)}`);

    const after = await app.controller.adaptationList();
    check('feedback_adaptation_integrity', 'feedback derives no adaptation',
      after.operation.steps[0].result.data.records.length === 0
        && /0 adaptation record\(s\)/.test(after.display),
      `adaptation list: ${after.display}`);

    const pending = await app.controller.planTask('calc 1+1');
    const refused = await app.controller.taskFeedback(pending.task.id, { assessment: 'useful' });
    check('feedback_adaptation_integrity', 'feedback needs a completed run',
      refused.status === Outcome.EXECUTION_FAILED
        && /not completed/.test(refused.display)
        && (await app.experience.list()).length === 1,
      `feedback on a pending task ended ${refused.status}`);

    const model = await app.controller.runAction(
      'task.feedback', { taskId: planned.task.id, assessment: 'incorrect' }, 'model', 'op-practical-feedback',
    );
    check('feedback_adaptation_integrity', 'a model cannot record the user\'s assessment',
      model.outcome === Outcome.ACTION_DENIED
        && view.current[0]?.assessment === 'useful',
      `model feedback ended ${model.outcome}`);
  });
});

describe('multi-step workflow completion: several components finish one request end to end', () => {
  test('a workspace document is created, read, compared, summarised, reported and safely updated through the CLI', async () => {
    const root = workspaceFixture();
    const dataDir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, APEX_FILESYSTEM_ROOT: root });
    const content = 'Alpha beta gamma. Alpha delta.';

    const created = await runCli(['workspace', 'write', 'plan.md', '--content', content], env);
    check('multi_step_workflow_completion', 'cli create', created.code === 0, created.stderr);

    const read = await runCli(['workspace', 'read', 'plan.md'], env);
    check('multi_step_workflow_completion', 'cli read', read.code === 0 && read.stdout.includes(content), read.stderr);

    const copied = await runCli(['workspace', 'write', 'plan-copy.md', '--content', content], env);
    const compared = await runCli(['workspace', 'compare', 'plan.md', 'plan-copy.md'], env);
    check('multi_step_workflow_completion', 'cli compare',
      copied.code === 0 && compared.code === 0 && /identical/i.test(compared.stdout),
      compared.stderr || compared.stdout);

    const summarized = await runCli(['workspace', 'summarize', 'plan.md'], env);
    check('multi_step_workflow_completion', 'cli summarize',
      summarized.code === 0 && /frequent terms/.test(summarized.stdout),
      summarized.stderr);

    const report = await runCli(['workspace', 'report'], env);
    check('multi_step_workflow_completion', 'cli report',
      report.code === 0 && /Workspace report/.test(report.stdout) && /plan\.md/.test(report.stdout),
      report.stderr);

    const unguarded = await runCli(['workspace', 'write', 'plan.md', '--content', 'replacement'], env);
    check('multi_step_workflow_completion', 'cli refuses a silent overwrite',
      unguarded.code === 1
        && fs.readFileSync(path.join(root, 'plan.md'), 'utf8') === content
        && /already exists/i.test(`${unguarded.stdout}${unguarded.stderr}`),
      `unguarded write exited ${unguarded.code}`);

    const replacement = 'Alpha beta gamma. Revised.';
    const guarded = await runCli(
      ['workspace', 'write', 'plan.md', '--content', replacement, '--expected-sha256', sha256(content)],
      env,
    );
    check('multi_step_workflow_completion', 'cli updates with the current hash',
      guarded.code === 0 && fs.readFileSync(path.join(root, 'plan.md'), 'utf8') === replacement,
      guarded.stderr);

    const writeInputs = fs.readFileSync(path.join(dataDir, 'operations.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.capability === 'filesystem.write')
      .flatMap((record) => record.steps.map((step) => JSON.stringify(step.input ?? {})));
    check('multi_step_workflow_completion', 'write content stays out of the audit',
      writeInputs.length === 4
        && writeInputs.every((input) => !input.includes('Alpha beta gamma'))
        && writeInputs.every((input) => /\[value omitted: \d+ chars\]/.test(input)),
      'the workspace write payload was not copied into the operation log');
  });

  test('remembered information and recorded knowledge are read back together, then reviewed as work', async () => {
    const app = appOn();

    const remembered = await app.controller.handle('remember that the project codename is Aurora');
    const knowledge = await app.controller.knowledgeAdd({
      subject: 'APEX', relationship: 'has_subsystem', object: 'Memory Store',
    });
    const digest = await app.controller.handle('knowledge digest');
    check('multi_step_workflow_completion', 'knowledge chain',
      remembered.status === Outcome.SUCCESS_VERIFIED
        && knowledge.status === Outcome.SUCCESS_VERIFIED
        && digest.status === Outcome.SUCCESS_VERIFIED
        && /Aurora/.test(digest.display)
        && /APEX --\[has_subsystem\]--> Memory Store/.test(digest.display)
        && /does not merge them or infer a relationship/.test(digest.display),
      `digest display: ${digest.display}`);

    const review = await app.controller.handle('work review');
    check('multi_step_workflow_completion', 'portfolio chain',
      review.status === Outcome.SUCCESS_VERIFIED
        && /Goals: none recorded|Tasks: none recorded/.test(review.display)
        && /empty board is not evidence that nothing needs doing/.test(review.display),
      `review display: ${review.display}`);
  });

  test('a planned task runs, is assessed by the user, and remains a recorded outcome with no adaptation', async () => {
    const app = appOn();
    const planned = await app.controller.planTask('list memory then calc 9*9');
    const run = await app.controller.runTask(planned.task.id, 'run');
    const feedback = await app.controller.taskFeedback(planned.task.id, { assessment: 'correct' });
    const adaptations = await app.controller.adaptationList();
    const review = await app.controller.handle('work review');

    check('multi_step_workflow_completion', 'task to feedback chain',
      planned.status === Outcome.PLAN_CREATED
        && run.status === Outcome.SUCCESS_VERIFIED
        && feedback.status === Outcome.SUCCESS_VERIFIED
        && adaptations.operation.steps[0].result.data.records.length === 0
        && review.status === Outcome.SUCCESS_VERIFIED
        && /completed/.test(review.display),
      `plan ${planned.status}; run ${run.status}; feedback ${feedback.status}; adaptations ${adaptations.operation.steps[0].result.data.records.length}`);
  });
});

test('the practical evaluation reports all ten dimensions separately', (t) => {
  const measured = new Map(DIMENSIONS.map((dimension) => [dimension, observed.filter((r) => r.dimension === dimension)]));
  const lines = DIMENSIONS.map((dimension) => {
    const mine = measured.get(dimension);
    return `${dimension.padEnd(34)} ${mine.filter((r) => r.passed).length}/${mine.length}`;
  });
  t.diagnostic(`\nPractical capability evaluation (deterministic fixtures; no model consulted):\n${lines.join('\n')}`);

  for (const dimension of DIMENSIONS) {
    assert.ok(measured.get(dimension).length > 0, `${dimension} was not measured`);
  }
  assert.deepEqual(observed.filter((r) => !r.passed), [], 'a recorded check failed');
  const report = lines.join('\n');
  assert.doesNotMatch(report, /\bscore\b|\boverall\b|\bgrade\b/i, 'the dimensions are not combined into one number');
});