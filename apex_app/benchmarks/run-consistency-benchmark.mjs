// Bounded, model-free benchmark for Batch AP-07: evidence snapshot integrity and read consistency.
//
// What is measured is the cost of the consistency work itself, path by path, on one deterministic
// fixture. Each integrated consumer is measured beside the read shape it had before AP-07, on the same
// bytes and in the same run: the window is opened and verified either way, so the delta is the window
// and the contract, not a remembered number from another machine or another day.
//
// The paths, and what each pair compares:
//   - snapshot certification: a content window against a metadata-only window over the same stores;
//   - integrity validation: one integrity report (its own window plus per-store health) against the
//     complete `evidence.integrity` request, which adds its own independent second window and audit;
//   - cognitive retrieval: `retrieveEvidence` reading the stores directly (the AP-06 shape) against the
//     same analysis over records read inside one content-certified window and given its verdict, with a
//     middle arm (the same seeded reads, no window) so the window's cost is separated from the cost of
//     the seeded read plan itself;
//   - world-state construction: `buildWorldState` alone against the same projection re-certified with
//     the verdict of a window opened around its two stores;
//   - prediction longitudinal: the analysis over a read prefix with no window against the same over a
//     read that carried a consistent window verdict;
//   - candidate generation, goal assessment, plan outcome, effectiveness and governance: the complete
//     read actions, each of which now opens and verifies its own window.
//
// A window is a SHA-256 of each contributing file's exact bytes before the first read and after the
// last. It proves that no contributing file differed byte for byte while the read ran. It is not a
// transaction, it holds no lock, it cannot stop a writer, and it says nothing about whether the
// records are true. Every fixture is deterministic: the application is assembled with NoBackend and a
// fixed clock, no model is contacted, nothing is inferred, and the only synthetic records are memory
// lines appended to a throw-away copy to vary the store size.
//
// Cold and warm are named explicitly: "cold" is the first read of a store in a freshly assembled
// application in this process (nothing parsed yet by that store object); "warm" is a later read on the
// same application and store object. The operating system's file cache is warm for both, so cold here
// measures the store's own first parse, not a cold disk.
//
// Isolation: every data directory is created under the OS temporary root with the
// `apex-bench-consistency-` prefix, and cleanup refuses any path outside that root or without that
// prefix. APEX_DATA_ISOLATED must be unset or 1; any other value is refused.
//
// Do not run this benchmark at the same time as the test suite, or as another benchmark: every figure
// is wall-clock time on this machine only. Nothing here is part of `npm test`.
//
//   APEX_DATA_ISOLATED=1 node benchmarks/run-consistency-benchmark.mjs [--records 100,1000,4000] [--repeats R] [--keep]
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
import { MAX_READ_SOURCES } from '../src/evidence/read-contract.js';
import { WORLD_RECORD_LIMIT, buildWorldState, certifyWorldRead } from '../src/world/world-state.js';
import { MAX_LONGITUDINAL_PREDICTIONS, analyzeLongitudinal } from '../src/prediction/longitudinal.js';
import { assessGoal } from '../src/goals/assess.js';
import { retrieveEvidence } from '../src/cognition/evidence.js';
import { understandRequest } from '../src/cognition/request.js';

const MAX_REPEATS = 10;
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const RECORD_SIZES = [100, 1000, 4000];
const DIR_PREFIX = 'apex-bench-consistency-';
const QUERY = 'what does the AP07 benchmark note say about the lighthouse status?';
const GUIDANCE = 'read the list before adding to it';

const isolation = (process.env.APEX_DATA_ISOLATED ?? '').trim();
if (isolation !== '' && isolation !== '1') {
  throw new Error(`APEX_DATA_ISOLATED must be unset or 1, not ${JSON.stringify(isolation)}`);
}

