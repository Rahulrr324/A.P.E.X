// T-41 Step 4 (2026-11-22): the sandbox-test and evolution-bridge walk.
//
// This is the end-to-end claim of Steps 1 to 3, made in a real browser against a real server, a real
// directory on disk, and a real `node --test` child process:
//
//   1. A proposal that targets the ECP is refused 403 IMMUTABLE_GOVERNANCE_BOUNDARY, the five safety
//      boundaries are all still intact afterwards, and the evolution ledger holds no proposal.
//   2. A proposal for `src/greeting.js` is recorded with a companion test, staged into the Workshop,
//      and verified. The FIRST run's test asserts the wrong version and fails: `verified` is false, the
//      failing assertion's own words are on the screen, and the apply is refused - both by the disabled
//      button and, when the walk posts directly, by the server with 409 APPLY_REFUSED_UNVERIFIED.
//   3. The corrected test passes: `verified` is true with a real pass count, and Apply writes the file.
//      The bytes are then read back here and compared to the candidate.
//   4. The causal trace, asked for by the PROPOSAL id, holds the whole chain: the stage, the sandbox
//      verification with its `sourceProposalId`, the apply, and the ECP audit entries.
//
// And across all of it: zero console errors outside the refusals the walk asked for, zero uncaught
// exceptions, no horizontal overflow on any view.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import {
  startT41Ui, T41_SCHEMA, T41_GREETING_LIVE, T41_GREETING_NEXT,
  T41_TEST_FAILING, T41_TEST_PASSING, T41_PROTECTED,
} from './t41-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(here, '..', '..');
const reportDir = path.join(repoDir, 'reports', 'screenshots', 't41');
const summaryPath = path.join(repoDir, 'reports', 't41-sandbox-test-and-evolution-bridge.json');

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
  schema: T41_SCHEMA,
  browserBinary: BROWSER_BINARY_SCHEMA,
  resolved: { executable: resolution.executable, source: resolution.source, candidate: resolution.browser?.label ?? null },
  browserVersion: null,
  platform: process.platform,
  node: process.version,
  headless: true,
  boundary: null,
  failingTest: null,
  passingTest: null,
  apply: null,
  trace: null,
  bridge: null,
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

// Stage a candidate through the panel's own controls, with its companion test, and verify it.
// The candidate id is read once and every later locator is scoped by it: `.first()` is lazy and would
// silently retarget when the next candidate is staged.
async function stageWithTest(page, { relativePath, content, test, rationale }) {
  await page.fill('#ws-stage-path', relativePath);
  await page.fill('#ws-stage-rationale', rationale);
  await page.fill('#ws-stage-content', content);
  await page.fill('#ws-stage-test', test);
  await page.click('#ws-stage-submit');
  await expect(page.locator('#ws-stage-status')).toContainText('Staged', { timeout: 20_000 });
  await expect(page.locator('#ws-stage-status')).toContainText('sandbox test');

  const newest = page.locator('#ws-candidates li').first();
  const id = await newest.locator('[data-candidate-id]').first().getAttribute('data-candidate-id');
  expect(id).toBeTruthy();
  const candidate = page.locator('#ws-candidates li', { has: page.locator(`[data-candidate-id="${id}"]`) });
  await expect(candidate.locator('.badge').first()).toHaveText('not checked');
  return { candidate, candidateId: id };
}

test.describe.configure({ mode: 'serial' });

