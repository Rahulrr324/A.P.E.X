// Objective intake: what the user asked for, kept apart from what this read inferred.
//
// A plan is only as honest as the distance between the user's words and the planner's reading of
// them. Every item here carries the basis it entered with: `user_stated` for the objective and the
// flags the user wrote, the goal item's own recorded basis for anything copied from a goal,
// `system_inferred` for a conclusion this read drew, and `assumption` for something taken to hold
// without evidence. Nothing is promoted on the way through: an assumption does not become a fact
// because a plan needs it to, and an unknown stays unknown and is named as a question rather than
// being filled in with a plausible value.
//
// The module reads no store and holds no clock. It takes the objective, the goal record the caller
// already resolved, the user's explicit flags, and the parts the outline mapped, and returns typed
// intake plus the conflicts and ambiguity those records actually support.
import { createHash } from 'node:crypto';
import { singleLine, truncate } from '../util.js';
import { stableStringify } from '../tasks/model.js';
import { GoalBasis, GOAL_ITEM_FIELDS } from '../goals/model.js';

export const INTAKE_SCHEMA = 'apex.planning-intake.v1';
export const MAX_INTAKE_ITEMS = 12;
export const MAX_INTAKE_ITEM_CHARS = 300;
export const MAX_INTAKE_QUESTIONS = 6;

export const INTAKE_NOTE = 'every item records where it came from; an inferred or assumed item is never '
  + 'presented as something the user stated, and an unknown is named as a question rather than resolved here';

// A goal in one of these states is not open to new work, so a plan recorded against it would bind a
// record that has already moved on. The states themselves are the store's, read rather than restated.
const CLOSED_GOAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'abandoned', 'superseded']);
const UNACCEPTED_GOAL_STATUSES = new Set(['proposed']);

function listOf(value, name) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const clean = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw new TypeError(`${name} must be text`);
    const text = singleLine(raw).trim();
    if (text.length === 0) continue;
    if (text.length > MAX_INTAKE_ITEM_CHARS) throw new TypeError(`${name} exceeds ${MAX_INTAKE_ITEM_CHARS} characters`);
    if (!clean.includes(text)) clean.push(text);
  }
  if (clean.length > MAX_INTAKE_ITEMS) throw new TypeError(`${name} may name at most ${MAX_INTAKE_ITEMS} items`);
  return clean;
}

function item(text, basis, source, extra = {}) {
  return {
    text: truncate(singleLine(String(text)), MAX_INTAKE_ITEM_CHARS),
    basis,
    source,
    ...extra,
  };
}

function statedItems(values, field, source) {
  return values.map((text) => item(text, GoalBasis.USER_STATED, source, { field }));
}

function goalItems(goal, field) {
  const list = Array.isArray(goal?.[field]) ? goal[field] : [];
  return list.slice(0, MAX_INTAKE_ITEMS).map((entry) => item(
    entry.text,
    entry.basis ?? GoalBasis.USER_STATED,
    `goal.${field}`,
    { field, ...(entry.ref ? { ref: entry.ref } : {}) },
  ));
}

function criteriaOf(goal) {
  const criteria = Array.isArray(goal?.criteria) ? goal.criteria : [];
  return criteria.slice(0, MAX_INTAKE_ITEMS).map((c) => ({
    id: c.id ?? null,
    description: truncate(singleLine(String(c.description ?? '')), MAX_INTAKE_ITEM_CHARS),
    basis: c.basis ?? GoalBasis.USER_STATED,
    requirement: c.requirement ?? null,
    status: c.status ?? null,
    ...(c.ref ? { ref: c.ref } : {}),
    ...(c.requiredEvidence ? { requiredEvidence: truncate(singleLine(String(c.requiredEvidence)), MAX_INTAKE_ITEM_CHARS) } : {}),
    source: 'goal.criteria',
  }));
}

