// Batch AM, work package D: what a partially executed plan may be taken up again, and what forbids it.
//
// Batch AL could recover an interrupted run inside one process and report six classes of step. It could
// not say which of nine states a run was in, could not tell a step waiting for the user's confirmation
// from one whose outcome is simply unknown, and had no path that took up the steps a stopped branch
// never reached. This package adds the vocabulary, the derivation, and one command that acts on it - and
// the command's first job is to refuse.
//
// The rules these tests exist to prove are the ones a system that resumes work can break without
// noticing: never replay a step whose effect may have happened; never read a lost process as a failed
// step; never treat a function returning as proof about the world; re-read the plan bytes, the approval,
// the registry, the constraints and the dependencies before taking anything up; keep the history;
// require a fresh approval for a materially revised plan; and leave reconciliation explicit and
// auditable.
//
// Sections AM-D1 and AM-D2 derive states from records handed in, so every claim is checked against the
// record that is supposed to support it. Section AM-D3 stops a real child process at each of the eight
// interruption boundaries and reads the durable bytes back from a second process: the interruption is
// not described, it is left on disk. Section AM-D4 runs the whole path through the real stores, action
// registry, task lock, audit log and finalization contract.
//
// One finding these tests state rather than smooth over. Three of the eight boundaries - a process lost
// during execution, after execution but before verification, and after verification but before the audit
// append - leave byte-identical records: a step the task log holds as running, its effect in the
// side-effect file, and no operation record. APEX cannot tell them apart and does not pretend to: all
// three are `outcome uncertain`, and none is ever produced a second time. That equality is the evidence
// that the state is read from the records and not from a guess about where the process died.
//
// Synthetic fixtures throughout. The gateway is NoBackend and capture is off: no model is contacted, no
// inference runs, and the probe capabilities in tests/fixtures/continuation-child.mjs stand for real
// actions rather than demonstrating them.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { StepStatus, TaskStatus } from '../src/tasks/model.js';
import { PlanStatus, planContentHash } from '../src/plans/model.js';
import { constraintLedger } from '../src/plans/constraints.js';
import { shortId } from '../src/util.js';
import {
  INTERRUPTION_BOUNDARIES, INTERRUPTION_BOUNDARY, BOUNDARY_SIGNATURE,
  continuationAudit, continuationDigest, continuationOf, renderContinuation,
} from '../src/plans/continuation.js';
import {
  CONTINUATION_EVIDENCE, CONTINUATION_NOTE, CONTINUATION_RULE, CONTINUATION_STATES, ContinuationState,
} from '../src/executive/vocabulary.js';
import { makeTempDataDir, cleanup, cleanEnv, APP_ROOT, runCli } from './helpers.js';

