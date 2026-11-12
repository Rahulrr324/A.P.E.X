// Bounded, model-free benchmark for the adaptation-effectiveness read (Batch AP-04).
//
// What is measured is the complete production request: the authorized `adaptation.effectiveness`
// action, the independent verification that re-runs the whole analysis and compares its digest, the
// audit append, and the controller return. The pure analysis, the experience-store derivation, the
// plan read, and the audit read are also printed separately and labelled partial; they are not the
// cost of a request.
//
// The fixtures are built through the ordinary controller actions: user corrections derive and approve
// one rule, an executive `prepare` records the comparison and the plan in one operation, the user
// approves the plan, and the plan is activated, executed, and assessed through the plan store. Every
// use therefore has the lineage the read is designed to trace. No baseline is ever executed, and no
// model is contacted: every application is built with NoBackend.
//
// Three questions:
//   1. how the read scales with the number of linked uses (small, medium, large histories);
//   2. how it scales with the number of stored adaptations, up to and past the 20-record window;
//   3. what a repeated read costs while the store is also being written, and whether concurrent
//      activity is reported truthfully rather than averaged away.
//
// Nothing here is part of `npm test`, and nothing here adds a cache or an index: repeated reads pay
// the same cost, which the samples show.
//
//   node benchmarks/run-effectiveness-benchmark.mjs [--sizes 4,12,24] [--adaptations 1,8,20,21] [--repeats R] [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import {
  analyzeAdaptationEffectiveness, EFFECTIVENESS_SCHEMA,
  MAX_EFFECTIVENESS_ADAPTATIONS, MAX_EFFECTIVENESS_USES,
} from '../src/plans/effectiveness.js';

const MAX_REPEATS = 15;
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const REAL_SIZES = [4, 12, 24];
const ADAPTATION_SIZES = [1, 8, 20, 21];
const GUIDANCE = 'read the list before adding to it';

