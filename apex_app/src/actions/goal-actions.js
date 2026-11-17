// Goal actions: the user-facing surface of the goal store, registered by the composition root.
//
// Trust boundaries:
//  - a goal is a record of what the user intends, never permission to act on it. Every
//    action that might help a goal still passes the registry's own authorization;
//  - every write here is user-origin only and unplannable, so a model cannot create,
//    alter, complete, or link a goal, and cannot smuggle one into a plan;
//  - completion is refused unless every success criterion carries supporting evidence
//    whose audit operation is still a verified success. `goal.complete` re-checks that
//    independently after the write instead of trusting the store's claim.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, shortId, singleLine } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { ORIGIN_USER } from './origins.js';
import {
  CRITERION_DECISIONS,
  CRITERION_ID_RE,
  EVIDENCE_KINDS,
  GOAL_ITEM_FIELDS,
  GoalBasis,
  GoalStatus,
  MAX_CRITERIA,
  MAX_CRITERION_CHARS,
  MAX_GOAL_DEPENDENCIES,
  MAX_GOAL_DETAIL_CHARS,
  MAX_GOAL_ITEMS,
  MAX_GOAL_ITEM_CHARS,
  MAX_GOAL_REASON_CHARS,
  MAX_GOAL_REQUEST_CHARS,
  Requirement,
  basisOf,
  goalProgress,
  needsUserDecision,
  requirementOf,
} from '../goals/model.js';
import { renderGoal } from '../goals/format.js';
import { EvidenceVerdict, assessGoal } from '../goals/assess.js';

function textField(value, name, max) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const t = value.trim();
  if (t.length === 0) throw new ValidationError(`${name} is empty`);
  if (t.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if (CONTROL_CHARS.test(t)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(t)) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  }
  return t;
}

function optionalTextField(value, name, max) {
  if (value === undefined || value === null) return null;
  return textField(value, name, max);
}

function recordRef(value, name) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const ref = value.trim();
  if (ref.length === 0) throw new ValidationError(`${name} is empty`);
  if (ref.length > 64) throw new ValidationError(`${name} is longer than 64 characters`);
  if (CONTROL_CHARS.test(ref)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(ref)) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not used`, 'SECRET_REFUSED');
  }
  return ref;
}

function linkTargetLabel({ planId, taskId, entityId, worldEventId }) {
  if (planId) return `plan ${shortId(planId)}`;
  if (taskId) return `task ${shortId(taskId)}`;
  if (entityId) return `world entity ${shortId(entityId)}`;
  return `world event ${shortId(worldEventId)}`;
}

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

// A criterion is either the user's own words or an object that says where it came from and what
// would prove it. The store re-checks the provenance rules (an inference cannot be recorded as a
// requirement, a declined criterion comes only from goal.confirm), so this screens the shape and
// the text and leaves one authority for what a criterion may hold.
function criterionList(value) {
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError('at least one success criterion is required');
  if (value.length > MAX_CRITERIA) throw new ValidationError(`at most ${MAX_CRITERIA} success criteria are allowed`);
  return value.map((entry, i) => {
    if (typeof entry === 'string') return textField(entry, `criterion ${i + 1}`, MAX_CRITERION_CHARS);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`criterion ${i + 1} must be text or an object`);
    }
    for (const key of Object.keys(entry)) {
      if (!['id', 'description', 'basis', 'requirement', 'ref', 'requiredEvidence'].includes(key)) {
        throw new ValidationError(`criterion ${i + 1}: unexpected field "${singleLine(key, 40)}"`);
      }
    }
    return { ...entry, description: textField(entry.description, `criterion ${i + 1}`, MAX_CRITERION_CHARS) };
  });
}

const criterionText = (entry) => (typeof entry === 'string' ? entry : entry.description);
const criterionBasis = (entry) => (typeof entry === 'string' ? GoalBasis.USER_STATED : basisOf({ basis: entry.basis }));
// What the record must end up saying: the user's own criterion gates completion, anything APEX
// put forward gates nothing until goal.confirm says otherwise.
const criterionRequirement = (entry) => {
  if (typeof entry === 'string') return Requirement.REQUIRED;
  if (entry.requirement !== undefined && entry.requirement !== null) return entry.requirement;
  return criterionBasis(entry) === GoalBasis.USER_STATED ? Requirement.REQUIRED : Requirement.SUGGESTED;
};

// One decomposition field. Absent means nothing was said about it; an empty list means the user
// said there are none. The two are different records and the store keeps them apart.
function itemsInput(value, name) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be a list`);
  if (value.length > MAX_GOAL_ITEMS) throw new ValidationError(`${name} may hold at most ${MAX_GOAL_ITEMS} items`);
  return value.map((entry, i) => {
    if (typeof entry === 'string') return textField(entry, `${name} ${i + 1}`, MAX_GOAL_ITEM_CHARS);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`${name} ${i + 1} must be text or an object`);
    }
    for (const key of Object.keys(entry)) {
      if (!['text', 'basis', 'ref'].includes(key)) {
        throw new ValidationError(`${name} ${i + 1}: unexpected field "${singleLine(key, 40)}"`);
      }
    }
    return { ...entry, text: textField(entry.text, `${name} ${i + 1}`, MAX_GOAL_ITEM_CHARS) };
  });
}

