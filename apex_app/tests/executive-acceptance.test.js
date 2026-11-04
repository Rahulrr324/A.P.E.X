// Batch AK, work package K: 25 numbered end-to-end acceptance scenarios for the executive bridge.
//
// Each scenario is the whole path a user takes - the words they type, the record APEX writes, the
// answer APEX gives afterwards - driven through `controller.handle()` and, where noted, through the
// CLI in a child process. No scenario calls a helper in isolation: what is asserted is the persisted
// audit, the persisted plan/task/memory records, and the printed words.
//
// No inference is run and no model is contacted. Where a scenario needs a step that fails or cannot
// be verified, it registers a labelled test double (`test.fail`, `test.unverified`) and says so in
// the assertion, so a double's report is never mistaken for a real action's outcome.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF, CAPTURE_VERIFIED_SUCCESS } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { PlanStatus, planContentHash } from '../src/plans/model.js';
import { StepStatus } from '../src/tasks/model.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const CLOCK = () => new Date('2026-11-04T09:00:00.000Z');
const TWO_PARTS = 'prepare a plan to remember that the AK acceptance fact holds and then list my memories';
const WRITE_ONLY = 'prepare a plan to remember that the AK acceptance note holds';

function appIn(dir, extra = {}) {
  return createApp({ dataDir: dir, now: CLOCK, experienceCapture: CAPTURE_OFF, ...extra });
}

const file = (dir, name) => path.join(dir, name);
const exists = (dir, name) => fs.existsSync(file(dir, name));

