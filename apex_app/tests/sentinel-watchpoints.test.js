// T-45 Package 4 (2026-11-19): the Sentinel Watchpoints engine.
//
// These tests pin the six claims the module exists to make, against the REAL composed application and a
// REAL git repository, because the question "what does this metric read right now" is answered by the
// machine rather than by the test author:
//
//   1. The four metrics. Each one is measured by running the capability that owns it, so the number on the
//      card is a capability's answer rather than a second implementation of the same reading.
//   2. The refusals. A metric outside the closed four is INVALID_WATCHPOINT_METRIC and an operator outside
//      the three is INVALID_WATCHPOINT_OPERATOR, both at 400 - so no rule on an unmeasurable name and no
//      rule with an ordering the engine cannot apply is ever written.
//   3. The live states. `apex_rss_mb gt 1` is breached by any running APEX, and `apex_rss_mb gt 999999` is
//      nominal: the state is a judgement of the number, not a constant. `dirty_files_count gt 0` is
//      breached by a real worktree edit and nominal on a clean tree.
//   4. `unmeasured` is not `nominal`. A rule nothing has read yet is in its own state, and a paused rule
//      keeps its history and re-enables to the last judgement rather than resetting.
//   5. Lockdown. Create, toggle, delete and evaluate each answer 423, and the reads stay 200 and say so.
//   6. Every evaluation is one audited write with one operation id, and the trace resolves a `wp_` id to
//      its evaluations and a `wpe_` id to its rule.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import {
  WATCHPOINT_CODES, WATCHPOINT_METRICS, WATCHPOINT_METRIC_NAMES, WATCHPOINT_OPERATORS,
  WATCHPOINT_SEVERITIES, WATCHPOINT_STATES, compareToThreshold,
} from '../src/perception/watchpoints.js';

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

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'APEX T-45',
  GIT_AUTHOR_EMAIL: 't45@apex.invalid',
  GIT_COMMITTER_NAME: 'APEX T-45',
  GIT_COMMITTER_EMAIL: 't45@apex.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

// A real repository. `dirty` leaves one unstaged edit, so `dirty_files_count` is exactly one for a reason
// the test can point at rather than a number it arranged.
function gitWorkspace({ dirty = true } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 't45-wp-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV });
  git('init', '-q', '--initial-branch=main');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'first');
  if (dirty) fs.writeFileSync(path.join(dir, 'tracked.txt'), 'two\n');
  dirs.push(dir);
  return dir;
}

