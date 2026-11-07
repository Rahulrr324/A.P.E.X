// Batch AM, work package H: the executive continuation ranking, and the seven answers to "can this be
// taken up now?".
//
// Batch AL ranked recorded work and could state four readiness answers about it. Batch D added a
// derivation that reads a partially executed run and states which of its steps may be taken up; this
// package makes that answer reach the two places a user actually looks - the ranking `work` and `next`
// print, and the readiness answer a question in the conversation gets - and adds the seventh readiness
// state, `ready to continue`, which is the difference between a run that never began and a run that
// stopped with provably untouched steps left in it.
//
// The rules these tests exist to prove:
//   - A readiness state is read from a record and names it. The new state is read from the continuation
//     derivation, because a plan status and a task status cannot show that a step never started. Where
//     no derivation was read, no continuation is claimed and the older states stand.
//   - The ranking is read-only. It starts nothing, writes nothing and runs no process: the command it
//     prints is taken up by the user, and the registry decides authorization again when each step runs.
//   - One run, one ranking place. `plan continue` and `task resume` describe the same interrupted run,
//     so the ranking prints the one that re-validates the approval, the registry and the constraints,
//     and lists the other as excluded with the reason.
//   - The ordering is deterministic: the same records give the same candidates in the same order.
//
// Synthetic fixtures throughout. The gateway is the no-backend one, experience capture is off, no model
// is contacted and no inference runs. The real-store section stops a real child process with the same
// fixture work package D used, so the interruption is left on disk rather than described.
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
import { continuationOf } from '../src/plans/continuation.js';
import { buildContinuation, renderContinuation } from '../src/continuation/engine.js';
import { readinessOf, renderReadiness, prioritizationFactors } from '../src/executive/readiness.js';
import {
  BOUNDS, ContinuationReadiness, READINESS_BASIS, READINESS_STATES,
} from '../src/executive/vocabulary.js';
import { shortId } from '../src/util.js';
import { makeTempDataDir, cleanup, cleanEnv, APP_ROOT } from './helpers.js';

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

const data = (res) => res?.operation?.steps?.[0]?.result?.data ?? res?.result?.data ?? {};
const display = (res) => String(res?.display ?? res?.output ?? '');
const lines = (text) => String(text ?? '').split('\n');

// ---- the records the two readers share --------------------------------------

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

