// The neural runtime boundary: a versioned contract, a bounded lifecycle, and a deterministic
// simulated transport. No test here runs inference, starts a process, imports the research tree,
// or contacts any endpoint. A reply produced here is test text, not evidence about a model.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_DEADLINE_MS,
  MAX_DEADLINE_MS,
  MAX_OUTPUT_CHARS,
  MAX_PLAN_STEPS,
  MAX_PROPOSALS,
  MAX_REQUEST_CHARS,
  MAX_RESPONSE_CHARS,
  NEURAL_REQUEST_SCHEMA,
  NEURAL_RESPONSE_SCHEMA,
  NeuralFailureCode,
  NeuralOutcome,
  PROPOSAL_KINDS,
  buildNeuralRequest,
  outcomeForCode,
  validateNeuralResponse,
} from '../src/neural/contract.js';
import { NeuralLifecycle, retryableOutcome } from '../src/neural/lifecycle.js';
import {
  NEURAL_BOUNDARY_SCHEMA,
  NeuralRuntimeBoundary,
  createNeuralBoundary,
} from '../src/neural/runtime.js';
import {
  SIMULATED_NOTE,
  SIMULATED_RUNTIME,
  createSimulatedNeuralBoundary,
  createSimulatedNeuralTransport,
  simulatedProposals,
} from '../src/neural/simulated.js';
import {
  describeNeuralBoundary,
  neuralBoundaryProblems,
  renderNeuralBoundary,
} from '../src/neural/diagnostics.js';
import { checkSteps } from '../src/tasks/planner.js';
import { ValidationError } from '../src/errors.js';
import { createApp } from '../src/app.js';
import { cleanup, makeTempDataDir } from './helpers.js';

const dirs = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    try { cleanup(dirs.pop()); } catch { /* already removed */ }
  }
});

const REQUEST = buildNeuralRequest({ requestId: 'req-1', text: 'Coffee is bitter' }).request;
const RUNTIME = SIMULATED_RUNTIME;

function reply(overrides = {}) {
  return JSON.stringify({
    schema: NEURAL_RESPONSE_SCHEMA,
    requestId: REQUEST.requestId,
    status: 'ok',
    proposals: [],
    runtime: RUNTIME,
    error: null,
    ...overrides,
  });
}

const KNOWLEDGE = { kind: 'knowledge_claim', confidence: 0.6, payload: { subject: 'Coffee', relationship: 'is', object: 'bitter' } };
const MEMORY = { kind: 'memory_claim', confidence: 0.5, payload: { content: 'the meeting is on Friday' } };
const PLAN = {
  kind: 'plan',
  confidence: 0.5,
  payload: { steps: [{ id: 's1', description: 'report status', action: 'app.status', input: {}, depends_on: [] }] },
};

// A transport whose reply the test controls. It records every invocation.
function controllableTransport({ name = 'test-transport', simulated = false, inferenceTested = false } = {}) {
  const calls = [];
  let settle = null;
  const transport = {
    name,
    simulated,
    inferenceTested,
    calls,
    invoke(request, meta) {
      calls.push({ request, meta });
      return new Promise((resolve, reject) => { settle = { resolve, reject }; });
    },
  };
  return { transport, calls, settleWith: (value) => settle.resolve(value), failWith: (err) => settle.reject(err) };
}

function stepsOf(proposal) {
  return proposal.payload.steps.map((s) => ({
    id: s.id,
    description: s.description,
    action: s.action,
    input: s.input,
    dependsOn: s.depends_on,
  }));
}

