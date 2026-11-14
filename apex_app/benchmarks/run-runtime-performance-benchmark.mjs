// Bounded, network-free runtime performance benchmark for Batch AP-11.
//
// Every measured request is handled by the real controller against a fresh temporary data directory.
// The model is a deterministic in-process fixture object implementing the same small backend interface
// the HTTP backends implement; it returns fixed synthetic text. No inference is run, no socket is
// opened, no endpoint is named, and no model quality is claimed.
//
//   node benchmarks/run-runtime-performance-benchmark.mjs [--phase scaling|shapes|limits|compare|all]
//        [--sizes 20,200,1000,4000,10000] [--repeats R] [--shape-size N] [--compare-ref REF]
//        [--rounds R] [--keep]
//
// Phases:
//   scaling  one grounded question at each corpus size, COLD (a fresh application per sample, so no
//            parse snapshot and no derived lifecycle entry exists) and WARM (one application, repeated
//            requests). Reports median/min/max wall time, the per-stage trace, store read counts,
//            lifecycle-index construction and reuse counts, parse-snapshot hits and misses, and memory.
//   shapes   ten request shapes, each on its own isolated corpus, warm: simple factual, memory-only,
//            knowledge-only, multi-source, conflicting, long query, empty store, large knowledge store,
//            goal/plan, executive preview. Reported apart, never averaged.
//   limits   the bounded-read disclosure ladder: the same question over corpora holding 1, 3, 5, 6, 10,
//            20 and 40 matching records, reporting returned/matched/eligible/contributed, the exclusion
//            counts, the retrieval state and whether completeness was established.
//   compare  paired A/B against another revision (`--compare-ref`, e.g. the pre-AP-12 commit). One
//            deterministic corpus per size is seeded once, verified, and copied byte-for-byte per side,
//            per round. Both sides run the same driver (`request-read-side.mjs`, copied into the
//            extracted tree) in a separate process, alternating order each round so drift affects both
//            sides rather than one. A discarded settling run follows the corpus build: a store just
//            written is still being scanned and cached by the operating system, and measuring the first
//            real side inside that window reports the machine. Each side reports cold and warm medians,
//            stage medians, corpus counts it read for itself, and reuse counters. Round medians are
//            listed one per round and ranges are pooled over all rounds, so a summary can be checked
//            against its own samples. Ratios are computed inside each round and reported per round; a
//            cross-run absolute is never presented as a before/after number.
//
// Measurement rules: timings are monotonic (`performance.now`). Latency is measured on an
// uninstrumented application; read and construction counts are collected afterwards on a separate
// instrumented application, so counting never sits inside a timed request. A duration that was not
// produced is `null`, never zero. "Cold" means cold application state: the operating system's file
// cache is warm, so this is not a cold-disk measurement. Fixtures are written only into fresh temporary
// directories prefixed `apex-bench-ap10-` (the scaling, shapes and limits phases) or `apex-bench-ap12-`
// (the compare phase's seeded corpora and extracted trees), removed at the end unless `--keep` is
// passed. This script is not part of `npm test`. Never run it concurrently with another benchmark or
// with the test suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { shortId } from '../src/util.js';
import {
  makeState, makeApp, addTargets, seed, countRecords, removeDir, dirs, QUESTION, TARGET, LAUNCH,
} from './run-retrieval-quality-benchmark.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const NOW = () => new Date('2026-06-01T00:00:00.000Z');

// A command result reports the record it created on the executed step, not at the top level.
function goalIdOf(result) {
  return result?.operation?.steps?.[0]?.result?.data?.goalId ?? null;
}
const DEFAULT_SIZES = [20, 200, 1000, 4000, 10000];
const DEFAULT_REPEATS = 5;
const MAX_REPEATS = 15;
const MAX_SIZE = 20000;
const MAX_ROUNDS = 5;
// §7 engineering targets for a complete warm request, keyed by corpus size.
const WARM_TARGETS = new Map([[20, 100], [200, 150], [1000, 300], [4000, 700], [10000, 1500]]);
const NOISE = Array.from({ length: 380 }, (_, i) => `phras${String(i).padStart(4, '0')}`).join(' ');
const LONG_QUESTION = `${NOISE} launch code name`;

