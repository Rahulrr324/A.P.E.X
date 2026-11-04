// Batch AK: the executive bridge, driven through the real request path.
//
// Every case here calls `controller.handle()` with the words a user would type and checks what the
// records say afterwards. The bridge owns no store and no runner: a preparation writes through the
// existing `plan.add` action, an approval through `plan.approve`, and a run through the existing
// plan activation and TaskRunner, so what these tests assert is an audit trail, not a mock.
//
// No model is contacted. Where a case needs a step that fails or cannot be verified it registers a
// labelled test double from helpers.js; a test double reports what it did and is not evidence about
// a real action.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF, CAPTURE_VERIFIED_SUCCESS, CAPTURE_EXCLUDED_CAPABILITIES } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { PlanStatus, planContentHash } from '../src/plans/model.js';
import { StepStatus } from '../src/tasks/model.js';
import { executiveSignal } from '../src/executive/mapping.js';
import { makeTempDataDir, cleanup, makeFakeTaskActions } from './helpers.js';

const CLOCK = () => new Date('2026-11-04T09:00:00.000Z');

// Two parts of one request, both registered: a write and a read that waits for it.
const PREPARE_TEXT = 'prepare a plan to remember that the AK bridge fact holds and then list my memories';
// A part no registered capability can take, stated in the user's own words.
const UNMAPPED_ONLY = 'prepare a plan to book a flight to Lisbon';
const PARTIALLY_MAPPED = 'prepare a plan to remember that the partial AK fact holds and then negotiate a treaty';

function appIn(dir, extra = {}) {
  return createApp({ dataDir: dir, now: CLOCK, experienceCapture: CAPTURE_OFF, ...extra });
}

const file = (dir, name) => path.join(dir, name);
const exists = (dir, name) => fs.existsSync(file(dir, name));

function records(dir, name) {
  if (!exists(dir, name)) return [];
  return fs.readFileSync(file(dir, name), 'utf8').split(/\r?\n/).filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

const audit = (dir) => records(dir, 'operations.jsonl');
const auditSeq = (dir) => audit(dir).map((r) => r.capability).join(',');

// The task log is an append-only event log: one line per transition, all naming the same taskId. The
// events are not a task state, so a test that wants "what the task records now" reads it through the
// store, and a test that counts tasks counts distinct ids.
const taskIds = (dir) => [...new Set(records(dir, 'tasks.jsonl').map((r) => r.taskId))];
const readTask = async (app, dir) => app.taskStore.get(taskIds(dir)[0]);

// The plan id and short reference a preparation recorded.
function prepared(res) {
  assert.equal(res.operation.steps.length, 1, 'a preparation records exactly one action step');
  const [step] = res.operation.steps;
  assert.equal(step.action, 'plan.add', 'a preparation writes through the existing plan.add action');
  assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, 'the recorded plan is independently verified');
  const planId = step.result.data.planId;
  return { planId, short: planId.slice(0, 8) };
}

// Byte-for-byte state of the stores the bridge could change. The audit log and `session.json` are
// excluded because a request records itself and resolves its session whether or not it does work;
// `conversation.jsonl` is excluded because recording the answer the user received is not work either.
// Everything that a step would have to write is in the list.
function state(dir) {
  const out = {};
  for (const name of ['plans.jsonl', 'tasks.jsonl', 'goals.jsonl', 'memory.jsonl', 'knowledge.jsonl', 'experiences.jsonl', 'world-model.jsonl']) {
    out[name] = exists(dir, name) ? fs.readFileSync(file(dir, name), 'utf8') : null;
  }
  return JSON.stringify(out);
}

