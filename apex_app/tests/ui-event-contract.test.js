import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UI_CLIENT } from '../src/ui/assets.js';
import { CLIENT_CONTRACT_SOURCE } from '../src/ui/client-contract.js';
import { UI_LIMITS } from '../src/ui/server.js';
import {
  BoundedEventHistory,
  EVENT_HEARTBEAT_MS,
  EVENT_WATCHDOG_MS,
  HEARTBEAT_SCHEMA,
  OWNER_POLL_MS,
  STATE_EVENT_OWNERS,
  STATE_EVENT_SCHEMA,
  createEventWatchdog,
  canQueueEventFrame,
  validateHeartbeatEnvelope,
  validateStateEventEnvelope,
} from '../src/ui/event-contract.js';

const STREAM_ID = 'a'.repeat(32);
const initialVersions = () => Object.fromEntries(STATE_EVENT_OWNERS.map((owner) => [owner, 1]));
const initialOwners = () => Object.fromEntries(STATE_EVENT_OWNERS.map((owner) => [owner, { available: true }]));
const initialCursor = () => ({ streamId: STREAM_ID, seq: 0, versions: initialVersions() });

function stateEvent(overrides = {}) {
  return {
    schema: STATE_EVENT_SCHEMA,
    streamId: STREAM_ID,
    seq: 1,
    at: '2026-11-19T00:00:00.000Z',
    type: 'state-changed',
    category: 'tasks',
    version: 2,
    payload: { available: true, total: 1 },
    correlationId: null,
    ...overrides,
  };
}

describe('versioned owner event contract', () => {
  test('a reconciliation establishes a stream cursor and every owner version', () => {
    const envelope = {
      schema: STATE_EVENT_SCHEMA,
      streamId: STREAM_ID,
      seq: 12,
      at: '2026-11-19T00:00:00.000Z',
      type: 'reconcile',
      versions: initialVersions(),
      payload: { reason: 'initial', snapshotUrl: '/api/state', owners: initialOwners() },
    };
    assert.deepEqual(validateStateEventEnvelope(envelope, { streamId: null, seq: 0, versions: {} }), {
      ok: true,
      kind: 'reconcile',
      cursor: { streamId: STREAM_ID, seq: 12, versions: initialVersions() },
    });
    const incompleteOwners = { ...initialOwners() };
    delete incompleteOwners.plans;
    assert.equal(validateStateEventEnvelope({
      ...envelope,
      payload: { ...envelope.payload, owners: incompleteOwners },
    }).reason, 'invalid-reconciliation-snapshot');
  });

  test('owner updates must be contiguous, non-duplicate, ordered and versioned', () => {
    const first = stateEvent();
    const accepted = validateStateEventEnvelope(first, initialCursor());
    assert.equal(accepted.ok, true);
    assert.equal(accepted.cursor.seq, 1);
    assert.equal(accepted.cursor.versions.tasks, 2);

    assert.equal(validateStateEventEnvelope(first, accepted.cursor).reason, 'duplicate-sequence');
    assert.equal(validateStateEventEnvelope(stateEvent({ seq: 0 }), accepted.cursor).reason, 'out-of-order-sequence');
    assert.equal(validateStateEventEnvelope(stateEvent({ seq: 3 }), accepted.cursor).reason, 'sequence-gap');
    assert.equal(validateStateEventEnvelope(stateEvent({ seq: 2, version: 4 }), accepted.cursor).reason, 'owner-version-gap');
    assert.equal(validateStateEventEnvelope(stateEvent({ seq: 2, version: 2 }), accepted.cursor).reason, 'out-of-order-owner-version');
    assert.equal(validateStateEventEnvelope(stateEvent({ schema: 'apex.state-event/2' }), initialCursor()).reason, 'unsupported-schema');
    assert.equal(validateStateEventEnvelope(stateEvent({ category: 'unknown' }), initialCursor()).reason, 'unknown-owner');
  });

  test('reconciliation explicitly resets a cursor after a server process changes', () => {
    const anotherStream = 'b'.repeat(32);
    const envelope = {
      schema: STATE_EVENT_SCHEMA,
      streamId: anotherStream,
      seq: 1,
      at: '2026-11-19T00:00:00.000Z',
      type: 'reconcile',
      versions: initialVersions(),
      payload: { reason: 'stream-changed', snapshotUrl: '/api/state', owners: initialOwners() },
    };
    const reset = validateStateEventEnvelope(envelope, initialCursor());
    assert.equal(reset.ok, true);
    assert.deepEqual(reset.cursor, { streamId: anotherStream, seq: 1, versions: initialVersions() });
  });

  test('heartbeat metadata detects a missed owner frame and rejects another stream', () => {
    const heartbeat = { schema: HEARTBEAT_SCHEMA, streamId: STREAM_ID, headSeq: 2, at: '2026-11-19T00:00:00.000Z' };
    assert.equal(validateHeartbeatEnvelope(heartbeat, initialCursor()).reason, 'sequence-gap');
    assert.equal(validateHeartbeatEnvelope({ ...heartbeat, streamId: 'b'.repeat(32) }, initialCursor()).reason, 'stream-mismatch');
    assert.equal(validateHeartbeatEnvelope({ ...heartbeat, headSeq: 0 }, initialCursor()).ok, true);
    assert.equal(validateHeartbeatEnvelope({ ...heartbeat, schema: 'apex.event-heartbeat/2' }, initialCursor()).reason, 'unsupported-heartbeat-schema');
  });
});

