// Model Gateway: a replaceable boundary between APEX and any inference backend.
// The application never depends on a particular model. With no backend
// configured the gateway reports that honestly and never fabricates output.
import { ValidationError } from '../errors.js';

export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_RESPONSE_CHARS = 1000000;
const MAX_OUTPUT_CHARS = 8000;

function failure(backend, code, message, latencyMs = 0) {
  return { ok: false, backend, error: { code, message }, latencyMs };
}

// Validate a configured endpoint. Loopback only unless explicitly allowed.
export function parseEndpoint(rawUrl, { allowRemote = false } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError('APEX_MODEL_URL is not a valid URL', 'INVALID_CONFIG');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('APEX_MODEL_URL must use http or https', 'INVALID_CONFIG');
  }
  if (url.username || url.password) {
    throw new ValidationError('APEX_MODEL_URL must not contain credentials', 'INVALID_CONFIG');
  }
  if (!allowRemote && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ValidationError(
      `APEX_MODEL_URL host "${url.hostname}" is not loopback; set APEX_ALLOW_REMOTE_MODEL=1 to permit it`,
      'INVALID_CONFIG',
    );
  }
  return url;
}

export class NoBackend {
  constructor() {
    this.name = 'none';
    this.configured = false;
  }

  describe() {
    return { name: this.name, configured: false, endpoint: null, model: null };
  }

  async health() {
    return { available: false, detail: 'no inference backend configured (set APEX_MODEL_URL)' };
  }

  async complete() {
    return failure(this.name, 'NOT_CONFIGURED', 'no inference backend is configured');
  }
}

// Adapter for any server speaking the OpenAI-compatible chat API on a local
// port (for example Ollama or llama.cpp's server).
export class OpenAICompatibleBackend {
  constructor({ name = 'openai-compatible', baseUrl, model = 'local', allowRemote = false, fetchImpl = globalThis.fetch }) {
    if (typeof fetchImpl !== 'function') throw new ValidationError('fetch is not available in this runtime', 'INVALID_CONFIG');
    const url = parseEndpoint(baseUrl, { allowRemote });
    let basePath = url.pathname.replace(/\/+$/, '');
    if (basePath.endsWith('/v1')) basePath = basePath.slice(0, -3);
    this.name = name;
    this.configured = true;
    this.model = model;
    this.origin = url.origin;
    this.basePath = basePath;
    this.fetchImpl = fetchImpl;
  }

  describe() {
    return { name: this.name, configured: true, endpoint: this.origin + this.basePath, model: this.model };
  }

  async #request(method, pathname, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await this.fetchImpl(this.origin + this.basePath + pathname, {
        method,
        signal: controller.signal,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      const latencyMs = Date.now() - started;
      if (!res.ok) return { error: { code: 'HTTP_ERROR', message: `endpoint returned HTTP ${res.status}` }, latencyMs };
      if (text.length > MAX_RESPONSE_CHARS) return { error: { code: 'RESPONSE_TOO_LARGE', message: 'endpoint response exceeds the size limit' }, latencyMs };
      return { text, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - started;
      if (err && err.name === 'AbortError') {
        return { error: { code: 'TIMEOUT', message: `no response within ${timeoutMs} ms` }, latencyMs };
      }
      const cause = err?.cause?.code || err?.code || 'NETWORK_ERROR';
      return { error: { code: 'UNREACHABLE', message: `could not reach the endpoint (${cause})` }, latencyMs };
    } finally {
      clearTimeout(timer);
    }
  }

  async health(timeoutMs = 2000) {
    const r = await this.#request('GET', '/v1/models', null, timeoutMs);
    if (r.error) return { available: false, detail: r.error.message };
    return { available: true, detail: `reachable at ${this.origin}${this.basePath}` };
  }

  async complete({ system, prompt, timeoutMs }) {
    const body = {
      model: this.model,
      temperature: 0,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    };
    const r = await this.#request('POST', '/v1/chat/completions', body, timeoutMs);
    if (r.error) return failure(this.name, r.error.code, r.error.message, r.latencyMs);
    let parsed;
    try {
      parsed = JSON.parse(r.text);
    } catch {
      return failure(this.name, 'MALFORMED_RESPONSE', 'endpoint response is not JSON', r.latencyMs);
    }
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return failure(this.name, 'MALFORMED_RESPONSE', 'endpoint response has no message content', r.latencyMs);
    }
    return { ok: true, backend: this.name, text: content.slice(0, MAX_OUTPUT_CHARS), latencyMs: r.latencyMs };
  }
}

export class ModelGateway {
  constructor({ backend = new NoBackend(), timeoutMs = 30000 } = {}) {
    this.backend = backend;
    this.timeoutMs = timeoutMs;
  }

  isConfigured() {
    return this.backend.configured === true;
  }

  describe() {
    return this.backend.describe();
  }

  async checkAvailability({ timeoutMs = 2000 } = {}) {
    if (!this.isConfigured()) {
      return { configured: false, available: false, backend: this.backend.name, detail: 'not configured' };
    }
    const h = await this.backend.health(timeoutMs);
    return { configured: true, available: h.available, backend: this.backend.name, detail: h.detail };
  }

  async complete({ system = '', prompt, timeoutMs } = {}) {
    if (!this.isConfigured()) return failure(this.backend.name, 'NOT_CONFIGURED', 'no inference backend is configured');
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return failure(this.backend.name, 'INVALID_PROMPT', 'prompt must be non-empty text');
    }
    return this.backend.complete({ system: String(system), prompt, timeoutMs: timeoutMs ?? this.timeoutMs });
  }
}

export function createGateway(modelConfig, fetchImpl = globalThis.fetch) {
  if (!modelConfig.url) {
    return new ModelGateway({ backend: new NoBackend(), timeoutMs: modelConfig.timeoutMs });
  }
  return new ModelGateway({
    backend: new OpenAICompatibleBackend({
      name: 'openai-compatible',
      baseUrl: modelConfig.url,
      model: modelConfig.name,
      allowRemote: modelConfig.allowRemote,
      fetchImpl,
    }),
    timeoutMs: modelConfig.timeoutMs,
  });
}
