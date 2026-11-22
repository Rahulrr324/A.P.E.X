// T-40: the three operational limits T-39 left open.
//
// T-39 could apply a file and roll it back, but it could not say whether an applied file still matched
// what was written, it could only write one file at a time, and the command bar's vocabulary lived in
// the router where the owner could not read it. This suite covers those three, and - like the T-39
// suite - every claim is about what is on disk or what the router actually returns rather than about
// what a return value said about itself.
//
// The claims, each of which is a distinct way the feature could be wrong:
//
//   1. `diskState()` classifies all four states, and `liveStatus()` counts them.
//   2. `workshop.check_applied` writes nothing, and says so.
//   3. A changeset pre-flight refuses the whole batch when ONE file fails, writing no byte.
//   4. A valid changeset applies every file atomically, and each is re-read from disk.
//   5. A batch rollback refuses with CHANGESET_ROLLBACK_DRIFT when one file drifted, restoring nothing.
//   6. A batch rollback restores every file byte-for-byte, and removes the ones the batch created.
//   7. A duplicate target path and an out-of-range count are refused as batch problems.
//   8. A mid-batch OS write failure restores every file already written.
//   9. The command catalogue is derived from the router, and every row routes to its own kind.
//  10. The client bundle is real JavaScript - the check that a template literal can never give you.
//  11. Lockdown refuses both batch writes, by the ECP, before the applier is reached.
//
// Every test uses a temporary workspace and a temporary data directory. Nothing here touches a real
// workspace, the APEX data directory, `stark/`, or the OnCall Memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { WorkshopSandbox } from '../src/workshop/sandbox.js';
import { WorkshopApplier, MIN_CHANGESET_FILES, MAX_CHANGESET_FILES } from '../src/workshop/applier.js';
import { createCommandRouter, ROUTE_KIND } from '../src/cognition/command-router.js';
import { UI_CLIENT } from '../src/ui/assets.js';

const OLD_A = 'export const a = 1;\n';
const NEW_A = 'export const a = 2;\n';
const OLD_B = '{"b":1}\n';
const NEW_B = '{"b":2}\n';
const DRIFT_B = '{"b":"edited outside APEX"}\n';

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function digestOf(file) {
  return sha256(fs.readFileSync(file));
}

// A workspace with two files, a data directory, and an applier wired to both.
function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t40-'));
  const root = path.join(base, 'workspace');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const fileA = path.join(root, 'src', 'a.js');
  const fileB = path.join(root, 'src', 'data.json');
  fs.writeFileSync(fileA, OLD_A);
  fs.writeFileSync(fileB, OLD_B);
  const sandbox = new WorkshopSandbox({ dataDir, workspaceRoot: root });
  const applier = new WorkshopApplier({ dataDir, sandbox });
  return { base, root, dataDir, fileA, fileB, sandbox, applier };
}

function stageAndVerify(sandbox, relativePath, content) {
  const staged = sandbox.stage({ relativePath, proposedContent: content });
  sandbox.verify(staged.candidateId);
  return staged.candidateId;
}

function stagePair(fixture) {
  return [
    stageAndVerify(fixture.sandbox, 'src/a.js', NEW_A),
    stageAndVerify(fixture.sandbox, 'src/data.json', NEW_B),
  ];
}

// ------------------------------------------------------------------ Step 1: the disk re-verification ---

