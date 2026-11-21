// T-36 Step 1 (2026-11-21): the Workstation Bootstrap Service.
//
// A new, unseeded data directory is a real situation, not an error: the owner has installed APEX and
// has not run it yet. What the owner must not have to do is hand-build the first state of the
// system - enroll the machine, take the first reading, read the first briefing - before the deck
// can be trusted. This service performs that first pass, and nothing else.
//
// Four rules hold here, and each of them is a rule the browser can check:
//
//   1. Zero synthetic data. Every number in the report was read from this machine, this git
//      repository or these store files. There is no fixture task, no demo goal, no placeholder
//      mission. A value that could not be read is `null` and is reported as unavailable.
//   2. Fail closed. If the ECP lockdown latch is engaged, or its policy cannot be read, the
//      bootstrap halts at the first check and writes nothing. A locked-down APEX does not go
//      looking at the host.
//   3. Idempotent. Running it again refreshes the live readings and the doctor report; it does
//      not enroll a second primary device, and it does not write a second copy of a fact that is
//      already recorded.
//   4. The ECP is the only authority. The bootstrap is a registered write capability, so the
//      registry authorizes it, the control plane refuses it under lockdown, and the operation is
//      audited like every other write.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ValidationError } from '../errors.js';
import { HOST_SENSOR_SOURCE } from '../perception/host-workspace-sensor.js';

export const BOOTSTRAP_SCHEMA = 'apex.system.bootstrap/1';
export const BOOTSTRAP_MARKER_FILE = 'system-bootstrap.json';
export const LOCAL_WORKSTATION_DEVICE_ID = 'local-workstation';
export const BOOTSTRAP_CHECKS = Object.freeze([
  'doctor_readiness', 'host_workspace_perception', 'workstation_enrollment', 'executive_briefing',
]);
export const BOOTSTRAP_STATES = Object.freeze(['pass', 'degraded', 'failed', 'not_configured']);

// The World Model subject the sensor's facts hang from. The scheme is the provenance the world
// model's own vocabulary uses, so `host-workspace-sensor` is recorded as the source of the fact
// rather than as a note in free text.
export const SENSOR_ENTITY_ID = 'host-workspace-sensor';
export const SENSOR_ENTITY_SCHEME = 'host-workspace-sensor';

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

