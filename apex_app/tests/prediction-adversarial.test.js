// Batch AE-07 (adversarial half): everything a caller can do to a prediction ledger that the
// writer was never meant to allow.
//
// The other five prediction suites cover the honest path - a record the store wrote, a lifecycle
// derived from records, a verdict computed from outcomes, a command the user typed. This suite
// attacks that path from outside it:
//
//   forged records    bytes that were not written by PredictionStore: a stored confidence, a stored
//                     status, a second verdict, a withdrawal naming nothing, a replacement ring;
//   hostile input     citations that are not citations, credential-shaped text, an oversized
//                     citation list, a subject carrying newlines;
//   scope violations  an outcome for another capability, an event one millisecond outside a horizon;
//   authorization     a model plan, a planning prompt, and ordinary prose aimed at the ledger;
//   finalization      an audit append that fails after the ledger line was written, and a
//                     verification that cannot be completed.
//
// The invariant every group is written against is the mission's three separate questions: what
// happened, what was expected, what established the outcome. A forged record must not be able to
// merge them, and where the ledger cannot tell which is which it refuses instead of choosing.
//
// No test here contacts a model, starts an inference service, or downloads anything. The plan
// doubles are the shared test doubles in helpers.js and report only what the wiring did.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  makeTempDataDir, cleanup, cleanEnv, runCli, makePlanGateway, taskStep,
} from './helpers.js';
import { OperationLog } from '../src/operations/operation-log.js';
import { ExperienceStore } from '../src/experience/experience-store.js';
import { PredictionStore } from '../src/prediction/prediction-store.js';
import { Outcome, OPERATION_SCHEMA } from '../src/outcomes.js';
import { StoreError, ValidationError } from '../src/errors.js';
import { createApp } from '../src/app.js';
import { main } from '../src/cli.js';
import { checkSteps, planningPrompt } from '../src/tasks/planner.js';
import { route } from '../src/controller/router.js';
import { CAPTURE_VERIFIED_SUCCESS } from '../src/experience/capture.js';
import { shortId } from '../src/util.js';
import {
  EVALUATION_KIND,
  INVALIDATION_KIND,
  PREDICTION_KIND,
  PREDICTION_SCHEMA,
  MAX_EVIDENCE_IDS,
  MAX_PREDICTION_HORIZON_DAYS,
  MAX_SUBJECT_CHARS,
  deriveLimitations,
  deriveEvaluation,
  invalidRefMessage,
  validatePredictionRecord,
} from '../src/prediction/prediction-engine.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

// One fixed clock for the store-level fixtures: a horizon is compared against "now", so a read that
// advanced during a test would report a lifecycle change that is only time passing.
const NOW_MS = Date.parse('2026-11-05T09:00:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const NOW = () => new Date(NOW_MS);
const ahead = (days) => new Date(NOW_MS + days * 86_400_000).toISOString();

const LEDGER = (dir) => path.join(dir, 'predictions.jsonl');
const AUDIT = (dir) => path.join(dir, 'operations.jsonl');

function fixture() {
  const dir = tempDir();
  const operations = new OperationLog(path.join(dir, 'operations.jsonl'));
  const experience = new ExperienceStore(path.join(dir, 'experiences.jsonl'), { now: NOW, operations });
  const predictions = new PredictionStore(LEDGER(dir), { now: NOW, experiences: experience });
  return { dir, operations, experience, predictions };
}

let seq = 0;
// One audited operation plus the experience of it: the only thing a prediction may cite, and the
// only thing that can establish an outcome.
async function event(experience, operations, {
  capability = 'calc.evaluate',
  outcome = Outcome.SUCCESS_VERIFIED,
  at = new Date(NOW_MS + 86_400_000).toISOString(),
  subject = 'the release train arrived on time',
} = {}) {
  seq += 1;
  const operationId = `op-${String(seq).padStart(4, '0')}`;
  await operations.append({
    schema: OPERATION_SCHEMA, id: operationId, capability, origin: 'user', decision: 'answer',
    status: outcome, requestedAt: at, finishedAt: at, output: 'verified',
  });
  const { record } = await experience.recordExperience({ operationId, subject, origin: 'user' });
  return record;
}

const readBytes = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const readLines = (file) => readBytes(file).split('\n').filter((line) => line.trim() !== '');
const forge = (file, records) => fs.appendFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));

// A record that passes every field rule but was never written by the store. This is what a hand
// edit, a restored backup, or a foreign writer looks like from the ledger's side.
function forgedPrediction(id, overrides = {}) {
  const record = {
    schema: PREDICTION_SCHEMA,
    kind: PREDICTION_KIND,
    id,
    createdAt: NOW_ISO,
    capability: 'calc.evaluate',
    expectation: 'success',
    subject: 'a forged standing expectation',
    expiresAt: ahead(7),
    confidence: null,
    evidence: { supportingExperienceIds: [], contradictingExperienceIds: [], feedbackIds: [], patternKinds: [] },
    evidenceBasis: 'none_cited',
    limitations: [],
    provenance: { origin: 'user_recorded', updateMode: 'user_confirmed' },
    ...overrides,
  };
  if (overrides.limitations === undefined) record.limitations = deriveLimitations(record);
  return record;
}

function forgedInvalidation(id, predictionId, reason, overrides = {}) {
  return {
    schema: PREDICTION_SCHEMA,
    kind: INVALIDATION_KIND,
    id,
    predictionId,
    reason,
    createdAt: NOW_ISO,
    provenance: { origin: 'user_retirement', updateMode: 'user_confirmed' },
    ...overrides,
  };
}

