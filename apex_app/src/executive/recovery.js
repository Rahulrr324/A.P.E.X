// Executive recovery: what the existing records prove about a partial or interrupted run.
//
// This module adds no second recovery mechanism. The TaskRunner already owns every task state
// transition, already records a step as running before it executes, and already resolves an
// interrupted step from its own audit record or leaves it uncertain. What was missing is a way to
// say what any of that means to the user: which steps ran, which never started, which may or may
// not have happened, and which of the commands that already exist can be run next.
//
// Every conclusion here is read from a record handed in by the caller - the task record, a step's
// own operation record, the plan record, and the live registry. A step whose evidence is missing is
// reported as unknown rather than guessed at, and an unknown step is never offered an automatic
// replay, because it may already have produced its record. Nothing in this file writes, runs, or
// retries anything, and nothing it returns can be used as authorization.
import { Outcome } from '../outcomes.js';
import { StepStatus, TaskStatus } from '../tasks/model.js';
import { PlanStatus, planContentHash } from '../plans/model.js';
import { shortId, truncate } from '../util.js';
import { FailureBoundary, RecoveryClass, RECOVERY_NOTE, BOUNDS } from './vocabulary.js';

// What a step's own audit record says about where the interruption fell. The matching rule and the
// outcomes are the runner's: a record for this task and this step is the only evidence trusted here.
const OP_BOUNDARY = Object.freeze({
  [Outcome.SUCCESS_VERIFIED]: FailureBoundary.AFTER_VERIFICATION_BEFORE_FINALIZATION,
  [Outcome.VERIFICATION_FAILED]: FailureBoundary.AFTER_ACTION_BEFORE_VERIFICATION,
  [Outcome.VERIFICATION_UNAVAILABLE]: FailureBoundary.AFTER_ACTION_BEFORE_VERIFICATION,
  [Outcome.EXECUTION_FAILED]: FailureBoundary.DURING_ACTION,
  [Outcome.ACTION_DENIED]: FailureBoundary.BEFORE_EXECUTION,
  [Outcome.INPUT_REJECTED]: FailureBoundary.BEFORE_EXECUTION,
});

// What may happen to a step again, in the runner's own rules. `retryStep` accepts only a read-only
// step and only on an explicit user request, so a write step that is failed or uncertain is never
// run again in this task; the class says which of those applies.
const MAY_RUN = Object.freeze({
  [RecoveryClass.NOT_STARTED]: 'it has not run, so a run of this task will run it',
  [RecoveryClass.REQUIRES_USER]: 'it runs only after you approve it',
  [RecoveryClass.BLOCKED]: 'it runs only after the step it depends on completes',
  [RecoveryClass.VERIFIED_SUCCESS]: 'it will not run again: its verified result stands',
  [RecoveryClass.VERIFIED_FAILED]: 'it is not run again by APEX',
  [RecoveryClass.STARTED_UNKNOWN]: 'it is never run again automatically, because it may already have happened',
});

// The evidence for a step, exactly as the runner matches it: this task, this step, this capability.
function stepOperation(op, task, step) {
  if (!op || typeof op !== 'object') return null;
  if (op.capability !== 'task.step') return null;
  if (op.task?.id !== task?.id || op.task?.stepId !== step?.id) return null;
  return op;
}

function operationId(op) {
  return typeof op?.id === 'string' ? shortId(op.id) : null;
}

// The step statuses that mean the step never got past the start of the run. Their recorded boundary
// is where they stopped, not evidence of an interruption, so the recovery aggregate does not count
// them as a boundary the run reached.
const NEVER_RAN = new Set([
  StepStatus.PENDING,
  StepStatus.AWAITING_APPROVAL,
  StepStatus.CANCELLED,
  StepStatus.SKIPPED,
]);

