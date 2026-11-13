// Bounded, model-free benchmark for adaptation governance (Batch AP-05).
//
// What is measured is the complete production path, not a pure function: the authorized
// `adaptation.reviews` list, `adaptation.review.open`, `adaptation.review.inspect`,
// `adaptation.review.reconcile`, and `adaptation.review.decide`, each including the independent
// verification that re-reads the stores, the audit append, and the controller return. Direct calls to
// the governance builder and the review preparer are printed separately and labelled partial; they
// are not the cost of a request.
//
// The fixtures are built through the ordinary controller actions: two user corrections derive and
// approve one rule, an executive `prepare` records the comparison and the plan in one operation, the
// user approves the plan, and the plan is activated, executed, evidenced, and assessed. Every use has
// the lineage the review cites. No baseline is ever executed, and no model is contacted: every
// application is built with NoBackend.
//
// Three questions:
//   1. how each complete review stage scales with the number of linked uses (small, medium, large);
//   2. how the list read scales with the number of stored adaptations, up to and past its window;
//   3. what a read costs beside writes and beside other reads, and whether a refused confirmation is
//      reported truthfully rather than averaged away.
//
// Isolation: every data directory is created under the OS temporary root with the
// `apex-bench-governance-` prefix, and cleanup refuses any path outside that root or without that
// prefix. APEX_DATA_ISOLATED=1 is accepted and asserted; anything else must be unset.
//
// Do not run this benchmark at the same time as the test suite: both compete for the same CPU and disk,
// and every figure here is wall-clock time on this machine only. Nothing here is part of `npm test`.
//
//   APEX_DATA_ISOLATED=1 node benchmarks/run-governance-benchmark.mjs [--sizes 4,12,24] [--adaptations 1,8,20,21] [--repeats R] [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { assertIsolatedDataDir } from '../src/config.js';
import {
  GOVERNANCE_SCHEMA, MAX_GOVERNANCE_ADAPTATIONS,
  governanceDetail, governanceReport, prepareReview,
} from '../src/plans/governance.js';

const MAX_REPEATS = 10;
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const REAL_SIZES = [4, 12, 24];
const ADAPTATION_SIZES = [1, 8, 20, 21];
const GUIDANCE = 'read the list before adding to it';
const DIR_PREFIX = 'apex-bench-governance-';

const isolation = (process.env.APEX_DATA_ISOLATED ?? '').trim();
if (isolation !== '' && isolation !== '1') {
  throw new Error(`APEX_DATA_ISOLATED must be unset or 1, not ${JSON.stringify(isolation)}`);
}

