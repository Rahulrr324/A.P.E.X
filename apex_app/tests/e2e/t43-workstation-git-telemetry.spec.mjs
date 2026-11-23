// T-43 Step 4 (2026-11-19): the workstation, git executive and host telemetry walk.
//
// This is the end-to-end claim of Packages 1 to 3, made in a real browser against a real server, a real
// git repository on disk, and the real operating system:
//
//   1. The Workshop panel shows the repository's real branch, HEAD, and its staged / unstaged /
//      untracked counts - measured here from the same repository with the system git binary, so the
//      panel is checked against git rather than against itself.
//   2. Inspect Diff renders the real working-tree change with both line-number columns, the additions
//      and deletions counted from the hunks, and every foreground measured against the tint it sits on.
//   3. Create Checkpoint writes a real ref that resolves to a real commit, and the card says REF INTACT.
//   4. Restore, driven from the panel, puts the committed bytes back on disk - read back here - and the
//      ledger records the restore. Moving the ref by hand then makes the card say REF DRIFT and disables
//      its restore control.
//   5. The causal trace of the checkpoint resolves in the Memory viewer.
//   6. Sentinel shows the host's listening ports and its own process, including the loopback port this
//      very server is listening on.
//   7. Ctrl+K takes `git status` and `inspect ports` to the screens they name.
//
// Across all of it: zero console errors, zero uncaught exceptions, and no horizontal overflow at three
// viewports.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import {
  startT43Ui, T43_SCHEMA, T43_GREETING_COMMITTED, T43_GREETING_EDITED, T43_GREETING_POST_CHECKPOINT,
  T43_UNTRACKED,
} from './t43-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(here, '..', '..');
const reportDir = path.join(repoDir, 'reports', 'screenshots', 't43');
const summaryPath = path.join(repoDir, 'reports', 't43-workstation-git-telemetry.json');

