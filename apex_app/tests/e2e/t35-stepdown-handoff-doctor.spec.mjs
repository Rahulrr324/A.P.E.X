// T-35 Step 4 (2026-11-19): one real-browser session over the step-down ladder, the sensor and
// privacy indicator, a trusted handoff, and the doctor.
//
// What this walk has to earn, in a real Chromium-family browser against the shipped server and the
// shipped client:
//
//   the ladder moves 0 -> 1 (bloom gone) -> 3 (parallax zeroed) -> 5 (flat: no backdrop blur, panel
//   transitions off) with the Core reticle still visible at every rung  ->  no animation anywhere in
//   the page cycles faster than three times a second, measured with the Web Animations API  ->  the
//   sensor indicator says audio/mic and camera/video are disabled  ->  a staged envelope is claimed
//   on its named device and the deck lands on the handed-off view and mission  ->  the System
//   workspace runs the doctor and shows six checks with the state each one could defend  ->  no
//   console error, no page error, no horizontal overflow.
//
// When the host has no browser at all the suite skips with an explicit diagnostic. A skip is not a
// pass, and the summary says which of the two happened.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import { startT35Ui, T35_SCHEMA } from './t35-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(here, '..', '..');
const reportDir = path.join(repoDir, 'reports', 'screenshots', 't35');
const summaryPath = path.join(repoDir, 'reports', 't35-stepdown-handoff-doctor.json');

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
  schema: T35_SCHEMA,
  browserBinary: BROWSER_BINARY_SCHEMA,
  resolved: { executable: resolution.executable, source: resolution.source, candidate: resolution.browser?.label ?? null },
  browserVersion: null,
  platform: process.platform,
  node: process.version,
  headless: true,
  steps: [],
  screenshots: [],
  stages: {},
  flashGuard: null,
  sensor: null,
  handoff: null,
  doctor: null,
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
  console.log(`T35_FAILURES ${JSON.stringify({ failures: run.failures, steps: run.steps.length, screenshots: run.screenshots.length })}`);
  console.log(`T35_SUMMARY ${JSON.stringify(run)}`);
}

let handle = null;
let browser = null;

