// Batch AP-13: one recorded, still-current contradicted expectation changes exactly one later
// recommendation - the next act the continuation ranking names for an approved plan - and nothing
// else. It does not start, approve, block, or authorize anything, and it is withdrawn the moment a
// fresh read stops confirming it.
//
// The unit tests read synthetic projections through the pure derivation. The store tests build a
// real ledger in a temporary directory. The end-to-end tests drive the real controller, goal, plan,
// prediction and experience stores with no model, no endpoint, and no inference of any kind.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome, OPERATION_SCHEMA } from '../src/outcomes.js';
import { OperationLog } from '../src/operations/operation-log.js';
import { ExperienceStore } from '../src/experience/experience-store.js';
import { PredictionStore } from '../src/prediction/prediction-store.js';
import { buildContinuation, planCapabilities, renderContinuation } from '../src/continuation/engine.js';
import { readinessOf, prioritizationFactors, renderReadiness } from '../src/executive/readiness.js';
import { ContinuationReadiness } from '../src/executive/vocabulary.js';
import {
  CAUTION_NOTE, EXPECTATION_CAUTION_RULE, MAX_EXPECTATION_CAUTIONS, cautionLine, cautionOf,
  deriveExpectationCautions,
} from '../src/prediction/caution.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW_MS = Date.parse('2026-11-05T09:00:00.000Z');
const at = (ms) => new Date(ms).toISOString();

// ---- synthetic projections --------------------------------------------------
// The shape the prediction store already derives. Each test changes exactly one field, so a withheld
// verdict names the record it refused instead of the fixture.
const projection = (over = {}) => ({
  id: 'pred-1',
  capability: 'probe.read',
  expectation: 'success',
  status: 'evaluated',
  createdAt: at(NOW_MS - 2 * DAY),
  expiresAt: at(NOW_MS + 5 * DAY),
  retired: false,
  evaluationStale: false,
  staleReason: null,
  counts: { matched: 0, contradicted: 1 },
  evaluation: {
    id: 'eval-1',
    verdict: 'contradicted',
    createdAt: at(NOW_MS - DAY),
    decidingExperienceId: 'exp-1',
    outcomeExperienceIds: ['exp-1', 'exp-2'],
    window: { since: at(NOW_MS - 2 * DAY), until: at(NOW_MS + 5 * DAY) },
  },
  ...over,
});

const viableCaution = (over = {}) => ({
  schema: 1,
  id: 'pred-1',
  capability: 'probe.read',
  expectation: 'success',
  verdict: 'contradicted',
  evaluationId: 'eval-1',
  decidedAt: at(NOW_MS - DAY),
  decidingExperienceId: 'exp-1',
  outcomeExperienceIds: ['exp-1'],
  window: { since: at(NOW_MS - 2 * DAY), until: at(NOW_MS + 5 * DAY) },
  predictionCreatedAt: at(NOW_MS - 2 * DAY),
  expiresAt: at(NOW_MS + 5 * DAY),
  rule: EXPECTATION_CAUTION_RULE,
  ...over,
});

