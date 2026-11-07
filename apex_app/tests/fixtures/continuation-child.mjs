// Test fixture for Batch AM work package D: a real APEX process that is stopped at one of the eight
// interruption boundaries of a plan run. Spawned by tests/plan-continuation.test.js and by nothing else.
//
//   continuation-child.mjs <boundary> <dataDir> <effectFile> [planShape]
//
// The plan's steps name two fixture capabilities that go through the ordinary action path -
// authorization, execution, verification, audit - so what each boundary leaves behind is the bytes a
// real interruption leaves behind, not a description of them.
//
// `probe.note` is a write: it appends one line to the side-effect file, and its verifier re-reads the
// file. `probe.peek` is a read: it appends a line prefixed `read:` and its verifier re-reads that.
// The side-effect file is therefore the observable answer to "did this step happen", which is the
// question a continuation has to decide without inventing an answer.
//
// TEST FIXTURE: `probe.note` and `probe.peek` are not real actions. Nothing here is evidence about a
// real capability's behaviour, and no model is contacted: the gateway is the no-backend one.
import fs from 'node:fs';
import { createApp } from '../../src/app.js';
import { NoBackend, ModelGateway } from '../../src/model/gateway.js';
import { CAPTURE_OFF } from '../../src/experience/capture.js';
import { Outcome } from '../../src/outcomes.js';
import { StepStatus } from '../../src/tasks/model.js';
import { makeTempDataDir } from '../helpers.js';

const [boundary, dataDir, effectFile, planShape = 'independent'] = process.argv.slice(2);
if (!boundary || !dataDir || !effectFile) {
  process.stderr.write('usage: continuation-child.mjs <boundary> <dataDir> <effectFile> [shape]\n');
  process.exit(2);
}

function report(obj) {
  // Synchronous, because the process exits immediately afterwards; a buffered write could be lost.
  fs.writeSync(1, `RESULT ${JSON.stringify(obj)}\n`);
}
function stop(at, extra = {}) {
  // The plan id is in every report, including the ones raised from inside a step: the second process
  // has to name the plan whose run it is reading, and a boundary that stopped mid-run would otherwise
  // leave it with a task id and no plan.
  report({ boundary, planId, stoppedAt: at, ...extra });
  process.exit(9);
}

const effect = (line) => fs.appendFileSync(effectFile, `${line}\n`);
const effects = () => (fs.existsSync(effectFile)
  ? fs.readFileSync(effectFile, 'utf8').split('\n').filter((l) => l.trim() !== '')
  : []);

function probeAction(name, permission, description, mark) {
  return {
    name,
    description,
    inputHint: '{"tag":"text"}',
    permission,
    // The registry refuses a write action offered to the model origin, so the fixture obeys the same
    // rule a real capability obeys: only the read is offered there.
    origins: permission === 'write' ? ['user'] : ['user', 'model'],
    validate: (input) => ({ tag: String(input?.tag ?? 'x').trim() }),
    async execute(_ctx, input) {
      // Boundary 4: the effect happens and the process never returns from the action.
      if (boundary === 'during-execution') {
        effect(mark(input.tag));
        stop('during-action-execution', { tag: input.tag });
      }
      effect(mark(input.tag));
      return { summary: `${name} ${input.tag}`, data: { tag: input.tag, effect: mark(input.tag) } };
    },
    async verify(_ctx, input, result) {
      // Boundary 5: the action returned, and the verifier never got to re-read it.
      if (boundary === 'after-execution-before-verification') {
        stop('before-verification', { tag: input.tag });
      }
      const want = mark(String(input?.tag ?? result?.data?.tag ?? ''));
      return effects().includes(want)
        ? { ok: true, detail: `the side-effect file holds ${want}` }
        : { ok: false, detail: `the side-effect file holds no ${want}` };
    },
  };
}

const app = await createApp({
  dataDir,
  now: () => new Date('2026-11-05T09:00:00.000Z'),
  gateway: new ModelGateway({ backend: new NoBackend() }),
  experienceCapture: CAPTURE_OFF,
  extraActions: [
    probeAction('probe.note', 'write', 'fixture write that leaves one observable line behind', (tag) => tag),
    probeAction('probe.peek', 'read', 'fixture read that leaves one observable line behind', (tag) => `read:${tag}`),
  ],
});

const data = (res) => res?.operation?.steps?.[0]?.result?.data ?? res?.data ?? {};
const need = (res) => {
  if (res.status !== Outcome.SUCCESS_VERIFIED && res.status !== Outcome.PLAN_STORED
    && res.status !== Outcome.GOAL_CREATED && res.status !== Outcome.GOAL_UPDATED) {
    report({ boundary, failed: res.status, output: String(res.output ?? res.display ?? '').slice(0, 400) });
    process.exit(8);
  }
};

