// Task model: states, legal transitions, plan structure checks, and the reducer
// that rebuilds task state from the append-only event log. Pure functions only:
// no I/O and no action execution here.
//
// Every state change is one `transition` event that is applied all-or-nothing.
// The reducer refuses any event whose `from` state does not match, or whose
// transition is not in the tables below, so the log cannot describe an impossible
// history (for example a step completed twice).
import { createHash } from 'node:crypto';

export const TASK_SCHEMA = 1;
export const MAX_STEPS = 8;
export const MAX_GOAL_CHARS = 500;
export const MAX_DESCRIPTION_CHARS = 200;
export const STEP_ID_RE = /^[a-z][a-z0-9_]{0,15}$/;

export const TaskStatus = Object.freeze({
  PROPOSED: 'proposed', // created from a model proposal; waits for user approval
  PENDING: 'pending', // approved or user-authored; not started
  RUNNING: 'running',
  PAUSED: 'paused', // waiting for an explicit user decision, or interrupted
  COMPLETED: 'completed',
  FAILED: 'failed', // a step failed or is uncertain; the task stopped
  CANCELLED: 'cancelled',
});

export const StepStatus = Object.freeze({
  PENDING: 'pending',
  AWAITING_APPROVAL: 'awaiting_approval', // a write proposed by a model: needs the user's approval
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  UNCERTAIN: 'uncertain', // executed (or interrupted) but the outcome could not be confirmed
  SKIPPED: 'skipped', // depends on a step that did not complete
  CANCELLED: 'cancelled',
});

export const TASK_TRANSITIONS = Object.freeze({
  proposed: ['pending', 'cancelled'],
  pending: ['running', 'cancelled'],
  running: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  failed: ['paused', 'cancelled'], // paused only by retrying a read-only step
  completed: [],
  cancelled: [],
});

export const STEP_TRANSITIONS = Object.freeze({
  pending: ['running', 'awaiting_approval', 'skipped', 'cancelled'],
  awaiting_approval: ['pending', 'cancelled'],
  running: ['completed', 'failed', 'uncertain'],
  failed: ['pending'], // retry: read-only steps only (enforced by the runner)
  uncertain: ['pending'], // retry: read-only steps only (enforced by the runner)
  skipped: ['pending'], // returns when the step it waited for is retried
  completed: [],
  cancelled: [],
});

export function canTransition(table, from, to) {
  return Array.isArray(table[from]) && table[from].includes(to);
}

// Deterministic JSON: object keys sorted, so the same input always hashes the same.
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function inputHash(input) {
  return createHash('sha256').update(stableStringify(input ?? {})).digest('hex');
}

// Checks step ids, references, self-dependencies, and cycles. Returns problems
// (empty when valid). `steps` is [{ id, dependsOn }].
export function dependencyProblems(steps) {
  const problems = [];
  if (!Array.isArray(steps) || steps.length === 0) return ['a plan needs at least one step'];
  if (steps.length > MAX_STEPS) problems.push(`a plan may have at most ${MAX_STEPS} steps`);
  const ids = new Set();
  for (const s of steps) {
    if (typeof s.id !== 'string' || !STEP_ID_RE.test(s.id)) {
      problems.push(`invalid step id: ${String(s.id)}`);
      continue;
    }
    if (ids.has(s.id)) problems.push(`duplicate step id: ${s.id}`);
    ids.add(s.id);
  }
  for (const s of steps) {
    if (!Array.isArray(s.dependsOn)) {
      problems.push(`step ${String(s.id)}: depends_on must be a list`);
      continue;
    }
    const seen = new Set();
    for (const d of s.dependsOn) {
      if (d === s.id) problems.push(`step ${s.id} depends on itself`);
      else if (!ids.has(d)) problems.push(`step ${s.id} depends on unknown step ${String(d)}`);
      else if (seen.has(d)) problems.push(`step ${s.id} lists dependency ${d} twice`);
      seen.add(d);
    }
  }
  if (problems.length === 0) {
    const cycle = findCycle(steps);
    if (cycle) problems.push(`dependency cycle: ${cycle.join(' -> ')}`);
  }
  return problems;
}

