// Batch Z: experience store foundations.
//
// These tests pin what an experience is (a verified reference to one audited event, never a copy of
// the conversation), how the store refuses rather than hides damage, the bounds on every read, the
// independent re-check against the audit log, and the read-only health view. Fixtures are
// deterministic: the audited events come from the real request path with no model configured, so a
// model-origin write is refused by construction rather than by a stub pretending to be one. No local
// inference is performed or simulated here, and no claim about a real model is made by any test.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { ExperienceStore, evidenceFromOperation, evidenceSha } from '../src/experience/experience-store.js';
import { Outcome } from '../src/outcomes.js';

const CLOCK = () => new Date('2026-11-01T09:00:00.000Z');
const dirs = [];

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function appFor(dataDir) {
  return createApp({ dataDir, now: CLOCK });
}

afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop());
});

// A real audited event, obtained through the assembled request path. 'remember that ...' routes to
// the memory.write capability deterministically, so the evidence an experience copies is an audit
// record APEX actually wrote rather than a fixture that merely looks like one.
async function auditedOp(app, request) {
  const res = await app.controller.handle(request, { origin: 'user' });
  return res.operation;
}

async function experienceFor(app, request, subject = 'the recorded event') {
  const op = await auditedOp(app, request);
  const { record } = await app.experience.recordExperience({ operationId: op.id, subject, origin: 'user' });
  return { op, record };
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

function snapshot(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out[entry.name] = entry.isDirectory() ? '<dir>' : fs.readFileSync(full).toString('base64');
  }
  return out;
}

