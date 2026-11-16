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
export const MAX_RESPONSE_CHARS = 1000000;
export const MAX_OUTPUT_CHARS = 8000;
const MAX_ERROR_DETAIL_CHARS = 200;
const RETRY_DELAY_MS = 300;
// Failures where no answer reached APEX, so a repeat attempt is safe.
const RETRYABLE = new Set(['UNREACHABLE', 'INTERRUPTED']);

// The transport outcome is one of these classes, fixed for every backend. The classes keep
// "nothing answered", "answered with no text", "the provider declined", "the request did not fit",
// and "the answer text came back" apart, so a caller never has to infer which happened from prose.
export const GatewayResponseClass = Object.freeze({
  VALID: 'valid',
  EMPTY: 'empty',
  REFUSED: 'refused',
  UNAVAILABLE: 'unavailable',
  MALFORMED: 'malformed',
  CONTEXT_LIMIT: 'context_limit',
  CANCELLED: 'cancelled',
});

export function classifyGatewayResult(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.ok === true) return GatewayResponseClass.VALID;
  const code = result.error?.code;
  switch (code) {
    case 'ABORTED':
      return GatewayResponseClass.CANCELLED;
    case 'EMPTY_RESPONSE':
      return GatewayResponseClass.EMPTY;
    case 'MODEL_REFUSED':
      return GatewayResponseClass.REFUSED;
    case 'CONTEXT_TOO_LARGE':
      return GatewayResponseClass.CONTEXT_LIMIT;
    case 'NOT_CONFIGURED':
    case 'UNREACHABLE':
    case 'TIMEOUT':
    case 'INTERRUPTED':
      return GatewayResponseClass.UNAVAILABLE;
    default:
      return GatewayResponseClass.MALFORMED;
  }
}

// A model answer is never verified by the transport. Provenance records which request it belongs
// to and which backend produced it, and states that no independent check has been made.
function provenanceOf(backend, provider, model, requestId) {
  return {
    requestId: typeof requestId === 'string' ? requestId.slice(0, 100) : null,
    backend: backend ?? null,
    provider: provider ?? null,
    model: typeof model === 'string' ? model : null,
    verified: false,
  };
}

