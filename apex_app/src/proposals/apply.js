// Proposal assessment and application.
//
// Assessment is a read-only comparison between what a proposal asked for and the live state it
// named. It distinguishes eligible, stale (the record moved on), invalid (the proposal is
// malformed or its validation failed), expired, and already-applied. Calling it never writes.
//
// Application is reached only from a user-origin acceptance action, and only after a fresh
// assessment. It applies a goal or plan change through the ordinary store operation, which
// validates the live state again. A proposal can therefore never approve, activate, execute, or
// complete anything: generating a plan proposal stores a draft plan at most, and a goal proposal
// stores a proposed goal at most.
import { normalizeRequest, isOpenStatus } from '../goals/model.js';
import { PlanStatus, isOpenPlan, planContent } from '../plans/model.js';
import { stableStringify } from '../tasks/model.js';
import { containsSecret } from '../security/secrets.js';
import { ProposalStatus, proposalStatus } from './model.js';

const TERMINAL_GOAL = new Set(['completed', 'failed', 'cancelled', 'abandoned', 'superseded']);

function criteriaMatch(goal, changes) {
  if (!Array.isArray(changes.criteria)) return false;
  if (goal.criteria.length !== changes.criteria.length) return false;
  return goal.criteria.every((c, i) => c.description === changes.criteria[i]);
}

function goalMatchesRequest(goal, changes) {
  if (changes.request === undefined) return true;
  return normalizeRequest(goal.request) === normalizeRequest(changes.request);
}

function proposalContent(plan, changes) {
  return planContent({ ...changes, goalId: plan.goalId ?? null, goalRevision: plan.goalRevision ?? null });
}

function planMatches(plan, changes) {
  return stableStringify(planContent(plan)) === stableStringify(proposalContent(plan, changes));
}

function normalizedChanges(changes) {
  return {
    outcome: changes.outcome,
    steps: changes.steps.map((s) => ({
      id: s.id,
      description: s.description,
      action: s.action,
      input: s.input ?? {},
      dependsOn: [...s.dependsOn],
      expectedResult: s.expectedResult,
      verification: s.verification,
      criterionId: s.criterionId ?? null,
      risk: s.risk,
      estimate: { seconds: s.estimate?.seconds ?? null },
    })),
    preconditions: [...(changes.preconditions ?? [])],
    assertions: changes.assertions.map((a) => ({ kind: a.kind, text: a.text, ref: a.ref ?? null })),
    resources: { estimatedSeconds: changes.resources?.estimatedSeconds ?? null },
  };
}

// Anything that is not a plain record read is a problem for assessment, so it is reported
// instead of being treated as absence. An unreadable store means "cannot tell", never "gone".
async function readGoal(goals, id) {
  if (!goals) return { goal: null, problem: 'the goal store is not available, so the proposal cannot be checked' };
  try {
    return { goal: await goals.get(id), problem: null };
  } catch (err) {
    return { goal: null, problem: `the goal store could not be read (${err?.code ?? err?.message ?? 'unknown'})` };
  }
}

async function readPlan(plans, id) {
  if (!plans) return { plan: null, problem: 'the plan store is not available, so the proposal cannot be checked' };
  try {
    return { plan: await plans.get(id), problem: null };
  } catch (err) {
    return { plan: null, problem: `the plan store could not be read (${err?.code ?? err?.message ?? 'unknown'})` };
  }
}

function registryProblems(plans, draft) {
  if (!plans || typeof plans.validatePlan !== 'function') return ['plan validation is unavailable'];
  const result = plans.validatePlan(draft);
  return result.ok ? [] : result.problems;
}

