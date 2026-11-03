// Plan actions: the user-facing surface of the plan store.
//
// A plan records intent, steps, assumptions, and risk. It is not permission: approval validates
// the plan against the live registry, and every step is authorized again when a task runs it.
// Every write here is user-origin only and unplannable, so a model cannot author, revise, or
// approve a plan.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, shortId, singleLine } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { STEP_ID_RE } from '../tasks/model.js';
import { ORIGIN_USER } from './origins.js';
import {
  ASSERTION_KINDS,
  MAX_ESTIMATE_SECONDS,
  MAX_PLAN_OUTCOME_CHARS,
  MAX_PRECONDITIONS,
  MAX_PRECONDITION_CHARS,
  MAX_ASSERTION_CHARS,
  MAX_ASSERTIONS,
  MAX_EXPECTED_CHARS,
  MAX_VERIFICATION_CHARS,
  RISK_LEVELS,
  PlanStatus,
  planContentHash,
  validatePlanContent,
} from '../plans/model.js';
import { renderPlan } from '../plans/format.js';

function assertNoSecret(value, name) {
  if (containsSecret(String(value ?? ''))) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  }
}

function textField(value, name, max) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const t = value.trim();
  if (t.length === 0) throw new ValidationError(`${name} is empty`);
  if (t.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if (CONTROL_CHARS.test(t)) throw new ValidationError(`${name} contains control characters`);
  assertNoSecret(t, name);
  return t;
}

function optionalTextField(value, name, max) {
  if (value === undefined || value === null) return null;
  return textField(value, name, max);
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

function parseStep(raw, i) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError(`step ${i + 1} is not an object`);
  const allowed = ['id', 'description', 'action', 'input', 'dependsOn', 'expectedResult', 'verification', 'criterion', 'criterionId', 'risk', 'estimate', 'estimateSeconds'];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new ValidationError(`step ${i + 1}: unexpected field "${singleLine(key, 40)}"`);
  }
  const id = raw.id === undefined ? `s${i + 1}` : String(raw.id).trim();
  if (!STEP_ID_RE.test(id)) throw new ValidationError(`step ${i + 1}: id must be lowercase letters, digits, or underscores`);
  if (typeof raw.action !== 'string' || raw.action.trim().length === 0) throw new ValidationError(`step ${i + 1}: action is required`);
  const input = raw.input ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError(`step ${i + 1}: input must be an object`);
  if (!Array.isArray(raw.dependsOn ?? [])) throw new ValidationError(`step ${i + 1}: dependsOn must be a list`);
  const risk = raw.risk ?? 'medium';
  if (!RISK_LEVELS.includes(risk)) throw new ValidationError(`step ${i + 1}: risk must be low, medium, or high`);
  let seconds = null;
  if (raw.estimateSeconds !== undefined && raw.estimateSeconds !== null) {
    if (!Number.isInteger(raw.estimateSeconds) || raw.estimateSeconds < 0 || raw.estimateSeconds > MAX_ESTIMATE_SECONDS) {
      throw new ValidationError(`step ${i + 1}: estimateSeconds must be an integer from 0 to ${MAX_ESTIMATE_SECONDS}`);
    }
    seconds = raw.estimateSeconds;
  } else if (raw.estimate && Number.isInteger(raw.estimate.seconds)) {
    seconds = raw.estimate.seconds;
  }
  return {
    id,
    description: textField(raw.description, `step ${i + 1} description`, MAX_EXPECTED_CHARS),
    action: raw.action.trim(),
    input,
    dependsOn: (raw.dependsOn ?? []).map((d) => String(d).trim()),
    expectedResult: textField(raw.expectedResult, `step ${i + 1} expected result`, MAX_EXPECTED_CHARS),
    verification: textField(raw.verification, `step ${i + 1} verification`, MAX_VERIFICATION_CHARS),
    criterionId: raw.criterionId ?? raw.criterion ?? null,
    risk,
    estimate: { seconds },
  };
}

