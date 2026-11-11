// Batch AO, work package G: bounded runtime diagnostics.
//
// Diagnostics are an observation of what the process did. These tests pin the adversarial half of
// that claim: the record carries no request, model, or evidence text; it cannot grant authority; a
// stage the path did not reach is never reported as executed and a failed stage is never reported as
// a success; cancellation is distinguishable from a timeout; a measurement that does not exist is
// null rather than zero; and a diagnostics fault cannot change the operation's own outcome.
//
// Every model is a fixed-output test double and every data directory is a fresh temp directory. No
// inference is run and no network is used.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import {
  RUNTIME_DIAGNOSTICS_SCHEMA,
  RUNTIME_STAGES,
  DIAGNOSTICS_BOUNDS,
  SpanRecorder,
  StageOutcome,
  buildRuntimeDiagnostics,
  renderRuntimeDiagnostics,
} from '../src/cognition/runtime-diagnostics.js';
import { makeTempDataDir, cleanup } from './helpers.js';

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

// TEST DOUBLE: fixed text, no model.
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

// TEST DOUBLE: reports a transport timeout in the exact shape the HTTP backend produces.
function timeoutGateway() {
  return new ModelGateway({
    timeoutMs: 25,
    backend: {
      name: 'timeout-double',
      provider: 'timeout-double',
      configured: true,
      describe: () => ({ configured: true, provider: 'timeout-double', endpoint: 'timeout-double', model: 'timeout-double' }),
      health: async () => ({ available: false, detail: 'no response' }),
      complete: async () => ({
        ok: false,
        backend: 'timeout-double',
        provider: 'timeout-double',
        error: { code: 'TIMEOUT', message: 'no response within 25 ms' },
        latencyMs: 25,
      }),
    },
  });
}

const appIn = (dir, extra = {}) => createApp({ dataDir: dir, now: CLOCK, experienceCapture: CAPTURE_OFF, ...extra });
const operations = (dir) => {
  const file = path.join(dir, 'operations.jsonl');
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
};

function stageOf(record, id) {
  return record.stages.find((stage) => stage.id === id) ?? null;
}

// A fake lifecycle snapshot in the shape the cognitive contract publishes.
function lifecycleWith(statuses) {
  return {
    stages: statuses.map((status, i) => ({ order: i + 1, status })),
  };
}

