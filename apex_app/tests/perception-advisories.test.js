// T-33 Step 1 (2026-11-19): the Sentinel's advisories and the discipline that carries them.
//
// These tests pin three things a reader has to be able to rely on:
//   1. an advisory is a fixed rule over values that were actually read, and a value that could not
//      be read never becomes an alarm;
//   2. the signature is the condition, so an unchanged machine deduplicates instead of counting;
//   3. delivery is the governor's decision alone - capped at three an hour, silent while a class is
//      suppressed, and restored the moment the owner revokes the rule.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVISORY_RULES, MEMORY_PRESSURE_RATIO, deriveAdvisories, deliverAdvisories,
} from '../src/perception/advisories.js';
import { PushGovernor } from '../src/perception/push-governor.js';
import { createPerceptionService } from '../src/perception/service.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    try { cleanup(dir); } catch { /* already removed */ }
  }
});

function reading(overrides = {}) {
  return {
    schema: 'apex.host-workspace-sensor/1',
    at: '2026-11-19T10:00:00.000Z',
    source: 'host-workspace-sensor',
    host: {
      cpu: { logicalCount: 8, loadAverage1m: 0.4, loadPercent: 0.05 },
      memory: { totalBytes: 8_000, freeBytes: 4_000, usedBytes: 4_000, usedPercent: 0.5 },
      storage: [{ path: '/var', totalBytes: 1_000, availableBytes: 500, reported: true }],
      process: { pid: 42, uptimeSeconds: 100, rssBytes: 1000, heapUsedBytes: 500 },
    },
    workspace: { available: true, root: '/repo', branch: 'main', head: 'abc123', dirtyFiles: 0, untrackedFiles: 0, lastCommitAt: '2026-11-18T00:00:00.000Z' },
    ...overrides,
  };
}

describe('deriveAdvisories', () => {
  test('a clean, healthy reading raises nothing at all', () => {
    assert.deepEqual(deriveAdvisories(reading()), []);
  });

  test('a reading that could not be taken raises nothing: unavailable is not alarming', () => {
    const advisories = deriveAdvisories({
      host: { cpu: { logicalCount: 8, loadAverage1m: 0.1, loadPercent: 0.01 }, memory: { usedPercent: null }, storage: [], process: {} },
      workspace: { available: true, branch: 'main', dirtyFiles: null, untrackedFiles: null },
    });
    assert.deepEqual(advisories, [], 'a null count is a missing reading, not zero files and not a dirty tree');
    assert.deepEqual(deriveAdvisories(null), []);
  });

  test('a dirty workspace is a non-critical advisory whose signature is the condition', () => {
    const dirty = reading({ workspace: { available: true, root: '/repo', branch: 'main', head: 'abc123', dirtyFiles: 2, untrackedFiles: 1 } });
    const first = deriveAdvisories(dirty);
    assert.equal(first.length, 1);
    assert.equal(first[0].alertClass, 'workspace_dirty');
    assert.equal(first[0].critical, false);
    assert.equal(first[0].severity, 'advisory');
    assert.equal(first[0].watch, 'workspace');
    assert.match(first[0].signature, /^workspace_dirty:main:2:1$/);
    // Re-sensing the same tree produces the same signature: dedupe, not a new count.
    assert.deepEqual(deriveAdvisories(dirty), first);
    // One more changed file is a different condition.
    const dirtier = deriveAdvisories(reading({ workspace: { ...dirty.workspace, dirtyFiles: 3 } }));
    assert.notEqual(dirtier[0].signature, first[0].signature);
  });

  test('a workspace that was never configured raises nothing, and one that cannot be read does', () => {
    assert.deepEqual(deriveAdvisories(reading({ workspace: { available: false, reason: 'NO_WORKSPACE_ROOT' } })), [],
      'a deployment without a workspace root is a normal deployment, not an alarm');
    const advisories = deriveAdvisories(reading({ workspace: { available: false, reason: 'GIT_UNAVAILABLE' } }));
    assert.equal(advisories.length, 1);
    assert.equal(advisories[0].alertClass, 'workspace_unreadable');
    assert.match(advisories[0].summary, /could not be read/);
    assert.equal(advisories[0].critical, false);
  });

  test('the named thresholds are the boundaries the rules use', () => {
    const atMemory = deriveAdvisories(reading({ host: { ...reading().host, memory: { totalBytes: 8_000, usedPercent: MEMORY_PRESSURE_RATIO } } }));
    assert.deepEqual(atMemory.map((entry) => entry.alertClass), ['memory_pressure']);
    const belowMemory = deriveAdvisories(reading({ host: { ...reading().host, memory: { totalBytes: 8_000, usedPercent: MEMORY_PRESSURE_RATIO - 0.001 } } }));
    assert.deepEqual(belowMemory, []);
    const tightStorage = deriveAdvisories(reading({ host: { ...reading().host, storage: [{ path: '/var', totalBytes: 1_000, availableBytes: 50, reported: true }] } }));
    assert.deepEqual(tightStorage.map((entry) => entry.alertClass), ['storage_pressure']);
  });

  test('only a wholly unreadable host is critical, and it says so', () => {
    const blind = deriveAdvisories({
      host: { cpu: { logicalCount: null, loadAverage1m: null, loadPercent: null }, memory: { totalBytes: null, usedPercent: null }, storage: [], process: { uptimeSeconds: null } },
      workspace: { available: false, reason: 'NO_WORKSPACE_ROOT' },
    });
    assert.deepEqual(blind.map((entry) => entry.alertClass), ['degraded']);
    const degraded = blind.find((entry) => entry.alertClass === 'degraded');
    assert.equal(degraded.critical, true);
    assert.equal(degraded.severity, 'critical');
    // The critical class is one the governor already treats as bypassing the cap.
    assert.ok(ADVISORY_RULES.some((rule) => rule.alertClass === 'degraded' && rule.critical === true));
  });
});