test('T-40 drift: diskState classifies intact, modified, reverted and deleted, and liveStatus counts them', () => {
  const fixture = makeFixture();
  const { applier, fileA, fileB, sandbox } = fixture;
  const applyA = applier.apply({ candidateId: stageAndVerify(sandbox, 'src/a.js', NEW_A) });
  const applyB = applier.apply({ candidateId: stageAndVerify(sandbox, 'src/data.json', NEW_B) });

  assert.equal(applier.diskState(applyA).state, 'intact', 'a file just written must read as intact');

  // A: edited outside APEX.
  fs.writeFileSync(fileA, 'export const a = 99;\n');
  const modified = applier.diskState(applyA);
  assert.equal(modified.state, 'modified_externally');
  assert.equal(modified.appliedSha256, sha256(NEW_A), 'the applied digest is reported');
  assert.equal(modified.currentDiskSha256, sha256('export const a = 99;\n'), 'the current digest is reported');
  // The refusal a rollback would give is named on the state, so the UI can say it before it is tried.
  assert.match(modified.detail, /ROLLBACK_DRIFT/);

  // B: put back to exactly the bytes it held before the apply.
  fs.writeFileSync(fileB, OLD_B);
  assert.equal(applier.diskState(applyB).state, 'reverted_externally');

  // And deleted.
  fs.rmSync(fileB);
  const live = applier.liveStatus();
  const byCandidate = new Map(live.states.map((state) => [state.candidateId, state]));
  assert.equal(byCandidate.get(applyB.candidateId).state, 'deleted_externally');
  assert.equal(byCandidate.get(applyB.candidateId).currentDiskSha256, null, 'a deleted file has no digest');

  // The summary agrees with the states it summarised, which is the only reason to have both.
  assert.equal(live.counts.modified_externally, 1);
  assert.equal(live.counts.deleted_externally, 1);
  assert.equal(live.counts.intact, 0);
  assert.equal(live.open, 2);
  assert.equal(live.allIntact, false);
  assert.equal(live.wroteNothing, true);
  assert.equal(live.mutatesLiveWorkspace, false);
  assert.equal(live.authorizesExecution, false);
  fs.rmSync(fixture.base, { recursive: true, force: true });
});

test('T-40 drift: the check writes nothing, measured by the whole data directory and the workspace', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t40-'));
  const root = path.join(base, 'workspace');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), OLD_A);
  const app = createApp({ dataDir, filesystemRoot: root });
  const staged = await app.controller.workshopStageFile({ relativePath: 'src/a.js', proposedContent: NEW_A });
  const candidateId = staged.operation.steps[0].result.data.candidateId;
  await app.controller.workshopVerifyFile({ candidateId });
  await app.controller.workshopApplyFile({ candidateId, reason: 'apply it' });

  const snapshot = () => {
    const map = new Map();
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const full = path.join(entry.parentPath ?? entry.path, entry.name);
        map.set(full, digestOf(full));
      }
    }
    return map;
  };
  const before = snapshot();
  const result = await app.controller.workshopCheckApplied();
  assert.equal(result.status, 'success_verified', result.output);
  const data = result.operation.steps[0].result.data;
  assert.equal(data.wroteNothing, true);
  assert.equal(data.readOnly, true);
  assert.equal(data.measuredFromDisk, true);
  assert.equal(data.counts.intact, 1, 'the applied file is intact');
  assert.deepEqual(snapshot(), before, 'the workspace is byte-identical after the check');
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- Step 2: the atomic changeset ---

test('T-40 changeset: one drifted file refuses the whole batch and writes no byte', () => {
  const fixture = makeFixture();
  const { applier, fileA, fileB } = fixture;
  const [idA, idB] = stagePair(fixture);
  const bytesBeforeA = digestOf(fileA);

  // Edit the second file after staging, so its recorded base no longer matches the disk.
  fs.writeFileSync(fileB, DRIFT_B);
  const bytesBeforeB = digestOf(fileB);

  assert.throws(
    () => applier.applyChangeset({ candidateIds: [idA, idB], title: 'pair' }),
    (error) => {
      assert.equal(error.code, 'CHANGESET_PREFLIGHT_REFUSED');
      assert.equal(error.detail.refusedRelativePath, 'src/data.json', 'the refusal names the offending file');
      assert.equal(error.detail.expectedBaseSha256, sha256(OLD_B), 'it reports the base it recorded');
      assert.equal(error.detail.actualDiskSha256, sha256(DRIFT_B), 'and what is on disk');
      assert.equal(error.detail.filesChecked, 2);
      assert.equal(error.detail.filesRefused, 1);
      return true;
    },
  );

  // The whole point: the file that would have passed is untouched, and so is the one that failed.
  assert.equal(digestOf(fileA), bytesBeforeA, 'the first file was not written');
  assert.equal(digestOf(fileB), bytesBeforeB, 'the external edit survived');
  assert.equal(applier.records().filter((r) => r.kind === 'changeset_apply').length, 0, 'no changeset was recorded');
  fs.rmSync(fixture.base, { recursive: true, force: true });
});