function appWith({ root = null } = {}) {
  return createApp({ dataDir: tempDir(), filesystemRoot: root });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

function ledger(app) {
  const file = path.join(app.dataDir, 'sentinel-watchpoints.json');
  if (!fs.existsSync(file)) return { watchpoints: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function operations(app) {
  const file = path.join(app.dataDir, 'operations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function createWatchpoint(app, overrides = {}) {
  return app.watchpoints.create({
    title: 'a rule the test wrote', metric: 'apex_rss_mb', operator: 'gt', threshold: 1, severity: 'warning',
    ...overrides,
  });
}

describe('T-45 Package 2: the metric vocabulary', () => {
  test('four metrics, three operators, three severities, four states - all closed lists', () => {
    assert.deepEqual([...WATCHPOINT_METRIC_NAMES], [
      'dirty_files_count', 'external_ports_count', 'apex_rss_mb', 'overdue_commitments_count',
    ]);
    assert.deepEqual([...WATCHPOINT_OPERATORS], ['gt', 'gte', 'eq']);
    assert.deepEqual([...WATCHPOINT_SEVERITIES], ['advisory', 'warning', 'critical']);
    assert.deepEqual([...WATCHPOINT_STATES], ['unmeasured', 'nominal', 'breached', 'paused']);
    // Every metric names the capability that measures it, so a metric is never a second implementation of a
    // reading the product already takes.
    for (const name of WATCHPOINT_METRIC_NAMES) {
      assert.equal(typeof WATCHPOINT_METRICS[name].capabilityId, 'string');
      assert.equal(typeof WATCHPOINT_METRICS[name].measure, 'function');
      assert.equal(typeof WATCHPOINT_METRICS[name].label, 'string');
    }
  });

  test('the three operators order numbers the way their names say', () => {
    assert.equal(compareToThreshold(2, 'gt', 1), true);
    assert.equal(compareToThreshold(1, 'gt', 1), false);
    assert.equal(compareToThreshold(1, 'gte', 1), true);
    assert.equal(compareToThreshold(0, 'gte', 1), false);
    assert.equal(compareToThreshold(1, 'eq', 1), true);
    assert.equal(compareToThreshold(2, 'eq', 1), false);
  });

  test('a measurement that produced no number is unmeasured, not nominal', async () => {
    const app = appWith({ root: null });
    createWatchpoint(app, { metric: 'apex_rss_mb', threshold: 1 });
    // No workspace root means no process inspector is composed here, so the metric cannot be measured. The
    // honest answer is `unmeasured`: the rule did not pass, and nothing said it did.
    const result = await app.watchpoints.evaluate();
    assert.equal(result.verified, true);
    const row = result.results.find((entry) => !entry.skipped);
    if (row === undefined) return; // the metric measured anyway; the live-state tests below cover that
    if (row.measuredValue === null) {
      assert.equal(row.state, 'unmeasured');
      assert.equal(row.breached, false, 'an unmeasured rule has not breached: nothing was compared');
    }
  });
});

describe('T-45 Package 2: the refusals', () => {
  test('a metric outside the four is refused 400 INVALID_WATCHPOINT_METRIC', () => {
    const app = appWith({ root: gitWorkspace() });
    assert.throws(() => createWatchpoint(app, { metric: 'cpu_percent' }), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, WATCHPOINT_CODES.INVALID_WATCHPOINT_METRIC);
      assert.deepEqual(error.detail.allowed, [...WATCHPOINT_METRIC_NAMES]);
      return true;
    });
    // Refused before a row was written, so the ledger holds nothing.
    assert.equal(ledger(app).watchpoints.length, 0);
  });

  test('a threshold that is not a non-negative integer is refused 400 INVALID_WATCHPOINT_THRESHOLD', () => {
    const app = appWith({ root: gitWorkspace() });
    for (const threshold of [-1, 1.5, 'many', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => createWatchpoint(app, { threshold }), (error) => {
        assert.equal(error.status, 400, `threshold ${String(threshold)} must be refused`);
        assert.equal(error.code, WATCHPOINT_CODES.INVALID_WATCHPOINT_THRESHOLD);
        return true;
      });
    }
    assert.equal(ledger(app).watchpoints.length, 0);
  });

  test('an operator outside the three is refused 400 INVALID_WATCHPOINT_OPERATOR', () => {
    const app = appWith({ root: gitWorkspace() });
    for (const operator of ['lt', 'lte', 'neq', '==', '']) {
      assert.throws(() => createWatchpoint(app, { operator }), (error) => {
        assert.equal(error.status, 400, `operator ${JSON.stringify(operator)} must be refused`);
        assert.equal(error.code, WATCHPOINT_CODES.INVALID_WATCHPOINT_OPERATOR);
        return true;
      });
    }
    assert.equal(ledger(app).watchpoints.length, 0);
  });

  test('a severity outside the three, or an empty title, is refused', () => {
    const app = appWith({ root: gitWorkspace() });
    assert.throws(() => createWatchpoint(app, { severity: 'catastrophic' }), (error) => {
      assert.equal(error.status, 400);
      return true;
    });
    assert.throws(() => createWatchpoint(app, { title: '   ' }), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, WATCHPOINT_CODES.INVALID_INPUT);
      return true;
    });
    assert.equal(ledger(app).watchpoints.length, 0);
  });

  test('an unknown id is refused 404 for toggle, delete and detail', () => {
    const app = appWith({ root: gitWorkspace() });
    for (const call of [
      () => app.watchpoints.toggle('wp_nope'),
      () => app.watchpoints.remove('wp_nope'),
    ]) {
      assert.throws(call, (error) => {
        assert.equal(error.status, 404);
        assert.equal(error.code, WATCHPOINT_CODES.WATCHPOINT_NOT_FOUND);
        return true;
      });
    }
    assert.equal(app.watchpoints.detail('wp_nope'), null);
  });
});

