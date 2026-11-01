#!/usr/bin/env node
// Batch Y offline performance - no inference, no endpoint, no benchmark overlap.
//
//   node experiments/batch-y/perf-ab.mjs --label=B --tree=<apex_app root> --mode=repeat|trim|growth --out=<dir>
//
// Everything here measures the deterministic application path only: the "model" is an
// in-process stub that returns a constant string and performs no work, so a measured
// millisecond is APEX work, never generation time. Nothing is launched, nothing is
// downloaded, and each mode runs sequentially in one process.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, def = undefined) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? def : hit.slice(name.length + 3);
};
const label = opt('label');
const tree = opt('tree');
const mode = opt('mode');
const outDir = opt('out');
if (!label || !tree || !mode || !outDir) {
  console.error('usage: perf-ab.mjs --label=A|B --tree=<root> --mode=repeat|trim|growth --out=<dir>');
  process.exit(2);
}
const root = pathToFileURL(path.resolve(tree)).href;
fs.mkdirSync(outDir, { recursive: true });

const { SCENARIOS, FIXED_NOW_ISO } = await import(new URL('./dataset.js', import.meta.url).href);
const { createApp } = await import(`${root}/src/app.js`);
const { ModelGateway } = await import(`${root}/src/model/gateway.js`);
const { Outcome } = await import(`${root}/src/outcomes.js`);
const { buildWorldState } = await import(`${root}/src/world/world-state.js`);

const NOW = () => new Date(FIXED_NOW_ISO);
const REPEATS = 7;

// The stub also records the exact prompt it was handed, so the budget ladder can state what
// the assembled context actually looked like rather than only its length.
const stub = (reply, sink = {}) => {
  sink.prompt = null;
  return new ModelGateway({
    backend: {
      name: 'batch-y-stub',
      provider: 'batch-y-stub',
      configured: true,
      describe: () => ({ configured: true, provider: 'batch-y-stub' }),
      health: async () => ({ available: true, detail: 'in-process stub' }),
      complete: async ({ prompt }) => {
        sink.prompt = prompt;
        return {
          ok: true, backend: 'batch-y-stub', provider: 'batch-y-stub', model: 'batch-y-stub',
          text: reply, finishReason: 'stop', truncated: false, latencyMs: 0,
        };
      },
    },
  });
};

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `apex-y-perf-${label}-${tag}-`));
}

async function seedScenario(app, scenario) {
  const ids = {};
  for (const step of scenario.steps) {
    if (step.op === 'memory') {
      const res = await app.controller.runAction('memory.add', {
        content: step.content, ...(step.sensitivity ? { sensitivity: step.sensitivity } : {}),
      }, 'user', 'seed');
      ids[step.alias] = res.result.data.id;
    } else if (step.op === 'knowledge') {
      const res = await app.controller.knowledgeAdd({
        subject: step.subject, relationship: step.relationship, object: step.object,
        evidence: step.evidence ?? null,
        supersedes: step.supersedesAlias ? [ids[step.supersedesAlias]] : [],
      });
      if (res.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`knowledgeAdd ${res.output}`);
      const [newest] = await app.knowledge.list({ limit: 1 });
      ids[step.alias] = newest.id;
    } else if (step.op === 'resolve') {
      await app.controller.knowledgeResolve({ target: ids[step.target], choose: ids[step.choose], reason: step.reason ?? null });
    } else if (step.op === 'retract') {
      await app.controller.knowledgeRetract({ target: ids[step.target], reason: step.reason ?? null });
    }
  }
  return ids;
}

// Count every store method call for one request, and read the derived-snapshot counters
// around it (they live on the underlying JsonlStore, `store.log`).
function instrument(stores) {
  const totals = {};
  for (const [bucket, store] of Object.entries(stores)) {
    if (!store) continue;
    const proto = Object.getPrototypeOf(store);
    for (const name of new Set([...Object.keys(store), ...(proto ? Object.getOwnPropertyNames(proto) : [])])) {
      if (name === 'constructor' || name.startsWith('_')) continue;
      let fn;
      try { fn = store[name]; } catch { continue; }
      if (typeof fn !== 'function') continue;
      const key = `${bucket}.${name}`;
      totals[key] = 0;
      store[name] = function (...args) { totals[key] += 1; return fn.apply(this, args); };
    }
  }
  return totals;
}

