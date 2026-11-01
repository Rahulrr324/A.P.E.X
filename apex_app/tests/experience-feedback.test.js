// Batch Z: explicit user feedback on recorded experiences.
//
// These tests pin the eight assessments the user can state, the rule that feedback must reference an
// identifiable experience, user-origin-only writes at both the registry and the store, append-only
// correction history (including contradictory feedback), secret refusal at the write boundary, and the
// independent verification of a feedback write. Fixtures are deterministic; nothing here runs or
// emulates model inference, and no test claims anything about a real model.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import {
  ASSESSMENTS,
  MAX_REASON_CHARS,
  MAX_RULE_CHARS,
  evidenceFromOperation,
  evidenceSha,
} from '../src/experience/experience-store.js';
import { CORRECTIVE_ASSESSMENTS } from '../src/experience/derivation.js';
import { Outcome } from '../src/outcomes.js';

const CLOCK = () => new Date('2026-11-01T09:00:00.000Z');
const dirs = [];

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop());
});

// An experience recorded through the real write path, so a feedback target below is an experience the
// application produced rather than a fixture that merely looks like one.
async function experienceViaController(app, request) {
  const op = (await app.controller.handle(request, { origin: 'user' })).operation;
  const res = await app.controller.experienceRecord({ operationId: op.id, subject: 'what APEX did here' });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
  return { op, id: (await app.experience.list({ limit: 1 }))[0].id };
}

