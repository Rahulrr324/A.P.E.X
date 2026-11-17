// Real multi-session executive workflows (T-16, §6 A-J).
//
// Each step is its own `bin/apex.js` process against the same isolated data directory: the work a
// later session reads back was written by an earlier one, and the assertions are on what those
// later processes could actually observe. Nothing here uses a model; the no-model request paths
// (`ask "remember ..."`, `calc`) are real application paths and are recorded as such.
import fs from 'node:fs';
import path from 'node:path';
import { check } from '../harness.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function oneLine(value, max = 600) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function goalId(result) {
  const match = /^Goal ([0-9a-f]+)\b/m.exec(String(result?.rawStdout ?? ''));
  return match ? match[1] : null;
}

function planId(result) {
  const match = /^Plan ([0-9a-f]+)\b/m.exec(String(result?.rawStdout ?? ''));
  return match ? match[1] : null;
}

function knowledgeId(result) {
  const match = /Stored knowledge record ([0-9a-f]+)/.exec(String(result?.rawStdout ?? ''));
  return match ? match[1] : null;
}

function operationId(result) {
  const match = /^Operation: ([0-9a-f-]{36})\b/m.exec(String(result?.rawStdout ?? ''));
  return match ? match[1] : null;
}

function memoryId(result) {
  const match = /Stored \(user fact\) ([0-9a-f]+)/.exec(String(result?.rawStdout ?? ''));
  return match ? match[1] : null;
}

function ticksIn(result) {
  const match = /ticks (\d+)/.exec(String(result?.rawStdout ?? ''));
  return match ? Number(match[1]) : null;
}

function pollCounts(result) {
  const match = /polled in \d+ ms: (\d+) accepted, (\d+) duplicate, (\d+) refused of (\d+) observation/.exec(String(result?.rawStdout ?? ''));
  return match
    ? { accepted: Number(match[1]), duplicates: Number(match[2]), refused: Number(match[3]), observed: Number(match[4]) }
    : null;
}

function lastLine(text) {
  return String(text ?? '').trim().split('\n').filter((line) => line.trim() !== '').pop() ?? '';
}

async function waitForTicks(ctx, minimum, timeoutMs = 20000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await ctx.cli(['runtime', 'status'], { label: 'runtime status (waiting for ticks)', probe: true });
    const ticks = ticksIn(last);
    if (ticks !== null && ticks >= minimum) return { status: last, ticks, elapsedMs: Date.now() - started };
    await sleep(250);
  }
  return { status: last, ticks: ticksIn(last), elapsedMs: Date.now() - started };
}

const findStep = (id, name, dependsOn = [], criterion = 'c1') => ({
  id,
  description: `Find the ${name} record`,
  action: 'filesystem.find',
  input: { name },
  dependsOn,
  expectedResult: `a bounded list naming the ${name} record`,
  verification: 'the action re-reads the workspace and reports its own result',
  risk: 'low',
  criterion,
});

const continuityAcrossSessions = {
  id: 'ex-01-project-continuity',
  category: 'real-world',
  area: 'executive',
  workflow: 'A',
  title: 'A goal and plan recorded in one session are run and read back in later ones',
  intent: 'Record a goal and plan, then approve, run and inspect them from separate CLI processes, confirming that each later session reads the records earlier ones stored rather than starting over.',
  preconditions: ['a pilot workspace with a status report and an owner note', 'no APEX data directory yet'],
  steps: [
    'record a goal and accept it in separate processes',
    'record a one-step plan bound to the goal',
    'validate, approve and start the plan in three further processes',
    'read the plan, task and goal from another process',
  ],
  expected: {
    result: 'the plan is completed from a later process, its task cites a verified step, and the goal remains uncompleted because no criterion evidence was recorded',
    acceptance: [
      'every command exits 0 and names the same plan and goal identifiers',
      'the plan status is completed with one verified step outcome',
      'the task list shows the created task as completed',
      'the goal still shows 0 of 1 criteria satisfied and stays accepted',
      'plan history shows creation, approval, activation and outcome records',
    ],
  },
  async setup(ctx) {
    ctx.write('docs/status-report.txt', 'status: green\nowner: Mira\n');
    ctx.write('docs/owner-note.txt', 'owner: Mira\ncontact: mira@example.invalid\n');
  },
  async run(ctx) {
    const added = await ctx.cli(['goal', 'add', 'Locate the current status report', '--criterion', 'the report is located'], { label: 'session 1: goal add' });
    const goal = goalId(added);
    if (!goal) throw new Error(`goal add printed no identifier: ${added.rawStdout}`);

    const accepted = await ctx.cli(['goal', 'update', goal, 'accepted'], { label: 'session 2: goal accepted' });
    const created = await ctx.cli(['plan', 'add', '--goal', goal, '--outcome', 'the current status report is located',
      '--step', JSON.stringify(findStep('s1', 'status'))], { label: 'session 3: plan add' });
    const plan = planId(created);
    if (!plan) throw new Error(`plan add printed no identifier: ${created.rawStdout}`);

    const shownBefore = await ctx.cli(['plan', 'show', plan], { label: 'session 4: plan show' });
    const validated = await ctx.cli(['plan', 'validate', plan], { label: 'session 5: plan validate' });
    const approved = await ctx.cli(['plan', 'approve', plan], { label: 'session 6: plan approve' });
    const started = await ctx.cli(['plan', 'start', plan], { label: 'session 7: plan start' });
    const taskMatch = /activated as task ([0-9a-f]+)/.exec(started.rawStdout);
    const task = taskMatch ? taskMatch[1] : null;

    const shownAfter = await ctx.cli(['plan', 'show', plan], { label: 'session 8: plan show after the run' });
    const tasks = await ctx.cli(['task', 'list'], { label: 'session 9: task list' });
    const goalAfter = await ctx.cli(['goal', 'show', goal], { label: 'session 10: goal show after the run' });
    const history = await ctx.cli(['plan', 'history', plan], { label: 'session 11: plan history' });

    ctx.record('plan before the run', oneLine(shownBefore.rawStdout, 400));
    ctx.record('plan after the run', oneLine(shownAfter.rawStdout, 500));
    ctx.record('goal after the run', oneLine(goalAfter.rawStdout, 400));
    ctx.measure('plan start', started.durationMs);
    ctx.measure('plan validate', validated.durationMs);

    const completed = /Plan [0-9a-f]+ is completed against 1 verified step outcome/.test(started.rawStdout);
    const stepVerified = /s1 \[completed [0-9a-f]+\]/.test(shownAfter.rawStdout) && /verified/.test(shownAfter.rawStdout);
    const sameIdentifiers = Boolean(task) && shownAfter.rawStdout.includes(plan) && shownAfter.rawStdout.includes(goal)
      && tasks.rawStdout.includes(task) && tasks.rawStdout.includes('completed');
    const goalUntouched = /status: accepted/.test(goalAfter.rawStdout) && /0 of 1 criterion/.test(goalAfter.rawStdout);
    // `plan history` lists recorded versions; the lifecycle events are shown by `plan show`.
    const historyComplete = ['created', 'approved', 'activated', 'outcome'].every((entry) => shownAfter.rawStdout.includes(entry))
      && /1 recorded version/.test(history.rawStdout);

    return {
      actual: `goal ${goal} / plan ${plan} / task ${task ?? 'none'}; started=${completed}; task list=${oneLine(tasks.rawStdout, 120)}; goal still=${/status: (\w+)/.exec(goalAfter.rawStdout)?.[1] ?? 'unknown'}`,
      checks: {
        correctness: check(
          completed && stepVerified && tasks.rawStdout.includes(`${task}`),
          'the plan ran to a verified completion in a later process and its step outcome was recorded',
          { completed, stepVerified, task },
        ),
        completeness: check(
          sameIdentifiers && historyComplete,
          'every later process reads the same plan, task and goal, and the plan history carries creation, approval, activation and outcome',
          { sameIdentifiers, historyComplete, history: oneLine(history.rawStdout, 300) },
        ),
        reliability: check(
          [added, accepted, created, shownBefore, validated, approved, started, shownAfter, tasks, goalAfter, history].every((row) => row.code === 0),
          'each of the eleven separate processes exits 0',
          { exits: [added, accepted, created, shownBefore, validated, approved, started, shownAfter, tasks, goalAfter, history].map((row) => row.code) },
        ),
        safety: check(
          goalUntouched && !/c1 \[satisfied\]/.test(goalAfter.rawStdout) && !/status: completed/.test(goalAfter.rawStdout),
          'running the plan does not complete the goal, which has no criterion evidence',
          { goalUntouched, goal: oneLine(goalAfter.rawStdout, 240) },
        ),
        continuity: check(
          shownBefore.rawStdout.includes(goal) && shownAfter.rawStdout.includes(goal) && shownAfter.rawStdout.includes(task),
          'a goal recorded in the first process, a plan recorded in the third, and a task created in the seventh are all readable in the last process',
          { sameIdentifiers, task },
        ),
        ux: check(
          /No goal is completed by this/.test(started.rawStdout) && /Next:/.test(shownAfter.rawStdout) && started.rawStdout.split('\n').length >= 6,
          'the run states that plan completion is not goal completion and the plan shows what to read next',
          { final: lastLine(started.rawStdout) },
        ),
      },
      metrics: { goalId: goal, planId: plan, taskId: task },
    };
  },
};

