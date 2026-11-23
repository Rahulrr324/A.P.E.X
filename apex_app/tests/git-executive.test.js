// T-43 Package 1 (2026-11-19): the git executive, its non-destructive checkpoints, and its refusals.
//
// Every test here runs against a real temporary git repository created by the test itself, because the
// only meaningful test of a git engine is git. Where a test needs to prove an argument never reached
// the shell, it plants a file that would be written if it had.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  GitExecutive, gitExecutiveActions, parseUnifiedDiff, validateGitRef, validateLabel,
  validateCheckpointId, resolveInside, GIT_EXECUTIVE_SCHEMA,
} from '../src/capabilities/git-executive.js';
import { ValidationError } from '../src/errors.js';
import { MemoryTraceService } from '../src/memory/trace.js';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', shell: false,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'APEX Test', GIT_AUTHOR_EMAIL: 'apex@example.invalid',
      GIT_COMMITTER_NAME: 'APEX Test', GIT_COMMITTER_EMAIL: 'apex@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();
}

function tempDir(prefix = 'apex-git-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A repository with one commit. Isolated from the developer's global config so a `core.autocrlf` or a
// signing hook on the machine cannot change what these tests observe.
function makeRepo() {
  const root = tempDir();
  git(root, ['init', '--quiet', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, 'greeting.js'), 'export const greeting = "hello";\n');
  fs.writeFileSync(path.join(root, 'other.txt'), 'one\ntwo\nthree\n');
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'initial commit']);
  return root;
}

function newExecutive(root, dataDir = tempDir('apex-git-data-')) {
  return { git: new GitExecutive({ workspaceRoot: root, dataDir }), dataDir };
}