function fileLines(app) {
  if (!fs.existsSync(app.experience.filePath)) return [];
  return fs.readFileSync(app.experience.filePath, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

function snapshot(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out[entry.name] = entry.isDirectory() ? '<dir>' : fs.readFileSync(full).toString('base64');
  }
  return out;
}

// A record shaped exactly like the ones the store writes, for the case one process cannot produce
// through its own API: two experiences whose ids share a prefix. The evidence is canonical and
// hashed, so the store reads it as a valid record rather than damage.
function experienceRecord({ id, operationId, capability = 'memory.add' }) {
  const at = CLOCK().toISOString();
  const evidence = evidenceFromOperation({
    capability,
    origin: 'user',
    status: Outcome.SUCCESS_VERIFIED,
    decision: 'answer',
    requestedAt: at,
    finishedAt: at,
    steps: [],
  });
  return {
    schema: 1,
    kind: 'experience',
    id,
    operationId,
    capability,
    subject: 'an experience written by another process',
    outcome: evidence.status,
    decision: evidence.decision,
    origin: evidence.origin,
    requestedAt: evidence.requestedAt,
    finishedAt: evidence.finishedAt,
    evidence,
    evidenceSha256: evidenceSha(evidence),
    adaptationEligible: true,
    createdAt: at,
    provenance: { origin: 'user_recorded', updateMode: 'user_confirmed' },
  };
}

function appendRecords(app, records) {
  fs.appendFileSync(app.experience.filePath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

describe('A. the eight assessments a user can state about one event', () => {
  test('every assessment in the vocabulary can be recorded and stays readable', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that the deploy window is nightly');

    for (const assessment of ASSESSMENTS) {
      const res = await app.controller.feedbackRecord({
        target: id, assessment, guidance: `guidance for ${assessment}`, reason: `why ${assessment}`,
      });
      assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
      assert.match(res.display, /Recorded your feedback/);
      const corrective = CORRECTIVE_ASSESSMENTS.includes(assessment);
      assert.match(
        res.display,
        corrective ? /corrective: it can support a candidate adaptation/ : /not corrective/,
        `${assessment} corrective labelling`,
      );
    }

    const view = await app.experience.feedbackFor(id);
    assert.equal(view.current.length, ASSESSMENTS.length);
    assert.deepEqual([...new Set(view.current.map((f) => f.assessment))].sort(), [...ASSESSMENTS].sort());
    for (const entry of view.current) {
      assert.deepEqual(entry.provenance, { origin: 'user_feedback', updateMode: 'user_confirmed' });
    }
    // `current` holds only uncorrected records; the correction flag lives on the full history.
    assert.equal(view.history.length, ASSESSMENTS.length);
    assert.equal(view.history.filter((f) => f.superseded).length, 0);
    assert.equal((await app.experience.health()).feedback, ASSESSMENTS.length);
  });

  test('an assessment outside the vocabulary is refused at both layers', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that only eight assessments exist');
    const before = fileLines(app).length;

    for (const bad of ['wrong', 'mostly_right', 'helpful', '', '  ', 42, null, undefined]) {
      await assert.rejects(
        app.experience.recordFeedback({ target: id, assessment: bad, origin: 'user' }),
        /assessment must be one of/,
        `${JSON.stringify(bad)} is not an assessment`,
      );
      const step = await app.controller.runAction('feedback.record', { target: id, assessment: bad }, 'user', 'op-validate-1');
      assert.equal(step.outcome, Outcome.INPUT_REJECTED, `${JSON.stringify(bad)} must be refused as input`);
      assert.match(step.summary, /assessment must be one of: correct, incorrect, partially_correct, useful, not_useful, user_correction, outcome_succeeded, outcome_failed/);
    }
    assert.equal(fileLines(app).length, before, 'a refused assessment appended nothing');
  });

  test('silence is not an assessment', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that nobody said anything yet');
    const view = await app.experience.feedbackFor(id);
    assert.deepEqual(view.current, []);
    assert.deepEqual(view.history, []);
    assert.equal(view.truncated, false);
    assert.equal(view.experience.assessments.length, 0);
    assert.equal(view.experience.feedbackCount, 0);
    const show = await app.controller.experienceShow({ target: id });
    assert.match(show.display, /feedback: none recorded; silence is never an assessment/);
    assert.equal((await app.experience.health()).attention, false);
  });

  test('guidance and reason over their bound are refused before they are stored', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that guidance has a length bound');
    const before = fileLines(app).length;

    await assert.rejects(
      app.experience.recordFeedback({ target: id, assessment: 'incorrect', guidance: 'x'.repeat(MAX_RULE_CHARS + 1), origin: 'user' }),
      new RegExp(`guidance exceeds ${MAX_RULE_CHARS} characters`),
    );
    await assert.rejects(
      app.experience.recordFeedback({ target: id, assessment: 'incorrect', reason: 'y'.repeat(MAX_REASON_CHARS + 1), origin: 'user' }),
      new RegExp(`reason exceeds ${MAX_REASON_CHARS} characters`),
    );
    assert.equal(fileLines(app).length, before);
  });

  test('blank and control-character text is handled at the write boundary', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that feedback text is checked');

    const blank = await app.experience.recordFeedback({ target: id, assessment: 'useful', guidance: '   ', reason: '', origin: 'user' });
    assert.equal(blank.record.guidance, undefined, 'blank guidance is absent, not an empty string');
    assert.equal(blank.record.reason, undefined);

    const BELL = String.fromCharCode(7);
    await assert.rejects(
      app.experience.recordFeedback({ target: id, assessment: 'useful', guidance: `answer${BELL}now`, origin: 'user' }),
      /guidance contains control characters/,
    );

    // The action layer is stricter than the store: an all-blank guidance string is a typo the user
    // should hear about rather than a silently absent field.
    const step = await app.controller.runAction(
      'feedback.record',
      { target: id, assessment: 'useful', guidance: '   ' },
      'user',
      'op-blank-1',
    );
    assert.equal(step.outcome, Outcome.INPUT_REJECTED);
    assert.match(step.summary, /guidance is empty/);
  });

  test('credential-like feedback text is refused before it reaches the log', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that credentials stay out of the log');
    const before = snapshot(app.dataDir);
    const secret = `rotate the key sk-${'a'.repeat(24)}`;

    const err = await app.experience
      .recordFeedback({ target: id, assessment: 'incorrect', guidance: secret, origin: 'user' })
      .then(() => null, (e) => e);
    assert.equal(err.code, 'SECRET_REFUSED');
    assert.match(err.message, /guidance looks like a password, key, or token; it was not stored/);

    const byTarget = await app.experience
      .recordFeedback({ target: secret, assessment: 'incorrect', origin: 'user' })
      .then(() => null, (e) => e);
    assert.equal(byTarget.code, 'SECRET_REFUSED');
    assert.match(byTarget.message, /the feedback target looks like a password, key, or token; it was not used/);

    assert.deepEqual(snapshot(app.dataDir), before, 'a refused secret left nothing behind');
    assert.ok(!fs.readFileSync(app.experience.filePath, 'utf8').includes('sk-'));
  });
});

