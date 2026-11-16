// Provider-independent model architecture: declarations, context budgeting, strict structured
// output, streaming contracts, and the registered inspection action.
//
// No test here contacts an endpoint or runs inference. Every backend is a deterministic object
// literal that records the calls made to it, and every assertion is about a declaration, a
// refusal, or a parsing rule. A reply produced here is test text, not evidence about a model.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelGateway, NoBackend, OllamaBackend, OpenAICompatibleBackend,
  contextBudget, createGateway, estimateTokens,
} from '../src/model/gateway.js';
import {
  CapabilityState, MODEL_PROTOCOL_CONTRACTS, PROVIDER_CONTRACT_SCHEMA, ProviderCapability,
  contractProblems, declaredCapabilities, describeProviderContract, renderProviderContract,
} from '../src/model/contract.js';
import {
  FORBIDDEN_AUTHORITY_KEYS, MAX_DEPTH, MAX_OBJECT_CHARS, MODEL_SUGGESTION_SCHEMA,
  asSuggestion, parseModelObject, validateSchemaValue,
} from '../src/model/structured.js';
import {
  STREAM_MAX_CHARS, StreamChunkType, chunkProblem, chunksFromResult, collectStream,
} from '../src/model/streaming.js';
import { loadConfig } from '../src/config.js';
import { ValidationError } from '../src/errors.js';
import { createApp } from '../src/app.js';
import { cleanup, makeTempDataDir } from './helpers.js';

const dirs = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    try { cleanup(dirs.pop()); } catch { /* already removed */ }
  }
});

// A backend double. It reports fixed text and records every call, so a test can prove a refusal
// happened before the transport was used. `health` throws: nothing in this file may probe.
function fakeBackend({ name = 'fake', provider = 'fake', configured = true, text = 'fake answer' } = {}) {
  const calls = [];
  const healthCalls = [];
  return {
    name,
    provider,
    configured,
    calls,
    healthCalls,
    describe() {
      return {
        name,
        provider,
        configured,
        endpoint: configured ? 'http://127.0.0.1:9' : null,
        model: configured ? 'fake-model' : null,
      };
    },
    async health() {
      healthCalls.push(true);
      return { available: false, detail: 'the test double never probes' };
    },
    async complete(request) {
      calls.push(request);
      return {
        ok: true, backend: name, provider, model: 'fake-model',
        text, finishReason: 'stop', truncated: false, latencyMs: 0,
      };
    },
  };
}

