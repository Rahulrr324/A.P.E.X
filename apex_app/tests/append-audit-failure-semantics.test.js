// AF-15: what an append failure does to what APEX is allowed to claim.
//
// The relationship this file tests is the one between six things that happen in a fixed order and
// are not one transaction:
//
//   side effect            a store append that changes what APEX knows (memory, knowledge,
//                          predictions) or what a task has done (the task log);
//   audit append           the operation's own record in operations.jsonl;
//   finalization           finalizeOperation(), which learns whether that append succeeded;
//   experience capture     attempted only with finalization's answer, and refused without a record;
//   prediction evaluation  computed from recorded outcomes, so it reads the logs instead of
//                          being told;
//   disclosure             what the user is shown, and what the exit code says.
//
// The requirement is narrow and absolute: no failure of the audit append, of experience capture, or
// of an evidence read may leave a verified-success claim standing unqualified. "Unqualified" means
// specifically: `recorded: false` alongside the status, a downgrade to `audit_integrity_failed`, or
// an outcome that never depended on the missing record in the first place.
//
// What this file does NOT claim, because it is not implemented and would be a false promise:
//   - atomicity. The side effect is committed before the audit append is even attempted, and an
//     audit failure never rolls it back. Tests here read the other store from inside the failing
//     append to prove that order rather than assume it.
//   - exactly-once execution. Nothing detects a repeated request after an audit failure, the audit
//     log has no unique index, and the in-process duplicate-finalize guard cannot cross a process
//     boundary. The disclosure says "that action may already have happened" instead.
//
// No test here contacts a model, starts a service, or touches real user data: every operation runs
// against an isolated temp data directory, and failures are injected either by replacing one
// function on the real audit store or by making the audit file itself unopenable.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { main, formatResult } from '../src/cli.js';
import { StoreError } from '../src/errors.js';
import { Outcome } from '../src/outcomes.js';
import { OPERATION_COMPLETION_PATHS } from '../src/controller/finalization.js';
import { CAPTURE_VERIFIED_SUCCESS } from '../src/experience/capture.js';

const CLOCK = () => new Date('2026-11-02T09:00:00.000Z');
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const file = (dir, name) => path.join(dir, name);
function readRecords(target) {
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return [];
  return fs.readFileSync(target, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}
const auditOf = (dir) => readRecords(file(dir, 'operations.jsonl'));
const memoryOf = (dir) => readRecords(file(dir, 'memory.jsonl'));
const knowledgeOf = (dir) => readRecords(file(dir, 'knowledge.jsonl'));
const experiencesOf = (dir) => readRecords(file(dir, 'experiences.jsonl')).filter((r) => r.kind === 'experience');
const predictionsOf = (dir) => readRecords(file(dir, 'predictions.jsonl'));
const evaluationsOf = (dir) => predictionsOf(dir).filter((r) => r.kind === 'prediction_evaluation');

// Replaces the audit store's append. `refuses` decides which records fail, so one test can break
// only the step records while the run's own record still lands - a different failure from losing
// both, and tested as one.
function armAuditFailure(app, refuses = () => true) {
  const original = app.operations.append.bind(app.operations);
  app.operations.append = async (record) => {
    if (refuses(record)) throw new StoreError(`injected: the audit log refused ${record.capability}`);
    return original(record);
  };
  return () => { app.operations.append = original; };
}

function capture() {
  return { text: '', write(chunk) { this.text += chunk; return true; } };
}
async function runThroughCli(app, dir, argv) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, {
    env: cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir }),
    stdout,
    stderr,
    stdin: { isTTY: false },
    appFactory: () => app,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

async function planAndReturnId(app, goal) {
  const planned = await app.controller.planTask(goal);
  assert.equal(planned.status, Outcome.PLAN_CREATED, planned.display);
  return planned.task.id;
}

async function rememberPrediction(app) {
  const res = await app.controller.predictionRecord({
    capability: 'race.ambiguous',
    expectation: 'success',
    subject: 'the release train leaves on Tuesday',
    inDays: 7,
  });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
  // The action's own read-back is the authority on the identifier: the store generated it.
  return res.operation.steps[0].result.data.id;
}

