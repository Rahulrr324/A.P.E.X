// T-34 Step 1 (2026-11-19): multi-node missions, a real fan-out and a real fan-in.
//
// T-29 could compile exactly one action into exactly one step, so the TaskGraph had a state and a
// control but never a shape. These tests pin the two halves of the fix:
//
//  1. A mission is compiled from a fixed template in source - deterministic, inspectable, no
//     inference - and it is gated: a mission is not a permission, and every node the template
//     declares `gate: 'approval'` is recorded awaiting the owner before anything runs.
//  2. The join cannot run until every branch it depends on holds a completed outcome. A branch that
//     waits for the owner leaves its sibling free to finish, the join reports which branch holds it
//     (`blockedBy: ['n2a']`), and approving that branch unblocks the join without re-running the
//     branch that already verified.
//
// Nothing here runs a model. Where a step has to fail, a labelled test double (`test.fail`, from
// tests/helpers.js) does it and the assertion says so.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, makeFakeTaskActions } from './helpers.js';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import { MISSION_NAMES, MISSION_SCHEMA, MISSION_TEMPLATES, MissionError, compileMission } from '../src/cognition/missions.js';
import { Outcome } from '../src/outcomes.js';
import { StepStatus, TaskStatus, blockedNodes } from '../src/tasks/model.js';

const TOKEN = 't34-mission-token-0123456789';
const dirs = [];
const servers = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (servers.length) await servers.pop().stop().catch(() => {});
  while (dirs.length) {
    const dir = dirs.pop();
    try { cleanup(dir); } catch { /* already removed */ }
  }
});

const SOUND = {
  title: 'T-34 mission design',
  domain: 'plan',
  components: [
    { id: 'supply', kind: 'resource', supply: 10, demand: 0, cost: 1 },
    { id: 'load', kind: 'service', supply: 0, demand: 5, cost: 1 },
  ],
  connections: [{ from: 'supply', to: 'load' }],
  budget: { total: 4 },
};

async function appWith(extra = {}) {
  const dir = tempDir();
  const app = createApp({ dataDir: dir, extraActions: makeFakeTaskActions([]), ...extra });
  return { app, dir };
}

async function stagedArtifact(app) {
  const composed = await app.workshop.compose(SOUND);
  assert.ok(composed.artifact?.artifactId, 'the workshop staged an artifact');
  return composed.artifact.artifactId;
}

// The run as /api/cognition/runs reads it back: the record plus what the task log holds now.
async function runOf(app, runId) {
  const run = await app.cognition.get(runId);
  assert.ok(run, 'the run record is readable');
  return run;
}

function stepOf(run, id) {
  const step = (run.task?.steps ?? []).find((entry) => entry.id === id);
  assert.ok(step, `the run records a step ${id}`);
  return step;
}

