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
  CRITERION_ID_RE,
  EVIDENCE_KINDS,
  GoalStatus,
  MAX_CRITERIA,
  MAX_CRITERION_CHARS,
  MAX_GOAL_DEPENDENCIES,
  MAX_GOAL_DETAIL_CHARS,
  MAX_GOAL_REASON_CHARS,
  MAX_GOAL_REQUEST_CHARS,
  goalProgress,
} from '../goals/model.js';
import { renderGoal } from '../goals/format.js';

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

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

function criterionList(value) {
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError('at least one success criterion is required');
  if (value.length > MAX_CRITERIA) throw new ValidationError(`at most ${MAX_CRITERIA} success criteria are allowed`);
  return value.map((entry, i) => textField(entry, `criterion ${i + 1}`, MAX_CRITERION_CHARS));
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
      description: 'Record a goal: the user\'s request, its success criteria, priority, optional deadline, and dependencies. A goal is a record of intent, not permission to act. Write: user origin only.',
      inputHint: '{"request":"what the user wants","criteria":["at least one success criterion"],"priority":"optional 1-5","deadline":"optional ISO date","dependsOn":["optional goal ids"]}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['request', 'criteria', 'priority', 'deadline', 'dependsOn']);
        const request = textField(o.request, 'request', MAX_GOAL_REQUEST_CHARS);
        const criteria = criterionList(o.criteria);
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
        return { request, criteria, priority, deadline, dependsOn: dependencyList(o.dependsOn) };
      },
      async execute(_ctx, { request, criteria, priority, deadline, dependsOn }) {
        const { goal } = await store.createGoal({ request, criteria, priority, deadline, dependsOn });
        return {
          summary: `recorded goal ${shortId(goal.id)} with ${goal.criteria.length} success criterion(s)`,
          data: { goalId: goal.id, status: goal.status, criteria: goal.criteria.map((c) => ({ id: c.id, description: c.description })) },
          display: `${renderGoal(goal)}\nThis records the intention only. Nothing has run, and the goal grants no permission.`,
        };
      },
      async verify(_ctx, { request, criteria }, result) {
        const goal = await store.get(result.data.goalId);
        if (!goal) return { ok: false, detail: 'the recorded goal cannot be read back' };
        if (goal.request !== request) return { ok: false, detail: 'stored request differs from the one recorded' };
        if (goal.origin !== 'user') return { ok: false, detail: 'stored goal origin is not the user' };
        if (goal.status !== GoalStatus.PROPOSED) return { ok: false, detail: `the new goal is ${goal.status}, not proposed` };
        if (goal.criteria.length !== criteria.length) return { ok: false, detail: 'stored criterion count differs from the request' };
        if (goal.criteria.some((c, i) => c.description !== criteria[i])) {
          return { ok: false, detail: 'stored criteria differ from the request' };
        }
        return { ok: true, detail: `goal present as proposed with ${goal.criteria.length} criterion(s); nothing has run` };
      },
    },

    {
      name: 'goal.update',
      description: 'Move a goal through its lifecycle: accepted, active, blocked, failed, cancelled, abandoned, superseded, or completed. Completion is refused unless every criterion has verified supporting evidence. Write: user origin only.',
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
          if (p.satisfied !== p.total) return { ok: false, detail: 'the goal is marked completed but a criterion is not satisfied' };
          if (!goal.completion) return { ok: false, detail: 'the goal is completed without a completion-evidence snapshot' };
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
      description: 'Record a goal as completed. Refused unless every criterion is satisfied by an audit operation that is still a verified success. No task result completes a goal by itself. Write: user origin only.',
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
      async execute(_ctx, { target, reason }) {
        const before = await store.resolve(target);
        // Completion is reachable only from active or blocked. Saying which step is missing is
        // more useful than "illegal transition"; advancing the lifecycle for the user would
        // record a status change nobody made.
        if (before.status === GoalStatus.PROPOSED || before.status === GoalStatus.ACCEPTED) {
          throw new ValidationError(`goal ${shortId(before.id)} is ${before.status}; ${before.status === GoalStatus.PROPOSED ? 'accept it, then move it to active' : 'move it to active'} before completing it: goal update ${shortId(before.id)} ${before.status === GoalStatus.PROPOSED ? 'accepted' : 'active'}`);
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
      description: 'Link a plan or a task to a goal. The link is a reference only: it grants neither the plan nor the task any authority. Write: user origin only.',
      inputHint: '{"target":"goal id","planId":"optional plan id","taskId":"optional task id"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'planId', 'taskId']);
        const planId = o.planId === undefined || o.planId === null ? null : recordRef(o.planId, 'planId');
        const taskId = o.taskId === undefined || o.taskId === null ? null : recordRef(o.taskId, 'taskId');
        if (planId === null && taskId === null) throw new ValidationError('a link must name a plan or a task');
        return { target: recordRef(o.target, 'target'), planId, taskId };
      },
      async execute(_ctx, { target, planId, taskId }) {
        const { goal } = await store.link(target, { planId, taskId });
        return {
          summary: `linked ${planId ? `plan ${shortId(planId)}` : `task ${shortId(taskId)}`} to goal ${shortId(goal.id)}`,
          data: { goalId: goal.id, planId, taskId, planIds: [...goal.planIds], taskIds: [...goal.taskIds] },
          display: [
            `Linked ${planId ? `plan ${shortId(planId)}` : `task ${shortId(taskId)}`} to goal ${shortId(goal.id)}.`,
            'A link records a reference; it does not authorize execution.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { planId, taskId }, result) {
        const goal = await store.get(result.data.goalId);
        if (!goal) return { ok: false, detail: 'the linked goal cannot be read back' };
        if (planId !== null && !goal.planIds.includes(planId)) return { ok: false, detail: 'the plan link is not recorded on the goal' };
        if (taskId !== null && !goal.taskIds.includes(taskId)) return { ok: false, detail: 'the task link is not recorded on the goal' };
        return { ok: true, detail: `link confirmed on the goal; ${goal.planIds.length} plan(s) and ${goal.taskIds.length} task(s) referenced` };
      },
    },
  ];
}
