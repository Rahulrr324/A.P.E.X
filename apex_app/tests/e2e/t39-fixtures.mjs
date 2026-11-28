// T-39 Step 4 (2026-11-22): the fixture the apply/rollback browser walk drives.
//
// The whole point of this milestone is that a file in a real directory changes, so the fixture owns a
// real directory: a temporary workspace created for the walk, with one module in it whose bytes are
// known here and can be recomputed from disk. Nothing contacts a model, reads a real APEX data
// directory, or touches the repository's own tree.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/app.js';
import { createUiServer } from '../../src/ui/server.js';
import { ModelGateway, NoBackend } from '../../src/model/gateway.js';

export const T39_TOKEN = 'T39-workshop-apply-rollback-token-0123456789';
export const T39_SCHEMA = 'apex.t39.workshop-apply-rollback/1';

// The live module the walk applies over, and the two candidates. The applied candidate must pass a
// real `node --check`; the second is verified against the same file and then made stale by an
// external edit, which is what the drift refusal is for.
export const T39_LIVE_SOURCE = 'export function greet(name) {\n  return `hello ${name}`;\n}\n';
export const T39_CANDIDATE_SOURCE = 'export function greet(name) {\n  return `hello ${name}!`;\n}\nexport const version = 2;\n';
export const T39_SECOND_SOURCE = 'export function greet(name) {\n  return `goodbye ${name}`;\n}\n';
export const T39_EXTERNAL_EDIT = 'export function greet(name) {\n  return `hello ${name}, edited outside APEX`;\n}\n';

export async function startT39Ui({ token = T39_TOKEN, port = 0 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-t39-e2e-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  const livePath = path.join(workspace, 'src', 'greeting.js');
  await fsp.writeFile(livePath, T39_LIVE_SOURCE, 'utf8');
  await fsp.writeFile(path.join(workspace, 'README.md'), '# the apply workspace\n\nOne module, written by the fixture.\n', 'utf8');

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
    app, ui, root, dataDir, workspace, livePath, base, token, headers, get, post,
    // The file's bytes as the fixture last wrote or observed them. A helper rather than a cached
    // value: the walk reads the file after every step precisely because the value is what matters.
    readLive: () => fs.readFileSync(livePath, 'utf8'),
    async stop() { await stop(); },
  };
}
