// Executive progress communication: what APEX's records say about open work.
//
// These questions - what are you doing, what is next, what needs my approval, can you continue, can
// you cancel - are answered from the plan, task, goal, and continuation records, never from a model.
// A model cannot know whether a step ran: the task log and the audit do. Every state printed here
// names the record it came from, and a state with no record behind it is not printed at all, so a
// proposal can never be read as an action that happened.
import { shortId, truncate } from '../util.js';
import { isOpenPlan, planProgress } from '../plans/model.js';
import { StepStatus } from '../tasks/model.js';
import { isOpenStatus } from '../goals/model.js';
import { BOUNDS, ExecutionState, NO_BACKGROUND_NOTE, STATE_EVIDENCE, stateOfPlanStatus } from './vocabulary.js';

function words(text) {
  return truncate(String(text ?? ''), 160);
}

// The task a plan was started under, if the activation names one and it can be read.
function taskForPlan(plan, tasksById) {
  const id = plan.activation?.taskId ?? null;
  if (!id) return null;
  return tasksById.get(id) ?? null;
}

// One record translated into the shared vocabulary. A plan whose task cannot be read is reported as
// what the record actually says - an activation naming an unreadable task - rather than as running.
export function planState(plan, tasksById = new Map()) {
  const task = taskForPlan(plan, tasksById);
  if (plan.status === 'active') {
    if (!task) return { state: ExecutionState.BLOCKED, evidence: `plan ${shortId(plan.id)} is active and names task ${shortId(plan.activation?.taskId ?? '')}, which is not in the task log` };
    const progress = planProgress(plan);
    if (task.status === 'running') return { state: ExecutionState.RUNNING, evidence: `task ${shortId(task.id)} is recorded as running` };
    if (task.status === 'paused') return { state: ExecutionState.BLOCKED, evidence: `task ${shortId(task.id)} is paused for a user decision` };
    if (task.status === 'cancelled') return { state: ExecutionState.FAILED, evidence: `task ${shortId(task.id)} was cancelled` };
    if (task.status === 'failed') return { state: ExecutionState.FAILED, evidence: `task ${shortId(task.id)} failed` };
    if (task.steps.some((s) => s.status === StepStatus.UNCERTAIN)) {
      return { state: ExecutionState.UNCERTAIN, evidence: `task ${shortId(task.id)} has a step whose outcome was not established` };
    }
    if (task.status === 'completed') {
      return progress.completed === progress.total
        ? { state: ExecutionState.VERIFIED, evidence: `task ${shortId(task.id)} completed and ${progress.completed} step outcome(s) recorded against it` }
        : { state: ExecutionState.PARTIALLY_COMPLETED, evidence: `task ${shortId(task.id)} finished with ${progress.completed} of ${progress.total} step outcomes recorded on the plan` };
    }
    return { state: ExecutionState.PARTIALLY_COMPLETED, evidence: `task ${shortId(task.id)} is ${task.status} with ${progress.completed} of ${progress.total} outcomes recorded` };
  }
  const state = stateOfPlanStatus(plan.status);
  if (!state) return { state: null, evidence: `plan ${shortId(plan.id)} has the unrecognised status ${words(plan.status)}` };
  return { state, evidence: `plan ${shortId(plan.id)} is recorded as ${plan.status}` };
}

function stepStates(tasks) {
  const out = [];
  for (const task of tasks) {
    for (const step of task.steps ?? []) {
      if (step.status === StepStatus.PENDING) continue;
      out.push({
        task: shortId(task.id),
        step: step.id,
        action: step.action ?? null,
        state: step.status,
        evidence: `task ${shortId(task.id)} step ${step.id} is recorded as ${step.status}`,
      });
    }
  }
  return out;
}

