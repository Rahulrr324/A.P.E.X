// Package 2 event-stream contract. State events describe bounded reads from the
// stores that own the state; the transport itself never authorizes or changes them.
//
// T-30 P0 (2026-11-19): the envelopes, the watchdog and the Core reduction are built by
// client-contract.js so the served browser client receives the same implementation it
// is tested against. This module re-exports that surface unchanged and keeps the
// Node-only helpers below (history bookkeeping and frame budgeting) next to it.
import {
  CLIENT_CONTRACT,
  EVENT_HEARTBEAT_MS,
  EVENT_WATCHDOG_MS,
  HEARTBEAT_SCHEMA,
  MAX_EVENT_FRAME_BYTES,
  OWNER_POLL_MS,
  STATE_EVENT_HISTORY_LIMIT,
  STATE_EVENT_OWNERS,
  STATE_EVENT_SCHEMA,
  STREAM_ID_PATTERN,
} from './client-contract.js';

export {
  EVENT_HEARTBEAT_MS,
  EVENT_WATCHDOG_MS,
  HEARTBEAT_SCHEMA,
  MAX_EVENT_FRAME_BYTES,
  OWNER_POLL_MS,
  STATE_EVENT_HISTORY_LIMIT,
  STATE_EVENT_OWNERS,
  STATE_EVENT_SCHEMA,
  STREAM_ID_PATTERN,
};

const { isRecord } = CLIENT_CONTRACT;

export { isRecord };
export const validateStateEventEnvelope = CLIENT_CONTRACT.validateStateEventEnvelope;
export const validateHeartbeatEnvelope = CLIENT_CONTRACT.validateHeartbeatEnvelope;
export const createEventWatchdog = CLIENT_CONTRACT.createEventWatchdog;

export class BoundedEventHistory {
  #limit;
  #events = [];

  constructor(limit = STATE_EVENT_HISTORY_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > STATE_EVENT_HISTORY_LIMIT) {
      throw new RangeError(`event history limit must be between 1 and ${STATE_EVENT_HISTORY_LIMIT}`);
    }
    this.#limit = limit;
  }

  push(event) {
    if (!isRecord(event) || !Number.isSafeInteger(event.seq) || event.seq < 1) {
      throw new TypeError('event history accepts only sequenced state events');
    }
    const last = this.#events.at(-1);
    if (last && event.seq !== last.seq + 1) throw new RangeError('state event history sequence must be contiguous');
    this.#events.push(event);
    if (this.#events.length > this.#limit) this.#events.shift();
  }

  replayAfter(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
    const head = this.#events.at(-1)?.seq ?? 0;
    if (sequence === head) return [];
    if (sequence > head || this.#events.length === 0) return null;
    const first = this.#events[0].seq;
    if (sequence < first - 1) return null;
    const events = this.#events.filter((event) => event.seq > sequence);
    if (events.length !== head - sequence || events[0]?.seq !== sequence + 1) return null;
    return events;
  }

  get size() {
    return this.#events.length;
  }

  get head() {
    return this.#events.at(-1)?.seq ?? 0;
  }
}

export function canQueueEventFrame(bufferedBytes, frameBytes, maxBufferedBytes) {
  return Number.isSafeInteger(bufferedBytes) && bufferedBytes >= 0
    && Number.isSafeInteger(frameBytes) && frameBytes > 0
    && Number.isSafeInteger(maxBufferedBytes) && maxBufferedBytes > 0
    && frameBytes <= maxBufferedBytes
    && bufferedBytes + frameBytes <= maxBufferedBytes;
}
