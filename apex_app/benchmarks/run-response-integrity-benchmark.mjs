// Bounded, network-free benchmark for the Batch AP-08 request-to-response path and its integrity work.
//
// Every measured request is handled by a real controller against a fresh temporary data directory. The
// model is a deterministic in-process fixture object implementing the same small backend interface the
// HTTP backends implement; it returns fixed synthetic text, so the gateway classification, structured
// reply validation, trust assessment, response contract, proposal validation, registry authorization,
// execution and verification all run through their real code paths. No inference is run, no socket is
// opened, no endpoint is named, and no model quality is claimed.
//
//   node benchmarks/run-response-integrity-benchmark.mjs [--repeats R] [--phase request|assessment|record|all] [--keep]
//
// Phases:
//   request     one grounded question through the complete deterministic path at small (20),
//               medium (200) and large (1000) memory+knowledge histories. Reports wall time per
//               request, the status, the trust state, the finding, and the contract's reached stage.
//   assessment  the AP-08 assessment and contract functions in isolation at 6/24/36 synthetic evidence
//               records (the retrieval budget), for a plain reply and for a structured grounded reply.
//               This is the module's own cost, printed separately and never subtracted from a request.
//   record      repeated identical requests: whether the stored integrity and contract audits are
//               byte-identical, and how large the bounded audits are.
//
// Measurement rules: timings are monotonic (`performance.now`). Warm-up requests are run but not
// measured. A duration that was not produced is `null`, never zero, and the tables print `n/a` for it.
// p95 is printed only at 20 or more samples, because a smaller sample cannot support it. Fixtures are
// written only into a fresh temporary directory, which is removed unless --keep is given. This is not
// part of `npm test`.
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
  assessResponseIntegrity,
  buildResponseContract,
  responseContractAudit,
  responseIntegrityAudit,
} from '../src/cognition/response-integrity.js';

const NOW = () => new Date('2026-06-01T00:00:00.000Z');
const QUESTION = 'tell me about the lighthouse project status';
const TARGET = 'the lighthouse project status is green';
const SIZES = [20, 200, 1000];
const EVIDENCE_COUNTS = [6, 24, 36];
const MAX_REPEATS = 25;
const DEFAULT_REPEATS = 9;
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const PREFIX = 'apex-bench-ap08-';
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
  const opts = { repeats: DEFAULT_REPEATS, keep: false, phase: 'all', help: false };
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
      if (!['request', 'assessment', 'record', 'all'].includes(name)) throw new Error(`unknown phase ${name}`);
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

