// Test helpers. Every test that writes data uses a fresh directory under the OS
// temp directory. makeTempDataDir refuses anything else, and cleanup removes only
// those directories, so real user data (~/.apex) cannot be touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('APEX_')) env[k] = v;
  }
  return { ...env, ...extra };
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
  const behavior = { reply: 'stub answer', status: 200, delayMs: 0, raw: undefined };
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stub' }] }));
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
          res.writeHead(200);
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
