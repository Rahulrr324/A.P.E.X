// Batch AF / AF-22: the finalization contract on the completion paths Batch AB and AF-15 left
// unwalked.
//
// `finalizeOperation()` owns steps 3-6 of the contract (append the audit record, establish whether
// that append succeeded, attempt capture, verify the capture), and Batch AB pinned its order,
// separation and idempotence (finalization-contract.test.js), its interruption boundaries
// (finalization-interruption.test.js). AF-15 then walked all five declared completion paths with
// the audit append refusing, and proved none of them can leave an unqualified verified-success
// claim. This file does not repeat those, and changes no semantics; it closes the four gaps that
// the earlier files did not reach:
//
//   prediction operations   a prediction record, a verdict and a withdrawal are all verified,
//                           user-origin, fully-audited successes - exactly the shape that gets
//                           captured - and must still produce no experience, with the ledger and
//                           the audit log as the only files that grow;
//   error-bearing successes an operation may verify its own side effect and still carry a recorded
//                           failure from another store; capture is then refused for want of
//                           complete audit evidence, and the manual path must still work;
//   duplicate finalization  the guard has to hold on each of the four controller-audited paths, on
//                           the real returned operation, and must leave no trace on the record;
//   claim vs record         what each path returns has to be what operations.jsonl holds, field by
//                           field, including the task runner's own per-step records, whose status is
//                           the task log's step outcome.
//
// Nothing here contacts a model, starts a service, or downloads anything. Failures are injected by
// replacing one function on the real store instance, and every claim about what a file does not
// contain is read back from that file rather than from a rendered string.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { finalizeOperation } from '../src/controller/finalization.js';
import {
  AUTO_CAPTURE_CAPABILITIES,
  CAPTURE_EXCLUDED_CAPABILITIES,
  CAPTURE_EXCLUSION_CATEGORIES,
  CAPTURE_VERIFIED_SUCCESS,
  autoCaptureDecision,
} from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const FILE = (dir, name) => path.join(dir, name);
const OPS = (dir) => FILE(dir, 'operations.jsonl');
const LOG = (dir) => FILE(dir, 'experiences.jsonl');
const PRED = (dir) => FILE(dir, 'predictions.jsonl');

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}
const auditOf = (dir) => readRecords(OPS(dir));
const memoryOf = (dir) => readRecords(FILE(dir, 'memory.jsonl'));
const knowledgeOf = (dir) => readRecords(FILE(dir, 'knowledge.jsonl'));
const experiencesOf = (dir) => readRecords(LOG(dir)).filter((r) => r.kind === 'experience');
const feedbackOf = (dir) => readRecords(LOG(dir)).filter((r) => r.kind === 'feedback');
const predictionsOf = (dir) => readRecords(PRED(dir));
const auditIds = (dir) => auditOf(dir).map((r) => r.id);

const bytesOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
// A store the operation did not touch is byte-identical; one it did touch can only have grown,
// because every one of these logs is append-only.
const grown = (before, file) => { const after = bytesOf(file); return after.startsWith(before) && after.length > before.length; };

// The nine persistent files, in the order the sweep reports them.
const ALL_FILES = Object.freeze([
  'memory.jsonl', 'conversation.jsonl', 'operations.jsonl', 'session.json', 'tasks.jsonl',
  'task-summary-queue.json', 'knowledge.jsonl', 'experiences.jsonl', 'predictions.jsonl',
]);
const snapshot = (dir) => Object.fromEntries(ALL_FILES.map((name) => [name, bytesOf(FILE(dir, name))]));
const changedFiles = (before, dir) => ALL_FILES.filter((name) => bytesOf(FILE(dir, name)) !== before[name]);

// A clock the test can move: an evaluation decides from experiences dated after the expectation, so
// on a frozen clock the deciding event is never inside the horizon and no verdict is reachable.
function clock(start) {
  let ms = Date.parse(start);
  return Object.assign(() => new Date(ms), {
    iso: () => new Date(ms).toISOString(),
    advance(days) { ms += days * 86_400_000; },
  });
}

// Capture armed to the only mode that captures, so every test in this file runs against the
// behaviour a user who switched it on would get.
function armed(dir, now = clock('2026-02-03T09:00:00.000Z')) {
  return { now, app: createApp({ dataDir: dir, now, experienceCapture: CAPTURE_VERIFIED_SUCCESS }) };
}

const remember = (app, note) => app.controller.handle(`remember that ${note}`, { origin: 'user' });
const lastMemoryId = (dir) => memoryOf(dir).at(-1).id;

