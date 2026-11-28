// T-34 Step 3 (2026-11-19): acknowledging a briefing.
//
// The action exists so the acknowledgement is a governed act rather than a client-state flag:
//
//   * it is a user-origin write, so the ECP authorizes it like any other write, and the lockdown
//     latch refuses it;
//   * the checkpoint it writes holds a *reading* - what the owning stores held at that moment - and
//     the verification reads both the record and the store status back, so "acknowledged" is only
//     reported when the line is really in the log;
//   * acknowledging authorizes nothing. It records that the owner has read a briefing, which is what
//     makes the next briefing able to say what changed since.
import { ValidationError } from '../errors.js';
import { ORIGIN_USER } from './origins.js';

const MAX_REASON_CHARS = 240;

function reasonField(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('reason must be text');
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_REASON_CHARS) throw new ValidationError(`reason must be at most ${MAX_REASON_CHARS} characters`);
  return trimmed;
}

export function briefingActions(briefing) {
  if (!briefing || typeof briefing.acknowledge !== 'function') throw new TypeError('briefing actions need the briefing service');
  return [
    {
      name: 'briefing.acknowledge',
      description: 'Record that the owner has read the current briefing, writing a checkpoint of what the owning stores held at that moment. The next briefing compares against it. Authorizes nothing and changes no other store.',
      inputHint: '{"reason": optional text}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      domain: 'briefing',
      validate(input) {
        if (input === undefined || input === null) return { reason: null };
        if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('briefing.acknowledge expects an object');
        for (const key of Object.keys(input)) {
          if (key !== 'reason') throw new ValidationError(`unexpected briefing.acknowledge input: ${key}`);
        }
        return { reason: reasonField(input.reason) };
      },
      async execute(_ctx, { reason }) {
        const outcome = await briefing.acknowledge({ by: 'owner', reason });
        const record = outcome?.record ?? null;
        if (!record || typeof record.id !== 'string') throw new ValidationError('the checkpoint was not recorded; nothing is claimed');
        return {
          summary: `briefing checkpoint ${record.id} recorded at ${record.at}${reason ? `: ${reason}` : ''}`,
          data: {
            checkpointId: record.id,
            at: record.at,
            by: record.by,
            reason: record.reason,
            snapshot: record.snapshot,
            authorizesExecution: false,
          },
          display: `Acknowledged: the briefing read at ${record.at} is the baseline for the next one (checkpoint ${record.id}).`,
        };
      },
      async verify(_ctx, _input, result) {
        const checkpointId = result?.data?.checkpointId ?? null;
        if (!checkpointId) return { ok: false, detail: 'no checkpoint id was returned, so nothing is claimed' };
        const latest = await briefing.latest();
        if (!latest || latest.id !== checkpointId) {
          return { ok: false, detail: `checkpoint ${checkpointId} is not the latest line in the briefing log` };
        }
        const status = typeof briefing.status === 'function' ? await briefing.status() : null;
        return {
          ok: true,
          detail: `checkpoint ${checkpointId} is the latest of ${status?.store?.total ?? 'an unknown number of'} line(s) in the briefing log`,
        };
      },
    },
  ];
}
