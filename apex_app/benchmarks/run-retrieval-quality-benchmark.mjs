// Bounded, network-free benchmark for the Batch AP-10 retrieval-quality work.
//
// Every measured request is handled by the real controller against a fresh temporary data directory.
// The model is a deterministic in-process fixture object implementing the same small backend interface
// the HTTP backends implement; it returns fixed synthetic text, so normalization, per-source retrieval,
// ranking, deduplication, contradiction marking, the evidence snapshot, context-budget selection, claim
// attribution, semantic assessment and the response contract all run through their real code paths. No
// inference is run, no socket is opened, no endpoint is named, and no model quality is claimed.
//
//   node benchmarks/run-retrieval-quality-benchmark.mjs [--repeats R] [--phase normalize|retrieval|context|request|scoring|all] [--sizes 20,200,1000,4000,10000] [--keep]
//
// Phases:
//   normalize  query normalization alone, per query class. Size-independent, so it is measured once and
//              printed apart from retrieval; it is never subtracted from a request time.
//   retrieval  per-source search (memory and knowledge) at each store size for five query classes:
//              common, rare-token, long, adversarial (negation) and no-result. Reports wall time,
//              returned counts and whether the result set was truncated by the source limit.
//   context    buildPrompt over the retrieved hits at each size: assembly time, surviving line counts,
//              and the disclosure counts for deduplication and budget omission.
//   request    one grounded question through the complete deterministic path at each size, with the
//              trust state, the retrieval read state, the claim-attribution counts, the retrieval
//              report state with per-source returned/contributed counts, and the citation-completeness
//              counts APEX produced. States and counts are printed beside the latency, never in it.
//   scoring    the measured AP-09 defect and its AP-10 fix, computed from the same document frequencies
//              at every size: the absent-term weight before (uncapped IDF) and after (capped), and the
//              resulting relevance score against the fixed 0.2 prompt floor. This is a before/after
//              comparison of the weighting policy, not of two builds of the application.
//
// Measurement rules: timings are monotonic (`performance.now`). Warm-up calls are run but not measured.
// A duration that was not produced is `null`, never zero, and the tables print `n/a` for it. p95 is
// printed only at 20 or more samples. Fixtures are written only into a fresh temporary directory, which
// is removed unless --keep is given. This is not part of `npm test`.
//
// What is measured is bounded lexical retrieval: token overlap weighted by inverse document frequency.
// It is not semantic understanding, not entailment and not natural-language inference. One fixture is
// not evidence of general retrieval quality, and a fast result here says nothing about whether a
// paraphrase or an implication would be found. The five query classes are reported separately and are
// never averaged into a single quality number.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { buildPrompt } from '../src/controller/context.js';
import { normalizeTokens, queryTokens } from '../src/retrieval/normalize.js';
import { termIdf, queryWeights, MAX_UNSEEN_TERM_WEIGHT } from '../src/retrieval/relevance.js';
import { ResponseTrustState } from '../src/cognition/response-integrity.js';

const NOW = () => new Date('2026-06-01T00:00:00.000Z');
const QUESTION = 'tell me about the lighthouse project status';
const TARGET = 'the lighthouse project status is green';
const LAUNCH = 'the launch code name is Zephyr';
const DEFAULT_SIZES = [20, 200, 1000, 4000];
const DEFAULT_REPEATS = 7;
const MAX_REPEATS = 15;
const MAX_SIZE = 20000;
const SOURCE_LIMIT = 5;
const PROMPT_FLOOR = 0.2;
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const PREFIX = 'apex-bench-ap10-';
const dirs = [];

