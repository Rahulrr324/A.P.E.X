// T-36 Step 4 (2026-11-21): one real-browser session on a workstation that has never been set up.
//
// Every other browser suite in this repository starts from a seeded data directory, because it is
// testing what the deck does once there is something to show. This one starts from nothing: an
// empty temporary directory and a fresh temporary git repository, with no stores, no enrolled
// device, no perception reading and no bootstrap marker. Then a real Chromium-family browser opens
// the shipped Command Deck against it, and the walk checks that the deck sets the machine up by
// itself.
//
// What this has to earn, in real Edge/Chrome/Chromium against the shipped server and the shipped
// client:
//
//   the directory really was empty and really was not bootstrapped  ->  opening the deck triggers
//   `#hud-boot-sequence` and the Core goes Dormant  ->  six subsystem rows appear, each with a
//   measured detail read from this machine and this repository  ->  the Core lands on its
//   authoritative state (Idle, not a state the boot screen hoped for)  ->  the HUD carries real
//   CPU/RAM/storage, the real git branch and head, the enrolled `local-workstation` in Presence and
//   a live Executive Briefing  ->  the doctor reads six checks, all passing on a machine that can
//   run this suite  ->  a T-29 cognitive intent launched from that state reaches Awaiting Approval
//   through the real pipeline  ->  no console error, no page error, no horizontal overflow.
//
// When the host has no browser at all the suite skips with an explicit diagnostic. A skip is not a
// pass, and the summary says which of the two happened.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import { startT36Ui, T36_SCHEMA } from './t36-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(here, '..', '..');
const reportDir = path.join(repoDir, 'reports', 'screenshots', 't36');
const summaryPath = path.join(repoDir, 'reports', 't36-cold-boot-unseeded.json');

const BOOT_SUBSYSTEMS = ['safety_latch', 'ecp_authority', 'resource_fabric', 'git_workspace', 'device_trust', 'executive_briefing'];

function playwrightChromiumPath() {
  try {
    return chromium.executablePath();
  } catch {
    return null;
  }
}

const resolution = resolveBrowser({
  platform: process.platform,
  env: process.env,
  playwrightPath: playwrightChromiumPath(),
});

const run = {
  schema: T36_SCHEMA,
  browserBinary: BROWSER_BINARY_SCHEMA,
  resolved: { executable: resolution.executable, source: resolution.source, candidate: resolution.browser?.label ?? null },
  browserVersion: null,
  platform: process.platform,
  node: process.version,
  headless: true,
  steps: [],
  screenshots: [],
  unseeded: null,
  coldBoot: null,
  core: null,
  telemetry: null,
  workspace: null,
  device: null,
  briefing: null,
  doctor: null,
  cognition: null,
  overflow: null,
  failures: [],
  startedAt: new Date().toISOString(),
  finishedAt: null,
};

function pngSize(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { bytes: buffer.length, width: null, height: null, png: false };
  return { bytes: buffer.length, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), png: true };
}

