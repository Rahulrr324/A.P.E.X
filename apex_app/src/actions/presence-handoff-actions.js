// T-35 Step 2 (2026-11-19): the governed presence handoff actions.
//
// Staging, claiming and revoking an envelope are writes, so they go through the same door as every
// other write: the ActionRegistry, the ECP, origin checking, the operation audit and a verifier that
// re-reads the ledger rather than trusting the call's own return value.
//
// Two refusals matter more than the happy path:
//
//   * Only the owner stages or revokes. A model may propose one of these actions, and the request is
//     refused at execution with the ECP's own reason - a proposal is never permission.
//   * Nothing here grants authority. A claim restores a view and a mission id; every action the
//     restored surface then takes is authorized separately, exactly as before.
import { ValidationError } from '../errors.js';
import { ORIGIN_USER } from './origins.js';

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;

function idField(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value.trim())) {
    throw new ValidationError(`${label} must be a 1-96 character identifier`);
  }
  return value.trim();
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return idField(value, label);
}

function noteField(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('note must be text');
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 240) throw new ValidationError('note must be at most 240 characters');
  return trimmed;
}

function viewField(value) {
  // The service owns the list of views; validating here as well keeps the failure a validation error
  // (refused input) rather than a store error.
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{1,31}$/.test(value.trim())) {
    throw new ValidationError('targetView must be a view identifier');
  }
  return value.trim();
}

// The audit identity a ledger line records. It is the request origin, which the ECP has already
// decided about; the line names who acted, and grants nothing.
function byOf(ctx) {
  const origin = ctx && typeof ctx.origin === 'string' ? ctx.origin : 'unknown';
  return origin === ORIGIN_USER ? 'owner' : origin;
}

function reasonField(value) {
  if (typeof value !== 'string') throw new ValidationError('a revocation reason is required');
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length < 3 || trimmed.length > 240) {
    throw new ValidationError('a revocation reason of 3-240 characters is required');
  }
  return trimmed;
}