describe('T-43 Package 1: git executive status, diff and refusals', () => {
  let root;
  let exec;
  let dataDir;

  before(() => {
    root = makeRepo();
    ({ git: exec, dataDir } = newExecutive(root));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('a directory that is not a repository is reported rather than thrown', () => {
    const bare = tempDir('apex-not-a-repo-');
    const { git: idle } = newExecutive(bare);
    const status = idle.statusDetailed();
    assert.equal(status.verified, true);
    assert.equal(status.available, true);
    assert.equal(status.isRepo, false);
    assert.equal(status.reason, 'not_a_git_repository');
    assert.deepEqual(status.staged, []);
    assert.deepEqual(status.unstaged, []);
    assert.deepEqual(status.untracked, []);
    assert.deepEqual(status.recentCommits, []);
    assert.equal(status.checkpointsCount, 0);
    fs.rmSync(bare, { recursive: true, force: true });
  });

  test('status reports the branch, HEAD, and the three path lists separately', () => {
    fs.writeFileSync(path.join(root, 'greeting.js'), 'export const greeting = "changed";\n');
    git(root, ['add', 'greeting.js']);
    fs.writeFileSync(path.join(root, 'other.txt'), 'one\ntwo\nTHREE\n');
    fs.writeFileSync(path.join(root, 'brand-new.txt'), 'untracked\n');

    const status = exec.statusDetailed();
    assert.equal(status.isRepo, true);
    assert.equal(status.branch, 'main');
    assert.match(status.headSha, /^[0-9a-f]{40}$/);
    assert.deepEqual(status.staged, [{ path: 'greeting.js', indexStatus: 'M' }]);
    assert.deepEqual(status.unstaged, [{ path: 'other.txt', worktreeStatus: 'M' }]);
    assert.deepEqual(status.untracked, ['brand-new.txt']);
    assert.equal(status.recentCommits.length, 1);
    assert.equal(status.recentCommits[0].subject, 'initial commit');
    assert.equal(status.recentCommits[0].author, 'APEX Test');
    assert.equal(typeof status.recentCommits[0].shortSha, 'string');
    // No upstream on a fresh init: the count is null, not a fabricated zero.
    assert.equal(status.ahead, null);
    assert.equal(status.behind, null);

    // Restore the tree for later tests by resetting to the commit and clearing extras.
    git(root, ['reset', '--quiet', '--hard', 'HEAD']);
    fs.rmSync(path.join(root, 'brand-new.txt'));
  });

  test('the diff is parsed into hunks with independent old and new line numbers', () => {
    fs.writeFileSync(path.join(root, 'other.txt'), 'one\ntwo\nTHREE\n');
    const diff = exec.diffInspect({ targetPath: 'other.txt' });
    assert.equal(diff.isRepo, true);
    assert.equal(diff.targetPath, 'other.txt');
    assert.equal(diff.additions, 1);
    assert.equal(diff.deletions, 1);
    assert.equal(diff.hunks.length, 1);
    const [hunk] = diff.hunks;
    assert.match(hunk.header, /^@@ -\d+,\d+ \+\d+,\d+ @@/);
    assert.equal(hunk.oldStart, 1);
    assert.equal(hunk.newStart, 1);
    const del = hunk.lines.find((line) => line.type === 'del');
    const add = hunk.lines.find((line) => line.type === 'add');
    assert.equal(del.text, 'three');
    // 'three' is the third line of the old file: the two context lines precede it on both sides.
    assert.equal(del.oldLine, 3);
    assert.equal(del.newLine, null);
    assert.equal(add.text, 'THREE');
    assert.equal(add.newLine, 3);
    assert.equal(add.oldLine, null);
    // Context lines carry both numbers.
    const ctx = hunk.lines.find((line) => line.type === 'ctx');
    assert.equal(ctx.oldLine, 1);
    assert.equal(ctx.newLine, 1);
    assert.match(diff.sha256, /^[0-9a-f]{64}$/);
    assert.equal(diff.truncated, false);
    git(root, ['checkout', '--', 'other.txt']);
  });

  test('a truncated diff says so and hashes only the text it returned', () => {
    fs.writeFileSync(path.join(root, 'other.txt'), 'one\ntwo\nTHREE\n');
    const diff = exec.diffInspect({ targetPath: 'other.txt', maxBytes: 40 });
    assert.equal(diff.truncated, true);
    assert.equal(diff.rawDiff.length, 40);
    git(root, ['checkout', '--', 'other.txt']);
  });

  test('a path outside the workspace is a 403 WORKSPACE_PATH_ESCAPE', () => {
    const outside = path.join(root, '..', 'outside.js');
    assert.throws(() => exec.diffInspect({ targetPath: '../outside.js' }), (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, 'WORKSPACE_PATH_ESCAPE');
      return true;
    });
    assert.throws(() => exec.diffInspect({ targetPath: outside }), (err) => err.code === 'WORKSPACE_PATH_ESCAPE');
    // A symlink inside the tree that points out is the same escape.
    fs.symlinkSync(os.tmpdir(), path.join(root, 'escape-hatch'));
    assert.throws(() => exec.diffInspect({ targetPath: 'escape-hatch' }), (err) => err.code === 'WORKSPACE_PATH_ESCAPE');
    fs.rmSync(path.join(root, 'escape-hatch'));
  });

  test('an option-shaped argument is a 400 INVALID_GIT_ARGUMENT and never reaches git', () => {
    // The planted file is the proof: if `--output=` had reached git as an option, git would have
    // written it, and the assertion below would find it.
    const canary = path.join(os.tmpdir(), `apex-pwn-${process.pid}`);
    fs.rmSync(canary, { force: true });
    assert.equal((() => { try { exec.diffInspect({ baseRef: `--output=${canary}` }); return null; } catch (e) { return e.code; } })(), 'INVALID_GIT_ARGUMENT');
    assert.equal(fs.existsSync(canary), false, 'the canary file must not exist: the flag never reached git');
    assert.equal((() => { try { exec.diffInspect({ targetPath: '--output=/tmp/pwn' }); return null; } catch (e) { return e.code; } })(), 'INVALID_GIT_ARGUMENT');
    assert.equal((() => { try { validateGitRef('-D'); return null; } catch (e) { return e.code; } })(), 'INVALID_GIT_ARGUMENT');
    // A semicolon is not a metacharacter here: it is simply not in a ref's charset, so it is refused as
    // a ref-syntax problem and never becomes a shell fragment.
    assert.equal((() => { try { validateGitRef('main; rm -rf /'); return null; } catch (e) { return e.code; } })(), 'INVALID_GIT_ARGUMENT');
    // A legitimate revision syntax still passes.
    assert.equal(validateGitRef('HEAD~1'), 'HEAD~1');
    assert.equal(validateGitRef('origin/main'), 'origin/main');
  });

  test('a label that is not a plain label is refused', () => {
    assert.equal(validateLabel('  before the refactor  '), 'before the refactor');
    assert.throws(() => validateLabel(''), (err) => err.code === 'INVALID_INPUT');
    assert.throws(() => validateLabel('x'.repeat(121)), (err) => err.code === 'INVALID_INPUT');
    // A semicolon is allowed in a label - it is just text and never reaches a shell. A backtick and an
    // angle bracket are not, because a label travels to a panel and to a ref name.
    assert.equal(validateLabel('drop; table'), 'drop; table');
    assert.throws(() => validateLabel('label<with>angles'), (err) => err.code === 'INVALID_INPUT');
    assert.throws(() => validateLabel('label\u0000nul'), (err) => err.code === 'INVALID_INPUT');
  });

  test('the unified diff parser is exported and handles empty input', () => {
    assert.deepEqual(parseUnifiedDiff(''), { hunks: [], additions: 0, deletions: 0 });
    const parsed = parseUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,0 +1,2 @@\n+a\n+b\n');
    assert.equal(parsed.additions, 2);
    assert.equal(parsed.deletions, 0);
    assert.equal(parsed.hunks[0].lines[0].newLine, 1);
    assert.equal(parsed.hunks[0].lines[1].newLine, 2);
  });

  test('resolveInside accepts a new file inside the tree and refuses an absolute path outside', () => {
    const inside = resolveInside(root, 'nested/new-file.txt');
    assert.equal(inside.relativePath, 'nested/new-file.txt');
    assert.equal(inside.absolute, path.join(fs.realpathSync(root), 'nested/new-file.txt'));
    assert.throws(() => resolveInside(root, '/etc/passwd'), (err) => err.code === 'WORKSPACE_PATH_ESCAPE');
    assert.equal(GIT_EXECUTIVE_SCHEMA, 'apex.git-executive/1');
  });
});

describe('T-43 Package 1: checkpoints are non-destructive and verify their own result', () => {
  let root;
  let exec;
  let dataDir;

  before(() => {
    root = makeRepo();
    ({ git: exec, dataDir } = newExecutive(root));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('a checkpoint of a dirty tree leaves the tree and index byte-identical', () => {
    fs.writeFileSync(path.join(root, 'greeting.js'), 'export const greeting = "dirty";\n');
    const beforeBytes = fs.readFileSync(path.join(root, 'greeting.js'));
    const beforeStatus = git(root, ['status', '--porcelain=v1']);
    const beforeIndexTree = git(root, ['write-tree']);
    const beforeHead = git(root, ['rev-parse', 'HEAD']);

    const record = exec.checkpointCreate({ label: 'dirty snapshot', reason: 'prove the create is read-only' });

    assert.equal(record.wasDirty, true);
    assert.equal(record.verified, true);
    assert.match(record.checkpointId, /^chk_[a-z0-9]{8,40}$/);
    assert.equal(record.refName, `refs/apex-checkpoints/${record.checkpointId}`);
    assert.match(record.commitSha, /^[0-9a-f]{40}$/);
    assert.match(record.treeSha, /^[0-9a-f]{40}$/);
    assert.equal(record.headShaAtCreation, beforeHead);
    assert.equal(record.trackedModifiedCount, 1);
    assert.deepEqual(record.manifest.map((m) => m.path), ['greeting.js']);
    assert.match(record.manifest[0].sha256, /^[0-9a-f]{64}$/);

    // The three things a create must not change.
    assert.deepEqual(fs.readFileSync(path.join(root, 'greeting.js')), beforeBytes, 'the file bytes are unchanged');
    assert.equal(git(root, ['status', '--porcelain=v1']), beforeStatus, 'the status is unchanged: nothing was stashed away');
    assert.equal(git(root, ['write-tree']), beforeIndexTree, 'the index tree is unchanged');
    assert.equal(git(root, ['rev-parse', 'HEAD']), beforeHead, 'HEAD did not move');

    // The ref resolves to the snapshot commit, verified by an independent read.
    assert.equal(git(root, ['rev-parse', record.refName]), record.commitSha);

    // And it is persisted where the trace and the panel read it.
    const ledger = JSON.parse(fs.readFileSync(path.join(dataDir, 'git-checkpoints.json'), 'utf8'));
    assert.equal(ledger.schema, 'apex.git-checkpoint/1');
    assert.equal(ledger.checkpoints.length, 1);
    assert.equal(ledger.checkpoints[0].checkpointId, record.checkpointId);
  });

  test('a checkpoint of a clean tree snapshots HEAD rather than inventing a stash commit', () => {
    git(root, ['reset', '--quiet', '--hard', 'HEAD']);
    const head = git(root, ['rev-parse', 'HEAD']);
    const record = exec.checkpointCreate({ label: 'clean snapshot' });
    assert.equal(record.wasDirty, false);
    assert.equal(record.commitSha, head);
    assert.equal(record.trackedModifiedCount, 0);
    assert.equal(git(root, ['rev-parse', record.refName]), head);
  });

  test('the ledger records every checkpoint and reports ref integrity live', () => {
    const list = exec.listCheckpoints();
    assert.equal(list.length, 2);
    for (const entry of list) assert.equal(entry.refIntact, true);
    const status = exec.statusDetailed();
    assert.equal(status.checkpointsCount, 2);
  });

  test('a checkpoint id that is not recorded is a CHECKPOINT_NOT_FOUND', () => {
    assert.throws(() => exec.checkpointRestore({ checkpointId: 'chk_00000000deadbeef' }), (err) => err.code === 'CHECKPOINT_NOT_FOUND');
    assert.throws(() => exec.checkpointRestore({ checkpointId: 'not-an-id' }), (err) => err.code === 'INVALID_INPUT');
    assert.equal(validateCheckpointId('chk_ab12cd34'), 'chk_ab12cd34');
  });

  test('a ref that no longer points where it was recorded is a CHECKPOINT_REF_DRIFT', () => {
    const record = exec.checkpointCreate({ label: 'drift target' });
    // A second real commit gives the ref somewhere else to point, which is what drift means.
    fs.writeFileSync(path.join(root, 'drift.txt'), 'a commit the checkpoint never saw\n');
    git(root, ['add', 'drift.txt']);
    git(root, ['commit', '--quiet', '-m', 'a commit made after the checkpoint']);
    git(root, ['update-ref', record.refName, git(root, ['rev-parse', 'HEAD'])]);
    assert.throws(() => exec.checkpointRestore({ checkpointId: record.checkpointId }), (err) => {
      assert.equal(err.code, 'CHECKPOINT_REF_DRIFT');
      assert.ok(err.detail && err.detail.recorded === record.commitSha);
      return true;
    });
    const listed = exec.listCheckpoints().find((entry) => entry.checkpointId === record.checkpointId);
    assert.equal(listed.refIntact, false);
    assert.notEqual(listed.liveCommitSha, record.commitSha);
  });

  test('a restore over an unrelated dirty tree is refused with GIT_CHECKPOINT_DIRTY_TREE', () => {
    const record = exec.checkpointCreate({ label: 'restore base' });
    fs.writeFileSync(path.join(root, 'other.txt'), 'owner work in progress\n');
    const before = fs.readFileSync(path.join(root, 'other.txt'), 'utf8');
    assert.throws(() => exec.checkpointRestore({ checkpointId: record.checkpointId }), (err) => {
      assert.equal(err.code, 'GIT_CHECKPOINT_DIRTY_TREE');
      assert.deepEqual(err.detail.dirtyPaths, ['other.txt']);
      return true;
    });
    assert.equal(fs.readFileSync(path.join(root, 'other.txt'), 'utf8'), before, 'a refused restore changes nothing');
    git(root, ['checkout', '--', 'other.txt']);
  });

  test('a clean round-trip restores the tracked files and verifies the result', () => {
    fs.writeFileSync(path.join(root, 'greeting.js'), 'export const greeting = "will be restored";\n');
    const record = exec.checkpointCreate({ label: 'round trip' });
    // Move the tree somewhere else entirely: commit the change, then the checkpoint's content is no
    // longer what is on disk.
    git(root, ['commit', '--quiet', '-am', 'the change the checkpoint predates']);
    fs.writeFileSync(path.join(root, 'other.txt'), 'one\ntwo\nthree\n');

    // The tree is clean relative to the new HEAD, so the preflight passes.
    const restored = exec.checkpointRestore({ checkpointId: record.checkpointId, reason: 'prove the round trip' });
    assert.equal(restored.verified, true);
    assert.equal(restored.restoreCount, 1);
    assert.equal(typeof restored.lastRestoredAt, 'string');
    assert.match(restored.treeSha, /^[0-9a-f]{40}$/);

    // The disk now holds the checkpointed bytes, and the tree is clean.
    assert.equal(fs.readFileSync(path.join(root, 'greeting.js'), 'utf8'), 'export const greeting = "will be restored";\n');
    assert.equal(git(root, ['status', '--porcelain=v1']), '');

    assert.equal(exec.restoredState(record.checkpointId).verified, true, 'the tree is the snapshot tree');

    // A second restore is a no-op rather than a refusal, and the count increments.
    const again = exec.checkpointRestore({ checkpointId: record.checkpointId });
    assert.equal(again.restoreCount, 2);
    assert.equal(exec.restoredState(record.checkpointId).verified, true);
  });

  test('restoring an older checkpoint onto a newer HEAD verifies against the snapshot, not against HEAD', () => {
    // The state a restore produces is, by construction, a difference from HEAD: the index holds the
    // old content and HEAD holds the new. A post-condition written as "the status is clean" would
    // declare every useful restore a failure, so this test pins the check to the snapshot tree.
    fs.writeFileSync(path.join(root, 'greeting.js'), 'export const greeting = "the old content";\n');
    const record = exec.checkpointCreate({ label: 'an older point' });
    git(root, ['commit', '--quiet', '-am', 'a newer commit the checkpoint predates']);
    fs.writeFileSync(path.join(root, 'greeting.js'), 'export const greeting = "the newest content";\n');
    git(root, ['commit', '--quiet', '-am', 'a newer commit still']);

    const restored = exec.checkpointRestore({ checkpointId: record.checkpointId });
    assert.equal(restored.verified, true);
    assert.equal(fs.readFileSync(path.join(root, 'greeting.js'), 'utf8'), 'export const greeting = "the old content";\n');
    // The restore IS visible against HEAD, and that is correct rather than a defect.
    assert.match(git(root, ['status', '--porcelain=v1']), /greeting\.js/, 'the restored file differs from the newer HEAD');
    // And the checkpoint's own tree matches exactly.
    const state = exec.restoredState(record.checkpointId);
    assert.equal(state.verified, true);
    assert.equal(state.worktreeMatches, true);
    assert.equal(state.indexMatches, true);
    git(root, ['checkout', '--', '.']);
  });

  test('the write capabilities refuse to run without the step-up proof when one is configured', async () => {
    const defs = gitExecutiveActions(exec);
    const create = defs.find((def) => def.name === 'git.checkpoint_create');
    const restore = defs.find((def) => def.name === 'git.checkpoint_restore');
    const secret = 'a-step-up-secret';
    const controlPlane = {
      killSwitchStatus: () => ({ active: false }),
      verifyStepUp: (proof, { capability }) => {
        const ok = proof === secret;
        return { ok, configured: true, required: true, reason: ok ? 'STEP_UP_VERIFIED' : 'STEP_UP_REQUIRED' };
      },
    };
    const ctx = { registry: { controlPlane } };

    const input = create.validate({ label: 'needs step-up' });
    await assert.rejects(() => create.execute(ctx, input), (err) => err.code === 'STEP_UP_REQUIRED');
    // Nothing was created by the refused call.
    const countBefore = exec.listCheckpoints().length;
    const good = create.validate({ label: 'with step-up', stepUp: secret });
    const result = await create.execute(ctx, good);
    assert.equal(exec.listCheckpoints().length, countBefore + 1);
    assert.equal(result.data.label, 'with step-up');

    const restoreInput = restore.validate({ checkpointId: result.data.checkpointId });
    await assert.rejects(() => restore.execute(ctx, restoreInput), (err) => err.code === 'STEP_UP_REQUIRED');
  });

  test('every capability declares its governance, and the two writes are user-only', () => {
    const defs = gitExecutiveActions(exec);
    assert.equal(defs.length, 4);
    const byName = new Map(defs.map((def) => [def.name, def]));
    assert.deepEqual([...byName.keys()].sort(), ['git.checkpoint_create', 'git.checkpoint_restore', 'git.diff_inspect', 'git.status_detailed']);
    for (const def of defs) {
      assert.equal(typeof def.validate, 'function', `${def.name} validates`);
      assert.equal(typeof def.verify, 'function', `${def.name} verifies`);
      assert.ok(def.description.length > 0);
      assert.equal(def.reversibility, 'reversible');
      assert.ok(['local_state', 'workspace_fs'].includes(def.blastRadius));
    }
    const create = byName.get('git.checkpoint_create');
    const restore = byName.get('git.checkpoint_restore');
    for (const write of [create, restore]) {
      assert.equal(write.permission, 'write');
      assert.equal(write.autonomyLevel, 'L2');
      assert.equal(write.blastRadius, 'workspace_fs');
      assert.deepEqual(write.origins, ['user'], 'a write into the tree is owner-only');
      assert.equal(write.plannable, false);
    }
    for (const read of [byName.get('git.status_detailed'), byName.get('git.diff_inspect')]) {
      assert.equal(read.permission, 'read');
      assert.equal(read.autonomyLevel, 'L0');
      assert.equal(read.blastRadius, 'local_state');
      assert.deepEqual(read.origins, ['user', 'model']);
    }
  });

  test('the status capability validates its input and verifies its own reading', async () => {
    const defs = gitExecutiveActions(exec);
    const status = defs.find((def) => def.name === 'git.status_detailed');
    assert.deepEqual(status.validate({}), {});
    assert.throws(() => status.validate({ nope: 1 }), (err) => err.code === 'INVALID_INPUT');
    const result = await status.execute({}, {});
    assert.equal(result.data.isRepo, true);
    assert.match(result.display, /Branch main/);
    const verified = await status.verify({}, {}, result);
    assert.equal(verified.ok, true);
    assert.equal((await status.verify({}, {}, { data: null })).ok, false);
  });

  test('the diff capability catches counts that disagree with the hunks it returned', async () => {
    const defs = gitExecutiveActions(exec);
    const diff = defs.find((def) => def.name === 'git.diff_inspect');
    fs.writeFileSync(path.join(root, 'other.txt'), 'one\ntwo\nTHREE\n');
    const input = diff.validate({ targetPath: 'other.txt' });
    const result = await diff.execute({}, input);
    assert.equal((await diff.verify({}, input, result)).ok, true);
    // A tampered count must fail the verifier: the numbers and the lines are two claims about one diff.
    const tampered = { data: { ...result.data, additions: result.data.additions + 5 } };
    assert.equal((await diff.verify({}, input, tampered)).ok, false);
    git(root, ['checkout', '--', 'other.txt']);
  });
});

describe('T-43 Package 1: the git engine never invokes a shell', () => {
  test('the module contains no exec() and no shell:true', () => {
    const source = fs.readFileSync(new URL('../src/capabilities/git-executive.js', import.meta.url), 'utf8');
    assert.equal(/child_process['"]?\)?\.exec\(|execSync\(/.test(source), false, 'no shell-form exec may appear');
    assert.equal(/shell:\s*true/.test(source), false, 'shell must never be true');
    assert.match(source, /execFileSync\('git', args/, 'the one call is execFileSync with an argument array');
    assert.match(source, /shell:\s*false/, 'the call states shell: false');
  });

  test('a git call is bounded by the three-second timeout', () => {
    const source = fs.readFileSync(new URL('../src/capabilities/git-executive.js', import.meta.url), 'utf8');
    assert.match(source, /export const GIT_TIMEOUT_MS = 3000;/);
    assert.match(source, /timeout: timeoutMs/);
  });
});

describe('T-43 Package 1: a checkpoint id resolves across the ledgers', () => {
  test('GET /api/memory/trace/chk_* reads the checkpoint out of git-checkpoints.json', async () => {
    const root = makeRepo();
    const dataDir = tempDir('apex-git-trace-');
    try {
      const git = new GitExecutive({ workspaceRoot: root, dataDir });
      fs.writeFileSync(path.join(root, 'greeting.js'), 'export const greeting = "traced";\n');
      const record = git.checkpointCreate({ label: 'traced checkpoint', reason: 'prove the trace resolves' });

      // The operation the create would have written. The trace links an operation to a chain by the
      // checkpoint id appearing in its step input, which is exactly what the real audit record carries.
      fs.writeFileSync(path.join(dataDir, 'operations.jsonl'), `${JSON.stringify({
        id: 'ui-git-checkpoint-1',
        requestedAt: record.createdAt,
        capability: 'git.checkpoint_create',
        origin: 'user',
        status: 'success_verified',
        request: 'create a checkpoint',
        steps: [{ action: 'git.checkpoint_create', input: { label: 'traced checkpoint' }, checkpointId: record.checkpointId }],
      })}\n`, { flag: 'a' });

      const trace = new MemoryTraceService({ dataDir }).trace(record.checkpointId);
      assert.equal(trace.ok, true, 'the checkpoint id resolves rather than 404ing');
      const kinds = trace.entries.map((step) => step.kind);
      assert.ok(kinds.includes('git_checkpoint'), 'the chain carries the checkpoint step');
      assert.equal(trace.complete, true, 'a checkpoint chain is complete when the record is found');
      assert.equal(trace.counts.checkpoints, 1);
      const checkpointStep = trace.entries.find((step) => step.kind === 'git_checkpoint' && step.label === 'git checkpoint recorded');
      assert.equal(checkpointStep.detail.checkpointId, record.checkpointId);
      assert.equal(checkpointStep.detail.commitSha, record.commitSha);
      assert.equal(checkpointStep.detail.wasDirty, true);
      // The operation that created it is in the same chain.
      assert.ok(kinds.includes('ecp_audit'), 'the operation that created the checkpoint is linked');

      // Search finds it by kind too.
      const found = new MemoryTraceService({ dataDir }).search({ kind: 'git_checkpoint' });
      assert.equal(found.ok, true);
      assert.equal(found.total, 1);

      // A restore adds a derived second step, marked as derived so the timestamp is not misread.
      git.checkpointRestore({ checkpointId: record.checkpointId });
      const after = new MemoryTraceService({ dataDir }).trace(record.checkpointId);
      const restoreStep = after.entries.find((step) => step.label === 'git checkpoint restored');
      assert.ok(restoreStep, 'the restore appears in the chain');
      assert.equal(restoreStep.detail.derivedFromRecord, true);
      assert.equal(restoreStep.detail.restoreCount, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
