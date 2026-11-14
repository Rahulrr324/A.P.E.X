// One side of the AP-12 paired A/B measurement. This file is copied unchanged into a tree
// extracted from another git revision, so both sides run the same driver code and differ only
// in the application source they import. It is not a standalone benchmark: the orchestrator
// (`run-runtime-performance-benchmark.mjs --phase compare`) seeds one verified corpus per size,
// copies it per side, and invokes this file with `--side`.
//
// The corpus is read-only for the measurement's purposes, but a real request writes conversation
// and operation records, so every side gets its own copy of the identical corpus. Cold samples
// create a fresh application per request (no parse snapshot, no derived state); warm samples reuse
// one application, with warm-up requests that are not measured.
//
// Output is a single JSON object written to `--json`. No inference is run and no network is used.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';

const NOW = () => new Date('2026-06-01T00:00:00.000Z');
const QUESTION = 'tell me about the lighthouse project status';
const TARGET = 'the lighthouse project status is green';

function parseArgs(argv) {
  const opts = { dir: null, target: null, repeats: 5, warmups: 1, json: null, side: 'unknown', size: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--dir') { opts.dir = value; i += 1; }
    else if (arg === '--target') { opts.target = value; i += 1; }
    else if (arg === '--repeats') { opts.repeats = Number(value); i += 1; }
    else if (arg === '--warmups') { opts.warmups = Number(value); i += 1; }
    else if (arg === '--json') { opts.json = value; i += 1; }
    else if (arg === '--side') { opts.side = value; i += 1; }
    else if (arg === '--size') { opts.size = Number(value); i += 1; }
    else throw new Error(`unknown argument ${arg}`);
  }
  for (const required of ['dir', 'target', 'json']) {
    if (!opts[required]) throw new Error(`--${required} is required`);
  }
  if (!Number.isInteger(opts.repeats) || opts.repeats < 1) throw new Error('--repeats must be a positive integer');
  if (!Number.isInteger(opts.warmups) || opts.warmups < 0) throw new Error('--warmups must be a non-negative integer');
  return opts;
}

function fixtureGateway(text) {
  return new ModelGateway({
    backend: {
      name: 'ap12-fixture',
      provider: 'fixture',
      configured: true,
      describe: () => ({ configured: true, provider: 'fixture', endpoint: 'in-process fixture', model: 'fixture' }),
      health: async () => ({ available: true, detail: 'in-process fixture' }),
      complete: async () => ({
        ok: true, backend: 'ap12-fixture', provider: 'fixture', model: 'fixture',
        text: typeof text === 'function' ? text() : text,
        finishReason: 'stop', truncated: false, latencyMs: 0,
      }),
    },
  });
}

function replyFor(evidenceId) {
  return () => 'The lighthouse project status is green.\n'
    + `COGNITION ${JSON.stringify({
      schema: 1,
      decision: 'answer',
      answer: 'The lighthouse project status is green.',
      claims: [{ text: TARGET, evidence: [`ev:memory:${evidenceId}`], kind: 'supported' }],
    })}`;
}

function makeApp(dataDir, reply) {
  return createApp({ dataDir, gateway: fixtureGateway(reply), experienceCapture: CAPTURE_OFF, now: NOW });
}

function countRecords(app) {
  const count = (file) => {
    if (!fs.existsSync(file)) return 0;
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).length;
  };
  return { memory: count(app.memory.filePath), knowledge: count(app.knowledge.filePath) };
}

async function timed(app) {
  const started = performance.now();
  const res = await app.controller.handle(QUESTION, { origin: 'user' });
  return { ms: performance.now() - started, res };
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

function stagesOf(res) {
  return (res?.operation?.diagnostics?.stages ?? [])
    .filter((stage) => Number.isFinite(stage.durationMs))
    .map((stage) => ({ id: stage.id, durationMs: stage.durationMs }));
}

function stageMedians(samples) {
  const byId = new Map();
  for (const stages of samples) {
    for (const stage of stages) {
      const list = byId.get(stage.id) ?? [];
      list.push(stage.durationMs);
      byId.set(stage.id, list);
    }
  }
  return [...byId.entries()].map(([id, values]) => ({ id, ...stats(values) }));
}

function indexStats(store) {
  return store?.lifecycleIndexStats ?? null;
}

function retrievalStats(store) {
  return store?.retrievalIndexStats ?? null;
}

function verdictOf(res) {
  const integrity = res?.operation?.cognition?.responseIntegrity ?? null;
  const report = res?.operation?.prompt?.retrievalReport ?? null;
  return {
    status: res?.operation?.status ?? null,
    trust: integrity?.trust ?? null,
    retrieval: report?.state ?? null,
    complete: report?.complete ?? null,
  };
}

const opts = parseArgs(process.argv.slice(2));
const target = opts.target;
const memoryBefore = process.memoryUsage();
const cold = [];
const coldStages = [];
let lastCold = null;
for (let i = 0; i < opts.repeats; i += 1) {
  const sample = await timed(makeApp(opts.dir, replyFor(target)));
  cold.push(sample.ms);
  coldStages.push(stagesOf(sample.res));
  lastCold = sample.res;
}

const warmApp = makeApp(opts.dir, replyFor(target));
for (let i = 0; i < opts.warmups; i += 1) await timed(warmApp);
const warm = [];
const warmStages = [];
let lastWarm = null;
for (let i = 0; i < opts.repeats; i += 1) {
  const sample = await timed(warmApp);
  warm.push(sample.ms);
  warmStages.push(stagesOf(sample.res));
  lastWarm = sample.res;
}
const memoryAfter = process.memoryUsage();

const payload = {
  side: opts.side,
  size: opts.size,
  corpus: countRecords(warmApp),
  cold: stats(cold),
  warm: stats(warm),
  coldStages: stageMedians(coldStages),
  warmStages: stageMedians(warmStages),
  stages: stagesOf(lastWarm),
  verdict: verdictOf(lastWarm),
  coldVerdict: verdictOf(lastCold),
  lifecycle: indexStats(warmApp.knowledge),
  knowledgeRetrieval: retrievalStats(warmApp.knowledge),
  memoryRetrieval: retrievalStats(warmApp.memory),
  parse: {
    knowledge: warmApp.knowledge.log.parseCacheStats ?? null,
    memory: warmApp.memory.log.parseCacheStats ?? null,
  },
  memory: {
    rssBefore: memoryBefore.rss,
    rssAfter: memoryAfter.rss,
    heapBefore: memoryBefore.heapUsed,
    heapAfter: memoryAfter.heapUsed,
  },
};

fs.mkdirSync(path.dirname(opts.json), { recursive: true });
fs.writeFileSync(opts.json, JSON.stringify(payload, null, 2));
console.log(JSON.stringify({ side: payload.side, size: payload.size, corpus: payload.corpus }));
