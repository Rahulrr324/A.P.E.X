// T-31 Step 1 (2026-11-19): real-browser verification, in a real Chromium-family browser.
//
// What failed before this file existed: Playwright's bundled Chromium has to be downloaded from
// `cdn.playwright.dev`, which is unreachable in the development sandbox, so "no real browser ran"
// was the honest state of every visual claim. It was never true that no browser existed anywhere:
// the GitHub-hosted runner ships `/usr/bin/microsoft-edge`. This suite resolves a real binary —
// explicitly, through `src/ui/browser-binary.js` — and launches it with
// `chromium.launch({ executablePath, headless: true })`.
//
// What this suite checks, in a real browser against the shipped server and the shipped client:
//   * zero `console.error` and zero uncaught `pageerror` at three viewports;
//   * zero unintended horizontal overflow;
//   * the Core reaches Awaiting Approval from the seeded pending approval, degrades within 2 s
//     when the stream stops, and recovers when the server comes back;
//   * all five presentation modes switch, and Lockdown locks the switch;
//   * every workspace renders, including the T-31 surfaces, from real backend data;
//   * a PNG screenshot per viewport, with its byte size and pixel dimensions recorded.
//
// When the host has no browser at all the suite skips with an explicit diagnostic. A skip is not
// a pass: `reports/T30_PROGRESS.md` only claims a browser result where this suite actually ran.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import {
  startSeededUi, restartUi, T31_VIEWPORTS, T31_SCHEMA, screenshotPath,
} from './t31-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const reportDir = path.join(here, '..', '..', 'reports', 'screenshots');
const summaryPath = path.join(reportDir, 't31-browser-run.json');

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
  schema: T31_SCHEMA,
  browserBinary: BROWSER_BINARY_SCHEMA,
  resolved: {
    executable: resolution.executable,
    source: resolution.source,
    candidate: resolution.browser?.label ?? null,
    tried: resolution.tried,
  },
  browserVersion: null,
  platform: process.platform,
  node: process.version,
  headless: true,
  viewports: [],
  screenshots: [],
  checks: {},
  startedAt: new Date().toISOString(),
  finishedAt: null,
};

// PNG dimensions come from the file itself (IHDR), not from what the page asked for: a
// screenshot that was clipped or scaled would otherwise be reported as the requested size.
function pngSize(file) {
  const buffer = fs.readFileSync(file);
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return { bytes: buffer.length, width: null, height: null, png: false };
  return { bytes: buffer.length, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), png: true };
}

