// Bounded, model-free benchmark for the world-state projection (Batch T).
//
// It measures APEX's own read path: store load, store-wide health scan, projection build,
// and render, against synthetic fixtures written into a fresh temporary data directory.
// No model is contacted, nothing is downloaded, no service is started, and the projection
// itself persists nothing (the script verifies that the store files are unchanged by reads).
//
//   node benchmarks/run-world-state-benchmark.mjs [--memory N] [--claims N] [--repeats R] [--keep]
//
// Bounds: memory fixtures are written directly as valid records, claims are appended
// through KnowledgeStore.add, so seeding cost is reported separately from read cost.
// This is not part of `npm test` and no test depends on it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../src/memory/memory-store.js';
import { KnowledgeStore } from '../src/knowledge/knowledge-store.js';
import { createApp } from '../src/app.js';
import { buildWorldState, renderWorldState } from '../src/world/world-state.js';
import { worldActions } from '../src/actions/world-actions.js';

const MAX_MEMORY_FIXTURE = 20000;
const MAX_CLAIM_FIXTURE = 2000;
const MAX_REPEATS = 25;

function parseArgs(argv) {
  const opts = { memory: 2000, claims: 2000, repeats: 7, keep: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--keep') {
      opts.keep = true;
    } else if (arg === '--memory') {
      opts.memory = bounded(argv[i + 1], 1, MAX_MEMORY_FIXTURE, '--memory');
      i += 1;
    } else if (arg === '--claims') {
      opts.claims = bounded(argv[i + 1], 1, MAX_CLAIM_FIXTURE, '--claims');
      i += 1;
    } else if (arg === '--repeats') {
      opts.repeats = bounded(argv[i + 1], 1, MAX_REPEATS, '--repeats');
      i += 1;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return opts;
}

function bounded(raw, min, max, label) {
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function timed(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, result };
}

async function timedAsync(fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, result };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
}

function fileState(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) {
      const content = fs.readFileSync(full);
      out[name] = { bytes: content.length, sha: sha256Hex(content.toString('utf8')) };
    }
  }
  return out;
}

// Memory records share one clause subject on purpose: the heuristic conflict scan compares
// the distinct values inside a subject group, so a single-subject fixture is the worst case
// the projection can present (it still only ever scans the read window).
function writeMemoryFixture(dir, count) {
  const createdAt = new Date(Date.UTC(2026, 0, 1)).toISOString();
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const content = `The archive index is entry${i}`;
    lines.push(JSON.stringify({
      schema: 1,
      id: randomUUID(),
      kind: 'user_fact',
      source: 'user',
      sensitivity: 'normal',
      content,
      contentSha256: sha256Hex(content),
      createdAt,
      provenance: { origin: 'user_request', updateMode: 'user_confirmed' },
    }));
  }
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

async function writeKnowledgeFixture(dir, count) {
  const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'), { now: () => new Date(Date.UTC(2026, 0, 1)) });
  for (let i = 0; i < count; i += 1) {
    await store.add({
      subject: `Ledger ${i}`,
      relationship: 'row',
      object: `value ${i}`,
      evidence: i % 2 === 0 ? `note ${i}` : null,
      origin: 'user',
    });
  }
  return store;
}

