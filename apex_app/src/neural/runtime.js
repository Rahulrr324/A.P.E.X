// The process-side half of the neural boundary. It owns the request lifecycle, the deadline,
// cancellation, and the size bounds; it never owns a store, a registry, or an action. A
// transport is injected (a deterministic simulated one exists for tests). With no transport,
// the boundary reports that nothing is configured and contacts nothing.
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_DEADLINE_MS,
  MAX_DEADLINE_MS,
  MAX_OUTPUT_CHARS,
  MAX_PLAN_STEPS,
  MAX_PROPOSALS,
  MAX_REQUEST_CHARS,
  MAX_RESPONSE_CHARS,
  NEURAL_REQUEST_SCHEMA,
  NEURAL_RESPONSE_SCHEMA,
  NeuralFailureCode,
  NeuralOutcome,
  PROPOSAL_KINDS,
  buildNeuralRequest,
  outcomeForCode,
  validateNeuralResponse,
} from './contract.js';
import { NeuralLifecycle, retryableOutcome } from './lifecycle.js';

export const NEURAL_BOUNDARY_SCHEMA = 'apex.neural-boundary/1';

function failed(code, message, { requestId = null, sent = false, latencyMs = null, requestChars = null, responseChars = null, deadlineMs = null, simulated = false } = {}) {
  const outcome = outcomeForCode(code);
  return {
    ok: false,
    outcome,
    code,
    message,
    proposals: [],
    ignoredKinds: [],
    counts: { received: 0, accepted: 0, ignored: 0 },
    runtime: null,
    error: null,
    requestId,
    latencyMs,
    sent,
    requestChars,
    responseChars,
    deadlineMs,
    // Only a request that reached the runtime and produced no completed answer may be
    // retried, and only by the caller. The boundary itself never retries.
    retryableByCaller: sent && retryableOutcome(outcome),
    simulated,
    inferenceTested: false,
    authorizes: false,
    executed: false,
    recorded: false,
    provenance: null,
  };
}