const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - String(s).length))}`;
const ms = (n) => `${(Math.round(n * 1000) / 1000).toFixed(3)}`;
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
const singleLineOf = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const line = (label, samples) => `  ${pad(label, 58)} ${pad(ms(median(samples)), 10)}ms min ${pad(ms(Math.min(...samples)), 10)}ms`
  + ` samples ${samples.map((x) => (Math.round(x * 1000) / 1000).toFixed(2)).join('/')}`;

async function timed(fn, repeats) {
  const samples = [];
  let value = null;
  for (let i = 0; i < repeats; i += 1) {
    const started = performance.now();
    value = await fn();
    samples.push(performance.now() - started);
  }
  return { samples, value, total: median(samples) };
}

async function once(fn) {
  const started = performance.now();
  const value = await fn();
  return { value, elapsed: performance.now() - started };
}

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--')
    ? process.argv[at + 1] : (process.argv.includes(`--${name}`) ? true : fallback);
}

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, DIR_PREFIX));
  assertIsolatedDataDir(dir);
  dirs.push(dir);
  return dir;
}

function removeDir(dir) {
  const real = fs.realpathSync(dir);
  if (!real.startsWith(TMP_ROOT) || !path.basename(real).startsWith(DIR_PREFIX)) {
    throw new Error(`refusing to remove non-benchmark directory: ${real}`);
  }
  fs.rmSync(real, { recursive: true, force: true });
}

function copyDir(from) {
  const to = tempDir();
  fs.cpSync(from, to, { recursive: true });
  return to;
}

function clock(start = '2026-11-05T09:00:00.000Z') {
  let at = Date.parse(start);
  const now = () => new Date(at);
  now.advance = (hours) => { at += hours * 3_600_000; };
  return now;
}

const appIn = (dataDir, now) => createApp({
  dataDir,
  now,
  gateway: new ModelGateway({ backend: new NoBackend() }),
  experienceCapture: CAPTURE_OFF,
});

const data = (res) => res?.operation?.steps?.[0]?.result?.data ?? res?.result?.data ?? {};

function storeFiles(dataDir) {
  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.jsonl')).sort();
  return files.map((f) => {
    const full = path.join(dataDir, f);
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.trim().length === 0 ? 0 : text.trim().split('\n').length;
    return { file: f, records: lines, bytes: Buffer.byteLength(text, 'utf8') };
  });
}

function countOf(files, name) {
  return files.find((f) => f.file === name)?.records ?? 0;
}

let note = 0;
function nextNote() {
  note += 1;
  return `remember that the AP05 benchmark note ${note} holds`;
}

let goalSeq = 0;
async function newGoal(app) {
  goalSeq += 1;
  const created = await app.controller.goalAdd({
    request: `keep the running note current, governance benchmark case ${goalSeq}`,
    criteria: [
      { description: 'remember that the note holds', basis: 'user_stated' },
      { description: 'list my memory', basis: 'user_stated' },
    ],
  });
  if (created.status !== Outcome.GOAL_CREATED) throw new Error(`benchmark goal was not created: ${created.output}`);
  const goalId = data(created).goalId;
  for (const status of ['accepted', 'active']) await app.controller.goalUpdate({ target: goalId, status });
  return goalId;
}

// Two user corrections derive one candidate; the user approves it and states the shape.
async function seedRule(app, { guidance = GUIDANCE, order = 'reads_first', tag = 'AP05' } = {}) {
  for (const n of [1, 2]) {
    const write = await app.controller.handle(`remember that the ${tag} note ${n} holds`, { origin: 'user' });
    if (write.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`benchmark write failed: ${write.output}`);
    const experience = await app.controller.experienceRecord({ operationId: write.operation.id, subject: `an ${tag} memory write` });
    if (experience.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`benchmark experience failed: ${experience.output}`);
    const feedback = await app.controller.feedbackRecord({
      target: data(experience).id, assessment: 'user_correction', guidance, reason: 'done the long way round',
    });
    if (feedback.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`benchmark feedback failed: ${feedback.output}`);
  }
  const derived = data(await app.controller.adaptationDerive({}));
  const adaptation = derived.created.find((a) => a.rule === guidance);
  if (!adaptation) throw new Error(`benchmark derivation created no rule matching "${guidance}"`);
  const decided = await app.controller.adaptationDecide({ target: adaptation.id, decision: 'approved', reason: 'benchmark approval' });
  if (decided.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`benchmark approval failed: ${decided.output}`);
  if (order !== null) {
    const guided = await app.controller.adaptationGuide({ target: adaptation.id, order });
    if (guided.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`benchmark guidance failed: ${guided.output}`);
  }
  return adaptation;
}

// One linked use, through the full real path: the decision and the plan in one operation, approval as
// a separate act, verified execution, goal evidence for each criterion, and the plan's own assessment.
// A successful assessment is not manufactured from step outcomes alone: the goal evidence has to hold.
async function seedUse(app, now) {
  const goalId = await newGoal(app);
  const prepared = await app.controller.handle(`prepare a plan for goal ${goalId}`, { origin: 'user' });
  if (prepared.status !== Outcome.PLAN_STORED) throw new Error(`benchmark prepare did not store a plan: ${prepared.output}`);
  const addStep = prepared.operation.steps.find((s) => s.action === 'plan.add');
  const planId = addStep?.result?.data?.planId;
  if (!planId) throw new Error('benchmark prepare recorded no plan in its operation');
  const approved = await app.controller.planApprove({ target: planId });
  if (approved.status !== Outcome.PLAN_STORED) throw new Error(`benchmark plan approval failed: ${approved.output}`);
  const run = await app.controller.planActivate(planId, { mode: 'run' });
  if (run.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`benchmark execution did not verify: ${run.output}`);
  const plan = await app.plans.get(planId);
  const goal = await app.goals.get(goalId);
  for (const criterion of goal.criteria) {
    const step = plan.steps.find((s) => s.criterionId === criterion.id) ?? plan.steps[0];
    const operationId = plan.stepResults[step.id]?.operationId;
    const evidence = await app.controller.goalEvidence({
      target: goalId, criterion: criterion.id, kind: 'supports', operationId,
    });
    if (evidence.status !== Outcome.GOAL_UPDATED) throw new Error(`benchmark goal evidence failed: ${evidence.output}`);
  }
  const assessed = await app.controller.planAssess({ target: planId });
  if (assessed.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`benchmark assessment failed: ${assessed.output}`);
  now.advance(1);
  return planId;
}

async function seedHistory(app, now, uses) {
  const adaptation = await seedRule(app);
  for (let i = 0; i < uses; i += 1) await seedUse(app, now);
  return adaptation;
}

// One complete cycle on a fresh copy of the seeded store: list, open, inspect, reconcile, and keep.
// Each stage is timed separately, and every stage includes its own independent verification and audit
// append. A fresh copy is required because open is refused for evidence that is already reviewed.
async function reviewCycle(template, adaptationId) {
  const dir = copyDir(template);
  const app = await appIn(dir, clock());

  const listed = await once(() => app.controller.adaptationReviews({}));
  const opened = await once(() => app.controller.adaptationReviewOpen({ target: adaptationId }));
  const reviewId = data(opened.value).reviewId ?? null;
  const inspected = reviewId
    ? await once(() => app.controller.adaptationReviewInspect({ target: reviewId }))
    : { value: null, elapsed: null };
  const reconciled = reviewId
    ? await once(() => app.controller.adaptationReviewReconcile({ target: reviewId }))
    : { value: null, elapsed: null };
  const decided = reviewId
    ? await once(() => app.controller.adaptationReviewDecide({ review: reviewId, decision: 'keep_active' }))
    : { value: null, elapsed: null };

  return { dir, listed, opened, inspected, reconciled, decided, reviewId };
}

const repeats = Math.min(Math.max(1, Number(arg('repeats', 5)) || 5), MAX_REPEATS);
const sizes = String(arg('sizes', REAL_SIZES.join(','))).split(',')
  .map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const adaptationSizes = String(arg('adaptations', ADAPTATION_SIZES.join(','))).split(',')
  .map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);

console.log(`adaptation-governance benchmark: ${os.platform()} ${os.arch()}, Node ${process.version}`);
console.log('deterministic and model-free: NoBackend is constructed and never contacted, nothing is inferred');
console.log(`isolation: every data directory is under ${TMP_ROOT} with the ${DIR_PREFIX} prefix; cleanup refuses anything else`
  + ` (APEX_DATA_ISOLATED=${isolation || 'unset'})`);
console.log('run this alone: concurrent tests would change every wall-clock figure below\n');
console.log(`repeats: ${repeats} complete cycles per size; each stage writes its own audit record, as a request does`);
console.log(`bounds in force: ${MAX_GOVERNANCE_ADAPTATIONS} adaptation rows per list read, 20 evidence references per list, 20 reviews per adaptation\n`);

const failed = [];
const check = (condition, message) => { if (!condition) failed.push(message); };

// ---- section one: complete review path over linked uses ------------------------------------
console.log('### complete review path: linked uses per adaptation (one approved rule, one plan and assessment per use)');
for (const size of sizes) {
  const dir = tempDir();
  const now = clock();
  const app = await appIn(dir, now);

  const seedStarted = performance.now();
  const adaptation = await seedHistory(app, now, size);
  const seedMs = performance.now() - seedStarted;
  const files = storeFiles(dir);
  const fixture = files.map((f) => `${f.file}:${f.records} rec/${f.bytes} B`).join(', ');

  // The direct builder and preparer are partial: they re-derive the same evidence without the action,
  // its verification, or its audit append.
  const directReport = await timed(() => governanceReport({
    experience: app.experience,
    plans: app.plans,
    operations: app.operations,
    goals: app.goals,
    knowledge: app.knowledge,
    memory: app.memory,
    predictions: app.predictions,
    now,
  }), 3);
  const directDetail = await timed(() => governanceDetail({
    experience: app.experience,
    plans: app.plans,
    operations: app.operations,
    goals: app.goals,
    knowledge: app.knowledge,
    memory: app.memory,
    predictions: app.predictions,
    now,
    target: adaptation.id,
  }), 3);
  const directPrepare = await timed(() => prepareReview({
    experience: app.experience,
    plans: app.plans,
    operations: app.operations,
    goals: app.goals,
    knowledge: app.knowledge,
    memory: app.memory,
    predictions: app.predictions,
    now,
    target: adaptation.id,
  }), 3);

  const cycles = [];
  for (let i = 0; i < repeats; i += 1) cycles.push(await reviewCycle(dir, adaptation.id));

  const stage = (name) => cycles.map((c) => c[name].elapsed).filter((n) => typeof n === 'number');
  const listSamples = stage('listed');
  const openSamples = stage('opened');
  const inspectSamples = stage('inspected');
  const reconcileSamples = stage('reconciled');
  const decideSamples = stage('decided');

  for (const cycle of cycles) {
    const list = cycle.listed.value;
    const listReport = data(list).report;
    check(list.status === Outcome.SUCCESS_VERIFIED, `${size} uses: the list request finished ${list.status}: ${singleLineOf(list.output)}`);
    check(listReport?.schema === GOVERNANCE_SCHEMA, `${size} uses: no governance report was returned`);
    check(listReport?.available === true, `${size} uses: the governance report was unavailable`);
    check(listReport?.authorizes === false, `${size} uses: the report claimed authorization`);
    check(listReport?.totals?.adaptations === 1, `${size} uses: the report listed ${listReport?.totals?.adaptations} adaptation(s)`);

    const open = cycle.opened.value;
    const openData = data(open);
    check(open.status === Outcome.SUCCESS_VERIFIED, `${size} uses: open finished ${open.status}: ${singleLineOf(open.output)}`);
    check(typeof openData.reviewId === 'string', `${size} uses: open returned no review id`);
    check(openData.awaitingEvidence === false, `${size} uses: the fixture should be classifiable, but open reported awaiting evidence`);

    const inspect = cycle.inspected.value;
    const inspectData = data(inspect);
    check(inspect?.status === Outcome.SUCCESS_VERIFIED, `${size} uses: inspect finished ${inspect?.status}: ${singleLineOf(inspect?.output)}`);
    check(inspectData.detail?.reviewState === 'review_opened', `${size} uses: inspect reported ${inspectData.detail?.reviewState}`);
    check(inspectData.detail?.review?.evidenceDigest === openData.evidenceDigest, `${size} uses: inspect cites different evidence than open`);
    check(inspectData.detail?.reviewState === 'review_opened', `${size} uses: the open review is not reported as opened`);

    const reconcile = cycle.reconciled.value;
    const reconcileData = data(reconcile);
    check(reconcile?.status === Outcome.SUCCESS_VERIFIED, `${size} uses: reconcile finished ${reconcile?.status}: ${singleLineOf(reconcile?.output)}`);
    check(reconcileData.reconciliation?.state === 'unchanged', `${size} uses: a fresh review reconciled as ${reconcileData.reconciliation?.state}`);
    check(reconcileData.reviewedEvidenceDigest === reconcileData.currentEvidenceDigest, `${size} uses: reconcile compared different digests`);

    const decide = cycle.decided.value;
    const decideData = data(decide);
    check(decide?.status === Outcome.SUCCESS_VERIFIED, `${size} uses: decide finished ${decide?.status}: ${singleLineOf(decide?.output)}`);
    check(decideData.decision === 'keep_active', `${size} uses: decide recorded ${decideData.decision}`);
    check(decideData.retirementId === null, `${size} uses: keep_active recorded a retirement`);
  }

  console.log(`  ${pad(`history ${size} linked use(s)`, 58)} seed ${ms(seedMs)}ms (not measured); `
    + `classification ${directReport.value?.adaptations?.[0]?.classification?.state ?? 'none'}, `
    + `recommendation ${directReport.value?.adaptations?.[0]?.recommendation?.kind ?? 'none'}`);
  console.log(`  ${pad('fixture', 58)} ${fixture}`);
  console.log(`  ${pad(`governance builder (partial, ${countOf(files, 'experiences.jsonl')} experience records)`, 58)} ${pad(ms(directReport.total), 10)}ms`);
  console.log(`  ${pad('single-adaptation detail (partial)', 58)} ${pad(ms(directDetail.total), 10)}ms`);
  console.log(`  ${pad('review preparation (partial: the bundle open would cite)', 58)} ${pad(ms(directPrepare.total), 10)}ms`);
  console.log(line('COMPLETE list request (builder + verify + audit)', listSamples));
  console.log(line('COMPLETE open (prepare + authority + verify + audit)', openSamples));
  console.log(line('COMPLETE inspect (detail + verify + audit)', inspectSamples));
  console.log(line('COMPLETE reconcile (re-derive + verify + audit)', reconcileSamples));
  console.log(line('COMPLETE decide keep_active (authority + verify + audit)', decideSamples));
  console.log(`  ${pad('', 58)} prepared evidence ${bytesOf(directPrepare.value?.evidence ?? null)} bytes; `
    + `detail ${bytesOf(directDetail.value ?? null)} bytes\n`);
  for (const cycle of cycles) removeDirSoon(cycle.dir);
}

// ---- section two: the number of stored adaptations -----------------------------------------
console.log(`### complete list request: stored adaptations, one @size=${sizes.at(-1) ?? 12}-use history (the ${MAX_GOVERNANCE_ADAPTATIONS}-row window is the bound)`);
for (const count of adaptationSizes) {
  const dir = tempDir();
  const now = clock();
  const app = await appIn(dir, now);
  const target = await seedHistory(app, now, sizes.at(-1) ?? 12);
  for (let i = 1; i < count; i += 1) {
    await seedRule(app, { guidance: `benchmark rule number ${i + 1} reads before writing`, order: 'reads_first', tag: `AP05-${i}` });
  }
  const stored = (await app.experience.adaptations({ limit: 100, includeRetired: true })).length;
  const files = storeFiles(dir);
  for (let i = 0; i < 2; i += 1) await app.controller.adaptationReviews({});
  const complete = await timed(() => app.controller.adaptationReviews({}), repeats);
  const report = data(complete.value).report;
  check(complete.value.status === Outcome.SUCCESS_VERIFIED, `${count} adaptations: the complete list request did not verify`);
  check(report?.schema === GOVERNANCE_SCHEMA, `${count} adaptations: no governance report was returned`);
  const row = report?.adaptations?.find((a) => a.id === target.id) ?? null;
  console.log(`  ${pad(`${count} stored adaptation(s), ${stored} stored by the experience read`, 58)} ${pad(ms(complete.total), 10)}ms`
    + `  reports ${report?.totals?.adaptations} row(s), ${report?.totals?.reviews} review record(s), `
    + `${report?.totals?.requiringReview} needing attention`);
  console.log(`  ${pad('', 58)} target ${row ? `read (${row.reviewState})` : 'outside the window, so it is not reported'}; `
    + `experiences.jsonl ${countOf(files, 'experiences.jsonl')} records; report ${bytesOf(report)} bytes`);
  if (count <= MAX_GOVERNANCE_ADAPTATIONS) {
    check(report?.totals?.adaptations === count, `${count} adaptations: the report listed ${report?.totals?.adaptations} rows`);
  } else {
    check(report?.totals?.adaptations <= MAX_GOVERNANCE_ADAPTATIONS, `${count} adaptations: the report ignored the window`);
  }
  console.log('');
  removeDirSoon(dir);
}
if (adaptationSizes.includes(MAX_GOVERNANCE_ADAPTATIONS + 1)) {
  console.log(`The ${MAX_GOVERNANCE_ADAPTATIONS + 1}-adaptation row is not faster: the recency window excludes the target's `
    + 'linked-use history, so that sample performs far less lineage work. The row count, not the clock, is the claim.\n');
}

