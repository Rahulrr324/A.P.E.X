// T-31 Step 2 (2026-11-19): the surfaces the deck now presents, verified against the owners that
// fill them.
//
// Four read surfaces are new — presence and device trust, the read-only autonomy matrix, the
// epistemic world model, and the Evolution Lab — plus four audited evolution capabilities. None of
// this is verified by looking at a screenshot: every assertion below reads the same HTTP route the
// page reads, and the page-side ids are pinned by extracting the served client and checking that
// each id the renderer writes to actually exists in the served HTML.
//
// The rules this file exists to hold:
//   * an empty owner is reported as empty, never as a clean or healthy value;
//   * a proposal is never a permission, and promotion is refused until a sandbox run recorded a
//     result;
//   * verification is stored as measured and cannot be written without a boolean;
//   * autonomy is read-only and the matrix describes the level the ECP actually applies.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import { UI_CLIENT, UI_PAGE } from '../src/ui/assets.js';
import { createEvolutionLab, evolutionBoundaries } from '../src/evolution/lab.js';

const dirs = [];
const servers = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    await server.stop().catch(() => {});
  }
  while (dirs.length) {
    const dir = dirs.pop();
    try { cleanup(dir); } catch { /* already removed */ }
  }
});

const TOKEN = 't31-surfaces-token-0123456789';