// Five classes, kept apart. `rare` is the class that exposed the AP-09 defect: "project" occurs in no
// filler record, so its weight grew with the store and pushed a two-of-three match under the floor.
const NOISE = Array.from({ length: 380 }, (_, i) => `phras${String(i).padStart(4, '0')}`).join(' ');
const QUERIES = [
  { name: 'common', text: 'lighthouse archive batch' },
  { name: 'rare-token', text: QUESTION },
  { name: 'long', text: `${NOISE} launch code name` },
  { name: 'adversarial', text: 'the lighthouse status is not green' },
  { name: 'no-result', text: 'zebra quantum marzipan' },
];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, PREFIX));
  dirs.push(dir);
  return dir;
}

function removeDir(dir) {
  const real = fs.realpathSync(dir);
  if (!real.startsWith(TMP_ROOT) || !path.basename(real).startsWith(PREFIX)) {
    throw new Error(`refusing to remove non-benchmark directory: ${real}`);
  }
  fs.rmSync(real, { recursive: true, force: true });
}

function parseArgs(argv) {
  const opts = { repeats: DEFAULT_REPEATS, keep: false, phase: 'all', sizes: DEFAULT_SIZES, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--repeats') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > MAX_REPEATS) throw new Error(`--repeats must be 1..${MAX_REPEATS}`);
      opts.repeats = value;
      i += 1;
    } else if (arg === '--sizes') {
      const value = String(argv[i + 1] ?? '').split(',').map((s) => Number(s.trim()));
      if (value.length === 0 || value.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_SIZE)) throw new Error(`--sizes must be positive integers up to ${MAX_SIZE}`);
      opts.sizes = [...new Set(value)].sort((a, b) => a - b);
      i += 1;
    } else if (arg === '--phase') {
      const name = argv[i + 1];
      if (!['normalize', 'retrieval', 'context', 'request', 'scoring', 'all'].includes(name)) throw new Error(`unknown phase ${name}`);
      opts.phase = name;
      i += 1;
    } else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

function stats(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return { n: 0, median: null, min: null, max: null, p95: null };
  const sorted = [...clean].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    n: sorted.length,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p95: sorted.length >= 20 ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null,
  };
}

const ms = (value) => (Number.isFinite(value) ? `${value.toFixed(3)} ms` : 'n/a');
const us = (value) => (Number.isFinite(value) ? `${(value * 1000).toFixed(2)} us` : 'n/a');
const num = (value) => (Number.isFinite(value) ? value.toFixed(4) : 'n/a');

async function timed(fn) {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}

function printRow(label, s, extra = '') {
  const tail = s.p95 === null ? '' : `, p95 ${ms(s.p95)}`;
  console.log(`  ${label.padEnd(26)} ${ms(s.median).padStart(11)} median (min ${ms(s.min)}, max ${ms(s.max)}${tail}) over ${s.n} sample(s)${extra}`);
}

function fixtureGateway(text) {
  const backend = {
    name: 'benchmark-fixture',
    provider: 'fixture',
    configured: true,
    describe: () => ({ configured: true, provider: 'fixture', endpoint: 'in-process fixture', model: 'fixture' }),
    health: async () => ({ available: true, detail: 'in-process fixture' }),
    complete: async () => ({
      ok: true, backend: 'benchmark-fixture', provider: 'fixture', model: 'fixture',
      text: typeof text === 'function' ? text() : text,
      finishReason: 'stop', truncated: false, latencyMs: 0,
    }),
  };
  return new ModelGateway({ backend });
}

function makeApp(dataDir, reply) {
  return createApp({ dataDir, gateway: fixtureGateway(reply), experienceCapture: CAPTURE_OFF, now: NOW });
}

function groundedReply(evidenceId) {
  return 'The lighthouse project status is green.\n'
    + `COGNITION ${JSON.stringify({
      schema: 1,
      decision: 'answer',
      answer: 'The lighthouse project status is green.',
      claims: [{ text: TARGET, evidence: [`ev:memory:${evidenceId}`], kind: 'supported' }],
    })}`;
}

