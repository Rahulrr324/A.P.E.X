// T-40 Step 4 (2026-11-22): the fixture the changeset, drift and command-help walk drives.
//
// Same shape as the T-39 fixture, and for the same reason: the milestone is about real files in a real
// directory and a real router behind a real server, so the fixture owns all three. It creates a
// temporary workspace with two files whose bytes are known here, a temporary data directory, an app
// with no model backend, and a UI server with a Bearer token.
//
// Nothing contacts a model, reads the real APEX data directory, or touches the repository's tree.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/app.js';
import { createUiServer } from '../../src/ui/server.js';
import { ModelGateway, NoBackend } from '../../src/model/gateway.js';

export const T40_TOKEN = 'T40-changeset-drift-command-help-token-0123456789';
export const T40_SCHEMA = 'apex.t40.changeset-drift-command-help/1';

// Two files, both real. The `.js` file must pass `node --check`, because the sandbox verifies a
// JavaScript candidate with the real parser; the `.json` file is verified by the JSON parse.
export const T40_GREETING_LIVE = 'export function greet(name) {\n  return "hello " + name;\n}\n';
export const T40_GREETING_NEXT = 'export function greet(name) {\n  return "hello " + name + "!";\n}\nexport const version = 2;\n';
export const T40_DATA_LIVE = '{\n  "version": 1,\n  "name": "apex"\n}\n';
export const T40_DATA_NEXT = '{\n  "version": 2,\n  "name": "apex"\n}\n';
// The edit an editor would make: written by this process, behind the product's back.
export const T40_GREETING_EXTERNAL = 'export function greet(name) {\n  return "edited outside APEX: " + name;\n}\n';

export async function startT40Ui({ token = T40_TOKEN, port = 0 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-t40-e2e-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  const greetingPath = path.join(workspace, 'src', 'greeting.js');
  const dataPath = path.join(workspace, 'src', 'data.json');
  await fsp.writeFile(greetingPath, T40_GREETING_LIVE, 'utf8');
  await fsp.writeFile(dataPath, T40_DATA_LIVE, 'utf8');
  await fsp.writeFile(path.join(workspace, 'README.md'), '# the changeset workspace\n\nTwo files, written by the fixture.\n', 'utf8');

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
    app, ui, root, dataDir, workspace, greetingPath, dataPath, base, token, headers, get, post,
    // Read from disk every time. A cached value would let the walk assert a claim about the file
    // without ever looking at it.
    readGreeting: () => fs.readFileSync(greetingPath, 'utf8'),
    readData: () => fs.readFileSync(dataPath, 'utf8'),
    // The ledger, parsed. Every phase that claims "nothing was recorded" reads this rather than
    // trusting a response field.
    ledger: () => {
      const file = path.join(dataDir, 'workshop-applies.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    async stop() { await stop(); },
  };
}