async function expectArm(dir, app, note = 'the survey depth is nine metres') {
  const before = experiencesOf(dir).length;
  const res = await remember(app, note);
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
  assert.equal(experiencesOf(dir).length, before + 1, 'capture is armed: an eligible write was captured');
  return res;
}

// The step evidence a capture needs, read from the operation the controller returned.
function assertStepStands(step, where) {
  assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, `${where}: step outcome`);
  assert.equal(step.authorization?.decision, 'allow', `${where}: step authorization`);
  assert.equal(step.execution?.status, 'ok', `${where}: step execution`);
  assert.equal(step.verification?.outcome, Outcome.SUCCESS_VERIFIED, `${where}: step verification`);
}

// A refusal has to be about the capability and nothing else. Re-running the same record with a
// capability from the subset proves the rest of the operation was capture-shaped: otherwise a test
// that only saw "not eligible" could not tell a designed exclusion from a broken fixture.
function refusalIsOnlyAboutCapability(op) {
  const decision = autoCaptureDecision(op, { mode: CAPTURE_VERIFIED_SUCCESS, recorded: true });
  assert.equal(decision.eligible, false, `${op.capability}: expected refusal`);
  assert.match(decision.reason, /^capability prediction\.[a-z]+ is outside the automatic capture subset$/, decision.reason);
  const otherwise = { ...op, capability: 'memory.add' };
  const swapped = autoCaptureDecision(otherwise, { mode: CAPTURE_VERIFIED_SUCCESS, recorded: true });
  assert.equal(swapped.eligible, true, `${op.capability} refused for some reason besides its capability: ${swapped.reason}`);
  assert.equal(CAPTURE_EXCLUDED_CAPABILITIES[op.capability], 'expectation', `${op.capability} is not classified as a ledger operation`);
  assert.ok(CAPTURE_EXCLUSION_CATEGORIES.expectation, 'the stated category exists in the inventory');
}

const CAPABILITY_ORDER = Object.freeze(['request', 'memory-correction', 'command', 'task-operation']);

// One real operation per controller-audited path. The fifth declared path (task-step) is audited by
// the runner and is walked in the claim/record test rather than through the finalizer.
const DRIVERS = Object.freeze({
  request: (app) => remember(app, 'the deployment window is held'),
  'memory-correction': async (app, dir) => {
    // A correction is accepted only when the replacement contradicts the claim it replaces, so the
    // fixture uses the shape the store's clause rule accepts; a refused correction would test the
    // finalization of a failure rather than of a verified write.
    await remember(app, 'the deployment window is held');
    return app.controller.correctMemory({ targetId: lastMemoryId(dir), content: 'the deployment window is postponed', resolve: true });
  },
  command: (app) => app.controller.knowledgeAdd({ subject: 'release', relationship: 'moved to', object: 'Monday' }),
  'task-operation': async (app) => {
    const planned = await app.controller.planTask('calc 2+2; calc 3+3');
    assert.equal(planned.status, Outcome.PLAN_CREATED, planned.display);
    return app.controller.runTask(planned.task.id);
  },
});