function forgedEvaluation(id, predictionId, verdict, overrides = {}) {
  const deciding = randomUUID();
  return {
    schema: PREDICTION_SCHEMA,
    kind: EVALUATION_KIND,
    id,
    predictionId,
    verdict,
    createdAt: NOW_ISO,
    window: { since: NOW_ISO, until: ahead(7) },
    outcomeExperienceIds: [deciding],
    decidingExperienceId: deciding,
    decidingOccurredAt: NOW_ISO,
    provenance: { origin: 'user_authorized_derivation', updateMode: 'user_confirmed' },
    ...overrides,
  };
}

async function standingPrediction(predictions, overrides = {}) {
  const { record } = await predictions.recordPrediction({
    capability: 'calc.evaluate',
    expectation: 'success',
    subject: 'the next release train runs on time',
    expiresAt: ahead(7),
    origin: 'user',
    ...overrides,
  });
  return record;
}

// ---- AE-7a: a forged record is damage, and the damage is named ----------------

describe('AE-7a forged prediction records fail validation, by field and by rule', () => {
  test('every field a writer may not supply is refused with the rule that refuses it', async () => {
    const { predictions } = fixture();
    const real = await standingPrediction(predictions);
    const other = randomUUID();

    // [label, mutation, exact validator problem]
    const forgeries = [
      ['a newer schema', (r) => { r.schema = 2; }, 'unsupported schema'],
      ['a kind the ledger does not have', (r) => { r.kind = 'prediction_observation'; }, 'unknown record kind'],
      ['an id that is not an id', (r) => { r.id = 'not-a-uuid'; }, 'missing or invalid id'],
      ['an id spelled as a read prints it', (r) => { r.id = real.id.slice(0, 8); }, 'missing or invalid id'],
      ['no id at all', (r) => { delete r.id; }, 'missing or invalid id'],
      ['a capability that is not a string', (r) => { r.capability = 42; }, 'capability is not a capability name'],
      ['a blank capability', (r) => { r.capability = ''; }, 'capability is not a capability name'],
      ['a capability with a control character', (r) => { r.capability = 'calc\u0007evaluate'; }, 'capability is not a capability name'],
      ['a capability longer than the field', (r) => { r.capability = 'c'.repeat(65); }, 'capability is not a capability name'],
      ['an invented expectation', (r) => { r.expectation = 'maybe'; }, 'unknown expectation'],
      ['an empty subject', (r) => { r.subject = ''; }, 'missing subject'],
      ['a subject over the cap', (r) => { r.subject = 'x'.repeat(MAX_SUBJECT_CHARS + 1); }, 'subject is too long'],
      ['a credential-shaped subject', (r) => { r.subject = 'sk-abcdefghijklmnopqrstuvwxyz1234'; }, 'subject looks like a password, key, or token'],
      ['a control character in the subject', (r) => { r.subject = 'on time\u0007'; }, 'subject contains control characters'],
      ['a horizon that is the record itself', (r) => { r.expiresAt = r.createdAt; }, 'expiresAt is not after the prediction was recorded'],
      ['a horizon two years out', (r) => { r.expiresAt = new Date(Date.parse(r.createdAt) + (MAX_PREDICTION_HORIZON_DAYS + 40) * 86_400_000).toISOString(); }, 'expiresAt is more than 366 days ahead'],
      ['a supplied confidence', (r) => { r.confidence = 0.87; }, 'confidence must be present and null'],
      ['a missing confidence field', (r) => { delete r.confidence; }, 'confidence must be present and null'],
      ['a stored probability', (r) => { r.probability = 0.9; }, 'a prediction must not carry probability'],
      ['a stored status', (r) => { r.status = 'evaluated'; }, 'a prediction must not carry status'],
      ['a stored outcome', (r) => { r.outcome = 'success'; }, 'a prediction must not carry outcome'],
      ['no evidence block', (r) => { delete r.evidence; }, 'missing evidence'],
      ['a confidence hidden in evidence', (r) => { r.evidence.confidence = 0.5; }, 'evidence has an unknown field confidence'],
      ['an evidence list that is not a list', (r) => { r.evidence.supportingExperienceIds = real.id; }, 'evidence supportingExperienceIds must be a list'],
      ['a citation named twice', (r) => { r.evidence.supportingExperienceIds = [other, other]; }, 'evidence supportingExperienceIds names the same id twice'],
      ['a citation that is not a stored id', (r) => { r.evidence.supportingExperienceIds = [real.id.slice(0, 8)]; }, 'evidence supportingExperienceIds has an invalid id'],
      ['an evidence basis that disagrees', (r) => { r.evidenceBasis = 'cited'; }, 'evidenceBasis disagrees with the cited evidence'],
      ['a replacement named twice', (r) => { r.replaces = [other, other]; }, 'replaces names the same id twice'],
      ['a prediction replacing itself', (r) => { r.replaces = [real.id]; }, 'a prediction cannot replace itself'],
      ['weakened limitations', (r) => { r.limitations = []; }, 'limitations do not match the record'],
      ['a model-authored provenance origin', (r) => { r.provenance.origin = 'model_generated'; }, 'provenance origin must be user_recorded'],
      ['a supplied update mode', (r) => { r.provenance.updateMode = 'auto'; }, 'provenance updateMode must be user_confirmed'],
      ['an invented provenance field', (r) => { r.provenance.approved = true; }, 'provenance has an unknown field approved'],
      ['a provenance operation id with spaces', (r) => { r.provenance.operationId = 'op 1'; }, 'provenance operationId has an invalid format'],
      ['a withdrawal with no reason', (r) => { delete r.reason; }, 'an invalidation must retain a reason', 'invalidation'],
      ['a verdict that is not a verdict', (r) => { r.verdict = 'confirmed'; }, 'unknown evaluation verdict', 'evaluation'],
      ['an inverted evaluation window', (r) => { r.window = { since: ahead(7), until: NOW_ISO }; }, 'the evaluation window is inverted', 'evaluation'],
      ['a verdict with no outcome evidence', (r) => { r.outcomeExperienceIds = []; }, 'outcomeExperienceIds must be a non-empty list', 'evaluation'],
      ['a deciding record outside its own evidence', (r) => { r.decidingExperienceId = other; }, 'the deciding record is not among the outcome evidence', 'evaluation'],
      ['a verdict restating the capability', (r) => { r.capability = 'calc.evaluate'; }, 'an evaluation must not carry capability', 'evaluation'],
      ['a verdict carrying a probability', (r) => { r.probability = 0.9; }, 'an evaluation must not carry probability', 'evaluation'],
    ];

    for (const [label, mutate, expected, kind = 'prediction'] of forgeries) {
      // A companion record is forged from its own kind's shape, never from a prediction with a
      // field bolted on: the attack has to look like a hand-edited invalidation or evaluation.
      const source = kind === 'invalidation'
        ? forgedInvalidation(randomUUID(), real.id, 'the condition no longer holds')
        : kind === 'evaluation'
          ? forgedEvaluation(randomUUID(), real.id, 'matched')
          : structuredClone(real);
      assert.equal(validatePredictionRecord(structuredClone(source)), null, `${label}: the unforged ${kind} must be a valid baseline`);
      mutate(source);
      const problem = validatePredictionRecord(source);
      assert.equal(problem, expected, `${label} must be refused as ${expected}`);
    }

    // And the record the store really wrote still validates, so the table above is about the
    // forgeries and not about a fixture nobody could have produced.
    assert.equal(validatePredictionRecord(structuredClone(real)), null);
    assert.equal(validatePredictionRecord(forgedInvalidation(randomUUID(), real.id, 'a reason that stays')), null);
    assert.equal(validatePredictionRecord(forgedEvaluation(randomUUID(), real.id, 'contradicted')), null);

    // The record shape is one rule and the capability name is another: a hand-edited line may hold
    // "Calc.Evaluate" and still parse, but nothing may put that name into an expectation through
    // the write path, because an expectation is scoped by the capability it names.
    for (const capability of ['Calc.Evaluate', 'calc-evaluate', 'none', '   ', 'free text here', 'a'.repeat(65)]) {
      await assert.rejects(
        () => predictions.recordPrediction({
          capability, expectation: 'success', subject: 'an expectation with an unusable name', expiresAt: ahead(7), origin: 'user',
        }),
        (err) => err.name === 'ValidationError' && /a prediction must name a real capability to scope it/.test(err.message),
        `"${capability}" must not be usable as a capability`,
      );
    }
    assert.equal(readLines(predictions.filePath).length, 1, 'a refused capability writes nothing');
  });

  test('a ledger carrying five forged lines refuses every read and write, names each line, and keeps the bytes', async () => {
    const { predictions } = fixture();
    const real = await standingPrediction(predictions);
    const pristine = readBytes(predictions.filePath);

    const forged = [
      { ...structuredClone(real), id: randomUUID(), probability: 0.9 },
      { ...forgedPrediction(randomUUID()), confidence: 0.87 },
      { ...forgedPrediction(randomUUID()), kind: 'prediction_observation' },
      { ...forgedInvalidation(randomUUID(), real.id, 'a withdrawal'), reason: '' },
      forgedEvaluation(randomUUID(), real.id, 'confirmed'),
    ];
    forge(predictions.filePath, forged);

    const refused = /prediction store contains 5 corrupt line\(s\); refusing an incomplete prediction operation/;
    await assert.rejects(() => predictions.list(), (err) => err instanceof StoreError && refused.test(err.message));
    await assert.rejects(() => predictions.detail(real.id), (err) => refused.test(err.message));
    await assert.rejects(() => predictions.history(real.id), (err) => refused.test(err.message));
    await assert.rejects(() => predictions.promptView(), (err) => refused.test(err.message));
    await assert.rejects(() => predictions.calibration(), (err) => refused.test(err.message));
    await assert.rejects(() => predictions.auditProjection(real.id), (err) => refused.test(err.message));
    await assert.rejects(() => predictions.recordPrediction({
      capability: 'memory.add', expectation: 'success', subject: 'a later expectation', expiresAt: ahead(3), origin: 'user',
    }), (err) => refused.test(err.message));
    await assert.rejects(() => predictions.invalidatePrediction({ target: real.id, reason: 'a withdrawal attempted against a damaged ledger', origin: 'user' }), (err) => refused.test(err.message));
    await assert.rejects(() => predictions.recordEvaluation({ target: real.id, origin: 'user' }), (err) => refused.test(err.message));

    const health = await predictions.health();
    assert.equal(health.state, 'damaged');
    assert.equal(health.inspected, false, 'a ledger with unreadable lines was not fully inspected');
    assert.equal(health.complete, false);
    assert.equal(health.attention, true);
    assert.equal(health.corruptLines, 5);
    assert.deepEqual(
      health.corrupt.map((c) => c.reason).sort(),
      [
        'a prediction must not carry probability',
        'an invalidation must retain a reason',
        'confidence must be present and null',
        'unknown evaluation verdict',
        'unknown record kind',
      ].sort(),
    );
    // Damage is about the lines that do not belong, not about the ones that do: no standing
    // prediction is disputed here, so the anomaly list stays empty rather than guessing.
    assert.equal(health.anomalies.count, 0);
    assert.equal(health.predictions, 1, 'only the record that validates is counted');

    const status = await predictions.status();
    assert.equal(status.corrupt, 5);
    assert.equal(status.records, 1);

    // The bytes are preserved exactly, which is what makes the refusal recoverable.
    const after = readBytes(predictions.filePath);
    assert.ok(after.startsWith(pristine), 'the original line was not rewritten');
    for (const record of forged) assert.ok(after.includes(JSON.stringify(record)), 'a forged line was deleted instead of reported');

    // Removing the forged lines is the whole repair: nothing had to be re-recorded.
    fs.writeFileSync(predictions.filePath, pristine);
    const list = await predictions.list();
    assert.equal(list.total, 1);
    assert.equal(list.projections[0].id, real.id);
    assert.equal((await predictions.health()).state, 'ok');
  });
});

