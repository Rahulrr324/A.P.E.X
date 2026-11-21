// T-37 Step 3 (2026-11-21): the deterministic executive command router.
//
// The claims worth testing are small and specific: that each phrase the brief named reaches the route
// it names, that a phrase *inside* a sentence does not reach it, that every dispatch returns a receipt
// with the fields the UI renders, that lockdown is routed and refuses to be routed around, and that
// nothing in the module contacts a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROUTE_KIND, ROUTER_SCHEMA, RECEIPT_SCHEMA, PRESENTATION_MODES, createCommandRouter, routeLine } from '../src/cognition/command-router.js';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t37-router-'));
}

// --------------------------------------------------------------- the routing decision (pure) ---

test('T-37 router: each phrase the brief named reaches the route it named', () => {
  const cases = [
    ['sense workspace', ROUTE_KIND.SENSE, 'perception.sense_host'],
    ['sense host', ROUTE_KIND.SENSE, 'perception.sense_host'],
    ['refresh telemetry', ROUTE_KIND.SENSE, 'perception.sense_host'],
    ['run doctor', ROUTE_KIND.HEALTH, null],
    ['system check', ROUTE_KIND.HEALTH, null],
    ['status report', ROUTE_KIND.HEALTH, null],
    ['acknowledge briefing', ROUTE_KIND.BRIEFING, 'briefing.acknowledge'],
    ['briefing delta', ROUTE_KIND.BRIEFING, null],
    ['verify workshop', ROUTE_KIND.WORKSHOP, 'workshop.verify'],
  ];
  for (const [line, kind, action] of cases) {
    const route = routeLine(line);
    assert.equal(route.kind, kind, `"${line}" should route to ${kind}, got ${route.kind}`);
    if (action) assert.equal(route.action, action, `"${line}" should invoke ${action}`);
  }
});

test('T-37 router: the argument-carrying routes keep the owner’s words', () => {
  const council = routeLine('council: Verify Release Readiness');
  assert.equal(council.kind, ROUTE_KIND.COUNCIL);
  assert.equal(council.action, 'council.deliberate');
  // The argument keeps its case: it is the question the owner asked, not a normalised token.
  assert.equal(council.argument, 'Verify Release Readiness');

  const deliberate = routeLine('deliberate should we widen the sensor budget');
  assert.equal(deliberate.kind, ROUTE_KIND.COUNCIL);
  assert.equal(deliberate.argument, 'should we widen the sensor budget');

  const mode = routeLine('mode overwatch');
  assert.equal(mode.kind, ROUTE_KIND.MODE);
  assert.equal(mode.argument, 'overwatch');

  const safety = routeLine('lockdown the sensor is compromised');
  assert.equal(safety.kind, ROUTE_KIND.SAFETY);
  assert.equal(safety.action, 'safety.lockdown');
  assert.equal(safety.argument, 'the sensor is compromised');
});

test('T-37 router: a phrase inside a sentence does not reach its route', () => {
  // The distinction that matters: "run doctor" is a command, "do not run doctor" is a request about
  // one. Matching on containment would run the doctor for the second.
  for (const line of ['do not run doctor', 'should I run doctor', 'I already ran the doctor', 'not now']) {
    assert.equal(routeLine(line).kind, ROUTE_KIND.MISSION, `"${line}" must not reach the doctor route`);
  }
  // But a phrase followed by a separator still does.
  assert.equal(routeLine('run doctor.').kind, ROUTE_KIND.HEALTH);
  assert.equal(routeLine('run doctor, please').kind, ROUTE_KIND.HEALTH);
  assert.equal(routeLine('sense workspace now').kind, ROUTE_KIND.SENSE);
});

test('T-37 router: everything else goes to the pipeline rather than being guessed at', () => {
  const lines = [
    'what should I do about the launch',
    'summarise the workspace notes',
    'this sentence matches no route at all',
  ];
  for (const line of lines) {
    const route = routeLine(line);
    assert.equal(route.kind, ROUTE_KIND.MISSION, `"${line}" should fall through to the pipeline`);
    assert.equal(route.argument, line, 'the pipeline receives the owner’s line intact');
  }
});

test('T-37 router: an empty line names no route and a very long one is refused', () => {
  assert.equal(routeLine('   ').kind, ROUTE_KIND.UNMATCHED);
  assert.equal(routeLine('').kind, ROUTE_KIND.UNMATCHED);
  const long = routeLine('x'.repeat(2001));
  assert.equal(long.kind, ROUTE_KIND.UNMATCHED);
  assert.match(long.reason, /longer than 2000/);
});

