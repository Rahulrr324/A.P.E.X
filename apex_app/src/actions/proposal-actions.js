// Proposal actions: the user's explicit decision about a model proposal.
//
// All three are write actions, user-origin only, and unplannable, so a model cannot accept,
// reject, or invalidate its own suggestion, and cannot smuggle a proposal decision into a plan.
// Acceptance re-checks the live goal or plan state before applying anything, applies only
// through the ordinary store operation, and verifies the result before recording the decision.
// Rejection and invalidation change no goal or plan.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, shortId, singleLine } from '../util.js';
import { ORIGIN_USER } from './origins.js';
import { assessProposal, applyProposal } from '../proposals/apply.js';
import { ProposalStatus, proposalStatus } from '../proposals/model.js';
import { renderProposal } from '../proposals/format.js';

function recordRef(value, name) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const ref = value.trim();
  if (ref.length === 0) throw new ValidationError(`${name} is empty`);
  if (ref.length > 64) throw new ValidationError(`${name} is longer than 64 characters`);
  if (CONTROL_CHARS.test(ref)) throw new ValidationError(`${name} contains control characters`);
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

function reasonField(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidationError('reason must be text');
  const text = value.trim();
  if (text.length > 500) throw new ValidationError('reason exceeds 500 characters');
  if (CONTROL_CHARS.test(text)) throw new ValidationError('reason contains control characters');
  return text;
}

function statusError(proposal, status, problems) {
  const why = problems.length ? `: ${problems.join('; ')}` : '';
  return new ValidationError(`proposal ${shortId(proposal.id)} is ${status}; it cannot be accepted${why}`, `PROPOSAL_${status.toUpperCase()}`);
}

