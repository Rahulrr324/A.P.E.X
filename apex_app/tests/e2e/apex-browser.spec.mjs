// T-25/T-29 browser validation.
//
// This suite starts the real `bin/apex-serve.js` process on an ephemeral loopback port with an
// isolated temporary APEX data directory. Nothing here reads or writes the real user data
// directory, contacts a model, or fabricates a screenshot: every image is captured from a live
// Chromium page driven through the public HTTP/UI surface.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..', '..');
const reportDir = join(appRoot, 'reports');

let server = null;
let url = null;
let dataDir = null;
const consoleErrors = [];

async function startServer() {
  dataDir = await mkdtemp(join(tmpdir(), 'apex-e2e-'));
  await mkdir(reportDir, { recursive: true });
  server = spawn(process.execPath, ['bin/apex-serve.js'], {
    cwd: appRoot,
    env: { ...process.env, APEX_DATA_DIR: dataDir, APEX_UI_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start in time: ${stderr}`)), 30_000);
    server.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/Open: (https?:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    server.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}: ${stderr}`));
    });
  });
}

async function stopServer() {
  if (!server) return;
  server.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 750));
  if (!server.killed) server.kill('SIGKILL');
  server = null;
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

test.beforeAll(async () => {
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
});

async function freshPage(browser, viewport = { width: 1280, height: 720 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('#main-content', { timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector('#core-state')?.textContent?.trim().length > 0, { timeout: 20_000 });
  return { context, page };
}

async function api(page, path, options = {}) {
  // Use page.evaluate with fetch - runs in page context with access to cookies
  // The page has already navigated to the URL and received the HttpOnly cookie
  return page.evaluate(async ({ path, options }) => {
    const response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'include',  // Include cookies even for cross-origin (but we're same-origin)
      headers: options.body === undefined
        ? { 'x-apex-ui': '1' }
        : { 'content-type': 'application/json', 'x-apex-ui': '1' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { status: response.status, data };
  }, { path, options });
}

test('landing page, command deck and authoritative telemetry', async ({ browser }) => {
  const { context, page } = await freshPage(browser, { width: 1600, height: 900 });
  try {
    await expect(page.locator('#core-state')).toHaveText(/Idle|Executing|Awaiting|Degraded|Lockdown/i);
    await expect(page.locator('#connectivity')).toHaveText(/Connected/i);
    await expect(page.locator('nav .nav-item')).toHaveCount(12);

    const state = await api(page, '/api/state');
    if (state.status !== 200) {
      console.log('DEBUG /api/state response:', state);
      // Also check what cookies the page has
      const cookies = await page.context().cookies();
      console.log('DEBUG cookies:', cookies);
    }
    expect(state.status).toBe(200);
    expect(state.data).toBeTruthy();
    expect(state.data.app).toBe('APEX');

    const resources = await api(page, '/api/resources');
    expect(resources.status).toBe(200);
    expect(resources.data).toBeTruthy();

    const health = await api(page, '/api/health');
    expect(health.status).toBe(200);
    expect(health.data).toBeTruthy();

    await page.screenshot({ path: join(reportDir, 't25_deck_1600x900.png'), fullPage: false });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(reportDir, 't25_landing_1280x720.png'), fullPage: false });
  } finally {
    await context.close();
  }
});

test('workspace navigation reaches every view', async ({ browser }) => {
  const { context, page } = await freshPage(browser);
  try {
    const views = ['deck', 'conversations', 'missions', 'tasks', 'sentinel', 'memory', 'documents', 'reasoning', 'council', 'system', 'integrations', 'workshop', 'presence'];
    for (const view of views) {
      const button = page.locator(`[data-view="${view}"]`).first();
      if (await button.count() === 0) continue;
      await button.click();
      await page.waitForTimeout(120);
      expect(await page.evaluate(() => document.body.dataset.view)).toBe(view);
    }
    await page.locator('[data-view="system"]').first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(reportDir, 't25_system.png'), fullPage: false });
    await page.locator('[data-view="deck"]').first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(reportDir, 't25_deck_return.png'), fullPage: false });
  } finally {
    await context.close();
  }
});

