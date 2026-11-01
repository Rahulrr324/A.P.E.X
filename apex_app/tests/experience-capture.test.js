// Batch AA: automatic experience capture, tested offline.
//
// Batch Z made an experience something the user records by naming an operation. Batch AA adds a
// narrow automatic path on top of it: when the one setting is armed, APEX may capture the outcome of
// an operation it already proved it carried out. Everything Batch Z drew stays exactly where it was -
// an experience is evidence that an event happened, feedback is what the user thought of it, and only
// the user's own repeated corrective feedback can support a behaviour rule. So the load-bearing
// claims this file makes are about the boundary as much as about the feature:
//
//   what is written       only an experience record, for a verified, user-origin, in-subset
//                         operation whose audit evidence is complete - and nothing else;
//   what is never written no feedback, no assessment, no candidate, no decision, no approval, and
//                         never the user's words or a credential;
//   what a failure costs  nothing to the operation itself: the audit record, the outcome and the
//                         exit status are settled before capture is attempted;
//   who controls it       one validated setting, off by default, refused at startup when malformed,
//                         reported truthfully by health, status and diagnose.
//
// The nineteen §9 cases are each named in a test title so the mapping can be audited; the extra
// tests cover bounds the case list implies but does not name separately (subject bounds, subset
// membership, restart behaviour, forged provenance, and the §8 wording). Real child processes are
// used where the claim is about processes (concurrent completion, an interrupted holder). No test
// here contacts a model, starts a service, or downloads anything: the fixture environment strips
// every APEX_* setting, and the audited events come from the real request path with deterministic
// routing.
//
// Two of §2's lifecycles (verification-unavailable, and an outcome that is uncertain after a side
// effect) cannot be produced for an in-subset capability without damaging a store on purpose,
// because every in-subset action defines a verifier that answers. Where that is the case a test says
// so and changes one field of a real audit record, so the decision function is exercised against real
// evidence rather than against a fixture that merely resembles it; the audit-damage variant that does
// produce such a record for real is tested in the same group.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDataDir, cleanup, cleanEnv, runCli, APP_ROOT, deadPid, rebindDeadHolder } from './helpers.js';
import { createApp } from '../src/app.js';
import { OperationLog } from '../src/operations/operation-log.js';
import {
  ExperienceStore, CAPTURE_AUTOMATIC, CAPTURE_UNKNOWN, ASSESSMENTS, MAX_SUBJECT_CHARS, captureOf,
} from '../src/experience/experience-store.js';
import {
  autoCaptureDecision, captureSubject, captureSettingPhrase,
  CAPTURE_OFF, CAPTURE_VERIFIED_SUCCESS, CAPTURE_MODES, AUTO_CAPTURE_CAPABILITIES,
} from '../src/experience/capture.js';
import { DERIVATION_METHOD, MIN_SUPPORT_FEEDBACK } from '../src/experience/derivation.js';
import { Outcome } from '../src/outcomes.js';

const CLOCK = () => new Date('2026-11-01T09:00:00.000Z');
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const LOG = (dir) => path.join(dir, 'experiences.jsonl');
const OPS = (dir) => path.join(dir, 'operations.jsonl');
const LOCK = (dir) => `${LOG(dir)}.lock`;
const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'experience-writer-child.mjs');

// The setting under test, as an operator sets it: through the environment of a real APEX process.
// `capture === null` means the variable is not present at all, which is the unset case.
function envFor(dir, capture = CAPTURE_VERIFIED_SUCCESS) {
  const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
  if (capture !== null) env.APEX_EXPERIENCE_CAPTURE = capture;
  return env;
}

// The assembled application, with capture armed by default: not a stub of it.
function appFor(dir, capture = CAPTURE_VERIFIED_SUCCESS) {
  return createApp({ dataDir: dir, now: CLOCK, experienceCapture: capture });
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function readRecords(file) {
  return readLines(file).map((line) => JSON.parse(line));
}

function experiencesOf(dir) {
  return readRecords(LOG(dir)).filter((record) => record.kind === 'experience');
}

function kindsOf(dir) {
  const counts = {};
  for (const record of readRecords(LOG(dir))) counts[record.kind] = (counts[record.kind] ?? 0) + 1;
  return counts;
}

function auditOf(dir) {
  return readRecords(OPS(dir));
}

// Anything a coordinated write is expected to clean up. A refusal that leaves a claim behind is
// correct only when the claim belongs to a live holder the test installed, or an ambiguous claim it
// deliberately refused to delete on a guess.
function residue(dir) {
  return fs.readdirSync(dir).filter((name) => (
    name.endsWith('.lock') || name.includes('.takeover.') || name.endsWith('.recover') || name.endsWith('.tmp')
  ));
}

function snapshot(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out[entry.name] = entry.isDirectory() ? '<dir>' : fs.readFileSync(full).toString('base64');
  }
  return out;
}

// One real audited operation, produced through the ordinary request path.
async function remember(app, note) {
  const res = await app.controller.handle(`remember that ${note}`, { origin: 'user' });
  assert.equal(res.operation.capability, 'memory.add', 'the fixture depends on this request routing to memory.add');
  return res;
}

const lastMemoryId = (dir) => readRecords(path.join(dir, 'memory.jsonl')).at(-1).id;
const lastKnowledgeId = (dir) => readRecords(path.join(dir, 'knowledge.jsonl')).at(-1).id;

function resultsOf(out) {
  return out.split('\n').filter((line) => line.startsWith('RESULT ')).map((line) => JSON.parse(line.slice('RESULT '.length)));
}

function startChild(args, { racers = 1, waitMs = null } = {}) {
  const env = cleanEnv({ APEX_RACERS: String(racers) });
  if (waitMs !== null) env.APEX_WAIT_MS = String(waitMs);
  const child = spawn(process.execPath, [CHILD, ...args], { env, cwd: APP_ROOT, windowsHide: true });
  let out = '';
  let exitInfo = null;
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const exit = new Promise((resolve) => child.on('exit', (code, signal) => { exitInfo = { code, signal }; resolve(exitInfo); }));
  const waitFor = (predicate, ceilingMs = 25000) => new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const hit = predicate(out);
      if (hit) { clearInterval(timer); resolve(hit); return; }
      if (exitInfo || Date.now() - startedAt > ceilingMs) {
        clearInterval(timer);
        reject(new Error(`child ${args.join(' ')} did not report what was expected (exit ${exitInfo?.code ?? 'still running'}):\n${out}`));
      }
    }, 10);
  });
  return { child, exit, waitFor, get out() { return out; }, get results() { return resultsOf(out); } };
}

// A real, verified audit record of an in-subset capability, so a decision-level refusal is always
// stated about evidence APEX actually wrote.
async function realVerifiedOp(dir) {
  const app = appFor(dir, CAPTURE_OFF);
  return (await remember(app, 'the note used as evidence')).operation;
}