// One step, classified from its recorded status plus its own operation record.
export function classifyStep(task, step, { op = null, auditReadable = true } = {}) {
  const evidence = stepOperation(op, task, step);
  const base = {
    id: step.id,
    action: step.action ?? null,
    permission: step.permission ?? null,
    status: step.status ?? null,
    operation: evidence ? operationId(evidence) : (step.operationId ? 'recorded, not readable' : null),
    outcome: step.outcome ?? (evidence?.status ?? null),
    summary: typeof step.summary === 'string' ? truncate(step.summary, BOUNDS.maxReasonChars) : null,
    requiresUser: false,
    boundary: null,
    note: null,
    // `note` describes what may be done next; `problem` states only what the records fail to
    // establish. They are printed in different places and must not be confused with each other.
    problem: null,
  };

  switch (step.status) {
    case StepStatus.PENDING:
      return { ...base, recoveryClass: RecoveryClass.NOT_STARTED, boundary: FailureBoundary.BEFORE_EXECUTION };

    case StepStatus.AWAITING_APPROVAL:
      // The runner paused here for a write a model proposed. Only the user's own decision moves it.
      return {
        ...base,
        recoveryClass: RecoveryClass.REQUIRES_USER,
        boundary: FailureBoundary.BEFORE_EXECUTION,
        requiresUser: true,
        note: `approve it with: task approve ${shortId(task?.id ?? '')} --step ${step.id}`,
      };

    case StepStatus.CANCELLED:
      return { ...base, recoveryClass: RecoveryClass.NOT_STARTED, boundary: FailureBoundary.BEFORE_EXECUTION };

    case StepStatus.COMPLETED: {
      if (evidence && evidence.status !== Outcome.SUCCESS_VERIFIED) {
        // The task log claims a completed step that its own operation record contradicts. The
        // runner refuses to let that make a task report verified success, and so does this read.
        return {
          ...base,
          recoveryClass: RecoveryClass.STARTED_UNKNOWN,
          boundary: OP_BOUNDARY[evidence.status] ?? FailureBoundary.UNCERTAIN_SIDE_EFFECT,
          requiresUser: true,
          note: 'it is treated as not established, and it is not run again',
          problem: `recorded completed in the task log while its own operation record ${base.operation} says ${evidence.status}: the two logs disagree`,
        };
      }
      // A completed step whose own operation record could not be matched rests on the task log
      // alone. That is a thinner claim than a verified record, so it is disclosed, not hidden.
      const thin = evidence ? null : step.operationId
        ? 'recorded completed, but its operation record was not read for this answer, so only the task log supports it'
        : 'recorded completed with no operation link in the task log, so its outcome cannot be checked against an operation record';
      return {
        ...base,
        recoveryClass: RecoveryClass.VERIFIED_SUCCESS,
        boundary: null,
        note: evidence
          ? `verified by its own operation record ${base.operation}`
          : 'the task log records it completed; its operation record was not read for this answer',
        problem: thin,
      };
    }

    case StepStatus.SKIPPED:
      return {
        ...base,
        recoveryClass: RecoveryClass.BLOCKED,
        boundary: FailureBoundary.BEFORE_EXECUTION,
        note: 'not run: it depends on a step that did not complete',
      };

    case StepStatus.FAILED:
    case StepStatus.UNCERTAIN: {
      const outcome = step.outcome ?? evidence?.status ?? null;
      const uncertain = step.status === StepStatus.UNCERTAIN
        || outcome === Outcome.VERIFICATION_UNAVAILABLE;
      if (uncertain) {
        return {
          ...base,
          recoveryClass: RecoveryClass.STARTED_UNKNOWN,
          boundary: FailureBoundary.UNCERTAIN_SIDE_EFFECT,
          requiresUser: step.permission !== 'read',
          note: step.permission === 'read'
            ? `read-only, so you may ask for one explicit retry: task retry ${shortId(task?.id ?? '')} ${step.id}`
            : 'it changes data, so APEX neither repeats it nor replays it; cancel this task and prepare a new plan if the work is still wanted',
          problem: 'may or may not have happened: no record verifies its outcome',
        };
      }
      return {
        ...base,
        recoveryClass: RecoveryClass.VERIFIED_FAILED,
        boundary: OP_BOUNDARY[outcome] ?? FailureBoundary.DURING_ACTION,
        requiresUser: step.permission !== 'read',
        note: step.permission === 'read'
          ? `you may retry it explicitly: task retry ${shortId(task?.id ?? '')} ${step.id}`
          : 'a failed write step is not retried; cancel this task and prepare a new plan if the work is still wanted',
      };
    }

    case StepStatus.RUNNING: {
      if (!auditReadable) {
        return {
          ...base,
          recoveryClass: RecoveryClass.STARTED_UNKNOWN,
          boundary: FailureBoundary.DURING_ACTION,
          requiresUser: true,
          note: 'it was not run again',
          problem: 'recorded as running while the operation log could not be read, so its outcome is unknown',
        };
      }
      if (!evidence) {
        return {
          ...base,
          recoveryClass: RecoveryClass.STARTED_UNKNOWN,
          boundary: FailureBoundary.DURING_ACTION,
          requiresUser: true,
          note: 'it was not run again',
          problem: 'recorded as running and no operation record matches it, so its outcome is unknown',
        };
      }
      if (evidence.status === Outcome.SUCCESS_VERIFIED) {
        // The action ran, the verifier re-read its result, and the operation record was appended -
        // the operation was finalized. Only the task log still shows RUNNING, which is what the
        // runner resolves without executing the step a second time.
        return {
          ...base,
          recoveryClass: RecoveryClass.VERIFIED_SUCCESS,
          boundary: FailureBoundary.AFTER_VERIFICATION_BEFORE_FINALIZATION,
          note: `ran and was verified: its operation record ${operationId(evidence)} ends ${evidence.status}; the task log still showed it running, so it was resolved from that record and not run again`,
        };
      }
      if (evidence.status === Outcome.VERIFICATION_UNAVAILABLE) {
        return {
          ...base,
          recoveryClass: RecoveryClass.STARTED_UNKNOWN,
          boundary: FailureBoundary.AFTER_ACTION_BEFORE_VERIFICATION,
          requiresUser: true,
          note: 'the step was not run again',
          problem: `ran but was never independently verified: operation record ${operationId(evidence)} ends ${evidence.status}`,
        };
      }
      return {
        ...base,
        recoveryClass: RecoveryClass.VERIFIED_FAILED,
        boundary: OP_BOUNDARY[evidence.status] ?? FailureBoundary.DURING_ACTION,
        requiresUser: step.permission !== 'read',
        note: `operation record ${operationId(evidence)} ends ${evidence.status}; the step was not run again`,
      };
    }

    default:
      // A status this vocabulary does not know is reported, not translated into a state that fits.
      return {
        ...base,
        recoveryClass: RecoveryClass.REQUIRES_USER,
        boundary: FailureBoundary.STORE_CORRUPTION,
        requiresUser: true,
        note: 'no conclusion is drawn from it, and nothing is run again on the strength of it',
        problem: `an unrecognised step status (${String(step.status ?? 'missing')}) is recorded in the task log`,
      };
  }
}

