// Bounded, model-free T-14 resource benchmark: document ingestion and evidence reads under growth.
//
// Two questions, measured rather than asserted:
//   1. what a complete document ingest costs when the authorized root holds 100 / 1000 / 5000 files,
//      what the documented caps do at those sizes (maxFiles bounds the scan, maxDocuments bounds the
//      index), what an unchanged re-ingest and a burst of edits cost, and what repeated extraction
//      failures do to the log;
//   2. what a complete request and a T-13 reasoning session cost when the memory store holds
//      100 / 1000 / 5000 evidence records, beside the retrieval stage alone.
//
// Nothing here is a target. Every figure is wall-clock time on this machine, in this process, at this
// moment. Cross-size and cross-condition comparisons are printed as in-run ratios from one run; no
// remembered number from an earlier run is compared against. No inference is used or authorized:
// every application is built with NoBackend, which is constructed and never contacted. Nothing is
// downloaded or started. The T-13 session is written, so a session count appears in the store; that
// is the real path, not a defect.
//
// Isolation: every content root and data directory is created with mkdtemp under the OS temporary
// directory with the `apex-bench-t14-` prefix, and cleanup refuses any path outside that root or
// without that prefix. APEX_DATA_ISOLATED must be unset or 1; any other value is refused.
//
// Do not run this benchmark at the same time as the test suite, or as another benchmark.
// Nothing here is part of `npm test`.
//
//   APEX_DATA_ISOLATED=1 node benchmarks/run-t14-scale-benchmark.mjs [--sizes 100,1000,5000] [--repeats R] [--keep]
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
import { LIMITS } from '../src/documents/vocabulary.js';
import { BOUNDS } from '../src/reasoning/vocabulary.js';
import { retrieveEvidence } from '../src/cognition/evidence.js';
import { understandRequest } from '../src/cognition/request.js';

const MAX_REPEATS = 5;
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const DIR_PREFIX = 'apex-bench-t14-';
const QUERY = 'what does the T14 benchmark note say about the lighthouse status?';
const MAX_SIZES = [100, 1000, 5000];

const isolation = (process.env.APEX_DATA_ISOLATED ?? '').trim();
if (isolation !== '' && isolation !== '1') {
  throw new Error(`APEX_DATA_ISOLATED must be unset or 1, not ${JSON.stringify(isolation)}`);
}

const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - String(s).length))}`;
const ms = (n) => `${(Math.round(n * 1000) / 1000).toFixed(3)}`;
const mib = (n) => `${(n / (1024 ** 2)).toFixed(1)} MiB`;
const ratio = (a, b) => (b > 0 ? `${(a / b).toFixed(2)}x` : 'n/a');

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const line = (label, samples) => `  ${pad(label, 60)} ${pad(ms(median(samples)), 10)}ms min ${pad(ms(Math.min(...samples)), 10)}ms`
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

async function timedOnce(fn) {
  const started = performance.now();
  const value = await fn();
  return { samples: [performance.now() - started], value, total: performance.now() - started };
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

function clock(start = '2026-11-17T09:00:00.000Z') {
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
const bytesOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };

// Small deterministic markdown files. No `key: value` lines, so no knowledge candidates are derived
// and the measurement stays on ingestion and the version index rather than on a second store's writes.
function writeNote(root, index, body = null) {
  const text = body ?? `# Note ${index}\nthe lighthouse status is steady for record ${index}\ndeterministic t14 scale fixture line\n`;
  fs.writeFileSync(path.join(root, `note-${String(index).padStart(5, '0')}.md`), text);
}

function makeDocuments(root, count) {
  const started = performance.now();
  for (let i = 0; i < count; i += 1) writeNote(root, i);
  return performance.now() - started;
}

function syntheticMemory(from, count, tag = 'T14') {
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

function seedMemory(dataDir, count) {
  fs.writeFileSync(path.join(dataDir, 'memory.jsonl'), `${syntheticMemory(0, count).join('\n')}\n`);
}

const repeats = Math.min(Math.max(1, Number(arg('repeats', 3)) || 3), MAX_REPEATS);
const sizes = String(arg('sizes', MAX_SIZES.join(','))).split(',')
  .map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);

