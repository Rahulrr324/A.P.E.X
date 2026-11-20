// T-32 Step 3 (2026-11-19): the governed perception capabilities.
//
// `perception.sense_host` is a read of the machine APEX is running on: CPU load, memory, storage,
// process uptime and memory, and the git branch/HEAD/dirty counts of the configured workspace. It is
// registered rather than called from a route so the same ECP, operation audit and verifier apply to
// it as to every other capability. It stays read-only, and it is refused while the ECP lockdown latch
// is active: a locked-down APEX does not go looking at the host.
//
// The two writes are the owner's, and only the owner's: dismissing a notice class (the second
// dismissal records a revocable suppression rule) and revoking that rule.
import { ValidationError } from '../errors.js';

const ALERT_CLASS_RE = /^[a-z][a-z0-9_]{1,39}$/;

function alertClassField(value) {
  if (typeof value !== 'string' || !ALERT_CLASS_RE.test(value.trim())) {
    throw new ValidationError('alertClass must be a lowercase identifier of 2-40 characters');
  }
  return value.trim();
}

function reasonField(value, label = 'reason') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 240) {
    throw new ValidationError(`${label} must be 1-240 characters`);
  }
  return value.trim();
}

function lockedDown(controlPlane) {
  try {
    const status = controlPlane?.killSwitchStatus?.();
    return status?.active === true;
  } catch {
    // An unreadable latch is treated as engaged: perception fails closed here too.
    return true;
  }
}

