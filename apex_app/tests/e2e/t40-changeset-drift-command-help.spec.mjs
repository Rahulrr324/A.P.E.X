// T-40 Step 4 (2026-11-22): the changeset, disk-drift and command-help walk.
//
// This is the end-to-end claim of Steps 1 to 3, made in a real browser against a real server, a real
// directory on disk, and the real router:
//
//   1. Two candidates are staged and verified through the panel while both live files are untouched.
//   2. One of the two files is edited outside APEX, and Apply Changeset is pressed. The batch is
//      refused with 409 CHANGESET_PREFLIGHT_REFUSED, the offending file is named with both digests,
//      and BOTH files are still byte-for-byte what they were - the one that would have passed too.
//   3. With the files restored, the same batch applies atomically: both files hold their applied
//      bytes, read back from disk here and hashed in this process.
//   4. Check Disk Status measures the applied files. When one is edited outside APEX the row flips
//      from `intact` to `modified_externally` with both digests, and a batch rollback is refused with
//      409 CHANGESET_ROLLBACK_DRIFT, restoring nothing - the external edit survives.
//   5. With the edit restored, Rollback Changeset returns BOTH files byte-for-byte to the digests they
//      had before the batch, and the causal trace holds the batch apply and the batch rollback.
//   6. `?` opens the command reference, a template fills the command bar, and Escape dismisses it.
//
// And across all of it: zero console errors outside the two deliberate refusals, zero uncaught
// exceptions, no horizontal overflow.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import {
  startT40Ui, T40_SCHEMA, T40_GREETING_LIVE, T40_GREETING_NEXT, T40_DATA_LIVE, T40_DATA_NEXT,
  T40_GREETING_EXTERNAL,
} from './t40-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(here, '..', '..');
const reportDir = path.join(repoDir, 'reports', 'screenshots', 't40');
const summaryPath = path.join(repoDir, 'reports', 't40-changeset-drift-command-help.json');

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
  schema: T40_SCHEMA,
  browserBinary: BROWSER_BINARY_SCHEMA,
  resolved: { executable: resolution.executable, source: resolution.source, candidate: resolution.browser?.label ?? null },
  browserVersion: null,
  platform: process.platform,
  node: process.version,
  headless: true,
  preflight: null,
  apply: null,
  drift: null,
  rollback: null,
  help: null,
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

// Written after every phase: a test killed by its own timeout never reaches its `finally`, and a suite
// that leaves no summary behind turns one failure into two.
function checkpoint(phase, detail = null) {
  run.lastPhase = phase;
  run.phases = Array.isArray(run.phases) ? run.phases : [];
  run.phases.push({ phase, at: new Date().toISOString(), detail });
  writeSummary();
}

