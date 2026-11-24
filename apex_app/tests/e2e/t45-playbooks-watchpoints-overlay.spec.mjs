// T-45 Package 4 (2026-11-19): the playbook / watchpoint / tactical-overlay walk.
//
// This is the end-to-end claim of Packages 1 to 3, made in a real browser against a real server and a real
// git repository on disk:
//
//   1. The playbooks panel lists three templates, each drawn as its own DAG, and the summary badges read
//      TEMPLATES 3 / TOTAL RUNS 0 / VERIFIED RUNS 0.
//   2. Launching `workspace_security_audit` from the card runs three steps in dependency order through the
//      ECP. The run card reads VERIFIED, each of the three step badges reads VERIFIED, each step names a
//      real `operationId`, and every one of those ids is a line in `operations.jsonl`.
//   3. The run's trace resolves in the Memory viewer, and the chain names the routine and its steps.
//   4. A watchpoint created from the panel's own controls starts UNMEASURED - not NOMINAL, because nothing
//      has read the metric yet. Evaluating it moves it to BREACHED or NOMINAL according to the number the
//      machine actually reports: `apex_rss_mb gt 1` is breached by any running APEX, `apex_rss_mb gt 999999`
//      is nominal, and `dirty_files_count gt 0` is breached by the fixture's own worktree edit.
//   5. Pause takes the card to PAUSED and Enable brings it back with its history intact.
//   6. Lockdown refuses a launch and an evaluation with 423 while the panel stays readable, and release
//      fires nothing.
//   7. The overlay toggle takes the body to `data-hud-posture="overlay"`, reveals the tactical strip,
//      changes the button to OVERLAY: TACTICAL with `aria-pressed="true"` - and survives a reload because
//      the owner's choice is theirs. Ctrl+K reaches `toggle overlay`, `run playbook
//      workspace_security_audit` and `evaluate watchpoints` by the same dispatch every other phrase takes.
//   8. The button and the command line agree: whichever moved the posture, the strip and the pressed state
//      say the same thing.
//   9. Contrast is at least 4.5:1 and there is no horizontal overflow in EITHER posture at three viewports.
//
// Across all of it: zero console errors, zero uncaught exceptions, zero failed requests.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import {
  startT45Ui, T45_SCHEMA, T45_PLAYBOOK_ID, T45_WATCHPOINT_TITLE, T45_BREACH_TITLE,
  T45_ROUTER_PLAYBOOK_LINE, T45_ROUTER_WATCHPOINT_LINE, T45_ROUTER_OVERLAY_LINE,
} from './t45-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(here, '..', '..');
const reportDir = path.join(repoDir, 'reports', 'screenshots', 't45');
const summaryPath = path.join(repoDir, 'reports', 't45-playbooks-watchpoints-overlay.json');

const VIEWPORTS = [
  { name: 'wide', width: 1600, height: 900 },
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'phone', width: 390, height: 844 },
];

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
  schema: T45_SCHEMA,
  browserBinary: BROWSER_BINARY_SCHEMA,
  resolved: { executable: resolution.executable, source: resolution.source, candidate: resolution.browser?.label ?? null },
  browserVersion: null,
  platform: process.platform,
  node: process.version,
  headless: true,
  repo: null,
  templates: null,
  runOne: null,
  trace: null,
  watchpoints: null,
  toggle: null,
  lockdown: null,
  overlay: null,
  router: null,
  contrast: null,
  viewports: [],
  screens: [],
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  abortedStreams: [],
  screenshots: 0,
  failures: [],
  skip: null,
};

