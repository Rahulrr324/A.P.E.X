// Plain-text rendering of tasks, shared by the controller's replies and the CLI.
import { shortId, truncate } from '../util.js';
import { progressOf, TaskStatus, StepStatus } from './model.js';

const CLI = 'node bin/apex.js';

function nextHint(task) {
  const id = shortId(task.id);
  switch (task.status) {
    case TaskStatus.PROPOSED:
      return `Review the steps. To approve the plan: ${CLI} task approve ${id}`;
    case TaskStatus.PENDING:
      return `To run it: ${CLI} task run ${id}`;
    case TaskStatus.PAUSED: {
      const waiting = task.steps.find((s) => s.status === StepStatus.AWAITING_APPROVAL);
      if (waiting) return `Step ${waiting.id} changes data and needs your approval: ${CLI} task approve ${id} --step ${waiting.id}, then ${CLI} task resume ${id}`;
      return `To continue: ${CLI} task resume ${id}`;
    }
    case TaskStatus.FAILED:
      return `Stopped at a failed step. Retry a read-only step: ${CLI} task retry ${id} <step>. Or cancel: ${CLI} task cancel ${id}`;
    case TaskStatus.COMPLETED:
      return 'Completed.';
    case TaskStatus.CANCELLED:
      return 'Cancelled. Nothing further will run.';
    default:
      return '';
  }
}

export function renderTask(task) {
  const { completed, total } = progressOf(task);
  const origin = task.origin === 'model' ? 'model proposal' : 'your request';
  const lines = [
    `Task ${shortId(task.id)}  status: ${task.status}  origin: ${origin}  planner: ${task.planner}`,
    `Goal: ${task.goal}`,
    `Progress: ${completed} of ${total} step(s) completed`,
    'Steps:',
  ];
  task.steps.forEach((s, i) => {
    lines.push(`  ${i + 1}. [${s.status}] ${s.id}  ${s.description}`);
    const detail = [s.action, s.summary].filter(Boolean).join(' - ');
    if (detail) lines.push(`       ${detail}`);
  });
  lines.push(`Next: ${nextHint(task)}`);
  return lines.join('\n');
}

export function renderTaskList(tasks) {
  if (tasks.length === 0) return 'No tasks yet. Create one with: node bin/apex.js task plan <goal>';
  return tasks
    .map((t) => {
      const { completed, total } = progressOf(t);
      return `${shortId(t.id)}  ${t.status.padEnd(9)}  ${completed}/${total} steps  ${t.goal}`;
    })
    .join('\n');
}

// A follow-up question about a task, answered from the replayed task log, plus a
// read-only check that each recorded step result has its own operation record. The
// wording never exceeds what those records establish: a task is called finished only when
// its status is completed, an interrupted or uncertain step is named as unresolved, and
// a step that never ran is never described as progress. Nothing here reads a model's
// earlier claim about the task, and nothing here changes the task's state.
const EXPLAIN_LIMIT = 2000;

function stepNames(steps, withAction = true) {
  return steps.map((s) => (withAction && s.action ? `${s.id} (${truncate(s.action, 24)})` : s.id)).join(', ');
}

function openNote(s) {
  switch (s.status) {
    case StepStatus.AWAITING_APPROVAL:
      return `${s.id} waits for your approval (it changes data)`;
    case StepStatus.SKIPPED:
      return `${s.id} was not run: a step it depends on did not complete`;
    case StepStatus.UNCERTAIN:
      return `${s.id} is uncertain: it ran or was interrupted and its outcome was never established, so it was not run again`;
    case StepStatus.RUNNING:
      return `${s.id} is still recorded as running, so its outcome is not established`;
    case StepStatus.FAILED:
      return `${s.id} failed${s.outcome ? ` (${s.outcome})` : ''}`;
    default:
      return `${s.id} has not run yet`;
  }
}

