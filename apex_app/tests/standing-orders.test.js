// T-44 Package 1 (2026-11-19): the governed Standing Orders engine.
//
// These tests pin the four rules the module exists to enforce, and they pin them against the real
// composed application rather than a hand-built stub, because the question "may this capability be
// delegated" is answered by the registry's own declarations - a stub registry would answer it with the
// test author's beliefs instead of the product's.
//
//   1. The whitelist. A capability that writes the workspace, moves the safety latch, is security
//      relevant or cannot be undone is refused at REGISTRATION with 403 STANDING_ORDER_CAPABILITY_FORBIDDEN.
//      Five of the brief's named refusals are asserted by name.
//   2. Lockdown. Every entry point answers 423 while the latch is engaged, the capability never runs,
//      and releasing the latch does not run anything that was halted.
//   3. The rate limits. A cooldown skip is recorded as `cooldown_skipped` and does not extend itself,
//      because a skipped attempt must not move `lastRunAt`.
//   4. The execution path. Every run goes through the controller, so it leaves an operation in
//      `operations.jsonl` whose id appears in the order's history.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import {
  SAFE_CAPABILITY_SET,
  StandingOrdersEngine,
  allowedStandingOrderCapabilities,
  delegationRefusalReasons,
  standingOrderPolicy,
} from '../src/executive/standing-orders.js';

const dirs = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    try { cleanup(dirs.pop()); } catch { /* already gone */ }
  }
});

// A real repository, so `git.status_detailed` has something true to read and the run that verifies is a
// real verified run rather than a stub returning a bool.
function gitWorkspace() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 't44-ws-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't44@example.invalid');
  git('config', 'user.name', 'T-44');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  dirs.push(dir);
  return dir;
}

function appWith({ root = null, stepUpToken = null } = {}) {
  return createApp({
    dataDir: tempDir(),
    filesystemRoot: root,
    ...(stepUpToken ? { stepUpToken } : {}),
  });
}

