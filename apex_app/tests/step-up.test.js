// T-31 Step 3 (2026-11-19): step-up for the two acts that undo a safety control or change what APEX
// may become.
//
// The rules, verified here rather than asserted in prose:
//   * step-up is off unless a deployment configures it, and off means "not required", not "weaker";
//   * a configured secret shorter than 16 characters is a configuration error;
//   * with step-up configured, `safety.release` and approving an `evolution.decide` are refused
//     without the proof and refused with a wrong one, and a refused release leaves the latch active;
//   * the proof never reaches the audit log - only the fact that a value was omitted;
//   * releasing the lockdown never resumes a task, and the paused run is still paused afterwards;
//   * the page shows the step-up field only when the ECP reports that step-up is configured.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import { loadConfig } from '../src/config.js';
import { UI_CLIENT, UI_PAGE } from '../src/ui/assets.js';
import { startSeededUi } from './e2e/t31-fixtures.mjs';

const SECRET = 't31-step-up-secret-0123456789';
const TOKEN = 't31-step-up-token-0123456789';

const dirs = [];
const servers = [];
afterEach(async () => {
  while (servers.length) await servers.pop().stop().catch(() => {});
  while (dirs.length) {
    const dir = dirs.pop();
    try { cleanup(dir); } catch { /* already removed */ }
  }
});

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

