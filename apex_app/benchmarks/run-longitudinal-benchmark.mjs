// Bounded, model-free benchmark for the longitudinal outcome read (Batch AP-03) and the complete
// decision request it can inform.
//
// Section one measures the pure analysis (`analyzeLongitudinal`) over increasing synthetic histories:
// how the read cost moves with the number of recorded predictions, how many groups and exclusions are
// produced, and where the fixed bounds hold per-group work constant. Section two measures the real
// application against a temporary data directory seeded through the ordinary controller actions: the
// store read, the authorized longitudinal action, the derivation that may create a candidate, and the
// complete `plan.candidates` request with the approved rule in effect.
//
// The complete request is the whole controller call, audit append and independent re-read included.
// The currentness read that re-judges every cited prediction runs inside that request, on every call,
// with no cached result; it is therefore part of every total below rather than a separate discount.
// The store read, the action, and the derivation are printed separately and labelled partial: they are
// not the cost of a request.
//
// The comparison against the AP-02 path is made in the same application and over the same evaluated
// history. An AP-02 candidate is one evaluated prediction (one citation); an AP-03 candidate is one
// supported longitudinal pattern (several citations). Both are approved through the same existing
// action, one at a time, and the complete request is measured under each. The candidate bytes are
// asserted unchanged between the conditions, so the measurement is of the disclosure and the guidance
// read, not of a different comparison.
//
// No inference is run or simulated: every application is built with NoBackend, which is never
// contacted. Nothing here is part of `npm test`.
//
//   node benchmarks/run-longitudinal-benchmark.mjs [--sizes 20,100,500,1000] [--real 20,40,80] [--repeats R] [--keep]
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
  analyzeLongitudinal,
  MAX_LONGITUDINAL_GROUPS, MAX_LONGITUDINAL_OBSERVATIONS, MAX_LONGITUDINAL_EXCLUSIONS,
  MAX_LONGITUDINAL_PREDICTIONS, MIN_REPEATED_OBSERVATIONS,
} from '../src/prediction/longitudinal.js';
import { MAX_PREDICTION_LIST, MIN_CALIBRATION_EVALUATIONS } from '../src/prediction/prediction-engine.js';
import { MAX_PREDICTION_CANDIDATES, MAX_SUPPORT_REFS } from '../src/experience/experience-store.js';
import { PREDICTION_DECISION_DIMENSION } from '../src/experience/prediction-derivation.js';

const MAX_REPEATS = 15;
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const PURE_SIZES = [20, 100, 500, 1000];
// The derivation reads at most MAX_PREDICTION_CANDIDATES predictions per call and refuses a pattern
// from a partial read, so the sizes below include one above that bound to measure the refusal rather
// than to hide it.
const REAL_SIZES = [8, 14, 19, 25];
const PURE_NOW = '2026-11-20T00:00:00.000Z';
const CAPABILITY_POOL = Array.from({ length: MAX_LONGITUDINAL_GROUPS }, (_, i) => `bench.cap.${String(i).padStart(2, '0')}`);

