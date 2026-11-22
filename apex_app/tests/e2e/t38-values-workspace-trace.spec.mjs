// T-38 Step 4 (2026-11-21): the values, workspace and trace walk.
//
// This is the end-to-end claim of the three steps together, made in a real browser against a real
// server:
//
//   1. A Council deliberation written in natural language resolves to a capability, and the core
//      reaches `satisfied` with the candidate's reversibility and blast radius stated explicitly -
//      not `partly_unverifiable`, and not a verdict whose evidence is missing.
//   2. The Workshop lists the real files of the configured workspace, reads one with its real line
//      numbers, stages a candidate with broken syntax, catches it with a real `node --check`, refuses
//      promotion, then stages a valid one, verifies it, shows the diff and the SHA-256, and promotes
//      it through the ECP.
//   3. The Memory Timeline searches every ledger and opens a causal chain that reaches a cognitive
//      run, a Council session and a task graph.
//
// And across all of it: zero console errors, zero uncaught exceptions, no horizontal overflow.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import { startT38Ui, T38_SCHEMA, T38_VALID_CANDIDATE, T38_BROKEN_CANDIDATE } from './t38-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(here, '..', '..');
const reportDir = path.join(repoDir, 'reports', 'screenshots', 't38');
const summaryPath = path.join(repoDir, 'reports', 't38-values-workspace-trace.json');

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
  schema: T38_SCHEMA,
  browserBinary: BROWSER_BINARY_SCHEMA,
  resolved: { executable: resolution.executable, source: resolution.source, candidate: resolution.browser?.label ?? null },
  browserVersion: null,
  platform: process.platform,
  node: process.version,
  headless: true,
  values: null,
  workspace: null,
  sandbox: null,
  trace: null,
  overflow: null,
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

// The summary is written after every phase, not only at the end. A test that is killed by the
// Playwright timeout never reaches its own `finally`, and a suite that leaves no summary behind
// turns one failure into two: the annotation step then has nothing to read and reports a second
// problem that is only a symptom. With a checkpoint the record always names the last phase that
// finished, so a timeout is diagnosable from the artifact alone.
function checkpoint(phase, detail = null) {
  run.lastPhase = phase;
  run.phases = Array.isArray(run.phases) ? run.phases : [];
  run.phases.push({ phase, at: new Date().toISOString(), detail });
  writeSummary();
}

// Every element that declares a screen, read from the live DOM so the audit is of what the browser
// parsed rather than of the source that produced it.
async function readScreenDeclarations(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('[data-screen-id]')).map((node) => ({
    id: node.getAttribute('data-screen-id'),
    message: node.getAttribute('data-screen-message'),
  })));
}

// Horizontal overflow, measured on the document and on every view, so a panel that pushes the page
// wide fails the walk instead of being noticed later.
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

test.describe.configure({ mode: 'serial' });

