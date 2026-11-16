// Persistent runtime checkpoint. One small JSON document is replaced atomically under a writer
// lock. The document carries a checksum over its own content, so a truncated or hand-edited
// checkpoint is detected on the next start instead of being trusted. A damaged checkpoint is
// quarantined, never silently deleted, and the runtime reports that recovery lost its place.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { WriterLock } from '../memory/writer-lock.js';
import { StoreError } from '../errors.js';
import { DEFAULT_RUNTIME_CONFIG, RUNTIME_SCHEMA } from './vocabulary.js';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function checksumOf(state) {
  const { checksum, ...rest } = state;
  return digest(canonical(rest));
}

export function defaultRuntimeState({ now, idFactory = randomUUID } = {}) {
  const at = now().toISOString();
  return {
    schema: RUNTIME_SCHEMA,
    runtimeId: idFactory(),
    version: 1,
    lifecycle: 'stopped',
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    stoppedAt: null,
    boots: 0,
    paused: false,
    tickCount: 0,
    lastTickAt: null,
    config: { ...DEFAULT_RUNTIME_CONFIG, retry: { ...DEFAULT_RUNTIME_CONFIG.retry } },
    checkpoint: { published: [], processed: [], lastEventAt: null },
    schedules: [],
    retries: {},
    deadLetters: [],
    notifications: [],
    history: [],
    counts: { eventsProcessed: 0, decisionsMade: 0, plansExecuted: 0, retries: 0, deadLettered: 0 },
    checksum: '',
  };
}

function trim(list, max) {
  return list.length > max ? list.slice(list.length - max) : list;
}

function validStateShape(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 'runtime state must be an object';
  if (state.schema !== RUNTIME_SCHEMA) return `runtime schema must be ${RUNTIME_SCHEMA}`;
  if (typeof state.runtimeId !== 'string' || state.runtimeId.length < 4) return 'runtime identity is missing';
  if (!['stopped', 'starting', 'running', 'stopping'].includes(state.lifecycle)) return 'runtime lifecycle is not recognised';
  if (!state.checkpoint || !Array.isArray(state.checkpoint.published) || !Array.isArray(state.checkpoint.processed)) {
    return 'runtime checkpoint is not usable';
  }
  for (const field of ['schedules', 'deadLetters', 'notifications', 'history']) {
    if (!Array.isArray(state[field])) return `runtime ${field} is not a list`;
  }
  if (!state.retries || typeof state.retries !== 'object' || Array.isArray(state.retries)) return 'runtime retries are not usable';
  if (!state.config || typeof state.config !== 'object') return 'runtime config is not usable';
  return null;
}

export class RuntimeStateStore {
  constructor(dataDir, { now = () => new Date(), idFactory = randomUUID, lockWaitMs, lockRetryMs, lockRetryMaxMs } = {}) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'runtime.json');
    this.now = now;
    this.idFactory = idFactory;
    this.lock = new WriterLock(this.filePath, { waitMs: lockWaitMs, retryMs: lockRetryMs, retryMaxMs: lockRetryMaxMs });
  }

  async load() {
    let text;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return { state: defaultRuntimeState({ now: this.now, idFactory: this.idFactory }), fresh: true, corruption: null };
      throw new StoreError(`the runtime checkpoint could not be read: ${err?.message ?? String(err)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.#quarantine('the runtime checkpoint is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || parsed.checksum !== checksumOf(parsed)) {
      return this.#quarantine('the runtime checkpoint checksum does not match its content');
    }
    const shape = validStateShape(parsed);
    if (shape) return this.#quarantine(shape);
    return { state: parsed, fresh: false, corruption: null };
  }

  // The damaged file is preserved next to the checkpoint with a timestamp. It is not restored,
  // parsed, or merged: a checkpoint that failed its own integrity check cannot be trusted to name
  // which events were already processed.
  #quarantine(reason) {
    const at = this.now().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.dataDir, `runtime.corrupt-${at}.json`);
    try {
      fs.renameSync(this.filePath, target);
    } catch (err) {
      throw new StoreError(`the runtime checkpoint is damaged (${reason}) and could not be quarantined: ${err?.message ?? String(err)}`);
    }
    return {
      state: defaultRuntimeState({ now: this.now, idFactory: this.idFactory }),
      fresh: true,
      corruption: { reason, quarantinedAt: target },
    };
  }

  #write(state) {
    const next = {
      ...state,
      updatedAt: this.now().toISOString(),
      checkpoint: {
        ...state.checkpoint,
        published: trim(state.checkpoint.published, state.config.maxPublishedKeys ?? DEFAULT_RUNTIME_CONFIG.maxPublishedKeys),
        processed: trim(state.checkpoint.processed, state.config.maxProcessedIds ?? DEFAULT_RUNTIME_CONFIG.maxProcessedIds),
      },
      deadLetters: trim(state.deadLetters, state.config.maxDeadLetters ?? DEFAULT_RUNTIME_CONFIG.maxDeadLetters),
      notifications: trim(state.notifications, state.config.maxNotifications ?? DEFAULT_RUNTIME_CONFIG.maxNotifications),
      history: trim(state.history, state.config.maxHistory ?? DEFAULT_RUNTIME_CONFIG.maxHistory),
    };
    next.checksum = checksumOf(next);
    const tmp = `${this.filePath}.${process.pid}.${this.idFactory()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`, { encoding: 'utf8' });
    fs.renameSync(tmp, this.filePath);
    return next;
  }

  async save(state) {
    return this.lock.run(async () => this.#write(state));
  }

  async mutate(fn) {
    return this.lock.run(async () => {
      const loaded = await this.load();
      if (loaded.corruption) {
        // A corruption discovered inside a mutation is reported to the caller, which decides
        // whether to continue from a fresh checkpoint. It is never swallowed.
        const fresh = await fn(loaded.state, loaded);
        const written = this.#write(fresh);
        return { state: written, corruption: loaded.corruption };
      }
      const next = await fn(loaded.state, loaded);
      return { state: this.#write(next), corruption: null };
    });
  }

  async lockReport() {
    return this.lock.state();
  }

  async recover() {
    return this.lock.recover();
  }
}
