// Batch AN, work package H: the integrated runtime path and its fourteen adversarial conditions.
//
// WHAT IS STUBBED AND WHAT IS REAL. Every "model reply" is a literal string returned by a fixed-output
// backend through the real ModelGateway; nothing here is evidence about what a model would say, and no
// inference is run, contacted, or simulated. Everything that decides an outcome is the shipped
// implementation: request understanding, retrieval, claims and deliberation, the COGNITION/proposal
// parsers and validators, the action registry and its origin authorization, execution, the independent
// verifiers, the audit log, finalization, and - for the cross-process cases - real APEX child processes
// (`tests/fixtures/continuation-child.mjs` and `continue-child.mjs`) whose only observable result is a
// side-effect file read back from disk.
//
// The first test walks the full path the batch names: user request -> cognitive interpretation ->
// evidence retrieval -> grounded claims -> response/proposal -> executive authorization -> verification
// -> audit -> learning. The remaining tests are the fourteen adversarial conditions, each against the
// same path: empty evidence, conflicting evidence, stale evidence, malformed cognitive output,
// model-origin authorization attempts, fabricated tool results, unsupported claims, backend unavailable,
// interrupted processing, duplicate requests, invalidated approvals, concurrent operations, audit
// failures, and recovery after process termination.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF, CAPTURE_VERIFIED_SUCCESS } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { formatResult } from '../src/cli.js';
import { StoreError } from '../src/errors.js';
import { ContinuationState } from '../src/executive/vocabulary.js';
import { INTERRUPTION_BOUNDARY } from '../src/plans/continuation.js';
import { StepStatus } from '../src/tasks/model.js';
import { PlanStatus } from '../src/plans/model.js';
import { makeTempDataDir, cleanup, cleanEnv, APP_ROOT } from './helpers.js';

const NOW = '2026-05-01T00:00:00.000Z';
const UE = [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }];

const dirs = [];
const children = [];

after(async () => {
  for (const c of children) {
    c.child.kill();
    await withCeiling(c.exited, 5000);
  }
  while (dirs.length) cleanup(dirs.pop());
});

const dir = () => { const d = makeTempDataDir(); dirs.push(d); return d; };

// ---- deterministic backends ---------------------------------------------------

function captureBackend(text) {
  const calls = [];
  return {
    calls,
    backend: {
      name: 'integration-capture',
      provider: 'integration-capture',
      configured: true,
      describe: () => ({ configured: true, provider: 'integration-capture', endpoint: 'synthetic', model: 'synthetic' }),
      health: async () => ({ available: true, detail: 'synthetic capture' }),
      complete: async (request) => {
        calls.push(request);
        return {
          ok: true,
          backend: 'integration-capture',
          provider: 'integration-capture',
          model: 'synthetic',
          text: typeof text === 'function' ? text(request, calls.length) : text,
          finishReason: 'stop',
          truncated: false,
          latencyMs: 0,
        };
      },
    },
  };
}

// A transport that answered and refused to serve the request. It is not an exception: the gateway has
// to report a classified failure, and the controller has to record that the model stage produced no
// answer and no proposal.
function failingBackend(code, message) {
  return {
    name: 'integration-failing',
    provider: 'integration-failing',
    configured: true,
    describe: () => ({ configured: true, provider: 'integration-failing', endpoint: 'synthetic', model: 'synthetic' }),
    health: async () => ({ available: false, detail: message }),
    complete: async () => ({
      ok: false, backend: 'integration-failing', provider: 'integration-failing', latencyMs: 0,
      error: { code, message },
    }),
  };
}

function appWith({ text = null, gateway = null, experienceCapture = CAPTURE_OFF } = {}) {
  const dataDir = dir();
  const capture = text === null ? null : captureBackend(text);
  const app = createApp({
    dataDir,
    gateway: gateway ?? new ModelGateway({ backend: capture.backend }),
    experienceCapture,
    now: () => new Date(NOW),
  });
  return { app, dataDir, calls: capture?.calls ?? [] };
}

// ---- fixture helpers ----------------------------------------------------------

