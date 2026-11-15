// Bounded, model-free benchmark for the offline deterministic answer path.
//
// With no inference backend configured, a model-shaped request now runs the same model-free cognitive
// analysis the configured path always ran and, when the retrieved records support a conclusion, answers
// from them as a cited, bounded reading (success_deterministic). This measures that path through the real
// controller against synthetic fixtures in a fresh temporary data directory. No inference is run or
// simulated: a NoBackend is constructed, so no model is contacted. This is not part of `npm test` and no
// test depends on it.
//
//   node benchmarks/run-offline-answer-benchmark.mjs [--repeats R] [--keep]
//
// It reports, at progressive memory sizes, the median latency of a supported deterministic answer and of
// the no-evidence fallback (model_unavailable) that shares the same analysis, plus their in-run ratio.
// Only in-run ratios are treated as findings: absolute timings swing with machine load, so no cross-run
// before/after is claimed. The first sample is cold (store/index warm-up); the median excludes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';

const args = process.argv.slice(2);
const repeatsArg = args.indexOf('--repeats');
const SAMPLES = repeatsArg >= 0 ? Math.max(3, Number(args[repeatsArg + 1]) || 5) : 5;
const KEEP = args.includes('--keep');
const SIZES = [20, 200, 1000];
const NOW = '2026-11-15T00:00:00.000Z';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-offline-bench-')); }
function median(xs) { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

async function seed(app, n) {
  // One relevant fact plus n-1 clearly unrelated filler notes, written through the store's own path.
  await app.memory.add({ content: 'the project codename is Lighthouse', kind: 'user_fact', source: 'user' });
  for (let i = 1; i < n; i += 1) {
    await app.memory.add({ content: `filler note ${i} about an unrelated topic ${i}`, kind: 'user_fact', source: 'user' });
  }
}

async function timeHandle(app, request, samples) {
  const ts = [];
  let last = null;
  for (let i = 0; i < samples; i += 1) {
    const t0 = performance.now();
    last = await app.controller.handle(request, { origin: 'user' });
    ts.push(performance.now() - t0);
  }
  return { ms: median(ts), all: ts.map((x) => +x.toFixed(1)), status: last.status };
}

const dirs = [];
const rows = [];
for (const n of SIZES) {
  const dir = tempDir();
  dirs.push(dir);
  const app = createApp({ dataDir: dir, gateway: new ModelGateway({ backend: new NoBackend() }), experienceCapture: CAPTURE_OFF, now: () => new Date(NOW) });
  await seed(app, n);
  const answered = await timeHandle(app, 'what is the codename of the project?', SAMPLES);
  const fallback = await timeHandle(app, 'what is the capital of France?', SAMPLES);
  rows.push({ n, answered, fallback });
}

console.log(`Offline deterministic answer through the real controller (no model). Medians of ${SAMPLES} samples, one run, no overlap.`);
console.log('size | deterministic-answer ms (status) | no-evidence fallback ms (status) | answer/fallback ratio | per-sample answer ms');
for (const r of rows) {
  const ratio = (r.answered.ms / r.fallback.ms).toFixed(2);
  console.log(`${r.n} | ${r.answered.ms.toFixed(1)} (${r.answered.status}) | ${r.fallback.ms.toFixed(1)} (${r.fallback.status}) | ${ratio} | [${r.answered.all.join(', ')}]`);
}
const a0 = rows[0].answered.ms;
const aN = rows[rows.length - 1].answered.ms;
console.log(`In-run scaling: deterministic answer at ${SIZES[SIZES.length - 1]} records is ${(aN / a0).toFixed(2)}x the ${SIZES[0]}-record cost.`);
console.log('Both columns run the same model-free analysis; the ratio isolates the rendering/contract cost of a supported answer.');
console.log('This measures the new path\'s internal cost, not a before/after: the offline path now runs the analysis it previously skipped.');

if (!KEEP) for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });