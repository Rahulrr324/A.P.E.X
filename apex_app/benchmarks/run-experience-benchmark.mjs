// Bounded, model-free benchmark for the experience, feedback and adaptation stores (Batch Z).
//
// It measures APEX's own paths against synthetic fixtures in fresh temporary data directories.
// No inference is run or simulated: every application is built with NoBackend, so the request path
// stops at `model_unavailable` and what is timed is APEX's own work. This is not part of `npm test`
// and no test depends on it.
//
//   node benchmarks/run-experience-benchmark.mjs [--experiences N] [--repeats R] [--phase P] [--keep]
//
// Phases, run in order unless one is selected:
//   reads     what a read costs at progressive store sizes, split into reading and parsing the
//            bytes and recomputing the derived lifecycle from them. The recomputation is what this
//            store pays on every read, deliberately: it is why a corrected experience cannot leave
//            a stale rule in effect. Both parts are measured on one fixture in one process.
//   writes    one append in parts: the audited event an experience must name, the store append
//            inside the write lock, the end-to-end controller call (audit record plus independent
//            re-check), then a feedback record, an approval, and a retirement.
//   context   the characters the approved-adaptation section adds to a prompt, the bounded
//            retrieval window, and whether a deterministic request reads the store at all.
//   compare   the same raw append, the same store-level append, the same full read and the same
//            read-plus-derived-state call on the memory and knowledge stores at matched record
//            counts, so the difference between these stores is measured rather than asserted.
//
// Fixtures are seeded through the real paths - one verified, audited request per experience - and
// the seeding cost is reported separately from the measured cost. Every write sample runs against
// a fresh copy of its fixture, so each repeat measures the same bytes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { OperationLog } from '../src/operations/operation-log.js';
import { Outcome } from '../src/outcomes.js';
import {
  ExperienceStore,
  summarizeExperienceHealth,
  validateExperienceRecord,
  DEFAULT_ACTIVE_ADAPTATIONS,
  MAX_ACTIVE_ADAPTATIONS,
} from '../src/experience/experience-store.js';
import { buildPrompt, adaptationLine, MAX_CONTEXT_CHARS } from '../src/controller/context.js';
import { MemoryStore, validateMemoryRecord } from '../src/memory/memory-store.js';
import { KnowledgeStore, validateKnowledgeRecord } from '../src/knowledge/knowledge-store.js';
import { JsonlStore } from '../src/memory/jsonl-store.js';

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const CLOCK = () => new Date('2026-11-01T10:00:00.000Z');
const GUIDANCE = [
  'answer in one line',
  'never store a private code',
  'give the date, not a reminder',
  'say which file you checked',
];
const QUERY = 'what did I ask you to hold about the review';
// The first 16 experiences of every fixture carry guidance: four candidate groups of four
// supporting experiences each. One adaptation may cite at most 20 evidence records, and a group
// larger than that is skipped rather than truncated, so a single preference restated across a
// 400-experience store would leave the store with no rules in it and nothing to measure. The
// remaining experiences still carry corrective feedback, but feedback that does not state what to
// change cannot support a rule - that exclusion is part of what the derivation does.
const GUIDED_EXPERIENCES = 16;
const MAX_EXPERIENCES = 2000;
const MAX_REPEATS = 25;
const DEFAULT_SIZES = [20, 100, 400];