export function explainTask(task, intent, { missingAudit = [] } = {}) {
  const { completed, total } = progressOf(task);
  const id = shortId(task.id);
  const by = (status) => task.steps.filter((s) => s.status === status);
  const done = by(StepStatus.COMPLETED);
  const unresolved = task.steps.filter((s) => s.status === StepStatus.UNCERTAIN || s.status === StepStatus.RUNNING);
  const blocked = task.steps.find((s) => s.status === StepStatus.FAILED || s.status === StepStatus.UNCERTAIN || s.status === StepStatus.RUNNING) ?? null;
  const head = `Task ${id} - status: ${task.status}; ${completed} of ${total} step(s) verified complete${unresolved.length ? `; ${unresolved.length} unresolved` : ''}.`;
  // A step is recorded as verified by the runner, but the record that shows what it was
  // verified against is its own operation entry. When the audit refused that entry the
  // answer has to say so instead of repeating the claim.
  const gap = missingAudit.length > 0
    ? `no operation record is available for ${missingAudit.join(', ')}, so APEX cannot show the evidence those step results were verified against`
    : null;
  let gapStated = false;

  let text;
  switch (intent) {
    case 'finished':
      if (task.status === TaskStatus.COMPLETED) {
        text = gap
          ? `${head} It is recorded as completed, but ${gap}.`
          : `${head} Yes, it finished: all ${total} step(s) ran and each one was verified.`;
        gapStated = gap !== null;
      } else if (task.status === TaskStatus.PENDING || task.status === TaskStatus.PROPOSED) {
        text = `${head} No, and it never ran: ${task.status === TaskStatus.PROPOSED ? 'it is still a model proposal awaiting your approval' : 'no step has been started'}.`;
      } else if (task.status === TaskStatus.CANCELLED) {
        text = `${head} No, it was cancelled${completed ? ` after ${completed} of ${total} step(s) had been verified` : ' before any step was verified'}, and nothing further will run.`;
      } else if (!blocked && by(StepStatus.AWAITING_APPROVAL).length > 0) {
        // A task waiting for an approval has not stopped: it is held at a step that
        // changes data, and saying "it stopped" would report a halt that never happened.
        const waiting = by(StepStatus.AWAITING_APPROVAL);
        text = `${head} No, it is waiting for you: ${stepNames(waiting)} need${waiting.length === 1 ? 's' : ''} your approval and ${waiting.length === 1 ? 'has' : 'have'} not run.`;
      } else {
        text = `${head} No, it stopped before finishing${blocked ? ` at ${blocked.id}` : ''}${completed ? `; ${completed} of ${total} step(s) were verified` : ''}.`;
      }
      break;
    case 'steps_succeeded':
      text = `${head} Verified complete: ${done.length ? stepNames(done) : 'none - no step has a verified result'}.`;
      if (unresolved.length) text += ` Not established: ${stepNames(unresolved)}.`;
      break;
    case 'pending': {
      const left = task.steps.filter((s) => s.status !== StepStatus.COMPLETED && s.status !== StepStatus.CANCELLED);
      text = `${head} Still to run: ${left.length ? left.map(openNote).join('; ') : 'nothing - every step is accounted for'}.`;
      break;
    }
    case 'why_stopped': {
      if (task.status === TaskStatus.COMPLETED) {
        text = gap
          ? `${head} Nothing stopped it, but ${gap}.`
          : `${head} It did not stop: every step ran and was verified.`;
        gapStated = gap !== null;
        break;
      }
      if (!blocked && task.steps.some((s) => s.status === StepStatus.AWAITING_APPROVAL)) {
        const waiting = task.steps.find((s) => s.status === StepStatus.AWAITING_APPROVAL);
        text = `${head} It is waiting for you: ${openNote(waiting)}${waiting.action ? ` (${waiting.action})` : ''}. A step proposed by a model never runs on the model's own authority.`;
        break;
      }
      if (!blocked) {
        text = `${head} ${task.status === TaskStatus.CANCELLED ? 'It was cancelled, so the steps that had not run were stopped.' : 'Nothing failed; the steps that remain have not been run.'}`;
        break;
      }
      const reason = blocked.summary ? `: ${truncate(blocked.summary, 200)}` : '';
      text = `${head} It stopped at ${blocked.id}${blocked.action ? ` (${blocked.action})` : ''} - ${openNote(blocked)}${reason}. Steps that depend on it were not run.`;
      break;
    }
    default:
      text = [
        head,
        `Goal: ${truncate(task.goal, 200)}`,
        ...task.steps.map((s) => `[${s.status}] ${s.id}${s.action ? ` (${truncate(s.action, 24)})` : ''}${s.status === StepStatus.COMPLETED || s.status === StepStatus.FAILED || s.status === StepStatus.UNCERTAIN ? ` - outcome: ${s.outcome ?? 'not recorded'}` : ''}`),
        `Next: ${nextHint(task)}`,
      ].join('\n');
      break;
  }
  // The views that list step states do not claim verification for the whole task, so the
  // gap is stated next to them rather than replacing them.
  if (gap !== null && !gapStated) text = `${text}\nNote: ${gap}.`;
  return truncate(text, EXPLAIN_LIMIT);
}