test('T-37 router: control characters are normalised rather than carried into a capability', () => {
  const route = routeLine('sense\u0000workspace\u001b');
  assert.equal(route.kind, ROUTE_KIND.SENSE);
  // And whitespace runs collapse, so a line typed with stray spaces still routes.
  assert.equal(routeLine('  sense    workspace  ').kind, ROUTE_KIND.SENSE);
});

test('T-37 router: the module imports no model client and makes no network call', () => {
  // A router that could call a model would not be deterministic. The test is on what would make the
  // call, not on the word: the module's own comment says it performs no inference, and matching that
  // word would fail on its own documentation.
  const source = fs.readFileSync(new URL('../src/cognition/command-router.js', import.meta.url), 'utf8');
  for (const forbidden of ['ollama', 'openai', 'anthropic', 'localhost:', 'http://', 'https://', 'fetch(']) {
    assert.equal(source.toLowerCase().includes(forbidden), false,
      `the router must not contain "${forbidden}"`);
  }
  // Its only imports are the string helper; there is no network, model or store module in the graph.
  const imports = [...source.matchAll(/^import\s.*from\s+'([^']+)'/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['../util.js'], `the router should import only the string helper, found ${imports.join(', ')}`);
});

// ------------------------------------------------------------------- the dispatch (live) ---