// Answer the next dialog with `text`, handing back a record rather than a bare promise. The rejection
// handler is attached at creation: an unhandled `waitForEvent` rejection kills the worker, and the
// operation actually in flight is then reported as a closed browser. The timeout is longer than the
// click it accompanies, so a missing dialog reads as a missing dialog.
function acceptNextDialog(page, text) {
  const record = { answered: false, text: null, error: null, message: null };
  const promise = page.waitForEvent('dialog', { timeout: 45_000 }).then(async (dialog) => {
    record.message = dialog.message();
    record.text = text;
    record.answered = true;
    await dialog.accept(text);
    return record;
  }).catch((error) => {
    record.error = String(error?.message ?? error);
    return record;
  });
  return promise;
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

// Stage and verify through the page's own controls. The candidate id is read once and every later
// locator is scoped by it: `.first()` is lazy and would silently retarget when the next candidate is
// staged, which is how the T-39 suite first failed on the hosted runner.
async function stageAndVerify(page, { relativePath, content, rationale }) {
  await page.fill('#ws-stage-path', relativePath);
  await page.fill('#ws-stage-rationale', rationale);
  await page.fill('#ws-stage-content', content);
  await page.click('#ws-stage-submit');
  await expect(page.locator('#ws-stage-status')).toContainText('Staged', { timeout: 20_000 });
  const newest = page.locator('#ws-candidates li').first();
  await expect(newest.locator('.badge').first()).toHaveText('not checked');
  await newest.locator('button', { hasText: 'Verify' }).click();
  await expect(newest.locator('.badge').first()).toHaveText('verified', { timeout: 25_000 });
  const id = await newest.locator('[data-candidate-id]').first().getAttribute('data-candidate-id');
  expect(id).toBeTruthy();
  const candidate = page.locator('#ws-candidates li', { has: page.locator(`[data-candidate-id="${id}"]`) });
  return { candidate, candidateId: id };
}

test.describe.configure({ mode: 'serial' });

test('T-40: a two-file changeset is atomic, disk drift is measured and blocks the batch, and the command reference opens with a key', async () => {
  // Stated rather than inherited: this walk starts a server, launches a browser, stages and verifies
  // four times, applies a batch, probes two refusals and rolls the batch back. Every phase checkpoints.
  test.setTimeout(240_000);
  test.skip(!resolution.executable, noBrowserDiagnostic(resolution));
  fs.mkdirSync(reportDir, { recursive: true });

  let fixture = null;
  let browser = null;
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const scheduledRefusals = [];

  try {
    fixture = await startT40Ui();
    const greetingBefore = fixture.readGreeting();
    const dataBefore = fixture.readData();
    expect(greetingBefore).toBe(T40_GREETING_LIVE);
    expect(dataBefore).toBe(T40_DATA_LIVE);
    const greetingBase = sha256(greetingBefore);
    const dataBase = sha256(dataBefore);

    browser = await chromium.launch({ executablePath: resolution.executable, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // Two refusals in this walk are asked for on purpose: the pre-flight refusal and the batch
    // rollback drift. Chromium logs every 409 as a console error whatever the client does with it, so
    // they are counted separately and the count is pinned at the end.
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
    await page.click('.nav-item[data-view="workshop"]');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'workshop');
    checkpoint('page loaded');

    // ------------------------------------------------- 1. stage and verify both files ---
    const greeting = await stageAndVerify(page, {
      relativePath: 'src/greeting.js',
      content: T40_GREETING_NEXT,
      rationale: 'the first file of the batch',
    });
    const data = await stageAndVerify(page, {
      relativePath: 'src/data.json',
      content: T40_DATA_NEXT,
      rationale: 'the second file of the batch',
    });
    // Staging and verifying write nothing to the workspace. Only the batch may.
    expect(fixture.readGreeting()).toBe(greetingBefore);
    expect(fixture.readData()).toBe(dataBefore);
    // Both rows state the base they will be compared against.
    await expect(greeting.candidate).toContainText('base ' + greetingBase.slice(0, 12));
    await expect(data.candidate).toContainText('base ' + dataBase.slice(0, 12));
    // The selection checkboxes are offered for both, and the batch control is still refused because
    // nothing is selected.
    await expect(greeting.candidate.locator(`[data-select-candidate="${greeting.candidateId}"]`)).toBeEnabled();
    await expect(data.candidate.locator(`[data-select-candidate="${data.candidateId}"]`)).toBeEnabled();
    await expect(page.locator('#ws-apply-changeset')).toBeDisabled();
    run.preflight = {
      greetingCandidateId: greeting.candidateId,
      dataCandidateId: data.candidateId,
      greetingBaseSha256: greetingBase,
      dataBaseSha256: dataBase,
      selectable: 2,
      liveUnchangedBeforeApply: true,
    };
    checkpoint('both candidates verified');
    await page.screenshot({ path: path.join(reportDir, 'changeset-staged.png') });
    run.screenshots += 1;

    // ---------------------------------------- 2. one file drifts: the batch is refused ---
    await greeting.candidate.locator(`[data-select-candidate="${greeting.candidateId}"]`).check();
    await data.candidate.locator(`[data-select-candidate="${data.candidateId}"]`).check();
    await expect(page.locator('#ws-apply-changeset')).toBeEnabled();
    // The edit an editor would make, made behind the product's back.
    fs.writeFileSync(fixture.dataPath, '{\n  "version": "edited outside APEX"\n}\n', 'utf8');
    const driftDigest = sha256(fixture.readData());

    const refusalDialog = acceptNextDialog(page, 'the walk tries to apply over an external edit');
    await page.fill('#ws-changeset-title', 'the pair');
    await page.click('#ws-apply-changeset');
    const refusalAnswer = await refusalDialog;
    expect(refusalAnswer.error, `the changeset prompt: ${refusalAnswer.error}`).toBeNull();
    expect(refusalAnswer.answered).toBe(true);
    // The notice must SURVIVE the click handler's own finally block. Asserting it once, immediately,
    // was the wrong test: the message was rendered and then overwritten a tick later by the selection
    // summary, and an assertion that ran in between passed while a human could never read it. So the
    // summary is asserted absent as well, which is the property that failed on the first hosted run.
    await expect(page.locator('#ws-changeset-state')).toContainText('refused before writing anything', { timeout: 25_000 });
    await expect(page.locator('#ws-changeset-state')).not.toContainText('selected');
    // And it is still there after the page has had time to go idle, which is when the overwrite landed.
    await page.waitForTimeout(500);
    await expect(page.locator('#ws-changeset-state')).toContainText('refused before writing anything');
    await expect(page.locator('#ws-changeset-state')).not.toContainText('selected');

    // The claim is about disk: the file that passed its own checks was not written either.
    expect(fixture.readGreeting()).toBe(greetingBefore);
    expect(sha256(fixture.readGreeting())).toBe(greetingBase);
    expect(sha256(fixture.readData())).toBe(driftDigest);
    // And nothing was recorded, because nothing happened.
    expect(fixture.ledger().filter((record) => record.kind === 'changeset_apply').length).toBe(0);
    // The refusal on screen names the offending file, with both digests.
    const refusalText = await page.locator('.diagnostic').last().textContent();
    expect(refusalText).toContain('Changeset refused');
    expect(refusalText).toContain('src/data.json');
    expect(refusalText).toContain(dataBase);
    expect(refusalText).toContain(driftDigest);

    run.preflight.refused = {
      code: 'CHANGESET_PREFLIGHT_REFUSED',
      refusedRelativePath: 'src/data.json',
      expectedBaseSha256: dataBase,
      actualDiskSha256: driftDigest,
      bothFilesUntouched: true,
      uiNamesFileAndBothDigests: true,
      ledgerChangesets: 0,
    };
    checkpoint('pre-flight refusal rendered');
    await page.screenshot({ path: path.join(reportDir, 'changeset-refused.png') });
    run.screenshots += 1;

    // ---------------------------------------------- 3. the clean batch applies atomically ---
    fs.writeFileSync(fixture.dataPath, dataBefore, 'utf8');
    expect(sha256(fixture.readData())).toBe(dataBase);
    const applyDialog = acceptNextDialog(page, 'the walk applies the pair as one change');
    await page.click('#ws-apply-changeset');
    const applyAnswer = await applyDialog;
    expect(applyAnswer.error, `the changeset prompt: ${applyAnswer.error}`).toBeNull();
    expect(applyAnswer.answered).toBe(true);
    expect(applyAnswer.message).toContain('reason');
    await expect(page.locator('#ws-changeset-state')).toContainText('atomically', { timeout: 25_000 });
    await page.waitForTimeout(500);
    await expect(page.locator('#ws-changeset-state')).toContainText('atomically');
    await expect(page.locator('#ws-changeset-state')).not.toContainText('selected');

    // Both files, read here and hashed here.
    expect(fixture.readGreeting()).toBe(T40_GREETING_NEXT);
    expect(fixture.readData()).toBe(T40_DATA_NEXT);
    expect(sha256(fixture.readGreeting())).toBe(sha256(T40_GREETING_NEXT));
    expect(sha256(fixture.readData())).toBe(sha256(T40_DATA_NEXT));

    const ledgerAfterApply = fixture.ledger();
    const changesetRecord = ledgerAfterApply.find((record) => record.kind === 'changeset_apply');
    expect(changesetRecord, 'the ledger must hold the batch').toBeTruthy();
    expect(changesetRecord.fileCount).toBe(2);
    expect(changesetRecord.atomic).toBe(true);
    expect(changesetRecord.everyFileVerifiedOnDisk).toBe(true);
    const recordFor = (relativePath) => changesetRecord.files.find((file) => file.relativePath === relativePath);
    expect(recordFor('src/greeting.js').beforeSha256).toBe(greetingBase);
    expect(recordFor('src/data.json').beforeSha256).toBe(dataBase);
    expect(recordFor('src/greeting.js').appliedSha256).toBe(sha256(T40_GREETING_NEXT));
    expect(recordFor('src/data.json').appliedSha256).toBe(sha256(T40_DATA_NEXT));
    // The backup directory holds both files' prior bytes, under one changeset id.
    const backupDir = path.join(fixture.dataDir, 'workshop-backups', changesetRecord.changesetId);
    expect(fs.existsSync(path.join(backupDir, 'snapshot.json'))).toBe(true);
    const snapshot = JSON.parse(fs.readFileSync(path.join(backupDir, 'snapshot.json'), 'utf8'));
    expect(snapshot.files.length).toBe(2);
    expect(snapshot.files.find((file) => file.relativePath === 'src/greeting.js').beforeSha256).toBe(greetingBase);

    // The panel shows the changeset with its own rollback control.
    await expect(page.locator('#ws-changesets')).toContainText(changesetRecord.changesetId, { timeout: 20_000 });
    const rollbackChangesetButton = page.locator(`[data-rollback-changeset="${changesetRecord.changesetId}"]`);
    await expect(rollbackChangesetButton).toBeVisible();
    await expect(page.locator('#ws-changesets')).toContainText('every file verified on disk: yes');

    run.apply = {
      changesetId: changesetRecord.changesetId,
      fileCount: changesetRecord.fileCount,
      atomic: changesetRecord.atomic,
      everyFileVerifiedOnDisk: changesetRecord.everyFileVerifiedOnDisk,
      diskVGreeting: true,
      diskData: true,
      backupHoldsBothPriorFiles: true,
      uiShowsChangesetAndRollback: true,
    };
    checkpoint('changeset applied atomically');
    await page.screenshot({ path: path.join(reportDir, 'changeset-applied.png') });
    run.screenshots += 1;

    // ------------------------------------- 4. the disk re-check, and the drift it finds ---
    await page.click('#ws-check-disk');
    await expect(page.locator('#ws-disk-state')).toContainText('still match', { timeout: 25_000 });
    await expect(page.locator('#ws-disk-status [data-disk-state="intact"]')).toHaveCount(2);
    await expect(page.locator('#ws-disk-status')).toContainText('src/greeting.js');
    await expect(page.locator('#ws-disk-status')).toContainText('src/data.json');
    const intactCounts = await page.locator('#ws-disk-status [data-disk-state="intact"]').count();
    expect(intactCounts).toBe(2);

    // Now edit one file outside APEX and press the button again.
    fs.writeFileSync(fixture.greetingPath, T40_GREETING_EXTERNAL, 'utf8');
    const externalDigest = sha256(T40_GREETING_EXTERNAL);
    await page.click('#ws-check-disk');
    await expect(page.locator('#ws-disk-status [data-disk-state="modified_externally"]')).toHaveCount(1, { timeout: 25_000 });
    await expect(page.locator('#ws-disk-state')).toContainText('modified externally');
    const modifiedRow = page.locator('#ws-disk-status li', { has: page.locator('[data-disk-state="modified_externally"]') });
    await expect(modifiedRow).toContainText('src/greeting.js');
    const modifiedText = await modifiedRow.textContent();
    // Both digests, named: what the batch wrote and what is on disk now.
    expect(modifiedText).toContain(sha256(T40_GREETING_NEXT));
    expect(modifiedText).toContain(externalDigest);
    run.drift = {
      intactBeforeEdit: intactCounts,
      modifiedAfterEdit: 1,
      modifiedRelativePath: 'src/greeting.js',
      appliedSha256: sha256(T40_GREETING_NEXT),
      actualDiskSha256: externalDigest,
      bothDigestsShown: true,
    };
    checkpoint('disk drift measured');
    await page.screenshot({ path: path.join(reportDir, 'disk-drift.png') });
    run.screenshots += 1;

    // ----------------------------------------- 5. the batch rollback is refused ---
    const driftRollbackDialog = acceptNextDialog(page, 'the walk tries to roll back over an external edit');
    await rollbackChangesetButton.click();
    const driftRollbackAnswer = await driftRollbackDialog;
    expect(driftRollbackAnswer.error, `the rollback prompt: ${driftRollbackAnswer.error}`).toBeNull();
    expect(driftRollbackAnswer.answered).toBe(true);
    await expect(page.locator('#ws-changeset-state')).toContainText('Batch rollback refused', { timeout: 25_000 });
    await page.waitForTimeout(500);
    await expect(page.locator('#ws-changeset-state')).toContainText('Batch rollback refused');
    await expect(page.locator('#ws-changeset-state')).not.toContainText('selected');
    // The file that still matched was NOT restored, and the external edit is intact.
    expect(fixture.readGreeting()).toBe(T40_GREETING_EXTERNAL);
    expect(fixture.readData()).toBe(T40_DATA_NEXT);
    expect(fixture.ledger().filter((record) => record.kind === 'changeset_rollback').length).toBe(0);
    run.drift.rollbackRefused = {
      code: 'CHANGESET_ROLLBACK_DRIFT',
      restoredNothing: true,
      externalEditIntact: true,
      uiSaidRefused: true,
    };
    checkpoint('batch rollback refused');
    await page.screenshot({ path: path.join(reportDir, 'rollback-refused.png') });
    run.screenshots += 1;

    // ------------------------------------------------ 6. the clean batch rollback ---
    // Restore what the batch wrote, which is the honest state to roll back from. This is the test's
    // own doing, not a claim about the product.
    fs.writeFileSync(fixture.greetingPath, T40_GREETING_NEXT, 'utf8');
    expect(sha256(fixture.readGreeting())).toBe(sha256(T40_GREETING_NEXT));
    const rollbackDialog = acceptNextDialog(page, 'the walk restores both files');
    await rollbackChangesetButton.click();
    const rollbackAnswer = await rollbackDialog;
    expect(rollbackAnswer.error, `the rollback prompt: ${rollbackAnswer.error}`).toBeNull();
    expect(rollbackAnswer.answered).toBe(true);
    await expect(page.locator('#ws-changeset-state')).toContainText('Rolled back', { timeout: 25_000 });
    await page.waitForTimeout(500);
    await expect(page.locator('#ws-changeset-state')).toContainText('Rolled back');
    await expect(page.locator('#ws-changeset-state')).not.toContainText('selected');

    // Byte-for-byte, both files.
    expect(fixture.readGreeting()).toBe(T40_GREETING_LIVE);
    expect(fixture.readData()).toBe(T40_DATA_LIVE);
    expect(sha256(fixture.readGreeting())).toBe(greetingBase);
    expect(sha256(fixture.readData())).toBe(dataBase);
    const rollbackRecord = fixture.ledger().find((record) => record.kind === 'changeset_rollback');
    expect(rollbackRecord).toBeTruthy();
    expect(rollbackRecord.changesetId).toBe(changesetRecord.changesetId);
    expect(rollbackRecord.fileCount).toBe(2);
    expect(rollbackRecord.everyFileVerifiedOnDisk).toBe(true);
    for (const file of rollbackRecord.files) {
      expect(file.verifiedOnDisk).toBe(true);
    }
    run.rollback = {
      changesetId: changesetRecord.changesetId,
      fileCount: rollbackRecord.fileCount,
      greetingRestoredSha256: greetingBase,
      dataRestoredSha256: dataBase,
      byteIdentical: true,
      everyFileVerifiedOnDisk: rollbackRecord.everyFileVerifiedOnDisk,
      uiConfirmed: true,
    };
    checkpoint('batch rollback restored both files');
    await page.screenshot({ path: path.join(reportDir, 'changeset-rolled-back.png') });
    run.screenshots += 1;

    // ------------------------------------------------- 7. the causal trace ---
    // A batch is two files, and the trace records one chain per path, so the greeting chain holds the
    // batch apply and the batch rollback.
    await page.click('.nav-item[data-view="memory"]');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'memory');
    await page.fill('#trace-search-q', 'greeting');
    await page.click('#trace-search-button');
    await expect(page.locator('#trace-search-statusline')).not.toContainText('Searching', { timeout: 20_000 });
    await expect(page.locator('#trace-search-statusline')).toContainText('matched');
    const changeResult = page.locator('#trace-results li', { hasText: 'workspace change' }).first();
    await changeResult.locator('button', { hasText: 'Open chain' }).click();
    await expect(page.locator('#trace-chain-status')).not.toContainText('Reading', { timeout: 20_000 });
    const chain = await page.locator('#trace-chain').textContent();
    expect(chain).toContain('workspace file applied');
    expect(chain).toContain('workspace rollback restored the prior file');
    expect(chain.indexOf('workspace file applied')).toBeLessThan(chain.indexOf('workspace rollback restored'));
    expect(chain).toContain(greetingBase);
    const chainBody = await page.evaluate(async (id) => {
      const response = await fetch('/api/memory/trace/' + encodeURIComponent(id));
      return { status: response.status, body: await response.json().catch(() => null) };
    }, greeting.candidateId);
    expect(chainBody.status).toBe(200);
    run.trace = {
      complete: chainBody.body.complete === true,
      counts: chainBody.body.counts,
      applies: chainBody.body.entries.filter((entry) => entry.kind === 'workshop_apply').length,
      ordered: true,
      digestsPresent: true,
    };
    expect(run.trace.applies).toBe(2);
    checkpoint('trace chain open');

    // ------------------------------------------- 8. the command reference, by key ---
    await page.click('.nav-item[data-view="deck"]');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'deck');
    // Click the body first so no field has focus: the binding is deliberately suppressed while typing.
    await page.locator('h1').first().click();
    await page.keyboard.press('?');
    await expect(page.locator('#hud-command-help')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#hud-command-help-rows tr').first()).toBeVisible();
    // The catalogue is real: a known command and its ECP decision are both on screen.
    await expect(page.locator('#hud-command-help-rows')).toContainText('verify workshop');
    await expect(page.locator('#hud-command-help-rows')).toContainText('ECP: allow');
    await expect(page.locator('#hud-command-help-keys')).toContainText('Ctrl+K');
    await expect(page.locator('#hud-command-help-keys')).toContainText('Escape');
    const rowCount = await page.locator('#hud-command-help-rows tr').count();
    expect(rowCount).toBeGreaterThanOrEqual(16);
    const shortcutCount = await page.locator('#hud-command-help-keys li').count();
    expect(shortcutCount).toBeGreaterThanOrEqual(5);

    // A template fills the command bar rather than dispatching it.
    const verifyButton = page.locator('[data-fill-command="verify workshop"]');
    await verifyButton.click();
    expect(await page.inputValue('#chat-text')).toBe('verify workshop');
    await expect(page.locator('#hud-command-help-state')).toContainText('Filled');

    // Escape closes the panel and leaves the typed line alone.
    await page.keyboard.press('Escape');
    await expect(page.locator('#hud-command-help')).toBeHidden({ timeout: 10_000 });
    expect(await page.inputValue('#chat-text')).toBe('verify workshop');

    // And the toggle opens it too, so the reference is reachable without a keyboard.
    await page.click('#hud-help-toggle');
    await expect(page.locator('#hud-command-help')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#hud-command-help')).toBeHidden({ timeout: 10_000 });
    run.help = {
      openedByKey: true,
      openedByToggle: true,
      rows: rowCount,
      shortcuts: shortcutCount,
      templateFilledBar: true,
      escapeDismissed: true,
      typedLineSurvived: true,
      ecpColumnLive: true,
    };
    checkpoint('command reference verified');
    await page.screenshot({ path: path.join(reportDir, 'command-help.png') });
    run.screenshots += 1;

    // ---------------------------------------------- 9. every view, and no overflow ---
    const views = await page.locator('.nav-item[data-view]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-view')));
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

    // ---------------------------------------------------------- 10. nothing failed ---
    run.consoleErrors = consoleErrors;
    run.pageErrors = pageErrors;
    run.failedRequests = failedRequests;
    run.scheduledRefusals = scheduledRefusals;
    expect(pageErrors, `uncaught exceptions: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    // Exactly two scheduled refusals: the pre-flight refusal and the batch rollback drift. Pinning
    // the count stops the filter from quietly becoming a blanket exemption.
    expect(scheduledRefusals.length, `scheduled refusals seen: ${scheduledRefusals.join(' | ')}`).toBe(2);
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
