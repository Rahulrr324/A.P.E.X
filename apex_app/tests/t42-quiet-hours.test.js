// T-42 Step 2 (2026-11-19): quiet hours, proven in both halves.
//
// The flake this closes is worth stating plainly, because the first diagnosis of it was wrong. The
// walk was said to be failing on "UTC wall-clock quiet hours". No quiet-hours code existed anywhere in
// src/perception; the string did not appear in the push governor, the advisories or the service. The
// real cause was the governor's hourly cap: on a busy CI runner the sensor honestly derives
// `load_pressure` and `storage_pressure` beside `workspace_dirty`, three non-critical advisories
// exhaust the 3/hour budget at the first sense, and the second sense - a genuinely new signature,
// after the fixture adds an untracked file - is refused as capped. The row then reads `held` where the
// walk expects `delivered`, on a runner that was merely busy.
//
// So there are two things to prove here, and they are different things:
//
//   1. The *feature*: quiet hours exist, are off by default, are configurable, honour an injected
//      clock, hold a non-critical notice with `reason: 'quiet_hours'`, and never hold an alarm.
//   2. The *flake*: a host under pressure cannot steal the budget the walk's own advisory needs,
//      because the fixture pins the host half and leaves the workspace half real.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PushGovernor, PUSH_LIMIT_PER_HOUR } from '../src/perception/push-governor.js';
import {
  resolveQuietHours, quietHoursFromEnv, isQuietAt, quietHourOf, quietHoursStatus,
  QUIET_HOURS_SCHEMA,
} from '../src/perception/quiet-hours.js';

const WINDOW = Object.freeze({ enabled: true, startHour: 22, endHour: 7 });
const at = (iso) => () => new Date(iso);
const INSIDE = '2026-11-19T23:30:00Z';
const OUTSIDE = '2026-11-19T12:00:00Z';
const advisory = (signature = 'workspace_dirty:main:1:0', alertClass = 'workspace_dirty') =>
  ({ watch: 'workspace', signature, alertClass });