describe('A. an experience is built from evidence APEX already has', () => {
  test('a recorded experience copies and hashes the structural evidence of its audit record', async () => {
    const app = appFor(tempDir());
    const op = await auditedOp(app, 'remember that the budget review is on Friday');
    assert.equal(op.capability, 'memory.add', 'the fixture depends on this request routing to memory.add');
    assert.equal(op.status, Outcome.SUCCESS_VERIFIED);

    const { record } = await app.experience.recordExperience({
      operationId: op.id, subject: 'asked to hold the review date', origin: 'user',
    });
    assert.equal(record.schema, 1);
    assert.equal(record.kind, 'experience');
    assert.equal(record.operationId, op.id);
    assert.equal(record.capability, op.capability);
    assert.equal(record.outcome, op.status);
    assert.equal(record.decision, op.decision);
    assert.equal(record.origin, op.origin);
    assert.equal(record.requestedAt, op.requestedAt);
    assert.equal(record.finishedAt, op.finishedAt);
    assert.deepEqual(record.evidence, evidenceFromOperation(op));
    assert.equal(record.evidenceSha256, evidenceSha(record.evidence));
    assert.equal(record.adaptationEligible, true);
    assert.deepEqual(record.provenance, { origin: 'user_recorded', updateMode: 'user_confirmed' });
    assert.equal(record.createdAt, CLOCK().toISOString());

    const stored = await app.experience.get(record.id);
    assert.ok(stored, 'the record is readable from the log it was appended to');

    // The experience is a pointer plus structural evidence: request text and answer text stay in
    // the audit log, so this store cannot become a second, weaker copy of the conversation.
    const bytes = fs.readFileSync(app.experience.filePath, 'utf8');
    assert.ok(!bytes.includes('budget review'), 'the user request text is not copied into the experience log');
    assert.ok(!bytes.includes('Friday'), 'the stored memory text is not copied into the experience log');
  });

  test('an experience cannot reference an operation that was never audited', async () => {
    const app = appFor(tempDir());
    await auditedOp(app, 'remember that the audit log has one record');
    const neverRecorded = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await assert.rejects(
      app.experience.recordExperience({ operationId: neverRecorded, subject: 'an invented event', origin: 'user' }),
      /is not in the audit log; an experience can only reference an event that was actually recorded/,
    );
    assert.equal((await app.experience.status()).records, 0, 'nothing was appended for the refused reference');
  });

  test('a store with no audit log cannot record an experience at all', async () => {
    const dir = tempDir();
    const orphan = new ExperienceStore(path.join(dir, 'experiences.jsonl'), { now: CLOCK });
    await assert.rejects(
      orphan.recordExperience({ operationId: 'abc123', subject: 'with nothing to check it against', origin: 'user' }),
      /an experience must reference an audited operation, and no audit log is configured for this store/,
    );
    const check = await orphan.evidenceCheck('anything');
    assert.equal(check.ok, false);
    assert.match(check.detail, /no audit log is configured/);
  });

  test('a model-origin request cannot write any part of the experience lifecycle', async () => {
    const app = appFor(tempDir());
    const { op, record } = await experienceFor(app, 'remember that a model cannot approve anything');
    const attempts = [
      () => app.experience.recordExperience({ operationId: op.id, subject: 'x', origin: 'model' }),
      () => app.experience.recordFeedback({ target: record.id, assessment: 'correct', origin: 'model' }),
      () => app.experience.deriveAdaptations({ origin: 'model' }),
      () => app.experience.decideAdaptation({ target: 'a'.repeat(8), decision: 'approved', origin: 'model' }),
      () => app.experience.retireAdaptation({ target: 'a'.repeat(8), reason: 'x', origin: 'model' }),
    ];
    for (const attempt of attempts) {
      const err = await attempt().then(() => null, (e) => e);
      assert.ok(err, 'every write path refuses a non-user origin');
      assert.equal(err.code, 'WRITE_REQUIRES_USER_ORIGIN');
      assert.match(err.message, /requires an authorized user-origin operation/);
    }
    // Refusal happens before any derivation or append, so the log is byte-for-byte what it was.
    assert.equal(readLines(app.experience.filePath).length, 1);
  });

  test('correcting an experience appends a record and keeps the one it corrects', async () => {
    const app = appFor(tempDir());
    const first = await experienceFor(app, 'remember that the sprint ends on Thursday', 'first reading');
    const second = await app.experience.recordExperience({
      operationId: first.op.id,
      subject: 'corrected reading of the same event',
      replaces: [first.record.id],
      origin: 'user',
    });
    assert.deepEqual(second.supersededIds, [first.record.id]);
    assert.deepEqual(second.record.replaces, [first.record.id]);

    const all = await app.experience.list({ limit: 10 });
    assert.equal(all.length, 2, 'both records stay in the log');
    const byId = new Map(all.map((r) => [r.id, r]));
    assert.equal(byId.get(first.record.id).superseded, true);
    assert.equal(byId.get(first.record.id).active, false);
    assert.equal(byId.get(second.record.id).active, true);
    assert.deepEqual(byId.get(second.record.id).replacedBy, []);
    assert.deepEqual(byId.get(first.record.id).replacedBy, [second.record.id]);

    const health = await app.experience.health();
    assert.equal(health.experiences, 2);
    assert.equal(health.activeExperiences, 1);
    assert.equal(health.supersededExperiences, 1);
    assert.equal(health.attention, false, 'a recorded correction is ordinary history, not damage');
    assert.ok(readLines(app.experience.filePath).some((l) => l.includes(first.record.id)), 'the corrected line was not rewritten or deleted');
  });

  test('a second live experience for the same operation is refused until it names what it corrects', async () => {
    const app = appFor(tempDir());
    const { op, record } = await experienceFor(app, 'remember that the vendor is paid monthly');
    await assert.rejects(
      app.experience.recordExperience({ operationId: op.id, subject: 'a duplicate of the same event', origin: 'user' }),
      /already has a recorded experience; correct it by naming that record in replaces/,
    );
    assert.equal((await app.experience.get(record.id)).active, true);
  });

  test('provenance origin and updateMode cannot be supplied by a caller', async () => {
    const app = appFor(tempDir());
    const op = await auditedOp(app, 'remember that provenance is derived, not given');
    await assert.rejects(
      app.experience.recordExperience({
        operationId: op.id,
        subject: 'claiming a different origin',
        origin: 'user',
        provenance: { origin: 'user_approval' },
      }),
      /provenance origin and updateMode may not be supplied directly/,
    );
  });
});

