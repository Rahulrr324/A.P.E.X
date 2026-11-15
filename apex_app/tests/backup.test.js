// Versioned backup, inspection, and confirmed restore of the APEX data directory.
//
// Every test runs through the assembled application against a real data directory and real files
// on disk. Nothing here calls a model; the restore tests compare bytes, not reports, so a restore
// that claimed success without writing would fail.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import {
  ARCHIVE_FORMAT, ARCHIVE_VERSION, CONFIRMATION_MIN_CHARS, DATA_FILES,
  exportArchive, inspectArchive, restoreArchive,
} from '../src/backup/archive.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const NOW = new Date('2026-11-15T12:00:00.000Z');

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

// The data directory and the destination live in different temp directories, so an archive path is
// never accidentally inside the data directory (which export refuses on purpose).
function appFor(options = {}) {
  const dataDir = tempDir();
  const app = createApp({ dataDir, now: () => NOW, ...options });
  return { app, dataDir, elsewhere: tempDir() };
}

const archivePath = (elsewhere, name = 'snapshot.json') => path.join(elsewhere, name);

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

function failureCode(res) {
  const step = res.operation.steps[0];
  return step.execution.error?.code ?? step.execution.error?.message;
}

async function seed(app) {
  const added = await app.controller.knowledgeAdd({ subject: 'Alpha', relationship: 'is', object: 'one' });
  assert.equal(added.status, Outcome.SUCCESS_VERIFIED, added.display);
  const remembered = await app.controller.handle('remember that the gate code name is Birch', { origin: 'user' });
  assert.equal(remembered.status, Outcome.SUCCESS_VERIFIED, remembered.display);
}

describe('backup.export', () => {
  test('writes one archive outside the data directory and the verifier re-reads every digest', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);

    const res = await app.controller.backupExport({ path: destination });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.operation.steps[0].verification.detail);
    const data = res.operation.steps[0].result.data;
    assert.equal(data.path, path.resolve(destination));
    assert.match(data.archiveSha256, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(destination));
    assert.ok(!destination.startsWith(path.resolve(dataDir)), 'the archive must not be inside the data directory');

    const names = data.files.map((file) => file.name);
    assert.ok(names.includes('knowledge.jsonl'));
    assert.ok(names.includes('memory.jsonl'));
    assert.ok(names.includes('operations.jsonl'));
    assert.ok(names.includes('session.json'));
    assert.ok(data.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));
    assert.ok(data.missing.includes('deadlines.jsonl'), 'absent stores are reported, not invented');

    const reread = await inspectArchive({ source: destination });
    assert.equal(reread.ok, true, reread.problems.join('; '));
    assert.equal(reread.archiveSha256, data.archiveSha256);
    assert.match(res.display, /not encrypted/);
    assert.match(res.display, /not a transaction across files/);
  });

  test('refuses a destination inside the data directory and writes nothing', async () => {
    const { app, dataDir } = appFor();
    const destination = path.join(dataDir, 'inside.json');
    const res = await app.controller.backupExport({ path: destination });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(failureCode(res), 'BACKUP_DESTINATION_INSIDE_DATA');
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'backups')), false);
  });

  test('refuses an existing destination without overwriting it', async () => {
    const { app, elsewhere } = appFor();
    const destination = archivePath(elsewhere);
    fs.writeFileSync(destination, 'the earlier copy');
    const res = await app.controller.backupExport({ path: destination });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(failureCode(res), 'BACKUP_DESTINATION_EXISTS');
    assert.equal(fs.readFileSync(destination, 'utf8'), 'the earlier copy');
  });

  test('refuses a destination whose directory does not exist', async () => {
    const { app, elsewhere } = appFor();
    const res = await app.controller.backupExport({ path: path.join(elsewhere, 'missing', 'x.json') });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(failureCode(res), 'BACKUP_DESTINATION_MISSING');
  });

  test('rejects a request without a path, and one with an unknown field', async () => {
    const { app } = appFor();
    const missing = await app.controller.backupExport({});
    assert.equal(missing.operation.steps[0].execution.status, 'rejected');
    const extra = await app.controller.runAction('backup.export', { path: 'x.json', force: true }, 'user', 'op1');
    assert.equal(extra.execution.status, 'rejected');
    assert.match(extra.execution.error.message, /unexpected input field "force"/);
  });

  test('preserves an unparseable line and says so, instead of repairing the store', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    fs.appendFileSync(path.join(dataDir, 'knowledge.jsonl'), '{not json}\n');
    const destination = archivePath(elsewhere);
    const res = await app.controller.backupExport({ path: destination });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    const data = res.operation.steps[0].result.data;
    const knowledge = data.files.find((file) => file.name === 'knowledge.jsonl');
    assert.equal(knowledge.unparsed, 1);
    assert.match(res.display, /preserved as they are, not repaired/);
    const stored = JSON.parse(fs.readFileSync(destination, 'utf8'));
    assert.match(stored.contents['knowledge.jsonl'], /\{not json\}/);
  });
});