describe('T-42 quiet hours: the window arithmetic', () => {
  it('is off by default, so an unconfigured governor behaves exactly as it did before', () => {
    const policy = resolveQuietHours();
    assert.equal(policy.enabled, false);
    assert.equal(policy.schema, QUIET_HOURS_SCHEMA);
    // Every hour of the day is delivered against a default policy.
    for (let hour = 0; hour < 24; hour += 1) {
      const moment = new Date(Date.UTC(2026, 10, 19, hour, 30));
      assert.equal(isQuietAt(policy, moment), false, `hour ${hour} must not be quiet when disabled`);
    }
  });

  it('reads a wrapping window on both sides of midnight, and treats its edges as declared', () => {
    const policy = resolveQuietHours(WINDOW);
    // start inclusive, end exclusive: 22:00 is quiet, 07:00 is not.
    assert.equal(isQuietAt(policy, new Date('2026-11-19T22:00:00Z')), true, '22:00 is the first quiet minute');
    assert.equal(isQuietAt(policy, new Date('2026-11-19T23:30:00Z')), true);
    assert.equal(isQuietAt(policy, new Date('2026-11-19T00:01:00Z')), true, 'past midnight is still quiet');
    assert.equal(isQuietAt(policy, new Date('2026-11-19T06:59:00Z')), true);
    assert.equal(isQuietAt(policy, new Date('2026-11-19T07:00:00Z')), false, '07:00 is the first loud minute');
    assert.equal(isQuietAt(policy, new Date('2026-11-19T12:00:00Z')), false);
    assert.equal(isQuietAt(policy, new Date('2026-11-19T21:59:00Z')), false);
  });

  it('reads a non-wrapping window in between its edges', () => {
    const policy = resolveQuietHours({ enabled: true, startHour: 1, endHour: 5 });
    assert.equal(isQuietAt(policy, new Date('2026-11-19T00:30:00Z')), false);
    assert.equal(isQuietAt(policy, new Date('2026-11-19T03:00:00Z')), true);
    assert.equal(isQuietAt(policy, new Date('2026-11-19T05:00:00Z')), false);
  });

  it('shifts the window by the declared offset rather than assuming the host timezone', () => {
    // 22:00-07:00 at +5:30 is quiet from 16:30 UTC to 01:30 UTC.
    const policy = resolveQuietHours({ enabled: true, startHour: 22, endHour: 7, utcOffsetHours: 5.5 });
    assert.equal(quietHourOf(new Date('2026-11-19T16:30:00Z'), policy), 22, '16:30 UTC is 22:00 at +5:30');
    assert.equal(isQuietAt(policy, new Date('2026-11-19T17:00:00Z')), true, '22:00 local at +5:30');
    assert.equal(isQuietAt(policy, new Date('2026-11-19T01:00:00Z')), true, '06:00 local at +5:30');
    assert.equal(isQuietAt(policy, new Date('2026-11-19T09:00:00Z')), false, '14:30 local at +5:30');
  });

  it('refuses nonsense instead of silently becoming always-on or always-off', () => {
    assert.throws(() => resolveQuietHours({ startHour: 24 }), /integer hour from 0 to 23/);
    assert.throws(() => resolveQuietHours({ endHour: -1 }), /integer hour from 0 to 23/);
    assert.throws(() => resolveQuietHours({ startHour: 2.5 }), /integer hour from 0 to 23/);
    // A window that starts and ends at the same hour is empty, not a whole day.
    assert.throws(() => resolveQuietHours({ enabled: true, startHour: 9, endHour: 9 }), /must differ/);
    assert.throws(() => resolveQuietHours({ utcOffsetHours: 20 }), /from -14 to 14/);
  });

  it('parses the environment form, and refuses what it cannot read', () => {
    assert.equal(quietHoursFromEnv('22-07').enabled, true);
    assert.deepEqual({ ...quietHoursFromEnv('22-07').window }, { startHour: 22, endHour: 7, utcOffsetHours: 0 });
    assert.deepEqual({ ...quietHoursFromEnv('22-7').window }, { startHour: 22, endHour: 7, utcOffsetHours: 0 });
    assert.equal(quietHoursFromEnv('off').enabled, false);
    assert.equal(quietHoursFromEnv('false').enabled, false);
    assert.equal(quietHoursFromEnv(''), null);
    assert.equal(quietHoursFromEnv(undefined), null);
    // An operator who believes quiet hours are on must never be lied to by a typo.
    assert.throws(() => quietHoursFromEnv('22:00-07:00'), /must look like "22-07"/);
    assert.throws(() => quietHoursFromEnv('late'), /must look like "22-07"/);
  });

  it('reports the projection the surfaces read', () => {
    const policy = resolveQuietHours(WINDOW);
    const open = quietHoursStatus(policy, new Date(INSIDE));
    assert.deepEqual({ enabled: open.enabled, activeNow: open.activeNow }, { enabled: true, activeNow: true });
    assert.deepEqual({ ...open.window }, { startHour: 22, endHour: 7, utcOffsetHours: 0 });
    const closed = quietHoursStatus(policy, new Date(OUTSIDE));
    assert.equal(closed.activeNow, false);
  });
});

