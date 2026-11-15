// Deterministic capability evaluation. Thirteen scenario classes are run through the real
// controller against isolated data directories; no model is consulted, and the only model
// used is a fixture that speaks the HTTP protocol so the authorization path can be exercised.
//
// Each scenario records what it expected, what actually happened, and a check per metric.
// A metric a scenario does not exercise is null rather than a pass: a request that never
// plans anything says nothing about planning correctness, and counting it as a success would
// inflate that number. The metrics are reported separately and are never combined into one
// score - they measure different promises, and a single number would hide which one moved.
//
// This suite is not a real-world intelligence benchmark. Its fixtures are synthetic, its
// answers are deterministic, and it says nothing about how a language model would behave.
import fs from 'node:fs';
import path from 'node:path';
import { Outcome } from '../outcomes.js';
import { Decision } from '../controller/decision.js';
import { TaskStatus, StepStatus } from '../tasks/model.js';

export const METRICS = Object.freeze([
  'task_success',
  'planning_correctness',
  'evidence_correctness',
  'safety_compliance',
  'recovery_correctness',
  'usability',
]);

export const SCENARIO_CLASSES = Object.freeze([
  'single-action',
  'multi-step-composed',
  'missing-input-clarification',
  'contradictory-evidence',
  'unsupported-request',
  'authorization-denial',
  'execution-failure',
  'interrupted-recovery',
  'partial-success',
  'outcome-verification',
  'user-correction',
  'repeated-request-idempotency',
  'context-continuity',
]);

const check = (ok, expected, actual) => ({ ok: Boolean(ok), expected, actual });
const has = (text, re) => typeof text === 'string' && re.test(text);

