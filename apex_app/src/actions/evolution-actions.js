// Evolution Lab actions (T-31 Step 2). Four capabilities, all user-origin writes: propose,
// record a sandbox verification that actually ran, request promotion, and decide a promotion.
//
// They are registered like every other capability, so the ECP authorizes each one and the audit log
// records each one. A proposal is never a permission, and promotion is a recorded decision that the
// lab itself cannot make: the lab only appends what the owner and the sandbox run reported.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, singleLine } from '../util.js';
import { ORIGIN_USER } from './origins.js';

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

function textField(value, name, max) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const t = value.trim();
  if (t.length === 0) throw new ValidationError(`${name} is empty`);
  if (t.length > max) throw new ValidationError(`${name} must be at most ${max} characters`);
  if (CONTROL_CHARS.test(t)) throw new ValidationError(`${name} contains control characters`);
  return t;
}

function optionalText(value, name, max) {
  if (value === undefined || value === null || value === '') return null;
  return textField(value, name, max);
}

function proposalIdField(value) {
  const id = textField(value, 'proposalId', 40);
  if (!/^evo-[a-z0-9]{1,32}$/.test(id)) throw new ValidationError('proposalId must be an evolution proposal id');
  return id;
}

export function evolutionActions(evolution) {
  return [
    {
      name: 'evolution.propose',
      description: 'Record a candidate change to APEX\'s own behaviour in the Evolution Lab. A proposal is a recorded idea: it authorizes nothing and changes nothing.',
      inputHint: '{"title":"text","hypothesis":"text","evidence":["text"]}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // A proposal is a note about the future, not a step that changes the world, so a plan may not
      // include it: a plan step that "proposes" would record an idea as an executed action.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['title', 'hypothesis', 'evidence']);
        const evidence = o.evidence === undefined || o.evidence === null ? [] : o.evidence;
        if (!Array.isArray(evidence)) throw new ValidationError('evidence must be a list');
        if (evidence.length > 8) throw new ValidationError('at most 8 evidence items may be cited');
        return {
          title: textField(o.title, 'title', 160),
          hypothesis: optionalText(o.hypothesis, 'hypothesis', 2000),
          evidence: evidence.map((item) => textField(String(item), 'an evidence item', 240)),
        };
      },
      async execute(ctx, input) {
        const created = await ctx.evolution.create(input);
        return {
          summary: `evolution proposal ${created.proposalId} recorded; nothing is authorized by it`,
          data: { ...created, authorizesExecution: false },
          display: [
            `Recorded evolution proposal ${created.proposalId}: ${input.title}`,
            input.hypothesis ? `Hypothesis: ${input.hypothesis}` : 'No hypothesis was stated.',
            'A proposal is an idea. It authorizes no action, changes no behaviour, and cannot be promoted until a sandbox run records a result.',
          ].join('\n'),
        };
      },
      async verify(ctx, input, result) {
        const stored = await ctx.evolution.get(result.data.proposalId);
        if (!stored) return { ok: false, detail: 'the proposal is not in the evolution ledger after the write' };
        if (stored.title !== input.title) return { ok: false, detail: 'the stored title differs from the title written' };
        return { ok: true, detail: 'the proposal is recorded with the title that was written' };
      },
    },
    {
      name: 'evolution.verify',
      description: 'Record the result of a sandbox run against an evolution proposal. `verified` is the measured outcome and is stored as reported; the lab never sets it on its own.',
      inputHint: '{"proposalId":"evo-…","verified":true,"detail":"what the sandbox run measured"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['proposalId', 'verified', 'detail']);
        if (typeof o.verified !== 'boolean') throw new ValidationError('verified must be true or false, as measured');
        return {
          proposalId: proposalIdField(o.proposalId),
          verified: o.verified,
          detail: optionalText(o.detail, 'detail', 500),
        };
      },
      async execute(ctx, input) {
        const recorded = await ctx.evolution.recordVerification(input);
        return {
          summary: `sandbox verification recorded for ${recorded.proposalId}: ${recorded.verified ? 'verified' : 'failed'}`,
          data: { ...recorded, recordedFromMeasurement: true },
          display: [
            `Sandbox verification for ${recorded.proposalId}: ${recorded.verified ? 'passed' : 'failed'}.`,
            recorded.verified ? 'Promotion may now be requested; the owner still decides it.' : 'A failed verification blocks promotion until a later run passes.',
          ].join('\n'),
        };
      },
      async verify(ctx, input, result) {
        if (result.data.verified !== input.verified) return { ok: false, detail: 'the stored result differs from the result reported' };
        const stored = await ctx.evolution.get(input.proposalId);
        if (!stored || stored.sandbox.verified !== input.verified) return { ok: false, detail: 'the ledger does not hold the recorded result' };
        return { ok: true, detail: 'the ledger holds the measured result that was written' };
      },
    },
    {
      name: 'evolution.promote',
      description: 'Request promotion of a verified evolution proposal. Refused unless the sandbox verification passed; a request is not an approval.',
      inputHint: '{"proposalId":"evo-…","reason":"text"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['proposalId', 'reason']);
        return { proposalId: proposalIdField(o.proposalId), reason: textField(o.reason, 'reason', 240) };
      },
      async execute(ctx, input) {
        const requested = await ctx.evolution.requestPromotion(input);
        return {
          summary: `promotion of ${requested.proposalId} requested; it awaits your decision`,
          data: { ...requested, authorized: false },
          display: [
            `Promotion requested for ${requested.proposalId}.`,
            `Reason recorded: ${input.reason}`,
            'A request is not an approval. Nothing changes until you decide the promotion, and that decision is audited.',
          ].join('\n'),
        };
      },
      async verify(ctx, input, result) {
        const stored = await ctx.evolution.get(input.proposalId);
        if (!stored) return { ok: false, detail: 'the proposal is not in the ledger' };
        if (stored.promotion.state !== 'requested') return { ok: false, detail: `the promotion state is "${stored.promotion.state}", not "requested"` };
        return { ok: true, detail: 'the promotion request is recorded and awaiting the owner decision' };
      },
    },
    {
      name: 'evolution.decide',
      description: 'Approve or reject a requested evolution promotion. This is the owner\'s own decision and is audited; approving requires the step-up proof when step-up is configured. It never resumes or executes anything by itself.',
      inputHint: '{"proposalId":"evo-…","decision":"approved|rejected","reason":"text","stepUp":"the configured step-up secret, only when step-up is configured"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['proposalId', 'decision', 'reason', 'stepUp']);
        if (o.decision !== 'approved' && o.decision !== 'rejected') {
          throw new ValidationError('decision must be "approved" or "rejected"');
        }
        const stepUp = o.stepUp === undefined || o.stepUp === null ? null : o.stepUp;
        if (stepUp !== null && (typeof stepUp !== 'string' || stepUp.length === 0 || stepUp.length > 200)) {
          throw new ValidationError('stepUp must be the configured step-up secret');
        }
        return {
          proposalId: proposalIdField(o.proposalId),
          decision: o.decision,
          reason: optionalText(o.reason, 'reason', 240),
          stepUp,
          actor: 'owner',
        };
      },
      async execute(ctx, input) {
        // Approving a promotion changes what APEX is allowed to become, so it takes the step-up
        // when one is configured. A rejection is not gated: refusing a change needs no extra proof.
        const stepUp = ctx.registry?.controlPlane;
        if (input.decision === 'approved' && stepUp && typeof stepUp.verifyStepUp === 'function') {
          const gate = stepUp.verifyStepUp(input.stepUp, { capability: 'evolution.decide' });
          if (!gate.ok) {
            throw new ValidationError(gate.reason === 'STEP_UP_REQUIRED'
              ? 'step-up is required to approve a promotion and no proof was given'
              : 'the step-up proof did not match; the promotion is not approved');
          }
        }
        const decided = await ctx.evolution.decidePromotion(input);
        return {
          summary: `evolution promotion ${decided.proposalId} ${decided.decision}`,
          data: { ...decided, actor: 'owner', executesCode: false },
          display: [
            `Promotion for ${decided.proposalId}: ${decided.decision}.`,
            input.reason ? `Reason: ${input.reason}` : 'No reason was recorded.',
            'The decision is a record. It changes no code and resumes no task: applying a promoted change stays an owner act outside the lab.',
          ].join('\n'),
        };
      },
      async verify(ctx, input, result) {
        const stored = await ctx.evolution.get(input.proposalId);
        if (!stored) return { ok: false, detail: 'the proposal is not in the ledger' };
        if (stored.promotion.state !== result.data.decision) {
          return { ok: false, detail: `the ledger holds "${stored.promotion.state}", not "${result.data.decision}"` };
        }
        return { ok: true, detail: 'the decision is recorded in the ledger' };
      },
    },
  ];
}
