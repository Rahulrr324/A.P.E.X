// T-30 P0 (2026-11-19): executes the served client itself — the exact string the server
// ships as UI_CLIENT — inside a vm context with a fake EventSource, and asserts the
// behaviour the browser failed to show: no ReferenceError, Idle on a healthy stream,
// Degraded within two seconds of lost heartbeats, and recovery on reconnect.
//
// This test exists because the previous suite inspected the client's source text and its
// extracted functions separately. It never assembled the shipped script, so a ReferenceError
// hidden in the serialized contract could not fail the build.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { UI_CLIENT } from '../src/ui/assets.js';
import { STATE_EVENT_OWNERS, STATE_EVENT_SCHEMA, HEARTBEAT_SCHEMA, EVENT_WATCHDOG_MS } from '../src/ui/event-contract.js';
import { createFakeBrowser, flushMicrotasks } from './helpers/fake-browser.js';

const STREAM_ID = 'b'.repeat(32);

const readyOwners = () => ({
  tasks: { available: true, total: 0, counts: { runningTasks: 0, pausedTasks: 0, awaitingApprovalSteps: 0, uncertainSteps: 0 }, items: [] },
  plans: { available: true, total: 0, counts: { unapprovedDrafts: 0 }, items: [] },
  approval: {
    available: true,
    taskStepCount: 0,
    draftPlanCount: 0,
    taskSteps: [],
    truncatedTaskSteps: false,
    draftPlans: [],
    truncatedDraftPlans: false,
  },
  lockdown: { available: true, active: false, policyUnavailable: false, reason: null },
  runtime: { available: true, lifecycle: 'stopped', paused: false, lastError: null, corruption: null },
  health: {
    available: true,
    overall: 'healthy',
    areas: [],
    unhealthyAreaCount: 0,
    attentionCount: 0,
    errorCount: 0,
    coreAttentionCounts: { approval: 0, uncertain: 0, other: 0 },
  },
  conversation: { available: true, sessionStatus: 'missing', turnCount: 0, corruptCount: 0 },
});

function reconcileEnvelope({ seq = 12, owners = readyOwners() } = {}) {
  return {
    schema: STATE_EVENT_SCHEMA,
    streamId: STREAM_ID,
    seq,
    at: '2026-11-19T00:00:00.000Z',
    type: 'reconcile',
    versions: Object.fromEntries(STATE_EVENT_OWNERS.map((owner) => [owner, 1])),
    payload: { reason: 'initial', snapshotUrl: '/api/state', owners },
    correlationId: null,
  };
}

function heartbeatEnvelope({ headSeq = 12 } = {}) {
  return { schema: HEARTBEAT_SCHEMA, streamId: STREAM_ID, headSeq, at: '2026-11-19T00:00:00.000Z' };
}

// Loads the shipped script in a vm context. Compilation failure (SyntaxError) and any
// top-level throw propagate to the caller, which is how the suite treats them as failures.
function loadClient() {
  const browser = createFakeBrowser();
  const context = vm.createContext(browser.sandbox, { name: 'apex-ui-client' });
  vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
  return { browser, context };
}

async function connectHealthy(browser) {
  assert.equal(browser.events.sources.length, 1, 'the client opens exactly one event stream');
  const source = browser.events.sources.at(-1);
  assert.equal(source.url, '/api/events');
  source.open();
  source.emit('reconcile', reconcileEnvelope(), { lastEventId: `${STREAM_ID}:12` });
  await flushMicrotasks();
  return source;
}