test('T-41: the governance boundary refuses, a failing sandbox test blocks the apply, a passing one allows it, and the trace holds the chain', async () => {
  // Stated rather than inherited: this walk starts a server, launches a browser, records three
  // proposals, stages twice, runs the real test runner twice, applies a file and probes the trace.
  test.setTimeout(300_000);
  test.skip(!resolution.executable, noBrowserDiagnostic(resolution));
  fs.mkdirSync(reportDir, { recursive: true });

  let fixture = null;
  let browser = null;
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const scheduledRefusals = [];

  try {
    fixture = await startT41Ui();
    const greetingBefore = fixture.readGreeting();
    expect(greetingBefore).toBe(T41_GREETING_LIVE);
    const greetingBase = sha256(greetingBefore);
    // The protected files are read before and after, so "the boundary is intact" is a measurement.
    const protectedBefore = new Map(T41_PROTECTED.map((relative) => [relative, sha256(fixture.readProtected(relative))]));

    browser = await chromium.launch({ executablePath: resolution.executable, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // The walk asks for three refusals on purpose: the boundary 403, the failing-test verification
    // (which is a 200 carrying verified:false, so it logs nothing) and the direct unverified apply,
    // which is a 409. Chromium logs every 4xx as a console error whatever the client does with it, so
    // they are counted separately and the count is pinned at the end.
    const EXPECTED_REFUSAL = /Failed to load resource: the server responded with a status of (403|409|423)/;
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

    // -------------------------- 1. the boundary, refused in the browser and on the server ---
    await page.fill('#evolution-title', 'rewrite the control plane');
    await page.fill('#evolution-target', 'src/executive/control-plane.js');
    await page.fill('#evolution-content', 'export const bypass = true;\n');
    run.scheduledRefusals = scheduledRefusals;
    await page.click('#evolution-propose');
    // The status line repeats the code AND the reason, because a 403 the owner cannot read is a 403
    // the owner will try again.
    await expect(page.locator('#evolution-form-status')).toContainText('IMMUTABLE_GOVERNANCE_BOUNDARY', { timeout: 20_000 });
    await expect(page.locator('#evolution-form-status')).toContainText('immutable governance boundary');
    checkpoint('boundary refused');

    // The same refusal for every protected path, on the server, so the walk covers the policy rather
    // than one example of it.
    const boundaryResults = [];
    for (const target of T41_PROTECTED) {
      const refused = await fixture.post('/api/evolution/propose', {
        title: `change ${target}`, targetRelativePath: target, proposedContent: 'x\n',
      });
      boundaryResults.push({ target, status: refused.status, code: refused.body?.code ?? null, category: refused.body?.boundary?.category ?? null });
    }
    for (const result of boundaryResults) {
      expect(result.status, `${result.target} -> ${JSON.stringify(result)}`).toBe(403);
      expect(result.code).toBe('IMMUTABLE_GOVERNANCE_BOUNDARY');
      expect(result.category).toBeTruthy();
    }

    // The ledger holds no proposal, and every protected file is byte-identical.
    const eventsAfterBoundary = fixture.evolutionEvents();
    expect(eventsAfterBoundary.filter((event) => event.type === 'proposal_created')).toEqual([]);
    const protectedAfter = new Map(T41_PROTECTED.map((relative) => [relative, sha256(fixture.readProtected(relative))]));
    for (const relative of T41_PROTECTED) {
      expect(protectedAfter.get(relative), `${relative} changed`).toBe(protectedBefore.get(relative));
    }
    run.boundary = {
      refusedInBrowser: true,
      refusedOnServer: boundaryResults.length,
      allFiveRefused: true,
      allFiveIntact: true,
      proposalRecorded: 0,
      code: 'IMMUTABLE_GOVERNANCE_BOUNDARY',
      // The five the milestone names, all present in the policy the screen renders.
      policyPaths: T41_PROTECTED,
      category: boundaryResults[0].category,
    };
    checkpoint('all five boundaries refused and intact');
    await page.screenshot({ path: path.join(reportDir, 'boundary-refusal.png') });
    run.screenshots += 1;

    // ------------------------------------ 2. a FAILING sandbox test blocks the apply ---
    const failing = await stageWithTest(page, {
      relativePath: 'src/greeting.js',
      content: T41_GREETING_NEXT,
      test: T41_TEST_FAILING,
      rationale: 'the first attempt, whose test asserts the wrong version',
    });
    await failing.candidate.locator('button', { hasText: 'Verify' }).click();
    await expect(failing.candidate.locator('.badge').first()).toHaveText('not verified', { timeout: 30_000 });
    // The failing assertion's own words are on the row: the exit code alone would tell the owner
    // nothing about what to fix.
    await expect(failing.candidate).toContainText('sandbox test');
    await expect(failing.candidate).toContainText(/passed, \d+ failed/);
    await expect(failing.candidate.locator('pre.code').last()).toContainText(/version 3|AssertionError|not ok/i);
    // The button is disabled because the backend said verified:false.
    await expect(failing.candidate.locator(`[data-apply-candidate="${failing.candidateId}"]`)).toBeDisabled();
    // And the server refuses it independently: the button is a courtesy, the gate is the contract.
    const directApply = await fixture.post(`/api/workshop/candidates/${failing.candidateId}/apply`, { reason: 'the failing attempt' });
    expect(directApply.status, JSON.stringify(directApply.body)).toBe(409);
    expect(directApply.body.code).toBe('APPLY_REFUSED_UNVERIFIED');
    // Nothing was written.
    expect(fixture.readGreeting()).toBe(greetingBefore);

    run.failingTest = {
      candidateId: failing.candidateId,
      verified: false,
      badgeText: 'not verified',
      applyButtonDisabled: true,
      serverApplyStatus: directApply.status,
      serverApplyCode: directApply.body.code,
      failingOutputShown: true,
      workspaceUnchanged: true,
      baseSha256: greetingBase,
    };
    checkpoint('failing sandbox test blocked the apply');
    await page.screenshot({ path: path.join(reportDir, 'failing-sandbox-test.png') });
    run.screenshots += 1;

    // ------------------------------------ 3. a PASSING sandbox test allows the apply ---
    const passing = await stageWithTest(page, {
      relativePath: 'src/greeting.js',
      content: T41_GREETING_NEXT,
      test: T41_TEST_PASSING,
      rationale: 'the corrected attempt, whose test asserts what the candidate does',
    });
    await passing.candidate.locator('button', { hasText: 'Verify' }).click();
    await expect(passing.candidate.locator('.badge').first()).toHaveText('verified', { timeout: 30_000 });
    // The pass count is the runner's own: two assertions, and the row says two.
    const rowText = await passing.candidate.innerText();
    const passedMatch = /(\d+) passed, (\d+) failed/.exec(rowText);
    expect(passedMatch, `the row must state the runner's counts: ${rowText.slice(0, 200)}`).toBeTruthy();
    expect(Number(passedMatch[1])).toBeGreaterThanOrEqual(2);
    expect(Number(passedMatch[2])).toBe(0);

    const applyButton = passing.candidate.locator(`[data-apply-candidate="${passing.candidateId}"]`);
    await expect(applyButton).toBeEnabled();
    const dialog = acceptNextDialog(page, 'T-41 walk: the test asserts what the candidate does');
    await applyButton.click();
    const answer = await dialog;
    expect(answer.error, `the apply dialog never appeared: ${answer.error}`).toBeNull();
    expect(answer.answered).toBe(true);
    // Verified on disk, then read back here: `reported` is not `written`.
    await expect(passing.candidate).toContainText(/applied|written/i, { timeout: 30_000 });
    const greetingAfter = fixture.readGreeting();
    expect(greetingAfter).toBe(T41_GREETING_NEXT);
    expect(sha256(greetingAfter)).toBe(sha256(T41_GREETING_NEXT));

    run.passingTest = {
      candidateId: passing.candidateId,
      verified: true,
      passedCount: Number(passedMatch[1]),
      failedCount: Number(passedMatch[2]),
      applyButtonEnabled: true,
      applied: true,
      greetingSha256: sha256(greetingAfter),
      bytesWritten: greetingAfter.length,
      baseSha256: greetingBase,
    };
    checkpoint('passing sandbox test applied the file');
    await page.screenshot({ path: path.join(reportDir, 'passing-sandbox-test-applied.png') });
    run.screenshots += 1;

    // ------------------------------------------- 4. the causal trace holds the chain ---
    const trace = await fixture.get(`/api/memory/trace/${failing.candidateId}`);
    expect(trace.status, JSON.stringify(trace.body)).toBe(200);
    const entries = Array.isArray(trace.body.entries) ? trace.body.entries : [];
    const kinds = entries.map((entry) => entry.kind);
    expect(kinds).toContain('workshop_verification');
    expect(kinds.filter((kind) => kind === 'ecp_audit').length).toBeGreaterThanOrEqual(2);
    // The FAILING candidate's trace holds its verification - and correctly NO apply, because the
    // apply was refused. A chain that showed an apply here would be the one thing a causal trace
    // cannot do: report something that did not happen.
    const verification = entries.find((entry) => entry.kind === 'workshop_verification');
    expect(verification.detail.candidateId).toBe(failing.candidateId);
    expect(verification.detail.sandboxTestResult, 'the trace carries the sandbox test result').toBeTruthy();
    expect(verification.detail.sandboxTestResult.failedCount).toBeGreaterThanOrEqual(1);
    expect(kinds).not.toContain('workshop_apply');
    expect(trace.body.complete, JSON.stringify(trace.body.missing)).toBe(true);

    // The APPLIED candidate's trace is the full chain, and it reaches back to the proposal through
    // `sourceProposalId` on the verification.
    const passTrace = await fixture.get(`/api/memory/trace/${passing.candidateId}`);
    expect(passTrace.status).toBe(200);
    const passEntries = Array.isArray(passTrace.body.entries) ? passTrace.body.entries : [];
    const passKinds = passEntries.map((entry) => entry.kind);
    expect(passKinds).toContain('workshop_verification');
    expect(passKinds).toContain('workshop_apply');
    expect(passKinds.filter((kind) => kind === 'ecp_audit').length).toBeGreaterThanOrEqual(2);
    const passVerification = passEntries.find((entry) => entry.kind === 'workshop_verification');
    expect(passVerification.detail.candidateId).toBe(passing.candidateId);
    // Staged through the Workshop panel, not from a proposal: the field is honestly null rather than
    // absent or invented.
    expect(passVerification.detail.sourceProposalId).toBeNull();
    expect(passVerification.detail.sandboxTestResult.failedCount).toBe(0);
    const passApply = passEntries.find((entry) => entry.kind === 'workshop_apply');
    expect(passApply.detail.candidateId).toBe(passing.candidateId);
    expect(passTrace.body.complete, JSON.stringify(passTrace.body.missing)).toBe(true);

    run.trace = {
      candidateId: failing.candidateId,
      entries: entries.length,
      kinds: [...new Set(kinds)],
      verifications: kinds.filter((kind) => kind === 'workshop_verification').length,
      applies: kinds.filter((kind) => kind === 'workshop_apply').length,
      operations: kinds.filter((kind) => kind === 'ecp_audit').length,
      sandboxTestResultOnTrace: true,
      // The panel-staged candidate has no proposal, so this is honestly false here; the bridge leg
      // below proves the true case on a candidate that really came from a proposal.
      sourceProposalIdOnTrace: Boolean(passVerification.detail.sourceProposalId),
      complete: trace.body.complete === true,
      appliedCandidateComplete: passTrace.body.complete === true,
      appliedKinds: [...new Set(passKinds)],
      appliedApplies: passKinds.filter((kind) => kind === 'workshop_apply').length,
    };
    checkpoint('causal trace verified');
    await page.screenshot({ path: path.join(reportDir, 'causal-trace.png') });
    run.screenshots += 1;

    // ------- 5. the bridge, through the UI, ending in an APPLIED candidate with a full chain ---
    // Step 1 of T-42 closed the gap this leg used to have. The old version staged through the HTTP
    // route and then stopped at verification: the applied candidate's chain was never proven, and the
    // assertion that looked like it proved it was reading the FAILING candidate instead. This leg now
    // walks the chain the milestone is named for, in the browser, and ends by applying the file:
    //
    //   Evolution proposal -> Stage to Workshop (UI button) -> sandbox test -> apply -> causal trace
    //
    // and the trace asked for by the applied candidate must carry sourceProposalId and exactly one apply.
    const proposalId = await page.evaluate(async (contents) => {
      // Created through the page's own token, so the proposal the UI later renders is this one.
      const headers = { 'content-type': 'application/json', 'x-apex-ui': '1' };
      const proposed = await fetch('/api/evolution/propose', {
        method: 'POST', headers,
        body: JSON.stringify({
          title: 'the bridge records its source',
          hypothesis: 'a staged candidate should name the proposal that produced it',
          targetRelativePath: 'src/greeting.js',
          proposedContent: contents.next,
          testContent: contents.test,
        }),
      });
      const body = await proposed.json();
      if (!body.proposalId) throw new Error(`the proposal was refused: ${JSON.stringify(body).slice(0, 300)}`);
      const verification = await fetch('/api/evolution/verify', {
        method: 'POST', headers,
        body: JSON.stringify({ proposalId: body.proposalId, verified: true, detail: 'the sandbox run passed' }),
      });
      if (!verification.ok) throw new Error('the proposal verification was refused');
      return body.proposalId;
    }, { next: T41_GREETING_NEXT, test: T41_TEST_PASSING });
    expect(proposalId).toMatch(/^evo-[a-z0-9]+$/);
    checkpoint('evolution proposal recorded and verified', { proposalId });

    // Return to the Evolution Lab so the proposal list is re-read and the button is rendered.
    await page.click('.nav-item[data-view="workshop"]');
    await expect(page.locator('body')).toHaveAttribute('data-view', 'workshop');
    const stageButton = page.locator(`[data-stage-proposal="${proposalId}"]`);
    await expect(stageButton).toBeVisible({ timeout: 30_000 });
    await expect(stageButton).toBeEnabled();
    // The provenance is not on the card until the candidate exists, so the button is pressed first.
    await stageButton.click();
    await expect(page.locator('#evolution-status')).toContainText('staged ' + proposalId, { timeout: 30_000 });
    const evolutionStatus = await page.locator('#evolution-status').innerText();
    const bridgedCandidateId = (/staged evo-[a-z0-9]+ as (wsc-[0-9a-f]{12})/.exec(evolutionStatus) ?? [])[1] ?? null;
    expect(bridgedCandidateId, `the status line names the candidate: ${evolutionStatus.slice(0, 200)}`).toBeTruthy();
    checkpoint('staged through the UI button', { candidateId: bridgedCandidateId });

    // The link is on disk, in the sandbox candidate record.
    const record = fixture.candidateRecord(bridgedCandidateId);
    expect(record, 'the candidate record exists').toBeTruthy();
    expect(record.sourceProposalId, 'candidate.json carries the proposal id').toBe(proposalId);

    // And in /api/workshop, which is what a reloaded page reads.
    const workshopListing = await fixture.get('/api/workshop');
    expect(workshopListing.status).toBe(200);
    const listedCandidate = (workshopListing.body.candidates ?? []).find((entry) => entry.candidateId === bridgedCandidateId);
    expect(listedCandidate, '/api/workshop lists the staged candidate').toBeTruthy();
    expect(listedCandidate.sourceProposalId, '/api/workshop carries sourceProposalId').toBe(proposalId);

    // The card badge renders the provenance, in the browser.
    const bridgedCard = page.locator('#ws-candidates li', { has: page.locator(`[data-candidate-id="${bridgedCandidateId}"]`) });
    await expect(bridgedCard.locator(`[data-source-proposal="${proposalId}"]`)).toBeVisible({ timeout: 30_000 });

    // Verify in the Workshop: the sandbox runs the companion test that travelled with the proposal.
    await bridgedCard.locator('button', { hasText: 'Verify' }).click();
    await expect(bridgedCard.locator('.badge').first()).toHaveText('verified', { timeout: 30_000 });
    const bridgedRowText = await bridgedCard.innerText();
    const bridgedCounts = /(\d+) passed, (\d+) failed/.exec(bridgedRowText);
    expect(bridgedCounts, `the row states the runner's counts: ${bridgedRowText.slice(0, 200)}`).toBeTruthy();
    expect(Number(bridgedCounts[1])).toBeGreaterThanOrEqual(1);
    expect(Number(bridgedCounts[2])).toBe(0);
    checkpoint('bridge candidate verified in the workshop');

    // Apply it. This is the missing half of the old leg: the applied candidate, not a verified one.
    const bridgedApply = bridgedCard.locator(`[data-apply-candidate="${bridgedCandidateId}"]`);
    await expect(bridgedApply).toBeEnabled();
    const bridgedDialog = acceptNextDialog(page, 'T-42 walk: the chain ends in a real apply');
    await bridgedApply.click();
    const bridgedAnswer = await bridgedDialog;
    expect(bridgedAnswer.error, `the apply dialog never appeared: ${bridgedAnswer.error}`).toBeNull();
    await expect(bridgedCard).toContainText(/applied/i, { timeout: 30_000 });
    // Read back from disk: the file really holds the proposal's bytes.
    expect(fixture.readGreeting()).toBe(T41_GREETING_NEXT);
    checkpoint('bridge candidate applied');

    // THE ASSERTION THIS STEP EXISTS FOR: the applied candidate's trace holds the whole chain, with
    // sourceProposalId set and exactly one apply.
    const appliedTrace = await fixture.get(`/api/memory/trace/${bridgedCandidateId}`);
    expect(appliedTrace.status).toBe(200);
    const appliedEntries = Array.isArray(appliedTrace.body.entries) ? appliedTrace.body.entries : [];
    const appliedKinds = appliedEntries.map((entry) => entry.kind);
    const appliedVerification = appliedEntries.find((entry) => entry.kind === 'workshop_verification');
    const appliedApplies = appliedEntries.filter((entry) => entry.kind === 'workshop_apply');
    expect(appliedVerification, 'the applied chain holds its verification').toBeTruthy();
    expect(appliedVerification.detail.sourceProposalId, 'sourceProposalId on the applied trace').toBe(proposalId);
    expect(appliedVerification.detail.candidateId).toBe(bridgedCandidateId);
    expect(appliedVerification.detail.sandboxTestResult, 'sandboxTest on the applied trace').toBeTruthy();
    expect(appliedVerification.detail.sandboxTestResult.passedCount).toBeGreaterThanOrEqual(1);
    expect(appliedVerification.detail.sandboxTestResult.failedCount).toBe(0);
    expect(appliedApplies.length, `the applied chain holds exactly one apply: ${JSON.stringify(appliedKinds)}`).toBe(1);
    expect(appliedApplies[0].detail.candidateId).toBe(bridgedCandidateId);
    expect(appliedKinds.filter((kind) => kind === 'ecp_audit').length).toBeGreaterThanOrEqual(2);
    expect(appliedTrace.body.complete, JSON.stringify(appliedTrace.body.missing)).toBe(true);

    // And the trace by PROPOSAL id reaches the same candidate.
    const proposalTrace = await fixture.get(`/api/memory/trace/${proposalId}`);
    expect(proposalTrace.status).toBe(200);
    const proposalVerification = (proposalTrace.body.entries ?? []).find((entry) => entry.kind === 'workshop_verification');
    expect(proposalVerification, 'a trace by proposal id reaches the verification').toBeTruthy();
    expect(proposalVerification.detail.sourceProposalId).toBe(proposalId);
    expect(proposalVerification.detail.candidateId).toBe(bridgedCandidateId);
    expect(proposalTrace.body.complete, JSON.stringify(proposalTrace.body.missing)).toBe(true);

    // The staging is recorded on the lab side too, and the proposal is listed with its candidate.
    const evolution = await fixture.get('/api/evolution');
    const listed = (evolution.body.proposals ?? []).find((entry) => entry.proposalId === proposalId);
    expect(listed.staging.candidateId).toBe(bridgedCandidateId);
    expect(listed.staging.count).toBe(1);
    const protectedRow = (evolution.body.boundaries?.entries ?? []).find((entry) => entry.key === 'protected_paths');
    expect(protectedRow.locked).toBe(true);
    expect(protectedRow.policy.overridable).toBe(false);

    run.bridge = {
      proposalId,
      candidateId: bridgedCandidateId,
      stagedThroughUiButton: true,
      sourceProposalIdOnRecord: record.sourceProposalId,
      sourceProposalIdInApi: listedCandidate.sourceProposalId,
      sourceProposalIdBadgeVisible: true,
      sourceProposalIdOnTrace: appliedVerification.detail.sourceProposalId === proposalId,
      sandboxTestOnTrace: Boolean(appliedVerification.detail.sandboxTestResult),
      verificationsOnAppliedTrace: appliedKinds.filter((kind) => kind === 'workshop_verification').length,
      applies: appliedApplies.length,
      operations: appliedKinds.filter((kind) => kind === 'ecp_audit').length,
      applied: true,
      bytesWritten: fixture.readGreeting().length,
      verificationReachedFromProposal: true,
      labRecordsStaging: true,
      boundaryLocked: true,
      complete: appliedTrace.body.complete === true,
    };
    checkpoint('bridge and full applied chain verified');

    // ---------------------------------------------- 5. every view, and no overflow ---
    const views = await page.locator('.nav-item[data-view]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-view')));
    const perView = [];
    for (const view of views) {
      await page.click(`.nav-item[data-view="${view}"]`);
      await page.waitForTimeout(80);
      perView.push({ view, ...(await measureOverflow(page)) });
      checkpoint(`view ${view}`);
    }
    run.overflow = perView;
    for (const measured of perView) {
      expect(measured.overflows, `${measured.view} overflows horizontally: ${JSON.stringify(measured.offending)}`).toBe(false);
    }

    // ---------------------------------------------------------- 6. nothing failed ---
    run.consoleErrors = consoleErrors;
    run.pageErrors = pageErrors;
    run.failedRequests = failedRequests;
    run.scheduledRefusals = scheduledRefusals;
    expect(pageErrors, `uncaught exceptions: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    // Exactly ONE refusal reaches the console: the panel's own boundary attempt, which the server
    // answers 403. The five further boundary probes and the direct unverified apply run through
    // `fetch` in this process, so Chromium never sees them and cannot log them. The count is pinned so
    // the filter cannot quietly become a blanket exemption; if a future step adds a browser refusal it
    // has to be counted here deliberately.
    expect(scheduledRefusals.length, `scheduled refusals seen: ${scheduledRefusals.join(' | ')}`).toBe(1);
    expect(scheduledRefusals[0]).toMatch(/status of 403/);
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
