// Bounded, model-free benchmark for adaptive planning (Batch AL): candidate generation, the disclosed
// comparison, goal progress derivation, plan validation, outcome evaluation, replanning, continuation
// ranking, and the one recorded assessment - measured against synthetic fixtures in a fresh temporary
// data directory at three store sizes.
//
// Batch AM added two more phases over the same fixtures: what one goals recorded constraints cost the
// ledger and the audited read that carries it, at increasing numbers of recorded items; and the
// recovery paths of a run a real process left behind - the continuation reading, the ranking that now
// reads it, and the resume - at the same three store sizes.
//
// No inference is run or simulated and no backend is constructed at all: every application here is
// built with `NoBackend`, and none of the measured paths asks a model. This is not part of `npm test`
// and no test depends on it.
//
//   node benchmarks/run-planning-benchmark.mjs [--sizes S,M,L] [--repeats R] [--phase columns|attribution|control|constraints|recovery|all] [--keep]
//
// Phases:
//   columns      the nine measured paths at each size, through the real controller and the real stores.
//   attribution  what one audited planning read actually costs: the three reads its learning disclosure
//                makes, the whole-log reads beneath them, and the raw read-and-parse of each log, so a
//                cost is attributed to a mechanism rather than asserted.
//   control      at the largest size only: the same fixture with the two ledgers the learning block
//                reads emptied, which separates the planning code from the ledger projection it calls.
//   constraints  the constraint ledger and the audited candidate read over a goal whose recorded
//                blockers grow - 0, 25 and 100 items - at each size.
//   recovery     a real child process (`tests/fixtures/continuation-child.mjs`) stops a plan run at an
//                interruption boundary inside the fixture; a second process then reads it. Measured:
//                the continuation reading, the ranking that reads it, the resume, and the refused
//                second resume. The resume is destructive to that fixture, so it is taken last.
//
// What each sample changes: an audited read appends one operation record of its own, so the second and
// third sample of a read are measured against a log one or two records longer than the first. At the
// sizes below that is a drift of well under one part in a thousand of the audit log, and it is disclosed
// rather than hidden. Nothing else in this file writes during a measurement.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { goalProgress } from '../src/goals/model.js';
import { candidatesForGoal } from '../src/plans/candidates.js';
import { evaluateCandidates } from '../src/plans/evaluation.js';
import { constraintLedger } from '../src/plans/constraints.js';

const NOW = () => new Date('2026-11-05T09:00:00.000Z');
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-05T09:00:00.000Z');
const MAX_REPEATS = 25;
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECOVERY_CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'continuation-child.mjs');

// The three fixture sizes. `L` is the size the AL reads were reported at in the README; the growth
// between S, M and L is what the scaling claim rests on.
const SIZES = {
  S: { memory: 0, knowledge: 0, goals: 1, plans: 1, runs: 1, predictions: 0, experiences: 0 },
  M: { memory: 600, knowledge: 600, goals: 40, plans: 40, runs: 8, predictions: 200, experiences: 120 },
  L: { memory: 2000, knowledge: 2000, goals: 150, plans: 150, runs: 20, predictions: 800, experiences: 400 },
};

const dirs = [];
function tempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `apex-bench-alx-${tag}-`));
  dirs.push(dir);
  return dir;
}

