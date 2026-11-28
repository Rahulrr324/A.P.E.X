// T-35 Step 2 (2026-11-19): trusted presence handoff envelopes.
//
// The claims under test are the refusals as much as the happy path. An envelope is only worth
// anything if it cannot be collected by an unknown device, a revoked device, the wrong device, a
// second time, after its expiry, or from a ledger line that has been edited on disk.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import { DeviceTrustService } from '../src/security/device-trust.js';
import {
  HANDOFF_SCHEMA, HANDOFF_TTL_MS, HANDOFF_VIEWS, createPresenceHandoffs,
} from '../src/presence/handoff.js';
import { UI_CLIENT } from '../src/ui/assets.js';
import vm from 'node:vm';
import { createFakeBrowser, flushMicrotasks } from './helpers/fake-browser.js';

function tempDir(prefix = 'apex-t35-handoff-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withApp(run, options = {}) {
  const dir = tempDir();
  const app = createApp({ dataDir: dir, ...options });
  try {
    return await run({ app, dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Two enrolled devices, which is the minimum a handoff needs.
async function twoDevices(app) {
  const source = await app.deviceTrust.enroll({ origin: 'user', label: 'owner laptop' });
  const target = await app.deviceTrust.enroll({ origin: 'user', label: 'owner tablet' });
  return { sourceId: source.deviceId, targetId: target.deviceId };
}

async function stageThroughApp(app, input, origin = 'user') {
  return app.controller.runAction('presence.handoff.stage', input, origin, 'op-t35-stage');
}

describe('T-35 staging a handoff is a governed write', () => {
  test('the owner stages an envelope for two enrolled devices, and the ledger records it', async () => {
    await withApp(async ({ app, dir }) => {
      const { sourceId, targetId } = await twoDevices(app);
      const outcome = await stageThroughApp(app, {
        sourceDeviceId: sourceId,
        targetDeviceId: targetId,
        targetView: 'missions',
        note: 'continue the T-35 build',
      });
      assert.equal(outcome.outcome, 'success_verified', outcome.summary);
      const handoff = outcome.result?.data?.handoff;
      assert.equal(handoff.status, 'staged');
      assert.equal(handoff.targetView, 'missions');
      assert.equal(handoff.sha256Digest.length, 64);
      assert.match(handoff.sha256Digest, /^[a-f0-9]{64}$/);
      assert.equal(handoff.authorizesExecution, false, 'a handoff hands over a view, never a capability');

      const ledger = fs.readFileSync(path.join(dir, 'presence-handoffs.jsonl'), 'utf8').trim().split('\n');
      assert.equal(ledger.length, 1);
      const record = JSON.parse(ledger[0]);
      assert.equal(record.schema, HANDOFF_SCHEMA);
      assert.equal(record.event, 'staged');
      assert.equal(record.sha256Digest, handoff.sha256Digest);
      assert.equal(record.by, 'owner');
      // The digest is over the envelope, so recomputing it from the ledger line must agree.
      assert.equal(app.handoffs.digestOf(record.envelope), record.sha256Digest);
    });
  });

  test('the model origin cannot stage, claim or revoke', async () => {
    await withApp(async ({ app }) => {
      const { sourceId, targetId } = await twoDevices(app);
      const staged = await stageThroughApp(app, { sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'deck' });
      const id = staged.result?.data?.handoff?.id;
      for (const [action, input] of [
        ['presence.handoff.stage', { sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'deck' }],
        ['presence.handoff.claim', { handoffId: id, targetDeviceId: targetId }],
        ['presence.handoff.revoke', { handoffId: id, reason: 'model asked' }],
      ]) {
        const outcome = await app.controller.runAction(action, input, 'model', 'op-model');
        assert.notEqual(outcome.outcome, 'success_verified', `${action} must be refused at the model origin`);
        const text = JSON.stringify(outcome).toLowerCase();
        assert.ok(text.includes('deni') || text.includes('origin') || text.includes('not permitted'), text.slice(0, 200));
      }
      assert.equal(app.handoffs.get(id).status, 'staged', 'nothing changed');
    });
  });

  test('the lockdown latch refuses staging, claiming and revoking', async () => {
    await withApp(async ({ app }) => {
      const { sourceId, targetId } = await twoDevices(app);
      const staged = await stageThroughApp(app, { sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'tasks' });
      const id = staged.result?.data?.handoff?.id;
      const locked = await app.controller.runAction('safety.lockdown', { reason: 'T-35 lockdown test' }, 'user', 'op-kill');
      assert.equal(locked.outcome, 'success_verified', locked.summary);
      assert.equal(app.ecp.killSwitchStatus().active, true);
      for (const [action, input] of [
        ['presence.handoff.stage', { sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'tasks' }],
        ['presence.handoff.claim', { handoffId: id, targetDeviceId: targetId }],
        ['presence.handoff.revoke', { handoffId: id, reason: 'lockdown' }],
      ]) {
        const outcome = await app.controller.runAction(action, input, 'user', 'op-locked');
        assert.notEqual(outcome.outcome, 'success_verified', `${action} must fail closed during lockdown`);
      }
      assert.equal(app.handoffs.get(id).status, 'staged');
    });
  });

  test('an unknown, revoked or self-referential device is refused by name', async () => {
    await withApp(async ({ app }) => {
      const { sourceId, targetId } = await twoDevices(app);
      const stranger = await stageThroughApp(app, { sourceDeviceId: sourceId, targetDeviceId: 'device-never-enrolled', targetView: 'deck' });
      assert.notEqual(stranger.outcome, 'success_verified');
      assert.match(JSON.stringify(stranger), /not enrolled/i);

      await app.deviceTrust.revoke(targetId, { origin: 'user', reason: 'T-35 revoked target' });
      const revoked = await stageThroughApp(app, { sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'deck' });
      assert.notEqual(revoked.outcome, 'success_verified');
      assert.match(JSON.stringify(revoked), /revoked/i);

      const self = await stageThroughApp(app, { sourceDeviceId: sourceId, targetDeviceId: sourceId, targetView: 'deck' });
      assert.notEqual(self.outcome, 'success_verified');
      assert.match(JSON.stringify(self), /two different devices/i);
    });
  });

  test('a target that does not exist is refused rather than stored and discovered later', async () => {
    await withApp(async ({ app }) => {
      const { sourceId, targetId } = await twoDevices(app);
      const missingTask = await stageThroughApp(app, {
        sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'missions', taskId: 'task-does-not-exist',
      });
      assert.notEqual(missingTask.outcome, 'success_verified');
      assert.match(JSON.stringify(missingTask), /TARGET_UNKNOWN/);

      // A real task is accepted, so the refusal above is the lookup working rather than a blanket no.
      await app.taskStore.createTask({
        taskId: 'task-t35-handoff', goal: 'T-35 handoff target', origin: 'user', planner: 'deterministic',
        reason: 'T-35 test', steps: [{ id: 'n1', description: 'read', action: 'test.ok', permission: 'read', input: {}, dependsOn: [] }],
      });
      const real = await stageThroughApp(app, {
        sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'missions', taskId: 'task-t35-handoff',
      });
      assert.equal(real.outcome, 'success_verified', real.summary);
      assert.equal(real.result.data.verifiedTargets.task, true);
    });
  });

  test('the view must be one the deck can open', async () => {
    await withApp(async ({ app }) => {
      const { sourceId, targetId } = await twoDevices(app);
      const bogus = await stageThroughApp(app, { sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'not-a-view' });
      assert.notEqual(bogus.outcome, 'success_verified');
      for (const view of ['deck', 'missions', 'system']) {
        const ok = await stageThroughApp(app, { sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: view });
        assert.equal(ok.outcome, 'success_verified', `${view}: ${ok.summary}`);
      }
      assert.deepEqual(HANDOFF_VIEWS.includes('presence'), true);
    });
  });
});

describe('T-35 claiming restores exactly the staged destination, once', () => {
  test('a claim returns the restoration target and marks the envelope claimed', async () => {
    await withApp(async ({ app }) => {
      const { sourceId, targetId } = await twoDevices(app);
      await app.taskStore.createTask({
        taskId: 'task-t35-claim', goal: 'T-35 claim target', origin: 'user', planner: 'deterministic',
        reason: 'T-35 test', steps: [{ id: 'n1', description: 'read', action: 'test.ok', permission: 'read', input: {}, dependsOn: [] }],
      });
      const staged = await stageThroughApp(app, {
        sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'missions', taskId: 'task-t35-claim',
        note: 'pick this up on the tablet',
      });
      const id = staged.result.data.handoff.id;

      const claimed = await app.controller.runAction('presence.handoff.claim', { handoffId: id, targetDeviceId: targetId }, 'user', 'op-t35-claim');
      assert.equal(claimed.outcome, 'success_verified', claimed.summary);
      assert.deepEqual(claimed.result.data.restoration, {
        view: 'missions', taskId: 'task-t35-claim', artifactId: null, briefingCheckpointId: null,
      });
      assert.equal(claimed.result.data.handoff.status, 'claimed');
      assert.equal(claimed.result.data.handoff.claimedBy, 'owner');

      const second = await app.controller.runAction('presence.handoff.claim', { handoffId: id, targetDeviceId: targetId }, 'user', 'op-t35-claim-2');
      assert.notEqual(second.outcome, 'success_verified', 'a second claim must be refused');
      assert.match(JSON.stringify(second), /already[_ ]claimed/i);
    });
  });

  test('the wrong device cannot collect the envelope', async () => {
    await withApp(async ({ app }) => {
      const { sourceId, targetId } = await twoDevices(app);
      const third = await app.deviceTrust.enroll({ origin: 'user', label: 'owner phone' });
      const staged = await stageThroughApp(app, { sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'deck' });
      const id = staged.result.data.handoff.id;
      const wrong = await app.controller.runAction('presence.handoff.claim', { handoffId: id, targetDeviceId: third.deviceId }, 'user', 'op-wrong');
      assert.notEqual(wrong.outcome, 'success_verified');
      assert.match(JSON.stringify(wrong), /HANDOFF_WRONG_DEVICE/);
      assert.equal(app.handoffs.get(id).status, 'staged');
    });
  });

  test('a device revoked after staging cannot collect it', async () => {
    await withApp(async ({ app }) => {
      const { sourceId, targetId } = await twoDevices(app);
      const staged = await stageThroughApp(app, { sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'deck' });
      const id = staged.result.data.handoff.id;
      await app.deviceTrust.revoke(targetId, { origin: 'user', reason: 'lost the tablet' });
      const claim = await app.controller.runAction('presence.handoff.claim', { handoffId: id, targetDeviceId: targetId }, 'user', 'op-revoked-claim');
      assert.notEqual(claim.outcome, 'success_verified', 'trust is re-read at the claim, not remembered from staging');
      assert.match(JSON.stringify(claim), /revoked/i);
    });
  });
});

describe('T-35 the ledger refuses tampering, expiry and a second collection', () => {
  function ledgerFixture() {
    const dir = tempDir('apex-t35-ledger-');
    let tick = 0;
    const clock = () => new Date(Date.parse('2026-11-19T12:00:00.000Z') + tick * 1000);
    const devices = new DeviceTrustService(path.join(dir, 'devices.jsonl'), { now: clock });
    return { dir, devices, clock, advance: (ms) => { tick += Math.ceil(ms / 1000); } };
  }

  test('an edited envelope line is a tamper, not a handoff', async () => {
    const { dir, devices, clock } = ledgerFixture();
    try {
      const source = await devices.enroll({ origin: 'user', label: 'laptop', deviceId: 'device-tamper-a' });
      const target = await devices.enroll({ origin: 'user', label: 'tablet', deviceId: 'device-tamper-b' });
      assert.ok(source.secret && target.secret);
      const handoffs = createPresenceHandoffs({ dataDir: dir, deviceTrust: devices, now: clock });
      const staged = await handoffs.stage({
        sourceDeviceId: 'device-tamper-a', targetDeviceId: 'device-tamper-b', targetView: 'deck', note: 'benign',
      });
      // Rewrite the ledger line: same id and digest, a different destination.
      const file = path.join(dir, 'presence-handoffs.jsonl');
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      const record = JSON.parse(lines[0]);
      record.envelope.targetView = 'workshop';
      fs.writeFileSync(file, `${JSON.stringify(record)}\n`);

      const reloaded = createPresenceHandoffs({ dataDir: dir, deviceTrust: devices, now: clock });
      await assert.rejects(
        () => reloaded.claim(staged.handoff.id),
        /HANDOFF_DIGEST_MISMATCH/,
      );
      // And the honest line is still readable as what it was.
      assert.equal(reloaded.get(staged.handoff.id).targetView, 'workshop');
      assert.equal(reloaded.get(staged.handoff.id).status, 'staged');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an expired envelope is refused, and is reported as expired rather than staged', async () => {
    const { dir, devices, clock, advance } = ledgerFixture();
    try {
      await devices.enroll({ origin: 'user', label: 'laptop', deviceId: 'device-expiry-a' });
      await devices.enroll({ origin: 'user', label: 'tablet', deviceId: 'device-expiry-b' });
      const handoffs = createPresenceHandoffs({ dataDir: dir, deviceTrust: devices, now: clock, ttlMs: 60_000 });
      const staged = await handoffs.stage({ sourceDeviceId: 'device-expiry-a', targetDeviceId: 'device-expiry-b', targetView: 'deck' });
      assert.equal(Date.parse(staged.handoff.expiresAt) - Date.parse(staged.handoff.stagedAt), 60_000);
      advance(61_000);
      await assert.rejects(() => handoffs.claim(staged.handoff.id), /HANDOFF_EXPIRED/);
      assert.equal(handoffs.get(staged.handoff.id).status, 'expired');
      assert.equal(handoffs.status().expired, 1);
      assert.equal(handoffs.status().staged, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the default lifetime is stated, not implied', () => {
    assert.equal(HANDOFF_TTL_MS, 30 * 60 * 1000);
  });

  test('revoking is recorded with its reason, and a revoked envelope cannot then be claimed', async () => {
    await withApp(async ({ app }) => {
      const { sourceId, targetId } = await twoDevices(app);
      const staged = await stageThroughApp(app, { sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'deck' });
      const id = staged.result.data.handoff.id;

      const tooShort = await app.controller.runAction('presence.handoff.revoke', { handoffId: id, reason: 'x' }, 'user', 'op-r0');
      assert.notEqual(tooShort.outcome, 'success_verified', 'a reason of substance is required');

      const revoked = await app.controller.runAction('presence.handoff.revoke', { handoffId: id, reason: 'staged on the wrong tablet' }, 'user', 'op-r1');
      assert.equal(revoked.outcome, 'success_verified', revoked.summary);
      const recorded = app.handoffs.get(id);
      assert.equal(recorded.status, 'revoked');
      assert.equal(recorded.revokeReason, 'staged on the wrong tablet');
      assert.ok(recorded.revokedAt);

      const claim = await app.controller.runAction('presence.handoff.claim', { handoffId: id, targetDeviceId: targetId }, 'user', 'op-r2');
      assert.notEqual(claim.outcome, 'success_verified');
      assert.match(JSON.stringify(claim), /revoked/i);

      const again = await app.controller.runAction('presence.handoff.revoke', { handoffId: id, reason: 'again please' }, 'user', 'op-r3');
      assert.notEqual(again.outcome, 'success_verified', 'revoking twice is refused, not recorded twice');
    });
  });

  test('a claimed envelope cannot be revoked', async () => {
    await withApp(async ({ app }) => {
      const { sourceId, targetId } = await twoDevices(app);
      const staged = await stageThroughApp(app, { sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'deck' });
      const id = staged.result.data.handoff.id;
      await app.controller.runAction('presence.handoff.claim', { handoffId: id, targetDeviceId: targetId }, 'user', 'op-c1');
      const revoke = await app.controller.runAction('presence.handoff.revoke', { handoffId: id, reason: 'too late' }, 'user', 'op-c2');
      assert.notEqual(revoke.outcome, 'success_verified');
      assert.match(JSON.stringify(revoke), /already[_ ]claimed/i);
    });
  });

  test('the ledger survives a reload, and a corrupt line names the line', async () => {
    await withApp(async ({ app, dir }) => {
      const { sourceId, targetId } = await twoDevices(app);
      const staged = await stageThroughApp(app, { sourceDeviceId: sourceId, targetDeviceId: targetId, targetView: 'cognition' });
      const id = staged.result.data.handoff.id;
      const reloaded = createPresenceHandoffs({ dataDir: dir, deviceTrust: app.deviceTrust });
      assert.equal(reloaded.get(id).targetView, 'cognition');
      assert.equal(reloaded.status().total, 1);

      fs.appendFileSync(path.join(dir, 'presence-handoffs.jsonl'), '{"schema":"apex.presence.handoff/1",\n');
      const broken = createPresenceHandoffs({ dataDir: dir, deviceTrust: app.deviceTrust });
      assert.throws(() => broken.status(), /corrupt at line 2/);
    });
  });
});

describe('T-35 the payload says what is and is not implemented', () => {
  test('status() is explicit that there is no remote transport', () => {
    const dir = tempDir();
    try {
      const handoffs = createPresenceHandoffs({ dataDir: dir, deviceTrust: null });
      const status = handoffs.status();
      assert.equal(status.schema, HANDOFF_SCHEMA);
      assert.equal(status.implemented, true);
      assert.equal(status.remoteTransport, false);
      assert.match(status.transport, /local loopback & store-backed handoff only/);
      assert.match(status.remoteTransportDetail, /no socket mesh/i);
      assert.equal(status.grantsAuthority, false);
      assert.equal(status.total, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without a device registry, staging is refused rather than trusted', async () => {
    const dir = tempDir();
    try {
      const handoffs = createPresenceHandoffs({ dataDir: dir, deviceTrust: null });
      await assert.rejects(
        () => handoffs.stage({ sourceDeviceId: 'device-a', targetDeviceId: 'device-b', targetView: 'deck' }),
        /no device-trust registry/i,
      );
      assert.equal(handoffs.list().length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T-35 the presence routes stage, claim and revoke through the same door', () => {
  const TOKEN = 't35-handoff-token-0123456789';
  const HEADERS = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1', 'content-type': 'application/json' };

  const BASE_HOLDER = { base: null };

  async function withUi(run) {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    const base = `http://127.0.0.1:${started.port}`;
    BASE_HOLDER.base = base;
    const get = async (pathname) => {
      const response = await fetch(base + pathname, { headers: HEADERS });
      return { status: response.status, body: await response.json() };
    };
    const post = async (pathname, body) => {
      const response = await fetch(base + pathname, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    try {
      return await run({ app, get, post, dir });
    } finally {
      await ui.stop().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a full stage, inspect, claim round trip over HTTP', async () => {
    await withUi(async ({ app, get, post }) => {
      const source = await app.deviceTrust.enroll({ origin: 'user', label: 'owner laptop' });
      const target = await app.deviceTrust.enroll({ origin: 'user', label: 'owner tablet' });

      const before = await get('/api/presence');
      assert.equal(before.status, 200);
      assert.equal(before.body.handoffs.implemented, true);
      assert.equal(before.body.handoffs.remoteTransport, false);
      assert.match(before.body.handoffs.transport, /local loopback/);
      assert.equal(before.body.handoffs.total, 0);

      const staged = await post('/api/presence/handoffs', {
        sourceDeviceId: source.deviceId,
        targetDeviceId: target.deviceId,
        targetView: 'missions',
        note: 'pick this up on the tablet',
      });
      assert.equal(staged.status, 201, JSON.stringify(staged.body));
      const id = staged.body.handoff.id;
      assert.equal(staged.body.handoff.status, 'staged');

      const listed = await get('/api/presence');
      assert.equal(listed.body.handoffs.total, 1);
      assert.equal(listed.body.handoffs.staged, 1);
      assert.equal(listed.body.handoffs.recent[0].id, id);
      assert.equal(listed.body.handoffs.recent[0].sha256Digest.length, 64);
      assert.equal(listed.body.readonly, true, 'inspection stays a read');

      const claimed = await post(`/api/presence/handoffs/${id}/claim`, { targetDeviceId: target.deviceId });
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
      assert.equal(claimed.body.handoff.status, 'claimed');
      assert.deepEqual(claimed.body.restoration, { view: 'missions', taskId: null, artifactId: null, briefingCheckpointId: null });

      const after = await get('/api/presence');
      assert.equal(after.body.handoffs.claimed, 1);
      assert.equal(after.body.handoffs.staged, 0);
      assert.deepEqual(after.body.handoffs.recent[0].restoration, claimed.body.restoration);
    });
  });

  test('the route refuses malformed requests before the ledger sees them', async () => {
    await withUi(async ({ app, post, dir }) => {
      const source = await app.deviceTrust.enroll({ origin: 'user', label: 'owner laptop' });
      const target = await app.deviceTrust.enroll({ origin: 'user', label: 'owner tablet' });
      const cases = [
        [{ targetDeviceId: target.deviceId, targetView: 'deck' }, /sourceDeviceId is required/],
        [{ sourceDeviceId: source.deviceId, targetView: 'deck' }, /targetDeviceId is required/],
        [{ sourceDeviceId: source.deviceId, targetDeviceId: target.deviceId }, /targetView is required/],
        [{ sourceDeviceId: source.deviceId, targetDeviceId: target.deviceId, targetView: 'deck', sha256Digest: 'x' }, /unknown field: sha256Digest/],
        [{ sourceDeviceId: source.deviceId, targetDeviceId: target.deviceId, targetView: 'deck', note: 'x'.repeat(241) }, /note must be text/],
      ];
      for (const [body, pattern] of cases) {
        const response = await post('/api/presence/handoffs', body);
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.match(response.body.error, pattern);
      }
      // The digest is derived by the server, never supplied by the caller - which is why asking for
      // one above was an unknown field rather than a value that was trusted.
      assert.equal(fs.existsSync(path.join(dir, 'presence-handoffs.jsonl')), false);
    });
  });

  test('a refused claim reports the reason as a 400 and leaves the envelope staged', async () => {
    await withUi(async ({ app, get, post }) => {
      const source = await app.deviceTrust.enroll({ origin: 'user', label: 'owner laptop' });
      const target = await app.deviceTrust.enroll({ origin: 'user', label: 'owner tablet' });
      const other = await app.deviceTrust.enroll({ origin: 'user', label: 'owner phone' });
      const staged = await post('/api/presence/handoffs', { sourceDeviceId: source.deviceId, targetDeviceId: target.deviceId, targetView: 'deck' });
      const id = staged.body.handoff.id;

      const wrong = await post(`/api/presence/handoffs/${id}/claim`, { targetDeviceId: other.deviceId });
      assert.equal(wrong.status, 400);
      assert.match(wrong.body.error, /HANDOFF_WRONG_DEVICE/);

      const missing = await post('/api/presence/handoffs/ph-000000000000/claim', { targetDeviceId: target.deviceId });
      assert.equal(missing.status, 400);

      const noReason = await post(`/api/presence/handoffs/${id}/revoke`, {});
      assert.equal(noReason.status, 400);
      assert.match(noReason.body.error, /reason/);

      const revoked = await post(`/api/presence/handoffs/${id}/revoke`, { reason: 'wrong tablet' });
      assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
      assert.equal(revoked.body.handoff.status, 'revoked');
      assert.equal(revoked.body.handoff.revokeReason, 'wrong tablet');

      const after = await get('/api/presence');
      assert.equal(after.body.handoffs.revoked, 1);
    });
  });

  test('posting without the token is refused, and cross-origin posting is refused', async () => {
    await withUi(async ({ app }) => {
      const source = await app.deviceTrust.enroll({ origin: 'user', label: 'owner laptop' });
      const target = await app.deviceTrust.enroll({ origin: 'user', label: 'owner tablet' });
      const body = { sourceDeviceId: source.deviceId, targetDeviceId: target.deviceId, targetView: 'deck' };
      const noToken = await fetch(`${BASE_HOLDER.base}/api/presence/handoffs`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-apex-ui': '1' }, body: JSON.stringify(body),
      });
      assert.equal(noToken.status, 401);
      const crossOrigin = await fetch(`${BASE_HOLDER.base}/api/presence/handoffs`, {
        method: 'POST',
        headers: { ...HEADERS, origin: 'https://evil.example' },
        body: JSON.stringify(body),
      });
      assert.equal(crossOrigin.status, 403);
      assert.equal(app.handoffs.list().length, 0);
    });
  });
});

describe('T-35 the Presence workspace shows the ledger and restores what it claims', () => {
  const DIGEST = 'a'.repeat(64);
  const HANDOFF_ID = 'ph-00000000aaaa';

  function routes() {
    const devices = [
      { deviceId: 'device-laptop-0001', label: 'owner laptop', status: 'trusted', enrolledAt: '2026-11-19T00:00:00.000Z', revokedAt: null, lastAcceptedSequence: null },
      { deviceId: 'device-tablet-0002', label: 'owner tablet', status: 'trusted', enrolledAt: '2026-11-19T00:00:00.000Z', revokedAt: null, lastAcceptedSequence: null },
      { deviceId: 'device-old-0003', label: 'retired phone', status: 'revoked', enrolledAt: '2026-11-18T00:00:00.000Z', revokedAt: '2026-11-19T00:00:00.000Z', revocationReason: 'sold', lastAcceptedSequence: 4 },
    ];
    const staged = {
      id: HANDOFF_ID,
      status: 'staged',
      sourceDeviceId: devices[0].deviceId,
      targetDeviceId: devices[1].deviceId,
      targetView: 'missions',
      taskId: 'task-t35-restore',
      briefingCheckpointId: null,
      artifactId: null,
      note: 'pick up the mission',
      sha256Digest: DIGEST,
      stagedAt: '2026-11-19T01:00:00.000Z',
      expiresAt: '2026-11-19T01:30:00.000Z',
      expired: false,
      claimedAt: null,
      revokedAt: null,
      revokeReason: null,
      restoration: null,
      authorizesExecution: false,
    };
    const claimResponse = {
      handoff: { ...staged, status: 'claimed', claimedAt: '2026-11-19T01:05:00.000Z', restoration: { view: 'missions', taskId: 'task-t35-restore', artifactId: null, briefingCheckpointId: null } },
      restoration: { view: 'missions', taskId: 'task-t35-restore', artifactId: null, briefingCheckpointId: null },
    };
    return new Map([
      ['/api/state', { session: { id: 'session-t35', status: 'ok' }, turns: [], tasks: [], plans: [], goals: [], autonomy: { configured: {} }, resources: {} }],
      ['/api/killswitch', { active: false, policyUnavailable: false, persistence: 'durable' }],
      ['/api/health', { overall: 'healthy', areas: [] }],
      ['/api/presence', {
        schema: 'apex.presence/1',
        deviceTrust: { available: true, devices, total: devices.length },
        mesh: { implemented: false, detail: 'no device mesh transport is implemented', peers: [], connectedPeers: 0 },
        handoffs: {
          schema: 'apex.presence.handoff/1', available: true, implemented: true, remoteTransport: false,
          transport: 'local loopback & store-backed handoff only', total: 1, staged: 1, claimed: 0, revoked: 0, expired: 0,
          recent: [staged],
        },
        readonly: true,
      }],
      ['/api/autonomy', { domains: [], levels: [], readonly: true, source: 'APEX_AUTONOMY_LEVELS' }],
      [`/api/presence/handoffs/${HANDOFF_ID}/claim`, claimResponse],
      ['/api/taskgraph?taskId=task-t35-restore', { available: true, tasks: [], graph: null }],
    ]);
  }

  async function boot() {
    const browser = createFakeBrowser({ routes: routes() });
    const context = vm.createContext(browser.sandbox, { name: 'apex-ui-client-t35-handoff' });
    vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
    const source = browser.events.sources.at(-1);
    source.open();
    source.emit('reconcile', {
      schema: 'apex.state-event/1', streamId: 'd'.repeat(32), seq: 2, at: '2026-11-19T00:00:00.000Z',
      type: 'reconcile', versions: {}, payload: { reason: 'initial', snapshotUrl: '/api/state', owners: {} },
      correlationId: null,
    }, { lastEventId: `${'d'.repeat(32)}:2` });
    await flushMicrotasks();
    return browser;
  }

  function walk(node, out = []) {
    for (const child of node.children || []) {
      out.push(child);
      walk(child, out);
    }
    return out;
  }

  test('the ledger is listed with its digest, and the form offers only trusted devices', async () => {
    const browser = await boot();
    assert.deepEqual(browser.events.pageErrors, []);
    const list = browser.getElement('handoff-list');
    const items = list.children.filter((child) => child.dataset && child.dataset.handoffId);
    assert.equal(items.length, 1, 'the staged envelope is listed');
    assert.equal(items[0].dataset.handoffStatus, 'staged');
    const text = walk(items[0]).map((node) => node.textContent).join(' ');
    assert.match(text, /aaaaaaaaaaaa/, 'the digest prefix is shown so a reviewer can compare it');
    assert.match(text, /task-t35-restore/);
    assert.match(text, /pick up the mission/);

    const source = browser.getElement('handoff-source');
    const target = browser.getElement('handoff-target');
    const sourceIds = source.children.map((option) => option.value);
    assert.deepEqual(sourceIds, ['device-laptop-0001', 'device-tablet-0002'], 'a revoked device is not offered');
    assert.notEqual(target.value, source.value, 'the two sides default to different devices');
    assert.equal(browser.getElement('handoff-stage').disabled, false);
    assert.match(browser.getElement('handoff-status').textContent, /local, store-backed only — no remote transport/);
  });

  test('Claim & Restore posts the claim and opens the handed-off view and mission', async () => {
    const browser = await boot();
    const list = browser.getElement('handoff-list');
    const buttons = walk(list).filter((node) => node.tagName === 'BUTTON');
    const claim = buttons.find((node) => node.textContent === 'Claim & Restore');
    assert.ok(claim, 'the staged envelope offers a claim');
    claim.click();
    for (let index = 0; index < 6; index += 1) await flushMicrotasks();
    const posted = browser.events.fetches.filter((entry) => entry.method === 'POST');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, `/api/presence/handoffs/${HANDOFF_ID}/claim`);
    assert.equal(browser.sandbox.document.body.dataset.view, 'missions', 'the handed-off view is opened');
    assert.match(browser.getElement('handoff-message').textContent, /Restored missions on mission task-t35-restore/);
    assert.match(browser.getElement('handoff-message').textContent, /Nothing was executed by opening it/);
    assert.deepEqual(browser.events.pageErrors, []);
  });
});