describe('backup.inspect', () => {
  test('reports a fresh archive as restorable and prints the exact confirmation', async () => {
    const { app, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);
    await app.controller.backupExport({ path: destination });

    const res = await app.controller.backupInspect({ path: destination });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    const data = res.operation.steps[0].result.data;
    assert.equal(data.ok, true);
    assert.equal(data.problems.length, 0);
    assert.match(res.display, /is valid and can be restored/);
    assert.match(res.display, new RegExp(`--confirm ${data.archiveSha256.slice(0, 12)}`));
    assert.match(res.display, /APEX backup, version 1/);
  });

  test('a changed byte is reported before anything is restored, and restore refuses it', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);
    const exported = await app.controller.backupExport({ path: destination });
    const digest = exported.operation.steps[0].result.data.archiveSha256;

    const document = JSON.parse(fs.readFileSync(destination, 'utf8'));
    document.contents['knowledge.jsonl'] = document.contents['knowledge.jsonl'].replace('Alpha', 'Omega');
    fs.writeFileSync(destination, JSON.stringify(document, null, 2));

    const inspected = await app.controller.backupInspect({ path: destination });
    const data = inspected.operation.steps[0].result.data;
    assert.equal(data.ok, false);
    assert.ok(data.problems.some((problem) => /recorded SHA-256/.test(problem)));
    assert.match(inspected.display, /NOT restorable/);

    const before = fs.readFileSync(path.join(dataDir, 'knowledge.jsonl'));
    const restored = await app.controller.backupRestore({ path: destination, confirm: digest.slice(0, 12), replaceExisting: true });
    assert.equal(restored.status, Outcome.EXECUTION_FAILED);
    assert.equal(failureCode(restored), 'BACKUP_INVALID');
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'knowledge.jsonl')), before);
  });

  test('refuses an archive that is not JSON, not an object, or another version', async () => {
    const { app, elsewhere } = appFor();
    const destination = archivePath(elsewhere);
    fs.writeFileSync(destination, 'not json at all');
    const bad = await app.controller.backupInspect({ path: destination });
    assert.equal(bad.status, Outcome.EXECUTION_FAILED);
    assert.equal(failureCode(bad), 'BACKUP_INVALID');

    fs.writeFileSync(destination, '[]');
    const list = await app.controller.backupInspect({ path: destination });
    assert.equal(failureCode(list), 'BACKUP_INVALID');

    fs.writeFileSync(destination, JSON.stringify({
      format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION + 1, createdAt: NOW.toISOString(),
      appVersion: 'test', files: [], contents: {},
    }));
    const future = await app.controller.backupInspect({ path: destination });
    const futureData = future.operation.steps[0].result.data;
    assert.equal(futureData.ok, false);
    assert.ok(futureData.problems.some((problem) => /unsupported archive version/.test(problem)));
  });

  test('refuses unknown, duplicated, and undeclared file entries', async () => {
    const { app, elsewhere } = appFor();
    const destination = archivePath(elsewhere);
    const text = JSON.stringify({ hello: 'world' });
    const digest = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(text).digest('hex'));
    const entry = { name: 'knowledge.jsonl', bytes: Buffer.byteLength(text), sha256: digest };
    fs.writeFileSync(destination, JSON.stringify({
      format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, createdAt: NOW.toISOString(), appVersion: 'test',
      files: [entry, entry, { name: 'secrets.txt', bytes: 0, sha256: '0'.repeat(64) }],
      contents: { 'knowledge.jsonl': text, 'secrets.txt': '' },
    }));
    const res = await app.controller.backupInspect({ path: destination });
    const data = res.operation.steps[0].result.data;
    assert.equal(data.ok, false);
    assert.ok(data.problems.some((problem) => /appears more than once/.test(problem)));
    assert.ok(data.problems.some((problem) => /unknown file "secrets.txt"/.test(problem)));
  });

  test('reports a missing archive as a refusal, not an empty one', async () => {
    const { app, elsewhere } = appFor();
    const res = await app.controller.backupInspect({ path: path.join(elsewhere, 'absent.json') });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(failureCode(res), 'BACKUP_NOT_FOUND');
  });

  test('the inspection record carries the manifest, not the store contents', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    const marker = `MARKER-${'x'.repeat(4000)}`;
    const noted = await app.controller.noteAdd({ title: 'Inspection privacy', body: marker });
    assert.equal(noted.status, Outcome.SUCCESS_VERIFIED, noted.display);
    const destination = archivePath(elsewhere);
    const exported = await app.controller.backupExport({ path: destination });
    assert.equal(exported.status, Outcome.SUCCESS_VERIFIED, exported.display);

    const res = await app.controller.backupInspect({ path: destination });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    const data = res.operation.steps[0].result.data;
    assert.ok(data.files.every((file) => !('text' in file)));

    const record = readJsonl(path.join(dataDir, 'operations.jsonl'))
      .find((op) => op.capability === 'backup.inspect');
    assert.ok(record);
    assert.ok(!JSON.stringify(record).includes('MARKER-'), 'the inspection record must not copy the archive contents');

    // The module still returns the stored text for callers that need it; only the audit record omits it.
    const read = await inspectArchive({ source: destination });
    assert.ok(read.files.some((file) => file.name === 'notes.jsonl' && file.text.includes('MARKER-')));
  });
});

