// Implementation 056: the complete model workflow, with the model's own behaviour under
// control and every APEX component real.
//
// WHAT IS A STUB AND WHAT IS REAL, stated once because it decides what this suite can prove:
//   STUB  - the model. `startStubModel` is a local HTTP server that speaks the OpenAI-compatible
//           protocol APEX uses, and returns text chosen by the test. `makePlanGateway` returns
//           fixed plan JSON without any HTTP at all. Neither says anything about what a real
//           model would reply, how long it would take, or how often it would obey a format.
//           No inference was run here and no latency is claimed by this file.
//   REAL  - the CLI entry point and exit codes, configuration from the environment, the HTTP
//           gateway and its timeout/retry handling, the Cognitive Controller, the capability
//           router, proposal parsing, the action registry and its authorization decisions, the
//           task store and its lock, the task runner, the verifiers, the operation audit log,
//           the conversation store, the summary queue, and task recovery.
//
// So a green test below means: APEX behaves correctly for this model reply. It does not mean a
// real model produces that reply. The real-model status of this workspace is reported in the
// Batch D report; the model endpoint here is a test fixture on a loopback port.
//
// Two distinctions this suite established about APEX's own classification, since they decide
// which outcome each leg expects:
//  - a reply that is not a plan is a REJECTED PLAN (`plan_rejected`); a reply that never arrived,
//    or arrived empty, is a BACKEND FAILURE (`execution_failed`) - there was no plan to check. An
//    HTTP 200 whose message content is empty is classified by the gateway as EMPTY_RESPONSE.
//  - `task retry` records the decision to try a step again; it does not execute it. Only the next
//    run does, so a retry of a step that still fails ends as `execution_failed`, not as success.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createGateway, ModelGateway, NoBackend } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { TaskStatus, StepStatus } from '../src/tasks/model.js';
import { shortId } from '../src/util.js';
import {
  makeTempDataDir, cleanup, cleanEnv, runCli, startStubModel, closedPortUrl,
  makeFakeTaskActions, makePlanGateway, taskStep,
} from './helpers.js';

const dirs = [];
const stubs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

async function stubModel(reply = 'stub answer') {
  const s = await startStubModel();
  stubs.push(s);
  s.behavior.reply = reply;
  return s;
}

// The real CLI, configured from the environment, pointed at the stub endpoint on a fresh data
// directory. Every request the stub answered is in `model.requests`, which is how these tests
// show whether a leg consulted a model at all.
function cliEnv(model, dataDir, extra = {}) {
  return cleanEnv({
    APEX_DATA_DIR: dataDir,
    HOME: dataDir,
    USERPROFILE: dataDir,
    APEX_MODEL_URL: model.url,
    APEX_MODEL_PROVIDER: 'openai',
    APEX_MODEL_NAME: 'stub',
    APEX_MODEL_TIMEOUT_MS: '5000',
    APEX_MODEL_RETRIES: '0',
    ...extra,
  });
}

const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)) : []);
const opsIn = (dataDir) => readJsonl(path.join(dataDir, 'operations.jsonl'));
const stepOpsIn = (dataDir) => opsIn(dataDir).filter((r) => r.capability === 'task.step');
const turnsIn = (dataDir) => readJsonl(path.join(dataDir, 'conversation.jsonl'));
const taskEventsIn = (dataDir) => readJsonl(path.join(dataDir, 'tasks.jsonl'));

// A plan the deterministic router cannot make, so the model has to propose it.
const PLAN_GOAL = 'work out 123 times 456 and then show what the knowledge base holds';
const PLAN_REPLY = JSON.stringify({
  steps: [
    { id: 's1', description: 'multiply 123 by 456', action: 'calc.evaluate', input: { expression: '123*456' }, depends_on: [] },
    { id: 's2', description: 'list the knowledge base', action: 'knowledge.list', input: {}, depends_on: ['s1'] },
  ],
});