const created = await app.controller.goalAdd({
  request: 'put the AM continuation notes in the record',
  criteria: [
    { description: 'the first note is recorded', basis: 'user_stated' },
    { description: 'the second note is recorded', basis: 'user_stated' },
  ],
});
need(created);
const goalId = data(created).goalId;
for (const status of ['accepted', 'active']) need(await app.controller.goalUpdate({ target: goalId, status }));

// Shape `independent`: s1 and s2 are separate branches, so a step that stopped says nothing about
// whether the other may be taken up. Shape `dependent`: s2 waits for s1, so it may not.
const steps = planShape === 'dependent'
  ? [
    { id: 's1', description: 'record the first note', action: 'probe.note', input: { tag: 'note-1' }, dependsOn: [], expectedResult: 'the line is in the file', verification: 'the file is re-read', risk: 'medium', criterionId: 'c1' },
    { id: 's2', description: 'peek at the second note', action: 'probe.peek', input: { tag: 'note-2' }, dependsOn: ['s1'], expectedResult: 'the line is in the file', verification: 'the file is re-read', risk: 'low', criterionId: 'c2' },
  ]
  : [
    { id: 's1', description: 'record the first note', action: 'probe.note', input: { tag: 'note-1' }, dependsOn: [], expectedResult: 'the line is in the file', verification: 'the file is re-read', risk: 'medium', criterionId: 'c1' },
    { id: 's2', description: 'peek at the second note', action: 'probe.peek', input: { tag: 'note-2' }, dependsOn: [], expectedResult: 'the line is in the file', verification: 'the file is re-read', risk: 'low', criterionId: 'c2' },
  ];

const add = await app.controller.planAdd({
  goalId, outcome: 'both notes are observable in the side-effect file', steps,
});
need(add);
const planId = data(add).planId;
need(await app.controller.planApprove({ target: planId }));

// Boundary 1: the plan is approved and nothing of a run exists yet.
if (boundary === 'before-step-creation') stop('before-task-creation', { planId });

// Boundary 2: the task and its steps are recorded; no step has been taken up.
if (boundary === 'after-step-creation') {
  const original = app.controller.tasks.run.bind(app.controller.tasks);
  app.controller.tasks.run = async (taskId) => {
    const t = await app.taskStore.get(taskId);
    stop('after-task-creation', { planId, taskId, statuses: t.steps.map((s) => [s.id, s.status]) });
    return original(taskId, { mode: 'run' });
  };
}

// Boundaries 3 and 8: stop on the way through the task log's own transitions, after the event
// asked for is durable.
if (['after-running-recorded', 'between-dependent-steps'].includes(boundary)) {
  const original = app.taskStore.transition.bind(app.taskStore);
  app.taskStore.transition = async (taskId, spec) => {
    const result = await original(taskId, spec);
    const events = spec?.steps ?? [];
    if (boundary === 'after-running-recorded' && events.some((e) => e.to === StepStatus.RUNNING)) {
      const t = await app.taskStore.get(taskId);
      stop('after-step-running-recorded', { taskId, statuses: t.steps.map((s) => [s.id, s.status]) });
    }
    if (boundary === 'between-dependent-steps' && events.some((e) => e.to === StepStatus.COMPLETED)) {
      const t = await app.taskStore.get(taskId);
      stop('between-steps', { taskId, statuses: t.steps.map((s) => [s.id, s.status]) });
    }
    return result;
  };
}

// Boundary 7: the audit line is written and the process stops before the completion event, so the
// task log still holds the step as running while the operation log holds it as verified.
if (boundary === 'after-finalization-before-next-step') {
  const original = app.operations.append.bind(app.operations);
  let stopped = false;
  app.operations.append = async (record) => {
    const result = await original(record);
    if (!stopped) {
      stopped = true;
      stop('after-audit-append', { operationId: record.id });
    }
    return result;
  };
}

// Boundary 6: verification passed and the audit append never started, so the effect and the
// verification are unrecorded and the step stays where the task log left it.
if (boundary === 'after-verification-before-finalization') {
  app.operations.append = async () => stop('before-audit-append');
}

const start = await app.controller.planActivate(planId, { mode: 'run' });
report({
  boundary,
  planId,
  startStatus: start.status,
  effects: effects(),
  task: start.task?.status ?? null,
});
process.exit(start.status === Outcome.SUCCESS_VERIFIED ? 0 : 7);