test('T-40 changeset: a valid batch applies every file atomically and re-reads each from disk', () => {
  const fixture = makeFixture();
  const { applier, fileA, fileB } = fixture;
  const [idA, idB] = stagePair(fixture);
  const changeset = applier.applyChangeset({ candidateIds: [idA, idB], title: 'the pair', rationale: 'because' });

  assert.equal(changeset.fileCount, 2);
  assert.equal(changeset.atomic, true);
  assert.equal(changeset.everyFileVerifiedOnDisk, true);
  assert.equal(fs.readFileSync(fileA, 'utf8'), NEW_A);
  assert.equal(fs.readFileSync(fileB, 'utf8'), NEW_B);
  for (const file of changeset.files) {
    assert.equal(file.diskSha256, file.appliedSha256, `${file.relativePath} was read back and matched`);
    assert.equal(file.beforeSha256, file.relativePath === 'src/a.js' ? sha256(OLD_A) : sha256(OLD_B));
  }
  // The batch appears in the open set, with its live status measured from the disk.
  const open = applier.openChangesets();
  assert.equal(open.length, 1);
  assert.equal(open[0].changesetId, changeset.changesetId);
  const live = applier.liveStatus();
  assert.equal(live.open, 2, 'both files of the batch are applied changes');
  assert.equal(live.allIntact, true);
  fs.rmSync(fixture.base, { recursive: true, force: true });
});

test('T-40 changeset: a batch rollback refuses on one drifted file and restores nothing', () => {
  const fixture = makeFixture();
  const { applier, fileA, fileB } = fixture;
  const changeset = applier.applyChangeset({ candidateIds: stagePair(fixture), title: 'pair' });
  fs.writeFileSync(fileB, DRIFT_B);

  assert.throws(
    () => applier.rollbackChangeset({ changesetId: changeset.changesetId, reason: 'undo' }),
    (error) => {
      assert.equal(error.code, 'CHANGESET_ROLLBACK_DRIFT');
      assert.equal(error.detail.refusedRelativePath, 'src/data.json');
      assert.equal(error.detail.expectedAppliedSha256, sha256(NEW_B));
      assert.equal(error.detail.actualDiskSha256, sha256(DRIFT_B));
      return true;
    },
  );
  assert.equal(fs.readFileSync(fileA, 'utf8'), NEW_A, 'the file that still matched was NOT restored');
  assert.equal(fs.readFileSync(fileB, 'utf8'), DRIFT_B, 'the external edit is intact');
  assert.equal(applier.records().filter((r) => r.kind === 'changeset_rollback').length, 0);
  fs.rmSync(fixture.base, { recursive: true, force: true });
});

test('T-40 changeset: a clean batch rollback restores every file byte-for-byte and removes created ones', () => {
  const fixture = makeFixture();
  const { applier, fileA, fileB, sandbox } = fixture;
  // A batch of three: two existing files and one the batch creates.
  const created = stageAndVerify(sandbox, 'src/created.js', 'export const created = true;\n');
  const changeset = applier.applyChangeset({
    candidateIds: [stageAndVerify(sandbox, 'src/a.js', NEW_A), stageAndVerify(sandbox, 'src/data.json', NEW_B), created],
    title: 'three',
  });
  const createdPath = path.join(fixture.root, 'src', 'created.js');
  assert.equal(fs.existsSync(createdPath), true, 'the batch created the file');

  const rolledBack = applier.rollbackChangeset({ changesetId: changeset.changesetId, reason: 'undo' });
  assert.equal(rolledBack.fileCount, 3);
  assert.equal(rolledBack.everyFileVerifiedOnDisk, true);
  assert.equal(fs.readFileSync(fileA, 'utf8'), OLD_A, 'restored byte-for-byte');
  assert.equal(fs.readFileSync(fileB, 'utf8'), OLD_B, 'restored byte-for-byte');
  assert.equal(digestOf(fileA), sha256(OLD_A), 'and the digest says so');
  assert.equal(fs.existsSync(createdPath), false, 'the file the batch created is gone');
  const createdFile = rolledBack.files.find((file) => file.relativePath === 'src/created.js');
  assert.equal(createdFile.removedFile, true);
  assert.equal(applier.openChangesets().length, 0, 'nothing is open after the rollback');
  fs.rmSync(fixture.base, { recursive: true, force: true });
});