// ---- the shared invariant, walked over the declared completion paths -------------------------
//
// Each driver runs a real operation with its audit append refusing. `absent(dir, res, app)` lists
// the operation identifiers whose record must not be in the audit log afterwards, read back from
// disk rather than from what the call returned. The invariant is stated once and applied to all
// five, which is what makes "no path was forgotten" checkable.
const DRIVERS = Object.freeze({
  'request': {
    async run(app) { return app.controller.handle('remember that the shared invariant holds', { origin: 'user' }); },
    absent: (dir, res) => [res.operation.id],
  },
  'memory-correction': {
    async run(app, dir) {
      // A correction is only accepted when the replacement contradicts the selected claim, so the
      // fixture has to be one the store itself would write; a refused correction would test nothing.
      const note = await app.controller.handle('remember that the survey depth is nine metres', { origin: 'user' });
      assert.equal(note.status, Outcome.SUCCESS_VERIFIED, note.display);
      return app.controller.correctMemory({
        targetId: memoryOf(dir).at(-1).id,
        content: 'the survey depth is ten metres',
        resolve: true,
      });
    },
    absent: (dir, res) => [res.operation.id],
  },
  'command': {
    async run(app) { return app.controller.knowledgeAdd({ subject: 'ferry', relationship: 'departs', object: 'at six' }); },
    absent: (dir, res) => [res.operation.id],
  },
  'task-operation': {
    async run(app) { return app.controller.runTask(await planAndReturnId(app, 'calc 2+2; calc 3+3')); },
    absent: (dir, res) => [res.operation.id],
  },
  'task-step': {
    // Only the step records refuse here, so the run's own record is written and the failure has to
    // be carried by the run's status instead of by `recorded: false`.
    async run(app) { return app.controller.runTask(await planAndReturnId(app, 'calc 2+2; calc 3+3')); },
    refuses: (record) => record.capability === 'task.step',
    // The task log is an event log, so the step records are the ones the reconstructed task names.
    async absent(dir, res, app) {
      const task = await app.taskStore.get(res.task.id);
      const ids = task.steps.map((s) => s.operationId).filter(Boolean);
      assert.equal(ids.length, task.steps.length, 'the task log claims an operation for every step');
      return ids;
    },
  },
});

describe('AF-15 1: an audit-append failure never leaves a verified-success claim unqualified', () => {
  test('the paths walked here are exactly the paths the contract declares', () => {
    assert.deepEqual(Object.keys(DRIVERS), OPERATION_COMPLETION_PATHS.map((p) => p.id));
  });

  test('every completion path: the missing record stays missing, no experience is invented, and the claim is qualified', async () => {
    for (const entry of OPERATION_COMPLETION_PATHS) {
      const driver = DRIVERS[entry.id];
      const dir = tempDir();
      const app = createApp({ dataDir: dir, now: CLOCK, experienceCapture: CAPTURE_VERIFIED_SUCCESS });
      const restore = armAuditFailure(app, driver.refuses ?? (() => true));
      let res;
      try {
        res = await driver.run(app, dir);
      } finally {
        restore();
      }
      const where = `${entry.id} (${entry.entry})`;
      const absent = await driver.absent(dir, res, app);
      const ids = new Set(auditOf(dir).map((r) => r.id));

      // (a) An operation whose append failed has no record. Not a record that under-claims - none.
      for (const id of absent) {
        assert.ok(!ids.has(id), `${where}: ${id} is claimed as audited, but its append failed`);
      }
      // (b) Nothing on disk asserts a verified success for an operation this finalization could not
      //     record. A persisted `success_verified` line is evidence, and it must not exist here.
      assert.equal(
        auditOf(dir).filter((r) => r.status === Outcome.SUCCESS_VERIFIED && absent.includes(r.id)).length,
        0,
        `${where}: a persisted record claims verified success for an unrecorded operation`,
      );
      // (c) The returned claim is either downgraded, or it carries the answer that its record is
      //     absent. This is the one statement the whole batch has to keep true.
      assert.ok(
        res.status !== Outcome.SUCCESS_VERIFIED || res.recorded === false,
        `${where}: success_verified returned with recorded=${res.recorded}`,
      );
      if (res.recorded === false) {
        assert.equal(typeof res.recordError, 'string');
        assert.match(res.recordError, /injected: the audit log refused/, `${where}: the reason is not the caller's`);
      }
      // (d) Capture is attempted with finalization's answer, so an unrecorded operation cannot
      //     become an experience: the record an experience is defined to reference does not exist.
      assert.equal(experiencesOf(dir).length, 0, `${where}: an experience was written for an unrecorded operation`);
      assert.doesNotMatch(res.display ?? '', /Experience: captured/, `${where}: the disclosure claims a capture`);
      // (e) The disclosure is produced from both results, so it tells the operator not to repeat.
      if (res.recorded === false) {
        assert.match(formatResult(res), /Do not repeat the request just to obtain a record/);
      }
    }
  });
});

