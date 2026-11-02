// Batch AE: what a prediction has become between the moment it was recorded and the moment it is
// read - its lifecycle, its evidence lineage, its evaluation, and the counts an aggregate read is
// allowed to state.
//
// The four things these tests hold apart are the four questions the mission says APEX must never
// merge:
//
//   lifecycle   which state does the ledger support right now, and is that state derived rather
//               than stored? A stored status could disagree with the records it was read from.
//   lineage     what was cited when the expectation was made, what has been recorded since, and what
//               the outcome was judged against - three groups that never merge.
//   evaluation  a verdict only when a live recorded outcome inside the horizon establishes one. No
//               such record means no result: not a failed prediction, and an expired horizon is not
//               a wrong expectation.
//   calibration counts, each with its denominator named and every exclusion listed, with a rate
//               withheld until the sample can carry one.
//
// No test here contacts a model, starts a service, or downloads anything. The evidence each
// prediction cites is a real audited operation plus the experience the user recorded of it, written
// by the real stores into a temporary directory.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { OperationLog } from '../src/operations/operation-log.js';
import { ExperienceStore } from '../src/experience/experience-store.js';
import { PredictionStore } from '../src/prediction/prediction-store.js';
import { Outcome, OPERATION_SCHEMA } from '../src/outcomes.js';
import { ValidationError } from '../src/errors.js';
import {
  EVALUATION_KIND,
  EVALUATION_RULE,
  FORBIDDEN_PREDICTION_FIELDS,
  INVALIDATION_KIND,
  LIMITATION_CODES,
  MIN_CALIBRATION_EVALUATIONS,
  PREDICTION_KIND,
  PREDICTION_LIMITS,
  PREDICTION_STATUSES,
  PROVENANCE_BY_KIND,
  renderCalibration,
  renderPredictionDetail,
  renderPredictionHistory,
} from '../src/prediction/prediction-engine.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const DAY = 86_400_000;
const NOW_MS = Date.parse('2026-11-05T09:00:00.000Z');

// An instant relative to the fixture's zero: negative days are before the expectation was made and
// can only ever be prior evidence; positive days are inside a horizon and can establish an outcome.
const instant = (days, hours = 0) => new Date(NOW_MS + days * DAY + hours * 3_600_000).toISOString();

const LEDGER = (dir) => path.join(dir, 'predictions.jsonl');
const EXP = (dir) => path.join(dir, 'experiences.jsonl');

// A fixture whose clock the test moves. A lifecycle state is a comparison against "now", so the
// only way to show expiry, and the only way to show that evidence recorded later stays out of the
// original citation, is to advance a clock the stores read - never to edit a stored record.
function fixture({ withExperiences = true } = {}) {
  const dir = tempDir();
  const clock = { ms: NOW_MS };
  const now = () => new Date(clock.ms);
  const operations = new OperationLog(path.join(dir, 'operations.jsonl'));
  const experience = new ExperienceStore(EXP(dir), { now, operations });
  const predictions = new PredictionStore(LEDGER(dir), {
    now,
    experiences: withExperiences ? experience : null,
  });
  return {
    dir,
    operations,
    experience,
    predictions,
    advance(days, hours = 0) { clock.ms = NOW_MS + days * DAY + hours * 3_600_000; },
  };
}

// Fresh readers over the same directory, for the cases where a test has changed a file on disk: a
// new instance has no cached parse of what the old one read.
function reopen({ dir, withExperiences = true, atMs = NOW_MS }) {
  const now = () => new Date(atMs);
  const operations = new OperationLog(path.join(dir, 'operations.jsonl'));
  const experience = new ExperienceStore(EXP(dir), { now, operations });
  const predictions = new PredictionStore(LEDGER(dir), {
    now,
    experiences: withExperiences ? experience : null,
  });
  return { dir, operations, experience, predictions };
}

let seq = 0;
async function event(experience, operations, {
  capability = 'calc.evaluate',
  outcome = Outcome.SUCCESS_VERIFIED,
  at,
  subject = 'the release train ran as scheduled',
  replaces = [],
} = {}) {
  seq += 1;
  const operationId = `op-${String(seq).padStart(4, '0')}`;
  await operations.append({
    schema: OPERATION_SCHEMA, id: operationId, capability, origin: 'user', decision: 'answer',
    status: outcome, requestedAt: at, finishedAt: at, output: 'verified',
  });
  const { record } = await experience.recordExperience({
    operationId, subject, origin: 'user', ...(replaces.length > 0 ? { replaces } : {}),
  });
  return record;
}

function ask(overrides = {}) {
  return {
    capability: 'calc.evaluate',
    expectation: 'success',
    subject: 'the next release train runs on time',
    expiresAt: instant(7),
    origin: 'user',
    ...overrides,
  };
}

const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map(JSON.parse);
const bytes = (file) => fs.readFileSync(file, 'utf8');
const byId = (items, id) => items.find((item) => item.id === id);
const byCapability = (items, name) => items.filter((item) => item.capability === name);
// One prediction per capability, so a horizon read never mixes two cases' evidence.
const scoped = (capability, overrides = {}) => ask({ capability, ...overrides });

