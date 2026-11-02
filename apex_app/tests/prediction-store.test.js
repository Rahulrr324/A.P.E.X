// Batch AE: the prediction ledger at storage level.
//
// A prediction is the fourth kind of thing APEX keeps about its own operations: not what happened
// (an experience), not what the user said about it (feedback), not what order those describe (a
// temporal pattern), but what the user expects to happen later. That distinction is the whole
// subject of this batch, so these tests are written to check it rather than to admire it:
//
//   separation   a prediction lives in its own log, cannot be read as an experience, and cannot be
//                written into one;
//   record shape every prediction carries the fields the mission requires, and carries no confidence
//                value, because this build has no method that could produce one;
//   write-time refusal  an expectation may only be built on records that exist and are not dated
//                after the moment it was made;
//   fail closed  a damaged ledger refuses reads and writes instead of reporting a partial history.
//
// No test here contacts a model, starts a service, or downloads anything. Evidence fixtures are
// real audit + experience records written by the real stores in a temporary directory, so a
// citation is validated against the log it will be read from.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { OperationLog } from '../src/operations/operation-log.js';
import { ExperienceStore } from '../src/experience/experience-store.js';
import { PredictionStore } from '../src/prediction/prediction-store.js';
import { Outcome, OPERATION_SCHEMA } from '../src/outcomes.js';
import { StoreError, ValidationError } from '../src/errors.js';
import { PATTERN_KINDS } from '../src/experience/temporal.js';
import {
  CONFIDENCE_UNAVAILABLE_REASON,
  EVALUATION_KIND,
  INVALIDATION_KIND,
  MAX_PREDICTION_HORIZON_DAYS,
  MAX_SUBJECT_CHARS,
  PREDICTION_KIND,
  PREDICTION_RECORD_KINDS,
  PREDICTION_SCHEMA,
  PREDICTION_STATUSES,
  LIMITATION_CODES,
  renderPredictionList,
  validatePredictionRecord,
} from '../src/prediction/prediction-engine.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

// One fixed clock for every fixture: a horizon is a comparison against "now", so a read that
// advanced during a test would report a state change that is only time passing.
const NOW_MS = Date.parse('2026-11-05T09:00:00.000Z');
const NOW = () => new Date(NOW_MS);
const ahead = (days) => new Date(NOW_MS + days * 86_400_000).toISOString();
const ago = (days) => new Date(NOW_MS - days * 86_400_000).toISOString();

const LEDGER = (dir) => path.join(dir, 'predictions.jsonl');
const EXP = (dir) => path.join(dir, 'experiences.jsonl');

function fixture({ now = NOW, withExperiences = true } = {}) {
  const dir = tempDir();
  const operations = new OperationLog(path.join(dir, 'operations.jsonl'));
  const experience = new ExperienceStore(EXP(dir), { now, operations });
  const predictions = new PredictionStore(LEDGER(dir), {
    now,
    experiences: withExperiences ? experience : null,
  });
  return { dir, operations, experience, predictions };
}

