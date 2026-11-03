// Test helpers. Every test that writes data uses a fresh directory under the OS
// temp directory. makeTempDataDir refuses anything else, and cleanup removes only
// those directories, so real user data (~/.apex) cannot be touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ModelGateway } from '../src/model/gateway.js';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = fs.realpathSync(os.tmpdir());

export function makeTempDataDir() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'apex-test-'));
  if (!fs.realpathSync(dir).startsWith(TMP_ROOT)) throw new Error('temp directory escaped the temp root');
  return dir;
}

export function cleanup(dir) {
  if (!dir) return;
  const real = fs.realpathSync(dir);
  if (!real.startsWith(TMP_ROOT) || !path.basename(real).startsWith('apex-test-')) {
    throw new Error(`refusing to remove non-test directory: ${real}`);
  }
  fs.rmSync(real, { recursive: true, force: true });
}

// Environment for child processes: APEX_* settings are removed so a developer's
// own configuration cannot leak into tests. Callers add what they need.
//
// Isolation is part of the harness rather than a per-test choice, so every child APEX process
// must name a data directory inside the OS temporary directory. A test that forgets
// APEX_DATA_DIR then exits 2 at configuration instead of falling back to ~/.apex and writing
// real audit records into the developer's store. A test that needs the unisolated behaviour
// says so on purpose with APEX_DATA_ISOLATED: '0'.
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('APEX_')) env[k] = v;
  }
  return { ...env, APEX_DATA_ISOLATED: '1', ...extra };
}

export function runCli(args, env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(APP_ROOT, 'bin', 'apex.js'), ...args],
      { env, timeout: 60000, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

// Local stub of an OpenAI-compatible endpoint. Behaviour is changed per test
// through `behavior`. Every chat request body is recorded in `requests`.
export async function startStubModel() {
  const behavior = {
    reply: 'stub answer', status: 200, delayMs: 0, raw: undefined, modelsRaw: undefined, contentType: 'application/json',
  };
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(behavior.modelsRaw ?? JSON.stringify({ data: [{ id: 'stub' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body);
        requests.push(parsed);
        if (behavior.delayMs) await new Promise((r) => setTimeout(r, behavior.delayMs));
        if (behavior.status !== 200) {
          res.writeHead(behavior.status);
          res.end('stub failure');
          return;
        }
        if (behavior.raw !== undefined) {
          res.writeHead(200, { 'content-type': behavior.contentType });
          res.end(behavior.raw);
          return;
        }
        const text = typeof behavior.reply === 'function' ? behavior.reply(parsed) : behavior.reply;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    behavior,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

// Returns a port on which nothing is listening (for the unreachable case).
export async function closedPortUrl() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

// ---- task test doubles -------------------------------------------------------
// Shared by the suites that drive tasks (task-history, task-resolution), so a step can
// be put into each state a summary or an explanation has to describe without inventing
// any state. TEST DOUBLES: they report what they did, and are not evidence about a real
// action, a real model, or real inference.

// Three read actions and one write. Every execution is pushed into `sink`, which is how a
// test shows that a step ran once, twice, or not at all.
export function makeFakeTaskActions(sink) {
  const ok = {
    name: 'test.ok',
    description: 'test-only read that always verifies',
    inputHint: '{"tag":"text"}',
    permission: 'read',
    origins: ['user', 'model'],
    validate: (input) => ({ tag: String(input?.tag ?? 'x') }),
    async execute(_ctx, input) {
      sink.push(input.tag);
      return { summary: `read ${input.tag}`, data: { tag: input.tag }, display: `read ${input.tag} (a value that must never reach history)` };
    },
    async verify() { return { ok: true, detail: 'the sink holds the read' }; },
  };
  const failing = {
    name: 'test.fail',
    description: 'test-only read that always fails to execute',
    inputHint: '{}',
    permission: 'read',
    origins: ['user', 'model'],
    validate: (input) => input ?? {},
    async execute() { throw new Error('the sensor did not answer'); },
    verify: null,
  };
  const unverified = {
    name: 'test.unverified',
    description: 'test-only read whose result cannot be independently checked',
    inputHint: '{"tag":"text"}',
    permission: 'read',
    origins: ['user', 'model'],
    validate: (input) => ({ tag: String(input?.tag ?? 'u') }),
    async execute(_ctx, input) {
      sink.push(input.tag);
      return { summary: `uncheckable read ${input.tag}`, data: { tag: input.tag } };
    },
    // No independent check is possible, so the verifier reports it as unavailable.
    async verify() { return null; },
  };
  // A write a model can propose but never run on its own authority: the runner holds it at
  // awaiting_approval, which is the state an approval question has to describe.
  const writing = {
    name: 'test.write',
    description: 'test-only write action that waits for approval',
    inputHint: '{"tag":"text"}',
    permission: 'write',
    origins: ['user'],
    validate: (input) => ({ tag: String(input?.tag ?? 'w') }),
    async execute(_ctx, input) {
      sink.push(`write:${input.tag}`);
      return { summary: `wrote ${input.tag}`, data: { tag: input.tag } };
    },
    async verify() { return { ok: true, detail: 'the sink holds the write' }; },
  };
  return [ok, failing, unverified, writing];
}

// TEST DOUBLE: a plan gateway that returns fixed JSON. It shows how a reply is handled,
// not what a model says.
export function makePlanGateway(steps) {
  const text = JSON.stringify({ steps });
  const backend = {
    name: 'test-double',
    provider: 'test-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'test-double', endpoint: 'test-double', model: 'test-double' }),
    health: async () => ({ available: true, detail: 'test double' }),
    complete: async () => ({
      ok: true, backend: 'test-double', provider: 'test-double', model: 'test-double',
      text, finishReason: 'stop', truncated: false, latencyMs: 0,
    }),
  };
  return new ModelGateway({ backend });
}

export function taskStep(id, action, dependsOn = [], input = { tag: id }) {
  return { id, description: `step ${id}`, action, input, depends_on: dependsOn };
}

// A process id that stays unused for the duration of a test. A pid taken from a process
// that has just exited is not stable: Windows returns freed process ids to the allocator
// immediately, so a later child in the same test (including the CLI under test) can be
// assigned the same number. A dead lock holder would then look alive, and the lock would
// be refused as "in use" for no real reason. Process ids are assigned in increasing order
// from boot, so a value near the top of the 31-bit range cannot be reached by the
// allocator during a test. Windows ids are multiples of four, so this value keeps that
// shape as well.
export const DEAD_PID = 0x7ffffffc;

export function deadPid() {
  let alive = false;
  try {
    process.kill(DEAD_PID, 0);
    alive = true;
  } catch (err) {
    alive = err?.code === 'EPERM';
  }
  if (alive) throw new Error(`test fixture pid ${DEAD_PID} is in use; a stable dead pid cannot be assumed`);
  return DEAD_PID;
}

// Rebinds the holder pid of a lock or takeover-token file left by a process the caller has
// already confirmed dead. Later lock checks then do not depend on the operating system not
// having reused the number. The original pid is checked first, so the file is still proven
// to be that process's own record before only the pid field is changed.
export function rebindDeadHolder(file, expectedPid) {
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (body.pid !== expectedPid) {
    throw new Error(`${path.basename(file)} names pid ${body.pid}, not the expected dead holder ${expectedPid}`);
  }
  const next = JSON.stringify({ ...body, pid: deadPid() });
  fs.writeFileSync(file, next);
  return next;
}