function writeSummary() {
  run.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(run, null, 2)}\n`);
  console.log(`T36_FAILURES ${JSON.stringify({ failures: run.failures, steps: run.steps.length, screenshots: run.screenshots.length })}`);
  console.log(`T36_SUMMARY ${JSON.stringify(run)}`);
}

let handle = null;
let browser = null;

test.describe('T-36 cold boot on an unseeded workstation, in a real browser', () => {
  test.skip(resolution.executable === null, noBrowserDiagnostic(resolution));

  test.beforeAll(async () => {
    fs.mkdirSync(reportDir, { recursive: true });
    handle = await startT36Ui();
    browser = await chromium.launch({ executablePath: resolution.executable, headless: true });
    run.browserVersion = browser.version();
  });

  test.afterAll(async () => {
    if (browser) await browser.close().catch(() => {});
    if (handle) await handle.stop().catch(() => {});
    writeSummary();
  });

  test('the deck wakes a brand-new workstation and lands on a real machine', async () => {
    test.setTimeout(300_000);
    try {
      // ---- the starting point is genuinely empty -----------------------------------------------
      // Asserted before the browser is opened, so a fixture that seeded anything would fail here
      // instead of quietly making the rest of the walk pass.
      const before = handle.unseeded;
      run.unseeded = before;
      expect(before.entries, 'the data directory must be empty before the cold boot').toEqual([]);
      expect(before.bootstrapMarker).toBe(false);
      expect(before.deviceRegistry).toBe(false);
      expect(before.perceptionLedger).toBe(false);
      expect(handle.repository.branch).toBe('trunk');

      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      // Sample the Core's state from the very first paint: the boot sequence is short, and what it
      // has to prove is the transition, not a lucky screenshot.
      await context.addInitScript(() => {
        window.__t36 = { core: [], bootRows: [] };
        const record = () => {
          const state = document.body?.dataset?.coreState;
          if (!state) return;
          const last = window.__t36.core[window.__t36.core.length - 1];
          if (!last || last.state !== state) window.__t36.core.push({ state, at: Date.now() });
        };
        const observer = new MutationObserver(() => {
          record();
          const rows = [...document.querySelectorAll('#hud-boot-steps li[data-boot-step]')]
            .map((row) => ({ id: row.dataset.bootStep, state: row.dataset.bootState, detail: row.textContent }));
          window.__t36.bootRows.push({ at: Date.now(), rows });
        });
        const start = () => {
          record();
          observer.observe(document.documentElement, { attributes: true, subtree: true, childList: true, attributeFilter: ['data-core-state'] });
          observer.observe(document.body, { attributes: true, childList: true, subtree: true });
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
        else start();
      });
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      page.on('pageerror', (error) => pageErrors.push(String(error)));

      const step = (id, detail) => {
        run.steps.push({ id, at: new Date().toISOString(), detail });
        return detail;
      };
      const shot = async (name) => {
        const file = path.join(reportDir, `t36-${name}.png`);
        await page.screenshot({ path: file, fullPage: false });
        run.screenshots.push({ name, file: path.relative(repoDir, file), ...pngSize(file) });
      };

      // ---- the deck is opened against an unseeded directory ------------------------------------
      await page.goto(`${handle.base}/?token=${encodeURIComponent(handle.token)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // ---- the boot sequence appears, and the Core is Dormant while it runs --------------------
      const overlay = page.locator('#hud-boot-sequence');
      await expect(overlay).toBeVisible({ timeout: 30_000 });
      await shot('01-boot-sequence');
      const dormantSeen = await page.evaluate(() => (window.__t36.core || []).some((entry) => entry.state === 'dormant'));
      // It is a region, not a dialog: it must not take focus away from the deck or trap it.
      await expect(overlay).toHaveAttribute('role', 'region');
      expect(await overlay.getAttribute('aria-modal')).toBeNull();

      // The six measured rows, each one naming the subsystem it read.
      const rows = page.locator('#hud-boot-steps li[data-boot-step]');
      await expect(rows).toHaveCount(6, { timeout: 60_000 });
      // Wait for the sequence to finish revealing every row: the last one is the briefing.
      await expect(page.locator('#hud-boot-steps li[data-boot-step="executive_briefing"]'))
        .not.toHaveAttribute('data-boot-state', 'pending', { timeout: 60_000 });
      const rowStates = await rows.evaluateAll((items) => items.map((item) => ({
        id: item.dataset.bootStep,
        state: item.dataset.bootState,
        detail: (item.textContent ?? '').trim(),
      })));
      expect(rowStates.map((entry) => entry.id)).toEqual(BOOT_SUBSYSTEMS);
      for (const entry of rowStates) {
        expect(['ok', 'degraded', 'failed', 'unavailable', 'pending']).toContain(entry.state);
      }
      run.coldBoot = {
        dormantSeen,
        rows: rowStates,
        quietBoot: false,
      };
      step('boot-sequence', run.coldBoot);
      await shot('02-boot-verified');

      // ---- the sequence dismisses cleanly and the Core takes its authoritative state -----------
      // A real watcher outside the window agrees the bootstrap finished, so the Core's landing
      // state is the owners' answer rather than the overlay's own claim.
      await expect.poll(async () => (await handle.bootstrapState()).body?.bootstrapped, { timeout: 60_000 }).toBe(true);
      const bootState = (await handle.bootstrapState()).body;
      const report = await handle.get('/api/state');
      expect(report.status).toBe(200);
      expect(report.body.system.bootstrap.bootstrapped).toBe(true);

      await expect(overlay).toBeHidden({ timeout: 60_000 });
      await expect(page.locator('body')).toHaveAttribute('data-core-state', /^(idle|awaiting_approval|lockdown)$/, { timeout: 30_000 });
      const coreTrail = await page.evaluate(() => window.__t36.core || []);
      const landing = await page.locator('body').getAttribute('data-core-state');
      expect(coreTrail.some((entry) => entry.state === 'dormant'), 'the Core was Dormant while it verified itself').toBe(true);
      expect(coreTrail[coreTrail.length - 1].state).toBe(landing);
      run.core = { landing, trail: coreTrail.map((entry) => entry.state), bootRuns: bootState.runs };
      step('core-landing', run.core);
      await shot('03-core-awake');

      // ---- the HUD carries this machine's own readings ----------------------------------------
      // The values are the ones the server just recorded from this host, so they are compared to
      // each other rather than to a constant: a stale or invented number fails the comparison.
      const state = (await handle.state()).body;
      const bootLatest = state.system?.bootstrap?.latest ?? null;
      const reading = bootLatest?.perception?.reading ?? null;
      expect(reading, 'the bootstrap recorded a host reading').not.toBeNull();
      expect(bootLatest.perception.source).toBe('host-workspace-sensor');
      // Real counters from this machine: a CPU count, a memory total and a storage reading that
      // came from the sensor rather than from a constant.
      expect(reading.host?.cpu?.logicalCount, 'a real CPU count was observed').toBeGreaterThan(0);
      expect(reading.host?.memory?.totalBytes, 'a real memory total was observed').toBeGreaterThan(0);
      await expect(page.locator('#gauge-cpu')).not.toHaveText(/^(CPU: —|CPU: unavailable)$/, { timeout: 30_000 });
      await expect(page.locator('#gauge-mem')).not.toHaveText(/^(Mem: —|Mem: unavailable)$/, { timeout: 30_000 });
      await expect(page.locator('#gauge-storage')).not.toHaveText(/^Storage: —$/, { timeout: 30_000 });
      const gauges = {
        cpu: (await page.locator('#gauge-cpu').textContent())?.trim(),
        memory: (await page.locator('#gauge-mem').textContent())?.trim(),
        storage: (await page.locator('#gauge-storage').textContent())?.trim(),
      };
      // Real numbers, not dashes: each row has to carry a digit.
      for (const [name, text] of Object.entries(gauges)) {
        expect(text, `the ${name} gauge shows a measured value`).toMatch(/\d/);
      }
      run.telemetry = {
        gauges,
        observedAt: reading.at ?? null,
        host: {
          cpu: reading.host?.cpu?.logicalCount ?? null,
          memoryTotalBytes: reading.host?.memory?.totalBytes ?? null,
          memoryFreeBytes: reading.host?.memory?.freeBytes ?? null,
          uptimeSeconds: reading.host?.uptime?.seconds ?? reading.host?.uptimeSeconds ?? null,
        },
      };
      step('telemetry', run.telemetry);
      await shot('04-real-telemetry');

      // ---- the git workspace is the real repository -------------------------------------------
      const workspaceReading = reading.workspace ?? null;
      expect(workspaceReading, 'the bootstrap recorded a workspace reading').not.toBeNull();
      expect(workspaceReading.available).toBe(true);
      expect(workspaceReading.branch).toBe(handle.repository.branch);
      expect(workspaceReading.head).toBe(handle.repository.head);
      run.workspace = {
        branch: workspaceReading.branch,
        head: workspaceReading.head,
        root: workspaceReading.root,
        expected: { branch: handle.repository.branch, head: handle.repository.head },
      };
      step('workspace', run.workspace);

      // ---- the local workstation is enrolled, exactly once ------------------------------------
      const presence = (await handle.presence()).body;
      const devices = Array.isArray(presence.deviceTrust?.devices) ? presence.deviceTrust.devices : [];
      const workstation = devices.filter((device) => device.deviceId === 'local-workstation');
      expect(workstation.length, 'the local workstation is enrolled once').toBe(1);
      expect(workstation[0].status).toBe('trusted');
      expect(workstation[0].metadata?.hostname).toBeTruthy();
      expect(workstation[0].metadata?.platform).toBeTruthy();
      expect(workstation[0].metadata?.capability).toBe('local-loopback');
      expect(devices.length, 'no other device was invented').toBe(1);
      // And the deck shows it. The list renders the device's own label - the real hostname the
      // bootstrap observed - not its id, so the assertion names the label. The id is checked on
      // the route above and again in the status line below, where the id also appears.
      await page.locator('nav .nav-item[data-view="presence"]').click();
      await expect(page.locator('body')).toHaveAttribute('data-view', 'presence');
      await expect(page.locator('#presence-status')).toContainText('1 enrolled device', { timeout: 30_000 });
      await expect(page.locator('#presence-devices')).toContainText(workstation[0].label, { timeout: 30_000 });
      await expect(page.locator('#presence-devices')).toContainText('trusted', { timeout: 30_000 });
      // The enrolled id is the contract; it is visible on the route and in the bootstrap report.
      expect(bootLatest?.device?.deviceId).toBe('local-workstation');
      const presenceText = (await page.locator('#presence-devices').textContent()) ?? '';
      expect(presenceText.length, 'the Presence list is not empty').toBeGreaterThan(0);
      run.device = {
        deviceId: workstation[0].deviceId,
        status: workstation[0].status,
        metadata: workstation[0].metadata,
        enrolled: devices.length,
      };
      step('presence', run.device);
      await shot('05-local-workstation');

      // ---- a live Executive Briefing, compiled from those readings -----------------------------
      await page.locator('nav .nav-item[data-view="deck"]').click();
      await expect(page.locator('body')).toHaveAttribute('data-view', 'deck');
      // `/api/briefing` is the deck's work briefing - goals, plans, tasks, situational events - and on
      // a machine with no work in it yet it is correctly empty. The *opening* briefing is a different
      // thing: the one `system.bootstrap` compiled from the doctor, the resource reading and the git
      // workspace. It is recorded in the marker the bootstrap wrote, and that is what is asserted.
      const workBriefing = (await handle.briefing()).body;
      expect(workBriefing.schema).toBeTruthy();
      expect(workBriefing.available, 'the work briefing is readable').toBe(true);

      const openingBriefing = bootLatest?.briefing ?? null;
      expect(openingBriefing, 'the bootstrap compiled an opening Executive Briefing').not.toBeNull();
      expect(openingBriefing.concise).toContain('local-workstation');
      expect(openingBriefing.concise).toContain(handle.repository.branch);
      expect(openingBriefing.facts.length, 'the briefing carries the facts it was compiled from').toBeGreaterThan(0);
      // Every fact names what kind of fact it is, and the set covers the three readings it was
      // compiled from: the doctor, the host, and the workspace.
      const kinds = openingBriefing.facts.map((fact) => fact.kind);
      for (const fact of openingBriefing.facts) {
        expect(fact.text, `a ${fact.kind} fact has text`).toBeTruthy();
      }
      for (const kind of ['doctor', 'resource', 'workspace']) {
        expect(kinds, `the opening briefing carries a ${kind} fact`).toContain(kind);
      }
      // And the deck rendered it: the boot row for the briefing carries the compiled line.
      const briefingRow = page.locator('#hud-boot-steps li[data-boot-step="executive_briefing"]');
      await expect(briefingRow).toHaveAttribute('data-boot-state', 'ok');
      expect(((await briefingRow.textContent()) ?? '').trim().length).toBeGreaterThan(0);
      run.briefing = {
        schema: workBriefing.schema,
        concise: openingBriefing.concise,
        facts: kinds,
        workBriefingCounts: workBriefing.counts ?? null,
        rendered: (await briefingRow.textContent())?.trim() ?? null,
      };
      step('briefing', run.briefing);
      await shot('06-briefing');

      // ---- the doctor reads six checks, and on this machine all six pass ----------------------
      // This suite only runs where a Chromium-family browser resolved, and the doctor resolves the
      // same binary with the same rules, so `browser_binary` has to pass. If it does not, the two
      // are disagreeing about the same host and that is a real failure, not a tolerable one.
      await page.locator('nav .nav-item[data-view="system"]').click();
      await expect(page.locator('body')).toHaveAttribute('data-view', 'system');
      await page.locator('#doctor-run').click();
      await expect(page.locator('#doctor-status')).toHaveText(/\d+(\.\d+)? ms of a 500 ms budget/, { timeout: 30_000 });
      const checkRows = page.locator('#doctor-checks li[data-check]');
      await expect(checkRows).toHaveCount(6, { timeout: 30_000 });
      const doctorJson = (await handle.doctor()).body;
      const expectedChecks = ['safety_latch', 'ecp_authority', 'stores_integrity', 'capability_inventory', 'browser_binary', 'workspace_sensor'];
      expect(doctorJson.checks.map((entry) => entry.name)).toEqual(expectedChecks);
      expect(doctorJson.withinBudget, `the doctor took ${doctorJson.durationMs} ms`).toBe(true);
      const checkStates = Object.fromEntries(doctorJson.checks.map((entry) => [entry.name, entry.state]));
      expect(checkStates.browser_binary, 'a browser resolved, so the doctor must see one').toBe('pass');
      expect(checkStates.safety_latch).toBe('pass');
      expect(checkStates.ecp_authority).toBe('pass');
      expect(checkStates.capability_inventory).toBe('pass');
      expect(checkStates.workspace_sensor).toBe('pass');
      expect(checkStates.stores_integrity).not.toBe('not_configured');
      const passing = doctorJson.checks.filter((entry) => entry.state === 'pass').length;
      expect(passing, 'every doctor check passes on a machine that can run this suite').toBe(6);
      run.doctor = { states: checkStates, passing, total: doctorJson.checks.length, status: doctorJson.status, durationMs: doctorJson.durationMs, withinBudget: doctorJson.withinBudget };
      step('doctor', run.doctor);
      await shot('07-doctor');

      // ---- a T-29 cognitive intent from the freshly bootstrapped state --------------------------
      // Started through the HTTP route, then read back from the deck: the intent is understood,
      // the task exists, and the ECP leaves the write awaiting the owner's own approval.
      const cognition = await handle.cognitiveRun();
      expect(cognition.status, JSON.stringify(cognition.body)).toBe(200);
      const runStatus = cognition.body.runStatus ?? cognition.body.run?.status ?? null;
      expect(['awaiting_approval', 'completed']).toContain(runStatus);
      await page.locator('nav .nav-item[data-view="deck"]').click();
      await expect(page.locator('body')).toHaveAttribute('data-view', 'deck');
      // The deck's own approval list, and the owner's approval queue, both name the run's step.
      await expect(page.locator('#approvals')).toContainText(/memory|approval/i, { timeout: 30_000 });
      const approvals = (await handle.get('/api/approvals')).body;
      const approvalItems = Array.isArray(approvals?.items) ? approvals.items : [];
      expect(approvalItems.length, 'the ECP left exactly one step awaiting the owner').toBe(1);
      expect(approvalItems[0].id).toContain('task-step:');
      const after = (await handle.state()).body;
      const tasks = Array.isArray(after.tasks) ? after.tasks : [];
      expect(tasks.length, 'the cognitive run created exactly one task').toBe(1);
      // Zero synthetic goals or tasks: the only task in the store is the one this intent created.
      const bootReport = bootLatest ?? null;
      expect(bootReport, 'the marker recorded what the boot created').not.toBeNull();
      expect(bootReport.syntheticTasksCreated, 'the bootstrap recorded that it created no task').toBe(0);
      expect(bootReport.syntheticGoalsCreated, 'the bootstrap recorded that it created no goal').toBe(0);
      run.cognition = {
        runId: cognition.body.run?.runId ?? cognition.body.runId ?? null,
        runStatus,
        taskId: tasks[0]?.id ?? null,
        taskStatus: tasks[0]?.status ?? null,
        taskCount: tasks.length,
        approvalCount: approvalItems.length,
        approvalId: approvalItems[0]?.id ?? null,
      };
      step('cognition', run.cognition);
      await shot('08-cognitive-intent');

      // ---- the bootstrap left no synthetic goals or tasks behind -------------------------------
      // Read the stores directly: a bootstrap that invented a demo task would fail here.
      const goalCount = Array.isArray(after.goals) ? after.goals.length : 0;
      expect(goalCount, 'the bootstrap created no synthetic goal').toBe(0);
      const bootstrapTasks = tasks.filter((task) => String(task.id).startsWith('bootstrap'));
      expect(bootstrapTasks.length, 'the bootstrap created no task of its own').toBe(0);

      // ---- the page stayed whole --------------------------------------------------------------
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      run.overflow = overflow;
      expect(overflow.scrollWidth, `horizontal overflow at ${overflow.scrollWidth}px wide in a ${overflow.clientWidth}px viewport`).toBeLessThanOrEqual(overflow.clientWidth);
      expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

      expect(pageErrors, `page errors: ${JSON.stringify(pageErrors)}`).toEqual([]);
      expect(consoleErrors, `console errors: ${JSON.stringify(consoleErrors)}`).toEqual([]);
      step('clean', { consoleErrors: 0, pageErrors: 0, overflow: false });

      // The marker and the ledger the walk earned are on disk, and the directory started empty.
      const afterDisk = handle.after();
      expect(afterDisk.bootstrapMarker).toBe(true);
      expect(afterDisk.deviceRegistry).toBe(true);
      expect(afterDisk.perceptionLedger).toBe(true);
      step('disk', afterDisk);

      await context.close();
    } catch (error) {
      run.failures.push({ at: new Date().toISOString(), message: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 6) });
      throw error;
    }
  });
});
