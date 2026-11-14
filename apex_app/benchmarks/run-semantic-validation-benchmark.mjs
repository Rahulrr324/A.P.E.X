// Bounded, network-free benchmark for the Batch AP-09 semantic-validation work.
//
// Every measured request is handled by the real controller against a fresh temporary data directory.
// The model is a deterministic in-process fixture object implementing the same small backend interface
// the HTTP backends implement; it returns fixed synthetic text, so retrieval, structured-reply
// validation, attribution, semantic assessment, response consistency, the trust ladder, the response
// contract and the executive handoff all run through their real code paths. No inference is run, no
// socket is opened, no endpoint is named, and no model quality is claimed.
//
//   node benchmarks/run-semantic-validation-benchmark.mjs [--repeats R] [--phase request|components|adversarial|all] [--sizes 20,200,1000,4000] [--adversarial-size 200] [--keep]
//
// Phases:
//   request      one grounded question through the complete deterministic path at 20, 200, 1000 and
//                4000 memory+knowledge records. Reports wall time per request and the APEX decision.
//   components   the attribution, semantic, response-consistency, integrity and contract functions in
//                isolation at 6/24/36 synthetic evidence records (the retrieval budget), for a claim
//                that restates its record and a claim that reverses it. Also scales the claim count to
//                the 12-claim structural bound. This is the modules' own cost, printed apart from a
//                request and never subtracted from it.
//   adversarial  ten contradiction fixtures plus a supported control, each through the complete
//                controller at --adversarial-size records. Checks that no class reaches
//                factually_supported and that the answer is shown with a notice.
//
// Measurement rules: timings are monotonic (`performance.now`). Warm-up requests are run but not
// measured. A duration that was not produced is `null`, never zero, and the tables print `n/a` for it.
// p95 is printed only at 20 or more samples. Fixtures are written only into a fresh temporary
// directory, which is removed unless --keep is given. This is not part of `npm test`.
//
// What is measured is a bounded lexical comparison against retrieved records. It is not natural-
// language inference, and a fast result here says nothing about whether the comparison is sufficient
// for a paraphrase, an implication or a causal claim. The fixtures are worded so the class is
// decidable by the rule; the benchmark does not claim otherwise.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { extractClaims } from '../src/cognition/claims.js';
import { validateStructuredResponse } from '../src/cognition/response.js';
import { Intent } from '../src/cognition/vocabulary.js';
import {
  ResponseTrustState,
  assessClaimAttribution,
  assessResponseIntegrity,
  buildResponseContract,
} from '../src/cognition/response-integrity.js';
import {
  SemanticFinding,
  assessClaimSemantics,
  assessResponseConsistency,
} from '../src/cognition/semantic-consistency.js';