describe('B. feedback must land on an experience the user can point at', () => {
  test('an audited operation with no recorded experience names the next step', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const op = (await app.controller.handle('remember that this event has no experience yet', { origin: 'user' })).operation;
    assert.equal((await app.experience.list()).length, 0);

    await assert.rejects(
      app.experience.recordFeedback({ target: op.id, assessment: 'incorrect', origin: 'user' }),
      /is in the audit log but has no recorded experience; record the experience first/,
    );
    // A reference that is neither an experience nor an audited operation has no next step to name.
    await assert.rejects(
      app.experience.recordFeedback({ target: 'ffffffffffffffff', assessment: 'incorrect', origin: 'user' }),
      /feedback target not found; it must be a recorded experience or an operation that has one/,
    );
  });

  test('a reference that matches two experiences is refused rather than guessed', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    await experienceViaController(app, 'remember that the first of two similar ids');
    appendRecords(app, [
      experienceRecord({ id: '00000000-1000-4000-8000-000000000001', operationId: 'op-shared-1' }),
      experienceRecord({ id: '00000000-2000-4000-8000-000000000002', operationId: 'op-shared-2' }),
    ]);

    await assert.rejects(
      app.experience.recordFeedback({ target: '00000000', assessment: 'incorrect', origin: 'user' }),
      /the feedback target is ambiguous; use a longer id prefix/,
    );
    await assert.rejects(
      app.experience.feedbackFor('00000000'),
      /the feedback view target is ambiguous; use a longer id prefix/,
    );
    // A longer prefix resolves to exactly one of them, so the refusal is about the reference only.
    const view = await app.experience.feedbackFor('00000000-2000');
    assert.equal(view.experience.id, '00000000-2000-4000-8000-000000000002');
  });

  test('feedback on a corrected experience is sent to the record that replaced it', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const op = (await app.controller.handle('remember that the meeting was Tuesday', { origin: 'user' })).operation;
    const first = await app.experience.recordExperience({ operationId: op.id, subject: 'first reading', origin: 'user' });
    const second = await app.experience.recordExperience({
      operationId: op.id, subject: 'corrected reading', replaces: [first.record.id], origin: 'user',
    });

    await assert.rejects(
      app.experience.recordFeedback({ target: first.record.id, assessment: 'incorrect', origin: 'user' }),
      /was corrected by a later record; give feedback on the record that replaced it/,
    );
    await assert.rejects(
      app.experience.recordFeedback({ target: first.record.id.slice(0, 12), assessment: 'incorrect', origin: 'user' }),
      /the feedback target is an experience that a later record corrected; give feedback on the record that replaced it/,
    );

    const onLive = await app.experience.recordFeedback({
      target: second.record.id, assessment: 'incorrect', guidance: 'check the calendar first', origin: 'user',
    });
    assert.equal(onLive.experience.id, second.record.id);
    assert.equal((await app.experience.feedbackFor(first.record.id)).current.length, 0);
  });

  test('a model cannot say what the user thought, at the registry or in a plan', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that only the user can assess this');
    const before = fileLines(app).length;

    const writes = [
      ['experience.record', { operationId: 'op-1', subject: 'the model own account' }],
      ['feedback.record', { target: id, assessment: 'correct' }],
      ['adaptation.derive', {}],
      ['adaptation.decide', { target: 'aaaaaaaa', decision: 'approved' }],
      ['adaptation.retire', { target: 'aaaaaaaa', reason: 'none' }],
    ];
    for (const [name, input] of writes) {
      const step = await app.controller.runAction(name, input, 'model', 'op-model-1');
      assert.equal(step.outcome, Outcome.ACTION_DENIED, `${name} must be denied for a model origin`);
      assert.equal(step.execution.status, 'not_run', `${name} must not reach the store`);
      assert.equal(step.authorization.decision, 'deny');
      assert.equal(app.registry.get(name).plannable, false, `${name} must never enter a plan`);
      assert.equal(app.registry.authorize(name, 'user').decision, 'allow', `${name} stays available to the user`);
    }
    assert.equal(fileLines(app).length, before, 'a denied write appended nothing');

    // The store refuses the same request again, so a caller that bypassed the registry gains nothing.
    await assert.rejects(
      app.experience.recordFeedback({ target: id, assessment: 'correct', origin: 'model' }),
      /requires an authorized user-origin operation/,
    );
  });
});