describe('AF-15 2: the side effect is committed before the audit append is attempted', () => {
  test('read from inside the failing append, the memory and knowledge stores already hold the record', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK });
    const seen = [];
    const original = app.operations.append.bind(app.operations);
    app.operations.append = async (record) => {
      // The order, measured rather than assumed: the audit append is the first thing that happens
      // after the write is durable, so a refusal can only ever follow a side effect.
      seen.push({
        capability: record.capability,
        memory: memoryOf(dir).length,
        knowledge: knowledgeOf(dir).length,
        experiences: experiencesOf(dir).length,
      });
      throw new StoreError('injected: the audit log refused after the write');
    };
    try {
      await app.controller.handle('remember that the tide table is filed', { origin: 'user' });
      await app.controller.knowledgeAdd({ subject: 'tide', relationship: 'is filed as', object: 'rev 4' });
    } finally {
      app.operations.append = original;
    }

    assert.deepEqual(seen, [
      { capability: 'memory.add', memory: 1, knowledge: 0, experiences: 0 },
      { capability: 'knowledge.add', memory: 1, knowledge: 1, experiences: 0 },
    ], 'the store append preceded the audit append in both operations');
    // And the refusal rolled nothing back: there is no transaction to roll it into.
    assert.equal(memoryOf(dir).length, 1);
    assert.equal(knowledgeOf(dir).length, 1);
    assert.equal(auditOf(dir).length, 0);
  });

  test('an audit log that cannot be opened is a filesystem failure, and its reads say unavailable rather than empty', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK });
    fs.rmSync(file(dir, 'operations.jsonl'), { force: true, recursive: true });
    fs.mkdirSync(file(dir, 'operations.jsonl'));

    const res = await app.controller.handle('remember that the audit target is a directory', { origin: 'user' });
    assert.equal(res.recorded, false);
    assert.match(res.recordError, /cannot write operations\.jsonl: (EISDIR|EPERM|EACCES)/, res.recordError);
    assert.equal(auditOf(dir).length, 0);
    assert.equal(memoryOf(dir).length, 1, 'the write stands on its own');

    // A reader must not call this an empty audit log: the file cannot be opened at all.
    await assert.rejects(() => app.operations.status(), (err) => {
      assert.ok(err instanceof StoreError);
      assert.match(err.message, /operations\.jsonl/);
      return true;
    });

    const cli = await runThroughCli(app, dir, ['ask', 'remember that the audit target is still a directory']);
    assert.equal(cli.code, 3, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /Audit:\s+NOT RECORDED \(cannot write operations\.jsonl/);
    assert.match(cli.stdout, /that action may already have happened/);
    assert.match(cli.stdout, /success_verified/, 'the operation was still verified by its own postcondition read');
    assert.equal(memoryOf(dir).length, 2);
  });
});