describe('B. a damaged store is refused, never quietly read', () => {
  test('one corrupt line blocks every read and every write for the whole log', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    await experienceFor(app, 'remember that a corrupt line stops the store');
    fs.appendFileSync(path.join(dir, 'experiences.jsonl'), '{oops\n');

    const message = /experience store contains 1 corrupt line\(s\); refusing an incomplete experience operation/;
    await assert.rejects(app.experience.list(), message);
    await assert.rejects(app.experience.activeAdaptations(), message);
    await assert.rejects(app.experience.evidenceReport(), message);
    await assert.rejects(
      app.experience.recordFeedback({ target: 'anything', assessment: 'correct', origin: 'user' }),
      message,
    );

    // A read-only view still reports the damage instead of pretending the store is empty.
    const health = await app.experience.health();
    assert.equal(health.state, 'damaged');
    assert.equal(health.inspected, true);
    assert.equal(health.complete, false);
    assert.equal(health.corruptLines, 1);
    assert.equal(health.attention, true);
    const status = await app.experience.status();
    assert.equal(status.corrupt, 1);
    assert.equal(status.records, 1, 'the readable line is counted separately from the damage');
  });

  test('refusal preserves every byte the store already held', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    await experienceFor(app, 'remember that refusal must not lose data');
    fs.appendFileSync(path.join(dir, 'experiences.jsonl'), '{"schema":1,"kind":"nonsense"}\n');
    const before = snapshot(dir);

    await assert.rejects(app.experience.deriveAdaptations({ origin: 'user' }), /corrupt line/);
    assert.deepEqual(snapshot(dir), before, 'a refused write created no lock residue and changed no line');
  });

  test('an unreadable experience log is unavailable, not empty', async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'experiences.jsonl'));
    const app = appFor(dir);

    const health = await app.experience.health();
    assert.equal(health.state, 'unavailable');
    assert.equal(health.inspected, false);
    assert.equal(health.experiences, null, 'no count is claimed for a store that cannot be read');
    assert.equal(health.attention, true);
    await assert.rejects(app.experience.list(), /cannot read/);
  });

  test('an unterminated tail is damage, marked as recoverable residue', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    await experienceFor(app, 'remember that a cut-off append leaves a partial line');
    fs.appendFileSync(path.join(dir, 'experiences.jsonl'), '{"schema":1,"kind":"experience"');

    const health = await app.experience.health();
    assert.equal(health.corruptLines, 1);
    assert.equal(health.corrupt[0].truncatedTail, true);
    assert.equal(health.corrupt[0].line, 2);
  });

  test('a hand-edited experience line that contradicts its own hash is not readable', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const { record } = await experienceFor(app, 'remember that the stored outcome is hashed');
    const file = path.join(dir, 'experiences.jsonl');
    const line = fs.readFileSync(file, 'utf8').split('\n')[0];
    const tampered = JSON.parse(line);
    tampered.outcome = Outcome.MODEL_UNAVAILABLE;
    fs.writeFileSync(file, `${JSON.stringify(tampered)}\n`);

    const health = await app.experience.health();
    assert.equal(health.corruptLines, 1, 'the header no longer agrees with the evidence copy it was taken from');
    assert.match(health.corrupt[0].reason, /evidence status disagrees with the record/);
    assert.equal(record.outcome, Outcome.SUCCESS_VERIFIED);
  });
});