function bounded(raw, min, max, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

function parseArgs(argv) {
  const opts = { sizes: DEFAULT_SIZES, repeats: 5, keep: false, phase: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--experiences') { opts.sizes = [bounded(argv[i + 1], 4, MAX_EXPERIENCES, '--experiences')]; i += 1; }
    else if (arg === '--repeats') { opts.repeats = bounded(argv[i + 1], 1, MAX_REPEATS, '--repeats'); i += 1; }
    else if (arg === '--phase') {
      const name = String(argv[i + 1] ?? '');
      if (!['reads', 'writes', 'context', 'compare'].includes(name)) throw new Error(`unknown phase ${name}`);
      opts.phase = name;
      i += 1;
    } else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

const dirs = [];
function tempDir(prefix = 'apex-bench-experience-') {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, prefix));
  dirs.push(dir);
  return dir;
}

function removeDir(dir) {
  const real = fs.realpathSync(dir);
  if (!real.startsWith(TMP_ROOT) || !path.basename(real).startsWith('apex-bench-')) {
    throw new Error(`refusing to remove non-benchmark directory: ${real}`);
  }
  fs.rmSync(real, { recursive: true, force: true });
}

async function copyDir(from) {
  const to = tempDir('apex-bench-copy-');
  await fsp.mkdir(to, { recursive: true });
  for (const name of await fsp.readdir(from)) {
    if (name.endsWith('.lock') || name.includes('.takeover.') || name.endsWith('.recover') || name.endsWith('.tmp')) continue;
    await fsp.copyFile(path.join(from, name), path.join(to, name));
  }
  return to;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    n: sorted.length,
  };
}

const ms = (value) => `${value.toFixed(2)} ms`;

async function timed(fn) {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
}

function timedSync(fn) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function app(dir) {
  return createApp({ dataDir: dir, gateway: new ModelGateway({ backend: new NoBackend() }), now: CLOCK });
}

function storeOn(dir) {
  return new ExperienceStore(path.join(dir, 'experiences.jsonl'), {
    operations: new OperationLog(path.join(dir, 'operations.jsonl')),
    now: CLOCK,
  });
}

// One audited event, produced the way the application produces one: a verified request through the
// controller. The benchmark measures appends against records that exist for real, not against
// hand-written fixtures the store's own verification would refuse.
async function auditedEvent(target, label) {
  const res = await target.controller.handle(`remember that ${label} is held`, { origin: 'user' });
  if (res.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`seeding failed: ${res.status} ${res.output ?? res.display ?? ''}`);
  return res.operation.id;
}

// Fixture: `experiences` audited events, each with one experience and one corrective feedback
// record, then one derivation. The first GUIDED_EXPERIENCES feedback records state the guidance the
// user asked for; the rest assess the result without restating a rule. Three of the four candidate
// groups are approved so retrieval has a realistic window; the fourth stays a candidate so the
// approval write is measured against a record that is genuinely undecided.
async function buildFixture(experiences) {
  const dir = tempDir();
  const target = app(dir);
  const seeded = await timed(async () => {
    const experienceIds = [];
    for (let i = 0; i < experiences; i += 1) {
      const operationId = await auditedEvent(target, `benchmark note ${i}`);
      const rec = await target.experience.recordExperience({
        operationId,
        subject: `experienced benchmark note ${i}`,
        origin: 'user',
      });
      experienceIds.push(rec.record.id);
      await target.experience.recordFeedback({
        target: rec.record.id,
        assessment: 'not_useful',
        guidance: i < GUIDED_EXPERIENCES ? GUIDANCE[i % GUIDANCE.length] : null,
        reason: i < GUIDED_EXPERIENCES ? null : `benchmark note ${i} did not help`,
        origin: 'user',
      });
    }
    const derived = await target.experience.deriveAdaptations({ origin: 'user' });
    const approvedIds = [];
    for (const created of derived.created.slice(0, 3)) {
      await target.experience.decideAdaptation({
        target: created.id, decision: 'approved', reason: 'benchmark approval', origin: 'user',
      });
      approvedIds.push(created.id);
    }
    return {
      experienceIds,
      approvedIds,
      pendingId: derived.created[3]?.id ?? null,
      candidateCount: derived.created.length,
      skippedCount: derived.skipped.length,
    };
  });
  const status = await storeOn(dir).status();
  return {
    dir,
    target,
    experiences,
    bytes: fs.statSync(path.join(dir, 'experiences.jsonl')).size,
    seedMs: seeded.ms,
    status,
    ...seeded.result,
  };
}

function header(cells) {
  console.log(`  ${cells.map(([label, width]) => label.padStart(width)).join('')}`);
}

