// T-14 durability acceptance: what survives a restart, and what a damaged append is reported as.
//
// The workflows suite proves the layers compose while a process is alive. These tests ask the two
// questions an operator asks next: after the process exits, can every record still be found from
// the record that cites it, and does the earlier history still hold its exact bytes? And when one
// store ends in a torn line, is the damage reported with its cause, are the other stores still
// readable, and are reads that would present incomplete state refused rather than answered from a
// partial replay? Nothing here calls a model; every application uses the no-backend gateway.
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { collectHealth, Health } from '../src/health.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
const runtimes = [];
afterEach(async () => {
  while (runtimes.length) await runtimes.pop().stop({ reason: 't14 reliability cleanup' }).catch(() => {});
  while (dirs.length) cleanup(dirs.pop());
});

function appOn(dir) {
  return createApp({ dataDir: dir });
}

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

const dataOf = (res) => res?.operation?.steps?.[0]?.result?.data ?? res?.result?.data ?? null;

async function makeGoal(app, request) {
  const res = await app.controller.goalAdd({
    request,
    criteria: [{ description: `${request} is recorded`, basis: 'user_stated' }],
    priority: 3,
  });
  assert.equal(res.status, Outcome.GOAL_CREATED, res.output ?? res.display);
  return dataOf(res).goalId;
}

async function activateGoal(app, goalId) {
  for (const status of ['accepted', 'active']) {
    const res = await app.controller.goalUpdate({ target: goalId, status });
    assert.equal(res.status, Outcome.GOAL_UPDATED, res.output ?? res.display);
  }
}

async function makePlan(app, goalId) {
  const res = await app.controller.planAdd({
    goalId,
    outcome: 'the note is recorded',
    steps: [{
      id: 's1',
      description: 'record the outcome',
      action: 'memory.add',
      input: { content: 'the durable note' },
      dependsOn: [],
      expectedResult: 'a memory record exists',
      verification: 'read it back',
      risk: 'medium',
    }],
  });
  assert.equal(res.status, Outcome.PLAN_STORED, res.output ?? res.display);
  const planId = dataOf(res).planId;
  const approved = await app.controller.planApprove({ target: planId });
  assert.ok([Outcome.SUCCESS_VERIFIED, Outcome.PLAN_STORED].includes(approved.status), approved.output ?? approved.display);
  return planId;
}

function areaOf(health, key) {
  return health.areas.find((entry) => entry.key === key);
}

