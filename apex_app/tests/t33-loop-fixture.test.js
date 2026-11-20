// T-33 Step 4 (2026-11-19): the executive-loop fixture, proven on a host with no browser.
//
// The Playwright walk in `tests/e2e/t33-executive-loop.spec.mjs` needs a browser that only the
// hosted runner has. What does not need one is the fixture and the sequence of facts the walk
// asserts: the gated run, the advisory a real workspace implies, the suppression rule, the revoke,
// the wit rule in both directions, and a staged telemetry sheet that really verifies. Those are
// pinned here, so a browser skip leaves the fixture's behaviour still verified and the walk itself
// honestly unverified rather than quietly assumed.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startT33Ui, readLoopFacts } from './e2e/t33-fixtures.mjs';

let handle = null;
before(async () => { handle = await startT33Ui(); });
after(async () => { if (handle) await handle.stop(); });

async function comms() {
  const response = await fetch(`${handle.base}/api/state`, { headers: handle.headers });
  assert.equal(response.status, 200);
  return response.json();
}

// The sense route answers with the reading and the governed result; the advisories and the
// governor's decisions are read from the perception state, which is where the deck reads them.
async function sense() {
  const response = await fetch(`${handle.base}/api/perception/sense`, {
    method: 'POST', headers: { ...handle.headers, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 200);
  const answered = await response.json();
  const state = await fetch(`${handle.base}/api/perception`, { headers: handle.headers }).then((r) => r.json());
  return {
    reading: answered.reading,
    advisories: state.alerts?.advisories ?? [],
    deliveries: state.alerts?.deliveries ?? [],
    suppressions: state.alerts?.suppressions ?? [],
  };
}

describe('the T-33 executive-loop fixture', () => {
  test('it opens on a real gated run, with no advisory yet and no wit', async () => {
    assert.ok(handle.seed.taskId, 'the gated run created a task');
    const facts = await readLoopFacts(handle);
    assert.equal(facts.graph.body.nodes[0].state, 'awaiting_approval');
    assert.equal(facts.graph.body.controls.approve, true);
    assert.equal(facts.state.body.coreReading, 'awaiting_approval');
    const classic = facts.state.body.comms.framings.classic;
    assert.equal(classic.witAllowed, false, 'a pending approval forbids wit before anything else happens');
    assert.ok(classic.witWithheldBecause.includes('an owner approval is pending'));
  });

  test('a real reading of a real dirty repository implies the advisory, and the core withholds wit for it', async () => {
    const sensed = await sense();
    const advisory = sensed.advisories.find((entry) => entry.alertClass === 'workspace_dirty');
    assert.ok(advisory, 'the reading implied the workspace advisory');
    assert.equal(advisory.critical, false);
    const delivery = sensed.deliveries.find((entry) => entry.alertClass === 'workspace_dirty');
    assert.equal(delivery.admitted, true, 'a first non-critical notice is delivered');
    const view = await comms();
    assert.equal(view.perception.advisories.length > 0, true);
    const classic = view.comms.framings.classic;
    assert.equal(classic.witAllowed, false);
    assert.ok(classic.witWithheldBecause.includes('an advisory is active'));
  });

  test('two dismissals record a revocable rule with an expiry, and revoking restores delivery', async () => {
    const post = async (route, body) => {
      const response = await fetch(`${handle.base}${route}`, {
        method: 'POST', headers: { ...handle.headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const first = await post('/api/perception/dismiss', { alertClass: 'workspace_dirty' });
    assert.equal(first.body.dismissals, 1);
    assert.equal(first.body.suppressed, false);
    const second = await post('/api/perception/dismiss', { alertClass: 'workspace_dirty' });
    assert.equal(second.body.dismissals, 2);
    assert.equal(second.body.suppressed, true);
    assert.match(second.body.rule.suppressedUntil, /^\d{4}-\d{2}-\d{2}T/);
    // A suppressed class is still a condition, so wit is still withheld: the invariant does not depend
    // on whether the notice was allowed through.
    const suppressed = await comms();
    assert.equal(suppressed.comms.framings.classic.witAllowed, false);
    const revoked = await post('/api/perception/suppressions/revoke', { ruleId: second.body.rule.id });
    assert.equal(revoked.status, 200);
    const stillSuppressed = await sense();
    assert.equal(stillSuppressed.suppressions.length, 0, 'the rule is gone');
    // The machine has not changed, so the governor deduplicates the same signature. That is not the
    // suppression doing the work, and the reason says so.
    const unchanged = stillSuppressed.deliveries.find((entry) => entry.alertClass === 'workspace_dirty');
    assert.equal(unchanged.admitted, false);
    assert.match(String(unchanged.reason), /already surfaced/);
    // A real change to the tree changes the condition, and delivery resumes.
    handle.addUntrackedFile();
    const after = await sense();
    const delivery = after.deliveries.find((entry) => entry.alertClass === 'workspace_dirty');
    assert.equal(delivery.admitted, true, 'delivery resumes once the rule is revoked and the condition changes');
    assert.notEqual(delivery.signature, unchanged.signature);
  });

  test('clearing the condition — not the notice — is what restores the wit', async () => {
    assert.equal(handle.tidyWorkspace().clean, true);
    const sensed = await sense();
    assert.deepEqual(sensed.advisories.map((entry) => entry.alertClass), [], 'a clean tree implies no advisory');
    const view = await comms();
    const classic = view.comms.framings.classic;
    // The gated run is still awaiting the owner in this fixture, so the wit stays withheld for that
    // reason; with the advisory gone the reason list names only the approval.
    assert.ok(!classic.witWithheldBecause.includes('an advisory is active'));
    assert.ok(classic.witWithheldBecause.includes('an owner approval is pending'));
  });

  test('the sheet the deck stages from the reading is one the sandbox can actually verify', async () => {
    // Mirrors `stageFromTelemetry()` in src/ui/assets.js: every number is one the reading reported,
    // and the one service is the check that consumes them.
    const perception = await fetch(`${handle.base}/api/perception`, { headers: handle.headers }).then((r) => r.json());
    const reading = perception.lastReading;
    assert.ok(reading, 'a reading is recorded');
    const logical = Number.isFinite(reading.host?.cpu?.logicalCount) && reading.host.cpu.logicalCount > 0
      ? reading.host.cpu.logicalCount : null;
    const totalMb = Number.isFinite(reading.host?.memory?.totalBytes)
      ? Math.max(1, Math.round(reading.host.memory.totalBytes / 1048576)) : null;
    const storage = Array.isArray(reading.host?.storage) ? reading.host.storage.find((volume) => volume.reported === true) : null;
    const availableMb = storage && Number.isFinite(storage.availableBytes)
      ? Math.max(1, Math.round(storage.availableBytes / 1048576)) : null;
    const components = [];
    if (logical !== null) components.push({ id: 'cpu', label: 'CPU', kind: 'resource', supply: logical, demand: 0, cost: 1 });
    if (totalMb !== null) components.push({ id: 'memory', label: 'Memory', kind: 'resource', supply: totalMb, demand: 0, cost: 1 });
    if (availableMb !== null) components.push({ id: 'storage', label: 'Storage', kind: 'resource', supply: availableMb, demand: 0, cost: 1 });
    components.push({ id: 'workspace_check', label: 'Workspace check', kind: 'service', supply: 0, demand: 1, cost: 1 });
    assert.ok(components.length >= 2, 'the reading produced at least one resource and the check');
    const sheet = {
      title: 'Host reading ' + reading.at,
      domain: 'plan',
      components,
      connections: components.filter((component) => component.id !== 'workspace_check')
        .map((component) => ({ from: component.id, to: 'workspace_check', label: 'supplies' })),
      budget: { total: components.length * 2 },
      note: 'Staged from the host reading at ' + reading.at + '; every number is a value the sensor reported.',
    };
    const composed = await handle.app.controller.runAction('workshop.compose', sheet, 'user', 'op-t33-stage');
    assert.equal(composed.outcome, 'success_verified', composed.summary);
    const artifactId = composed.result.data.artifactId;
    const verified = await handle.app.controller.runAction('workshop.verify', { artifactId }, 'user', 'op-t33-verify');
    assert.equal(verified.outcome, 'success_verified', verified.summary);
    assert.equal(verified.result.data.verified, true, `failed checks: ${verified.result.data.failed.join(', ')}`);
    const promoted = await handle.app.controller.runAction(
      'workshop.promote', { artifactId, reason: 'the staged sheet passed the sandbox check' }, 'user', 'op-t33-promote',
    );
    assert.equal(promoted.outcome, 'success_verified', promoted.summary);
    assert.equal(promoted.result.data.verified, true);
  });
});