async function main() {
  const opts = (() => {
    try {
      return parseArgs(process.argv.slice(2));
    } catch (err) {
      console.error(`bench: ${err.message}`);
      process.exit(2);
    }
  })();
  if (opts.help) {
    console.log('usage: node benchmarks/run-world-state-benchmark.mjs [--memory N] [--claims N] [--repeats R] [--keep]');
    console.log(`  N for --memory is 1-${MAX_MEMORY_FIXTURE}, for --claims 1-${MAX_CLAIM_FIXTURE}, for --repeats 1-${MAX_REPEATS}`);
    return;
  }

  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'apex-world-bench-'));
  console.log(`fixture: ${opts.memory} memory record(s), ${opts.claims} knowledge claim(s), ${opts.repeats} timed read(s)`);
  console.log(`data dir: ${dir} (temporary, removed unless --keep)`);

  const seedMemory = await timedAsync(async () => writeMemoryFixture(dir, opts.memory));
  const seedKnowledge = await timedAsync(() => writeKnowledgeFixture(dir, opts.claims));
  const files = fileState(dir);
  console.log(`fixture files: memory.jsonl ${files['memory.jsonl'].bytes} bytes, knowledge.jsonl ${files['knowledge.jsonl'].bytes} bytes`);
  console.log(`fixture write: memory ${seedMemory.ms.toFixed(1)} ms, knowledge ${seedKnowledge.ms.toFixed(1)} ms (reported separately from read cost)`);

  const app = createApp({ dataDir: dir });
  const beforeReads = fileState(dir);
  const rssBefore = process.memoryUsage().rss;

  const health = await timedAsync(() => Promise.all([app.memory.health(), app.knowledge.health()]));
  const builds = [];
  let rendered = null;
  for (let i = 0; i < opts.repeats; i += 1) {
    const run = await timedAsync(() => buildWorldState({ memory: app.memory, knowledge: app.knowledge, now: () => new Date() }));
    builds.push(run.ms);
    rendered = run.result;
  }
  const render = timed(() => renderWorldState(rendered));
  const action = worldActions()[0];
  const actionRuns = [];
  for (let i = 0; i < Math.min(3, opts.repeats); i += 1) {
    const run = await timedAsync(async () => {
      const result = await action.execute({ memory: app.memory, knowledge: app.knowledge, now: () => new Date() }, { limit: undefined });
      const verification = await action.verify({ memory: app.memory, knowledge: app.knowledge, now: () => new Date() }, { limit: undefined }, result);
      return verification;
    });
    actionRuns.push(run.ms);
  }
  const rssAfter = process.memoryUsage().rss;

  const buildStats = stats(builds);
  const actionStats = stats(actionRuns);
  const line = (label, value) => console.log(`  ${label.padEnd(28)} ${value}`);
  console.log('read cost (no model, no inference, nothing downloaded):');
  line('store health scan', `${health.ms.toFixed(1)} ms`);
  line('projection build, first', `${builds[0].toFixed(1)} ms`);
  line('projection build min/median/max', `${buildStats.min.toFixed(1)} / ${buildStats.median.toFixed(1)} / ${buildStats.max.toFixed(1)} ms`);
  line('render (display only)', `${render.ms.toFixed(1)} ms`);
  line(`execute+verify x${actionRuns.length} min/median/max`, `${actionStats.min.toFixed(1)} / ${actionStats.median.toFixed(1)} / ${actionStats.max.toFixed(1)} ms`);
  line('display length', `${render.result.length} chars`);
  console.log('what the projection read:');
  line('represented beliefs', `${rendered.counts.representedBeliefs} of ${opts.memory + opts.claims} stored records`);
  line('beliefs shown', `${rendered.beliefs.shown}`);
  line('memory conflict groups', `${rendered.counts.memoryConflictGroups}`);
  line('largest memory group', `${rendered.contradictions.filter((g) => g.kind === 'memory').reduce((max, g) => Math.max(max, g.claimIds.length), 0)} record(s)`);
  line('complete / attention', `${rendered.complete} / ${rendered.attention}`);
  console.log('process footprint during the run:');
  line('rss before / after', `${(rssBefore / 1024 / 1024).toFixed(1)} MiB / ${(rssAfter / 1024 / 1024).toFixed(1)} MiB`);
  line('heap used after', `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MiB`);

  const afterReads = fileState(dir);
  const unchanged = JSON.stringify(beforeReads) === JSON.stringify(afterReads);
  console.log(`writes during ${opts.repeats} reads: ${unchanged ? 'none (every store file is byte-identical)' : 'CHANGED - this benchmark expected no writes'}`);
  console.log(`runtime: node ${process.version}, ${os.platform()} ${os.arch()}, ${os.cpus().length} logical cpus, ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GiB reported memory`);
  console.log('limits: one machine, one warm page cache, a temporary local directory, no concurrent writer, no model. These are observations at the stated fixture sizes, not a scaling guarantee.');

  if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
  else console.log(`kept: ${dir}`);
}

main().catch((err) => {
  console.error(`bench failed: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
