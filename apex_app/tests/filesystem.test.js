// Bounded, read-only filesystem inspection: normal behaviour, security boundaries,
// independent verification, and failure handling. Every test uses its own temp data
// directory and its own temp authorized root; the real project tree is never read.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { resolveRoot, resolveInside, isInside } from '../src/filesystem/path.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const d = makeTempDataDir();
  dirs.push(d);
  return d;
}

function fixture() {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'notes.txt'), 'hello apex\n');
  fs.writeFileSync(path.join(root, 'empty.txt'), '');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'inner.txt'), 'inner\n');
  fs.mkdirSync(path.join(root, 'empty-dir'));
  return root;
}

function appFor(root, options = {}) {
  return createApp({ dataDir: tempDir(), filesystemRoot: root, ...options });
}

function entryNames(step) {
  return step.result.data.entries.map((e) => e.name);
}

describe('filesystem: authorised listing and reading', () => {
  test('lists an authorised directory with name and type, and verifies the result', async () => {
    const root = fixture();
    const app = appFor(root);
    const res = await app.controller.handle('list .');

    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.operation.capability, 'filesystem.list');
    const step = res.operation.steps[0];
    assert.equal(step.authorization.decision, 'allow');
    assert.equal(step.execution.status, 'ok');
    assert.equal(step.verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.deepEqual(entryNames(step), ['empty-dir', 'empty.txt', 'notes.txt', 'sub']);
    assert.deepEqual(step.result.data.entries.map((e) => e.type), ['directory', 'file', 'file', 'directory']);
    assert.equal(step.result.data.count, 4);
    assert.equal(step.result.data.truncated, false);
    assert.match(res.display, /notes\.txt/);
    assert.equal(res.recorded, true);
  });

  test('reads a bounded text file inside the root and keeps its content out of the audit log', async () => {
    const root = fixture();
    const app = appFor(root);
    const res = await app.controller.handle('read notes.txt');

    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.operation.capability, 'filesystem.read');
    assert.match(res.display, /hello apex/);
    const step = res.operation.steps[0];
    assert.equal(step.result.data.size, 11);
    assert.match(step.result.data.sha256, /^[0-9a-f]{64}$/);
    // Content is redacted in the persisted record, and no absolute path is recorded.
    assert.equal(step.result.data.content, '[omitted 11 chars]');
    const persisted = fs.readFileSync(path.join(app.dataDir, 'operations.jsonl'), 'utf8');
    assert.ok(!persisted.includes('hello apex'), 'file content must not be written to the audit log');
    assert.ok(!persisted.includes(root), 'the absolute root must not be written to the audit log');
  });

  test('an empty directory and an empty file are handled as valid, verified results', async () => {
    const root = fixture();
    const app = appFor(root);

    const dirRes = await app.controller.handle('list empty-dir/');
    assert.equal(dirRes.status, Outcome.SUCCESS_VERIFIED);
    assert.deepEqual(dirRes.operation.steps[0].result.data.entries, []);
    assert.equal(dirRes.operation.steps[0].result.data.total, 0);

    const fileRes = await app.controller.handle('read empty.txt');
    assert.equal(fileRes.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(fileRes.operation.steps[0].result.data.size, 0);
    assert.match(fileRes.display, /empty\.txt \(0 bytes\)/);
    // An empty file is still redacted in the audit record rather than stored verbatim.
    assert.equal(fileRes.operation.steps[0].result.data.content, '[omitted 0 chars]');
  });

  test('a large directory is listed up to an explicit limit and marks the result truncated', async () => {
    const root = tempDir();
    for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(root, `f${String(i).padStart(2, '0')}.txt`), 'x');
    const app = appFor(root);

    const res = await app.controller.runAction('filesystem.list', { path: '.', limit: 5 }, 'user', 'op-x');
    assert.equal(res.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.result.data.entries.length, 5);
    assert.equal(res.result.data.total, 12);
    assert.equal(res.result.data.truncated, true);
    assert.equal(res.result.data.limit, 5);
  });

  test('a crafted file name cannot inject terminal control characters into the display', async (t) => {
    const root = fixture();
    const hostile = 'evil\u001b[31m.txt';
    try {
      fs.writeFileSync(path.join(root, hostile), 'x');
    } catch (err) {
      t.skip(`this filesystem rejects control characters in names (${err.code})`);
      return;
    }
    const app = appFor(root);
    const res = await app.controller.runAction('filesystem.list', { path: '.' }, 'user', 'op-x');
    assert.equal(res.outcome, Outcome.SUCCESS_VERIFIED);
    assert.ok(res.result.data.entries.some((e) => e.name === hostile), 'the raw name is kept as data');
    assert.ok(!res.display.includes('\u001b'), 'the displayed listing must not contain escape sequences');
    assert.match(res.display, /evil\?\[31m\.txt/);
  });

  test('the authorised root is reported by status and the capability is absent without one', async () => {
    const root = fixture();
    const withRoot = appFor(root);
    const statusWith = await withRoot.getStatus();
    assert.equal(statusWith.filesystemRoot, fs.realpathSync(root));
    assert.equal(withRoot.registry.get('filesystem.list').permission, 'read');
    assert.equal(withRoot.registry.get('filesystem.read').permission, 'read');

    const withoutRoot = createApp({ dataDir: tempDir() });
    assert.equal(withoutRoot.registry.get('filesystem.list'), null);
    assert.equal((await withoutRoot.getStatus()).filesystemRoot, null);
  });
});

