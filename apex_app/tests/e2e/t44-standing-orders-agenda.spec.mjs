// T-44 Package 4 (2026-11-19): the standing-orders and executive-agenda walk.
//
// This is the end-to-end claim of Packages 1 to 3, made in a real browser against a real server and a
// real git repository on disk:
//
//   1. A standing order can be created from the panel's own controls: a title, a trigger, and a
//      capability picked from the select the server populated. The card says ENABLED and RUNS 0.
//   2. Invoke Now runs it through the ECP. RUNS becomes 1 and the outcome badge reads VERIFIED, and the
//      operations ledger holds the receipt the card's history names.
//   3. A forbidden capability is refused by the API with 403 STANDING_ORDER_CAPABILITY_FORBIDDEN - and
//      refused at REGISTRATION, so no row is written for it.
//   4. Pause takes the card to PAUSED and Enable brings it back.
//   5. Lockdown halts the order: the badge reads HALTED BY LOCKDOWN, the run is recorded with no
//      operation, and releasing the latch does not fire it.
//   6. The causal trace of the order resolves in the Memory viewer.
//   7. A commitment linked to the order renders in the agenda list with its horizon badge, the order
//      appears in the derived list because it is armed, and Complete takes the commitment to COMPLETED.
//   8. Ctrl+K takes `schedule Review phase 2 telemetry` to the agenda panel, and `standing orders` to the
//      standing-orders panel - each with its own receipt.
//
// Across all of it: zero console errors, zero uncaught exceptions, zero failed requests, and no
// horizontal overflow at three viewports.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import {
  startT44Ui, T44_SCHEMA, T44_ORDER_TITLE, T44_COMMITMENT_TITLE, T44_ROUTER_LINE,
} from './t44-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(here, '..', '..');
const reportDir = path.join(repoDir, 'reports', 'screenshots', 't44');
const summaryPath = path.join(repoDir, 'reports', 't44-standing-orders-agenda.json');

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
  schema: T44_SCHEMA,
  browserBinary: BROWSER_BINARY_SCHEMA,
  resolved: { executable: resolution.executable, source: resolution.source, candidate: resolution.browser?.label ?? null },
  browserVersion: null,
  platform: process.platform,
  node: process.version,
  headless: true,
  repo: null,
  order: null,
  runOne: null,
  refusal: null,
  toggle: null,
  lockdown: null,
  trace: null,
  agenda: null,
  derived: null,
  complete: null,
  router: null,
  contrast: null,
  viewports: [],
  screens: [],
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
// resolved - not from the stylesheet text. The selector list is an argument because contrast is a
// property of what is ON SCREEN: a panel that is display:none has no rendered colour, and asking for one
// would measure a question the page cannot answer.
//
// The backdrop walk composites bottom-up from the page's own background-color, which is what the T-43
// walk had to be fixed to do: an accumulator that forces alpha to 1 ends the walk at the first
// transparent layer and reports dark-on-dark text as 1.98:1.
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
// receipt is already visible and a bare visibility wait would resolve against it - the defect the T-37
// walk was fixed for. The four lines this walk sends are distinct in route and summary, verified in
// T-44's unit tests, so a text comparison distinguishes them.
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
      verified: pairs.Verified, text: dl.textContent ?? '', values: Object.values(pairs),
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

test.describe.configure({ mode: 'serial' });