console.log(`T-14 scale benchmark: ${os.platform()} ${os.arch()}, Node ${process.version}`);
console.log(`host: ${os.cpus()[0]?.model ?? 'unknown CPU'}, ${(os.totalmem() / (1024 ** 3)).toFixed(1)} GiB total memory`);
console.log('deterministic and model-free: NoBackend is constructed and never contacted, nothing is inferred');
console.log(`isolation: every content root and data directory is under ${TMP_ROOT} with the ${DIR_PREFIX} prefix;`
  + ` cleanup refuses anything else (APEX_DATA_ISOLATED=${isolation || 'unset'})`);
console.log('run this alone: concurrent tests or another benchmark would change every wall-clock figure below\n');
console.log(`repeats: ${repeats} per repeated condition; first-ingest and burst rows are single samples and are labelled`);
console.log(`document bounds in force: maxFiles ${LIMITS.maxFiles} per scan, maxDocuments ${LIMITS.maxDocuments} per index,`
  + ` maxVersions ${LIMITS.maxVersions} per document, maxFileBytes ${LIMITS.maxFileBytes}`);
console.log(`reasoning bounds in force: ${BOUNDS.maxEvidence} evidence records per session, ${BOUNDS.maxEvidencePerSource} per source\n`);

const failed = [];
let checksRun = 0;
const check = (condition, message) => { checksRun += 1; if (!condition) failed.push(message); };
const docRows = [];
const evRows = [];

// ---- section one: document ingestion under growth ----------------------------------------------
console.log('### documents: one authorized root, markdown notes, complete ingest through the service');
console.log('the runtime calls ingest(); the scan is capped by maxFiles, so files beyond the cap are never read');
console.log('');
for (const size of sizes) {
  const contentDir = tempDir();
  const dataDir = tempDir();
  const creationMs = makeDocuments(contentDir, size);
  const now = clock();
  const app = await appIn(dataDir, now);
  const cap = Math.min(size, LIMITS.maxFiles);
  const configured = await app.documents.configure({ roots: [contentDir], extensions: ['md'], maxFiles: cap });
  check(configured.config.maxFiles === cap, `${size} files: maxFiles was not configured to ${cap}`);
  await app.documents.enable();

  const heapBefore = process.memoryUsage();
  const first = await timedOnce(() => app.documents.ingest());
  const heapAfter = process.memoryUsage();
  const report = first.value;
  now.advance(1);
  const repeat = await timed(() => app.documents.ingest(), repeats);
  const search = await timed(() => app.documents.search('lighthouse status', { limit: 10 }), 3);
  const status = await timed(() => app.documents.status(), 3);

  // A burst: ten indexed documents change, the rest do not.
  const burstCount = Math.min(10, cap);
  for (let i = 0; i < burstCount; i += 1) writeNote(contentDir, i, `# Note ${i}\nthe lighthouse status now reads changed for record ${i}\nburst edit\n`);
  now.advance(1);
  const burst = await timedOnce(() => app.documents.ingest());

  const expectedIndexed = cap;
  check(report.status === 'ingested', `${size} files: first ingest did not finish: ${report.status} ${report.reason ?? ''}`);
  check(report.indexed === expectedIndexed, `${size} files: expected ${expectedIndexed} indexed, got ${report.indexed}`);
  check(report.truncated === (size > LIMITS.maxFiles), `${size} files: scan truncation was ${report.truncated}`);
  check(report.limited === 0, `${size} files: unexpected document-limit skip with maxFiles=${cap}`);
  check(repeat.value.changed === 0, `${size} files: an unchanged re-ingest appended versions`);
  check(repeat.value.indexed === 0, `${size} files: an unchanged re-ingest re-indexed documents`);
  check(search.value.length > 0, `${size} files: the search found no indexed document`);
  check(status.value.documents === expectedIndexed, `${size} files: status counted ${status.value.documents} documents, expected ${expectedIndexed}`);
  check(burst.value.changed === burstCount, `${size} files: the burst changed ${burst.value.changed}, expected ${burstCount}`);

  const row = {
    size,
    cap,
    truncated: report.truncated,
    indexed: report.indexed,
    observed: report.observed,
    firstMs: first.total,
    repeatMs: repeat.total,
    searchMs: search.total,
    statusMs: status.total,
    burstMs: burst.total,
    burstChanged: burst.value.changed,
    creationMs,
    documentsLogBytes: bytesOf(path.join(dataDir, 'documents.jsonl')),
    situationalLogBytes: bytesOf(path.join(dataDir, 'situational.jsonl')),
    heapDelta: heapAfter.heapUsed - heapBefore.heapUsed,
    rssAfter: heapAfter.rss,
  };
  docRows.push(row);

  console.log(`  files on disk ${size}, scan cap ${cap}, scanned ${cap}, indexed ${report.indexed}, truncated ${report.truncated}`);
  console.log(`  ${pad('fixture creation (outside every measurement)', 60)} ${ms(creationMs)}ms`);
  console.log(`  ${pad('COMPLETE ingest, first (single sample)', 60)} ${ms(first.total)}ms  changed ${report.changed}, failed ${report.failed}, deleted ${report.deleted}`
    + `  (${ms(first.total / report.indexed)}ms per indexed document)`);
  console.log(line('COMPLETE ingest, unchanged repeat', repeat.samples));
  console.log(line('documents.search (read-only)', search.samples));
  console.log(line('documents.status (read-only)', status.samples));
  console.log(`  ${pad(`COMPLETE ingest after ${burstCount} changed documents (single sample)`, 60)} ${ms(burst.total)}ms  changed ${burst.value.changed}`);
  console.log(`  ${pad('store and memory after this row', 60)} documents.jsonl ${(row.documentsLogBytes / 1024).toFixed(1)} KiB,`
    + ` situational.jsonl ${(row.situationalLogBytes / 1024).toFixed(1)} KiB, heap ${mib(row.heapDelta)} delta (no forced GC), RSS ${mib(row.rssAfter)}`);
  console.log('');
}