let seq = 0;
// One audited operation plus the experience the user recorded of it: the only thing a prediction
// may cite. `at` is when the event happened, which is what a horizon is compared against.
async function event(experience, operations, {
  capability = 'calc.evaluate',
  outcome = Outcome.SUCCESS_VERIFIED,
  at = ago(4),
  subject = 'the release train ran as scheduled',
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

function basePrediction(overrides = {}) {
  return {
    capability: 'calc.evaluate',
    expectation: 'success',
    subject: 'the next release train runs on time',
    expiresAt: ahead(7),
    origin: 'user',
    ...overrides,
  };
}

const recordedLines = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
  : []);

// ---- AE-1 the ledger is a separate log, and separation is physical ------------

describe('AE-1 predictions are stored apart from observations', () => {
  test('the three prediction kinds live in predictions.jsonl and never in the experience log', async () => {
    const { dir, experience, operations, predictions } = fixture();
    const cited = await event(experience, operations);
    const { record } = await predictions.recordPrediction(basePrediction({
      evidence: { supportingExperienceIds: [cited.id] },
    }));
    await predictions.invalidatePrediction({ target: record.id, reason: 'the window moved', origin: 'user' });
    // A third prediction with outcome evidence inside its horizon, so one evaluation is recorded.
    const standing = await predictions.recordPrediction(basePrediction({
      capability: 'knowledge.add', subject: 'the next knowledge write is accepted', expiresAt: ahead(7),
    }));
    await event(experience, operations, { capability: 'knowledge.add', at: ahead(1) });
    await predictions.recordEvaluation({ target: standing.record.id, origin: 'user' });

    const kinds = recordedLines(LEDGER(dir)).map((r) => r.kind);
    assert.deepEqual(
      [...new Set(kinds)].sort(),
      [EVALUATION_KIND, INVALIDATION_KIND, PREDICTION_KIND].sort(),
      'all three kinds are in the prediction ledger',
    );
    assert.deepEqual(recordedLines(EXP(dir)).map((r) => r.kind), ['experience', 'experience']);
    assert.equal(recordedLines(EXP(dir)).length, 2, 'the cited event and the outcome event, nothing else');
    assert.equal(PREDICTION_RECORD_KINDS.length, 3);
  });

  test('no prediction read appears in any experience read', async () => {
    const { experience, operations, predictions } = fixture();
    const cited = await event(experience, operations);
    await predictions.recordPrediction(basePrediction({ evidence: { supportingExperienceIds: [cited.id] } }));

    assert.equal((await experience.list({ limit: 20 })).length, 1, 'the experience log holds only the recorded event');
    const summary = await experience.temporalSummary({ limit: 20 });
    assert.equal(summary.counts.stored, 1);
    assert.equal(summary.prediction, false, 'the temporal summary still states that it holds no prediction');
    const health = await experience.health();
    assert.equal(health.experiences, 1);
    assert.equal(health.corruptLines, 0, 'the experience log is not damaged by a ledger it cannot see');
  });

  test('a prediction-shaped line written into the experience log is reported as damage, not read as an experience', async () => {
    const { dir, experience, operations, predictions } = fixture();
    const cited = await event(experience, operations);
    const { record } = await predictions.recordPrediction(basePrediction({ evidence: { supportingExperienceIds: [cited.id] } }));
    // The attack the mission names: an expectation arriving in the observation log. Reuse the real
    // ledger line so this is exactly what a mis-pointed writer would leave behind.
    const [line] = recordedLines(LEDGER(dir));
    fs.appendFileSync(EXP(dir), `${JSON.stringify({ ...line, schema: 1 })}\n`);

    await assert.rejects(() => experience.list({ limit: 20 }), StoreError, 'an incomplete observation log is refused');
    const health = await experience.health();
    assert.equal(health.corruptLines, 1);
    assert.match(health.corrupt[0].reason, /unknown record kind/);
    // And the reverse direction: an experience-shaped line in the ledger is damage there too.
    const [experienceLine] = recordedLines(EXP(dir)).slice(0, 1);
    fs.appendFileSync(LEDGER(dir), `${JSON.stringify({ ...experienceLine })}\n`);
    await assert.rejects(() => predictions.list(), StoreError);
    assert.match(validatePredictionRecord({ ...experienceLine }), /unknown record kind/);
  });
});

// ---- AE-2 the record carries what the mission requires, and nothing else ----

describe('AE-2 a recorded prediction states what it is, when it ends, and what it does not mean', () => {
  test('the stored record has the required fields and no confidence value', async () => {
    const { dir, experience, operations, predictions } = fixture();
    const cited = await event(experience, operations);
    const feedback = await experience.recordFeedback({ target: cited.id, assessment: 'user_correction', origin: 'user' });
    const { record } = await predictions.recordPrediction(basePrediction({
      evidence: {
        supportingExperienceIds: [cited.id],
        feedbackIds: [feedback.record.id],
        patternKinds: ['repeated_failure'],
      },
      provenance: { operationId: 'op-0001', context: 'release review' },
    }));

    assert.equal(record.schema, PREDICTION_SCHEMA);
    assert.equal(record.kind, PREDICTION_KIND);
    assert.match(record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'a stable id');
    assert.equal(record.createdAt, NOW().toISOString(), 'when it was created');
    assert.equal(record.capability, 'calc.evaluate', 'what it is about');
    assert.equal(record.expectation, 'success', 'the outcome it expects');
    assert.equal(record.subject, 'the next release train runs on time');
    assert.equal(record.expiresAt, ahead(7), 'its horizon');
    assert.equal(record.confidence, null, 'confidence is represented as unavailable');
    assert.equal(record.evidenceBasis, 'cited');
    assert.deepEqual(record.evidence, {
      supportingExperienceIds: [cited.id],
      contradictingExperienceIds: [],
      feedbackIds: [feedback.record.id],
      patternKinds: ['repeated_failure'],
    });
    assert.equal(record.provenance.origin, 'user_recorded', 'provenance says a user recorded it');
    assert.equal(record.provenance.updateMode, 'user_confirmed');
    assert.equal(record.provenance.operationId, 'op-0001');
    assert.equal(record.provenance.context, 'release review');
    // The explicit statement of limitations, from the closed code list.
    assert.deepEqual(record.limitations, [
      'expectation_not_observation', 'confidence_unavailable', 'pattern_kinds_descriptive', 'expiry_not_failure', 'no_authorization',
    ]);
    for (const code of record.limitations) assert.ok(LIMITATION_CODES.includes(code), `unknown limitation code ${code}`);
    // Nothing that stores derived state, and no number that could be read as a probability.
    for (const field of ['status', 'evaluation', 'outcome', 'probability', 'score', 'weight', 'likelihood', 'certainty']) {
      assert.equal(Object.hasOwn(record, field), false, `a stored prediction must not carry ${field}`);
    }
    assert.equal(Object.hasOwn(record, 'from'), false, 'the horizon starts at the record itself');
    assert.equal(recordedLines(LEDGER(dir)).length, 1);
  });

  test('a prediction that names no evidence says so, and its projection reports confidence unavailable', async () => {
    const { predictions } = fixture();
    const { record } = await predictions.recordPrediction(basePrediction());
    assert.equal(record.evidenceBasis, 'none_cited');
    assert.deepEqual(record.limitations, [
      'expectation_not_observation', 'confidence_unavailable', 'no_cited_evidence', 'expiry_not_failure', 'no_authorization',
    ]);

    const item = await predictions.detail(record.id);
    assert.equal(item.status, 'recorded');
    assert.ok(PREDICTION_STATUSES.includes(item.status));
    assert.equal(item.confidence, null);
    assert.equal(item.confidenceReason, CONFIDENCE_UNAVAILABLE_REASON);
    assert.equal(item.evaluationDecision, 'outcome_unavailable');
    assert.equal(item.canRecordEvaluation, false);
    assert.equal(item.evidenceBasis, 'none_cited');
    assert.equal(item.lineage.atCreation.supporting.count, 0);
    assert.equal(item.lineage.available, true);
    assert.equal(item.evaluationRule.includes('the latest live experience'), true);
  });

  test('the stored limitations cannot be weakened by the writer', async () => {
    const { predictions } = fixture();
    // A projection recomputes the statement from the record's own fields, so a hand-edited line that
    // drops a limitation is damage rather than a weaker disclaimer.
    const { record } = await predictions.recordPrediction(basePrediction());
    const edits = [
      [{ limitations: ['no_authorization'] }, 'limitations do not match the record'],
      [{ confidence: 0.9 }, 'confidence must be present and null'],
      [{ confidence: undefined }, 'confidence must be present and null'],
      [{ status: 'recorded' }, 'a prediction must not carry status'],
      [{ evidenceBasis: 'cited' }, 'evidenceBasis disagrees with the cited evidence'],
      [{ evidence: { ...record.evidence, extra: 1 } }, 'evidence has an unknown field extra'],
    ];
    for (const [patch, expected] of edits) {
      assert.equal(validatePredictionRecord({ ...record, ...patch }), expected, JSON.stringify(patch));
    }
    assert.equal(validatePredictionRecord(record), null, 'the record as written is valid');
    assert.equal((await predictions.health()).corruptLines, 0);
  });
});

// ---- AE-3 write-time refusals ------------------------------------------------

describe('AE-3 the store refuses an expectation it cannot stand behind', () => {
  test('a model cannot record, withdraw, or evaluate a prediction', async () => {
    const { dir, predictions } = fixture();
    for (const [method, args] of [
      ['recordPrediction', basePrediction({ origin: 'model' })],
      ['invalidatePrediction', { target: 'a'.repeat(36), reason: 'x', origin: 'model' }],
      ['recordEvaluation', { target: 'a'.repeat(36), origin: 'model' }],
    ]) {
      await assert.rejects(() => predictions[method](args), (err) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.code, 'WRITE_REQUIRES_USER_ORIGIN');
        return true;
      }, `${method} must refuse a model-origin write`);
    }
    assert.equal(fs.existsSync(LEDGER(dir)), false, 'a refused write creates no file');
  });

  test('a caller cannot supply a confidence, a status, or a verdict', async () => {
    const { dir, predictions } = fixture();
    const { record } = await predictions.recordPrediction(basePrediction());
    for (const overrides of [
      { confidence: 0.9 },
      { status: 'recorded' },
      { evaluation: 'matched' },
      { outcome: Outcome.SUCCESS_VERIFIED },
      { evidence: { confidence: 0.4 } },
      { evidence: { probability: 0.4 } },
      { evidence: { score: 4 } },
      { evidence: { notes: 'free text' } },
    ]) {
      await assert.rejects(
        () => predictions.recordPrediction(basePrediction(overrides)),
        ValidationError,
        `${JSON.stringify(Object.keys(overrides))} must be refused, not ignored`,
      );
    }
    for (const overrides of [{ verdict: 'matched' }, { confidence: 0.5 }, { outcome: Outcome.SUCCESS_VERIFIED }]) {
      await assert.rejects(() => predictions.recordEvaluation({ target: record.id, origin: 'user', ...overrides }), ValidationError);
    }
    assert.equal(recordedLines(LEDGER(dir)).length, 1, 'only the first accepted prediction is stored');
  });

  test('provenance origin and update mode are derived, never supplied', async () => {
    const { dir, predictions } = fixture();
    for (const provenance of [{ origin: 'model_suggested' }, { updateMode: 'auto' }, { origin: 'user_recorded' }]) {
      await assert.rejects(
        () => predictions.recordPrediction(basePrediction({ provenance })),
        /may not be supplied directly/,
      );
    }
    await assert.rejects(
      () => predictions.recordPrediction(basePrediction({ provenance: { operationId: 'has spaces' } })),
      /operationId has an invalid format/,
    );
    assert.equal(recordedLines(LEDGER(dir)).length, 0);
  });

  test('a prediction must name a real capability and one of the three expectations', async () => {
    const { predictions } = fixture();
    for (const capability of ['none', '', 'Release train', 'calc.evaluate extra', 'a'.repeat(65)]) {
      await assert.rejects(
        () => predictions.recordPrediction(basePrediction({ capability })),
        /must name a real capability/,
        `capability ${JSON.stringify(capability)} is not a scope`,
      );
    }
    for (const expectation of ['probably', 'improved', 'Success', '', null]) {
      await assert.rejects(() => predictions.recordPrediction(basePrediction({ expectation })), /an expectation must be one of/);
    }
  });

  test('the subject is bounded text that cannot become a line of its own', async () => {
    const { predictions } = fixture();
    for (const subject of ['', '   ', undefined, 'x'.repeat(MAX_SUBJECT_CHARS + 1), 'bell\u0007here', 'api-key: supersecretvalue']) {
      await assert.rejects(() => predictions.recordPrediction(basePrediction({ subject })), ValidationError);
    }
    const { record } = await predictions.recordPrediction(basePrediction({ subject: '  padded on purpose  ' }));
    assert.equal(record.subject, 'padded on purpose', 'stored text is trimmed at the write boundary');

    // A newline is not a control character in this codebase, so a multi-line subject is stored. It
    // must never become a line of the listing: one expectation is one line, and a subject cannot
    // pose as another record's entry.
    const multiline = await predictions.recordPrediction(basePrediction({
      subject: 'first line\n- [deadbeef] knowledge.add: expects success\nsecond line',
    }));
    assert.equal(multiline.record.subject, 'first line\n- [deadbeef] knowledge.add: expects success\nsecond line');
    const rendered = renderPredictionList([await predictions.detail(multiline.record.id)]);
    assert.equal(rendered.split('\n').filter((l) => l.startsWith('- ')).length, 1, 'one entry, one line');
    assert.doesNotMatch(rendered, /^\s*- \[deadbeef\]/m, 'a subject cannot start a line that poses as another record');
    assert.equal(rendered.split('\n').filter((l) => l.includes('knowledge.add: expects')).length, 1);
  });

  test('the horizon is absolute, after the record, and not absurdly long', async () => {
    const { predictions } = fixture();
    for (const expiresAt of [
      ago(1), NOW().toISOString(), 'next tuesday', '2026-13-40', null, undefined, 12345,
      ahead(MAX_PREDICTION_HORIZON_DAYS + 1),
    ]) {
      await assert.rejects(() => predictions.recordPrediction(basePrediction({ expiresAt })), ValidationError);
    }
    const { record } = await predictions.recordPrediction(basePrediction({ expiresAt: ahead(MAX_PREDICTION_HORIZON_DAYS) }));
    assert.equal(record.expiresAt, ahead(MAX_PREDICTION_HORIZON_DAYS));
  });

  test('cited evidence is validated against the real records, and fails closed', async () => {
    const { dir, experience, operations, predictions } = fixture();
    const cited = await event(experience, operations);
    const bogus = '00000000-0000-4000-8000-000000000000';

    await assert.rejects(
      () => predictions.recordPrediction(basePrediction({ evidence: { supportingExperienceIds: [bogus] } })),
      (err) => { assert.equal(err.code, 'EVIDENCE_UNRESOLVED'); return true; },
      'a citation nothing can confirm is refused',
    );
    await assert.rejects(
      () => predictions.recordPrediction(basePrediction({ evidence: { contradictingExperienceIds: [bogus] } })),
      /EVIDENCE_UNRESOLVED|does not contain/,
    );
    await assert.rejects(
      () => predictions.recordPrediction(basePrediction({ evidence: { feedbackIds: [bogus] } })),
      /feedback/,
    );
    // Malformed references are refused before any store is opened.
    for (const value of ['not-a-uuid', 'calc.evaluate', '', 42]) {
      await assert.rejects(
        () => predictions.recordPrediction(basePrediction({ evidence: { supportingExperienceIds: [value] } })),
        /invalid id|must be a list|non-text id/,
      );
    }
    assert.equal(recordedLines(LEDGER(dir)).length, 0, 'nothing was written on any of those refusals');

    const ok = await predictions.recordPrediction(basePrediction({ evidence: { supportingExperienceIds: [cited.id] } }));
    assert.equal(ok.record.evidenceBasis, 'cited');
    assert.equal(recordedLines(LEDGER(dir)).length, 1);
  });

  // Every read of APEX prints a record as its first eight characters, so a citation the user can type
  // has to be nameable that way. The reference is resolved against the log it must exist in and the
  // exact id is what gets stored, so the lineage points at one record permanently.
  test('a citation named as a read prints it is stored as the whole id of one record', async () => {
    const { dir, experience, operations, predictions } = fixture();
    const cited = await event(experience, operations);
    const assessment = await experience.recordFeedback({ target: cited.id, assessment: 'useful', origin: 'user' });

    const { record } = await predictions.recordPrediction(basePrediction({
      evidence: {
        supportingExperienceIds: [cited.id.slice(0, 8)],
        feedbackIds: [assessment.record.id.slice(0, 8)],
      },
    }));
    assert.deepEqual(record.evidence.supportingExperienceIds, [cited.id], 'the stored citation is the exact experience id');
    assert.deepEqual(record.evidence.feedbackIds, [assessment.record.id], 'and the exact feedback id');
    assert.deepEqual(recordedLines(LEDGER(dir)).map((r) => r.kind), [PREDICTION_KIND]);

    // Two spellings of one record are still one record: named twice it is cited once, and it cannot
    // take both evidence roles just because the two lists gave different characters.
    const twice = await predictions.recordPrediction(basePrediction({
      subject: 'the following train is on time too',
      evidence: { supportingExperienceIds: [cited.id, cited.id.slice(0, 8)] },
    }));
    assert.deepEqual(twice.record.evidence.supportingExperienceIds, [cited.id]);
    await assert.rejects(
      () => predictions.recordPrediction(basePrediction({
        subject: 'a train that is both evidence for and against',
        evidence: { supportingExperienceIds: [cited.id], contradictingExperienceIds: [cited.id.slice(0, 8)] },
      })),
      /cannot be cited as both supporting and contradicting/,
    );

    // A reference too short to be the printed form is refused by its shape, before any log is opened.
    for (const value of ['dead', 'abcdefg', 'not-a-uuid']) {
      await assert.rejects(
        () => predictions.recordPrediction(basePrediction({ subject: `citing ${value}`, evidence: { supportingExperienceIds: [value] } })),
        /invalid id/,
      );
    }
    assert.equal(recordedLines(LEDGER(dir)).length, 2, 'the refusals wrote nothing');
  });

  // A prefix that matches two records cannot be resolved by choosing one: guessing would attach the
  // expectation to evidence the user did not name. No two UUIDs printed by APEX share eight
  // characters, so the log's answer is supplied here and the rule under test is the store's own.
  test('a citation prefix that matches two records is refused, not guessed', async () => {
    const dir = tempDir();
    const experiences = {
      evidenceIndex: async () => ({ experiences: [], feedback: [], unresolvedExperienceIds: [], unresolvedFeedbackIds: [] }),
      findByPrefix: async () => ([
        { id: 'aaaaaaaa-1111-4111-8111-000000000001' },
        { id: 'aaaaaaaa-2222-4111-8111-000000000002' },
      ]),
      findFeedbackByPrefix: async () => ([]),
    };
    const predictions = new PredictionStore(LEDGER(dir), { now: NOW, experiences });
    await assert.rejects(
      () => predictions.recordPrediction(basePrediction({ evidence: { supportingExperienceIds: ['aaaaaaaa'] } })),
      (err) => { assert.equal(err.code, 'EVIDENCE_AMBIGUOUS'); return true; },
      'two records matching one citation reference is a refusal',
    );
    assert.equal(recordedLines(LEDGER(dir)).length, 0, 'nothing was appended while the reference named two records');
  });

  // The duplicate refusal names the standing record in the form a read prints, so the correction it
  // suggests has to be accepted by the very command it points at.
  test('a replacement may be named by the short id the duplicate refusal prints', async () => {
    const { dir, experience, operations, predictions } = fixture();
    const cited = await event(experience, operations);
    const args = basePrediction({ evidence: { supportingExperienceIds: [cited.id] } });
    const first = await predictions.recordPrediction(args);
    await assert.rejects(() => predictions.recordPrediction(args), /already records this expectation/);

    const corrected = await predictions.recordPrediction({
      ...args,
      subject: 'the next release train runs an hour early',
      replaces: [first.record.id.slice(0, 8)],
    });
    assert.deepEqual(corrected.record.replaces, [first.record.id], 'the stored replacement is the exact id');
    assert.equal(recordedLines(LEDGER(dir)).filter((r) => r.kind === PREDICTION_KIND).length, 2);

    await assert.rejects(
      () => predictions.recordPrediction({ ...args, subject: 'and again', replaces: ['00000000-0000-4000-8000-000000000000'] }),
      /is not in the ledger/,
      'a replacement must name a recorded expectation, in either form',
    );
  });

  test('evidence dated after the prediction cannot be cited as its original support', async () => {
    const { dir, experience, operations, predictions } = fixture();
    const future = await event(experience, operations, { at: ahead(2), subject: 'a train that has not run yet' });
    await assert.rejects(
      () => predictions.recordPrediction(basePrediction({ evidence: { supportingExperienceIds: [future.id] } })),
      (err) => { assert.equal(err.code, 'EVIDENCE_FROM_FUTURE'); return true; },
    );
    assert.equal(recordedLines(LEDGER(dir)).length, 0);

    // The same event cited by a prediction made after it happened is legitimate: what matters is the
    // order, so the clock moves forward rather than the record being edited.
    const later = new PredictionStore(LEDGER(dir), {
      now: () => new Date(NOW_MS + 3 * 86_400_000),
      experiences: experience,
    });
    const cited = await later.recordPrediction(basePrediction({
      subject: 'the following release train also runs on time',
      evidence: { supportingExperienceIds: [future.id] },
    }));
    assert.equal(cited.record.evidenceBasis, 'cited');
    assert.equal(cited.record.createdAt, new Date(NOW_MS + 3 * 86_400_000).toISOString());
  });

  test('a citation cannot be written when the experience log is not configured', async () => {
    const { dir, predictions } = fixture({ withExperiences: false });
    await assert.rejects(
      () => predictions.recordPrediction(basePrediction({
        evidence: { supportingExperienceIds: ['00000000-0000-4000-8000-000000000000'] },
      })),
      (err) => { assert.equal(err.code, 'EVIDENCE_UNRESOLVED'); return true; },
    );
    // An expectation with no citations is still recordable: it simply says it names no evidence.
    const { record } = await predictions.recordPrediction(basePrediction());
    assert.equal(record.evidenceBasis, 'none_cited');
    assert.equal(recordedLines(LEDGER(dir)).length, 1);
  });

  test('one record cannot be cited as both support and contradiction, and pattern kinds are a closed list', async () => {
    const { experience, operations, predictions } = fixture();
    const cited = await event(experience, operations);
    await assert.rejects(
      () => predictions.recordPrediction(basePrediction({
        evidence: { supportingExperienceIds: [cited.id], contradictingExperienceIds: [cited.id] },
      })),
      /cannot be cited as both supporting and contradicting/,
    );
    await assert.rejects(
      () => predictions.recordPrediction(basePrediction({ evidence: { patternKinds: ['cause_and_effect'] } })),
      /not one the temporal engine can produce/,
    );
    for (const kind of PATTERN_KINDS) {
      const { record } = await predictions.recordPrediction(basePrediction({
        subject: `expectation citing ${kind}`,
        evidence: { patternKinds: [kind] },
      }));
      assert.deepEqual(record.evidence.patternKinds, [kind]);
    }
  });

  test('an identical standing expectation is refused instead of duplicated', async () => {
    const { experience, operations, predictions } = fixture();
    const cited = await event(experience, operations);
    const args = basePrediction({ evidence: { supportingExperienceIds: [cited.id] } });
    const first = await predictions.recordPrediction(args);
    await assert.rejects(() => predictions.recordPrediction(args), (err) => {
      assert.equal(err.code, 'PREDICTION_EXISTS');
      assert.match(err.message, /\[.{8}\] already records this expectation/);
      return true;
    });
    assert.equal((await predictions.list()).total, 1);

    // Correcting it is allowed and keeps the first record: the replacement names what it replaces.
    const corrected = await predictions.recordPrediction({
      ...args, subject: 'the next release train runs an hour early', replaces: [first.record.id],
    });
    assert.deepEqual(corrected.record.replaces, [first.record.id]);
    assert.equal((await predictions.list()).total, 2);
    // And the same expectation may be recorded again once the standing one has been replaced.
    const again = await predictions.recordPrediction(args);
    assert.equal(again.record.capability, 'calc.evaluate');
  });

  test('a replacement must name a standing, unwithdrawn prediction', async () => {
    const { predictions } = fixture();
    const a = await predictions.recordPrediction(basePrediction({ subject: 'first expectation' }));
    await predictions.invalidatePrediction({ target: a.record.id, reason: 'no longer held', origin: 'user' });
    await assert.rejects(
      () => predictions.recordPrediction(basePrediction({ subject: 'second expectation', replaces: [a.record.id] })),
      /was withdrawn by the user/,
    );

    const b = await predictions.recordPrediction(basePrediction({ subject: 'third expectation' }));
    const c = await predictions.recordPrediction(basePrediction({ subject: 'fourth expectation', replaces: [b.record.id] }));
    await assert.rejects(
      () => predictions.recordPrediction(basePrediction({ subject: 'fifth expectation', replaces: [b.record.id] })),
      (err) => { assert.match(err.message, new RegExp(c.record.id.slice(0, 8))); return true; },
      'the refusal names the record that already replaced it',
    );
    await assert.rejects(
      () => predictions.recordPrediction(basePrediction({ subject: 'sixth expectation', replaces: ['00000000-0000-4000-8000-000000000000'] })),
      /is not in the ledger/,
    );
  });
});