// ---- AE-7b: a ledger that parses and still disagrees with itself --------------

describe('AE-7b a ledger that disagrees with itself names the disagreement', () => {
  test('a withdrawal and a verdict that name nothing are reported, and stand no prediction down', async () => {
    const { predictions } = fixture();
    const real = await standingPrediction(predictions);
    const absentA = randomUUID();
    const absentB = randomUUID();
    forge(predictions.filePath, [
      forgedInvalidation(randomUUID(), absentA, 'a withdrawal of an expectation never recorded'),
      forgedEvaluation(randomUUID(), absentB, 'matched'),
    ]);

    const health = await predictions.health();
    assert.equal(health.state, 'ok', 'every line parsed; the ledger disagrees with itself instead');
    assert.equal(health.inspected, true);
    assert.equal(health.attention, true);
    assert.equal(health.anomalies.count, 2);
    assert.ok(health.anomalies.samples.some((m) => /^withdrawal [0-9a-f]{8} names prediction [0-9a-f]{8}, which is not in the log$/.test(m)));
    assert.ok(health.anomalies.samples.some((m) => /^evaluation [0-9a-f]{8} names prediction [0-9a-f]{8}, which is not in the log$/.test(m)));

    // An orphan companion record cannot retire or score the standing expectation, because it names
    // a different record - so the read keeps reporting what the log actually holds.
    const detail = await predictions.detail(real.id);
    assert.equal(detail.status, 'recorded');
    assert.equal(detail.invalidation, null);
    assert.equal(detail.evaluation, null);
    assert.equal((await predictions.list()).projections.length, 1);
  });

  test('two withdrawals of one expectation: the first stays reported, the third is refused', async () => {
    const { predictions } = fixture();
    const real = await standingPrediction(predictions);
    const first = forgedInvalidation(randomUUID(), real.id, 'the first withdrawal');
    const second = forgedInvalidation(randomUUID(), real.id, 'the second withdrawal');
    forge(predictions.filePath, [first, second]);

    const detail = await predictions.detail(real.id);
    assert.equal(detail.status, 'invalidated');
    assert.equal(detail.invalidation.id, first.id, 'a read never overrides the record that came first in the log');
    assert.equal(detail.invalidation.reason, 'the first withdrawal');
    assert.equal(detail.evaluationDecision, 'invalidated');

    const health = await predictions.health();
    assert.equal(health.attention, true);
    assert.ok(health.anomalies.samples.some((m) => m.includes('2 prediction_invalidation records name prediction')
      && m.endsWith('the ledger allows one of each')));

    // A third withdrawal is refused rather than adding to a disputed pair.
    await assert.rejects(
      () => predictions.invalidatePrediction({ target: real.id, reason: 'a third withdrawal', origin: 'user' }),
      (err) => err.code === 'INVALIDATION_EXISTS' && /has already been withdrawn/.test(err.message),
    );
    assert.equal(readLines(predictions.filePath).length, 3, 'nothing was appended to the dispute');
    assert.equal((await predictions.detail(real.id)).invalidation.id, first.id);
  });

  test('a second, contrary verdict cannot replace the first or move a count', async () => {
    const { experience, operations, predictions } = fixture();
    await event(experience, operations, { outcome: Outcome.SUCCESS_VERIFIED });
    const real = await standingPrediction(predictions);
    await predictions.recordEvaluation({ target: real.id, origin: 'user' });
    const recorded = (await predictions.detail(real.id)).evaluation;
    assert.equal(recorded.verdict, 'matched');

    forge(predictions.filePath, [forgedEvaluation(randomUUID(), real.id, 'contradicted')]);

    const detail = await predictions.detail(real.id);
    assert.equal(detail.evaluation.id, recorded.id, 'the verdict that was computed stands');
    assert.equal(detail.evaluation.verdict, 'matched');
    assert.equal(detail.status, 'evaluated');
    // The fresh read agrees with the stored verdict, so there is nothing to disclose as stale -
    // a hand-appended verdict changes no derived evidence.
    assert.equal(detail.evaluationStale, false);

    const { calibration } = await predictions.calibration();
    assert.equal(calibration.totals.evaluated, 1, 'a duplicate verdict cannot inflate the count of evaluations');
    assert.equal(calibration.totals.matched, 1);
    assert.equal(calibration.totals.contradicted, 0);
    assert.equal(calibration.matchRate.numerator, 1);
    assert.equal(calibration.matchRate.denominator, 1);
    assert.equal(calibration.matchRate.value, null);
    assert.match(calibration.matchRate.reason, /below 20/);

    await assert.rejects(
      () => predictions.recordEvaluation({ target: real.id, origin: 'user' }),
      (err) => err.code === 'EVALUATION_EXISTS' && /already has a recorded evaluation \(matched\)/.test(err.message),
    );
    const health = await predictions.health();
    assert.ok(health.anomalies.samples.some((m) => m.includes('2 prediction_evaluation records name prediction')));
  });

  test('a replacement ring retires every member and says so; a dangling replacement is named', async () => {
    const { predictions } = fixture();
    const real = await standingPrediction(predictions);
    const a = randomUUID();
    const b = randomUUID();
    const absent = randomUUID();
    const dangling = forgedPrediction(randomUUID(), { subject: 'an expectation correcting nothing', replaces: [absent] });
    forge(predictions.filePath, [
      forgedPrediction(a, { subject: 'the ring\'s first expectation', replaces: [b] }),
      forgedPrediction(b, { subject: 'the ring\'s second expectation', replaces: [a] }),
      dangling,
    ]);

    const health = await predictions.health();
    assert.equal(health.state, 'ok');
    assert.equal(health.attention, true);
    const ring = health.anomalies.samples.filter((m) => /is retired only inside a replacement circle/.test(m));
    assert.equal(ring.length, 2, 'both members are named, because choosing a winner would be an invention');
    for (const id of [a, b]) {
      assert.ok(ring.some((m) => m.startsWith(`prediction ${shortId(id)} `)), `the ring names ${shortId(id)}`);
    }
    assert.ok(health.anomalies.samples.some((m) => m.includes(`names prediction ${shortId(absent)}, which is not in the log`)
      && m.endsWith('what it claims to correct was never recorded')));
    assert.equal(health.superseded, 2, 'a ring retires its two members; a reference to a record that was never written retires nothing');
    assert.equal(health.live, 2, 'the store-written expectation stands, and so does the one whose claim to correct a record is dangling');

    const list = await predictions.list();
    const byId = new Map(list.projections.map((item) => [item.id, item]));
    for (const id of [a, b]) {
      assert.equal(byId.get(id).status, 'superseded');
      assert.equal(byId.get(id).retired, true);
      assert.match(byId.get(id).statusReason, /replacement loop/, 'a ring member is not shown as replaced by something that exists later');
    }
    assert.equal(byId.get(real.id).status, 'recorded');
    assert.equal(byId.get(real.id).retired, false);
    assert.equal(byId.get(dangling.id).status, 'recorded');
    assert.equal(byId.get(dangling.id).retired, false);

    // The write path cannot extend a ring: it refuses to replace a retired expectation, so a
    // successor to a member is refused instead of closing a second circle.
    await assert.rejects(
      () => predictions.recordPrediction({
        capability: 'calc.evaluate', expectation: 'success', subject: 'a third member of the ring',
        expiresAt: ahead(7), replaces: [a], origin: 'user',
      }),
      (err) => /is already replaced by/.test(err.message),
    );
    assert.equal((await predictions.list()).total, 4);
  });

  test('one record id written twice makes every read and write refuse, and the health read names it', async () => {
    const { predictions } = fixture();
    const real = await standingPrediction(predictions);
    forge(predictions.filePath, [structuredClone(real)]);

    const refused = /prediction store reuses 1 record id\(s\) \([0-9a-f]{8}\); refusing an operation on a ledger whose records are not individually identifiable/;
    await assert.rejects(() => predictions.list(), (err) => err instanceof StoreError && refused.test(err.message));
    await assert.rejects(() => predictions.detail(real.id), (err) => refused.test(err.message));
    await assert.rejects(() => predictions.recordPrediction({
      capability: 'memory.add', expectation: 'failure', subject: 'a later expectation', expiresAt: ahead(3), origin: 'user',
    }), (err) => refused.test(err.message));

    // Unlike corrupt bytes, every line here validates, so the ledger is inspected and the dispute
    // is reported as an anomaly rather than as damage.
    const health = await predictions.health();
    assert.equal(health.state, 'ok');
    assert.equal(health.inspected, true);
    assert.equal(health.corruptLines, 0);
    assert.equal(health.attention, true);
    assert.ok(health.anomalies.samples.some((m) => m.includes(`record ${shortId(real.id)} is written more than once in the log`)
      && m.endsWith('until the duplicate is resolved')));
    assert.equal((await predictions.status()).records, 2, 'the operational count reports the lines that exist');
  });
});