describe('neural request contract: strict, bounded, refused rather than clamped', () => {
  test('a valid request names the schema, one kind, the bounds, and a deadline', () => {
    assert.equal(REQUEST.schema, NEURAL_REQUEST_SCHEMA);
    assert.equal(REQUEST.kind, 'propose');
    assert.deepEqual(REQUEST.limits, { maxProposals: MAX_PROPOSALS, maxPlanSteps: MAX_PLAN_STEPS, maxOutputChars: MAX_OUTPUT_CHARS });
    assert.equal(REQUEST.deadlineMs, DEFAULT_DEADLINE_MS);
    assert.equal(JSON.parse(JSON.stringify(REQUEST)).input.text, 'Coffee is bitter');
  });

  test('an invalid id, empty text, out-of-range limit, unknown limit, and excessive deadline are refused', () => {
    for (const bad of [
      {},
      { requestId: '', text: 'x' },
      { requestId: 'has space', text: 'x' },
      { requestId: 'x'.repeat(101), text: 'x' },
      { requestId: 'r', text: '   ' },
      { requestId: 'r', text: 42 },
    ]) {
      assert.throws(() => buildNeuralRequest(bad), ValidationError, JSON.stringify(bad));
    }
    assert.throws(() => buildNeuralRequest({ requestId: 'r', text: 'x', limits: { maxProposals: 0 } }), /maxProposals/);
    assert.throws(() => buildNeuralRequest({ requestId: 'r', text: 'x', limits: { maxProposals: MAX_PROPOSALS + 1 } }), /maxProposals/);
    assert.throws(() => buildNeuralRequest({ requestId: 'r', text: 'x', limits: { maxPlanSteps: 1.5 } }), /maxPlanSteps/);
    assert.throws(() => buildNeuralRequest({ requestId: 'r', text: 'x', limits: { maxOutputChars: 'many' } }), /maxOutputChars/);
    assert.throws(() => buildNeuralRequest({ requestId: 'r', text: 'x', limits: { temperature: 1 } }), /unexpected field "temperature"/);
    assert.throws(() => buildNeuralRequest({ requestId: 'r', text: 'x', deadlineMs: 0 }), /deadlineMs/);
    assert.throws(() => buildNeuralRequest({ requestId: 'r', text: 'x', deadlineMs: MAX_DEADLINE_MS + 1 }), /deadlineMs/);
  });

  test('a body larger than the request cap is refused, never truncated', () => {
    assert.throws(
      () => buildNeuralRequest({ requestId: 'r', text: 'x'.repeat(MAX_REQUEST_CHARS + 1) }),
      new RegExp(`the limit is ${MAX_REQUEST_CHARS}`),
    );
    // Framing overhead is counted too: a body at the cap cannot fit once it is wrapped.
    assert.throws(() => buildNeuralRequest({ requestId: 'r', text: 'x'.repeat(MAX_REQUEST_CHARS - 40) }), /request line/);
  });
});

