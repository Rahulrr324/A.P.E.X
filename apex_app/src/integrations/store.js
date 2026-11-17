// Persistent integration configuration, health and per-provider checkpoints. One bounded JSON
// document is replaced atomically under the existing writer lock. A checksum over the document makes
// a hand-edited or truncated file visible; such a file is quarantined rather than trusted. Loading is
// read-only, so opening the UI or listing providers creates no file and starts no polling.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { WriterLock } from '../memory/writer-lock.js';
import { StoreError } from '../errors.js';
import { canonical } from './model.js';
import { DEFAULT_CONFIG, INTEGRATION_SCHEMA } from './vocabulary.js';

function checksumOf(state) {
  const { checksum, ...rest } = state;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

export function defaultIntegrationState(now = () => new Date()) {
  return {
    schema: INTEGRATION_SCHEMA,
    version: 1,
    paused: false,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
    providers: {},
    checksum: '',
  };
}

function validShape(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 'integration state must be an object';
  if (state.schema !== INTEGRATION_SCHEMA) return `integration schema must be ${INTEGRATION_SCHEMA}`;
  if (typeof state.paused !== 'boolean') return 'integration paused flag is missing';
  if (!state.providers || typeof state.providers !== 'object' || Array.isArray(state.providers)) return 'provider state is not an object';
  for (const [id, provider] of Object.entries(state.providers)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(id)) return `provider id "${String(id).slice(0, 40)}" is not valid`;
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return `provider ${id} state is not an object`;
    if (typeof provider.enabled !== 'boolean') return `provider ${id} has no enabled flag`;
    if (!provider.config || typeof provider.config !== 'object') return `provider ${id} has no configuration`;
    if (!provider.health || typeof provider.health !== 'object') return `provider ${id} has no health record`;
    if (!provider.checkpoint || typeof provider.checkpoint !== 'object') return `provider ${id} has no checkpoint`;
  }
  return null;
}

export class IntegrationStore {
  constructor(dataDir, { now = () => new Date(), idFactory = randomUUID, lockWaitMs, lockRetryMs, lockRetryMaxMs } = {}) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'integrations.json');
    this.now = now;
    this.idFactory = idFactory;
    this.lock = new WriterLock(this.filePath, { waitMs: lockWaitMs, retryMs: lockRetryMs, retryMaxMs: lockRetryMaxMs });
  }

  async load() {
    let text;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return { state: defaultIntegrationState(this.now), fresh: true, corruption: null };
      throw new StoreError(`integration configuration could not be read: ${err?.message ?? String(err)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.#quarantine('integration configuration is not valid JSON');
    }
    if (!parsed || parsed.checksum !== checksumOf(parsed)) {
      return this.#quarantine('integration configuration checksum does not match its content');
    }
    const shape = validShape(parsed);
    if (shape) return this.#quarantine(shape);
    return { state: parsed, fresh: false, corruption: null };
  }

  #quarantine(reason) {
    const at = this.now().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.dataDir, `integrations.corrupt-${at}.json`);
    try {
      fs.renameSync(this.filePath, target);
    } catch (err) {
      throw new StoreError(`integration configuration is damaged (${reason}) and could not be quarantined: ${err?.message ?? String(err)}`);
    }
    return { state: defaultIntegrationState(this.now), fresh: true, corruption: { reason, quarantinedAt: target } };
  }

  #write(state) {
    const next = {
      ...state,
      schema: INTEGRATION_SCHEMA,
      version: 1,
      updatedAt: this.now().toISOString(),
    };
    next.checksum = checksumOf(next);
    const tmp = `${this.filePath}.${process.pid}.${this.idFactory()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`, 'utf8');
    fs.renameSync(tmp, this.filePath);
    return next;
  }

  async save(state) {
    return this.lock.run(async () => this.#write(state));
  }

  async mutate(fn) {
    return this.lock.run(async () => {
      const loaded = await this.load();
      const next = await fn(loaded.state, loaded);
      return { state: this.#write(next), corruption: loaded.corruption };
    });
  }
}

export { DEFAULT_CONFIG };
