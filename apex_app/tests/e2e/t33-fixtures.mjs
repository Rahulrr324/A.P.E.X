// T-33 Step 4 (2026-11-19): the fixture the executive-loop browser walk drives.
//
// It is the same shape as the T-31 fixture - the shipped app and UI server in this process, an
// isolated temporary data directory, no model backend - with two additions the T-33 loop needs:
//
//   * a real, tiny git workspace. The perception sensor reads it with git itself, so the
//     `workspace_dirty` advisory the walk dismisses twice is implied by an actual reading of an
//     actual repository, not by a fabricated sensor. The repository is temporary and is removed
//     with the data directory.
//   * one gated cognitive run, started through the HTTP route, so the deck opens on Awaiting
//     Approval with a real step waiting for the owner.
//
// Nothing here reads or writes a real APEX data directory, contacts a model, or invents a value
// the product would not produce.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createApp } from '../../src/app.js';
import { createUiServer } from '../../src/ui/server.js';
import { ModelGateway, NoBackend } from '../../src/model/gateway.js';

export const T33_TOKEN = 'T33-executive-loop-token-0123456789';
export const T33_SCHEMA = 'apex.t33.executive-loop/1';

// A repository with one committed file and one uncommitted change: dirtyFiles >= 1, so the
// workspace rule fires. `git` is used exactly as the sensor uses it.
export function createDirtyWorkspace(root) {
  const workspace = path.join(root, 'workspace');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', workspace], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'config', 'user.email', 't33@apex.invalid'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'config', 'user.name', 'T-33 fixture'], { stdio: 'ignore' });
  const file = path.join(workspace, 'loop.txt');
  fs.writeFileSync(file, 'committed\n');
  execFileSync('git', ['-C', workspace, 'add', 'loop.txt'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'T-33 fixture baseline'], { stdio: 'ignore' });
  fs.writeFileSync(file, 'committed\nuncommitted\n');
  return workspace;
}

// Delivery is deduplicated by the condition's signature, so a revoked class is delivered again only
// when the machine has actually changed. A second untracked file changes the signature without
// inventing anything: the tree really is dirtier than it was.
export function addUntrackedFile(workspace) {
  const file = path.join(workspace, `untracked-${Date.now()}.txt`);
  fs.writeFileSync(file, 'an untracked file, recorded by the fixture\n');
  return { file, status: execFileSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' }).trim() };
}

// The workspace the walk reads is a real repository, so the honest way to clear the advisory is to
// clear the condition: commit the change and let the next reading see a clean tree.
export function tidyWorkspace(workspace) {
  execFileSync('git', ['-C', workspace, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'T-33 fixture: the change is committed'], { stdio: 'ignore' });
  const status = execFileSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' });
  return { clean: status.trim().length === 0 };
}

export async function startT33Ui({ token = T33_TOKEN, port = 0 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-t33-loop-'));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  const workspace = createDirtyWorkspace(root);
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
  const seeded = await seed(app, { base, headers, workspace });
  return {
    app, ui, root, dataDir, workspace, base, port: started.port, token, headers, seed: seeded,
    tidyWorkspace() { return tidyWorkspace(workspace); },
    addUntrackedFile() { return addUntrackedFile(workspace); },
    async stop() {
      await ui.stop().catch(() => {});
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function seed(app, { base, headers, workspace = null }) {
  const memory = await app.memory.add({
    content: 'the T-33 executive loop stores this fact so the walk has a real memory to read',
    kind: 'user_fact',
    source: 'user',
  });
  // A gated write step: the pipeline records the run and the ECP leaves it awaiting the owner.
  const response = await fetch(`${base}/api/cognition/run`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      intent: 'store the T-33 loop marker in memory',
      action: 'memory.add',
      input: { content: 'the T-33 loop marker' },
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(`the T-33 fixture could not start a gated run: ${response.status} ${JSON.stringify(body)}`);
  const graph = await fetch(`${base}/api/taskgraph`, { headers }).then((r) => r.json()).catch(() => null);
  return {
    memoryId: memory?.id ?? null,
    runId: body.run?.runId ?? null,
    runStatus: body.run?.status ?? body.runStatus ?? null,
    taskId: graph?.taskId ?? null,
    taskStatus: graph?.status ?? null,
    workspace,
  };
}

// What the walk is allowed to claim afterwards: the mirrored backend state, read from the same
// routes the page reads, so a screenshot that looks right cannot pass on its own.
export async function readLoopFacts(handle) {
  const get = async (route) => {
    const response = await fetch(`${handle.base}${route}`, { headers: handle.headers });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const [state, workshop, perception, graph] = await Promise.all([
    get('/api/state'), get('/api/workshop'), get('/api/perception?limit=20'), get('/api/taskgraph'),
  ]);
  return { state, workshop, perception, graph };
}