export function perceptionActions(perception, { controlPlane = null } = {}) {
  if (!perception || typeof perception.sense !== 'function' || typeof perception.state !== 'function') {
    throw new TypeError('perceptionActions requires the perception service');
  }
  return [
    {
      name: 'perception.sense_host',
      description: 'Read the host and workspace APEX is running on: CPU load, memory, storage availability, process uptime and memory, and the configured workspace git branch, HEAD, dirty and untracked counts and last commit time. Read-only; records the reading as observed epistemic entries. Refused while the ECP lockdown latch is active.',
      inputHint: '{"reason":"why the owner asked for a reading"}',
      // The class is write because the action appends its reading to the perception ledger, which is
      // a store. It reads the machine only, and the write class is what makes the ECP refuse it while
      // the lockdown latch is active - the denial is the control plane's, not a hand-written check.
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'perception',
      detect: { kind: 'perception' },
      validate(input) {
        if (input === undefined || input === null) return { reason: null };
        if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('perception.sense_host expects an object');
        for (const key of Object.keys(input)) {
          if (key !== 'reason') throw new ValidationError(`unexpected perception.sense_host input: ${key}`);
        }
        return { reason: reasonField(input.reason) };
      },
      async execute(_ctx, { reason }) {
        if (lockedDown(controlPlane)) {
          throw new ValidationError('the ECP lockdown latch is active; host sensing is refused while locked down', 'LOCKDOWN_ACTIVE');
        }
        const result = perception.sense({ reason });
        const reading = result.reading;
        const workspace = reading.workspace;
        const lines = [
          `Host reading at ${reading.at}: ${result.recorded} observation(s), source ${perception.source}.`,
          `CPU: ${reading.host.cpu.logicalCount ?? 'unavailable'} logical · load 1m ${reading.host.cpu.loadAverage1m ?? 'unavailable'}`,
          `Memory: ${reading.host.memory.usedBytes ?? 'unavailable'} of ${reading.host.memory.totalBytes ?? 'unavailable'} bytes in use`,
          `Process: up ${reading.host.process.uptimeSeconds ?? 'unavailable'}s · rss ${reading.host.process.rssBytes ?? 'unavailable'} bytes`,
          workspace.available
            ? `Workspace: ${workspace.branch ?? 'detached'} at ${workspace.head ?? 'unavailable'} · ${workspace.dirtyFiles ?? 'unavailable'} changed · ${workspace.untrackedFiles ?? 'unavailable'} untracked`
            : `Workspace: unavailable (${workspace.reason})`,
          'These are readings, not inferences: an unavailable value is reported as unavailable.',
        ];
        return {
          summary: `host reading: ${result.recorded} observed entries`,
          data: { reading, recorded: result.recorded, observations: result.observations },
          display: lines.join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const reading = result?.data?.reading;
        if (!reading || typeof reading !== 'object') return { ok: false, detail: 'the action returned no reading' };
        if (reading.source === undefined && !reading.at) return { ok: false, detail: 'the reading carries no timestamp' };
        const after = perception.state({ limit: 1 });
        if (!after.lastObservationAt) return { ok: false, detail: 'no observation was written to the perception ledger' };
        if (after.source !== perception.source) return { ok: false, detail: 'the ledger names a different sensor' };
        return { ok: true, detail: `observation recorded at ${after.lastObservationAt}` };
      },
    },
    {
      name: 'perception.state',
      description: 'Read the perception ledger: recent host and workspace observations, the Sentinel push budget (three non-critical pushes per rolling hour), and the active suppression rules with their expiry. Read-only.',
      inputHint: '{"limit":20}',
      permission: 'read',
      origins: ['user', 'model'],
      plannable: false,
      domain: 'perception',
      validate(input) {
        if (input === undefined || input === null) return { limit: 20 };
        if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('perception.state expects an object');
        for (const key of Object.keys(input)) {
          if (key !== 'limit') throw new ValidationError(`unexpected perception.state input: ${key}`);
        }
        if (input.limit === undefined || input.limit === null) return { limit: 20 };
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 40) {
          throw new ValidationError('limit must be an integer from 1 to 40');
        }
        return { limit: input.limit };
      },
      async execute(_ctx, { limit }) {
        const view = perception.state({ limit });
        return {
          summary: `${view.observations.length} observation(s); ${view.governor.budget.remaining}/${view.governor.budget.limit} non-critical pushes left this hour`,
          data: view,
          display: [
            `Perception ledger (${view.source}) — last observation ${view.lastObservationAt ?? 'none recorded'}`,
            `Push budget: ${view.governor.budget.used}/${view.governor.budget.limit} used, ${view.governor.budget.remaining} remaining this hour`,
            view.governor.suppressions.length === 0
              ? 'No alert class is suppressed.'
              : `Suppressed classes: ${view.governor.suppressions.map((rule) => `${rule.alertClass} until ${rule.suppressedUntil}`).join(', ')}`,
          ].join('\n'),
        };
      },
      async verify(_ctx, { limit }, result) {
        const data = result?.data;
        if (!data || !Array.isArray(data.observations)) return { ok: false, detail: 'the read returned no observation list' };
        if (data.observations.length > limit) return { ok: false, detail: `the read returned ${data.observations.length} observations for a limit of ${limit}` };
        const budget = data.governor?.budget;
        if (!budget || budget.used + budget.remaining !== budget.limit) {
          return { ok: false, detail: 'the push budget did not account for every slot' };
        }
        const after = perception.state({ limit });
        if (after.lastObservationAt !== data.lastObservationAt) {
          return { ok: false, detail: 'the ledger moved between the read and the verification' };
        }
        return { ok: true, detail: `${data.observations.length} observation(s) read within a ${limit} limit` };
      },
    },
    {
      name: 'perception.dismiss_alert',
      description: 'Record that the owner dismissed a class of Sentinel notice. The second dismissal of a class records a revocable suppression rule with an expiry; critical safety, lockdown and degraded notices are never suppressed. User origin only.',
      inputHint: '{"alertClass":"storage_pressure"}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'perception',
      validate(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('perception.dismiss_alert expects an object');
        for (const key of Object.keys(input)) {
          if (key !== 'alertClass') throw new ValidationError(`unexpected perception.dismiss_alert input: ${key}`);
        }
        return { alertClass: alertClassField(input.alertClass) };
      },
      async execute(_ctx, { alertClass }) {
        const result = perception.dismiss({ alertClass });
        return {
          summary: result.suppressed
            ? `alert class ${alertClass} suppressed until ${result.rule?.suppressedUntil}`
            : `dismissal ${result.dismissals} of ${alertClass} recorded`,
          data: result,
          display: [
            `Dismissal recorded for ${alertClass} (${result.dismissals} so far).`,
            result.suppressed
              ? `The class is suppressed until ${result.rule?.suppressedUntil}; the rule is visible in Sentinel and revocable.`
              : 'A second dismissal records a revocable suppression rule.',
            'Critical safety, lockdown and degraded notices bypass suppression.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { alertClass }, result) {
        const view = perception.state({ limit: 1 });
        const rule = view.governor.rules.find((entry) => entry.alertClass === alertClass);
        if (result.dismissals >= 2 && !rule) return { ok: false, detail: 'two dismissals did not record a suppression rule' };
        if (rule && rule.revokedAt !== null) return { ok: false, detail: 'the suppression rule is already revoked' };
        return { ok: true, detail: rule ? `rule ${rule.id} suppresses ${alertClass} until ${rule.suppressedUntil}` : `dismissal ${result.dismissals} recorded` };
      },
    },
    {
      name: 'perception.revoke_suppression',
      description: 'Revoke a suppression rule the owner recorded, so the class of notice is surfaced again. User origin only.',
      inputHint: '{"ruleId":"rule-7"}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'perception',
      validate(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('perception.revoke_suppression expects an object');
        for (const key of Object.keys(input)) {
          if (key !== 'ruleId') throw new ValidationError(`unexpected perception.revoke_suppression input: ${key}`);
        }
        if (typeof input.ruleId !== 'string' || !/^rule-[0-9]{1,9}$/.test(input.ruleId.trim())) {
          throw new ValidationError('ruleId must be a suppression rule id');
        }
        return { ruleId: input.ruleId.trim() };
      },
      async execute(_ctx, { ruleId }) {
        const result = perception.revoke(ruleId);
        if (!result.revoked) throw new ValidationError(`no suppression rule ${ruleId} exists`, 'UNKNOWN_RULE');
        return {
          summary: result.alreadyRevoked ? `rule ${ruleId} was already revoked` : `rule ${ruleId} revoked`,
          data: result,
          display: [
            result.alreadyRevoked ? `Rule ${ruleId} was already revoked.` : `Rule ${ruleId} revoked; ${result.rule.alertClass} notices are surfaced again.`,
          ].join('\n'),
        };
      },
      async verify(_ctx, { ruleId }, result) {
        if (result?.data?.revoked !== true) return { ok: false, detail: 'the action did not report a revocation' };
        const rule = perception.state({ limit: 1 }).governor.rules.find((entry) => entry.id === ruleId);
        if (!rule) return { ok: false, detail: `rule ${ruleId} is not in the ledger` };
        if (rule.revokedAt === null) return { ok: false, detail: `rule ${ruleId} is still active` };
        return { ok: true, detail: `rule ${ruleId} records its revocation at ${rule.revokedAt}` };
      },
    },
  ];
}