describe('AP-13 caution derivation: what a contradicted verdict is allowed to become', () => {
  test('a live, current, evidence-confirmed contradicted verdict is a caution', () => {
    const { caution, withheld } = cautionOf(projection());
    assert.equal(withheld, null);
    assert.equal(caution.id, 'pred-1');
    assert.equal(caution.capability, 'probe.read');
    assert.equal(caution.verdict, 'contradicted');
    assert.equal(caution.decidingExperienceId, 'exp-1');
    assert.deepEqual(caution.outcomeExperienceIds, ['exp-1', 'exp-2']);
    assert.equal(caution.rule, EXPECTATION_CAUTION_RULE);
    assert.match(cautionLine(caution), /prediction .* expected probe\.read to end in success/);
    assert.match(cautionLine(caution), /`contradicted`/);
  });

  test('a matched verdict is not a caution', () => {
    const { caution, withheld } = cautionOf(projection({ evaluation: { ...projection().evaluation, verdict: 'matched' } }));
    assert.equal(caution, null);
    assert.match(withheld.reason, /`matched`, which is not a caution/);
  });

  test('a verdict with no evidence read is withheld, not softened into no caution', () => {
    const { caution, withheld } = cautionOf(projection({ counts: null }));
    assert.equal(caution, null);
    assert.match(withheld.reason, /experience log could not be read/);
  });

  test('a stale verdict is withheld and names why it no longer stands', () => {
    const { caution, withheld } = cautionOf(projection({
      evaluationStale: true,
      staleReason: 'a read now would report matched rather than contradicted',
    }));
    assert.equal(caution, null);
    assert.match(withheld.reason, /no longer stands: a read now would report matched/);
  });

  test('a withdrawn expectation is not scored', () => {
    const { caution, withheld } = cautionOf(projection({ status: 'invalidated' }));
    assert.equal(caution, null);
    assert.match(withheld.reason, /withdrew this expectation/);
  });

  test('a superseded or retired expectation is history, not guidance', () => {
    for (const record of [projection({ status: 'superseded' }), projection({ retired: true })]) {
      const { caution, withheld } = cautionOf(record);
      assert.equal(caution, null);
      assert.match(withheld.reason, /replaced it/);
    }
  });

  test('an unevaluated expectation states the state it was read in', () => {
    const { caution, withheld } = cautionOf(projection({ status: 'expired', evaluation: null }));
    assert.equal(caution, null);
    assert.match(withheld.reason, /no recorded verdict exists.*`expired`/);
  });

  test('the derivation is bounded and says so when it cuts', () => {
    const many = Array.from({ length: MAX_EXPECTATION_CAUTIONS + 2 }, (_, i) => projection({ id: `pred-${i}` }));
    const derived = deriveExpectationCautions({ projections: many, limit: MAX_EXPECTATION_CAUTIONS });
    assert.equal(derived.cautions.length, MAX_EXPECTATION_CAUTIONS);
    assert.equal(derived.truncated, true);
    assert.equal(derived.considered, many.length);
    assert.equal(derived.rule, EXPECTATION_CAUTION_RULE);
  });

  test('the denominator counts expectations that carry a verdict, not rows that became cautions', () => {
    const derived = deriveExpectationCautions({
      projections: [
        projection({ id: 'p-a' }),
        projection({ id: 'p-b', evaluation: { ...projection().evaluation, verdict: 'matched' } }),
        projection({ id: 'p-c', status: 'recorded', evaluation: null }),
      ],
    });
    assert.equal(derived.cautions.length, 1);
    assert.equal(derived.considered, 2, 'the unevaluated row is not in the denominator');
  });
});

// ---- the store read ---------------------------------------------------------
const EXP_FILE = (dir) => path.join(dir, 'experiences.jsonl');
const LEDGER_FILE = (dir) => path.join(dir, 'predictions.jsonl');

async function appendOperation(operations, { id, capability, status, atMs = NOW_MS }) {
  await operations.append({
    schema: OPERATION_SCHEMA, id, capability, origin: 'user', decision: 'answer',
    status, requestedAt: at(atMs), finishedAt: at(atMs), output: 'fixture',
  });
}

async function storeFixture({ withExperiences = true } = {}) {
  const dir = tempDir();
  const clock = { ms: NOW_MS };
  const now = () => new Date(clock.ms);
  const operations = new OperationLog(path.join(dir, 'operations.jsonl'));
  const experience = new ExperienceStore(EXP_FILE(dir), { now, operations });
  const predictions = new PredictionStore(LEDGER_FILE(dir), { now, experiences: withExperiences ? experience : null });
  return { dir, clock, operations, experience, predictions };
}

async function seededLedger(fixture, { capability = 'probe.read', outcome = 'execution_failed', expectation = 'success' } = {}) {
  await appendOperation(fixture.operations, { id: 'op-eval-write', capability: 'prediction.evaluate', status: 'success_verified' });
  const { record } = await fixture.predictions.recordPrediction({
    capability, expectation, subject: 'the probe read succeeds',
    expiresAt: at(NOW_MS + 7 * DAY), origin: 'user',
  });
  await appendOperation(fixture.operations, { id: 'op-outcome', capability, status: outcome, atMs: NOW_MS + HOUR });
  const { record: experience } = await fixture.experience.recordExperience({
    operationId: 'op-outcome', subject: 'the probe read ran', origin: 'user',
  });
  fixture.clock.ms = NOW_MS + DAY;
  const evaluation = await fixture.predictions.recordEvaluation({
    target: record.id, origin: 'user', provenance: { operationId: 'op-eval-write' },
  });
  fixture.clock.ms = NOW_MS;
  return { predictionId: record.id, experienceId: experience.id, verdict: evaluation.record?.verdict ?? null };
}

