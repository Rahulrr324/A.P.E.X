// T-35 Step 1 (2026-11-19): Part 4's visual step-down ladder and the system sensor indicator.
//
// Part 4 asks for two things this module owns the reading half of:
//
//   1. An ordered five-stage visual degradation ladder driven by real ResourceFabric pressure, so a
//      strained machine sheds decoration in a fixed order instead of a designer's choice, and the
//      Core reticle - the one thing that says what APEX is doing - survives to the last stage.
//   2. A read-only statement of which local sensors are active and which are not, so "APEX is not
//      listening and not watching" is a reading of the deployment rather than a promise in prose.
//
// Nothing here authorizes anything, writes a store, or starts a sensor. It is a pure function of
// telemetry the ResourceFabric already produces and of the registry the caller already holds, and it
// is computed per snapshot so a reading never outlives the numbers it was derived from.
//
// The ladder is data, not prose: each stage lists exactly which layers it drops, and the browser
// applies that list to `data-hud-*` attributes on the HUD root. A stage that says it dropped bloom
// and did not is a visible lie, so the table below is the single source of both the payload and the
// stylesheet's selectors.
export const HUD_SCHEMA = 'apex.hud/1';
export const STEPDOWN_SCHEMA = 'apex.hud.stepdown/1';
export const SENSOR_SCHEMA = 'apex.hud.sensor/1';

// Part 4's flash rule: no animation, pulse or alert may cycle faster than three times a second. The
// guard is stated once here, asserted against the shipped stylesheet by a test, and re-measured in
// the browser against every element's computed animation duration.
export const FLASH_GUARD = Object.freeze({ maxFlashesPerSecond: 3, minIntervalMs: 334 });

// The thresholds are explicit numbers rather than a feeling. Memory is the fraction of physical
// memory in use; load is the one-minute load average divided by the logical CPU count, so a 32-core
// box at load 32 is "saturated" and a 2-core box at load 2 is the same reading.
export const PRESSURE_THRESHOLDS = Object.freeze({
  memoryUsedPercent: Object.freeze({ elevated: 0.8, high: 0.9, critical: 0.96 }),
  loadPerCpu: Object.freeze({ elevated: 1.5, high: 3, critical: 6 }),
});

// Which ladder stage a pressure level steps to. The mapping is coarse on purpose: a ladder that moves
// on every jitter would flicker, and the spec's ladder is about shedding whole layers, not trimming
// them. `unknown` stays at 0 because a machine whose telemetry cannot be read is not evidence of
// strain - and the payload says `unknown`, so the page never claims a nominal reading it did not make.
const STAGE_FOR_LEVEL = Object.freeze({ nominal: 0, elevated: 2, high: 4, critical: 5, unknown: 0 });

const LAYERS = Object.freeze(['bloom', 'particles', 'parallax', 'ambientMotion', 'backdropBlur', 'panelTransitions']);

function layersFor(dropped) {
  const set = new Set(dropped);
  return Object.freeze(Object.fromEntries(LAYERS.map((layer) => [layer, set.has(layer) ? 'dropped' : 'on'])));
}

function stage(spec) {
  const frozenDrops = Object.freeze([...spec.dropped]);
  return Object.freeze({
    stage: spec.stage,
    tier: spec.tier,
    name: spec.name,
    summary: spec.summary,
    dropped: frozenDrops,
    layers: layersFor(frozenDrops),
  });
}

// The ladder itself. Stage 5 is flat mode: no blur, no transitions, and the reticle is deliberately
// not in the list of things it may drop - Part 4 keeps the Core state legible at every stage.
export const VISUAL_STAGES = Object.freeze([
  stage({
    stage: 0,
    tier: 'A',
    name: 'nominal',
    summary: 'Full HUD tokens: bloom, particles, parallax, ambient motion, backdrop blur and panel transitions.',
    dropped: [],
  }),
  stage({
    stage: 1,
    tier: 'B',
    name: 'drop_bloom',
    summary: 'Multi-tier outer glow and bloom disabled; the reticle and its state cadence are untouched.',
    dropped: ['bloom'],
  }),
  stage({
    stage: 2,
    tier: 'B',
    name: 'drop_particles',
    summary: 'Background field particles and grid shimmer disabled.',
    dropped: ['bloom', 'particles'],
  }),
  stage({
    stage: 3,
    tier: 'B',
    name: 'drop_parallax',
    summary: 'Z0-Z4 depth-plane parallax factors zeroed, so a pointer move no longer shifts any plane.',
    dropped: ['bloom', 'particles', 'parallax'],
  }),
  stage({
    stage: 4,
    tier: 'B',
    name: 'drop_ambient_motion',
    summary: 'Secondary ring drift and ambient motion paused; the Core state indicator keeps its cadence.',
    dropped: ['bloom', 'particles', 'parallax', 'ambientMotion'],
  }),
  stage({
    stage: 5,
    tier: 'C',
    name: 'flat_mode',
    summary: 'Backdrop blur and panel transitions disabled. The Core state reticle stays active and legible.',
    dropped: ['bloom', 'particles', 'parallax', 'ambientMotion', 'backdropBlur', 'panelTransitions'],
  }),
]);