const requirementsChange = {
  id: 'ex-02-requirements-change',
  category: 'real-world',
  area: 'executive',
  workflow: 'B',
  title: 'A revised requirement invalidates the approved plan and a new plan follows it',
  intent: 'Change a goal criterion after its plan was approved, confirm the old plan is refused rather than quietly run, and confirm a new plan written for the revised goal runs.',
  preconditions: ['one goal with a single criterion and one approved plan bound to it'],
  steps: [
    'record and accept a goal, then record and approve its plan',
    'revise the goal to add a second criterion',
    'validate and re-approve the old plan, which must be refused',
    'cancel the obsolete plan, then record a new two-step plan against revision 2',
    'validate, approve and run the new plan, and read both plans back',
  ],
  expected: {
    result: 'the old plan fails live validation against revision 2 and cannot be re-approved or revised, while a new plan bound to revision 2 completes',
    acceptance: [
      'goal revise reports revision 2 with two criteria',
      'the old plan validates NOT passed on goal-revision and re-approval exits 1',
      'the old plan cannot be revised while approved',
      'the new plan validates passed against revision 2 and its run completes',
      'the old plan is cancelled with no task created, and both plans remain readable',
    ],
  },
  async setup(ctx) {
    ctx.write('docs/status-report.txt', 'status: green\n');
    ctx.write('docs/owner-note.txt', 'owner: Mira\n');
  },
  async run(ctx) {
    const g1 = goalId(await ctx.cli(['goal', 'add', 'Prepare the status report', '--criterion', 'the report names the current state'], { label: 'goal add' }));
    await ctx.cli(['goal', 'update', g1, 'accepted'], { label: 'goal accepted' });
    const oldPlan = planId(await ctx.cli(['plan', 'add', '--goal', g1, '--outcome', 'the report is located',
      '--step', JSON.stringify(findStep('s1', 'status'))], { label: 'old plan add' }));
    const approvedOld = await ctx.cli(['plan', 'approve', oldPlan], { label: 'old plan approve' });

    const revised = await ctx.cli(['goal', 'revise', g1, '--criterion', 'the report names the current state', '--criterion', 'the report names the owner', '--reason', 'the owner must be visible too'], { label: 'goal revise' });
    const staleValidation = await ctx.cli(['plan', 'validate', oldPlan], { label: 'stale plan validate' });
    const staleApprove = await ctx.cli(['plan', 'approve', oldPlan], { label: 'stale plan re-approve' });
    const staleRevise = await ctx.cli(['plan', 'revise', oldPlan, '--outcome', 'the report is located', '--reason', 'follow the new criteria',
      '--step', JSON.stringify(findStep('s1', 'status'))], { label: 'stale plan revise' });

    // Only one plan per goal may be live: the obsolete approved plan has to be cancelled before
    // the goal can authorize another one. Doing so is a user decision, not a repair of the old plan.
    const cancelled = await ctx.cli(['plan', 'cancel', oldPlan, '--reason', 'the goal revision replaced this approach'], { label: 'old plan cancel' });
    const newPlan = planId(await ctx.cli(['plan', 'add', '--goal', g1, '--outcome', 'the report and its owner are located',
      '--step', JSON.stringify(findStep('s1', 'status', [], 'c1')),
      '--step', JSON.stringify(findStep('s2', 'owner', ['s1'], 'c2'))], { label: 'new plan add' }));
    const newValidation = await ctx.cli(['plan', 'validate', newPlan], { label: 'new plan validate' });
    const newApprove = await ctx.cli(['plan', 'approve', newPlan], { label: 'new plan approve' });
    const newStart = await ctx.cli(['plan', 'start', newPlan], { label: 'new plan start' });
    const oldShown = await ctx.cli(['plan', 'show', oldPlan], { label: 'old plan show' });
    const newShown = await ctx.cli(['plan', 'show', newPlan], { label: 'new plan show' });
    const goalShown = await ctx.cli(['goal', 'show', g1], { label: 'goal show' });
    const tasks = await ctx.cli(['task', 'list'], { label: 'task list' });

    ctx.record('goal revision', oneLine(revised.rawStdout, 360));
    ctx.record('stale validation', oneLine(staleValidation.rawStdout.split('\n').slice(-6).join(' '), 500));
    ctx.record('stale refusals', oneLine(`${staleApprove.rawStdout} ${staleRevise.rawStdout}`, 400));
    ctx.record('new plan outcome', oneLine(newStart.rawStdout, 400));
    ctx.measure('stale plan validation', staleValidation.durationMs);
    ctx.measure('new plan start', newStart.durationMs);

    const revisionIsTwo = /is now revision 2 \(was 1\)/.test(revised.rawStdout) && /c2 \[pending\] the report names the owner/.test(revised.rawStdout);
    const staleRefused = /Live validation: NOT passed/.test(staleValidation.rawStdout)
      && /FAILED {2}goal-revision: plan names goal revision 1, but the goal is revision 2/.test(staleValidation.rawStdout)
      && staleApprove.code === 1 && /only a draft can be approved/.test(staleApprove.rawStdout)
      && staleRevise.code === 1 && /plan is approved/.test(staleRevise.rawStdout);
    const newPassed = /Live validation: passed/.test(newValidation.rawStdout)
      && /plan names goal revision 2, which is current/.test(newValidation.rawStdout);
    const newCompleted = newStart.code === 0 && /Plan [0-9a-f]+ is completed against 2 verified step outcome/.test(newStart.rawStdout);
    const oldCancelled = /status: cancelled/.test(oldShown.rawStdout) && /no task was created from this plan/.test(cancelled.rawStdout);
    const onlyOneTask = tasks.rawStdout.trim().split('\n').filter((line) => line.trim() !== '').length === 1;

    return {
      actual: `revision=${revisionIsTwo}; stale validation refused=${staleRefused}; new plan validated=${newPassed}; new plan completed=${newCompleted}; old plan cancelled=${oldCancelled}`,
      checks: {
        correctness: check(
          revisionIsTwo && newPassed && newCompleted,
          'the changed requirement is recorded, the new plan validates against it, and that plan completes',
          { revisionIsTwo, newPassed, newCompleted },
        ),
        completeness: check(
          staleRefused && oldCancelled,
          'the obsolete plan is refused while approved, cannot be revised, and is finally cancelled with its history intact',
          { staleRefused, oldCancelled },
        ),
        reliability: check(
          [approvedOld, revised, newValidation, newApprove, newStart, cancelled, oldShown, newShown, goalShown, tasks].every((row) => row.code === 0)
            && staleValidation.code === 1 && staleApprove.code === 1 && staleRevise.code === 1,
          'every command that must succeed exits 0, and the three stale-plan checks exit 1 expectedly',
          { exits: { approvedOld: approvedOld.code, staleValidation: staleValidation.code, staleApprove: staleApprove.code, staleRevise: staleRevise.code, newStart: newStart.code } },
        ),
        safety: check(
          oldCancelled && onlyOneTask && /revision 1/.test(oldShown.rawStdout) && /revision 2/.test(newShown.rawStdout),
          'the obsolete approved plan created no task or run and keeps its recorded revision, while only the new plan holds a task',
          { oldCancelled, onlyOneTask, tasks: oneLine(tasks.rawStdout, 200) },
        ),
        continuity: check(
          /revision: 2/.test(goalShown.rawStdout) && /c2 \[pending\] the report names the owner/.test(goalShown.rawStdout)
            && newShown.rawStdout.includes(newPlan),
          'a later process reads the goal at revision 2 with both criteria and the new plan bound to it',
          { goal: oneLine(goalShown.rawStdout, 240) },
        ),
        ux: check(
          /moved from revision 1 to 2; the plan was written for older criteria and must be revised or revalidated/.test(staleValidation.rawStdout),
          'the refusal explains the revision mismatch and what the user has to do about it',
          { refusal: oneLine(staleValidation.rawStdout.split('\n').slice(-3).join(' '), 300) },
        ),
      },
      metrics: { goalId: g1, stalePlanId: oldPlan, newPlanId: newPlan },
    };
  },
};

