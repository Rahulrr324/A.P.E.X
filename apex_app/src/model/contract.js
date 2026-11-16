// Provider contract: what a backend *declares* about itself, in a fixed vocabulary.
//
// A declaration is read from the backend's own `describe()` and from APEX's own transport code.
// Nothing here contacts a server, calls `health()`, sends a request, or infers a capability from a
// successful call. `verified` is false and `probed` is false on every contract, and each capability
// says where the claim comes from. What a running server actually implements is a separate question,
// answered only by `status --model` or `diagnose --model`, which read the model list.
//
// The protocol table states which parts of the model architecture are implemented, which are
// contract-only, and which are enforced by APEX rather than by the provider. A contract-only entry
// is not a capability claim: no configured backend streams, and no provider is asked for a schema.
import { MAX_OUTPUT_CHARS, MAX_RESPONSE_CHARS } from './gateway.js';
import { singleLine } from '../util.js';

export const PROVIDER_CONTRACT_SCHEMA = 'apex.model-provider.v1';

export const ProviderCapability = Object.freeze({
  CHAT: 'chat',
  MODEL_LIST: 'model-list',
  CANCELLATION: 'cancellation',
  TIMEOUT: 'timeout',
  RETRY_BEFORE_ANSWER: 'retry-before-answer',
  USAGE_REPORTING: 'usage-reporting',
  STREAMING: 'streaming',
});

export const CapabilityState = Object.freeze({
  SUPPORTED: 'supported',
  WHEN_REPORTED: 'when-reported',
  UNSUPPORTED: 'unsupported',
});

const CAPABILITY_NAMES = Object.freeze(Object.values(ProviderCapability));
const STATES = new Set(Object.values(CapabilityState));

// Declarations for the two backends APEX actually ships. Evidence is a short APEX-authored phrase;
// it is not server text and does not grow with the endpoint's answer.
const DECLARED = Object.freeze({
  'openai-compatible': Object.freeze({
    [ProviderCapability.CHAT]: { state: CapabilityState.SUPPORTED, evidence: 'the backend sends /v1/chat/completions' },
    [ProviderCapability.MODEL_LIST]: { state: CapabilityState.SUPPORTED, evidence: 'readiness reads /v1/models only when status --model or diagnose --model asks' },
    [ProviderCapability.CANCELLATION]: { state: CapabilityState.SUPPORTED, evidence: 'the gateway passes the caller AbortSignal to fetch' },
    [ProviderCapability.TIMEOUT]: { state: CapabilityState.SUPPORTED, evidence: 'one deadline covers the request and reading its body' },
    [ProviderCapability.RETRY_BEFORE_ANSWER]: { state: CapabilityState.SUPPORTED, evidence: 'UNREACHABLE and INTERRUPTED attempts are retried; a timeout or a partial answer is never retried' },
    [ProviderCapability.USAGE_REPORTING]: { state: CapabilityState.WHEN_REPORTED, evidence: 'token counts and timings are recorded only when the server reports them' },
    [ProviderCapability.STREAMING]: { state: CapabilityState.UNSUPPORTED, evidence: 'the backend reads one complete response; no partial text is delivered' },
  }),
  ollama: Object.freeze({
    [ProviderCapability.CHAT]: { state: CapabilityState.SUPPORTED, evidence: 'the backend sends /api/chat' },
    [ProviderCapability.MODEL_LIST]: { state: CapabilityState.SUPPORTED, evidence: 'readiness reads /api/tags only when status --model or diagnose --model asks' },
    [ProviderCapability.CANCELLATION]: { state: CapabilityState.SUPPORTED, evidence: 'the gateway passes the caller AbortSignal to fetch' },
    [ProviderCapability.TIMEOUT]: { state: CapabilityState.SUPPORTED, evidence: 'one deadline covers the request and reading its body' },
    [ProviderCapability.RETRY_BEFORE_ANSWER]: { state: CapabilityState.SUPPORTED, evidence: 'UNREACHABLE and INTERRUPTED attempts are retried; a timeout or a partial answer is never retried' },
    [ProviderCapability.USAGE_REPORTING]: { state: CapabilityState.WHEN_REPORTED, evidence: 'token counts and nanosecond timings are recorded only when the server reports them' },
    [ProviderCapability.STREAMING]: { state: CapabilityState.UNSUPPORTED, evidence: 'the backend reads one complete response; no partial text is delivered' },
  }),
});

