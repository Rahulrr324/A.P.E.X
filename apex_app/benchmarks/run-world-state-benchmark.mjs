// Bounded, model-free benchmark for the world-state projection (Batch T read path,
// Batch U cold/warm behaviour).
//
// It measures APEX's own read path against synthetic fixtures written into a fresh temporary
// data directory: the first read of a store (nothing derived yet), a repeated unchanged read,
// the same read with the derived snapshot switched off, the same read through the Batch T
// strategy (two whole-store loads per store, no snapshot), the read that follows a memory
// append, the read that follows a knowledge append, the store health scan, render, and the
// executed step and its independent verification timed separately. Reporting the Batch T
// strategy and the switched-off read in the same run means the before/after comparison shares
// one fixture, one machine, and one page-cache state instead of relying on old recorded
// numbers. The write phases run twice, once per reader, so the cost the snapshot adds to a
// write is measured rather than assumed.
//
//   node benchmarks/run-world-state-benchmark.mjs [--memory N] [--claims N] [--repeats R] [--keep]
//   node benchmarks/run-world-state-benchmark.mjs --writes [--repeats R] [--full] [--keep]
//
// Bounds: memory fixtures are written directly as valid records; in read mode claims are
// appended through KnowledgeStore.add (which re-reads the store per append), so seeding cost is
// reported separately from read cost and claim fixtures stay small for that reason. In --writes
// mode claim fixtures are built through the same write path against an emptied scratch store,
// which keeps preparation linear; the quadratic cost of preparing a store through ordinary
// appends is what the cumulative workload section measures.
//
// `--writes` measures the write path instead of the read path: for each store size it separates
// the parts of one append - reading the file, hashing all its bytes, parsing without integrity
// checks, the whole-store validated read a write used to perform, the incremental validated read
// a write performs now, the append itself at that size, the whole write on a freshly constructed
// store, and the whole write on a store that has already written once - plus the operations that
// read the store's derived state (a conflicting claim, a supersession, a retraction, a resolution,
// a correction) on the same fixtures, the store-layer work timed inside one call rather than
// subtracted across three, the wall time of cumulative append workloads, and the cost of
// the refusal a damaged store forces. The old and new write reads are measured on the same fixture
// in the same process, so the comparison does not depend on a recorded number; the incremental read
// reports its own provenance (reuses and re-derivations) so a reader can see that the figure is a
// reuse rather than a rebuild wearing the name of one. Each cumulative workload is likewise run
// twice, once with the derived state and once with it switched off through the store's own
// constructor option, which is what makes the before/after a measurement instead of a recollection.
// That decomposition is what justified (and now bounds) the incremental write design, so it is
// reported as components, not just totals.
// This is not part of `npm test` and no test depends on it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { sha256Hex, MemoryStore, validateMemoryRecord, MEMORY_PARSE_CACHE_BYTES } from '../src/memory/memory-store.js';
import { KnowledgeStore, validateKnowledgeRecord, KNOWLEDGE_PARSE_CACHE_BYTES } from '../src/knowledge/knowledge-store.js';
import { JsonlStore } from '../src/memory/jsonl-store.js';
import { buildWorldState, renderWorldState } from '../src/world/world-state.js';
import { worldActions } from '../src/actions/world-actions.js';

const MAX_MEMORY_FIXTURE = 40000;
const MAX_CLAIM_FIXTURE = 2000;
const MAX_REPEATS = 25;
// Write-path sizes are a fixed matrix so a before/after comparison runs the same fixtures. The
// memory fixtures are written directly, so a large one costs little to prepare; claim fixtures
// are seeded through KnowledgeStore.add and therefore cost O(n^2) to prepare, which is itself
// one of the findings this benchmark reports.
const WRITE_MEMORY_SIZES = [200, 2000, 20000, 40000];
const WRITE_CLAIM_SIZES = [200, 2000];
// Cumulative workloads are the quadratic case: 1,000 ordinary writes onto a 200-record store each
// re-read the store, and before Batch V each also re-parsed and re-validated every record in it.
// A 2,000-append workload is listed separately because it takes minutes to run, so it is opt-in
// with --full rather than part of the default matrix that a before/after comparison uses.
const WRITE_WORKLOADS = [
  { kind: 'memory', start: 200, appends: 100 },
  { kind: 'memory', start: 200, appends: 1000 },
  { kind: 'memory', start: 2000, appends: 100 },
  { kind: 'memory', start: 2000, appends: 1000 },
  { kind: 'knowledge', start: 200, appends: 100 },
  { kind: 'knowledge', start: 200, appends: 1000 },
];
const WRITE_WORKLOADS_FULL = [
  { kind: 'memory', start: 200, appends: 2000 },
  { kind: 'knowledge', start: 200, appends: 2000 },
];

function parseArgs(argv) {
  const opts = { memory: 2000, claims: 2000, repeats: 7, keep: false, writes: false, full: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--keep') {
      opts.keep = true;
    } else if (arg === '--writes') {
      opts.writes = true;
    } else if (arg === '--full') {
      opts.full = true;
    } else if (arg === '--memory') {
      opts.memory = bounded(argv[i + 1], 1, MAX_MEMORY_FIXTURE, '--memory');
      i += 1;
    } else if (arg === '--claims') {
      opts.claims = bounded(argv[i + 1], 1, MAX_CLAIM_FIXTURE, '--claims');
      i += 1;
    } else if (arg === '--repeats') {
      opts.repeats = bounded(argv[i + 1], 1, MAX_REPEATS, '--repeats');
      i += 1;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return opts;
}

function bounded(raw, min, max, label) {
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

async function timedAsync(fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, result };
}

function timed(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, result };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
    n: sorted.length,
  };
}

function fileState(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) {
      const content = fs.readFileSync(full);
      out[name] = { bytes: content.length, sha: sha256Hex(content.toString('utf8')) };
    }
  }
  return out;
}

