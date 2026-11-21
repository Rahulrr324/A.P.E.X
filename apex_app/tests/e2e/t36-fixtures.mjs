// T-36 Step 4 (2026-11-21): the fixture the cold-boot browser walk drives.
//
// This fixture is deliberately the opposite of t31-t35. Those start from a seeded data directory,
// because they are testing what the deck does once there is something to show. This one starts
// from nothing at all: a fresh temporary directory with no stores, no enrolled device, no
// perception reading and no bootstrap marker, plus a real temporary git repository with one
// commit. The only things created before the browser opens are the directory and the repository.
//
// That is the whole point. If the cold boot works, everything the walk checks - the host reading,
// the git branch and head, the `local-workstation` device, the briefing - was produced by the
// bootstrap during the walk, against this machine and this repository. If it does not work, the
// walk fails with an empty deck rather than passing on a fixture's help.
//
// Nothing here contacts a model, reads a real APEX data directory, or writes anything outside the
// temporary root.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createApp } from '../../src/app.js';
import { createUiServer } from '../../src/ui/server.js';
import { ModelGateway, NoBackend } from '../../src/model/gateway.js';

export const T36_TOKEN = 'T36-cold-boot-unseeded-token-0123456789';
export const T36_SCHEMA = 'apex.t36.cold-boot-unseeded/1';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T-36 fixture',
  GIT_AUTHOR_EMAIL: 't36@apex.invalid',
  GIT_COMMITTER_NAME: 'T-36 fixture',
  GIT_COMMITTER_EMAIL: 't36@apex.invalid',
};

// A real repository, committed with real git: the workspace sensor reads it with git itself, so
// the branch and head the cold boot reports are this repository's, not a fixture's claim.
export function createColdRepository(root) {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=trunk', workspace], { stdio: 'ignore', env: GIT_ENV });
  fs.writeFileSync(path.join(workspace, 'README.md'), 'A brand-new workstation, with nothing seeded in it.\n');
  execFileSync('git', ['-C', workspace, 'add', 'README.md'], { stdio: 'ignore', env: GIT_ENV });
  execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'the first commit on a cold workstation'], { stdio: 'ignore', env: GIT_ENV });
  const branch = execFileSync('git', ['-C', workspace, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', env: GIT_ENV }).trim();
  const head = execFileSync('git', ['-C', workspace, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', env: GIT_ENV }).trim();
  return { workspace, branch, head };
}

// The unseeded state, read from disk rather than assumed: what exists in the temporary directory
// before the browser opens is exactly what a fresh install has, and the walk reports it.
function readUnseeded(dataDir) {
  const entries = (() => {
    try {
      return fs.readdirSync(dataDir);
    } catch {
      return [];
    }
  })();
  return {
    dataDir,
    entries,
    bootstrapMarker: fs.existsSync(path.join(dataDir, 'system-bootstrap.json')),
    // `devices.jsonl` is the device-trust chain; `perception/` is the observation ledger.
    deviceRegistry: fs.existsSync(path.join(dataDir, 'devices.jsonl')),
    perceptionLedger: fs.existsSync(path.join(dataDir, 'perception')),
  };
}

export async function startT36Ui({ token = T36_TOKEN, port = 0 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-t36-e2e-'));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  const repository = createColdRepository(root);
  const before = readUnseeded(dataDir);

  const app = createApp({
    dataDir,
    filesystemRoot: repository.workspace,
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

  return {
    app,
    ui,
    root,
    dataDir,
    workspace: repository.workspace,
    repository,
    // What was on disk before anything ran. The walk asserts this is empty, so a fixture that
    // leaked a seed would fail the walk rather than quietly make it pass.
    unseeded: before,
    base,
    port: started.port,
    token,
    headers,
    get,
    post,
    // Every reader returns `{ status, body }`, the same shape `get`/`post`/`bootstrap` return, so a
    // caller never has to remember which helper unwraps and which does not.
    bootstrap: async (reason = 'T-36 cold-boot walk') => post('/api/system/bootstrap', { reason }),
    bootstrapState: async () => get('/api/system/bootstrap'),
    doctor: async () => get('/api/system/doctor'),
    presence: async () => get('/api/presence'),
    state: async () => get('/api/state'),
    briefing: async () => get('/api/briefing'),
    after: () => readUnseeded(dataDir),
    // T-29: a cognitive intent launched from the freshly bootstrapped deck. The write step is
    // gated, so the ECP leaves it awaiting the owner's approval - which is the point: the run is
    // real, the intent was understood, and nothing was executed without the owner.
    async cognitiveRun(overrides = {}) {
      return post('/api/cognition/run', {
        intent: 'record the first note from a workstation that booted a moment ago',
        action: 'memory.add',
        input: { content: 'the T-36 cold-boot note' },
        ...overrides,
      });
    },
    async stop() {
      await ui.stop().catch(() => {});
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}