function unsupported(evidence) {
  const out = {};
  for (const name of CAPABILITY_NAMES) out[name] = { state: CapabilityState.UNSUPPORTED, evidence };
  return out;
}

export function declaredCapabilities(described = {}) {
  if (described.configured !== true) return unsupported('no inference backend is configured');
  const table = DECLARED[described.name];
  if (!table) return unsupported(`APEX has no capability declaration for backend "${singleLine(described.name ?? 'unknown', 64)}"`);
  return table;
}

// Which parts of the model architecture exist. "contract-only" means the contract and its
// deterministic tests exist but no configured provider uses that path; it is not a claim that a
// server implements it.
export const MODEL_PROTOCOL_CONTRACTS = Object.freeze({
  completion: Object.freeze({
    state: 'implemented',
    note: 'gateway.complete() returns either answer text or a structured failure with a transport class',
  }),
  structuredOutput: Object.freeze({
    state: 'contract-only',
    note: 'no provider is asked for a schema; APEX parses and validates one JSON object itself (src/model/structured.js), and existing line protocols keep their own parsers',
  }),
  streaming: Object.freeze({
    state: 'contract-only',
    note: 'no configured backend streams; src/model/streaming.js defines a typed chunk contract that deterministic stubs and a future provider can share',
  }),
  cancellation: Object.freeze({
    state: 'implemented',
    note: 'a caller AbortSignal is combined with the request deadline; caller cancellation is reported as ABORTED, a deadline as TIMEOUT, and partial text is discarded',
  }),
  retry: Object.freeze({
    state: 'implemented',
    note: 'only failures where no answer reached APEX are retried; a timeout is not, because the user would wait twice',
  }),
  contextBudget: Object.freeze({
    state: 'implemented-when-declared',
    note: 'when APEX_MODEL_CONTEXT_TOKENS is set, an estimated over-window request is refused before it is sent; without a declared window no estimate is enforced',
  }),
  observability: Object.freeze({
    state: 'implemented',
    note: 'every result carries a transport class and unverified provenance; reported usage and timings are kept only when present; operation records carry the same fields',
  }),
  authority: Object.freeze({
    state: 'enforced',
    note: 'model text is untrusted input; a suggestion has authority none, and only an explicit user-origin decision can accept a proposal',
  }),
});

export const TRUST_BOUNDARY = Object.freeze({
  modelText: 'untrusted',
  suggestionAuthority: 'none',
  executableWithoutUserDecision: false,
  verified: false,
  note: 'The transport never verifies an answer. A structured object is validated before use, a malformed or over-claiming object is rejected whole, and no model-origin value can grant authorization.',
});