test('T-37 router: every dispatch returns a receipt with the fields the deck renders', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    const router = app.commandRouter;
    assert.ok(router, 'the application must compose a router');
    assert.equal(router.schema, ROUTER_SCHEMA);
    assert.deepEqual(router.modes(), [...PRESENTATION_MODES]);

    const receipt = await router.dispatch('mode tactical');
    assert.equal(receipt.schema, RECEIPT_SCHEMA);
    for (const field of ['routeKind', 'actionInvoked', 'targetView', 'ecpDecision', 'verified', 'summary']) {
      assert.ok(field in receipt, `the receipt is missing ${field}`);
    }
    // A routing decision is never an authorization, and every receipt says so.
    assert.equal(receipt.authorizesExecution, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 router: a sense route takes a real reading through the governed capability', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    const receipt = await app.commandRouter.dispatch('sense workspace');
    assert.equal(receipt.routeKind, ROUTE_KIND.SENSE);
    assert.equal(receipt.actionInvoked, 'perception.sense_host');
    assert.equal(receipt.ecpDecision, 'allow');
    assert.equal(receipt.verified, true, `the reading did not verify: ${receipt.summary}`);
    assert.equal(receipt.targetView, 'sentinel');
    // What actually landed in the observation ledger is what the receipt claims.
    const state = app.perception.state();
    assert.ok(state, 'the perception service must report its state');
    const observations = app.perception.observations();
    assert.ok(Array.isArray(observations) && observations.length > 0,
      'a verified sense must leave an observation behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 router: the health route reports the doctor’s real counts, not a placeholder', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    const receipt = await app.commandRouter.dispatch('run doctor');
    assert.equal(receipt.routeKind, ROUTE_KIND.HEALTH);
    assert.equal(receipt.verified, true);
    // A confident `?/?` would be the exact failure this assertion exists to catch.
    assert.equal(/\?\/\?/.test(receipt.summary), false, `the summary invented a count: ${receipt.summary}`);
    assert.match(receipt.summary, /pass/);
    assert.ok(receipt.result && typeof receipt.result.counts === 'object');
    assert.equal(receipt.targetView, 'system');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 router: a council route deliberates and names its recommendation', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    const receipt = await app.commandRouter.dispatch('council: verify release readiness');
    assert.equal(receipt.routeKind, ROUTE_KIND.COUNCIL);
    assert.equal(receipt.actionInvoked, 'council.deliberate');
    assert.equal(receipt.ecpDecision, 'allow');
    assert.equal(receipt.verified, true, receipt.summary);
    assert.equal(receipt.targetView, 'council');
    assert.match(receipt.summary, /Deliberated/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 router: `deliberate` with no question opens the workspace and invents nothing', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    const receipt = await app.commandRouter.dispatch('deliberate');
    assert.equal(receipt.routeKind, ROUTE_KIND.COUNCIL);
    // No capability was invoked: there was no objective, and inventing one would be the router
    // deciding what the owner should think about.
    assert.equal(receipt.actionInvoked, null);
    assert.equal(receipt.verified, false);
    assert.equal(receipt.targetView, 'council');
    assert.match(receipt.detail, /council:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 router: an unknown mode is refused by name and lists the real ones', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    const receipt = await app.commandRouter.dispatch('mode cinematic');
    assert.equal(receipt.routeKind, ROUTE_KIND.MODE);
    assert.equal(receipt.target, null);
    assert.match(receipt.summary, /not a presentation mode/);
    for (const mode of PRESENTATION_MODES) {
      assert.match(receipt.detail, new RegExp(mode));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 router: a general intent runs the T-29 pipeline and returns its record', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    const receipt = await app.commandRouter.dispatch('summarise the workspace notes');
    assert.equal(receipt.routeKind, ROUTE_KIND.MISSION);
    assert.equal(receipt.actionInvoked, 'cognition.run');
    assert.equal(receipt.ecpDecision, 'allow');
    assert.equal(receipt.verified, true, receipt.summary);
    assert.equal(receipt.targetView, 'cognition');
    assert.deepEqual(receipt.input, { intent: 'summarise the workspace notes' });
    // The run really exists in the pipeline's own store, not only in the receipt.
    const runs = await app.cognition.list({ limit: 5 });
    assert.ok(runs.runs.length >= 1, 'the pipeline recorded no run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------- lockdown ---

test('T-37 router: lockdown is routed, latches the ECP, and cannot be routed around', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    const latched = await app.commandRouter.dispatch('lockdown the sensor is compromised');
    assert.equal(latched.routeKind, ROUTE_KIND.SAFETY);
    assert.equal(latched.actionInvoked, 'safety.lockdown');
    assert.equal(latched.verified, true, latched.summary);
    assert.equal(app.ecp.killSwitchStatus().active, true, 'the latch did not engage');

    // With the latch engaged, a presentation mode is refused: a mode must not make a stopped system
    // look calm.
    const mode = await app.commandRouter.dispatch('mode tactical');
    assert.equal(mode.ecpDecision, 'deny');
    assert.equal(mode.verified, false);
    assert.match(mode.summary, /lockdown latch is engaged/);

    // And a capability route is denied by the ECP itself, not by the router deciding for it.
    const sensed = await app.commandRouter.dispatch('sense workspace');
    assert.equal(sensed.ecpDecision, 'deny');
    assert.equal(sensed.verified, false);
    assert.match(sensed.summary, /KILL_SWITCH_ACTIVE|did not verify/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------- the route ---

test('T-37 route: POST /api/command/dispatch returns the receipt and refuses a bad body', async () => {
  const dir = tempDir();
  const token = 't37-router-http-token-0123456789';
  const app = createApp({ dataDir: dir });
  const ui = createUiServer({ app, token, host: '127.0.0.1', port: 0 });
  const started = await ui.start();
  const base = `http://127.0.0.1:${started.port}`;
  const headers = { authorization: `Bearer ${token}`, 'x-apex-ui': '1', 'content-type': 'application/json', origin: base };
  try {
    const ok = await fetch(`${base}/api/command/dispatch`, {
      method: 'POST', headers, body: JSON.stringify({ line: 'mode overwatch' }),
    });
    assert.equal(ok.status, 200);
    const receipt = await ok.json();
    assert.equal(receipt.schema, RECEIPT_SCHEMA);
    assert.equal(receipt.routeKind, ROUTE_KIND.MODE);
    assert.equal(receipt.target, 'overwatch');

    const empty = await fetch(`${base}/api/command/dispatch`, {
      method: 'POST', headers, body: JSON.stringify({ line: '   ' }),
    });
    assert.equal(empty.status, 400);

    const extra = await fetch(`${base}/api/command/dispatch`, {
      method: 'POST', headers, body: JSON.stringify({ line: 'sense workspace', action: 'safety.release' }),
    });
    assert.equal(extra.status, 400, 'an unknown field must be refused, especially one naming a capability');

    const long = await fetch(`${base}/api/command/dispatch`, {
      method: 'POST', headers, body: JSON.stringify({ line: 'x'.repeat(2001) }),
    });
    assert.equal(long.status, 400);
  } finally {
    await ui.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 router: a release is not reachable through the command router', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    await app.commandRouter.dispatch('lockdown probe');
    assert.equal(app.ecp.killSwitchStatus().active, true);
    // `safety.release` needs a typed reason, an explicit confirmation and the step-up secret when one
    // is configured. The router has no route that names it, and no line shapes one.
    for (const line of ['release lockdown', 'safety.release', 'unlock', 'release the latch']) {
      const receipt = await app.commandRouter.dispatch(line);
      assert.notEqual(receipt.actionInvoked, 'safety.release', `"${line}" must not reach the release`);
    }
    assert.equal(app.ecp.killSwitchStatus().active, true, 'the latch must still be engaged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
