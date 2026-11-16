// Neural runtime boundary: a versioned, typed contract for an external runtime that may
// only propose. No runtime is connected in this build. Nothing here spawns a process,
// imports the research tree, contacts an endpoint, writes a store, or executes a proposal.
//
// The wire format is the proposal documented in README.md ("Neural integration boundary"),
// realized as code so the limits and refusals are testable rather than prose:
//
//   APEX -> runtime  {"schema":"apex.neural.request/1", "requestId", "kind":"propose",
//                     "input":{"text"}, "limits":{...}, "deadlineMs"}
//   runtime -> APEX  {"schema":"apex.neural.response/1", "requestId", "status",
//                     "proposals":[...], "runtime":{...}, "error":{...}}
//
// A parsed proposal is untrusted data. Its confidence is advisory, it carries no origin,
// and every field that could claim authority is refused whole rather than ignored.
import { ValidationError } from '../errors.js';
import { SINGLE_LINE_FORBIDDEN, singleLine, CONTROL_CHARS } from '../util.js';

export const NEURAL_REQUEST_SCHEMA = 'apex.neural.request/1';
export const NEURAL_RESPONSE_SCHEMA = 'apex.neural.response/1';
export const MAX_REQUEST_CHARS = 65536;
export const MAX_RESPONSE_CHARS = 1000000;
export const MAX_PROPOSALS = 8;
export const MAX_PLAN_STEPS = 8;
export const MAX_OUTPUT_CHARS = 8000;
export const DEFAULT_DEADLINE_MS = 5000;
export const MAX_DEADLINE_MS = 30000;

export const PROPOSAL_KINDS = Object.freeze(['knowledge_claim', 'memory_claim', 'plan']);

// The classes a caller can branch on. They keep "answered with proposals", "answered with
// nothing", "the runtime is absent", "the runtime failed", and "the reply is untrustworthy"
// apart, so no caller has to read prose to decide what happened.
export const NeuralOutcome = Object.freeze({
  VALID: 'valid',
  EMPTY: 'empty',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  MALFORMED: 'malformed',
  TOO_LARGE: 'too_large',
  UNSUPPORTED_VERSION: 'unsupported_version',
  IN_PROGRESS: 'in_progress',
});

// Failure codes mirror the gateway's vocabulary where the meaning is the same.
export const NeuralFailureCode = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNAVAILABLE: 'UNAVAILABLE',
  UNREACHABLE: 'UNREACHABLE',
  RUNTIME_ERROR: 'RUNTIME_ERROR',
  TIMEOUT: 'TIMEOUT',
  INTERRUPTED: 'INTERRUPTED',
  CANCELLED: 'CANCELLED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  REQUEST_IN_PROGRESS: 'REQUEST_IN_PROGRESS',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
});

export function outcomeForCode(code) {
  switch (code) {
    case NeuralFailureCode.TIMEOUT: return NeuralOutcome.TIMEOUT;
    case NeuralFailureCode.CANCELLED: return NeuralOutcome.CANCELLED;
    case NeuralFailureCode.INVALID_REQUEST: return NeuralOutcome.MALFORMED;
    case NeuralFailureCode.REQUEST_IN_PROGRESS: return NeuralOutcome.IN_PROGRESS;
    case NeuralFailureCode.MALFORMED_RESPONSE: return NeuralOutcome.MALFORMED;
    case NeuralFailureCode.RESPONSE_TOO_LARGE: return NeuralOutcome.TOO_LARGE;
    case NeuralFailureCode.UNSUPPORTED_VERSION: return NeuralOutcome.UNSUPPORTED_VERSION;
    case NeuralFailureCode.EMPTY_RESPONSE: return NeuralOutcome.EMPTY;
    case NeuralFailureCode.RUNTIME_ERROR: return NeuralOutcome.ERROR;
    default: return NeuralOutcome.UNAVAILABLE;
  }
}