function records(dir, name) {
  if (!exists(dir, name)) return [];
  return fs.readFileSync(file(dir, name), 'utf8').split(/\r?\n/).filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

const capabilities = (dir) => records(dir, 'operations.jsonl').map((r) => r.capability);
const taskIds = (dir) => [...new Set(records(dir, 'tasks.jsonl').map((r) => r.taskId))];

// The plan a preparation recorded, read back from the store rather than from the answer's words.
async function recordedPlan(app, res) {
  assert.equal(res.operation.steps.length, 1, 'a preparation performs exactly one action step');
  assert.equal(res.operation.steps[0].action, 'plan.add');
  const planId = res.operation.steps[0].result.data.planId;
  return { planId, short: planId.slice(0, 8), plan: await app.plans.get(planId) };
}

// Everything a step would have to write. The audit, session and conversation files are excluded
// because a request records itself and answers itself whether or not it does any work.
function state(dir) {
  const out = {};
  for (const name of ['plans.jsonl', 'tasks.jsonl', 'goals.jsonl', 'memory.jsonl', 'knowledge.jsonl', 'experiences.jsonl', 'world-model.jsonl']) {
    out[name] = exists(dir, name) ? fs.readFileSync(file(dir, name), 'utf8') : null;
  }
  return JSON.stringify(out);
}

describe('AK-K scenarios 1-6: a request becomes a record, a record becomes an approval, an approval becomes a run', () => {
  test('K-01 an empty portfolio is reported as empty, not guessed at', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle('what is the overall status?', { origin: 'user' });
      assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
      assert.equal(res.operation.capability, 'executive.status');
      assert.match(res.display, /Records read: 0 goal\(s\), 0 plan\(s\), 0 task\(s\)/);
      assert.match(res.display, /Nothing is open\. No work is proposed, prepared, approved, running, or blocked\./);
      assert.equal(exists(dir, 'plans.jsonl'), false, 'a status read created no plan log');
    } finally {
      cleanup(dir);
    }
  });

  test('K-02 "prepare a plan to …" records a draft carrying both parts of the request', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(TWO_PARTS, { origin: 'user' });
      assert.equal(res.status, Outcome.PLAN_STORED);
      assert.equal(res.operation.capability, 'executive.prepare');
      const { plan } = await recordedPlan(app, res);
      assert.equal(plan.status, PlanStatus.DRAFT, 'a preparation records a draft');
      assert.equal(plan.approval, null, 'and no approval of its own');
      assert.deepEqual(plan.steps.map((s) => s.action), ['memory.add', 'memory.list'], 'both parts are registered actions');
      assert.deepEqual(plan.steps.map((s) => s.dependsOn), [[], ['s1']], 'the run order is the order the user spoke in');
      assert.equal(records(dir, 'memory.jsonl').length, 0, 'preparation wrote no memory');
      assert.equal(exists(dir, 'tasks.jsonl'), false, 'and created no task');
    } finally {
      cleanup(dir);
    }
  });

  test('K-03 the preview shown is the record, with the registry\'s own answers beside each step', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(TWO_PARTS, { origin: 'user' });
      const { plan } = await recordedPlan(app, res);
      assert.match(res.display, /Execution preview of the recorded plan\. This is a proposal, not an action: nothing below has run\./);
      assert.match(res.display, new RegExp(`Intended outcome: ${plan.outcome.slice(0, 40)}`));
      assert.ok(res.display.includes(`Steps (${plan.steps.length} of at most `), 'the preview names the step count and its bound');
      assert.match(res.display, /capability: memory\.add \(write\)/);
      assert.match(res.display, /capability: memory\.list \(read\)/);
      assert.match(res.display, /depends on: s1/);
      assert.match(res.display, /verification: memory\.add verify\(\)/);
      assert.match(res.display, /Authorization, as the registry answers it right now: 1 read, 1 write/);
      assert.match(res.display, /Expected side effects: 1 append\(s\), 1 read-only step\(s\)\./);
      assert.match(res.display, /Plan validation: passed/);
      assert.match(res.display, /Live validity against current state: passed/);
      assert.match(res.display, /Nothing has run\. No step has been started, no record has been changed, and no approval has been given\./);
    } finally {
      cleanup(dir);
    }
  });

  test('K-04 approval is bound to the content hash the preview printed', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(TWO_PARTS, { origin: 'user' });
      const { plan, short } = await recordedPlan(app, res);
      const printed = /content hash ([0-9a-f]{16})/.exec(res.display)?.[1];
      assert.ok(printed, 'the preview prints the hash the approval binds to');
      assert.equal(planContentHash(plan).slice(0, 16), printed, 'the preview prints the hash of the recorded content');

      const approve = await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      assert.equal(approve.status, Outcome.PLAN_STORED);
      assert.equal(approve.operation.capability, 'executive.approve');
      const after = await app.plans.get(plan.id);
      assert.equal(after.status, PlanStatus.APPROVED);
      assert.equal(after.approval.contentHash.slice(0, 16), printed, 'the recorded approval names that same hash');
      assert.equal(after.approval.contentHash, planContentHash(after), 'and it hashes the content the plan holds now');
      assert.equal(after.approval.version, after.version, 'and the version it was given against');
      assert.equal(exists(dir, 'tasks.jsonl'), false, 'approval starts nothing');
      assert.match(approve.display, /Approval authorizes nothing by itself/);
    } finally {
      cleanup(dir);
    }
  });

  test('K-05 starting an approved plan runs it through the existing task runner', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(TWO_PARTS, { origin: 'user' });
      const { plan, short } = await recordedPlan(app, res);
      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      const run = await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      assert.equal(run.status, Outcome.SUCCESS_VERIFIED);
      assert.equal(run.operation.capability, 'executive.execute');
      assert.equal(run.operation.steps.length, 0, 'the run is audited by its own task records, not duplicated');
      assert.equal(taskIds(dir).length, 1, 'one task for one started plan');
      const task = await app.taskStore.get(taskIds(dir)[0]);
      assert.equal(task.planId, plan.id, 'the task names the plan it came from');
      assert.deepEqual(task.steps.map((s) => s.status), [StepStatus.COMPLETED, StepStatus.COMPLETED]);
      assert.equal(records(dir, 'memory.jsonl').length, 1, 'the write step stored its record once');
      const done = await app.plans.get(plan.id);
      assert.equal(done.status, PlanStatus.COMPLETED);
      assert.deepEqual(Object.values(done.stepResults).map((r) => r.status), [StepStatus.COMPLETED, StepStatus.COMPLETED],
        'each outcome is recorded against the plan it belongs to');
      assert.equal(done.activation.contentHash, done.approval.contentHash, 'the run started from the approved bytes');
    } finally {
      cleanup(dir);
    }
  });

  test('K-06 one lifecycle leaves one audit chain and nothing else', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(TWO_PARTS, { origin: 'user' });
      const { short } = await recordedPlan(app, res);
      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      assert.deepEqual(capabilities(dir),
        ['executive.prepare', 'executive.approve', 'task.step', 'task.step', 'plan.activate', 'executive.execute'],
        'the outer acts, the runner\'s own per-step records, and the activation it wrote');
    } finally {
      cleanup(dir);
    }
  });
});

