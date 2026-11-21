// T-33 Step 2 (2026-11-19): executive comms where the owner meets them - the deck's state snapshot,
// the comms route the deck asks for its own Core reading, the briefing, and a T-29 run summary.
//
// The formatter's own rules are pinned in `persona-comms.test.js`. This file pins the wiring: that
// every surface carries the framings, that the route refuses a Core state it does not know, and that
// a pending approval anywhere on the deck takes wit away from every voice on every surface.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import { witMarkersIn } from '../src/cognition/persona-comms.js';

const TOKEN = 't33-comms-token-0123456789';
const dirs = [];
const servers = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (servers.length) await servers.pop().stop().catch(() => {});
  while (dirs.length) {
    const dir = dirs.pop();
    try { cleanup(dir); } catch { /* already removed */ }
  }
});

async function start({ dataDir = null } = {}) {
  const dir = dataDir ?? tempDir();
  const app = createApp({ dataDir: dir });
  const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
  const started = await ui.start();
  servers.push(ui);
  const base = `http://127.0.0.1:${started.port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' };
  return { app, ui, dir, base, headers };
}

describe('executive comms on the owner surfaces', () => {
  test('the state snapshot carries all five framings and says wit is allowed on a settled deck', async () => {
    const { base, headers } = await start();
    const state = await fetch(`${base}/api/state`, { headers }).then((r) => r.json());
    assert.equal(state.coreReading, 'idle');
    assert.deepEqual(Object.keys(state.comms.framings), ['classic', 'tactical', 'overwatch', 'synthesis', 'quiet']);
    assert.equal(state.comms.signals.witAllowed, true);
    assert.ok(witMarkersIn(state.comms.framings.classic).length > 0, 'a settled deck lets the classic voice breathe');
    // The facts behind the words are in the snapshot too, so a reader can check the wording.
    assert.ok(state.comms.framings.classic.lines.some((entry) => entry.label === 'Core'));
  });

  test('the comms route follows the Core state the deck passes and refuses one it does not know', async () => {
    const { base, headers } = await start();
    const locked = await fetch(`${base}/api/comms?core=lockdown`, { headers }).then((r) => r.json());
    assert.equal(locked.coreReading, 'lockdown');
    assert.equal(locked.signals.witAllowed, false);
    assert.match(locked.signals.witWithheldBecause.join('; '), /Lockdown is latched/);
    for (const mode of ['classic', 'tactical', 'overwatch', 'synthesis', 'quiet']) {
      assert.deepEqual(witMarkersIn(locked.framings[mode]), [], `${mode} carries no wit while Lockdown is latched`);
    }
    assert.equal(locked.presentationOnly, true);
    assert.equal(locked.authorizesExecution, false);

    const refused = await fetch(`${base}/api/comms?core=ecstatic`, { headers });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /core must be one of/);
  });

  test('a pending approval takes wit away from the briefing and from a run summary', async () => {
    const { app, base, headers, dir } = await start();
    // A gated write is the honest way to have a real pending approval: the pipeline records the run,
    // the ECP leaves the step awaiting the owner, and nothing executes.
    const started = await fetch(`${base}/api/cognition/run`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'store the T-33 approval marker in memory', action: 'memory.add', input: { content: 'the T-33 gated marker' } }),
    }).then((r) => r.json());
    const runId = started.run?.runId ?? started.runId;
    assert.equal(started.run?.status ?? started.runStatus, 'awaiting_approval');

    const briefing = await fetch(`${base}/api/briefing`, { headers }).then((r) => r.json());
    assert.ok(briefing.executiveComms, 'the briefing carries the framings');
    assert.equal(briefing.executiveComms.signals.approvalPending, true);
    assert.equal(briefing.executiveComms.signals.witAllowed, false);
    for (const mode of ['classic', 'tactical', 'overwatch', 'synthesis', 'quiet']) {
      assert.deepEqual(witMarkersIn(briefing.executiveComms.framings[mode]), [], `${mode} in the briefing carries no wit`);
    }

    const runs = await fetch(`${base}/api/cognition/runs?limit=5`, { headers }).then((r) => r.json());
    const run = runs.runs.find((entry) => entry.runId === runId);
    assert.ok(run, 'the run is listed');
    assert.ok(run.comms, 'the run summary carries its own framing');
    assert.equal(run.comms.framings.classic.witAllowed, false);
    assert.deepEqual(witMarkersIn(run.comms.framings.classic), []);

    const state = await fetch(`${base}/api/state`, { headers }).then((r) => r.json());
    assert.equal(state.coreReading, 'awaiting_approval', 'the server reads the same owners the deck does');
    assert.equal(state.comms.signals.witAllowed, false);

    // Nothing above executed anything: the gated step is still waiting, which is why every voice is sober.
    const tasks = await app.taskStore.list();
    assert.ok(tasks.some((task) => task.steps.some((step) => step.status === 'awaiting_approval')));
    assert.ok(dir.length > 0);
  });

  test('a degraded read is not described in a calm voice', async () => {
    const { base, headers } = await start();
    const degraded = await fetch(`${base}/api/comms?core=degraded`, { headers }).then((r) => r.json());
    assert.equal(degraded.signals.witAllowed, false);
    assert.match(degraded.framings.tactical.headline, /DEGRADED/);
    assert.deepEqual(witMarkersIn(degraded.framings.classic), []);
  });
});
