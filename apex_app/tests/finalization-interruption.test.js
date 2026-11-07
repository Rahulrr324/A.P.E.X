// Batch AB §7: an operation interrupted between its finalization steps, observed by a later process.
//
// Each case runs a real child that performs one verified `memory.add` through the ordinary controller
// path and stops at a named boundary of `finalizationOperation` - before the audit append, during it,
// after it but before capture, during the experience append, after that append but before its
// read-back, and after the read-back but before any disclosure. The child exits with status 9
// without returning a result, so what the next process may say is limited to what is on disk.
//
// After restart this file asserts the durable facts, not intentions:
//   - the side effect is present when it had already happened, and absent when it had not;
//   - an audit record exists only when its complete line was written, and a torn line is reported as
//     damage rather than being silently skipped or treated as an operation;
//   - an experience exists only when its complete line was written, and a torn line blocks reads
//     instead of yielding an incomplete list;
//   - nothing reconstructs a missing experience automatically, and no restart appends anything;
//   - where the audit record is complete, the documented manual path - an explicit
//     `experience record <operation-id>` by the user - still works, and only there.
//
// These are real child processes and real stores with deterministic routing; no model, service, or
// download is involved.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDataDir, cleanup, cleanEnv, runCli, APP_ROOT } from './helpers.js';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { captureOf, CAPTURE_AUTOMATIC, CAPTURE_EXPLICIT } from '../src/experience/experience-store.js';
import { Outcome } from '../src/outcomes.js';

const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'finalization-child.mjs');
const NOTE = 'the harbor survey is filed';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const OPS = (dir) => path.join(dir, 'operations.jsonl');
const EXP = (dir) => path.join(dir, 'experiences.jsonl');

function envFor(dir) {
  return cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
}

// A real process, not an in-process fault: the interruption and the bytes it leaves are the test.
function runChild(dir, boundary) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, boundary, dir, NOTE], {
      env: envFor(dir), cwd: APP_ROOT, windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      const results = out.split('\n').filter((l) => l.startsWith('RESULT ')).map((l) => JSON.parse(l.slice(7)));
      resolve({ code, signal, out, err, results, last: results.at(-1) });
    });
  });
}

// A new application instance, exactly as a new process would build it. Reads here establish what a
// restart can know; nothing is written by constructing it.
function restart(dir) {
  return createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF });
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

function rawLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function sizes(dir) {
  const size = (file) => (fs.existsSync(file) ? fs.statSync(file).size : null);
  return { ops: size(OPS(dir)), exp: size(EXP(dir)) };
}

describe('AB-5 an operation interrupted before its audit append', () => {
  test('the side effect is present and no record claims it was audited', async () => {
    const dir = tempDir();
    const child = await runChild(dir, 'before-audit');
    assert.equal(child.code, 9, child.err);
    assert.equal(child.last.stoppedAt, 'before-audit-append');
    assert.equal(child.last.status, undefined, 'no result was assembled before the process stopped');

    const app = restart(dir);
    assert.equal((await app.memory.list()).length, 1, 'the write itself had already happened');
    const audit = await app.operations.inspect();
    assert.deepEqual([audit.records.length, audit.corrupt.length], [0, 0], 'no audit line was written');
    assert.deepEqual(await app.experience.status(), {
      path: path.join(dir, 'experiences.jsonl'),
      records: 0, experiences: 0, recordedByUser: 0, capturedAutomatically: 0,
      unknownCapture: 0, feedback: 0, adaptations: 0, decisions: 0, retirements: 0,
      // Batch AM: the shapes a user records on an approved rule are counted here, so a restart that
      // holds none says so rather than leaving the field out and letting a reader guess.
      guidance: 0,
      activeAdaptations: 0, corrupt: 0,
    });

    // The new process's own reports agree, and neither invents an audit record or an experience.
    const status = await runCli(['status'], envFor(dir));
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /Memory records: 1 \(corrupt lines skipped: 0\)/);
    assert.match(status.stdout, /Operation records: 0\b/);
    assert.match(status.stdout, /Experiences: 0 record\(s\), 0 feedback record\(s\), 0 approved adaptation\(s\) in effect/);
    const auditHealth = await runCli(['audit', 'health'], envFor(dir));
    assert.equal(auditHealth.code, 0, auditHealth.stderr);
    assert.match(auditHealth.stdout, /Store: {10}ok - empty log \(no operation records\)/);
    const experienceHealth = await runCli(['experience', 'health'], envFor(dir));
    assert.equal(experienceHealth.code, 0, experienceHealth.stderr);
    assert.match(experienceHealth.stdout, /Store: {10}ok - empty store \(no experiences, feedback, or adaptations\)/);
  });
});

