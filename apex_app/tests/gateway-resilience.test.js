// Implementation 069: the gateway under failure, exercised through local stand-in
// servers and the real controller.
//
// WHAT IS A STUB AND WHAT IS REAL: every server below is a loopback fixture that speaks
// the OpenAI-compatible protocol. It returns bytes chosen by the test. No inference was
// run, no model was consulted, and nothing here says what a real model would answer, how
// long it would take, or whether it would obey the proposal format. The gateway, timeout
// and retry handling, proposal parsing, the action registry's authorization decision, the
// executor, the verifiers and the operation audit are the real implementations.
//
// Coverage of the other failure classes is in the suites named here, so this file does not
// duplicate them: timeout and late responses (model-protocol.test.js), malformed JSON,
// empty answers, 200 provider error envelopes, truncated output and unknown Ollama models
// (model-protocol.test.js), timeout-is-never-retried end to end (integration.test.js), and
// the planner's rejections (model-workflow.test.js). What was missing is added here: a
// refused request's detail, retry exhaustion on dropped connections, and proof that a
// retry cannot duplicate a read action or turn a denied write into an executed one.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { createGateway } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const servers = [];
const dirs = [];
after(async () => {
  for (const s of servers) await new Promise((resolve) => s.close(resolve));
  while (dirs.length) cleanup(dirs.pop());
});

function rawServer(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, body, res));
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const answer = (res, content) => json(res, 200, { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

function appOn(gateway) {
  const dataDir = makeTempDataDir();
  dirs.push(dataDir);
  return { dataDir, ...createApp({ dataDir, gateway }) };
}

const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)) : []);
const operationsOf = (dir) => readJsonl(path.join(dir, 'operations.jsonl'));

