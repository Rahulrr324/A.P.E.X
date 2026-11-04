// Bounded, model-free benchmark for the executive bridge (Batch AK): the request path
// User request -> understanding -> proposal -> validation -> authorization -> execution ->
// verification -> audit -> outcome.
//
// No inference is run or simulated. Every application is built with `NoBackend`, so a request that
// needed a model stops at `model_unavailable` and what is measured is APEX's own work. Nothing here
// contacts a network, starts a service, or downloads anything. This is not part of `npm test` and no
// test depends on it.
//
//   node benchmarks/run-executive-bridge-benchmark.mjs [--repeats R] [--rows 1,10,50,150] [--phase all|preview|authorization|run|status|recovery|finalize] [--keep]
//
// Phases, and the cost centre each one answers for:
//   preview        request-to-preview: the bridge whole, then its parts - intent mapping, plan
//                  synthesis, the live plan-validity read, the view build, the approval binding hash.
//   authorization  the approval write, the approval answer (which reads the record back and prints
//                  the binding), a clarification refusal, and a draft that cannot be started.
//   run            multi-step orchestration through the existing TaskRunner: a 1-step plan and the
//                  recorded maximum-size 8-step plan, on the same fixture bytes.
//   status         the status view and the record reads behind it, plus the two reads the bridge
//                  performs when it declines an approval question in favour of the task log.
//   recovery       the read-only recovery sweep, and the reconcile that records a failed run's
//                  outcomes against the plan.
//   finalize       one verified write at five depths: the store append alone, the authorized action
//                  step, then the whole request with capture off, with capture armed, and with capture
//                  off again. All three request columns are the same words on copies of the same
//                  bytes, so the armed figure is compared with two same-condition figures.
//
// Alongside the milliseconds each phase prints the records its call appended, per log. A timing
// figure says how long a request took; those lines say what it did, which is the part a latency
// number cannot show and the part an optimization would have to change.
//
// The growth axis is historical executive work: each row holds that many completed goal/plan/task
// bundles plus their operation audit records and the memory writes those steps made. A bundle is
// produced by really running prepare -> approve -> start in a throwaway directory and collecting the
// exact lines that run wrote, so every fixture record is one a real request produced. Seeding cost is
// reported separately from every measurement.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF, CAPTURE_VERIFIED_SUCCESS } from '../src/experience/capture.js';
import { executiveSignal, synthesizePlan } from '../src/executive/mapping.js';
import { buildPreview } from '../src/executive/preview.js';
import { planContentHash, MAX_PLAN_STEPS } from '../src/plans/model.js';
import { Outcome } from '../src/outcomes.js';

const DIR_PREFIX = 'apex-bench-akx-';
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const CLOCK = () => new Date('2026-11-04T09:00:00.000Z');
const PREPARE = 'prepare a plan to remember that the AK benchmark fact holds';
const STATUS_QUESTION = 'what is the status of my goal and plan progress?';
const APPROVAL_QUESTION = 'what needs approving?';
const MAX_ROWS = 400;
const MAX_REPEATS = 25;
const DEFAULT_ROWS = [1, 10, 50, 150];
// The record logs a bundle is made of. `conversation.jsonl` and `session.json` are deliberately not
// part of a bundle: the conversation belongs to one session, and the rows below measure a fresh
// process per sample, which is how the CLI actually runs.
const BUNDLE_FILES = ['goals.jsonl', 'plans.jsonl', 'tasks.jsonl', 'operations.jsonl', 'memory.jsonl'];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, DIR_PREFIX));
  dirs.push(dir);
  return dir;
}

const dirs = [];

function removeDir(dir) {
  const real = fs.realpathSync(dir);
  if (!real.startsWith(TMP_ROOT) || !path.basename(real).startsWith(DIR_PREFIX)) {
    throw new Error(`refusing to remove non-benchmark directory: ${real}`);
  }
  fs.rmSync(real, { recursive: true, force: true });
}