async function seedHistory(app, target) {
  for (let i = 1; i <= target; i += 1) {
    await app.memory.add({
      content: `the lighthouse archive batch ${i} was recorded`,
      kind: 'user_fact',
      source: 'user',
    });
    await app.knowledge.add({
      subject: 'lighthouse project',
      relationship: 'archived batch',
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

async function phaseRequest(opts) {
  const dataDir = tempDir();
  let evidenceId = null;
  const app = makeApp(dataDir, () => groundedReply(evidenceId));
  console.log('\nrequest: one grounded question through the complete deterministic path');
  console.log(`  request: "${QUESTION}"`);
  console.log('  the model is a deterministic in-process fixture returning one COGNITION line that cites the');
  console.log('  seeded record; the record is APEX\'s own classification of that reply');
  console.log('  records | evidence | wall per request | status | trust | finding | contract reached');
  let seededTotal = 0;
  for (const size of SIZES) {
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
      if (warm.operation?.cognition?.responseIntegrity?.trust !== 'factually_supported') {
        throw new Error(`fixture did not reach a grounded assessment at ${size} records: `
          + `${warm.operation?.cognition?.responseIntegrity?.trust} / ${warm.status}`);
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
      + `${String(last.status).padEnd(22)} | ${String(integrity?.trust).padEnd(24)} | ${String(integrity?.finding).padEnd(20)} | ${contract?.reachedThrough ?? 'n/a'}`);
    printRow(`  wall, ${size} records`, wall, `, contract ok ${contract?.ok}`);
  }
  console.log('  A size row adds one target record; the filler history ahead of it is never re-seeded, so a');
  console.log('  larger row measures retrieval over a larger store rather than a different request.');
}

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

function structuredCheck(analysis) {
  const first = analysis.retrieval.evidence[0];
  const validation = validateStructuredResponse({
    schema: 1,
    decision: 'answer',
    answer: first.claim,
    claims: [{ text: first.claim, evidence: [first.evidenceId], kind: 'supported' }],
  }, { analysis });
  if (!validation.ok) throw new Error(`benchmark fixture is not a valid structured reply: ${validation.problems.join('; ')}`);
  return { found: true, structure: validation.value, error: null, validation };
}

async function phaseAssessment(opts) {
  console.log('\nassessment: the AP-08 functions alone, no store and no clock');
  console.log('  evidence | reply | assess + contract median | assess | contract | min | max');
  const ITERATIONS = 200;
  for (const count of EVIDENCE_COUNTS) {
    const analysis = syntheticAnalysis(syntheticEvidence(count));
    const check = structuredCheck(analysis);
    const conditions = [
      ['plain', { analysis, text: 'The synthetic records were read.', classification: 'valid', check: null }],
      ['structured', { analysis, text: check.structure.answer, classification: 'valid', check }],
    ];
    for (const [label, input] of conditions) {
      // Warm-up.
      for (let i = 0; i < 20; i += 1) {
        assessResponseIntegrity(input);
        buildResponseContract({ analysis, model: { prepared: true, class: 'valid', ok: true }, check: input.check, text: input.text, finalAnswer: true });
      }
      const both = [];
      const assessOnly = [];
      const contractOnly = [];
      for (let i = 0; i < ITERATIONS; i += 1) {
        const a0 = performance.now();
        assessResponseIntegrity(input);
        const a1 = performance.now();
        buildResponseContract({ analysis, model: { prepared: true, class: 'valid', ok: true }, check: input.check, text: input.text, finalAnswer: true });
        const a2 = performance.now();
        both.push(a1 - a0 + a2 - a1);
        assessOnly.push(a1 - a0);
        contractOnly.push(a2 - a1);
      }
      const b = stats(both);
      const a = stats(assessOnly);
      const c = stats(contractOnly);
      console.log(`  ${String(count).padStart(8)} | ${label.padEnd(10)} | ${us(b.median).padStart(25)} | ${us(a.median).padStart(7)} | ${us(c.median).padStart(9)} | ${us(b.min).padStart(8)} | ${us(b.max).padStart(8)}`);
    }
  }
  console.log(`  ${ITERATIONS} measured iterations per row after 20 warm-ups; each iteration assesses the reply`);
  console.log('  and builds the fourteen-stage contract once. The two are timed together and also printed apart,');
  console.log('  so a change in either is visible. Neither figure includes a store read or a model call.');
}

async function phaseRecord(opts) {
  const dataDir = tempDir();
  let evidenceId = null;
  const app = makeApp(dataDir, () => groundedReply(evidenceId));
  await seedHistory(app, 20);
  evidenceId = await addTarget(app);
  await app.controller.handle(QUESTION, { origin: 'user' });

  const integrity = [];
  const contract = [];
  const combined = [];
  let firstRecordCount = null;
  let lastRecordCount = null;
  for (let i = 0; i < Math.max(5, Math.min(opts.repeats, 20)); i += 1) {
    const res = await app.controller.handle(QUESTION, { origin: 'user' });
    const stored = res.operation.cognition.responseContract;
    const iAudit = JSON.stringify(res.operation.cognition.responseIntegrity);
    // Each request appends a conversation turn, which later requests retrieve as evidence. The record
    // count and prompt length therefore grow; the classification, stage outcomes and checks must not.
    const cAudit = JSON.stringify({
      ok: stored.ok,
      reachedThrough: stored.reachedThrough,
      stages: stored.stages.map((entry) => ({ order: entry.order, id: entry.id, status: entry.status })),
      checks: stored.checks,
      authority: stored.authority,
    });
    integrity.push(iAudit);
    contract.push(cAudit);
    combined.push(JSON.stringify({ integrity: JSON.parse(iAudit), contract: JSON.parse(cAudit) }));
    const records = stored.stages.find((entry) => entry.order === 3)?.counts?.records ?? null;
    if (firstRecordCount === null) firstRecordCount = records;
    lastRecordCount = records;
  }
  const distinctIntegrity = new Set(integrity).size;
  const distinctContract = new Set(contract).size;
  const distinctCombined = new Set(combined).size;
  const size = stats(combined.map((text) => text.length));
  console.log('\nrecord: repeated identical requests');
  console.log(`  requests: ${combined.length}; distinct integrity audits ${distinctIntegrity}, distinct contract skeletons ${distinctContract}, distinct pairs ${distinctCombined}`);
  console.log(`  retrieved records per request: ${firstRecordCount} (first) -> ${lastRecordCount} (last): each request appends a`);
  console.log('    conversation turn that later requests retrieve, so counts and prompt length legitimately grow;');
  console.log('    the contract skeleton above compares stage outcomes and checks, not those counts');
  console.log(`  stored integrity + contract skeleton size: ${size.min}..${size.max} bytes, median ${size.median}`);
  const keys = Object.keys(JSON.parse(integrity[0])).sort();
  console.log(`  integrity keys: ${keys.join(', ')}`);
  const stageKeys = Object.keys(JSON.parse(integrity[0]).claims ?? {}).sort();
  console.log(`  claim-count keys: ${stageKeys.join(', ')}`);
  console.log('  A distinct count above one means a stage outcome, check, or assessment field varied between');
  console.log('  identical requests. The audit holds states, counts and bounded limitation codes; it holds no');
  console.log('  request text, record text, or model prose.');
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node benchmarks/run-response-integrity-benchmark.mjs [--repeats R] [--phase request|assessment|record|all] [--keep]');
  console.log('  network-free; deterministic in-process model fixture; writes only into a fresh temporary directory; not part of npm test');
} else {
  console.log(`node ${process.version} on ${process.platform} ${process.arch}, `
    + `${os.cpus().length} logical CPU(s), ${Math.round(os.totalmem() / 1073741824)} GiB reported memory; repeats ${opts.repeats}`);
  console.log('No inference is run and no network is used: the model is an in-process fixture object returning');
  console.log('fixed synthetic text. Fixtures are written through the stores\' own validated write paths into a');
  console.log('fresh temporary data directory, which is removed at the end unless --keep is passed.');
  try {
    if (opts.phase === 'all' || opts.phase === 'request') await phaseRequest(opts);
    if (opts.phase === 'all' || opts.phase === 'assessment') await phaseAssessment(opts);
    if (opts.phase === 'all' || opts.phase === 'record') await phaseRecord(opts);
  } finally {
    if (opts.keep) {
      console.log(`\nkept: ${dirs.join(', ')}`);
    } else {
      for (const dir of dirs) removeDir(dir);
      console.log('\ntemporary data directories removed; nothing outside them was written.');
    }
  }
}
