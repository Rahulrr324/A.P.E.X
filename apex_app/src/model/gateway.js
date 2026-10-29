// Model Gateway: the only place APEX talks to an inference server. Provider
// specific code lives behind the same small interface, so the controller never
// depends on a particular model or server.
//
//   gateway.complete({ system, prompt, timeoutMs })
//     -> { ok: true,  backend, provider, model, text, finishReason, truncated, latencyMs }
//     -> { ok: false, backend, provider, error: { code, message }, latencyMs }
//
// A result is ok ONLY when the server returned non-empty answer text. Every other
// case is a structured failure. Nothing is ever invented.
import { ValidationError } from '../errors.js';
import { redactSecrets } from '../security/secrets.js';
import { CONTROL_CHARS } from '../util.js';

// Model text is untrusted. Control characters (including terminal escape codes)
// are removed before the text reaches the user, the history, or the audit log.
const CONTROL_CHARS_GLOBAL = new RegExp(CONTROL_CHARS.source, 'g');

export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_RESPONSE_CHARS = 1000000;
const MAX_OUTPUT_CHARS = 8000;
const MAX_ERROR_DETAIL_CHARS = 200;
const RETRY_DELAY_MS = 300;
// Failures where no answer reached APEX, so a repeat attempt is safe.
const RETRYABLE = new Set(['UNREACHABLE', 'INTERRUPTED']);