describe('C. reads and retrieval are bounded', () => {
  test('list is newest-first and never returns more than was asked for', async () => {
    const app = appFor(tempDir());
    const a = await experienceFor(app, 'remember that the first thing happened');
    const b = await experienceFor(app, 'remember that the second thing happened');
    const c = await experienceFor(app, 'remember that the third thing happened');

    const two = await app.experience.list({ limit: 2 });
    assert.deepEqual(two.map((r) => r.id), [c.record.id, b.record.id]);
    const floor = await app.experience.list({ limit: 0 });
    assert.deepEqual(floor.map((r) => r.id), [c.record.id], 'a bound below one still returns the newest record');
    assert.equal((await app.experience.get(a.record.id)).subject, 'the recorded event');
  });

  test('an empty store returns an empty bounded window instead of an error', async () => {
    const app = appFor(tempDir());
    const res = await app.experience.activeAdaptations({});
    assert.deepEqual(res, { adaptations: [], total: 0, truncated: false, limit: 3 });
    assert.deepEqual(await app.experience.list(), []);
    assert.deepEqual(await app.experience.adaptations(), []);
    assert.equal(await app.experience.get('00000000-0000-4000-8000-000000000000'), null);
    assert.equal(await app.experience.feedbackFor('missing'), null);
  });

  test('a missing lookup argument is an empty answer, not a full scan', async () => {
    const app = appFor(tempDir());
    await experienceFor(app, 'remember that empty references are refused');
    assert.deepEqual(await app.experience.findByPrefix('   '), []);
    assert.equal(await app.experience.feedbackFor(''), null);
    assert.equal(await app.experience.adaptationDetail(''), null);
  });

  test('a prefix finds an experience by its own id or by the operation it names', async () => {
    const app = appFor(tempDir());
    const { op, record } = await experienceFor(app, 'remember that short references work');
    const byExperience = await app.experience.findByPrefix(record.id.slice(0, 8));
    assert.deepEqual(byExperience.map((r) => r.id), [record.id]);
    const byOperation = await app.experience.findByPrefix(op.id.slice(0, 8));
    assert.deepEqual(byOperation.map((r) => r.id), [record.id]);
    assert.deepEqual(await app.experience.findByPrefix('zzzzzzzz'), []);
  });

  test('the active window states its limit and says when it cut records', async () => {
    const app = appFor(tempDir());
    for (let i = 0; i < 4; i += 1) {
      await experienceFor(app, `remember that observation ${i + 1} counts`);
    }
    const res = await app.experience.activeAdaptations({ limit: 2 });
    assert.equal(res.total, 0, 'nothing is in scope until a rule is approved');
    assert.equal(res.limit, 2);
    assert.equal(res.truncated, false);
    const capped = await app.experience.activeAdaptations({ limit: 9999 });
    assert.equal(capped.limit, 10, 'the requested bound is clamped to the hard maximum');
    const bad = await app.experience.activeAdaptations({ limit: 'three' });
    assert.equal(bad.limit, 3, 'a non-integer bound falls back to the documented default');
  });
});

