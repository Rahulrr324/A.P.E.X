// Lifecycle for one neural request at a time. The boundary owns this; nothing here can
// start, cancel, retry, or execute a proposal. A retry is only ever a caller decision, and
// only for a request that produced no completed answer.
import { NeuralOutcome } from './contract.js';

const OUTCOME_COUNTER = Object.freeze({
  [NeuralOutcome.VALID]: 'completed',
  [NeuralOutcome.EMPTY]: 'empty',
  [NeuralOutcome.UNAVAILABLE]: 'unavailable',
  [NeuralOutcome.ERROR]: 'errored',
  [NeuralOutcome.TIMEOUT]: 'timedOut',
  [NeuralOutcome.CANCELLED]: 'cancelled',
  [NeuralOutcome.MALFORMED]: 'malformed',
  [NeuralOutcome.TOO_LARGE]: 'tooLarge',
  [NeuralOutcome.UNSUPPORTED_VERSION]: 'unsupportedVersion',
  [NeuralOutcome.IN_PROGRESS]: 'rejected',
});

// The outcomes for which no answer reached APEX. A timeout is retryable by the caller even
// though the boundary never replays it: a runtime that produced no completed response cannot
// make an ambiguous reply deterministic, but the request itself carries no APEX state.
const RETRYABLE = new Set([NeuralOutcome.TIMEOUT, NeuralOutcome.UNAVAILABLE]);

export function retryableOutcome(outcome) {
  return RETRYABLE.has(outcome);
}

export class NeuralLifecycle {
  #inFlight = null;
  #counts = {
    requests: 0, completed: 0, empty: 0, unavailable: 0, errored: 0,
    timedOut: 0, cancelled: 0, malformed: 0, tooLarge: 0, unsupportedVersion: 0, rejected: 0,
  };
  #last = null;

  get busy() {
    return this.#inFlight !== null;
  }

  begin(requestId) {
    if (this.#inFlight !== null) {
      return { ok: false, detail: `a neural request is already in progress (${this.#inFlight})` };
    }
    this.#inFlight = requestId;
    this.#counts.requests += 1;
    return { ok: true };
  }

  // A request refused because another is in flight is counted, but it never becomes the
  // in-flight request and never overwrites the last completed record.
  noteRejected() {
    this.#counts.rejected += 1;
  }

  // The record is a bounded diagnostic summary: identity, sizes, durations, and counts.
  // Prompt and response text never enter it.
  finish(outcome, record = {}) {
    const counter = OUTCOME_COUNTER[outcome] ?? 'errored';
    this.#counts[counter] += 1;
    this.#inFlight = null;
    this.#last = Object.freeze({
      requestId: typeof record.requestId === 'string' ? record.requestId : null,
      outcome,
      retryableByCaller: retryableOutcome(outcome),
      sent: record.sent === true,
      requestChars: Number.isInteger(record.requestChars) ? record.requestChars : null,
      responseChars: Number.isInteger(record.responseChars) ? record.responseChars : null,
      latencyMs: Number.isFinite(record.latencyMs) ? Math.max(0, Math.trunc(record.latencyMs)) : null,
      deadlineMs: Number.isInteger(record.deadlineMs) ? record.deadlineMs : null,
      runtimeName: typeof record.runtimeName === 'string' ? record.runtimeName : null,
      runtimeVersion: typeof record.runtimeVersion === 'string' ? record.runtimeVersion : null,
      proposalsReceived: Number.isInteger(record.proposalsReceived) ? record.proposalsReceived : 0,
      proposalsAccepted: Number.isInteger(record.proposalsAccepted) ? record.proposalsAccepted : 0,
      proposalsIgnored: Number.isInteger(record.proposalsIgnored) ? record.proposalsIgnored : 0,
    });
  }

  snapshot() {
    return {
      inFlight: this.#inFlight,
      counts: Object.freeze({ ...this.#counts }),
      last: this.#last,
    };
  }
}
