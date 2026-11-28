// T-41 Step 4 (2026-11-22): the fixture the sandbox-test and evolution-bridge walk drives.
//
// Same shape as the T-40 fixture, for the same reason: this milestone is about real bytes, a real
// sandbox, a real test runner process and a real router, so the fixture owns all of them. It creates a
// temporary workspace with two files whose bytes are known here, a temporary data directory, an app
// with no model backend, and a UI server with a Bearer token.
//
// The workspace mirrors the shape a real tree has: `src/greeting.js` is the file a proposal will
// change, and the protected paths exist as directories so a refusal is a refusal about a real member
// of a real tree rather than about a string.
//
// Nothing contacts a model, reads the real APEX data directory, or touches the repository's tree.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/app.js';
import { createUiServer } from '../../src/ui/server.js';
import { ModelGateway, NoBackend } from '../../src/model/gateway.js';

export const T41_TOKEN = 'T41-sandbox-test-evolution-bridge-token-0123456789';
export const T41_SCHEMA = 'apex.t41.sandbox-test-and-evolution-bridge/1';

export const T41_GREETING_LIVE = 'export function greet(name) {\n  return "hello " + name;\n}\n';
export const T41_GREETING_NEXT = 'export function greet(name) {\n  return "hello " + name + "!";\n}\nexport const version = 2;\n';

// A companion test that FAILS against the staged content. It asserts the version is 3, so the sandbox
// run exits non-zero, `verified` is false, and the apply is refused. Whether the test is broken or the
// candidate is broken does not matter to the walk: a failed assertion has to stop the write.
export const T41_TEST_FAILING = "import test from 'node:test';\n"
  + "import assert from 'node:assert';\n"
  + "import { version } from './greeting.js';\n"
  + "test('the greeting carries version 3', () => {\n"
  + '  assert.equal(version, 3);\n'
  + '});\n';

// The same test, corrected to assert what the candidate actually does. Two assertions, so the reported
// pass count is a number the walk can compare against rather than "at least one".
export const T41_TEST_PASSING = "import test from 'node:test';\n"
  + "import assert from 'node:assert';\n"
  + "import { greet, version } from './greeting.js';\n"
  + "test('the greeting carries version 2', () => {\n"
  + '  assert.equal(version, 2);\n'
  + '});\n'
  + "test('the greeting still greets', () => {\n"
  + '  assert.equal(greet("apex"), "hello apex!");\n'
  + '});\n';

// The five paths the immutable boundary protects, in the spellings the policy uses. Each is created as
// a real file under the fixture workspace so the walk is refusing a real member of the tree.
export const T41_PROTECTED = Object.freeze([
  'src/executive/control-plane.js',
  'src/security/latch.js',
  'src/governance/policy.js',
  'src/autonomy/matrix.js',
  'src/workshop/applier.js',
]);

export async function startT41Ui({ token = T41_TOKEN, port = 0 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-t41-e2e-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  const greetingPath = path.join(workspace, 'src', 'greeting.js');
  await fsp.writeFile(greetingPath, T41_GREETING_LIVE, 'utf8');

  // The protected tree. These files are never proposed against successfully; they exist so that a
  // refused target names a path that is really there.
  for (const relative of T41_PROTECTED) {
    const full = path.join(workspace, relative);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, `// ${relative}: protected by the immutable governance boundary\nexport const protectedFile = true;\n`, 'utf8');
  }
  await fsp.writeFile(path.join(workspace, 'README.md'), '# the T-41 workspace\n\nOne greeting, and a protected tree.\n', 'utf8');

  const app = createApp({
    dataDir,
    filesystemRoot: workspace,
    gateway: new ModelGateway({ backend: new NoBackend() }),
  });
  const ui = createUiServer({ app, token, host: '127.0.0.1', port });
  let started;
  try {
    started = await ui.start();
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const base = `http://127.0.0.1:${started.port}`;
  const headers = { authorization: `Bearer ${token}`, 'x-apex-ui': '1' };

  const get = async (pathname) => {
    const response = await fetch(`${base}${pathname}`, { headers });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const post = async (pathname, body) => {
    const response = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const stop = async () => {
    await ui.stop();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  };

  return {
    app, ui, root, dataDir, workspace, greetingPath, base, token, headers, get, post,
    // Read from disk every time. A cached value would let the walk assert a claim about the file
    // without ever looking at it.
    readGreeting: () => fs.readFileSync(greetingPath, 'utf8'),
    readProtected: (relative) => fs.readFileSync(path.join(workspace, relative), 'utf8'),
    // The evolution ledger, parsed. Every phase that claims "nothing was recorded" reads this.
    evolutionEvents: () => {
      const file = path.join(dataDir, 'evolution-proposals.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    // The candidate record, read from the sandbox. This is where `sourceProposalId` lives, and reading
    // it here is what proves the link is on disk rather than only in a response body.
    candidateRecord: (candidateId) => {
      const file = path.join(dataDir, 'workshop-sandbox', candidateId, 'candidate.json');
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    async stop() { await stop(); },
  };
}