export function proposalActions(store) {
  if (!store || typeof store.decide !== 'function' || typeof store.resolve !== 'function') {
    throw new TypeError('proposalActions requires a proposal store');
  }
  return [
    {
      name: 'proposal.accept',
      description: 'Accept a model proposal as the user. The live goal or plan is re-checked first and changed only through the ordinary store operation; a plan stays a draft and a goal stays proposed. Accepting never approves, activates, or executes anything. Write: user origin only.',
      inputHint: '{"target":"proposal id","reason":"optional text"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'reason']);
        return { target: recordRef(o.target, 'target'), reason: reasonField(o.reason) };
      },
      async execute(ctx, { target, reason }) {
        if (!ctx.goals || !ctx.plans) throw new ValidationError('the goal and plan stores are not available, so a proposal cannot be accepted');
        const proposal = await store.resolve(target);
        const assessment = await assessProposal(proposal, { goals: ctx.goals, plans: ctx.plans, now: typeof ctx.now === 'function' ? ctx.now() : new Date() });
        if (assessment.status !== ProposalStatus.PENDING) throw statusError(proposal, assessment.status, assessment.problems);
        if (assessment.problems.length > 0 && !assessment.alreadyApplied) {
          throw new ValidationError(`proposal ${shortId(proposal.id)} cannot be accepted: ${assessment.problems.join('; ')}`, 'PROPOSAL_STALE');
        }
        const result = await applyProposal(proposal, { goals: ctx.goals, plans: ctx.plans, reason });
        // Verify before recording the decision. A failed verification leaves the proposal pending;
        // a retry finds the change already applied rather than creating a second record.
        if (result.applied.goalId) {
          const goal = await ctx.goals.get(result.applied.goalId);
          if (!goal) throw new ValidationError('the applied goal cannot be read back; the proposal was not recorded as accepted', 'VERIFICATION_FAILED');
        }
        if (result.applied.planId) {
          const plan = await ctx.plans.get(result.applied.planId);
          if (!plan) throw new ValidationError('the applied plan cannot be read back; the proposal was not recorded as accepted', 'VERIFICATION_FAILED');
        }
        const decided = await store.decide(proposal.id, { decision: ProposalStatus.ACCEPTED, reason, applied: result.applied });
        return {
          summary: result.applied.planId
            ? `accepted proposal ${shortId(proposal.id)}; ${result.alreadyApplied ? 'the draft plan was already present' : 'a draft plan was stored'}; nothing ran`
            : result.applied.goalId
              ? `accepted proposal ${shortId(proposal.id)}; ${result.alreadyApplied ? 'the goal change was already present' : `goal ${shortId(result.applied.goalId)} was recorded`}; nothing ran`
              : `accepted proposal ${shortId(proposal.id)} as advice; nothing was changed and nothing ran`,
          data: {
            proposalId: proposal.id,
            decision: decided.proposal.decision.decision,
            applied: result.applied,
            alreadyApplied: result.alreadyApplied,
          },
          display: [
            `Proposal ${shortId(proposal.id)} accepted.`,
            result.applied.goalId ? `  goal: ${shortId(result.applied.goalId)}` : null,
            result.applied.planId ? `  plan: ${shortId(result.applied.planId)}` : null,
            result.note ?? null,
            'Accepting a proposal is not approval or authorization. Every step still needs its own approval and every action its own authorization.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(ctx, { target }, result) {
        const proposal = await store.resolve(target);
        if (!proposal.decision || proposal.decision.decision !== ProposalStatus.ACCEPTED) {
          return { ok: false, detail: 'the proposal does not record an accepted decision' };
        }
        if (proposal.decision.applied?.goalId) {
          const goal = await ctx.goals.get(proposal.decision.applied.goalId);
          if (!goal) return { ok: false, detail: 'the applied goal cannot be read back' };
        }
        if (proposal.decision.applied?.planId) {
          const plan = await ctx.plans.get(proposal.decision.applied.planId);
          if (!plan) return { ok: false, detail: 'the applied plan cannot be read back' };
        }
        return { ok: true, detail: 'the user decision is recorded and every applied record is present' };
      },
    },

    {
      name: 'proposal.reject',
      description: 'Reject a model proposal. Nothing in any goal or plan changes, and the proposal remains readable as history. Write: user origin only.',
      inputHint: '{"target":"proposal id","reason":"why it was rejected"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'reason']);
        const reason = reasonField(o.reason);
        if (reason.length === 0) throw new ValidationError('a rejection needs a reason');
        return { target: recordRef(o.target, 'target'), reason };
      },
      async execute(_ctx, { target, reason }) {
        const proposal = await store.resolve(target);
        const before = proposalStatus(proposal);
        const decided = await store.decide(proposal.id, { decision: ProposalStatus.REJECTED, reason });
        return {
          summary: `rejected proposal ${shortId(proposal.id)} (${before}); no goal or plan was changed`,
          data: { proposalId: proposal.id, decision: decided.proposal.decision.decision, applied: null },
          display: `Proposal ${shortId(proposal.id)} rejected. No goal, plan, or task was changed. The record stays readable as history.`,
        };
      },
      async verify(_ctx, { target }, result) {
        const proposal = await store.resolve(target);
        if (!proposal.decision || proposal.decision.decision !== ProposalStatus.REJECTED) {
          return { ok: false, detail: 'the rejection is not recorded' };
        }
        if (proposal.decision.applied?.goalId || proposal.decision.applied?.planId) {
          return { ok: false, detail: 'a rejection must not name an applied record' };
        }
        return { ok: true, detail: 'the rejection is recorded and nothing was applied' };
      },
    },

    {
      name: 'proposal.invalidate',
      description: 'Mark a pending model proposal as invalidated by the user, for example because its assumptions no longer hold. Nothing in any goal or plan changes. Write: user origin only.',
      inputHint: '{"target":"proposal id","reason":"what invalidated it"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'reason']);
        const reason = reasonField(o.reason);
        if (reason.length === 0) throw new ValidationError('an invalidation needs a reason');
        return { target: recordRef(o.target, 'target'), reason };
      },
      async execute(_ctx, { target, reason }) {
        const proposal = await store.resolve(target);
        const before = proposalStatus(proposal);
        const decided = await store.decide(proposal.id, { decision: ProposalStatus.INVALIDATED, reason });
        return {
          summary: `invalidated proposal ${shortId(proposal.id)} (${before}); no goal or plan was changed`,
          data: { proposalId: proposal.id, decision: decided.proposal.decision.decision, applied: null },
          display: `Proposal ${shortId(proposal.id)} invalidated. No goal, plan, or task was changed. The record stays readable as history.`,
        };
      },
      async verify(_ctx, { target }) {
        const proposal = await store.resolve(target);
        if (!proposal.decision || proposal.decision.decision !== ProposalStatus.INVALIDATED) {
          return { ok: false, detail: 'the invalidation is not recorded' };
        }
        return { ok: true, detail: 'the invalidation is recorded and nothing was applied' };
      },
    },
  ];
}
