// Bounded, model-free T-15 benchmark: what the situational event a document ingest emits costs,
// and what a situational read costs, at progressive log sizes.
//
// The T-14 benchmark disclosed that a document ingest emits one situational event per new, changed
// or failed document, and that each emit reads and reduces the whole append-only situational log.
// This script measures that share directly, in one process, at three prior-log sizes, with the emit
// enabled and disabled on identical documents. It also measures a cold and a warm situational read
// on the same store, so the parse snapshot's effect is visible rather than remembered.
//
// Nothing here is a target. Every figure is wall-clock time on this machine, in this process, at this
// moment; conditions are compared only within the run. No inference is used or authorized: no
// backend, socket, or child process is constructed. Nothing is downloaded or started.
//
// The synthetic prior log is built by cloning one real event/assessment pair written by the real
// service, with fresh ids and a recomputed payload fingerprint, so the file is structurally valid and
// the measuring run pays only the reads and appends it is measuring.
//
// Isolation: every content root and data directory is created with mkdtemp under the OS temporary
// directory with the `apex-bench-t15-` prefix, and cleanup refuses any path outside that root or
// without that prefix. APEX_DATA_ISOLATED must be unset or 1; any other value is refused.
//
// Do not run this benchmark at the same time as the test suite, or as another benchmark.
// Nothing here is part of `npm test`.
//
//   APEX_DATA_ISOLATED=1 node benchmarks/run-t15-situational-ingest-benchmark.mjs [--rows 0,1000,4000] [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { DocumentService } from '../src/documents/service.js';
import { SituationService } from '../src/situational/service.js';
import { SituationStore } from '../src/situational/store.js';
import { fingerprintOf } from '../src/situational/model.js';

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const DIR_PREFIX = 'apex-bench-t15-';
const DOCS = 20;
const AT = '2026-01-05T09:00:00.000Z';

const isolation = (process.env.APEX_DATA_ISOLATED ?? '').trim();
if (isolation !== '' && isolation !== '1') {
  throw new Error(`APEX_DATA_ISOLATED must be unset or 1, not ${JSON.stringify(isolation)}`);
}

const keep = process.argv.includes('--keep');
const rowsFlag = process.argv.indexOf('--rows');
const rowSizes = rowsFlag > -1 && process.argv[rowsFlag + 1]
  ? process.argv[rowsFlag + 1].split(',').map((value) => Number(value.trim()))
  : [0, 1000, 4000];
if (rowSizes.some((rows) => !Number.isInteger(rows) || rows < 0 || rows % 2 !== 0)) {
  throw new Error('--rows must be a comma-separated list of non-negative even row counts');
}

const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - String(s).length))}`;
const ms = (n) => `${(Math.round(n * 1000) / 1000).toFixed(3)}`;
const ratio = (a, b) => (b > 0 ? `${(a / b).toFixed(2)}x` : 'n/a');

const dirs = [];
const checks = [];
function check(ok, message) {
  checks.push({ ok: Boolean(ok), message });
  if (!ok) console.log(`  FAIL ${message}`);
}

function makeRoot(label) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `${DIR_PREFIX}${label}-`));
  dirs.push(dir);
  return dir;
}

function removeDir(dir) {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(`${TMP_ROOT}${path.sep}`) || !path.basename(resolved).startsWith(DIR_PREFIX)) {
    throw new Error(`refusing to remove ${resolved}: not a ${DIR_PREFIX} directory under the temp root`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function makeDocs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < DOCS; i += 1) {
    fs.writeFileSync(path.join(dir, `note-${String(i).padStart(4, '0')}.md`), [
      `# Supplier note ${i}`, '', `Owner: team-${i % 7}`, `Reference: REF-${1000 + i}`,
      `Status: ${i % 3 === 0 ? 'open' : 'closed'}`, '',
      `Paragraph ${i}: the contract review for lot ${i} was completed on day ${i % 28 + 1}.`,
      `Paragraph ${i}: the warehouse reported stock level ${i * 3 % 97} units.`, '',
      '## Follow-up', '', `The office manager confirmed the schedule for lot ${i} remains unchanged.`,
    ].join('\n'));
  }
}