describe('provider contract: declarations, not probes', () => {
  test('an unconfigured gateway declares every capability unsupported and contacts nothing', () => {
    const backend = fakeBackend({ configured: false, name: 'none', provider: 'none' });
    const contract = describeProviderContract(new ModelGateway({ backend }));
    assert.equal(contract.schema, PROVIDER_CONTRACT_SCHEMA);
    assert.equal(contract.configured, false);
    assert.equal(contract.backend, 'none');
    assert.equal(contract.endpoint, null);
    for (const name of Object.values(ProviderCapability)) {
      assert.deepEqual(contract.capabilities[name], {
        state: CapabilityState.UNSUPPORTED,
        evidence: 'no inference backend is configured',
      }, name);
    }
    assert.equal(contract.verified, false);
    assert.equal(contract.probed, false);
    assert.deepEqual(contractProblems(contract), []);
    assert.match(renderProviderContract(contract), /declared, not probed; no endpoint was contacted/);
    assert.match(renderProviderContract(contract), /none configured \(backend none\)/);
  });

  test('the OpenAI-compatible and Ollama declarations name their transport and claim no streaming', () => {
    const openai = new OpenAICompatibleBackend({ baseUrl: 'http://127.0.0.1:8080', model: 'm' });
    const ollama = new OllamaBackend({ baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2' });
    for (const backend of [openai, ollama]) {
      const contract = describeProviderContract(new ModelGateway({ backend, timeoutMs: 2500, maxTokens: 300 }));
      assert.equal(contract.configured, true);
      assert.equal(contract.capabilities.chat.state, CapabilityState.SUPPORTED);
      assert.match(contract.capabilities.chat.evidence, /chat/);
      assert.equal(contract.capabilities[ProviderCapability.MODEL_LIST].state, CapabilityState.SUPPORTED);
      assert.equal(contract.capabilities[ProviderCapability.USAGE_REPORTING].state, CapabilityState.WHEN_REPORTED);
      assert.equal(contract.capabilities[ProviderCapability.STREAMING].state, CapabilityState.UNSUPPORTED);
      assert.equal(contract.capabilities[ProviderCapability.CANCELLATION].state, CapabilityState.SUPPORTED);
      assert.equal(contract.limits.requestTimeoutMs, 2500);
      assert.equal(contract.limits.maxOutputTokens, 300);
      assert.equal(contract.limits.declaredContextTokens, null);
      assert.equal(contract.limits.budgetEnforced, false);
      assert.deepEqual(contractProblems(contract), []);
    }
    assert.equal(openai.describe().name, 'openai-compatible');
    assert.equal(ollama.describe().name, 'ollama');
  });

  test('an unknown configured backend claims nothing and says why', () => {
    const contract = describeProviderContract(new ModelGateway({ backend: fakeBackend({ name: 'acme' }) }));
    assert.equal(contract.configured, true);
    assert.equal(contract.capabilities.chat.state, CapabilityState.UNSUPPORTED);
    assert.match(contract.capabilities.chat.evidence, /no capability declaration for backend "acme"/);
    const unknown = declaredCapabilities({});
    assert.equal(unknown.chat.state, CapabilityState.UNSUPPORTED);
  });

  test('a declared contract never calls health() or complete()', async () => {
    const backend = fakeBackend();
    const gateway = new ModelGateway({ backend });
    describeProviderContract(gateway);
    renderProviderContract(describeProviderContract(gateway));
    assert.deepEqual(backend.healthCalls, [], 'a declaration is not a readiness probe');
    assert.deepEqual(backend.calls, [], 'a declaration does not send a request');
  });

  test('protocol contracts state implemented, contract-only and enforced separately', () => {
    assert.equal(MODEL_PROTOCOL_CONTRACTS.completion.state, 'implemented');
    assert.equal(MODEL_PROTOCOL_CONTRACTS.structuredOutput.state, 'contract-only');
    assert.equal(MODEL_PROTOCOL_CONTRACTS.streaming.state, 'contract-only');
    assert.equal(MODEL_PROTOCOL_CONTRACTS.contextBudget.state, 'implemented-when-declared');
    assert.equal(MODEL_PROTOCOL_CONTRACTS.authority.state, 'enforced');
    const contract = describeProviderContract(new ModelGateway({ backend: new NoBackend() }));
    assert.equal(contract.protocol, MODEL_PROTOCOL_CONTRACTS);
    assert.equal(contract.trust.suggestionAuthority, 'none');
    assert.equal(contract.trust.executableWithoutUserDecision, false);
    assert.equal(contract.trust.verified, false);
  });

  test('an enforced budget needs a declared window and an output count; malformed declarations are named', () => {
    const base = describeProviderContract(new ModelGateway({
      backend: new OpenAICompatibleBackend({ baseUrl: 'http://127.0.0.1:1', model: 'm' }),
      maxTokens: 256,
      maxContextTokens: 4096,
    }));
    assert.equal(base.limits.budgetEnforced, true);
    assert.equal(base.limits.declaredContextTokens, 4096);
    assert.match(renderProviderContract(base), /prompt budget: enforced before sending/);
    assert.match(renderProviderContract(base), /about 4096 declared context tokens/);

    const clone = () => structuredClone(base);
    const cases = [
      [(c) => { c.schema = 'apex.model-provider.v9'; }, /unsupported contract schema/],
      [(c) => { c.verified = true; }, /unprobed and unverified/],
      [(c) => { c.probed = true; }, /unprobed and unverified/],
      [(c) => { delete c.capabilities.chat; }, /capability "chat" is missing or malformed/],
      [(c) => { c.capabilities.chat.state = 'yes'; }, /capability "chat" is missing or malformed/],
      [(c) => { c.capabilities.chat.evidence = ''; }, /capability "chat" is missing or malformed/],
      [(c) => { c.capabilities.telepathy = { state: 'supported', evidence: 'x' }; }, /unexpected capability "telepathy"/],
      [(c) => { c.limits.budgetEnforced = true; c.limits.declaredContextTokens = null; }, /needs both a declared context window and an output budget/],
      [(c) => { c.limits.maxOutputTokens = 0; }, /must be a positive integer or null/],
      [(c) => { c.limits.budgetEnforced = 'yes'; }, /budgetEnforced must be a boolean/],
    ];
    for (const [tamper, expected] of cases) {
      const contract = clone();
      tamper(contract);
      assert.match(contractProblems(contract).join('\n'), expected);
    }
    assert.deepEqual(contractProblems(null), ['the contract is not an object']);
    assert.deepEqual(contractProblems([]), ['the contract is not an object']);
  });

  test('the registered model.contracts inspection reports the declaration and verifies it', async () => {
    const app = createApp({ dataDir: tempDir(), gateway: new ModelGateway({ backend: new NoBackend() }) });
    assert.equal(app.registry.get('model.contracts').permission, 'read');
    assert.equal(app.registry.get('model.contracts').plannable, false);
    const res = await app.controller.modelContracts();
    assert.equal(res.verified, true);
    assert.equal(res.data.configured, false);
    assert.equal(res.data.verified, false);
    assert.equal(res.data.probed, false);
    assert.match(res.display, /no endpoint was contacted/);
  });
});

describe('context budget: an estimate, enforced only when a window is declared', () => {
  test('the estimate is a character count, never presented as tokenization', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
    const budget = contextBudget({ system: 'abcd', prompt: 'abcde', maxTokens: 10, maxContextTokens: 100 });
    assert.equal(budget.promptTokens, 3);
    assert.equal(budget.outputTokens, 10);
    assert.equal(budget.enforced, true);
    assert.equal(budget.exceeds, false);
    assert.match(describeProviderContract(new ModelGateway({ backend: new NoBackend() })).limits.budgetEstimate, /not a tokenizer/);
  });

  test('an undeclared or malformed window enforces nothing', () => {
    for (const options of [
      { system: '', prompt: 'x'.repeat(4000), maxTokens: 10, maxContextTokens: null },
      { system: '', prompt: 'x'.repeat(4000), maxTokens: null, maxContextTokens: 100 },
      { system: '', prompt: 'x'.repeat(4000), maxTokens: 10, maxContextTokens: '100' },
      { system: '', prompt: 'x'.repeat(4000), maxTokens: 10, maxContextTokens: 0 },
      { system: '', prompt: 'x'.repeat(4000), maxTokens: -1, maxContextTokens: 100 },
    ]) {
      const budget = contextBudget(options);
      assert.equal(budget.enforced, false, JSON.stringify(options));
      assert.equal(budget.exceeds, false, JSON.stringify(options));
    }
  });

  test('the boundary is inclusive: exactly the declared window fits', () => {
    const fits = contextBudget({ system: 'a'.repeat(40), prompt: 'b'.repeat(40), maxTokens: 10, maxContextTokens: 30 });
    assert.equal(fits.promptTokens + fits.outputTokens, 30);
    assert.equal(fits.exceeds, false);
    const over = contextBudget({ system: 'a'.repeat(44), prompt: 'b'.repeat(40), maxTokens: 10, maxContextTokens: 30 });
    assert.equal(over.exceeds, true);
  });

  test('an over-window request is refused locally, before the transport is used', async () => {
    const backend = fakeBackend();
    const gateway = new ModelGateway({ backend, maxTokens: 5, maxContextTokens: 40 });
    const res = await gateway.complete({ system: 'a'.repeat(100), prompt: 'b'.repeat(200), requestId: 'op-b1' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'CONTEXT_TOO_LARGE');
    assert.equal(res.class, 'context_limit');
    assert.equal(res.requestId, 'op-b1');
    assert.equal(res.provenance.verified, false);
    assert.match(res.error.message, /about 75 prompt tokens plus 5 reserved output tokens/);
    assert.match(res.error.message, /the request was not sent/);
    assert.match(res.error.message, /estimate of about 4 characters per token, not a tokenizer measurement/);
    assert.deepEqual(backend.calls, [], 'the refusal happened before the backend was called');
  });

  test('a request within the declared window reaches the backend unchanged', async () => {
    const backend = fakeBackend({ text: 'within budget' });
    const gateway = new ModelGateway({ backend, timeoutMs: 1234, maxTokens: 5, maxContextTokens: 100 });
    const res = await gateway.complete({ system: 'sys', prompt: 'hello', signal: null });
    assert.equal(res.ok, true);
    assert.equal(res.text, 'within budget');
    assert.deepEqual(backend.calls, [{ system: 'sys', prompt: 'hello', timeoutMs: 1234, signal: null }]);
  });

  test('cancellation is checked before the budget, so an aborted request is ABORTED, not over-window', async () => {
    const backend = fakeBackend();
    const gateway = new ModelGateway({ backend, maxTokens: 5, maxContextTokens: 40 });
    const controller = new AbortController();
    controller.abort();
    const res = await gateway.complete({ prompt: 'x'.repeat(1000), signal: controller.signal });
    assert.equal(res.error.code, 'ABORTED');
    assert.equal(res.class, 'cancelled');
    assert.deepEqual(backend.calls, []);
  });

  test('configuration accepts a declared window only when it can hold one prompt', () => {
    assert.equal(loadConfig({}).model.contextTokens, null);
    assert.equal(loadConfig({ APEX_MODEL_CONTEXT_TOKENS: '8192' }).model.contextTokens, 8192);
    assert.equal(loadConfig({ APEX_MODEL_MAX_TOKENS: '128', APEX_MODEL_CONTEXT_TOKENS: '512' }).model.contextTokens, 512);
    assert.throws(() => loadConfig({ APEX_MODEL_CONTEXT_TOKENS: 'soon' }), ValidationError);
    assert.throws(() => loadConfig({ APEX_MODEL_CONTEXT_TOKENS: '511' }), /must be between 512 and 10000000/);
    assert.throws(() => loadConfig({ APEX_MODEL_CONTEXT_TOKENS: '512' }), /must be greater than APEX_MODEL_MAX_TOKENS/);
    assert.throws(() => loadConfig({ APEX_MODEL_MAX_TOKENS: '1024', APEX_MODEL_CONTEXT_TOKENS: '1024' }), ValidationError);
  });

  test('the assembled gateway carries the declared window, configured or not', () => {
    const configured = createGateway({
      url: 'http://127.0.0.1:1', name: 'm', timeoutMs: 1000, maxTokens: 64, contextTokens: 4096, allowRemote: false,
    });
    assert.equal(configured.maxTokens, 64);
    assert.equal(configured.maxContextTokens, 4096);
    const none = createGateway({ url: null, timeoutMs: 1000, maxTokens: 64, contextTokens: 4096 });
    assert.equal(none.maxContextTokens, 4096);
    assert.equal(none.isConfigured(), false);
  });
});

// ---- structured output -------------------------------------------------------
const SCHEMA = {
  type: 'object',
  required: ['answer', 'confidence'],
  additionalProperties: false,
  properties: {
    answer: { type: 'string', minLength: 1, maxLength: 100 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    tags: { type: 'array', maxItems: 3, items: { type: 'string' } },
    count: { type: 'integer', minimum: 0, maximum: 10 },
    ok: { type: 'boolean' },
    nothing: { type: 'null' },
    mood: { enum: ['calm', 'tense'] },
    nested: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: false },
  },
};
const VALID = {
  answer: 'a bounded answer',
  confidence: 0.5,
  tags: ['one'],
  count: 2,
  ok: true,
  nothing: null,
  mood: 'calm',
  nested: { note: 'inside' },
};

describe('structured output: one validated object or a refusal', () => {
  test('one conforming JSON object is accepted', () => {
    const res = parseModelObject(JSON.stringify(VALID), SCHEMA);
    assert.equal(res.ok, true);
    assert.deepEqual(res.value, VALID);
    assert.deepEqual(res.problems, []);
    assert.equal(res.chars, JSON.stringify(VALID).length);
  });

  test('prose, a code fence and a top-level array are refused rather than stripped', () => {
    for (const text of [
      `Here is the answer: ${JSON.stringify(VALID)}`,
      `\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``,
      `[${JSON.stringify(VALID)}]`,
      `"${JSON.stringify(VALID)}"`,
    ]) {
      const res = parseModelObject(text, SCHEMA);
      assert.equal(res.ok, false, text);
      assert.equal(res.value, null);
      assert.equal(res.problems[0].code, 'not-an-object');
    }
  });

  test('empty, oversized and invalid JSON are named failures', () => {
    assert.equal(parseModelObject('   ', SCHEMA).problems[0].code, 'empty');
    assert.equal(parseModelObject(null, SCHEMA).problems[0].code, 'empty');
    const oversized = parseModelObject(`{${' '.repeat(200)}}`, SCHEMA, { maxChars: 100 });
    assert.equal(oversized.problems[0].code, 'too-large');
    assert.match(oversized.problems[0].message, /the limit is 100/);
    assert.equal(parseModelObject('{"answer":', SCHEMA).problems[0].code, 'not-an-object');
    assert.equal(parseModelObject('{"answer":,}', SCHEMA).problems[0].code, 'invalid-json');
    assert.equal(MAX_OBJECT_CHARS, 100000);
  });

  test('schema violations are reported by path and nothing partial is returned', () => {
    const cases = [
      [{ ...VALID, extra: 1 }, 'unexpected'],
      [(() => { const v = { ...VALID }; delete v.answer; return v; })(), 'missing'],
      [{ ...VALID, answer: '' }, 'too-short'],
      [{ ...VALID, answer: 'x'.repeat(101) }, 'too-long'],
      [{ ...VALID, confidence: 2 }, 'too-large'],
      [{ ...VALID, confidence: -1 }, 'too-small'],
      [{ ...VALID, count: 1.5 }, 'not-an-integer'],
      [{ ...VALID, count: 11 }, 'too-large'],
      [{ ...VALID, tags: ['a', 'b', 'c', 'd'] }, 'too-many-items'],
      [{ ...VALID, tags: ['a', 2] }, 'not-a-string'],
      [{ ...VALID, ok: 'yes' }, 'not-a-boolean'],
      [{ ...VALID, nothing: 0 }, 'not-null'],
      [{ ...VALID, mood: 'angry' }, 'not-in-enum'],
      [{ ...VALID, nested: { note: 5 } }, 'not-a-string'],
      [{ ...VALID, nested: { other: 'x' } }, 'unexpected'],
    ];
    for (const [value, code] of cases) {
      const res = parseModelObject(JSON.stringify(value), SCHEMA);
      assert.equal(res.ok, false, JSON.stringify(value));
      assert.equal(res.value, null);
      assert.ok(res.problems.some((p) => p.code === code), `${code} not reported: ${JSON.stringify(res.problems)}`);
    }
  });

  test('authority-shaped and prototype-mutating keys are refused at any depth and in any case', () => {
    const authority = JSON.parse(JSON.stringify(VALID));
    authority.Authorized = true;
    const res = parseModelObject(JSON.stringify(authority), SCHEMA);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.code === 'authority-key'));

    const nested = JSON.parse(JSON.stringify(VALID));
    nested.nested.permission = 'write';
    const deep = parseModelObject(JSON.stringify(nested), SCHEMA);
    assert.equal(deep.ok, false);
    assert.ok(deep.problems.some((p) => p.code === 'authority-key'));

    const proto = JSON.parse('{"answer":"x","confidence":0.5,"__proto__":{"polluted":true}}');
    const unsafe = parseModelObject(JSON.stringify(proto), SCHEMA);
    assert.equal(unsafe.ok, false);
    assert.ok(unsafe.problems.some((p) => p.code === 'unsafe-key'));

    assert.deepEqual(FORBIDDEN_AUTHORITY_KEYS, [
      'authorization', 'authorized', 'permission', 'permissions', 'grant', 'grants',
      'verified', 'verifier', 'executed', 'executable', 'approved', 'authority', 'origin',
    ]);
  });

  test('the supported subset bounds nesting and property count; an unknown type is a schema error', () => {
    let schema = { type: 'string' };
    let value = 'leaf';
    for (let i = 0; i <= MAX_DEPTH; i += 1) {
      schema = { type: 'object', properties: { a: schema }, additionalProperties: false };
      value = { a: value };
    }
    const deep = validateSchemaValue(value, schema);
    assert.ok(deep.some((p) => p.code === 'too-deep'), JSON.stringify(deep));

    const flat = { type: 'object', maxProperties: 2, properties: {}, additionalProperties: true };
    assert.equal(validateSchemaValue({ a: 1, b: 2, c: 3 }, flat)[0].code, 'too-many-properties');
    assert.equal(validateSchemaValue({ a: 1 }, { type: 'mystery' })[0].code, 'bad-schema');
    assert.deepEqual(validateSchemaValue(1, { type: 'object' }).map((p) => p.code), ['not-an-object']);
    assert.deepEqual(validateSchemaValue([], { type: 'array', minItems: 1 }).map((p) => p.code), ['too-few-items']);
  });

  test('a parsed payload is wrapped as a suggestion with no authority', () => {
    const { value } = parseModelObject(JSON.stringify(VALID), SCHEMA);
    const suggestion = asSuggestion(value, { kind: 'draft-reply' });
    assert.equal(Object.isFrozen(suggestion), true);
    assert.equal(suggestion.schema, MODEL_SUGGESTION_SCHEMA);
    assert.equal(suggestion.kind, 'draft-reply');
    assert.equal(suggestion.authority, 'none');
    assert.equal(suggestion.executable, false);
    assert.equal(suggestion.verified, false);
    assert.equal(suggestion.recorded, false);
    assert.equal(suggestion.payload, value);
    assert.equal(asSuggestion(value).kind, null);
    assert.equal(asSuggestion(value, { kind: 'x'.repeat(65) }).kind, null);
  });
});

// ---- streaming ---------------------------------------------------------------
async function* chunksOf(items) {
  for (const item of items) yield item;
}

describe('streaming contract: typed chunks, no partial answer on failure', () => {
  test('chunk validation names the broken field and never quotes the text', () => {
    assert.equal(chunkProblem({ type: StreamChunkType.TEXT, text: 'ok' }), null);
    assert.equal(chunkProblem({ type: StreamChunkType.USAGE, promptTokens: 1, completionTokens: 2 }), null);
    assert.equal(chunkProblem({ type: StreamChunkType.DONE, finishReason: 'stop', truncated: false, simulated: true }), null);
    assert.equal(chunkProblem({ type: StreamChunkType.ERROR, code: 'TIMEOUT', message: 'no response' }), null);
    assert.match(chunkProblem(null), /must be an object/);
    assert.match(chunkProblem({ type: 'delta' }), /unknown chunk type/);
    assert.match(chunkProblem({ type: StreamChunkType.TEXT, text: '' }), /non-empty text/);
    assert.match(chunkProblem({ type: StreamChunkType.USAGE }), /reported count/);
    assert.match(chunkProblem({ type: StreamChunkType.USAGE, promptTokens: -1 }), /finite, non-negative/);
    assert.match(chunkProblem({ type: StreamChunkType.ERROR, code: 'timeout', message: 'x' }), /upper-case error code/);
    assert.match(chunkProblem({ type: StreamChunkType.ERROR, code: 'TIMEOUT', message: 'line\nbreak' }), /plain text/);
    assert.match(chunkProblem({ type: StreamChunkType.DONE, finishReason: 'x'.repeat(41) }), /short plain text/);
  });

  test('text, usage and done produce one bounded answer and keep reported counts', async () => {
    const res = await collectStream(chunksOf([
      { type: StreamChunkType.TEXT, text: 'Hello ' },
      { type: StreamChunkType.TEXT, text: 'world' },
      { type: StreamChunkType.USAGE, promptTokens: 3, completionTokens: 2 },
      { type: StreamChunkType.DONE, finishReason: 'stop', truncated: false },
    ]));
    assert.equal(res.ok, true);
    assert.equal(res.text, 'Hello world');
    assert.deepEqual(res.counts, { text: 2, usage: 1, done: 1, error: 0 });
    assert.deepEqual(res.usage, { promptTokens: 3, completionTokens: 2 });
    assert.equal(res.finishReason, 'stop');
    assert.equal(res.truncated, false);
    assert.equal(res.simulated, false);
    assert.equal(res.discardedChars, 0);
  });

  test('control characters are removed before chunks are joined', async () => {
    const res = await collectStream(chunksOf([
      { type: StreamChunkType.TEXT, text: 'a\u001b[31mb\n' },
      { type: StreamChunkType.DONE },
    ]));
    assert.equal(res.ok, true);
    assert.equal(res.text, 'a[31mb\n');
    assert.doesNotMatch(res.text, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  });

  test('a stream without done, or with no text, is a failure with no partial answer', async () => {
    const incomplete = await collectStream(chunksOf([
      { type: StreamChunkType.TEXT, text: 'partial' },
    ]));
    assert.equal(incomplete.ok, false);
    assert.equal(incomplete.code, 'INCOMPLETE_STREAM');
    assert.equal(incomplete.text, '');
    assert.equal(incomplete.counts.text, 1);
    assert.equal(incomplete.discardedChars, 7);

    const empty = await collectStream(chunksOf([
      { type: StreamChunkType.TEXT, text: '   ' },
      { type: StreamChunkType.DONE },
    ]));
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'EMPTY_RESPONSE');
    assert.equal(empty.text, '');
  });

  test('an error or malformed chunk discards text that came before it', async () => {
    const errored = await collectStream(chunksOf([
      { type: StreamChunkType.TEXT, text: 'prefix' },
      { type: StreamChunkType.ERROR, code: 'PROVIDER_FAILURE', message: 'the provider stopped' },
    ]));
    assert.equal(errored.ok, false);
    assert.equal(errored.code, 'PROVIDER_FAILURE');
    assert.equal(errored.text, '');
    assert.equal(errored.discardedChars, 6);

    const malformed = await collectStream(chunksOf([
      { type: StreamChunkType.TEXT, text: 'prefix' },
      { type: 'delta', text: 'more' },
    ]));
    assert.equal(malformed.ok, false);
    assert.equal(malformed.code, 'MALFORMED_STREAM');
    assert.equal(malformed.text, '');
    assert.equal(malformed.discardedChars, 6);

    const notIterable = await collectStream(null);
    assert.equal(notIterable.code, 'MALFORMED_STREAM');
    assert.equal(notIterable.text, '');
  });

  test('an iterator that throws is INTERRUPTED, not a short answer', async () => {
    async function* broken() {
      yield { type: StreamChunkType.TEXT, text: 'start' };
      const err = new Error('socket closed');
      err.code = 'ECONNRESET';
      throw err;
    }
    const res = await collectStream(broken());
    assert.equal(res.ok, false);
    assert.equal(res.code, 'INTERRUPTED');
    assert.equal(res.text, '');
    assert.equal(res.discardedChars, 5);
    assert.match(res.error.message, /ECONNRESET/);
  });

  test('character and chunk limits fail closed', async () => {
    const tooLong = await collectStream(chunksOf([
      { type: StreamChunkType.TEXT, text: 'abcdefgh' },
      { type: StreamChunkType.DONE },
    ]), { maxChars: 5 });
    assert.equal(tooLong.code, 'RESPONSE_TOO_LARGE');
    assert.equal(tooLong.text, '');
    assert.equal(tooLong.discardedChars, 8);

    const tooMany = await collectStream(chunksOf([
      { type: StreamChunkType.TEXT, text: 'a' },
      { type: StreamChunkType.TEXT, text: 'b' },
      { type: StreamChunkType.TEXT, text: 'c' },
      { type: StreamChunkType.DONE },
    ]), { maxChunks: 2 });
    assert.equal(tooMany.code, 'RESPONSE_TOO_LARGE');
    assert.equal(tooMany.text, '');
    assert.equal(tooMany.discardedChars, 2);
    assert.equal(STREAM_MAX_CHARS, 8000);
  });

  test('a caller cancellation mid-stream discards the prefix', async () => {
    const controller = new AbortController();
    async function* aborting() {
      yield { type: StreamChunkType.TEXT, text: 'partial' };
      controller.abort();
      yield { type: StreamChunkType.TEXT, text: ' after cancellation' };
      yield { type: StreamChunkType.DONE };
    }
    const res = await collectStream(aborting(), { signal: controller.signal });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ABORTED');
    assert.equal(res.text, '');
    assert.equal(res.discardedChars, 7);
    assert.equal(res.counts.text, 1);
  });

  test('a complete gateway result becomes simulated chunks, never live generation', async () => {
    const result = {
      ok: true, text: 'one complete answer', finishReason: 'stop', truncated: false,
      usage: { promptTokens: 4, completionTokens: 3 },
    };
    const raw = [];
    for await (const chunk of chunksFromResult(result)) raw.push(chunk);
    assert.deepEqual(raw, [
      { type: StreamChunkType.TEXT, text: 'one complete answer', simulated: true },
      { type: StreamChunkType.USAGE, promptTokens: 4, completionTokens: 3 },
      { type: StreamChunkType.DONE, finishReason: 'stop', truncated: false, simulated: true },
    ]);
    const collected = await collectStream(chunksFromResult(result));
    assert.equal(collected.ok, true);
    assert.equal(collected.text, 'one complete answer');
    assert.equal(collected.simulated, true, 'a non-streaming backend cannot be presented as streaming');
    assert.deepEqual(collected.usage, { promptTokens: 4, completionTokens: 3 });
  });

  test('a failed result becomes one error chunk and is not a partial answer', async () => {
    const failure = { ok: false, error: { code: 'TIMEOUT', message: 'no response within 30 ms' } };
    const raw = [];
    for await (const chunk of chunksFromResult(failure)) raw.push(chunk);
    assert.deepEqual(raw, [{ type: StreamChunkType.ERROR, code: 'TIMEOUT', message: 'no response within 30 ms' }]);
    assert.equal(chunkProblem(raw[0]), null);
    const collected = await collectStream(chunksFromResult(failure));
    assert.equal(collected.ok, false);
    assert.equal(collected.code, 'TIMEOUT');
    assert.equal(collected.text, '');

    const badCode = { ok: false, error: { code: 'not a code', message: 'x' } };
    const [chunk] = await (async () => {
      const out = [];
      for await (const c of chunksFromResult(badCode)) out.push(c);
      return out;
    })();
    assert.equal(chunk.code, 'MALFORMED_RESPONSE');
  });

  test('implausible usage and missing text are not repaired', async () => {
    const implausible = {
      ok: true, text: 'answer', finishReason: 'stop', truncated: true,
      usage: { promptTokens: 1e12, completionTokens: 2 },
    };
    const collected = await collectStream(chunksFromResult(implausible));
    assert.equal(collected.ok, true);
    assert.deepEqual(collected.usage, { completionTokens: 2 });
    assert.equal(collected.truncated, true);

    const empty = { ok: true, text: '', finishReason: 'stop' };
    const emptyCollected = await collectStream(chunksFromResult(empty));
    assert.equal(emptyCollected.ok, false);
    assert.equal(emptyCollected.code, 'EMPTY_RESPONSE');
  });
});