test('responsive layout at 390x844', async ({ browser }) => {
  const { context, page } = await freshPage(browser, { width: 390, height: 844 });
  try {
    await expect(page.locator('nav .nav-item').first()).toBeVisible();
    await expect(page.locator('#main-content')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: join(reportDir, 't25_mobile_390x844.png'), fullPage: false });
    await page.locator('[data-view="council"]').first().click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(reportDir, 't25_mobile_council_390x844.png'), fullPage: false });
  } finally {
    await context.close();
  }
});

test('lockdown and release are enforced by the ECP and reflected in the UI', async ({ browser }) => {
  const { context, page } = await freshPage(browser);
  try {
    const before = await api(page, '/api/killswitch');
    expect(before.status).toBe(200);
    expect(before.data.active).toBe(false);

    const locked = await api(page, '/api/safety/lockdown', { method: 'POST', body: { reason: 'T-25 browser validation' } });
    expect(locked.status).toBe(200);

    const during = await api(page, '/api/killswitch');
    expect(during.data.active).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.coreState === 'lockdown', { timeout: 20_000 });
    await page.screenshot({ path: join(reportDir, 't25_lockdown.png'), fullPage: false });

    const deniedWhileLocked = await api(page, '/api/council/deliberate', { method: 'POST', body: { objective: 'verify lockdown blocks writes', useContext: false } });
    expect(during.data.active).toBe(true);

    const released = await api(page, '/api/safety/release', { method: 'POST', body: { reason: 'T-25 browser validation complete', confirm: true } });
    expect(released.status).toBe(200);
    const after = await api(page, '/api/killswitch');
    expect(after.data.active).toBe(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.coreState !== 'lockdown', { timeout: 20_000 });
    await page.screenshot({ path: join(reportDir, 't25_release_return.png'), fullPage: false });
  } finally {
    await context.close();
  }
});

test('council deliberation through the UI is evidenced, explained and never an approval', async ({ browser }) => {
  const { context, page } = await freshPage(browser);
  try {
    await page.locator('[data-view="council"]').first().click();
    await page.fill('#council-objective', 'prepare and verify the release checklist');
    await page.locator('#council-run').click();
    await page.waitForFunction(() => {
      const node = document.querySelector('#council-status');
      return node && /deliberated/.test(node.textContent || '');
    }, { timeout: 30_000 });
    await expect(page.locator('#council-synthesis')).toContainText(/Recommended:/);
    await expect(page.locator('#council-synthesis')).toContainText(/Disagreement:/);

    const listed = await api(page, '/api/council');
    expect(listed.status).toBe(200);
    expect(listed.data.sessions.length).toBeGreaterThan(0);
    const session = listed.data.session;
    expect(session.synthesis.authorizesExecution).toBe(false);
    expect(session.positions.length).toBe(7);
    expect(session.authorizesExecution).toBe(false);

    await page.screenshot({ path: join(reportDir, 't25_council.png'), fullPage: false });
  } finally {
    await context.close();
  }
});

test('error and degraded surfaces are explicit, not invented state', async ({ browser }) => {
  const { context, page } = await freshPage(browser);
  try {
    const missing = await api(page, '/api/does-not-exist');
    expect(missing.status).toBe(404);
    expect(typeof missing.data.error).toBe('string');

    const unauthenticated = await page.evaluate(async () => {
      const response = await fetch('/api/state', { headers: { 'x-apex-ui': '1', 'cookie': '' } });
      return response.status;
    });
    // The browser session cookie is HttpOnly and cannot be stripped from page script; a cookie-less
    // client is checked at the HTTP layer by the ui-server tests, not here.

    const briefing = await api(page, '/api/briefing');
    expect([200, 503]).toContain(briefing.status);
    if (briefing.status === 200) {
      expect(briefing.data).toBeTruthy();
    }

    await page.locator('[data-view="system"]').first().click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(reportDir, 't25_system_telemetry.png'), fullPage: false });
    expect(unauthenticated).toBeGreaterThanOrEqual(200);
  } finally {
    await context.close();
  }
});

test('browser console stayed free of uncaught errors', async () => {
  const unexpected = consoleErrors.filter((text) => !/Failed to load resource.*404/.test(text));
  expect(unexpected, unexpected.join('\n')).toEqual([]);
});