function parseArgs(argv) {
  const opts = { repeats: 3, keep: false, phase: 'all', rows: DEFAULT_ROWS, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--repeats') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > MAX_REPEATS) throw new Error(`--repeats must be 1..${MAX_REPEATS}`);
      opts.repeats = value;
      i += 1;
    } else if (arg === '--rows') {
      const values = String(argv[i + 1]).split(',').map((v) => Number(v.trim()));
      if (values.length === 0 || values.some((v) => !Number.isInteger(v) || v < 0 || v > MAX_ROWS)) {
        throw new Error(`--rows must be comma-separated integers, each 0..${MAX_ROWS}`);
      }
      opts.rows = values.sort((a, b) => a - b);
      i += 1;
    } else if (arg === '--phase') {
      const name = argv[i + 1];
      if (!['preview', 'authorization', 'run', 'status', 'recovery', 'finalize', 'all'].includes(name)) {
        throw new Error(`unknown phase ${name}`);
      }
      opts.phase = name;
      i += 1;
    } else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return { n: sorted.length, median: sorted[mid], min: sorted[0], max: sorted[sorted.length - 1] };
}

function ms(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return value.toFixed(2);
}

function bytes(n) {
  return n.toLocaleString('en-US');
}

const timed = async (fn) => {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
};

const timedSync = (fn) => {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
};

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.length > 0);
}

function makeApp(dataDir, experienceCapture = CAPTURE_OFF, extraActions = []) {
  return createApp({
    dataDir,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    experienceCapture,
    now: CLOCK,
    extraActions,
  });
}

// TEST DOUBLE: one read action that fails during execution. It exists so the recovery and reconcile
// rows have a real failed step to read, because a failure cannot be measured by asking a working
// action to pretend. Nothing destructive is registered anywhere in this file.
const failingAction = {
  name: 'bench.fail',
  description: 'benchmark-only read action that always fails to execute',
  inputHint: '{"tag":"text"}',
  permission: 'read',
  origins: ['user', 'model'],
  validate: (input) => ({ tag: String(input?.tag ?? 'x') }),
  async execute() { throw new Error('the benchmark sensor did not answer'); },
  verify: null,
};

function planStep(id, tag) {
  return {
    id,
    description: `remember the benchmark fact ${tag}`,
    action: 'memory.add',
    input: { content: `the AK benchmark step fact ${tag}` },
    dependsOn: [],
    expectedResult: `the ${tag} fact is stored`,
    verification: 'the stored record is read back and its content matches',
    // `memory.add` is a write action, and the plan model refuses a write step classified low risk, so
    // this is the shape that actually reaches approval and runs.
    risk: 'medium',
    estimateSeconds: 1,
  };
}

async function dataOf(res) {
  if (!res?.operation?.steps?.[0]?.result?.data) {
    throw new Error(`the benchmark fixture request did not produce data: ${res?.status} ${res?.output ?? ''}`);
  }
  return res.operation.steps[0].result.data;
}

// ---- fixture bundles ---------------------------------------------------------
// One bundle is what one real executive cycle writes: a prepared plan, its approval, the task that
// ran it, one audit record per step, and the memory record the step produced.
async function buildBundle(index) {
  const dir = tempDir();
  const app = await makeApp(dir);
  const prep = await app.controller.handle(`prepare a plan to remember that the AK benchmark bundle ${index} fact holds`, { origin: 'user' });
  if (prep.status !== Outcome.PLAN_STORED) throw new Error(`fixture prepare failed at ${index}: ${prep.status} ${prep.output ?? ''}`);
  const planId = (await dataOf(prep)).planId;
  const short = planId.slice(0, 8);
  const approve = await app.controller.handle(`approve plan ${short}`, { origin: 'user' });
  if (approve.status !== Outcome.PLAN_STORED) throw new Error(`fixture approve failed at ${index}: ${approve.status}`);
  const start = await app.controller.handle(`start plan ${short}`, { origin: 'user' });
  if (start.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`fixture run failed at ${index}: ${start.status}`);
  const bundle = {};
  for (const name of BUNDLE_FILES) bundle[name] = readLines(path.join(dir, name));
  return bundle;
}

function writeFixture(dir, bundles, count) {
  const taken = bundles.slice(0, count);
  const sizes = {};
  for (const name of BUNDLE_FILES) {
    const lines = taken.flatMap((bundle) => bundle[name]);
    fs.writeFileSync(path.join(dir, name), lines.length > 0 ? `${lines.join('\n')}\n` : '');
    sizes[name] = fs.statSync(path.join(dir, name)).size;
  }
  return sizes;
}