function row(cells) {
  console.log(`  ${cells.map(([value, width]) => String(value).padStart(width)).join('')}`);
}

async function phaseReads(opts, fixtures) {
  console.log('\n== reads: one read, split into what it costs ==');
  header([
    ['store', 20], ['records', 9], ['bytes', 9], ['cold', 11], ['warm', 11],
    ['load only', 11], ['recompute', 12], ['list', 9], ['retrieval', 12], ['derive scan', 13], ['health', 10], ['evidence', 11],
  ]);
  for (const fixture of fixtures) {
    const samples = {
      cold: [], warm: [], load: [], recompute: [], list: [], retrieval: [], scan: [], health: [], evidence: [],
    };
    for (let i = 0; i < opts.repeats; i += 1) {
      const store = storeOn(fixture.dir);
      samples.cold.push((await timed(() => store.status())).ms);
      samples.warm.push((await timed(() => store.status())).ms);
      // The same records, measured twice in the same process: reading, hashing, parsing and
      // validating them, then deriving the lifecycle from them. `recompute` is its own measurement
      // on those records, not a subtraction across runs.
      const loaded = await timed(() => store.log.load());
      samples.load.push(loaded.ms);
      samples.recompute.push(timedSync(() => summarizeExperienceHealth(loaded.result.records)));
      samples.list.push((await timed(() => store.list({ limit: 20 }))).ms);
      samples.retrieval.push((await timed(() => store.activeAdaptations({ query: QUERY }))).ms);
      samples.scan.push((await timed(() => store.deriveAdaptations({ origin: 'user' }))).ms);
      samples.health.push((await timed(() => store.health())).ms);
      samples.evidence.push((await timed(() => store.evidenceCheck(fixture.experienceIds[0]))).ms);
    }
    row([
      [`${fixture.experiences} experiences`, 20], [fixture.status.records, 9], [fixture.bytes, 9],
      [ms(stats(samples.cold).median), 11], [ms(stats(samples.warm).median), 11],
      [ms(stats(samples.load).median), 11], [ms(stats(samples.recompute).median), 12],
      [ms(stats(samples.list).median), 9], [ms(stats(samples.retrieval).median), 12],
      [ms(stats(samples.scan).median), 13], [ms(stats(samples.health).median), 10],
      [ms(stats(samples.evidence).median), 11],
    ]);
  }
}

async function phaseWrites(opts, fixtures) {
  console.log('\n== writes: one append, in parts (each sample runs on a fresh copy of its fixture) ==');
  header([
    ['store', 20], ['audited event', 14], ['store append', 14], ['end to end', 12],
    ['feedback', 11], ['approve', 10], ['retire', 10], ['re-check', 11],
  ]);
  for (const fixture of fixtures) {
    const samples = { event: [], append: [], endToEnd: [], feedback: [], approve: [], retire: [], recheck: [] };
    for (let i = 0; i < opts.repeats; i += 1) {
      const work = await copyDir(fixture.dir);
      const target = app(work);
      const event = await timed(() => auditedEvent(target, `written note ${i}`));
      samples.event.push(event.ms);
      samples.append.push((await timed(() => target.experience.recordExperience({
        operationId: event.result, subject: 'a written note', origin: 'user',
      }))).ms);
      const second = await timed(() => auditedEvent(target, `another note ${i}`));
      samples.endToEnd.push((await timed(() => target.controller.experienceRecord({
        operationId: second.result, subject: 'a written note',
      }))).ms);
      samples.feedback.push((await timed(() => target.controller.feedbackRecord({
        target: fixture.experienceIds[0], assessment: 'user_correction', guidance: GUIDANCE[0],
      }))).ms);
      if (fixture.pendingId) {
        samples.approve.push((await timed(() => target.controller.adaptationDecide({
          target: fixture.pendingId, decision: 'approved', reason: 'benchmark',
        }))).ms);
      }
      samples.retire.push((await timed(() => target.controller.adaptationRetire({
        target: fixture.approvedIds[0], reason: 'benchmark',
      }))).ms);
      samples.recheck.push((await timed(() => target.experience.evidenceCheck(fixture.experienceIds[0]))).ms);
    }
    const cell = (key) => (samples[key].length ? ms(stats(samples[key]).median) : 'n/a');
    row([
      [`${fixture.experiences} experiences`, 20], [cell('event'), 14], [cell('append'), 14],
      [cell('endToEnd'), 12], [cell('feedback'), 11], [cell('approve'), 10],
      [cell('retire'), 10], [cell('recheck'), 11],
    ]);
  }
}