function opsOf(dataDir) {
  const file = path.join(dataDir, 'operations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function turnsOf(dataDir) {
  const file = path.join(dataDir, 'conversation.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function taskEvents(dataDir) {
  const file = path.join(dataDir, 'tasks.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

const stepOps = (dataDir) => opsOf(dataDir).filter((r) => r.capability === 'task.step');

const statusOf = (steps, id) => steps.find((s) => s.id === id)?.status ?? 'missing';

// A user-facing answer is bounded, non-empty, and states the thing the question needed. Raw
// store dumps are excluded by length; the informative phrases are the scenario's own.
function usable(display, phrases) {
  const bounded = typeof display === 'string' && display.length > 0 && display.length <= 4000;
  const informative = phrases.every((re) => has(display, re));
  return check(bounded && informative, `an answer of at most 4000 chars matching ${phrases.map(String).join(', ')}`, `length ${typeof display === 'string' ? display.length : 'none'}`);
}

export const SCENARIOS = [
  {
    id: 's01',
    class: 'single-action',
    title: 'one supported request runs once and is verified',
    async run(kit) {
      const { app, dataDir } = await kit.fixture();
      const res = await app.controller.handle('calc 2+2');
      const ops = opsOf(dataDir);
      const calc = ops.filter((r) => r.capability === 'calc.evaluate');
      return {
        expected: { status: Outcome.SUCCESS_VERIFIED, executed: ['calc.evaluate'], modelCalls: 0 },
        actual: { status: res.status, executed: ops.map((r) => r.capability), modelCalls: 0 },
        checks: {
          task_success: check(res.status === Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, res.status),
          planning_correctness: null,
          evidence_correctness: check(calc.length === 1 && calc[0].status === Outcome.SUCCESS_VERIFIED, 'one calc.evaluate record, success_verified', `${calc.length} record(s), ${calc[0]?.status}`),
          safety_compliance: check(calc.length === 1 && ops.length === 1, 'exactly one read action ran', `${ops.length} operation(s)`),
          recovery_correctness: null,
          usability: usable(res.display, [/2\s*\+\s*2\s*=\s*4/]),
        },
      };
    },
  },
  {
    id: 's02',
    class: 'multi-step-composed',
    title: 'two supported parts become one ordered task that runs both steps',
    async run(kit) {
      const { app, dataDir } = await kit.fixture();
      const res = await app.controller.handle('calc 2+2; calc 3+3');
      const [task] = await app.taskStore.list();
      const steps = task?.steps ?? [];
      const names = steps.map((s) => s.action);
      return {
        expected: { status: Outcome.SUCCESS_VERIFIED, steps: ['s1', 's2'], actions: ['calc.evaluate', 'calc.evaluate'], allVerified: true },
        actual: { status: res.status, steps: steps.map((s) => s.id), actions: names, statuses: steps.map((s) => `${s.id}:${s.status}`) },
        checks: {
          task_success: check(res.status === Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, res.status),
          planning_correctness: check(
            steps.length === 2 && steps[0].id === 's1' && steps[1].id === 's2' && names.every((n) => n === 'calc.evaluate'),
            'two steps in request order, each a registered calc.evaluate',
            `${steps.length} step(s), ${names.join(', ') || 'none'}`,
          ),
          evidence_correctness: check(
            steps.every((s) => s.status === StepStatus.COMPLETED && s.outcome === Outcome.SUCCESS_VERIFIED),
            'every step completed with success_verified',
            steps.map((s) => `${s.id}:${s.status}:${s.outcome}`).join(', ') || 'none',
          ),
          safety_compliance: check(stepOps(dataDir).length === 2, 'two step executions, no more', String(stepOps(dataDir).length)),
          recovery_correctness: null,
          usability: usable(res.display, [/4/, /6/]),
        },
      };
    },
  },
  {
    id: 's03',
    class: 'missing-input-clarification',
    title: 'a request missing its input asks for it and runs nothing',
    async run(kit) {
      const { app, dataDir } = await kit.fixture();
      const res = await app.controller.handle('recall');
      const ops = opsOf(dataDir);
      const taskCount = (await app.taskStore.list()).length;
      return {
        expected: { status: Outcome.CLARIFICATION_REQUIRED, asksFor: 'search topic', tasks: 0, executions: 0 },
        actual: { status: res.status, tasks: taskCount, operations: ops.map((r) => `${r.capability}:${r.status}`), display: res.display },
        checks: {
          task_success: check(res.status === Outcome.CLARIFICATION_REQUIRED, Outcome.CLARIFICATION_REQUIRED, res.status),
          // The right plan for a request with no topic is none: the question comes before any
          // plan, and a plan recorded here would have to invent the missing input.
          planning_correctness: check(taskCount === 0, 'no task or plan for an under-specified request', `${taskCount} task(s)`),
          evidence_correctness: check(ops.length === 1 && ops[0].status === Outcome.CLARIFICATION_REQUIRED, 'one audited clarification record, no execution', ops.map((r) => r.status).join(', ') || 'none'),
          safety_compliance: check(taskCount === 0 && stepOps(dataDir).length === 0, 'nothing was planned or run', `${taskCount} task(s), ${stepOps(dataDir).length} step execution(s)`),
          recovery_correctness: null,
          usability: usable(res.display, [/topic/, /memory/]),
        },
      };
    },
  },
  {
    id: 's04',
    class: 'contradictory-evidence',
    title: 'a damaged audit log is not reported as proof that no record exists',
    async run(kit) {
      const { app, dataDir } = await kit.fixture();
      const ran = await app.controller.handle('calc 2+2; calc 3+3');
      fs.writeFileSync(path.join(dataDir, 'operations.jsonl'), 'not json\n');
      const asked = await app.controller.handle('what happened to that task?');
      return {
        expected: { runStatus: Outcome.SUCCESS_VERIFIED, answerStatus: Outcome.SUCCESS_VERIFIED, namesDamage: true, claimsAbsence: false },
        actual: { runStatus: ran.status, answerStatus: asked.status },
        checks: {
          task_success: check(asked.status === Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, asked.status),
          planning_correctness: null,
          evidence_correctness: check(has(asked.display, /damaged line/), 'the damaged log is named as damage', 'see display'),
          safety_compliance: check(!has(asked.display, /no operation record is available/), 'damage is not turned into proven absence', 'see display'),
          recovery_correctness: null,
          usability: usable(asked.display, [/cannot establish|damaged/]),
        },
      };
    },
  },
  {
    id: 's05',
    class: 'unsupported-request',
    title: 'a request for an unregistered capability is answered from the registry, not invented',
    async run(kit) {
      const { app, dataDir } = await kit.fixture();
      const res = await app.controller.handle('what can you do about teleporting?');
      const ops = opsOf(dataDir);
      const capability = ops.find((r) => r.capability === 'app.capabilities');
      const step = capability?.steps?.[0];
      return {
        expected: { status: Outcome.SUCCESS_VERIFIED, capability: 'app.capabilities', matched: 0, modelCalls: 0 },
        actual: { status: res.status, matched: step?.result?.data?.matched ?? null },
        checks: {
          task_success: check(res.status === Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, res.status),
          planning_correctness: check(step?.result?.data?.matched === 0, 'zero registered actions match, so no plan is invented', String(step?.result?.data?.matched ?? null)),
          evidence_correctness: check(has(res.display, /No registered action matches|0 of \d+ registered action/), 'the answer says nothing matches', 'see display'),
          safety_compliance: check(ops.length === 1 && stepOps(dataDir).length === 0, 'only the registry read ran', `${ops.length} operation(s)`),
          recovery_correctness: null,
          usability: usable(res.display, [/registered action/]),
        },
      };
    },
  },
  {
    id: 's06',
    class: 'authorization-denial',
    title: 'a model proposal to write is denied and nothing is stored',
    async run(kit) {
      const { app, dataDir, stub } = await kit.fixture({
        reply: [
          'I will record that.',
          'PROPOSE_ACTION {"action":"memory.add","input":{"content":"written on model authority"}}',
        ].join('\n'),
      });
      const res = await app.controller.handle('please note that the invoice is due on friday');
      const memory = await app.memory.list({ limit: 50 });
      const writeStep = res.operation?.steps?.find((s) => s.action === 'memory.add');
      return {
        expected: { decision: Decision.REFUSE_OR_BLOCK, stepOutcome: Outcome.ACTION_DENIED, memory: 0, modelCalls: 1 },
        actual: { decision: res.decision, stepOutcome: writeStep?.outcome ?? null, memory: memory.length, modelCalls: stub.requests.length },
        checks: {
          task_success: check(res.decision === Decision.REFUSE_OR_BLOCK, Decision.REFUSE_OR_BLOCK, res.decision),
          planning_correctness: null,
          evidence_correctness: check(writeStep?.origin === 'model', 'the denied step is recorded as model origin', String(writeStep?.origin ?? null)),
          safety_compliance: check(memory.length === 0 && writeStep?.outcome === Outcome.ACTION_DENIED, 'no memory record and an ACTION_DENIED step', `${memory.length} memory record(s), ${writeStep?.outcome}`),
          recovery_correctness: null,
          usability: usable(res.display, [/denied|not permitted|authoriz/i]),
        },
      };
    },
  },
  {
    id: 's07',
    class: 'execution-failure',
    title: 'a failing step stops the task and is not reported as verified',
    async run(kit) {
      const { app, dataDir } = await kit.fixture();
      const res = await app.controller.handle('calc 10/2; calc 1/0');
      const [task] = await app.taskStore.list();
      const steps = task?.steps ?? [];
      return {
        expected: { status: Outcome.EXECUTION_FAILED, s1: 'completed', s2: 'failed', noVerifiedFailure: true },
        actual: { status: res.status, s1: statusOf(steps, 's1'), s2: statusOf(steps, 's2'), s2Outcome: steps.find((s) => s.id === 's2')?.outcome ?? null },
        checks: {
          task_success: check(res.status === Outcome.EXECUTION_FAILED, Outcome.EXECUTION_FAILED, res.status),
          planning_correctness: check(steps.length === 2, 'a two-step plan', `${steps.length} step(s)`),
          evidence_correctness: check(
            statusOf(steps, 's1') === StepStatus.COMPLETED && statusOf(steps, 's2') === StepStatus.FAILED && steps.find((s) => s.id === 's2')?.outcome !== Outcome.SUCCESS_VERIFIED,
            's1 completed, s2 failed with a non-success outcome',
            `s1:${statusOf(steps, 's1')} s2:${statusOf(steps, 's2')}:${steps.find((s) => s.id === 's2')?.outcome}`,
          ),
          safety_compliance: check(stepOps(dataDir).length === 2, 'the plan stopped at the failure', `${stepOps(dataDir).length} step execution(s)`),
          recovery_correctness: null,
          usability: usable(res.display, [/s2/, /fail/i]),
        },
      };
    },
  },
  {
    id: 's08',
    class: 'interrupted-recovery',
    title: 'after a lost transition, resume keeps the completed step and runs only the rest',
    async run(kit) {
      const { app, dataDir } = await kit.fixture();
      const planned = await app.controller.planTask('calc 2+2; calc 3+3');
      const task = planned.task;
      const original = app.taskStore.transition.bind(app.taskStore);
      let injected = false;
      app.taskStore.transition = async (id, event) => {
        if (!injected && event.steps?.some((s) => s.to === 'completed')) {
          injected = true;
          throw new Error('simulated process loss after the first step was audited');
        }
        return original(id, event);
      };
      let lost = false;
      try { await app.controller.runTask(task.id, 'run'); } catch { lost = true; }
      app.taskStore.transition = original;
      const resumed = await app.controller.runTask(task.id, 'resume');
      const final = await app.taskStore.get(task.id);
      const executions = stepOps(dataDir).length;
      return {
        expected: { interrupted: true, resumeStatus: Outcome.SUCCESS_VERIFIED, s1: 'completed', s2: 'completed', executions: 2 },
        actual: { interrupted: lost, resumeStatus: resumed.status, s1: final.steps[0].status, s2: final.steps[1].status, executions },
        checks: {
          task_success: check(lost && resumed.status === Outcome.SUCCESS_VERIFIED, 'the interruption happens and resume completes the task', `${lost}/${resumed.status}`),
          planning_correctness: null,
          evidence_correctness: check(final.steps.every((s) => s.status === StepStatus.COMPLETED && s.outcome === Outcome.SUCCESS_VERIFIED), 'both steps verified', final.steps.map((s) => `${s.id}:${s.status}`).join(', ')),
          safety_compliance: check(executions === 2, 'each step ran exactly once', `${executions} step execution(s)`),
          recovery_correctness: check(final.steps[0].status === StepStatus.COMPLETED && executions === 2, 'the completed step was not re-run', `${executions} step execution(s)`),
          usability: usable(resumed.display, [/s2|3\s*\+\s*3|6/]),
        },
      };
    },
  },
  {
    id: 's09',
    class: 'partial-success',
    title: 'work that partly ran is reported as partial, with the unfinished step named',
    async run(kit) {
      const { app } = await kit.fixture();
      const ran = await app.controller.handle('calc 2+2; calc 1/0; calc 3+3');
      const [task] = await app.taskStore.list();
      const steps = task?.steps ?? [];
      const finished = await app.controller.handle('did it finish?');
      const pending = await app.controller.handle('what is still pending?');
      return {
        expected: { runStatus: Outcome.EXECUTION_FAILED, s3: 'skipped', finishedSaysPartial: true, pendingNamesS3: true },
        actual: { runStatus: ran.status, s1: statusOf(steps, 's1'), s2: statusOf(steps, 's2'), s3: statusOf(steps, 's3') },
        checks: {
          task_success: check(ran.status === Outcome.EXECUTION_FAILED, Outcome.EXECUTION_FAILED, ran.status),
          planning_correctness: check(steps.length === 3, 'a three-step plan', `${steps.length} step(s)`),
          evidence_correctness: check(has(finished.display, /1 of 3 step\(s\) were verified/) && has(finished.display, /stopped before finishing at s2/), 'the answer states 1 of 3 verified and where it stopped', 'see display'),
          safety_compliance: check(statusOf(steps, 's3') === StepStatus.SKIPPED, 'the dependent step did not run', statusOf(steps, 's3')),
          recovery_correctness: null,
          usability: usable(pending.display, [/s3/]),
        },
      };
    },
  },
  {
    id: 's10',
    class: 'outcome-verification',
    title: 'a verified step is not presented as the goal having been achieved',
    async run(kit) {
      const { app } = await kit.fixture();
      const ran = await app.controller.handle('calc 2+2; calc 3+3');
      const asked = await app.controller.handle('what did that achieve?');
      return {
        expected: { runStatus: Outcome.SUCCESS_VERIFIED, answerStatus: Outcome.SUCCESS_VERIFIED, achieved: 'not established' },
        actual: { runStatus: ran.status, answerStatus: asked.status },
        checks: {
          task_success: check(asked.status === Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, asked.status),
          planning_correctness: null,
          evidence_correctness: check(has(asked.display, /^Achieved: not established - /m), 'achievement is not established by a verified step', 'see display'),
          safety_compliance: check(!has(asked.display, /is recorded as (?:completed|successful)/), 'no record is claimed that does not exist', 'see display'),
          recovery_correctness: null,
          usability: usable(asked.display, [/Intended: calc 2\+2; calc 3\+3/, /Executed: 2 of 2/]),
        },
      };
    },
  },
  {
    id: 's11',
    class: 'user-correction',
    title: 'a user correction is recorded as user-confirmed and the original is kept',
    async run(kit) {
      const { app, dataDir } = await kit.fixture();
      await app.controller.handle('remember that my favourite colour is blue');
      const original = (await app.memory.search('favourite colour'))[0].record;
      const corrected = await app.controller.correctMemory({
        targetId: original.id,
        content: 'my favourite colour is green',
        resolve: true,
      });
      const correctionId = corrected.operation?.steps?.[0]?.result?.data?.id ?? null;
      const correction = correctionId ? await app.memory.get(correctionId) : null;
      const hits = await app.memory.search('favourite colour', { limit: 10 });
      const provenance = correction?.provenance?.origin ?? null;
      const oldState = hits.find((h) => h.record.id === original.id)?.status ?? 'missing';
      return {
        expected: { status: Outcome.SUCCESS_VERIFIED, provenance: 'user_memory_correction', original: 'superseded', modelCalls: 0 },
        actual: { status: corrected.status, provenance, original: oldState, modelCalls: 0 },
        checks: {
          task_success: check(corrected.status === Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, corrected.status),
          planning_correctness: null,
          evidence_correctness: check(provenance === 'user_memory_correction' && oldState === 'superseded', 'the correction carries user-confirmed provenance and the original stays as superseded', `${provenance}/${oldState}`),
          safety_compliance: check(opsOf(dataDir).every((r) => r.origin === 'user'), 'every write in this scenario is user origin', opsOf(dataDir).map((r) => r.origin).join(', ')),
          recovery_correctness: null,
          usability: usable(corrected.display, [/correction|corrects/]),
        },
      };
    },
  },
  {
    id: 's12',
    class: 'repeated-request-idempotency',
    title: 'repeating a resume of a failed task changes no task state and runs nothing',
    async run(kit) {
      const { app, dataDir } = await kit.fixture();
      await app.controller.handle('calc 2+2; calc 1/0');
      const [task] = await app.taskStore.list();
      const eventsBefore = taskEvents(dataDir);
      const executionsBefore = stepOps(dataDir).length;
      const first = await app.controller.runTask(task.id, 'resume');
      const second = await app.controller.runTask(task.id, 'resume');
      const eventsAfter = taskEvents(dataDir);
      const executionsAfter = stepOps(dataDir).length;
      return {
        expected: { first: Outcome.INPUT_REJECTED, second: Outcome.INPUT_REJECTED, events: 'unchanged', executions: 'unchanged' },
        actual: { first: first.status, second: second.status, events: `${eventsBefore}->${eventsAfter}`, executions: `${executionsBefore}->${executionsAfter}` },
        checks: {
          task_success: check(first.status === Outcome.INPUT_REJECTED && second.status === Outcome.INPUT_REJECTED, 'both repeats are refused', `${first.status}/${second.status}`),
          planning_correctness: null,
          evidence_correctness: null,
          safety_compliance: check(executionsAfter === executionsBefore, 'nothing was executed by the repeats', `${executionsBefore}->${executionsAfter}`),
          recovery_correctness: check(eventsAfter === eventsBefore, 'no task event was written by the repeats', `${eventsBefore}->${eventsAfter}`),
          usability: usable(second.display, [/fail|resume|cannot|refus/i]),
        },
      };
    },
  },
  {
    id: 's13',
    class: 'context-continuity',
    title: 'two follow-ups resolve to the same recorded task without naming it',
    async run(kit) {
      const { app, dataDir } = await kit.fixture();
      const ran = await app.controller.handle('calc 2+2; calc 3+3');
      const [task] = await app.taskStore.list();
      const first = await app.controller.handle('did it finish?');
      const second = await app.controller.handle('which steps succeeded?');
      const turns = turnsOf(dataDir).filter((t) => t.taskId);
      const ids = new Set(turns.map((t) => t.taskId));
      return {
        expected: { runStatus: Outcome.SUCCESS_VERIFIED, first: Outcome.SUCCESS_VERIFIED, second: Outcome.SUCCESS_VERIFIED, sameTask: task.id },
        actual: { runStatus: ran.status, first: first.status, second: second.status, turns: [...ids] },
        checks: {
          task_success: check(first.status === Outcome.SUCCESS_VERIFIED && second.status === Outcome.SUCCESS_VERIFIED, 'both follow-ups are answered', `${first.status}/${second.status}`),
          planning_correctness: null,
          evidence_correctness: check(ids.size === 1 && ids.has(task.id), 'the answers name the one recorded task', [...ids].join(', ')),
          safety_compliance: check(stepOps(dataDir).length === 2, 'no follow-up ran a step', `${stepOps(dataDir).length} step execution(s)`),
          recovery_correctness: null,
          usability: usable(`${first.display}\n${second.display}`, [/finished|Verified complete/]),
        },
      };
    },
  },
];

export async function runScenario(scenario, kit) {
  let result;
  try {
    result = await scenario.run(kit);
  } catch (err) {
    return {
      id: scenario.id,
      class: scenario.class,
      title: scenario.title,
      expected: 'the scenario completes without an exception',
      actual: `${err.code ?? 'ERROR'}: ${err.message}`,
      checks: Object.fromEntries(METRICS.map((m) => [m, check(false, 'the scenario completes', `threw ${err.message}`)])),
    };
  }
  const failed = METRICS.filter((m) => result.checks[m] && !result.checks[m].ok);
  return { id: scenario.id, class: scenario.class, title: scenario.title, ...result, failed, pass: failed.length === 0 };
}

export async function runCapabilityEvaluation(kit) {
  const results = [];
  for (const scenario of SCENARIOS) results.push(await runScenario(scenario, kit));
  return { results, metrics: summarizeMetrics(results), passed: results.filter((r) => r.pass).length, total: results.length };
}

export function summarizeMetrics(results) {
  const out = {};
  for (const metric of METRICS) {
    let passed = 0;
    let total = 0;
    for (const result of results) {
      const c = result.checks?.[metric];
      if (!c) continue;
      total += 1;
      if (c.ok) passed += 1;
    }
    out[metric] = { passed, total, rate: total > 0 ? passed / total : null };
  }
  return out;
}

export function renderReport(report) {
  const lines = [`Capability evaluation: ${report.passed} of ${report.total} scenario(s) passed.`];
  for (const r of report.results) {
    lines.push(`  ${r.id} ${r.class}: ${r.pass ? 'pass' : `FAIL (${r.failed.join(', ')})`} - ${r.title}`);
  }
  lines.push('', 'Metrics (each measured on the scenarios that exercise it; null is not a pass):');
  for (const metric of METRICS) {
    const m = report.metrics[metric];
    lines.push(`  ${metric.padEnd(22)} ${m.total === 0 ? 'n/a' : `${m.passed}/${m.total}`}`);
  }
  lines.push('', 'Synthetic, deterministic fixtures; this is not a real-world intelligence benchmark.');
  return lines.join('\n');
}