// ---- section two: repeated extraction failures --------------------------------------------------
console.log('### documents: repeated extraction failures on an unchanged root');
console.log('maxBytes is set below twenty of the files, so each of them fails extraction. A failure that has');
console.log('not changed is not appended again; the log is expected to stay byte-identical across repeats.');
{
  const contentDir = tempDir();
  const dataDir = tempDir();
  for (let i = 0; i < 40; i += 1) {
    if (i < 20) writeNote(contentDir, i, `# Note ${i}\n${'x'.repeat(4096)}\n`);
    else writeNote(contentDir, i);
  }
  const now = clock();
  const app = await appIn(dataDir, now);
  await app.documents.configure({ roots: [contentDir], extensions: ['md'], maxFiles: 40, maxBytes: 1024 });
  await app.documents.enable();
  const first = await timedOnce(() => app.documents.ingest());
  const bytesAtFirst = bytesOf(path.join(dataDir, 'documents.jsonl'));
  now.advance(1);
  const repeat = await timed(() => app.documents.ingest(), repeats);
  const bytesAtRepeat = bytesOf(path.join(dataDir, 'documents.jsonl'));
  now.advance(1);
  for (let i = 20; i < 25; i += 1) writeNote(contentDir, i, `# Note ${i}\nthe lighthouse status now reads changed for record ${i}\n`);
  const changed = await timedOnce(() => app.documents.ingest());
  const bytesAfterChanged = bytesOf(path.join(dataDir, 'documents.jsonl'));

  check(first.value.failed === 20, `failure burst: expected 20 failed extraction records, got ${first.value.failed}`);
  check(first.value.indexed === 20, `failure burst: expected 20 indexed records, got ${first.value.indexed}`);
  check(repeat.value.failed === 0, `failure burst: an unchanged failure was appended again (${repeat.value.failed})`);
  check(bytesAtRepeat === bytesAtFirst, 'failure burst: the log grew during unchanged repeated failures');
  check(changed.value.changed === 5, `failure burst: expected 5 changed documents, got ${changed.value.changed}`);
  check(bytesAfterChanged > bytesAtRepeat, 'failure burst: a real content change appended no record');

  console.log(`  ${pad(`first ingest: ${first.value.indexed} indexed, ${first.value.failed} failed (single sample)`, 60)} ${ms(first.total)}ms`);
  console.log(line('unchanged repeat: failures are not re-appended', repeat.samples));
  console.log(`  ${pad('log bytes: first / after repeats / after 5 edits', 60)} ${bytesAtFirst} / ${bytesAtRepeat} / ${bytesAfterChanged}`);
  console.log(`  ${pad('failed count on an unchanged repeat', 60)} ${repeat.value.failed}`);
  console.log('');
}