// ---- AE-4 damaged storage fails closed --------------------------------------

describe('AE-4 a damaged ledger is refused, reported, and never read as an empty one', () => {
  test('every read and write refuses while a line is unreadable', async () => {
    const { dir, predictions } = fixture();
    const { record } = await predictions.recordPrediction(basePrediction());
    fs.appendFileSync(LEDGER(dir), '{ this is not json\n');

    for (const call of [
      () => predictions.list(),
      () => predictions.detail(record.id),
      () => predictions.history(record.id),
      () => predictions.calibration({}),
      () => predictions.recordPrediction(basePrediction({ subject: 'a new expectation' })),
      () => predictions.invalidatePrediction({ target: record.id, reason: 'x', origin: 'user' }),
      () => predictions.recordEvaluation({ target: record.id, origin: 'user' }),
    ]) {
      await assert.rejects(call, StoreError, 'an incomplete ledger is never used as authority');
    }
    // The one read that must still answer is the operational status line, and it counts the damage.
    const status = await predictions.status();
    assert.equal(status.corrupt, 1);
    assert.equal(status.predictions, 1);
    const health = await predictions.health();
    assert.equal(health.inspected, false);
    assert.equal(health.corruptLines, 1);
    assert.match(health.corrupt[0].reason, /invalid JSON/);
  });

  test('a valid line that fails record validation is damage too', async () => {
    const { dir, predictions } = fixture();
    const { record } = await predictions.recordPrediction(basePrediction());
    fs.appendFileSync(LEDGER(dir), `${JSON.stringify({
      schema: PREDICTION_SCHEMA, kind: PREDICTION_KIND, ...record, confidence: 0.75,
    })}\n`);
    await assert.rejects(() => predictions.list(), StoreError);
    const health = await predictions.health();
    assert.equal(health.corruptLines, 1);
    assert.match(health.corrupt[0].reason, /confidence must be present and null/);
  });

  test('a truncated tail is reported as truncation and the ledger recovers when it is removed', async () => {
    const { dir, predictions } = fixture();
    const { record } = await predictions.recordPrediction(basePrediction());
    fs.appendFileSync(LEDGER(dir), '{"schema":1,"kind":"prediction","id":"abc');
    await assert.rejects(() => predictions.list(), StoreError);
    assert.equal((await predictions.health()).corrupt[0].truncatedTail, true);

    const lines = fs.readFileSync(LEDGER(dir), 'utf8').split('\n').filter((l) => l.trim() !== '');
    fs.writeFileSync(LEDGER(dir), `${lines[0]}\n`);
    const item = await predictions.detail(record.id);
    assert.equal(item.status, 'recorded');
    assert.equal((await predictions.health()).corruptLines, 0);
  });
});