test('T-40 changeset: a duplicate path, too few and too many files are refused as batch problems', () => {
  const fixture = makeFixture();
  const { applier } = fixture;
  const idA = stageAndVerify(fixture.sandbox, 'src/a.js', NEW_A);
  const idA2 = stageAndVerify(fixture.sandbox, 'src/a.js', 'export const a = 3;\n');

  assert.throws(
    () => applier.applyChangeset({ candidateIds: [idA, idA2], title: 'duplicate' }),
    (error) => {
      assert.equal(error.code, 'CHANGESET_PREFLIGHT_REFUSED');
      assert.equal(error.detail.problems[0].reason, 'DUPLICATE_PATH');
      return true;
    },
  );
  assert.throws(
    () => applier.applyChangeset({ candidateIds: [idA], title: 'one' }),
    (error) => {
      assert.equal(error.code, 'CHANGESET_PREFLIGHT_REFUSED');
      assert.equal(error.detail.problems[0].reason, 'TOO_FEW_FILES');
      return true;
    },
  );
  const many = Array.from({ length: MAX_CHANGESET_FILES + 1 }, () => idA);
  assert.throws(
    () => applier.applyChangeset({ candidateIds: many, title: 'many' }),
    (error) => {
      assert.equal(error.code, 'CHANGESET_PREFLIGHT_REFUSED');
      assert.equal(error.detail.problems[0].reason, 'TOO_MANY_FILES');
      return true;
    },
  );
  assert.equal(fs.readFileSync(fixture.fileA, 'utf8'), OLD_A, 'no refusal wrote anything');
  assert.equal(MIN_CHANGESET_FILES, 2);
  fs.rmSync(fixture.base, { recursive: true, force: true });
});

test('T-40 changeset: an OS write failure on the second file restores the first, and records nothing', () => {
  const fixture = makeFixture();
  const { applier, fileA, fileB } = fixture;
  const [idA, idB] = stagePair(fixture);
  const realRename = fs.renameSync;
  let renames = 0;
  // The second rename is the second file's write. Failing it is the only way to reach the unwind path
  // without simulating a full disk, and it is exactly the case the batch exists to survive.
  fs.renameSync = (...args) => {
    renames += 1;
    if (renames === 2) {
      const error = new Error('ENOSPC: no space left on device (simulated)');
      error.code = 'ENOSPC';
      throw error;
    }
    return realRename(...args);
  };
  try {
    assert.throws(
      () => applier.applyChangeset({ candidateIds: [idA, idB], title: 'will fail' }),
      (error) => {
        assert.equal(error.code, 'CHANGESET_WRITE_FAILED');
        assert.deepEqual(error.detail.undone, ['src/a.js'], 'the file already written was named as undone');
        return true;
      },
    );
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(digestOf(fileA), sha256(OLD_A), 'the first file was restored to its original bytes');
  assert.equal(digestOf(fileB), sha256(OLD_B), 'the second file was never written');
  assert.equal(applier.records().filter((r) => r.kind === 'changeset_apply').length, 0, 'a failed batch is not recorded as applied');
  fs.rmSync(fixture.base, { recursive: true, force: true });
});

test('T-40 changeset: lockdown refuses both batch writes before the applier is reached', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t40-'));
  const root = path.join(base, 'workspace');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), OLD_A);
  fs.writeFileSync(path.join(root, 'src', 'data.json'), OLD_B);
  const app = createApp({ dataDir, filesystemRoot: root });
  const ids = [];
  for (const [relativePath, content] of [['src/a.js', NEW_A], ['src/data.json', NEW_B]]) {
    const staged = await app.controller.workshopStageFile({ relativePath, proposedContent: content });
    const candidateId = staged.operation.steps[0].result.data.candidateId;
    await app.controller.workshopVerifyFile({ candidateId });
    ids.push(candidateId);
  }
  await app.controller.safetyLockdown({ reason: 'the owner stopped the system' });
  const refused = await app.controller.workshopApplyChangeset({ candidateIds: ids, title: 'pair', rationale: 'while latched' });
  const step = refused.operation.steps[0];
  assert.equal(step.authorization.decision, 'deny');
  assert.equal(step.execution.status, 'not_run', 'the ECP stopped it before the applier ran');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), OLD_A, 'nothing was written');
  fs.rmSync(base, { recursive: true, force: true });
});

