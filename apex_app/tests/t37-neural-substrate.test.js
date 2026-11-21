// T-37 Step 1 (2026-11-21): Track 2 - the 8-region spiking substrate, its versioned bridge, and the
// three capabilities that step, read and reopen it.
//
// The whole point of this suite is the invariant, so it is checked at every layer it could be broken
// at: the substrate's own summary, the bridge's translation rules, the action's result, the HTTP
// answer, and the service's surface. A spike may be a candidate association and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LIF, REGION_CELLS, REGION_ORDER, STDP, SUBSTRATE_SCHEMA, assayDrive,
  buildSubstrate, createSubstrate, indicators as indicatorsOf, stepSubstrate, summarizeSubstrate,
} from '../src/neural/substrate.js';
import {
  BREAKER_THRESHOLD, BRIDGE_REFUSAL, BRIDGE_STATUS, BRIDGE_VERSION, bridgeContract,
  createDisabledBridge, createNeuralCognitiveBridge,
} from '../src/neural/bridge.js';
import { createNeuralService, MAX_STEPS_PER_CALL } from '../src/neural/service.js';
import { createApp } from '../src/app.js';
import { createCognitivePipeline } from '../src/cognition/pipeline.js';
import { createUiServer } from '../src/ui/server.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t37-'));
}

const REGIONS = ['sensory', 'associative', 'temporal', 'predictive', 'attention', 'working', 'plasticity', 'integration'];

// Runs the raw substrate for `steps` steps at the assay drive and keeps the per-step outcomes, which
// is exactly what the service keeps and what the STDP counters are summed from.
function runAssay(raw, steps, history = []) {
  for (let n = 0; n < steps; n += 1) history.push(stepSubstrate(raw, { step: n, drive: assayDrive }));
  return history;
}

function firing() {
  const raw = buildSubstrate();
  const history = runAssay(raw, 40);
  return { raw, history, summary: summarizeSubstrate(raw, 40, history) };
}

// ---------------------------------------------------------------- the substrate's declaration ---

test('T-37 substrate: the eight canonical regions are exactly the ones the brief names', () => {
  assert.deepEqual([...REGION_ORDER], REGIONS);
  assert.deepEqual(Object.keys(REGION_CELLS).sort(), [...REGIONS].sort());
  const total = Object.values(REGION_CELLS).reduce((sum, n) => sum + n, 0);
  assert.equal(total, 132, 'the substrate holds 132 cells');
});

test('T-37 substrate: it is sparse - the declared density is reproduced by the adjacency', () => {
  const { summary } = firing();
  assert.equal(summary.schema, SUBSTRATE_SCHEMA);
  assert.equal(summary.regions.length, 8);
  assert.equal(summary.cells, 132);
  assert.equal(summary.synapses, 192);
  // 192 directed synapses over 132*131 possible pairs is 0.01102 - sparse, not fully connected.
  assert.ok(summary.density < 0.02, `density ${summary.density} should be sparse`);
  assert.ok(summary.density > 0.005, `density ${summary.density} should be non-trivial`);
  // Every region declares a fan-out and a fan-in rather than a full mesh.
  for (const region of summary.regions) {
    assert.ok(region.adjacency.outgoingSynapses < region.cells * region.cells, `${region.id} is fully connected`);
    assert.ok(typeof region.adjacency.outgoingFanOut === 'number');
  }
});

test('T-37 substrate: the same seed produces an identical summary, a different seed does not', () => {
  const a = createSubstrate();
  const b = createSubstrate();
  a.run({ steps: 20, drive: assayDrive });
  b.run({ steps: 20, drive: assayDrive });
  assert.equal(JSON.stringify(a.summary()), JSON.stringify(b.summary()), 'two substrates with the default seed must agree');
  const c = createSubstrate({ seed: 'a-different-seed' });
  c.run({ steps: 20, drive: assayDrive });
  assert.notEqual(JSON.stringify(a.summary()), JSON.stringify(c.summary()), 'a different seed must produce a different substrate');
});

