// Batch AO: the executable request lifecycle.
//
// These tests pin the state machine itself: entry conditions, skipped stages, failure propagation,
// invalid-transition rejection, and the rule that a success cannot be claimed above a stage that did
// not run. Everything is a plain object; no model and no store are involved.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  LifecycleStatus, RequestLifecycle, STAGE_ENTRY, TransitionRejection, lifecycleAudit,
} from '../src/cognition/lifecycle.js';
import { StageStatus, buildContract } from '../src/cognition/contract.js';
import { analyzeRequest } from '../src/cognition/engine.js';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { APP_ROOT, cleanEnv, cleanup, makeTempDataDir } from './helpers.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) {
    try { cleanup(dirs.pop()); } catch { /* already removed */ }
  }
});

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
        text, finishReason: 'stop', truncated: false, latencyMs: 0,
      }),
    },
  });
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

function ran(lifecycle, orders = [1, 2, 3, 4, 5]) {
  for (const order of orders) lifecycle.complete(order, { counts: { n: order } });
  return lifecycle;
}

test('a new request starts with every stage pending and no authorizing claim', () => {
  const lifecycle = new RequestLifecycle({ requestId: 'op-1' });
  const snapshot = lifecycle.snapshot();
  assert.equal(snapshot.requestId, 'op-1');
  assert.equal(snapshot.stages.length, 10);
  assert.ok(snapshot.stages.every((stage) => stage.status === LifecycleStatus.PENDING));
  assert.equal(snapshot.authorizes, false);
  assert.deepEqual(snapshot.rejections, []);
});

test('stages complete in order and keep their own counts', () => {
  const lifecycle = ran(new RequestLifecycle());
  const snapshot = lifecycle.snapshot();
  for (let order = 1; order <= 5; order += 1) {
    assert.equal(snapshot.stages[order - 1].status, LifecycleStatus.RAN);
    assert.deepEqual(snapshot.stages[order - 1].counts, { n: order });
  }
  for (let order = 6; order <= 10; order += 1) {
    assert.equal(snapshot.stages[order - 1].status, LifecycleStatus.PENDING);
  }
});

test('a stage cannot be entered before its prerequisite has finished', () => {
  const lifecycle = new RequestLifecycle();
  const skippedAhead = lifecycle.complete(4);
  assert.equal(skippedAhead.ok, false);
  assert.equal(skippedAhead.code, TransitionRejection.EARLIER_STAGE_PENDING);
  assert.equal(lifecycle.statusOf(4), LifecycleStatus.PENDING);
  assert.deepEqual(lifecycle.rejections, [{ order: 4, code: TransitionRejection.EARLIER_STAGE_PENDING }]);
});

test('a failed stage blocks every dependent stage instead of leaving it available', () => {
  const lifecycle = new RequestLifecycle();
  lifecycle.complete(1);
  lifecycle.fail(2, { reason: 'interpretation_error' });
  lifecycle.closeRange(3, 5, LifecycleStatus.UNAVAILABLE);
  lifecycle.closeRange(6, 10, LifecycleStatus.NOT_REACHED);

  const snapshot = lifecycle.snapshot();
  assert.equal(snapshot.stages[1].status, LifecycleStatus.FAILED);
  for (let order = 3; order <= 5; order += 1) {
    assert.equal(snapshot.stages[order - 1].status, LifecycleStatus.UNAVAILABLE);
  }
  for (let order = 6; order <= 10; order += 1) {
    assert.equal(snapshot.stages[order - 1].status, LifecycleStatus.NOT_REACHED);
  }

  // Stage 3 was already closed as unavailable when stage 2 failed, so a later attempt is refused for
  // that reason first; either rejection code leaves the stage at unavailable.
  const attempt = lifecycle.complete(3);
  assert.equal(attempt.ok, false);
  assert.equal(attempt.code, TransitionRejection.STAGE_ALREADY_TERMINAL);
  assert.equal(lifecycle.statusOf(3), LifecycleStatus.UNAVAILABLE);

  // A stage that is still open ahead of the failed stage is refused by the earlier-stage rule.
  const open = new RequestLifecycle();
  open.complete(1);
  open.fail(2, { reason: 'interpretation_error' });
  const ahead = open.complete(3);
  assert.equal(ahead.ok, false);
  assert.equal(ahead.code, TransitionRejection.PREREQUISITE_FAILED);
});

