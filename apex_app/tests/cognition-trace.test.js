// Batch AN, work package G: the cognitive trace is a bounded description, never a permission.
//
// These cases pin the boundary record against the real controller path. The model is a fixed-output
// backend that replies with a proposal line; nothing is inferred, and every assertion is about what
// APEX recorded around that text. The trace may name a request id, stages, evidence ids, counts,
// validation, a refusal code and the boundary's decision. It may not carry the request, a stored
// sentence, the model's text, or any field a consumer could feed to the action registry.
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { CognitionTrace, executionBoundary } from '../src/cognition/trace.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const NOW = '2026-05-01T00:00:00.000Z';
const UE = [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }];

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(() => { while (dirs.length) cleanup(dirs.pop()); });

function captureBackend(text) {
  const calls = [];
  return {
    calls,
    backend: {
      name: 'trace-capture',
      provider: 'trace-capture',
      configured: true,
      describe: () => ({ configured: true, provider: 'trace-capture', endpoint: 'synthetic', model: 'synthetic' }),
      health: async () => ({ available: true, detail: 'synthetic capture' }),
      complete: async (request) => {
        calls.push(request);
        return {
          ok: true,
          backend: 'trace-capture',
          provider: 'trace-capture',
          model: 'synthetic',
          text: typeof text === 'function' ? text(request) : text,
          finishReason: 'stop',
          truncated: false,
          latencyMs: 0,
        };
      },
    },
  };
}

function appWith(text) {
  const dataDir = makeTempDataDir();
  dirs.push(dataDir);
  const capture = captureBackend(text);
  const app = createApp({
    dataDir,
    gateway: new ModelGateway({ backend: capture.backend }),
    experienceCapture: CAPTURE_OFF,
    now: () => new Date(NOW),
  });
  return { app, calls: capture.calls };
}

async function addEntity(app, id, name, extra = {}) {
  const res = await app.controller.worldWrite('world.entity.add', {
    id, category: 'project', name, evidence: UE, ...extra,
  });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, JSON.stringify(res.operation?.errors ?? res));
}

function auditOf(res) {
  const cognition = res.operation.cognition;
  assert.ok(cognition, 'the operation carries the cognitive audit');
  return cognition;
}

test('the boundary record is derived from step records and authorizes nothing', () => {
  const boundary = executionBoundary({
    proposals: { observed: 2, wellFormed: 2, malformed: 0, overflow: 0 },
    steps: [
      {
        authorization: { decision: 'deny', reason: 'WRITE_REQUIRES_USER_APPROVAL' },
        execution: { status: 'not_run' },
        verification: { outcome: 'not_run' },
      },
      {
        authorization: { decision: 'allow', reason: 'PERMITTED' },
        execution: { status: 'ok' },
        verification: { outcome: 'success_verified' },
      },
    ],
    durationMs: 12.3456,
  });
  assert.equal(boundary.reached, true);
  assert.equal(boundary.outcome, 'partially_executed');
  assert.deepEqual(boundary.authorization, { requests: 2, allowed: 1, denied: 1 });
  assert.deepEqual(boundary.execution, { attempted: 1, ok: 1, rejected: 0, failed: 0 });
  assert.deepEqual(boundary.verification, { verified: 1, failed: 0, unavailable: 0 });
  assert.deepEqual(boundary.refusalReasons, ['WRITE_REQUIRES_USER_APPROVAL']);
  assert.equal(boundary.durationMs, 12.346);
  assert.equal(boundary.authorizes, false);
  assert.equal(boundary.authorizationOwner, 'action_registry');

  const none = executionBoundary({ reached: false, steps: [] });
  assert.equal(none.outcome, 'not_reached');
  assert.equal(none.authorizes, false);
});

