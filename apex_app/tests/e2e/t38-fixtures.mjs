// T-38 Step 4 (2026-11-21): the fixture the values/workspace/trace browser walk drives.
//
// It starts a real server against a temporary data directory and a real workspace directory that is
// created for the walk, so the files the inspector lists are files this fixture wrote and the digests
// it reports can be recomputed from disk. Nothing here contacts a model, reads a real APEX data
// directory, or touches the repository's own tree.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/app.js';
import { createUiServer } from '../../src/ui/server.js';
import { ModelGateway, NoBackend } from '../../src/model/gateway.js';

export const T38_TOKEN = 'T38-values-workspace-trace-token-0123456789';
export const T38_SCHEMA = 'apex.t38.values-workspace-trace/1';

// The workspace the walk inspects. Two real files with known content, so the bytes, the line count
// and the SHA-256 the panel shows can all be recomputed here rather than taken on trust.
export const T38_WORKSPACE_FILES = {
  'src/greeting.js': 'export function greet(name) {\n  return `hello ${name}`;\n}\n',
  'README.md': '# the walk workspace\n\nTwo files, written by the fixture.\n',
  'src/data.json': '{"ready":true}\n',
};

// A valid replacement and a broken one, both against the same real file. The broken one must fail a
// real parse and must be refused promotion; the valid one must pass and then promote through the ECP.
export const T38_VALID_CANDIDATE = 'export function greet(name) {\n  return `hello ${name}!`;\n}\nexport const version = 2;\n';
export const T38_BROKEN_CANDIDATE = 'export function greet(name) {\n  return `hello ${name};\n}\n';

export async function startT38Ui({ token = T38_TOKEN, port = 0 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-t38-e2e-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  for (const [relative, content] of Object.entries(T38_WORKSPACE_FILES)) {
    await fsp.writeFile(path.join(workspace, relative), content, 'utf8');
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

  // A real cognition run through the governed capability, so the Memory Timeline has a chain to
  // assemble. The walk then reads that chain in the browser.
  const run = await post('/api/cognition/run', { intent: 'remember that the launch moved to friday' });
  if (run.status !== 200) {
    await stop();
    throw new Error(`the fixture could not start a cognition run: ${run.status} ${JSON.stringify(run.body).slice(0, 200)}`);
  }
  // The route answers with the run it recorded, so the identity is read from that record rather than
  // from a field this fixture hopes for.
  const runId = run.body?.run?.runId ?? null;
  const taskId = run.body?.run?.taskId ?? null;

  // A Council deliberation in natural language, which is what Step 1's resolver exists to make work.
  const deliberation = await post('/api/council/deliberate', { objective: 'run the neural step' });

  // A file verification, so the trace and the workshop panel both have a real record to show.
  const staged = await post('/api/workshop/stage', {
    relativePath: 'src/greeting.js',
    proposedContent: T38_VALID_CANDIDATE,
    rationale: 'the fixture wants a verified candidate on the record',
  });
  const candidateId = staged.body?.candidateId ?? null;
  const verification = candidateId
    ? await post('/api/workshop/verify-file', { candidateId })
    : { status: 0, body: null };

  return {
    app,
    ui,
    root,
    dataDir,
    workspace,
    base,
    token,
    headers,
    get,
    post,
    runId,
    taskId,
    deliberation,
    candidateId,
    verification,
    async stop() {
      await stop();
    },
  };
}