describe('AE-6: every lifecycle state is derived from the records that exist, never stored', () => {
  test('each state appears when its records appear, and no record carries a state field', async () => {
    const f = fixture();
    // One capability per case: a horizon read is scoped to the expectation it bounds, so two cases
    // in one file never share evidence.
    const judged = (await f.predictions.recordPrediction(scoped('life.evaluated'))).record;
    await event(f.experience, f.operations, { capability: 'life.evaluated', at: instant(1) });
    await f.predictions.recordEvaluation({ target: judged.id, origin: 'user' });

    const pending = (await f.predictions.recordPrediction(scoped('life.awaiting'))).record;
    await event(f.experience, f.operations, { capability: 'life.awaiting', at: instant(1) });

    const waiting = (await f.predictions.recordPrediction(scoped('life.recorded', { expiresAt: instant(20) }))).record;
    const expiring = (await f.predictions.recordPrediction(scoped('life.expired', { expiresAt: instant(2) }))).record;

    const superseded = (await f.predictions.recordPrediction(scoped('life.superseded'))).record;
    await f.predictions.recordPrediction(scoped('life.superseded', {
      subject: 'a corrected expectation about the same capability',
      expiresAt: instant(20),
      replaces: [superseded.id],
    }));
    const withdrawn = (await f.predictions.recordPrediction(scoped('life.invalidated'))).record;
    await f.predictions.invalidatePrediction({
      target: withdrawn.id, reason: 'the release was moved, so this expectation no longer applies', origin: 'user',
    });

    const ledger = bytes(LEDGER(f.dir));
    f.advance(9);
    const listed = await f.predictions.list({ limit: 50 });
    const projectionOf = (id) => byId(listed.projections, id);
    assert.equal(projectionOf(expiring.id).status, 'expired');
    assert.equal(projectionOf(expiring.id).evaluationDecision, 'expired');
    assert.equal(projectionOf(expiring.id).evaluation, null, 'expiry records no verdict');
    assert.equal(projectionOf(expiring.id).canRecordEvaluation, false);
    assert.equal(projectionOf(judged.id).status, 'evaluated');
    assert.equal(projectionOf(pending.id).status, 'awaiting_evaluation');
    assert.equal(projectionOf(pending.id).evaluationDecision, 'matched');
    assert.equal(projectionOf(pending.id).canRecordEvaluation, true);
    assert.equal(projectionOf(waiting.id).status, 'recorded');
    assert.equal(projectionOf(waiting.id).evaluationDecision, 'outcome_unavailable');
    assert.equal(projectionOf(withdrawn.id).status, 'invalidated');
    assert.equal(projectionOf(superseded.id).status, 'superseded');
    assert.equal(projectionOf(superseded.id).retired, true);
    // The standing replacement of a withdrawn or expired expectation is itself only `recorded`: a
    // new expectation inherits no state from the one it corrects.
    assert.equal(byId(listed.projections, projectionOf(superseded.id).supersededBy[0]).status, 'recorded');
    for (const item of listed.projections) assert.ok(PREDICTION_STATUSES.includes(item.status));

    // The states above came from reads. The ledger itself is untouched, and holds no state field:
    // nothing in it could have disagreed with the records it was read from.
    assert.equal(bytes(LEDGER(f.dir)), ledger, 'a read appends nothing');
    for (const record of lines(LEDGER(f.dir))) {
      for (const field of ['status', 'evaluation', ...FORBIDDEN_PREDICTION_FIELDS]) {
        assert.equal(record[field], undefined, `${record.kind} must not store ${field}`);
      }
    }
    assert.deepEqual([...new Set(lines(LEDGER(f.dir)).map((r) => r.kind))].sort(),
      [EVALUATION_KIND, INVALIDATION_KIND, PREDICTION_KIND].sort());
  });

  test('a superseded expectation stays in the log and stays auditable', async () => {
    const f = fixture();
    const first = (await f.predictions.recordPrediction(scoped('train.deploys', { subject: 'the 09:00 deploy finishes by 09:20' }))).record;
    await event(f.experience, f.operations, { capability: 'train.deploys', at: instant(1) });
    await f.predictions.recordEvaluation({ target: first.id, origin: 'user' });
    const second = (await f.predictions.recordPrediction(scoped('train.deploys', {
      subject: 'the corrected expectation: the 09:00 deploy finishes by 09:40',
      expiresAt: instant(9),
      replaces: [first.id],
    }))).record;

    const detail = await f.predictions.detail(first.id);
    assert.equal(detail.status, 'superseded');
    assert.equal(detail.retired, true);
    assert.deepEqual(detail.supersededBy, [second.id]);
    assert.equal(detail.subject, 'the 09:00 deploy finishes by 09:20', 'a replacement edits nothing');
    assert.equal(detail.createdAt, first.createdAt);
    assert.equal(detail.evaluation.verdict, 'matched', 'the verdict that was recorded stays readable');
    assert.equal(detail.evaluationDecision, 'superseded', 'and a fresh read says it would not score this one now');

    const history = await f.predictions.history(first.id);
    assert.deepEqual([...history.records.map((r) => r.kind)].sort(), [EVALUATION_KIND, PREDICTION_KIND, PREDICTION_KIND].sort());
    assert.ok(history.records.some((r) => r.id === second.id), 'the replacing record is part of its history');
    assert.match(renderPredictionHistory(detail, history.records), /each line above is an appended record/);

    const listed = await f.predictions.list({ limit: 50 });
    assert.equal(listed.total, 2);
    assert.equal(listed.ledger.retiredByReplacement.has(first.id), true);
    const health = await f.predictions.health();
    assert.deepEqual({ live: health.live, superseded: health.superseded }, { live: 1, superseded: 1 });
  });

  test('a withdrawn expectation keeps its reason and its provenance, and cannot be withdrawn twice', async () => {
    const f = fixture();
    const p = (await f.predictions.recordPrediction(scoped('sync.push'))).record;
    const { record: withdrawal } = await f.predictions.invalidatePrediction({
      target: p.id,
      reason: 'the vendor moved the maintenance window, so nothing will test this now',
      provenance: { operationId: 'op-77', context: 'asked at the standup' },
      origin: 'user',
    });
    assert.equal(withdrawal.provenance.origin, PROVENANCE_BY_KIND[INVALIDATION_KIND].origin);
    assert.equal(withdrawal.provenance.updateMode, PROVENANCE_BY_KIND[INVALIDATION_KIND].updateMode);

    const detail = await f.predictions.detail(p.id);
    assert.equal(detail.status, 'invalidated');
    assert.equal(detail.invalidation.reason, 'the vendor moved the maintenance window, so nothing will test this now');
    assert.equal(detail.invalidation.provenance.operationId, 'op-77');
    assert.equal(detail.invalidation.provenance.context, 'asked at the standup');
    assert.equal(detail.evaluationDecision, 'invalidated');
    assert.equal(detail.canRecordEvaluation, false);
    assert.match(renderPredictionDetail(detail), /Invalidated:/);

    await assert.rejects(
      () => f.predictions.invalidatePrediction({ target: p.id, reason: 'withdrawn again', origin: 'user' }),
      (err) => err instanceof ValidationError && err.code === 'INVALIDATION_EXISTS',
    );
    const ledger = bytes(LEDGER(f.dir));
    const attempt = await f.predictions.recordEvaluation({ target: p.id, origin: 'user' });
    assert.equal(attempt.record, null, 'a withdrawn expectation is not scored');
    assert.match(attempt.reason, /withdrew this expectation/);
    assert.equal(bytes(LEDGER(f.dir)), ledger, 'refusing an evaluation appended nothing');
  });

  test('a withdrawn expectation keeps a verdict it already had, and withdrawal takes precedence in the state', async () => {
    const f = fixture();
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate'))).record;
    await event(f.experience, f.operations, { at: instant(1) });
    await f.predictions.recordEvaluation({ target: p.id, origin: 'user' });
    await f.predictions.invalidatePrediction({ target: p.id, reason: 'the expectation was mine to keep, and I no longer hold it', origin: 'user' });

    const detail = await f.predictions.detail(p.id);
    assert.equal(detail.status, 'invalidated', 'the withdrawal is the later statement, so it is the state');
    assert.equal(detail.evaluation.verdict, 'matched', 'the recorded evaluation is not deleted by a withdrawal');
    assert.equal(detail.evaluationDecision, 'invalidated');
    const kinds = (await f.predictions.history(p.id)).records.map((r) => r.kind);
    assert.deepEqual([...kinds].sort(), [EVALUATION_KIND, INVALIDATION_KIND, PREDICTION_KIND].sort());
  });

  test('an unreadable experience log leaves the state at recorded and establishes no outcome', async () => {
    const withoutLog = fixture({ withExperiences: false });
    const orphan = (await withoutLog.predictions.recordPrediction(scoped('calc.evaluate'))).record;
    const first = await withoutLog.predictions.detail(orphan.id);
    assert.equal(first.evaluationDecision, 'evidence_unavailable');
    assert.equal(first.status, 'recorded');
    assert.match(first.statusReason, /could not be read/);
    assert.equal(first.canRecordEvaluation, false);
    assert.equal(first.lineage.available, false);
    assert.match(first.lineage.reason, /no experience log is configured/);
    assert.equal((await withoutLog.predictions.recordEvaluation({ target: orphan.id, origin: 'user' })).record, null);

    // The same statement against a log that exists but cannot be parsed: an unreadable record is
    // never reported as an empty horizon, because "nothing establishes this" and "nothing could be
    // read" are about different things.
    const f = fixture();
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate', { subject: 'a release that has not happened yet' }))).record;
    fs.appendFileSync(EXP(f.dir), 'this line is not json\n');
    const reread = reopen({ dir: f.dir });
    const damaged = await reread.predictions.detail(p.id);
    assert.equal(damaged.evaluationDecision, 'evidence_unavailable');
    assert.equal(damaged.status, 'recorded');
    assert.match(damaged.evaluationReason, /could not be read/);
    assert.equal(damaged.evidenceBasis, 'none_cited');
    assert.equal(damaged.lineage.available, false);
  });
});

