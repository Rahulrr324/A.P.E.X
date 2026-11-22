// T-39 Step 4 (2026-11-22): the governed apply and rollback walk.
//
// This is the end-to-end claim of Steps 1 to 3, made in a real browser against a real server and a
// real directory on disk:
//
//   1. A candidate is staged and verified while the live file is untouched. The panel shows the base
//      digest that will be compared and the candidate digest that will be written.
//   2. Apply writes the real file. The bytes are read back from disk here, not taken from the
//      response, and the digest is recomputed in this process. The panel shows the applied badge, the
//      backup id and a rollback control.
//   3. A second candidate is staged and verified, then the file is edited outside APEX. Applying that
//      candidate is refused with 409 WORKSPACE_DRIFT, both digests are reported, and the external edit
//      is still on disk afterwards - byte for byte.
//   4. Rolling back the first apply restores the file to exactly the bytes it had before, verified by
//      digest here, and the causal trace for that candidate holds the verification, the apply and the
//      rollback in time order with `complete: true`.
//
// And across all of it: zero console errors outside the one deliberate 409 probe, zero uncaught
// exceptions, no horizontal overflow.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import {
  startT39Ui, T39_SCHEMA, T39_LIVE_SOURCE, T39_CANDIDATE_SOURCE, T39_SECOND_SOURCE, T39_EXTERNAL_EDIT,
} from './t39-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(here, '..', '..');
const reportDir = path.join(repoDir, 'reports', 'screenshots', 't39');
const summaryPath = path.join(repoDir, 'reports', 't39-workshop-apply-rollback.json');

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

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
  schema: T39_SCHEMA,
  browserBinary: BROWSER_BINARY_SCHEMA,
  resolved: { executable: resolution.executable, source: resolution.source, candidate: resolution.browser?.label ?? null },
  browserVersion: null,
  platform: process.platform,
  node: process.version,
  headless: true,
  apply: null,
  drift: null,
  rollback: null,
  trace: null,
  overflow: null,
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  scheduledRefusals: [],
  screenshots: 0,
  failures: [],
  skip: null,
};

