// T-34 Step 4 (2026-11-19): one real-browser session over the mission graph.
//
// What this walk has to earn, in a real Chromium-family browser against the shipped server and the
// shipped client:
//
//   a fan-out/fan-in mission exists and is shown as its own shape  ->  the task selector switches
//   between two real tasks  ->  the gated branch is approved and the join's block clears  ->  the
//   join runs only after both branches, and the mission completes verified  ->  no console error, no
//   page error, no horizontal overflow.
//
// Every checkpoint asserts the record before the paint: a node reads `data-verified="true"` only
// when the task log's own verification says so, and the numbers on the page are compared with
// /api/taskgraph rather than believed. The JSON summary the workflow reads is written from what the
// page and the API actually answered.
//
// When the host has no browser at all the suite skips with an explicit diagnostic. A skip is not a
// pass, and the report says which of the two happened.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import { startT34Ui, readMissionFacts, T34_SCHEMA } from './t34-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(here, '..', '..');
const reportDir = path.join(repoDir, 'reports', 'screenshots', 't34');
const summaryPath = path.join(repoDir, 'reports', 't34-mission-dag.json');

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
  schema: T34_SCHEMA,
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
  console.log(`T34_FAILURES ${JSON.stringify({ failures: run.failures, steps: run.steps.length, screenshots: run.screenshots.length })}`);
  console.log(`T34_MISSION_SUMMARY ${JSON.stringify(run)}`);
}

let handle = null;
let browser = null;

