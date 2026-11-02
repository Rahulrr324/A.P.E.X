// Batch AE: the prediction ledger reached through the assembled application - the action registry,
// the controller's audit and finalization path, the command line, and the read-only operational
// surface.
//
// AE-05 asks a question the store and lifecycle suites cannot answer: once a user types a command,
// does the wiring still keep the kinds of information apart? So these tests assert on what the real
// path produces - exit codes, terminal text, the bytes in predictions.jsonl, the audit log - rather
// than on internals. Three boundaries get the closest attention, because they are the ones a wiring
// change is most likely to soften:
//
//   authorization  a prediction is recorded only by a user-origin command, refused by the registry
//                  and again by the store, and it is never captured as an experience;
//   citation       a reference is resolved against the record it must exist in and stored as that
//                  record's exact id - never guessed, never kept as a prefix;
//   reporting      a refusal that happened before the action ran is an input rejection, one that
//                  happened inside it is an execution failure, and an exit code says which.
//
// Nothing here contacts a model, starts an inference service, or downloads anything. Each fixture is
// an audited operation APEX really carried out, on a deterministic clock, in a temporary directory.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, cleanEnv, runCli } from './helpers.js';
import { createApp } from '../src/app.js';
import { main } from '../src/cli.js';
import { Outcome } from '../src/outcomes.js';
import { State, collectDiagnostics, renderDiagnostics } from '../src/diagnostics.js';
import { CAPTURE_VERIFIED_SUCCESS } from '../src/experience/capture.js';
import { FEEDBACK_KIND, EXPERIENCE_KIND } from '../src/experience/experience-store.js';
import { PREDICTION_KIND, EVALUATION_KIND } from '../src/prediction/prediction-engine.js';
import { shortId } from '../src/util.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function envFor(dataDir, extra = {}) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir, ...extra });
}

function capture() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
      return true;
    },
  };
}

// The real entry point, in this process, against the app the test assembled. Exit codes and printed
// text are the contract, so both are returned.
async function cli(app, dataDir, argv) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, {
    env: envFor(dataDir),
    stdout,
    stderr,
    stdin: { isTTY: false },
    appFactory: () => app,
  });
  return { code, out: stdout.text, err: stderr.text };
}

function makeClock(start = '2026-10-01T09:00:00.000Z') {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    advanceDays: (days) => { ms += days * 86400000; },
  };
}