function fixtureBytes(sizes) {
  return Object.values(sizes).reduce((a, b) => a + b, 0);
}

// The logs a measured request can write to. Counting the lines before and after a call says what that
// call recorded, which is what a timing figure on its own cannot show: a fast request that appends to
// five logs and a slow one that appends to one are different costs even when the milliseconds match.
const COUNTED_FILES = [...BUNDLE_FILES, 'experiences.jsonl', 'conversation.jsonl'];

function recordCounts(dir) {
  const out = {};
  for (const name of COUNTED_FILES) out[name] = readLines(path.join(dir, name)).length;
  return out;
}

function countsDelta(before, after) {
  const parts = [];
  for (const name of COUNTED_FILES) {
    const delta = after[name] - (before[name] ?? 0);
    if (delta !== 0) parts.push(`${name.replace('.jsonl', '')}+${delta}`);
  }
  return parts.length > 0 ? parts.join(' ') : 'no record written';
}

// Every column that writes measures its own copy of the row fixture. Two write columns sharing one
// instance would compare a cold store write with a warm one, and call the difference the thing under
// measurement.
function copyFixture(bundles, row) {
  const dir = tempDir();
  writeFixture(dir, bundles, row);
  return dir;
}

// ---- one sample --------------------------------------------------------------
// One sample writes the row fixture once and then builds a fresh application per phase, which is what
// one CLI command does: nothing here reuses a warmed instance across phases. Phases that only read
// share that fixture; the write columns in `finalize` each get their own copy, because a store's first
// write builds the incremental state a second write reuses. The printed record deltas show what each
// measured call actually appended.
async function sample(row, bundles, opts) {
  const t = {};
  const push = (name, value) => { (t[name] ??= []).push(value); };
  const dir = tempDir();
  const sizes = writeFixture(dir, bundles, row);
  const wanted = (phase) => opts.phase === 'all' || opts.phase === phase;

  if (wanted('preview')) {
    const app = await makeApp(dir);
    const before = recordCounts(dir);
    const prep = await timed(() => app.controller.handle(PREPARE, { origin: 'user' }));
    if (prep.value.status !== Outcome.PLAN_STORED) throw new Error(`preview prepare: ${prep.value.status}`);
    push('preview: records written', [countsDelta(before, recordCounts(dir))]);
    const planId = (await dataOf(prep.value)).planId;
    const short = planId.slice(0, 8);
    push('preview: request to preview', prep.ms);
    const plan = await app.plans.get(planId);
    const validity = await timed(() => app.controller.validateStoredPlan(short));
    push('preview: live plan validity read', validity.ms);
    push('preview: signal (pure)', timedSync(() => executiveSignal(PREPARE)).ms);
    push('preview: synthesis (pure)', timedSync(() => synthesizePlan({
      request: PREPARE, workText: 'remember that the AK benchmark fact holds', registry: app.registry, now: CLOCK(),
    })).ms);
    push('preview: view build (pure)', timedSync(() => buildPreview({ plan, registry: app.registry })).ms);
    push('preview: approval binding hash', timedSync(() => planContentHash(plan)).ms);
  }

  if (wanted('authorization')) {
    const app = await makeApp(dir);
    const draft = async () => {
      const res = await app.controller.handle(PREPARE, { origin: 'user' });
      return (await dataOf(res)).planId;
    };
    const one = await draft();
    const action = await timed(() => app.controller.planApprove({ target: one }));
    push('authorization: plan.approve', action.ms);
    if (action.value.status !== Outcome.PLAN_STORED) push('authorization: note', [`plan.approve returned ${action.value.status}`]);
    const two = await draft();
    const bridge = await timed(() => app.controller.handle(`approve plan ${two.slice(0, 8)}`, { origin: 'user' }));
    push('authorization: approve answer', bridge.ms);
    const clarify = await timed(() => app.controller.handle('approve plan', { origin: 'user' }));
    push('authorization: clarification', clarify.ms);
    if (clarify.value.status !== Outcome.CLARIFICATION_REQUIRED) push('authorization: note', [`clarification returned ${clarify.value.status}`]);
    const three = await draft();
    const refuse = await timed(() => app.controller.handle(`start plan ${three.slice(0, 8)}`, { origin: 'user' }));
    push('authorization: draft cannot start', refuse.ms);
    if (refuse.value.status !== Outcome.INPUT_REJECTED) push('authorization: note', [`a draft start returned ${refuse.value.status}`]);
  }

  if (wanted('run')) {
    for (const stepCount of [1, MAX_PLAN_STEPS]) {
      const app = await makeApp(dir);
      const steps = Array.from({ length: stepCount }, (_, i) => planStep(`s${i + 1}`, `r${row}-${stepCount}-${i}`));
      const add = await app.controller.planAdd({ outcome: `the ${stepCount} benchmark facts are stored`, steps, reason: 'benchmark orchestration row' });
      const planId = (await dataOf(add)).planId;
      const short = planId.slice(0, 8);
      const approved = await app.controller.planApprove({ target: short });
      if (approved.status !== Outcome.PLAN_STORED) push('run: note', [`${stepCount}-step approval returned ${approved.status}: ${approved.output ?? ''}`]);
      const before = recordCounts(dir);
      const run = await timed(() => app.controller.planActivate(short, { mode: 'run' }));
      push(`run: ${stepCount}-step plan`, run.ms);
      push(`run: ${stepCount}-step records`, [countsDelta(before, recordCounts(dir))]);
      if (stepCount > 1) push(`run: ${stepCount}-step per step`, run.ms / stepCount);
      const task = run.value.task;
      const done = (task?.steps ?? []).filter((s) => s.status === 'completed').length;
      push('run: note', [`steps after: ${done}/${stepCount} completed, outcome ${run.value.status}`]);
    }
  }

  if (wanted('status')) {
    const app = await makeApp(dir);
    const beforeView = recordCounts(dir);
    const view = await timed(() => app.controller.handle(STATUS_QUESTION, { origin: 'user' }));
    push('status: question answer', view.ms);
    push('status: status request records', [countsDelta(beforeView, recordCounts(dir))]);
    if (view.value.operation?.capability !== 'executive.status') push('status: note', [`capability was ${view.value.operation?.capability}`]);
    const read = await timed(() => app.controller.continuationReport({}));
    push('status: continuation record read', read.ms);
    const beforeRun = recordCounts(dir);
    push('status: record read wrote', [countsDelta(beforeRun, recordCounts(dir))]);
    push('status: records read', [`${read.value.goals?.length ?? 0} goal(s), ${read.value.plans?.length ?? 0} plan(s), ${read.value.tasks?.length ?? 0} task(s)`]);
    // The approval question is answered by the task log when one task is in view, so the bridge
    // performs exactly two extra reads before it declines: the bounded conversation read and that
    // task's own record. Both are timed here on the same fixture, because the decline is those reads.
    const decline = await timed(async () => {
      const sid = (await app.session.peek())?.sessionId ?? (await app.session.current())?.sessionId;
      const turns = await app.conversation.recent(sid, app.controller.contextTurns);
      const tasks = await app.taskStore.list();
      const one = tasks[0] ? await app.taskStore.get(tasks[0].id) : null;
      return { turns: turns.length, tasks: tasks.length, held: (one?.steps ?? []).filter((s) => s.status === 'awaiting_approval').length };
    });
    push('status: decline reads (turns + task)', decline.ms);
    const question = await timed(() => app.controller.handle(APPROVAL_QUESTION, { origin: 'user' }));
    push('status: approval question', question.ms);
  }

  if (wanted('recovery')) {
    const app = await makeApp(dir, CAPTURE_OFF, [failingAction]);
    const sweep = await timed(() => app.controller.recoveryReport());
    push('recovery: read-only sweep', sweep.ms);
    const steps = [planStep('s1', `rec-${row}`), {
      id: 's2', description: 'a step that fails', action: 'bench.fail', input: { tag: 'x' }, dependsOn: ['s1'],
      expectedResult: 'the double throws', verification: 'the double verifies its own report', risk: 'low', estimateSeconds: 1,
    }];
    const add = await app.controller.planAdd({ outcome: 'a benchmark plan whose second step fails', steps, reason: 'benchmark recovery row' });
    const planId = (await dataOf(add)).planId;
    const short = planId.slice(0, 8);
    await app.controller.planApprove({ target: short });
    const run = await app.controller.planActivate(short, { mode: 'run' });
    push('recovery: note', [`failed run outcome ${run.status}, steps ${JSON.stringify((run.task?.steps ?? []).map((s) => s.status))}`]);
    const after = await timed(() => app.controller.recoveryReport());
    push('recovery: sweep after a failed run', after.ms);
    const reconcile = await timed(() => app.controller.planReconcile(short));
    push('recovery: reconcile', reconcile.ms);
    push('recovery: reconcile outcome', [`${reconcile.value.status}`]);
  }

  if (wanted('finalize')) {
    const content = `the AK benchmark finalize fact for row ${row}`;
    const words = `remember that the AK benchmark request fact for row ${row} holds`;

    // One bare store append and one authorized action step, each on its own copy of the same bytes.
    // On one instance the first write builds the incremental state the second reuses, so the two
    // numbers would then differ by warmth rather than by the action layer.
    const storeDir = copyFixture(bundles, row);
    const storeApp = await makeApp(storeDir);
    const storeBefore = recordCounts(storeDir);
    const store = await timed(() => storeApp.memory.add({ content, kind: 'user_fact', source: 'user' }));
    push('finalize: store append', store.ms);
    push('finalize: store append records', [countsDelta(storeBefore, recordCounts(storeDir))]);

    const stepDir = copyFixture(bundles, row);
    const stepApp = await makeApp(stepDir);
    const stepBefore = recordCounts(stepDir);
    const action = await timed(() => stepApp.controller.runAction('memory.add', { content }, 'user', 'benchmark-operation'));
    push('finalize: authorized action step', action.ms);
    push('finalize: action step records', [`${action.value.outcome} ${countsDelta(stepBefore, recordCounts(stepDir))}`]);

    // A/B/A on the same words and the same bytes: capture off, capture armed, then capture off again.
    // The control says how much of the armed gap is the capture and how much is drift inside one run.
    const requestOf = async (capture) => {
      const where = copyFixture(bundles, row);
      const app = await makeApp(where, capture);
      const before = recordCounts(where);
      const res = await timed(() => app.controller.handle(words, { origin: 'user' }));
      return { ms: res.ms, value: res.value, records: countsDelta(before, recordCounts(where)) };
    };
    const off1 = await requestOf(CAPTURE_OFF);
    push('finalize: request, capture off', off1.ms);
    push('finalize: off request records', [off1.records]);
    const armed = await requestOf(CAPTURE_VERIFIED_SUCCESS);
    push('finalize: request, capture armed', armed.ms);
    push('finalize: armed request records', [armed.records]);
    const off2 = await requestOf(CAPTURE_OFF);
    push('finalize: request, capture off (control)', off2.ms);
    for (const [name, res] of [['off', off1], ['armed', armed], ['off control', off2]]) {
      if (res.value.status !== Outcome.SUCCESS_VERIFIED) push('finalize: note', [`${name} request returned ${res.value.status}`]);
    }
  }

  return { t, sizes };
}

