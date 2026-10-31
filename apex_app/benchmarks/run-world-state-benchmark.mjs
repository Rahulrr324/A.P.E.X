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
//
// Bounds: memory fixtures are written directly as valid records; claims are appended through
// KnowledgeStore.add (which re-reads the store per append), so seeding cost is reported
// separately from read cost. Claim fixtures stay small for that reason.
// This is not part of `npm test` and no test depends on it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { sha256Hex, MemoryStore, validateMemoryRecord, MEMORY_PARSE_CACHE_BYTES } from '../src/memory/memory-store.js';
import { KnowledgeStore, validateKnowledgeRecord, KNOWLEDGE_PARSE_CACHE_BYTES } from '../src/knowledge/knowledge-store.js';
import { JsonlStore } from '../src/memory/jsonl-store.js';
import { buildWorldState, renderWorldState } from '../src/world/world-state.js';
import { worldActions } from '../src/actions/world-actions.js';

const MAX_MEMORY_FIXTURE = 40000;
const MAX_CLAIM_FIXTURE = 2000;
const MAX_REPEATS = 25;

function parseArgs(argv) {
  const opts = { memory: 2000, claims: 2000, repeats: 7, keep: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--keep') {
      opts.keep = true;
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
function writeMemoryFixture(dir, count) {
  const createdAt = new Date(Date.UTC(2026, 0, 1)).toISOString();
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const content = `The archive index is entry${i}`;
    lines.push(JSON.stringify({
      schema: 1,
      id: randomUUID(),
      kind: 'user_fact',
      source: 'user',
      sensitivity: 'normal',
      content,
      contentSha256: sha256Hex(content),
      createdAt,
      provenance: { origin: 'user_request', updateMode: 'user_confirmed' },
    }));
  }
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

async function writeKnowledgeFixture(dir, count) {
  const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'), { now: () => new Date(Date.UTC(2026, 0, 1)) });
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
    console.log(`  N for --memory is 1-${MAX_MEMORY_FIXTURE}, for --claims 1-${MAX_CLAIM_FIXTURE}, for --repeats 1-${MAX_REPEATS}`);
    console.log(`  claims are seeded through KnowledgeStore.add, which re-reads the store per append; that is why --claims stays small`);
    console.log(`  the derived parse snapshot is capped at ${MEMORY_PARSE_CACHE_BYTES} bytes per store (memory) and ${KNOWLEDGE_PARSE_CACHE_BYTES} bytes per store (knowledge)`);
    return;
  }

  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'apex-world-bench-'));
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
