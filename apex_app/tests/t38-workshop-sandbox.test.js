// T-38 Step 2: the workspace inspector and the sandbox verifier.
//
// Two claims are pinned here, and they are separable on purpose:
//
//   1. Containment. A path that escapes the root is refused with a code, by realpath, before anything
//      is read. The tests use real symbolic links and real traversal strings rather than asserting on
//      the shape of a check, because the boundary is the thing being claimed.
//
//   2. Measurement. `verified` is what a real parser said about the real staged bytes. The suite
//      checks that a broken file is reported broken *and* that the parser's own message survived, and
//      it pins the trap that made this necessary: a `.js` file parsed as a CommonJS script passes
//      `node --check` with syntax that a module would reject.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { diffSummary, readExcerpt, WorkshopSandbox } from '../src/workshop/sandbox.js';

function tempDir(prefix = 'apex-t38-ws-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withWorkspace(fn) {
  const root = tempDir();
  const data = tempDir('apex-t38-data-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'README.md'), '# probe workspace\n\nA file for the T-38 tests.\n');
  fs.writeFileSync(path.join(root, 'src', 'good.js'), 'export const ok = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'data.json'), '{"ok":true}\n');
  try {
    return fn({ root, data, sandbox: new WorkshopSandbox({ dataDir: data, workspaceRoot: root }) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------ containment ---

test('T-38 sandbox: a path outside the root is refused by code, not silently', () => {
  withWorkspace(({ sandbox }) => {
    const refusals = [
      ['../escape.txt', 'ACCESS_DENIED'],
      ['src/../../escape.txt', 'ACCESS_DENIED'],
      ['/etc/passwd', 'ACCESS_DENIED'],
      ['/etc/hosts', 'ACCESS_DENIED'],
      ['C:\\Windows\\win.ini', 'ACCESS_DENIED'],
      ['\\\\server\\share\\file.txt', 'ACCESS_DENIED'],
      ['', 'INVALID_INPUT'],
      ['src/\u0000null.js', 'INVALID_INPUT'],
    ];
    for (const [attempt, expected] of refusals) {
      const resolved = sandbox.inspector.resolve(attempt);
      assert.equal(resolved.ok, false, `${JSON.stringify(attempt)} must be refused`);
      assert.equal(resolved.code, expected, `${JSON.stringify(attempt)}: ${resolved.code} ${resolved.detail}`);
    }
  });
});

test('T-38 sandbox: a symbolic link that escapes the root is refused rather than followed', () => {
  withWorkspace(({ root, sandbox }) => {
    const outside = tempDir('apex-t38-outside-');
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours\n');
      // A link inside the root pointing out of it. The string form is "inside"; only realpath tells
      // the truth, which is why the gate resolves links before it decides.
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
      const resolved = sandbox.inspector.resolve('link.txt');
      assert.equal(resolved.ok, false, 'a link pointing out of the root must be refused');
      assert.equal(resolved.code, 'ACCESS_DENIED');
      assert.match(resolved.detail, /outside the authorized root/);

      // And a link pointing inside the root is still readable - the rule is containment, not a ban on
      // links, so the gate must not be so strict that it refuses a legitimate one.
      fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'inside-link.md'));
      const ok = sandbox.inspector.resolve('inside-link.md');
      assert.equal(ok.ok, true, ok.detail);
      assert.equal(ok.isLink, true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('T-38 sandbox: the listing reports real bytes, lines and a sha256 digest', () => {
  withWorkspace(({ root, sandbox }) => {
    const listing = sandbox.inspector.list();
    const readme = listing.entries.find((e) => e.path === 'README.md');
    assert.ok(readme, 'README.md must be listed');
    assert.equal(readme.kind, 'file');
    const content = fs.readFileSync(path.join(root, 'README.md'));
    assert.equal(readme.bytes, content.length);
    assert.equal(readme.lines, 3);
    assert.match(readme.digest, /^[0-9a-f]{64}$/);
    // The digest is the digest of the bytes on disk, checked independently.
    assert.equal(readme.digest, createHash('sha256').update(content).digest('hex'));
  });
});

test('T-38 sandbox: the listing never descends into git, node_modules or build trees', () => {
  withWorkspace(({ root, sandbox }) => {
    for (const skipped of ['.git', 'node_modules', 'dist', 'build']) {
      fs.mkdirSync(path.join(root, skipped));
      fs.writeFileSync(path.join(root, skipped, 'anything.js'), 'export const hidden = 1;\n');
    }
    const listing = sandbox.inspector.list();
    const paths = listing.entries.map((e) => e.path);
    for (const skipped of ['.git', 'node_modules', 'dist', 'build']) {
      assert.ok(!paths.some((p) => p.startsWith(`${skipped}/`)), `${skipped} must not be walked`);
    }
  });
});

test('T-38 sandbox: a binary file is reported as binary rather than read', () => {
  withWorkspace(({ root, sandbox }) => {
    fs.writeFileSync(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const listing = sandbox.inspector.list();
    const binary = listing.entries.find((e) => e.path === 'image.png');
    assert.equal(binary.kind, 'binary');
    assert.equal(binary.digest, null, 'a binary is not digested, because it is not read');
    assert.equal(binary.skipped, true);
  });
});

test('T-38 sandbox: an excerpt is line-numbered with the file\'s real line numbers', () => {
  withWorkspace(({ root }) => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(root, 'long.txt'), `${lines}\n`);
    const middle = readExcerpt(path.join(root, 'long.txt'), { startLine: 20, lines: 3 });
    assert.equal(middle.startLine, 20);
    assert.equal(middle.lines, 3);
    // The numbers in the excerpt are the numbers in the file, so a citation means something.
    assert.match(middle.excerpt, /^\s+20 {2}line 20$/m);
    assert.match(middle.excerpt, /^\s+22 {2}line 22$/m);
    assert.doesNotMatch(middle.excerpt, /line 19$/m);
  });
});

// ------------------------------------------------------------------------------- the parse ---

test('T-38 sandbox: node --check accepts a good .js candidate, with the diff and both digests', () => {
  withWorkspace(({ sandbox }) => {
    const staged = sandbox.stage({
      relativePath: 'src/good.js',
      proposedContent: 'export const ok = 2;\nexport const extra = 3;\n',
      rationale: 'a second export',
    });
    const { verification } = sandbox.verify(staged.candidateId);
    assert.equal(verification.verified, true, JSON.stringify(verification.checks.filter((c) => !c.passed)));
    assert.equal(verification.passed, verification.total);
    assert.equal(verification.parser.kind, 'node_check');
    assert.equal(verification.parser.ran, true);
    assert.equal(verification.parser.exitCode, 0);
    assert.match(verification.stagedDigest, /^[0-9a-f]{64}$/);
    assert.match(verification.baseDigest, /^[0-9a-f]{64}$/);
    assert.notEqual(verification.stagedDigest, verification.baseDigest);
    // added 2, removed 1: one line changed and one line is new.
    assert.equal(verification.diff.addedLines, 2);
    assert.equal(verification.diff.removedLines, 1);
    assert.ok(verification.diff.preview.some((line) => line.startsWith('+')));
    assert.ok(verification.diff.preview.some((line) => line.startsWith('-')));
    // A verification authorizes nothing, and says so in its own record.
    assert.equal(verification.authorizesExecution, false);
    assert.equal(verification.executedCode, false);
    assert.equal(verification.mutatesLiveWorkspace, false);
  });
});

test('T-38 sandbox: node --check catches broken syntax and keeps its exact message', () => {
  withWorkspace(({ sandbox }) => {
    const staged = sandbox.stage({
      relativePath: 'src/good.js',
      proposedContent: 'export function broken( { return 1; }\n',
      rationale: 'deliberately broken',
    });
    const { verification } = sandbox.verify(staged.candidateId);
    assert.equal(verification.verified, false, 'a syntax error must never verify');
    assert.deepEqual(verification.failed, ['real_parse']);
    assert.equal(verification.parser.ran, true);
    assert.equal(verification.parser.exitCode, 1);
    assert.equal(verification.parser.stderr.trim().length > 0, true);
    assert.match(verification.parser.stderr, /SyntaxError/);
    // The failure is stored, not lost with the exception: the UI shows this string.
    const reread = sandbox.latestVerification(staged.candidateId);
    assert.equal(reread.verified, false);
    assert.match(reread.parser.stderr, /SyntaxError/);
  });
});

test('T-38 sandbox: a .js candidate is parsed as a module, not as a CommonJS script', () => {
  withWorkspace(({ sandbox, data }) => {
    // The trap this pins, measured directly: node decides a file's module kind from the nearest
    // package.json, and a `.js` file with no manifest is treated as CommonJS script - where this
    // syntax exits 0 and is never loaded. The sandbox writes the manifest for exactly this reason.
    const brokenSource = 'export function broken( { return 1; }\n';
    const scriptDir = tempDir('apex-t38-script-');
    try {
      const scriptFile = path.join(scriptDir, 'candidate.js');
      fs.writeFileSync(scriptFile, brokenSource);
      let scriptExit = 0;
      try {
        execFileSync(process.execPath, ['--check', scriptFile], { stdio: 'ignore' });
      } catch (err) {
        scriptExit = err.status ?? 1;
      }
      assert.equal(scriptExit, 0, 'the premise of this test: as a script, node --check accepts it');

      const staged = sandbox.stage({ relativePath: 'src/good.js', proposedContent: brokenSource });
      const { verification } = sandbox.verify(staged.candidateId);
      assert.equal(verification.verified, false, 'as a module, the same bytes must fail');
      assert.equal(verification.parser.exitCode, 1);
      // And the manifest that makes the difference is inside the sandbox data directory.
      assert.ok(fs.existsSync(path.join(data, 'workshop-sandbox', 'package.json')));
    } finally {
      fs.rmSync(scriptDir, { recursive: true, force: true });
    }
  });
});

test('T-38 sandbox: a .json candidate is checked with strict JSON.parse', () => {
  withWorkspace(({ sandbox }) => {
    const broken = sandbox.stage({ relativePath: 'src/data.json', proposedContent: '{"ok": false,}' });
    const brokenResult = sandbox.verify(broken.candidateId).verification;
    assert.equal(brokenResult.verified, false);
    assert.equal(brokenResult.parser.kind, 'json_parse');
    assert.match(brokenResult.parser.stderr ?? brokenResult.checks.find((c) => c.id === 'real_parse').detail, /JSON/);

    const good = sandbox.stage({ relativePath: 'src/data.json', proposedContent: '{"ok": false}' });
    const goodResult = sandbox.verify(good.candidateId).verification;
    assert.equal(goodResult.verified, true, JSON.stringify(goodResult.failed));
  });
});

test('T-38 sandbox: a file type with no parser says so instead of claiming a parse', () => {
  withWorkspace(({ sandbox }) => {
    const staged = sandbox.stage({ relativePath: 'notes.md', proposedContent: '# a heading\n' });
    const { verification } = sandbox.verify(staged.candidateId);
    assert.equal(verification.parser.ran, false);
    assert.equal(verification.parser.moduleKind, 'n/a');
    const parse = verification.checks.find((c) => c.id === 'real_parse');
    assert.match(parse.detail, /no parser is defined|no parser applies/);
  });
});

// -------------------------------------------------------------------------- staging safety ---

test('T-38 sandbox: staging writes only inside the sandbox, never the workspace', () => {
  withWorkspace(({ root, data, sandbox }) => {
    const before = fs.readFileSync(path.join(root, 'src', 'good.js'));
    const staged = sandbox.stage({
      relativePath: 'src/good.js',
      proposedContent: 'export const ok = 99;\n',
      rationale: 'a change that must not be applied',
    });
    assert.equal(staged.mutatesLiveWorkspace, false);
    assert.equal(staged.authorizesExecution, false);
    // The live file is byte-identical.
    assert.deepEqual(fs.readFileSync(path.join(root, 'src', 'good.js')), before);
    // And the staged file is inside the sandbox directory.
    assert.ok(staged.stagedPath.startsWith(path.join(data, 'workshop-sandbox')), staged.stagedPath);
    assert.ok(fs.existsSync(staged.stagedPath));
  });
});

test('T-38 sandbox: a staged path may not escape, and is refused before anything is written', () => {
  withWorkspace(({ sandbox }) => {
    for (const bad of ['../escape.js', '/tmp/escape.js', 'src/../../escape.js']) {
      assert.throws(
        () => sandbox.stage({ relativePath: bad, proposedContent: 'x' }),
        (err) => err instanceof Error,
        `${bad} must be refused`,
      );
    }
  });
});

test('T-38 sandbox: staging refuses content past its bound rather than truncating it', () => {
  withWorkspace(({ sandbox }) => {
    assert.throws(
      () => sandbox.stage({ relativePath: 'big.txt', proposedContent: 'x'.repeat(300 * 1024) }),
      /exceeds/,
    );
  });
});

test('T-38 sandbox: a candidate is read back from disk, not remembered', () => {
  withWorkspace(({ sandbox }) => {
    const staged = sandbox.stage({ relativePath: 'src/good.js', proposedContent: 'export const ok = 7;\n' });
    const loaded = sandbox.load(staged.candidateId);
    assert.equal(loaded.candidateId, staged.candidateId);
    assert.equal(loaded.digest, staged.digest);
    // A tampered sandbox file is caught: the check re-reads the bytes rather than trusting the record.
    fs.writeFileSync(staged.stagedPath, 'export const ok = 8;\n');
    const { verification } = sandbox.verify(staged.candidateId);
    assert.equal(verification.verified, false);
    assert.ok(verification.failed.includes('content_unchanged_since_staging'));
  });
});

test('T-38 sandbox: verify refuses a candidate that is not staged', () => {
  withWorkspace(({ sandbox }) => {
    const result = sandbox.verify('wsc-000000000000');
    assert.equal(result.found, false);
  });
});

// ----------------------------------------------------------------- via the governed actions ---

test('T-38 actions: a valid candidate verifies and promotes through the ECP', async () => {
  const root = tempDir();
  const data = tempDir('apex-t38-data-');
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'good.js'), 'export const ok = 1;\n');
    const app = createApp({ dataDir: data, filesystemRoot: root });

    const inspect = await app.controller.runAction('workspace.inspect', {}, 'user', 'op-i');
    assert.equal(inspect.outcome, 'success_verified');
    assert.ok(inspect.result.data.entries.some((e) => e.path === 'src/good.js'));

    const staged = await app.controller.runAction('workshop.stage_file', {
      relativePath: 'src/good.js', proposedContent: 'export const ok = 2;\n', rationale: 'improve',
    }, 'user', 'op-s');
    assert.equal(staged.outcome, 'success_verified');
    const candidateId = staged.result.data.candidateId;

    const verified = await app.controller.runAction('workshop.verify_file', { candidateId }, 'user', 'op-v');
    assert.equal(verified.outcome, 'success_verified');
    assert.equal(verified.result.data.verified, true);

    const promoted = await app.controller.runAction('workshop.promote_file', {
      candidateId, reason: 'the change is correct',
    }, 'user', 'op-p');
    assert.equal(promoted.outcome, 'success_verified');
    assert.equal(promoted.result.data.verified, true);
    assert.equal(promoted.result.data.appliesNothing, true);
    // The live workspace was still not written, even after a promotion.
    assert.equal(fs.readFileSync(path.join(root, 'src', 'good.js'), 'utf8'), 'export const ok = 1;\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('T-38 actions: a broken candidate is refused promotion by the ECP-gated action', async () => {
  const root = tempDir();
  const data = tempDir('apex-t38-data-');
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'good.js'), 'export const ok = 1;\n');
    const app = createApp({ dataDir: data, filesystemRoot: root });
    const staged = await app.controller.runAction('workshop.stage_file', {
      relativePath: 'src/good.js', proposedContent: 'export const = ;\n',
    }, 'user', 'op-s');
    const candidateId = staged.result.data.candidateId;
    const verified = await app.controller.runAction('workshop.verify_file', { candidateId }, 'user', 'op-v');
    assert.equal(verified.result.data.verified, false);

    const refused = await app.controller.runAction('workshop.promote_file', {
      candidateId, reason: 'I want it anyway',
    }, 'user', 'op-p');
    assert.equal(refused.outcome, 'execution_failed');
    assert.equal(refused.execution.error.code, 'PROMOTION_REFUSED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('T-38 actions: the model origin may read the workspace but never stage or promote', async () => {
  const root = tempDir();
  const data = tempDir('apex-t38-data-');
  try {
    fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
    const app = createApp({ dataDir: data, filesystemRoot: root });
    const read = await app.controller.runAction('workspace.read_file', { path: 'README.md' }, 'model', 'op-r');
    assert.equal(read.outcome, 'success_verified');

    for (const [name, input] of [
      ['workshop.stage_file', { relativePath: 'a.js', proposedContent: 'x' }],
      ['workshop.verify_file', { candidateId: 'wsc-000000000000' }],
      ['workshop.promote_file', { candidateId: 'wsc-000000000000', reason: 'x' }],
    ]) {
      const denied = await app.controller.runAction(name, input, 'model', 'op-m');
      assert.equal(denied.outcome, 'action_denied', `${name} must refuse the model origin`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('T-38 actions: an inspector with no configured workspace is unavailable, not empty', async () => {
  const data = tempDir('apex-t38-data-');
  try {
    const app = createApp({ dataDir: data });
    const inspect = await app.controller.runAction('workspace.inspect', {}, 'user', 'op-i');
    assert.equal(inspect.outcome, 'execution_failed');
    assert.equal(inspect.execution.error.code, 'WORKSPACE_UNAVAILABLE');
    // The message says there is nothing configured, rather than implying the tree is empty.
    assert.match(inspect.execution.error.message, /no target workspace is configured/);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------------- the diff ---

test('T-38 diff: added and removed line counts describe the change', () => {
  const same = diffSummary('a\nb\nc', 'a\nb\nc');
  assert.deepEqual([same.addedLines, same.removedLines], [0, 0]);

  const added = diffSummary('a\nb', 'a\nb\nc\nd');
  assert.equal(added.addedLines, 2);
  assert.equal(added.removedLines, 0);

  const removed = diffSummary('a\nb\nc', 'a');
  assert.equal(removed.addedLines, 0);
  assert.equal(removed.removedLines, 2);

  const replaced = diffSummary('one\ntwo', 'one\nTWO');
  assert.equal(replaced.addedLines, 1);
  assert.equal(replaced.removedLines, 1);
  assert.deepEqual(replaced.preview.sort(), ['+ TWO', '- two']);
});

test('T-38 diff: a brand-new file counts every line as added', () => {
  withWorkspace(({ sandbox }) => {
    const staged = sandbox.stage({ relativePath: 'src/brand-new.js', proposedContent: 'export const a = 1;\nexport const b = 2;\n' });
    assert.equal(staged.base.exists, false);
    assert.equal(staged.diff.removedLines, 0);
    assert.ok(staged.diff.addedLines >= 2);
  });
});

// ------------------------------------------------------------------------------ spawn safety ---
// The registry invariant test allows exactly one new process-spawning file, `src/workshop/sandbox.js`,
// on the strength of the properties pinned here. If any of them changes, that allowlist entry is no
// longer justified and this test must fail rather than silently widen the reviewed surface.
test('T-38 spawn: the verifier runs a fixed argument vector with no shell and a hard timeout', () => {
  const source = fs.readFileSync(new URL('../src/workshop/sandbox.js', import.meta.url), 'utf8');
  // The command is a literal `--check` against the staged path, and nothing else.
  assert.match(source, /execFileSync\(process\.execPath, \['--check', stagedPath\]/, 'the argument vector must stay fixed');
  // The executable is always the running Node binary - never a caller-supplied string.
  assert.doesNotMatch(source, /execFileSync\((?!process\.execPath)/, 'only process.execPath may be executed');
  assert.doesNotMatch(source, /execFileSync\([^)]*\bshell:\s*true/, 'a shell must never be used');
  assert.doesNotMatch(source, /\bexecSync\b|\bspawnSync\(.*shell/, 'no shell-executing spawn may be used');
  assert.match(source, /timeout:\s*SYNTAX_CHECK_TIMEOUT_MS/, 'the timeout must be a bounded constant');
  // And the constant is a real bound, not Infinity or an absent value.
  assert.match(source, /SYNTAX_CHECK_TIMEOUT_MS\s*=\s*[\d_]{3,8}/, 'the timeout constant must be a finite number of milliseconds');
  // Only the child_process import of execFileSync, nothing wider.
  assert.match(source, /import \{ execFileSync \} from 'node:child_process'/, 'only execFileSync may be imported');
});

test('T-38 spawn: the parser only ever reads a staged path inside the sandbox', () => {
  withWorkspace(({ data, sandbox }) => {
    const staged = sandbox.stage({ relativePath: 'src/good.js', proposedContent: 'export const ok = 3;\n' });
    const { verification } = sandbox.verify(staged.candidateId);
    assert.equal(verification.parser.ran, true);
    assert.equal(verification.parser.exitCode, 0);
    // The record carries a curated parser shape, not the raw spawn options: no command string, no
    // shell setting, nothing a caller could have supplied. Its fields are exactly these.
    assert.deepEqual(Object.keys(verification.parser).sort(), ['exitCode', 'kind', 'moduleKind', 'ran', 'stderr']);
    assert.equal(verification.parser.kind, 'node_check');
    assert.ok(staged.stagedPath.startsWith(path.join(data, 'workshop-sandbox')));
  });
});