export const MAX_STAGE = VISUAL_STAGES.length - 1;

function finiteOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// What the telemetry says about this machine, in the two numbers the ladder reads. Everything else
// the ResourceFabric reports is carried through untouched by the caller; this function only reads.
export function pressureFromTelemetry(telemetry) {
  const total = finiteOrNull(telemetry?.memory?.totalBytes);
  const free = finiteOrNull(telemetry?.memory?.freeBytes);
  const memoryUsedPercent = total !== null && free !== null && total > 0
    ? Math.min(Math.max(1 - (free / total), 0), 1)
    : null;
  const logicalCpuCount = finiteOrNull(telemetry?.cpu?.logicalCount);
  const loadAverage1m = finiteOrNull(telemetry?.cpu?.loadAverage1m);
  const loadPerCpu1m = logicalCpuCount !== null && logicalCpuCount > 0 && loadAverage1m !== null
    ? loadAverage1m / logicalCpuCount
    : null;

  const reasons = [];
  let level = 'nominal';
  const raise = (next) => {
    const order = ['nominal', 'elevated', 'high', 'critical'];
    if (order.indexOf(next) > order.indexOf(level)) level = next;
  };
  if (memoryUsedPercent === null && loadPerCpu1m === null) {
    level = 'unknown';
    reasons.push('neither memory nor load telemetry was reported; no pressure level is inferred');
  } else {
    if (memoryUsedPercent !== null) {
      const t = PRESSURE_THRESHOLDS.memoryUsedPercent;
      if (memoryUsedPercent >= t.critical) raise('critical');
      else if (memoryUsedPercent >= t.high) raise('high');
      else if (memoryUsedPercent >= t.elevated) raise('elevated');
      reasons.push(`memory ${(memoryUsedPercent * 100).toFixed(1)}% used (elevated >= 80%, high >= 90%, critical >= 96%)`);
    }
    if (loadPerCpu1m !== null) {
      const t = PRESSURE_THRESHOLDS.loadPerCpu;
      if (loadPerCpu1m >= t.critical) raise('critical');
      else if (loadPerCpu1m >= t.high) raise('high');
      else if (loadPerCpu1m >= t.elevated) raise('elevated');
      reasons.push(`load 1m ${loadAverage1m.toFixed(2)} over ${logicalCpuCount} CPU(s) = ${loadPerCpu1m.toFixed(2)} per CPU (elevated >= 1.5, high >= 3, critical >= 6)`);
    }
    if (level === 'nominal') reasons.push('every reported metric is below its elevated threshold');
  }

  return Object.freeze({
    level,
    memoryUsedPercent,
    loadAverage1m,
    logicalCpuCount,
    loadPerCpu1m,
    thresholds: PRESSURE_THRESHOLDS,
    basis: Object.freeze(reasons),
  });
}

function normaliseOverride(override) {
  if (override === undefined || override === null || override === 'auto') return 'auto';
  const numeric = typeof override === 'string' && override.trim() !== '' ? Number(override) : override;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > MAX_STAGE) return { invalid: String(override) };
  return numeric;
}

