// Bounded, network-free T-13 structural benchmark. It measures the deterministic projection and
// dependency algorithms over synthetic records; it does not claim retrieval quality, model quality or
// human reasoning. No inference process, endpoint or socket is used.
//
//   node benchmarks/run-reasoning-benchmark.mjs [--sizes 100,1000,5000]
import { performance } from 'node:perf_hooks';
import { normalizeBaseEvidence, dedupeEvidence } from '../src/reasoning/evidence.js';
import { assessEvidence, buildHypotheses } from '../src/reasoning/engine.js';
import { buildDependencyGraph } from '../src/reasoning/dependencies.js';

const arg = process.argv.slice(2);
const sizeArg = arg.includes('--sizes') ? arg[arg.indexOf('--sizes') + 1] : '100,1000,5000';
const sizes = String(sizeArg).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function evidenceAt(size) {
  return Array.from({ length: size }, (_, i) => ({
    evidenceId: `ev:bench:record:${i}`,
    source: i % 3 === 0 ? 'memory' : i % 3 === 1 ? 'knowledge' : 'document',
    recordId: String(i),
    claim: `synthetic evidence ${i}: Atlas requirement value ${i}`,
    provenance: { origin: 'user_supplied' },
    current: true,
    validity: 'current',
    status: 'supported',
  }));
}

function graphAt(size) {
  const steps = Array.from({ length: size }, (_, i) => ({
    id: `s${i + 1}`,
    description: `synthetic step ${i + 1}`,
    action: 'world.fact.add',
    input: {},
    dependsOn: i === 0 ? [] : [`s${i}`],
    expectedResult: `s${i + 1} is complete`,
    verification: `s${i + 1} is checked`,
    risk: 'low',
  }));
  return buildDependencyGraph([{ id: 'bench-plan', status: 'active', steps }], { maxNodes: size });
}

const report = { schema: 'apex.reasoning.benchmark/1', network: false, inference: false, sizes: [] };
for (const size of sizes) {
  const raw = evidenceAt(size);

  let started = performance.now();
  const normalized = normalizeBaseEvidence(raw, new Date().toISOString(), { perSource: size });
  const normalizedMs = performance.now() - started;

  started = performance.now();
  const deduped = dedupeEvidence(normalized, { max: size });
  const dedupedMs = performance.now() - started;

  started = performance.now();
  const assessment = assessEvidence(deduped, { now: new Date().toISOString(), conflicts: [] });
  const assessmentMs = performance.now() - started;

  started = performance.now();
  const hypotheses = buildHypotheses({
    evidence: deduped,
    assessment,
    baseHypotheses: { hypotheses: [], selection: null },
  });
  const hypothesesMs = performance.now() - started;

  started = performance.now();
  const graph = graphAt(size);
  const graphMs = performance.now() - started;

  report.sizes.push({
    size,
    evidence: deduped.length,
    nodes: graph.totalNodes,
    edges: graph.edges.length,
    timingsMs: {
      normalize: Number(normalizedMs.toFixed(3)),
      dedupe: Number(dedupedMs.toFixed(3)),
      assess: Number(assessmentMs.toFixed(3)),
      hypotheses: Number(hypothesesMs.toFixed(3)),
      dependencyGraph: Number(graphMs.toFixed(3)),
    },
    counts: {
      supporting: assessment.counts.supporting,
      contextual: assessment.counts.contextual,
      hypotheses: hypotheses.hypotheses.length,
      blocked: graph.blocked.length,
      cycles: graph.cycles.length,
    },
  });
}

report.medianDependencyGraphMs = Number(median(report.sizes.map((entry) => entry.timingsMs.dependencyGraph)).toFixed(3));
console.log(JSON.stringify(report, null, 2));