describe('069: gateway failures and retries, against local stand-in servers', () => {
  test('a refused request is a bounded, redacted HTTP failure, never an answer', async () => {
    const url = await rawServer((req, body, res) => {
      if (req.method === 'GET') return json(res, 200, { data: [] });
      json(res, 403, { error: { message: `forbidden for credential sk-live-${'a'.repeat(80)} and more text that must not be echoed in full` } });
    });
    const gw = createGateway({ url, name: 'stub', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'HTTP_ERROR');
    assert.match(res.error.message, /HTTP 403/);
    assert.equal(res.error.message.includes('sk-live'), false, 'a credential-looking detail is redacted');
    assert.equal(res.error.message.length <= 220, true, `the detail stays bounded, got ${res.error.message.length}`);
    assert.equal(res.text, undefined);
  });

  test('a connection dropped on every attempt is retried to exhaustion and yields nothing', async () => {
    let requests = 0;
    const url = await rawServer((req, body, res) => {
      if (req.method === 'GET') return json(res, 200, { data: [] });
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
      res.write('{"choices":[{"message":{"content":"partial');
      setTimeout(() => req.socket.destroy(), 10);
    });
    const gateway = createGateway({ url, name: 'stub', timeoutMs: 5000, retries: 2, allowRemote: false });
    const app = appOn(gateway);
    const res = await app.controller.handle('what is 123 times 456?');
    assert.equal(requests, 3, 'one attempt plus the configured two retries, then it stops');
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /The model backend did not produce an answer \(INTERRUPTED: the connection was interrupted while reading the response\)/);
    const op = operationsOf(app.dataDir).at(-1);
    assert.equal(op.capability, 'model.answer');
    assert.deepEqual(op.steps, [], 'no action was considered from a partial response');
    assert.equal(op.status, Outcome.EXECUTION_FAILED);
    assert.equal((await app.memory.list({ limit: 50 })).length, 0);
  });

  test('a retry after an interrupted read executes that read once, under the same authorization', async () => {
    const prompts = [];
    let requests = 0;
    const url = await rawServer((req, body, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') return json(res, 200, { data: [{ id: 'stub' }] });
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      requests += 1;
      prompts.push(JSON.parse(body));
      if (requests === 1) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
        res.write('{"choices":[{"message":{"content":"partial');
        setTimeout(() => req.socket.destroy(), 10);
        return;
      }
      answer(res, 'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"123*456"}}\nI suggest the product.');
    });
    const gateway = createGateway({ url, name: 'stub', timeoutMs: 5000, retries: 1, allowRemote: false });
    const app = appOn(gateway);
    const res = await app.controller.handle('what is 123 times 456?');

    assert.equal(requests, 2, 'the interrupted attempt was repeated once');
    assert.deepEqual(prompts[1].messages, prompts[0].messages, 'the retry resends the same prompt, not a new request');
    assert.match(res.display, /= 56088/, 'the value comes from the executed action');
    const op = operationsOf(app.dataDir).at(-1);
    assert.equal(op.steps.length, 1, 'exactly one action was authorized and executed');
    assert.equal(op.steps[0].action, 'calc.evaluate');
    assert.equal(op.steps[0].origin, 'model');
    assert.equal(op.steps[0].authorization.decision, 'allow');
    assert.equal(op.steps[0].execution.status, 'ok');
    assert.equal(op.steps[0].verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(operationsOf(app.dataDir).length, 1, 'the retried request produced one operation with one action, not two');
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE, 'the model prose around it is still unverified');
  });

  test('a retry cannot turn a denied write into an executed one', async () => {
    let requests = 0;
    const url = await rawServer((req, body, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') return json(res, 200, { data: [{ id: 'stub' }] });
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      requests += 1;
      if (requests === 1) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
        res.write('{"choices":[{"message":{"content":"partial');
        setTimeout(() => req.socket.destroy(), 10);
        return;
      }
      answer(res, 'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the model wrote this"}}\nI have saved it.');
    });
    const gateway = createGateway({ url, name: 'stub', timeoutMs: 5000, retries: 1, allowRemote: false });
    const app = appOn(gateway);
    const res = await app.controller.handle('what should I keep in mind about the sky?');

    assert.equal(requests, 2);
    const op = operationsOf(app.dataDir).at(-1);
    assert.equal(op.steps.length, 1);
    assert.equal(op.steps[0].action, 'memory.add');
    assert.equal(op.steps[0].authorization.decision, 'deny', 'the model origin receives no write authority');
    assert.equal(op.steps[0].execution.status, 'not_run');
    assert.equal(op.steps[0].outcome, Outcome.ACTION_DENIED);
    assert.equal((await app.memory.list({ limit: 50 })).length, 0, 'a retried proposal cannot write');
    assert.match(String(res.display), /did not execute a proposed action: denied/);
  });

  test('an oversized body is refused while it is being read, not only after it ends', async () => {
    const chunk = 'x'.repeat(64 * 1024);
    let sent = 0;
    let closed = false;
    const url = await rawServer((req, body, res) => {
      if (req.method === 'GET') { res.writeHead(200); res.end('{}'); return; }
      res.on('close', () => { closed = true; });
      res.writeHead(200, { 'content-type': 'application/json' });
      const pump = () => {
        if (res.destroyed || sent > 1_200_000) return; // never end: the limit has to stop it
        sent += chunk.length;
        res.write(chunk, () => setTimeout(pump, 2));
      };
      pump();
    });
    const gw = createGateway({ url, name: 'stub', timeoutMs: 4000, retries: 0, allowRemote: false });
    const started = Date.now();
    const res = await gw.complete({ prompt: 'hi' });
    const elapsed = Date.now() - started;
    assert.equal(res.error.code, 'RESPONSE_TOO_LARGE', 'the limit is applied to the stream, not to a finished body');
    assert.ok(elapsed < 2000, `rejected at the limit rather than waiting for the timeout (${elapsed} ms)`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closed, true, 'the body read was cancelled and the connection closed');
  });

  test('an oversized error body is still an HTTP failure, with an omitted detail', async () => {
    const chunk = 'e'.repeat(64 * 1024);
    let sent = 0;
    const url = await rawServer((req, body, res) => {
      if (req.method === 'GET') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(500, { 'content-type': 'text/plain' });
      const pump = () => {
        if (res.destroyed || sent > 1_200_000) return;
        sent += chunk.length;
        res.write(chunk, () => setTimeout(pump, 2));
      };
      pump();
    });
    const gw = createGateway({ url, name: 'stub', timeoutMs: 4000, retries: 0, allowRemote: false });
    const started = Date.now();
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.error.code, 'HTTP_ERROR', 'the status decides the class, not the body size');
    assert.match(res.error.message, /HTTP 500: \[response body omitted: exceeds the size limit\]/);
    assert.ok(Date.now() - started < 2000, 'the oversized body is not buffered to the timeout');
  });

  test('a request that never answers is aborted, the connection is closed, and the retry budget is not spent', async () => {
    let requests = 0;
    let closed = false;
    const url = await rawServer((req, body, res) => {
      if (req.method === 'GET') {
        // Health checks are not part of this call.
        return;
      }
      requests += 1;
      res.on('close', () => { closed = true; });
      // Accept the request and never answer. The gateway's own timer has to end it.
    });
    const gw = createGateway({ url, name: 'stub', timeoutMs: 100, retries: 3, allowRemote: false });
    const started = Date.now();
    const res = await gw.complete({ prompt: 'hi' });
    const elapsed = Date.now() - started;
    assert.equal(res.error.code, 'TIMEOUT');
    assert.equal(requests, 1, 'a timeout is not retried');
    assert.equal(elapsed < 1000, true, `returned near the timeout (${elapsed} ms)`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closed, true, 'the client closed the connection instead of leaving it open');
  });
});
