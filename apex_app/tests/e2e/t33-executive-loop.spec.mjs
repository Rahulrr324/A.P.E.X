// T-33 Step 4 (2026-11-19): one real-browser session walking the whole 5-character loop.
//
// The claim this suite has to earn is the loop, end to end, in a real Chromium-family browser,
// against the shipped server and the shipped client:
//
//   Ctrl+K dispatch  ->  a T-29 intent through the five stages  ->  a perception sense with the
//   Sentinel's own suppression rule (two dismissals, then revoke)  ->  the TaskGraph DAG with its
//   checkpoint control (approve, then resume)  ->  a workshop verification and an ECP-gated
//   promotion  ->  the Core back to Idle, and dry wit restored only then (Part 4, Principle #10).
//
// Every checkpoint asserts the record before the paint: no verified badge before the backend says
// `verified: true`, no `witAllowed` before the Core is genuinely Idle, and no delivery claim that
// the governor did not make. The JSON summary the workflow reads is written from what the page and
// the API actually answered.
//
// When the host has no browser at all the suite skips with an explicit diagnostic. A skip is not a
// pass, and the report says which of the two happened.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import { startT33Ui, readLoopFacts, T33_SCHEMA } from './t33-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(here, '..', '..');
const reportDir = path.join(repoDir, 'reports', 'screenshots', 't33');
const summaryPath = path.join(repoDir, 'reports', 't33-executive-loop.json');

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
  schema: T33_SCHEMA,
  browserBinary: BROWSER_BINARY_SCHEMA,
  resolved: { executable: resolution.executable, source: resolution.source, candidate: resolution.browser?.label ?? null },
  browserVersion: null,
  platform: process.platform,
  node: process.version,
  headless: true,
  steps: [],
  screenshots: [],
  facts: null,
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
  // One short line first, because a long annotation can be truncated and a failure that is cut off
  // is a failure that was not reported.
  console.log(`T33_FAILURES ${JSON.stringify({ failures: run.failures, steps: run.steps.length, screenshots: run.screenshots.length })}`);
  console.log(`T33_LOOP_SUMMARY ${JSON.stringify(run)}`);
}

let handle = null;
let browser = null;