// Fillers deliberately do not contain the word "project", so the rare-token class reproduces the
// measured defect: one query term absent from the whole store, two present in every record.
async function seed(app, count) {
  for (let i = 1; i <= count; i += 1) {
    await app.memory.add({ content: `the lighthouse archive batch ${i} was recorded`, kind: 'user_fact', source: 'user' });
    await app.knowledge.add({ subject: 'lighthouse archive', relationship: 'status batch', object: `${i}`, origin: 'user' });
  }
}

async function addTargets(app) {
  const memory = await app.memory.add({ content: TARGET, kind: 'user_fact', source: 'user' });
  await app.memory.add({ content: LAUNCH, kind: 'user_fact', source: 'user' });
  await app.knowledge.add({ subject: 'lighthouse project', relationship: 'status', object: 'green', origin: 'user' });
  return memory.id;
}

// ---- phase: normalize ---------------------------------------------------------------------------

function phaseNormalize(opts) {
  console.log('\nnormalize: query normalization alone (size-independent; never subtracted from a request)');
  console.log('  class        tokens  dropped  distinct   median        range');
  for (const query of QUERIES) {
    const samples = [];
    let view = null;
    for (let i = 0; i < opts.repeats + 2; i += 1) {
      const started = performance.now();
      view = queryTokens(query.text, { stem: true });
      const elapsed = performance.now() - started;
      if (i >= 2) samples.push(elapsed);
    }
    const s = stats(samples);
    console.log(`  ${query.name.padEnd(12)} ${String(view.tokens.length).padStart(6)} ${String(view.dropped).padStart(8)} ${String(view.total).padStart(9)}   ${us(s.median).padStart(11)}   ${us(s.min)} .. ${us(s.max)}`);
  }
  const negated = queryTokens('the task is not completed', { stem: true });
  const plain = queryTokens('the task is completed', { stem: true });
  console.log(`  negation kept: "not completed" -> [${negated.tokens.join(', ')}] vs "completed" -> [${plain.tokens.join(', ')}]`);
  console.log(`  identifier kept whole: ${JSON.stringify(normalizeTokens('AP-10 2026-06-01 v1.2'))}`);
  console.log('  normalization is lexical: no synonym expansion, no coreference, no meaning is inferred.');
}

// ---- phase: retrieval ---------------------------------------------------------------------------

async function phaseRetrieval(opts, state) {
  console.log('\nretrieval: per-source search at each store size, five query classes kept apart');
  console.log(`  source limit ${SOURCE_LIMIT} per search; a class that returns ${SOURCE_LIMIT} may be truncated, and the count alone does not say so`);
  for (const size of opts.sizes) {
    await state.growTo(size);
    console.log(`\n  ${size} record(s) per store`);
    console.log('    class        source     median        range          returned  top score  tail score  floor');
    for (const query of QUERIES) {
      for (const [name, store] of [['memory', state.app.memory], ['knowledge', state.app.knowledge]]) {
        const samples = [];
        let hits = [];
        for (let i = 0; i < opts.repeats + 2; i += 1) {
          const run = await timed(() => store.search(query.text, { limit: SOURCE_LIMIT }));
          hits = run.value;
          if (i >= 2) samples.push(run.ms);
        }
        const s = stats(samples);
        const top = hits[0]?.score ?? null;
        // The tail is the lowest-ranked returned hit. For the rare-token class the fillers match two of
        // the three query terms, so the tail is the score the AP-09 defect pushed under the floor.
        const tail = hits.length ? hits[hits.length - 1].score : null;
        const kept = top === null ? 'n/a' : top >= PROMPT_FLOOR ? 'kept' : 'excluded';
        console.log(`    ${query.name.padEnd(12)} ${name.padEnd(10)} ${ms(s.median).padStart(11)}   ${ms(s.min)} .. ${ms(s.max)}   ${String(hits.length).padStart(8)}  ${num(top).padStart(9)}  ${num(tail).padStart(10)}  ${kept}`);
      }
    }
  }
}

// ---- phase: context -----------------------------------------------------------------------------