describe('AF-22 1: a prediction operation is never captured, even when capture is armed', () => {
  test('recording an expectation is a verified, audited success that writes no experience', async () => {
    const dir = tempDir();
    const { app } = armed(dir);
    await expectArm(dir, app);
    const experiencesBefore = bytesOf(LOG(dir));

    const res = await app.controller.predictionRecord({
      capability: 'memory.add',
      expectation: 'success',
      subject: 'the next survey will be recorded',
      inDays: 7,
    });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    assert.equal(res.recorded, true, 'the expectation has its own audit record');
    assert.doesNotMatch(res.display, /Experience:/, 'nothing was attempted, so no line claims a capture');
    assertStepStands(res.operation.steps[0], 'prediction.record');
    refusalIsOnlyAboutCapability(res.operation);
    assert.equal(AUTO_CAPTURE_CAPABILITIES.includes('prediction.record'), false);

    assert.deepEqual(experiencesOf(dir).map((r) => r.capability), ['memory.add']);
    assert.equal(bytesOf(LOG(dir)), experiencesBefore, 'the experience log gained nothing at all');
    assert.equal(feedbackOf(dir).length, 0, 'and no feedback was invented alongside it');
    assert.deepEqual(predictionsOf(dir).map((r) => r.kind), ['prediction']);
    assert.deepEqual(auditOf(dir).map((r) => `${r.capability}/${r.status}`), [
      'memory.add/success_verified', 'prediction.record/success_verified',
    ]);
  });

  test('an evaluation that reaches a verdict captures nothing about itself', async () => {
    const dir = tempDir();
    const { app, now } = armed(dir);
    await expectArm(dir, app);
    const predicted = await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success', subject: 'the next survey will be recorded', inDays: 7,
    });
    const target = predicted.operation.steps[0].result.data.id;

    // The event the verdict is computed from: a later verified write, captured on its own merits.
    now.advance(1);
    await expectArm(dir, app, 'the second survey is complete');
    const before = snapshot(dir);
    const experiencesBefore = bytesOf(LOG(dir));

    const res = await app.controller.predictionEvaluate({ target });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    assert.match(res.output, /evaluated as matched/, 'a verdict was reached, so this is not a vacuous pass');
    assert.equal(res.recorded, true);
    assert.doesNotMatch(res.display, /Experience:/);
    assertStepStands(res.operation.steps[0], 'prediction.evaluate');
    refusalIsOnlyAboutCapability(res.operation);

    assert.equal(bytesOf(LOG(dir)), experiencesBefore, 'the deciding experience is still the only evidence in that log');
    assert.deepEqual(changedFiles(before, dir), ['operations.jsonl', 'predictions.jsonl']);
    assert.deepEqual(predictionsOf(dir).map((r) => r.kind), ['prediction', 'prediction_evaluation']);
    assert.equal(auditIds(dir).filter((id) => id === res.operation.id).length, 1);
  });

  test('withdrawing an expectation is audited and stays outside the capture subset', async () => {
    const dir = tempDir();
    const { app } = armed(dir);
    await expectArm(dir, app);
    const predicted = await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success', subject: 'the next survey will be recorded', inDays: 7,
    });
    const experiencesBefore = bytesOf(LOG(dir));

    const res = await app.controller.predictionInvalidate({
      target: predicted.operation.steps[0].result.data.id,
      reason: 'the plan it rested on was replaced',
    });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    assert.equal(res.recorded, true);
    assert.doesNotMatch(res.display, /Experience:/);
    assertStepStands(res.operation.steps[0], 'prediction.invalidate');
    refusalIsOnlyAboutCapability(res.operation);

    assert.equal(bytesOf(LOG(dir)), experiencesBefore);
    assert.deepEqual(predictionsOf(dir).map((r) => r.kind), ['prediction', 'prediction_invalidation']);
    assert.deepEqual(auditOf(dir).map((r) => r.capability), [
      'memory.add', 'prediction.record', 'prediction.invalidate',
    ]);
  });

  test('three prediction operations in one armed session grow only the ledger and the audit log', async () => {
    const dir = tempDir();
    const { app, now } = armed(dir);
    await expectArm(dir, app);
    const predicted = await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success', subject: 'the next survey will be recorded', inDays: 7,
    });
    const target = predicted.operation.steps[0].result.data.id;
    now.advance(1);
    await expectArm(dir, app, 'the second survey is complete');

    const before = snapshot(dir);
    const evaluated = await app.controller.predictionEvaluate({ target });
    assert.equal(evaluated.status, Outcome.SUCCESS_VERIFIED, evaluated.display);
    const withdrawn = await app.controller.predictionInvalidate({ target, reason: 'superseded by a new plan' });
    assert.equal(withdrawn.status, Outcome.SUCCESS_VERIFIED, withdrawn.display);

    assert.deepEqual(changedFiles(before, dir), ['operations.jsonl', 'predictions.jsonl']);
    assert.ok(grown(before['operations.jsonl'], OPS(dir)), 'the audit log grew by the two new records');
    assert.ok(grown(before['predictions.jsonl'], PRED(dir)));
    assert.deepEqual(experiencesOf(dir).map((r) => r.capability), ['memory.add', 'memory.add'],
      'the two eligible writes from the fixture are the whole log; the ledger contributed nothing');
    assert.equal(feedbackOf(dir).length, 0);
    assert.deepEqual(auditOf(dir).map((r) => r.capability).slice(-2), ['prediction.evaluate', 'prediction.invalidate']);
  });
});