describe('AA-1 an eligible verified operation is captured automatically', () => {
  test('§9 Eligible verified operation captured automatically: one experience record, and nothing else', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const res = await remember(app, 'the budget review is on Friday');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
    const op = res.operation;

    // The user is told, in the same output as the result, that an experience was written and that no
    // assessment of it was.
    assert.match(res.display, new RegExp(`Experience: captured automatically as [0-9a-f]{8} from operation ${op.id.slice(0, 8)} \\(memory\\.add\\)`));
    assert.match(res.display, /APEX recorded no assessment of it - feedback is yours alone/);

    const records = readRecords(LOG(dir));
    assert.equal(records.length, 1, 'capture writes exactly one line');
    const [record] = records;
    assert.equal(record.kind, 'experience');
    assert.equal(record.operationId, op.id, 'an experience is a reference to the audit record');
    assert.equal(record.capability, 'memory.add');
    assert.equal(record.outcome, Outcome.SUCCESS_VERIFIED, 'the outcome is copied from the audit record, not chosen');
    assert.equal(record.origin, 'user');
    assert.equal(record.adaptationEligible, true);

    // Provenance: a captured experience is authorized by the user's setting but authored by APEX's
    // own observation.
    assert.equal(record.provenance.origin, 'system_observed');
    assert.equal(record.provenance.updateMode, 'user_confirmed');

    // Nothing about a judgement, and no new kind of record.
    assert.equal(record.assessment, undefined);
    assert.equal(record.guidance, undefined);
    assert.deepEqual(kindsOf(dir), { experience: 1 });

    // A fresh store instance re-derives the same state from disk, and the independent evidence check
    // still agrees with the audit record.
    const x = new ExperienceStore(LOG(dir), { now: CLOCK, operations: new OperationLog(OPS(dir)) });
    assert.equal((await x.evidenceCheck(record.id)).ok, true);
    const listed = await x.list({ limit: 10 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].capture, CAPTURE_AUTOMATIC, 'a reader can tell a captured record from a recorded one');
    assert.equal(listed[0].feedbackCount, 0);
    const status = await x.status();
    assert.equal(status.capturedAutomatically, 1);
    assert.equal(status.unknownCapture, 0, 'a writer produces a known capture value');

    const health = await app.experience.health();
    assert.equal(health.experiences, 1);
    assert.equal(health.capturedAutomatically, 1);
    assert.equal(health.recordedByUser, 0);
    assert.equal(health.unknownCapture, 0);
    assert.equal(health.feedback, 0, 'no assessment was written for the user');
    assert.equal(health.adaptations, 0, 'a capture cannot start a behaviour rule');

    const appStatus = await app.getStatus();
    assert.equal(appStatus.experienceCapturedAutomatically, 1);
    assert.equal(appStatus.experienceRecordedByUser, 0);
    assert.equal(appStatus.experienceCaptureMode, CAPTURE_VERIFIED_SUCCESS);
  });

  test('§9 coverage: every capability in the capture subset is captured through the real write paths', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const added = await remember(app, 'the launch note is held');
    const memoryId = await lastMemoryId(dir);
    // A correction APEX's own conflict rule accepts: the same subject, a different value. The
    // store refuses a replacement that does not contradict the claim it names, so this call really
    // does exercise the memory.correct write path.
    const corrected = await app.controller.correctMemory({
      targetId: memoryId, content: 'the launch note is postponed', resolve: true,
    });
    assert.equal(corrected.status, Outcome.SUCCESS_VERIFIED, corrected.display ?? corrected.output);
    const known = await app.controller.knowledgeAdd({ subject: 'launch', relationship: 'scheduled for', object: 'Tuesday' });
    assert.equal(known.status, Outcome.SUCCESS_VERIFIED, known.display ?? known.output);
    const knowledgeId = await lastKnowledgeId(dir);
    const retracted = await app.controller.knowledgeRetract({ target: knowledgeId, reason: 'superseded by the review' });
    assert.equal(retracted.status, Outcome.SUCCESS_VERIFIED, retracted.display ?? retracted.output);

    const captured = experiencesOf(dir);
    const ops = [added.operation, corrected.operation, known.operation, retracted.operation];
    assert.deepEqual(captured.map((r) => r.operationId).sort(), ops.map((o) => o.id).sort());
    assert.deepEqual(captured.map((r) => r.capability).sort(), [
      'knowledge.add', 'knowledge.retract', 'memory.add', 'memory.correct',
    ]);
    for (const record of captured) {
      assert.equal(record.provenance.origin, 'system_observed');
      assert.match(record.subject, new RegExp(`^${record.capability}: `), 'every subject names the capability it came from');
    }
    // The subset is the documented one. `knowledge.resolve` shares the knowledge write path, and so
    // the same capture call site, but needs a conflicting pair to reach a verified success; the
    // knowledge suites cover resolution itself.
    assert.deepEqual([...AUTO_CAPTURE_CAPABILITIES].sort(), [
      'knowledge.add', 'knowledge.resolve', 'knowledge.retract', 'memory.add', 'memory.correct',
    ].sort());
    assert.deepEqual([...CAPTURE_MODES], ['off', 'verified-success']);
    assert.equal(readRecords(LOG(dir)).length, 4, 'no bookkeeping records accompany the captures');
  });

  test('the captured subject is an account of the event, never the user\'s words, and is bounded', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const long = 'the quarterly review meeting '.repeat(20);
    const res = await remember(app, `${long} is on Friday`);
    assert.ok(res.display.includes('captured automatically'));
    const [record] = experiencesOf(dir);

    for (const phrase of ['quarterly', 'review', 'Friday']) {
      assert.equal(record.subject.includes(phrase), false, `the subject must not copy the request: ${phrase}`);
    }
    assert.match(record.subject, /^memory\.add: stored user fact [0-9a-f]{8} \(verified\)$/);
    assert.ok(record.subject.length <= MAX_SUBJECT_CHARS);

    // The fallback when the summaries would not fit is content-free rather than a cut-down sentence,
    // because a half identifier would disagree with the audit record on every later read.
    const wide = { ...res.operation, steps: [{ ...res.operation.steps[0], summary: 'x'.repeat(MAX_SUBJECT_CHARS) }] };
    assert.equal(captureSubject(wide), 'memory.add: 1 verified step(s)');
    assert.equal(captureSubject({ capability: 'memory.add', steps: [] }), null, 'no summaries, no account of the event');
    assert.equal(captureSubject({ capability: '', steps: [{ summary: 'a' }] }), null);
  });
});

