// Bounded, network-free benchmark for the Batch AO runtime diagnostics and the stages they observe.
//
// Every request is handled by a real controller against a fresh temporary data directory. The model
// is a deterministic in-process fixture: a plain object implementing the same small backend interface
// the HTTP backends implement, so `model_call`, model-output validation, proposal validation, handoff
// preparation, authorization, execution, and verification all run through their real code paths.
// Nothing here constructs an HTTP backend except the retry row, which uses an injected `fetchImpl`
// that never leaves the process. No inference is run, no socket is opened, and no endpoint is named.
//
//   node benchmarks/run-cognitive-runtime-benchmark.mjs [--repeats R] [--phase answer|proposal|handoff|executive|diagnostics|all] [--keep]
//
// Phases:
//   answer       one grounded question at empty/small/medium/large/extra-large evidence contexts.
//                Reports wall time and the per-stage durations the runtime diagnostics recorded.
//   proposal     deterministic model replies: one permitted read-only proposal, a duplicated
//                proposal, a denied write proposal, a malformed proposal, an already-cancelled
//                request, and one transport retry (the only row that touches a fetch implementation,
//                and it is a local fake).
//   handoff      src/executive/handoff.js in isolation: build/prepare/complete/record-check and live
//                reference validation for 1, 2, 4 and 8-step plans, plus the index cost at growing
//                step-operation histories. Its component hashes are timed separately.
//   executive    plan add -> approve -> activate (run) for a 1-step and an 8-step plan, then the
//                continuation (work/next) report, each read from its operation diagnostics.
//   diagnostics  SpanRecorder micro-cost, record size, and a repeated-request record-size check.
//
// Measurement rules: timings are monotonic (`performance.now`). A duration that was not produced is
// `null`, never zero; the tables print `n/a` for it. p95 is printed only when the sample count is at
// least 20, because a smaller sample cannot support it. The fixture writes only into a fresh
// temporary directory, which is removed unless --keep is given. This is not part of `npm test`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend, OpenAICompatibleBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import {
  buildPlanActivationHandoff, completeTaskHandoff, proposalBindingHash,
  taskBindingHash, validateHandoff, validateHandoffReferences,
} from '../src/executive/handoff.js';
import { planContentHash } from '../src/plans/model.js';
import { SpanRecorder } from '../src/cognition/runtime-diagnostics.js';

const NOW = () => new Date('2026-06-01T00:00:00.000Z');
const QUESTION = 'what is the status of the lighthouse project?';
const SIZES = [0, 20, 200, 800, 2000];
const PLAN_STEPS = [1, 2, 4, 8];
const HANDOFF_HISTORY = [0, 100, 1000];
const MAX_REPEATS = 25;
const DEFAULT_REPEATS = 9;
const MAX_SEED = SIZES[SIZES.length - 1];
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const PREFIX = 'apex-bench-ao8-';
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
      if (!['answer', 'proposal', 'handoff', 'executive', 'diagnostics', 'all'].includes(name)) throw new Error(`unknown phase ${name}`);
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
    // Below 20 samples the tail is an anecdote, so it is not reported.
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

// The model is a fixed in-process object. `complete` returns exactly the fields a real backend
// returns, so the gateway classifies and wraps it the same way; `configured: true` is what lets the
// controller take the model path instead of reporting model_unavailable.
function fixtureGateway(text) {
  const backend = {
    name: 'benchmark-fixture',
    provider: 'fixture',
    configured: true,
    describe: () => ({ configured: true, provider: 'fixture', endpoint: 'in-process fixture', model: 'fixture' }),
    health: async () => ({ available: true, detail: 'in-process fixture' }),
    complete: async () => ({
      ok: true, backend: 'benchmark-fixture', provider: 'fixture', model: 'fixture',
      text, finishReason: 'stop', truncated: false, latencyMs: 0,
    }),
  };
  return new ModelGateway({ backend });
}