const correctionPreserved = {
  id: 'ex-03-user-correction',
  category: 'real-world',
  area: 'executive',
  workflow: 'C',
  title: 'A correction replaces what is retrieved without erasing the earlier claim',
  intent: 'Record a fact in one session, correct it in another, and confirm later retrieval returns the correction first while the original stays readable and marked superseded.',
  preconditions: ['an empty memory store'],
  steps: [
    'remember a project codename through the no-model request path',
    'recall it from a second process',
    'record an explicit correction in a third process',
    'recall again and read memory health from later processes',
  ],
  expected: {
    result: 'the corrected codename is returned as the current fact, the original remains stored as superseded, and memory health counts one correction over two readable records',
    acceptance: [
      'the first session stores one user fact',
      'the correction names the record it replaces',
      'later recall returns the correction with the original still listed as superseded',
      'memory health reports 2 readable records and 1 correction',
    ],
  },
  async run(ctx) {
    const remembered = await ctx.cli(['ask', 'remember that the project codename is Lighthouse'], { label: 'session 1: remember' });
    const original = memoryId(remembered);
    const firstRecall = await ctx.cli(['ask', 'recall codename'], { label: 'session 2: recall' });
    const corrected = await ctx.cli(['memory', 'correct', '--resolve', original, 'the project codename is Beacon'], { label: 'session 3: memory correct' });
    const secondRecall = await ctx.cli(['ask', 'recall codename'], { label: 'session 4: recall after correction' });
    const health = await ctx.cli(['memory', 'health'], { label: 'session 5: memory health' });

    ctx.record('initial recall', oneLine(firstRecall.rawStdout, 300));
    ctx.record('correction', oneLine(corrected.rawStdout, 300));
    ctx.record('corrected recall', oneLine(secondRecall.rawStdout, 500));
    ctx.measure('memory recall', secondRecall.durationMs);
    ctx.measure('memory correction', corrected.durationMs);

    const beacon = secondRecall.rawStdout.indexOf('the project codename is Beacon');
    const lighthouse = secondRecall.rawStdout.indexOf('the project codename is Lighthouse');
    const correctionFirst = beacon >= 0 && lighthouse > beacon;
    const originalPreserved = /\[superseded; superseded by [0-9a-f-]+\]/.test(secondRecall.rawStdout);
    const correctionCited = new RegExp(`Stored correction [0-9a-f-]+; it explicitly corrects ${original}`).test(corrected.rawStdout);
    const healthCounts = /Records:\s+2 readable/.test(health.rawStdout) && /corrections:\s+1 \(replacing 1 claim\(s\)\)/.test(health.rawStdout);

    return {
      actual: `correctionFirst=${correctionFirst}; original preserved=${originalPreserved}; correction cites original=${correctionCited}; health=${healthCounts}; first recall one fact=${/1 matching memory record/.test(firstRecall.rawStdout)}`,
      checks: {
        correctness: check(
          /1 matching memory record/.test(firstRecall.rawStdout) && correctionFirst && secondRecall.rawStdout.includes('Beacon'),
          'the first recall returns the original fact and the later recall returns the correction before it',
          { firstRecall: oneLine(firstRecall.rawStdout, 200), secondRecall: oneLine(secondRecall.rawStdout, 240) },
        ),
        completeness: check(
          correctionCited && originalPreserved && healthCounts,
          'the correction cites the record it replaces, the original stays readable as superseded, and health counts both',
          { correctionCited, originalPreserved, healthCounts },
        ),
        reliability: check(
          [remembered, firstRecall, corrected, secondRecall, health].every((row) => row.code === 0),
          'all five separate processes exit 0',
          { exits: [remembered, firstRecall, corrected, secondRecall, health].map((row) => row.code) },
        ),
        safety: check(
          originalPreserved && /Earlier evidence remains stored/.test(corrected.rawStdout) && /model_proposed 0/.test(health.rawStdout),
          'the correction appends to history instead of rewriting it and no model-proposed record exists',
          { corrected: oneLine(corrected.rawStdout, 240) },
        ),
        continuity: check(
          new RegExp(`\\[${original}[0-9a-f-]*\\].*Lighthouse`).test(secondRecall.rawStdout),
          'the record identifier from the first session is still the one a later process shows',
          { original },
        ),
        ux: check(
          /Memory matches for "codename"/.test(secondRecall.rawStdout) && /\[user_confirmed; corrects [0-9a-f-]+\]/.test(secondRecall.rawStdout),
          'recall states which record is the correction and which is superseded',
          { line: oneLine(secondRecall.rawStdout.split('\n').find((line) => line.includes('Beacon')) ?? '', 240) },
        ),
      },
      metrics: { originalMemoryId: original },
    };
  },
};