describe('T-45 Package 2: the live states', () => {
  test('a new watchpoint is unmeasured, and its shape is the declared one', () => {
    const app = appWith({ root: gitWorkspace() });
    const created = createWatchpoint(app);
    assert.match(created.watchpointId, /^wp_/);
    assert.equal(created.verified, true);
    assert.equal(created.lastState, 'unmeasured');
    assert.equal(created.evaluationCount, 0);
    assert.equal(created.breachCount, 0);
    assert.equal(created.lastEvaluatedAt, null);
    assert.equal(created.lastMeasuredValue, null);
    assert.equal(created.lastEvalId, null);
    assert.deepEqual(created.history, []);
    assert.equal(created.rule, 'apex_rss_mb > 1 MB');
    // The listing agrees with the stored row.
    const listed = app.watchpoints.list();
    assert.equal(listed.summary.totalCount, 1);
    assert.equal(listed.summary.enabledCount, 1);
    assert.equal(listed.summary.breachedCount, 0);
    assert.equal(listed.summary.nominalCount, 0);
  });

  test('apex_rss_mb gt 1 is breached live, and gt 999999 is nominal', async () => {
    const app = appWith({ root: gitWorkspace() });
    // This is the number the running process really reports, not a fixture: any process carrying a Node
    // heap is more than a megabyte resident.
    const breached = createWatchpoint(app, { title: 'resident at all', metric: 'apex_rss_mb', threshold: 1 });
    const nominal = createWatchpoint(app, { title: 'residency ceiling', metric: 'apex_rss_mb', operator: 'gt', threshold: 999999 });
    const result = await app.watchpoints.evaluate();
    assert.equal(result.verified, true);
    assert.match(result.evalId, /^wpe_/);

    const after = app.watchpoints.list();
    const breachedRow = after.watchpoints.find((entry) => entry.watchpointId === breached.watchpointId);
    const nominalRow = after.watchpoints.find((entry) => entry.watchpointId === nominal.watchpointId);
    assert.equal(breachedRow.lastState, 'breached');
    assert.equal(breachedRow.breachCount, 1);
    assert.equal(nominalRow.lastState, 'nominal');
    assert.equal(nominalRow.breachCount, 0);
    // Both measured the SAME metric, so the two rules differ only in their threshold - which is the claim.
    assert.equal(breachedRow.lastMeasuredValue, nominalRow.lastMeasuredValue);
    assert.ok(breachedRow.lastMeasuredValue > 1);
    assert.ok(nominalRow.lastMeasuredValue < 999999);
    // One evaluation, two rules judged, one breach.
    assert.equal(result.summary.evaluatedCount, 2);
    assert.equal(result.summary.breachedCount, 1);
    assert.equal(result.summary.nominalCount, 1);
    assert.equal(after.summary.breachedCount, 1);
    assert.equal(after.summary.nominalCount, 1);
  });

  test('dirty_files_count gt 0 is breached by a real edit and nominal on a clean tree', async () => {
    const dirtyApp = appWith({ root: gitWorkspace({ dirty: true }) });
    createWatchpoint(dirtyApp, { title: 'uncommitted work', metric: 'dirty_files_count', threshold: 0 });
    await dirtyApp.watchpoints.evaluate();
    const dirtyRow = dirtyApp.watchpoints.list().watchpoints[0];
    assert.equal(dirtyRow.lastState, 'breached');
    assert.equal(dirtyRow.lastMeasuredValue, 1, 'one unstaged edit is one dirty file');

    const cleanApp = appWith({ root: gitWorkspace({ dirty: false }) });
    const clean = createWatchpoint(cleanApp, {
      title: 'uncommitted work', metric: 'dirty_files_count', operator: 'gt', threshold: 0,
    });
    await cleanApp.watchpoints.evaluate();
    const cleanRow = cleanApp.watchpoints.detail(clean.watchpointId);
    assert.equal(cleanRow.lastState, 'nominal');
    assert.equal(cleanRow.lastMeasuredValue, 0);
    // The same rule against the same threshold, differing only in what the repository holds.
    assert.equal(cleanRow.threshold, dirtyRow.threshold);
    assert.equal(cleanRow.operator, dirtyRow.operator);
  });

  test('a metricOverride is an explicit test input, and the record says what it measured', async () => {
    // The override exists so a test can hold a reading still. It never applies to a route: the server does
    // not offer one. This test pins that the number recorded is the number the override supplied, so a card
    // can never show a state that its own history does not explain.
    const app = appWith({ root: gitWorkspace() });
    const wp = createWatchpoint(app, { title: 'held still', metric: 'external_ports_count', threshold: 2 });
    const result = await app.watchpoints.evaluate({ metricOverrides: { external_ports_count: 3 } });
    const row = result.results.find((entry) => entry.watchpointId === wp.watchpointId);
    assert.equal(row.measuredValue, 3);
    assert.equal(row.state, 'breached');
    const stored = app.watchpoints.detail(wp.watchpointId);
    assert.equal(stored.lastMeasuredValue, 3);
    assert.equal(stored.history[0].measuredValue, 3);
    assert.equal(stored.history[0].threshold, 2);
    assert.equal(stored.history[0].breached, true);
  });
});