describe('AE-7: a verdict exists only when a recorded outcome inside the horizon establishes one', () => {
  test('a matching outcome verdicts matched, and a contrary one verdicts contradicted', async () => {
    const matched = fixture();
    const expectation = (await matched.predictions.recordPrediction(scoped('calc.evaluate'))).record;
    const evidence = await event(matched.experience, matched.operations, { at: instant(1) });
    const result = await matched.predictions.recordEvaluation({ target: expectation.id, origin: 'user' });
    assert.equal(result.record.verdict, 'matched');
    assert.equal(result.record.decidingExperienceId, evidence.id);
    assert.deepEqual(result.record.outcomeExperienceIds, [evidence.id]);
    assert.deepEqual({ since: result.record.window.since, until: result.record.window.until },
      { since: expectation.createdAt, until: expectation.expiresAt });
    assert.equal(result.projection.status, 'evaluated');
    assert.equal(result.projection.evaluation.verdict, 'matched');

    const contradicted = fixture();
    const hoped = (await contradicted.predictions.recordPrediction(scoped('sync.push'))).record;
    const broke = await event(contradicted.experience, contradicted.operations, {
      capability: 'sync.push', outcome: Outcome.EXECUTION_FAILED, at: instant(1), subject: 'the sync gave up',
    });
    const second = await contradicted.predictions.recordEvaluation({ target: hoped.id, origin: 'user' });
    assert.equal(second.record.verdict, 'contradicted');
    // Once a verdict is recorded, the read reports the recorded decider rather than a recomputed
    // one: the second statement about the same record cannot disagree with the first.
    assert.equal(second.projection.deciding, null);
    assert.equal(second.projection.evaluation.decidingExperienceId, broke.id);
    assert.equal(second.projection.evaluationDecision, 'already_evaluated');
    assert.match(second.projection.evaluationReason, /already has a recorded evaluation/);
    assert.equal(byId((await contradicted.predictions.list({ limit: 50 })).projections, hoped.id).contradictingEstablishing.ids.includes(broke.id), true);

    // The expectation is not fixed to "success": a blocked outcome establishes a blocked expectation.
    const blocked = fixture();
    const refusal = (await blocked.predictions.recordPrediction(scoped('fs.delete', { expectation: 'blocked' }))).record;
    await event(blocked.experience, blocked.operations, {
      capability: 'fs.delete', outcome: Outcome.ACTION_DENIED, at: instant(2), subject: 'the delete was refused',
    });
    const judged = await blocked.predictions.recordEvaluation({ target: refusal.id, origin: 'user' });
    assert.equal(judged.record.verdict, 'matched', 'a refused deletion is what was expected, so it matches');
  });

  test('the latest establishing record inside the horizon decides, not the first', async () => {
    const f = fixture();
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate'))).record;
    const failed = await event(f.experience, f.operations, { outcome: Outcome.EXECUTION_FAILED, at: instant(1), subject: 'the run failed' });
    const recovered = await event(f.experience, f.operations, { at: instant(3), subject: 'the retry succeeded' });
    const detail = await f.predictions.detail(p.id);
    assert.equal(detail.evaluationDecision, 'matched');
    assert.equal(detail.deciding.id, recovered.id);
    assert.equal(detail.supportingEstablishing.ids.includes(recovered.id), true);
    assert.equal(detail.contradictingEstablishing.ids.includes(failed.id), true, 'the earlier failure is still counted as contrary evidence');
    assert.equal(detail.counts.establishing, 2);

    const later = fixture();
    const q = (await later.predictions.recordPrediction(scoped('calc.evaluate'))).record;
    await event(later.experience, later.operations, { at: instant(1) });
    await event(later.experience, later.operations, { outcome: Outcome.EXECUTION_FAILED, at: instant(4), subject: 'the run failed later' });
    assert.equal((await later.predictions.detail(q.id)).evaluationDecision, 'contradicted');
  });

  test('an outcome that establishes nothing gives insufficient evidence, not a verdict', async () => {
    const f = fixture();
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate'))).record;
    await event(f.experience, f.operations, { outcome: Outcome.PLAN_CREATED, at: instant(1), subject: 'a plan was stored' });
    const ledger = bytes(LEDGER(f.dir));
    const attempt = await f.predictions.recordEvaluation({ target: p.id, origin: 'user' });
    assert.equal(attempt.record, null);
    assert.equal(attempt.projection.evaluationDecision, 'insufficient_evidence');
    assert.equal(attempt.projection.counts.live, 1);
    assert.equal(attempt.projection.counts.establishing, 0);
    assert.equal(attempt.projection.counts.unclassified, 1);
    assert.match(attempt.reason, /establishes anything/);
    assert.equal(bytes(LEDGER(f.dir)), ledger);
    assert.equal((await f.predictions.detail(p.id)).status, 'recorded', 'an unclassified outcome is not expiry either');
  });

  test('a horizon that passes with no outcome evidence is expiry, and a later record cannot change it', async () => {
    const f = fixture();
    const p = (await f.predictions.recordPrediction(scoped('train.deploys', { expiresAt: instant(2) }))).record;
    assert.equal((await f.predictions.detail(p.id)).status, 'recorded');
    f.advance(3);
    const expired = await f.predictions.detail(p.id);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.evaluationDecision, 'expired');
    assert.match(expired.evaluationReason, /this is expiry, not a wrong prediction/);
    assert.ok(!/contradicted|matched/.test(expired.evaluationReason));
    assert.equal(expired.evaluation, null);
    assert.equal(expired.canRecordEvaluation, false);
    assert.ok(expired.limitations.includes('expiry_not_failure'));
    const ledger = bytes(LEDGER(f.dir));
    assert.equal((await f.predictions.recordEvaluation({ target: p.id, origin: 'user' })).record, null);
    assert.equal(bytes(LEDGER(f.dir)), ledger);

    // An outcome recorded after the horizon closed is outside the question that was asked. It is
    // real evidence about the world and no evidence about this expectation.
    await event(f.experience, f.operations, { capability: 'train.deploys', at: instant(10) });
    f.advance(11);
    const still = await f.predictions.detail(p.id);
    assert.equal(still.evaluationDecision, 'expired');
    assert.equal(still.counts.inHorizon, 0);
    assert.equal(still.evidenceTruncated, false);
  });

  test('a record made before the expectation can be prior evidence but can never decide', async () => {
    const f = fixture();
    const prior = await event(f.experience, f.operations, { at: instant(-3) });
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate', {
      evidence: { supportingExperienceIds: [prior.id] },
    }))).record;
    const detail = await f.predictions.detail(p.id);
    assert.equal(detail.evaluationDecision, 'outcome_unavailable');
    assert.equal(detail.counts.inHorizon, 0);
    assert.equal(detail.evaluationRule, EVALUATION_RULE);
    assert.match(detail.evaluationReason, /no live experience inside the horizon/);
    // The citation stands: it is prior evidence, and it is not outcome evidence.
    assert.deepEqual(detail.lineage.atCreation.supporting.shown.map((c) => c.id), [prior.id]);
    assert.equal(detail.lineage.outcomeEvidence.ids.count, 0);
    assert.deepEqual(detail.lineage.outcomeEvidence.ids.ids, []);
    assert.ok(detail.limitations.includes('expectation_not_observation'));
  });

  test('a recorded verdict is never rewritten: a changed read is disclosed, and a second attempt is refused', async () => {
    const f = fixture();
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate'))).record;
    await event(f.experience, f.operations, { at: instant(1) });
    const written = await f.predictions.recordEvaluation({ target: p.id, origin: 'user' });
    assert.equal(written.projection.evaluationStale, false);
    assert.equal(written.projection.staleReason, null);

    await event(f.experience, f.operations, { outcome: Outcome.EXECUTION_FAILED, at: instant(3), subject: 'and then it broke' });
    const detail = await f.predictions.detail(p.id);
    assert.equal(detail.status, 'evaluated');
    assert.equal(detail.evaluationDecision, 'already_evaluated');
    assert.equal(detail.evaluation.verdict, 'matched');
    assert.equal(detail.evaluationStale, true);
    assert.match(detail.staleReason, /recorded evaluation stands and the difference is disclosed, never rewritten/);
    assert.match(renderPredictionDetail(detail), /Stale:/);
    assert.equal(lines(LEDGER(f.dir)).find((r) => r.kind === EVALUATION_KIND).verdict, 'matched', 'the stored verdict is untouched');
    await assert.rejects(
      () => f.predictions.recordEvaluation({ target: p.id, origin: 'user' }),
      (err) => err instanceof ValidationError && err.code === 'EVALUATION_EXISTS',
    );

    // An unreadable log cannot make a verdict look stale: it says nothing about the world.
    fs.appendFileSync(EXP(f.dir), 'not json at all\n');
    const reread = reopen({ dir: f.dir });
    const blind = await reread.predictions.detail(p.id);
    assert.equal(blind.evaluationDecision, 'already_evaluated');
    assert.equal(blind.evaluationStale, false, 'an unreadable log is not evidence that the verdict changed');
    assert.match(blind.lineage.reason, /could not be read/);
  });

  test('an expectation a later record replaced is not current evidence, but is counted as left out', async () => {
    const f = fixture();
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate'))).record;
    const first = await event(f.experience, f.operations, { outcome: Outcome.EXECUTION_FAILED, at: instant(1), subject: 'the run failed' });
    const corrected = await event(f.experience, f.operations, {
      at: instant(2), subject: 'the audit was wrong: the run succeeded', replaces: [first.id],
    });
    const detail = await f.predictions.detail(p.id);
    assert.equal(detail.evaluationDecision, 'matched');
    assert.equal(detail.deciding.id, corrected.id);
    assert.equal(detail.counts.superseded, 1);
    assert.equal(detail.counts.inHorizon, 2);
    assert.equal(detail.counts.live, 1);
    const exclusion = detail.exclusions.find((item) => item.key === 'superseded');
    assert.equal(exclusion.count, 1);
    assert.match(exclusion.reason, /replaced it/);
    const written = await f.predictions.recordEvaluation({ target: p.id, origin: 'user' });
    assert.deepEqual(written.record.outcomeExperienceIds, [corrected.id], 'a replaced record is not outcome evidence');
    assert.deepEqual(detail.exclusions.map((item) => item.key).sort(), ['superseded', 'unclassified_outcome', 'undated'],
      'every exclusion is named even when its count is zero');
  });

  test('an evaluation writes one prediction record and touches no other log', async () => {
    const f = fixture();
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate'))).record;
    await event(f.experience, f.operations, { at: instant(1) });
    const experiences = bytes(EXP(f.dir));
    const before = await f.experience.list({ limit: 50 });
    const summary = await f.experience.temporalSummary({ since: instant(-30), until: instant(30), capability: 'calc.evaluate' });

    const { record } = await f.predictions.recordEvaluation({ target: p.id, origin: 'user' });
    assert.equal(record.kind, EVALUATION_KIND);
    assert.equal(record.provenance.origin, PROVENANCE_BY_KIND[EVALUATION_KIND].origin);
    assert.equal(bytes(EXP(f.dir)), experiences, 'the experience log is byte-identical');
    assert.deepEqual((await f.experience.list({ limit: 50 })).map((r) => r.id), before.map((r) => r.id));
    assert.equal((await f.experience.temporalSummary({ since: instant(-30), until: instant(30), capability: 'calc.evaluate' })).counts.stored,
      summary.counts.stored);
    assert.equal(lines(LEDGER(f.dir)).filter((r) => r.kind === EVALUATION_KIND).length, 1);
    // The verdict is not free text about the world: the record holds ids, enums, counts and times.
    assert.deepEqual(Object.keys(record).sort(), [
      'createdAt', 'decidingExperienceId', 'decidingOccurredAt', 'id', 'kind', 'outcomeExperienceIds',
      'predictionId', 'provenance', 'schema', 'verdict', 'window',
    ].sort());
  });
});

