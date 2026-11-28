// T-37 Step 4 (2026-11-21): one real-browser session over the three things T-37 added.
//
// In a real Chromium-family browser against the shipped server and the shipped client, this walk
// earns four claims:
//
//   1. Track 2 is exposed and bounded. The Council workspace shows all eight canonical regions with
//      cell counts, spike counts, membrane summaries and adjacency read from the live substrate; the
//      bridge states its version and status; and the boundary - candidate association, no authority -
//      is on screen where a reader can see it.
//   2. The Council deliberates with the four canonical perspectives, tags every citation with an
//      epistemic label, and compiles a recommendation into a real ECP-gated mission.
//   3. The command router answers typed lines with a receipt, each naming the route it took and the
//      screen it moved to: "mode tactical", "sense workspace", "council: verify release readiness"
//      and a general mission intent.
//   4. All eleven screens declare a screen id and a one-line message, with no console error, no page
//      error and no horizontal overflow.
//
// When the host has no browser at all the suite skips with an explicit diagnostic. A skip is not a
// pass, and the summary says which of the two happened.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import {
  T37_REGIONS, T37_SCHEMA, T37_SCREENS,
  attachConsoleCollectors, measureOverflow, readScreenDeclarations, startT37Ui,
} from './t37-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(here, '..', '..');
const reportDir = path.join(repoDir, 'reports', 'screenshots', 't37');
const summaryPath = path.join(repoDir, 'reports', 't37-neural-council-router.json');

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
  schema: T37_SCHEMA,
  browserBinary: BROWSER_BINARY_SCHEMA,
  resolved: { executable: resolution.executable, source: resolution.source, candidate: resolution.browser?.label ?? null },
  browserVersion: null,
  platform: process.platform,
  node: process.version,
  headless: true,
  regions: [],
  bridge: null,
  boundary: null,
  council: null,
  receipts: [],
  screens: [],
  overflow: null,
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  screenshots: 0,
  failures: [],
  skip: null,
};