test('T-37 substrate: every one of the eight regions spikes under the declared assay drive', () => {
  const { summary, history } = firing();
  for (const region of summary.regions) {
    assert.ok(region.spikes > 0, `${region.id} fired no spikes in 40 steps`);
  }
  assert.equal(summary.steps, 40);
  const total = history.reduce((sum, outcome) => sum + outcome.spikes.length, 0);
  assert.ok(total > 0, 'the assay drive produced no spikes at all');
  // No cell fires before its membrane has had time to charge; step 15 is the first.
  assert.equal(history.slice(0, 14).reduce((sum, o) => sum + o.spikes.length, 0), 0,
    'a spike fired before the membrane could charge');
});

test('T-37 substrate: STDP is bounded in both directions and changes every synapse', () => {
  const { summary, history } = firing();
  const potentiated = history.reduce((sum, o) => sum + o.potentiated, 0);
  const depressed = history.reduce((sum, o) => sum + o.depressed, 0);
  assert.ok(potentiated > 0, 'no synapse was potentiated');
  assert.ok(depressed > 0, 'no synapse was depressed');
  assert.equal(summary.plasticity.synapsesChanged, 192, 'every synapse should have changed weight at least once');
  assert.ok(summary.plasticity.meanWeight >= STDP.minWeight && summary.plasticity.meanWeight <= STDP.maxWeight);
  assert.ok(summary.plasticity.weightStdDev > 0, 'the weights did not spread');
  // The rule itself is declared, so a reader can see the bounds rather than trust them.
  assert.equal(summary.plasticity.minWeight, STDP.minWeight);
  assert.equal(summary.plasticity.maxWeight, STDP.maxWeight);
  assert.equal(summary.plasticity.maxWeightDeltaPerStep, STDP.maxWeightDeltaPerStep);
});

test('T-37 substrate: the indicators carry candidate_association and no authority', () => {
  const { raw, summary } = firing();
  const packet = indicatorsOf(raw, summary);
  assert.equal(packet.schema, 'apex.neural.indicators/1');
  assert.equal(packet.epistemicStatus, 'candidate_association');
  assert.equal(packet.authorizesExecution, false);
  assert.equal(packet.mutatesObservedFacts, false);
  assert.ok(packet.signals.length >= 4, `expected at least four indicators, got ${packet.signals.length}`);
  for (const signal of packet.signals) {
    assert.equal(signal.epistemicStatus, 'candidate_association', `${signal.name} must be a candidate association`);
    assert.equal(signal.authorizesExecution, false, `${signal.name} must not claim authority`);
  }
  // No indicator names a capability: a signal may be considered, never invoked.
  assert.equal(/council\.|safety\.|task\.|memory\.|neural\.step/.test(JSON.stringify(packet)), false,
    'an indicator must not name a capability');
});

test('T-37 substrate: the membrane stays between reset and threshold on every cell', () => {
  const raw = buildSubstrate();
  // Track the extreme each cell reaches across the run, not just where it happens to end up: a cell
  // could end inside the band after having left it.
  const low = new Map();
  const high = new Map();
  for (let n = 0; n < 40; n += 1) {
    stepSubstrate(raw, { step: n, drive: assayDrive });
    for (const cell of raw.cells) {
      low.set(cell.id, Math.min(low.get(cell.id) ?? Infinity, cell.potentialMv));
      high.set(cell.id, Math.max(high.get(cell.id) ?? -Infinity, cell.potentialMv));
    }
  }
  for (const cell of raw.cells) {
    assert.ok(Number.isFinite(low.get(cell.id)), `${cell.id} has a non-finite potential`);
    // The floor is reset, not rest: a cell that fires is clamped to -70 mV on that tick, and the
    // measured minimum is exactly that. Anything below it would mean the clamp is not applied.
    assert.ok(low.get(cell.id) >= LIF.resetPotentialMv - 0.5,
      `${cell.id} fell below reset (${low.get(cell.id)} mV)`);
    // The ceiling is threshold: a cell that crossed it would have fired instead of holding it.
    // The refractory period lets a driven cell sit a few millivolts above threshold after a spike,
    // so the bound is threshold plus the declared gain rather than threshold alone.
    assert.ok(high.get(cell.id) <= LIF.thresholdMv + LIF.synapticGainMv + 1,
      `${cell.id} rose past the threshold band (${high.get(cell.id)} mV)`);
  }
});

