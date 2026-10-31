// Implementation 001 (Batch O): the runtime conditions around a local model must stay
// distinguishable. Readiness reports what the model listing says and never that inference
// was tested; a reachable server that cannot serve the model is not an outage; and a
// readiness result does not predict the outcome of a real request.
//
// The servers here are local protocol stubs. They show how APEX classifies a response;
// they are not evidence about any real model or real inference.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { makeTempDataDir, cleanup, cleanEnv, runCli, startStubModel } from './helpers.js';
import { main } from '../src/cli.js';
import { createApp } from '../src/app.js';
import { createGateway } from '../src/model/gateway.js';

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
function lastOperation(dataDir) {
  const lines = fs.readFileSync(path.join(dataDir, 'operations.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines.at(-1));
}

async function stubServer(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

describe('O-02/O-03: model runtime states and slow starts are distinct and truthfully reported', () => {
  test('a reachable server that cannot serve the model is not reported as an outage', async () => {
    const dir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    // The server answers the listing request but holds no model at all.
    stub.behavior.modelsRaw = JSON.stringify({ data: [] });
    const env = envFor(dir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'stub' });

    const status = await runCli(['status', '--model'], env);
    assert.equal(status.code, 1, status.stdout + status.stderr);
    assert.match(status.stdout, /unavailable: endpoint lists no model/, status.stdout);
    assert.match(status.stdout, /The endpoint answered but readiness failed/, status.stdout);
    assert.doesNotMatch(status.stdout, /Starting the configured local server/, 'the server is up, so that advice would be wrong');
    assert.match(status.stdout, /no inference was tested/, status.stdout);

    const diag = await runCli(['diagnose', '--model'], env);
    assert.equal(diag.code, 1, diag.stdout + diag.stderr);
    assert.match(diag.stdout, /the endpoint answered, but it could not serve the configured model/, diag.stdout);
    assert.match(diag.stdout, /no inference was tested/, diag.stdout);
    assert.doesNotMatch(diag.stdout, /start the configured local model server/, 'a reachable server is not an outage');
    assert.equal(stub.requests.length, 0, 'a readiness probe sends no completion request');
  });

  test('an Ollama server that is up but missing the model is told apart from an outage', async () => {
    const dir = tempDir();
    const url = await stubServer((req, res) => {
      assert.equal(req.url, '/api/tags');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'some-other-model:latest' }] }));
    });
    const env = envFor(dir, {
      APEX_MODEL_URL: url, APEX_MODEL_PROVIDER: 'ollama', APEX_MODEL_NAME: 'wanted',
    });

    const status = await runCli(['status', '--model'], env);
    assert.equal(status.code, 1, status.stdout + status.stderr);
    assert.match(status.stdout, /model "wanted" is not installed on this Ollama server/, status.stdout);
    assert.match(status.stdout, /The endpoint answered but readiness failed/, status.stdout);

    const diag = await runCli(['diagnose', '--model'], env);
    assert.match(diag.stdout, /the endpoint answered, but it could not serve the configured model/, diag.stdout);
    assert.doesNotMatch(diag.stdout, /start the configured local model server/, 'pulling the model is the fix, not restarting the server');
  });

  test('a model listed by readiness can still fail inference, and keeps its own error code', async () => {
    const dir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.status = 500;
    const env = envFor(dir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'stub', APEX_MODEL_RETRIES: '0' });

    const status = await runCli(['status', '--model'], env);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /available \(model list checked; no inference was run\)/, status.stdout);
    assert.equal(stub.requests.length, 0, 'the readiness check did not infer');

    const asked = await runCli(['ask', 'hello'], env);
    assert.equal(asked.code, 1, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /HTTP_ERROR: endpoint returned HTTP 500/, asked.stdout);
    assert.match(asked.stdout, /No answer has been generated/, asked.stdout);

    const op = lastOperation(dir);
    assert.equal(op.status, 'execution_failed');
    assert.equal(op.errors[0].stage, 'model');
    assert.equal(op.errors[0].code, 'HTTP_ERROR');
    assert.equal(op.model.provider, 'openai');
    assert.deepEqual(op.steps, [], 'a failed inference proposes no action');
  });

  test('an unconfirmed model is not a failure when the request itself succeeds', async () => {
    const dir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.modelsRaw = JSON.stringify({ data: [{ id: 'some-other-model' }] });
    stub.behavior.reply = 'the answer is four';
    const env = envFor(dir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'wanted-model' });

    const status = await runCli(['status', '--model'], env);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /reachable, model not confirmed/, status.stdout);
    assert.equal(stub.requests.length, 0);

    const asked = await runCli(['ask', 'what is two plus two?'], env);
    assert.equal(asked.code, 0, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /Status:    verification_unavailable/, asked.stdout);
    assert.match(asked.stdout, /the answer is four/, asked.stdout);
    assert.doesNotMatch(asked.stdout, /MODEL_NOT_FOUND/, 'a listing gap does not prove the request fails');

    const op = lastOperation(dir);
    assert.equal(op.status, 'verification_unavailable');
    assert.equal(op.model.name, 'wanted-model');
    assert.equal(op.steps.length, 0);
  });

  test('a timeout is its own state: no answer, no invented content, a distinct audit code', async () => {
    const dir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.delayMs = 500;
    const env = envFor(dir, {
      APEX_MODEL_URL: stub.url,
      APEX_MODEL_NAME: 'stub',
      APEX_MODEL_TIMEOUT_MS: '150',
      APEX_MODEL_RETRIES: '0',
    });

    const asked = await runCli(['ask', 'hello'], env);
    assert.equal(asked.code, 1, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /TIMEOUT: no response within 150 ms/, asked.stdout);
    assert.match(asked.stdout, /a first request can be slower while the server loads the model/, asked.stdout);
    assert.match(asked.stdout, /did not resend the request/, asked.stdout);
    assert.match(asked.stdout, /raise APEX_MODEL_TIMEOUT_MS \(100-600000\)/, asked.stdout);
    assert.doesNotMatch(asked.stdout, /retrying this request after the backend is available is safe/, 'a timeout is not an outage');
    assert.match(asked.stdout, /No answer has been generated/, asked.stdout);
    assert.equal(stub.requests.length, 1, 'a timeout is not retried');

    const op = lastOperation(dir);
    assert.equal(op.status, 'execution_failed');
    assert.equal(op.errors[0].code, 'TIMEOUT');
    assert.equal(op.decision, 'refuse_or_block');
    assert.deepEqual(op.steps, []);
  });

  test('a reported model load time is shown for a slow start but never stored as model text', async () => {
    const dir = tempDir();
    let loadNs = 1_500_000_000;
    const url = await stubServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'local:latest' }] }));
        return;
      }
      if (req.url === '/api/chat') {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'local:latest',
          message: { role: 'assistant', content: 'the answer is four' },
          done_reason: 'stop',
          total_duration: loadNs + 400_000_000,
          load_duration: loadNs,
          prompt_eval_duration: 100_000_000,
          eval_duration: 300_000_000,
        }));
        return;
      }
      res.writeHead(404).end();
    });
    const env = envFor(dir, {
      APEX_MODEL_URL: url, APEX_MODEL_PROVIDER: 'ollama', APEX_MODEL_NAME: 'local',
    });

    const cold = await runCli(['ask', 'what is two plus two?'], env);
    assert.equal(cold.code, 0, cold.stdout + cold.stderr);
    assert.match(cold.stdout, /\[The backend reported 1\.5 s of model load time for this answer\.\]/, cold.stdout);

    const modelTurns = fs.readFileSync(path.join(dir, 'conversation.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line)).filter((t) => t.origin === 'model');
    assert.equal(modelTurns.at(-1).text, 'the answer is four', 'the notice is display-only');
    assert.equal(modelTurns.at(-1).text.includes('load time'), false);

    const op = lastOperation(dir);
    assert.equal(op.model.timings.loadMs, 1500);

    // A warm load is ordinary overhead and must not add noise to every answer.
    loadNs = 200_000_000;
    const warm = await runCli(['ask', 'what is two plus two?'], env);
    assert.equal(warm.code, 0, warm.stdout + warm.stderr);
    assert.doesNotMatch(warm.stdout, /model load time/, warm.stdout);
  });
});