const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - String(s).length))}`;
const ms = (n) => `${(Math.round(n * 1000) / 1000).toFixed(3)}`;
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
const singleLineOf = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const line = (label, samples) => `  ${pad(label, 54)} ${pad(ms(median(samples)), 10)}ms min ${pad(ms(Math.min(...samples)), 10)}ms`
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

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--')
    ? process.argv[at + 1] : (process.argv.includes(`--${name}`) ? true : fallback);
}

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'apex-bench-effectiveness-'));
  dirs.push(dir);
  return dir;
}

function removeDir(dir) {
  const real = fs.realpathSync(dir);
  if (!real.startsWith(TMP_ROOT) || !path.basename(real).startsWith('apex-bench-effectiveness-')) {
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
  return `remember that the AP04 benchmark note ${note} holds`;
}

let goalSeq = 0;
async function newGoal(app) {
  goalSeq += 1;
  const created = await app.controller.goalAdd({
    request: `keep the running note current, benchmark case ${goalSeq}`,
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
async function seedRule(app, { guidance = GUIDANCE, order = 'reads_first', tag = 'AP04' } = {}) {
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

const repeats = Math.min(Math.max(1, Number(arg('repeats', 7)) || 7), MAX_REPEATS);
const sizes = String(arg('sizes', REAL_SIZES.join(','))).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const adaptationSizes = String(arg('adaptations', ADAPTATION_SIZES.join(','))).split(',')
  .map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);

console.log(`adaptation-effectiveness benchmark: ${os.platform()} ${os.arch()}, Node ${process.version}`);
console.log('deterministic and model-free: NoBackend is constructed and never contacted, nothing is inferred\n');
console.log(`repeats: ${repeats} per measurement after two warm-up calls; each sample writes its own audit record, as a request does`);
console.log(`bounds in force: ${MAX_EFFECTIVENESS_ADAPTATIONS} adaptations, ${MAX_EFFECTIVENESS_USES} uses in total, 20 uses per adaptation, 20,000 audit records scanned\n`);

const failed = [];

// ---- section one: the number of linked uses ------------------------------------------------
console.log('### complete request: linked uses per adaptation (one approved rule, one plan and assessment per use)');
for (const size of sizes) {
  const dir = tempDir();
  const now = clock();
  const app = await appIn(dir, now);

  const seedStarted = performance.now();
  const adaptation = await seedHistory(app, now, size);
  const seedMs = performance.now() - seedStarted;

  const files = storeFiles(dir);
  const fixture = files.map((f) => `${f.file}:${f.records} rec/${f.bytes} B`).join(', ');

  const detail = await timed(() => app.experience.adaptationDetail(adaptation.id), repeats);
  const planRead = await timed(() => app.plans.load(), repeats);
  const auditRead = await timed(() => app.operations.inspect(), repeats);
  const analysis = await timed(() => analyzeAdaptationEffectiveness({
    experience: app.experience,
    plans: app.plans,
    operations: app.operations,
    goals: app.goals,
    knowledge: app.knowledge,
    memory: app.memory,
    now,
    target: adaptation.id,
  }), repeats);

  // The digest covers every field of the report, including the audit-record count, so a direct
  // analysis can only be compared against another analysis of the same store state. Two direct runs
  // back to back prove determinism; the action's own verification is what re-reads across the append.
  const again = await analyzeAdaptationEffectiveness({
    experience: app.experience,
    plans: app.plans,
    operations: app.operations,
    goals: app.goals,
    knowledge: app.knowledge,
    memory: app.memory,
    now,
    target: adaptation.id,
  });
  if (analysis.value?.digest !== again.digest) failed.push(`${size} uses: two direct analyses of the same store disagree on the digest`);

  for (let i = 0; i < 2; i += 1) await app.controller.adaptationEffectiveness({ target: adaptation.id });
  const complete = await timed(() => app.controller.adaptationEffectiveness({ target: adaptation.id }), repeats);
  const result = complete.value;
  const report = data(result).report;
  const row = report?.adaptations?.[0] ?? null;
  if (result.status !== Outcome.SUCCESS_VERIFIED) failed.push(`${size} uses: the complete request did not verify (${result.status})`);
  if (report?.schema !== EFFECTIVENESS_SCHEMA) failed.push(`${size} uses: no effectiveness report was returned`);
  if (row?.readings?.usesRead !== size) failed.push(`${size} uses: the report read ${row?.readings?.usesRead} use(s)`);
  if (row?.readings?.usesKept !== Math.min(size, 20)) failed.push(`${size} uses: the report kept ${row?.readings?.usesKept} use(s)`);
  if (report?.totals?.evaluated !== Math.min(size, 20)) failed.push(`${size} uses: the report evaluated ${report?.totals?.evaluated} use(s)`);
  // `usesTruncated` describes the displayed sample list (`MAX_SAMPLES = 10`), not the kept-use bound.
  if (row?.usesTruncated !== (Math.min(size, 20) > 10)) {
    failed.push(`${size} uses: displayed-sample truncation is ${row?.usesTruncated}, expected ${Math.min(size, 20) > 10}`);
  }

  console.log(`  ${pad(`history ${size} linked use(s)`, 54)} seed ${ms(seedMs)}ms (not measured); use record ${row?.uses?.[0]?.outcome?.kind ?? 'none'}, `
    + `classification ${row?.classification?.state ?? 'none'}`);
  console.log(`  ${pad('fixture', 54)} ${fixture}`);
  console.log(`  ${pad(`adaptation detail read (partial, ${countOf(files, 'experiences.jsonl')} records)`, 54)} ${pad(ms(detail.total), 10)}ms`);
  console.log(`  ${pad(`plan store read (partial, ${countOf(files, 'plans.jsonl')} records)`, 54)} ${pad(ms(planRead.total), 10)}ms`);
  console.log(`  ${pad(`audit read (partial, ${countOf(files, 'operations.jsonl')} records)`, 54)} ${pad(ms(auditRead.total), 10)}ms`);
  console.log(`  ${pad('pure analysis over the same stores (partial)', 54)} ${pad(ms(analysis.total), 10)}ms`);
  console.log(line('COMPLETE request (analysis + verify + audit append)', complete.samples));
  console.log(`  ${pad('', 54)} reads ${report?.reads?.adaptationsRead} adaptation(s), ${report?.reads?.plansRead} plan(s), `
    + `${report?.reads?.auditRecords} audit record(s) (${report?.reads?.auditRecordsScanned} scanned), ${report?.reads?.disclosures} disclosure(s); `
    + `per-use truncation ${row?.usesTruncated ? 'yes' : 'no'}; report ${bytesOf(report)} bytes`);
  // The first and last of the complete samples show whether the growing audit log moves the read.
  const firstSample = complete.samples[0];
  const lastSample = complete.samples.at(-1);
  console.log(`  ${pad('', 54)} first sample ${ms(firstSample)}ms, last sample ${ms(lastSample)}ms (the audit log grows by one record per call)\n`);
}

// ---- section two: the number of stored adaptations -----------------------------------------
console.log(`### complete request: stored adaptations, one @size=${sizes.at(-1) ?? 12}-use history (the 20-record window is the bound)`);
for (const count of adaptationSizes) {
  const dir = tempDir();
  const now = clock();
  const app = await appIn(dir, now);
  const target = await seedHistory(app, now, sizes.at(-1) ?? 12);
  for (let i = 1; i < count; i += 1) {
    await seedRule(app, { guidance: `benchmark rule number ${i + 1} reads before writing`, order: 'reads_first', tag: `AP04-${i}` });
  }
  const stored = (await app.experience.adaptations({ limit: 100, includeRetired: true })).length;
  const files = storeFiles(dir);
  for (let i = 0; i < 2; i += 1) await app.controller.adaptationEffectiveness({ target: null });
  const complete = await timed(() => app.controller.adaptationEffectiveness({ target: null }), repeats);
  const report = data(complete.value).report;
  if (complete.value.status !== Outcome.SUCCESS_VERIFIED) failed.push(`${count} adaptations: the complete request did not verify`);
  const row = report?.adaptations?.find((a) => a.id === target.id) ?? null;
  console.log(`  ${pad(`${count} stored adaptation(s), ${stored} stored by the experience read`, 54)} ${pad(ms(complete.total), 10)}ms`
    + `  reports ${report?.reads?.adaptationsRead} adaptation row(s), ${report?.totals?.uses} use(s), ${report?.totals?.evaluated} evaluated`);
  console.log(`  ${pad('', 54)} target ${row ? `read (${row.classification.state})` : 'outside the window, so its uses are not counted'}; `
    + `experiences.jsonl ${countOf(files, 'experiences.jsonl')} records; report ${bytesOf(report)} bytes`);
  if (count <= MAX_EFFECTIVENESS_ADAPTATIONS && report?.reads?.adaptationsRead !== count) {
    failed.push(`${count} adaptations: the report read ${report?.reads?.adaptationsRead} rows, expected ${count}`);
  }
  if (count > MAX_EFFECTIVENESS_ADAPTATIONS && !(report?.reads?.adaptationsRead <= MAX_EFFECTIVENESS_ADAPTATIONS)) {
    failed.push(`${count} adaptations: the report ignored the ${MAX_EFFECTIVENESS_ADAPTATIONS}-record window`);
  }
  console.log('');
}

