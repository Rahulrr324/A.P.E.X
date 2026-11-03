// Bounded, model-free benchmark for the prediction ledger (Batch AE).
//
// It measures APEX's own paths against synthetic fixtures in fresh temporary data directories.
// No inference is run or simulated: every application is built with NoBackend, and no read below
// asks a model anything. This is not part of `npm test` and no test depends on it.
//
//   node benchmarks/run-prediction-benchmark.mjs [--repeats R] [--phase P] [--keep]
//
// Phases, run in order unless one is selected:
//   reads     what a ledger read costs, at progressive ledger sizes and against progressive
//           experience-log sizes. `load` and `project` are the ledger alone; `horizon` is one
//           re-opening of one prediction's horizon against the experience log, which is the unit
//           every aggregate read multiplies; `list`, `summary` and `prompt` are the real store
//           paths. This phase is where the batch's dominant cost is either found or ruled out.
//   writes    one append in parts: the raw JSONL append, the uncontended write-lock section, a
//           prediction with and without citations, the same through the authorized action layer
//           (audit record plus independent re-read), an evaluation that judges and one that finds
//           nothing to judge, and a withdrawal.
//   contention  1, 2 and 4 real child processes appending predictions to one ledger from a shared
//           start, each reporting its own attempt duration from inside itself.
//   context   what the bounded expectation section adds to a prompt, and which requests pay for it.
//
// Both fixtures are written as records in the stores' own validated shape rather than through the
// write paths. Every read below validates every line, so a fixture seeded this way exercises the
// same reader a real log does, and the seeding cost stays out of the measurement. Each prediction
// record is checked with the ledger's own validator as it is produced, so a fixture line no reader
// would accept cannot quietly become a fast number.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { OperationLog } from '../src/operations/operation-log.js';
import { Outcome } from '../src/outcomes.js';
import {
  ExperienceStore, evidenceFromOperation, evidenceSha,
  EXPERIENCE_SCHEMA, EXPERIENCE_KIND,
} from '../src/experience/experience-store.js';
import { PredictionStore } from '../src/prediction/prediction-store.js';
import {
  PREDICTION_SCHEMA, PREDICTION_KIND, INVALIDATION_KIND, EVALUATION_KIND,
  deriveLimitations, projectLedger, validatePredictionRecord,
  MAX_PREDICTION_PROMPT_ITEMS,
} from '../src/prediction/prediction-engine.js';
import { buildPrompt, predictionPromptLines, predictionPromptRelevant, MAX_CONTEXT_CHARS } from '../src/controller/context.js';

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const CHILD_WRITER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'prediction-writer-child.mjs');

// One fixed instant for every fixture, so a horizon boundary cannot move between the seeding of a
// fixture and its measurement, and two runs of the same size measure the same bytes.
const CLOCK = () => new Date('2026-11-01T10:00:00.000Z');
const END_MS = CLOCK().getTime() - 3_600_000;
const SPAN_DAYS = 29;
const DAY_MS = 86_400_000;

// The ledger size matrix, each row against the same experience log, then two rows that hold the
// ledger still and move the experience log instead. A prediction read re-opens every horizon in the
// ledger, so both axes matter and neither can be reported alone.
const READ_MATRIX = [
  { predictions: 10, experiences: 1000 },
  { predictions: 50, experiences: 1000 },
  { predictions: 100, experiences: 1000 },
  { predictions: 200, experiences: 1000 },
  { predictions: 50, experiences: 100 },
  { predictions: 50, experiences: 5000 },
];
const WRITE_FIXTURE = { predictions: 50, experiences: 1000 };
const MAX_PREDICTIONS = 2000;
const MAX_EXPERIENCES = 10000;
const MAX_REPEATS = 25;
const WRITERS = [1, 2, 4];
const ATTEMPTS_PER_WRITER = 5;

function bounded(raw, min, max, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

function parseArgs(argv) {
  const opts = { repeats: 5, keep: false, phase: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--repeats') { opts.repeats = bounded(argv[i + 1], 1, MAX_REPEATS, '--repeats'); i += 1; }
    else if (arg === '--phase') {
      const name = argv[i + 1];
      if (!['reads', 'writes', 'contention', 'context'].includes(name)) throw new Error(`unknown phase ${name}`);
      opts.phase = name;
      i += 1;
    } else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

const dirs = [];
function tempDir(prefix = 'apex-bench-pred-') {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, prefix));
  dirs.push(dir);
  return dir;
}

function removeDir(dir) {
  const real = fs.realpathSync(dir);
  if (!real.startsWith(TMP_ROOT) || !path.basename(real).startsWith('apex-bench-')) {
    throw new Error(`refusing to remove non-benchmark directory: ${real}`);
  }
  fs.rmSync(real, { recursive: true, force: true });
}

async function copyDir(from) {
  const to = tempDir('apex-bench-copy-');
  await fsp.mkdir(to, { recursive: true });
  for (const name of await fsp.readdir(from)) {
    if (name.endsWith('.lock') || name.includes('.takeover.') || name.endsWith('.recover') || name.endsWith('.tmp')) continue;
    await fsp.copyFile(path.join(from, name), path.join(to, name));
  }
  return to;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    n: sorted.length,
  };
}