function cleanup(keep) {
  if (keep) {
    for (const dir of dirs) console.log(`left behind: ${dir}`);
    return;
  }
  while (dirs.length) {
    const dir = dirs.pop();
    // Refuse anything that is not this harness's own temporary directory: a mistake in the prefix or
    // the root must not turn a benchmark run into a delete.
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(os.tmpdir())) || !path.basename(resolved).startsWith('apex-bench-alx-')) {
      console.error(`refused to remove ${resolved}: not an apex-bench-alx- temporary directory`);
      continue;
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

const ms = (n) => `${(Math.round(n * 10) / 10).toFixed(1)}ms`;
const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - String(s).length))}`;
const line = (label, t) => `  ${pad(label, 30)} ${pad(ms(t?.median ?? -1), 11)} samples ${t ? t.all.map((x) => Math.round(x)).join('/') : ''}ms`;

async function timed(fn, runs) {
  const samples = [];
  let first = null;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    const out = await fn();
    if (i === 0) first = out;
    samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], all: samples, first };
}

function stepPlan(i) {
  return [
    {
      id: 's1',
      action: 'memory.add',
      description: `record the ${i}th correction`,
      input: { content: `benchmark correction ${i} keeps the index honest` },
      expectedResult: 'the record is stored',
      verification: 'the record reads back',
      dependsOn: [],
      risk: 'medium',
    },
    {
      id: 's2',
      action: 'memory.list',
      description: 'read the list back',
      input: { limit: 5 },
      dependsOn: ['s1'],
      expectedResult: 'the list is returned',
      verification: 'the task log records the step',
      risk: 'low',
    },
  ];
}

// Build one fixture: history at the requested size, then the subject goal and plan every measurement
// answers about, made only through the application's own writes.
async function build(spec, tag) {
  const dir = tempDir(tag);
  const app = await createApp({
    dataDir: dir,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    experienceCapture: CAPTURE_OFF,
    now: NOW,
  });

  for (let i = 0; i < spec.memory; i += 1) {
    await app.memory.add({ content: `benchmark memory ${i} about the release index and budget item ${i % 37}` });
  }
  for (let i = 0; i < spec.knowledge; i += 1) {
    await app.knowledge.add({ subject: `module ${i}`, relationship: 'owned by', object: `team ${i % 11}`, origin: 'user' });
  }

  const subject = await app.controller.goalAdd({
    request: 'remember that the benchmark index is corrected and list my memory',
    criteria: ['remember that the benchmark index is corrected', 'list my memory'],
  });
  const goalId = subject.operation.steps[0].result.data.goalId;
  await app.controller.goalUpdate({ target: goalId, status: 'accepted' });
  await app.controller.goalUpdate({ target: goalId, status: 'active' });
  const made = await app.controller.planAdd({
    goalId,
    outcome: 'the corrected index is stored and read back',
    steps: stepPlan(0),
    reason: 'created for the benchmark',
  });
  const planId = made.operation.steps[0].result.data.planId;
  await app.controller.planApprove({ target: planId });
  if (spec.runs > 0) {
    const started = await app.controller.planActivate(planId, { mode: 'run' });
    if (started.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`the subject plan did not run: ${started.output}`);
  }

  // The backlog the reads scan: goals and plans that are not the subject.
  for (let i = 0; i < spec.goals; i += 1) {
    const g = await app.goals.createGoal({
      request: `retire the ${i}th legacy cache`,
      criteria: [`the ${i}th cache no longer answers`],
      priority: (i % 5) + 1,
    });
    if (i < spec.plans) {
      const p = await app.plans.createPlan({
        goalId: g.goalId,
        outcome: `the ${i}th cache is retired`,
        steps: stepPlan(i + 1),
        reason: 'historical plan for the benchmark',
      });
      if (i < spec.runs) {
        await app.plans.approve(p.plan.id);
        await app.controller.planActivate(p.plan.id, { mode: 'run' });
      }
    }
  }

  // An experience may be recorded once per operation, so the audit log is grown first with audited
  // reads of the experience ledger - the shape a long log really has - and then one experience is
  // filed against each of those operations.
  const opsFile = path.join(dir, 'operations.jsonl');
  const opCount = () => fs.readFileSync(opsFile, 'utf8').trim().split(/\r?\n/).length;
  while (opCount() < spec.experiences + 1) await app.controller.experienceList({ limit: 5 });
  const ops = fs.readFileSync(opsFile, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
  for (let i = 0; i < spec.predictions; i += 1) {
    await app.predictions.recordPrediction({
      capability: 'memory.list',
      expectation: 'success',
      subject: `benchmark expectation ${i}`,
      expiresAt: new Date(T0 + ((i % 300) + 2) * DAY).toISOString(),
      origin: 'user',
    });
  }
  for (let i = 0; i < spec.experiences; i += 1) {
    await app.experience.recordExperience({
      operationId: ops[i].id,
      subject: `benchmark experience ${i} of a bounded read`,
      origin: 'user',
    });
  }

  const counts = Object.fromEntries(fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => [f.replace('.jsonl', ''), fs.readFileSync(path.join(dir, f), 'utf8').trim().split(/\r?\n/).filter(Boolean).length]));
  const bytes = Object.fromEntries(fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => [f.replace('.jsonl', ''), fs.statSync(path.join(dir, f)).size]));
  return { dir, app, goalId, planId, counts, bytes };
}

async function columns(f, repeats) {
  const { app } = f;
  const goal = await app.goals.resolve(f.goalId);
  const registry = app.registry;
  const evidence = { unavailableActions: [], knownBlockers: [] };
  const generated = await timed(() => candidatesForGoal({ goal, registry, evidence }), Math.min(repeats, 5));
  return {
    decomposition: await timed(() => app.controller.assessStoredGoal(f.goalId), repeats),
    generation: generated,
    evaluation: await timed(() => evaluateCandidates({ result: generated.first, goal, registry, evidence }), Math.min(repeats, 5)),
    validation: await timed(() => app.controller.validateStoredPlan(f.planId), repeats),
    progress: await timed(async () => (await app.goals.list()).map((g) => goalProgress(g)).length, repeats),
    outcome: await timed(() => app.controller.planOutcome({ plan: f.planId }), repeats),
    replan: await timed(() => app.controller.planReplan({ plan: f.planId }), repeats),
    candidates: await timed(() => app.controller.planCandidates({ goal: f.goalId }), repeats),
    ranking: await timed(() => app.controller.continuationReport({ limit: 10 }), repeats),
  };
}

async function attribution(f, repeats) {
  const { app } = f;
  const log = (name) => (fs.existsSync(path.join(f.dir, `${name}.jsonl`))
    ? fs.readFileSync(path.join(f.dir, `${name}.jsonl`), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    : []);
  const counts = {};
  const wrap = (obj, name, label) => {
    if (!obj || typeof obj[name] !== 'function') return;
    const original = obj[name].bind(obj);
    counts[label] = 0;
    obj[name] = (...args) => { counts[label] += 1; return original(...args); };
  };
  wrap(app.plans, 'list', 'plans.list');
  wrap(app.goals, 'list', 'goals.list');
  wrap(app.experience, 'activeAdaptations', 'activeAdaptations');
  wrap(app.predictions, 'calibration', 'calibration');
  wrap(app.operations, 'findById', 'operations.findById');
  await app.controller.planCandidates({ goal: f.goalId });
  const readsPerCandidate = { ...counts };
  await app.controller.planOutcome({ plan: f.planId });
  const readsPerOutcome = { ...counts };
  return {
    learning: await timed(() => Promise.all([
      app.experience.activeAdaptations({ limit: 200 }),
      app.predictions.calibration({}),
      app.plans.list(),
    ]), repeats),
    calibration: await timed(() => app.predictions.calibration({}), repeats),
    activeAdaptations: await timed(() => app.experience.activeAdaptations({ limit: 200 }), repeats),
    plansList: await timed(() => app.plans.list(), repeats),
    goalsList: await timed(() => app.goals.list(), repeats),
    operationsInspect: await timed(() => app.operations.inspect(), repeats),
    parseOnly: await timed(async () => log('predictions').length + log('experiences').length, repeats),
    readsPerCandidate,
    readsPerOutcome,
  };
}

// The control: the same fixture with the two ledgers the learning disclosure reads emptied. Only the
// largest size is worth this, and it is destructive to that fixture - which is why it runs last.
async function control(f, repeats) {
  for (const name of ['predictions', 'experiences']) {
    fs.writeFileSync(path.join(f.dir, `${name}.jsonl`), '');
  }
  return {
    candidates: await timed(() => f.app.controller.planCandidates({ goal: f.goalId }), repeats),
    replan: await timed(() => f.app.controller.planReplan({ plan: f.planId }), repeats),
    outcome: await timed(() => f.app.controller.planOutcome({ plan: f.planId }), repeats),
    learning: await timed(() => Promise.all([
      f.app.experience.activeAdaptations({ limit: 200 }),
      f.app.predictions.calibration({}),
      f.app.plans.list(),
    ]), repeats),
  };
}

// Batch AM, work package K: what a goals recorded constraints cost. The ledger is the whole read - the
// recorded blockers, prerequisites, constraints, resources, time conditions and unknowns, each of which
// sends a citation to the stores for a live answer. A fresh goal is used rather than the subject goal:
// revising the subject goal would move the revision its plan is bound to, and the columns above would
// then measure a different plan.
//
// The store caps each of those six lists at MAX_GOAL_ITEMS, so a goals own recorded constraints have a
// hard ceiling; the ladder below reaches it (0, one full list, all six full) and the growth that remains
// is the size of the stores the citations are answered from - which is what the three fixture sizes vary.
const CONSTRAINT_RUNGS = [
  { label: '0 recorded items', kinds: [] },
  { label: '8 blockers', kinds: ['blockers'] },
  { label: '8 of each of the six kinds', kinds: ['prerequisites', 'constraints', 'resources', 'timeConditions', 'blockers', 'unknowns'] },
];

async function constraints(f, repeats) {
  const { app } = f;
  const made = await app.controller.goalAdd({
    // Criteria the generator can ground in registered capabilities: a constraint can only bear on a step
    // that exists, so a goal no capability can carry would measure a ledger that never reaches work.
    request: 'remember that the benchmark cache is corrected and list my memory',
    criteria: ['remember that the benchmark cache is corrected', 'list my memory'],
  });
  if (made.status !== Outcome.GOAL_CREATED) return { refused: `goal add: ${made.output}` };
  const goalId = made.operation.steps[0].result.data.goalId;
  await app.controller.goalUpdate({ target: goalId, status: 'accepted' });
  await app.controller.goalUpdate({ target: goalId, status: 'active' });
  const rungs = [];
  for (const rung of CONSTRAINT_RUNGS) {
    const sets = Object.fromEntries(rung.kinds.map((field) => [field, Array.from({ length: 8 }, (_, i) => ({
      // The text names a registered capability on purpose: a constraint gates the steps it bears on, and
      // a rung whose items bear on nothing would measure a ledger that never reaches the exclusion path.
      text: `benchmark ${field.slice(0, -1)} ${i}: ${i % 2 === 0 ? 'memory.add' : 'memory.list'} is unavailable on this machine`,
      basis: 'user_stated',
    }))]));
    const count = Object.values(sets).reduce((n, list) => n + list.length, 0);
    const goal = await app.goals.resolve(goalId);
    const revised = count === 0
      ? { status: Outcome.GOAL_UPDATED, output: 'no revision needed: the goal records nothing yet' }
      : await app.controller.goalRevise({
        target: goalId,
        criteria: goal.criteria.map((c) => ({ description: c.description, basis: c.basis })),
        ...sets,
        reason: `the benchmark recorded ${count} constraint item(s)`,
      });
    if (revised.status !== Outcome.GOAL_UPDATED) {
      rungs.push({ label: rung.label, count, refused: `${revised.status}: ${String(revised.output).slice(0, 140)}` });
      continue;
    }
    const read = await app.goals.resolve(goalId);
    const registry = app.registry;
    const ledger = await timed(() => constraintLedger({ goal: read, registry }), repeats);
    const audited = await timed(() => app.controller.planCandidates({ goal: goalId }), repeats);
    const data = audited.first?.operation?.steps?.[0]?.result?.data ?? {};
    rungs.push({
      label: rung.label,
      count,
      ledger,
      audited,
      items: (data.constraints?.constraints ?? []).length,
      gating: (data.constraints?.gating ?? []).length,
      included: (data.comparison?.included ?? []).length,
      excluded: (data.comparison?.excluded ?? []).length,
    });
  }
  return { rungs };
}

// The recovery paths over a run a real process left behind. The interruption is not simulated: the same
// fixture the AM tests stop is spawned here, so the records the reads below walk are the bytes a stopped
// process wrote. `plan continue` executes the untouched steps, so it is timed once and taken last.
async function recovery(f, repeats) {
  const dir = f.dir;
  const effectFile = path.join(dir, 'effects.txt');
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('APEX_')) env[k] = v;
  const child = spawn(process.execPath, [RECOVERY_CHILD, 'after-step-creation', dir, effectFile, 'independent'], {
    env: { ...env, APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir, APEX_DATA_ISOLATED: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const exitCode = await new Promise((resolve) => { child.once('exit', (code) => resolve(code)); });
  const reported = out.split('\n').filter((l) => l.startsWith('RESULT '));
  if (reported.length === 0) return { refused: `the stopped run reported nothing (exit ${exitCode}): ${err.slice(0, 200)}` };
  const last = JSON.parse(reported[reported.length - 1].slice(7));

  // A second process, holding the registry the stopped run ran under, reads the records it left.
  const effects = path.join(dir, 'effects.txt');
  const effectLines = () => (fs.existsSync(effects)
    ? fs.readFileSync(effects, 'utf8').split('\n').filter((l) => l.trim() !== '') : []);
  const make = (name, permission, mark) => ({
    name,
    description: `benchmark fixture ${permission} that leaves one observable line behind`,
    inputHint: '{"tag":"text"}',
    permission,
    origins: permission === 'write' ? ['user'] : ['user', 'model'],
    validate: (input) => ({ tag: String(input?.tag ?? 'x').trim() }),
    async execute(_ctx, input) {
      fs.appendFileSync(effects, `${mark(input.tag)}\n`);
      return { summary: `${name} ${input.tag}`, data: { tag: input.tag, effect: mark(input.tag) } };
    },
    async verify(_ctx, input, result) {
      const want = mark(String(input?.tag ?? result?.data?.tag ?? ''));
      return effectLines().includes(want)
        ? { ok: true, detail: `the side-effect file holds ${want}` }
        : { ok: false, detail: `the side-effect file holds no ${want}` };
    },
  });
  const reader = await createApp({
    dataDir: dir,
    now: NOW,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    experienceCapture: CAPTURE_OFF,
    extraActions: [make('probe.note', 'write', (tag) => tag), make('probe.peek', 'read', (tag) => `read:${tag}`)],
  });
  const read = await timed(() => reader.controller.planContinuation(last.planId), repeats);
  const ranking = await timed(() => reader.controller.continuationReport({ limit: 10 }), repeats);
  const asked = await timed(() => reader.controller.handle(
    `what is the readiness of plan ${String(last.planId).slice(0, 8)}?`, { origin: 'user' },
  ), repeats);
  const resumed = await timed(() => reader.controller.planContinue(last.planId), 1);
  const refusedAgain = await timed(() => reader.controller.planContinue(last.planId), repeats);
  const settledRead = await timed(() => reader.controller.planContinuation(last.planId), repeats);
  const settledRanking = await timed(() => reader.controller.continuationReport({ limit: 10 }), repeats);
  return {
    planId: last.planId,
    read,
    ranking,
    asked,
    resumed,
    refusedAgain,
    settledRead,
    settledRanking,
    effects: effectLines().length,
    resumeStatus: resumed.first?.status ?? null,
    refusalStatus: refusedAgain.first?.status ?? null,
  };
}

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--') ? process.argv[at + 1] : (process.argv.includes(`--${name}`) ? true : fallback);
}

const repeats = Math.min(Math.max(1, Number(arg('repeats', 3)) || 3), MAX_REPEATS);
const phase = arg('phase', 'all');
const keep = arg('keep', false) === true;
const wanted = String(arg('sizes', 'S,M,L')).split(',').map((s) => s.trim().toUpperCase()).filter((s) => SIZES[s]);

try {
  for (const size of wanted) {
    const built = await timed(() => build(SIZES[size], size), 1);
    const f = built.first;
    console.log(`\n### size ${size}  seeded in ${ms(built.median)}`);
    console.log(`  records ${JSON.stringify(f.counts)}`);
    console.log(`  bytes   ${JSON.stringify(f.bytes)}`);
    if (phase === 'columns' || phase === 'all') {
      const c = await columns(f, repeats);
      console.log('  --- the nine planning paths');
      console.log(line('goal decomposition', c.decomposition));
      console.log(line('candidate generation (pure)', c.generation));
      console.log(line('candidate evaluation (pure)', c.evaluation));
      console.log(line('plan validation', c.validation));
      console.log(line('goal progress over all goals', c.progress));
      console.log(line('outcome read (audited)', c.outcome));
      console.log(line('replan read (audited)', c.replan));
      console.log(line('candidate read (audited)', c.candidates));
      console.log(line('continuation ranking', c.ranking));
    }
    if (phase === 'attribution' || phase === 'all') {
      const a = await attribution(f, repeats);
      console.log('  --- attribution: what the audited reads spend their time on');
      console.log(line('the three learning reads', a.learning));
      console.log(line('predictions.calibration', a.calibration));
      console.log(line('activeAdaptations', a.activeAdaptations));
      console.log(line('plans.list', a.plansList));
      console.log(line('goals.list', a.goalsList));
      console.log(line('operations.inspect', a.operationsInspect));
      console.log(line('both logs read+parse', a.parseOnly));
      console.log(`  store reads during one candidate read: ${JSON.stringify(a.readsPerCandidate)}`);
      console.log(`  and during one outcome read too:       ${JSON.stringify(a.readsPerOutcome)}`);
    }
    if (phase === 'constraints' || phase === 'all') {
      const k = await constraints(f, repeats);
      console.log('  --- constraint evaluation: one goal, its recorded items grown to the store cap');
      if (k.refused) console.log(`  refused: ${k.refused}`);
      for (const r of k.rungs ?? []) {
        if (r.refused) {
          console.log(`  ${pad(r.label, 30)} refused: ${r.refused}`);
          continue;
        }
        console.log(`  ${pad(r.label, 30)} ${pad(`${r.count} recorded`, 14)} ledger ${pad(ms(r.ledger.median), 11)}`
          + ` audited read ${pad(ms(r.audited.median), 11)} ledger answers ${r.items} gating ${r.gating}`
          + ` candidates ${r.included} in, ${r.excluded} excluded`);
        console.log(`  ${' '.repeat(30)} samples ledger ${r.ledger.all.map((x) => Math.round(x)).join('/')}ms`
          + ` read ${r.audited.all.map((x) => Math.round(x)).join('/')}ms`);
      }
    }
    if (phase === 'recovery' || phase === 'all') {
      const r = await recovery(f, repeats);
      console.log('  --- recovery of a run a real process left behind (second process, same records)');
      if (r.refused) console.log(`  refused: ${r.refused}`);
      else {
        console.log(line('continuation reading', r.read));
        console.log(line('ranking over the reading', r.ranking));
        console.log(line('readiness question', r.asked));
        console.log(line('resume (one write, 2 steps)', r.resumed));
        console.log(line('resume refused, run closed', r.refusedAgain));
        console.log(line('reading of the settled run', r.settledRead));
        console.log(line('ranking after the resume', r.settledRanking));
        console.log(`  resume outcome ${r.resumeStatus}; the refused second resume ${r.refusalStatus};`
          + ` the side-effect file holds ${r.effects} line(s) for plan ${String(r.planId).slice(0, 8)}`);
      }
    }
    if ((phase === 'control' || phase === 'all') && size === wanted[wanted.length - 1] && SIZES[size].predictions > 0) {
      const c = await control(f, repeats);
      console.log('  --- control: the same fixture with no predictions and no experiences');
      console.log(line('candidate read (audited)', c.candidates));
      console.log(line('replan read (audited)', c.replan));
      console.log(line('outcome read (audited)', c.outcome));
      console.log(line('the three learning reads', c.learning));
    }
    if (phase === 'all') {
      // Recorded last, so the one assessment a fixture can hold does not sit inside the reads above.
      // A second recording of the same version is refused by the store, so this is taken once.
      const assessed = await timed(() => f.app.controller.planAssess({ target: f.planId }), 1);
      console.log('  --- the recorded assessment (one write, first and only version)');
      console.log(line('plan assess (audited write)', assessed));
      if (![Outcome.PLAN_STORED, Outcome.SUCCESS_VERIFIED].includes(assessed.first.status)) {
        console.log(`  refused: ${assessed.first.output}`);
      }
    }
  }
} finally {
  cleanup(keep);
}