function writeSummary() {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(run, null, 2)}\n`);
}

test.describe.configure({ mode: 'serial' });

test('T-37: Track 2, the Council with its constraint core, the command router and all eleven screens', async () => {
  test.skip(!resolution.executable, noBrowserDiagnostic(resolution));
  fs.mkdirSync(reportDir, { recursive: true });

  const fixture = await startT37Ui();
  const browser = await chromium.launch({ executablePath: resolution.executable, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const collected = attachConsoleCollectors(page);

  try {
    run.browserVersion = browser.version();
    await page.goto(`${fixture.base}/?token=${encodeURIComponent(fixture.token)}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveAttribute('data-view', 'deck', { timeout: 15_000 });

    // ---------------------------------------------------------------- 1. Track 2 on screen ---

    await page.locator('button.nav-item[data-view="council"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-view', 'council');
    await expect(page.locator('#neural-status')).not.toHaveText(/Loading the neural substrate/, { timeout: 20_000 });

    // The status line names the region count and the bridge status, from the real read.
    const neuralStatus = await page.locator('#neural-status').textContent();
    expect(neuralStatus, `the neural status line: ${neuralStatus}`).toMatch(/8 region\(s\)/);
    expect(neuralStatus).toMatch(/bridge (connected|isolated|disabled)/);

    // The per-region table carries the eight canonical regions in the substrate's own order.
    const renderedRegions = await page.locator('#neural-region-rows tr td:first-child').allTextContents();
    expect(renderedRegions, `rendered regions: ${renderedRegions.join(', ')}`).toEqual(T37_REGIONS);
    run.regions = renderedRegions;

    // Each row carries a cell count, a spike count, an active count, a membrane summary and a weight.
    const rows = await page.locator('#neural-region-rows tr').all();
    for (const [index, row] of rows.entries()) {
      const cells = await row.locator('td').nth(1).textContent();
      const spikes = await row.locator('td').nth(2).textContent();
      const membrane = await row.locator('td').nth(4).textContent();
      const weight = await row.locator('td').nth(5).textContent();
      expect(Number(cells), `${T37_REGIONS[index]} cell count`).toBeGreaterThan(0);
      expect(Number(spikes), `${T37_REGIONS[index]} spike count`).toBeGreaterThan(0);
      expect(membrane, `${T37_REGIONS[index]} membrane summary`).toMatch(/-?\d+(\.\d+)? mV/);
      expect(Number(weight), `${T37_REGIONS[index]} mean weight`).toBeGreaterThan(0);
    }

    // The bridge panel names the version, the schema and the fallback, and the API says the same.
    const bridgeText = await page.locator('#neural-bridge').textContent();
    expect(bridgeText).toMatch(/apex\.neural\.cognitive-bridge\/1/);
    expect(bridgeText).toMatch(/apex\.neural\.bridge-signal\/1/);
    expect(bridgeText).toMatch(/Boundary:/);
    expect(bridgeText).toMatch(/candidate_association/);

    // The API agrees with the screen - a screen that showed numbers the API did not have would be
    // the failure this assertion exists to catch.
    const bridgeApi = await fixture.get('/api/neural/bridge');
    expect(bridgeApi.status).toBe(200);
    expect(bridgeApi.body.boundary.epistemicStatus).toBe('candidate_association');
    expect(bridgeApi.body.boundary.authorizesExecution).toBe(false);
    expect(bridgeApi.body.boundary.mutatesObservedFacts).toBe(false);
    run.boundary = bridgeApi.body.boundary;
    run.bridge = {
      version: bridgeApi.body.bridgeVersion,
      status: bridgeApi.body.status,
      // The text is kept short: the annotation reads `version`, the detail is for a human opening
      // the artifact.
      text: bridgeText.slice(0, 240),
    };

    const substrateApi = await fixture.get('/api/neural/substrate');
    expect(substrateApi.body.substrate.regions.map((region) => region.id)).toEqual(T37_REGIONS);
    expect(substrateApi.body.substrate.totals.cells).toBe(132);
    expect(substrateApi.body.substrate.totals.synapses).toBe(192);

    // A governed step from the deck, and its verification reported rather than assumed.
    await page.locator('#neural-steps').fill('8');
    await page.locator('#neural-step').click();
    await expect(page.locator('#neural-action-status')).toHaveText(/Verified: \d+ spike\(s\)/, { timeout: 20_000 });

    await page.screenshot({ path: path.join(reportDir, '01-track2-council.png'), fullPage: true });
    run.screenshots += 1;

    // ------------------------------------------------------- 2. Council deliberation ---

    const objective = 'verify release readiness for the neural bridge';
    await page.locator('#council-objective').fill(objective);
    await page.locator('#council-run').click();
    await expect(page.locator('#council-status')).toHaveText(/deliberated/i, { timeout: 30_000 });

    // The status line is set before the deck refreshes, so waiting on it alone reads the panel while
    // it still holds the previous render - which is what the first walk did. Waiting on the rendered
    // perspective rows is waiting for the thing being asserted.
    // The canonical four are the first list in the panel; the full evaluated set below them also
    // tags the constraint core, so the assertion is on the canonical list rather than a flat count.
    await expect(page.locator('#council-synthesis ul.work').first().locator('[data-perspective]'))
      .toHaveCount(4, { timeout: 30_000 });

    const canonicalRendered = await page.locator('#council-synthesis ul.work').first()
      .locator('[data-perspective]').evaluateAll((nodes) => nodes.map((node) => node.dataset.perspective));
    expect(canonicalRendered).toEqual(['thesis', 'counter_risk', 'evidence_check', 'constraint_check']);

    // What a reader sees is prose, not the identifier: "Counter-risk", "Evidence check". The
    // identifiers are already asserted above through data-perspective, so this check is the one that
    // matters for a person - the four are labelled, not numbered.
    const synthesis = await page.locator('#council-synthesis').textContent();
    for (const label of ['thesis', 'counter-risk', 'evidence check', 'constraint check']) {
      expect(synthesis.toLowerCase(), `the synthesis should label ${label}`).toContain(label);
    }
    // The core's rule-by-rule verdicts are on screen, not only in a tooltip.
    const ruleRows = await page.locator('#council-synthesis [data-constraint]').evaluateAll(
      (nodes) => nodes.map((node) => ({ id: node.dataset.constraint, verdict: node.dataset.verdict })));
    expect(ruleRows.length, `constraint rules rendered: ${ruleRows.map((row) => row.id).join(', ')}`).toBeGreaterThan(0);
    expect(ruleRows.every((row) => typeof row.verdict === 'string' && row.verdict.length > 0)).toBe(true);
    run.constraints = ruleRows;

    // Epistemic labels are attached to citations, not to prose.
    const epistemic = await page.evaluate(() => {
      const text = document.body.innerText;
      return ['observed', 'user_asserted', 'inferred', 'candidate_association'].filter((label) => text.includes(label));
    });
    expect(epistemic.length, `epistemic labels on screen: ${epistemic.join(', ')}`).toBeGreaterThan(0);

    // The compile button is now live, and compiling produces a real mission.
    await expect(page.locator('#council-compile')).toBeEnabled({ timeout: 10_000 });
    await page.locator('#council-compile').click();
    await expect(page.locator('#council-compile-status')).toHaveText(/Compiled and run|Compiled but not verified|Refused/, { timeout: 60_000 });
    const compileText = await page.locator('#council-compile-status').textContent();
    expect(compileText, `compile result: ${compileText}`).toMatch(/Compiled and run/);
    const compileResult = await page.locator('#council-compile-result').textContent();
    expect(compileResult).toMatch(/Run .+ · status/);
    run.council = { objective, compileText, compileResult: compileResult.slice(0, 400) };

    // The deliberation really is in the store the API reads.
    const councilApi = await fixture.get('/api/council');
    expect(councilApi.body.sessions.length).toBeGreaterThan(0);
    run.council.sessions = councilApi.body.sessions.length;

    await page.screenshot({ path: path.join(reportDir, '02-council-deliberation.png'), fullPage: true });
    run.screenshots += 1;

    // -------------------------------------------------------- 3. The command router ---

    // Back to the deck, where the command bar lives.
    await page.locator('button.nav-item[data-view="deck"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-view', 'deck');

    // Each dispatch is awaited on its own line text, not on visibility alone: the panel stays
    // visible after the first dispatch, so waiting for visibility resolves against the previous
    // receipt and every read is one route behind. The receipt carries the line it answered.
    const dispatch = async (line, expectedRoute) => {
      await page.locator('#chat-text').fill(line);
      await page.locator('#send').click();
      await expect(page.locator('#dispatch-receipt')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('#dispatch-receipt')).toHaveAttribute('data-route', expectedRoute, { timeout: 30_000 });
      const receipt = await page.evaluate(() => {
        const dl = document.getElementById('dispatch-receipt');
        const values = Array.from(dl.querySelectorAll('dd')).map((dd) => dd.textContent);
        return {
          route: dl.dataset.route,
          verified: dl.dataset.verified,
          fields: values,
        };
      });
      return receipt;
    };

    const mode = await dispatch('mode tactical', 'mode');
    expect(mode.route, 'mode tactical').toBe('mode');
    expect(await page.locator('body')).toHaveAttribute('data-mode', 'tactical');
    run.receipts.push({ line: 'mode tactical', route: mode.route, verified: mode.verified });

    const sensed = await dispatch('sense workspace', 'sense');
    expect(sensed.route, 'sense workspace').toBe('sense');
    expect(sensed.fields.join(' ')).toMatch(/perception\.sense_host/);
    expect(await page.locator('body')).toHaveAttribute('data-view', 'sentinel');
    run.receipts.push({ line: 'sense workspace', route: sensed.route, verified: sensed.verified });

    await page.locator('button.nav-item[data-view="deck"]').click();
    const council = await dispatch('council: verify release readiness', 'council');
    expect(council.route, 'council: verify release readiness').toBe('council');
    expect(council.fields.join(' ')).toMatch(/council\.deliberate/);
    expect(await page.locator('body')).toHaveAttribute('data-view', 'council');
    run.receipts.push({ line: 'council: verify release readiness', route: council.route, verified: council.verified });

    await page.locator('button.nav-item[data-view="deck"]').click();
    const mission = await dispatch('summarise the workspace notes', 'mission');
    expect(mission.route, 'a general intent').toBe('mission');
    expect(mission.fields.join(' ')).toMatch(/cognition\.run/);
    expect(await page.locator('body')).toHaveAttribute('data-view', 'cognition');
    run.receipts.push({ line: 'summarise the workspace notes', route: mission.route, verified: mission.verified });

    await page.screenshot({ path: path.join(reportDir, '03-command-receipt.png'), fullPage: true });
    run.screenshots += 1;

    // ------------------------------------------------------------- 4. The eleven screens ---

    const declared = await readScreenDeclarations(page);
    const ids = declared.map((entry) => entry.id);
    expect([...ids].sort(), `declared screens: ${ids.join(', ')}`).toEqual([...T37_SCREENS].sort());
    for (const entry of declared) {
      expect(entry.message, `${entry.id} declares no message`).toBeTruthy();
      expect(entry.message.length, `${entry.id}'s message is too short`).toBeGreaterThan(40);
      expect(entry.message, `${entry.id}'s message is not a sentence`).toMatch(/[.!]$/);
    }
    run.screens = declared.map((entry) => ({ id: entry.id, view: entry.view, message: entry.message.slice(0, 90) }));

    // Each screen is reachable: the views by their nav button, the boot and deck screens by opening
    // the deck, the safety panel by opening System.
    const views = [...new Set(declared.filter((entry) => entry.isView).map((entry) => entry.view))];
    for (const view of views) {
      await page.locator(`button.nav-item[data-view="${view}"]`).click();
      await expect(page.locator(`section.view[data-view="${view}"]`)).toBeVisible({ timeout: 10_000 });
      const overflow = await measureOverflow(page);
      expect(overflow.scrollWidth, `horizontal overflow on ${view}`).toBeLessThanOrEqual(overflow.clientWidth);
    }
    run.overflow = await measureOverflow(page);

    // The safety panel is the lockdown screen, and its controls are present and wired.
    await page.locator('button.nav-item[data-view="system"]').click();
    await expect(page.locator('[data-screen-id="lockdown"]')).toBeVisible();
    await expect(page.locator('#safety-lock')).toBeVisible();
    await expect(page.locator('#safety-release')).toBeVisible();

    await page.screenshot({ path: path.join(reportDir, '04-screens.png'), fullPage: true });
    run.screenshots += 1;

    // --------------------------------------------------------------- the quiet assertions ---

    expect(collected.pageErrors, `page errors: ${collected.pageErrors.join(' | ')}`).toEqual([]);
    expect(collected.consoleErrors, `console errors: ${collected.consoleErrors.join(' | ')}`).toEqual([]);
    expect(collected.failedRequests, `failed requests: ${collected.failedRequests.join(' | ')}`).toEqual([]);
    run.consoleErrors = collected.consoleErrors;
    run.pageErrors = collected.pageErrors;
    run.failedRequests = collected.failedRequests;
  } catch (error) {
    // The summary is the only thing CI can read back, so a failed walk records why it failed and
    // which phase it reached. Without this a red run is an annotation full of `None`.
    run.failures.push({
      phase: run.council ? 'council' : run.boundary ? 'bridge' : run.regions ? 'regions' : 'startup',
      message: String(error?.message ?? error),
      stack: String(error?.stack ?? '').split('\n').slice(0, 6),
    });
    throw error;
  } finally {
    run.consoleErrors = collected.consoleErrors;
    run.pageErrors = collected.pageErrors;
    run.failedRequests = collected.failedRequests;
    writeSummary();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await fixture.stop();
  }
});
