// General objective planning: the composed answer to "what would it take to do this?".
//
// It is built on top of the T-03 objective outline rather than beside it. The outline already answers
// what the router maps, what no capability can carry, what alternatives the same mapping supports,
// and what the existing plan and task machinery revalidate; this module adds the parts a general
// planner needs on top of that reading - a typed intake with provenance, a milestone hierarchy, a
// six-way feasibility reading of every task, per-task explanation, and a recordable plan content that
// carries the milestones.
//
// Nothing here is generated: every task is the step the existing synthesis already produced, every
// milestone groups those steps by the capability family their actions name, and every feasibility
// class is what the live registry and the absent approval say. The read records nothing, approves
// nothing, and grants nothing; `plan add` and the user's own approval remain the only way a proposal
// becomes a plan.
import { createHash } from 'node:crypto';
import { singleLine, truncate } from '../util.js';
import { stableStringify } from '../tasks/model.js';
import { GoalBasis } from '../goals/model.js';
import {
  MAX_MILESTONE_DESCRIPTION_CHARS,
  MAX_MILESTONE_TITLE_CHARS,
  MAX_PLAN_MILESTONES,
  MAX_VERIFICATION_CHARS,
  validatePlanContent,
} from '../plans/model.js';
import { outlineObjective } from '../plans/objective.js';
import { intakeOf, intakeDigest } from './intake.js';
import { classifyTasks } from './feasibility.js';

export const PLANNING_SCHEMA = 'apex.objective-planning.v1';
export const MAX_TASK_ROWS = 24;

export const PLANNING_NOTE = 'this planning read records nothing, approves nothing, and runs nothing. '
  + 'The intake says which statements are the user\'s and which this read inferred, every task is a step '
  + 'the existing router already mapped, and every feasibility class is the live registry\'s answer. A plan '
  + 'becomes real only through `plan add` and the user\'s own approval.';

export const PLANNING_RULES = Object.freeze({
  intake: 'the objective and the user\'s flags are user_stated; goal items keep the basis the goal recorded; anything this read concluded is system_inferred, and an unknown is named rather than filled in',
  decomposition: 'a part becomes a task only when the existing router maps it to a registered action with accepted input; an unmatched part is shown as a task with no capability rather than guessed into one',
  milestones: 'milestones are grouped by the capability family of each step action, first appearance first; this is a proposal the user can revise, not a phase boundary the user recorded',
  dependencies: 'the only dependency recorded is the written order the synthesis already imposes; no data dependency is inferred between steps',
  feasibility: 'every class is read from the live registry, the request\'s exclusions, and the absence of an approval; nothing is scored or assumed runnable',
  approval: 'this read is not a plan; `plan add` records a draft and `plan approve` is the user\'s own decision, bound to the exact bytes',
  execution: 'approval does not run anything by itself: `plan start` creates a user-origin task only from an approved plan, and the runner re-asks the registry before each step',
});

function partsWithNearby(outline) {
  let k = 0;
  return outline.parts.map((row) => {
    if (row.action) return row;
    const missing = outline.missingCapabilities[k] ?? null;
    k += 1;
    return { ...row, nearby: missing?.nearby ?? [] };
  });
}

function tasksOf(parts, cannotUse) {
  const excluded = new Set(cannotUse);
  const tasks = [];
  let unmapped = 0;
  for (const part of parts) {
    if (part.action) {
      tasks.push({
        id: part.id,
        kind: 'step',
        part: part.part,
        description: part.description,
        text: part.text,
        action: part.action,
        capability: part.capability,
        permission: part.permission,
        input: part.input,
        dependsOn: [...part.dependsOn],
        dependencyBasis: part.dependencyBasis ?? null,
        expectedResult: part.expectedResult,
        verification: part.verification,
        risk: part.risk,
        recovery: part.recovery,
        authorization: part.authorization,
        plannable: part.plannable,
        excludedByRequest: excluded.has(part.action),
        completed: null,
      });
      continue;
    }
    unmapped += 1;
    tasks.push({
      id: `x${unmapped}`,
      kind: 'unmapped',
      part: part.part,
      description: part.text,
      text: part.text,
      action: null,
      dependsOn: [],
      expectedResult: null,
      verification: null,
      risk: null,
      reason: part.reason ?? 'no registered action matches this part of the request',
      nearby: part.nearby ?? [],
      completed: null,
    });
  }
  return tasks.slice(0, MAX_TASK_ROWS);
}

function familyOf(action) {
  return String(action).split('.')[0] || String(action);
}