const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - String(s).length))}`;
const ms = (n) => `${(Math.round(n * 1000) / 1000).toFixed(3)}`;
const singleLineOf = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function spread(xs) {
  return Math.max(...xs) - Math.min(...xs);
}

const line = (label, samples) => `  ${pad(label, 62)} ${pad(ms(median(samples)), 10)}ms min ${pad(ms(Math.min(...samples)), 10)}ms`
  + ` spread ${pad(ms(spread(samples)), 10)}ms samples ${samples.map((x) => (Math.round(x * 1000) / 1000).toFixed(2)).join('/')}`;

// One untimed call before a timed block, so a first parse is not charged to the first sample. A
// refusal is a result, not a warm-up failure: it is discarded like any other first answer.
async function warm(fn) {
  try {
    await fn();
  } catch {
    // The measured call reports its own refusal; the warm-up only exists to move first-read cost out
    // of the sample window.
  }
}

async function timed(fn, repeats) {
  await warm(fn);
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
  await warm(first);
  await warm(second);
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

// Three conditions measured alternately on one fixture, with the same warm-up and rotation rules as
// `timedPair`. The middle arm is a control: it makes the same reads the windowed arm makes, without a
// window, so the difference between the second and third arms is the window and the first pair is the
// read plan itself.
async function timedArms(fns, repeats) {
  for (const fn of fns) await warm(fn);
  const samples = fns.map(() => []);
  const values = fns.map(() => null);
  for (let i = 0; i < repeats; i += 1) {
    for (let k = 0; k < fns.length; k += 1) {
      const started = performance.now();
      values[k] = await fns[k]();
      samples[k].push(performance.now() - started);
    }
  }
  return fns.map((_, k) => ({ samples: samples[k], value: values[k], total: median(samples[k]) }));
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
function syntheticMemory(from, count, tag = 'AP07') {
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
    request: `keep the running note current, consistency benchmark case ${goalSeq}`,
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
async function seedRule(app, { guidance = GUIDANCE, order = 'reads_first', tag = 'AP07' } = {}) {
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

// One linked use, through the full real path, returning the goal and plan it recorded.
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
  return { goalId, planId };
}

const BASE = Date.parse('2026-11-05T00:00:00.000Z');
const at = (index) => new Date(BASE + index * 3_600_000).toISOString();
let projectionSeq = 0;

// A projected expectation in the shape `analyzeLongitudinal` consumes. Synthetic, deterministic, and
// never written to a store: this isolates the analysis from the ledger read it normally shares a
// window with, so the sweep shows the analysis's own scaling.
function projection({ index = 0, capability = 'calc.evaluate' } = {}) {
  projectionSeq += 1;
  const id = `bench-ap07-${projectionSeq}`;
  return {
    id,
    capability,
    expectation: 'success',
    status: 'evaluated',
    provenance: { origin: 'user_recorded' },
    invalidation: null,
    retired: false,
    supersededBy: [],
    evaluation: {
      id: `eval-${id}`,
      verdict: 'matched',
      decidingExperienceId: `exp-${id}`,
      outcomeExperienceIds: [`exp-${id}`],
      createdAt: at(index),
    },
    evaluationStale: false,
    deciding: { id: `exp-${id}`, occurredAt: at(index), outcomeClass: 'success' },
    lineage: { available: true, atCreation: { unresolvedExperienceIds: [], unresolvedFeedbackIds: [], unavailableDeclared: false } },
    createdAt: at(index),
    expiresAt: at(index + 1),
  };
}

function projectionSet(size) {
  return Array.from({ length: size }, (_, i) => projection({ index: i }));
}

const CONSISTENT_WINDOW = Object.freeze({
  schema: 'apex.evidence-snapshot.v1',
  certification: 'content',
  state: 'consistent',
  consistent: true,
  complete: true,
  changed: [],
});

const repeats = Math.min(Math.max(1, Number(arg('repeats', 5)) || 5), MAX_REPEATS);
const sizes = String(arg('records', RECORD_SIZES.join(','))).split(',')
  .map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);

console.log(`evidence-consistency benchmark (AP-07): ${os.platform()} ${os.arch()}, Node ${process.version}`);
console.log(`host: ${os.cpus()[0]?.model ?? 'unknown CPU'}, ${(os.totalmem() / (1024 ** 3)).toFixed(1)} GiB total memory`);
console.log('deterministic and model-free: NoBackend is constructed and never contacted, nothing is inferred');
console.log(`isolation: every data directory is under ${TMP_ROOT} with the ${DIR_PREFIX} prefix; cleanup refuses anything else`
  + ` (APEX_DATA_ISOLATED=${isolation || 'unset'})`);
console.log('run this alone: concurrent tests or another benchmark would change every wall-clock figure below\n');
console.log(`repeats: ${repeats} per complete request; partial module calls use 3 or ${repeats}, whichever is smaller; before/after pairs alternate on one fixture; the retrieval section runs three arms (direct, seeded control, windowed)`);
console.log(`bounds in force: ${MAX_SNAPSHOT_STORES} stores per window, ${DEFAULT_SNAPSHOT_ATTEMPTS} window attempts, `
  + `${MAX_READ_SOURCES} sources per read report, ${MAX_INTEGRITY_FINDINGS} disclosed integrity findings, `
  + `${MAX_LONGITUDINAL_PREDICTIONS} longitudinal projections, ${WORLD_RECORD_LIMIT} projected records per store\n`);

const failed = [];
const check = (condition, message) => { if (!condition) failed.push(message); };

// One fixture with a real linked history, copied per size and enlarged with synthetic memory lines.
const baseDir = tempDir();
let baseGoalId = null;
let basePlanId = null;
{
  const now = clock();
  const app = await appIn(baseDir, now);
  await seedRule(app);
  const used = await seedUse(app, now);
  baseGoalId = used.goalId;
  basePlanId = used.planId;
}
const baseFiles = storeFiles(baseDir);
console.log('### fixture: one approved rule and one linked, executed and assessed use, then synthetic memory growth');
console.log(`  base stores: ${baseFiles.map((f) => `${f.file}:${f.records} rec/${f.bytes} B`).join(', ')}\n`);

// ---- section one: the integrated paths at increasing store size ------------------------------
console.log('### certification, integrity, retrieval and projection under store growth');
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
  const windowStores = contributingStores({ memory: app.memory, knowledge: app.knowledge, experience: app.experience });
  const worldStores = contributingStores({ memory: app.memory, knowledge: app.knowledge, experience: app.experience });

  // A window on its own, content-certified against metadata-only, over the same files.
  const certification = await timedPair(
    async () => (await openEvidenceSnapshot({ stores: contributing, content: true })).verify(),
    async () => (await openEvidenceSnapshot({ stores: contributing, content: false })).verify(),
    3,
  );

  // The integrity report without the action, then the complete request (its own window plus audit).
  const directIntegrity = await timed(() => evidenceIntegrityReport({ stores, now }), 3);
  const completeIntegrity = await timed(() => app.controller.evidenceIntegrity(), repeats);

  // Cognitive retrieval in three arms on the same stores and the same query: the AP-06 shape (the
  // analysis reads the two relevance-gated sources itself), a control with the same two searches done
  // up front and handed in as seeds but no window, and the AP-07 shape (the same reads performed
  // through one content-certified window, with its verdict handed to the analysis). The control exists
  // so the window's cost is not confused with the cost of the seeded read plan.
  const retrievalStores = {
    memory: app.memory,
    knowledge: app.knowledge,
    experience: app.experience,
    predictions: app.predictions,
    goals: app.goals,
    plans: app.plans,
    tasks: app.taskStore,
  };
  const seededRetrieval = async (windowed) => {
    if (!windowed) {
      const memoryHits = await app.memory.search(QUERY, { limit: 8 });
      const knowledge = await app.knowledge.search(QUERY, { limit: 8 });
      return retrieveEvidence({
        request: QUERY, understanding, now: now(), stores: retrievalStores, seeds: { memoryHits, knowledge },
      });
    }
    const snapshot = await openEvidenceSnapshot({ stores: windowStores });
    const memoryHits = await snapshot.read('memory', () => app.memory.search(QUERY, { limit: 8 }));
    const knowledge = await snapshot.read('knowledge', () => app.knowledge.search(QUERY, { limit: 8 }));
    const verdict = await snapshot.verify();
    return retrieveEvidence({
      request: QUERY,
      understanding,
      now: now(),
      stores: retrievalStores,
      seeds: { memoryHits, knowledge },
      window: verdict,
    });
  };
  const [retrievalDirect, retrievalControl, retrievalWindowed] = await timedArms([
    () => retrieveEvidence({ request: QUERY, understanding, now: now(), stores: retrievalStores }),
    () => seededRetrieval(false),
    () => seededRetrieval(true),
  ], 3);

  // World-state construction alone beside the same projection re-certified by a window around its
  // two stores. The temporal and prediction sections are read the way the controller reads them.
  const worldPair = await timedPair(
    async () => {
      const temporal = { available: true, ...(await app.experience.temporalSummary()) };
      const predictions = { available: true, ...(await app.predictions.promptView()) };
      return buildWorldState({ memory: app.memory, knowledge: app.knowledge, now, temporal, predictions });
    },
    async () => {
      const snapshot = await openEvidenceSnapshot({ stores: worldStores });
      const temporal = { available: true, ...(await snapshot.read('temporal', () => app.experience.temporalSummary())) };
      const predictions = { available: true, ...(await snapshot.read('predictions', () => app.predictions.promptView())) };
      const world = await buildWorldState({
        memory: app.memory, knowledge: app.knowledge, now, temporal, predictions,
      });
      const certified = certifyWorldRead(world, await snapshot.verify());
      return certified;
    },
    3,
  );

  // The complete read actions. Each opens and verifies its own window and appends its own audit line.
  const candidateGoalId = await newGoal(app);
  const candidateRun = await timed(() => app.controller.planCandidates({ goal: candidateGoalId }), repeats);
  const longitudinalRun = await timed(() => app.controller.predictionLongitudinal({}), repeats);
  const outcomeRun = await timed(() => app.controller.planOutcome({ plan: basePlanId }), repeats);
  const effectivenessRun = await timed(() => app.controller.adaptationEffectiveness({}), repeats);
  const governanceRun = await timed(() => app.controller.adaptationReviews({}), repeats);

  // Goal assessment on its own: the same derivation the plan reads embed, measured without a window.
  const goal = await app.goals.get(baseGoalId);
  const goalAssessment = await timed(() => assessGoal(goal, {
    knowledge: app.knowledge, operations: app.operations, plans: app.plans,
  }), 3);

  const integrityReport = data(completeIntegrity.value).report;
  const candidatesRun = data(candidateRun.value);
  const longitudinalReport = data(longitudinalRun.value).report;
  const outcomeData = data(outcomeRun.value);
  const effectivenessReport = data(effectivenessRun.value).report;
  const governanceReport = data(governanceRun.value).report;

  check(certification.first.value.state === 'consistent', `${size}: the content window was ${certification.first.value.state}`);
  check(certification.first.value.certification === 'content', `${size}: the content window certified ${certification.first.value.certification}`);
  check(certification.second.value.certification === 'metadata', `${size}: the metadata window certified ${certification.second.value.certification}`);
  check(completeIntegrity.value.status === Outcome.SUCCESS_VERIFIED, `${size}: evidence.integrity finished ${completeIntegrity.value.status}: ${singleLineOf(completeIntegrity.value.output)}`);
  check(integrityReport?.available === true, `${size}: the integrity report was unavailable`);
  check(integrityReport?.snapshot?.state === 'consistent', `${size}: the integrity window was ${integrityReport?.snapshot?.state}`);
  check(integrityReport?.authorizes === false, `${size}: the integrity report claimed authorization`);
  check(retrievalWindowed.value.read.window === 'consistent', `${size}: retrieval's window was ${retrievalWindowed.value.read.window}`);
  check(retrievalWindowed.value.read.certification === 'content', `${size}: retrieval certified ${retrievalWindowed.value.read.certification}`);
  check(retrievalControl.value.read.window === 'unverified', `${size}: the seeded control's window was ${retrievalControl.value.read.window}`);
  check(worldPair.second.value.read.state !== 'unavailable', `${size}: the projection's reads were unavailable`);
  check(worldPair.second.value.complete === worldPair.first.value.complete, `${size}: certification changed the projection's completeness`);
  check(candidateRun.value.status === Outcome.SUCCESS_VERIFIED, `${size}: plan.candidates finished ${candidateRun.value.status}: ${singleLineOf(candidateRun.value.output)}`);
  check(candidatesRun.evidence?.window === 'consistent', `${size}: candidate comparison's window was ${candidatesRun.evidence?.window}`);
  check(longitudinalRun.value.status === Outcome.SUCCESS_VERIFIED, `${size}: prediction.longitudinal finished ${longitudinalRun.value.status}: ${singleLineOf(longitudinalRun.value.output)}`);
  check(longitudinalReport?.read?.window === 'consistent', `${size}: longitudinal's window was ${longitudinalReport?.read?.window}`);
  check(outcomeRun.value.status === Outcome.SUCCESS_VERIFIED, `${size}: plan.outcome finished ${outcomeRun.value.status}: ${singleLineOf(outcomeRun.value.output)}`);
  check(outcomeData.evidence?.window === 'consistent', `${size}: plan.outcome's window was ${outcomeData.evidence?.window}`);
  check(effectivenessRun.value.status === Outcome.SUCCESS_VERIFIED, `${size}: effectiveness finished ${effectivenessRun.value.status}: ${singleLineOf(effectivenessRun.value.output)}`);
  check(effectivenessReport?.available === true, `${size}: the effectiveness report was unavailable`);
  check(governanceRun.value.status === Outcome.SUCCESS_VERIFIED, `${size}: governance finished ${governanceRun.value.status}: ${singleLineOf(governanceRun.value.output)}`);
  check(governanceReport?.available === true, `${size}: the governance report was unavailable`);

  const delta = (...pair) => {
    const [a, b] = pair;
    return `${b.total - a.total >= 0 ? '+' : ''}${ms(b.total - a.total)}ms`;
  };

  console.log(`  ${pad(`memory ${countOf(files, 'memory.jsonl')} rec / ${files.reduce((n, f) => n + f.bytes, 0)} B across stores`, 62)} `
    + `integrity ${integrityReport?.state} (${integrityReport?.counts?.stores} stores, ${integrityReport?.counts?.records} records)`);
  console.log(line(`window open + verify, content (${contributing.length} stores)`, certification.first.samples));
  console.log(line(`window open + verify, metadata only (same files)`, certification.second.samples));
  console.log(`  ${pad('certification cost of the bytes', 62)} ${delta(certification.second, certification.first)} over metadata`);
  console.log(line('integrity report (partial: window + health)', directIntegrity.samples));
  console.log(line('COMPLETE evidence.integrity (two windows + verify + audit)', completeIntegrity.samples));
  console.log(line('retrieval with stores read directly (AP-06 shape)', retrievalDirect.samples));
  console.log(line('retrieval with the same reads seeded, no window (control)', retrievalControl.samples));
  console.log(line('retrieval through one certified window (AP-07 shape)', retrievalWindowed.samples));
  console.log(`  ${pad('seeded read plan (control over AP-06 shape)', 62)} ${delta(retrievalDirect, retrievalControl)}`);
  console.log(`  ${pad('window + verdict on a seeded read (AP-07 over control)', 62)} ${delta(retrievalControl, retrievalWindowed)}`);
  console.log(`  ${pad('window + verdict on the retrieval path (total)', 62)} ${delta(retrievalDirect, retrievalWindowed)}; `
    + `${retrievalWindowed.value.counts.total} evidence record(s), ${retrievalWindowed.value.counts.dropped} dropped by a bound`);
  console.log(line('world-state build, unwindowed', worldPair.first.samples));
  console.log(line('world-state build + window + certify', worldPair.second.samples));
  console.log(`  ${pad('window + certification on the projection', 62)} ${delta(worldPair.first, worldPair.second)}; `
    + `read ${worldPair.second.value.read.state}, ${worldPair.second.value.beliefs?.shown ?? '?'} of ${worldPair.second.value.beliefs?.total ?? '?'} belief(s) shown`);
  console.log(line('goal assessment (partial: no window)', goalAssessment.samples));
  console.log(line('COMPLETE plan.candidates (window + verify + audit)', candidateRun.samples));
  console.log(line('COMPLETE prediction.longitudinal (window + ledger + audit)', longitudinalRun.samples));
  console.log(line('COMPLETE plan.outcome (window + outcome derivation)', outcomeRun.samples));
  console.log(line('COMPLETE adaptation.effectiveness (window + trace + audit)', effectivenessRun.samples));
  console.log(line('COMPLETE adaptation.reviews (window + lifecycle + audit)', governanceRun.samples));
  console.log(`  ${pad('complete-read disclosures', 62)} candidates ${candidatesRun.evidence?.window}/${candidatesRun.evidence?.certification}; `
    + `longitudinal ${longitudinalReport?.read?.window}/${longitudinalReport?.read?.certification} `
    + `over ${longitudinalReport?.read?.considered ?? 0} projection(s); outcome ${outcomeData.evidence?.window}/${outcomeData.evidence?.certification}`);
  if ((longitudinalReport?.read?.considered ?? 0) === 0) {
    console.log(`  ${pad('', 62)} the fixture records no evaluated expectations, so the ledger-backed read is empty; `
      + 'the analysis at scale is measured in section two over synthetic projections');
  }
  console.log('');
  removeDirSoon(dir);
}