const snap = (store) => {
  const out = {};
  for (const key of ['parseCacheStats', 'appendStateStats']) {
    const v = store?.log?.[key];
    if (v && typeof v === 'object') out[key] = v;
  }
  return out;
};

const ms = (big) => Number(big) / 1e6;
const readStores = (dir) => ['memory.jsonl', 'knowledge.jsonl']
  .map((n) => {
    const p = path.join(dir, n);
    return fs.existsSync(p) ? fs.readFileSync(p).toString('hex') : '(absent)';
  });
const sameStores = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hr = () => process.hrtime.bigint();
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const minmax = (a) => [Math.min(...a), Math.max(...a)];

const results = { label, tree: path.resolve(tree), mode, runs: [] };

if (mode === 'repeat') {
  // One seeded store per timing run, so every run sees the same starting state; the store
  // files are byte-checked around each timed request to confirm the path stayed read-only.
  for (const scenario of SCENARIOS) {
    const handles = [];
    const projections = [];
    const reads = [];
    const chars = [];
    let wroteStore = false;
    let snapDelta = null;
    for (let i = 0; i < REPEATS; i += 1) {
      const dir = tmpDir(scenario.id);
      const app = createApp({ dataDir: dir, now: NOW, gateway: stub(scenario.stubReply) });
      app.controller.retrievalLimit = scenario.retrievalLimit;
      app.controller.maxContextChars = scenario.maxContextChars;
      await seedScenario(app, scenario);
      const before = readStores(dir);
      const totals = instrument({ memory: app.memory, knowledge: app.knowledge });
      const s0 = { memory: snap(app.memory), knowledge: snap(app.knowledge) };
      const t0 = hr();
      const res = await app.controller.handle(scenario.question);
      handles.push(ms(hr() - t0));
      const handleReads = { ...totals };
      const s1 = { memory: snap(app.memory), knowledge: snap(app.knowledge) };
      const t1 = hr();
      await buildWorldState({ memory: app.memory, knowledge: app.knowledge, now: NOW });
      projections.push(ms(hr() - t1));
      chars.push(res.operation?.prompt?.chars ?? 0);
      reads.push(handleReads);
      wroteStore ||= !sameStores(before, readStores(dir));
      if (i === REPEATS - 1) {
        snapDelta = {
          memory: {
            hits: s1.memory.parseCacheStats?.hits ?? 0,
            misses: s1.memory.parseCacheStats?.misses ?? 0,
            reuses: s1.memory.appendStateStats?.reuses ?? 0,
            rebuilds: s1.memory.appendStateStats?.rebuilds ?? 0,
          },
          knowledge: {
            hits: s1.knowledge.parseCacheStats?.hits ?? 0,
            misses: s1.knowledge.parseCacheStats?.misses ?? 0,
            reuses: s1.knowledge.appendStateStats?.reuses ?? 0,
            rebuilds: s1.knowledge.appendStateStats?.rebuilds ?? 0,
          },
          deltaAcrossHandle: {
            memoryHits: (s1.memory.parseCacheStats?.hits ?? 0) - (s0.memory.parseCacheStats?.hits ?? 0),
            memoryMisses: (s1.memory.parseCacheStats?.misses ?? 0) - (s0.memory.parseCacheStats?.misses ?? 0),
            knowledgeHits: (s1.knowledge.parseCacheStats?.hits ?? 0) - (s0.knowledge.parseCacheStats?.hits ?? 0),
            knowledgeMisses: (s1.knowledge.parseCacheStats?.misses ?? 0) - (s0.knowledge.parseCacheStats?.misses ?? 0),
          },
        };
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const readKeys = new Set(reads.flatMap((r) => Object.keys(r).filter((k) => r[k] > 0)));
    results.runs.push({
      scenarioId: scenario.id,
      handleMs: { min: minmax(handles)[0], median: median(handles), max: minmax(handles)[1] },
      worldStateMs: { min: minmax(projections)[0], median: median(projections), max: minmax(projections)[1] },
      promptChars: chars[0],
      estPromptTokens: Math.round(chars[0] / 4),
      readsPerRequest: Object.fromEntries([...readKeys].map((k) => [k, reads[0][k]])),
      snapshot: snapDelta,
      storeWrittenDuringRead: wroteStore,
    });
  }
} else if (mode === 'trim') {
  // Budget ladder: the same seeded store, progressively smaller context budgets.
  const budgets = [3000, 2000, 1600, 1400, 1200, 900, 700, 500, 400];
  for (const id of ['03-conflicting-claims', '07-outside-retrieval-window', '09-incomplete-retrieval']) {
    const scenario = SCENARIOS.find((s) => s.id === id);
    for (const budget of budgets) {
      const dir = tmpDir(id);
      const sink = {};
      const app = createApp({ dataDir: dir, now: NOW, gateway: stub(scenario.stubReply, sink) });
      app.controller.retrievalLimit = scenario.retrievalLimit;
      app.controller.maxContextChars = budget;
      await seedScenario(app, scenario);
      const t0 = hr();
      const res = await app.controller.handle(scenario.question);
      const took = ms(hr() - t0);
      const p = res.operation?.prompt ?? {};
      const prompt = sink.prompt ?? '';
      const section = String(prompt).split('\n\n').find((s) => s.startsWith('APEX STORE-WIDE PROJECTION'));
      results.runs.push({
        scenarioId: id,
        budget,
        chars: p.chars ?? 0,
        withinBudget: (p.chars ?? 0) <= budget,
        assemblyMs: took,
        memoryIncluded: (p.memoryIds ?? []).length,
        knowledgeIncluded: (p.knowledgeIds ?? []).length,
        // Counted from the prompt text itself, so condition A (which never writes a `world`
        // audit field) is measured on the same basis as condition B.
        projectionSectionPresent: Boolean(section),
        projectionLines: section ? section.split('\n').length - 1 : 0,
        projectionLinesTotal: p.world?.linesTotal ?? null,
        omissionNotice: /omitted from this context/i.test(section ?? '') || /omitted from this context/i.test(prompt),
        status: res.status,
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
} else if (mode === 'growth') {
  // Read cost as the store grows. Only the read primitives are timed here, so nothing about
  // model latency is implied, and each size gets a fresh seeded store.
  const sizes = [10, 50, 200, 600];
  const query = 'warehouse 7 coolant loop pressure reading';
  for (const size of sizes) {
    const dir = tmpDir(`n${size}`);
    const app = createApp({ dataDir: dir, now: NOW, gateway: stub('x') });
    await app.controller.runAction('memory.add', { content: 'The coolant loop pressure reading for Warehouse 7 is 2.4 bar.' }, 'user', 'seed');
    for (let i = 0; i < size; i += 1) {
      await app.controller.runAction('memory.add', { content: `Bay ${i} pallet count reviewed by the night shift on rack ${i}.` }, 'user', 'seed');
    }
    const searchTimes = [];
    const worldTimes = [];
    let lastHits = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = hr();
      lastHits = await app.memory.search(query, { limit: 6 });
      searchTimes.push(ms(hr() - t0));
      const t1 = hr();
      await buildWorldState({ memory: app.memory, knowledge: app.knowledge, now: NOW });
      worldTimes.push(ms(hr() - t1));
    }
    const s = snap(app.memory);
    results.runs.push({
      records: size + 1,
      fileBytes: fs.statSync(path.join(dir, 'memory.jsonl')).size,
      searchMs: { min: minmax(searchTimes)[0], median: median(searchTimes), max: minmax(searchTimes)[1] },
      worldStateMs: { min: minmax(worldTimes)[0], median: median(worldTimes), max: minmax(worldTimes)[1] },
      hitCount: lastHits.length,
      snapshot: { hits: s.parseCacheStats?.hits ?? 0, misses: s.parseCacheStats?.misses ?? 0, cachedBytes: s.parseCacheStats?.cachedBytes ?? 0, reuses: s.appendStateStats?.reuses ?? 0, rebuilds: s.appendStateStats?.rebuilds ?? 0 },
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}

const file = path.join(outDir, `${label}-${mode}.json`);
fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
console.log(`${label}/${mode}: ${results.runs.length} runs -> ${file}`);
for (const r of results.runs) {
  console.log('  ' + JSON.stringify(r));
}