test('a skipped stage is explicitly represented and cannot carry a dependent stage', () => {
  const lifecycle = ran(new RequestLifecycle());
  lifecycle.complete(6, { counts: { observed: 0, well_formed: 0 } });
  const skipped = lifecycle.skip(7, { reason: 'no_proposals', counts: { requests: 0 } });
  assert.equal(skipped.ok, true);
  assert.equal(lifecycle.statusOf(7), LifecycleStatus.SKIPPED);

  const execution = lifecycle.complete(8, { counts: { attempted: 0 } });
  assert.equal(execution.ok, false);
  assert.equal(execution.code, TransitionRejection.PREREQUISITE_SKIPPED);
  assert.equal(lifecycle.statusOf(8), LifecycleStatus.PENDING);

  const snapshot = lifecycle.snapshot();
  assert.equal(snapshot.stages[6].status, LifecycleStatus.SKIPPED);
  assert.equal(snapshot.stages[6].reason, 'no_proposals');
});

test('a stage cannot be completed twice', () => {
  const lifecycle = new RequestLifecycle();
  lifecycle.complete(1);
  const again = lifecycle.complete(1);
  assert.equal(again.ok, false);
  assert.equal(again.code, TransitionRejection.STAGE_ALREADY_TERMINAL);
});

test('a success claim is downgraded when authorization, execution or verification is missing', () => {
  const lifecycle = ran(new RequestLifecycle());
  lifecycle.complete(6, { counts: { observed: 1, well_formed: 1 } });
  lifecycle.complete(7, { counts: { requests: 1, allowed: 1, denied: 0 } });

  const noExecution = lifecycle.claim('success_verified');
  assert.equal(noExecution.downgraded, true);
  assert.equal(noExecution.status, 'execution_failed');
  assert.ok(noExecution.reasons.some((reason) => /execution/.test(reason)));

  lifecycle.complete(8, { counts: { attempted: 1, ok: 1, rejected: 0, failed: 0 } });
  const noVerification = lifecycle.claim('success_verified');
  assert.equal(noVerification.downgraded, true);
  assert.equal(noVerification.status, 'verification_unavailable');

  lifecycle.complete(9, { counts: { checked: 1, verified: 1, failed: 0, unavailable: 0 } });
  const verified = lifecycle.claim('success_verified');
  assert.equal(verified.downgraded, false);
  assert.equal(verified.status, 'success_verified');
});

test('a claim that is not a success is never rewritten', () => {
  const lifecycle = new RequestLifecycle();
  assert.deepEqual(lifecycle.claim('clarification_required'), {
    status: 'clarification_required', downgraded: false, reasons: [],
  });
});

test('finalization records its result once and refuses a second finalization', () => {
  const lifecycle = ran(new RequestLifecycle());
  const first = lifecycle.finalize({ requestedStatus: 'verification_unavailable', recorded: true });
  assert.equal(first.ok, true);
  assert.equal(lifecycle.finalization.recorded, true);
  assert.equal(lifecycle.finalization.status, 'verification_unavailable');
  const second = lifecycle.finalize({ recorded: false });
  assert.equal(second.ok, false);
  assert.equal(second.code, TransitionRejection.ALREADY_FINALIZED);
  // A finalized lifecycle cannot advance either.
  assert.equal(lifecycle.start(6).ok, false);
});