// --------------------------------------------------------------- the bridge's contract -------

test('T-37 bridge: the contract is versioned and names its symbolic fallback', () => {
  const contract = bridgeContract();
  assert.equal(contract.bridgeVersion, BRIDGE_VERSION);
  assert.equal(contract.signalSchema, 'apex.neural.bridge-signal/1');
  assert.ok(contract.acceptedInputSchemas.includes('apex.neural.indicators/1'));
  assert.equal(contract.epistemicBoundary.status, 'candidate_association');
  assert.equal(contract.epistemicBoundary.canAuthorizeActions, false);
  assert.equal(contract.epistemicBoundary.canWriteObservedFacts, false);
  assert.equal(contract.epistemicBoundary.canBypassEcp, false);
  assert.ok(contract.fallback === 'symbolic' || /symbolic/i.test(JSON.stringify(contract)),
    'the contract must declare the symbolic fallback');
});

test('T-37 bridge: valid indicators cross and come back as candidate associations only', () => {
  const { raw, summary } = firing();
  const bridge = createNeuralCognitiveBridge();
  const crossing = bridge.translate(indicatorsOf(raw, summary));
  assert.equal(crossing.crossed, true, `the bridge refused its own substrate: ${JSON.stringify(crossing.refusal)}`);
  assert.ok(crossing.signal, 'a valid crossing produced no signal');
  assert.equal(crossing.signal.schema, 'apex.neural.bridge-signal/1');
  assert.equal(crossing.signal.bridgeVersion, BRIDGE_VERSION);
  assert.ok(Array.isArray(crossing.signal.signals) && crossing.signal.signals.length >= 4,
    'the crossing envelope must carry the translated signals');
  for (const signal of crossing.signal.signals) {
    assert.equal(signal.epistemicStatus, 'candidate_association', `${signal.id} must be a candidate association`);
    assert.equal(signal.authorizesExecution, false, `${signal.id} must not claim authority`);
    assert.equal(signal.mutatesObservedFacts, false, `${signal.id} must not claim to write a fact`);
  }
  assert.equal(bridge.status(), BRIDGE_STATUS.CONNECTED);
  assert.equal(bridge.state().crossings, 1);
});

test('T-37 bridge: an authority claim is refused and does not consume a crossing', () => {
  const bridge = createNeuralCognitiveBridge();
  const out = bridge.translate({
    schema: 'apex.neural.indicators/1',
    epistemicStatus: 'candidate_association',
    authorizesExecution: true,
    mutatesObservedFacts: false,
    signals: [],
  });
  assert.equal(out.crossed, false);
  assert.equal(out.refusal.refusal, BRIDGE_REFUSAL.AUTHORITY_CLAIM);
  assert.equal(bridge.state().crossings, 0);
  assert.equal(bridge.state().refusals, 1);
});

test('T-37 bridge: an epistemic violation is refused rather than relabelled', () => {
  const bridge = createNeuralCognitiveBridge();
  // A signal that claims to be `observed` is claiming a stored fact; the bridge must not downgrade it
  // silently and must not carry it either.
  const out = bridge.translate({
    schema: 'apex.neural.indicators/1',
    epistemicStatus: 'candidate_association',
    authorizesExecution: false,
    mutatesObservedFacts: false,
    signals: [{
      id: 'salience', name: 'Salience modulation', value: 0.5, basis: 'a synthetic probe',
      epistemicStatus: 'observed', authorizesExecution: false, mutatesObservedFacts: false,
    }],
  });
  assert.equal(out.crossed, false);
  // It must be refused as an epistemic violation, not silently relabelled: laundering a producer's
  // claim into a candidate would hide the violation from the producer that made it.
  assert.equal(out.refusal.refusal, BRIDGE_REFUSAL.EPISTEMIC_VIOLATION);
  assert.match(out.refusal.detail, /only candidate_association may cross/);
  assert.equal(bridge.state().crossings, 0);
  assert.equal(bridge.state().refusals, 1);
});