describe('AB-6 an operation interrupted during its audit append', () => {
  test('the torn audit line is reported as damage while the side effect stays visible', async () => {
    const dir = tempDir();
    const child = await runChild(dir, 'during-audit');
    assert.equal(child.code, 9, child.err);
    assert.equal(child.last.stoppedAt, 'during-audit-append');

    const app = restart(dir);
    assert.equal((await app.memory.list()).length, 1, 'the write happened before the audit append');
    const audit = await app.operations.inspect();
    assert.equal(audit.records.length, 0, 'a partial line is not an operation record');
    assert.equal(audit.corrupt.length, 1);
    assert.equal(audit.corrupt[0].truncatedTail, true, 'the damage is the unfinished tail of the append');
    assert.equal((await app.experience.status()).experiences, 0);

    const auditHealth = await runCli(['audit', 'health'], envFor(dir));
    assert.equal(auditHealth.code, 1, 'damage requires the user');
    assert.match(auditHealth.stdout, /Store: {10}damaged - 1 corrupt line\(s\); inspection incomplete/);
    assert.match(auditHealth.stdout, /final line without a newline/);
    assert.match(auditHealth.stdout, /Inspection: {5}incomplete: counts cover readable records only/);
    const status = await runCli(['status'], envFor(dir));
    assert.match(status.stdout, /Operation records: 0 \(corrupt lines skipped: 1\)/);
    // The audit record is not repaired or invented on startup: the same single torn line remains.
    assert.equal(rawLines(OPS(dir)).length, 1);
  });
});

describe('AB-7 an operation interrupted after its audit append, before capture', () => {
  test('the audit record stands, no experience is invented, and the manual path still works', async () => {
    const dir = tempDir();
    const child = await runChild(dir, 'after-audit-before-capture');
    assert.equal(child.code, 9, child.err);
    assert.equal(child.last.stoppedAt, 'before-experience-append');

    const before = sizes(dir);
    const app = restart(dir);
    const audit = await app.operations.inspect();
    assert.equal(audit.records.length, 1);
    assert.equal(audit.corrupt.length, 0);
    assert.equal(audit.records[0].capability, 'memory.add');
    assert.equal(audit.records[0].status, Outcome.SUCCESS_VERIFIED);
    assert.equal((await app.experience.status()).experiences, 0);
    assert.deepEqual(await app.experience.list(), [], 'opening the store does not fabricate the missing record');
    assert.equal((await app.memory.list()).length, 1);

    const experienceHealth = await runCli(['experience', 'health'], envFor(dir));
    assert.equal(experienceHealth.code, 0, experienceHealth.stderr);
    assert.match(experienceHealth.stdout, /Experiences: {4}0 record\(s\)/);
    assert.match(experienceHealth.stdout, /Evidence: {7}0\/0 recent experience\(s\) re-verified against the audit log/);

    // Nothing a restart does has appended to either store.
    assert.deepEqual(sizes(dir), before, 'restart inspection is read-only');

    // The documented manual recovery: the user names the completed operation explicitly. That is a
    // new, user-origin command with its own audit record - never an automatic reconstruction.
    const opId = audit.records[0].id;
    const manual = await runCli(['experience', 'record', opId, '--subject', NOTE], envFor(dir));
    assert.equal(manual.code, 0, manual.stderr);
    assert.match(manual.stdout, /Recorded experience/);
    const after = restart(dir);
    const experiences = await after.experience.list();
    assert.equal(experiences.length, 1);
    assert.equal(experiences[0].operationId, opId);
    assert.equal(captureOf(experiences[0]), CAPTURE_EXPLICIT, 'the recovery is attributed to the user, not to automatic capture');
    assert.equal((await after.experience.evidenceCheck(experiences[0].id)).ok, true);
    assert.equal((await after.memory.list()).length, 1, 'the explicit record did not re-run the original write');
  });
});

describe('AB-8 an operation interrupted during its experience append', () => {
  test('the torn experience line blocks reads rather than yielding an incomplete list', async () => {
    const dir = tempDir();
    const child = await runChild(dir, 'during-experience-append');
    assert.equal(child.code, 9, child.err);
    assert.equal(child.last.stoppedAt, 'during-experience-append');

    const app = restart(dir);
    const audit = await app.operations.inspect();
    assert.equal(audit.records.length, 1, 'the audit record was complete before capture began');
    assert.equal(audit.corrupt.length, 0);
    const experience = await app.experience.status();
    assert.deepEqual([experience.records, experience.experiences, experience.corrupt], [0, 0, 1]);
    await assert.rejects(
      () => app.experience.list(),
      /corrupt line\(s\); refusing an incomplete experience operation/,
      'a partial append is not read as "no experiences"',
    );

    const health = await runCli(['experience', 'health'], envFor(dir));
    assert.equal(health.code, 1, 'damage requires the user');
    assert.match(health.stdout, /Store: {10}damaged - 1 corrupt line\(s\); inspection incomplete/);
    assert.match(health.stdout, /final line without a newline/);
    assert.match(health.stdout, /Inspection: {5}incomplete/);
    const status = await runCli(['status'], envFor(dir));
    assert.match(status.stdout, /Experiences: 0 record\(s\), 0 feedback record\(s\), 0 approved adaptation\(s\) in effect \(corrupt lines skipped: 1\)/);

    // The audit record exists, but the damaged store refuses the manual path too. APEX does not
    // guess which half-record was intended, and does not drop the line to make the write succeed.
    const opId = audit.records[0].id;
    const manual = await runCli(['experience', 'record', opId, '--subject', NOTE], envFor(dir));
    assert.equal(manual.code, 1, 'a write is refused while the log is damaged');
    assert.match(`${manual.stdout}\n${manual.stderr}`, /corrupt line\(s\); refusing an incomplete experience operation/);
    assert.equal(rawLines(EXP(dir)).length, 1, 'the torn line is preserved for inspection');
    assert.equal((await app.experience.status()).corrupt, 1);
  });
});

