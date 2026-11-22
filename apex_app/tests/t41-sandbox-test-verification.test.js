// T-41 Step 2 (2026-11-22): sandboxed behavioural verification.
//
// T-33 taught the Workshop to say "this file parses". T-41 teaches it to say "this file behaves", and
// these tests pin the three things that claim could get wrong:
//
//   1. **It is real.** The staged test runs under the real `node --test`, and its own summary is what
//      fills `passedCount` and `failedCount`. A passing test verifies; a failing assertion does not.
//   2. **It is contained.** The command is a fixed argument vector with `shell: false`, the working
//      directory is the candidate's own sandbox directory, the environment carries no credentials, and
//      a run that changes the live workspace is caught by a measurement taken around it.
//   3. **It gates.** A failed sandbox test makes `verified: false`, and a `verified: false` candidate is
//      refused with `409 APPLY_REFUSED_UNVERIFIED` rather than written.
//
// Nothing here contacts a model, reads the real APEX data directory, or writes the repository tree.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import {
  WorkshopSandbox, SANDBOX_TEST_TIMEOUT_MS, sandboxTestCounts,
} from '../src/workshop/sandbox.js';

const TOKEN = 't41-sandbox-test-token-0123456789';
const roots = [];
const servers = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t41-sb-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (servers.length) await servers.pop().stop().catch(() => {});
  while (roots.length) {
    const root = roots.pop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* already removed */ }
  }
});

// A workspace with one real file, and a sandbox pointed at it.
function fixture() {
  const root = tempRoot();
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'greeting.js'), 'export const version = 1;\n', 'utf8');
  const sandbox = new WorkshopSandbox({ dataDir, workspaceRoot: workspace });
  return { root, dataDir, workspace, sandbox };
}

const PASSING = "import test from 'node:test';\nimport assert from 'node:assert';\nimport { version } from './greeting.js';\n"
  + "test('version is 2', () => { assert.equal(version, 2); });\n"
  + "test('it is a number', () => { assert.equal(typeof version, 'number'); });\n";

const FAILING = "import test from 'node:test';\nimport assert from 'node:assert';\nimport { version } from './greeting.js';\n"
  + "test('version is 3', () => { assert.equal(version, 3); });\n";

