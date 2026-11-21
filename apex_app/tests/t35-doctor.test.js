// T-35 Step 3 (2026-11-19): `apex doctor`.
//
// The value of a doctor is in what it refuses to say. These tests check the six named checks, the
// 500 ms budget, and - most importantly - that a damaged store is reported as damaged, by name, with
// a non-zero exit code, and that a check with nothing to look at is never reported as a pass.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import { UI_CLIENT } from '../src/ui/assets.js';
import {
  DOCTOR_BUDGET_MS, DOCTOR_CHECKS, DOCTOR_SCHEMA, DOCTOR_STATES, createDoctor,
} from '../src/system/doctor.js';
import { createFakeBrowser, flushMicrotasks } from './helpers/fake-browser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const TOKEN = 't35-doctor-token-0123456789';
const HEADERS = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' };

const FAKE_BROWSER = () => ({
  schema: 'apex.browser.binary/1',
  browser: { id: 'fake', label: 'Fake Edge', command: '/usr/bin/fake-edge' },
  executable: '/usr/bin/fake-edge',
  source: 'system',
  tried: ['/usr/bin/fake-edge'],
});

function tempDir(prefix = 'apex-t35-doctor-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withDoctor(run, { appOptions = {}, browserLookup = FAKE_BROWSER } = {}) {
  const dir = tempDir();
  const app = createApp({ dataDir: dir, ...appOptions });
  try {
    const doctor = createDoctor({ app, dataDir: dir, browserLookup });
    return await run({ app, doctor, dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('T-35 the doctor runs six read-only checks', () => {
  test('the check list, the states and the budget are declared', () => {
    assert.deepEqual(DOCTOR_CHECKS, [
      'safety_latch', 'ecp_authority', 'stores_integrity', 'capability_inventory', 'browser_binary', 'workspace_sensor',
    ]);
    assert.deepEqual(DOCTOR_STATES, ['pass', 'degraded', 'failed', 'not_configured']);
    assert.equal(DOCTOR_BUDGET_MS, 500);
  });

  test('a healthy installation passes the checks it can make, and does not invent the rest', async () => {
    await withDoctor(async ({ doctor, dir }) => {
      // Something real for the store check to read.
      fs.writeFileSync(path.join(dir, 'stores-probe.jsonl'), '{"a":1}\n{"b":2}\n');
      const report = await doctor.run();
      assert.equal(report.schema, DOCTOR_SCHEMA);
      assert.equal(report.checks.length, 6);
      assert.deepEqual(report.checks.map((entry) => entry.name), DOCTOR_CHECKS);
      for (const entry of report.checks) {
        assert.ok(DOCTOR_STATES.includes(entry.state), `${entry.name} has a declared state`);
        assert.ok(entry.summary.length > 0, `${entry.name} states its evidence`);
        assert.equal(typeof entry.durationMs, 'number');
      }
      const byName = Object.fromEntries(report.checks.map((entry) => [entry.name, entry]));
      assert.equal(byName.safety_latch.state, 'pass');
      assert.equal(byName.ecp_authority.state, 'pass');
      assert.equal(byName.stores_integrity.state, 'pass');
      assert.match(byName.stores_integrity.summary, /2 line\(s\)/);
      assert.equal(byName.capability_inventory.state, 'pass');
      assert.match(byName.capability_inventory.summary, /0 orphans/);
      assert.equal(byName.browser_binary.state, 'pass');
      assert.match(byName.browser_binary.summary, /fake-edge/);
      // No workspace root is configured in this fixture, so the sensor check says exactly that.
      assert.equal(byName.workspace_sensor.state, 'not_configured');
      assert.match(byName.workspace_sensor.summary, /nothing is claimed about the tree/);
      assert.equal(report.counts.pass, 5);
      assert.equal(report.counts.notConfigured, 1);
      assert.equal(report.ok, true, 'not_configured does not make a run a failure');
      assert.equal(report.status, 'ok');
    });
  });

  test('the run is inside the budget, and says how long it took', async () => {
    await withDoctor(async ({ doctor }) => {
      const report = await doctor.run();
      assert.equal(report.withinBudget, true, `took ${report.durationMs} ms`);
      assert.ok(report.durationMs < DOCTOR_BUDGET_MS, `${report.durationMs} ms`);
      assert.equal(report.budgetMs, 500);
      assert.equal(report.at, new Date(report.at).toISOString());
    });
  });

  test('the doctor changes nothing: no store is written and the directory is the same afterwards', async () => {
    await withDoctor(async ({ app, doctor, dir }) => {
      fs.writeFileSync(path.join(dir, 'kept.jsonl'), '{"kept":true}\n');
      const before = fs.readdirSync(dir).sort();
      const beforeBytes = fs.readFileSync(path.join(dir, 'kept.jsonl'), 'utf8');
      await doctor.run();
      await doctor.run();
      assert.deepEqual(fs.readdirSync(dir).sort(), before, 'no file was created or removed');
      assert.equal(fs.readFileSync(path.join(dir, 'kept.jsonl'), 'utf8'), beforeBytes);
      assert.equal(app.ecp.killSwitchStatus().active, false);
    });
  });

  test('nothing is created for a data directory that does not exist yet', async () => {
    const dir = tempDir();
    const missing = path.join(dir, 'not-created-yet');
    const app = createApp({ dataDir: missing });
    try {
      const doctor = createDoctor({ app, dataDir: missing, browserLookup: FAKE_BROWSER });
      const report = await doctor.run();
      const stores = report.checks.find((entry) => entry.name === 'stores_integrity');
      assert.equal(stores.state, 'not_configured');
      assert.match(stores.summary, /does not exist yet/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T-35 a damaged store is reported as damaged, by name', () => {
  test('a line that does not parse fails the store check and names the file and line', async () => {
    await withDoctor(async ({ doctor, dir }) => {
      fs.writeFileSync(path.join(dir, 'good.jsonl'), '{"a":1}\n');
      fs.writeFileSync(path.join(dir, 'broken.jsonl'), '{"a":1}\n{not json\n');
      const report = await doctor.run();
      const stores = report.checks.find((entry) => entry.name === 'stores_integrity');
      assert.equal(stores.state, 'failed');
      assert.match(stores.summary, /broken\.jsonl line 2/);
      assert.equal(report.status, 'failed');
      assert.equal(report.ok, false);
      // `failing` lists everything that did not pass, including a check that had nothing to read.
      assert.ok(report.failing.some((entry) => entry.name === 'stores_integrity'));
      assert.equal(report.failing.find((entry) => entry.name === 'stores_integrity').state, 'failed');
    });
  });

  test('an unreadable store fails the check rather than being skipped', async () => {
    await withDoctor(async ({ doctor, dir }) => {
      const locked = path.join(dir, 'locked.jsonl');
      fs.writeFileSync(locked, '{"a":1}\n');
      fs.chmodSync(locked, 0o000);
      try {
        const report = await doctor.run();
        const stores = report.checks.find((entry) => entry.name === 'stores_integrity');
        // Running as root ignores the mode bits, so the honest expectation depends on the process.
        if (process.getuid && process.getuid() === 0) {
          assert.equal(stores.state, 'pass', 'root can read the file, so the check passes on what it read');
        } else {
          assert.equal(stores.state, 'failed');
          assert.match(stores.summary, /locked\.jsonl/);
        }
      } finally {
        fs.chmodSync(locked, 0o600);
      }
    });
  });

  test('a corrupt JSON store file fails the check', async () => {
    await withDoctor(async ({ doctor, dir }) => {
      fs.writeFileSync(path.join(dir, 'state.json'), '{"half":');
      const report = await doctor.run();
      const stores = report.checks.find((entry) => entry.name === 'stores_integrity');
      assert.equal(stores.state, 'failed');
      assert.match(stores.summary, /state\.json/);
    });
  });

  test('the CLI exits non-zero and names the failing check', async () => {
    const dir = tempDir();
    try {
      fs.writeFileSync(path.join(dir, 'broken.jsonl'), '{oops\n');
      const run = (argv) => {
        try {
          const stdout = execFileSync(process.execPath, [path.join(APP_ROOT, 'bin/apex.js'), ...argv], {
            cwd: APP_ROOT, encoding: 'utf8', env: { ...process.env, APEX_DATA_DIR: dir, APEX_ISOLATED: '1' }, stdio: 'pipe',
          });
          return { code: 0, stdout };
        } catch (error) {
          return { code: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
        }
      };
      const text = run(['doctor']);
      assert.equal(text.code, 1, text.stdout + text.stderr);
      assert.match(text.stdout, /FAILED/);
      assert.match(text.stdout, /stores_integrity/);
      assert.match(text.stdout, /broken\.jsonl line 1/);

      const json = run(['doctor', '--json']);
      assert.equal(json.code, 1);
      const report = JSON.parse(json.stdout);
      assert.equal(report.status, 'failed');
      assert.equal(report.schema, DOCTOR_SCHEMA);
      assert.equal(report.checks.find((entry) => entry.name === 'stores_integrity').state, 'failed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the CLI exit code is the report, and the JSON is the report', async () => {
    const dir = tempDir();
    try {
      let stdout = '';
      let code = 0;
      try {
        stdout = execFileSync(process.execPath, [path.join(APP_ROOT, 'bin/apex.js'), 'doctor', '--json'], {
          cwd: APP_ROOT, encoding: 'utf8', env: { ...process.env, APEX_DATA_DIR: dir, APEX_ISOLATED: '1' }, stdio: 'pipe',
        });
      } catch (error) {
        stdout = String(error.stdout ?? '');
        code = error.status;
      }
      const report = JSON.parse(stdout);
      assert.deepEqual(report.checks.map((entry) => entry.name), DOCTOR_CHECKS);
      // The store check has nothing to read in a fresh directory, and says so rather than passing.
      assert.equal(report.checks.find((entry) => entry.name === 'stores_integrity').state, 'not_configured');
      // On a host with no Chromium-family browser the run is degraded, so the exit code is 1. The
      // invariant is that the code agrees with the report rather than being fixed in advance.
      assert.equal(code, report.ok ? 0 : 1, `ok=${report.ok} exited ${code}`);
      assert.equal(report.ok, report.counts.failed === 0 && report.counts.degraded === 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T-35 the doctor reports the system it is actually looking at', () => {
  test('an engaged lockdown is named in the safety check', async () => {
    await withDoctor(async ({ app, doctor }) => {
      await app.controller.runAction('safety.lockdown', { reason: 'T-35 doctor check' }, 'user', 'op-doc-lock');
      const report = await doctor.run();
      const latch = report.checks.find((entry) => entry.name === 'safety_latch');
      assert.equal(latch.state, 'pass', 'the latch is readable and enforcing');
      assert.match(latch.summary, /lockdown engaged: T-35 doctor check/);
      assert.equal(latch.evidence.active, true);
    });
  });

  test('the capability inventory counts what the registry holds, and reports an orphan by name', async () => {
    await withDoctor(async ({ app, doctor }) => {
      const clean = await doctor.run();
      const inventory = clean.checks.find((entry) => entry.name === 'capability_inventory');
      assert.equal(inventory.state, 'pass');
      const total = app.registry.list().length;
      assert.equal(inventory.evidence.total, total);
      assert.equal(inventory.evidence.reads + inventory.evidence.writes, total);

      // A registry that advertises a capability it cannot resolve is an orphan, and it is named.
      const originalGet = app.registry.get.bind(app.registry);
      const originalList = app.registry.list.bind(app.registry);
      const real = originalList();
      app.registry.get = (name) => (name === 'memory.add' ? null : originalGet(name));
      app.registry.list = () => [...real, { ...real[0], name: 'memory.ghost' }];
      try {
        const report = await doctor.run();
        const broken = report.checks.find((entry) => entry.name === 'capability_inventory');
        assert.equal(broken.state, 'failed');
        assert.match(broken.summary, /orphan capability/);
        assert.match(broken.summary, /memory\.ghost/);
      } finally {
        app.registry.get = originalGet;
        app.registry.list = originalList;
      }
    });
  });

  test('the workspace sensor reads the git repository it was given', async () => {
    const workspace = tempDir('apex-t35-doctor-ws-');
    const dataDir = tempDir();
    try {
      fs.writeFileSync(path.join(workspace, 'README.md'), '# doctor\n');
      let gitRepo = true;
      try {
        const git = (args) => execFileSync('git', ['-C', workspace, '-c', 'user.email=t35@example.invalid',
          '-c', 'user.name=T35', ...args], { stdio: 'pipe' });
        git(['init', '-q', '-b', 'main']);
        git(['add', 'README.md']);
        git(['commit', '-q', '-m', 'doctor fixture']);
      } catch {
        gitRepo = false;
      }
      const app = createApp({ dataDir, filesystemRoot: workspace });
      const sensed = await app.controller.runAction('perception.sense_host', { reason: 'T-35 doctor' }, 'user', 'op-sense');
      assert.equal(sensed.outcome, 'success_verified', sensed.summary);
      const doctor = createDoctor({ app, dataDir, browserLookup: FAKE_BROWSER });
      const report = await doctor.run();
      const sensor = report.checks.find((entry) => entry.name === 'workspace_sensor');
      if (gitRepo) {
        assert.equal(sensor.state, 'pass', sensor.summary);
        assert.match(sensor.summary, /branch main at [0-9a-f]{7}/);
      } else {
        assert.equal(sensor.state, 'degraded');
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('a missing browser is degraded with the candidates it tried, never a pass', async () => {
    await withDoctor(async ({ doctor }) => {
      const report = await doctor.run();
      const browser = report.checks.find((entry) => entry.name === 'browser_binary');
      assert.equal(browser.state, 'degraded');
      assert.match(browser.summary, /no Chromium-family browser was found/);
      assert.ok(Array.isArray(browser.evidence.tried));
      assert.equal(report.ok, false, 'a degraded check keeps the run from claiming ok');
    }, { browserLookup: () => ({ schema: 'apex.browser.binary/1', browser: null, executable: null, source: null, tried: ['/opt/edge', '/usr/bin/google-chrome'] }) });
  });

  test('the route serves the same report the service produces', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    try {
      const base = `http://127.0.0.1:${started.port}`;
      const response = await fetch(`${base}/api/system/doctor`, { headers: HEADERS });
      assert.equal(response.status, 200);
      const report = await response.json();
      assert.equal(report.schema, DOCTOR_SCHEMA);
      assert.deepEqual(report.checks.map((entry) => entry.name), DOCTOR_CHECKS);
      assert.equal(typeof report.durationMs, 'number');
      const unauthorized = await fetch(`${base}/api/system/doctor`);
      assert.equal(unauthorized.status, 401, 'the doctor is not served without the token');
    } finally {
      await ui.stop().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T-35 the System workspace shows the doctor report as it stands', () => {
  const report = {
    schema: DOCTOR_SCHEMA,
    at: '2026-11-19T00:00:00.000Z',
    status: 'degraded',
    ok: false,
    counts: { pass: 4, degraded: 1, failed: 0, notConfigured: 1 },
    durationMs: 12.5,
    budgetMs: 500,
    withinBudget: true,
    checks: [
      { name: 'safety_latch', state: 'pass', summary: 'the latch is clear and enforced', durationMs: 0.1 },
      { name: 'ecp_authority', state: 'pass', summary: 'the ECP is the sole authority', durationMs: 0.2 },
      { name: 'stores_integrity', state: 'pass', summary: '3 store file(s), 9 line(s), every line parses', durationMs: 1.2 },
      { name: 'capability_inventory', state: 'pass', summary: '154 capabilities, 0 orphans', durationMs: 2.4 },
      { name: 'browser_binary', state: 'degraded', summary: 'no Chromium-family browser was found', durationMs: 0.3 },
      { name: 'workspace_sensor', state: 'not_configured', summary: 'no workspace root is configured', durationMs: 0.1 },
    ],
    failing: [{ name: 'browser_binary', state: 'degraded', summary: 'no Chromium-family browser was found' }],
  };

  test('each check is listed with its own state, and the total names the degraded one', async () => {
    const routes = new Map([
      ['/api/state', { session: { id: 'session-t35', status: 'ok' }, turns: [], tasks: [], plans: [], goals: [], autonomy: { configured: {} }, resources: {} }],
      ['/api/killswitch', { active: false, policyUnavailable: false, persistence: 'durable' }],
      ['/api/health', { overall: 'healthy', areas: [] }],
      ['/api/system/doctor', report],
    ]);
    const browser = createFakeBrowser({ routes });
    const context = vm.createContext(browser.sandbox, { name: 'apex-ui-client-t35-doctor' });
    vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
    const source = browser.events.sources.at(-1);
    source.open();
    source.emit('reconcile', {
      schema: 'apex.state-event/1', streamId: 'e'.repeat(32), seq: 2, at: '2026-11-19T00:00:00.000Z',
      type: 'reconcile', versions: {}, payload: { reason: 'initial', snapshotUrl: '/api/state', owners: {} },
      correlationId: null,
    }, { lastEventId: `${'e'.repeat(32)}:2` });
    await flushMicrotasks();

    browser.getElement('doctor-run').click();
    for (let index = 0; index < 6; index += 1) await flushMicrotasks();

    const status = browser.getElement('doctor-status');
    assert.match(status.textContent, /DEGRADED/);
    assert.match(status.textContent, /4 pass, 1 degraded, 0 failed, 1 not configured/);
    assert.match(status.textContent, /12.5 ms of a 500 ms budget/);
    assert.equal(status.dataset.state, 'degraded');

    const listed = browser.getElement('doctor-checks').children.filter((child) => child.dataset && child.dataset.check);
    assert.equal(listed.length, 6);
    assert.deepEqual(listed.map((child) => child.dataset.checkState),
      ['pass', 'pass', 'pass', 'pass', 'degraded', 'not_configured']);
    const browserRow = listed.find((child) => child.dataset.check === 'browser_binary');
    const rows = browserRow.children.flatMap((child) => [child.textContent, ...(child.children ?? []).map((inner) => inner.textContent)]);
    assert.match(rows.join(' '), /no Chromium-family browser/);
    const sensorRow = listed.find((child) => child.dataset.check === 'workspace_sensor');
    assert.equal(sensorRow.dataset.checkState, 'not_configured', 'a check with nothing to read is not shown as a pass');
    assert.deepEqual(browser.events.pageErrors, []);
  });

  // The hosted walk caught this: opening System takes a reading, and pressing Run again while that
  // reading was still landing left the panel saying "Running..." over six checks it had already
  // listed. A re-run now keeps the last measured line on screen until it has a new one.
  test('a second run keeps the measured line on screen instead of replacing it with a status', async () => {
    const routes = new Map([
      ['/api/state', { session: { id: 'session-t35', status: 'ok' }, turns: [], tasks: [], plans: [], goals: [], autonomy: { configured: {} }, resources: {} }],
      ['/api/killswitch', { active: false, policyUnavailable: false, persistence: 'durable' }],
      ['/api/health', { overall: 'healthy', areas: [] }],
      ['/api/system/doctor', report],
    ]);
    const browser = createFakeBrowser({ routes });
    const context = vm.createContext(browser.sandbox, { name: 'apex-ui-client-t35-doctor-rerun' });
    vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
    const source = browser.events.sources.at(-1);
    source.open();
    source.emit('reconcile', {
      schema: 'apex.state-event/1', streamId: 'f'.repeat(32), seq: 2, at: '2026-11-19T00:00:00.000Z',
      type: 'reconcile', versions: {}, payload: { reason: 'initial', snapshotUrl: '/api/state', owners: {} },
      correlationId: null,
    }, { lastEventId: `${'f'.repeat(32)}:2` });
    await flushMicrotasks();

    const status = browser.getElement('doctor-status');
    browser.getElement('doctor-run').click();
    for (let index = 0; index < 6; index += 1) await flushMicrotasks();
    const measured = status.textContent;
    assert.match(measured, /12.5 ms of a 500 ms budget/);

    browser.getElement('doctor-run').click();
    const duringRerun = status.textContent;
    assert.match(duringRerun, /ms of a 500 ms budget/,
      'the re-run reads over the last measurement rather than hiding it behind "Running..."');
    for (let index = 0; index < 6; index += 1) await flushMicrotasks();
    assert.match(status.textContent, /12.5 ms of a 500 ms budget/);
    assert.deepEqual(browser.events.pageErrors, []);
  });
});