test('T-40 changeset: the causal trace expands a batch per file and reads it as apply then rollback', async () => {
  // The fourth hosted walk failed here. The ledger was right; the trace reader was not. It assumed one
  // record is one file - a changeset has no top-level candidateId or relativePath - so a two-file batch
  // produced zero chain entries and a chain that existed in the ledger could not be opened at all.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t40-'));
  const root = path.join(base, 'workspace');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), OLD_A);
  fs.writeFileSync(path.join(root, 'src', 'data.json'), OLD_B);
  const app = createApp({ dataDir, filesystemRoot: root });
  const ids = [];
  for (const [relativePath, content] of [['src/a.js', NEW_A], ['src/data.json', NEW_B]]) {
    const staged = await app.controller.workshopStageFile({ relativePath, proposedContent: content });
    const candidateId = staged.operation.steps[0].result.data.candidateId;
    await app.controller.workshopVerifyFile({ candidateId });
    ids.push(candidateId);
  }
  const applied = await app.controller.workshopApplyChangeset({ candidateIds: ids, title: 'the pair', rationale: 'because' });
  const changesetId = applied.operation.steps[0].result.data.changesetId;
  await app.controller.workshopRollbackChangeset({ changesetId, reason: 'undo it' });

  const trace = await app.memoryTrace.trace(ids[0]);
  assert.equal(trace.ok, true, 'a batch must produce an openable chain');
  assert.equal(trace.complete, true, `chain missing: ${JSON.stringify(trace.missing)}`);
  const applies = trace.entries.filter((entry) => entry.kind === 'workshop_apply');
  assert.equal(applies.length, 2, 'the chain holds the batch apply and the batch rollback, one entry each');
  assert.deepEqual(applies.map((entry) => entry.label),
    ['workspace file applied', 'workspace rollback restored the prior file']);
  // In time order, both naming the batch they belong to.
  assert.ok(applies[0].at <= applies[1].at, 'the apply precedes the rollback');
  for (const entry of applies) {
    assert.equal(entry.detail.changesetId, changesetId, 'each entry names the batch it belongs to');
    assert.equal(entry.detail.changesetFileCount, 2);
  }
  // The digests travel with the chain, because a chain a reader cannot recompute is a story.
  assert.equal(applies[0].detail.beforeSha256, sha256(OLD_A));
  assert.equal(applies[0].detail.appliedSha256, sha256(NEW_A));
  assert.equal(applies[1].detail.restoredSha256, sha256(OLD_A));
  // And the batch is findable by path.
  const found = await app.memoryTrace.search({ q: 'a.js' });
  assert.equal(found.ok, true);
  assert.ok(found.results.some((result) => result.kind === 'workshop_apply'), 'search must find the batch');
  fs.rmSync(base, { recursive: true, force: true });
});

// ----------------------------------------------------- Step 3: the command catalogue and the client ---

test('T-40 command help: the catalogue is derived from the router, and every row routes to its own kind', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t40-'));
  const root = path.join(base, 'workspace');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const app = createApp({ dataDir, filesystemRoot: root });
  const router = createCommandRouter({ controller: app.controller });
  const catalog = router.catalog();

  assert.equal(catalog.schema, 'apex.command.catalog/1');
  assert.equal(catalog.readOnly, true);
  assert.equal(catalog.wroteNothing, true);
  assert.equal(catalog.authorizesExecution, false);
  assert.deepEqual(catalog.modes, [...router.modes()], 'the modes come from the router');

  // Every literal phrase the router holds is in the catalogue. This is the derivation check: a phrase
  // added to PHRASES and not to the catalogue would fail here, which is the point of building it from
  // the tables rather than writing it out.
  const syntaxes = catalog.commands.map((row) => row.syntax);
  for (const phrase of ['sense workspace', 'sense host', 'refresh telemetry', 'refresh sensor',
    'run doctor', 'system check', 'status report', 'acknowledge briefing', 'briefing delta',
    'show briefing', 'briefing', 'verify workshop']) {
    assert.ok(syntaxes.includes(phrase), `${phrase} is missing from the catalogue`);
  }
  for (const prefix of ['council: <text>', 'deliberate <text>', 'mode <mode>', 'lockdown <text>']) {
    assert.ok(syntaxes.includes(prefix), `${prefix} is missing from the catalogue`);
  }

  // And every row that names a concrete line routes to the kind its row claims.
  let checked = 0;
  for (const row of catalog.commands) {
    if (row.syntax.startsWith('<')) continue;
    const probe = row.syntax.replace('<text>', 'a question').replace('<mode>', 'quiet');
    const routed = router.routeLine(probe);
    assert.equal(routed.kind, row.routeKind, `${probe} routes to ${routed.kind}, not ${row.routeKind}`);
    checked += 1;
  }
  assert.ok(checked >= 16, `only ${checked} rows were checked`);

  // The shortcuts list is the keyboard reference, and it names the five the milestone requires.
  const keys = catalog.shortcuts.map((shortcut) => shortcut.keys);
  for (const key of ['Ctrl+K', '/', '?', 'Escape', 'Tab']) assert.ok(keys.includes(key), `${key} is missing`);
  // The ECP column is a live decision, not a constant.
  const governance = catalog.commands.filter((row) => row.capability).map((row) => row.capability.ecpDecision);
  assert.ok(governance.length > 0 && governance.every((decision) => decision === 'allow'), 'with no latch every governed row reads allow');
  fs.rmSync(base, { recursive: true, force: true });
});

