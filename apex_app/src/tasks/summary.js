// The task-result turn that goes into conversation history. It is built only from
// replayed task state (the task log is the source of truth) plus evidence the runner
// already gathered: which steps are verified complete, which are uncertain, and which
// audit records could not be written. No step output, memory payload, file content,
// or model text is copied in, so a summary cannot smuggle data into later prompts and
// a model cannot reproduce this class of turn by writing similar prose.
//
// The text never claims more than the state establishes: only a task whose status is
// `completed` is called completed, and a single verified step is never enough for that.
import { createHash } from 'node:crypto';
import { Outcome } from '../outcomes.js';
import { shortId, truncate } from '../util.js';
import { TaskStatus, StepStatus, progressOf } from './model.js';

// Below the per-turn cap used when history is put in front of a model, so the whole
// statement survives replay instead of being cut where a tail note is lost.
export const MAX_TASK_SUMMARY_CHARS = 480;
const HEADER = 'TASK RESULT (from the task log and audit, not model text)';
const ACTION_CHARS = 20;
const SIGNATURE_VERSION = 'task-summary-1';

// The facts a summary states. Two runs whose facts are identical must not both write a
// summary turn; any change in state or recorded outcome gives a different signature.
export function taskStateSignature(task) {
  const facts = [
    SIGNATURE_VERSION,
    task.status,
    ...task.steps.map((s) => `${s.id}=${s.status}:${s.outcome ?? '-'}`),
  ].join('|');
  return createHash('sha256').update(facts).digest('hex');
}

function verdictOf(task, { completed, total, uncertain, interrupted }) {
  switch (task.status) {
    case TaskStatus.COMPLETED:
      return 'completed';
    case TaskStatus.CANCELLED:
      return 'cancelled';
    case TaskStatus.PROPOSED:
      return 'proposed but never run';
    case TaskStatus.PENDING:
      return 'approved but never run';
    case TaskStatus.PAUSED:
      if (interrupted) return completed > 0 ? 'interrupted partway through' : 'interrupted before any step finished';
      if (task.steps.some((s) => s.status === StepStatus.AWAITING_APPROVAL)) return 'paused for your approval';
      return 'paused before completion';
    case TaskStatus.FAILED:
      if (uncertain.length > 0) return 'stopped on a step whose outcome is uncertain';
      return completed > 0 && completed < total ? 'partially completed, then failed' : 'failed';
    default:
      // An unexpected state is reported as itself. It is never described as completed.
      return `in an unrecognised state (${truncate(String(task.status), 20)})`;
  }
}

const GROUP_TEXT = {
  [StepStatus.COMPLETED]: 'verified complete',
  [StepStatus.FAILED]: 'failed',
  [StepStatus.UNCERTAIN]: 'uncertain',
  [StepStatus.AWAITING_APPROVAL]: 'waiting for your approval',
  [StepStatus.SKIPPED]: 'not run',
  [StepStatus.CANCELLED]: 'cancelled',
  [StepStatus.PENDING]: 'still pending',
  [StepStatus.RUNNING]: 'recorded as running',
};

// The order the groups are stated in: what happened first is not the point, what is
// unresolved is. Steps keep their plan order inside a group.
const GROUP_ORDER = [
  StepStatus.COMPLETED,
  StepStatus.FAILED,
  StepStatus.UNCERTAIN,
  StepStatus.AWAITING_APPROVAL,
  StepStatus.SKIPPED,
  StepStatus.CANCELLED,
  StepStatus.PENDING,
  StepStatus.RUNNING,
];

function stepLabel(step, withAction) {
  const action = withAction && typeof step.action === 'string' ? ` (${truncate(step.action, ACTION_CHARS)})` : '';
  return `${step.id}${action}`;
}

function detailFor(task, withAction) {
  const groups = GROUP_ORDER
    .map((status) => ({ status, steps: task.steps.filter((s) => s.status === status) }))
    .filter((group) => group.steps.length > 0);
  // A state the tables do not describe is stated as itself, never folded into a
  // familiar group.
  const known = new Set(GROUP_ORDER);
  for (const status of new Set(task.steps.map((s) => s.status))) {
    if (known.has(status)) continue;
    groups.push({ status, steps: task.steps.filter((s) => s.status === status), unknown: true });
  }
  return groups.map((group) => {
    // A completed step's outcome is always success_verified, so it is not repeated.
    const outcomes = [...new Set(group.steps
      .map((s) => s.outcome)
      .filter((o) => typeof o === 'string' && o !== Outcome.SUCCESS_VERIFIED))];
    const suffix = outcomes.length > 0 ? `[${outcomes.join(', ')}]` : '';
    const text = group.unknown ? `in state ${group.status}` : GROUP_TEXT[group.status];
    return `${text}: ${group.steps.map((s) => stepLabel(s, withAction)).join(', ')}${suffix}`;
  }).join('; ');
}