describe('AA-2 what is never captured', () => {
  test('§9 Ineligible operation not captured: verified reads and out-of-subset writes stay silent', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    await remember(app, 'the seed note is held');
    const before = readLines(LOG(dir)).length;
    assert.equal(before, 1, 'the seed itself was captured');

    const reads = [
      ['knowledge.list', await app.controller.knowledgeList({ limit: 5 })],
      ['knowledge.search', await app.controller.knowledgeSearch('seed')],
      ['memory.search', await app.controller.handle('recall the seed note', { origin: 'user' })],
    ];
    for (const [name, res] of reads) {
      assert.ok(res.operation, `${name} should have been audited`);
      assert.equal(AUTO_CAPTURE_CAPABILITIES.includes(res.operation.capability), false, `${name} must be outside the subset`);
      assert.equal(res.display.includes('Experience:'), false, `${name} must not announce a capture`);
    }
    assert.equal(readLines(LOG(dir)).length, before, 'a read produced no experience');

    // Each of those records is refused by name, so a reader can tell why nothing appeared.
    for (const [, res] of reads) {
      const decision = autoCaptureDecision(res.operation, { mode: CAPTURE_VERIFIED_SUCCESS });
      assert.equal(decision.eligible, false);
      assert.match(decision.reason, /is outside the automatic capture subset/);
    }
  });

  test('§9 Denied operation not captured: a model-origin write is audited as denied and never captured', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const denied = await app.controller.handle('remember that the model wanted this stored', { origin: 'model' });
    assert.equal(denied.status, Outcome.ACTION_DENIED);
    assert.equal(denied.operation.origin, 'model');
    assert.equal(denied.operation.steps[0].authorization.decision, 'deny');
    assert.equal(denied.operation.steps[0].execution.status, 'not_run', 'a denied action never ran');
    assert.equal(denied.display.includes('Experience:'), false);

    const decision = autoCaptureDecision(denied.operation, { mode: CAPTURE_VERIFIED_SUCCESS });
    assert.equal(decision.eligible, false);
    // The first guard this record meets is the origin rule; the state of its steps and its own
    // status say no as well, so the refusal does not depend on one field being read correctly.
    assert.match(decision.reason, /only a user-origin operation is captured automatically/);
    const userOrigin = autoCaptureDecision({ ...denied.operation, origin: 'user' }, { mode: CAPTURE_VERIFIED_SUCCESS });
    assert.equal(userOrigin.eligible, false);
    assert.match(userOrigin.reason, /action_denied, which is not a verified success/);
    const repairedStatus = autoCaptureDecision(
      { ...denied.operation, origin: 'user', status: Outcome.SUCCESS_VERIFIED },
      { mode: CAPTURE_VERIFIED_SUCCESS },
    );
    assert.equal(repairedStatus.eligible, false);
    assert.match(repairedStatus.reason, /at least one step was denied, failed, or not independently verified/);

    assert.equal(fs.existsSync(LOG(dir)), false, 'the experience log was never opened for a denied operation');
    assert.equal(auditOf(dir).filter((o) => o.id === denied.operation.id).length, 1, 'the denial is still audited');
  });

  test('§9 Failed operation not captured: a verified failure is recorded and refused as experience', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const failed = await app.controller.knowledgeRetract({ target: 'ffffffff', reason: 'no such record' });
    assert.equal(failed.status, Outcome.EXECUTION_FAILED);
    assert.equal(failed.operation.steps[0].outcome, Outcome.EXECUTION_FAILED);
    assert.equal(failed.display.includes('Experience:'), false, 'a failure is not announced as a capture');

    const decision = autoCaptureDecision(failed.operation, { mode: CAPTURE_VERIFIED_SUCCESS });
    assert.equal(decision.eligible, false);
    assert.match(decision.reason, /execution_failed, which is not a verified success/);
    // Even with the status repaired on paper, the failed step itself is what refuses.
    const stepOnly = autoCaptureDecision({ ...failed.operation, status: Outcome.SUCCESS_VERIFIED }, { mode: CAPTURE_VERIFIED_SUCCESS });
    assert.equal(stepOnly.eligible, false);
    assert.match(stepOnly.reason, /at least one step was denied, failed, or not independently verified/);
    assert.equal(fs.existsSync(LOG(dir)), false);
  });

  test('§9 Uncertain side effect not captured: a write whose audit record could not be written is refused', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    await remember(app, 'the launch note is held');
    const memoryId = await lastMemoryId(dir);
    assert.equal(experiencesOf(dir).length, 1, 'the seed was captured normally');

    // Make the audit log impossible to append to. The memory correction really does happen, and then
    // its audit record cannot be written, so the outcome is genuinely uncertain - that is the real
    // path to this lifecycle, not a fixture. The replacement contradicts the claim it names, which is
    // the condition the memory store requires before it accepts a correction at all.
    const auditPath = OPS(dir);
    fs.rmSync(auditPath);
    fs.mkdirSync(auditPath);
    try {
      const uncertain = await app.controller.correctMemory({
        targetId: memoryId, content: 'the launch note is postponed', resolve: true,
      });
      assert.equal(uncertain.recorded, false, 'the audit append failed');
      assert.equal(uncertain.status, Outcome.AUDIT_INTEGRITY_FAILED);
      assert.match(uncertain.display, /may have been stored, but its audit record could not be written/);
      assert.equal(uncertain.display.includes('Experience:'), false, 'and nothing is claimed about an experience');
      assert.equal(
        readRecords(path.join(dir, 'memory.jsonl')).length, 2,
        'the side effect itself is present on disk, which is why the outcome cannot be reported as certain',
      );

      const decision = autoCaptureDecision(uncertain.operation, { mode: CAPTURE_VERIFIED_SUCCESS, recorded: false });
      assert.equal(decision.eligible, false);
      assert.match(decision.reason, /the audit record could not be written/);
      assert.equal(experiencesOf(dir).length, 1, 'the uncertain write added no experience');
    } finally {
      fs.rmSync(auditPath, { recursive: true });
    }
  });

  test('§9 Verification unavailable not captured: a step without independent confirmation is refused', async () => {
    const dir = tempDir();
    const real = await realVerifiedOp(dir);
    // Every in-subset action defines a verifier that answers, so this lifecycle is produced by
    // changing only the verification fields of a real audit record.
    const unverifiable = {
      ...real,
      status: Outcome.VERIFICATION_UNAVAILABLE,
      steps: real.steps.map((step) => ({
        ...step,
        outcome: Outcome.VERIFICATION_UNAVAILABLE,
        verification: { ...step.verification, outcome: Outcome.VERIFICATION_UNAVAILABLE },
      })),
    };

    const byStatus = autoCaptureDecision(unverifiable, { mode: CAPTURE_VERIFIED_SUCCESS });
    assert.equal(byStatus.eligible, false);
    assert.match(byStatus.reason, /verification_unavailable, which is not a verified success/);

    const byStep = autoCaptureDecision({ ...unverifiable, status: Outcome.SUCCESS_VERIFIED }, { mode: CAPTURE_VERIFIED_SUCCESS });
    assert.equal(byStep.eligible, false);
    assert.match(byStep.reason, /not independently verified/);

    // A step that ran without authorization, or was authorized and never ran, or failed its own
    // re-read: each fails the same test from a different direction.
    for (const mutate of [
      (step) => ({ ...step, authorization: { ...step.authorization, decision: 'deny' } }),
      (step) => ({ ...step, execution: { ...step.execution, status: 'not_run' } }),
      (step) => ({ ...step, verification: { ...step.verification, outcome: Outcome.EXECUTION_FAILED } }),
    ]) {
      const patched = { ...real, steps: real.steps.map(mutate) };
      const refused = autoCaptureDecision(patched, { mode: CAPTURE_VERIFIED_SUCCESS });
      assert.equal(refused.eligible, false);
      assert.match(refused.reason, /at least one step was denied, failed, or not independently verified/);
    }

    // A record with no steps at all says nothing was verified.
    const noSteps = autoCaptureDecision({ ...real, steps: [] }, { mode: CAPTURE_VERIFIED_SUCCESS });
    assert.equal(noSteps.eligible, false);
    assert.match(noSteps.reason, /recorded no steps/);

    // Errors attached to an operation mean its audit evidence is not complete, even when the status
    // reads as success.
    const withErrors = autoCaptureDecision(
      { ...real, errors: [{ stage: 'verification', code: 'STORE_ERROR', message: 'the store could not be re-read' }] },
      { mode: CAPTURE_VERIFIED_SUCCESS },
    );
    assert.equal(withErrors.eligible, false);
    assert.match(withErrors.reason, /audit evidence is not complete/);

    // And a model-origin record is refused whatever its status: an unverified model conclusion is
    // never evidence of anything.
    const fromModel = autoCaptureDecision({ ...real, origin: 'model' }, { mode: CAPTURE_VERIFIED_SUCCESS });
    assert.equal(fromModel.eligible, false);
    assert.match(fromModel.reason, /model origin/);
  });

  test('§9 Missing audit evidence: no identifier, no operation, or an operation absent from the audit log', async () => {
    const dir = tempDir();
    const real = await realVerifiedOp(dir);

    const noId = autoCaptureDecision({ ...real, id: '' }, { mode: CAPTURE_VERIFIED_SUCCESS });
    assert.equal(noId.eligible, false);
    assert.match(noId.reason, /no stable identifier/);
    const noOp = autoCaptureDecision(null, { mode: CAPTURE_VERIFIED_SUCCESS });
    assert.equal(noOp.eligible, false);
    assert.match(noOp.reason, /no operation record/);
    const notRecorded = autoCaptureDecision(real, { mode: CAPTURE_VERIFIED_SUCCESS, recorded: false });
    assert.equal(notRecorded.eligible, false);
    assert.match(notRecorded.reason, /audit record could not be written/);

    // The store is the second line of defence: an experience cannot be written for an operation the
    // audit log does not hold, so a capture could never point at a record that only exists in memory.
    const orphan = new ExperienceStore(LOG(dir), { now: CLOCK, operations: new OperationLog(OPS(dir)) });
    const refused = await orphan.recordExperience({
      operationId: '00000000-0000-4000-8000-000000000000', subject: 'an event with no audit record', origin: 'user',
    }).then(() => null, (err) => err);
    assert.ok(refused, 'the store refuses an experience with no audit evidence');
    assert.match(refused.message, /audit/i);
    assert.equal(readLines(LOG(dir)).length, 0, 'the refusal appended nothing at all');

    // Refusing one bad reference does not damage the store: the operation the audit log really does
    // hold can still be recorded, and its record then re-checks against that audit record.
    const explicit = await orphan.recordExperience({
      operationId: real.id, subject: 'recorded after the unfounded reference was refused', origin: 'user',
    });
    assert.equal(explicit.record.operationId, real.id);
    assert.equal((await orphan.evidenceCheck(explicit.record.id)).ok, true);
    assert.equal(experiencesOf(dir).length, 1, 'exactly the one honest record was written');
  });
});