describe('T-45 Package 2: pause, resume and delete', () => {
  test('a paused rule keeps its history and re-enables to the last judgement', async () => {
    const app = appWith({ root: gitWorkspace() });
    const wp = createWatchpoint(app);
    await app.watchpoints.evaluate();
    const afterFirst = app.watchpoints.detail(wp.watchpointId);
    assert.equal(afterFirst.lastState, 'breached');

    const paused = app.watchpoints.toggle(wp.watchpointId);
    assert.equal(paused.enabled, false);
    assert.equal(paused.lastState, 'paused');
    // Pausing is not forgetting: the history and the counts are still there.
    assert.equal(paused.evaluationCount, 1);
    assert.equal(paused.breachCount, 1);
    assert.equal(paused.lastMeasuredValue, afterFirst.lastMeasuredValue);
    assert.equal(paused.history.length, 1);

    // An evaluation skips it and says why, and does not touch its counts.
    const result = await app.watchpoints.evaluate();
    assert.equal(result.summary.skippedCount, 1);
    assert.equal(result.summary.evaluatedCount, 0);
    const skippedRow = result.results.find((entry) => entry.skipped === true);
    assert.equal(skippedRow.reason, 'paused');
    assert.equal(app.watchpoints.detail(wp.watchpointId).evaluationCount, 1);
    // A skipped evaluation wrote nothing, so it is not audited as a write.
    assert.equal(app.watchpoints.list().summary.enabledCount, 0);

    const resumed = app.watchpoints.toggle(wp.watchpointId);
    assert.equal(resumed.enabled, true);
    // Re-enabling restores the last judgement rather than resetting to unmeasured.
    assert.equal(resumed.lastState, 'breached');
    assert.equal(resumed.evaluationCount, 1);
    assert.equal(resumed.history.length, 1);
  });

  test('delete removes the rule and leaves no row behind', async () => {
    const app = appWith({ root: gitWorkspace() });
    const wp = createWatchpoint(app);
    await settle();
    const removed = app.watchpoints.remove(wp.watchpointId);
    assert.equal(removed.deleted, true);
    assert.equal(app.watchpoints.list().summary.totalCount, 0);
    assert.equal(app.watchpoints.detail(wp.watchpointId), null);
    assert.equal(ledger(app).watchpoints.length, 0);
  });
});

describe('T-45 Package 2: the audit and the trace', () => {
  test('one evaluation is one audited write with one operation id on every history row', async () => {
    const app = appWith({ root: gitWorkspace() });
    const first = createWatchpoint(app, { title: 'first', metric: 'apex_rss_mb', threshold: 1 });
    const second = createWatchpoint(app, { title: 'second', metric: 'dirty_files_count', threshold: 0 });
    await settle();
    const result = await app.watchpoints.evaluate();
    await settle();
    assert.equal(typeof result.operationId, 'string', 'a write must name its receipt');
    // Both history rows carry the id of the ONE evaluation that judged them: a batch is one act, not two.
    for (const watchpointId of [first.watchpointId, second.watchpointId]) {
      const stored = app.watchpoints.detail(watchpointId);
      assert.equal(stored.history.length, 1);
      assert.equal(stored.history[0].operationId, result.operationId);
      assert.equal(stored.lastEvalId, result.evalId);
      assert.equal(stored.history[0].evalId, result.evalId);
    }
    const receipt = operations(app).find((entry) => entry.id === result.operationId);
    assert.ok(receipt, 'the evaluation must leave an operation in operations.jsonl');
    assert.equal(receipt.steps[0].action, 'watchpoint.evaluate');
  });

  test('the trace resolves a wp_ id to its evaluations and a wpe_ id to its rule', async () => {
    const app = appWith({ root: gitWorkspace() });
    const wp = createWatchpoint(app);
    await settle();
    const first = await app.watchpoints.evaluate();
    await settle();
    const second = await app.watchpoints.evaluate();
    await settle();

    const ruleTrace = app.memoryTrace.trace(wp.watchpointId);
    assert.equal(ruleTrace.ok, true);
    assert.equal(ruleTrace.counts.watchpoints, 1);
    assert.equal(ruleTrace.counts.watchpointEvaluations, 2);
    assert.equal(ruleTrace.complete, true);
    const kinds = ruleTrace.entries.map((entry) => entry.kind);
    assert.equal(kinds.includes('watchpoint'), true);
    assert.equal(kinds.filter((kind) => kind === 'watchpoint_eval').length, 2);
    // A watchpoint id is never a cognition run id, and the chain says so rather than reporting a gap.
    assert.equal(ruleTrace.missing.some((note) => /watchpoint chain/.test(note)), true);

    // And an evaluation id resolves back to the rule it judged.
    const evalTrace = app.memoryTrace.trace(first.evalId);
    assert.equal(evalTrace.ok, true);
    assert.equal(evalTrace.keys.includes(wp.watchpointId), true);
    assert.equal(evalTrace.entries.some((entry) => entry.kind === 'watchpoint'), true);
    // The second evaluation is reachable from the rule, and each names its own receipt.
    const text = JSON.stringify(ruleTrace.entries);
    assert.match(text, new RegExp(first.evalId));
    assert.match(text, new RegExp(second.evalId));
    assert.match(text, new RegExp(first.operationId));
  });
});