// ---- section two: the analysis alone, at increasing history size -------------------------------
console.log('### prediction longitudinal over synthetic history, with and without a window verdict');
console.log('  The projections are in-memory and identical per size; only the analysis runs. The ledger read is');
console.log('  measured in section one through the complete request, where it shares a window with experience.');
for (const size of [...new Set([MAX_LONGITUDINAL_PREDICTIONS, 200, 1000])]) {
  if (!Number.isInteger(size) || size < 1) continue;
  const projections = projectionSet(size);  const experiences = new Map(projections.map((p) => [p.evaluation.outcomeExperienceIds[0], { id: p.evaluation.outcomeExperienceIds[0], active: true }]));
  const pair = await timedPair(
    () => analyzeLongitudinal({ projections, experiencesById: experiences, now: '2026-11-20T00:00:00.000Z' }),
    () => analyzeLongitudinal({ projections, experiencesById: experiences, now: '2026-11-20T00:00:00.000Z', window: CONSISTENT_WINDOW }),
    3,
  );
  check(pair.first.value.read.complete === true, `${size} projections: the unwindowed analysis was not complete`);
  check(pair.second.value.read.complete === true, `${size} projections: the windowed analysis was not complete`);
  console.log(`  ${pad(`${size} projections, ${pair.second.value.groups.length} capability group(s)`, 62)} `
    + `no window ${ms(pair.first.total)}ms, with verdict ${ms(pair.second.total)}ms, delta ${ms(pair.second.total - pair.first.total)}ms`);
  console.log(`  ${pad('', 62)} ${pair.first.value.totals.evaluated} evaluated, ${pair.first.value.totals.eligibleScored} eligible scored, `
    + `patterns ${pair.first.value.read.patternsAllowed}`);
}

