// Batch AO, work package F: executive handoff integrity and the authority boundary.
//
// A handoff record is the one bounded statement of a crossing from cognitive or executive intent
// into execution. It authorizes nothing: the action registry, the plan approval, and the user's
// task approval remain the only authorities, and every outcome in the record is read from the
// operation and task records that executed or verified it. This file drives the real controller,
// task runner, plan store, and operation log, with fixed-output stubs and test doubles only.
//
// No model is contacted, no inference is run, and every data directory is a fresh temp directory.
// A test double's report is labelled as a double wherever it is asserted on.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { StoreError } from '../src/errors.js';
import { TaskStatus, StepStatus } from '../src/tasks/model.js';
import { planContentHash } from '../src/plans/model.js';
import {
  HANDOFF_SCHEMA,
  HandoffKind,
  HandoffState,
  buildModelProposalHandoff,
  completeModelProposalHandoff,
  buildPlanActivationHandoff,
  buildTaskRunHandoff,
  completeTaskHandoff,
  proposalBindingHash,
  taskBindingHash,
  validateHandoff,
  validateHandoffReferences,
} from '../src/executive/handoff.js';
import { makeTempDataDir, cleanup, makeFakeTaskActions, makePlanGateway, taskStep } from './helpers.js';

const CLOCK = () => new Date('2026-11-11T09:00:00.000Z');
const dirs = [];
afterEach(() => {
  while (dirs.length) {
    try { cleanup(dirs.pop()); } catch { /* already removed */ }
  }
});

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function appIn(dir, extra = {}) {
  return createApp({ dataDir: dir, now: CLOCK, experienceCapture: CAPTURE_OFF, ...extra });
}

// TEST DOUBLE: fixed text, no model. A function is evaluated per request so a test can cite a
// record it created moments earlier.
function stubGateway(text) {
  return new ModelGateway({
    backend: {
      name: 'stub-reply',
      provider: 'stub-reply',
      configured: true,
      describe: () => ({ configured: true, provider: 'stub-reply', endpoint: 'stub-reply', model: 'stub-reply' }),
      health: async () => ({ available: true, detail: 'stub reply' }),
      complete: async () => ({
        ok: true, backend: 'stub-reply', provider: 'stub-reply', model: 'stub-reply',
        text: typeof text === 'function' ? text() : text,
        finishReason: 'stop', truncated: false, latencyMs: 0,
      }),
    },
  });
}

