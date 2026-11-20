// T-33 Step 1 (2026-11-19): the Sentinel's advisories, derived from a reading.
//
// T-32 Step 3 gave the Sentinel a push discipline - three non-critical notices an hour, dedupe,
// dismissals and revocable suppressions - but nothing derived a notice from a reading, so the
// discipline had no conditions to discipline. This module is that missing half, and it is
// deliberately small:
//
//   * every advisory is a fixed rule over the values the host/workspace sensor actually read;
//   * a rule fires only on an observed value - a reading that is `null` because it could not be
//     taken never becomes an alarm, because "unavailable" is not "alarming";
//   * the signature is the condition, not the moment, so re-sensing an unchanged machine produces
//     the same signature and the governor deduplicates it instead of counting it again;
//   * criticality is stated by the rule that raised the notice, never inferred by the governor. Only
//     a reading that has degraded as a whole (every host value unavailable) is critical, because a
//     sensor that can no longer see the machine is a Core-level fact, not a housekeeping one.
//
// The thresholds are named constants so the owner can read what "pressure" means, and so a test can
// state the boundary rather than guess it.
export const ADVISORY_SCHEMA = 'apex.perception.advisory/1';
export const ADVISORY_SOURCE = 'host-workspace-sensor';

export const MEMORY_PRESSURE_RATIO = 0.9;
export const LOAD_PRESSURE_RATIO = 0.9;
export const STORAGE_PRESSURE_RATIO = 0.1;

// The rules, in the order they are reported. `alertClass` is the identifier the owner dismisses and
// the governor suppresses; `watch` names the producer so two rules can share a class and still be
// deduplicated separately.
export const ADVISORY_RULES = Object.freeze([
  Object.freeze({
    alertClass: 'workspace_dirty',
    watch: 'workspace',
    critical: false,
    describe: 'the configured workspace has uncommitted or untracked files',
  }),
  Object.freeze({
    alertClass: 'workspace_unreadable',
    watch: 'workspace',
    critical: false,
    describe: 'the configured workspace could not be read, which is not the same as clean',
  }),
  Object.freeze({
    alertClass: 'memory_pressure',
    watch: 'host.memory',
    critical: false,
    describe: `memory use is at or above ${Math.round(MEMORY_PRESSURE_RATIO * 100)}%`,
  }),
  Object.freeze({
    alertClass: 'load_pressure',
    watch: 'host.cpu',
    critical: false,
    describe: `per-core load is at or above ${Math.round(LOAD_PRESSURE_RATIO * 100)}%`,
  }),
  Object.freeze({
    alertClass: 'storage_pressure',
    watch: 'host.storage',
    critical: false,
    describe: `a storage volume has ${Math.round(STORAGE_PRESSURE_RATIO * 100)}% or less free`,
  }),
  Object.freeze({
    alertClass: 'degraded',
    watch: 'host',
    critical: true,
    describe: 'every host value in the reading was unavailable, so the sensor cannot see the machine',
  }),
]);

const BY_CLASS = new Map(ADVISORY_RULES.map((rule) => [rule.alertClass, rule]));