// The whole step-down reading: what the machine says, what the ladder does about it, and what an
// operator override would do instead. `effective` is the stage this reading resolves to - the auto
// stage on the server, or the operator's own choice when the client applies an override - and it is
// always one of the six declared stages rather than a number invented at the edge.
export function resolveStepDown({ telemetry = null, override = 'auto' } = {}) {
  const pressure = telemetry && typeof telemetry === 'object' && !telemetry.unavailable
    ? pressureFromTelemetry(telemetry)
    : Object.freeze({
      level: 'unknown',
      memoryUsedPercent: null,
      loadAverage1m: null,
      logicalCpuCount: null,
      loadPerCpu1m: null,
      thresholds: PRESSURE_THRESHOLDS,
      basis: Object.freeze([telemetry?.unavailable ? 'the ResourceFabric reported no telemetry' : 'no telemetry was supplied']),
    });
  const autoStage = STAGE_FOR_LEVEL[pressure.level] ?? 0;
  const chosen = normaliseOverride(override);
  const invalid = chosen && typeof chosen === 'object' ? chosen.invalid : null;
  const appliedStage = typeof chosen === 'number' ? chosen : autoStage;
  const applied = VISUAL_STAGES[appliedStage];

  return Object.freeze({
    schema: STEPDOWN_SCHEMA,
    at: null,
    auto: Object.freeze({
      stage: autoStage,
      level: pressure.level,
      source: pressure.level === 'unknown' ? 'telemetry-unavailable' : 'resource-fabric',
      pressure,
    }),
    override: Object.freeze({
      supported: true,
      applied: typeof chosen === 'number' ? chosen : 'auto',
      accepted: Object.freeze(['auto', ...VISUAL_STAGES.map((entry) => entry.stage)]),
      invalid: invalid === null ? null : invalid,
      note: 'the operator override is a presentation choice applied by the page; it changes no authorization and no record',
    }),
    effective: Object.freeze({
      stage: applied.stage,
      name: applied.name,
      tier: applied.tier,
      dropped: applied.dropped,
      layers: applied.layers,
      source: typeof chosen === 'number' ? 'override' : 'auto',
    }),
    stages: VISUAL_STAGES,
    flashGuard: FLASH_GUARD,
  });
}

// The sensor and privacy indicator. Every field is a reading of something the deployment really
// holds: the last perception reading supplies the host and git timestamps, the workspace
// configuration says whether a git sensor is wired at all, and `captureCapabilities` lists every
// registered capability whose name looks like audio or video capture - which must be empty, because
// APEX has none. If one were ever registered, this indicator would say so instead of hiding it.
export function sensorPrivacy({ perception = null, workspaceConfigured = false, registryNames = [] } = {}) {
  const reading = perception?.lastReading ?? null;
  const lastObservationAt = perception?.lastObservationAt ?? null;
  const hostAt = reading?.at ?? lastObservationAt;
  const workspace = reading?.workspace ?? null;
  const capture = (Array.isArray(registryNames) ? registryNames : [])
    .filter((name) => /^(audio|video|camera|microphone|mic|screen)\b/i.test(String(name)));

  const sensors = [
    Object.freeze({
      id: 'host-telemetry',
      label: 'Host telemetry: CPU, memory, storage and uptime',
      kind: 'read-only local sensor',
      active: true,
      readOnly: true,
      lastReadAt: hostAt,
      available: reading?.host !== undefined && reading?.host !== null,
      detail: hostAt === null
        ? 'no host reading has been recorded yet; use "Sense host now" in Sentinel'
        : `last reading recorded at ${hostAt}`,
    }),
    Object.freeze({
      id: 'git-workspace',
      label: 'Workspace git state: branch, HEAD, dirty and untracked counts',
      kind: 'read-only local sensor',
      active: workspaceConfigured === true,
      readOnly: true,
      lastReadAt: workspaceConfigured === true ? hostAt : null,
      available: workspace?.available === true,
      detail: workspaceConfigured !== true
        ? 'no workspace root is configured, so no git sensor runs'
        : workspace === null || workspace === undefined
          ? 'configured, and no reading has been recorded yet'
          : workspace.available === true
            ? `branch ${workspace.branch ?? 'detached'} at ${String(workspace.head ?? 'unknown').slice(0, 12)}`
            : `configured, and the last read could not be made: ${workspace.reason ?? 'reason not reported'}`,
    }),
  ];

  return Object.freeze({
    schema: SENSOR_SCHEMA,
    at: null,
    sensors: Object.freeze(sensors),
    privacy: Object.freeze({
      audio: Object.freeze({
        state: 'disabled',
        basis: 'no audio capture, wake-word or speech path is registered or configured; voice is out of scope',
      }),
      camera: Object.freeze({
        state: 'disabled',
        basis: 'no camera or screen capture capability is registered, and the page opens no media device',
      }),
      captureCapabilities: Object.freeze(capture),
      capturePossible: capture.length > 0,
    }),
    // One sentence the page can render without composing its own claim.
    statement: 'Local sensors are read-only; microphone and camera are disabled.',
    capturesNothing: capture.length === 0,
  });
}

// The block `/api/state` carries. It is one function so the route and the tests read the same shape,
// and so a caller cannot assemble half a ladder and call it a reading.
export function hudStatus({ telemetry = null, perception = null, workspaceConfigured = false, registryNames = [], now = () => new Date() } = {}) {
  const at = now().toISOString();
  return Object.freeze({
    schema: HUD_SCHEMA,
    at,
    stepDown: Object.freeze({ ...resolveStepDown({ telemetry }), at }),
    sensor: Object.freeze({ ...sensorPrivacy({ perception, workspaceConfigured, registryNames }), at }),
  });
}