function records(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

const operations = (dir) => records(dir, 'operations.jsonl');
const taskStepOperations = (dir, taskId = null) => operations(dir)
  .filter((op) => op.capability === 'task.step' && (taskId === null || op.task?.id === taskId));

// A crossing is carried by the operation itself (a plan activation or task run) or by the step that
// executed a model proposal, so both places are counted.
const handoffCount = (dir) => operations(dir)
  .reduce((n, op) => n + (op.handoff ? 1 : 0) + (op.steps ?? []).filter((step) => step.handoff).length, 0);

function planStep(id, action, input = { tag: id }, dependsOn = []) {
  return {
    id,
    description: `step ${id}`,
    action,
    input,
    dependsOn,
    expectedResult: 'the fixture reports what it did',
    verification: 'the fixture verifies its own report',
    risk: 'medium',
  };
}

async function addPlan(app, steps, outcome = 'the AO-07 fixture plan runs') {
  const res = await app.controller.planAdd({ outcome, reason: 'AO-07 fixture', steps });
  assert.equal(res.status, Outcome.PLAN_STORED, res.display);
  return res.operation.steps[0].result.data.planId;
}

async function approvePlan(app, planId) {
  const res = await app.controller.planApprove({ target: planId });
  assert.equal(res.status, Outcome.PLAN_STORED, res.display);
  return res;
}

// A valid record carried by the request's own operation, with the live operations that justify it.
function boundRecords(dir, res) {
  const stored = operations(dir).find((op) => op.id === res.operation.id);
  assert.ok(stored, 'the operation was written to the audit log');
  return { stored, stepOps: taskStepOperations(dir) };
}

const HANdOFF_KEYS = [
  'schema', 'kind', 'authorizes', 'state', 'requestId', 'source', 'evidence',
  'authorization', 'execution', 'verification', 'finalization',
];

describe('AO-07 A: the handoff record is bounded, text-free, and names only live records', () => {
  test('A1 a model-proposed read crosses once with a verified handoff that the live operation confirms', async () => {
    const dir = tempDir();
    let recordId = null;
    const app = appIn(dir, {
      gateway: stubGateway(() => [
        'The probe fact is grounded.',
        `COGNITION ${JSON.stringify({
          schema: 1,
          decision: 'answer',
          answer: 'The probe fact is grounded.',
          claims: [{ text: 'the handoff probe fact is grounded', evidence: [`ev:memory:${recordId}`], kind: 'supported' }],
          uncertainty: 'supported_but_incomplete',
          disclosures: [],
          missing: [],
        })}`,
        'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"6*7"}}',
      ].join('\n')),
    });
    recordId = (await app.memory.add({
      content: 'the handoff probe fact is grounded', kind: 'user_fact', source: 'user',
    })).id;

    const res = await app.controller.handle('tell me about the handoff probe fact', { origin: 'user' });
    assert.equal(res.operation.steps.length, 1);
    const [step] = res.operation.steps;
    const handoff = step.handoff;
    assert.ok(handoff, 'the executed proposal carries a handoff record');

    assert.equal(handoff.schema, HANDOFF_SCHEMA);
    assert.equal(handoff.kind, HandoffKind.MODEL_PROPOSAL);
    assert.equal(handoff.authorizes, false, 'a handoff record authorizes nothing');
    assert.equal(handoff.source, 'model');
    assert.equal(handoff.requestId, res.operation.id);
    assert.equal(handoff.state, HandoffState.VERIFIED);
    assert.equal(handoff.proposal.id, 'mp:1');
    assert.equal(handoff.proposal.version, 1);
    assert.equal(handoff.proposal.origin, 'model');
    assert.equal(handoff.proposal.trusted, false);
    assert.equal(handoff.proposal.authority, 'none');
    assert.equal(handoff.proposal.contentHash, proposalBindingHash(step.action, step.input),
      'the record names the exact content the registry was asked about');
    assert.deepEqual(handoff.authorization, {
      owner: 'action_registry', decision: 'allow', reason: 'PERMITTED',
      basis: 'registry_decision', perStep: 'this_step',
    });
    assert.deepEqual(handoff.execution, { operationId: res.operation.id, step: 0, status: 'ok' });
    assert.equal(handoff.verification.basis, 'independent_verifier');
    assert.equal(handoff.verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.deepEqual({
      checked: handoff.verification.checked,
      verified: handoff.verification.verified,
      failed: handoff.verification.failed,
      unavailable: handoff.verification.unavailable,
    }, { checked: 1, verified: 1, failed: 0, unavailable: 0 });
    assert.ok(handoff.evidence.refs.includes(`ev:memory:${recordId}`),
      'the request\'s bounded cognitive evidence is named without its text');
    assert.equal(handoff.finalization.recorded, null, 'whether the operation was recorded belongs to the operation log');
    assert.deepEqual(Object.keys(handoff).sort(),
      [...HANdOFF_KEYS, 'proposal', 'step', 'approval'].sort());

    assert.equal(validateHandoff(handoff, { phase: 'recorded' }).ok, true);
    const { stored } = boundRecords(dir, res);
    assert.deepEqual(stored.steps[0].handoff, handoff, 'the persisted record is the returned one');
    const checked = validateHandoffReferences(handoff, { operation: stored });
    assert.equal(checked.ok, true, checked.problems.join('; '));
    assert.equal(checked.authorizes, false);
  });

  test('A2 a model-proposed write is denied, records the denial, and writes nothing', async () => {
    const dir = tempDir();
    const app = appIn(dir, {
      gateway: stubGateway('PROPOSE_ACTION {"action":"memory.add","input":{"content":"the model wrote this"}}'),
    });
    const res = await app.controller.handle('do the whole thing for me', { origin: 'user' });
    assert.equal(res.operation.steps.length, 1);
    const [step] = res.operation.steps;
    assert.equal(step.action, 'memory.add');
    assert.equal(step.origin, 'model');
    // memory.add is registered for the user origin only, so the denial comes from the origin rule.
    assert.deepEqual(step.authorization, { decision: 'deny', reason: 'ORIGIN_NOT_PERMITTED' });
    assert.equal(step.execution.status, 'not_run');

    const handoff = step.handoff;
    assert.ok(handoff);
    assert.equal(handoff.state, HandoffState.DENIED);
    assert.equal(handoff.authorization.decision, 'deny');
    assert.equal(handoff.authorization.reason, 'ORIGIN_NOT_PERMITTED');
    assert.equal(handoff.execution, null, 'a denied crossing names no execution');
    assert.equal(handoff.verification, null);
    // The record still names the request's own bounded cognitive evidence; a denial does not make
    // the request it answered disappear.
    assert.ok(handoff.evidence.refs.every((ref) => ref.startsWith('ev:')));
    assert.equal(handoff.evidence.total, handoff.evidence.refs.length);
    assert.equal(records(dir, 'memory.jsonl').length, 0, 'the write never happened');
    assert.equal(validateHandoff(handoff, { phase: 'recorded' }).ok, true);
    const { stored } = boundRecords(dir, res);
    const checked = validateHandoffReferences(handoff, { operation: stored });
    assert.equal(checked.ok, true, checked.problems.join('; '));
    assert.equal(JSON.stringify(handoff).includes('the model wrote this'), false,
      'the action input is not copied into the handoff');
  });

  test('A3 a handoff cannot be made to authorize, approve, or finalize itself', async () => {
    const dir = tempDir();
    const app = appIn(dir, {
      gateway: stubGateway('PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"2+2"}}'),
    });
    const res = await app.controller.handle('tell me about arithmetic', { origin: 'user' });
    const handoff = res.operation.steps[0].handoff;
    assert.ok(handoff);

    const forgeries = {
      'self-authorized': { ...handoff, authorizes: true },
      'self-approved': {
        ...handoff,
        approval: { scope: 'task_creation', at: '2026-11-11T09:00:00.000Z', version: null, contentHash: 'a'.repeat(64) },
      },
      'denied with execution': { ...handoff, state: HandoffState.DENIED },
      'verified without its outcome': {
        ...handoff,
        verification: { ...handoff.verification, verified: 0, failed: 1, unavailable: 0 },
      },
      'prepared but complete': { ...handoff, state: HandoffState.PREPARED },
      'finalized by itself': { ...handoff, finalization: { recorded: true } },
      'unbounded evidence': {
        ...handoff,
        evidence: { refs: ['ev:memory:one', 'ev:memory:one'], total: 2 },
      },
    };
    for (const [label, record] of Object.entries(forgeries)) {
      const check = validateHandoff(record, { phase: 'recorded' });
      assert.equal(check.ok, false, `${label} was accepted`);
      assert.equal(check.authorizes, false, `${label} gained authority`);
    }

    // A record that says a model-origin write was allowed is not merely invalid; its claim is
    // contradicted by the step's own registry decision.
    const allowedWrite = {
      ...buildModelProposalHandoff({ requestId: res.operation.id, proposal: { proposalId: 'mp:1', action: 'memory.add', input: { content: 'x' } }, stepIndex: 0 }),
      authorization: { owner: 'action_registry', decision: 'allow', reason: 'PERMITTED', basis: 'registry_decision', perStep: 'this_step' },
      state: HandoffState.NOT_RUN,
    };
    const { stored } = boundRecords(dir, res);
    const checked = validateHandoffReferences(allowedWrite, { operation: stored });
    assert.equal(checked.ok, false, 'a forged allow was confirmed by the live operation');
    assert.match(checked.problems.join(' '), /authorization|proposal/);
  });

  test('A4 a plan approval cannot be manufactured or borrowed from another plan', async () => {
    const dir = tempDir();
    const app = appIn(dir);
    const approvedId = await addPlan(app, [planStep('s1', 'memory.add', { content: 'AO-07 approved plan' })]);
    await approvePlan(app, approvedId);
    const draftId = await addPlan(app, [planStep('s1', 'memory.add', { content: 'AO-07 draft plan' })]);
    const approved = await app.plans.get(approvedId);
    const draft = await app.plans.get(draftId);
    const task = { id: 't-forged', planId: draft.id, origin: 'user', steps: draft.steps, status: TaskStatus.PENDING };

    // A structurally perfect record naming the draft bytes and a fabricated approval.
    const forged = {
      ...buildPlanActivationHandoff({ requestId: 'op-forged-approval', plan: draft, goal: null, task }),
      approval: { scope: 'plan_approval', at: approved.approval.at, version: draft.version, contentHash: planContentHash(draft) },
      authorization: { owner: 'plan_approval', decision: 'allow', reason: null, basis: 'approval_bound_to_live_plan', perStep: 'registry_decided_at_run' },
      state: HandoffState.NOT_RUN,
    };
    assert.equal(validateHandoff(forged, { phase: 'recorded' }).ok, true,
      'structure alone cannot tell a fabricated approval from a recorded one');
    const againstDraft = validateHandoffReferences(forged, { plan: draft, task, stepOperations: [] });
    assert.equal(againstDraft.ok, false);
    assert.match(againstDraft.problems.join(' '), /no recorded approval/);

    // The approved plan's own approval is not transferable to the draft's bytes either.
    const borrowed = {
      ...forged,
      plan: { id: draft.id, version: draft.version, contentHash: planContentHash(draft) },
      approval: { ...approved.approval, scope: 'plan_approval', version: approved.version, contentHash: approved.approval.contentHash },
    };
    assert.equal(validateHandoff(borrowed, { phase: 'recorded' }).ok, false,
      'another plan\'s approval was accepted for different content');
    const againstBorrowed = validateHandoffReferences(borrowed, { plan: draft, task, stepOperations: [] });
    assert.equal(againstBorrowed.ok, false);
  });

  test('A5 an approval cannot survive a revision of the plan it approved', async () => {
    const dir = tempDir();
    const app = appIn(dir, { extraActions: makeFakeTaskActions([]) });
    const planId = await addPlan(app, [planStep('s1', 'test.fail', {})]);
    await approvePlan(app, planId);
    // An approved plan cannot be revised at all: the store refuses before the handoff layer is
    // reached. A blocked plan can be, and the revision is what clears the approval.
    const blockedRun = await app.controller.planActivate(planId);
    assert.equal(blockedRun.status, Outcome.EXECUTION_FAILED, blockedRun.output);
    const approved = await app.plans.get(planId);
    assert.equal(approved.status, 'blocked');
    assert.ok(approved.approval, 'the blocked plan still carries the approval it ran under');

    const task = await app.taskStore.get(approved.activation.taskId);
    const handoff = completeTaskHandoff(
      buildPlanActivationHandoff({ requestId: 'op-old-approval', plan: approved, goal: null, task }),
      { task },
    );
    assert.equal(handoff.state, HandoffState.FAILED);
    const before = validateHandoffReferences(handoff, {
      plan: approved, task, stepOperations: taskStepOperations(dir, task.id),
    });
    assert.equal(before.ok, true, before.problems.join('; '));

    const revised = await app.controller.planRevise({
      target: planId,
      outcome: 'the AO-07 revision fact two',
      steps: [planStep('s1', 'test.fail', {})],
      reason: 'the fact changed',
    });
    assert.equal(revised.status, Outcome.PLAN_STORED, revised.display);
    const live = await app.plans.get(planId);
    assert.equal(live.version, approved.version + 1);
    assert.equal(live.approval, null, 'a revision cleared the approval it invalidated');

    const after = validateHandoffReferences(handoff, { plan: live, task, stepOperations: [] });
    assert.equal(after.ok, false, 'the old handoff still validated against the revised plan');
    assert.match(after.problems.join(' '), /version|hash|approval/);

    const rebuilt = buildPlanActivationHandoff({ requestId: 'op-new-approval', plan: live, goal: null, task });
    assert.equal(rebuilt.authorization.decision, 'deny');
    assert.equal(rebuilt.authorization.reason, 'APPROVAL_NOT_BOUND_TO_PLAN');
  });

  test('A6 verification cannot be claimed without the step operation records that establish it', async () => {
    const dir = tempDir();
    const app = appIn(dir, { extraActions: makeFakeTaskActions([]) });
    const planId = await addPlan(app, [
      planStep('s1', 'test.ok', { tag: 'a' }),
      planStep('s2', 'test.ok', { tag: 'b' }, ['s1']),
    ]);
    await approvePlan(app, planId);
    const run = await app.controller.planActivate(planId);
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.output);
    const task = await app.taskStore.get(run.task.id);
    const stepOps = taskStepOperations(dir, task.id);
    assert.equal(stepOps.length, 2);
    const handoff = run.operation.handoff;
    assert.equal(handoff.state, HandoffState.VERIFIED);

    // Missing audit records: the handoff claims two verified steps it cannot evidence.
    const missing = validateHandoffReferences(handoff, { plan: await app.plans.get(planId), task, stepOperations: [] });
    assert.equal(missing.ok, false);
    assert.match(missing.problems.join(' '), /not in the audit log/);

    // Reusing another step's completed operation id: the live task and the audit record disagree.
    const reused = {
      ...handoff,
      execution: {
        ...handoff.execution,
        steps: handoff.execution.steps.map((step, i) => (i === 0
          ? { ...step, operationId: handoff.execution.steps[1].operationId }
          : step)),
      },
    };
    assert.equal(validateHandoff(reused, { phase: 'recorded' }).ok, true, 'the id shape alone is not enough');
    const reusedCheck = validateHandoffReferences(reused, { plan: await app.plans.get(planId), task, stepOperations: stepOps });
    assert.equal(reusedCheck.ok, false, 'a reused completed operation id was accepted');
    assert.match(reusedCheck.problems.join(' '), /operation|step/);

    // Dropping a step from the list while still claiming every step verified is structurally invalid.
    const dropped = { ...handoff, execution: { ...handoff.execution, steps: handoff.execution.steps.slice(0, 1) } };
    const droppedCheck = validateHandoff(dropped, { phase: 'recorded' });
    assert.equal(droppedCheck.ok, false);
    assert.match(droppedCheck.problems.join(' '), /list every step|step total/);

    // Forged counts are contradicted by the live task records.
    const forgedCounts = {
      ...handoff,
      verification: { ...handoff.verification, checked: 1, verified: 1, failed: 0, unavailable: 0 },
    };
    const forgedCheck = validateHandoffReferences(forgedCounts, { plan: await app.plans.get(planId), task, stepOperations: stepOps });
    assert.equal(forgedCheck.ok, false);
    assert.match(forgedCheck.problems.join(' '), /counts differ/);
  });

  test('A7 evidence is bounded and the record carries no request or action text', async () => {
    const dir = tempDir();
    const app = appIn(dir, {
      gateway: stubGateway('PROPOSE_ACTION {"action":"memory.add","input":{"content":"AO07-PAYLOAD-MARKER-4f1c"}}'),
    });
    const res = await app.controller.handle('AO07-REQUEST-MARKER-9b2e please store it', { origin: 'user' });
    const handoff = res.operation.steps[0].handoff;
    assert.ok(handoff);
    const serialized = JSON.stringify(handoff);
    assert.equal(serialized.includes('AO07-PAYLOAD-MARKER-4f1c'), false, 'the action input reached the handoff');
    assert.equal(serialized.includes('AO07-REQUEST-MARKER-9b2e'), false, 'the request text reached the handoff');
    assert.equal(serialized.includes('please store it'), false);
    assert.equal(handoff.proposal.action, 'memory.add', 'the action identity is named, not its payload');

    const refused = buildModelProposalHandoff({
      requestId: 'op-bounded-evidence',
      proposal: { proposalId: 'mp:1', action: 'calc.evaluate', input: { expression: '1+1' } },
      stepIndex: 0,
      evidenceRefs: Array.from({ length: 12 }, (_, i) => `ev:memory:record-${i}`),
    });
    assert.equal(refused.evidence.refs.length, 8, 'the list is bounded');
    assert.equal(refused.evidence.total, 12, 'the total is honest about what was omitted');
    assert.equal(validateHandoff(refused, { phase: 'prepared' }).ok, true);
  });
});

describe('AO-07 B: the controller records each crossing and refuses unsafe ones', () => {
  test('B1 duplicate proposals run once and leave one handoff', async () => {
    const dir = tempDir();
    const sink = [];
    const app = appIn(dir, {
      extraActions: makeFakeTaskActions(sink),
      gateway: stubGateway([
        'PROPOSE_ACTION {"action":"test.ok","input":{"tag":"same"}}',
        'PROPOSE_ACTION {"action":"test.ok","input":{"tag":"same"}}',
      ].join('\n')),
    });
    const res = await app.controller.handle('ask the test double twice', { origin: 'user' });
    assert.equal(res.operation.steps.length, 2, 'the repeat is visible as its own refusal');
    assert.equal(res.operation.steps[0].outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.operation.steps[1].outcome, Outcome.DUPLICATE_PROPOSAL);
    assert.equal(res.operation.steps[1].handoff, undefined, 'a proposal that never ran has no crossing');
    assert.deepEqual(sink, ['same'], 'the fake action ran exactly once');
    assert.equal(res.operation.steps.filter((step) => step.handoff).length, 1);
    assert.equal(handoffCount(dir), 1);
  });

  test('B2 a delayed model reply creates no crossing until it arrives and is executed', async () => {
    const dir = tempDir();
    let release;
    let reached;
    const arrived = new Promise((resolve) => { reached = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const gateway = new ModelGateway({
      backend: {
        name: 'delayed-stub',
        provider: 'delayed-stub',
        configured: true,
        describe: () => ({ configured: true, provider: 'delayed-stub', endpoint: 'delayed-stub', model: 'delayed-stub' }),
        health: async () => ({ available: true, detail: 'delayed stub' }),
        complete: async () => {
          reached();
          await gate;
          return {
            ok: true, backend: 'delayed-stub', provider: 'delayed-stub', model: 'delayed-stub',
            text: 'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"3*3"}}',
            finishReason: 'stop', truncated: false, latencyMs: 0,
          };
        },
      },
    });
    const app = appIn(dir, { gateway });
    const pending = app.controller.handle('tell me about a delayed arithmetic answer', { origin: 'user' });
    await arrived;
    assert.equal(fs.existsSync(path.join(dir, 'tasks.jsonl')), false, 'the stalled reply started a task');
    assert.equal(fs.existsSync(path.join(dir, 'plans.jsonl')), false);
    assert.equal(handoffCount(dir), 0);

    release();
    const res = await pending;
    assert.equal(res.operation.steps.length, 1);
    assert.equal(res.operation.steps[0].handoff.state, HandoffState.VERIFIED);
    assert.equal(handoffCount(dir), 1);
  });

  test('B3 a completed task cannot be run twice: the second crossing is denied and executes nothing', async () => {
    const dir = tempDir();
    const app = appIn(dir);
    const planned = await app.controller.planTask('list my memories');
    assert.equal(planned.status, Outcome.PLAN_CREATED, planned.display);
    const taskId = planned.task.id;

    const first = await app.controller.runTask(taskId);
    assert.equal(first.status, Outcome.SUCCESS_VERIFIED, first.output);
    const firstHandoff = first.operation.handoff;
    assert.equal(firstHandoff.kind, HandoffKind.TASK_RUN);
    assert.equal(firstHandoff.state, HandoffState.VERIFIED);
    assert.equal(firstHandoff.authorization.decision, 'allow');
    assert.equal(firstHandoff.approval.scope, 'task_creation');
    assert.equal(firstHandoff.approval.at, planned.task.createdAt);
    assert.equal(firstHandoff.approval.contentHash, taskBindingHash(planned.task));
    assert.equal(firstHandoff.approval.version, null);

    const task = await app.taskStore.get(taskId);
    const stepOps = taskStepOperations(dir, taskId);
    const checked = validateHandoffReferences(firstHandoff, { task, stepOperations: stepOps });
    assert.equal(checked.ok, true, checked.problems.join('; '));

    const before = records(dir, 'tasks.jsonl').length;
    const again = await app.controller.runTask(taskId);
    assert.equal(again.status, Outcome.INPUT_REJECTED, again.output);
    assert.equal(again.operation.handoff.state, HandoffState.DENIED,
      'a run that did not happen records a denial, never the earlier crossing\'s execution');
    assert.equal(again.operation.handoff.execution, null);
    assert.equal(again.operation.handoff.verification, null);
    assert.equal(again.operation.handoff.authorization.reason, 'TASK_STATE_NOT_RUNNABLE');
    assert.equal(records(dir, 'tasks.jsonl').length, before, 'the refused run appended a second execution');
    assert.equal(taskStepOperations(dir, taskId).length, 1, 'the step ran once');
  });

  test('B4 concurrent runs execute once and produce exactly one verified and one denied handoff', async () => {
    const dir = tempDir();
    const app = appIn(dir);
    const planned = await app.controller.planTask('list my memories');
    assert.equal(planned.status, Outcome.PLAN_CREATED, planned.display);
    const taskId = planned.task.id;

    const [a, b] = await Promise.all([
      app.controller.runTask(taskId),
      app.controller.runTask(taskId),
    ]);
    // The loser is refused either because the task is already complete or because the task store is
    // still held by the winner; both are refusals recorded as such, never a second execution.
    const statuses = [a.status, b.status].sort();
    assert.equal(statuses.filter((status) => status === Outcome.SUCCESS_VERIFIED).length, 1);
    assert.equal(statuses.filter((status) => status === Outcome.INPUT_REJECTED || status === Outcome.EXECUTION_FAILED).length, 1);

    const handoffs = operations(dir).filter((op) => op.capability === 'task.run' && op.handoff).map((op) => op.handoff);
    assert.equal(handoffs.length, 2, 'both attempts are audited');
    assert.equal(handoffs.filter((h) => h.state === HandoffState.VERIFIED).length, 1);
    assert.equal(handoffs.filter((h) => h.state === HandoffState.DENIED).length, 1);
    for (const h of handoffs.filter((entry) => entry.state === HandoffState.DENIED)) {
      assert.equal(h.execution, null, 'the losing crossing reported the winner\'s execution');
      assert.equal(h.verification, null);
    }
    assert.equal(taskStepOperations(dir, taskId).length, 1, 'the shared step ran once, not twice');
    const task = await app.taskStore.get(taskId);
    assert.deepEqual(task.steps.map((s) => s.status), [StepStatus.COMPLETED]);
  });

  test('B5 a failed step is reported as failure, never as success', async () => {
    const dir = tempDir();
    const sink = [];
    const app = appIn(dir, { extraActions: makeFakeTaskActions(sink) });
    const planId = await addPlan(app, [planStep('s1', 'test.fail', {})]);
    await approvePlan(app, planId);
    const run = await app.controller.planActivate(planId);
    assert.equal(run.status, Outcome.EXECUTION_FAILED, run.output);

    const task = await app.taskStore.get(run.task.id);
    assert.deepEqual(task.steps.map((s) => s.status), [StepStatus.FAILED]);
    const handoff = run.operation.handoff;
    assert.equal(handoff.kind, HandoffKind.PLAN_ACTIVATION);
    assert.equal(handoff.state, HandoffState.FAILED);
    assert.equal(handoff.execution.status, TaskStatus.FAILED);
    assert.equal(handoff.execution.steps.length, 1);
    assert.equal(handoff.execution.steps[0].status, StepStatus.FAILED);
    assert.equal(handoff.execution.steps[0].outcome, Outcome.EXECUTION_FAILED);
    assert.deepEqual({
      checked: handoff.verification.checked,
      verified: handoff.verification.verified,
      failed: handoff.verification.failed,
      unavailable: handoff.verification.unavailable,
    }, { checked: 1, verified: 0, failed: 1, unavailable: 0 });
    assert.equal(validateHandoff(handoff, { phase: 'recorded' }).ok, true);
    const checked = validateHandoffReferences(handoff, {
      plan: await app.plans.get(planId), task, stepOperations: taskStepOperations(dir, task.id),
    });
    assert.equal(checked.ok, true, checked.problems.join('; '));
    assert.deepEqual(sink, [], 'the failing double never reported an effect');
  });

  test('B6 an uncertain step is named as uncertain and is never replayed', async () => {
    const dir = tempDir();
    const sink = [];
    const app = appIn(dir, { extraActions: makeFakeTaskActions(sink).filter((action) => action.name === 'test.unverified') });
    const planId = await addPlan(app, [planStep('s1', 'test.unverified', { tag: 'u1' })]);
    await approvePlan(app, planId);
    const run = await app.controller.planActivate(planId);
    assert.equal(run.status, Outcome.VERIFICATION_UNAVAILABLE, run.output);

    const task = await app.taskStore.get(run.task.id);
    assert.deepEqual(task.steps.map((s) => s.status), [StepStatus.UNCERTAIN]);
    const handoff = run.operation.handoff;
    assert.equal(handoff.state, HandoffState.UNCERTAIN);
    assert.equal(handoff.verification.unavailable, 1);
    assert.equal(handoff.verification.verified, 0);
    assert.equal(handoff.execution.steps[0].outcome, Outcome.VERIFICATION_UNAVAILABLE);
    const stepOps = taskStepOperations(dir, task.id);
    assert.equal(stepOps.length, 1);
    assert.equal(stepOps[0].id, handoff.execution.steps[0].operationId);
    assert.equal(stepOps[0].status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(validateHandoffReferences(handoff, {
      plan: await app.plans.get(planId), task, stepOperations: stepOps,
    }).ok, true);

    const before = operations(dir).length;
    const again = await app.controller.planActivate(planId);
    assert.equal(again.status, Outcome.INPUT_REJECTED, again.output);
    assert.equal(again.operation.handoff, undefined, 'a refused activation opens no crossing');
    assert.equal(operations(dir).length, before + 1, 'the refusal is its own audit record');
    assert.deepEqual(sink, ['u1'], 'neither the run nor the refusal re-executed the uncertain step');
  });

  test('B7 an activation whose own audit append fails leaves no handoff line and says so', async () => {
    const dir = tempDir();
    const app = appIn(dir);
    const planId = await addPlan(app, [planStep('s1', 'memory.add', { content: 'AO-07 append-failure fact' })]);
    await approvePlan(app, planId);

    const original = app.operations.append.bind(app.operations);
    app.operations.append = async (record) => {
      if (record.capability === 'plan.activate') {
        throw new StoreError('injected: the audit log refused the activation record');
      }
      return original(record);
    };
    let run;
    try {
      run = await app.controller.planActivate(planId);
    } finally {
      app.operations.append = original;
    }
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.output);
    assert.equal(run.recorded, false, 'the operation log is the authority on whether the record was written');
    assert.ok(run.operation.handoff, 'the returned operation still states the crossing it performed');
    assert.equal(run.operation.handoff.finalization.recorded, null,
      'the handoff does not claim its own finalization');
    assert.equal(operations(dir).filter((op) => op.capability === 'plan.activate').length, 0,
      'an audit record that refused the write left a handoff line behind');
    assert.equal(records(dir, 'memory.jsonl').length, 1, 'the side effect is separate from the audit failure');
  });

  test('B8 cancellation after approval prevents execution and opens no crossing', async () => {
    const dir = tempDir();
    const app = appIn(dir);
    const planId = await addPlan(app, [planStep('s1', 'memory.add', { content: 'AO-07 cancelled fact' })]);
    await approvePlan(app, planId);
    const cancelled = await app.controller.planCancel({ target: planId, reason: 'the user changed their mind' });
    assert.equal(cancelled.status, Outcome.PLAN_STORED, cancelled.display);

    const before = records(dir, 'memory.jsonl').length;
    const run = await app.controller.planActivate(planId);
    assert.equal(run.status, Outcome.INPUT_REJECTED, run.output);
    assert.equal(run.operation.handoff, undefined, 'a plan refused before activation opened no crossing');
    assert.equal(fs.existsSync(path.join(dir, 'tasks.jsonl')), false, 'a cancelled plan created a task');
    assert.equal(records(dir, 'memory.jsonl').length, before, 'the cancelled plan wrote memory');
  });

  test('B9 a model-proposed task cannot run before the user approves it, and then names that approval', async () => {
    const dir = tempDir();
    const sink = [];
    const app = appIn(dir, {
      extraActions: makeFakeTaskActions(sink),
      gateway: makePlanGateway([taskStep('s1', 'test.ok', [], { tag: 'model-proposed' })]),
    });
    const proposed = await app.controller.planTask('do the whole thing for me');
    assert.equal(proposed.status, Outcome.PLAN_PROPOSED, proposed.output);
    assert.equal(proposed.task.origin, 'model');

    const refused = await app.controller.runTask(proposed.task.id);
    assert.equal(refused.status, Outcome.INPUT_REJECTED, refused.output);
    assert.equal(refused.operation.handoff.state, HandoffState.DENIED);
    assert.equal(refused.operation.handoff.authorization.reason, 'TASK_APPROVAL_MISSING');
    assert.equal(refused.operation.handoff.execution, null);
    assert.deepEqual(sink, [], 'a model proposal ran without the user');

    const approved = await app.controller.approveTask(proposed.task.id);
    assert.equal(approved.status, Outcome.SUCCESS_VERIFIED, approved.display);
    const task = await app.taskStore.get(proposed.task.id);
    assert.equal(task.status, TaskStatus.PENDING);
    assert.ok(task.approvedAt, 'the user\'s approval act is recorded on the task');

    const run = await app.controller.runTask(proposed.task.id);
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.output);
    assert.deepEqual(sink, ['model-proposed'], 'the approved step ran once');
    const handoff = run.operation.handoff;
    assert.equal(handoff.authorization.decision, 'allow');
    assert.equal(handoff.approval.scope, 'task_approval');
    assert.equal(handoff.approval.at, task.approvedAt);
    assert.equal(handoff.approval.contentHash, taskBindingHash(task));
    assert.equal(handoff.state, HandoffState.VERIFIED);
    const checked = validateHandoffReferences(handoff, {
      task: await app.taskStore.get(proposed.task.id),
      stepOperations: taskStepOperations(dir, proposed.task.id),
    });
    assert.equal(checked.ok, true, checked.problems.join('; '));
  });
});

describe('AO-07 C: end-to-end acceptance of the handoff boundary', () => {
  test('C1 prepare -> approve -> start leaves one plan-activation handoff bound to the approval and the task', async () => {
    const dir = tempDir();
    const app = appIn(dir);
    const prepared = await app.controller.handle(
      'prepare a plan to remember that the AO-07 acceptance fact holds and then list my memories',
      { origin: 'user' },
    );
    assert.equal(prepared.status, Outcome.PLAN_STORED, prepared.output);
    const planId = prepared.operation.steps[0].result.data.planId;
    const short = planId.slice(0, 8);
    const approved = await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
    assert.equal(approved.status, Outcome.PLAN_STORED, approved.output);
    const run = await app.controller.handle(`start plan ${short}`, { origin: 'user' });
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.output);

    assert.deepEqual(operations(dir).map((op) => op.capability),
      ['executive.prepare', 'executive.approve', 'task.step', 'task.step', 'plan.activate', 'executive.execute'],
      'the handoff added no operation to the lifecycle');
    const activation = operations(dir).find((op) => op.capability === 'plan.activate');
    assert.ok(activation.handoff, 'the activation carries the crossing record');
    assert.equal(activation.handoff.kind, HandoffKind.PLAN_ACTIVATION);
    assert.equal(activation.handoff.authorizes, false);
    assert.equal(activation.handoff.state, HandoffState.VERIFIED);

    const plan = await app.plans.get(planId);
    const task = await app.taskStore.get(plan.activation.taskId);
    assert.equal(plan.status, 'completed');
    const handoff = activation.handoff;
    assert.equal(handoff.plan.id, planId);
    assert.equal(handoff.plan.version, plan.version);
    assert.equal(handoff.plan.contentHash, planContentHash(plan));
    assert.equal(handoff.approval.scope, 'plan_approval');
    assert.equal(handoff.approval.at, plan.approval.at);
    assert.equal(handoff.approval.version, plan.version);
    assert.equal(handoff.approval.contentHash, plan.approval.contentHash);
    assert.equal(handoff.approval.contentHash, handoff.plan.contentHash, 'the approval binds the bytes that ran');
    assert.equal(handoff.goal, null);
    assert.equal(handoff.task.id, task.id);
    assert.equal(handoff.task.planId, planId);
    assert.equal(handoff.task.stepCount, 2);
    assert.deepEqual(handoff.authorization, {
      owner: 'plan_approval', decision: 'allow', reason: null,
      basis: 'approval_bound_to_live_plan', perStep: 'registry_decided_at_run',
    });
    assert.equal(handoff.execution.status, TaskStatus.COMPLETED);
    assert.deepEqual(handoff.execution.steps.map((s) => s.status), [StepStatus.COMPLETED, StepStatus.COMPLETED]);
    assert.deepEqual({
      checked: handoff.verification.checked,
      verified: handoff.verification.verified,
      failed: handoff.verification.failed,
      unavailable: handoff.verification.unavailable,
    }, { checked: 2, verified: 2, failed: 0, unavailable: 0 });
    const stepOps = taskStepOperations(dir, task.id);
    assert.equal(stepOps.length, 2);
    assert.deepEqual(handoff.evidence.refs.sort(),
      stepOps.map((op) => `ev:operation:${op.id}`).sort(),
      'the evidence is the operation records the run actually wrote');

    assert.equal(validateHandoff(handoff, { phase: 'recorded' }).ok, true);
    const checked = validateHandoffReferences(handoff, { plan, task, stepOperations: stepOps });
    assert.equal(checked.ok, true, checked.problems.join('; '));
    assert.equal(checked.authorizes, false);
    const outer = operations(dir).find((op) => op.capability === 'executive.execute');
    assert.equal(outer.steps.length, 0, 'the outer act still has no steps of its own');
    assert.equal(outer.handoff, undefined, 'the crossing record belongs to the activation it names');
    assert.equal(handoffCount(dir), 1, 'one crossing, one handoff');
  });

  test('C2 a response-only request activates no executive path and records no handoff', async () => {
    const dir = tempDir();
    const app = appIn(dir, { gateway: stubGateway('A plain answer with no proposed action.') });
    const res = await app.controller.handle('what is the capital of France?', { origin: 'user' });
    assert.equal(res.operation.capability, 'model.answer');
    assert.equal(res.operation.steps.length, 0);
    assert.equal(handoffCount(dir), 0, 'a grounded answer opened a crossing');
    assert.equal(fs.existsSync(path.join(dir, 'tasks.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dir, 'plans.jsonl')), false);
    assert.equal(records(dir, 'memory.jsonl').length, 0);
  });

  test('C3 a user-created task run is bound to the creation that authorized it', async () => {
    const dir = tempDir();
    const app = appIn(dir);
    const planned = await app.controller.planTask('list my memories');
    assert.equal(planned.status, Outcome.PLAN_CREATED, planned.display);
    const run = await app.controller.runTask(planned.task.id);
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.output);
    const handoff = run.operation.handoff;
    assert.equal(handoff.kind, HandoffKind.TASK_RUN);
    assert.equal(handoff.source, 'user');
    assert.equal(handoff.authorization.owner, 'task_status');
    assert.equal(handoff.approval.scope, 'task_creation');
    assert.equal(handoff.approval.at, planned.task.createdAt);
    assert.equal(handoff.approval.contentHash, taskBindingHash(planned.task));
    assert.equal(handoff.state, HandoffState.VERIFIED);
    const task = await app.taskStore.get(planned.task.id);
    const checked = validateHandoffReferences(handoff, {
      task,
      stepOperations: taskStepOperations(dir, planned.task.id),
    });
    assert.equal(checked.ok, true, checked.problems.join('; '));
    assert.equal(handoff.evidence.refs.length, 1);
    assert.match(handoff.evidence.refs[0], /^ev:operation:/);
  });
});