// The two readings a partly-supported objective genuinely has: record what the registry can carry
// now, or supply the missing parts first and then plan the whole request. They produce different
// plans, so the difference is stated instead of one being chosen silently.
function ambiguityOf({ parts, cannotUse, goal, mapped }) {
  const missing = (parts ?? []).filter((p) => !p.action);
  const material = missing.length > 0 && mapped > 0;
  const interpretations = [];
  const questions = [];

  if (material) {
    interpretations.push({
      kind: 'supported_only',
      title: 'Record only the parts a registered capability can carry now',
      note: 'the plan covers the mapped parts and names the missing ones outside it; the objective is not fully met by this reading',
    });
    interpretations.push({
      kind: 'supply_missing',
      title: 'Supply the missing parts, then plan the whole objective',
      note: 'each missing part has to become a registered action with valid input, or be reworded, before it can be a step',
    });
  }
  if (mapped === 0 && (parts ?? []).length > 0) {
    interpretations.push({
      kind: 'nothing_supported',
      title: 'No part of this objective can be a plan step now',
      note: 'no registered action matches the request, so nothing executable can be recorded against it',
    });
  }
  for (const [i, part] of missing.entries()) {
    if (questions.length >= MAX_INTAKE_QUESTIONS) break;
    const nearby = part.nearby ?? [];
    questions.push({
      part: part.part ?? i,
      question: `Which registered capability should carry "${truncate(singleLine(part.text), 120)}", or should it be left out of the plan?`,
      ...(nearby.length > 0 ? { candidates: nearby.map((n) => n.action) } : {}),
    });
  }
  if (cannotUse.length > 0 && mapped > 0) {
    interpretations.push({
      kind: 'exclusions_honored',
      title: 'The capabilities the request excluded are not offered',
      note: `the request asked this read not to offer ${cannotUse.join(', ')}; a plan that carried them would not be the plan that was asked for`,
    });
  }

  return {
    material,
    because: material
      ? `${missing.length} part(s) of the objective cannot be carried as the request stands while ${mapped} can, and the two readings produce different plans`
      : mapped === 0 && (parts ?? []).length > 0
        ? 'no part of the objective matches a registered action, so no reading of it produces a plan step'
        : 'every part of the objective that maps is supported, so no competing reading changes the plan',
    interpretations,
    questions,
    ...(goal ? { goalStatements: 'the goal record is read as it stands; no criterion, constraint, or blocker was retyped to fit the plan' } : {}),
  };
}

function conflictsOf({ goal, parts, cannotUse }) {
  const conflicts = [];
  if (goal) {
    if (CLOSED_GOAL_STATUSES.has(goal.status)) {
      conflicts.push({
        kind: 'goal_closed',
        text: `the goal ${goal.id} is recorded ${goal.status}, so a plan recorded against it would bind a goal that is no longer open`,
        basis: GoalBasis.VERIFIED_FACT,
        ref: goal.id,
      });
    } else if (UNACCEPTED_GOAL_STATUSES.has(goal.status)) {
      conflicts.push({
        kind: 'goal_not_accepted',
        text: `the goal ${goal.id} is recorded ${goal.status}: the user has not accepted it yet, so a plan recorded against it would bind a proposal`,
        basis: GoalBasis.VERIFIED_FACT,
        ref: goal.id,
      });
    }
    for (const field of GOAL_ITEM_FIELDS) {
      if (field !== 'blockers') continue;
      for (const blocker of goalItems(goal, 'blockers')) {
        conflicts.push({
          kind: 'goal_blocker',
          text: blocker.text,
          basis: blocker.basis,
          ...(blocker.ref ? { ref: blocker.ref } : {}),
          source: 'goal.blockers',
        });
      }
    }
  }
  if (cannotUse.length > 0) {
    const excluded = new Set(cannotUse);
    for (const part of parts ?? []) {
      if (!part.action || !excluded.has(part.action)) continue;
      conflicts.push({
        kind: 'request_excludes_named_capability',
        text: `part ${part.part} names ${part.action}, and the same request asked this read not to offer ${part.action}`,
        basis: GoalBasis.USER_STATED,
        ref: part.id ?? null,
      });
    }
  }
  return conflicts;
}

function assumptionsOf({ goal }) {
  const assumptions = [];
  if (goal) {
    assumptions.push({
      text: 'the objective serves the recorded goal; this read did not check that the goal\'s success criteria are met by these steps',
      basis: GoalBasis.SYSTEM_INFERRED,
      source: 'goal',
      why: 'a plan and a goal are recorded separately, and completing steps does not satisfy criteria without evidence',
    });
  }
  return assumptions;
}

