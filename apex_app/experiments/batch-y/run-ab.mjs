#!/usr/bin/env node
// Batch Y offline A/B - evidence collection (no scoring here; see score-ab.mjs).
//
//   node experiments/batch-y/run-ab.mjs --label=B --tree=E:/A.P.E.X/apex_app --out=<dir>
//
// Runs every dataset scenario through that tree's real request path (createApp +
// controller.handle) against an in-process stub backend, and records exactly what the
// application assembled, said, read and wrote. It never touches a network or a model
// endpoint: the "backend" is a plain object with a complete() method, so no fetch, no
// provider, no Ollama, no server, no inference of any kind.
//
// Collection and scoring are separate on purpose: this file cannot be adjusted to make a
// score come out differently.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, def = undefined) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? def : hit.slice(name.length + 3);
};
const label = opt('label');
const tree = opt('tree');
const outDir = opt('out');
const only = opt('only'); // optional single-scenario id filter, for debugging only
if (!label || !tree || !outDir) {
  console.error('usage: run-ab.mjs --label=A|B --tree=<apex_app root> --out=<dir> [--only=<scenarioId>]');
  process.exit(2);
}
const root = pathToFileURL(path.resolve(tree)).href;
fs.mkdirSync(outDir, { recursive: true });

const { SCENARIOS, FIXED_NOW_ISO } = await import(new URL('./dataset.js', import.meta.url).href);
const { createApp } = await import(`${root}/src/app.js`);
const { ModelGateway } = await import(`${root}/src/model/gateway.js`);
const { Outcome } = await import(`${root}/src/outcomes.js`);

const NOW = () => new Date(FIXED_NOW_ISO);
const STORE_FILES = ['memory.jsonl', 'knowledge.jsonl'];

// A stub backend: returns the scenario's fixed reply, records what it was handed, and
// performs no work beyond that. Deterministic by construction.
function stubGateway() {
  const state = { calls: 0, prompts: [], systems: [], reply: 'stub reply', mode: 'ok' };
  const backend = {
    name: 'batch-y-stub',
    provider: 'batch-y-stub',
    configured: true,
    describe: () => ({ configured: true, provider: 'batch-y-stub', endpoint: 'in-process-stub', model: 'batch-y-stub' }),
    health: async () => ({ available: true, detail: 'in-process stub, no endpoint' }),
    async complete({ system, prompt }) {
      state.calls += 1;
      state.systems.push(system);
      state.prompts.push(prompt);
      if (state.mode === 'throw') throw new Error('stub backend failure');
      const text = state.mode === 'empty' ? '' : state.reply;
      return {
        ok: true, backend: 'batch-y-stub', provider: 'batch-y-stub', model: 'batch-y-stub',
        text, finishReason: 'stop', truncated: false, latencyMs: 0,
      };
    },
  };
  return { gateway: new ModelGateway({ backend }), state };
}

function tmpDataDir(scenarioId) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `apex-y-${label}-${scenarioId}-`));
}

function readBytes(dir) {
  const out = {};
  for (const name of STORE_FILES) {
    const p = path.join(dir, name);
    out[name] = fs.existsSync(p) ? createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) : '(absent)';
  }
  return out;
}

// Count store calls by shadowing the store object's own and prototype methods with a
// counter. Only methods that already exist are wrapped, so the same instrumentation works
// unchanged on both trees, and the raw per-method counts are kept in the evidence.
function instrument(stores) {
  const totals = {};
  for (const [bucket, store] of Object.entries(stores)) {
    if (!store) continue;
    const proto = Object.getPrototypeOf(store);
    const names = new Set([...Object.keys(store), ...(proto ? Object.getOwnPropertyNames(proto) : [])]);
    for (const name of names) {
      if (name === 'constructor' || name.startsWith('_')) continue;
      let fn;
      try { fn = store[name]; } catch { continue; }
      if (typeof fn !== 'function') continue;
      const key = `${bucket}.${name}`;
      totals[key] = 0;
      store[name] = function (...args) { totals[key] += 1; return fn.apply(this, args); };
    }
  }
  return { totals };
}

// The derived-snapshot counters live on the underlying JsonlStore (`store.log`), not on the
// memory/knowledge facade, and they are getters rather than methods. Read them defensively so
// a tree without the snapshot simply reports null instead of failing the run.
function stats(store) {
  const log = store?.log;
  if (!log) return null;
  const out = {};
  for (const key of ['parseCacheStats', 'appendStateStats']) {
    let value;
    try { value = log[key]; } catch { continue; }
    if (value && typeof value === 'object') out[key] = { ...value };
  }
  return Object.keys(out).length ? out : null;
}

