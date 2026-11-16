// Streaming contract for model answers.
//
// No configured backend streams today: both HTTP backends read one complete response, and the
// gateway reports that as `streaming: unsupported` in its declared contract. This module defines the
// chunk vocabulary that a streaming provider, a deterministic test stub, and a future interface can
// share, and a bounded collector that decides what a chunk sequence is allowed to mean.
//
// The rules are the same ones the non-streaming path already follows:
//   - text is untrusted and control characters are removed before it is joined;
//   - a stream that ends without `done` is incomplete, not a short answer;
//   - an empty or oversized answer is a failure, not a success with less text;
//   - a caller cancellation discards partial text, and an error chunk discards it too, because a
//     prefix of an answer can be misread as the whole answer;
//   - usage counters are kept only when the provider reported finite, bounded numbers.
//
// `chunksFromResult()` adapts a complete gateway result into this vocabulary. Its chunks carry
// `simulated: true`: they describe a complete answer already in hand, not text produced
// incrementally, and a consumer must not present them as live generation.
import { CONTROL_CHARS, singleLine } from '../util.js';

export const STREAM_SCHEMA = 'apex.model-stream.v1';
export const STREAM_MAX_CHARS = 8000;
export const STREAM_MAX_CHUNKS = 100000;
const MAX_COUNT = 1_000_000_000;
const MAX_ERROR_MESSAGE = 300;

export const StreamChunkType = Object.freeze({
  TEXT: 'text',
  USAGE: 'usage',
  DONE: 'done',
  ERROR: 'error',
});

const TYPES = new Set(Object.values(StreamChunkType));
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CONTROL_CHARS_GLOBAL = new RegExp(CONTROL_CHARS.source, 'g');

function count(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null;
}

function plainMessage(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ERROR_MESSAGE
    && !CONTROL_CHARS.test(value) && !/[\r\n]/.test(value);
}

// Returns null for a well-formed chunk, or a short reason. The reason never quotes chunk text.
export function chunkProblem(chunk) {
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return 'a chunk must be an object';
  if (!TYPES.has(chunk.type)) return 'unknown chunk type';
  if (chunk.type === StreamChunkType.TEXT) {
    if (typeof chunk.text !== 'string' || chunk.text.length === 0) return 'a text chunk needs non-empty text';
    return null;
  }
  if (chunk.type === StreamChunkType.USAGE) {
    const keys = ['promptTokens', 'completionTokens'];
    const present = keys.filter((k) => chunk[k] !== undefined);
    if (present.length === 0) return 'a usage chunk needs a reported count';
    for (const key of present) {
      if (count(chunk[key]) === null) return `usage field "${key}" must be a finite, non-negative, bounded integer`;
    }
    return null;
  }
  if (chunk.type === StreamChunkType.DONE) {
    if (chunk.finishReason !== undefined && chunk.finishReason !== null
      && (typeof chunk.finishReason !== 'string' || chunk.finishReason.length > 40
        || CONTROL_CHARS.test(chunk.finishReason) || /[\r\n]/.test(chunk.finishReason))) {
      return 'finishReason must be short plain text or null';
    }
    if (chunk.truncated !== undefined && typeof chunk.truncated !== 'boolean') return 'truncated must be a boolean';
    if (chunk.simulated !== undefined && typeof chunk.simulated !== 'boolean') return 'simulated must be a boolean';
    return null;
  }
  if (!CODE_RE.test(chunk.code ?? '')) return 'an error chunk needs an upper-case error code';
  if (!plainMessage(chunk.message)) return `an error message must be plain text of at most ${MAX_ERROR_MESSAGE} characters`;
  return null;
}

function failureResult(code, message, extra) {
  return {
    ok: false,
    text: '',
    code,
    error: { code, message },
    ...extra,
  };
}