// ---- AE-5 references are exact or refused ------------------------------------

describe('AE-5 a prediction is addressed by an unambiguous reference', () => {
  test('full ids, unique prefixes and short ids resolve; absent and ambiguous ones are refused', async () => {
    const { predictions } = fixture();
    const first = await predictions.recordPrediction(basePrediction({ subject: 'alpha expectation' }));
    const second = await predictions.recordPrediction(basePrediction({ subject: 'beta expectation', expiresAt: ahead(9) }));

    assert.equal((await predictions.detail(first.record.id)).id, first.record.id);
    assert.equal((await predictions.detail(first.record.id.slice(0, 8))).id, first.record.id);
    assert.equal((await predictions.history(second.record.id)).projection.id, second.record.id);

    await assert.rejects(() => predictions.detail('00000000-0000-4000-8000-000000000000'), /no prediction record matches/);
    assert.equal(await predictions.detail(''), null, 'an empty reference is an empty answer, not a refusal');
    assert.equal(await predictions.history(''), null);
    await assert.rejects(() => predictions.invalidatePrediction({ target: '', reason: 'x', origin: 'user' }), /must name the prediction/);
    await assert.rejects(() => predictions.recordEvaluation({ target: '   ', origin: 'user' }), /must name the prediction/);
    // Two records sharing the first 8 hex characters is a real risk, so force the collision instead
    // of hoping for it: identical ids cannot be written, but an identical prefix can.
    const { predictions: other } = fixture();
    const a = await other.recordPrediction(basePrediction({ subject: 'colliding one' }));
    const b = await other.recordPrediction(basePrediction({ subject: 'colliding two', expiresAt: ahead(3) }));
    const shared = commonPrefixLength(a.record.id, b.record.id);
    if (shared >= 4) {
      await assert.rejects(() => other.detail(a.record.id.slice(0, shared)), /ambiguous/);
    } else {
      assert.equal((await other.detail(a.record.id.slice(0, 4))).id, a.record.id, 'a unique prefix resolves');
    }
  });

  test('an empty ledger reads as empty and says so, and a list is bounded', async () => {
    const { dir, predictions } = fixture();
    assert.equal(fs.existsSync(LEDGER(dir)), false, 'no file is written until a user records an expectation');
    const empty = await predictions.list();
    assert.deepEqual(empty.projections, []);
    assert.equal(empty.total, 0);
    assert.equal((await predictions.status()).records, 0);

    for (let i = 0; i < 4; i += 1) {
      await predictions.recordPrediction(basePrediction({ subject: `bounded expectation ${i}`, expiresAt: ahead(2 + i) }));
    }
    const view = await predictions.list({ limit: 2 });
    assert.equal(view.projections.length, 2);
    assert.equal(view.total, 4);
    assert.equal(view.truncated, true);
    assert.equal(view.projections[0].createdAt, view.projections[1].createdAt, 'one clock, so order is by log position');
    assert.equal((await predictions.list({ limit: 999 })).projections.length, 4, 'the bound is applied, not the request');
  });
});