// The order the task's steps were executed in, from the audit log the runner writes for each step.
function stepOrder(dir, taskId) {
  const file = path.join(dir, 'operations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((record) => record.task?.id === taskId)
    .map((record) => record.task.stepId);
}

describe('T-34 the mission compiler is a template, not a planner', () => {
  test('the audit_and_stage template is exact: five nodes, five edges, one fan-out, one join', () => {
    const compiled = compileMission({ mission: 'audit_and_stage', artifactId: 'ws-0123456789abcdef' });
    assert.equal(compiled.schema, MISSION_SCHEMA);
    assert.deepEqual(compiled.nodes.map((node) => node.id), ['n1', 'n2a', 'n2b', 'n3', 'n4']);
    assert.deepEqual(compiled.nodes.map((node) => node.action), [
      'perception.state', 'perception.sense_host', 'workshop.list', 'workshop.verify', 'workshop.get',
    ]);
    assert.deepEqual(compiled.nodes.map((node) => node.dependsOn), [[], ['n1'], ['n1'], ['n2a', 'n2b'], ['n3']]);
    assert.deepEqual(compiled.nodes.map((node) => node.role), ['root', 'branch', 'branch', 'join', 'completion']);
    assert.deepEqual(compiled.shape, { nodes: 5, edges: 5, fanOut: 2, joins: ['n3'], roots: ['n1'], gated: ['n2a', 'n3'] });
    assert.deepEqual(compiled.edges, [
      { from: 'n1', to: 'n2a' }, { from: 'n1', to: 'n2b' }, { from: 'n2a', to: 'n3' }, { from: 'n2b', to: 'n3' }, { from: 'n3', to: 'n4' },
    ]);
    assert.match(compiled.summary, /5 node\(s\) · 5 edge\(s\) · fan-out 2 · join n3 · gated n2a, n3 · template audit_and_stage/);
  });

  test('the artifact reaches only the nodes that declare it, and compiling twice says the same thing', () => {
    const first = compileMission({ mission: 'audit_and_stage', artifactId: 'ws-0123456789abcdef' });
    const second = compileMission({ mission: 'audit_and_stage', artifactId: 'ws-0123456789abcdef' });
    assert.deepEqual(second, first, 'compilation is deterministic: same request, same graph');
    const byId = new Map(first.nodes.map((node) => [node.id, node]));
    assert.equal(byId.get('n3').input.artifactId, 'ws-0123456789abcdef');
    assert.equal(byId.get('n4').input.artifactId, 'ws-0123456789abcdef');
    for (const id of ['n1', 'n2a', 'n2b']) {
      assert.equal(Object.hasOwn(byId.get(id).input, 'artifactId'), false, `${id} does not take the artifact`);
    }
    // The template is the source of truth and it is frozen: nothing at run time can rewrite a mission.
    assert.equal(Object.isFrozen(MISSION_TEMPLATES.audit_and_stage), true);
    assert.equal(Object.isFrozen(MISSION_TEMPLATES.audit_and_stage.nodes), true);
    assert.equal(Object.isFrozen(first.nodes), true);
    assert.deepEqual(MISSION_NAMES, ['audit_and_stage']);
  });

  test('a mission that cannot be stated is refused with a code, never guessed at', () => {
    assert.throws(() => compileMission({ mission: 'invent_one' }), (err) => err instanceof MissionError && err.code === 'MISSION_UNKNOWN');
    assert.throws(() => compileMission({}), (err) => err instanceof MissionError && err.code === 'MISSION_UNKNOWN');
    assert.throws(() => compileMission({ mission: 'audit_and_stage' }), (err) => err instanceof MissionError && err.code === 'MISSION_NEEDS_ARTIFACT');
    assert.throws(() => compileMission({ mission: 'audit_and_stage', artifactId: '   ' }), (err) => err.code === 'MISSION_NEEDS_ARTIFACT');
  });
});

describe('T-34 a mission is compiled, gated and run as one task', () => {
  test('the mission stops at its gates with the read branch done and the join blocked by the gated one', async () => {
    const { app } = await appWith();
    const artifactId = await stagedArtifact(app);
    const res = await app.controller.cognitionRun({ intent: 'audit the host and verify my artifact', mission: 'audit_and_stage', artifactId });
    assert.equal(res.status, Outcome.VERIFICATION_FAILED, 'a paused mission is not a verified success');
    const runId = res.operation.steps[0].result.data.runId;
    const run = await runOf(app, runId);

    assert.equal(run.status, 'awaiting_approval');
    assert.equal(run.mission.name, 'audit_and_stage');
    assert.equal(run.stages.task_graph.shape.fanOut, 2);
    assert.deepEqual(run.stages.task_graph.shape.joins, ['n3']);

    // The read root and the read sibling ran; the gated branch waits; the join is held by it.
    assert.equal(stepOf(run, 'n1').status, 'completed');
    assert.equal(stepOf(run, 'n1').outcome, 'success_verified');
    assert.equal(stepOf(run, 'n2b').status, 'completed');
    assert.equal(stepOf(run, 'n2b').outcome, 'success_verified');
    assert.equal(stepOf(run, 'n2a').status, 'awaiting_approval');
    assert.equal(stepOf(run, 'n3').status, 'awaiting_approval');
    assert.deepEqual(stepOf(run, 'n3').blockedBy, ['n2a'], 'the join names the branch that holds it');
    assert.equal(stepOf(run, 'n4').status, 'pending');
    assert.deepEqual(stepOf(run, 'n4').blockedBy, ['n3']);

    // And the answer says exactly that, instead of claiming nothing happened.
    assert.match(res.display, /paused awaiting explicit owner approval of n2a, n3/);
    assert.match(res.display, /n1, n2b ran and verified/);
    assert.match(res.display, /n3 by n2a/);
  });

  test('approving the gated branch unblocks the join and never re-runs the branch that verified', async () => {
    const { app, dir } = await appWith();
    const artifactId = await stagedArtifact(app);
    const res = await app.controller.cognitionRun({ intent: 'audit and verify', mission: 'audit_and_stage', artifactId });
    const runId = res.operation.steps[0].result.data.runId;
    const before = await runOf(app, runId);
    const taskId = before.taskId;
    const siblingOperation = stepOf(before, 'n2b').operationId;
    const siblingRunCount = stepOrder(dir, taskId).filter((id) => id === 'n2b').length;
    assert.equal(siblingRunCount, 1);

    const approved = await app.controller.approveTask(taskId, { stepId: 'n2a' });
    assert.equal(approved.status, Outcome.SUCCESS_VERIFIED);
    const resumed = await app.controller.runTask(taskId, 'resume');
    assert.equal(resumed.status, Outcome.TASK_PAUSED, 'the join still waits for its own approval');
    const after = await runOf(app, runId);

    assert.equal(stepOf(after, 'n2a').status, 'completed');
    assert.equal(stepOf(after, 'n2a').outcome, 'success_verified');
    assert.deepEqual(stepOf(after, 'n3').blockedBy, [], 'both branches now hold, so nothing blocks the join');
    assert.equal(stepOf(after, 'n3').status, 'awaiting_approval', 'the join still needs the owner');
    assert.equal(stepOf(after, 'n2b').status, 'completed');
    assert.equal(stepOf(after, 'n2b').operationId, siblingOperation, 'the verified sibling kept its own operation');
    assert.equal(stepOrder(dir, taskId).filter((id) => id === 'n2b').length, 1, 'the verified sibling did not run again');
  });

  test('the join runs only after both branches, and the mission completes verified', async () => {
    const { app, dir } = await appWith();
    const artifactId = await stagedArtifact(app);
    const res = await app.controller.cognitionRun({ intent: 'audit and verify', mission: 'audit_and_stage', artifactId });
    const runId = res.operation.steps[0].result.data.runId;
    const taskId = (await runOf(app, runId)).taskId;

    await app.controller.approveTask(taskId, { stepId: 'n2a' });
    await app.controller.runTask(taskId, 'resume');
    await app.controller.approveTask(taskId, { stepId: 'n3' });
    const finished = await app.controller.runTask(taskId, 'resume');
    assert.equal(finished.status, Outcome.SUCCESS_VERIFIED);

    const run = await runOf(app, runId);
    assert.equal(run.status, 'completed');
    assert.equal(run.verification.verified, true, 'every node holds its own verified outcome');
    assert.equal(run.task.status, 'completed');
    assert.deepEqual((run.task.steps ?? []).map((step) => step.status), ['completed', 'completed', 'completed', 'completed', 'completed']);

    // The execution order is the graph's: the join after both branches, the completion after it.
    const order = stepOrder(dir, taskId);
    assert.equal(order.filter((id) => id === 'n3').length, 1, 'the join ran once');
    assert.equal(order.filter((id) => id === 'n2b').length, 1, 'the branch ran once');
    assert.ok(order.indexOf('n3') > order.indexOf('n2a'));
    assert.ok(order.indexOf('n3') > order.indexOf('n2b'));
    assert.ok(order.indexOf('n4') > order.indexOf('n3'));
  });

  test('a refused mission creates no task at all', async () => {
    const { app, dir } = await appWith();
    const unknown = await app.controller.runAction('cognition.run', { intent: 'run a mission', mission: 'invent_one' }, 'user');
    assert.equal(unknown.outcome, 'input_rejected');
    assert.match(unknown.summary, /no mission template is named/);
    assert.equal(JSON.stringify(unknown).includes('MISSION_UNKNOWN'), true, 'the compiler\'s own code is carried on the refusal');

    const missing = await app.controller.runAction('cognition.run', { intent: 'run a mission', mission: 'audit_and_stage' }, 'user');
    assert.equal(missing.outcome, 'input_rejected');
    assert.match(missing.summary, /needs the workshop artifact/);

    // An artifact that is not in the workshop is refused before any task exists. The refusal is
    // recorded as an execution that did not start, and it names the mission's own precondition.
    const notStaged = await app.controller.runAction('cognition.run', { intent: 'run a mission', mission: 'audit_and_stage', artifactId: 'ws-ffffffffffffffff' }, 'user');
    assert.notEqual(notStaged.outcome, 'success_verified');
    assert.match(JSON.stringify(notStaged), /MISSION_ARTIFACT_UNKNOWN/);

    const tasksFile = path.join(dir, 'tasks.jsonl');
    assert.equal(fs.existsSync(tasksFile) ? fs.readFileSync(tasksFile, 'utf8').trim() : '', '', 'no task was created for any of these');
  });
});

describe('T-34 a failed branch stops its run and leaves its sibling to a continuation', () => {
  // A hand-built graph with the same shape as the mission, using the labelled test doubles: n2a is a
  // read that always fails, n2b is a read that verifies. It is a test graph, not a mission.
  //
  // The stop rule is the one every run has always had, and T-34 does not relax it: a branch that
  // fails stops the run, and the sibling it never reached stays pending. That pending sibling is a
  // continuation's work - the owner's own command, which reads the records first - because a run that
  // quietly carried on past a failure would report a partial run as a whole one.
  async function brokenBranchTask(app) {
    await app.taskStore.createTask({
      taskId: 'task-t34-branch',
      goal: 'fan out to two branches, one of which fails',
      origin: 'user',
      planner: 'deterministic',
      reason: 'T-34 test graph',
      steps: [
        { id: 'n1', description: 'n1 root', action: 'test.ok', permission: 'read', input: { tag: 'root' }, dependsOn: [] },
        { id: 'n2a', description: 'n2a branch that fails', action: 'test.fail', permission: 'read', input: {}, dependsOn: ['n1'] },
        { id: 'n2b', description: 'n2b branch that verifies', action: 'test.ok', permission: 'read', input: { tag: 'sibling' }, dependsOn: ['n1'] },
        { id: 'n3', description: 'n3 join', action: 'test.ok', permission: 'read', input: { tag: 'join' }, dependsOn: ['n2a', 'n2b'] },
        { id: 'n4', description: 'n4 completion', action: 'test.ok', permission: 'read', input: { tag: 'completion' }, dependsOn: ['n3'] },
      ],
    });
    return 'task-t34-branch';
  }

  const statusOf = (task, id) => task.steps.find((step) => step.id === id)?.status;

  test('the failed branch stops the run, its sibling is left pending, and the join names both branches', async () => {
    const { app } = await appWith();
    const taskId = await brokenBranchTask(app);
    const result = await app.controller.runTask(taskId, 'run');
    assert.notEqual(result.status, Outcome.SUCCESS_VERIFIED, 'a failed branch can never report verified success');

    const task = await app.taskStore.get(taskId);
    assert.equal(task.status, TaskStatus.FAILED);
    assert.equal(statusOf(task, 'n1'), StepStatus.COMPLETED);
    assert.equal(statusOf(task, 'n2a'), StepStatus.FAILED);
    assert.equal(statusOf(task, 'n2b'), StepStatus.PENDING, 'the sibling never started: the run stopped on the failure');
    // The branches behind the failure are marked skipped rather than left looking like work waiting on
    // nothing, and a retry of n2a is the state that turns them back to pending.
    assert.equal(statusOf(task, 'n3'), StepStatus.SKIPPED);
    assert.equal(statusOf(task, 'n4'), StepStatus.SKIPPED);

    // The branch view names what holds each node, from the records alone.
    const blocked = blockedNodes(task);
    assert.deepEqual(blocked.map((node) => node.id), ['n2b', 'n3', 'n4']);
    assert.deepEqual(blocked.find((node) => node.id === 'n2b').blockedBy, [], 'nothing holds the untouched branch itself');
    assert.deepEqual(blocked.find((node) => node.id === 'n3').blockedBy, ['n2a', 'n2b'], 'the join waits on both branches');

    // The failed branch names what it stopped, in the log's own words.
    const log = fs.readFileSync(path.join(app.dataDir ?? '', 'tasks.jsonl'), 'utf8');
    assert.match(log, /n2a failed/);
    assert.match(log, /not run: depends on n2a/);
  });

  test('a continuation takes up the untouched sibling and never re-runs the branch that failed', async () => {
    const { app, dir } = await appWith();
    const taskId = await brokenBranchTask(app);
    await app.controller.runTask(taskId, 'run');
    const failedAttempt = (await app.taskStore.get(taskId)).steps.find((step) => step.id === 'n2a');

    const continued = await app.controller.runTask(taskId, 'continue');
    assert.notEqual(continued.status, Outcome.SUCCESS_VERIFIED, 'the failed branch still holds the run');
    // The audit log is what the continuation itself wrote, so it says which step this command ran.
    assert.deepEqual(stepOrder(dir, taskId).filter(Boolean), ['n1', 'n2a', 'n2b'],
      'the step the failure never touched, and only it');
    const after = await app.taskStore.get(taskId);
    assert.equal(statusOf(after, 'n2b'), StepStatus.COMPLETED, 'the sibling ran in the continuation');
    assert.equal(after.steps.find((step) => step.id === 'n2b').outcome, 'success_verified');
    assert.equal(after.steps.find((step) => step.id === 'n2a').operationId, failedAttempt.operationId,
      'the failed branch was not run again');
    // The continuation cannot take up the join either: one of its branches still holds a verified
    // failure, and the records say so instead of the runner assuming the branch had run.
    assert.equal(statusOf(after, 'n3'), StepStatus.SKIPPED);
    assert.equal(stepOrder(dir, taskId).filter((id) => id === 'n2a').length, 1, 'n2a ran exactly once');

    // Retrying the failed branch is what puts the join back in front of the run.
    const retried = await app.controller.retryTask(taskId, 'n2a');
    assert.equal(retried.status, Outcome.SUCCESS_VERIFIED);
    const afterRetry = await app.taskStore.get(taskId);
    assert.equal(statusOf(afterRetry, 'n2a'), StepStatus.PENDING);
    assert.equal(statusOf(afterRetry, 'n3'), StepStatus.PENDING, 'the join is waiting again, not skipped');
    assert.equal(statusOf(afterRetry, 'n2b'), StepStatus.COMPLETED, 'the verified sibling stays verified');
    assert.equal(afterRetry.steps.find((step) => step.id === 'n2b').operationId,
      after.steps.find((step) => step.id === 'n2b').operationId, 'and it is not touched by the retry');
  });

  test('cancel marks the steps that never ran as cancelled and records why', async () => {
    const { app, dir } = await appWith();
    const artifactId = await stagedArtifact(app);
    const res = await app.controller.cognitionRun({ intent: 'audit and verify', mission: 'audit_and_stage', artifactId });
    const runId = res.operation.steps[0].result.data.runId;
    const taskId = (await runOf(app, runId)).taskId;

    const cancelled = await app.controller.cancelTask(taskId);
    assert.equal(cancelled.status, Outcome.SUCCESS_VERIFIED);
    const task = await app.taskStore.get(taskId);
    assert.equal(task.status, TaskStatus.CANCELLED);
    assert.equal(task.steps.filter((step) => step.status === StepStatus.PENDING || step.status === StepStatus.AWAITING_APPROVAL).length, 0, 'nothing is left open');
    assert.equal(task.steps.find((step) => step.id === 'n1').status, StepStatus.COMPLETED, 'what ran stays recorded as run');
    assert.deepEqual(blockedNodes(task), [], 'a cancelled task blocks nothing');
    const log = fs.readFileSync(path.join(dir, 'tasks.jsonl'), 'utf8');
    assert.match(log, /cancelled by the user/);
  });
});

describe('T-34 /api/taskgraph carries the tasks and the shape, and ?taskId= switches', () => {
  async function start() {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, extraActions: makeFakeTaskActions([]) });
    const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    servers.push(ui);
    return { app, dir, base: `http://127.0.0.1:${started.port}`, headers: { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' } };
  }

  test('the summary lists every task and the graph is the selected one', async () => {
    const { app, base, headers } = await start();
    const artifactId = await app.workshop.compose(SOUND).then((composed) => composed.artifact.artifactId);
    const first = await app.controller.cognitionRun({ intent: 'audit and verify', mission: 'audit_and_stage', artifactId });
    const firstRun = await app.cognition.get(first.operation.steps[0].result.data.runId);
    const second = await app.controller.cognitionRun({ intent: 'store a marker', action: 'memory.add', input: { content: 'the T-34 marker' } });
    const secondRun = await app.cognition.get(second.operation.steps[0].result.data.runId);
    assert.notEqual(firstRun.taskId, secondRun.taskId);

    const listed = await fetch(`${base}/api/taskgraph`, { headers }).then((response) => response.json());
    assert.equal(listed.taskId, secondRun.taskId, 'the default is the newest unfinished task');
    assert.equal(listed.tasks.length, 2);
    assert.deepEqual(listed.tasks.map((task) => task.id).sort(), [firstRun.taskId, secondRun.taskId].sort());

    const mission = await fetch(`${base}/api/taskgraph?taskId=${encodeURIComponent(firstRun.taskId)}`, { headers }).then((response) => response.json());
    assert.equal(mission.taskId, firstRun.taskId);
    assert.equal(mission.nodes.length, 5);
    assert.deepEqual(mission.shape, { nodes: 5, edges: 5, fanOut: 2, joins: ['n3'], roots: ['n1'] });
    const join = mission.nodes.find((node) => node.id === 'n3');
    assert.deepEqual(join.blockedBy, ['n2a'], 'the join names the branch that holds it');
    assert.equal(join.state, 'awaiting_approval');
    assert.equal(mission.controls.approve, true);
    assert.equal(mission.controls.resume, false, 'nothing is ready while the gated branch holds the only pending node');
    assert.equal(mission.authorizesExecution, false);
    assert.equal(mission.nodes.find((node) => node.id === 'n1').verified, true);
    assert.equal(mission.nodes.find((node) => node.id === 'n2a').verified, false, 'a gated node is never verified');

    // Approving the gated branch through the deck's own route makes a pending node with nothing unmet,
    // which is exactly what the resume control says it acts on; resuming then completes that branch and
    // clears the join's block, all read back through /api/taskgraph.
    const approved = await fetch(`${base}/api/tasks/${encodeURIComponent(firstRun.taskId)}/approve`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ stepId: 'n2a' }),
    }).then((response) => response.json());
    assert.equal(approved.status, 'success_verified');
    const ready = await fetch(`${base}/api/taskgraph?taskId=${encodeURIComponent(firstRun.taskId)}`, { headers }).then((response) => response.json());
    assert.equal(ready.controls.resume, true, 'an approved branch left pending is resumable');
    assert.equal(ready.nodes.find((node) => node.id === 'n2a').state, 'pending');
    const resumed = await fetch(`${base}/api/tasks/${encodeURIComponent(firstRun.taskId)}/resume`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
    }).then((response) => response.json());
    assert.equal(resumed.status, 'task_paused', 'the join still waits for its own approval');
    const unblocked = await fetch(`${base}/api/taskgraph?taskId=${encodeURIComponent(firstRun.taskId)}`, { headers }).then((response) => response.json());
    assert.equal(unblocked.nodes.find((node) => node.id === 'n2a').state, 'completed');
    assert.deepEqual(unblocked.nodes.find((node) => node.id === 'n3').blockedBy, [], 'the join is no longer held by the branch');
    assert.equal(unblocked.nodes.find((node) => node.id === 'n2b').state, 'completed');
    assert.equal(unblocked.nodes.find((node) => node.id === 'n2b').verified, true);

    // The single-node task keeps its own graph: one node, no edge, no join.
    const single = await fetch(`${base}/api/taskgraph?taskId=${encodeURIComponent(secondRun.taskId)}`, { headers }).then((response) => response.json());
    assert.equal(single.nodes.length, 1);
    assert.deepEqual(single.edges, []);
    assert.equal(single.shape.fanOut, 0);
    assert.deepEqual(single.shape.joins, []);
  });

  test('switching to a task that does not exist answers with no graph and no invented node', async () => {
    const { base, headers } = await start();
    const missing = await fetch(`${base}/api/taskgraph?taskId=task-t34-doesnotexist`, { headers }).then(async (response) => ({ status: response.status, body: await response.json() }));
    assert.equal(missing.status, 200);
    assert.equal(missing.body.taskId, null);
    assert.deepEqual(missing.body.nodes, []);
    assert.equal(missing.body.status, 'none');
    assert.ok(Array.isArray(missing.body.tasks), 'the tasks remain listed even when the chosen one is gone');
  });

  test('the mission route refuses a mission the compiler does not hold', async () => {
    const { base, headers } = await start();
    const refused = await fetch(`${base}/api/cognition/run`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'run a mission', mission: 'invent_one' }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    assert.equal(refused.status, 400);
    assert.match(JSON.stringify(refused.body), /no mission template is named/);
    const graph = await fetch(`${base}/api/taskgraph`, { headers }).then((response) => response.json());
    assert.deepEqual(graph.tasks, [], 'a refused mission created no task');
  });
});
