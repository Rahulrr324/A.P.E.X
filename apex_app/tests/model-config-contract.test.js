// Implementation 102: the model endpoint, model identifier, timeout, and request limits
// are configuration, and a configuration mistake must be distinguishable from an endpoint
// failure and from a model-availability failure. Readiness output may report what the
// model list says; it must never imply that inference was tested.
//
// The model servers here are local protocol stubs. They show how APEX classifies an
// answer; they are not evidence about any real model or real inference.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { makeTempDataDir, cleanup, cleanEnv, runCli, startStubModel, closedPortUrl } from './helpers.js';

const dirs = [];
const stubs = [];
const servers = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => {
  for (const s of stubs) await s.close();
  for (const s of servers) await new Promise((resolve) => { s.closeAllConnections?.(); s.close(resolve); });
});

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }
function envFor(dataDir, extra = {}) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir, ...extra });
}

async function stubServer(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

describe('102: model configuration is validated before a request is attempted', () => {
  test('missing configuration is a supported state, not a failed inference', async () => {
    const dir = tempDir();
    const env = envFor(dir);

    const status = await runCli(['status'], env);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /Model backend: none configured/, status.stdout);
    assert.match(status.stdout, /Non-model functions are available/, status.stdout);

    const asked = await runCli(['ask', 'explain photosynthesis'], env);
    assert.equal(asked.code, 1, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /No inference backend is configured/, asked.stdout);
    assert.match(asked.stdout, /Retrying this request will not produce an answer until a model is configured/, asked.stdout);

    const help = await runCli(['help'], env);
    assert.equal(help.code, 0, help.stdout + help.stderr);
    assert.match(help.stdout, /status \[--model\][^\n]*no inference/, help.stdout);
    assert.match(help.stdout, /diagnose \[--model\][^\n]*no inference/, help.stdout);
  });

  test('malformed endpoint, model name, timeout, and limit values exit 2 before any store is created', async () => {
    const cases = [
      ['APEX_MODEL_URL', 'http://127.0.0.1:11434/v1/chat/completions', /must be the server base URL, not a chat endpoint/],
      ['APEX_MODEL_URL', 'http://127.0.0.1:11434/api/chat', /must be the server base URL, not a chat endpoint/],
      ['APEX_MODEL_NAME', 'wanted\nmodel', /without control characters or line breaks/],
      ['APEX_MODEL_NAME', 'm'.repeat(201), /at most 200 characters/],
      ['APEX_MODEL_TIMEOUT_MS', '0', /must be between 100 and 600000/],
      ['APEX_MODEL_MAX_TOKENS', '9000', /must be between 1 and 8192/],
    ];
    for (const [key, value, expected] of cases) {
      const root = tempDir();
      const dataDir = path.join(root, 'data');
      const res = await runCli(['status'], envFor(dataDir, {
        APEX_MODEL_URL: 'http://127.0.0.1:11434',
        ...{ [key]: value },
      }));
      assert.equal(res.code, 2, `${key} must be a configuration error: ${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /^configuration error: /, `${key}: ${res.stderr}`);
      assert.match(res.stderr, expected, `${key}: ${res.stderr}`);
      assert.match(res.stderr, /No data was read or changed/, `${key}: ${res.stderr}`);
      assert.equal(fs.existsSync(dataDir), false, `${key} created the data directory`);
    }
  });

  test('an unreachable endpoint is an endpoint failure (exit 1), never a configuration error', async () => {
    const dir = tempDir();
    const url = await closedPortUrl();
    const env = envFor(dir, { APEX_MODEL_URL: url, APEX_MODEL_NAME: 'local', APEX_MODEL_RETRIES: '0' });

    const asked = await runCli(['ask', 'hello'], env);
    assert.equal(asked.code, 1, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /UNREACHABLE: could not reach the endpoint/, asked.stdout);

    const auditBefore = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8');
    const status = await runCli(['status', '--model'], env);
    assert.equal(status.code, 1, status.stdout + status.stderr);
    assert.match(status.stdout, /Model backend: .* - unavailable: could not reach the endpoint/, status.stdout);
    assert.match(status.stdout, /Local integrity: no defects found; the model backend is unavailable/, status.stdout);
    assert.match(status.stdout, /no inference was tested/, status.stdout);
    assert.equal(/configuration error/.test(status.stderr), false, status.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8'), auditBefore, 'a readiness probe appends no audit record');
  });

  test('a configured model missing from the listing is unconfirmed, while the listing itself is not inference', async () => {
    const dir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.modelsRaw = JSON.stringify({ data: [{ id: 'some-other-model' }] });
    const env = envFor(dir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'wanted-model' });

    const status = await runCli(['status', '--model'], env);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /reachable, model not confirmed:/, status.stdout);
    assert.match(status.stdout, /does not include configured model "wanted-model"/, status.stdout);
    assert.match(status.stdout, /no inference was run/, status.stdout);

    const diag = await runCli(['diagnose', '--model'], env);
    assert.equal(diag.code, 0, diag.stdout + diag.stderr);
    assert.match(diag.stdout, /Model: reachable but not confirmed/, diag.stdout);
    assert.match(diag.stdout, /unconfirmed, not a failure, and no inference was run/, diag.stdout);
    assert.equal(stub.requests.length, 0, 'a readiness probe sends no completion request');
  });

  test('a reachable endpoint that does not serve the configured model is MODEL_NOT_FOUND, not an outage', async () => {
    const dir = tempDir();
    const url = await stubServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'wanted-model' }] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model "wanted-model" not found' } }));
    });
    const env = envFor(dir, { APEX_MODEL_URL: url, APEX_MODEL_NAME: 'wanted-model', APEX_MODEL_RETRIES: '0' });

    const asked = await runCli(['ask', 'hello'], env);
    assert.equal(asked.code, 1, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /MODEL_NOT_FOUND: model "wanted-model" was not found by the endpoint/, asked.stdout);
    assert.match(asked.stdout, /Correct APEX_MODEL_NAME before retrying/, asked.stdout);
    assert.doesNotMatch(asked.stdout, /HTTP_ERROR/, 'a model-name mismatch is not reported as a generic endpoint error');
    assert.doesNotMatch(asked.stdout, /after the backend is available/, 'the backend is reachable, so that advice would be wrong');

    // The listing says the model exists; a readiness probe is still only a listing check.
    const status = await runCli(['status', '--model'], env);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /available \(model list checked; no inference was run\)/, status.stdout);
  });

  test('a 404 that does not name a model remains an endpoint/path failure', async () => {
    const dir = tempDir();
    const url = await stubServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'local' }] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
    });
    const asked = await runCli(['ask', 'hello'], envFor(dir, {
      APEX_MODEL_URL: url, APEX_MODEL_NAME: 'local', APEX_MODEL_RETRIES: '0',
    }));
    assert.equal(asked.code, 1, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /HTTP_ERROR: endpoint returned HTTP 404: Not Found/, asked.stdout);
    assert.doesNotMatch(asked.stdout, /MODEL_NOT_FOUND/, 'no model-name problem is claimed without evidence');
  });

  test('timeout and token limits are loaded, shown, and applied to the request body', async () => {
    const dir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    const env = envFor(dir, {
      APEX_MODEL_URL: stub.url,
      APEX_MODEL_NAME: 'stub',
      APEX_MODEL_TIMEOUT_MS: '1500',
      APEX_MODEL_MAX_TOKENS: '64',
      APEX_MODEL_RETRIES: '0',
    });

    const diag = await runCli(['diagnose', '--model'], env);
    assert.equal(diag.code, 0, diag.stdout + diag.stderr);
    assert.match(diag.stdout, /timeout 1500 ms; max 64 tokens; retries 0/, diag.stdout);
    assert.match(diag.stdout, /model list only - no inference was run/, diag.stdout);

    const asked = await runCli(['ask', 'what is the capital of France?'], env);
    assert.equal(asked.code, 0, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /Status:    verification_unavailable/, asked.stdout);
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].model, 'stub', 'the configured model id is sent verbatim');
    assert.equal(stub.requests[0].max_tokens, 64, 'the configured token limit is applied');
  });
});
