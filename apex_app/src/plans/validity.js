// Live plan validity.
//
// A stored plan is valid only against the state it names, not against the state that existed when
// it was written. This module re-reads that state and reports every reason the plan cannot be
// approved or started now: a capability that disappeared or changed, an input the action would
// reject, a goal that moved to another revision or stopped, a dependency that is not complete, an
// approval bound to older bytes, a retrieved record that no longer resolves, and a prior step whose
// recorded operation no longer verifies.
//
// It reads only. Nothing here approves, revises, activates, or executes a plan.
import { WORLD_ASSERTION_KINDS, planContentHash, planProgress } from './model.js';

const TERMINAL_GOAL = new Set(['completed', 'failed', 'cancelled', 'abandoned', 'superseded']);

function check(name, ok, detail) {
  return { check: name, ok, detail };
}

async function resolveEvidence(ref, { knowledge, memory, experience }) {
  try {
    if (knowledge && await knowledge.get(ref)) return { found: true, source: 'knowledge' };
  } catch (err) {
    return { found: false, unreadable: err };
  }
  try {
    if (memory && await memory.get(ref)) return { found: true, source: 'memory' };
  } catch (err) {
    return { found: false, unreadable: err };
  }
  try {
    if (experience && await experience.get(ref)) return { found: true, source: 'experience' };
  } catch (err) {
    return { found: false, unreadable: err };
  }
  return { found: false, source: null };
}