describe('AB-9 an operation interrupted after its experience append, before the read-back', () => {
  test('the record is complete and re-verifies against the audit record on restart', async () => {
    const dir = tempDir();
    const child = await runChild(dir, 'after-experience-append-before-check');
    assert.equal(child.code, 9, child.err);
    assert.equal(child.last.stoppedAt, 'before-experience-check');

    const app = restart(dir);
    const audit = await app.operations.inspect();
    assert.equal(audit.records.length, 1);
    assert.equal(audit.records[0].status, Outcome.SUCCESS_VERIFIED);
    assert.equal((await app.memory.list()).length, 1);
    const experiences = await app.experience.list();
    assert.equal(experiences.length, 1);
    assert.equal(experiences[0].operationId, audit.records[0].id);
    assert.equal(captureOf(experiences[0]), CAPTURE_AUTOMATIC);
    // The check that never ran in the child is run here, by a process that did not write the record,
    // and it agrees with the audit log. Durability did not depend on the check having completed.
    const check = await app.experience.evidenceCheck(experiences[0].id);
    assert.equal(check.ok, true, JSON.stringify(check));

    const health = await runCli(['experience', 'health'], envFor(dir));
    assert.equal(health.code, 0, health.stderr);
    assert.match(health.stdout, /Experiences: {4}1 record\(s\) \(1 live, 0 corrected by a later record\)/);
    assert.match(health.stdout, /How recorded: {3}0 recorded by you, 1 captured automatically/);
    assert.match(health.stdout, /Evidence: {7}1\/1 recent experience\(s\) re-verified against the audit log/);
  });
});

describe('AB-10 an operation interrupted after its read-back, before disclosure', () => {
  test('the durable state is identical to the previous boundary and no result was claimed', async () => {
    const dir = tempDir();
    const child = await runChild(dir, 'after-verification-before-disclosure');
    assert.equal(child.code, 9, child.err);
    assert.equal(child.last.stoppedAt, 'before-disclosure');
    assert.equal(child.last.status, undefined, 'the caller never returned, so no status or capture notice was shown');

    const app = restart(dir);
    const audit = await app.operations.inspect();
    assert.equal(audit.records.length, 1);
    assert.equal(audit.corrupt.length, 0);
    const experiences = await app.experience.list();
    assert.equal(experiences.length, 1);
    assert.equal(captureOf(experiences[0]), CAPTURE_AUTOMATIC);
    assert.equal((await app.experience.evidenceCheck(experiences[0].id)).ok, true);
    // Verification adds no record of its own: the pair on disk is exactly the pair the previous
    // boundary leaves, which is why a restart cannot claim more than the append established.
    assert.equal(rawLines(OPS(dir)).length, 1);
    assert.equal(rawLines(EXP(dir)).length, 1);
  });
});

describe('AB-11 an uninterrupted finalization, for comparison with the interrupted boundaries', () => {
  test('control: one verified operation yields exactly one audit record and one experience', async () => {
    const dir = tempDir();
    const child = await runChild(dir, 'control');
    assert.equal(child.code, 0, child.err);
    assert.equal(child.last.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(child.last.recorded, true);
    assert.equal(child.last.captured, true);

    const app = restart(dir);
    const audit = await app.operations.inspect();
    assert.equal(audit.records.length, 1);
    assert.equal(audit.records[0].id, child.last.operationId);
    const experiences = await app.experience.list();
    assert.equal(experiences.length, 1);
    assert.equal(experiences[0].operationId, child.last.operationId);
    assert.equal((await app.memory.list()).length, 1);
    assert.equal(rawLines(OPS(dir)).length, 1, 'no duplicate audit record exists');
    assert.equal(rawLines(EXP(dir)).length, 1, 'no duplicate experience exists');
  });
});
