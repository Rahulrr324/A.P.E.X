// Bounded, model-free benchmark for the integrated cognition layer (Batch AJ).
//
// It measures APEX's own deterministic stages against synthetic fixtures in a fresh temporary data
// directory. No inference is run or simulated: no backend is constructed at all, `analyzeRequest`
// reads stores and never calls a model, and the response-validation samples are literal strings.
// This is not part of `npm test` and no test depends on it.
//
//   node benchmarks/run-cognition-benchmark.mjs [--repeats R] [--phase stages|context|validation|all] [--keep]
//
// Phases:
//   stages       request understanding, evidence retrieval/normalization, claim extraction,
//                deliberation and the grounding brief, at progressive memory and knowledge sizes.
//                `world state` and `conflicts` are reported beside them because the request path
//                derives them before the analysis and the analysis treats them as seeds.
//   context      what the cognitive grounding section adds to a prompt, and the prompt assembly
//                cost at the same sizes.
//   validation   one accepted structured response, one over-claiming response, and one malformed
//                response, measured through the real validator against a real analysis.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { analyzeRequest, validateModelOutput } from '../src/cognition/engine.js';
import { buildPrompt, MAX_CONTEXT_CHARS } from '../src/controller/context.js';
import { computeConflicts } from '../src/world/conflicts.js';

const NOW = () => new Date('2026-05-01T00:00:00.000Z');
const REQUEST = 'tell me about the lighthouse project status';
const SIZES = [20, 200, 800];
const MAX_SIZE = SIZES[SIZES.length - 1];
// The default budget is 6000 characters. This measurement room is large enough for the fixture's
// records and the brief, so the section's own size is visible; the default-budget line below
// reports what happens when it is not, and does not pretend the section was present.
const CONTEXT_BUDGET = 8000;
const MAX_REPEATS = 25;
const UE = [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }];

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const dirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'apex-bench-cog-'));
  dirs.push(dir);
  return dir;
}

function removeDir(dir) {
  const real = fs.realpathSync(dir);
  if (!real.startsWith(TMP_ROOT) || !path.basename(real).startsWith('apex-bench-cog-')) {
    throw new Error(`refusing to remove non-benchmark directory: ${real}`);
  }
  fs.rmSync(real, { recursive: true, force: true });
}