describe('AO-08 G1: the recorder measures, and a missing measurement is not zero', () => {
  test('G1.1 a completed span reports the monotonic difference and its counts', () => {
    let now = 1000;
    const recorder = new SpanRecorder({ clock: () => now });
    const span = recorder.start('model_call');
    now += 12.5;
    recorder.end(span, { outcome: StageOutcome.RAN, counts: { calls: 1 } });
    now += 4;
    const snapshot = recorder.snapshot();
    assert.deepEqual(snapshot.stages.model_call, { outcome: 'ran', durationMs: 12.5, counts: { calls: 1 } });
    assert.deepEqual(snapshot.clock, { source: 'performance.now', monotonic: true, fault: false });
    assert.equal(recorder.elapsedTotal(), 16.5);
  });

  test('G1.2 a clock that throws leaves the outcome but no duration, and says so', () => {
    const recorder = new SpanRecorder({ clock: () => { throw new Error('clock unavailable'); } });
    const span = recorder.start('verification');
    recorder.end(span, { outcome: StageOutcome.FAILED, counts: { failed: 1 } });
    const snapshot = recorder.snapshot();
    assert.deepEqual(snapshot.stages.verification, { outcome: 'failed', durationMs: null, counts: { failed: 1 } });
    assert.equal(snapshot.clock.monotonic, false);
    assert.equal(snapshot.clock.fault, true);
    assert.equal(recorder.elapsedTotal(), null);
    const record = buildRuntimeDiagnostics({
      requestId: 'op-clock-fault', spans: snapshot, status: Outcome.VERIFICATION_FAILED, totalDurationMs: recorder.elapsedTotal(),
    });
    assert.equal(record.available, true, 'a failed clock does not make the diagnostics unavailable');
    assert.equal(record.totalMs, null, 'an unread clock is not reported as zero milliseconds');
    assert.equal(stageOf(record, 'verification').durationMs, null);
  });

  test('G1.3 a clock that moves backwards is a timing fault, not a zero-length stage', () => {
    let now = 5000;
    const recorder = new SpanRecorder({ clock: () => now });
    const span = recorder.start('execution');
    now = 4000;
    recorder.end(span, { outcome: StageOutcome.RAN });
    assert.equal(recorder.snapshot().stages.execution.durationMs, null);
    assert.equal(recorder.snapshot().clock.fault, true);
  });

  test('G1.4 a span that was entered but never ended is unavailable, not ran and not skipped', () => {
    const recorder = new SpanRecorder({ clock: () => 1 });
    recorder.start('execution');
    const stage = recorder.snapshot().stages.execution;
    assert.equal(stage.outcome, StageOutcome.UNAVAILABLE);
    assert.equal(stage.durationMs, null);
  });

  test('G1.5 an unknown stage name is refused rather than added to the record', () => {
    const recorder = new SpanRecorder({ clock: () => 1 });
    assert.equal(recorder.start('invented_stage'), null);
    recorder.mark('invented_stage');
    recorder.addDuration('invented_stage', 5);
    assert.deepEqual(recorder.snapshot().stages, {});
  });

  test('G1.6 a merged stage is never upgraded: failed outranks ran, and counts stay bounded', () => {
    const recorder = new SpanRecorder({ clock: () => 1 });
    recorder.mark('execution', { outcome: StageOutcome.RAN, counts: { steps: 2 } });
    recorder.mark('execution', { outcome: StageOutcome.FAILED, counts: { steps: 1, failed: 1 } });
    const stage = recorder.snapshot().stages.execution;
    assert.equal(stage.outcome, StageOutcome.FAILED);
    assert.deepEqual(stage.counts, { steps: 3, failed: 1 });

    const many = {};
    for (let i = 0; i < 30; i += 1) many[`k${i}`] = i;
    many.Bad_Key = 1;
    many.negative = -3;
    recorder.mark('verification', { counts: many });
    const counts = recorder.snapshot().stages.verification.counts;
    assert.ok(Object.keys(counts).length <= DIAGNOSTICS_BOUNDS.maxCountKeys);
    assert.ok(!('Bad_Key' in counts) && !('negative' in counts));
  });
});