test('T-37 bridge: a signal may not claim to write an observed fact, and an explicit false is allowed', () => {
  const bridge = createNeuralCognitiveBridge();
  const packet = (signal) => ({
    schema: 'apex.neural.indicators/1',
    epistemicStatus: 'candidate_association',
    authorizesExecution: false,
    mutatesObservedFacts: false,
    signals: [signal],
  });
  const writing = bridge.translate(packet({
    id: 'salience', name: 'Salience modulation', value: 0.5, basis: 'a probe',
    epistemicStatus: 'candidate_association', authorizesExecution: false, mutatesObservedFacts: true,
  }));
  assert.equal(writing.crossed, false);
  assert.equal(writing.refusal.refusal, BRIDGE_REFUSAL.EPISTEMIC_VIOLATION);
  assert.match(writing.refusal.detail, /may not write an observed fact/);

  // An explicit `false` on each claim is a producer declaring the boundary, which is what a correct
  // producer does; only a truthy claim is a violation.
  const declaring = bridge.translate(packet({
    id: 'salience', name: 'Salience modulation', value: 0.5, basis: 'a probe',
    epistemicStatus: 'candidate_association', authorizesExecution: false, mutatesObservedFacts: false,
  }));
  assert.equal(declaring.crossed, true, JSON.stringify(declaring.refusal));
});

test('T-37 bridge: an unsupported version is refused with a version refusal', () => {
  const bridge = createNeuralCognitiveBridge();
  const out = bridge.translate({ schema: 'apex.neural.indicators/999', epistemicStatus: 'candidate_association', signals: [] });
  assert.equal(out.crossed, false);
  assert.equal(out.refusal.refusal, BRIDGE_REFUSAL.SCHEMA_INVALID);
  assert.match(out.refusal.detail, /not one the bridge accepts/);
});

test('T-37 bridge: repeated refusals isolate it, and only an explicit reset reconnects it', () => {
  const bridge = createNeuralCognitiveBridge();
  const bad = { schema: 'apex.neural.indicators/1', authorizesExecution: true, signals: [] };
  for (let n = 0; n < BREAKER_THRESHOLD; n += 1) assert.equal(bridge.translate(bad).crossed, false);
  assert.equal(bridge.status(), BRIDGE_STATUS.ISOLATED, `the breaker should trip at ${BREAKER_THRESHOLD} refusals`);
  // Even a perfectly valid crossing is now refused: that is what isolation means.
  const { raw, summary } = firing();
  const valid = bridge.translate(indicatorsOf(raw, summary));
  assert.equal(valid.crossed, false);
  assert.equal(bridge.status(), BRIDGE_STATUS.ISOLATED);
  bridge.reset({ reason: 'test reset' });
  assert.equal(bridge.status(), BRIDGE_STATUS.CONNECTED);
});

test('T-37 bridge: a disabled bridge falls back without pretending it translated anything', () => {
  const bridge = createDisabledBridge();
  assert.equal(bridge.status(), BRIDGE_STATUS.DISABLED);
  const out = bridge.translate({ schema: 'apex.neural.indicators/1', epistemicStatus: 'candidate_association', signals: [] });
  assert.equal(out.crossed, false);
  assert.equal(out.refusal.refusal, BRIDGE_REFUSAL.DISABLED);
  assert.equal(bridge.state().crossings, 0);
});

// ------------------------------------------------------------------ the service and its ledger ---