// Whether an approval still binds the plan it was given for. The plan store already refuses
// activation on a mismatch; this reports the same fact before a user is asked to act on it.
function approvalProblems(plan) {
  const problems = [];
  const boundaries = [];
  if (!plan || typeof plan !== 'object') return { problems, boundaries };
  if (plan.approval) {
    let current = null;
    try {
      current = planContentHash(plan);
    } catch {
      current = null;
    }
    if (current === null) {
      // Nothing here proves the plan changed or that the store is damaged: only that this read
      // cannot re-derive the hash, so the approval cannot be confirmed. No boundary is claimed.
      problems.push('the recorded plan could not be re-hashed from this read, so the approval that names it cannot be confirmed to still bind its content');
    } else if (current !== plan.approval.contentHash) {
      problems.push('the plan\'s recorded content no longer matches the hash its approval was bound to, so that approval authorizes nothing');
      boundaries.push(FailureBoundary.STALE_APPROVAL);
    } else if (plan.approval.version !== plan.version) {
      problems.push(`the approval names version ${plan.approval.version} but the plan is version ${plan.version}`);
      boundaries.push(FailureBoundary.CHANGED_PLAN);
    }
  }
  if (plan.activation && plan.approval
    && typeof plan.activation.contentHash === 'string'
    && plan.activation.contentHash !== plan.approval.contentHash) {
    problems.push('the activation record names a different plan content than the approval it rests on');
    boundaries.push(FailureBoundary.CHANGED_PLAN);
  }
  return { problems, boundaries };
}