const conflictingSources = {
  id: 'ex-04-conflicting-information',
  category: 'real-world',
  area: 'executive',
  workflow: 'D',
  title: 'Two disagreeing records stay stored and the user decision is recorded separately',
  intent: 'Store two contradictory claims from different evidence, confirm both are reported as conflicting, and record an explicit user choice that preserves the alternative.',
  preconditions: ['an empty knowledge store'],
  steps: [
    'store a green status claim with its evidence',
    'store a red status claim with different evidence',
    'read the conflict and knowledge health before any decision',
    'record an explicit resolution choosing one claim',
    'read health, the losing claim and its history afterwards',
  ],
  expected: {
    result: 'both claims remain stored and conflicting, the unresolved state is reported, and the later decision names the chosen claim while preserving the alternative',
    acceptance: [
      'the second claim reports a conflict with the first',
      'knowledge health exits 1 while the conflict is unresolved',
      'the resolution reports one preserved alternative',
      'health afterwards reports a recorded user decision, not verified truth',
      'the non-chosen claim remains readable with the decision recorded',
    ],
  },
  async run(ctx) {
    const first = await ctx.cli(['knowledge', 'add', '--subject', 'Project Atlas', '--relationship', 'status', '--object', 'green', '--evidence', 'kickoff note'], { label: 'knowledge add (kickoff note)' });
    const second = await ctx.cli(['knowledge', 'add', '--subject', 'Project Atlas', '--relationship', 'status', '--object', 'red', '--evidence', 'incident report'], { label: 'knowledge add (incident report)' });
    const green = knowledgeId(first);
    const red = knowledgeId(second);
    const listBefore = await ctx.cli(['knowledge', 'list'], { label: 'knowledge list (conflicting)' });
    const healthBefore = await ctx.cli(['knowledge', 'health'], { label: 'knowledge health (unresolved)' });
    const resolved = await ctx.cli(['knowledge', 'resolve', green, '--choose', red, '--reason', 'the incident report is newer'], { label: 'knowledge resolve' });
    const healthAfter = await ctx.cli(['knowledge', 'health'], { label: 'knowledge health (decision recorded)' });
    const shown = await ctx.cli(['knowledge', 'show', green], { label: 'knowledge show (not chosen)' });
    const history = await ctx.cli(['knowledge', 'history', green], { label: 'knowledge history (not chosen)' });

    ctx.record('conflict', oneLine(second.rawStdout, 300));
    ctx.record('resolution', oneLine(resolved.rawStdout, 400));
    ctx.record('health after', oneLine(healthAfter.rawStdout, 400));
    ctx.measure('knowledge search over conflicts', listBefore.durationMs);
    ctx.measure('conflict resolution', resolved.durationMs);

    const conflictDetected = new RegExp(`conflicts with 1 existing record\\(s\\): ${green}`).test(second.rawStdout)
      && (listBefore.rawStdout.match(/status: conflicting/g) ?? []).length === 2;
    const healthSaysUnresolved = healthBefore.code === 1 && /1 unresolved group/.test(healthBefore.rawStdout);
    const resolutionRecorded = /alternatives preserved: 1/.test(resolved.rawStdout)
      && /It does not prove the chosen claim is true/.test(resolved.rawStdout);
    const healthSaysDecided = healthAfter.code === 0
      && /1 group\(s\) with a recorded user decision \(a decision, not verified truth\)/.test(healthAfter.rawStdout);
    const loserPreserved = shown.code === 0 && /RESOLUTION:/.test(shown.rawStdout) && /this records a decision, not verified truth/.test(shown.rawStdout)
      && /chose [0-9a-f]+ \(event [0-9a-f]+\)/.test(history.rawStdout);

    return {
      actual: `conflict=${conflictDetected}; unresolved health exit=${healthBefore.code}; resolution=${resolutionRecorded}; decided health exit=${healthAfter.code}; loser preserved=${loserPreserved}`,
      checks: {
        correctness: check(
          conflictDetected && resolutionRecorded,
          'the disagreement is detected and the decision names the chosen and preserved claims',
          { conflictDetected, resolutionRecorded },
        ),
        completeness: check(
          healthSaysUnresolved && healthSaysDecided && loserPreserved,
          'health reports the unresolved conflict, then the recorded decision, and the non-chosen claim keeps its decision history',
          { healthSaysUnresolved, healthSaysDecided, loserPreserved },
        ),
        reliability: check(
          [first, second, listBefore, healthAfter, resolved, shown, history].every((row) => row.code === 0) && healthBefore.code === 1,
          'the stores stay readable and only the unresolved-conflict health check exits nonzero',
          { exits: { first: first.code, second: second.code, healthBefore: healthBefore.code, healthAfter: healthAfter.code, resolved: resolved.code } },
        ),
        safety: check(
          (listBefore.rawStdout.match(/status: conflicting/g) ?? []).length === 2
            && /Claims:\s+2 total/.test(healthAfter.rawStdout)
            && /a decision, not verified truth/.test(healthAfter.rawStdout),
          'resolving the conflict deletes neither claim and labels the outcome a user decision',
          { claims: /Claims:\s+(\d+) total/.exec(healthAfter.rawStdout)?.[0] ?? 'unknown' },
        ),
        continuity: check(
          history.rawStdout.includes(green) && history.rawStdout.includes(red) && /governs the current conflict group/.test(history.rawStdout),
          'a later process reads the resolution against the same two record identifiers',
          { history: oneLine(history.rawStdout, 300) },
        ),
        ux: check(
          /This records a user decision\. It does not prove the chosen claim is true/.test(resolved.rawStdout)
            && /unresolved conflicts require explicit handling/.test(healthBefore.rawStdout),
          'both the resolution and the health output say a decision is not proof',
          { resolution: oneLine(resolved.rawStdout, 240) },
        ),
      },
      metrics: { greenId: green, redId: red },
    };
  },
};