const ms = (value) => `${value.toFixed(2)} ms`;

async function timed(fn) {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
}

function header(cells) {
  console.log(`  ${cells.map(([label, width]) => label.padStart(width)).join('  ')}`);
}

function row(cells) {
  console.log(`  ${cells.map(([value, width]) => String(value).padStart(width)).join('  ')}`);
}

const byteCount = (value) => Number(value).toLocaleString('en-US');

// ---- fixtures ---------------------------------------------------------------

// An experience log of `n` events spread evenly over the 29 days ending an hour before CLOCK. One
// event in ten is refused before execution (a blocked outcome, so a different class), and events
// carry the audited capability the ledger's predictions are about, so a horizon that should contain
// outcome evidence does contain it.
function experienceRecords(n) {
  const step = n > 1 ? (END_MS - (END_MS - SPAN_DAYS * DAY_MS)) / (n - 1) : 0;
  const start = END_MS - SPAN_DAYS * DAY_MS;
  const records = [];
  for (let i = 0; i < n; i += 1) {
    const at = new Date(Math.round(start + step * i)).toISOString();
    const outcome = i % 10 === 3 ? Outcome.INPUT_REJECTED : Outcome.SUCCESS_VERIFIED;
    const operation = {
      capability: 'calc.evaluate',
      origin: 'user',
      status: outcome,
      decision: outcome === Outcome.SUCCESS_VERIFIED ? 'answer' : 'refuse_or_block',
      requestedAt: at,
      finishedAt: at,
      steps: [],
    };
    const evidence = evidenceFromOperation(operation);
    records.push({
      schema: EXPERIENCE_SCHEMA,
      kind: EXPERIENCE_KIND,
      id: randomUUID(),
      operationId: `bench-op-${i}`,
      capability: 'calc.evaluate',
      subject: `prediction benchmark event ${i}`,
      outcome,
      decision: operation.decision,
      origin: 'user',
      requestedAt: at,
      finishedAt: at,
      evidence,
      evidenceSha256: evidenceSha(evidence),
      adaptationEligible: true,
      createdAt: at,
      provenance: { origin: 'user_recorded', updateMode: 'user_confirmed' },
    });
  }
  return records;
}

