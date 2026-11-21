// T-36 Step 1 (2026-11-21): the governed cold-start bootstrap capability.
//
// It is a write, because it writes: a reading to the perception ledger, a device to the trust
// registry, facts to the world model, and a marker to the data directory. A write is offered to
// the user origin only - a reply may ask for a bootstrap, and the control plane decides, exactly
// as it decides for every other write.
//
// The action itself decides nothing about authorization. It refuses to run at all when the ECP
// lockdown latch is engaged, but that refusal is the control plane's: the capability is registered
// with `origins: ['user']` and `permission: 'write'`, so the registry denies it at model origin
// and the latch denies it while it is engaged.
import { ValidationError } from '../errors.js';

function reasonField(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 240) {
    throw new ValidationError('reason must be 1-240 characters');
  }
  return value.trim();
}

export function systemBootstrapActions(bootstrap) {
  if (!bootstrap || typeof bootstrap.run !== 'function') {
    throw new TypeError('systemBootstrapActions requires the workstation bootstrap service');
  }
  return [
    {
      name: 'system.bootstrap',
      description: 'Bootstrap an unseeded workstation: run the six read-only doctor checks, take a real host and git-workspace reading, enrol the local workstation when the owner has enrolled no device at all, and compile the opening executive briefing. Idempotent - a second run refreshes the live readings without enrolling a second device. Refused while the ECP lockdown latch is engaged. Write: user origin only.',
      inputHint: '{"reason":"why the owner asked for a cold start"}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'system',
      detect: { kind: 'system' },
      validate(input) {
        if (input === undefined || input === null) return { reason: null };
        if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('system.bootstrap expects an object');
        for (const key of Object.keys(input)) {
          if (key !== 'reason') throw new ValidationError(`unexpected system.bootstrap input: ${key}`);
        }
        return { reason: reasonField(input.reason) };
      },
      async execute(_ctx, { reason }) {
        const report = await bootstrap.run({ reason });
        const lines = [
          `Workstation bootstrap ${report.status} at ${report.at} — ${report.detail}.`,
          ...report.checks.map((entry) => `  ${entry.verified ? 'verified' : entry.state}: ${entry.label} — ${entry.detail}`),
          'No task, goal or mission was created: a bootstrap reads this machine and this repository, and nothing else.',
        ];
        return {
          summary: `workstation bootstrap ${report.status}: ${report.checks.filter((entry) => entry.verified).length}/${report.checks.length} check(s) verified`,
          data: report,
          display: lines.join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const report = result?.data;
        if (!report || report.schema !== 'apex.system.bootstrap/1') {
          return { ok: false, detail: 'the bootstrap returned no report' };
        }
        if (report.status === 'lockdown') {
          return { ok: false, detail: 'lockdown was engaged, so the bootstrap wrote nothing' };
        }
        // The marker is the record of the pass, and it is read back from disk rather than believed.
        const after = bootstrap.status();
        if (after.bootstrapped !== true) {
          return { ok: false, detail: 'the bootstrap marker was not written' };
        }
        if (report.marker && after.at !== report.marker.at) {
          return { ok: false, detail: 'the marker on disk is from a different run than the report' };
        }
        const perception = report.perception;
        if (perception && perception.reading) {
          const observed = (perception.observed ?? 0);
          if (observed === 0 && report.verified === true) {
            return { ok: false, detail: 'the bootstrap claims to be verified but no observation was recorded' };
          }
        }
        return {
          ok: true,
          detail: `bootstrap ${report.status}; ${report.checks.filter((entry) => entry.verified).length}/${report.checks.length} check(s) verified and the marker is on disk`,
        };
      },
    },
    {
      name: 'system.bootstrap_status',
      description: 'Read the workstation bootstrap state of this data directory: whether it has been bootstrapped, when it was first and last run, how many runs it has taken, and the check digests of the last pass. Read-only.',
      inputHint: '{}',
      permission: 'read',
      origins: ['user', 'model'],
      plannable: false,
      domain: 'system',
      validate(input) {
        if (input === undefined || input === null) return {};
        if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('system.bootstrap_status expects an object');
        for (const key of Object.keys(input)) {
          throw new ValidationError(`unexpected system.bootstrap_status input: ${key}`);
        }
        return {};
      },
      async execute() {
        const state = bootstrap.status();
        return {
          summary: state.bootstrapped
            ? `bootstrapped at ${state.at} (${state.runs} run(s))`
            : 'this data directory has not been bootstrapped yet',
          data: state,
          display: state.bootstrapped
            ? `Bootstrapped: ${state.status ?? 'unknown'} · first ${state.firstAt ?? 'unknown'} · last ${state.at ?? 'unknown'} · ${state.runs} run(s).`
            : 'Not bootstrapped: this data directory has no bootstrap marker yet.',
        };
      },
      async verify(_ctx, _input, result) {
        const state = result?.data;
        if (!state || typeof state.bootstrapped !== 'boolean') {
          return { ok: false, detail: 'the bootstrap status could not be read' };
        }
        const after = bootstrap.status();
        if (after.bootstrapped !== state.bootstrapped || after.runs !== state.runs) {
          return { ok: false, detail: 'the bootstrap state changed between the read and the verification' };
        }
        return { ok: true, detail: state.bootstrapped ? `bootstrapped, ${state.runs} run(s)` : 'not bootstrapped' };
      },
    },
  ];
}
