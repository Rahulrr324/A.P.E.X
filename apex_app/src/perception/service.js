// T-32 Step 3 (2026-11-19): the perception service.
//
// It owns three things and nothing else:
//   1. the observation ledger — every reading the host/workspace sensor makes, one line each, with
//      its own timestamp, source and epistemic status;
//   2. the push governor — the Sentinel's 3-per-hour, deduplicated, dismissible notice discipline;
//   3. the suppression rules the owner can see and revoke.
//
// It is read-only with respect to the machine: the only file it writes is its own ledger inside the
// APEX data directory. A reading that could not be taken is recorded as `unavailable`, never as a
// zero, and the state it serves carries the reason.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHostWorkspaceSensor, HOST_SENSOR_SCHEMA, HOST_SENSOR_SOURCE } from './host-workspace-sensor.js';
import { PushGovernor, PUSH_GOVERNOR_SCHEMA } from './push-governor.js';
import { ADVISORY_RULES, deriveAdvisories, deliverAdvisories } from './advisories.js';

export const PERCEPTION_SCHEMA = 'apex.perception.view/1';
export const OBSERVATION_SCHEMA = 'apex.perception.observation/1';
export const PERCEPTION_LEDGER_DIR = 'perception';
export const OBSERVATION_READ_LIMIT = 40;
export const OBSERVATION_LEDGER_LIMIT = 2_000;

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export function createPerceptionService({
  dataDir,
  now = () => new Date(),
  idFactory = randomUUID,
  workspaceDir = null,
  sensor = null,
  governor = null,
  storagePaths = null,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('the perception service needs a data directory');
  const directory = path.join(dataDir, PERCEPTION_LEDGER_DIR);
  const ledgerPath = path.join(directory, 'observations.jsonl');
  const governorPath = path.join(directory, 'governor.json');

  const hostSensor = sensor ?? createHostWorkspaceSensor({
    now,
    workspaceDir,
    storagePaths: storagePaths ?? (workspaceDir ? [workspaceDir, dataDir] : [dataDir]),
  });
  const pushGovernor = governor ?? new PushGovernor({ now });
  const loadedGovernor = readJsonFile(governorPath);
  if (loadedGovernor) pushGovernor.load(loadedGovernor);

  let observations = [];
  let lastReading = null;
  // T-33 Step 1: what the last reading implied, and what the governor decided about each of those
  // implications. Both are read-only projections of work already recorded.
  let lastAdvisories = Object.freeze([]);
  let lastDeliveries = Object.freeze([]);

  // The tail is read once at construction; appends keep the in-memory view current without
  // re-reading a file that only this process writes.
  try {
    if (fs.existsSync(ledgerPath)) {
      const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
      for (const line of lines.slice(-OBSERVATION_LEDGER_LIMIT * 2)) {
        try {
          observations.push(JSON.parse(line));
        } catch {
          // A corrupt line is skipped, not repaired: the ledger is an account, not a state machine.
        }
      }
      const latest = [...observations].reverse().find((entry) => entry?.reading === true);
      lastReading = latest?.detail?.reading ?? latest?.snapshot ?? null;
    }
  } catch {
    observations = [];
  }

  // Reading perception creates nothing: the directory appears only when a reading or a rule is
  // actually written, so a fresh data directory stays empty until the owner senses something.
  function ensureDirectory() {
    fs.mkdirSync(directory, { recursive: true });
  }

  function persistGovernor() {
    ensureDirectory();
    writeJsonFile(governorPath, { schema: PUSH_GOVERNOR_SCHEMA, ...pushGovernor.toJSON() });
  }

  function append(entries) {
    if (entries.length === 0) return;
    ensureDirectory();
    const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
    fs.appendFileSync(ledgerPath, lines);
    observations.push(...entries);
    if (observations.length > OBSERVATION_LEDGER_LIMIT) observations = observations.slice(-OBSERVATION_LEDGER_LIMIT);
  }

  // One governed sensing pass: the reading, the entries it produced, and the ledger reference for
  // each. The reading itself is also stored, so the deck can show the machine as it was read.
  function sense({ reason = null } = {}) {
    const { reading, entries } = hostSensor.observe();
    const at = reading.at;
    const recorded = entries.map((entry) => Object.freeze({
      schema: OBSERVATION_SCHEMA,
      id: idFactory(),
      at: entry.at,
      subject: entry.subject,
      value: entry.value,
      unit: entry.unit,
      detail: entry.detail,
      source: HOST_SENSOR_SOURCE,
      epistemicStatus: entry.epistemicStatus,
      sensorSchema: HOST_SENSOR_SCHEMA,
      reason,
    }));
    append([
      ...recorded,
      Object.freeze({
        schema: OBSERVATION_SCHEMA,
        id: idFactory(),
        at,
        subject: 'host.reading',
        value: recorded.length,
        unit: 'observations',
        detail: { reading },
        source: HOST_SENSOR_SOURCE,
        epistemicStatus: 'observed',
        sensorSchema: HOST_SENSOR_SCHEMA,
        reading: true,
        reason,
      }),
    ]);
    lastReading = reading;
    // T-33 Step 1: a reading is also an occasion. The Sentinels' advisories are derived from what was
    // just read and handed to the governor, which decides what may be delivered. Nothing is pushed
    // here that the governor did not admit, and the same unchanged machine deduplicates.
    lastAdvisories = deriveAdvisories(reading);
    lastDeliveries = deliverAdvisories(pushGovernor, lastAdvisories, { at });
    if (lastAdvisories.length > 0) persistGovernor();
    return Object.freeze({
      reading,
      observations: Object.freeze(recorded),
      recorded: recorded.length,
      at,
      advisories: lastAdvisories,
      deliveries: lastDeliveries,
    });
  }

  function recentObservations(limit = OBSERVATION_READ_LIMIT) {
    const bounded = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), OBSERVATION_READ_LIMIT) : OBSERVATION_READ_LIMIT;
    return observations.filter((entry) => entry?.reading !== true).slice(-bounded).reverse();
  }

  function state({ limit = OBSERVATION_READ_LIMIT } = {}) {
    return Object.freeze({
      schema: PERCEPTION_SCHEMA,
      at: now().toISOString(),
      source: HOST_SENSOR_SOURCE,
      workspaceRoot: hostSensor.workspaceDir ?? workspaceDir ?? null,
      lastReading: lastReading ?? null,
      lastObservationAt: observations.at(-1)?.at ?? null,
      observations: recentObservations(limit),
      observedCount: observations.filter((entry) => entry?.epistemicStatus === 'observed' && entry?.reading !== true).length,
      unavailableCount: observations.filter((entry) => entry?.epistemicStatus === 'unavailable').length,
      governor: pushGovernor.snapshot(),
      // T-34 Step 3: the watch rules themselves - their thresholds, the last signature each raised, how
      // often each has fired and when it last did - read out of the governor's own admissions.
      watches: pushGovernor.watchReport({ rules: ADVISORY_RULES }),
      // T-33 Step 1: the advisories the last reading implied, what the governor decided about each,
      // and which of them are suppressed right now. A suppressed class is reported as suppressed
      // rather than as absent, so the owner can see the rule doing its work and revoke it.
      alerts: Object.freeze({
        advisories: lastAdvisories,
        deliveries: lastDeliveries,
        active: lastDeliveries.filter((entry) => entry.admitted === true),
        suppressions: pushGovernor.activeSuppressions(),
        policy: Object.freeze({
          limitPerHour: pushGovernor.limit,
          dismissalsToSuppress: pushGovernor.dismissalsToSuppress,
          suppressionTtlMs: pushGovernor.suppressionTtlMs,
          criticalBypassesCap: true,
        }),
      }),
    });
  }

  function push(options = {}) {
    const decision = pushGovernor.admit(options);
    persistGovernor();
    return decision;
  }

  function dismiss(options = {}) {
    const result = pushGovernor.dismiss(options);
    persistGovernor();
    return result;
  }

  function revoke(ruleId, options = {}) {
    const result = pushGovernor.revoke(ruleId, options);
    persistGovernor();
    return result;
  }

  return Object.freeze({
    schema: PERCEPTION_SCHEMA,
    source: HOST_SENSOR_SOURCE,
    ledgerPath,
    governor,
    sensor: hostSensor,
    sense,
    state,
    push,
    dismiss,
    revoke,
    advisories: () => lastAdvisories,
    observations: () => recentObservations(),
  });
}