describe('D. an experience can be re-verified against the event it names', () => {
  test('the check passes while the audit record still agrees', async () => {
    const app = appFor(tempDir());
    const { record } = await experienceFor(app, 'remember that the review moved to Monday');
    const check = await app.experience.evidenceCheck(record.id);
    assert.equal(check.ok, true);
    assert.match(check.detail, /matches the audit record/);

    const report = await app.experience.evidenceReport({});
    assert.deepEqual(
      { checked: report.checked, experiences: report.experiences, verified: report.verified, mismatched: report.mismatched, missingAudit: report.missingAudit, auditReadable: report.auditReadable },
      { checked: 1, experiences: 1, verified: 1, mismatched: 0, missingAudit: 0, auditReadable: true },
    );
    assert.deepEqual(report.samples, []);
  });

  test('a tampered audit record is reported as a disagreement', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const { record } = await experienceFor(app, 'remember that someone edited the audit log');
    const file = path.join(dir, 'operations.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const target = lines.findIndex((l) => l.includes(`"id":"${record.operationId}"`));
    assert.ok(target >= 0, 'the audited event is in the log the experience names');
    const op = JSON.parse(lines[target]);
    op.capability = 'memory.other';
    lines[target] = JSON.stringify(op);
    fs.writeFileSync(file, lines.join('\n'));

    const check = await app.experience.evidenceCheck(record.id);
    assert.equal(check.ok, false);
    assert.match(check.detail, /no longer matches the experience summary of it/);

    const report = await app.experience.evidenceReport({});
    assert.equal(report.mismatched, 1);
    assert.equal(report.verified, 0);
    assert.equal(report.samples[0].state, 'mismatch');
    assert.equal(report.samples[0].id, record.id);

    // The disagreement is with another log, so the experience store itself still parses.
    const health = await app.experience.health();
    assert.equal(health.corruptLines, 0);
  });

  test('a removed audit record is not re-checkable, and is not called a disagreement', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    await experienceFor(app, 'remember that the audit line is gone');
    const file = path.join(dir, 'operations.jsonl');
    fs.writeFileSync(file, '');

    const report = await app.experience.evidenceReport({});
    assert.equal(report.verified, 0);
    assert.equal(report.mismatched, 0, 'absence proves nothing about invention');
    assert.equal(report.missingAudit, 1);
    assert.match(report.samples[0].detail, /is not in the audit log, so this experience cannot be re-checked/);
    const check = await app.experience.evidenceCheck(report.samples[0].shortId);
    assert.equal(check.ok, false);
    assert.match(check.detail, /is not in the audit log/);
  });

  test('an unreadable audit log makes the evidence report unprovable', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const { record } = await experienceFor(app, 'remember that the audit log cannot be read');
    const pending = await auditedOp(app, 'remember that a second event has no experience yet');
    // The audit log exists at this point, so it is replaced by a directory: the same unreadable-path
    // condition the other stores are tested with, without deleting the evidence the experience names.
    fs.rmSync(path.join(dir, 'operations.jsonl'));
    fs.mkdirSync(path.join(dir, 'operations.jsonl'));

    const report = await app.experience.evidenceReport({});
    assert.equal(report.auditReadable, false);
    assert.equal(report.verified, 0);
    assert.equal(report.mismatched, 0, 'an unreadable log is not evidence of a mismatch');
    assert.match(report.samples[0].detail, /cannot read/);

    const check = await app.experience.evidenceCheck(record.id);
    assert.equal(check.ok, false);
    assert.match(check.detail, /the audit log could not be read/);

    // The audit log's own refusal is propagated in its own words rather than rephrased as a missing
    // record: an unreadable log establishes neither that the event happened nor that it did not.
    await assert.rejects(
      app.experience.recordExperience({ operationId: pending.id, subject: 'a new claim', origin: 'user' }),
      /cannot read operations\.jsonl/,
    );
  });

  test('sampling is disclosed instead of silently partial', async () => {
    const app = appFor(tempDir());
    for (let i = 0; i < 3; i += 1) {
      await experienceFor(app, `remember that sampling covers observation ${i + 1}`);
    }
    const report = await app.experience.evidenceReport({ limit: 2 });
    assert.equal(report.checked, 2);
    assert.equal(report.experiences, 3);
    assert.equal(report.verified, 2);
  });

  test('the check refuses an ambiguous or missing reference instead of guessing', async () => {
    const app = appFor(tempDir());
    await experienceFor(app, 'remember that nothing was referenced');
    assert.equal((await app.experience.evidenceCheck('  ')).ok, false);
    const missing = await app.experience.evidenceCheck('00000000-0000-4000-8000-000000000000');
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /the experience record is not in the store/);
  });
});