describe('AP-13 store read: scoped, bounded, and honest about what it could not read', () => {
  test('a live contradicted verdict is returned for the capability in scope', async () => {
    const f = await storeFixture();
    const seeded = await seededLedger(f);
    assert.equal(seeded.verdict, 'contradicted');
    const read = await f.predictions.expectationCautions({ capabilities: ['probe.read'] });
    assert.equal(read.unavailable, null);
    assert.equal(read.cautions.length, 1);
    assert.equal(read.cautions[0].id, seeded.predictionId);
    assert.equal(read.considered, 1);
    assert.equal(read.storedEvaluated, 1);
    assert.equal(read.rule, EXPECTATION_CAUTION_RULE);
    assert.ok(read.derivedAt, 'the read states the instant it was derived at');
  });

  test('a capability outside the scope opens no horizon and yields nothing', async () => {
    const f = await storeFixture();
    await seededLedger(f);
    const read = await f.predictions.expectationCautions({ capabilities: ['memory.list'] });
    assert.deepEqual(read.cautions, []);
    assert.equal(read.storedEvaluated, 0);
    assert.equal(read.rule, EXPECTATION_CAUTION_RULE);
  });

  test('no capability in scope is stated, and no ledger is opened', async () => {
    const f = await storeFixture();
    const read = await f.predictions.expectationCautions({ capabilities: [] });
    assert.deepEqual(read.cautions, []);
    assert.match(read.note, /no capability was in scope/);
    assert.equal(read.rule, EXPECTATION_CAUTION_RULE);
  });

  test('a corrupt ledger is unavailable, never an empty result', async () => {
    const f = await storeFixture();
    fs.mkdirSync(path.dirname(LEDGER_FILE(f.dir)), { recursive: true });
    fs.writeFileSync(LEDGER_FILE(f.dir), '{not json}\n');
    const read = await f.predictions.expectationCautions({ capabilities: ['probe.read'] });
    assert.deepEqual(read.cautions, []);
    assert.match(read.unavailable, /prediction log could not be read/);
  });

  test('an expectation withdrawn after evaluation is not a caution', async () => {
    const f = await storeFixture();
    const seeded = await seededLedger(f);
    await f.predictions.invalidatePrediction({
      target: seeded.predictionId, reason: 'the user withdrew it', origin: 'user',
      provenance: { operationId: 'op-eval-write' },
    });
    const read = await f.predictions.expectationCautions({ capabilities: ['probe.read'] });
    assert.deepEqual(read.cautions, []);
    assert.equal(read.considered, 0, 'a withdrawn expectation is not in the denominator either');
  });

  test('the scope is bounded to the first eight capabilities, and the cut is disclosed', async () => {
    const f = await storeFixture({ withExperiences: false });
    const capabilities = Array.from({ length: 10 }, (_, i) => `probe.c${i}`);
    const read = await f.predictions.expectationCautions({ capabilities });
    assert.equal(read.capabilities.length, 8);
    assert.equal(read.capabilitiesTruncated, true);
  });
});

// ---- the continuation ranking ----------------------------------------------
const planRecord = (over = {}) => ({
  id: 'plan-1',
  goalId: 'goal-1',
  status: 'approved',
  outcome: 'the probe read is verified',
  version: 1,
  steps: [{ id: 's1', action: 'probe.read', dependsOn: [], risk: 'low' }],
  ...over,
});
const validPlan = { ok: true, problems: [], checks: [] };
const stalePlan = { ok: false, problems: ['live state changed since approval'], checks: [] };
const CLOCK = new Date(NOW_MS);

function rank({ plan = planRecord(), validity = validPlan, cautions = [] } = {}) {
  return buildContinuation({
    plans: [plan], validityByPlan: new Map([[plan.id, validity]]), cautions, now: CLOCK,
  });
}