// A step that the live registry would now refuse. The plan was authorized when it was validated;
// a registry change is reported rather than hidden, because it is why a run would stop at that step.
function registryProblems(steps, registry) {
  const problems = [];
  const boundaries = [];
  if (!registry || typeof registry.authorize !== 'function') return { problems, boundaries };
  for (const step of steps) {
    if (typeof step.action !== 'string' || step.action.length === 0) continue;
    if (step.status !== StepStatus.PENDING && step.status !== StepStatus.AWAITING_APPROVAL) continue;
    const decision = registry.authorize(step.action, 'user');
    if (decision?.decision === 'allow') continue;
    const code = decision?.reason ?? 'DENIED';
    problems.push(`step ${step.id} (${step.action}): no longer permitted by the registry (${code}), so a run of this task stops there`);
    boundaries.push(code === 'UNKNOWN_ACTION' ? FailureBoundary.CHANGED_REGISTRY : FailureBoundary.CAPABILITY_UNAVAILABLE);
  }
  return { problems, boundaries };
}

// The whole recovery reading of one task, and of the plan it came from if one was supplied.
// `operations` is whatever audit records the caller already has, matched by step; `auditReadable`
// is false when the log could not be read at all, which keeps every interrupted outcome unknown.
// `corrupt` is the count of unreadable lines, or one entry per unreadable line.
export function classifyRecovery({
  task,
  plan = null,
  operations = null,
  auditReadable = true,
  registry = null,
  lock = null,
  corrupt = [],
} = {}) {
  if (!task || typeof task !== 'object' || !Array.isArray(task.steps)) {
    return {
      ok: false,
      problems: ['no task record was supplied, so nothing can be established about it'],
      steps: [],
      classes: {},
      boundaries: [],
      guidance: [],
      note: RECOVERY_NOTE,
    };
  }

  const opsById = new Map();
  for (const op of operations ?? []) {
    if (op && typeof op.id === 'string') opsById.set(op.id, op);
  }

  const classified = task.steps.map((step) => classifyStep(task, step, {
    op: step.operationId ? (opsById.get(step.operationId) ?? null) : null,
    auditReadable,
  }));

  const classes = {};
  for (const row of classified) classes[row.recoveryClass] = (classes[row.recoveryClass] ?? 0) + 1;

  // A plan belongs to this task only when the task names it. A plan handed in that the task does
  // not record is a different piece of work: its approval state must not be attributed to this
  // task, and no command for it belongs in this task's guidance.
  const planForTask = plan && task.planId && task.planId === plan.id ? plan : null;

  const problems = [];

  // A step that never started sits at `before_execution`, which is not an interruption; it is only
  // where a step that did run stopped. So the aggregate skips the never-ran statuses.
  const boundaries = classified
    .filter((row) => !NEVER_RAN.has(row.status))
    .map((row) => row.boundary)
    .filter((b) => typeof b === 'string');

  if (!auditReadable) {
    problems.push('the operation log could not be read, so no interrupted step could be resolved from its own record');
    boundaries.push(FailureBoundary.UNCERTAIN_SIDE_EFFECT);
  }
  for (const row of classified) {
    if (row.problem) problems.push(`step ${row.id}: ${row.problem}`);
  }

  const approval = approvalProblems(planForTask);
  problems.push(...approval.problems);
  boundaries.push(...approval.boundaries);

  const live = registryProblems(task.steps, registry);
  problems.push(...live.problems);
  boundaries.push(...live.boundaries);

  const damaged = Array.isArray(corrupt) ? corrupt.length : Number(corrupt) || 0;
  if (damaged > 0) {
    problems.push(`${damaged} unreadable line(s) in a record log this read depends on; the state rebuilt from that log may be incomplete`);
    boundaries.push(FailureBoundary.STORE_CORRUPTION);
  }

  if (lock && (lock.code === 'LOCKED' || lock.code === 'LOCK_LOST')) {
    if (lock.code === 'LOCKED') {
      problems.push('a write lock was held, so the refused command wrote nothing');
      boundaries.push(FailureBoundary.LOCK_CONTENTION);
    } else {
      problems.push('exclusive ownership of a write lock was lost after an append, so whether that record landed must be read back rather than assumed');
      boundaries.push(FailureBoundary.LOST_LOCK_OWNERSHIP);
    }
  }

  const unknown = classified.filter((row) => row.recoveryClass === RecoveryClass.STARTED_UNKNOWN);
  const needsUser = classified.filter((row) => row.requiresUser);
  const interrupted = task.status === TaskStatus.RUNNING
    || task.steps.some((s) => s.status === StepStatus.RUNNING)
    || unknown.length > 0;

  const guidance = [];
  const stoppedRow = classified.find((row) => row.status === StepStatus.FAILED || row.status === StepStatus.UNCERTAIN);
  if (task.status === TaskStatus.PAUSED) {
    const waiting = classified.find((row) => row.status === StepStatus.AWAITING_APPROVAL);
    if (waiting) guidance.push(`task approve ${shortId(task.id)} --step ${waiting.id}`);
    else if (stoppedRow?.permission === 'read') guidance.push(`task retry ${shortId(task.id)} ${stoppedRow.id}`);
    // A paused task that paused on an uncertain or failed write step cannot be resumed past it, so
    // the only honest next command is the one that closes the task.
    else if (stoppedRow) guidance.push(`task cancel ${shortId(task.id)}`);
    else guidance.push(`task resume ${shortId(task.id)}`);
  }
  if (task.status === TaskStatus.FAILED) {
    if (stoppedRow?.permission === 'read') guidance.push(`task retry ${shortId(task.id)} ${stoppedRow.id}`);
    guidance.push(`task cancel ${shortId(task.id)}`);
  }
  if (unknown.some((row) => row.permission !== 'read')) guidance.push(`task cancel ${shortId(task.id)}`);
  if (planForTask && planForTask.status === PlanStatus.DRAFT && !planForTask.approval) {
    guidance.push(`plan show ${shortId(planForTask.id)}`, `plan approve ${shortId(planForTask.id)}`);
  } else if (planForTask && planForTask.status === PlanStatus.APPROVED) {
    guidance.push(`plan start ${shortId(planForTask.id)}`);
  }

  return {
    ok: true,
    task: {
      id: task.id,
      status: task.status,
      origin: task.origin ?? null,
      goalId: task.goalId ?? null,
      planId: task.planId ?? null,
      progress: { completed: classified.filter((r) => r.recoveryClass === RecoveryClass.VERIFIED_SUCCESS).length, total: task.steps.length },
    },
    plan: planForTask ? { id: planForTask.id, status: planForTask.status, version: planForTask.version, approved: Boolean(planForTask.approval) } : null,
    steps: classified,
    classes,
    boundaries: [...new Set(boundaries)],
    problems: [...new Set(problems)],
    unknown: unknown.map((row) => row.id),
    needsUser: needsUser.map((row) => row.id),
    interrupted,
    guidance: [...new Set(guidance)],
    note: RECOVERY_NOTE,
  };
}

