import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, cleanEnv, runCli } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { createUiServer, UI_LIMITS } from '../src/ui/server.js';
import { Outcome } from '../src/outcomes.js';
import { STATE_EVENT_OWNERS, STATE_EVENT_SCHEMA } from '../src/ui/event-contract.js';
import { resolveCoreStateFromOwners } from '../src/ui/core-state.js';

const TOKEN = 'ui-owner-test-token-0123456789';
const dirs = [];
const uis = [];

afterEach(async () => {
  while (uis.length) await uis.pop().stop().catch(() => {});
  while (dirs.length) cleanup(dirs.pop());
});

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

async function uiOn(dir, { ownerPollMs = UI_LIMITS.ownerPollMs, heartbeatMs = UI_LIMITS.heartbeatMs } = {}) {
  const app = createApp({ dataDir: dir, gateway: new ModelGateway({ backend: new NoBackend() }) });
  const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0, ownerPollMs, heartbeatMs });
  const started = await ui.start();
  uis.push(ui);
  return { app, ui, base: `http://127.0.0.1:${started.port}` };
}

async function openStream(base, { lastEventId = null, query = '' } = {}) {
  const controller = new AbortController();
  const headers = { authorization: `Bearer ${TOKEN}` };
  if (lastEventId !== null) headers['last-event-id'] = lastEventId;
  const suffix = query ? `?${query}` : '';
  const response = await fetch(`${base}/api/events${suffix}`, { headers, signal: controller.signal });
  const received = { text: '' };
  const reader = response.status === 200 ? response.body?.getReader() ?? null : null;
  const pump = reader
    ? (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received.text += decoder.decode(value, { stream: true });
      }
    })().catch(() => {})
    : Promise.resolve();
  return {
    response,
    received,
    close: async () => {
      controller.abort();
      await pump;
    },
  };
}

function post(base, route, body) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-apex-ui': '1',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function frames(text) {
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    let event = null;
    let id = null;
    let data = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('id: ')) id = line.slice(4);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (!event || data === null) return [];
    try { return [{ event, id, payload: JSON.parse(data) }]; } catch { return []; }
  });
}

