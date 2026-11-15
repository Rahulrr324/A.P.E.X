// Workspace assistance: bounded discovery, summarisation, comparison, reporting, and the
// create-or-hash-guarded write. Every test uses its own temp data directory and its own
// temp authorized root; the real project tree is never read or written.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { route } from '../src/controller/router.js';
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
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nAlpha beta gamma.\n\nAlpha delta in the second line.\n');
  fs.writeFileSync(path.join(root, 'docs', 'guide.txt'), 'Guide\n\nFirst sentence. Second sentence. Third one.\n');
  fs.writeFileSync(path.join(root, 'docs', 'other.txt'), 'Guide\n\nFirst sentence. Second sentence. Third one.\n');
  fs.writeFileSync(path.join(root, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  return root;
}

function appFor(root, options = {}) {
  return createApp({ dataDir: tempDir(), filesystemRoot: root, ...options });
}

function persisted(app) {
  return fs.readFileSync(path.join(app.dataDir, 'operations.jsonl'), 'utf8');
}

describe('workspace.find', () => {
  test('finds by extension inside the root and verifies the match list', async () => {
    const root = fixture();
    const app = appFor(root);
    const step = await app.controller.runAction(
      'filesystem.find', { path: '.', extension: 'txt', maxDepth: 3 }, 'user', 'op-f',
    );
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(step.verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.deepEqual(step.result.data.matches.map((m) => m.path), ['docs/guide.txt', 'docs/other.txt']);
    assert.equal(step.result.data.truncated, false);
    assert.match(step.display, /docs\/guide\.txt/);
  });

  test('finds by name substring and reports an empty result as empty', async () => {
    const root = fixture();
    const app = appFor(root);
    const step = await app.controller.runAction('filesystem.find', { name: 'notes' }, 'user', 'op-f');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.deepEqual(step.result.data.matches.map((m) => m.path), ['notes.md']);

    const empty = await app.controller.runAction('filesystem.find', { name: 'nothing-here' }, 'user', 'op-f2');
    assert.equal(empty.outcome, Outcome.SUCCESS_VERIFIED);
    assert.deepEqual(empty.result.data.matches, []);
    assert.match(empty.display, /\(none\)/);
  });

  test('refuses traversal, absolute paths, and a symlinked directory escape', async (t) => {
    const root = fixture();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');
    } catch {
      linked = false;
    }
    const app = appFor(root);

    for (const input of [{ path: '../' }, { path: path.join(outside, 'secret.txt') }]) {
      const step = await app.controller.runAction('filesystem.find', input, 'user', 'op-x');
      assert.equal(step.outcome, Outcome.EXECUTION_FAILED);
      assert.equal(step.execution.error.code, 'ACCESS_DENIED');
      assert.match(step.summary, /traversal|absolute/i);
    }
    if (linked) {
      const step = await app.controller.runAction('filesystem.find', { path: 'escape' }, 'user', 'op-x');
      assert.ok(step.outcome === Outcome.INPUT_REJECTED || step.outcome === Outcome.EXECUTION_FAILED);
      assert.equal(step.result, null);
    } else {
      t.diagnostic('symlinks are not permitted in this environment; the link case was not run');
    }
  });

  test('a link inside a scanned directory is counted, never followed', async (t) => {
    const root = fixture();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside\n');
    try {
      fs.symlinkSync(outside, path.join(root, 'docs', 'linked'), 'dir');
    } catch {
      t.diagnostic('symlinks are not permitted in this environment; the scan-link case was not run');
      return;
    }
    const app = appFor(root);
    const step = await app.controller.runAction('filesystem.find', { path: 'docs', name: 'linked' }, 'user', 'op-l');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(step.result.data.skippedLinks, 1);
    assert.deepEqual(step.result.data.matches.map((m) => m.path), ['docs/linked']);
  });
});

describe('workspace.summarize', () => {
  test('produces a deterministic extract and recomputes it during verification', async () => {
    const root = fixture();
    const app = appFor(root);
    const step = await app.controller.runAction('filesystem.summarize', { path: 'notes.md' }, 'user', 'op-s');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.deepEqual(step.result.data.headings, ['Notes']);
    assert.ok(step.result.data.keywords.some((k) => k.word === 'alpha'));
    assert.match(step.result.data.summary, /Alpha beta gamma/);
    assert.match(step.display, /deterministic extract/);
    assert.ok(!('content' in step.result.data), 'the summary does not republish the file');
  });

  test('refuses a binary file rather than describing it as text', async () => {
    const root = fixture();
    const app = appFor(root);
    const step = await app.controller.runAction('filesystem.summarize', { path: 'data.bin' }, 'user', 'op-b');
    assert.equal(step.outcome, Outcome.EXECUTION_FAILED);
    assert.match(step.summary, /not valid UTF-8|binary/i);
  });

  test('refuses a file above the configured byte bound', async () => {
    const root = fixture();
    const app = appFor(root);
    const step = await app.controller.runAction(
      'filesystem.summarize', { path: 'notes.md', maxBytes: 4 }, 'user', 'op-l',
    );
    assert.equal(step.outcome, Outcome.EXECUTION_FAILED);
    assert.match(step.summary, /limit/);
  });

  test('refuses a directory', async () => {
    const root = fixture();
    const app = appFor(root);
    const step = await app.controller.runAction('filesystem.summarize', { path: 'docs' }, 'user', 'op-d');
    assert.equal(step.outcome, Outcome.EXECUTION_FAILED);
    assert.match(step.summary, /not a regular file/);
  });
});

describe('workspace.compare', () => {
  test('reports identical files as identical', async () => {
    const root = fixture();
    const app = appFor(root);
    const step = await app.controller.runAction(
      'filesystem.compare', { a: 'docs/guide.txt', b: 'docs/other.txt' }, 'user', 'op-c',
    );
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(step.result.data.identical, true);
    assert.equal(step.result.data.method, 'positional line comparison');
    assert.match(step.display, /identical/);
  });

  test('counts and samples positional differences without claiming an edit script', async () => {
    const root = fixture();
    const app = appFor(root);
    const step = await app.controller.runAction(
      'filesystem.compare', { a: 'notes.md', b: 'docs/guide.txt' }, 'user', 'op-c',
    );
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(step.result.data.identical, false);
    assert.equal(step.result.data.differingLines, 2);
    assert.equal(step.result.data.aOnlyLines, 2);
    assert.equal(step.result.data.bOnlyLines, 0);
    assert.equal(step.result.data.samples[0].line, 1);
    assert.match(step.display, /positional line comparison/);
  });
});

describe('workspace.report', () => {
  test('counts files, directories, links, bytes, and names the largest files', async () => {
    const root = fixture();
    const app = appFor(root);
    const step = await app.controller.runAction('filesystem.report', { path: '.' }, 'user', 'op-r');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(step.result.data.files, 4);
    assert.equal(step.result.data.directories, 1);
    assert.equal(step.result.data.links, 0);
    assert.ok(step.result.data.bytes > 0);
    assert.ok(step.result.data.extensions.some((e) => e.extension === 'txt'));
    assert.equal(step.result.data.largest.length, 4);
    assert.match(step.display, /Workspace report/);
  });
});

describe('workspace.write', () => {
  test('creates a file inside the root and verifies the bytes independently', async () => {
    const root = fixture();
    const app = appFor(root);
    const res = await app.controller.workspaceWrite({ path: 'docs/new.md', content: 'hello write\n' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.operation.capability, 'filesystem.write');
    assert.equal(res.operation.steps[0].result.data.mode, 'created');
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'new.md'), 'utf8'), 'hello write\n');
    assert.equal(res.recorded, true);
  });

  test('never silently overwrites: an existing target is refused without a hash', async () => {
    const root = fixture();
    const app = appFor(root);
    const res = await app.controller.workspaceWrite({ path: 'notes.md', content: 'clobbered\n' });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /already exists|expectedSha256/i);
    assert.match(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), /^# Notes/);
  });

  test('replaces only when the supplied hash matches, and refuses a stale hash', async () => {
    const root = fixture();
    const app = appFor(root);
    const original = fs.readFileSync(path.join(root, 'notes.md'));

    const stale = await app.controller.workspaceWrite({
      path: 'notes.md',
      content: 'replacement\n',
      expectedSha256: 'a'.repeat(64),
    });
    assert.equal(stale.status, Outcome.EXECUTION_FAILED);
    assert.match(stale.display, /HASH_MISMATCH|changed since/i);
    assert.deepEqual(fs.readFileSync(path.join(root, 'notes.md')), original);

    const digest = (await import('node:crypto')).createHash('sha256').update(original).digest('hex');
    const replaced = await app.controller.workspaceWrite({
      path: 'notes.md',
      content: 'replacement\n',
      expectedSha256: digest,
    });
    assert.equal(replaced.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(replaced.operation.steps[0].result.data.mode, 'replaced');
    assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), 'replacement\n');
  });

  test('keeps the written content out of the audit log', async () => {
    const root = fixture();
    const app = appFor(root);
    const secretText = 'a private note that must not be duplicated into the audit log';
    const res = await app.controller.workspaceWrite({ path: 'private.md', content: secretText });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    const log = persisted(app);
    assert.ok(!log.includes(secretText), 'file content must not be written to the operation log');
    assert.ok(!log.includes(root), 'the absolute root must not be written to the operation log');
    assert.ok(log.includes('private.md'));
    assert.match(log, /value omitted: \d+ chars/);
  });

  test('refuses traversal and absolute targets without touching anything outside the root', async () => {
    const root = fixture();
    const outside = tempDir();
    const app = appFor(root);
    const target = path.join(outside, 'escaped.txt');

    for (const p of ['../escaped.txt', target]) {
      const res = await app.controller.workspaceWrite({ path: p, content: 'nope\n' });
      assert.equal(res.status, Outcome.EXECUTION_FAILED);
      assert.match(res.display, /traversal|absolute/i);
    }
    assert.equal(fs.existsSync(target), false);
  });

  test('refuses a missing parent directory instead of creating one', async () => {
    const root = fixture();
    const app = appFor(root);
    const res = await app.controller.workspaceWrite({ path: 'missing/new.md', content: 'x\n' });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /parent directory does not exist/i);
    assert.equal(fs.existsSync(path.join(root, 'missing')), false);
  });

  test('refuses control characters in content', async () => {
    const root = fixture();
    const app = appFor(root);
    const res = await app.controller.workspaceWrite({ path: 'bad.txt', content: 'a\u0000b' });
    assert.equal(res.status, Outcome.INPUT_REJECTED);
    assert.equal(fs.existsSync(path.join(root, 'bad.txt')), false);
  });

  test('a model origin cannot write, and the write action is not plannable', async () => {
    const root = fixture();
    const app = appFor(root);
    const step = await app.controller.runAction(
      'filesystem.write', { path: 'model.txt', content: 'x\n' }, 'model', 'op-m',
    );
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.match(step.summary, /denied/);
    assert.equal(fs.existsSync(path.join(root, 'model.txt')), false);
    assert.equal(app.registry.get('filesystem.write').plannable, false);
  });

  test('without a configured root no workspace action is registered', async () => {
    const app = createApp({ dataDir: tempDir() });
    const names = app.registry.list().map((d) => d.name);
    for (const name of ['filesystem.find', 'filesystem.summarize', 'filesystem.compare', 'filesystem.report', 'filesystem.write']) {
      assert.ok(!names.includes(name), `${name} must not exist without a root`);
    }
    await assert.rejects(
      () => app.controller.workspaceReport({ path: '.' }),
      /no filesystem root is configured/,
    );
  });
});