// ---- section three: one operation, one window -------------------------------------------------
console.log('\n### per-operation snapshot reuse: two reads of one label inside one window');
{
  const dir = copyDir(baseDir);
  appendMemory(dir, countOf(storeFiles(dir), 'memory.jsonl'), 1000);
  const now = clock();
  const app = await appIn(dir, now);
  const contributing = contributingStores({ memory: app.memory, knowledge: app.knowledge, experience: app.experience });
  const reused = await timed(async () => {
    const snapshot = await openEvidenceSnapshot({ stores: contributing });
    const first = await snapshot.read('memory', () => app.memory.search(QUERY, { limit: 8 }));
    const second = await snapshot.read('memory', () => app.memory.search(QUERY, { limit: 8 }));
    await snapshot.verify();
    return { first, second };
  }, 3);
  // The alternative to reuse: a second window, opened for the second read of the same store.
  const separate = await timed(async () => {
    const first = await openEvidenceSnapshot({ stores: contributing });
    await first.read('memory', () => app.memory.search(QUERY, { limit: 8 }));
    await first.verify();
    const second = await openEvidenceSnapshot({ stores: contributing });
    await second.read('memory', () => app.memory.search(QUERY, { limit: 8 }));
    await second.verify();
  }, 3);
  console.log(line('one window, the same label read twice', reused.samples));
  console.log(line('two windows, each reading the label once', separate.samples));
  console.log(`  ${pad('', 62)} the same label is one store read, memoised for the life of the snapshot; `
    + 'reuse is per operation and is never persisted\n');
  removeDirSoon(dir);
}