function appFor(dataDir, clock, options = {}) {
  return createApp({ dataDir, now: clock.now, ...options });
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function ledgerOf(dataDir) {
  return readLines(path.join(dataDir, 'predictions.jsonl')).map((line) => JSON.parse(line));
}

function expectationsOf(dataDir) {
  return ledgerOf(dataDir).filter((record) => record.kind === PREDICTION_KIND);
}

function experienceLogOf(dataDir) {
  return readLines(path.join(dataDir, 'experiences.jsonl')).map((line) => JSON.parse(line));
}

function auditCount(dataDir) {
  return readLines(path.join(dataDir, 'operations.jsonl')).length;
}

// The evidence a prediction is allowed to cite: an operation APEX actually ran and audited, plus the
// experience the user recorded of it. Written by the real stores, so the citation resolves against
// a record that exists rather than a fixture that only looks like one.
async function seedEvent(app, clock, { request = 'calc 1+1', subject = 'evaluated 1+1', day = 0 } = {}) {
  clock.advanceDays(day);
  const res = await app.controller.handle(request, { origin: 'user' });
  assert.ok(res.operation, `the fixture depends on "${request}" producing an audited operation`);
  const { record } = await app.experience.recordExperience({
    operationId: res.operation.id,
    subject,
    origin: 'user',
  });
  return { operation: res.operation, experience: record };
}

async function seedFeedback(app, target, assessment = 'useful') {
  const res = await app.controller.feedbackRecord({ target, assessment });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
  return res.operation;
}

function firstFeedback(dataDir) {
  return experienceLogOf(dataDir).find((record) => record.kind === FEEDBACK_KIND);
}

const recordFixture = {
  capability: 'calc.evaluate',
  expectation: 'success',
  subject: 'the next calculation is reported as a verified success',
  inDays: 30,
};

describe('the prediction commands through the controller and the audit contract', () => {
  test('record, list, show, history and summary each run one registered action and re-read their own result', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    await seedEvent(app, clock);

    const recorded = await app.controller.predictionRecord(recordFixture);
    assert.equal(recorded.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(recorded.operation.capability, 'prediction.record');
    assert.equal(recorded.operation.steps[0].authorization.decision, 'allow');
    assert.equal(recorded.operation.steps[0].verification.outcome, Outcome.SUCCESS_VERIFIED);
    // The verifier re-opens the ledger instead of trusting the write's own report.
    assert.match(recorded.operation.steps[0].verification.detail, /prediction present/);
    const id = expectationsOf(dir)[0].id;

    for (const [name, res] of [
      ['prediction.list', await app.controller.predictionList({ limit: 20 })],
      ['prediction.show', await app.controller.predictionShow({ target: shortId(id) })],
      ['prediction.history', await app.controller.predictionHistory({ target: shortId(id) })],
      ['prediction.summary', await app.controller.predictionSummary({})],
    ]) {
      assert.equal(res.status, Outcome.SUCCESS_VERIFIED, `${name} must be a verified read`);
      assert.equal(res.operation.capability, name);
      assert.equal(res.operation.steps.length, 1, `${name} runs exactly the action it names`);
      assert.equal(res.operation.steps[0].verification.outcome, Outcome.SUCCESS_VERIFIED);
      assert.match(res.operation.steps[0].verification.detail, /store|ledger|read|confirmed/i, `${name} verifies against a re-read, not against its own result`);
    }

    // One expectation, five operations: the reads are audited because they were authorized commands,
    // and none of them wrote a prediction.
    assert.equal(ledgerOf(dir).length, 1);
    assert.equal(expectationsOf(dir).length, 1);
    assert.equal(auditCount(dir), 6, 'the seeded event, the record, and one operation per read');
  });

  test('the reply a write prints is the state a later read reports, and confidence stays unavailable', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    const { experience } = await seedEvent(app, clock);

    const res = await app.controller.predictionRecord({
      ...recordFixture,
      evidence: { supportingExperienceIds: [experience.id] },
    });
    const id = expectationsOf(dir)[0].id;
    assert.match(res.display, new RegExp(`Prediction \\[${shortId(id)}\\]`));
    assert.match(res.display, /Evidence basis: cited/);
    assert.match(res.display, /Cited at creation: 1 supporting/);
    assert.match(res.display, /Confidence:\s+unavailable/);
    assert.match(res.display, /not an observation|never authorizes|not an observation/i);

    const shown = await app.controller.predictionShow({ target: id });
    for (const line of ['Capability:     calc.evaluate', 'Expectation:    success', `Prediction [${shortId(id)}]`]) {
      assert.ok(shown.display.includes(line), `the detail read must repeat the stored field "${line}"`);
    }
    assert.equal(expectationsOf(dir)[0].confidence, null, 'no confidence is stored in the ledger record either');
  });

  test('a model cannot record, evaluate, or withdraw a prediction, at the registry and again in the store', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    await seedEvent(app, clock);
    const created = await app.controller.predictionRecord(recordFixture);
    assert.equal(created.status, Outcome.SUCCESS_VERIFIED);
    const id = expectationsOf(dir)[0].id;
    const ledgerBytes = fs.readFileSync(path.join(dir, 'predictions.jsonl'));
    const operationsBefore = auditCount(dir);

    const attempts = [
      ['prediction.record', { ...recordFixture, subject: 'a model proposal' }],
      ['prediction.evaluate', { target: id }],
      ['prediction.invalidate', { target: id, reason: 'a model proposal' }],
    ];
    for (const [name, input] of attempts) {
      const step = await app.controller.runAction(name, input, 'model', `op-model-${name}`);
      assert.equal(step.outcome, Outcome.ACTION_DENIED, `${name} must be denied to a model proposal`);
      assert.equal(step.authorization.decision, 'deny');
      assert.equal(step.execution.status, 'not_run', 'a denied request never reaches the ledger');
      assert.equal(app.registry.get(name).plannable, false, `${name} must never appear in a model plan`);
      const direct = await Promise.resolve(
        name === 'prediction.record'
          ? app.predictions.recordPrediction({ ...input, origin: 'model' })
          : name === 'prediction.evaluate'
            ? app.predictions.recordEvaluation({ ...input, origin: 'model' })
            : app.predictions.invalidatePrediction({ ...input, origin: 'model' }),
      ).then(() => null, (err) => err);
      assert.equal(direct?.code, 'WRITE_REQUIRES_USER_ORIGIN', `and the ledger refuses ${name} again on its own`);
    }

    assert.deepEqual(fs.readFileSync(path.join(dir, 'predictions.jsonl')), ledgerBytes, 'nothing was appended by any refused request');
    assert.equal(auditCount(dir), operationsBefore, 'a denied proposal is refused before an operation is opened for it');

    // Reads are the exception: a model-origin read sees exactly what a user-origin read sees.
    const asModel = await app.controller.runAction('prediction.list', { limit: 20 }, 'model', 'op-model-read');
    assert.equal(asModel.outcome, Outcome.SUCCESS_VERIFIED);
    assert.notEqual(app.registry.get('prediction.list').plannable, false, 'a read of the ledger is not withheld from a proposal that only reads it');
  });

  test('a prediction never becomes an experience, even with automatic capture on', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock, { experienceCapture: CAPTURE_VERIFIED_SUCCESS });
    const { experience } = await seedEvent(app, clock);
    const created = await app.controller.predictionRecord({
      ...recordFixture,
      evidence: { supportingExperienceIds: [experience.id] },
    });
    assert.equal(created.status, Outcome.SUCCESS_VERIFIED);
    const id = expectationsOf(dir)[0].id;
    assert.equal(created.operation.steps[0].verification.outcome, Outcome.SUCCESS_VERIFIED);

    await app.controller.predictionEvaluate({ target: id });
    await app.controller.predictionInvalidate({ target: id, reason: 'the condition it assumed no longer holds' });
    await app.controller.predictionList({ limit: 20 });

    const captured = experienceLogOf(dir).filter((record) => record.kind === EXPERIENCE_KIND && record.capture === 'captured_automatically');
    assert.deepEqual(captured.map((record) => record.subject), [], 'no prediction operation may reach the log that answers what happened');
    // The one experience in the log is the seeded event; a prediction operation cannot add to it.
    assert.equal(experienceLogOf(dir).filter((record) => record.kind === EXPERIENCE_KIND).length, 1);
  });
});