describe('filesystem: security boundaries', () => {
  test('a traversal component is refused before any filesystem access', async () => {
    const root = fixture();
    const app = appFor(root);
    const res = await app.controller.handle('list ../');

    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(res.operation.steps[0].execution.error.code, 'ACCESS_DENIED');
    assert.match(res.operation.steps[0].execution.error.message, /traversal/);
    assert.equal(res.operation.steps[0].verification.outcome, 'not_run');
  });

  test('an absolute path outside the root is refused (POSIX and Windows forms)', async () => {
    const root = fixture();
    const app = appFor(root);

    const outsideFile = path.join(tempDir(), 'outside.txt');
    fs.writeFileSync(outsideFile, 'do not read me\n');
    const viaRouter = await app.controller.handle(`read ${outsideFile}`);
    assert.equal(viaRouter.status, Outcome.EXECUTION_FAILED);
    assert.equal(viaRouter.operation.steps[0].execution.error.code, 'ACCESS_DENIED');
    assert.ok(!JSON.stringify(viaRouter.operation).includes('do not read me'));

    const windowsForms = [
      '..\\..\\windows\\system32\\config\\sam',
      '\\\\server\\share\\secret.txt',
      'C:\\Windows\\win.ini',
      '/etc/passwd',
    ];
    for (const p of windowsForms) {
      const step = await app.controller.runAction('filesystem.read', { path: p }, 'user', 'op-x');
      assert.equal(step.execution.status, 'failed', `expected refusal for ${p}`);
      assert.equal(step.execution.error.code, 'ACCESS_DENIED', `expected ACCESS_DENIED for ${p}`);
    }
  });

  test('Windows-style separators are accepted only as relative paths inside the root', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('backslash separators are only meaningful on Windows');
      return;
    }
    const root = fixture();
    const app = appFor(root);
    const res = await app.controller.runAction('filesystem.read', { path: 'sub\\inner.txt' }, 'user', 'op-x');
    assert.equal(res.outcome, Outcome.SUCCESS_VERIFIED);
    assert.match(res.display, /inner/);
  });

  test('a symbolic link out of the root cannot be used to list or read', async (t) => {
    const root = fixture();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret\n');
    try {
      fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOSYS') {
        t.skip(`symbolic links are not permitted in this environment (${err.code})`);
        return;
      }
      throw err;
    }
    const app = appFor(root);

    const listed = await app.controller.runAction('filesystem.list', { path: 'escape' }, 'user', 'op-x');
    assert.equal(listed.execution.status, 'failed');
    // The link resolves outside the root, so containment refuses it before anything is read.
    assert.equal(listed.execution.error.code, 'ACCESS_DENIED');

    const read = await app.controller.runAction('filesystem.read', { path: 'escape/secret.txt' }, 'user', 'op-x');
    assert.equal(read.execution.status, 'failed');
    assert.equal(read.execution.error.code, 'ACCESS_DENIED');
    assert.ok(!JSON.stringify(read).includes('outside secret'));
  });

  test('a symbolic link is refused even when its target is inside the root', async (t) => {
    const root = fixture();
    try {
      fs.symlinkSync(path.join(root, 'notes.txt'), path.join(root, 'alias.txt'), 'file');
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOSYS') {
        t.skip(`symbolic links are not permitted in this environment (${err.code})`);
        return;
      }
      throw err;
    }
    const app = appFor(root);
    const res = await app.controller.runAction('filesystem.read', { path: 'alias.txt' }, 'user', 'op-x');
    assert.equal(res.execution.status, 'failed');
    assert.equal(res.execution.error.code, 'SYMLINK_REFUSED');
  });

  test('a request cannot widen the authorised root', async () => {
    const root = fixture();
    const app = appFor(root);

    const extraField = await app.controller.runAction(
      'filesystem.list',
      { path: '.', root: tempDir(), authorizedRoot: 'C:\\' },
      'user',
      'op-x',
    );
    assert.equal(extraField.execution.status, 'rejected');
    assert.match(extraField.summary, /unexpected input field/);

    // The action closure still uses the configured root: a sibling file outside it is absent.
    const stillScoped = await app.controller.runAction('filesystem.list', { path: '.' }, 'user', 'op-y');
    assert.equal(stillScoped.outcome, Outcome.SUCCESS_VERIFIED);
    assert.deepEqual(entryNames(stillScoped), ['empty-dir', 'empty.txt', 'notes.txt', 'sub']);
  });

  test('a model-origin request cannot trigger filesystem inspection', async () => {
    const root = fixture();
    const app = appFor(root);

    const handled = await app.controller.handle('list .', { origin: 'model' });
    assert.equal(handled.status, Outcome.ACTION_DENIED);
    assert.equal(handled.operation.steps[0].authorization.reason, 'ORIGIN_NOT_PERMITTED');
    assert.equal(handled.operation.steps[0].execution.status, 'not_run');

    // A model-shaped path from a user request is still refused by containment.
    const outOfRoot = await app.controller.runAction('filesystem.read', { path: '../outside.txt' }, 'user', 'op-z');
    assert.equal(outOfRoot.execution.error.code, 'ACCESS_DENIED');
  });

  test('an oversized file is refused, and the request cannot raise the limit', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(200));
    const app = appFor(root, { filesystemMaxReadBytes: 64 });

    const tooLarge = await app.controller.runAction('filesystem.read', { path: 'big.txt' }, 'user', 'op-x');
    assert.equal(tooLarge.execution.status, 'failed');
    assert.equal(tooLarge.execution.error.code, 'FILE_TOO_LARGE');

    const raise = await app.controller.runAction('filesystem.read', { path: 'big.txt', maxBytes: 1_000_000 }, 'user', 'op-y');
    assert.equal(raise.execution.status, 'rejected');
    assert.match(raise.summary, /maxBytes/);
  });

  test('reading requires a regular file: a directory is refused', async () => {
    const root = fixture();
    const app = appFor(root);
    const res = await app.controller.runAction('filesystem.read', { path: 'sub' }, 'user', 'op-x');
    assert.equal(res.execution.status, 'failed');
    assert.equal(res.execution.error.code, 'NOT_A_REGULAR_FILE');
  });

  test('binary content is refused instead of being returned as text', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42, 0x00]));
    const app = appFor(root);
    const res = await app.controller.runAction('filesystem.read', { path: 'blob.bin' }, 'user', 'op-x');
    assert.equal(res.execution.status, 'failed');
    assert.equal(res.execution.error.code, 'FILE_NOT_TEXT');

    fs.writeFileSync(path.join(root, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0xfd]));
    const invalid = await app.controller.runAction('filesystem.read', { path: 'invalid.txt' }, 'user', 'op-y');
    assert.equal(invalid.execution.error.code, 'FILE_NOT_TEXT');
  });

  test('inspection never writes, deletes, or renames anything', async () => {
    const root = fixture();
    const app = appFor(root);
    const before = fs.readdirSync(root, { recursive: true }).sort();
    const beforeContent = fs.readFileSync(path.join(root, 'notes.txt'), 'utf8');

    await app.controller.handle('list .');
    await app.controller.handle('read notes.txt');
    await app.controller.handle('list sub/');

    const after = fs.readdirSync(root, { recursive: true }).sort();
    assert.deepEqual(after, before);
    assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), beforeContent);
    for (const name of ['filesystem.list', 'filesystem.read']) {
      assert.equal(app.registry.get(name).permission, 'read');
      assert.deepEqual([...app.registry.get(name).origins], ['user']);
    }
  });

  test('path helpers refuse unusable roots and containment is boundary-exact', () => {
    assert.throws(() => resolveRoot('relative/dir'), /absolute/);
    assert.throws(() => resolveRoot('\\\\server\\share'), /UNC/);
    assert.equal(resolveRoot(fixture()), fs.realpathSync(dirs[dirs.length - 1]));

    const root = tempDir();
    fs.mkdirSync(path.join(root, 'allowed'));
    fs.mkdirSync(path.join(root, 'allowed-2'));
    assert.equal(isInside(path.join(root, 'allowed', 'x'), path.join(root, 'allowed')), true);
    assert.equal(isInside(path.join(root, 'allowed-2', 'x'), path.join(root, 'allowed')), false);
    assert.throws(() => resolveInside(path.join(root, 'allowed'), '..'), /traversal/);
  });
});