// Consumes one chunk sequence. Partial text is never returned on failure: the caller receives the
// number of characters discarded, not the text itself.
export async function collectStream(chunks, { maxChars = STREAM_MAX_CHARS, maxChunks = STREAM_MAX_CHUNKS, signal = null } = {}) {
  const counts = { text: 0, usage: 0, done: 0, error: 0 };
  let text = '';
  let usage = null;
  let finishReason = null;
  let truncated = false;
  let simulated = false;
  let seen = 0;
  const discard = () => ({ counts, usage, finishReason: null, truncated: false, simulated, discardedChars: text.length });

  if (!chunks || typeof chunks[Symbol.asyncIterator] !== 'function') {
    return failureResult('MALFORMED_STREAM', 'the stream is not an async iterable', { counts, usage: null, finishReason: null, truncated: false, simulated: false, discardedChars: 0 });
  }

  try {
    for await (const chunk of chunks) {
      if (signal?.aborted === true) {
        return failureResult('ABORTED', 'the stream was cancelled', { ...discard(), finishReason: null });
      }
      seen += 1;
      if (seen > maxChunks) {
        return failureResult('RESPONSE_TOO_LARGE', `the stream exceeded ${maxChunks} chunks`, discard());
      }
      const bad = chunkProblem(chunk);
      if (bad) return failureResult('MALFORMED_STREAM', bad, discard());
      counts[chunk.type] += 1;
      if (chunk.type === StreamChunkType.TEXT) {
        text += chunk.text.replace(CONTROL_CHARS_GLOBAL, '');
        if (chunk.simulated === true) simulated = true;
        if (text.length > maxChars) {
          return failureResult('RESPONSE_TOO_LARGE', `the answer exceeded ${maxChars} characters`, discard());
        }
        continue;
      }
      if (chunk.type === StreamChunkType.USAGE) {
        usage = {
          ...(chunk.promptTokens !== undefined ? { promptTokens: chunk.promptTokens } : {}),
          ...(chunk.completionTokens !== undefined ? { completionTokens: chunk.completionTokens } : {}),
        };
        continue;
      }
      if (chunk.type === StreamChunkType.ERROR) {
        return failureResult(chunk.code, chunk.message, discard());
      }
      finishReason = typeof chunk.finishReason === 'string' ? singleLine(chunk.finishReason, 40) : null;
      truncated = chunk.truncated === true;
      if (chunk.simulated === true) simulated = true;
      break;
    }
  } catch (err) {
    return failureResult('INTERRUPTED', `the stream ended unexpectedly (${singleLine(err?.code ?? err?.name ?? 'error', 40)})`, discard());
  }

  if (counts.done === 0) {
    return failureResult('INCOMPLETE_STREAM', 'the stream ended without a done chunk', discard());
  }
  if (text.trim().length === 0) {
    return failureResult('EMPTY_RESPONSE', 'the stream produced no answer text', { counts, usage, finishReason, truncated, simulated, discardedChars: 0 });
  }
  return { ok: true, text, counts, usage, finishReason, truncated, simulated, discardedChars: 0 };
}

// Adapts a complete gateway result to the chunk vocabulary. This does not make a non-streaming
// backend stream: every chunk is marked simulated, and the answer text arrives in one chunk.
export async function* chunksFromResult(result) {
  if (!result || result.ok !== true) {
    const code = typeof result?.error?.code === 'string' && CODE_RE.test(result.error.code) ? result.error.code : 'MALFORMED_RESPONSE';
    const raw = typeof result?.error?.message === 'string' ? result.error.message : 'the model call did not return an answer';
    const message = singleLine(raw, MAX_ERROR_MESSAGE);
    yield { type: StreamChunkType.ERROR, code, message };
    return;
  }
  if (typeof result.text === 'string' && result.text.length > 0) {
    yield { type: StreamChunkType.TEXT, text: result.text, simulated: true };
  }
  if (result.usage && typeof result.usage === 'object') {
    const usage = {};
    if (count(result.usage.promptTokens) !== null) usage.promptTokens = result.usage.promptTokens;
    if (count(result.usage.completionTokens) !== null) usage.completionTokens = result.usage.completionTokens;
    if (Object.keys(usage).length > 0) yield { type: StreamChunkType.USAGE, ...usage };
  }
  yield {
    type: StreamChunkType.DONE,
    finishReason: typeof result.finishReason === 'string' ? singleLine(result.finishReason, 40) : null,
    truncated: result.truncated === true,
    simulated: true,
  };
}
