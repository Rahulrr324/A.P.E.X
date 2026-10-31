// Backend-reported token and timing metadata. The counters come from the server, so
// they are untrusted: only bounded numbers are kept, and absent values stay absent.
// These tests use stand-in servers; no model is required.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createGateway } from '../src/model/gateway.js';
import { createApp } from '../src/app.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const servers = [];
after(async () => {
  for (const s of servers) await new Promise((resolve) => s.close(resolve));
});

async function rawServer(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, body, res));
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

function ollamaReply(overrides = {}) {
  return {
    model: 'm',
    message: { role: 'assistant', content: 'Paris.' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 724,
    eval_count: 101,
    prompt_eval_duration: 1_576_900_000,
    eval_duration: 28_474_560_000,
    total_duration: 30_051_460_000,
    load_duration: 22_900_000_000,
    ...overrides,
  };
}

describe('backend-reported metadata', () => {
  test('Ollama counters and nanosecond durations become whole numbers of tokens and milliseconds', async () => {
    const url = await rawServer((req, _body, res) => json(res, 200, ollamaReply()));
    const gw = createGateway({ provider: 'ollama', url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'capital?' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.usage, { promptTokens: 724, completionTokens: 101 });
    assert.deepEqual(res.timings, { totalMs: 30051, loadMs: 22900, promptEvalMs: 1577, evalMs: 28475 });
  });

  test('OpenAI-compatible usage is captured; no timings are invented', async () => {
    const url = await rawServer((req, _body, res) => json(res, 200, {
      model: 'm',
      choices: [{ message: { role: 'assistant', content: 'Paris.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 30, total_tokens: 530 },
    }));
    const gw = createGateway({ url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'capital?' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.usage, { promptTokens: 500, completionTokens: 30 });
    assert.equal('timings' in res, false, 'a server that reports no durations gets none');
  });

  test('implausible or missing counters are omitted, never guessed', async () => {
    const url = await rawServer((req, _body, res) => json(res, 200, ollamaReply({
      prompt_eval_count: '724',
      eval_count: -5,
      prompt_eval_duration: -1,
      eval_duration: 1e300,
      total_duration: null,
      load_duration: 'slow',
    })));
    const gw = createGateway({ provider: 'ollama', url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'capital?' });
    assert.equal(res.ok, true);
    assert.equal('usage' in res, false);
    assert.equal('timings' in res, false);
  });

  test('an empty answer reports the failure and carries no metadata', async () => {
    const url = await rawServer((req, _body, res) => json(res, 200, ollamaReply({
      message: { role: 'assistant', content: '', thinking: 'reasoning' },
      done_reason: 'length',
    })));
    const gw = createGateway({ provider: 'ollama', url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'capital?' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'EMPTY_RESPONSE');
    assert.equal('usage' in res, false);
    assert.equal('timings' in res, false);
  });

  test('the controller records the metadata in the operation and leaves the answer unverified', async () => {
    const url = await rawServer((req, _body, res) => json(res, 200, ollamaReply()));
    const gateway = createGateway({ provider: 'ollama', url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
    const dir = makeTempDataDir();
    try {
      const app = createApp({ dataDir: dir, gateway });
      const result = await app.controller.handle('what is the capital of France?', { origin: 'user' });
      assert.equal(result.status, 'verification_unavailable');
      assert.equal(result.operation.steps.length, 0, 'no action is proposed or executed');
      assert.deepEqual(result.operation.model.usage, { promptTokens: 724, completionTokens: 101 });
      assert.deepEqual(result.operation.model.timings, { totalMs: 30051, loadMs: 22900, promptEvalMs: 1577, evalMs: 28475 });

      // The same numbers reach the audit log, which is what a later reader sees.
      const lines = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8').trim().split(/\r?\n/);
      const stored = JSON.parse(lines.at(-1));
      assert.deepEqual(stored.model.usage, { promptTokens: 724, completionTokens: 101 });
      assert.equal(stored.status, 'verification_unavailable');
      assert.equal(stored.steps.length, 0);
    } finally {
      cleanup(dir);
    }
  });
});