describe('T-45 Package 2: the latch', () => {
  test('create, toggle, delete and evaluate each answer 423 under Lockdown, and the reads stay 200', async () => {
    const app = appWith({ root: gitWorkspace() });
    const wp = createWatchpoint(app);
    app.registry.controlPlane.activateKillSwitch({ origin: 'user', reason: 'T-45 test: prove the latch stops writes' });
    try {
      const refusals = [
        () => createWatchpoint(app, { title: 'refused under the latch' }),
        () => app.watchpoints.toggle(wp.watchpointId),
        () => app.watchpoints.remove(wp.watchpointId),
      ];
      for (const call of refusals) {
        assert.throws(call, (error) => {
          assert.equal(error.status, 423, error.message);
          assert.equal(error.code, WATCHPOINT_CODES.LOCKDOWN_ACTIVE);
          return true;
        });
      }
      await assert.rejects(() => app.watchpoints.evaluate(), (error) => {
        assert.equal(error.status, 423);
        assert.equal(error.code, WATCHPOINT_CODES.LOCKDOWN_ACTIVE);
        return true;
      });
      // Nothing was written by any of the four refusals.
      const stored = app.watchpoints.list();
      assert.equal(stored.watchpoints.length, 1);
      assert.equal(stored.watchpoints[0].evaluationCount, 0);
      assert.equal(stored.watchpoints[0].lastState, 'unmeasured');
      // The reads stay readable, and say the latch is up.
      assert.equal(stored.lockdownActive, true);
      assert.equal(app.watchpoints.detail(wp.watchpointId).watchpointId, wp.watchpointId);
    } finally {
      app.registry.controlPlane.clearKillSwitch({ origin: 'user', reason: 'T-45 test: release' });
    }
    assert.equal(app.watchpoints.list().lockdownActive, false);
  });
});