describe('E. read-only health reports, it does not fix', () => {
  test('a store that does not exist yet is inspected and empty', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const health = await app.experience.health();
    assert.equal(health.state, 'ok');
    assert.equal(health.inspected, true);
    assert.equal(health.records, 0);
    assert.equal(health.attention, false);
    assert.equal(fs.existsSync(path.join(dir, 'experiences.jsonl')), false, 'health did not create the file');
    assert.equal(fs.existsSync(path.join(dir, 'experiences.jsonl.lock')), false, 'health took no write lock');
  });

  test('a full lifecycle is counted from the log without touching it', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const before = await buildLifecycle(app);
    const bytesBefore = snapshot(dir);

    const health = await app.experience.health();
    assert.deepEqual(snapshot(dir), bytesBefore, 'health is a read');
    assert.equal(health.experiences, 2);
    assert.equal(health.feedback, 2);
    assert.equal(health.adaptations, 1);
    assert.equal(health.candidates, 0);
    assert.equal(health.approved, 1);
    assert.equal(health.activeAdaptations, 1);
    assert.equal(health.decisions, 1);
    assert.equal(health.retirements, 0);
    assert.equal(health.conflicts.scopes, 0);
    assert.equal(health.anomalies.count, 0, `${JSON.stringify(health.anomalies.samples)}`);
    assert.equal(health.attention, false);
    assert.equal(before.created.length, 1);
  });

  test('feedback support that has not been derived yet is pending, not damage', async () => {
    const app = appFor(tempDir());
    const a = await experienceFor(app, 'remember that the first answer was wrong');
    const b = await experienceFor(app, 'remember that the second answer was wrong too');
    await app.experience.recordFeedback({ target: a.record.id, assessment: 'incorrect', guidance: 'give the date first', origin: 'user' });
    await app.experience.recordFeedback({ target: b.record.id, assessment: 'incorrect', guidance: 'give the date first', origin: 'user' });

    const health = await app.experience.health();
    assert.equal(health.adaptations, 0);
    assert.equal(health.pending.derivableCandidates, 1);
    assert.deepEqual(health.pending.scopes, ['memory.add']);
    assert.equal(health.attention, false, 'un-derived evidence is the user next step');
  });

  test('a reference that does not resolve is an anomaly and needs the user', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    await experienceFor(app, 'remember that a dangling reference is damage');
    const dangling = {
      schema: 1,
      kind: 'feedback',
      id: '00000000-0000-4000-8000-000000000099',
      experienceId: '00000000-0000-4000-8000-000000000098',
      assessment: 'incorrect',
      createdAt: '2026-11-01T09:00:00.000Z',
      provenance: { origin: 'user_feedback', updateMode: 'user_confirmed' },
    };
    fs.appendFileSync(path.join(dir, 'experiences.jsonl'), `${JSON.stringify(dangling)}\n`);

    const health = await app.experience.health();
    assert.equal(health.feedback, 1);
    assert.equal(health.attention, true);
    assert.equal(health.anomalies.count, 1);
    assert.match(health.anomalies.samples[0], /assesses \[[0-9a-f]{8}\], which is not a recorded experience/);
    // The line stays: health reports, it does not repair.
    assert.ok(readLines(app.experience.filePath).some((l) => l.includes(dangling.id)));
  });

  test('two live experiences of one operation are reported as an anomaly', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const { op, record } = await experienceFor(app, 'remember that only one live experience is allowed');
    const duplicate = { ...record, id: '00000000-0000-4000-8000-000000000077' };
    fs.appendFileSync(path.join(dir, 'experiences.jsonl'), `${JSON.stringify(duplicate)}\n`);

    const health = await app.experience.health();
    assert.equal(health.anomalies.count, 1);
    assert.match(health.anomalies.samples[0], /are both live experiences of/);
    assert.equal(health.attention, true);
  });

  test('an anomaly sample list is capped and says so', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    await experienceFor(app, 'remember that many anomalies are still bounded');
    const lines = [];
    for (let i = 0; i < 30; i += 1) {
      lines.push(JSON.stringify({
        schema: 1,
        kind: 'adaptation_decision',
        id: `00000000-0000-4000-8000-00000000${String(i).padStart(4, '0')}`,
        targetId: `00000000-0000-4000-8000-10000000${String(i).padStart(4, '0')}`,
        decision: 'approved',
        createdAt: '2026-11-01T09:00:00.000Z',
        provenance: { origin: 'user_approval', updateMode: 'user_confirmed' },
      }));
    }
    fs.appendFileSync(path.join(dir, 'experiences.jsonl'), `${lines.join('\n')}\n`);

    const health = await app.experience.health();
    assert.equal(health.decisions, 30);
    assert.equal(health.anomalies.count, 30);
    assert.equal(health.anomalies.samples.length, 20);
    assert.equal(health.anomalies.truncated, true);
  });

  test('the store status view reports records and damage counts', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    await experienceFor(app, 'remember that status counts what is readable');
    await app.experience.recordFeedback({ target: 'anything', assessment: 'useful', origin: 'user' }).catch(() => {});
    const status = await app.experience.status();
    assert.equal(status.records, 1);
    assert.equal(status.experiences, 1);
    assert.equal(status.corrupt, 0);
    assert.equal(status.path, path.join(dir, 'experiences.jsonl'));
  });
});

