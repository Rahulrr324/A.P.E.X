// T-30 Step 1 (2026-11-19): `/api/state` latency with fail-closed truth preserved.
//
// Part 4 requires <= 150 ms responsiveness. `/api/state` was measured at 167-204 ms during a
// page load, where the client issues sixteen reads at once and every endpoint re-derived the
// same records. `JsonlStore` now decides whether a read may reuse this instance's records from
// the file's own stat identity (dev/ino/size/mtimeNs/ctimeNs), so a duplicate read costs a stat
// instead of a file read plus parse, while any write - including another process's - changes the
// key and forces a full read.
//
// The correctness half of this file matters more than the timings: a cache that hides a
// cross-process approval, a lockdown latch or a damaged kill-switch would be a truth defect.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, cleanEnv, runCli } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { createUiServer } from '../src/ui/server.js';

const TOKEN = 'ui-latency-test-token-0123456789';
const LIMIT_WARM_MS = 100;
const LIMIT_COLD_MS = 150;
const dirs = [];
const uis = [];

afterEach(async () => {
  while (uis.length) await uis.pop().stop().catch(() => {});
  while (dirs.length) cleanup(dirs.pop());
});

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

async function seed(app) {
  for (let index = 0; index < 200; index += 1) {
    await app.memory.add({ content: `latency seed memory ${index} for project alpha-${index % 7}`, origin: 'user_supplied' });
  }
  for (let index = 0; index < 150; index += 1) {
    await app.taskStore.createTask({
      taskId: `latency-task-${index}`,
      goal: `latency seed task ${index}`,
      origin: 'model',
      planner: 'deterministic',
      steps: [{
        id: 'w1',
        description: 'store the seed note',
        action: 'memory.add',
        permission: 'write',
        input: { content: `latency task note ${index}` },
        dependsOn: [],
      }],
      reason: 'seeded for the latency test',
    });
  }
  // Fewer plans than the 50-record display bound, so a plan written after the seed is visible
  // inside the bounded projection rather than pushed out by older records.
  for (let index = 0; index < 20; index += 1) {
    await app.plans.createPlan({
      outcome: `latency seed plan ${index}`,
      steps: [{
        id: 's1',
        description: 'list the stored memory records',
        action: 'memory.list',
        input: {},
        dependsOn: [],
        expectedResult: 'the records are listed',
        verification: 'the listing matches the store',
        risk: 'low',
      }],
    });
  }
  for (let index = 0; index < 25; index += 1) {
    await app.controller.goalAdd({
      request: `latency seed goal ${index}`,
      criteria: [{ description: 'the seed goal is recorded', basis: 'user_stated' }],
      priority: 3,
    });
  }
}

async function uiOn(dir) {
  const app = createApp({ dataDir: dir, gateway: new ModelGateway({ backend: new NoBackend() }) });
  await seed(app);
  const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
  const started = await ui.start();
  uis.push(ui);
  return { app, ui, base: `http://127.0.0.1:${started.port}` };
}

async function readState(base) {
  const response = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' } });
  assert.equal(response.status, 200);
  return response.json();
}

async function timed(base) {
  const started = performance.now();
  const body = await readState(base);
  return { ms: performance.now() - started, body };
}

