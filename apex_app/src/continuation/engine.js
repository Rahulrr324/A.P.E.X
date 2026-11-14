// Deterministic continuation engine.
//
// It ranks the work the records already describe: an interrupted task that must be resolved
// from its own audit record, an approval the user still owes, an approved plan that is ready
// to start, a draft that needs review, a blocked goal or plan, a completed run that has not
// been reconciled. It never executes the recommendation, and it never invents a priority, a
// deadline, or an outcome: a missing priority or deadline is reported as absent.
//
// Every candidate carries the rules that placed it and the conditions that block it, and every
// record the ranking excluded carries the reason it was excluded. The ordering is a pure
// function of the records, so the same state always produces the same answer.
import { shortId, truncate } from '../util.js';
import { goalProgress, isOpenStatus } from '../goals/model.js';
import { isOpenPlan, planProgress, planRisk } from '../plans/model.js';
import { ContinuationReadiness } from '../executive/vocabulary.js';
import { CAUTION_NOTE, cautionLine } from '../prediction/caution.js';

// A lower number is treated as more urgent. The recorded priority is used as given; a goal
// without one is never assigned one.
export const PRIORITY_RULE = 'explicit user priority, where 1 is most urgent';

const KIND_ORDER = { task: 0, plan: 1, goal: 2 };

const BASE = {
  'resolve-uncertain': 100,
  'resolve-interrupted': 95,
  'approve-step': 90,
  'accept-goal': 85,
  'review-contradiction': 80,
  // A run the records prove stopped with untouched steps outranks starting an untouched plan: the
  // steps already paid for are in it, and its approval, registry answer and constraints have just
  // been re-read once more than any other candidate's. It sits under the three states that settle
  // what is unknown, because an unknown outcome is settled before more work is added to a run.
  'continue-plan': 78,
  'start-plan': 75,
  'resume-task': 70,
  'reconcile-plan': 65,
  // A recorded contradicted expectation asks for one read before an approved plan is started. It sits
  // under every execution step because it replaces no work: when it applies it takes `start-plan`'s
  // place for that plan, and its lower base is what moves the plan down the ranking. It is a read, so
  // the weight it is scored at is the weight of looking again, not of running anything.
  'review-expectation': 62,
  'review-plan': 60,
  'create-plan': 55,
  'resolve-blocker': 50,
  'review-failure': 40,
  'review-closed': 20,
};

// The readiness state each plan action is read from, in the words `executive/readiness.js` uses for
// the seven. The engine cannot call that module - readiness reads this file's own ordering rule - so
// the states are named here for the branches that carry the records that support them, and a
// candidate whose readiness is not one of the seven is returned with `null` rather than a guess.
const ACTION_READINESS = {
  'continue-plan': ContinuationReadiness.READY_TO_CONTINUE,
  'start-plan': ContinuationReadiness.READY_TO_EXECUTE,
  'review-plan': ContinuationReadiness.READY_FOR_APPROVAL,
  'reconcile-plan': ContinuationReadiness.WAITING_FOR_EVIDENCE,
  'resolve-blocker': ContinuationReadiness.BLOCKED,
};

function priorityWeight(priority) {
  if (!Number.isInteger(priority)) return { weight: 0, note: 'no priority is recorded' };
  return { weight: (6 - Math.min(5, Math.max(1, priority))) * 2, note: `priority ${priority}` };
}

function deadlineWeight(deadline, now) {
  if (!deadline) return { weight: 0, note: null };
  const at = Date.parse(deadline);
  if (Number.isNaN(at)) return { weight: 0, note: `deadline ${deadline} could not be read` };
  const days = Math.ceil((at - now.getTime()) / 86400000);
  if (days < 0) return { weight: 6, note: `deadline ${deadline} has passed` };
  if (days <= 7) return { weight: 4, note: `deadline ${deadline} is within 7 days` };
  if (days <= 30) return { weight: 2, note: `deadline ${deadline} is within 30 days` };
  return { weight: 0, note: `deadline ${deadline} is later than 30 days` };
}

function riskWeight(risk) {
  if (risk === 'high') return { weight: -3, note: 'high risk' };
  if (risk === 'medium') return { weight: -1, note: 'medium risk' };
  return { weight: 0, note: risk ? `${risk} risk` : null };
}