describe('AK-K scenarios 7-12: the nine questions are answered from those records', () => {
  test('K-07 "what have you completed so far?" cites the completed plan and its task', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(TWO_PARTS, { origin: 'user' });
      const { short } = await recordedPlan(app, res);
      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      const before = state(dir);
      const q = await app.controller.handle('what have you completed so far?', { origin: 'user' });
      assert.equal(q.operation.capability, 'executive.status');
      assert.match(q.display, /Records read: 0 goal\(s\), 1 plan\(s\), 1 task\(s\)/);
      assert.match(q.display, /verified\. evidence: plan /);
      assert.match(q.display, /2 step outcome\(s\) recorded as completed/);
      assert.equal(state(dir), before, 'answering ran and recorded nothing');
    } finally {
      cleanup(dir);
    }
  });

  test('K-08 "what needs my approval?" names the draft and nothing else', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const first = await app.controller.handle(TWO_PARTS, { origin: 'user' });
      const { short } = await recordedPlan(app, first);
      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      const second = await app.controller.handle(WRITE_ONLY, { origin: 'user' });
      const { short: otherShort } = await recordedPlan(app, second);
      const q = await app.controller.handle('what needs my approval?', { origin: 'user' });
      assert.equal(q.status, Outcome.SUCCESS_VERIFIED);
      assert.match(q.display, new RegExp(`awaiting_approval\. evidence: plan ${otherShort} is recorded as draft`));
      assert.match(q.display, new RegExp(`plan ${short}`), 'the approved plan is still shown, under its own heading');
      assert.match(q.display, /Approved already, and waiting for you to start them/);
      assert.match(q.display, /What needs your approval, and nothing else can supply/);
    } finally {
      cleanup(dir);
    }
  });

  test('K-09 "what is the overall status?" lists each open record with its evidence', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(TWO_PARTS, { origin: 'user' });
      const q = await app.controller.handle('what is the overall status?', { origin: 'user' });
      assert.match(q.display, /Executive status, read from APEX records\. Nothing here was run, approved, changed, or cancelled\./);
      assert.match(q.display, /These states were read from records\. APEX has proposed nothing here, approved nothing, started nothing, and completed nothing\./);
      assert.match(q.display, new RegExp(`awaiting_approval\. evidence: plan ${res.operation.steps[0].result.data.planId.slice(0, 8)}`));
    } finally {
      cleanup(dir);
    }
  });

  test('K-10 "what\'s next" ranks the approved plan and gives the command, running nothing', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(TWO_PARTS, { origin: 'user' });
      const { short } = await recordedPlan(app, res);
      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      const before = state(dir);
      const q = await app.controller.handle("what's next", { origin: 'user' });
      assert.equal(q.operation.capability, 'executive.status');
      assert.match(q.display, /Next, ranked from the records \(a recommendation only - it is not permission\)/);
      assert.match(q.display, /node bin\/apex\.js plan start/);
      assert.equal(state(dir), before, 'the ranking is a read; it started the plan it named');
      assert.equal(exists(dir, 'tasks.jsonl'), false);
    } finally {
      cleanup(dir);
    }
  });

  test('K-11 "what are you doing?" states the architecture fact and finds no running work', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      await app.controller.handle(TWO_PARTS, { origin: 'user' });
      const q = await app.controller.handle('what are you doing?', { origin: 'user' });
      assert.match(q.display, /APEX runs only when you run a command: it has no background process, so nothing is in progress between commands/);
      assert.match(q.display, /No plan or task is recorded as running, so APEX is not carrying out work for you\./);
    } finally {
      cleanup(dir);
    }
  });

  test('K-12 "can you continue?" answers from the records and defers the command to the user', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(TWO_PARTS, { origin: 'user' });
      const { short } = await recordedPlan(app, res);
      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      const before = state(dir);
      const q = await app.controller.handle('can you continue?', { origin: 'user' });
      assert.equal(q.operation.capability, 'executive.status');
      assert.match(q.display, /work can be continued, and only when you run the command/);
      assert.match(q.display, new RegExp(`plan start ${short}`), 'the answer names the command, and does not run it');
      assert.equal(state(dir), before, 'and the answer started nothing');
    } finally {
      cleanup(dir);
    }
  });
});