export function intakeOf({ objective, goal = null, stated = {}, parts = null, cannotUse = [] } = {}) {
  const text = String(objective ?? '').trim();
  if (text.length === 0) throw new TypeError('an objective is required');
  const excludes = [...new Set((cannotUse ?? []).map((n) => String(n).trim()).filter(Boolean))].sort();
  const flags = {
    constraints: listOf(stated.constraints, 'constraints'),
    deliverables: listOf(stated.deliverables, 'deliverables'),
    preferences: listOf(stated.preferences, 'preferences'),
    resources: listOf(stated.resources, 'resources'),
    deadlines: listOf(stated.deadlines, 'deadlines'),
  };
  const priority = stated.priority === undefined || stated.priority === null
    ? null
    : listOf([stated.priority], 'priority')[0] ?? null;

  const partsList = Array.isArray(parts) ? parts : [];
  const mapped = partsList.filter((p) => p.action).length;

  const unknowns = [
    ...goalItems(goal, 'unknowns'),
    ...partsList.filter((p) => !p.action).map((p) => item(
      p.text,
      GoalBasis.SYSTEM_INFERRED,
      'objective.unmatched',
      { field: 'unknowns', part: p.part, question: `which registered capability should carry "${truncate(singleLine(p.text), 100)}"?` },
    )),
  ].slice(0, MAX_INTAKE_ITEMS);

  const intake = {
    schema: INTAKE_SCHEMA,
    note: INTAKE_NOTE,
    objective: item(text, GoalBasis.USER_STATED, 'objective'),
    goal: goal
      ? {
        id: goal.id,
        revision: goal.revision ?? null,
        status: goal.status ?? null,
        priority: Number.isInteger(goal.priority) ? goal.priority : null,
        deadline: typeof goal.deadline === 'string' ? goal.deadline : null,
      }
      : null,
    constraints: [
      ...goalItems(goal, 'prerequisites'),
      ...goalItems(goal, 'constraints'),
      ...(goal?.deadline ? [item(goal.deadline, GoalBasis.USER_STATED, 'goal.deadline', { field: 'deadlines', at: goal.deadline })] : []),
      ...statedItems(flags.constraints, 'constraints', 'flag'),
      ...statedItems(flags.deadlines, 'deadlines', 'flag'),
    ].slice(0, MAX_INTAKE_ITEMS * 2),
    deadlines: [
      ...(goal?.deadline ? [item(goal.deadline, GoalBasis.USER_STATED, 'goal.deadline', { field: 'deadlines', at: goal.deadline })] : []),
      ...statedItems(flags.deadlines, 'deadlines', 'flag'),
    ].slice(0, MAX_INTAKE_ITEMS),
    priorities: [
      ...(Number.isInteger(goal?.priority)
        ? [item(`goal priority ${goal.priority} of 5`, GoalBasis.USER_STATED, 'goal.priority', { field: 'priorities', value: goal.priority })]
        : []),
      ...(priority ? [item(`priority: ${priority}`, GoalBasis.USER_STATED, 'flag', { field: 'priorities', value: priority })] : []),
    ],
    // The goal record has no deliverables field, so nothing is derived from it here: a deliverable
    // is only what the user stated, and an empty list says none was stated rather than inventing one.
    deliverables: statedItems(flags.deliverables, 'deliverables', 'flag').slice(0, MAX_INTAKE_ITEMS),
    resources: [
      ...goalItems(goal, 'resources'),
      ...statedItems(flags.resources, 'resources', 'flag'),
    ].slice(0, MAX_INTAKE_ITEMS),
    preferences: statedItems(flags.preferences, 'preferences', 'flag'),
    successCriteria: criteriaOf(goal),
    unknowns,
    assumptions: assumptionsOf({ goal }),
    conflicts: conflictsOf({ goal, parts: partsList, cannotUse: excludes }),
    ambiguity: ambiguityOf({ parts: partsList, cannotUse: excludes, goal, mapped }),
    records: {
      goalRead: Boolean(goal),
      criteria: criteriaOf(goal).length,
      unmappedParts: partsList.filter((p) => !p.action).length,
      mappedParts: mapped,
      excludes,
    },
  };
  intake.digest = intakeDigest(intake);
  return intake;
}

export function intakeDigest(intake) {
  return createHash('sha256').update(stableStringify({
    schema: intake.schema,
    objective: intake.objective,
    goal: intake.goal,
    constraints: intake.constraints,
    deadlines: intake.deadlines,
    priorities: intake.priorities,
    deliverables: intake.deliverables,
    resources: intake.resources,
    preferences: intake.preferences,
    successCriteria: intake.successCriteria,
    unknowns: intake.unknowns,
    assumptions: intake.assumptions,
    conflicts: intake.conflicts,
    ambiguity: intake.ambiguity,
    records: intake.records,
  })).digest('hex');
}