function table(title, note, rows, columns) {
  console.log(`\n${title}`);
  const header = ['fixture (bundles, KiB)', ...columns.map((c) => c.label)];
  const widths = [30, ...columns.map((c) => Math.max(c.label.length, 14))];
  const line = (cells) => cells.map((cell, i) => String(cell).padStart(widths[i])).join(' | ');
  console.log(`  ${line(header)}`);
  console.log(`  ${line(header.map((_, i) => '-'.repeat(widths[i])))}`);
  for (const row of rows) {
    console.log(`  ${line([row.label, ...columns.map((c) => c.cell(row))] )}`);
  }
  if (note) console.log(`  ${note}`);
}

async function main(opts) {
  console.log(`node ${process.version} on ${process.platform} ${process.arch}, `
    + `${os.cpus().length} logical CPU(s), ${Math.round(os.totalmem() / 1073741824)} GiB reported memory; repeats ${opts.repeats}`);
  console.log('no model, no network, no inference: every application here is built with NoBackend, so a request');
  console.log('that needed a model stops at model_unavailable and only APEX\'s own work is timed.');
  console.log(`the plan step cap is ${MAX_PLAN_STEPS}, so the largest plan this file can measure has ${MAX_PLAN_STEPS} steps;`);
  console.log('the growth axis is therefore historical executive work, not plan length.');

  const seeding = performance.now();
  const largest = Math.max(...opts.rows);
  const bundles = [];
  for (let i = 1; i <= largest; i += 1) bundles.push(await buildBundle(i));
  const seedMs = performance.now() - seeding;
  const perBundle = bundles.reduce((a, b) => a + BUNDLE_FILES.reduce((x, n) => x + b[n].length, 0), 0) / (bundles.length || 1);
  console.log(`\nfixture: ${bundles.length} real executive bundles (prepare -> approve -> start), `
    + `about ${perBundle.toFixed(1)} record lines each, seeded in ${(seedMs / 1000).toFixed(1)} s.`);
  console.log('  seeding is reported apart from every measurement below; it costs whole-store reads and is not a');
  console.log('  claim about request latency.');

  const collected = opts.rows.map((row) => ({ row, samples: [] }));
  for (const entry of collected) {
    for (let i = 0; i < opts.repeats; i += 1) {
      entry.samples.push(await sample(entry.row, bundles, opts));
    }
  }

  const rows = collected.map((entry) => ({
    label: `${entry.row} / ${Math.round(fixtureBytes(entry.samples[0].sizes) / 1024)} KiB`,
    row: entry.row,
    samples: entry.samples,
  }));

  const column = (key, unit = 'ms') => ({
    label: key.split(': ').slice(1).join(': ') + ` (${unit})`,
    cell: (row) => {
      const values = row.samples.flatMap((s) => s.t[key] ?? []).filter((v) => typeof v === 'number');
      if (values.length === 0) return '-';
      const st = stats(values);
      return `${ms(st.median)} (${ms(st.min)}-${ms(st.max)})`;
    },
  });

  const medianOf = (row, key) => stats(row.samples.flatMap((s) => s.t[key] ?? []).filter((v) => typeof v === 'number')).median;

  // The record deltas are deterministic, so one line per distinct value with how many samples showed
  // it says the same thing as repeating it once per sample and is far easier to read.
  const notesFor = (keys) => (row) => {
    const counts = new Map();
    for (const key of keys) {
      for (const note of row.samples.flatMap((s) => s.t[key] ?? []).filter((v) => typeof v === 'string' || Array.isArray(v))) {
        const text = `${key}: ${Array.isArray(note) ? note.join(', ') : note}`;
        counts.set(text, (counts.get(text) ?? 0) + 1);
      }
    }
    return [...counts].map(([text, n]) => (n > 1 ? `${text} (in ${n} of ${row.samples.length} samples)` : text));
  };

  const wanted = (phase) => opts.phase === 'all' || opts.phase === phase;

  if (wanted('preview')) {
    table('preview: request-to-preview, and its parts',
      'The pure columns run no store read: they are the bridge\'s own computation on one plan.',
      rows,
      [column('preview: request to preview'), column('preview: live plan validity read'),
        column('preview: signal (pure)'), column('preview: synthesis (pure)'),
        column('preview: view build (pure)'), column('preview: approval binding hash')]);
    console.log('  The first column is the request end to end: the record reads it makes, the plan write, the read');
    console.log('  back, the view, and this request\'s own conversation and audit turns. The later columns are');
    console.log('  parts of it, so they do not add up to it and are not meant to. They run after it, on the same');
    console.log('  instance, so they measure a store whose read state is already built - they bound the bridge\'s');
    console.log('  own computation, and any part of them that is a store read is a warm one.');
    for (const row of rows) {
      const whole = medianOf(row, 'preview: request to preview');
      const pure = ['preview: signal (pure)', 'preview: synthesis (pure)', 'preview: view build (pure)',
        'preview: approval binding hash'].reduce((sum, key) => sum + medianOf(row, key), 0);
      if (Number.isNaN(whole) || Number.isNaN(pure)) continue;
      console.log(`  ${row.label}: the bridge's own computation is ${ms(pure)} ms of the ${ms(whole)} ms request (${((pure / whole) * 100).toFixed(1)}%).`);
    }
    for (const row of rows) for (const note of notesFor(['preview: records written'])(row)) console.log(`  ${row.label}: ${note}`);
  }
  if (wanted('authorization')) {
    table('authorization: the approval write, the approval answer, and two refusals',
      'plan.approve is the action layer; "approve answer" is the same approval plus the read-back view this request prints.',
      rows,
      [column('authorization: plan.approve'), column('authorization: approve answer'),
        column('authorization: clarification'), column('authorization: draft cannot start')]);
    for (const row of rows) for (const note of notesFor(['authorization: note'])(row)) console.log(`  ${row.label}: ${note}`);
  }
  if (wanted('run')) {
    table('run: multi-step orchestration through the existing TaskRunner',
      'Each step is one real memory.add: authorized, executed, verified, audited. "per step" is the plan total divided by its steps.',
      rows,
      [column('run: 1-step plan'), column(`run: ${MAX_PLAN_STEPS}-step plan`), column(`run: ${MAX_PLAN_STEPS}-step per step`)]);
    console.log('  The last line per row is the marginal cost of a step: the difference between the two plans divided');
    console.log(`  by the ${MAX_PLAN_STEPS - 1} steps the second plan has more of. Each additional step is one authorized,`);
    console.log('  executed, verified and audited write, so it pays a whole coordinated write plus the reads around it.');
    for (const row of rows) {
      const one = medianOf(row, 'run: 1-step plan');
      const many = medianOf(row, `run: ${MAX_PLAN_STEPS}-step plan`);
      if (Number.isNaN(one) || Number.isNaN(many) || one <= 0) continue;
      console.log(`  ${row.label}: ${MAX_PLAN_STEPS} steps cost ${(many / one).toFixed(2)}x the 1-step run; the extra ${ms(many - one)} ms over ${MAX_PLAN_STEPS - 1} steps is ${ms((many - one) / (MAX_PLAN_STEPS - 1))} ms per additional step.`);
    }
    for (const row of rows) {
      for (const note of notesFor(['run: note', 'run: 1-step records', `run: ${MAX_PLAN_STEPS}-step records`])(row)) console.log(`  ${row.label}: ${note}`);
    }
  }
  if (wanted('status')) {
    table('status: the status view, its record read, and the decline',
      'The decline column is the two reads the bridge performs before it defers an approval question to the task log.',
      rows,
      [column('status: question answer'), column('status: continuation record read'),
        column('status: decline reads (turns + task)'), column('status: approval question')]);
    console.log('  The status request is the bridge answering from the records; the two "wrote" lines below say what');
    console.log('  it and the bare record read appended, so a read-only request can be told from an executing one.');
    for (const row of rows) {
      for (const note of notesFor(['status: records read', 'status: status request records', 'status: record read wrote', 'status: note'])(row)) {
        console.log(`  ${row.label}: ${note}`);
      }
    }
  }
  if (wanted('recovery')) {
    table('recovery: the read-only sweep and the reconcile that records a failed run',
      'The failed run comes from a labelled benchmark double that throws; it is not evidence about a real action.',
      rows,
      [column('recovery: read-only sweep'), column('recovery: sweep after a failed run'), column('recovery: reconcile')]);
    for (const row of rows) {
      for (const note of notesFor(['recovery: note', 'recovery: reconcile outcome'])(row)) console.log(`  ${row.label}: ${note}`);
    }
  }
  if (wanted('finalize')) {
    table('finalize: one verified write, from a bare store append to a whole request',
      'Each single-write column runs on its own copy of the row fixture; see the lines below the table.',
      rows,
      [column('finalize: store append'), column('finalize: authorized action step'),
        column('finalize: request, capture off'), column('finalize: request, capture armed'),
        column('finalize: request, capture off (control)')]);
    console.log('  The two write columns are separated so that their difference is the action layer (authorize,');
    console.log('  validate, execute, verify) and not one warm store measured against one cold one. The three');
    console.log('  request columns are the same words on the same bytes, off then armed then off again, so the last');
    console.log('  column measures the drift of the run itself rather than the capture.');
    console.log('  capture overhead, same run and same fixture bytes:');
    for (const row of rows) {
      const off1 = medianOf(row, 'finalize: request, capture off');
      const armedMs = medianOf(row, 'finalize: request, capture armed');
      const off2 = medianOf(row, 'finalize: request, capture off (control)');
      if ([off1, armedMs, off2].some((v) => Number.isNaN(v))) continue;
      console.log(`    ${row.label}: armed minus off = ${ms(armedMs - off1)} ms; off control minus off = ${ms(off2 - off1)} ms (the drift this run adds to nothing); armed vs the second off = ${ms(armedMs - off2)} ms. Medians ${ms(off1)} / ${ms(armedMs)} / ${ms(off2)}. A negative figure is noise at this size.`);
    }
    for (const row of rows) {
      for (const note of notesFor(['finalize: store append records', 'finalize: action step records',
        'finalize: off request records', 'finalize: armed request records', 'finalize: note'])(row)) {
        console.log(`  ${row.label}: ${note}`);
      }
    }
  }

  const totals = rows.map((row) => `${row.label}: ${bytes(fixtureBytes(row.samples[0].sizes))} fixture bytes`);
  console.log('\nconditions and limits');
  console.log(`  rows: ${opts.rows.join(', ')} executive bundles; repeats: ${opts.repeats}. Every sample writes its`);
  console.log('  own fresh copy of the row fixture into its own temporary directory and builds a new application per');
  console.log('  phase, so no sample measures a store a previous sample enlarged.');
  for (const line of totals) console.log(`  ${line}`);
  if (rows.length > 1) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    console.log('  growth from the smallest row to the largest, medians in ms. The record count multiplies by more');
    console.log('  than the time does, so a ratio near 1 means a fixed cost dominates and these are the lines to');
    console.log('  watch if this path ever needs a derived index:');
    for (const key of ['preview: request to preview', 'preview: live plan validity read',
      'authorization: plan.approve', 'authorization: approve answer', `run: ${MAX_PLAN_STEPS}-step plan`,
      'status: question answer', 'status: continuation record read', 'recovery: read-only sweep',
      'recovery: reconcile', 'finalize: store append', 'finalize: authorized action step',
      'finalize: request, capture off', 'finalize: request, capture armed']) {
      const from = medianOf(first, key);
      const to = medianOf(last, key);
      if (Number.isNaN(from) || Number.isNaN(to) || from <= 0) continue;
      console.log(`    ${key}: ${ms(from)} -> ${ms(to)} ms (${(to / from).toFixed(2)}x) for ${first.row} -> ${last.row} bundles`);
    }
  }
  const mem = process.memoryUsage();
  console.log(`  process memory at the end of the run: rss ${(mem.rss / 1048576).toFixed(1)} MiB, heap used ${(mem.heapUsed / 1048576).toFixed(1)} MiB.`);
  console.log('  A column printed as "-" was not measured by the selected phase.');
  console.log('  The phases inside one sample share that sample\'s fixture, so a later phase reads the row fixture');
  console.log('  plus the few records the earlier phases of the same sample wrote. The "records written" and');
  console.log('  "records" lines above bound that addition, and it is the same addition at every row, so it does not');
  console.log('  create the growth the rows show. The write columns of `finalize` do not share it: each one gets its');
  console.log('  own copy, because a store\'s first write builds the incremental state a second write reuses.');
  console.log('  Medians over repeats samples in one process on one machine, warm page cache. Differences of a few');
  console.log('  milliseconds, including negative ones, are noise; read the growth across rows and the composition');
  console.log('  of an operation, not one figure.');
  console.log('  The fixture is one memory.add step per bundle and one fixed clock, which is the shape the plan and');
  console.log('  task logs grow fastest in; a real install spreads its steps over more capabilities.');
  console.log('  This measures what the executive path costs to run. It is not evidence that a plan it recorded was');
  console.log('  a good plan, that a verified step is correct in the world, or that any model would have chosen');
  console.log('  these steps: no model was contacted and no inference was run.');
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node benchmarks/run-executive-bridge-benchmark.mjs [--repeats R] [--rows 1,10,50,150] [--phase all|preview|authorization|run|status|recovery|finalize] [--keep]');
  console.log('  model-free; writes only into fresh temporary data directories; not part of npm test');
} else {
  try {
    await main(opts);
  } finally {
    if (opts.keep) {
      console.log(`\nkept: ${dirs.length} directory/directories under ${TMP_ROOT}`);
    } else {
      for (const dir of dirs) removeDir(dir);
      console.log('\ntemporary data directories removed; nothing outside them was written.');
    }
  }
}
