// Workspace lifecycle and multiple roots: mkdir, move, quarantine delete, restore, the batch
// preflight, and the fixed set of named roots. Every test uses its own temp data directory and
// its own temp roots; the real project tree is never read or written.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Outcome } from '../src/outcomes.js';
import { route } from '../src/controller/router.js';
import { createWorkspaces, parseWorkspaceSpec, MAX_WORKSPACES } from '../src/filesystem/roots.js';
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
  fs.writeFileSync(path.join(root, 'notes.txt'), 'alpha\n');
  fs.writeFileSync(path.join(root, 'docs', 'guide.txt'), 'guide\n');
  return root;
}

function appFor(root, options = {}) {
  return createApp({ dataDir: tempDir(), filesystemRoot: root, ...options });
}

function listNames(app) {
  return app.registry.list().map((d) => d.name);
}

describe('filesystem.mkdir', () => {
  test('creates one directory or a missing chain, and verifies what exists afterwards', async () => {
    const root = fixture();
    const app = appFor(root);

    const one = await app.controller.workspaceMkdir({ path: 'reports' });
    assert.equal(one.status, Outcome.SUCCESS_VERIFIED, one.display);
    assert.equal(fs.statSync(path.join(root, 'reports')).isDirectory(), true);
    assert.deepEqual(one.operation.steps[0].result.data.created, ['reports']);

    const chain = await app.controller.workspaceMkdir({ path: 'a/b/c', parents: true });
    assert.equal(chain.status, Outcome.SUCCESS_VERIFIED, chain.display);
    assert.equal(fs.statSync(path.join(root, 'a', 'b', 'c')).isDirectory(), true);
    assert.deepEqual(chain.operation.steps[0].result.data.created, ['a', 'a/b', 'a/b/c']);
  });

  test('refuses a missing parent, an existing entry, and a file at the target', async () => {
    const root = fixture();
    const app = appFor(root);

    const noParent = await app.controller.workspaceMkdir({ path: 'missing/child' });
    assert.equal(noParent.status, Outcome.EXECUTION_FAILED);
    assert.match(noParent.display, /parent directory does not exist/);
    assert.equal(fs.existsSync(path.join(root, 'missing')), false);

    const again = await app.controller.workspaceMkdir({ path: 'docs' });
    assert.equal(again.status, Outcome.EXECUTION_FAILED);
    assert.match(again.display, /already exists/);

    const overFile = await app.controller.workspaceMkdir({ path: 'notes.txt' });
    assert.equal(overFile.status, Outcome.EXECUTION_FAILED);
    assert.match(overFile.display, /file already exists|not a directory/);
    assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'alpha\n');
  });

  test('refuses traversal, absolute targets, the root itself, and the quarantine', async () => {
    const root = fixture();
    const outside = tempDir();
    const app = appFor(root);

    for (const target of ['../escaped', path.join(outside, 'escaped')]) {
      const res = await app.controller.workspaceMkdir({ path: target });
      assert.equal(res.status, Outcome.EXECUTION_FAILED);
      assert.match(res.display, /traversal|absolute|outside/i);
    }
    assert.equal(fs.existsSync(path.join(outside, 'escaped')), false);

    const atRoot = await app.controller.workspaceMkdir({ path: '.' });
    assert.equal(atRoot.status, Outcome.EXECUTION_FAILED);

    const reserved = await app.controller.workspaceMkdir({ path: '.apex-trash/fake' });
    assert.equal(reserved.status, Outcome.EXECUTION_FAILED);
    assert.match(reserved.display, /quarantine/);
  });

  test('a symlinked component is refused, and nothing is created through it', async (t) => {
    const root = fixture();
    const outside = tempDir();
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');
    } catch {
      linked = false;
    }
    if (!linked) {
      t.diagnostic('symlinks are not permitted in this environment; the link case was not run');
      return;
    }
    const app = appFor(root);
    const res = await app.controller.workspaceMkdir({ path: 'escape/child', parents: true });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /symbolic link|outside/i);
    assert.equal(fs.existsSync(path.join(outside, 'child')), false);
  });

  test('a model origin cannot run a lifecycle write and the action is not plannable', async () => {
    const root = fixture();
    const app = appFor(root);
    for (const [action, input] of [
      ['filesystem.mkdir', { path: 'model-dir' }],
      ['filesystem.move', { path: 'notes.txt', to: 'moved.txt' }],
      ['filesystem.delete', { path: 'notes.txt' }],
      ['filesystem.batch', { operations: [{ type: 'mkdir', path: 'model-dir' }] }],
    ]) {
      const step = await app.controller.runAction(action, input, 'model', `op-${action}`);
      assert.equal(step.outcome, Outcome.ACTION_DENIED, action);
      assert.equal(app.registry.get(action).plannable, false, action);
    }
    assert.equal(fs.existsSync(path.join(root, 'model-dir')), false);
    assert.equal(fs.existsSync(path.join(root, 'moved.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'notes.txt')), true);
  });
});

describe('filesystem.move', () => {
  test('renames a file and a directory without copying, and verifies the new location', async () => {
    const root = fixture();
    const app = appFor(root);

    const file = await app.controller.workspaceMove({ path: 'notes.txt', to: 'docs/notes.txt' });
    assert.equal(file.status, Outcome.SUCCESS_VERIFIED, file.display);
    assert.equal(fs.existsSync(path.join(root, 'notes.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'notes.txt'), 'utf8'), 'alpha\n');

    const dir = await app.controller.workspaceMove({ path: 'docs', to: 'archive' });
    assert.equal(dir.status, Outcome.SUCCESS_VERIFIED, dir.display);
    assert.equal(fs.readFileSync(path.join(root, 'archive', 'guide.txt'), 'utf8'), 'guide\n');
  });

  test('never overwrites, never moves onto itself, and never moves a directory into itself', async () => {
    const root = fixture();
    const app = appFor(root);
    fs.writeFileSync(path.join(root, 'target.txt'), 'keep\n');

    const overwrite = await app.controller.workspaceMove({ path: 'notes.txt', to: 'target.txt' });
    assert.equal(overwrite.status, Outcome.EXECUTION_FAILED);
    assert.match(overwrite.display, /destination already exists/);
    assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'keep\n');
    assert.equal(fs.existsSync(path.join(root, 'notes.txt')), true);

    const self = await app.controller.workspaceMove({ path: 'notes.txt', to: 'notes.txt' });
    assert.equal(self.status, Outcome.EXECUTION_FAILED);

    const intoSelf = await app.controller.workspaceMove({ path: 'docs', to: 'docs/nested' });
    assert.equal(intoSelf.status, Outcome.EXECUTION_FAILED);
    assert.match(intoSelf.display, /inside the source/);
    assert.equal(fs.existsSync(path.join(root, 'docs', 'nested')), false);
  });

  test('refuses a missing source, a missing destination parent, and the quarantine', async () => {
    const root = fixture();
    const app = appFor(root);

    const missing = await app.controller.workspaceMove({ path: 'nope.txt', to: 'x.txt' });
    assert.equal(missing.status, Outcome.EXECUTION_FAILED);
    assert.match(missing.display, /does not exist/);

    const noParent = await app.controller.workspaceMove({ path: 'notes.txt', to: 'nowhere/x.txt' });
    assert.equal(noParent.status, Outcome.EXECUTION_FAILED);
    assert.match(noParent.display, /parent directory does not exist/);
    assert.equal(fs.existsSync(path.join(root, 'notes.txt')), true);

    const reserved = await app.controller.workspaceMove({ path: 'notes.txt', to: '.apex-trash/stolen' });
    assert.equal(reserved.status, Outcome.EXECUTION_FAILED);
    assert.match(reserved.display, /quarantine/);
    assert.equal(fs.existsSync(path.join(root, 'notes.txt')), true);
  });
});

describe('quarantine delete and restore', () => {
  test('delete moves an entry into the quarantine with a manifest, and restore brings it back', async () => {
    const root = fixture();
    const app = appFor(root);

    const del = await app.controller.workspaceDelete({ path: 'notes.txt' });
    assert.equal(del.status, Outcome.SUCCESS_VERIFIED, del.display);
    assert.equal(fs.existsSync(path.join(root, 'notes.txt')), false);
    const data = del.operation.steps[0].result.data;
    assert.equal(data.originalPath, 'notes.txt');

    const manifestPath = path.join(root, '.apex-trash', data.trashId, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.originalPath, 'notes.txt');
    assert.equal(fs.readFileSync(path.join(root, '.apex-trash', data.trashId, 'entry'), 'utf8'), 'alpha\n');

    const trash = await app.controller.workspaceTrash({});
    assert.equal(trash.status, Outcome.SUCCESS_VERIFIED, trash.display);
    assert.deepEqual(trash.operation.steps[0].result.data.items.map((i) => i.id), [data.trashId]);

    const restored = await app.controller.workspaceRestore({ id: data.trashId });
    assert.equal(restored.status, Outcome.SUCCESS_VERIFIED, restored.display);
    assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'alpha\n');
    assert.equal(fs.existsSync(path.join(root, '.apex-trash', data.trashId)), false);

    const empty = await app.controller.workspaceTrash({});
    assert.equal(empty.operation.steps[0].result.data.items.length, 0);
  });

  test('a deleted directory is quarantined whole and restored with its contents', async () => {
    const root = fixture();
    const app = appFor(root);

    const del = await app.controller.workspaceDelete({ path: 'docs' });
    assert.equal(del.status, Outcome.SUCCESS_VERIFIED, del.display);
    const id = del.operation.steps[0].result.data.trashId;
    assert.equal(fs.existsSync(path.join(root, 'docs')), false);

    const restored = await app.controller.workspaceRestore({ id });
    assert.equal(restored.status, Outcome.SUCCESS_VERIFIED, restored.display);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'guide.txt'), 'utf8'), 'guide\n');
  });

  test('restore refuses an occupied original path and an unknown id', async () => {
    const root = fixture();
    const app = appFor(root);

    const del = await app.controller.workspaceDelete({ path: 'notes.txt' });
    const id = del.operation.steps[0].result.data.trashId;
    fs.writeFileSync(path.join(root, 'notes.txt'), 'new file\n');

    const occupied = await app.controller.workspaceRestore({ id });
    assert.equal(occupied.status, Outcome.EXECUTION_FAILED);
    assert.match(occupied.display, /occupied/);
    assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'new file\n');

    const unknown = await app.controller.workspaceRestore({ id: '00000000-0000-4000-8000-000000000000' });
    assert.equal(unknown.status, Outcome.EXECUTION_FAILED);
    assert.match(unknown.display, /no quarantine entry/i);
  });

  test('the quarantine directory cannot be deleted, moved, or listed as ordinary content', async () => {
    const root = fixture();
    const app = appFor(root);
    await app.controller.workspaceDelete({ path: 'notes.txt' });

    const del = await app.controller.workspaceDelete({ path: '.apex-trash' });
    assert.equal(del.status, Outcome.EXECUTION_FAILED);
    assert.match(del.display, /cannot be deleted/);

    const find = await app.controller.runAction('filesystem.find', { path: '.' }, 'user', 'op-f');
    assert.equal(find.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(find.result.data.matches.some((m) => m.path.includes('.apex-trash')), false);

    const report = await app.controller.workspaceReport({ path: '.' });
    assert.equal(report.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(String(report.display).includes('.apex-trash'), false);
  });

  test('the trash listing validates its limit', async () => {
    const root = fixture();
    const app = appFor(root);
    for (const limit of [0, 201, 1.5, '5']) {
      const res = await app.controller.workspaceTrash({ limit });
      assert.equal(res.status, Outcome.INPUT_REJECTED, `limit ${limit}`);
    }
  });
});

