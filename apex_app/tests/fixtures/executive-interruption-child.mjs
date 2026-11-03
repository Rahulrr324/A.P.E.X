// TEST FIXTURE for the AG interruption scenario: a real APEX process that is terminated while
// it is inside a plan step. Spawned by tests/executive-interruption.test.js and by nothing else.
//
//   node executive-interruption-child.mjs <data dir> <side-effect file>
//
// It records a goal, starts it, attaches an approved two-step plan, and activates the plan.
// The first step finishes; the second appends one line to the side-effect file, prints READY,
// and never returns, so the parent can terminate the process at a point the records define:
// the task log already holds that step as running and its side effect has happened once.
//
// TEST FIXTURE: `probe.ok` and `probe.block` are not real actions. They are deterministic
// readers that leave an observable line; nothing here is evidence about a real action or model.
import fs from 'node:fs';
import { createApp } from '../../src/app.js';
import { CAPTURE_OFF } from '../../src/experience/capture.js';
import { Outcome } from '../../src/outcomes.js';

const [dataDir, effectFile] = process.argv.slice(2);
if (!dataDir || !effectFile) {
  process.stderr.write('usage: executive-interruption-child.mjs <dataDir> <effectFile>\n');
  process.exit(2);
}

const actions = [
  {
    name: 'probe.ok',
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
    description: 'fixture read step that starts and never finishes',
    inputHint: '{}',
    permission: 'read',
    origins: ['user', 'model'],
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

function fail(label, res) {
  process.stderr.write(`${label}: ${res.status} ${res.display ?? res.output ?? ''}\n`);
  process.exit(1);
}

const app = createApp({ dataDir, experienceCapture: CAPTURE_OFF, extraActions: actions });

const goal = await app.controller.goalAdd({
  request: 'the interrupted executive goal',
  criteria: ['the probe steps complete'],
});
if (goal.status !== Outcome.GOAL_CREATED) fail('goal', goal);
const goalId = goal.operation.steps[0].result.data.goalId;
const accepted = await app.controller.goalUpdate({ target: goalId, status: 'accepted' });
if (accepted.status !== Outcome.GOAL_UPDATED) fail('goal accept', accepted);
const active = await app.controller.goalUpdate({ target: goalId, status: 'active' });
if (active.status !== Outcome.GOAL_UPDATED) fail('goal activate', active);

const planned = await app.controller.planAdd({
  goalId,
  outcome: 'the probe steps complete',
  steps: [
    {
      id: 's1',
      description: 'read once and record it',
      action: 'probe.ok',
      input: { tag: 'probe-1' },
      dependsOn: [],
      expectedResult: 'the read is recorded once',
      verification: 'the side-effect file holds the read',
      risk: 'low',
    },
    {
      id: 's2',
      description: 'start a read that never returns',
      action: 'probe.block',
      input: {},
      dependsOn: ['s1'],
      expectedResult: 'the read answers',
      verification: 'the read verifies',
      risk: 'low',
    },
  ],
  assertions: [],
});
if (planned.status !== Outcome.PLAN_STORED) fail('plan', planned);
const planId = planned.operation.steps[0].result.data.planId;
const approved = await app.controller.planApprove({ target: planId });
if (approved.status !== Outcome.PLAN_STORED) fail('plan approval', approved);

// The parent terminates this process inside s2; under normal execution this never returns.
const activated = await app.controller.planActivate(planId, { mode: 'run' });
fail('activation returned instead of blocking', activated);