// Read-only. `status` is the derived status; `problems` explains anything that is not eligible.
export async function assessProposal(proposal, { goals = null, plans = null, now = new Date(), check = true } = {}) {
  const base = proposalStatus(proposal, { now });
  if (base !== ProposalStatus.PENDING) return { status: base, problems: [], goal: null, plan: null, alreadyApplied: false };
  if (containsSecret(JSON.stringify(proposal.changes ?? {}))) {
    return { status: ProposalStatus.INVALID, problems: ['the proposed changes contain a credential-shaped value'], goal: null, plan: null, alreadyApplied: false };
  }
  if (!check) return { status: ProposalStatus.PENDING, problems: [], goal: null, plan: null, alreadyApplied: false };

  const problems = [];
  let goal = null;
  let plan = null;
  let alreadyApplied = false;

  if (proposal.kind === 'goal_create') {
    if (!goals) {
      problems.push('the goal store is not available, so a goal cannot be proposed');
    } else {
      let open = [];
      try {
        open = (await goals.list()).filter((g) => isOpenStatus(g.status) && normalizeRequest(g.request) === normalizeRequest(proposal.changes.request));
      } catch (err) {
        problems.push(`the goal store could not be read (${err?.code ?? 'unknown'})`);
      }
      if (open.length > 0) {
        goal = open[0];
        if (criteriaMatch(goal, proposal.changes)) alreadyApplied = true;
        else problems.push(`an open goal ${goal.id} already records this request with different criteria`);
      }
    }
  } else if (proposal.kind === 'goal_clarify') {
    const found = await readGoal(goals, proposal.goalId);
    goal = found.goal;
    if (found.problem) problems.push(found.problem);
    else if (!goal) problems.push(`goal ${proposal.goalId} no longer exists`);
    else if (!isOpenStatus(goal.status)) problems.push(`goal ${goal.id} is ${goal.status}; its criteria can no longer be revised`);
    else if (proposal.baseRevision !== null && goal.revision < proposal.baseRevision) {
      problems.push(`goal ${goal.id} is revision ${goal.revision}, older than the proposal's base revision ${proposal.baseRevision}`);
    } else if (proposal.baseRevision !== null && goal.revision > proposal.baseRevision) {
      if (goal.revision === proposal.baseRevision + 1 && criteriaMatch(goal, proposal.changes) && goalMatchesRequest(goal, proposal.changes)) {
        alreadyApplied = true;
      } else {
        problems.push(`goal ${goal.id} moved from revision ${proposal.baseRevision} to ${goal.revision}; the proposal was written for an older wording`);
      }
    }
    if (goal && goal.revision === proposal.baseRevision && !isOpenStatus(goal.status)) {
      problems.push(`goal ${goal.id} is ${goal.status}`);
    }
  } else if (proposal.kind === 'plan_create') {
    if (proposal.goalId) {
      const found = await readGoal(goals, proposal.goalId);
      goal = found.goal;
      if (found.problem) problems.push(found.problem);
      else if (!goal) problems.push(`goal ${proposal.goalId} no longer exists`);
      else if (TERMINAL_GOAL.has(goal.status)) problems.push(`goal ${goal.id} is ${goal.status}; a new plan is not accepted for it`);
      else if (proposal.baseRevision !== null && goal.revision > proposal.baseRevision) {
        problems.push(`goal ${goal.id} moved from revision ${proposal.baseRevision} to ${goal.revision}; the plan proposal was written for an older wording`);
      } else if (proposal.baseRevision !== null && goal.revision < proposal.baseRevision) {
        problems.push(`goal ${goal.id} is revision ${goal.revision}, older than the proposal's base revision ${proposal.baseRevision}`);
      }
    }
    if (goal && plans) {
      try {
        const open = (await plans.list()).filter((p) => p.goalId === goal.id && isOpenPlan(p.status));
        if (open.length > 0) {
          plan = open[0];
          if (planMatches(plan, proposal.changes)) alreadyApplied = true;
          else problems.push(`goal ${goal.id} already has an open plan ${plan.id}`);
        }
      } catch (err) {
        problems.push(`the plan store could not be read (${err?.code ?? 'unknown'})`);
      }
    }
    if (problems.length === 0 && proposal.validation?.ok === true) {
      const draft = { goalId: proposal.goalId, goalRevision: goal?.revision ?? null, ...normalizedChanges(proposal.changes) };
      problems.push(...registryProblems(plans, draft));
    }
  } else if (proposal.kind === 'plan_revise') {
    const found = await readPlan(plans, proposal.planId);
    plan = found.plan;
    if (found.problem) problems.push(found.problem);
    else if (!plan) problems.push(`plan ${proposal.planId} no longer exists`);
    else if (plan.version < proposal.baseVersion) problems.push(`plan ${plan.id} is version ${plan.version}, older than the proposal's base version ${proposal.baseVersion}`);
    else if (plan.version > proposal.baseVersion) {
      if (plan.version === proposal.baseVersion + 1 && planMatches(plan, proposal.changes)) alreadyApplied = true;
      else problems.push(`plan ${plan.id} moved from version ${proposal.baseVersion} to ${plan.version}; the proposal was written for older content`);
    } else if (plan.status !== PlanStatus.DRAFT && plan.status !== PlanStatus.BLOCKED) {
      problems.push(`plan ${plan.id} is ${plan.status}; a revision is accepted only for a draft or blocked plan`);
    }
    if (plan && plan.version === proposal.baseVersion && problems.length === 0 && proposal.validation?.ok === true) {
      const draft = { goalId: plan.goalId, goalRevision: plan.goalRevision, ...normalizedChanges(proposal.changes) };
      problems.push(...registryProblems(plans, draft));
    }
  } else if (proposal.kind === 'advice') {
    if (proposal.goalId) {
      const found = await readGoal(goals, proposal.goalId);
      goal = found.goal;
      if (found.problem) problems.push(found.problem);
      else if (!goal) problems.push(`goal ${proposal.goalId} no longer exists`);
      else if (!isOpenStatus(goal.status)) problems.push(`goal ${goal.id} is ${goal.status}; the advice names a closed goal`);
    }
    if (proposal.planId) {
      const found = await readPlan(plans, proposal.planId);
      plan = found.plan;
      if (found.problem) problems.push(found.problem);
      else if (!plan) problems.push(`plan ${proposal.planId} no longer exists`);
    }
  }

  const status = problems.length > 0 && !alreadyApplied ? ProposalStatus.STALE : ProposalStatus.PENDING;
  return { status, problems, goal, plan, alreadyApplied };
}