describe('neural response validation: one object or a whole refusal', () => {
  test('each accepted kind is returned frozen, advisory, and without authority', () => {
    const res = validateNeuralResponse(reply({ proposals: [KNOWLEDGE, MEMORY, PLAN] }), REQUEST);
    assert.equal(res.ok, true);
    assert.equal(res.outcome, NeuralOutcome.VALID);
    assert.equal(res.code, null);
    assert.deepEqual(res.proposals.map((p) => p.kind), PROPOSAL_KINDS);
    for (const proposal of res.proposals) {
      assert.equal(Object.isFrozen(proposal), true);
      assert.equal(proposal.advisory, true);
      assert.equal(proposal.authorizes, false);
    }
    assert.equal(res.proposals[1].confidence, 0.5);
    assert.equal(res.proposals[1].payload.content, 'the meeting is on Friday');
    assert.equal(res.runtime.name, SIMULATED_RUNTIME.name);
    assert.deepEqual(res.counts, { received: 3, accepted: 3, ignored: 0 });
  });

  test('an empty answer is a failure that says so, not an empty success', () => {
    const res = validateNeuralResponse(reply(), REQUEST);
    assert.equal(res.ok, false);
    assert.equal(res.outcome, NeuralOutcome.EMPTY);
    assert.equal(res.code, NeuralFailureCode.EMPTY_RESPONSE);
    assert.match(res.message, /no usable proposal/);
  });

  test('transport-level problems are named: not text, not JSON, not one object, wrong request, wrong version', () => {
    assert.equal(validateNeuralResponse({}, REQUEST).code, NeuralFailureCode.MALFORMED_RESPONSE);
    assert.equal(validateNeuralResponse('not json', REQUEST).code, NeuralFailureCode.MALFORMED_RESPONSE);
    assert.equal(validateNeuralResponse('[]', REQUEST).code, NeuralFailureCode.MALFORMED_RESPONSE);
    assert.equal(validateNeuralResponse(`{"schema":"apex.neural.response/2"}`, REQUEST).code, NeuralFailureCode.UNSUPPORTED_VERSION);
    assert.equal(validateNeuralResponse(reply({ requestId: 'other' }), REQUEST).code, NeuralFailureCode.MALFORMED_RESPONSE);
    assert.equal(validateNeuralResponse(reply({ status: 'maybe' }), REQUEST).code, NeuralFailureCode.MALFORMED_RESPONSE);
    assert.match(validateNeuralResponse(reply({ verified: true }), REQUEST).message, /unexpected field "verified"/);
    assert.equal(validateNeuralResponse('x'.repeat(MAX_RESPONSE_CHARS + 1), REQUEST).code, NeuralFailureCode.RESPONSE_TOO_LARGE);
  });

  test('unavailable and error replies are distinct classes and cannot carry proposals', () => {
    const unavailable = validateNeuralResponse(reply({ status: 'unavailable', proposals: [], error: null }), REQUEST);
    assert.equal(unavailable.code, NeuralFailureCode.UNAVAILABLE);
    assert.equal(unavailable.outcome, NeuralOutcome.UNAVAILABLE);
    assert.equal(unavailable.runtime.name, SIMULATED_RUNTIME.name);

    assert.equal(
      validateNeuralResponse(reply({ status: 'unavailable', proposals: [KNOWLEDGE] }), REQUEST).code,
      NeuralFailureCode.MALFORMED_RESPONSE,
    );

    const errored = validateNeuralResponse(
      reply({ status: 'error', proposals: [], error: { code: 'RUNTIME_ERROR', message: 'the runtime stopped' } }),
      REQUEST,
    );
    assert.equal(errored.code, NeuralFailureCode.RUNTIME_ERROR);
    assert.equal(errored.outcome, NeuralOutcome.ERROR);
    assert.deepEqual(errored.error, { code: 'RUNTIME_ERROR', message: 'the runtime stopped' });

    assert.equal(validateNeuralResponse(reply({ status: 'error', error: null }), REQUEST).code, NeuralFailureCode.MALFORMED_RESPONSE);
    assert.equal(
      validateNeuralResponse(reply({ status: 'error', error: { code: 'X', message: 'x' }, proposals: [MEMORY] }), REQUEST).code,
      NeuralFailureCode.MALFORMED_RESPONSE,
    );
  });

  test('an unknown proposal kind is ignored and counted; a malformed known kind rejects the whole reply', () => {
    const mixed = validateNeuralResponse(
      reply({ proposals: [{ kind: 'shell_command', payload: { command: 'rm -rf /' } }, MEMORY] }),
      REQUEST,
    );
    assert.equal(mixed.ok, true);
    assert.deepEqual(mixed.proposals.map((p) => p.kind), ['memory_claim']);
    assert.deepEqual(mixed.ignoredKinds, ['shell_command']);
    assert.deepEqual(mixed.counts, { received: 2, accepted: 1, ignored: 1 });

    for (const [proposal, expected] of [
      [{ kind: 'plan', payload: { steps: [] } }, /1 to 8 steps/],
      [{ kind: 'plan', payload: { steps: [{ id: 'S1', description: 'x', action: 'app.status', input: {} }] } }, /lowercase/],
      [{ kind: 'plan', payload: { steps: [{ id: 's1', description: 'x\nfake record', action: 'app.status', input: {} }] } }, /one line/],
      [{ kind: 'plan', payload: { steps: [{ id: 's1', description: 'x', action: 'app status', input: {} }] } }, /action-name grammar/],
      [{ kind: 'plan', payload: { steps: [{ id: 's1', description: 'x', action: 'app.status', input: 'y' }] } }, /input must be an object/],
      [{ kind: 'knowledge_claim', payload: { subject: 'A', relationship: 'is', object: 'B', confidence: 0.9 } }, /unexpected field "confidence"/],
      [{ kind: 'memory_claim', payload: { content: 'x', private: true } }, /unexpected field "private"/],
      [{ kind: 'memory_claim', payload: { content: 'x', importance: 0.9 } }, /unexpected field "importance"/],
      [{ ...KNOWLEDGE, authority: 'user' }, /unexpected field "authority"/],
      [{ ...KNOWLEDGE, confidence: 2 }, /confidence must be a number from 0 to 1/],
      [{ ...MEMORY, verified: true }, /unexpected field "verified"/],
    ]) {
      const res = validateNeuralResponse(reply({ proposals: [proposal] }), REQUEST);
      assert.equal(res.ok, false, JSON.stringify(proposal));
      assert.equal(res.code, NeuralFailureCode.MALFORMED_RESPONSE, JSON.stringify(proposal));
      assert.match(res.message, expected, JSON.stringify(proposal));
      assert.deepEqual(res.proposals, [], 'no proposal survives a rejected reply');
    }
  });

  test('the reply cannot exceed the proposal, step, or output bounds the request declared', () => {
    const many = buildNeuralRequest({ requestId: 'req-2', text: 'x', limits: { maxProposals: 1 } }).request;
    const two = validateNeuralResponse(reply({ requestId: 'req-2', proposals: [KNOWLEDGE, MEMORY] }), many);
    assert.equal(two.code, NeuralFailureCode.MALFORMED_RESPONSE);
    assert.match(two.message, /the request allowed 1/);

    const short = buildNeuralRequest({ requestId: 'req-3', text: 'x', limits: { maxPlanSteps: 1, maxOutputChars: 10 } }).request;
    const longPlan = {
      kind: 'plan',
      payload: {
        steps: [
          { id: 's1', description: 'one', action: 'app.status', input: {} },
          { id: 's2', description: 'two', action: 'app.status', input: {} },
        ],
      },
    };
    assert.match(validateNeuralResponse(reply({ requestId: 'req-3', proposals: [longPlan] }), short).message, /1 to 1 steps/);
    const longDescription = { kind: 'plan', payload: { steps: [{ id: 's1', description: 'x'.repeat(50), action: 'app.status', input: {} }] } };
    assert.match(validateNeuralResponse(reply({ requestId: 'req-3', proposals: [longDescription] }), short).message, /description must be/);
  });
});