describe('a citation names exactly one recorded event', () => {
  test('a reference typed as a read prints it is stored as the whole id of the record it resolved to', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    const { operation, experience } = await seedEvent(app, clock);
    await seedFeedback(app, experience.id);
    const feedback = firstFeedback(dir);
    assert.ok(feedback, 'the fixture needs a real feedback record to cite');

    // Every read of this application prints an id as its first eight characters, and an experience is
    // also reachable by the operation it names; both spellings must land on one exact record.
    const res = await app.controller.predictionRecord({
      ...recordFixture,
      evidence: {
        supportingExperienceIds: [experience.id.slice(0, 8), shortId(operation.id)],
        feedbackIds: [shortId(feedback.id)],
      },
    });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    const stored = expectationsOf(dir)[0];
    assert.deepEqual(stored.evidence.supportingExperienceIds, [experience.id], 'two spellings of one experience stay one exact id');
    assert.deepEqual(stored.evidence.feedbackIds, [feedback.id]);
    assert.match(res.display, /Cited at creation: 1 supporting, 0 contradicting, 1 feedback/);

    // And the citation still resolves on the next read, which is the store's own postcondition: a
    // citation that could not be resolved is disclosed as unavailable rather than dropped.
    const shown = await app.controller.predictionShow({ target: stored.id });
    assert.equal(shown.status, Outcome.SUCCESS_VERIFIED);
    assert.match(shown.display, /Cited at creation: 1 supporting, 0 contradicting, 1 feedback/);
    assert.doesNotMatch(shown.display, /Unavailable:/);
    assert.match(shown.display, /Added after:/, 'the lineage read opens against the resolved record');
  });

  test('one record cannot be cited as both supporting and contradicting, even spelled two ways', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    const { experience } = await seedEvent(app, clock);

    const res = await app.controller.predictionRecord({
      ...recordFixture,
      evidence: {
        supportingExperienceIds: [experience.id],
        contradictingExperienceIds: [experience.id.slice(0, 8)],
      },
    });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /cannot be cited as both supporting and contradicting/);
    assert.equal(ledgerOf(dir).length, 0, 'the refusal happened before any byte was written');
  });

  test('a citation that names nothing fails closed and says which command prints the id to cite', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    const { experience } = await seedEvent(app, clock);

    const res = await app.controller.predictionRecord({
      ...recordFixture,
      evidence: { supportingExperienceIds: [experience.id], contradictingExperienceIds: ['deadbeef'] },
    });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /does not contain \[deadbeef\]/);
    assert.match(res.display, /experience list/);
    assert.equal(ledgerOf(dir).length, 0, 'a prediction cannot be stored on evidence that does not exist');
    assert.ok(res.operation, 'the refusal is itself audited');
    assert.equal(res.operation.steps[0].execution.status, 'failed');
  });

  test('a malformed citation is rejected as input, before the action runs', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);

    for (const value of ['nope-nope-nope', 'a'.repeat(7), 'not-a-uuid']) {
      const res = await app.controller.predictionRecord({
        ...recordFixture,
        evidence: { supportingExperienceIds: [value] },
      });
      assert.equal(res.status, Outcome.INPUT_REJECTED, `"${value}" must be rejected as an input, not as a store failure`);
      const step = res.operation.steps[0];
      assert.equal(step.execution.status, 'rejected', 'the action body never ran');
      assert.match(step.execution.error.message, /has an invalid id/);
      assert.match(step.execution.error.message, /at least 8 leading characters/);
      assert.equal(step.verification.outcome, 'not_run');
    }
    assert.equal(fs.existsSync(path.join(dir, 'predictions.jsonl')), false, 'a rejected input cannot create the ledger');
    assert.equal(ledgerOf(dir).length, 0);
  });

  test('a replacement named by the short id the duplicate refusal prints is stored as the full id', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    const { experience } = await seedEvent(app, clock);

    const first = await app.controller.predictionRecord({
      ...recordFixture,
      evidence: { supportingExperienceIds: [experience.id] },
    });
    assert.equal(first.status, Outcome.SUCCESS_VERIFIED);
    const originalId = expectationsOf(dir)[0].id;

    const duplicate = await app.controller.predictionRecord({
      ...recordFixture,
      evidence: { supportingExperienceIds: [experience.id] },
    });
    assert.equal(duplicate.status, Outcome.EXECUTION_FAILED);
    assert.match(duplicate.display, /already records this expectation/);
    assert.match(duplicate.display, /naming that record in replaces/);

    const corrected = await app.controller.predictionRecord({
      ...recordFixture,
      subject: 'the corrected expectation supersedes the first',
      evidence: { supportingExperienceIds: [experience.id] },
      replaces: [shortId(originalId)],
    });
    assert.equal(corrected.status, Outcome.SUCCESS_VERIFIED, 'the id a refusal printed must be citable by the same command');
    const stored = expectationsOf(dir).find((record) => (record.replaces ?? []).length > 0);
    assert.deepEqual(stored.replaces, [originalId], 'the ledger stores the resolved id, never the prefix');

    const lost = await app.controller.predictionRecord({ ...recordFixture, subject: 'nothing here matches', replaces: [shortId('ffffffff00000000000000000000ffff')] });
    assert.equal(lost.status, Outcome.EXECUTION_FAILED);
    assert.match(lost.display, /is not in the ledger/);
    assert.equal(expectationsOf(dir).length, 2, 'the refused replacement wrote nothing');
  });

  test('a superseded expectation stays auditable and the read says which one stands', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    const { experience } = await seedEvent(app, clock);
    const first = await app.controller.predictionRecord({ ...recordFixture, evidence: { supportingExperienceIds: [experience.id] } });
    const originalId = expectationsOf(dir)[0].id;
    const second = await app.controller.predictionRecord({
      ...recordFixture,
      subject: 'a later expectation replaces the first',
      evidence: { supportingExperienceIds: [experience.id] },
      replaces: [originalId],
    });
    assert.equal(second.status, Outcome.SUCCESS_VERIFIED);
    const secondId = expectationsOf(dir).find((record) => record.id !== originalId).id;

    const old = await app.controller.predictionShow({ target: originalId });
    assert.match(old.display, /superseded/i);
    assert.match(old.display, new RegExp(`Superseded by:\\s+${shortId(secondId)}`));
    assert.equal(expectationsOf(dir).length, 2, 'a superseded expectation is never rewritten or removed');

    const history = await app.controller.predictionHistory({ target: originalId });
    assert.match(history.display, /each line above is an appended record/);
  });
});