// Returns one cycle as a list of ids (first repeated at the end), or null.
export function findCycle(steps) {
  const deps = new Map(steps.map((s) => [s.id, s.dependsOn]));
  const state = new Map(); // 1 = on the current path, 2 = finished
  const path = [];
  const visit = (id) => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...path.slice(path.indexOf(id)), id];
    state.set(id, 1);
    path.push(id);
    for (const d of deps.get(id) ?? []) {
      const found = visit(d);
      if (found) return found;
    }
    path.pop();
    state.set(id, 2);
    return null;
  };
  for (const s of steps) {
    const found = visit(s.id);
    if (found) return found;
  }
  return null;
}

// Execution order: dependencies first; ties keep the order the steps were listed.
export function topologicalOrder(steps) {
  const remaining = steps.map((s) => ({ id: s.id, deps: new Set(s.dependsOn) }));
  const done = new Set();
  const order = [];
  while (order.length < steps.length) {
    const next = remaining.find((r) => !done.has(r.id) && [...r.deps].every((d) => done.has(d)));
    if (!next) throw new Error('dependency cycle (validate plans before ordering them)');
    done.add(next.id);
    order.push(next.id);
  }
  return order;
}

// Ids of every step that depends, directly or through others, on `stepId`.
export function dependentsOf(steps, stepId) {
  const out = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of steps) {
      if (out.has(s.id)) continue;
      if (s.dependsOn.some((d) => d === stepId || out.has(d))) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return [...out];
}

export function progressOf(task) {
  const total = task.steps.length;
  const completed = task.steps.filter((s) => s.status === StepStatus.COMPLETED).length;
  return { completed, total };
}

// ---- reducer ----------------------------------------------------------------

export function validateEventShape(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'not an object';
  if (e.schema !== TASK_SCHEMA) return 'unsupported schema';
  if (typeof e.eventId !== 'string' || e.eventId.length === 0) return 'missing event id';
  if (typeof e.taskId !== 'string' || e.taskId.length === 0) return 'missing task id';
  if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) return 'bad timestamp';
  if (e.type === 'task_created') {
    if (typeof e.goal !== 'string' || e.goal.length === 0) return 'missing goal';
    if (e.origin !== 'user' && e.origin !== 'model') return 'unknown origin';
    if (e.planner !== 'deterministic' && e.planner !== 'model') return 'unknown planner';
    if (!Array.isArray(e.steps)) return 'missing steps';
    return null;
  }
  if (e.type === 'transition') {
    if (typeof e.reason !== 'string') return 'missing reason';
    if (e.task !== null && (typeof e.task !== 'object' || typeof e.task.from !== 'string' || typeof e.task.to !== 'string')) {
      return 'bad task change';
    }
    if (!Array.isArray(e.steps)) return 'missing step changes';
    for (const s of e.steps) {
      if (!s || typeof s.id !== 'string' || typeof s.from !== 'string' || typeof s.to !== 'string') return 'bad step change';
    }
    if (e.approval !== null && e.approval !== undefined && (typeof e.approval.stepId !== 'string' || typeof e.approval.inputSha256 !== 'string')) {
      return 'bad approval';
    }
    return null;
  }
  return 'unknown event type';
}

function freshStep(s) {
  return {
    id: s.id,
    description: s.description,
    action: s.action,
    permission: s.permission,
    input: s.input,
    dependsOn: [...s.dependsOn],
    status: StepStatus.PENDING,
    operationId: null,
    outcome: null,
    summary: null,
    approval: null,
  };
}