function ledger(dataDir) {
  const file = path.join(dataDir, 'operations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function orderFile(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'standing-orders.json'), 'utf8'));
}

// ------------------------------------------------------------------------------- the whitelist ---

describe('T-44 standing orders: the delegable set', () => {
  test('the safe set is exactly the seven capabilities the brief names, and every one is delegable', () => {
    const app = appWith({ root: gitWorkspace() });
    assert.deepEqual([...SAFE_CAPABILITY_SET].sort(), [
      'briefing.compile', 'git.diff_inspect', 'git.status_detailed', 'system.doctor',
      'system.inspect_ports', 'system.inspect_processes', 'workspace.inspect',
    ]);
    const allowed = allowedStandingOrderCapabilities(app.registry);
    assert.deepEqual(allowed, [...SAFE_CAPABILITY_SET].sort(),
      'all seven must be registered and must pass the rule in a rooted build');
    for (const name of allowed) {
      assert.deepEqual(delegationRefusalReasons(app.registry.get(name)), [], `${name} must be delegable`);
    }
  });

  test('an order for each of the seven safe capabilities is created and stored verified', () => {
    const app = appWith({ root: gitWorkspace() });
    for (const capabilityId of SAFE_CAPABILITY_SET) {
      const order = app.standingOrders.create({
        title: `delegate ${capabilityId}`, eventType: 'manual_invoke', capabilityId,
      });
      assert.match(order.orderId, /^so_[0-9a-f]{16}$/, 'an order id is stable and prefix-named');
      assert.equal(order.verified, true);
      assert.equal(order.runCount, 0);
      assert.equal(order.lastRunAt, null);
      assert.equal(order.lastRunId, null);
      assert.equal(order.lastOutcome, 'never_run');
      assert.deepEqual(order.history, []);
      assert.equal(order.trigger.cooldownSec, 30, 'the default cooldown is 30 seconds');
      assert.equal(order.trigger.maxRunsPerHour, 12, 'the default rate limit is twelve an hour');
      assert.equal(order.action.autonomyTier, 'L3', 'an order is above L2 by definition');
    }
    assert.equal(orderFile(app.dataDir).orders.length, SAFE_CAPABILITY_SET.length);
  });

  test('a forbidden capability is refused at registration with 403 STANDING_ORDER_CAPABILITY_FORBIDDEN', () => {
    const app = appWith({ root: gitWorkspace() });
    // The five the brief names, plus one that is not registered at all. Each must be 403 and each must
    // leave the ledger empty: a refusal that still wrote the row would be a refusal that did not refuse.
    const forbidden = [
      'workshop.apply_file', 'workshop.apply_changeset', 'workshop.rollback_file',
      'git.checkpoint_restore', 'git.checkpoint_create', 'safety.release', 'safety.lockdown',
      'evolution.stage_to_workshop', 'evolution.decide', 'filesystem.write',
    ];
    for (const capabilityId of forbidden) {
      assert.throws(
        () => app.standingOrders.create({ title: 'x', eventType: 'workspace_dirty', capabilityId }),
        (err) => {
          assert.equal(err.code, 'STANDING_ORDER_CAPABILITY_FORBIDDEN', `${capabilityId} must be refused`);
          assert.equal(err.status, 403, `${capabilityId} must be a 403`);
          assert.ok(Array.isArray(err.detail.reasons) && err.detail.reasons.length > 0, 'a refusal names its reason');
          return true;
        },
        `${capabilityId} must not be delegable`,
      );
    }
    assert.equal(fs.existsSync(path.join(app.dataDir, 'standing-orders.json')), false,
      'not one refused order may be written to the ledger');
  });

  test('an unregistered capability is refused rather than stored as a row that could never run', () => {
    const app = appWith();
    assert.throws(() => app.standingOrders.create({ title: 'x', eventType: 'manual_invoke', capabilityId: 'nope.missing' }),
      (err) => err.code === 'STANDING_ORDER_CAPABILITY_FORBIDDEN' && err.status === 403);
  });

  test('a capability outside the safe set is refused even when the rule would permit it', () => {
    // `workspace.read_file` is a read_only local_state read: the letter of the rule permits it, and it is
    // not in the safe set, because a standing order that could name any file would exfiltrate a different
    // one each time it fired. This is the test that keeps "permitted by the rule" from meaning "armed".
    const app = appWith({ root: gitWorkspace() });
    const def = app.registry.get('workspace.read_file');
    assert.equal(def.reversibility, 'read_only');
    assert.equal(def.blastRadius, 'none');
    assert.throws(() => app.standingOrders.create({
      title: 'x', eventType: 'manual_invoke', capabilityId: 'workspace.read_file',
    }), (err) => err.code === 'STANDING_ORDER_CAPABILITY_FORBIDDEN');
  });

  test('the policy is a value a surface can render, and it names the rule and the tiers', () => {
    const app = appWith();
    const policy = standingOrderPolicy(app.registry);
    assert.equal(policy.schema, 'apex.executive.standing-order-policy/1');
    assert.match(policy.rule, /reversible/);
    assert.match(policy.rule, /local_state/);
    assert.deepEqual(policy.triggerEventTypes, [
      'workspace_dirty', 'load_pressure', 'storage_pressure', 'drift_detected', 'session_start', 'manual_invoke',
    ]);
    assert.deepEqual(policy.autonomyTiers, ['L3', 'L4', 'L5']);
    assert.deepEqual(policy.defaults, { cooldownSec: 30, maxRunsPerHour: 12 });
    assert.ok(policy.forbiddenCapabilities.includes('workshop.apply_file'));
  });

  test('an invalid trigger or tier is refused rather than defaulted into something that looks armed', () => {
    const app = appWith();
    assert.throws(() => app.standingOrders.create({ title: 'x', eventType: 'whenever', capabilityId: 'system.doctor' }),
      (err) => err.code === 'STANDING_ORDER_INVALID_TRIGGER' && err.status === 400);
    assert.throws(() => app.standingOrders.create({ title: 'x', eventType: 'manual_invoke', capabilityId: 'system.doctor', autonomyTier: 'L2' }),
      (err) => err.code === 'STANDING_ORDER_INVALID_TIER' && err.status === 400);
    assert.throws(() => app.standingOrders.create({ title: '', eventType: 'manual_invoke', capabilityId: 'system.doctor' }),
      (err) => err.code === 'STANDING_ORDER_INVALID_INPUT' && err.status === 400);
  });
});

// ------------------------------------------------------------------------------------ the runs ---

describe('T-44 standing orders: every run is a governed operation', () => {
  test('invoke runs through the ECP and leaves an operation whose id is in the history', async () => {
    const app = appWith({ root: gitWorkspace() });
    const order = app.standingOrders.create({
      title: 'a repository reading', eventType: 'workspace_dirty', capabilityId: 'git.status_detailed',
    });
    // A second granularity: the cooldown would refuse anything else immediately, and this test is about
    // the run rather than the limit.
    const result = await app.standingOrders.invoke(order.orderId);
    assert.equal(result.outcome, 'verified', result.summary);
    assert.equal(result.verified, true);
    assert.match(result.runId, /^sor_[0-9a-f]{16}$/);
    assert.equal(result.order.runCount, 1);
    assert.equal(result.order.lastOutcome, 'verified');
    assert.equal(result.order.lastRunId, result.runId);
    assert.equal(result.order.history.length, 1);
    const run = result.order.history[0];
    assert.equal(run.runId, result.runId);
    assert.equal(run.triggeredBy, 'manual_invoke');
    assert.equal(run.outcome, 'verified');
    assert.equal(run.verified, true);
    assert.ok(typeof run.operationId === 'string' && run.operationId.length > 0, 'a verified run names its operation');

    // The receipt is a real record in the one ledger, with the capability's own verification on it.
    const record = ledger(app.dataDir).find((entry) => entry.id === run.operationId);
    assert.ok(record, 'the operation the history names must exist in operations.jsonl');
    assert.equal(record.steps[0].action, 'git.status_detailed');
    assert.equal(record.steps[0].verification.outcome, 'success_verified');
    assert.equal(record.steps[0].authorization.decision, 'allow');
  });

  test('evaluate runs only the enabled orders whose trigger matches, each through the ECP', async () => {
    const app = appWith({ root: gitWorkspace() });
    const matching = app.standingOrders.create({
      title: 'on dirty', eventType: 'workspace_dirty', capabilityId: 'git.status_detailed',
    });
    const other = app.standingOrders.create({
      title: 'on pressure', eventType: 'storage_pressure', capabilityId: 'system.doctor',
    });
    const paused = app.standingOrders.create({
      title: 'paused on dirty', eventType: 'workspace_dirty', capabilityId: 'system.inspect_ports',
    });
    app.standingOrders.toggle(paused.orderId, { enabled: false });

    const result = await app.standingOrders.evaluate({ eventType: 'workspace_dirty' });
    assert.equal(result.matchedCount, 1, 'a paused order and an order for another trigger are not candidates');
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].orderId, matching.orderId);
    assert.equal(result.runs[0].outcome, 'verified');
    assert.equal(result.verified, true);
    // The two non-candidates were not touched: not run, not skipped, not recorded.
    assert.equal((await app.standingOrders.detail(other.orderId)).runCount, 0);
    assert.equal((await app.standingOrders.detail(paused.orderId)).runCount, 0);
    assert.deepEqual((await app.standingOrders.detail(other.orderId)).history, []);
  });

  test('a dry run reports the candidates and runs nothing at all', async () => {
    const app = appWith({ root: gitWorkspace() });
    const order = app.standingOrders.create({
      title: 'on dirty', eventType: 'workspace_dirty', capabilityId: 'git.status_detailed',
    });
    const result = await app.standingOrders.evaluate({ eventType: 'workspace_dirty', dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.matchedCount, 1);
    assert.deepEqual(result.runs, []);
    assert.equal((await app.standingOrders.detail(order.orderId)).runCount, 0);
    assert.deepEqual((await app.standingOrders.detail(order.orderId)).history, []);
    assert.deepEqual(ledger(app.dataDir), [], 'a dry run writes no operation');
  });

  test('a run whose capability is no longer delegable is refused, not run and not counted', async () => {
    // The registry has no removal, so "the declaration changed under a live order" is expressed the way
    // it can actually happen: an engine reads a registry that does not hold the capability the stored
    // order names - a build without a workspace root, where the git reads are not registered at all, and
    // an order ledger copied from a build that had one. The stored order must not become a permission.
    const rooted = appWith({ root: gitWorkspace() });
    const order = rooted.standingOrders.create({
      title: 'a repository reading', eventType: 'workspace_dirty', capabilityId: 'git.status_detailed',
    });
    const rootless = appWith({ root: null });
    // Copy the ledger across, which is what a data directory moved to a build with no root looks like.
    fs.copyFileSync(
      path.join(rooted.dataDir, 'standing-orders.json'),
      path.join(rootless.dataDir, 'standing-orders.json'),
    );
    assert.equal(rootless.registry.get('git.status_detailed'), null);
    const result = await rootless.standingOrders.invoke(order.orderId);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.verified, false);
    assert.equal(result.order.runCount, 0, 'a refused run does not count as a run');
    assert.match(result.summary, /no longer delegable/);
    assert.equal(result.operationId, null, 'nothing was executed, so there is no operation to point at');
    // And the list says so, rather than showing the row as if it were runnable.
    const listed = rootless.standingOrders.list().orders[0];
    assert.equal(listed.runnable, false);
    assert.ok(listed.forbiddenReasons.length > 0);
  });
});