async function worldWrite(app, action, input) {
  const res = await app.controller.worldWrite(action, input);
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, JSON.stringify(res.operation?.errors ?? res));
  return res.operation.steps[0].result.data;
}

async function addEntity(app, id, name, extra = {}) {
  return worldWrite(app, 'world.entity.add', { id, category: 'project', name, evidence: UE, ...extra });
}

async function addFact(app, id, subject, predicate, object, extra = {}) {
  return worldWrite(app, 'world.fact.add', {
    id, subject, predicate, object, validFrom: '2024-01-01', evidence: UE, ...extra,
  });
}

function scalar(value) {
  return { kind: 'scalar', valueType: 'string', value };
}

function cognitionOf(res) {
  const cognition = res.operation.cognition;
  assert.ok(cognition, 'the operation carries the cognitive audit');
  return cognition;
}

function traceIds(cognition) {
  return (cognition.trace?.evidence ?? []).map((item) => item.id);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

const displayOf = (res) => String(res?.display ?? res?.output ?? '');
const dOf = (res) => res?.operation?.steps?.[0]?.result?.data ?? {};

function armAuditFailure(app, refuses = () => true) {
  const original = app.operations.append.bind(app.operations);
  app.operations.append = async (record) => {
    if (refuses(record)) throw new StoreError(`injected: the audit log refused ${record.capability}`);
    return original(record);
  };
  return () => { app.operations.append = original; };
}

// ---- real child fixtures ------------------------------------------------------

const INTERRUPT_CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'continuation-child.mjs');
const CONTINUE_CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'continue-child.mjs');
const RUN_CEILING_MS = 120000;

async function withCeiling(promise, ms = RUN_CEILING_MS) {
  let timer;
  const ceiling = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ code: null, signal: 'ceiling' }), ms);
  });
  try {
    return await Promise.race([promise, ceiling]);
  } finally {
    clearTimeout(timer);
  }
}

const effectFileOf = (dataDir) => path.join(dataDir, 'effects.txt');
const effectsOf = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
  : []);

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
  gateway: new ModelGateway({ backend: new NoBackend() }),
  experienceCapture: CAPTURE_OFF,
  extraActions: probeActions(dataDir),
});

