// Bounded, model-free benchmark for the usable offline release paths.
//
// It measures, through the real controller and against synthetic fixtures in fresh temporary
// directories, the everyday operations the offline release is defined by: note search, the
// cross-store knowledge digest, bounded CSV extraction, deadline listing and the work review, and
// the backup export / inspect / restore cycle. No inference is run or simulated: a NoBackend is
// constructed so no model is contacted, no child process is started, and nothing touches a
// network. This is not part of `npm test` and no test depends on it.
//
//   node benchmarks/run-release-benchmark.mjs [--repeats R] [--keep]
//
// Fixtures are seeded in the stores' own append-only JSONL format (real records that pass the same
// validators) so the corpus is large without spending the run writing it through the controller.
// Each size gets its own data directory, workspace root, archive directory, and restore target;
// cleanup removes only directories this run created unless --keep is given.
//
// It reports the median of R samples after one discarded warm-up per operation, plus the in-run
// scaling from the smallest to the largest corpus. Only in-run ratios are treated as findings:
// absolute timings swing with machine load, so no cross-run before/after is claimed. Export is
// timed with a fresh destination per sample because an export refuses to overwrite an archive.
// Restore is timed once per size (it consumes an archive into an empty data directory) and is
// reported as a single run, not a median.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';

const args = process.argv.slice(2);
const repeatsArg = args.indexOf('--repeats');
const SAMPLES = repeatsArg >= 0 ? Math.max(3, Number(args[repeatsArg + 1]) || 5) : 5;
const KEEP = args.includes('--keep');
const SIZES = [200, 2000, 12000];
const DEADLINE_SIZES = [100, 500];
const NOW = '2026-11-15T00:00:00.000Z';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-release-bench-')); }
function median(xs) { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function sha256Hex(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function writeJsonl(file, records) { fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n'); }
function bytesOf(dir) {
  return fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
}

function knowledgeRecords(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const subject = `vendor ${i}`;
    const relationship = 'owns';
    const object = `asset ${i}`;
    out.push({
      schema: 1,
      id: randomUUID(),
      subject,
      relationship,
      object,
      evidence: i % 10 === 0 ? 'the permit renewal is pending for this asset' : `recorded at the review of asset ${i}`,
      tripleHash: sha256Hex(`${subject}\x00${relationship}\x00${object}`),
      status: 'supported',
      createdAt: NOW,
      provenance: { origin: 'user_supplied', updateMode: 'user_confirmed' },
    });
  }
  return out;
}

function noteRecords(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const body = `note ${i}: the permit renewal for asset ${i} is tracked here with the budget figures`;
    out.push({
      schema: 1,
      id: randomUUID(),
      revision: 1,
      title: `asset ${i} renewal note`,
      body,
      bodySha256: sha256Hex(body),
      tags: i % 7 === 0 ? ['permit', 'renewal'] : ['asset'],
      sources: [],
      sensitivity: 'normal',
      createdAt: NOW,
      provenance: { origin: 'user_supplied', updateMode: 'user_confirmed' },
    });
  }
  return out;
}

function scheduleCsv(n) {
  const lines = ['title,dueAt'];
  for (let i = 0; i < n; i += 1) {
    const due = new Date(Date.UTC(2026, 10, 1) + ((i * 37) % 400) * 86400000).toISOString().slice(0, 10);
    lines.push(`scheduled item ${i},${due}`);
  }
  return lines.join('\n') + '\n';
}

function appAt(dataDir, root) {
  return createApp({
    dataDir,
    filesystemRoot: root,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    experienceCapture: CAPTURE_OFF,
    now: () => new Date(NOW),
  });
}

// One call is run first and discarded (cold parse / index warm-up), then SAMPLES are recorded.
async function timeCall(fn) {
  await fn();
  const ts = [];
  let last = null;
  for (let i = 0; i < SAMPLES; i += 1) {
    const t0 = performance.now();
    last = await fn();
    ts.push(performance.now() - t0);
  }
  return { ms: median(ts), all: ts.map((x) => +x.toFixed(1)), status: last.status };
}

async function timeExport(app, archiveDir, label) {
  const times = [];
  let last = null;
  for (let i = 0; i <= SAMPLES; i += 1) {
    const destination = path.join(archiveDir, `${label}-${i}.json`);
    const t0 = performance.now();
    const res = await app.controller.backupExport({ path: destination });
    const ms = performance.now() - t0;
    if (res.status !== 'success_verified') throw new Error(`export failed: ${res.display}`);
    if (i > 0) times.push(ms);
    last = res;
  }
  return { ms: median(times), all: times.map((x) => +x.toFixed(1)), archive: last };
}

const dirs = [];
const rows = [];

for (const n of SIZES) {
  const dataDir = tempDir();
  const root = tempDir();
  const archiveDir = tempDir();
  dirs.push(dataDir, root, archiveDir);

  const notes = Math.max(1, Math.floor(n / 3));
  writeJsonl(path.join(dataDir, 'knowledge.jsonl'), knowledgeRecords(n));
  writeJsonl(path.join(dataDir, 'notes.jsonl'), noteRecords(notes));
  fs.writeFileSync(path.join(root, 'schedule.csv'), scheduleCsv(n));

  const app = appAt(dataDir, root);
  const noteSearch = await timeCall(() => app.controller.noteSearch({ query: 'permit renewal', limit: 5 }));
  const digest = await timeCall(() => app.controller.knowledgeDigest({ query: 'permit', limit: 5 }));
  const extract = await timeCall(() => app.controller.workspaceExtract({ path: 'schedule.csv' }));
  const exported = await timeExport(app, archiveDir, `release-${n}`);
  const archivePath = exported.archive.operation.steps[0].result.data.path;
  const archiveSha = exported.archive.operation.steps[0].result.data.archiveSha256;
  const inspect = await timeCall(() => app.controller.backupInspect({ path: archivePath }));

  const restoreDir = tempDir();
  dirs.push(restoreDir);
  const restoreApp = appAt(restoreDir, root);
  const rt0 = performance.now();
  const restored = await restoreApp.controller.backupRestore({
    path: archivePath,
    confirm: archiveSha.slice(0, 12),
  });
  const restoreMs = performance.now() - rt0;

  rows.push({
    n,
    notes,
    bytes: bytesOf(dataDir),
    archiveBytes: exported.archive.operation.steps[0].result.data.size,
    noteSearch,
    digest,
    extract,
    export: exported,
    inspect,
    restoreMs,
    restoreStatus: restored.status,
  });
}

console.log(`Release-path benchmark through the real controller (no model). Medians of ${SAMPLES} samples after one discarded warm-up; export samples use a fresh destination; restore is one run.`);
console.log('size | notes | data MiB | archive MiB | note search ms | knowledge digest ms | CSV extract ms | export ms | inspect ms | restore ms (status)');
for (const r of rows) {
  console.log([
    r.n,
    r.notes,
    (r.bytes / 1048576).toFixed(2),
    (r.archiveBytes / 1048576).toFixed(2),
    r.noteSearch.ms.toFixed(1),
    r.digest.ms.toFixed(1),
    r.extract.ms.toFixed(1),
    r.export.ms.toFixed(1),
    r.inspect.ms.toFixed(1),
    `${r.restoreMs.toFixed(1)} (${r.restoreStatus})`,
  ].join(' | '));
}
const first = rows[0];
const last = rows[rows.length - 1];
const factor = (a, b) => (b / a).toFixed(2);
console.log(`In-run scaling from ${first.n} to ${last.n} records: note search ${factor(first.noteSearch.ms, last.noteSearch.ms)}x, `
  + `knowledge digest ${factor(first.digest.ms, last.digest.ms)}x, CSV extraction ${factor(first.extract.ms, last.extract.ms)}x, `
  + `export ${factor(first.export.ms, last.export.ms)}x, inspect ${factor(first.inspect.ms, last.inspect.ms)}x.`);
console.log('The digest reads both knowledge and notes; note search scans every note; export reads every store file and re-inspects the archive it wrote.');
console.log('Per-sample medians: note search ' + JSON.stringify(last.noteSearch.all) + ', digest ' + JSON.stringify(last.digest.all) + ', export ' + JSON.stringify(last.export.all) + '.');

const deadlineRows = [];
for (const d of DEADLINE_SIZES) {
  const dataDir = tempDir();
  const root = tempDir();
  dirs.push(dataDir, root);
  fs.writeFileSync(path.join(root, 'schedule.csv'), scheduleCsv(d));
  const app = appAt(dataDir, root);
  const t0 = performance.now();
  const imported = await app.controller.deadlineImport({ path: 'schedule.csv' });
  const importMs = performance.now() - t0;
  if (imported.status !== 'success_verified') throw new Error(`deadline import failed: ${imported.display}`);
  const list = await timeCall(() => app.controller.deadlineList({ limit: 50, horizonDays: 30 }));
  const review = await timeCall(() => app.controller.workReview({ horizonDays: 7 }));
  deadlineRows.push({ d, importMs, list, review });
}

console.log('');
console.log('Deadline ledger, bounded at 500 entries by the store contract. Import is one run; list and review are medians.');
console.log('entries | import ms | deadline list ms | work review ms');
for (const r of deadlineRows) {
  console.log(`${r.d} | ${r.importMs.toFixed(1)} | ${r.list.ms.toFixed(1)} | ${r.review.ms.toFixed(1)}`);
}
const dl0 = deadlineRows[0];
const dlN = deadlineRows[deadlineRows.length - 1];
console.log(`In-run scaling from ${dl0.d} to ${dlN.d} deadlines: list ${factor(dl0.list.ms, dlN.list.ms)}x, review ${factor(dl0.review.ms, dlN.review.ms)}x.`);
console.log('The list returns at most 50 items and the review at most 20, but each sorts the whole ledger, so the read cost follows the ledger size.');
console.log('Only in-run ratios are reported: absolute timings vary with machine load, and no before/after across runs is claimed.');

if (!KEEP) for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
else console.log(`Kept ${dirs.length} fixture directories under ${os.tmpdir()}.`);