const REQUEST_FIELDS = ['schema', 'requestId', 'kind', 'input', 'limits', 'deadlineMs'];
const RESPONSE_FIELDS = ['schema', 'requestId', 'status', 'proposals', 'runtime', 'error'];
const RUNTIME_FIELDS = ['name', 'version', 'modelId'];
const ERROR_FIELDS = ['code', 'message'];
const PROPOSAL_FIELDS = ['kind', 'confidence', 'payload'];
const KNOWLEDGE_FIELDS = ['subject', 'relationship', 'object', 'evidence'];
const MEMORY_FIELDS = ['content'];
const PLAN_FIELDS = ['steps'];
const STEP_FIELDS = ['id', 'description', 'action', 'input', 'depends_on'];

function unexpectedField(fields, value, where) {
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) return `unexpected field "${singleLine(key, 40)}" ${where}`;
  }
  return null;
}

function plainText(value, min, max, label, { singleLine: oneLine = false } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    return `${label} must be text of ${min} to ${max} characters`;
  }
  if (CONTROL_CHARS.test(value) || /[\u007f-\u009f]/.test(value)) return `${label} must not contain control characters`;
  if (oneLine && SINGLE_LINE_FORBIDDEN.test(value)) return `${label} must be one line`;
  return null;
}

function boundedInt(value, min, max, label) {
  return Number.isInteger(value) && value >= min && value <= max ? null : `${label} must be an integer from ${min} to ${max}`;
}

// Returns { request, line }. Validation is strict: an out-of-range limit is refused, never
// clamped, because a runtime that silently answers fewer proposals than APEX can account for
// would make the count a guess.
export function buildNeuralRequest({ requestId, text, limits = {}, deadlineMs = DEFAULT_DEADLINE_MS } = {}) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(requestId)) {
    throw new ValidationError('a neural requestId must be 1-100 letters, digits, dots, colons, underscores, or hyphens', 'INVALID_INPUT');
  }
  const body = typeof text === 'string' ? text : '';
  if (body.trim().length === 0) throw new ValidationError('neural request text must be non-empty', 'INVALID_INPUT');
  if (body.length > MAX_REQUEST_CHARS) {
    throw new ValidationError(`neural request text is ${body.length} characters; the limit is ${MAX_REQUEST_CHARS}`, 'INVALID_INPUT');
  }
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new ValidationError('neural request limits must be an object', 'INVALID_INPUT');
  }
  const unexpected = unexpectedField(['maxProposals', 'maxPlanSteps', 'maxOutputChars'], limits, 'in the request limits');
  if (unexpected) throw new ValidationError(unexpected, 'INVALID_INPUT');
  const wanted = {
    maxProposals: limits.maxProposals ?? MAX_PROPOSALS,
    maxPlanSteps: limits.maxPlanSteps ?? MAX_PLAN_STEPS,
    maxOutputChars: limits.maxOutputChars ?? MAX_OUTPUT_CHARS,
  };
  const limitsProblem = boundedInt(wanted.maxProposals, 1, MAX_PROPOSALS, 'maxProposals')
    ?? boundedInt(wanted.maxPlanSteps, 1, MAX_PLAN_STEPS, 'maxPlanSteps')
    ?? boundedInt(wanted.maxOutputChars, 1, MAX_OUTPUT_CHARS, 'maxOutputChars')
    ?? boundedInt(deadlineMs, 1, MAX_DEADLINE_MS, 'deadlineMs');
  if (limitsProblem) throw new ValidationError(limitsProblem, 'INVALID_INPUT');
  const request = {
    schema: NEURAL_REQUEST_SCHEMA,
    requestId,
    kind: 'propose',
    input: { text: body },
    limits: wanted,
    deadlineMs,
  };
  const line = JSON.stringify(request);
  if (line.length > MAX_REQUEST_CHARS) {
    // Framing can push a body that passed its own bound over the wire cap. The request is
    // refused before it is sent; it is never truncated.
    throw new ValidationError(`the neural request line is ${line.length} characters; the limit is ${MAX_REQUEST_CHARS}`, 'INVALID_INPUT');
  }
  return { request, line };
}