function parseArgs(argv) {
  const opts = { repeats: 7, keep: false, phase: 'all', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--repeats') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > MAX_REPEATS) throw new Error(`--repeats must be 1..${MAX_REPEATS}`);
      opts.repeats = value;
      i += 1;
    } else if (arg === '--phase') {
      const name = argv[i + 1];
      if (!['stages', 'context', 'validation', 'all'].includes(name)) throw new Error(`unknown phase ${name}`);
      opts.phase = name;
      i += 1;
    } else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    median: sorted[mid],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function ms(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${value.toFixed(3)} ms`;
}

async function seed(app, target) {
  for (let i = 1; i <= target; i += 1) {
    await app.memory.add({
      content: `the lighthouse project status is green for batch ${i}`,
      kind: 'user_fact',
      source: 'user',
    });
    await app.knowledge.add({
      subject: 'lighthouse project',
      relationship: 'status',
      object: `green for batch ${i}`,
      origin: 'user',
    });
  }
}

// One entity with a recorded fact and a second, disagreeing fact. The disagreement is what makes
// claim extraction and deliberation do real work; a single clean fact would measure almost nothing.
async function seedWorld(app) {
  const write = async (action, input) => {
    const res = await app.controller.worldWrite(action, input);
    if (res.status !== 'success_verified') throw new Error(`${action} failed: ${JSON.stringify({ status: res.status, decision: res.operation?.decision, verification: res.operation?.verification, errors: res.operation?.errors ?? res })}`);
  };
  await write('world.entity.add', { id: 'lighthouse', category: 'project', name: 'lighthouse project', evidence: UE });
  await write('world.fact.add', {
    id: 'lh-status-a', subject: 'lighthouse', predicate: 'status', object: { kind: 'scalar', valueType: 'string', value: 'green' },
    validFrom: '2024-01-01', evidence: UE,
  });
  await write('world.fact.add', {
    id: 'lh-status-b', subject: 'lighthouse', predicate: 'status', object: { kind: 'scalar', valueType: 'string', value: 'amber' },
    validFrom: '2024-02-01', evidence: UE,
  });
  await write('world.event.add', {
    id: 'lh-event', eventType: 'status_review', participants: ['lighthouse'], occurredAt: '2024-03-01T00:00:00.000Z', evidence: UE,
  });
}

function storesOf(app) {
  return {
    memory: app.memory,
    knowledge: app.knowledge,
    experience: app.experience,
    predictions: app.predictions,
    goals: app.goals,
    plans: app.plans,
    tasks: app.taskStore,
  };
}

async function runAnalysis(app) {
  const started = performance.now();
  const state = await app.worldModel.state();
  const afterState = performance.now();
  const conflicts = computeConflicts(state, { now: NOW() });
  const afterConflicts = performance.now();
  const analysis = await analyzeRequest({
    request: REQUEST,
    now: NOW(),
    turns: [],
    stores: storesOf(app),
    seeds: { worldState: state },
    worldConflicts: conflicts,
  });
  const afterAnalysis = performance.now();
  return {
    analysis,
    worldStateMs: afterState - started,
    conflictsMs: afterConflicts - afterState,
    analysisMs: afterAnalysis - afterConflicts,
  };
}

async function phaseStages(opts) {
  const dataDir = tempDir();
  const app = createApp({
    dataDir,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    experienceCapture: CAPTURE_OFF,
    now: NOW,
  });
  await seedWorld(app);
  console.log('\nstages: one question through the deterministic analysis, model-free');
  console.log(`  request: "${REQUEST}"`);
  console.log('  memory   knowledge | world+conflicts | analysis | request  retrieval  claims  deliberation  brief | evidence');
  let seeded = 0;
  for (const size of SIZES) {
    await seed(app, size - seeded);
    seeded = size;
    const runs = [];
    for (let i = 0; i < opts.repeats; i += 1) runs.push(await runAnalysis(app));
    const stage = (name) => stats(runs.map((run) => run.analysis.timings?.[name] ?? 0)).median;
    const outer = (name) => stats(runs.map((run) => run[name])).median;
    const evidence = runs[0].analysis.retrieval?.counts?.total ?? 0;
    console.log(`  ${String(size).padStart(6)}   ${String(size).padStart(9)} | `
      + `${ms(outer('worldStateMs')).padStart(15)} | ${ms(outer('analysisMs')).padStart(8)} | `
      + `${ms(stage('request')).padStart(8)} ${ms(stage('retrieval')).padStart(10)} ${ms(stage('claims')).padStart(6)} `
      + `${ms(stage('deliberation')).padStart(12)} ${ms(stage('brief')).padStart(5)} | ${String(evidence).padStart(8)}`);
  }
  const last = await runAnalysis(app);
  console.log(`  the analysis is bounded: ${last.analysis.retrieval?.counts?.total ?? 0} evidence record(s) kept, `
    + `${last.analysis.retrieval?.counts?.dropped ?? 0} omitted at ${seeded} memory and knowledge records.`);
  console.log('  No model is contacted; every number above is store reading, normalization, and deterministic analysis.');
  console.log('  This measures the standalone analysis, which re-reads memory and knowledge. The controller');
  console.log('  passes the records it already retrieved as seeds, so on the model path those two reads do not');
  console.log('  happen twice; the seeded path is the one the scenario suite exercises.');
}

async function phaseContext(opts) {
  const dataDir = tempDir();
  const app = createApp({
    dataDir,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    experienceCapture: CAPTURE_OFF,
    now: NOW,
  });
  await seedWorld(app);
  await seed(app, MAX_SIZE);
  const state = await app.worldModel.state();
  const conflicts = computeConflicts(state, { now: NOW() });
  const analysis = await analyzeRequest({
    request: REQUEST,
    now: NOW(),
    turns: [],
    stores: storesOf(app),
    seeds: { worldState: state },
    worldConflicts: conflicts,
  });
  const memoryHits = await app.memory.search(REQUEST, { limit: 20 });
  const knowledge = await app.knowledge.search(REQUEST, { limit: 20 });
  const build = (maxChars = CONTEXT_BUDGET) => buildPrompt({
    request: REQUEST,
    memoryHits,
    turns: [],
    knowledge,
    world: null,
    worldModel: null,
    cognition: analysis.brief,
    maxChars,
  });
  const without = buildPrompt({
    request: REQUEST,
    memoryHits,
    turns: [],
    knowledge,
    world: null,
    worldModel: null,
    cognition: null,
    maxChars: CONTEXT_BUDGET,
  }).prompt;
  const withSection = build().prompt;
  const samples = [];
  for (let i = 0; i < opts.repeats; i += 1) {
    const started = performance.now();
    build();
    samples.push(performance.now() - started);
  }
  const s = stats(samples);
  console.log('\ncontext: prompt assembly with the deterministic grounding section');
  console.log(`  ${MAX_SIZE} memory and ${MAX_SIZE} knowledge records, ${memoryHits.length} memory / ${knowledge.length} knowledge hit(s) in the prompt`);
  console.log(`  without the section ${without.length} characters; with it ${withSection.length} `
    + `(+${withSection.length - without.length}, ${(((withSection.length - without.length) / CONTEXT_BUDGET) * 100).toFixed(1)}% `
    + `of the ${CONTEXT_BUDGET}-character measurement budget)`);
  const atDefault = build(MAX_CONTEXT_CHARS).prompt;
  console.log(`  at the default ${MAX_CONTEXT_CHARS}-character budget: ${atDefault.length} characters, `
    + `brief ${atDefault.includes('deterministic analysis of the records above') ? 'present'
      : atDefault.includes('APEX COGNITIVE GROUNDING: omitted') ? 'omitted with a notice' : 'omitted without room for its notice'}`);
  console.log(`  buildPrompt(): ${ms(s.median)} median (${ms(s.min)} min, ${ms(s.max)} max) over ${s.n} samples`);
  console.log(`  the brief itself: ${analysis.brief?.lineCount ?? 0}/${analysis.brief?.totalLines ?? 0} line(s), `
    + `${analysis.brief?.chars ?? 0} character(s), ${analysis.brief?.omitted ?? 0} omitted.`);
  console.log('  The section carries intent, claim kinds, contradictions, uncertainty, and evidence ids;');
  console.log('  it never carries record content or an instruction to the model.');
}

async function phaseValidation(opts) {
  const dataDir = tempDir();
  const app = createApp({
    dataDir,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    experienceCapture: CAPTURE_OFF,
    now: NOW,
  });
  await seedWorld(app);
  await seed(app, 20);
  const state = await app.worldModel.state();
  const conflicts = computeConflicts(state, { now: NOW() });
  const analysis = await analyzeRequest({
    request: REQUEST,
    now: NOW(),
    turns: [],
    stores: storesOf(app),
    seeds: { worldState: state },
    worldConflicts: conflicts,
  });
  const evidenceId = analysis.retrieval.evidence[0]?.evidenceId;
  if (!evidenceId) throw new Error('the fixture produced no evidence to cite');
  const accepted = [
    'The lighthouse project has two recorded status values.',
    `COGNITION ${JSON.stringify({
      schema: 1,
      decision: 'answer',
      answer: 'The lighthouse project has two recorded status values.',
      claims: [{ text: 'two status values are recorded', evidence: [evidenceId], kind: 'supported' }],
      uncertainty: 'conflicting',
      disclosures: [],
      missing: [],
    })}`,
  ].join('\n');
  const overClaim = [
    'The lighthouse project is green.',
    `COGNITION ${JSON.stringify({
      schema: 1,
      decision: 'answer',
      answer: 'The lighthouse project is green.',
      claims: [{ text: 'the project is green', evidence: ['ev:world_fact:invented'], kind: 'supported' }],
      uncertainty: 'supported',
      disclosures: [],
      missing: [],
    })}`,
  ].join('\n');
  const malformed = 'The lighthouse project is green.\nCOGNITION {not json}';
  const time = (text) => {
    const samples = [];
    let result = null;
    for (let i = 0; i < opts.repeats; i += 1) {
      const started = performance.now();
      result = validateModelOutput(text, analysis);
      samples.push(performance.now() - started);
    }
    return { result, ...stats(samples) };
  };
  const a = time(accepted);
  const o = time(overClaim);
  const m = time(malformed);
  console.log('\nvalidation: model output checked against a real analysis');
  console.log(`  accepted structure: ${a.result.structure ? 'accepted' : 'rejected'} (${a.result.error?.message ?? 'none'}), `
    + `${a.result.audit?.claims ?? 0} claim(s), ${a.result.audit?.citedEvidence ?? 0} cited evidence id(s), `
    + `${ms(a.median)} median`);
  console.log(`  invented citation:   ${o.result.structure ? 'accepted' : 'rejected'} `
    + `(${o.result.error?.code ?? 'none'}), ${ms(o.median)} median`);
  console.log(`  malformed JSON:      ${m.result.structure ? 'accepted' : 'rejected'} `
    + `(${m.result.error?.code ?? 'none'}), ${ms(m.median)} median`);
  console.log('  Validation is pure parsing and identifier comparison; no model and no stored write.');
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node benchmarks/run-cognition-benchmark.mjs [--repeats R] [--phase stages|context|validation|all] [--keep]');
  console.log('  model-free; writes only into a fresh temporary data directory; not part of npm test');
} else {
  console.log(`node ${process.version} on ${process.platform} ${process.arch}, `
    + `${os.cpus().length} logical CPU(s), ${Math.round(os.totalmem() / 1073741824)} GiB reported memory; repeats ${opts.repeats}`);
  console.log('no model, no network, no inference: no backend is constructed, analyzeRequest is a pure read,');
  console.log('and the validation samples are literal strings. Fixtures are written through the stores\' own');
  console.log('validated write paths into a fresh temporary data directory.');
  try {
    if (opts.phase === 'all' || opts.phase === 'stages') await phaseStages(opts);
    if (opts.phase === 'all' || opts.phase === 'context') await phaseContext(opts);
    if (opts.phase === 'all' || opts.phase === 'validation') await phaseValidation(opts);
  } finally {
    if (opts.keep) {
      console.log(`\nkept: ${dirs.join(', ')}`);
    } else {
      for (const dir of dirs) removeDir(dir);
      console.log('\ntemporary data directories removed; nothing outside them was written.');
    }
  }
}