describe('AA-3 one operation, one experience - including across processes', () => {
  test('§9 Duplicate operation ID: asking again for a captured operation writes nothing', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const res = await remember(app, 'the note recorded twice');
    const [first] = experiencesOf(dir);
    assert.equal(first.provenance.origin, 'system_observed', 'it arrived by capture');

    const again = await app.controller.experienceRecord({ operationId: res.operation.id, subject: 'the same event again' });
    assert.equal(again.status, Outcome.EXECUTION_FAILED);
    assert.match(again.display, /already has a recorded experience/);

    const records = readRecords(LOG(dir));
    assert.equal(records.length, 1, 'the duplicate was refused, not silently merged or appended');
    assert.equal(records[0].id, first.id);
    assert.equal(records[0].subject, first.subject, 'the captured record was not rewritten either');

    // Deduplication is per operation, not a global block: a second, distinct operation still gets
    // its own experience.
    const second = await remember(app, 'a different note entirely');
    assert.match(second.display, /captured automatically/);
    const captured = experiencesOf(dir);
    assert.equal(captured.length, 2);
    assert.equal(new Set(captured.map((r) => r.operationId)).size, 2);
    // The capture for that second note came from its own memory.add; the duplicate attempt was
    // audited as experience.record, which is outside the subset - so the log cannot fill with
    // records about its own bookkeeping.
    assert.deepEqual(kindsOf(dir), { experience: 2 });
    assert.equal(auditOf(dir).filter((o) => o.capability === 'experience.record').length, 1);
  });

  test('§9 Concurrent completion: two APEX processes each finish and capture an operation', async () => {
    const dir = tempDir();
    const [a, b] = await Promise.all([
      runCli(['ask', 'remember that the first parallel note is held'], envFor(dir)),
      runCli(['ask', 'remember that the second parallel note is held'], envFor(dir)),
    ]);
    for (const run of [a, b]) {
      assert.equal(run.stderr, '', run.stderr);
      assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
      assert.match(run.stdout, /Status:\s+success_verified/);
      assert.match(run.stdout, /Experience: captured automatically as [0-9a-f]{8}/);
      assert.match(run.stdout, /Audit:\s+recorded in operations\.jsonl/);
    }

    const operations = auditOf(dir).filter((o) => o.capability === 'memory.add');
    assert.equal(operations.length, 2, 'both operations are audited');
    const captured = experiencesOf(dir);
    assert.equal(captured.length, 2, 'and both were captured - neither lost the race');
    for (const op of operations) {
      assert.equal(captured.filter((r) => r.operationId === op.id).length, 1, 'one experience each, no duplicates');
    }
    // Every line parses and every hash recomputes: coordinated appends cannot interleave bytes.
    for (const line of readLines(LOG(dir))) assert.ok(JSON.parse(line).id);
    const x = new ExperienceStore(LOG(dir), { now: CLOCK, operations: new OperationLog(OPS(dir)) });
    for (const record of captured) assert.equal((await x.evidenceCheck(record.id)).ok, true);
    assert.equal((await x.health()).corruptLines, 0);
    assert.deepEqual(residue(dir), [], 'both processes released their claims');
  });

  test('§9 Concurrent completion of one operation: four processes, one experience, three truthful refusals', async () => {
    const dir = tempDir();
    // One audited operation to race over, created with capture off so the test controls the count.
    const app = appFor(dir, CAPTURE_OFF);
    const op = (await remember(app, 'the note four processes claim')).operation;

    const handles = [0, 1, 2, 3].map((w) => startChild(['record-experience', dir, String(w), op.id], { racers: 4, waitMs: 60000 }));
    const settled = [];
    for (const handle of handles) settled.push({ ...(await handle.exit), results: handle.results });

    const results = settled.flatMap((run) => run.results);
    assert.equal(results.length, 4, JSON.stringify(results));
    const won = results.filter((r) => r.ok);
    const lost = results.filter((r) => !r.ok);
    assert.equal(won.length, 1, 'exactly one process wrote the experience');
    assert.equal(lost.length, 3, 'the others were refused rather than silently dropped');
    for (const loser of lost) {
      assert.equal(loser.code, 'EXPERIENCE_EXISTS', JSON.stringify(loser));
      assert.match(loser.message, /already has a recorded experience/);
    }
    const captured = experiencesOf(dir);
    assert.equal(captured.length, 1, 'no duplicate experience for one operation');
    assert.equal(captured[0].operationId, op.id);
    assert.deepEqual(residue(dir), []);
    // Four real processes, so the claim is about coordination and not exactly-once execution: the
    // winner's record is verifiable and each loser returned a refusal that states what it found.
    const x = new ExperienceStore(LOG(dir), { now: CLOCK, operations: new OperationLog(OPS(dir)) });
    assert.equal((await x.evidenceCheck(captured[0].id)).ok, true);
  });

  test('§9 Process interruption: a killed lock holder neither loses nor duplicates the capture', async () => {
    const dir = tempDir();
    const app = appFor(dir, CAPTURE_OFF);
    const op = (await remember(app, 'the note behind an abandoned claim')).operation;

    const holder = startChild(['hold-lock', dir, 'h', '0'], {});
    await holder.waitFor((out) => out.includes('HELD '));
    assert.equal(JSON.parse(fs.readFileSync(LOCK(dir), 'utf8')).pid, holder.child.pid, 'the claim names its writer');
    holder.child.kill();
    await holder.exit;
    // The killed pid could be reused by the operating system, so the abandoned claim is rebound to a
    // process id that stays unused for the duration of the test rather than assumed dead.
    rebindDeadHolder(LOCK(dir), holder.child.pid);
    assert.equal(JSON.parse(fs.readFileSync(LOCK(dir), 'utf8')).pid, deadPid());

    // A real APEX process now completes an eligible operation with capture armed. It must take over
    // the abandoned claim, write its own experience, and leave nothing behind.
    const run = await runCli(['ask', 'remember that the note after the crash'], envFor(dir));
    assert.equal(run.stderr, '', run.stderr);
    assert.equal(run.code, 0, run.stdout);
    assert.match(run.stdout, /Experience: captured automatically as [0-9a-f]{8}/);

    // The interrupted holder had written nothing, so the log holds exactly the one new capture.
    const captured = experiencesOf(dir);
    assert.equal(captured.length, 1);
    assert.notEqual(captured[0].operationId, op.id, 'the holder never got as far as its own record');
    for (const line of readLines(LOG(dir))) assert.ok(JSON.parse(line).id);
    assert.equal(fs.existsSync(LOCK(dir)), false, 'the abandoned claim was taken over, not left in place');
    assert.deepEqual(residue(dir), [], 'and the takeover left no token behind');

    const second = await runCli(['ask', 'remember that the note after the takeover'], envFor(dir));
    assert.equal(second.code, 0, `${second.stdout}${second.stderr}`);
    assert.match(second.stdout, /captured automatically/);
    assert.equal(experiencesOf(dir).length, 2, 'capture keeps working after the recovery');
    assert.deepEqual(residue(dir), []);
  });
});