describe('AF-15 3: what each caller does with the failed append, and why they differ', () => {
  test('the request path keeps its verified outcome and is qualified by recorded:false and exit 3', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK, experienceCapture: CAPTURE_VERIFIED_SUCCESS });
    const restore = armAuditFailure(app);
    let res;
    let cli;
    try {
      res = await app.controller.handle('remember that the harbour depth is 4 m', { origin: 'user' });
      cli = await runThroughCli(app, dir, ['ask', 'remember that the pilot berth is 9 m']);
    } finally {
      restore();
    }
    // The verifier confirmed the postcondition by re-reading the memory store, so the outcome is not
    // false. What would be false is a durable audit record or an unqualified report, and there is
    // neither: no line, `recorded: false`, and an exit code that is not success.
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.recorded, false);
    assert.equal(auditOf(dir).filter((r) => r.capability === 'memory.add').length, 0);
    assert.equal(cli.code, 3, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /Status:\s+success_verified/);
    assert.match(cli.stdout, /Audit:\s+NOT RECORDED \(injected: the audit log refused memory\.add\)/);
    assert.match(cli.stdout, /Do not repeat the request just to obtain a record/);
    assert.equal(memoryOf(dir).length, 2, 'both runs wrote their memory; neither was rolled back');
  });

  test('the correction path may have changed stored data, so it is downgraded and says so', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK, experienceCapture: CAPTURE_VERIFIED_SUCCESS });
    const note = await app.controller.handle('remember that the survey depth is nine metres', { origin: 'user' });
    assert.equal(note.status, Outcome.SUCCESS_VERIFIED, note.display);
    assert.equal(note.recorded, true, 'the earlier operation is audited, so its capture is legitimate');
    const target = memoryOf(dir).at(-1).id;
    const capturedSoFar = experiencesOf(dir).length;

    const restore = armAuditFailure(app);
    let res;
    try {
      res = await app.controller.correctMemory({ targetId: target, content: 'the survey depth is ten metres', resolve: true });
    } finally {
      restore();
    }
    assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED, 'a correction that may have landed cannot report success');
    assert.equal(res.recorded, false);
    assert.equal(res.decision, 'refuse_or_block');
    assert.equal(res.output, 'The correction may have been stored, but its audit record could not be written; it is not reported as verified success.');
    assert.deepEqual(res.operation.errors.map((e) => [e.stage, e.code]), [['audit', 'AUDIT_WRITE_FAILED']]);
    // The correction did land, which is exactly why the status had to change: the store holds a
    // second claim that replaces the first, and no audit record says who made it.
    assert.equal(memoryOf(dir).length, 2);
    assert.deepEqual(memoryOf(dir).at(-1).provenance.replaces, [target]);
    assert.equal(auditOf(dir).length, 1, 'only the earlier, successful operation is on disk');
    // Capture ran for the audited note, so the log is not empty to begin with; what matters is that
    // the unrecorded correction added nothing to it - an experience must reference a record.
    assert.equal(capturedSoFar, 1, 'the earlier audited operation was captured');
    assert.equal(experiencesOf(dir).length, capturedSoFar, 'the unrecorded correction added no experience');
    assert.doesNotMatch(res.display, /Experience:/, 'and its disclosure claims none');
  });

  test('a command whose write may have landed is downgraded; an audited read that changed nothing is not', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK });
    const restore = armAuditFailure(app);
    let writeRes;
    let readRes;
    try {
      writeRes = await app.controller.knowledgeRetract({ target: 'ferry', reason: 'the timetable changed' });
      readRes = await app.controller.knowledgeList({ limit: 5 });
    } finally {
      restore();
    }
    assert.equal(writeRes.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.match(writeRes.output, /may have been retracted, but its audit record could not be written/);
    assert.equal(readRes.status, Outcome.SUCCESS_VERIFIED, 'a read has no side effect that could be lost');
    assert.equal(readRes.recorded, false, 'but its record is still missing, and that is disclosed');
    assert.equal(auditOf(dir).length, 0);
  });

  test('a task run whose step records cannot be written is downgraded even though its steps completed', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK });
    const id = await planAndReturnId(app, 'calc 2+2; calc 3+3');

    const restore = armAuditFailure(app, (record) => record.capability === 'task.step');
    let res;
    try {
      res = await app.controller.runTask(id);
    } finally {
      restore();
    }
    assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED, 'a completed task with unwritten step records is not a verified success');
    assert.equal(res.underlyingStatus, Outcome.SUCCESS_VERIFIED, 'what the run did is kept, not rewritten');
    assert.equal(res.auditGaps, 2);
    assert.deepEqual(res.auditGapSteps, ['s1', 's2']);
    assert.equal(res.recorded, true, 'the run record itself was written, so the failure is the steps, not the operation');

    assert.equal(auditOf(dir).filter((r) => r.capability === 'task.step').length, 0);
    assert.deepEqual(auditOf(dir).map((r) => r.capability).sort(), ['task.plan', 'task.run']);
    const persisted = await app.taskStore.get(id);
    assert.equal(persisted.status, 'completed', 'the task log records the run as it observed it');
    assert.deepEqual(persisted.steps.map((s) => [s.id, s.status, s.outcome]), [
      ['s1', 'completed', Outcome.SUCCESS_VERIFIED],
      ['s2', 'completed', Outcome.SUCCESS_VERIFIED],
    ], 'every step names an operation whose audit record was refused');
    assert.equal(persisted.steps.filter((s) => s.operationId).length, 2);
    assert.match(res.display, /Audit integrity failure: 2 required task-step operation record\(s\) could not be written \(s1, s2\)/);
    assert.match(res.display, /Underlying task result: success_verified/);

    // The independent read reaches the same conclusion as the run, from the records alone.
    assert.equal((await app.controller.describeTask(id, 'steps')).evidenceState, 'gaps');
    const cli = await runThroughCli(app, dir, ['task', 'explain', id, 'steps']);
    assert.equal(cli.code, 1, `task explain must not report a complete evidence chain: ${cli.stdout}`);
    assert.match(cli.stdout, /not independently supported/);
  });

  test('a task run that loses both its step records and its own record reports both failures', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK });
    const id = await planAndReturnId(app, 'calc 2+2; calc 3+3');

    const restore = armAuditFailure(app);
    let res;
    try {
      res = await app.controller.runTask(id);
    } finally {
      restore();
    }
    assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED, 'the step gaps downgrade the run on their own');
    assert.equal(res.recorded, false, 'and its own record is missing too');
    assert.equal(res.auditGaps, 2, 'the step gap is reported separately, not absorbed by the missing run record');
    assert.deepEqual(res.operation.errors.map((e) => e.code), ['AUDIT_WRITE_FAILED']);
    assert.equal(auditOf(dir).filter((r) => r.capability === 'task.run').length, 0);
    assert.equal(auditOf(dir).filter((r) => r.capability === 'task.step').length, 0);
    assert.equal((await app.taskStore.get(id)).status, 'completed', 'the task log still holds what the run observed');
  });
});