async function phaseContext(opts, fixtures) {
  const fixture = fixtures[fixtures.length - 1];
  const store = storeOn(fixture.dir);
  const adaptations = await store.adaptations({ limit: 20 });
  const active = adaptations.filter((a) => a.active);
  console.log('\n== context: what the approved rules add, and what a request pays for them ==');
  console.log(`  fixture: ${fixture.experiences} experiences, ${active.length} rule(s) in effect of ${adaptations.length} derived`);

  const base = buildPrompt({ request: QUERY, memoryHits: [], turns: [], adaptations: [] });
  const lines = [];
  for (let count = 1; count <= active.length; count += 1) {
    const picked = active.slice(0, count);
    const built = buildPrompt({ request: QUERY, memoryHits: [], turns: [], adaptations: picked });
    lines.push([`${count} approved adaptation(s) in the prompt`, `+${built.prompt.length - base.prompt.length} characters`]);
  }
  const withOmission = buildPrompt({ request: QUERY, memoryHits: [], turns: [], adaptations: active, adaptationsOmitted: 5 });
  lines.push([`the same list plus the note that 5 more were cut`, `+${withOmission.prompt.length - base.prompt.length} characters`]);
  const unavailable = buildPrompt({ request: QUERY, memoryHits: [], turns: [], adaptations: [], adaptationsUnavailable: true });
  lines.push(['an unreadable store, stated as unreadable', `+${unavailable.prompt.length - base.prompt.length} characters`]);
  lines.push(['longest single rule line', active.length
    ? `${Math.max(...active.map((a) => adaptationLine(a).length))} characters`
    : 'no rule in effect to measure']);
  lines.push(['retrieval bound', `default window ${DEFAULT_ACTIVE_ADAPTATIONS}, hard maximum ${MAX_ACTIVE_ADAPTATIONS}`]);
  const retrieval = await store.activeAdaptations({ query: QUERY, limit: MAX_ACTIVE_ADAPTATIONS });
  lines.push(['in scope for this request', `${retrieval.total} active, ${retrieval.adaptations.length} returned, truncated: ${retrieval.truncated}`]);
  const fullPrompt = buildPrompt({ request: QUERY, memoryHits: [], turns: [], adaptations: active });
  lines.push(['prompt size', `${base.prompt.length} characters with no rule, ${fullPrompt.prompt.length} with ${active.length}, against the ${MAX_CONTEXT_CHARS}-character budget`]);
  for (const [name, value] of lines) console.log(`  ${name.padEnd(52)} ${value}`);

  // A deterministic request must not pay for behaviour rules it cannot use. The counter observes
  // only: it calls through to the real method and returns exactly what the store returned.
  const counts = { calc: 0, ask: 0 };
  let current = 'calc';
  const target = app(fixture.dir);
  const original = target.experience.activeAdaptations.bind(target.experience);
  target.experience.activeAdaptations = async (options) => {
    counts[current] += 1;
    return original(options);
  };
  const calcTimed = [];
  const calcReads = [];
  for (let i = 0; i < opts.repeats; i += 1) {
    current = 'calc';
    counts.calc = 0;
    calcTimed.push((await timed(() => target.controller.handle('calc 2+2', { origin: 'user' }))).ms);
    calcReads.push(counts.calc);
  }
  const askTimed = [];
  const askReads = [];
  for (let i = 0; i < opts.repeats; i += 1) {
    current = 'ask';
    counts.ask = 0;
    askTimed.push((await timed(() => target.controller.handle(QUERY, { origin: 'user' }))).ms);
    askReads.push(counts.ask);
  }
  const emptyDir = tempDir('apex-bench-empty-');
  const bare = app(emptyDir);
  const bareCalc = [];
  const bareAsk = [];
  for (let i = 0; i < opts.repeats; i += 1) {
    bareCalc.push((await timed(() => bare.controller.handle('calc 2+2', { origin: 'user' }))).ms);
    bareAsk.push((await timed(() => bare.controller.handle(QUERY, { origin: 'user' }))).ms);
  }
  const reads = (list) => `${list[0]} experience read(s) per request${list.every((n) => n === list[0]) ? '' : ` (varied: ${list.join(', ')})`}`;
  console.log('  request path (medians; no model is configured, so the model path stops at model_unavailable):');
  console.log(`    ${'calc 2+2 with the populated store'.padEnd(46)} ${ms(stats(calcTimed).median)}   ${reads(calcReads)}`);
  console.log(`    ${'calc 2+2 with no experience records'.padEnd(46)} ${ms(stats(bareCalc).median)}`);
  console.log(`    ${'free-form ask with the populated store'.padEnd(46)} ${ms(stats(askTimed).median)}   ${reads(askReads)}`);
  console.log(`    ${'free-form ask with no experience records'.padEnd(46)} ${ms(stats(bareAsk).median)}`);
}