function failure(backend, provider, code, message, latencyMs = 0) {
  return { ok: false, backend, provider, error: { code, message }, latencyMs };
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

// A short, readable message from an error body. Long or secret-looking text is
// cut or redacted before it reaches the user.
function serverMessage(text) {
  let msg = '';
  try {
    const obj = JSON.parse(text);
    msg = typeof obj?.error === 'string' ? obj.error : (obj?.error?.message ?? '');
  } catch {
    msg = String(text ?? '');
  }
  msg = redactSecrets(String(msg).replace(/\s+/g, ' ').trim());
  return msg.length > MAX_ERROR_DETAIL_CHARS ? `${msg.slice(0, MAX_ERROR_DETAIL_CHARS - 3)}...` : msg;
}

export class NoBackend {
  constructor() {
    this.name = 'none';
    this.provider = 'none';
    this.configured = false;
  }

  describe() {
    return { name: this.name, provider: this.provider, configured: false, endpoint: null, model: null };
  }

  async health() {
    return { available: false, detail: 'no inference backend configured (set APEX_MODEL_URL)' };
  }

  async complete() {
    return failure(this.name, this.provider, 'NOT_CONFIGURED', 'no inference backend is configured');
  }
}

// Shared HTTP transport: explicit error classification, one overall timeout that
// also covers reading the body, and retries only for failures where nothing was
// answered.
class HttpBackend {
  constructor({ name, provider, baseUrl, model, maxTokens = 512, retries = 1, allowRemote = false, fetchImpl = globalThis.fetch }) {
    if (typeof fetchImpl !== 'function') throw new ValidationError('fetch is not available in this runtime', 'INVALID_CONFIG');
    const url = parseEndpoint(baseUrl, { allowRemote });
    this.name = name;
    this.provider = provider;
    this.configured = true;
    this.model = model;
    this.maxTokens = maxTokens;
    this.retries = retries;
    this.origin = url.origin;
    this.basePath = this.normalizeBasePath(url.pathname.replace(/\/+$/, ''));
    this.fetchImpl = fetchImpl;
  }

  normalizeBasePath(p) {
    return p;
  }

  describe() {
    return { name: this.name, provider: this.provider, configured: true, endpoint: this.origin + this.basePath, model: this.model };
  }

  async #attempt(method, pathname, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    try {
      let res;
      try {
        res = await this.fetchImpl(this.origin + this.basePath + pathname, {
          method,
          signal: controller.signal,
          headers: body ? { 'content-type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (err?.name === 'AbortError') return { error: { code: 'TIMEOUT', message: `no response within ${timeoutMs} ms` }, latencyMs: elapsed() };
        const cause = err?.cause?.code || err?.code || 'NETWORK_ERROR';
        return { error: { code: 'UNREACHABLE', message: `could not reach the endpoint (${cause})` }, latencyMs: elapsed() };
      }
      let text;
      try {
        text = await res.text();
      } catch (err) {
        // The connection dropped after the response began, so the answer is incomplete.
        if (err?.name === 'AbortError') return { error: { code: 'TIMEOUT', message: `no complete response within ${timeoutMs} ms` }, latencyMs: elapsed() };
        return { error: { code: 'INTERRUPTED', message: 'the connection was interrupted while reading the response' }, latencyMs: elapsed() };
      }
      if (!res.ok) {
        const detail = serverMessage(text);
        return {
          error: { code: 'HTTP_ERROR', message: `endpoint returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, status: res.status, detail },
          latencyMs: elapsed(),
        };
      }
      if (text.length > MAX_RESPONSE_CHARS) return { error: { code: 'RESPONSE_TOO_LARGE', message: 'endpoint response exceeds the size limit' }, latencyMs: elapsed() };
      return { text, latencyMs: elapsed() };
    } finally {
      clearTimeout(timer);
    }
  }

  // A timeout is never retried: the user would wait for the timeout twice.
  async request(method, pathname, body, timeoutMs) {
    let total = 0;
    let r;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      r = await this.#attempt(method, pathname, body, timeoutMs);
      total += r.latencyMs;
      if (!r.error || !RETRYABLE.has(r.error.code) || attempt === this.retries) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
    return { ...r, latencyMs: total };
  }

  // Maps a transport failure to a structured result. An over-long prompt is named
  // as such, so the user knows to shorten the request rather than retry.
  httpFailure(r) {
    const e = r.error;
    if (e.code === 'HTTP_ERROR' && [400, 413, 422].includes(e.status) && /context|too (long|large)|exceed/i.test(e.detail ?? '')) {
      return failure(this.name, this.provider, 'CONTEXT_TOO_LARGE', 'the prompt is larger than the model context window; shorten the request or use a model with a larger context', r.latencyMs);
    }
    return failure(this.name, this.provider, e.code, e.message, r.latencyMs);
  }

  parseJson(text, latencyMs) {
    try {
      return { value: JSON.parse(text) };
    } catch {
      return { failure: failure(this.name, this.provider, 'MALFORMED_RESPONSE', 'endpoint response is not JSON', latencyMs) };
    }
  }

  finishAnswer({ content, reasoning, finishReason, reportedModel, latencyMs }) {
    if (typeof content !== 'string') {
      return failure(this.name, this.provider, 'MALFORMED_RESPONSE', 'endpoint response has no message content', latencyMs);
    }
    const text = content.replace(CONTROL_CHARS_GLOBAL, '').trim();
    if (text.length === 0) {
      // Reasoning is never a substitute for an answer, but its presence explains
      // why the answer is empty: the generation budget was spent before any final
      // text was produced.
      const spentOnReasoning = typeof reasoning === 'string' && reasoning.trim().length > 0;
      return failure(
        this.name,
        this.provider,
        'EMPTY_RESPONSE',
        spentOnReasoning
          ? 'the model produced reasoning but no final answer; the token budget was likely spent on reasoning, so raise APEX_MODEL_MAX_TOKENS or use a model that can skip thinking'
          : 'endpoint returned an empty answer',
        latencyMs,
      );
    }
    return {
      ok: true,
      backend: this.name,
      provider: this.provider,
      model: reportedModel || this.model,
      text: text.slice(0, MAX_OUTPUT_CHARS),
      finishReason: finishReason ?? null,
      truncated: finishReason === 'length' || text.length > MAX_OUTPUT_CHARS,
      latencyMs,
    };
  }
}

// Any server speaking the OpenAI-compatible chat API: llama.cpp's llama-server,
// or Ollama's /v1 compatibility layer.
export class OpenAICompatibleBackend extends HttpBackend {
  constructor(opts) {
    super({ name: 'openai-compatible', provider: 'openai', ...opts });
  }

  normalizeBasePath(p) {
    return p.endsWith('/v1') ? p.slice(0, -3) : p;
  }

  async health(timeoutMs = 2000) {
    const r = await this.request('GET', '/v1/models', null, timeoutMs);
    if (r.error) return { available: false, detail: r.error.message };
    return { available: true, detail: `reachable at ${this.origin}${this.basePath}` };
  }

  async complete({ system, prompt, timeoutMs }) {
    const body = {
      model: this.model,
      temperature: 0,
      stream: false,
      max_tokens: this.maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    };
    const r = await this.request('POST', '/v1/chat/completions', body, timeoutMs);
    if (r.error) return this.httpFailure(r);
    const parsed = this.parseJson(r.text, r.latencyMs);
    if (parsed.failure) return parsed.failure;
    const choice = parsed.value?.choices?.[0];
    return this.finishAnswer({
      content: choice?.message?.content,
      finishReason: choice?.finish_reason,
      reportedModel: typeof parsed.value?.model === 'string' ? parsed.value.model : null,
      latencyMs: r.latencyMs,
    });
  }
}

// Ollama's native API (/api/chat and /api/tags). It gives a precise message when
// the configured model has not been pulled.
export class OllamaBackend extends HttpBackend {
  constructor(opts) {
    super({ name: 'ollama', provider: 'ollama', ...opts });
  }

  async installedModels(timeoutMs) {
    const r = await this.request('GET', '/api/tags', null, timeoutMs);
    if (r.error) return { error: r.error };
    const parsed = this.parseJson(r.text, r.latencyMs);
    if (parsed.failure) return { error: parsed.failure.error };
    const names = Array.isArray(parsed.value?.models)
      ? parsed.value.models.map((m) => m?.name).filter((n) => typeof n === 'string')
      : [];
    return { names };
  }

  async health(timeoutMs = 2000) {
    const listed = await this.installedModels(timeoutMs);
    if (listed.error) return { available: false, detail: listed.error.message };
    const wanted = this.model.includes(':') ? this.model : `${this.model}:latest`;
    if (!listed.names.some((n) => n === this.model || n === wanted)) {
      return { available: false, detail: `model "${this.model}" is not installed on this Ollama server (run: ollama pull ${this.model})` };
    }
    return { available: true, detail: `model "${this.model}" installed at ${this.origin}` };
  }

  async complete({ system, prompt, timeoutMs }) {
    const body = {
      model: this.model,
      stream: false,
      // The provider default is used deliberately. For a thinking model, Ollama
      // then returns reasoning in `message.thinking` and the final answer in
      // `message.content`. Sending think:false does NOT suppress reasoning for
      // templates that always open a think block (for example the installed Qwen3
      // GGUF): that reasoning arrives inside `message.content` and cannot be
      // separated reliably. think:true would be rejected by models that do not
      // support thinking.
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      options: { temperature: 0, num_predict: this.maxTokens },
    };
    const r = await this.request('POST', '/api/chat', body, timeoutMs);
    if (r.error) {
      if (r.error.code === 'HTTP_ERROR' && r.error.status === 404 && /not found/i.test(r.error.detail ?? '')) {
        return failure(this.name, this.provider, 'MODEL_NOT_FOUND', `model "${this.model}" is not installed on this Ollama server (run: ollama pull ${this.model})`, r.latencyMs);
      }
      return this.httpFailure(r);
    }
    const parsed = this.parseJson(r.text, r.latencyMs);
    if (parsed.failure) return parsed.failure;
    if (parsed.value?.error) {
      return failure(this.name, this.provider, 'MODEL_ERROR', `Ollama reported an error: ${serverMessage(JSON.stringify({ error: parsed.value.error }))}`, r.latencyMs);
    }
    return this.finishAnswer({
      content: parsed.value?.message?.content,
      // Only ever used to explain an empty answer. Reasoning is never returned as
      // text, shown, or stored.
      reasoning: parsed.value?.message?.thinking,
      finishReason: parsed.value?.done_reason ?? null,
      reportedModel: typeof parsed.value?.model === 'string' ? parsed.value.model : null,
      latencyMs: r.latencyMs,
    });
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
      return { configured: false, available: false, backend: this.backend.name, provider: this.backend.provider, detail: 'not configured' };
    }
    const h = await this.backend.health(timeoutMs);
    return { configured: true, available: h.available, backend: this.backend.name, provider: this.backend.provider, detail: h.detail };
  }

  async complete({ system = '', prompt, timeoutMs } = {}) {
    if (!this.isConfigured()) return failure(this.backend.name, this.backend.provider, 'NOT_CONFIGURED', 'no inference backend is configured');
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      return failure(this.backend.name, this.backend.provider, 'INVALID_PROMPT', 'prompt must be non-empty text');
    }
    return this.backend.complete({ system: String(system), prompt, timeoutMs: timeoutMs ?? this.timeoutMs });
  }
}

export function createGateway(modelConfig, fetchImpl = globalThis.fetch) {
  if (!modelConfig.url) {
    return new ModelGateway({ backend: new NoBackend(), timeoutMs: modelConfig.timeoutMs });
  }
  const common = {
    baseUrl: modelConfig.url,
    model: modelConfig.name,
    maxTokens: modelConfig.maxTokens ?? 512,
    retries: modelConfig.retries ?? 1,
    allowRemote: modelConfig.allowRemote,
    fetchImpl,
  };
  const backend = modelConfig.provider === 'ollama' ? new OllamaBackend(common) : new OpenAICompatibleBackend(common);
  return new ModelGateway({ backend, timeoutMs: modelConfig.timeoutMs });
}