describe('AA-4 capture failure costs the operation nothing', () => {
  test('§9 Experience-store corruption: the capture refuses, the operation keeps its outcome, the damage stays', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    await remember(app, 'the note before the damage');
    assert.equal(experiencesOf(dir).length, 1);

    fs.appendFileSync(LOG(dir), 'this line is not a record\n');
    const before = fs.readFileSync(LOG(dir), 'utf8');

    const run = await runCli(['ask', 'remember that the note during the damage'], envFor(dir));
    assert.equal(run.stderr, '', run.stderr);
    assert.equal(run.code, 0, 'a verified operation is not re-reported as failed because capture could not run');
    assert.match(run.stdout, /Status:\s+success_verified/);
    assert.match(run.stdout, /Experience: not captured \(/);
    assert.match(run.stdout, /corrupt line/);
    assert.match(run.stdout, /succeeded and its audit record is unchanged/);
    assert.match(run.stdout, /experience record [0-9a-f-]{8}/, 'and the explicit route is named instead');

    // The damage is preserved byte for byte: APEX refuses an incomplete log, it does not rewrite it.
    assert.equal(fs.readFileSync(LOG(dir), 'utf8'), before, 'the corrupt line was neither repaired nor extended');
    assert.equal(auditOf(dir).filter((o) => o.capability === 'memory.add').length, 2, 'the operation was audited normally');
    assert.equal(readRecords(path.join(dir, 'memory.jsonl')).length, 2, 'the user fact was stored');

    // A reader is told the store is damaged rather than shown a shorter list.
    const health = await app.experience.health();
    assert.equal(health.corruptLines, 1);
    assert.equal(health.state, 'damaged', 'a damaged store is named as damaged, not as an empty one');
    assert.equal(health.complete, false, 'and its counts cover only the readable records');
    assert.equal(health.attention, true);
    assert.deepEqual(residue(dir), []);
  });

  test('§9 Experience write failure after operation success: an ambiguous claim refuses and is not deleted', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const claim = 'this claim is not json';
    fs.writeFileSync(LOCK(dir), claim);

    const run = await runCli(['ask', 'remember that the note against an unknown holder'], envFor(dir));
    assert.equal(run.code, 0, run.stdout);
    assert.match(run.stdout, /Status:\s+success_verified/);
    assert.match(run.stdout, /Experience: not captured \(/);
    assert.match(run.stdout, /in use by process unknown/, 'a writer does not guess past a claim it cannot read');
    assert.equal(fs.readFileSync(LOCK(dir), 'utf8'), claim, 'an ambiguous claim is never removed on a guess');
    assert.equal(experiencesOf(dir).length, 0, 'nothing was written behind the claim');

    // The operation is intact and still recordable by name: repairing the experience is never done by
    // re-running the original operation.
    const op = auditOf(dir).at(-1);
    assert.equal(op.capability, 'memory.add');
    assert.equal(op.status, Outcome.SUCCESS_VERIFIED);
    fs.rmSync(LOCK(dir));
    const explicit = await app.controller.experienceRecord({ operationId: op.id, subject: 'recorded after clearing the claim' });
    assert.equal(explicit.status, Outcome.SUCCESS_VERIFIED, explicit.display ?? explicit.output);
    const captured = experiencesOf(dir);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].operationId, op.id);
    assert.equal(captured[0].provenance.origin, 'user_recorded', 'and it is honest about how it arrived');
    assert.deepEqual(residue(dir), []);
  });

  test('§9 Experience write failure, store unreadable: a verified operation is never silently discarded', async () => {
    const dir = tempDir();
    // Nothing at the experience path can be read as a file, so every capture attempt must fail - and
    // must fail without touching what the operation itself proved.
    fs.mkdirSync(LOG(dir));
    const app = appFor(dir);

    const res = await remember(app, 'the note with an unreadable experience store');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, 'the operation is reported from its own verifier');
    assert.match(res.display, /Experience: not captured \(/);
    assert.match(res.display, /succeeded and its audit record is unchanged/);

    const operations = auditOf(dir);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].status, Outcome.SUCCESS_VERIFIED);
    assert.equal(readRecords(path.join(dir, 'memory.jsonl')).length, 1, 'the user fact is stored');

    // An unreadable store is reported as unreadable, never as an empty one.
    const health = await app.experience.health();
    assert.equal(health.state, 'unavailable');
    assert.equal(health.inspected, false);
    assert.equal(health.experiences, null, 'no count is claimed for a store that could not be read');
    assert.match(health.detail, /cannot read experiences\.jsonl/);
    // The aggregate status report refuses rather than inventing zero counts for the same store.
    const refusedStatus = await app.getStatus().then(() => null, (err) => err);
    assert.ok(refusedStatus, 'a store that cannot be read is not reported as an empty one');
    assert.equal(refusedStatus.code, 'STORE_UNAVAILABLE');

    // Giving the operator a real log at that path lets the same operation be recorded afterwards - the
    // damage never needed the operation to be repeated.
    fs.rmSync(LOG(dir), { recursive: true });
    const x = new ExperienceStore(LOG(dir), { now: CLOCK, operations: new OperationLog(OPS(dir)) });
    const { record } = await x.recordExperience({ operationId: operations[0].id, subject: 'recorded once the store was readable', origin: 'user' });
    assert.equal((await x.evidenceCheck(record.id)).ok, true);
    assert.equal(experiencesOf(dir).length, 1);
  });

  test('a capture that was never tried is silent, and one that was tried always says what happened', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    // Ineligible: nothing was attempted, so nothing is reported about it.
    const read = await app.controller.knowledgeList({ limit: 5 });
    assert.equal(read.display.includes('Experience'), false);
    // Eligible and refused by the store: named as a refusal, with the reason and the alternative.
    fs.appendFileSync(LOG(dir), 'this line is not a record\n');
    const damaged = await remember(app, 'the note whose capture was refused');
    assert.match(damaged.display, /Experience: not captured \(experience store contains 1 corrupt line\(s\)/);
    assert.match(damaged.display, /"experience record [0-9a-f-]{8,36}" asks for it explicitly/);
    // Eligible and succeeded: named as a capture, with the record id.
    fs.rmSync(LOG(dir));
    const clean = await remember(app, 'the note captured after the damage was cleared');
    assert.match(clean.display, /Experience: captured automatically as [0-9a-f]{8} from operation/);
    assert.equal(experiencesOf(dir).length, 1, 'clearing the damage did not replay the refused capture');
  });
});