// ---- AE-7c: hostile input through the real command line ----------------------

describe('AE-7c hostile citation and subject input is refused before it reaches the ledger', () => {
  const envFor = (dir) => cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });

  const recordArgs = (extra) => [
    'prediction', 'record',
    '--capability', 'calc.evaluate', '--expect', 'success',
    '--subject', 'the next release train runs on time', '--in-days', '7', ...extra,
  ];

  test('a citation too short to name one record, and a path instead of an id, are refused without echoing them', async () => {
    const dir = tempDir();
    for (const typed of ['abcdef1', '../../../../etc/passwd']) {
      const res = await runCli(recordArgs(['--supports', typed]), envFor(dir));
      assert.equal(res.code, 1, `${typed} must be refused`);
      const out = `${res.stdout}${res.stderr}`;
      assert.ok(out.includes(invalidRefMessage('supportingExperienceIds')), `the refusal states the citation rule: ${out}`);
      assert.ok(!out.includes(typed), 'the typed value is never echoed back into the terminal or the audit record');
    }
    assert.equal(readLines(LEDGER(dir)).length, 0, 'nothing was written');
    // A path-shaped citation created no file anywhere under the data directory.
    assert.equal(fs.existsSync(path.join(dir, 'etc')), false);
  });

  test('a citation list longer than the ledger reads is refused by count, not by truncation', async () => {
    const dir = tempDir();
    const ids = Array.from({ length: MAX_EVIDENCE_IDS + 1 }, () => randomUUID().replace(/-/g, '').slice(0, 12));
    const res = await runCli(recordArgs(['--supports', ids.join(',')]), envFor(dir));
    assert.equal(res.code, 1);
    assert.match(`${res.stdout}${res.stderr}`, /supportingExperienceIds may name at most 20 records/);
    assert.equal(readLines(LEDGER(dir)).length, 0);
  });

  test('an invented pattern kind and a zero-day horizon are refused as input', async () => {
    const dir = tempDir();
    const kind = await runCli(recordArgs(['--pattern', 'guaranteed_success']), envFor(dir));
    assert.equal(kind.code, 1);
    assert.match(`${kind.stdout}${kind.stderr}`, /"guaranteed_success" is not a pattern kind the temporal engine can produce/);

    const days = await runCli(['prediction', 'record', '--capability', 'calc.evaluate', '--expect', 'success',
      '--subject', 'the next release train runs on time', '--in-days', '0'], envFor(dir));
    assert.equal(days.code, 1);
    assert.match(`${days.stdout}${days.stderr}`, /inDays must be an integer from 1 to 366/);

    const capability = await runCli(['prediction', 'record', '--capability', 'calc-evaluate', '--expect', 'success',
      '--subject', 'the next release train runs on time', '--in-days', '7'], envFor(dir));
    assert.equal(capability.code, 1);
    assert.match(`${capability.stdout}${capability.stderr}`, /capability must be a capability name/);
    assert.equal(readLines(LEDGER(dir)).length, 0);
  });

  test('a credential-shaped subject is refused, and never reaches the ledger or the audit log', async () => {
    const dir = tempDir();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz1234';
    const res = await runCli([
      'prediction', 'record',
      '--capability', 'calc.evaluate', '--expect', 'success',
      '--subject', secret, '--in-days', '7',
      '--supports', '12345678', '--replaces', '87654321',
    ], envFor(dir));
    assert.equal(res.code, 1);
    assert.match(`${res.stdout}${res.stderr}`, /subject looks like a password, key, or token; it was not stored/);

    assert.ok(!readBytes(LEDGER(dir)).includes(secret), 'the ledger holds no credential');
    const audit = readBytes(AUDIT(dir));
    assert.ok(audit.length > 0, 'the refusal itself is audited');
    assert.ok(!audit.includes(secret), 'a refused credential never reaches the audit log');
    assert.ok(!audit.includes('calc.evaluate'), 'every string in a credential-bearing input is replaced, not only the offending one');

    const op = JSON.parse(audit.trim().split('\n').at(-1));
    const input = op.steps[0].input;
    const omitted = '[omitted: contained a password, key, or token]';
    assert.equal(input.subject, omitted);
    assert.equal(input.capability, omitted);
    assert.equal(input.evidence.supportingExperienceIds[0], omitted, 'a credential nested in the evidence object is replaced too');
    assert.equal(input.replaces[0], omitted, 'a credential in a cited reference list is replaced too');
    // What is not text still says which command was attempted, so the audit record stays useful.
    assert.equal(op.capability, 'prediction.record');
    assert.equal(input.inDays, 7);
  });

  test('a subject carrying newlines is stored as one escaped line, and reads back as one expectation', async () => {
    const dir = tempDir();
    const clock = () => new Date(NOW_MS);
    const app = createApp({ dataDir: dir, now: clock });
    const res = await app.controller.predictionRecord({
      capability: 'calc.evaluate',
      expectation: 'success',
      subject: 'the train runs on time\nand the ledger holds one line',
      expiresAt: ahead(7),
    });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);

    const lines = readLines(LEDGER(dir));
    assert.equal(lines.length, 1, 'a multi-line subject cannot become a second record of its own');
    assert.ok(readBytes(LEDGER(dir)).endsWith('\n'), 'the ledger stays newline-terminated');
    assert.equal(JSON.parse(lines[0]).subject, 'the train runs on time\nand the ledger holds one line');
    assert.equal((await app.predictions.list()).total, 1);
  });

  test('prediction health reports a hand-forged replacement circle from a real child process and exits 1', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: () => new Date(NOW_MS) });
    await app.controller.predictionRecord({
      capability: 'calc.evaluate', expectation: 'success', subject: 'a standing expectation', expiresAt: ahead(7),
    });
    const clean = await runCli(['prediction', 'health'], envFor(dir));
    assert.equal(clean.code, 0, `a ledger the store wrote is healthy: ${clean.stdout}`);
    assert.match(clean.stdout, /Anomalies:      none detected among readable records/);

    const a = randomUUID();
    const b = randomUUID();
    forge(LEDGER(dir), [
      forgedPrediction(a, { subject: 'the ring\'s first expectation', replaces: [b] }),
      forgedPrediction(b, { subject: 'the ring\'s second expectation', replaces: [a] }),
    ]);
    const damaged = await runCli(['prediction', 'health'], envFor(dir));
    assert.equal(damaged.code, 1, 'a ledger that disagrees with itself is not reported as healthy');
    assert.match(damaged.stdout, /Anomalies:      2/);
    assert.match(damaged.stdout, /is retired only inside a replacement circle/);
    // The read is read-only: naming the circle changes nothing.
    assert.equal(readLines(LEDGER(dir)).length, 3);
  });
});