describe('workspace natural-language and CLI surface', () => {
  test('workspace requests route deterministically, and a non-path request stays on the model path', async () => {
    assert.deepEqual(route('summarize notes.md'), {
      kind: 'action', capability: 'filesystem.summarize', action: 'filesystem.summarize', input: { path: 'notes.md' },
    });
    assert.deepEqual(route('find files named notes under docs/'), {
      kind: 'action', capability: 'filesystem.find', action: 'filesystem.find', input: { path: 'docs/', name: 'notes' },
    });
    assert.deepEqual(route('find files with extension txt'), {
      kind: 'action', capability: 'filesystem.find', action: 'filesystem.find', input: { extension: 'txt' },
    });
    assert.deepEqual(route('compare notes.md with docs/guide.txt'), {
      kind: 'action',
      capability: 'filesystem.compare',
      action: 'filesystem.compare',
      input: { a: 'notes.md', b: 'docs/guide.txt' },
    });
    assert.equal(route('workspace report').action, 'filesystem.report');
    assert.equal(route('report on docs/').action, 'filesystem.report');

    // A target that is not path-shaped is not turned into a file request.
    assert.equal(route('summarize my week').kind, 'model');
    assert.equal(route('compare apples and oranges').kind, 'model');
    assert.equal(route('create file notes').kind, 'model', 'a create request without content is not routed');
  });

  test('a workspace request runs through the real request path and verifies its own result', async () => {
    const root = fixture();
    const app = appFor(root);

    const summarized = await app.controller.handle('summarize notes.md');
    assert.equal(summarized.status, Outcome.SUCCESS_VERIFIED, summarized.display);
    assert.equal(summarized.operation.capability, 'filesystem.summarize');
    assert.match(summarized.display, /frequent terms/);

    const found = await app.controller.handle('find files with extension txt under docs/');
    assert.equal(found.status, Outcome.SUCCESS_VERIFIED, found.display);
    assert.match(found.display, /docs\/guide\.txt/);
    assert.match(found.display, /docs\/other\.txt/);
  });

  test('a create-file request writes only the stated content, never silently overwrites, and keeps it out of the audit', async () => {
    const root = fixture();
    const app = appFor(root);

    const created = await app.controller.handle('create file essay.txt with content: Alpha beta gamma.');
    assert.equal(created.status, Outcome.SUCCESS_VERIFIED, created.display);
    assert.equal(created.operation.capability, 'filesystem.write');
    assert.equal(fs.readFileSync(path.join(root, 'essay.txt'), 'utf8'), 'Alpha beta gamma.');
    assert.ok(!persisted(app).includes('Alpha beta gamma.'), 'the content is not copied into the audit log');

    const again = await app.controller.handle('create file essay.txt with content: a different text');
    assert.equal(again.status, Outcome.EXECUTION_FAILED);
    assert.match(again.display, /already exists/);
    assert.equal(fs.readFileSync(path.join(root, 'essay.txt'), 'utf8'), 'Alpha beta gamma.', 'the first file was not replaced');
  });

  test('the CLI exposes every workspace command with the same checks and exit codes', async () => {
    const root = fixture();
    const dir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dir, APEX_FILESYSTEM_ROOT: root });

    const list = await runCli(['workspace', 'list', 'docs'], env);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /guide\.txt/);

    const find = await runCli(['workspace', 'find', '--name', 'notes'], env);
    assert.equal(find.code, 0, find.stderr);
    assert.match(find.stdout, /notes\.md/);

    const read = await runCli(['workspace', 'read', 'notes.md'], env);
    assert.equal(read.code, 0, read.stderr);
    assert.match(read.stdout, /Alpha beta gamma/);

    const summarized = await runCli(['workspace', 'summarize', 'notes.md'], env);
    assert.equal(summarized.code, 0, summarized.stderr);
    assert.match(summarized.stdout, /frequent terms/);

    const compared = await runCli(['workspace', 'compare', 'docs/guide.txt', 'docs/other.txt'], env);
    assert.equal(compared.code, 0, compared.stderr);
    assert.match(compared.stdout, /identical/);

    const report = await runCli(['workspace', 'report'], env);
    assert.equal(report.code, 0, report.stderr);
    assert.match(report.stdout, /Workspace report/);

    const created = await runCli(['workspace', 'write', 'cli.txt', '--content', 'line one'], env);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'cli.txt'), 'utf8'), 'line one');

    const overwrite = await runCli(['workspace', 'write', 'cli.txt', '--content', 'line two'], env);
    assert.equal(overwrite.code, 1);
    assert.match(`${overwrite.stdout}${overwrite.stderr}`, /already exists/);

    const usage = await runCli(['workspace', 'write', 'cli.txt'], env);
    assert.equal(usage.code, 2);
    const missing = await runCli(['workspace', 'summarize', 'missing.txt'], env);
    assert.equal(missing.code, 1);
    assert.match(`${missing.stdout}${missing.stderr}`, /path does not exist|cannot be inspected|PATH_NOT_FOUND/);
  });
});