describe('AO-08 G2: the record states outcomes from what ran, and authorizes nothing', () => {
  const baseCognition = (statuses, timings = {}) => ({
    available: true,
    timings,
    lifecycle: lifecycleWith(statuses),
    evidence: { total: 3, dropped: 0 },
    claims: { total: 2, material: 1, supported: 1, contradicted: 1, inference: 0, unknown: 0, expectation: 0 },
    decision: 'answer',
    uncertainty: 'conflicting_evidence',
    clarification: false,
  });

  test('G2.1 a skipped stage has an outcome and no duration; a ran stage without a timing is null', () => {
    const statuses = ['ran', 'ran', 'ran', 'ran', 'skipped', 'skipped', 'not_reached', 'not_reached', 'not_reached', 'not_reached'];
    const record = buildRuntimeDiagnostics({
      requestId: 'op-2',
      cognition: baseCognition(statuses, { request: 1.25, retrieval: 2.5, claims: 0.5, contradictions: null, deliberation: null, brief: null }),
      spans: null,
      status: Outcome.CLARIFICATION_REQUIRED,
      totalDurationMs: 9,
    });
    assert.equal(record.available, true);
    assert.equal(record.schema, RUNTIME_DIAGNOSTICS_SCHEMA);
    assert.equal(record.stages.length, RUNTIME_STAGES.length);
    assert.equal(stageOf(record, 'request_interpretation').outcome, 'ran');
    assert.equal(stageOf(record, 'request_interpretation').durationMs, 1.25);
    assert.equal(stageOf(record, 'claim_extraction').durationMs, 0.5);
    assert.equal(stageOf(record, 'deliberation').outcome, 'skipped');
    assert.equal(stageOf(record, 'deliberation').durationMs, null, 'a skipped stage measured no duration');
    assert.equal(stageOf(record, 'grounded_response').outcome, 'skipped');
    assert.equal(stageOf(record, 'model_call').outcome, 'not_reached');
    assert.equal(stageOf(record, 'finalization').outcome, 'not_reached');
    assert.equal(record.measuredStages, 3);
    assert.equal(record.cognitive.claims, 2);
    assert.equal(record.cognitive.contradicted, 1);
    assert.equal(record.cognitive.evidence, 3);
    assert.equal(record.failure.category, 'clarification');
    assert.equal(record.authorizes, false);
  });

  test('G2.2 a stage with a missing timing is not measured, even when the lifecycle says it ran', () => {
    const record = buildRuntimeDiagnostics({
      requestId: 'op-3',
      cognition: baseCognition(['ran', 'ran', 'ran', 'ran', 'ran', 'ran', 'not_reached', 'not_reached', 'not_reached', 'not_reached'], { request: 1 }),
      status: Outcome.SUCCESS_VERIFIED,
    });
    assert.equal(stageOf(record, 'evidence_retrieval').outcome, 'ran');
    assert.equal(stageOf(record, 'evidence_retrieval').durationMs, null);
    assert.equal(record.measuredStages, 1);
  });

  test('G2.3 a stage the path never entered is not reachable through a stray timing', () => {
    const record = buildRuntimeDiagnostics({
      requestId: 'op-4',
      cognition: baseCognition(['ran', 'ran', 'ran', 'ran', 'ran', 'ran', 'not_reached', 'not_reached', 'not_reached', 'not_reached'], {
        request: 1, retrieval: 1, claims: 1, contradictions: 1, deliberation: 1, brief: 1,
      }),
      status: Outcome.SUCCESS_VERIFIED,
    });
    for (const id of ['model_call', 'model_output_validation', 'proposal_validation', 'handoff_preparation', 'authorization', 'execution', 'verification', 'task_execution', 'finalization']) {
      assert.equal(stageOf(record, id).outcome, 'not_reached', `${id} was not reached`);
      assert.equal(stageOf(record, id).durationMs, null);
    }
  });

  test('G2.4 retries are stated as unavailable when no count exists, never invented as zero', () => {
    const unknown = buildRuntimeDiagnostics({ requestId: 'op-5', status: Outcome.EXECUTION_FAILED, retries: null });
    assert.deepEqual(unknown.retries, { available: false, count: null });
    const none = buildRuntimeDiagnostics({ requestId: 'op-6', status: Outcome.SUCCESS_VERIFIED, retries: 0 });
    assert.deepEqual(none.retries, { available: true, count: 0 });
  });

  test('G2.5 the record is bounded: fixed stage list, bounded counts, and a duration cap', () => {
    const recorder = new SpanRecorder({ clock: () => 0 });
    const counts = {};
    for (let i = 0; i < 40; i += 1) counts[`c${i}`] = i;
    recorder.mark('execution', { counts });
    const record = buildRuntimeDiagnostics({
      requestId: 'op-7', spans: recorder.snapshot(), status: Outcome.SUCCESS_VERIFIED, totalDurationMs: 10 * 24 * 60 * 60 * 1000,
    });
    assert.equal(record.stages.length, RUNTIME_STAGES.length);
    assert.ok(record.stages.every((stage) => Object.keys(stage.counts).length <= DIAGNOSTICS_BOUNDS.maxCountKeys));
    assert.equal(record.totalMs, DIAGNOSTICS_BOUNDS.maxDurationMs);
    assert.deepEqual(record.bounds, {
      stages: DIAGNOSTICS_BOUNDS.maxStages, countsPerStage: DIAGNOSTICS_BOUNDS.maxCountKeys,
    });
  });

  test('G2.6 an accessor that throws makes the diagnostics unavailable without throwing', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'errors', { get() { throw new Error('record is damaged'); } });
    const record = buildRuntimeDiagnostics({
      requestId: 'op-8', operation: hostile, status: Outcome.REQUEST_CANCELLED,
    });
    assert.equal(record.available, false);
    assert.equal(record.error, 'diagnostics_unavailable');
    assert.equal(record.authorizes, false);
    assert.equal(record.totalMs, null);
    assert.equal(record.requestId, 'op-8');
  });
});