describe('lifecycle: one request at a time, and only a caller may retry', () => {
  test('a refused second request does not become in flight and is counted', async () => {
    const ctl = controllableTransport();
    const boundary = new NeuralRuntimeBoundary({ transport: ctl.transport });
    const first = boundary.propose({ text: 'one', requestId: 'a' });
    const second = await boundary.propose({ text: 'two', requestId: 'b' });
    assert.equal(second.ok, false);
    assert.equal(second.code, NeuralFailureCode.REQUEST_IN_PROGRESS);
    assert.equal(second.outcome, NeuralOutcome.IN_PROGRESS);
    assert.match(second.message, /already in progress/);
    const mid = boundary.lifecycle.snapshot();
    assert.equal(mid.inFlight, 'a');
    assert.equal(mid.counts.requests, 1);
    assert.equal(mid.counts.rejected, 1);

    ctl.settleWith(reply({ requestId: 'a', proposals: [MEMORY] }));
    const done = await first;
    assert.equal(done.ok, true);
    const after = boundary.lifecycle.snapshot();
    assert.equal(after.inFlight, null);
    assert.equal(after.counts.completed, 1);
    assert.equal(after.last.requestId, 'a');
    assert.equal(typeof after.last.requestChars, 'number');
    assert.equal(after.last.proposalsAccepted, 1);
    // The diagnostic record never carries prompt or reply text.
    assert.doesNotMatch(JSON.stringify(after), /Coffee|bitter/);
  });

  test('only timeout and unavailable are retryable, and only by the caller', () => {
    assert.equal(retryableOutcome(NeuralOutcome.TIMEOUT), true);
    assert.equal(retryableOutcome(NeuralOutcome.UNAVAILABLE), true);
    for (const outcome of Object.values(NeuralOutcome)) {
      if (outcome === NeuralOutcome.TIMEOUT || outcome === NeuralOutcome.UNAVAILABLE) continue;
      assert.equal(retryableOutcome(outcome), false, outcome);
    }
    assert.equal(outcomeForCode(NeuralFailureCode.TIMEOUT), NeuralOutcome.TIMEOUT);
    assert.equal(outcomeForCode(NeuralFailureCode.MALFORMED_RESPONSE), NeuralOutcome.MALFORMED);
    assert.equal(outcomeForCode('SOMETHING_NEW'), NeuralOutcome.UNAVAILABLE);
  });

  test('a completion that throws does not leave the boundary busy', () => {
    const lifecycle = new NeuralLifecycle();
    lifecycle.begin('a');
    lifecycle.finish(NeuralOutcome.ERROR, { requestId: 'a' });
    assert.equal(lifecycle.busy, false);
    assert.equal(lifecycle.snapshot().counts.errored, 1);
  });
});