function writeSummary() {
  run.finishedAt = new Date().toISOString();
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(run, null, 2)}\n`);
  // One line of JSON on stdout: the workflow reads it back for the check annotation.
  console.log(`T31_BROWSER_SUMMARY ${JSON.stringify(run)}`);
}

let handle = null;
let browser = null;

test.describe('T-31 real-browser verification', () => {
  test.skip(resolution.executable === null, noBrowserDiagnostic(resolution));

  test.beforeAll(async () => {
    fs.mkdirSync(reportDir, { recursive: true });
    handle = await startSeededUi();
    browser = await chromium.launch({ executablePath: resolution.executable, headless: true });
    run.browserVersion = browser.version();
    run.checks.seeded = handle.seed;
  });

  test.afterAll(async () => {
    if (browser) await browser.close().catch(() => {});
    if (handle) await handle.stop().catch(() => {});
    writeSummary();
  });

  for (const viewport of T31_VIEWPORTS) {
    test(`${viewport.width}x${viewport.height}: no console errors, no overflow, Core on live SSE, every workspace renders`, async () => {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      page.on('pageerror', (error) => pageErrors.push(String(error)));

      const result = { viewport, core: null, connectivity: null, overflow: null, views: [], errors: null };
      try {
        await page.goto(`${handle.base}/?token=${encodeURIComponent(handle.token)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForSelector('#main-content', { timeout: 20_000 });
        // The seeded gated run leaves a step awaiting the owner, so the Core must say so rather
        // than Idle: the client derives that from the authoritative owner snapshots on the stream.
        await page.waitForFunction(() => /awaiting/i.test(document.getElementById('core-state')?.textContent ?? ''), null, { timeout: 30_000 });
        result.core = (await page.locator('#core-state').textContent())?.trim() ?? null;
        result.connectivity = (await page.locator('#connectivity').textContent())?.trim() ?? null;

        const metrics = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          innerWidth: window.innerWidth,
        }));
        result.overflow = metrics;
        expect(metrics.scrollWidth, `horizontal overflow at ${viewport.width}x${viewport.height}: ${JSON.stringify(metrics)}`)
          .toBeLessThanOrEqual(metrics.clientWidth);

        // Every workspace the deck ships, opened through the navigation the owner uses.
        const views = await page.evaluate(() => [...document.querySelectorAll('nav .nav-item')].map((node) => node.dataset.view));
        expect(views.length, 'the deck ships its workspaces').toBeGreaterThanOrEqual(15);
        for (const view of views) {
          await page.locator(`[data-view="${view}"]`).first().click();
          await expect(page.locator('body')).toHaveAttribute('data-view', view);
          result.views.push(view);
        }

        // The workspaces a person governs from, read from the live backend rather than filled
        // with placeholders: the T-29 trace, the Council synthesis and the Workshop list.
        await page.locator('[data-view="cognition"]').first().click();
        await expect(page.locator('#cognition-trace')).toBeVisible();
        await expect(page.locator('#cognition-trace')).toContainText(/context|salience|council|task graph|ecp/i);
        await page.locator('[data-view="council"]').first().click();
        await expect(page.locator('#council')).toBeVisible();
        await page.locator('[data-view="workshop"]').first().click();
        await expect(page.locator('#workshop')).toBeVisible();

        // T-31 Step 2: the surfaces that must show a real backend read, not a placeholder.
        // The epistemic labels are read from the projection the page fetched, so an assumption can
        // never be rendered as an observation.
        await expect(page.locator('#world-labels')).not.toHaveText(/Loading|Unavailable/i);
        result.worldLabels = (await page.locator('#world-labels').textContent())?.trim() ?? null;
        await expect(page.locator('#evolution-status')).not.toHaveText(/Loading/i);
        await expect(page.locator('#evolution-status')).toContainText(/proposal|No evolution proposal/i);
        result.evolutionStatus = (await page.locator('#evolution-status').textContent())?.trim() ?? null;
        const boundaryCount = await page.locator('#evolution-boundaries li').count();
        expect(boundaryCount, 'the immutable safety boundaries are rendered').toBeGreaterThanOrEqual(5);

        await page.locator('[data-view="presence"]').first().click();
        await expect(page.locator('#presence-status')).not.toHaveText(/Loading/i);
        await expect(page.locator('#presence-status')).toContainText(/device|trust/i);
        result.presenceStatus = (await page.locator('#presence-status').textContent())?.trim() ?? null;
        // The autonomy matrix is read-only and must carry one row per domain, never an empty table.
        const matrixRows = await page.locator('#autonomy-matrix tr').count();
        expect(matrixRows, 'the autonomy matrix lists the domains the ECP applies').toBeGreaterThan(0);
        result.autonomyRows = matrixRows;
        result.autonomyStatus = (await page.locator('#autonomy-status').textContent())?.trim() ?? null;
        expect(result.autonomyStatus).toMatch(/read-only/i);

        // Every element the client resolves must exist in the live DOM: a missing id is a blank
        // workspace, and this is the assertion that would catch one.
        const missingIds = await page.evaluate(() => {
          const ids = ['presence-status', 'presence-devices', 'presence-mesh', 'autonomy-status',
            'autonomy-matrix', 'autonomy-capabilities', 'world-claims', 'world-labels', 'evolution-status',
            'evolution-proposals', 'evolution-boundaries', 'evolution-boundaries-status', 'evolution-policy',
            'evolution-form', 'evolution-title', 'evolution-hypothesis', 'evolution-propose', 'evolution-form-status'];
          return ids.filter((id) => document.getElementById(id) === null);
        });
        expect(missingIds, `missing DOM ids: ${missingIds.join(', ')}`).toEqual([]);
        // No fabricated controls: nothing on these surfaces claims a capability the backend refuses.
        const forbidden = await page.evaluate(() => [...document.querySelectorAll('button')]
          .map((node) => node.textContent ?? '')
          .filter((text) => /voice|microphone|push to talk|listen|speak|connect device|pair/i.test(text)));
        expect(forbidden, `fabricated controls: ${forbidden.join(' | ')}`).toEqual([]);

        await page.locator('[data-view="deck"]').first().click();

        const file = screenshotPath(reportDir, viewport);
        await page.screenshot({ path: file, fullPage: false });
        const size = pngSize(file);
        result.screenshot = { file: path.relative(path.join(here, '..', '..'), file), ...size };
        expect(size.png, `the screenshot is a real PNG: ${JSON.stringify(size)}`).toBe(true);
        expect(size.width, 'the screenshot has the viewport width').toBe(viewport.width);
        expect(size.height, 'the screenshot has the viewport height').toBe(viewport.height);
        run.screenshots.push(result.screenshot);

        await page.waitForTimeout(500);
        result.errors = { console: consoleErrors.slice(0, 20), page: pageErrors.slice(0, 20) };
        expect(pageErrors, `uncaught page errors at ${viewport.width}x${viewport.height}: ${pageErrors.join(' | ')}`).toEqual([]);
        expect(consoleErrors, `console errors at ${viewport.width}x${viewport.height}: ${consoleErrors.join(' | ')}`).toEqual([]);
      } finally {
        run.viewports.push({ ...result, errors: result.errors ?? { console: consoleErrors.slice(0, 20), page: pageErrors.slice(0, 20) } });
        await context.close();
      }
    });
  }

  test('the Core degrades within 2 s when the stream stops and recovers on reconnect', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await page.goto(`${handle.base}/?token=${encodeURIComponent(handle.token)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForFunction(() => /awaiting/i.test(document.getElementById('core-state')?.textContent ?? ''), null, { timeout: 30_000 });

      await handle.stopServer();
      const stoppedAt = Date.now();
      await page.waitForFunction(() => /degraded/i.test(document.getElementById('core-state')?.textContent ?? ''), null, { timeout: 5_000 });
      const degradedAfterMs = Date.now() - stoppedAt;
      run.checks.degradedAfterMs = degradedAfterMs;
      expect(degradedAfterMs, `degraded detection was ${degradedAfterMs} ms`).toBeLessThanOrEqual(2_000);
      run.checks.connectivityWhileDegraded = (await page.locator('#connectivity').textContent())?.trim() ?? null;

      handle = await restartUi(handle);
      await page.waitForFunction(() => /awaiting/i.test(document.getElementById('core-state')?.textContent ?? ''), null, { timeout: 20_000 });
      run.checks.recoveredCore = (await page.locator('#core-state').textContent())?.trim() ?? null;
      run.checks.recoveredConnectivity = (await page.locator('#connectivity').textContent())?.trim() ?? null;
      expect(run.checks.recoveredConnectivity).toBe('Connected');
    } finally {
      await context.close();
    }
  });

  test('all five presentation modes switch, and Lockdown locks the switch', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    try {
      await page.goto(`${handle.base}/?token=${encodeURIComponent(handle.token)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForFunction(() => /awaiting/i.test(document.getElementById('core-state')?.textContent ?? ''), null, { timeout: 30_000 });

      const modes = ['tactical', 'overwatch', 'synthesis', 'quiet', 'classic'];
      const switched = [];
      for (const mode of modes) {
        await page.selectOption('#mode-select', mode);
        await expect(page.locator('body')).toHaveAttribute('data-mode', mode);
        switched.push(mode);
      }
      run.checks.modes = switched;

      // T-31 Step 3: with no step-up secret configured, the proof field must stay hidden and the
      // note must say so. A visible credential field here would be a fabricated control.
      const stepUpState = await page.evaluate(() => ({
        hidden: document.getElementById('safety-step-up-wrap')?.hidden ?? null,
        note: (document.getElementById('safety-step-up-note')?.textContent ?? '').trim(),
      }));
      run.checks.stepUp = stepUpState;
      expect(stepUpState.hidden, 'the step-up field is hidden when no secret is configured').toBe(true);
      expect(stepUpState.note).toMatch(/No step-up secret is configured/);

      const locked = await page.evaluate(async () => {
        const response = await fetch('/api/safety/lockdown', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-apex-ui': '1' },
          body: JSON.stringify({ reason: 'T-31 real-browser verification: mode lock check' }),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
      });
      expect(locked.status, JSON.stringify(locked.body)).toBe(200);
      await page.waitForFunction(() => document.body.dataset.coreState === 'lockdown', null, { timeout: 20_000 });
      await expect(page.locator('#mode-select')).toBeDisabled();
      await expect(page.locator('body')).toHaveAttribute('data-mode', 'lockdown');
      run.checks.modeLockedByLockdown = true;

      // The latch is released through the same owner route the System workspace uses. The
      // confirmation and the typed reason are mandatory; T-31 adds the step-up when configured.
      const released = await page.evaluate(async () => {
        const response = await fetch('/api/safety/release', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-apex-ui': '1' },
          body: JSON.stringify({ reason: 'T-31 real-browser verification complete', confirm: true }),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
      });
      expect(released.status, JSON.stringify(released.body)).toBe(200);
      await page.waitForFunction(() => document.body.dataset.coreState !== 'lockdown', null, { timeout: 20_000 });
      await expect(page.locator('#mode-select')).toBeEnabled();
      run.checks.releasedAfterLockdown = true;
      expect(consoleErrors, consoleErrors.join(' | ')).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