// ------------------------------------------------------------------------------ the rate limits ---

describe('T-44 standing orders: the cooldown and the hourly limit', () => {
  test('a second invoke inside the cooldown is cooldown_skipped and does not re-run or extend itself', async () => {
    // A controlled clock, so the cooldown can be walked through deterministically rather than slept
    // through. The engine takes `now` for exactly this reason.
    let clockMs = Date.parse('2026-11-19T00:00:00.000Z');
    const dir = tempDir();
    const base = appWith({ root: gitWorkspace() });
    const engine = new StandingOrdersEngine({
      dataDir: dir,
      registry: base.registry,
      controller: base.controller,
      now: () => new Date(clockMs),
      lockdown: () => false,
    });
    const order = engine.create({ title: 'dirty', eventType: 'workspace_dirty', capabilityId: 'git.status_detailed' });

    const first = await engine.invoke(order.orderId);
    assert.equal(first.outcome, 'verified');
    assert.equal(first.order.runCount, 1);
    const lastRunAt = first.order.lastRunAt;

    clockMs += 5_000; // five seconds later: inside a thirty second cooldown
    const skipped = await engine.invoke(order.orderId);
    assert.equal(skipped.outcome, 'cooldown_skipped');
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.order.runCount, 1, 'a skip is not a run');
    assert.equal(skipped.order.lastRunAt, lastRunAt, 'a skip must not move the window, or it extends itself forever');
    assert.equal(skipped.order.history.length, 2, 'a skip is recorded, because the owner should be able to see it');
    assert.equal(skipped.order.history[1].outcome, 'cooldown_skipped');
    assert.equal(skipped.order.history[1].operationId, null);

    clockMs += 26_000; // thirty-one seconds after the run
    const again = await engine.invoke(order.orderId);
    assert.equal(again.outcome, 'verified', 'the cooldown elapsed, so the run is permitted again');
    assert.equal(again.order.runCount, 2);
  });

  test('maxRunsPerHour stops the run even when the cooldown has elapsed', async () => {
    let clockMs = Date.parse('2026-11-19T00:00:00.000Z');
    const dir = tempDir();
    const base = appWith({ root: gitWorkspace() });
    const engine = new StandingOrdersEngine({
      dataDir: dir, registry: base.registry, controller: base.controller,
      now: () => new Date(clockMs), lockdown: () => false,
    });
    const order = engine.create({
      title: 'bounded', eventType: 'workspace_dirty', capabilityId: 'system.doctor',
      cooldownSec: 0, maxRunsPerHour: 2,
    });
    clockMs += 1_000; assert.equal((await engine.invoke(order.orderId)).outcome, 'verified');
    clockMs += 1_000; assert.equal((await engine.invoke(order.orderId)).outcome, 'verified');
    clockMs += 1_000;
    const third = await engine.invoke(order.orderId);
    assert.equal(third.outcome, 'cooldown_skipped');
    assert.match(third.summary, /2 verified runs in the last hour is the limit/);
    assert.equal(third.order.runCount, 2, 'the limit stops the run rather than being counted past');
  });
});