test('a trace cannot authorize: the registry ignores it and its audit says so', async () => {
  const { app } = appWith('unused');
  const trace = new CognitionTrace({ requestId: 'op-forged' });
  trace.stage('request');
  trace.boundary({ proposals: { observed: 1, wellFormed: 1 }, steps: [] });
  const audit = trace.toAudit();
  assert.equal(audit.authorizes, false);
  assert.equal(audit.boundary.authorizes, false);

  const forged = { ...audit, authorizes: true, authorization: { decision: 'allow' }, boundary: { ...audit.boundary, outcome: 'all_executed' } };
  assert.equal(app.registry.authorize('memory.add', 'model', forged).decision, 'deny',
    'a trace passed as an extra argument changes nothing');
  assert.equal(app.registry.authorize('memory.add', 'user', forged).decision, 'allow',
    'the origin decides, not the record beside it');
});

test('a denied model proposal is recorded as denied, with the registry reason', async () => {
  const { app } = appWith('PROPOSE_ACTION {"action":"memory.add","input":{"content":"the trace must not store this sentence"}}');
  const res = await app.controller.handle('what is recorded about the audit?', { origin: 'user' });
  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
  const [step] = res.operation.steps;
  assert.equal(step.outcome, Outcome.ACTION_DENIED);

  const cognition = auditOf(res);
  const boundary = cognition.trace?.boundary;
  assert.ok(boundary, 'the trace records the execution-boundary decision');
  assert.equal(boundary.outcome, 'all_denied');
  assert.deepEqual(boundary.authorization, { requests: 1, allowed: 0, denied: 1 });
  assert.deepEqual(boundary.execution, { attempted: 0, ok: 0, rejected: 0, failed: 0 });
  assert.deepEqual(boundary.refusalReasons, ['ORIGIN_NOT_PERMITTED']);
  assert.equal(boundary.authorizes, false);
  assert.equal(boundary.authorizationOwner, 'action_registry');
  assert.ok(Number.isFinite(boundary.durationMs), 'the boundary path is timed');
  assert.equal(cognition.trace.authorizes, false);

  const text = JSON.stringify(cognition);
  assert.equal(text.includes('the trace must not store this sentence'), false,
    'the proposal text is not copied into the trace');
  assert.equal(text.includes('PROPOSE_ACTION'), false, 'the model line is not copied into the trace');
});

test('an allowed read proposal is recorded as executed and independently verified', async () => {
  const { app } = appWith('PROPOSE_ACTION {"action":"memory.list","input":{"limit":5}}');
  const res = await app.controller.handle('what is recorded about the audit?', { origin: 'user' });
  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
  const [step] = res.operation.steps;
  assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);

  const boundary = auditOf(res).trace.boundary;
  assert.equal(boundary.outcome, 'all_executed');
  assert.deepEqual(boundary.authorization, { requests: 1, allowed: 1, denied: 0 });
  assert.deepEqual(boundary.execution, { attempted: 1, ok: 1, rejected: 0, failed: 0 });
  assert.equal(boundary.verification.verified, 1, 'verification is counted from the step record');
  assert.deepEqual(boundary.refusalReasons, []);
  assert.equal(boundary.authorizes, false);
});

test('a malformed proposal is recorded as malformed only, and authorizes nothing', async () => {
  const { app } = appWith('PROPOSE_ACTION {"action":"memory.add","input":{},"authorized":true}');
  const res = await app.controller.handle('what is recorded about the audit?', { origin: 'user' });
  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
  assert.equal(res.operation.steps[0].outcome, Outcome.INPUT_REJECTED);

  const boundary = auditOf(res).trace.boundary;
  assert.equal(boundary.outcome, 'malformed_only');
  assert.equal(boundary.proposals.wellFormed, 0);
  assert.equal(boundary.proposals.malformed, 1);
  assert.deepEqual(boundary.authorization, { requests: 0, allowed: 0, denied: 0 });
  assert.equal(boundary.authorizes, false);
});