// ---- section three: concurrent activity -----------------------------------------------------
console.log('### concurrent activity: reads beside writes, and four reads beside each other');
{
  const dir = tempDir();
  const now = clock();
  const app = await appIn(dir, now);
  const target = await seedHistory(app, now, 8);

  // A read issued at the same time as a write. Both are separate controller requests and the audit log
  // is shared. A write that lands between a read and its verification is a real change; the read must
  // refuse to confirm rather than report a state it no longer observed. Those refusals are reported.
  const readAndWrite = await timed(() => Promise.all([
    app.controller.adaptationReviews({}),
    app.controller.handle(nextNote(), { origin: 'user' }),
    app.controller.adaptationReviews({}),
    app.controller.handle(nextNote(), { origin: 'user' }),
  ]), repeats);
  const [firstRead, firstWrite, secondRead, secondWrite] = readAndWrite.value;
  for (const write of [firstWrite, secondWrite]) {
    check(write.status === Outcome.SUCCESS_VERIFIED, `concurrent write finished ${write.status}: ${singleLineOf(write.output)}`);
  }
  const readRefusals = [firstRead, secondRead].filter((r) => r.status !== Outcome.SUCCESS_VERIFIED);
  console.log(line('two reads + two writes in parallel', readAndWrite.samples));
  console.log(`  ${pad('', 58)} writes ${firstWrite.status}/${secondWrite.status}; reads ${firstRead.status}/${secondRead.status}; `
    + `${readRefusals.length} read(s) refused to confirm a concurrent change`);
  for (const refusal of readRefusals) console.log(`  ${pad('', 58)}   ${refusal.status}: ${singleLineOf(refusal.output)}`);

  // Four reads with no writer: each appends its own audit record after it verifies, so a read can
  // transiently see another read's record. Both outcomes are reported; no throughput claim is made.
  const fourReads = await timed(() => Promise.all(Array.from({ length: 4 }, () => (
    app.controller.adaptationReviews({})
  ))), repeats);
  const verifiedReads = fourReads.value.filter((r) => r.status === Outcome.SUCCESS_VERIFIED).length;
  const refusedReads = fourReads.value.filter((r) => r.status !== Outcome.SUCCESS_VERIFIED);
  console.log(line('four reads in parallel', fourReads.samples));
  for (const refusal of refusedReads) console.log(`  ${pad('', 58)}   ${refusal.status}: ${singleLineOf(refusal.output)}`);
  const serial = await timed(() => app.controller.adaptationReviews({}), repeats);
  console.log(line('one read, serial (same store)', serial.samples));
  console.log(`  ${pad('', 58)} four reads wall time ${ms(fourReads.total)}ms (${verifiedReads} of 4 verified, `
    + `${refusedReads.length} refused) vs one read ${ms(serial.total)}ms; concurrency is measured, not claimed as throughput\n`);
  removeDirSoon(dir);
}

for (const dir of dirs) {
  if (!process.argv.includes('--keep')) removeDir(dir);
}

if (failed.length > 0) {
  console.log('The run is not comparable:');
  for (const problem of failed) console.log(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('Every measured request verified and reported its own state. Observation changed no rule, recorded no decision, and retired nothing.');
}

// Deferred cleanup: cycles within a section are removed level by level so one large fixture and its
// copies do not all sit on disk at once. `--keep` suppresses it.
function removeDirSoon(dir) {
  if (process.argv.includes('--keep')) return;
  const at = dirs.indexOf(dir);
  if (at < 0 || !fs.existsSync(dir)) return;
  dirs.splice(at, 1);
  removeDir(dir);
}