async function recoverIfApplied(proposal, { goals, plans }) {
  const again = await assessProposal(proposal, { goals, plans, check: true });
  if (again.alreadyApplied) return again;
  return null;
}

// Applies an eligible proposal through ordinary store operations. Returns the record(s) created
// or changed and whether this call found the change already applied (a safe retry).
export async function applyProposal(proposal, { goals, plans, reason = null } = {}) {
  const note = `accepted proposal ${proposal.id}`;
  const why = reason ? `${note}: ${reason}` : note;
  if (proposal.kind === 'goal_create') {
    const assessment = await assessProposal(proposal, { goals, plans });
    if (assessment.alreadyApplied) {
      return { applied: { goalId: assessment.goal.id, planId: null }, goal: assessment.goal, plan: null, alreadyApplied: true };
    }
    try {
      const { goal } = await goals.createGoal({ ...proposal.changes, reason: why });
      return { applied: { goalId: goal.id, planId: null }, goal, plan: null, alreadyApplied: false, note: 'The goal is recorded as proposed; accepting the proposal did not accept the goal itself.' };
    } catch (err) {
      const again = await recoverIfApplied(proposal, { goals, plans });
      if (again) return { applied: { goalId: again.goal.id, planId: null }, goal: again.goal, plan: null, alreadyApplied: true };
      throw err;
    }
  }

  if (proposal.kind === 'goal_clarify') {
    const assessment = await assessProposal(proposal, { goals, plans });
    if (assessment.alreadyApplied) {
      return { applied: { goalId: assessment.goal.id, planId: null }, goal: assessment.goal, plan: null, alreadyApplied: true };
    }
    try {
      const { goal } = await goals.revise(proposal.goalId, { ...proposal.changes, reason: why });
      return { applied: { goalId: goal.id, planId: null }, goal, plan: null, alreadyApplied: false };
    } catch (err) {
      const again = await recoverIfApplied(proposal, { goals, plans });
      if (again) return { applied: { goalId: again.goal.id, planId: null }, goal: again.goal, plan: null, alreadyApplied: true };
      throw err;
    }
  }

  if (proposal.kind === 'plan_create') {
    const assessment = await assessProposal(proposal, { goals, plans });
    if (assessment.alreadyApplied) {
      return { applied: { goalId: proposal.goalId, planId: assessment.plan.id }, goal: assessment.goal, plan: assessment.plan, alreadyApplied: true };
    }
    const result = await plans.createPlan({
      goalId: proposal.goalId,
      ...proposal.changes,
      reason: why,
    });
    return {
      applied: { goalId: result.plan.goalId ?? null, planId: result.plan.id },
      goal: assessment.goal,
      plan: result.plan,
      alreadyApplied: false,
      linkError: result.linkError ?? null,
      note: 'The plan is a draft. It has not been approved, activated, or executed.',
    };
  }

  if (proposal.kind === 'plan_revise') {
    const assessment = await assessProposal(proposal, { goals, plans });
    if (assessment.alreadyApplied) {
      return { applied: { goalId: assessment.plan.goalId ?? null, planId: assessment.plan.id }, goal: assessment.goal, plan: assessment.plan, alreadyApplied: true };
    }
    const result = await plans.revise(proposal.planId, { ...proposal.changes, reason: why });
    return {
      applied: { goalId: result.plan.goalId ?? null, planId: result.plan.id },
      goal: assessment.goal,
      plan: result.plan,
      alreadyApplied: false,
      note: 'The plan is a draft revision. Its earlier approval was cleared, if it had one.',
    };
  }

  // Advice applies nothing. Accepting it records that the user read and accepted the advice,
  // not that any recommended action happened.
  return { applied: { goalId: proposal.goalId ?? null, planId: proposal.planId ?? null }, goal: null, plan: null, alreadyApplied: false };
}