// The approval binds the bytes the fixture plan actually holds, because that binding is what a
// continuation re-reads and a fixture that faked it would prove nothing about the check.
function fixturePlan(planSteps, over = {}) {
  const plan = {
    id: 'fx-plan-1',
    goalId: null,
    goalRevision: null,
    origin: 'user',
    version: 1,
    status: PlanStatus.ACTIVE,
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
  return { id: 'fx-task-1', planId: 'fx-plan-1', status: TaskStatus.PAUSED, origin: 'user', steps, ...over };
}

const stepOp = (stepId, id, status) => ({
  id, capability: 'task.step', task: { id: 'fx-task-1', stepId }, status, steps: [], errors: [],
});

const NO_LOCK = { present: false, pid: null, alive: false };
const LIVE_LOCK = { present: true, pid: 424242, alive: true };

// A goal with nothing recorded against it, so the constraint gate answers "none able to stop work"
// rather than "no ledger was read".
function emptyLedger(goalId = 'fx-goal-1') {
  return constraintLedger({
    goal: {
      id: goalId, revision: 1, status: 'active', criteria: [], prerequisites: [], blockers: [],
      constraints: [], resources: [], timeConditions: [], unknowns: [], dependsOn: [],
    },
    registry,
  });
}

// One pair of readers over the same records: the derivation first, then the readiness state it
// supports. Every claim a test makes about readiness is therefore made against a reading APEX produces.
function pair(input = {}) {
  const {
    planSteps = [planStep('s1', 'memory.add'), planStep('s2', 'memory.list')],
    taskSteps = [taskStep('s1', 'memory.add', StepStatus.PENDING), taskStep('s2', 'memory.list', StepStatus.PENDING)],
    plan: planOver = {},
    task: taskOver = {},
    operations = [],
    lock = NO_LOCK,
    auditReadable = true,
    constraints = emptyLedger(),
    reg = registry,
    validity = null,
    assessment = null,
  } = input;
  const plan = fixturePlan(planSteps, planOver);
  const task = fixtureTask(taskSteps, taskOver);
  const continuation = continuationOf({
    plan, task, operations, registry: reg, constraints, validity, lock, auditReadable, now: CLOCK(),
  });
  return {
    plan, task, continuation,
    reading: readinessOf({ plan, task, validity, assessment, continuation }),
  };
}

const factorText = (reading) => reading.factors.map((f) => `${f.factor} [from: ${f.readFrom}]`).join('\n');

describe('AM-H1: seven answers, each with the record it is read from', () => {
  test('the readiness vocabulary holds seven distinct states, each naming a record', () => {
    assert.deepEqual([...READINESS_STATES].sort(), [
      'blocked', 'not feasible', 'ready for approval', 'ready to continue', 'ready to execute',
      'requires clarification', 'waiting for evidence',
    ].sort());
    assert.equal(new Set(READINESS_STATES).size, 7);
    for (const state of READINESS_STATES) {
      assert.ok(READINESS_BASIS[state], `${state} names no record it could be read from`);
    }
    assert.match(READINESS_BASIS[ContinuationReadiness.READY_TO_CONTINUE], /interrupted/);
    const others = READINESS_STATES.filter((s) => s !== ContinuationReadiness.READY_TO_CONTINUE);
    for (const state of others) {
      assert.notEqual(READINESS_BASIS[state], READINESS_BASIS[ContinuationReadiness.READY_TO_CONTINUE]);
    }
  });

  test('each state is answered by the command that fits it, and only the continuation state offers plan continue', () => {
    const cases = [
      {
        name: ContinuationReadiness.READY_TO_EXECUTE,
        input: { plan: fixturePlan([planStep('s1', 'memory.list')], { status: PlanStatus.APPROVED }) },
        expect: `node bin/apex.js plan start ${shortId('fx-plan-1')}`,
      },
      {
        name: ContinuationReadiness.READY_FOR_APPROVAL,
        input: { plan: fixturePlan([planStep('s1', 'memory.list')], { status: PlanStatus.DRAFT }) },
        expect: `node bin/apex.js plan approve ${shortId('fx-plan-1')}`,
      },
      {
        name: ContinuationReadiness.BLOCKED,
        input: { plan: fixturePlan([planStep('s1', 'memory.list')], { status: PlanStatus.BLOCKED, blockedReason: 'a step failed' }) },
        expect: `node bin/apex.js plan validate ${shortId('fx-plan-1')}`,
      },
      {
        name: ContinuationReadiness.WAITING_FOR_EVIDENCE,
        input: {
          plan: fixturePlan([planStep('s1', 'memory.list')]),
          task: fixtureTask([taskStep('s1', 'memory.list', StepStatus.PENDING)]),
        },
        expect: `node bin/apex.js plan outcome ${shortId('fx-plan-1')}`,
      },
      {
        name: ContinuationReadiness.NOT_FEASIBLE,
        input: {
          plan: fixturePlan([planStep('s1', 'memory.list')], { status: PlanStatus.APPROVED }),
          validity: {
            ok: false,
            problems: ['the registry no longer holds the capability'],
            checks: [{ check: 'capabilities', ok: false, detail: 'the registry no longer holds the capability' }],
          },
        },
        expect: 'node bin/apex.js plan list',
      },
      {
        name: ContinuationReadiness.REQUIRES_CLARIFICATION,
        input: {
          goal: {
            id: 'fx-goal-9', status: 'active', criteria: [{ description: 'c1', status: 'pending' }],
            priority: null, deadline: null, blockers: [],
          },
          comparison: {
            ok: true, front: ['steady', 'faster'], excluded: [], tradeOffs: ['neither dominates'],
            ties: [], whatWouldSettleIt: [],
          },
        },
        expect: `node bin/apex.js plan candidates ${shortId('fx-goal-9')}`,
      },
    ];
    for (const testCase of cases) {
      const reading = readinessOf(testCase.input);
      assert.equal(reading.readiness, testCase.name, `${testCase.name} was not derived from its own records`);
      assert.equal(reading.next, testCase.expect, `the command offered for ${testCase.name}`);
    }

    const continuable = pair();
    assert.equal(continuable.reading.readiness, ContinuationReadiness.READY_TO_CONTINUE);
    assert.equal(
      continuable.reading.next,
      `node bin/apex.js plan continue ${shortId('fx-plan-1')}`,
      'the continuation state is the only one that offers the continuation command',
    );
    assert.equal(continuable.reading.nextIsRead, false, 'taking the run up is an act on a record, not a read');
  });

  test('the readiness view prints the state, its factors with their records, and the rule over it', () => {
    const { reading } = pair();
    const text = renderReadiness(reading);
    assert.match(text, /Readiness: ready to continue\./);
    assert.match(text, new RegExp(`to take it up: node bin/apex\\.js plan continue ${shortId('fx-plan-1')}`));
    for (const f of reading.factors.slice(0, BOUNDS.maxListedRecords)) {
      assert.ok(f.readFrom, 'a factor is printed without the record it was read from');
    }
    assert.match(text, /not a forecast that a run will succeed/);
    assert.match(renderReadiness(null), /No readiness reading was derived\./);
  });

  test('a closed plan and a candidate-only read state no continuation', () => {
    const done = fixturePlan([planStep('s1', 'memory.list')], { status: PlanStatus.COMPLETED });
    const closed = readinessOf({
      plan: done,
      task: fixtureTask([taskStep('s1', 'memory.list', StepStatus.COMPLETED, { operationId: 'op-1' })]),
      operations: [stepOp('s1', 'op-1', Outcome.SUCCESS_VERIFIED)],
    });
    assert.equal(closed.readiness, null);
    assert.match(closed.basis, /closed as completed/);

    const noPlan = readinessOf({
      comparison: { ok: true, front: ['steady'], excluded: [], tradeOffs: [], ties: [], whatWouldSettleIt: [] },
    });
    assert.equal(noPlan.noPlanRecord, true);
    assert.match(noPlan.next, /plan candidates/, 'a command naming a plan nobody wrote is not offered');
  });
});

describe('AM-H2: the seventh state is read from the derivation, and the refusals are read too', () => {
  test('a run stopped before any step began names the steps its own records prove untouched', () => {
    const { reading, continuation } = pair();
    assert.equal(continuation.runState, 'not started');
    assert.deepEqual(continuation.continue.runnable, ['s1', 's2']);
    assert.equal(reading.readiness, ContinuationReadiness.READY_TO_CONTINUE);
    assert.match(factorText(reading), /2 step\(s\) its records prove never started - s1, s2/);
    assert.match(factorText(reading), /revalidation check/);
  });

  test('a step proven untouched beside one already verified still reads as ready to continue', () => {
    const { reading, continuation } = pair({
      taskSteps: [
        taskStep('s1', 'memory.list', StepStatus.COMPLETED, { operationId: 'op-1' }),
        taskStep('s2', 'memory.add', StepStatus.PENDING),
      ],
      operations: [stepOp('s1', 'op-1', Outcome.SUCCESS_VERIFIED)],
    });
    assert.equal(continuation.counts['verified successful'], 1);
    assert.equal(reading.readiness, ContinuationReadiness.READY_TO_CONTINUE);
    assert.match(factorText(reading), /s2/);
  });

  test('a write whose effect cannot be established is not taken up, and the answer says what stopped it', () => {
    const { reading, continuation } = pair({
      taskSteps: [
        taskStep('s1', 'memory.add', StepStatus.RUNNING, { operationId: 'op-1' }),
        taskStep('s2', 'memory.list', StepStatus.PENDING),
      ],
      operations: [],
    });
    assert.equal(continuation.continue.safe, false);
    assert.deepEqual(continuation.continue.neverReplay, ['s1']);
    assert.notEqual(reading.readiness, ContinuationReadiness.READY_TO_CONTINUE);
    assert.equal(reading.readiness, ContinuationReadiness.WAITING_FOR_EVIDENCE);
    assert.match(factorText(reading), /refuses to take the run up/);
    assert.equal(reading.next, `node bin/apex.js plan outcome ${shortId('fx-plan-1')}`,
      'the command offered reads the outcome; none offered here would replay the write');
  });

  test('bytes the approval no longer binds are handed back, and the state reads as blocked', () => {
    // The approval was taken over one step and the plan now holds two, so the bytes the run stopped at
    // are no longer the bytes the approval binds. That is the derivation's own refusal, and the fresh
    // approval is what is owed - not a continuation.
    const plan = fixturePlan([planStep('s1', 'memory.list')]);
    plan.steps = [planStep('s1', 'memory.list'), planStep('s2', 'memory.list')];
    const task = fixtureTask([
      taskStep('s1', 'memory.list', StepStatus.PENDING),
      taskStep('s2', 'memory.list', StepStatus.PENDING),
    ]);
    const continuation = continuationOf({
      plan, task, operations: [], registry, constraints: emptyLedger(), validity: null, lock: NO_LOCK,
      auditReadable: true, now: CLOCK(),
    });
    assert.equal(continuation.plan.approval.bound, false);
    assert.equal(continuation.continue.safe, false);
    assert.ok(continuation.continue.requiresUser.length > 0);
    const reading = readinessOf({ plan, task, continuation });
    assert.notEqual(reading.readiness, ContinuationReadiness.READY_TO_CONTINUE);
    assert.equal(reading.readiness, ContinuationReadiness.BLOCKED);
    assert.match(factorText(reading), /no longer binds the bytes|refuses to take the run up/);
    assert.equal(reading.next, `node bin/apex.js plan validate ${shortId('fx-plan-1')}`,
      'the command offered re-reads the approval rather than taking the run up');
  });

  test('a live process holding the run owns it: untouched steps do not make the work continuable', () => {
    const { reading, continuation } = pair({ lock: LIVE_LOCK });
    assert.equal(continuation.continue.safe, true, 'the derivation does prove the steps untouched');
    assert.notEqual(reading.readiness, ContinuationReadiness.READY_TO_CONTINUE);
    assert.equal(reading.readiness, ContinuationReadiness.WAITING_FOR_EVIDENCE);
    assert.match(factorText(reading), /a live process holds the task lock/);
  });

  test('an unreadable audit log leaves the run unresolved rather than safe', () => {
    const { reading, continuation } = pair({
      taskSteps: [
        taskStep('s1', 'memory.add', StepStatus.RUNNING, { operationId: 'op-1' }),
        taskStep('s2', 'memory.list', StepStatus.PENDING),
      ],
      operations: null,
      auditReadable: false,
    });
    assert.equal(continuation.continue.safe, false);
    assert.notEqual(reading.readiness, ContinuationReadiness.READY_TO_CONTINUE);
    assert.match(factorText(reading), /audit/);
  });

  test('a reading of a different plan says nothing about this one, and the answer discloses that', () => {
    const plan = fixturePlan([planStep('s1', 'memory.list')]);
    const task = fixtureTask([taskStep('s1', 'memory.list', StepStatus.PENDING)]);
    const foreign = continuationOf({
      plan: fixturePlan([planStep('s1', 'memory.list')], { id: 'fx-other-9' }),
      task: fixtureTask([taskStep('s1', 'memory.list', StepStatus.PENDING)], { id: 'fx-task-9', planId: 'fx-other-9' }),
      operations: [], registry, constraints: emptyLedger(), validity: null, lock: NO_LOCK,
      auditReadable: true, now: CLOCK(),
    });
    const reading = readinessOf({ plan, task, continuation: foreign });
    assert.notEqual(reading.readiness, ContinuationReadiness.READY_TO_CONTINUE);
    assert.match(factorText(reading), new RegExp(`not ${shortId('fx-plan-1')}, so it says nothing about this plan`));
  });

  test('no derivation, no claim: the same records read as waiting for evidence', () => {
    const plan = fixturePlan([planStep('s1', 'memory.add'), planStep('s2', 'memory.list')]);
    const task = fixtureTask([
      taskStep('s1', 'memory.add', StepStatus.PENDING),
      taskStep('s2', 'memory.list', StepStatus.PENDING),
    ]);
    const bare = readinessOf({ plan, task });
    assert.equal(bare.readiness, ContinuationReadiness.WAITING_FOR_EVIDENCE);
    const withReading = readinessOf({
      plan, task,
      continuation: continuationOf({
        plan, task, operations: [], registry, constraints: emptyLedger(), validity: null,
        lock: NO_LOCK, auditReadable: true, now: CLOCK(),
      }),
    });
    assert.equal(withReading.readiness, ContinuationReadiness.READY_TO_CONTINUE);
  });

  test('a reading that could not be built is reported as unreadable, not as an unbroken run', () => {
    const plan = fixturePlan([planStep('s1', 'memory.list')]);
    const continuation = continuationOf({
      plan, task: null, operations: [], registry, constraints: emptyLedger(), validity: null,
      lock: NO_LOCK, auditReadable: true, now: CLOCK(),
    });
    assert.equal(continuation.ok, false);
    const reading = readinessOf({
      plan,
      task: fixtureTask([taskStep('s1', 'memory.list', StepStatus.PENDING)]),
      continuation,
    });
    assert.notEqual(reading.readiness, ContinuationReadiness.READY_TO_CONTINUE);
    assert.match(factorText(reading), /the continuation of this run cannot be read/);
  });

  test('a failed step in one branch is disclosed while the untouched step of another is taken up', () => {
    const { reading, continuation } = pair({
      taskSteps: [
        taskStep('s1', 'memory.add', StepStatus.FAILED, { operationId: 'op-1' }),
        taskStep('s2', 'memory.list', StepStatus.PENDING),
      ],
      operations: [stepOp('s1', 'op-1', Outcome.EXECUTION_FAILED)],
    });
    assert.equal(continuation.counts['verified failed'], 1);
    assert.equal(continuation.continue.safe, true, 'the failed branch is settled; the other never began');
    assert.equal(reading.readiness, ContinuationReadiness.READY_TO_CONTINUE);
    assert.match(factorText(reading), new RegExp(`1 step\\(s\\) of task ${shortId('fx-task-1')} recorded as failed: s1`));
  });

  test('a run that still owes a confirmation is not called ready to continue', () => {
    const { reading, continuation } = pair({
      taskSteps: [
        taskStep('s1', 'memory.add', StepStatus.AWAITING_APPROVAL, { permission: 'write' }),
        taskStep('s2', 'memory.list', StepStatus.PENDING),
      ],
    });
    // The derivation does prove s2 untouched, so `continue.safe` is true of it; what it does not do is
    // settle s1, which is the step the records hand to the user. Readiness states the owed confirmation,
    // because that is what is still missing from taking the run up.
    assert.equal(continuation.continue.safe, true);
    assert.deepEqual(continuation.continue.awaiting, ['s1']);
    assert.equal(continuation.runState, 'awaiting external confirmation');
    assert.notEqual(reading.readiness, ContinuationReadiness.READY_TO_CONTINUE);
    assert.equal(reading.readiness, ContinuationReadiness.WAITING_FOR_EVIDENCE);
    assert.match(factorText(reading), /wait for a step-level approval|wait for a confirmation this read cannot give/);
  });
});

describe('AM-H3: the ranking places the continuable run once, and reads nothing else into it', () => {
  const goal = (over = {}) => ({
    id: 'g1', request: 'the fixture goal', status: 'active', priority: 3, deadline: null,
    dependsOn: [], criteria: [], planIds: ['fx-plan-1'], taskIds: ['fx-task-1'], ...over,
  });

  const withReading = (input = {}) => {
    // The plan names the goal, because the priority the ranking uses is read from the goal the plan
    // itself records - and a fixture that left the link out would rank a priority it never read.
    const { plan, task, continuation } = pair({ constraints: emptyLedger('g1'), ...input, plan: { goalId: 'g1', ...(input.plan ?? {}) } });
    return {
      plan, task, continuation,
      report: buildContinuation({
        goals: [goal()], plans: [plan], tasks: [task], now: CLOCK(),
        continuationsByPlan: new Map([[plan.id, continuation]]),
      }),
    };
  };

  test('a continuable run is ranked as plan work, with its command and its readiness stated', () => {
    const { report } = withReading();
    const top = report.candidates[0];
    assert.equal(top.action, 'continue-plan');
    assert.equal(top.kind, 'plan');
    assert.equal(top.readiness, ContinuationReadiness.READY_TO_CONTINUE);
    assert.match(top.command, new RegExp(`plan continue ${shortId('fx-plan-1')}`));
    assert.equal(top.requiresAuthorization, true, 'the ranking prints a command; it does not grant one');
    assert.ok(top.reasons.some((r) => /never started/.test(r)));
    assert.ok(top.reasons.some((r) => /re-read the plan bytes/.test(r)));
    assert.match(renderContinuation(report), /readiness: ready to continue/);
  });

  test('the same run is not ranked twice: the task record is excluded with the reason', () => {
    const { report } = withReading();
    assert.equal(report.candidates.some((c) => c.kind === 'task'), false);
    const excluded = report.excluded.find((e) => e.kind === 'task');
    assert.ok(excluded, 'the task candidate disappeared without saying where it went');
    assert.match(excluded.reason, /ranked as the plan's continuation work/);
  });

  test('without a derivation the ranking keeps the run where the records put it and claims no continuation', () => {
    const plan = fixturePlan([planStep('s1', 'memory.add'), planStep('s2', 'memory.list')]);
    const task = fixtureTask([
      taskStep('s1', 'memory.add', StepStatus.PENDING),
      taskStep('s2', 'memory.list', StepStatus.PENDING),
    ]);
    const report = buildContinuation({ goals: [goal()], plans: [plan], tasks: [task], now: CLOCK() });
    assert.equal(report.candidates.some((c) => c.action === 'continue-plan'), false);
    const resume = report.candidates.find((c) => c.action === 'resume-task');
    assert.ok(resume, 'the task record still describes work that is not finished');
    assert.equal(resume.readiness, null, 'no state is printed for a record that was not read');
    assert.equal(report.excluded.find((e) => e.kind === 'task'), undefined);
  });

  test('a derivation that refuses leaves the run ranked as it was, with the refusal carried into the answer', () => {
    const { report } = withReading({
      taskSteps: [
        taskStep('s1', 'memory.add', StepStatus.RUNNING, { operationId: 'op-1' }),
        taskStep('s2', 'memory.list', StepStatus.PENDING),
      ],
      operations: [],
    });
    assert.equal(report.candidates.some((c) => c.action === 'continue-plan'), false);
    const excluded = report.excluded.find((e) => e.kind === 'plan');
    assert.ok(excluded);
    assert.match(excluded.reason, /refuses to take the run up/);
  });

  test('a continuable run outranks a plan that never started, and never outranks an unknown outcome', () => {
    const continuable = withReading();
    const approved = fixturePlan([planStep('s1', 'memory.list')], {
      id: 'fx-plan-9', status: PlanStatus.APPROVED, activation: null,
    });
    const report = buildContinuation({
      goals: [goal()],
      plans: [continuable.plan, approved],
      tasks: [continuable.task],
      validityByPlan: new Map([[approved.id, { ok: true, problems: [], checks: [] }]]),
      now: CLOCK(),
      continuationsByPlan: new Map([[continuable.plan.id, continuable.continuation]]),
    });
    const actions = report.candidates.map((c) => c.action);
    assert.ok(actions.indexOf('continue-plan') < actions.indexOf('start-plan'), actions.join(','));

    const unknown = withReading({
      taskSteps: [
        taskStep('s1', 'memory.add', StepStatus.UNCERTAIN, { operationId: 'op-1' }),
        taskStep('s2', 'memory.list', StepStatus.PENDING),
      ],
      operations: [],
    });
    assert.equal(unknown.report.candidates[0].action, 'resolve-uncertain');
    assert.equal(unknown.report.candidates.some((c) => c.action === 'continue-plan'), false);
  });

  test('the ordering is a function of the records, and a recorded priority moves it while an absent one does not', () => {
    const first = withReading();
    const second = withReading();
    assert.deepEqual(first.report.candidates, second.report.candidates);
    assert.deepEqual(first.report.excluded, second.report.excluded);

    const ranked = (priority) => buildContinuation({
      goals: [goal({ priority })],
      plans: [first.plan], tasks: [first.task], now: CLOCK(),
      continuationsByPlan: new Map([[first.plan.id, first.continuation]]),
    }).candidates[0];
    assert.equal(ranked(3).score, first.report.candidates[0].score);
    assert.ok(ranked(1).score > ranked(3).score, 'a recorded priority moves the order');
    const unrecorded = ranked(null);
    assert.ok(unrecorded.score < ranked(3).score, 'an absent priority is not given the most urgent weight');
    assert.ok(unrecorded.reasons.includes('no priority is recorded'));
  });

  test('the ranking states a readiness only where its own records state one', () => {
    const approved = fixturePlan([planStep('s1', 'memory.list')], { id: 'fx-plan-3', status: PlanStatus.APPROVED });
    const stale = fixturePlan([planStep('s1', 'memory.list')], { id: 'fx-plan-4', status: PlanStatus.APPROVED });
    const report = buildContinuation({
      goals: [], plans: [approved, stale], tasks: [], now: CLOCK(),
      validityByPlan: new Map([
        [approved.id, { ok: true, problems: [], checks: [] }],
        [stale.id, {
          ok: false,
          problems: ['the goal moved to revision 2'],
          checks: [{ check: 'goal-revision', ok: false, detail: 'the goal moved to revision 2' }],
        }],
      ]),
    });
    const ready = report.candidates.find((c) => c.ref === approved.id);
    assert.equal(ready.readiness, ContinuationReadiness.READY_TO_EXECUTE);
    const moved = report.candidates.find((c) => c.ref === stale.id);
    assert.equal(moved.readiness, ContinuationReadiness.BLOCKED);
    assert.equal(moved.ready, false);

    const pf = prioritizationFactors(ready);
    assert.ok(pf.factors.length > 0);
    assert.match(pf.note, /not a probability, an importance, or a permission/);
    for (const f of pf.factors) assert.ok(f.readFrom, `factor names no record: ${f.factor}`);
  });
});

// ---- a real process, stopped, read by a second one ----------------------------

const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'continuation-child.mjs');
const RUN_CEILING_MS = 120000;

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
  const exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
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

// The same two fixture capabilities the child ran against, registered again in the parent so the second
// process reads the interrupted run instead of reporting that it cannot authorize the fixture.
function probeActions(dataDir) {
  const effectFile = path.join(dataDir, 'effects.txt');
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
      return effectsOf(effectFile).includes(want)
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

describe('AM-H4: a run a real process left behind, ranked and answered in a second process', () => {
  test('the interrupted run ranks first as plan work, and a question about it answers ready to continue', async () => {
    const dataDir = dir();
    const effectFile = path.join(dataDir, 'effects.txt');
    const { last } = await runChild('after-step-creation', dataDir, effectFile);
    const app = await appIn(dataDir);
    assert.equal(effectsOf(effectFile).length, 0, 'the child stopped before any step ran');

    const report = await app.controller.continuationReport();
    const top = report.candidates[0];
    assert.equal(top.action, 'continue-plan', display(report));
    assert.equal(top.readiness, ContinuationReadiness.READY_TO_CONTINUE);
    assert.match(top.command, new RegExp(`plan continue ${shortId(last.planId)}`));
    assert.equal((await app.taskStore.lockState()).alive, false,
      'no process holds the run, which is the record that lets it be taken up');

    const asked = await app.controller.handle(`what is the readiness of plan ${shortId(last.planId)}?`, { origin: 'user' });
    assert.equal(asked.status, Outcome.SUCCESS_VERIFIED, asked.output);
    assert.match(display(asked), /Readiness: ready to continue\./);
    assert.match(display(asked), new RegExp(`to take it up: node bin/apex\\.js plan continue ${shortId(last.planId)}`));
    assert.match(display(asked), /\[from: continuation reading of plan/);
  });

  test('the ranking reads write nothing, run nothing, and leave the records as they found them', async () => {
    const dataDir = dir();
    const effectFile = path.join(dataDir, 'effects.txt');
    const { last } = await runChild('after-step-creation', dataDir, effectFile);
    const app = await appIn(dataDir);
    const before = await app.operations.inspect();
    const planBefore = JSON.stringify(await app.plans.get(last.planId));
    const taskId = (await app.plans.get(last.planId)).activation.taskId;
    const taskBefore = JSON.stringify(await app.taskStore.get(taskId));

    const first = await app.controller.continuationReport();
    const next = await app.controller.continuationReport({ limit: 1, top: true });
    const work = await app.controller.continuationReport({ limit: null });
    assert.deepEqual(next.candidates, first.candidates.slice(0, 1), 'next is the same ranking, shorter');
    assert.deepEqual(work.candidates, first.candidates, 'work and next read one ranking, not two');
    assert.equal((await app.operations.inspect()).records.length, before.records.length,
      'a recommendation writes nothing');
    assert.equal(JSON.stringify(await app.plans.get(last.planId)), planBefore);
    assert.equal(JSON.stringify(await app.taskStore.get(taskId)), taskBefore);
    assert.equal(effectsOf(effectFile).length, 0, 'a read of the ranking takes no step');
    assert.match(display(work), /This command started nothing/);
  });

  test('the continue command the ranking prints is the users to give, and afterwards the answer is different', async () => {
    const dataDir = dir();
    const effectFile = path.join(dataDir, 'effects.txt');
    const { last } = await runChild('after-step-creation', dataDir, effectFile);
    const app = await appIn(dataDir);

    const ran = await app.controller.planContinue(last.planId);
    assert.equal(ran.status, Outcome.PLAN_STORED, ran.output);
    assert.match(display(ran), /2 step\(s\) taken up/);
    assert.equal(effectsOf(effectFile).length, 2, 'both fixture steps ran once, on the users own command');

    const after = await app.controller.continuationReport();
    assert.equal(after.candidates.some((c) => c.action === 'continue-plan'), false,
      'a run that finished is not continuation work');
    const read = await app.controller.planContinuation(last.planId);
    assert.equal(data(read).continuation.continue.safe, false);
    assert.equal((await app.plans.get(last.planId)).status, PlanStatus.COMPLETED);
  });

  test('a goal whose revision moved after the interruption is not offered as continuable work', async () => {
    const dataDir = dir();
    const effectFile = path.join(dataDir, 'effects.txt');
    const { last } = await runChild('after-step-creation', dataDir, effectFile);
    const app = await appIn(dataDir);
    const plan = await app.plans.get(last.planId);
    const taskId = plan.activation.taskId;

    // The approval binds the plan bytes, not the goal they were written against. Moving the goal's
    // criteria is the record that says the work the plan describes is no longer the work on file.
    const revised = await app.controller.goalRevise({
      target: plan.goalId,
      criteria: ['the first note is recorded, with the second wording', 'the second note is recorded'],
      reason: 'the criterion moved after the run stopped',
    });
    assert.equal(revised.status, Outcome.GOAL_UPDATED, revised.output);

    const report = await app.controller.continuationReport();
    assert.equal(report.candidates.some((c) => c.action === 'continue-plan'), false, display(report));
    const read = await app.controller.planContinuation(last.planId);
    const continuation = data(read).continuation;
    assert.equal(continuation.continue.safe, false);
    assert.ok(continuation.blockers.some((b) => /revision/.test(b)), continuation.blockers.join(' | '));
    const asked = await app.controller.handle(`what is the readiness of plan ${shortId(last.planId)}?`, { origin: 'user' });
    assert.doesNotMatch(display(asked), /Readiness: ready to continue/);
    assert.match(display(asked), /Readiness: requires clarification/);
    assert.equal(effectsOf(effectFile).length, 0, 'a moved goal is not a way to keep running');
    assert.equal((await app.taskStore.get(taskId)).steps.filter((s) => s.status === StepStatus.RUNNING).length, 0);
  });

  test('a run whose step is unknown is ranked as the record that settles it, not as work to take up', async () => {
    const dataDir = dir();
    const effectFile = path.join(dataDir, 'effects.txt');
    const { last } = await runChild('during-execution', dataDir, effectFile);
    const app = await appIn(dataDir);

    const report = await app.controller.continuationReport();
    assert.equal(report.candidates.some((c) => c.action === 'continue-plan'), false, display(report));
    const read = await app.controller.planContinuation(last.planId);
    const continuation = data(read).continuation;
    assert.deepEqual(continuation.continue.neverReplay, ['s1']);
    assert.equal(continuation.continue.safe, false);

    const asked = await app.controller.handle(`what is the readiness of plan ${shortId(last.planId)}?`, { origin: 'user' });
    assert.doesNotMatch(display(asked), /Readiness: ready to continue/);
    assert.match(display(asked), /Readiness: waiting for evidence/);
    assert.equal(effectsOf(effectFile).length, 1, 'the interrupted write is not produced a second time');
  });
});