describe('C. history is preserved and a correction is a new record', () => {
  test('a correction names what it supersedes and leaves it readable', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that the report needs one page');
    const first = await app.experience.recordFeedback({
      target: id, assessment: 'not_useful', guidance: 'answer in three lines', reason: 'too long', origin: 'user',
    });
    const second = await app.experience.recordFeedback({
      target: id, assessment: 'not_useful', guidance: 'answer in one line', supersedes: [first.record.id], origin: 'user',
    });

    assert.deepEqual(second.supersededIds, [first.record.id]);
    assert.deepEqual(second.record.supersedes, [first.record.id]);
    const view = await app.experience.feedbackFor(id);
    assert.deepEqual(view.current.map((f) => f.id), [second.record.id]);
    assert.equal(view.history.length, 2, 'the earlier words stay in the history');
    assert.equal(view.history[0].superseded, true);
    assert.equal(view.history[0].guidance, 'answer in three lines');
    assert.equal(view.history[1].superseded, false);
    assert.equal(view.truncated, false);

    const lines = fileLines(app);
    assert.ok(lines.some((l) => l.includes(first.record.id)), 'the superseded line was not rewritten or deleted');
    const health = await app.experience.health();
    assert.equal(health.feedback, 2);
    assert.equal(health.currentFeedback, 1);
    assert.equal(health.supersededFeedback, 1);
    assert.equal(health.attention, false);
  });

  test('contradictory feedback stays visible instead of one winning', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that the user disagreed with themselves');
    await app.experience.recordFeedback({ target: id, assessment: 'correct', reason: 'this was right', origin: 'user' });
    await app.experience.recordFeedback({ target: id, assessment: 'incorrect', reason: 'actually it was not', origin: 'user' });

    const view = await app.experience.feedbackFor(id);
    assert.deepEqual(view.current.map((f) => f.assessment), ['correct', 'incorrect']);
    assert.deepEqual(view.experience.assessments, ['correct', 'incorrect']);
    assert.equal(view.experience.feedbackCount, 2);
    assert.equal((await app.experience.health()).attention, false, 'disagreement in feedback is history, not damage');
  });

  test('a correction chain retires every earlier link', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that the guidance was revised twice');
    const a = await app.experience.recordFeedback({ target: id, assessment: 'incorrect', guidance: 'version one', origin: 'user' });
    const b = await app.experience.recordFeedback({ target: id, assessment: 'incorrect', guidance: 'version two', supersedes: [a.record.id], origin: 'user' });
    await app.experience.recordFeedback({ target: id, assessment: 'incorrect', guidance: 'version three', supersedes: [b.record.id], origin: 'user' });

    const view = await app.experience.feedbackFor(id);
    assert.equal(view.current.length, 1);
    assert.equal(view.current[0].guidance, 'version three');
    assert.equal(view.history.length, 3);
    assert.deepEqual(view.history.map((f) => f.superseded), [true, true, false]);
    assert.equal((await app.experience.health()).supersededFeedback, 2);
  });

  test('a superseding reference is checked against the experience it belongs to', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const one = await experienceViaController(app, 'remember that the first event happened');
    const two = await experienceViaController(app, 'remember that the second event happened');
    const before = fileLines(app).length;

    const foreign = await app.experience.recordFeedback({ target: one.id, assessment: 'incorrect', guidance: 'first words', origin: 'user' });
    await assert.rejects(
      app.experience.recordFeedback({ target: two.id, assessment: 'incorrect', supersedes: [foreign.record.id], origin: 'user' }),
      /is about a different experience; only feedback on the same experience can be corrected/,
    );
    await assert.rejects(
      app.experience.recordFeedback({
        target: '00000000-0000-4000-8000-000000000055', assessment: 'incorrect', supersedes: [foreign.record.id], origin: 'user',
      }),
      /feedback target not found/,
    );
    await assert.rejects(
      app.experience.recordFeedback({ target: one.id, assessment: 'incorrect', supersedes: ['00000000-0000-4000-8000-000000000056'], origin: 'user' }),
      /a superseded feedback record was not found/,
    );

    const correction = await app.experience.recordFeedback({
      target: one.id, assessment: 'incorrect', guidance: 'second words', supersedes: [foreign.record.id], origin: 'user',
    });
    assert.deepEqual(correction.supersededIds, [foreign.record.id]);
    await assert.rejects(
      app.experience.recordFeedback({ target: one.id, assessment: 'incorrect', supersedes: [foreign.record.id], origin: 'user' }),
      /has already been corrected by a later record/,
    );
    assert.equal(fileLines(app).length, before + 2, 'only the two accepted feedback records were appended');
  });

  test('the history view is bounded and says when it cut', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that feedback accumulates');
    for (let i = 0; i < 6; i += 1) {
      await app.experience.recordFeedback({ target: id, assessment: 'useful', reason: `note ${i + 1}`, origin: 'user' });
    }
    const view = await app.experience.feedbackFor(id, { limit: 2 });
    assert.equal(view.history.length, 2);
    assert.equal(view.truncated, true);
    assert.deepEqual(view.current.map((f) => f.reason), ['note 5', 'note 6']);
    const wide = await app.experience.feedbackFor(id, { limit: 20 });
    assert.equal(wide.history.length, 6);
    assert.equal(wide.truncated, false);
  });
});