describe('filesystem.batch', () => {
  test('applies mkdir, move, and delete together and verifies every applied effect', async () => {
    const root = fixture();
    const app = appFor(root);

    // Every destination parent exists when the batch starts; the plan is computed against
    // that one state, so a directory this batch creates cannot serve as a destination.
    const res = await app.controller.workspaceBatch({
      operations: [
        { type: 'mkdir', path: 'archive' },
        { type: 'move', path: 'notes.txt', to: 'moved.txt' },
        { type: 'delete', path: 'docs/guide.txt' },
      ],
    });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    const data = res.operation.steps[0].result.data;
    assert.equal(data.complete, true);
    assert.equal(data.applied, 3);
    assert.equal(data.failed, 0);
    assert.equal(fs.statSync(path.join(root, 'archive')).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(root, 'moved.txt'), 'utf8'), 'alpha\n');
    assert.equal(fs.existsSync(path.join(root, 'docs', 'guide.txt')), false);
  });

  test('refuses the whole batch before any change when one operation cannot be planned', async () => {
    const root = fixture();
    const app = appFor(root);

    const res = await app.controller.workspaceBatch({
      operations: [
        { type: 'mkdir', path: 'first' },
        { type: 'move', path: 'missing.txt', to: 'first/missing.txt' },
      ],
    });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(res.operation.steps[0].execution.error.code, 'BATCH_PREFLIGHT_FAILED');
    assert.equal(fs.existsSync(path.join(root, 'first')), false, 'the valid operation was not applied either');
    assert.equal(fs.existsSync(path.join(root, 'notes.txt')), true);
  });

  test('a destination that depends on an earlier mkdir in the same batch is refused, not guessed', async () => {
    const root = fixture();
    const app = appFor(root);

    const res = await app.controller.workspaceBatch({
      operations: [
        { type: 'mkdir', path: 'fresh' },
        { type: 'move', path: 'notes.txt', to: 'fresh/notes.txt' },
      ],
    });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /parent directory does not exist/);
    assert.equal(fs.existsSync(path.join(root, 'fresh')), false);
    assert.equal(fs.existsSync(path.join(root, 'notes.txt')), true);
  });

  test('refuses conflicting sources and a destination inside a deleted directory', async () => {
    const root = fixture();
    const app = appFor(root);

    const sameSource = await app.controller.workspaceBatch({
      operations: [
        { type: 'move', path: 'notes.txt', to: 'moved.txt' },
        { type: 'delete', path: 'notes.txt' },
      ],
    });
    assert.equal(sameSource.status, Outcome.EXECUTION_FAILED);
    assert.match(sameSource.display, /same source/);
    assert.equal(fs.existsSync(path.join(root, 'notes.txt')), true);
    assert.equal(fs.existsSync(path.join(root, 'moved.txt')), false);

    const insideDeleted = await app.controller.workspaceBatch({
      operations: [
        { type: 'delete', path: 'docs' },
        { type: 'move', path: 'notes.txt', to: 'docs/notes.txt' },
      ],
    });
    assert.equal(insideDeleted.status, Outcome.EXECUTION_FAILED);
    assert.match(insideDeleted.display, /inside a directory/);
    assert.equal(fs.existsSync(path.join(root, 'docs', 'guide.txt')), true);
    assert.equal(fs.existsSync(path.join(root, 'notes.txt')), true);
  });

  test('bounds the operation list and refuses malformed operations', async () => {
    const root = fixture();
    const app = appFor(root);
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ type: 'mkdir', path: `d${i}` }));

    for (const operations of [[], tooMany, [{ type: 'chmod', path: 'x' }], [{ type: 'move', path: 'a.txt' }]]) {
      const res = await app.controller.workspaceBatch({ operations });
      assert.equal(res.status, Outcome.INPUT_REJECTED, JSON.stringify(operations).slice(0, 60));
    }
    assert.equal(fs.readdirSync(root).sort().join(','), 'docs,notes.txt');
  });
});