// ---- AE-7d: what may settle an expectation ---------------------------------

describe('AE-7d only a scoped, in-horizon outcome can establish an expectation', () => {
  test('an outcome for a different capability cannot settle this one', async () => {
    const { experience, operations, predictions } = fixture();
    const scoped = await standingPrediction(predictions, { capability: 'memory.add', subject: 'the next knowledge write is accepted' });
    // A verified success, recorded inside the horizon - of another capability.
    await event(experience, operations, { capability: 'calc.evaluate', subject: 'a calculation unrelated to it' });

    const before = readBytes(predictions.filePath);
    const unscoped = await predictions.recordEvaluation({ target: scoped.id, origin: 'user' });
    assert.equal(unscoped.record, null, 'only the capability the expectation names can establish it');
    assert.equal(unscoped.projection.evaluationDecision, 'outcome_unavailable');
    assert.match(unscoped.reason, /no live experience inside the horizon/);

    // The very same evidence settles the expectation that names this capability, so the refusal
    // above is about scoping and not about a horizon that is empty for every record.
    const matching = await predictions.recordPrediction({
      capability: 'calc.evaluate', expectation: 'success', subject: 'a calculation the ledger expects to verify', expiresAt: ahead(7), origin: 'user',
    });
    const settled = await predictions.recordEvaluation({ target: matching.record.id, origin: 'user' });
    assert.equal(settled.record.verdict, 'matched');
    assert.equal(settled.projection.evaluation.verdict, 'matched', 'the reopened projection reads the verdict back from the log');
    assert.ok(settled.record, 'the in-scope outcome establishes the outcome');

    // Only the scoped record's own line was appended by the refused attempt: a refusal writes
    // nothing, so the ledger grew by the expectation and its evaluation and by nothing else.
    const lines = readLines(predictions.filePath);
    assert.equal(lines.length, 3);
    assert.ok(readBytes(predictions.filePath).startsWith(before));
    assert.ok(lines.includes(JSON.stringify(matching.record)));
    assert.ok(lines.includes(JSON.stringify(settled.record)));
  });

  test('a horizon bound is inclusive at both ends and exclusive one millisecond outside', () => {
    const since = NOW_ISO;
    const until = ahead(7);
    const at = (ms) => new Date(ms).toISOString();
    const sinceMs = Date.parse(since);
    const untilMs = Date.parse(until);
    const prediction = {
      id: randomUUID(), createdAt: since, expiresAt: until, capability: 'calc.evaluate', expectation: 'success',
    };
    const mk = (ms, id = randomUUID()) => ({
      id, capability: 'calc.evaluate', outcome: Outcome.SUCCESS_VERIFIED, occurredAt: at(ms), active: true, logPosition: 1,
    });
    const events = [
      mk(sinceMs - 1),
      mk(sinceMs),
      mk(untilMs),
      mk(untilMs + 1),
    ];
    const derived = deriveEvaluation({
      prediction,
      evidence: { available: true, events, counts: { undated: 0, storedExperiences: events.length }, patternKinds: [] },
      invalidation: null,
      evaluation: null,
      supersededBy: [],
      nowMs: sinceMs,
    });
    assert.equal(derived.current.counts.read, 4, 'the judge sees everything the caller read for it');
    assert.equal(derived.current.counts.inHorizon, 2, 'the two events one millisecond outside never reach a verdict');
    assert.equal(derived.decision, 'matched');
    // The later of the two in-horizon outcomes decides, and both bounds counted.
    assert.equal(derived.deciding.occurredAt, until);
  });
});

