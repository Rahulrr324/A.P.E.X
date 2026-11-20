// Deterministic briefing engine foundation (T-22).
// Pure read-only assembly of real system facts. Distinguishes actual facts from inferred items.
// No model inference, no external data, no store writes.

export const BRIEFING_SCHEMA = 'apex.briefing.v1';

export function buildBriefing({ goals = [], plans = [], tasks = [], situation = null, resources = null, health = null, now = () => new Date() } = {}) {
  const facts = [];
  const inferred = [];
  const taskRows = Array.isArray(tasks) ? tasks : [];
  const planRows = Array.isArray(plans) ? plans : [];
  const pendingTaskApprovals = taskRows.filter((task) => task && (
    task.status === 'proposed'
    || (Array.isArray(task.steps) && task.steps.some((step) => step?.status === 'awaiting_approval'))
  ));
  const pendingPlanApprovals = planRows.filter((plan) => plan?.status === 'draft' && !plan.approval);
  const pendingApprovals = [...pendingTaskApprovals, ...pendingPlanApprovals];
  const blocked = taskRows.filter((task) => task && (task.status === 'blocked' || task.status === 'paused'));
  const running = taskRows.filter((task) => task && task.status === 'running');

  for (const g of (Array.isArray(goals) ? goals : [])) {
    facts.push({ kind: 'goal', id: g.id ?? null, text: g.request || g.title || g.id || 'goal', status: g.status || 'recorded' });
  }
  for (const p of planRows) {
    facts.push({ kind: 'plan', id: p.id ?? null, text: p.outcome || p.id || 'plan', status: p.status || 'unknown' });
  }
  for (const task of pendingTaskApprovals) facts.push({ kind: 'task_approval', id: task.id ?? null, text: task.goal || task.id || 'task approval', status: 'pending' });
  for (const plan of pendingPlanApprovals) facts.push({ kind: 'plan_approval', id: plan.id ?? null, text: plan.outcome || plan.id || 'plan approval', status: 'pending' });
  for (const t of blocked) facts.push({ kind: 'blocked_task', id: t.id ?? null, text: t.goal || t.id || 'task', status: t.status });
  for (const t of running) facts.push({ kind: 'running_task', id: t.id ?? null, text: t.goal || t.id || 'task', status: 'running' });

  if (situation && Array.isArray(situation.alerts)) {
    for (const alert of situation.alerts) {
      facts.push({ kind: 'sentinel_alert', id: alert.eventId ?? alert.id ?? null, text: alert.summary || alert.eventId || alert.id || 'alert', status: 'recorded_alert' });
    }
  }
  if (situation && Array.isArray(situation.observations)) {
    for (const o of situation.observations) facts.push({ kind: 'sentinel_observation', id: o.id ?? null, text: o.summary || o.id || 'observation', status: 'reported' });
  }

  if (running.length > 0 && blocked.length > 0) {
    inferred.push({ kind: 'possible_contention', text: 'Running and blocked tasks coexist; review dependencies.', basis: 'task status counts' });
  }
  if (pendingApprovals.length > 0) {
    inferred.push({ kind: 'decision_needed', text: `${pendingApprovals.length} approval(s) pending.`, basis: 'approval count' });
  }

  const concise = [
    `Goals: ${(goals || []).length}`,
    `Plans: ${(plans || []).length}`,
    `Tasks: ${(tasks || []).length} (${running.length} running, ${blocked.length} blocked, ${pendingApprovals.length} approvals)`,
    `Sentinel alerts: ${(situation?.alerts || []).length}`,
  ].join(' | ');

  return {
    schema: BRIEFING_SCHEMA,
    generatedAt: now().toISOString(),
    concise,
    facts,
    inferred,
    counts: {
      goals: (goals || []).length,
      plans: (plans || []).length,
      tasks: (tasks || []).length,
      approvals: pendingApprovals.length,
      blocked: blocked.length,
      running: running.length,
      alerts: (situation?.alerts || []).length,
      facts: facts.length,
      inferred: inferred.length,
    },
    note: 'Facts are read from stores; inferred items are heuristic summaries and are not verified outcomes.',
  };
}
