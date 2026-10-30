// Test fixture for Implementation 055: a real APEX process that is terminated while it is
// inside a step. Spawned by tests/process-recovery.test.js and by nothing else.
//
//   node interrupted-run-child.mjs <data dir> <side-effect file>
//
// It works through the ordinary controller path: a two-step plan, the user's approval of the
// plan, a run that holds the write step for its own approval, that approval, and a resume. The
// approved write step appends one line to the side-effect file, prints READY, and then never
// returns - so the parent can terminate this process at a point the records themselves define
// (the step is recorded as running before it executes, so READY means the task log holds that
// step as running and its side effect has already happened exactly once).
//
// TEST FIXTURE: `probe.finish` and `probe.block` are not real actions, and the side-effect file
// is what they observably did. Nothing here is evidence about a real action or a real model.
import fs from 'node:fs';
import { createApp } from '../../src/app.js';
import { Outcome } from '../../src/outcomes.js';
import { makePlanGateway, taskStep } from '../helpers.js';

const [dataDir, effectFile] = process.argv.slice(2);
if (!dataDir || !effectFile) {
  process.stderr.write('usage: interrupted-run-child.mjs <dataDir> <effectFile>\n');
  process.exit(2);
}

const actions = [
  {
    name: 'probe.finish',
    description: 'fixture read step that leaves one observable line behind',
    inputHint: '{"tag":"text"}',
    permission: 'read',
    origins: ['user', 'model'],
    validate: (input) => ({ tag: String(input?.tag ?? 's1') }),
    async execute(_ctx, input) {
      fs.appendFileSync(effectFile, `${input.tag}\n`);
      return { summary: `read ${input.tag}`, data: { tag: input.tag } };
    },
    async verify() {
      return { ok: true, detail: 'the side-effect file holds the read' };
    },
  },
  {
    name: 'probe.block',
    description: 'fixture write step that starts and never finishes',
    inputHint: '{}',
    permission: 'write',
    origins: ['user'],
    validate: (input) => input ?? {},
    async execute() {
      fs.appendFileSync(effectFile, 'block-start\n');
      process.stdout.write('READY\n');
      // A ref'd timer keeps the loop alive while the promise never settles, so the process
      // waits here until the parent terminates it.
      setInterval(() => {}, 500);
      await new Promise(() => {});
    },
    async verify() {
      return { ok: true, detail: 'never reached in this fixture' };
    },
  },
];

const steps = [taskStep('s1', 'probe.finish'), taskStep('s2', 'probe.block', ['s1'])];

function fail(label, res) {
  process.stderr.write(`${label}: ${res.status} ${res.display ?? res.output ?? ''}\n`);
  process.exit(1);
}

const app = createApp({ dataDir, gateway: makePlanGateway(steps), extraActions: actions });

const planned = await app.controller.planTask('run the probe and record what it did');
if (planned.status !== Outcome.PLAN_PROPOSED) fail('plan', planned);
const task = (await app.taskStore.list()).at(-1);
const approved = await app.controller.approveTask(task.id);
if (approved.status !== Outcome.SUCCESS_VERIFIED) fail('plan approval', approved);
const firstRun = await app.controller.runTask(task.id, 'run');
if (firstRun.status !== Outcome.TASK_PAUSED) fail('first run', firstRun);
const stepApproved = await app.controller.approveTask(task.id, { stepId: 's2' });
if (stepApproved.status !== Outcome.SUCCESS_VERIFIED) fail('step approval', stepApproved);

// Resumes into the step that never returns. The parent terminates this process while it waits.
await app.controller.runTask(task.id, 'resume');