const blockedDependency = {
  id: 'ex-05-blocked-dependency',
  category: 'real-world',
  area: 'executive',
  workflow: 'G',
  title: 'A goal with an incomplete dependency is blocked and the block is reported',
  intent: 'Declare one goal as a dependency of another, confirm activation is refused until the dependency is completed from verified audit evidence, then activate it.',
  preconditions: ['two accepted goals, one depending on the other'],
  steps: [
    'record both goals and accept them',
    'try to activate the dependent goal before its dependency completes',
    'evaluate a real operation, cite it as evidence and complete the dependency',
    'activate the dependent goal and read both goals',
  ],
  expected: {
    result: 'the dependent goal cannot become active while its dependency is only accepted, and it activates once that dependency is completed against a verified audit operation',
    acceptance: [
      'the early activation exits 1 and names the dependency and its status',
      'the dependent goal stays accepted with no criteria satisfied',
      'completion of the dependency is checked against the audit log',
      'activation succeeds only after the dependency is completed',
    ],
  },
  async run(ctx) {
    const dependency = goalId(await ctx.cli(['goal', 'add', 'Confirm the arithmetic result', '--criterion', 'the result is two'], { label: 'goal add (dependency)' }));
    const dependent = goalId(await ctx.cli(['goal', 'add', 'Publish the confirmed result', '--criterion', 'the result is published', '--depends-on', dependency], { label: 'goal add (dependent)' }));
    await ctx.cli(['goal', 'update', dependency, 'accepted'], { label: 'dependency accepted' });
    await ctx.cli(['goal', 'update', dependent, 'accepted'], { label: 'dependent accepted' });

    const early = await ctx.cli(['goal', 'update', dependent, 'active'], { label: 'dependent activation before its dependency completes' });
    const dependentBefore = await ctx.cli(['goal', 'show', dependent], { label: 'dependent goal show (blocked)' });

    await ctx.cli(['goal', 'update', dependency, 'active'], { label: 'dependency active' });
    const evaluated = await ctx.cli(['ask', 'calc 1+1'], { label: 'calculate the verified operation' });
    const operation = operationId(evaluated);
    const evidence = await ctx.cli(['goal', 'evidence', dependency, '--criterion', 'c1', '--kind', 'supports', '--operation', operation], { label: 'dependency evidence' });
    const completed = await ctx.cli(['goal', 'complete', dependency], { label: 'dependency complete' });
    const activated = await ctx.cli(['goal', 'update', dependent, 'active'], { label: 'dependent activation after the dependency completes' });
    const dependencyAfter = await ctx.cli(['goal', 'show', dependency], { label: 'dependency goal show (completed)' });
    const dependentAfter = await ctx.cli(['goal', 'show', dependent], { label: 'dependent goal show (active)' });

    ctx.record('early activation', oneLine(early.rawStdout, 300));
    ctx.record('dependency completion', oneLine(completed.rawStdout, 300));
    ctx.record('dependent activation', oneLine(activated.rawStdout, 300));
    ctx.measure('verified operation', evaluated.durationMs);
    ctx.measure('goal completion check', completed.durationMs);

    const refusal = new RegExp(`refused: dependency goal [0-9a-f-]+ is accepted, not completed`).test(early.rawStdout);
    const stillAccepted = /status: accepted/.test(dependentBefore.rawStdout) && /0 of 1 criterion/.test(dependentBefore.rawStdout)
      && dependentBefore.rawStdout.includes(dependency);
    const completionChecked = /Completion was checked against the audit log, not asserted/.test(completed.rawStdout)
      && /1 of 1 criterion\(s\) satisfied/.test(dependencyAfter.rawStdout)
      && /status: completed/.test(dependencyAfter.rawStdout);
    const activatedAfter = activated.code === 0 && /is now active \(was accepted\)/.test(activated.rawStdout)
      && /status: active/.test(dependentAfter.rawStdout) && /Depends on: [0-9a-f]+/.test(dependentAfter.rawStdout);

    return {
      actual: `early exit=${early.code}; refusal=${refusal}; still accepted=${stillAccepted}; completion checked=${completionChecked}; activated=${activatedAfter}`,
      checks: {
        correctness: check(
          refusal && activatedAfter,
          'activation is refused while the dependency is incomplete and succeeds after it is completed',
          { refusal, activatedAfter },
        ),
        completeness: check(
          completionChecked && /1 evidence record\(s\); latest supports of [0-9a-f]+/.test(dependencyAfter.rawStdout),
          'the completed dependency cites the verified operation as its recorded evidence',
          { completion: oneLine(completed.rawStdout, 240) },
        ),
        reliability: check(
          early.code === 1 && [completed, evidence, activated, dependencyAfter, dependentAfter, dependentBefore, evaluated].every((row) => row.code === 0),
          'only the refused activation exits 1; every other process exits 0',
          { early: early.code, completed: completed.code, activated: activated.code },
        ),
        safety: check(
          stillAccepted && /status: active/.test(dependentAfter.rawStdout) && /no evidence recorded/.test(dependentAfter.rawStdout),
          'the dependent goal was not advanced by the refusal and its own criterion still has no evidence after activation',
          { dependent: oneLine(dependentAfter.rawStdout, 260) },
        ),
        continuity: check(
          dependentAfter.rawStdout.includes(dependency) && dependencyAfter.rawStdout.includes(dependent) === false,
          'a later process reads the dependency identifier recorded by the earlier ones',
          { dependentBefore: oneLine(dependentBefore.rawStdout, 200) },
        ),
        ux: check(
          /is accepted, not completed/.test(early.rawStdout) && /this changes the goal record only\. It authorizes no action/.test(activated.rawStdout),
          'the refusal names the actual dependency status and activation claims no authority to act',
          { activation: oneLine(activated.rawStdout, 240) },
        ),
      },
      metrics: { dependencyGoalId: dependency, dependentGoalId: dependent, operationId: operation },
    };
  },
};