describe('multiple workspace roots', () => {
  function twoRoots() {
    const first = fixture();
    const second = tempDir();
    fs.writeFileSync(path.join(second, 'notes.txt'), 'beta\n');
    return { first, second };
  }

  test('roots are listed once, and the same relative path resolves inside the selected root', async () => {
    const { first, second } = twoRoots();
    const app = appFor(first, { filesystemWorkspaces: [{ name: 'second', path: second }] });

    assert.deepEqual(app.controller.workspaceRoots().map((r) => [r.name, r.default]), [['default', true], ['second', false]]);

    const inDefault = await app.controller.workspaceRead({ path: 'notes.txt' });
    assert.equal(inDefault.status, Outcome.SUCCESS_VERIFIED);
    assert.match(inDefault.display, /alpha/);

    const inSecond = await app.controller.workspaceRead({ path: 'notes.txt', workspace: 'second' });
    assert.equal(inSecond.status, Outcome.SUCCESS_VERIFIED);
    assert.match(inSecond.display, /beta/);

    const moved = await app.controller.workspaceMkdir({ path: 'only-here', workspace: 'second' });
    assert.equal(moved.status, Outcome.SUCCESS_VERIFIED, moved.display);
    assert.equal(fs.existsSync(path.join(second, 'only-here')), true);
    assert.equal(fs.existsSync(path.join(first, 'only-here')), false);
  });

  test('an unknown root is an input rejection, never a path and never a fallback', async () => {
    const { first, second } = twoRoots();
    const app = appFor(first, { filesystemWorkspaces: [{ name: 'second', path: second }] });

    for (const workspace of ['nope', '../default', 'two words']) {
      const res = await app.controller.workspaceRead({ path: 'notes.txt', workspace });
      assert.equal(res.status, Outcome.INPUT_REJECTED, workspace);
      assert.match(res.display, /workspace/);
    }

    // Naming the default root explicitly selects the same boundary; it does not widen it.
    const named = await app.controller.workspaceRead({ path: 'notes.txt', workspace: 'default' });
    assert.equal(named.status, Outcome.SUCCESS_VERIFIED, named.display);
    assert.match(named.display, /alpha/);
  });

  test('a missing named root is refused at startup, before any action exists', async () => {
    const { first } = twoRoots();
    const missing = path.join(tempDir(), 'not-created');
    assert.throws(
      () => appFor(first, { filesystemWorkspaces: [{ name: 'second', path: missing }] }),
      /does not exist|directory/i,
    );
  });

  test('without any root the lifecycle actions are absent and roots cannot be listed', async () => {
    const app = createApp({ dataDir: tempDir() });
    const names = listNames(app);
    for (const name of ['filesystem.mkdir', 'filesystem.move', 'filesystem.delete', 'filesystem.restore', 'filesystem.trash', 'filesystem.batch']) {
      assert.ok(!names.includes(name), `${name} must not exist without a root`);
    }
    assert.throws(() => app.controller.workspaceRoots(), /no filesystem root is configured/);
  });
});