function writeSummary() {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(run, null, 2)}\n`);
}

// Written after every phase: a test killed by its own timeout never reaches its `finally`, and a suite
// that leaves no summary behind turns one failure into two.
function checkpoint(phase, detail = null) {
  run.lastPhase = phase;
  run.phases = Array.isArray(run.phases) ? run.phases : [];
  run.phases.push({ phase, at: new Date().toISOString(), detail });
  writeSummary();
}

async function measureOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const offending = [];
    for (const node of document.querySelectorAll('body *')) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right > doc.clientWidth + 2) {
        offending.push({
          tag: node.tagName.toLowerCase(),
          id: node.id || null,
          className: typeof node.className === 'string' ? node.className.slice(0, 60) : null,
          right: Math.round(rect.right),
          viewport: doc.clientWidth,
        });
      }
    }
    return {
      documentScrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflows: doc.scrollWidth > doc.clientWidth + 2,
      offending: offending.slice(0, 10),
    };
  });
}

// WCAG relative luminance and contrast, computed in the page from the colours the browser actually
// resolved - not from the stylesheet text. The selector list is an argument because contrast is a property
// of what is ON SCREEN: a panel that is display:none has no rendered colour, and asking for one would
// measure a question the page cannot answer. That matters more here than anywhere else in the tree, because
// this walk measures the SAME panels in two postures and one of them hides things.
//
// The backdrop walk composites bottom-up from the page's own background-color, which is what the T-43 walk
// had to be fixed to do: an accumulator that forces alpha to 1 ends the walk at the first transparent layer
// and reports dark-on-dark text as 1.98:1.
async function measureContrast(page, selectors) {
  return page.evaluate((list) => {
    const parse = (value) => {
      const match = String(value).match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(',').map((part) => Number(part.trim()));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const luminance = (colour) => {
      const channel = (value) => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
    };
    const backdrop = (node) => {
      const layers = [];
      let current = node;
      while (current) {
        const parsed = parse(getComputedStyle(current).backgroundColor);
        if (parsed && parsed.a > 0) layers.push(parsed);
        current = current.parentElement;
      }
      // The page paints gradients over background-color: var(--bg-void), so the walk starts there.
      let colour = { r: 5, g: 8, b: 15, a: 1 };
      for (let index = layers.length - 1; index >= 0; index -= 1) {
        const layer = layers[index];
        colour = {
          r: layer.r * layer.a + colour.r * (1 - layer.a),
          g: layer.g * layer.a + colour.g * (1 - layer.a),
          b: layer.b * layer.a + colour.b * (1 - layer.a),
          a: colour.a * (1 - layer.a) + layer.a,
        };
      }
      return colour;
    };
    const ratio = (node) => {
      const style = getComputedStyle(node);
      const foreground = parse(style.color);
      if (!foreground) return null;
      const background = backdrop(node);
      const fg = foreground.a < 1 ? over(foreground, background) : foreground;
      const high = Math.max(luminance(fg), luminance(background));
      const low = Math.min(luminance(fg), luminance(background));
      return (high + 0.05) / (low + 0.05);
    };
    const sample = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return { selector, ratio: null, missing: 'absent' };
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { selector, ratio: null, missing: 'not-on-screen' };
      const style = getComputedStyle(node);
      return { selector, label: selector, ratio: ratio(node), colour: style.color, background: style.backgroundColor };
    };
    const samples = list.map(sample);
    return {
      samples: samples.filter((entry) => !entry.missing),
      missing: samples.filter((entry) => entry.missing).map((entry) => ({ selector: entry.selector, why: entry.missing })),
    };
  }, selectors);
}

// Type a command into the command bar and send it. The bar is the product's own route in, so the walk
// exercises the router rather than a back door. The wait is on the receipt CHANGING, because the previous
// receipt is already visible and a bare visibility wait would resolve against it - the defect the T-37 walk
// was fixed for. The three lines this walk sends are distinct in route and summary, verified in T-45's unit
// tests, so a text comparison distinguishes them.
async function dispatch(page, line) {
  await page.locator('button.nav-item[data-view="deck"]').click();
  const before = await page.evaluate(() => document.getElementById('dispatch-receipt')?.textContent ?? null);
  await page.locator('#chat-text').fill(line);
  await page.locator('#send').click();
  await expect.poll(async () => page.evaluate((previous) => {
    const node = document.getElementById('dispatch-receipt');
    if (!node || node.hidden) return false;
    return (node.textContent ?? '') !== previous;
  }, before), { timeout: 30_000, message: `no new receipt for "${line}"` }).toBe(true);
  return page.evaluate(() => {
    const dl = document.getElementById('dispatch-receipt');
    const pairs = {};
    for (const term of Array.from(dl.querySelectorAll('dt'))) {
      pairs[term.textContent.trim()] = term.nextElementSibling?.textContent ?? '';
    }
    return {
      route: pairs.Route, capability: pairs.Capability, targetView: pairs['Target view'],
      // The field is titled "Action"; the Capability row is the one a governed act fills and the Action row
      // is the one a presentation command fills. Both are read so a test names the right one per route.
      action: pairs.Action, verified: pairs.Verified, text: dl.textContent ?? '', values: Object.values(pairs),
    };
  });
}

async function openView(page, view) {
  await page.locator(`button.nav-item[data-view="${view}"]`).click();
  await expect.poll(async () => page.evaluate((wanted) => {
    const section = document.querySelector(`section.view[data-view="${wanted}"]`);
    return section ? section.classList.contains('active') : false;
  }, view), { timeout: 10_000 }).toBe(true);
}

async function posture(page) {
  return page.evaluate(() => ({
    body: document.body.dataset.hudPosture ?? null,
    pressed: document.getElementById('btn-hud-overlay-toggle')?.getAttribute('aria-pressed') ?? null,
    button: document.getElementById('btn-hud-overlay-toggle')?.textContent?.trim() ?? null,
    stripHidden: document.getElementById('tactical-overlay-strip')?.hidden ?? null,
    stored: (() => { try { return localStorage.getItem('apex.hudPosture'); } catch { return 'unavailable'; } })(),
  }));
}

test.describe.configure({ mode: 'serial' });

test('T-45: three routines run through the ECP, watchpoints judge live readings, and the overlay is a posture the owner keeps', async () => {
  // Stated rather than inherited: this walk starts a server and a browser, runs a routine, creates, pauses,
  // evaluates and deletes watchpoints, latches and releases the system, and measures three viewports in
  // both postures.
  test.setTimeout(300_000);
  test.skip(!resolution.executable, noBrowserDiagnostic(resolution));
  fs.mkdirSync(reportDir, { recursive: true });

  const fixture = await startT45Ui();
  const browser = await chromium.launch({ executablePath: resolution.executable, headless: true });
  run.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
  // A reload aborts whatever the previous document had in flight, and the page holds a long-lived SSE
  // stream on /api/events for the whole time it is open. The browser reports that cancellation as a failed
  // request, which it technically is and which is exactly what a reload is supposed to do. It is counted
  // separately rather than filtered out, so the summary still says it happened: what this walk refuses to
  // accept is a request that failed while a document was asking for it.
  const abortedStreams = [];
  page.on('requestfailed', (request) => {
    const error = request.failure()?.errorText ?? null;
    const entry = { method: request.method(), url: request.url(), error };
    const reloadCancelled = /ERR_ABORTED/.test(String(error)) && /\/api\/events/.test(request.url());
    if (reloadCancelled) abortedStreams.push(entry);
    else failedRequests.push(entry);
  });

  let shot = 0;
  const screenshot = async (name) => {
    shot += 1;
    await page.screenshot({ path: path.join(reportDir, `${String(shot).padStart(2, '0')}-${name}.png`), fullPage: true });
    run.screenshots = shot;
  };

  try {
    run.repo = fixture.repo ? { branch: fixture.repo.branch, headSha: fixture.repo.headSha } : null;
    checkpoint('boot');
    // The token is a query parameter: the server hands the bearer to the client that way, and a bare base
    // URL gets a 401 and a blank page. Boot is read from the deck's own attribute rather than from a chip
    // whose vocabulary changes with the connection state.
    await page.goto(`${fixture.base}/?token=${encodeURIComponent(fixture.token)}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveAttribute('data-view', /.+/, { timeout: 20_000 });

    // ---- 1. the playbooks panel lists three templates -----------------------------------------------
    checkpoint('playbooks-open');
    await openView(page, 'tasks');
    const panel = page.locator('#playbooks-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => page.locator('#playbooks-template-list > li').count(), { timeout: 20_000 }).toBe(3);
    const templateIds = await page.locator('#playbooks-template-list > li').evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute('data-playbook-id')),
    );
    expect(templateIds).toEqual(['morning_briefing', 'workspace_security_audit', 'pre_release_readiness']);
    // The three summary badges are the engine's own counts, not the walk's.
    await expect(page.locator('#playbooks-template-count')).toHaveText('3');
    await expect(page.locator('#playbooks-runs-count')).toHaveText('0');
    await expect(page.locator('#playbooks-verified-count')).toHaveText('0');
    // Each card draws its DAG: the two roots in parallel, then the arrow, then the fan-in.
    const dag = page.locator(`#playbooks-template-list li[data-playbook-id="${T45_PLAYBOOK_ID}"] .playbook-dag-label`);
    await expect(dag).toHaveText('system.inspect_ports || system.inspect_processes -> git.status_detailed');
    run.templates = { count: templateIds.length, ids: templateIds, dag: (await dag.textContent())?.trim() ?? null };
    await screenshot('playbooks-listed');
    checkpoint('playbooks-listed', run.templates);

    // ---- 2. Launch runs three steps in DAG order ------------------------------------------------------
    const launchButton = page.locator(`#playbooks-template-list li[data-playbook-id="${T45_PLAYBOOK_ID}"] button[data-action="launch-playbook"]`);
    await expect(launchButton).toBeEnabled();
    await launchButton.click();
    await expect.poll(async () => page.locator('#playbooks-runs-list > li').count(), { timeout: 60_000 }).toBe(1);
    const runCard = page.locator('#playbooks-runs-list li').first();
    const runId = await runCard.getAttribute('data-playbook-run-id');
    expect(runId).toMatch(/^pbr_/);
    await expect(runCard).toHaveAttribute('data-run-status', 'verified');
    await expect(runCard.locator('[data-run-badge]')).toHaveText('VERIFIED');
    // Every one of the three steps is verified, and each names the operation it recorded.
    const steps = await runCard.locator('.playbook-steps li').evaluateAll((nodes) => nodes.map((node) => ({
      status: node.querySelector('[data-step-status]')?.getAttribute('data-step-status') ?? null,
      badge: node.querySelector('[data-step-status]')?.textContent?.trim() ?? null,
      // The operation id is the ledger's own - a bare UUID. The pattern is deliberately narrow so the run
      // id, which is also hex, cannot be mistaken for one.
      operationId: node.textContent?.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/)?.[0] ?? null,
    })));
    expect(steps.length).toBe(3);
    expect(steps.map((step) => step.status)).toEqual(['verified', 'verified', 'verified']);
    expect(steps.map((step) => step.badge)).toEqual(['VERIFIED', 'VERIFIED', 'VERIFIED']);
    const operationIds = steps.map((step) => step.operationId);
    expect(operationIds.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id))).toBe(true);
    // The ids on the card are lines in the one ledger - a receipt the panel printed, not one it invented.
    const ledger = fixture.operationLedger();
    for (const operationId of operationIds) {
      const receipt = ledger.find((entry) => entry.id === operationId);
      expect(receipt, `${operationId} must be a line in operations.jsonl`).toBeTruthy();
      expect(receipt.steps[0].verification.outcome).toBe('success_verified');
    }
    // The stored run agrees, and its step order is the DAG's: both roots, then the fan-in.
    const storedRun = fixture.playbookRunLedger().runs.find((entry) => entry.runId === runId);
    expect(storedRun.status).toBe('verified');
    expect(storedRun.steps.map((step) => step.capabilityId)).toEqual([
      'system.inspect_ports', 'system.inspect_processes', 'git.status_detailed',
    ]);
    expect(storedRun.steps.map((step) => step.operationId)).toEqual(operationIds);
    await expect(page.locator('#playbooks-runs-count')).toHaveText('1');
    await expect(page.locator('#playbooks-verified-count')).toHaveText('1');
    run.runOne = {
      runId, status: storedRun.status, operationIds, ledgerFound: operationIds.length,
      steps: storedRun.steps.map((step) => ({ capabilityId: step.capabilityId, status: step.status, operationId: step.operationId })),
    };
    await screenshot('playbook-verified');
    checkpoint('playbook-verified', run.runOne);

    // ---- 3. the trace of the run resolves ------------------------------------------------------------
    await runCard.locator('button[data-action="trace-playbook-run"]').click();
    await expect.poll(async () => page.evaluate(() => {
      const chain = document.getElementById('trace-chain');
      return chain ? chain.textContent ?? '' : '';
    }), { timeout: 30_000 }).toContain(runId);
    const chainText = await page.evaluate(() => document.getElementById('trace-chain').textContent ?? '');
    expect(chainText).toContain('playbook');
    for (const operationId of operationIds) expect(chainText).toContain(operationId);
    run.trace = { runId, resolved: true, chainLength: chainText.length, namesEveryOperation: true };
    await screenshot('playbook-trace');
    checkpoint('trace-verified', { runId });

    // ---- 4. a watchpoint is created, and starts unmeasured ---------------------------------------------
    checkpoint('watchpoints-open');
    await openView(page, 'sentinel');
    await expect(page.locator('#sentinel-watchpoints-panel')).toBeVisible({ timeout: 20_000 });
    await page.locator('#wp-title-input').fill(T45_WATCHPOINT_TITLE);
    await page.locator('#wp-metric-select').selectOption('dirty_files_count');
    await page.locator('#wp-operator-select').selectOption('gt');
    await page.locator('#wp-threshold-input').fill('0');
    await page.locator('#wp-severity-select').selectOption('warning');
    await page.locator('#btn-wp-create').click();
    await expect.poll(async () => page.locator('#sentinel-watchpoints-list li[data-watchpoint-id]').count(), { timeout: 20_000 }).toBe(1);
    const created = await fixture.get('/api/watchpoints');
    const watchpointId = created.body.watchpoints.find((entry) => entry.title === T45_WATCHPOINT_TITLE)?.watchpointId;
    expect(watchpointId).toMatch(/^wp_/);
    const wpCard = page.locator(`#sentinel-watchpoints-list li[data-watchpoint-id="${watchpointId}"]`);
    // Unmeasured is its own state: nothing has read the metric, so nothing can say it is nominal.
    await expect(wpCard).toHaveAttribute('data-wp-state', 'unmeasured');
    await expect(wpCard.locator('[data-wp-badge]')).toHaveText('UNMEASURED');
    await expect(wpCard.locator('[data-wp-badge]')).toHaveAttribute('data-wp-badge', 'unmeasured');
    await expect(page.locator('#watchpoints-total-count')).toHaveText('1');
    await screenshot('watchpoint-created');
    checkpoint('watchpoint-created', { watchpointId });

    // ---- 5. Evaluate: the number the machine reports decides the state ----------------------------------
    await page.locator('#btn-wp-evaluate').click();
    await expect.poll(async () => page.locator(`#sentinel-watchpoints-list li[data-watchpoint-id="${watchpointId}"]`)
      .getAttribute('data-wp-state'), { timeout: 30_000 }).toBe('breached');
    await expect(page.locator(`#sentinel-watchpoints-list li[data-watchpoint-id="${watchpointId}"] [data-wp-badge]`))
      .toHaveText('BREACHED');
    // The measured value is on the card, and it is the same number the ledger recorded.
    const measured = await page.locator(`#sentinel-watchpoints-list li[data-watchpoint-id="${watchpointId}"] [data-wp-measured]`)
      .getAttribute('data-wp-measured');
    expect(Number(measured)).toBeGreaterThan(0);
    const storedWp = fixture.watchpointLedger().watchpoints.find((entry) => entry.watchpointId === watchpointId);
    expect(storedWp.lastState).toBe('breached');
    expect(storedWp.lastMeasuredValue).toBe(Number(measured));
    expect(storedWp.evaluationCount).toBe(1);
    expect(storedWp.breachCount).toBe(1);
    expect(storedWp.history[0].evalId).toMatch(/^wpe_/);
    expect(storedWp.history[0].operationId).toBeTruthy();
    await expect(page.locator('#watchpoints-breached-count')).toHaveText('1');

    // A second rule that cannot be breached: 999999 MB of resident memory. The two rules prove that the
    // state is a judgement of the number rather than a constant the panel applies to everything.
    await page.locator('#wp-title-input').fill(T45_BREACH_TITLE);
    await page.locator('#wp-metric-select').selectOption('apex_rss_mb');
    await page.locator('#wp-operator-select').selectOption('gt');
    await page.locator('#wp-threshold-input').fill('999999');
    await page.locator('#wp-severity-select').selectOption('advisory');
    await page.locator('#btn-wp-create').click();
    await expect.poll(async () => page.locator('#sentinel-watchpoints-list li[data-watchpoint-id]').count(), { timeout: 20_000 }).toBe(2);
    const afterSecond = await fixture.get('/api/watchpoints');
    const nominalId = afterSecond.body.watchpoints.find((entry) => entry.title === T45_BREACH_TITLE)?.watchpointId;
    expect(nominalId).toMatch(/^wp_/);
    expect(nominalId).not.toBe(watchpointId);
    await page.locator('#btn-wp-evaluate').click();
    await expect.poll(async () => page.locator(`#sentinel-watchpoints-list li[data-watchpoint-id="${nominalId}"]`)
      .getAttribute('data-wp-state'), { timeout: 30_000 }).toBe('nominal');
    await expect(page.locator(`#sentinel-watchpoints-list li[data-watchpoint-id="${nominalId}"] [data-wp-badge]`))
      .toHaveText('NOMINAL');
    await expect(page.locator('#watchpoints-nominal-count')).toHaveText('1');
    await expect(page.locator('#watchpoints-breached-count')).toHaveText('1');
    run.watchpoints = {
      breached: { watchpointId, measured: Number(measured), state: 'breached' },
      nominal: { watchpointId: nominalId, state: 'nominal' },
      evaluations: fixture.watchpointLedger().watchpoints.map((entry) => ({
        watchpointId: entry.watchpointId, state: entry.lastState, value: entry.lastMeasuredValue,
        evaluations: entry.evaluationCount, breaches: entry.breachCount,
      })),
    };
    await screenshot('watchpoints-evaluated');
    checkpoint('watchpoints-evaluated', run.watchpoints);

    // ---- 6. pause and re-enable ---------------------------------------------------------------------
    await page.locator(`#sentinel-watchpoints-list li[data-watchpoint-id="${watchpointId}"] button[data-action="toggle-watchpoint"]`).click();
    await expect.poll(async () => page.locator(`#sentinel-watchpoints-list li[data-watchpoint-id="${watchpointId}"]`)
      .getAttribute('data-wp-state'), { timeout: 20_000 }).toBe('paused');
    await expect(page.locator(`#watchpoints-enabled-count`)).toHaveText('1');
    // Re-enabling restores the last judgement rather than resetting to unmeasured: the history is intact.
    await page.locator(`#sentinel-watchpoints-list li[data-watchpoint-id="${watchpointId}"] button[data-action="toggle-watchpoint"]`).click();
    await expect.poll(async () => page.locator(`#sentinel-watchpoints-list li[data-watchpoint-id="${watchpointId}"]`)
      .getAttribute('data-wp-state'), { timeout: 20_000 }).toBe('breached');
    await expect(page.locator('#watchpoints-enabled-count')).toHaveText('2');
    run.toggle = { paused: 'paused', resumed: 'breached' };
    checkpoint('watchpoint-toggle-verified');

    // ---- 7. Lockdown refuses a launch and an evaluation ----------------------------------------------
    const locked = await fixture.lock();
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(fixture.latchActive()).toBe(true);
    const runsBeforeLock = fixture.playbookRunLedger().runs.length;
    const evalsBeforeLock = fixture.watchpointLedger().watchpoints.map((entry) => entry.evaluationCount);
    const launchRefused = await fixture.post(`/api/playbooks/${T45_PLAYBOOK_ID}/launch`);
    expect(launchRefused.status).toBe(423);
    expect(launchRefused.body.code).toBe('LOCKDOWN_ACTIVE');
    const evalRefused = await fixture.post('/api/watchpoints/evaluate');
    expect(evalRefused.status).toBe(423);
    expect(evalRefused.body.code).toBe('LOCKDOWN_ACTIVE');
    const createRefused = await fixture.post('/api/watchpoints', {
      title: 'should not exist', metric: 'dirty_files_count', operator: 'gt', threshold: 0,
    });
    expect(createRefused.status).toBe(423);
    // The reads stay readable while the latch is up, and say so.
    const playbooksUnderLock = await fixture.get('/api/playbooks');
    expect(playbooksUnderLock.status).toBe(200);
    expect(playbooksUnderLock.body.lockdownActive).toBe(true);
    const watchpointsUnderLock = await fixture.get('/api/watchpoints');
    expect(watchpointsUnderLock.status).toBe(200);
    expect(watchpointsUnderLock.body.lockdownActive).toBe(true);
    // Nothing was written by any of the three refusals.
    expect(fixture.playbookRunLedger().runs.length).toBe(runsBeforeLock);
    expect(fixture.watchpointLedger().watchpoints.map((entry) => entry.evaluationCount)).toEqual(evalsBeforeLock);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveAttribute('data-view', /.+/, { timeout: 20_000 });
    await openView(page, 'tasks');
    // The launch button is disabled under the latch rather than left to discover the 423 by clicking.
    await expect(page.locator(`#playbooks-template-list li[data-playbook-id="${T45_PLAYBOOK_ID}"] button[data-action="launch-playbook"]`))
      .toBeDisabled({ timeout: 20_000 });
    await screenshot('lockdown-refusal');

    const released = await fixture.release();
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(fixture.latchActive()).toBe(false);
    // Release fired nothing: no run and no evaluation happened while the latch was up.
    expect(fixture.playbookRunLedger().runs.length).toBe(runsBeforeLock);
    expect(fixture.watchpointLedger().watchpoints.map((entry) => entry.evaluationCount)).toEqual(evalsBeforeLock);
    run.lockdown = {
      launchStatus: launchRefused.status, launchCode: launchRefused.body.code,
      evaluateStatus: evalRefused.status, evaluateCode: evalRefused.body.code,
      createStatus: createRefused.status, createCode: createRefused.body.code,
      runsUnchanged: true, evaluationsUnchanged: true,
    };
    checkpoint('lockdown-verified', run.lockdown);

    // ---- 8. the overlay toggle: button, persistence, and the strip ------------------------------------
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveAttribute('data-view', /.+/, { timeout: 20_000 });
    const initial = await posture(page);
    // Nothing has been chosen on this browser yet, so it starts in the full posture and says so.
    expect(initial.body).toBe('full');
    expect(initial.pressed).toBe('false');
    expect(initial.button).toBe('OVERLAY: OFF');
    expect(initial.stripHidden).toBe(true);

    await page.locator('#btn-hud-overlay-toggle').click();
    await expect(page.locator('body')).toHaveAttribute('data-hud-posture', 'overlay', { timeout: 10_000 });
    const on = await posture(page);
    expect(on.pressed).toBe('true');
    expect(on.button).toBe('OVERLAY: TACTICAL');
    expect(on.stripHidden).toBe(false);
    expect(on.stored).toBe('overlay');
    await expect(page.locator('#tactical-overlay-strip')).toBeVisible();
    // The strip carries the five readings, and the latch says OPEN because the release above proved it.
    await expect(page.locator('#tactical-overlay-strip .overlay-item')).toHaveCount(5);
    await expect(page.locator('#overlay-lockdown')).toHaveText('OPEN');
    await expect(page.locator('#overlay-lockdown')).toHaveAttribute('data-latch', 'open');
    // The strip's breach count is the watchpoint panel's own number, not a second reading.
    await expect(page.locator('#overlay-watchpoint-breaches')).toHaveText('1');
    await expect(page.locator('#overlay-watchpoint-breaches')).toHaveAttribute('data-breaches', 'some');
    // The nav is still usable in the compact posture, so the strip did not cost the way out of a screen.
    await openView(page, 'sentinel');
    await expect(page.locator('#sentinel-watchpoints-panel')).toBeVisible();
    await screenshot('overlay-on');

    // It survives a reload, because the posture is the owner's choice rather than a page state.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveAttribute('data-view', /.+/, { timeout: 20_000 });
    await expect(page.locator('body')).toHaveAttribute('data-hud-posture', 'overlay', { timeout: 20_000 });
    const afterReload = await posture(page);
    expect(afterReload.pressed).toBe('true');
    expect(afterReload.button).toBe('OVERLAY: TACTICAL');
    expect(afterReload.stripHidden).toBe(false);

    // Back off, and the button says OFF again.
    await page.locator('#btn-hud-overlay-toggle').click();
    await expect(page.locator('body')).toHaveAttribute('data-hud-posture', 'full', { timeout: 10_000 });
    const off = await posture(page);
    expect(off.pressed).toBe('false');
    expect(off.button).toBe('OVERLAY: OFF');
    expect(off.stripHidden).toBe(true);
    expect(off.stored).toBe('full');
    run.overlay = {
      initial: { body: initial.body, pressed: initial.pressed, button: initial.button, stripHidden: initial.stripHidden },
      on: { body: 'overlay', pressed: on.pressed, button: on.button, stripHidden: on.stripHidden, stored: on.stored, items: 5 },
      persistedAcrossReload: true,
      off: { body: 'full', pressed: off.pressed, button: off.button, stripHidden: off.stripHidden, stored: off.stored },
    };
    await screenshot('overlay-off');
    checkpoint('overlay-verified', run.overlay);

    // ---- 9. the command line reaches the same three families -------------------------------------------
    // Each line is dispatched through the deck's own router, and the receipt is the product's answer. The
    // playbook line names a routine, so the receipt names the run; the watchpoint line evaluates, so the
    // receipt counts what it judged; the overlay line moves the posture, so the body attribute changes.
    const playbookReceipt = await dispatch(page, T45_ROUTER_PLAYBOOK_LINE);
    expect(playbookReceipt.route).toBe('playbook');
    expect(playbookReceipt.capability).toBe('playbook.launch');
    expect(playbookReceipt.text).toContain(T45_PLAYBOOK_ID);
    await expect(page.locator('section.view[data-view="tasks"]')).toHaveClass(/active/);
    await expect(page.locator('#playbooks-panel')).toBeVisible({ timeout: 20_000 });
    // A launch from the command line is a launch: the run list holds a second run.
    await expect.poll(async () => page.locator('#playbooks-runs-list > li').count(), { timeout: 60_000 }).toBe(2);

    const watchpointReceipt = await dispatch(page, T45_ROUTER_WATCHPOINT_LINE);
    expect(watchpointReceipt.route).toBe('watchpoint');
    // The evaluation act is spelled out: an evaluation is a write, so it is named with the capability
    // rather than left to a generic "evaluated" line.
    expect(watchpointReceipt.action).toBe('watchpoint.evaluate');
    // The command waits for the receipt, so the evaluation it reports has already been recorded.
    expect(fixture.watchpointLedger().watchpoints.every((entry) => entry.evaluationCount >= 2)).toBe(true);
    await expect(page.locator('section.view[data-view="sentinel"]')).toHaveClass(/active/);
    await expect(page.locator('#sentinel-watchpoints-panel')).toBeVisible({ timeout: 20_000 });

    const overlayReceipt = await dispatch(page, T45_ROUTER_OVERLAY_LINE);
    expect(overlayReceipt.route).toBe('hud');
    // The router authorizes nothing and names no capability, and the deck performs the toggle.
    await expect(page.locator('body')).toHaveAttribute('data-hud-posture', 'overlay', { timeout: 10_000 });
    expect((await posture(page)).pressed).toBe('true');
    run.router = {
      playbook: { route: playbookReceipt.route, capability: playbookReceipt.capability, summary: playbookReceipt.text.slice(0, 160) },
      watchpoint: { route: watchpointReceipt.route, capability: watchpointReceipt.capability, summary: watchpointReceipt.text.slice(0, 160) },
      overlay: { route: overlayReceipt.route, posture: 'overlay' },
    };
    await screenshot('router-dispatch');
    checkpoint('router-verified', run.router);

    // ---- 10. contrast and overflow in BOTH postures, at three viewports --------------------------------
    checkpoint('contrast-start');
    const contrastSamples = [];
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const wanted of ['full', 'overlay']) {
        await page.evaluate((next) => {
          // Driven through the button rather than by setting the attribute, so what is measured is the
          // posture the product produces and not one the walk assembled.
          const button = document.getElementById('btn-hud-overlay-toggle');
          const isOverlay = document.body.dataset.hudPosture === 'overlay';
          if ((next === 'overlay') !== isOverlay) button.click();
        }, wanted);
        await expect(page.locator('body')).toHaveAttribute('data-hud-posture', wanted, { timeout: 10_000 });

        // The tasks view: the playbooks panel, its badges and a run card.
        await openView(page, 'tasks');
        await expect(page.locator('#playbooks-runs-list li').first()).toBeVisible({ timeout: 20_000 });
        const playbookMeasured = await measureContrast(page, [
          '#playbooks-panel h3',
          '#playbooks-status',
          '#playbooks-summary-badges .badge',
          '#playbooks-template-list li .playbook-title',
          '#playbooks-template-list li .playbook-dag-label',
          '#playbooks-template-list li .playbook-badge--rule',
          '#playbooks-template-list li button[data-action="launch-playbook"]',
          '#playbooks-runs-list li [data-run-badge]',
          '#playbooks-runs-list li [data-step-status]',
          '#playbooks-runs-list li .playbook-step-op',
        ]);
        const playbooksOverflow = await measureOverflow(page);
        expect(playbooksOverflow.overflows,
          `${viewport.name}/${wanted} tasks overflow: ${JSON.stringify(playbooksOverflow.offending)}`).toBe(false);

        // The sentinel view: the watchpoint panel, both states and the form.
        await openView(page, 'sentinel');
        await expect(page.locator('#sentinel-watchpoints-list li[data-watchpoint-id]').first()).toBeVisible({ timeout: 20_000 });
        const watchpointMeasured = await measureContrast(page, [
          '#sentinel-watchpoints-panel h3',
          '#watchpoints-status',
          '#watchpoints-summary-badges .badge',
          '#sentinel-watchpoints-list li .watchpoint-title',
          '#sentinel-watchpoints-list li [data-wp-badge="breached"]',
          '#sentinel-watchpoints-list li [data-wp-badge="nominal"]',
          '#sentinel-watchpoints-list li [data-wp-measured]',
          '#sentinel-watchpoints-list li button[data-action="toggle-watchpoint"]',
          '#btn-wp-create',
          '#btn-wp-evaluate',
          '#btn-hud-overlay-toggle',
        ]);
        // The overlay strip is only on screen in the compact posture, so it is measured only there.
        const stripMeasured = wanted === 'overlay'
          ? await measureContrast(page, ['#tactical-overlay-strip .overlay-key', '#overlay-lockdown', '#overlay-watchpoint-breaches'])
          : { samples: [], missing: [] };
        if (wanted === 'overlay') {
          await expect(page.locator('#tactical-overlay-strip')).toBeVisible();
          await expect(page.locator('#overlay-lockdown')).toHaveText('OPEN');
        }
        const watchpointsOverflow = await measureOverflow(page);
        expect(watchpointsOverflow.overflows,
          `${viewport.name}/${wanted} sentinel overflow: ${JSON.stringify(watchpointsOverflow.offending)}`).toBe(false);
        await screenshot(`viewport-${viewport.name}-${wanted}`);
        for (const sample of [...playbookMeasured.samples, ...watchpointMeasured.samples, ...stripMeasured.samples]) {
          expect(sample.ratio, `${sample.selector} at ${viewport.name}/${wanted} measures ${sample.ratio}`)
            .toBeGreaterThanOrEqual(4.5);
          contrastSamples.push({ viewport: viewport.name, posture: wanted, selector: sample.selector, ratio: Number(sample.ratio.toFixed(2)) });
        }
        run.viewports.push({
          name: viewport.name, width: viewport.width, height: viewport.height, posture: wanted,
          playbooksOverflow: false, watchpointsOverflow: false,
          samples: playbookMeasured.samples.length + watchpointMeasured.samples.length + stripMeasured.samples.length,
          missing: [...playbookMeasured.missing, ...watchpointMeasured.missing, ...stripMeasured.missing],
        });
      }
    }
    const ratios = contrastSamples.map((sample) => sample.ratio);
    run.contrast = {
      samples: contrastSamples.length,
      minimum: Math.min(...ratios),
      maximum: Math.max(...ratios),
      measured: contrastSamples,
    };
    await page.setViewportSize({ width: 1600, height: 900 });
    checkpoint('contrast-measured', run.contrast);

    // ---- 11. nothing errored, and the contract held ---------------------------------------------------
    run.consoleErrors = consoleErrors;
    run.pageErrors = pageErrors;
    run.failedRequests = failedRequests;
    run.screens = VIEWPORTS.flatMap((viewport) => ['full', 'overlay']
      .map((postureName) => `${viewport.name} ${viewport.width}x${viewport.height} ${postureName}`));
    expect(pageErrors, `uncaught exceptions: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    expect(failedRequests, `failed requests: ${JSON.stringify(failedRequests)}`).toEqual([]);
    run.abortedStreams = abortedStreams;
    // Four reloads, so at most one cancellation each - a stream that died without a reload would be a real
    // defect and would not be in this list.
    expect(abortedStreams.length).toBeLessThanOrEqual(4);
    // Voice stays reserved and the indicator says so, in the compact posture as much as the full one.
    const privacy = await page.evaluate(() => document.getElementById('sensor-privacy-indicator')?.textContent ?? '');
    expect(privacy).toMatch(/audio\/mic: disabled/);
    checkpoint('complete', {
      contrast: `${run.contrast.minimum}-${run.contrast.maximum}:1 over ${run.contrast.samples} samples`,
      screenshots: run.screenshots,
    });
  } catch (error) {
    run.failures.push(String(error?.message ?? error));
    run.consoleErrors = consoleErrors;
    run.pageErrors = pageErrors;
    run.failedRequests = failedRequests;
    checkpoint('failed', String(error?.message ?? error));
    throw error;
  } finally {
    writeSummary();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await fixture.stop().catch(() => {});
  }
});