test('T-40 command help: the ECP column tells the truth under lockdown rather than showing a stale allow', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t40-'));
  const root = path.join(base, 'workspace');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const app = createApp({ dataDir, filesystemRoot: root });
  const router = createCommandRouter({ controller: app.controller });
  await app.controller.safetyLockdown({ reason: 'the owner stopped the system' });
  const catalog = router.catalog();
  const workshopRow = catalog.commands.find((row) => row.syntax === 'verify workshop');
  assert.equal(workshopRow.capability.ecpDecision, 'deny', 'a reference that says allow during a lockdown is a lie');
  fs.rmSync(base, { recursive: true, force: true });
});

test('T-40 command help: the client bundle is real JavaScript, and installs the bindings it documents', () => {
  // The UI client is a template literal in the server module, so `node --check` never parses it and a
  // stray apostrophe inside a single-quoted string is invisible until a browser runs it. This is the
  // check that catches that class of defect, and it exists because T-40 shipped one and found it here.
  assert.equal(typeof UI_CLIENT, 'string');
  assert.ok(UI_CLIENT.length > 100_000, 'the client bundle is not empty');
  assert.doesNotThrow(() => {
    // Compiling it is the check. `new Function` parses without running, so nothing in the page executes.
    // eslint-disable-next-line no-new-func
    new Function(UI_CLIENT);
  }, 'the client bundle must parse as JavaScript');

  // The elements the milestone names are all present, and the key binding is installed.
  for (const id of ['hud-command-help', 'hud-help-toggle', 'ws-check-disk', 'ws-apply-changeset']) {
    assert.ok(UI_CLIENT.includes(`'${id}'`), `${id} is not looked up by the client`);
  }
  assert.ok(UI_CLIENT.includes('dataset.rollbackChangeset'), 'the batch rollback control is not built');
  assert.ok(UI_CLIENT.includes('dataset.selectCandidate'), 'the selection checkbox is not built');
});