test.describe('T-34 mission DAG, in a real browser', () => {
  test.skip(resolution.executable === null, noBrowserDiagnostic(resolution));

  test.beforeAll(async () => {
    fs.mkdirSync(reportDir, { recursive: true });
    handle = await startT34Ui();
    browser = await chromium.launch({ executablePath: resolution.executable, headless: true });
    run.browserVersion = browser.version();
  });

  test.afterAll(async () => {
    if (handle) run.facts = await readMissionFacts(handle).catch((error) => ({ error: String(error) }));
    if (browser) await browser.close().catch(() => {});
    if (handle) await handle.stop().catch(() => {});
    writeSummary();
  });

  test('the mission: shape, selector, gated branch, join, verification', async () => {
    // A five-node mission, two approvals, two resumes and three navigations: the default 90 s is for
    // one page assertion, not for a session.
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
      const file = path.join(reportDir, `t34-${name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      run.screenshots.push({ name, file: path.relative(repoDir, file), ...pngSize(file) });
    };
    const nav = async (view) => {
      await page.locator(`nav .nav-item[data-view="${view}"]`).click();
      await expect(page.locator('body')).toHaveAttribute('data-view', view);
    };
    const node = (id) => page.locator(`#dag-nodes li[data-node-id="${id}"]`);

    await page.goto(handle.base, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#core-state')).toBeVisible({ timeout: 45_000 });
    await nav('missions');

    // ---- 1. the mission's own shape, read from the record before it is believed ----------------
    const seeded = handle.seed;
    const record = await handle.graph(seeded.missionTaskId);
    expect(record.status, 'the task graph route answered').toBe(200);
    expect(record.body.taskId).toBe(seeded.missionTaskId);
    expect(record.body.shape, 'the fixture really is a fan-out with a join').toMatchObject({ nodes: 5, fanOut: 2, joins: ['n3'] });

    await expect(page.locator('#taskgraph-select')).toBeVisible({ timeout: 30_000 });
    await page.locator('#taskgraph-select').selectOption(seeded.missionTaskId);
    // The renderer fills the select back from the response, so the chosen task is the shown task.
    await expect(page.locator('#taskgraph-select')).toHaveValue(seeded.missionTaskId, { timeout: 30_000 });
    await expect(page.locator('#dag-nodes li[data-node-id]')).toHaveCount(5, { timeout: 30_000 });
    await expect(page.locator('#dag-edges')).toContainText('fan-out 2');
    await expect(page.locator('#dag-edges')).toContainText('join n3');
    step('mission-shape', { taskId: seeded.missionTaskId, nodes: record.body.nodes.length, shape: record.body.shape });
    await shot('01-mission-shape');

    // ---- 2. the gated branch holds the join, and the sibling already verified ------------------
    await expect(node('n1')).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
    await expect(node('n1')).toHaveAttribute('data-verified', 'true');
    await expect(node('n2b')).toHaveAttribute('data-state', 'completed');
    await expect(node('n2b')).toHaveAttribute('data-verified', 'true');
    await expect(node('n2a')).toHaveAttribute('data-state', 'awaiting_approval');
    await expect(node('n2a')).toHaveAttribute('data-verified', 'false');
    await expect(node('n3')).toHaveAttribute('data-state', 'awaiting_approval');
    // The join says which branch holds it - the page's own words, and the record's answer.
    await expect(node('n3')).toHaveAttribute('data-blocked-by', 'n2a');
    await expect(node('n3')).toContainText('Blocked by: n2a');
    await expect(node('n4')).toHaveAttribute('data-blocked-by', 'n3');
    const held = record.body.nodes.find((entry) => entry.id === 'n3');
    expect(held.blockedBy).toEqual(['n2a']);
    step('join-held', { join: 'n3', blockedBy: held.blockedBy, siblingVerified: record.body.nodes.find((entry) => entry.id === 'n2b').verified });
    await shot('02-join-held-by-gated-branch');

    // ---- 3. the selector switches between two real tasks --------------------------------------
    const options = await page.locator('#taskgraph-select option').evaluateAll((nodes) => nodes.map((option) => option.value).filter((value) => value !== ''));
    expect(options, 'both seeded tasks are offered').toEqual(expect.arrayContaining([seeded.missionTaskId, seeded.singleTaskId]));
    await page.locator('#taskgraph-select').selectOption(seeded.singleTaskId);
    await expect(page.locator('#dag-nodes li[data-node-id]')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('#dag-edges')).toContainText('single node');
    await expect(page.locator('#taskgraph-select')).toHaveValue(seeded.singleTaskId);
    step('selector', { tasks: options.length, switchedTo: seeded.singleTaskId, nodes: 1 });
    await shot('03-selector-other-task');

    await page.locator('#taskgraph-select').selectOption(seeded.missionTaskId);
    await expect(page.locator('#dag-nodes li[data-node-id]')).toHaveCount(5, { timeout: 30_000 });
    await expect(node('n3')).toHaveAttribute('data-blocked-by', 'n2a');
    step('selector-back', { selected: seeded.missionTaskId, nodes: 5 });

    // ---- 4. approve the gated branch: the join's block clears, the sibling is untouched --------
    const siblingBefore = (await handle.task(seeded.missionTaskId)).steps.find((entry) => entry.id === 'n2b');
    await expect(page.locator('#dag-approve')).toBeVisible({ timeout: 30_000 });
    await page.locator('#dag-approve').click();
    await expect(page.locator('#dag-control-status')).toContainText('Approving the checkpoint', { timeout: 30_000 });
    // Approved, and the branch is a pending step whose dependencies are met: exactly what resume acts on.
    await expect(node('n2a')).toHaveAttribute('data-state', 'pending', { timeout: 45_000 });
    await expect(page.locator('#dag-resume')).toBeVisible({ timeout: 30_000 });
    await shot('04a-branch-approved');
    await page.locator('#dag-resume').click();
    await expect(page.locator('#dag-control-status')).toContainText('Resuming the recorded task', { timeout: 30_000 });
    await expect(node('n2a')).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
    await expect(node('n2a')).toHaveAttribute('data-verified', 'true');
    await expect(node('n3')).not.toHaveAttribute('data-blocked-by', 'n2a', { timeout: 30_000 });
    await expect(node('n2b')).toHaveAttribute('data-verified', 'true');
    const unblocked = await handle.graph(seeded.missionTaskId);
    expect(unblocked.body.nodes.find((entry) => entry.id === 'n3').blockedBy).toEqual([]);
    const siblingAfter = (await handle.task(seeded.missionTaskId)).steps.find((entry) => entry.id === 'n2b');
    expect(siblingAfter.operationId, 'the verified sibling was not run again').toBe(siblingBefore.operationId);
    expect(siblingAfter.status).toBe('completed');
    step('branch-unblocked', { branch: 'n2a', join: 'n3', siblingOperationUnchanged: true });
    await shot('04b-join-unblocked');

    // ---- 5. approve the join and resume: it runs, then the completion node, and the task is verified
    await expect(page.locator('#dag-approve')).toBeVisible({ timeout: 30_000 });
    await page.locator('#dag-approve').click();
    await expect(node('n3')).toHaveAttribute('data-state', 'pending', { timeout: 45_000 });
    await page.locator('#dag-resume').click();
    await expect(node('n3')).toHaveAttribute('data-state', 'completed', { timeout: 90_000 });
    await expect(node('n3')).toHaveAttribute('data-verified', 'true');
    await expect(node('n4')).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
    await expect(node('n4')).toHaveAttribute('data-verified', 'true');
    await expect(page.locator('#dag-status')).toContainText('5 of 5 node(s) completed', { timeout: 30_000 });
    await expect(page.locator('#dag-status')).toContainText('every node verified');
    const done = await handle.graph(seeded.missionTaskId);
    expect(done.body.status).toBe('completed');
    expect(done.body.verified).toBe(true);
    expect(done.body.nodes.every((entry) => entry.verified)).toBe(true);
    // The join really did wait for both branches: the task log's own step records say so.
    const finished = await handle.task(seeded.missionTaskId);
    for (const id of ['n1', 'n2a', 'n2b', 'n3', 'n4']) {
      expect(finished.steps.find((entry) => entry.id === id).status, `${id} is completed`).toBe('completed');
    }
    step('mission-verified', { taskId: seeded.missionTaskId, status: done.body.status, verified: done.body.verified });
    await shot('05-mission-verified');

    // ---- 6. the page's own honesty: no console error, no page error, nothing overflowing ------
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `horizontal overflow: ${overflow.scrollWidth} > ${overflow.clientWidth}`)
      .toBeLessThanOrEqual(overflow.clientWidth + 1);
    expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    step('console', { errors: 0, pageErrors: 0, overflow: false });
    await context.close();
  });
});
