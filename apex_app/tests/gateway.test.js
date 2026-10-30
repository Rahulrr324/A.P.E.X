// Model Gateway and configuration: honest behaviour with and without a backend.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway, NoBackend, OpenAICompatibleBackend, createGateway, parseEndpoint } from '../src/model/gateway.js';
import { loadConfig } from '../src/config.js';
import { ValidationError } from '../src/errors.js';
import { startStubModel, closedPortUrl } from './helpers.js';

const stubs = [];
after(async () => { for (const s of stubs) await s.close(); });
async function stub() { const s = await startStubModel(); stubs.push(s); return s; }

describe('model gateway', () => {
  test('with no backend configured, the gateway reports it and never fabricates output', async () => {
    const gw = new ModelGateway({ backend: new NoBackend() });
    assert.equal(gw.isConfigured(), false);
    assert.equal(gw.describe().configured, false);
    const avail = await gw.checkAvailability();
    assert.equal(avail.configured, false);
    assert.equal(avail.available, false);
    const res = await gw.complete({ prompt: 'hello' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'NOT_CONFIGURED');
    assert.equal(res.text, undefined);
  });

  test('a configured local endpoint answers, and results record which backend produced them', async () => {
    const s = await stub();
    s.behavior.reply = 'hello from the stub';
    const gw = createGateway({ url: s.url, name: 'stub-model', timeoutMs: 5000, allowRemote: false });
    const avail = await gw.checkAvailability();
    assert.equal(avail.available, true);
    const res = await gw.complete({ system: 'sys', prompt: 'hi' });
    assert.equal(res.ok, true);
    assert.equal(res.text, 'hello from the stub');
    assert.equal(res.backend, 'openai-compatible');
    assert.equal(s.requests.at(-1).messages[0].content, 'sys');
    assert.equal(s.requests.at(-1).temperature, 0);
  });

  test('a 200 response without a usable model list is unavailable, not available', async () => {
    const s = await stub();
    const gw = createGateway({ url: s.url, name: 'stub-model', timeoutMs: 5000, allowRemote: false });
    const cases = [
      [JSON.stringify({ error: { message: 'model is not loaded' } }), /reported an error: model is not loaded/],
      ['<html>proxy error</html>', /did not return a model list/],
      [JSON.stringify({}), /did not return a model list/],
      [JSON.stringify({ data: [] }), /lists no model/],
    ];
    for (const [modelsRaw, detail] of cases) {
      s.behavior.modelsRaw = modelsRaw;
      const avail = await gw.checkAvailability({ timeoutMs: 1000 });
      assert.equal(avail.available, false, `reported available for ${modelsRaw}`);
      assert.match(avail.detail, detail);
    }
    // A server that does list a model is still available: this check must not
    // refuse every endpoint just because the body was validated.
    s.behavior.modelsRaw = undefined;
    assert.equal((await gw.checkAvailability({ timeoutMs: 1000 })).available, true);
  });

  test('an HTTP error from the endpoint is returned as a structured failure', async () => {
    const s = await stub();
    s.behavior.status = 500;
    const gw = createGateway({ url: s.url, name: 'x', timeoutMs: 5000, allowRemote: false });
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'HTTP_ERROR');
    assert.match(res.error.message, /500/);
  });

  test('a slow endpoint hits the timeout and is reported as TIMEOUT', async () => {
    const s = await stub();
    s.behavior.delayMs = 1500;
    const gw = createGateway({ url: s.url, name: 'x', timeoutMs: 200, allowRemote: false });
    const started = Date.now();
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'TIMEOUT');
    assert.ok(Date.now() - started < 1200, 'the call must return near the timeout');
  });

  test('an unreachable endpoint is reported as UNREACHABLE and availability is false', async () => {
    const url = await closedPortUrl();
    const gw = createGateway({ url, name: 'x', timeoutMs: 2000, allowRemote: false });
    const avail = await gw.checkAvailability({ timeoutMs: 1000 });
    assert.equal(avail.configured, true);
    assert.equal(avail.available, false);
    const res = await gw.complete({ prompt: 'hi' });
    assert.equal(res.error.code, 'UNREACHABLE');
  });

  test('a non-JSON or shape-wrong response is MALFORMED_RESPONSE, not an answer', async () => {
    const s = await stub();
    const gw = createGateway({ url: s.url, name: 'x', timeoutMs: 5000, allowRemote: false });
    s.behavior.raw = 'this is not json';
    assert.equal((await gw.complete({ prompt: 'hi' })).error.code, 'MALFORMED_RESPONSE');
    s.behavior.raw = JSON.stringify({ choices: [] });
    assert.equal((await gw.complete({ prompt: 'hi' })).error.code, 'MALFORMED_RESPONSE');
  });

  test('an empty prompt is rejected by the gateway', async () => {
    const s = await stub();
    const gw = createGateway({ url: s.url, name: 'x', timeoutMs: 5000, allowRemote: false });
    assert.equal((await gw.complete({ prompt: '' })).error.code, 'INVALID_PROMPT');
  });
});