describe('AP-13 ranking: one recommendation moves, and only one', () => {
  test('without a caution an approved plan is started', () => {
    const report = rank();
    const top = report.candidates[0];
    assert.equal(top.action, 'start-plan');
    assert.equal(top.score, 75);
    assert.equal(top.requiresAuthorization, true);
    assert.deepEqual(top.cautions, []);
    assert.equal(top.cautionChangedAction, false);
  });

  test('a caution for a capability the plan runs replaces the start with a read', () => {
    const report = rank({ cautions: [viableCaution()] });
    const top = report.candidates[0];
    assert.equal(top.action, 'review-expectation');
    assert.equal(top.score, 62, 'the read is scored below the start it replaces');
    assert.equal(top.ready, true, 'the plan is still ready');
    assert.equal(top.readiness, ContinuationReadiness.READY_TO_EXECUTE);
    assert.equal(top.cautionChangedAction, true);
    assert.equal(top.cautions.length, 1);
    assert.equal(top.requiresAuthorization, false, 'reading a record needs no authorization');
    assert.match(top.command, /plan candidates goal-1/);
    assert.ok(top.reasons.some((r) => /contradicted/.test(r)));
    assert.ok(top.reasons.some((r) => /changed no readiness state, approval, or authorization/.test(r)));
  });

  test('a caution for a capability the plan does not run changes nothing', () => {
    const report = rank({ cautions: [viableCaution({ capability: 'memory.list' })] });
    assert.equal(report.candidates[0].action, 'start-plan');
    assert.deepEqual(report.candidates[0].cautions, []);
  });

  test('a stale plan keeps its revalidation; the caution is disclosed but moves nothing', () => {
    const report = rank({ validity: stalePlan, cautions: [viableCaution()] });
    const top = report.candidates[0];
    assert.equal(top.action, 'review-plan');
    assert.equal(top.cautionChangedAction, false);
    assert.equal(top.cautions.length, 1);
    assert.equal(top.ready, false);
    assert.equal(top.readiness, ContinuationReadiness.BLOCKED);
  });

  test('a plan with no goal is reviewed with a read of the plan itself', () => {
    const report = rank({ plan: planRecord({ goalId: null }), cautions: [viableCaution()] });
    assert.equal(report.candidates[0].action, 'review-expectation');
    assert.match(report.candidates[0].command, /plan show plan-1/);
  });

  test('the printed ranking names the caution and says what did not change', () => {
    const text = renderContinuation(rank({ cautions: [viableCaution()] }));
    assert.match(text, /caution: prediction .*contradicted/);
    assert.ok(text.includes(CAUTION_NOTE));
    assert.match(text, /next: node bin\/apex\.js plan candidates goal-1/);
    assert.doesNotMatch(text, /next: node bin\/apex\.js plan start/);
  });

  test('plan capabilities are read from the step actions alone', () => {
    assert.deepEqual(planCapabilities(planRecord()), ['probe.read']);
    assert.deepEqual(planCapabilities({ steps: [{ action: 'probe.read' }, { action: 'probe.read' }, { action: '' }] }), ['probe.read']);
    assert.deepEqual(planCapabilities({ steps: [] }), []);
    assert.deepEqual(planCapabilities(null), []);
  });
});

// ---- readiness --------------------------------------------------------------
describe('AP-13 readiness: disclosure beside the state, never a state', () => {
  const ready = () => readinessOf({ plan: planRecord(), validity: validPlan, cautions: [viableCaution()] });

  test('the state is unchanged and the caution is a factor', () => {
    const reading = ready();
    assert.equal(reading.readiness, ContinuationReadiness.READY_TO_EXECUTE);
    assert.equal(reading.expectationCautions.length, 1);
    const text = reading.factors.map((f) => f.factor).join('\n');
    assert.match(text, /contradicted at/);
    assert.match(text, /changes nothing about it/);
  });

  test('the printed reading states the caution and repeats what did not change', () => {
    const text = renderReadiness(ready());
    assert.match(text, /Readiness: ready to execute\./);
    assert.match(text, /caution: prediction .*contradicted/);
    assert.ok(text.includes(CAUTION_NOTE));
  });

  test('an unread caution is disclosed, and the state stands', () => {
    const reading = readinessOf({
      plan: planRecord(), validity: validPlan,
      cautionRead: { cautions: [], unavailable: 'the prediction log could not be read: boom' },
    });
    assert.equal(reading.readiness, ContinuationReadiness.READY_TO_EXECUTE);
    assert.deepEqual(reading.expectationCautions, []);
    assert.match(reading.factors.map((f) => f.factor).join('\n'), /did not complete.*boom/);
    assert.match(renderReadiness(reading), /the expectation read did not complete/);
  });

  test('no read attempted is null, not an empty list', () => {
    const reading = readinessOf({ plan: planRecord(), validity: validPlan });
    assert.equal(reading.expectationCautions, null);
  });

  test('a closed plan carries no caution', () => {
    const reading = readinessOf({
      plan: planRecord({ status: 'completed' }), cautions: [viableCaution()],
    });
    assert.equal(reading.expectationCautions, null);
  });

  test('the prioritization factors name the caution and the substitution', () => {
    const factors = prioritizationFactors({
      kind: 'plan', ref: 'plan-1', action: 'review-expectation', priority: null, deadline: null,
      risk: null, blockers: [], ready: true, requiresAuthorization: false, score: 62,
      cautions: [viableCaution()], cautionChangedAction: true,
    });
    const text = factors.factors.map((f) => f.factor).join('\n');
    assert.match(text, /a caution replaced the recommended start with a read/);
  });
});

