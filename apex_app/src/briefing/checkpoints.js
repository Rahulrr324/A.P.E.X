// T-34 Step 3 (2026-11-19): briefing checkpoints and the honest delta.
//
// A briefing is only useful if the owner can tell what changed since the last time they read one.
// That requires a checkpoint: a record of what the briefing showed at the moment the owner
// acknowledged it. Two rules shape this module:
//
//   * The checkpoint is a *reading*, not a decision. It stores what the owning stores held - task
//     statuses, the advisories in force, the last observation time, how many verifications each lab had
//     recorded - and nothing the stores do not hold. Acknowledging changes nothing about the system.
//   * The delta is computed by comparing that reading with a fresh one. When there is no prior
//     checkpoint the delta says so in as many words - `No prior briefing checkpoint recorded — showing
//     full current state` - instead of pretending the whole state is a change.
//
// The store is append-only and lives in the isolated data directory, like every other record here.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const BRIEFING_CHECKPOINT_SCHEMA = 'apex.briefing.checkpoint/1';
export const NO_PRIOR_CHECKPOINT = 'No prior briefing checkpoint recorded — showing full current state';
const MAX_REASON_CHARS = 240;

function text(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

// The reading a checkpoint stores. Every field is derived from a store; none is a guess, and a store
// that could not be read contributes `null` rather than zero.
export function normalizeSnapshot(value) {
  const snapshot = value && typeof value === 'object' ? value : {};
  const statuses = (map) => {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    const out = {};
    for (const [key, status] of Object.entries(map)) {
      if (typeof key === 'string' && typeof status === 'string') out[key] = status;
    }
    return out;
  };
  const list = (items) => (Array.isArray(items) ? items.filter((item) => typeof item === 'string').sort() : null);
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  return {
    schema: BRIEFING_CHECKPOINT_SCHEMA,
    taskStatuses: statuses(snapshot.taskStatuses),
    taskCount: count(snapshot.taskCount),
    advisories: list(snapshot.advisories),
    lastObservationAt: typeof snapshot.lastObservationAt === 'string' ? snapshot.lastObservationAt : null,
    observedCount: count(snapshot.observedCount),
    runStatuses: statuses(snapshot.runStatuses),
    runCount: count(snapshot.runCount),
    workshopVerifications: count(snapshot.workshopVerifications),
    evolutionVerifications: count(snapshot.evolutionVerifications),
    unavailable: list(snapshot.unavailable),
  };
}

export class BriefingCheckpointStore {
  constructor(filePath, { now = () => new Date(), idFactory = randomUUID } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.idFactory = idFactory;
  }

  async #records() {
    try {
      const contents = await fsp.readFile(this.filePath, 'utf8');
      const out = [];
      for (const line of contents.split('\n')) {
        if (line.trim().length === 0) continue;
        try {
          const record = JSON.parse(line);
          if (record && record.schema === BRIEFING_CHECKPOINT_SCHEMA && typeof record.id === 'string') out.push(record);
        } catch {
          // A corrupt line is skipped, not repaired: the file is an account, not a state machine.
        }
      }
      return out;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async latest() {
    const records = await this.#records();
    return records.length === 0 ? null : records[records.length - 1];
  }

  async list({ limit = 20 } = {}) {
    const bounded = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 20;
    const records = await this.#records();
    return records.slice(-bounded).reverse();
  }

  async status() {
    const records = await this.#records();
    return {
      schema: BRIEFING_CHECKPOINT_SCHEMA,
      available: true,
      path: path.basename(this.filePath),
      total: records.length,
      latestAt: records.length === 0 ? null : records[records.length - 1].at ?? null,
    };
  }

  // Appends one checkpoint. The snapshot is taken by the caller from the owning stores; this method
  // does not read them, so a checkpoint can only ever record what the caller actually observed.
  async acknowledge({ by = 'owner', reason = null, snapshot = null } = {}) {
    const at = this.now().toISOString();
    const record = {
      schema: BRIEFING_CHECKPOINT_SCHEMA,
      kind: 'briefing_checkpoint',
      id: `bc-${this.idFactory().replace(/-/g, '').slice(0, 16)}`,
      at,
      by: text(by, 60) ?? 'owner',
      reason: text(reason, MAX_REASON_CHARS),
      snapshot: normalizeSnapshot(snapshot),
      // Reading a briefing is not a decision about the system: it authorizes nothing and changes no
      // store other than this log.
      authorizesExecution: false,
      appliesChanges: false,
    };
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }
}

// The delta between a checkpoint and the current reading. Items are the changes a reader needs, each
// naming where to look; they are never a story about what the change means. `available: false` with
// the honest sentence is the answer when nothing has been acknowledged yet.
export function briefingDelta({ prior = null, current = null } = {}) {
  if (!prior) {
    return {
      available: false,
      text: NO_PRIOR_CHECKPOINT,
      acknowledgedAt: null,
      checkpointId: null,
      items: [],
      counts: { tasks: 0, advisories: 0, observations: 0, workshop: 0, evolution: 0 },
      note: 'A checkpoint is written when the owner acknowledges a briefing; until then the whole current state is shown.',
    };
  }
  const now = normalizeSnapshot(current);
  const before = normalizeSnapshot(prior.snapshot ?? prior);
  const items = [];
  const push = (item) => items.push({ at: null, ...item });

  // Tasks: new, and every status that changed.
  const priorTasks = before.taskStatuses ?? {};
  const currentTasks = now.taskStatuses ?? {};
  for (const id of Object.keys(currentTasks).sort()) {
    const status = currentTasks[id];
    if (!(id in priorTasks)) {
      push({ kind: 'task_new', taskId: id, text: `task ${id} was created (${status})`, goto: { view: 'missions', task: id } });
    } else if (priorTasks[id] !== status) {
      push({ kind: 'task_status', taskId: id, text: `task ${id} moved from ${priorTasks[id]} to ${status}`, from: priorTasks[id], to: status, goto: { view: 'missions', task: id } });
    }
  }
  // Advisories that were not in force at the checkpoint.
  const priorAdvisories = new Set(before.advisories ?? []);
  for (const alertClass of now.advisories ?? []) {
    if (!priorAdvisories.has(alertClass)) push({ kind: 'advisory', text: `the Sentinel is now advising ${alertClass}`, alertClass, goto: { view: 'sentinel' } });
  }
  // A new host or workspace reading. The time is the reading's own, and only a later one counts.
  if (now.lastObservationAt && now.lastObservationAt !== before.lastObservationAt
    && (before.lastObservationAt === null || Date.parse(now.lastObservationAt) > Date.parse(before.lastObservationAt))) {
    push({ kind: 'observation', text: `the host was sensed again at ${now.lastObservationAt}`, goto: { view: 'sentinel' } });
  }
  // Verifications that have been recorded since.
  if ((now.workshopVerifications ?? 0) > (before.workshopVerifications ?? 0)) {
    push({ kind: 'workshop', text: `${(now.workshopVerifications ?? 0) - (before.workshopVerifications ?? 0)} workshop verification(s) recorded since the checkpoint`, goto: { view: 'workshop' } });
  }
  if ((now.evolutionVerifications ?? 0) > (before.evolutionVerifications ?? 0)) {
    push({ kind: 'evolution', text: `${(now.evolutionVerifications ?? 0) - (before.evolutionVerifications ?? 0)} evolution verification(s) recorded since the checkpoint`, goto: { view: 'system' } });
  }
  const counts = {
    tasks: items.filter((item) => item.kind === 'task_new' || item.kind === 'task_status').length,
    advisories: items.filter((item) => item.kind === 'advisory').length,
    observations: items.filter((item) => item.kind === 'observation').length,
    workshop: items.filter((item) => item.kind === 'workshop').length,
    evolution: items.filter((item) => item.kind === 'evolution').length,
  };
  const total = items.length;
  return {
    available: true,
    text: total === 0
      ? `Nothing has changed since the briefing you acknowledged at ${prior.at}`
      : `Changes since the briefing you acknowledged at ${prior.at}: ${Object.entries(counts).filter(([, value]) => value > 0).map(([key, value]) => `${value} ${key}`).join(', ')}`,
    acknowledgedAt: prior.at ?? null,
    checkpointId: prior.id ?? null,
    items,
    counts,
    note: 'A delta is a comparison of two readings; it states what changed, not what it means.',
  };
}

export function readCheckpointFile(filePath) {
  return fs.existsSync(filePath);
}
