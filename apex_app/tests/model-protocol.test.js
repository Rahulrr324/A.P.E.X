// Model Gateway protocol checks. These use local stand-in servers that reproduce
// the documented request and response shapes of Ollama's native API and of
// OpenAI-compatible servers (llama.cpp). They prove the wire format and the failure
// classification. They do NOT prove inference quality; see README "Verification".
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway, OllamaBackend, OpenAICompatibleBackend } from '../src/model/gateway.js';
import { startStubModel, closedPortUrl } from './helpers.js';

const servers = [];
after(async () => {
  for (const s of servers) await new Promise((resolve) => s.close(resolve));
});

// A tiny raw server: `handler(req, body, res)` decides every response.
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

describe('Ollama native API (protocol)', () => {
  test('a chat request uses /api/chat with stream=false and num_predict, and the answer is read from message.content', async () => {
    const seen = [];
    const url = await rawServer((req, body, res) => {
      if (req.url === '/api/chat') {
        seen.push(JSON.parse(body));
        return json(res, 200, { model: 'llama3.2:latest', message: { role: 'assistant', content: 'Paris.' }, done: true, done_reason: 'stop' });
      }
      res.writeHead(404).end();
    });
    const gw = createGateway({ provider: 'ollama', url, name: 'llama3.2', maxTokens: 64, timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ system: 'sys', prompt: 'capital of France?' });
    assert.equal(res.ok, true);
    assert.equal(res.text, 'Paris.');
    assert.equal(res.provider, 'ollama');
    assert.equal(res.model, 'llama3.2:latest', 'the model that actually answered is reported');
    assert.equal(res.finishReason, 'stop');
    const sent = seen[0];
    assert.equal(sent.model, 'llama3.2');
    assert.equal(sent.stream, false);
    assert.equal(sent.think, false, 'APEX asks for the answer, not a separate reasoning stream');
    assert.equal(sent.options.num_predict, 64);
    assert.equal(sent.options.temperature, 0);
    assert.deepEqual(sent.messages.map((m) => m.role), ['system', 'user']);
  });

  test('a thinking-only response has no answer text and never exposes the reasoning as the answer', async () => {
    const url = await rawServer((req, body, res) => json(res, 200, {
      model: 'm',
      message: { role: 'assistant', content: '', thinking: 'internal reasoning that is not an answer' },
      done: true,
      done_reason: 'length',
    }));
    const gw = createGateway({ provider: 'ollama', url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'EMPTY_RESPONSE');
    assert.equal(res.text, undefined);
  });

  test('an Ollama answer stopped by num_predict is kept and flagged as truncated', async () => {
    const url = await rawServer((req, body, res) => json(res, 200, {
      model: 'm',
      message: { role: 'assistant', content: 'The answer starts but was cut' },
      done: true,
      done_reason: 'length',
    }));
    const gw = createGateway({ provider: 'ollama', url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.ok, true);
    assert.equal(res.finishReason, 'length');
    assert.equal(res.truncated, true, 'done_reason "length" is reported as an incomplete answer');
    assert.equal(res.text, 'The answer starts but was cut');
  });

  test('reasoning text and a think marker inside message.content are preserved, not stripped', async () => {
    const content = 'I should work this out step by step.\n</think>\n\n4';
    const url = await rawServer((req, body, res) => json(res, 200, {
      model: 'm',
      message: { role: 'assistant', content },
      done: true,
      done_reason: 'stop',
    }));
    const gw = createGateway({ provider: 'ollama', url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.ok, true);
    assert.equal(res.text, content, 'content is returned verbatim; no marker heuristic is applied');
    assert.equal(res.truncated, false);
  });

  test('a response that exhausts its budget inside reasoning is truncated, not completed', async () => {
    const url = await rawServer((req, body, res) => json(res, 200, {
      model: 'm',
      message: { role: 'assistant', content: 'Okay, the user is asking. Let me think about the answer and' },
      done: true,
      done_reason: 'length',
    }));
    const gw = createGateway({ provider: 'ollama', url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.ok, true, 'the visible text is kept rather than discarded');
    assert.equal(res.truncated, true, 'budget exhaustion is reported from done_reason, without inferring the cause');
    assert.equal(res.text, 'Okay, the user is asking. Let me think about the answer and');
  });

  test('an Ollama error object in a 200 response is MODEL_ERROR, never an answer', async () => {
    const url = await rawServer((req, body, res) => json(res, 200, { error: 'model failed to load' }));
    const gw = createGateway({ provider: 'ollama', url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'MODEL_ERROR');
    assert.match(res.error.message, /model failed to load/);
    assert.equal(res.text, undefined);
  });

  test('a model that is not pulled is reported as MODEL_NOT_FOUND with the fix, never as an answer', async () => {
    const url = await rawServer((req, body, res) => json(res, 404, { error: "model 'nope' not found" }));
    const gw = createGateway({ provider: 'ollama', url, name: 'nope', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'MODEL_NOT_FOUND');
    assert.match(res.error.message, /ollama pull nope/);
    assert.equal(res.text, undefined);
  });

  test('availability checks the installed model list, including the implicit :latest tag', async () => {
    const url = await rawServer((req, body, res) => {
      if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'phi3:latest' }, { name: 'qwen2.5:7b' }] });
      res.writeHead(404).end();
    });
    const present = new OllamaBackend({ baseUrl: url, model: 'phi3', timeoutMs: 5000 });
    assert.equal((await present.health()).available, true);
    const tagged = new OllamaBackend({ baseUrl: url, model: 'qwen2.5:7b', timeoutMs: 5000 });
    assert.equal((await tagged.health()).available, true);
    const missing = new OllamaBackend({ baseUrl: url, model: 'mistral', timeoutMs: 5000 });
    const h = await missing.health();
    assert.equal(h.available, false);
    assert.match(h.detail, /not installed/);
  });

  test('an Ollama error body on a failed request is surfaced briefly, not echoed in full', async () => {
    const url = await rawServer((req, body, res) => json(res, 500, { error: `out of memory ${'x'.repeat(500)}` }));
    const gw = createGateway({ provider: 'ollama', url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.error.code, 'HTTP_ERROR');
    assert.match(res.error.message, /HTTP 500: out of memory/);
    assert.ok(res.error.message.length < 300, 'the server message is shortened');
  });

  test('an Ollama response with no message content is MALFORMED_RESPONSE', async () => {
    const url = await rawServer((req, body, res) => json(res, 200, { model: 'm', done: true }));
    const gw = createGateway({ provider: 'ollama', url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
    assert.equal((await gw.complete({ prompt: 'hi' })).error.code, 'MALFORMED_RESPONSE');
  });

  test('unexpected Ollama response shapes are MALFORMED_RESPONSE, never answer text', async () => {
    const cases = [
      { model: 'm', message: 'not an object' },
      { model: 'm', message: { content: 42 } },
      { model: 'm', message: { content: ['array'] } },
      [],
    ];
    for (const shape of cases) {
      const url = await rawServer((req, body, res) => json(res, 200, shape));
      const gw = createGateway({ provider: 'ollama', url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
      const res = await gw.complete({ prompt: 'hi' });
      assert.equal(res.ok, false, JSON.stringify(shape));
      assert.equal(res.error.code, 'MALFORMED_RESPONSE', JSON.stringify(shape));
      assert.equal(res.text, undefined);
    }
  });

  test('credential-looking text in an Ollama diagnostic is redacted', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwx';
    const url = await rawServer((req, body, res) => json(res, 500, { error: `authentication failed for ${secret}` }));
    const gw = createGateway({ provider: 'ollama', url, name: 'm', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.error.code, 'HTTP_ERROR');
    assert.equal(res.error.message.includes(secret), false, 'the token is not echoed');
    assert.match(res.error.message, /\[redacted-secret\]/);
  });
});

describe('OpenAI-compatible servers (llama.cpp protocol)', () => {
  test('an OpenAI-compatible request applies stream=false, temperature 0, max_tokens, and message roles', async () => {
    let sent;
    const url = await rawServer((req, body, res) => {
      if (req.url === '/v1/chat/completions') {
        sent = JSON.parse(body);
        return json(res, 200, { model: 'm', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
      }
      res.writeHead(404).end();
    });
    const gw = createGateway({ url, name: 'm', maxTokens: 64, timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ system: 'sys', prompt: 'hi' });
    assert.equal(res.ok, true);
    assert.equal(sent.stream, false);
    assert.equal(sent.temperature, 0);
    assert.equal(sent.max_tokens, 64);
    assert.equal(sent.model, 'm');
    assert.deepEqual(sent.messages.map((m) => m.role), ['system', 'user']);
  });

  test('an empty answer is EMPTY_RESPONSE, never a successful answer', async () => {
    const s = await startStubModel();
    servers.push({ close: (cb) => s.close().then(() => cb && cb()) });
    s.behavior.reply = '   ';
    const gw = createGateway({ url: s.url, name: 'x', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'EMPTY_RESPONSE');
  });

  test('unexpected OpenAI-compatible response shapes are MALFORMED_RESPONSE, never answer text', async () => {
    const shapes = [
      { choices: 'not an array' },
      { choices: [] },
      { choices: [{ message: { content: 42 } }] },
      { choices: [{ message: 'not an object' }] },
      { choices: [{ message: { content: null } }] },
      null,
    ];
    for (const shape of shapes) {
      const url = await rawServer((req, body, res) => json(res, 200, shape));
      const gw = createGateway({ url, name: 'x', timeoutMs: 5000, retries: 0, allowRemote: false });
      const res = await gw.complete({ prompt: 'hi' });
      assert.equal(res.ok, false, JSON.stringify(shape));
      assert.equal(res.error.code, 'MALFORMED_RESPONSE', JSON.stringify(shape));
      assert.equal(res.text, undefined);
    }
  });

  test('credential-looking text in an OpenAI-compatible diagnostic is redacted', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwx';
    const url = await rawServer((req, body, res) => json(res, 500, { error: { message: `bad key ${secret}` } }));
    const gw = createGateway({ url, name: 'x', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.error.code, 'HTTP_ERROR');
    assert.equal(res.error.message.includes(secret), false, 'the token is not echoed');
    assert.match(res.error.message, /\[redacted-secret\]/);
  });

  test('a length-limited answer is kept and flagged as truncated', async () => {
    const url = await rawServer((req, body, res) => json(res, 200, { model: 'm', choices: [{ message: { content: 'The first part' }, finish_reason: 'length' }] }));
    const gw = createGateway({ url, name: 'x', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.ok, true);
    assert.equal(res.truncated, true);
    assert.equal(res.text, 'The first part');
  });

  test('control characters (such as terminal escape codes) are removed from model text', async () => {
    const url = await rawServer((req, body, res) => json(res, 200, { choices: [{ message: { content: 'safe\u001b[2Jtext\u0007' }, finish_reason: 'stop' }] }));
    const gw = createGateway({ url, name: 'x', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.text.includes('\u001b'), false);
    assert.equal(res.text.includes('\u0007'), false);
  });

  test('an over-long prompt is named CONTEXT_TOO_LARGE so the user shortens the request', async () => {
    const url = await rawServer((req, body, res) => json(res, 400, { error: { message: 'the request exceeds the available context size' } }));
    const gw = createGateway({ url, name: 'x', timeoutMs: 5000, retries: 0, allowRemote: false });
    assert.equal((await gw.complete({ prompt: 'hi' })).error.code, 'CONTEXT_TOO_LARGE');
  });

  test('a body that stalls after the headers is TIMEOUT, never a partial answer', async () => {
    const url = await rawServer((req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":[{"message":{"content":"partial');
    });
    const gw = createGateway({ url, name: 'm', timeoutMs: 100, retries: 2, allowRemote: false });
    const started = Date.now();
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'TIMEOUT');
    assert.equal(res.text, undefined);
    assert.ok(Date.now() - started < 500, 'the stalled body does not extend the wait');
  });

  test('a connection dropped while the answer is being read is INTERRUPTED, not an answer', async () => {
    const url = await rawServer((req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
      res.write('{"choices":[{"message":{"content":"partial');
      setTimeout(() => req.socket.destroy(), 30);
    });
    const gw = createGateway({ url, name: 'x', timeoutMs: 5000, retries: 0, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INTERRUPTED');
  });

  test('an unreachable failure is retried once and a later success is used', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        const e = new TypeError('fetch failed');
        e.cause = { code: 'ECONNRESET' };
        throw e;
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }] }), { status: 200 });
    };
    const backend = new OpenAICompatibleBackend({ baseUrl: 'http://127.0.0.1:1', model: 'm', retries: 1, timeoutMs: 5000, fetchImpl });
    const res = await backend.complete({ system: '', prompt: 'hi', timeoutMs: 5000 });
    assert.equal(calls, 2);
    assert.equal(res.ok, true);
    assert.equal(res.text, 'recovered');
  });

  test('a response that arrives after the timeout is not retried or used', async () => {
    let requests = 0;
    let closed = false;
    const url = await rawServer((req, body, res) => {
      requests += 1;
      res.on('close', () => { closed = true; });
      setTimeout(() => {
        if (!res.writableEnded && !res.destroyed) {
          json(res, 200, { model: 'm', choices: [{ message: { content: 'late answer' }, finish_reason: 'stop' }] });
        }
      }, 300);
    });
    const gw = createGateway({ url, name: 'm', timeoutMs: 50, retries: 2, allowRemote: false });
    const started = Date.now();
    const res = await gw.complete({ prompt: 'hi' });
    const elapsed = Date.now() - started;
    assert.equal(res.error.code, 'TIMEOUT');
    assert.ok(elapsed < 250, `the call returned near its timeout, not after the late response (${elapsed} ms)`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(requests, 1, 'a timeout is not retried');
    assert.equal(closed, true, 'APEX closes the connection instead of waiting for a late body');
  });

  test('a timeout is never retried (the user would wait twice)', async () => {
    let calls = 0;
    const fetchImpl = (url, init) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    };
    const backend = new OpenAICompatibleBackend({ baseUrl: 'http://127.0.0.1:1', model: 'm', retries: 3, timeoutMs: 100, fetchImpl });
    const res = await backend.complete({ system: '', prompt: 'hi', timeoutMs: 100 });
    assert.equal(res.error.code, 'TIMEOUT');
    assert.equal(calls, 1);
  });

  test('an unreachable server is reported as UNREACHABLE after the retry, with no answer', async () => {
    const url = await closedPortUrl();
    const gw = createGateway({ url, name: 'x', timeoutMs: 2000, retries: 1, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.error.code, 'UNREACHABLE');
    assert.equal(res.text, undefined);
  });
});