function advisory(alertClass, signature, summary, detail = null) {
  const rule = BY_CLASS.get(alertClass);
  return Object.freeze({
    schema: ADVISORY_SCHEMA,
    alertClass,
    watch: rule.watch,
    critical: rule.critical,
    severity: rule.critical ? 'critical' : 'advisory',
    signature: String(signature).slice(0, 160),
    summary: String(summary).slice(0, 240),
    basis: rule.describe,
    detail,
  });
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Pure: the same reading always produces the same advisory list, in the same order.
export function deriveAdvisories(reading) {
  if (!reading || typeof reading !== 'object') return Object.freeze([]);
  const host = reading.host && typeof reading.host === 'object' ? reading.host : {};
  const workspace = reading.workspace && typeof reading.workspace === 'object' ? reading.workspace : {};
  const out = [];

  if (workspace.available === true) {
    const dirty = count(workspace.dirtyFiles);
    const untracked = count(workspace.untrackedFiles);
    if (dirty !== null && untracked !== null && dirty + untracked > 0) {
      out.push(advisory(
        'workspace_dirty',
        `workspace_dirty:${workspace.branch ?? 'detached'}:${dirty}:${untracked}`,
        `${dirty} changed and ${untracked} untracked file(s) in the ${workspace.branch ?? 'detached'} workspace`,
        { root: workspace.root ?? null, dirtyFiles: dirty, untrackedFiles: untracked },
      ));
    }
  } else if (workspace.available === false && workspace.reason !== 'NO_WORKSPACE_ROOT') {
    // A workspace that was never configured is not a condition to report: a deployment without a
    // workspace root is a normal deployment. Only a root that exists and cannot be read is an
    // advisory, because that is a tree the owner asked APEX to see and APEX cannot see it.
    out.push(advisory(
      'workspace_unreadable',
      `workspace_unreadable:${workspace.reason ?? 'unknown'}`,
      `the workspace could not be read (${workspace.reason ?? 'no reason recorded'})`,
      { reason: workspace.reason ?? null },
    ));
  }

  const memRatio = Number(host.memory?.usedPercent);
  if (Number.isFinite(memRatio) && memRatio >= MEMORY_PRESSURE_RATIO) {
    out.push(advisory('memory_pressure', `memory_pressure:${Math.round(memRatio * 100)}`,
      `memory use is ${Math.round(memRatio * 100)}% of ${host.memory?.totalBytes ?? 'an unknown total'} bytes`));
  }

  const loadRatio = Number(host.cpu?.loadPercent);
  if (Number.isFinite(loadRatio) && loadRatio >= LOAD_PRESSURE_RATIO) {
    out.push(advisory('load_pressure', `load_pressure:${Math.round(loadRatio * 100)}`,
      `per-core load is ${Math.round(loadRatio * 100)}% across ${host.cpu?.logicalCount ?? 'an unknown number of'} logical CPUs`));
  }

  const volumes = Array.isArray(host.storage) ? host.storage : [];
  const tight = volumes.filter((volume) => Number.isSafeInteger(volume?.totalBytes) && volume.totalBytes > 0
    && Number.isSafeInteger(volume?.availableBytes)
    && volume.availableBytes / volume.totalBytes <= STORAGE_PRESSURE_RATIO);
  if (tight.length > 0) {
    out.push(advisory('storage_pressure', `storage_pressure:${tight.map((volume) => volume.path).sort().join(',')}`,
      `${tight.length} storage volume(s) at or below ${Math.round(STORAGE_PRESSURE_RATIO * 100)}% free`,
      { volumes: tight.map((volume) => ({ path: volume.path, availableBytes: volume.availableBytes, totalBytes: volume.totalBytes })) }));
  }

  // Whole-reading degradation: the sensor answered, but every host value in it was unavailable.
  const hostValues = [host.cpu?.logicalCount, host.cpu?.loadAverage1m, host.memory?.totalBytes,
    host.memory?.usedPercent, host.process?.uptimeSeconds];
  if (hostValues.every((value) => value === null || value === undefined)) {
    out.push(advisory('degraded', 'degraded:host-unreadable',
      'every host value in the reading was unavailable; the Core cannot see this machine'));
  }

  return Object.freeze(out);
}

// One delivery pass: every derived advisory goes to the governor exactly once, and the governor's
// answer - admitted, deduplicated, capped, suppressed - is returned with the advisory that asked.
// The governor is the only thing that decides delivery; this function decides nothing.
export function deliverAdvisories(governor, advisories, { at } = {}) {
  if (!governor || typeof governor.admit !== 'function') throw new TypeError('deliverAdvisories needs a push governor');
  const list = Array.isArray(advisories) ? advisories : [];
  const deliveries = list.map((entry) => {
    const decision = governor.admit({
      watch: entry.watch,
      signature: entry.signature,
      critical: entry.critical === true,
      alertClass: entry.alertClass,
      summary: entry.summary,
      ...(at === undefined ? {} : { at }),
    });
    return Object.freeze({
      alertClass: entry.alertClass,
      watch: entry.watch,
      critical: entry.critical === true,
      signature: entry.signature,
      summary: entry.summary,
      admitted: decision.admitted === true,
      reason: decision.reason,
      at: decision.at,
      pushId: decision.id,
    });
  });
  return Object.freeze(deliveries);
}