describe('backup.restore', () => {
  test('replaces the changed files, writes a pre-restore archive, and records itself in the restored log', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);
    const exported = await app.controller.backupExport({ path: destination });
    const digest = exported.operation.steps[0].result.data.archiveSha256;
    const knowledgeBefore = fs.readFileSync(path.join(dataDir, 'knowledge.jsonl'), 'utf8');

    await app.controller.knowledgeAdd({ subject: 'Beta', relationship: 'is', object: 'two' });
    assert.notEqual(fs.readFileSync(path.join(dataDir, 'knowledge.jsonl'), 'utf8'), knowledgeBefore);

    const res = await app.controller.backupRestore({
      path: destination, confirm: digest.slice(0, CONFIRMATION_MIN_CHARS), replaceExisting: true,
    });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.operation.steps[0].verification.detail);
    const data = res.operation.steps[0].result.data;
    assert.equal(fs.readFileSync(path.join(dataDir, 'knowledge.jsonl'), 'utf8'), knowledgeBefore);
    assert.ok(data.replaced.includes('knowledge.jsonl'));
    assert.ok(data.safetyPath !== null && fs.existsSync(data.safetyPath));
    assert.ok(data.safetyPath.includes(`${path.sep}backups${path.sep}pre-restore-`), data.safetyPath);
    assert.match(res.display, /appended to the restored audit log/);

    const ops = readJsonl(path.join(dataDir, 'operations.jsonl'));
    const last = ops.at(-1);
    assert.equal(last.capability, 'backup.restore');
    assert.equal(last.status, Outcome.SUCCESS_VERIFIED);
    const listed = await app.controller.knowledgeList({ limit: 10 });
    assert.match(listed.display, /Alpha/);
    assert.ok(!listed.display.includes('Beta'));
  });

  test('a wrong or short confirmation refuses and changes nothing', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);
    const exported = await app.controller.backupExport({ path: destination });
    const digest = exported.operation.steps[0].result.data.archiveSha256;
    await app.controller.knowledgeAdd({ subject: 'Beta', relationship: 'is', object: 'two' });
    const before = fs.readFileSync(path.join(dataDir, 'knowledge.jsonl'));

    const wrong = await app.controller.backupRestore({ path: destination, confirm: 'deadbeefdead', replaceExisting: true });
    assert.equal(wrong.status, Outcome.EXECUTION_FAILED);
    assert.equal(failureCode(wrong), 'BACKUP_CONFIRMATION_REQUIRED');

    const short = await app.controller.backupRestore({ path: destination, confirm: digest.slice(0, CONFIRMATION_MIN_CHARS - 1), replaceExisting: true });
    assert.equal(failureCode(short), 'BACKUP_CONFIRMATION_REQUIRED');
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'knowledge.jsonl')), before);
    assert.equal(fs.existsSync(path.join(dataDir, 'backups')), false, 'no pre-restore archive was written');
  });

  test('refuses to replace existing bytes without replaceExisting', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);
    const exported = await app.controller.backupExport({ path: destination });
    const digest = exported.operation.steps[0].result.data.archiveSha256;
    await app.controller.knowledgeAdd({ subject: 'Beta', relationship: 'is', object: 'two' });
    const before = fs.readFileSync(path.join(dataDir, 'knowledge.jsonl'));

    const res = await app.controller.backupRestore({ path: destination, confirm: digest.slice(0, 12) });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(failureCode(res), 'BACKUP_REPLACE_REQUIRED');
    assert.match(res.operation.steps[0].execution.error.message, /knowledge\.jsonl/);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'knowledge.jsonl')), before);
    assert.equal(fs.existsSync(path.join(dataDir, 'backups')), false);
  });

  test('restores into a data directory whose files are missing without replaceExisting', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);
    const exported = await app.controller.backupExport({ path: destination });
    const digest = exported.operation.steps[0].result.data.archiveSha256;
    const archived = exported.operation.steps[0].result.data.files.map((file) => file.name);

    // The data directory still exists, but the stores are gone (for example after a mistaken
    // delete). Nothing here overwrites an existing file, so nothing needs preserving.
    for (const name of archived) fs.unlinkSync(path.join(dataDir, name));

    const res = await app.controller.backupRestore({ path: destination, confirm: digest.slice(0, 12) });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.operation.steps[0].verification.detail);
    const data = res.operation.steps[0].result.data;
    assert.deepEqual(data.replaced, [], 'no existing file was replaced');
    assert.deepEqual(data.unchanged, [], 'no file was already equal');
    assert.deepEqual([...data.created].sort(), [...archived].sort(), 'every archived file was created');
    assert.equal(data.safetyPath, null, 'no pre-restore archive is needed when nothing is overwritten');
    assert.equal(fs.existsSync(path.join(dataDir, 'backups')), false);
    assert.match(res.display, /created:\s+.*knowledge\.jsonl/);
    assert.match(res.display, /no existing file was replaced, so none was written/);
    for (const name of archived) assert.ok(fs.existsSync(path.join(dataDir, name)), `${name} was written`);

    const reopened = createApp({ dataDir, now: () => NOW });
    const listed = await reopened.controller.knowledgeList({ limit: 10 });
    assert.match(listed.display, /Alpha/);
  });

  test('a snapshot never holds its own export record, so even an immediate restore asks to replace the audit file', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);
    const exported = await app.controller.backupExport({ path: destination });
    const digest = exported.operation.steps[0].result.data.archiveSha256;

    // The export's own audit line is appended after the archive was built, so the snapshot cannot
    // contain it. That difference is real audit history and is not overwritten silently.
    const refused = await app.controller.backupRestore({ path: destination, confirm: digest.slice(0, 12) });
    assert.equal(failureCode(refused), 'BACKUP_REPLACE_REQUIRED');
    assert.match(refused.operation.steps[0].execution.error.message, /operations\.jsonl/);

    const res = await app.controller.backupRestore({ path: destination, confirm: digest.slice(0, 12), replaceExisting: true });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.operation.steps[0].verification.detail);
    const data = res.operation.steps[0].result.data;
    assert.deepEqual(data.replaced, ['operations.jsonl'], 'only the audit log differs from the snapshot');
    assert.ok(data.unchanged.includes('knowledge.jsonl'));
    assert.ok(data.unchanged.includes('memory.jsonl'));
    assert.ok(data.safetyPath !== null && fs.existsSync(data.safetyPath), 'the overwritten audit line is preserved');
  });

  test('files the archive does not hold are left in place and reported', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);
    const exported = await app.controller.backupExport({ path: destination });
    const digest = exported.operation.steps[0].result.data.archiveSha256;

    fs.appendFileSync(path.join(dataDir, 'deadlines.jsonl'), `${JSON.stringify({
      schema: 'apex.deadline/1', id: 'dl-later', title: 'later record', dueAt: '2026-12-01',
      source: { path: 'plan.csv', sha256: 'a'.repeat(64), line: 1 }, recordedAt: NOW.toISOString(), sequence: 1,
    })}\n`);

    const res = await app.controller.backupRestore({ path: destination, confirm: digest.slice(0, 12), replaceExisting: true });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.operation.steps[0].verification.detail);
    const data = res.operation.steps[0].result.data;
    assert.ok(data.leftInPlace.includes('deadlines.jsonl'));
    assert.match(res.display, /restore does not delete records/);
    assert.ok(fs.existsSync(path.join(dataDir, 'deadlines.jsonl')));
  });

  test('refuses while a store lock file is present', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);
    const exported = await app.controller.backupExport({ path: destination });
    const digest = exported.operation.steps[0].result.data.archiveSha256;
    fs.writeFileSync(path.join(dataDir, 'memory.jsonl.lock'), '{}');
    const res = await app.controller.backupRestore({ path: destination, confirm: digest.slice(0, 12), replaceExisting: true });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(failureCode(res), 'BACKUP_STORE_BUSY');
  });

  test('a model origin can neither export nor restore', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);
    const exported = await app.controller.backupExport({ path: destination });
    const digest = exported.operation.steps[0].result.data.archiveSha256;

    const modelExport = await app.controller.runAction('backup.export', { path: archivePath(elsewhere, 'model.json') }, 'model', 'op1');
    assert.equal(modelExport.outcome, Outcome.ACTION_DENIED);
    assert.equal(fs.existsSync(archivePath(elsewhere, 'model.json')), false);

    const before = fs.readFileSync(path.join(dataDir, 'knowledge.jsonl'));
    const modelRestore = await app.controller.runAction(
      'backup.restore', { path: destination, confirm: digest.slice(0, 12), replaceExisting: true }, 'model', 'op2',
    );
    assert.equal(modelRestore.outcome, Outcome.ACTION_DENIED);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'knowledge.jsonl')), before);
  });

  test('the three backup actions are unplannable and audited with their paths', async () => {
    const { app, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);
    for (const name of ['backup.export', 'backup.inspect', 'backup.restore']) {
      assert.equal(app.registry.get(name).plannable, false, `${name} must never be a plan step`);
    }
    const exported = await app.controller.backupExport({ path: destination });
    const digest = exported.operation.steps[0].result.data.archiveSha256;
    const res = await app.controller.backupRestore({ path: destination, confirm: digest.slice(0, 12), replaceExisting: true });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);

    const archived = await exportArchive({ dataDir: app.dataDir, destination: archivePath(elsewhere, 'audit.json'), now: () => NOW, appVersion: 'test' });
    const document = JSON.parse(fs.readFileSync(archived.path, 'utf8'));
    const ops = document.contents['operations.jsonl'].trim().split('\n').map((line) => JSON.parse(line));
    const restoreLine = ops.find((op) => op.capability === 'backup.restore');
    assert.ok(restoreLine, 'the restore is in the audit log at the moment the archive was taken');
    assert.equal(restoreLine.steps[0].input.path, destination);
    assert.equal(restoreLine.steps[0].input.confirm, digest.slice(0, 12));
  });
});