const CLOCK = () => new Date('2026-11-05T09:00:00.000Z');
const dirs = [];
const children = [];
after(async () => {
  for (const c of children) {
    c.child.kill();
    await Promise.race([c.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  while (dirs.length) cleanup(dirs.pop());
});
const dir = () => { const d = makeTempDataDir(); dirs.push(d); return d; };
const effectFileOf = (dataDir) => path.join(dataDir, 'effects.txt');

// The two fixture capabilities the child's plan steps name, registered again here so the second
// process holds the same registry the first one ran against. Without them every continuation answer
// would be "the live registry refuses probe.note" - a true reading, but one that describes the test
// harness rather than the interrupted run. They behave exactly as tests/fixtures/continuation-child.mjs
// describes: one line per effect in the side-effect file, and a verifier that re-reads the file.
function probeActions(dataDir) {
  const effectFile = effectFileOf(dataDir);
  const make = (name, permission, mark) => ({
    name,
    description: `fixture ${permission} that leaves one observable line behind`,
    inputHint: '{"tag":"text"}',
    permission,
    origins: permission === 'write' ? ['user'] : ['user', 'model'],
    validate: (input) => ({ tag: String(input?.tag ?? 'x').trim() }),
    async execute(_ctx, input) {
      fs.appendFileSync(effectFile, `${mark(input.tag)}\n`);
      return { summary: `${name} ${input.tag}`, data: { tag: input.tag, effect: mark(input.tag) } };
    },
    async verify(_ctx, input, result) {
      const want = mark(String(input?.tag ?? result?.data?.tag ?? ''));
      const linesNow = fs.existsSync(effectFile)
        ? fs.readFileSync(effectFile, 'utf8').split('\n').filter((l) => l.trim() !== '')
        : [];
      return linesNow.includes(want)
        ? { ok: true, detail: `the side-effect file holds ${want}` }
        : { ok: false, detail: `the side-effect file holds no ${want}` };
    },
  });
  return [
    make('probe.note', 'write', (tag) => tag),
    make('probe.peek', 'read', (tag) => `read:${tag}`),
  ];
}

const appIn = (dataDir) => createApp({
  dataDir,
  now: CLOCK,
  gateway: new ModelGateway({ backend: new NoBackend() }),
  experienceCapture: CAPTURE_OFF,
  extraActions: probeActions(dataDir),
});

const data = (res) => res?.operation?.steps?.[0]?.result?.data ?? res?.result?.data ?? {};
const display = (res) => String(res?.display ?? res?.output ?? '');
const lines = (text) => String(text ?? '').split('\n');

// ---- the records a derivation reads -----------------------------------------

const NAMES = ['memory.add', 'memory.list', 'calc.evaluate'];
const registry = {
  names: () => [...NAMES],
  get: (name) => (NAMES.includes(name)
    ? { name, permission: name === 'memory.add' ? 'write' : 'read', plannable: true }
    : null),
  authorize: (name) => (NAMES.includes(name)
    ? { decision: 'allow' }
    : { decision: 'deny', reason: 'UNKNOWN_ACTION' }),
};

function planStep(id, action, dependsOn = []) {
  return {
    id,
    description: `the ${id} step of the fixture plan`,
    action,
    input: { tag: id },
    dependsOn,
    expectedResult: `the ${id} result is recorded`,
    verification: 'the action re-checks its own result',
    risk: 'medium',
    reversibility: action === 'memory.add' ? 'reversible' : 'read_only',
  };
}

// A plan record with its approval bound to the bytes it actually holds - because that binding is what a
// continuation has to re-check, and a fixture that faked it would prove nothing about the check.
function fixturePlan(planSteps, over = {}) {
  const plan = {
    id: 'fx-plan-1',
    goalId: null,
    goalRevision: null,
    origin: 'user',
    version: 1,
    status: PlanStatus.BLOCKED,
    outcome: 'both fixture notes are recorded',
    steps: planSteps,
    preconditions: [],
    assertions: [],
    resources: { estimatedSeconds: null },
    history: [],
    approval: null,
    activation: { taskId: 'fx-task-1', contentHash: null, at: '2026-11-04T00:00:00.000Z' },
    stepResults: {},
    assessments: [],
    ...over,
  };
  plan.approval = {
    version: plan.version,
    contentHash: planContentHash(plan),
    at: '2026-11-04T00:00:00.000Z',
    reason: 'approved by the user',
  };
  return plan;
}

function taskStep(id, action, status, extra = {}) {
  return {
    id,
    description: `the ${id} step`,
    action,
    permission: extra.permission ?? (action === 'memory.add' ? 'write' : 'read'),
    input: { tag: id },
    dependsOn: extra.dependsOn ?? [],
    status,
    operationId: extra.operationId ?? null,
    outcome: extra.outcome ?? null,
    summary: extra.summary ?? null,
  };
}

function fixtureTask(steps, over = {}) {
  return {
    id: 'fx-task-1',
    planId: 'fx-plan-1',
    status: TaskStatus.PAUSED,
    origin: 'user',
    steps,
    ...over,
  };
}

// The step's own audit record, in the shape the runner writes and recovery matches.
const stepOp = (stepId, id, status) => ({
  id, capability: 'task.step', task: { id: 'fx-task-1', stepId }, status, steps: [], errors: [],
});

const NO_LOCK = { present: false, pid: null, alive: false };
const LIVE_LOCK = { present: true, pid: 424242, alive: true };
const UNKNOWN_LOCK = { present: true, pid: null, alive: null };

// A goal with nothing recorded against it, so the constraint check answers "none able to stop work"
// rather than "no ledger was read" - which are different answers with different consequences.
function emptyLedger(goalId = 'fx-goal-1') {
  return constraintLedger({
    goal: {
      id: goalId, revision: 1, status: 'active', criteria: [], prerequisites: [], blockers: [],
      constraints: [], resources: [], timeConditions: [], unknowns: [], dependsOn: [],
    },
    registry,
  });
}

function reading({
  planSteps = [planStep('s1', 'memory.add')],
  taskSteps = [taskStep('s1', 'memory.add', StepStatus.UNCERTAIN, { operationId: 'op-1' })],
  plan: planOver = {},
  task: taskOver = {},
  operations = [],
  lock = NO_LOCK,
  auditReadable = true,
  constraints = emptyLedger(),
  registry: reg = registry,
  validity = null,
} = {}) {
  const plan = fixturePlan(planSteps, planOver);
  const task = fixtureTask(taskSteps, taskOver);
  return {
    plan, task,
    continuation: continuationOf({
      plan, task, operations, registry: reg, constraints, validity, lock, auditReadable, now: CLOCK(),
    }),
  };
}
const row = (c, id) => c.steps.find((r) => r.id === id);

describe('AM-D1: the nine states, each read from the record that proves it', () => {
  test('the vocabulary holds exactly the nine states the batch asked for, and each names a record', () => {
    assert.deepEqual([...CONTINUATION_STATES].sort(), [
      'awaiting external confirmation', 'blocked', 'not started', 'outcome uncertain',
      'requires user intervention', 'running', 'safe to continue', 'verified failed', 'verified successful',
    ].sort());
    for (const state of CONTINUATION_STATES) {
      assert.ok(CONTINUATION_EVIDENCE[state], `${state} is a state with no record that could ever prove it`);
    }
    // The rule is the part a reader has to be able to check, so it travels in full, not summarised.
    assert.match(CONTINUATION_RULE, /nothing is read from a process that stopped/);
    assert.match(CONTINUATION_RULE, /is never continued again by this path/);
    assert.match(CONTINUATION_RULE, /fresh approval/);
    assert.match(CONTINUATION_RULE, /APEX runs only when a command runs/);
    assert.match(CONTINUATION_NOTE, /continues nothing/);
  });

  test('a step with no operation link is proven not to have started, and a run of only such steps has not started', () => {
    const { continuation } = reading({
      planSteps: [planStep('s1', 'memory.add'), planStep('s2', 'memory.list')],
      taskSteps: [
        taskStep('s1', 'memory.add', StepStatus.PENDING),
        taskStep('s2', 'memory.list', StepStatus.PENDING),
      ],
      task: { status: TaskStatus.PENDING },
      plan: { status: PlanStatus.ACTIVE },
    });
    assert.equal(continuation.runState, ContinuationState.NOT_STARTED);
    assert.deepEqual(continuation.continue.runnable, ['s1', 's2'], 'both are proven never to have begun');
    assert.equal(row(continuation, 's1').state, ContinuationState.SAFE_TO_CONTINUE);
    assert.equal(row(continuation, 's1').operation, null, 'no operation link, which is what proves it');
    assert.equal(continuation.continue.safe, true);
    assert.equal(continuation.nextCommand, `plan continue ${shortId('fx-plan-1')}`);
  });

  test('a step recorded as running while a live process holds the task lock is running, not interrupted', () => {
    const { continuation } = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.RUNNING, { operationId: 'op-9' })],
      task: { status: TaskStatus.RUNNING },
      lock: LIVE_LOCK,
    });
    assert.equal(row(continuation, 's1').state, ContinuationState.RUNNING);
    assert.equal(continuation.runState, ContinuationState.RUNNING);
    assert.equal(continuation.continue.safe, false, 'another process holds the run');
    assert.deepEqual(continuation.continue.neverReplay, ['s1']);
    assert.match(row(continuation, 's1').why, /live process holds the task lock/);
    assert.match(continuation.whatWouldSettleIt.join(' '), /the process that holds the task lock/);
  });

  test('the same bytes with the lock unreadable are not reported as running', () => {
    // A lock that cannot be read proves nobody is running this. It proves nothing else, so the step
    // keeps the state its own records give it and no live-process claim is made.
    const { continuation } = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.RUNNING, { operationId: 'op-9' })],
      task: { status: TaskStatus.RUNNING },
      lock: UNKNOWN_LOCK,
    });
    assert.equal(row(continuation, 's1').state, ContinuationState.OUTCOME_UNCERTAIN);
    assert.match(row(continuation, 's1').why, /no live process holds the task lock/);
  });

  test('a completed step is verified only by its own audit record, and the record is named', () => {
    const { continuation } = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.COMPLETED, { operationId: 'op-1' })],
      operations: [stepOp('s1', 'op-1', Outcome.SUCCESS_VERIFIED)],
    });
    assert.equal(row(continuation, 's1').state, ContinuationState.VERIFIED_SUCCESSFUL);
    assert.equal(row(continuation, 's1').evidence.record.store, 'operations');
    assert.equal(row(continuation, 's1').evidence.record.ref, 'op-1');
    assert.match(row(continuation, 's1').why, /verifier/);

    // Without the record, the task log's word is thinner, and it says so instead of claiming the same.
    const alone = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.COMPLETED, { operationId: 'op-1' })],
      operations: [],
    }).continuation;
    assert.equal(row(alone, 's1').thinEvidence, true);
    assert.match(row(alone, 's1').why, /rests on the task log alone/);
    assert.equal(row(alone, 's1').state, ContinuationState.VERIFIED_SUCCESSFUL,
      'the task log still records a completion; it is a thinner claim, and is marked as one');
  });

  test('a completed step whose own record contradicts it is uncertain, and neither log is taken as the outcome', () => {
    const { continuation } = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.COMPLETED, { operationId: 'op-1' })],
      operations: [stepOp('s1', 'op-1', Outcome.EXECUTION_FAILED)],
    });
    assert.equal(row(continuation, 's1').state, ContinuationState.OUTCOME_UNCERTAIN);
    assert.equal(row(continuation, 's1').contradictory, true);
    assert.match(row(continuation, 's1').why, /disagree/);
    assert.equal(continuation.continue.safe, false);
    assert.match(continuation.whatWouldSettleIt.join(' '), /does not pick which one to believe/);
  });

  test('a failed read may be retried by the user; a failed write may not be repeated by APEX', () => {
    const failedWrite = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.FAILED, { operationId: 'op-1', outcome: Outcome.EXECUTION_FAILED })],
      operations: [stepOp('s1', 'op-1', Outcome.EXECUTION_FAILED)],
    }).continuation;
    assert.equal(row(failedWrite, 's1').state, ContinuationState.VERIFIED_FAILED);
    assert.equal(row(failedWrite, 's1').retryable, undefined, 'a write whose attempt failed is not offered a repeat');
    assert.match(row(failedWrite, 's1').mayRun, /not by APEX/);

    const failedRead = reading({
      planSteps: [planStep('s1', 'calc.evaluate')],
      taskSteps: [taskStep('s1', 'calc.evaluate', StepStatus.FAILED, { operationId: 'op-1', outcome: Outcome.EXECUTION_FAILED })],
      operations: [stepOp('s1', 'op-1', Outcome.EXECUTION_FAILED)],
    }).continuation;
    assert.equal(row(failedRead, 's1').retryable, true);
    assert.match(failedRead.whatWouldSettleIt.join(' '), /task retry/);
    assert.equal(failedRead.runState, ContinuationState.VERIFIED_FAILED);
  });

  test('an interrupted step is outcome uncertain, and is never called failed because the process stopped', () => {
    const { continuation } = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.RUNNING, { operationId: 'op-1' })],
      operations: [],
    });
    const s1 = row(continuation, 's1');
    assert.equal(s1.state, ContinuationState.OUTCOME_UNCERTAIN);
    assert.equal(s1.boundary, 'after_running_recorded');
    assert.equal(s1.operation, 'op-1 recorded, no such audit record');
    assert.match(s1.why, /not recorded either way/);
    assert.equal(continuation.continue.safe, false);
    assert.deepEqual(continuation.continue.neverReplay, ['s1']);
    assert.match(s1.mayRun, /never/);
    // The rule that makes this a finding rather than a wording: an uncertain write is the user's to
    // settle, so the run as a whole is handed back rather than continued past it.
    assert.equal(continuation.runState, ContinuationState.REQUIRES_USER);
    assert.match(continuation.whatWouldSettleIt.join(' '), /plan replan|plan revise/);
  });

  test('a step waiting for the user is awaiting external confirmation, which is not the same as unknown', () => {
    const { continuation } = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.AWAITING_APPROVAL)],
    });
    assert.equal(row(continuation, 's1').state, ContinuationState.AWAITING_CONFIRMATION);
    assert.deepEqual(continuation.continue.awaiting, ['s1']);
    assert.match(row(continuation, 's1').why, /confirmation APEX does not hold/);
    assert.equal(continuation.continue.safe, false);
    assert.equal(continuation.runState, ContinuationState.AWAITING_CONFIRMATION);
  });

  test('a pending step behind a step that did not verify is blocked, not safe', () => {
    const { continuation } = reading({
      planSteps: [planStep('s1', 'memory.add'), planStep('s2', 'memory.list', ['s1'])],
      taskSteps: [
        taskStep('s1', 'memory.add', StepStatus.UNCERTAIN, { operationId: 'op-1' }),
        taskStep('s2', 'memory.list', StepStatus.PENDING, { dependsOn: ['s1'] }),
      ],
      operations: [],
    });
    assert.equal(row(continuation, 's2').state, ContinuationState.BLOCKED);
    assert.deepEqual(row(continuation, 's2').blockingDeps, ['s1']);
    assert.deepEqual(continuation.continue.runnable, [], 'nothing here may be taken up');
    assert.deepEqual(continuation.continue.blockedByRun, ['s2']);
  });

  test('a pending step whose dependency holds a verified success is safe to continue', () => {
    const { continuation } = reading({
      planSteps: [planStep('s1', 'memory.add'), planStep('s2', 'memory.list', ['s1'])],
      taskSteps: [
        taskStep('s1', 'memory.add', StepStatus.COMPLETED, { operationId: 'op-1' }),
        taskStep('s2', 'memory.list', StepStatus.PENDING, { dependsOn: ['s1'] }),
      ],
      operations: [stepOp('s1', 'op-1', Outcome.SUCCESS_VERIFIED)],
      plan: { status: PlanStatus.ACTIVE },
    });
    assert.deepEqual(continuation.continue.runnable, ['s2']);
    assert.equal(row(continuation, 's2').state, ContinuationState.SAFE_TO_CONTINUE);
    assert.equal(continuation.continue.safe, true);
    assert.equal(continuation.runState, ContinuationState.SAFE_TO_CONTINUE, 'a partially executed run, not one that never began');
  });

  test('a step in a status this vocabulary does not know is reported, not translated into one that fits', () => {
    const { continuation } = reading({
      taskSteps: [taskStep('s1', 'memory.add', 'half_done')],
    });
    assert.equal(row(continuation, 's1').state, ContinuationState.REQUIRES_USER);
    assert.match(row(continuation, 's1').why, /does not know/);
  });

  test('a fully verified run is settled only when the plan record says so too', () => {
    const notReconciled = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.COMPLETED, { operationId: 'op-1' })],
      task: { status: TaskStatus.COMPLETED },
      operations: [stepOp('s1', 'op-1', Outcome.SUCCESS_VERIFIED)],
      plan: { status: PlanStatus.ACTIVE },
    }).continuation;
    assert.equal(notReconciled.runState, ContinuationState.REQUIRES_USER);
    const planStatus = notReconciled.revalidation.find((r) => r.check === 'plan_status');
    assert.equal(planStatus.ok, false);
    assert.match(planStatus.detail, /reconciliation/);

    const done = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.COMPLETED, { operationId: 'op-1' })],
      task: { status: TaskStatus.COMPLETED },
      operations: [stepOp('s1', 'op-1', Outcome.SUCCESS_VERIFIED)],
      plan: { status: PlanStatus.COMPLETED },
    }).continuation;
    assert.equal(done.runState, ContinuationState.VERIFIED_SUCCESSFUL);
    assert.equal(done.continue.runnable.length, 0);
  });

  test('one unreadable audit log makes every outcome unknown rather than absent', () => {
    const { continuation } = reading({
      planSteps: [planStep('s1', 'memory.add'), planStep('s2', 'memory.list')],
      taskSteps: [
        taskStep('s1', 'memory.add', StepStatus.COMPLETED, { operationId: 'op-1' }),
        taskStep('s2', 'memory.list', StepStatus.RUNNING, { operationId: 'op-2' }),
      ],
      operations: [stepOp('s1', 'op-1', Outcome.SUCCESS_VERIFIED)],
      auditReadable: false,
    });
    assert.equal(row(continuation, 's1').state, ContinuationState.OUTCOME_UNCERTAIN,
      'a verified step is not verified when its record cannot be read');
    assert.equal(row(continuation, 's2').state, ContinuationState.OUTCOME_UNCERTAIN);
    assert.equal(continuation.task.auditReadable, false);
    assert.equal(continuation.continue.safe, false);
    assert.match(continuation.whatWouldSettleIt.join(' '), /operation log to be readable/);
  });
});

