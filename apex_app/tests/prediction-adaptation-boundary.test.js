// Implementation 114 (Batch AF-21): the prediction -> evaluation -> adaptation boundary.
//
// WHAT IS A STUB AND WHAT IS REAL: the only test double is a backend that returns fixed text, used
// where a request would otherwise reach for a model. No inference is run or simulated. Everything
// that decides an outcome here is the real implementation: the assembled app, each store's write lock
// and validation, the prediction engine's horizon rules, the adaptation derivation rule, the action
// registry's authorization, the independent verifiers, and the audit log.
//
// The six claims AF-21 lists are each tested against the persisted files rather than against a
// rendered string, because a reader can be reworded and an append-only log cannot: a boundary that
// holds is visible as the records that exist after each step.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';

const dirs = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    try { cleanup(dir); } catch { /* already removed */ }
  }
});

// A movable clock: a horizon is a statement about time, so a test that has to wait for one to pass
// moves it instead of sleeping.
function clock(start) {
  let ms = Date.parse(start);
  return Object.assign(() => new Date(ms), {
    advance(days) { ms += days * 86_400_000; },
    iso() { return new Date(ms).toISOString(); },
  });
}

// TEST DOUBLE: a backend that answers with fixed text.
function stubGateway() {
  return new ModelGateway({
    backend: {
      name: 'stub-reply',
      provider: 'stub-reply',
      configured: true,
      describe: () => ({ configured: true, provider: 'stub-reply', endpoint: 'stub-reply', model: 'stub-reply' }),
      health: async () => ({ available: true, detail: 'stub reply' }),
      complete: async () => ({
        ok: true, backend: 'stub-reply', provider: 'stub-reply', model: 'stub-reply',
        text: 'the sky is blue', finishReason: 'stop', truncated: false, latencyMs: 0,
      }),
    },
  });
}

const NOW = '2026-01-05T09:00:00.000Z';

function appFor({ experienceCapture } = {}) {
  const dataDir = tempDir();
  const now = clock(NOW);
  const options = { dataDir, gateway: stubGateway(), now };
  if (experienceCapture !== undefined) options.experienceCapture = experienceCapture;
  return { dataDir, now, app: createApp(options) };
}