describe('AO-08 G3: no request, model, evidence, or secret text reaches the record', () => {
  test('G3.1 the record and its rendered form contain only identifiers, outcomes, durations, and counts', () => {
    const secrets = ['hunter2', 'swingline', 'vault passphrase', 'the model said this'];
    const operation = {
      id: 'op-9',
      status: Outcome.VERIFICATION_FAILED,
      errors: [{ stage: 'verification', code: 'VERIFICATION_FAILED', message: 'the vault passphrase did not read back' }],
      output: 'the model said this and hunter2 is the vault passphrase',
      steps: [{ action: 'memory.add', input: { content: 'the vault passphrase is swingline' }, summary: 'stored hunter2' }],
      model: { name: 'stub', provider: 'stub', latencyMs: 1 },
      handoff: { kind: 'plan_activation', state: 'failed', task: { id: 't-1' } },
    };
    const cognition = {
      available: true,
      timings: { request: 1 },
      lifecycle: lifecycleWith(['ran', 'ran', 'ran', 'ran', 'ran', 'ran', 'ran', 'ran', 'ran', 'failed']),
      evidence: { total: 2, dropped: 0 },
      claims: { total: 1, material: 1, supported: 0, contradicted: 1, inference: 0, unknown: 0, expectation: 0 },
      decision: 'answer',
      uncertainty: 'conflicting_evidence',
      clarification: false,
      // Raw claim text must not be copied into the summary.
      claimList: [{ text: 'the vault passphrase is hunter2', kind: 'contradicted' }],
      raw: 'the model said this',
      trace: { boundary: { proposals: { observed: 1 }, authorization: { allowed: 1 }, execution: { ran: 1 }, verification: { failed: 1 } } },
    };
    const record = buildRuntimeDiagnostics({ requestId: 'op-9', operation, cognition, status: operation.status, totalDurationMs: 5 });
    assert.equal(record.available, true);
    const serialized = JSON.stringify(record);
    for (const secret of secrets) assert.ok(!serialized.includes(secret), `the record leaked ${JSON.stringify(secret)}`);
    const rendered = renderRuntimeDiagnostics(record);
    for (const secret of secrets) assert.ok(!rendered.includes(secret));
    assert.ok(rendered.includes('finalization'));
  });

  test('G3.2 a full request stores diagnostics with no request, reply, or memory text', async () => {
    const dir = tempDir();
    const app = appIn(dir, { gateway: stubGateway('The lighthouse status is green, and hunter2 is the passphrase.') });
    await app.memory.add({ content: 'the lighthouse project status is green; the vault passphrase is swingline', kind: 'user_fact', source: 'user' });
    const res = await app.controller.handle('what is the lighthouse status and the vault passphrase hunter2?', { origin: 'user' });
    const record = res.operation.diagnostics;
    assert.equal(record.available, true);
    const serialized = JSON.stringify(record);
    for (const text of ['hunter2', 'swingline', 'lighthouse status is green', 'The lighthouse status is green']) {
      assert.ok(!serialized.includes(text), `the diagnostics record leaked ${JSON.stringify(text)}`);
    }
    const stored = operations(dir).find((op) => op.id === res.operation.id);
    assert.deepEqual(stored.diagnostics, record, 'the persisted record is the returned record');
  });
});