describe('T-14 durability: restart and damaged appends', () => {
  test('a completed executive cycle survives a restart with every cross-reference intact and no replayed work', async () => {
    const dir = tempDir();
    const first = appOn(dir);
    runtimes.push(first.runtime);
    await first.runtime.start({ intervalMs: 0 });

    const goalId = await makeGoal(first, 'record a durable note');
    await activateGoal(first, goalId);
    const planId = await makePlan(first, goalId);
    const ticked = await first.runtime.tick();
    assert.equal(ticked.executed.length, 1, 'the approved plan did not run');
    await first.runtime.stop({ reason: 't14 restart fixture' });

    const plan = await first.plans.get(planId);
    assert.equal(plan.status, 'completed');
    const task = (await first.taskStore.list()).find((entry) => entry.planId === planId);
    assert.ok(task, 'the completed plan has no task record');
    const operationId = plan.stepResults.s1.operationId;
    assert.equal(typeof operationId, 'string');

    // The append-only logs are the record of what happened. A restart may add to them and must not
    // rewrite what is already there.
    const logs = ['goals.jsonl', 'plans.jsonl', 'tasks.jsonl', 'operations.jsonl', 'situational.jsonl'];
    const before = new Map(logs.map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));

    const second = appOn(dir);
    runtimes.push(second.runtime);
    const started = await second.runtime.start({ intervalMs: 0 });
    assert.equal(started.boots, 2, 'the restart did not resume the recorded runtime state');
    const status = await second.runtime.status();
    assert.equal(status.lifecycle, 'running');
    assert.equal(status.checkpoint.processed > 0, true, 'the restart forgot which events were processed');

    const replayed = await second.runtime.tick();
    assert.equal(replayed.executed.length, 0, 'a restart replayed work that had already completed');

    // Each record is reachable from the record that cites it.
    const goalAfter = await second.goals.get(goalId);
    assert.equal(goalAfter.id, goalId);
    const planAfter = await second.plans.get(planId);
    assert.equal(planAfter.goalId, goalId);
    assert.equal(planAfter.status, 'completed');
    const taskAfter = await second.taskStore.get(task.id);
    assert.equal(taskAfter.planId, planId);
    assert.equal(taskAfter.goalId, goalId);
    assert.equal(taskAfter.status, 'completed');

    const operation = await second.operations.findById(operationId);
    assert.equal(operation.found, true, 'the audit record cited by the completed plan is missing after the restart');
    assert.equal(operation.record.task?.id, task.id);
    assert.equal(operation.record.task?.stepId, 's1');

    const page = await second.situation.events({ limit: 100 });
    assert.ok(page.rows.some((row) => row.event.type === 'plan_completed' && row.event.planRefs.includes(planId)),
      'the situational log lost the record of the completed plan');

    // A restart tick that executes nothing must not execute a completed step a second time.
    const after = (await second.operations.list({ limit: 1000 })).records;
    const stepRuns = after.filter((record) => record.capability === 'task.step' && record.task?.id === task.id);
    assert.equal(stepRuns.length, 1, 'the completed step has more than one execution record after the restart');

    for (const name of logs) {
      const now = fs.readFileSync(path.join(dir, name), 'utf8');
      assert.ok(now.startsWith(before.get(name)), `${name} no longer begins with the bytes that were already recorded`);
    }

    const health = await collectHealth(second);
    assert.equal(health.overall, Health.HEALTHY, `the restarted system is not healthy: ${health.areas.filter((entry) => entry.state !== Health.HEALTHY).map((entry) => `${entry.key}=${entry.state}`).join(', ')}`);
  });

  test('a torn final plan record is reported as an interrupted append, the other stores stay readable, and incomplete plan reads are refused', async () => {
    const dir = tempDir();
    const first = appOn(dir);
    const goalId = await makeGoal(first, 'draft a durable plan');
    await activateGoal(first, goalId);
    const planId = await makePlan(first, goalId);

    // A crash during an append leaves a partial final line and no trailing newline.
    const plansFile = path.join(dir, 'plans.jsonl');
    fs.appendFileSync(plansFile, '{"schema":"apex.plan/1","id":"plan-torn');
    const damaged = fs.readFileSync(plansFile, 'utf8');

    const second = appOn(dir);
    const health = await collectHealth(second);

    assert.equal(health.overall, Health.FAILED, 'a torn plan log was reported as healthy');
    const application = areaOf(health, 'application');
    assert.equal(application.state, Health.FAILED);
    assert.match(application.summary, /Plans/);
    assert.equal(areaOf(health, 'storage').state, Health.FAILED);
    assert.ok(health.attention.some((item) => item.kind === 'integrity'
      && /plans\.jsonl/.test(item.text)
      && /final line without a newline/.test(item.text)
      && /interrupted append/.test(item.text)),
    'health does not name the torn line as an interrupted append');
    assert.equal(areaOf(health, 'runtime').state, Health.FAILED,
      'the runtime was reported healthy while the plan state could not be read');

    // Reads that would present the plan state refuse; they do not silently drop the unreadable line.
    await assert.rejects(() => second.plans.list(), /corrupt line/);
    await assert.rejects(() => second.plans.get(planId), /corrupt line/);
    await assert.rejects(() => second.runtime.status(), /corrupt line/,
      'the executive status was answered from a partial plan state');

    // Damage in one store does not hide the records the other stores still hold.
    const goalAfter = await second.goals.get(goalId);
    assert.equal(goalAfter.id, goalId);
    const operations = await second.operations.status();
    assert.ok(operations.records > 0, 'the audit log became unreadable with the plan log');

    // The damaged bytes are evidence: reading them never rewrites or truncates the file.
    assert.equal(fs.readFileSync(plansFile, 'utf8'), damaged, 'the damaged log was rewritten');
  });
});
