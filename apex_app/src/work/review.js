// A portfolio view of the owner's recorded work: goals, plans, and tasks read together,
// with the few things that need attention called out and everything else left as stored.
//
// This is a read. It does not rank work by a model, invent a priority, or decide what to
// do next: the continuation engine already proposes an order from stored rules. What this
// adds is the whole board in one place - what is open, what is waiting on the owner, what
// is blocked and why, and which recorded deadlines are near - each line traceable to the
// record it came from.
//
// A store that cannot be read is reported as unavailable, never as empty. The other
// stores are still shown, so one damaged log does not hide the rest of the work.
import { shortId, truncate } from '../util.js';

export const WORK_DEFAULT_LIMIT = 20;
export const WORK_MAX_LIMIT = 50;
export const WORK_DEFAULT_HORIZON_DAYS = 7;
export const WORK_MAX_HORIZON_DAYS = 365;

const OPEN_GOALS = new Set(['proposed', 'accepted', 'active', 'blocked']);
const OPEN_PLANS = new Set(['draft', 'approved', 'active', 'blocked']);
const OPEN_TASKS = new Set(['proposed', 'pending', 'running', 'paused', 'failed']);

const SEVERITY_ORDER = { blocked: 0, overdue: 1, deadline: 2, failed: 3, waiting: 4, unplanned: 5 };