describe('AE-8: evidence lineage keeps three groups apart', () => {
  test('a citation keeps the role it was cited in, and evidence recorded later never joins it', async () => {
    const f = fixture();
    const support = await event(f.experience, f.operations, { at: instant(-4), subject: 'the last four runs were on time' });
    const contrary = await event(f.experience, f.operations, {
      outcome: Outcome.EXECUTION_FAILED, at: instant(-2), subject: 'one run was late',
    });
    const assessment = await f.experience.recordFeedback({ target: contrary.id, assessment: 'outcome_failed', origin: 'user' });
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate', {
      evidence: { supportingExperienceIds: [support.id], contradictingExperienceIds: [contrary.id], feedbackIds: [assessment.record.id] },
    }))).record;

    const created = await f.predictions.detail(p.id);
    assert.equal(created.lineage.basis, 'cited');
    assert.deepEqual(created.lineage.atCreation.supporting.shown.map((c) => c.id), [support.id]);
    assert.deepEqual(created.lineage.atCreation.contradicting.shown.map((c) => c.id), [contrary.id]);
    assert.equal(created.lineage.atCreation.supporting.shown[0].outcomeClass, 'success');
    assert.equal(created.lineage.atCreation.supporting.shown[0].available, true);
    assert.equal(created.lineage.atCreation.feedback.shown[0].assessment, 'outcome_failed');
    assert.deepEqual(created.lineage.atCreation.unresolvedExperienceIds, []);
    assert.equal(created.lineage.atCreation.unavailableDeclared, false);

    // Two days later, more evidence is recorded. It is derived as added-after, and it does not
    // appear among the records the expectation was built on.
    f.advance(2);
    const after = await event(f.experience, f.operations, { at: instant(2), subject: 'a run finished early' });
    const added = await f.predictions.detail(p.id);
    assert.deepEqual(added.lineage.atCreation.supporting.shown.map((c) => c.id), [support.id]);
    assert.equal(added.lineage.atCreation.supporting.count, 1);
    assert.ok(!added.lineage.atCreation.supporting.shown.some((c) => c.id === after.id));
    assert.equal(added.lineage.addedAfter.supporting.ids.includes(after.id), true);
    assert.match(added.lineage.addedAfter.note, /never stored as original support/);
    assert.deepEqual(added.lineage.addedAfter.window, { since: p.createdAt, until: p.expiresAt });
    assert.match(renderPredictionDetail(added), /Added after:/);
  });

  test('an outcome that establishes nothing, and a record outside the horizon, are counted as excluded', async () => {
    const f = fixture();
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate', { expiresAt: instant(6) }))).record;
    await event(f.experience, f.operations, { at: instant(1) });
    await event(f.experience, f.operations, { outcome: Outcome.PLAN_CREATED, at: instant(2), subject: 'a plan was stored' });
    await event(f.experience, f.operations, { at: instant(9), subject: 'outside the horizon entirely' });
    f.advance(4);
    const detail = await f.predictions.detail(p.id);
    assert.deepEqual(detail.lineage.addedAfter.supporting.ids.length, 1);
    assert.equal(detail.lineage.addedAfter.excluded.count, 1);
    assert.match(detail.lineage.addedAfter.excludedReasons.join(' '), /establishes neither success, failure, nor a block/);
    assert.ok(!detail.lineage.addedAfter.excluded.ids.includes(detail.lineage.addedAfter.supporting.ids[0]));
  });

  test('a cited record that has gone is marked unavailable and kept, never read as absent evidence', async () => {
    const f = fixture();
    const kept = await event(f.experience, f.operations, { at: instant(-4), subject: 'a run the ledger still holds' });
    const gone = await event(f.experience, f.operations, { at: instant(-3), subject: 'a run whose record is later removed' });
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate', {
      evidence: { supportingExperienceIds: [gone.id, kept.id] },
    }))).record;

    // Drop one stored experience line, as a hand-edited or restored-then-partial log would.
    const remaining = bytes(EXP(f.dir)).split('\n').filter((l) => l.trim() !== '' && !l.includes(gone.id));
    fs.writeFileSync(EXP(f.dir), `${remaining.join('\n')}\n`);
    const reread = reopen({ dir: f.dir });
    const detail = await reread.predictions.detail(p.id);
    assert.equal(detail.lineage.atCreation.supporting.count, 2, 'the citation is still declared, and still counted');
    const marked = detail.lineage.atCreation.supporting.shown.find((c) => c.id === gone.id);
    assert.equal(marked.available, false);
    assert.match(marked.reason, /not in the experience log/);
    assert.deepEqual(detail.lineage.atCreation.unresolvedExperienceIds, [gone.id]);
    assert.equal(detail.lineage.atCreation.unavailableDeclared, false);
    assert.equal(byId(detail.lineage.atCreation.supporting.shown, kept.id).available, true);
    assert.equal(detail.status, 'recorded', 'a lost citation does not become a verdict of any kind');
    assert.match(renderPredictionDetail(detail), /marked unavailable, never read as absent evidence/);
    assert.match(bytes(LEDGER(f.dir)), new RegExp(p.id), 'the expectation itself is untouched');
  });

  test('an unreadable experience log marks every citation unverified instead of missing', async () => {
    const f = fixture();
    const cited = await event(f.experience, f.operations, { at: instant(-4) });
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate', {
      evidence: { supportingExperienceIds: [cited.id] },
    }))).record;
    fs.appendFileSync(EXP(f.dir), '{{ not a record\n');
    const reread = reopen({ dir: f.dir });
    const detail = await reread.predictions.detail(p.id);
    assert.equal(detail.lineage.available, false);
    assert.equal(detail.lineage.basis, 'cited', 'what the record declared still stands');
    assert.equal(detail.lineage.atCreation.unavailableDeclared, true);
    assert.equal(detail.lineage.atCreation.supporting.count, 1);
    assert.equal(detail.lineage.atCreation.supporting.shown[0].available, false);
    assert.match(detail.lineage.atCreation.supporting.shown[0].reason, /could not be read, so this citation is unverified/);
    assert.match(renderPredictionDetail(detail), /Evidence read:  unavailable/);
  });

  test('a citation whose outcome reads against its role is disclosed, and keeps the role it was given', async () => {
    const f = fixture();
    const success = await event(f.experience, f.operations, { at: instant(-4), subject: 'a run that succeeded' });
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate', {
      evidence: { contradictingExperienceIds: [success.id] },
    }))).record;
    const detail = await f.predictions.detail(p.id);
    assert.equal(detail.lineage.atCreation.contradicting.count, 1, 'the citation is not silently re-roled');
    assert.equal(detail.lineage.atCreation.contradicting.shown[0].role, 'contradicting');
    assert.match(detail.lineage.atCreation.contradicting.shown[0].roleDisagreement, /reads against the role it was cited in/);
    assert.deepEqual(detail.lineage.atCreation.roleDisagreements, [success.id]);
    assert.equal(detail.lineage.atCreation.unresolvedExperienceIds.length, 0, 'a disagreement is not a missing record');
    assert.match(renderPredictionDetail(detail), /Role check:/);
    // APEX does not infer evidence relationships from wording, so a success cited against a success
    // expectation is left as the user's own statement: the verdict comes only from the horizon.
    assert.equal(detail.evidenceBasis, 'cited');
  });

  test('a cited pattern is reported as still detected or no longer detected, and is never a cause', async () => {
    const f = fixture();
    const p = (await f.predictions.recordPrediction(scoped('sync.push', {
      evidence: { patternKinds: ['repeated_failure', 'repeated_success'] },
    }))).record;
    for (const day of [1, 2, 3]) {
      await event(f.experience, f.operations, {
        capability: 'sync.push', outcome: Outcome.EXECUTION_FAILED, at: instant(day), subject: `the sync failed on run ${day}`,
      });
    }
    const detail = await f.predictions.detail(p.id);
    assert.deepEqual(detail.lineage.patternKindsNowDetected, ['repeated_failure']);
    assert.deepEqual(detail.lineage.patternKindsNoLongerDetected, ['repeated_success']);
    assert.deepEqual(detail.lineage.atCreation.patternKinds, ['repeated_failure', 'repeated_success']);
    assert.ok(detail.limitations.includes('pattern_kinds_descriptive'));
    assert.equal(detail.evaluationDecision, 'contradicted', 'a cited pattern establishes nothing by itself');
    assert.ok(!/pattern/.test(detail.evaluationReason));
  });

  test('outcome evidence is the recorded evaluation once one exists', async () => {
    const f = fixture();
    const p = (await f.predictions.recordPrediction(scoped('calc.evaluate'))).record;
    const establishing = await event(f.experience, f.operations, { at: instant(1) });
    const before = await f.predictions.detail(p.id);
    assert.equal(before.lineage.outcomeEvidence.source, 'derived at read time');
    assert.deepEqual(before.lineage.outcomeEvidence.ids.ids, [establishing.id]);
    assert.equal(before.lineage.outcomeEvidence.deciding, null);
    assert.deepEqual(before.lineage.outcomeEvidence.window, { since: p.createdAt, until: p.expiresAt });

    await f.predictions.recordEvaluation({ target: p.id, origin: 'user' });
    const after = await f.predictions.detail(p.id);
    assert.equal(after.lineage.outcomeEvidence.source, 'recorded evaluation');
    assert.equal(after.lineage.outcomeEvidence.deciding, establishing.id);
    assert.deepEqual(after.lineage.outcomeEvidence.ids.ids, [establishing.id]);
    assert.deepEqual(after.lineage.outcomeEvidence.window, { since: p.createdAt, until: p.expiresAt });
  });
});