async function waitFor(check, what, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const step = JSON.stringify({
  id: 's1',
  description: 'store a known test statement',
  action: 'memory.add',
  input: { content: 'the owner event test writes a plan in another process' },
  expectedResult: 'the statement is stored',
  verification: 'a read returns the stored statement',
  risk: 'low',
});

describe('cross-process owner events and reconciliation', () => {
  test('reconciles on connect, observes external CLI plan changes, replays gaps, and resets stale streams', async () => {
    const dir = tempDir();
    const { ui, base } = await uiOn(dir, { ownerPollMs: 35, heartbeatMs: 500 });
    assert.equal(ui.stats().limits.heartbeatMs, 500);
    assert.equal(ui.stats().limits.ownerPollMs, 250, 'the reported default preserves the 250 ms fallback poll');

    const first = await openStream(base);
    assert.equal(first.response.status, 200);
    const initial = await waitFor(() => frames(first.received.text).find((frame) => frame.event === 'reconcile'), 'initial owner reconciliation');
    assert.equal(initial.payload.schema, STATE_EVENT_SCHEMA);
    assert.equal(initial.payload.type, 'reconcile');
    assert.equal(initial.payload.payload.reason, 'initial');
    assert.deepEqual(Object.keys(initial.payload.versions).sort(), [...STATE_EVENT_OWNERS].sort());
    assert.equal(initial.id, `${initial.payload.streamId}:${initial.payload.seq}`);
    assert.equal(initial.payload.payload.owners.tasks.available, true);
    assert.equal(initial.payload.payload.owners.plans.available, true);
    assert.equal(resolveCoreStateFromOwners(initial.payload.payload.owners, {
      eventStreamAvailable: true,
      stateReadAvailable: true,
    }), 'idle', 'the real startup owner projections satisfy the full readiness contract');

    const result = await runCli([
      'plan', 'add', '--outcome', 'the external process stores a draft plan', '--step', step,
    ], cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir }));
    assert.equal(result.code, 0, result.stdout + result.stderr);

    const changes = await waitFor(() => {
      const events = frames(first.received.text).filter((frame) => frame.event === 'state-changed');
      const plans = events.find((frame) => frame.payload.category === 'plans');
      const approvals = events.find((frame) => frame.payload.category === 'approval');
      return plans && approvals ? { events, plans, approvals } : null;
    }, 'versioned PlanStore and approval owner events');

    assert.equal(changes.plans.payload.schema, STATE_EVENT_SCHEMA);
    assert.equal(changes.plans.payload.version, 2);
    assert.equal(changes.plans.payload.payload.available, true);
    assert.equal(changes.plans.payload.payload.total, 1);
    assert.equal(changes.approvals.payload.version, 2);
    assert.equal(changes.approvals.payload.payload.available, true);
    assert.equal(changes.approvals.payload.payload.draftPlanCount, 1);
    assert.ok(changes.plans.payload.seq < changes.approvals.payload.seq);
    assert.ok(changes.events.every((frame) => frame.id === `${frame.payload.streamId}:${frame.payload.seq}`));
    assert.ok(Buffer.byteLength(first.received.text) < UI_LIMITS.maxBufferedBytes);
    const ownersAfterPlan = { ...initial.payload.payload.owners };
    for (const frame of changes.events) ownersAfterPlan[frame.payload.category] = frame.payload.payload;
    assert.equal(resolveCoreStateFromOwners(ownersAfterPlan, {
      eventStreamAvailable: true,
      stateReadAvailable: true,
    }), 'awaiting_approval', 'a real external CLI draft becomes the higher-priority Core state');

    const pause = await runCli(['runtime', 'pause'], cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir }));
    assert.equal(pause.code, 0, pause.stdout + pause.stderr);
    const runtimeEvent = await waitFor(() => frames(first.received.text)
      .find((frame) => frame.event === 'state-changed' && frame.payload.category === 'runtime'), 'external runtime owner event');
    assert.equal(runtimeEvent.payload.payload.available, true);
    const expectedReplay = frames(first.received.text).filter((frame) => frame.event === 'state-changed');

    await first.close();
    const replay = await openStream(base, { lastEventId: initial.id });
    assert.equal(replay.response.status, 200);
    const replayed = await waitFor(() => {
      const events = frames(replay.received.text).filter((frame) => frame.event === 'state-changed');
      return events.length >= expectedReplay.length ? events : null;
    }, 'the missing owner events to replay from Last-Event-ID');
    assert.deepEqual(replayed.map((frame) => frame.payload.seq), expectedReplay.map((frame) => frame.payload.seq));
    assert.equal(frames(replay.received.text).some((frame) => frame.event === 'reconcile'), false);
    await replay.close();

    const restarted = await openStream(base, { lastEventId: `${'b'.repeat(32)}:0` });
    const repaired = await waitFor(() => frames(restarted.received.text).find((frame) => frame.event === 'reconcile'), 'stale-stream reconciliation');
    assert.equal(repaired.payload.payload.reason, 'stream-changed');
    assert.equal(repaired.payload.payload.owners.plans.total, 1);
    await restarted.close();
  });

  test('lockdown and health owner events carry fresh fail-closed reads', async () => {
    const dir = tempDir();
    const { base } = await uiOn(dir, { ownerPollMs: 35 });
    const stream = await openStream(base);
    await waitFor(() => frames(stream.received.text).find((frame) => frame.event === 'reconcile'), 'initial owner reconciliation');

    fs.writeFileSync(path.join(dir, 'memory.jsonl'), '{not-json}\n', 'utf8');
    const health = await waitFor(() => frames(stream.received.text)
      .find((frame) => frame.event === 'state-changed' && frame.payload.category === 'health'), 'health to reflect a damaged source');
    assert.equal(health.payload.payload.available, true);
    assert.equal(health.payload.payload.overall, 'failed');
    assert.ok(health.payload.payload.areas.some((area) => area.state === 'failed'));

    const locked = await post(base, '/api/safety/lockdown', { reason: 'T-30 owner-event test latch' });
    assert.equal(locked.status, 200, await locked.text());
    const lockdown = await waitFor(() => frames(stream.received.text)
      .find((frame) => frame.event === 'state-changed' && frame.payload.category === 'lockdown'), 'ECP lockdown owner event');
    assert.equal(lockdown.payload.payload.available, true);
    assert.equal(lockdown.payload.payload.active, true);
    assert.equal(lockdown.payload.payload.policyUnavailable, false);
    await stream.close();
  });

  test('malformed ECP and runtime source objects are published unavailable, not normalized healthy', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, gateway: new ModelGateway({ backend: new NoBackend() }) });
    app.ecp.killSwitchStatus = () => ({ active: false });
    app.runtime.status = async () => ({ lifecycle: 'stopped' });
    const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    uis.push(ui);
    const base = `http://127.0.0.1:${started.port}`;
    const stream = await openStream(base);
    const initial = await waitFor(() => frames(stream.received.text).find((frame) => frame.event === 'reconcile'), 'malformed-source reconciliation');
    const owners = initial.payload.payload.owners;
    assert.equal(owners.lockdown.available, false, 'a missing ECP policy flag is not coerced to false');
    assert.equal(owners.runtime.available, false, 'a missing runtime pause flag is not coerced to false');
    assert.equal(resolveCoreStateFromOwners(owners, { eventStreamAvailable: true, stateReadAvailable: true }), 'degraded');
    await stream.close();
  });

  test('a real uncertain task stays Uncertain when health is degraded only for that outcome', async () => {
    const dir = tempDir();
    const unverifiedRead = {
      name: 'test.ui_uncertain',
      description: 'test-only read whose result cannot be verified',
      inputHint: '{}',
      permission: 'read',
      origins: ['user'],
      validate: (input) => input ?? {},
      async execute() { return { summary: 'the test read ran', data: { read: true } }; },
      async verify() { return null; },
    };
    const app = createApp({
      dataDir: dir,
      gateway: new ModelGateway({ backend: new NoBackend() }),
      extraActions: [unverifiedRead],
    });
    const taskId = randomUUID();
    await app.taskStore.createTask({
      taskId,
      goal: 'verify the live Core uncertainty projection',
      origin: 'user',
      planner: 'deterministic',
      steps: [{
        id: 's1', description: 'a test read with an unestablished result', action: 'test.ui_uncertain',
        permission: 'read', input: {}, dependsOn: [],
      }],
    });
    const run = await app.controller.runTask(taskId, 'run');
    assert.equal(run.status, Outcome.VERIFICATION_UNAVAILABLE);
    const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    uis.push(ui);
    const stream = await openStream(`http://127.0.0.1:${started.port}`);
    const initial = await waitFor(() => frames(stream.received.text).find((frame) => frame.event === 'reconcile'), 'uncertain-task reconciliation');
    const owners = initial.payload.payload.owners;
    assert.equal(owners.tasks.counts.uncertainSteps, 1);
    assert.equal(owners.health.overall, 'degraded');
    assert.equal(owners.health.coreAttentionCounts.uncertain, 1);
    assert.equal(resolveCoreStateFromOwners(owners, { eventStreamAvailable: true, stateReadAvailable: true }), 'uncertain', JSON.stringify(owners.health));
    await stream.close();
  });
});