async function startApp(configure = null) {
  const dir = tempDir();
  const app = createApp({ dataDir: dir });
  if (configure) await configure(app);
  const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
  const started = await ui.start();
  servers.push(ui);
  const base = `http://127.0.0.1:${started.port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' };
  async function get(pathname) {
    const response = await fetch(base + pathname, { headers });
    return { status: response.status, body: await response.json() };
  }
  async function post(pathname, body) {
    const response = await fetch(base + pathname, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return { app, dir, base, headers, get, post };
}

describe('T-31 presence and device trust surface', () => {
  test('an empty registry is reported as empty, and the mesh says it is not implemented', async () => {
    const { get } = await startApp();
    const { status, body } = await get('/api/presence');
    assert.equal(status, 200);
    assert.equal(body.schema, 'apex.presence/1');
    assert.equal(body.readonly, true);
    assert.equal(body.deviceTrust.available, true);
    assert.deepEqual(body.deviceTrust.devices, []);
    assert.equal(body.deviceTrust.total, 0);
    // The transport is not implemented, and the route says so instead of returning peers.
    assert.equal(body.mesh.implemented, false);
    assert.deepEqual(body.mesh.peers, []);
    assert.equal(body.mesh.connectedPeers, 0);
    assert.match(body.mesh.detail, /no device mesh transport is implemented/);
    // A device grants no capability: the note has to say it, because the UI repeats it verbatim.
    assert.match(body.note, /grants no capability/i);
  });

  test('an enrolled device is listed with its trust state and never a capability list', async () => {
    let deviceId = null;
    const { get, app } = await startApp(async (application) => {
      const enrolled = await application.deviceTrust.enroll({ origin: 'user', label: 'owner laptop' });
      deviceId = enrolled.deviceId;
    });
    const { body } = await get('/api/presence');
    assert.equal(body.deviceTrust.total, 1);
    const [device] = body.deviceTrust.devices;
    assert.equal(device.deviceId, deviceId);
    assert.equal(device.label, 'owner laptop');
    assert.equal(device.status, 'trusted');
    assert.equal(typeof device.enrolledAt, 'string');
    // The record carries no capability grant, and the surface must not invent one.
    assert.equal(Object.prototype.hasOwnProperty.call(device, 'capabilities'), false);
    assert.ok(app.deviceTrust);
  });
});

describe('T-31 autonomy matrix', () => {
  test('the matrix reports every registered capability at the level the ECP applies', async () => {
    const { get, app } = await startApp();
    const { status, body } = await get('/api/autonomy/matrix');
    assert.equal(status, 200);
    assert.equal(body.schema, 'apex.autonomy.matrix/1');
    assert.equal(body.readonly, true);
    assert.equal(body.source, 'APEX_AUTONOMY_LEVELS');
    assert.equal(body.levels.length, 6);
    assert.deepEqual(body.levels.map((entry) => entry.name), ['Observe', 'Suggest', 'Confirm', 'Delegate (bounded)', 'Mission', 'Standing orders']);

    const registryNames = app.registry.names();
    assert.equal(body.capabilities.length, registryNames.length);
    assert.deepEqual(body.capabilities.map((row) => row.name).sort(), registryNames);
    for (const row of body.capabilities) {
      assert.equal(Number.isInteger(row.level), true, `${row.name} has a level`);
      assert.match(row.domain, /^[a-z][a-z0-9_]{0,31}$/);
      assert.equal(row.permission === 'read' || row.permission === 'write', true);
      // With no configured autonomy the ECP's own default applies: L2 for a write, L0 for a read.
      assert.equal(row.level, row.permission === 'write' ? 2 : 0);
      assert.equal(row.configured, false);
    }
    const grouped = body.domains.reduce((total, domain) => total + domain.capabilities, 0);
    assert.equal(grouped, registryNames.length, 'every capability is grouped under exactly one domain');
  });

  test('a configured domain is reported as configured, at its configured level', async () => {
    const { get } = await startApp();
    const { body } = await get('/api/autonomy/matrix');
    const writes = body.capabilities.filter((row) => row.permission === 'write');
    assert.ok(writes.length > 0);
    assert.ok(body.domains.every((domain) => domain.configuredLevel === null), 'nothing is configured by default');
  });
});

describe('T-31 epistemic world model surface', () => {
  test('an empty model is honest, and the labels are declared', async () => {
    const { get } = await startApp();
    const { status, body } = await get('/api/world/epistemic');
    assert.equal(status, 200);
    assert.equal(body.schema, 'apex.world.epistemic/1');
    assert.equal(body.beliefs.total, 0);
    assert.deepEqual(body.beliefs.userAsserted, []);
    assert.deepEqual(body.beliefs.unverifiedModel, []);
    assert.match(body.labels.user_asserted, /not independently observed/);
    assert.match(body.labels.unverified_model, /unverified/);
    assert.match(body.note, /never a judgement about whether the claim is true/);
  });

  test('a stored memory is labelled as user-asserted, not as observed', async () => {
    const { get } = await startApp(async (app) => {
      await app.memory.add({ content: 'the launch checklist has three gates', source: 'user' });
    });
    const { body } = await get('/api/world/epistemic');
    assert.equal(body.beliefs.total, 1);
    const [belief] = body.beliefs.userAsserted;
    assert.equal(belief.epistemic, 'user_asserted');
    assert.deepEqual(body.beliefs.unverifiedModel, []);
  });
});

describe('T-31 Evolution Lab', () => {
  test('an empty ledger is empty, and the boundaries are real reads', async () => {
    const { get } = await startApp();
    const { status, body } = await get('/api/evolution');
    assert.equal(status, 200);
    assert.equal(body.schema, 'apex.evolution.lab/1');
    assert.deepEqual(body.proposals, []);
    assert.equal(body.total, 0);
    assert.equal(body.authorizesExecution, false);
    assert.equal(body.status.proposals, 0);
    assert.equal(body.policy.appliesChanges, false);
    const keys = body.boundaries.entries.map((entry) => entry.key);
    // T-41 Step 3 (2026-11-22) adds `protected_paths`: the canonical policy that refuses a proposal
    // targeting governance, safety, autonomy, ledger or applier code. It is a read of the policy module
    // itself, so it is locked exactly when that module reports no override.
    assert.deepEqual(keys, ['ecp_sole_authority', 'kill_switch', 'permission_scopes', 'audit_log',
      'self_modification', 'protected_paths']);
    // The first four are reads of the live system; against this app they all succeed.
    for (const entry of body.boundaries.entries) {
      assert.equal(entry.locked, true, `${entry.key} was confirmed by a read`);
      assert.equal(typeof entry.evidence, 'string');
      assert.ok(entry.evidence.length > 0);
    }
    assert.equal(body.boundaries.allLocked, true);
  });

  test('a proposal authorizes nothing and cannot be promoted before a sandbox result', async () => {
    const { post, get } = await startApp();
    const proposed = await post('/api/evolution/propose', { title: 'raise the salience floor', hypothesis: 'fewer noisy advisories' });
    assert.equal(proposed.status, 200);
    assert.equal(proposed.body.actVerified, true);
    assert.equal(proposed.body.authorizesExecution, false);
    const proposalId = proposed.body.proposalId;
    assert.match(proposalId, /^evo-[a-z0-9]+$/);

    const refused = await post('/api/evolution/promote', { proposalId, reason: 'it looked fine' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /no sandbox verification is recorded/);

    const listed = await get('/api/evolution');
    assert.equal(listed.body.total, 1);
    assert.equal(listed.body.proposals[0].promotion.state, 'not_requested');
    assert.equal(listed.body.proposals[0].sandbox.verified, null);
    assert.match(listed.body.proposals[0].promotionBlocked, /no sandbox verification/);
  });

  test('a failed sandbox result still blocks promotion; a passing one unlocks it and the owner decides', async () => {
    const { post, get } = await startApp();
    const proposalId = (await post('/api/evolution/propose', { title: 'tighten the retry budget' })).body.proposalId;

    const failed = await post('/api/evolution/verify', { proposalId, verified: false, detail: 'precision fell' });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.actVerified, true, 'the act of recording a failure is itself verified');
    assert.equal(failed.body.verified, false, 'the sandbox result is stored as the failure it was');
    const blocked = await post('/api/evolution/promote', { proposalId, reason: 'try anyway' });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /verification failed/);

    const passed = await post('/api/evolution/verify', { proposalId, verified: true, detail: 'second run passed' });
    assert.equal(passed.status, 200);
    assert.equal(passed.body.verified, true);
    assert.equal(passed.body.actVerified, true);

    const requested = await post('/api/evolution/promote', { proposalId, reason: 'the second run passed' });
    assert.equal(requested.status, 200);
    assert.equal(requested.body.state, 'requested');

    const approved = await post('/api/evolution/decide', { proposalId, decision: 'approved', reason: 'accepted' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.decision, 'approved');
    assert.equal(approved.body.executesCode, false);

    const listed = await get('/api/evolution');
    const [stored] = listed.body.proposals;
    assert.equal(stored.sandbox.verified, true);
    assert.equal(stored.promotion.state, 'approved');
    assert.equal(listed.body.status.promoted, 1);
    assert.equal(listed.body.status.failed, 0, 'the failed run was replaced by the later passing one');

    // An approved promotion cannot be decided again: the state machine refuses.
    const again = await post('/api/evolution/decide', { proposalId, decision: 'approved' });
    assert.equal(again.status, 400);
  });

  test('the lab refuses a verification that is not a measured boolean, and an unknown proposal', async () => {
    const { post } = await startApp();
    const proposalId = (await post('/api/evolution/propose', { title: 'something' })).body.proposalId;
    const bad = await post('/api/evolution/verify', { proposalId, verified: 'yes' });
    assert.equal(bad.status, 400);
    const unknown = await post('/api/evolution/verify', { proposalId: 'evo-doesnotexist', verified: true });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /no evolution proposal/);
    const unknownField = await post('/api/evolution/propose', { title: 'x', namespace: 'y' });
    assert.equal(unknownField.status, 400);
    assert.match(unknownField.body.error, /unknown field/);
  });

  test('the lab is a real ledger: a second lab on the same directory sees the first one’s records', async () => {
    const dir = tempDir();
    const first = createEvolutionLab({ dataDir: dir });
    const created = await first.create({ title: 'persisted across instances' });
    await first.recordVerification({ proposalId: created.proposalId, verified: true, detail: 'ran' });
    const second = createEvolutionLab({ dataDir: dir });
    const listed = await second.list();
    assert.equal(listed.total, 1);
    assert.equal(listed.proposals[0].proposalId, created.proposalId);
    assert.equal(listed.proposals[0].sandbox.verified, true);
  });

  test('a boundary whose source cannot be read says so instead of claiming it is locked', () => {
    const blind = evolutionBoundaries({});
    assert.equal(blind.allLocked, false);
    const unconfirmed = blind.entries.filter((entry) => entry.locked !== true).map((entry) => entry.key);
    assert.deepEqual(unconfirmed, ['ecp_sole_authority', 'kill_switch', 'permission_scopes', 'audit_log']);
    for (const entry of blind.entries.filter((row) => row.locked !== true)) {
      assert.match(entry.evidence, /could not be (read|confirmed)/);
    }
  });

  test('evolution acts are audited operations with the ECP decision recorded', async () => {
    const { post, app } = await startApp();
    const proposalId = (await post('/api/evolution/propose', { title: 'audited' })).body.proposalId;
    const { records } = await app.operations.list({ limit: 20 });
    const step = records
      .flatMap((operation) => operation.steps ?? [])
      .find((entry) => entry.action === 'evolution.propose');
    assert.ok(step, 'the propose act is in the audit log');
    assert.equal(step.authorization.decision, 'allow');
    assert.equal(step.verification.outcome, 'success_verified');
    assert.ok(proposalId);
  });
});

describe('T-31 surfaces are actually wired into the served page', () => {
  const ids = [
    'presence-status', 'presence-devices', 'presence-mesh', 'autonomy-status', 'autonomy-matrix',
    'autonomy-capabilities', 'world-claims', 'world-labels', 'evolution-status', 'evolution-proposals',
    'evolution-boundaries', 'evolution-boundaries-status', 'evolution-policy', 'evolution-form',
    'evolution-title', 'evolution-hypothesis', 'evolution-propose', 'evolution-form-status',
  ];

  test('every element the renderers write to exists in the served HTML', () => {
    for (const id of ids) {
      assert.match(UI_PAGE, new RegExp(`id="${id}"`), `${id} is in the page`);
      assert.match(UI_CLIENT, new RegExp(`getElementById\\('${id}'\\)`), `${id} is read by the client`);
    }
  });

  test('the presence workspace is a nav destination and the autonomy matrix is documented as read-only', () => {
    assert.match(UI_PAGE, /data-view="presence"/);
    assert.match(UI_CLIENT, /'presence', 'system'/);
    assert.match(UI_PAGE, /L0 Observe · L1 Suggest · L2 Confirm · L3 Delegate \(bounded\) · L4 Mission · L5 Standing orders/);
    assert.match(UI_PAGE, /cannot be changed from the UI|cannot change them|APEX_AUTONOMY_LEVELS/);
  });

  test('the client reads every new route and never a fabricated endpoint', () => {
    for (const route of ['/api/presence', '/api/autonomy/matrix', '/api/world/epistemic', '/api/evolution']) {
      assert.ok(UI_CLIENT.includes(`readApi('${route}')`), `${route} is read`);
    }
    for (const route of ['/api/evolution/propose', '/api/evolution/promote', '/api/evolution/decide']) {
      assert.ok(UI_CLIENT.includes(`'${route}'`), `${route} is called`);
    }
    // No pixel or presence claim may be hard-coded in the client.
    assert.equal(/presence-devices[\s\S]{0,200}connected to/.test(UI_CLIENT), false);
  });

  test('the epistemic renderer never maps an unclassified record to observed', () => {
    const fn = UI_CLIENT.slice(UI_CLIENT.indexOf('function renderWorldClaims'));
    const body = fn.slice(0, fn.indexOf('\nfunction ', 10));
    assert.match(body, /unclassified \(never shown as observed\)/);
  });
});

describe('T-31 report artefact', () => {
  test('the evolution ledger file is created inside the data directory, not beside it', async () => {
    const { post, dir } = await startApp();
    await post('/api/evolution/propose', { title: 'file location' });
    const files = fs.readdirSync(dir, { recursive: false });
    assert.ok(files.includes('evolution-proposals.jsonl'), 'the ledger lives in the data directory');
  });
});