describe('deliverAdvisories and the push budget', () => {
  test('three non-critical advisories an hour, then the budget refuses', () => {
    const governor = new PushGovernor({ now: () => new Date('2026-11-19T10:00:00.000Z') });
    for (let index = 0; index < 3; index += 1) {
      const decision = deliverAdvisories(governor, deriveAdvisories(reading({
        workspace: { available: true, branch: 'main', dirtyFiles: index + 1, untrackedFiles: 0 },
      })));
      assert.equal(decision[0].admitted, true, `advisory ${index + 1} should be admitted`);
    }
    const fourth = deliverAdvisories(governor, deriveAdvisories(reading({
      workspace: { available: true, branch: 'main', dirtyFiles: 4, untrackedFiles: 0 },
    })));
    assert.equal(fourth[0].admitted, false);
    assert.match(fourth[0].reason, /non-critical pushes were already surfaced/);
    assert.equal(governor.budget().remaining, 0);
  });

  test('the same condition twice is deduplicated, and it costs the budget once', () => {
    const governor = new PushGovernor({ now: () => new Date('2026-11-19T10:00:00.000Z') });
    const dirty = reading({ workspace: { available: true, branch: 'main', dirtyFiles: 1, untrackedFiles: 0 } });
    assert.equal(deliverAdvisories(governor, deriveAdvisories(dirty))[0].admitted, true);
    const again = deliverAdvisories(governor, deriveAdvisories(dirty));
    assert.equal(again[0].admitted, false);
    assert.match(again[0].reason, /already surfaced/);
    assert.equal(governor.budget().used, 1);
  });

  test('a critical advisory is delivered even with the budget spent', () => {
    const governor = new PushGovernor({ now: () => new Date('2026-11-19T10:00:00.000Z') });
    for (let index = 0; index < 3; index += 1) {
      deliverAdvisories(governor, deriveAdvisories(reading({
        workspace: { available: true, branch: 'main', dirtyFiles: index + 1, untrackedFiles: 0 },
      })));
    }
    const critical = deliverAdvisories(governor, [{
      alertClass: 'degraded', watch: 'host', critical: true, severity: 'critical',
      signature: 'degraded:host-unreadable', summary: 'the Core cannot see this machine',
    }]);
    assert.equal(critical[0].admitted, true);
    assert.match(critical[0].reason, /critical pushes bypass/);
  });

  test('two dismissals suppress the class until an expiry, and revoking restores delivery', () => {
    const clock = { at: new Date('2026-11-19T10:00:00.000Z') };
    const governor = new PushGovernor({ now: () => clock.at });
    const dirty = (count) => deriveAdvisories(reading({
      workspace: { available: true, branch: 'main', dirtyFiles: count, untrackedFiles: 0 },
    }));
    assert.equal(deliverAdvisories(governor, dirty(1))[0].admitted, true);

    const first = governor.dismiss({ alertClass: 'workspace_dirty' });
    assert.equal(first.suppressed, false, 'one dismissal is not yet a suppression');
    const second = governor.dismiss({ alertClass: 'workspace_dirty' });
    assert.equal(second.suppressed, true);
    assert.match(second.rule.suppressedUntil, /^2026-11-19T16:00:00\.000Z$/, 'the expiry is six hours after the second dismissal');

    // Delivery stops while the rule holds, and the refusal names the rule and its expiry.
    clock.at = new Date('2026-11-19T11:00:00.000Z');
    const suppressed = deliverAdvisories(governor, dirty(2));
    assert.equal(suppressed[0].admitted, false);
    assert.match(suppressed[0].reason, /suppressed by the owner's rule until 2026-11-19T16:00:00\.000Z/);

    // The owner revokes it, and the next delivery is admitted again.
    const revoked = governor.revoke(second.rule.id);
    assert.equal(revoked.revoked, true);
    clock.at = new Date('2026-11-19T11:05:00.000Z');
    const restored = deliverAdvisories(governor, dirty(3));
    assert.equal(restored[0].admitted, true, 'a revoked rule stops silencing the class');
  });
});

describe('the perception service carries the advisories', () => {
  function service(overrides = {}) {
    const dir = tempDir();
    const clock = () => new Date('2026-11-19T10:00:00.000Z');
    const sensor = {
      workspaceDir: '/repo',
      sense: () => overrides.reading ?? reading(),
      observe: () => ({
        reading: overrides.reading ?? reading(),
        entries: [{ subject: 'host.cpu.logical_count', value: 8, unit: 'count', at: (overrides.reading ?? reading()).at, source: 'host-workspace-sensor', epistemicStatus: 'observed' }],
      }),
    };
    // The governor's own clock is the test's clock: a real clock a day later would empty the rolling
    // window and make a suppression look expired, which is a fact about the fixture, not the code.
    return createPerceptionService({ dataDir: dir, sensor, governor: new PushGovernor({ now: clock }), now: clock });
  }

  test('a sense records the reading, derives the advisories and reports what was delivered', () => {
    const perception = service({ reading: reading({ workspace: { available: true, branch: 'main', dirtyFiles: 1, untrackedFiles: 0 } }) });
    const before = perception.state();
    assert.deepEqual(before.alerts.advisories, [], 'nothing has been sensed yet, so nothing is advised');
    const sensed = perception.sense({ reason: 'the owner asked' });
    assert.equal(sensed.advisories.length, 1);
    assert.equal(sensed.deliveries[0].admitted, true);
    const state = perception.state();
    assert.equal(state.alerts.advisories[0].alertClass, 'workspace_dirty');
    assert.equal(state.alerts.active.length, 1);
    assert.equal(state.alerts.policy.limitPerHour, 3);
    assert.equal(state.alerts.policy.dismissalsToSuppress, 2);
    assert.equal(state.alerts.policy.criticalBypassesCap, true);
    // The ledger kept the reading itself, so the observation carries its own time and source.
    assert.ok(state.observations.length > 0);
    assert.equal(state.observations[0].source, 'host-workspace-sensor');
    assert.equal(state.observations[0].epistemicStatus, 'observed');
  });

  test('dismissing twice through the service records the rule the UI shows, and revoking clears it', () => {
    const dir = tempDir();
    const clock = () => new Date('2026-11-19T10:00:00.000Z');
    // A workspace whose change count moves, so each reading is a new condition and dedupe cannot be
    // mistaken for suppression.
    let dirtyFiles = 1;
    const sensor = {
      workspaceDir: '/repo',
      sense: () => reading({ workspace: { available: true, branch: 'main', dirtyFiles, untrackedFiles: 0 } }),
      observe: () => ({ reading: reading({ workspace: { available: true, branch: 'main', dirtyFiles, untrackedFiles: 0 } }), entries: [] }),
    };
    const perception = createPerceptionService({ dataDir: dir, sensor, governor: new PushGovernor({ now: clock }), now: clock });

    assert.equal(perception.sense({ reason: 'first' }).deliveries[0].admitted, true);
    const first = perception.dismiss({ alertClass: 'workspace_dirty' });
    assert.equal(first.rule, null);
    const second = perception.dismiss({ alertClass: 'workspace_dirty' });
    assert.equal(second.suppressed, true);
    const suppressedState = perception.state();
    assert.equal(suppressedState.alerts.suppressions.length, 1);
    assert.equal(suppressedState.alerts.suppressions[0].alertClass, 'workspace_dirty');
    assert.match(suppressedState.alerts.suppressions[0].suppressedUntil, /T16:00:00\.000Z$/);

    // A genuinely new condition is still silenced while the rule holds: that is what suppression is.
    dirtyFiles = 2;
    const silenced = perception.sense({ reason: 'while suppressed' });
    assert.equal(silenced.deliveries[0].admitted, false);
    assert.match(silenced.deliveries[0].reason, /suppressed by the owner's rule/);

    const revoked = perception.revoke(second.rule.id);
    assert.equal(revoked.revoked, true);
    assert.deepEqual(perception.state().alerts.suppressions, []);
    // The next new condition is delivered again, which is what "revoking restores delivery" means.
    dirtyFiles = 3;
    const again = perception.sense({ reason: 'after revoke' });
    assert.equal(again.deliveries[0].admitted, true);
  });

  test('the governor survives a restart, so a suppression is not undone by reloading the page', () => {
    const dir = tempDir();
    const dirty = reading({ workspace: { available: true, branch: 'main', dirtyFiles: 1, untrackedFiles: 0 } });
    const sensor = { workspaceDir: '/repo', sense: () => dirty, observe: () => ({ reading: dirty, entries: [] }) };
    const clock = () => new Date('2026-11-19T10:00:00.000Z');
    const first = createPerceptionService({ dataDir: dir, sensor, governor: new PushGovernor({ now: clock }), now: clock });
    first.sense({ reason: 'first' });
    first.dismiss({ alertClass: 'workspace_dirty' });
    const rule = first.dismiss({ alertClass: 'workspace_dirty' }).rule;

    const restartClock = () => new Date('2026-11-19T10:30:00.000Z');
    const restarted = createPerceptionService({ dataDir: dir, sensor, governor: new PushGovernor({ now: restartClock }), now: restartClock });
    const state = restarted.state();
    assert.equal(state.alerts.suppressions.length, 1);
    assert.equal(state.alerts.suppressions[0].id, rule.id);
    assert.equal(state.governor.budget.used, 1, 'the hourly count is a record, not a page-lifetime counter');
  });
});