describe('AO-08 G4: the request path reports its real stages', () => {
  test('G4.1 a grounded answer records the stages it ran, each with a duration and no authority', async () => {
    const dir = tempDir();
    let recordId = null;
    const app = appIn(dir, {
      gateway: stubGateway(() => [
        'The AO-08 fact is recorded.',
        `COGNITION ${JSON.stringify({
          schema: 1,
          decision: 'answer',
          answer: 'The AO-08 fact is recorded.',
          claims: [{ text: 'the AO-08 diagnostic fact is recorded', evidence: [`ev:memory:${recordId}`], kind: 'supported' }],
          uncertainty: 'supported_but_incomplete',
          disclosures: [],
          missing: [],
        })}`,
      ].join('\n')),
    });
    recordId = (await app.memory.add({ content: 'the AO-08 diagnostic fact is recorded', kind: 'user_fact', source: 'user' })).id;

    const res = await app.controller.handle('is the AO-08 diagnostic fact recorded?', { origin: 'user' });
    const record = res.operation.diagnostics;
    assert.equal(record.available, true);
    assert.equal(record.requestId, res.operation.id);
    assert.equal(record.status, res.operation.status);
    assert.equal(record.authorizes, false);
    for (const id of ['request_interpretation', 'evidence_retrieval', 'claim_extraction', 'deliberation', 'model_call', 'model_output_validation', 'proposal_validation', 'finalization']) {
      const stage = stageOf(record, id);
      assert.equal(stage.outcome, 'ran', `${id} ran`);
      assert.ok(Number.isFinite(stage.durationMs), `${id} recorded a duration`);
    }
    assert.ok(Number.isFinite(record.totalMs) && record.totalMs >= 0);
    assert.equal(record.cognitive.available, true);
    assert.ok(record.cognitive.claims >= 1, 'the analysis extracted at least the supported claim');
    assert.ok(record.cognitive.supported >= 1);
    assert.equal(record.cognitive.contradicted, 0);
    assert.equal(record.cognitive.validation.ok, true);
    assert.deepEqual(record.cancellation, { requested: false, afterResponse: false }, 'the request states that it was not cancelled');
    assert.deepEqual(record.retries, { available: false, count: null }, 'the transport did not expose an attempt count');
    for (const id of ['handoff_preparation', 'plan_validation', 'authorization', 'execution', 'verification', 'task_execution']) {
      assert.equal(stageOf(record, id).outcome, 'not_reached', `${id} was not reached by an answer with no proposal`);
    }
  });

  test('G4.2 a command operation says only finalization was measured', async () => {
    const dir = tempDir();
    const app = appIn(dir, { gateway: stubGateway('unused') });
    const added = await app.controller.planAdd({
      outcome: 'the diagnostic command fixture is stored',
      reason: 'AO-08 fixture',
      steps: [{ id: 's1', description: 'do the fixture step', action: 'memory.search', input: { query: 'x' }, dependsOn: [], expectedResult: 'records are listed', verification: 'a record is named', risk: 'low' }],
    });
    assert.equal(added.status, Outcome.PLAN_STORED, added.display);
    const record = added.operation.diagnostics;
    assert.equal(record.available, true);
    assert.equal(record.measuredStages, 1);
    assert.equal(stageOf(record, 'finalization').outcome, 'ran');
    assert.ok(Number.isFinite(stageOf(record, 'finalization').durationMs));
    for (const stage of record.stages.filter((s) => s.id !== 'finalization')) {
      assert.equal(stage.outcome, 'not_reached', `${stage.id} is not part of a command operation`);
      assert.equal(stage.durationMs, null);
    }
  });

  test('G4.3 a cancelled request records a failed model stage, a cancellation, and no execution', async () => {
    const dir = tempDir();
    const app = appIn(dir, { gateway: stubGateway('PROPOSE_ACTION {"action":"memory.add","input":{"content":"never runs"}}') });
    const controller = new AbortController();
    controller.abort();
    // A prompt the router does not resolve to a deterministic action, so the model path is the one
    // that observes the cancellation.
    const res = await app.controller.handle('tell me something about the sky', { origin: 'user', signal: controller.signal });
    assert.equal(res.status, Outcome.REQUEST_CANCELLED);
    assert.equal(res.operation.steps.length, 0);
    const record = res.operation.diagnostics;
    assert.equal(stageOf(record, 'model_call').outcome, 'failed');
    assert.deepEqual(record.cancellation, { requested: true, afterResponse: false });
    assert.equal(record.failure.category, 'cancellation');
    assert.equal(record.failure.code, 'request_cancelled');
    assert.equal(stageOf(record, 'proposal_validation').outcome, 'not_reached');
    assert.equal(stageOf(record, 'execution').outcome, 'not_reached');
    // Finalization and audit semantics are unchanged: the lifecycle closed with the same status.
    assert.equal(res.operation.cognition.lifecycle.finalization.status, Outcome.REQUEST_CANCELLED);
    assert.equal(stageOf(record, 'finalization').outcome, 'ran');
  });

  test('G4.4 a transport timeout is reported differently from a cancellation', async () => {
    const dir = tempDir();
    const app = appIn(dir, { gateway: timeoutGateway() });
    const res = await app.controller.handle('tell me something about the sky', { origin: 'user' });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    const record = res.operation.diagnostics;
    // The record states explicitly that no caller cancellation happened, rather than leaving the
    // reader to infer it from a missing field.
    assert.deepEqual(record.cancellation, { requested: false, afterResponse: false }, 'a timeout is not a caller cancellation');
    assert.deepEqual(record.failure, { category: 'execution', code: 'TIMEOUT', stage: 'model' });
    assert.equal(stageOf(record, 'model_call').outcome, 'failed');
    assert.equal(stageOf(record, 'execution').outcome, 'not_reached');
    assert.equal(res.operation.steps.length, 0);
  });

  test('G4.5 a plan activation records its validation, handoff, per-step and finalization stages', async () => {
    const dir = tempDir();
    const app = appIn(dir, { gateway: stubGateway('unused') });
    const steps = [1, 2].map((n) => ({
      id: `s${n}`, description: `step ${n}`, action: 'memory.search', input: { query: 'lighthouse' },
      dependsOn: n === 1 ? [] : ['s1'], expectedResult: 'records are listed', verification: 'a record is named', risk: 'low',
    }));
    const added = await app.controller.planAdd({ outcome: 'the diagnostic activation fixture runs', reason: 'AO-08 fixture', steps });
    const planId = added.operation.steps[0].result.data.planId;
    assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);
    const run = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.display);
    const record = run.operation.diagnostics;
    assert.equal(record.available, true);
    for (const id of ['plan_validation', 'handoff_preparation', 'authorization', 'execution', 'verification', 'task_execution', 'finalization']) {
      const stage = stageOf(record, id);
      assert.equal(stage.outcome, 'ran', `${id} ran`);
      assert.ok(Number.isFinite(stage.durationMs), `${id} recorded a duration`);
    }
    assert.equal(stageOf(record, 'task_execution').counts.steps, 2);
    assert.equal(record.executive.handoffs.recorded, 1);
    assert.equal(record.executive.handoffs.prepared, 1);
    assert.equal(record.executive.handoffs.completed, 1);
    assert.deepEqual(record.executive.handoffs.kinds, { plan_activation: 1 });
    assert.deepEqual(record.executive.handoffs.states, { verified: 1 });

    // The task-run operation carries its own record, and the step audits are not request operations.
    const stored = operations(dir);
    const taskRun = stored.find((op) => op.capability === 'task.run');
    if (taskRun) assert.equal(taskRun.diagnostics?.requestId, taskRun.id);
    const stepRows = stored.filter((op) => op.capability === 'task.step');
    assert.ok(stepRows.length >= 2);
    assert.ok(stepRows.every((op) => op.diagnostics === undefined), 'a per-step audit row is not a request and gets no diagnostics');
  });
});