describe('D. provenance, verification, and what feedback does not do', () => {
  test('recorded feedback names the operation that recorded it and is verified by a second read', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that feedback is auditable');
    const res = await app.controller.feedbackRecord({ target: id, assessment: 'partially_correct', guidance: 'keep the total' });

    const step = res.operation.steps[0];
    assert.equal(step.action, 'feedback.record');
    assert.equal(step.origin, 'user');
    assert.equal(step.authorization.decision, 'allow');
    assert.equal(step.execution.status, 'ok');
    assert.equal(step.verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.match(step.verification.detail, /feedback present as the user's own/);
    assert.equal(res.operation.capability, 'feedback.record');

    const view = await app.experience.feedbackFor(id);
    assert.equal(view.current.at(-1).operationId, res.operation.id);
  });

  test('a feedback line whose provenance was rewritten is reported as damage', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that provenance is not optional');
    const forged = {
      schema: 1,
      kind: 'feedback',
      id: '00000000-0000-4000-8000-000000000060',
      experienceId: id,
      assessment: 'correct',
      createdAt: CLOCK().toISOString(),
      provenance: { origin: 'model_output', updateMode: 'candidate_unapproved' },
    };
    appendRecords(app, [forged]);

    const health = await app.experience.health();
    assert.equal(health.corruptLines, 1);
    assert.match(health.corrupt[0].reason, /provenance origin must be user_feedback/);
  });

  test('a damaged experience store is not reported as a missing target', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that a damaged log says so');
    fs.appendFileSync(path.join(dir, 'experiences.jsonl'), '{oops\n');

    const res = await app.controller.feedbackRecord({ target: id, assessment: 'correct' });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display ?? res.output, /corrupt line/);
    assert.ok(!/target not found/.test(res.display ?? ''), 'damage is not reported as absence');

    const audit = await app.operations.findById(res.operation.id);
    assert.equal(audit.found, true, 'the refused command is itself audited');
    assert.equal(audit.record.steps[0].execution.status, 'failed');
  });

  test('feedback on its own changes nothing about future answers', async () => {
    const app = createApp({ dataDir: tempDir(), now: CLOCK });
    const { id } = await experienceViaController(app, 'remember that a complaint is not a rule');
    const res = await app.controller.feedbackRecord({ target: id, assessment: 'incorrect', guidance: 'always give the date' });
    assert.match(res.display, /Recording feedback changes nothing about your future requests/);

    assert.equal((await app.experience.adaptations()).length, 0, 'no candidate exists until it is derived');
    assert.deepEqual((await app.experience.activeAdaptations({ query: 'always give the date' })).adaptations, []);
    const health = await app.experience.health();
    assert.equal(health.activeAdaptations, 0);
    assert.equal(health.pending.derivableCandidates, 0, 'one experience is not yet repeated evidence');
  });
});