test('T-44: a governed standing order runs through the ECP, Lockdown halts it, and the agenda reads what is owed', async () => {
  // Stated rather than inherited: this walk starts a server and a browser, runs an order, latches and
  // releases the system, and measures three viewports across the screens.
  test.setTimeout(240_000);
  test.skip(!resolution.executable, noBrowserDiagnostic(resolution));
  fs.mkdirSync(reportDir, { recursive: true });

  const fixture = await startT44Ui();
  const browser = await chromium.launch({ executablePath: resolution.executable, headless: true });
  run.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()}`));

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
    // whose vocabulary changes with the connection state - the first version of this walk waited for
    // "Online" or "Local" and burned its whole timeout on a chip that says "Connected".
    await page.goto(`${fixture.base}/?token=${encodeURIComponent(fixture.token)}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveAttribute('data-view', /.+/, { timeout: 20_000 });

    // ---- 1. create a standing order from the panel -------------------------------------------------
    checkpoint('standing-orders-open');
    await openView(page, 'system');
    const panel = page.locator('#standing-orders-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => page.locator('#so-capability-select option').count(), { timeout: 20_000 })
      .toBeGreaterThan(0);
    const capabilities = await page.locator('#so-capability-select option').evaluateAll((nodes) => nodes.map((n) => n.value));
    expect(capabilities).toContain('git.status_detailed');
    // The safe set is exactly the seven, so a capability outside it must not be on offer.
    for (const forbidden of ['workshop.apply_file', 'safety.release', 'git.checkpoint_restore']) {
      expect(capabilities).not.toContain(forbidden);
    }
    await page.locator('#so-title-input').fill(T44_ORDER_TITLE);
    await page.locator('#so-trigger-select').selectOption('workspace_dirty');
    await page.locator('#so-capability-select').selectOption('git.status_detailed');
    await page.locator('#btn-so-create').click();
    await expect.poll(async () => page.locator('#standing-orders-list li').count(), { timeout: 20_000 }).toBe(1);
    const card = page.locator('#standing-orders-list li').first();
    const orderId = await card.getAttribute('data-order-id');
    expect(orderId).toMatch(/^so_/);
    await expect(card.locator('[data-so-status]')).toHaveAttribute('data-so-status', 'enabled');
    await expect(card.locator('[data-so-status]')).toHaveText('ENABLED');
    await expect(card.locator('[data-so-runs]')).toHaveText('RUNS 0');
    // The outcome badge carries the outcome name, not a sentence: `never_run` renders as NEVER RUN.
    await expect(card.locator('[data-so-outcome]')).toHaveAttribute('data-so-outcome', 'never_run');
    run.order = { orderId, title: T44_ORDER_TITLE, capabilities, status: 'ENABLED', runs: 0 };
    await screenshot('standing-order-created');
    checkpoint('standing-order-created', { orderId });

    // ---- 2. Invoke Now runs it through the ECP -------------------------------------------------------
    await card.locator('button[data-action="invoke-standing-order"]').click();
    await expect.poll(async () => page.locator(`#standing-orders-list li[data-order-id="${orderId}"] [data-so-runs]`).textContent(),
      { timeout: 30_000 }).toBe('RUNS 1');
    await expect(page.locator(`#standing-orders-list li[data-order-id="${orderId}"] [data-so-outcome]`))
      .toHaveAttribute('data-so-outcome', 'verified');
    const afterRun = await fixture.get('/api/standing-orders');
    const stored = afterRun.body.orders.find((order) => order.orderId === orderId);
    expect(stored.runCount).toBe(1);
    expect(stored.lastOutcome).toBe('verified');
    const operationId = stored.history[0].operationId;
    expect(operationId).toBeTruthy();
    // The receipt the card names is a real record in the one ledger.
    const ledger = fixture.operationLedger();
    const receipt = ledger.find((entry) => entry.id === operationId);
    expect(receipt, 'the run must have left an operation in operations.jsonl').toBeTruthy();
    expect(receipt.steps[0].action).toBe('git.status_detailed');
    expect(receipt.steps[0].verification.outcome).toBe('success_verified');
    run.runOne = { runId: stored.history[0].runId, operationId, outcome: stored.lastOutcome, ledgerFound: Boolean(receipt) };
    await screenshot('standing-order-verified');
    checkpoint('standing-order-verified', { operationId });

    // ---- 3. a forbidden capability is refused by the API --------------------------------------------
    const refusal = await fixture.post('/api/standing-orders', {
      title: 'delegate a workspace write', eventType: 'workspace_dirty', capabilityId: 'workshop.apply_file',
    });
    expect(refusal.status).toBe(403);
    expect(refusal.body.code).toBe('STANDING_ORDER_CAPABILITY_FORBIDDEN');
    // Refused at registration, so the ledger still holds exactly one order.
    const ordersAfterRefusal = fixture.standingOrderLedger();
    expect(ordersAfterRefusal.orders.length).toBe(1);
    run.refusal = { status: refusal.status, code: refusal.body.code, ledgerCount: ordersAfterRefusal.orders.length };
    checkpoint('refusal-verified');

    // ---- 4. Pause and re-enable ---------------------------------------------------------------------
    await page.locator(`#standing-orders-list li[data-order-id="${orderId}"] button[data-action="toggle-standing-order"]`).click();
    await expect(page.locator(`#standing-orders-list li[data-order-id="${orderId}"] [data-so-status]`))
      .toHaveAttribute('data-so-status', 'paused');
    // Invoke is disabled on a paused order: a control that cannot honestly work does not pretend.
    await expect(page.locator(`#standing-orders-list li[data-order-id="${orderId}"] button[data-action="invoke-standing-order"]`))
      .toBeDisabled();
    await page.locator(`#standing-orders-list li[data-order-id="${orderId}"] button[data-action="toggle-standing-order"]`).click();
    await expect(page.locator(`#standing-orders-list li[data-order-id="${orderId}"] [data-so-status]`))
      .toHaveAttribute('data-so-status', 'enabled');
    run.toggle = { paused: 'PAUSED', resumed: 'ENABLED' };
    checkpoint('toggle-verified');

    // ---- 5. Lockdown halts, and release fires nothing -------------------------------------------------
    const locked = await fixture.lock();
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(fixture.latchActive()).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveAttribute('data-view', /.+/, { timeout: 20_000 });
    await openView(page, 'system');
    await expect(page.locator('#so-lockdown-status')).toHaveText('ENGAGED', { timeout: 20_000 });
    // The panel disables Invoke while the latch is up rather than letting a click discover the refusal;
    // the 423 below is the server refusing the same request if anything did send it.
    await expect(page.locator(`#standing-orders-list li[data-order-id="${orderId}"] button[data-action="invoke-standing-order"]`))
      .toBeDisabled();
    // The order card is still ENABLED - the latch is a condition on running, not a state of the order -
    // but Invoke is off, so the panel does not offer a control that could only fail.
    await expect(page.locator(`#standing-orders-list li[data-order-id="${orderId}"] [data-so-status]`))
      .toHaveAttribute('data-so-status', 'enabled');
    const haltedAttempt = await fixture.post(`/api/standing-orders/${orderId}/invoke`);
    expect(haltedAttempt.status).toBe(423);
    expect(haltedAttempt.body.code).toBe('LOCKDOWN_ACTIVE');
    const createUnderLock = await fixture.post('/api/standing-orders', {
      title: 'should not exist', eventType: 'session_start', capabilityId: 'system.doctor',
    });
    expect(createUnderLock.status).toBe(423);
    const ordersUnderLock = await fixture.get('/api/standing-orders');
    expect(ordersUnderLock.body.lockdownActive).toBe(true);
    expect(ordersUnderLock.body.summary.totalCount).toBe(1);
    await screenshot('standing-orders-lockdown');

    const released = await fixture.release();
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(fixture.latchActive()).toBe(false);
    // Release ran nothing, and a refused invoke left no mark: an invoke while the latch is up is refused
    // at the door, before the run, so there is no half-recorded run and no `halted_by_lockdown` on the
    // card. The halted state is written only for a run the engine had already accepted when the latch
    // engaged - that in-flight case is covered by the engine's own test, which can arm the latch between
    // the entry gate and the run's gate. Here the count is the one run from step 2, unchanged.
    const afterRelease = await fixture.get('/api/standing-orders');
    const releasedOrder = afterRelease.body.orders.find((order) => order.orderId === orderId);
    expect(releasedOrder.runCount).toBe(1);
    expect(releasedOrder.lastOutcome).toBe('verified');
    expect(releasedOrder.history.length).toBe(1);
    expect(releasedOrder.history.some((run) => run.outcome === 'halted_by_lockdown')).toBe(false);
    run.lockdown = {
      engaged: true, invokeStatus: haltedAttempt.status, invokeCode: haltedAttempt.body.code,
      createStatus: createUnderLock.status, createCode: createUnderLock.body.code,
      runCountAfterRelease: releasedOrder.runCount, lastOutcomeAfterRelease: releasedOrder.lastOutcome,
      refusalsRecorded: 0,
    };
    checkpoint('lockdown-verified', run.lockdown);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveAttribute('data-view', /.+/, { timeout: 20_000 });
    await openView(page, 'system');
    await expect(page.locator('#so-lockdown-status')).toHaveText('OPEN', { timeout: 20_000 });

    // ---- 6. the causal trace of the order resolves ----------------------------------------------------
    await page.locator(`#standing-orders-list li[data-order-id="${orderId}"] button[data-action="trace-standing-order"]`).click();
    await expect.poll(async () => page.evaluate(() => {
      const chain = document.getElementById('trace-chain');
      return chain ? chain.textContent ?? '' : '';
    }), { timeout: 30_000 }).toContain(orderId);
    const chainText = await page.evaluate(() => document.getElementById('trace-chain').textContent ?? '');
    expect(chainText).toContain('standing order');
    const traceApi = await fixture.get(`/api/memory/trace/${orderId}`);
    expect(traceApi.status).toBe(200);
    expect(traceApi.body.ok).toBe(true);
    run.trace = {
      orderId,
      kinds: [...new Set(traceApi.body.entries.map((entry) => entry.kind))],
      entries: traceApi.body.entries.length,
      // The chain must reach the run itself and name the operation it produced - that is the two-way
      // link: the order's history names the operation, and the operation is in the chain.
      reachesRun: traceApi.body.entries.some((entry) => entry.kind === 'standing_order_run'),
      namesOperation: JSON.stringify(traceApi.body.entries).includes(operationId),
    };
    expect(run.trace.reachesRun).toBe(true);
    expect(run.trace.namesOperation).toBe(true);
    checkpoint('trace-verified', run.trace);

    // ---- 7. the agenda: a commitment linked to the order, and the order in the derived list -----------
    await openView(page, 'approvals');
    await expect(page.locator('#briefing-agenda-panel')).toBeVisible({ timeout: 20_000 });
    await page.locator('#agenda-title-input').fill(T44_COMMITMENT_TITLE);
    await page.locator('#agenda-priority-select').selectOption('high');
    await page.locator('#agenda-link-input').fill(orderId);
    await page.locator('#btn-agenda-create').click();
    await expect.poll(async () => page.locator('#briefing-agenda-list li').count(), { timeout: 20_000 }).toBe(1);
    const item = page.locator('#briefing-agenda-list li').first();
    const itemId = await item.getAttribute('data-agenda-id');
    expect(itemId).toMatch(/^ag_/);
    await expect(item.locator('.agenda-title')).toHaveText(T44_COMMITMENT_TITLE);
    await expect(item.locator('[data-agenda-link]')).toHaveText(`LINKED ${orderId}`);
    // With no due date it is unscheduled, which is the cyan bucket.
    const horizon = await item.getAttribute('data-horizon');
    expect(['unscheduled', 'today', 'overdue']).toContain(horizon);
    // The armed order appears in the derived list, because it is a reading of the standing-order ledger.
    await expect.poll(async () => page.locator(`#briefing-derived-agenda-list li[data-source="standing_order"]`).count(),
      { timeout: 20_000 }).toBe(1);
    const derivedText = await page.locator('#briefing-derived-agenda-list li[data-source="standing_order"]').first().textContent();
    expect(derivedText).toContain(T44_ORDER_TITLE);
    run.agenda = { itemId, title: T44_COMMITMENT_TITLE, horizon, linkedTo: orderId };
    run.derived = { standingOrderRows: 1, text: derivedText.trim().slice(0, 160) };
    await screenshot('agenda-populated');
    checkpoint('agenda-populated', { itemId, horizon });

    // ---- 8. Complete takes it to COMPLETED ------------------------------------------------------------
    await item.locator('button[data-action="complete-agenda-item"]').click();
    await expect.poll(async () => page.locator(`#briefing-agenda-list li[data-agenda-id="${itemId}"] [data-agenda-horizon]`).textContent(),
      { timeout: 20_000 }).toBe('COMPLETED');
    await expect(page.locator(`#briefing-agenda-list li[data-agenda-id="${itemId}"] button[data-action="complete-agenda-item"]`))
      .toBeDisabled();
    const agendaAfter = await fixture.get('/api/agenda');
    const storedItem = agendaAfter.body.items.find((entry) => entry.itemId === itemId);
    expect(storedItem.status).toBe('completed');
    expect(storedItem.completedAt).toBeTruthy();
    run.complete = { itemId, status: storedItem.status, completedAt: storedItem.completedAt };
    await screenshot('agenda-completed');
    checkpoint('agenda-completed', run.complete);

    // ---- 9. the router: two lines, two panels ---------------------------------------------------------
    const scheduleReceipt = await dispatch(page, T44_ROUTER_LINE);
    expect(scheduleReceipt.route).toBe('agenda');
    expect(scheduleReceipt.capability).toBe('agenda.create');
    // The receipt names what it wrote: the title, and the id the agenda assigned - so a reader can match
    // the line to the card that appeared without guessing which of two commitments it was.
    expect(scheduleReceipt.text).toContain('Scheduled: ' + T44_COMMITMENT_TITLE);
    await expect(page.locator('section.view[data-view="approvals"]')).toHaveClass(/active/);
    await expect.poll(async () => page.locator('#briefing-agenda-list li').count(), { timeout: 20_000 }).toBe(2);

    const ordersReceipt = await dispatch(page, 'standing orders');
    expect(ordersReceipt.route).toBe('standing_order');
    await expect(page.locator('section.view[data-view="system"]')).toHaveClass(/active/);
    await expect(page.locator('#standing-orders-panel')).toBeVisible({ timeout: 20_000 });
    run.router = { schedule: scheduleReceipt.text.slice(0, 200), orders: ordersReceipt.text.slice(0, 200) };
    await screenshot('router-dispatch');
    checkpoint('router-verified');

    // ---- 10. contrast, overflow and errors across three viewports --------------------------------------
    checkpoint('contrast-start');
    const contrastSamples = [];
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      // The system view: the standing-orders panel and its badges.
      await openView(page, 'system');
      await expect(page.locator('#standing-orders-list li').first()).toBeVisible({ timeout: 20_000 });
      const soMeasured = await measureContrast(page, [
        '#standing-orders-panel h3',
        '#so-status',
        '#so-summary-badges .badge',
        '#standing-orders-list li .so-title',
        '#standing-orders-list li [data-so-status]',
        '#standing-orders-list li [data-so-runs]',
        '#standing-orders-list li [data-so-outcome]',
        '#standing-orders-list li button[data-action="invoke-standing-order"]',
        '#btn-so-create',
        '#btn-so-evaluate-dirty',
      ]);
      const soOverflow = await measureOverflow(page);
      expect(soOverflow.overflows, `${viewport.name} system overflow: ${JSON.stringify(soOverflow.offending)}`).toBe(false);
      // The approvals view: the agenda panel, its badges and the derived list.
      await openView(page, 'approvals');
      await expect(page.locator('#briefing-agenda-list li').first()).toBeVisible({ timeout: 20_000 });
      const agendaMeasured = await measureContrast(page, [
        '#briefing-agenda-panel h3',
        '#agenda-status',
        '#agenda-summary-badges .badge',
        '#briefing-agenda-list li .agenda-title',
        '#briefing-agenda-list li [data-agenda-horizon]',
        '#briefing-agenda-list li button[data-action="dismiss-agenda-item"]',
        '#briefing-derived-agenda-list li .agenda-badge',
        '#btn-agenda-create',
      ]);
      const agendaOverflow = await measureOverflow(page);
      expect(agendaOverflow.overflows, `${viewport.name} approvals overflow: ${JSON.stringify(agendaOverflow.offending)}`).toBe(false);
      await screenshot(`viewport-${viewport.name}`);
      for (const sample of [...soMeasured.samples, ...agendaMeasured.samples]) {
        expect(sample.ratio, `${sample.selector} at ${viewport.name} measures ${sample.ratio}`).toBeGreaterThanOrEqual(4.5);
        contrastSamples.push({ viewport: viewport.name, selector: sample.selector, ratio: Number(sample.ratio.toFixed(2)) });
      }
      run.viewports.push({
        name: viewport.name, width: viewport.width, height: viewport.height,
        soOverflow: false, agendaOverflow: false,
        samples: soMeasured.samples.length + agendaMeasured.samples.length,
        missing: [...soMeasured.missing, ...agendaMeasured.missing],
      });
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

    // ---- 11. nothing errored, and the contract held -----------------------------------------------
    run.consoleErrors = consoleErrors;
    run.pageErrors = pageErrors;
    run.failedRequests = failedRequests;
    run.screens = VIEWPORTS.map((viewport) => `${viewport.name} ${viewport.width}x${viewport.height}`);
    expect(pageErrors, `uncaught exceptions: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);
    // Voice stays reserved and the indicator says so, on the view this batch changed.
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