function parseContent(input) {
  const outcome = textField(input.outcome, 'intended outcome', MAX_PLAN_OUTCOME_CHARS);
  if (!Array.isArray(input.steps) || input.steps.length === 0) throw new ValidationError('at least one step is required');
  const steps = input.steps.map(parseStep);
  const preconditions = input.preconditions ?? [];
  if (!Array.isArray(preconditions)) throw new ValidationError('preconditions must be a list');
  if (preconditions.length > MAX_PRECONDITIONS) throw new ValidationError(`at most ${MAX_PRECONDITIONS} preconditions are allowed`);
  const cleanPreconditions = preconditions.map((p, i) => textField(p, `precondition ${i + 1}`, MAX_PRECONDITION_CHARS));
  const assertions = input.assertions ?? [];
  if (!Array.isArray(assertions)) throw new ValidationError('assertions must be a list');
  if (assertions.length > MAX_ASSERTIONS) throw new ValidationError(`at most ${MAX_ASSERTIONS} assertions are allowed`);
  const cleanAssertions = assertions.map((a, i) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new ValidationError(`assertion ${i + 1} is not an object`);
    for (const key of Object.keys(a)) {
      if (!['kind', 'text', 'ref'].includes(key)) throw new ValidationError(`assertion ${i + 1}: unexpected field "${singleLine(key, 40)}"`);
    }
    if (!ASSERTION_KINDS.includes(a.kind)) throw new ValidationError(`assertion ${i + 1}: kind must be one of: ${ASSERTION_KINDS.join(', ')}`);
    return {
      kind: a.kind,
      text: textField(a.text, `assertion ${i + 1}`, MAX_ASSERTION_CHARS),
      ref: a.ref === undefined || a.ref === null ? null : textField(a.ref, `assertion ${i + 1} reference`, 64),
    };
  });
  let resources = { estimatedSeconds: null };
  if (input.estimatedSeconds !== undefined && input.estimatedSeconds !== null) {
    if (!Number.isInteger(input.estimatedSeconds) || input.estimatedSeconds < 0 || input.estimatedSeconds > MAX_ESTIMATE_SECONDS) {
      throw new ValidationError(`estimatedSeconds must be an integer from 0 to ${MAX_ESTIMATE_SECONDS}`);
    }
    resources = { estimatedSeconds: input.estimatedSeconds };
  }
  const content = { outcome, steps, preconditions: cleanPreconditions, assertions: cleanAssertions, resources };
  const problems = validatePlanContent(content);
  if (problems.length > 0) throw new ValidationError(`the plan is not valid: ${problems.join('; ')}`);
  return content;
}

function validationNote(validation) {
  if (!validation) return null;
  if (validation.ok) {
    return `Validation: passed. ${validation.steps} step(s): ${validation.reads} read, ${validation.writes} write; risk ${validation.risk}.`;
  }
  return [
    'Validation: NOT passed. The plan is stored as a draft, but it cannot be approved or run until these are resolved:',
    ...validation.problems.map((p) => `  - ${p}`),
  ].join('\n');
}

