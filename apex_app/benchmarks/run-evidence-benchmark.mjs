// Bounded, model-free benchmark for the evidence fabric (Batch AP-06).
//
// What is measured is the new cross-store read path, not a pure function: one stat-based window opened
// and verified over every configured store, the complete `evidence.integrity` request (which runs its
// own independent second window and appends its audit record), cross-store cognitive retrieval, the
// complete `adaptation.effectiveness` request, and the complete governance list. The pre-AP-06 shape of
// the effectiveness analysis is measured beside the windowed one on the same fixture, so the cost of
// the window is an in-run comparison rather than a remembered number.
//
// What a window is: a `{exists,size,mtimeMs}` identity for each contributing JSONL file before the
// first read and after the last. An unchanged identity proves no append landed inside the window. It
// is not a transaction, it holds no lock, it cannot stop a writer, and a same-size rewrite that also
// restores the modification time is invisible to it. Every fixture is deterministic: the application
// is assembled with NoBackend and a fixed clock, no model is contacted, nothing is inferred, and the
// only synthetic records are memory lines written directly into a throw-away store to vary its size.
//
// Three questions:
//   1. what the window costs as the largest store grows (the window itself is per store, not per
//      record, so the per-store health check is where growth should appear);
//   2. whether the complete reads through the window still certify, and what the window adds to the
//      effectiveness analysis on identical bytes;
//   3. what a read costs beside writes, and whether refusals or bounded windows are disclosed rather
//      than averaged away.
//
// Isolation: every data directory is created under the OS temporary root with the
// `apex-bench-evidence-` prefix, and cleanup refuses any path outside that root or without that
// prefix. APEX_DATA_ISOLATED must be unset or 1; any other value is refused.
//
// Do not run this benchmark at the same time as the test suite, or as another benchmark: every figure
// is wall-clock time on this machine only. Nothing here is part of `npm test`.
//
//   APEX_DATA_ISOLATED=1 node benchmarks/run-evidence-benchmark.mjs [--records 100,1000,4000] [--repeats R] [--keep]
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
import { sha256Hex } from '../src/memory/memory-store.js';
import {
  DEFAULT_SNAPSHOT_ATTEMPTS,
  MAX_SNAPSHOT_STORES,
  contributingStores,
  openEvidenceSnapshot,
} from '../src/evidence/snapshot.js';
import { MAX_INTEGRITY_FINDINGS, evidenceIntegrityReport } from '../src/evidence/integrity.js';
import {
  MAX_EFFECTIVENESS_ADAPTATIONS,
  MAX_EFFECTIVENESS_USES,
  analyzeAdaptationEffectiveness,
  analyzeEffectivenessWithSnapshot,
} from '../src/plans/effectiveness.js';
import { retrieveEvidence } from '../src/cognition/evidence.js';
import { understandRequest } from '../src/cognition/request.js';

const MAX_REPEATS = 10;
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const RECORD_SIZES = [100, 1000, 4000];
const DIR_PREFIX = 'apex-bench-evidence-';
const QUERY = 'what does the AP06 benchmark note say about the lighthouse status?';
const GUIDANCE = 'read the list before adding to it';

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