function parseArgs(argv) {
  const opts = {
    phase: 'all',
    sizes: DEFAULT_SIZES,
    repeats: DEFAULT_REPEATS,
    shapeSize: 200,
    compareRef: null,
    rounds: 2,
    keep: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--phase') {
      const value = String(argv[i + 1] ?? '');
      if (!['scaling', 'shapes', 'limits', 'compare', 'all'].includes(value)) throw new Error('--phase must be scaling|shapes|limits|compare|all');
      opts.phase = value;
      i += 1;
    } else if (arg === '--compare-ref') {
      const value = String(argv[i + 1] ?? '');
      if (!/^[A-Za-z0-9._/-]+$/.test(value)) throw new Error('--compare-ref must name a git revision');
      opts.compareRef = value;
      i += 1;
    } else if (arg === '--rounds') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > MAX_ROUNDS) throw new Error(`--rounds must be 1..${MAX_ROUNDS}`);
      opts.rounds = value;
      i += 1;
    } else if (arg === '--repeats') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > MAX_REPEATS) throw new Error(`--repeats must be 1..${MAX_REPEATS}`);
      opts.repeats = value;
      i += 1;
    } else if (arg === '--shape-size') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 2 || value > MAX_SIZE) throw new Error(`--shape-size must be 2..${MAX_SIZE}`);
      opts.shapeSize = value;
      i += 1;
    } else if (arg === '--sizes') {
      const value = String(argv[i + 1] ?? '').split(',').map((s) => Number(s.trim()));
      if (value.length === 0 || value.some((n) => !Number.isInteger(n) || n < 2 || n > MAX_SIZE)) throw new Error(`--sizes must be integers 2..${MAX_SIZE}`);
      opts.sizes = [...new Set(value)].sort((a, b) => a - b);
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function stats(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return { n: 0, median: null, min: null, max: null };
  const sorted = [...clean].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    median: sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
const ms = (v) => (Number.isFinite(v) ? `${v.toFixed(3)} ms` : 'n/a');
const mib = (v) => (Number.isFinite(v) ? `${(v / 1048576).toFixed(1)} MiB` : 'n/a');
const cnt = (v) => (v === null || v === undefined ? 'n/a' : String(v));

function fixtureGateway(text) {
  return new ModelGateway({
    backend: {
      name: 'ap11-fixture',
      provider: 'fixture',
      configured: true,
      describe: () => ({ configured: true, provider: 'fixture', endpoint: 'in-process fixture', model: 'fixture' }),
      health: async () => ({ available: true, detail: 'in-process fixture' }),
      complete: async () => ({
        ok: true, backend: 'ap11-fixture', provider: 'fixture', model: 'fixture',
        text: typeof text === 'function' ? text() : text,
        finishReason: 'stop', truncated: false, latencyMs: 0,
      }),
    },
  });
}

const replyFor = (evidenceId) => () => 'The lighthouse project status is green.\n'
  + `COGNITION ${JSON.stringify({
    schema: 1,
    decision: 'answer',
    answer: 'The lighthouse project status is green.',
    claims: [{ text: TARGET, evidence: [`ev:memory:${evidenceId}`], kind: 'supported' }],
  })}`;

const plainReply = 'The lighthouse project status is green.\n'
  + `COGNITION ${JSON.stringify({ schema: 1, decision: 'answer', answer: 'The lighthouse project status is green.', claims: [] })}`;

// Counting wrappers are installed on a separate application, never on one being timed.
function instrument(app) {
  const calls = {};
  const stores = {
    memory: app.memory, knowledge: app.knowledge, conversation: app.conversation,
    operations: app.operations, experience: app.experience, goals: app.goals, plans: app.plans,
  };
  const bump = (key) => { calls[key] = (calls[key] ?? 0) + 1; };
  for (const [label, store] of Object.entries(stores)) {
    if (!store) continue;
    for (const method of ['search', 'list', 'projectionRead', 'getMany', 'health']) {
      if (typeof store[method] !== 'function') continue;
      const key = `${label}.${method}`;
      const original = store[method].bind(store);
      store[method] = (...args) => { bump(key); return original(...args); };
    }
    if (store.log && typeof store.log.load === 'function') {
      const key = `${label}.log.load`;
      const original = store.log.load.bind(store.log);
      store.log.load = (...args) => { bump(key); return original(...args); };
    }
  }
  return calls;
}

function stageMedians(samples) {
  const byStage = new Map();
  for (const sample of samples) {
    for (const stage of sample) {
      if (!Number.isFinite(stage.durationMs)) continue;
      const list = byStage.get(stage.id) ?? [];
      list.push(stage.durationMs);
      byStage.set(stage.id, list);
    }
  }
  return [...byStage.entries()].map(([id, values]) => ({ id, ...stats(values) }));
}

function verdict(res) {
  const integrity = res.operation?.cognition?.responseIntegrity ?? null;
  const report = res.operation?.prompt?.retrievalReport ?? null;
  return {
    status: res.operation?.status ?? 'n/a',
    trust: integrity?.trust ?? 'n/a',
    retrieval: report?.state ?? 'n/a',
    complete: report?.complete ?? null,
    claims: integrity?.claims ?? null,
    citation: integrity?.citationCompleteness ?? null,
    sources: (report?.sources ?? []).map((s) => `${s.source} ${s.returned ?? 'n/a'}/${s.contributed ?? 'n/a'}`).join(', '),
    exclusions: (report?.sources ?? [])
      .filter((s) => (s.exclusions?.sourceLimit ?? 0) > 0 || (s.exclusions?.contextBudget ?? 0) > 0)
      .map((s) => `${s.source} limit ${s.exclusions.sourceLimit} budget ${s.exclusions.contextBudget}`)
      .join('; '),
  };
}

async function timedRequest(app, text) {
  const started = performance.now();
  const res = await app.controller.handle(text, { origin: 'user' });
  return { ms: performance.now() - started, res };
}

// ---- phase: scaling -----------------------------------------------------------------------------

// The pre-AP-11 tree has no derived-state reuse, so it reports no stats. `null` is printed as n/a
// rather than zero: an absent counter is not a measured zero.
function indexStats(store) {
  const stats = store?.lifecycleIndexStats;
  return stats ?? { builds: null, hits: null, misses: null, healthBuilds: null, healthHits: null };
}

async function phaseScaling(opts) {
  console.log('\n== scaling: one grounded question, cold and warm, per corpus size ==');
  console.log('   cold = a fresh application per sample (no parse snapshot, no derived lifecycle entry).');
  console.log('   warm = one application, repeated requests; the first request is a warm-up and is not measured.');
  const state = await makeState();
  for (const size of opts.sizes) {
    const actual = await state.growTo(size);
    const reply = replyFor(state.evidenceId);
    const memoryBefore = process.memoryUsage();

    const cold = [];
    const coldStages = [];
    for (let i = 0; i < opts.repeats; i += 1) {
      const fresh = makeApp(state.dir, reply);
      const sample = await timedRequest(fresh, QUESTION);
      cold.push(sample.ms);
      coldStages.push(sample.res.operation?.diagnostics?.stages ?? []);
    }

    const warmApp = makeApp(state.dir, reply);
    await timedRequest(warmApp, QUESTION);
    const warm = [];
    const warmStages = [];
    let lastWarm = null;
    for (let i = 0; i < opts.repeats; i += 1) {
      const sample = await timedRequest(warmApp, QUESTION);
      warm.push(sample.ms);
      warmStages.push(sample.res.operation?.diagnostics?.stages ?? []);
      lastWarm = sample.res;
    }

    // Counts come from a separate instrumented application, so no wrapper sits inside a timed request.
    const counted = makeApp(state.dir, reply);
    const calls = instrument(counted);
    await timedRequest(counted, QUESTION);
    await timedRequest(counted, QUESTION);
    const knowledgeStats = indexStats(counted.knowledge);
    const knowledgeParse = counted.knowledge.log.parseCacheStats;
    const memoryParse = counted.memory.log.parseCacheStats;
    const memoryAfter = process.memoryUsage();

    const c = stats(cold);
    const w = stats(warm);
    console.log(`\n  size ${size} — corpus verified: memory ${actual.memory}, knowledge ${actual.knowledge}`);
    console.log(`    cold  ${ms(c.median).padStart(12)} median (${ms(c.min)} .. ${ms(c.max)}) over ${c.n} sample(s)`);
    console.log(`    warm  ${ms(w.median).padStart(12)} median (${ms(w.min)} .. ${ms(w.max)}) over ${w.n} sample(s)`);
    const v = verdict(lastWarm);
    console.log(`    verdict ${v.status} / trust ${v.trust} / retrieval ${v.retrieval} (complete ${v.complete})`);
    console.log(`    claims ${JSON.stringify(v.claims)}; citation ${JSON.stringify(v.citation)}`);
    console.log(`    returned/contributed ${v.sources}${v.exclusions ? `; exclusions ${v.exclusions}` : ''}`);
    console.log(`    lifecycle indexes: builds ${knowledgeStats.builds}, hits ${knowledgeStats.hits}, misses ${knowledgeStats.misses}; health builds ${knowledgeStats.healthBuilds}, hits ${knowledgeStats.healthHits} (two requests)`);
    console.log(`    parse snapshot: knowledge hits ${knowledgeParse.hits} misses ${knowledgeParse.misses}; memory hits ${memoryParse.hits} misses ${memoryParse.misses}`);
    const reads = Object.entries(calls).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    console.log(`    store reads over two requests: ${reads.map(([k, n]) => `${k} ${n}`).join(', ')}`);
    console.log('    warm per-stage medians:');
    for (const stage of stageMedians(warmStages)) {
      console.log(`      ${stage.id.padEnd(26)} ${ms(stage.median).padStart(12)} (${ms(stage.min)} .. ${ms(stage.max)})`);
    }
    console.log(`    memory: rss ${mib(memoryBefore.rss)} -> ${mib(memoryAfter.rss)}, heapUsed ${mib(memoryBefore.heapUsed)} -> ${mib(memoryAfter.heapUsed)}`);
  }
}

// ---- phase: shapes ------------------------------------------------------------------------------

// Each shape owns an isolated corpus. `build` receives the app and returns the question to ask.
const SHAPES = [
  {
    name: 'simple factual',
    async build(app) { await addTargets(app); return QUESTION; },
  },
  {
    name: 'memory-only',
    async build(app) {
      await app.memory.add({ content: TARGET, kind: 'user_fact', source: 'user' });
      return QUESTION;
    },
  },
  {
    name: 'knowledge-only',
    async build(app) {
      await app.knowledge.add({ subject: 'lighthouse project', relationship: 'status', object: 'green', origin: 'user' });
      return 'what is the lighthouse project status';
    },
  },
  {
    name: 'multi-source',
    async build(app) {
      await app.memory.add({ content: TARGET, kind: 'user_fact', source: 'user' });
      await app.knowledge.add({ subject: 'lighthouse project', relationship: 'status', object: 'green', origin: 'user' });
      return QUESTION;
    },
  },
  {
    name: 'conflicting',
    async build(app) {
      await app.memory.add({ content: TARGET, kind: 'user_fact', source: 'user' });
      await app.knowledge.add({ subject: 'lighthouse project', relationship: 'status', object: 'green', origin: 'user' });
      await app.knowledge.add({ subject: 'lighthouse project', relationship: 'status', object: 'red', origin: 'user' });
      return QUESTION;
    },
  },
  {
    name: 'long query',
    async build(app) {
      await app.memory.add({ content: LAUNCH, kind: 'user_fact', source: 'user' });
      await seed(app, 198, 198);
      return LONG_QUESTION;
    },
  },
  {
    name: 'empty store',
    async build() { return QUESTION; },
  },
  {
    name: 'large knowledge store',
    async build(app, size) {
      await app.memory.add({ content: TARGET, kind: 'user_fact', source: 'user' });
      await seed(app, 0, size - 1);
      return QUESTION;
    },
  },
  {
    name: 'goal/plan',
    async build(app) {
      await addTargets(app);
      const created = await app.controller.goalAdd({
        request: 'keep the lighthouse project status current',
        criteria: [{ description: 'the status note is recorded', basis: 'user_stated' }],
      });
      const goalId = goalIdOf(created);
      if (!goalId) throw new Error(`the goal fixture could not be created: ${created?.status} ${created?.output}`);
      await app.controller.goalUpdate({ target: goalId, status: 'accepted' });
      await app.controller.goalUpdate({ target: goalId, status: 'active' });
      return `prepare a plan for goal ${shortId(goalId)}`;
    },
  },
  {
    name: 'executive preview',
    async build(app) {
      await addTargets(app);
      const created = await app.controller.goalAdd({
        request: 'keep the lighthouse project status current',
        criteria: [{ description: 'the status note is recorded', basis: 'user_stated' }],
      });
      const goalId = goalIdOf(created);
      if (!goalId) throw new Error(`the goal fixture could not be created: ${created?.status} ${created?.output}`);
      await app.controller.goalUpdate({ target: goalId, status: 'accepted' });
      await app.controller.goalUpdate({ target: goalId, status: 'active' });
      await app.controller.handle(`prepare a plan for goal ${shortId(goalId)}`, { origin: 'user' });
      return 'what is the overall status?';
    },
  },
];

async function phaseShapes(opts) {
  console.log(`\n== shapes: ten request shapes, warm, isolated corpus each (filler size ${opts.shapeSize}) ==`);
  console.log('   Reported apart. No shape is averaged into another and no overall quality number is computed.');
  for (const shape of SHAPES) {
    const state = await makeState();
    const app = state.app;
    let question;
    let buildMs = null;
    try {
      const started = performance.now();
      question = await shape.build(app, opts.shapeSize);
      buildMs = performance.now() - started;
      // The fixture reply cites the memory target when one exists; otherwise it asserts nothing.
      const target = (await app.memory.search(TARGET, { limit: 1 }))[0]?.record?.id ?? null;
      const gatewayApp = makeApp(state.dir, target ? replyFor(target) : () => plainReply);
      await timedRequest(gatewayApp, question);
      const samples = [];
      let last = null;
      for (let i = 0; i < opts.repeats; i += 1) {
        const sample = await timedRequest(gatewayApp, question);
        samples.push(sample.ms);
        last = sample.res;
      }
      const s = stats(samples);
      const v = verdict(last);
      const counts = countRecords(gatewayApp);
      console.log(`\n  ${shape.name}`);
      console.log(`    question ${question.length > 70 ? `${question.slice(0, 67)}... (${question.length} chars)` : question}`);
      console.log(`    corpus memory ${counts.memory}, knowledge ${counts.knowledge}; fixture build ${ms(buildMs)}`);
      console.log(`    warm ${ms(s.median).padStart(12)} median (${ms(s.min)} .. ${ms(s.max)}) over ${s.n} sample(s)`);
      console.log(`    verdict ${v.status} / trust ${v.trust} / retrieval ${v.retrieval} (complete ${v.complete})`);
      console.log(`    returned/contributed ${v.sources || 'none'}${v.exclusions ? `; exclusions ${v.exclusions}` : ''}`);
      const shapeStats = indexStats(gatewayApp.knowledge);
      console.log(`    lifecycle builds ${cnt(shapeStats.builds)}, hits ${cnt(shapeStats.hits)}`);
    } finally {
      removeDir(state.dir);
      const at = dirs.indexOf(state.dir);
      if (at !== -1) dirs.splice(at, 1);
    }
  }
}

// ---- phase: limits ------------------------------------------------------------------------------

const LIMITS_QUESTION = 'lighthouse project status note green';

// Fillers that share no content word with the question, so `matched` counts exactly the records the
// row names. The shared benchmark seed cannot be used here: its fillers contain "lighthouse", which
// would make every row report the whole corpus as matched and hide where the bound actually bites.
async function seedDisjoint(app, memoryCount, knowledgeCount) {
  for (let i = 1; i <= memoryCount; i += 1) {
    await app.memory.add({ content: `the harbour ledger entry ${i} was filed`, kind: 'user_fact', source: 'user' });
  }
  for (let i = 1; i <= knowledgeCount; i += 1) {
    await app.knowledge.add({ subject: 'harbour ledger', relationship: 'entry number', object: `${i}`, origin: 'user' });
  }
}

function limitLine(entry) {
  if (!entry) return 'not searched';
  return `returned ${entry.returned}, matched ${entry.matched}, eligible ${entry.eligible}, `
    + `contributed ${entry.contributed}, limit-excluded ${entry.exclusions?.sourceLimit ?? 'n/a'}, `
    + `budget-excluded ${entry.exclusions?.contextBudget ?? 'n/a'}, state ${entry.state}, complete ${entry.complete}`;
}

async function phaseLimits(opts) {
  console.log('\n== limits: the bounded-read disclosure ladder ==');
  console.log('   The same question over corpora holding a known number of matching records, with fillers');
  console.log('   that share no content word with it, so "matched" counts exactly those records. The bounds');
  console.log('   are the application\'s own: memory search 5, knowledge prompt 3, evidence per source 6,');
  console.log('   evidence total 36, prompt 6000 chars. Nothing here widens a bound; it reports what each one');
  console.log('   excludes. Knowledge prompt lines are read from the built prompt, not inferred.');
  const size = Math.max(40, opts.shapeSize);
  for (const matching of [1, 3, 5, 6, 10, 20, 40]) {
    const state = await makeState();
    try {
      const app = state.app;
      for (let i = 0; i < matching; i += 1) {
        await app.memory.add({
          content: `the lighthouse project status note ${i} is green`, kind: 'user_fact', source: 'user',
        });
        await app.knowledge.add({
          subject: `lighthouse project note ${i}`, relationship: 'status', object: 'green', origin: 'user',
        });
      }
      await seedDisjoint(app, Math.max(0, size - matching), Math.max(0, size - matching));
      const measured = makeApp(state.dir, () => plainReply);
      await timedRequest(measured, LIMITS_QUESTION);
      const samples = [];
      let last = null;
      for (let i = 0; i < opts.repeats; i += 1) {
        const sample = await timedRequest(measured, LIMITS_QUESTION);
        samples.push(sample.ms);
        last = sample.res;
      }
      const s = stats(samples);
      const prompt = last.operation?.prompt ?? null;
      const report = prompt?.retrievalReport ?? null;
      const memory = report?.sources?.find((entry) => entry.source === 'memory') ?? null;
      const knowledge = report?.sources?.find((entry) => entry.source === 'knowledge') ?? null;
      console.log(`\n  matching records ${String(matching).padStart(2)} | corpus ${size} per store | warm ${ms(s.median)} (${ms(s.min)} .. ${ms(s.max)})`);
      console.log(`    memory    ${limitLine(memory)}`);
      console.log(`    knowledge ${limitLine(knowledge)}`);
      console.log(`    prompt knowledge lines ${prompt?.knowledgeIds?.length ?? 'n/a'} (the prompt bound is 3); evidence read offered ${knowledge?.eligible ?? 'n/a'} (the per-source evidence bound is 6)`);
      console.log(`    overall ${report?.state ?? 'n/a'} (complete ${report?.complete ?? 'n/a'}); limitations ${(report?.limitations ?? []).length}`);
      for (const line of report?.limitations ?? []) console.log(`      - ${line}`);
    } finally {
      removeDir(state.dir);
      const at = dirs.indexOf(state.dir);
      if (at !== -1) dirs.splice(at, 1);
    }
  }
}

// ---- phase: compare (paired A/B against another revision) ---------------------------------------

function removeScratch(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  const real = fs.realpathSync(dir);
  if (!real.startsWith(fs.realpathSync(os.tmpdir()))) {
    throw new Error(`refusing to remove a non-temporary directory: ${real}`);
  }
  fs.rmSync(real, { recursive: true, force: true });
}

// The baseline tree comes from `git archive`, so the working tree is never touched. The same
// driver file is copied into it: both sides then run identical measurement code and differ only
// in the application modules resolved from `../src`.
function extractRevision(ref) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'apex-bench-ap12-ref-'));
  const tar = path.join(dir, 'tree.tar');
  const archive = spawnSync('git', ['-C', REPO_ROOT, 'archive', '--format=tar', '-o', tar, ref, 'apex_app'], {
    encoding: 'utf8', windowsHide: true,
  });
  if (archive.status !== 0) {
    removeScratch(dir);
    throw new Error(`git archive ${ref} failed: ${archive.stderr || `status ${archive.status}`}`);
  }
  // The archive is named relatively and read from the extraction directory: GNU tar splits an
  // argument at the first colon, so a Windows drive path (`C:\...`) is taken as a remote host.
  const extract = spawnSync('tar', ['-xf', 'tree.tar'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (extract.status !== 0) {
    removeScratch(dir);
    throw new Error(`extracting the ${ref} tree failed: ${extract.stderr || `status ${extract.status}`}`);
  }
  fs.rmSync(tar, { force: true });
  const appRoot = path.join(dir, 'apex_app');
  if (!fs.existsSync(path.join(appRoot, 'src', 'app.js'))) {
    removeScratch(dir);
    throw new Error(`revision ${ref} has no apex_app/src/app.js`);
  }
  fs.copyFileSync(
    path.join(APP_ROOT, 'benchmarks', 'request-read-side.mjs'),
    path.join(appRoot, 'benchmarks', 'request-read-side.mjs'),
  );
  return { dir, appRoot };
}

function runSide({ appRoot, dataDir, target, side, size, json, repeats }) {
  const result = spawnSync(process.execPath, [
    path.join(appRoot, 'benchmarks', 'request-read-side.mjs'),
    '--dir', dataDir,
    '--target', target,
    '--repeats', String(repeats),
    '--json', json,
    '--side', side,
    '--size', String(size),
  ], { encoding: 'utf8', windowsHide: true, timeout: 600000 });
  if (result.status !== 0) {
    throw new Error(`${side} side failed at size ${size}: ${result.stderr || result.stdout || `status ${result.status}`}`);
  }
  return JSON.parse(fs.readFileSync(json, 'utf8'));
}

const ratioText = (value) => (Number.isFinite(value) ? `${value.toFixed(2)}x` : 'n/a');

function medianOf(values) {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 0 ? (clean[mid - 1] + clean[mid]) / 2 : clean[mid];
}

function stageTable(base, side) {
  const ids = [...new Set([...base, ...side].map((stage) => stage.id))];
  const rows = [];
  for (const id of ids) {
    const b = base.find((stage) => stage.id === id)?.median ?? null;
    const c = side.find((stage) => stage.id === id)?.median ?? null;
    rows.push({ id, base: b, current: c, ratio: b && c ? c / b : null });
  }
  return rows;
}

async function phaseCompare(opts) {
  if (!opts.compareRef) throw new Error('--phase compare requires --compare-ref <git revision>');
  const baseline = extractRevision(opts.compareRef);
  const runRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'apex-bench-ap12-ab-'));
  const scratch = [baseline.dir, runRoot];
  console.log(`\n== compare: paired A/B against ${opts.compareRef} ==`);
  console.log('   One deterministic corpus per size is seeded once, its exact record counts verified, and');
  console.log('   copied byte-for-byte for each side and round. Both sides run the same driver in a separate');
  console.log('   process. Rounds alternate order; ratios are computed within a round, never across runs.');
  try {
    for (const size of opts.sizes) {
      const state = await makeState();
      const pristine = path.join(runRoot, `seed-${size}`);
      let target = null;
      try {
        await state.growTo(size);
        target = state.evidenceId;
        fs.cpSync(state.dir, pristine, { recursive: true });
      } finally {
        removeDir(state.dir);
        const at = dirs.indexOf(state.dir);
        if (at !== -1) dirs.splice(at, 1);
      }

      // A discarded run absorbs what the corpus build leaves behind (file cache churn, antivirus
      // scans of thousands of freshly appended records). Measuring the first real side inside that
      // window reports the machine, not the code; its result is never read.
      const settleDir = path.join(runRoot, `run-${size}-settle`);
      fs.cpSync(pristine, settleDir, { recursive: true });
      runSide({
        appRoot: APP_ROOT, dataDir: settleDir, target, side: 'settle', size,
        json: path.join(runRoot, `result-${size}-settle.json`), repeats: 1,
      });
      fs.rmSync(settleDir, { recursive: true, force: true });

      const results = { baseline: [], current: [] };
      for (let round = 1; round <= opts.rounds; round += 1) {
        const order = round % 2 === 1
          ? [['baseline', baseline.appRoot], ['current', APP_ROOT]]
          : [['current', APP_ROOT], ['baseline', baseline.appRoot]];
        for (const [side, appRoot] of order) {
          const dataDir = path.join(runRoot, `run-${size}-${round}-${side}`);
          const json = path.join(runRoot, `result-${size}-${round}-${side}.json`);
          fs.cpSync(pristine, dataDir, { recursive: true });
          results[side].push(runSide({
            appRoot, dataDir, target, side, size, json, repeats: opts.repeats,
          }));
        }
      }

      for (const side of ['baseline', 'current']) {
        for (const sample of results[side]) {
          if (sample.corpus.memory !== size || sample.corpus.knowledge !== size) {
            throw new Error(`${side} side read a corpus of ${sample.corpus.memory}/${sample.corpus.knowledge} records, `
              + `not the verified ${size}/${size}`);
          }
        }
      }

      const coldRatios = results.current.map((sample, i) => sample.cold.median / results.baseline[i].cold.median);
      const warmRatios = results.current.map((sample, i) => sample.warm.median / results.baseline[i].warm.median);
      const baseWarm = results.baseline.map((sample) => sample.warm.median);
      const currentWarm = results.current.map((sample) => sample.warm.median);
      const targetMs = WARM_TARGETS.get(size) ?? null;

      // Round medians are listed one per round; the min..max span is pooled over every sample in
      // every round, so the summary median always falls inside the printed span. Mixing a
      // cross-round median with one round's range is how a summary ends up contradicting itself.
      const roundList = (values) => values.map((v) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a')).join(' / ');
      const span = (samples, key) => {
        const mins = samples.map((sample) => sample[key].min).filter(Number.isFinite);
        const maxs = samples.map((sample) => sample[key].max).filter(Number.isFinite);
        if (mins.length === 0) return 'n/a';
        return `${ms(Math.min(...mins))} .. ${ms(Math.max(...maxs))}`;
      };

      console.log(`\n  size ${size} — each side verified its own corpus: memory ${size}, knowledge ${size}`);
      console.log(`    baseline cold ${roundList(results.baseline.map((s) => s.cold.median))} ms; warm ${roundList(baseWarm)} ms (medians, one per round)`);
      console.log(`    current  cold ${roundList(results.current.map((s) => s.cold.median))} ms; warm ${roundList(currentWarm)} ms (medians, one per round)`);
      console.log(`    baseline cold ${span(results.baseline, 'cold')}; warm ${span(results.baseline, 'warm')} (min .. max, all rounds)`);
      console.log(`    current  cold ${span(results.current, 'cold')}; warm ${span(results.current, 'warm')} (min .. max, all rounds)`);
      console.log(`    paired cold ratio ${coldRatios.map(ratioText).join(', ')} (current/baseline, per round); median ${ratioText(medianOf(coldRatios))}`);
      console.log(`    paired warm ratio ${warmRatios.map(ratioText).join(', ')} (current/baseline, per round); median ${ratioText(medianOf(warmRatios))}`
        + ` (speedup ${Number.isFinite(medianOf(warmRatios)) ? `${(1 / medianOf(warmRatios)).toFixed(2)}x` : 'n/a'})`);
      if (targetMs !== null) {
        const current = medianOf(currentWarm);
        const verdict = current === null ? 'not measured' : current <= targetMs ? 'met' : 'missed';
        console.log(`    warm target ${targetMs} ms: ${verdict} (current ${current === null ? 'n/a' : `${current.toFixed(1)} ms`}, median of round medians)`);
      }
      for (const side of ['baseline', 'current']) {
        const sample = results[side].at(-1);
        console.log(`    ${side.padEnd(8)} last round: trust ${sample.verdict.trust ?? 'n/a'}, retrieval ${sample.verdict.retrieval ?? 'n/a'}`
          + ` (complete ${sample.verdict.complete ?? 'n/a'}), status ${sample.verdict.status ?? 'n/a'}`);
      }
      const baseStages = results.baseline.at(-1).warmStages;
      const currentStages = results.current.at(-1).warmStages;
      console.log('    warm stage medians (baseline -> current, ratio; last round):');
      for (const row of stageTable(baseStages, currentStages)) {
        console.log(`      ${row.id.padEnd(26)} ${ms(row.base).padStart(12)} -> ${ms(row.current).padStart(12)}  ${ratioText(row.ratio)}`);
      }
      const baseLifecycle = results.baseline.at(-1).lifecycle;
      const currentLifecycle = results.current.at(-1).lifecycle;
      console.log(`    knowledge lifecycle indexes: baseline builds ${cnt(baseLifecycle?.builds)} hits ${cnt(baseLifecycle?.hits)}; `
        + `current builds ${cnt(currentLifecycle?.builds)} hits ${cnt(currentLifecycle?.hits)}`);
      const baseKnowledgeRetrieval = results.baseline.at(-1).knowledgeRetrieval;
      const currentKnowledgeRetrieval = results.current.at(-1).knowledgeRetrieval;
      const baseMemoryRetrieval = results.baseline.at(-1).memoryRetrieval;
      const currentMemoryRetrieval = results.current.at(-1).memoryRetrieval;
      console.log(`    knowledge retrieval reuse: baseline ${baseKnowledgeRetrieval ? `builds ${baseKnowledgeRetrieval.builds} hits ${baseKnowledgeRetrieval.hits}` : 'n/a'}; `
        + `current builds ${cnt(currentKnowledgeRetrieval?.builds)} hits ${cnt(currentKnowledgeRetrieval?.hits)}`);
      console.log(`    memory retrieval reuse: baseline ${baseMemoryRetrieval ? `builds ${baseMemoryRetrieval.builds} hits ${baseMemoryRetrieval.hits}` : 'n/a'}; `
        + `current builds ${cnt(currentMemoryRetrieval?.builds)} hits ${cnt(currentMemoryRetrieval?.hits)}`);
      const baseParse = results.baseline.at(-1).parse;
      const currentParse = results.current.at(-1).parse;
      console.log(`    parse snapshot: baseline knowledge ${cnt(baseParse.knowledge?.hits)}/${cnt(baseParse.knowledge?.misses)} `
        + `memory ${cnt(baseParse.memory?.hits)}/${cnt(baseParse.memory?.misses)} hits/misses; `
        + `current knowledge ${cnt(currentParse.knowledge?.hits)}/${cnt(currentParse.knowledge?.misses)} `
        + `memory ${cnt(currentParse.memory?.hits)}/${cnt(currentParse.memory?.misses)}`);
      const baseMemory = results.baseline.at(-1).memory;
      const currentMemory = results.current.at(-1).memory;
      console.log(`    process memory (warm end): baseline rss ${mib(baseMemory.rssAfter)} heap ${mib(baseMemory.heapAfter)}; `
        + `current rss ${mib(currentMemory.rssAfter)} heap ${mib(currentMemory.heapAfter)}`);
    }
  } finally {
    if (opts.keep) console.log(`\nkept comparison scratch: ${scratch.join(', ')}`);
    else for (const dir of scratch) removeScratch(dir);
  }
}

