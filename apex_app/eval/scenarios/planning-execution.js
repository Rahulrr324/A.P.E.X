// Planning and execution scenarios: a person records an intention, approves a specific plan, lets
// it run, and expects the result, the plan state, and the goal state to stay distinct.
//
// The checks read controller results and store records a user can inspect. They assert that a plan
// completing is not reported as a goal completing, that a goal needs its own evidence, that a
// failed step blocks the plan instead of being retried invisibly, and that a revision keeps the
// earlier version readable.
import { check } from '../framework.js';
import { outcomeIs, outcomeIn, displayHas, boundedDisplay } from '../oracles.js';

function planSteps(expressions) {
  return expressions.map((expression, index) => ({
    id: `s${index + 1}`,
    description: `Evaluate ${expression}`,
    action: 'calc.evaluate',
    input: { expression },
    dependsOn: index === 0 ? [] : [`s${index}`],
    expectedResult: 'the deterministic arithmetic result is reported and independently verified',
    verification: 'calc.evaluate recomputes the expression by an independent method',
    risk: 'low',
  }));
}

export default [
  {
    id: 'px-01',
    category: 'planning-execution',
    title: 'An approved plan runs and completes without completing its goal',
    intent: 'Record a goal and a linked two-step plan, approve it, run it, and confirm the plan completes while the goal still waits for the user.',
    preconditions: ['an empty goal, plan and task store', 'the calc capability registered'],
    steps: [
      'record a goal with one success criterion',
      'record a linked two-step plan',
      'approve the plan',
      'activate the plan and run it',
      'read the goal afterwards',
    ],
    async run(ctx) {
      const goal = await ctx.act('goalAdd', {
        request: 'Confirm two arithmetic results for the quarterly summary',
        criteria: ['both arithmetic results are verified audit operations'],
      }, 'goal: add');
      const goalId = goal.operation?.steps?.[0]?.result?.data?.goalId ?? null;

      const plan = await ctx.act('planAdd', {
        goalId,
        outcome: 'Two arithmetic results are verified',
        steps: planSteps(['(12+8)*3', '60/4']),
        reason: 'the user asked to confirm two results',
      }, 'plan: add');
      const planId = plan.operation?.steps?.[0]?.result?.data?.planId ?? null;

      const approved = await ctx.act('planApprove', { target: planId }, 'plan: approve');
      const activated = await ctx.call('planActivate', [planId], 'plan: activate');
      const goalAfter = await ctx.call('showGoal', [goalId], 'goal: show after activation');

      const task = activated.task ?? null;
      const steps = task?.steps ?? [];
      const goalStatus = goalAfter.goal?.status ?? null;

      return {
        expected: 'the plan runs to verified completion, the task is completed, and the goal is not marked complete by the plan',
        actual: `plan=${activated.status} task=${task?.status ?? 'none'} planStatus=${activated.planStatus ?? 'none'} goal=${goalStatus}`,
        checks: {
          correctness: check(
            outcomeIn(approved, ['plan_stored', 'success_verified']).ok
              && outcomeIs(activated, 'success_verified').ok,
            'approval is recorded and activation reports verified success',
            `approve=${approved.status} activate=${activated.status}`,
          ),
          completeness: check(
            task?.status === 'completed'
              && steps.length === 2
              && steps.every((step) => step.status === 'completed'),
            'both plan steps complete and the task is completed',
            `${steps.filter((step) => step.status === 'completed').length}/${steps.length} step(s) completed; task ${task?.status ?? 'none'}`,
          ),
          continuity: check(
            activated.planStatus === 'completed',
            'the plan records its own completed state',
            activated.planStatus,
          ),
          safety: check(
            goalStatus !== 'completed' && goalStatus !== null,
            'the goal is not completed by the plan',
            goalStatus,
          ),
          ux: check(
            boundedDisplay(activated, { min: 20 }).ok && displayHas(activated, /Plan status:/).ok,
            'the run report states the plan status and the task result',
            activated.display,
          ),
        },
        metrics: { steps: steps.length, goalStatus, planStatus: activated.planStatus ?? null },
      };
    },
  },

  {
    id: 'px-02',
    category: 'planning-execution',
    title: 'A goal is completed only after its own verified evidence is recorded',
    intent: 'Try to complete a goal before any evidence exists, record verified evidence, accept the goal, then complete it.',
    preconditions: ['one recorded goal with one user-stated criterion', 'one verified audit operation'],
    steps: [
      'record a goal',
      'move it to active',
      'attempt completion before evidence',
      'run an approved plan to produce a verified operation',
      'record that operation as goal evidence',
      'complete the goal',
    ],
    async run(ctx) {
      const goal = await ctx.act('goalAdd', {
        request: 'Prove that APEX can evaluate a small expression and record it',
        criteria: ['a verified calculation operation is recorded'],
      }, 'goal: add');
      const goalData = goal.operation?.steps?.[0]?.result?.data ?? null;
      const goalId = goalData?.goalId ?? null;
      const criterionId = goalData?.criteria?.[0]?.id ?? 'c1';

      await ctx.act('goalUpdate', { target: goalId, status: 'accepted' }, 'goal: accept');
      await ctx.act('goalUpdate', { target: goalId, status: 'active' }, 'goal: activate');

      const early = await ctx.act('goalComplete', { target: goalId }, 'goal: complete too early');

      const plan = await ctx.act('planAdd', {
        goalId,
        outcome: 'One verified arithmetic operation',
        steps: planSteps(['7*6']),
        reason: 'produce the operation the criterion needs',
      }, 'plan: add');
      const planId = plan.operation?.steps?.[0]?.result?.data?.planId ?? null;
      await ctx.act('planApprove', { target: planId }, 'plan: approve');
      const activated = await ctx.call('planActivate', [planId], 'plan: activate');
      const operationId = activated.task?.steps?.[0]?.operationId ?? null;

      const evidence = await ctx.act('goalEvidence', {
        target: goalId,
        criterion: criterionId,
        kind: 'supports',
        operationId,
      }, 'goal: record evidence');
      const completed = await ctx.act('goalComplete', { target: goalId }, 'goal: complete');
      const goalAfter = await ctx.call('showGoal', [goalId], 'goal: show completed');

      return {
        expected: 'completion is refused until the criterion is backed by a verified operation, then succeeds',
        actual: `early=${early.status} evidence=${evidence.status} complete=${completed.status} goal=${goalAfter.goal?.status ?? 'none'}`,
        checks: {
          correctness: check(
            outcomeIn(early, ['execution_failed', 'input_rejected']).ok
              && outcomeIs(completed, 'goal_completed').ok,
            'the early completion is refused and the evidenced completion succeeds',
            `${early.status} then ${completed.status}`,
          ),
          completeness: check(
            goalAfter.goal?.status === 'completed'
              && (goalAfter.goal?.completion?.criteria ?? []).length === 1
              && goalAfter.goal.completion.criteria[0].operationId === operationId,
            'the completed goal cites the verified operation as proof',
            `status=${goalAfter.goal?.status ?? 'none'} cited=${goalAfter.goal?.completion?.criteria?.[0]?.operationId ?? 'none'}`,
          ),
          safety: check(
            /refus|cannot be completed|not satisfied|before completing/i.test(String(early.display ?? '')),
            'the refusal explains why completion was not recorded',
            early.display,
          ),
          ux: check(
            displayHas(goalAfter, /completed/i).ok && boundedDisplay(goalAfter, { min: 10 }).ok,
            'the completed goal is reported clearly',
            goalAfter.display,
          ),
        },
        metrics: { criterionId, operationId },
      };
    },
  },

  {
    id: 'px-03',
    category: 'planning-execution',
    title: 'A failed step stops the plan and leaves it blocked, not successful',
    intent: 'Approve a plan whose second step reads a file that does not exist and confirm the run reports failure and blocks the plan.',
    preconditions: ['an authorized content root with no file at the named path'],
    steps: [
      'record a two-step plan whose second step extracts a missing file',
      'approve the plan',
      'activate and run the plan',
      'read the plan and task afterwards',
    ],
    async run(ctx) {
      const plan = await ctx.act('planAdd', {
        outcome: 'Summarize an existing report',
        steps: [
          {
            id: 's1',
            description: 'Find text files in the workspace',
            action: 'filesystem.find',
            input: { name: 'report' },
            dependsOn: [],
            expectedResult: 'a bounded list of matching files, possibly empty',
            verification: 'the action re-reads the workspace and reports its own result',
            risk: 'low',
          },
          {
            id: 's2',
            description: 'Extract the missing report',
            action: 'filesystem.extract',
            input: { path: 'missing/report.txt' },
            dependsOn: ['s1'],
            expectedResult: 'the report text is extracted',
            verification: 'the action re-reads the extracted file and matches its digest',
            risk: 'low',
          },
        ],
        reason: 'show that a missing input fails honestly',
      }, 'plan: add');
      const planId = plan.operation?.steps?.[0]?.result?.data?.planId ?? null;
      await ctx.act('planApprove', { target: planId }, 'plan: approve');
      const activated = await ctx.call('planActivate', [planId], 'plan: activate');
      const shown = await ctx.call('showPlan', [planId], 'plan: show');

      const task = activated.task ?? null;
      const failed = (task?.steps ?? []).filter((step) => step.status === 'failed');

      return {
        expected: 'the missing file fails its step, the task is failed, and the plan is blocked rather than completed',
        actual: `activate=${activated.status} task=${task?.status ?? 'none'} plan=${activated.planStatus ?? 'none'} failedSteps=${failed.length}`,
        checks: {
          correctness: check(
            activated.status !== 'success_verified' && failed.length === 1,
            'the run does not report verified success and one step failed',
            `${activated.status}; ${failed.length} failed step(s)`,
          ),
          completeness: check(
            task?.status === 'failed' && activated.planStatus === 'blocked',
            'the task is failed and the plan is blocked',
            `task=${task?.status ?? 'none'} plan=${activated.planStatus ?? 'none'}`,
          ),
          safety: check(
            (task?.steps ?? []).filter((step) => step.status === 'completed').length === 1
              && shown.plan?.status === 'blocked',
            'the step before the failure is recorded and the plan is not retried or silently completed',
            `completed=${(task?.steps ?? []).filter((step) => step.status === 'completed').length} storedPlan=${shown.plan?.status ?? 'none'}`,
          ),
          ux: check(
            boundedDisplay(activated, { min: 20 }).ok
              && /block|fail|missing|not found|cannot|refus/i.test(String(activated.display ?? '')),
            'the report names the failed run and does not imply success',
            activated.display,
          ),
        },
        metrics: { failedSteps: failed.length, planStatus: activated.planStatus ?? null },
      };
    },
  },

  {
    id: 'px-04',
    category: 'planning-execution',
    title: 'A revised plan is current at version 2 while version 1 stays readable',
    intent: 'Revise an approved plan, restart, and confirm the current plan is the revision while its earlier version remains in history.',
    preconditions: ['one recorded plan at version 1'],
    steps: [
      'record a one-step plan',
      'revise it to a two-step plan with a reason',
      'restart the application',
      'read the plan and its history',
    ],
    async run(ctx) {
      const plan = await ctx.act('planAdd', {
        outcome: 'One arithmetic result is verified',
        steps: planSteps(['2+2']),
        reason: 'initial version',
      }, 'plan: add');
      const planId = plan.operation?.steps?.[0]?.result?.data?.planId ?? null;

      const revised = await ctx.act('planRevise', {
        target: planId,
        outcome: 'Two arithmetic results are verified',
        steps: planSteps(['2+2', '4*3']),
        reason: 'the user asked for a second result',
      }, 'plan: revise');

      await ctx.restart();
      const shown = await ctx.call('showPlan', [planId], 'plan: show after restart');
      const history = await ctx.call('planHistory', [planId], 'plan: history after restart');

      return {
        expected: 'the current plan has two steps at version 2, and the history still records version 1',
        actual: `revise=${revised.status} version=${shown.plan?.version ?? 'none'} steps=${shown.plan?.steps?.length ?? 0}`,
        checks: {
          correctness: check(
            outcomeIn(revised, ['plan_stored', 'success_verified']).ok,
            'the revision is recorded',
            revised.status,
          ),
          completeness: check(
            shown.plan?.version === 2
              && (shown.plan?.steps ?? []).length === 2
              && shown.plan?.outcome === 'Two arithmetic results are verified',
            'the current plan is the revised two-step version',
            `v${shown.plan?.version ?? '?'} with ${(shown.plan?.steps ?? []).length} step(s)`,
          ),
          continuity: check(
            (history.versions ?? []).length === 2
              && history.versions.some((version) => version.version === 1)
              && history.versions.some((version) => version.version === 2)
              && displayHas(history, /v1/).ok && displayHas(history, /v2/).ok,
            'both versions remain readable after a restart',
            `${(history.versions ?? []).length} recorded version(s)`,
          ),
          safety: check(
            shown.plan?.status !== 'approved',
            'the revision does not inherit the earlier approval',
            shown.plan?.status ?? 'none',
          ),
        },
        metrics: { versions: (history.versions ?? []).length, currentVersion: shown.plan?.version ?? null },
      };
    },
  },
];