describe('runtime boundary: absent, cancelled, timed out, or answered', () => {
  test('with no transport the boundary reports NOT_CONFIGURED and owns nothing', async () => {
    const boundary = createNeuralBoundary();
    const res = await boundary.propose({ text: 'Coffee is bitter', requestId: 'r1' });
    assert.equal(res.ok, false);
    assert.equal(res.code, NeuralFailureCode.NOT_CONFIGURED);
    assert.equal(res.sent, false);
    assert.equal(res.inferenceTested, false);
    assert.equal(res.authorizes, false);
    assert.equal(boundary.lifecycle.snapshot().counts.requests, 0);
    const described = boundary.describe();
    assert.equal(described.configured, false);
    assert.equal(described.transport, null);
    assert.equal(described.verified, false);
    assert.equal(described.probed, false);
    assert.equal(described.inferenceTested, false);
    assert.equal(described.isolation.processTransport, false);
    assert.match(described.note, /no neural runtime is connected/);
  });

  test('an unsendable request is refused before the transport is touched', async () => {
    const ctl = controllableTransport();
    const boundary = new NeuralRuntimeBoundary({ transport: ctl.transport });
    const res = await boundary.propose({ text: '   ', requestId: 'r1' });
    assert.equal(res.code, NeuralFailureCode.INVALID_REQUEST);
    assert.equal(res.sent, false);
    assert.deepEqual(ctl.calls, []);
  });

  test('a caller cancellation before send is CANCELLED, and the transport is never invoked', async () => {
    const ctl = controllableTransport();
    const boundary = new NeuralRuntimeBoundary({ transport: ctl.transport });
    const controller = new AbortController();
    controller.abort();
    const res = await boundary.propose({ text: 'Coffee is bitter', requestId: 'r1', signal: controller.signal });
    assert.equal(res.code, NeuralFailureCode.CANCELLED);
    assert.equal(res.sent, false);
    assert.deepEqual(ctl.calls, []);
    assert.equal(boundary.lifecycle.snapshot().counts.cancelled, 1);
  });

  test('a reply that arrives after cancellation never becomes a result', async () => {
    const ctl = controllableTransport();
    const boundary = new NeuralRuntimeBoundary({ transport: ctl.transport });
    const controller = new AbortController();
    const pending = boundary.propose({ text: 'Coffee is bitter', requestId: 'r1', signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctl.calls.length, 1);
    controller.abort();
    const res = await pending;
    assert.equal(res.code, NeuralFailureCode.CANCELLED);
    assert.equal(res.sent, true);
    assert.deepEqual(res.proposals, []);
    // The transport still resolves afterwards; the boundary drops the reply and stays usable.
    ctl.settleWith(reply({ requestId: 'r1', proposals: [MEMORY] }));
    await new Promise((resolve) => setImmediate(resolve));
    const after = boundary.lifecycle.snapshot();
    assert.equal(after.inFlight, null);
    assert.equal(after.counts.completed, 0, 'a cancelled request is not counted as completed');
    assert.equal(after.counts.cancelled, 1);
  });

  test('a transport that ignores its signal still ends at the deadline, and only the caller may retry', async () => {
    const pending = { name: 'never-answers', simulated: false, inferenceTested: false, invoke: () => new Promise(() => {}) };
    const boundary = new NeuralRuntimeBoundary({ transport: pending });
    const started = Date.now();
    const res = await boundary.propose({ text: 'Coffee is bitter', requestId: 'r1', deadlineMs: 25 });
    assert.equal(res.code, NeuralFailureCode.TIMEOUT);
    assert.equal(res.outcome, NeuralOutcome.TIMEOUT);
    assert.equal(res.retryableByCaller, true);
    assert.equal(res.sent, true);
    assert.ok(res.latencyMs >= 0);
    assert.ok(Date.now() - started < 5000, 'the deadline ended the wait');
    assert.match(res.message, /not replayed automatically/);
    assert.equal(boundary.lifecycle.snapshot().counts.timedOut, 1);
  });

  test('a transport that throws is UNREACHABLE, not a model answer', async () => {
    const ctl = controllableTransport();
    const boundary = new NeuralRuntimeBoundary({ transport: ctl.transport });
    const pending = boundary.propose({ text: 'Coffee is bitter', requestId: 'r1' });
    await new Promise((resolve) => setImmediate(resolve));
    ctl.failWith(new Error('socket closed'));
    const res = await pending;
    assert.equal(res.code, NeuralFailureCode.UNREACHABLE);
    assert.equal(res.outcome, NeuralOutcome.UNAVAILABLE);
    assert.equal(res.retryableByCaller, true, 'a reply that never arrived is retryable by the caller');
    assert.deepEqual(res.proposals, []);
  });

  test('an accepted reply carries provenance that states it is unverified model output', async () => {
    const ctl = controllableTransport({ name: 'contract-test', simulated: true });
    const boundary = new NeuralRuntimeBoundary({ transport: ctl.transport });
    const pending = boundary.propose({ text: 'Coffee is bitter', requestId: 'r1' });
    await new Promise((resolve) => setImmediate(resolve));
    ctl.settleWith(reply({ requestId: 'r1', proposals: [KNOWLEDGE] }));
    const res = await pending;
    assert.equal(res.ok, true);
    assert.equal(res.simulated, true);
    assert.equal(res.inferenceTested, false);
    assert.equal(res.authorizes, false);
    assert.equal(res.executed, false);
    assert.equal(res.recorded, false);
    assert.deepEqual(res.provenance, {
      origin: 'model_output',
      backend: 'neural-runtime',
      runtime: SIMULATED_RUNTIME.name,
      runtimeVersion: SIMULATED_RUNTIME.version,
      modelId: SIMULATED_RUNTIME.modelId,
      verified: false,
    });
    assert.equal(res.proposals[0].authorizes, false);
  });
});

describe('simulated transport: deterministic rules, never a claim about a model', () => {
  test('the same text always yields the same proposals, and the note says what it is', () => {
    for (const text of ['Coffee is bitter', 'remember that the meeting is on Friday', 'please plan my day', 'nothing here']) {
      assert.deepEqual(simulatedProposals(text), simulatedProposals(text), text);
    }
    assert.deepEqual(simulatedProposals('remember that the meeting is on Friday'), [{
      kind: 'memory_claim', confidence: 0.5, payload: { content: 'the meeting is on Friday' },
    }]);
    assert.deepEqual(simulatedProposals('Coffee is bitter'), [{
      kind: 'knowledge_claim', confidence: 0.4, payload: { subject: 'Coffee', relationship: 'is', object: 'bitter' },
    }]);
    assert.deepEqual(simulatedProposals('nothing here'), []);
    assert.equal(simulatedProposals('Coffee is bitter', { maxProposals: 0 }).length, 0);
    assert.match(SIMULATED_NOTE, /no neural model, no inference, no training/);
    const transport = createSimulatedNeuralTransport();
    assert.equal(transport.simulated, true);
    assert.equal(transport.inferenceTested, false);
  });

  test('a simulated boundary answers through the real contract with a simulated provenance', async () => {
    const boundary = createSimulatedNeuralBoundary();
    const res = await boundary.propose({ text: 'Coffee is bitter', requestId: 'sim-1' });
    assert.equal(res.ok, true);
    assert.equal(res.simulated, true);
    assert.equal(res.proposals[0].kind, 'knowledge_claim');
    assert.equal(res.provenance.verified, false);
    assert.equal(boundary.describe().transport.simulated, true);
    assert.equal(boundary.describe().transport.inferenceTested, false);
  });
});

describe('nothing a runtime proposes reaches a store or becomes authorized work', () => {
  test('claims cannot be turned into plan steps, and the write-capable step is refused by name', async () => {
    const app = createApp({ dataDir: tempDir() });
    const memory = validateNeuralResponse(reply({ proposals: [MEMORY] }), REQUEST).proposals[0];
    const memoryCheck = checkSteps([{
      id: 's1',
      description: 'store the claim',
      action: 'memory.add',
      input: { content: memory.payload.content },
      dependsOn: [],
    }], app.registry, 'model');
    assert.match(memoryCheck.problems.join('\n'), /cannot be stored as a user fact/);
    assert.deepEqual(memoryCheck.steps, []);

    const knowledge = validateNeuralResponse(reply({ proposals: [KNOWLEDGE] }), REQUEST).proposals[0];
    const knowledgeCheck = checkSteps([{
      id: 's1',
      description: 'record the claim',
      action: 'knowledge.add',
      input: { ...knowledge.payload },
      dependsOn: [],
    }], app.registry, 'model');
    assert.match(knowledgeCheck.problems.join('\n'), /cannot be part of a plan/);
    assert.deepEqual(knowledgeCheck.steps, []);

    // The same knowledge step is refused for a user plan too: the action is not plannable at all.
    const userCheck = checkSteps([{
      id: 's1', description: 'record the claim', action: 'knowledge.add', input: { ...knowledge.payload }, dependsOn: [],
    }], app.registry, 'user');
    assert.match(userCheck.problems.join('\n'), /cannot be part of a plan/);
  });

  test('a read-only plan proposal survives the planner as a read step, not as an action that ran', async () => {
    const app = createApp({ dataDir: tempDir() });
    const plan = validateNeuralResponse(reply({ proposals: [PLAN] }), REQUEST).proposals[0];
    const checked = checkSteps(stepsOf(plan), app.registry, 'model');
    assert.deepEqual(checked.problems, []);
    assert.equal(checked.steps.length, 1);
    assert.equal(checked.steps[0].action, 'app.status');
    assert.equal(checked.steps[0].permission, 'read');
    // Checking is not running: no operation, task, or memory record exists afterwards.
    assert.deepEqual(await app.memory.list({ limit: 10 }), []);
    assert.deepEqual(await app.taskStore.list(), []);
    assert.deepEqual((await app.operations.list({ limit: 10 })).records, []);
  });

  test('a proposal is frozen data: it carries no method and cannot be executed', () => {
    const proposal = validateNeuralResponse(reply({ proposals: [KNOWLEDGE] }), REQUEST).proposals[0];
    assert.equal(Object.isFrozen(proposal), true);
    assert.equal(Object.isFrozen(proposal.payload), true);
    assert.equal(typeof proposal.execute, 'undefined');
    assert.throws(() => { proposal.payload.subject = 'Other'; }, TypeError);
  });
});

describe('diagnostics and the registered neural.contract read', () => {
  test('the shipped declaration has no problems and says no inference was run', () => {
    const declaration = describeNeuralBoundary();
    assert.deepEqual(neuralBoundaryProblems(declaration), []);
    assert.equal(declaration.schema, NEURAL_BOUNDARY_SCHEMA);
    assert.equal(declaration.configured, false);
    assert.equal(declaration.simulated.connected, false);
    assert.equal(declaration.simulated.available, true);
    const text = renderNeuralBoundary(declaration);
    assert.match(text, /declared, not probed; no neural inference runs/);
    assert.match(text, /not configured; no runtime is contacted/);
    assert.match(text, /available to tests only, not connected/);
  });

  test('each tampered declaration field is named', () => {
    const base = describeNeuralBoundary();
    const clone = () => structuredClone(base);
    const cases = [
      [(d) => { d.schema = 'apex.neural-boundary/9'; }, /boundary schema/],
      [(d) => { d.requestSchema = 'apex.neural.request/9'; }, /request schema/],
      [(d) => { d.responseSchema = 'other'; }, /response schema/],
      [(d) => { d.configured = 'yes'; }, /configured must be a boolean/],
      [(d) => { d.configured = true; }, /name its transport/],
      [(d) => { d.configured = true; d.transport = { name: 'x', simulated: false, inferenceTested: true }; }, /inference-tested/],
      [(d) => { d.limits.maxRequestChars = 10; }, /maxRequestChars/],
      [(d) => { d.limits.maxDeadlineMs = 1; }, /maxDeadlineMs/],
      [(d) => { d.isolation.runtimeMayInvokeActions = true; }, /must not invoke actions/],
      [(d) => { d.isolation.oneRequestAtATime = false; }, /one request at a time/],
      [(d) => { d.trust.proposalKinds = ['everything']; }, /exactly the accepted three/],
      [(d) => { d.trust.runtimeAuthority = 'full'; }, /no authority/],
      [(d) => { d.trust.executableWithoutUserDecision = true; }, /without a user decision/],
      [(d) => { d.verified = true; }, /must not claim verification/],
      [(d) => { d.probed = true; }, /must not claim a probe/],
      [(d) => { d.inferenceTested = true; }, /no inference has been tested/],
      [(d) => { d.simulated.name = 'gpt-4'; }, /simulated runtime identity/],
      [(d) => { d.lifecycle.counts.timedOut = -1; }, /timedOut/],
    ];
    for (const [tamper, expected] of cases) {
      const declaration = clone();
      tamper(declaration);
      assert.match(neuralBoundaryProblems(declaration).join('\n'), expected);
    }
    const missing = neuralBoundaryProblems(null);
    assert.ok(missing.includes('the boundary schema is not apex.neural-boundary/1'));
    assert.ok(missing.length > 20, 'every missing section is named');
  });

  test('neural.contract is a read-only, unplannable action that verifies and writes nothing', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const def = app.registry.get('neural.contract');
    assert.equal(def.permission, 'read');
    assert.equal(def.plannable, false);
    const before = fs.readdirSync(dir).sort();
    const res = await app.controller.neuralContract();
    assert.equal(res.verified, true);
    assert.equal(res.data.configured, false);
    assert.equal(res.data.inferenceTested, false);
    assert.match(res.display, /Neural runtime boundary/);
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'a declaration read creates no store file');
  });

  test('an injected simulated boundary is reported as configured but still untested', async () => {
    const app = createApp({ dataDir: tempDir(), neuralRuntime: createSimulatedNeuralBoundary() });
    const res = await app.controller.neuralContract();
    assert.equal(res.verified, true);
    assert.equal(res.data.configured, true);
    assert.equal(res.data.transport.name, SIMULATED_RUNTIME.name);
    assert.equal(res.data.transport.simulated, true);
    assert.equal(res.data.transport.inferenceTested, false);
    assert.equal(res.data.inferenceTested, false);
    assert.deepEqual(neuralBoundaryProblems(res.data), []);
    assert.match(res.display, /deterministic simulation/);
  });
});