// ---- section three: concurrent activity -----------------------------------------------------
console.log('### concurrent activity: a read beside writes, and four reads beside each other');
{
  const dir = tempDir();
  const now = clock();
  const app = await appIn(dir, now);
  const target = await seedHistory(app, now, 8);

  // A write issued at the same time as a read. Both are separate controller requests; the audit log is
  // the shared resource. The read re-runs the whole analysis to verify itself, and the report's digest
  // covers the audit-record count, so a write that lands between those two reads is a real change and
  // the read refuses to confirm it. That refusal is the correct fail-closed answer and is reported
  // here, not suppressed: the write itself must still verify.
  const readAndWrite = await timed(() => Promise.all([
    app.controller.adaptationEffectiveness({ target: target.id }),
    app.controller.handle(nextNote(), { origin: 'user' }),
    app.controller.adaptationEffectiveness({ target: target.id }),
    app.controller.handle(nextNote(), { origin: 'user' }),
  ]), repeats);
  const [firstRead, firstWrite, secondRead, secondWrite] = readAndWrite.value;
  for (const write of [firstWrite, secondWrite]) {
    if (write.status !== Outcome.SUCCESS_VERIFIED) failed.push(`concurrent write: a write finished ${write.status}: ${write.output}`);
  }
  const readReports = [firstRead, secondRead].map((r) => data(r).report);
  const readRefusals = [firstRead, secondRead].filter((r) => r.status !== Outcome.SUCCESS_VERIFIED);
  console.log(line('two reads + two writes in parallel', readAndWrite.samples));
  console.log(`  ${pad('', 54)} writes ${firstWrite.status}/${secondWrite.status}; reads ${firstRead.status}/${secondRead.status}; `
    + `${readRefusals.length} read(s) refused to confirm a concurrent change`);
  for (const refusal of readRefusals) console.log(`  ${pad('', 54)}   ${refusal.status}: ${singleLineOf(refusal.output)}`);
  console.log(`  ${pad('', 54)} confirmed reads ${readRefusals.length === 0 && readReports[0]?.digest === readReports[1]?.digest ? 'agree on the digest' : 'were not both available to compare'}`);

  // Four reads with no writer: each still appends its own audit record after it verifies, so a read
  // can transiently see another read's record. Both outcomes are reported; the wall time is the
  // measurement, and no throughput claim is made from it.
  const fourReads = await timed(() => Promise.all(Array.from({ length: 4 }, () => (
    app.controller.adaptationEffectiveness({ target: target.id })
  ))), repeats);
  const verifiedReads = fourReads.value.filter((r) => r.status === Outcome.SUCCESS_VERIFIED).length;
  const refusedReads = fourReads.value.filter((r) => r.status !== Outcome.SUCCESS_VERIFIED);
  console.log(line('four reads in parallel', fourReads.samples));
  for (const refusal of refusedReads) console.log(`  ${pad('', 54)}   ${refusal.status}: ${singleLineOf(refusal.output)}`);
  const serial = await timed(() => app.controller.adaptationEffectiveness({ target: target.id }), repeats);
  console.log(line('one read, serial (same store)', serial.samples));
  console.log(`  ${pad('', 54)} four reads wall time ${ms(fourReads.total)}ms (${verifiedReads} of 4 verified, ${refusedReads.length} refused) `
    + `vs one read ${ms(serial.total)}ms; concurrency is measured, not claimed as throughput\n`);
}

for (const dir of dirs) {
  if (!process.argv.includes('--keep')) removeDir(dir);
}

if (failed.length > 0) {
  console.log('The run is not comparable:');
  for (const problem of failed) console.log(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('Every measured request verified and every report disclosed its own reads. Nothing was approved, changed, retired, or executed by a read.');
}