// ---- driver -------------------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node benchmarks/run-runtime-performance-benchmark.mjs [--phase scaling|shapes|limits|compare|all] '
    + '[--sizes 20,200,1000,4000,10000] [--repeats R] [--shape-size N] [--compare-ref REF] [--rounds R] [--keep]');
  console.log('  network-free; deterministic in-process model fixture; writes only into fresh temporary directories; not part of npm test');
  console.log('  --phase compare requires --compare-ref, e.g. the pre-AP-12 commit; both sides run the same driver');
} else {
  console.log(`node ${process.version} on ${process.platform} ${process.arch}, `
    + `${os.cpus().length} logical CPU(s), ${Math.round(os.totalmem() / 1073741824)} GiB reported memory`);
  console.log(`phase ${opts.phase}; sizes ${opts.sizes.join(', ')}; repeats ${opts.repeats}; shape size ${opts.shapeSize}`);
  console.log('No inference is run and no network is used. The model is an in-process fixture returning fixed');
  console.log('synthetic text. Every request goes through the real controller and the real persisted stores.');
  try {
    if (opts.phase === 'compare') await phaseCompare(opts);
    else {
      if (opts.phase === 'all' || opts.phase === 'scaling') await phaseScaling(opts);
      if (opts.phase === 'all' || opts.phase === 'shapes') await phaseShapes(opts);
      if (opts.phase === 'all' || opts.phase === 'limits') await phaseLimits(opts);
      if (opts.phase === 'all' && opts.compareRef) await phaseCompare(opts);
    }
  } finally {
    if (opts.keep) console.log(`\nkept: ${dirs.join(', ')}`);
    else {
      for (const dir of dirs) removeDir(dir);
      console.log('\ntemporary data directories removed; nothing outside them was written.');
    }
  }
}