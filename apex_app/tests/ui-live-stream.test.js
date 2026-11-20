// T-30 P0/Step 2 (2026-11-19): the shipped client against the real HTTP server and the
// real SSE stream.
//
// Chromium cannot be downloaded in this environment (cdn.playwright.dev is blocked and the
// sandbox has none of Chromium's shared libraries), so this test is the strongest available
// substitute for a browser: the same UI_CLIENT string the server serves, a real
// createUiServer on a loopback port, real `text/event-stream` frames, real cross-process
// writes, and real timers. It verifies protocol behaviour and client logic; it does not
// verify pixels, layout or CSS, which remain UNVERIFIED.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { makeTempDataDir, cleanup, cleanEnv, runCli } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { createUiServer } from '../src/ui/server.js';
import { UI_CLIENT } from '../src/ui/assets.js';
import { createFakeBrowser } from './helpers/fake-browser.js';

const TOKEN = 'live-stream-test-token-0123456789';
const dirs = [];
const servers = [];
const liveSources = [];
const allSources = [];

afterEach(async () => {
  // Close every live stream (including reconnects) so the backoff cannot keep the process
  // alive, and give the aborted sockets a moment to close before the servers stop.
  while (allSources.length) {
    const source = allSources.pop();
    try { source.close(); } catch { /* already closed */ }
  }
  liveSources.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 50));
  while (servers.length) await servers.pop().stop().catch(() => {});
  while (dirs.length) cleanup(dirs.pop());
});

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

async function startUi(dir, { port = 0 } = {}) {
  const app = createApp({ dataDir: dir, gateway: new ModelGateway({ backend: new NoBackend() }) });
  const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port });
  const started = await ui.start();
  servers.push(ui);
  return { app, ui, base: `http://127.0.0.1:${started.port}`, port: started.port };
}

function parseBlock(block) {
  let type = 'message';
  let id = '';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event: ')) type = line.slice(7);
    else if (line.startsWith('id: ')) id = line.slice(4);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  if (data.length === 0) return null;
  return { type, id, data: data.join('\n') };
}

// A browser-shaped EventSource over the real stream: named events, lastEventId, onopen,
// onerror, and an automatic reconnect (like a real browser, 300 ms backoff here).
function createLiveEventSource({ baseUrl, headers, log }) {
  class LiveEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.onopen = null;
      this.onerror = null;
      this.closed = false;
      this.readyState = 0;
      log.sources.push(this);
      allSources.push(this);
      this.connect();
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    removeEventListener() {}
    emit(type, event) {
      for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
      this.controller?.abort();
    }
    scheduleReconnect() {
      if (this.closed) return;
      log.reconnects += 1;
      globalThis.setTimeout(() => { if (!this.closed) this.connect(); }, 300);
    }
    async connect() {
      if (this.closed) return;
      this.controller = new AbortController();
      try {
        const response = await fetch(new URL(this.url, baseUrl.value), {
          headers: { ...headers, accept: 'text/event-stream' },
          signal: this.controller.signal,
        });
        if (!response.ok || !response.body) {
          this.onerror?.({ type: 'error' });
          this.scheduleReconnect();
          return;
        }
        this.readyState = 1;
        this.onopen?.({ type: 'open' });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const match = /\r?\n\r?\n/.exec(buffer);
            if (!match) break;
            const block = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const frame = parseBlock(block);
            if (!frame) continue;
            log.frames.push(frame);
            this.emit(frame.type, { type: frame.type, data: frame.data, lastEventId: frame.id });
          }
        }
        if (!this.closed) {
          this.onerror?.({ type: 'error', message: 'stream ended' });
          this.scheduleReconnect();
        }
      } catch (error) {
        if (this.closed) return;
        this.onerror?.({ type: 'error', message: String(error?.message || error) });
        this.scheduleReconnect();
      }
    }
  }
  return LiveEventSource;
}