describe('AF-22 2: an operation that carries a recorded failure is not captured', () => {
  test('a verified write whose history turn could not be saved is audited, uncaptured, and still recordable by hand', async () => {
    const dir = tempDir();
    const { app } = armed(dir);
    const original = app.conversation.append.bind(app.conversation);
    app.conversation.append = async () => { throw new Error('injected: history refused'); };
    let res;
    try {
      res = await remember(app, 'the tide table is stale');
    } finally {
      app.conversation.append = original;
    }

    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, 'the memory write itself was verified');
    assert.equal(res.recorded, true, 'and its audit record was written');
    assert.equal(res.operation.errors.length, 1, 'the failure it did have is carried, not dropped');
    assert.equal(res.operation.errors[0].stage, 'conversation');
    assert.match(res.display, /could not be fully saved to conversation history/);
    assert.doesNotMatch(res.display, /Experience:/, 'a refused capture is not reported as an attempted one');

    const auditBefore = bytesOf(OPS(dir));
    const [line] = auditOf(dir);
    assert.equal(line.capability, 'memory.add');
    assert.equal(line.status, Outcome.SUCCESS_VERIFIED, 'the record says what its own verifier proved');
    assert.equal(line.errors.length, 1, 'and it carries the same failure the caller was told about');
    assert.equal(experiencesOf(dir).length, 0, 'incomplete audit evidence is not evidence for an experience');

    // The suppression is a refusal, not a dead end: the audit record exists, so the user can ask
    // for the experience and the store accepts it on its own read-back.
    const manual = await app.controller.experienceRecord({ operationId: res.operation.id, subject: 'memory.add: the tide table write' });
    assert.equal(manual.status, Outcome.SUCCESS_VERIFIED, manual.display);
    assert.equal(experiencesOf(dir).length, 1);
    assert.equal(experiencesOf(dir)[0].provenance.origin, 'user_recorded', 'the manual record is the user\'s, not a system capture');
    assert.equal(experiencesOf(dir)[0].operationId, res.operation.id);
    assert.equal(grown(auditBefore, OPS(dir)), true, 'the manual record added its own audit line');
    assert.deepEqual(auditOf(dir).map((r) => r.capability), ['memory.add', 'experience.record']);
  });

  test('the refusal reason is the attached failure, and the same record without it is eligible', async () => {
    const dir = tempDir();
    // Capture off, so the only thing under test is the decision itself and nothing is written.
    const app = createApp({ dataDir: dir, now: clock('2026-02-03T09:00:00.000Z') });
    const res = await remember(app, 'the anchor chain is nine metres');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    assert.equal(experiencesOf(dir).length, 0);

    const clean = autoCaptureDecision(res.operation, { mode: CAPTURE_VERIFIED_SUCCESS, recorded: true });
    assert.equal(clean.eligible, true, `the fixture is capture-shaped: ${clean.reason}`);
    assert.match(clean.subject, /^memory\.add: /);

    const withError = autoCaptureDecision(
      { ...res.operation, errors: [{ stage: 'conversation', code: 'STORE_ERROR', message: 'injected: history refused' }] },
      { mode: CAPTURE_VERIFIED_SUCCESS, recorded: true },
    );
    assert.equal(withError.eligible, false);
    assert.match(withError.reason, /^1 error\(s\) are attached to the operation/);
    assert.equal(withError.subject, undefined, 'a refused decision offers no subject to write');

    // The other half of the same rule, stated as data rather than prose: no audit record, no
    // experience - the record an experience is defined to reference has to exist first.
    const unrecorded = autoCaptureDecision(res.operation, { mode: CAPTURE_VERIFIED_SUCCESS, recorded: false });
    assert.equal(unrecorded.eligible, false);
    assert.match(unrecorded.reason, /the audit record could not be written/);
  });
});

describe('AF-22 3: duplicate finalization is refused on every controller-audited path', () => {
  test('a second finalization of the returned operation appends nothing and leaves no trace on the record', async () => {
    for (const id of CAPABILITY_ORDER) {
      const dir = tempDir();
      const { app } = armed(dir);
      const res = await DRIVERS[id](app, dir);
      const where = `path ${id}`;
      assert.equal(res.recorded, true, `${where}: the fixture needs its audit record`);
      const mine = auditOf(dir).filter((r) => r.id === res.operation.id);
      assert.equal(mine.length, 1, `${where}: one record for the operation`);

      const before = auditIds(dir);
      await assert.rejects(
        () => finalizeOperation(res.operation, {
          append: async () => { throw new Error('injected: a second record would be a duplicate'); },
          capture: async () => null,
        }),
        /was already finalized; a second audit record would duplicate it/,
        where,
      );
      assert.deepEqual(auditIds(dir), before, `${where}: the refused call wrote nothing`);

      // The guard is a symbol on the in-memory object. It must never reach the caller's record, a
      // JSONL line, or a reader that compares records field by field.
      assert.deepEqual(Object.getOwnPropertySymbols(res.operation).map(String), ['Symbol(apex.operation.finalized)']);
      assert.equal(Object.keys(res.operation).some((key) => /final/i.test(key)), false);
      assert.equal(Object.keys(mine[0]).some((key) => /final/i.test(key)), false);
      assert.equal(Object.keys(JSON.parse(JSON.stringify(res.operation))).some((key) => /final/i.test(key)), false);
    }
  });
});