describe('T-41 the sandbox runs a staged test for real', () => {
  test('a passing test verifies and reports the runner\'s own counts', () => {
    const { sandbox } = fixture();
    const staged = sandbox.stage({
      relativePath: 'greeting.js', proposedContent: 'export const version = 2;\n', testContent: PASSING,
    });
    assert.equal(typeof staged.testPath, 'string', 'the companion test is written into the sandbox');
    assert.match(staged.testDigest, /^[0-9a-f]{64}$/);

    const { verification } = sandbox.verify(staged.candidateId);
    assert.equal(verification.verified, true, `expected verified, failed: ${verification.failed}`);
    assert.equal(verification.executedCode, true, 'code really ran');
    assert.equal(verification.sandboxTestResult.ran, true);
    assert.equal(verification.sandboxTestResult.exitCode, 0);
    assert.ok(verification.sandboxTestResult.passedCount >= 2,
      `two assertions passed, reported ${verification.sandboxTestResult.passedCount}`);
    assert.equal(verification.sandboxTestResult.failedCount, 0);
    assert.equal(verification.sandboxTestResult.mutatedLiveWorkspace, false);
  });

  test('a failing assertion makes verified false and keeps the failing output', () => {
    const { sandbox } = fixture();
    const staged = sandbox.stage({
      relativePath: 'greeting.js', proposedContent: 'export const version = 2;\n', testContent: FAILING,
    });
    const { verification } = sandbox.verify(staged.candidateId);
    assert.equal(verification.verified, false);
    assert.ok(verification.failed.includes('sandbox_test_passed'), JSON.stringify(verification.failed));
    const result = verification.sandboxTestResult;
    assert.equal(result.exitCode, 1);
    assert.ok(result.failedCount >= 1, `expected at least one failing assertion, got ${result.failedCount}`);
    assert.equal(result.passedCount, 0);
    // The owner has to be able to see WHY: the excerpt carries the assertion, not just the exit code.
    assert.match(result.outputExcerpt, /version is 3|not ok|AssertionError/i);
  });

  test('a candidate staged without a test is verified for parsing only, and says so', () => {
    const { sandbox } = fixture();
    const staged = sandbox.stage({ relativePath: 'greeting.js', proposedContent: 'export const version = 2;\n' });
    assert.equal(staged.testPath, null);
    const { verification } = sandbox.verify(staged.candidateId);
    assert.equal(verification.verified, true);
    assert.equal(verification.executedCode, false, 'nothing ran');
    assert.equal(verification.sandboxTestResult, null, 'null is honest: behaviour was not exercised');
    const check = verification.checks.find((c) => c.id === 'sandbox_test_passed');
    assert.match(check.detail, /no companion test/i);
  });

  test('the timeout is a failure, not a pass', () => {
    // The bound is the module's own constant, and it is short enough that a wedged candidate cannot
    // hold a verification open.
    assert.equal(SANDBOX_TEST_TIMEOUT_MS, 5_000);
    const { sandbox } = fixture();
    const wedged = "import test from 'node:test';\n"
      + "test('never finishes', () => { const until = Date.now() + 600000; while (Date.now() < until) {} });\n";
    const staged = sandbox.stage({
      relativePath: 'greeting.js', proposedContent: 'export const version = 2;\n', testContent: wedged,
    });
    const { verification } = sandbox.verify(staged.candidateId);
    assert.equal(verification.verified, false, 'a test that did not finish has not passed');
    assert.equal(verification.sandboxTestResult.timedOut, true);
    assert.match(verification.sandboxTestResult.outputExcerpt, /did not finish within 5000 ms/);
  });

  test('the test runs in the sandbox, not in the live workspace', () => {
    const { sandbox, workspace } = fixture();
    // A test that writes a relative file. It must land in the candidate's sandbox directory, because
    // that is the working directory - and the live workspace must stay untouched.
    const writes = "import fs from 'node:fs';\nimport test from 'node:test';\nimport assert from 'node:assert';\n"
      + "test('writes locally', () => { fs.writeFileSync('relative-output.txt', 'in the sandbox'); assert.ok(true); });\n";
    const staged = sandbox.stage({
      relativePath: 'greeting.js', proposedContent: 'export const version = 2;\n', testContent: writes,
    });
    const { verification } = sandbox.verify(staged.candidateId);
    assert.equal(verification.verified, true, `failed: ${verification.failed}`);
    assert.equal(verification.sandboxTestResult.mutatedLiveWorkspace, false);
    assert.equal(fs.existsSync(path.join(staged.sandboxDir, 'relative-output.txt')), true,
      'the write landed in the sandbox working directory');
    assert.equal(fs.existsSync(path.join(workspace, 'relative-output.txt')), false,
      'nothing was written into the live workspace');
    assert.equal(fs.readFileSync(path.join(workspace, 'greeting.js'), 'utf8'), 'export const version = 1;\n');
  });

  test('a test that reaches the live workspace is measured and refused', () => {
    const { sandbox, workspace } = fixture();
    const target = path.join(workspace, 'ESCAPED.txt');
    // An absolute path is the simplest escape, and the sandbox cannot prevent the write - the check is
    // what catches it. This is the reason `workspace_untouched_by_test` exists rather than being assumed.
    const escape = `import fs from 'node:fs';\nimport test from 'node:test';\nimport assert from 'node:assert';\n`
      + `test('escapes', () => { fs.writeFileSync(${JSON.stringify(target)}, 'x'); assert.ok(true); });\n`;
    const staged = sandbox.stage({
      relativePath: 'greeting.js', proposedContent: 'export const version = 2;\n', testContent: escape,
    });
    const { verification } = sandbox.verify(staged.candidateId);
    assert.equal(fs.existsSync(target), true, 'the escape really happened - the test is not vacuous');
    assert.equal(verification.verified, false, 'the mutation must be refused, not ignored');
    assert.ok(verification.failed.includes('workspace_untouched_by_test'), JSON.stringify(verification.failed));
    assert.equal(verification.sandboxTestResult.mutatedLiveWorkspace, true);
  });

  test('a test body is never parsed by a shell', () => {
    const { sandbox } = fixture();
    const canary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t41-canary-')), 'PWNED');
    roots.push(path.dirname(canary));
    const staged = sandbox.stage({
      relativePath: 'greeting.js', proposedContent: 'export const version = 2;\n',
      // If this string ever reached a shell it would create the canary file.
      testContent: `$(touch ${canary}); echo hi`,
    });
    const { verification } = sandbox.verify(staged.candidateId);
    assert.equal(fs.existsSync(canary), false, 'the metacharacters were never interpreted');
    assert.equal(verification.verified, false, 'it is not valid JavaScript either');
    assert.match(verification.sandboxTestResult.command, /--test <staged test>/);
  });

  test('the runner summary is read, not guessed', () => {
    assert.deepEqual(sandboxTestCounts('# pass 3\n# fail 0\n').passed, 3);
    assert.deepEqual(sandboxTestCounts('# pass 3\n# fail 0\n').failed, 0);
    assert.deepEqual(sandboxTestCounts('# pass 0\n# fail 2\n').failed, 2);
    // A run that printed no summary at all is one failure, never a silent pass.
    assert.deepEqual(sandboxTestCounts(''), { passed: 0, failed: 0 });
    assert.deepEqual(sandboxTestCounts('Error: boom').failed, 1);
  });

  test('staging bounds the test text', () => {
    const { sandbox } = fixture();
    assert.throws(() => sandbox.stage({
      relativePath: 'greeting.js', proposedContent: 'export const version = 2;\n', testContent: '   ',
    }), /must not be empty/);
    assert.throws(() => sandbox.stage({
      relativePath: 'greeting.js', proposedContent: 'export const version = 2;\n', testContent: 42,
    }), /must be text/);
  });
});