// Backend-reported counters are untrusted input. Only finite, non-negative, bounded
// numbers are kept; a missing or implausible value is null, never estimated. Ollama
// reports durations in nanoseconds and APEX exposes whole milliseconds.
const MAX_REPORTED_COUNT = 1_000_000_000;
function reportedCount(value) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_REPORTED_COUNT ? Math.trunc(value) : null;
}
function reportedMs(nanoseconds) {
  return Number.isFinite(nanoseconds) && nanoseconds >= 0 && nanoseconds <= 3.6e15
    ? Math.round(nanoseconds / 1e6)
    : null;
}
// Returns null for a group where nothing usable was reported, so callers that never
// see metadata keep their existing result shape.
function backendMetadata({ promptTokens, completionTokens, totalNs, loadNs, promptEvalNs, evalNs } = {}) {
  const usage = { promptTokens: reportedCount(promptTokens), completionTokens: reportedCount(completionTokens) };
  const timings = { totalMs: reportedMs(totalNs), loadMs: reportedMs(loadNs), promptEvalMs: reportedMs(promptEvalNs), evalMs: reportedMs(evalNs) };
  const any = (group) => Object.values(group).some((v) => v !== null);
  return { usage: any(usage) ? usage : null, timings: any(timings) ? timings : null };
}

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
  // A base URL with a path prefix is supported, but a chat endpoint is not a base: using
  // one appends the API path twice and turns a configuration mistake into a misleading
  // HTTP 404 at request time.
  const endpointPath = url.pathname.replace(/\/+$/, '');
  if (/(?:^|\/)chat\/completions$/.test(endpointPath) || /(?:^|\/)api\/(?:chat|generate|tags)$/.test(endpointPath)) {
    throw new ValidationError('APEX_MODEL_URL must be the server base URL, not a chat or tags endpoint: APEX adds the API path itself', 'INVALID_CONFIG');
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

// A model id comes from the server, so it is bounded and stripped like any other
// untrusted text before it is quoted in a readiness message.
function safeModelName(value) {
  const text = String(value ?? '').replace(CONTROL_CHARS_GLOBAL, ' ').replace(/\s+/g, ' ').trim();
  const redacted = redactSecrets(text);
  return redacted.length > 60 ? `${redacted.slice(0, 57)}...` : redacted;
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

  // Reads the body with the size limit applied as data arrives. Reading the whole body
  // first would make the limit meaningless: the memory is already spent, and a stalled
  // oversized body would only end at the timeout. The limit is counted in decoded
  // characters, the same measure the rest of the gateway uses.
  async #readBody(res) {
    if (!res.body || typeof res.body.getReader !== 'function') return { text: await res.text() };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length > MAX_RESPONSE_CHARS) {
          await reader.cancel().catch(() => {});
          return { tooLarge: true };
        }
      }
      text += decoder.decode();
      return { text };
    } finally {
      reader.releaseLock();
    }
  }

  // The request's own deadline and the caller's cancellation are separate signals. Whichever fires
  // first ends the attempt, but only the caller's signal is reported as ABORTED: a timeout is the
  // gateway's limit, a cancellation is the caller's decision, and they call for different advice.
  #signalFor(timeoutMs, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const combined = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    return { signal: combined, clear: () => clearTimeout(timer), abortedByCaller: () => signal?.aborted === true };
  }

  async #attempt(method, pathname, body, timeoutMs, signal = null) {
    const deadline = this.#signalFor(timeoutMs, signal);
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    try {
      let res;
      try {
        res = await this.fetchImpl(this.origin + this.basePath + pathname, {
          method,
          signal: deadline.signal,
          headers: body ? { 'content-type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (err?.name === 'AbortError') {
          return deadline.abortedByCaller()
            ? { error: { code: 'ABORTED', message: 'the request was cancelled' }, latencyMs: elapsed() }
            : { error: { code: 'TIMEOUT', message: `no response within ${timeoutMs} ms` }, latencyMs: elapsed() };
        }
        const cause = err?.cause?.code || err?.code || 'NETWORK_ERROR';
        return { error: { code: 'UNREACHABLE', message: `could not reach the endpoint (${cause})` }, latencyMs: elapsed() };
      }
      let read;
      try {
        read = await this.#readBody(res);
      } catch (err) {
        // The connection dropped after the response began, so the answer is incomplete.
        if (err?.name === 'AbortError') {
          return deadline.abortedByCaller()
            ? { error: { code: 'ABORTED', message: 'the request was cancelled while its response was being read' }, latencyMs: elapsed() }
            : { error: { code: 'TIMEOUT', message: `no complete response within ${timeoutMs} ms` }, latencyMs: elapsed() };
        }
        return { error: { code: 'INTERRUPTED', message: 'the connection was interrupted while reading the response' }, latencyMs: elapsed() };
      }
      if (read.tooLarge) {
        // The status still decides the class: an oversized error body is an HTTP failure,
        // not a malformed success. Its detail is omitted rather than buffered.
        if (!res.ok) {
          const detail = '[response body omitted: exceeds the size limit]';
          return {
            error: { code: 'HTTP_ERROR', message: `endpoint returned HTTP ${res.status}: ${detail}`, status: res.status, detail },
            latencyMs: elapsed(),
          };
        }
        return { error: { code: 'RESPONSE_TOO_LARGE', message: 'endpoint response exceeds the size limit' }, latencyMs: elapsed() };
      }
      const text = read.text;
      if (!res.ok) {
        const detail = serverMessage(text);
        return {
          error: { code: 'HTTP_ERROR', message: `endpoint returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, status: res.status, detail },
          latencyMs: elapsed(),
        };
      }
      return { text, latencyMs: elapsed() };
    } finally {
      deadline.clear();
    }
  }

  // A timeout is never retried: the user would wait for the timeout twice.
  async request(method, pathname, body, timeoutMs, signal = null) {
    let total = 0;
    let r;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      r = await this.#attempt(method, pathname, body, timeoutMs, signal);
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
    if (e.code === 'TIMEOUT') {
      // Only the completion path gets this hint: a listing request that times out is not
      // slow because the model is loading.
      return failure(this.name, this.provider, 'TIMEOUT', `${e.message} (a first request can be slower while the server loads the model)`, r.latencyMs);
    }
    if (e.code === 'HTTP_ERROR' && [400, 413, 422].includes(e.status) && /context|too (long|large)|exceed/i.test(e.detail ?? '')) {
      return failure(this.name, this.provider, 'CONTEXT_TOO_LARGE', 'the prompt is larger than the model context window; shorten the request or use a model with a larger context', r.latencyMs);
    }
    // The endpoint answered, so this is not an outage or a bad base URL. If it says the
    // configured model does not exist, the model identifier is the problem.
    if (e.code === 'HTTP_ERROR' && e.status === 404
      && /model/i.test(e.detail ?? '')
      && /not (?:found|installed|available)|does not exist|unknown/i.test(e.detail ?? '')) {
      return failure(this.name, this.provider, 'MODEL_NOT_FOUND', `model "${safeModelName(this.model)}" was not found by the endpoint; check APEX_MODEL_NAME`, r.latencyMs);
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

  finishAnswer({ content, reasoning, finishReason, reportedModel, latencyMs, usage, timings, refused = false }) {
    // A provider refusal is not an empty answer and not a failure to reach the model. The refusal
    // text itself is not quoted: it is untrusted and says nothing APEX can act on.
    if (refused === true) {
      return failure(this.name, this.provider, 'MODEL_REFUSED', 'the model provider declined to produce an answer (content filter)', latencyMs);
    }
    if (typeof content !== 'string') {
      return failure(this.name, this.provider, 'MALFORMED_RESPONSE', 'endpoint response has no message content', latencyMs);
    }
    const text = content.replace(CONTROL_CHARS_GLOBAL, '').trim();
    if (text.length === 0) {
      // Reasoning is never a substitute for an answer, but its presence explains
      // why the answer is empty: the generation budget was spent before any final
      // text was produced. A reported "length" stop is used only when the provider
      // actually said so; nothing is inferred from a missing finish reason.
      const spentOnReasoning = typeof reasoning === 'string' && reasoning.trim().length > 0;
      const hitLimit = finishReason === 'length';
      let message;
      if (spentOnReasoning && hitLimit) {
        message = 'the model produced reasoning but no final answer, and the provider reported the token limit was reached; raise APEX_MODEL_MAX_TOKENS or use a model that can skip thinking';
      } else if (spentOnReasoning) {
        message = 'the model produced reasoning but no final answer; the token budget was likely spent on reasoning, so raise APEX_MODEL_MAX_TOKENS or use a model that can skip thinking';
      } else if (hitLimit) {
        message = 'the provider reported the token limit was reached before any answer text was produced; raise APEX_MODEL_MAX_TOKENS';
      } else {
        message = 'endpoint returned an empty answer';
      }
      return failure(this.name, this.provider, 'EMPTY_RESPONSE', message, latencyMs);
    }
    const meta = backendMetadata({ ...usage, ...timings });
    const overSizeLimit = text.length > MAX_OUTPUT_CHARS;
    return {
      ok: true,
      backend: this.name,
      provider: this.provider,
      model: reportedModel || this.model,
      text: text.slice(0, MAX_OUTPUT_CHARS),
      finishReason: finishReason ?? null,
      truncated: finishReason === 'length' || overSizeLimit,
      // Which limit cut the answer. A provider token stop and APEX's own output-size
      // cap are different causes, and the user-facing notice must not name the wrong one.
      truncatedBy: finishReason === 'length' ? 'token-limit' : (overSizeLimit ? 'output-size-limit' : null),
      latencyMs,
      ...(meta.usage ? { usage: meta.usage } : {}),
      ...(meta.timings ? { timings: meta.timings } : {}),
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
    // "Reachable" means the endpoint returned an HTTP response. It does not mean it can
    // serve the configured model: that is what available/modelListed report. The
    // distinction matters because a reachable server with the wrong model is not an
    // outage, and telling the operator to start the server would point at the wrong fix.
    if (r.error) return { available: false, reachable: r.error.code === 'HTTP_ERROR', detail: r.error.message };
    // A 200 status says the socket answered, not that the endpoint can serve a model.
    // The completion path already refuses a 200 error envelope and a malformed body;
    // the health check must agree, or `status --model` reports "available" for a server
    // that will fail every request. The configured model's presence is not required:
    // some servers accept any model name, so the check validates the shape and that at
    // least one model is listed.
    const parsed = this.parseJson(r.text, r.latencyMs);
    if (parsed.failure) {
      return { available: false, reachable: true, detail: `endpoint did not return a model list (${parsed.failure.error.message})` };
    }
    if (parsed.value?.error) {
      return { available: false, reachable: true, detail: `endpoint reported an error: ${serverMessage(JSON.stringify({ error: parsed.value.error }))}` };
    }
    if (!Array.isArray(parsed.value?.data)) {
      return { available: false, reachable: true, detail: 'endpoint did not return a model list' };
    }
    if (parsed.value.data.length === 0) {
      return { available: false, reachable: true, detail: 'endpoint lists no model' };
    }
    // The list is valid, but a reachable socket that lists some other model says
    // nothing about the configured one. Report that as unconfirmed rather than
    // available: some servers accept any model name, so this is not an outage, but
    // calling it confirmed would repeat the claim that a request will work.
    const ids = parsed.value.data
      .map((m) => (typeof m?.id === 'string' ? m.id : (typeof m?.name === 'string' ? m.name : null)))
      .filter((id) => typeof id === 'string' && id.length > 0);
    const modelListed = ids.some((id) => id === this.model);
    const where = `${this.origin}${this.basePath}`;
    if (ids.length === 0) {
      return {
        available: true,
        modelListed: false,
        detail: `reachable at ${where}; the model list has ${parsed.value.data.length} entr${parsed.value.data.length === 1 ? 'y' : 'ies'} but no model id, so configured model "${safeModelName(this.model)}" cannot be confirmed`,
      };
    }
    if (!modelListed) {
      const shown = ids.slice(0, 5).map((id) => `"${safeModelName(id)}"`).join(', ');
      const more = ids.length > 5 ? ` and ${ids.length - 5} more` : '';
      return {
        available: true,
        modelListed: false,
        detail: `reachable at ${where}; the model list (${shown}${more}) does not include configured model "${safeModelName(this.model)}", so a request may be rejected`,
      };
    }
    return {
      available: true,
      modelListed: true,
      detail: `reachable at ${where}; model "${safeModelName(this.model)}" is listed`,
    };
  }

  async complete({ system, prompt, timeoutMs, signal = null }) {
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
    const r = await this.request('POST', '/v1/chat/completions', body, timeoutMs, signal);
    if (r.error) return this.httpFailure(r);
    const parsed = this.parseJson(r.text, r.latencyMs);
    if (parsed.failure) return parsed.failure;
    // Some servers answer HTTP 200 with an error envelope instead of choices.
    // That is a provider failure, not a successful-but-malformed answer.
    if (parsed.value?.error) {
      return failure(this.name, this.provider, 'MODEL_ERROR', `endpoint reported an error: ${serverMessage(JSON.stringify({ error: parsed.value.error }))}`, r.latencyMs);
    }
    const choice = parsed.value?.choices?.[0];
    return this.finishAnswer({
      content: choice?.message?.content,
      finishReason: choice?.finish_reason,
      reportedModel: typeof parsed.value?.model === 'string' ? parsed.value.model : null,
      latencyMs: r.latencyMs,
      usage: {
        promptTokens: parsed.value?.usage?.prompt_tokens,
        completionTokens: parsed.value?.usage?.completion_tokens,
      },
      // Either signal is a provider refusal: a refusal message on the choice, or a content-filter
      // stop reason. A partial content body is not used, because the filter stopped generation.
      refused: choice?.finish_reason === 'content_filter'
        || (typeof choice?.message?.refusal === 'string' && choice.message.refusal.trim().length > 0),
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
    if (listed.error) {
      // As with the OpenAI-compatible backend, an HTTP answer proves the server is up
      // even when the installed-model list cannot be read.
      return { available: false, reachable: listed.error.code === 'HTTP_ERROR', detail: listed.error.message };
    }
    const wanted = this.model.includes(':') ? this.model : `${this.model}:latest`;
    if (!listed.names.some((n) => n === this.model || n === wanted)) {
      return { available: false, reachable: true, detail: `model "${safeModelName(this.model)}" is not installed on this Ollama server; configure APEX_MODEL_NAME to a model this server lists` };
    }
    return { available: true, modelListed: true, detail: `model "${safeModelName(this.model)}" installed at ${this.origin}` };
  }

  async complete({ system, prompt, timeoutMs, signal = null }) {
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
    const r = await this.request('POST', '/api/chat', body, timeoutMs, signal);
    if (r.error) {
      if (r.error.code === 'HTTP_ERROR' && r.error.status === 404 && /not found/i.test(r.error.detail ?? '')) {
        return failure(this.name, this.provider, 'MODEL_NOT_FOUND', `model "${this.model}" is not installed on this Ollama server; configure APEX_MODEL_NAME to a model this server lists`, r.latencyMs);
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
      usage: {
        promptTokens: parsed.value?.prompt_eval_count,
        completionTokens: parsed.value?.eval_count,
      },
      timings: {
        totalNs: parsed.value?.total_duration,
        loadNs: parsed.value?.load_duration,
        promptEvalNs: parsed.value?.prompt_eval_duration,
        evalNs: parsed.value?.eval_duration,
      },
    });
  }
}

// A prompt budget is only enforceable when the operator declares the model's context window. The
// count is a character-based estimate, named as one everywhere it is reported: APEX has no
// tokenizer and must not present a guess as a measurement. It is used before a request is sent,
// so an over-large prompt is refused locally instead of spending a round trip to learn the same
// thing from the server (or, worse, receiving a truncated prompt that silently changed the task).
export function estimateTokens(text) {
  return typeof text === 'string' && text.length > 0 ? Math.ceil(text.length / 4) : 0;
}

export function contextBudget({ system = '', prompt = '', maxTokens = null, maxContextTokens = null } = {}) {
  const declared = Number.isInteger(maxContextTokens) && maxContextTokens > 0 ? maxContextTokens : null;
  const output = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : null;
  const promptTokens = estimateTokens(system) + estimateTokens(prompt);
  if (declared === null || output === null) {
    return { enforced: false, promptTokens, outputTokens: output, maxContextTokens: declared, exceeds: false };
  }
  return {
    enforced: true,
    promptTokens,
    outputTokens: output,
    maxContextTokens: declared,
    exceeds: promptTokens + output > declared,
  };
}

export class ModelGateway {
  constructor({ backend = new NoBackend(), timeoutMs = 30000, maxTokens = null, maxContextTokens = null } = {}) {
    this.backend = backend;
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
    this.maxContextTokens = maxContextTokens;
  }

  isConfigured() {
    return this.backend.configured === true;
  }

  // The budget fields are APEX's own limits, not claims about the server. They are reported with
  // the provider declaration so a reader can tell a configured limit from a probed capability.
  describe() {
    return {
      ...this.backend.describe(),
      maxTokens: this.maxTokens,
      maxContextTokens: this.maxContextTokens,
    };
  }

  async checkAvailability({ timeoutMs = 2000 } = {}) {
    if (!this.isConfigured()) {
      return { configured: false, available: false, backend: this.backend.name, provider: this.backend.provider, detail: 'not configured' };
    }
    const h = await this.backend.health(timeoutMs);
    return {
      configured: true,
      available: h.available,
      modelListed: h.modelListed ?? null,
      // Reachability is separate evidence: a server can answer and still be unable to
      // serve the configured model. Null means the backend did not report it.
      reachable: h.reachable ?? null,
      backend: this.backend.name,
      provider: this.backend.provider,
      detail: h.detail,
    };
  }

  // Every result, success or failure, carries the request it answers, the transport class, and
  // provenance that says the text has not been verified. The class is derived here so all backends
  // agree, including a test backend: the caller never has to read a message to tell an outage from
  // an empty answer, a refusal, or a request that did not fit the context window.
  async complete({ system = '', prompt, timeoutMs, requestId = null, signal = null } = {}) {
    const id = typeof requestId === 'string' ? requestId.slice(0, 100) : null;
    const wrap = (result) => ({
      ...result,
      requestId: id,
      class: classifyGatewayResult(result),
      provenance: {
        ...provenanceOf(result.backend ?? this.backend.name, result.provider ?? this.backend.provider, result.model ?? null, id),
      },
    });
    if (!this.isConfigured()) return wrap(failure(this.backend.name, this.backend.provider, 'NOT_CONFIGURED', 'no inference backend is configured'));
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      return wrap(failure(this.backend.name, this.backend.provider, 'INVALID_PROMPT', 'prompt must be non-empty text'));
    }
    if (signal?.aborted === true) {
      return wrap(failure(this.backend.name, this.backend.provider, 'ABORTED', 'the request was cancelled before it was sent'));
    }
    const budget = contextBudget({ system, prompt, maxTokens: this.maxTokens, maxContextTokens: this.maxContextTokens });
    if (budget.exceeds) {
      return wrap(failure(
        this.backend.name,
        this.backend.provider,
        'CONTEXT_TOO_LARGE',
        `the assembled request is about ${budget.promptTokens} prompt tokens plus ${budget.outputTokens} reserved output tokens, which exceeds the declared ${budget.maxContextTokens}-token context window; the request was not sent (the count is an estimate of about 4 characters per token, not a tokenizer measurement)`,
      ));
    }
    const result = await this.backend.complete({
      system: String(system),
      prompt,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      signal,
    });
    return wrap(result);
  }
}

export function createGateway(modelConfig, fetchImpl = globalThis.fetch) {
  if (!modelConfig.url) {
    return new ModelGateway({
      backend: new NoBackend(),
      timeoutMs: modelConfig.timeoutMs,
      maxTokens: modelConfig.maxTokens ?? null,
      maxContextTokens: modelConfig.contextTokens ?? null,
    });
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
  return new ModelGateway({
    backend,
    timeoutMs: modelConfig.timeoutMs,
    maxTokens: modelConfig.maxTokens ?? common.maxTokens,
    maxContextTokens: modelConfig.contextTokens ?? null,
  });
}