describe('APEX_WORKSPACES configuration', () => {
  test('parses name=path entries and requires the default root', () => {
    const one = tempDir();
    const two = tempDir();
    const spec = `first=${one};second=${two}`;
    const parsed = parseWorkspaceSpec(spec);
    assert.deepEqual(parsed.map((e) => e.name), ['first', 'second']);

    const config = loadConfig({ APEX_FILESYSTEM_ROOT: one, APEX_WORKSPACES: spec });
    assert.deepEqual(config.filesystem.workspaces.map((e) => e.name), ['first', 'second']);

    assert.throws(
      () => loadConfig({ APEX_WORKSPACES: spec }),
      /requires APEX_FILESYSTEM_ROOT/,
    );
  });

  test('refuses malformed, duplicate, reserved, and oversized definitions', () => {
    const one = tempDir();
    const cases = [
      ['no-separator', /must be "name=absolute-path"/],
      [`default=${one}`, /may not define "default"/],
      [`a=${one};a=${one}`, /more than once/],
      ['1bad=' + one, /must start with a letter/],
      ['empty=', /has no path/],
      [Array.from({ length: MAX_WORKSPACES + 1 }, (_, i) => `w${i}=${one}`).join(';'), /at most/],
    ];
    for (const [spec, expected] of cases) {
      assert.throws(() => parseWorkspaceSpec(spec), expected, spec.slice(0, 40));
    }
  });

  test('createWorkspaces keeps one frozen set and maps an absent name to the default root', () => {
    const one = tempDir();
    const two = tempDir();
    const set = createWorkspaces({ root: one, extra: [{ name: 'other', path: two }] });
    assert.equal(set.pick(), fs.realpathSync(one));
    assert.equal(set.pick('other'), fs.realpathSync(two));
    assert.throws(() => set.pick('missing'), /unknown workspace/);
    assert.equal(Object.isFrozen(set), true);
    assert.equal(createWorkspaces({}), null);
  });
});