const providerOutage = {
  id: 'ex-06-provider-outage',
  category: 'real-world',
  area: 'executive',
  workflow: 'H',
  title: 'A provider whose source disappears fails in a bounded way and recovers',
  intent: 'Poll a configured filesystem provider, remove the directory it observes, confirm the failure is reported with a retry time and changes nothing, then restore the directory and poll again.',
  preconditions: ['a configured and enabled filesystem provider observing a pilot directory', 'the application workspace root is a different directory'],
  steps: [
    'configure and enable the provider, then poll once',
    'delete the observed directory',
    'poll again and read provider status',
    'restore the directory and poll again',
  ],
  expected: {
    result: 'the missing directory produces a reported provider failure with a retry time, no tasks or plans, and the provider succeeds again once the directory is back',
    acceptance: [
      'the first poll accepts one observation',
      'the poll with the directory gone exits 1 and names the failure and retry time',
      'provider status records the last error while the earlier success remains',
      'no task or plan is created and the application does not crash',
      'a later poll after restoration succeeds again',
    ],
  },
  async setup(ctx) {
    ctx.write('observed/source.txt', 'status: green\n');
  },
  async run(ctx) {
    const observed = path.join(ctx.filesDir, 'observed');
    const configured = await ctx.cli(['source', 'configure', 'filesystem', '--root', observed, '--extension', 'txt', '--max-files', '20'], { label: 'source configure' });
    const enabled = await ctx.cli(['source', 'enable', 'filesystem'], { label: 'source enable' });
    const first = await ctx.cli(['source', 'poll', 'filesystem'], { label: 'poll before the outage' });

    fs.rmSync(observed, { recursive: true, force: true });
    const failed = await ctx.cli(['source', 'poll', 'filesystem', '--force'], { label: 'poll during the outage' });
    const status = await ctx.cli(['source', 'status', 'filesystem'], { label: 'source status during the outage' });
    const tasks = await ctx.cli(['task', 'list'], { label: 'task list during the outage' });
    const plans = await ctx.cli(['plan', 'list'], { label: 'plan list during the outage' });

    ctx.write('observed/source.txt', 'status: green\n');
    const recovered = await ctx.cli(['source', 'poll', 'filesystem', '--force'], { label: 'poll after restoration' });
    const statusAfter = await ctx.cli(['source', 'status', 'filesystem'], { label: 'source status after restoration' });

    // A provider failure is reported on stderr: the operator reads the same terminal either way.
    const failureText = `${failed.rawStdout}${failed.rawStderr}`;

    ctx.record('first poll', oneLine(first.rawStdout, 240));
    ctx.record('outage poll', oneLine(failureText, 300));
    ctx.record('recovered poll', oneLine(recovered.rawStdout, 240));
    ctx.measure('provider poll (healthy)', first.durationMs);
    ctx.measure('provider poll (failed)', failed.durationMs);

    const firstCounts = pollCounts(first);
    const failedBounded = failed.code === 1
      && /filesystem failed: root observed-\d+ cannot be read: ENOENT; retry at \d{4}-\d{2}-\d{2}T/.test(failureText)
      && !/ECONN|EPIPE|unhandled/i.test(failureText);
    const statusTruthful = /last error: root observed-\d+ cannot be read: ENOENT/.test(status.rawStdout)
      && /last success \d{4}-\d{2}-\d{2}T/.test(status.rawStdout);
    const nothingRan = tasks.rawStdout.includes('No tasks yet.') && plans.rawStdout.includes('No plans yet.');
    const recovery = recovered.code === 0 && pollCounts(recovered)?.observed === 1
      && /last success \d{4}-\d{2}-\d{2}T/.test(statusAfter.rawStdout);

    return {
      actual: `first=${firstCounts?.accepted ?? 'unknown'} accepted; outage exit=${failed.code}; status records error=${statusTruthful}; tasks/plans untouched=${nothingRan}; recovered=${recovery}`,
      checks: {
        correctness: check(
          firstCounts?.accepted === 1 && failedBounded && recovery,
          'the provider works, fails honestly when its source vanishes, and works again after restoration',
          { firstCounts, failedBounded, recovery },
        ),
        completeness: check(
          statusTruthful,
          'provider status keeps both the earlier success and the recorded failure',
          { status: oneLine(status.rawStdout, 400) },
        ),
        reliability: check(
          [configured, enabled, first, status, tasks, plans, recovered, statusAfter].every((row) => row.code === 0) && failed.code === 1,
          'the expected failure is the only nonzero exit and every other process exits 0',
          { exits: { configured: configured.code, first: first.code, failed: failed.code, recovered: recovered.code } },
        ),
        safety: check(
          nothingRan && /counts: 2 poll\(s\), 1 accepted/.test(status.rawStdout),
          'a provider outage creates no work and its single failed poll does not fabricate observations',
          { tasks: oneLine(tasks.rawStdout, 120), plans: oneLine(plans.rawStdout, 120) },
        ),
        continuity: check(
          /checkpoint keys: \d+ \| last checkpoint/.test(status.rawStdout),
          'the checkpoint written before the outage is still readable during and after it',
          { status: oneLine(status.rawStdout, 320) },
        ),
        ux: check(
          /retry at \d{4}-\d{2}-\d{2}T/.test(failureText) && failureText.trim().split('\n').length === 1,
          'the failure is one bounded line naming the cause and when the provider will retry',
          { line: lastLine(failureText) },
        ),
      },
      metrics: { firstAccepted: firstCounts?.accepted ?? null, recoveredAccepted: pollCounts(recovered)?.accepted ?? null },
    };
  },
};