describe('filesystem: failure handling', () => {
  test('a missing path is reported honestly, not as an empty result', async () => {
    const root = fixture();
    const app = appFor(root);

    const file = await app.controller.runAction('filesystem.read', { path: 'missing.txt' }, 'user', 'op-x');
    assert.equal(file.execution.status, 'failed');
    assert.equal(file.execution.error.code, 'PATH_NOT_FOUND');
    assert.equal(file.outcome, Outcome.EXECUTION_FAILED);

    const dir = await app.controller.runAction('filesystem.list', { path: 'missing-dir/' }, 'user', 'op-y');
    assert.equal(dir.execution.error.code, 'PATH_NOT_FOUND');
  });

  test('a permission error is reported as PERMISSION_DENIED', async (t) => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
      t.skip('POSIX permission bits are not enforced in this environment');
      return;
    }
    const root = fixture();
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'hidden.txt'), 'hidden\n');
    fs.chmodSync(locked, 0o000);
    try {
      const app = appFor(root);
      const res = await app.controller.runAction('filesystem.list', { path: 'locked/' }, 'user', 'op-x');
      assert.equal(res.execution.status, 'failed');
      assert.equal(res.execution.error.code, 'PERMISSION_DENIED');
      assert.equal(res.verification.outcome, 'not_run');
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  test('independent verification fails when the file changes after it was read', async () => {
    const root = fixture();
    const app = appFor(root);
    const def = app.registry.get('filesystem.read');
    const input = def.validate({ path: 'notes.txt' });
    const result = await def.execute({ root: app.filesystemRoot }, input);

    fs.writeFileSync(path.join(root, 'notes.txt'), 'changed after the read\n');
    const decision = await def.verify({ root: app.filesystemRoot }, input, result);
    assert.equal(decision.ok, false);
    assert.match(decision.detail, /changed|bytes/);
  });

  test('independent verification fails when the directory changes after it was listed', async () => {
    const root = fixture();
    const app = appFor(root);
    const def = app.registry.get('filesystem.list');
    const input = def.validate({ path: '.' });
    const result = await def.execute({ root: app.filesystemRoot }, input);

    fs.writeFileSync(path.join(root, 'appeared-later.txt'), 'x');
    const decision = await def.verify({ root: app.filesystemRoot }, input, result);
    assert.equal(decision.ok, false);
    assert.match(decision.detail, /entries/);
  });

  test('verification does not trust a fabricated result', async () => {
    const root = fixture();
    const app = appFor(root);
    const def = app.registry.get('filesystem.read');
    const input = def.validate({ path: 'notes.txt' });
    const fabricated = {
      data: { path: 'notes.txt', size: 11, maxBytes: 1024, sha256: 'f'.repeat(64), content: 'not the real content' },
    };
    const decision = await def.verify({ root: app.filesystemRoot }, input, fabricated);
    assert.equal(decision.ok, false);
  });

  test('an audit write failure leaves the result visible but unrecorded', async () => {
    const root = fixture();
    const dataDir = tempDir();
    const app = createApp({ dataDir, filesystemRoot: root });
    fs.rmSync(path.join(dataDir, 'operations.jsonl'), { force: true });
    fs.mkdirSync(path.join(dataDir, 'operations.jsonl'));

    const res = await app.controller.handle('list .');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.recorded, false);
    assert.ok(res.recordError, 'the failure reason must be reported');
    assert.match(res.display, /notes\.txt/);
  });

  test('a task with filesystem steps reports audit_integrity_failed when a step record is lost', async () => {
    const root = fixture();
    const dataDir = tempDir();
    const app = createApp({ dataDir, filesystemRoot: root });

    const planned = await app.controller.planTask('list sub/ then read notes.txt');
    assert.equal(planned.status, Outcome.PLAN_CREATED, planned.display);
    const taskId = planned.task.id;

    fs.rmSync(path.join(dataDir, 'operations.jsonl'), { force: true });
    fs.mkdirSync(path.join(dataDir, 'operations.jsonl'));

    const run = await app.controller.runTask(taskId, 'run');
    assert.equal(run.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.ok(run.auditGaps >= 1);
  });
});