const bytes = (dir, name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name)) : null);
const lines = (dir, name) => {
  const raw = bytes(dir, name);
  return raw === null || raw.length === 0 ? [] : raw.toString('utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
};
const FILE_NAMES = ['memory.jsonl', 'conversation.jsonl', 'operations.jsonl', 'session.json', 'tasks.jsonl',
  'task-summary-queue.json', 'knowledge.jsonl', 'experiences.jsonl', 'predictions.jsonl'];
const sizes = (dir) => Object.fromEntries(FILE_NAMES.map((name) => [name, bytes(dir, name)?.length ?? 0]));
const changed = (before, after) => FILE_NAMES.filter((name) => before[name] !== after[name]);

const horizon = (now, days) => new Date(Date.parse(now.iso()) + days * 86_400_000).toISOString();

// A live memory write, audited under its own capability: the kind of event an expectation is later
// judged against.
async function memoryWrite(app, subject) {
  const result = await app.controller.handle(`remember that ${subject}`, { origin: 'user' });
  return { result, operation: result.operation };
}

// A write the system correctly refused, which is an outcome of a different class (blocked).
async function refusedWrite(app, secret) {
  const result = await app.controller.handle(`remember that the token is ${secret}`, { origin: 'user' });
  return { result, operation: result.operation };
}

async function experienceOf(app, operation, subject) {
  await app.experience.recordExperience({ operationId: operation.id, subject, origin: 'user' });
  return (await app.experience.list({ limit: 10 })).find((e) => e.operationId === operation.id);
}

async function recordExpectation(app, now, { capability = 'memory.add', expectation = 'success', subject, days = 7, replaces = [] }) {
  const { record } = await app.predictions.recordPrediction({
    capability, expectation, subject, expiresAt: horizon(now, days), replaces, origin: 'user',
  });
  return record;
}

// Two corrective feedbacks on two distinct experiences in one capability scope, then a derivation:
// the whole of the evidence an adaptation candidate requires, and nothing more.
async function seedCandidate(app) {
  for (const subject of ['the gate is open', 'the hinge is oiled']) {
    const { operation } = await memoryWrite(app, subject);
    const experience = await experienceOf(app, operation, `a memory write about ${subject}`);
    await app.controller.feedbackRecord({ target: experience.id, assessment: 'incorrect', guidance: 'always confirm before writing' });
  }
  await app.controller.adaptationDerive({});
  const [adaptation] = await app.experience.adaptations({ limit: 5 });
  return adaptation;
}

describe('recording an expectation creates no experience', () => {
  test('a prediction appends to the prediction ledger and to nothing else', async () => {
    // Automatic capture is switched on, so the one route that could turn an expectation into an
    // observation is open - and must still produce nothing.
    const { dataDir, app } = appFor({ experienceCapture: 'verified-success' });
    const before = sizes(dataDir);

    const recorded = await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success', subject: 'the gate stays open', inDays: 7,
    });
    assert.equal(recorded.status, Outcome.SUCCESS_VERIFIED);

    const predictions = lines(dataDir, 'predictions.jsonl');
    assert.equal(predictions.length, 1, 'the ledger holds the expectation');
    assert.equal(predictions[0].kind, 'prediction');
    assert.deepEqual(lines(dataDir, 'experiences.jsonl'), [], 'an expectation is not an experience');
    assert.equal(changed(before, sizes(dataDir)).includes('experiences.jsonl'), false,
      'no experience record was written');
    const ops = lines(dataDir, 'operations.jsonl');
    assert.equal(ops.filter((o) => o.capability === 'prediction.record').length, 1);
    assert.equal(ops.filter((o) => o.capability === 'memory.add').length, 0, 'recording an expectation writes no memory');
  });

  test('an expectation cannot cite an experience that does not exist', async () => {
    const { dataDir, now, app } = appFor();
    const invented = '0f1e2d3c-4b5a-6978-8776-554433221100';
    await assert.rejects(
      () => app.predictions.recordPrediction({
        capability: 'memory.add', expectation: 'success', subject: 'cites a record that is not there',
        expiresAt: horizon(now, 7), origin: 'user', evidence: { supportingExperienceIds: [invented] },
      }),
      /does not contain|can only cite a recorded event/,
    );
    assert.deepEqual(lines(dataDir, 'predictions.jsonl'), [], 'a refused citation appended nothing');
    assert.deepEqual(lines(dataDir, 'experiences.jsonl'), []);
  });

  test('the ledger reports an expectation as standing on nothing until an outcome is recorded', async () => {
    const { now, app } = appFor();
    const expectation = await recordExpectation(app, now, { subject: 'the next write lands' });
    const projection = (await app.predictions.list({ limit: 5 })).projections.find((p) => p.id === expectation.id);
    assert.equal(projection.status, 'recorded');
    assert.equal(projection.evaluationDecision, 'outcome_unavailable');
    assert.equal(projection.canRecordEvaluation, false, 'nothing establishes it yet');
    assert.equal(projection.evidenceBasis, 'none_cited');
    assert.deepEqual(projection.evaluation, null);
  });
});