// The digest of a check is over the evidence it actually produced, not over its label. Two runs
// that read the same machine produce the same digest; a run that read a different machine does not.
function digestOf(value) {
  return sha256(canonical(value));
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function check(id, label, state, verified, detail, evidence = {}) {
  if (!BOOTSTRAP_STATES.includes(state)) throw new TypeError(`bootstrap check ${id} has an unknown state ${state}`);
  return { id, label, state, verified: verified === true, detail, evidence, digest: digestOf({ id, state, detail, evidence }) };
}

// The latch is read directly as well as through the doctor, because the doctor says what the latch
// is and this service has to decide whether to continue. An unreadable policy is treated as
// engaged: fail closed.
function latchState(ecp) {
  let status;
  try {
    status = ecp?.killSwitchStatus?.();
  } catch (err) {
    return { readable: false, active: true, reason: `the safety latch could not be read: ${err?.message || err}` };
  }
  if (!status || typeof status.active !== 'boolean') {
    return { readable: false, active: true, reason: 'the safety latch returned no readable state' };
  }
  if (status.policyUnavailable === true) {
    return { readable: false, active: true, reason: 'the latch policy file is unreadable, so every write is refused', status };
  }
  return { readable: true, active: status.active, reason: status.reason ?? null, status };
}

function workstationMetadata({ platform = process.platform, hostname = os.hostname() } = {}) {
  return {
    deviceId: LOCAL_WORKSTATION_DEVICE_ID,
    kind: 'workstation',
    hostname: typeof hostname === 'string' && hostname.length > 0 ? hostname.slice(0, 80) : 'unknown',
    platform: typeof platform === 'string' && platform.length > 0 ? platform.slice(0, 40) : 'unknown',
    arch: typeof process.arch === 'string' ? process.arch : 'unknown',
    capability: 'local-loopback',
    enrolledBy: 'system.bootstrap',
  };
}

export function createWorkstationBootstrap({
  app,
  dataDir = app?.dataDir ?? null,
  now = () => new Date(),
  doctor = null,
  hostname = os.hostname(),
  platform = process.platform,
} = {}) {
  if (!app || typeof app !== 'object') throw new TypeError('the workstation bootstrap needs a composed app');
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('the workstation bootstrap needs a data directory');
  const markerPath = path.join(dataDir, BOOTSTRAP_MARKER_FILE);

  // The marker is the record of the last completed pass. It is written only after every check has
  // run, so its presence means "this directory has been bootstrapped", and its absence means the
  // owner has not seen the deck yet.
  function status() {
    const marker = readJsonFile(markerPath);
    if (!marker || marker.schema !== BOOTSTRAP_SCHEMA) {
      return {
        schema: BOOTSTRAP_SCHEMA,
        bootstrapped: false,
        at: null,
        firstAt: null,
        runs: 0,
        markerPath,
        detail: 'this data directory has not been bootstrapped yet',
      };
    }
    return {
      schema: BOOTSTRAP_SCHEMA,
      bootstrapped: marker.bootstrapped === true,
      at: marker.at ?? null,
      firstAt: marker.firstAt ?? null,
      runs: Number.isInteger(marker.runs) ? marker.runs : 0,
      status: marker.status ?? null,
      markerPath,
      detail: marker.detail ?? null,
    };
  }

  const isBootstrapped = () => status().bootstrapped === true;

  // ---- check 1: doctor readiness -------------------------------------------------------------
  // Check 1 is a gate, not a score. It reads the doctor and asks one question: may this pass
  // proceed? The answer is the safety latch. The other five checks are reported, but they are not
  // what the gate turns on - a missing browser does not stop APEX from reading its own host.
  async function doctorReadiness() {
    if (!doctor || typeof doctor.run !== 'function') {
      return check('doctor_readiness', 'Safety Latch', 'not_configured', false,
        'the doctor is not configured, so readiness could not be read');
    }
    let report;
    try {
      report = await doctor.run();
    } catch (err) {
      return check('doctor_readiness', 'Safety Latch', 'failed', false,
        `the doctor could not run: ${err?.message || err}`);
    }
    const checks = Array.isArray(report?.checks) ? report.checks : [];
    const latch = checks.find((entry) => entry.name === 'safety_latch') ?? null;
    const passed = checks.filter((entry) => entry.state === 'pass').length;
    const failed = checks.some((entry) => entry.state === 'failed');
    return check('doctor_readiness', 'Safety Latch', failed ? 'failed' : 'pass', failed === false,
      `readiness gate: ${passed}/${checks.length} doctor check(s) passed; overall ${report?.status ?? 'unknown'}`,
      { report, passed, total: checks.length, latch: latch ? { state: latch.state, summary: latch.summary } : null });
  }

  // ---- check 2: real host and git workspace perception ----------------------------------------
  async function hostWorkspacePerception({ operationId = null, reason = null } = {}) {
    if (!app.perception || typeof app.perception.sense !== 'function') {
      return check('host_workspace_perception', 'Resource Fabric', 'not_configured', false,
        'the perception service is not configured, so the host was not read');
    }
    // The reading is taken through the controller, so the ECP authorizes it, the operation is
    // audited, and `perception.sense_host` is refused under lockdown by the same rule that refuses
    // every other write.
    const why = reason ?? 'workstation bootstrap: first real reading of this machine';
    let step = null;
    let audited = false;
    if (app.controller && typeof app.controller.perceptionSense === 'function') {
      // The controller's own command: it creates the operation, runs the capability through the
      // registry and the ECP, and writes the audit record. The reading is therefore a governed,
      // audited act and not a private call from inside another action.
      const command = await app.controller.perceptionSense({ reason: why });
      step = command?.operation?.steps?.[0] ?? null;
      audited = command?.operation !== null && command?.operation !== undefined;
    } else if (app.controller && typeof app.controller.runAction === 'function') {
      step = await app.controller.runAction(
        'perception.sense_host',
        { reason: why },
        'user',
        operationId ? `${operationId}:perception` : `bootstrap-perception-${Date.now()}`,
      );
    }
    const denied = step !== null && step.authorization?.decision !== 'allow';
    if (denied) {
      return check('host_workspace_perception', 'Resource Fabric', 'failed', false,
        `the host reading was refused by the control plane: ${step.authorization?.reason ?? 'denied'}`);
    }
    if (step !== null && step.outcome !== undefined && step.outcome !== 'success_verified'
      && step.authorization?.decision === 'allow') {
      return check('host_workspace_perception', 'Resource Fabric', 'failed', false,
        `the host reading was not verified: ${step.verification?.detail ?? step.summary ?? 'unknown'}`);
    }
    // The ledger is read with the full observation window, not with one entry: the question is how
    // many values the reading produced, and the last entry alone would answer a different one.
    const state = app.perception.state({ limit: 40 });
    const reading = state.lastReading;
    if (!reading) {
      return check('host_workspace_perception', 'Resource Fabric', 'degraded', false,
        'the host reading produced no record');
    }
    const workspace = reading.workspace ?? null;
    const observed = state.observations.filter((entry) => entry.epistemicStatus === 'observed');
    // The world model is told about what the sensor actually read. A value that is null is not
    // recorded at all: an unavailable reading is not a fact.
    const world = await recordSensorFacts({ reading, workspace, observed, at: reading.at });
    const verified = observed.length > 0;
    return check('host_workspace_perception', 'Resource Fabric', verified ? 'pass' : 'degraded', verified,
      `${observed.length} observed entr(ies) from ${HOST_SENSOR_SOURCE}; workspace ${workspace?.available ? `branch ${workspace.branch ?? '(none)'} at ${workspace.head ?? '(no head)'}` : `unavailable (${workspace?.reason ?? 'no reason recorded'})`}`,
      {
        reading,
        observed: observed.length,
        unavailable: state.unavailableCount,
        workspaceRoot: state.workspaceRoot ?? null,
        worldFacts: world,
        audited,
      });
  }

  // The World Model half of check 2. The subject is the sensor itself, and the facts hang from it
  // with the sensor's own scheme as their provenance. The write is idempotent: a fact that is
  // already recorded with the same value is left alone.
  async function recordSensorFacts({ reading, workspace, observed, at }) {
    const store = app.worldModel;
    if (!store || typeof store.state !== 'function' || typeof store.assertFact !== 'function') {
      return { recorded: [], entity: null, detail: 'the world model is not configured' };
    }
    const recorded = [];
    try {
      const state = await store.state();
      if (!state.entities.has(SENSOR_ENTITY_ID)) {
        await store.createEntity({
          origin: 'user',
          entityId: SENSOR_ENTITY_ID,
          category: 'device',
          name: 'Host and workspace sensor',
          aliases: [],
          description: 'Reads CPU, memory, storage and uptime of this machine and the git state of the configured workspace. Every fact it holds was read, not asserted.',
          externalIds: [{ scheme: SENSOR_ENTITY_SCHEME, value: SENSOR_ENTITY_ID }],
          observedAt: at ?? null,
          evidence: [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }],
        });
      }
      const facts = [
        workspace?.available === true
          ? { predicate: 'has_identifier', object: { kind: 'scalar', valueType: 'string', value: workspace.root } }
          : null,
        workspace?.available === true
          ? {
            predicate: 'described_as',
            object: {
              kind: 'scalar',
              valueType: 'string',
              value: `git branch ${workspace.branch ?? '(detached)'} at ${workspace.head ?? '(no head)'}`,
            },
          }
          : null,
        {
          // Only the machine's durable shape goes here: how many CPUs it has and how much memory.
          // The moving values - load, free memory, uptime, the dirty-file count - belong to the
          // perception ledger, which is a time series. Recording them as world-model facts would
          // make every refresh a new fact, and a world model that grows a fact a minute is a log
          // wearing the wrong hat.
          predicate: 'described_as',
          object: {
            kind: 'scalar',
            valueType: 'string',
            value: `${reading.host.cpu.logicalCount ?? 'unavailable'} logical CPUs, ${reading.host.memory.totalBytes ?? 'unavailable'} bytes of memory, ${platform} ${process.arch}`,
          },
        },
      ].filter((entry) => entry !== null);

      const existing = state.facts ? [...state.facts.values()] : [];
      for (const fact of facts) {
        const already = existing.some((entry) => entry.subjectId === SENSOR_ENTITY_ID
          && entry.predicate === fact.predicate
          && JSON.stringify(entry.object) === JSON.stringify(fact.object));
        if (already) continue;
        const { record } = await store.assertFact({
          origin: 'user',
          subjectId: SENSOR_ENTITY_ID,
          predicate: fact.predicate,
          object: fact.object,
          validFrom: at ?? null,
          observedAt: at ?? null,
          confidence: { value: 1, basis: 'read directly from the machine by the host and workspace sensor' },
          evidence: [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }],
        });
        recorded.push({ factId: record.factId, predicate: record.predicate, source: SENSOR_ENTITY_SCHEME });
      }
      return { recorded, entity: SENSOR_ENTITY_ID, detail: `${recorded.length} fact(s) recorded` };
    } catch (err) {
      // A world-model write that could not be made does not fail the bootstrap: the reading itself
      // is in the perception ledger, and the report says the world-model half did not happen.
      return { recorded: [], entity: SENSOR_ENTITY_ID, detail: `the world-model facts could not be recorded: ${err?.message || err}` };
    }
  }

  // ---- check 3: the local workstation device --------------------------------------------------
  async function workstationEnrollment() {
    const trust = app.deviceTrust;
    if (!trust || typeof trust.list !== 'function' || typeof trust.enroll !== 'function') {
      return check('workstation_enrollment', 'Device Trust', 'not_configured', false,
        'the device trust registry is not configured, so no device was enrolled');
    }
    const devices = await trust.list();
    const existing = devices.find((device) => device.deviceId === LOCAL_WORKSTATION_DEVICE_ID);
    if (existing) {
      // Idempotency: the primary workstation is enrolled once. A second bootstrap does not enroll a
      // second device and does not re-enroll the one that is already there.
      return check('workstation_enrollment', 'Device Trust', 'pass', true,
        `the local workstation is already enrolled as ${existing.deviceId} (${existing.status})`,
        { deviceId: existing.deviceId, label: existing.label, status: existing.status, enrolledAt: existing.enrolledAt, alreadyEnrolled: true, total: devices.length });
    }
    if (devices.length > 0) {
      // The owner has enrolled their own devices. The machine is not enrolled behind their back.
      return check('workstation_enrollment', 'Device Trust', 'not_configured', false,
        `${devices.length} device(s) are already enrolled, so the local workstation was not enrolled automatically`,
        { alreadyEnrolled: false, total: devices.length });
    }
    const metadata = workstationMetadata({ platform, hostname });
    const enrolled = await trust.enroll({
      origin: 'user',
      label: `${metadata.hostname} (${metadata.platform})`,
      deviceId: LOCAL_WORKSTATION_DEVICE_ID,
      metadata,
    });
    const readBack = await trust.get(LOCAL_WORKSTATION_DEVICE_ID);
    if (!readBack) {
      return check('workstation_enrollment', 'Device Trust', 'failed', false,
        'the local workstation was enrolled but cannot be read back');
    }
    return check('workstation_enrollment', 'Device Trust', 'pass', true,
      `the local workstation was enrolled as ${readBack.deviceId} (${readBack.status})`,
      {
        deviceId: readBack.deviceId,
        label: readBack.label,
        status: readBack.status,
        enrolledAt: readBack.enrolledAt,
        metadata: readBack.metadata ?? metadata,
        alreadyEnrolled: false,
        total: 1,
        secretShownOnce: enrolled?.secretShownOnce === true,
      });
  }

  // ---- check 4: the opening executive briefing ------------------------------------------------
  async function executiveBriefing({ doctorReport = null, reading = null, device = null } = {}) {
    const telemetry = await readTelemetry();
    const workspace = reading?.workspace ?? null;
    const facts = [];
    const inferred = [];
    const at = now().toISOString();

    if (doctorReport) {
      facts.push({ kind: 'doctor', text: `doctor ${doctorReport.status}: ${doctorReport.counts.pass}/${doctorReport.checks.length} check(s) passed`, status: doctorReport.status });
    }
    if (telemetry) {
      facts.push({
        kind: 'resource',
        text: `${telemetry.cpu.logicalCount ?? 'unavailable'} logical CPUs, load 1m ${telemetry.cpu.loadAverage1m ?? 'unavailable'}, `
          + `${Math.round((telemetry.memory.freeBytes ?? 0) / 1048576)}/${Math.round((telemetry.memory.totalBytes ?? 0) / 1048576)} MB free`,
        status: 'observed',
      });
    }
    if (workspace?.available === true) {
      facts.push({ kind: 'workspace', text: `git ${workspace.branch ?? '(detached)'} at ${workspace.head ?? '(no head)'}`, status: 'observed' });
    } else {
      facts.push({ kind: 'workspace', text: `the workspace could not be read (${workspace?.reason ?? 'no reason recorded'})`, status: 'unavailable' });
    }
    if (device?.deviceId) {
      facts.push({ kind: 'device', text: `the local workstation is enrolled as ${device.deviceId}`, status: device.status ?? 'trusted' });
    }
    if (doctorReport && doctorReport.counts.degraded > 0) {
      inferred.push({ kind: 'degraded_subsystem', text: `${doctorReport.counts.degraded} doctor check(s) are degraded; the deck is not claiming a healthy machine.`, basis: 'doctor counts' });
    }

    const briefing = {
      schema: 'apex.briefing.v1',
      generatedAt: at,
      concise: [
        `Doctor: ${doctorReport ? `${doctorReport.counts.pass}/${doctorReport.checks.length} ok (${doctorReport.status})` : 'unavailable'}`,
        `Host: ${telemetry ? `${telemetry.cpu.logicalCount ?? '?'} CPU` : 'unavailable'}`,
        `Workspace: ${workspace?.available === true ? `${workspace.branch ?? 'detached'} @ ${workspace.head ?? '?'}` : 'unavailable'}`,
        `Device: ${device?.deviceId ?? 'none enrolled'}`,
      ].join(' | '),
      facts,
      inferred,
      counts: { facts: facts.length, inferred: inferred.length },
      note: 'The opening briefing is assembled from the doctor report, the Resource Fabric telemetry and the git workspace reading. Every line names the source it came from; nothing here is a placeholder.',
      verified: doctorReport !== null && telemetry !== null,
    };
    return check('executive_briefing', 'Executive Briefing', briefing.verified ? 'pass' : 'degraded', briefing.verified,
      briefing.concise, { briefing });
  }

  async function readTelemetry() {
    const fabric = app.resources;
    if (!fabric || typeof fabric.telemetry !== 'function') return null;
    try {
      return await fabric.telemetry({ storagePaths: [dataDir] });
    } catch {
      return null;
    }
  }

  // ---- the pass itself --------------------------------------------------------------------------
  async function run({ reason = null, force = false } = {}) {
    const at = now().toISOString();
    const before = status();
    const checks = [];
    const latch = latchState(app.ecp);

    // Check 1 first, and it is a gate: a locked-down or unreadable latch halts the pass here. No
    // host reading, no device enrollment, no briefing, no marker.
    const readiness = await doctorReadiness();
    checks.push(readiness);
    const latchCheck = readiness.evidence?.latch ?? null;
    const latchActive = latch.active === true;
    const latchUnreadable = latch.readable !== true;
    if (latchActive || latchUnreadable) {
      const failed = check('doctor_readiness', 'Safety Latch', 'failed', false,
        latchUnreadable
          ? `the safety latch could not be read, so the bootstrap halted fail-closed: ${latch.reason}`
          : `lockdown is engaged, so the bootstrap halted fail-closed${latch.reason ? `: ${latch.reason}` : ''}`,
        { latch: latch.status ?? null, reason: latch.reason ?? null, halted: true });
      checks[0] = failed;
      return report({
        at,
        checks,
        status: latchUnreadable ? 'degraded' : 'lockdown',
        verified: false,
        marker: null,
        detail: latchUnreadable
          ? 'the safety latch could not be read; the bootstrap wrote nothing'
          : 'lockdown is engaged; the bootstrap wrote nothing',
        firstRun: before.runs === 0,
        idempotent: before.bootstrapped === true,
        reason,
        force,
      });
    }

    const perception = await hostWorkspacePerception({ reason });
    checks.push(perception);
    const enrollment = await workstationEnrollment();
    checks.push(enrollment);

    // The doctor is read a second time, after the pass has written its ledger and enrolled the
    // workstation, so the report describes the machine as it is now rather than as it was before the
    // bootstrap ran. The first read was the gate; this one is the statement the briefing is built
    // from.
    let finalReport = readiness.evidence?.report ?? null;
    if (doctor && typeof doctor.run === 'function') {
      try {
        finalReport = await doctor.run();
      } catch {
        // A doctor that cannot be read a second time leaves the gate reading in place; the report
        // says which one it is carrying.
        finalReport = readiness.evidence?.report ?? null;
      }
    }
    const doctorReport = finalReport;

    const briefing = await executiveBriefing({
      doctorReport,
      reading: perception.evidence?.reading ?? null,
      device: enrollment.evidence?.deviceId ? enrollment.evidence : null,
    });
    checks.push(briefing);

    const failed = checks.filter((entry) => entry.state === 'failed');
    const degraded = checks.filter((entry) => entry.state === 'degraded' || entry.state === 'not_configured');
    const verified = checks.every((entry) => entry.verified === true);
    // Named `overall` and not `status`: the marker reader in this scope is called `status`, and a
    // local of the same name would shadow it before its own declaration.
    const doctorDegraded = finalReport ? finalReport.status !== 'ok' : true;
    const overall = failed.length > 0 ? 'failed'
      : degraded.length > 0 || doctorDegraded ? 'degraded' : 'ok';

    // The marker is written when the pass ran to the end, whatever its state. A degraded bootstrap
    // still happened, and the next run refreshes it.
    const marker = {
      schema: BOOTSTRAP_SCHEMA,
      bootstrapped: true,
      at,
      firstAt: before.firstAt ?? at,
      runs: before.runs + 1,
      status: overall,
      verified,
      detail: `${checks.filter((entry) => entry.verified).length}/${checks.length} check(s) verified`,
      checks: checks.map((entry) => ({ id: entry.id, label: entry.label, state: entry.state, verified: entry.verified, digest: entry.digest, detail: entry.detail })),
      doctor: finalReport
        ? { status: finalReport.status, passed: finalReport.counts.pass, total: finalReport.checks.length, withinBudget: finalReport.withinBudget }
        : null,
      device: enrollment.evidence?.deviceId ? {
        deviceId: enrollment.evidence.deviceId,
        label: enrollment.evidence.label ?? null,
        status: enrollment.evidence.status ?? null,
        enrolledAt: enrollment.evidence.enrolledAt ?? null,
      } : null,
      workspace: perception.evidence?.reading?.workspace
        ? {
          root: perception.evidence.reading.workspace.root ?? null,
          branch: perception.evidence.reading.workspace.branch ?? null,
          head: perception.evidence.reading.workspace.head ?? null,
        }
        : null,
      readingAt: perception.evidence?.reading?.at ?? null,
    };
    try {
      writeJsonFile(markerPath, marker);
    } catch (err) {
      marker.writeError = err?.message || String(err);
    }
    return report({
      at,
      checks,
      status: overall,
      verified,
      marker,
      detail: marker.detail,
      firstRun: before.runs === 0,
      idempotent: before.bootstrapped === true,
      reason,
      force,
      doctorReport: finalReport,
      doctorGate: readiness.evidence?.report ?? null,
    });
  }

  function report({ at, checks, status, verified, marker, detail, firstRun, idempotent, reason, force, doctorReport = null, doctorGate = null }) {
    return {
      schema: BOOTSTRAP_SCHEMA,
      at,
      status,
      verified,
      detail,
      firstRun,
      idempotent,
      forced: force === true,
      reason: reason ?? null,
      order: BOOTSTRAP_CHECKS,
      checks,
      doctor: doctorReport ?? checks.find((entry) => entry.id === 'doctor_readiness')?.evidence?.report ?? null,
      doctorGate: doctorGate ?? checks.find((entry) => entry.id === 'doctor_readiness')?.evidence?.report ?? null,
      perception: checks.find((entry) => entry.id === 'host_workspace_perception')?.evidence ?? null,
      device: checks.find((entry) => entry.id === 'workstation_enrollment')?.evidence ?? null,
      briefing: checks.find((entry) => entry.id === 'executive_briefing')?.evidence?.briefing ?? null,
      marker: marker === null ? null : {
        path: markerPath,
        at: marker.at,
        firstAt: marker.firstAt,
        runs: marker.runs,
        status: marker.status,
        writeError: marker.writeError ?? null,
      },
      note: 'A workstation bootstrap reads this machine and this repository. It creates no task, no goal and no mission, and it enrols the local workstation only when the owner has enrolled no device at all.',
    };
  }

  return Object.freeze({
    schema: BOOTSTRAP_SCHEMA,
    markerPath,
    run,
    status,
    isBootstrapped,
    checks: BOOTSTRAP_CHECKS,
  });
}