describe('AK-B1 a preparation, an approval and a run are three recorded acts', () => {
  test('the lifecycle writes through the existing actions and leaves one audit chain', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);

      const prep = await app.controller.handle(PREPARE_TEXT, { origin: 'user' });
      assert.equal(prep.status, Outcome.PLAN_STORED);
      assert.equal(prep.operation.capability, 'executive.prepare');
      const { planId, short } = prepared(prep);
      assert.equal((await app.plans.get(planId)).status, PlanStatus.DRAFT, 'a preparation records a draft, not an approved plan');
      assert.equal(exists(dir, 'tasks.jsonl'), false, 'preparation created no task');
      assert.equal(records(dir, 'memory.jsonl').length, 0, 'preparation wrote no memory');
      assert.match(prep.display, /This is a proposal, not an action: nothing below has run/);
      assert.match(prep.display, /waiting for your approval; approval is a separate act, and approval starts nothing/);

      const approve = await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      assert.equal(approve.status, Outcome.PLAN_STORED);
      assert.equal(approve.operation.capability, 'executive.approve');
      assert.deepEqual(approve.operation.steps.map((s) => [s.action, s.outcome]),
        [['plan.approve', Outcome.SUCCESS_VERIFIED]], 'the approval is the existing plan.approve action, verified');
      assert.equal((await app.plans.get(planId)).status, PlanStatus.APPROVED);
      assert.equal(exists(dir, 'tasks.jsonl'), false, 'an approval starts nothing');
      assert.match(approve.display, /Approval authorizes nothing by itself/);

      const run = await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      assert.equal(run.status, Outcome.SUCCESS_VERIFIED);
      assert.equal(run.operation.capability, 'executive.execute');
      assert.equal(run.operation.steps.length, 0, 'the run is audited by the task it created, not duplicated here');
      assert.equal((await app.plans.get(planId)).status, PlanStatus.COMPLETED);

      // One outer record per user act, the runner's own per-step records, and the activation's own
      // record. This is the chain the batch asks the bridge to produce by reusing, not by writing a
      // second orchestration log.
      assert.equal(auditSeq(dir),
        'executive.prepare,executive.approve,task.step,task.step,plan.activate,executive.execute');
      assert.equal(taskIds(dir).length, 1, 'one task for one started plan');
      const task = await readTask(app, dir);
      assert.equal(task.planId, planId, 'the task names the plan it was started from');
      assert.deepEqual(task.steps.map((s) => s.status), [StepStatus.COMPLETED, StepStatus.COMPLETED]);
      assert.equal(records(dir, 'memory.jsonl').length, 1, 'the write step ran once and stored its record');
      assert.equal(run.display.includes('APEX will not retry or resume'), false,
        'a run that ended clean carries no recovery reading');
    } finally {
      cleanup(dir);
    }
  });

  test('the run reports the plan, the task and the per-step outcomes it recorded', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const prep = await app.controller.handle(PREPARE_TEXT, { origin: 'user' });
      const { short } = prepared(prep);
      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      const run = await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      assert.match(run.display, /was activated as task /);
      assert.match(run.display, /Plan status: completed/);
      assert.match(run.display, /Progress: 2 of 2 step\(s\) completed/);
      assert.match(run.display, /\[completed\] s1/);
      assert.match(run.display, /\[completed\] s2/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('AK-B2 the preview is the record, and the approval binds to it', () => {
  test('every preview field is read from the stored plan and the live registry', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const prep = await app.controller.handle(PREPARE_TEXT, { origin: 'user' });
      const { planId } = prepared(prep);
      const plan = await app.plans.get(planId);

      // Intended outcome, steps with dependencies, capabilities and permissions, side effects,
      // reversibility, and the verification each step will be held to.
      assert.match(prep.display, new RegExp(`Intended outcome: ${plan.outcome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(prep.display, /Steps \(2 of at most \d+, run one at a time in this order\)/);
      assert.match(prep.display, /capability: memory\.add \(write\)/);
      assert.match(prep.display, /capability: memory\.list \(read\)/);
      assert.match(prep.display, /depends on: s1/, 'the second step is recorded as waiting for the first');
      assert.match(prep.display, /Authorization, as the registry answers it right now: 1 read, 1 write/);
      assert.match(prep.display, /Expected side effects: 1 append\(s\), 1 read-only step\(s\)/);
      assert.match(prep.display, /1 step\(s\) append a persistent record \(s1\)/);
      assert.match(prep.display, /verification: memory\.add verify\(\)/);
      assert.match(prep.display, /Plan validation: passed/);
      assert.match(prep.display, /Live validity against current state: passed/);
      assert.match(prep.display, /Nothing has run\. No step has been started, no record has been changed, and no approval has been given/);
    } finally {
      cleanup(dir);
    }
  });

  test('the printed hash is the stored plan hash, and the approval records that hash', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const prep = await app.controller.handle(PREPARE_TEXT, { origin: 'user' });
      const { planId, short } = prepared(prep);
      const hash = planContentHash(await app.plans.get(planId));
      const shown = prep.display.match(/content hash ([0-9a-f]{16})/);
      assert.ok(shown, 'the preview prints the content hash an approval binds to');
      assert.equal(hash.slice(0, 16), shown[1], 'the hash shown is the hash of the stored record');
      assert.match(prep.display, /Your approval is recorded against this hash/);

      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      const approved = await app.plans.get(planId);
      assert.equal(approved.approval.contentHash, hash, 'the approval is bound to the plan content it was shown against');
      assert.equal(approved.approval.version, 1, 'and to the version it was shown against');

      // A revision of a draft changes the hash, so what the user was shown no longer matches, and an
      // approved plan cannot be revised at all: no edit can ride on an existing approval.
      const draft = await app.controller.handle('make a plan to remember that the first draft fact holds', { origin: 'user' });
      const draftRef = prepared(draft);
      const beforeHash = planContentHash(await app.plans.get(draftRef.planId));
      const beforePlan = await app.plans.get(draftRef.planId);
      const rev = await app.controller.planRevise({
        target: draftRef.planId,
        outcome: 'a revised outcome',
        reason: 'the user changed the outcome',
        steps: beforePlan.steps.map((s) => ({
          id: s.id, description: s.description, action: s.action, input: s.input, dependsOn: s.dependsOn,
          expectedResult: s.expectedResult, verification: s.verification, risk: s.risk,
        })),
      });
      assert.equal(rev.status, Outcome.PLAN_STORED, 'a draft may be revised');
      const afterHash = planContentHash(await app.plans.get(draftRef.planId));
      assert.notEqual(afterHash, beforeHash, 'the revision changed the content hash');
      assert.equal((await app.plans.get(draftRef.planId)).approval, null, 'and left no approval behind');

      const approvedPlan = await app.plans.get(planId);
      const refused = await app.controller.planRevise({
        target: planId, outcome: 'an outcome changed after approval', reason: 'attack',
        steps: approvedPlan.steps.map((s) => ({
          id: s.id, description: s.description, action: s.action, input: s.input, dependsOn: s.dependsOn,
          expectedResult: s.expectedResult, verification: s.verification, risk: s.risk,
        })),
      });
      assert.notEqual(refused.status, Outcome.PLAN_STORED, 'an approved plan cannot be revised under its own approval');
      assert.equal(planContentHash(await app.plans.get(planId)), hash, 'and its bytes are unchanged');
    } finally {
      cleanup(dir);
    }
  });

  test('a plan that was never approved cannot be started, and nothing runs', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const prep = await app.controller.handle(PREPARE_TEXT, { origin: 'user' });
      const { planId, short } = prepared(prep);
      const before = state(dir);

      const run = await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      assert.equal(run.operation.capability, 'executive.execute');
      assert.equal(run.status, Outcome.INPUT_REJECTED, 'activation refuses a draft, and the bridge reports that refusal');
      assert.match(run.output, /only an approved plan can be started/);
      assert.equal(exists(dir, 'tasks.jsonl'), false, 'no task was created');
      assert.equal(records(dir, 'memory.jsonl').length, 0, 'no step ran');
      assert.equal((await app.plans.get(planId)).status, PlanStatus.DRAFT, 'the plan is still a draft');
      assert.equal(state(dir), before, 'a refused start changed no store');
    } finally {
      cleanup(dir);
    }
  });

  test('approval of a plan that does not exist is refused and records nothing', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle('approve plan deadbeef', { origin: 'user' });
      assert.equal(res.operation.capability, 'executive.approve');
      assert.equal(res.status, Outcome.EXECUTION_FAILED, 'the plan store refused it');
      assert.match(res.output, /no plan matches/);
      assert.equal(res.operation.steps[0].outcome, Outcome.EXECUTION_FAILED, 'the refused action is on the audit as a failed step');
      assert.equal(records(dir, 'plans.jsonl').length, 0, 'no approval was written');
    } finally {
      cleanup(dir);
    }
  });
});

describe('AK-B3 mapping: what the bridge takes and what it leaves alone', () => {
  test('a request with no registered capability for any part is refused without recording', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(UNMAPPED_ONLY, { origin: 'user' });
      assert.equal(res.status, Outcome.PLAN_REJECTED);
      assert.equal(res.operation.capability, 'executive.prepare');
      assert.equal(res.operation.steps.length, 0, 'a refusal performs no action');
      assert.match(res.display, /No plan was recorded, and nothing has run/);
      // The part is named as the user wrote it; no plausible action is substituted for it.
      assert.match(res.display, /"book a flight to Lisbon" - no registered action matches/);
      assert.match(res.display, /Nothing was recorded, so there is no plan waiting for approval/);
      assert.equal(exists(dir, 'plans.jsonl'), false, 'nothing was stored');
    } finally {
      cleanup(dir);
    }
  });

  test('a partly mappable request keeps the unmappable part as a recorded unknown', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(PARTIALLY_MAPPED, { origin: 'user' });
      assert.equal(res.status, Outcome.PLAN_STORED);
      const { planId } = prepared(res);
      const plan = await app.plans.get(planId);
      assert.equal(plan.steps.length, 1, 'only the part a registered action can carry became a step');
      assert.deepEqual(plan.assertions.map((a) => a.kind), ['user_fact', 'unknown']);
      assert.match(plan.assertions[1].text, /negotiate a treaty/);
      assert.match(res.display, /Steps that cannot currently be completed \(1\)/);
      assert.match(res.display, /No substitute capability is invented for them/);
    } finally {
      cleanup(dir);
    }
  });

  test('an approval with no plan named is asked about, never guessed', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const prep = await app.controller.handle(PREPARE_TEXT, { origin: 'user' });
      const { planId } = prepared(prep);
      const res = await app.controller.handle('approve the plan', { origin: 'user' });
      assert.equal(res.status, Outcome.CLARIFICATION_REQUIRED);
      assert.equal(res.operation.capability, 'executive.clarify');
      assert.match(res.output, /Which plan do you mean\?/);
      assert.match(res.output, /APEX will not approve the most recent plan it can find/);
      assert.equal((await app.plans.get(planId)).status, PlanStatus.DRAFT, 'the one draft that exists was not approved');
    } finally {
      cleanup(dir);
    }
  });

  test('a request the deterministic router already resolved keeps its action', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      // "the next steps are" reads as a preparation to a keyword matcher; it is a memory write.
      const res = await app.controller.handle('remember that the next steps are to call the vendor on Monday', { origin: 'user' });
      assert.equal(res.operation.capability, 'memory.add');
      assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
      assert.equal(records(dir, 'plans.jsonl').length, 0, 'no plan was invented from a memory write');
      assert.equal(records(dir, 'memory.jsonl').length, 1);
    } finally {
      cleanup(dir);
    }
  });

  test('a question naming one task stays with the task log', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const prep = await app.controller.handle(PREPARE_TEXT, { origin: 'user' });
      const { short } = prepared(prep);
      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      const taskId = taskIds(dir)[0];
      assert.ok(taskId, 'the run created a task record');
      const res = await app.controller.handle(`why did task ${taskId} fail?`, { origin: 'user' });
      assert.equal(res.operation.capability, 'task.explain',
        'one named task is answered from that task and its own operation records, not from the portfolio view');
      assert.equal(res.operation.capability.startsWith('executive.'), false);
    } finally {
      cleanup(dir);
    }
  });

  test('a model-origin request never takes the bridge', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const prep = await app.controller.handle(PREPARE_TEXT, { origin: 'user' });
      const { planId, short } = prepared(prep);

      const asModel = await app.controller.handle(PREPARE_TEXT, { origin: 'model' });
      assert.equal(asModel.operation.capability, 'model.answer', 'the model path, as it was before the bridge existed');
      assert.equal(asModel.status, Outcome.MODEL_UNAVAILABLE);
      assert.equal(records(dir, 'plans.jsonl').length, 1, 'a model asking for a plan records nothing');

      // A model cannot approve or start either: the acts stay on the path that has no authority.
      const startAsModel = await app.controller.handle(`start plan ${short}`, { origin: 'model' });
      assert.equal(startAsModel.operation.capability, 'model.answer');
      assert.equal(exists(dir, 'tasks.jsonl'), false, 'a model-origin request started nothing');
      const approveAsModel = await app.controller.handle(`approve plan ${short}`, { origin: 'model' });
      assert.equal(approveAsModel.operation.capability, 'model.answer');
      assert.equal((await app.plans.get(planId)).status, PlanStatus.DRAFT, 'and approved nothing');
    } finally {
      cleanup(dir);
    }
  });

  test('a request that is too long or carries a credential is not read as an executive act', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const long = `prepare a plan to remember that the fact holds ${'y'.repeat(520)}`;
      const longRes = await app.controller.handle(long, { origin: 'user' });
      assert.equal(longRes.operation.capability, 'model.answer');
      const secretRes = await app.controller.handle('prepare a plan to remember that api_key is abcdef123456', { origin: 'user' });
      assert.equal(secretRes.operation.capability, 'model.answer');
      assert.equal(exists(dir, 'plans.jsonl'), false, 'neither recorded a plan');
      // The bound that produced these two answers is stated in the mapping, not assumed here.
      assert.equal(executiveSignal(long, { plansAvailable: true }), null);
      assert.equal(executiveSignal('prepare a plan to remember that api_key is abcdef123456', { plansAvailable: true }), null);
    } finally {
      cleanup(dir);
    }
  });
});

describe('AK-B4 status is read from the records and runs nothing', () => {
  test('the portfolio questions are answered from plan, task and goal records', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const prep = await app.controller.handle(PREPARE_TEXT, { origin: 'user' });
      const { planId, short } = prepared(prep);
      const before = state(dir);

      const approval = await app.controller.handle('what needs my approval?', { origin: 'user' });
      assert.equal(approval.status, Outcome.SUCCESS_VERIFIED);
      assert.equal(approval.operation.capability, 'executive.status');
      assert.equal(approval.operation.steps.length, 0, 'a status answer performs no action');
      assert.match(approval.display, /Executive status, read from APEX records\. Nothing here was run, approved, changed, or cancelled/);
      assert.match(approval.display, /Records read: 0 goal\(s\), 1 plan\(s\), 0 task\(s\)/);
      // Every state names the record it was read from.
      assert.match(approval.display, new RegExp(`awaiting_approval\\. evidence: plan ${short} is recorded as draft`));
      assert.match(approval.display, /These states were read from records/);
      assert.equal(state(dir), before, 'answering changed none of the state stores');

      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      const approvedState = state(dir);
      const next = await app.controller.handle("what's next", { origin: 'user' });
      assert.equal(next.operation.capability, 'executive.status');
      assert.match(next.display, /Next, ranked from the records \(a recommendation only - it is not permission\)/);
      assert.match(next.display, /action: review-plan|action: start-plan/, 'the ranking names the next recorded act');
      assert.equal(state(dir), approvedState, 'the next-step question ran nothing');

      const activity = await app.controller.handle('what are you doing?', { origin: 'user' });
      assert.equal(activity.operation.capability, 'executive.status');
      assert.match(activity.display, /it has no background process, so nothing is in progress between commands/);
      assert.match(activity.display, /No plan or task is recorded as running/);
      assert.equal(state(dir), approvedState, 'and neither did the activity question');

      await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      const runState = state(dir);
      const done = await app.controller.handle('what have you completed so far?', { origin: 'user' });
      assert.equal(done.operation.capability, 'executive.status');
      assert.match(done.display, /Records read: 0 goal\(s\), 1 plan\(s\), 1 task\(s\)/);
      assert.match(done.display, new RegExp(`verified\\. evidence: plan ${short} is recorded as completed`));
      assert.equal(state(dir), runState, 'a status answer cannot re-run or re-record the work it describes');
      assert.equal((await app.plans.get(planId)).status, PlanStatus.COMPLETED, 'and the answer matches the record');

      // The phrasing that asks what APEX's records say is answered from those records. The one that
      // asks what the user should do is advice, and it keeps the path that reads the same records,
      // gives them to the configured model, and marks any recommendation as not executed.
      const progress = await app.controller.handle('what is the status of my goal and plan progress?', { origin: 'user' });
      assert.equal(progress.operation.capability, 'executive.status');
      assert.match(progress.display, new RegExp(`Records read: 0 goal\\(s\\), 1 plan\\(s\\), 1 task\\(s\\)`));
      const whatNext = await app.controller.handle('what should I do next?', { origin: 'user' });
      assert.equal(whatNext.operation.capability, 'model.answer');
      assert.equal(state(dir), runState, 'neither question ran or recorded anything');

      // A question about something APEX does not hold is not an executive status question.
      const essay = await app.controller.handle("what's next on my essay?", { origin: 'user' });
      assert.equal(essay.operation.capability, 'model.answer');
    } finally {
      cleanup(dir);
    }
  });

  test('every open record state printed is one the vocabulary defines', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      await app.controller.handle(PREPARE_TEXT, { origin: 'user' });
      const { EXECUTION_STATES } = await import('../src/executive/vocabulary.js');
      const res = await app.controller.handle('what is the overall status?', { origin: 'user' });
      assert.equal(res.operation.capability, 'executive.status');
      const states = res.display.split('\n').filter((l) => /^ {2}\S+: \d+ - /.test(l)).map((l) => l.trim().split(':')[0]);
      assert.ok(states.length > 0, 'the overall view lists the states it counted');
      for (const s of states) {
        assert.ok(EXECUTION_STATES.includes(s) || s === 'unrecognised', `${s} is not a state the bridge defines`);
      }
    } finally {
      cleanup(dir);
    }
  });
});

describe('AK-B5 a run that does not end clean is reported from its records', () => {
  test('a failed step is reported as failed, and nothing is retried by APEX', async () => {
    const dir = makeTempDataDir();
    try {
      const sink = [];
      const failing = makeFakeTaskActions(sink).filter((a) => a.name === 'test.fail');
      const app = await appIn(dir, { extraActions: failing });
      const add = await app.controller.planAdd({
        outcome: 'a plan whose only step fails',
        reason: 'the failure case',
        steps: [{
          id: 's1', description: 'a step that fails', action: 'test.fail', input: {}, dependsOn: [],
          expectedResult: 'the action reports a result', verification: 'the action verifies its own result', risk: 'low',
        }],
      });
      const planId = add.operation.steps[0].result.data.planId;
      await app.controller.planApprove({ target: planId });

      const run = await app.controller.handle(`start plan ${planId.slice(0, 8)}`, { origin: 'user' });
      assert.equal(run.status, Outcome.EXECUTION_FAILED);
      assert.equal(run.operation.capability, 'executive.execute');
      // The bridge attaches a recovery reading exactly where the run did not end clean.
      assert.match(run.display, /step s1 \(test\.fail, read\) is failed: verified not done/);
      assert.match(run.display, /interrupted at: during_action/);
      assert.match(run.display, /it is not run again by APEX/);
      assert.match(run.display, /recovery reads the task log and the operation audit/);
      assert.match(run.display, /APEX will not retry or resume any of this on its own/);
      const task = await readTask(app, dir);
      assert.deepEqual(task.steps.map((s) => s.status), [StepStatus.FAILED]);
      assert.equal(sink.length, 0, 'the step executed once and never again');
      assert.equal(taskIds(dir).length, 1, 'and the bridge invented no second task over it');
    } finally {
      cleanup(dir);
    }
  });

  test('an uncheckable step is reported as uncertain, never as done', async () => {
    const dir = makeTempDataDir();
    try {
      const sink = [];
      const app = await appIn(dir, { extraActions: makeFakeTaskActions(sink).filter((a) => a.name === 'test.unverified') });
      const add = await app.controller.planAdd({
        outcome: 'a plan whose step cannot be independently checked',
        reason: 'the uncertain case',
        steps: [{
          id: 's1', description: 'an uncheckable read', action: 'test.unverified', input: { tag: 'u1' }, dependsOn: [],
          expectedResult: 'the action returns something', verification: 'no independent check exists', risk: 'low',
        }],
      });
      const planId = add.operation.steps[0].result.data.planId;
      await app.controller.planApprove({ target: planId });

      const run = await app.controller.handle(`start plan ${planId.slice(0, 8)}`, { origin: 'user' });
      assert.equal(run.status, Outcome.VERIFICATION_UNAVAILABLE,
        'a side effect that may exist is not reported as a failure, and not as a success');
      assert.match(run.display, /step s1: may or may not have happened: no record verifies its outcome/);
      assert.match(run.display, /APEX will not repeat them automatically/);
      assert.match(run.display, /APEX will not retry or resume any of this on its own/);
      assert.deepEqual((await readTask(app, dir)).steps.map((s) => s.status), [StepStatus.UNCERTAIN]);
      assert.equal(sink.length, 1, 'the step ran once; an uncertain outcome is never replayed');
    } finally {
      cleanup(dir);
    }
  });

  test('starting a plan that already ran is refused, so a side effect is not repeated', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const prep = await app.controller.handle(PREPARE_TEXT, { origin: 'user' });
      const { short } = prepared(prep);
      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      const before = state(dir);

      const again = await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      assert.equal(again.status, Outcome.INPUT_REJECTED);
      assert.match(again.output, /plan is completed/);
      assert.match(again.output, /starting it again would repeat work that already happened/);
      assert.equal(state(dir), before, 'the refusal wrote nothing');
      assert.equal(records(dir, 'memory.jsonl').length, 1, 'the memory write happened once');
      assert.equal(taskIds(dir).length, 1, 'and no second task exists');
    } finally {
      cleanup(dir);
    }
  });

  test('starting a plan that does not exist reports the store\'s own refusal', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle('start plan deadbeef', { origin: 'user' });
      assert.equal(res.operation.capability, 'executive.execute');
      assert.equal(res.status, Outcome.INPUT_REJECTED);
      assert.equal(exists(dir, 'tasks.jsonl'), false);
      assert.match(res.display ?? res.output, /deadbeef|no plan/i);
    } finally {
      cleanup(dir);
    }
  });
});

describe('AK-B6 outcomes reach the existing learning path, and only verified ones', () => {
  test('the bridge records no experience for acts that are not experiences', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir, { experienceCapture: CAPTURE_VERIFIED_SUCCESS });
      const prep = await app.controller.handle(PREPARE_TEXT, { origin: 'user' });
      const { short } = prepared(prep);
      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      const run = await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      assert.equal(run.status, Outcome.SUCCESS_VERIFIED);

      // Every capability the bridge ends an operation with is an explicitly classified exclusion, so
      // the absence of experiences below is a decision in the inventory, not a broken pipe.
      for (const name of ['executive.prepare', 'executive.approve', 'executive.execute', 'executive.status', 'executive.clarify']) {
        assert.ok(Object.hasOwn(CAPTURE_EXCLUDED_CAPABILITIES, name), `${name} is unclassified`);
      }
      assert.equal(records(dir, 'experiences.jsonl').length, 0,
        'a recorded plan, a recorded approval and a run covered by its own task log are not experiences');

      // The same app, the same clock, an eligible write: capture is live, so the zero above means
      // something.
      await app.controller.handle('remember that the AK control fact was written directly', { origin: 'user' });
      assert.equal(records(dir, 'experiences.jsonl').length, 1, 'the eligible verified write was captured');

      // A refused preparation and a refused run never become a successful experience.
      await app.controller.handle(UNMAPPED_ONLY, { origin: 'user' });
      await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      assert.equal(records(dir, 'experiences.jsonl').length, 1, 'nothing unverified or refused was captured');
    } finally {
      cleanup(dir);
    }
  });

  test('the run outcome is recorded against the plan so later reads see it', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const prep = await app.controller.handle(PREPARE_TEXT, { origin: 'user' });
      const { planId, short } = prepared(prep);
      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      await app.controller.handle(`start plan ${short}`, { origin: 'user' });

      const plan = await app.plans.get(planId);
      assert.deepEqual(Object.values(plan.stepResults).map((r) => r.status),
        [StepStatus.COMPLETED, StepStatus.COMPLETED], 'per-step outcomes are recorded against the plan');
      assert.ok(Object.values(plan.stepResults).every((r) => typeof r.operationId === 'string'),
        'each names the operation record that established it');
      assert.equal(plan.activation.contentHash, plan.approval.contentHash,
        'and the run started from exactly the bytes the approval was bound to');
      const report = await app.controller.continuationReport();
      assert.deepEqual(report.plans.map((p) => p.id), [planId]);
      assert.equal(report.tasks.length, 1);
      assert.equal(report.goals.length, 0, 'this preparation was not attached to a goal, and the report says so');
    } finally {
      cleanup(dir);
    }
  });
});