// The ledger fixture: every lifecycle state the reader can report, because an aggregate read derives
// a state per record and a fixture of one shape would measure a ledger that does not exist.
//   - horizons half in the past and half in the future, so expiry and standing expectations coexist;
//   - one prediction in five cites recorded events that predate it, which is what makes the
//     lineage derivation do cross-store work rather than report an empty citation list;
//   - one in nine replaces an earlier expectation, so supersession links are derived;
//   - one in eleven carries a withdrawal;
//   - a fixed group carries a recorded verdict, so calibration has scored records to count.
function predictionRecords(n, experiences) {
  const start = END_MS - SPAN_DAYS * DAY_MS;
  const step = n > 1 ? (SPAN_DAYS * DAY_MS) / (n - 1) : 0;
  const lines = [];
  const ids = [];
  const byDay = experiences.map((record) => ({ id: record.id, ms: Date.parse(record.createdAt) }));
  for (let i = 0; i < n; i += 1) {
    const createdAtMs = Math.round(start + step * i);
    const createdAt = new Date(createdAtMs).toISOString();
    // Alternating horizons put roughly half the ledger past its horizon and leave the rest standing.
    const expiresAt = new Date(createdAtMs + (i % 2 === 0 ? 2 : 30) * DAY_MS).toISOString();
    const id = randomUUID();
    ids.push(id);
    const evidence = { supportingExperienceIds: [], contradictingExperienceIds: [], feedbackIds: [], patternKinds: [] };
    if (i % 5 === 2) {
      // Cite events that had already happened when the expectation was made: a citation dated later
      // than the record would be the retrospective evidence this batch exists to refuse.
      const before = byDay.filter((e) => e.ms <= createdAtMs);
      evidence.supportingExperienceIds = before.slice(-3).map((e) => e.id);
    }
    if (i % 7 === 3) evidence.patternKinds = ['repeated_success'];
    const record = {
      schema: PREDICTION_SCHEMA,
      kind: PREDICTION_KIND,
      id,
      createdAt,
      capability: 'calc.evaluate',
      expectation: i % 3 === 1 ? 'failure' : 'success',
      subject: `the next calc.evaluate run for expectation ${i} settles as expected`,
      expiresAt,
      confidence: null,
      evidence,
      evidenceBasis: evidence.supportingExperienceIds.length + evidence.contradictingExperienceIds.length
        + evidence.feedbackIds.length + evidence.patternKinds.length > 0 ? 'cited' : 'none_cited',
      limitations: [],
      provenance: { origin: 'user_recorded', updateMode: 'user_confirmed', operationId: `bench-rec-${i}` },
      ...(i % 9 === 4 && i > 0 ? { replaces: [ids[i - 1]] } : {}),
    };
    record.limitations = deriveLimitations(record);
    const problem = validatePredictionRecord(record);
    if (problem) throw new Error(`fixture prediction ${i} is not a valid record: ${problem}`);
    lines.push(JSON.stringify(record));

    if (i % 11 === 6) {
      const invalidation = {
        schema: PREDICTION_SCHEMA,
        kind: INVALIDATION_KIND,
        id: randomUUID(),
        predictionId: id,
        reason: `benchmark withdrawal ${i}: the condition the expectation assumed no longer holds`,
        createdAt: new Date(createdAtMs + 60_000).toISOString(),
        provenance: { origin: 'user_retirement', updateMode: 'user_confirmed', operationId: `bench-inv-${i}` },
      };
      const invalid = validatePredictionRecord(invalidation);
      if (invalid) throw new Error(`fixture withdrawal ${i} is not a valid record: ${invalid}`);
      lines.push(JSON.stringify(invalidation));
    }

    if (i % 8 === 1) {
      // A verdict whose deciding record really sits inside this horizon and is one of the outcome
      // ids, because a reader that cannot find its deciding evidence refuses the ledger.
      const inside = byDay.filter((e) => e.ms >= createdAtMs && e.ms <= Date.parse(expiresAt));
      const deciding = inside.at(-1) ?? byDay.find((e) => e.ms <= createdAtMs);
      if (deciding) {
        const evaluation = {
          schema: PREDICTION_SCHEMA,
          kind: EVALUATION_KIND,
          id: randomUUID(),
          predictionId: id,
          verdict: 'matched',
          createdAt: new Date(Date.parse(expiresAt) - 3_600_000).toISOString(),
          window: { since: createdAt, until: expiresAt },
          outcomeExperienceIds: [deciding.id],
          decidingExperienceId: deciding.id,
          decidingOccurredAt: new Date(deciding.ms).toISOString(),
          provenance: { origin: 'user_authorized_derivation', updateMode: 'user_confirmed', operationId: `bench-eval-${i}` },
        };
        const bad = validatePredictionRecord(evaluation);
        if (bad) throw new Error(`fixture evaluation ${i} is not a valid record: ${bad}`);
        lines.push(JSON.stringify(evaluation));
      }
    }
  }
  return lines;
}