function p50(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// A second process on the same data directory writes the latch. Nothing about this read can be
// answered from another process's memory.
function flipLatchInAnotherProcess(dir, { release = false } = {}) {
  const script = `
    const { createApp } = await import(${JSON.stringify(new URL('../src/app.js', import.meta.url).href)});
    const { ModelGateway, NoBackend } = await import(${JSON.stringify(new URL('../src/model/gateway.js', import.meta.url).href)});
    const app = createApp({ dataDir: process.argv[1], gateway: new ModelGateway({ backend: new NoBackend() }) });
    const state = ${release
    ? "app.ecp.clearKillSwitch({ origin: 'user', reason: 'cross-process latency test release' })"
    : "app.ecp.activateKillSwitch({ origin: 'user', reason: 'cross-process latency test latch' })"};
    console.log(JSON.stringify({ active: state.active, policyUnavailable: state.policyUnavailable }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], {
    encoding: 'utf8',
    env: cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir }),
    timeout: 30000,
  });
  assert.equal(result.status, 0, `the latch process failed: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

describe('authoritative /api/state latency (T-30 Step 1)', () => {
  test('cold is under 150 ms, warm is under 100 ms, and a content-verified retained read is what makes warm cheap', async () => {
    const dir = tempDir();
    const { app, base } = await uiOn(dir);

    // Cold: the first request this server process answers, on a seeded workspace.
    const cold = await timed(base);
    assert.ok(cold.ms <= LIMIT_COLD_MS, `cold /api/state must be <= ${LIMIT_COLD_MS} ms, measured ${cold.ms.toFixed(1)} ms`);
    assert.equal(cold.body.tasks.length, 50, 'the projection is bounded by maxWorkItems regardless of the seed size');

    const warm = [];
    for (let index = 0; index < 12; index += 1) warm.push((await timed(base)).ms);
    const median = p50(warm);
    const slowest = Math.max(...warm);
    assert.ok(median <= LIMIT_WARM_MS, `warm median must be <= ${LIMIT_WARM_MS} ms, measured ${median.toFixed(1)} ms`);
    assert.ok(slowest <= LIMIT_WARM_MS, `every warm response must be <= ${LIMIT_WARM_MS} ms, slowest ${slowest.toFixed(1)} ms`);

    // The speed comes from a retained read whose bytes were verified by digest, and the stats are
    // observable rather than assumed.
    const stats = app.taskStore.log.readCacheStats;
    assert.equal(stats.enabled, true);
    assert.ok(stats.hits > 0, `repeated reads reuse the validated records (hits ${stats.hits}, misses ${stats.misses})`);
  });

  test('a page-load burst does not push /api/state past the cold limit', async () => {
    const dir = tempDir();
    const { base } = await uiOn(dir);
    const otherRoutes = ['/api/health', '/api/mission-control', '/api/approvals', '/api/timeline', '/api/situation',
      '/api/briefing', '/api/runtime', '/api/sources', '/api/documents', '/api/reasoning', '/api/council',
      '/api/workshop', '/api/resources', '/api/killswitch'];
    const headers = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' };
    const measured = [];
    for (let round = 0; round < 3; round += 1) {
      const started = performance.now();
      const [, state] = await Promise.all([
        Promise.all(otherRoutes.map((route) => fetch(`${base}${route}`, { headers }).then((r) => r.json()))),
        (async () => {
          const stateStarted = performance.now();
          const body = await (await fetch(`${base}/api/state`, { headers })).json();
          return { ms: performance.now() - stateStarted, body };
        })(),
      ]);
      measured.push(state.ms);
      assert.ok(state.body.tasks.length > 0, 'the contended read is still authoritative');
      assert.ok(performance.now() - started < 5000, 'the burst completes');
    }
    const worst = Math.max(...measured);
    assert.ok(worst <= LIMIT_COLD_MS, `contended /api/state must be <= ${LIMIT_COLD_MS} ms, worst ${worst.toFixed(1)} ms`);
  });

  test('a cross-process write is visible on the immediately following read', async () => {
    const dir = tempDir();
    const { app, base } = await uiOn(dir);
    await readState(base);
    const before = app.plans.log.readCacheStats;

    const step = JSON.stringify({
      id: 's1',
      description: 'store a known test statement',
      action: 'memory.add',
      input: { content: 'the latency test writes a plan in another process' },
      expectedResult: 'the statement is stored',
      verification: 'a read returns the stored statement',
      risk: 'low',
      dependsOn: [],
    });
    const created = await runCli([
      'plan', 'add', '--outcome', 'the cross-process plan is visible at once', '--step', step,
    ], cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir }));
    assert.equal(created.code, 0, created.stdout + created.stderr);
    const planId = /Plan\s+([A-Za-z0-9_-]+)/.exec(created.stdout)?.[1] ?? null;
    assert.ok(planId, `the CLI reported a plan id: ${created.stdout}`);

    const state = await readState(base);
    // The CLI prints the short form; the projection carries the full id it resolved to.
    assert.ok(state.plans.some((plan) => plan.id.startsWith(planId)), 'the new plan is present on the very next read');
    const after = app.plans.log.readCacheStats;
    assert.ok(after.misses > before.misses, 'the write changed the bytes, so the read was not served from the retained records');
  });

  test('a lockdown latch flipped by another process is visible at once and is never cached as clear', async () => {
    const dir = tempDir();
    const { base } = await uiOn(dir);
    const before = await readState(base);
    assert.equal(before.killSwitch.active, false);

    const activated = flipLatchInAnotherProcess(dir);
    assert.equal(activated.active, true);
    const afterLock = await readState(base);
    assert.equal(afterLock.killSwitch.active, true, 'the latch is authoritative on the next read');
    assert.equal(afterLock.killSwitch.policyUnavailable, false);

    const released = flipLatchInAnotherProcess(dir, { release: true });
    assert.equal(released.active, false);
    const afterRelease = await readState(base);
    assert.equal(afterRelease.killSwitch.active, false, 'the release is authoritative on the next read');
  });

  test('a damaged kill-switch file is reported as policy-unavailable at once, never as unlocked', async () => {
    const dir = tempDir();
    const { base } = await uiOn(dir);
    await readState(base);

    const latchPath = path.join(dir, 'kill-switch.json');
    fs.writeFileSync(latchPath, '{ this is not json', 'utf8');

    const state = await readState(base);
    assert.equal(state.killSwitch.policyUnavailable, true, 'an unreadable policy file fails closed');
    assert.equal(state.killSwitch.active !== undefined, true);
    assert.notEqual(state.killSwitch.active, false, 'damage is never reported as an unlocked latch');
  });
});