describe('AE-9: calibration states its denominator and every exclusion, or states nothing', () => {
  test('an empty ledger reports no evaluations rather than a rate of nothing', async () => {
    const f = fixture();
    const { calibration } = await f.predictions.calibration();
    assert.equal(calibration.reliability, 'no_evaluations');
    assert.deepEqual(calibration.matchRate, { value: null, numerator: 0, denominator: 0, reason: 'no prediction has been evaluated yet' });
    assert.equal(calibration.totals.stored, 0);
    assert.equal(calibration.confidence.available, false);
    assert.equal(calibration.confidence.calibrationApplied, false);
    assert.deepEqual(calibration.limitations, [...PREDICTION_LIMITS]);
    assert.deepEqual(calibration.byCapability, []);
  });

  test('a rate is withheld below the sample floor, with each excluded kind counted', async () => {
    const f = fixture();
    // One prediction per lifecycle state, each establishing its own state from real records.
    const judged = (await f.predictions.recordPrediction(scoped('cal.matched'))).record;
    await event(f.experience, f.operations, { capability: 'cal.matched', at: instant(1) });
    await f.predictions.recordEvaluation({ target: judged.id, origin: 'user' });

    const awaiting = (await f.predictions.recordPrediction(scoped('cal.awaiting'))).record;
    await event(f.experience, f.operations, { capability: 'cal.awaiting', at: instant(1) });

    await f.predictions.recordPrediction(scoped('cal.expired', { expiresAt: instant(2) }));
    await f.predictions.recordPrediction(scoped('cal.recorded'));

    const withdrawn = (await f.predictions.recordPrediction(scoped('cal.invalidated'))).record;
    await f.predictions.invalidatePrediction({ target: withdrawn.id, reason: 'no longer an expectation I hold', origin: 'user' });

    const retired = (await f.predictions.recordPrediction(scoped('cal.superseded'))).record;
    await f.predictions.recordPrediction(scoped('cal.superseded', {
      subject: 'the corrected expectation for that capability',
      replaces: [retired.id],
    }));

    f.advance(5);
    const { calibration } = await f.predictions.calibration();
    assert.equal(calibration.reliability, 'insufficient_sample');
    assert.equal(calibration.matchRate.value, null);
    assert.equal(calibration.matchRate.numerator, 1);
    assert.equal(calibration.matchRate.denominator, 1);
    assert.match(calibration.matchRate.reason, new RegExp(`below ${MIN_CALIBRATION_EVALUATIONS}`));
    assert.match(calibration.rateDenominator, /matched \+ contradicted/);

    assert.equal(calibration.totals.stored, 7);
    assert.equal(calibration.totals.live, 6);
    assert.equal(calibration.totals.superseded, 1);
    assert.equal(calibration.totals.matched, 1);
    assert.equal(calibration.totals.contradicted, 0);
    assert.equal(calibration.totals.evaluated, 1);
    assert.equal(calibration.totals.invalidated, 1);
    assert.deepEqual(calibration.totals.byStatus, {
      invalidated: 1, evaluated: 1, superseded: 1, awaiting_evaluation: 1, expired: 1, recorded: 2,
    });
    const exclusions = Object.fromEntries(calibration.rateExclusions.map((item) => [item.key, item.count]));
    assert.deepEqual(Object.keys(exclusions).sort(), [
      'awaiting_evaluation', 'evidence_unavailable', 'expired', 'insufficient_evidence',
      'invalidated', 'outcome_unavailable', 'recorded', 'superseded',
    ].sort());
    assert.deepEqual(exclusions, {
      expired: 1, awaiting_evaluation: 1, recorded: 2, invalidated: 1, superseded: 1,
      insufficient_evidence: 0, outcome_unavailable: 2, evidence_unavailable: 0,
    }, 'the two unevaluated live expectations inside an open horizon are both counted as establishing nothing');
    for (const item of calibration.rateExclusions) assert.ok(item.reason.length > 10, `${item.key} names why it is excluded`);
    assert.equal(calibration.confidence.predictionsWithConfidence, 0);
    assert.match(renderCalibration(calibration), /Match rate:     none stated/);
    assert.ok(!/\d+\.\d+/.test(renderCalibration(calibration).split('\n').find((l) => l.startsWith('  Match rate'))));
  });

  test('each capability gets its own denominator, and a scoped read cannot mis-count another', async () => {
    const f = fixture();
    for (const capability of ['cal.alpha', 'cal.beta']) {
      const p = (await f.predictions.recordPrediction(scoped(capability))).record;
      await event(f.experience, f.operations, { capability, at: instant(1) });
      if (capability === 'cal.alpha') await f.predictions.recordEvaluation({ target: p.id, origin: 'user' });
    }
    await f.predictions.recordPrediction(scoped('cal.beta', { subject: 'a second expectation about the same capability' }));

    const { calibration } = await f.predictions.calibration();
    const groups = Object.fromEntries(calibration.byCapability.map((item) => [item.capability, item]));
    assert.equal(calibration.byCapability.length, 2);
    assert.deepEqual([groups['cal.alpha'].predictions, groups['cal.alpha'].matched, groups['cal.alpha'].denominator], [1, 1, 1]);
    assert.deepEqual([groups['cal.beta'].predictions, groups['cal.beta'].matched, groups['cal.beta'].denominator], [2, 0, 0]);
    assert.equal(groups['cal.alpha'].rate, null);
    assert.match(groups['cal.alpha'].rateWithheldReason, new RegExp(`below the ${MIN_CALIBRATION_EVALUATIONS}`));
    assert.equal(groups['cal.beta'].rateWithheldReason, 'no evaluation exists for this capability');
    assert.equal(calibration.capabilitiesTruncated, false);

    const scopedRead = await f.predictions.calibration({ capability: 'cal.alpha' });
    assert.equal(scopedRead.calibration.totals.stored, 1);
    assert.equal(scopedRead.calibration.totals.matched, 1);
    assert.equal(scopedRead.calibration.totals.unevaluated, 0);
    assert.deepEqual(scopedRead.calibration.byCapability.map((item) => item.capability), ['cal.alpha']);
    const unknown = await f.predictions.calibration({ capability: 'cal.gamma' });
    assert.equal(unknown.calibration.totals.stored, 0);
    assert.equal(unknown.calibration.reliability, 'no_evaluations');
  });

  test('twenty evaluations state a rate over a stated denominator, and it is still only a count', async () => {
    const f = fixture();
    const ids = [];
    // One horizon per expectation, opened and closed on its own day, so each verdict comes from the
    // outcome recorded for it rather than from whichever record happened to be read last.
    for (let day = 1; day <= MIN_CALIBRATION_EVALUATIONS; day += 1) {
      f.advance(day);
      const fails = day % 4 === 0;
      await event(f.experience, f.operations, {
        outcome: fails ? Outcome.EXECUTION_FAILED : Outcome.SUCCESS_VERIFIED,
        at: instant(day),
        subject: `nightly run ${day} ${fails ? 'failed' : 'finished'}`,
      });
      ids.push((await f.predictions.recordPrediction(scoped('calc.evaluate', {
        subject: `nightly run ${day} finishes by morning`,
        expiresAt: instant(day, 1),
      }))).record.id);
    }
    const verdicts = [];
    for (const id of ids) verdicts.push((await f.predictions.recordEvaluation({ target: id, origin: 'user' })).record.verdict);
    assert.equal(verdicts.filter((v) => v === 'matched').length, 15);
    assert.equal(verdicts.filter((v) => v === 'contradicted').length, 5);

    const { calibration } = await f.predictions.calibration();
    assert.equal(calibration.matchRate.value, 0.75);
    assert.deepEqual({ n: calibration.matchRate.numerator, d: calibration.matchRate.denominator }, { n: 15, d: 20 });
    assert.equal(calibration.matchRate.reason, null);
    assert.equal(calibration.reliability, 'counts_only', 'a count over twenty records is not a reliability claim');
    assert.equal(calibration.confidence.available, false);
    assert.equal(calibration.confidence.calibrationApplied, false);
    assert.equal(calibration.totals.evaluated, 20);
    assert.equal(calibration.totals.unevaluated, 0);
    assert.equal(calibration.totals.awaitingEvaluation, 0);
    assert.equal(calibration.totals.staleEvaluations, 0);
    assert.equal(calibration.byCapability[0].rate, 0.75);
    assert.match(renderCalibration(calibration), /rate 0\.75 over 20/);
    assert.match(renderCalibration(calibration), /Denominator:/);
    assert.ok(calibration.limitations.some((text) => /not calibrated probabilities/.test(text)));

    // The history of each expectation still shows only its own appended records.
    const one = await f.predictions.history(ids[3]);
    assert.deepEqual(one.records.map((r) => r.kind).sort(), [EVALUATION_KIND, PREDICTION_KIND].sort());
    assert.equal(one.projection.evaluation.verdict, 'contradicted');
    assert.equal((await f.predictions.list({ limit: 50 })).total, 20);
  });

  test('derived limitation codes travel with every record, and a reader cannot choose a weaker set', async () => {
    const f = fixture();
    const bare = (await f.predictions.recordPrediction(scoped('calc.evaluate'))).record;
    const cited = (await f.predictions.recordPrediction(scoped('sync.push', {
      evidence: { patternKinds: ['repeated_failure'] },
    }))).record;
    assert.deepEqual(bare.limitations, ['expectation_not_observation', 'confidence_unavailable', 'no_cited_evidence', 'expiry_not_failure', 'no_authorization']);
    assert.deepEqual(cited.limitations, ['expectation_not_observation', 'confidence_unavailable', 'pattern_kinds_descriptive', 'expiry_not_failure', 'no_authorization']);
    for (const code of [...bare.limitations, ...cited.limitations]) assert.ok(LIMITATION_CODES.includes(code));
    const rendered = renderPredictionDetail(await f.predictions.detail(bare.id));
    assert.match(rendered, /Confidence:     unavailable/);
    assert.match(rendered, /an expectation about a later event, not evidence that anything happened/);
    assert.ok(rendered.split('\n').every((l) => l.length <= 400), 'no rendered line runs unbounded');
  });
});
