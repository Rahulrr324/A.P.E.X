// Batch AN: the explicit cognitive runtime contract.
//
// These tests pin the ten-stage order, the authority statement every contract carries, and the two
// invariants that make "a proposal cannot execute itself" true rather than aspirational: an execution
// with no allow decision, or with no authorization record at all, fails the contract. Every fixture is
// a plain object; no model is contacted.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTRACT_STAGES, COGNITION_AUTHORITY, COGNITIVE_CONTRACT_SCHEMA, ContractStage,
  StageStatus, buildContract, contractAudit,
} from '../src/cognition/contract.js';
import { analyzeRequest } from '../src/cognition/engine.js';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { cleanup, makeTempDataDir } from './helpers.js';

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

const ANALYSIS = Object.freeze({
  available: true,
  understanding: {
    intent: 'stored_information_question',
    entities: [{ id: 'e1' }],
    goals: [],
    plans: [],
    tasks: [],
    missing: [],
    ambiguities: [],
    executionRequested: false,
  },
  retrieval: {
    counts: { total: 2, unavailable: [], damaged: [], dropped: 1 },
    sources: [{ source: 'memory', status: 'ok', count: 2 }, { source: 'knowledge', status: 'empty', count: 0 }],
  },
  claims: { counts: { total: 2, material: 1, contradicted: 0, historical: 0, inference: 0 } },
  deliberation: {
    decision: 'answer',
    clarification: { needed: false },
    disclosures: ['model_output_unverified'],
    uncertainty: { category: 'supported_but_incomplete' },
  },
});

function stageOf(contract, order) {
  return contract.stages.find((entry) => entry.order === order);
}

function allowStep({ execution = 'ok', verification = 'success_verified' } = {}) {
  return {
    action: 'memory_search',
    origin: 'model',
    authorization: { decision: 'allow', reason: 'PERMITTED' },
    execution: { status: execution },
    verification: { outcome: verification, detail: null },
    outcome: verification,
  };
}

function deniedStep(reason = 'WRITE_REQUIRES_USER_APPROVAL') {
  return {
    action: 'memory_add',
    origin: 'model',
    authorization: { decision: 'deny', reason },
    execution: { status: 'not_run' },
    verification: { outcome: 'not_run', detail: null },
    outcome: 'action_denied',
  };
}

test('the contract names ten stages in the documented order with fixed owners', () => {
  assert.equal(CONTRACT_STAGES.length, 10);
  assert.deepEqual(CONTRACT_STAGES.map((entry) => entry.name), [
    ContractStage.REQUEST,
    ContractStage.INTERPRETATION,
    ContractStage.EVIDENCE,
    ContractStage.CLAIMS,
    ContractStage.RESPONSE,
    ContractStage.PROPOSED_ACTIONS,
    ContractStage.AUTHORIZATION,
    ContractStage.EXECUTION,
    ContractStage.VERIFICATION,
    ContractStage.LEARNING,
  ]);
  assert.deepEqual(CONTRACT_STAGES.map((entry) => entry.owner), [
    'user', 'cognitive', 'cognitive', 'cognitive', 'cognitive',
    'model', 'executive', 'executive', 'executive', 'executive',
  ]);
});

test('an analysis alone reaches stage 5 and claims nothing about the executive stages', () => {
  const contract = buildContract({ requestId: 'op-1', analysis: ANALYSIS });
  assert.equal(contract.schema, COGNITIVE_CONTRACT_SCHEMA);
  assert.equal(contract.ok, true);
  assert.equal(contract.reachedThrough, 5);
  assert.equal(contract.authorizes, false);
  assert.deepEqual(contract.authority, COGNITION_AUTHORITY);
  for (let order = 1; order <= 5; order += 1) assert.equal(stageOf(contract, order).status, StageStatus.RAN);
  for (let order = 6; order <= 10; order += 1) assert.equal(stageOf(contract, order).status, StageStatus.NOT_REACHED);
  assert.equal(stageOf(contract, 5).labels.decision, 'answer');
  assert.equal(stageOf(contract, 5).labels.uncertainty, 'supported_but_incomplete');
});

test('a denied proposal is refused at stage 7 and never reaches execution', () => {
  const contract = buildContract({
    requestId: 'op-2',
    analysis: ANALYSIS,
    proposals: { observed: 1, wellFormed: 1, malformed: 0, overflow: 0 },
    steps: [deniedStep()],
  });
  assert.equal(contract.ok, true);
  assert.deepEqual(stageOf(contract, 6).counts, { observed: 1, well_formed: 1, malformed: 0, overflow: 0 });
  assert.deepEqual(stageOf(contract, 7).counts, { requests: 1, allowed: 0, denied: 1 });
  assert.equal(stageOf(contract, 8).status, StageStatus.SKIPPED);
  assert.deepEqual(stageOf(contract, 8).counts, { attempted: 0 });
  assert.equal(stageOf(contract, 9).status, StageStatus.NOT_REACHED);
  assert.ok(contract.checks.every((check) => check.ok));
});

test('an allowed, executed, verified step reaches stages 8 and 9', () => {
  const contract = buildContract({
    requestId: 'op-3',
    analysis: ANALYSIS,
    proposals: { observed: 1, wellFormed: 1, malformed: 0, overflow: 0 },
    steps: [allowStep()],
    learning: { recorded: true, failed: 0 },
  });
  assert.equal(stageOf(contract, 7).counts.allowed, 1);
  assert.deepEqual(stageOf(contract, 8).counts, { attempted: 1, ok: 1, rejected: 0, failed: 0 });
  assert.deepEqual(stageOf(contract, 9).counts, { checked: 1, verified: 1, failed: 0, unavailable: 0 });
  assert.equal(stageOf(contract, 10).status, StageStatus.RAN);
  assert.equal(contract.reachedThrough, 10);
  assert.equal(contract.ok, true);
});