// ---- AE-7e: no model-origin path into the ledger -----------------------------

describe('AE-7e a model cannot reach the ledger by planning, prompting, or prose', () => {
  test('a plan that names a prediction command is rejected, and nothing is stored', async () => {
    const dir = tempDir();
    const app = createApp({
      dataDir: dir,
      now: () => new Date(NOW_MS),
      gateway: makePlanGateway([taskStep('s1', 'prediction.record', [], {
        capability: 'calc.evaluate', expectation: 'success', subject: 'a prediction the model proposed', inDays: 7,
      })]),
    });
    const res = await app.controller.planTask('keep a standing expectation about the release train for later');
    assert.equal(res.status, Outcome.PLAN_REJECTED);
    assert.match(res.display, /cannot be part of a plan/);
    assert.match(res.display, /The model's proposed plan was rejected, so nothing was stored/);
    assert.equal(readLines(path.join(dir, 'tasks.jsonl')).length, 0, 'a rejected plan creates no task');
    assert.equal(readLines(LEDGER(dir)).length, 0, 'a rejected plan writes no expectation');
    assert.equal(readLines(path.join(dir, 'experiences.jsonl')).length, 0);

    // The same refusal at the step checker, for every one of the ledger's three write actions.
    for (const action of ['prediction.record', 'prediction.evaluate', 'prediction.invalidate']) {
      const checked = checkSteps([taskStep('s1', action, [], {})], app.registry, 'model');
      assert.ok(checked.problems.some((p) => p.includes(`action ${action} cannot be part of a plan`)), `${action} must be unplannable`);
    }
    // What the prompt offers must be what checkSteps() accepts, or the model is invited to write
    // a step that is always refused. The ledger's three write actions are absent for every origin;
    // its reads are present, and each of them really does check out as a plan step.
    for (const origin of ['model', 'user']) {
      const { system, prompt } = planningPrompt({ goal: 'anything', registry: app.registry, memoryLines: [], origin });
      const text = `${system}\n${prompt}`;
      for (const action of ['prediction.record', 'prediction.evaluate', 'prediction.invalidate']) {
        assert.ok(!text.includes(`- ${action} (`), `the ${origin} planning prompt must not offer the write action ${action}`);
      }
      const offered = text.split('\n')
        .filter((line) => line.startsWith('- prediction.'))
        .map((line) => line.slice(2).split(' ')[0]);
      assert.deepEqual(offered.sort(), ['prediction.history', 'prediction.list', 'prediction.show', 'prediction.summary']);
      for (const action of offered) {
        const checked = checkSteps([taskStep('s1', action, [], {})], app.registry, origin);
        assert.ok(!checked.problems.some((p) => p.includes('cannot be part of a plan')), `${action} is offered to a ${origin} plan but checkSteps refuses it`);
      }
    }
  });

  test('expectation-shaped prose never becomes a durable prediction', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: () => new Date(NOW_MS) });
    const phrasings = [
      'I expect the next calculation to succeed',
      'record a prediction that the release train is late',
      'predict that knowledge search will fail tomorrow',
    ];
    for (const text of phrasings) {
      for (const origin of ['model', 'user']) {
        const res = await app.controller.handle(text, { origin });
        assert.ok(res.operation, `${text} (${origin}) must still be audited`);
      }
      const routed = route(text);
      assert.ok(!String(routed?.action ?? '').startsWith('prediction.'), `${text} must not route to a prediction action`);
    }
    assert.equal(readLines(LEDGER(dir)).length, 0, 'no request phrased as an expectation wrote an expectation');
    const kinds = readLines(path.join(dir, 'experiences.jsonl')).map((line) => JSON.parse(line).kind);
    assert.ok(!kinds.some((kind) => String(kind).startsWith('prediction')), 'no prediction-shaped line in the experience log');
  });

  test('a model-origin prediction call is refused at the registry and again in the store', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: () => new Date(NOW_MS) });
    const step = await app.controller.runAction('prediction.record', {
      capability: 'calc.evaluate', expectation: 'success', subject: 'a model-authored expectation', inDays: 7,
    }, 'model', 'op-model-attempt');
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.equal(readLines(LEDGER(dir)).length, 0);

    await assert.rejects(
      () => app.predictions.recordPrediction({
        capability: 'calc.evaluate', expectation: 'success', subject: 'a model-authored expectation', expiresAt: ahead(7), origin: 'model',
      }),
      (err) => err.code === 'WRITE_REQUIRES_USER_ORIGIN' && /model output cannot record, withdraw, or evaluate a prediction/.test(err.message),
    );
    assert.equal(readLines(LEDGER(dir)).length, 0, 'the store refused before opening the ledger for writing');
  });
});

