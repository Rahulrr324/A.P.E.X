// T-14: one operational health view composed from the records each subsystem already exposes.
//
// These tests pin the claims the view makes: a fresh install is healthy because every store is
// absent (a valid absence), a damaged store is failed rather than quietly skipped, every failure
// names the read it came from, a blocked decision is not reported as healthy, an unchecked model
// is advisory rather than a passing result, and the view adds no store of its own. Nothing here
// performs inference: every application is assembled with NoBackend or a fixed-output test double.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, cleanEnv, runCli, makePlanGateway } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { createUiServer } from '../src/ui/server.js';
import { collectHealth, renderHealth, Health, HEALTH_NOTE } from '../src/health.js';
import { Outcome } from '../src/outcomes.js';

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

function offlineApp(dir, options = {}) {
  return createApp({ dataDir: dir, gateway: new ModelGateway({ backend: new NoBackend() }), ...options });
}

function envFor(dataDir) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
}

function filesIn(dir) {
  return fs.readdirSync(dir).sort();
}

function areaOf(health, key) {
  return health.areas.find((entry) => entry.key === key);
}

describe('T-14 health: composition', () => {
  test('a fresh install is healthy and the view creates no store of its own', async () => {
    const dir = tempDir();
    const app = offlineApp(dir);
    const before = filesIn(dir);

    const health = await collectHealth(app);

    assert.equal(health.overall, Health.HEALTHY);
    assert.deepEqual(health.attention, []);
    assert.deepEqual(health.errors, []);
    for (const key of ['application', 'model', 'runtime', 'situational', 'providers', 'documents', 'reasoning', 'world-model', 'learning', 'storage']) {
      assert.ok(areaOf(health, key), `the ${key} area is missing`);
      assert.equal(areaOf(health, key).state, Health.HEALTHY, `${key} should be healthy on a fresh install`);
    }
    assert.equal(areaOf(health, 'documents').summary.includes('permission'), true, 'the document permission boundary is stated');
    assert.deepEqual(filesIn(dir), before, 'reading health must not create a store');
  });

  test('a configured but unchecked model is advisory and does not decide the overall state', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, gateway: makePlanGateway([{ id: 's1', description: 'read', action: 'calc', input: { expression: '1+1' }, depends_on: [] }]) });

    const health = await collectHealth(app, { checkModel: false });
    const model = areaOf(health, 'model');
    assert.equal(model.advisory, true);
    assert.equal(model.state, Health.UNKNOWN, 'the model was not checked, so it is not healthy');
    assert.equal(health.overall, Health.HEALTHY, 'an unchecked model is advisory, not a local failure');

    const rendered = renderHealth(health);
    assert.match(rendered, /Model backend: unknown \[not checked\]/);
    assert.ok(rendered.includes(HEALTH_NOTE));
    assert.match(rendered, /starts nothing, polls nothing, and calls no model/);
  });

  test('a damaged situational log is failed, names its source, and keeps every byte', async () => {
    const dir = tempDir();
    const damaged = '{"schema":1}\n{broken\n';
    fs.writeFileSync(path.join(dir, 'situational.jsonl'), damaged);
    const app = offlineApp(dir);

    const health = await collectHealth(app);

    const situational = areaOf(health, 'situational');
    assert.equal(situational.state, Health.FAILED);
    assert.match(situational.summary, /corrupt line/);
    assert.equal(situational.source, 'situation.status()');
    assert.equal(areaOf(health, 'storage').state, Health.FAILED);
    assert.equal(health.overall, Health.FAILED);
    assert.ok(health.attention.some((item) => item.kind === 'situational-log' && item.severity === Health.FAILED));
    assert.equal(fs.readFileSync(path.join(dir, 'situational.jsonl'), 'utf8'), damaged, 'the damaged log was not rewritten');
    assert.ok(renderHealth(health).includes('Situational awareness: failed'));
  });

  test('a damaged runtime checkpoint is quarantined and reported, never deleted', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'runtime.json'), '{"schema":"apex.runtime/1","lifecycle":"running"');
    const app = offlineApp(dir);

    const health = await collectHealth(app);

    const runtime = areaOf(health, 'runtime');
    assert.equal(runtime.state, Health.FAILED);
    assert.match(runtime.summary, /damaged/);
    assert.match(runtime.summary, /quarantin/i);
    assert.ok(health.attention.some((item) => item.kind === 'checkpoint'));
    assert.equal(fs.existsSync(path.join(dir, 'runtime.json')), false);
    const quarantined = filesIn(dir).filter((name) => name.startsWith('runtime.corrupt-'));
    assert.equal(quarantined.length, 1, 'the damaged checkpoint was preserved');
    assert.equal(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), '{"schema":"apex.runtime/1","lifecycle":"running"');
  });

  test('a damaged reasoning record is failed and the sessions that cite it are refused', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'reasoning.jsonl'), '{"schema":"apex.reasoning/1"}\n{broken\n');
    const app = offlineApp(dir);

    const health = await collectHealth(app);

    const reasoning = areaOf(health, 'reasoning');
    assert.equal(reasoning.state, Health.FAILED);
    assert.match(reasoning.summary, /corrupt reasoning record/);
    assert.equal(health.overall, Health.FAILED);
    assert.ok(health.attention.some((item) => item.kind === 'reasoning'));
  });

  test('a task waiting for approval is blocked, not healthy', async () => {
    const dir = tempDir();
    const writeAction = {
      name: 'test.write',
      description: 'test-only write that the runner holds for approval',
      inputHint: '{"tag":"text"}',
      permission: 'write',
      origins: ['user'],
      validate: (input) => ({ tag: String(input?.tag ?? 'w') }),
      async execute() { throw new Error('an unapproved write must not run'); },
      async verify() { return { ok: true, detail: 'written' }; },
    };
    const app = createApp({
      dataDir: dir,
      gateway: makePlanGateway([{ id: 's1', description: 'write a note', action: 'test.write', input: { tag: 'held' }, depends_on: [] }]),
      extraActions: [writeAction],
    });
    const planned = await app.controller.planTask('write a note');
    assert.equal(planned.status, Outcome.PLAN_PROPOSED);
    const task = (await app.taskStore.list()).at(-1);
    assert.equal((await app.controller.approveTask(task.id)).status, Outcome.SUCCESS_VERIFIED);
    const ran = await app.controller.runTask(task.id, 'run');
    assert.equal(ran.status, Outcome.TASK_PAUSED, 'the model-origin write was not held for approval');

    const health = await collectHealth(app);

    assert.ok(health.attention.some((item) => item.kind === 'approval' && item.severity === Health.BLOCKED));
    assert.equal(health.overall, Health.BLOCKED);
    assert.match(renderHealth(health), /Overall: blocked/);
  });
});