function tally(items, key = 'status') {
  const byStatus = {};
  for (const item of items) byStatus[item[key]] = (byStatus[item[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(byStatus).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// Whole calendar days between two instants, measured at UTC midnight so a deadline on the
// current date is due today rather than "0.6 days ago". A value that does not parse was
// accepted by the goal store only if it parsed there, so a null here means the field was
// absent, not invalid.
function daysUntil(deadline, now) {
  if (typeof deadline !== 'string') return null;
  const target = Date.parse(deadline);
  if (Number.isNaN(target)) return null;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const d = new Date(target);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((end - start) / 86400000);
}

function goalCitation(goal) {
  const criteria = Array.isArray(goal.criteria) ? goal.criteria : [];
  return {
    id: goal.id,
    shortId: shortId(goal.id),
    request: truncate(goal.request, 200),
    status: goal.status,
    priority: goal.priority ?? null,
    deadline: goal.deadline ?? null,
    revision: goal.revision ?? 1,
    criteria: { satisfied: criteria.filter((c) => c.status === 'satisfied').length, total: criteria.length },
    plans: (goal.planIds ?? []).map((id) => shortId(id)),
    tasks: (goal.taskIds ?? []).map((id) => shortId(id)),
    blockedReason: goal.blockedReason ?? null,
    updatedAt: goal.updatedAt,
  };
}

function planCitation(plan) {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const results = plan.stepResults ?? {};
  return {
    id: plan.id,
    shortId: shortId(plan.id),
    outcome: truncate(plan.outcome ?? '(no outcome recorded)', 200),
    goalId: plan.goalId ? shortId(plan.goalId) : null,
    version: plan.version ?? 1,
    status: plan.status,
    steps: steps.length,
    completedSteps: steps.filter((s) => results[s.id]?.status === 'completed').length,
    taskId: plan.activation?.taskId ? shortId(plan.activation.taskId) : null,
    blockedReason: plan.blockedReason ?? null,
    updatedAt: plan.updatedAt,
  };
}

function taskCitation(task) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  return {
    id: task.id,
    shortId: shortId(task.id),
    goal: truncate(task.goal, 200),
    origin: task.origin,
    status: task.status,
    goalId: task.goalId ? shortId(task.goalId) : null,
    planId: task.planId ? shortId(task.planId) : null,
    steps: { completed: steps.filter((s) => s.status === 'completed').length, total: steps.length },
    updatedAt: task.updatedAt,
  };
}

function attentionFor({ goals, plans, tasks, deadlines = [], now, horizonDays }) {
  const items = [];
  for (const goal of goals) {
    if (goal.status === 'blocked') {
      items.push({
        kind: 'goal_blocked',
        severity: 'blocked',
        subject: `goal ${shortId(goal.id)}: ${truncate(goal.request, 120)}`,
        detail: goal.blockedReason ? truncate(goal.blockedReason, 200) : 'recorded as blocked with no reason stored',
        at: goal.updatedAt,
        refs: { goalId: goal.id },
      });
    }
    if (!OPEN_GOALS.has(goal.status)) continue;
    const days = daysUntil(goal.deadline, now);
    if (days !== null && days <= horizonDays) {
      const overdue = days < 0;
      items.push({
        kind: overdue ? 'goal_overdue' : 'goal_deadline',
        severity: overdue ? 'overdue' : 'deadline',
        subject: `goal ${shortId(goal.id)}: ${truncate(goal.request, 120)}`,
        detail: overdue
          ? `recorded deadline ${goal.deadline} passed ${Math.abs(days)} day(s) ago; the goal is still ${goal.status}`
          : `recorded deadline ${goal.deadline} is ${days === 0 ? 'today' : `in ${days} day(s)`}; the goal is ${goal.status}`,
        at: goal.deadline,
        refs: { goalId: goal.id },
      });
    }
    if (['accepted', 'active'].includes(goal.status) && (goal.planIds ?? []).length === 0) {
      items.push({
        kind: 'goal_without_plan',
        severity: 'unplanned',
        subject: `goal ${shortId(goal.id)}: ${truncate(goal.request, 120)}`,
        detail: `goal is ${goal.status} and no plan is linked to it`,
        at: goal.updatedAt,
        refs: { goalId: goal.id },
      });
    }
  }

  for (const plan of plans) {
    if (plan.status === 'blocked') {
      items.push({
        kind: 'plan_blocked',
        severity: 'blocked',
        subject: `plan ${shortId(plan.id)}: ${truncate(plan.outcome, 120)}`,
        detail: plan.blockedReason ? truncate(plan.blockedReason, 200) : 'recorded as blocked with no reason stored',
        at: plan.updatedAt,
        refs: { planId: plan.id, ...(plan.goalId ? { goalId: plan.goalId } : {}) },
      });
    }
    if (plan.status === 'approved') {
      items.push({
        kind: 'plan_approved_not_active',
        severity: 'waiting',
        subject: `plan ${shortId(plan.id)}: ${truncate(plan.outcome, 120)}`,
        detail: 'approved and waiting for activation; no task has run it',
        at: plan.updatedAt,
        refs: { planId: plan.id, ...(plan.goalId ? { goalId: plan.goalId } : {}) },
      });
    }
  }

  // A recorded deadline is a date the owner read from a file. It is called out only when it falls
  // inside the requested horizon, and it is never treated as an instruction to act: the detail says
  // where the date came from so it can be checked against that source.
  for (const item of deadlines) {
    const days = item.daysUntil;
    if (days === null || days > horizonDays) continue;
    const overdue = days < 0;
    items.push({
      kind: overdue ? 'deadline_overdue' : 'deadline_due',
      severity: overdue ? 'overdue' : 'deadline',
      subject: `deadline ${shortId(item.id)}: ${truncate(item.title, 120)}`,
      detail: overdue
        ? `recorded date ${item.dueAt} passed ${Math.abs(days)} day(s) ago (from ${item.source.path}:${item.source.line})`
        : `recorded date ${item.dueAt} is ${days === 0 ? 'today' : `in ${days} day(s)`} (from ${item.source.path}:${item.source.line})`,
      at: item.dueAt,
      refs: { deadlineId: item.id },
    });
  }

  for (const task of tasks) {
    if (task.status === 'paused') {
      items.push({
        kind: 'task_paused',
        severity: 'waiting',
        subject: `task ${shortId(task.id)}: ${truncate(task.goal, 120)}`,
        detail: 'paused; it needs a decision to resume or cancel',
        at: task.updatedAt,
        refs: { taskId: task.id, ...(task.goalId ? { goalId: task.goalId } : {}), ...(task.planId ? { planId: task.planId } : {}) },
      });
    }
    if (task.status === 'failed') {
      items.push({
        kind: 'task_failed',
        severity: 'failed',
        subject: `task ${shortId(task.id)}: ${truncate(task.goal, 120)}`,
        detail: 'stopped after a failure or an uncertain step; it did not complete',
        at: task.updatedAt,
        refs: { taskId: task.id, ...(task.goalId ? { goalId: task.goalId } : {}), ...(task.planId ? { planId: task.planId } : {}) },
      });
    }
    if (task.status === 'proposed') {
      items.push({
        kind: 'task_awaiting_approval',
        severity: 'waiting',
        subject: `task ${shortId(task.id)}: ${truncate(task.goal, 120)}`,
        detail: 'model proposal awaiting the owner; nothing has run',
        at: task.updatedAt,
        refs: { taskId: task.id },
      });
    }
  }

  return items.sort((a, b) => {
    const rank = (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
    if (rank !== 0) return rank;
    const at = Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0);
    if (!Number.isNaN(at) && at !== 0) return at;
    return a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0;
  });
}

async function readStore(store, reader) {
  if (!store) return { state: 'unavailable', records: null };
  try {
    const records = await reader(store);
    return { state: 'ok', records };
  } catch {
    // The reason is deliberately not echoed: store errors can name the data directory, and
    // this output can be offered to a model. The digest's notes say the source is unreadable.
    return { state: 'unavailable', records: null };
  }
}

function newestFirst(records, limit) {
  return [...records].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)).slice(0, limit);
}

export async function buildWorkReview({
  goals,
  plans,
  tasks,
  deadlines,
  now = new Date(),
  horizonDays = WORK_DEFAULT_HORIZON_DAYS,
  limit = WORK_DEFAULT_LIMIT,
} = {}) {
  const bound = Math.max(1, Math.min(WORK_MAX_LIMIT, Number.isInteger(limit) ? limit : WORK_DEFAULT_LIMIT));
  const horizon = Math.max(0, Math.min(WORK_MAX_HORIZON_DAYS, Number.isInteger(horizonDays) ? horizonDays : WORK_DEFAULT_HORIZON_DAYS));
  // The deadline ledger is optional: a configuration without it shows the same board as before,
  // rather than an extra section that would look like an empty schedule.
  const includeDeadlines = deadlines !== undefined && deadlines !== null;
  const [goalRead, planRead, taskRead, deadlineRead] = await Promise.all([
    readStore(goals, (store) => store.list()),
    readStore(plans, (store) => store.list()),
    readStore(tasks, (store) => store.list()),
    includeDeadlines ? readStore(deadlines, (store) => store.list({ now })) : Promise.resolve(null),
  ]);

  const goalRecords = goalRead.records ?? [];
  const planRecords = planRead.records ?? [];
  const taskRecords = taskRead.records ?? [];
  // Already earliest-first, with its day count measured against this read's `now`.
  const deadlineRecords = deadlineRead?.records ?? [];
  const deadlineWithin = deadlineRecords.filter((item) => item.daysUntil !== null && item.daysUntil <= horizon);

  const data = {
    generatedAt: now.toISOString(),
    horizonDays: horizon,
    limit: bound,
    sources: {
      goals: { state: goalRead.state, records: goalRead.records === null ? null : goalRecords.length },
      plans: { state: planRead.state, records: planRead.records === null ? null : planRecords.length },
      tasks: { state: taskRead.state, records: taskRead.records === null ? null : taskRecords.length },
    },
    counts: {
      goals: {
        total: goalRecords.length,
        open: goalRecords.filter((g) => OPEN_GOALS.has(g.status)).length,
        byStatus: tally(goalRecords),
      },
      plans: {
        total: planRecords.length,
        open: planRecords.filter((p) => OPEN_PLANS.has(p.status)).length,
        byStatus: tally(planRecords),
      },
      tasks: {
        total: taskRecords.length,
        open: taskRecords.filter((t) => OPEN_TASKS.has(t.status)).length,
        byStatus: tally(taskRecords),
      },
    },
    goals: newestFirst(goalRecords, bound).map(goalCitation),
    plans: newestFirst(planRecords, bound).map(planCitation),
    tasks: newestFirst(taskRecords, bound).map(taskCitation),
    attention: attentionFor({
      goals: goalRecords,
      plans: planRecords,
      tasks: taskRecords,
      deadlines: deadlineRead?.records === null ? [] : deadlineRecords,
      now,
      horizonDays: horizon,
    }),
    notes: [],
  };

  if (includeDeadlines) {
    data.sources.deadlines = {
      state: deadlineRead.state,
      records: deadlineRead.records === null ? null : deadlineRecords.length,
    };
    data.counts.deadlines = {
      total: deadlineRecords.length,
      within: deadlineWithin.length,
      overdue: deadlineWithin.filter((item) => item.daysUntil < 0).length,
    };
    data.deadlines = deadlineRecords.slice(0, bound);
  }

  const unavailable = Object.entries(data.sources).filter(([, s]) => s.state !== 'ok').map(([name]) => name);
  if (unavailable.length > 0) {
    data.notes.push(`A source that could not be read is reported as unavailable, not as empty: ${unavailable.join(', ')}.`);
  }
  data.notes.push('This is a listing of stored work, not a claim that any of it happened. Completion and failure come from the records, and an empty board is not evidence that nothing needs doing.');
  data.notes.push('Attention items are derived from recorded status and recorded deadlines only; APEX does not score urgency or invent a priority.');
  if (includeDeadlines) {
    data.notes.push('Deadlines here are dates recorded from an imported file, with the source file and line each came from. APEX does not infer a due date, schedule a reminder, or act when one passes.');
  }
  return data;
}

function renderCitation(citation, kind) {
  const lines = [];
  if (kind === 'goal') {
    const bits = [`${citation.criteria.satisfied}/${citation.criteria.total} criteria satisfied`];
    if (citation.priority !== null) bits.push(`priority ${citation.priority}`);
    if (citation.deadline !== null) bits.push(`deadline ${String(citation.deadline).slice(0, 10)}`);
    if (citation.plans.length) bits.push(`plans ${citation.plans.join(', ')}`);
    if (citation.tasks.length) bits.push(`tasks ${citation.tasks.join(', ')}`);
    lines.push(`  [${citation.shortId}] ${citation.status} - ${citation.request}`);
    lines.push(`      ${bits.join('; ')}`);
    if (citation.blockedReason) lines.push(`      blocked: ${citation.blockedReason}`);
  } else if (kind === 'plan') {
    lines.push(`  [${citation.shortId}] ${citation.status} v${citation.version} - ${citation.outcome}`);
    lines.push(`      ${citation.completedSteps}/${citation.steps} step(s) completed${citation.goalId ? `; goal ${citation.goalId}` : ''}${citation.taskId ? `; task ${citation.taskId}` : ''}`);
    if (citation.blockedReason) lines.push(`      blocked: ${citation.blockedReason}`);
  } else if (kind === 'deadline') {
    const days = citation.daysUntil;
    const when = days === null ? 'date unreadable' : days < 0 ? `overdue by ${Math.abs(days)} day(s)` : days === 0 ? 'due today' : `in ${days} day(s)`;
    lines.push(`  [${citation.shortId}] ${citation.dueAt} (${when}) - ${citation.title}`);
    lines.push(`      from ${citation.source.path}:${citation.source.line}`);
  } else {
    lines.push(`  [${citation.shortId}] ${citation.status} - ${citation.goal}`);
    lines.push(`      ${citation.steps.completed}/${citation.steps.total} step(s) completed; ${citation.origin}${citation.goalId ? `; goal ${citation.goalId}` : ''}${citation.planId ? `; plan ${citation.planId}` : ''}`);
  }
  return lines.join('\n');
}

function renderSection(label, source, citations, kind) {
  if (source.state !== 'ok') return [`${label}: unavailable - the store could not be read`];
  if (citations.length === 0) return [`${label}: none recorded`];
  return [`${label} (${citations.length} shown):`, ...citations.map((citation) => renderCitation(citation, kind))];
}

export function renderWorkReview(data) {
  const lines = [`Work review (read-only; records as stored, generated ${String(data.generatedAt).slice(0, 16).replace('T', ' ')} UTC)`];
  const c = data.counts;
  lines.push(`  goals: ${c.goals.total} total, ${c.goals.open} open`, `  plans: ${c.plans.total} total, ${c.plans.open} open`, `  tasks: ${c.tasks.total} total, ${c.tasks.open} open/unfinished`);
  if (c.deadlines) {
    lines.push(`  deadlines: ${c.deadlines.total} recorded, ${c.deadlines.within} within ${data.horizonDays} day(s), ${c.deadlines.overdue} overdue`);
  }
  lines.push('');
  if (data.attention.length === 0) {
    lines.push('Needs attention: nothing derived from the stored statuses and deadlines.');
  } else {
    lines.push(`Needs attention (${data.attention.length}; within ${data.horizonDays} day(s) for deadlines):`);
    for (const item of data.attention) lines.push(`  - [${item.severity}] ${item.subject}\n      ${item.detail}`);
  }
  lines.push('');
  lines.push(...renderSection('Goals', data.sources.goals, data.goals, 'goal'));
  lines.push('');
  lines.push(...renderSection('Plans', data.sources.plans, data.plans, 'plan'));
  lines.push('');
  lines.push(...renderSection('Tasks', data.sources.tasks, data.tasks, 'task'));
  if (data.sources.deadlines) {
    lines.push('');
    lines.push(...renderSection('Deadlines', data.sources.deadlines, data.deadlines, 'deadline'));
  }
  lines.push('');
  lines.push('Notes:');
  for (const note of data.notes) lines.push(`  - ${note}`);
  return lines.join('\n');
}