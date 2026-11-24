// T-45 Package 4 (2026-11-19): the fixture the playbook / watchpoint / overlay walk drives.
//
// Same shape as the T-44 fixture - a real git repository, a real composed application, a real UI server -
// because every number this milestone is about is decided by the product rather than by the walk's beliefs:
//
//   * A playbook's three steps are decided by the capability declarations. So the workspace here is a real
//     repository with a real edit in it, which is what makes `git.status_detailed` a reading the fan-in step
//     can verify rather than one that reports itself unavailable.
//   * A watchpoint's two live states are decided by the machine. `apex_rss_mb` is this process's own
//     resident set, so a threshold of 1 MB is breached by any running APEX and a threshold of 999999 is
//     nominal without anyone faking a reading. `dirty_files_count` is the fixture's real worktree edit.
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

export const T45_TOKEN = 'T45-playbooks-watchpoints-overlay-token-0123456789';
export const T45_SCHEMA = 'apex.t45.playbooks-watchpoints-overlay/1';

// The committed and edited bytes. One line changes, so `dirty_files_count` is at least one for a real
// reason: the same defect the routine's `git.status_detailed` step reads.
export const T45_TRACKED_COMMITTED = 'export const phase = 1;\n';
export const T45_TRACKED_EDITED = 'export const phase = 2;\n';

// The names the walk uses. Stated here so a selector and the assertion that reads it cannot drift.
export const T45_PLAYBOOK_ID = 'workspace_security_audit';
export const T45_WATCHPOINT_TITLE = 'the tree has uncommitted work';
export const T45_BREACH_TITLE = 'this process is resident';
export const T45_ROUTER_PLAYBOOK_LINE = `run playbook ${T45_PLAYBOOK_ID}`;
export const T45_ROUTER_WATCHPOINT_LINE = 'evaluate watchpoints';
export const T45_ROUTER_OVERLAY_LINE = 'toggle overlay';

function git(cwd, args) {
  // No trim, for the reason the T-43 and T-44 fixtures give: porcelain's leading space is the whole
  // difference between a worktree edit and a staged one.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'APEX T-45',
      GIT_AUTHOR_EMAIL: 't45@apex.invalid',
      GIT_COMMITTER_NAME: 'APEX T-45',
      GIT_COMMITTER_EMAIL: 't45@apex.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

export async function startT45Ui({ token = T45_TOKEN, port = 0, withRepo = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-t45-e2e-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  const trackedPath = path.join(workspace, 'src', 'phase.js');
  await fsp.writeFile(trackedPath, T45_TRACKED_COMMITTED, 'utf8');
  await fsp.writeFile(path.join(workspace, 'README.md'), '# the T-45 workspace\n\nA real git repository.\n', 'utf8');

  let headSha = null;
  let repo = null;
  if (withRepo) {
    git(workspace, ['init', '--quiet', '--initial-branch=main']);
    git(workspace, ['add', '--', 'README.md', 'src/phase.js']);
    git(workspace, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'T-45 fixture baseline']);
    const clean = git(workspace, ['status', '--porcelain=v1']);
    if (clean !== '') throw new Error(`the T-45 fixture baseline is not clean: ${JSON.stringify(clean)}`);
    headSha = git(workspace, ['rev-parse', 'HEAD']).trim();
    // One worktree edit, so `dirty_files_count` is one and the fan-in step has something to read.
    await fsp.writeFile(trackedPath, T45_TRACKED_EDITED, 'utf8');
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

  const readJson = (name) => {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };

  return {
    app, ui, root, dataDir, workspace, trackedPath, base, token, headers, headSha, repo,
    get, post, stop,
    readTracked: () => fs.readFileSync(trackedPath, 'utf8'),
    // The three ledgers, parsed. The walk reads these rather than trusting a response field, because "the
    // routine ran" and "the threshold was judged" are claims about records, not about a JSON body.
    playbookRunLedger: () => readJson('playbook-runs.json'),
    watchpointLedger: () => readJson('sentinel-watchpoints.json'),
    operationLedger: () => {
      const file = path.join(dataDir, 'operations.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    // The lockdown latch, moved through the product's own route so the walk is using the same path an
    // owner would. It is released in the same walk, and the fixture asserts it was released.
    lock: () => post('/api/safety/lockdown', { reason: 'T-45 walk: prove the latch halts a launch and an evaluation' }),
    release: () => post('/api/safety/release', { reason: 'T-45 walk: prove release fires nothing', confirm: true }),
    latchActive: () => app.registry.controlPlane.killSwitchStatus().active === true,
  };
}