describe('AO-08 G5: concurrency, repetition, and purity', () => {
  test('G5.1 concurrent requests keep their diagnostics separate', async () => {
    const dir = tempDir();
    const app = appIn(dir, { gateway: stubGateway('A fixed answer.') });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => app.controller.handle(`concurrent request ${i}`, { origin: 'user' })));
    const ids = new Set(results.map((res) => res.operation.id));
    assert.equal(ids.size, results.length);
    for (const res of results) {
      assert.equal(res.operation.diagnostics.requestId, res.operation.id);
      assert.equal(res.operation.diagnostics.cognitive?.evidence, res.operation.cognition?.evidence?.total ?? null);
    }
    // Each persisted record matches exactly the diagnostics its own operation returned.
    const stored = operations(dir);
    for (const res of results) {
      const row = stored.find((op) => op.id === res.operation.id);
      assert.deepEqual(row.diagnostics, res.operation.diagnostics);
    }
  });

  test('G5.2 repeated requests keep the record the same size and shape', async () => {
    const dir = tempDir();
    const app = appIn(dir, { gateway: stubGateway('A fixed answer.') });
    const sizes = [];
    let shape = null;
    for (let i = 0; i < 20; i += 1) {
      const res = await app.controller.handle(`repeated request ${i}`, { origin: 'user' });
      const record = res.operation.diagnostics;
      sizes.push(JSON.stringify(record).length);
      const current = record.stages.map((stage) => `${stage.id}:${stage.outcome}`);
      if (shape === null) shape = current;
      assert.deepEqual(current, shape, 'the stage list does not grow or change shape');
    }
    assert.ok(Math.max(...sizes) < 8192, `a diagnostics record stayed bounded (max ${Math.max(...sizes)} bytes)`);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) < 512, 'the record size is stable across identical requests');
  });

  test('G5.3 building diagnostics over frozen inputs is pure and changes nothing', () => {
    const freeze = (value) => {
      if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) freeze(value[key]);
        Object.freeze(value);
      }
      return value;
    };
    const makeInputs = () => ({
      requestId: 'op-frozen',
      operation: freeze({
        id: 'op-frozen',
        status: Outcome.SUCCESS_VERIFIED,
        errors: [],
        steps: [{ action: 'memory.search', handoff: { kind: 'model_proposal', state: 'verified' } }],
      }),
      cognition: freeze({
        available: true,
        timings: { request: 1, retrieval: 2 },
        lifecycle: lifecycleWith(['ran', 'ran', 'ran', 'not_reached', 'not_reached', 'not_reached', 'ran', 'ran', 'ran', 'ran']),
        evidence: { total: 1 },
        claims: { total: 1, supported: 1 },
        decision: 'answer',
        uncertainty: 'supported',
        clarification: false,
      }),
      spans: freeze(new SpanRecorder({ clock: () => 1 }).snapshot()),
      status: Outcome.SUCCESS_VERIFIED,
      totalDurationMs: 3,
    });
    const first = buildRuntimeDiagnostics(makeInputs());
    const second = buildRuntimeDiagnostics(makeInputs());
    assert.deepEqual(first, second, 'the same measurements produce the same record');
    const inputs = makeInputs();
    const before = structuredClone(inputs);
    buildRuntimeDiagnostics(inputs);
    assert.deepEqual(inputs, before, 'building the record does not mutate its inputs');
  });
});
