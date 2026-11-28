// T-32 Step 3 (2026-11-19): the Sentinel's push discipline (Part 4, Principle #6).
//
// The rules under test are the ones a person would state: no more than three non-critical pushes in
// a rolling hour, no duplicate of a condition already surfaced, critical alarms never silenced, and
// two dismissals of a class suppress that class only until a stated expiry, under a rule the owner
// can see and revoke.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PushGovernor, PUSH_LIMIT_PER_HOUR, SUPPRESSION_TTL_MS } from '../src/perception/push-governor.js';
import { createPerceptionService } from '../src/perception/service.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-push-'));
}

function clockAt(startIso) {
  let current = Date.parse(startIso);
  const now = () => new Date(current);
  now.advance = (ms) => { current += ms; };
  now.set = (iso) => { current = Date.parse(iso); };
  return now;
}

describe('T-32 Sentinel push discipline', () => {
  test('three non-critical pushes are admitted in an hour and the fourth is refused with a reason', () => {
    const now = clockAt('2026-11-19T09:00:00.000Z');
    const governor = new PushGovernor({ now });
    assert.equal(PUSH_LIMIT_PER_HOUR, 3);
    const first = governor.admit({ watch: 'resource-fabric', signature: 'memory-high' });
    assert.equal(first.admitted, true);
    assert.equal(first.budget.remaining, 2);
    now.advance(60_000);
    assert.equal(governor.admit({ watch: 'task-store', signature: 'task-blocked' }).admitted, true);
    now.advance(60_000);
    assert.equal(governor.admit({ watch: 'sentinel', signature: 'storage-pressure' }).admitted, true);
    now.advance(60_000);
    const fourth = governor.admit({ watch: 'sentinel', signature: 'another-thing' });
    assert.equal(fourth.admitted, false);
    assert.match(fourth.reason, /3 non-critical pushes were already surfaced/);
    assert.equal(fourth.budget.remaining, 0);
  });

  test('a duplicate condition is refused even when the budget has room', () => {
    const now = clockAt('2026-11-19T09:00:00.000Z');
    const governor = new PushGovernor({ now });
    const first = governor.admit({ watch: 'resource-fabric', signature: 'memory-92-percent' });
    assert.equal(first.admitted, true);
    now.advance(5 * 60_000);
    const repeat = governor.admit({ watch: 'resource-fabric', signature: 'memory-92-percent' });
    assert.equal(repeat.admitted, false);
    assert.match(repeat.reason, /already surfaced at/);
    // A different watch with the same signature is a different condition, and is admitted.
    now.advance(1_000);
    const other = governor.admit({ watch: 'workspace-sensor', signature: 'memory-92-percent' });
    assert.equal(other.admitted, true);
    assert.equal(other.budget.used, 2);
  });

  test('the window rolls: an hour after the first push the oldest slot frees', () => {
    const now = clockAt('2026-11-19T09:00:00.000Z');
    const governor = new PushGovernor({ now });
    governor.admit({ watch: 'a', signature: 'one' });
    now.advance(60_000);
    governor.admit({ watch: 'a', signature: 'two' });
    now.advance(60_000);
    governor.admit({ watch: 'a', signature: 'three' });
    assert.equal(governor.admit({ watch: 'a', signature: 'four' }).admitted, false);
    // A full window plus a second: the boundary itself is inclusive, so the third push has to leave
    // the window rather than sit exactly on its edge.
    now.advance(60 * 60_000 + 1_000);
    const afterWindow = governor.admit({ watch: 'a', signature: 'four' });
    assert.equal(afterWindow.admitted, true, 'the earlier pushes have left the rolling window');
    assert.equal(afterWindow.budget.used, 1);
  });

  test('a critical push bypasses the cap, the cooldown and a suppression', () => {
    const now = clockAt('2026-11-19T09:00:00.000Z');
    const governor = new PushGovernor({ now });
    for (const signature of ['one', 'two', 'three']) {
      now.advance(1_000);
      assert.equal(governor.admit({ watch: 'sentinel', signature }).admitted, true);
    }
    now.advance(1_000);
    const locked = governor.admit({ watch: 'sentinel', signature: 'lockdown', alertClass: 'lockdown', summary: 'the ECP latch is active' });
    assert.equal(locked.admitted, true, 'a lockdown notice is never silenced by the hourly cap');
    assert.equal(locked.critical, true);
    assert.equal(locked.budget.used, 3, 'a critical push does not consume a non-critical slot');

    governor.dismiss({ alertClass: 'lockdown' });
    governor.dismiss({ alertClass: 'lockdown' });
    assert.ok(governor.activeSuppressions().some((rule) => rule.alertClass === 'lockdown'));
    const again = governor.admit({ watch: 'sentinel', signature: 'lockdown-2', alertClass: 'lockdown' });
    assert.equal(again.admitted, true, 'a critical class is still surfaced while a rule for it exists');
  });

  test('two dismissals record a revocable rule with an expiry, and the class is suppressed meanwhile', () => {
    const now = clockAt('2026-11-19T09:00:00.000Z');
    const governor = new PushGovernor({ now });
    const firstDismissal = governor.dismiss({ alertClass: 'storage_pressure' });
    assert.equal(firstDismissal.dismissals, 1);
    assert.equal(firstDismissal.suppressed, false, 'one dismissal does not silence a class');
    now.advance(30_000);
    const secondDismissal = governor.dismiss({ alertClass: 'storage_pressure' });
    assert.equal(secondDismissal.dismissals, 2);
    assert.equal(secondDismissal.suppressed, true);
    assert.ok(secondDismissal.rule, 'the second dismissal records the rule');
    assert.equal(secondDismissal.rule.revocable, true);
    assert.equal(Date.parse(secondDismissal.rule.suppressedUntil) - now().getTime(), SUPPRESSION_TTL_MS);

    const suppressed = governor.admit({ watch: 'resource-fabric', signature: 'disk-91', alertClass: 'storage_pressure' });
    assert.equal(suppressed.admitted, false);
    assert.match(suppressed.reason, /suppressed by the owner's rule until/);

    // A different class is unaffected.
    const other = governor.admit({ watch: 'resource-fabric', signature: 'cpu-88', alertClass: 'cpu_pressure' });
    assert.equal(other.admitted, true);

    now.advance(SUPPRESSION_TTL_MS + 1_000);
    assert.deepEqual(governor.activeSuppressions(), [], 'the rule expires on its own');
    const afterExpiry = governor.admit({ watch: 'resource-fabric', signature: 'disk-91', alertClass: 'storage_pressure' });
    assert.equal(afterExpiry.admitted, true, 'an expired rule suppresses nothing');
  });

  test('the owner can revoke a suppression, and the rule says so', () => {
    const now = clockAt('2026-11-19T09:00:00.000Z');
    const governor = new PushGovernor({ now });
    governor.dismiss({ alertClass: 'signal_noise' });
    const rule = governor.dismiss({ alertClass: 'signal_noise' }).rule;
    const revoked = governor.revoke(rule.id);
    assert.equal(revoked.revoked, true);
    assert.ok(revoked.rule.revokedAt, 'the revocation is recorded on the rule');
    assert.deepEqual(governor.activeSuppressions(), []);
    const admitted = governor.admit({ watch: 'sentinel', signature: 'signal-noise', alertClass: 'signal_noise' });
    assert.equal(admitted.admitted, true, 'a revoked rule no longer suppresses the class');
    const unknown = governor.revoke('rule-999999');
    assert.equal(unknown.revoked, false);
    assert.equal(unknown.reason, 'UNKNOWN_RULE');
  });

  test('the service persists the budget and the rules across a restart', () => {
    const dataDir = tempDir();
    const now = clockAt('2026-11-19T09:00:00.000Z');
    const first = createPerceptionService({ dataDir, now });
    first.push({ watch: 'resource-fabric', signature: 'memory-90' });
    first.push({ watch: 'resource-fabric', signature: 'memory-95' });
    first.push({ watch: 'resource-fabric', signature: 'memory-97' });
    const blocked = first.push({ watch: 'resource-fabric', signature: 'memory-99' });
    assert.equal(blocked.admitted, false);
    first.dismiss({ alertClass: 'storage_pressure' });
    const rule = first.dismiss({ alertClass: 'storage_pressure' }).rule;
    assert.ok(rule);

    const second = createPerceptionService({ dataDir, now });
    const state = second.state({ limit: 5 });
    assert.equal(state.governor.budget.used, 3, 'the used slots survive the restart');
    assert.equal(state.governor.budget.remaining, 0);
    assert.ok(state.governor.suppressions.some((entry) => entry.alertClass === 'storage_pressure'));
    assert.ok(state.governor.rules.some((entry) => entry.id === rule.id), 'the rule id is stable across a restart');
    const revoked = second.revoke(rule.id);
    assert.equal(revoked.revoked, true, 'a rule recorded by one process is revocable by the next');
  });

  test('the governed dismiss and revoke are owner-only and verified', async () => {
    const { createApp } = await import('../src/app.js');
    const dataDir = tempDir();
    const app = createApp({ dataDir });
    assert.equal(app.registry.authorize('perception.dismiss_alert', 'model').decision, 'deny');
    assert.equal(app.registry.authorize('perception.revoke_suppression', 'model').decision, 'deny');
    const first = await app.controller.perceptionDismissAlert({ alertClass: 'storage_pressure' });
    assert.equal(first.operation.steps[0].verification.outcome, 'success_verified');
    const second = await app.controller.perceptionDismissAlert({ alertClass: 'storage_pressure' });
    const ruleId = second.operation.steps[0].result.data.rule.id;
    assert.match(ruleId, /^rule-\d+$/);
    assert.equal(second.operation.steps[0].result.data.suppressed, true);
    const state = app.perception.state({ limit: 1 });
    assert.ok(state.governor.suppressions.some((entry) => entry.alertClass === 'storage_pressure'));
    const revoked = await app.controller.perceptionRevokeSuppression({ ruleId });
    assert.equal(revoked.operation.steps[0].verification.outcome, 'success_verified');
    assert.deepEqual(app.perception.state({ limit: 1 }).governor.suppressions, []);
    const unknown = await app.controller.perceptionRevokeSuppression({ ruleId: 'rule-424242' });
    const unknownStep = unknown.operation.steps[0];
    // The action throws rather than returning a result, so the step records the failure and no
    // revocation is claimed.
    assert.equal(unknownStep.verification.outcome, 'not_run');
    assert.match(String(unknownStep.summary + ' ' + (unknownStep.result ? '' : '')) + ' ' + JSON.stringify(unknownStep.execution),
      /no suppression rule|UNKNOWN_RULE/);
  });
});
