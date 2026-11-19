// Package 2 event-stream contract. State events describe bounded reads from the
// stores that own the state; the transport itself never authorizes or changes them.
export const STATE_EVENT_SCHEMA = 'apex.state-event/1';
export const HEARTBEAT_SCHEMA = 'apex.event-heartbeat/1';
export const STATE_EVENT_OWNERS = Object.freeze([
  'tasks',
  'plans',
  'approval',
  'lockdown',
  'runtime',
  'health',
  'conversation',
]);

export const EVENT_HEARTBEAT_MS = 500;
export const EVENT_WATCHDOG_MS = 1500;
export const OWNER_POLL_MS = 250;
export const STATE_EVENT_HISTORY_LIMIT = 128;
export const MAX_EVENT_FRAME_BYTES = 256 * 1024;

const STREAM_ID_RE = /^[a-f0-9]{32}$/;

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveVersion(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

// The browser and the server tests use the same validator. A reconnect snapshot is
// an explicit cursor reset; ordinary state events must be contiguous in both their
// stream sequence and the owning source's version.
export function validateStateEventEnvelope(envelope, cursor = { streamId: null, seq: 0, versions: {} }) {
  const fail = (reason) => ({ ok: false, reason });
  if (!isRecord(envelope)) return fail('invalid-envelope');
  if (envelope.schema !== STATE_EVENT_SCHEMA) return fail('unsupported-schema');
  if (typeof envelope.streamId !== 'string' || !STREAM_ID_RE.test(envelope.streamId)) return fail('invalid-stream-id');
  if (!Number.isSafeInteger(envelope.seq) || envelope.seq < 0) return fail('invalid-sequence');

  if (envelope.type === 'reconcile') {
    if (!isRecord(envelope.versions)) return fail('invalid-owner-versions');
    const keys = Object.keys(envelope.versions);
    if (keys.length !== STATE_EVENT_OWNERS.length
      || keys.some((key) => !STATE_EVENT_OWNERS.includes(key))) return fail('invalid-owner-versions');
    const versions = {};
    for (const owner of STATE_EVENT_OWNERS) {
      if (!positiveVersion(envelope.versions[owner])) return fail('invalid-owner-version');
      versions[owner] = envelope.versions[owner];
    }
    if (!isRecord(envelope.payload) || typeof envelope.payload.reason !== 'string'
      || !isRecord(envelope.payload.owners)) return fail('invalid-reconciliation-snapshot');
    const ownerKeys = Object.keys(envelope.payload.owners);
    if (ownerKeys.length !== STATE_EVENT_OWNERS.length
      || ownerKeys.some((key) => !STATE_EVENT_OWNERS.includes(key))) return fail('invalid-reconciliation-snapshot');
    for (const owner of STATE_EVENT_OWNERS) {
      const snapshot = envelope.payload.owners[owner];
      if (!isRecord(snapshot) || typeof snapshot.available !== 'boolean') return fail('invalid-reconciliation-snapshot');
    }
    return {
      ok: true,
      kind: 'reconcile',
      cursor: { streamId: envelope.streamId, seq: envelope.seq, versions },
    };
  }

  if (envelope.type !== 'state-changed') return fail('invalid-event-type');
  if (cursor.streamId !== envelope.streamId) return fail('stream-mismatch');
  if (!Number.isSafeInteger(cursor.seq) || cursor.seq < 0) return fail('invalid-cursor');
  if (envelope.seq <= cursor.seq) return fail(envelope.seq === cursor.seq ? 'duplicate-sequence' : 'out-of-order-sequence');
  if (envelope.seq !== cursor.seq + 1) return fail('sequence-gap');
  if (typeof envelope.category !== 'string' || !STATE_EVENT_OWNERS.includes(envelope.category)) return fail('unknown-owner');
  if (!positiveVersion(envelope.version)) return fail('invalid-owner-version');
  if (!isRecord(envelope.payload) || typeof envelope.payload.available !== 'boolean') return fail('invalid-owner-payload');

  const priorVersion = cursor.versions?.[envelope.category];
  if (priorVersion === undefined) {
    if (envelope.version !== 1) return fail('owner-version-gap');
  } else if (!positiveVersion(priorVersion) || envelope.version !== priorVersion + 1) {
    return fail(envelope.version <= priorVersion ? 'out-of-order-owner-version' : 'owner-version-gap');
  }

  const versions = { ...(cursor.versions ?? {}), [envelope.category]: envelope.version };
  return {
    ok: true,
    kind: 'state-changed',
    cursor: { streamId: envelope.streamId, seq: envelope.seq, versions },
  };
}

export function validateHeartbeatEnvelope(envelope, cursor = { streamId: null, seq: 0 }) {
  if (!isRecord(envelope)) return { ok: false, reason: 'invalid-heartbeat' };
  if (envelope.schema !== HEARTBEAT_SCHEMA) return { ok: false, reason: 'unsupported-heartbeat-schema' };
  if (typeof envelope.streamId !== 'string' || !STREAM_ID_RE.test(envelope.streamId)) {
    return { ok: false, reason: 'invalid-stream-id' };
  }
  if (!Number.isSafeInteger(envelope.headSeq) || envelope.headSeq < 0) {
    return { ok: false, reason: 'invalid-head-sequence' };
  }
  if (cursor.streamId && cursor.streamId !== envelope.streamId) return { ok: false, reason: 'stream-mismatch' };
  if (cursor.streamId === envelope.streamId && envelope.headSeq > cursor.seq) {
    return { ok: false, reason: 'sequence-gap' };
  }
  if (cursor.streamId === envelope.streamId && envelope.headSeq < cursor.seq) {
    return { ok: false, reason: 'head-sequence-regression' };
  }
  return { ok: true };
}

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

// Kept tiny and dependency-injected so the served client and timing tests exercise
// the exact same watchdog. A missing 500 ms heartbeat therefore degrades at 1.5 s,
// within the two-second acceptance window.
export function createEventWatchdog({
  onExpired = () => {},
  timeoutMs = EVENT_WATCHDOG_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let stopped = false;
  return Object.freeze({
    arm() {
      if (stopped) return;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        if (!stopped) onExpired();
      }, timeoutMs);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  });
}