const rows = [];
for (const scenario of SCENARIOS) {
  if (only && scenario.id !== only) continue;
  const dir = tmpDataDir(scenario.id);
  const cap = stubGateway();
  cap.state.reply = scenario.stubReply;
  const app = createApp({ dataDir: dir, now: NOW, gateway: cap.gateway });
  app.controller.retrievalLimit = scenario.retrievalLimit;
  app.controller.maxContextChars = scenario.maxContextChars;

  const ids = {};
  const seedErrors = [];
  for (const step of scenario.steps) {
    try {
      if (step.op === 'memory') {
        const res = await app.controller.runAction('memory.add', {
          content: step.content, ...(step.sensitivity ? { sensitivity: step.sensitivity } : {}),
        }, 'user', `seed-${scenario.id}`);
        if (res.outcome !== Outcome.SUCCESS_VERIFIED) throw new Error(`memory.add: ${res.summary}`);
        ids[step.alias] = res.result.data.id;
      } else if (step.op === 'knowledge') {
        const supersedes = step.supersedesAlias ? [ids[step.supersedesAlias]] : [];
        const res = await app.controller.knowledgeAdd({
          subject: step.subject, relationship: step.relationship, object: step.object,
          evidence: step.evidence ?? null, supersedes,
        });
        if (res.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`knowledgeAdd: ${res.output}`);
        const [newest] = await app.knowledge.list({ limit: 1 });
        ids[step.alias] = newest.id;
      } else if (step.op === 'resolve') {
        const res = await app.controller.knowledgeResolve({
          target: ids[step.target], choose: ids[step.choose], reason: step.reason ?? null,
        });
        if (res.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`knowledgeResolve: ${res.output}`);
      } else if (step.op === 'retract') {
        const res = await app.controller.knowledgeRetract({
          target: ids[step.target], reason: step.reason ?? null,
        });
        if (res.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`knowledgeRetract: ${res.output}`);
      } else {
        throw new Error(`unknown seed op ${step.op}`);
      }
    } catch (err) {
      seedErrors.push(`${step.op}:${step.alias ?? step.target ?? '?'} ${err.message}`);
    }
  }

  const contentByAlias = {};
  for (const step of scenario.steps) {
    if (step.op === 'memory') contentByAlias[step.alias] = step.content;
    if (step.op === 'knowledge') contentByAlias[step.alias] = `${step.subject} --[${step.relationship}]--> ${step.object}`;
  }

  const bytesBefore = readBytes(dir);
  const counts = instrument({ memory: app.memory, knowledge: app.knowledge });
  const statsBefore = { memory: stats(app.memory), knowledge: stats(app.knowledge) };
  const t0 = process.hrtime.bigint();
  const res = await app.controller.handle(scenario.question);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const statsAfter = { memory: stats(app.memory), knowledge: stats(app.knowledge) };
  const bytesAfter = readBytes(dir);

  rows.push({
    label,
    scenarioId: scenario.id,
    title: scenario.title,
    question: scenario.question,
    tree: path.resolve(tree),
    retrievalLimit: scenario.retrievalLimit,
    maxContextChars: scenario.maxContextChars,
    stubReply: scenario.stubReply,
    ids,
    contentByAlias,
    seedErrors,
    prompt: cap.state.prompts[0] ?? null,
    system: cap.state.systems[0] ?? null,
    modelCalls: cap.state.calls,
    output: res.output,
    status: res.status,
    decision: res.operation?.decision ?? null,
    promptMeta: res.operation?.prompt ?? null,
    steps: (res.operation?.steps ?? []).map((s) => ({
      action: s.action, origin: s.origin, status: s.execution?.status, outcome: s.outcome,
    })),
    readCounts: counts.totals,
    parseStats: { before: statsBefore, after: statsAfter },
    bytesBefore,
    bytesAfter,
    storeWriteDuringRead: STORE_FILES.some((n) => bytesBefore[n] !== bytesAfter[n]),
    elapsedMs: ms,
  });

  fs.rmSync(dir, { recursive: true, force: true });
}

const file = path.join(outDir, `${label}-evidence.json`);
fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`collected ${rows.length} scenarios for condition ${label} -> ${file}`);
for (const r of rows) {
  console.log(`  ${r.scenarioId}: prompt=${r.prompt === null ? 'none' : `${r.prompt.length} chars`} status=${r.status} calls=${r.modelCalls} reads=${JSON.stringify(r.readCounts)} wroteStores=${r.storeWriteDuringRead}`);
}
