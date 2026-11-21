// T-35 Step 4 (2026-11-19): the fixture the step-down / handoff / doctor browser walk drives.
//
// The shipped app and UI server run in this process against an isolated temporary data directory. No
// model backend is configured and none is contacted; no real APEX data directory is read or written.
//
// What the walk needs to be real rather than staged:
//
//   * a temporary git repository with a committed HEAD, so the workspace sensor and the doctor's
//     workspace check read an actual repository with git itself - and a `perception.sense_host` run,
//     so the sensor has a recorded reading to point at;
//   * two enrolled devices, because a handoff needs a source and a different target and the form
//     offers only trusted devices;
//   * one real task, so the envelope can name a mission that exists rather than being refused by the
//     service's target lookup.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createApp } from '../../src/app.js';
import { createUiServer } from '../../src/ui/server.js';
import { ModelGateway, NoBackend } from '../../src/model/gateway.js';

export const T35_TOKEN = 'T35-stepdown-handoff-token-0123456789';
export const T35_SCHEMA = 'apex.t35.stepdown-handoff-doctor/1';

export function createWorkspace(root) {
  const workspace = path.join(root, 'workspace');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', workspace], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'config', 'user.email', 't35@apex.invalid'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'config', 'user.name', 'T-35 fixture'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(workspace, 'handoff.txt'), 'the mission the owner is handing over\n');
  execFileSync('git', ['-C', workspace, 'add', 'handoff.txt'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'T-35 fixture baseline'], { stdio: 'ignore' });
  return workspace;
}

export async function startT35Ui({ token = T35_TOKEN, port = 0 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-t35-e2e-'));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  const workspace = createWorkspace(root);
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

  const source = await app.deviceTrust.enroll({ origin: 'user', label: 'owner laptop', deviceId: 'device-t35-laptop' });
  const target = await app.deviceTrust.enroll({ origin: 'user', label: 'owner tablet', deviceId: 'device-t35-tablet' });
  await app.taskStore.createTask({
    taskId: 'task-t35-handoff',
    goal: 'finish the T-35 build on the tablet',
    origin: 'user',
    planner: 'deterministic',
    reason: 'T-35 browser fixture',
    steps: [{ id: 'n1', description: 'read the handoff note', action: 'filesystem.list', permission: 'read', input: { path: '.' }, dependsOn: [] }],
  });
  const sense = await app.controller.runAction('perception.sense_host', { reason: 'T-35 fixture reading' }, 'user', 'op-t35-fixture');

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
    workspace,
    base,
    port: started.port,
    token,
    headers,
    devices: { source: source.deviceId, target: target.deviceId },
    taskId: 'task-t35-handoff',
    sensed: { outcome: sense.outcome, summary: sense.summary },
    get,
    post,
    doctor: async () => (await get('/api/system/doctor')).body,
    presence: async () => (await get('/api/presence')).body,
    state: async () => (await get('/api/state')).body,
    async stageHandoff(overrides = {}) {
      return post('/api/presence/handoffs', {
        sourceDeviceId: source.deviceId,
        targetDeviceId: target.deviceId,
        targetView: 'tasks',
        taskId: 'task-t35-handoff',
        note: 'picked up from the laptop',
        ...overrides,
      });
    },
    async stop() {
      await ui.stop().catch(() => {});
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}