// One fixture directory: an experience log of `E` events and a ledger of `P` predictions in every
// lifecycle state. Returned with the ids the write phases need.
async function buildFixture({ predictions, experiences }) {
  if (predictions > MAX_PREDICTIONS || experiences > MAX_EXPERIENCES) {
    throw new Error(`sizes above ${MAX_PREDICTIONS} predictions or ${MAX_EXPERIENCES} experiences are not supported here`);
  }
  const dir = tempDir();
  const seeded = await timed(() => {
    const events = experienceRecords(experiences);
    fs.writeFileSync(path.join(dir, 'experiences.jsonl'), `${events.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const ledger = predictionRecords(predictions, events);
    fs.writeFileSync(path.join(dir, 'predictions.jsonl'), `${ledger.join('\n')}\n`);
    return { events, ledger };
  });
  const store = storeOn(dir);
  const [status, experienceStatus] = await Promise.all([store.status(), experienceOn(dir).status()]);
  return {
    dir,
    predictions,
    experiences,
    bytes: fs.statSync(path.join(dir, 'predictions.jsonl')).size,
    experienceBytes: fs.statSync(path.join(dir, 'experiences.jsonl')).size,
    ledgerLines: seeded.result.ledger.length,
    seedMs: seeded.ms,
    status,
    experienceStatus,
    standingIds: seeded.result.ledger.length > 0 ? (await store.list({ limit: MAX_PREDICTIONS })).projections.map((p) => p.id) : [],
    eventIds: seeded.result.events.map((e) => e.id),
    store,
  };
}

function experienceOn(dir) {
  return new ExperienceStore(path.join(dir, 'experiences.jsonl'), {
    now: CLOCK,
    operations: new OperationLog(path.join(dir, 'operations.jsonl')),
  });
}

// Built exactly the way the application builds it: the ledger is given the experience log, because
// every horizon a reader reports is re-opened against it.
function storeOn(dir) {
  return new PredictionStore(path.join(dir, 'predictions.jsonl'), { now: CLOCK, experiences: experienceOn(dir) });
}

function appOn(dir) {
  return createApp({ dataDir: dir, gateway: new ModelGateway({ backend: new NoBackend() }), now: CLOCK });
}

// ---- reads ------------------------------------------------------------------

// `load` is the ledger's own whole-file read, hash, parse and per-record validation. `project` is
// the ledger derivation over those records with no experience read at all. `horizon` is one
// re-opening of one prediction's horizon against the experience log - the unit an aggregate read
// multiplies by the number of predictions. `list`, `history`, `summary` and `prompt` are the public
// reads, each on a fresh store instance, so each pays both.
async function phaseReads(opts) {
  console.log('\n== reads: what a ledger read costs, per ledger size and per experience-log size ==');
  for (const line of [
    '  load    = predictions.jsonl read, hash, parse and per-record validation',
    '  project = ledger derivation over those records, with no experience read',
    '  status  = the operational count read (ledger only; opens no horizon)',
    '  health  = the ledger health read (ledger only; opens no horizon)',
    '  horizon = ONE experience-log horizon read: whole-file read, lifecycle derivation, window slice, patterns',
    '  show    = store.detail(id): load + project + one horizon',
    '  list    = store.list(): load + project + one horizon per prediction in the ledger',
    '  warm    = the same list() again on the same instance',
    '  history = store.history(id): load + project + one horizon',
    '  summary = store.calibration(): load + project + one horizon per prediction',
    '  prompt  = store.promptView(): the bounded section a model context or the world projection reads',
  ]) console.log(line);
  header([
    ['predictions', 12], ['experiences', 12], ['lines', 8], ['bytes', 10], ['load', 10], ['project', 10],
    ['status', 9], ['health', 9], ['horizon', 10], ['show', 10], ['list', 11], ['warm', 10],
    ['history', 10], ['summary', 11], ['prompt', 11],
  ]);
  let previous = null;
  for (const size of READ_MATRIX) {
    const fixture = await buildFixture(size);
    const samples = {
      load: [], project: [], status: [], health: [], horizon: [], show: [], list: [], warm: [],
      history: [], summary: [], prompt: [],
    };
    const targetId = fixture.standingIds.find((id) => true) ?? null;
    for (let i = 0; i < opts.repeats; i += 1) {
      const store = storeOn(fixture.dir);
      const loaded = await store.log.load();
      samples.load.push((await timed(() => storeOn(fixture.dir).log.load())).ms);
      samples.project.push((await timed(() => projectLedger({
        records: loaded.records,
        nowMs: CLOCK().getTime(),
        evidenceFor: () => ({ available: false, reason: 'benchmark: no experience read' }),
      }))).ms);
      samples.status.push((await timed(() => store.status())).ms);
      samples.health.push((await timed(() => store.health())).ms);
      const projection = projectLedger({
        records: loaded.records, nowMs: CLOCK().getTime(), evidenceFor: () => null,
      }).projections.find((item) => item.id === targetId);
      const windowOf = loaded.records.find((r) => r.id === targetId);
      samples.horizon.push((await timed(() => experienceOn(fixture.dir).evidenceIndex({
        experienceIds: [...(windowOf.evidence.supportingExperienceIds ?? [])],
        feedbackIds: [],
        since: windowOf.createdAt,
        until: windowOf.expiresAt,
        capability: windowOf.capability,
      }))).ms);
      samples.show.push((await timed(() => storeOn(fixture.dir).detail(targetId))).ms);
      const listed = storeOn(fixture.dir);
      await listed.list({ limit: 50 });
      samples.warm.push((await timed(() => listed.list({ limit: 50 }))).ms);
      samples.list.push((await timed(() => storeOn(fixture.dir).list({ limit: 50 }))).ms);
      samples.history.push((await timed(() => storeOn(fixture.dir).history(targetId))).ms);
      samples.summary.push((await timed(() => storeOn(fixture.dir).calibration({}))).ms);
      samples.prompt.push((await timed(() => storeOn(fixture.dir).promptView({}))).ms);
      if (projection === undefined) throw new Error('the fixture produced no projection to read');
    }
    const cell = (key) => ms(stats(samples[key]).median);
    row([
      [size.predictions, 12], [size.experiences, 12], [fixture.ledgerLines, 8], [byteCount(fixture.bytes), 10],
      [cell('load'), 10], [cell('project'), 10], [cell('status'), 9], [cell('health'), 9],
      [cell('horizon'), 10], [cell('show'), 10], [cell('list'), 11], [cell('warm'), 10],
      [cell('history'), 10], [cell('summary'), 11], [cell('prompt'), 11],
    ]);
    console.log(`    ${size.predictions} prediction(s) / ${size.experiences} event(s): `
      + `${byteCount(fixture.bytes)} ledger bytes, ${byteCount(fixture.experienceBytes)} experience bytes, `
      + `seeded in ${ms(fixture.seedMs)}; ${fixture.status.live} standing, ${fixture.status.superseded} superseded, `
      + `${fixture.status.evaluations} verdict record(s), ${fixture.status.invalidations} withdrawal(s), `
      + `${fixture.status.pastHorizon} past horizon`);
    if (previous && previous.predictions === size.predictions && previous.experiences !== size.experiences) {
      const ratio = stats(samples.list).median / stats(previous.samples.list).median;
      console.log(`    experience log x${(size.experiences / previous.experiences).toFixed(0)}: list x${ratio.toFixed(1)} `
        + `(${ms(stats(previous.samples.list).median)} -> ${ms(stats(samples.list).median)})`);
    } else if (previous && previous.predictions !== size.predictions && previous.experiences === size.experiences) {
      const ratio = stats(samples.list).median / stats(previous.samples.list).median;
      console.log(`    ledger x${(size.predictions / previous.predictions).toFixed(0)}: list x${ratio.toFixed(1)} `
        + `(${ms(stats(previous.samples.list).median)} -> ${ms(stats(samples.list).median)})`);
    }
    previous = { predictions: size.predictions, experiences: size.experiences, samples };
  }
  console.log('  the ledger-only columns (`load`, `project`, `status`, `health`) grow with prediction');
  console.log('  records. `list`, `summary` and `prompt` open one horizon per standing prediction, but all');
  console.log('  of them from one snapshot of the experience log: the whole-file read, the per-record');
  console.log('  validation and the lifecycle derivation happen once per operation (roughly one `horizon`');
  console.log('  column), and what grows per prediction is the window slice and pattern detection over');
  console.log('  that shared log - the difference between `list` and `horizon` on each row.');
}

// ---- writes -----------------------------------------------------------------

async function phaseWrites(opts) {
  const fixture = await buildFixture(WRITE_FIXTURE);
  console.log('\n== writes: one prediction append in parts ==');
  for (const line of [
    '  append          = the raw JSONL append alone, inside no lock and with no read',
    '  lock            = store.writeLock.run(async () => {}): the uncontended coordination section',
    '  record          = recordPrediction with no citation: the write read of the whole ledger, the',
    '                    duplicate scan, the record, the append',
    '  record cited    = the same citing three recorded events: adds the cross-store citation read',
    '  record (action) = the authorized command through the controller: audit record, action, and an',
    '                    independent re-read of what was written',
    '  evaluate        = recordEvaluation on an expectation whose horizon holds a classifiable outcome',
    '  evaluate empty  = the same on an expectation whose horizon has not arrived yet: writes nothing,',
    '                    and still pays the locked read of the whole ledger and the one-horizon projection',
    '  invalidate      = invalidatePrediction: a withdrawal record naming one expectation and its reason',
  ]) console.log(line);
  header([
    ['operation', 16], ['median', 11], ['min', 11], ['max', 11], ['n', 5], ['records after', 13],
  ]);
  // One projection read picks every target, so the fixture is only walked once before measuring.
  const standing = (await fixture.store.list({ limit: MAX_PREDICTIONS })).projections;
  const judged = standing.find((item) => item.canRecordEvaluation);
  const withdrawable = standing.find((item) => item.invalidation === null
    && item.evaluation === null && !item.retired)?.id ?? null;
  // The refusal path needs an expectation with no outcome to judge. Standing expectations in this
  // fixture all have a horizon full of recorded events, so one is appended whose horizon is entirely
  // in the future: nothing has happened inside it, and nothing can be. Added before any copy, so
  // every cell below reads the same ledger.
  const unjudged = (await fixture.store.recordPrediction({
    capability: 'calc.evaluate', expectation: 'success',
    subject: 'a benchmark expectation whose horizon has not arrived',
    expiresAt: new Date(CLOCK().getTime() + 14 * DAY_MS).toISOString(),
    origin: 'user', provenance: { operationId: 'bench-target-empty' },
  })).record;
  const seeded = await fixture.store.status();
  const samples = { append: [], lock: [], record: [], cited: [], action: [], evaluate: [], refused: [], invalidate: [] };
  const after = { append: 0, lock: 0, record: 0, cited: 0, action: 0, evaluate: 0, refused: 0, invalidate: 0 };
  for (let i = 0; i < opts.repeats; i += 1) {
    // Every cell appends into its own copy of the same seeded ledger, so no cell can slow or
    // enlarge the ledger a later cell reads.
    const copy = await copyDir(fixture.dir);
    const store = storeOn(copy);
    const line = {
      schema: PREDICTION_SCHEMA, kind: PREDICTION_KIND, id: randomUUID(),
      createdAt: CLOCK().toISOString(), capability: 'calc.evaluate', expectation: 'success',
      subject: `a benchmark expectation appended directly into the ledger ${i}`,
      expiresAt: new Date(CLOCK().getTime() + 14 * DAY_MS).toISOString(), confidence: null,
      evidence: { supportingExperienceIds: [], contradictingExperienceIds: [], feedbackIds: [], patternKinds: [] },
      evidenceBasis: 'none_cited', limitations: [],
      provenance: { origin: 'user_recorded', updateMode: 'user_confirmed', operationId: `bench-append-${i}` },
    };
    line.limitations = deriveLimitations(line);
    samples.append.push((await timed(() => store.log.append(line))).ms);
    after.append = (await store.status()).records;

    const copy2 = await copyDir(fixture.dir);
    const s2 = storeOn(copy2);
    samples.lock.push((await timed(() => s2.writeLock.run(async () => {}))).ms);
    after.lock = (await s2.status()).records;

    const copy3 = await copyDir(fixture.dir);
    const s3 = storeOn(copy3);
    samples.record.push((await timed(() => s3.recordPrediction({
      capability: 'calc.evaluate', expectation: 'success',
      subject: `a benchmark expectation recorded without citations ${i}`,
      expiresAt: new Date(CLOCK().getTime() + 21 * DAY_MS).toISOString(), origin: 'user',
      provenance: { operationId: `bench-record-${i}` },
    }))).ms);
    after.record = (await s3.status()).records;

    const copy4 = await copyDir(fixture.dir);
    const s4 = storeOn(copy4);
    samples.cited.push((await timed(() => s4.recordPrediction({
      capability: 'calc.evaluate', expectation: 'success',
      subject: `a benchmark expectation citing recorded events ${i}`,
      expiresAt: new Date(CLOCK().getTime() + 21 * DAY_MS).toISOString(),
      evidence: { supportingExperienceIds: fixture.eventIds.slice(-3).map((id) => id.slice(0, 8)) },
      origin: 'user', provenance: { operationId: `bench-cite-${i}` },
    }))).ms);
    after.cited = (await s4.status()).records;

    const copy5 = await copyDir(fixture.dir);
    const target5 = appOn(copy5);
    samples.action.push((await timed(() => target5.controller.predictionRecord({
      capability: 'calc.evaluate', expectation: 'success',
      subject: `a benchmark expectation recorded through the action layer ${i}`,
      inDays: 14,
    }))).ms);
    after.action = (await target5.getStatus()).predictionRecords;

    if (judged) {
      const copy6 = await copyDir(fixture.dir);
      const s6 = storeOn(copy6);
      const done = await timed(() => s6.recordEvaluation({
        target: judged.id, origin: 'user', provenance: { operationId: `bench-evaluate-${i}` },
      }));
      samples.evaluate.push(done.ms);
      after.evaluate = (await s6.status()).records;
      if (done.result.record === null) console.log(`    sample ${i}: the judged expectation offered no verdict (${done.result.reason})`);
    }
    if (unjudged) {
      const copy7 = await copyDir(fixture.dir);
      const s7 = storeOn(copy7);
      samples.refused.push((await timed(() => s7.recordEvaluation({
        target: unjudged.id, origin: 'user', provenance: { operationId: `bench-refuse-${i}` },
      }))).ms);
      // The refusal writes nothing, so this total equals the seeded one.
      after.refused = (await s7.status()).records;
    }
    const copy8 = await copyDir(fixture.dir);
    const s8 = storeOn(copy8);
    samples.invalidate.push((await timed(() => s8.invalidatePrediction({
      target: withdrawable, reason: 'the benchmark condition no longer holds', origin: 'user',
      provenance: { operationId: `bench-invalidate-${i}` },
    }))).ms);
    after.invalidate = (await s8.status()).records;
  }
  const print = (label, key) => {
    const s = stats(samples[key]);
    row([[label, 16], [ms(s.median), 11], [ms(s.min), 11], [ms(s.max), 11], [s.n, 5], [after[key], 13]]);
  };
  print('append', 'append');
  print('lock', 'lock');
  print('record', 'record');
  print('record cited', 'cited');
  print('record (action)', 'action');
  if (judged) print('evaluate', 'evaluate');
  print('evaluate empty', 'refused');
  print('invalidate', 'invalidate');
  console.log(`  fixture: ${fixture.predictions} expectation(s) in ${seeded.records} record line(s) over `
    + `${fixture.experiences} experience event(s), plus the one appended as the "evaluate empty" target. `
    + '"records after" is the ledger total that cell produced, so the two cells that write nothing '
    + 'show the seeded count.');
  console.log('  `append` alone is a raw file write with no read: it is printed to bound the store-level');
  console.log('  write, not as an operation APEX offers. Nothing here reaches a model, and no ledger');
  console.log('  record is created by a read.');
}

// ---- contention -------------------------------------------------------------

function spawnWriter(dir, writer, capabilities, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      CHILD_WRITER, 'record', dir, String(writer), capabilities.join(','),
    ], { env, windowsHide: true });
    const results = [];
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk.toString();
      let nl;
      while ((nl = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, nl).trim();
        text = text.slice(nl + 1);
        if (line.startsWith('RESULT ')) {
          try { results.push(JSON.parse(line.slice(7))); } catch { /* a partial line is not a result */ }
        }
      }
    });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.on('close', (code) => resolve({ results, code, err }));
  });
}

async function phaseContention(opts) {
  const fixture = await buildFixture({ predictions: 10, experiences: 1000 });
  console.log('\n== contention: real processes appending to one ledger from a shared start ==');
  header([['writers', 8], ['wall', 11], ['accepted', 10], ['records', 9], ['ids', 6], ['attempt med', 13],
    ['attempt min', 12], ['attempt max', 12], ['refusals', 10], ['corrupt', 9], ['residue', 9]]);
  for (const writers of WRITERS) {
    const copy = await copyDir(fixture.dir);
    const before = await storeOn(copy).status();
    const env = {
      ...process.env,
      // The store each writer races into is named twice, in the argument and in the
      // environment, and isolation is requested so the two can never disagree about a real
      // user's directory: a writer that resolved the environment instead of its argument
      // would stop at startup rather than append to `~/.apex` during a measurement.
      APEX_DATA_DIR: copy,
      APEX_DATA_ISOLATED: '1',
      APEX_RACERS: String(writers),
      APEX_NOW: CLOCK().toISOString(),
      APEX_WAIT_MS: '10000',
    };
    const started = performance.now();
    const runs = await Promise.all(Array.from({ length: writers }, (_, w) => {
      const capabilities = Array.from({ length: ATTEMPTS_PER_WRITER }, (_, k) => `calc.evaluate.w${w}c${k}`);
      return spawnWriter(copy, w, capabilities, env);
    }));
    const wall = performance.now() - started;
    const results = runs.flatMap((r) => r.results);
    const accepted = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    const durations = accepted.map((r) => r.ms);
    const after = await storeOn(copy).status();
    const listed = await storeOn(copy).list({ limit: MAX_PREDICTIONS });
    const distinct = new Set(listed.projections.map((p) => p.id)).size;
    const residue = fs.readdirSync(copy).filter((name) => name.includes('.lock') || name.includes('.takeover') || name.endsWith('.tmp'));
    const s = stats(durations);
    row([
      [writers, 8], [ms(wall), 11], [`${accepted.length}/${results.length}`, 10], [after.records, 9],
      [distinct, 6], [ms(s.median), 13], [ms(s.min), 12], [ms(s.max), 12],
      [refused.length, 10], [after.corrupt, 9], [residue.length, 9],
    ]);
    if (refused.length > 0) {
      for (const r of refused.slice(0, 3)) console.log(`      refusal: ${r.code ?? ''} ${r.message}`);
    }
    console.log(`      ${before.records} record(s) seeded, ${after.records} after ${accepted.length} accepted write(s), `
      + `${after.live} standing / ${after.superseded} superseded, ${after.confidenceValues} confidence value(s) `
      + `(must be 0), exit codes ${runs.map((r) => r.code).join(',')}`);
  }
  console.log('  each attempt is timed from inside its own process and excludes that process\'s start-up;');
  console.log('  wall time includes it. A refusal writes nothing, so `records` must equal the seeded count');
  console.log('  plus the accepted attempts on every row. Node start-up on this machine is several hundred');
  console.log('  milliseconds per child, which is why the wall column is not comparable to the attempt columns.');
}

// ---- context ----------------------------------------------------------------

async function phaseContext(opts) {
  const fixture = await buildFixture({ predictions: 200, experiences: 1000 });
  console.log('\n== context: what the bounded expectation section adds, and which requests pay for it ==');
  const view = await fixture.store.promptView({});
  const section = predictionPromptLines(view);
  // One request the user's own words made prediction-shaped, and the same prompt without the
  // section, measured in the same process on the same fixture: the difference is the section. The
  // control holds the request constant on both sides, so what it measures is the gate and not the
  // length of two different requests.
  const RELEVANT = 'did any of my recorded expectations come true';
  const IRRELEVANT = 'what is 6 times 7';
  const assembled = (request, extra) => buildPrompt({
    request, memoryHits: [], turns: [], ...extra,
  }).prompt;
  const base = assembled(RELEVANT, {});
  const withSection = assembled(RELEVANT, { predictions: view });
  const unavailable = assembled(RELEVANT, { predictions: null, predictionsUnavailable: true });
  const irrelevantBase = assembled(IRRELEVANT, {});
  const irrelevantWithSection = assembled(IRRELEVANT, { predictions: view });
  console.log(`  ledger: ${fixture.status.records} record line(s), ${fixture.status.live} standing expectation(s)`);
  console.log(`  section: ${section.length} line(s), ${section.join('\n').length} characters, `
    + `named items ${(view.active ?? []).length} of ${view.counts?.live ?? 0} standing (bound ${MAX_PREDICTION_PROMPT_ITEMS})`);
  console.log(`  base prompt ${base.length} characters; with the section ${withSection.length} `
    + `(+${withSection.length - base.length}, ${(((withSection.length - base.length) / MAX_CONTEXT_CHARS) * 100).toFixed(1)}% of the `
    + `${MAX_CONTEXT_CHARS}-character budget)`);
  console.log(`  an unreadable ledger is one sentence: ${unavailable.length - base.length} character(s) added, `
    + `and it says the ledger could not be read rather than that no expectation exists`);
  console.log(`  the same section on a request the words did not make prediction-shaped: `
    + `${irrelevantWithSection.length - irrelevantBase.length} character(s) added (0 means the gate held), `
    + `on a ${irrelevantBase.length}-character base`);
  console.log(`  a ${fixture.status.records}-line ledger still contributes ${section.length} line(s), because the`);
  console.log(`  section names at most ${MAX_PREDICTION_PROMPT_ITEMS} standing expectations and counts the rest.`);

  // What the read behind that section costs, as the controller and the world command make it.
  const samples = [];
  for (let i = 0; i < opts.repeats; i += 1) {
    samples.push((await timed(() => storeOn(fixture.dir).promptView({}))).ms);
  }
  const s = stats(samples);
  console.log(`  promptView() on this ${fixture.status.records}-line ledger: ${ms(s.median)} median `
    + `(${ms(s.min)} min, ${ms(s.max)} max) over ${s.n} samples`);
  const small = await buildFixture({ predictions: 10, experiences: 1000 });
  const smallView = await small.store.promptView({});
  const smallSamples = [];
  for (let i = 0; i < opts.repeats; i += 1) {
    smallSamples.push((await timed(() => storeOn(small.dir).promptView({}))).ms);
  }
  console.log(`  the same call on a ${small.status.records}-line ledger (${smallView.counts.live} standing): `
    + `${ms(stats(smallSamples).median)} median - the section names at most ${MAX_PREDICTION_PROMPT_ITEMS} `
    + 'expectations at either size, so its size is fixed while its read cost is not');
  console.log('  No model is contacted: every prompt above is assembled and measured offline, and the');
  console.log('  section carries counts and status only - never a subject, reason, or evidence text.');
}

// ---- run --------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node benchmarks/run-prediction-benchmark.mjs [--repeats R] [--phase reads|writes|contention|context] [--keep]');
  console.log('  model-free; writes only into a fresh temporary data directory; not part of npm test');
} else {
  console.log(`node ${process.version} on ${process.platform} ${process.arch}, `
    + `${os.cpus().length} logical CPU(s), ${Math.round(os.totalmem() / 1073741824)} GiB reported memory`);
  console.log(`clock fixed at ${CLOCK().toISOString()}, fixtures spread over ${SPAN_DAYS} days ending an hour before it; `
    + `repeats ${opts.repeats}`);
  console.log('no model, no network, no inference: every application here is built with NoBackend and no');
  console.log('read below asks one. The experience log is seeded as records in its own validated shape,');
  console.log('and every ledger line is checked by the ledger validator as the fixture is written.');
  try {
    if (!opts.phase || opts.phase === 'reads') await phaseReads(opts);
    if (!opts.phase || opts.phase === 'writes') await phaseWrites(opts);
    if (!opts.phase || opts.phase === 'contention') await phaseContention(opts);
    if (!opts.phase || opts.phase === 'context') await phaseContext(opts);
  } finally {
    if (opts.keep) {
      console.log(`\nkept: ${dirs.join(', ')}`);
    } else {
      for (const dir of dirs) removeDir(dir);
      console.log('\ntemporary data directories removed; nothing outside them was written.');
    }
  }
}
