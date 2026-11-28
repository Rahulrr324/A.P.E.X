// Evolution Lab actions (T-31 Step 2). Four capabilities, all user-origin writes: propose,
// record a sandbox verification that actually ran, request promotion, and decide a promotion.
//
// They are registered like every other capability, so the ECP authorizes each one and the audit log
// records each one. A proposal is never a permission, and promotion is a recorded decision that the
// lab itself cannot make: the lab only appends what the owner and the sandbox run reported.
import { ValidationError, ExecutionError } from '../errors.js';
import { CONTROL_CHARS, singleLine } from '../util.js';
import { ORIGIN_USER } from './origins.js';
import { classifyGovernancePath, IMMUTABLE_BOUNDARY_CODE } from '../evolution/governance-boundary.js';

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
      inputHint: '{"title":"text","hypothesis":"text","evidence":["text"],"targetRelativePath":"optional","proposedContent":"optional","testContent":"optional"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // A proposal is a note about the future, not a step that changes the world, so a plan may not
      // include it: a plan step that "proposes" would record an idea as an executed action.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['title', 'hypothesis', 'evidence', 'targetRelativePath', 'proposedContent', 'testContent']);
        const evidence = o.evidence === undefined || o.evidence === null ? [] : o.evidence;
        if (!Array.isArray(evidence)) throw new ValidationError('evidence must be a list');
        if (evidence.length > 8) throw new ValidationError('at most 8 evidence items may be cited');
        // T-41 Step 3: the optional target. The immutable-boundary refusal happens in the lab, where
        // the proposal is recorded, so this layer only bounds the text.
        const targetRelativePath = optionalText(o.targetRelativePath, 'targetRelativePath', 512);
        if (o.proposedContent !== undefined && o.proposedContent !== null && typeof o.proposedContent !== 'string') {
          throw new ValidationError('proposedContent must be text');
        }
        if (o.testContent !== undefined && o.testContent !== null && typeof o.testContent !== 'string') {
          throw new ValidationError('testContent must be text');
        }
        return {
          title: textField(o.title, 'title', 160),
          hypothesis: optionalText(o.hypothesis, 'hypothesis', 2000),
          evidence: evidence.map((item) => textField(String(item), 'an evidence item', 240)),
          targetRelativePath,
          proposedContent: o.proposedContent ?? null,
          testContent: o.testContent ?? null,
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
    // T-41 Step 3 (2026-11-22): the bridge from a proposal to a Workshop candidate.
    //
    // This is the one capability that moves bytes from the Evolution Lab's ledger toward the owner's
    // tree, so the ordering below is the whole design:
    //
    //   1. The immutable boundary is checked FIRST, before the proposal is even read. A proposal that
    //      targets `src/executive/` is refused with 403 IMMUTABLE_GOVERNANCE_BOUNDARY whatever else is
    //      true about it - a boundary that can be argued past is not a boundary.
    //   2. The proposal must have a passing sandbox verification recorded. Staging an unverified idea
    //      would put unverified bytes in a directory the applier reads.
    //   3. Only then is a candidate staged, with `sourceProposalId` recorded on the record so the causal
    //      trace can follow proposal -> candidate -> verification -> apply.
    //
    // The refusal is thrown as an ExecutionError rather than a ValidationError: it is a refusal the
    // owner can read and the route can map to 403, not a malformed request.
    {
      name: 'evolution.stage_to_workshop',
      description: 'Stage a sandbox-verified evolution proposal into the Workshop as a candidate file, recording the proposal as its source. The immutable governance boundary is checked first and refuses governance, safety, autonomy, ledger and applier paths with IMMUTABLE_GOVERNANCE_BOUNDARY; there is no override. Staging writes only inside the sandbox - it does not verify, does not apply, and authorizes nothing.',
      inputHint: '{"proposalId":"evo-…"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // Applying a staged proposal to the real tree is an owner act, so a plan may not compose the
      // bridge with an apply: the steps would read as one automatic self-modification.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['proposalId']);
        return { proposalId: proposalIdField(o.proposalId) };
      },
      async execute(ctx, input) {
        if (!ctx?.workshopSandbox) {
          throw new ExecutionError('WORKSHOP_UNAVAILABLE', 'the workshop sandbox is not available in this configuration');
        }
        const proposal = await ctx.evolution.get(input.proposalId);
        if (!proposal) throw new ExecutionError('WORKSHOP_NOT_FOUND', `no evolution proposal ${input.proposalId}`);

        // (1) The boundary, before anything else about the proposal is considered.
        const boundary = classifyGovernancePath(proposal.targetRelativePath);
        if (boundary) {
          const refusal = new ExecutionError(
            boundary.code,
            `the proposal targets ${boundary.path}, which is inside the immutable governance boundary: ${boundary.why}`,
          );
          refusal.boundary = boundary;
          refusal.proposalId = input.proposalId;
          throw refusal;
        }

        // (2) The proposal has to name a target and carry bytes, and the sandbox has to have passed it.
        if (typeof proposal.targetRelativePath !== 'string' || proposal.targetRelativePath.length === 0) {
          throw new ExecutionError('STAGE_REFUSED_NO_TARGET', 'the proposal names no targetRelativePath, so there is nothing to stage');
        }
        if (typeof proposal.proposedContent !== 'string' || proposal.proposedContent.length === 0) {
          throw new ExecutionError('STAGE_REFUSED_NO_CONTENT', 'the proposal carries no proposedContent, so there is nothing to stage');
        }
        if (proposal.sandbox.verified !== true) {
          throw new ExecutionError('STAGE_REFUSED_UNVERIFIED',
            proposal.sandbox.verified === false
              ? 'the proposal\'s sandbox verification failed; it cannot be staged'
              : 'the proposal has no sandbox verification, so it cannot be staged');
        }

        // (3) Stage, then record the link.
        const record = ctx.workshopSandbox.stage({
          relativePath: proposal.targetRelativePath,
          proposedContent: proposal.proposedContent,
          rationale: `${input.proposalId}: ${proposal.title}`.slice(0, 2000),
          testContent: typeof proposal.testContent === 'string' ? proposal.testContent : null,
          // Recorded on the candidate so the causal trace can follow the link from the candidate side.
          sourceProposalId: input.proposalId,
        });
        const staging = await ctx.evolution.recordStaging({
          proposalId: input.proposalId,
          candidateId: record.candidateId,
          targetRelativePath: record.relativePath,
        });
        return {
          summary: `staged ${proposal.targetRelativePath} from ${input.proposalId} as ${record.candidateId}`,
          data: {
            candidateId: record.candidateId,
            relativePath: record.relativePath,
            digest: record.digest,
            bytes: record.bytes,
            lines: record.lines,
            sourceProposalId: input.proposalId,
            hasSandboxTest: typeof record.testPath === 'string',
            stagedAt: staging.at,
            boundaryClear: true,
            verified: false,
            applied: false,
            authorizesExecution: false,
            mutatesLiveWorkspace: false,
          },
          display: [
            `Staged ${proposal.targetRelativePath} from ${input.proposalId} as ${record.candidateId}.`,
            `  ${record.bytes} byte(s), sha256 ${record.digest.slice(0, 16)}, base ${record.base.exists ? 'present' : 'absent'}`,
            'The file is in the sandbox. It has not verified this content and it is not applied: run verification, then apply as a separate owner act.',
          ].join('\n'),
        };
      },
      async verify(ctx, input, result) {
        // The claim worth checking is the LINK, not the staging: a candidate that exists but whose
        // ledger does not name this proposal is a candidate the causal trace cannot explain.
        const stored = await ctx.evolution.get(input.proposalId);
        if (!stored) return { ok: false, detail: 'the proposal is not in the ledger' };
        if (stored.staging.candidateId !== result.data.candidateId) {
          return { ok: false, detail: 'the ledger does not record this candidate against the proposal' };
        }
        const record = ctx.workshopSandbox.load(result.data.candidateId);
        if (!record) return { ok: false, detail: 'the candidate cannot be read back from the sandbox' };
        if (record.digest !== result.data.digest) return { ok: false, detail: 'the sandbox holds a different digest' };
        return { ok: true, detail: `candidate ${result.data.candidateId} is in the sandbox and recorded against ${input.proposalId}` };
      },
    },
  ];
}