// ---- AE-7f: audit failure, capture, and unverifiable writes ------------------

describe('AE-7f the ledger is honest when the audit tail or the verifier fails', () => {
  function capture() {
    return { text: '', write(chunk) { this.text += chunk; return true; } };
  }

  async function cliInProcess(app, dir, argv) {
    const stdout = capture();
    const stderr = capture();
    const code = await main(argv, {
      env: cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir }),
      stdout, stderr, stdin: { isTTY: false }, appFactory: () => app,
    });
    return { code, out: `${stdout.text}${stderr.text}` };
  }

  test('an audit append that fails after the line was written is reported as unverified, and the retry cannot duplicate it', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: () => new Date(NOW_MS) });
    const real = await standingPrediction(app.predictions);
    app.operations.append = async () => { throw new StoreError('injected: audit write failed'); };

    const res = await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success', subject: 'an expectation whose audit record could not be written', expiresAt: ahead(7),
    });
    assert.equal(res.recorded, false);
    assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.match(res.output, /The expectation may have been recorded, but its audit record could not be written/);
    const lines = readLines(LEDGER(dir));
    assert.equal(lines.length, 2, 'the record that was written stays, and nothing is appended twice');
    assert.ok(lines.some((line) => JSON.parse(line).id === real.id));

    // Because the line may exist, a retry of the same expectation is refused instead of duplicating it.
    await assert.rejects(
      () => app.predictions.recordPrediction({
        capability: 'memory.add', expectation: 'success', subject: 'an expectation whose audit record could not be written', expiresAt: ahead(7), origin: 'user',
      }),
      (err) => err.code === 'PREDICTION_EXISTS',
    );
    assert.equal(readLines(LEDGER(dir)).length, 2, 'the refused retry appended nothing');

    // One write through the real CLI while the audit append is still failing: the ledger line is
    // written, the run cannot claim the record, so it exits as a partial outcome, not as success.
    const failing = await cliInProcess(app, dir, ['prediction', 'record',
      '--capability', 'knowledge.add', '--expect', 'blocked', '--subject', 'a second write whose audit fails', '--in-days', '3']);
    assert.equal(failing.code, 3, 'an operation whose audit record could not be written never exits as success');
    assert.match(failing.out, /Audit: NOT RECORDED/);
    assert.match(failing.out, /the audit trail will not contain it/, 'the CLI says the evidence trail is incomplete');
    assert.match(failing.out, /that action may already have happened/);
    assert.equal(readLines(LEDGER(dir)).length, 3);

    // Repairing the append is enough: every expectation the ledger holds stays readable and is
    // reported as standing, because nothing had to be rolled back or re-recorded.
    delete app.operations.append;
    const run = await cliInProcess(app, dir, ['prediction', 'list']);
    assert.equal(run.code, 0);
    assert.match(run.out, /of 3 recorded expectation\(s\)/);
  });

  test('a prediction operation never attempts automatic experience capture, even with capture on', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: () => new Date(NOW_MS), experienceCapture: CAPTURE_VERIFIED_SUCCESS });
    const attempted = [];
    app.experience.recordExperience = async (args) => {
      attempted.push(args.operationId);
      throw new ValidationError('injected: capture must not run for a prediction operation');
    };
    const res = await app.controller.predictionRecord({
      capability: 'calc.evaluate', expectation: 'success', subject: 'an expectation recorded while capture is on', expiresAt: ahead(7),
    });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.deepEqual(attempted, [], 'the ledger\'s own operations are outside the capture subset');
    assert.ok(!res.display.includes('not captured'), 'an operation that never asked for a capture is not reported as failing one');
    assert.equal(readLines(path.join(dir, 'experiences.jsonl')).length, 0);
    assert.equal(readLines(LEDGER(dir)).length, 1);
  });

  test('a write the verifier cannot re-read is reported as unconfirmed, and the record is not erased', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: () => new Date(NOW_MS) });
    await standingPrediction(app.predictions);
    const original = app.predictions.auditProjection.bind(app.predictions);
    app.predictions.auditProjection = async () => null;

    const res = await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success', subject: 'an expectation nothing could confirm', expiresAt: ahead(7),
    });
    assert.equal(res.status, Outcome.VERIFICATION_FAILED);
    assert.match(res.display, /result NOT confirmed/);
    assert.equal(readLines(LEDGER(dir)).length, 2, 'a verification the ledger could not answer does not roll the record back');

    const run = await cliInProcess(app, dir, ['prediction', 'record',
      '--capability', 'knowledge.add', '--expect', 'success', '--subject', 'a second unverifiable expectation', '--in-days', '4']);
    assert.equal(run.code, 1, 'an unconfirmed write is not reported as a success');

    app.predictions.auditProjection = original;
    const list = await app.predictions.list();
    assert.equal(list.total, 3);
    assert.ok(list.projections.some((item) => item.subject === 'an expectation nothing could confirm'));
  });
});