// ---- end-to-end -------------------------------------------------------------
const PROBE_ACTION = {
  name: 'probe.read',
  description: 'test-only read whose execution verifies',
  inputHint: '{"tag":"text"}',
  permission: 'read',
  origins: ['user', 'model'],
  validate: (input) => ({ tag: String(input?.tag ?? 'x') }),
  async execute(_ctx, input) { return { summary: `read ${input.tag}`, data: { tag: input.tag } }; },
  async verify() { return { ok: true, detail: 'the probe action was re-read' }; },
};

function appOn(dir, clock) {
  return createApp({
    dataDir: dir, now: () => new Date(clock.ms), experienceCapture: CAPTURE_OFF, extraActions: [PROBE_ACTION],
  });
}

async function approvedPlan(app) {
  const created = await app.controller.goalAdd({ request: 'the probe goal', criteria: ['the read is verified'] });
  const goalId = created.operation.steps[0].result.data.goalId;
  await app.controller.goalUpdate({ target: goalId, status: 'accepted' });
  await app.controller.goalUpdate({ target: goalId, status: 'active' });
  const added = await app.controller.planAdd({
    goalId,
    outcome: 'the read is verified',
    steps: [{
      id: 's1', description: 'read the sensor', action: 'probe.read', input: { tag: 'a' },
      dependsOn: [], expectedResult: 'a reading is returned', verification: 'the reading is re-read',
      criterion: 'c1', risk: 'low',
    }],
  });
  const planId = added.operation.steps[0].result.data.planId;
  const approved = await app.controller.planApprove({ target: planId });
  assert.equal(approved.status, Outcome.PLAN_STORED, approved.output);
  return { goalId, planId };
}

// The audited operations below are written by the fixture, not by an action, exactly as the
// prediction suites do: an outcome has to be a record before an expectation can be judged by it.
let opSeq = 0;
const opId = () => `ap13-op-${String(++opSeq).padStart(3, '0')}`;

async function auditedOutcome(app, clock, { capability, status, hours = 1 }) {
  const id = opId();
  const when = at(clock.ms + hours * HOUR);
  await app.operations.append({
    schema: OPERATION_SCHEMA, id, capability, origin: 'user', decision: 'answer',
    status, requestedAt: when, finishedAt: when, output: 'fixture outcome',
  });
  return id;
}

async function contradictProbe(app, clock, { expectation = 'success', outcome = 'execution_failed' } = {}) {
  const recordOp = await auditedOutcome(app, clock, { capability: 'prediction.record', status: 'success_verified', hours: 0 });
  const recorded = await app.controller.runAction('prediction.record', {
    capability: 'probe.read', expectation, subject: 'the probe read succeeds', inDays: 7,
  }, 'user', recordOp);
  assert.equal(recorded.outcome, Outcome.SUCCESS_VERIFIED, recorded.summary);
  const predictionId = recorded.result.data.id;

  const evidenceOp = await auditedOutcome(app, clock, { capability: 'probe.read', status: outcome });
  const experience = await app.experience.recordExperience({
    operationId: evidenceOp, subject: 'the probe read ran', origin: 'user',
  });

  clock.ms = NOW_MS + DAY;
  const evalOp = await auditedOutcome(app, clock, { capability: 'prediction.evaluate', status: 'success_verified', hours: 0 });
  const evaluated = await app.controller.runAction('prediction.evaluate', { target: predictionId }, 'user', evalOp);
  clock.ms = NOW_MS;
  assert.equal(evaluated.outcome, Outcome.SUCCESS_VERIFIED, evaluated.summary);
  return {
    predictionId,
    experienceId: experience.record.id,
    verdict: evaluated.result.data.verdict,
    evaluationId: evaluated.result.data.evaluationId,
  };
}