test.describe('T-35 step-down ladder, handoff envelopes and doctor, in a real browser', () => {
  test.skip(resolution.executable === null, noBrowserDiagnostic(resolution));

  test.beforeAll(async () => {
    fs.mkdirSync(reportDir, { recursive: true });
    handle = await startT35Ui();
    browser = await chromium.launch({ executablePath: resolution.executable, headless: true });
    run.browserVersion = browser.version();
  });

  test.afterAll(async () => {
    if (browser) await browser.close().catch(() => {});
    if (handle) await handle.stop().catch(() => {});
    writeSummary();
  });

  test('the ladder, the flash guard, the indicator, a handoff, and the doctor', async () => {
    test.setTimeout(300_000);
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
        const file = path.join(reportDir, `t35-${name}.png`);
        await page.screenshot({ path: file, fullPage: false });
        run.screenshots.push({ name, file: path.relative(repoDir, file), ...pngSize(file) });
      };

      await page.goto(`${handle.base}/?token=${encodeURIComponent(handle.token)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // ---- the ladder -------------------------------------------------------------------------
      // The auto stage is whatever this machine's pressure says; the override is the only way to walk
      // the rungs deterministically, and walking it is exactly what the owner's control is for.
      await expect(page.locator('#stepdown-state')).toHaveAttribute('data-stage', /^[0-5]$/, { timeout: 30_000 });
      const autoStage = await page.locator('#stepdown-state').getAttribute('data-auto-stage');
      run.stages.auto = { stage: await page.locator('#stepdown-state').getAttribute('data-stage'), auto: autoStage };
      step('auto-stage', run.stages.auto);

      const setStage = async (stage) => {
        await page.locator('#stepdown-select').selectOption(String(stage));
        await expect(page.locator('body')).toHaveAttribute('data-stepdown-stage', String(stage));
        await expect(page.locator('#stepdown-state')).toHaveAttribute('data-stage', String(stage));
        return page.evaluate(() => ({
          bloom: document.body.dataset.hudBloom,
          particles: document.body.dataset.hudParticles,
          parallax: document.body.dataset.hudParallax,
          ambient: document.body.dataset.hudAmbient,
          flat: document.body.dataset.hudFlat,
          // Read where the deck inherits from: the stage is written on <body>, so the effective
          // token is the body's computed value, not the :root default the body overrides.
          deckBloom: getComputedStyle(document.body).getPropertyValue('--hud-bloom').trim(),
          coreFilter: getComputedStyle(document.querySelector('.core')).filter,
          panelBackdrop: (() => {
            const panel = document.querySelector('.view.active .panel') || document.querySelector('.panel');
            return panel ? getComputedStyle(panel).backdropFilter || getComputedStyle(panel).webkitBackdropFilter : 'no-panel';
          })(),
          z3Factor: getComputedStyle(document.documentElement).getPropertyValue('--parallax-z3').trim(),
          ringAnimation: getComputedStyle(document.querySelector('.core-ring.outer')).animationName,
          haloAnimation: getComputedStyle(document.querySelector('.core-halo')).animationName,
          azimuthAnimation: getComputedStyle(document.querySelector('#core-reticle .reticle-azimuth')).animationName,
          reticle: (() => {
            const reticle = document.getElementById('core-reticle');
            const style = getComputedStyle(reticle);
            const box = reticle.getBoundingClientRect();
            return { opacity: style.opacity, visibility: style.visibility, display: style.display, width: Math.round(box.width), height: Math.round(box.height) };
          })(),
        }));
      };

      const stage0 = await setStage(0);
      run.stages[0] = stage0;
      expect(stage0.bloom, 'stage 0 paints the bloom').not.toBe('dropped');
      expect(stage0.coreFilter, 'stage 0 has a glow filter').not.toBe('none');
      expect(stage0.reticle.opacity).toBe('1');
      expect(stage0.ringAnimation, 'stage 0 drifts the outer ring').toBe('spin');
      await shot('stage-0-nominal');

      const stage1 = await setStage(1);
      run.stages[1] = stage1;
      expect(stage1.bloom).toBe('dropped');
      expect(stage1.deckBloom, 'the bloom token the deck inherits is zeroed').toBe('0px');
      expect(stage1.coreFilter, 'the bloom is gone from the painted Core').toBe('none');
      expect(stage1.reticle.opacity, 'the reticle stays legible when the bloom drops').toBe('1');
      await shot('stage-1-no-bloom');

      const stage2 = await setStage(2);
      run.stages[2] = stage2;
      expect(stage2.particles).toBe('dropped');
      expect(await page.evaluate(() => getComputedStyle(document.getElementById('hud-particles')).display)).toBe('none');

      const stage3 = await setStage(3);
      run.stages[3] = stage3;
      expect(stage3.parallax).toBe('dropped');
      const factors = await page.evaluate(() => ['--parallax-z1', '--parallax-z3', '--parallax-z4']
        .map((token) => getComputedStyle(document.body).getPropertyValue(token).trim()));
      expect(factors, 'every depth plane factor is zero at stage 3').toEqual(['0', '0', '0']);
      await shot('stage-3-no-parallax');

      const stage4 = await setStage(4);
      run.stages[4] = stage4;
      expect(stage4.ambient).toBe('dropped');
      expect(stage4.ringAnimation, 'the ambient outer ring stops drifting').toBe('none');
      expect(stage4.haloAnimation, 'the ambient halo stops breathing').toBe('none');
      expect(stage4.azimuthAnimation, 'the Core state indicator keeps its cadence').toBe('spin');

      const stage5 = await setStage(5);
      run.stages[5] = stage5;
      expect(stage5.flat).toBe('true');
      expect(stage5.panelBackdrop, 'flat mode removes the backdrop blur').toBe('none');
      const panelTransition = await page.evaluate(() => {
        const panel = document.querySelector('.view.active .panel') || document.querySelector('.panel');
        if (!panel) return null;
        const style = getComputedStyle(panel);
        return { property: style.transitionProperty, duration: style.transitionDuration };
      });
      expect(panelTransition, 'the deck still has a panel to measure').not.toBeNull();
      expect(panelTransition.duration.replace(/[\s,]+/g, ''), 'flat mode removes every panel transition duration')
        .toMatch(/^(0s)+$/);
      const reticleBox = page.locator('#core-reticle');
      await expect(reticleBox).toBeVisible();
      const reticleBoxPx = await reticleBox.boundingBox();
      expect(reticleBoxPx.width, 'the Core reticle keeps its size at the lowest rung').toBeGreaterThan(40);
      expect(stage5.reticle.opacity).toBe('1');
      await shot('stage-5-flat');

      // Back to auto, so the rest of the walk runs on the machine's own reading.
      await page.locator('#stepdown-select').selectOption('auto');
      await expect(page.locator('body')).toHaveAttribute('data-stepdown-source', 'auto');

      // ---- the flash guard -------------------------------------------------------------------
      // Measured live, not read off a stylesheet: every running animation's own timing is inspected,
      // and the reticle is sampled for 1.2 s to count how often its computed style changes.
      const animations = await page.evaluate(() => {
        if (typeof document.getAnimations !== 'function') return null;
        return document.getAnimations().map((animation) => {
          let duration = null;
          try {
            const timing = animation.effect?.getTiming?.();
            duration = typeof timing?.duration === 'number' ? timing.duration : null;
          } catch { duration = null; }
          // Only animations cycle; a transition is a one-shot state change and has no flash rate.
          return { duration, name: animation.animationName ?? null, kind: animation.constructor?.name ?? 'unknown' };
        });
      });
      expect(animations, 'the Web Animations API is available to measure the guard').not.toBeNull();
      const GUARD_MS = 334;
      const cycles = animations.filter((entry) => entry.kind === 'CSSAnimation');
      expect(cycles.length, 'the deck is still animating something, so the guard is measured and not vacuous').toBeGreaterThan(0);
      const fast = cycles.filter((entry) => typeof entry.duration === 'number' && entry.duration > 0 && entry.duration < GUARD_MS);
      expect(fast, `no animation may cycle faster than ${GUARD_MS} ms: ${JSON.stringify(fast)}`).toEqual([]);

      const samples = await page.evaluate(async () => {
        const reticle = document.getElementById('core-reticle');
        const seen = new Set();
        const read = () => {
          const style = getComputedStyle(reticle);
          return [style.opacity, style.visibility, style.display, style.fill, style.stroke, style.transform].join('|');
        };
        const started = performance.now();
        for (let index = 0; index < 40; index += 1) {
          seen.add(read());
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return { changes: seen.size, elapsed: Math.round(performance.now() - started), values: [...seen].slice(0, 4) };
      });
      expect(samples.changes, 'the reticle does not flicker between values').toBeLessThanOrEqual(3);
      run.flashGuard = {
        guardMs: GUARD_MS, animations: animations.length, cycles: cycles.length,
        durations: cycles.map((entry) => entry.duration), violations: fast.length, reticleSamples: samples,
      };
      step('flash-guard', run.flashGuard);

      // ---- the sensor and privacy indicator ---------------------------------------------------
      const privacy = page.locator('#sensor-privacy-indicator');
      await expect(privacy).toHaveAttribute('data-audio', 'disabled');
      await expect(privacy).toHaveAttribute('data-camera', 'disabled');
      await expect(privacy).toContainText('audio/mic: disabled');
      await expect(privacy).toContainText('camera/video: disabled');
      await expect(privacy).toContainText('host-telemetry');
      await expect(privacy).toContainText('git-workspace');
      const privacyText = (await privacy.textContent()) ?? '';
      run.sensor = { text: privacyText.trim(), active: await privacy.getAttribute('data-active-sensors') };
      const stateHud = await handle.state();
      expect(stateHud.hud.sensor.privacy.capturePossible).toBe(false);
      step('sensor-indicator', run.sensor);

      // ---- a trusted handoff, staged and claimed ----------------------------------------------
      await page.locator('nav .nav-item[data-view="presence"]').click();
      await expect(page.locator('body')).toHaveAttribute('data-view', 'presence');
      const sourceOption = page.locator('#handoff-source option', { hasText: 'owner laptop' });
      await expect(sourceOption).toHaveCount(1);
      await page.locator('#handoff-source').selectOption(handle.devices.source);
      await page.locator('#handoff-target').selectOption(handle.devices.target);
      await page.locator('#handoff-view').selectOption('tasks');
      await page.locator('#handoff-task').fill(handle.taskId);
      await page.locator('#handoff-note').fill('picked up in a real browser');
      await page.locator('#handoff-stage').click();

      const stagedRow = page.locator('#handoff-list li[data-handoff-status="staged"]').first();
      await expect(stagedRow).toHaveCount(1, { timeout: 30_000 });
      const stagedId = await stagedRow.getAttribute('data-handoff-id');
      const stagedText = (await stagedRow.textContent()) ?? '';
      const presenceAfterStage = await handle.presence();
      const stagedRecord = presenceAfterStage.handoffs.recent.find((entry) => entry.id === stagedId);
      expect(stagedRecord, 'the ledger holds the envelope the page is showing').toBeTruthy();
      expect(stagedRecord.status).toBe('staged');
      expect(stagedRecord.sha256Digest).toMatch(/^[a-f0-9]{64}$/);
      expect(stagedText, 'the digest is on the page, not only in the API').toContain(stagedRecord.sha256Digest.slice(0, 12));
      expect(stagedRecord.targetView).toBe('tasks');
      expect(stagedRecord.remoteTransport ?? presenceAfterStage.handoffs.remoteTransport).toBe(false);
      await shot('handoff-staged');

      await stagedRow.getByRole('button', { name: 'Claim & Restore' }).click();
      await expect(page.locator('body')).toHaveAttribute('data-view', 'tasks', { timeout: 30_000 });
      await expect(page.locator('#handoff-message')).toContainText('Restored tasks');
      const presenceAfterClaim = await handle.presence();
      const claimed = presenceAfterClaim.handoffs.recent.find((entry) => entry.id === stagedId);
      expect(claimed.status).toBe('claimed');
      expect(claimed.sha256Digest, 'the claimed envelope is the same envelope').toBe(stagedRecord.sha256Digest);
      expect(claimed.restoration).toMatchObject({ view: 'tasks', taskId: handle.taskId });
      run.handoff = {
        id: stagedId,
        digest: stagedRecord.sha256Digest,
        stagedText: stagedText.replace(/\s+/g, ' ').trim(),
        restoration: claimed.restoration,
        digestMatchedAfterClaim: claimed.sha256Digest === stagedRecord.sha256Digest,
      };
      step('handoff-claimed', { id: stagedId, restoration: claimed.restoration });
      await shot('handoff-claimed');

      // ---- the doctor -------------------------------------------------------------------------
      await page.locator('nav .nav-item[data-view="system"]').click();
      await expect(page.locator('body')).toHaveAttribute('data-view', 'system');
      await page.locator('#doctor-run').click();
      await expect(page.locator('#doctor-status')).not.toHaveText(/The doctor has not run yet/, { timeout: 30_000 });
      const checkRows = page.locator('#doctor-checks li[data-check]');
      await expect(checkRows).toHaveCount(6, { timeout: 30_000 });
      const states = await checkRows.evaluateAll((rows) => rows.map((row) => ({ name: row.dataset.check, state: row.dataset.checkState })));
      const expected = ['safety_latch', 'ecp_authority', 'stores_integrity', 'capability_inventory', 'browser_binary', 'workspace_sensor'];
      expect(states.map((entry) => entry.name)).toEqual(expected);
      for (const entry of states) {
        expect(['pass', 'degraded', 'failed', 'not_configured']).toContain(entry.state);
      }
      const doctorJson = await handle.doctor();
      expect(doctorJson.schema).toBe('apex.system.doctor/1');
      expect(doctorJson.checks.map((entry) => entry.name)).toEqual(expected);
      expect(doctorJson.withinBudget, `the doctor took ${doctorJson.durationMs} ms`).toBe(true);
      expect(doctorJson.checks.filter((entry) => entry.name === 'stores_integrity')[0].state,
        'the store check reads the stores this session wrote').not.toBe('not_configured');
      expect(doctorJson.checks.filter((entry) => entry.name === 'capability_inventory')[0].state).toBe('pass');
      expect(doctorJson.checks.filter((entry) => entry.name === 'workspace_sensor')[0].state).toBe('pass');
      const statusText = (await page.locator('#doctor-status').textContent()) ?? '';
      // The page ran its own reading, so its duration is its own; what must agree is the shape and
      // the budget, and that the total names the states it counted.
      expect(statusText).toMatch(/\d+(\.\d+)? ms of a 500 ms budget/);
      expect(statusText).toContain('pass');
      expect(statusText).toContain('not configured');
      run.doctor = { states, status: doctorJson.status, durationMs: doctorJson.durationMs, withinBudget: doctorJson.withinBudget, statusText: statusText.trim() };
      step('doctor', run.doctor);
      await shot('doctor');

      // ---- the page stayed whole --------------------------------------------------------------
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(overflow.scrollWidth, `no horizontal overflow: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(overflow.clientWidth + 1);
      run.overflow = overflow;
      expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      run.consoleErrors = consoleErrors;
      run.pageErrors = pageErrors;
      step('clean', { overflow, consoleErrors: 0, pageErrors: 0 });
      await context.close();
    } catch (error) {
      run.failures.push({ error: String(error?.message ?? error).slice(0, 600), at: new Date().toISOString() });
      throw error;
    }
  });
});