test('the contract restates the lifecycle and reports a rejected transition', () => {
  const lifecycle = ran(new RequestLifecycle());
  const contract = buildContract({ requestId: 'op-2', lifecycle });
  assert.equal(contract.reachedThrough, 5);
  for (let order = 1; order <= 5; order += 1) {
    assert.equal(contract.stages[order - 1].status, StageStatus.RAN);
  }
  for (let order = 6; order <= 10; order += 1) {
    assert.equal(contract.stages[order - 1].status, StageStatus.NOT_REACHED);
  }
  assert.equal(contract.ok, true);

  lifecycle.start(9);
  const inconsistent = buildContract({ requestId: 'op-2', lifecycle });
  const check = inconsistent.checks.find((entry) => entry.check === 'lifecycle_transitions_recorded');
  assert.equal(check.ok, false);
  assert.equal(inconsistent.ok, false);
});

test('the lifecycle audit contains fixed stage data and no request text', () => {
  const lifecycle = ran(new RequestLifecycle({ requestId: 'op-3' }));
  lifecycle.fail(6, { reason: 'model_unavailable' });
  const audit = lifecycleAudit(lifecycle.snapshot());
  assert.deepEqual(Object.keys(audit).sort(), [
    'authorizes', 'finalization', 'rejections', 'requestId', 'schema', 'stages',
  ]);
  assert.equal(audit.authorizes, false);
  assert.deepEqual(Object.keys(audit.stages[5]).sort(), ['counts', 'name', 'order', 'owner', 'reason', 'status']);
  assert.equal(audit.stages[5].reason, 'model_unavailable');
});

test('an error during interpretation is attributed to stage 2 and closes the executive stages', async () => {
  // A non-Date `now` makes the deterministic date parser throw inside interpretation. This exercises
  // the engine's own per-stage attribution, not a mocked analysis.
  const analysis = await analyzeRequest({ request: 'what changed as of yesterday', requestId: 'op-4', now: 'not-a-date' });
  assert.equal(analysis.available, false);
  const byOrder = Object.fromEntries(analysis.contract.stages.map((stage) => [stage.order, stage]));
  assert.equal(byOrder[1].status, StageStatus.RAN);
  assert.equal(byOrder[2].status, StageStatus.FAILED);
  for (let order = 3; order <= 5; order += 1) assert.equal(byOrder[order].status, StageStatus.UNAVAILABLE);
  for (let order = 6; order <= 10; order += 1) assert.equal(byOrder[order].status, StageStatus.NOT_REACHED);
  assert.equal(analysis.contract.reachedThrough, 2);
  const check = analysis.contract.checks.find((entry) => entry.check === 'lifecycle_transitions_recorded');
  assert.equal(check.ok, true, 'a recorded failure is not an invalid transition');
});

function allowStep() {
  return {
    action: 'memory_search',
    authorization: { decision: 'allow', reason: 'PERMITTED' },
    execution: { status: 'ok' },
    verification: { outcome: 'success_verified', detail: null },
  };
}

function denyStep() {
  return {
    action: 'memory.add',
    authorization: { decision: 'deny', reason: 'ORIGIN_NOT_PERMITTED' },
    execution: { status: 'not_run' },
    verification: { outcome: 'not_run', detail: null },
  };
}

test('stages 6-9 are recorded from the steps the executive path produced', () => {
  const lifecycle = ran(new RequestLifecycle());
  lifecycle.recordExecution({
    proposals: { observed: 2, wellFormed: 1, malformed: 1, overflow: 0 },
    steps: [denyStep()],
  });
  assert.equal(lifecycle.statusOf(6), LifecycleStatus.RAN);
  assert.deepEqual(lifecycle.snapshot().stages[5].counts, {
    observed: 2, well_formed: 1, malformed: 1, overflow: 0,
  });
  assert.deepEqual(lifecycle.snapshot().stages[6].counts, { requests: 1, allowed: 0, denied: 1 });
  assert.equal(lifecycle.statusOf(8), LifecycleStatus.SKIPPED);
  assert.equal(lifecycle.statusOf(9), LifecycleStatus.NOT_REACHED);
  assert.equal(lifecycle.statusOf(10), LifecycleStatus.NOT_REACHED);
  // A second call cannot rewrite recorded stages.
  lifecycle.recordExecution({ proposals: { observed: 5, wellFormed: 5, malformed: 0, overflow: 0 }, steps: [] });
  assert.equal(lifecycle.snapshot().stages[5].counts.observed, 2);
});

