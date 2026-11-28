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
    // T-34 Step 4 (2026-11-19): the mission-DAG walk joins them. It drives a fan-out/fan-in mission
    // through its gates and writes its own summary, so the workflow can state what it reached.
    // T-35 Step 4 (2026-11-19): the step-down / handoff / doctor walk joins the default run, and the
    // assertion below names it so a spec that is written but never wired is a red test.
    // T-36 Step 4 (2026-11-21): the cold-boot walk joins too, and the assertion names it for the
    // same reason: a spec that exists but is never wired is a red test, not a green one.
    // T-37 Step 4 (2026-11-21): the neural/Council/router walk joins the same list. It is the only
    // suite that reads all eleven screen declarations and all eight substrate regions out of a live
    // DOM, so it is wired here like the rest rather than living as a spec nothing runs.
    // T-38 Step 4 (2026-11-21): the values/workspace/trace walk joins too. It is the only suite that
    // drives the file-backed Workshop from the browser and recomputes the digests it renders from
    // the files on disk, so it is named here for the same reason as the rest: a spec that exists but
    // is never wired is a red test, not a green one.
    // T-41 Step 4 (2026-11-22): the sandbox-test and evolution-bridge walk joins the list. It is the
    // only suite that runs a real `node --test` child against a staged candidate and then follows the
    // result into the causal trace, so it is wired here like the rest.
    // T-43 Step 4 (2026-11-19): the workstation / git executive / telemetry walk joins the list. It is
    // the only suite whose workspace is a real git repository - so its counts are checked against the
    // system git binary as well as against the product - and the only one that measures the host's
    // listening ports and finds its own server among them. Twelve specs; the list is pinned here so a
    // suite that is written but never wired stays a red test.
    // T-44 Step 4 (2026-11-19): the standing-orders and agenda walk joins the list. It is the only
    // suite that drives a governed delegation from the panel through the ECP and reads the receipt back
    // out of the ledger, the only one that moves the Lockdown latch and proves release fires nothing,
    // and the only one that reads a commitment's horizon beside the derived rows the stores already
    // hold. Thirteen specs.
    // T-45 Step 4 (2026-11-19): the playbook / watchpoint / overlay walk joins the list. It is the only
    // suite that launches a three-step routine from a card and checks all three receipts against the one
    // operations ledger, the only one that judges a threshold against a number the running process really
    // reports (`apex_rss_mb`), and the only one that measures contrast and overflow in TWO postures of the
    // same deck, because the compact posture hides elements and a hidden element cannot be measured.
    // Fourteen specs.
    // T-46 STEP 0 (2026-11-19): the experience walk joins the list. It is the only suite that measures
    // the deck as a LAYOUT rather than as a set of correct surfaces: the height of the header, the
    // centre of the Core against the viewport's centre, the document's own scroll height, and whether
    // the command bar is on screen without scrolling. Its gates are numbers in `T46_GATES`, and the
    // first run of it records the baseline those gates are then measured against. Fifteen specs.
    assert.match(config, /testMatch: \['\*\*\/t31-real-browser\.spec\.mjs', '\*\*\/t32-hud-experience\.spec\.mjs', '\*\*\/t33-executive-loop\.spec\.mjs', '\*\*\/t34-mission-dag-and-briefing\.spec\.mjs', '\*\*\/t35-stepdown-handoff-doctor\.spec\.mjs', '\*\*\/t36-cold-boot-unseeded\.spec\.mjs', '\*\*\/t37-neural-council-router\.spec\.mjs', '\*\*\/t38-values-workspace-trace\.spec\.mjs', '\*\*\/t39-workshop-apply-rollback\.spec\.mjs', '\*\*\/t40-changeset-drift-command-help\.spec\.mjs', '\*\*\/t41-sandbox-test-and-evolution-bridge\.spec\.mjs', '\*\*\/t43-workstation-git-telemetry\.spec\.mjs', '\*\*\/t44-standing-orders-agenda\.spec\.mjs', '\*\*\/t45-playbooks-watchpoints-overlay\.spec\.mjs', '\*\*\/t46-experience\.spec\.mjs'\]/);
    assert.match(config, /testIgnore: \['\*\*\/apex-browser\.spec\.mjs'\]/);
    const spec = fs.readFileSync(path.join(appRoot, 'tests', 'e2e', 't31-real-browser.spec.mjs'), 'utf8');
    assert.match(spec, /chromium\.launch\(\{ executablePath: resolution\.executable, headless: true \}\)/);
    assert.match(spec, /test\.skip\(resolution\.executable === null, noBrowserDiagnostic\(resolution\)\)/);
    const hud = fs.readFileSync(path.join(appRoot, 'tests', 'e2e', 't32-hud-experience.spec.mjs'), 'utf8');
    assert.match(hud, /chromium\.launch\(\{ executablePath: resolution\.executable, headless: true \}\)/,
      'the HUD suite launches the resolved browser');
    assert.match(hud, /test\.skip\(resolution\.executable === null, noBrowserDiagnostic\(resolution\)\)/,
      'the HUD suite skips loudly when no browser exists');
    const mission = fs.readFileSync(path.join(appRoot, 'tests', 'e2e', 't34-mission-dag-and-briefing.spec.mjs'), 'utf8');
    assert.match(mission, /chromium\.launch\(\{ executablePath: resolution\.executable, headless: true \}\)/,
      'the mission-DAG walk launches the resolved browser');
    assert.match(mission, /test\.skip\(resolution\.executable === null, noBrowserDiagnostic\(resolution\)\)/,
      'the mission-DAG walk skips loudly when no browser exists');
    assert.match(mission, /T34_FAILURES/, 'the mission-DAG walk prints a short failure line first');
    const stepdown = fs.readFileSync(path.join(appRoot, 'tests', 'e2e', 't35-stepdown-handoff-doctor.spec.mjs'), 'utf8');
    assert.match(stepdown, /chromium\.launch\(\{ executablePath: resolution\.executable, headless: true \}\)/,
      'the T-35 walk launches the resolved browser');
    assert.match(stepdown, /test\.skip\(resolution\.executable === null, noBrowserDiagnostic\(resolution\)\)/,
      'the T-35 walk skips loudly when no browser exists');
    assert.match(stepdown, /T35_FAILURES/, 'the T-35 walk prints a short failure line first');
    assert.match(stepdown, /page\.goto\(`\$\{handle\.base\}\/\?token=\$\{encodeURIComponent\(handle\.token\)\}`/,
      'the T-35 walk authorizes the page it opens');
    // T-36 Step 4 (2026-11-21): the cold-boot walk is the only one that asserts its own starting
    // point, so these three are what keep it honest: it must launch the resolved browser, skip
    // loudly when there is none, and record a failure and its last checkpoint in its summary.
    const coldBoot = fs.readFileSync(path.join(appRoot, 'tests', 'e2e', 't36-cold-boot-unseeded.spec.mjs'), 'utf8');
    assert.match(coldBoot, /chromium\.launch\(\{ executablePath: resolution\.executable, headless: true \}\)/,
      'the cold-boot walk launches the resolved browser');
    assert.match(coldBoot, /test\.skip\(resolution\.executable === null, noBrowserDiagnostic\(resolution\)\)/,
      'the cold-boot walk skips loudly when no browser exists');
    assert.match(coldBoot, /T36_FAILURES/, 'the cold-boot walk prints a short failure line first');
    assert.match(coldBoot, /run\.failures\.push\(/, 'the cold-boot walk records a failure in its summary');
    assert.match(coldBoot, /page\.goto\(`\$\{handle\.base\}\/\?token=\$\{encodeURIComponent\(handle\.token\)\}`/,
      'the cold-boot walk authorizes the page it opens');
    assert.match(coldBoot, /#hud-boot-sequence/, 'the cold-boot walk checks the boot overlay the deck ships');
    // T-37 Step 4 (2026-11-21): the same three obligations, and one extra that only this walk has -
    // it must not ship a screen that violates the deck's own Content-Security-Policy, because the
    // shipped policy blocks inline styles and a single style attribute fails every browser suite.
    const t37 = fs.readFileSync(path.join(appRoot, 'tests', 'e2e', 't37-neural-council-router.spec.mjs'), 'utf8');
    assert.match(t37, /chromium\.launch\(\{ executablePath: resolution\.executable, headless: true \}\)/,
      'the T-37 walk launches the resolved browser');
    assert.match(t37, /test\.skip\(!resolution\.executable, noBrowserDiagnostic\(resolution\)\)/,
      'the T-37 walk skips loudly when no browser exists');
    assert.match(t37, /page\.goto\(`\$\{fixture\.base\}\/\?token=\$\{encodeURIComponent\(fixture\.token\)\}`/,
      'the T-37 walk authorizes the page it opens');
    for (const screen of ['boot', 'command-deck', 'mission-view', 'briefing', 'workshop', 'memory-timeline',
      'council', 'presence-mesh', 'sentinel', 'policy-autonomy', 'lockdown']) {
      const fixture = fs.readFileSync(path.join(appRoot, 'tests', 'e2e', 't37-fixtures.mjs'), 'utf8');
      assert.ok(fixture.includes(`'${screen}'`), `the T-37 fixture names the ${screen} screen`);
    }
    const t36Fixture = fs.readFileSync(path.join(appRoot, 'tests', 'e2e', 't36-fixtures.mjs'), 'utf8');
    // The fixture must not seed: no task creation, no enrollment, no perception run before the walk.
    for (const forbidden of ['createTask(', 'deviceTrust.enroll(', 'perception.sense_host']) {
      assert.ok(!t36Fixture.includes(forbidden), `the T-36 fixture must not seed ${forbidden} before the cold boot`);
    }
    // The page itself is authorized with the same token the routes use. A walk that navigates to the
    // bare base gets the server's refusal page and no #core-state, which is a failure with no cause.
    assert.match(mission, /page\.goto\(`\$\{handle\.base\}\/\?token=\$\{encodeURIComponent\(handle\.token\)\}`/,
      'the mission-DAG walk authorizes the page it opens');
    const loop = fs.readFileSync(path.join(appRoot, 'tests', 'e2e', 't33-executive-loop.spec.mjs'), 'utf8');
    // A red browser run is diagnosed from its own summary, so a failure has to reach it: both walks
    // record the last checkpoint and the error before rethrowing, and print the short line first.
    for (const [name, spec] of [['the mission-DAG walk', mission], ['the executive-loop walk', loop]]) {
      assert.match(spec, /run\.failures\.push\(/, `${name} records a failure in its summary`);
      assert.match(spec, /checkpoint: run\.steps\.at\(-1\)\?\.id \?\? null/, `${name} names the last checkpoint it reached`);
    }
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