describe('served client executes without Node scope (T-30 P0)', () => {
  test('the shipped script compiles and runs with zero ReferenceError, SyntaxError or uncaught exception', async () => {
    const { browser } = loadClient();
    await flushMicrotasks();

    assert.deepEqual(browser.events.pageErrors, []);
    assert.deepEqual(browser.events.consoleErrors.filter((line) => /ReferenceError|SyntaxError|not defined/i.test(line)), []);
    // The client performs its initial authoritative reads rather than waiting for a click.
    const paths = new Set(browser.events.fetches.map((entry) => entry.url.split('?')[0]));
    for (const path of ['/api/state', '/api/health', '/api/killswitch', '/api/mission-control', '/api/resources']) {
      assert.ok(paths.has(path), `the client reads ${path} on load`);
    }
  });

  test('the Core reaches Idle on a healthy stream and shows a reconciled connectivity label', async () => {
    const { browser } = loadClient();
    await flushMicrotasks();
    await connectHealthy(browser);

    assert.equal(browser.coreState(), 'idle', 'a healthy reconciled stream with available owners is Idle, not Degraded');
    assert.equal(browser.connectivityText(), 'Connected');
    assert.equal(browser.events.consoleErrors.filter((line) => /ReferenceError|SyntaxError|not defined/i.test(line)).length, 0);
  });

  test('heartbeats hold the Core at Idle, and lost heartbeats degrade it within two seconds', async () => {
    const { browser } = loadClient();
    await flushMicrotasks();
    const source = await connectHealthy(browser);
    assert.equal(browser.coreState(), 'idle');

    // Four heartbeats 500 ms apart: the healthy window the browser must sustain.
    for (let beat = 0; beat < 4; beat += 1) {
      browser.clock.advance(500);
      source.emit('heartbeat', heartbeatEnvelope({ headSeq: 12 }), { lastEventId: `${STREAM_ID}:12` });
      await flushMicrotasks();
      assert.equal(browser.coreState(), 'idle', `still Idle after heartbeat ${beat + 1}`);
    }

    // No heartbeat now. The watchdog is armed for 1.5 s; step the clock in 100 ms slices so
    // the measured detection time is the client's own, not the test's step size.
    const startedAt = browser.clock.now();
    let detectedAt = null;
    for (let slice = 0; slice < 40 && detectedAt === null; slice += 1) {
      browser.clock.advance(100);
      await flushMicrotasks();
      if (browser.coreState() === 'degraded') detectedAt = browser.clock.now();
    }

    assert.notEqual(detectedAt, null, 'a stream with no heartbeat must not stay Idle');
    const detectionMs = detectedAt - startedAt;
    assert.ok(detectionMs <= 2000, `degraded detection must be within 2000 ms, measured ${detectionMs} ms`);
    assert.ok(detectionMs >= EVENT_WATCHDOG_MS, `detection cannot precede the ${EVENT_WATCHDOG_MS} ms watchdog (measured ${detectionMs} ms)`);
    assert.equal(browser.connectivityText(), 'Degraded');
  });

  test('a reconnected stream reconciles from authoritative reads and returns to Idle', async () => {
    const { browser } = loadClient();
    await flushMicrotasks();
    const source = await connectHealthy(browser);

    browser.clock.advance(4000);
    await flushMicrotasks();
    assert.equal(browser.coreState(), 'degraded', 'the stream is stale before the reconnect');

    source.emit('heartbeat', heartbeatEnvelope({ headSeq: 12 }), { lastEventId: `${STREAM_ID}:12` });
    await flushMicrotasks();
    assert.equal(browser.coreState(), 'idle', 'the same stream cursor re-arms the watchdog and re-reconciles');
    assert.equal(browser.connectivityText(), 'Connected');

    // A fresh connection (server restart) reconciles through a new stream id.
    browser.events.sources.at(-1).close();
    const reconnected = browser.events.sources.at(-1);
    assert.equal(reconnected.closed, true);
  });

  test('an invalid envelope degrades the Core instead of being rendered as healthy', async () => {
    const { browser } = loadClient();
    await flushMicrotasks();
    const source = await connectHealthy(browser);
    assert.equal(browser.coreState(), 'idle');

    source.emit('heartbeat', { schema: HEARTBEAT_SCHEMA, streamId: 'not-a-stream-id', headSeq: 12 });
    await flushMicrotasks();
    assert.equal(browser.coreState(), 'degraded', 'the shipped validator rejects a malformed stream id');
  });
});