// The capabilities an approved plan's steps would run, from the step records themselves. A step's
// action is the capability the registry would authorize, so it is the one thing a recorded expectation
// about that capability can bear on. A step that names no action matches nothing. Exported because the
// readiness view and the controller scope their own expectation reads by the same rule.
export function planCapabilities(plan) {
  const capabilities = new Set();
  for (const step of plan?.steps ?? []) {
    if (typeof step?.action === 'string' && step.action.trim() !== '') capabilities.add(step.action.trim());
  }
  return [...capabilities];
}

// The cautions that bear on one plan. The caller derived them from the prediction ledger; this side
// reads no ledger, so a caution ranked here cannot disagree with the read that produced it.
function cautionsForPlan(plan, cautions) {
  if (!Array.isArray(cautions) || cautions.length === 0) return [];
  const capabilities = new Set(planCapabilities(plan));
  return cautions.filter((caution) => caution && capabilities.has(caution.capability));
}

function candidate({
  kind, ref, title, action, command, status, priority = null, deadline = null,
  risk = null, requiresAuthorization = true, reasons = [], blockers = [], ready = true, now,
  readiness = null, cautions = [], cautionChangedAction = false,
}) {
  const p = priorityWeight(priority);
  const d = deadlineWeight(deadline, now);
  const r = riskWeight(risk);
  const score = (BASE[action] ?? 0) + p.weight + d.weight + r.weight;
  return {
    id: `${kind}:${ref}:${action}`,
    kind,
    ref,
    title,
    action,
    command,
    status: status ?? null,
    priority,
    deadline,
    risk,
    requiresAuthorization,
    ready,
    blockers,
    reasons: [...reasons, p.note, d.note, r.note].filter(Boolean),
    score,
    readiness: readiness ?? (kind === 'plan' ? ACTION_READINESS[action] ?? null : null),
    cautions: [...cautions],
    cautionChangedAction,
  };
}

function terminalGoal(goal) {
  return !isOpenStatus(goal.status);
}

function unmetDependencies(goal, goalsById) {
  const unmet = [];
  for (const dependencyId of goal.dependsOn ?? []) {
    const dependency = goalsById.get(dependencyId);
    if (!dependency) unmet.push(`dependency ${shortId(dependencyId)} does not exist`);
    else if (dependency.status !== 'completed') unmet.push(`dependency ${shortId(dependencyId)} is ${dependency.status}`);
  }
  return unmet;
}