test('an allowed, executed, verified step reaches stages 8 and 9 and carries a success claim', () => {
  const lifecycle = ran(new RequestLifecycle());
  lifecycle.recordExecution({
    proposals: { observed: 1, wellFormed: 1, malformed: 0, overflow: 0 },
    steps: [allowStep()],
  });
  assert.deepEqual(lifecycle.snapshot().stages[7].counts, { attempted: 1, ok: 1, rejected: 0, failed: 0 });
  assert.deepEqual(lifecycle.snapshot().stages[8].counts, { checked: 1, verified: 1, failed: 0, unavailable: 0 });
  assert.equal(lifecycle.claim('success_verified').downgraded, false);
});

test('a model turn with no proposals records a skipped authorization stage', () => {
  const lifecycle = ran(new RequestLifecycle());
  lifecycle.recordExecution({
    proposals: { observed: 0, wellFormed: 0, malformed: 0, overflow: 0 },
    steps: [],
  });
  assert.equal(lifecycle.statusOf(6), LifecycleStatus.RAN);
  assert.equal(lifecycle.statusOf(7), LifecycleStatus.SKIPPED);
  assert.equal(lifecycle.snapshot().stages[6].reason, 'no_proposals');
  for (let order = 8; order <= 10; order += 1) assert.equal(lifecycle.statusOf(order), LifecycleStatus.NOT_REACHED);
});

test('a model failure is recorded as a failed stage that closes every dependent stage', () => {
  const lifecycle = ran(new RequestLifecycle());
  lifecycle.recordModelFailure('cancelled');
  assert.equal(lifecycle.statusOf(6), LifecycleStatus.FAILED);
  assert.equal(lifecycle.snapshot().stages[5].reason, 'cancelled');
  for (let order = 7; order <= 10; order += 1) assert.equal(lifecycle.statusOf(order), LifecycleStatus.NOT_REACHED);
  // Repeating the record is a no-op, not a second failure.
  const before = lifecycle.snapshot().stages[5];
  lifecycle.recordModelFailure('model_unavailable');
  assert.deepEqual(lifecycle.snapshot().stages[5], before);
  assert.deepEqual(lifecycle.rejections, []);
});

test('a request cancelled before it is sent records the model stage as failed and runs nothing', async () => {
  const dataDir = makeTempDataDir();
  dirs.push(dataDir);
  const gateway = stubGateway('PROPOSE_ACTION {"action":"memory.add","input":{"content":"never runs"}}');
  const app = createApp({ dataDir, gateway });
  const controller = new AbortController();
  controller.abort();

  const res = await app.controller.handle('tell me something about the sky', {
    origin: 'user', signal: controller.signal,
  });
  assert.equal(res.status, Outcome.REQUEST_CANCELLED);
  assert.equal(res.operation.steps.length, 0, 'a cancelled request executed nothing');

  const stored = readJsonl(path.join(dataDir, 'operations.jsonl')).at(-1);
  const lifecycle = stored.cognition.lifecycle;
  assert.equal(lifecycle.stages[5].status, 'failed');
  assert.equal(lifecycle.stages[5].reason, 'cancelled');
  for (let order = 7; order <= 10; order += 1) assert.equal(lifecycle.stages[order - 1].status, 'not_reached');
  assert.equal(lifecycle.finalization.status, Outcome.REQUEST_CANCELLED);
  assert.equal(lifecycle.finalization.recorded, null);
  assert.equal(stored.cognition.contract.ok, true);
  assert.equal(stored.cognition.contract.reachedThrough, 6);
});

test('the entry table states a dependency for every stage except the model stage', () => {
  for (const order of [2, 3, 4, 5, 7, 8, 9, 10]) {
    assert.ok(STAGE_ENTRY[order].requires.length > 0, `stage ${order} must depend on an earlier stage`);
    for (const required of STAGE_ENTRY[order].requires) assert.ok(required < order);
  }
  assert.deepEqual(STAGE_ENTRY[1].requires, []);
  // The model may be asked once the cognitive reading has finished or is disclosed as unavailable, so
  // stage 6 names no specific predecessor. The earlier-stage rule below still enforces the order.
  assert.deepEqual(STAGE_ENTRY[6].requires, []);
  const lifecycle = ran(new RequestLifecycle());
  assert.equal(lifecycle.complete(6).ok, true);
  const skippedOverOpen = new RequestLifecycle();
  skippedOverOpen.complete(1);
  assert.equal(skippedOverOpen.complete(6).code, TransitionRejection.EARLIER_STAGE_PENDING);
});