// The raw-append probe re-appends the last line of the store's own file, read back verbatim, so
// each store is measured appending bytes it already accepts rather than a shape the benchmark made
// up. It runs against a throwaway copy because the appended line duplicates an existing id.
async function rawAppendSample(spec) {
  const scratch = tempDir('apex-bench-raw-');
  const copy = path.join(scratch, path.basename(spec.path));
  await fsp.copyFile(spec.path, copy);
  const probe = JSON.parse(fs.readFileSync(copy, 'utf8').trim().split(/\r?\n/).at(-1));
  return (await timed(() => new JsonlStore(copy, { validateRecord: spec.validate }).append(probe))).ms;
}

async function phaseCompare(opts, fixtures) {
  console.log('\n== compare: the same operations on the memory, knowledge and experience stores ==');
  console.log('  matched record counts, one fresh store instance per sample:');
  console.log('    raw append  = append one already-valid record through the shared JSONL layer');
  console.log('    store write = the store\'s own write path (validation, coordination, derived state)');
  console.log('    full read   = read, hash, parse and validate the whole file');
  console.log('    read+derive = that read plus the derived state the store computes for a caller');
  header([['store', 20], ['records', 9], ['bytes', 9], ['raw append', 12], ['store write', 13], ['full read', 11], ['read+derive', 13]]);
  for (const fixture of fixtures) {
    const count = fixture.status.records;
    const dir = tempDir('apex-bench-compare-');
    const memoryPath = path.join(dir, 'memory.jsonl');
    const knowledgePath = path.join(dir, 'knowledge.jsonl');
    for (let i = 0; i < count; i += 1) {
      await new MemoryStore(memoryPath, { now: CLOCK }).add({
        content: `benchmark memory ${i} of the comparison fixture`, source: 'user', provenance: { origin: 'user_request' },
      });
      await new KnowledgeStore(knowledgePath, { now: CLOCK }).add({
        subject: 'the benchmark', relationship: 'notes', object: `comparison claim ${i}`, origin: 'user',
      });
    }
    const specs = [
      { kind: 'memory', path: memoryPath, Store: MemoryStore, validate: validateMemoryRecord },
      { kind: 'knowledge', path: knowledgePath, Store: KnowledgeStore, validate: validateKnowledgeRecord },
      {
        kind: 'experience',
        path: path.join(fixture.dir, 'experiences.jsonl'),
        Store: { call: (target) => storeOn(target) },
        validate: validateExperienceRecord,
      },
    ];
    const prepared = {
      memory: fs.statSync(memoryPath).size,
      knowledge: fs.statSync(knowledgePath).size,
      experience: fs.statSync(specs[2].path).size,
    };
    const samples = {
      experience: { raw: [], write: [], read: [], derive: [] },
      memory: { raw: [], write: [], read: [], derive: [] },
      knowledge: { raw: [], write: [], read: [], derive: [] },
    };
    for (let i = 0; i < opts.repeats; i += 1) {
      for (const spec of specs) {
        samples[spec.kind].raw.push(await rawAppendSample(spec));
        const open = () => (spec.kind === 'experience'
          ? spec.Store.call(path.dirname(spec.path))
          : new spec.Store(spec.path, { now: CLOCK }));
        samples[spec.kind].read.push((await timed(() => open().log.load())).ms);
        samples[spec.kind].derive.push((await timed(() => (spec.kind === 'experience'
          ? open().status()
          : open().list({ limit: 20 })))).ms);
        if (spec.kind === 'memory') {
          samples.memory.write.push((await timed(() => open().add({
            content: `written through the store ${i}`, source: 'user', provenance: { origin: 'user_request' },
          }))).ms);
        } else if (spec.kind === 'knowledge') {
          samples.knowledge.write.push((await timed(() => open().add({
            subject: 'the benchmark', relationship: 'notes', object: `written claim ${i}`, origin: 'user',
          }))).ms);
        } else {
          // The experience write path needs an audited event to name, so its sample runs on a copy
          // with one produced through the controller. That audited event is the same cost the
          // writes phase reports separately; here it is preparation, not measurement.
          const work = await copyDir(fixture.dir);
          const event = await timed(() => auditedEvent(app(work), `comparison event ${i}`));
          samples.experience.write.push((await timed(() => storeOn(work).recordExperience({
            operationId: event.result, subject: 'a comparison experience', origin: 'user',
          }))).ms);
        }
      }
    }
    for (const spec of specs) {
      row([
        [`${fixture.experiences} exp / ${spec.kind}`, 20],
        [count, 9],
        [prepared[spec.kind], 9],
        [ms(stats(samples[spec.kind].raw).median), 12],
        [ms(stats(samples[spec.kind].write).median), 13],
        [ms(stats(samples[spec.kind].read).median), 11],
        [ms(stats(samples[spec.kind].derive).median), 13],
      ]);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node benchmarks/run-experience-benchmark.mjs [--experiences N] [--repeats R] [--phase reads|writes|context|compare] [--keep]');
    return;
  }
  console.log('experience benchmark: model-free, temporary data directories, no inference requested at any point.');
  console.log(`node ${process.version} on ${process.platform}; sizes ${opts.sizes.join(', ')} experiences; ${opts.repeats} repeat(s) per measurement.`);
  try {
    const fixtures = [];
    for (const experiences of opts.sizes) {
      const fixture = await buildFixture(experiences);
      console.log(`\nfixture ${experiences} experiences: ${fixture.status.records} record(s), ${fixture.bytes} bytes, seeded in ${ms(fixture.seedMs)}`
        + ` (experiences ${fixture.status.experiences}, feedback ${fixture.status.feedback}, adaptations ${fixture.status.adaptations},`
        + ` in effect ${fixture.status.activeAdaptations}, ${fixture.candidateCount} candidate group(s) derived,`
        + ` ${fixture.skippedCount} group(s) left as evidence without a candidate)`);
      fixtures.push(fixture);
    }
    const phases = opts.phase ? [opts.phase] : ['reads', 'writes', 'context', 'compare'];
    for (const name of phases) {
      if (name === 'reads') await phaseReads(opts, fixtures);
      if (name === 'writes') await phaseWrites(opts, fixtures);
      if (name === 'context') await phaseContext(opts, fixtures);
      if (name === 'compare') await phaseCompare(opts, fixtures);
    }
  } finally {
    if (opts.keep) console.log(`\nkept ${dirs.length} temporary directory/directories under ${TMP_ROOT}`);
    else for (const dir of dirs.splice(0)) removeDir(dir);
  }
}

main().catch((err) => {
  console.error(`benchmark failed: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
