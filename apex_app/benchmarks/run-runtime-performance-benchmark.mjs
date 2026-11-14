// Bounded, network-free runtime performance benchmark for Batch AP-11.
//
// Every measured request is handled by the real controller against a fresh temporary data directory.
// The model is a deterministic in-process fixture object implementing the same small backend interface
// the HTTP backends implement; it returns fixed synthetic text. No inference is run, no socket is
// opened, no endpoint is named, and no model quality is claimed.
//
//   node benchmarks/run-runtime-performance-benchmark.mjs [--phase scaling|shapes|limits|all]
//        [--sizes 20,200,1000,4000,10000] [--repeats R] [--shape-size N] [--keep]
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
//
// Measurement rules: timings are monotonic (`performance.now`). Latency is measured on an
// uninstrumented application; read and construction counts are collected afterwards on a separate
// instrumented application, so counting never sits inside a timed request. A duration that was not
// produced is `null`, never zero. "Cold" means cold application state: the operating system's file
// cache is warm, so this is not a cold-disk measurement. Fixtures are written only into fresh temporary
// directories prefixed `apex-bench-ap10-`, removed at the end unless `--keep` is passed. This script is
// not part of `npm test`. Never run it concurrently with another benchmark or with the test suite.
import os from 'node:os';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { shortId } from '../src/util.js';
import {
  makeState, makeApp, addTargets, seed, countRecords, removeDir, dirs, QUESTION, TARGET, LAUNCH,
} from './run-retrieval-quality-benchmark.mjs';

const NOW = () => new Date('2026-06-01T00:00:00.000Z');

// A command result reports the record it created on the executed step, not at the top level.
function goalIdOf(result) {
  return result?.operation?.steps?.[0]?.result?.data?.goalId ?? null;
}
const DEFAULT_SIZES = [20, 200, 1000, 4000];
const DEFAULT_REPEATS = 5;
const MAX_REPEATS = 15;
const MAX_SIZE = 20000;
const NOISE = Array.from({ length: 380 }, (_, i) => `phras${String(i).padStart(4, '0')}`).join(' ');
const LONG_QUESTION = `${NOISE} launch code name`;

function parseArgs(argv) {
  const opts = {
    phase: 'all', sizes: DEFAULT_SIZES, repeats: DEFAULT_REPEATS, shapeSize: 200, keep: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--phase') {
      const value = String(argv[i + 1] ?? '');
      if (!['scaling', 'shapes', 'limits', 'all'].includes(value)) throw new Error('--phase must be scaling|shapes|limits|all');
      opts.phase = value;
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

// ---- driver -------------------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node benchmarks/run-runtime-performance-benchmark.mjs [--phase scaling|shapes|limits|all] [--sizes 20,200,1000,4000,10000] [--repeats R] [--shape-size N] [--keep]');
  console.log('  network-free; deterministic in-process model fixture; writes only into fresh temporary directories; not part of npm test');
} else {
  console.log(`node ${process.version} on ${process.platform} ${process.arch}, `
    + `${os.cpus().length} logical CPU(s), ${Math.round(os.totalmem() / 1073741824)} GiB reported memory`);
  console.log(`phase ${opts.phase}; sizes ${opts.sizes.join(', ')}; repeats ${opts.repeats}; shape size ${opts.shapeSize}`);
  console.log('No inference is run and no network is used. The model is an in-process fixture returning fixed');
  console.log('synthetic text. Every request goes through the real controller and the real persisted stores.');
  try {
    if (opts.phase === 'all' || opts.phase === 'scaling') await phaseScaling(opts);
    if (opts.phase === 'all' || opts.phase === 'shapes') await phaseShapes(opts);
    if (opts.phase === 'all' || opts.phase === 'limits') await phaseLimits(opts);
  } finally {
    if (opts.keep) console.log(`\nkept: ${dirs.join(', ')}`);
    else {
      for (const dir of dirs) removeDir(dir);
      console.log('\ntemporary data directories removed; nothing outside them was written.');
    }
  }
}