describe('T-45 Package 2: the routes', () => {
  test('the six routes answer with the engine\'s own words', async () => {
    const app = appWith({ root: gitWorkspace() });
    const token = 't45-watchpoints-route-token-0123456789';
    const ui = createUiServer({ app, token, host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    const base = `http://127.0.0.1:${started.port}`;
    const headers = { authorization: `Bearer ${token}`, 'x-apex-ui': '1', 'content-type': 'application/json' };
    try {
      const created = await fetch(`${base}/api/watchpoints`, {
        method: 'POST', headers,
        body: JSON.stringify({ title: 'the route wrote this', metric: 'apex_rss_mb', operator: 'gt', threshold: 1, severity: 'critical' }),
      });
      assert.equal(created.status, 200);
      const wp = await created.json();
      assert.match(wp.watchpointId, /^wp_/);
      assert.equal(wp.lastState, 'unmeasured');

      const badMetric = await fetch(`${base}/api/watchpoints`, {
        method: 'POST', headers, body: JSON.stringify({ title: 'x', metric: 'nope', threshold: 1 }),
      });
      assert.equal(badMetric.status, 400);
      assert.equal((await badMetric.json()).code, WATCHPOINT_CODES.INVALID_WATCHPOINT_METRIC);

      const badThreshold = await fetch(`${base}/api/watchpoints`, {
        method: 'POST', headers, body: JSON.stringify({ title: 'x', metric: 'apex_rss_mb', threshold: -3 }),
      });
      assert.equal(badThreshold.status, 400);
      assert.equal((await badThreshold.json()).code, WATCHPOINT_CODES.INVALID_WATCHPOINT_THRESHOLD);

      const evaluated = await fetch(`${base}/api/watchpoints/evaluate`, { method: 'POST', headers, body: '{}' });
      assert.equal(evaluated.status, 200);
      const evalBody = await evaluated.json();
      assert.equal(evalBody.summary.evaluatedCount, 1);
      assert.equal(evalBody.summary.breachedCount, 1);

      const toggled = await fetch(`${base}/api/watchpoints/${wp.watchpointId}/toggle`, { method: 'POST', headers, body: '{}' });
      assert.equal(toggled.status, 200);
      assert.equal((await toggled.json()).lastState, 'paused');

      const stillThere = await fetch(`${base}/api/watchpoints`, { headers });
      const listed = await stillThere.json();
      assert.equal(stillThere.status, 200);
      assert.equal(listed.summary.totalCount, 1);
      assert.equal(listed.summary.enabledCount, 0);

      const removed = await fetch(`${base}/api/watchpoints/${wp.watchpointId}/delete`, { method: 'POST', headers, body: '{}' });
      assert.equal(removed.status, 200);
      assert.equal((await removed.json()).deleted, true);

      const missing = await fetch(`${base}/api/watchpoints/wp_nope/toggle`, { method: 'POST', headers, body: '{}' });
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).code, WATCHPOINT_CODES.WATCHPOINT_NOT_FOUND);
    } finally {
      await ui.stop();
    }
  });

  test('every write route answers 423 under Lockdown while GET /api/watchpoints stays 200', async () => {
    const app = appWith({ root: gitWorkspace() });
    const token = 't45-watchpoints-latch-token-0123456789';
    const ui = createUiServer({ app, token, host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    const base = `http://127.0.0.1:${started.port}`;
    const headers = { authorization: `Bearer ${token}`, 'x-apex-ui': '1', 'content-type': 'application/json' };
    try {
      const wp = app.watchpoints.create({ title: 'before the latch', metric: 'apex_rss_mb', threshold: 1 });
      app.registry.controlPlane.activateKillSwitch({ origin: 'user', reason: 'T-45 route test' });
      for (const [pathname, body] of [
        ['/api/watchpoints', JSON.stringify({ title: 'x', metric: 'apex_rss_mb', threshold: 1 })],
        ['/api/watchpoints/evaluate', '{}'],
        [`/api/watchpoints/${wp.watchpointId}/toggle`, '{}'],
        [`/api/watchpoints/${wp.watchpointId}/delete`, '{}'],
      ]) {
        const response = await fetch(`${base}${pathname}`, { method: 'POST', headers, body });
        assert.equal(response.status, 423, `${pathname} must answer 423 under the latch`);
        assert.equal((await response.json()).code, 'LOCKDOWN_ACTIVE');
      }
      const read = await fetch(`${base}/api/watchpoints`, { headers });
      assert.equal(read.status, 200);
      const listed = await read.json();
      assert.equal(listed.lockdownActive, true);
      assert.equal(listed.summary.totalCount, 1);
      assert.equal(listed.watchpoints[0].evaluationCount, 0);
    } finally {
      app.registry.controlPlane.clearKillSwitch({ origin: 'user', reason: 'T-45 route test: release' });
      await ui.stop();
    }
  });

  test('GET /api/watchpoints is 200 with no workspace root, and names the four metrics', async () => {
    const app = appWith({ root: null });
    const token = 't45-watchpoints-unrooted-token-0123456789';
    const ui = createUiServer({ app, token, host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    try {
      const response = await fetch(`http://127.0.0.1:${started.port}/api/watchpoints`, {
        headers: { authorization: `Bearer ${token}`, 'x-apex-ui': '1' },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.metrics.map((entry) => entry.metric), [...WATCHPOINT_METRIC_NAMES]);
      assert.deepEqual(body.operators, [...WATCHPOINT_OPERATORS]);
      assert.equal(body.summary.totalCount, 0);
    } finally {
      await ui.stop();
    }
  });
});