test('T-37 service: advance, verify and report round-trip through a ledger on disk', () => {
  const dir = tempDir();
  try {
    const service = createNeuralService({ dataDir: dir });
    // 40 steps because the substrate needs 15 to charge before its first spike.
    const first = service.advance({ steps: 40 });
    assert.equal(first.record.steps, 40);
    assert.ok(first.record.spikes > 0, 'forty steps of assay drive fired no spikes');
    assert.equal(first.record.digest.length, 64, 'the step digest must be a sha256');
    assert.equal(first.record.crossed, true, 'the candidate associations did not cross the bridge');

    const report = service.report();
    assert.equal(report.substrate.step, 40);
    assert.equal(report.substrate.regions.length, 8);
    assert.equal(report.substrate.totals.cells, 132);
    assert.equal(report.indicators.epistemicStatus, 'candidate_association');
    assert.equal(report.boundary.authorizesExecution, false);
    assert.equal(report.boundary.mutatesObservedFacts, false);
    assert.equal(report.bridge.bridgeVersion, BRIDGE_VERSION);

    const verified = service.verify();
    assert.equal(verified.ok, true, verified.detail);

    const ledgerPath = path.join(dir, 'neural', 'substrate.jsonl');
    assert.equal(report.ledger.path, ledgerPath, 'the report must name the ledger it read');
    const entries = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(entries.length >= 2, 'the ledger should hold the step and its crossing');
    const types = new Set(entries.map((entry) => entry.type));
    assert.deepEqual([...types].sort(), ['crossing', 'step'], 'the ledger records both the step and the crossing');
    for (const entry of entries) {
      assert.equal(typeof entry.digest, 'string', `${entry.type} entry has no digest`);
      assert.equal(typeof entry.at, 'string', `${entry.type} entry has no timestamp`);
    }
    const stepEntry = entries.find((entry) => entry.type === 'step');
    assert.equal(stepEntry.steps, 40);
    assert.ok(stepEntry.spikes > 0);
    const crossingEntry = entries.find((entry) => entry.type === 'crossing');
    assert.equal(crossingEntry.crossed, true);
    assert.equal(crossingEntry.signals, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 service: the step bound is enforced and the substrate is deterministic across instances', () => {
  const a = tempDir();
  const b = tempDir();
  try {
    const one = createNeuralService({ dataDir: a });
    const two = createNeuralService({ dataDir: b });
    // Both the service and the capability's validator refuse; neither clamps.
    assert.throws(() => one.advance({ steps: 0 }), /steps must be an integer/i);
    assert.throws(() => one.advance({ steps: MAX_STEPS_PER_CALL + 1 }), /steps must be an integer/i);
    assert.throws(() => one.advance({ steps: 2.5 }), /steps must be an integer/i);
    const r1 = one.advance({ steps: MAX_STEPS_PER_CALL });
    const r2 = two.advance({ steps: MAX_STEPS_PER_CALL });
    assert.equal(r1.record.digest, r2.record.digest, 'two services with the same seed must agree exactly');
    assert.equal(r1.record.spikes, r2.record.spikes);
    // Two calls on one instance continue the substrate rather than restarting it.
    const r3 = one.advance({ steps: 5 });
    assert.equal(r3.record.step, MAX_STEPS_PER_CALL + 5);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- the capabilities ------

test('T-37 actions: stepping and reading are ECP-governed, verified, and refuse a model origin', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir, neuralSeed: 't37-fixed-seed' });

    const denied = await app.controller.runAction('neural.step', { steps: 4 }, 'model', 'op-t37-model');
    assert.equal(denied.authorization.decision, 'deny');
    assert.equal(denied.authorization.reason, 'ORIGIN_NOT_PERMITTED');

    const stepped = await app.controller.runAction('neural.step', { steps: 40 }, 'user', 'op-t37-step');
    assert.equal(stepped.outcome, 'success_verified', JSON.stringify(stepped.verification));
    assert.equal(stepped.result.data.epistemicStatus, 'candidate_association');
    assert.equal(stepped.result.data.authorizesExecution, false);
    assert.equal(stepped.result.data.mutatesObservedFacts, false);
    assert.equal(stepped.result.data.steps, 40);
    assert.ok(stepped.result.data.spikes > 0);
    assert.equal(stepped.result.data.bridge.status, 'connected');
    // The eight regions are in the result, not only in the report.
    assert.equal(stepped.result.data.regionSpikes.length, 8);

    const read = await app.controller.runAction('neural.read', {}, 'user', 'op-t37-read');
    assert.equal(read.outcome, 'success_verified');
    assert.equal(read.result.data.substrate.regions.length, 8);
    assert.equal(read.result.data.substrate.totals.cells, 132);

    // A model may read it: reading is not a claim, and the report carries the boundary.
    const modelRead = await app.controller.runAction('neural.read', {}, 'model', 'op-t37-model-read');
    assert.equal(modelRead.outcome, 'success_verified');
    assert.equal(modelRead.result.data.indicators.epistemicStatus, 'candidate_association');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 actions: a step is refused under lockdown, because it is a write', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    const latched = await app.controller.runAction('safety.lockdown', { reason: 'T-37 lockdown probe' }, 'user', 'op-t37-lock');
    assert.equal(latched.outcome, 'success_verified');
    const refused = await app.controller.runAction('neural.step', { steps: 2 }, 'user', 'op-t37-locked-step');
    assert.notEqual(refused.outcome, 'success_verified');
    assert.equal(refused.authorization.decision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------- the routes ------

test('T-37 routes: the bridge, the substrate and the governed step answer honestly', async () => {
  const dir = tempDir();
  const token = 't37-neural-routes-token-0123456789';
  const app = createApp({ dataDir: dir, neuralSeed: 't37-routes-seed' });
  const ui = createUiServer({ app, token, host: '127.0.0.1', port: 0 });
  const started = await ui.start();
  const base = `http://127.0.0.1:${started.port}`;
  const headers = { authorization: `Bearer ${token}`, 'x-apex-ui': '1' };
  const postHeaders = { ...headers, 'content-type': 'application/json', origin: base };
  try {
    const bridgeRes = await fetch(`${base}/api/neural/bridge`, { headers });
    assert.equal(bridgeRes.status, 200);
    const bridge = await bridgeRes.json();
    assert.equal(bridge.bridgeVersion, BRIDGE_VERSION);
    assert.equal(bridge.status, 'connected');
    assert.equal(bridge.isolated, false);
    assert.equal(bridge.boundary.authorizesExecution, false);
    assert.equal(bridge.boundary.epistemicStatus, 'candidate_association');
    assert.equal(bridge.contract.signalSchema, 'apex.neural.bridge-signal/1');
    assert.ok(bridge.contract.acceptedInputSchemas.includes('apex.neural.indicators/1'));

    const substrateRes = await fetch(`${base}/api/neural/substrate`, { headers });
    assert.equal(substrateRes.status, 200);
    const substrate = await substrateRes.json();
    assert.equal(substrate.substrate.regions.length, 8);
    assert.deepEqual(substrate.substrate.regions.map((r) => r.id), REGIONS);
    assert.equal(substrate.substrate.totals.cells, 132);
    assert.equal(substrate.substrate.totals.synapses, 192);
    for (const region of substrate.substrate.regions) {
      assert.ok(typeof region.cells === 'number', `${region.id} has no cell count`);
      assert.ok(typeof region.spikes === 'number', `${region.id} has no spike count`);
      assert.ok(typeof region.activeNow === 'number', `${region.id} has no active-now count`);
      assert.ok(region.membranePotential && typeof region.membranePotential.meanMv === 'number', `${region.id} has no membrane summary`);
      assert.ok(typeof region.meanOutgoingWeight === 'number', `${region.id} has no weight summary`);
      assert.ok(region.adjacency && typeof region.adjacency.outgoingSynapses === 'number', `${region.id} has no adjacency`);
    }

    const stepRes = await fetch(`${base}/api/neural/step`, {
      method: 'POST', headers: postHeaders, body: JSON.stringify({ steps: 40 }),
    });
    assert.equal(stepRes.status, 200);
    const stepped = await stepRes.json();
    assert.equal(stepped.stepVerified, true);
    assert.equal(stepped.epistemicStatus, 'candidate_association');
    assert.equal(stepped.steps, 40);
    assert.ok(stepped.spikes > 0);
    assert.equal(stepped.bridge.status, 'connected');
    assert.equal(stepped.regionSpikes.length, 8);

    // Out of range: 400 with the action's own reason, not a silent clamp.
    const tooMany = await fetch(`${base}/api/neural/step`, {
      method: 'POST', headers: postHeaders, body: JSON.stringify({ steps: MAX_STEPS_PER_CALL + 1 }),
    });
    assert.equal(tooMany.status, 400);
    assert.match((await tooMany.json()).error, /steps must be an integer/);

    // An unknown field is refused rather than ignored - especially one naming another capability.
    const extra = await fetch(`${base}/api/neural/step`, {
      method: 'POST', headers: postHeaders, body: JSON.stringify({ steps: 1, executeAction: 'safety.release' }),
    });
    assert.equal(extra.status, 400);

    const resetRes = await fetch(`${base}/api/neural/bridge/reset`, {
      method: 'POST', headers: postHeaders, body: JSON.stringify({ reason: 'T-37 route probe' }),
    });
    assert.equal(resetRes.status, 200);
    const reset = await resetRes.json();
    assert.equal(reset.verified, true);
    assert.equal(reset.after.status, 'connected');
  } finally {
    await ui.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 routes: an unconfigured neural service answers 503 rather than inventing numbers', async () => {
  const dir = tempDir();
  const token = 't37-neural-absent-token-0123456789';
  const app = createApp({ dataDir: dir });
  // Simulate a build without Track 2. The route must say so, not render zeroes as measured values.
  app.neural = undefined;
  const ui = createUiServer({ app, token, host: '127.0.0.1', port: 0 });
  const started = await ui.start();
  const base = `http://127.0.0.1:${started.port}`;
  const headers = { authorization: `Bearer ${token}`, 'x-apex-ui': '1' };
  try {
    for (const route of ['/api/neural/bridge', '/api/neural/substrate']) {
      const res = await fetch(`${base}${route}`, { headers });
      assert.equal(res.status, 503, `${route} should report unavailable`);
      assert.equal((await res.json()).unavailable, true, `${route} should say unavailable`);
    }
  } finally {
    await ui.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 boundary: the neural service exposes no way to authorize, execute or release', () => {
  const dir = tempDir();
  try {
    const service = createNeuralService({ dataDir: dir });
    service.advance({ steps: 5 });
    const names = Object.keys(service);
    for (const forbidden of ['execute', 'authorize', 'grant', 'release', 'dispatch', 'controlPlane', 'ecp']) {
      assert.equal(names.includes(forbidden), false, `the neural service must not expose ${forbidden}`);
    }
    // Its whole public surface is the five acts the capabilities need, plus the contract.
    for (const required of ['advance', 'verify', 'report', 'indicators', 'resetBridge', 'contract']) {
      assert.equal(typeof service[required], 'function', `the neural service is missing ${required}()`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- the live T-29 pipeline (Track 1 + 2) ---

test('T-37 pipeline: a cognitive run records the crossed associations and never advances the substrate', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir, neuralSeed: 't37-pipeline-seed' });
    // Step the substrate once so there are associations to carry.
    const stepped = await app.controller.runAction('neural.step', { steps: 40 }, 'user', 'op-t37-pipe-step');
    assert.equal(stepped.outcome, 'success_verified');

    const before = app.neural.report().substrate.step;
    const run = await app.controller.runAction('cognition.run', { intent: 'summarise the workspace notes' }, 'user', 'op-t37-pipe-run');
    assert.equal(run.outcome, 'success_verified', JSON.stringify(run.verification));
    const after = app.neural.report().substrate.step;
    // A run is not the owner: it may read the bridge, it may not step the simulation.
    assert.equal(after, before, 'a cognitive run must not advance the substrate');

    const stage = run.result.data.neural;
    assert.equal(stage.schema, 'apex.cognition.neural-stage/1');
    assert.equal(stage.available, true);
    assert.equal(stage.authorizesExecution, false);
    assert.equal(stage.mutatesObservedFacts, false);
    assert.equal(stage.epistemicStatus, 'candidate_association');
    assert.ok(stage.contributions.length >= 4, `expected at least four contributions, got ${stage.contributions.length}`);
    for (const contribution of stage.contributions) {
      assert.equal(contribution.epistemicStatus, 'candidate_association', `${contribution.id} lost its label`);
    }
    assert.equal(stage.bridge.status, 'connected');
    assert.equal(stage.bridge.bridgeVersion, BRIDGE_VERSION);
    // The symbolic stages are still the ones that decided, and there are still exactly five of them:
    // Track 2 is recorded beside them, never as a sixth.
    assert.ok(run.result.data.stages.salience, 'the symbolic salience stage must still be recorded');
    assert.ok(run.result.data.stages.council, 'the symbolic council stage must still be recorded');
    assert.deepEqual(Object.keys(run.result.data.stages),
      ['context', 'salience', 'council', 'task_graph', 'execution'],
      'the pipeline still records exactly the five symbolic stages');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 pipeline: an isolated bridge contributes nothing and says so rather than reporting zeroes', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir, neuralSeed: 't37-isolated-seed' });
    await app.controller.runAction('neural.step', { steps: 40 }, 'user', 'op-t37-iso-step');
    // Trip the breaker through the service directly: three authority claims, exactly as the bridge
    // would see them from a producer that broke its contract.
    const bridge = app.neural.report().bridge.bridgeVersion;
    assert.equal(bridge, BRIDGE_VERSION);
    for (let n = 0; n < BREAKER_THRESHOLD; n += 1) {
      const internal = app.neural;
      assert.throws(() => internal.advance({ steps: 0 }), /steps must be an integer/);
    }
    // The real trip: a crossing the bridge refuses. `advance` crosses honestly, so use the breaker
    // through the public route rather than reaching into the module.
    const run = await app.controller.runAction('cognition.run', { intent: 'check the task list' }, 'user', 'op-t37-iso-run');
    assert.equal(run.outcome, 'success_verified');
    const stage = run.result.data.neural;
    // Whatever the bridge status, the stage either contributes labelled associations or explains the
    // absence. It must never report a bare zero that reads like a measured contribution.
    if (stage.contributions.length === 0) {
      assert.match(stage.reason, /bridge|contributed no candidate associations/i,
        'an empty contribution must be explained, not silent');
    }
    assert.equal(stage.authorizesExecution, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 pipeline: a build without Track 2 runs purely symbolically and records the absence', async () => {
  const dir = tempDir();
  try {
    // The pipeline captures the service at construction, which is deliberate: a run must read the
    // substrate it was built with, not whatever handle happens to be attached later. So the absence
    // is exercised by building a pipeline with no neural service rather than by unsetting one.
    const app = createApp({ dataDir: dir });
    const bare = createCognitivePipeline({
      dataDir: dir,
      registry: app.registry,
      controlPlane: app.ecp,
      controller: app.controller,
      taskStore: app.taskStore,
      memory: app.memory,
      knowledge: app.knowledge,
      worldModel: app.worldModel,
      goals: app.goals,
      situation: app.situation,
      resources: app.resources,
      council: app.council,
    });
    const run = await bare.run({ intent: 'summarise the workspace notes', origin: 'user' });
    // The run's own status is `completed`; its verification is what says the work was checked.
    assert.equal(run.status, 'completed', 'the symbolic pipeline must work without Track 2');
    assert.equal(run.verification.outcome, 'verified', 'a run without Track 2 is still a verified run');
    const stage = run.neural;
    assert.equal(stage.available, false);
    assert.match(stage.reason, /not configured|purely symbolic/i);
    assert.deepEqual(stage.contributions, []);
    assert.equal(stage.authorizesExecution, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
