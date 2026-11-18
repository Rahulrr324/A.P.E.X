import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reportDir = join(__dirname, '..', 'reports');
mkdirSync(reportDir, { recursive: true });

function tempDataDir() {
  return mkdtempSync(join(tmpdir(), 'apex-e2e-'));
}

test('apex command deck launches', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  const dataDir = tempDataDir();
  const server = spawn('node', ['bin/apex-serve.js'], {
    cwd: process.cwd(),
    env: { ...process.env, APEX_DATA_DIR: dataDir, APEX_UI_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let url = null;
  const urlReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start in time')), 20000);
    server.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const m = text.match(/Open: (https?:\/\/[^\s]+)/);
      if (m) { clearTimeout(timeout); url = m[1]; resolve(); }
    });
    server.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('fatal:')) { clearTimeout(timeout); reject(new Error(text)); }
    });
  });

  await urlReady;
  test.skip(!url, 'server did not start');

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('#main-content', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#core-state'), { timeout: 10000 });

  async function resizeAndScreenshot(name, width, height) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(reportDir, `${name}.png`), fullPage: false });
  }

  await resizeAndScreenshot('t25_desktop', 1600, 900);
  await resizeAndScreenshot('t25_landing', 1280, 720);
  await resizeAndScreenshot('t25_mobile', 390, 844);

  await page.click('[data-view="system"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(reportDir, 't25_system.png'), fullPage: false });

  await page.click('[data-view="deck"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(reportDir, 't25_deck_return.png'), fullPage: false });

  server.kill('SIGTERM');
  try { await new Promise(r => setTimeout(r, 1500)); } catch {}
  if (!server.killed) server.kill('SIGKILL');
});