describe('AA-5 feedback stays the user\'s and adaptations stay as they were', () => {
  test('§9 User feedback remains explicit: feedback on a captured experience is the user\'s own record', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const res = await remember(app, 'the note the user then judged');
    const [captured] = experiencesOf(dir);
    assert.ok(res.display.includes('captured automatically'));

    const feedback = await app.controller.feedbackRecord({
      target: captured.id, assessment: 'not_useful', guidance: 'put the date at the top', reason: null,
    });
    assert.equal(feedback.status, Outcome.SUCCESS_VERIFIED, feedback.display ?? feedback.output);
    assert.match(feedback.display, /captured automatically/, 'the reply says what kind of record it is about');
    assert.match(feedback.display, /this feedback is yours alone/);

    assert.deepEqual(kindsOf(dir), { experience: 1, feedback: 1 });
    const [written] = readRecords(LOG(dir)).filter((r) => r.kind === 'feedback');
    assert.equal(written.experienceId, captured.id);
    assert.equal(written.assessment, 'not_useful');
    assert.equal(written.provenance.origin, 'user_feedback', 'the assessment is authored by the user, not observed');

    const listed = await app.experience.list({ limit: 10 });
    assert.equal(listed[0].feedbackCount, 1);
    assert.deepEqual(listed[0].assessments, ['not_useful']);
    assert.equal(listed[0].capture, CAPTURE_AUTOMATIC, 'the experience is still a captured one');
  });

  test('§9 Automatic capture cannot generate user feedback: no assessment and no candidate from any number of captures', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await remember(app, `repeated note ${i} is held`);
      assert.match(res.display, /captured automatically/);
    }
    // Two operations that did not qualify, so the refusals are exercised in the same run.
    await app.controller.knowledgeRetract({ target: 'eeeeeeee', reason: 'no such record' });
    await app.controller.knowledgeList({ limit: 5 });

    const raw = readLines(LOG(dir)).join('\n');
    assert.equal(experiencesOf(dir).length, 4);
    for (const assessment of ASSESSMENTS) {
      // Only the field value counts: the word 'correct' also appears inside ordinary report text.
      assert.equal(raw.includes(`"assessment":"${assessment}"`), false, `APEX wrote no ${assessment} assessment`);
    }
    const health = await app.experience.health();
    assert.equal(health.feedback, 0, 'silence is not feedback, and success is not approval');
    assert.equal(health.decisions, 0);
    assert.equal(health.retirements, 0);
    assert.equal(health.adaptations, 0);
    assert.equal(health.activeAdaptations, 0);

    // Repeated successful captures in one scope still derive nothing.
    const derived = await app.experience.deriveAdaptations({ origin: 'user' });
    assert.deepEqual(derived.created, [], 'four experiences are not two corrective feedbacks');
    assert.deepEqual(kindsOf(dir), { experience: 4 });
    assert.deepEqual((await app.experience.activeAdaptations({ query: 'repeated note' })).adaptations, []);
    assert.equal((await app.experience.health()).attention, false, 'a healthy log of captures is not an alarm');
  });

  test('§9 Existing adaptations remain unchanged: the same support, the same approval, the same retirement', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    assert.equal(MIN_SUPPORT_FEEDBACK, 2, 'the threshold is the Batch Z constant');
    assert.equal(DERIVATION_METHOD, 'repeated_user_correction');

    await remember(app, 'the review date note one');
    await remember(app, 'the review date note two');
    const ids = experiencesOf(dir).map((r) => r.id);
    assert.equal(ids.length, 2);

    // One corrective feedback is not yet support for anything.
    await app.experience.recordFeedback({ target: ids[0], assessment: 'not_useful', guidance: 'put the date at the top', origin: 'user' });
    let derived = await app.experience.deriveAdaptations({ origin: 'user' });
    assert.deepEqual(derived.created, [], 'one feedback does not reach the threshold with capture on');

    // The second one does, exactly as in Batch Z - and only because the user wrote both.
    await app.experience.recordFeedback({ target: ids[1], assessment: 'user_correction', guidance: 'put the date at the top', origin: 'user' });
    derived = await app.experience.deriveAdaptations({ origin: 'user' });
    assert.equal(derived.created.length, 1);
    const candidate = derived.created[0];
    assert.equal(candidate.capability, 'memory.add');
    assert.deepEqual([...candidate.support.experienceIds].sort(), [...ids].sort());
    // The written record is the candidate itself: a decision state is derived from the decisions
    // appended after it, so the appended record carries the derivation constants instead.
    assert.equal(candidate.kind, 'adaptation');
    assert.equal(candidate.method, DERIVATION_METHOD);
    assert.equal(candidate.minSupport, MIN_SUPPORT_FEEDBACK);
    assert.equal((await app.experience.adaptationDetail(candidate.id)).decisionState, 'candidate', 'no decision has been recorded, so it is a candidate');
    assert.equal((await app.experience.adaptationDetail(candidate.id)).active, false);

    // Still inert: a candidate derived from captured experiences changes nothing until the user
    // decides, and only a decision can make it so.
    assert.deepEqual((await app.experience.activeAdaptations({ query: 'put the date at the top' })).adaptations, []);
    const beforeApproval = readLines(LOG(dir)).length;
    const approved = await app.controller.adaptationDecide({ target: candidate.id, decision: 'approved', reason: 'yes, do that' });
    assert.equal(approved.status, Outcome.SUCCESS_VERIFIED, approved.display ?? approved.output);
    assert.ok(readLines(LOG(dir)).length > beforeApproval, 'the decision is appended next to the candidate, not written into it');
    assert.equal((await app.experience.adaptationDetail(candidate.id)).decisionState, 'approved');
    assert.equal((await app.experience.activeAdaptations({ query: 'put the date at the top' })).adaptations.length, 1);

    // A capture can never undo that: the next verified operation adds an experience and no other kind.
    const counts = kindsOf(dir);
    await remember(app, 'a third note after the approval');
    const after = kindsOf(dir);
    assert.equal(after.experience, counts.experience + 1);
    for (const kind of Object.keys(after)) {
      if (kind !== 'experience') assert.equal(after[kind], counts[kind], `${kind} records are not touched by capture`);
    }

    // Retirement still works on a rule derived from captured experiences, and excludes it without
    // deleting anything.
    const retired = await app.experience.retireAdaptation({ target: candidate.id, reason: 'no longer wanted', origin: 'user' });
    assert.ok(retired.record.id);
    assert.equal((await app.experience.adaptationDetail(candidate.id)).decisionState, 'retired');
    assert.deepEqual((await app.experience.activeAdaptations({ query: 'put the date at the top' })).adaptations, []);
    assert.ok(readLines(LOG(dir)).length > beforeApproval, 'the log only ever grew');
  });

  test('a model still cannot approve, derive, or judge a captured experience', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const res = await remember(app, 'the note a model must not judge');
    const [captured] = experiencesOf(dir);

    const attempts = [
      ['feedback.record', { target: captured.id, assessment: 'useful', guidance: 'keep doing that' }],
      ['adaptation.derive', {}],
      ['adaptation.decide', { target: captured.id, decision: 'approved' }],
    ];
    for (const [name, input] of attempts) {
      // eslint-disable-next-line no-await-in-loop
      const step = await app.controller.runAction(name, input, 'model', `op-model-${name}`);
      assert.equal(step.outcome, Outcome.ACTION_DENIED, `${name} must stay denied to a model proposal`);
      assert.equal(step.authorization.decision, 'deny');
      assert.equal(step.execution.status, 'not_run');
      assert.equal(app.registry.get(name).plannable, false, `${name} must not appear in a model plan`);
    }
    // The capture happened because the user armed the setting; the record's provenance is the fixed
    // value the store gives a captured experience, so no request can set it free-form.
    assert.equal(captured.provenance.origin, 'system_observed');
    assert.equal(res.operation.steps[0].authorization.decision, 'allow', 'the original write was the user\'s own request');
    assert.deepEqual(kindsOf(dir), { experience: 1 });
    assert.deepEqual(await app.experience.adaptations({ limit: 5 }), [], 'and nothing was derived or approved behind the refusals');
  });
});