// ---- section three: evidence reads under growth -------------------------------------------------
console.log('### evidence: memory store seeded directly, then complete requests and a T-13 session');
console.log(`reasoning reads at most ${BOUNDS.maxEvidence} evidence records (${BOUNDS.maxEvidencePerSource} per source),`);
console.log('so growth in the store is expected to cost retrieval, not reasoning depth');
console.log('');
for (const size of sizes) {
  const dataDir = tempDir();
  seedMemory(dataDir, size);
  const now = clock();
  const app = await appIn(dataDir, now);
  const understanding = understandRequest({ request: QUERY, now: now() });
  const stores = {
    memory: app.memory,
    knowledge: app.knowledge,
    experience: app.experience,
    predictions: app.predictions,
    goals: app.goals,
    plans: app.plans,
    tasks: app.taskStore,
  };
  const heapBefore = process.memoryUsage();
  const retrieval = await timed(() => retrieveEvidence({
    request: QUERY, understanding, now: now(), stores,
  }), 3);
  const complete = await timed(() => app.controller.handle(QUERY, { origin: 'user' }), repeats);
  const reasoning = await timed(() => app.controller.reasoningStart({ request: QUERY }), repeats);
  const heapAfter = process.memoryUsage();

  const completeStatus = complete.value.status;
  const reasoningStatus = reasoning.value.status;
  const sessionId = data(reasoning.value).sessionId;
  const evidenceRead = await app.controller.reasoningEvidence({ session: sessionId });
  const hypothesesRead = await app.controller.reasoningHypotheses({ session: sessionId });
  const evidenceItems = data(evidenceRead).evidence?.items ?? [];
  const hypotheses = data(hypothesesRead).hypotheses ?? [];

  check([Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_DETERMINISTIC].includes(completeStatus),
    `${size} records: the complete request finished ${completeStatus}`);
  check(reasoningStatus === Outcome.SUCCESS_VERIFIED, `${size} records: the reasoning session finished ${reasoningStatus}`);
  check(evidenceItems.length > 0, `${size} records: the reasoning session cited no evidence`);
  check(evidenceItems.length <= BOUNDS.maxEvidence,
    `${size} records: the reasoning session exceeded its evidence bound (${evidenceItems.length})`);
  check(retrieval.value?.counts?.total > 0, `${size} records: retrieval returned no evidence`);

  const row = {
    size,
    retrievalMs: retrieval.total,
    completeMs: complete.total,
    reasoningMs: reasoning.total,
    retrieved: retrieval.value?.counts?.total ?? 0,
    dropped: retrieval.value?.counts?.dropped ?? 0,
    cited: evidenceItems.length,
    hypotheses: hypotheses.length,
    completeStatus,
    memoryLogBytes: bytesOf(path.join(dataDir, 'memory.jsonl')),
    heapDelta: heapAfter.heapUsed - heapBefore.heapUsed,
  };
  evRows.push(row);

  console.log(`  memory records ${size}, memory.jsonl ${(row.memoryLogBytes / 1024).toFixed(1)} KiB`);
  console.log(line('cognitive retrieval (partial: no model, no response)', retrieval.samples));
  console.log(line('COMPLETE request through the controller (offline)', complete.samples));
  console.log(line('COMPLETE reasoning session (retrieve, assess, persist)', reasoning.samples));
  console.log(`  ${pad('evidence returned / cited / hypotheses', 60)} retrieval ${row.retrieved} (dropped ${row.dropped}),`
    + ` session cited ${row.cited}, hypotheses ${row.hypotheses}`);
  console.log(`  ${pad('outcomes', 60)} request ${completeStatus}, session ${reasoningStatus}`);
  console.log(`  ${pad('heap delta during this row (no forced GC)', 60)} ${mib(row.heapDelta)}`);
  console.log('');
}