// Applies one event to `tasks` (a Map). Returns a problem string, or null when applied.
// Nothing is changed when a problem is returned.
export function applyEvent(tasks, e) {
  const shape = validateEventShape(e);
  if (shape) return shape;

  if (e.type === 'task_created') {
    if (tasks.has(e.taskId)) return 'task id already exists';
    const problems = dependencyProblems(e.steps);
    if (problems.length) return problems[0];
    const task = {
      id: e.taskId,
      goal: e.goal,
      origin: e.origin,
      planner: e.planner,
      createdAt: e.at,
      updatedAt: e.at,
      status: e.origin === 'model' ? TaskStatus.PROPOSED : TaskStatus.PENDING,
      approvedAt: null,
      lastReason: e.reason ?? null,
      steps: e.steps.map(freshStep),
    };
    tasks.set(task.id, task);
    return null;
  }

  // type === 'transition': validate every part first, then apply all of it.
  const task = tasks.get(e.taskId);
  if (!task) return 'unknown task';

  if (e.task) {
    if (task.status !== e.task.from) return `task is ${task.status}, event expected ${e.task.from}`;
    if (!canTransition(TASK_TRANSITIONS, e.task.from, e.task.to)) return `illegal task transition ${e.task.from} -> ${e.task.to}`;
    if (e.task.from === 'proposed' && e.task.to === 'pending' && task.origin !== 'model') return 'only a model proposal needs approval';
  }
  const byId = new Map(task.steps.map((s) => [s.id, s]));
  for (const c of e.steps) {
    const step = byId.get(c.id);
    if (!step) return `unknown step ${c.id}`;
    if (step.status !== c.from) return `step ${c.id} is ${step.status}, event expected ${c.from}`;
    if (!canTransition(STEP_TRANSITIONS, c.from, c.to)) return `illegal step transition ${c.from} -> ${c.to} for ${c.id}`;
  }
  if (e.approval) {
    const step = byId.get(e.approval.stepId);
    if (!step) return `approval for unknown step ${e.approval.stepId}`;
    if (inputHash(step.input) !== e.approval.inputSha256) return 'approval does not match the step input';
  }

  // Apply.
  const nextStatus = e.task ? e.task.to : task.status;
  for (const c of e.steps) {
    const step = byId.get(c.id);
    step.status = c.to;
    if (c.operationId !== undefined) step.operationId = c.operationId;
    if (c.outcome !== undefined) step.outcome = c.outcome;
    if (c.summary !== undefined) step.summary = c.summary;
  }
  if (e.approval) byId.get(e.approval.stepId).approval = { approvedBy: 'user', inputSha256: e.approval.inputSha256, at: e.at };
  if (e.task) {
    task.status = e.task.to;
    if (e.task.from === 'proposed' && e.task.to === 'pending') task.approvedAt = e.at;
  }
  task.lastReason = e.reason;
  task.updatedAt = e.at;

  // Invariants: the task status must agree with its steps.
  const statuses = task.steps.map((s) => s.status);
  if (nextStatus === TaskStatus.COMPLETED && statuses.some((s) => s !== StepStatus.COMPLETED)) {
    return 'task marked completed while a step is not completed';
  }
  if (nextStatus === TaskStatus.CANCELLED && statuses.some((s) => s === StepStatus.PENDING || s === StepStatus.RUNNING || s === StepStatus.AWAITING_APPROVAL)) {
    return 'task marked cancelled while a step is still open';
  }
  return null;
}

// Rebuilds tasks from events in order. Events that do not apply are reported as
// problems and skipped, so one bad line cannot corrupt the rest of the history.
export function reduceEvents(events) {
  const tasks = new Map();
  const problems = [];
  events.forEach((e, index) => {
    const problem = applyEvent(tasks, e);
    if (problem) problems.push({ index, eventId: e?.eventId ?? null, reason: problem });
  });
  return { tasks, problems };
}

export function taskSummary(task) {
  const { completed, total } = progressOf(task);
  return { id: task.id, goal: task.goal, origin: task.origin, status: task.status, progress: { completed, total }, createdAt: task.createdAt, updatedAt: task.updatedAt };
}