describe('056: one controlled reply, read and executed by the real CLI', () => {
  test('a proposal the model asks for is authorized, executed, verified, and audited as the action that ran', async () => {
    const model = await stubModel('PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"123*456"}}\nI suggest the product.');
    const dataDir = tempDir();
    const env = cliEnv(model, dataDir);

    const res = await runCli(['ask', 'what is 123 times 456?'], env);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /= 56088/, 'the result comes from the executed action, not from what the model said');
    assert.match(
      res.stdout,
      /calc\.evaluate \[origin model\]: authorization allow \(PERMITTED\); execution ok; verification success_verified/,
      'authorization, execution and verification are reported as three separate judgements',
    );
    assert.equal(model.requests.length, 1, 'one reply was asked for and one was used');

    const op = opsIn(dataDir).at(-1);
    assert.equal(op.capability, 'model.answer', 'the request went through the model path');
    assert.equal(op.decision, 'propose_action');
    assert.equal(op.steps.length, 1, 'exactly one action ran');
    assert.equal(op.steps[0].action, 'calc.evaluate', 'the audit names the action that ran, not the model that asked for it');
    assert.equal(op.steps[0].origin, 'model', 'and records that a model proposed it');
    assert.equal(op.steps[0].authorization.decision, 'allow');
    assert.equal(op.steps[0].execution.status, 'ok');
    assert.equal(op.steps[0].verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(op.status, Outcome.VERIFICATION_UNAVAILABLE, 'the model conclusion itself is never recorded as independently verified');

    const turns = turnsIn(dataDir);
    const modelTurn = turns.find((t) => t.origin === 'model');
    assert.equal(modelTurn.verified, false, 'the model prose is stored as unverified');
    assert.equal(turns.at(-1).origin, 'apex_action', 'the verified action result is stored as its own turn');
    assert.equal(turns.at(-1).verified, true);
    assert.match(turns.at(-1).text, /= 56088 \(verified\)/);
  });

  test('a proposal for an action the model may not run is denied, and its prose stays model text', async () => {
    // filesystem.list is registered user-origin only: a model cannot run it on its own say-so.
    const model = await stubModel('PROPOSE_ACTION {"action":"filesystem.list","input":{"path":"src"}}\nI have listed the directory for you.');
    const dataDir = tempDir();
    const env = cliEnv(model, dataDir);

    const res = await runCli(['ask', 'list src/'], env);
    assert.notEqual(res.code, 0, 'a denied proposal is not a success');
    assert.match(res.stdout, /action_denied|denied/);
    assert.equal(/listed|files?:/.test(res.stdout) || /src\b.*\.js/.test(res.stdout), false, 'nothing was read, so nothing is shown as read');

    const op = opsIn(dataDir).at(-1);
    assert.equal(op.status, Outcome.ACTION_DENIED);
    assert.equal(op.steps[0].authorization.decision, 'deny');
    assert.equal(op.steps[0].execution?.status ?? 'not_run', 'not_run', 'a denial is before execution, not after');
    const fsFiles = taskEventsIn(dataDir);
    assert.equal(fsFiles.length, 0, 'and no task or step was created by the denial');
  });

  test('a malformed proposal line is refused and recorded as a refusal, and nothing runs', async () => {
    const model = await stubModel('PROPOSE_ACTION {"action": calc.evaluate, "input": 123*456}\nThat is done, the answer is 56832.');
    const dataDir = tempDir();
    const env = cliEnv(model, dataDir);

    const res = await runCli(['ask', 'what is 123 times 456?'], env);
    assert.equal(res.code, 1, 'an unverified answer with a refused proposal is not a verified success');
    assert.match(res.stdout, /56832/, 'the model text is still shown - as model text');
    assert.equal(res.stdout.includes('56088'), false, 'the real product never appears, because no action ran');
    assert.match(res.stdout, /malformed proposal rejected: proposal is not valid JSON/);
    assert.match(res.stdout, /model answer; APEX cannot independently verify/);

    const ops = opsIn(dataDir);
    assert.equal(ops.length, 1, 'the refusal adds an operation record of its own and runs nothing');
    const op = ops.at(-1);
    assert.equal(op.capability, 'model.answer');
    assert.equal(op.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(op.steps.length, 1, 'the refusal is recorded as a step that did not run');
    assert.equal(op.steps[0].action, null, 'a malformed proposal never reaches an action name');
    assert.equal(op.steps[0].authorization, null, 'so it is never even authorized');
    assert.equal(op.steps[0].execution.status, 'not_run');
    assert.equal(op.steps[0].outcome, Outcome.INPUT_REJECTED);
    assert.match(op.steps[0].summary, /not valid JSON/, 'and says what was wrong');
    assert.equal(op.steps[0].summary.includes('123*456'), false, 'the refused payload is not carried into the audit');

    const turns = turnsIn(dataDir);
    const modelTurn = turns.find((t) => t.origin === 'model');
    assert.match(modelTurn.text, /56832/, 'history keeps the reply as model text');
    assert.equal(modelTurn.verified, false);
    assert.doesNotMatch(modelTurn.text, /PROPOSE_ACTION/, 'the rejected protocol line is not replayed as an answer');
    assert.match(turns.at(-1).text, /malformed proposal rejected/, 'and the refusal itself is replayable from history');
  });

  test('a plan the router cannot build is proposed by the model, approved by the user, run, and verified', async () => {
    const model = await stubModel(PLAN_REPLY);
    const dataDir = tempDir();
    const env = cliEnv(model, dataDir);

    const planned = await runCli(['task', 'plan', PLAN_GOAL], env);
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    assert.match(planned.stdout, /status: proposed/);
    assert.match(planned.stdout, /planner: model/);
    assert.match(planned.stdout, /Nothing has run yet/);
    const short = /Task ([0-9a-f]{8})/.exec(planned.stdout)[1];
    assert.equal(stepOpsIn(dataDir).length, 0, 'a proposal runs nothing');
    assert.equal(taskEventsIn(dataDir).filter((e) => e.type === 'transition').length, 0, 'and changes no step state');

    // The user approves the plan; a write step would still need its own approval.
    const approved = await runCli(['task', 'approve', short], env);
    assert.equal(approved.code, 0, approved.stdout + approved.stderr);
    assert.match(approved.stdout, /status: pending/);

    const ran = await runCli(['task', 'run', short], env);
    assert.equal(ran.code, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /status: completed/);
    assert.match(ran.stdout, /= 56088 \(verified\)/);

    assert.equal(stepOpsIn(dataDir).length, 2, 'each executed step has its own audit record');
    assert.deepEqual(stepOpsIn(dataDir).map((r) => r.task.stepId), ['s1', 's2']);
    assert.deepEqual(stepOpsIn(dataDir).map((r) => r.origin), ['model', 'model'], 'both were reads, so both ran as the model');
    const summary = turnsIn(dataDir).filter((t) => t.origin === 'apex_task');
    assert.equal(summary.length, 1);
    assert.match(summary[0].text, /TASK RESULT \(from the task log and audit, not model text\)/);
    assert.match(summary[0].text, /2 of 2 step\(s\) verified complete/);

    // Explaining it needs neither the model nor a run.
    const requestsBefore = model.requests.length;
    const explained = await runCli(['task', 'explain', short, 'finished'], env);
    assert.equal(explained.code, 0, explained.stdout + explained.stderr);
    assert.match(explained.stdout, /Yes, it finished: all 2 step\(s\) ran and each one was verified\./);
    assert.match(explained.stdout, /Evidence: all 2 step result\(s\) the task log records as verified have an operation record of their own\./);
    assert.equal(model.requests.length, requestsBefore, 'the explanation asked the model nothing');

    // A follow-up in the conversation is answered from the records, even while the stub has a
    // confident contradiction loaded. Model prose is not evidence; the task log is.
    model.behavior.reply = 'That task failed completely and none of its steps were verified.';
    const asked = await runCli(['ask', `task ${short} finished?`], env);
    assert.equal(asked.code, 0, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /Yes, it finished: all 2 step\(s\) ran and each one was verified/);
    assert.equal(/failed/i.test(asked.stdout), false, 'the model claim is not repeated');
    assert.equal(model.requests.length, requestsBefore, 'and it was answered without asking the model');

    // Re-running a completed task repeats nothing.
    const again = await runCli(['task', 'run', short], env);
    assert.equal(again.code, 1);
    assert.equal(stepOpsIn(dataDir).length, 2, 'no third step record: nothing ran again');
  });

  test('a model claim of work it did not do stays a claim: no action, no record, nothing marked verified', async () => {
    // The reply asserts completed work in prose only. There is no PROPOSE_ACTION line, so
    // there is nothing to authorize and nothing to run. This is the boundary between a
    // model-generated claim and a verified system outcome.
    const model = await stubModel('Done. I evaluated 123*456, saved the result to memory, and listed your files.');
    const dataDir = tempDir();
    const env = cliEnv(model, dataDir);

    const res = await runCli(['ask', 'what is 123 times 456?'], env);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /model answer; APEX cannot independently verify/);
    assert.equal(res.stdout.includes('56088'), false, 'the number the model claims was computed never appears as a result');

    const op = opsIn(dataDir).at(-1);
    assert.equal(op.capability, 'model.answer');
    assert.equal(op.steps.length, 0, 'the claim proposed nothing, so no action was authorized or run');
    assert.equal(op.decision, 'answer', 'the reply is treated as an answer, not as work');

    const turns = turnsIn(dataDir);
    const claim = turns.at(-1);
    assert.equal(claim.origin, 'model');
    assert.equal(claim.verified, false, 'history records the claim as unverified model text');
    assert.equal(opsIn(dataDir).some((r) => String(r.capability).startsWith('memory') || String(r.capability).startsWith('filesystem')), false,
      'neither the claimed memory write nor the claimed file listing happened');
    const memoryFile = path.join(dataDir, 'memory.jsonl');
    assert.equal(fs.existsSync(memoryFile) ? readJsonl(memoryFile).length : 0, 0, 'nothing was stored in memory');
  });

  test('the model being unreachable, unparseable, empty, or slow leaves no plan and no claim', async () => {
    // An unreachable endpoint and an empty answer are backend failures, not rejected plans:
    // APEX never got a plan to check. A reply that is not a plan is refused by the parser.
    // Each case must store no task, run no step, and say so plainly.
    const dead = await closedPortUrl();
    const unreachable = await runCli(['task', 'plan', PLAN_GOAL], cliEnv({ url: dead }, tempDir()));
    assert.equal(unreachable.code, 1);
    assert.match(unreachable.stdout, /The model did not return a plan \(UNREACHABLE: could not reach the endpoint/);
    assert.match(unreachable.stdout, /No task was created\./);

    const cases = [
      ['not a plan at all, sorry', Outcome.PLAN_REJECTED, /the model reply is not valid JSON/],
      // HTTP 200 with an empty message is classified by the gateway as an empty answer.
      ['', Outcome.EXECUTION_FAILED, /EMPTY_RESPONSE: endpoint returned an empty answer/],
      ['{"steps":"many","extra":1}', Outcome.PLAN_REJECTED, /unexpected field "extra"/],
    ];
    for (const [reply, status, expected] of cases) {
      const model = await stubModel(reply);
      const dataDir = tempDir();
      const res = await runCli(['task', 'plan', PLAN_GOAL], cliEnv(model, dataDir));
      assert.equal(res.code, 1, `${JSON.stringify(reply)}: ${res.stdout}${res.stderr}`);
      assert.match(res.stdout, expected);
      assert.equal(taskEventsIn(dataDir).length, 0, `${JSON.stringify(reply)} stored no task`);
      assert.equal(stepOpsIn(dataDir).length, 0, `${JSON.stringify(reply)} ran no step`);
      assert.equal(turnsIn(dataDir).length, 0, `${JSON.stringify(reply)} added nothing to the conversation`);
      assert.equal(opsIn(dataDir).at(-1).status, status, `${JSON.stringify(reply)} is reported as ${status}`);
    }

    // A reply that arrives after the deadline is a timeout, and it is not retried into a
    // second plan attempt. The short deadline is the configuration under test, not a model.
    const slow = await stubModel(PLAN_REPLY);
    slow.behavior.delayMs = 700;
    const dataDir = tempDir();
    const timedOut = await runCli(['task', 'plan', PLAN_GOAL], cliEnv(slow, dataDir, { APEX_MODEL_TIMEOUT_MS: '200' }));
    assert.equal(timedOut.code, 1, timedOut.stdout + timedOut.stderr);
    assert.match(timedOut.stdout, /TIMEOUT: no response within 200 ms/);
    assert.equal(taskEventsIn(dataDir).length, 0, 'a timed-out plan call stores nothing');
    assert.equal(slow.requests.length, 1, 'retries=0 means one request, not a retry storm');
  });
});

describe('056: the same workflow with a write step, against the real execution path', () => {
  // TEST DOUBLES: `test.*` actions and the fixed plan JSON. Everything else - the registry,
  // the authorization decision, the approval binding to the step input, the runner, the
  // verifiers, the lock, the stores, and recovery - is the implementation under test.
  function appWith(gateway, sink, dataDir = tempDir()) {
    return { dataDir, app: createApp({ dataDir, gateway, extraActions: makeFakeTaskActions(sink) }) };
  }

  test('a model-proposed write waits, is approved by the user for that input, runs, and verifies', async () => {
    const sink = [];
    const { app, dataDir } = appWith(makePlanGateway([taskStep('s1', 'test.ok'), taskStep('s2', 'test.write', ['s1'], { tag: 'the note to keep' })]), sink);

    const planned = await app.controller.planTask('check the reading and keep a note about it');
    assert.equal(planned.status, Outcome.PLAN_PROPOSED);
    const task = (await app.taskStore.list()).at(-1);
    assert.equal(task.origin, 'model');

    await app.controller.approveTask(task.id);
    const first = await app.controller.runTask(task.id, 'run');
    assert.equal(first.status, Outcome.TASK_PAUSED, 'the write stops the run and waits');
    assert.deepEqual(sink, ['s1'], 'the read ran; the write did not');
    const held = (await app.taskStore.get(task.id)).steps.find((s) => s.id === 's2');
    assert.equal(held.status, StepStatus.AWAITING_APPROVAL);
    assert.equal(held.approval, null, 'waiting is not approval');

    const approved = await app.controller.approveTask(task.id, { stepId: 's2' });
    assert.equal(approved.status, Outcome.SUCCESS_VERIFIED);
    const afterApproval = (await app.taskStore.get(task.id)).steps.find((s) => s.id === 's2');
    assert.ok(afterApproval.approval, 'the approval is recorded on the step');
    assert.equal(afterApproval.approval.approvedBy, 'user');

    const done = await app.controller.runTask(task.id, 'resume');
    assert.equal(done.status, Outcome.SUCCESS_VERIFIED, done.display);
    assert.deepEqual(sink, ['s1', 'write:the note to keep'], 'and only now does the write run');
    const ran = (await app.taskStore.get(task.id)).steps.find((s) => s.id === 's2');
    assert.equal(ran.status, StepStatus.COMPLETED);
    assert.equal(ran.outcome, Outcome.SUCCESS_VERIFIED);

    const stepOps = stepOpsIn(dataDir);
    assert.deepEqual(stepOps.map((r) => r.task.stepId), ['s1', 's2'], 'each executed step has its own record');
    assert.deepEqual(stepOps.map((r) => r.origin), ['model', 'user'], 'the write ran as the user, because the user approved it');

    // Nothing about the write is recorded before the approval that authorises it.
    const stepApproval = taskEventsIn(dataDir).filter((e) => e.approval?.stepId === 's2');
    assert.equal(stepApproval.length, 1, 'the step approval is recorded once in the task log');
    assert.match(String(stepApproval[0].approval.inputSha256), /^[0-9a-f]{64}$/, 'the approval is bound to the exact step input, not to the step name');
    assert.equal(
      turnsIn(dataDir).filter((t) => t.origin === 'apex_task').length,
      2,
      'the pause and the completion are both reported to the conversation from the task log',
    );
  });

  test('a failed step, an interrupted approved write, and a restart: the verified step never runs twice', async () => {
    const sinkA = [];
    const first = appWith(makePlanGateway([taskStep('s1', 'test.ok', [], { tag: 'once' }), taskStep('s2', 'test.fail', ['s1'])]), sinkA);
    const planned = await first.app.controller.planTask('take the reading and then the second one');
    assert.equal(planned.status, Outcome.PLAN_PROPOSED);
    const task = (await first.app.taskStore.list()).at(-1);
    await first.app.controller.approveTask(task.id);
    const ran = await first.app.controller.runTask(task.id, 'run');
    assert.equal(ran.status, Outcome.EXECUTION_FAILED, 'the failing step decides the task result');
    assert.equal((await first.app.taskStore.get(task.id)).status, TaskStatus.FAILED);
    assert.deepEqual(sinkA, ['once'], 'the read ran once; the failing step ran and threw');

    // A resume of a failed task is refused, not silently re-run.
    const resumed = await first.app.controller.runTask(task.id, 'resume');
    assert.equal(resumed.status, Outcome.INPUT_REJECTED, 'a failed task needs a step retry or a cancel');
    assert.deepEqual(sinkA, ['once'], 'and the resume attempt ran nothing');

    // `task retry` only records the decision to try again; it does not execute the step.
    const marked = await first.app.controller.retryTask(task.id, 's2');
    assert.equal(marked.status, Outcome.SUCCESS_VERIFIED, 's2 is read-only, so the user may set it for retry');
    assert.match(marked.display, /Retry set for step s2/);
    assert.deepEqual(sinkA, ['once'], 'setting a retry runs nothing by itself');
    const rerun = await first.app.controller.runTask(task.id, 'resume');
    assert.equal(rerun.status, Outcome.EXECUTION_FAILED, 'the re-run fails again: the step still does not answer');
    assert.equal((await first.app.taskStore.get(task.id)).steps.find((s) => s.id === 's2').status, StepStatus.FAILED);
    assert.deepEqual(sinkA, ['once'], 'a step that fails again is not recorded as having succeeded');

    // The interruption leg, in a second data directory with its own sink. An approved write is
    // put into exactly the state a lost process leaves behind: the task recorded as running and
    // its approved step recorded as running against an operation id the audit log has no record
    // for. Each transition appended here is one the state machine allows (055 reaches the same
    // state by terminating a real child process; this leg checks the recovery decision itself).
    const sinkB = [];
    const other = appWith(makePlanGateway([taskStep('s1', 'test.ok', [], { tag: 'keep-once' }), taskStep('s2', 'test.write', ['s1'], { tag: 'the interrupted write' })]), sinkB);
    const plan2 = await other.app.controller.planTask('read once and write once');
    assert.equal(plan2.status, Outcome.PLAN_PROPOSED);
    const task2 = (await other.app.taskStore.list()).at(-1);
    await other.app.controller.approveTask(task2.id);
    const paused = await other.app.controller.runTask(task2.id, 'run');
    assert.equal(paused.status, Outcome.TASK_PAUSED);
    const approved = await other.app.controller.approveTask(task2.id, { stepId: 's2' });
    assert.equal(approved.status, Outcome.SUCCESS_VERIFIED);
    assert.deepEqual(sinkB, ['keep-once'], 'approval records the decision; it runs nothing');
    assert.equal((await other.app.taskStore.get(task2.id)).steps.find((s) => s.id === 's2').status, StepStatus.PENDING, 'the approved step waits at pending');

    await other.app.taskStore.transition(task2.id, {
      reason: 'running s2',
      task: { from: TaskStatus.PAUSED, to: TaskStatus.RUNNING },
      steps: [{ id: 's2', from: StepStatus.PENDING, to: StepStatus.RUNNING, operationId: 'f'.repeat(64) }],
    });
    const interrupted = await other.app.taskStore.get(task2.id);
    assert.equal(interrupted.status, TaskStatus.RUNNING);
    assert.equal(interrupted.steps.find((s) => s.id === 's2').status, StepStatus.RUNNING);
    assert.equal(stepOpsIn(other.dataDir).filter((r) => r.task.stepId === 's2').length, 0, 'the step is running with no audit record of its own');

    // A second app on the same directory knows nothing except these files.
    const fresh = createApp({ dataDir: other.dataDir, gateway: new ModelGateway({ backend: new NoBackend() }), extraActions: makeFakeTaskActions(sinkB) });
    const recovered = await fresh.controller.runTask(task2.id, 'resume');
    assert.equal(recovered.status, Outcome.INPUT_REJECTED, recovered.display);
    assert.match(recovered.display, /step s2 is uncertain and was not run again/);
    const after = await fresh.taskStore.get(task2.id);
    assert.equal(after.status, TaskStatus.PAUSED, 'the task is stopped, not left claiming to run');
    assert.equal(after.steps.find((s) => s.id === 's2').status, StepStatus.UNCERTAIN, 'an interrupted write is resolved as unknown, not as done');
    assert.equal(after.steps.find((s) => s.id === 's2').outcome, null, 'and no outcome is invented for it');
    assert.deepEqual(sinkB, ['keep-once'], 'the recovery re-ran neither step');

    const retry = await fresh.controller.retryTask(task2.id, 's2');
    assert.equal(retry.status, Outcome.INPUT_REJECTED, 'a write whose outcome is unknown is never retried');
    assert.match(retry.display, /changes data, so it is never retried/);
    assert.deepEqual(sinkB, ['keep-once'], 'and the refusal ran nothing');

    // The follow-up is answered from these records, with no model configured at all.
    const asked = await fresh.controller.handle(`what happened to task ${shortId(task2.id)}?`);
    assert.equal(asked.operation.capability, 'task.explain', 'the question is answered by reading the records');
    assert.match(asked.display, /status: paused; 1 of 2 step\(s\) verified complete; 1 unresolved/);
    assert.match(asked.display, /\[uncertain\] s2 \(test\.write\) - outcome: not recorded/, 'the uncertain write is named as unresolved');
    assert.equal(/2 of 2|it finished/.test(asked.display), false, 'and the task is not called finished');
    assert.deepEqual(sinkB, ['keep-once'], 'asking about it ran nothing');

    // The verified step is still backed by exactly one audit record after all of this.
    const s1Records = stepOpsIn(other.dataDir).filter((r) => r.task.stepId === 's1');
    assert.equal(s1Records.length, 1, 'the verified read was executed once and recorded once');
    assert.equal(fresh.taskStore.lockPath && fs.existsSync(fresh.taskStore.lockPath), false, 'recovery released the lock it took over');
  });
});