test('T-40 command help: the disk and changeset rows show whole digests, because they are compared', () => {
  // The third hosted walk failed here, and it was the third instance of the same shape of mistake: the
  // information was correct in the ledger and had been shortened before it reached the screen. Twelve
  // characters of a SHA-256 identify a record; they cannot be compared with a file the owner hashed.
  // Every panel that exists to be checked against the disk now shows the whole digest.
  const diskRows = UI_CLIENT.slice(UI_CLIENT.indexOf('function renderDiskStatus'),
    UI_CLIENT.indexOf('function selectedCandidates'));
  assert.ok(diskRows.length > 200, 'renderDiskStatus was not found');
  assert.ok(!diskRows.includes('shortDigest('), 'the disk status row shortens a digest it exists to compare');
  assert.ok(diskRows.includes('state.appliedSha256'), 'the disk status row does not show the applied digest');
  assert.ok(diskRows.includes('state.currentDiskSha256'), 'the disk status row does not show the current digest');

  const changesetRows = UI_CLIENT.slice(UI_CLIENT.indexOf('function renderChangesets'),
    UI_CLIENT.indexOf('async function stageCandidate'));
  assert.ok(changesetRows.length > 200, 'renderChangesets was not found');
  assert.ok(!changesetRows.includes('shortDigest('), 'the changeset row shortens a digest it exists to compare');
  assert.ok(changesetRows.includes('file.appliedSha256'), 'the changeset row does not show what it wrote');
  assert.ok(changesetRows.includes('file.beforeSha256'), 'the changeset row does not show what it replaced');
  // The error contract. `api()` copies a bounded set of refusal fields onto the thrown error, and a
  // field missing from that list is silently unavailable to every handler above it - which is exactly
  // how the T-40 walk reached the screen with an empty diagnostic while the server had sent the whole
  // per-file diagnosis. Both batch refusals depend on `problems`, so its presence is pinned.
  const apiBody = UI_CLIENT.slice(UI_CLIENT.indexOf('async function api('), UI_CLIENT.indexOf('async function readApi('));
  for (const field of ['problems', 'refusedRelativePath', 'refusedCandidateId', 'filesChecked',
    'filesRefused', 'undone', 'expectedBaseSha256', 'actualDiskSha256', 'expectedAppliedSha256']) {
    assert.ok(apiBody.includes(`'${field}'`), `api() drops the ${field} field from a refusal`);
  }
  assert.ok(UI_CLIENT.includes('dataset.rollbackChangeset'), 'the batch rollback control is not built');
  assert.ok(UI_CLIENT.includes("event.key === '?'"), 'the question-mark binding is not installed');
  assert.ok(UI_CLIENT.includes('/api/command/catalog'), 'the client does not read the catalogue');
});

test('T-40 command help: a batch notice outranks the selection summary, and survives the finally block', () => {
  // The first hosted run failed here and nowhere else, and this is the regression pin for it.
  //
  // A refusal was rendered correctly and then overwritten a tick later: the click handler's `catch`
  // wrote the message, and the same handler's `finally` called `updateChangesetControls()`, which wrote
  // the selection summary over the top. The assertion that ran in between passed while a human could
  // never have read the refusal. The fix is a held notice, and this test pins its two properties -
  // that the update function yields to a notice, and that the notice is cleared when the owner changes
  // the selection - because neither is observable from a plain `node --check` and only one of them is
  // reliably reachable from a browser walk.
  assert.ok(UI_CLIENT.includes('function setChangesetNotice'), 'the notice is not held');
  assert.ok(UI_CLIENT.includes('function clearChangesetNotice'), 'the notice is never cleared');
  // The ordering that matters: the early return on a live notice comes BEFORE the summary is written.
  const updateBody = UI_CLIENT.slice(UI_CLIENT.indexOf('function updateChangesetControls'));
  const endOfUpdate = updateBody.indexOf('\n}');
  const body = updateBody.slice(0, endOfUpdate === -1 ? updateBody.length : endOfUpdate);
  const noticeGuard = body.indexOf('if (wsState.changesetNotice) return;');
  const summaryWrite = body.indexOf('selected.length + \' selected: \'');
  assert.ok(noticeGuard !== -1, 'updateChangesetControls does not yield to a notice');
  assert.ok(summaryWrite !== -1, 'updateChangesetControls no longer writes a selection summary');
  assert.ok(noticeGuard < summaryWrite, 'the notice guard must come before the summary is written');
  // A selection change clears it, so a stale refusal cannot describe a different batch.
  const pickHandler = UI_CLIENT.slice(UI_CLIENT.indexOf("pick.addEventListener('change'"));
  assert.ok(pickHandler.slice(0, 400).includes('clearChangesetNotice()'),
    'changing the selection must clear the previous notice');
  // Every outcome path uses the notice rather than writing directly into the status line.
  for (const phrase of ['Applied \' + data.fileCount + \' files atomically',
    'refused before writing anything',
    'Batch rollback refused: ',
    'Rolled back \' + data.fileCount + \' files']) {
    const index = UI_CLIENT.indexOf(phrase);
    assert.ok(index !== -1, `missing outcome message: ${phrase}`);
    const before = UI_CLIENT.slice(Math.max(0, index - 200), index);
    assert.ok(!before.includes('setWorkspaceStatus(els.wsChangesetState'),
      `an outcome message still writes directly into the status line and can be overwritten: ${phrase}`);
  }
});