// A real process stopped at one of the eight boundaries. The plan, task, and side-effect bytes are the
// interruption itself, not a description of it.
async function interruptedRun(dataDir, boundary = 'after-step-creation') {
  const child = spawn(process.execPath, [INTERRUPT_CHILD, boundary, dataDir, effectFileOf(dataDir)], {
    env: cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  children.push({ child, exited });
  const info = await withCeiling(exited);
  const results = out.split('\n').filter((l) => l.startsWith('RESULT ')).map((l) => JSON.parse(l.slice(7)));
  if (results.length === 0) throw new Error(`the interruption fixture reported nothing (${info.code ?? info.signal})`);
  return results[results.length - 1];
}

async function runContinue(dataDir, planId, delayMs = 0) {
  const child = spawn(process.execPath, [CONTINUE_CHILD, dataDir, planId, String(delayMs)], {
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
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  children.push({ child, exited });
  const info = await withCeiling(exited);
  const results = out.split('\n').filter((l) => l.startsWith('RESULT ')).map((l) => JSON.parse(l.slice(7)));
  return { info, err, result: results[results.length - 1] ?? null };
}

const row = (continuation, id) => continuation.steps.find((s) => s.id === id);

// ============================================================================
// The whole path
// ============================================================================

describe('AN-09: the full runtime path through the real controller and stores', () => {
  test('request -> interpretation -> evidence -> claims -> answer/proposal -> authorization -> verification -> audit -> learning', async () => {
    let recordId = null;
    const { app, dataDir } = appWith({
      text: () => [
        'The lighthouse project is green.',
        `COGNITION ${JSON.stringify({
          schema: 1,
          decision: 'answer',
          answer: 'The lighthouse project is green.',
          claims: [{
            text: 'the lighthouse project status is green',
            evidence: [`ev:memory:${recordId}`],
            kind: 'supported',
          }],
          uncertainty: 'supported_but_incomplete',
          disclosures: [],
          missing: [],
        })}`,
        'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"1+1"}}',
      ].join('\n'),
    });
    const record = await app.memory.add({
      content: 'the lighthouse project status is green', kind: 'user_fact', source: 'user',
    });
    recordId = record.id;

    const res = await app.controller.handle('tell me about the lighthouse project status', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.ok(res.output.startsWith('The lighthouse project is green.'), res.output);

    // The cognitive stages read from this request's actual analysis.
    const cognition = cognitionOf(res);
    assert.equal(cognition.available, true);
    assert.equal(cognition.decision, 'answer');
    assert.ok(cognition.evidence.total >= 1);
    assert.equal(cognition.claims.total >= 1, true);
    assert.equal(cognition.model.accepted, true, cognition.model.problems?.join('; '));
    assert.equal(cognition.model.validationOk, true);
    assert.equal(cognition.model.citedEvidence, 1);
    assert.ok(traceIds(cognition).includes(`ev:memory:${record.id}`));

    // The proposal is a typed model-origin request; the registry authorized it, execution ran, and the
    // independent verifier recomputed the answer.
    assert.equal(res.operation.steps.length, 1);
    const [step] = res.operation.steps;
    assert.equal(step.action, 'calc.evaluate');
    assert.equal(step.origin, 'model');
    assert.equal(step.proposalId, `${res.operation.id}/mp:1`);
    assert.equal(step.authorization.decision, 'allow');
    assert.equal(step.execution.status, 'ok');
    assert.equal(step.verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.match(res.display, /1\+1 = 2/, 'the verified tool result is shown, not only the model wording');

    // The boundary record restates the decision and authorizes nothing.
    const boundary = cognition.trace.boundary;
    assert.equal(boundary.outcome, 'all_executed');
    assert.deepEqual(boundary.authorization, { requests: 1, allowed: 1, denied: 0 });
    assert.deepEqual(boundary.execution, { attempted: 1, ok: 1, rejected: 0, failed: 0 });
    assert.deepEqual(boundary.verification, { verified: 1, failed: 0, unavailable: 0 });
    assert.equal(boundary.authorizes, false);
    assert.equal(boundary.authorizationOwner, 'action_registry');
    assert.equal(cognition.trace.authorizes, false);

    // The contract is the persisted statement of the same path. Learning (stage 10) is not claimed by
    // this request: the controller builds the contract before finalization and passes no learning
    // record, so the stage is honestly not_reached here; the experience below is how learning is
    // recorded, and it is a separate audited operation.
    const rows = readJsonl(path.join(dataDir, 'operations.jsonl'));
    assert.equal(rows.length, 1, 'the answer operation was audited exactly once');
    const stored = rows[0];
    assert.equal(stored.id, res.operation.id);
    const contract = stored.cognition.contract;
    assert.ok(contract, 'the audit record carries the contract');
    assert.equal(contract.ok, true);
    assert.equal(contract.reachedThrough, 9);
    assert.equal(contract.authority.canSkipAuthorization, false);
    assert.equal(contract.authority.authorizationOwner, 'action_registry');
    assert.equal(contract.authority.cognitiveOutputGrantsAuthorization, false);
    assert.ok(contract.checks.every((check) => check.ok === true));
    const stageOf = (order) => contract.stages.find((entry) => entry.order === order);
    for (let order = 1; order <= 9; order += 1) assert.equal(stageOf(order).status, 'ran', `stage ${order}`);
    assert.equal(stageOf(1).counts.received, 1);
    assert.equal(stageOf(2).counts.entities >= 0, true);
    assert.equal(stageOf(3).counts.evidence >= 1, true);
    assert.equal(stageOf(4).counts.total >= 1, true);
    assert.equal(stageOf(5).labels.decision, 'answer');
    assert.deepEqual(stageOf(6).counts, { observed: 1, well_formed: 1, malformed: 0, overflow: 0 });
    assert.deepEqual(stageOf(7).counts, { requests: 1, allowed: 1, denied: 0 });
    assert.deepEqual(stageOf(8).counts, { attempted: 1, ok: 1, rejected: 0, failed: 0 });
    assert.deepEqual(stageOf(9).counts, { checked: 1, verified: 1, failed: 0, unavailable: 0 });
    assert.equal(stageOf(10).status, 'not_reached');
    // The executable lifecycle behind the contract: the request's own status is the record's status,
    // no transition was rejected, and whether the append succeeded cannot be inside the record.
    assert.equal(cognition.lifecycle.authorizes, false);
    assert.deepEqual(cognition.lifecycle.rejections, []);
    assert.equal(cognition.lifecycle.finalization.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(cognition.lifecycle.finalization.recorded, null);
    assert.equal(cognition.lifecycle.stages[9].status, 'not_reached');

    // Learning: the user records the audited answer as an experience, and the store proves it points at
    // the operation it names.
    const learned = await app.controller.experienceRecord({
      operationId: stored.id, subject: 'the lighthouse status answer',
    });
    assert.equal(learned.status, Outcome.SUCCESS_VERIFIED, learned.display ?? learned.output);
    const experiences = await app.experience.list({ limit: 10 });
    const written = experiences.find((r) => r.operationId === stored.id);
    assert.ok(written, 'the experience references the audited operation');
    assert.equal(written.capability, stored.capability);
    assert.equal(written.outcome, stored.status);
  });
});

// ============================================================================
// Evidence conditions
// ============================================================================

describe('AN-09: evidence conditions', () => {
  test('empty evidence is disclosed as no evidence, never filled in by the model', async () => {
    const { app } = appWith({ text: 'No stored record answers that.' });
    const res = await app.controller.handle('what is recorded about the harbour ledger?', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);

    const cognition = cognitionOf(res);
    assert.equal(cognition.available, true);
    // Only the request itself was carried: a summary of an empty store is not evidence, so no record
    // source contributed a claim.
    assert.equal(cognition.claims.material, 0);
    const contributing = cognition.sources.filter((source) => source.count > 0);
    assert.deepEqual(contributing, [{ source: 'user_instruction', status: 'ok', count: 1 }]);
    assert.deepEqual(cognition.evidence.unavailable, []);
    assert.deepEqual(cognition.evidence.damaged, []);
    assert.equal(cognition.uncertainty, 'unknown');
    assert.ok(cognition.disclosures.includes('no_evidence_found'));
    assert.deepEqual(traceIds(cognition), ['ev:user_instruction:request'], 'no evidence id was invented');
    assert.equal(res.operation.steps.length, 0);
  });

  test('conflicting evidence is reported unresolved and both records remain evidence', async () => {
    const { app } = appWith({ text: 'The records disagree; APEX has not resolved them.' });
    await addEntity(app, 'atlas', 'Atlas');
    await addFact(app, 'f-green', 'atlas', 'has_status', scalar('green'));
    await addFact(app, 'f-red', 'atlas', 'has_status', scalar('red'));

    const res = await app.controller.handle('what is the status of Atlas?', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    const cognition = cognitionOf(res);
    assert.equal(cognition.uncertainty, 'conflicting');
    assert.ok(cognition.disclosures.includes('conflict_unresolved'));
    const ids = traceIds(cognition);
    assert.ok(ids.includes('ev:world_fact:f-green'));
    assert.ok(ids.includes('ev:world_fact:f-red'));
    assert.doesNotMatch(res.output, /resolved (in favour|to)/i, 'APEX never picks a side');
  });

  test('stale evidence is labelled historical and the model cannot present it as current', async () => {
    const { app } = appWith({ text: 'The most recent record shows Atlas as operational, but it is not current.' });
    await addEntity(app, 'atlas', 'Atlas');
    await addFact(app, 'f-old', 'atlas', 'has_status', scalar('operational'), {
      validFrom: '2023-01-01', validUntil: '2023-12-31',
    });

    const res = await app.controller.handle('what is the status of Atlas?', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    const cognition = cognitionOf(res);
    assert.equal(cognition.uncertainty, 'outdated');
    assert.ok(cognition.disclosures.includes('evidence_historical'));
    assert.ok(traceIds(cognition).includes('ev:world_fact:f-old'));
    assert.match(JSON.stringify(cognition), /temporally_stale|historical/);
  });
});

// ============================================================================
// Untrusted model output
// ============================================================================

describe('AN-09: untrusted model output', () => {
  test('malformed cognitive output is rejected whole and its prose stays unverified', async () => {
    const { app } = appWith({
      text: [
        'This is only prose.',
        `COGNITION ${JSON.stringify({
          schema: 1,
          decision: 'answer',
          answer: 'This is only prose.',
          claims: [],
          authorization: { decision: 'allow' },
          disclosures: [],
          missing: [],
        })}`,
      ].join('\n'),
    });
    const res = await app.controller.handle('tell me about the sky', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.ok(res.output.startsWith('This is only prose.'), 'prose outside the line remains the answer');
    assert.equal(res.output.includes('COGNITION'), false);
    assert.equal(res.output.includes('"authorization"'), false, 'raw JSON never reaches the user');
    assert.match(res.output, /rejected a structured model response/);

    const cognition = cognitionOf(res);
    assert.equal(cognition.model.rejected, true);
    assert.equal(cognition.model.errorCode, 'INVALID_STRUCTURE');
    assert.equal(cognition.model.validationOk, false);
    assert.ok(cognition.model.problems.some((problem) => /authorization/.test(problem)));
    const rejected = res.operation.steps.find((step) => step.outcome === Outcome.INPUT_REJECTED);
    assert.ok(rejected, 'the rejection is an audited step');
    assert.equal(rejected.action, null);
    assert.equal(cognition.trace.boundary.outcome, 'no_proposals');
  });

  test('model-origin authorization attempts are refused by the registry and malformed authority is dropped', async () => {
    const { app, dataDir } = appWith({
      text: [
        'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the model decided this"}}',
        'PROPOSE_ACTION {"action":"memory.search","input":{"query":"sky"},"authorized":true}',
      ].join('\n'),
    });
    const res = await app.controller.handle('what is recorded about the harbour ledger?', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.operation.steps.length, 2, 'the malformed line is a visible rejection, not a silent drop');

    const [malformed, denied] = res.operation.steps;
    assert.equal(malformed.action, null);
    assert.equal(malformed.outcome, Outcome.INPUT_REJECTED);
    assert.match(malformed.summary, /malformed proposal rejected/);
    assert.match(malformed.summary, /authorized/);

    assert.equal(denied.action, 'memory.add');
    assert.equal(denied.origin, 'model', 'the origin is APEX\'s, not the proposal\'s');
    assert.deepEqual(denied.authorization, { decision: 'deny', reason: 'ORIGIN_NOT_PERMITTED' });
    assert.equal(denied.execution.status, 'not_run');
    assert.equal(denied.outcome, Outcome.ACTION_DENIED);

    assert.equal(readJsonl(path.join(dataDir, 'memory.jsonl')).length, 0, 'no model-authorized write exists');
    assert.match(res.output, /\[APEX did not execute (?:a|\d+) proposed actions?:/);

    const cognition = cognitionOf(res);
    const boundary = cognition.trace.boundary;
    assert.equal(boundary.outcome, 'all_denied');
    assert.deepEqual(boundary.authorization, { requests: 1, allowed: 0, denied: 1 });
    assert.deepEqual(boundary.refusalReasons, ['ORIGIN_NOT_PERMITTED']);
    assert.equal(boundary.authorizes, false);

    const contract = cognition.contract;
    const stageOf = (order) => contract.stages.find((entry) => entry.order === order);
    assert.deepEqual(stageOf(6).counts, { observed: 2, well_formed: 1, malformed: 1, overflow: 0 });
    assert.deepEqual(stageOf(7).counts, { requests: 1, allowed: 0, denied: 1 });
    assert.equal(stageOf(8).status, 'skipped');
    assert.equal(contract.reachedThrough, 7);
  });

  test('a fabricated tool result is contradicted by the step record that never executed', async () => {
    const { app } = appWith({
      text: [
        'The archive search returned three matching records; I checked each one.',
        'PROPOSE_ACTION {"action":"memory.search","input":{"query":"archive","verified":true}}',
      ].join('\n'),
    });
    const res = await app.controller.handle('what is recorded about the archive batches?', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);

    const [step] = res.operation.steps;
    assert.equal(step.action, 'memory.search');
    assert.equal(step.authorization.decision, 'allow');
    assert.equal(step.execution.status, 'rejected', 'the action\'s validator refused the invented field');
    assert.match(step.summary, /unexpected input field "verified"/);
    assert.equal(step.outcome, Outcome.INPUT_REJECTED);
    assert.match(res.output, /\[APEX did not execute (?:a|\d+) proposed actions?:/);
    assert.match(res.display, /unexpected input field "verified"/);

    const boundary = cognitionOf(res).trace.boundary;
    assert.equal(boundary.outcome, 'partially_executed');
    assert.deepEqual(boundary.execution, { attempted: 1, ok: 0, rejected: 1, failed: 0 });
    assert.equal(boundary.verification.verified, 0, 'a rejected tool call verified nothing');
  });

  test('a claim citing evidence this request did not retrieve is rejected', async () => {
    const { app } = appWith({
      text: [
        'The archive is closed.',
        `COGNITION ${JSON.stringify({
          schema: 1,
          decision: 'answer',
          answer: 'The archive is closed.',
          claims: [{
            text: 'the archive is closed',
            evidence: ['ev:memory:not-retrieved-1'],
            kind: 'supported',
          }],
          disclosures: [],
          missing: [],
        })}`,
      ].join('\n'),
    });
    const res = await app.controller.handle('what is recorded about the archive?', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    const cognition = cognitionOf(res);
    assert.equal(cognition.model.rejected, true);
    assert.equal(cognition.model.errorCode, 'INVALID_STRUCTURE');
    assert.ok(cognition.model.problems.some((problem) => /not in this retrieval/.test(problem)));
    assert.equal(res.output.includes('not-retrieved-1'), false, 'the invented id is not presented to the user');
    assert.ok(!traceIds(cognition).some((id) => id.includes('not-retrieved')), 'the invented id is not in the trace');
    assert.ok(res.operation.steps.some((step) => step.outcome === Outcome.INPUT_REJECTED));
  });
});

// ============================================================================
// Transport
// ============================================================================

describe('AN-09: transport failure', () => {
  test('a backend that cannot answer leaves no answer, no proposal, and no execution boundary', async () => {
    const { app, dataDir } = appWith({
      gateway: new ModelGateway({
        backend: failingBackend('UNREACHABLE', 'the configured endpoint did not answer'),
      }),
    });
    const res = await app.controller.handle('what is recorded about the audit?', { origin: 'user' });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.output, /The model backend did not produce an answer \(UNREACHABLE: the configured endpoint did not answer\)/);
    assert.equal(res.operation.steps.length, 0);

    const cognition = cognitionOf(res);
    assert.equal(cognition.available, true, 'the analysis ran before the transport failed');
    assert.equal(cognition.trace.boundary.reached, false);
    assert.equal(cognition.trace.boundary.outcome, 'not_reached');
    assert.deepEqual(cognition.trace.boundary.authorization, { requests: 0, allowed: 0, denied: 0 });
    assert.equal(cognition.trace.boundary.authorizes, false);

    const contract = cognition.contract;
    const stageOf = (order) => contract.stages.find((entry) => entry.order === order);
    for (let order = 1; order <= 5; order += 1) assert.equal(stageOf(order).status, 'ran', `stage ${order}`);
    // The transport failed while the model stage was running: the stage is recorded as failed, not as
    // a "ran" that observed zero proposals, and every stage that depends on it is not reached.
    assert.equal(stageOf(6).status, 'failed');
    assert.deepEqual(stageOf(6).counts, { observed: 0, well_formed: 0, malformed: 0, overflow: 0 });
    // The fixed contract stage has no free-text field; the bounded reason lives in the lifecycle audit.
    assert.equal(cognition.lifecycle.stages[5].reason, 'model_unavailable');
    assert.equal(stageOf(7).status, 'not_reached');
    assert.equal(stageOf(8).status, 'not_reached');
    assert.equal(contract.reachedThrough, 6);

    const rows = readJsonl(path.join(dataDir, 'operations.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, Outcome.EXECUTION_FAILED);
    assert.equal(rows[0].cognition.trace.boundary.outcome, 'not_reached');
  });
});

// ============================================================================
// Interruption, recovery, duplicates and concurrency
// ============================================================================

describe('AN-09: interruption and continuation, with real processes', () => {
  test('interrupted processing: a step recorded as running is uncertain and is never replayed', async () => {
    const dataDir = dir();
    const effectFile = effectFileOf(dataDir);
    const { planId } = await interruptedRun(dataDir, 'after-running-recorded');

    const app = appIn(dataDir);
    const continuation = dOf(await app.controller.planContinuation(planId)).continuation;
    const s1 = row(continuation, 's1');
    assert.equal(s1.recordedStatus, StepStatus.RUNNING);
    assert.equal(s1.state, ContinuationState.OUTCOME_UNCERTAIN);
    assert.equal(s1.boundary, INTERRUPTION_BOUNDARY.AFTER_RUNNING_RECORDED);
    assert.equal(continuation.continue.safe, false);
    assert.deepEqual(continuation.continue.neverReplay, ['s1']);
    assert.deepEqual(effectsOf(effectFile), [], 'no effect exists, and the reading still does not assume none happened');

    const cont = await app.controller.planContinue(planId);
    assert.equal(cont.status, Outcome.INPUT_REJECTED);
    assert.match(displayOf(cont), /nothing was taken up/);
    assert.match(displayOf(cont), /outcome uncertain/);
    assert.deepEqual(effectsOf(effectFile), [], 'the refusal ran nothing');
  });

  test('recovery after process termination: a new process takes up only the steps proven not to have started', async () => {
    const dataDir = dir();
    const effectFile = effectFileOf(dataDir);
    const { planId } = await interruptedRun(dataDir, 'after-step-creation');

    const { info, err, result } = await runContinue(dataDir, planId);
    assert.equal(info.code, 0, `continuation child exited ${info.code ?? info.signal}: ${err}`);
    assert.ok(result && !result.threw, `child reported no result: ${err}`);
    assert.equal(result.status, Outcome.PLAN_STORED, JSON.stringify(result));
    assert.deepEqual(result.ran, ['s1', 's2']);
    assert.deepEqual(effectsOf(effectFile), ['note-1', 'read:note-2'], 'each effect happened exactly once');

    const app = appIn(dataDir);
    const after = dOf(await app.controller.planContinuation(planId)).continuation;
    assert.equal(after.runState, ContinuationState.VERIFIED_SUCCESSFUL);
    assert.equal(after.plan.status, PlanStatus.COMPLETED);
  });

  test('duplicate requests: a second continuation of a settled run takes up nothing', async () => {
    const dataDir = dir();
    const effectFile = effectFileOf(dataDir);
    const { planId } = await interruptedRun(dataDir, 'after-step-creation');

    const first = await runContinue(dataDir, planId);
    assert.equal(first.result.status, Outcome.PLAN_STORED, JSON.stringify(first.result));
    const afterFirst = effectsOf(effectFile);
    assert.deepEqual(afterFirst, ['note-1', 'read:note-2']);

    // The duplicate is sent by this process, after the first process is gone: the records - not an
    // in-process guard - are what stop it.
    const app = appIn(dataDir);
    const second = await app.controller.planContinue(planId);
    assert.equal(second.status, Outcome.INPUT_REJECTED, 'a settled run has nothing left to take up');
    assert.deepEqual(effectsOf(effectFile), afterFirst, 'the duplicate produced no second effect');
  });

  test('concurrent operations: two processes attempt the same continuation and the side-effect file decides', async () => {
    const dataDir = dir();
    const effectFile = effectFileOf(dataDir);
    const { planId } = await interruptedRun(dataDir, 'after-step-creation');

    const [a, b] = await Promise.all([
      runContinue(dataDir, planId, 0),
      runContinue(dataDir, planId, 25),
    ]);
    for (const run of [a, b]) {
      assert.equal(run.info.code, 0, `continuation child exited ${run.info.code ?? run.info.signal}: ${run.err}`);
      assert.ok(run.result && !run.result.threw, `child reported no result: ${run.err}`);
    }
    assert.deepEqual(effectsOf(effectFile), ['note-1', 'read:note-2'],
      'each effect appears exactly once, whatever either process claims');

    const tookUp = [a, b].filter((run) => Array.isArray(run.result.ran) && run.result.ran.length > 0);
    assert.equal(tookUp.length, 1, `exactly one process ran the steps: ${JSON.stringify([a.result, b.result])}`);
    assert.deepEqual(tookUp[0].result.ran, ['s1', 's2']);
    const other = [a, b].find((run) => run !== tookUp[0]);
    assert.equal(other.result.status, Outcome.INPUT_REJECTED, JSON.stringify(other.result));
  });
});

// ============================================================================
// Approvals and audit failures
// ============================================================================

describe('AN-09: approvals and audit failures', () => {
  test('an approval invalidated by a goal revision cannot start a task or write anything', async () => {
    const { app, dataDir } = appWith({ gateway: new ModelGateway({ backend: new NoBackend() }) });

    const created = await app.controller.goalAdd({
      request: 'record the revision fact', criteria: ['the recorded fact is stored'],
    });
    assert.equal(created.status, Outcome.GOAL_CREATED, created.output);
    const goalId = dOf(created).goalId;
    for (const status of ['accepted', 'active']) {
      assert.equal((await app.controller.goalUpdate({ target: goalId, status })).status, Outcome.GOAL_UPDATED);
    }

    const added = await app.controller.planAdd({
      goalId,
      outcome: 'the fact is stored',
      steps: [{
        id: 's1',
        description: 'remember the revision fact',
        action: 'memory.add',
        input: { content: 'the revision fact is stored' },
        dependsOn: [],
        criterion: null,
        expectedResult: 'one memory record',
        verification: 'the record is read back',
        risk: 'medium',
        estimateSeconds: 2,
      }],
    });
    assert.equal(added.status, Outcome.PLAN_STORED, added.output);
    const planId = dOf(added).planId;
    assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);

    const revised = await app.controller.goalRevise({
      target: goalId, criteria: ['a revised criterion'], reason: 'the criterion changed',
    });
    assert.equal(revised.status, Outcome.GOAL_UPDATED, revised.output);

    const validity = await app.controller.validateStoredPlan(planId);
    assert.equal(validity.validation.ok, false);
    assert.match(validity.display, /goal-revision/);

    const tasksBefore = (await app.taskStore.inspect()).tasks.length;
    const run = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(run.status, Outcome.INPUT_REJECTED, displayOf(run));
    assert.match(displayOf(run), /moved from revision 1 to 2/);
    assert.equal((await app.taskStore.inspect()).tasks.length, tasksBefore, 'a refused activation created no task');
    assert.equal(readJsonl(path.join(dataDir, 'memory.jsonl')).length, 0, 'the step never ran');
  });

  test('an audit-append failure qualifies the success, leaves no record, and captures no experience', async () => {
    const { app, dataDir } = appWith({
      gateway: new ModelGateway({ backend: new NoBackend() }),
      experienceCapture: CAPTURE_VERIFIED_SUCCESS,
    });
    const restore = armAuditFailure(app);
    let res;
    try {
      res = await app.controller.handle('remember that the harbour depth is four metres', { origin: 'user' });
    } finally {
      restore();
    }

    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, 'the verifier confirmed the postcondition by re-reading the store');
    assert.equal(res.recorded, false);
    assert.match(res.recordError, /injected: the audit log refused memory\.add/);
    assert.equal(readJsonl(path.join(dataDir, 'memory.jsonl')).length, 1, 'the side effect stands and is not rolled back');
    assert.equal(readJsonl(path.join(dataDir, 'operations.jsonl')).length, 0, 'the failed append left no line');
    assert.equal(readJsonl(path.join(dataDir, 'experiences.jsonl')).length, 0,
      'capture needs the audit record that does not exist');

    const shown = formatResult(res);
    assert.match(shown, /Audit:\s+NOT RECORDED \(injected: the audit log refused memory\.add\)/);
    assert.match(shown, /Do not repeat the request just to obtain a record/);
    assert.doesNotMatch(shown, /Experience: captured/);
  });
});