describe('AK-K scenarios 13-18: a run that does not end clean is reported, never papered over', () => {
  // Two steps where the first fails: the dependent step is accounted for without running.
  async function appWithFailingPlan(dir) {
    const { makeFakeTaskActions } = await import('./helpers.js');
    const sink = [];
    const app = await appIn(dir, { extraActions: makeFakeTaskActions(sink) });
    const add = await app.controller.planAdd({
      outcome: 'a plan whose middle step fails',
      reason: 'the dependency case',
      steps: [
        { id: 's1', description: 'a step that succeeds', action: 'test.ok', input: { tag: 'a' }, dependsOn: [],
          expectedResult: 'the double reports success', verification: 'the double verifies its own report', risk: 'low' },
        { id: 's2', description: 'a step that fails', action: 'test.fail', input: {}, dependsOn: ['s1'],
          expectedResult: 'the double throws', verification: 'the double verifies its own report', risk: 'low' },
        { id: 's3', description: 'a step that must never run', action: 'test.ok', input: { tag: 'c' }, dependsOn: ['s2'],
          expectedResult: 'the double reports success', verification: 'the double verifies its own report', risk: 'low' },
      ],
    });
    const planId = add.operation.steps[0].result.data.planId;
    await app.controller.planApprove({ target: planId });
    return { app, planId, short: planId.slice(0, 8), sink };
  }

  test('K-13 a failed step stops the plan and its dependants never run', async () => {
    const dir = makeTempDataDir();
    try {
      const { app, short, sink } = await appWithFailingPlan(dir);
      const run = await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      assert.equal(run.status, Outcome.PARTIAL_OUTCOME ?? Outcome.EXECUTION_FAILED);
      const task = await app.taskStore.get(taskIds(dir)[0]);
      assert.deepEqual(task.steps.map((s) => s.status),
        [StepStatus.COMPLETED, StepStatus.FAILED, StepStatus.SKIPPED],
        'the dependent step is recorded as skipped: accounted for, and never run');
      assert.deepEqual(sink, ['a'], 'only the step before the failure executed');
    } finally {
      cleanup(dir);
    }
  });

  test('K-14 the failed run carries a recovery reading and no retry promise', async () => {
    const dir = makeTempDataDir();
    try {
      const { app, short } = await appWithFailingPlan(dir);
      const run = await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      assert.match(run.display, /step s2 \(test\.fail, read\) is failed: verified not done/);
      assert.match(run.display, /recovery reads the task log and the operation audit/);
      assert.match(run.display, /APEX will not retry or resume any of this on its own/);
      assert.equal(taskIds(dir).length, 1, 'the bridge invented no second task over the failure');
    } finally {
      cleanup(dir);
    }
  });

  test('K-15 "what is blocked?" and "what is uncertain?" read the same records the run wrote', async () => {
    const dir = makeTempDataDir();
    try {
      const { app, short } = await appWithFailingPlan(dir);
      await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      const failed = await app.controller.handle('what failed?', { origin: 'user' });
      assert.equal(failed.operation.capability, 'executive.status');
      assert.match(failed.display, /step\(s\) recorded as failed\. Nothing retries on its own/);
      assert.match(failed.display, /task .* step s2: failed/);
      const uncertain = await app.controller.handle('what is uncertain?', { origin: 'user' });
      assert.match(uncertain.display, /No step is recorded as uncertain/);
    } finally {
      cleanup(dir);
    }
  });

  test('K-16 an uncheckable step is uncertain, is never replayed, and says how to resolve it', async () => {
    const dir = makeTempDataDir();
    try {
      const { makeFakeTaskActions } = await import('./helpers.js');
      const sink = [];
      const app = await appIn(dir, { extraActions: makeFakeTaskActions(sink).filter((a) => a.name === 'test.unverified') });
      const add = await app.controller.planAdd({
        outcome: 'a plan with a step nothing can check',
        reason: 'the uncertain case',
        steps: [{ id: 's1', description: 'an uncheckable read', action: 'test.unverified', input: { tag: 'u1' }, dependsOn: [],
          expectedResult: 'the double returns something', verification: 'no independent check exists', risk: 'low' }],
      });
      const planId = add.operation.steps[0].result.data.planId;
      await app.controller.planApprove({ target: planId });
      const run = await app.controller.handle(`start plan ${planId.slice(0, 8)}`, { origin: 'user' });
      assert.equal(run.status, Outcome.VERIFICATION_UNAVAILABLE);
      assert.match(run.display, /may or may not have happened: no record verifies its outcome/);
      assert.deepEqual((await app.taskStore.get(taskIds(dir)[0])).steps.map((s) => s.status), [StepStatus.UNCERTAIN]);
      const q = await app.controller.handle('what is uncertain?', { origin: 'user' });
      assert.match(q.display, /1 step\(s\) are uncertain/);
      assert.match(q.display, /task .* step s1: u1|APEX will not retry one/);
      assert.equal(sink.length, 1, 'the question and the answer between them never re-ran it');
    } finally {
      cleanup(dir);
    }
  });

  test('K-17 an unapproved plan cannot be started, and the refusal writes nothing', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(TWO_PARTS, { origin: 'user' });
      const { short } = await recordedPlan(app, res);
      const before = state(dir);
      const run = await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      assert.equal(run.status, Outcome.INPUT_REJECTED);
      assert.match(run.output, /plan is draft; only an approved plan can be started; the plan has no recorded approval/);
      assert.equal(state(dir), before, 'the refusal is a read of the record, not a change to it');
      assert.equal(exists(dir, 'tasks.jsonl'), false);
    } finally {
      cleanup(dir);
    }
  });

  test('K-18 a plan that already ran is refused a second run, so no side effect repeats', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(WRITE_ONLY, { origin: 'user' });
      const { short } = await recordedPlan(app, res);
      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      const before = state(dir);
      const again = await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      assert.equal(again.status, Outcome.INPUT_REJECTED);
      assert.match(again.output, /starting it again would repeat work that already happened/);
      assert.equal(state(dir), before);
      assert.equal(records(dir, 'memory.jsonl').length, 1, 'the memory exists once');
      assert.equal(taskIds(dir).length, 1, 'and no second task was created over it');
    } finally {
      cleanup(dir);
    }
  });
});