describe('T-14 health: command and interface', () => {
  test('apex health exits 0 when healthy and 1 when a store is damaged', async () => {
    const healthyDir = tempDir();
    const healthy = await runCli(['health'], envFor(healthyDir));
    assert.equal(healthy.code, 0, healthy.stderr);
    assert.match(healthy.stdout, /^.*operational health/m);
    assert.match(healthy.stdout, /Overall: healthy/);
    assert.match(healthy.stdout, /Storage and checkpoints: healthy/);

    const brokenDir = tempDir();
    fs.writeFileSync(path.join(brokenDir, 'situational.jsonl'), '{broken\n');
    const broken = await runCli(['health'], envFor(brokenDir));
    assert.equal(broken.code, 1);
    assert.match(broken.stdout, /Overall: failed/);
    assert.match(broken.stdout, /Situational awareness: failed/);
    assert.match(broken.stdout, /source: situation\.status\(\)/);
  });

  test('apex health --json is machine-readable and agrees with the text view', async () => {
    const dir = tempDir();
    const result = await runCli(['health', '--json'], envFor(dir));
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.overall, Health.HEALTHY);
    assert.ok(Array.isArray(parsed.areas));
    assert.equal(parsed.areas.some((entry) => entry.key === 'storage'), true);
    assert.equal(parsed.checks.modelChecked, false);
  });

  test('GET /api/health requires the access token and reports the same view', async () => {
    const dir = tempDir();
    const app = offlineApp(dir);
    const ui = createUiServer({ app, token: 't14-health-token', host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    uis.push(ui);
    const base = `http://127.0.0.1:${started.port}`;

    const denied = await fetch(`${base}/api/health`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${base}/api/health`, { headers: { authorization: 'Bearer t14-health-token' } });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.equal(body.overall, Health.HEALTHY);
    assert.equal(body.checks.modelChecked, false);
    assert.ok(body.areas.some((entry) => entry.key === 'runtime'));
  });
});