describe('the prediction command group through the command line', () => {
  test('record, list, show, history, evaluate and summary return exit 0 and print what the ledger holds', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    const { experience } = await seedEvent(app, clock);

    const recorded = await cli(app, dir, [
      'prediction', 'record',
      '--capability', 'calc.evaluate',
      '--expect', 'success',
      '--subject', 'the next calculation is reported as a verified success',
      '--in-days', '30',
      '--supports', shortId(experience.id),
    ]);
    assert.equal(recorded.code, 0, recorded.err);
    assert.match(recorded.out, /Audit: recorded in operations\.jsonl/);
    assert.match(recorded.out, /Evidence basis: cited/);
    const id = expectationsOf(dir)[0].id;

    const listed = await cli(app, dir, ['prediction', 'list']);
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, new RegExp(`\\[${shortId(id)}\\] calc\\.evaluate: expects success`));
    assert.match(listed.out, /confidence unavailable/);
    assert.match(listed.out, /not an observation/);

    // A filter that matches nothing is reported as an empty view of a populated ledger, never as an
    // error and never as an empty ledger: the seeded expectation has outcome evidence inside its
    // horizon, so it reads as awaiting an evaluation rather than as invalidated.
    const filtered = await cli(app, dir, ['prediction', 'list', '--status', 'invalidated']);
    assert.equal(filtered.code, 0, filtered.err);
    assert.match(filtered.out, /0 shown of 1 recorded/);
    assert.match(filtered.out, /An empty ledger is not a lost one\./);

    const shown = await cli(app, dir, ['prediction', 'show', shortId(id)]);
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /Horizon ends:/);

    // The seeded experience is a verified success inside the horizon, so the records do establish an
    // outcome and the verdict the command stores is the one the evidence decides - not a value the
    // caller supplied. The read-only case (no outcome evidence, nothing written) is the child-process
    // test below.
    const evaluated = await cli(app, dir, ['prediction', 'evaluate', shortId(id)]);
    assert.equal(evaluated.code, 0, evaluated.err);
    assert.match(evaluated.out, new RegExp(`Prediction \\[${shortId(id)}\\] evaluated as matched`));
    assert.match(evaluated.out, /this verdict changes no experience, adaptation, or authorization/);
    const verdicts = ledgerOf(dir).filter((record) => record.kind === EVALUATION_KIND);
    assert.equal(verdicts.length, 1, 'exactly one verdict was appended for this expectation');
    assert.equal(verdicts[0].predictionId, id);
    assert.equal(verdicts[0].verdict, 'matched');
    assert.deepEqual(verdicts[0].outcomeExperienceIds, [experience.id], 'the verdict names the record that established the outcome');

    const history = await cli(app, dir, ['prediction', 'history', shortId(id)]);
    assert.equal(history.code, 0, history.err);
    assert.match(history.out, /Prediction history/);

    const summary = await cli(app, dir, ['prediction', 'summary']);
    assert.equal(summary.code, 0, summary.err);
    assert.match(summary.out, /Prediction ledger/);
    assert.match(summary.out, /Denominator:/);
    assert.match(summary.out, /Confidence:\s+unavailable/);

    const health = await cli(app, dir, ['prediction', 'health']);
    assert.equal(health.code, 0, health.err);
    assert.match(health.out, /Prediction ledger health \(read-only/);
    assert.match(health.out, /Confidence:     none stored in any record/);
    assert.match(health.out, /an expired horizon is not a wrong prediction/);
  });

  test('a withdrawal keeps its reason, and the same expectation stays in the history', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    await seedEvent(app, clock);
    const recorded = await cli(app, dir, ['prediction', 'record', ...Object.entries({
      '--capability': 'calc.evaluate',
      '--expect': 'success',
      '--subject': 'an expectation the user will withdraw',
      '--in-days': '30',
    }).flat()]);
    assert.equal(recorded.code, 0, recorded.err);
    const id = expectationsOf(dir)[0].id;

    const noReason = await cli(app, dir, ['prediction', 'invalidate', shortId(id)]);
    assert.equal(noReason.code, 2, 'a withdrawal without a reason is a usage refusal, not a command that ran');
    assert.match(noReason.err, /usage: prediction invalidate <prediction-id> --reason <text>/);
    assert.equal(ledgerOf(dir).length, 1, 'the refusal wrote nothing');
    assert.equal(auditCount(dir), 2, 'and it cost no operation record either');

    const withdrawn = await cli(app, dir, ['prediction', 'invalidate', shortId(id), '--reason', 'the condition it assumed no longer holds']);
    assert.equal(withdrawn.code, 0, withdrawn.err);
    assert.match(withdrawn.out, /is withdrawn/);
    assert.match(withdrawn.out, new RegExp(`withdrawal ${shortId(ledgerOf(dir)[1].id)} in predictions\\.jsonl`));
    assert.equal(ledgerOf(dir).length, 2);
    assert.equal(ledgerOf(dir)[1].reason, 'the condition it assumed no longer holds');

    const stillThere = await cli(app, dir, ['prediction', 'show', shortId(id)]);
    assert.equal(stillThere.code, 0, stillThere.err);
    assert.match(stillThere.out, /Invalidated:/);
    assert.match(stillThere.out, /invalid|withdrawn/i);
  });

  test('a reference that names nothing prints the store\'s reason and the command that lists what exists', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    const { experience } = await seedEvent(app, clock);

    const missing = await cli(app, dir, [
      'prediction', 'record',
      '--capability', 'calc.evaluate', '--expect', 'success',
      '--subject', 'an expectation on evidence that does not exist',
      '--in-days', '30', '--supports', 'deadbeef',
    ]);
    assert.equal(missing.code, 1, missing.err);
    assert.match(missing.out, /execution failed/);
    assert.match(missing.out, /does not contain \[deadbeef\]/);
    assert.match(missing.out, /"experience list" prints the id to cite/);
    assert.match(missing.out, /Audit: recorded in operations\.jsonl/, 'a refused write is still audited');
    assert.equal(fs.existsSync(path.join(dir, 'predictions.jsonl')), false, 'and nothing reached the ledger');

    const malformed = await cli(app, dir, [
      'prediction', 'record',
      '--capability', 'calc.evaluate', '--expect', 'success',
      '--subject', 'an expectation on an id that is not an id',
      '--in-days', '30', '--supports', 'nope-nope-nope',
    ]);
    assert.equal(malformed.code, 1, malformed.err);
    assert.match(malformed.out, /input rejected: supportingExperienceIds has an invalid id/);
    assert.match(malformed.out, /at least 8 leading characters/);
    // The two refusals differ in the one way the user can act on: one input never reached the
    // action, the other did and was refused by the ledger itself.
    assert.match(missing.out, /execution failed/);
    assert.match(malformed.out, /input rejected/);
    assert.doesNotMatch(malformed.out, /execution failed/);
    assert.equal(ledgerOf(dir).length, 0);

    const unknownTarget = await cli(app, dir, ['prediction', 'show', shortId(experience.id)]);
    assert.equal(unknownTarget.code, 0, 'a read that confirms absence succeeded as a read');
    assert.match(unknownTarget.out, /No recorded prediction matches/);
    assert.match(unknownTarget.out, /APEX makes no predictions of its own/);
  });

  test('usage refusals cost no audit record and no ledger line', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    await seedEvent(app, clock);
    const operations = auditCount(dir);

    const cases = [
      { argv: ['prediction', 'record', '--capability', 'calc.evaluate', '--expect', 'success', '--subject', 'x', '--nope', '1'], reason: /unknown option --nope/ },
      { argv: ['prediction', 'record', '--capability', 'calc.evaluate', '--expect', 'success', '--subject', 'x'], reason: /needs a horizon/ },
      { argv: ['prediction', 'record', '--capability', 'calc.evaluate', '--expect', 'success', '--subject', 'x', '--in-days', '3', '--expires', '2026-12-01T00:00:00.000Z'], reason: /either as --expires or as --in-days/ },
      { argv: ['prediction', 'record', '--capability', 'calc.evaluate', '--expect', 'success', '--subject', 'x', '--in-days', 'soon'], reason: /--in-days needs a whole number/ },
      { argv: ['prediction', 'record', '--capability', 'calc.evaluate', '--subject', 'x', '--in-days', '3'], reason: /usage: prediction record/ },
      { argv: ['prediction', 'list', 'stray'], reason: /usage: prediction list/ },
      { argv: ['prediction', 'show'], reason: /usage: prediction show <prediction-id>/ },
      { argv: ['prediction', 'health', 'extra'], reason: /usage: prediction health/ },
      { argv: ['prediction', 'summary', '--limit', 'many'], reason: /--limit needs a whole number/ },
      { argv: ['prediction', 'nonsense'], reason: /usage: prediction record\|list\|show\|history\|evaluate\|invalidate\|summary\|health/ },
    ];
    for (const { argv, reason } of cases) {
      const res = await cli(app, dir, argv);
      assert.equal(res.code, 2, `${argv.join(' ')} must be a usage refusal: ${res.out}${res.err}`);
      assert.match(res.err, reason, argv.join(' '));
    }
    assert.equal(auditCount(dir), operations, 'a command that was never understood leaves no operation record');
    assert.equal(fs.existsSync(path.join(dir, 'predictions.jsonl')), false, 'and it leaves no ledger');
  });

  test('the whole path runs in a real child process and stores the exact ids it resolved', async () => {
    const dir = tempDir();
    const env = envFor(dir);

    const asked = await runCli(['ask', 'calc 6*7'], env);
    assert.equal(asked.code, 0, asked.stderr);
    // `ask` prints an audited operation by its full id; the record reads print the eight characters
    // `prediction record` accepts, so the two spellings are both exercised below.
    const operationId = asked.stdout.match(/operations\.jsonl \(([0-9a-f-]{36})\)/)?.[1];
    assert.ok(operationId, `expected an audit id in:\n${asked.stdout}`);

    const experienced = await runCli(['experience', 'record', operationId, '--subject', 'evaluated 6*7'], env);
    assert.equal(experienced.code, 0, experienced.stderr);
    const experienceLine = experienceLogOf(dir).find((record) => record.kind === EXPERIENCE_KIND);
    assert.ok(experienceLine, 'the experience the user recorded is in the log');

    // Cited with the eight characters `experience list` prints, and with the operation id that read
    // names; the ledger must hold neither spelling.
    const recorded = await runCli([
      'prediction', 'record',
      '--capability', 'calc.evaluate', '--expect', 'success',
      '--subject', 'the next calculation reports a verified success',
      '--in-days', '30',
      '--supports', shortId(experienceLine.id),
    ], env);
    assert.equal(recorded.code, 0, recorded.stderr);
    assert.match(recorded.stdout, /Evidence basis: cited/);
    const prediction = expectationsOf(dir)[0];
    assert.deepEqual(prediction.evidence.supportingExperienceIds, [experienceLine.id], 'the child process stored the resolved id');

    const listed = await runCli(['prediction', 'list'], env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`\\[${shortId(prediction.id)}\\]`));

    const evaluated = await runCli(['prediction', 'evaluate', shortId(prediction.id)], env);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    const verdicts = ledgerOf(dir).filter((record) => record.kind !== PREDICTION_KIND);
    if (/was not evaluated/.test(evaluated.stdout)) {
      assert.equal(verdicts.length, 0, 'a report of no verdict must be matched by the bytes');
    } else {
      assert.equal(verdicts.length, 1);
      assert.match(evaluated.stdout, new RegExp(`evaluated as ${verdicts[0].verdict}`));
    }

    const health = await runCli(['prediction', 'health'], env);
    assert.equal(health.code, 0, health.stderr);
    assert.match(health.stdout, /fully inspected|empty \(no expectations recorded\)/);
  });
});

