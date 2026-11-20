// T-31 Step 1 (2026-11-19): the real-browser suite's browser-free half.
//
// The sandbox this repository is developed in has no browser binary, so the Playwright run cannot
// happen here — but everything that decides *whether* and *how* it runs can still be verified
// without one: the resolver's order and its explicit skip diagnostic, the fixture's seeded state
// (a real goal, task, pending approval, Sentinel observation, briefing and T-29 run), the restart
// that the degraded/reconnect check depends on, the screenshot naming, and the configuration that
// selects the suite. What is *not* verified here is anything a browser would do; the report says
// so explicitly.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  browserCandidates, findExecutable, isExecutable, noBrowserDiagnostic, resolveBrowser, BROWSER_BINARY_SCHEMA,
} from '../src/ui/browser-binary.js';
import { startSeededUi, restartUi, screenshotPath, readSurfaceFacts, T31_VIEWPORTS, T31_SCHEMA } from './e2e/t31-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');

describe('T-31 browser binary resolution', () => {
  test('an explicit setting is tried before discovery, and APEX_BROWSER_BIN before the older name', () => {
    const both = browserCandidates({ platform: 'linux', env: { APEX_BROWSER_BIN: '/opt/first', APEX_DESKTOP_BROWSER_BIN: '/opt/second' } });
    assert.equal(both[0].command, '/opt/first');
    assert.equal(both[0].label, 'APEX_BROWSER_BIN');
    assert.equal(both.some((entry) => entry.command === '/opt/second'), false, 'the older name is not used when the newer one is set');

    const legacy = browserCandidates({ platform: 'linux', env: { APEX_DESKTOP_BROWSER_BIN: '/opt/second' } });
    assert.equal(legacy[0].command, '/opt/second');
    assert.equal(legacy[0].label, 'APEX_DESKTOP_BROWSER_BIN');
  });

  test('Playwright\'s own browser is only offered when the file it names exists', () => {
    const present = browserCandidates({ platform: 'linux', env: {}, playwrightPath: '/playwright/chrome', exists: (value) => value === '/playwright/chrome' });
    assert.deepEqual(present.slice(0, 2).map((entry) => entry.id), ['playwright', 'msedge']);
    const absent = browserCandidates({ platform: 'linux', env: {}, playwrightPath: '/playwright/missing-chrome', exists: () => false });
    assert.equal(absent.some((entry) => entry.id === 'playwright'), false, 'a reported-but-absent Playwright path is not a candidate');
  });

  test('the system paths the hosted runner uses are candidates even when PATH is restricted', () => {
    const linux = browserCandidates({ platform: 'linux', env: { PATH: '' } });
    const commands = linux.map((entry) => entry.command);
    for (const expected of ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
      assert.ok(commands.includes(expected), `${expected} is a candidate`);
    }
    assert.equal(commands[0], 'microsoft-edge', 'the Edge-first discovery order is kept');
    assert.ok(commands.indexOf('microsoft-edge') < commands.indexOf('google-chrome'), 'Edge precedes Chrome');
    assert.ok(commands.indexOf('google-chrome') < commands.indexOf('chromium'), 'Chrome precedes Chromium');

    const win = browserCandidates({ platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files' } });
    assert.ok(win.some((entry) => /Microsoft\\Edge\\Application\\msedge\.exe$/.test(entry.command)), 'Windows Edge is a candidate');

    const mac = browserCandidates({ platform: 'darwin', env: {} });
    assert.ok(mac.some((entry) => entry.command === '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
  });

  test('resolution reports the plan it tried and never invents a path', () => {
    const tried = [];
    const found = resolveBrowser({
      platform: 'linux',
      env: {},
      candidates: [{ id: 'a', label: 'a', command: '/no/a' }, { id: 'b', label: 'b', command: '/no/b' }],
      executable: (command) => { tried.push(command); return command === '/no/b' ? '/no/b' : null; },
    });
    assert.equal(found.executable, '/no/b');
    assert.equal(found.source, 'system');
    assert.equal(found.schema, BROWSER_BINARY_SCHEMA);
    assert.deepEqual(found.tried, ['/no/a', '/no/b']);

    const none = resolveBrowser({ platform: 'linux', env: {}, candidates: [], executable: () => null });
    assert.equal(none.executable, null);
    assert.equal(none.source, null);
    assert.match(noBrowserDiagnostic(none), /no Chromium-family browser is installed/);
  });

  test('this host is reported honestly: either a real executable resolves, or the diagnostic says none did', () => {
    const resolution = resolveBrowser({ platform: process.platform, env: process.env });
    if (resolution.executable === null) {
      assert.match(noBrowserDiagnostic(resolution), /no real-browser check ran/);
    } else {
      assert.equal(fs.statSync(resolution.executable).isFile(), true, 'a resolved browser is a real file');
      assert.equal(isExecutable(resolution.executable, { platform: process.platform, env: process.env }), true);
      assert.equal(findExecutable(resolution.executable), resolution.executable);
    }
  });
});

describe('T-31 real-browser fixture', () => {
  let handle = null;
  before(async () => { handle = await startSeededUi(); });
  after(async () => { if (handle) await handle.stop(); });

  test('the seeded owner state is real backend data, including a pending approval and a T-29 run', async () => {
    assert.ok(handle.seed.goalId, 'a goal was recorded');
    assert.ok(handle.seed.memoryId, 'a memory record was recorded');
    assert.ok(handle.seed.sentinelEventId, 'a Sentinel observation was recorded');
    assert.match(handle.seed.cognitionRunId, /^cog-[a-z0-9]+$/, 'a cognition run was recorded');
    assert.equal(handle.seed.cognitionRunStatus, 'awaiting_approval', 'the gated run is awaiting the owner');
    assert.equal(handle.seed.taskStatus, 'paused', 'the TaskGraph task is paused at the gate');
    assert.ok(handle.seed.approvalId, 'the approval centre lists the task step');

    const facts = await readSurfaceFacts(handle);
    assert.equal(facts.state.status, 200);
    assert.equal(facts.state.body.app, 'APEX');
    assert.ok(facts.state.body.goals.length >= 1);
    assert.ok(facts.state.body.tasks.length >= 1);
    assert.ok(facts.state.body.tasks.some((task) => task.status === 'paused'), 'the paused task is in the owner snapshot');
    assert.equal(facts.approvals.status, 200);
    assert.ok(facts.approvals.body.items.length >= 1);
    assert.equal(facts.briefing.status, 200);
    assert.match(JSON.stringify(facts.briefing.body), /T-31 command deck/);
    assert.equal(facts.situation.status, 200);
    assert.ok(facts.situation.body.counts.events >= 1, 'the Sentinel counted the seeded observation');
    assert.equal(facts.autonomy.status, 200);
    assert.equal(facts.autonomy.body.readonly, true);
    assert.equal(facts.workshop.status, 200);
    assert.equal(facts.council.status, 200);
  });

  test('the gated run is readable through the cognition route, so the trace has a record to render', async () => {
    const response = await fetch(`${handle.base}/api/cognition/runs/${handle.seed.cognitionRunId}`, { headers: handle.headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    const record = body.run ?? body;
    assert.equal(record.runId, handle.seed.cognitionRunId);
    for (const stage of ['context', 'salience', 'council', 'task_graph', 'execution']) {
      assert.ok(record.stages?.[stage], `the run records the ${stage} stage`);
    }
  });

  test('a restart on the same port serves the same stores, which is what the reconnect check needs', async () => {
    const port = handle.port;
    const before = await readSurfaceFacts(handle);
    await handle.stopServer();
    const restarted = await restartUi(handle, { port });
    try {
      assert.equal(restarted.port, port, 'the restarted server listens on the same port');
      const afterFacts = await readSurfaceFacts(restarted);
      assert.equal(afterFacts.state.status, 200);
      assert.equal(afterFacts.state.body.goals.length, before.state.body.goals.length, 'no goal was seeded twice');
      assert.equal(afterFacts.state.body.tasks.length, before.state.body.tasks.length, 'no task was seeded twice');
      assert.equal(afterFacts.approvals.body.items.length, before.approvals.body.items.length, 'the pending approval survived');
    } finally {
      handle = restarted;
    }
  });
});

describe('T-31 browser suite wiring', () => {
  test('the screenshots are named per viewport under reports/screenshots', () => {
    const reportDir = path.join(appRoot, 'reports', 'screenshots');
    const names = T31_VIEWPORTS.map((viewport) => path.relative(appRoot, screenshotPath(reportDir, viewport)));
    assert.deepEqual(names, [
      path.join('reports', 'screenshots', 't31_desktop-wide_1600x900.png'),
      path.join('reports', 'screenshots', 't31_desktop_1280x720.png'),
      path.join('reports', 'screenshots', 't31_mobile_390x844.png'),
    ]);
    assert.equal(T31_SCHEMA, 'apex.t31.browser-run/1');
    assert.ok(fs.existsSync(reportDir), 'the screenshot directory exists, so a real run has somewhere to write');
    assert.ok(fs.existsSync(path.join(reportDir, 'README.md')), 'the directory explains what may appear in it');
  });

  test('the Playwright configuration runs the T-31, T-32 and T-33 suites and keeps the legacy spec out of the default run', () => {
    const config = fs.readFileSync(path.join(appRoot, 'playwright.config.mjs'), 'utf8');
    // T-32 Step 2 (2026-11-19): the HUD-experience suite joins the default run. Both suites drive a
    // real binary; neither is a simulation, and the legacy T-25 spec stays out because its
    // assertions predate the T-31 markup.
    // T-33 Step 4 (2026-11-19): the executive-loop walk joins them for the same reason, and it
    // writes its own summary so the workflow can state which checkpoints ran.
    assert.match(config, /testMatch: \['\*\*\/t31-real-browser\.spec\.mjs', '\*\*\/t32-hud-experience\.spec\.mjs', '\*\*\/t33-executive-loop\.spec\.mjs'\]/);
    assert.match(config, /testIgnore: \['\*\*\/apex-browser\.spec\.mjs'\]/);
    const spec = fs.readFileSync(path.join(appRoot, 'tests', 'e2e', 't31-real-browser.spec.mjs'), 'utf8');
    assert.match(spec, /chromium\.launch\(\{ executablePath: resolution\.executable, headless: true \}\)/);
    assert.match(spec, /test\.skip\(resolution\.executable === null, noBrowserDiagnostic\(resolution\)\)/);
    const hud = fs.readFileSync(path.join(appRoot, 'tests', 'e2e', 't32-hud-experience.spec.mjs'), 'utf8');
    assert.match(hud, /chromium\.launch\(\{ executablePath: resolution\.executable, headless: true \}\)/,
      'the HUD suite launches the resolved browser');
    assert.match(hud, /test\.skip\(resolution\.executable === null, noBrowserDiagnostic\(resolution\)\)/,
      'the HUD suite skips loudly when no browser exists');
    const loop = fs.readFileSync(path.join(appRoot, 'tests', 'e2e', 't33-executive-loop.spec.mjs'), 'utf8');
    assert.match(loop, /chromium\.launch\(\{ executablePath: resolution\.executable, headless: true \}\)/,
      'the executive-loop walk launches the resolved browser');
    assert.match(loop, /test\.skip\(resolution\.executable === null, noBrowserDiagnostic\(resolution\)\)/,
      'the walk skips loudly when no browser exists');
    // The walk has to say which checkpoints it reached, or a partial session could look like a pass.
    for (const checkpoint of ['dispatch', 'intent', 'suppression', 'graph', 'workshop']) {
      assert.ok(loop.includes(`step('${checkpoint}'`), `the walk records the ${checkpoint} checkpoint`);
    }
    assert.match(loop, /toHaveAttribute\('data-wit-allowed', 'false'/,
      'the walk asserts the wit rule in the browser, not only in the unit tests');
    assert.match(loop, /T33_LOOP_SUMMARY/, 'the walk prints a summary line the workflow reads');
    assert.match(hud, /data-depth-plane/, 'the HUD suite asserts the depth planes');
    assert.match(hud, /4\.5/, 'the HUD suite asserts the contrast floor');
    for (const viewport of T31_VIEWPORTS) {
      assert.match(spec, /T31_VIEWPORTS/, 'the spec iterates the shared viewport list');
      assert.ok(spec.includes('screenshotPath(reportDir, viewport)'), 'the spec writes one screenshot per viewport');
      assert.ok(viewport.width > 0 && viewport.height > 0);
    }
  });
});