// ---- AE-8 an aggregate read opens every horizon from one snapshot --------------

// One horizon is a window, a capability scope and a pattern detection, so the read that decides a
// prediction stays per prediction. What an aggregate read used to repeat was the step underneath it:
// opening the experience log, which is a whole-file read, a hash, a validation pass over every
// record and the lifecycle derivation. That repeat is what made `apex prediction list` and any
// prediction-shaped model request cost grow with predictions x the size of the experience log.
//
// These tests pin the sharing of only that step, and pin the two things that make it safe: nothing a
// reader can see changes, and a single-prediction read takes no snapshot at all.

describe('AE-8 an aggregate read shares one snapshot of the experience log', () => {
  test('one aggregate read takes one snapshot and opens every horizon from it', async () => {
    const { shared, watch, predictions } = await horizonFixture();
    const list = await shared.list();
    assert.equal(list.projections.length, 4, 'the fixture has four standing expectations');

    assert.equal(watch.calls.snapshots, 1, 'the experience log is opened once for the whole read');
    assert.equal(watch.calls.indexCalls.length, 4, 'one horizon per prediction, still');
    const snapshots = watch.calls.indexCalls.map((call) => call.snapshot);
    assert.ok(snapshots.every((snapshot) => snapshot !== null), 'no horizon fell back to its own read');
    assert.equal(snapshots[1], snapshots[0], 'the same derived log, not four equal-looking ones');
    assert.equal(snapshots[2], snapshots[0]);
    assert.equal(snapshots[3], snapshots[0]);

    // Sharing the file read must not collapse the reads that depend on it: each expectation has its
    // own window and its own capability, and each reports its own in-window count.
    const byId = new Map(predictions.map((record) => [record.id, record.subject]));
    const scoped = watch.calls.indexCalls.map((call) => `${call.capability}|${call.until}`);
    assert.equal(new Set(scoped).size, 4, 'four distinct horizons were asked for');
    const held = list.projections
      .map((item) => `${byId.get(item.id)}=${item.counts?.inHorizon ?? 'unread'}`)
      .sort();
    assert.deepEqual(held, [
      'a memory note gets stored=0',
      'calc stays on schedule for a second window=2',
      'calc stays on schedule this week=1',
      'knowledge writes keep being accepted=2',
    ], 'each horizon saw only its own events');
  });

  test('a snapshot read and a per-horizon read report identical projections and counts', async () => {
    const { shared, perHorizon, watchShared, watchPerHorizon } = await horizonFixture();

    const a = await shared.list();
    const b = await perHorizon.list();
    assert.equal(watchPerHorizon.calls.snapshots, 0, 'the second store cannot snapshot, so it reads per horizon');
    assert.equal(watchPerHorizon.calls.indexCalls.length, 4);
    assert.ok(watchPerHorizon.calls.indexCalls.every((call) => call.snapshot === null));
    assert.deepEqual(b.projections, a.projections, 'sharing the log read changed nothing a reader can see');
    assert.equal(b.total, a.total);

    const calA = await shared.calibration();
    const calB = await perHorizon.calibration();
    assert.deepEqual(calB.calibration, calA.calibration, 'calibration counts are derived from evidence-bearing projections');
    assert.deepEqual(await perHorizon.promptView(), await shared.promptView());

    // The published counts are the reason the horizon reads could not simply be bounded: every
    // exclusion is stated from a horizon that was actually opened.
    const decisions = calA.ledger.projections.map((item) => item.evaluationDecision);
    assert.deepEqual([...new Set(decisions)].sort(), ['matched', 'outcome_unavailable'],
      'three horizons hold an establishing event and one holds none');
    assert.equal(decisions.filter((d) => d === 'outcome_unavailable').length, 1);
    assert.ok(watchShared.calls.snapshots >= 3, 'each of the three aggregate reads took its own snapshot');
  });

  test('a read that names one prediction opens one horizon and takes no snapshot', async () => {
    const { shared, predictions, watch } = await horizonFixture();
    const target = predictions[0];

    const item = await shared.detail(target.id);
    assert.equal(item.id, target.id);
    assert.equal(watch.calls.snapshots, 0, 'one horizon needs no shared log');
    assert.equal(watch.calls.indexCalls.length, 1);
    assert.equal(watch.calls.indexCalls[0].snapshot, null);
    assert.equal(watch.calls.indexCalls[0].capability, target.capability);
    assert.equal(watch.calls.indexCalls[0].until, target.expiresAt);
    assert.equal(item.counts.inHorizon, 1, 'the named prediction had its own horizon opened');

    watch.reset();
    const other = predictions[3];
    const history = await shared.history(other.id);
    assert.equal(history.projection.id, other.id);
    assert.equal(watch.calls.snapshots, 0);
    assert.equal(watch.calls.indexCalls.length, 1, 'the rest of the ledger is not read from the experience log');
    assert.equal(watch.calls.indexCalls[0].capability, other.capability);
    assert.equal(history.projection.counts.inHorizon, 0, 'its horizon is empty, which is read, not assumed');
  });

  test('a snapshot that cannot be taken costs the old read, not a lost horizon', async () => {
    const { shared, predictions, watch } = await horizonFixture({ snapshotThrows: true });
    const list = await shared.list();

    assert.equal(watch.calls.snapshots, 0, 'the attempt failed before it counted');
    assert.equal(watch.calls.indexCalls.length, 4, 'every horizon was still opened');
    assert.ok(watch.calls.indexCalls.every((call) => call.snapshot === null));
    assert.deepEqual(list.projections.map((item) => item.id).sort(), predictions.map((r) => r.id).sort());
    assert.ok(list.projections.every((item) => item.counts !== null && item.lineage.available === true),
      'no projection lost its horizon or reports that it could not be read');
  });

  test('a snapshot is a point-in-time view, and the next read sees what was appended since', async () => {
    const dir = tempDir();
    const operations = new OperationLog(path.join(dir, 'operations.jsonl'));
    const experience = new ExperienceStore(EXP(dir), { now: NOW, operations });
    const first = await event(experience, operations, { at: ahead(1) });
    const args = {
      experienceIds: [first.id],
      since: NOW().toISOString(), until: ahead(3), capability: 'calc.evaluate',
    };

    const snapshot = await experience.evidenceSnapshot();
    const fromSnapshot = await experience.evidenceIndex({ ...args, snapshot });
    assert.deepEqual(await experience.evidenceIndex(args), fromSnapshot, 'a snapshot taken now reads the same log a fresh read does');

    await event(experience, operations, { at: ahead(2), subject: 'a second run finished inside the window' });
    const after = await experience.evidenceIndex(args);
    assert.equal(after.counts.inWindow, fromSnapshot.counts.inWindow + 1, 'the append is real and a fresh read finds it');
    assert.equal(after.counts.storedExperiences, fromSnapshot.counts.storedExperiences + 1);
    assert.equal(fromSnapshot.counts.inWindow, (await experience.evidenceIndex({ ...args, snapshot: await experience.evidenceSnapshot() })).counts.inWindow - 1,
      'holding a snapshot across operations is holding a past instant, by the caller\'s choice not the store\'s');
  });

  test('the store keeps no snapshot between reads, so a late append is never invisible to the next request', async () => {
    const { shared, experience, operations, predictions } = await horizonFixture();
    const before = await shared.detail(predictions[0].id);
    assert.equal(before.counts.inHorizon, 1);

    await event(experience, operations, { at: aheadHours(28), capability: 'calc.evaluate', subject: 'another calc run finished in the window' });
    const after = await shared.detail(predictions[0].id);
    assert.equal(after.counts.inHorizon, before.counts.inHorizon + 1, 'nothing was retained from the earlier read');
    assert.equal(after.counts.storedExperiences, before.counts.storedExperiences + 1);
  });

  test('a prediction write that cites records still validates them against a fresh read', async () => {
    const dir = tempDir();
    const operations = new OperationLog(path.join(dir, 'operations.jsonl'));
    const experience = new ExperienceStore(EXP(dir), { now: NOW, operations });
    const cited = await event(experience, operations, { at: ago(1) });
    const watch = watchExperiences(experience);
    const predictions = new PredictionStore(LEDGER(dir), { now: NOW, experiences: watch });

    await predictions.recordPrediction(basePrediction({
      subject: 'the next calc run stays on schedule',
      evidence: { supportingExperienceIds: [cited.id] },
    }));
    assert.equal(watch.calls.snapshots, 0, 'the citation check is one read, so it takes no snapshot');
    assert.equal(watch.calls.indexCalls.length, 1);
    assert.equal(watch.calls.indexCalls[0].snapshot, null);
    assert.equal(watch.calls.indexCalls[0].capability, null, 'a citation is bounded by what existed, not by the horizon');
  });
});