describe('an evaluation is a verdict on records, not a permission', () => {
  test('a matched verdict changes no experience, no adaptation and no authorization', async () => {
    const { dataDir, now, app } = appFor();
    const adaptation = await seedCandidate(app);
    assert.equal(adaptation.decisionState, 'candidate');

    const expectation = await recordExpectation(app, now, { subject: 'the next memory write works' });
    now.advance(1);
    await experienceOf(app, (await memoryWrite(app, 'the gate held')).operation, 'the write landed');

    const before = sizes(dataDir);
    const definition = JSON.stringify(app.registry.get('memory.add'));
    const { record, projection } = await app.predictions.recordEvaluation({ target: expectation.id, origin: 'user' });
    assert.equal(record.verdict, 'matched');
    assert.equal(projection.evaluation.verdict, 'matched');
    assert.deepEqual(changed(before, sizes(dataDir)), ['predictions.jsonl'],
      'the verdict is one appended ledger line; no audit, belief or experience file moved');

    // The candidate the same evidence produced is untouched: no decision record, still unapproved.
    const after = (await app.experience.adaptations({ limit: 5 })).find((a) => a.id === adaptation.id);
    assert.equal(after.decisionState, 'candidate', 'a correct prediction approved nothing');
    assert.equal(after.active, false);
    assert.deepEqual(lines(dataDir, 'experiences.jsonl').filter((r) => r.kind === 'adaptation_decision'), [],
      'no user decision was manufactured');
    assert.equal(lines(dataDir, 'predictions.jsonl').length, 2, 'one expectation plus one evaluation');

    // Authorization is unchanged: the capability the ledger just called correct is still a user-only
    // write, and its registered definition is the same text it was before the verdict.
    assert.equal(JSON.stringify(app.registry.get('memory.add')), definition);
    assert.deepEqual(app.registry.get('memory.add').origins, ['user']);
    const denied = app.registry.authorize('memory.add', 'model');
    assert.equal(denied.decision, 'deny');
    assert.equal(denied.reason, 'ORIGIN_NOT_PERMITTED');
  });

  test('a matched verdict grants the model no permission it did not already lack', async () => {
    const { now, app } = appFor();
    const expectation = await recordExpectation(app, now, { subject: 'the write lands' });
    now.advance(1);
    await experienceOf(app, (await memoryWrite(app, 'the gate held')).operation, 'the write landed');
    const { record } = await app.predictions.recordEvaluation({ target: expectation.id, origin: 'user' });
    assert.equal(record.verdict, 'matched');

    // The same write the prediction just called correct, attempted on the model's own authority.
    const step = await app.controller.runAction('memory.add', { content: 'the model wrote this itself' }, 'model', 'af21-model-attempt');
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.equal(step.execution.status, 'not_run');
    assert.equal(step.authorization.reason, 'ORIGIN_NOT_PERMITTED');
  });

  test('a contradicted verdict leaves every earlier record exactly as it was', async () => {
    const { dataDir, now, app } = appFor();

    // A first expectation the evidence settles as correct.
    const matched = await recordExpectation(app, now, { subject: 'the first write lands' });
    now.advance(1);
    await experienceOf(app, (await memoryWrite(app, 'the gate held')).operation, 'a landed write');
    const first = await app.predictions.recordEvaluation({ target: matched.id, origin: 'user' });
    assert.equal(first.record.verdict, 'matched');

    // The history a wrong expectation is now about to be recorded against, frozen byte for byte.
    const ledgerBefore = bytes(dataDir, 'predictions.jsonl');
    const experiencesBefore = bytes(dataDir, 'experiences.jsonl');
    const auditBefore = bytes(dataDir, 'operations.jsonl');
    const memoryBefore = bytes(dataDir, 'memory.jsonl');
    const knowledgeBefore = bytes(dataDir, 'knowledge.jsonl');

    // A second expectation, settled by an operation the system correctly refused.
    now.advance(1);
    const contradicted = await recordExpectation(app, now, { subject: 'the next write is accepted', days: 3 });
    const refusal = await refusedWrite(app, 'sk-synthetic-abcdef0123456789');
    assert.equal(refusal.result.status, Outcome.INPUT_REJECTED);
    assert.equal(refusal.operation.capability, 'memory.add');
    await experienceOf(app, refusal.operation, 'a refused write');

    const second = await app.predictions.recordEvaluation({ target: contradicted.id, origin: 'user' });
    assert.equal(second.record.verdict, 'contradicted');

    // The ledger grew; nothing in it was rewritten, so the earlier verdict and the records it was
    // judged against are the same bytes they were.
    const ledgerAfter = bytes(dataDir, 'predictions.jsonl');
    assert.ok(ledgerAfter.length > ledgerBefore.length);
    assert.ok(ledgerAfter.subarray(0, ledgerBefore.length).equals(ledgerBefore), 'the prediction log was appended to, never rewritten');
    assert.ok(bytes(dataDir, 'experiences.jsonl').subarray(0, experiencesBefore.length).equals(experiencesBefore));
    assert.ok(bytes(dataDir, 'operations.jsonl').subarray(0, auditBefore.length).equals(auditBefore));
    assert.deepEqual(bytes(dataDir, 'memory.jsonl'), memoryBefore, 'a wrong expectation retired no memory');
    assert.deepEqual(bytes(dataDir, 'knowledge.jsonl'), knowledgeBefore);

    const again = (await app.predictions.list({ limit: 5 })).projections.find((p) => p.id === matched.id);
    assert.equal(again.evaluation.verdict, 'matched', 'the first verdict still reads the same');
    assert.equal(again.evaluation.id, first.record.id);
    assert.equal(again.status, 'evaluated');

    // The blocked record appended afterwards also falls inside the first expectation's horizon, so a
    // fresh read would settle it differently. The difference is disclosed and the record is left
    // alone - which is the whole of what "does not alter historical records" has to mean here.
    assert.equal(again.evaluationStale, true, 'the newer evidence is disclosed rather than suppressed');
    assert.match(again.staleReason, /the recorded evaluation stands and the difference is disclosed, never rewritten/);
  });

  test('a second evaluation is refused and rewrites nothing', async () => {
    const { dataDir, now, app } = appFor();
    const expectation = await recordExpectation(app, now, { subject: 'the write lands' });
    now.advance(1);
    await experienceOf(app, (await memoryWrite(app, 'the gate held')).operation, 'a landed write');
    await app.predictions.recordEvaluation({ target: expectation.id, origin: 'user' });

    const ledger = bytes(dataDir, 'predictions.jsonl');
    await assert.rejects(
      () => app.predictions.recordEvaluation({ target: expectation.id, origin: 'user' }),
      /already has a recorded evaluation/,
    );
    assert.deepEqual(bytes(dataDir, 'predictions.jsonl'), ledger, 'a refusal appended nothing');
  });

  test('an evaluation of a superseded expectation records nothing', async () => {
    const { dataDir, now, app } = appFor();
    const first = await recordExpectation(app, now, { subject: 'the first expectation' });
    await recordExpectation(app, now, { subject: 'the later expectation', days: 14, replaces: [first.id] });
    now.advance(1);
    await experienceOf(app, (await memoryWrite(app, 'the gate held')).operation, 'a landed write');

    const ledger = bytes(dataDir, 'predictions.jsonl');
    const { record, projection } = await app.predictions.recordEvaluation({ target: first.id, origin: 'user' });
    assert.equal(record, null, 'a replaced expectation is not scored');
    assert.equal(projection.evaluationDecision, 'superseded');
    assert.deepEqual(bytes(dataDir, 'predictions.jsonl'), ledger);
  });
});