async function seededApp() {
  const dir = tempDir();
  const clock = { ms: NOW_MS };
  const app = await appOn(dir, clock);
  const { goalId, planId } = await approvedPlan(app);
  return { dir, clock, app, goalId, planId };
}

describe('AP-13 end to end: an expectation changes the next act a user is shown', () => {
  test('the plan is recommended for start, then for review, and is never changed', async () => {
    const { app, clock, planId } = await seededApp();
    const before = await app.controller.continuationReport();
    assert.equal(before.candidates[0].action, 'start-plan');
    assert.equal(before.cautionRead.cautions, 0);

    const planBefore = (await app.controller.showPlan(planId)).plan;
    const approvalsBefore = JSON.stringify((await app.plans.inspect()).plans);

    const seeded = await contradictProbe(app, clock);
    assert.equal(seeded.verdict, 'contradicted');

    const after = await app.controller.continuationReport();
    const top = after.candidates[0];
    assert.equal(top.action, 'review-expectation');
    assert.equal(top.ready, true);
    assert.equal(top.readiness, ContinuationReadiness.READY_TO_EXECUTE);
    assert.equal(top.cautions[0].id, seeded.predictionId);
    assert.equal(top.cautions[0].evaluationId, seeded.evaluationId);
    assert.match(after.display, /caution: prediction .*contradicted/);
    assert.ok(after.display.includes(CAUTION_NOTE));

    const planAfter = (await app.controller.showPlan(planId)).plan;
    assert.equal(JSON.stringify(planAfter), JSON.stringify(planBefore), 'the plan bytes and approval are untouched');
    assert.equal(JSON.stringify((await app.plans.inspect()).plans), approvalsBefore, 'the plan log gained no record');
  });

  test('the readiness answer states the same state and discloses the caution', async () => {
    const { app, clock } = await seededApp();
    await contradictProbe(app, clock);
    const answer = await app.controller.handle('is the plan ready to start?', { origin: 'user' });
    assert.equal(answer.status, Outcome.SUCCESS_VERIFIED);
    assert.match(answer.display, /Readiness: ready to execute\./);
    assert.match(answer.display, /caution: prediction .*contradicted/);
    assert.ok(answer.display.includes(CAUTION_NOTE));
    assert.match(answer.display, /review-expectation/);
  });

  test('withdrawing the expectation restores the previous recommendation', async () => {
    const { app, clock } = await seededApp();
    const seeded = await contradictProbe(app, clock);
    assert.equal((await app.controller.continuationReport()).candidates[0].action, 'review-expectation');

    const withdrawOp = await auditedOutcome(app, clock, { capability: 'prediction.invalidate', status: 'success_verified', hours: 0 });
    const withdrawn = await app.controller.runAction('prediction.invalidate', {
      target: seeded.predictionId, reason: 'the user withdrew the expectation',
    }, 'user', withdrawOp);
    assert.equal(withdrawn.outcome, Outcome.SUCCESS_VERIFIED, withdrawn.summary);

    const after = await app.controller.continuationReport();
    assert.equal(after.candidates[0].action, 'start-plan');
    assert.equal(after.cautionRead.cautions, 0);
    assert.doesNotMatch(after.display, /caution:/);
  });

  test('a verdict the evidence no longer carries is withheld, and the plan is started again', async () => {
    const { app, clock } = await seededApp();
    const seeded = await contradictProbe(app, clock);

    // A corrected experience: the user records that the same capability actually succeeded, naming
    // the experience the verdict rested on. The recorded verdict stands, but a fresh read disagrees.
    const correctedOp = await auditedOutcome(app, clock, { capability: 'probe.read', status: 'success_verified', hours: 2 });
    await app.experience.recordExperience({
      operationId: correctedOp, subject: 'the probe read succeeded after all', origin: 'user',
      replaces: [seeded.experienceId],
    });

    const after = await app.controller.continuationReport();
    assert.equal(after.candidates[0].action, 'start-plan', 'a verdict that no longer stands is not a caution');
    assert.equal(after.cautionRead.cautions, 0);
  });

  test('a matched verdict changes nothing', async () => {
    const { app, clock } = await seededApp();
    const seeded = await contradictProbe(app, clock, { expectation: 'failure', outcome: 'execution_failed' });
    assert.equal(seeded.verdict ?? 'matched', 'matched');
    const report = await app.controller.continuationReport();
    assert.equal(report.candidates[0].action, 'start-plan');
    assert.equal(report.cautionRead.cautions, 0);
  });

  test('a fresh process derives the same recommendation from the same records', async () => {
    const { dir, clock } = await seededApp();
    const first = await appOn(dir, clock);
    const probe = await approvedPlanProbe(first);
    await contradictProbe(first, clock);

    const restarted = await appOn(dir, clock);
    const report = await restarted.controller.continuationReport();
    assert.equal(report.candidates[0].action, 'review-expectation');
    assert.equal(report.candidates[0].ref, probe.id);
  });

  test('a corrupt prediction ledger is reported, and the plan is still recommended for start', async () => {
    const { dir, clock, app } = await seededApp();
    const before = (await app.controller.continuationReport()).candidates[0].action;
    assert.equal(before, 'start-plan');
    fs.writeFileSync(path.join(dir, 'predictions.jsonl'), '{not json}\n');

    const report = await app.controller.continuationReport();
    assert.equal(report.candidates[0].action, 'start-plan');
    assert.ok(report.problems.some((p) => /expectations: the prediction log could not be read/.test(p)), report.problems.join('\n'));
    assert.match(report.display, /Problems reading records/);
  });

  test('a model origin cannot record the expectation the caution rests on', async () => {
    const { app, clock, dir } = await seededApp();
    await auditedOutcome(app, clock, { capability: 'prediction.record', status: 'success_verified', hours: 0 });
    const denied = await app.controller.runAction('prediction.record', {
      capability: 'probe.read', expectation: 'success', subject: 'the probe read succeeds', inDays: 7,
    }, 'model', 'ap13-model-write');
    assert.equal(denied.outcome, Outcome.ACTION_DENIED);
    assert.equal(denied.authorization.decision, 'deny');
    assert.equal(fs.existsSync(path.join(dir, 'predictions.jsonl')), false, 'a refused write creates no ledger');
  });

  test('reading the recommendation writes nothing', async () => {
    const { dir, clock, app } = await seededApp();
    await contradictProbe(app, clock);
    const files = ['predictions.jsonl', 'plans.jsonl', 'experiences.jsonl', 'operations.jsonl'];
    const snapshot = () => files.map((name) => {
      const file = path.join(dir, name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    });

    const before = snapshot();
    await app.controller.continuationReport();
    assert.deepEqual(snapshot(), before, 'the continuation read appended no ledger, plan, experience, or audit record');
    assert.ok(before[0]?.length > 0, 'the fixture did record an expectation, so the comparison is not vacuous');
  });

  test('answering a question audits that answer and changes nothing else', async () => {
    const { dir, clock, app } = await seededApp();
    await contradictProbe(app, clock);
    const read = (name) => {
      const file = path.join(dir, name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    };
    const lines = (text) => text.split('\n').filter((line) => line.trim() !== '').length;

    const beforeRecords = JSON.stringify([read('predictions.jsonl'), read('plans.jsonl'), read('experiences.jsonl')]);
    const operationsBefore = lines(read('operations.jsonl'));

    const answer = await app.controller.handle('is the plan ready to start?', { origin: 'user' });
    assert.equal(answer.status, Outcome.SUCCESS_VERIFIED);

    assert.equal(
      JSON.stringify([read('predictions.jsonl'), read('plans.jsonl'), read('experiences.jsonl')]),
      beforeRecords,
      'answering appends no prediction, plan, or experience record',
    );
    assert.equal(lines(read('operations.jsonl')), operationsBefore + 1, 'the answer itself is audited, once');
    const last = JSON.parse(read('operations.jsonl').trim().split('\n').at(-1));
    assert.equal(last.origin, 'user', 'the audit record names the user origin');
    assert.equal(last.capability, 'executive.status', 'the audit record names the read the answer performed');
  });
});

// The restart test needs the plan id for the fresh process without creating a second goal there.
async function approvedPlanProbe(app) {
  const plans = (await app.plans.inspect()).plans;
  return plans[0];
}