test.describe('T-33 executive loop, in a real browser', () => {
  test.skip(resolution.executable === null, noBrowserDiagnostic(resolution));

  test.beforeAll(async () => {
    fs.mkdirSync(reportDir, { recursive: true });
    handle = await startT33Ui();
    browser = await chromium.launch({ executablePath: resolution.executable, headless: true });
    run.browserVersion = browser.version();
  });

  test.afterAll(async () => {
    if (handle) run.facts = await readLoopFacts(handle).catch((error) => ({ error: String(error) }));
    if (browser) await browser.close().catch(() => {});
    if (handle) await handle.stop().catch(() => {});
    writeSummary();
  });

  test('the loop: dispatch, intent, perception, graph, workshop, approval, Idle', async () => {
    // Seven checkpoints, three governed writes and two navigations between them: the default 90 s is
    // for one page assertion, not for a session.
    test.setTimeout(300_000);
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
      const file = path.join(reportDir, `t33-${name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      run.screenshots.push({ name, file: path.relative(repoDir, file), ...pngSize(file) });
    };
    const nav = async (view) => {
      await page.locator(`nav .nav-item[data-view="${view}"]`).click();
      await expect(page.locator('body')).toHaveAttribute('data-view', view);
    };

    await page.goto(`${handle.base}/?token=${encodeURIComponent(handle.token)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('#main-content', { timeout: 20_000 });

    // ---- 0. the deck opens on the gated run the fixture recorded, and withholds wit ------------
    await expect(page.locator('#core-state')).toHaveText('Awaiting Approval', { timeout: 20_000 });
    await expect(page.locator('#exec-comms-headline')).toHaveAttribute('data-wit-allowed', 'false', { timeout: 20_000 });
    step('open', { core: 'Awaiting Approval', witAllowed: false });
    await shot('01-open-awaiting-approval');

    // ---- 1. Ctrl+K reaches the dispatch, Escape dismisses it ----------------------------------
    await page.keyboard.press('Control+k');
    await expect(page.locator('#chat-text')).toBeFocused({ timeout: 5_000 });
    await expect(page.locator('#activity')).toContainText('Command dispatch focused');
    await page.keyboard.press('Escape');
    await expect(page.locator('#chat-text')).not.toBeFocused({ timeout: 5_000 });
    step('dispatch', { ctrlK: 'focused', escape: 'dismissed' });

    // ---- 2. a T-29 intent through the five stages --------------------------------------------
    await nav('cognition');
    await page.locator('#cognition-intent').fill('what does memory hold about the T-33 loop');
    await page.locator('#cognition-action').selectOption('memory.search');
    await page.locator('#cognition-run').click();
    await expect(page.locator('#cognition-run-status')).toContainText('Recorded', { timeout: 30_000 });
    const trace = page.locator('#cognition-trace');
    for (const heading of ['1 · Context', '2 · Salience', '3 · Council', '4 · Task graph', '5 · Governed execution']) {
      await expect(trace).toContainText(heading, { timeout: 15_000 });
    }
    await expect(page.locator('#cognition-runs li')).not.toHaveCount(0, { timeout: 15_000 });
    step('intent', { stages: 5, council: 'rendered' });
    await shot('02-five-stage-trace');

    // ---- 3. a perception sense, then the Sentinel's own suppression rule ----------------------
    await nav('sentinel');
    await page.locator('#perception-sense').click();
    const alert = page.locator('#perception-alerts li[data-alert-class="workspace_dirty"]');
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toHaveAttribute('data-delivery', 'delivered', { timeout: 20_000 });
    // Delivery is the governor's answer; the reading is the sensor's.
    await expect(page.locator('#perception-status')).toContainText('observed', { timeout: 15_000 });
    // The rule itself is the evidence, not the prose: after the second dismissal the row says
    // suppressed and the rule carries its class, its dismissal count and its expiry in the DOM.
    await alert.locator('[data-action="dismiss-alert"]').click();
    await alert.locator('[data-action="dismiss-alert"]').click();
    await expect(alert).toHaveAttribute('data-delivery', 'suppressed', { timeout: 30_000 });
    const suppression = page.locator('#perception-suppressions li[data-rule-id]').first();
    await expect(suppression).toBeVisible({ timeout: 20_000 });
    const suppressedUntil = await suppression.getAttribute('data-suppressed-until');
    expect(suppressedUntil, 'the rule names its expiry').toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await suppression.getAttribute('data-dismissals'), 'the rule counts the two dismissals').toBe('2');
    step('suppression', { alertClass: 'workspace_dirty', dismissals: 2, suppressedUntil });
    await shot('03-suppression-rule');

    // Revoking the rule restores delivery. The governor deduplicates an unchanged condition, so the
    // machine is really changed first: a second untracked file, then a fresh reading.
    await suppression.locator('[data-action="revoke-suppression"]').click();
    await expect(page.locator('#perception-suppressions')).toContainText('No alert class is suppressed', { timeout: 20_000 });
    const dirt = handle.addUntrackedFile();
    expect(dirt.status, 'the fixture workspace now holds a second dirty path').toMatch(/\?\?/);
    await page.locator('#perception-sense').click();
    await expect(page.locator('#perception-alerts li[data-alert-class="workspace_dirty"]'))
      .toHaveAttribute('data-delivery', 'delivered', { timeout: 30_000 });
    step('revoke', { ruleRevoked: true, delivery: 'delivered' });

    // ---- 4. the TaskGraph DAG: state, verification, checkpoint approve then resume -------------
    await nav('missions');
    const graphStatus = page.locator('#dag-status');
    await expect(graphStatus).toContainText('node(s) completed', { timeout: 30_000 });
    const node = page.locator('#dag-nodes li[data-node-id]').first();
    await expect(node).toHaveAttribute('data-state', 'awaiting_approval', { timeout: 20_000 });
    await expect(node).toHaveAttribute('data-verified', 'false');
    // Honest cinema: no verified badge anywhere in the graph while nothing is verified.
    await expect(page.locator('#dag-nodes .dag-verified')).toHaveCount(0);
    await expect(page.locator('#dag-edges')).toContainText('edge', { timeout: 5_000 });
    await shot('04a-dag-gated');
    await expect(page.locator('#dag-approve')).toBeVisible();
    await page.locator('#dag-approve').click();
    await expect(page.locator('#dag-control-status')).toContainText('success_verified', { timeout: 30_000 });
    await expect(node).toHaveAttribute('data-state', 'pending', { timeout: 20_000 });
    await expect(page.locator('#dag-resume')).toBeVisible({ timeout: 20_000 });
    await page.locator('#dag-resume').click();
    await expect(page.locator('#dag-control-status')).toContainText('success_verified', { timeout: 45_000 });
    await expect(node).toHaveAttribute('data-state', 'completed', { timeout: 45_000 });
    await expect(node).toHaveAttribute('data-verified', 'true', { timeout: 20_000 });
    await expect(node.locator('.dag-verified')).toHaveCount(1);
    step('graph', { approved: true, resumed: true, verified: true });

    // ---- 5. Core back to Idle, and Principle #10 both ways ------------------------------------
    //
    // The approval is spent, so the Core settles. Wit is still withheld: the Sentinel holds a real
    // advisory about this machine, and the formatter treats a condition as a condition whether or
    // not its notice was delivered. Clearing the condition is what restores the voice.
    await nav('deck');
    await expect(page.locator('#core-state')).toHaveText('Idle', { timeout: 45_000 });
    await expect(page.locator('#exec-comms-headline')).toHaveAttribute('data-core', 'idle', { timeout: 20_000 });
    await expect(page.locator('#exec-comms-headline')).toHaveAttribute('data-wit-allowed', 'false', { timeout: 20_000 });
    await expect(page.locator('#exec-comms-tone')).toContainText('wit withheld', { timeout: 20_000 });
    await expect(page.locator('#exec-comms-tone')).toContainText('advisory', { timeout: 20_000 });
    step('idle', { core: 'Idle', witAllowed: false, because: 'an advisory is active' });
    await shot('05a-idle-advisory-withholds-wit');

    // The fixture commits its own change, so the tree really is clean; the next reading of the real
    // workspace says so, the advisory list empties, and only then does the voice allow wit.
    const tidied = handle.tidyWorkspace();
    expect(tidied.clean, 'the fixture workspace is clean after its own commit').toBe(true);
    // The sense control lives in the Sentinel workspace, so the walk goes there to use it. The
    // exec-comms panel is on the deck; its attributes are read after the reading changes.
    await nav('sentinel');
    await page.locator('#perception-sense').click();
    await expect(page.locator('#perception-alert-status')).toContainText('No advisory is implied', { timeout: 30_000 });
    await expect(page.locator('#perception-alerts')).toContainText('No advisory is implied', { timeout: 20_000 });
    await nav('deck');
    await expect(page.locator('#exec-comms-headline')).toHaveAttribute('data-wit-allowed', 'true', { timeout: 30_000 });
    await expect(page.locator('#exec-comms-tone')).toContainText('wit allowed', { timeout: 20_000 });
    step('idle-clear', { core: 'Idle', witAllowed: true, advisory: 'none implied by the last reading' });
    await shot('05b-wit-restored-only-when-clear');

    // ---- 6. the workshop loop: stage, verify, then the ECP-gated promotion ---------------------
    await nav('workshop');
    await expect(page.locator('#workshop')).toContainText('No design sheets are recorded', { timeout: 20_000 });
    await page.locator('#workshop-stage-telemetry').click();
    const artifact = page.locator('#workshop li[data-artifact-id]').first();
    await expect(artifact).toBeVisible({ timeout: 30_000 });
    await expect(artifact).toHaveAttribute('data-verified', 'false');
    await expect(artifact.locator('span.badge')).toHaveText('unverified');
    await expect(artifact.locator('[data-action="workshop-promote"]')).toBeDisabled();
    await shot('06a-workshop-unverified');
    await artifact.locator('[data-action="workshop-verify"]').click();
    await expect(artifact).toHaveAttribute('data-verified', 'true', { timeout: 45_000 });
    await expect(artifact.locator('span.badge').first()).toHaveText('verified');
    const verificationId = await artifact.locator('span.badge').first().getAttribute('data-verification');
    expect(verificationId, 'the badge names the verification it came from').toMatch(/^wsv-/);
    await shot('06b-workshop-verified');
    // The promotion asks for the owner's reason first: the dialog is the decision, not a formality.
    page.once('dialog', (dialog) => { dialog.accept('owner accepts the staged telemetry design'); });
    await artifact.locator('[data-action="workshop-promote"]').click();
    await expect(artifact).toHaveAttribute('data-promoted', 'true', { timeout: 45_000 });
    await expect(page.locator('#workshop-sandbox-status')).toContainText('promoted', { timeout: 20_000 });
    step('workshop', { verificationId, verified: true, promoted: true });
    await shot('07-workshop-promoted');

    // ---- 7. the page's own honesty: no console error, no page error ----------------------------
    expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    step('console', { errors: 0 });
    await context.close();
  });
});