describe('AM-D2: what a continuation is forbidden to assume', () => {
  test('an approval that no longer binds the plan bytes stops the continuation, naming both hashes', () => {
    const plan = fixturePlan([planStep('s1', 'memory.add'), planStep('s2', 'memory.list')]);
    const moved = { ...plan, approval: { ...plan.approval, contentHash: 'b'.repeat(64) } };
    const c = continuationOf({
      plan: moved,
      task: fixtureTask([taskStep('s1', 'memory.add', StepStatus.PENDING), taskStep('s2', 'memory.list', StepStatus.PENDING)]),
      operations: [], registry, lock: NO_LOCK, constraints: emptyLedger(),
    });
    assert.equal(c.plan.approval.bound, false);
    assert.equal(row(c, 's1').state, ContinuationState.REQUIRES_USER);
    assert.equal(c.continue.safe, false);
    assert.match(c.plan.approval.why, /names content .* and the plan now hashes to /);
    assert.match(c.whatWouldSettleIt.join(' '), /plan approve/);
    assert.equal(c.revalidation.find((r) => r.check === 'approval').ok, false);
  });

  test('a materially revised plan is a different plan, and the old approval does not carry it', () => {
    const plan = fixturePlan([planStep('s1', 'memory.add'), planStep('s2', 'memory.list')]);
    const revised = {
      ...plan,
      version: 2,
      steps: [planStep('s1', 'memory.add'), planStep('s2', 'memory.list'), planStep('s3', 'calc.evaluate')],
    };
    const c = continuationOf({
      plan: revised,
      task: fixtureTask([taskStep('s1', 'memory.add', StepStatus.PENDING)]),
      operations: [], registry, lock: NO_LOCK, constraints: emptyLedger(),
    });
    assert.equal(c.plan.approval.bound, false, 'a step added to the plan is different bytes, and the approval binds the bytes it was given');
    assert.match(c.plan.approval.why, /names content .* and the plan now hashes to /);
    assert.equal(c.continue.safe, false);

    // The other half of the same rule, read the same way: content untouched and only the revision number
    // moved is still an approval that does not name the plan as it now stands.
    const bumped = continuationOf({
      plan: { ...plan, version: 2 },
      task: fixtureTask([taskStep('s1', 'memory.add', StepStatus.PENDING)]),
      operations: [], registry, lock: NO_LOCK, constraints: emptyLedger(),
    });
    assert.equal(bumped.plan.approval.bound, false);
    assert.match(bumped.plan.approval.why, /version 1 and the plan is version 2/);
    assert.equal(bumped.continue.safe, false);
  });

  test('a capability the live registry no longer holds is not taken up, and the refusal names the step', () => {
    const { continuation } = reading({
      planSteps: [planStep('s1', 'memory.list')],
      taskSteps: [taskStep('s1', 'memory.list', StepStatus.PENDING)],
      registry: { ...registry, authorize: () => ({ decision: 'deny', reason: 'UNKNOWN_ACTION' }) },
    });
    assert.equal(row(continuation, 's1').state, ContinuationState.REQUIRES_USER);
    assert.match(row(continuation, 's1').why, /registry/i);
    assert.equal(continuation.continue.safe, false);
    assert.equal(continuation.revalidation.find((r) => r.check === 'registry').ok, false);
  });

  test('a recorded constraint that gates a pending step keeps it from being taken up', () => {
    const goal = {
      id: 'fx-goal-1', revision: 1, status: 'active', criteria: [],
      blockers: [{ text: 'memory.add is disabled on this machine', basis: 'user_stated' }],
      prerequisites: [], constraints: [], resources: [], timeConditions: [], unknowns: [], dependsOn: [],
    };
    const { continuation } = reading({
      planSteps: [planStep('s1', 'memory.add')],
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.PENDING)],
      plan: { goalId: 'fx-goal-1', goalRevision: 1 },
      constraints: constraintLedger({ goal, registry }),
    });
    assert.equal(row(continuation, 's1').state, ContinuationState.BLOCKED);
    assert.deepEqual(row(continuation, 's1').gates, ['confirmed_blocker']);
    assert.equal(continuation.continue.safe, false);
    assert.match(continuation.revalidation.find((r) => r.check === 'constraints').detail, /1 recorded constraint/);
  });

  test('a constraint record that could not be read is not treated as a cleared one', () => {
    const { continuation } = reading({
      planSteps: [planStep('s1', 'memory.add')],
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.PENDING)],
      plan: { goalId: 'fx-goal-1' },
      constraints: null,
    });
    const c = continuation.revalidation.find((r) => r.check === 'constraints');
    assert.equal(c.ok, false);
    assert.match(c.detail, /could not be read/);
    assert.equal(continuation.continue.safe, false, 'an unread constraint record is not a cleared one');
  });

  test('the audit record that resolves an interrupted step is used, and the step is not taken up again', () => {
    const { continuation } = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.RUNNING, { operationId: 'op-1' })],
      operations: [stepOp('s1', 'op-1', Outcome.SUCCESS_VERIFIED)],
    });
    const s1 = row(continuation, 's1');
    assert.equal(s1.state, ContinuationState.VERIFIED_SUCCESSFUL);
    assert.equal(s1.boundary, INTERRUPTION_BOUNDARY.AFTER_VERIFICATION_BEFORE_FINALIZATION);
    assert.equal(s1.resolvableFromAudit, true);
    assert.deepEqual(continuation.continue.neverReplay, []);
    assert.equal(continuation.continue.runnable.length, 0, 'it settled, so there is nothing to take up');
  });

  test('a task that does not belong to this plan is refused, not adopted', () => {
    const plan = fixturePlan([planStep('s1', 'memory.add')]);
    const c = continuationOf({
      plan,
      task: fixtureTask([taskStep('s1', 'memory.add', StepStatus.PENDING)], { planId: 'someone-elses-plan' }),
      operations: [], registry, lock: NO_LOCK, constraints: emptyLedger(),
    });
    assert.equal(c.continue.safe, false);
    assert.equal(c.revalidation.find((r) => r.check === 'task_belongs_to_plan').ok, false);
  });

  test('the reading grants nothing: it writes nothing, runs nothing, and authorizes nothing', () => {
    const { continuation } = reading({});
    assert.equal(continuation.writes, false);
    assert.equal(continuation.runs, false);
    assert.equal(continuation.authorizes, false);
    assert.equal(continuation.historyPreserved, true);
    assert.match(continuation.note, /continues nothing/);
  });

  test('the digest covers the states and the record references, so a moved state moves it and a re-read does not', () => {
    const a = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.RUNNING, { operationId: 'op-1' })],
      operations: [],
    }).continuation;
    const b = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.RUNNING, { operationId: 'op-1' })],
      operations: [stepOp('s1', 'op-1', Outcome.SUCCESS_VERIFIED)],
    }).continuation;
    assert.notEqual(continuationDigest(a), continuationDigest(b), 'a record that resolves the step is a different reading');
    const again = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.RUNNING, { operationId: 'op-1' })],
      operations: [],
    }).continuation;
    assert.equal(continuationDigest(a), continuationDigest(again), 'the same records answer the same way');
    const audit = continuationAudit(a);
    assert.deepEqual(audit.steps, [['s1', 'outcome uncertain', 'running', 'op-1 recorded, no such audit record']]);
    assert.equal(audit.digest, a.digest);
  });

  test('the print names the state, the record it was read from, and the command that would act on it', () => {
    const { continuation } = reading({
      planSteps: [planStep('s1', 'memory.add'), planStep('s2', 'memory.list', ['s1'])],
      taskSteps: [
        taskStep('s1', 'memory.add', StepStatus.UNCERTAIN, { operationId: 'op-1' }),
        taskStep('s2', 'memory.list', StepStatus.PENDING, { dependsOn: ['s1'] }),
      ],
    });
    const text = renderContinuation(continuation);
    assert.match(text, /- s1 \(memory\.add, write\): outcome uncertain/);
    assert.match(text, new RegExp(`read from: tasks ${shortId('fx-task-1')}`));
    assert.match(text, /must not be run again/);
    assert.match(text, new RegExp(`next: task show ${shortId('fx-task-1')}`),
      'the command offered is the one that reads the run whose step cannot be settled');
    assert.match(text, new RegExp(CONTINUATION_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(renderContinuation(null), /No continuation reading was taken/);
  });

  test('the eight interruption boundaries are named, and each states what its records would show', () => {
    assert.deepEqual([...INTERRUPTION_BOUNDARIES].sort(), [
      'after_execution_before_verification', 'after_finalization_before_next_step', 'after_running_recorded',
      'after_step_creation', 'after_verification_before_finalization', 'before_step_creation',
      'between_dependent_steps', 'during_execution',
    ].sort());
    for (const b of INTERRUPTION_BOUNDARIES) {
      assert.ok(BOUNDARY_SIGNATURE[b], `${b} has no stated signature`);
    }
  });

  test('a live plan validity failure is folded into the same answer rather than decided twice', () => {
    const validity = {
      ok: false,
      problems: ['goal fx-goal-1 moved from revision 1 to 2; the plan was written for older criteria'],
      checks: [{ check: 'goal-revision', ok: false, detail: 'plan names goal revision 1, but the goal is revision 2' }],
    };
    const { continuation } = reading({
      taskSteps: [taskStep('s1', 'memory.add', StepStatus.PENDING)],
      planSteps: [planStep('s1', 'memory.add')],
      plan: { goalId: 'fx-goal-1', goalRevision: 1 },
      validity,
    });
    assert.equal(continuation.revalidation.some((r) => r.check === 'validity_goal-revision' && r.ok === false), true);
    assert.equal(continuation.continue.safe, false);
    assert.match(continuation.blockers.join(' '), /goal-revision/);
  });
});