// Memory records share one clause subject on purpose: the heuristic conflict scan compares
// the distinct values inside a subject group, so a single-subject fixture is the worst case
// the projection can present (it still only ever scans the read window).
function writeMemoryFixture(dir, count, name = 'memory.jsonl') {
  const createdAt = new Date(Date.UTC(2026, 0, 1)).toISOString();
  const records = [];
  for (let i = 0; i < count; i += 1) {
    const content = `The archive index is entry${i}`;
    records.push({
      schema: 1,
      id: randomUUID(),
      kind: 'user_fact',
      source: 'user',
      sensitivity: 'normal',
      content,
      contentSha256: sha256Hex(content),
      createdAt,
      provenance: { origin: 'user_request', updateMode: 'user_confirmed' },
    });
  }
  const lines = records.map((record) => JSON.stringify(record));
  fs.writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`, 'utf8');
  return records;
}

async function writeKnowledgeFixture(dir, count, name = 'knowledge.jsonl') {
  const store = new KnowledgeStore(path.join(dir, name), { now: () => new Date(Date.UTC(2026, 0, 1)), parseCacheBytes: 0 });
  for (let i = 0; i < count; i += 1) {
    await store.add({
      subject: `Ledger ${i}`,
      relationship: 'row',
      object: `value ${i}`,
      evidence: i % 2 === 0 ? `note ${i}` : null,
      origin: 'user',
    });
  }
  return store;
}

// A new pair of store instances: the derived snapshot lives in the instance, so a fresh pair
// is what a restarted process sees. `parseCacheBytes: 0` builds the same reader with the
// snapshot switched off, which is the comparison this benchmark needs.
function storePair(dir, { parseCacheBytes }) {
  const memory = new MemoryStore(path.join(dir, 'memory.jsonl'), { parseCacheBytes });
  const knowledge = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'), { parseCacheBytes });
  return { memory, knowledge };
}

const contextOf = (stores) => ({ memory: stores.memory, knowledge: stores.knowledge, now: () => new Date() });

// The Batch T read pattern, reconstructed through the current public store API: the integrity
// summary and the bounded record window obtained by two separate whole-store loads per store.
// Wrapping the stores this way lets one run compare the old read strategy against the merged
// read under identical fixture, machine, and page-cache conditions. The wrapper has to produce
// the same projection as the real stores, so the comparison is cost only.
function legacyContext(stores) {
  const memory = {
    async projectionRead({ limit, includePrivate }) {
      const health = await stores.memory.health();
      const records = health.inspected === true && health.corruptLines === 0
        ? await stores.memory.list({ limit, includePrivate })
        : null;
      return { health, records };
    },
  };
  const knowledge = {
    async projectionRead({ limit }) {
      const health = await stores.knowledge.health();
      const claims = health.inspected === true && health.corruptLines === 0
        ? await stores.knowledge.list({ limit })
        : null;
      return { health, claims };
    },
  };
  return { memory, knowledge, now: () => new Date() };
}

async function sampleLegacyBuilds(stores, count) {
  const samples = [];
  let world = null;
  for (let i = 0; i < count; i += 1) {
    const run = await timedAsync(() => buildWorldState(legacyContext(stores)));
    samples.push(run.ms);
    world = run.result;
  }
  return { samples, world };
}

async function sampleBuilds(stores, count) {
  const samples = [];
  let world = null;
  for (let i = 0; i < count; i += 1) {
    const run = await timedAsync(() => buildWorldState(contextOf(stores)));
    samples.push(run.ms);
    world = run.result;
  }
  return { samples, world };
}

async function sampleLoad(log, count) {
  const samples = [];
  for (let i = 0; i < count; i += 1) samples.push((await timedAsync(() => log.load())).ms);
  return samples;
}

function footprint() {
  const m = process.memoryUsage();
  return { rss: m.rss, heap: m.heapUsed };
}

const fmt = (value) => `${(value / 1024 / 1024).toFixed(1)} MiB`;

// ---- write path (--writes) ---------------------------------------------------
//
// One append against a store of a given size is made of parts, and this section times each of
// them separately on identical bytes so the write design can be argued from the composition
// instead of from a single total:
//   read              fs.readFile of the whole store
//   read+hash         the same read plus a SHA-256 of every byte - the sound test for "are
//                     these still the bytes I already validated?"
//   read+parse        the same read plus the store's own parser with integrity checks disabled
//   validated read    the read an ordinary write performed before Batch V: parser plus every rule
//   incremental read  the write read as Batch V performs it when its state is verified: read the
//                     bytes, hash them once, reuse the records that came from those bytes
//   append            the append by itself at that size (open, write, fsync)
//   cold write        the store's public write on a store instance that has not written yet, so
//                     its read is a re-derivation of the whole store
//   warm write        the same public write on an instance that has already written once, which
//                     is the repeated-write case the incremental state exists for
// Subtracting read+parse from validated read isolates the integrity work. The cold and warm
// writes are reported as separate columns rather than subtracted from each other's reads: the
// store-layer work belongs to the warm write, and the gap between the two writes is the
// re-derivation a restart pays. Every sample copies the fixture to a run file first, and the
// copy is outside the timer, so the store under measurement always holds exactly the same
// records and the same bytes.

// A direct claim fixture would have to reproduce the store's own triple hash, so fixture
// records are produced by the real write path against a scratch file that is emptied between
// records. That keeps seeding linear while leaving every record authored and validated exactly
// as an ordinary write would; the quadratic cost of building a large store through ordinary
// appends is measured on its own in the cumulative workload section.
async function buildClaimRecords(count) {
  const scratch = path.join(fs.realpathSync(os.tmpdir()), `apex-bench-seed-${randomUUID()}.jsonl`);
  const store = new KnowledgeStore(scratch, {
    now: () => new Date(Date.UTC(2026, 0, 1)),
    parseCacheBytes: 0,
  });
  const records = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const { record } = await store.add({
        subject: `Ledger ${i}`,
        relationship: 'row',
        object: `value ${i}`,
        evidence: i % 2 === 0 ? `note ${i}` : null,
        origin: 'user',
      });
      records.push(record);
      await fsp.writeFile(scratch, '', 'utf8');
    }
  } finally {
    fs.rmSync(scratch, { force: true });
  }
  return records;
}

async function writeClaimFixture(dir, count, name = 'knowledge.jsonl') {
  const records = await buildClaimRecords(count);
  fs.writeFileSync(path.join(dir, name), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return records;
}

async function appendComponents({ fixture, run, repeats, validateRecord, appendOnce, writeOnce, warmWrite, warmStore, coldRead }) {
  const out = {
    read: [], readHash: [], readParse: [], validatedRead: [], coldWriteRead: [], incrementalRead: [],
    append: [], write: [], warmWrite: [],
  };
  const once = async (bucket, fn, prep = null) => {
    await fsp.copyFile(fixture, run);
    const context = prep ? await prep(run) : null;
    out[bucket].push((await timedAsync(() => fn(run, context))).ms);
    return context;
  };
  let warm = null;
  for (let i = 0; i < repeats; i += 1) {
    await once('read', () => fsp.readFile(run, 'utf8'));
    await once('readHash', async () => createHash('sha256').update(await fsp.readFile(run, 'utf8')).digest('hex'));
    await once('readParse', () => new JsonlStore(run, { validateRecord: () => null }).load({ maintainSnapshot: false }));
    await once('validatedRead', () => new JsonlStore(run, { validateRecord }).load({ maintainSnapshot: false }));
    // The write read as Batch V performs it: one untimed ordinary write on a fresh copy of the
    // fixture builds the incremental validated state, and the timed call is the next write's read
    // of the same store instance. Its provenance is reported with the row, so a reader can see
    // whether the number below is a reuse or a re-derivation.
    warm = await once('incrementalRead', (target, store) => store.log.loadForAppend(), () => warmStore(run));
    // The write read a freshly constructed instance performs - what one CLI command pays, including
    // the cost of retaining and freezing the records it just validated.
    if (coldRead) await once('coldWriteRead', (target) => coldRead(target));
    await once('append', () => appendOnce(run));
    await once('write', () => writeOnce(run));
    await once('warmWrite', (target, store) => warmWrite(store), () => warmStore(run));
  }
  const out2 = Object.fromEntries(Object.entries(out).map(([key, samples]) => [key, stats(samples)]));
  out2.incrementalProvenance = warm ? warm.log.appendStateStats : null;
  return out2;
}

// One store's component matrix. `extraOps` re-runs on a fresh copy of the same fixture for the
// sizes listed in `extraSizes`, so the operations that read the store's derived state - the
// conflict scan, the lifecycle rebuild, a correction, a retraction, a resolution - are reported
// at the same sizes as the plain append instead of at one convenient size.
async function storeMatrix(dir, { label, file, sizes, validateRecord, make, rawAppend, writeOnce, warmWrite, warmStore, coldRead, extraOps, extraSizes, repeats }) {
  const columns = ['records', 'bytes', 'read', 'read+hash', 'read+parse', 'validated read', 'cold write read', 'incremental read', 'append', 'cold write', 'warm write'];
  const pad = (cells) => cells.map((v, i) => (i === 0 ? v.padStart(8) : v.padStart(17))).join('');
  console.log(`${label}: one append, measured in parts (medians, ms)`);
  console.log(`  ${pad(columns)}`);
  const rows = [];
  for (const count of sizes) {
    const fixture = path.join(dir, `bench-${file}-${count}.jsonl`);
    const records = await make(dir, count, path.basename(fixture));
    const run = path.join(dir, `bench-${file}-${count}-run.jsonl`);
    const bytes = fs.statSync(fixture).size;
    const c = await appendComponents({
      fixture,
      run,
      repeats,
      validateRecord,
      appendOnce: (target) => rawAppend(target),
      writeOnce: (target) => writeOnce(target, count),
      warmWrite: (store) => warmWrite(store, count),
      warmStore: (target) => warmStore(target, count),
      coldRead: coldRead ? (target) => coldRead(target) : null,
    });
    rows.push({ count, bytes, c, records });
    console.log(`  ${pad([
      String(count),
      String(bytes),
      c.read.median.toFixed(2),
      c.readHash.median.toFixed(2),
      c.readParse.median.toFixed(2),
      c.validatedRead.median.toFixed(2),
      c.coldWriteRead ? c.coldWriteRead.median.toFixed(2) : 'n/a',
      c.incrementalRead.median.toFixed(2),
      c.append.median.toFixed(2),
      c.write.median.toFixed(2),
      c.warmWrite.median.toFixed(2),
    ])}`);
    if (!extraSizes.includes(count) || extraOps.length === 0) continue;
    const line = (name, value) => console.log(`    ${name.padEnd(52)} ${value}`);
    line('integrity work (validated read - parse)', `${(c.validatedRead.median - c.readParse.median).toFixed(2)} ms`);
    line('integrity work per record', `${((c.validatedRead.median - c.readParse.median) / count * 1000).toFixed(1)} us`);
    if (c.coldWriteRead) {
      line('retention cost of a cold write read (cold - validated)', `${(c.coldWriteRead.median - c.validatedRead.median).toFixed(2)} ms`);
    }
    line('store-layer work (warm write - incr read - append)', `${(c.warmWrite.median - c.incrementalRead.median - c.append.median).toFixed(2)} ms`);
    line('re-derivation a fresh instance pays (cold - warm)', `${(c.write.median - c.warmWrite.median).toFixed(2)} ms`);
    const provenance = c.incrementalProvenance;
    line('incremental read provenance', provenance
      ? `${provenance.reuses} reuse(s), ${provenance.rebuilds} re-derivation(s), ${provenance.trackedRecords} tracked record(s)`
      : 'not measured');
    console.log(`  ${label}: derived-state operations at ${count} record(s) (median, ms)`);
    for (const spec of extraOps) {
      // Ranked retrieval scores every record against every query term, which at these fixture
      // sizes takes minutes rather than milliseconds, so an op can name the sizes it is worth
      // running at and how many samples it can afford. The omission is printed, not hidden.
      if (spec.at && !spec.at.includes(count)) {
        line(spec.name, `not measured at ${count} record(s): ${spec.note ?? 'this op is only measured where it is practical'}`);
        continue;
      }
      const samples = [];
      const times = Math.min(spec.samples ?? Infinity, repeats);
      const target = path.join(dir, `bench-${file}-${count}-extra.jsonl`);
      const { prepare = null, run: runOp } = spec.op({ records, count });
      for (let i = 0; i < times; i += 1) {
        await fsp.copyFile(fixture, target);
        // Untimed setup, so the number below is the operation itself. A resolution needs a live
        // conflict to decide between, which the fixture alone does not contain.
        const prepared = prepare ? await prepare(target, i) : null;
        samples.push((await timedAsync(() => runOp(target, i, prepared))).ms);
      }
      line(spec.name, `${stats(samples).median.toFixed(2)} ms${times < repeats ? ` (n=${times}, reduced)` : ''}`);
    }
  }
  return rows;
}

// A cumulative append workload: a store of `start` records, then `appends` ordinary writes
// against the live file through ONE store instance held for the whole workload, which is what a
// continuous session does. The growth of the per-append median across the workload is the scaling
// signal; the seeding cost is reported separately because it is fixture preparation, not a
// measurement.
//
// Each workload is run twice on the same seed: with the incremental validated state (how Batch V
// writes) and with it switched off, which makes every write read the whole store, parse it and
// validate every record - exactly what a write read cost before Batch V. Reporting both from one
// run is what makes the comparison a measurement rather than a claim: same fixture bytes, same
// machine, same page-cache state, and the second number is produced by the same store class with
// one constructor option changed.
async function cumulativeWorkload(dir, { kind, start, appends, make, writeOn, makeStore }) {
  const fixture = path.join(dir, `bench-wl-${kind}-${start}-${appends}.jsonl`);
  const seed = await timedAsync(() => make(dir, start, path.basename(fixture)));
  const runOnce = async (derived) => {
    const live = path.join(dir, `bench-wl-${kind}-${start}-${appends}-${derived ? 'incremental' : 'revalidate'}.jsonl`);
    await fsp.copyFile(fixture, live);
    const store = makeStore(live, derived);
    const samples = [];
    const total = await timedAsync(async () => {
      for (let i = 0; i < appends; i += 1) samples.push((await timedAsync(() => writeOn(store, start + i, i))).ms);
    });
    const slice = (from, to) => stats(samples.slice(from, to));
    const window = Math.min(10, samples.length);
    const out = {
      totalMs: total.ms,
      perAppend: stats(samples),
      head: slice(0, window).median,
      middle: slice(Math.floor(appends / 2) - Math.floor(window / 2), Math.floor(appends / 2) + Math.floor(window / 2)).median,
      tail: slice(-window).median,
      bytes: fs.statSync(live).size,
      provenance: store.log.appendStateStats,
    };
    fs.rmSync(live, { force: true });
    return out;
  };
  const incremental = await runOnce(true);
  const revalidate = await runOnce(false);
  fs.rmSync(fixture, { force: true });
  return { kind, start, appends, seedMs: seed.ms, incremental, revalidate };
}

// A store whose last line was left unterminated by an interrupted append must refuse a write,
// and the refusal has a cost. It is timed here, on the same fixtures, so the guard the write
// path pays for is known rather than assumed.
async function damagedWrite(dir, { file, count, make, writeOnce, repeats }) {
  const fixture = path.join(dir, `bench-${file}-${count}.jsonl`);
  await make(dir, count, path.basename(fixture));
  const target = path.join(dir, `bench-${file}-${count}-damaged.jsonl`);
  const samples = [];
  const leftDamage = [];
  let message = null;
  let rejected = 0;
  const attempt = async () => {
    const start = process.hrtime.bigint();
    try {
      await writeOnce(target, count, samples.length);
      return { ms: Number(process.hrtime.bigint() - start) / 1e6, threw: false };
    } catch (err) {
      return { ms: Number(process.hrtime.bigint() - start) / 1e6, threw: true, message: err?.message ?? String(err) };
    }
  };
  const before = [];
  for (let i = 0; i < repeats; i += 1) {
    await fsp.copyFile(fixture, target);
    await fsp.appendFile(target, '{"schema":1,"id":"partial', 'utf8');
    before.push((await fsp.stat(target)).size);
    const run = await attempt();
    samples.push(run.ms);
    if (run.threw) {
      rejected += 1;
      message = run.message;
    }
    if ((await fsp.stat(target)).size !== before[i]) leftDamage.push(i);
  }
  fs.rmSync(target, { force: true });
  fs.rmSync(fixture, { force: true });
  return { count, stats: stats(samples), rejected, attempts: repeats, message, leftDamage };
}

// The store-layer work measured inside one call instead of subtracted across samples. The
// component matrix derives it as warm write minus incremental read minus append, three medians
// from three separate distributions, so at these sizes it can come out negative on fsync noise.
// Here one public write is timed as a whole and, within that same call, the write read and the
// append it performed are timed too; the difference is then one number from one sample of one
// call. The instrumentation replaces two methods of the store's own JsonlStore with wrappers that
// only add a clock around the original, so the call under measurement is the production call.
async function inCallDecomposition(dir, { label, count, make, warmStore, publicWrite, repeats }) {
  const fixture = path.join(dir, `bench-incall-${label}-${count}-fixture.jsonl`);
  const target = path.join(dir, `bench-incall-${label}-${count}.jsonl`);
  await make(dir, count, path.basename(fixture));
  const totals = [];
  const readMs = [];
  const appendMs = [];
  const storeLayer = [];
  const innerCalls = [];
  let provenance = null;
  for (let i = 0; i < repeats; i += 1) {
    await fsp.copyFile(fixture, target);
    const store = await warmStore(target, count);
    const log = store.log;
    const originalRead = log.loadForAppend.bind(log);
    const originalAppend = log.append.bind(log);
    const inner = { reads: 0, appends: 0, readMs: 0, appendMs: 0 };
    log.loadForAppend = async () => {
      const started = process.hrtime.bigint();
      const value = await originalRead();
      inner.reads += 1;
      inner.readMs += Number(process.hrtime.bigint() - started) / 1e6;
      return value;
    };
    log.append = async (record) => {
      const started = process.hrtime.bigint();
      try {
        return await originalAppend(record);
      } finally {
        inner.appends += 1;
        inner.appendMs += Number(process.hrtime.bigint() - started) / 1e6;
      }
    };
    const sample = await timedAsync(() => publicWrite(store, count, `in-call-${i}`));
    log.loadForAppend = originalRead;
    log.append = originalAppend;
    totals.push(sample.ms);
    readMs.push(inner.readMs);
    appendMs.push(inner.appendMs);
    storeLayer.push(sample.ms - inner.readMs - inner.appendMs);
    innerCalls.push(`${inner.reads}/${inner.appends}`);
    provenance = log.appendStateStats;
  }
  fs.rmSync(target, { force: true });
  fs.rmSync(fixture, { force: true });
  return {
    count,
    totals: stats(totals),
    readMs: stats(readMs),
    appendMs: stats(appendMs),
    storeLayer: stats(storeLayer),
    innerCalls,
    provenance,
  };
}

async function writePhases(dir, { repeats, full }) {
  const line = (name, value) => console.log(`  ${name.padEnd(52)} ${value}`);
  const row = (cells) => cells.map((v, i) => (i === 0 ? v.padStart(36) : v.padStart(13))).join('');
  console.log(`write path: ${repeats} timed sample(s) for each measurement; every sample runs on a fresh copy of its fixture, so the store under measurement always holds the same bytes`);
  console.log('the public write is a production store instance (derived state enabled with the same cap the real stores use)');
  console.log('"cold write" constructs the store for the timed write; "warm write" is the next write on an instance that has already written once');

  const memoryProbeContent = 'Probe record used only for the append component';
  const memoryProbe = () => ({
    schema: 1,
    id: randomUUID(),
    kind: 'user_fact',
    source: 'user',
    sensitivity: 'normal',
    content: memoryProbeContent,
    contentSha256: sha256Hex(memoryProbeContent),
    createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    provenance: { origin: 'user_request', updateMode: 'user_confirmed' },
  });
  const claimProbe = (await buildClaimRecords(1))[0];

  const memoryAdd = (store, count, index = 0) => store.add({
    content: `Appended belief ${count}-${index} during the write matrix`,
    source: 'user',
    provenance: { origin: 'user_request' },
  });
  const claimAdd = (store, count, index = 0) => store.add({
    subject: `Probe ${count}-${index}`, relationship: 'row', object: `value ${index}`, origin: 'user',
  });
  const memoryWriteOnce = (target, count, index = 0) => memoryAdd(new MemoryStore(target), count, index);
  const knowledgeWriteOnce = (target, count, index = 0) => claimAdd(new KnowledgeStore(target), count, index);

  const memoryRows = await storeMatrix(dir, {
    label: 'memory',
    file: 'memory',
    sizes: WRITE_MEMORY_SIZES,
    validateRecord: validateMemoryRecord,
    make: async (d, count, name) => writeMemoryFixture(d, count, name),
    rawAppend: (target) => new JsonlStore(target, { validateRecord: validateMemoryRecord }).append(memoryProbe()),
    writeOnce: memoryWriteOnce,
    warmWrite: memoryAdd,
    coldRead: async (target) => (await new MemoryStore(target).log.loadForAppend()).records.length,
    warmStore: async (target, count) => {
      const store = new MemoryStore(target);
      await memoryAdd(store, count, 'warm-up');
      return store;
    },
    extraSizes: [2000, WRITE_MEMORY_SIZES[WRITE_MEMORY_SIZES.length - 1]],
    repeats,
    extraOps: [
      { name: 'add (contradicting content)', op: () => ({ run: (target, i) => new MemoryStore(target).add({ content: `The archive index is contradicted ${i}`, source: 'user', provenance: { origin: 'user_request' } }) }) },
      {
        name: 'correct (replacement of the newest record)',
        op: ({ records }) => {
          const newest = records[records.length - 1];
          return { run: (target, i) => new MemoryStore(target).correct({ targetId: newest.id, content: `The archive index is corrected ${i}`, origin: 'user' }) };
        },
      },
      {
        name: 'search (ranked retrieval)',
        at: [2000],
        samples: 3,
        note: 'it scores every stored record against every query term, so it is measured at 2,000 records only',
        op: () => ({ run: (target) => new MemoryStore(target).search('archive index entry', { limit: 5 }) }),
      },
      { name: 'list (bounded window)', op: () => ({ run: (target) => new MemoryStore(target).list({ limit: 20 }) }) },
      { name: 'health (integrity scan)', op: () => ({ run: (target) => new MemoryStore(target).health() }) },
      { name: 'projectionRead (merged read)', op: () => ({ run: (target) => new MemoryStore(target).projectionRead({ limit: 20 }) }) },
    ],
  });

  const knowledgeRows = await storeMatrix(dir, {
    label: 'knowledge',
    file: 'knowledge',
    sizes: WRITE_CLAIM_SIZES,
    validateRecord: validateKnowledgeRecord,
    make: async (d, count, name) => writeClaimFixture(d, count, name),
    rawAppend: (target) => new JsonlStore(target, { validateRecord: validateKnowledgeRecord }).append({ ...claimProbe, id: randomUUID() }),
    writeOnce: knowledgeWriteOnce,
    warmWrite: claimAdd,
    coldRead: async (target) => (await new KnowledgeStore(target).log.loadForAppend()).records.length,
    warmStore: async (target, count) => {
      const store = new KnowledgeStore(target);
      await claimAdd(store, count, 'warm-up');
      return store;
    },
    extraSizes: WRITE_CLAIM_SIZES,
    repeats,
    extraOps: [
      {
        name: 'add (claim that conflicts with an existing one)',
        op: ({ records }) => {
          const first = records[0];
          return { run: (target, i) => new KnowledgeStore(target).add({ subject: first.subject, relationship: first.relationship, object: `contested ${i}`, origin: 'user' }) };
        },
      },
      {
        name: 'add (superseding an existing claim)',
        op: ({ records }) => {
          const first = records[0];
          return { run: (target, i) => new KnowledgeStore(target).add({ subject: first.subject, relationship: first.relationship, object: `revised ${i}`, supersedes: [first.id], origin: 'user' }) };
        },
      },
      {
        name: 'retract (lifecycle event)',
        op: ({ records }) => {
          const second = records[1];
          return { run: (target) => new KnowledgeStore(target).retract({ target: second.id, reason: 'withdrawn by the write benchmark', origin: 'user' }) };
        },
      },
      {
        name: 'resolve (decision over a live conflict)',
        op: ({ records }) => {
          const first = records[0];
          return {
            prepare: async (target, i) => {
              const store = new KnowledgeStore(target, { parseCacheBytes: 0 });
              const live = await store.add({ subject: first.subject, relationship: first.relationship, object: `contested-live ${i}`, origin: 'user' });
              return live.record.id;
            },
            run: (target, i, chosenId) => new KnowledgeStore(target)
              .resolve({ target: first.id, choose: chosenId, reason: 'decided by the write benchmark', origin: 'user' }),
          };
        },
      },
      { name: 'list (bounded window)', op: () => ({ run: (target) => new KnowledgeStore(target).list({ limit: 20 }) }) },
      { name: 'health (integrity scan)', op: () => ({ run: (target) => new KnowledgeStore(target).health() }) },
      { name: 'projectionRead (merged read)', op: () => ({ run: (target) => new KnowledgeStore(target).projectionRead({ limit: 20 }) }) },
    ],
  });

  const workloads = full ? [...WRITE_WORKLOADS, ...WRITE_WORKLOADS_FULL] : WRITE_WORKLOADS;
  console.log('cumulative append workloads (ordinary writes against the live file, one store instance held for the whole workload):');
  console.log('  every workload runs twice on the same seed. "incremental" is Batch V: the write read reuses the');
  console.log('  records this instance validated, once the file hashes to the byte sequence they came from.');
  console.log('  "revalidate" is the same store class with its derived state switched off, so every write read parses');
  console.log('  and validates the whole store again - what a write cost before Batch V. One machine, one fixture,');
  console.log('  one run, so the two totals are directly comparable.');
  const workloadRow = (cells) => cells.map((v, i) => (i === 0 ? v.padStart(46) : v.padStart(13))).join('');
  console.log(`  ${workloadRow(['workload', 'seed (ms)', 'total (ms)', 'per-append', 'first 10', 'middle 10', 'last 10', 'final bytes'])}`);
  for (const workload of workloads) {
    const run = await cumulativeWorkload(dir, {
      kind: workload.kind,
      start: workload.start,
      appends: workload.appends,
      make: workload.kind === 'memory'
        ? async (d, count, name) => writeMemoryFixture(d, count, name)
        : async (d, count, name) => writeClaimFixture(d, count, name),
      writeOn: workload.kind === 'memory' ? memoryAdd : claimAdd,
      makeStore: workload.kind === 'memory'
        ? (target, derived) => new MemoryStore(target, derived ? undefined : { parseCacheBytes: 0 })
        : (target, derived) => new KnowledgeStore(target, derived ? undefined : { parseCacheBytes: 0 }),
    });
    const name = `${run.kind}: ${run.appends} append(s) onto ${run.start}`;
    for (const reader of [run.incremental, run.revalidate]) {
      const label = `${name}, ${reader === run.incremental ? 'incremental' : 'revalidate'}`;
      console.log(`  ${workloadRow([
        label,
        String(run.seedMs.toFixed(0)),
        reader.totalMs.toFixed(0),
        `${reader.perAppend.median.toFixed(2)} ms`,
        `${reader.head.toFixed(2)} ms`,
        `${reader.middle.toFixed(2)} ms`,
        `${reader.tail.toFixed(2)} ms`,
        String(reader.bytes),
      ])}`);
    }
    const ratio = run.revalidate.totalMs / run.incremental.totalMs;
    const provenance = run.incremental.provenance;
    console.log(`  ${''.padStart(46)}${`${ratio.toFixed(2)}x faster`.padStart(13)}${`  ${provenance.reuses} reuse(s), ${provenance.rebuilds} re-derivation(s), ${provenance.trackedRecords} tracked record(s)`}`);
  }
  console.log('  the first/middle/last columns are per-append medians over a 10-append window; growth across them is the quadratic behaviour, and the total column is why seeding a large store through ordinary writes is not practical to repeat');

  console.log('a damaged store must refuse a write (timed, same fixtures):');
  for (const spec of [
    { label: 'memory', file: 'memory', count: 2000, validateRecord: validateMemoryRecord, make: async (d, c, n) => writeMemoryFixture(d, c, n), writeOnce: memoryWriteOnce },
    { label: 'knowledge', file: 'knowledge', count: 200, validateRecord: validateKnowledgeRecord, make: async (d, c, n) => writeClaimFixture(d, c, n), writeOnce: knowledgeWriteOnce },
  ]) {
    const run = await damagedWrite(dir, { ...spec, repeats: Math.min(repeats, 5) });
    line(`${spec.label} write onto a store with an unterminated last line`, `${run.stats.median.toFixed(2)} ms (rejected ${run.rejected}/${run.attempts})`);
    line('  reported reason', run.message ?? 'NOT REJECTED - the write was accepted');
    line('  bytes left behind by the refused write', run.leftDamage.length === 0 ? 'none (the store is byte-identical after the refusal)' : `${run.leftDamage.length} sample(s) changed the file`);
  }

  const largestMemory = memoryRows[memoryRows.length - 1];
  const largestKnowledge = knowledgeRows[knowledgeRows.length - 1];
  console.log('write-path composition (largest measured fixture per store):');
  console.log('  these are differences of independently sampled medians, so a negative store-layer value means the');
  console.log('  append on its own was slower than the append inside the write - fsync timing noise at that size, not');
  console.log('  a saving. The cold and warm writes are both end-to-end public writes, so their difference is the cost');
  console.log('  of the whole-store re-derivation a freshly constructed instance pays.');
  for (const [label, row0] of [['memory', largestMemory], ['knowledge', largestKnowledge]]) {
    const c = row0.c;
    line(`${label} whole write, fresh instance (cold)`, `${c.write.median.toFixed(2)} ms for ${row0.count} record(s)`);
    line(`${label} whole write, already written once (warm)`, `${c.warmWrite.median.toFixed(2)} ms for ${row0.count} record(s)`);
    line('  of which the warm write read costs (incremental)', `${c.incrementalRead.median.toFixed(2)} ms`);
    line('  of which the append itself', `${c.append.median.toFixed(2)} ms`);
    line('  store-layer work (warm - incr read - append)', `${(c.warmWrite.median - c.incrementalRead.median - c.append.median).toFixed(2)} ms`);
    line('  the write read a whole-store revalidation costs instead', `${c.validatedRead.median.toFixed(2)} ms`);
    if (c.coldWriteRead) {
      line('  the write read a fresh instance performs now (Batch V)', `${c.coldWriteRead.median.toFixed(2)} ms`);
    }
    line('  integrity work the reuse skips per append', `${(c.validatedRead.median - c.incrementalRead.median).toFixed(2)} ms`);
    line('  re-derivation a restart pays (cold - warm)', `${(c.write.median - c.warmWrite.median).toFixed(2)} ms`);
    line('  read + whole-file hash of that read', `${c.readHash.median.toFixed(2)} ms`);
  }

  // V-06 asks whether conflict or lifecycle processing is worth indexing. That is only answerable
  // with a positive number for the work itself, because the composition above subtracts three
  // separately sampled medians and therefore cannot report a small value honestly.
  console.log('store-layer work inside one call (measured, not subtracted):');
  console.log('  one public write is timed whole, and the write read plus the append it performs are timed');
  console.log('  inside that same call. The difference is the conflict scan, the lifecycle rebuild, the record');
  console.log('  construction and the integrity checks - everything an incremental index could still remove.');
  for (const spec of [
    {
      label: 'memory',
      count: largestMemory.count,
      make: (d, c, name) => writeMemoryFixture(d, c, name),
      write: memoryAdd,
      open: async (target) => {
        const store = new MemoryStore(target);
        await memoryAdd(store, largestMemory.count, 'warm-up');
        return store;
      },
    },
    {
      label: 'knowledge',
      count: largestKnowledge.count,
      make: (d, c, name) => writeClaimFixture(d, c, name),
      write: claimAdd,
      open: async (target) => {
        const store = new KnowledgeStore(target);
        await claimAdd(store, largestKnowledge.count, 'warm-up');
        return store;
      },
    },
  ]) {
    const run = await inCallDecomposition(dir, {
      label: spec.label,
      count: spec.count,
      make: spec.make,
      warmStore: spec.open,
      publicWrite: spec.write,
      repeats,
    });
    const spread = (s) => `${s.median.toFixed(2)} ms (min ${s.min.toFixed(2)}, max ${s.max.toFixed(2)})`;
    line(`${spec.label} public write at ${run.count} record(s), whole call`, spread(run.totals));
    line('  its write read', spread(run.readMs));
    line('  its append', spread(run.appendMs));
    line('  store-layer work in the same call', spread(run.storeLayer));
    line('  log calls the write performed (read/append)', [...new Set(run.innerCalls)].join(', '));
    const p = run.provenance;
    line('  write-read provenance across these samples', `${p.reuses} reuse(s), ${p.rebuilds} re-derivation(s), ${p.trackedRecords} tracked record(s)`);
  }

  const end = footprint();
  console.log('process footprint:');
  line('rss / heap used at the end', `${fmt(end.rss)} / ${fmt(end.heap)}`);
  console.log('limits: one machine, one process, a temporary local directory, no concurrent writer and no model. Every measurement here re-reads the whole store, so the numbers are per-append costs at a given size, not an amortised cost; a store the size of these fixtures is far larger than a personal APEX install, which is why the absolute medians move with system load while the composition does not.');
}

async function main() {
  const opts = (() => {
    try {
      return parseArgs(process.argv.slice(2));
    } catch (err) {
      console.error(`bench: ${err.message}`);
      process.exit(2);
    }
  })();
  if (opts.help) {
    console.log('usage: node benchmarks/run-world-state-benchmark.mjs [--memory N] [--claims N] [--repeats R] [--keep]');
    console.log('       node benchmarks/run-world-state-benchmark.mjs --writes [--repeats R] [--full] [--keep]');
    console.log(`  N for --memory is 1-${MAX_MEMORY_FIXTURE}, for --claims 1-${MAX_CLAIM_FIXTURE}, for --repeats 1-${MAX_REPEATS}`);
    console.log(`  claims are seeded through KnowledgeStore.add, which re-reads the store per append; that is why --claims stays small`);
    console.log(`  the derived parse snapshot is capped at ${MEMORY_PARSE_CACHE_BYTES} bytes per store (memory) and ${KNOWLEDGE_PARSE_CACHE_BYTES} bytes per store (knowledge)`);
    console.log('  --writes measures the write path instead: the parts of one append at each store size, the');
    console.log('  derived-state operations on the same fixtures, cumulative append workloads, and the cost of');
    console.log('  the refusal a damaged store forces. Sizes are a fixed matrix (memory 200/2,000/20,000/40,000,');
    console.log('  knowledge 200/2,000) so two runs are comparable. The default run takes a few minutes.');
    console.log('  --full adds the 2,000-append cumulative workloads on top of that, which take several more.');
    return;
  }

  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'apex-world-bench-'));
  if (opts.writes) {
    console.log(`write-path benchmark, fixture sizes: memory ${WRITE_MEMORY_SIZES.join(', ')} record(s), knowledge ${WRITE_CLAIM_SIZES.join(', ')} claim(s)`);
    console.log(`data dir: ${dir} (temporary, removed unless --keep)`);
    const started = process.hrtime.bigint();
    await writePhases(dir, { repeats: opts.repeats, full: opts.full });
    console.log(`runtime: node ${process.version}, ${os.platform()} ${os.arch()}, ${os.cpus().length} logical cpus, ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GiB reported memory`);
    console.log(`elapsed: ${(Number(process.hrtime.bigint() - started) / 1e9).toFixed(1)} s`);
    if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
    else console.log(`kept: ${dir}`);
    return;
  }
  console.log(`fixture: ${opts.memory} memory record(s), ${opts.claims} knowledge claim(s), ${opts.repeats} timed sample(s) per read phase`);
  console.log(`data dir: ${dir} (temporary, removed unless --keep)`);

  const seedMemory = await timedAsync(() => writeMemoryFixture(dir, opts.memory));
  const seedKnowledge = await timedAsync(() => writeKnowledgeFixture(dir, opts.claims));
  const files = fileState(dir);
  console.log(`fixture files: memory.jsonl ${files['memory.jsonl'].bytes} bytes, knowledge.jsonl ${files['knowledge.jsonl'].bytes} bytes`);
  console.log(`fixture write: memory ${seedMemory.ms.toFixed(1)} ms, knowledge ${seedKnowledge.ms.toFixed(1)} ms (write cost, reported separately from read cost)`);

  const beforeReads = fileState(dir);
  const rssStart = footprint();

  // ---- reads that change nothing ---------------------------------------------------------
  const cached = storePair(dir, { parseCacheBytes: MEMORY_PARSE_CACHE_BYTES });
  const coldPrecondition = {
    memoryCached: cached.memory.log.parseCacheStats.cached,
    knowledgeCached: cached.knowledge.log.parseCacheBytes > 0 && cached.knowledge.log.parseCacheStats.cached,
  };
  const cold = await timedAsync(() => buildWorldState(contextOf(cached)));
  const warm = await sampleBuilds(cached, opts.repeats);

  const uncached = storePair(dir, { parseCacheBytes: 0 });
  await sampleBuilds(uncached, 1); // same page-cache state as the warm cached run
  const noCache = await sampleBuilds(uncached, opts.repeats);

  // Batch T's read strategy on the very same fixture and the very same store instances: no
  // derived snapshot, and four whole-store loads per projection instead of two. Subtracting
  // this from `noCache` isolates the cost of the read pattern from the cost of the snapshot.
  const legacy = await sampleLegacyBuilds(uncached, opts.repeats);
  const withoutClock = (world) => JSON.stringify({ ...world, generatedAt: null });
  const legacyMatches = withoutClock(legacy.world) === withoutClock(warm.world);

  const health = await timedAsync(() => Promise.all([cached.memory.health(), cached.knowledge.health()]));
  const render = timed(() => renderWorldState(warm.world));

  const cachedMemoryLoad = await sampleLoad(cached.memory.log, opts.repeats);
  const rawMemoryLog = new JsonlStore(path.join(dir, 'memory.jsonl'), { validateRecord: validateMemoryRecord });
  const uncachedMemoryLoad = await sampleLoad(rawMemoryLog, opts.repeats);
  const cachedKnowledgeLoad = await sampleLoad(cached.knowledge.log, opts.repeats);
  const rawKnowledgeLog = new JsonlStore(path.join(dir, 'knowledge.jsonl'), { validateRecord: validateKnowledgeRecord });
  const uncachedKnowledgeLoad = await sampleLoad(rawKnowledgeLog, opts.repeats);

  const action = worldActions()[0];
  const execSamples = [];
  const verifySamples = [];
  let verifiedOk = 0;
  for (let i = 0; i < Math.min(opts.repeats, 11); i += 1) {
    const ctx = contextOf(cached);
    const exec = await timedAsync(() => action.execute(ctx, { limit: undefined }));
    execSamples.push(exec.ms);
    const verify = await timedAsync(() => action.verify(ctx, { limit: undefined }, exec.result));
    verifySamples.push(verify.ms);
    if (verify.result.ok === true) verifiedOk += 1;
  }

  const readsUnchanged = JSON.stringify(beforeReads) === JSON.stringify(fileState(dir));
  const rssAfterReads = footprint();

  // ---- reads that follow a write ---------------------------------------------------------
  // Every append changes the file bytes, so the next read re-parses and re-validates the
  // whole store it reads. These phases measure that; they are not warm-read numbers.
  // Running the same phase on the snapshot-free pair measures what the snapshot costs a write:
  // the read inside a write happens before the bytes change, and the read after it is a
  // guaranteed miss, so neither should pay for snapshot maintenance.
  async function appendPhase(stores) {
    const memAppends = [];
    const memBuilds = [];
    for (let i = 0; i < Math.min(opts.repeats, 5); i += 1) {
      const content = `Appended belief ${i} after the warm read`;
      const append = await timedAsync(() => stores.memory.add({ content, source: 'user', provenance: { origin: 'user_request' } }));
      memAppends.push(append.ms);
      const build = await timedAsync(() => buildWorldState(contextOf(stores)));
      memBuilds.push(build.ms);
    }
    const knAppends = [];
    const knBuilds = [];
    for (let i = 0; i < Math.min(opts.repeats, 5); i += 1) {
      const append = await timedAsync(() => stores.knowledge.add({
        subject: `Annex ${i}`, relationship: 'row', object: `value ${i}`, origin: 'user',
      }));
      knAppends.push(append.ms);
      const build = await timedAsync(() => buildWorldState(contextOf(stores)));
      knBuilds.push(build.ms);
    }
    return { memAppends, memBuilds, knAppends, knBuilds };
  }

  const onWrite = await appendPhase(cached);
  const offWrite = await appendPhase(uncached);
  const rssAfterAppends = footprint();

  const coldStats = { min: cold.ms, median: cold.ms, max: cold.ms, n: 1 };
  const warmStats = stats(warm.samples);
  const noCacheStats = stats(noCache.samples);
  const legacyStats = stats(legacy.samples);
  const execStats = stats(execSamples);
  const verifyStats = stats(verifySamples);
  const pairStats = stats(execSamples.map((ms, i) => ms + verifySamples[i]));

  const line = (label, value) => console.log(`  ${label.padEnd(44)} ${value}`);
  console.log('projection build, stores unchanged:');
  line('cold first read (nothing derived)', `${coldStats.median.toFixed(1)} ms (n=${coldStats.n})`);
  line('  cold precondition', `snapshot present before it: ${JSON.stringify(coldPrecondition)}`);
  line('warm repeated read (snapshot hit)', `${warmStats.min.toFixed(1)} / ${warmStats.median.toFixed(1)} / ${warmStats.max.toFixed(1)} ms min/median/max (n=${warmStats.n})`);
  line('same read, snapshot switched off', `${noCacheStats.min.toFixed(1)} / ${noCacheStats.median.toFixed(1)} / ${noCacheStats.max.toFixed(1)} ms min/median/max (n=${noCacheStats.n})`);
  line('Batch T read pattern, snapshot off', `${legacyStats.min.toFixed(1)} / ${legacyStats.median.toFixed(1)} / ${legacyStats.max.toFixed(1)} ms min/median/max (n=${legacyStats.n})`);
  line('  Batch T vs switched-off, median', `${(legacyStats.median - noCacheStats.median).toFixed(1)} ms saved by the merged read alone`);
  line('  Batch T vs warm, median', `${(legacyStats.median - warmStats.median).toFixed(1)} ms saved by both changes together`);
  line('  legacy projection equals current', `${legacyMatches} (identical apart from generatedAt)`);
  line('warm vs switched-off median', `${(noCacheStats.median - warmStats.median).toFixed(1)} ms saved per read`);
  console.log('one store read, cached against uncached (median, cost is per store):');
  line('memory log.load() cached', `${stats(cachedMemoryLoad).median.toFixed(1)} ms (n=${cachedMemoryLoad.length})`);
  line('memory log.load() uncached', `${stats(uncachedMemoryLoad).median.toFixed(1)} ms`);
  line('knowledge log.load() cached', `${stats(cachedKnowledgeLoad).median.toFixed(1)} ms`);
  line('knowledge log.load() uncached', `${stats(uncachedKnowledgeLoad).median.toFixed(1)} ms`);
  console.log('other read-path costs:');
  line('store health scan (both stores, warm)', `${health.ms.toFixed(1)} ms`);
  line('render (display only)', `${render.ms.toFixed(1)} ms`);
  line(`execute, median (n=${execStats.n})`, `${execStats.median.toFixed(1)} ms`);
  line(`verify, independent re-read (n=${verifyStats.n})`, `${verifyStats.median.toFixed(1)} ms`);
  line('execute + verify together', `${pairStats.min.toFixed(1)} / ${pairStats.median.toFixed(1)} / ${pairStats.max.toFixed(1)} ms min/median/max`);
  line('verifications that passed', `${verifiedOk} of ${verifyStats.n}`);
  const memBuildOn = stats(onWrite.memBuilds);
  const memBuildOff = stats(offWrite.memBuilds);
  const memAddOn = stats(onWrite.memAppends);
  const memAddOff = stats(offWrite.memAppends);
  const knBuildOn = stats(onWrite.knBuilds);
  const knBuildOff = stats(offWrite.knBuilds);
  const knAddOn = stats(onWrite.knAppends);
  const knAddOff = stats(offWrite.knAppends);

  console.log('a read after a write re-parses the store that changed (snapshot on):');
  line('build after a memory append', `${memBuildOn.min.toFixed(1)} / ${memBuildOn.median.toFixed(1)} / ${memBuildOn.max.toFixed(1)} ms (n=${memBuildOn.n})`);
  line('  the memory append itself', `${memAddOn.median.toFixed(1)} ms median`);
  line('build after a knowledge append', `${knBuildOn.min.toFixed(1)} / ${knBuildOn.median.toFixed(1)} / ${knBuildOn.max.toFixed(1)} ms (n=${knBuildOn.n})`);
  line('  the knowledge append itself', `${knAddOn.median.toFixed(1)} ms median`);
  console.log('the same write phases with the snapshot switched off (Batch T reader):');
  line('build after a memory append', `${memBuildOff.min.toFixed(1)} / ${memBuildOff.median.toFixed(1)} / ${memBuildOff.max.toFixed(1)} ms (n=${memBuildOff.n})`);
  line('  the memory append itself', `${memAddOff.median.toFixed(1)} ms median`);
  line('build after a knowledge append', `${knBuildOff.min.toFixed(1)} / ${knBuildOff.median.toFixed(1)} / ${knBuildOff.max.toFixed(1)} ms (n=${knBuildOff.n})`);
  line('  the knowledge append itself', `${knAddOff.median.toFixed(1)} ms median`);
  console.log('what the snapshot costs the write path itself (median, same fixture):');
  line('memory add(), on minus off', `${(memAddOn.median - memAddOff.median).toFixed(1)} ms`);
  line('knowledge add(), on minus off', `${(knAddOn.median - knAddOff.median).toFixed(1)} ms`);
  line('read after a memory append, on minus off', `${(memBuildOn.median - memBuildOff.median).toFixed(1)} ms`);
  console.log('derived snapshot state at the end of the run (a performance aid, not stored data):');
  line('memory snapshot', JSON.stringify(cached.memory.log.parseCacheStats));
  line('knowledge snapshot', JSON.stringify(cached.knowledge.log.parseCacheStats));
  console.log('what the projection read:');
  line('represented beliefs', `${warm.world.counts.representedBeliefs} of ${opts.memory + opts.claims} stored records`);
  line('beliefs shown', `${warm.world.beliefs.shown}`);
  line('memory conflict groups', `${warm.world.counts.memoryConflictGroups}`);
  line('largest memory group', `${warm.world.contradictions.filter((g) => g.kind === 'memory').reduce((max, g) => Math.max(max, g.claimIds.length), 0)} record(s)`);
  line('complete / attention', `${warm.world.complete} / ${warm.world.attention}`);
  console.log('process footprint:');
  line('rss start / after reads / after appends', `${fmt(rssStart.rss)} / ${fmt(rssAfterReads.rss)} / ${fmt(rssAfterAppends.rss)}`);
  line('heap used start / after reads', `${fmt(rssStart.heap)} / ${fmt(rssAfterReads.heap)}`);

  console.log(`writes during the unchanged-store read phases: ${readsUnchanged ? 'none (every store file is byte-identical)' : 'CHANGED - this benchmark expected no writes'}`);
  const finalFiles = fileState(dir);
  console.log(`store files after the append phases: memory.jsonl ${finalFiles['memory.jsonl'].bytes} bytes (+${onWrite.memAppends.length + offWrite.memAppends.length} record(s)), knowledge.jsonl ${finalFiles['knowledge.jsonl'].bytes} bytes (+${onWrite.knAppends.length + offWrite.knAppends.length} claim(s))`);
  console.log(`runtime: node ${process.version}, ${os.platform()} ${os.arch()}, ${os.cpus().length} logical cpus, ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GiB reported memory`);
  console.log('limits: one machine, one warm page cache, a temporary local directory, no concurrent writer, no model. A cold read and a post-append read still parse and validate the whole store, so read cost is NOT independent of total store size; only an unchanged repeat read is cheaper. The "Batch T read pattern" line is the old strategy re-run on this fixture in this process; the figures recorded in benchmarks/README.md were measured before the optimization and may include system load, so prefer the in-run comparison.');

  if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
  else console.log(`kept: ${dir}`);
}

main().catch((err) => {
  console.error(`bench failed: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