function benchAction(sink) {
  return [{
    name: 'bench.ok',
    description: 'records a tag and reports the stored tag',
    inputHint: '{"tag":"text"}',
    permission: 'read',
    origins: ['user', 'model'],
    validate: (input) => ({ tag: String(input?.tag ?? 'x') }),
    async execute(_context, input) {
      sink.push(input.tag);
      return { summary: `recorded ${input.tag}`, data: { tag: input.tag } };
    },
    async verify() { return { ok: true, detail: 'the tag is readable' }; },
  }];
}

function makeApp({ dataDir, reply = 'The lighthouse project has one recorded status value.', actions = [] }) {
  return createApp({
    dataDir,
    gateway: fixtureGateway(reply),
    extraActions: actions,
    experienceCapture: CAPTURE_OFF,
    now: NOW,
  });
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

function stageOf(operation, id) {
  return operation?.diagnostics?.stages?.find((s) => s.id === id) ?? null;
}

function outcomeLabel(stage) {
  return stage ? stage.outcome : 'missing';
}

function printRow(label, s, extra = '') {
  const tail = s.p95 === null ? '' : `, p95 ${ms(s.p95)}`;
  console.log(`  ${label.padEnd(28)} ${ms(s.median).padStart(10)} median (min ${ms(s.min)}, max ${ms(s.max)}${tail}) over ${s.n} sample(s)${extra}`);
}

async function phaseAnswer(opts) {
  const dataDir = tempDir();
  const app = makeApp({ dataDir });
  console.log('\nanswer: one grounded question through the full request lifecycle');
  console.log('  request: "' + QUESTION + '"');
  console.log('  the model is a deterministic in-process fixture; the record is the operation\'s own diagnostics');
  console.log('  records | evidence claims | total | request  retrieval  claims  contradictions  deliberation  brief | model  validate | finalize');
  let seeded = 0;
  for (const size of SIZES) {
    if (size > seeded) {
      await seed(app, size - seeded);
      seeded = size;
    }
    // Warm-up samples are not measured; they let the store's read cache behave as in steady state.
    for (let i = 0; i < 2; i += 1) await app.controller.handle(QUESTION);
    const runs = [];
    for (let i = 0; i < opts.repeats; i += 1) {
      const r = await timed(() => app.controller.handle(QUESTION));
      runs.push({ ms: r.ms, operation: r.value.operation, status: r.value.status });
    }
    const total = stats(runs.map((r) => r.operation?.diagnostics?.totalMs));
    const wall = stats(runs.map((r) => r.ms));
    const last = runs[runs.length - 1].operation;
    const stage = (id) => stats(runs.map((r) => stageOf(r.operation, id)?.durationMs).filter((v) => v !== null));
    const evidence = last?.cognition?.evidence?.total ?? null;
    const claims = last?.cognition?.claims?.total ?? null;
    console.log(`  ${String(size).padStart(7)} | ${String(evidence).padStart(8)} ${String(claims).padStart(6)} | ${ms(total.median).padStart(9)} | `
      + `${ms(stage('request_interpretation').median).padStart(8)} ${ms(stage('evidence_retrieval').median).padStart(10)} `
      + `${ms(stage('claim_extraction').median).padStart(6)} ${ms(stage('contradiction_detection').median).padStart(14)} `
      + `${ms(stage('deliberation').median).padStart(12)} ${ms(stage('grounded_response').median).padStart(5)} | `
      + `${ms(stage('model_call').median).padStart(5)} ${ms(stage('model_output_validation').median).padStart(8)} | ${ms(stage('finalization').median)}`);
    printRow(`  wall, ${size} records`, wall, `, status ${runs[runs.length - 1].status}`);
  }
  console.log('  The stages above are the durations the request recorded; a stage the path did not reach');
  console.log('  is absent from its average rather than counted as zero.');
}

function proposalReply() {
  return 'Let me look that up.\nPROPOSE_ACTION {"action":"bench.ok","input":{"tag":"probe"}}';
}

async function phaseProposal(opts) {
  const dataDir = tempDir();
  const sink = [];
  const app = makeApp({ dataDir, reply: proposalReply(), actions: benchAction(sink) });
  await seed(app, 20);
  console.log('\nproposal: model output crossing the authorization boundary');
  const cases = [
    ['permitted read proposal', proposalReply()],
    ['duplicated proposal', `${proposalReply()}\nPROPOSE_ACTION {"action":"bench.ok","input":{"tag":"probe"}}`],
    ['denied write proposal', 'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the fixture decided this"}}'],
    ['malformed proposal', 'PROPOSE_ACTION {not json}'],
  ];
  for (const [label, reply] of cases) {
    app.gateway.backend.complete = async () => ({
      ok: true, backend: 'benchmark-fixture', provider: 'fixture', model: 'fixture',
      text: reply, finishReason: 'stop', truncated: false, latencyMs: 0,
    });
    await app.controller.handle('please check the bench tag');
    const runs = [];
    for (let i = 0; i < opts.repeats; i += 1) {
      const r = await timed(() => app.controller.handle('please check the bench tag'));
      runs.push({ ms: r.ms, result: r.value });
    }
    const last = runs[runs.length - 1].result;
    const op = last.operation;
    const pv = stageOf(op, 'proposal_validation');
    const hp = stageOf(op, 'handoff_preparation');
    const auth = stageOf(op, 'authorization');
    const exec = stageOf(op, 'execution');
    const ver = stageOf(op, 'verification');
    const wall = stats(runs.map((r) => r.ms));
    const steps = op.steps ?? [];
    console.log(`  ${label}: status ${last.status}, ${steps.length} step(s)`
      + `${pv ? `, proposal_validation ${pv.outcome} ${JSON.stringify(pv.counts)}` : ''}`);
    console.log(`    handoff ${hp ? `${hp.outcome} ${JSON.stringify(hp.counts)}` : 'missing'}; `
      + `authorization ${outcomeLabel(auth)}; execution ${outcomeLabel(exec)}; verification ${outcomeLabel(ver)}`);
    printRow('    wall', wall, `, record ${JSON.stringify(op.diagnostics).length} bytes`);
  }

  // A request cancelled before it is sent: no model call, no step, and the record says cancelled.
  for (const truthy of [true]) {
    const controller = new AbortController();
    controller.abort();
    const runs = [];
    for (let i = 0; i < opts.repeats; i += 1) {
      const r = await timed(() => app.controller.handle(QUESTION, { signal: controller.signal }));
      runs.push({ ms: r.ms, result: r.value });
    }
    const last = runs[runs.length - 1].result;
    console.log(`  cancelled-before-send: status ${last.status}, steps ${last.operation.steps.length}, `
      + `model_call ${outcomeLabel(stageOf(last.operation, 'model_call'))}, `
      + `cancellation ${JSON.stringify(last.operation.diagnostics?.cancellation)}, cancellation-code ${truthy}`);
    printRow('    wall', stats(runs.map((r) => r.ms)));
  }

  // The only transport row. retries: 1 means one repeat after an UNREACHABLE attempt; the gateway's
  // own backoff (300 ms, a constant in the transport) is included in the figure.
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls % 2 === 1) throw Object.assign(new Error('fixture refused the connection'), { code: 'ECONNREFUSED' });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'retried answer' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const retryGateway = new ModelGateway({
    backend: new OpenAICompatibleBackend({ baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', retries: 1, fetchImpl }),
  });
  const retryRuns = [];
  for (let i = 0; i < Math.min(3, opts.repeats); i += 1) {
    const r = await timed(() => retryGateway.complete({ prompt: 'ping' }));
    retryRuns.push({ ms: r.ms, result: r.value });
  }
  const retried = retryRuns[retryRuns.length - 1].result;
  console.log(`  one transport retry: ok ${retried.ok}, class ${retried.class}, ${retryRuns.length} sample(s); `
    + 'the 300 ms retry backoff is part of every figure');
  printRow('    wall', stats(retryRuns.map((r) => r.ms)));
}

async function makeRunnablePlan(app, steps) {
  const added = await app.controller.planAdd({
    outcome: `benchmark plan with ${steps} step(s)`,
    reason: 'benchmark fixture',
    steps: Array.from({ length: steps }, (_, i) => ({
      id: `s${i + 1}`,
      description: `benchmark step ${i + 1}`,
      action: 'bench.ok',
      input: { tag: `t${i + 1}` },
      dependsOn: i === 0 ? [] : [`s${i}`],
      expectedResult: 'the tag is recorded',
      verification: 'the tag reads back',
      risk: 'low',
    })),
  });
  if (added.status !== Outcome.PLAN_STORED) throw new Error(`planAdd failed: ${added.status} ${added.output ?? ''}`);
  const planId = added.operation.steps[0]?.result?.data?.planId;
  const approved = await app.controller.planApprove({ target: planId });
  if (approved.status !== Outcome.PLAN_STORED) throw new Error(`planApprove failed: ${approved.status} ${approved.output ?? ''}`);
  return planId;
}

async function phaseHandoff(opts) {
  const dataDir = tempDir();
  const sink = [];
  const app = makeApp({ dataDir, actions: benchAction(sink) });
  console.log('\nhandoff: src/executive/handoff.js against live records');
  console.log('  steps | build+check | complete | record check | reference check | plan hash | task hash | record bytes');
  for (const steps of PLAN_STEPS) {
    const planId = await makeRunnablePlan(app, steps);
    const run = await app.controller.planActivate(planId, { mode: 'run' });
    if (run.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`planActivate failed: ${run.status} ${run.output ?? ''}`);
    const taskId = run.operation.task?.id;
    const plan = await app.plans.get(planId);
    const task = await app.taskStore.get(taskId);
    const stepOperations = (task?.steps ?? []).filter((s) => s.operationId).map((s) => ({
      id: s.operationId, capability: 'task.step', task: { id: task.id, stepId: s.id }, status: s.outcome,
    }));
    const requestId = run.operation.id;
    const prepared = [];
    const completed = [];
    const recorded = [];
    const referenced = [];
    let record = null;
    for (let i = 0; i < opts.repeats; i += 1) {
      const prepare = await timed(() => {
        const r = buildPlanActivationHandoff({ requestId, plan, goal: null, task });
        const check = validateHandoff(r, { phase: 'prepared' });
        if (!check.ok) throw new Error(`prepared check failed: ${check.problems[0]}`);
        return r;
      });
      prepared.push(prepare.ms);
      const complete = await timed(() => {
        const r = completeTaskHandoff(prepare.value, { task });
        if (r.state !== 'verified') throw new Error(`completed handoff state ${r.state}`);
        return r;
      });
      completed.push(complete.ms);
      const recordCheck = await timed(() => {
        const check = validateHandoff(complete.value, { phase: 'recorded' });
        if (!check.ok) throw new Error(`recorded check failed: ${check.problems[0]}`);
        return check;
      });
      recorded.push(recordCheck.ms);
      const references = await timed(() => {
        const check = validateHandoffReferences(complete.value, { plan, task, stepOperations });
        if (!check.ok) throw new Error(`reference check failed: ${check.problems[0]}`);
        return check;
      });
      referenced.push(references.ms);
      record = complete.value;
    }
    const planHash = [];
    const taskHash = [];
    for (let i = 0; i < opts.repeats; i += 1) {
      planHash.push((await timed(() => planContentHash(plan))).ms);
      taskHash.push((await timed(() => taskBindingHash(task))).ms);
    }
    console.log(`  ${String(steps).padStart(5)} | ${ms(stats(prepared).median).padStart(10)} | ${ms(stats(completed).median).padStart(8)} | `
      + `${ms(stats(recorded).median).padStart(12)} | ${ms(stats(referenced).median).padStart(15)} | `
      + `${us(stats(planHash).median).padStart(9)} | ${us(stats(taskHash).median).padStart(9)} | ${String(JSON.stringify(record).length).padStart(12)}`);
  }

  // The index a reference check builds is linear in the history it is given, even though only the
  // task's own operations are ever looked up. This row says what that costs as the history grows.
  const taskId = (await app.taskStore.list?.() ?? [])[0]?.id ?? null;
  const planId = (await app.plans.list?.() ?? [])[0]?.id ?? null;
  const plan = planId ? await app.plans.get(planId) : null;
  const task = taskId ? await app.taskStore.get(taskId) : null;
  if (plan && task) {
    const record = completeTaskHandoff(buildPlanActivationHandoff({ requestId: 'bench-history', plan, goal: null, task }), { task });
    const own = (task.steps ?? []).filter((s) => s.operationId).map((s) => ({
      id: s.operationId, capability: 'task.step', task: { id: task.id, stepId: s.id }, status: s.outcome,
    }));
    console.log('  reference validation against a growing step-operation history:');
    for (const pad of HANDOFF_HISTORY) {
      const entries = [...own];
      for (let i = 0; i < pad; i += 1) entries.push({ id: `pad-${i}`, capability: 'task.step', task: { id: `other-${i}`, stepId: `p${i}` }, status: 'success_verified' });
      const samples = [];
      for (let i = 0; i < opts.repeats; i += 1) {
        samples.push((await timed(() => {
          const check = validateHandoffReferences(record, { plan, task, stepOperations: entries });
          if (!check.ok) throw new Error(`padded reference check failed: ${check.problems[0]}`);
        })).ms);
      }
      console.log(`    ${String(pad).padStart(5)} extra entries | ${ms(stats(samples).median)} median`);
    }
  }
}

async function phaseExecutive(opts) {
  const dataDir = tempDir();
  const sink = [];
  const app = makeApp({ dataDir, actions: benchAction(sink) });
  console.log('\nexecutive: plan add -> approve -> activate (run) through the controller');
  console.log('  steps | add | approve | activate | plan_validation | handoff | authorization | execution | verification | task_execution');
  for (const steps of [1, 8]) {
    const add = await timed(() => app.controller.planAdd({
      outcome: `executive benchmark plan with ${steps} step(s)`,
      reason: 'benchmark fixture',
      steps: Array.from({ length: steps }, (_, i) => ({
        id: `e${i + 1}`,
        description: `executive benchmark step ${i + 1}`,
        action: 'bench.ok',
        input: { tag: `e${i + 1}` },
        dependsOn: i === 0 ? [] : [`e${i}`],
        expectedResult: 'the tag is recorded',
        verification: 'the tag reads back',
        risk: 'low',
      })),
    }));
    const planId = add.value.operation?.steps?.[0]?.result?.data?.planId;
    const approve = await timed(() => app.controller.planApprove({ target: planId }));
    const activate = await timed(() => app.controller.planActivate(planId, { mode: 'run' }));
    const op = activate.value.operation;
    const stages = ['plan_validation', 'handoff_preparation', 'authorization', 'execution', 'verification', 'task_execution'];
    console.log(`  ${String(steps).padStart(5)} | ${ms(add.ms).padStart(6)} | ${ms(approve.ms).padStart(7)} | ${ms(activate.ms).padStart(8)} | `
      + stages.map((id) => `${ms(stageOf(op, id)?.durationMs).padStart(id === 'task_execution' ? 14 : 14)}`).join(' | '));
    console.log(`    activate status ${activate.value.status}; ${stageOf(op, 'task_execution')?.counts?.steps ?? 0} step(s) executed; the completion check is part of finalization`);
  }
  // work/next: the continuation report the CLI exposes. It reads goals, plans, tasks, assessments
  // and learning records; nothing is written.
  const samples = [];
  for (let i = 0; i < opts.repeats; i += 1) samples.push((await timed(() => app.controller.continuationReport({ limit: 10 }))).ms);
  printRow('  continuationReport', stats(samples));
  const rows = (await app.controller.continuationReport({ top: true })).output ?? '';
  console.log(`  work/next answer: ${String(rows).split('\n').length} line(s), ${String(rows).length} character(s)`);
}

async function phaseDiagnostics(opts) {
  const dataDir = tempDir();
  const sink = [];
  const app = makeApp({ dataDir, reply: proposalReply(), actions: benchAction(sink) });
  await seed(app, 20);

  // Micro-cost of the recorder itself, per request-shaped workload: 16 stages, half measured, then
  // one snapshot and one total. This is the instrumentation's own overhead, not an end-to-end A/B:
  // instrumentation has no off switch in the request path, so an off comparison would measure a
  // different build rather than the same build with a flag.
  const ITERATIONS = 20000;
  const micro = [];
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    for (let j = 0; j < ITERATIONS; j += 1) {
      const recorder = new SpanRecorder();
      const spans = [];
      for (let k = 0; k < 8; k += 1) {
        const span = recorder.start('model_call');
        recorder.end(span, { outcome: 'ran', counts: { ok: 1 } });
      }
      for (let k = 0; k < 8; k += 1) recorder.mark('execution', { outcome: 'ran', counts: { ok: 1 } });
      recorder.snapshot();
      recorder.elapsedTotal();
    }
    micro.push((performance.now() - started) / ITERATIONS);
  }
  const microStats = stats(micro);
  console.log('\ndiagnostics: the recorder, the record, and repeated requests');
  console.log(`  one request-shaped workload (16 stages, 8 measured): ${us(microStats.median)} median per request, `
    + `${us(microStats.min)} min, ${us(microStats.max)} max, ${microStats.n} runs of ${ITERATIONS} workloads`);
  console.log('  (timed in isolation; the request path has one recorder, created per request)');

  const sizes = [];
  for (let i = 0; i < 50; i += 1) {
    const r = await app.controller.handle('please check the bench tag');
    sizes.push(JSON.stringify(r.operation.diagnostics).length);
  }
  const s = stats(sizes);
  console.log(`  record size over 50 replies: ${s.min}..${s.max} bytes, median ${s.median}`);
  const shapeKeys = Object.keys((await app.controller.handle(QUESTION)).operation.diagnostics ?? {});
  console.log(`  record keys: ${shapeKeys.join(', ')}`);
  console.log('  the record holds stage ids, outcomes, durations, counts, bounded failure/retry/cancellation');
  console.log('  statements, and authorizes:false; it holds no request text, model text, or evidence text.');

  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 100; i += 1) await app.controller.handle('please check the bench tag');
  const after = process.memoryUsage().heapUsed;
  console.log(`  heapUsed across 100 further requests: ${(before / 1048576).toFixed(1)} -> ${(after / 1048576).toFixed(1)} MiB `
    + '(garbage collection is not forced, so this is an observation, not a leak measurement)');
  if (!Number.isFinite(before) || !Number.isFinite(after)) console.log('  heap readings unavailable in this runtime');
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node benchmarks/run-cognitive-runtime-benchmark.mjs [--repeats R] [--phase answer|proposal|handoff|executive|diagnostics|all] [--keep]');
  console.log('  network-free; deterministic in-process model fixture; writes only into a fresh temporary directory; not part of npm test');
} else {
  console.log(`node ${process.version} on ${process.platform} ${process.arch}, `
    + `${os.cpus().length} logical CPU(s), ${Math.round(os.totalmem() / 1073741824)} GiB reported memory; repeats ${opts.repeats}`);
  console.log('No inference is run and no network is used: the model is an in-process fixture object, and the');
  console.log('retry row injects a fetch implementation that fails once and answers locally. Fixtures are written');
  console.log('through the stores\' own validated write paths into a fresh temporary data directory.');
  try {
    if (opts.phase === 'all' || opts.phase === 'answer') await phaseAnswer(opts);
    if (opts.phase === 'all' || opts.phase === 'proposal') await phaseProposal(opts);
    if (opts.phase === 'all' || opts.phase === 'handoff') await phaseHandoff(opts);
    if (opts.phase === 'all' || opts.phase === 'executive') await phaseExecutive(opts);
    if (opts.phase === 'all' || opts.phase === 'diagnostics') await phaseDiagnostics(opts);
  } finally {
    if (opts.keep) {
      console.log(`\nkept: ${dirs.join(', ')}`);
    } else {
      for (const dir of dirs) removeDir(dir);
      console.log('\ntemporary data directories removed; nothing outside them was written.');
    }
  }
}
