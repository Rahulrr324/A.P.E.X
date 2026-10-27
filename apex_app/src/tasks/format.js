// Plain-text rendering of tasks, shared by the controller's replies and the CLI.
import { shortId } from '../util.js';
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