const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - String(s).length))}`;
const ms = (n) => `${(Math.round(n * 1000) / 1000).toFixed(3)}`;
const us = (n) => `${(Math.round(n * 1000) / 1) / 1000}`;
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const line = (label, samples) => `  ${pad(label, 46)} ${pad(ms(median(samples)), 10)} min ${pad(ms(Math.min(...samples)), 10)}`
  + ` samples ${samples.map((x) => (Math.round(x * 1000) / 1000).toFixed(2)).join('/')}ms`;

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

// ---- pure fixtures ----------------------------------------------------------------------------
//
// A projection in the shape the ledger produces for an evaluated prediction. `deciding` states the
// outcome class and its occurrence time directly, so the analysis needs no second read to resolve
// them; that is exactly the field a real projection lacks, and section two measures the real path
// where the class is resolved from the evidence read instead.
function pureProjection({ id, capability, outcomeClass, status, index }) {
  const evidenceId = `exp-${id}`;
  const evaluated = status === 'evaluated' || status === 'invalidated';
  const at = new Date(Date.parse('2026-11-01T00:00:00.000Z') + index * 3_600_000).toISOString();
  return {
    id,
    capability,
    expectation: 'success',
    status,
    provenance: { origin: 'user_recorded' },
    invalidation: status === 'invalidated' ? { reason: 'benchmark withdrawal' } : null,
    retired: false,
    supersededBy: [],
    evaluation: evaluated ? {
      id: `eval-${id}`,
      verdict: outcomeClass === 'success' ? 'matched' : 'contradicted',
      decidingExperienceId: evidenceId,
      outcomeExperienceIds: [evidenceId],
      createdAt: at,
    } : null,
    evaluationStale: false,
    deciding: evaluated ? { id: evidenceId, occurredAt: at, outcomeClass } : null,
    lineage: { available: true, atCreation: { unresolvedExperienceIds: [], unresolvedFeedbackIds: [], unavailableDeclared: false } },
    createdAt: at,
    expiresAt: new Date(Date.parse(at) + 86_400_000).toISOString(),
  };
}

// One history with a stated shape per capability order: repeated success, repeated failure, strict
// alternation, and a mixed group. Every seventh, eleventh and thirteenth record is withdrawn, expired
// and awaiting respectively, mirroring the group's own outcome class so an exclusion is not mistaken
// for a conflicting observation.
function pureHistory(total) {
  const groupCount = Math.min(MAX_LONGITUDINAL_GROUPS, Math.max(1, Math.round(total / 25)));
  const counters = new Map();
  const projections = [];
  for (let i = 0; i < total; i += 1) {
    const capIndex = i % groupCount;
    const n = counters.get(capIndex) ?? 0;
    counters.set(capIndex, n + 1);
    let outcomeClass = 'success';
    if (capIndex % 4 === 1) outcomeClass = 'failure';
    else if (capIndex % 4 === 2) outcomeClass = n % 2 === 0 ? 'success' : 'failure';
    else if (capIndex % 4 === 3) outcomeClass = ['success', 'success', 'failure', 'success'][n % 4];
    let status = 'evaluated';
    if (i % 7 === 0) status = 'invalidated';
    else if (i % 11 === 0) status = 'expired';
    else if (i % 13 === 0) status = 'awaiting_evaluation';
    projections.push(pureProjection({
      id: `pure-${String(i).padStart(4, '0')}`, capability: CAPABILITY_POOL[capIndex], outcomeClass, status, index: i,
    }));
  }
  return { projections, groupCount };
}

// ---- real application fixtures ----------------------------------------------------------------

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'apex-bench-longitudinal-'));
  dirs.push(dir);
  return dir;
}

function removeDir(dir) {
  const real = fs.realpathSync(dir);
  if (!real.startsWith(TMP_ROOT) || !path.basename(real).startsWith('apex-bench-longitudinal-')) {
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
  now.advance = (days) => { at += days * 86_400_000; };
  return now;
}

const appIn = (dataDir, now) => createApp({
  dataDir,
  now,
  gateway: new ModelGateway({ backend: new NoBackend() }),
  experienceCapture: CAPTURE_OFF,
});

const data = (res) => res?.operation?.steps?.[0]?.result?.data ?? res?.result?.data ?? {};

let note = 0;
function successMemory() {
  note += 1;
  return `remember that the AP03 benchmark note ${note} holds`;
}

async function observed(app, text) {
  const res = await app.controller.handle(text, { origin: 'user' });
  if (res.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`benchmark action did not verify: ${res.status}`);
  const recorded = await app.controller.experienceRecord({ operationId: res.operation.id, subject: 'an AP03 benchmark outcome' });
  if (recorded.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`benchmark experience was not recorded: ${recorded.output}`);
  return data(recorded);
}

// The complete real evidence chain: expectation, recorded outcome, deterministic evaluation. The
// two-day spacing keeps each horizon clear of the next, so one evaluated outcome is the only event a
// window can see.
async function evaluated(app, now, { capability, action }) {
  const recorded = await app.controller.predictionRecord({
    capability, expectation: 'success', subject: `an AP03 benchmark expectation about ${capability}`, inDays: 1,
  });
  if (recorded.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`benchmark prediction was not recorded: ${recorded.output}`);
  const predictionId = data(recorded).id;
  now.advance(1);
  await observed(app, action);
  const evaluation = await app.controller.predictionEvaluate({ target: predictionId });
  if (evaluation.status !== Outcome.SUCCESS_VERIFIED || data(evaluation).recorded !== true) {
    throw new Error(`benchmark evaluation was not recorded: ${evaluation.output}`);
  }
  now.advance(1);
  return predictionId;
}

async function newGoal(app) {
  const created = await app.controller.goalAdd({
    request: 'keep the release note current',
    criteria: [
      { description: 'list my memory', basis: 'user_stated' },
      { description: 'remember that the release note holds', requirement: 'suggested' },
    ],
  });
  const goalId = data(created).goalId;
  for (const status of ['accepted', 'active']) await app.controller.goalUpdate({ target: goalId, status });
  return goalId;
}

function shapeOfDecision(dataValue) {
  return JSON.stringify({
    candidateSetDigest: dataValue.candidateSetDigest,
    candidates: (dataValue.candidates ?? []).map((c) => ({ strategy: c.strategy, digest: c.digest })),
    gates: dataValue.comparison?.gates,
    rankedDimensions: dataValue.comparison?.rankedDimensions,
  });
}

const repeats = Math.min(Math.max(1, Number(arg('repeats', 7)) || 7), MAX_REPEATS);
const pureSizes = String(arg('sizes', PURE_SIZES.join(','))).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const realSizes = String(arg('real', REAL_SIZES.join(','))).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);

console.log(`longitudinal outcome benchmark: ${os.platform()} ${os.arch()}, Node ${process.version}`);
console.log('deterministic and model-free: NoBackend is constructed and never contacted, nothing is inferred\n');
console.log(`repeats: ${repeats} per measurement; every sample writes its own audit record, as a request does\n`);
console.log(`bounds in force: ${MAX_LONGITUDINAL_PREDICTIONS} predictions read, ${MAX_LONGITUDINAL_GROUPS} groups, `
  + `${MAX_LONGITUDINAL_OBSERVATIONS} observations and ${MAX_LONGITUDINAL_EXCLUSIONS} exclusions shown per group, `
  + `${MAX_SUPPORT_REFS} support refs per rule; derivation read ${MAX_PREDICTION_CANDIDATES}; calibration floor ${MIN_CALIBRATION_EVALUATIONS}\n`);

const failed = [];

// ---- section one: the pure analysis over increasing histories ---------------------------------
console.log('### pure analysis: increasing recorded histories (one group per 25 records, capped at 20)');
for (const size of pureSizes) {
  const { projections } = pureHistory(size);
  // `deciding` states the class directly, so no evidence map is handed over: an empty map would be
  // read as "every cited outcome is missing", which is the opposite of what this fixture states.
  const args = { projections, experiencesById: null, now: PURE_NOW, readTotal: size, readTruncated: false };
  for (let i = 0; i < 5; i += 1) analyzeLongitudinal(args);
  const samples = [];
  let report = null;
  for (let i = 0; i < repeats; i += 1) {
    const started = performance.now();
    report = analyzeLongitudinal(args);
    samples.push(performance.now() - started);
  }
  const total = median(samples);
  const patterns = Object.entries(report.totals.byPattern).map(([k, v]) => `${k}:${v}`).join(' ');
  const truncated = report.groups.some((g) => g.observationsTruncated || g.exclusionsTruncated);
  console.log(`  ${pad(`${size} recorded prediction(s)`, 46)} ${pad(ms(total), 10)} min ${pad(ms(Math.min(...samples)), 10)}`
    + ` ${pad(`${us((total * 1000) / size)} us/record`, 22)}`
    + ` groups ${report.totals.groups}, eligible ${report.totals.eligibleScored}, excluded ${report.totals.excluded}`);
  console.log(`  ${pad('', 46)} patterns ${patterns || 'none'}; per-group truncation disclosed ${truncated ? 'yes' : 'no'}; `
    + `report ${bytesOf(report)} bytes`);
}

// ---- section two: the real store, action, derivation and complete request ----------------------
console.log('\n### real production path: one evaluated capability (memory.add) plus one single-evaluation scope (memory.list)');
for (const size of realSizes) {
  const seedDir = tempDir();
  const now = clock();
  const seedApp = await appIn(seedDir, now);
  const goalId = await newGoal(seedApp);

  const seedStarted = performance.now();
  for (let i = 0; i < size; i += 1) await evaluated(seedApp, now, { capability: 'memory.add', action: successMemory() });
  await evaluated(seedApp, now, { capability: 'memory.list', action: 'list my memory' });
  const seedMs = performance.now() - seedStarted;

  // Partial computations run in their own copy: they append audit records, and a store the complete
  // request is measured against must not grow between conditions for a reason unrelated to the rule.
  const deriveDir = copyDir(seedDir);
  const deriveApp = await appIn(deriveDir, now);
  await deriveApp.predictions.longitudinal({ capability: 'memory.add' });
  await deriveApp.controller.predictionLongitudinal({ capability: 'memory.add' });
  const storeRead = await timed(() => deriveApp.predictions.longitudinal({ capability: 'memory.add' }), repeats);
  const actionRead = await timed(() => deriveApp.controller.predictionLongitudinal({ capability: 'memory.add' }), repeats);
  const coldStarted = performance.now();
  const firstDerive = await deriveApp.controller.adaptationDerive({});
  const coldDeriveMs = performance.now() - coldStarted;
  const derive = await timed(() => deriveApp.controller.adaptationDerive({}), repeats);

  const report = data(actionRead.value).report;
  const group = report.groups.find((g) => g.capability === 'memory.add');
  const derived = data(firstDerive);
  const longitudinal = derived.created.find((c) => c.capability === 'memory.add');
  const single = derived.created.find((c) => c.capability === 'memory.list');

  // The complete-request conditions each start from an identical byte-for-byte copy of the store at
  // the moment the candidates exist. The only difference between them is the one approval each
  // carries, so the audit log, the records, and the read history are the same under every condition.
  const runComplete = async (dir, setup = null) => {
    const copyApp = await appIn(dir, now);
    if (setup) await setup(copyApp);
    for (let i = 0; i < 2; i += 1) await copyApp.controller.planCandidates({ goal: goalId });
    const sample = await timed(() => copyApp.controller.planCandidates({ goal: goalId }), repeats);
    return { ...sample, app: copyApp, data: data(sample.value) };
  };

  const baseline = await runComplete(copyDir(deriveDir));
  const baselineShape = shapeOfDecision(baseline.data);

  const calibration = group?.calibration.available ? 'available' : `unavailable (${group?.calibration.reason})`;
  console.log(`  ${pad(`history ${size} evaluation(s) + 1 memory.add`, 46)} seed ${ms(seedMs)}ms (not measured); `
    + `pattern ${group?.pattern.kind}, eligible ${group?.counts.eligibleScored}, excluded ${group?.counts.excluded}, `
    + `calibration ${calibration}`);
  console.log(`  ${pad('', 46)} groups ${report.totals.groups}, patterns ${Object.entries(report.totals.byPattern).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  console.log(`  ${pad('store longitudinal read (partial)', 46)} ${pad(ms(storeRead.total), 10)}ms  report ${bytesOf(storeRead.value?.report ?? storeRead.value)} bytes`);
  console.log(`  ${pad('authorized longitudinal action (partial)', 46)} ${pad(ms(actionRead.total), 10)}ms`);
  console.log(`  ${pad('one derivation, appends candidates (partial)', 46)} ${pad(ms(coldDeriveMs), 10)}ms`
    + `  created ${derived.created.length}`);
  console.log(`  ${pad('repeat derivation, nothing to append (partial)', 46)} ${pad(ms(derive.total), 10)}ms`);
  console.log(`  ${pad('COMPLETE request, no rule approved', 46)} ${pad(ms(baseline.total), 10)}ms`);

  if (!longitudinal) {
    // The derivation's read is bounded, and it refuses to state a pattern from a partial read. The
    // refusal is a disclosed boundary, not a benchmark failure.
    const skip = (derived.prediction?.longitudinal?.skipped ?? []).find((s) => s.capability === 'memory.add');
    console.log(`  ${pad('', 46)} no longitudinal candidate: ${skip?.reason ?? derived.prediction?.longitudinal?.reason ?? 'not reported'}`);
    console.log(`  ${pad('', 46)} the rule conditions are not measured above the ${MAX_PREDICTION_CANDIDATES}-record derivation bound\n`);
    continue;
  }
  if (!single) {
    failed.push(`${size}: expected one single-evaluation candidate for memory.add, got ${JSON.stringify(derived.created.map((c) => c.capability))}`);
    continue;
  }

  // AP-02 shape: one evaluated prediction, one citation.
  const ap02 = await runComplete(copyDir(deriveDir), async (copyApp) => {
    const approved = await copyApp.controller.adaptationDecide({ target: single.id, decision: 'approved', reason: 'benchmark AP-02 shape' });
    if (approved.status !== Outcome.SUCCESS_VERIFIED) failed.push(`${size}: the AP-02-shaped approval did not verify`);
  });
  // AP-03 shape: the supported longitudinal pattern, several citations.
  const ap03 = await runComplete(copyDir(deriveDir), async (copyApp) => {
    const approved = await copyApp.controller.adaptationDecide({ target: longitudinal.id, decision: 'approved', reason: 'benchmark AP-03 shape' });
    if (approved.status !== Outcome.SUCCESS_VERIFIED) failed.push(`${size}: the longitudinal approval did not verify`);
  });
  const ap02Shape = shapeOfDecision(ap02.data);
  const ap03Shape = shapeOfDecision(ap03.data);

  const ap02Decision = ap02.data.adaptationDecision;
  const ap03Decision = ap03.data.adaptationDecision;
  if (ap02Decision?.dimension !== PREDICTION_DECISION_DIMENSION) failed.push(`${size}: the AP-02-shaped decision names the wrong dimension`);
  if (ap03Decision?.dimension !== PREDICTION_DECISION_DIMENSION) failed.push(`${size}: the longitudinal decision names the wrong dimension`);
  if (baselineShape !== ap02Shape || baselineShape !== ap03Shape) {
    failed.push(`${size}: the candidate bytes, gates or binding moved between the decision conditions`);
  }
  if (ap03Decision?.applied !== true || ap03Decision?.changed !== true) {
    failed.push(`${size}: the approved longitudinal rule did not move the comparison`);
  }
  if (ap03Decision?.rules?.[0]?.basis !== 'longitudinal_pattern') failed.push(`${size}: the applied rule is not stated as a longitudinal pattern`);

  const cited = ap03Decision?.rules?.[0]?.support?.predictionIds?.length ?? 0;
  const expectedCited = Math.min(size, MAX_LONGITUDINAL_OBSERVATIONS);
  if (cited !== expectedCited) failed.push(`${size}: the applied rule cites ${cited} prediction(s), expected ${expectedCited}`);
  // The AP-02-shaped rule need not move this comparison (both candidates carry memory.list); what
  // makes it AP-02-shaped is its single citation, which the record itself must state.
  const ap02Detail = await ap02.app.experience.adaptationDetail(single.id);
  const ap02Cited = (ap02Detail.support?.predictionIds ?? []).length;
  if (ap02Cited !== 1) failed.push(`${size}: the AP-02-shaped rule cites ${ap02Cited} prediction(s), expected 1`);

  console.log(`  ${pad('COMPLETE request, AP-02 rule (1 citation)', 46)} ${pad(ms(ap02.total), 10)}ms`
    + `  applied ${ap02Decision?.applied}, changed ${ap02Decision?.changed}`);
  console.log(`  ${pad('COMPLETE request, AP-03 rule (cited predictions)', 46)} ${pad(ms(ap03.total), 10)}ms`
    + `  applied ${ap03Decision?.applied}, changed ${ap03Decision?.changed}, cited ${cited}`);
  const addedAp02 = median(ap02.samples) - median(baseline.samples);
  const addedAp03 = median(ap03.samples) - median(baseline.samples);
  console.log(`  ${pad('', 46)} median difference vs no rule: AP-02 ${addedAp02 >= 0 ? '+' : ''}${ms(addedAp02)}ms, `
    + `AP-03 ${addedAp03 >= 0 ? '+' : ''}${ms(addedAp03)}ms (identical stores; noise included)`);
  console.log(`  ${pad('', 46)} decision block ${bytesOf(ap03Decision)} bytes; candidate bytes unchanged across all three: `
    + `${baselineShape === ap02Shape && baselineShape === ap03Shape ? 'yes' : 'NO'}`);
  console.log(`  ${pad('', 46)} the currentness read re-judges all ${cited} citations inside each request; nothing is cached\n`);
}

for (const dir of dirs) {
  if (!process.argv.includes('--keep')) removeDir(dir);
}

if (failed.length > 0) {
  console.log('The run is not comparable:');
  for (const problem of failed) console.log(`  - ${problem}`);
  process.exitCode = 1;
}