// `evidence` is what the runner established about this particular run. It comes from
// the task log and the operation log, never from a model:
//   interrupted: the task was recorded as running when its process was lost
//   recovered:   [{ id, basis }] - basis 'audit' (resolved from its own audit record),
//                'unknown' (no matching record), 'unreadable' (the audit log could not
//                be read)
//   auditGaps:   step ids whose operation record could not be written
export function buildTaskSummary(task, { evidence = null } = {}) {
  if (!task || !Array.isArray(task.steps) || task.steps.length === 0) return null;
  // A task still recorded as running has no established outcome, so there is nothing
  // truthful to summarise. The caller reports that instead of writing a turn.
  if (task.status === TaskStatus.RUNNING) return null;

  const { completed, total } = progressOf(task);
  const uncertain = task.steps.filter((s) => s.status === StepStatus.UNCERTAIN);
  const interrupted = evidence?.interrupted === true;
  const auditGaps = (evidence?.auditGaps ?? []).filter((id) => task.steps.some((s) => s.id === id));
  const recovered = evidence?.recovered ?? [];

  const counts = [];
  if (uncertain.length > 0) counts.push(`${uncertain.length} uncertain`);
  if (auditGaps.length > 0) counts.push(`${auditGaps.length} without an audit record`);
  const open = task.steps.filter((s) => s.status === StepStatus.PENDING
    || s.status === StepStatus.AWAITING_APPROVAL
    || s.status === StepStatus.SKIPPED).length;
  if (open > 0) counts.push(`${open} not run`);
  if (interrupted) counts.push('the earlier run was interrupted');

  const header = `${HEADER}: task ${shortId(task.id)} ${verdictOf(task, { completed, total, uncertain, interrupted })}`
    + ` - ${completed} of ${total} step(s) verified complete${counts.length > 0 ? `; ${counts.join('; ')}` : ''}.`;

  // The statements about what is NOT established come before the per-step detail, which
  // is the part given up when the summary has to be shortened.
  const notes = [];
  for (const step of uncertain) {
    const basis = recovered.find((r) => r.id === step.id)?.basis;
    if (basis === 'unknown') {
      notes.push(`Step ${step.id} was interrupted and no audit record matches it, so whether it executed is not known.`);
    } else if (basis === 'unreadable') {
      notes.push(`Step ${step.id} was interrupted and the audit log could not be read, so its outcome is not known.`);
    } else if (basis === 'audit') {
      notes.push(`Step ${step.id} was interrupted; its outcome comes from its own audit record and it was not run again.`);
    } else {
      notes.push(`Step ${step.id} ran but its outcome was never established, so it is not counted complete and was not run again.`);
    }
  }
  for (const step of task.steps.filter((s) => s.status === StepStatus.RUNNING)) {
    notes.push(`Step ${step.id} is still recorded as running, so its outcome is not established.`);
  }
  if (auditGaps.length > 0) {
    notes.push(`No operation record could be written for ${auditGaps.join(', ')}, so those results are not independently established.`);
  }
  const fromAudit = recovered.filter((r) => r.basis === 'audit' && !uncertain.some((s) => s.id === r.id));
  if (fromAudit.length > 0) {
    notes.push(`Resolved from its own audit record after the interruption, not run again: ${fromAudit.map((r) => r.id).join(', ')}.`);
  }
  if (task.status === TaskStatus.COMPLETED && auditGaps.length > 0) {
    notes.push('The task log reports completion but the audit records above are missing, so this is not presented as independently verified.');
  }

  let statement = [header, ...notes].join(' ');
  if (statement.length > MAX_TASK_SUMMARY_CHARS) {
    // Compress rather than cut: an omitted "step s5 is uncertain" would leave a
    // summary that reads as if nothing is unresolved.
    const unresolved = [...new Set([...uncertain.map((s) => s.id), ...auditGaps,
      ...task.steps.filter((s) => s.status === StepStatus.RUNNING).map((s) => s.id)])];
    statement = `${header} Outcomes not established by the audit: ${unresolved.join(', ') || 'none'}.`;
  }

  const detail = (withAction) => {
    const text = detailFor(task, withAction);
    return text ? `${text}.` : '';
  };

  for (const withAction of [true, false]) {
    const candidate = detail(withAction) ? `${statement} ${detail(withAction)}` : statement;
    if (candidate.length <= MAX_TASK_SUMMARY_CHARS) {
      statement = candidate;
      break;
    }
    if (!withAction) statement = `${statement} Per-step detail omitted: it exceeds the summary limit; see the task log.`;
  }

  return {
    // Hard bound. The verdict line comes first, so a cut can only lose trailing
    // detail, never the statement of what is and is not established.
    text: truncate(statement, MAX_TASK_SUMMARY_CHARS),
    signature: taskStateSignature(task),
    taskId: task.id,
    // "Verified" means the whole task completed with its audit intact. Everything else
    // is a truthful statement of an incomplete result, never a verified success.
    verified: task.status === TaskStatus.COMPLETED && auditGaps.length === 0 && uncertain.length === 0,
  };
}