describe('T-42 quiet hours: the governor holds a notice, never an alarm', () => {
  it('holds a non-critical advisory inside the window, naming quiet_hours as the reason', () => {
    const governor = new PushGovernor({ now: at(INSIDE), quietHours: WINDOW });
    const decision = governor.admit(advisory());
    assert.equal(decision.admitted, false);
    assert.equal(decision.reason, 'quiet_hours');
    // The decision carries the window it was made in, so the screen cannot imply a fault.
    assert.equal(decision.quietHours.enabled, true);
    assert.equal(decision.quietHours.activeNow, true);
  });

  it('still delivers a critical advisory inside the window', () => {
    const governor = new PushGovernor({ now: at(INSIDE), quietHours: WINDOW });
    const degrade = governor.admit({ watch: 'host', signature: 'degraded:all-unreadable', alertClass: 'degraded' });
    assert.equal(degrade.admitted, true, 'a window that silences an alarm is worse than a noisy alarm');
    const byFlag = governor.admit({ watch: 'safety', signature: 'lockdown:engaged', critical: true });
    assert.equal(byFlag.admitted, true);
    assert.equal(byFlag.reason, 'critical pushes bypass the hourly cap and the cooldown');
  });

  it('delivers outside the window, up to the documented 3/hour cap', () => {
    const governor = new PushGovernor({ now: at(OUTSIDE), quietHours: WINDOW });
    assert.equal(PUSH_LIMIT_PER_HOUR, 3);
    const decisions = ['a', 'b', 'c', 'd'].map((tag) => governor.admit(advisory(`sig:${tag}`)));
    assert.deepEqual(decisions.slice(0, 3).map((entry) => entry.admitted), [true, true, true]);
    assert.equal(decisions[3].admitted, false, 'the fourth is capped, as before');
    assert.match(decisions[3].reason, /3 non-critical pushes were already surfaced/);
    // And the cap is what refused it - not the window, which is closed.
    assert.equal(decisions[3].quietHours.activeNow, false);
  });

  it('does not let a held notice consume the hourly budget', () => {
    const governor = new PushGovernor({ now: at(INSIDE), quietHours: WINDOW });
    governor.admit(advisory('held-1'));
    governor.admit(advisory('held-2'));
    governor.admit(advisory('held-3'));
    assert.equal(governor.budget().used, 0, 'a held notice was never surfaced, so it was never spent');
    assert.equal(governor.budget().remaining, PUSH_LIMIT_PER_HOUR);
    assert.equal(governor.budget().quietHours.activeNow, true);
  });

  it('behaves exactly as before when quiet hours are disabled, at any hour', () => {
    const governed = new PushGovernor({ now: at(INSIDE), quietHours: { enabled: false } });
    const decision = governed.admit(advisory());
    assert.equal(decision.admitted, true);
    assert.equal(decision.reason, 'within the hourly budget');
    assert.equal(decision.quietHours.enabled, false);
    assert.equal(decision.quietHours.activeNow, false);
  });

  it('keeps suppression ahead of quiet hours, so the owner sees the rule that silenced it', () => {
    const governor = new PushGovernor({ now: at(OUTSIDE), quietHours: WINDOW });
    governor.dismiss({ alertClass: 'workspace_dirty' });
    governor.dismiss({ alertClass: 'workspace_dirty' });
    const decision = governor.admit(advisory('sig:after-suppression'));
    assert.equal(decision.admitted, false);
    assert.match(decision.reason, /suppressed by the owner's rule/, 'an explicit rule outranks a clock');
  });

  it('reports the window in the snapshot the service and the deck read', () => {
    const governor = new PushGovernor({ now: at(INSIDE), quietHours: WINDOW });
    const snapshot = governor.snapshot();
    assert.equal(snapshot.quietHours.enabled, true);
    assert.equal(snapshot.quietHours.activeNow, true);
    assert.equal(snapshot.budget.quietHours.activeNow, true);
    assert.deepEqual({ ...snapshot.quietHours.window }, { startHour: 22, endHour: 7, utcOffsetHours: 0 });
  });
});

describe('T-42 the flake itself: a busy host cannot steal the walk\'s budget', () => {
  // The CI failure, reproduced exactly: three non-critical advisories from one sense.
  const busyHostAdvisories = [
    { watch: 'workspace', signature: 'workspace_dirty:main:1:0', alertClass: 'workspace_dirty' },
    { watch: 'host.cpu', signature: 'load_pressure:0.975:2', alertClass: 'load_pressure' },
    { watch: 'host.storage', signature: 'storage_pressure:0.95', alertClass: 'storage_pressure' },
  ];

  it('shows why a busy runner held the row: the cap, not the clock and not a fault', () => {
    const governor = new PushGovernor({ now: at(OUTSIDE) });
    for (const entry of busyHostAdvisories) assert.equal(governor.admit(entry).admitted, true);
    assert.equal(governor.budget().used, 3);
    assert.equal(governor.budget().remaining, 0);
    // The walk then changes the machine and senses again. The signature is new; the budget is not.
    const second = governor.admit({ watch: 'workspace', signature: 'workspace_dirty:main:1:1', alertClass: 'workspace_dirty' });
    assert.equal(second.admitted, false);
    assert.match(second.reason, /already surfaced in the last 60 minutes/);
    assert.equal(second.quietHours.activeNow, false, 'this refusal has nothing to do with quiet hours');
  });

  it('delivers the same second sense once the host half of the reading is pinned', () => {
    // This is the fixture's configuration: only the workspace rule can fire, so the budget is intact.
    const governor = new PushGovernor({ now: at(OUTSIDE) });
    assert.equal(governor.admit(busyHostAdvisories[0]).admitted, true);
    const second = governor.admit({ watch: 'workspace', signature: 'workspace_dirty:main:1:1', alertClass: 'workspace_dirty' });
    assert.equal(second.admitted, true, 'an honest reading of a dirty tree is delivered');
    assert.equal(governor.budget().used, 2);
    assert.equal(governor.budget().remaining, 1);
  });
});
