// Long-duration operation scenarios: work started in one session is still reported truthfully
// after the process is rebuilt, and a second operating-system process sees the same records.
//
// These checks use restarts and the CLI a user runs. They assert stored record counts as well as
// statuses, so a duplicated task, a stale plan version, or a lost correction is visible rather
// than hidden behind a successful-looking summary.
import { check } from '../framework.js';
import {
  outcomeIs, outcomeIn, dataOf, displayHas, boundedDisplay, readJsonl,
} from '../oracles.js';

const recordsIn = (dataDir, name) => readJsonl(dataDir, name).records;

function planSteps(expressions) {
  return expressions.map((expression, index) => ({
    id: `s${index + 1}`,
    description: `Evaluate ${expression}`,
    action: 'calc.evaluate',
    input: { expression },
    dependsOn: index === 0 ? [] : [`s${index}`],
    expectedResult: 'a deterministic numeric result',
    verification: 'the action independently re-evaluates the expression',
    risk: 'low',
  }));
}

export default [
  {
    id: 'ld-01',
    category: 'long-duration',
    title: 'A completed plan is reported completed after a restart and from a new process',
    intent: 'Run an approved plan to completion in one session, then rebuild the application and read the same plan and task through the controller and the CLI.',
    preconditions: ['one open goal', 'no model backend'],
    steps: [
      'record a goal and a two-step plan',
      'approve and activate the plan',
      'restart the application over the same data',
      'read the plan and task in-process and through the CLI',
    ],
    async run(ctx) {
      const goal = await ctx.act('goalAdd', {
        request: 'Produce two verified arithmetic results',
        criteria: ['both calculations are recorded as verified'],
      }, 'goal: add');
      const goalId = dataOf(goal)?.goalId ?? null;
      const plan = await ctx.act('planAdd', {
        goalId,
        outcome: 'Two arithmetic results are verified',
        steps: planSteps(['(12+8)*3', '60/4']),
        reason: 'produce the results the goal asks for',
      }, 'plan: add');
      const planId = dataOf(plan)?.planId ?? null;
      await ctx.act('planApprove', { target: planId }, 'plan: approve');
      const activated = await ctx.call('planActivate', [planId], 'plan: activate');
      const taskId = activated.task?.id ?? null;

      await ctx.restart();
      const shown = await ctx.call('showPlan', [planId], 'plan: show after restart');
      const task = await ctx.call('showTask', [taskId], 'task: show after restart');
      const cliPlan = await ctx.cli(['plan', 'show', planId]);
      const cliTask = await ctx.cli(['task', 'show', taskId]);

      const plans = recordsIn(ctx.dataDir, 'plans.jsonl');
      const tasks = recordsIn(ctx.dataDir, 'tasks.jsonl');
      const planIds = new Set(plans.map((record) => record.planId));
      const taskIds = new Set(tasks.map((record) => record.taskId));

      return {
        expected: 'the plan and its task stay completed after a restart, and a second process reports the same status from one plan and one task',
        actual: `activate=${activated.status}/${activated.planStatus} afterRestart=${shown.plan?.status}/${task.task?.status} cli=${cliPlan.code}/${cliTask.code} ids=${planIds.size}/${taskIds.size}`,
        checks: {
          correctness: check(
            activated.status === 'success_verified'
              && activated.planStatus === 'completed'
              && activated.task?.status === 'completed',
            'activation reports verified success and completes both the task and the plan',
            `${activated.status} plan=${activated.planStatus} task=${activated.task?.status}`,
          ),
          completeness: check(
            shown.plan?.status === 'completed' && task.task?.status === 'completed',
            'the rebuilt application reads both records as completed',
            `plan=${shown.plan?.status} task=${task.task?.status}`,
          ),
          continuity: check(
            cliPlan.code === 0 && /status: completed/i.test(cliPlan.stdout)
              && cliTask.code === 0 && /status: completed/i.test(cliTask.stdout),
            'a second process reports the same completed statuses',
            `plan=${cliPlan.stdout.split('\n')[0] || '(no output)'} task=${cliTask.stdout.split('\n')[0] || '(no output)'}`,
          ),
          safety: check(
            planIds.size === 1 && taskIds.size === 1,
            'the restart did not create a second plan or a second task',
            `${planIds.size} plan id(s), ${taskIds.size} task id(s)`,
          ),
          ux: check(
            boundedDisplay(shown, { min: 20 }).ok && displayHas(shown, /completed/i).ok,
            'the plan view says it is completed',
            shown.display,
          ),
        },
        metrics: { plans: planIds.size, tasks: taskIds.size, completedSteps: (task.task?.steps ?? []).filter((s) => s.status === 'completed').length },
      };
    },
  },

  {
    id: 'ld-02',
    category: 'long-duration',
    title: 'A fresh process answers a portfolio question from the stores, not from memory',
    intent: 'Complete one task and leave one goal open, restart, and confirm the portfolio view reads both without a model or the earlier conversation.',
    preconditions: ['one open goal', 'one completed task', 'no model backend'],
    steps: [
      'record an open goal',
      'record, approve and run a separate one-step plan',
      'restart the application',
      'ask for the work review in-process and through the CLI',
    ],
    async run(ctx) {
      const goal = await ctx.act('goalAdd', {
        request: 'Replace the office printer before the lease ends',
        criteria: ['the office manager approves a replacement'],
        priority: 3,
      }, 'goal: add open goal');
      const plan = await ctx.act('planAdd', {
        outcome: 'One arithmetic result is verified',
        steps: planSteps(['9*9']),
        reason: 'produce one independent task',
      }, 'plan: add');
      const planId = dataOf(plan)?.planId ?? null;
      await ctx.act('planApprove', { target: planId }, 'plan: approve');
      await ctx.call('planActivate', [planId], 'plan: activate');

      await ctx.restart();
      const review = await ctx.act('workReview', {}, 'work: review after restart');
      const data = dataOf(review);
      const counts = data?.counts ?? null;
      const cli = await ctx.cli(['review']);
      const modelCalls = ctx.gateway()?.requests?.length ?? 0;
      const tasks = recordsIn(ctx.dataDir, 'tasks.jsonl');
      const taskIds = new Set(tasks.map((record) => record.taskId));

      return {
        expected: 'the review reports one open goal, no unfinished task, and a completed task without consulting a model',
        actual: `status=${review.status} goals=${counts?.goals?.open ?? 'n/a'} tasksOpen=${counts?.tasks?.open ?? 'n/a'} tasks=${counts?.tasks?.total ?? 'n/a'} modelCalls=${modelCalls}`,
        checks: {
          correctness: outcomeIs(review, 'success_verified'),
          completeness: check(
            (counts?.goals?.open ?? 0) === 1
              && (counts?.tasks?.open ?? -1) === 0
              && (counts?.tasks?.total ?? 0) === 1
              && (data?.goals ?? []).some((row) => /printer/i.test(String(row.request ?? ''))),
            'the review names the open goal and counts the completed task exactly once',
            `goals=${counts?.goals?.open} tasksOpen=${counts?.tasks?.open} tasks=${counts?.tasks?.total}`,
          ),
          continuity: check(
            cli.code === 0 && /printer/i.test(cli.stdout) && taskIds.size === 1,
            'a second process reports the same open goal from one stored task',
            `cli=${cli.code} taskIds=${taskIds.size}`,
          ),
          safety: check(
            modelCalls === 0,
            'the portfolio answer is derived from the stores with no model call',
            `${modelCalls} model call(s)`,
          ),
          ux: check(
            boundedDisplay(review, { min: 40, max: 8000 }).ok,
            'the portfolio answer is bounded',
            `${String(review.display ?? '').length} characters`,
          ),
        },
        metrics: { openGoals: counts?.goals?.open ?? null, tasks: counts?.tasks?.total ?? null, modelCalls },
      };
    },
  },

  {
    id: 'ld-03',
    category: 'long-duration',
    title: 'Corrections across sessions leave one current answer and a readable history',
    intent: 'In separate sessions correct a remembered fact, retract a knowledge claim, and revise a plan, then confirm the current answers are singular while earlier versions remain.',
    preconditions: ['three sessions over one isolated data directory', 'no model backend'],
    steps: [
      'session 1: remember that the vendor ships on Tuesdays',
      'session 2: correct it to Thursdays, retract a backup claim, revise the plan',
      'session 3: recall the fact and read knowledge and plan history',
    ],
    async run(ctx) {
      const stored = await ctx.say('remember that the vendor ships on Tuesdays');
      const originalId = dataOf(stored)?.id ?? null;
      await ctx.restart();

      const corrected = await ctx.act('correctMemory', {
        targetId: originalId,
        content: 'the vendor ships on Thursdays',
        resolve: true,
      }, 'memory: correct shipping day');

      const added = await ctx.act('knowledgeAdd', {
        subject: 'backup policy', relationship: 'requires', object: 'weekly snapshots',
      }, 'knowledge: add backup claim');
      const claimId = dataOf(added)?.id ?? null;
      const retracted = await ctx.act('knowledgeRetract', {
        target: claimId, reason: 'replaced by the 2026 retention policy',
      }, 'knowledge: retract backup claim');

      const plan = await ctx.act('planAdd', {
        outcome: 'One arithmetic result is verified',
        steps: planSteps(['3+3']),
        reason: 'initial version',
      }, 'plan: add');
      const planId = dataOf(plan)?.planId ?? null;
      const revised = await ctx.act('planRevise', {
        target: planId,
        outcome: 'Two arithmetic results are verified',
        steps: planSteps(['3+3', '6*6']),
        reason: 'the requirement changed between sessions',
      }, 'plan: revise');
      await ctx.restart();

      const recalled = await ctx.say('what do you remember about the vendor');
      const hits = dataOf(recalled)?.hits ?? [];
      // Command results redact record content, so identity is read from the replacement chain:
      // the correction names the row it replaces, and the original carries the superseded status.
      const current = hits.find((hit) => (hit.replaces ?? []).includes(originalId));
      const historical = hits.find((hit) => hit.id === originalId);

      const search = await ctx.call('knowledgeSearch', ['backup policy'], 'knowledge: search retracted claim');
      const listed = await ctx.act('knowledgeList', {}, 'knowledge: list after retraction');
      const row = (dataOf(listed)?.records ?? []).find((record) => record.id === claimId) ?? null;

      const shown = await ctx.call('showPlan', [planId], 'plan: show after restart');
      const history = await ctx.call('planHistory', [planId], 'plan: history after restart');

      const memoryRecords = recordsIn(ctx.dataDir, 'memory.jsonl');
      // A correction is recorded as a new row that names the row it replaces; the store keeps
      // both. "Current" is therefore derived from the replacement chain, not from a status field.
      const currentMemory = memoryRecords.filter((record) => !memoryRecords.some(
        (other) => (other.provenance?.replaces ?? []).includes(record.id),
      ));

      return {
        expected: 'each change is current exactly once, earlier versions remain readable, and no record is duplicated across sessions',
        actual: `memory=${memoryRecords.length} hits=${hits.length} search=${(dataOf(search)?.hits ?? []).length} plan=v${shown.plan?.version} versions=${(history.versions ?? []).length}`,
        checks: {
          correctness: check(
            outcomeIs(corrected, 'success_verified').ok
              && outcomeIs(retracted, 'success_verified').ok
              && outcomeIn(revised, ['plan_stored', 'success_verified']).ok,
            'the correction, retraction and revision each report a recorded success',
            `${corrected.status}/${retracted.status}/${revised.status}`,
          ),
          completeness: check(
            current !== undefined && current.status === 'user_confirmed'
              && historical !== undefined && historical.status === 'superseded'
              && shown.plan?.version === 2 && (shown.plan?.steps ?? []).length === 2,
            'the current answer is singular and the earlier one is kept as superseded',
            `current=${current?.status ?? 'missing'} historical=${historical?.status ?? 'missing'} plan=v${shown.plan?.version}`,
          ),
          continuity: check(
            (history.versions ?? []).length === 2
              && (dataOf(search)?.hits ?? []).length === 0
              && row?.lifecycleState === 'retracted'
              && search.display !== undefined,
            'both plan versions survive the restart, and the retracted claim is absent from current search but readable in the list',
            `versions=${(history.versions ?? []).length} hits=${(dataOf(search)?.hits ?? []).length} claim=${row?.lifecycleState ?? 'missing'}`,
          ),
          safety: check(
            memoryRecords.length === 2 && currentMemory.length === 1
              && currentMemory[0].content !== undefined,
            'exactly one current memory record remains and the original is kept as superseded',
            `${memoryRecords.length} memory record(s), ${currentMemory.length} current`,
          ),
          ux: check(
            displayHas(recalled, /Thursdays/).ok && boundedDisplay(shown, { min: 20 }).ok,
            'the recall shows the current value and the plan view is readable',
            recalled.display,
          ),
        },
        metrics: {
          memoryRecords: memoryRecords.length,
          recallHits: hits.length,
          planVersions: (history.versions ?? []).length,
          searchHits: (dataOf(search)?.hits ?? []).length,
        },
      };
    },
  },
];