function writeSummary() {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(run, null, 2)}\n`);
}

// Written after every phase, for the same reason T-38 does it: a test killed by its own timeout never
// reaches its `finally`, and a suite that leaves no summary behind turns one failure into two.
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

// The staging and verification the panel performs, driven through the page's own controls so the walk
// exercises the UI rather than calling the API behind it and then looking at the UI.
async function stageAndVerify(page, { relativePath, content, rationale }) {
  await page.fill('#ws-stage-path', relativePath);
  await page.fill('#ws-stage-rationale', rationale);
  await page.fill('#ws-stage-content', content);
  await page.click('#ws-stage-submit');
  await expect(page.locator('#ws-stage-status')).toContainText('Staged', { timeout: 20_000 });
  const candidate = page.locator('#ws-candidates li').first();
  await expect(candidate.locator('.badge')).toHaveText('not checked');
  await candidate.locator('button', { hasText: 'Verify' }).click();
  await expect(candidate.locator('.badge')).toHaveText('verified', { timeout: 25_000 });
  const id = await candidate.locator('[data-candidate-id]').first().getAttribute('data-candidate-id');
  expect(id).toBeTruthy();
  return { candidate, candidateId: id };
}

test.describe.configure({ mode: 'serial' });

test('T-39: a verified candidate is applied to the real workspace, a stale one is refused, and a rollback restores the bytes', async () => {
  // The budget is stated rather than inherited. This walk starts a server, launches a browser, stages
  // and verifies twice, applies, probes a refusal and rolls back - and every phase writes a
  // checkpoint, so a timeout names the phase that was running.
  test.setTimeout(180_000);
  test.skip(!resolution.executable, noBrowserDiagnostic(resolution));
  fs.mkdirSync(reportDir, { recursive: true });

  let fixture = null;
  let browser = null;
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const scheduledRefusals = [];

  try {
    fixture = await startT39Ui();
    const liveBefore = fixture.readLive();
    const beforeSha256 = sha256(liveBefore);
    expect(liveBefore).toBe(T39_LIVE_SOURCE);

    browser = await chromium.launch({ executablePath: resolution.executable, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // One refusal in this walk is asked for on purpose: the drift probe below. Chromium logs any
    // non-2xx response as a console error whatever the client does with it, so it is counted
    // separately and the count is pinned at the end. Everything else is a real console error.
    const EXPECTED_REFUSAL = /Failed to load resource: the server responded with a status of (409|423)/;
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (EXPECTED_REFUSAL.test(message.text())) { scheduledRefusals.push(message.text()); return; }
      consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
    page.on('requestfailed', (request) => {
      if (request.url().endsWith('/favicon.ico')) return;
      failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`);
    });
    run.browserVersion = browser.version();
    checkpoint('browser launched');

    await page.goto(`${fixture.base}/?token=${encodeURIComponent(fixture.token)}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveAttribute('data-view', 'deck', { timeout: 20_000 });
    await page.click('[data-view="workshop"]');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'workshop');
    checkpoint('page loaded');

    // ---------------------------------------------------------------- 1. stage and verify ---
    const first = await stageAndVerify(page, {
      relativePath: 'src/greeting.js',
      content: T39_CANDIDATE_SOURCE,
      rationale: 'the walk applies this one, then rolls it back',
    });
    // The live file is untouched by staging and verifying. This is the T-38 promise, and the apply is
    // the only thing in this suite allowed to break it.
    expect(fixture.readLive()).toBe(liveBefore);
    // The candidate states both digests: the base it was staged against and the bytes it would write.
    await expect(first.candidate).toContainText('base ' + beforeSha256.slice(0, 12));
    await expect(first.candidate).toContainText('-> candidate ' + sha256(T39_CANDIDATE_SOURCE).slice(0, 12));
    const applyButton = first.candidate.locator(`[data-apply-candidate="${first.candidateId}"]`);
    await expect(applyButton).toBeEnabled();
    run.apply = { candidateId: first.candidateId, beforeSha256, liveUnchangedBeforeApply: true };
    checkpoint('first candidate verified');

    // ------------------------------------------------------------------------- 2. apply ---
    // window.prompt opens a dialog: the handler is registered before the click, and the click is
    // awaited after the dialog is answered.
    const applyDialog = page.waitForEvent('dialog', { timeout: 20_000 }).then(async (dialog) => {
      await dialog.accept('the walk applies this candidate');
      return dialog.message();
    });
    await applyButton.click();
    await applyDialog;
    await expect(page.locator('#ws-stage-status')).toContainText('Applied', { timeout: 25_000 });

    // The claim is about the disk. The bytes are read here and hashed in this process.
    const liveAfterApply = fixture.readLive();
    const appliedSha256 = sha256(T39_CANDIDATE_SOURCE);
    expect(liveAfterApply).toBe(T39_CANDIDATE_SOURCE);
    expect(sha256(liveAfterApply)).toBe(appliedSha256);
    // And the backup holds the exact bytes that were replaced.
    const ledger = fs.readFileSync(path.join(fixture.dataDir, 'workshop-applies.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const applyRecord = ledger.find((record) => record.kind === 'apply');
    expect(applyRecord, 'the ledger must hold the apply').toBeTruthy();
    expect(applyRecord.appliedSha256).toBe(appliedSha256);
    expect(applyRecord.beforeSha256).toBe(beforeSha256);
    expect(applyRecord.verifiedOnDisk).toBe(true);
    const backupFile = path.join(fixture.dataDir, 'workshop-backups', applyRecord.applyId, `before-${beforeSha256}.bin`);
    expect(fs.readFileSync(backupFile, 'utf8')).toBe(T39_LIVE_SOURCE);

    // The panel reports it: the badge, the id, the backup and a rollback control.
    await expect(first.candidate.locator('.badge', { hasText: 'Applied to workspace' })).toBeVisible({ timeout: 20_000 });
    await expect(first.candidate).toContainText('Applied to workspace — disk SHA-256 verified');
    await expect(first.candidate).toContainText(applyRecord.applyId);
    await expect(first.candidate).toContainText('backup ' + applyRecord.applyId);
    const rollbackButton = first.candidate.locator(`[data-rollback-apply="${applyRecord.applyId}"]`);
    await expect(rollbackButton).toBeVisible();

    run.apply.applyId = applyRecord.applyId;
    run.apply.appliedSha256 = appliedSha256;
    run.apply.diskMatchesAppliedSha256 = true;
    run.apply.backupHoldsPriorBytes = true;
    run.apply.uiShowsAppliedBadge = true;
    run.apply.uiShowsRollbackControl = true;
    checkpoint('apply written and verified on disk');

    await page.screenshot({ path: path.join(reportDir, 'workshop-applied.png') });
    run.screenshots += 1;
    checkpoint('applied screenshot');

    // ------------------------------------------------------- 3. the drift refusal ---
    // A second candidate, verified against the file as it is now. Then the file is edited outside
    // APEX - by this test process writing to it, which is exactly what an editor would do.
    await page.click('#ws-refresh');
    await expect(page.locator('#ws-state')).not.toContainText('Inspecting', { timeout: 20_000 });
    const second = await stageAndVerify(page, {
      relativePath: 'src/greeting.js',
      content: T39_SECOND_SOURCE,
      rationale: 'staged before an external edit, so it must be refused',
    });
    fs.writeFileSync(fixture.livePath, T39_EXTERNAL_EDIT, 'utf8');
    expect(fixture.readLive()).toBe(T39_EXTERNAL_EDIT);

    // The refusal, driven through the page so the browser sees the 409 and the panel renders it.
    const driftDialog = page.waitForEvent('dialog', { timeout: 20_000 }).then(async (dialog) => {
      await dialog.accept('the walk tries to apply over an external edit');
    });
    await second.candidate.locator(`[data-apply-candidate="${second.candidateId}"]`).click();
    await driftDialog;
    await expect(page.locator('#ws-stage-status')).toContainText('Apply refused', { timeout: 25_000 });

    // The external edit survived: a refused apply writes nothing at all.
    expect(fixture.readLive()).toBe(T39_EXTERNAL_EDIT);
    // The panel shows both digests it was told, rather than the word "drift".
    const expectedBase = sha256(T39_CANDIDATE_SOURCE);
    const actualDisk = sha256(T39_EXTERNAL_EDIT);
    await expect(second.candidate).toContainText('the file changed after this candidate was staged', { timeout: 15_000 });
    await expect(second.candidate).toContainText(expectedBase);
    await expect(second.candidate).toContainText(actualDisk);
    // And the ledger still holds exactly one apply, because the second one did not happen.
    const afterDrift = fs.readFileSync(path.join(fixture.dataDir, 'workshop-applies.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(afterDrift.filter((record) => record.kind === 'apply').length).toBe(1);

    run.drift = {
      code: 'WORKSPACE_DRIFT',
      expectedBaseSha256: expectedBase,
      actualDiskSha256: actualDisk,
      externalEditIntact: true,
      ledgerApplyCount: 1,
      uiShowsBothDigests: true,
    };
    checkpoint('drift refusal rendered');

    await page.screenshot({ path: path.join(reportDir, 'workshop-drift.png') });
    run.screenshots += 1;
    checkpoint('drift screenshot');

    // ---------------------------------------------------------- 4. the rollback ---
    // The drift probe left the file holding the external edit, so it is restored to the applied bytes
    // first: the rollback gate compares against what the apply wrote, and that is the honest state to
    // roll back from. Putting the file back is the test's own doing, not a claim about the product.
    fs.writeFileSync(fixture.livePath, T39_CANDIDATE_SOURCE, 'utf8');
    expect(sha256(fixture.readLive())).toBe(appliedSha256);

    const rollbackDialog = page.waitForEvent('dialog', { timeout: 20_000 }).then(async (dialog) => {
      await dialog.accept('the walk restores the file');
    });
    await first.candidate.locator(`[data-rollback-apply="${applyRecord.applyId}"]`).click();
    await rollbackDialog;
    await expect(page.locator('#ws-stage-status')).toContainText('Rolled back', { timeout: 25_000 });

    // Byte-identical to what it held before the apply.
    const restored = fixture.readLive();
    expect(restored).toBe(T39_LIVE_SOURCE);
    expect(sha256(restored)).toBe(beforeSha256);
    const rollbackRecord = fs.readFileSync(path.join(fixture.dataDir, 'workshop-applies.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .find((record) => record.kind === 'rollback');
    expect(rollbackRecord).toBeTruthy();
    expect(rollbackRecord.applyId).toBe(applyRecord.applyId);
    expect(rollbackRecord.restoredSha256).toBe(beforeSha256);
    expect(rollbackRecord.verifiedOnDisk).toBe(true);

    run.rollback = {
      applyId: applyRecord.applyId,
      restoredSha256: beforeSha256,
      byteIdentical: true,
      removedFile: rollbackRecord.removedFile === true,
      uiConfirmed: true,
    };
    checkpoint('rollback restored the bytes');

    await page.screenshot({ path: path.join(reportDir, 'workshop-rolled-back.png') });
    run.screenshots += 1;

    // ------------------------------------------------------------- 5. the causal trace ---
    await page.click('[data-view="memory"]');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'memory');
    await page.fill('#trace-search-q', 'greeting');
    await page.click('#trace-search-button');
    await expect(page.locator('#trace-search-statusline')).not.toContainText('Searching', { timeout: 20_000 });
    await expect(page.locator('#trace-search-statusline')).toContainText('matched');

    // The workspace changes are findable as their own kind.
    const kinds = await page.locator('#trace-results .badge').allTextContents();
    expect(kinds).toContain('workspace change');
    const changeResult = page.locator('#trace-results li', { hasText: 'workspace change' }).first();
    await changeResult.locator('button', { hasText: 'Open chain' }).click();
    await expect(page.locator('#trace-chain-status')).not.toContainText('Reading', { timeout: 20_000 });
    await expect(page.locator('#trace-chain li')).not.toHaveCount(0);

    const chain = await page.locator('#trace-chain').textContent();
    const chainSteps = await page.locator('#trace-chain li').count();
    // The chain holds the apply and the rollback, in that order, with the digests.
    expect(chain).toContain('workspace file applied');
    expect(chain).toContain('workspace rollback restored the prior file');
    expect(chain.indexOf('workspace file applied')).toBeLessThan(chain.indexOf('workspace rollback restored'));
    expect(chain).toContain(beforeSha256);
    expect(chain).toContain(appliedSha256);

    // The API's own answer for the same chain, read from the page so it is the browser's request.
    const chainBody = await page.evaluate(async (id) => {
      const response = await fetch('/api/memory/trace/' + encodeURIComponent(id));
      return { status: response.status, body: await response.json().catch(() => null) };
    }, first.candidateId);
    expect(chainBody.status).toBe(200);
    expect(chainBody.body.counts.applies).toBeGreaterThanOrEqual(2);
    const entries = chainBody.body.entries.filter((entry) => entry.kind === 'workshop_apply');
    expect(entries.length).toBe(2);
    expect(entries[0].detail.rolledBack).toBe(false);
    expect(entries[1].detail.rolledBack).toBe(true);

    run.trace = {
      complete: chainBody.body.complete === true,
      chainSteps,
      workspaceChanges: entries.length,
      orderedApplyThenRollback: true,
      digestsPresent: true,
      counts: chainBody.body.counts,
    };
    // Both events, in order, with verified digests - and the chain reads as complete, because the
    // flag means "every record this kind of chain should hold was found". A candidate chain is
    // assembled from verifications and applies; it holds no cognition run, and does not claim one.
    expect(run.trace.workspaceChanges).toBe(2);
    expect(run.trace.orderedApplyThenRollback).toBe(true);
    expect(chainBody.body.complete, `chain missing: ${JSON.stringify(chainBody.body.missing)}`).toBe(true);
    checkpoint('trace chain open');
    await page.screenshot({ path: path.join(reportDir, 'memory-workspace-changes.png') });
    run.screenshots += 1;
    checkpoint('trace screenshot');

    // ---------------------------------------------------- 6. every view, and no overflow ---
    const views = await page.locator('.nav-item[data-view]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-view')));
    const perView = [];
    for (const view of views) {
      await page.click(`.nav-item[data-view="${view}"]`);
      await page.waitForTimeout(80);
      const measured = await measureOverflow(page);
      perView.push({ view, ...measured });
      checkpoint(`view ${view}`);
    }
    run.overflow = perView;
    for (const measured of perView) {
      expect(measured.overflows, `${measured.view} overflows horizontally: ${JSON.stringify(measured.offending)}`).toBe(false);
    }

    // ------------------------------------------------------------------ 7. nothing failed ---
    run.consoleErrors = consoleErrors;
    run.pageErrors = pageErrors;
    run.failedRequests = failedRequests;
    run.scheduledRefusals = scheduledRefusals;
    expect(pageErrors, `uncaught exceptions: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    // Exactly one scheduled refusal was seen: the drift probe. Pinning it stops the filter from
    // quietly becoming a blanket exemption.
    expect(scheduledRefusals.length, `scheduled refusals seen: ${scheduledRefusals.join(' | ')}`).toBe(1);
    expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);
  } catch (error) {
    run.failures.push({
      phase: run.lastPhase ?? null,
      message: String(error?.message ?? error),
      stack: String(error?.stack ?? '').slice(0, 2000),
    });
    writeSummary();
    throw error;
  } finally {
    run.consoleErrors = consoleErrors;
    run.pageErrors = pageErrors;
    run.failedRequests = failedRequests;
    run.scheduledRefusals = scheduledRefusals;
    writeSummary();
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.stop().catch(() => {});
  }
});