export function planActions(store) {
  if (!store || typeof store.createPlan !== 'function') {
    throw new TypeError('planActions requires a plan store');
  }
  return [
    {
      name: 'plan.add',
      description: 'Record an executive plan for a goal: ordered steps with dependencies, expected results, verification requirements, risk, preconditions, and classified assumptions. A plan is a proposal, not permission. Write: user origin only.',
      inputHint: '{"goal":"optional goal id","outcome":"intended outcome","steps":[{"id":"s1","description":"...","action":"memory.add","input":{},"dependsOn":[],"expectedResult":"...","verification":"...","criterion":"optional c1","risk":"low|medium|high","estimateSeconds":10}],"preconditions":[],"assertions":[{"kind":"user_fact|stored_knowledge|retrieved_evidence|inference|unknown","text":"...","ref":"optional record id"}],"estimatedSeconds":30,"reason":"optional"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['goal', 'goalId', 'outcome', 'steps', 'preconditions', 'assertions', 'estimatedSeconds', 'reason']);
        return {
          goalId: o.goalId ?? o.goal ?? null,
          ...parseContent(o),
          reason: optionalTextField(o.reason, 'reason', 500),
        };
      },
      async execute(_ctx, { goalId, outcome, steps, preconditions, assertions, resources, reason }) {
        const { plan, linkError } = await store.createPlan({ goalId, outcome, steps, preconditions, assertions, resources, reason });
        const validation = store.validatePlan(plan);
        return {
          summary: `recorded plan ${shortId(plan.id)} v${plan.version} for ${goalId ? `goal ${shortId(goalId)}` : 'no goal'}; ${plan.steps.length} step(s)`,
          data: { planId: plan.id, version: plan.version, status: plan.status, goalId: plan.goalId, validation, linkError },
          display: [
            renderPlan(plan),
            validationNote(validation),
            linkError ? `Note: the plan is stored, but the goal's plan index could not be updated (${linkError}).` : null,
            'Nothing has run. Approval is separate, and approval still authorizes nothing by itself.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(ctx, { goalId, outcome, steps }, result) {
        const plan = await store.get(result.data.planId);
        if (!plan) return { ok: false, detail: 'the recorded plan cannot be read back' };
        if (plan.outcome !== outcome) return { ok: false, detail: 'stored outcome differs from the request' };
        // The store stores the full id it resolved a short reference to, so the comparison
        // resolves the same reference rather than demanding the text be identical.
        let requestedGoalId = goalId ?? null;
        if (requestedGoalId && ctx.goals?.resolve) {
          try {
            requestedGoalId = (await ctx.goals.resolve(requestedGoalId)).id;
          } catch {
            return { ok: false, detail: 'the requested goal cannot be resolved to a recorded goal' };
          }
        }
        if ((plan.goalId ?? null) !== requestedGoalId) return { ok: false, detail: 'stored goal reference differs from the request' };
        if (plan.status !== PlanStatus.DRAFT) return { ok: false, detail: `the new plan is ${plan.status}, not draft` };
        if (plan.version !== 1) return { ok: false, detail: 'the new plan does not start at version 1' };
        if (plan.steps.length !== steps.length) return { ok: false, detail: 'stored step count differs from the request' };
        if (plan.steps.some((s, i) => s.id !== steps[i].id || s.action !== steps[i].action)) {
          return { ok: false, detail: 'stored steps differ from the request' };
        }
        if (plan.activation) return { ok: false, detail: 'a newly recorded plan already records an activation' };
        if (result.data.linkError === null && requestedGoalId && ctx.goals) {
          const goal = await ctx.goals.get(requestedGoalId);
          if (!goal || !goal.planIds.includes(plan.id)) return { ok: false, detail: 'the plan is not recorded on its goal' };
        }
        return { ok: true, detail: `plan present as a draft at v1; ${plan.steps.length} step(s); nothing has run` };
      },
    },

    {
      name: 'plan.revise',
      description: 'Replace a draft or blocked plan with a new version. The revision needs a reason, clears any approval, and must be approved again before it can be activated. Write: user origin only.',
      inputHint: '{"target":"plan id","outcome":"...","steps":[...],"preconditions":[],"assertions":[],"estimatedSeconds":30,"reason":"why the plan changed"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'outcome', 'steps', 'preconditions', 'assertions', 'estimatedSeconds', 'reason']);
        if (typeof o.target !== 'string') throw new ValidationError('target must be a plan id');
        return { target: o.target.trim(), ...parseContent(o), reason: textField(o.reason, 'reason', 500) };
      },
      async execute(_ctx, { target, outcome, steps, preconditions, assertions, resources, reason }) {
        const { plan } = await store.revise(target, { outcome, steps, preconditions, assertions, resources, reason });
        const validation = store.validatePlan(plan);
        return {
          summary: `revised plan ${shortId(plan.id)} to v${plan.version}`,
          data: { planId: plan.id, version: plan.version, status: plan.status, validation },
          display: [
            renderPlan(plan),
            validationNote(validation),
            'Previous versions and their approvals remain in the log. This revision has no approval.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(_ctx, { outcome, version: _ignored, steps }, result) {
        const plan = await store.get(result.data.planId);
        if (!plan) return { ok: false, detail: 'the revised plan cannot be read back' };
        if (plan.version !== result.data.version) return { ok: false, detail: 'stored version differs from the revision result' };
        if (plan.outcome !== outcome) return { ok: false, detail: 'stored outcome differs from the revision' };
        if (plan.status !== PlanStatus.DRAFT) return { ok: false, detail: `the revision is ${plan.status}, not draft` };
        if (plan.approval) return { ok: false, detail: 'the revision inherited an approval' };
        if (plan.steps.length !== steps.length || plan.steps.some((s, i) => s.id !== steps[i].id)) {
          return { ok: false, detail: 'stored steps differ from the revision' };
        }
        return { ok: true, detail: `revision v${plan.version} present with all earlier versions preserved; no approval inherited` };
      },
    },

    {
      name: 'plan.approve',
      description: 'Approve a draft plan after validating it against the live action registry. Approval is bound to the plan content and authorizes no action by itself. Write: user origin only.',
      inputHint: '{"target":"plan id"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target']);
        if (typeof o.target !== 'string' || o.target.trim().length === 0) throw new ValidationError('target must be a plan id');
        return { target: o.target.trim() };
      },
      async execute(_ctx, { target }) {
        const { plan } = await store.approve(target);
        return {
          summary: `approved plan ${shortId(plan.id)} v${plan.version}`,
          data: { planId: plan.id, version: plan.version, status: plan.status, contentHash: plan.approval?.contentHash ?? null, validation: plan.validation },
          display: [
            `Approved plan ${shortId(plan.id)} v${plan.version}.`,
            `  content: ${String(plan.approval?.contentHash).slice(0, 16)} (approval is bound to these exact steps)`,
            validationNote(plan.validation),
            'Approval permits starting this plan. Every step is still authorized separately when it runs.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const plan = await store.get(result.data.planId);
        if (!plan) return { ok: false, detail: 'the approved plan cannot be read back' };
        if (plan.status !== PlanStatus.APPROVED) return { ok: false, detail: `plan is ${plan.status}, not approved` };
        if (!plan.approval) return { ok: false, detail: 'no approval record is present' };
        if (plan.approval.version !== plan.version) return { ok: false, detail: 'the approval names a different version' };
        if (plan.approval.contentHash !== planContentHash(plan)) return { ok: false, detail: 'the approval does not match the current plan content' };
        if (!plan.validation?.ok) return { ok: false, detail: 'the approved plan does not carry a passing validation record' };
        return { ok: true, detail: `approval confirmed for v${plan.version}; content hash matches; validation passed` };
      },
    },

    {
      name: 'plan.cancel',
      description: 'Cancel a draft, approved, active, blocked, or failed plan. This changes the plan record only; a task already created from it is not cancelled by this action. Write: user origin only.',
      inputHint: '{"target":"plan id","reason":"why it is cancelled"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'reason']);
        if (typeof o.target !== 'string' || o.target.trim().length === 0) throw new ValidationError('target must be a plan id');
        return { target: o.target.trim(), reason: textField(o.reason, 'reason', 500) };
      },
      async execute(_ctx, { target, reason }) {
        const before = await store.resolve(target);
        const { plan } = await store.setStatus(target, PlanStatus.CANCELLED, { reason });
        return {
          summary: `cancelled plan ${shortId(plan.id)} (was ${before.status})`,
          data: { planId: plan.id, previousStatus: before.status, status: plan.status, taskId: plan.activation?.taskId ?? null },
          display: [
            `Plan ${shortId(plan.id)} is cancelled (was ${before.status}).`,
            plan.activation ? `  task ${shortId(plan.activation.taskId)} was created from this plan and is not cancelled by this action; cancel it separately if it should stop.` : '  no task was created from this plan.',
            'The plan history and any recorded outcomes remain readable.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { reason }, result) {
        const plan = await store.get(result.data.planId);
        if (!plan) return { ok: false, detail: 'the cancelled plan cannot be read back' };
        if (plan.status !== PlanStatus.CANCELLED) return { ok: false, detail: `plan is ${plan.status}, not cancelled` };
        if (plan.cancelledReason !== reason) return { ok: false, detail: 'stored cancellation reason differs from the request' };
        return { ok: true, detail: 'cancellation confirmed; history and outcomes preserved' };
      },
    },

    {
      name: 'plan.supersede',
      description: 'Record that one plan is replaced by another. The replacement must be a recorded plan. Nothing is executed. Write: user origin only.',
      inputHint: '{"target":"plan id being replaced","by":"replacement plan id","reason":"why"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'by', 'reason']);
        if (typeof o.target !== 'string' || o.target.trim().length === 0) throw new ValidationError('target must be a plan id');
        if (typeof o.by !== 'string' || o.by.trim().length === 0) throw new ValidationError('by must be a plan id');
        return { target: o.target.trim(), by: o.by.trim(), reason: textField(o.reason, 'reason', 500) };
      },
      async execute(_ctx, { target, by, reason }) {
        const { plan } = await store.setStatus(target, PlanStatus.SUPERSEDED, { reason, by });
        return {
          summary: `plan ${shortId(plan.id)} superseded by ${shortId(by)}`,
          data: { planId: plan.id, status: plan.status, supersededBy: plan.supersededBy },
          display: [
            `Plan ${shortId(plan.id)} is superseded by ${shortId(by)}.`,
            'The earlier plan and its history remain readable. Superseding does not execute or cancel anything.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { by }, result) {
        const plan = await store.get(result.data.planId);
        if (!plan) return { ok: false, detail: 'the superseded plan cannot be read back' };
        if (plan.status !== PlanStatus.SUPERSEDED) return { ok: false, detail: `plan is ${plan.status}, not superseded` };
        if (plan.supersededBy !== by) return { ok: false, detail: 'the recorded replacement differs from the request' };
        return { ok: true, detail: 'supersession confirmed; both plans remain readable' };
      },
    },
  ];
}