describe('AA-6 one validated setting, off by default', () => {
  test('§9 Capture disabled: the default records nothing automatically and says so', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK });
    const res = await remember(app, 'the note with capture off');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
    assert.equal(res.display.includes('Experience:'), false, 'an operation that captured nothing says nothing about experiences');
    assert.equal(fs.existsSync(LOG(dir)), false, 'the store is not even opened');

    // Explicitly off behaves the same as unset.
    const off = appFor(dir, CAPTURE_OFF);
    const second = await remember(off, 'the note with off set');
    assert.equal(second.display.includes('Experience:'), false);
    assert.equal(fs.existsSync(LOG(dir)), false);

    // Health reports the setting it actually holds, and the explicit route still works.
    const health = await off.controller.experienceHealth();
    assert.match(health.display, /Capture:\s+off: an experience is written only when you record one/);
    const op = auditOf(dir).at(-1);
    const recorded = await off.controller.experienceRecord({ operationId: op.id, subject: 'recorded by hand with capture off' });
    assert.equal(recorded.status, Outcome.SUCCESS_VERIFIED, recorded.display ?? recorded.output);
    const [manual] = experiencesOf(dir);
    assert.equal(manual.provenance.origin, 'user_recorded');
    const listed = await off.controller.experienceList({ limit: 5 });
    assert.match(listed.display, /recorded by you/);

    // The CLI states the same thing from the setting its own process holds.
    const cliHealth = await runCli(['experience', 'health'], envFor(dir, CAPTURE_OFF));
    assert.equal(cliHealth.code, 0, `${cliHealth.stdout}${cliHealth.stderr}`);
    assert.match(cliHealth.stdout, /Capture:\s+off: an experience is written only when you record one/);
  });

  test('§9 Capture configuration malformed: a mistyped value is refused at startup and writes nothing', async () => {
    const dir = tempDir();
    const run = await runCli(['ask', 'remember that the note behind a typo'], envFor(dir, 'verifed-sucess'));
    assert.equal(run.code, 2, `${run.stdout}${run.stderr}`);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /APEX_EXPERIENCE_CAPTURE must be one of: off, verified-success/);
    assert.match(run.stderr, /No data was read or changed/);
    assert.deepEqual(fs.readdirSync(dir), [], 'a refused setting opens no store at all');

    // A value that names some other setting's mode is refused too, so a misspelling can never
    // silently change what APEX writes.
    for (const bad of ['true', '1', 'on', 'verified_success', 'always']) {
      const other = tempDir();
      // eslint-disable-next-line no-await-in-loop
      const attempt = await runCli(['ask', `remember that the note behind ${bad}`], envFor(other, bad));
      assert.equal(attempt.code, 2, `${bad}: ${attempt.stdout}${attempt.stderr}`);
      assert.deepEqual(fs.readdirSync(other), [], `${bad} opened no store`);
    }

    // An empty value is the documented default rather than an error.
    const empty = await runCli(['ask', 'remember that the note behind an empty value'], envFor(dir, ''));
    assert.equal(empty.code, 0, `${empty.stdout}${empty.stderr}`);
    assert.equal(empty.stdout.includes('Experience:'), false);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('experiences')), []);
  });

  test('the setting is case and space insensitive, applies after a restart, and an unusable value behaves as off', async () => {
    const dir = tempDir();
    const loose = await runCli(['ask', 'remember that the loosely spelled setting'], envFor(dir, '  VERIFIED-Success '));
    assert.equal(loose.code, 0, `${loose.stdout}${loose.stderr}`);
    assert.match(loose.stdout, /captured automatically/);
    assert.equal(experiencesOf(dir).length, 1);

    // A second process with no setting at all stops capturing: the switch applies to each start, and
    // nothing about a previous run is assumed.
    const restartedOff = await runCli(['ask', 'remember that the note after switching off'], envFor(dir, null));
    assert.equal(restartedOff.code, 0, `${restartedOff.stdout}${restartedOff.stderr}`);
    assert.equal(restartedOff.stdout.includes('Experience:'), false);
    assert.equal(experiencesOf(dir).length, 1, 'the earlier capture stays, no new one appears');
    const healthOff = await runCli(['experience', 'health'], envFor(dir, null));
    assert.match(healthOff.stdout, /Capture:\s+off: an experience is written only when you record one/);
    assert.match(healthOff.stdout, /How recorded:\s+0 recorded by you, 1 captured automatically/);

    // A restart with the setting armed captures again, from the state on disk and nothing else.
    const restartedOn = await runCli(['ask', 'remember that the note after switching back on'], envFor(dir));
    assert.equal(restartedOn.code, 0, `${restartedOn.stdout}${restartedOn.stderr}`);
    assert.match(restartedOn.stdout, /captured automatically/);
    assert.equal(experiencesOf(dir).length, 2);

    // A value the application holds that is not a mode is reported as a setting that did not take
    // effect, never folded in with off.
    assert.match(captureSettingPhrase('sometimes'), /set to "sometimes", which APEX does not recognize/);
    assert.match(captureSettingPhrase('sometimes'), /valid values: off, verified-success/);
    assert.equal(captureSettingPhrase(null), 'off: an experience is written only when you record one');
    assert.equal(captureSettingPhrase(undefined), 'off: an experience is written only when you record one');
    assert.equal(captureSettingPhrase(CAPTURE_OFF), 'off: an experience is written only when you record one');
    assert.match(captureSettingPhrase(CAPTURE_VERIFIED_SUCCESS), /on for verified successful operations/);
    assert.match(captureSettingPhrase(CAPTURE_VERIFIED_SUCCESS), /no assessment of it/);
    const refused = autoCaptureDecision(
      { id: 'op-1', origin: 'user', status: Outcome.SUCCESS_VERIFIED, capability: 'memory.add', steps: [{ summary: 'stored' }] },
      { mode: 'sometimes' },
    );
    assert.equal(refused.eligible, false);
    assert.match(refused.reason, /set to sometimes/);

    // A non-string handed to the application is not a mode either; it behaves as off rather than as a
    // truthy "on".
    const odd = createApp({ dataDir: tempDir(), now: CLOCK, experienceCapture: true });
    const oddRes = await remember(odd, 'the note behind a non-string setting');
    assert.equal(oddRes.display.includes('Experience:'), false);
    assert.equal(odd.controller.experienceCapture, CAPTURE_OFF);
  });

  test('a record whose capture provenance names no writer is reported, never re-labelled', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const res = await remember(app, 'the note with a forged provenance');
    const [record] = experiencesOf(dir);
    assert.equal(record.provenance.origin, 'system_observed');

    // Rewrite the provenance to something no writer produces. APEX must not quietly present the
    // record as one the user recorded: the reader refuses to treat the log as complete and names the
    // line that cannot be attributed.
    const lines = readLines(LOG(dir));
    const damaged = { ...record, provenance: { ...record.provenance, origin: 'who_knows' } };
    lines[0] = JSON.stringify(damaged);
    fs.writeFileSync(LOG(dir), `${lines.join('\n')}\n`);
    const before = fs.readFileSync(LOG(dir), 'utf8');

    // The derivation itself never guesses: a provenance outside the two writer-produced origins is
    // the unknown value, and is never folded in with `explicit`.
    assert.equal(captureOf(damaged), CAPTURE_UNKNOWN);
    assert.equal(captureOf(record), CAPTURE_AUTOMATIC);

    const listRefused = await app.experience.list({ limit: 5 }).then(() => null, (err) => err);
    assert.ok(listRefused, 'an unattributable record stops the reader rather than being relabelled');
    assert.match(listRefused.message, /corrupt line/);
    const health = await app.experience.health();
    assert.equal(health.state, 'damaged');
    assert.equal(health.corruptLines, 1);
    assert.match(health.corrupt[0].reason, /provenance origin must be user_recorded or system_observed/);
    assert.equal(health.capturedAutomatically, 0, 'the damaged record is not counted as a capture');
    assert.equal(health.unknownCapture, 0, 'and no count is claimed for a record that cannot be read');
    assert.equal(health.attention, true);

    const evidenceRefused = await app.experience.evidenceCheck(record.id).then(() => null, (err) => err);
    assert.ok(evidenceRefused, 'the event cannot be re-checked while its record cannot be read');

    const healthView = await app.controller.experienceHealth();
    assert.match(healthView.display, /Store:\s+damaged - 1 corrupt line\(s\); inspection incomplete/);
    assert.match(healthView.display, /provenance origin must be user_recorded or system_observed/);
    assert.match(healthView.display, /Inspection:\s+incomplete/);
    assert.equal(fs.readFileSync(LOG(dir), 'utf8'), before, 'reporting the anomaly did not rewrite it');

    // Repair is the operator's decision: once the line is restored, the same record re-checks against
    // the audit log, so nothing else in the store had been touched.
    fs.writeFileSync(LOG(dir), `${JSON.stringify(record)}\n`);
    assert.equal((await app.experience.evidenceCheck(record.id)).ok, true);
    assert.equal((await app.experience.health()).state, 'ok');

    // A writer can only choose between the two real values, so the field that says how a record
    // arrived cannot be set free-form - not even by a user-origin request.
    for (const capture of ['who_knows', null, true, 'explicit-but-claimed']) {
      // eslint-disable-next-line no-await-in-loop
      const attempt = await app.experience.recordExperience({
        operationId: res.operation.id, subject: 'an experience with an invented capture value', capture, origin: 'user',
      }).then(() => null, (err) => err);
      assert.ok(attempt, `capture=${String(capture)} must be refused`);
      assert.match(attempt.message, /either explicit or automatic captured/);
    }
    assert.equal(experiencesOf(dir).length, 1, 'the refused writes appended nothing');

    // And the automatic route cannot be claimed by an ordinary caller passing origin alone: the
    // store's permission check is about who authorized the write, and the record keeps saying who
    // observed the event.
    const asUser = await app.experience.recordExperience({
      operationId: res.operation.id, subject: 'a second attempt at the same event', capture: CAPTURE_AUTOMATIC, origin: 'user',
    }).then(() => null, (err) => err);
    assert.equal(asUser.code, 'EXPERIENCE_EXISTS', 'the duplicate is refused before any provenance is written');
  });
});