describe('T-41 an unverified candidate cannot be applied', () => {
  async function startUi() {
    const root = tempRoot();
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'greeting.js'), 'export const version = 1;\n', 'utf8');
    const app = createApp({
      dataDir, filesystemRoot: workspace, gateway: new ModelGateway({ backend: new NoBackend() }),
    });
    const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    servers.push(ui);
    const headers = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1', 'content-type': 'application/json' };
    const base = `http://127.0.0.1:${started.port}`;
    const post = async (pathname, body) => {
      const response = await fetch(`${base}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    return { dataDir, workspace, post };
  }

  test('a failing sandbox test blocks the apply with 409 APPLY_REFUSED_UNVERIFIED', async () => {
    const { post, workspace } = await startUi();
    const staged = await post('/api/workshop/stage', {
      relativePath: 'greeting.js', proposedContent: 'export const version = 2;\n', testContent: FAILING,
    });
    assert.equal(staged.status, 200);
    assert.equal(staged.body.hasSandboxTest, true);
    assert.equal(staged.body.verified, false, 'staging is not verifying');

    const verified = await post('/api/workshop/verify-file', { candidateId: staged.body.candidateId });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.verified, false);
    assert.ok(verified.body.failed.includes('sandbox_test_passed'));
    assert.equal(verified.body.sandboxTestResult.exitCode, 1);

    const applied = await post(`/api/workshop/candidates/${staged.body.candidateId}/apply`, { reason: 't41 failing test' });
    assert.equal(applied.status, 409, JSON.stringify(applied.body));
    assert.equal(applied.body.code, 'APPLY_REFUSED_UNVERIFIED');
    assert.equal(fs.readFileSync(path.join(workspace, 'greeting.js'), 'utf8'), 'export const version = 1;\n',
      'the refused apply wrote nothing');
  });

  test('a passing sandbox test verifies, applies, and writes the candidate', async () => {
    const { post, workspace } = await startUi();
    const staged = await post('/api/workshop/stage', {
      relativePath: 'greeting.js', proposedContent: 'export const version = 2;\n', testContent: PASSING,
    });
    const verified = await post('/api/workshop/verify-file', { candidateId: staged.body.candidateId });
    assert.equal(verified.body.verified, true, JSON.stringify(verified.body.failed));
    assert.ok(verified.body.sandboxTestResult.passedCount >= 2);

    const applied = await post(`/api/workshop/candidates/${staged.body.candidateId}/apply`, { reason: 't41 passing test' });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(fs.readFileSync(path.join(workspace, 'greeting.js'), 'utf8'), 'export const version = 2;\n',
      'the verified candidate was written');
  });

  test('the HTTP layer refuses an empty or oversized test body', async () => {
    const { post } = await startUi();
    const empty = await post('/api/workshop/stage', {
      relativePath: 'greeting.js', proposedContent: 'export const version = 2;\n', testContent: '   ',
    });
    assert.equal(empty.status, 400);
    assert.match(String(empty.body.error), /must not be empty/);

    const oversized = await post('/api/workshop/stage', {
      relativePath: 'greeting.js', proposedContent: 'export const version = 2;\n', testContent: `// ${'x'.repeat(256 * 1024)}\n`,
    });
    // 413: the body limit refuses it before the action ever sees it, which is the earlier and better
    // refusal. What matters is that a 256 KiB test is not accepted.
    assert.equal(oversized.status, 413, JSON.stringify(oversized.body));
  });
});