function failure(code, message, detail = {}) {
  return {
    ok: false,
    outcome: outcomeForCode(code),
    code,
    message,
    proposals: [],
    ignoredKinds: [],
    counts: { received: 0, accepted: 0, ignored: 0 },
    runtime: null,
    error: null,
    ...detail,
  };
}

function runtimeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { problem: 'runtime must be an object' };
  const unexpected = unexpectedField(RUNTIME_FIELDS, value, 'in the runtime identity');
  if (unexpected) return { problem: unexpected };
  const nameProblem = plainText(value.name, 1, 80, 'runtime name', { singleLine: true });
  if (nameProblem) return { problem: nameProblem };
  const versionProblem = plainText(value.version, 1, 40, 'runtime version', { singleLine: true });
  if (versionProblem) return { problem: versionProblem };
  if (value.modelId !== null && value.modelId !== undefined) {
    const modelProblem = plainText(value.modelId, 1, 100, 'runtime modelId', { singleLine: true });
    if (modelProblem) return { problem: modelProblem };
  }
  return {
    runtime: Object.freeze({
      name: value.name,
      version: value.version,
      modelId: typeof value.modelId === 'string' ? value.modelId : null,
    }),
  };
}

function knowledgePayload(payload, maxChars) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { problem: 'a knowledge_claim payload must be an object' };
  const unexpected = unexpectedField(KNOWLEDGE_FIELDS, payload, 'in a knowledge_claim payload');
  if (unexpected) return { problem: unexpected };
  for (const field of ['subject', 'relationship', 'object']) {
    const problem = plainText(payload[field], 1, Math.min(500, maxChars), `knowledge_claim ${field}`);
    if (problem) return { problem };
  }
  if (payload.evidence !== undefined) {
    const problem = plainText(payload.evidence, 0, Math.min(1000, maxChars), 'knowledge_claim evidence');
    if (problem) return { problem };
  }
  return {
    payload: {
      subject: payload.subject,
      relationship: payload.relationship,
      object: payload.object,
      ...(payload.evidence !== undefined ? { evidence: payload.evidence } : {}),
    },
  };
}

function memoryPayload(payload, maxChars) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { problem: 'a memory_claim payload must be an object' };
  const unexpected = unexpectedField(MEMORY_FIELDS, payload, 'in a memory_claim payload');
  if (unexpected) return { problem: unexpected };
  // A runtime cannot mark a memory private, or carry any other field that would change how
  // APEX treats it. `{content}` only; sensitivity is decided by the user-origin action later.
  const problem = plainText(payload.content, 1, Math.min(4000, maxChars), 'memory_claim content');
  if (problem) return { problem };
  return { payload: { content: payload.content } };
}