describe('AA-7 privacy, provenance, and read-only operation', () => {
  test('§9 Privacy and secret redaction: a credential is refused everywhere and no conversation text is copied', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const secret = 'supersecretpass123';
    const asked = await app.controller.handle(`remember that my password is ${secret}`, { origin: 'user' });
    assert.equal(asked.status, Outcome.INPUT_REJECTED);
    assert.match(asked.display, /looks like a password, key, or token/);
    assert.equal(asked.display.includes('Experience:'), false);

    // The credential appears nowhere on disk, in any log.
    const onDisk = [OPS(dir), path.join(dir, 'memory.jsonl'), LOG(dir)]
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('');
    assert.equal(onDisk.includes(secret), false, 'a credential never reaches the logs');
    assert.equal(experiencesOf(dir).length, 0);

    // A secret-shaped account of an event is refused by the capture decision even if a step summary
    // ever carried one, because the experience log is a second place content could be exposed.
    const real = (await remember(app, 'the ordinary note')).operation;
    const leaked = {
      ...real,
      steps: real.steps.map((step) => ({ ...step, summary: 'stored api_key: sk-abcdefghijklmnopqrstuvwx' })),
    };
    const refused = autoCaptureDecision(leaked, { mode: CAPTURE_VERIFIED_SUCCESS });
    assert.equal(refused.eligible, false);
    assert.match(refused.reason, /password, key, or token/);
    const ordinary = autoCaptureDecision(
      { ...real, steps: real.steps.map((step) => ({ ...step, summary: 'stored the note about the api key rotation' })) },
      { mode: CAPTURE_VERIFIED_SUCCESS },
    );
    assert.equal(ordinary.eligible, true, 'an ordinary mention of a key is not a credential');

    // A control character in an account of the event is refused: it would reach a terminal report and
    // a later reader as escape bytes rather than as text. (A line break cannot forge a record, because
    // the append is JSON-encoded, so the guard here is the control character itself.)
    const injected = autoCaptureDecision(
      { ...real, steps: real.steps.map((step) => ({ ...step, summary: 'stored a note\u0001{"kind":"feedback","assessment":"useful"}' })) },
      { mode: CAPTURE_VERIFIED_SUCCESS },
    );
    assert.equal(injected.eligible, false);
    assert.match(injected.reason, /control characters/);
    const multiline = autoCaptureDecision(
      { ...real, steps: real.steps.map((step) => ({ ...step, summary: 'stored a note\n{"kind":"feedback"}' })) },
      { mode: CAPTURE_VERIFIED_SUCCESS },
    );
    assert.equal(multiline.eligible, true, 'a line break in the account is escaped by the append, not a second record');

    // And the whole log holds no request or output text: an experience is a reference, not a copy.
    for (const record of experiencesOf(dir)) {
      assert.equal(record.request, undefined);
      assert.equal(record.output, undefined);
      assert.equal(record.evidence.request, undefined, 'the copied evidence is the structural subset');
      assert.equal(record.evidence.output, undefined);
      assert.equal(JSON.stringify(record).includes('ordinary note'), false);
    }
  });

  test('§9 Read-only diagnostics: health, status and diagnose write nothing and state the setting', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const res = await remember(app, 'the note the diagnostics will describe');
    assert.match(res.display, /captured automatically/);
    const [experience] = experiencesOf(dir);

    for (const args of [['experience', 'health'], ['status'], ['diagnose'], ['audit', 'health'], ['memory', 'health'], ['knowledge', 'health']]) {
      const before = snapshot(dir);
      // eslint-disable-next-line no-await-in-loop
      const run = await runCli(args, envFor(dir));
      assert.equal(run.stderr, '', `${args.join(' ')}: ${run.stderr}`);
      assert.deepEqual(snapshot(dir), before, `"apex ${args.join(' ')}" wrote nothing, with capture armed`);
    }

    const health = await runCli(['experience', 'health'], envFor(dir));
    assert.equal(health.code, 0, `${health.stdout}${health.stderr}`);
    assert.match(health.stdout, /Experience health \(read-only; derived from stored records; nothing is repaired or approved\)/);
    assert.match(health.stdout, /Capture:\s+on for verified successful operations: an experience of the outcome is written, and no assessment of it/);
    assert.match(health.stdout, /How recorded:\s+0 recorded by you, 1 captured automatically/);
    assert.match(health.stdout, /Evidence:\s+1\/1 recent experience\(s\) re-verified against the audit log/);

    const diagnose = await runCli(['diagnose'], envFor(dir));
    assert.equal(diagnose.code, 0, `${diagnose.stdout}${diagnose.stderr}`);
    assert.match(diagnose.stdout, /automatic capture on for verified successful operations/);
    assert.match(diagnose.stdout, /experience record\(s\) \(0 recorded by you, 1 captured automatically\)/);

    const status = await runCli(['status'], envFor(dir));
    assert.match(status.stdout, /Experience capture: on for verified successful operations/);
    assert.match(status.stdout, /0 recorded by you, 1 captured automatically/);

    // A show of the captured record names how it arrived, so the reader is never left to guess.
    const shown = await runCli(['experience', 'show', experience.id], envFor(dir));
    assert.equal(shown.code, 0, `${shown.stdout}${shown.stderr}`);
    assert.match(shown.stdout, /captured automatically/);
    assert.deepEqual(kindsOf(dir), { experience: 1 }, 'none of the read-only surface appended a record');
  });

  test('audited readers are recorded as operations, never as experiences', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    await remember(app, 'the note the readers will list');
    const captured = experiencesOf(dir).length;
    const opsBefore = auditOf(dir).length;

    const listed = await app.controller.experienceList({ limit: 10 });
    assert.equal(listed.status, Outcome.SUCCESS_VERIFIED, listed.display ?? listed.output);
    assert.match(listed.display, /captured automatically/);
    const adapted = await app.controller.adaptationList({ limit: 10 });
    assert.equal(adapted.status, Outcome.SUCCESS_VERIFIED, adapted.display ?? adapted.output);

    assert.ok(auditOf(dir).length > opsBefore, 'the reads themselves are audited');
    assert.equal(experiencesOf(dir).length, captured, 'and none of that bookkeeping became an experience');
    assert.deepEqual(kindsOf(dir), { experience: 1 });
    for (const op of auditOf(dir).slice(opsBefore)) {
      assert.equal(AUTO_CAPTURE_CAPABILITIES.includes(op.capability), false, `${op.capability} must stay outside the subset`);
    }
  });

  test('§8 the CLI, status and diagnose recommend no local inference server', async () => {
    const dir = tempDir();
    const env = envFor(dir);
    const runs = await Promise.all([
      runCli(['help'], env),
      runCli(['status'], env),
      runCli(['diagnose'], env),
      runCli(['experience', 'health'], env),
      runCli(['status', '--model'], env),
    ]);
    for (const run of runs) {
      assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
      for (const pattern of [/ollama pull/i, /llama-server/i, /LM Studio/i, /\bollama serve\b(?!r)/i, /install(?:ing)? ollama/i, /download a model/i]) {
        assert.doesNotMatch(run.stdout, pattern, `the surface must not point at a local inference server: ${pattern}`);
      }
    }
    // The wording is line-wrapped in the help output, so the sentence is matched across its break.
    assert.match(runs[0].stdout, /does\s+not install, download, start, or recommend a model server/);
    assert.match(runs[0].stdout, /APEX_EXPERIENCE_CAPTURE/);
    assert.match(runs[0].stdout, /off \(default\) or verified-success/);
    // With no endpoint configured, every surface says exactly that and offers no way to obtain a
    // model: no instruction to install, start, pull or download one appears anywhere above.
    assert.match(runs[2].stdout, /Model: not configured \(non-model functions are available\)/);
    assert.match(runs[4].stdout, /Model backend: none configured\. Non-model functions are available\./);
  });
});

