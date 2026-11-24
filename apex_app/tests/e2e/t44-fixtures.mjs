// T-44 Package 4 (2026-11-19): the fixture the standing-orders and agenda walk drives.
//
// Same shape as the T-43 fixture - a real git repository, a real composed application, a real UI server -
// because the two things this milestone is about are decided by the product's own registry rather than by
// the walk's beliefs:
//
//   * **What may be delegated** is read from the capability declarations. So the workspace here is a real
//     repository, which is what makes `git.status_detailed` exist to be delegated in the first place.
//   * **What is owed** is read from the stores the agenda does not own. So the fixture writes to those
//     stores through the routes, never into the agenda ledger, and the walk asserts the agenda reports
//     what is there.
//
// Nothing contacts a model, reads the real APEX data directory, or touches the repository's tree.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createApp } from '../../src/app.js';
import { createUiServer } from '../../src/ui/server.js';
import { ModelGateway, NoBackend } from '../../src/model/gateway.js';

export const T44_TOKEN = 'T44-standing-orders-agenda-token-0123456789';
export const T44_SCHEMA = 'apex.t44.standing-orders-agenda/1';

// The committed and edited bytes. One line changes, so `git.status_detailed` has a repository whose
// state is a number the walk could assert if it wanted to; the point is only that it is real.
export const T44_TRACKED_COMMITTED = 'export const phase = 1;\n';
export const T44_TRACKED_EDITED = 'export const phase = 2;\n';

// The two names the walk uses. Stated here so a selector and the assertion that reads it cannot drift.
export const T44_ORDER_TITLE = 'reading when the tree goes dirty';
export const T44_COMMITMENT_TITLE = 'Review phase 2 telemetry';
export const T44_ROUTER_LINE = 'schedule Review phase 2 telemetry';

function git(cwd, args) {
  // No trim, for the reason the T-43 fixture gives: porcelain's leading space is the whole difference
  // between a worktree edit and a staged one.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'APEX T-44',
      GIT_AUTHOR_EMAIL: 't44@apex.invalid',
      GIT_COMMITTER_NAME: 'APEX T-44',
      GIT_COMMITTER_EMAIL: 't44@apex.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

export async function startT44Ui({ token = T44_TOKEN, port = 0, withRepo = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-t44-e2e-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  const trackedPath = path.join(workspace, 'src', 'phase.js');
  await fsp.writeFile(trackedPath, T44_TRACKED_COMMITTED, 'utf8');
  await fsp.writeFile(path.join(workspace, 'README.md'), '# the T-44 workspace\n\nA real git repository.\n', 'utf8');

  let headSha = null;
  let repo = null;
  if (withRepo) {
    git(workspace, ['init', '--quiet', '--initial-branch=main']);
    git(workspace, ['add', '--', 'README.md', 'src/phase.js']);
    git(workspace, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'T-44 fixture baseline']);
    const clean = git(workspace, ['status', '--porcelain=v1']);
    if (clean !== '') throw new Error(`the T-44 fixture baseline is not clean: ${JSON.stringify(clean)}`);
    headSha = git(workspace, ['rev-parse', 'HEAD']).trim();
    // One worktree edit, so the repository the standing order reads is a repository with something in it.
    await fsp.writeFile(trackedPath, T44_TRACKED_EDITED, 'utf8');
    repo = { root: workspace, headSha, branch: git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() };
  }

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
  const post = async (pathname, body = {}) => {
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
    app, ui, root, dataDir, workspace, trackedPath, base, token, headers, headSha, repo,
    get, post, stop,
    readTracked: () => fs.readFileSync(trackedPath, 'utf8'),
    // The two ledgers, parsed. The walk reads these rather than trusting a response field, because "the
    // order ran" and "the commitment is stored" are claims about records, not about a JSON body.
    standingOrderLedger: () => {
      const file = path.join(dataDir, 'standing-orders.json');
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    agendaLedger: () => {
      const file = path.join(dataDir, 'executive-agenda.json');
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    operationLedger: () => {
      const file = path.join(dataDir, 'operations.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    // The lockdown latch, moved through the product's own route so the walk is using the same path an
    // owner would. It is released in the same walk, and the fixture asserts it was released.
    lock: () => post('/api/safety/lockdown', { reason: 'T-44 walk: prove the latch halts every order' }),
    release: () => post('/api/safety/release', { reason: 'T-44 walk: prove release fires nothing', confirm: true }),
    latchActive: () => app.registry.controlPlane.killSwitchStatus().active === true,
  };
}