const sustainedRuntime = {
  id: 'ex-07-sustained-runtime',
  category: 'real-world',
  area: 'executive',
  workflow: 'I',
  title: 'The runtime keeps ticking under real scheduling and survives a restart',
  intent: 'Run the real runtime process long enough to observe many ticks, bounded queue and memory, stop it from another process, restart it and confirm the tick count and identity continue.',
  preconditions: ['an idle isolated data directory'],
  steps: [
    'start the runtime in the foreground with a short interval',
    'observe ticks, queue and process memory over several seconds',
    'stop it from a second process and wait for the first to exit',
    'start it again and read the lifecycle and tick count',
  ],
  expected: {
    result: 'the runtime completes at least twelve ticks with no backlog, its memory stays bounded, it stops cleanly from another process, and a restart continues the same runtime identity',
    acceptance: [
      'at least 12 ticks are observed while the background is empty',
      'checkpoint backlog, retries, dead letters and interruptions stay 0',
      'the foreground process exits 0 after an external stop',
      'a restart reports boot 2 and more ticks than the first run, with the same runtime identifier',
      'memory samples are available and below a generous bound',
    ],
  },
  async run(ctx) {
    const first = ctx.launch(['runtime', 'start', '--interval', '120'], { marker: 'ms cycle.', label: 'runtime start (boot 1)' });
    await first.ready;
    const startedAt = Date.now();
    const readyAt = Date.now() - Date.parse(first.handle.startedAt);
    const firstPhase = await waitForTicks(ctx, 12, 25000);
    const memoryEarly = await ctx.processMemory(first.handle.pid);
    await sleep(1200);
    const memoryLate = await ctx.processMemory(first.handle.pid);
    const bytesLive = ctx.dataBytes();

    const stopStarted = Date.now();
    const stopped = await ctx.cli(['runtime', 'stop', '--reason', 'pilot sustained run finished'], { label: 'runtime stop (external)' });
    const exited = await Promise.race([first.handle.exited, sleep(15000).then(() => null)]);
    const shutdownMs = Date.now() - stopStarted;
    const statusStopped = await ctx.cli(['runtime', 'status'], { label: 'runtime status after the stop' });
    const runtimeId = (first.handle.stdout().match(/^Runtime ([0-9a-f-]{36}) started/) ?? [])[1] ?? null;

    const second = ctx.launch(['runtime', 'start', '--interval', '150'], { marker: 'boot 2', label: 'runtime start (boot 2)' });
    await second.ready;
    const secondPhase = await waitForTicks(ctx, (firstPhase.ticks ?? 0) + 5, 20000);
    const stoppedAgain = await ctx.cli(['runtime', 'stop', '--reason', 'pilot restart finished'], { label: 'runtime stop (after restart)' });
    const exitedAgain = await Promise.race([second.handle.exited, sleep(15000).then(() => null)]);
    const finalStatus = await ctx.cli(['runtime', 'status'], { label: 'runtime status (final)' });

    ctx.record('first status', oneLine(firstPhase.status?.rawStdout, 500));
    ctx.record('restarted status', oneLine(secondPhase.status?.rawStdout, 500));
    ctx.record('memory samples', { early: memoryEarly, late: memoryLate });

    const elapsedFirst = firstPhase.elapsedMs;
    ctx.measure('runtime readiness (marker)', readyAt);
    ctx.measure('ticks observed (boot 1)', firstPhase.ticks);
    ctx.measure('elapsed to observe those ticks', elapsedFirst);
    ctx.measure('shutdown after external stop', shutdownMs);
    ctx.measure('runtime memory (early)', memoryEarly, null, 'bytes');
    ctx.measure('runtime memory (late)', memoryLate, null, 'bytes');
    ctx.measure('runtime storage during the run', bytesLive, null, 'bytes');

    const ticksFirst = firstPhase.ticks ?? 0;
    const ticksSecond = secondPhase.ticks ?? 0;
    const runtimeIdSecond = (second.handle.stdout().match(/^Runtime ([0-9a-f-]{36}) started/) ?? [])[1] ?? null;
    const boundedQueue = /checkpoint: \d+\/\d+ processed, \d+\/\d+ published \| backlog 0/.test(secondPhase.status?.rawStdout ?? '')
      && /retries: 0 \| dead letters: 0 \| interrupted: 0/.test(secondPhase.status?.rawStdout ?? '');
    const cleanStop = stopped.code === 0 && exited !== null && exited.code === 0
      && /is stopped/.test(statusStopped.rawStdout) && /Runtime stopped at/.test(stopped.rawStdout);
    const restarted = secondPhase.ticks !== null && ticksSecond > ticksFirst
      && /boot 2/.test(secondPhase.status?.rawStdout ?? '') && runtimeIdSecond === runtimeId
      && /is stopped/.test(finalStatus.rawStdout);
    const memoryBounded = typeof memoryEarly === 'number' && typeof memoryLate === 'number'
      && memoryEarly > 0 && memoryLate > 0 && memoryEarly < 1024 * 1024 * 1024 && memoryLate < 1024 * 1024 * 1024
      && memoryLate - memoryEarly < 256 * 1024 * 1024;

    return {
      actual: `ticks boot1=${ticksFirst} boot2=${ticksSecond}; id stable=${runtimeIdSecond === runtimeId}; clean stop=${cleanStop}; queue bounded=${boundedQueue}; memory early=${memoryEarly} late=${memoryLate}; shutdown=${shutdownMs} ms`,
      checks: {
        correctness: check(
          ticksFirst >= 12 && restarted,
          'the runtime ticks repeatedly, stops cleanly and continues after a restart with the same identity',
          { ticksFirst, ticksSecond, runtimeId, runtimeIdSecond },
        ),
        completeness: check(
          boundedQueue && cleanStop && /The runtime was stopped from another process/.test(first.handle.stdout()),
          'queue, retries and interruptions stay at zero and the external stop is acknowledged by both processes',
          { boundedQueue, stopOutput: lastLine(first.handle.stdout()) },
        ),
        reliability: check(
          stopped.code === 0 && exited?.code === 0 && stoppedAgain.code === 0 && exitedAgain?.code === 0 && finalStatus.code === 0,
          'both foreground runs exit 0 after their external stop and the final status is readable',
          { exits: { stopped: stopped.code, firstProcess: exited?.code ?? null, stoppedAgain: stoppedAgain.code, secondProcess: exitedAgain?.code ?? null } },
        ),
        safety: check(
          ticksFirst >= 12 && /active plans: 0 \| schedule entries: 0/.test(firstPhase.status?.rawStdout ?? '')
            && /notifications: 0 active/.test(firstPhase.status?.rawStdout ?? ''),
          'sustained ticking on an empty background created no plans, schedule entries or notifications',
          { status: oneLine(firstPhase.status?.rawStdout, 320) },
        ),
        continuity: check(
          runtimeId !== null && runtimeIdSecond === runtimeId && ticksSecond > ticksFirst,
          'the restarted process reports the same runtime identifier and a tick count that continued rather than reset',
          { runtimeId, runtimeIdSecond, ticksFirst, ticksSecond },
        ),
        ux: check(
          /is running \| boot 1 \| ticks \d+/.test(firstPhase.status?.rawStdout ?? '')
            && /is running \| boot 2 \| ticks \d+/.test(secondPhase.status?.rawStdout ?? '')
            && firstPhase.status.rawStdout.split('\n').length >= 6,
          'status reports lifecycle, boot, ticks, queue, lease and schedule in a bounded readable block',
          { first: oneLine(firstPhase.status?.rawStdout, 260) },
        ),
      },
      metrics: {
        ticksBoot1: ticksFirst,
        ticksBoot2: ticksSecond,
        shutdownMs,
        memoryEarlyBytes: memoryEarly,
        memoryLateBytes: memoryLate,
      },
    };
  },
};