function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

// ---- AE-8 fixtures ------------------------------------------------------------

// Every record on both sides of these horizons is written by the real stores in one temporary
// directory, so a horizon read here opens a log that really contains the events it reports.
const HOUR_MS = 3_600_000;
const aheadHours = (hours) => new Date(NOW_MS + hours * HOUR_MS).toISOString();

function watchExperiences(experience, { exposeSnapshot = true, snapshotThrows = false } = {}) {
  const watcher = {
    calls: { snapshots: 0, indexCalls: [] },
    reset() { watcher.calls.snapshots = 0; watcher.calls.indexCalls = []; },
    async evidenceSnapshot() {
      if (snapshotThrows) throw new StoreError('the experience log could not be snapshotted');
      watcher.calls.snapshots += 1;
      return experience.evidenceSnapshot();
    },
    async evidenceIndex(args) {
      watcher.calls.indexCalls.push({
        snapshot: args.snapshot ?? null,
        since: args.since, until: args.until, capability: args.capability ?? null,
      });
      return experience.evidenceIndex(args);
    },
    findByPrefix: (ref) => experience.findByPrefix(ref),
    findFeedbackByPrefix: (ref) => experience.findFeedbackByPrefix(ref),
  };
  // Deleted rather than stubbed to throw: the production guard is a typeof check, and a read of the
  // pre-change path has to be a read that could not find the method at all.
  if (!exposeSnapshot) delete watcher.evidenceSnapshot;
  return watcher;
}

