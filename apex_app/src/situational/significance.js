// Deterministic significance and contextual evaluation. Every number is a documented rule total
// over records the caller supplied; nothing is sampled, inferred, or produced by a model. The
// output is an assessment, not an action: it recommends one response and says what authorisation
// that response would need.
import { OPEN_GOAL_STATUSES, SIGNIFICANCE_RANK, SIGNIFICANCE_THRESHOLDS } from './vocabulary.js';

const FAILURE_TERMS = ['fail', 'failed', 'failure', 'error', 'blocked', 'overdue', 'missed', 'expired', 'denied'];
const CONFLICT_TERMS = ['conflict', 'contradict', 'disagree', 'mismatch', 'contradicts'];
const DEADLINE_TERMS = ['deadline', 'due', 'overdue', 'expires', 'expired'];
const ROUTINE_TERMS = ['heartbeat', 'routine', 'unchanged', 'no change', 'informational'];

const HOUR = 60 * 60 * 1000;

function lower(text) {
  return String(text ?? '').toLowerCase();
}

function containsAny(haystack, terms) {
  return terms.filter((term) => haystack.includes(term));
}

function openGoal(goal) {
  return OPEN_GOAL_STATUSES.includes(goal.status);
}

function levelFor(score) {
  if (score >= SIGNIFICANCE_THRESHOLDS.critical) return 'critical';
  if (score >= SIGNIFICANCE_THRESHOLDS.high) return 'high';
  if (score >= SIGNIFICANCE_THRESHOLDS.medium) return 'medium';
  if (score >= SIGNIFICANCE_THRESHOLDS.low) return 'low';
  return 'none';
}

function deadlineState(goal, nowMs) {
  if (!goal.deadline) return null;
  const due = Date.parse(goal.deadline);
  if (Number.isNaN(due)) return null;
  if (due <= nowMs) return { state: 'passed', hours: Math.floor((nowMs - due) / HOUR) };
  const hours = (due - nowMs) / HOUR;
  if (hours <= 48) return { state: 'approaching', hours: Math.ceil(hours) };
  return { state: 'distant', hours: Math.ceil(hours) };
}

function uniqueBy(list, key) {
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const id = key(entry);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
  }
  return out;
}