function limit(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

// The contract APEX can state without asking the endpoint anything. `describe()` is a backend's own
// fixed description; `timeoutMs`, `maxTokens` and `maxContextTokens` are APEX configuration.
export function describeProviderContract(gateway) {
  const described = gateway && typeof gateway.describe === 'function' ? gateway.describe() : {};
  const maxTokens = limit(gateway?.maxTokens);
  const maxContextTokens = limit(gateway?.maxContextTokens);
  return {
    schema: PROVIDER_CONTRACT_SCHEMA,
    configured: described.configured === true,
    backend: described.name ?? null,
    provider: described.provider ?? null,
    endpoint: described.endpoint ?? null,
    model: described.model ?? null,
    capabilities: declaredCapabilities(described),
    limits: {
      requestTimeoutMs: limit(gateway?.timeoutMs),
      maxOutputTokens: maxTokens,
      maxOutputChars: MAX_OUTPUT_CHARS,
      maxResponseChars: MAX_RESPONSE_CHARS,
      declaredContextTokens: maxContextTokens,
      budgetEnforced: maxContextTokens !== null && maxTokens !== null,
      budgetEstimate: 'about 4 characters per token; not a tokenizer measurement',
    },
    protocol: MODEL_PROTOCOL_CONTRACTS,
    trust: TRUST_BOUNDARY,
    verified: false,
    probed: false,
    note: 'Declared from the backend description and APEX configuration. No endpoint was contacted and no capability was inferred from a successful call.',
  };
}

// Internal consistency of a contract. This checks the declaration's own rules, not a server: every
// capability name is known, every state is in the fixed vocabulary, and the limits are numbers or
// null. The action verifier also compares the identity fields with a fresh status read.
export function contractProblems(contract) {
  const problems = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return ['the contract is not an object'];
  if (contract.schema !== PROVIDER_CONTRACT_SCHEMA) problems.push('unsupported contract schema');
  if (contract.verified !== false || contract.probed !== false) problems.push('a declared contract must be marked unprobed and unverified');
  if (!contract.capabilities || typeof contract.capabilities !== 'object') problems.push('capabilities are missing');
  else {
    for (const name of CAPABILITY_NAMES) {
      const entry = contract.capabilities[name];
      if (!entry || !STATES.has(entry.state) || typeof entry.evidence !== 'string' || entry.evidence.length === 0) {
        problems.push(`capability "${name}" is missing or malformed`);
      }
    }
    for (const name of Object.keys(contract.capabilities)) {
      if (!CAPABILITY_NAMES.includes(name)) problems.push(`unexpected capability "${singleLine(name, 40)}"`);
    }
  }
  const l = contract.limits ?? {};
  for (const key of ['requestTimeoutMs', 'maxOutputTokens', 'maxOutputChars', 'maxResponseChars', 'declaredContextTokens']) {
    if (l[key] !== null && l[key] !== undefined && (!Number.isInteger(l[key]) || l[key] <= 0)) problems.push(`limit "${key}" must be a positive integer or null`);
  }
  if (typeof l.budgetEnforced !== 'boolean') problems.push('budgetEnforced must be a boolean');
  if (l.budgetEnforced === true && (l.declaredContextTokens === null || l.maxOutputTokens === null)) {
    problems.push('an enforced budget needs both a declared context window and an output budget');
  }
  return problems;
}

function capLine(name, entry) {
  return `    ${name}: ${entry.state} - ${entry.evidence}`;
}

export function renderProviderContract(contract) {
  const who = contract.configured
    ? `${contract.backend ?? 'unknown'} (provider ${contract.provider ?? 'unknown'}), model "${singleLine(contract.model ?? '', 80)}" at ${singleLine(contract.endpoint ?? '', 200)}`
    : `none configured (backend ${contract.backend ?? 'none'})`;
  const l = contract.limits;
  const budget = l.budgetEnforced
    ? `    prompt budget: enforced before sending; about ${l.declaredContextTokens} declared context tokens, ${l.maxOutputTokens} reserved for output`
    : `    prompt budget: not enforced (declare APEX_MODEL_CONTEXT_TOKENS to enable it; APEX has no tokenizer, so it does not guess a window)`;
  const caps = CAPABILITY_NAMES.map((name) => capLine(name, contract.capabilities[name])).join('\n');
  const protocols = Object.entries(contract.protocol)
    .map(([name, entry]) => `    ${name}: ${entry.state} - ${entry.note}`)
    .join('\n');
  return [
    'Model provider contract (declared, not probed; no endpoint was contacted)',
    `  ${who}`,
    '  capabilities:',
    caps,
    '  limits:',
    `    request timeout: ${l.requestTimeoutMs === null ? 'not set' : `${l.requestTimeoutMs} ms`}`,
    `    reserved output: ${l.maxOutputTokens === null ? 'not set' : `${l.maxOutputTokens} tokens`}`,
    `    output text cap: ${l.maxOutputChars} characters; response body cap: ${l.maxResponseChars} characters`,
    budget,
    '  protocols:',
    protocols,
    `  trust: ${contract.trust.note}`,
    `  ${contract.note}`,
  ].join('\n');
}