const CLASS_PLAIN = Object.freeze({
  [RecoveryClass.NOT_STARTED]: 'not started',
  [RecoveryClass.STARTED_UNKNOWN]: 'started, outcome unknown',
  [RecoveryClass.VERIFIED_SUCCESS]: 'verified done',
  [RecoveryClass.VERIFIED_FAILED]: 'verified not done',
  [RecoveryClass.BLOCKED]: 'blocked by another step',
  [RecoveryClass.REQUIRES_USER]: 'needs your decision',
});

function capLines(lines, { maxLines, maxChars }) {
  const out = [];
  let chars = 0;
  for (const line of lines) {
    if (out.length >= maxLines) {
      out.push(`  ... ${lines.length - out.length} more line(s) not shown in this bounded read`);
      break;
    }
    chars += line.length + 1;
    if (chars > maxChars) {
      out.push('  ... this report was cut at its character bound; the records still hold the full history.');
      break;
    }
    out.push(line);
  }
  return out;
}

// The recovery reading as text, for a status answer or a failed run. It states what each step's
// evidence shows, what is unknown, and what the user may run next - and it repeats that nothing
// here was run or changed.
export function renderRecovery(report, { maxLines = BOUNDS.maxStatusLines, maxChars = BOUNDS.maxStatusChars } = {}) {
  if (!report || report.ok !== true) {
    return capLines([
      'Recovery could not be read from the records.',
      ...((report?.problems ?? []).map((p) => `  - ${p}`)),
    ], { maxLines, maxChars }).join('\n');
  }

  const lines = [
    `Recovery reading of task ${shortId(report.task.id)} (${report.task.status}).`,
    'Produced by reading records. Nothing was run, retried, approved, or changed to produce it.',
    `Steps: ${report.task.progress.completed} verified done of ${report.task.progress.total}.`,
  ];

  if (report.plan) {
    lines.push(`Plan ${shortId(report.plan.id)} is ${report.plan.status} at version ${report.plan.version}${report.plan.approved ? ', with a recorded approval' : ', with no recorded approval'}.`);
  }

  const shown = report.steps.filter((row) => row.status !== StepStatus.PENDING);
  if (shown.length > 0) {
    lines.push('', 'What each recorded step shows:');
    for (const row of shown) {
      lines.push(`  - step ${row.id} (${row.action ?? 'no action'}, ${row.permission ?? 'unstated permission'}) is ${row.status}: ${CLASS_PLAIN[row.recoveryClass] ?? row.recoveryClass}`);
      if (row.boundary) lines.push(`      interrupted at: ${row.boundary}`);
      if (row.note) lines.push(`      ${row.note}`);
      lines.push(`      ${MAY_RUN[row.recoveryClass] ?? 'no replay policy is stated for this class'}`);
    }
  } else {
    lines.push('', 'No step has been recorded as started, failed, or skipped: every step of this task is still pending.');
  }

  if (report.problems.length > 0) {
    lines.push('', 'What the records cannot establish:');
    for (const problem of report.problems) lines.push(`  - ${problem}`);
  }
  if (report.boundaries.length > 0) {
    lines.push(`  boundaries seen: ${report.boundaries.join(', ')}`);
  }
  if (report.unknown.length > 0) {
    lines.push('', `Steps whose outcome is unknown (${report.unknown.join(', ')}): APEX will not repeat them automatically, and a step whose outcome is not verified is not reported as done.`);
  }
  if (report.guidance.length > 0) {
    lines.push('', 'Commands that are yours to run:', ...report.guidance.map((g) => `  ${g}`));
  }
  lines.push('', report.note);
  return capLines(lines, { maxLines, maxChars }).join('\n');
}