describe('a retired expectation stays auditable', () => {
  test('a replacement retires the earlier expectation without removing it', async () => {
    const { dataDir, now, app } = appFor();
    const first = await recordExpectation(app, now, { subject: 'the first expectation' });
    const second = await app.predictions.recordPrediction({
      capability: 'memory.add', expectation: 'blocked', subject: 'the later expectation',
      expiresAt: horizon(now, 14), replaces: [first.id.slice(0, 8)], origin: 'user',
    });
    assert.deepEqual(second.record.replaces, [first.id], 'a typed reference is stored as the exact id');

    const all = await app.predictions.list({ limit: 10 });
    const retired = all.projections.find((p) => p.id === first.id);
    assert.equal(retired.status, 'superseded');
    assert.equal(retired.retired, true);
    assert.deepEqual(retired.supersededBy, [second.record.id]);
    assert.match(retired.statusReason, /stays in the log and stays auditable/);

    // Still readable by the same reference, with its own line still in the file.
    const detail = await app.predictions.detail(first.id.slice(0, 8));
    assert.equal(detail.subject, 'the first expectation');
    const history = await app.predictions.history(first.id.slice(0, 8));
    assert.equal(history.records.length, 2, 'the retired expectation and its replacement are both readable');
    assert.deepEqual([...new Set(history.records.map((r) => r.kind))], ['prediction']);
    assert.ok(lines(dataDir, 'predictions.jsonl').some((r) => r.id === first.id));

    // And it is counted as an exclusion from the rate rather than quietly dropped.
    const { calibration } = await app.predictions.calibration({});
    assert.equal(calibration.totals.stored, 2);
    assert.equal(calibration.totals.live, 1);
    assert.equal(calibration.totals.superseded, 1);
    assert.equal(calibration.rateExclusions.find((e) => e.key === 'superseded').count, 1);
  });

  test('a withdrawal keeps the expectation and its reason in the log', async () => {
    const { dataDir, now, app } = appFor();
    const expectation = await recordExpectation(app, now, { subject: 'an expectation to withdraw' });
    now.advance(1);
    await experienceOf(app, (await memoryWrite(app, 'the gate held')).operation, 'a landed write');
    const before = sizes(dataDir);

    const withdrawn = await app.predictions.invalidatePrediction({ target: expectation.id, reason: 'it was a guess, not a plan', origin: 'user' });
    assert.equal(withdrawn.record.kind, 'prediction_invalidation');

    const projection = await app.predictions.detail(expectation.id);
    assert.equal(projection.status, 'invalidated');
    assert.equal(projection.invalidation.reason, 'it was a guess, not a plan');
    assert.equal(projection.evaluationDecision, 'invalidated');
    assert.equal(projection.canRecordEvaluation, false);

    // Withdrawing an expectation that already has outcome evidence does not score it and removes
    // nothing: both lines stay in the file, and no other store was touched.
    assert.deepEqual(lines(dataDir, 'predictions.jsonl').map((r) => r.kind), ['prediction', 'prediction_invalidation']);
    assert.deepEqual(changed(before, sizes(dataDir)), ['predictions.jsonl'], 'a withdrawal writes one ledger line and nothing else');
    assert.equal(lines(dataDir, 'experiences.jsonl').length, 1, 'the experience the evidence came from is untouched');
  });
});