describe('endpoint validation and configuration', () => {
  test('remote endpoints are refused unless explicitly allowed; credentials are never accepted', () => {
    assert.throws(() => parseEndpoint('https://api.example.com'), ValidationError);
    assert.throws(() => parseEndpoint('http://user:secret@127.0.0.1:11434'), ValidationError);
    assert.throws(() => parseEndpoint('ftp://127.0.0.1'), ValidationError);
    assert.throws(() => parseEndpoint('not a url'), ValidationError);
    assert.equal(parseEndpoint('http://127.0.0.1:11434').hostname, '127.0.0.1');
    assert.equal(parseEndpoint('http://localhost:8080/v1').hostname, 'localhost');
    assert.equal(parseEndpoint('https://api.example.com', { allowRemote: true }).hostname, 'api.example.com');
  });

  test('the endpoint description never includes credentials or query strings', () => {
    const b = new OpenAICompatibleBackend({ baseUrl: 'http://127.0.0.1:11434/v1/', model: 'm' });
    assert.equal(b.describe().endpoint, 'http://127.0.0.1:11434');
  });

  test('configuration: defaults, overrides, and rejected values', () => {
    const d = loadConfig({});
    assert.equal(d.model.url, null);
    assert.equal(d.model.name, 'local');
    assert.equal(d.model.timeoutMs, 30000);
    assert.equal(d.model.maxTokens, 512);
    assert.match(d.dataDir, /[\\/]\.apex[\\/]local-alpha$/);
    const o = loadConfig({ APEX_DATA_DIR: '/tmp/x', APEX_MODEL_URL: 'http://127.0.0.1:1', APEX_MODEL_TIMEOUT_MS: '500' });
    assert.equal(o.model.timeoutMs, 500);
    assert.equal(o.model.url, 'http://127.0.0.1:1');
    assert.throws(() => loadConfig({ APEX_MODEL_TIMEOUT_MS: 'soon' }), ValidationError);
    assert.throws(() => loadConfig({ APEX_MODEL_TIMEOUT_MS: '5' }), ValidationError);
    assert.equal(loadConfig({ APEX_MODEL_MAX_TOKENS: '64' }).model.maxTokens, 64);
    assert.throws(() => loadConfig({ APEX_MODEL_MAX_TOKENS: '0' }), ValidationError);
    assert.throws(() => loadConfig({ APEX_MODEL_MAX_TOKENS: '8193' }), ValidationError);
  });

  test('Ollama requires an explicit model name once an endpoint is configured', () => {
    const named = loadConfig({
      APEX_MODEL_PROVIDER: 'ollama',
      APEX_MODEL_URL: 'http://127.0.0.1:11434',
      APEX_MODEL_NAME: 'llama3.2',
    });
    assert.equal(named.model.name, 'llama3.2');
    assert.throws(
      () => loadConfig({ APEX_MODEL_PROVIDER: 'ollama', APEX_MODEL_URL: 'http://127.0.0.1:11434' }),
      /APEX_MODEL_NAME is required/,
    );
    // With no endpoint there is no model backend, so the name is not used.
    assert.equal(loadConfig({ APEX_MODEL_PROVIDER: 'ollama' }).model.name, 'local');
  });
});