describe('AF-22 4: what each path returns is what the audit log holds', () => {
  const CLAIM_FIELDS = Object.freeze([
    'id', 'capability', 'status', 'decision', 'origin', 'requestedAt', 'finishedAt', 'output', 'errors',
  ]);
  const evidenceOf = (steps) => steps.map((s) => ({
    outcome: s?.outcome,
    auth: s?.authorization?.decision,
    exec: s?.execution?.status,
    ver: s?.verification?.outcome,
    summary: s?.summary,
  }));

  test('each controller-audited path: the returned claim matches the persisted record field by field', async () => {
    for (const id of CAPABILITY_ORDER) {
      const dir = tempDir();
      const { app } = armed(dir);
      const res = await DRIVERS[id](app, dir);
      const where = `${id} (${res.operation.capability})`;
      const line = auditOf(dir).find((r) => r.id === res.operation.id);
      assert.ok(line, `${where}: a returned claim with no record on disk is an unrecorded success`);
      assert.equal(res.recorded, true, where);
      assert.equal(res.status, line.status, `${where}: what the caller was told is what the record says`);
      for (const field of CLAIM_FIELDS) {
        assert.deepEqual(line[field], res.operation[field], `${where}: ${field}`);
      }
      // Nothing in these fixtures is credential-shaped, so the comparison above is exact rather
      // than approximate - the record is the same claim, not a filtered version of it.
      assert.equal(line.secretsMasked, undefined, where);
      assert.equal(line.outputMinimized, undefined, where);
      assert.equal(line.auditMinimizationFailed, undefined, where);
      assert.deepEqual(evidenceOf(line.steps), evidenceOf(res.operation.steps), `${where}: step evidence`);
      // Only the terminal needed the rendered step text, and it is not on the record.
      for (const step of line.steps) assert.equal(step.display, undefined, `${where}: display text persisted`);
    }
  });

  test('the runner\'s per-step records state the outcome the task log holds for that step', async () => {
    const dir = tempDir();
    const { app } = armed(dir);
    const res = await DRIVERS['task-operation'](app, dir);
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    const task = await app.taskStore.get(res.task.id);
    assert.ok(task.steps.length >= 2, 'the fixture runs more than one step');

    const runLine = auditOf(dir).find((r) => r.id === res.operation.id);
    assert.equal(runLine.capability, 'task.run');
    assert.equal(runLine.task.id, task.id);
    assert.equal(runLine.task.status, task.status, 'the run record states the task state the log holds');

    for (const step of task.steps) {
      assert.equal(typeof step.operationId, 'string', `step ${step.id} claims no operation`);
      const mine = auditOf(dir).filter((r) => r.id === step.operationId);
      assert.equal(mine.length, 1, `step ${step.id} has exactly one audit record`);
      const line = mine[0];
      assert.equal(line.capability, 'task.step');
      assert.equal(line.status, step.outcome, `step ${step.id}: the record and the task log disagree`);
      assert.equal(line.task.id, task.id);
      assert.equal(line.task.stepId, step.id);
      assert.deepEqual(line.errors, [], 'the step record carries its own outcome, not a qualified one');
      // The step was audited but never captured: task.* is outside the subset, and one experience
      // per step would say less than the task log already says.
      assert.equal(experiencesOf(dir).filter((e) => e.operationId === step.operationId).length, 0);
    }
    assert.deepEqual(experiencesOf(dir), [], 'the whole task run produced no experience');
  });

  test('an experience store that refuses leaves a verified command and a verified correction verified', async () => {
    const dir = tempDir();
    const { app } = armed(dir);
    const original = app.experience.recordExperience.bind(app.experience);
    app.experience.recordExperience = async () => { throw new Error('injected: experience store refused'); };
    let command, correction;
    try {
      command = await app.controller.knowledgeAdd({ subject: 'release', relationship: 'moved to', object: 'Monday' });
      assert.equal(command.status, Outcome.SUCCESS_VERIFIED, command.display);
      const note = await remember(app, 'the manifest is sealed');
      assert.equal(note.status, Outcome.SUCCESS_VERIFIED, note.display);
      correction = await app.controller.correctMemory({ targetId: lastMemoryId(dir), content: 'the manifest is opened', resolve: true });
    } finally {
      app.experience.recordExperience = original;
    }
    assert.equal(correction.status, Outcome.SUCCESS_VERIFIED, correction.display);

    for (const [where, res] of [['command', command], ['memory-correction', correction]]) {
      assert.equal(res.recorded, true, `${where}: its own audit record was written`);
      assert.match(res.display, /Experience: not captured \(injected: experience store refused\)/, `${where}: ${res.display}`);
      assert.match(res.display, /succeeded and its audit record is unchanged/);
      assert.match(res.display, /"experience record [0-9a-f]{8}" asks for it explicitly/, `${where}: the remedy is named`);
      const line = auditOf(dir).find((r) => r.id === res.operation.id);
      assert.equal(line.status, Outcome.SUCCESS_VERIFIED, `${where}: a bookkeeping failure is not evidence against the operation`);
      assert.deepEqual(line.errors, [], `${where}: the capture failure was never written into the record as an operation error`);
      assert.equal(line.steps[0].verification.outcome, Outcome.SUCCESS_VERIFIED, `${where}: the independent verification still stands`);
    }
    assert.equal(experiencesOf(dir).length, 0, 'neither attempt wrote a line');
    assert.equal(feedbackOf(dir).length, 0);
    assert.equal(knowledgeOf(dir).length, 1, 'the command did have its side effect');
    assert.equal(memoryOf(dir).length, 2, 'and the correction replaced its record');

    // The same app, the same paths, a working store: the refusals above were the injection, not
    // eligibility. Without this control the test would pass for a broken fixture too.
    const after = snapshot(dir);
    const second = await app.controller.knowledgeAdd({ subject: 'release', relationship: 'delayed by', object: 'a day' });
    assert.equal(second.status, Outcome.SUCCESS_VERIFIED, second.display);
    const secondCorrection = await app.controller.correctMemory({
      targetId: lastMemoryId(dir), content: 'the manifest is broken', resolve: true,
    });
    assert.equal(secondCorrection.status, Outcome.SUCCESS_VERIFIED, secondCorrection.display);
    assert.match(secondCorrection.display, /Experience: captured automatically as [0-9a-f]{8}/);
    assert.deepEqual(experiencesOf(dir).map((r) => r.capability).sort(), ['knowledge.add', 'memory.correct']);
    // In ALL_FILES order: the two writes grew their own stores, their audit lines grew, and the
    // captures grew the experience log. Nothing else moved.
    assert.deepEqual(changedFiles(after, dir), ['memory.jsonl', 'operations.jsonl', 'knowledge.jsonl', 'experiences.jsonl']);
  });

  test('the audit record is already on disk when capture is attempted on the correction path too', async () => {
    const dir = tempDir();
    const { app } = armed(dir);
    const original = app.experience.recordExperience.bind(app.experience);
    const seen = [];
    app.experience.recordExperience = async (spec) => {
      // Read from the file, not from the operation: the claim is that the line was durable first.
      const line = readRecords(OPS(dir)).find((r) => r.id === spec.operationId);
      seen.push({ capability: line?.capability, status: line?.status, errors: line?.errors });
      return original(spec);
    };
    try {
      await remember(app, 'the manifest is sealed');
      const correction = await app.controller.correctMemory({
        targetId: lastMemoryId(dir), content: 'the manifest is opened', resolve: true,
      });
      assert.equal(correction.status, Outcome.SUCCESS_VERIFIED, correction.display);
      await app.controller.knowledgeAdd({ subject: 'manifest', relationship: 'was', object: 'countersigned' });
    } finally {
      app.experience.recordExperience = original;
    }
    assert.equal(seen.length, 3, 'all three capture paths were reached');
    assert.deepEqual(seen.map((s) => s.capability), ['memory.add', 'memory.correct', 'knowledge.add']);
    for (const call of seen) {
      assert.equal(call.status, Outcome.SUCCESS_VERIFIED, `${call.capability}: captured from an unfinished record`);
      assert.deepEqual(call.errors, [], `${call.capability}: the record was complete when capture read it`);
    }
    assert.deepEqual(experiencesOf(dir).map((r) => r.capability).sort(), ['knowledge.add', 'memory.add', 'memory.correct']);
  });
});