describe('O-04: an unusable answer is described from the provider\'s own evidence', () => {
  async function ollamaChat(message, doneReason) {
    const url = await stubServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'local:latest' }] }));
        return;
      }
      if (req.url === '/api/chat') {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'local:latest', message: { role: 'assistant', ...message }, done: true, done_reason: doneReason }));
        return;
      }
      res.writeHead(404).end();
    });
    return url;
  }
  const ollamaEnv = (dataDir, url) => envFor(dataDir, {
    APEX_MODEL_URL: url, APEX_MODEL_PROVIDER: 'ollama', APEX_MODEL_NAME: 'local',
  });
  function turns(dataDir) {
    return fs.readFileSync(path.join(dataDir, 'conversation.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  }

  test('a reasoning-only answer is EMPTY_RESPONSE, names the budget, and never shows reasoning', async () => {
    const dir = tempDir();
    const url = await ollamaChat({ content: '', thinking: 'PRIVATE-CHAIN-OF-THOUGHT' }, 'length');
    const res = await runCli(['ask', 'what is two plus two?'], ollamaEnv(dir, url));

    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /EMPTY_RESPONSE: the model produced reasoning but no final answer, and the provider reported the token limit was reached/, res.stdout);
    assert.match(res.stdout, /raise APEX_MODEL_MAX_TOKENS/, res.stdout);
    assert.match(res.stdout, /adjust the token budget or model/, res.stdout);
    assert.doesNotMatch(res.stdout, /PRIVATE-CHAIN-OF-THOUGHT/, 'reasoning is never output');
    assert.equal(res.stdout.includes('PRIVATE-CHAIN-OF-THOUGHT'), false);

    const op = lastOperation(dir);
    assert.equal(op.errors[0].code, 'EMPTY_RESPONSE');
    assert.equal(fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8').includes('PRIVATE-CHAIN-OF-THOUGHT'), false, 'reasoning is never audited');
    assert.equal(turns(dir).some((t) => t.origin === 'model'), false, 'no model turn is stored for an empty answer');
  });

  test('a token-limit stop with no content names the budget instead of a generic empty answer', async () => {
    const dir = tempDir();
    const url = await ollamaChat({ content: '' }, 'length');
    const res = await runCli(['ask', 'what is two plus two?'], ollamaEnv(dir, url));

    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /the provider reported the token limit was reached before any answer text was produced/, res.stdout);
    assert.doesNotMatch(res.stdout, /produced reasoning/, 'no reasoning was reported, so none is claimed');
  });

  test('an empty answer without a reported cause makes no claim about the budget', async () => {
    const dir = tempDir();
    const url = await ollamaChat({ content: '' }, 'stop');
    const res = await runCli(['ask', 'what is two plus two?'], ollamaEnv(dir, url));

    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /EMPTY_RESPONSE: endpoint returned an empty answer/, res.stdout);
    assert.doesNotMatch(res.stdout, /token limit/, 'a "stop" answer is not evidence of budget exhaustion');
  });

  test('an over-long answer is attributed to APEX\'s size limit, not the token budget', async () => {
    const dir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.raw = JSON.stringify({
      model: 'stub',
      choices: [{ message: { role: 'assistant', content: 'x'.repeat(8100) }, finish_reason: 'stop' }],
    });
    const env = envFor(dir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'stub', APEX_MODEL_RETRIES: '0' });

    const res = await runCli(['ask', 'write a long text'], env);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /cut off at APEX's output-size limit/, res.stdout);
    assert.doesNotMatch(res.stdout, /cut off at the model output limit/, res.stdout);

    const op = lastOperation(dir);
    const truncated = op.errors.find((e) => e.code === 'TRUNCATED');
    assert.equal(truncated.message, 'answer exceeded the output-size limit');
  });
});