async function startApp({ stepUpToken = null } = {}) {
  const dir = tempDir();
  const app = createApp({ dataDir: dir, ...(stepUpToken ? { stepUpToken } : {}) });
  const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
  const started = await ui.start();
  servers.push(ui);
  const base = `http://127.0.0.1:${started.port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' };
  const get = async (pathname) => {
    const response = await fetch(base + pathname, { headers });
    return { status: response.status, body: await response.json() };
  };
  const post = async (pathname, body) => {
    const response = await fetch(base + pathname, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, dir, base, headers, get, post };
}

function auditText(dir) {
  const file = path.join(dir, 'operations.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

describe('T-31 step-up configuration', () => {
  test('step-up is off by default and the status says so without inventing a policy', async () => {
    const { get, app } = await startApp();
    const { status, body } = await get('/api/step-up');
    assert.equal(status, 200);
    assert.equal(body.schema, 'apex.step-up/1');
    assert.equal(body.configured, false);
    // T-39 Step 1 adds the two Workshop writes that reach the live workspace tree; T-40 Step 2 adds
    // the two batch writes, for the same reason and more strongly - one stolen session could otherwise
    // write eight files in a single authorized-looking act. T-43 Package 1 adds the two git writes: a
    // checkpoint create writes a ref into the owner's repository and a restore overwrites tracked files
    // in it. The list is pinned because it is a promise about which acts a stolen session cannot
    // perform without the secret.
    assert.deepEqual(body.appliesTo,
      ['safety.release', 'evolution.decide', 'workshop.apply_file', 'workshop.rollback_file',
        'workshop.apply_changeset', 'workshop.rollback_changeset',
        'git.checkpoint_create', 'git.checkpoint_restore']);
    assert.match(body.note, /not required/i);
    // Off means "no proof needed": the existing release path is unchanged.
    assert.equal(app.ecp.verifyStepUp(null, { capability: 'safety.release' }).ok, true);
  });

  test('a configured secret is never returned, and a short one is refused at start-up', async () => {
    const { get } = await startApp({ stepUpToken: SECRET });
    const { body } = await get('/api/step-up');
    assert.equal(body.configured, true);
    const serialised = JSON.stringify(body);
    assert.equal(serialised.includes(SECRET), false, 'the status must not carry the secret');
    assert.equal(serialised.includes('t31-step-up-secret'.slice(0, 8)), false);
    assert.match(body.note, /refused without it/i);

    assert.throws(() => loadConfig({ APEX_DATA_DIR: tempDir(), APEX_STEP_UP_TOKEN: 'too-short' }),
      /at least 16 characters/);
    assert.equal(loadConfig({ APEX_DATA_DIR: tempDir(), APEX_STEP_UP_TOKEN: SECRET }).stepUpToken, SECRET);
    assert.equal(loadConfig({ APEX_DATA_DIR: tempDir() }).stepUpToken, null);
  });

  test('the verification distinguishes a missing proof, a wrong proof and the right one', async () => {
    const { app } = await startApp({ stepUpToken: SECRET });
    assert.deepEqual(app.ecp.verifyStepUp(null, { capability: 'safety.release' }).reason, 'STEP_UP_REQUIRED');
    assert.deepEqual(app.ecp.verifyStepUp('nope', { capability: 'safety.release' }).reason, 'STEP_UP_REJECTED');
    assert.deepEqual(app.ecp.verifyStepUp(SECRET, { capability: 'safety.release' }).reason, 'STEP_UP_VERIFIED');
    // A capability outside the two gated acts is never gated.
    assert.deepEqual(app.ecp.verifyStepUp(null, { capability: 'memory.add' }).reason, 'STEP_UP_NOT_APPLICABLE');
  });
});

describe('T-31 step-up governs the release', () => {
  test('a release without the proof is refused and the latch stays active', async () => {
    const { post, app, dir } = await startApp({ stepUpToken: SECRET });
    const locked = await post('/api/safety/lockdown', { reason: 'T-31 step-up test: locking' });
    assert.equal(locked.status, 200);
    assert.equal(app.ecp.killSwitchStatus().active, true);

    const missing = await post('/api/safety/release', { reason: 'reviewed it', confirm: true });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /step-up is required/);
    assert.equal(app.ecp.killSwitchStatus().active, true, 'a refused release must leave the latch active');

    const wrong = await post('/api/safety/release', { reason: 'reviewed it', confirm: true, stepUp: 'wrong-secret' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /did not match/);
    assert.equal(app.ecp.killSwitchStatus().active, true);

    // Both refusals are in the audit log, and neither carries the proof.
    const audit = auditText(dir);
    assert.match(audit, /safety\.release/);
    assert.equal(audit.includes(SECRET), false);
    assert.equal(audit.includes('wrong-secret'), false);
  });

  test('a release with the right proof succeeds, and the proof is omitted from the audit', async () => {
    const { post, app, dir } = await startApp({ stepUpToken: SECRET });
    await post('/api/safety/lockdown', { reason: 'T-31 step-up test: locking again' });
    const released = await post('/api/safety/release', { reason: 'reviewed it', confirm: true, stepUp: SECRET });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.status, 'success_verified');
    assert.equal(released.body.recorded, true);
    assert.equal(app.ecp.killSwitchStatus().active, false);

    const audit = auditText(dir);
    assert.equal(audit.includes(SECRET), false, 'the proof must never be written to the audit log');
    assert.match(audit, /value omitted/, 'the audit records that a value was omitted');
    // The reason and the decision are still recorded in the open.
    assert.match(audit, /reviewed it/);
  });

  test('releasing the lockdown does not resume a paused task', async () => {
    const handle = await startSeededUi({ token: TOKEN });
    servers.push({ stop: () => handle.stop() });
    const before = await fetch(`${handle.base}/api/state`, { headers: handle.headers }).then((r) => r.json());
    const pausedBefore = before.tasks.filter((task) => task.status === 'paused').length;
    assert.equal(pausedBefore, 1, 'the seeded run leaves one paused task');

    const locked = await fetch(`${handle.base}/api/safety/lockdown`, {
      method: 'POST',
      headers: { ...handle.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'T-31 step-up test: release must not resume' }),
    });
    assert.equal(locked.status, 200);
    const released = await fetch(`${handle.base}/api/safety/release`, {
      method: 'POST',
      headers: { ...handle.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'T-31 step-up test: releasing', confirm: true }),
    });
    assert.equal(released.status, 200);

    const after = await fetch(`${handle.base}/api/state`, { headers: handle.headers }).then((r) => r.json());
    assert.equal(after.tasks.length, before.tasks.length, 'no task was created or removed');
    assert.equal(after.tasks.filter((task) => task.status === 'paused').length, pausedBefore,
      'the paused task is still paused: release resumes nothing');
    const runResponse = await fetch(`${handle.base}/api/cognition/runs/${encodeURIComponent(handle.seed.cognitionRunId)}`, { headers: handle.headers });
    const { run } = await runResponse.json();
    assert.equal(run.status, 'awaiting_approval', 'the run still waits for the owner, not for the latch');
  });
});

describe('T-31 step-up governs an evolution promotion', () => {
  async function prepared(stepUpToken) {
    const session = await startApp({ stepUpToken });
    const proposalId = (await session.post('/api/evolution/propose', { title: 'step-up promotion' })).body.proposalId;
    await session.post('/api/evolution/verify', { proposalId, verified: true, detail: 'sandbox passed' });
    await session.post('/api/evolution/promote', { proposalId, reason: 'sandbox passed' });
    return { ...session, proposalId };
  }

  test('approving without the proof is refused, and the proposal stays requested', async () => {
    const { post, get, proposalId, dir } = await prepared(SECRET);
    const refused = await post('/api/evolution/decide', { proposalId, decision: 'approved', reason: 'accepted' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /step-up is required/);
    const listed = await get('/api/evolution');
    assert.equal(listed.body.proposals[0].promotion.state, 'requested', 'nothing was approved');
    assert.equal(auditText(dir).includes(SECRET), false);

    const wrong = await post('/api/evolution/decide', { proposalId, decision: 'approved', reason: 'accepted', stepUp: 'nope' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /did not match/);
  });

  test('a rejection needs no proof, and an approval with the proof is recorded without it', async () => {
    const rejected = await prepared(SECRET);
    const rejection = await rejected.post('/api/evolution/decide', { proposalId: rejected.proposalId, decision: 'rejected', reason: 'not yet' });
    assert.equal(rejection.status, 200, JSON.stringify(rejection.body));
    assert.equal(rejection.body.decision, 'rejected');

    const approved = await prepared(SECRET);
    const approval = await approved.post('/api/evolution/decide', {
      proposalId: approved.proposalId, decision: 'approved', reason: 'accepted', stepUp: SECRET,
    });
    assert.equal(approval.status, 200, JSON.stringify(approval.body));
    assert.equal(approval.body.decision, 'approved');
    const audit = auditText(approved.dir);
    assert.equal(audit.includes(SECRET), false, 'the proof is never written to the audit log');
    assert.match(audit, /value omitted/);
  });

  test('with step-up unconfigured the same acts run without a proof', async () => {
    const session = await prepared(null);
    const approval = await session.post('/api/evolution/decide', { proposalId: session.proposalId, decision: 'approved', reason: 'accepted' });
    assert.equal(approval.status, 200, JSON.stringify(approval.body));
  });
});

describe('T-31 step-up in the page', () => {
  test('the field exists, is hidden until the status says it is configured, and is sent only then', () => {
    assert.match(UI_PAGE, /id="safety-step-up-wrap" hidden/);
    assert.match(UI_PAGE, /id="safety-step-up" type="password"/);
    assert.ok(UI_CLIENT.includes("getElementById('safety-step-up')"), 'the client resolves the field');
    assert.match(UI_CLIENT, /state\.stepUp\?\.configured === true/);
    assert.match(UI_CLIENT, /readApi\('\/api\/step-up'\)/);
    // The note must distinguish "configured" from "not configured" rather than always warning.
    assert.match(UI_CLIENT, /No step-up secret is configured in this deployment/);
    assert.match(UI_CLIENT, /refused without it/);
  });
});
