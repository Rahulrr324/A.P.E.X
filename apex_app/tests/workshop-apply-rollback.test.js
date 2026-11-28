// T-39 Step 1: the governed applier.
//
// T-38 stopped the Workshop at a recorded decision, on purpose: it verified a candidate in a sandbox
// and applied nothing. This suite is about the half that writes, and every claim it makes is about
// what is actually on disk afterwards rather than about what a return value said.
//
// The seven claims, each of which is a way the feature could be wrong:
//
//   1. An unverified candidate is refused, and nothing is written.
//   2. A file that changed after the candidate was staged is refused, with both digests reported.
//   3. A verified candidate is applied atomically: the file holds the new bytes, the old bytes are in
//      a content-addressed backup, and the read-back digest matches.
//   4. A rollback after a manual edit is refused, and the manual edit survives.
//   5. A rollback restores byte-identical bytes, and rolling back a created file removes it.
//   6. Lockdown refuses both writes, by the ECP, before the applier is reached.
//   7. A configured step-up token is required for both, and a wrong one is refused.
//
// Every test runs against a temporary workspace and a temporary data directory. Nothing in this file
// touches a real workspace, the APEX data directory, `stark/`, or the OnCall Memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { MAX_LEDGER_RECORDS } from '../src/workshop/applier.js';

const CLEAN_OLD = 'export const greeting = 1;\n';
const CLEAN_NEW = 'export const greeting = 2;\n';

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

// A workspace with one module in it, and a data directory beside it. The file's original digest is
// returned because half the assertions in this file compare against it.
function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t39-'));
  const root = path.join(base, 'workspace');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(root, 'src', 'greeting.js');
  fs.writeFileSync(file, CLEAN_OLD);
  return { base, root, dataDir, file, beforeSha256: sha256(CLEAN_OLD) };
}

function readFile(file) {
  return fs.readFileSync(file, 'utf8');
}

// Stage and verify in the sandbox. The live file must be untouched when this returns: that is the
// T-38 promise, and every apply test below depends on it still holding.
async function stageVerified(app, { relativePath = 'src/greeting.js', content = CLEAN_NEW } = {}) {
  const staged = await app.controller.workshopStageFile({ relativePath, proposedContent: content });
  const candidateId = staged.operation.steps[0].result?.data?.candidateId;
  assert.ok(candidateId, `staging failed: ${staged.operation.steps[0].summary}`);
  const verified = await app.controller.workshopVerifyFile({ candidateId });
  const data = verified.operation.steps[0].result?.data;
  assert.equal(data?.verified, true, `verification failed: ${verified.operation.steps[0].summary}`);
  return candidateId;
}

function stepOf(result) {
  return result.operation.steps[0];
}

function apply(app, candidateId, extra = {}) {
  return app.controller.workshopApplyFile({ candidateId, reason: 'the owner applied it from the deck', ...extra });
}

function rollback(app, applyId, extra = {}) {
  return app.controller.workshopRollbackFile({ applyId, reason: 'the owner undid it from the deck', ...extra });
}