describe('the read-only operational surface reports the ledger', () => {
  test('status distinguishes an absent ledger from a populated one, and diagnose reports its counts', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);

    const before = await cli(app, dir, ['status']);
    assert.equal(before.code, 0, before.err);
    assert.match(before.out, /Predictions: 0 expectation\(s\) recorded, 0 standing, 0 evaluated against recorded outcomes/);
    assert.doesNotMatch(before.out, /Expectations the user recorded, not observations/, 'nothing is explained about records that do not exist');

    const diagBefore = await collectDiagnostics(app);
    assert.equal(diagBefore.subsystems.predictions.state, State.MISSING);
    assert.match(diagBefore.subsystems.predictions.summary, /^Predictions: missing \(valid: no expectation recorded yet\)$/);
    assert.ok('prediction' in diagBefore.locks, 'the ledger has its own write lock in the lock report');

    const { experience } = await seedEvent(app, clock);
    const created = await app.controller.predictionRecord({ ...recordFixture, evidence: { supportingExperienceIds: [experience.id] } });
    assert.equal(created.status, Outcome.SUCCESS_VERIFIED);

    const after = await cli(app, dir, ['status']);
    assert.equal(after.code, 0, after.err);
    assert.match(after.out, /Predictions: 1 expectation\(s\) recorded, 1 standing, 0 evaluated against recorded outcomes/);
    assert.match(after.out, /Expectations the user recorded, not observations/);

    const diag = await collectDiagnostics(app);
    const predictions = diag.subsystems.predictions;
    assert.equal(predictions.state, State.OK);
    assert.match(predictions.summary, /Predictions: ok \(1 expectation\(s\), 1 standing, 0 superseded, 0 withdrawal\(s\), 0 verdict\(s\); no confidence is stored in any record\)/);
    assert.match(predictions.note, /an expectation, not an observation/);
    assert.equal(predictions.anomalies.count, 0);
    assert.ok(renderDiagnostics(diag).split('\n').some((line) => /^ {2}Predictions: ok/.test(line)), 'the rendered report carries the ledger line');
  });

  test('a damaged ledger is reported as damaged, never as empty, and the repair command is not offered', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    await seedEvent(app, clock);
    const created = await app.controller.predictionRecord(recordFixture);
    assert.equal(created.status, Outcome.SUCCESS_VERIFIED);
    const bytes = fs.readFileSync(path.join(dir, 'predictions.jsonl'));

    fs.appendFileSync(path.join(dir, 'predictions.jsonl'), 'this line is not json\n');

    const diag = await collectDiagnostics(app);
    assert.equal(diag.subsystems.predictions.state, State.CORRUPT);
    assert.match(diag.subsystems.predictions.summary, /corrupt \(1 readable line\(s\), 1 corrupt line\(s\)/);
    assert.ok(diag.subsystems.predictions.problems.some((p) => /predictions\.jsonl/.test(p)));
    assert.ok(unchecked(diag), 'the unreadable counts reach the report the exit code carries');
    const recovery = diag.recovery.join('\n');
    assert.match(recovery, /Predictions: no supported repair command exists/);
    assert.match(recovery, /do not append to it by hand/);
    assert.doesNotMatch(recovery, /delete predictions/);

    const health = await cli(app, dir, ['prediction', 'health']);
    assert.equal(health.code, 1, 'a damaged ledger is attention, not a clean read');
    assert.match(health.out, /damaged - 1 corrupt line/);
    assert.match(health.out, /the bytes are preserved/i);

    const blocked = await cli(app, dir, ['prediction', 'record', '--capability', 'calc.evaluate', '--expect', 'success', '--subject', 'anything at all', '--in-days', '3']);
    assert.notEqual(blocked.code, 0, 'a write to a damaged ledger is refused rather than appended to the damage');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'predictions.jsonl')).subarray(0, bytes.length), bytes, 'the readable lines were not rewritten');
  });

  test('repair locks names the prediction lock alongside the others', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);

    const res = await cli(app, dir, ['repair', 'locks']);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /Prediction lock: no lock file; nothing to recover/);
    for (const label of ['Task lock', 'Summary queue lock', 'Memory lock', 'Knowledge lock', 'Experience lock']) {
      assert.match(res.out, new RegExp(`^${label}:`, 'm'), `${label} must still be reported`);
    }
  });
});

function unchecked(diag) {
  return diag.integrity.unchecked.some((line) => /prediction/i.test(line));
}