describe('backup module contract', () => {
  test('the data-file list is fixed and the module refuses to write outside its contract', async () => {
    assert.equal(new Set(DATA_FILES).size, DATA_FILES.length);
    assert.ok(DATA_FILES.includes('notes.jsonl') && DATA_FILES.includes('operations.jsonl'));
    assert.ok(!DATA_FILES.some((name) => name.includes(path.sep) || name.includes('/')));
    const { dataDir, elsewhere } = appFor();
    await assert.rejects(
      () => restoreArchive({ dataDir, source: archivePath(elsewhere, 'no.json'), confirm: 'abcdef12', appVersion: 'test' }),
      (err) => err.code === 'BACKUP_NOT_FOUND',
    );
  });
});

describe('backup CLI', () => {
  test('export, inspect, and a confirmed restore through the real command line', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, APEX_DATA_ISOLATED: '1' });

    const exported = await runCli(['backup', 'export', destination], env);
    assert.equal(exported.code, 0, exported.stderr);
    assert.match(exported.stdout, /Exported \d+ of 15 APEX data files/);
    const digestLine = exported.stdout.match(/archive sha256: ([0-9a-f]{64})/);
    assert.ok(digestLine, exported.stdout);

    const inspected = await runCli(['backup', 'inspect', destination], env);
    assert.equal(inspected.code, 0, inspected.stderr);
    assert.match(inspected.stdout, /is valid and can be restored/);

    await app.controller.knowledgeAdd({ subject: 'Beta', relationship: 'is', object: 'two' });
    const restored = await runCli(
      ['backup', 'restore', destination, '--confirm', digestLine[1].slice(0, 12), '--replace-existing'],
      env,
    );
    assert.equal(restored.code, 0, restored.stderr);
    assert.match(restored.stdout, /appended to the restored audit log/);
    const listed = await runCli(['knowledge', 'list'], env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /Alpha/);
    assert.ok(!listed.stdout.includes('Beta'));
  });

  test('usage errors exit 2; a missing confirmation is a refusal', async () => {
    const { app, dataDir, elsewhere } = appFor();
    await seed(app);
    const destination = archivePath(elsewhere);
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, APEX_DATA_ISOLATED: '1' });
    assert.equal((await runCli(['backup', 'export', destination], env)).code, 0);

    assert.equal((await runCli(['backup', 'restore', destination], env)).code, 1);
    assert.equal((await runCli(['backup', 'inspect'], env)).code, 2);
    assert.equal((await runCli(['backup', 'nonsense'], env)).code, 2);
    assert.equal((await runCli(['backup', 'inspect', destination, '--frobnicate'], env)).code, 2);
  });
});