function planPayload(payload, maxSteps, maxChars) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { problem: 'a plan payload must be an object' };
  const unexpected = unexpectedField(PLAN_FIELDS, payload, 'in a plan payload');
  if (unexpected) return { problem: unexpected };
  if (!Array.isArray(payload.steps) || payload.steps.length === 0 || payload.steps.length > maxSteps) {
    return { problem: `a plan payload must carry 1 to ${maxSteps} steps` };
  }
  const steps = [];
  for (let i = 0; i < payload.steps.length; i += 1) {
    const raw = payload.steps[i];
    const label = `plan step ${i + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problem: `${label} must be an object` };
    const extra = unexpectedField(STEP_FIELDS, raw, `in ${label}`);
    if (extra) return { problem: extra };
    const idProblem = plainText(raw.id, 1, 40, `${label} id`, { singleLine: true });
    if (idProblem) return { problem: idProblem };
    if (!/^[a-z0-9_]+$/.test(raw.id)) return { problem: `${label} id must use lowercase letters, digits, and underscores` };
    const descriptionProblem = plainText(raw.description, 1, Math.min(200, maxChars), `${label} description`, { singleLine: true });
    if (descriptionProblem) return { problem: descriptionProblem };
    const actionProblem = plainText(raw.action, 1, 80, `${label} action`, { singleLine: true });
    if (actionProblem) return { problem: actionProblem };
    if (!/^[a-z0-9]+(?:[._][a-z0-9]+)*$/.test(raw.action)) return { problem: `${label} action must match the action-name grammar` };
    if (!raw.input || typeof raw.input !== 'object' || Array.isArray(raw.input)) return { problem: `${label} input must be an object` };
    if (raw.depends_on !== undefined && (!Array.isArray(raw.depends_on) || raw.depends_on.some((dep) => typeof dep !== 'string'))) {
      return { problem: `${label} depends_on must be a list of step ids` };
    }
    steps.push({
      id: raw.id,
      description: raw.description,
      action: raw.action,
      input: Object.freeze({ ...raw.input }),
      depends_on: Object.freeze([...(raw.depends_on ?? [])]),
    });
  }
  return { payload: { steps: Object.freeze(steps) } };
}

function proposalValue(raw, limits) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problem: 'a proposal must be an object' };
  const unexpected = unexpectedField(PROPOSAL_FIELDS, raw, 'in a proposal');
  if (unexpected) return { problem: unexpected };
  if (typeof raw.kind !== 'string' || raw.kind.length === 0 || raw.kind.length > 40 || SINGLE_LINE_FORBIDDEN.test(raw.kind)) {
    return { problem: 'a proposal kind must be short plain text' };
  }
  if (raw.confidence !== undefined
    && (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1)) {
    return { problem: 'a proposal confidence must be a number from 0 to 1' };
  }
  if (!PROPOSAL_KINDS.includes(raw.kind)) return { ignored: raw.kind };
  let payload;
  if (raw.kind === 'knowledge_claim') payload = knowledgePayload(raw.payload, limits.maxOutputChars);
  else if (raw.kind === 'memory_claim') payload = memoryPayload(raw.payload, limits.maxOutputChars);
  else payload = planPayload(raw.payload, limits.maxPlanSteps, limits.maxOutputChars);
  if (payload.problem) return { problem: payload.problem };
  return {
    proposal: Object.freeze({
      kind: raw.kind,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
      advisory: true,
      authorizes: false,
      payload: Object.freeze(payload.payload),
    }),
  };
}

// Validate one runtime reply against the request it answers. The whole reply is rejected on
// any malformed or authority-shaped part: nothing is repaired, and no proposal survives a
// reply that failed validation.
export function validateNeuralResponse(raw, request) {
  if (typeof raw !== 'string') return failure(NeuralFailureCode.MALFORMED_RESPONSE, 'the runtime reply must be one JSON line');
  if (raw.length > MAX_RESPONSE_CHARS) {
    return failure(NeuralFailureCode.RESPONSE_TOO_LARGE, `the runtime reply is ${raw.length} characters; the limit is ${MAX_RESPONSE_CHARS}`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return failure(NeuralFailureCode.MALFORMED_RESPONSE, 'the runtime reply is not JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return failure(NeuralFailureCode.MALFORMED_RESPONSE, 'the runtime reply must be one JSON object');
  }
  const unexpected = unexpectedField(RESPONSE_FIELDS, value, 'in the runtime reply');
  if (unexpected) return failure(NeuralFailureCode.MALFORMED_RESPONSE, unexpected);
  if (value.schema !== NEURAL_RESPONSE_SCHEMA) {
    return failure(
      NeuralFailureCode.UNSUPPORTED_VERSION,
      `the runtime answered with schema ${JSON.stringify(singleLine(value.schema, 60))}; APEX sends ${NEURAL_RESPONSE_SCHEMA}`,
    );
  }
  if (value.requestId !== request.requestId) {
    return failure(NeuralFailureCode.MALFORMED_RESPONSE, 'the runtime reply is for a different requestId');
  }
  if (!['ok', 'unavailable', 'error'].includes(value.status)) {
    return failure(NeuralFailureCode.MALFORMED_RESPONSE, 'the runtime status must be "ok", "unavailable", or "error"');
  }
  const limits = request.limits ?? { maxProposals: MAX_PROPOSALS, maxPlanSteps: MAX_PLAN_STEPS, maxOutputChars: MAX_OUTPUT_CHARS };

  if (value.status === 'unavailable') {
    if (Array.isArray(value.proposals) && value.proposals.length > 0) {
      return failure(NeuralFailureCode.MALFORMED_RESPONSE, 'an unavailable runtime cannot also carry proposals');
    }
    const identity = value.runtime === undefined || value.runtime === null ? {} : runtimeIdentity(value.runtime);
    if (identity.problem) return failure(NeuralFailureCode.MALFORMED_RESPONSE, identity.problem);
    return failure(
      NeuralFailureCode.UNAVAILABLE,
      'the neural runtime reports that it is unavailable',
      { runtime: identity.runtime ?? null },
    );
  }

  const identity = runtimeIdentity(value.runtime);
  if (identity.problem) return failure(NeuralFailureCode.MALFORMED_RESPONSE, identity.problem);

  if (value.status === 'error') {
    if (Array.isArray(value.proposals) && value.proposals.length > 0) {
      return failure(NeuralFailureCode.MALFORMED_RESPONSE, 'an error reply cannot also carry proposals');
    }
    const error = value.error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
      return failure(NeuralFailureCode.MALFORMED_RESPONSE, 'an error reply must carry an error object');
    }
    const extra = unexpectedField(ERROR_FIELDS, error, 'in the runtime error');
    if (extra) return failure(NeuralFailureCode.MALFORMED_RESPONSE, extra);
    const codeProblem = plainText(error.code, 1, 60, 'runtime error code', { singleLine: true });
    if (codeProblem) return failure(NeuralFailureCode.MALFORMED_RESPONSE, codeProblem);
    const messageProblem = plainText(error.message, 1, 500, 'runtime error message');
    if (messageProblem) return failure(NeuralFailureCode.MALFORMED_RESPONSE, messageProblem);
    const result = failure(NeuralFailureCode.RUNTIME_ERROR, 'the neural runtime reported an error', { runtime: identity.runtime });
    result.error = Object.freeze({ code: error.code, message: error.message });
    return result;
  }

  if (!Array.isArray(value.proposals)) {
    return failure(NeuralFailureCode.MALFORMED_RESPONSE, 'an ok reply must carry a proposals list', { runtime: identity.runtime });
  }
  if (value.proposals.length > limits.maxProposals) {
    return failure(
      NeuralFailureCode.MALFORMED_RESPONSE,
      `the runtime returned ${value.proposals.length} proposals; the request allowed ${limits.maxProposals}`,
      { runtime: identity.runtime },
    );
  }
  const proposals = [];
  const ignoredKinds = [];
  for (const rawProposal of value.proposals) {
    const checked = proposalValue(rawProposal, limits);
    if (checked.ignored !== undefined) {
      ignoredKinds.push(checked.ignored);
      continue;
    }
    if (checked.problem) {
      return failure(NeuralFailureCode.MALFORMED_RESPONSE, checked.problem, { runtime: identity.runtime });
    }
    proposals.push(checked.proposal);
  }
  const base = {
    // An empty answer is a failure, never an empty success: the caller must be able to see
    // that the runtime said nothing usable without reading the proposal list.
    ok: proposals.length > 0,
    outcome: proposals.length > 0 ? NeuralOutcome.VALID : NeuralOutcome.EMPTY,
    code: proposals.length > 0 ? null : NeuralFailureCode.EMPTY_RESPONSE,
    message: proposals.length > 0 ? null : 'the neural runtime answered with no usable proposal',
    proposals: Object.freeze(proposals),
    ignoredKinds: Object.freeze(ignoredKinds),
    counts: {
      received: value.proposals.length,
      accepted: proposals.length,
      ignored: ignoredKinds.length,
    },
    runtime: identity.runtime,
    error: null,
  };
  return base;
}