// `validityByPlan` maps a plan id to the result of assessPlanValidity. It is optional; without
// it only the structural checks below are applied.
//
// `continuationsByPlan` maps a plan id to the result of `continuationOf` (src/plans/continuation.js).
// It is optional in the same way, and it is the only source this ranking will accept for the
// `ready to continue` state: a plan status and a task status cannot show that a step never started,
// and the reading can. Without a reading the interrupted run is ranked by its task and plan records
// alone, which is what Batch AL did, and no continuation is claimed.
// `cautions` is the bounded read of live, current contradicted expectations (`expectationCautions` on
// the prediction store). It is optional and defaulted to empty: a caller without a prediction ledger
// ranks exactly as before. Where one applies to an approved plan, the recommendation is still an act
// on that plan but a read rather than a start, and nothing about the plan's approval, its readiness, or
// the registry's authorization moves.
export function buildContinuation({
  goals = [], plans = [], tasks = [], validityByPlan = new Map(), continuationsByPlan = new Map(),
  cautions = [], now = new Date(),
} = {}) {
  const candidates = [];
  const excluded = [];
  const notes = [];
  const goalsById = new Map(goals.map((g) => [g.id, g]));
  const plansById = new Map(plans.map((p) => [p.id, p]));
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const plansByTask = new Map();
  const plansByGoal = new Map();
  for (const plan of plans) {
    if (plan.activation?.taskId) plansByTask.set(plan.activation.taskId, plan);
    const list = plansByGoal.get(plan.goalId) ?? [];
    list.push(plan);
    plansByGoal.set(plan.goalId, list);
  }

  // ---- tasks ---------------------------------------------------------------
  for (const task of tasks) {
    const plan = plansByTask.get(task.id) ?? null;
    const planNote = plan ? `plan ${shortId(plan.id)}` : null;
    const uncertain = task.steps.filter((s) => s.status === 'uncertain').map((s) => s.id);
    const awaiting = task.steps.filter((s) => s.status === 'awaiting_approval').map((s) => s.id);
    const failed = task.steps.filter((s) => s.status === 'failed').map((s) => s.id);

    if (task.status === 'running') {
      candidates.push(candidate({
        kind: 'task', ref: task.id, action: 'resolve-interrupted',
        title: `Resolve interrupted task ${shortId(task.id)}${planNote ? ` (${planNote})` : ''}`,
        command: `node bin/apex.js task resume ${shortId(task.id)}`,
        status: task.status, requiresAuthorization: true,
        reasons: ['the record says running, but no live process holds its lock', 'each interrupted step is resolved from its own audit record'],
        blockers: uncertain.length > 0 ? [`step(s) ${uncertain.join(', ')} have no confirmed outcome`] : [],
        now,
      }));
      continue;
    }
    if (uncertain.length > 0) {
      candidates.push(candidate({
        kind: 'task', ref: task.id, action: 'resolve-uncertain',
        title: `Resolve uncertain step(s) of task ${shortId(task.id)}${planNote ? ` (${planNote})` : ''}`,
        command: `node bin/apex.js task explain ${shortId(task.id)} recovery`,
        status: task.status, requiresAuthorization: false,
        reasons: ['a step may or may not have happened; no retry is safe without resolving it'],
        blockers: [`step(s) ${uncertain.join(', ')} are uncertain`],
        now,
      }));
    }
    if (task.status === 'proposed') {
      candidates.push(candidate({
        kind: 'task', ref: task.id, action: 'approve-step',
        title: `Review proposed task ${shortId(task.id)}`,
        command: `node bin/apex.js task show ${shortId(task.id)}`,
        status: task.status, requiresAuthorization: true,
        reasons: ['the task came from a model proposal and waits for your approval'],
        now,
      }));
    } else if (awaiting.length > 0) {
      candidates.push(candidate({
        kind: 'task', ref: task.id, action: 'approve-step',
        title: `Approve step(s) ${awaiting.join(', ')} of task ${shortId(task.id)}`,
        command: `node bin/apex.js task approve ${shortId(task.id)} --step ${awaiting[0]}`,
        status: task.status, requiresAuthorization: true,
        reasons: ['a step is waiting for explicit user approval'],
        now,
      }));
    } else if (task.status === 'pending' || task.status === 'paused') {
      // One run, one ranking place. Where the continuation reading of the plan this task runs says
      // the run may be taken up, that candidate is the one printed: it names `plan continue`, which
      // re-reads the approval, the registry, the constraints and every interrupted step's own record
      // before it runs anything, while `task resume` does not. The task is listed as excluded, with
      // that reason, so the reader can see the other command was not forgotten.
      const reading = plan ? continuationsByPlan.get(plan.id) ?? null : null;
      const readingHeld = (reading?.continue?.awaiting ?? []).length > 0
        || (reading?.continue?.blockedByRun ?? []).length > 0;
      if (reading?.continue?.safe === true && reading?.task?.lock?.alive !== true && !readingHeld) {
        excluded.push({
          kind: 'task', ref: task.id, title: `task ${shortId(task.id)}`,
          reason: `its run is ranked as the plan's continuation work (plan ${shortId(plan.id)}), which re-validates the approval, the registry and the constraints before anything runs`,
        });
      } else {
        candidates.push(candidate({
          kind: 'task', ref: task.id, action: 'resume-task',
          title: `Resume ${task.status} task ${shortId(task.id)}${planNote ? ` (${planNote})` : ''}`,
          command: `node bin/apex.js task resume ${shortId(task.id)}`,
          status: task.status, requiresAuthorization: true,
          reasons: ['the task is not finished and no step is uncertain'],
          now,
        }));
      }
    }
    if (failed.length > 0 || task.status === 'failed') {
      candidates.push(candidate({
        kind: 'task', ref: task.id, action: 'review-failure',
        title: `Review failed work in task ${shortId(task.id)}${planNote ? ` (${planNote})` : ''}`,
        command: `node bin/apex.js task explain ${shortId(task.id)} why`,
        status: task.status, requiresAuthorization: false,
        reasons: ['a failure is recorded; nothing retries automatically'],
        blockers: failed.length > 0 ? [`step(s) ${failed.join(', ')} failed`] : ['the task failed'],
        now,
      }));
    }
    if (task.status === 'completed' || task.status === 'cancelled') {
      excluded.push({ kind: 'task', ref: task.id, title: `task ${shortId(task.id)}`, reason: `already ${task.status}` });
    }
  }

  // ---- plans ---------------------------------------------------------------
  for (const plan of plans) {
    const goal = plan.goalId ? goalsById.get(plan.goalId) : null;
    const validity = validityByPlan.get(plan.id) ?? null;
    const progress = planProgress(plan);
    const risk = planRisk(plan.steps);
    const task = plan.activation?.taskId ? tasksById.get(plan.activation.taskId) ?? null : null;
    const base = {
      kind: 'plan', ref: plan.id, status: plan.status, risk,
      priority: goal?.priority ?? null, deadline: goal?.deadline ?? null, now,
      title: `Plan ${shortId(plan.id)}: ${truncate(plan.outcome, 90)}`,
    };

    if (plan.status === 'approved') {
      const blockers = validity ? [...validity.problems] : [];
      const stale = validity && !validity.ok;
      // A caution applies only when the plan could otherwise be started: a stale plan is already held
      // for revalidation, and adding the caution's read in front of that would name an act the records
      // do not recommend first. The plan is still ranked here, still approved, and still startable.
      const planCautions = cautionsForPlan(plan, cautions);
      const caution = planCautions.length > 0 && !stale;
      const cautioned = planCautions.map((c) => c.capability);
      candidates.push(candidate({
        ...base,
        action: stale ? 'review-plan' : caution ? 'review-expectation' : 'start-plan',
        title: stale
          ? `Revalidate plan ${shortId(plan.id)} before starting it`
          : caution
            ? `Review what the records say about plan ${shortId(plan.id)} before starting it`
            : base.title,
        command: stale
          ? `node bin/apex.js plan validate ${shortId(plan.id)}`
          : caution
            // Both commands are reads. The candidates read names the goal's comparison, which is where a
            // user sees the expectations recorded for the plan's capabilities beside what happened.
            ? (plan.goalId
              ? `node bin/apex.js plan candidates ${shortId(plan.goalId)}`
              : `node bin/apex.js plan show ${shortId(plan.id)}`)
            : `node bin/apex.js plan start ${shortId(plan.id)}`,
        requiresAuthorization: caution ? false : true,
        reasons: [
          'the plan is approved and has not started',
          ...(validity && validity.ok ? ['live validation passed'] : []),
          ...(stale ? ['live state changed since approval; the approval cannot be reused'] : []),
          ...(caution
            ? [
              `a recorded expectation for ${[...new Set(cautioned)].join(', ')} was contradicted, and a fresh read still confirms the verdict`,
              'the caution changed the recommended act from starting the plan to reading the contradiction; it changed no readiness state, approval, or authorization',
            ]
            : []),
        ],
        blockers,
        ready: !stale,
        readiness: stale ? ContinuationReadiness.BLOCKED : ContinuationReadiness.READY_TO_EXECUTE,
        cautions: planCautions,
        cautionChangedAction: caution,
      }));
    } else if (plan.status === 'draft') {
      candidates.push(candidate({
        ...base,
        action: 'review-plan',
        command: `node bin/apex.js plan validate ${shortId(plan.id)}`,
        requiresAuthorization: false,
        reasons: ['the plan is a draft; it can be started only after explicit approval'],
        blockers: validity ? [...validity.problems] : [],
        now,
      }));
    } else if (plan.status === 'blocked') {
      candidates.push(candidate({
        ...base,
        action: 'resolve-blocker',
        title: `Resolve blocker on plan ${shortId(plan.id)}`,
        command: `node bin/apex.js plan reconcile ${shortId(plan.id)}`,
        requiresAuthorization: true,
        reasons: [plan.blockedReason ? `blocked: ${truncate(plan.blockedReason, 120)}` : 'the plan is blocked'],
        blockers: progress.failed || progress.uncertain || progress.skipped
          ? [`step outcomes: ${progress.failed} failed, ${progress.uncertain} uncertain, ${progress.skipped} skipped`]
          : [],
        now,
      }));
    } else if (plan.status === 'active') {
      // The continuation reading, when the caller handed one over, is what says whether this run's
      // untouched steps may be taken up. Nothing below reaches that claim without it, and the two
      // guards repeat the readiness view's: a live holder of the task lock owns the run, and a step
      // still waiting on the user or on an unmet dependency is something the run waits on, which is
      // not the same answer as ready. The ranking and the readiness answer read one rule.
      const reading = continuationsByPlan.get(plan.id) ?? null;
      const heldBack = (reading?.continue?.awaiting ?? []).length > 0
        || (reading?.continue?.blockedByRun ?? []).length > 0;
      const continuable = reading?.continue?.safe === true
        && reading?.task?.lock?.alive !== true && !heldBack;
      if (!task) {
        candidates.push(candidate({
          ...base,
          action: 'resolve-blocker',
          title: `Plan ${shortId(plan.id)} is active but its task cannot be read`,
          command: 'node bin/apex.js recover',
          requiresAuthorization: false,
          reasons: ['the activation names a task that is not in the task records'],
          blockers: [`task ${shortId(plan.activation?.taskId ?? '')} cannot be read`],
          ready: false,
          now,
        }));
      } else if (continuable) {
        const runnable = reading.continue.runnable ?? [];
        const neverReplay = reading.continue.neverReplay ?? [];
        candidates.push(candidate({
          ...base,
          action: 'continue-plan',
          title: `Take up plan ${shortId(plan.id)}: ${runnable.length} step(s) its own records prove never started`,
          command: `node bin/apex.js plan continue ${shortId(plan.id)}`,
          requiresAuthorization: true,
          reasons: [
            `the run stopped with ${reading.progress.verified} of ${reading.progress.total} step(s) holding a verified outcome and ${runnable.join(', ')} never started`,
            `the reading re-read the plan bytes, the approval that binds them, the live registry, the goal's recorded constraints and dependencies over ${reading.revalidation.length} check(s), and none of them refused`,
            ...(neverReplay.length > 0
              ? [`step(s) ${neverReplay.join(', ')} will not be replayed: their effects cannot be established from their records`]
              : []),
            'a step that runs is authorized again by the registry at that moment; this ranking grants nothing',
          ],
          blockers: neverReplay.length > 0
            ? [`${neverReplay.length} step(s) of the same run are held back as never to be replayed`]
            : [],
          now,
        }));
      } else if (task.status === 'completed' && progress.completed !== progress.total) {
        candidates.push(candidate({
          ...base,
          action: 'reconcile-plan',
          title: `Reconcile plan ${shortId(plan.id)} with its finished task`,
          command: `node bin/apex.js plan reconcile ${shortId(plan.id)}`,
          requiresAuthorization: true,
          reasons: ['the task finished but the plan has not recorded every terminal outcome'],
          blockers: [
            `${progress.completed} of ${progress.total} step outcome(s) recorded`,
            ...(reading && reading.continue?.safe !== true ? reading.blockers ?? [] : []),
          ],
          now,
        }));
      } else {
        excluded.push({
          kind: 'plan', ref: plan.id, title: `plan ${shortId(plan.id)}`,
          reason: `active under task ${shortId(task.id)} (${task.status})${reading && reading.continue?.safe !== true
            ? `, and its continuation reading refuses to take the run up: ${(reading.blockers ?? [])[0] ?? 'no reason stated'}`
            : '; its execution state is the task candidate'}`,
        });
      }
    } else {
      excluded.push({
        kind: 'plan', ref: plan.id, title: `plan ${shortId(plan.id)}`,
        reason: `already ${plan.status}`,
      });
    }
  }

  // ---- goals ---------------------------------------------------------------
  for (const goal of goals) {
    const linked = (plansByGoal.get(goal.id) ?? []).filter((p) => isOpenPlan(p.status));
    const progress = goalProgress(goal);
    const deps = unmetDependencies(goal, goalsById);
    const base = {
      kind: 'goal', ref: goal.id, status: goal.status,
      priority: goal.priority, deadline: goal.deadline, now,
      title: `Goal ${shortId(goal.id)}: ${truncate(goal.request, 90)}`,
    };

    if (terminalGoal(goal)) {
      excluded.push({ kind: 'goal', ref: goal.id, title: `goal ${shortId(goal.id)}`, reason: `already ${goal.status}` });
      continue;
    }
    if (deps.length > 0) {
      candidates.push(candidate({
        ...base,
        action: 'resolve-blocker',
        title: `Goal ${shortId(goal.id)} is waiting on a dependency`,
        command: `node bin/apex.js goal show ${shortId(goal.id)}`,
        requiresAuthorization: false,
        reasons: ['a goal cannot become active until every dependency is completed'],
        blockers: deps,
        ready: false,
      }));
      continue;
    }
    if (goal.contradiction) {
      candidates.push(candidate({
        ...base,
        action: 'review-contradiction',
        title: `Review contradicted criterion ${goal.contradiction.criterionId} of goal ${shortId(goal.id)}`,
        command: `node bin/apex.js goal show ${shortId(goal.id)}`,
        requiresAuthorization: false,
        reasons: ['a criterion is contradicted; the goal cannot be completed as stated'],
        blockers: [`criterion ${goal.contradiction.criterionId} is contradicted`],
        now,
      }));
      continue;
    }
    if (goal.status === 'proposed') {
      candidates.push(candidate({
        ...base,
        action: 'accept-goal',
        command: `node bin/apex.js goal update ${shortId(goal.id)} accepted`,
        requiresAuthorization: true,
        reasons: ['the goal is recorded and waits for your acceptance'],
        now,
      }));
      continue;
    }
    if (goal.status === 'blocked') {
      candidates.push(candidate({
        ...base,
        action: 'resolve-blocker',
        title: `Resolve blocked goal ${shortId(goal.id)}`,
        command: `node bin/apex.js goal show ${shortId(goal.id)}`,
        requiresAuthorization: false,
        reasons: [goal.blockedReason ? `blocked: ${truncate(goal.blockedReason, 120)}` : 'the goal is blocked'],
        blockers: [goal.blockedReason ? truncate(goal.blockedReason, 160) : 'no reason was recorded'],
        now,
      }));
      continue;
    }
    if (linked.length > 0) {
      excluded.push({
        kind: 'goal', ref: goal.id, title: `goal ${shortId(goal.id)}`,
        reason: `an open plan (${shortId(linked[0].id)}) already carries the next step`,
      });
      continue;
    }
    if (goal.status === 'accepted' || goal.status === 'active') {
      candidates.push(candidate({
        ...base,
        action: 'create-plan',
        title: `Plan goal ${shortId(goal.id)}`,
        command: `node bin/apex.js propose --kind plan_create --goal ${shortId(goal.id)} <request>`,
        requiresAuthorization: false,
        reasons: [
          `the goal is ${goal.status} with no open plan`,
          progress.total > 0 ? `${progress.pending} criterion(s) still need evidence` : 'no success criteria are recorded',
          'a proposal is a suggestion only; approving and starting remain separate user actions',
        ],
        now,
      }));
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const kind = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
    if (kind !== 0) return kind;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  if (candidates.length === 0) notes.push('No open work is described by the records that were read.');
  return { generatedAt: now.toISOString(), candidates, excluded, notes, rule: PRIORITY_RULE };
}

export function renderContinuation({ candidates, excluded, notes, rule, generatedAt }, { limit = null, top = false } = {}) {
  const lines = ['Continuation recommendation (read-only, nothing is executed)'];
  lines.push(`Ranking: ${rule}; readiness where a record states it, deadlines when recorded, risk, dependencies, and existing execution state.`);
  lines.push('Readiness is one of seven states read from a record, and the record is named beside it; none of them is permission.');
  if (candidates.length === 0) {
    lines.push(...notes);
    return lines.join('\n');
  }
  const shown = limit ? candidates.slice(0, limit) : candidates;
  lines.push('', `Ranked work (${candidates.length} candidate(s)):`);
  for (const [index, c] of shown.entries()) {
    lines.push(`${index + 1}. ${c.title}`);
    lines.push(`   ${c.kind} ${shortId(c.ref)}  status: ${c.status ?? 'unknown'}  score: ${c.score}${c.ready ? '' : '  NOT READY'}`);
    if (c.readiness) lines.push(`   readiness: ${c.readiness}`);
    if (c.command) lines.push(`   next: ${c.command}`);
    for (const reason of c.reasons) lines.push(`   why: ${reason}`);
    for (const caution of c.cautions ?? []) lines.push(`   caution: ${cautionLine(caution)}`);
    for (const blocker of c.blockers) lines.push(`   blocker: ${blocker}`);
    if (c.requiresAuthorization) lines.push('   this would be a separately authorized action, not taken here');
    if (c.cautionChangedAction) lines.push(`   ${CAUTION_NOTE}`);
  }
  if (top && candidates.length > 1) lines.push('', `${candidates.length - 1} other candidate(s) are not shown; run "node bin/apex.js work" for the full list.`);
  if (excluded.length > 0) {
    lines.push('', 'Not recommended, with the reason:');
    for (const e of excluded.slice(0, 20)) lines.push(`  - ${e.title}: ${e.reason}`);
    if (excluded.length > 20) lines.push(`  - ... and ${excluded.length - 20} more`);
  }
  lines.push('', 'This command started nothing. It approves nothing, and its top recommendation is not permission.');
  return lines.join('\n');
}