// Every open record, in the shared vocabulary, with the line it came from. Closed records are left
// out of the list but counted, so "nothing is open" is a statement about the records read, not an
// invention.
export function executiveStates({ goals = [], plans = [], tasks = [] }) {
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const rows = [];
  for (const plan of plans) {
    const { state, evidence } = planState(plan, tasksById);
    rows.push({
      kind: 'plan',
      id: plan.id,
      title: words(plan.outcome),
      state,
      evidence,
      open: isOpenPlan(plan.status),
    });
  }
  for (const task of tasks) {
    if (task.planId) continue; // already shown as the plan it was started from
    const uncertain = (task.steps ?? []).filter((s) => s.status === StepStatus.UNCERTAIN).length;
    const completed = (task.steps ?? []).filter((s) => s.status === StepStatus.COMPLETED).length;
    rows.push({
      kind: 'task',
      id: task.id,
      title: words((task.steps ?? []).map((s) => s.description).join('; ')),
      state: uncertain > 0
        ? ExecutionState.UNCERTAIN
        : task.status === 'running'
          ? ExecutionState.RUNNING
          : task.status === 'completed'
            ? ExecutionState.VERIFIED
            : task.status === 'failed' || task.status === 'cancelled'
              ? ExecutionState.FAILED
              : completed > 0
                ? ExecutionState.PARTIALLY_COMPLETED
                : ExecutionState.AWAITING_APPROVAL,
      evidence: `task ${shortId(task.id)} is recorded as ${task.status} with ${completed} completed and ${uncertain} uncertain step(s)`,
      open: task.status !== 'completed' && task.status !== 'cancelled' && task.status !== 'failed',
    });
  }
  for (const goal of goals) {
    rows.push({
      kind: 'goal',
      id: goal.id,
      title: words(goal.request),
      state: goal.status === 'blocked'
        ? ExecutionState.BLOCKED
        : goal.status === 'completed'
          ? ExecutionState.VERIFIED
          : goal.status === 'proposed'
            ? ExecutionState.AWAITING_APPROVAL
            : isOpenStatus(goal.status) ? ExecutionState.PREPARED : ExecutionState.FAILED,
      evidence: `goal ${shortId(goal.id)} is recorded as ${goal.status} with ${goal.criteria?.length ?? 0} criterion (s)`,
      open: isOpenStatus(goal.status),
    });
  }
  return rows;
}

function byState(rows, state) {
  return rows.filter((r) => r.state === state);
}

// One record, the state read from it, and the record the state was read from. The citation is
// labelled rather than given as a reason: "approved because plan x is recorded as approved" reads as
// circular, while the same line under "evidence:" says which record to check.
function recordList(rows, lines, { limit = BOUNDS.maxListedRecords } = {}) {
  for (const row of rows.slice(0, limit)) {
    line(`  - ${row.kind} ${shortId(row.id)}: ${row.title}`, lines);
    line(`    ${row.state}. evidence: ${row.evidence}`, lines);
  }
  if (rows.length > limit) line(`  - ... and ${rows.length - limit} more; run "node bin/apex.js work" for the ranked list`, lines);
}

function line(text, lines) {
  lines.push(truncate(String(text), 320));
}

const HEADER = 'Executive status, read from APEX records. Nothing here was run, approved, changed, or cancelled.';