export function presenceHandoffActions(handoffs) {
  if (!handoffs || typeof handoffs.stage !== 'function') throw new TypeError('presence handoff actions need the handoff service');

  return [
    {
      name: 'presence.handoff.stage',
      description: 'Stage a presence handoff envelope for an enrolled target device (local store only; no remote transport).',
      domain: 'presence',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      inputHint: '{"sourceDeviceId","targetDeviceId","targetView","taskId"?,"briefingCheckpointId"?,"artifactId"?,"note"?}',
      validate(input = {}) {
        return {
          sourceDeviceId: idField(input.sourceDeviceId, 'sourceDeviceId'),
          targetDeviceId: idField(input.targetDeviceId, 'targetDeviceId'),
          targetView: viewField(input.targetView),
          taskId: optionalId(input.taskId, 'taskId'),
          briefingCheckpointId: optionalId(input.briefingCheckpointId, 'briefingCheckpointId'),
          artifactId: optionalId(input.artifactId, 'artifactId'),
          note: noteField(input.note),
        };
      },
      async execute(ctx, input) {
        const result = await handoffs.stage({ ...input, by: byOf(ctx) });
        return {
          summary: `staged handoff ${result.handoff.id} for ${result.handoff.targetDeviceId} (${result.handoff.targetView})`,
          data: { handoff: result.handoff, verifiedTargets: result.verifiedTargets },
          artifact: { kind: 'presence.handoff', id: result.handoff.id, sha256Digest: result.handoff.sha256Digest },
        };
      },
      async verify(_ctx, _input, result) {
        const recorded = handoffs.get(result?.data?.handoff?.id);
        if (!recorded) return { ok: false, detail: 'the staged handoff is not in the ledger' };
        if (recorded.status !== 'staged') return { ok: false, detail: `the handoff reads ${recorded.status}, not staged` };
        const recomputed = handoffs.digestOf(recorded);
        if (recomputed !== recorded.sha256Digest) return { ok: false, detail: 'the stored envelope does not match its digest' };
        return {
          ok: true,
          detail: `handoff ${recorded.id} is staged with digest ${recorded.sha256Digest.slice(0, 12)} and expires ${recorded.expiresAt}`,
        };
      },
    },
    {
      name: 'presence.handoff.claim',
      description: 'Claim a staged handoff on its target device: verifies the digest, trust and expiry, then returns the exact restoration target.',
      domain: 'presence',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      inputHint: '{"handoffId","targetDeviceId"}',
      validate(input = {}) {
        return { handoffId: idField(input.handoffId, 'handoffId'), targetDeviceId: idField(input.targetDeviceId, 'targetDeviceId') };
      },
      async execute(ctx, input) {
        const staged = handoffs.get(input.handoffId);
        if (!staged) throw new ValidationError(`HANDOFF_UNKNOWN: no handoff ${input.handoffId} is recorded`);
        // The device that claims must be the device the envelope names. A handoff is not a wildcard.
        if (staged.targetDeviceId !== input.targetDeviceId) {
          throw new ValidationError(`HANDOFF_WRONG_DEVICE: ${staged.id} is addressed to ${staged.targetDeviceId}, not ${input.targetDeviceId}`);
        }
        const result = await handoffs.claim(input.handoffId, { by: byOf(ctx) });
        return {
          summary: `claimed handoff ${result.handoff.id}; restore ${result.restoration.view}${result.restoration.taskId ? ` on ${result.restoration.taskId}` : ''}`,
          data: { handoff: result.handoff, restoration: result.restoration },
          artifact: { kind: 'presence.handoff', id: result.handoff.id, sha256Digest: result.handoff.sha256Digest },
        };
      },
      async verify(_ctx, _input, result) {
        const recorded = handoffs.get(result?.data?.handoff?.id);
        if (!recorded) return { ok: false, detail: 'the claimed handoff is not in the ledger' };
        if (recorded.status !== 'claimed') return { ok: false, detail: `the handoff reads ${recorded.status}, not claimed` };
        const restoration = recorded.restoration;
        if (!restoration || restoration.view !== recorded.targetView) {
          return { ok: false, detail: 'the claimed handoff does not name its restoration target' };
        }
        return {
          ok: true,
          detail: `handoff ${recorded.id} is claimed by ${recorded.claimedBy} at ${recorded.claimedAt}; restore ${restoration.view}${restoration.taskId ? ` / ${restoration.taskId}` : ''}`,
        };
      },
    },
    {
      name: 'presence.handoff.revoke',
      description: 'Revoke a staged handoff before it is claimed, recording the reason in the ledger.',
      domain: 'presence',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      inputHint: '{"handoffId","reason"}',
      validate(input = {}) {
        return { handoffId: idField(input.handoffId, 'handoffId'), reason: reasonField(input.reason) };
      },
      async execute(ctx, input) {
        const result = await handoffs.revoke(input.handoffId, { reason: input.reason, by: byOf(ctx) });
        return {
          summary: `revoked handoff ${result.handoff.id}: ${result.handoff.revokeReason}`,
          data: { handoff: result.handoff },
          artifact: { kind: 'presence.handoff', id: result.handoff.id },
        };
      },
      async verify(_ctx, _input, result) {
        const recorded = handoffs.get(result?.data?.handoff?.id);
        if (!recorded) return { ok: false, detail: 'the revoked handoff is not in the ledger' };
        if (recorded.status !== 'revoked') return { ok: false, detail: `the handoff reads ${recorded.status}, not revoked` };
        if (!recorded.revokeReason) return { ok: false, detail: 'the revocation recorded no reason' };
        return { ok: true, detail: `handoff ${recorded.id} is revoked at ${recorded.revokedAt}: ${recorded.revokeReason}` };
      },
    },
  ];
}