// ------------------------------------------------------------------------------------ lockdown ---

describe('T-44 standing orders: Lockdown halts and release does not resume', () => {
  test('every entry point answers 423 while the latch is engaged and nothing runs', async () => {
    const app = appWith({ root: gitWorkspace() });
    const order = app.standingOrders.create({
      title: 'dirty', eventType: 'workspace_dirty', capabilityId: 'git.status_detailed',
    });
    app.registry.controlPlane.activateKillSwitch({ origin: 'user', reason: 'T-44 lockdown probe' });
    try {
      const locked = app.standingOrders.list();
      assert.equal(locked.lockdownActive, true);
      assert.equal(locked.orders[0].runnable, false, 'an order is not runnable while the latch is engaged');

      const attempts = [
        () => app.standingOrders.create({ title: 'x', eventType: 'manual_invoke', capabilityId: 'system.doctor' }),
        () => app.standingOrders.toggle(order.orderId, { enabled: false }),
        () => app.standingOrders.revoke(order.orderId),
        () => app.standingOrders.invoke(order.orderId),
        () => app.standingOrders.evaluate({ eventType: 'workspace_dirty' }),
      ];
      for (const attempt of attempts) {
        await assert.rejects(async () => attempt(), (err) => {
          assert.equal(err.code, 'LOCKDOWN_ACTIVE');
          assert.equal(err.status, 423);
          return true;
        });
      }
      // The order is untouched and the capability never ran.
      const after = await app.standingOrders.detail(order.orderId);
      assert.equal(after.runCount, 0);
      assert.equal(after.lastOutcome, 'never_run');
      assert.deepEqual(after.history, []);
    } finally {
      app.registry.controlPlane.clearKillSwitch({ origin: 'user', reason: 'probe complete' });
    }
  });

  test('a run halted mid-flight by the latch records halted_by_lockdown, and release does not fire it', async () => {
    // The engine's own lockdown reader is injected here, so the latch can be engaged at the exact moment
    // between the invoke being accepted and the capability being asked to run. That is the window the
    // brief cares about: an order must not slip through because its check happened a moment too early.
    let locked = false;
    const dir = tempDir();
    const base = appWith({ root: gitWorkspace() });
    const engine = new StandingOrdersEngine({
      dataDir: dir, registry: base.registry, controller: base.controller, lockdown: () => locked,
    });
    const order = engine.create({ title: 'dirty', eventType: 'workspace_dirty', capabilityId: 'git.status_detailed' });
    locked = true;
    // An invoke while the latch is engaged is a 423 at the entry point, so it never reaches the run.
    await assert.rejects(() => engine.invoke(order.orderId), (err) => err.status === 423);

    // To exercise the in-flight path, evaluate is asked while the reader says unlocked and the latch
    // engages on the second read. The engine reads the latch again inside the run, which is what makes
    // this the interesting case: the check is not a single gate at the door.
    let reads = 0;
    let armed = false;
    const racing = new StandingOrdersEngine({
      dataDir: tempDir(), registry: base.registry, controller: base.controller,
      // Unlocked until the test arms it, then unlocked exactly once more. That one extra read is the
      // entry point's gate; the read after it is the run's own gate, which is the one that halts.
      lockdown: () => { if (!armed) return false; reads += 1; return reads > 1; },
    });
    const racy = racing.create({ title: 'racy', eventType: 'workspace_dirty', capabilityId: 'system.inspect_ports' });
    armed = true;
    const result = await racing.evaluate({ eventType: 'workspace_dirty' });
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].outcome, 'halted_by_lockdown');
    assert.equal(result.runs[0].operationId, null, 'a halted run executes nothing, so it has no operation');
    const stored = await racing.detail(racy.orderId);
    assert.equal(stored.lastOutcome, 'halted_by_lockdown');
    assert.equal(stored.runCount, 0);
    assert.equal(stored.history.length, 1);
    assert.equal(stored.history[0].verified, false);

    // Release: the reader now answers false forever. Nothing fires. The engine keeps no queue between
    // calls, so there is nothing left to run - which is why this is a structural guarantee.
    locked = false;
    const quiet = new StandingOrdersEngine({
      dataDir: dir, registry: base.registry, controller: base.controller, lockdown: () => false,
    });
    const afterRelease = await quiet.detail(order.orderId);
    assert.equal(afterRelease.runCount, 0);
    assert.equal(afterRelease.lastOutcome, 'never_run', 'releasing the latch must not run the order it halted');
    assert.deepEqual(afterRelease.history, []);
  });
});