async function waitForState(browser, expected, timeoutMs, label, { connected = false } = {}) {
  const started = Date.now();
  for (;;) {
    const ready = browser.coreState() === expected
      && (!connected || browser.connectivityText() === 'Connected');
    if (ready) return Date.now() - started;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for Core ${expected} (${label}); last ${browser.coreState()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('shipped client over a real server and real event stream (T-30 P0/Step 2)', () => {
  test('Idle on a healthy stream, Awaiting Approval after a real cross-process write, Degraded within 2 s when the server stops, and recovery on reconnect', async (t) => {
    const dir = tempDir();
    const { base, port } = await startUi(dir);

    const baseUrl = { value: base };
    const log = { frames: [], sources: [], reconnects: 0 };
    const headers = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' };
    const timing = { stateReadMs: null, firstReconcileMs: null };
    const liveFetch = async (url, options = {}) => {
      const started = Date.now();
      const response = await fetch(new URL(url, baseUrl.value), {
        ...options,
        headers: { ...headers, ...(options.headers ?? {}) },
      });
      if (String(url).split('?')[0] === '/api/state' && timing.stateReadMs === null) {
        timing.stateReadMs = Date.now() - started;
      }
      return response;
    };
    const loadStartedAt = Date.now();

    const liveSources = [];
    const browser = createFakeBrowser({
      realTimers: true,
      fetchImpl: liveFetch,
      EventSourceClass: createLiveEventSource({ baseUrl, headers, log }),
    });
    const context = vm.createContext(browser.sandbox, { name: 'apex-live-ui' });
    liveSources.push(...browser.events.sources);
    liveSources.push(log);
    vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });

    // 1. Healthy stream: the browser-equivalent reaches Idle, not Degraded.
    await waitForState(browser, 'idle', 6000, 'initial healthy stream', { connected: true });
    assert.equal(browser.connectivityText(), 'Connected');
    const firstReconcile = log.frames.find((frame) => frame.type === 'reconcile');
    assert.ok(firstReconcile, 'the server sent a reconciliation frame');
    timing.firstReconcileMs = Date.now() - loadStartedAt;

    // 2. Heartbeats arrive on the documented 500 ms cadence (allow scheduler jitter).
    const heartbeatsBefore = log.frames.filter((frame) => frame.type === 'heartbeat').length;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const heartbeats = log.frames.filter((frame) => frame.type === 'heartbeat').length - heartbeatsBefore;
    assert.ok(heartbeats >= 2, `expected at least two heartbeats in 1.2 s, observed ${heartbeats}`);

    // 3. A real cross-process draft plan is an approval, and the client shows it.
    const result = await runCli([
      'plan', 'add', '--outcome', 'the live stream test stores a draft plan',
      '--step', JSON.stringify({
        id: 's1',
        description: 'store a known test statement',
        action: 'memory.add',
        input: { content: 'live stream test statement' },
        expectedResult: 'the statement is stored',
        verification: 'a read returns the stored statement',
        risk: 'low',
      }),
    ], cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir }));
    assert.equal(result.code, 0, result.stdout + result.stderr);
    await waitForState(browser, 'awaiting_approval', 6000, 'draft plan requires approval');

    // 4. Stop the server: the client must degrade inside the two-second window.
    const stopping = servers.pop();
    await stopping.stop();
    const degradedAfter = await waitForState(browser, 'degraded', 3000, 'server stopped');
    assert.ok(degradedAfter <= 2000, `degraded detection must be within 2000 ms, measured ${degradedAfter} ms`);
    assert.equal(browser.connectivityText(), 'Degraded');

    // 5. Restart on the same port. The client reconnects, reconciles and leaves Degraded.
    const reconnectStartedAt = Date.now();
    let restarted = null;
    for (let attempt = 0; attempt < 20 && restarted === null; attempt += 1) {
      try {
        restarted = await startUi(dir, { port });
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(restarted, 'the server restarted on the same port');
    baseUrl.value = restarted.base;
    await waitForState(browser, 'awaiting_approval', 8000, 'reconnect reconciled the pending approval');
    const reconnectMs = Date.now() - reconnectStartedAt;
    assert.ok(log.reconnects >= 1, 'the client attempted a reconnect');

    // Real measurements for the Package 6 evidence row. They describe this harness
    // (Node fetch + vm client on loopback), not a browser.
    t.diagnostic(`measured: first /api/state ${timing.stateReadMs} ms; first reconcile frame ${timing.firstReconcileMs} ms after load; degraded detection ${degradedAfter} ms after the server stopped; reconnect-to-reconciled ${reconnectMs} ms (including the 300 ms client backoff); heartbeats ${heartbeats} in 1.2 s`);

    assert.deepEqual(browser.events.pageErrors, []);
    assert.equal(browser.events.consoleErrors.filter((line) => /ReferenceError|SyntaxError|not defined/i.test(line)).length, 0);
  });

  // T-29 (2026-11-19): the same shipped client, the same real server, now driven through the
  // cognitive pipeline's HTTP surface. This is the runtime evidence for the deck's claim that a
  // run is recorded, gated, approved by the owner, and rendered from the run record.
  test('a cognitive run reaches the served client: cold and warm /api/state, the cognition event, the gated approval and the five-stage trace', async (t) => {
    const dir = tempDir();
    const { base } = await startUi(dir);
    const headers = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' };
    const baseUrl = { value: base };
    const stateTimings = [];
    const liveFetch = async (url, options = {}) => {
      const started = Date.now();
      const response = await fetch(new URL(url, base), { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
      if (String(url).split('?')[0] === '/api/state') stateTimings.push(Date.now() - started);
      return response;
    };
    // The cold read is taken on its own, before the page-load burst: STEP 1's acceptance bound is
    // about one read, and a number taken while fourteen other owner routes are in flight would
    // measure the burst rather than the read.
    const coldStartedAt = Date.now();
    const coldResponse = await fetch(`${base}/api/state`, { headers });
    assert.equal(coldResponse.status, 200);
    await coldResponse.json();
    const cold = Date.now() - coldStartedAt;
    const log = { frames: [], sources: [], reconnects: 0 };
    const browser = createFakeBrowser({
      realTimers: true,
      fetchImpl: liveFetch,
      EventSourceClass: createLiveEventSource({ baseUrl, headers, log }),
    });
    const context = vm.createContext(browser.sandbox, { name: 'apex-live-t29' });
    vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
    await waitForState(browser, 'idle', 6000, 'initial healthy stream', { connected: true });

    const warm = [];
    for (let index = 0; index < 5; index += 1) {
      const startedAt = Date.now();
      const response = await fetch(`${base}/api/state`, { headers });
      assert.equal(response.status, 200);
      await response.json();
      warm.push(Date.now() - startedAt);
    }
    warm.sort((a, b) => a - b);
    const warmP50 = warm[Math.floor(warm.length / 2)] ?? null;
    assert.ok(cold <= 150, `the cold /api/state read must be within 150 ms, measured ${cold} ms`);
    assert.ok(warmP50 <= 100, `the warm /api/state p50 must be within 100 ms, measured ${warmP50} ms`);

    // A read-only run completes and the server announces it on the authoritative stream.
    const readRun = await fetch(`${base}/api/cognition/run`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'what does memory hold about the launch checklist' }),
    });
    assert.equal(readRun.status, 200);
    const readBody = await readRun.json();
    assert.equal(readBody.runStatus, 'completed');
    const cognitionFrame = await (async () => {
      const started = Date.now();
      for (;;) {
        const frame = log.frames.find((entry) => entry.type === 'cognition');
        if (frame) return frame;
        if (Date.now() - started > 5000) throw new Error('the cognition event never arrived');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    const cognitionPayload = typeof cognitionFrame.data === 'string' ? JSON.parse(cognitionFrame.data) : cognitionFrame.data;
    assert.equal(cognitionPayload.status, 'completed');
    assert.equal(typeof cognitionPayload.runId, 'string');

    // The client re-reads the trace from the owner route and renders all five stages.
    const traceStarted = Date.now();
    let stages = [];
    for (;;) {
      const trace = browser.getElement('cognition-trace');
      stages = (trace.children ?? []).filter((child) => child.className === 'cognition-stage');
      if (stages.length === 5) break;
      if (Date.now() - traceStarted > 5000) throw new Error(`the trace rendered ${stages.length} of 5 stages`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const traceMs = Date.now() - traceStarted;
    const traceText = JSON.stringify(stages.map((stage) => stage.children.map((child) => child.textContent)));
    assert.match(traceText, /1 · Context/, 'the first stage is rendered');
    assert.match(traceText, /5 · Governed execution/, 'the fifth stage is rendered');

    // A write run pauses; the Core shows Awaiting Approval from the authoritative owner snapshot,
    // not from a client animation. The owner's approval then executes it and the Core returns to Idle.
    const writeRun = await fetch(`${base}/api/cognition/run`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'remember the release window is zulu9c1', action: 'memory.add', input: { content: 'the release window is zulu9c1' } }),
    });
    assert.equal(writeRun.status, 200);
    const writeBody = await writeRun.json();
    assert.equal(writeBody.runStatus, 'awaiting_approval');
    await waitForState(browser, 'awaiting_approval', 6000, 'the gated run is visible in the Core');

    const approval = await fetch(`${base}/api/cognition/runs/${encodeURIComponent(writeBody.run.runId)}/approve`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ stepId: 's1' }),
    });
    const approved = await approval.json();
    assert.equal(approval.status, 200);
    assert.equal(approved.runStatus, 'completed');
    await waitForState(browser, 'idle', 8000, 'the Core returns to Idle after the approved run completes');

    t.diagnostic(`measured: cold /api/state ${cold} ms; warm /api/state p50 ${warmP50} ms over ${warm.length} reads; five-stage trace rendered ${traceMs} ms after the cognition event; gated run approved and completed; Core transitions observed idle -> awaiting_approval -> idle`);
    assert.deepEqual(browser.events.pageErrors, []);
    assert.equal(browser.events.consoleErrors.filter((line) => /ReferenceError|SyntaxError|not defined/i.test(line)).length, 0);
  });

});
