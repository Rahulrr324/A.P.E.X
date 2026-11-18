import { test, expect } from '@playwright/test';

const REPORT_DIR = new URL('../reports/', import.meta.url);

async function resizeAndScreenshot(page, name, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(800);
  await page.screenshot({ path: new URL(`${name}.png`, REPORT_DIR).pathname, fullPage: false });
}

test('apex command deck launches', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', msg => { if (msg.type() === 'error') console.error('CONSOLE ERROR:', msg.text()); });

  const server = process.env.APEX_UI_URL;
  test.skip(!server, 'APEX_UI_URL not set');
  await page.goto(server, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('#main-content', { timeout: 15000 });
  await page.waitForFunction(() => document.body.dataset.coreState === 'idle' || document.querySelector('#core-state'), { timeout: 10000 });
  await resizeAndScreenshot(page, 't25_desktop', 1600, 900);
  await resizeAndScreenshot(page, 't25_landing', 1280, 720);
  await resizeAndScreenshot(page, 't25_mobile', 390, 844);
});