const damagedRuntimeState = {
  id: 'ex-08-runtime-recovery',
  category: 'real-world',
  area: 'executive',
  workflow: 'J',
  title: 'A damaged runtime checkpoint is quarantined and the audit record survives',
  intent: 'Damage the runtime state file, confirm a later process quarantines it and reports the problem without losing audit records, then restart the runtime.',
  preconditions: ['a runtime that has run and stopped, leaving a checkpoint and audit records'],
  steps: [
    'record an audited operation and run the runtime briefly',
    'overwrite runtime.json with invalid JSON',
    'read runtime status and diagnose',
    'restart the runtime and read the audit afterwards',
  ],
  expected: {
    result: 'the damaged checkpoint is preserved under a quarantine name, diagnose names that path, the runtime restarts under a new identity, and the audit records are unchanged',
    acceptance: [
      'a runtime.corrupt-*.json file exists and runtime.json is replaced',
      'runtime status exits 0 with a new identity and no ticks',
      'runtime diagnose exits 1 and reports where the damaged checkpoint was preserved',
      'the audit record count is identical before and after the damage',
      'a restarted runtime reaches ticks and stops cleanly',
    ],
  },
  async run(ctx) {
    const calculated = await ctx.cli(['ask', 'calc 2+3'], { label: 'audited operation' });
    const stored = await ctx.cli(['knowledge', 'add', '--subject', 'Runtime', '--relationship', 'state', '--object', 'persisted'], { label: 'audited knowledge write' });
    const first = ctx.launch(['runtime', 'start', '--interval', '150'], { marker: 'ms cycle.', label: 'runtime start (before damage)' });
    await first.ready;
    await waitForTicks(ctx, 3, 15000);
    await ctx.cli(['runtime', 'stop', '--reason', 'prepare the recovery check'], { label: 'runtime stop (before damage)' });
    await Promise.race([first.handle.exited, sleep(10000)]);
    const priorId = (first.handle.stdout().match(/^Runtime ([0-9a-f-]{36}) started/) ?? [])[1] ?? null;

    const auditBefore = ctx.countLines('operations.jsonl');
    const statePath = ctx.dataFile('runtime.json');
    const stateExisted = fs.existsSync(statePath);
    fs.writeFileSync(statePath, '{"runtimeId": "torn');

    // Diagnose first: reading the damaged file is what preserves it under the quarantine name, so
    // this is the process that must report the path. Status afterwards reads the fresh state.
    const diagnose = await ctx.cli(['runtime', 'diagnose'], { label: 'runtime diagnose after damage' });
    const quarantined = ctx.dataTree().filter((name) => /^runtime\.corrupt-.*\.json$/.test(path.posix.basename(name)));
    const status = await ctx.cli(['runtime', 'status'], { label: 'runtime status after damage' });
    const auditAfter = ctx.countLines('operations.jsonl');
    const auditHealth = await ctx.cli(['audit', 'health'], { label: 'audit health after recovery' });

    const restarted = ctx.launch(['runtime', 'start', '--interval', '150'], { marker: 'ms cycle.', label: 'runtime start (after recovery)' });
    await restarted.ready;
    const recovered = await waitForTicks(ctx, 4, 15000);
    const stopped = await ctx.cli(['runtime', 'stop', '--reason', 'recovery check finished'], { label: 'runtime stop (after recovery)' });
    const exited = await Promise.race([restarted.handle.exited, sleep(10000)]);
    const finalStatus = await ctx.cli(['runtime', 'status'], { label: 'runtime status (final)' });

    const newId = (restarted.handle.stdout().match(/^Runtime ([0-9a-f-]{36}) started/) ?? [])[1] ?? null;
    ctx.record('damaged checkpoint diagnose', oneLine(diagnose.rawStdout, 500));
    ctx.record('quarantine', quarantined);
    ctx.record('restarted status', oneLine(recovered.status?.rawStdout, 400));
    ctx.measure('recovery to a readable status', status.durationMs);
    ctx.measure('restart readiness (marker)', Date.now() - Date.parse(restarted.handle.startedAt));

    const preserved = stateExisted && quarantined.length === 1
      && /runtime\.corrupt-/.test(diagnose.rawStdout)
      && status.code === 0 && /is stopped \| boot 0 \| ticks 0/.test(status.rawStdout)
      && newId !== null && newId !== priorId;
    // Two audited operations ran before the damage, so two records must survive it.
    const auditIntact = auditBefore >= 2 && auditAfter === auditBefore
      && auditHealth.code === 0 && /Corrupt lines:\s+0/.test(auditHealth.rawStdout)
      && /Records:\s+\d+ readable operation record/.test(auditHealth.rawStdout);
    const restartedFine = stopped.code === 0 && exited?.code === 0
      && (recovered.ticks ?? 0) >= 4 && /is stopped/.test(finalStatus.rawStdout);

    return {
      actual: `quarantined=${quarantined.length}; prior id ${priorId} -> new id ${newId}; diagnose exit=${diagnose.code}; audit ${auditBefore} -> ${auditAfter}; restarted ticks=${recovered.ticks}`,
      checks: {
        correctness: check(
          preserved && restartedFine,
          'the damaged state is preserved and replaced, and the runtime runs again',
          { preserved, restartedFine },
        ),
        completeness: check(
          auditIntact,
          'the operation audit is byte-count stable across the recovery and reports no corrupt lines',
          { auditBefore, auditAfter, audit: oneLine(auditHealth.rawStdout, 260) },
        ),
        reliability: check(
          [status, auditHealth, stopped, finalStatus].every((row) => row.code === 0) && diagnose.code === 1,
          'reads and restarts exit 0 while diagnose exits 1 because it found the real problem',
          { status: status.code, diagnose: diagnose.code, stopped: stopped.code },
        ),
        safety: check(
          quarantined.length === 1 && stateExisted && !/remove|delete/i.test(diagnose.rawStdout),
          'the damaged file is preserved under a new name rather than deleted or silently overwritten',
          { quarantined },
        ),
        continuity: check(
          auditAfter === auditBefore && auditAfter >= 2 && newId !== null,
          'audit records written before the damage are all still readable after it',
          { auditBefore, auditAfter },
        ),
        ux: check(
          /\[FAIL\] checkpoint readable: the runtime checkpoint is not valid JSON; preserved at /.test(diagnose.rawStdout)
            && /may be re-read|preserved/.test(diagnose.rawStdout),
          'diagnose names the damaged checkpoint and the exact path where it was preserved',
          { line: oneLine(diagnose.rawStdout.split('\n').find((line) => line.includes('checkpoint readable')) ?? '', 320) },
        ),
      },
      metrics: { priorRuntimeId: priorId, newRuntimeId: newId, auditRecords: auditAfter },
    };
  },
};

export default [
  continuityAcrossSessions,
  requirementsChange,
  correctionPreserved,
  conflictingSources,
  blockedDependency,
  providerOutage,
  sustainedRuntime,
  damagedRuntimeState,
];