test('T-38: safety metadata, the real workspace sandbox, and the causal chain in a real browser', async () => {
  // This walk does more than any other suite in one test: it starts a server, launches a browser,
  // deliberates twice, stages and verifies twice, and walks every view measuring overflow. Its own
  // budget is stated here rather than inherited, so a slow machine fails for being slow and not for
  // being asked to do the whole milestone in ninety seconds - but it is also bounded, because the
  // job that runs eight browser suites has a thirty-five minute ceiling and one suite may not take
  // an unbounded share of it. Every phase writes a checkpoint, so a timeout here names the phase.
  test.setTimeout(180_000);
  test.skip(!resolution.executable, noBrowserDiagnostic(resolution));
  fs.mkdirSync(reportDir, { recursive: true });

  // The fixture and the browser are started inside the try, so a failure to start either one still
  // writes a summary. A suite that fails before its own reporting step leaves the annotation step with
  // nothing to read, which turns one failure into two.
  let fixture = null;
  let browser = null;
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  try {
    fixture = await startT38Ui();
    browser = await chromium.launch({ executablePath: resolution.executable, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    // A refusal that the walk asks for on purpose is not noise. The walk promotes a broken candidate
    // through fetch() to prove the *server* refuses it, and Chromium logs any non-2xx response as a
    // console error regardless of what the client does with it. Those two deliberate probes are
    // counted separately, as `expectedRefusals`, so the zero-console-error assertion keeps its
    // meaning: it still fails on anything the page did not ask for.
    const EXPECTED_REFUSAL = /Failed to load resource: the server responded with a status of (409|403)/;
    const expectedRefusals = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (EXPECTED_REFUSAL.test(message.text())) { expectedRefusals.push(message.text()); return; }
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

    checkpoint('page loaded');

    // ------------------------------------------------------------- 1. the constraints core ---
    // A natural-language objective naming a capability. The backend resolves it, evaluates the core
    // and records the declaration it read; the walk asserts on that record rather than on the prose
    // the deck happens to render.
    const deliberation = await fixture.post('/api/council/deliberate', { objective: 'run the neural step' });
    expect(deliberation.status).toBe(200);

    const sessionFile = path.join(fixture.dataDir, 'council.jsonl');
    const sessions = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const session = sessions[sessions.length - 1];
    const constraintPosition = session.positions.find((p) => p.perspectiveId === 'constraint_check');
    expect(constraintPosition, 'the eighth perspective must be the constraints core').toBeTruthy();

    const verdict = constraintPosition.position.verdict;
    run.values = {
      verdict,
      counts: constraintPosition.evaluation.counts,
      declaration: constraintPosition.declaration,
      candidate: session.input.candidate,
      rules: constraintPosition.evaluation.evaluations.map((rule) => ({ name: rule.name, verdict: rule.verdict })),
    };
    // The T-38 acceptance criterion: resolved, satisfied, and not partly_unverifiable.
    expect(verdict).toBe('satisfied');
    expect(constraintPosition.evaluation.counts.unverifiable).toBe(0);
    expect(constraintPosition.evaluation.counts.violated).toBe(0);
    // The candidate is named, and its safety metadata is stated explicitly.
    expect(session.input.candidate?.id).toBe('neural.step');
    expect(session.input.candidate?.reversibility).toBe('reversible');
    expect(session.input.candidate?.blastRadius).toBe('local_store');
    // And the declaration the core read travels with its verdict.
    expect(constraintPosition.declaration?.reversibility).toBe('reversible');
    expect(constraintPosition.declaration?.blastRadius).toBe('local_store');
    expect(constraintPosition.declaration?.metadataSource).toBe('declared');
    // Every rule row states a verdict of its own; none of them is blank.
    for (const rule of constraintPosition.evaluation.evaluations) {
      expect(['satisfied', 'violated', 'unverifiable', 'not_applicable']).toContain(rule.verdict);
    }

    checkpoint('constraints core');

    // The honesty rule, in the same breath: an objective that names nothing still says why.
    await fixture.post('/api/council/deliberate', { objective: 'make me a sandwich' });
    const after = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const unmapped = after[after.length - 1].positions.find((p) => p.perspectiveId === 'constraint_check');
    run.values.unmapped = {
      verdict: unmapped.position.verdict,
      details: unmapped.evaluation.evaluations.map((rule) => rule.detail),
    };
    expect(unmapped.position.verdict).toBe('partly_unverifiable');
    // The reason is the verbatim string the brief requires.
    expect(unmapped.evaluation.evaluations.some((rule) => rule.detail.includes('no_mapped_capability'))).toBe(true);

    checkpoint('unmapped objective');

    // ------------------------------------------------------------------- 2. the real workspace ---
    await page.click('[data-view="workshop"]');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'workshop');
    await page.click('#ws-refresh');
    await expect(page.locator('#ws-state')).not.toContainText('Inspecting', { timeout: 20_000 });
    // Four entries: the three files the fixture wrote and the directory that holds two of them. The
    // directory is listed because the inspector reports the tree it read, not a flattened file list.
    await expect(page.locator('#ws-entries li')).toHaveCount(4);

    // The listing names the fixture's real files and directories.
    const listedPaths = await page.locator('#ws-entries li strong').allTextContents();
    const listedKinds = await page.locator('#ws-entries li .meta').allTextContents();
    run.workspace = { listed: listedPaths.sort(), kinds: listedKinds.slice(0, 8) };
    expect(listedPaths.sort()).toEqual(['README.md', 'src', 'src/data.json', 'src/greeting.js']);
    expect(listedPaths).toContain('src');

    // Bytes, lines and a digest, all recomputed here from the file on disk.
    const greetingPath = path.join(fixture.workspace, 'src', 'greeting.js');
    const greetingText = fs.readFileSync(greetingPath, 'utf8');
    const { createHash } = await import('node:crypto');
    const expectedDigest = createHash('sha256').update(greetingText).digest('hex');
    const greetingRow = page.locator('#ws-entries li', { hasText: 'src/greeting.js' });
    await expect(greetingRow).toContainText(`${greetingText.length} B`);
    await expect(greetingRow).toContainText('3 lines');
    await expect(greetingRow).toContainText(`sha256 ${expectedDigest.slice(0, 12)}`);
    run.workspace.digestMatchesDisk = true;

    // A bounded excerpt with the file's real line numbers.
    await greetingRow.locator('button', { hasText: 'Read' }).click();
    await expect(page.locator('#ws-excerpt-panel')).toBeVisible({ timeout: 15_000 });
    const excerpt = await page.locator('#ws-excerpt').textContent();
    run.workspace.excerpt = excerpt;
    expect(excerpt).toMatch(/^ {1,5}1 {2}export function greet\(name\) \{/m);
    expect(excerpt).toMatch(/^ {1,5}2 {2} {2}return `hello \$\{name\}`;/m);
    // The excerpt body is the numbered lines and nothing else. The path, the line range and the
    // digest are in the panel title, which is where a reader looks to cite what they are reading.
    expect(excerpt).not.toContain('sha256');
    const excerptTitle = await page.locator('#ws-excerpt-title').textContent();
    run.workspace.excerptTitle = excerptTitle;
    expect(excerptTitle).toContain('src/greeting.js');
    expect(excerptTitle).toContain('sha256 ' + expectedDigest.slice(0, 12));
    // The range names the file's real lines, and after the phantom-line fix it ends at the real last
    // line rather than one past it.
    expect(excerptTitle).toContain('lines 1–3 of 3');

    checkpoint('workspace listed and read');

    // --------------------------------------------------------------------- 3. the sandbox ---
    // A candidate with broken syntax, staged and then verified in the browser. The backend runs a real
    // `node --check`; the panel must show the failure and its message, and promotion must be refused.
    const liveBefore = fs.readFileSync(greetingPath, 'utf8');
    await page.fill('#ws-stage-path', 'src/greeting.js');
    await page.fill('#ws-stage-rationale', 'a broken change, to prove the parser catches it');
    await page.fill('#ws-stage-content', T38_BROKEN_CANDIDATE);
    await page.click('#ws-stage-submit');
    await expect(page.locator('#ws-stage-status')).toContainText('Staged', { timeout: 20_000 });

    // Before verification the candidate says so; it does not show an empty badge or a green one.
    const brokenCandidate = page.locator('#ws-candidates li').first();
    await expect(brokenCandidate.locator('.badge')).toHaveText('not checked');
    await expect(brokenCandidate.locator('button', { hasText: 'Promote' })).toBeDisabled();

    await brokenCandidate.locator('button', { hasText: 'Verify' }).click();
    await expect(brokenCandidate.locator('.badge')).toHaveText('not verified', { timeout: 25_000 });
    // The parser's own message is on screen, verbatim enough to name the problem.
    await expect(brokenCandidate).toContainText('SyntaxError');
    await expect(brokenCandidate).toContainText('real_parse');
    await expect(page.locator('#ws-stage-status')).toContainText('Promotion is refused');
    // Promotion is still unavailable, because the backend said verified:false.
    await expect(brokenCandidate.locator('button', { hasText: 'Promote' })).toBeDisabled();

    // The refusal is enforced by the server, not only by the disabled button.
    const candidateIdFromDom = await brokenCandidate.locator('[data-candidate-id]').first().getAttribute('data-candidate-id');
    const refused = await page.evaluate(async (candidateId) => {
      const response = await fetch('/api/workshop/promote-file', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-apex-ui': '1' },
        body: JSON.stringify({ candidateId, reason: 'the browser tried to promote a broken file' }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    }, candidateIdFromDom);
    run.sandbox = {
      refusedPromotionStatus: refused.status,
      refusedPromotionCode: refused.body?.code ?? null,
      liveFileUnchangedAfterRefusal: fs.readFileSync(greetingPath, 'utf8') === liveBefore,
    };
    expect(refused.status).toBe(409);
    expect(refused.body?.code).toBe('PROMOTION_REFUSED');
    // And the live workspace was never written.
    expect(fs.readFileSync(greetingPath, 'utf8')).toBe(liveBefore);

    checkpoint('broken candidate caught and refused');

    // A valid candidate. It must verify, show a diff and both digests, and promote through the ECP.
    await page.fill('#ws-stage-path', 'src/greeting.js');
    await page.fill('#ws-stage-rationale', 'the valid version, which should be accepted');
    await page.fill('#ws-stage-content', T38_VALID_CANDIDATE);
    await page.click('#ws-stage-submit');
    await expect(page.locator('#ws-stage-status')).toContainText('Staged', { timeout: 20_000 });

    const validCandidate = page.locator('#ws-candidates li').first();
    await expect(validCandidate.locator('.badge')).toHaveText('not checked');
    await validCandidate.locator('button', { hasText: 'Verify' }).click();
    await expect(validCandidate.locator('.badge')).toHaveText('verified', { timeout: 25_000 });
    // Six checks, a parser that ran, an exit code of zero, and a diff.
    await expect(validCandidate).toContainText('6/6 checks passed');
    await expect(validCandidate).toContainText('exit 0');
    // The diff is line-based: one line changed and one was added, so +2/-1. The numbers are pinned
    // rather than matched loosely, because a diff summary that drifts from the change is exactly the
    // kind of quiet inaccuracy the panel exists to avoid.
    await expect(validCandidate).toContainText('diff +2/-1');
    const validText = await validCandidate.textContent();
    run.sandbox.valid = { rendered: validText.slice(0, 600) };
    const stagedDigest = (validText.match(/sha256 ([0-9a-f]{12})/) ?? [])[1] ?? null;
    expect(stagedDigest).toBeTruthy();
    // The staged content is the proposed content, so its digest is not the live file's.
    expect(stagedDigest).not.toBe(expectedDigest.slice(0, 12));

    // Promote: the browser is asked for a reason, which is recorded.
    // window.prompt opens a dialog, so the handler is registered before the click and the click is
    // awaited after the dialog is answered. A prompt with no handler stalls until the test times out.
    const dialogAnswered = page.waitForEvent('dialog', { timeout: 20_000 }).then(async (dialog) => {
      const answer = 'the browser walk accepts this change';
      await dialog.accept(answer);
      return answer;
    });
    await validCandidate.locator('button', { hasText: 'Promote' }).click();
    const acceptedReason = await dialogAnswered;
    run.sandbox.promotionReason = acceptedReason;
    await expect(page.locator('#ws-stage-status')).toContainText('Promoted', { timeout: 25_000 });
    // A promotion records a decision; it still does not write the live tree.
    expect(fs.readFileSync(greetingPath, 'utf8')).toBe(liveBefore);
    run.sandbox.promotedWithoutWritingLiveTree = true;

    checkpoint('valid candidate verified and promoted');

    // ------------------------------------------------------------------------ 4. the trace ---
    await page.click('[data-view="memory"]');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'memory');
    await page.fill('#trace-search-q', 'launch');
    await page.click('#trace-search-button');
    await expect(page.locator('#trace-search-statusline')).not.toContainText('Searching', { timeout: 20_000 });
    await expect(page.locator('#trace-search-statusline')).toContainText('matched');
    const resultCount = await page.locator('#trace-results li').count();
    expect(resultCount).toBeGreaterThan(0);
    run.trace = { resultCount, kinds: await page.locator('#trace-results .badge').allTextContents() };
    // Every kind the run wrote is findable.
    expect(run.trace.kinds).toContain('cognitive run');
    expect(run.trace.kinds).toContain('Council session');
    expect(run.trace.kinds).toContain('task graph');

    // Open the chain from the run's own result.
    const runResult = page.locator('#trace-results li', { hasText: 'cognitive run' }).first();
    await runResult.locator('button', { hasText: 'Open chain' }).click();
    await expect(page.locator('#trace-chain-status')).toContainText('Complete chain', { timeout: 20_000 });
    await expect(page.locator('#trace-chain li')).not.toHaveCount(0);
    const chainText = await page.locator('#trace-chain').textContent();
    run.trace.chainLength = await page.locator('#trace-chain li').count();
    run.trace.complete = true;
    // The chain reaches a run, a Council session with its constraint verdict, and the task graph.
    expect(chainText).toContain('cognitive run');
    expect(chainText).toContain('Council deliberation');
    expect(chainText).toContain('task graph created');
    expect(chainText).toContain('satisfied');
    expect(chainText).toContain('reversible');
    expect(chainText).toContain('local_store');
    // Every step names what linked it.
    expect(chainText).toContain('linked by:');

    checkpoint('trace chain open');

    // ------------------------------------------------------- 5. every screen, and no overflow ---
    const screens = await readScreenDeclarations(page);
    expect(screens.length).toBeGreaterThanOrEqual(11);
    for (const screen of screens) {
      expect(screen.id, 'a screen must declare an id').toBeTruthy();
      expect(screen.message, `${screen.id} must declare a screen message`).toBeTruthy();
    }

    // Walk every view, measuring overflow at each one, because a panel that only overflows on one
    // screen is exactly what a single measurement would miss.
    const views = await page.locator('.nav-item[data-view]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-view')));
    const perView = [];
    for (const view of views) {
      const startedAt = Date.now();
      await page.click(`.nav-item[data-view="${view}"]`);
      await page.waitForTimeout(80);
      const measured = await measureOverflow(page);
      perView.push({ view, ...measured, ms: Date.now() - startedAt });
      // One checkpoint per view: if the budget runs out during the walk, the summary names the view
      // and the times of the ones that finished, which is the difference between "the walk is slow"
      // and "this screen hangs the browser".
      checkpoint(`view ${view}`, { ms: Date.now() - startedAt });
    }
    run.overflow = perView;
    for (const measured of perView) {
      expect(measured.overflows, `${measured.view} overflows horizontally: ${JSON.stringify(measured.offending)}`).toBe(false);
    }
    // And a capture of the memory view, where the chain was read, and of the workshop sandbox. These
    // are viewport captures: after the walk the document is many screens tall, and a full-page image
    // of it is slow to take and unreadable as evidence. The overflow numbers above are the record of
    // the whole page; these two images are the record of the two panels the milestone added.
    await page.click('.nav-item[data-view="memory"]');
    await page.waitForTimeout(150);
    checkpoint('memory view reopened');
    await page.screenshot({ path: path.join(reportDir, 'memory-trace-chain.png') });
    run.screenshots += 1;
    checkpoint('memory screenshot');
    await page.click('.nav-item[data-view="workshop"]');
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(reportDir, 'workshop-sandbox.png') });
    run.screenshots += 1;
    checkpoint('workshop screenshot');

    // ---------------------------------------------------------------- 6. nothing failed ---
    // The console collectors have been running since the first byte of the page. Nothing may have
    // been logged as an error, thrown uncaught, or failed to load.
    run.consoleErrors = consoleErrors;
    run.pageErrors = pageErrors;
    run.failedRequests = failedRequests;
    expect(pageErrors, `uncaught exceptions: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    // The two deliberate refusals were seen, and nothing else was filtered out. Pinning the count
    // means the filter cannot quietly grow into a blanket exemption.
    expect(expectedRefusals.length, `expected refusals seen: ${expectedRefusals.join(' | ')}`).toBe(1);
    expect(failedRequests, `failed requests: ${failedRequests.join(' | ')}`).toEqual([]);
  } catch (error) {
    run.failures.push(String(error?.message ?? error));
    throw error;
  } finally {
    run.consoleErrors = consoleErrors;
    run.pageErrors = pageErrors;
    run.failedRequests = failedRequests;
    run.expectedRefusals = expectedRefusals;
    writeSummary();
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.stop().catch(() => {});
  }
});