function replyGateway(complete) {
  return new ModelGateway({
    backend: {
      name: 'stub-reply',
      provider: 'stub-reply',
      configured: true,
      describe: () => ({ configured: true, provider: 'stub-reply', endpoint: 'stub-reply', model: 'stub-reply' }),
      health: async () => ({ available: true, detail: 'stub reply' }),
      complete,
    },
  });
}

function waitForLine(child, token, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const stop = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`child did not report ${token}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes(token)) {
        stop();
        resolve();
      }
    };
    const onExit = () => {
      stop();
      reject(new Error(`child exited before reporting ${token}`));
    };
    const onError = (err) => {
      stop();
      reject(err);
    };
    child.stdout.on('data', onData);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

test('a delayed response that arrives after cancellation is discarded and runs nothing', async () => {
  const dataDir = makeTempDataDir();
  dirs.push(dataDir);
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const gateway = replyGateway(async () => {
    startedResolve();
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      ok: true, backend: 'stub-reply', provider: 'stub-reply', model: 'stub-reply',
      text: 'PROPOSE_ACTION {"action":"memory.add","input":{"content":"late write"}}\nA late answer.',
      finishReason: 'stop', truncated: false, latencyMs: 80,
    };
  });
  const app = createApp({ dataDir, gateway });
  const controller = new AbortController();

  const pending = app.controller.handle('tell me something about the sky', {
    origin: 'user', signal: controller.signal,
  });
  await started;
  controller.abort();
  const res = await pending;

  assert.equal(res.status, Outcome.REQUEST_CANCELLED);
  assert.equal(res.operation.steps.length, 0, 'the late proposal never reached the registry');
  assert.doesNotMatch(res.output ?? '', /late write|A late answer/);
  assert.doesNotMatch(res.display ?? '', /late write|A late answer/);
  assert.equal((await app.memory.list()).length, 0, 'no action ran');

  const stored = readJsonl(path.join(dataDir, 'operations.jsonl')).at(-1);
  assert.equal(stored.status, Outcome.REQUEST_CANCELLED);
  assert.equal(stored.model.class, 'cancelled');
  assert.equal(stored.model.transportClass, 'valid');
  assert.equal(stored.model.cancelledAfterResponse, true);
  const lifecycle = stored.cognition.lifecycle;
  assert.equal(lifecycle.stages[5].status, 'failed');
  assert.equal(lifecycle.stages[5].reason, 'cancelled_after_response');
  for (let order = 7; order <= 10; order += 1) assert.equal(lifecycle.stages[order - 1].status, 'not_reached');
  assert.equal(lifecycle.finalization.status, Outcome.REQUEST_CANCELLED);
  assert.equal(stored.cognition.contract.ok, true);
});

test('a reply that repeats a proposal executes it once and records the repeat as a duplicate', async () => {
  const dataDir = makeTempDataDir();
  dirs.push(dataDir);
  const sink = [];
  const read = {
    name: 'probe.read',
    description: 'fixture read that records its executions',
    inputHint: '{"tag":"text","n":1}',
    permission: 'read',
    origins: ['user', 'model'],
    validate: (input) => ({ tag: String(input?.tag ?? 'x'), n: Number(input?.n ?? 0) }),
    async execute(_ctx, input) {
      sink.push(input.tag);
      return { summary: `read ${input.tag}`, data: { tag: input.tag } };
    },
    async verify() { return { ok: true, detail: 'the sink holds one read' }; },
  };
  const gateway = stubGateway([
    'PROPOSE_ACTION {"action":"probe.read","input":{"tag":"dup","n":1}}',
    // The same request with its keys in a different order is the same proposal.
    'PROPOSE_ACTION {"action":"probe.read","input":{"n":1,"tag":"dup"}}',
    'An answer beside two proposals.',
  ].join('\n'));
  const app = createApp({ dataDir, gateway, extraActions: [read] });

  const res = await app.controller.handle('tell me something about the sky', { origin: 'user' });

  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
  assert.deepEqual(sink, ['dup'], 'the action ran exactly once');
  const modelSteps = res.operation.steps.filter((step) => step.origin === 'model');
  assert.equal(modelSteps.length, 2);
  assert.equal(modelSteps[0].outcome, Outcome.SUCCESS_VERIFIED);
  assert.equal(modelSteps[1].outcome, Outcome.DUPLICATE_PROPOSAL);
  assert.equal(modelSteps[1].execution.status, 'not_run');
  assert.equal(modelSteps[1].authorization, null);
  assert.equal(modelSteps[1].verification.outcome, 'not_run');

  const stored = readJsonl(path.join(dataDir, 'operations.jsonl')).at(-1);
  const lifecycle = stored.cognition.lifecycle;
  assert.equal(lifecycle.stages[5].counts.well_formed, 2);
  assert.equal(lifecycle.stages[6].counts.requests, 1, 'only the first copy was offered to the registry');
  assert.equal(lifecycle.stages[7].counts.ok, 1);
  assert.equal(lifecycle.stages[8].counts.checked, 1);
});

test('submitting the same request twice creates two fresh requests and no executive write', async () => {
  const dataDir = makeTempDataDir();
  dirs.push(dataDir);
  const gateway = stubGateway('PROPOSE_ACTION {"action":"memory.add","input":{"content":"duplicate write"}}');
  const app = createApp({ dataDir, gateway });

  const first = await app.controller.handle('tell me something about the sky', { origin: 'user' });
  const second = await app.controller.handle('tell me something about the sky', { origin: 'user' });

  assert.notEqual(first.operation.id, second.operation.id, 'each submission has its own request identity');
  assert.equal((await app.memory.list()).length, 0, 'the model-origin write was denied both times');
  for (const res of [first, second]) {
    const step = res.operation.steps.find((entry) => entry.origin === 'model');
    assert.equal(step.authorization.decision, 'deny', 'each attempt was authorized again');
    assert.equal(step.execution.status, 'not_run');
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.equal(step.proposalId, `${res.operation.id}/mp:1`, 'the proposal identity is bound to its own request');
  }
  const ids = readJsonl(path.join(dataDir, 'operations.jsonl')).map((record) => record.id);
  assert.equal(new Set(ids).size, ids.length, 'both attempts are recorded under distinct identities');
});

test('a process terminated during a model request leaves no success record and nothing resumes', async () => {
  const dataDir = makeTempDataDir();
  dirs.push(dataDir);
  const child = spawn(
    process.execPath,
    [path.join(APP_ROOT, 'tests', 'fixtures', 'cancelled-request-child.mjs'), dataDir],
    { env: cleanEnv(), cwd: APP_ROOT, windowsHide: true },
  );
  try {
    await waitForLine(child, 'MODEL-STARTED');
    child.kill('SIGKILL');
    await once(child, 'exit');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  const opsFile = path.join(dataDir, 'operations.jsonl');
  const completed = fs.existsSync(opsFile)
    ? readJsonl(opsFile).filter((record) => record.status === Outcome.SUCCESS_VERIFIED
      || record.status === Outcome.VERIFICATION_UNAVAILABLE
      || record.status === Outcome.REQUEST_CANCELLED)
    : [];
  assert.deepEqual(completed, [], 'the interrupted request is not recorded as answered');

  const restarted = createApp({ dataDir, gateway: stubGateway('irrelevant') });
  const { records } = await restarted.operations.list({ limit: 20 });
  assert.deepEqual(records, [], 'a restarted APEX does not resume or record the interrupted request');
  assert.equal((await restarted.memory.list()).length, 0, 'the interrupted request left no side effect');
});