function decompositionOf(input) {
  return Object.fromEntries(GOAL_ITEM_FIELDS.map((field) => [field, itemsInput(input[field], field)]));
}

const itemText = (entry) => (typeof entry === 'string' ? entry : entry.text);

// Compares the decomposition the caller asked for with the record that was written. A field the
// caller did not send is not compared; a field sent empty must read back empty.
function decompositionMismatch(stored, requested) {
  for (const field of GOAL_ITEM_FIELDS) {
    const want = requested[field];
    if (want === undefined) continue;
    const got = stored[field] ?? [];
    if (got.length !== want.length) return field;
    if (got.some((item, i) => item.text !== itemText(want[i]))) return field;
  }
  return null;
}

function dependencyList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('dependsOn must be a list of goal ids');
  if (value.length > MAX_GOAL_DEPENDENCIES) throw new ValidationError(`dependsOn may name at most ${MAX_GOAL_DEPENDENCIES} goals`);
  return value.map((entry) => recordRef(entry, 'dependency'));
}

function statusValue(value) {
  if (typeof value !== 'string' || !Object.values(GoalStatus).includes(value.trim())) {
    throw new ValidationError(`status must be one of: ${Object.values(GoalStatus).join(', ')}`);
  }
  return value.trim();
}

export function goalActions(store) {
  if (!store || typeof store.createGoal !== 'function') {
    throw new TypeError('goalActions requires a goal store');
  }
  return [
    {
      name: 'goal.add',
      description: 'Record a goal: the user\'s request, its success criteria, priority, optional deadline, dependencies, and the bounded decomposition (prerequisites, constraints, resources, time conditions, blockers, unknowns). A criterion stated as text is the user\'s own requirement; one recorded as an inference or an assumption is a suggestion until goal.confirm decides it. A goal is a record of intent, not permission to act. Write: user origin only.',
      inputHint: '{"request":"what the user wants","criteria":["at least one success criterion",{"description":"an inference APEX drew","basis":"system_inferred","requiredEvidence":"what would prove it"}],"priority":"optional 1-5","deadline":"optional ISO date","dependsOn":["optional goal ids"],"prerequisites":[],"constraints":[],"resources":[],"timeConditions":[],"blockers":[],"unknowns":[],"reason":"optional"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['request', 'criteria', 'priority', 'deadline', 'dependsOn', ...GOAL_ITEM_FIELDS]);
        const request = textField(o.request, 'request', MAX_GOAL_REQUEST_CHARS);
        const criteria = criterionList(o.criteria);
        const decomposition = decompositionOf(o);
        const priority = o.priority === undefined ? 3 : o.priority;
        if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
          throw new ValidationError('priority must be an integer from 1 to 5');
        }
        let deadline = null;
        if (o.deadline !== undefined && o.deadline !== null) {
          if (typeof o.deadline !== 'string' || Number.isNaN(Date.parse(o.deadline))) {
            throw new ValidationError('deadline must be an ISO date or time');
          }
          deadline = o.deadline.trim();
        }
        return { request, criteria, priority, deadline, dependsOn: dependencyList(o.dependsOn), ...decomposition };
      },
      async execute(_ctx, { request, criteria, priority, deadline, dependsOn, ...decomposition }) {
        // The goal list prints an eight-character reference, so a dependency may be named the same
        // way `goal show` accepts it. Resolution happens before any event is written; an unknown or
        // ambiguous reference refuses the whole goal rather than inventing a link.
        const resolved = [];
        for (const ref of dependsOn) {
          try {
            resolved.push((await store.resolve(ref)).id);
          } catch {
            throw new ValidationError(`refused: unknown dependency goal ${singleLine(ref, 40)}`);
          }
        }
        if (new Set(resolved).size !== resolved.length) throw new ValidationError('refused: a dependency goal is named twice');
        const { goal } = await store.createGoal({ request, criteria, priority, deadline, dependsOn: resolved, ...decomposition });
        return {
          summary: `recorded goal ${shortId(goal.id)} with ${goal.criteria.length} success criterion(s)`,
          data: {
            goalId: goal.id,
            status: goal.status,
            criteria: goal.criteria.map((c) => ({ id: c.id, description: c.description, basis: c.basis, requirement: c.requirement })),
          },
          display: `${renderGoal(goal)}\nThis records the intention only. Nothing has run, and the goal grants no permission.`,
        };
      },
      async verify(_ctx, { request, criteria, ...decomposition }, result) {
        const goal = await store.get(result.data.goalId);
        if (!goal) return { ok: false, detail: 'the recorded goal cannot be read back' };
        if (goal.request !== request) return { ok: false, detail: 'stored request differs from the one recorded' };
        if (goal.origin !== 'user') return { ok: false, detail: 'stored goal origin is not the user' };
        if (goal.status !== GoalStatus.PROPOSED) return { ok: false, detail: `the new goal is ${goal.status}, not proposed` };
        if (goal.criteria.length !== criteria.length) return { ok: false, detail: 'stored criterion count differs from the request' };
        if (goal.criteria.some((c, i) => c.description !== criterionText(criteria[i]))) {
          return { ok: false, detail: 'stored criteria differ from the request' };
        }
        // Provenance is the point of the write: a criterion APEX inferred must not have come back
        // as a requirement, and one the user stated must not have come back as a suggestion.
        if (goal.criteria.some((c, i) => c.basis !== criterionBasis(criteria[i]) || c.requirement !== criterionRequirement(criteria[i]))) {
          return { ok: false, detail: 'stored criterion provenance differs from the request' };
        }
        const field = decompositionMismatch(goal, decomposition);
        if (field) return { ok: false, detail: `stored ${field} differ from the request` };
        return { ok: true, detail: `goal present as proposed with ${goal.criteria.length} criterion(s); nothing has run` };
      },
    },

    {
      name: 'goal.revise',
      description: 'Replace the success criteria of an open goal, optionally its request, priority, deadline, or any decomposition field. Evidence for the old criteria stops counting; the revision is recorded, never overwritten. A decomposition field that is not sent keeps its record. Write: user origin only.',
      inputHint: '{"target":"goal id","request":"optional revised request","criteria":["new success criteria"],"priority":"optional 1-5","deadline":"optional ISO date or null","prerequisites":[],"constraints":[],"resources":[],"timeConditions":[],"blockers":[],"unknowns":[],"reason":"why the goal changed"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'request', 'criteria', 'priority', 'deadline', 'reason', ...GOAL_ITEM_FIELDS]);
        const criteria = criterionList(o.criteria);
        const decomposition = decompositionOf(o);
        const reason = textField(o.reason, 'reason', MAX_GOAL_REASON_CHARS);
        const request = o.request === undefined ? undefined : textField(o.request, 'request', MAX_GOAL_REQUEST_CHARS);
        let priority;
        if (o.priority !== undefined) {
          if (!Number.isInteger(o.priority) || o.priority < 1 || o.priority > 5) {
            throw new ValidationError('priority must be an integer from 1 to 5');
          }
          priority = o.priority;
        }
        let deadline;
        if (o.deadline !== undefined) {
          if (o.deadline !== null && (typeof o.deadline !== 'string' || Number.isNaN(Date.parse(o.deadline)))) {
            throw new ValidationError('deadline must be an ISO date, a time, or null');
          }
          deadline = o.deadline === null ? null : o.deadline.trim();
        }
        return { target: recordRef(o.target, 'target'), request, criteria, priority, deadline, reason, ...decomposition };
      },
      async execute(_ctx, { target, request, criteria, priority, deadline, reason, ...decomposition }) {
        const before = await store.resolve(target);
        const { goal } = await store.revise(target, { request, criteria, priority, deadline, reason, ...decomposition });
        return {
          summary: `goal ${shortId(goal.id)} revised to revision ${goal.revision} with ${goal.criteria.length} criterion(s); previous evidence no longer counts`,
          data: {
            goalId: goal.id,
            previousRevision: before.revision ?? 1,
            revision: goal.revision,
            status: goal.status,
            criteria: goal.criteria.map((c) => ({ id: c.id, description: c.description, basis: c.basis, requirement: c.requirement, status: c.status })),
            reason,
          },
          display: [
            `Goal ${shortId(goal.id)} is now revision ${goal.revision} (was ${before.revision ?? 1}); its criteria were replaced.`,
            ...goal.criteria.map((c) => `  ${c.id} [${c.status}] ${c.description}`),
            ...GOAL_ITEM_FIELDS.filter((f) => decomposition[f] !== undefined).map((f) => `  ${f}: ${(goal[f] ?? []).length} recorded item(s)`),
            'Earlier criteria and evidence remain in the event log but no longer count toward completion.',
            'A plan approved against the previous goal revision must be revalidated before it can run.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { request, criteria, ...decomposition }, result) {
        const goal = await store.get(result.data.goalId);
        if (!goal) return { ok: false, detail: 'the revised goal cannot be read back' };
        if (goal.revision !== result.data.revision) return { ok: false, detail: 'the stored revision differs from the recorded one' };
        if (goal.criteria.length !== criteria.length) return { ok: false, detail: 'stored criterion count differs from the revision' };
        if (goal.criteria.some((c, i) => c.description !== criterionText(criteria[i]) || c.status !== 'pending')) {
          return { ok: false, detail: 'revised criteria are not present and pending' };
        }
        if (goal.criteria.some((c, i) => c.basis !== criterionBasis(criteria[i]) || c.requirement !== criterionRequirement(criteria[i]))) {
          return { ok: false, detail: 'stored criterion provenance differs from the revision' };
        }
        const field = decompositionMismatch(goal, decomposition);
        if (field) return { ok: false, detail: `stored ${field} differ from the revision` };
        if (request !== undefined && goal.request !== request) return { ok: false, detail: 'the stored request differs from the revision' };
        return { ok: true, detail: `revision ${goal.revision} confirmed; all criteria are pending and earlier evidence does not count` };
      },
    },

    {
      name: 'goal.confirm',
      description: 'Record the user\'s decision about one success criterion: required, suggested, or declined. This is the only path by which a criterion APEX inferred becomes a requirement, and the only path by which a criterion stops counting toward completion without revising the goal. A criterion the user stated cannot be declined. Write: user origin only.',
      inputHint: '{"target":"goal id","criterion":"c1","decision":"required|suggested|declined","reason":"why the decision was made","operationId":"optional audit record id"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'criterion', 'decision', 'reason', 'operationId']);
        if (typeof o.criterion !== 'string' || !CRITERION_ID_RE.test(o.criterion.trim())) {
          throw new ValidationError('criterion must be an id such as c1');
        }
        const decision = typeof o.decision === 'string' ? o.decision.trim() : '';
        if (!CRITERION_DECISIONS.includes(decision)) {
          throw new ValidationError(`decision must be one of: ${CRITERION_DECISIONS.join(', ')}`);
        }
        return {
          target: recordRef(o.target, 'target'),
          criterionId: o.criterion.trim(),
          decision,
          reason: textField(o.reason, 'reason', MAX_GOAL_REASON_CHARS),
          operationId: o.operationId === undefined || o.operationId === null ? null : recordRef(o.operationId, 'operationId'),
        };
      },
      async execute(_ctx, { target, criterionId, decision, reason, operationId }) {
        const before = await store.resolve(target);
        const prior = before.criteria.find((c) => c.id === criterionId)?.confirmation?.decision ?? null;
        const { goal } = await store.decideCriterion(target, { criterionId, decision, reason, operationId });
        const criterion = goal.criteria.find((c) => c.id === criterionId);
        const p = goalProgress(goal);
        return {
          summary: `recorded ${decision} for criterion ${criterionId} of goal ${shortId(goal.id)}; ${p.gatingSatisfied} of ${p.gating} required criterion(s) satisfied`,
          data: {
            goalId: goal.id,
            criterionId,
            decision,
            previousDecision: prior,
            requirement: criterion?.requirement ?? null,
            basis: criterion ? basisOf(criterion) : null,
            operationId,
            status: goal.status,
            progress: p,
          },
          display: [
            `Criterion ${criterionId} of goal ${shortId(goal.id)} is recorded as ${decision}.`,
            `  basis: ${criterion ? basisOf(criterion) : 'unknown'}; requirement: ${criterion?.requirement ?? 'unknown'}`,
            `  reason: ${reason}`,
            operationId ? `  decision operation: ${shortId(operationId)}` : null,
            prior ? `  it was ${prior} before; the earlier decision stays in the event log` : null,
            decision === Requirement.REQUIRED
              ? '  it now gates completion: it needs supporting evidence whose operation is still a verified success.'
              : null,
            decision === Requirement.DECLINED
              ? '  it no longer counts toward completion. The suggestion and this decision both stay in the log.'
              : null,
            decision === Requirement.SUGGESTED
              ? '  it stays a suggestion: it does not gate completion, and the goal can complete without it. Both the suggestion and this decision stay in the log.'
              : null,
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(_ctx, { criterionId, decision, reason, operationId }, result) {
        const goal = await store.get(result.data.goalId);
        if (!goal) return { ok: false, detail: 'the confirmed goal cannot be read back' };
        const criterion = goal.criteria.find((c) => c.id === criterionId);
        if (!criterion) return { ok: false, detail: `criterion ${criterionId} is no longer recorded` };
        if (criterion.requirement !== decision) return { ok: false, detail: `criterion is ${criterion.requirement}, not ${decision}` };
        if (criterion.confirmation?.decision !== decision) return { ok: false, detail: 'the criterion carries no confirmation record of this decision' };
        if (criterion.confirmation?.reason !== reason) return { ok: false, detail: 'the recorded decision reason differs from the request' };
        if ((criterion.confirmation?.operationId ?? null) !== operationId) {
          return { ok: false, detail: 'the recorded decision operation differs from the request' };
        }
        if (decision === Requirement.DECLINED && basisOf(criterion) === GoalBasis.USER_STATED) {
          return { ok: false, detail: 'a criterion the user stated was recorded as declined' };
        }
        return { ok: true, detail: `decision recorded for ${criterionId}; the criterion's evidence and every earlier decision are preserved` };
      },
    },

    {
      name: 'goal.update',
      description: 'Move a goal through its lifecycle: accepted, active, blocked, failed, cancelled, abandoned, superseded, or completed. Completion is refused while a criterion still needs your decision, and unless every required criterion has verified supporting evidence. Write: user origin only.',
      inputHint: '{"target":"goal id","status":"accepted|active|blocked|completed|failed|cancelled|abandoned|superseded","reason":"required for stopping states","by":"replacement goal id for superseded"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'status', 'reason', 'by']);
        return {
          target: recordRef(o.target, 'target'),
          status: statusValue(o.status),
          reason: optionalTextField(o.reason, 'reason', MAX_GOAL_REASON_CHARS),
          by: o.by === undefined || o.by === null ? null : recordRef(o.by, 'replacement goal'),
        };
      },
      async execute(_ctx, { target, status, reason, by }) {
        const before = await store.resolve(target);
        const { goal } = await store.transition(target, status, { reason, by });
        const changed = goal.statusHistory.at(-1);
        return {
          summary: `goal ${shortId(goal.id)}: ${before.status} -> ${goal.status}`,
          data: {
            goalId: goal.id,
            previousStatus: before.status,
            status: goal.status,
            reason: changed?.reason ?? null,
            supersededBy: goal.supersededBy ?? null,
          },
          display: [
            `Goal ${shortId(goal.id)} is now ${goal.status} (was ${before.status}).`,
            reason ? `  reason: ${reason}` : '  no reason was needed for this state',
            status === GoalStatus.COMPLETED
              ? '  completion rests on the recorded criterion evidence; no task result alone completed it.'
              : '  this changes the goal record only. It authorizes no action.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { status }, result) {
        const goal = await store.get(result.data.goalId);
        if (!goal) return { ok: false, detail: 'the updated goal cannot be read back' };
        if (goal.status !== status) return { ok: false, detail: `goal is ${goal.status}, not ${status}` };
        const last = goal.statusHistory.at(-1);
        if (!last || last.to !== status || last.from !== result.data.previousStatus) {
          return { ok: false, detail: 'the status history does not end with the recorded transition' };
        }
        if (status === GoalStatus.COMPLETED) {
          const p = goalProgress(goal);
          if (p.needsConfirmation > 0) return { ok: false, detail: 'the goal is marked completed while a criterion still needs your decision' };
          if (p.gating === 0) return { ok: false, detail: 'the goal is marked completed while no criterion is recorded as required' };
          if (p.gatingPending !== 0) return { ok: false, detail: 'the goal is marked completed but a required criterion is not satisfied' };
          if (!goal.completion) return { ok: false, detail: 'the goal is completed without a completion-evidence snapshot' };
          const snapshot = new Set((goal.completion.criteria ?? []).map((c) => c.criterionId));
          const gatingIds = new Set(goal.criteria.filter((c) => requirementOf(c) === Requirement.REQUIRED).map((c) => c.id));
          if (snapshot.size !== gatingIds.size || [...gatingIds].some((id) => !snapshot.has(id))) {
            return { ok: false, detail: 'the completion snapshot does not name every required criterion' };
          }
        }
        return { ok: true, detail: `goal state confirmed as ${status}; ${goal.statusHistory.length} status record(s) preserved` };
      },
    },

    {
      name: 'goal.evidence',
      description: 'Record evidence for one success criterion. Supporting evidence must name an operation that is a verified success in the audit log. Contradicting evidence on a completed goal reopens it only when reopen is stated. Write: user origin only.',
      inputHint: '{"target":"goal id","criterion":"c1","kind":"supports|contradicts","operationId":"audit record id (required for supports)","detail":"optional text","reopen":"true only to reopen a completed goal with contradicting evidence"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'criterion', 'kind', 'operationId', 'detail', 'reopen']);
        if (typeof o.criterion !== 'string' || !CRITERION_ID_RE.test(o.criterion.trim())) {
          throw new ValidationError('criterion must be an id such as c1');
        }
        if (typeof o.kind !== 'string' || !EVIDENCE_KINDS.includes(o.kind.trim())) {
          throw new ValidationError(`kind must be one of: ${EVIDENCE_KINDS.join(', ')}`);
        }
        if (o.reopen !== undefined && typeof o.reopen !== 'boolean') throw new ValidationError('reopen must be true or false');
        return {
          target: recordRef(o.target, 'target'),
          criterionId: o.criterion.trim(),
          kind: o.kind.trim(),
          operationId: o.operationId === undefined || o.operationId === null ? null : recordRef(o.operationId, 'operationId'),
          detail: optionalTextField(o.detail, 'detail', MAX_GOAL_DETAIL_CHARS),
          reopen: o.reopen === true,
        };
      },
      async execute(_ctx, { target, criterionId, kind, operationId, detail, reopen }) {
        const { goal } = await store.addEvidence(target, { criterionId, kind, operationId, detail, reopen });
        const criterion = goal.criteria.find((c) => c.id === criterionId);
        return {
          summary: `recorded ${kind} evidence for criterion ${criterionId} of goal ${shortId(goal.id)}; criterion is ${criterion?.status}`,
          data: {
            goalId: goal.id,
            criterionId,
            kind,
            operationId,
            criterionStatus: criterion?.status ?? null,
            goalStatus: goal.status,
          },
          display: [
            `Recorded ${kind} evidence for criterion ${criterionId} of goal ${shortId(goal.id)}.`,
            `  criterion: ${criterion?.status ?? 'unknown'}`,
            `  goal: ${goal.status}`,
            reopen ? '  the completed goal was reopened; its earlier completion record is preserved in the status history' : null,
            criterion && needsUserDecision(criterion)
              ? `  ${criterionId} is still a suggestion APEX put forward: your decision is what makes it count or takes it out - goal confirm ${shortId(goal.id)} ${criterionId} required|suggested|declined --reason <text>`
              : null,
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(_ctx, { criterionId, kind, operationId }, result) {
        const goal = await store.get(result.data.goalId);
        if (!goal) return { ok: false, detail: 'the goal cannot be read back' };
        const criterion = goal.criteria.find((c) => c.id === criterionId);
        if (!criterion) return { ok: false, detail: `criterion ${criterionId} is no longer recorded` };
        const expected = kind === 'supports' ? 'satisfied' : 'contradicted';
        if (criterion.status !== expected) return { ok: false, detail: `criterion is ${criterion.status}, not ${expected}` };
        if (!criterion.evidence.some((e) => e.kind === kind && e.operationId === operationId)) {
          return { ok: false, detail: 'the recorded evidence is not present on the criterion' };
        }
        return { ok: true, detail: `evidence present; criterion ${criterionId} is ${criterion.status}; all earlier evidence preserved` };
      },
    },

    {
      name: 'goal.complete',
      description: 'Record a goal as completed. Refused while an inferred criterion still needs your decision, refused unless every required criterion is satisfied by an audit operation that is still a verified success, and refused when the proof a satisfied criterion cites has since been retracted or superseded. No task result completes a goal by itself. Write: user origin only.',
      inputHint: '{"target":"goal id","reason":"optional text"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'reason']);
        return {
          target: recordRef(o.target, 'target'),
          reason: optionalTextField(o.reason, 'reason', MAX_GOAL_REASON_CHARS),
        };
      },
      async execute(ctx, { target, reason }) {
        const before = await store.resolve(target);
        // Completion is reachable only from active or blocked. Saying which step is missing is
        // more useful than "illegal transition"; advancing the lifecycle for the user would
        // record a status change nobody made.
        if (before.status === GoalStatus.PROPOSED || before.status === GoalStatus.ACCEPTED) {
          throw new ValidationError(`goal ${shortId(before.id)} is ${before.status}; ${before.status === GoalStatus.PROPOSED ? 'accept it, then move it to active' : 'move it to active'} before completing it: goal update ${shortId(before.id)} ${before.status === GoalStatus.PROPOSED ? 'accepted' : 'active'}`);
        }
        // The criterion statuses in the goal log say what was recorded then. Completion is checked
        // against what the recorded proof still is: a supporting claim that has since been retracted
        // or superseded no longer backs the criterion, and completing over it would record a decision
        // the evidence does not support. `goalProgress` cannot see this, because it reads the goal log
        // alone; the re-read here opens the knowledge store and the audit log the evidence cites.
        const assessment = await assessGoal(before, {
          knowledge: ctx?.knowledge ?? null,
          operations: ctx?.operations ?? null,
          plans: ctx?.plans ?? null,
        });
        const withdrawn = assessment.criteria.filter((c) => c.requirement === Requirement.REQUIRED
          && c.status === 'satisfied'
          && [EvidenceVerdict.STALE, EvidenceVerdict.INVALID, EvidenceVerdict.CONTRADICTED].includes(c.verdict));
        if (withdrawn.length > 0) {
          const how = withdrawn.map((c) => `goal evidence ${shortId(before.id)} ${c.id} --operation <id>`).join(' or ');
          throw new ValidationError(
            `goal cannot be completed: ${withdrawn.map((c) => `${c.id} cites proof that is ${c.verdict} (${singleLine(c.reason, 160)})`).join('; ')}. Record current evidence for it (${how}) before completing the goal`,
            'GOAL_EVIDENCE_WITHDRAWN',
          );
        }
        const { goal } = await store.transition(target, GoalStatus.COMPLETED, { reason });
        return {
          summary: `goal ${shortId(goal.id)} completed against ${goal.completion?.criteria.length ?? 0} verified criterion(s)`,
          data: {
            goalId: goal.id,
            previousStatus: before.status,
            status: goal.status,
            completion: goal.completion,
          },
          display: [
            `Goal ${shortId(goal.id)} is completed.`,
            ...(goal.completion?.criteria ?? []).map((c) => `  ${c.criterionId}: operation ${shortId(c.operationId)}`),
            (goal.completion?.declined ?? []).length > 0
              ? `  not counted because you declined them: ${goal.completion.declined.join(', ')}`
              : null,
            reason ? `  reason: ${reason}` : null,
            'Completion was checked against the audit log, not asserted.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(ctx, _input, result) {
        const goal = await store.get(result.data.goalId);
        if (!goal) return { ok: false, detail: 'the completed goal cannot be read back' };
        if (goal.status !== GoalStatus.COMPLETED) return { ok: false, detail: `goal is ${goal.status}, not completed` };
        if (!goal.completion) return { ok: false, detail: 'no completion-evidence snapshot is recorded' };
        const p = goalProgress(goal);
        if (p.needsConfirmation > 0) return { ok: false, detail: 'the goal is completed while a criterion still needs your decision' };
        if (p.gating === 0) return { ok: false, detail: 'the goal is completed while no criterion is recorded as required' };
        if (p.gatingPending !== 0) return { ok: false, detail: 'the goal is completed but a required criterion is not satisfied' };
        if (!ctx.operations) return { ok: false, detail: 'the audit log is unavailable, so completion evidence cannot be re-checked' };
        for (const entry of goal.completion.criteria) {
          if (!entry.operationId) return { ok: false, detail: `criterion ${entry.criterionId} has no supporting operation` };
          const found = await ctx.operations.findById(entry.operationId);
          if (!found.found) return { ok: false, detail: `operation ${shortId(entry.operationId)} is not in the audit log` };
          if (found.record.status !== 'success_verified') {
            return { ok: false, detail: `operation ${shortId(entry.operationId)} is ${found.record.status}, not a verified success` };
          }
          if (Array.isArray(found.record.errors) && found.record.errors.length > 0) {
            return { ok: false, detail: `operation ${shortId(entry.operationId)} carries errors, so its evidence is incomplete` };
          }
        }
        return { ok: true, detail: `completion confirmed against ${goal.completion.criteria.length} audit record(s); the history is preserved` };
      },
    },

    {
      name: 'goal.link',
      description: 'Link a plan, a task, a world entity, or a world event to a goal. The link is a reference only: it grants no authority and changes no completion rule. Write: user origin only.',
      inputHint: '{"target":"goal id","planId":"optional plan id","taskId":"optional task id","entityId":"optional world entity id","worldEventId":"optional world event id"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'planId', 'taskId', 'entityId', 'worldEventId']);
        const planId = o.planId === undefined || o.planId === null ? null : recordRef(o.planId, 'planId');
        const taskId = o.taskId === undefined || o.taskId === null ? null : recordRef(o.taskId, 'taskId');
        const entityId = o.entityId === undefined || o.entityId === null ? null : recordRef(o.entityId, 'entityId');
        const worldEventId = o.worldEventId === undefined || o.worldEventId === null ? null : recordRef(o.worldEventId, 'worldEventId');
        if (planId === null && taskId === null && entityId === null && worldEventId === null) {
          throw new ValidationError('a link must name a plan, a task, a world entity, or a world event');
        }
        return { target: recordRef(o.target, 'target'), planId, taskId, entityId, worldEventId };
      },
      async execute(ctx, { target, planId, taskId, entityId, worldEventId }) {
        // A world reference is recorded as the stable record id, so a short or merged reference
        // still names the same entity after an identity merge. The reference grants no authority.
        let linkedEntityId = entityId;
        if (entityId !== null) {
          if (!ctx.worldModel || typeof ctx.worldModel.showEntity !== 'function') {
            throw new ValidationError('the world model is unavailable, so a world entity reference cannot be checked');
          }
          const view = await ctx.worldModel.showEntity(entityId);
          if (!view.entity) throw new ValidationError(`world entity "${singleLine(entityId, 64)}" cannot be linked: ${singleLine(view.problem ?? 'not found', 120)}`);
          if (view.entity.status !== 'active') {
            throw new ValidationError(`world entity ${shortId(view.entity.id)} is ${view.entity.status}; a retired entity cannot receive a new link`);
          }
          linkedEntityId = view.entity.id;
        }
        let linkedEventId = worldEventId;
        if (worldEventId !== null) {
          if (!ctx.worldModel || typeof ctx.worldModel.state !== 'function') {
            throw new ValidationError('the world model is unavailable, so a world event reference cannot be checked');
          }
          const state = await ctx.worldModel.state();
          if (!state.events.has(worldEventId)) {
            throw new ValidationError(`world event "${singleLine(worldEventId, 64)}" does not exist`);
          }
        }
        const { goal } = await store.link(target, { planId, taskId, entityId: linkedEntityId, worldEventId: linkedEventId });
        const label = linkTargetLabel({ planId, taskId, entityId: linkedEntityId, worldEventId: linkedEventId });
        return {
          summary: `linked ${label} to goal ${shortId(goal.id)}`,
          data: {
            goalId: goal.id,
            planId,
            taskId,
            entityId: linkedEntityId,
            worldEventId: linkedEventId,
            planIds: [...goal.planIds],
            taskIds: [...goal.taskIds],
            entityIds: [...goal.entityIds],
            worldEventIds: [...goal.worldEventIds],
          },
          display: [
            `Linked ${label} to goal ${shortId(goal.id)}.`,
            'A link records a reference; it does not authorize execution or prove a fact.',
          ].join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const { planId, taskId, entityId, worldEventId } = result.data;
        const goal = await store.get(result.data.goalId);
        if (!goal) return { ok: false, detail: 'the linked goal cannot be read back' };
        if (planId !== null && !goal.planIds.includes(planId)) return { ok: false, detail: 'the plan link is not recorded on the goal' };
        if (taskId !== null && !goal.taskIds.includes(taskId)) return { ok: false, detail: 'the task link is not recorded on the goal' };
        if (entityId !== null && !goal.entityIds.includes(entityId)) return { ok: false, detail: 'the world entity link is not recorded on the goal' };
        if (worldEventId !== null && !goal.worldEventIds.includes(worldEventId)) return { ok: false, detail: 'the world event link is not recorded on the goal' };
        return {
          ok: true,
          detail: `link confirmed on the goal; ${goal.planIds.length} plan(s), ${goal.taskIds.length} task(s), ${goal.entityIds.length} world entit(ies), and ${goal.worldEventIds.length} world event(s) referenced`,
        };
      },
    },
  ];
}
