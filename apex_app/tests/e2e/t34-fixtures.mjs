// T-34 Step 4 (2026-11-19): the fixture the mission/DAG browser walk drives.
//
// Same shape as the T-33 fixture - the shipped app and UI server in this process, an isolated
// temporary data directory, no model backend - with what a fan-out/fan-in mission needs:
//
//   * a real temporary git workspace, so the mission's `perception.sense_host` node reads an actual
//     repository with git itself instead of being handed a value;
//   * one workshop artifact, composed through the workshop service, so the mission's join has a real
//     artifact to verify;
//   * the `audit_and_stage` mission itself, started through the HTTP route, which leaves the deck on a
//     five-node graph with two gated nodes and one branch still to run;
//   * a second, single-node gated task, so the task selector has two real tasks to switch between.
//
// Nothing here reads or writes a real APEX data directory, contacts a model, or invents a value the
// product would not produce.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createApp } from '../../src/app.js';
import { createUiServer } from '../../src/ui/server.js';
import { ModelGateway, NoBackend } from '../../src/model/gateway.js';

export const T34_TOKEN = 'T34-mission-dag-token-0123456789';
export const T34_SCHEMA = 'apex.t34.mission-dag/1';

const DESIGN = {
  title: 'T-34 mission design',
  domain: 'plan',
  components: [
    { id: 'supply', kind: 'resource', supply: 10, demand: 0, cost: 1 },
    { id: 'load', kind: 'service', supply: 0, demand: 5, cost: 1 },
  ],
  connections: [{ from: 'supply', to: 'load' }],
  budget: { total: 4 },
};

// A repository with one committed file and one uncommitted change, so the mission's host-sensing
// node reads a tree that is genuinely dirty. `git` is used exactly as the sensor uses it.
export function createMissionWorkspace(root) {
  const workspace = path.join(root, 'workspace');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', workspace], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'config', 'user.email', 't34@apex.invalid'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'config', 'user.name', 'T-34 fixture'], { stdio: 'ignore' });
  const file = path.join(workspace, 'mission.txt');
  fs.writeFileSync(file, 'committed\n');
  execFileSync('git', ['-C', workspace, 'add', 'mission.txt'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'T-34 fixture baseline'], { stdio: 'ignore' });
  fs.writeFileSync(file, 'committed\nuncommitted\n');
  return workspace;
}

export async function startT34Ui({ token = T34_TOKEN, port = 0 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-t34-mission-'));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  const workspace = createMissionWorkspace(root);
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
  const seeded = await seed(app, { base, headers });
  return {
    app, ui, root, dataDir, workspace, base, port: started.port, token, headers, seed: seeded,
    async graph(taskId = null) {
      const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : '';
      const response = await fetch(`${base}/api/taskgraph${query}`, { headers });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    async task(taskId) {
      return app.taskStore.get(taskId);
    },
    async stop() {
      await ui.stop().catch(() => {});
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function seed(app, { base, headers }) {
  // T-34 Step 2: a prior episode with the mission's own subject. The mission run below therefore
  // recalls it as a candidate association, and the walk can assert the badge against a real record
  // instead of a fabricated one.
  const priorRun = await fetch(`${base}/api/cognition/run`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ intent: 'audit the host and verify the staged artifact, as done before', action: 'memory.search', input: { query: 'audit the host' } }),
  }).then((response) => response.json()).catch(() => null);
  if (!priorRun?.run?.runId) throw new Error(`the T-34 fixture could not record the prior episode: ${JSON.stringify(priorRun)}`);

  const composed = await app.workshop.compose(DESIGN);
  const artifactId = composed.artifact?.artifactId ?? null;
  if (!artifactId) throw new Error('the T-34 fixture could not stage a workshop artifact');

  // The mission, started exactly as the deck's own control would start it.
  const missionResponse = await fetch(`${base}/api/cognition/run`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ intent: 'audit the host and verify the staged artifact', mission: 'audit_and_stage', artifactId }),
  });
  const missionBody = await missionResponse.json().catch(() => null);
  if (!missionResponse.ok || !missionBody?.run) {
    throw new Error(`the T-34 fixture could not start the mission: ${missionResponse.status} ${JSON.stringify(missionBody)}`);
  }

  // A second, single-node task that stops at its own gate, so the selector has two real tasks.
  const singleResponse = await fetch(`${base}/api/cognition/run`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ intent: 'store the T-34 selector marker in memory', action: 'memory.add', input: { content: 'the T-34 selector marker' } }),
  });
  const singleBody = await singleResponse.json().catch(() => null);
  if (!singleResponse.ok || !singleBody?.run) {
    throw new Error(`the T-34 fixture could not start the second task: ${singleResponse.status} ${JSON.stringify(singleBody)}`);
  }

  return {
    artifactId,
    priorRunId: priorRun.run.runId,
    missionRunId: missionBody.run.runId,
    missionTaskId: missionBody.run.taskId,
    missionStatus: missionBody.run.status,
    singleRunId: singleBody.run.runId,
    singleTaskId: singleBody.run.taskId,
    singleStatus: singleBody.run.status,
  };
}

// What the walk is allowed to claim afterwards: the mirrored state, read from the same routes the
// page reads, so a screenshot that looks right cannot pass on its own.
export async function readMissionFacts(handle) {
  const get = async (route) => {
    const response = await fetch(`${handle.base}${route}`, { headers: handle.headers });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const [graph, missionGraph, runs] = await Promise.all([
    get('/api/taskgraph'),
    get(`/api/taskgraph?taskId=${encodeURIComponent(handle.seed.missionTaskId)}`),
    get('/api/cognition/runs?limit=10'),
  ]);
  return { graph, missionGraph, runs };
}