test('an execution without an allow decision fails the contract', () => {
  const smuggled = allowStep();
  smuggled.authorization = { decision: 'deny', reason: 'ORIGIN_NOT_PERMITTED' };
  const contract = buildContract({
    requestId: 'op-4',
    analysis: ANALYSIS,
    proposals: { observed: 1, wellFormed: 1, malformed: 0, overflow: 0 },
    steps: [smuggled],
  });
  assert.equal(contract.ok, false);
  const check = contract.checks.find((entry) => entry.check === 'execution_requires_authorization');
  assert.equal(check.ok, false);
  assert.match(check.detail, /no allow decision/);
});

test('an execution with no authorization record at all fails the contract', () => {
  const smuggled = allowStep();
  smuggled.authorization = null;
  const contract = buildContract({
    requestId: 'op-5',
    analysis: ANALYSIS,
    proposals: { observed: 1, wellFormed: 1, malformed: 0, overflow: 0 },
    steps: [smuggled],
  });
  assert.equal(contract.ok, false);
  const check = contract.checks.find((entry) => entry.check === 'authorization_recorded_before_execution');
  assert.equal(check.ok, false);
});

test('a failed analysis records the cognitive stages as unavailable and stops the contract', () => {
  const contract = buildContract({ requestId: 'op-6', analysis: null });
  assert.equal(contract.ok, true);
  assert.equal(stageOf(contract, 1).status, StageStatus.RAN);
  for (let order = 2; order <= 5; order += 1) assert.equal(stageOf(contract, order).status, StageStatus.UNAVAILABLE);
  for (let order = 6; order <= 10; order += 1) assert.equal(stageOf(contract, order).status, StageStatus.NOT_REACHED);
  assert.equal(contract.reachedThrough, 1);
});

test('a stage that is not reached closes every later stage even if records are supplied', () => {
  const contract = buildContract({
    requestId: 'op-7',
    analysis: ANALYSIS,
    proposals: { observed: 1, wellFormed: 1, malformed: 0, overflow: 0 },
    steps: null,
  });
  assert.equal(stageOf(contract, 6).status, StageStatus.RAN);
  for (let order = 7; order <= 10; order += 1) assert.equal(stageOf(contract, order).status, StageStatus.NOT_REACHED);
});

test('the analysis itself carries a bounded contract', async () => {
  const analysis = await analyzeRequest({ request: 'what do you remember about the launch date', requestId: 'op-8' });
  assert.equal(analysis.available, true);
  assert.equal(analysis.contract.requestId, 'op-8');
  const audit = contractAudit(analysis.contract);
  assert.equal(audit.reachedThrough, 5);
  assert.equal(audit.authority.authorizationOwner, 'action_registry');
  assert.equal(audit.authority.cognitiveOutputGrantsAuthorization, false);
  // The audit shape is fixed: no free text field exists that could carry a request or model answer.
  assert.deepEqual(Object.keys(audit).sort(), [
    'authority', 'checks', 'ok', 'reachedThrough', 'requestId', 'schema', 'stages',
  ]);
  assert.deepEqual(Object.keys(audit.stages[0]).sort(), ['counts', 'name', 'order', 'owner', 'status']);
});

test('contract labels are restricted to vocabulary tokens, never prose', () => {
  const analysis = {
    ...ANALYSIS,
    deliberation: {
      ...ANALYSIS.deliberation,
      decision: 'the user should probably run the thing',
      uncertainty: { category: 'I think it is right' },
    },
  };
  const contract = buildContract({ requestId: 'op-9', analysis });
  assert.deepEqual(stageOf(contract, 5).labels, {});
});

// End to end through the real controller and audit log. The model reply is fixed text; every
// decision that matters (parse, registry authorization, execution, verification) is the real
// implementation. The contract must show the proposal reaching stage 6 and being refused at stage 7.
test('a model proposal reaches the contract and is refused before execution', async () => {
  const dataDir = makeTempDataDir();
  dirs.push(dataDir);
  const gateway = stubGateway([
    'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the model decided this"}}',
    'I recorded that for you.',
  ].join('\n'));
  const app = createApp({ dataDir, gateway });
  const res = await app.controller.handle('tell me something about the sky', { origin: 'user' });
  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);

  const stored = readJsonl(path.join(dataDir, 'operations.jsonl')).at(-1);
  const contract = stored.cognition.contract;
  assert.ok(contract, 'the audit record carries the contract');
  assert.equal(contract.ok, true);
  assert.equal(contract.reachedThrough, 7);
  const byOrder = Object.fromEntries(contract.stages.map((entry) => [entry.order, entry]));
  assert.equal(byOrder[6].status, StageStatus.RAN);
  assert.deepEqual(byOrder[6].counts, { observed: 1, well_formed: 1, malformed: 0, overflow: 0 });
  assert.deepEqual(byOrder[7].counts, { requests: 1, allowed: 0, denied: 1 });
  assert.equal(byOrder[8].status, StageStatus.SKIPPED);
  assert.equal(byOrder[9].status, StageStatus.NOT_REACHED);
  assert.equal(contract.authority.cognitiveOutputGrantsAuthorization, false);
  assert.equal(contract.authority.authorizationOwner, 'action_registry');
  assert.equal(stored.steps[0].authorization.decision, 'deny');
  assert.equal(stored.model.class, 'valid');
  assert.equal(stored.model.provenance.requestId, stored.id);
  assert.equal(stored.model.provenance.verified, false);
});