// ---- section four: cold and warm ---------------------------------------------------------------
console.log('### cold and warm: the first read in a freshly assembled application against later reads');
{
  const dir = copyDir(baseDir);
  appendMemory(dir, countOf(storeFiles(dir), 'memory.jsonl'), 1000);
  const now = clock();
  // Assembly is not the unit under test, so it is measured once and reported on its own.
  const assemblyStart = performance.now();
  await appIn(dir, now);
  const assemblyMs = performance.now() - assemblyStart;

  // `run(app)` performs one complete read. Cold = a fresh application, then its first read, timed from
  // the freshly assembled object; warm = one warm-up read on another fresh application, then repeats on
  // that same application and store object.
  const coldWarm = async (label, run) => {
    const coldApp = await appIn(dir, now);
    const started = performance.now();
    const first = await run(coldApp);
    const cold = performance.now() - started;
    const warmApp = await appIn(dir, now);
    await run(warmApp);
    const warm = [];
    for (let i = 0; i < repeats; i += 1) {
      const at0 = performance.now();
      await run(warmApp);
      warm.push(performance.now() - at0);
    }
    console.log(`  ${pad(label, 62)} cold ${pad(ms(cold), 10)}ms warm median ${pad(ms(median(warm)), 10)}ms `
      + `spread ${ms(spread(warm))}ms samples ${warm.map((x) => (Math.round(x * 1000) / 1000).toFixed(2)).join('/')}`);
    return first;
  };

  const integrity = await coldWarm('evidence.integrity (fresh app)', (fresh) => fresh.controller.evidenceIntegrity());
  check(integrity.status === Outcome.SUCCESS_VERIFIED, `cold integrity finished ${integrity.status}`);
  const outcome = await coldWarm('plan.outcome (fresh app)', (fresh) => fresh.controller.planOutcome({ plan: basePlanId }));
  check(outcome.status === Outcome.SUCCESS_VERIFIED, `cold plan.outcome finished ${outcome.status}`);
  const longitudinal = await coldWarm('prediction.longitudinal (fresh app)', (fresh) => fresh.controller.predictionLongitudinal({}));
  check(longitudinal.status === Outcome.SUCCESS_VERIFIED, `cold longitudinal finished ${longitudinal.status}`);
  console.log(`  ${pad('application assembly, one fresh app', 62)} ${ms(assemblyMs)}ms (not part of any read above)`);
  console.log('  Cold here is the store object\'s first parse in this process, not a cold disk: the OS file cache is warm.');
  console.log('');
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
  console.log('Every measured read certified its own window or disclosed why it could not. No store was repaired, '
    + 'no record was rewritten, and no report authorized an action.');
}

// Deferred cleanup keeps one large fixture and its copies from all sitting on disk at once.
function removeDirSoon(dir) {
  if (process.argv.includes('--keep')) return;
  const at = dirs.indexOf(dir);
  if (at < 0 || !fs.existsSync(dir)) return;
  dirs.splice(at, 1);
  removeDir(dir);
}