describe('bounded event transport and timing', () => {
  test('the replay history evicts oldest events and refuses an incomplete cursor', () => {
    const history = new BoundedEventHistory(3);
    history.push({ seq: 1 });
    history.push({ seq: 2 });
    history.push({ seq: 3 });
    history.push({ seq: 4 });
    assert.equal(history.size, 3);
    assert.equal(history.head, 4);
    assert.deepEqual(history.replayAfter(1).map((event) => event.seq), [2, 3, 4]);
    assert.equal(history.replayAfter(0), null, 'a cursor older than retained history requires reconciliation');
    assert.deepEqual(history.replayAfter(4), []);
    assert.equal(history.replayAfter(5), null, 'a future cursor requires reconciliation');
  });

  test('subscriber frame writes stay within a fixed buffer and event-frame bound', () => {
    assert.equal(canQueueEventFrame(900, 100, 1000), true);
    assert.equal(canQueueEventFrame(901, 100, 1000), false);
    assert.equal(canQueueEventFrame(0, 1001, 1000), false);
    assert.equal(canQueueEventFrame(-1, 1, 1000), false);
    assert.equal(UI_LIMITS.maxSubscribers, 8);
    assert.equal(UI_LIMITS.maxBufferedBytes, 1024 * 1024);
    assert.equal(UI_LIMITS.maxEventFrameBytes, 256 * 1024);
  });

  test('the 500 ms heartbeat and 1.5 s watchdog degrade no later than two seconds', () => {
    assert.equal(EVENT_HEARTBEAT_MS, 500);
    assert.equal(EVENT_WATCHDOG_MS, 1500);
    assert.equal(OWNER_POLL_MS, 250);
    assert.equal(UI_LIMITS.heartbeatMs, 500);
    assert.equal(UI_LIMITS.ownerPollMs, 250);
    // T-30 P0 (2026-11-19): supersedes the textual check for the old serialized Node
    // function. The served client now receives its watchdog value from the rendered
    // contract program; the intent (a 1.5 s watchdog in the browser) is unchanged.
    assert.match(CLIENT_CONTRACT_SOURCE, /"watchdogMs":1500/);
    assert.match(UI_CLIENT, /const EVENT_WATCHDOG_MS = APEX_CONTRACT\.constants\.watchdogMs;/);

    let now = 0;
    let nextId = 0;
    const timers = new Map();
    let degraded = false;
    const watchdog = createEventWatchdog({
      timeoutMs: EVENT_WATCHDOG_MS,
      onExpired: () => { degraded = true; },
      setTimer: (callback, delay) => {
        const id = ++nextId;
        timers.set(id, { callback, due: now + delay });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    });
    const advance = (time) => {
      now = time;
      for (const [id, timer] of [...timers]) {
        if (timer.due > now) continue;
        timers.delete(id);
        timer.callback();
      }
    };

    watchdog.arm();
    advance(1499);
    assert.equal(degraded, false);
    advance(1500);
    assert.equal(degraded, true);
    watchdog.stop();
  });
});
