// T-36 Step 4 (2026-11-21): the cold-boot walk's own starting point, checked without a browser.
//
// `tests/e2e/t36-cold-boot-unseeded.spec.mjs` is the real-browser proof, and it only runs where a
// Chromium-family binary exists. This file is the other half: it drives the same fixture and makes
// every server-side claim that walk makes, so a regression in the bootstrap fails here on any
// machine, browser or none, rather than waiting for the next hosted run to notice.
//
// What it can not do is render the page. The DOM claims - the overlay appearing, the Core going
// Dormant and landing on its authoritative state, the six rows in the HUD, the gauges carrying
// digits, no overflow - are the browser's business, and they are marked UNVERIFIED here rather than
// silently assumed. The walk in CI is what verifies them.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startT36Ui } from './e2e/t36-fixtures.mjs';

const handles = [];
afterEach(async () => {
  while (handles.length) await handles.pop().stop().catch(() => {});
});

async function cold() {
  const handle = await startT36Ui();
  handles.push(handle);
  return handle;
}

describe('T-36: the cold boot on a genuinely unseeded workstation', () => {
  test('the fixture starts from nothing at all', async () => {
    const handle = await cold();
    // Asserted before any request is made, so a fixture that seeded would fail here instead of
    // making the rest of the file pass for the wrong reason.
    assert.deepEqual(handle.unseeded.entries, [], 'the data directory is empty');
    assert.equal(handle.unseeded.bootstrapMarker, false);
    assert.equal(handle.unseeded.deviceRegistry, false);
    assert.equal(handle.unseeded.perceptionLedger, false);
    // A real repository, on a branch no other fixture uses, so a stale reading is visible.
    assert.equal(handle.repository.branch, 'trunk');
    assert.match(handle.repository.head, /^[a-f0-9]{7,}$/);
    const before = (await handle.bootstrapState()).body;
    assert.equal(before.bootstrapped, false);
    assert.equal(before.runs, 0);
    assert.equal(before.latest ?? null, null, 'an unseeded directory reports no reading, not an empty one');
  });

  test('the route bootstraps the directory and every check is verified by measurement', async () => {
    const handle = await cold();
    const response = await handle.bootstrap();
    assert.equal(response.status, 200);
    const body = response.body;
    assert.equal(body.status, 'success_verified');
    assert.equal(body.bootstrapVerified, true);
    assert.equal(body.firstRun, true);
    assert.equal(body.idempotent, false);
    const checks = body.checks;
    assert.deepEqual(checks.map((entry) => entry.id),
      ['doctor_readiness', 'host_workspace_perception', 'workstation_enrollment', 'executive_briefing']);
    for (const entry of checks) {
      assert.equal(entry.verified, true, `${entry.id} is verified`);
      assert.match(entry.digest, /^[a-f0-9]{64}$/, `${entry.id} carries a digest of its own evidence`);
    }
    // The marker exists on disk, and the run count is real.
    const after = handle.after();
    assert.equal(after.bootstrapMarker, true);
    assert.equal(after.deviceRegistry, true);
    assert.equal(after.perceptionLedger, true);
    const marker = JSON.parse(fs.readFileSync(path.join(handle.dataDir, 'system-bootstrap.json'), 'utf8'));
    assert.equal(marker.runs, 1);
    assert.equal(marker.bootstrapped, true);
    assert.equal(marker.checks.length, 4);
  });

  test('the reading is real host telemetry and the real git workspace', async () => {
    const handle = await cold();
    await handle.bootstrap();
    const state = (await handle.state()).body;
    const latest = state.system.bootstrap.latest;
    assert.equal(latest.perception.source, 'host-workspace-sensor');
    const reading = latest.perception.reading;
    // Counters that only this machine can have produced.
    assert.ok(reading.host.cpu.logicalCount > 0, 'a real CPU count');
    assert.ok(reading.host.memory.totalBytes > 0, 'a real memory total');
    assert.ok(reading.host.memory.freeBytes >= 0, 'a real free-memory figure');
    assert.ok(reading.host.memory.freeBytes <= reading.host.memory.totalBytes, 'free never exceeds total');
    // And the workspace is the repository this fixture made, read with git itself.
    assert.equal(reading.workspace.available, true);
    assert.equal(reading.workspace.branch, handle.repository.branch);
    assert.equal(reading.workspace.head, handle.repository.head);
    assert.equal(reading.workspace.root, handle.workspace);
  });

  test('the local workstation is enrolled once, with the metadata the bootstrap observed', async () => {
    const handle = await cold();
    await handle.bootstrap();
    const presence = (await handle.presence()).body;
    const devices = presence.deviceTrust.devices;
    assert.equal(devices.length, 1, 'exactly one device');
    const [workstation] = devices;
    assert.equal(workstation.deviceId, 'local-workstation');
    assert.equal(workstation.status, 'trusted');
    assert.equal(workstation.metadata.kind, 'workstation');
    assert.equal(workstation.metadata.capability, 'local-loopback');
    assert.ok(workstation.metadata.hostname.length > 0, 'the real hostname was recorded');
    assert.equal(workstation.metadata.platform, process.platform);
    assert.equal(workstation.metadata.arch, process.arch);
    assert.equal(workstation.metadata.enrolledBy, 'system.bootstrap');
    // Enrollment provenance: the append-only chain on disk has one enrollment event, and the
    // metadata is inside the hashed body - so it cannot have been edited after the fact.
    const chain = fs.readFileSync(path.join(handle.dataDir, 'devices.jsonl'), 'utf8')
      .split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
    assert.equal(chain.length, 1);
    assert.equal(chain[0].type, 'enrolled');
    assert.equal(chain[0].deviceId, 'local-workstation');
    assert.equal(chain[0].metadata.hostname, workstation.metadata.hostname);
    assert.equal(chain[0].metadata.capability, 'local-loopback');
  });

  test('the opening briefing is compiled from the readings, and no goal or task is invented', async () => {
    const handle = await cold();
    await handle.bootstrap();
    const state = (await handle.state()).body;
    const latest = state.system.bootstrap.latest;
    assert.ok(latest.briefing.concise.includes('local-workstation'), 'the briefing names the enrolled device');
    assert.ok(latest.briefing.concise.includes(handle.repository.branch), 'the briefing names the real branch');
    assert.ok(latest.briefing.facts.length > 0, 'the briefing carries the facts it was compiled from');
    for (const fact of latest.briefing.facts) {
      assert.ok(fact.kind, 'every fact says what kind of fact it is');
      assert.ok(typeof fact.text === 'string' && fact.text.length > 0, 'every fact is readable');
    }
    // The same four readings the four checks produced, named the same way the browser walk names
    // them: the doctor, the host, the workspace, and the device the bootstrap enrolled.
    const kinds = latest.briefing.facts.map((fact) => fact.kind);
    for (const kind of ['doctor', 'resource', 'workspace', 'device']) {
      assert.ok(kinds.includes(kind), `the briefing carries a ${kind} fact`);
    }
    // Zero synthetic data. A bootstrap that invented a demo goal or task would fail here.
    assert.equal(latest.syntheticGoalsCreated, 0);
    assert.equal(latest.syntheticTasksCreated, 0);
    assert.deepEqual(state.tasks, [], 'no task exists after bootstrapping');
    assert.deepEqual(state.goals, [], 'no goal exists after bootstrapping');
    const approvals = (await handle.get('/api/approvals')).body;
    assert.equal(approvals.items.length, 0, 'no approval was invented');
  });

  test('a second run refreshes the reading without duplicating the workstation', async () => {
    const handle = await cold();
    await handle.bootstrap('the first launch');
    const first = (await handle.state()).body.system.bootstrap;
    const second = await handle.bootstrap('the owner ran it again');
    assert.equal(second.status, 200);
    assert.equal(second.body.idempotent, true);
    assert.equal(second.body.firstRun, false);
    assert.equal(second.body.device.alreadyEnrolled, true);
    const after = (await handle.state()).body.system.bootstrap;
    assert.equal(after.runs, 2, 'both runs are recorded');
    assert.equal(after.firstAt, first.firstAt, 'the first run is remembered');
    assert.notEqual(after.at, first.at, 'the second run took its own reading');
    assert.equal(after.latest.perception.source, 'host-workspace-sensor');
    const presence = (await handle.presence()).body;
    assert.equal(presence.deviceTrust.devices.length, 1, 'still exactly one device');
    assert.equal(presence.deviceTrust.devices[0].deviceId, 'local-workstation');
  });

  test('under lockdown the bootstrap is refused and writes nothing', async () => {
    const handle = await cold();
    await handle.app.controller.runAction('safety.lockdown', { reason: 'the owner locked the system down' }, 'user', 'op-t36-lockdown');
    const response = await handle.bootstrap('attempted while locked down');
    assert.notEqual(response.status, 200, 'the route does not report success');
    // Nothing was created: no marker, no device, no reading.
    const after = handle.after();
    assert.equal(after.bootstrapMarker, false, 'no marker was written');
    assert.equal(after.deviceRegistry, false, 'no device was enrolled');
    assert.equal(after.perceptionLedger, false, 'no perception reading was recorded');
    const state = (await handle.state()).body;
    assert.equal(state.system.bootstrap.bootstrapped, false);
    assert.equal(state.killSwitch.active, true);
  });

  test('a T-29 cognitive intent runs from the freshly bootstrapped state', async () => {
    const handle = await cold();
    await handle.bootstrap();
    const response = await handle.cognitiveRun();
    assert.equal(response.status, 200);
    assert.equal(response.body.runStatus, 'awaiting_approval', 'the ECP left the write for the owner');
    const state = (await handle.state()).body;
    assert.equal(state.tasks.length, 1, 'the intent created exactly one task');
    assert.equal(state.goals.length, 0, 'and no goal');
    const approvals = (await handle.get('/api/approvals')).body;
    assert.equal(approvals.items.length, 1);
    assert.match(approvals.items[0].id, /^task-step:/);
  });

  test('what the browser walk verifies, and what only it can verify', async () => {
    // The split is stated rather than implied, so a green `npm test` is not read as a green browser
    // walk. These are the DOM claims t36-cold-boot-unseeded.spec.mjs owns.
    const spec = fs.readFileSync(new URL('./e2e/t36-cold-boot-unseeded.spec.mjs', import.meta.url), 'utf8');
    for (const claim of ['#hud-boot-sequence', 'data-core-state', '#hud-boot-steps li[data-boot-step]', '#gauge-cpu', '#presence-devices', '#approvals']) {
      assert.ok(spec.includes(claim), `the browser walk checks ${claim}`);
    }
    assert.match(spec, /expect\(consoleErrors/, 'the browser walk fails on a console error');
    assert.match(spec, /expect\(pageErrors/, 'the browser walk fails on a page error');
    assert.match(spec, /scrollWidth/, 'the browser walk fails on horizontal overflow');
  });
});