describe('AK-K scenarios 19-25: what the bridge will not do', () => {
  test('K-19 a request no capability can carry is refused and records nothing', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const before = state(dir);
      const res = await app.controller.handle('prepare a plan to book a flight to Lisbon', { origin: 'user' });
      assert.equal(res.status, Outcome.PLAN_REJECTED);
      assert.match(res.display, /No plan was recorded, and nothing has run\./);
      assert.match(res.display, /Parts of the request that no registered capability can take/);
      assert.match(res.display, /book a flight to Lisbon/);
      assert.equal(state(dir), before, 'a refusal stored no plan');
      assert.equal(capabilities(dir).length, 1, 'and left only its own operation record');
    } finally {
      cleanup(dir);
    }
  });

  test('K-20 a partly mappable request keeps the unmappable part as a recorded unknown', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle('prepare a plan to remember that the partial AK fact holds and then negotiate a treaty', { origin: 'user' });
      assert.equal(res.status, Outcome.PLAN_STORED);
      const { plan, short } = await recordedPlan(app, res);
      assert.equal(plan.steps.length, 1, 'only the part a capability can take became a step');
      assert.equal(plan.steps[0].action, 'memory.add');
      assert.ok((plan.assertions ?? []).some((a) => a.kind === 'unknown' && /negotiate a treaty/.test(a.text)),
        'the unmappable part is recorded as an unknown in the plan itself');
      assert.match(res.display, /Steps that cannot currently be completed \(1\)/);
      assert.match(res.display, /No substitute capability is invented for them/);
      const shown = await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      assert.match(shown.display, /cannot currently be completed/, 'the unknown is still disclosed after approval');
    } finally {
      cleanup(dir);
    }
  });

  test('K-21 an approval that names no plan is asked about, never guessed', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      await app.controller.handle(TWO_PARTS, { origin: 'user' });
      const res = await app.controller.handle('approve the plan', { origin: 'user' });
      assert.equal(res.status, Outcome.CLARIFICATION_REQUIRED);
      assert.equal(res.operation.capability, 'executive.clarify');
      assert.match(res.display, /APEX will not approve the most recent plan it can find/);
      assert.equal((await app.plans.list())[0].approval, null, 'no plan was approved');
    } finally {
      cleanup(dir);
    }
  });

  test('K-22 a plan is approved only by the act that names it: a twin draft stays a draft', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const a = await recordedPlan(app, await app.controller.handle('prepare a plan to remember that the AK twin a holds', { origin: 'user' }));
      const b = await recordedPlan(app, await app.controller.handle('prepare a plan to remember that the AK twin b holds', { origin: 'user' }));
      await app.controller.handle(`approve plan ${a.short}`, { origin: 'user' });
      const startB = await app.controller.handle(`start plan ${b.short}`, { origin: 'user' });
      assert.equal(startB.status, Outcome.INPUT_REJECTED, 'approving one plan authorizes no other');
      assert.match(startB.output, /no recorded approval/);
      assert.equal((await app.plans.get(b.planId)).status, PlanStatus.DRAFT);
      assert.equal(exists(dir, 'tasks.jsonl'), false, 'and nothing ran');
    } finally {
      cleanup(dir);
    }
  });

  test('K-23 a request that carries a credential is not taken as an executive act and persists nothing', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const before = state(dir);
      const res = await app.controller.handle('prepare a plan to remember that my api_key is sk-abcdefghij0123456789ABCDEF', { origin: 'user' });
      assert.equal(res.operation.capability, 'model.answer', 'the bridge does not read it as an executive act');
      assert.equal(res.operation.steps.length, 0, 'and no action ran on it');
      assert.equal(state(dir), before, 'so no plan was recorded either');
      assert.equal(exists(dir, 'plans.jsonl'), false, 'the request that would have made a plan made none');
      const persisted = fs.readdirSync(dir).map((n) => {
        const p = path.join(dir, n);
        return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : '';
      }).join('\n');
      assert.equal(persisted.includes('sk-abcdefghij0123456789ABCDEF'), false, 'the credential survives in no store');
    } finally {
      cleanup(dir);
    }
  });

  test('K-24 the same lifecycle is reachable from the CLI, and the CLI writes the same records', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir);
      const res = await app.controller.handle(WRITE_ONLY, { origin: 'user' });
      const { planId, short } = await recordedPlan(app, res);
      const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
      const cli = (args) => runCli(args, env);

      const shown = await cli(['plan', 'show', short]);
      assert.equal(shown.code, 0, shown.stdout + shown.stderr);
      assert.match(shown.stdout, /memory\.add/);

      const approved = await cli(['plan', 'approve', short]);
      assert.equal(approved.code, 0, approved.stdout + approved.stderr);
      const afterApproval = await app.plans.get(planId);
      assert.equal(afterApproval.approval.contentHash, planContentHash(afterApproval),
        'the CLI approval binds to the content the plan holds');
      assert.equal(afterApproval.approval.contentHash.slice(0, 16),
        /content hash ([0-9a-f]{16})/.exec(res.display)?.[1], 'and to the same hash the conversation previewed');

      const started = await cli(['plan', 'start', short]);
      assert.equal(started.code, 0, started.stdout + started.stderr);
      const after = await app.plans.get(planId);
      assert.equal(after.status, PlanStatus.COMPLETED, 'a CLI start finishes the plan the conversation recorded');
      assert.equal(records(dir, 'memory.jsonl').length, 1, 'and its step wrote once, not twice');
    } finally {
      cleanup(dir);
    }
  });

  test('K-25 the bridge records no experience for its own acts, and a verified write does', async () => {
    const dir = makeTempDataDir();
    try {
      const app = await appIn(dir, { experienceCapture: CAPTURE_VERIFIED_SUCCESS });
      const res = await app.controller.handle(TWO_PARTS, { origin: 'user' });
      const { short } = await recordedPlan(app, res);
      await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
      const run = await app.controller.handle(`start plan ${short}`, { origin: 'user' });
      assert.equal(run.status, Outcome.SUCCESS_VERIFIED);
      assert.equal(records(dir, 'experiences.jsonl').length, 0,
        'a preparation, an approval, a status read and a run are not experiences of an answer');
      await app.controller.handle('remember that the AK control note holds', { origin: 'user' });
      assert.equal(records(dir, 'experiences.jsonl').length, 1, 'the same verified write on its own is captured');
    } finally {
      cleanup(dir);
    }
  });
});