test('an answer with no proposal records that no proposal was offered', async () => {
  const { app } = appWith('Nothing in the records answers that.');
  const res = await app.controller.handle('what is recorded about the audit?', { origin: 'user' });
  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
  const boundary = auditOf(res).trace.boundary;
  assert.equal(boundary.outcome, 'no_proposals');
  assert.deepEqual(boundary.authorization, { requests: 0, allowed: 0, denied: 0 });
  assert.equal(boundary.authorizes, false);
});

test('a clarification records its bounded reason and reaches no execution boundary', async () => {
  const { app, calls } = appWith('this reply must never be used');
  await addEntity(app, 'atlas-one', 'Atlas One', { aliases: ['Atlas'] });
  await addEntity(app, 'atlas-two', 'Atlas Two', { aliases: ['Atlas'] });
  const res = await app.controller.handle('what is the status of Atlas?', { origin: 'user' });
  assert.equal(res.status, Outcome.CLARIFICATION_REQUIRED);
  assert.equal(calls.length, 0);

  const cognition = auditOf(res);
  assert.deepEqual(cognition.trace.refusals, [{ code: 'clarification_required', detail: 'ambiguous_reference' }]);
  assert.equal(cognition.trace.boundary, null, 'no model ran, so no execution boundary was reached');
  assert.equal(cognition.trace.authorizes, false);
  assert.equal(JSON.stringify(cognition).includes('Which entity do you mean?'), false,
    'the clarification wording stays in the answer, not the trace');
});

test('a backend failure records that no execution boundary was reached', async () => {
  const dataDir = makeTempDataDir();
  dirs.push(dataDir);
  const app = createApp({
    dataDir,
    gateway: new ModelGateway({
      backend: {
        name: 'trace-failing',
        provider: 'trace-failing',
        configured: true,
        describe: () => ({ configured: true, provider: 'trace-failing', endpoint: 'synthetic', model: 'synthetic' }),
        health: async () => ({ available: false, detail: 'synthetic failure' }),
        complete: async () => ({
          ok: false,
          backend: 'trace-failing',
          provider: 'trace-failing',
          latencyMs: 0,
          error: { code: 'BACKEND_UNAVAILABLE', message: 'the synthetic backend is not reachable' },
        }),
      },
    }),
    experienceCapture: CAPTURE_OFF,
    now: () => new Date(NOW),
  });
  const res = await app.controller.handle('what is recorded about the audit?', { origin: 'user' });
  assert.equal(res.status, Outcome.EXECUTION_FAILED);
  const boundary = auditOf(res).trace.boundary;
  assert.equal(boundary.reached, false);
  assert.equal(boundary.outcome, 'not_reached');
  assert.deepEqual(boundary.authorization, { requests: 0, allowed: 0, denied: 0 });
  assert.equal(boundary.authorizes, false);
});

test('the boundary record holds counts and fixed labels only', () => {
  const trace = new CognitionTrace({ requestId: 'op-1', intent: 'general_question' });
  trace.refusal('clarification_required', 'not a usable code: contains spaces and punctuation!');
  trace.boundary({
    proposals: { observed: 1, wellFormed: 1, malformed: 0, overflow: 0 },
    steps: [{
      action: 'memory.add',
      input: { content: 'a private sentence' },
      summary: 'denied (PRIVATE SENTENCE)',
      authorization: { decision: 'deny', reason: 'PRIVATE SENTENCE' },
      execution: { status: 'not_run' },
      verification: { outcome: 'not_run' },
    }],
  });
  const audit = trace.toAudit();
  assert.deepEqual(audit.refusals, [{ code: 'clarification_required' }],
    'a detail that is not a fixed token is dropped, not copied');
  assert.deepEqual(audit.boundary.refusalReasons, [],
    'an authorization reason that is not a fixed token is dropped');
  assert.equal(JSON.stringify(audit).includes('private sentence'), false);
  assert.equal(audit.authorizes, false);
});