// ------------------------------------------------------------------------ the ledger and the trace ---

describe('T-44 standing orders: the ledger, the step-up and the trace', () => {
  test('toggle pauses and resumes without losing the run history', async () => {
    const app = appWith({ root: gitWorkspace() });
    const order = app.standingOrders.create({
      title: 'dirty', eventType: 'workspace_dirty', capabilityId: 'git.status_detailed',
    });
    await app.standingOrders.invoke(order.orderId);
    const paused = app.standingOrders.toggle(order.orderId, { enabled: false });
    assert.equal(paused.enabled, false);
    assert.equal(paused.runCount, 1, 'pausing does not erase what the order already did');
    assert.equal(paused.verified, true);
    // A paused order is not a candidate.
    const evaluated = await app.standingOrders.evaluate({ eventType: 'workspace_dirty' });
    assert.equal(evaluated.matchedCount, 0);
    const resumed = app.standingOrders.toggle(order.orderId, { enabled: true });
    assert.equal(resumed.enabled, true);
  });

  test('revoke removes the record and leaves the operations it performed in the ledger', async () => {
    const app = appWith({ root: gitWorkspace() });
    const order = app.standingOrders.create({
      title: 'dirty', eventType: 'workspace_dirty', capabilityId: 'git.status_detailed',
    });
    const run = await app.standingOrders.invoke(order.orderId);
    const revoked = app.standingOrders.revoke(order.orderId);
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.orderId, order.orderId);
    assert.equal(await app.standingOrders.detail(order.orderId), null);
    assert.equal(app.standingOrders.list().orders.length, 0);
    // The receipt survives the revocation: the act happened, and an audit trail that a revoke can erase
    // is not an audit trail.
    assert.ok(ledger(app.dataDir).some((entry) => entry.id === run.operationId));
    assert.throws(() => app.standingOrders.toggle(order.orderId), (err) => err.status === 404);
    await assert.rejects(() => app.standingOrders.invoke(order.orderId), (err) => err.status === 404);
  });

  test('the four ledger acts each leave exactly one audit line, and a run leaves the controller\'s one', async () => {
    const app = appWith({ root: gitWorkspace() });
    const order = app.standingOrders.create({
      title: 'dirty', eventType: 'workspace_dirty', capabilityId: 'git.status_detailed',
    });
    app.standingOrders.toggle(order.orderId, { enabled: false });
    app.standingOrders.toggle(order.orderId, { enabled: true });
    const run = await app.standingOrders.invoke(order.orderId);
    // Let the writer flush: `operations.append` is a promise the caller does not await.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const entries = ledger(app.dataDir);
    const byCapability = (name) => entries.filter((entry) => entry.capability === name);
    assert.equal(byCapability('standing_order.create').length, 1, 'create writes one line');
    assert.equal(byCapability('standing_order.toggle').length, 2, 'two toggles write two lines');
    assert.equal(byCapability('git.status_detailed').length, 1, 'the run writes the capability\'s own operation');
    assert.equal(byCapability('standing_order.run').length, 0,
      'a controller-executed run must not also write a thinner standing_order.run line');
    assert.ok(entries.some((entry) => entry.id === run.operationId));
    for (const entry of entries) {
      assert.equal(entry.steps[0].verification.outcome, 'success_verified', `${entry.capability} was not verified`);
    }
  });

  test('the step-up secret covers the two Workshop writes and not the standing-order ledger', () => {
    // A standing order's own writes are reversible local_state acts on an order ledger; the step-up list
    // is for acts that cost nothing when refused and everything when unproven. Asserting the boundary
    // here keeps a later batch from quietly adding one of these to the list without deciding it.
    const app = appWith({ stepUpToken: 'step-up-secret-t44' });
    const status = app.registry.controlPlane.stepUpStatus();
    assert.equal(status.configured, true);
    for (const name of ['standing_order.create', 'standing_order.toggle', 'standing_order.revoke', 'standing_order.invoke']) {
      assert.equal(status.appliesTo.includes(name), false, `${name} is not a step-up act`);
    }
    assert.ok(status.appliesTo.includes('workshop.apply_file'));
  });

  test('a standing order cannot be created by a model origin, whatever the input', () => {
    // The one act that would let a reply grant itself a standing permission. It is refused by the
    // registry before the engine is reached, which is the point: the engine is not the only gate.
    const app = appWith({ root: gitWorkspace() });
    assert.equal(app.registry.authorize('standing_order.create', 'model').decision, 'deny');
    for (const name of ['standing_order.toggle', 'standing_order.revoke', 'standing_order.invoke', 'standing_order.evaluate']) {
      assert.equal(app.registry.authorize(name, 'model').decision, 'deny', `${name} must deny a model origin`);
    }
  });
});