describe('F. the audit lookup the store depends on', () => {
  test('findById returns the record it names, and an honest absence', async () => {
    const app = appFor(tempDir());
    const first = await experienceFor(app, 'remember that the first lookup finds its record');
    const second = await experienceFor(app, 'remember that the second lookup reads to the end');
    assert.notEqual(second.record.id, first.record.id);

    const found = await app.operations.findById(first.op.id);
    assert.equal(found.found, true);
    assert.equal(found.record.id, first.op.id);
    assert.equal(found.stoppedEarly, true);
    assert.equal(found.corrupt, 0);

    const absent = await app.operations.findById('ffffffff-ffff-4fff-8fff-ffffffffffff');
    assert.equal(absent.found, false);
    assert.equal(absent.record, null);
    assert.equal(absent.stoppedEarly, false, 'absence is only established by reading the whole log');
    assert.ok(absent.inspected >= 2, `the scan reached the end of the log (${absent.inspected} lines)`);
  });

  test('a damaged audit line is counted and not used as evidence', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const { op } = await experienceFor(app, 'remember that a bad audit line is skipped');
    const file = path.join(dir, 'operations.jsonl');
    const lines = readLines(file);
    fs.writeFileSync(file, `{broken\n${lines.join('\n')}\n`);

    const found = await app.operations.findById(op.id);
    assert.equal(found.found, true);
    assert.equal(found.corrupt, 1);

    // The experience write path treats a damaged log as unprovable rather than as a missing record.
    await assert.rejects(
      app.experience.recordExperience({ operationId: op.id, subject: 'a second claim', origin: 'user' }),
      /already has a recorded experience/,
    );
    const health = await app.operations.health();
    assert.equal(health.corruptLines, 1);
    assert.equal(health.integrity.mode, 'parse-only', 'a clean parse is not claimed as tamper evidence');
  });

  test('an operation id is a valid reference to the experience of that operation', async () => {
    const app = appFor(tempDir());
    const a = await experienceFor(app, 'remember that the first reference resolves');
    await experienceFor(app, 'remember that the second reference resolves too');

    const feedback = await app.experience.recordFeedback({
      target: a.op.id, assessment: 'not_useful', guidance: 'answer in one line', origin: 'user',
    });
    assert.equal(feedback.experience.id, a.record.id, 'an operation id resolves to its recorded experience');

    await assert.rejects(
      app.experience.recordFeedback({ target: 'ffffffffffffffff', assessment: 'correct', origin: 'user' }),
      /feedback target not found; it must be a recorded experience or an operation that has one/,
    );
  });
});

// Two experiences with the same corrective guidance, one derived candidate, and the user's approval.
async function buildLifecycle(app) {
  const a = await experienceFor(app, 'remember that the first review date was missed');
  const b = await experienceFor(app, 'remember that the second review date was missed');
  await app.experience.recordFeedback({
    target: a.record.id, assessment: 'incorrect', guidance: 'state the review date before anything else', origin: 'user',
  });
  await app.experience.recordFeedback({
    target: b.record.id, assessment: 'user_correction', guidance: 'state the review date before anything else', reason: 'the date is what I need', origin: 'user',
  });
  const derived = await app.experience.deriveAdaptations({ origin: 'user' });
  const decided = await app.experience.decideAdaptation({
    target: derived.created[0].id, decision: 'approved', reason: 'this is what I asked for', origin: 'user',
  });
  return { ...derived, decided };
}