describe('AF-15 4: prediction evaluation is computed from records, so an unreadable evidence log cannot yield a verdict', () => {
  test('an expectation with no outcome evidence records nothing, and the verified claim is that absence', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK });
    const id = await rememberPrediction(app);

    const res = await app.controller.predictionEvaluate({ target: id });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.recorded, true);
    // The postcondition this verifies is the *absence* of a verdict: the verifier re-reads the ledger
    // and refuses if a verdict appeared. It is not a claim that the expectation matched.
    assert.match(res.display, /was not evaluated: outcome_unavailable/);
    assert.doesNotMatch(res.display, /matched|contradicted/, 'no verdict is stated when the records do not establish one');
    assert.equal(evaluationsOf(dir).length, 0);
  });

  test('an experience log that cannot be read is evidence_unavailable, and still no verdict is stored', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK });
    const id = await rememberPrediction(app);

    // A torn line: the store reports damage rather than answering from a partial read.
    fs.writeFileSync(file(dir, 'experiences.jsonl'), '{"kind":"experience","id":"truncated\n');
    const res = await app.controller.predictionEvaluate({ target: id });
    assert.match(res.display, /was not evaluated: evidence_unavailable/);
    assert.match(res.display, /experience log could not be read/i);
    assert.equal(evaluationsOf(dir).length, 0, 'an unreadable log proves nothing, so it decides nothing');
  });

  test('a prediction write whose audit record cannot be written is downgraded while the ledger keeps its line', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK, experienceCapture: CAPTURE_VERIFIED_SUCCESS });
    const id = await rememberPrediction(app);
    const linesBefore = predictionsOf(dir).length;

    const restore = armAuditFailure(app);
    let withdrawal;
    let evaluation;
    try {
      withdrawal = await app.controller.predictionInvalidate({ target: id, reason: 'the horizon moved' });
      evaluation = await app.controller.predictionEvaluate({ target: id });
    } finally {
      restore();
    }
    assert.equal(withdrawal.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.match(withdrawal.output, /withdrawal may have been recorded, but its audit record could not be written/);
    assert.equal(predictionsOf(dir).length, linesBefore + 1, 'the withdrawal was written; only its audit record is missing');
    // The evaluation now finds the expectation withdrawn, writes nothing, and loses its own record.
    assert.equal(evaluation.status, Outcome.AUDIT_INTEGRITY_FAILED, 'even a no-op evaluation is a write command here');
    assert.equal(evaluation.recorded, false);
    assert.match(evaluation.display, /was not evaluated: invalidated/);
    assert.equal(evaluationsOf(dir).length, 0);
    assert.equal(experiencesOf(dir).length, 0, 'the prediction ledger is outside the capture subset, failure or not');
  });
});