// The three viewports the milestone names. The narrow one is a phone held upright, and the wide one is
// the largest the HUD is designed for; if a surface overflows at either end it is wrong at both.
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
  schema: T43_SCHEMA,
  browserBinary: BROWSER_BINARY_SCHEMA,
  resolved: { executable: resolution.executable, source: resolution.source, candidate: resolution.browser?.label ?? null },
  browserVersion: null,
  platform: process.platform,
  node: process.version,
  headless: true,
  repo: null,
  status: null,
  diff: null,
  contrast: null,
  checkpoint: null,
  restore: null,
  drift: null,
  trace: null,
  telemetry: null,
  router: null,
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
// resolved - not from the stylesheet text. A token redefined for a dark panel is measured as it renders.
async function measureContrast(page) {
  return page.evaluate(() => {
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
    // Walk up for the first opaque backdrop: a tinted line sits on a panel that sits on the page.
    const backdrop = (node) => {
      let current = node;
      let colour = { r: 0, g: 0, b: 0, a: 0 };
      while (current) {
        const style = getComputedStyle(current);
        const parsed = parse(style.backgroundColor);
        if (parsed && parsed.a > 0) colour = over(colour, parsed);
        if (colour.a >= 0.999) return colour;
        current = current.parentElement;
      }
      return over(colour, { r: 255, g: 255, b: 255, a: 1 });
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
    const sample = (selector, label) => {
      const node = document.querySelector(selector);
      if (!node) return { label, selector, ratio: null, missing: true };
      return { label, selector, ratio: ratio(node), colour: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor };
    };
    const samples = [
      sample('.diff-line-add', 'added line text'),
      sample('.diff-line-del', 'deleted line text'),
      sample('.diff-gutter-add', 'added line number'),
      sample('.diff-gutter-del', 'deleted line number'),
      sample('.checkpoint-ref-intact', 'REF INTACT badge'),
      sample('.checkpoint-ref-drift', 'REF DRIFT badge'),
      sample('.exposure-loopback', 'loopback row'),
      sample('#git-branch-badge', 'branch badge'),
      sample('#telemetry-total-badge', 'TOTAL PORTS badge'),
    ];
    return { samples: samples.filter((entry) => !entry.missing), missing: samples.filter((entry) => entry.missing).map((entry) => entry.selector) };
  });
}

// Type a command into the command bar and send it. The bar is the product's own route in, so the walk
// exercises the router rather than a back door. The receipt is read from the deck, and it carries the
// line it answered: a bare visibility wait would resolve against the previous receipt and every read
// would be one route behind.
async function dispatch(page, line) {
  await page.locator('button.nav-item[data-view="deck"]').click();
  await page.locator('#chat-text').fill(line);
  await page.locator('#send').click();
  await expect(page.locator('#dispatch-receipt')).toBeVisible({ timeout: 30_000 });
  // The receipt is a definition list of term/value pairs, so the route is read from its own row rather
  // than from an attribute the markup does not carry. Reading it by term name also means a reordered
  // list cannot silently report the wrong field.
  return page.evaluate(() => {
    const dl = document.getElementById('dispatch-receipt');
    const pairs = {};
    const terms = Array.from(dl.querySelectorAll('dt'));
    for (const term of terms) pairs[term.textContent.trim()] = term.nextElementSibling?.textContent ?? '';
    return { route: pairs.Route, capability: pairs.Capability, targetView: pairs['Target view'], verified: pairs.Verified, values: Object.values(pairs) };
  });
}

test.describe.configure({ mode: 'serial' });

test('T-43: the git panel measures a real repository, a checkpoint restores from its card, and Sentinel reads the host', async () => {
  // Stated rather than inherited: this walk starts a server and a browser, inspects two diffs, creates
  // and restores a checkpoint, drifts a ref, and measures three viewports across the screens.
  test.setTimeout(240_000);
  test.skip(!resolution.executable, noBrowserDiagnostic(resolution));
  fs.mkdirSync(reportDir, { recursive: true });

  let fixture = null;
  let browser = null;
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  try {
    fixture = await startT43Ui();
    run.repo = { headSha: fixture.headSha, branch: fixture.repo.branch, workspace: fixture.workspace };
    checkpoint('started', { headSha: fixture.headSha, branch: fixture.repo.branch });

    browser = await chromium.launch({ executablePath: resolution.executable, args: ['--no-sandbox'] });
    run.browserVersion = browser.version();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
    page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? null }));

    // The token is a query parameter on the page URL: the server hands the bearer to the client that
    // way, and a bare base URL gets a 401 and an empty body. Every other suite in this tree opens the
    // page the same way.
    await page.goto(`${fixture.base}/?token=${encodeURIComponent(fixture.token)}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveAttribute('data-view', /.+/, { timeout: 20_000 });
    checkpoint('booted', { url: fixture.base });

    // --------------------------------------------------- 1. The git panel measures the repository ---
    await page.locator('button.nav-item[data-view="workshop"]').click();
    await expect(page.locator('#workshop-git-panel')).toBeVisible({ timeout: 15_000 });
    // The panel may render before its first read lands; the badges carry data attributes, so waiting on
    // the attribute is waiting for the reading rather than for a paint.
    await expect(page.locator('#git-branch-badge')).toContainText(`branch: ${fixture.repo.branch}`, { timeout: 20_000 });
    await expect(page.locator('#git-head-badge')).toContainText(fixture.headSha.slice(0, 7));
    await expect(page.locator('#git-unstaged-badge')).toHaveAttribute('data-count', '2', { timeout: 20_000 });
    await expect(page.locator('#git-untracked-badge')).toHaveAttribute('data-count', '1');
    await expect(page.locator('#git-staged-badge')).toHaveAttribute('data-count', '0');
    await expect(page.locator('#git-checkpoints-badge')).toHaveAttribute('data-count', '0');
    await expect(page.locator('#git-status-text')).toHaveAttribute('data-state', 'available');

    // The same three facts, measured outside the product with the system git binary. The panel agreeing
    // with the API that produced it would prove nothing; agreeing with git proves it measured.
    expect(fixture.git(['status', '--porcelain=v1']).split('\n').filter((line) => /^ M/.test(line)).length).toBe(2);
    const status = await fixture.get('/api/git/status');
    expect(status.body.unstaged.length).toBe(2);
    // Untracked paths are relative to the workspace root and are reported as paths, not as objects.
    const untrackedPaths = status.body.untracked.map((entry) => (typeof entry === 'string' ? entry : entry.path));
    expect(untrackedPaths).toEqual(['fresh.txt']);
    expect(status.body.headSha).toBe(fixture.headSha);
    run.status = {
      branch: status.body.branch, headSha: status.body.headSha,
      staged: status.body.staged.length, unstaged: status.body.unstaged.length,
      untracked: status.body.untracked.length, checkpointsCount: status.body.checkpointsCount,
    };
    await page.screenshot({ path: path.join(reportDir, '01-git-panel.png'), fullPage: true });
    run.screenshots += 1;
    checkpoint('status-painted', run.status);

    // ------------------------------------------------------------- 2. The diff viewer renders ---
    await page.fill('#git-diff-path-input', 'src/greeting.js');
    await page.click('#btn-git-diff-inspect');
    await expect(page.locator('#workshop-diff-viewer')).toBeVisible({ timeout: 20_000 });
    // One line changed: "+ return hello name !" replaces "- return hello name". The counts come from the
    // hunks, so asserting them is asserting the parse.
    await expect(page.locator('#diff-additions-badge')).toHaveText('+1', { timeout: 20_000 });
    await expect(page.locator('#diff-deletions-badge')).toHaveText('-1');

    const addRows = page.locator('#diff-body .diff-line-add');
    const delRows = page.locator('#diff-body .diff-line-del');
    await expect(addRows).toHaveCount(1);
    await expect(delRows).toHaveCount(1);
    // The changed text is on screen, and each row carries both line numbers in their own columns. The
    // gutter classes are per side, so a row whose numbers were swapped would fail this.
    await expect(addRows.first()).toContainText('"!"');
    const addGutters = await addRows.first().locator('td').allTextContents();
    expect(addGutters.length, 'old number, new number, text').toBe(3);
    expect(addGutters[0].trim(), 'an added line has no old number').toBe('');
    expect(addGutters[1].trim(), 'an added line has a new number').toMatch(/^\d+$/);
    await expect(addRows.first().locator('td').nth(1)).toHaveClass(/diff-gutter-add/);
    const delGutters = await delRows.first().locator('td').allTextContents();
    expect(delGutters[0].trim(), 'a deleted line has an old number').toMatch(/^\d+$/);
    expect(delGutters[1].trim(), 'a deleted line has no new number').toBe('');
    await expect(delRows.first().locator('td').nth(0)).toHaveClass(/diff-gutter-del/);

    // The colour is measured, not assumed: the two gutters are the ok-green and armor-red tokens, and
    // both clear the floor against the tint their row actually renders.
    const contrast = await measureContrast(page);
    run.contrast = { samples: contrast.samples.map((entry) => ({ label: entry.label, ratio: Number(entry.ratio?.toFixed(2)) })), missing: contrast.missing };
    expect(contrast.missing, 'every sampled surface exists').toEqual([]);
    for (const entry of contrast.samples) {
      expect(entry.ratio, `${entry.label} measures ${entry.ratio?.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    // And the two glyphs are present, so the meaning of a line is not carried by colour alone. The glyph
    // is the first character of the text cell rather than an element of its own.
    await expect(addRows.first().locator('td').nth(2)).toHaveText(/^\+/);
    await expect(delRows.first().locator('td').nth(2)).toHaveText(/^-/);

    const diff = await fixture.get('/api/git/diff?path=src/greeting.js');
    expect(diff.body.additions).toBe(1);
    expect(diff.body.deletions).toBe(1);
    run.diff = { additions: diff.body.additions, deletions: diff.body.deletions, hunks: diff.body.hunks.length, truncated: diff.body.truncated };
    await page.screenshot({ path: path.join(reportDir, '02-diff-viewer.png'), fullPage: true });
    run.screenshots += 1;
    checkpoint('diff-painted', run.diff);

    // ------------------------------------------------- 3. Create a checkpoint, and it is real ---
    await page.fill('#git-checkpoint-label-input', 'end-to-end walk');
    await page.click('#btn-git-checkpoint-create');
    await expect(page.locator('#git-checkpoint-status')).toContainText('Checkpoint', { timeout: 25_000 });
    await expect(page.locator('#workshop-checkpoints-list li')).toHaveCount(1, { timeout: 25_000 });
    const card = page.locator('#workshop-checkpoints-list li').first();
    await expect(card).toContainText('end-to-end walk');
    await expect(card.locator('.checkpoint-ref-intact')).toHaveText('REF INTACT');

    const ledger = fixture.checkpointLedger();
    expect(ledger, 'the checkpoint ledger was written').toBeTruthy();
    const record = ledger.checkpoints.find((entry) => entry.label === 'end-to-end walk');
    expect(record, 'the ledger holds the checkpoint the panel created').toBeTruthy();
    // The ref resolves to a real commit, measured with git rather than with the product's own answer.
    expect(fixture.refResolves(record.refName, record.commitSha), `${record.refName} resolves`).toBe(true);
    const porcelainDuringCheckpoint = fixture.git(['status', '--porcelain=v1']);
    expect(porcelainDuringCheckpoint, 'creating a checkpoint left the worktree alone').toContain(' M src/greeting.js');
    run.checkpoint = {
      checkpointId: record.checkpointId, refName: record.refName, commitSha: record.commitSha,
      refResolves: true, worktreeUnchanged: true,
    };
    await page.screenshot({ path: path.join(reportDir, '03-checkpoint-created.png'), fullPage: true });
    run.screenshots += 1;
    checkpoint('checkpoint-created', { checkpointId: record.checkpointId });

    // ---------------------------- 4. Restore from the card, and the index comes back ---
    // A checkpoint records the WORKTREE AS IT IS, so a restore returns the bytes it captured. What a
    // restore therefore changes is anything that moved after it - and the case the preflight allows is
    // the index, because staging a file does not put new content in the worktree. The file is staged,
    // the panel's own control is pressed, and the tree is re-read from git afterwards. There is no API
    // call in this step: the button is what performs the act.
    fixture.git(['add', '--', 'src/greeting.js']);
    const stagedBefore = await fixture.get('/api/git/status');
    expect(stagedBefore.body.staged.length, 'one file is staged before the restore').toBe(1);
    expect(stagedBefore.body.unstaged.length).toBe(1);

    await card.locator('button[data-action="restore-git-checkpoint"]').click();
    await expect(page.locator('#git-checkpoint-status')).toContainText('Restored', { timeout: 30_000 });
    const afterRestoreStatus = await fixture.get('/api/git/status');
    // Both files match the snapshot again and both are in the index: the staging was undone by the
    // restore, which is exactly the state the snapshot describes.
    expect(afterRestoreStatus.body.staged.length, 'the restore rebuilt the index from the snapshot').toBe(2);
    expect(afterRestoreStatus.body.unstaged.length, 'nothing is left outside the index').toBe(0);
    expect(fixture.readGreeting(), 'the worktree still holds the checkpointed bytes').toBe(T43_GREETING_EDITED);
    expect(fs.readFileSync(fixture.untrackedPath, 'utf8'), 'the untracked file was not touched').toBe(T43_UNTRACKED);
    const afterRestore = fixture.checkpointLedger().checkpoints.find((entry) => entry.checkpointId === record.checkpointId);
    expect(afterRestore.restoreCount, 'the ledger recorded the restore').toBe(1);
    expect(afterRestore.lastRestoredAt).toBeTruthy();

    // The restore is a governed write, so it is in the operations ledger as one. The ledger records the
    // capability by name and the verification in the step that performed it; the L2 classification is a
    // property of the capability, and it is read from where capabilities declare it.
    const operations = fixture.operationLedger();
    const restoreOperation = operations.find((entry) => entry.capability === 'git.checkpoint_restore');
    expect(restoreOperation, 'the restore is in the operations ledger').toBeTruthy();
    expect(restoreOperation.status, 'the ledger calls a verified write what it is').toBe('success_verified');
    expect(restoreOperation.origin, 'the write is attributed to the owner').toBe('user');
    expect(restoreOperation.steps?.[0]?.verified, 'the step that performed it verified it').toBe(true);
    expect(restoreOperation.steps?.[0]?.checkpointId).toBe(record.checkpointId);
    const declared = fixture.app.registry.get('git.checkpoint_restore');
    expect(declared.autonomyLevel, 'the restore is declared L2').toBe('L2');
    expect(declared.blastRadius, 'and it reaches the workspace filesystem').toBe('workspace_fs');
    expect(declared.reversibility, 'and it is declared reversible').toBe('reversible');
    // The panel re-read the repository after the restore rather than leaving the stale counts up.
    await expect(page.locator('#git-staged-badge')).toHaveAttribute('data-count', '2', { timeout: 20_000 });
    await expect(page.locator('#git-unstaged-badge')).toHaveAttribute('data-count', '0');
    run.restore = {
      restoreCount: afterRestore.restoreCount,
      stagedBefore: stagedBefore.body.staged.length,
      stagedAfter: afterRestoreStatus.body.staged.length,
      untrackedUntouched: true,
      operation: { capability: restoreOperation.capability, status: restoreOperation.status, verified: restoreOperation.steps?.[0]?.verified === true },
      declared: { autonomyLevel: declared.autonomyLevel, blastRadius: declared.blastRadius, reversibility: declared.reversibility },
    };
    await page.screenshot({ path: path.join(reportDir, '04-checkpoint-restored.png'), fullPage: true });
    run.screenshots += 1;
    checkpoint('checkpoint-restored', run.restore);

    // And the refusal the preflight exists for: a real worktree edit made after the checkpoint would be
    // discarded by a restore, so the restore is refused and the edit survives. This is the other half of
    // the same claim, and it is checked against the file on disk rather than against the response.
    fs.writeFileSync(fixture.greetingPath, T43_GREETING_POST_CHECKPOINT, 'utf8');
    await page.click('#btn-git-refresh');
    await expect(page.locator('#git-unstaged-badge')).toHaveAttribute('data-count', '2', { timeout: 20_000 });
    const refusal = await fixture.post(`/api/git/checkpoints/${record.checkpointId}/restore`, { reason: 'the walk probes the refusal' });
    expect(refusal.status, 'a restore that would discard a worktree edit is refused').toBe(409);
    expect(refusal.body.code).toBe('GIT_CHECKPOINT_DIRTY_TREE');
    expect(refusal.body.detail.dirtyPaths, 'the refusal names the path it would have discarded').toContain('src/greeting.js');
    expect(fixture.readGreeting(), 'the refused restore changed nothing').toBe(T43_GREETING_POST_CHECKPOINT);
    expect(fixture.checkpointLedger().checkpoints.find((entry) => entry.checkpointId === record.checkpointId).restoreCount,
      'a refused restore is not recorded as one that happened').toBe(1);
    run.restore.refusal = { status: refusal.status, code: refusal.body.code, dirtyPaths: refusal.body.detail.dirtyPaths };
    // Put the checkpointed bytes back so the drift phase starts from a known tree.
    fs.writeFileSync(fixture.greetingPath, T43_GREETING_EDITED, 'utf8');
    await page.click('#btn-git-refresh');
    await expect(page.locator('#git-unstaged-badge')).toHaveAttribute('data-count', '2', { timeout: 20_000 });

    // ----------------------------------------------- 5. Drift the ref, and the card notices ---
    // The ref is moved out from under the panel by hand. This is the failure the badge exists for, and it
    // must be discovered by the next read rather than cached from the one that said INTACT.
    fixture.driftRef(record.refName, fixture.headSha);
    expect(fixture.refResolves(record.refName, record.commitSha), 'the ref no longer names its commit').toBe(false);
    await page.click('#btn-git-refresh');
    await expect(page.locator('#workshop-checkpoints-list li .checkpoint-ref-drift').first()).toHaveText('REF DRIFT', { timeout: 20_000 });
    const driftedCard = page.locator('#workshop-checkpoints-list li').first();
    await expect(driftedCard.locator('button[data-action="restore-git-checkpoint"]')).toBeDisabled();
    await expect(driftedCard.locator('button[data-action="trace-git-checkpoint"]')).toBeEnabled();
    run.drift = { refIntact: false, restoreDisabled: true, traceEnabled: true };
    await page.screenshot({ path: path.join(reportDir, '05-checkpoint-drift.png'), fullPage: true });
    run.screenshots += 1;
    checkpoint('checkpoint-drifted', run.drift);

    // ------------------------------------------------------------ 6. The causal trace resolves ---
    await page.locator('#workshop-checkpoints-list li').first().locator('button[data-action="trace-git-checkpoint"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-view', 'memory', { timeout: 15_000 });
    await expect(page.locator('#trace-chain li')).not.toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('#trace-chain')).toContainText(record.checkpointId.slice(0, 12));
    const trace = await fixture.get(`/api/memory/trace/${record.checkpointId}`);
    expect(trace.status, 'the checkpoint id resolves in the trace API').toBe(200);
    expect(trace.body.complete, 'the chain is complete from the create onward').toBe(true);
    // The chain alternates the ECP audit of each act with the checkpoint record it authorised. The
    // checkpoint records carry the ledger entry itself, and the audit records name the capability.
    const kinds = (trace.body.entries ?? []).map((entry) => entry.kind);
    expect(kinds, 'the chain holds both halves').toContain('git_checkpoint');
    expect(kinds, 'the chain holds the authorisation too').toContain('ecp_audit');
    const checkpointEntries = trace.body.entries.filter((entry) => entry.kind === 'git_checkpoint');
    expect(checkpointEntries.length, 'one record per checkpoint act').toBe(2);
    expect(checkpointEntries.map((entry) => entry.detail?.checkpointId)).toEqual([record.checkpointId, record.checkpointId]);
    const auditText = JSON.stringify(trace.body.entries.filter((entry) => entry.kind === 'ecp_audit'));
    expect(auditText, 'the chain names the create').toMatch(/git\.checkpoint_create/);
    expect(auditText, 'the chain names the restore').toMatch(/git\.checkpoint_restore/);
    run.trace = { status: trace.status, complete: trace.body.complete, entries: kinds.length, kinds: [...new Set(kinds)] };
    await page.screenshot({ path: path.join(reportDir, '06-causal-trace.png'), fullPage: true });
    run.screenshots += 1;
    checkpoint('trace-opened', run.trace);

    // ------------------------------------------ 7. Sentinel reads the host, this server included ---
    await page.locator('button.nav-item[data-view="sentinel"]').click();
    await expect(page.locator('#sentinel-telemetry-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#telemetry-total-badge')).toContainText('TOTAL PORTS: ', { timeout: 25_000 });
    await expect(page.locator('#edith-port-table tbody tr')).not.toHaveCount(0, { timeout: 25_000 });
    await expect(page.locator('#edith-process-table tbody tr')).not.toHaveCount(0);

    const telemetry = await fixture.get('/api/system/telemetry?limit=15');
    const serverPort = Number(new URL(fixture.base).port);
    // The server this walk is talking to is listening on a loopback port, and the inspection must find
    // it. That is the one fact no fixture can fake: it is the operating system's answer about this very
    // process.
    const apexPort = (telemetry.body.ports.summary.apexListeningPorts ?? []).find((entry) => Number(entry.localPort ?? entry) === serverPort)
      ?? null;
    expect(apexPort, `the server's own port ${serverPort} is among the inspected apex ports`).toBeTruthy();
    const apexRow = page.locator('#edith-port-table tbody tr', { hasText: String(serverPort) });
    await expect(apexRow.first()).toBeVisible({ timeout: 10_000 });
    await expect(apexRow.first()).toContainText('LOOPBACK ONLY');

    // The badges are the summary, so they are checked against it rather than for being present.
    await expect(page.locator('#telemetry-total-badge')).toContainText(`TOTAL PORTS: ${telemetry.body.ports.summary.totalListening}`);
    await expect(page.locator('#telemetry-loopback-badge')).toContainText(`LOOPBACK ONLY: ${telemetry.body.ports.summary.loopbackOnlyCount}`);
    await expect(page.locator('#telemetry-exposure-badge')).toContainText(`EXTERNAL EXPOSURE: ${telemetry.body.ports.summary.externalExposureCount}`);
    await expect(page.locator('#edith-process-summary')).toContainText(String(telemetry.body.processes.apexProcess.pid));

    // The process table names APEX's own process and its resident size, and carries no environment
    // variable or command line: the exclusion is a promise the panel must keep too.
    const processText = await page.locator('#edith-process-table').innerText();
    expect(processText).toMatch(new RegExp(String(telemetry.body.processes.apexProcess.pid)));
    expect(processText, 'no environment variable leaks into the table').not.toMatch(/APEX_STEP_UP_TOKEN|PATH=|HOME=/);
    run.telemetry = {
      platform: telemetry.body.platform,
      totalListening: telemetry.body.ports.summary.totalListening,
      loopbackOnly: telemetry.body.ports.summary.loopbackOnlyCount,
      externalExposure: telemetry.body.ports.summary.externalExposureCount,
      apexPort: serverPort,
      apexRssBytes: telemetry.body.processes.apexProcess.rssBytes,
      excluded: telemetry.body.processes.excluded,
    };
    await page.screenshot({ path: path.join(reportDir, '07-sentinel-telemetry.png'), fullPage: true });
    run.screenshots += 1;
    checkpoint('telemetry-painted', run.telemetry);

    // ---------------------------------------------------- 8. Ctrl+K routes to both surfaces ---
    // Ctrl+K is the keyboard route into the command bar; the router then decides the screen. This is the
    // brief's own line: the commands must go where the panels are, not merely be recognised.
    // The key opens the bar: pressing it must focus the command text, which is the whole point of a
    // shortcut. A key that does nothing would pass a test that only checked the bar was visible.
    await page.locator('button.nav-item[data-view="deck"]').click();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+k');
    await expect(page.locator('#chat-text')).toBeFocused({ timeout: 10_000 });
    run.keyboard = { ctrlKFocusedCommandBar: true };

    const gitReceipt = await dispatch(page, 'git status');
    expect(gitReceipt.route, 'git status routes to git').toBe('git');
    expect(gitReceipt.capability, 'the receipt names the capability that read it').toBe('git.status_detailed');
    expect(gitReceipt.targetView, 'the receipt names the screen it moved to').toBe('workshop');
    expect(gitReceipt.values.join(' '), 'the receipt reports the branch it read').toMatch(/main @ [0-9a-f]{7}/);
    expect(gitReceipt.verified, 'the read was verified').toBe('yes');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'workshop', { timeout: 15_000 });
    await expect(page.locator('#workshop-git-panel')).toBeVisible();
    run.router = { gitStatus: 'git', gitStatusTarget: 'workshop' };

    const portsReceipt = await dispatch(page, 'inspect ports');
    expect(portsReceipt.route, 'inspect ports routes to inspect').toBe('inspect');
    expect(portsReceipt.capability).toBe('system.inspect_ports');
    expect(portsReceipt.targetView).toBe('sentinel');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'sentinel', { timeout: 15_000 });
    await expect(page.locator('#edith-port-table')).toBeVisible();
    run.router.inspectPorts = 'inspect';
    run.router.inspectPortsTarget = 'sentinel';

    const processesReceipt = await dispatch(page, 'inspect processes');
    expect(processesReceipt.route).toBe('inspect');
    expect(processesReceipt.capability).toBe('system.inspect_processes');
    expect(processesReceipt.targetView).toBe('sentinel');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'sentinel', { timeout: 15_000 });
    await expect(page.locator('#edith-process-table')).toBeVisible();
    run.router.inspectProcesses = 'inspect';

    // The bare `git diff` and the targeted form are different lines with the same route; the target is
    // what the request carries, so both are sent and the panel's own state is what is read.
    const diffReceipt = await dispatch(page, 'git diff src/greeting.js');
    expect(diffReceipt.route, 'git diff <path> routes to git').toBe('git');
    expect(diffReceipt.capability).toBe('git.diff_inspect');
    expect(diffReceipt.targetView).toBe('workshop');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'workshop', { timeout: 15_000 });
    await expect(page.locator('#workshop-diff-viewer')).toBeVisible();
    run.router.gitDiff = 'git';
    run.router.gitDiffTarget = 'workshop';

    const plainDiff = await dispatch(page, 'git diff');
    expect(plainDiff.route, 'git diff routes to git').toBe('git');
    expect(plainDiff.capability).toBe('git.diff_inspect');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'workshop', { timeout: 15_000 });
    await page.screenshot({ path: path.join(reportDir, '08-router.png'), fullPage: true });
    run.screenshots += 1;
    checkpoint('router', run.router);

    // ------------------------------------ 9. Three viewports, every screen, no overflow ---
    // Every screen is opened at each viewport and measured. The surfaces this milestone added are the
    // widest things in the product - a diff table and two telemetry tables - so this is where a fixed
    // column would show up.
    const views = ['workshop', 'sentinel', 'deck', 'mission', 'briefing', 'memory', 'council', 'presence', 'system'];
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const view of views) {
        const nav = page.locator(`button.nav-item[data-view="${view}"]`);
        if (await nav.count()) await nav.first().click();
        await page.waitForTimeout(120);
        const overflow = await measureOverflow(page);
        expect(overflow.overflows, `horizontal overflow on ${view} at ${viewport.width}x${viewport.height}: ${JSON.stringify(overflow.offending)}`).toBe(false);
        run.viewports.push({ viewport: viewport.name, width: viewport.width, height: viewport.height, view, scrollWidth: overflow.documentScrollWidth, clientWidth: overflow.clientWidth });
      }
      // The two surfaces the milestone built are measured at the narrow size with their content on
      // screen, because a table that fits while empty proves nothing.
      if (viewport.name === 'phone') {
        await page.locator('button.nav-item[data-view="workshop"]').click();
        await expect(page.locator('#workshop-diff-viewer')).toBeVisible();
        const diffOverflow = await measureOverflow(page);
        expect(diffOverflow.overflows, `the diff viewer overflows the phone viewport: ${JSON.stringify(diffOverflow.offending)}`).toBe(false);
        await page.locator('button.nav-item[data-view="sentinel"]').click();
        await expect(page.locator('#edith-port-table')).toBeVisible();
        const telemetryOverflow = await measureOverflow(page);
        expect(telemetryOverflow.overflows, `telemetry overflows the phone viewport: ${JSON.stringify(telemetryOverflow.offending)}`).toBe(false);
      }
      await page.screenshot({ path: path.join(reportDir, `09-${viewport.name}.png`), fullPage: true });
      run.screenshots += 1;
      checkpoint('viewport', { viewport: viewport.name, screens: views.length });
    }

    // The voice promise, restated because T-43 must not have quietly re-enabled anything.
    await page.locator('button.nav-item[data-view="system"]').click();
    const privacy = await page.locator('#sensor-privacy-indicator').innerText();
    expect(privacy, 'the privacy indicator states audio/mic is disabled').toMatch(/audio[^\n]*mic[^\n]*disabled/i);
    run.voice = { privacyIndicator: privacy.trim().slice(0, 120) };

    // ------------------------------------------------------------- 10. Nothing broke ---
    // Refusals are not errors: this walk schedules none, so any console error is a failure.
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    expect(pageErrors, `uncaught exceptions: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(failedRequests.filter((entry) => !/favicon/.test(entry.url)), `failed requests: ${JSON.stringify(failedRequests)}`).toEqual([]);
    expect(run.screenshots).toBeGreaterThanOrEqual(11);
    checkpoint('complete');
  } catch (error) {
    run.failures.push(String(error?.stack ?? error));
    throw error;
  } finally {
    run.consoleErrors = consoleErrors;
    run.pageErrors = pageErrors;
    run.failedRequests = failedRequests;
    writeSummary();
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.stop().catch(() => {});
  }
});