describe('filesystem: command line', () => {
  test('ask list/read works through the CLI when a root is configured', async () => {
    const root = fixture();
    const env = cleanEnv({ APEX_DATA_DIR: tempDir(), APEX_FILESYSTEM_ROOT: root });

    const listed = await runCli(['ask', 'list', '.'], env);
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    assert.match(listed.stdout, /success_verified/);
    assert.match(listed.stdout, /notes\.txt/);

    const read = await runCli(['ask', 'read', 'notes.txt'], env);
    assert.equal(read.code, 0, read.stdout + read.stderr);
    assert.match(read.stdout, /hello apex/);
  });

  test('without a configured root, filesystem requests are denied and nothing is read', async () => {
    const env = cleanEnv({ APEX_DATA_DIR: tempDir() });
    const res = await runCli(['ask', 'list', '.'], env);
    assert.equal(res.code, 1);
    assert.match(res.stdout, /action_denied|UNKNOWN_ACTION/);
  });

  test('a relative or unusable APEX_FILESYSTEM_ROOT is a configuration error (exit 2)', async () => {
    const env = cleanEnv({ APEX_DATA_DIR: tempDir(), APEX_FILESYSTEM_ROOT: 'relative/dir' });
    const res = await runCli(['status'], env);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /absolute/);

    const missing = await runCli(['status'], cleanEnv({
      APEX_DATA_DIR: tempDir(),
      APEX_FILESYSTEM_ROOT: path.join(tempDir(), 'does-not-exist'),
    }));
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /does not exist/);
  });
});