describe('adaptation approval stays explicitly user-controlled', () => {
  test('neither a matched nor a contradicted verdict moves a candidate', async () => {
    const { now, app } = appFor();
    const adaptation = await seedCandidate(app);

    const matched = await recordExpectation(app, now, { subject: 'the next write lands' });
    now.advance(1);
    await experienceOf(app, (await memoryWrite(app, 'the gate held')).operation, 'a landed write');
    assert.equal((await app.predictions.recordEvaluation({ target: matched.id, origin: 'user' })).record.verdict, 'matched');
    assert.equal((await app.experience.adaptations({ limit: 5 })).find((a) => a.id === adaptation.id).decisionState, 'candidate');

    const contradicted = await recordExpectation(app, now, { subject: 'the one after that is accepted', days: 4 });
    now.advance(1);
    const refusal = await refusedWrite(app, 'sk-synthetic-abcdef0123456789');
    await experienceOf(app, refusal.operation, 'a refused write');
    assert.equal((await app.predictions.recordEvaluation({ target: contradicted.id, origin: 'user' })).record.verdict, 'contradicted');

    const after = (await app.experience.adaptations({ limit: 5 })).find((a) => a.id === adaptation.id);
    assert.equal(after.decisionState, 'candidate');
    assert.equal(after.active, false, 'the rule was applied to no later turn');
    assert.equal(after.decision, null, 'no decision of any kind is recorded against it');
  });

  test('deriving again does not approve what it already derived', async () => {
    const { dataDir, app } = appFor();
    const adaptation = await seedCandidate(app);
    const ledger = bytes(dataDir, 'experiences.jsonl');

    const second = await app.experience.deriveAdaptations({ origin: 'user' });
    assert.deepEqual(second.created, [], 'the same evidence yields no new candidate');
    assert.ok(second.skipped.some((s) => /already recorded/i.test(s.reason)), 'and says why');
    assert.deepEqual(bytes(dataDir, 'experiences.jsonl'), ledger, 'a repeat derivation is a read');

    const list = await app.experience.adaptations({ limit: 10 });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, adaptation.id);
    assert.equal(list[0].decisionState, 'candidate');
  });

  test('an unapproved candidate is never retrieved as a rule in effect', async () => {
    const { app } = appFor();
    await seedCandidate(app);
    const view = await app.experience.activeAdaptations({ capability: 'memory.add', limit: 5 });
    assert.deepEqual(view.adaptations, [], 'an unapproved candidate is not retrieved as an active rule');
    assert.equal(view.total, 0);
  });

  test('only an explicit user decision makes a rule active', async () => {
    const { dataDir, app } = appFor();
    const adaptation = await seedCandidate(app);

    await assert.rejects(
      () => app.experience.decideAdaptation({ target: adaptation.id, decision: 'approved', origin: 'model' }),
      /requires an authorized user-origin operation|may not be supplied directly/,
    );
    assert.deepEqual(lines(dataDir, 'experiences.jsonl').filter((r) => r.kind === 'adaptation_decision'), [],
      'the refusal happened before any append');
    assert.equal((await app.experience.adaptationDetail(adaptation.id)).active, false);

    const approved = await app.controller.adaptationDecide({ target: adaptation.id, decision: 'approved' });
    assert.equal(approved.status, Outcome.SUCCESS_VERIFIED);
    const withDecision = await app.experience.adaptationDetail(adaptation.id);
    assert.equal(withDecision.decisionState, 'approved');
    assert.equal(withDecision.active, true, 'the user decision is what made it active');
    assert.deepEqual((await app.experience.activeAdaptations({ capability: 'memory.add', limit: 5 })).adaptations.map((a) => a.id),
      [withDecision.id], 'and only that decision put it in effect');

    const rejected = await app.controller.adaptationDecide({ target: adaptation.id, decision: 'rejected' });
    assert.equal(rejected.status, Outcome.SUCCESS_VERIFIED);
    const later = await app.experience.adaptationDetail(adaptation.id);
    assert.equal(later.active, false);
    assert.equal(later.decisions.length, 2, 'both decisions stay readable');
    assert.equal(lines(dataDir, 'experiences.jsonl').filter((r) => r.kind === 'adaptation_decision').length, 2);
  });
});