const NOW = () => new Date('2026-06-01T00:00:00.000Z');
const QUESTION = 'tell me about the lighthouse project status';
const TARGET = 'the lighthouse project status is green';
const DEFAULT_SIZES = [20, 200, 1000, 4000];
const EVIDENCE_COUNTS = [6, 24, 36];
const CLAIM_COUNTS = [1, 4, 8, 12];
const MAX_REPEATS = 15;
const DEFAULT_REPEATS = 7;
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const PREFIX = 'apex-bench-ap09-';
const dirs = [];

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
  const opts = {
    repeats: DEFAULT_REPEATS, keep: false, phase: 'all', sizes: DEFAULT_SIZES, adversarialSize: 200, help: false,
  };
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
      if (value.length === 0 || value.some((n) => !Number.isInteger(n) || n < 1)) throw new Error('--sizes must be positive integers');
      opts.sizes = [...new Set(value)].sort((a, b) => a - b);
      i += 1;
    } else if (arg === '--adversarial-size') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--adversarial-size must be a positive integer');
      opts.adversarialSize = value;
      i += 1;
    } else if (arg === '--phase') {
      const name = argv[i + 1];
      if (!['request', 'components', 'adversarial', 'all'].includes(name)) throw new Error(`unknown phase ${name}`);
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

function ms(value) {
  return Number.isFinite(value) ? `${value.toFixed(3)} ms` : 'n/a';
}

function us(value) {
  return Number.isFinite(value) ? `${(value * 1000).toFixed(2)} us` : 'n/a';
}

async function timed(fn) {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
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

// The knowledge fixture names the same three words the request asks about. Knowledge triples enter the
// prompt only above the fixed relevance floor. Until AP-10 a query word absent from the store was
// weighted by log(2n+2), which grows without bound with corpus size, so a triple matching two of three
// asked words crossed that floor between 1000 and 4000 records and the row silently dropped its
// knowledge evidence. AP-10 caps the absent-term weight at MAX_UNSEEN_TERM_WEIGHT, so that growth no
// longer happens; the fixture is deliberately unchanged so the AP-09 and AP-10 rows stay comparable.
// Matching all three words keeps the fixture above the floor at every size either way, so each row
// retrieves the same kind of context from a larger store.
async function seedHistory(app, target) {
  for (let i = 1; i <= target; i += 1) {
    await app.memory.add({
      content: `the lighthouse archive batch ${i} was recorded`,
      kind: 'user_fact',
      source: 'user',
    });
    await app.knowledge.add({
      subject: 'lighthouse project',
      relationship: 'status archive',
      object: `${i}`,
      origin: 'user',
    });
  }
}

// A record that restates the claim exactly, added last. Retrieval ranks equal scores by recency and
// then by append index, so the last record of the seeded history is the first retrieved one.
async function addTarget(app) {
  const record = await app.memory.add({ content: TARGET, kind: 'user_fact', source: 'user' });
  return record.id;
}

function groundedReply(evidenceId) {
  return 'The lighthouse project status is green.\n'
    + 'COGNITION ' + JSON.stringify({
      schema: 1,
      decision: 'answer',
      answer: 'The lighthouse project status is green.',
      claims: [{ text: TARGET, evidence: [`ev:memory:${evidenceId}`], kind: 'supported' }],
    });
}

function printRow(label, s, extra = '') {
  const tail = s.p95 === null ? '' : `, p95 ${ms(s.p95)}`;
  console.log(`  ${label.padEnd(30)} ${ms(s.median).padStart(10)} median (min ${ms(s.min)}, max ${ms(s.max)}${tail}) over ${s.n} sample(s)${extra}`);
}

// ---- phase: request ----------------------------------------------------------------------------

async function phaseRequest(opts) {
  const dataDir = tempDir();
  let evidenceId = null;
  const app = makeApp(dataDir, () => groundedReply(evidenceId));
  console.log('\nrequest: one grounded question through the complete deterministic path');
  console.log(`  request: "${QUESTION}"`);
  console.log('  the model is a deterministic in-process fixture returning one COGNITION line that cites the');
  console.log('  seeded record; every expected value below is APEX\'s own classification of that reply');
  console.log('  records | evidence | wall per request | status | trust | semantic finding | contract reached');
  let seededTotal = 0;
  for (const size of opts.sizes) {
    const fillersNeeded = size - 1 - seededTotal;
    if (fillersNeeded > 0) {
      await seedHistory(app, fillersNeeded);
      seededTotal += fillersNeeded;
    }
    evidenceId = await addTarget(app);
    seededTotal += 1;
    // Warm-up requests are not measured; they let the store's read path reach steady state.
    for (let i = 0; i < 2; i += 1) {
      const warm = await app.controller.handle(QUESTION, { origin: 'user' });
      const warmIntegrity = warm.operation?.cognition?.responseIntegrity;
      if (warmIntegrity?.trust !== ResponseTrustState.FACTUALLY_SUPPORTED) {
        throw new Error(`fixture did not reach a grounded assessment at ${size} records: `
          + `${warmIntegrity?.trust} / ${warm.status}`);
      }
    }
    const runs = [];
    for (let i = 0; i < opts.repeats; i += 1) {
      const r = await timed(() => app.controller.handle(QUESTION, { origin: 'user' }));
      runs.push({ ms: r.ms, result: r.value });
    }
    const wall = stats(runs.map((r) => r.ms));
    const last = runs[runs.length - 1].result;
    const integrity = last.operation?.cognition?.responseIntegrity ?? null;
    const contract = last.operation?.cognition?.responseContract ?? null;
    const evidence = last.operation?.cognition?.evidence?.total ?? null;
    console.log(`  ${String(size).padStart(7)} | ${String(evidence).padStart(8)} | ${ms(wall.median).padStart(15)} | `
      + `${String(last.status).padEnd(22)} | ${String(integrity?.trust).padEnd(24)} | `
      + `${String(integrity?.semantic?.finding).padEnd(22)} | ${contract?.reachedThrough ?? 'n/a'}`);
    printRow(`  wall, ${size} records`, wall, `, contract ok ${contract?.ok}`);
  }
  console.log('  A size row adds one target record; the filler history ahead of it is never re-seeded, so a');
  console.log('  larger row measures retrieval and assessment over a larger store, not a different request.');
  console.log('  The knowledge fixture matches all three asked words, which keeps it above the fixed prompt');
  console.log('  relevance floor at every size, so the evidence column stays comparable between rows.');
}

// ---- phase: components -------------------------------------------------------------------------

// Synthetic evidence and a synthetic analysis shaped like the retrieval artifact. No store is read.
function syntheticEvidence(count) {
  return Array.from({ length: count }, (_, i) => ({
    evidenceId: `ev:memory:syn-${i + 1}`,
    source: 'memory',
    recordId: `syn-${i + 1}`,
    type: 'memory',
    subject: null,
    claim: `synthetic record ${i + 1} states a stable value`,
    observedAt: null,
    recordedAt: null,
    provenance: { origin: 'user', operationId: null, updateMode: null },
    status: 'recorded',
    current: true,
    retrievalReason: 'benchmark-fixture',
    relationships: { supports: [], contradicts: [] },
    contradicts: [],
  }));
}

function syntheticAnalysis(evidence) {
  return {
    available: true,
    understanding: { intent: Intent.STORED_INFORMATION, intents: [Intent.STORED_INFORMATION] },
    retrieval: {
      evidence,
      byId: new Map(evidence.map((item) => [item.evidenceId, item])),
      conflicts: [],
      omitted: [],
      read: { state: 'complete', complete: true },
      sources: [{ source: 'memory', status: 'ok' }],
      counts: { total: evidence.length, dropped: 0, unavailable: [], damaged: [] },
    },
    claims: extractClaims({ evidence, conflicts: [] }),
    deliberation: {
      decision: 'answer',
      conclusion: { kind: 'supported' },
      uncertainty: null,
      disclosures: [],
      contradicting: [],
      missing: [],
      interpretations: [],
      assumptions: [],
      recommendation: null,
      clarification: null,
    },
  };
}

const CONSISTENT_TEXT = 'synthetic record 1 states a stable value';
const ADVERSARIAL_TEXT = 'synthetic record 1 does not state a stable value';

function structuredCheck(analysis, claims) {
  const validation = validateStructuredResponse({
    schema: 1,
    decision: 'answer',
    answer: claims[0].text,
    claims,
  }, { analysis });
  if (!validation.ok) throw new Error(`benchmark fixture is not a valid structured reply: ${validation.problems.join('; ')}`);
  return { found: true, structure: validation.value, error: null, validation };
}

function oneClaim(analysis, text) {
  const first = analysis.retrieval.evidence[0];
  return { text, evidence: [first.evidenceId], kind: 'supported' };
}

function componentSamples(analysis, check) {
  const claim = check.structure.claims[0];
  const semantic = assessClaimSemantics({
    text: claim.text,
    evidenceIds: claim.evidenceIds,
    evidenceById: analysis.retrieval.byId,
    kind: claim.kind ?? 'supported',
    evidenceState: claim.evidenceState ?? null,
    read: analysis.retrieval.read,
  });
  const input = { analysis, text: check.structure.answer, classification: 'valid', check };
  return {
    attribution: () => assessClaimAttribution(claim.text, claim.evidenceIds, analysis.retrieval.byId),
    semantic: () => assessClaimSemantics({
      text: claim.text,
      evidenceIds: claim.evidenceIds,
      evidenceById: analysis.retrieval.byId,
      kind: claim.kind ?? 'supported',
      evidenceState: claim.evidenceState ?? null,
      read: analysis.retrieval.read,
    }),
    consistency: () => assessResponseConsistency({ claims: [{ ...claim, semantic }] }),
    integrity: () => assessResponseIntegrity(input),
    contract: () => buildResponseContract({
      analysis, model: { prepared: true, class: 'valid', ok: true }, check, text: check.structure.answer, finalAnswer: true,
    }),
  };
}

async function phaseComponents(opts) {
  console.log('\ncomponents: the AP-09 functions alone, no store, no model and no clock');
  console.log('  evidence | reply | attribution | semantic | consistency | integrity | contract (median per call)');
  const ITERATIONS = 200;
  for (const count of EVIDENCE_COUNTS) {
    const analysis = syntheticAnalysis(syntheticEvidence(count));
    for (const [label, text] of [['consistent', CONSISTENT_TEXT], ['adversarial', ADVERSARIAL_TEXT]]) {
      const check = structuredCheck(analysis, [oneClaim(analysis, text)]);
      const fns = componentSamples(analysis, check);
      const expected = label === 'consistent' ? SemanticFinding.SEMANTICALLY_CONSISTENT : null;
      const observed = fns.semantic().finding;
      if (expected !== null && observed !== expected) throw new Error(`consistent fixture assessed as ${observed}`);
      if (expected === null && observed === SemanticFinding.SEMANTICALLY_CONSISTENT) {
        throw new Error('adversarial fixture was assessed as consistent');
      }
      for (let i = 0; i < 20; i += 1) for (const fn of Object.values(fns)) fn();
      const samples = { attribution: [], semantic: [], consistency: [], integrity: [], contract: [] };
      for (let i = 0; i < ITERATIONS; i += 1) {
        for (const [name, fn] of Object.entries(fns)) {
          const started = performance.now();
          fn();
          samples[name].push(performance.now() - started);
        }
      }
      console.log(`  ${String(count).padStart(8)} | ${label.padEnd(11)} | ${us(stats(samples.attribution).median).padStart(11)} | `
        + `${us(stats(samples.semantic).median).padStart(8)} | ${us(stats(samples.consistency).median).padStart(11)} | `
        + `${us(stats(samples.integrity).median).padStart(9)} | ${us(stats(samples.contract).median).padStart(8)} (${observed})`);
    }
  }
  console.log(`  ${ITERATIONS} measured calls per function per row after 20 warm-ups. Each function is timed on`);
  console.log('  its own; the integrity figure re-runs attribution and semantic assessment internally, so the');
  console.log('  columns are not additive and none includes a store read or a model call.');

  console.log('\ncomponents: claim-count scaling of the integrity assessment at 36 evidence records');
  console.log('  claims | integrity median | response finding | assessed | contradictions');
  const analysis = syntheticAnalysis(syntheticEvidence(36));
  const first = analysis.retrieval.evidence[0];
  for (const n of CLAIM_COUNTS) {
    const claims = Array.from({ length: n }, (_, i) => ({
      text: i % 2 === 0 ? CONSISTENT_TEXT : ADVERSARIAL_TEXT,
      evidence: [first.evidenceId],
      kind: 'supported',
    }));
    const check = structuredCheck(analysis, claims);
    const input = { analysis, text: check.structure.answer, classification: 'valid', check };
    for (let i = 0; i < 20; i += 1) assessResponseIntegrity(input);
    const samples = [];
    let last = null;
    for (let i = 0; i < 200; i += 1) {
      const started = performance.now();
      last = assessResponseIntegrity(input);
      samples.push(performance.now() - started);
    }
    const assessed = last.trust.claims.filter((claim) => claim.semantic).length;
    console.log(`  ${String(n).padStart(6)} | ${us(stats(samples).median).padStart(16)} | `
      + `${String(last.consistency.finding).padEnd(22)} | ${String(assessed).padStart(8)} | `
      + `${String(last.consistency.contradictions.length).padStart(14)}`);
  }
  console.log('  Every side of the scaling row is a constant bound (12 claims, 6 compared pairs); the growth');
  console.log('  shown is the per-claim comparison, not an unbounded scan.');
}

// ---- phase: adversarial ------------------------------------------------------------------------

const ADVERSARIAL_CLASSES = [
  {
    name: 'control: exact restatement',
    record: 'the deployment was approved',
    claim: 'the deployment was approved',
    query: 'tell me about the deployment',
    feedback: SemanticFinding.SEMANTICALLY_CONSISTENT,
    supported: true,
  },
  {
    name: 'polarity reversal',
    record: 'the deployment was approved',
    claim: 'the deployment was not approved',
    query: 'tell me about the deployment',
    feedback: SemanticFinding.POLARITY_CONFLICT,
  },
  {
    name: 'changed quantity',
    record: 'the archive retention window is at least 30 days',
    claim: 'the archive retention window is 3 days',
    query: 'tell me about the archive retention window',
    feedback: SemanticFinding.NUMERICAL_CONFLICT,
  },
  {
    name: 'bound stated as an exact value',
    record: 'the archive retention window is at least 30 days',
    claim: 'the archive retention window is 30 days',
    query: 'tell me about the archive retention window',
    feedback: SemanticFinding.NUMERICAL_CONFLICT,
  },
  {
    name: 'changed date',
    record: 'the release happened on 2026-04-01',
    claim: 'the release happened on 2026-04-02',
    query: 'tell me about the release',
    feedback: SemanticFinding.TEMPORAL_CONFLICT,
  },
  {
    name: 'swapped entity',
    record: 'the Aurora deployment succeeded',
    claim: 'the Meridian deployment succeeded',
    query: 'tell me about the deployment',
    feedback: SemanticFinding.ENTITY_CONFLICT,
  },
  {
    name: 'reversed relationship',
    record: 'the operator owns the vault',
    claim: 'the vault owns the operator',
    query: 'tell me about the operator',
    feedback: SemanticFinding.RELATIONSHIP_CONFLICT,
  },
  {
    name: 'widened quantifier',
    record: 'some checks passed',
    claim: 'all checks passed',
    query: 'tell me about the checks',
    feedback: SemanticFinding.QUALIFIER_CONFLICT,
  },
  {
    name: 'added cause',
    record: 'the deployment failed',
    claim: 'the deployment failed because the cache expired',
    query: 'tell me about the deployment',
    feedback: SemanticFinding.UNSUPPORTED_TRANSFORMATION,
  },
  {
    name: 'unestablished meaning',
    record: 'the deployment was approved',
    claim: 'the deployment was not fully approved',
    query: 'tell me about the deployment',
    feedback: SemanticFinding.AMBIGUOUS,
  },
  {
    name: 'omitted quantity',
    record: 'the release shipped with 3 known bugs',
    claim: 'the release shipped',
    query: 'tell me about the release',
    feedback: SemanticFinding.PARTIALLY_CONSISTENT,
  },
];

async function adversarialRun(entry, opts) {
  const dataDir = tempDir();
  let evidenceId = null;
  const app = makeApp(dataDir, () => {
    const claim = { text: entry.claim, evidence: [`ev:memory:${evidenceId}`], kind: 'supported' };
    return `${entry.claim}\nCOGNITION ${JSON.stringify({
      schema: 1, decision: 'answer', answer: entry.claim, claims: [claim],
    })}`;
  });
  await seedHistory(app, Math.max(0, opts.adversarialSize - 1));
  const record = await app.memory.add({ content: entry.record, kind: 'user_fact', source: 'user' });
  evidenceId = record.id;
  const query = entry.query;
  for (let i = 0; i < 2; i += 1) await app.controller.handle(query, { origin: 'user' });
  const runs = [];
  for (let i = 0; i < opts.repeats; i += 1) {
    const r = await timed(() => app.controller.handle(query, { origin: 'user' }));
    runs.push({ ms: r.ms, result: r.value });
  }
  const last = runs[runs.length - 1].result;
  const integrity = last.operation?.cognition?.responseIntegrity ?? null;
  return {
    wall: stats(runs.map((r) => r.ms)),
    trust: integrity?.trust ?? null,
    degradation: integrity?.degradation ?? null,
    finding: integrity?.semantic?.finding ?? null,
    limitations: integrity?.limitations ?? [],
    notice: (last.output ?? '').includes('[APEX check:'),
    result: last,
  };
}

async function phaseAdversarial(opts) {
  console.log(`\nadversarial: one request per class through the complete controller at ${opts.adversarialSize} records`);
  console.log('  class | wall median | trust | semantic finding | limitations | notice | expected');
  const failures = [];
  for (const entry of ADVERSARIAL_CLASSES) {
    const out = await adversarialRun(entry, opts);
    if (out.finding !== entry.feedback) failures.push(`${entry.name}: finding ${out.finding} != ${entry.feedback}`);
    if (entry.supported) {
      if (out.trust !== ResponseTrustState.FACTUALLY_SUPPORTED) failures.push(`${entry.name}: trust ${out.trust}`);
      if (out.notice) failures.push(`${entry.name}: a supported control carried a notice`);
    } else {
      if (out.trust === ResponseTrustState.FACTUALLY_SUPPORTED || out.trust === ResponseTrustState.VERIFIED) {
        failures.push(`${entry.name}: an adversarial class reached ${out.trust}`);
      }
      if (!out.notice) failures.push(`${entry.name}: the answer carried no notice`);
      if (out.degradation !== 'present_with_limitations') failures.push(`${entry.name}: degradation ${out.degradation}`);
    }
    console.log(`  ${entry.name.padEnd(30)} | ${ms(out.wall.median).padStart(11)} | ${String(out.trust).padEnd(24)} | `
      + `${String(out.finding).padEnd(24)} | ${out.limitations.filter((code) => code.startsWith('semantic_')).join(',') || 'n/a'} | `
      + `${out.notice ? 'yes' : 'no '} | ${entry.feedback}`);
  }
  if (failures.length > 0) {
    throw new Error(`adversarial phase self-check failed:\n  ${failures.join('\n  ')}`);
  }
  console.log('  Every adversarial class stayed at presentation with a stated limitation; the supported control');
  console.log('  reached factual support only. No class reached verified, which no path can.');
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node benchmarks/run-semantic-validation-benchmark.mjs [--repeats R] [--phase request|components|adversarial|all] [--sizes 20,200,1000,4000] [--adversarial-size 200] [--keep]');
  console.log('  network-free; deterministic in-process model fixture; writes only into a fresh temporary directory; not part of npm test');
} else {
  console.log(`node ${process.version} on ${process.platform} ${process.arch}, `
    + `${os.cpus().length} logical CPU(s), ${Math.round(os.totalmem() / 1073741824)} GiB reported memory; repeats ${opts.repeats}`);
  console.log('No inference is run and no network is used: the model is an in-process fixture object returning');
  console.log('fixed synthetic text. Fixtures are written through the stores\' own validated write paths into a');
  console.log('fresh temporary data directory, which is removed at the end unless --keep is passed.');
  console.log('The semantic check is a bounded lexical comparison, not natural-language inference; no NLU or');
  console.log('entailment capability is claimed. No index, cache or schema was added for this benchmark.');
  try {
    if (opts.phase === 'all' || opts.phase === 'request') await phaseRequest(opts);
    if (opts.phase === 'all' || opts.phase === 'components') await phaseComponents(opts);
    if (opts.phase === 'all' || opts.phase === 'adversarial') await phaseAdversarial(opts);
  } finally {
    if (opts.keep) {
      console.log(`\nkept: ${dirs.join(', ')}`);
    } else {
      for (const dir of dirs) removeDir(dir);
      console.log('\ntemporary data directories removed; nothing outside them was written.');
    }
  }
}