// Four expectations over three capabilities, each with a different horizon - one of them holding no
// event at all - so an aggregate read opens four horizons that are not interchangeable. `shared` may
// take a snapshot; `perHorizon` cannot see the method and therefore reads the experience log once per
// horizon, which is the path this change replaced. Both stores read the same two files.
async function horizonFixture({ snapshotThrows = false } = {}) {
  const dir = tempDir();
  const operations = new OperationLog(path.join(dir, 'operations.jsonl'));
  const experience = new ExperienceStore(EXP(dir), { now: NOW, operations });
  await event(experience, operations, { at: aheadHours(24), subject: 'a calc run finished on schedule' });
  await event(experience, operations, { at: aheadHours(48), subject: 'a second calc run finished' });
  await event(experience, operations, { capability: 'knowledge.add', at: aheadHours(72), subject: 'a knowledge write was accepted' });
  await event(experience, operations, { capability: 'knowledge.add', at: aheadHours(144), subject: 'a later knowledge write was accepted' });

  const watchShared = watchExperiences(experience, { snapshotThrows });
  const shared = new PredictionStore(LEDGER(dir), { now: NOW, experiences: watchShared });
  const watchPerHorizon = watchExperiences(experience, { exposeSnapshot: false });
  const perHorizon = new PredictionStore(LEDGER(dir), { now: NOW, experiences: watchPerHorizon });

  const records = [];
  for (const spec of [
    { subject: 'calc stays on schedule this week', expiresAt: aheadHours(30) },
    { subject: 'calc stays on schedule for a second window', expiresAt: aheadHours(50) },
    { subject: 'knowledge writes keep being accepted', capability: 'knowledge.add', expiresAt: aheadHours(200) },
    { subject: 'a memory note gets stored', capability: 'memory.add', expiresAt: aheadHours(12) },
  ]) {
    records.push((await shared.recordPrediction(basePrediction(spec))).record);
  }
  return { dir, operations, experience, shared, perHorizon, predictions: records, watch: watchShared, watchShared, watchPerHorizon };
}