// The answer to one status question. `candidates` is the existing continuation ranking, so the
// recommendation APEX gives in a conversation is the same one `work` and `next` print.
export function describeExecutiveStatus({
  question, goals = [], plans = [], tasks = [], candidates = [], problems = [],
}) {
  const rows = executiveStates({ goals, plans, tasks });
  const open = rows.filter((r) => r.open);
  const lines = [HEADER, ''];
  const counts = {};
  for (const row of rows) counts[row.state ?? 'unrecognised'] = (counts[row.state ?? 'unrecognised'] ?? 0) + 1;
  line(`Records read: ${goals.length} goal(s), ${plans.length} plan(s), ${tasks.length} task(s).`, lines);
  if (problems.length > 0) {
    line('Problems reading those records (so the answer is partial, not complete):', lines);
    for (const p of problems.slice(0, 6)) line(`  - ${words(p)}`, lines);
    if (problems.length > 6) line(`  - ... and ${problems.length - 6} more`, lines);
  }

  switch (question) {
    case 'activity': {
      const running = open.filter((r) => r.state === ExecutionState.RUNNING);
      line(NO_BACKGROUND_NOTE, lines);
      if (running.length === 0) {
        line('No plan or task is recorded as running, so APEX is not carrying out work for you.', lines);
      } else {
        line(`${running.length} record(s) name work in progress:`, lines);
        recordList(running, lines);
      }
      break;
    }
    case 'next': {
      if (candidates.length === 0) {
        line('No open work is described by the records that were read. Nothing is suggested, because nothing is waiting.', lines);
      } else {
        line(`Next, ranked from the records (a recommendation only - it is not permission):`, lines);
        for (const [index, c] of candidates.slice(0, 3).entries()) {
          line(`  ${index + 1}. ${words(c.title)}`, lines);
          line(`     ${c.kind} ${shortId(c.ref)} is ${c.status ?? 'unknown'}; action: ${c.action}${c.ready ? '' : ' (not ready)'}`, lines);
          if (c.command) line(`     command: ${c.command}`, lines);
          for (const b of c.blockers.slice(0, 3)) line(`     blocker: ${words(b)}`, lines);
          if (c.requiresAuthorization) line('     this needs your own explicit action; APEX will not take it for you', lines);
        }
        if (candidates.length > 3) line(`  ${candidates.length - 3} other candidate(s): "node bin/apex.js work"`, lines);
      }
      break;
    }
    case 'completed': {
      const verified = byState(rows, ExecutionState.VERIFIED);
      const partial = byState(rows, ExecutionState.PARTIALLY_COMPLETED);
      const steps = stepStates(tasks).filter((s) => s.state === StepStatus.COMPLETED);
      if (verified.length === 0 && partial.length === 0 && steps.length === 0) {
        line('No step or plan is recorded as verified complete. Nothing is claimed as done.', lines);
      } else {
        line(`${verified.length} record(s) verified complete, ${partial.length} partially complete, ${steps.length} step outcome(s) recorded as completed:`, lines);
        recordList([...verified, ...partial], lines);
      }
      break;
    }
    case 'failed': {
      const failed = byState(rows, ExecutionState.FAILED);
      const steps = stepStates(tasks).filter((s) => s.state === StepStatus.FAILED);
      if (failed.length === 0 && steps.length === 0) {
        line('No plan, task, or step is recorded as failed.', lines);
      } else {
        line(`${failed.length} record(s) failed, ${steps.length} step(s) recorded as failed. Nothing retries on its own:`, lines);
        recordList(failed, lines);
        for (const s of steps.slice(0, BOUNDS.maxListedRecords)) line(`  - task ${s.task} step ${s.step}: failed (${s.action ?? 'action not recorded'})`, lines);
      }
      break;
    }
    case 'blocked': {
      const blocked = byState(rows, ExecutionState.BLOCKED);
      const blockers = candidates.flatMap((c) => (c.blockers ?? []).map((b) => ({ c, b })));
      if (blocked.length === 0 && blockers.length === 0) {
        line('No plan, goal, or task is recorded as blocked, and no ranked candidate carries a blocker.', lines);
      } else {
        line(`${blocked.length} record(s) blocked${blockers.length ? `, and ${blockers.length} blocker(s) named by the ranked candidates` : ''}:`, lines);
        recordList(blocked, lines);
        for (const { c, b } of blockers.slice(0, BOUNDS.maxListedRecords)) {
          line(`  - ${c.kind} ${shortId(c.ref)} (${c.action}): ${words(b)}`, lines);
        }
      }
      break;
    }
    case 'approval': {
      const awaiting = byState(rows, ExecutionState.AWAITING_APPROVAL);
      const approved = byState(rows, ExecutionState.APPROVED);
      const steps = stepStates(tasks).filter((s) => s.state === StepStatus.AWAITING_APPROVAL);
      line('What needs your approval, and nothing else can supply:', lines);
      if (awaiting.length === 0 && steps.length === 0 && approved.length === 0) {
        line('  Nothing is waiting on you in the records that were read.', lines);
      }
      recordList(awaiting, lines);
      for (const s of steps.slice(0, BOUNDS.maxListedRecords)) {
        line(`  - task ${s.task} step ${s.step} is waiting for a step-level approval`, lines);
      }
      if (approved.length > 0) {
        line('Approved already, and waiting for you to start them (approval starts nothing by itself):', lines);
        recordList(approved, lines);
      }
      break;
    }
    case 'uncertain': {
      const uncertain = byState(rows, ExecutionState.UNCERTAIN);
      const steps = stepStates(tasks).filter((s) => s.state === StepStatus.UNCERTAIN);
      if (uncertain.length === 0 && steps.length === 0) {
        line('No step is recorded as uncertain. Every recorded step outcome either verified or failed.', lines);
      } else {
        line(`${steps.length} step(s) are uncertain: they may or may not have happened. APEX will not retry one, because a retry could repeat a side effect:`, lines);
        for (const s of steps.slice(0, BOUNDS.maxListedRecords)) {
          line(`  - task ${s.task} step ${s.step}: ${s.action ?? 'action not recorded'}. Resolve it from its own audit record: "node bin/apex.js task explain ${s.task} recovery"`, lines);
        }
        recordList(uncertain, lines);
      }
      break;
    }
    case 'continue': {
      const resumable = candidates.filter((c) => c.action === 'resume-task' || c.action === 'resolve-interrupted' || c.action === 'start-plan');
      line(NO_BACKGROUND_NOTE, lines);
      if (resumable.length === 0) {
        line('Nothing in the records is waiting to be continued: no interrupted task, no uncertain step blocking a task, and no approved plan that has not started.', lines);
      } else {
        line(`Yes, work can be continued, and only when you run the command: ${resumable.length} record(s) can be picked up.`, lines);
        for (const c of resumable.slice(0, 4)) {
          line(`  - ${words(c.title)}: ${c.command ?? c.action}`, lines);
        }
        line('  A step whose outcome was never established is not replayed: continuing means resolving it first, from its own audit record.', lines);
      }
      break;
    }
    case 'cancel': {
      const running = open.filter((r) => r.state === ExecutionState.RUNNING);
      const cancelable = open.filter((r) => r.kind === 'plan' || r.kind === 'task');
      line(NO_BACKGROUND_NOTE, lines);
      if (cancelable.length === 0) {
        line('There is nothing to cancel: no plan is drafted, approved, or active in the records read.', lines);
      } else {
        line(`Yes, safely. ${cancelable.length} open record(s) can be stopped, and stopping is a recorded decision, not a silent one:`, lines);
        for (const r of cancelable.slice(0, 4)) {
          const command = r.kind === 'plan'
            ? `node bin/apex.js plan cancel ${shortId(r.id)} --reason <text>`
            : `node bin/apex.js task cancel ${shortId(r.id)}`;
          line(`  - ${r.kind} ${shortId(r.id)}: ${command}`, lines);
        }
        line('  A step that has already verified keeps its result. A step that was interrupted is left uncertain until you resolve it, because APEX cannot tell from the log whether it happened.', lines);
        if (running.length > 0) line('  Nothing is running in another process, so cancelling cannot leave a half-written action behind.', lines);
      }
      break;
    }
    default: {
      line('Overall state of the open records:', lines);
      for (const [state, count] of Object.entries(counts)) {
        line(`  ${state}: ${count} - ${STATE_EVIDENCE[state] ?? 'the record carries a status this view does not translate'}`, lines);
      }
      if (open.length === 0) {
        line('', lines);
        line('Nothing is open. No work is proposed, prepared, approved, running, or blocked.', lines);
      } else {
        line('', lines);
        recordList(open, lines, { limit: 8 });
      }
    }
  }

  line('', lines);
  line('These states were read from records. APEX has proposed nothing here, approved nothing, started nothing, and completed nothing.', lines);
  const truncated = lines.length > BOUNDS.maxStatusLines;
  const shown = truncated ? lines.slice(0, BOUNDS.maxStatusLines) : lines;
  let display = shown.join('\n');
  if (truncated || display.length > BOUNDS.maxStatusChars) {
    display = `${truncate(display, BOUNDS.maxStatusChars)}\n[status view cut at ${BOUNDS.maxStatusLines} lines; "node bin/apex.js work" lists the open records in full]`;
  }
  return { display, lines: shown, rows, counts, truncated };
}