describe('AF-15 5: no atomicity, no exactly-once, and the disclosures that replace both promises', () => {
  test('a retry after an audit failure repeats the side effect: nothing detects the duplicate', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK, experienceCapture: CAPTURE_VERIFIED_SUCCESS });
    const restore = armAuditFailure(app);
    let first;
    try {
      first = await app.controller.handle('remember that the archive code is filed', { origin: 'user' });
    } finally {
      restore();
    }
    const second = await app.controller.handle('remember that the archive code is filed', { origin: 'user' });

    assert.equal(first.recorded, false);
    assert.equal(second.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(second.recorded, true);
    const lines = memoryOf(dir);
    assert.equal(lines.length, 2, 'the retry wrote a second claim: APEX does not deliver exactly-once');
    assert.notEqual(lines[0].id, lines[1].id);
    assert.equal(auditOf(dir).length, 1, 'the audit trail holds only the retry, and the disclosure says so');
    assert.deepEqual(auditOf(dir).map((r) => r.id), [second.operation.id]);
  });

  test('the audit log has no unique index, so the duplicate-record guard cannot span a restart', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK });
    await app.controller.handle('remember that the ledger rule is pinned', { origin: 'user' });
    const [record] = auditOf(dir);

    // finalizeOperation's guard is a non-enumerable mark on one object in one process. Hand the same
    // record to a second writer - what a restarted process effectively does - and the log takes it
    // twice. Nothing here may treat a matching identifier as proof of one execution.
    await app.operations.append(record);
    const lines = auditOf(dir);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].id, lines[1].id);
    assert.deepEqual((await app.operations.list({ limit: 5 })).records.map((r) => r.id), [record.id, record.id]);

    const reopened = createApp({ dataDir: dir, now: CLOCK });
    assert.equal((await reopened.operations.inspect()).records.length, 2, 'a second reader sees both claims');
  });

  test('a store that refuses the write is reported as unverified, and its audit record carries the failure', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK });
    // Make the memory store itself unusable, so the side effect cannot happen. The audit record is
    // still written, and it must carry the failure rather than a success inferred from its absence.
    fs.rmSync(file(dir, 'memory.jsonl'), { force: true, recursive: true });
    fs.mkdirSync(file(dir, 'memory.jsonl'));

    const res = await app.controller.handle('remember that the store is a directory', { origin: 'user' });
    assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED, 'a refused write is never reported as a verified success');
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(res.recorded, true, 'the failure is itself audited');
    const [record] = auditOf(dir);
    assert.equal(record.status, Outcome.EXECUTION_FAILED);
    assert.equal(record.steps[0].verification.outcome, 'not_run', 'no verification ran, so none is claimed');
    assert.equal(memoryOf(dir).length, 0);
  });
});