async function phaseContext(opts, state) {
  console.log('\ncontext: buildPrompt over the retrieved hits, with the disclosure counts it produced');
  for (const size of opts.sizes) {
    await state.growTo(size);
    const memoryHits = await state.app.memory.search(QUESTION, { limit: SOURCE_LIMIT });
    const knowledge = await state.app.knowledge.search(QUESTION, { limit: SOURCE_LIMIT });
    const samples = [];
    let built = null;
    for (let i = 0; i < opts.repeats + 2; i += 1) {
      const started = performance.now();
      built = buildPrompt({ request: QUESTION, memoryHits, knowledge, turns: [] });
      const elapsed = performance.now() - started;
      if (i >= 2) samples.push(elapsed);
    }
    const s = stats(samples);
    console.log(`  ${String(size).padStart(6)} record(s)  ${ms(s.median).padStart(11)} median (${ms(s.min)} .. ${ms(s.max)}) over ${s.n} sample(s)`);
    console.log(`         prompt ${built.prompt.length} chars; memory ${built.memoryLines}/${built.memoryLinesTotal}, knowledge ${built.knowledgeLines}/${built.knowledgeLinesTotal}, `
      + `duplicates collapsed ${built.knowledgeDeduplicated}, knowledge omitted ${built.knowledgeLinesTotal - built.knowledgeLines}, memory omitted ${built.memoryLinesTotal - built.memoryLines}`);
    const contested = /\[contested:|conflicting memory:/.test(built.prompt);
    console.log(`         contradiction marker present: ${contested}; an omitted record is disclosed, never rendered as absent`);
  }

  // Size-independent, and printed apart from the rows above: these two properties are about what the
  // budget does to a disagreement and to a repeated triple, not about how large the store is.
  const clock = '2026-06-01T00:00:00.000Z';
  const hit = (id, content, conflict) => ({
    record: { id, content, kind: 'user_fact', createdAt: clock, sensitivity: 'normal' },
    score: 1, conflict, status: 'current',
  });
  const disagreeing = buildPrompt({
    request: QUESTION,
    turns: [],
    memoryHits: [hit('m1', TARGET, ['m2']), hit('m2', 'the lighthouse project status is red', ['m1'])],
  });
  console.log('\n  contradiction preservation (size-independent)');
  console.log(`    both sides retrieved: ${disagreeing.memoryLines} line(s); marker present: ${/conflicting memory: 1 other record\(s\) disagree/.test(disagreeing.prompt)}`);
  let trimmed = null;
  for (let budget = disagreeing.prompt.length; budget > 0 && trimmed === null; budget -= 1) {
    const candidate = buildPrompt({
      request: QUESTION,
      turns: [],
      maxChars: budget,
      memoryHits: [hit('m1', TARGET, ['m2']), hit('m2', 'the lighthouse project status is red', ['m1'])],
    });
    if (candidate.memoryLines === 1) trimmed = candidate;
  }
  console.log(`    after a budget that keeps one side: marker present ${trimmed ? /\[contested:/.test(trimmed.prompt) : 'n/a'}; `
    + `omission disclosed ${trimmed ? /\d+ recalled record\(s\) were omitted/.test(trimmed.prompt) : 'n/a'}; `
    + 'a trimmed disagreement is never rendered as an unopposed claim');

  const triple = (id, object) => ({
    record: {
      id, subject: 'lighthouse project', relationship: 'status', object,
      provenance: { origin: 'user_supplied' }, conflictsWith: [], createdAt: clock,
    },
    score: 1,
  });
  const duplicates = buildPrompt({
    request: QUESTION,
    turns: [],
    memoryHits: [],
    knowledge: [triple('k1', 'green'), triple('k2', 'green'), triple('k3', 'red')],
  });
  console.log('\n  deduplication (size-independent)');
  console.log(`    3 retrieved triples -> ${duplicates.knowledgeLines} line(s); ${duplicates.knowledgeDeduplicated} collapsed and disclosed: `
    + `${/repeated an identical subject-relationship-object triple/.test(duplicates.prompt)}; the disagreeing triple survives: ${/red/.test(duplicates.prompt)}`);
}

// ---- phase: request -----------------------------------------------------------------------------

async function phaseRequest(opts, state) {
  console.log('\nrequest: one grounded question through the complete deterministic path');
  console.log(`  request: "${QUESTION}"`);
  console.log('  the model is an in-process fixture returning one COGNITION line citing the seeded record;');
  console.log('  every classification below is APEX\'s own assessment of that fixed reply');
  console.log('  records | median wall    | range                  | trust                 | read state   | claim attribution');
  for (const size of opts.sizes) {
    await state.growTo(size);
    const samples = [];
    let result = null;
    for (let i = 0; i < opts.repeats + 2; i += 1) {
      const run = await timed(() => state.app.controller.handle(QUESTION, { origin: 'user' }));
      result = run.value;
      if (i >= 2) samples.push(run.ms);
    }
    const s = stats(samples);
    const integrity = result.operation?.cognition?.responseIntegrity ?? null;
    const read = result.operation?.cognition?.read ?? null;
    const report = result.operation?.prompt?.retrievalReport ?? null;
    const citation = integrity?.citationCompleteness ?? null;
    const claims = integrity?.claims ?? {};
    console.log(`  ${String(size).padStart(7)} | ${ms(s.median).padStart(14)} | ${ms(s.min)} .. ${ms(s.max)} | ${String(integrity?.trust ?? 'n/a').padEnd(21)} | ${String(read?.state ?? 'n/a').padEnd(12)} | ${claims.factual ?? 'n/a'} factual, ${claims.supported ?? 'n/a'} directly supported, ${claims.partialAttribution ?? 'n/a'} partial, ${claims.unattributed ?? 'n/a'} unattributed`);
    // The retrieval report and the citation findings are printed beside the latency, never inside it:
    // they are counts and states, not durations, and a state is not a quality score.
    const perSource = (report?.sources ?? [])
      .map((entry) => `${entry.source} ${entry.returned ?? 'n/a'}/${entry.contributed ?? 'n/a'}`)
      .join(', ');
    console.log(`          retrieval ${report?.state ?? 'n/a'} (complete ${report?.complete ?? 'n/a'}, window ${report?.window ?? 'n/a'}); returned/contributed ${perSource || 'n/a'}`);
    console.log(`          citation ${citation ? `${citation.claims} claim(s), ${citation.outsideSnapshot} outside snapshot, ${citation.uncitedRelevant} relevant uncited, ${citation.oneSidedConflicts} one-sided, bounded ${citation.bounded}` : 'n/a'}`);
    if (integrity?.trust !== ResponseTrustState.FACTUALLY_SUPPORTED) {
      console.log(`          note: trust ${integrity?.trust ?? 'n/a'} at this size; the fixture reply is unchanged, so any difference is APEX's own assessment`);
    }
  }
}

// ---- phase: scoring -----------------------------------------------------------------------------

// The before/after comparison is of the weighting policy on identical document frequencies, computed
// from the same formula the stores use. `before` is the uncapped AP-09 IDF for an absent term; `after`
// is the capped AP-10 weight. Nothing here re-runs an old build of the application.
function phaseScoring(opts) {
  console.log('\nscoring: the measured absent-term defect and its fix, on identical document frequencies');
  console.log(`  query terms: lighthouse (in every record), status (in every record), project (in no record)`);
  console.log(`  fixed prompt-relevance floor ${PROMPT_FLOOR}; cap MAX_UNSEEN_TERM_WEIGHT = ${MAX_UNSEEN_TERM_WEIGHT}`);
  console.log('  records | before weight | after weight | before score | after score | before floor | after floor');
  for (const size of opts.sizes) {
    const df = new Map([['lighthouse', size], ['status', size], ['project', 0]]);
    const terms = ['lighthouse', 'status', 'project'];
    const before = new Map(terms.map((t) => [t, termIdf(df.get(t) ?? 0, size)]));
    const beforeTotal = terms.reduce((sum, t) => sum + before.get(t), 0);
    const beforeScore = (before.get('lighthouse') + before.get('status')) / beforeTotal;
    const { idf, totalWeight } = queryWeights(terms, df, size);
    const afterScore = (idf.get('lighthouse') + idf.get('status')) / totalWeight;
    console.log(`  ${String(size).padStart(7)} | ${num(before.get('project')).padStart(13)} | ${num(idf.get('project')).padStart(12)} | ${num(beforeScore).padStart(12)} | ${num(afterScore).padStart(11)} | ${(beforeScore >= PROMPT_FLOOR ? 'kept' : 'EXCLUDED').padStart(12)} | ${(afterScore >= PROMPT_FLOOR ? 'kept' : 'EXCLUDED').padStart(11)}`);
  }
  console.log('  a two-of-three match is the fixture that crossed the floor as the store grew; the cap stops');
  console.log('  the absent term\'s weight from growing with corpus size. This is one fixture, not a claim of');
  console.log('  general retrieval quality, and it is reported apart from the latency phases above.');
}

// ---- driver -------------------------------------------------------------------------------------

// One corpus is grown monotonically and shared by the phases that need a store, so a larger row is the
// same corpus plus fillers rather than a different fixture. The two target records are added once.
async function makeState() {
  const dataDir = tempDir();
  let evidenceId = null;
  const app = makeApp(dataDir, () => groundedReply(evidenceId));
  let seeded = 0;
  return {
    app,
    async growTo(size) {
      if (evidenceId === null) {
        evidenceId = await addTargets(app);
        seeded += 3;
      }
      const fillers = size - seeded;
      if (fillers > 0) {
        await seed(app, fillers);
        seeded += fillers;
      }
    },
  };
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node benchmarks/run-retrieval-quality-benchmark.mjs [--repeats R] [--phase normalize|retrieval|context|request|scoring|all] [--sizes 20,200,1000,4000,10000] [--keep]');
  console.log('  network-free; deterministic in-process model fixture; writes only into a fresh temporary directory; not part of npm test');
} else {
  console.log(`node ${process.version} on ${process.platform} ${process.arch}, `
    + `${os.cpus().length} logical CPU(s), ${Math.round(os.totalmem() / 1073741824)} GiB reported memory; repeats ${opts.repeats}`);
  console.log(`sizes ${opts.sizes.join(', ')}; phase ${opts.phase}`);
  console.log('No inference is run and no network is used: the model is an in-process fixture object returning');
  console.log('fixed synthetic text. Fixtures are written through the stores\' own validated write paths into a');
  console.log('fresh temporary data directory, which is removed at the end unless --keep is passed.');
  console.log('Retrieval is bounded lexical token overlap weighted by inverse document frequency. It is not');
  console.log('semantic understanding, and no paraphrase, entailment or NLU capability is claimed or measured.');
  console.log('No index, cache or schema was added for this benchmark.');
  const state = await makeState();
  try {
    if (opts.phase === 'all' || opts.phase === 'normalize') phaseNormalize(opts);
    if (opts.phase === 'all' || opts.phase === 'scoring') phaseScoring(opts);
    if (opts.phase === 'all' || opts.phase === 'retrieval') await phaseRetrieval(opts, state);
    if (opts.phase === 'all' || opts.phase === 'context') await phaseContext(opts, state);
    if (opts.phase === 'all' || opts.phase === 'request') await phaseRequest(opts, state);
  } finally {
    if (opts.keep) {
      console.log(`\nkept: ${dirs.join(', ')}`);
    } else {
      for (const dir of dirs) removeDir(dir);
      console.log('\ntemporary data directories removed; nothing outside them was written.');
    }
  }
}