// ---- the eight boundaries, with a real process stopped at each one ------------

const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'continuation-child.mjs');
const RUN_CEILING_MS = 120000;

// Runs the fixture to its chosen boundary and waits for it to exit. The child stops itself, after the
// bytes a kill at that point would leave are durable, and reports where it stopped.
async function runChild(boundary, dataDir, effectFile, shape = 'independent') {
  const child = spawn(process.execPath, [CHILD, boundary, dataDir, effectFile, shape], {
    env: cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  children.push({ child, exited });
  const info = await Promise.race([
    exited,
    new Promise((resolve) => { setTimeout(() => resolve({ code: null, signal: 'ceiling' }), RUN_CEILING_MS); }),
  ]);
  const results = lines(out).filter((l) => l.startsWith('RESULT ')).map((l) => JSON.parse(l.slice(7)));
  if (results.length === 0) {
    throw new Error(`the child at ${boundary} reported nothing (exit ${info.code ?? info.signal}). stdout: ${out} stderr: ${err}`);
  }
  return { info, last: results[results.length - 1], out, err };
}

const effectsOf = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
  : []);

// A second process, reading what the first one left.
async function inspect(dataDir, effectFile, planId) {
  const app = await appIn(dataDir);
  const read = await app.controller.planContinuation(planId);
  return { app, read, continuation: data(read).continuation, effects: effectsOf(effectFile) };
}

describe('AM-D3: a real process stopped at each of the eight boundaries', () => {
  test('1 - stopped before the task existed: the reading says there is no run to continue', async () => {
    const dataDir = dir();
    const effectFile = path.join(dataDir, 'effects.txt');
    const { last } = await runChild('before-step-creation', dataDir, effectFile);
    const planId = last.planId;

    const { app, read } = await inspect(dataDir, effectFile, planId);
    // The reading itself is refused here, and correctly so: there is no run to describe. What the plan
    // record holds is read from the plan store, which is where the absence of an activation lives.
    const plan = await app.plans.get(planId);
    assert.equal(plan.status, PlanStatus.APPROVED);
    assert.equal(plan.activation, null, 'no activation record exists, because no task was created');
    assert.equal(fs.existsSync(effectFile), false, 'no step ran, so no effect may exist');
    assert.equal(read.status, Outcome.INPUT_REJECTED);
    assert.match(display(read), /never activated/);

    const cont = await app.controller.planContinue(planId);
    assert.equal(cont.status, Outcome.INPUT_REJECTED, 'nothing was run, because nothing had ever begun');
    assert.equal(fs.existsSync(effectFile), false);
  });

  test('2 - stopped after the steps were created: every step is proven not to have started', async () => {
    const dataDir = dir();
    const effectFile = path.join(dataDir, 'effects.txt');
    const { last } = await runChild('after-step-creation', dataDir, effectFile);
    const planId = last.planId;
    assert.equal(last.stoppedAt, 'after-task-creation');

    const { continuation, read } = await inspect(dataDir, effectFile, planId);
    assert.equal(continuation.task.status, TaskStatus.PENDING);
    assert.equal(continuation.runState, ContinuationState.NOT_STARTED);
    assert.deepEqual(continuation.continue.runnable, ['s1', 's2']);
    assert.equal(continuation.continue.safe, true);
    assert.match(display(read), /the run is: not started/);

    const app = await appIn(dataDir);
    const cont = await app.controller.planContinue(planId);
    assert.equal(cont.status, Outcome.PLAN_STORED, cont.display);
    assert.deepEqual(cont.ran, ['s1', 's2']);
    assert.deepEqual(effectsOf(effectFile), ['note-1', 'read:note-2']);
  });

  test('3 - stopped after the running state was recorded: uncertain, and not taken up again', async () => {
    const dataDir = dir();
    const effectFile = path.join(dataDir, 'effects.txt');
    const { last } = await runChild('after-running-recorded', dataDir, effectFile);
    const planId = last.planId;

    const { continuation, effects } = await inspect(dataDir, effectFile, planId);
    const s1 = row(continuation, 's1');
    assert.equal(s1.recordedStatus, StepStatus.RUNNING);
    assert.equal(s1.state, ContinuationState.OUTCOME_UNCERTAIN);
    assert.equal(s1.boundary, INTERRUPTION_BOUNDARY.AFTER_RUNNING_RECORDED);
    assert.deepEqual(effects, [], 'the side-effect file is empty - and the reading still cannot conclude that');
    assert.match(s1.why, /not recorded either way/);
    assert.equal(continuation.continue.safe, false);
    assert.deepEqual(continuation.continue.neverReplay, ['s1']);
    assert.equal(row(continuation, 's2').state, ContinuationState.SAFE_TO_CONTINUE,
      'the independent step is proven never to have begun, even though the run as a whole is not safe');

    const app = await appIn(dataDir);
    const cont = await app.controller.planContinue(planId);
    assert.equal(cont.status, Outcome.INPUT_REJECTED, 'a run with an unresolvable step is not taken up past it');
    assert.deepEqual(effectsOf(effectFile), [], 'the refusal ran nothing');
    assert.match(display(cont), /nothing was taken up/);
    assert.match(display(cont), /outcome uncertain/);
  });

  test('4, 5 and 6 - lost during execution, before verification, and before the audit append: one state, because the records are one state', async () => {
    // The comparison is over what the reading claims, not over its digest: each child writes its own
    // plan and task ids, and a digest that covers record references is supposed to move with them.
    const shapeOf = (c) => ({
      runState: c.runState,
      steps: c.steps.map((s) => [s.id, s.state, s.recordedStatus, s.boundary, s.mayRun, s.neverReplay === true]),
      mayTakeUp: c.continue,
      revalidation: c.revalidation.map((r) => [r.check, r.ok]),
    });
    const shapes = [];
    for (const boundary of ['during-execution', 'after-execution-before-verification', 'after-verification-before-finalization']) {
      const dataDir = dir();
      const effectFile = path.join(dataDir, 'effects.txt');
      const { last } = await runChild(boundary, dataDir, effectFile);
      const { continuation, effects } = await inspect(dataDir, effectFile, last.planId);
      const s1 = row(continuation, 's1');
      assert.deepEqual(effects, ['note-1'], `${boundary}: the effect happened, and the file is the only evidence of it`);
      assert.equal(s1.state, ContinuationState.OUTCOME_UNCERTAIN, boundary);
      assert.equal(s1.boundary, INTERRUPTION_BOUNDARY.AFTER_RUNNING_RECORDED,
        `${boundary}: the records do not say where inside the step the process went`);
      assert.equal(continuation.continue.safe, false, boundary);
      assert.deepEqual(continuation.continue.neverReplay, ['s1'], boundary);
      const app = await appIn(dataDir);
      const cont = await app.controller.planContinue(last.planId);
      assert.equal(cont.status, Outcome.INPUT_REJECTED, boundary);
      assert.deepEqual(effectsOf(effectFile), ['note-1'], `${boundary}: the refusal produced no second effect`);
      shapes.push(shapeOf(continuation));
    }
    // The finding the batch asked to be stated rather than smoothed over: three different kill points
    // leave byte-identical records, so three different claims would be inventions.
    assert.deepEqual(shapes[1], shapes[0], 'boundaries 4 and 5 are read identically, because their records are identical');
    assert.deepEqual(shapes[2], shapes[0], 'boundaries 4 and 6 are read identically, because their records are identical');
  });

  test('6 - stopped after verification but before finalization: no record claims the step, and none is assumed absent', async () => {
    const dataDir = dir();
    const effectFile = path.join(dataDir, 'effects.txt');
    const { last } = await runChild('after-verification-before-finalization', dataDir, effectFile);
    const { app, continuation } = await inspect(dataDir, effectFile, last.planId);
    assert.equal(row(continuation, 's1').state, ContinuationState.OUTCOME_UNCERTAIN);
    const audit = await app.operations.inspect();
    assert.equal(audit.records.filter((r) => r.capability === 'task.step').length, 0,
      'the absence of a record is reported as an absence, never as the absence of an effect');
    const task = await app.taskStore.get(continuation.task.id);
    assert.equal(task.steps[0].status, StepStatus.RUNNING, 'the task log still holds the step as running');
  });

  test('7 - stopped after finalization but before the next step: the audit resolves it and it is not run again', async () => {
    const dataDir = dir();
    const effectFile = path.join(dataDir, 'effects.txt');
    const { last } = await runChild('after-finalization-before-next-step', dataDir, effectFile);
    const planId = last.planId;

    const { continuation, effects } = await inspect(dataDir, effectFile, planId);
    assert.deepEqual(effects, ['note-1']);
    const s1 = row(continuation, 's1');
    assert.equal(s1.state, ContinuationState.VERIFIED_SUCCESSFUL);
    assert.equal(s1.boundary, INTERRUPTION_BOUNDARY.AFTER_VERIFICATION_BEFORE_FINALIZATION);
    assert.equal(s1.resolvableFromAudit, true);
    assert.match(s1.why, /the task log still shows it running/);
    assert.equal(row(continuation, 's2').state, ContinuationState.SAFE_TO_CONTINUE);
    assert.equal(continuation.continue.safe, true);

    const app = await appIn(dataDir);
    const cont = await app.controller.planContinue(planId);
    assert.equal(cont.status, Outcome.PLAN_STORED, cont.display);
    assert.deepEqual(cont.ran, ['s2'], 'only the step that never started');
    assert.deepEqual(effectsOf(effectFile), ['note-1', 'read:note-2'], 'note-1 appears exactly once');
  });

  test('8 - stopped between two dependent steps: the dependent step is proven not to have started', async () => {
    const dataDir = dir();
    const effectFile = path.join(dataDir, 'effects.txt');
    const { last } = await runChild('between-dependent-steps', dataDir, effectFile, 'dependent');
    const planId = last.planId;

    const { continuation, effects } = await inspect(dataDir, effectFile, planId);
    assert.deepEqual(effects, ['note-1']);
    assert.equal(row(continuation, 's1').state, ContinuationState.VERIFIED_SUCCESSFUL);
    assert.equal(row(continuation, 's2').state, ContinuationState.SAFE_TO_CONTINUE);
    assert.deepEqual(continuation.continue.runnable, ['s2']);
    assert.equal(continuation.continue.safe, true);

    const app = await appIn(dataDir);
    const cont = await app.controller.planContinue(planId);
    assert.equal(cont.status, Outcome.PLAN_STORED, cont.display);
    assert.deepEqual(cont.ran, ['s2']);
    assert.deepEqual(effectsOf(effectFile), ['note-1', 'read:note-2']);
    const after = data(await app.controller.planContinuation(planId)).continuation;
    assert.equal(after.runState, ContinuationState.VERIFIED_SUCCESSFUL);
    assert.equal(after.plan.status, PlanStatus.COMPLETED);
  });

  test('a second continuation of a run that finished takes up nothing and produces no second effect', async () => {
    const dataDir = dir();
    const effectFile = path.join(dataDir, 'effects.txt');
    const { last } = await runChild('after-step-creation', dataDir, effectFile);
    const app = await appIn(dataDir);
    const first = await app.controller.planContinue(last.planId);
    assert.equal(first.status, Outcome.PLAN_STORED, first.display);
    const afterFirst = effectsOf(effectFile);
    const second = await app.controller.planContinue(last.planId);
    assert.equal(second.status, Outcome.INPUT_REJECTED, 'a settled run has nothing left to take up');
    assert.deepEqual(effectsOf(effectFile), afterFirst);
  });

  test('an interrupted write is never produced a second time, and its dependent is not run on an assumption', async () => {
    const dataDir = dir();
    const effectFile = path.join(dataDir, 'effects.txt');
    const { last } = await runChild('during-execution', dataDir, effectFile, 'dependent');
    const app = await appIn(dataDir);
    const before = effectsOf(effectFile);
    const cont = await app.controller.planContinue(last.planId);
    assert.equal(cont.status, Outcome.INPUT_REJECTED);
    assert.deepEqual(effectsOf(effectFile), before, 'the uncertain write was not repeated');
    const { continuation } = await inspect(dataDir, effectFile, last.planId);
    assert.equal(row(continuation, 's2').state, ContinuationState.BLOCKED,
      'and the step behind it is not treated as work waiting on nothing');
  });
});

describe('AM-D4: the whole path through the real stores', () => {
  async function activatedPlan(app, steps) {
    const created = await app.controller.goalAdd({
      request: 'put the AM continuation notes in the record',
      criteria: [
        { description: 'the first note is recorded', basis: 'user_stated' },
        { description: 'the second note is recorded', basis: 'user_stated' },
      ],
    });
    const goalId = data(created).goalId;
    for (const status of ['accepted', 'active']) {
      await app.controller.goalUpdate({ target: goalId, status });
    }
    const add = await app.controller.planAdd({ goalId, outcome: 'both notes are recorded', steps });
    const planId = data(add).planId;
    await app.controller.planApprove({ target: planId });
    return { planId, goalId };
  }

  const step = (id, action, input, dependsOn = []) => ({
    id,
    description: `the ${id} step`,
    action,
    input,
    dependsOn,
    expectedResult: 'the record holds it',
    verification: 'the action re-checks its own result',
    // The registry's own rule reaches the plan model: a write step may not be classified low risk, so
    // an fixture that filed one would be refused before any continuation question came up.
    risk: action === 'memory.add' ? 'medium' : 'low',
    criterionId: id === 's1' ? 'c1' : 'c2',
  });

  test('the continuation read writes nothing: every store it could have changed is byte for byte unchanged', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    // A run that stopped on its own failure, so the reading has a step left to take up: a read of a
    // settled plan would prove less, because there would be nothing for the answer to be about.
    const { planId } = await activatedPlan(app, [
      step('s1', 'calc.evaluate', { expression: '1/0' }),
      step('s2', 'memory.add', { content: 'the AM continuation read note' }),
    ]);
    const start = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(start.status, Outcome.EXECUTION_FAILED, start.display);
    const sizes = () => Object.fromEntries(fs.readdirSync(dataDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => [f, fs.readFileSync(path.join(dataDir, f), 'utf8').split('\n').filter((l) => l !== '').length]));
    const before = sizes();
    const read = await app.controller.planContinuation(planId);
    assert.equal(read.status, Outcome.SUCCESS_VERIFIED, read.display);
    const after = sizes();
    // Only the audit log grows: a read is allowed to record that it answered. The plan, task, goal and
    // memory stores must be exactly what they were, or the read would be a write wearing a question.
    for (const [file, count] of Object.entries(after)) {
      if (file === 'operations.jsonl' || file === 'conversation.jsonl') continue;
      assert.equal(count, before[file] ?? 0, `${file} changed during a read-only continuation`);
    }
    assert.equal((await app.memory.list()).length, 0, 'the read ran no step');
  });

  test('a plan that never ran is started, not continued, and the reading names the command that fits', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const { planId } = await activatedPlan(app, [
      step('s1', 'memory.add', { content: 'the AM continuation start note' }),
      step('s2', 'memory.list', {}, ['s1']),
    ]);
    const read = await app.controller.planContinuation(planId);
    assert.equal(read.status, Outcome.INPUT_REJECTED);
    assert.match(display(read), /never activated/);
    assert.match(display(read), /plan start/);
    const started = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(started.status, Outcome.SUCCESS_VERIFIED, started.display);
    assert.equal((await app.memory.list()).length, 1);
  });

  test('a run that failed on one step still takes up the independent step that never started', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    // s1 divides by zero and fails; s2 is an independent write the failure never reached.
    const { planId } = await activatedPlan(app, [
      step('s1', 'calc.evaluate', { expression: '1/0' }),
      step('s2', 'memory.add', { content: 'the AM continuation independent note' }),
    ]);
    const start = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(start.status, Outcome.EXECUTION_FAILED, start.display);

    const before = data(await app.controller.planContinuation(planId)).continuation;
    assert.equal(row(before, 's1').state, ContinuationState.VERIFIED_FAILED);
    assert.equal(row(before, 's2').state, ContinuationState.SAFE_TO_CONTINUE);
    assert.equal(before.continue.safe, true, 'a failure the records establish does not freeze work the records prove untouched');

    const cont = await app.controller.planContinue(planId);
    assert.deepEqual(cont.ran, ['s2'], 'the step the failure never touched is the step taken up');
    assert.equal(cont.status, Outcome.EXECUTION_FAILED, 'and the run is still not reported as a success it did not achieve');
    assert.equal((await app.memory.list()).length, 1, 'it ran exactly once');

    const after = data(await app.controller.planContinuation(planId)).continuation;
    assert.equal(row(after, 's2').state, ContinuationState.VERIFIED_SUCCESSFUL);
    assert.equal(row(after, 's1').state, ContinuationState.VERIFIED_FAILED);
    assert.equal(after.continue.runnable.length, 0);
    const again = await app.controller.planContinue(planId);
    assert.equal(again.status, Outcome.INPUT_REJECTED);
    assert.equal((await app.memory.list()).length, 1, 'a second continuation produced no second write');
  });

  test('a continuation records its own audited answer and leaves the history it found', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const { planId } = await activatedPlan(app, [
      step('s1', 'calc.evaluate', { expression: '1/0' }),
      step('s2', 'memory.add', { content: 'the AM continuation history note' }),
    ]);
    await app.controller.planActivate(planId, { mode: 'run' });
    const plansFile = path.join(dataDir, 'plans.jsonl');
    const before = fs.readFileSync(plansFile, 'utf8').split('\n').filter((l) => l !== '');
    const cont = await app.controller.planContinue(planId);
    assert.equal(cont.status, Outcome.EXECUTION_FAILED, cont.display);

    const after = fs.readFileSync(plansFile, 'utf8').split('\n').filter((l) => l !== '');
    assert.ok(after.length > before.length, 'the plan log grew');
    assert.deepEqual(after.slice(0, before.length), before, 'nothing already written was rewritten');
    const plan = await app.plans.get(planId);
    assert.equal(plan.history.some((h) => h.kind === 'outcome'), true,
      'the steps this continuation established are recorded as outcomes');

    const audit = await app.operations.inspect();
    const mine = audit.records.filter((r) => r.capability === 'plan.continue');
    assert.equal(mine.length, 1, 'one audited answer for one continuation');
    assert.equal(mine[0].status, Outcome.EXECUTION_FAILED, 'the run is not reported as a success it did not achieve');
    assert.equal(mine[0].steps.some((s) => s.action === 'plan.continue'), true);
    const recorded = JSON.stringify(mine[0]);
    assert.match(recorded, /"before"/, 'the audit line carries what the continuation refused to replay');
    assert.match(recorded, /"ran"/);
  });

  test('a recorded expectation moves no state: continuation comes from run records', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const { planId } = await activatedPlan(app, [
      step('s1', 'memory.add', { content: 'the AM continuation prediction note' }),
      step('s2', 'memory.list', {}, ['s1']),
    ]);
    await app.controller.planActivate(planId, { mode: 'run' });
    const first = data(await app.controller.planContinuation(planId)).continuation;
    await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success', subject: 'the continuation note is stored', inDays: 3,
    });
    const second = data(await app.controller.planContinuation(planId)).continuation;
    assert.equal(second.digest, first.digest, 'an expectation about a later event is not evidence about this run');
    assert.equal(first.runState, ContinuationState.VERIFIED_SUCCESSFUL);
  });

  test('a blocker the user records after approval keeps the untouched step from being taken up', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const { planId, goalId } = await activatedPlan(app, [
      step('s1', 'calc.evaluate', { expression: '1/0' }),
      step('s2', 'memory.add', { content: 'the AM continuation blocked note' }),
    ]);
    await app.controller.planActivate(planId, { mode: 'run' });
    const clean = data(await app.controller.planContinuation(planId)).continuation;
    assert.equal(clean.continue.safe, true, 'before the blocker is recorded, the independent step may be taken up');

    // goal.revise is the user's own command for putting an obstacle on the record after the approval,
    // and it moves the goal revision as it does so. The continuation reports both facts, because both
    // are in the records: the gate on the step and the revision the approval was bound against.
    const blocked = await app.controller.goalRevise({
      target: goalId,
      criteria: ['the first note is recorded', 'the second note is recorded'],
      blockers: [{ text: 'memory.add is disabled on this machine', basis: 'user_stated' }],
      reason: 'the memory store is disabled on this machine',
    });
    assert.equal(blocked.status, Outcome.GOAL_UPDATED, blocked.display ?? blocked.output);

    const c = data(await app.controller.planContinuation(planId)).continuation;
    assert.equal(row(c, 's2').state, ContinuationState.BLOCKED);
    assert.deepEqual(row(c, 's2').gates, ['confirmed_blocker']);
    assert.equal(c.continue.safe, false);
    const cont = await app.controller.planContinue(planId);
    assert.equal(cont.status, Outcome.INPUT_REJECTED, 'a recorded obstacle is not continued past');
    assert.match(display(cont), /confirmed_blocker/);
    assert.equal((await app.memory.list()).length, 0, 'and nothing was written');
  });

  test('two reads of the same records answer the same way, inside the bound', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const { planId } = await activatedPlan(app, [
      step('s1', 'memory.add', { content: 'the AM continuation determinism note' }),
      step('s2', 'memory.list', {}, ['s1']),
    ]);
    await app.controller.planActivate(planId, { mode: 'run' });
    const first = await app.controller.planContinuation(planId);
    const second = await app.controller.planContinuation(planId);
    assert.equal(data(first).continuation.digest, data(second).continuation.digest);
    assert.equal(display(first), display(second));
    assert.ok(lines(display(first)).length < 70, `the answer is bounded: ${lines(display(first)).length} lines`);
    assert.ok(display(first).length < 14000, `the answer is bounded: ${display(first).length} characters`);
    assert.match(display(first), /this read continues nothing/);
  });

  test('the CLI carries both verbs, and a continuation with no plan is a usage error', async () => {
    const dataDir = dir();
    const app = await appIn(dataDir);
    const { planId } = await activatedPlan(app, [
      step('s1', 'calc.evaluate', { expression: '1/0' }),
      step('s2', 'memory.add', { content: 'the AM continuation CLI note' }),
    ]);
    await app.controller.planActivate(planId, { mode: 'run' });
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });

    const read = await runCli(['plan', 'continuation', shortId(planId)], env);
    assert.equal(read.code, 0, read.stderr);
    assert.match(read.stdout, /Continuation of plan /);
    assert.match(read.stdout, /the run is: /);
    assert.match(read.stdout, /- s1 \(calc\.evaluate, read\): verified failed/);

    // The continuation ran the step that never started, and the run as a whole still did not complete:
    // s1's established failure stands in the records. The exit code reports that failure rather than
    // the continuation's own part in it, which is the same contract `plan start` uses.
    const used = await runCli(['plan', 'continue', shortId(planId)], env);
    assert.equal(used.code, 1, `${used.stdout}\n${used.stderr}`);
    assert.match(used.stdout, /continued plan /);
    assert.match(used.stdout, /1 step\(s\) taken up \(s2\)/);

    const missing = await runCli(['plan', 'continue'], env);
    assert.notEqual(missing.code, 0, 'a continuation without a plan is a usage error');
    assert.match(missing.stderr + missing.stdout, /usage: plan continue <id>/);
  });

  test('nine states in one reading, and the states that stop a continuation survive the bound', () => {
    const { continuation } = reading({
      planSteps: [
        planStep('s1', 'memory.add'), planStep('s2', 'memory.add'), planStep('s3', 'memory.list'),
        planStep('s4', 'memory.list', ['s3']), planStep('s5', 'calc.evaluate'), planStep('s6', 'memory.add'),
      ],
      taskSteps: [
        taskStep('s1', 'memory.add', StepStatus.COMPLETED, { operationId: 'op-1' }),
        taskStep('s2', 'memory.add', StepStatus.UNCERTAIN, { operationId: 'op-2' }),
        taskStep('s3', 'memory.list', StepStatus.RUNNING, { operationId: 'op-3' }),
        taskStep('s4', 'memory.list', StepStatus.PENDING, { dependsOn: ['s3'] }),
        taskStep('s5', 'calc.evaluate', StepStatus.FAILED, { operationId: 'op-5', outcome: Outcome.EXECUTION_FAILED }),
        taskStep('s6', 'memory.add', StepStatus.AWAITING_APPROVAL),
      ],
      operations: [
        stepOp('s1', 'op-1', Outcome.SUCCESS_VERIFIED),
        stepOp('s3', 'op-3', Outcome.VERIFICATION_UNAVAILABLE),
        stepOp('s5', 'op-5', Outcome.EXECUTION_FAILED),
      ],
    });
    assert.deepEqual(continuation.steps.map((s) => [s.id, s.state]), [
      ['s1', ContinuationState.VERIFIED_SUCCESSFUL],
      ['s2', ContinuationState.OUTCOME_UNCERTAIN],
      ['s3', ContinuationState.OUTCOME_UNCERTAIN],
      ['s4', ContinuationState.BLOCKED],
      ['s5', ContinuationState.VERIFIED_FAILED],
      ['s6', ContinuationState.AWAITING_CONFIRMATION],
    ]);
    assert.equal(continuation.runState, ContinuationState.REQUIRES_USER,
      'the state a reader has to act on comes first: an uncertain write is nobody else\'s to settle');
    assert.deepEqual(continuation.continue.neverReplay, ['s2'],
      'the one step no attempt may be repeated for is the write whose effect cannot be established');
    assert.deepEqual(continuation.continue.retryableReads, ['s3', 's5'],
      'the reads have a stated route - the user\'s own retry - so they are not in the never-replay set');
    assert.equal(continuation.continue.safe, false);
    const text = renderContinuation(continuation);
    for (const state of [ContinuationState.OUTCOME_UNCERTAIN, ContinuationState.AWAITING_CONFIRMATION]) {
      assert.equal(text.includes(state), true, `${state} was cut from the answer`);
    }
  });
});