// ---- section four: in-run ratios ---------------------------------------------------------------
console.log('### in-run ratios (same process, same run; no remembered baseline)');
if (docRows.length >= 2) {
  const first = docRows[0];
  const last = docRows[docRows.length - 1];
  console.log(`  documents first ingest, ${last.size} vs ${first.size} files: ${ratio(last.firstMs, first.firstMs)}`
    + ` (scan caps ${first.cap} -> ${last.cap}; above the cap the work is bounded, not proportional)`);
  console.log(`  documents unchanged re-ingest, ${last.size} vs ${first.size}: ${ratio(last.repeatMs, first.repeatMs)}`);
  console.log(`  documents search, ${last.size} vs ${first.size}: ${ratio(last.searchMs, first.searchMs)}`);
  for (const row of docRows) {
    console.log(`  documents ${row.size}: unchanged re-ingest vs first ingest ${ratio(row.repeatMs, row.firstMs)},`
      + ` search vs first ingest ${ratio(row.searchMs, row.firstMs)}`);
  }
}
if (evRows.length >= 2) {
  const first = evRows[0];
  const last = evRows[evRows.length - 1];
  console.log(`  evidence complete request, ${last.size} vs ${first.size} records: ${ratio(last.completeMs, first.completeMs)}`);
  console.log(`  evidence reasoning session, ${last.size} vs ${first.size} records: ${ratio(last.reasoningMs, first.reasoningMs)}`);
  console.log(`  evidence retrieval partial, ${last.size} vs ${first.size} records: ${ratio(last.retrievalMs, first.retrievalMs)}`);
  for (const row of evRows) {
    console.log(`  evidence ${row.size}: complete request vs retrieval partial ${ratio(row.completeMs, row.retrievalMs)},`
      + ` session vs retrieval partial ${ratio(row.reasoningMs, row.retrievalMs)}`);
  }
}
console.log('');

console.log('what this run cannot prove:');
console.log('  - it is not a statistical benchmark: a few samples on one machine at one moment;');
console.log('  - heap deltas are allocation between two points with no forced GC, not retained memory;');
console.log('  - document work above maxFiles is refused by the scan, so the 1000/5000 rows measure');
console.log('    bounded ingestion plus directory listing, not proportional indexing;');
console.log('  - document ingest emits one situational event per new, changed or failed document, and each');
console.log('    emit reads and reduces the whole append-only situational log (several times). A batch of');
console.log('    new documents therefore costs roughly the batch size times the log length at that moment;');
console.log('    the first-ingest and burst rows show that cost, and no optimization is claimed here;');
console.log('  - the reasoning session is written, so reasoning.jsonl grows by one record per sample;');
console.log('  - no inference, provider, socket or child process was used; model-free behaviour only.');

if (!keep()) {
  for (const dir of dirs) removeDir(dir);
  console.log(`\nremoved ${dirs.length} temporary director${dirs.length === 1 ? 'y' : 'ies'}`);
} else {
  console.log(`\n--keep: left ${dirs.length} temporary director${dirs.length === 1 ? 'y' : 'ies'}:`);
  for (const dir of dirs) console.log(`  ${dir}`);
}

function keep() { return process.argv.includes('--keep'); }

if (failed.length > 0) {
  console.error(`\n${failed.length} of ${checksRun} check(s) failed:`);
  for (const message of failed) console.error(`  - ${message}`);
  process.exitCode = 1;
} else {
  console.log(`\nall ${checksRun} checks passed`);
}