// Two conditions measured alternately on the same fixture, so a slow period affects both rather than
// one block. Neither condition writes, so the bytes stay identical between the two.
async function timedPair(first, second, repeats) {
  const a = [];
  const b = [];
  let av = null;
  let bv = null;
  for (let i = 0; i < repeats; i += 1) {
    let started = performance.now();
    av = await first();
    a.push(performance.now() - started);
    started = performance.now();
    bv = await second();
    b.push(performance.now() - started);
  }
  return { first: { samples: a, value: av, total: median(a) }, second: { samples: b, value: bv, total: median(b) } };
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

function clock(start = '2026-11-13T09:00:00.000Z') {
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

const allStores = (app) => ({
  experience: app.experience,
  plans: app.plans,
  operations: app.operations,
  goals: app.goals,
  knowledge: app.knowledge,
  memory: app.memory,
  predictions: app.predictions,
  world: app.worldModel,
  tasks: app.taskStore,
});

function storeFiles(dataDir) {
  return fs.readdirSync(dataDir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => {
    const text = fs.readFileSync(path.join(dataDir, f), 'utf8');
    return { file: f, records: text.trim().length === 0 ? 0 : text.trim().split('\n').length, bytes: Buffer.byteLength(text, 'utf8') };
  });
}

function countOf(files, name) {
  return files.find((f) => f.file === name)?.records ?? 0;
}

// Memory lines written directly into a throw-away store, so the size sweep is not dominated by an
// append's own read-modify-write cost. They are valid records for the store's own validator, carry a
// real content digest, and are never written into a user's data directory.
function syntheticMemory(from, count, tag = 'AP06') {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const n = from + i;
    const content = `the ${tag} benchmark note ${n} records that the lighthouse status holds`;
    lines.push(JSON.stringify({
      schema: 1,
      id: `bench-${tag.toLowerCase()}-${String(n).padStart(6, '0')}`,
      kind: 'user_fact',
      source: 'user',
      sensitivity: 'normal',
      content,
      contentSha256: sha256Hex(content),
      createdAt: new Date(Date.parse('2026-10-01T00:00:00.000Z') + n * 60_000).toISOString(),
      provenance: { origin: 'user_request', updateMode: 'user_confirmed' },
    }));
  }
  return lines;
}

function appendMemory(dataDir, from, count) {
  fs.appendFileSync(path.join(dataDir, 'memory.jsonl'), `${syntheticMemory(from, count).join('\n')}\n`);
}

let goalSeq = 0;
async function newGoal(app) {
  goalSeq += 1;
  const created = await app.controller.goalAdd({
    request: `keep the running note current, evidence benchmark case ${goalSeq}`,
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

// Two user corrections derive one candidate; the user approves it and states its shape.
async function seedRule(app, { guidance = GUIDANCE, order = 'reads_first', tag = 'AP06' } = {}) {
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

const repeats = Math.min(Math.max(1, Number(arg('repeats', 5)) || 5), MAX_REPEATS);
const sizes = String(arg('records', RECORD_SIZES.join(','))).split(',')
  .map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);

console.log(`evidence-fabric benchmark: ${os.platform()} ${os.arch()}, Node ${process.version}`);
console.log(`host: ${os.cpus()[0]?.model ?? 'unknown CPU'}, ${(os.totalmem() / (1024 ** 3)).toFixed(1)} GiB total memory`);
console.log('deterministic and model-free: NoBackend is constructed and never contacted, nothing is inferred');
console.log(`isolation: every data directory is under ${TMP_ROOT} with the ${DIR_PREFIX} prefix; cleanup refuses anything else`
  + ` (APEX_DATA_ISOLATED=${isolation || 'unset'})`);
console.log('run this alone: concurrent tests or another benchmark would change every wall-clock figure below\n');
console.log(`repeats: ${repeats} per complete request; partial module calls use 3; before/after pairs alternate on one fixture`);
console.log(`bounds in force: ${MAX_EFFECTIVENESS_ADAPTATIONS} adaptation rows per read (one extra is read to detect clipping), `
  + `${MAX_EFFECTIVENESS_USES} linked uses, ${MAX_SNAPSHOT_STORES} stores per window, ${MAX_INTEGRITY_FINDINGS} disclosed integrity findings, `
  + `${DEFAULT_SNAPSHOT_ATTEMPTS} window attempts\n`);

const failed = [];
const check = (condition, message) => { if (!condition) failed.push(message); };

// One fixture with a real linked history, copied per size and enlarged with synthetic memory lines.
const baseDir = tempDir();
{
  const now = clock();
  const app = await appIn(baseDir, now);
  await seedRule(app);
  await seedUse(app, now);
  await seedUse(app, now);
}
const baseFiles = storeFiles(baseDir);
console.log('### fixture: one approved rule, two linked and assessed uses, then synthetic memory growth');
console.log(`  base stores: ${baseFiles.map((f) => `${f.file}:${f.records} rec/${f.bytes} B`).join(', ')}\n`);

// ---- section one: the window and the complete reads under store growth ------------------------
console.log('### cross-store window, integrity request, retrieval and effectiveness at increasing store size');
for (const size of sizes) {
  const dir = copyDir(baseDir);
  const existing = countOf(storeFiles(dir), 'memory.jsonl');
  appendMemory(dir, existing, size);
  const now = clock();
  const app = await appIn(dir, now);
  const stores = allStores(app);
  const contributing = contributingStores(stores);
  const files = storeFiles(dir);
  const understanding = understandRequest({ request: QUERY, now: now() });

  // A window on its own: stat every contributing file, then stat them again. Nothing is parsed.
  const window = await timed(async () => {
    const snapshot = await openEvidenceSnapshot({ stores: contributing });
    return snapshot.verify();
  }, 3);

  // The integrity report without the action: one window, one health check per store that has one.
  const directIntegrity = await timed(() => evidenceIntegrityReport({ stores, now }), 3);

  // The complete request: the action's own read, its independent second window, and the audit append.
  const completeIntegrity = await timed(() => app.controller.evidenceIntegrity(), repeats);

  // Cross-store cognitive retrieval, without a model or a response. This is the retrieval stage only.
  const retrieval = await timed(() => retrieveEvidence({
    request: QUERY,
    understanding,
    now: now(),
    stores: {
      memory: app.memory,
      knowledge: app.knowledge,
      experience: app.experience,
      predictions: app.predictions,
      goals: app.goals,
      plans: app.plans,
      tasks: app.taskStore,
    },
  }), 3);

  // Before AP-06 the analysis read the stores directly. It still can, without a window, and that is
  // what is measured here; the windowed form is the public read.
  const effectivenessInput = {
    experience: app.experience,
    plans: app.plans,
    operations: app.operations,
    goals: app.goals,
    knowledge: app.knowledge,
    memory: app.memory,
    now,
  };
  const pair = await timedPair(
    () => analyzeEffectivenessWithSnapshot(effectivenessInput),
    () => analyzeAdaptationEffectiveness(effectivenessInput),
    3,
  );
  const completeEffectiveness = await timed(() => app.controller.adaptationEffectiveness({}), repeats);
  const completeGovernance = await timed(() => app.controller.adaptationReviews({}), 3);

  const integrityRes0 = completeIntegrity.value;
  check(integrityRes0.status === Outcome.SUCCESS_VERIFIED, `${size} records: evidence.integrity finished ${integrityRes0.status}: ${singleLineOf(integrityRes0.output)}`);
  const integrityReport = data(integrityRes0).report;
  check(integrityReport?.available === true, `${size} records: the integrity report was unavailable`);
  check(integrityReport?.snapshot?.state === 'consistent', `${size} records: the integrity window was ${integrityReport?.snapshot?.state}`);
  check(integrityReport?.authorizes === false, `${size} records: the integrity report claimed authorization`);
  check(data(completeEffectiveness.value).report?.available === true, `${size} records: effectiveness was unavailable`);
  check(data(completeGovernance.value).report?.available === true, `${size} records: governance was unavailable`);

  const beforeMs = pair.first.total;
  const afterMs = pair.second.total;
  const delta = afterMs - beforeMs;
  console.log(`  ${pad(`memory ${countOf(files, 'memory.jsonl')} rec / ${files.reduce((n, f) => n + f.bytes, 0)} B across stores`, 58)} `
    + `window state ${window.value.state}; integrity ${integrityReport?.state} (${integrityReport?.counts?.stores} stores, ${integrityReport?.counts?.records} records)`);
  console.log(line(`window open + verify (partial, ${contributing.length} stores)`, window.samples));
  console.log(line('integrity report (partial: window + health)', directIntegrity.samples));
  console.log(line('COMPLETE evidence.integrity (two windows + verify + audit)', completeIntegrity.samples));
  console.log(line('cognitive retrieval (partial: no model, no response)', retrieval.samples));
  console.log(line('COMPLETE adaptation.effectiveness (window + verify + audit)', completeEffectiveness.samples));
  console.log(line('COMPLETE adaptation.reviews (window + verify + audit)', completeGovernance.samples));
  console.log(line('effectiveness analysis without a window (pre-AP-06 shape)', pair.first.samples));
  console.log(line('effectiveness analysis with the window (public read)', pair.second.samples));
  console.log(`  ${pad('window cost on identical bytes', 58)} delta ${delta >= 0 ? '+' : ''}${ms(delta)}ms of a ${ms(beforeMs)}ms unwindowed median; `
    + 'a window is one stat pair per store, so its cost is per store rather than per record');
  console.log(`  ${pad('retrieval disclosed', 58)} ${retrieval.value?.counts?.total ?? '?'} evidence record(s), `
    + `${retrieval.value?.counts?.dropped ?? '?'} dropped by a bound, ${retrieval.value?.counts?.unavailable?.length ?? '?'} unavailable source(s)`);
  console.log('');
}

// ---- section two: bounded windows, at and past the cap ----------------------------------------
console.log(`### adaptations at and past the ${MAX_EFFECTIVENESS_ADAPTATIONS}-row window (complete effectiveness request)`);
for (const count of [MAX_EFFECTIVENESS_ADAPTATIONS, MAX_EFFECTIVENESS_ADAPTATIONS + 1]) {
  const dir = tempDir();
  const now = clock();
  const app = await appIn(dir, now);
  for (let i = 1; i <= count; i += 1) {
    await seedRule(app, { guidance: `benchmark rule ${i} reads before writing`, tag: `AP06-${i}` });
  }
  const run = await timed(() => app.controller.adaptationEffectiveness({}), 3);
  const report = data(run.value).report;
  const stored = (await app.experience.adaptations({ limit: 100, includeRetired: true })).length;
  check(run.value.status === Outcome.SUCCESS_VERIFIED, `${count} adaptations: effectiveness finished ${run.value.status}: ${singleLineOf(run.value.output)}`);
  check(report?.totals?.adaptations === Math.min(count, MAX_EFFECTIVENESS_ADAPTATIONS), `${count} adaptations: the report held ${report?.totals?.adaptations} rows`);
  if (count <= MAX_EFFECTIVENESS_ADAPTATIONS) {
    check(report?.integrity?.truncated === false, `${count} adaptations: a full window was reported as truncated`);
  } else {
    check(report?.integrity?.truncated === true, `${count} adaptations: a clipped window was not disclosed`);
    check(report?.integrity?.truncatedSources?.includes('adaptations'), `${count} adaptations: the clipped source was not named`);
  }
  console.log(`  ${pad(`${count} stored (${stored} read back)`, 58)} ${pad(ms(run.total), 10)}ms  rows ${report?.totals?.adaptations}, `
    + `uses ${report?.totals?.uses}, integrity ${report?.integrity?.state}, `
    + `truncated ${report?.integrity?.truncated}${report?.integrity?.truncatedSources?.length ? ` (${report.integrity.truncatedSources.join(', ')})` : ''}`);
  removeDirSoon(dir);
}
console.log('  The clipped row states one bounded window; it is not faster or slower evidence, and no rule is hidden behind a count.\n');

// ---- section three: concurrent activity -------------------------------------------------------
console.log('### concurrent activity: reads beside writes, and several reads beside each other');
{
  const dir = copyDir(baseDir);
  appendMemory(dir, countOf(storeFiles(dir), 'memory.jsonl'), 1000);
  const now = clock();
  const app = await appIn(dir, now);
  let note = 0;
  const nextNote = () => { note += 1; return `remember that the AP06 concurrency note ${note} holds`; };

  const mixed = await timed(() => Promise.all([
    app.controller.evidenceIntegrity(),
    app.controller.handle(nextNote(), { origin: 'user' }),
    app.controller.adaptationEffectiveness({}),
    app.controller.handle(nextNote(), { origin: 'user' }),
  ]), repeats);
  const [integrityRes, firstWrite, effectivenessRes, secondWrite] = mixed.value;
  for (const write of [firstWrite, secondWrite]) {
    check(write.status === Outcome.SUCCESS_VERIFIED, `concurrent write finished ${write.status}: ${singleLineOf(write.output)}`);
  }
  const refusals = [integrityRes, effectivenessRes].filter((r) => r.status !== Outcome.SUCCESS_VERIFIED);
  console.log(line('integrity + write + effectiveness + write', mixed.samples));
  console.log(`  ${pad('', 58)} writes ${firstWrite.status}/${secondWrite.status}; reads ${integrityRes.status}/${effectivenessRes.status}; `
    + `${refusals.length} read(s) refused rather than stating a mixed instant`);
  for (const refusal of refusals) console.log(`  ${pad('', 58)}   ${refusal.status}: ${singleLineOf(refusal.output)}`);

  // Each read appends its own audit record after it verifies, so one read may observe another's
  // record. Both outcomes are reported; no throughput claim is made.
  const parallel = await timed(() => Promise.all(Array.from({ length: 4 }, () => app.controller.evidenceIntegrity())), repeats);
  const verified = parallel.value.filter((r) => r.status === Outcome.SUCCESS_VERIFIED).length;
  const refused = parallel.value.filter((r) => r.status !== Outcome.SUCCESS_VERIFIED);
  const serial = await timed(() => app.controller.evidenceIntegrity(), repeats);
  console.log(line('four integrity reads in parallel', parallel.samples));
  for (const refusal of refused) console.log(`  ${pad('', 58)}   ${refusal.status}: ${singleLineOf(refusal.output)}`);
  console.log(line('one integrity read, serial (same store)', serial.samples));
  console.log(`  ${pad('', 58)} four reads ${ms(parallel.total)}ms (${verified} of 4 verified, ${refused.length} refused) `
    + `vs one read ${ms(serial.total)}ms; concurrency is measured, not claimed as throughput\n`);
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
  console.log('Every complete read certified its own window or refused explicitly. No store was repaired, no rule changed, and no record was rewritten.');
}

// Deferred cleanup keeps one large fixture and its copies from all sitting on disk at once.
function removeDirSoon(dir) {
  if (process.argv.includes('--keep')) return;
  const at = dirs.indexOf(dir);
  if (at < 0 || !fs.existsSync(dir)) return;
  dirs.splice(at, 1);
  removeDir(dir);
}