async function withApp(options, fn) {
  const fixture = makeFixture();
  const app = createApp({ dataDir: fixture.dataDir, filesystemRoot: fixture.root, ...options });
  try {
    return await fn({ ...fixture, app });
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------ claims ---

test('T-39 apply: an unverified candidate is refused and nothing is written', async () => {
  await withApp({}, async ({ app, file, beforeSha256 }) => {
    const staged = await app.controller.workshopStageFile({ relativePath: 'src/greeting.js', proposedContent: CLEAN_NEW });
    const candidateId = staged.operation.steps[0].result.data.candidateId;

    const refused = stepOf(await apply(app, candidateId));
    assert.equal(refused.outcome, 'execution_failed');
    assert.equal(refused.execution.error.code, 'APPLY_REFUSED_UNVERIFIED');
    // The claim is about the file, not the message: a refusal that still wrote would be the bug.
    assert.equal(readFile(file), CLEAN_OLD);
    assert.equal(sha256(readFile(file)), beforeSha256);
    // And the ledger must not claim an apply happened.
    assert.equal(app.workshopApplier.records().length, 0);
  });
});

test('T-39 apply: a failed verification is refused as firmly as a missing one', async () => {
  await withApp({}, async ({ app, file }) => {
    const staged = await app.controller.workshopStageFile({
      relativePath: 'src/greeting.js',
      proposedContent: 'export const greeting = ;\n',
    });
    const candidateId = staged.operation.steps[0].result.data.candidateId;
    const verified = await app.controller.workshopVerifyFile({ candidateId });
    assert.equal(verified.operation.steps[0].result.data.verified, false);

    const refused = stepOf(await apply(app, candidateId));
    assert.equal(refused.execution.error.code, 'APPLY_REFUSED_UNVERIFIED');
    assert.equal(readFile(file), CLEAN_OLD);
  });
});

test('T-39 apply: a file that drifted after staging is refused with both digests', async () => {
  await withApp({}, async ({ app, file, beforeSha256 }) => {
    const candidateId = await stageVerified(app);
    // Somebody else edits the file between the verification and the apply. This is the whole reason
    // the base digest is recorded at staging time.
    const concurrent = 'export const greeting = 99;\n';
    fs.writeFileSync(file, concurrent);

    const refused = stepOf(await apply(app, candidateId));
    assert.equal(refused.outcome, 'execution_failed');
    assert.equal(refused.execution.error.code, 'WORKSPACE_DRIFT');
    // Both digests are on the error, because "it drifted" without them cannot be acted on.
    assert.equal(refused.execution.error.expectedBaseSha256, beforeSha256);
    assert.equal(refused.execution.error.actualDiskSha256, sha256(concurrent));
    // The concurrent edit survives. An editor that clobbers is worse than one that refuses.
    assert.equal(readFile(file), concurrent);
    assert.equal(app.workshopApplier.records().length, 0);
  });
});

test('T-39 apply: a verified candidate is applied atomically and read back from disk', async () => {
  await withApp({}, async ({ app, file, dataDir, beforeSha256 }) => {
    const candidateId = await stageVerified(app);
    // T-38's promise, restated here so a regression in the sandbox is caught by this suite too.
    assert.equal(readFile(file), CLEAN_OLD, 'staging and verifying must not touch the live file');

    const applied = await apply(app, candidateId);
    const step = stepOf(applied);
    assert.equal(step.outcome, 'success_verified', step.summary);
    assert.equal(step.verification.outcome, 'success_verified');

    const data = step.result.data;
    assert.match(data.applyId, /^wsa-[0-9a-f]{12}$/);
    assert.equal(data.appliedSha256, sha256(CLEAN_NEW));
    assert.equal(data.beforeSha256, beforeSha256);
    assert.equal(data.diskSha256, sha256(CLEAN_NEW));
    assert.equal(data.appliedToWorkspace, true);
    assert.equal(data.verifiedOnDisk, true);
    assert.equal(data.mutatesLiveWorkspace, true);
    assert.equal(data.authorizesExecution, false);

    // The real file, read here rather than taken from the result.
    assert.equal(readFile(file), CLEAN_NEW);
    assert.equal(sha256(readFile(file)), sha256(CLEAN_NEW));

    // The backup holds the exact bytes that were replaced, and its name carries their digest.
    const backupFile = path.join(dataDir, 'workshop-backups', data.applyId, `before-${beforeSha256}.bin`);
    assert.equal(readFile(backupFile), CLEAN_OLD);
    // The snapshot's own metadata agrees with the ledger.
    const snapshot = JSON.parse(readFile(path.join(dataDir, 'workshop-backups', data.applyId, 'snapshot.json')));
    assert.equal(snapshot.beforeSha256, beforeSha256);
    assert.equal(snapshot.appliedSha256, sha256(CLEAN_NEW));
    assert.equal(snapshot.relativePath, 'src/greeting.js');

    // The ledger holds one record, and it says what happened.
    const records = app.workshopApplier.records();
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'apply');
    assert.equal(records[0].appliedToWorkspace, true);
    assert.equal(records[0].verifiedOnDisk, true);

    // No temporary sibling was left behind, which is the failure mode of a non-atomic write.
    const leftovers = fs.readdirSync(path.join(fs.realpathSync(path.dirname(file)))).filter((n) => n.includes('apex-tmp'));
    assert.deepEqual(leftovers, []);
  });
});

test('T-39 apply: the same candidate cannot be applied twice while the apply is open', async () => {
  await withApp({}, async ({ app, file }) => {
    const candidateId = await stageVerified(app);
    assert.equal(stepOf(await apply(app, candidateId)).outcome, 'success_verified');

    const again = stepOf(await apply(app, candidateId));
    assert.equal(again.outcome, 'execution_failed');
    assert.equal(again.execution.error.code, 'ALREADY_APPLIED');
    assert.equal(readFile(file), CLEAN_NEW);
  });
});

test('T-39 rollback: an edit made after the apply is refused, and the edit survives', async () => {
  await withApp({}, async ({ app, file }) => {
    const candidateId = await stageVerified(app);
    const applyId = stepOf(await apply(app, candidateId)).result.data.applyId;

    // The owner edits the file by hand after the apply. A rollback would now discard that work.
    const manual = 'export const greeting = 42;\n';
    fs.writeFileSync(file, manual);

    const refused = stepOf(await rollback(app, applyId));
    assert.equal(refused.outcome, 'execution_failed');
    assert.equal(refused.execution.error.code, 'ROLLBACK_DRIFT');
    assert.equal(refused.execution.error.expectedAppliedSha256, sha256(CLEAN_NEW));
    assert.equal(refused.execution.error.actualDiskSha256, sha256(manual));

    // The manual edit is the newest intent in the system and it is still on disk.
    assert.equal(readFile(file), manual);
    // And no rollback record was appended for a rollback that did not happen.
    assert.equal(app.workshopApplier.records().filter((r) => r.kind === 'rollback').length, 0);
  });
});

test('T-39 rollback: the file is restored byte-for-byte and the ledger says so', async () => {
  await withApp({}, async ({ app, file, beforeSha256 }) => {
    const candidateId = await stageVerified(app);
    const applyId = stepOf(await apply(app, candidateId)).result.data.applyId;

    const rolledBack = stepOf(await rollback(app, applyId));
    assert.equal(rolledBack.outcome, 'success_verified', rolledBack.summary);
    const data = rolledBack.result.data;
    assert.equal(data.rolledBack, true);
    assert.equal(data.applyId, applyId);
    assert.equal(data.restoredSha256, beforeSha256);
    assert.equal(data.removedFile, false);
    assert.equal(data.verifiedOnDisk, true);

    // Byte-identical, compared by digest and by content.
    assert.equal(readFile(file), CLEAN_OLD);
    assert.equal(sha256(readFile(file)), beforeSha256);

    // The rollback is its own record, and the apply record is unchanged rather than rewritten.
    const records = app.workshopApplier.records();
    assert.equal(records.length, 2);
    assert.equal(records[1].kind, 'rollback');
    assert.equal(records[1].restoredSha256, beforeSha256);
    assert.equal(app.workshopApplier.applyRecord(applyId).appliedSha256, sha256(CLEAN_NEW));

    // A second rollback is refused rather than restoring twice.
    const twice = stepOf(await rollback(app, applyId));
    assert.equal(twice.execution.error.code, 'ALREADY_ROLLED_BACK');
    assert.equal(readFile(file), CLEAN_OLD);
  });
});

test('T-39 rollback: a file the apply created is removed, and its absence is proved', async () => {
  await withApp({}, async ({ app, root }) => {
    const created = path.join(root, 'src', 'brand-new.js');
    const candidateId = await stageVerified(app, { relativePath: 'src/brand-new.js', content: 'export const added = true;\n' });
    assert.equal(fs.existsSync(created), false);

    const applied = stepOf(await apply(app, candidateId));
    assert.equal(applied.outcome, 'success_verified');
    assert.equal(applied.result.data.existedBefore, false);
    assert.equal(applied.result.data.beforeSha256, null);
    assert.equal(readFile(created), 'export const added = true;\n');

    const rolledBack = stepOf(await rollback(app, applied.result.data.applyId));
    assert.equal(rolledBack.outcome, 'success_verified', rolledBack.summary);
    assert.equal(rolledBack.result.data.removedFile, true);
    assert.equal(rolledBack.result.data.restoredSha256, null);
    assert.equal(fs.existsSync(created), false);
  });
});

test('T-39 apply: lockdown refuses the write through the ECP, before the applier is reached', async () => {
  await withApp({}, async ({ app, file }) => {
    const candidateId = await stageVerified(app);

    const latched = await app.controller.safetyLockdown({ reason: 'the owner latched the system' });
    assert.equal(latched.operation.steps[0].outcome, 'success_verified');

    const refused = stepOf(await apply(app, candidateId));
    // A denial is an authorization refusal, not an execution failure: the ECP answered first.
    assert.equal(refused.authorization.decision, 'deny');
    assert.equal(refused.authorization.reason, 'KILL_SWITCH_ACTIVE');
    assert.equal(readFile(file), CLEAN_OLD);
    assert.equal(app.workshopApplier.records().length, 0);

    // The rollback side is refused for the same reason, against the same latch.
    const stillRefused = stepOf(await rollback(app, 'wsa-000000000000'));
    assert.equal(stillRefused.authorization.decision, 'deny');
    assert.equal(stillRefused.authorization.reason, 'KILL_SWITCH_ACTIVE');
  });
});

test('T-39 apply: a model origin cannot reach either write', async () => {
  await withApp({}, async ({ app }) => {
    for (const name of ['workshop.apply_file', 'workshop.rollback_file']) {
      const decision = app.registry.authorize(name, 'model');
      assert.equal(decision.decision, 'deny', `${name} must refuse a model origin`);
      assert.deepEqual(app.registry.get(name).origins, ['user']);
    }
  });
});

test('T-39 apply: a configured step-up token is required, and a wrong one writes nothing', async () => {
  const secret = 't39-step-up-secret-value';
  await withApp({ stepUpToken: secret }, async ({ app, file }) => {
    const candidateId = await stageVerified(app);

    // No proof at all. The refusal is thrown inside execute - the shape `evolution.decide` uses -
    // so it is an execution failure carrying INVALID_INPUT rather than an input rejection.
    const missing = stepOf(await apply(app, candidateId));
    assert.equal(missing.execution.status, 'failed');
    assert.equal(missing.execution.error.code, 'INVALID_INPUT');
    assert.match(missing.execution.error.message, /step-up is required/i);
    assert.equal(readFile(file), CLEAN_OLD, 'an unproven apply must not write');

    // A wrong proof.
    const wrong = stepOf(await apply(app, candidateId, { stepUp: 'not-the-secret' }));
    assert.equal(wrong.execution.status, 'failed');
    assert.match(wrong.execution.error.message, /did not match/i);
    assert.equal(readFile(file), CLEAN_OLD);

    // The right proof applies.
    const applied = stepOf(await apply(app, candidateId, { stepUp: secret }));
    assert.equal(applied.outcome, 'success_verified', applied.summary);
    assert.equal(readFile(file), CLEAN_NEW);

    // And the rollback is gated identically.
    const applyId = applied.result.data.applyId;
    const rollbackMissing = stepOf(await rollback(app, applyId));
    assert.equal(rollbackMissing.execution.status, 'failed');
    assert.match(rollbackMissing.execution.error.message, /step-up is required/i);
    assert.equal(readFile(file), CLEAN_NEW, 'an unproven rollback must not restore');

    const rolledBack = stepOf(await rollback(app, applyId, { stepUp: secret }));
    assert.equal(rolledBack.outcome, 'success_verified', rolledBack.summary);
    assert.equal(readFile(file), CLEAN_OLD);
  });
});

test('T-39 apply: the step-up status names both capabilities, and the secret is never returned', async () => {
  const secret = 't39-step-up-secret-value';
  await withApp({ stepUpToken: secret }, async ({ app }) => {
    const status = app.ecp.stepUpStatus();
    // T-40 extended this list with the two batch capabilities. The assertion still pins the exact
    // list - an addition has to be made deliberately here - and it still requires the two T-39
    // entries, which a T-40 change must not quietly drop.
    // T-43 Package 1 extends it with the two git checkpoint writes. They are L2 Confirm writes with a
    // workspace_fs blast radius, so they are step-up governed for the same reason the apply and
    // rollback capabilities are: they change files the owner has not read in this session. The list is
    // still exact, and the T-39 and T-40 entries are still required.
    assert.deepEqual([...status.appliesTo],
      ['safety.release', 'evolution.decide', 'workshop.apply_file', 'workshop.rollback_file',
        'workshop.apply_changeset', 'workshop.rollback_changeset',
        'git.checkpoint_create', 'git.checkpoint_restore']);
    assert.equal(status.appliesTo.includes('workshop.apply_file'), true);
    assert.equal(status.appliesTo.includes('workshop.rollback_file'), true);
    assert.equal(JSON.stringify(status).includes(secret), false);
  });
});

test('T-39 apply: a path that escapes the root is refused even from a verified candidate', async () => {
  await withApp({}, async ({ app, root, base }) => {
    // A symlink inside the workspace that points out of it, and a candidate that names it. The
    // sandbox stages bytes for it - staging is a write under the data directory - and the apply is
    // where the escape has to be caught.
    const outside = path.join(base, 'outside.js');
    fs.writeFileSync(outside, 'export const outside = true;\n');
    fs.symlinkSync(outside, path.join(root, 'src', 'escape.js'));

    const staged = await app.controller.workshopStageFile({ relativePath: 'src/escape.js', proposedContent: 'export const outside = false;\n' });
    const candidateId = staged.operation.steps[0].result.data.candidateId;
    await app.controller.workshopVerifyFile({ candidateId });

    const refused = stepOf(await apply(app, candidateId));
    assert.equal(refused.outcome, 'execution_failed');
    assert.equal(refused.execution.error.code, 'ACCESS_DENIED');
    // The file outside the root is exactly as the test wrote it.
    assert.equal(readFile(outside), 'export const outside = true;\n');
  });
});

test('T-39 apply: the apply and rollback appear in the causal trace in order, with their digests', async () => {
  await withApp({}, async ({ app, file, beforeSha256 }) => {
    const candidateId = await stageVerified(app);
    const applied = stepOf(await apply(app, candidateId));
    const applyId = applied.result.data.applyId;
    assert.equal(stepOf(await rollback(app, applyId)).outcome, 'success_verified');

    const trace = app.memoryTrace.trace(candidateId);
    assert.equal(trace.ok, true);
    assert.equal(trace.counts.applies, 2, 'the chain should hold one apply and one rollback');

    const changes = trace.entries.filter((entry) => entry.kind === 'workshop_apply');
    assert.equal(changes.length, 2);
    // Chronologically: the apply first, the rollback second. The trace sorts by timestamp.
    assert.equal(changes[0].detail.rolledBack, false);
    assert.equal(changes[0].detail.appliedSha256, sha256(CLEAN_NEW));
    assert.equal(changes[0].detail.beforeSha256, beforeSha256);
    assert.equal(changes[1].detail.rolledBack, true);
    assert.equal(changes[1].detail.restoredSha256, beforeSha256);
    // A chain step never reads as permission.
    for (const change of changes) assert.equal(change.detail.authorizesExecution, false);

    // The verification comes before the apply, which is the order the work happened in.
    const kinds = trace.entries.map((entry) => entry.kind);
    assert.ok(kinds.indexOf('workshop_verification') < kinds.indexOf('workshop_apply'));
  });
});

test('T-39 apply: a full ledger refuses to append rather than dropping the oldest record', async () => {
  await withApp({}, async ({ app, file, dataDir }) => {
    const candidateId = await stageVerified(app);
    // Fill the ledger to the bound with records that are not applies, so the next append is the one
    // that must be refused. Writing the file directly is honest here: the claim is about what the
    // appender does at the bound, not about how the bound is reached.
    const filler = [];
    for (let i = 0; i < MAX_LEDGER_RECORDS; i += 1) {
      filler.push(JSON.stringify({ kind: 'apply', applyId: `wsa-${String(i).padStart(12, '0')}`, at: '2026-01-01T00:00:00.000Z' }));
    }
    fs.writeFileSync(path.join(dataDir, 'workshop-applies.jsonl'), `${filler.join('\n')}\n`);

    const refused = stepOf(await apply(app, candidateId));
    assert.equal(refused.outcome, 'execution_failed');
    assert.equal(refused.execution.error.code, 'APPLY_LEDGER_FULL');
    // The file is untouched: the refusal happens before the snapshot and before the write.
    assert.equal(readFile(file), CLEAN_OLD);
  });
});

test('T-39 apply: with no workspace root the actions refuse instead of pretending', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t39-noroot-'));
  const app = createApp({ dataDir });
  try {
    const applied = stepOf(await app.controller.workshopApplyFile({ candidateId: 'wsc-000000000000', reason: 'probe' }));
    assert.equal(applied.outcome, 'execution_failed');
    assert.equal(applied.execution.error.code, 'WORKSPACE_UNAVAILABLE');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