function titleOf(family) {
  const words = String(family).replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Milestones are proposed from the capability families the mapped steps already name. The grouping is
// contiguous in written order and deterministic, and it adds no step and no ordering of its own: a
// milestone that would owe its existence to a guess about phases does not exist here.
function milestonesOf(stepTasks) {
  if (stepTasks.length === 0) return { records: [], groups: [], byStep: new Map() };
  const groups = [];
  const index = new Map();
  for (const task of stepTasks) {
    const family = familyOf(task.action);
    if (!index.has(family)) {
      index.set(family, groups.length);
      groups.push({ family, steps: [] });
    }
    groups[index.get(family)].steps.push(task);
  }
  let entries = groups;
  if (groups.length > MAX_PLAN_MILESTONES) {
    const head = groups.slice(0, MAX_PLAN_MILESTONES - 1);
    const rest = groups.slice(MAX_PLAN_MILESTONES - 1);
    entries = [
      ...head,
      { family: null, families: rest.map((g) => g.family), steps: rest.flatMap((g) => g.steps) },
    ];
  }

  const records = [];
  const annotated = [];
  const byStep = new Map();
  entries.forEach((entry, i) => {
    const id = `m${i + 1}`;
    const ids = entry.steps.map((t) => t.id);
    const families = entry.family ? [entry.family] : entry.families;
    const actions = [...new Set(entry.steps.map((t) => t.action))];
    const title = entry.family ? titleOf(entry.family) : 'Remaining steps';
    const description = entry.family
      ? `Steps ${ids.join(', ')}: every step whose action belongs to the ${entry.family} family, in written order.`
      : `Steps ${ids.join(', ')}: the remaining capability families (${families.join(', ')}), in written order.`;
    const checkpoint = 'every step grouped here holds an operation record whose outcome is verified';
    const verification = `the verifiers of ${actions.join(', ')} re-read their own records; this milestone is settled only when all of its steps are verified`;
    records.push({
      id,
      title: truncate(title, MAX_MILESTONE_TITLE_CHARS),
      description: truncate(description, MAX_MILESTONE_DESCRIPTION_CHARS),
      dependsOn: i === 0 ? [] : [`m${i}`],
      checkpoint: truncate(checkpoint, MAX_VERIFICATION_CHARS),
      verification: truncate(verification, MAX_VERIFICATION_CHARS),
    });
    annotated.push({
      id,
      title: records[records.length - 1].title,
      steps: ids,
      families,
      dependsOn: records[records.length - 1].dependsOn,
      checkpoint: records[records.length - 1].checkpoint,
      verification: records[records.length - 1].verification,
      basis: GoalBasis.SYSTEM_INFERRED,
      rule: PLANNING_RULES.milestones,
    });
    for (const stepId of ids) byStep.set(stepId, id);
  });
  return { records, groups: annotated, byStep };
}

function crossMilestoneDependencies(tasks, byStep) {
  const rows = [];
  for (const task of tasks) {
    if (task.kind !== 'step') continue;
    const to = byStep.get(task.id);
    for (const dep of task.dependsOn) {
      const from = byStep.get(dep);
      if (from && to && from !== to) {
        rows.push({ step: task.id, dependsOn: dep, from, to });
      }
    }
  }
  return rows;
}

function planningDraft(outline, milestones, byStep) {
  if (!outline.draft?.content) {
    return {
      available: false,
      recordable: false,
      content: null,
      reason: outline.draftWithheld ?? (outline.draft ? 'the outline held a draft but it did not validate' : 'no recordable draft was produced'),
      validation: { ok: false, problems: outline.draft?.validation?.problems ?? [] },
    };
  }
  const content = {
    ...outline.draft.content,
    ...(milestones.length > 0 ? { milestones } : {}),
    steps: outline.draft.content.steps.map((s) => {
      const milestoneId = byStep.get(s.id);
      return milestoneId ? { ...s, milestoneId } : { ...s };
    }),
  };
  const problems = validatePlanContent(content);
  return {
    available: true,
    recordable: problems.length === 0,
    content: problems.length === 0 ? content : null,
    reason: problems.length === 0 ? null : 'the planning draft did not validate against the plan content rules',
    validation: { ok: problems.length === 0, problems },
  };
}

function priorityOf(intake) {
  const value = intake.goal?.priority;
  if (!Number.isInteger(value)) return null;
  const band = value <= 2 ? 'high' : value === 3 ? 'normal' : 'low';
  return {
    value: band,
    basis: GoalBasis.SYSTEM_INFERRED,
    rule: `goal priority ${value} of 5 mapped to the plan band ${band}; the goal's own scale is 1-5 and the plan's is low/normal/high`,
  };
}

function explainOf(task, row, intake, priority) {
  return {
    why: task.kind === 'step'
      ? `part ${task.part} of the objective, written as "${truncate(singleLine(task.text), 160)}"`
      : `part ${task.part} of the objective: "${truncate(singleLine(task.text), 160)}" is not carried by any registered capability`,
    capability: task.action ?? null,
    evidence: task.action
      ? {
        registered: row.evidence.registered,
        plannable: row.evidence.plannable,
        permission: row.evidence.permission,
        userAuthorized: row.evidence.userDecision,
        hasVerifier: row.evidence.hasVerifier,
        basis: `read from the live registry entry for ${task.action}`,
      }
      : {
        nearby: (task.nearby ?? []).map((n) => n.action),
        basis: 'name and description word match only; no nearby action was asked to accept this input',
      },
    assumptions: intake.assumptions.map((a) => a.text),
    ...(priority ? { priority } : {}),
    blockedBy: row.class === 'blocked' ? (row.blockedBecause ?? row.because) : null,
    approval: task.action
      ? 'the plan as a whole must be approved before any step runs, and approval binds these exact bytes'
      : null,
    completion: task.expectedResult
      ? { expected: task.expectedResult, verifiedBy: task.verification }
      : null,
    estimate: {
      seconds: null,
      because: 'the audit log holds no per-action duration this read could average, so no effort is estimated',
    },
    provenance: [
      { source: 'objective', ref: `part ${task.part}` },
      ...(task.action ? [{ source: 'registry', ref: task.action }] : []),
      ...(task.action ? [{ source: 'plan content', ref: 'synthesized step' }] : []),
      ...(intake.goal ? [{ source: 'goal', ref: intake.goal.id }] : []),
    ],
    heuristic: task.action
      ? 'the capability, its permission, and its verifier are registry facts; the order is the order written, not an inferred dependency'
      : 'the nearby names are a word lookup, not a recommendation',
  };
}

function planningDeliverables(intake) {
  return {
    listed: intake.deliverables.map((d) => ({ text: d.text, basis: d.basis })),
    statement: 'a deliverable is verified only when a step\'s own verifier re-reads the record that would carry it; this read did not match the stated deliverables to steps, so none is marked verified here',
  };
}

function planningUncertainty(outline, intake, milestones, priority) {
  const lines = [];
  if (milestones.length > 0) {
    lines.push('the milestones are grouped by capability family in written order; they are a proposal, not a phase boundary the user recorded or the registry requires');
  }
  if (priority) lines.push(priority.rule);
  if (intake.deliverables.length > 0) {
    lines.push(`${intake.deliverables.length} deliverable(s) were stated and no step was matched to them by name; completion means each step\'s verifier re-read its record, not that a deliverable was accepted`);
  }
  lines.push('this is a planning read: no approval is present, so every otherwise-ready step is classed needs_approval and no step is classed ready until an approval binds these bytes');
  lines.push('feasibility is read from the live registry at this moment; a capability that moves later changes the answer, which is why the plan is validated again at add, approval, and before each step');
  return [...outline.uncertainty, ...lines].slice(0, 14);
}

export function planObjective({
  objective, registry, goal = null, cannotUse = [], stated = {}, completed = null, outline = null,
} = {}) {
  const read = outline ?? outlineObjective({ objective, registry, goal, cannotUse });
  const parts = partsWithNearby(read);
  const excludes = [...new Set((cannotUse ?? []).map((n) => String(n).trim()).filter(Boolean))].sort();
  const intake = intakeOf({ objective, goal, stated, parts, cannotUse: excludes });

  const tasks = tasksOf(parts, excludes);
  const stepTasks = tasks.filter((t) => t.kind === 'step');
  const { records, groups, byStep } = milestonesOf(stepTasks);
  const completedMap = completed && typeof completed === 'object' ? completed : {};
  for (const task of tasks) {
    if (completedMap[task.id]) task.completed = completedMap[task.id];
  }

  const approvalWhy = 'this read records nothing, so no approval binds the content it describes; `plan add` records a draft and `plan approve` is the user\'s own decision';
  const feasibility = classifyTasks({ tasks, registry, approval: { bound: false, why: approvalWhy } });
  const priority = priorityOf(intake);

  const rows = tasks.map((task, i) => {
    const row = feasibility.rows[i];
    return {
      id: task.id,
      kind: task.kind,
      part: task.part,
      description: task.description,
      action: task.action,
      capability: task.capability ?? null,
      permission: task.permission ?? null,
      input: task.input ?? null,
      dependsOn: [...task.dependsOn],
      ...(byStep.get(task.id) ? { milestoneId: byStep.get(task.id) } : {}),
      ...(task.expectedResult ? { expectedResult: task.expectedResult } : {}),
      ...(task.verification ? { verification: task.verification } : {}),
      ...(task.risk ? { risk: task.risk } : {}),
      ...(task.reason ? { reason: task.reason } : {}),
      ...(task.nearby?.length ? { nearby: task.nearby.map((n) => n.action) } : {}),
      class: row.class,
      because: row.because,
      ...(row.blockedBy ? { blockedBy: row.blockedBy } : {}),
      explanation: explainOf(task, row, intake, priority),
    };
  });

  const draft = planningDraft(read, records, byStep);
  const planning = {
    schema: PLANNING_SCHEMA,
    note: PLANNING_NOTE,
    rules: PLANNING_RULES,
    objective: intake.objective,
    outlineDigest: read.digest,
    intake,
    goal: intake.goal,
    tasks: rows,
    milestones: groups,
    crossMilestoneDependencies: crossMilestoneDependencies(tasks, byStep),
    draft,
    feasibility,
    conflicts: intake.conflicts,
    ambiguity: intake.ambiguity,
    deliverables: planningDeliverables(intake),
    execution: {
      mode: 'sequential',
      parallel: false,
      because: 'the TaskRunner has no parallel path, so steps run one at a time in the order recorded and independence is never assumed',
      activation: 'plan start creates a user-origin task only from an approved plan and re-checks the status, version, content hash, and the one-live-plan-per-goal bound',
      eachStep: 'before each step runs, the controller asks the registry for authorization again; a changed registry stops the task rather than being ignored',
      failure: 'a failed or uncertain step stops the task; steps that depend on it are recorded as skipped and are never run on a failed prerequisite',
      resume: 'plan continuation reads which steps never started, and plan continue takes up only those; a step whose effect may have landed is never replayed',
      completion: 'a step is completed only when its own verifier re-reads its record; completing every step completes the plan, which remains separate from a goal\'s criteria and evidence',
    },
    approval: {
      required: true,
      bound: false,
      why: approvalWhy,
      path: 'plan add records the draft; plan approve binds the content hash; plan start runs it, and a revised plan needs its own approval',
    },
    revision: {
      command: 'plan revise <plan-id> --outcome <text> --step <json>... [--milestone <json>]... --reason <text>',
      attachedTo: null,
      statement: 'a recorded plan keeps every version and the reason for it; a revision is a new version with its own content hash and needs its own approval. This read is not attached to a recorded plan, so there is no revision history to show.',
    },
    learning: {
      automatic: false,
      path: 'verified step outcomes are recorded against the plan and read back by plan outcome and plan assess; a pattern drawn from them is an improvement proposal the user approves, never a planner behaviour change this read makes',
    },
    uncertainty: planningUncertainty(read, intake, groups, priority),
    risks: read.risks,
    counts: {
      ...read.counts,
      tasks: rows.length,
      milestones: groups.length,
      ...feasibility.counts,
    },
    authorizes: false,
    recorded: false,
    approved: false,
    executable: false,
  };
  planning.digest = planningDigest(planning);
  return planning;
}

export function planningDigest(planning) {
  return createHash('sha256').update(stableStringify({
    schema: planning.schema,
    objective: planning.objective,
    outlineDigest: planning.outlineDigest,
    intakeDigest: intakeDigest(planning.intake),
    goal: planning.goal,
    tasks: planning.tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      part: t.part,
      action: t.action,
      permission: t.permission,
      input: t.input,
      dependsOn: t.dependsOn,
      milestoneId: t.milestoneId ?? null,
      class: t.class,
      because: t.because,
    })),
    milestones: planning.milestones,
    crossMilestoneDependencies: planning.crossMilestoneDependencies,
    draft: planning.draft,
    feasibility: {
      schema: planning.feasibility.schema,
      approval: planning.feasibility.approval,
      counts: planning.feasibility.counts,
      rows: planning.feasibility.rows,
      cycles: planning.feasibility.cycles,
    },
    conflicts: planning.conflicts,
    ambiguity: planning.ambiguity,
    deliverables: planning.deliverables,
    execution: planning.execution,
    approval: planning.approval,
    revision: planning.revision,
    learning: planning.learning,
    uncertainty: planning.uncertainty,
    risks: planning.risks,
    counts: planning.counts,
    authorizes: planning.authorizes,
    recorded: planning.recorded,
    approved: planning.approved,
    executable: planning.executable,
  })).digest('hex');
}

// The plan content this proposal would become, as `plan add` would receive it, or null. Present only
// when the content validates; the caller still has to record and approve it in separate acts.
export function planningContent(planning) {
  return planning?.draft?.content ?? null;
}