// `forActivation` adds the checks that only matter when a task is about to be created from the
// plan: an approved status, an approval bound to the current bytes, and no previously executed step.
export async function assessPlanValidity(plan, {
  goals = null,
  plans = null,
  operations = null,
  knowledge = null,
  memory = null,
  experience = null,
  worldModel = null,
  taskStore = null,
  now = new Date(),
  forActivation = false,
} = {}) {
  const problems = [];
  const checks = [];
  let goal = null;

  const statusOk = forActivation ? plan.status === 'approved' : true;
  checks.push(check('status', statusOk, `plan is ${plan.status}${forActivation && !statusOk ? '; only an approved plan can be started' : ''}`));
  if (!statusOk) problems.push(`plan is ${plan.status}; only an approved plan can be started`);

  if (forActivation) {
    const approval = plan.approval;
    if (!approval) {
      checks.push(check('approval', false, 'the plan has no recorded approval'));
      problems.push('the plan has no recorded approval');
    } else if (approval.version !== plan.version) {
      checks.push(check('approval', false, `approval names version ${approval.version}, but the plan is version ${plan.version}`));
      problems.push(`the approval was given for version ${approval.version}, but the plan is version ${plan.version}; approval must be renewed`);
    } else if (approval.contentHash !== planContentHash(plan)) {
      checks.push(check('approval', false, 'the approval does not match the current plan content'));
      problems.push('the approval does not match the current plan content; it cannot be reused for different steps');
    } else {
      checks.push(check('approval', true, `approval is bound to the current content at version ${plan.version}`));
    }
  }

  const registry = plans && typeof plans.validatePlan === 'function'
    ? plans.validatePlan(plan)
    : { ok: false, problems: ['the plan registry is not available, so no capability can be checked'] };
  checks.push(check('capabilities', registry.ok, registry.ok ? `${registry.steps} step(s) name available, authorized capabilities` : registry.problems.join('; ')));
  problems.push(...registry.problems);

  if (plan.goalId) {
    try {
      goal = goals ? await goals.get(plan.goalId) : null;
    } catch (err) {
      checks.push(check('goal', false, `the goal store could not be read (${err?.code ?? 'store error'})`));
      problems.push(`the goal store could not be read (${err?.code ?? 'store error'}), so the plan's relation to its goal cannot be confirmed`);
    }
    if (!goal && !checks.some((c) => c.check === 'goal')) {
      checks.push(check('goal', false, `goal ${plan.goalId} does not exist`));
      problems.push(`goal ${plan.goalId} no longer exists`);
    } else if (goal) {
      if (TERMINAL_GOAL.has(goal.status)) {
        checks.push(check('goal', false, `goal ${goal.id} is ${goal.status}`));
        problems.push(`goal ${goal.id} is ${goal.status}; its plan cannot be started`);
      } else {
        checks.push(check('goal', true, `goal ${goal.id} is ${goal.status} at revision ${goal.revision ?? 1}`));
      }
      const recordedRevision = plan.goalRevision ?? null;
      const liveRevision = goal.revision ?? 1;
      if (recordedRevision === null) {
        checks.push(check('goal-revision', false, 'the plan does not record the goal revision it was written for'));
        problems.push('the plan does not record the goal revision it was written for, so a changed goal cannot be ruled out; revalidate the plan against the current goal');
      } else if (recordedRevision !== liveRevision) {
        checks.push(check('goal-revision', false, `plan names goal revision ${recordedRevision}, but the goal is revision ${liveRevision}`));
        problems.push(`goal ${goal.id} moved from revision ${recordedRevision} to ${liveRevision}; the plan was written for older criteria and must be revised or revalidated`);
      } else {
        checks.push(check('goal-revision', true, `plan names goal revision ${liveRevision}, which is current`));
      }
      const unmet = [];
      for (const dependencyId of goal.dependsOn ?? []) {
        let dependency = null;
        try {
          dependency = goals ? await goals.get(dependencyId) : null;
        } catch (err) {
          unmet.push(`${dependencyId} could not be read (${err?.code ?? 'store error'})`);
          continue;
        }
        if (!dependency) unmet.push(`${dependencyId} does not exist`);
        else if (dependency.status !== 'completed') unmet.push(`${dependencyId} is ${dependency.status}, not completed`);
      }
      checks.push(check('goal-dependencies', unmet.length === 0, unmet.length === 0 ? 'every goal dependency is complete' : unmet.join('; ')));
      problems.push(...unmet.map((u) => `goal dependency ${u}; the goal cannot proceed until it is completed`));
    }
  }

  const assertionProblems = [];
  const worldProblems = [];
  for (const assertion of plan.assertions ?? []) {
    if (WORLD_ASSERTION_KINDS.includes(assertion.kind)) {
      if (!assertion.ref) {
        worldProblems.push(`an assertion of kind ${assertion.kind} does not name its record`);
        continue;
      }
      if (!worldModel || typeof worldModel.checkStatement !== 'function') {
        worldProblems.push(`the world model is not available, so ${assertion.kind} ${assertion.ref} cannot be checked`);
        continue;
      }
      let status;
      try {
        status = await worldModel.checkStatement({
          targetType: assertion.kind === 'world_fact' ? 'fact' : 'entity',
          targetId: assertion.ref,
          expected: assertion.expected ?? null,
        });
      } catch (err) {
        worldProblems.push(`the world model could not be read (${err?.code ?? 'store error'}), so ${assertion.kind} ${assertion.ref} cannot be checked`);
        continue;
      }
      if (!status.ok) {
        worldProblems.push(`the world ${assertion.kind === 'world_fact' ? 'fact' : 'entity'} ${assertion.ref} no longer supports the plan (${status.state}): ${status.detail}`);
      }
      continue;
    }
    if (!['stored_knowledge', 'retrieved_evidence'].includes(assertion.kind)) continue;
    if (!assertion.ref) {
      assertionProblems.push(`an assertion of kind ${assertion.kind} does not name its record`);
      continue;
    }
    const found = await resolveEvidence(assertion.ref, { knowledge, memory, experience });
    if (found.unreadable) {
      assertionProblems.push(`the record ${assertion.ref} could not be read (${found.unreadable?.code ?? 'store error'})`);
    } else if (!found.found) {
      assertionProblems.push(`the record ${assertion.ref} no longer resolves`);
    }
  }
  const allAssertionProblems = [...assertionProblems, ...worldProblems];
  checks.push(check('assertions', allAssertionProblems.length === 0, allAssertionProblems.length === 0 ? 'every referenced record still resolves and every cited world value still holds' : allAssertionProblems.join('; ')));
  problems.push(...assertionProblems.map((p) => `evidence ${p}`));
  problems.push(...worldProblems.map((p) => `world assertion ${p}`));

  const progress = planProgress(plan);
  const staleOutcomes = [];
  for (const step of plan.steps) {
    const result = plan.stepResults?.[step.id];
    if (!result || result.status !== 'completed' || !result.operationId) continue;
    if (!operations) continue;
    try {
      const found = await operations.findById(result.operationId);
      if (!found.found) staleOutcomes.push(`step ${step.id} cites operation ${result.operationId}, which is not in the audit log`);
      else if (found.record.status !== 'success_verified') staleOutcomes.push(`step ${step.id} cites operation ${result.operationId}, which ended as ${found.record.status}`);
    } catch (err) {
      staleOutcomes.push(`step ${step.id} could not be re-checked (${err?.code ?? 'audit unreadable'})`);
    }
  }
  checks.push(check('recorded-outcomes', staleOutcomes.length === 0, staleOutcomes.length === 0 ? `${progress.completed} completed step(s) still cite verified operations` : staleOutcomes.join('; ')));
  problems.push(...staleOutcomes.map((p) => `recorded outcome ${p}`));

  if (forActivation && progress.completed > 0) {
    problems.push(`the plan already records ${progress.completed} executed step(s); starting it again would repeat work that already happened`);
  }

  return {
    ok: problems.length === 0,
    problems,
    checks,
    goal,
    progress,
    registry,
    liveRevision: goal ? (goal.revision ?? 1) : null,
  };
}

export function renderValidity(validity, { title = 'Live validity' } = {}) {
  const lines = [`${title}: ${validity.ok ? 'passed' : 'NOT passed'}`];
  for (const c of validity.checks) lines.push(`  ${c.ok ? 'ok' : 'FAILED'}  ${c.check}: ${c.detail}`);
  if (!validity.ok) {
    lines.push('The plan cannot be approved or started until these are resolved:');
    for (const p of validity.problems) lines.push(`  - ${p}`);
  }
  lines.push('This check reads the live state only. It wrote nothing and ran nothing.');
  return lines.join('\n');
}
