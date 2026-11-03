// TEST FIXTURE for scenario E: a real APEX process that is terminated after it created the
// task for an approved plan but before the activation record was written. Spawned only by
// tests/executive-reliability.test.js.
//
//   node executive-orphan-task-child.mjs <data dir>
//
// The plan step is the built-in, read-only memory.list action, so the command uses the same
// registry as any other process. `plans.activate` is wrapped in this fixture to print READY and
// never return; the parent terminates the process there. The task it created is therefore a real
// task record produced by the real activation path.
import { createApp } from '../../src/app.js';
import { CAPTURE_OFF } from '../../src/experience/capture.js';
import { Outcome } from '../../src/outcomes.js';

const [dataDir] = process.argv.slice(2);
if (!dataDir) {
  process.stderr.write('usage: executive-orphan-task-child.mjs <dataDir>\n');
  process.exit(2);
}

function fail(label, res) {
  process.stderr.write(`${label}: ${res.status} ${res.display ?? res.output ?? ''}\n`);
  process.exit(1);
}

const app = createApp({ dataDir, experienceCapture: CAPTURE_OFF });

const goal = await app.controller.goalAdd({
  request: 'the orphan task goal',
  criteria: ['the list is returned'],
});
if (goal.status !== Outcome.GOAL_CREATED) fail('goal', goal);
const goalId = goal.operation.steps[0].result.data.goalId;
const accepted = await app.controller.goalUpdate({ target: goalId, status: 'accepted' });
if (accepted.status !== Outcome.GOAL_UPDATED) fail('goal accept', accepted);
const active = await app.controller.goalUpdate({ target: goalId, status: 'active' });
if (active.status !== Outcome.GOAL_UPDATED) fail('goal activate', active);

const planned = await app.controller.planAdd({
  goalId,
  outcome: 'the list is returned',
  steps: [{
    id: 's1',
    description: 'list the stored memory',
    action: 'memory.list',
    input: { limit: 5 },
    dependsOn: [],
    expectedResult: 'a bounded list is returned',
    verification: 'the list read succeeds',
    criterion: 'c1',
    risk: 'low',
  }],
});
if (planned.status !== Outcome.PLAN_STORED) fail('plan', planned);
const planId = planned.operation.steps[0].result.data.planId;
const approved = await app.controller.planApprove({ target: planId });
if (approved.status !== Outcome.PLAN_STORED) fail('plan approval', approved);

// The task exists at this point; the next call would record the activation.
app.plans.activate = async () => {
  process.stdout.write('READY\n');
  setInterval(() => {}, 500);
  await new Promise(() => {});
};

const activated = await app.controller.planActivate(planId, { mode: 'run' });
fail('activation returned instead of blocking', activated);