describe('O-05: waiting is reported once, truthfully, and only for a model call', () => {
  function captureStream(isTTY) {
    return {
      text: '',
      isTTY,
      write(chunk) {
        this.text += chunk;
        return true;
      },
    };
  }
  async function appWithStub(dir) {
    const stub = await startStubModel();
    stubs.push(stub);
    const gateway = createGateway({ url: stub.url, name: 'stub', timeoutMs: 20000, retries: 0, allowRemote: false });
    return { stub, app: createApp({ dataDir: dir, gateway }) };
  }

  test('one bounded wait line is printed on a terminal, and none without one', async () => {
    const dir = tempDir();
    const { stub, app } = await appWithStub(dir);
    const env = envFor(dir);
    const stdin = { isTTY: false };

    const ttyOut = captureStream(false);
    const ttyErr = captureStream(true);
    const code = await main(['ask', 'hello'], { env, stdout: ttyOut, stderr: ttyErr, stdin, appFactory: () => app });
    assert.equal(code, 0, ttyOut.text + ttyErr.text);
    assert.equal(ttyErr.text, 'Waiting for the model (up to 20 s; no partial output is shown)...\n');
    assert.match(ttyOut.text, /stub answer/);
    assert.equal(stub.requests.length, 1, 'the wait notice does not repeat the request');

    const pipeOut = captureStream(false);
    const pipeErr = captureStream(false);
    const piped = await main(['ask', 'hello'], { env, stdout: pipeOut, stderr: pipeErr, stdin, appFactory: () => app });
    assert.equal(piped, 0, pipeOut.text + pipeErr.text);
    assert.equal(pipeErr.text, '', 'a piped result stays free of display-only noise');
  });

  test('a deterministic request shows no wait line because no model is asked', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const stdout = captureStream(false);
    const stderr = captureStream(true);

    const code = await main(['ask', 'calc 1+1'], {
      env: envFor(dir), stdout, stderr, stdin: { isTTY: false }, appFactory: () => app,
    });
    assert.equal(code, 0, stdout.text + stderr.text);
    assert.match(stdout.text, /Status:    success_verified/);
    assert.equal(stderr.text.includes('Waiting for the model'), false);
  });

  test('a display callback cannot change the request outcome', async () => {
    const dir = tempDir();
    const { app } = await appWithStub(dir);
    const events = [];
    const res = await app.controller.handle('hello', {
      origin: 'user',
      onProgress(event) {
        events.push(event);
        throw new Error('display failed');
      },
    });

    assert.equal(res.status, 'verification_unavailable');
    assert.equal(events.length, 1, 'the notice is emitted once, immediately before the call');
    assert.equal(events[0].stage, 'model');
    assert.equal(events[0].timeoutMs, 20000);
  });
});

describe('O-07: model configuration belongs to one invocation', () => {
  test('a later run without model settings does not inherit or persist them', async () => {
    const dir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);

    const configured = await runCli(['ask', 'hello'], envFor(dir, {
      APEX_MODEL_URL: stub.url,
      APEX_MODEL_NAME: 'stub',
    }));
    assert.equal(configured.code, 0, configured.stdout + configured.stderr);
    assert.equal(stub.requests.length, 1);

    // The same data directory, but no model variables in this process's environment.
    // If the earlier settings had been written anywhere, this run would reuse them.
    const unconfigured = await runCli(['ask', 'hello'], envFor(dir));
    assert.equal(unconfigured.code, 1, unconfigured.stdout + unconfigured.stderr);
    assert.match(unconfigured.stdout, /No inference backend is configured/, unconfigured.stdout);
    assert.equal(stub.requests.length, 1, 'the second run made no model request');
  });
});