describe('lifecycle routing and CLI', () => {
  test('lifecycle requests route deterministically, and ordinary sentences stay on the model path', () => {
    assert.deepEqual(route('create directory reports'), {
      kind: 'action', capability: 'filesystem.mkdir', action: 'filesystem.mkdir', input: { path: 'reports' },
    });
    assert.deepEqual(route('mkdir docs/archive'), {
      kind: 'action', capability: 'filesystem.mkdir', action: 'filesystem.mkdir', input: { path: 'docs/archive' },
    });
    assert.deepEqual(route('rename notes.txt to docs/notes.txt'), {
      kind: 'action', capability: 'filesystem.move', action: 'filesystem.move', input: { path: 'notes.txt', to: 'docs/notes.txt' },
    });
    assert.deepEqual(route('delete docs/old.txt'), {
      kind: 'action', capability: 'filesystem.delete', action: 'filesystem.delete', input: { path: 'docs/old.txt' },
    });
    assert.deepEqual(route('workspace trash'), {
      kind: 'action', capability: 'filesystem.trash', action: 'filesystem.trash', input: {},
    });
    assert.deepEqual(route('restore 7d9cba14-17dd-4d83-b033-4e8a6d3a9368'), {
      kind: 'action', capability: 'filesystem.restore', action: 'filesystem.restore', input: { id: '7d9cba14-17dd-4d83-b033-4e8a6d3a9368' },
    });

    assert.equal(route('delete my opinion').kind, 'model', 'a bare word after delete is not a path');
    assert.equal(route('restore confidence in the plan').kind, 'model');
    assert.equal(route('create directory structure for the release').kind, 'model', 'a phrase is not a directory name');
    assert.equal(route('rename things in the report').kind, 'model');
  });

  test('the lifecycle routes act through the real request path', async () => {
    const root = fixture();
    const app = appFor(root);

    const made = await app.controller.handle('create directory reports');
    assert.equal(made.status, Outcome.SUCCESS_VERIFIED, made.display);
    assert.equal(fs.statSync(path.join(root, 'reports')).isDirectory(), true);

    const moved = await app.controller.handle('rename notes.txt to reports/notes.txt');
    assert.equal(moved.status, Outcome.SUCCESS_VERIFIED, moved.display);
    assert.equal(fs.existsSync(path.join(root, 'notes.txt')), false);

    const deleted = await app.controller.handle('delete reports/notes.txt');
    assert.equal(deleted.status, Outcome.SUCCESS_VERIFIED, deleted.display);
    const id = deleted.operation.steps[0].result.data.trashId;

    const listed = await app.controller.handle('workspace trash');
    assert.equal(listed.status, Outcome.SUCCESS_VERIFIED);
    assert.match(listed.display, new RegExp(id));

    const restored = await app.controller.handle(`restore ${id}`);
    assert.equal(restored.status, Outcome.SUCCESS_VERIFIED, restored.display);
    assert.equal(fs.readFileSync(path.join(root, 'reports', 'notes.txt'), 'utf8'), 'alpha\n');
  });

  test('the CLI exposes every lifecycle command with the same checks and exit codes', async () => {
    const root = fixture();
    const second = tempDir();
    fs.writeFileSync(path.join(second, 'second.txt'), 'second\n');
    const env = cleanEnv({
      APEX_DATA_DIR: tempDir(),
      APEX_FILESYSTEM_ROOT: root,
      APEX_WORKSPACES: `second=${second}`,
    });

    const roots = await runCli(['workspace', 'roots'], env);
    assert.equal(roots.code, 0, roots.stderr);
    assert.match(roots.stdout, /default \(default\)/);
    assert.match(roots.stdout, /second/);

    const made = await runCli(['workspace', 'mkdir', 'cli/nested', '--parents'], env);
    assert.equal(made.code, 0, `${made.stdout}${made.stderr}`);
    assert.equal(fs.statSync(path.join(root, 'cli', 'nested')).isDirectory(), true);

    const moved = await runCli(['workspace', 'move', 'notes.txt', 'cli/notes.txt'], env);
    assert.equal(moved.code, 0, `${moved.stdout}${moved.stderr}`);
    assert.equal(fs.existsSync(path.join(root, 'cli', 'notes.txt')), true);

    const deleted = await runCli(['workspace', 'delete', 'cli/notes.txt'], env);
    assert.equal(deleted.code, 0, `${deleted.stdout}${deleted.stderr}`);
    const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(deleted.stdout);
    assert.ok(match, 'the delete reports a quarantine id');

    const trash = await runCli(['workspace', 'trash'], env);
    assert.equal(trash.code, 0, `${trash.stdout}${trash.stderr}`);
    assert.match(trash.stdout, new RegExp(match[1]));

    const restored = await runCli(['workspace', 'restore', match[1]], env);
    assert.equal(restored.code, 0, `${restored.stdout}${restored.stderr}`);
    assert.equal(fs.existsSync(path.join(root, 'cli', 'notes.txt')), true);

    // A batch plans against the state it starts from, so the destination directory is created
    // first, in its own call, rather than by another operation in the same batch.
    const batched = await runCli(['workspace', 'mkdir', 'batched'], env);
    assert.equal(batched.code, 0, `${batched.stdout}${batched.stderr}`);
    const batch = await runCli(['workspace', 'batch', '--operations', JSON.stringify([
      { type: 'move', path: 'cli/notes.txt', to: 'batched/notes.txt' },
    ])], env);
    assert.equal(batch.code, 0, `${batch.stdout}${batch.stderr}`);
    assert.equal(fs.existsSync(path.join(root, 'batched', 'notes.txt')), true);

    const secondRead = await runCli(['workspace', 'read', 'second.txt', '--workspace', 'second'], env);
    assert.equal(secondRead.code, 0, `${secondRead.stdout}${secondRead.stderr}`);
    assert.match(secondRead.stdout, /second/);

    const unknown = await runCli(['workspace', 'read', 'second.txt', '--workspace', 'missing'], env);
    assert.equal(unknown.code, 1);

    const collision = await runCli(['workspace', 'move', 'batched/notes.txt', 'batched/notes.txt'], env);
    assert.equal(collision.code, 1);

    const badJson = await runCli(['workspace', 'batch', '--operations', 'not-json'], env);
    assert.equal(badJson.code, 2);

    const noOperations = await runCli(['workspace', 'batch'], env);
    assert.equal(noOperations.code, 2);

    const reserved = await runCli(['workspace', 'delete', '.apex-trash'], env);
    assert.equal(reserved.code, 1);
    assert.match(`${reserved.stdout}${reserved.stderr}`, /quarantine/);
  });
});