// The one entry point. `duplicate` is decided by the store, not guessed here.
export function assessEvent({ event, context = {}, now, duplicate = false }) {
  const nowMs = Date.parse(now);
  const typeText = lower(`${event.type} ${event.category}`);
  const payloadText = lower(JSON.stringify(event.payload ?? {}));
  const haystack = `${typeText} ${payloadText}`;
  const failureHits = containsAny(haystack, FAILURE_TERMS);
  const conflictHits = containsAny(haystack, CONFLICT_TERMS);
  const deadlineHits = containsAny(haystack, DEADLINE_TERMS);
  const routineHits = containsAny(haystack, ROUTINE_TERMS);

  const goals = Array.isArray(context.goals) ? context.goals : [];
  const plans = Array.isArray(context.plans) ? context.plans : [];
  const tasks = Array.isArray(context.tasks) ? context.tasks : [];
  const conflicts = Number.isInteger(context.world?.conflicts) ? context.world.conflicts : 0;
  const conflictEntities = Array.isArray(context.world?.conflictEntities) ? context.world.conflictEntities : [];

  const linkedGoals = uniqueBy(goals.filter((goal) => event.goalRefs.includes(goal.id)), (g) => g.id);
  const linkedPlans = uniqueBy(plans.filter((plan) => event.planRefs.includes(plan.id)), (p) => p.id);
  const linkedTasks = uniqueBy(tasks.filter((task) => event.taskRefs.includes(task.id)), (t) => t.id);
  const goalPlans = plans.filter((plan) => linkedGoals.some((goal) => goal.id === plan.goalId)
    && ['draft', 'approved', 'active', 'blocked'].includes(plan.status));
  const activePlans = linkedPlans.filter((plan) => ['approved', 'active', 'blocked'].includes(plan.status));

  const reasons = [];
  let score = 0;

  const stale = event.validUntil !== null && Date.parse(event.validUntil) <= nowMs;
  if (duplicate) {
    return {
      significance: { level: 'none', score: 0, reasons: ['the information is already recorded; it is the same source event and the same payload'] },
      relevance: { kind: 'duplicate', goals: [], plans: [], tasks: [], entities: [], rationale: 'a replay of information already in the log' },
      affectedObjectives: [],
      consequences: [],
      uncertainty: [],
      candidates: [
        { response: 'ignore', why: 'nothing new was observed', requiresAuthorization: false },
        { response: 'record', why: 'the duplicate is already preserved', requiresAuthorization: false },
      ],
      recommended: 'ignore',
      authorization: { required: false, reason: 'ignoring a duplicate changes nothing' },
      rationale: 'The event duplicates one already recorded exactly, so the only honest response is to take no further action.',
      stale: false,
    };
  }

  if (stale) {
    return {
      significance: { level: 'none', score: 0, reasons: ['the observation is past its validity end and is not treated as current truth'] },
      relevance: { kind: 'stale', goals: linkedGoals.map((g) => g.id), plans: linkedPlans.map((p) => p.id), tasks: linkedTasks.map((t) => t.id), entities: [...event.entityRefs], rationale: 'the observation expired before it was evaluated' },
      affectedObjectives: linkedGoals.map((goal) => ({ type: 'goal', id: goal.id, title: goal.request, why: 'the event names this goal, but its observation is stale' })),
      consequences: [{ kind: 'stale_observation', statement: 'the event can be preserved as history, but no current condition rests on it', basis: 'validity window' }],
      uncertainty: [`the observation stopped being current at ${event.validUntil}`],
      candidates: [
        { response: 'record', why: 'preserve the observation and its expiry without treating it as present', requiresAuthorization: false },
        { response: 'investigate', why: 'only if a fresh observation can be taken', requiresAuthorization: false },
      ],
      recommended: 'record',
      authorization: { required: false, reason: 'recording history changes nothing in the world' },
      rationale: 'The observation is recorded, but it is past its validity end, so APEX does not present it as current truth or raise it as an alert.',
      stale: true,
    };
  }

  // Relevance: a reference to an open objective is what makes an event more than information.
  if (linkedGoals.length > 0) {
    const priorities = linkedGoals.map((goal) => (Number.isInteger(goal.priority) ? goal.priority : 3));
    const top = Math.max(...priorities);
    score += 10 + top * 6;
    reasons.push(`${linkedGoals.length} open goal(s) referenced, highest priority ${top}/5`);
  }
  if (activePlans.length > 0) {
    score += 18;
    reasons.push(`${activePlans.length} approved or active plan(s) referenced`);
  }
  if (goalPlans.length > 0) {
    score += 8;
    reasons.push(`${goalPlans.length} plan(s) belong to an affected goal`);
  }
  if (linkedTasks.length > 0) {
    const unfinished = linkedTasks.filter((task) => !['completed', 'cancelled'].includes(task.status));
    score += 8 + (unfinished.some((task) => task.status === 'failed') ? 12 : 0);
    reasons.push(`${linkedTasks.length} task(s) referenced, ${unfinished.length} unfinished`);
  }

  if (failureHits.length > 0) {
    score += 20;
    reasons.push(`failure language recorded in the event: ${failureHits.slice(0, 3).join(', ')}`);
  }
  if (deadlineHits.length > 0) {
    score += 8;
    reasons.push(`deadline language recorded in the event: ${deadlineHits[0]}`);
  }
  for (const goal of linkedGoals) {
    const due = deadlineState(goal, nowMs);
    if (!due) continue;
    if (due.state === 'passed') {
      score += 25;
      reasons.push(`goal ${goal.id} is past its recorded deadline by ${due.hours} hour(s)`);
    } else if (due.state === 'approaching') {
      score += 15;
      reasons.push(`goal ${goal.id} is due within ${due.hours} hour(s)`);
    }
  }
  if (conflictHits.length > 0) {
    score += 12;
    reasons.push('the event describes a disagreement or contradiction');
  }
  const entityConflict = event.entityRefs.some((id) => conflictEntities.includes(id));
  if (conflicts > 0 && entityConflict) {
    score += 15;
    reasons.push(`the world model already holds ${conflicts} unresolved conflict group(s) involving a referenced entity`);
  }
  const expected = event.payload?.expected;
  const observed = event.payload?.observed;
  if (expected !== undefined && observed !== undefined && JSON.stringify(expected) !== JSON.stringify(observed)) {
    score += 25;
    reasons.push('the event records an expectation and an observation that differ');
  }
  if (routineHits.length > 0) {
    score -= 10;
    reasons.push(`routine language recorded in the event: ${routineHits[0]}`);
  }
  if (linkedGoals.length === 0 && linkedPlans.length === 0 && linkedTasks.length === 0 && event.entityRefs.length === 0) {
    // No reference and no matching language is noise for executive purposes, whatever its content.
    if (failureHits.length === 0 && conflictHits.length === 0) {
      score = Math.min(score, 4);
      reasons.push('the event names no objective, plan, task, or entity, so it is information rather than a condition');
    }
  }
  score = Math.max(0, Math.min(100, score));
  const level = levelFor(score);

  const consequences = [];
  if (activePlans.length > 0 && (failureHits.length > 0 || conflictHits.length > 0 || event.payload?.invalidate === true)) {
    consequences.push({
      kind: 'plan_invalidation',
      statement: `${activePlans.map((p) => p.id).slice(0, 3).join(', ')} may rest on a condition this event changes; the plan is not rewritten by this read`,
      basis: 'rule: failure or contradiction language plus a referenced active plan',
    });
  }
  for (const goal of linkedGoals) {
    const due = deadlineState(goal, nowMs);
    if (due?.state === 'passed') consequences.push({ kind: 'deadline_passed', statement: `goal ${goal.id} is past its recorded deadline`, basis: 'recorded deadline' });
    if (due?.state === 'approaching') consequences.push({ kind: 'deadline_approaching', statement: `goal ${goal.id} is due within ${due.hours} hour(s)`, basis: 'recorded deadline' });
  }
  if (linkedTasks.some((task) => task.status === 'failed')) {
    consequences.push({ kind: 'blocked_work', statement: 'a referenced task is recorded as failed, so work that depends on it may not proceed', basis: 'recorded task status' });
  }
  if (expected !== undefined && observed !== undefined && JSON.stringify(expected) !== JSON.stringify(observed)) {
    consequences.push({ kind: 'expectation_mismatch', statement: 'the observation differs from the recorded expectation; the expectation is not rewritten', basis: 'payload comparison' });
  }
  if (conflictHits.length > 0 || entityConflict) {
    consequences.push({ kind: 'assumption_conflict', statement: 'the current understanding now contains two claims that disagree; both are preserved until resolved', basis: 'world conflict group' });
  }

  const uncertainty = [];
  if (event.confidence < 0.6) uncertainty.push(`the source states confidence ${event.confidence}; the event is treated as uncertain`);
  if (event.goalRefs.length === 0) uncertainty.push('the event names no goal, so its executive relevance rests on its own description');
  if (entityConflict) uncertainty.push(`${conflicts} conflict group(s) already exist for referenced entities`);
  if (failureHits.length > 0 && linkedPlans.length === 0) uncertainty.push('failure language is present, but no plan was named; the affected plan is unknown');
  if (expected !== undefined && observed !== undefined && JSON.stringify(expected) !== JSON.stringify(observed)) {
    uncertainty.push('the observation disagrees with the recorded expectation; neither value was rewritten');
  }

  let recommended;
  if (level === 'critical') recommended = 'request_approval';
  else if (level === 'high') recommended = 'recommend';
  else if (level === 'medium') recommended = 'notify';
  else recommended = 'record';
  if (level === 'medium' && linkedGoals.length === 0 && linkedPlans.length === 0) recommended = 'record';

  const candidates = [];
  if (level === 'none' || level === 'low') {
    candidates.push({ response: 'record', why: 'preserve the observation without interrupting the user', requiresAuthorization: false });
  }
  if (event.entityRefs.length > 0 || linkedPlans.length > 0) {
    candidates.push({ response: 'investigate', why: 'read the referenced records and the current world state before deciding', requiresAuthorization: false });
  }
  if (SIGNIFICANCE_RANK[level] >= SIGNIFICANCE_RANK.medium) {
    candidates.push({ response: 'notify', why: 'the event is relevant to recorded work and is not a duplicate', requiresAuthorization: false });
  }
  if (SIGNIFICANCE_RANK[level] >= SIGNIFICANCE_RANK.high) {
    candidates.push({ response: 'recommend', why: 'the recorded context supports a next step, which the user may accept or reject', requiresAuthorization: false });
  }
  if (level === 'critical' || consequences.some((c) => ['plan_invalidation', 'blocked_work'].includes(c.kind))) {
    candidates.push({ response: 'request_approval', why: 'a consequential response would change recorded work, so it needs the user first', requiresAuthorization: true });
  }
  candidates.push({ response: 'ignore', why: 'take no further action; this is available for any event', requiresAuthorization: false });
  // Execution is never recommended by an assessment. It becomes available only as an explicit
  // user decision naming a registered action.
  candidates.push({ response: 'execute', why: 'run one named registered action, only after the user records that decision', requiresAuthorization: true });

  const affectedObjectives = [
    ...linkedGoals.map((goal) => ({ type: 'goal', id: goal.id, title: goal.request, why: 'named by the event' })),
    ...linkedPlans.map((plan) => ({ type: 'plan', id: plan.id, title: plan.outcome, why: 'named by the event' })),
    ...linkedTasks.map((task) => ({ type: 'task', id: task.id, title: task.goal ?? task.id, why: 'named by the event' })),
  ];

  return {
    significance: { level, score, reasons },
    relevance: {
      kind: linkedGoals.length > 0 || linkedPlans.length > 0 || linkedTasks.length > 0 ? 'relevant' : 'informational',
      goals: linkedGoals.map((g) => g.id),
      plans: linkedPlans.map((p) => p.id),
      tasks: linkedTasks.map((t) => t.id),
      entities: [...event.entityRefs],
      rationale: reasons.length > 0 ? reasons.join('; ') : 'no recorded objective, plan, task, or entity is affected',
    },
    affectedObjectives,
    consequences,
    uncertainty,
    candidates: uniqueBy(candidates, (c) => c.response),
    recommended,
    authorization: {
      required: recommended === 'request_approval',
      reason: recommended === 'request_approval'
        ? 'a consequential response to a critical condition needs the user to decide it'
        : 'the recommended response records, reads, or informs and changes no recorded work',
    },
    rationale: `Level ${level} (score ${score}) from ${reasons.length} documented rule(s). ${recommended === 'request_approval'
      ? 'The condition is critical enough that APEX asks before anything consequential happens.'
      : `The least consequential response that fits the recorded evidence is ${recommended}.`}`,
    stale: false,
  };
}