// Resolves with the runtime's reply, or rejects as soon as the caller's signal aborts. The
// race is what makes a cancellation or deadline terminal even when a transport ignores its
// signal and keeps waiting.
async function invokeWithin(promise, signal) {
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  });
  aborted.catch(() => {});
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export class NeuralRuntimeBoundary {
  #transport;
  #now;
  #idFactory;
  #defaultDeadlineMs;
  #lifecycle;

  constructor({
    transport = null,
    now = () => Date.now(),
    idFactory = randomUUID,
    lifecycle = new NeuralLifecycle(),
    defaultDeadlineMs = DEFAULT_DEADLINE_MS,
  } = {}) {
    this.#transport = transport;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#lifecycle = lifecycle;
    this.#defaultDeadlineMs = defaultDeadlineMs;
  }

  isConfigured() {
    return this.#transport !== null;
  }

  get lifecycle() {
    return this.#lifecycle;
  }

  describe() {
    const configured = this.isConfigured();
    return {
      schema: NEURAL_BOUNDARY_SCHEMA,
      requestSchema: NEURAL_REQUEST_SCHEMA,
      responseSchema: NEURAL_RESPONSE_SCHEMA,
      configured,
      transport: configured
        ? {
          name: typeof this.#transport.name === 'string' ? this.#transport.name : 'unnamed',
          simulated: this.#transport.simulated === true,
          inferenceTested: this.#transport.inferenceTested === true,
        }
        : null,
      limits: {
        maxRequestChars: MAX_REQUEST_CHARS,
        maxResponseChars: MAX_RESPONSE_CHARS,
        maxProposals: MAX_PROPOSALS,
        maxPlanSteps: MAX_PLAN_STEPS,
        maxOutputChars: MAX_OUTPUT_CHARS,
        defaultDeadlineMs: this.#defaultDeadlineMs,
        maxDeadlineMs: MAX_DEADLINE_MS,
      },
      isolation: {
        runtimeReceivesStores: false,
        runtimeMayInvokeActions: false,
        runtimeMayApprove: false,
        runtimeMayWrite: false,
        oneRequestAtATime: true,
        processTransport: false,
        note: 'only one request line crosses the boundary and only one response line comes back; no store handle, registry, action, or callback is passed to a runtime',
      },
      trust: {
        proposalKinds: [...PROPOSAL_KINDS],
        confidenceIsAdvisory: true,
        runtimeAuthority: 'none',
        executableWithoutUserDecision: false,
        verified: false,
        recorded: false,
      },
      verified: false,
      probed: false,
      inferenceTested: false,
      lifecycle: this.#lifecycle.snapshot(),
      note: configured
        ? 'a transport is connected; it is reported as reachable only when it answers, never as healthy or inference-tested'
        : 'no neural runtime is connected; this build ships the contract and a deterministic simulated transport for tests',
    };
  }

  async propose({ text, requestId = this.#idFactory(), deadlineMs = this.#defaultDeadlineMs, signal = null } = {}) {
    let built;
    try {
      built = buildNeuralRequest({ requestId, text, deadlineMs });
    } catch (err) {
      return failed(NeuralFailureCode.INVALID_REQUEST, err?.message ?? String(err), {
        requestId: typeof requestId === 'string' && requestId.length <= 100 ? requestId : null,
      });
    }
    const id = built.request.requestId;
    if (!this.isConfigured()) {
      return failed(
        NeuralFailureCode.NOT_CONFIGURED,
        'no neural runtime is configured; the boundary declares the contract and contacts nothing',
        { requestId: id, requestChars: built.line.length, deadlineMs: built.request.deadlineMs },
      );
    }
    const started = this.#now();
    const begun = this.#lifecycle.begin(id);
    if (!begun.ok) {
      this.#lifecycle.noteRejected();
      return failed(NeuralFailureCode.REQUEST_IN_PROGRESS, begun.detail, { requestId: id, requestChars: built.line.length });
    }

    const simulated = this.#transport?.simulated === true;
    const meta = {
      requestId: id,
      sent: false,
      requestChars: built.line.length,
      responseChars: null,
      deadlineMs: built.request.deadlineMs,
      simulated,
    };
    let result = failed(NeuralFailureCode.MALFORMED_RESPONSE, 'no neural request was attempted', meta);
    let timer = null;
    let controller = null;
    let timedOut = false;
    try {
      if (signal?.aborted === true) {
        return (result = failed(NeuralFailureCode.CANCELLED, 'the neural request was cancelled before it was sent', meta));
      }
      controller = new AbortController();
      const combined = signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal;
      if (signal && typeof AbortSignal.any !== 'function') {
        signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, built.request.deadlineMs);

      let raw;
      const invocation = Promise.resolve().then(() => {
        meta.sent = true;
        return this.#transport.invoke(built.request, {
          line: built.line,
          deadlineMs: built.request.deadlineMs,
          signal: combined,
        });
      });
      try {
        raw = await invokeWithin(invocation, combined);
      } catch (err) {
        invocation.catch(() => {});
        const latencyMs = this.#now() - started;
        const abortedByCaller = signal?.aborted === true;
        if (abortedByCaller) {
          return (result = failed(NeuralFailureCode.CANCELLED, 'the neural request was cancelled', { ...meta, latencyMs }));
        }
        if (timedOut) {
          return (result = failed(
            NeuralFailureCode.TIMEOUT,
            `no neural response within ${built.request.deadlineMs} ms; the request is not replayed automatically`,
            { ...meta, latencyMs },
          ));
        }
        if (err?.name === 'AbortError' || controller.signal.aborted) {
          return (result = failed(NeuralFailureCode.INTERRUPTED, 'the neural request was interrupted', { ...meta, latencyMs }));
        }
        return (result = failed(NeuralFailureCode.UNREACHABLE, 'the neural runtime could not be reached', { ...meta, latencyMs }));
      }
      const latencyMs = this.#now() - started;
      if (signal?.aborted === true) {
        // The caller cancelled while the reply was in flight. The late reply is data from a
        // request that is no longer wanted, so it is discarded rather than delivered.
        return (result = failed(NeuralFailureCode.CANCELLED, 'the request was cancelled; a late runtime reply was discarded', {
          ...meta, latencyMs, responseChars: typeof raw === 'string' ? raw.length : 0,
        }));
      }
      const parsed = validateNeuralResponse(raw, built.request);
      result = {
        ...parsed,
        requestId: id,
        latencyMs,
        sent: true,
        requestChars: built.line.length,
        responseChars: typeof raw === 'string' ? raw.length : 0,
        deadlineMs: built.request.deadlineMs,
        retryableByCaller: retryableOutcome(parsed.outcome),
        simulated,
        inferenceTested: this.#transport.inferenceTested === true,
        authorizes: false,
        executed: false,
        recorded: false,
        provenance: parsed.runtime
          ? {
            origin: 'model_output',
            backend: 'neural-runtime',
            runtime: parsed.runtime.name,
            runtimeVersion: parsed.runtime.version,
            modelId: parsed.runtime.modelId,
            verified: false,
          }
          : null,
      };
      return result;
    } finally {
      if (timer !== null) clearTimeout(timer);
      const final = result?.outcome ?? NeuralOutcome.MALFORMED;
      this.#lifecycle.finish(final, {
        requestId: id,
        sent: result?.sent === true,
        requestChars: result?.requestChars ?? built.line.length,
        responseChars: result?.responseChars ?? null,
        latencyMs: result?.latencyMs ?? null,
        deadlineMs: built.request.deadlineMs,
        runtimeName: result?.runtime?.name ?? null,
        runtimeVersion: result?.runtime?.version ?? null,
        proposalsReceived: result?.counts?.received ?? 0,
        proposalsAccepted: result?.counts?.accepted ?? 0,
        proposalsIgnored: result?.counts?.ignored ?? 0,
      });
    }
  }
}

// The default boundary: no transport, so it can only report that nothing is connected.
export function createNeuralBoundary(options = {}) {
  return new NeuralRuntimeBoundary(options);
}