function countLines(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

function uuid(prefix, i) {
  return `${prefix}-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

// One real pair, written by the service under a fixed clock, becomes the shape of every cloned pair.
async function templatePair(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const store = new SituationStore(path.join(dir, 'situational.jsonl'), { now: () => new Date(AT) });
  const service = new SituationService({ store, now: () => new Date(AT) });
  await service.ingest({
    source: 'user', sourceEventId: 'template', type: 'observation', category: 'observation',
    payload: { summary: 'template observation' }, confidence: 0.8,
    entityRefs: [], goalRefs: [], planRefs: [], taskRefs: [],
  });
  const [event, assessment] = fs.readFileSync(store.filePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { event, assessment, storePath: store.filePath };
}

function buildLog({ event, assessment }, pairs) {
  const lines = [];
  for (let i = 0; i < pairs; i += 1) {
    const eventId = uuid('2a000000', i);
    const payload = { ...event.payload, summary: `seeded observation ${i} for lot ${i % 50}` };
    const fingerprint = fingerprintOf(payload);
    lines.push(JSON.stringify({
      ...event, id: eventId, source: 'user', sourceEventId: `seeded-${i}`,
      observedAt: AT, ingestedAt: AT, payload, fingerprint,
      integrity: { ...event.integrity, digest: fingerprint }, at: AT,
    }));
    lines.push(JSON.stringify({
      ...assessment, id: uuid('3b000000', i), assessmentId: uuid('3b000000', i), eventId, at: AT,
    }));
  }
  return `${lines.join('\n')}\n`;
}

async function ingestOnce({ emit, priorRows, template, label }) {
  const dir = makeRoot(label);
  const docsDir = path.join(dir, 'docs');
  const dataDir = path.join(dir, 'data');
  makeDocs(docsDir);
  fs.mkdirSync(dataDir, { recursive: true });
  let situation = null;
  let store = null;
  let logPath = path.join(dataDir, 'situational.jsonl');
  if (emit) {
    if (priorRows > 0) fs.writeFileSync(logPath, buildLog(template, priorRows / 2));
    store = new SituationStore(logPath);
    situation = new SituationService({ store });
  }
  const docs = new DocumentService({ dataDir, situation });
  await docs.configure({ roots: [docsDir] });
  await docs.enable();
  const started = performance.now();
  const report = await docs.ingest();
  const elapsed = performance.now() - started;
  return { elapsed, report, emittedRows: emit ? countLines(logPath) : 0 };
}

const templateDir = makeRoot('template');
const template = await templatePair(templateDir);

console.log('situational emit inside a document ingest, current tree');
console.log(`  ${DOCS} new markdown documents per condition; emit off is the extraction/index floor`);
console.log(`  ${pad('prior rows', 12)}${pad('floor ms', 12)}${pad('emit ms', 12)}${pad('emit share', 12)}${pad('share/event', 14)}emit/floor`);

const byRows = [];
for (let index = 0; index < rowSizes.length; index += 1) {
  const priorRows = rowSizes[index];
  // The first condition alternates so neither side always pays the cold page cache.
  const first = index % 2 === 0 ? 'floor' : 'emit';
  let floor = null;
  let emit = null;
  for (const mode of first === 'floor' ? ['floor', 'emit'] : ['emit', 'floor']) {
    const run = await ingestOnce({
      emit: mode === 'emit', priorRows, template, label: `${mode}-${priorRows}`,
    });
    if (mode === 'floor') floor = run; else emit = run;
    check(run.report.indexed === DOCS, `${mode} at ${priorRows} prior rows: indexed ${run.report.indexed} of ${DOCS}`);
    check(run.report.failed === 0, `${mode} at ${priorRows} prior rows: ${run.report.failed} failure(s)`);
    if (mode === 'emit') {
      check(run.emittedRows === priorRows + DOCS * 2,
        `emit at ${priorRows} prior rows: ${run.emittedRows} situational rows, expected ${priorRows + DOCS * 2}`);
    } else {
      check(run.emittedRows === 0, `floor at ${priorRows} prior rows: a situational log was written`);
    }
  }
  const share = emit.elapsed - floor.elapsed;
  byRows.push({ priorRows, floorMs: floor.elapsed, emitMs: emit.elapsed, shareMs: share });
  console.log(`  ${pad(priorRows, 12)}${pad(ms(floor.elapsed), 12)}${pad(ms(emit.elapsed), 12)}${pad(ms(share), 12)}${pad(ms(share / (DOCS * 2)), 14)}${ratio(emit.elapsed, floor.elapsed)}`);
}
const firstRow = byRows[0];
const lastRow = byRows[byRows.length - 1];
if (byRows.length > 1) {
  console.log(`  emit share grows with the log: ${ms(lastRow.shareMs)} at ${lastRow.priorRows} prior rows`
    + ` vs ${ms(firstRow.shareMs)} at ${firstRow.priorRows} (${ratio(lastRow.shareMs, firstRow.shareMs)})`);
}
console.log('');

console.log('one situational read on the same store, current tree');
console.log(`  ${pad('rows', 10)}${pad('file bytes', 14)}${pad('cold load', 12)}${pad('warm load', 12)}${pad('warm/cold', 12)}cache hits`);
for (const rows of rowSizes.filter((value) => value > 0)) {
  const dir = makeRoot(`read-${rows}`);
  const file = path.join(dir, 'situational.jsonl');
  fs.writeFileSync(file, buildLog(template, rows / 2));
  const store = new SituationStore(file);
  const coldStart = performance.now();
  const cold = await store.load();
  const coldMs = performance.now() - coldStart;
  const warmStart = performance.now();
  const warm = await store.load();
  const warmMs = performance.now() - warmStart;
  const stats = store.log.parseCacheStats;
  check(cold.records.length === rows, `cold read at ${rows} rows returned ${cold.records.length} records`);
  check(warm.records.length === rows, `warm read at ${rows} rows returned ${warm.records.length} records`);
  check(stats.hits >= 1, `warm read at ${rows} rows did not use the parse snapshot`);
  console.log(`  ${pad(rows, 10)}${pad(fs.statSync(file).size, 14)}${pad(ms(coldMs), 12)}${pad(ms(warmMs), 12)}${pad(ratio(warmMs, coldMs), 12)}${stats.hits}`);
}
console.log('');
console.log('what this run cannot prove:');
console.log('  - it is not a statistical benchmark: one sample per condition on one machine at one moment;');
console.log('  - the prior log is synthetic but structurally valid; it exercises parse, reduce and append,');
console.log('    not assessment quality, which the T-09 tests cover;');
console.log('  - the emit share is dominated at small logs by fixed per-event costs (two writer-locked,');
console.log('    fsynced appends), so a small-log ratio near 1 is expected and is not a failure;');
console.log('  - the cold read includes populating the parse snapshot; the warm read reuses unchanged');
console.log('    bytes. Neither number is a claim about a restart, which has no snapshot to reuse;');
console.log('  - no inference, provider, socket or child process was used; model-free behaviour only.');

if (!keep) {
  for (const dir of dirs) removeDir(dir);
  console.log(`\nremoved ${dirs.length} temporary director${dirs.length === 1 ? 'y' : 'ies'}`);
} else {
  console.log(`\n--keep: left ${dirs.length} temporary director${dirs.length === 1 ? 'y' : 'ies'}:`);
  for (const dir of dirs) console.log(`  ${dir}`);
}

const failed = checks.filter((entry) => !entry.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${checks.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`\nall ${checks.length} checks passed`);
}