// ---------------------------------------------------------------------------------- the routes ---

describe('T-44 standing orders: the HTTP surface', () => {
  const TOKEN = 'tok_t44_standing_orders_1';
  const servers = [];
  afterEach(async () => {
    while (servers.length) await servers.pop().stop().catch(() => {});
  });

  async function serve(app) {
    const server = createUiServer({ app, token: TOKEN, port: 0 });
    servers.push(server);
    const started = await server.start();
    const base = `http://127.0.0.1:${started.port}`;
    const headers = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' };
    return {
      get: async (url) => {
        const res = await fetch(base + url, { headers });
        return { status: res.status, body: await res.json() };
      },
      post: async (url, body = {}) => {
        const res = await fetch(base + url, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      },
    };
  }

  test('GET answers 200 with the whole shape on a rooted build, a rootless build and an empty ledger', async () => {
    for (const root of [gitWorkspace(), null]) {
      const http = await serve(appWith({ root }));
      const result = await http.get('/api/standing-orders');
      assert.equal(result.status, 200, 'the list must never be a server fault, with or without a root');
      assert.equal(result.body.verified, true);
      assert.equal(result.body.lockdownActive, false);
      assert.ok(Array.isArray(result.body.allowedCapabilities));
      assert.ok(Array.isArray(result.body.orders));
      assert.deepEqual(result.body.summary, {
        totalCount: 0, enabledCount: 0, pausedCount: 0, totalRuns: 0, haltedByLockdownCount: 0,
      });
      // The safe set is what the panel builds its select from, so it must be the same seven either way.
      for (const name of SAFE_CAPABILITY_SET) {
        if (root !== null || name !== 'git.status_detailed') {
          if (root === null && name.startsWith('git.')) {
            assert.equal(result.body.allowedCapabilities.includes(name), false,
              'a rootless build has no repository, so its git reads are not registered');
          } else {
            assert.ok(result.body.allowedCapabilities.includes(name), `${name} must be offered`);
          }
        }
      }
    }
  });

  test('the five POSTs answer their documented statuses', async () => {
    const http = await serve(appWith({ root: gitWorkspace() }));
    const created = await http.post('/api/standing-orders', {
      title: 'dirty tree reading', eventType: 'workspace_dirty', capabilityId: 'git.status_detailed',
    });
    assert.equal(created.status, 200);
    const orderId = created.body.orderId;
    assert.match(orderId, /^so_/);

    const refused = await http.post('/api/standing-orders', {
      title: 'bad', eventType: 'workspace_dirty', capabilityId: 'workshop.apply_file',
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'STANDING_ORDER_CAPABILITY_FORBIDDEN');
    assert.equal(refused.body.verified, false);

    const invoked = await http.post(`/api/standing-orders/${orderId}/invoke`);
    assert.equal(invoked.status, 200);
    assert.equal(invoked.body.outcome, 'verified');
    assert.ok(invoked.body.operationId);

    const skipped = await http.post(`/api/standing-orders/${orderId}/invoke`);
    assert.equal(skipped.status, 200, 'a withheld run is an answered request, not a fault');
    assert.equal(skipped.body.outcome, 'cooldown_skipped');

    const toggled = await http.post(`/api/standing-orders/${orderId}/toggle`, { enabled: false });
    assert.equal(toggled.status, 200);
    assert.equal(toggled.body.enabled, false);

    const evaluated = await http.post('/api/standing-orders/evaluate', { eventType: 'workspace_dirty' });
    assert.equal(evaluated.status, 200);
    assert.equal(evaluated.body.matchedCount, 0, 'the only order is paused');

    const revoked = await http.post(`/api/standing-orders/${orderId}/revoke`);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revoked, true);

    assert.equal((await http.post('/api/standing-orders/so_missing/invoke')).status, 404);
    assert.equal((await http.post('/api/standing-orders/so_missing/toggle')).status, 404);
  });

  test('every POST answers 423 while Lockdown is engaged, and the GET still answers 200', async () => {
    const app = appWith({ root: gitWorkspace() });
    const http = await serve(app);
    const created = await http.post('/api/standing-orders', {
      title: 'dirty', eventType: 'workspace_dirty', capabilityId: 'git.status_detailed',
    });
    app.registry.controlPlane.activateKillSwitch({ origin: 'user', reason: 'T-44 route probe' });
    try {
      const listed = await http.get('/api/standing-orders');
      assert.equal(listed.status, 200, 'the panel must be able to say the latch is up');
      assert.equal(listed.body.lockdownActive, true);
      for (const [url, body] of [
        ['/api/standing-orders', { title: 'x', eventType: 'manual_invoke', capabilityId: 'system.doctor' }],
        [`/api/standing-orders/${created.body.orderId}/toggle`, {}],
        [`/api/standing-orders/${created.body.orderId}/invoke`, {}],
        [`/api/standing-orders/${created.body.orderId}/revoke`, {}],
        ['/api/standing-orders/evaluate', { eventType: 'workspace_dirty' }],
      ]) {
        const result = await http.post(url, body);
        assert.equal(result.status, 423, `${url} must be 423 under Lockdown`);
        assert.equal(result.body.code, 'LOCKDOWN_ACTIVE');
      }
    } finally {
      app.registry.controlPlane.clearKillSwitch({ origin: 'user', reason: 'probe complete' });
    }
    // After release the order is still there, still enabled, still never run.
    const after = await http.get('/api/standing-orders');
    assert.equal(after.body.orders.length, 1);
    assert.equal(after.body.orders[0].runCount, 0);
    assert.equal(after.body.orders[0].lastOutcome, 'never_run');
  });

  test('the causal trace resolves an order id and a run id to the same chain', async () => {
    const app = appWith({ root: gitWorkspace() });
    const http = await serve(app);
    const created = await http.post('/api/standing-orders', {
      title: 'delegated doctor', eventType: 'workspace_dirty', capabilityId: 'system.doctor',
    });
    const orderId = created.body.orderId;
    const run = await http.post(`/api/standing-orders/${orderId}/invoke`);
    assert.equal(run.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const byOrder = await http.get(`/api/memory/trace/${orderId}`);
    assert.equal(byOrder.status, 200);
    assert.equal(byOrder.body.ok, true);
    const orderChain = byOrder.body.entries;
    assert.equal(orderChain.filter((e) => e.kind === 'standing_order').length, 1);
    assert.equal(orderChain.filter((e) => e.kind === 'standing_order_run').length, 1);
    // A chain step is `{at, kind, label, linkedBy, detail}`: the ids live on `detail`, and the step's
    // `linkedBy` says how the chain reached it. That is the shape the timeline renders, so these tests
    // read the same field the surface does.
    const operationEntry = orderChain.find((e) => e.kind === 'ecp_audit' && e.detail?.operationId === run.body.operationId);
    assert.ok(operationEntry, 'the chain must reach the real operation the run recorded');
    const runStep = orderChain.find((e) => e.kind === 'standing_order_run');
    assert.equal(runStep.detail.runId, run.body.runId);
    assert.equal(runStep.detail.orderId, orderId);
    assert.equal(runStep.detail.operationId, run.body.operationId);
    assert.equal(runStep.detail.verified, true);
    const orderStep = orderChain.find((e) => e.kind === 'standing_order');
    assert.equal(orderStep.detail.orderId, orderId);
    assert.equal(orderStep.detail.capabilityId, 'system.doctor');

    const byRun = await http.get(`/api/memory/trace/${run.body.runId}`);
    assert.equal(byRun.status, 200);
    assert.equal(byRun.body.ok, true);
    const runChain = byRun.body.entries;
    assert.equal(runChain.filter((e) => e.kind === 'standing_order_run').length, 1,
      'a chain opened for a run names that run');
    assert.equal(runChain.filter((e) => e.kind === 'standing_order').length, 1,
      'and the order that owns it');
    const runOnly = runChain.find((e) => e.kind === 'standing_order_run');
    assert.equal(runOnly.linkedBy, 'the id names this run', 'the link is named for what it is');
  });
});
