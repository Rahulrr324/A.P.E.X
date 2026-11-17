// The integration fabric. It owns provider configuration, permissions, health and checkpoints, and
// it is the only component that turns a provider result into situational events. Polling is explicit
// or driven by the T-10 runtime tick; constructing the fabric or listing sources contacts nothing.
//
// One provider failure is contained: its retry/backoff state is updated and other providers are still
// polled. Ingested observations use the existing `situation.ingest` contract, so source identity,
// fingerprints, replay refusal, world-model writes, significance, notification cooldown and the
// runtime's queue/checkpoint are the existing T-09/T-10 mechanisms, not a second pipeline.
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '../security/secrets.js';
import { ValidationError } from '../errors.js';
import { IntegrationStore } from './store.js';
import { createProviderRegistry } from './registry.js';
import { DEFAULT_COMMON_CONFIG, LIMITS, SOURCE } from './vocabulary.js';
import {
  canonical, hash, mergeCommon, normalizeObservation, wireSourceId,
} from './model.js';

const MAX_HISTORY = 20;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freshHealth() {
  return {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
    polls: 0,
    observed: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    durationMs: null,
    nextAttemptAt: null,
    exhausted: false,
    outageStartedAt: null,
    lastMetrics: null,
    recent: [],
    errors: [],
  };
}

function freshEntry(provider) {
  return {
    enabled: false,
    config: mergeCommon({ ...clone(provider.defaults), retry: { ...DEFAULT_COMMON_CONFIG.retry } }, {}),
    checkpoint: {},
    scope: null,
    history: [],
    health: freshHealth(),
  };
}

function nowIso(now) {
  return now().toISOString();
}

function safeError(error) {
  return redactSecrets(String(error?.message ?? error)).slice(0, 300);
}

function retryDelay(attempts, config) {
  return Math.min(24 * 60 * 60 * 1000, config.retry.baseDelayMs * 2 ** Math.max(0, attempts - 1));
}

export class IntegrationFabric {
  constructor({
    dataDir, situation, worldModel = null, now = () => new Date(), idFactory = randomUUID,
    providers = null, fetchImpl = globalThis.fetch, lockWaitMs, lockRetryMs, lockRetryMaxMs,
  } = {}) {
    if (!dataDir) throw new TypeError('IntegrationFabric requires a data directory');
    if (!situation || typeof situation.ingest !== 'function') throw new TypeError('IntegrationFabric requires the situational service');
    this.dataDir = dataDir;
    this.situation = situation;
    this.worldModel = worldModel;
    this.now = now;
    this.idFactory = idFactory;
    this.fetchImpl = fetchImpl;
    this.registry = createProviderRegistry(providers ?? undefined);
    this.store = new IntegrationStore(dataDir, { now, idFactory, lockWaitMs, lockRetryMs, lockRetryMaxMs });
    this.inFlight = new Map();
    this.lastCorruption = null;
    // No provider is constructed with a live connection, and nothing here polls.
  }

  async #load() {
    const loaded = await this.store.load();
    this.lastCorruption = loaded.corruption ?? null;
    const state = loaded.state;
    for (const provider of this.registry.providers.values()) {
      if (!state.providers[provider.id]) state.providers[provider.id] = freshEntry(provider);
      const entry = state.providers[provider.id];
      entry.health = { ...freshHealth(), ...(entry.health ?? {}) };
      entry.config = mergeCommon({ ...clone(provider.defaults), ...(entry.config ?? {}), retry: { ...DEFAULT_COMMON_CONFIG.retry, ...(entry.config?.retry ?? {}) } }, {});
      entry.history = Array.isArray(entry.history) ? entry.history : [];
      entry.checkpoint = entry.checkpoint && typeof entry.checkpoint === 'object' ? entry.checkpoint : {};
      entry.scope = entry.scope ?? null;
    }
    return { state, corruption: loaded.corruption };
  }

  async #save(state) {
    return this.store.save(state);
  }

  // A poll holds an in-memory copy of its provider entry. Persist only the fields a poll owns, so a
  // concurrent disable/configure cannot be overwritten by a slow fetch finishing afterwards.
  async #persistProvider(id, entry) {
    await this.store.mutate((state) => {
      const target = this.#entry(state, id);
      target.health = entry.health;
      target.checkpoint = entry.checkpoint;
      return state;
    });
  }

  #entry(state, id) {
    const provider = this.registry.get(id);
    if (!state.providers[id]) state.providers[id] = freshEntry(provider);
    return state.providers[id];
  }

  #nextPollAt(entry) {
    if (!entry.enabled) return null;
    if (entry.health.exhausted) return null;
    if (entry.health.nextAttemptAt) return entry.health.nextAttemptAt;
    if (!entry.health.lastAttemptAt) return null;
    return new Date(Date.parse(entry.health.lastAttemptAt) + entry.config.intervalMs).toISOString();
  }

  #record(entry, row) {
    entry.health.recent.push(row);
    if (entry.health.recent.length > LIMITS.maxRecent) entry.health.recent = entry.health.recent.slice(-LIMITS.maxRecent);
  }

  #recordError(entry, message, at) {
    entry.health.errors.push({ at, error: message.slice(0, 300) });
    if (entry.health.errors.length > LIMITS.maxErrors) entry.health.errors = entry.health.errors.slice(-LIMITS.maxErrors);
  }

  list() {
    return this.registry.list();
  }

  async status() {
    const { state, corruption } = await this.#load();
    const providers = [...this.registry.providers.values()].map((provider) => {
      const entry = state.providers[provider.id];
      return {
        id: provider.id,
        name: provider.name,
        kind: provider.describe().kind,
        apiVersion: provider.apiVersion,
        permissions: [...provider.permissions],
        enabled: entry.enabled === true,
        config: clone(entry.config),
        scope: entry.scope,
        health: clone(entry.health),
        checkpoint: {
          keys: Object.keys(entry.checkpoint ?? {}).length,
          lastPollAt: entry.checkpoint?.lastPollAt ?? entry.checkpoint?.lastScanAt ?? entry.checkpoint?.lastFetchAt ?? null,
        },
        nextPollAt: state.paused ? null : this.#nextPollAt(entry),
        history: entry.history.slice(-5),
      };
    });
    return {
      at: nowIso(this.now),
      paused: state.paused === true,
      schema: state.schema,
      version: state.version,
      corruption,
      providers,
      running: this.inFlight.size > 0,
      inFlight: [...this.inFlight.keys()],
      enabled: providers.filter((provider) => provider.enabled).length,
      totals: providers.reduce((sum, provider) => ({
        observed: sum.observed + provider.health.observed,
        accepted: sum.accepted + provider.health.accepted,
        duplicates: sum.duplicates + provider.health.duplicates,
        rejected: sum.rejected + provider.health.rejected,
      }), { observed: 0, accepted: 0, duplicates: 0, rejected: 0 }),
    };
  }

  async summary() {
    const state = await this.status();
    return {
      paused: state.paused,
      enabled: state.enabled,
      running: state.running,
      totals: state.totals,
      providers: state.providers.map((provider) => ({
        id: provider.id,
        enabled: provider.enabled,
        lastSuccessAt: provider.health.lastSuccessAt,
        lastError: provider.health.lastError,
        nextPollAt: provider.nextPollAt,
      })),
    };
  }

  async configure(id, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError('configuration must be an object');
    const provider = this.registry.get(id);
    const { state } = await this.#load();
    const entry = this.#entry(state, id);
    for (const key of Object.keys(patch)) {
      if (!(key in entry.config)) throw new ValidationError(`provider ${id} has no configuration field "${String(key).slice(0, 40)}"`);
    }
    const nextConfig = provider.validate({ ...entry.config, ...patch });
    if (nextConfig.entityId && this.worldModel) {
      let view;
      try {
        view = await this.worldModel.showEntity(nextConfig.entityId);
      } catch (err) {
        throw new ValidationError(`entity ${nextConfig.entityId} cannot be checked: ${err?.message ?? String(err)}`);
      }
      if (!view || view.problem) throw new ValidationError(`entity ${nextConfig.entityId} cannot be used: ${view?.problem ?? 'not found'}`);
    }
    const nextScope = typeof provider.scopeOf === 'function' ? provider.scopeOf(nextConfig) : null;
    const scopeChanged = entry.scope !== null && nextScope !== entry.scope;
    entry.config = nextConfig;
    entry.scope = nextScope;
    if (scopeChanged) {
      entry.checkpoint = {};
      entry.history.push({ type: 'scope_changed', at: nowIso(this.now), reason: 'the configured scope changed, so the old checkpoint was invalidated' });
      entry.history = entry.history.slice(-MAX_HISTORY);
    }
    await this.#save(state);
    return { id, config: clone(entry.config), checkpointReset: scopeChanged };
  }

  async enable(id) {
    const provider = this.registry.get(id);
    const { state } = await this.#load();
    const entry = this.#entry(state, id);
    const validated = provider.validate(entry.config);
    if (id === 'external_service' && !validated.endpoint) {
      throw new ValidationError('external_service needs an endpoint and an allowlist before it can be enabled');
    }
    if (validated.entityId && this.worldModel) {
      const view = await this.worldModel.showEntity(validated.entityId).catch((err) => ({ problem: err?.message }));
      if (!view || view.problem) throw new ValidationError(`entity ${validated.entityId} cannot be used: ${view?.problem ?? 'not found'}`);
    }
    entry.config = validated;
    entry.enabled = true;
    entry.health.exhausted = false;
    entry.health.nextAttemptAt = null;
    entry.history.push({ type: 'enabled', at: nowIso(this.now) });
    await this.#save(state);
    return { id, enabled: true, permissions: [...provider.permissions] };
  }

  async disable(id) {
    const { state } = await this.#load();
    const entry = this.#entry(state, id);
    entry.enabled = false;
    entry.health.nextAttemptAt = null;
    entry.history.push({ type: 'disabled', at: nowIso(this.now) });
    const controller = this.inFlight.get(id);
    if (controller) controller.abort();
    await this.#save(state);
    return { id, enabled: false };
  }

  async pause() {
    const { state } = await this.#load();
    state.paused = true;
    for (const [id, controller] of this.inFlight) {
      controller.abort();
      this.inFlight.delete(id);
    }
    await this.#save(state);
    return { paused: true };
  }

  async resume() {
    const { state } = await this.#load();
    state.paused = false;
    await this.#save(state);
    return { paused: false };
  }

  async resetCheckpoint(id, { reason = null } = {}) {
    if (typeof reason !== 'string' || reason.trim().length < 4) throw new ValidationError('resetting a checkpoint requires a reason of at least 4 characters');
    const { state } = await this.#load();
    const entry = this.#entry(state, id);
    entry.checkpoint = {};
    entry.scope = null;
    entry.history.push({ type: 'checkpoint_reset', at: nowIso(this.now), reason: reason.trim().slice(0, 200) });
    entry.history = entry.history.slice(-MAX_HISTORY);
    await this.#save(state);
    return { id, reset: true, history: entry.history.slice(-3) };
  }

  async #providerStateEvent(provider, entry, type, summary) {
    const episode = entry.health.outageStartedAt ?? nowIso(this.now);
    const reporter = provider.id;
    try {
      await this.situation.ingest({
        source: SOURCE,
        sourceEventId: wireSourceId(provider.id, `provider:${type}:${episode}`),
        type,
        category: 'system',
        observedAt: nowIso(this.now),
        payload: { summary, provider: provider.id },
        confidence: 0.95,
        entityRefs: [],
        goalRefs: [],
        planRefs: [],
        taskRefs: [],
        provenance: { reporter, provider: provider.id },
      });
    } catch {
      // Provider state is already in the health record. A refusal here must not turn into a poll loop.
    }
  }

  async poll(id, { force = false } = {}) {
    const provider = this.registry.get(id);
    const { state } = await this.#load();
    const entry = this.#entry(state, id);
    if (!entry.enabled) return { id, status: 'skipped', reason: 'provider is disabled' };
    if (state.paused) return { id, status: 'skipped', reason: 'external observation is paused' };
    if (this.inFlight.has(id)) return { id, status: 'skipped', reason: 'a poll is already in flight' };
    if (!force && entry.health.exhausted) return { id, status: 'skipped', reason: 'retry limit reached; a forced poll is required' };
    const nowMs = this.now().getTime();
    if (!force && entry.health.nextAttemptAt && Date.parse(entry.health.nextAttemptAt) > nowMs) {
      return { id, status: 'skipped', reason: `next poll is not due until ${entry.health.nextAttemptAt}` };
    }
    if (!force && !entry.health.nextAttemptAt && entry.health.lastAttemptAt
      && nowMs - Date.parse(entry.health.lastAttemptAt) < entry.config.intervalMs) {
      return { id, status: 'skipped', reason: `the ${entry.config.intervalMs} ms interval has not elapsed`, nextPollAt: this.#nextPollAt(entry) };
    }

    const controller = new AbortController();
    this.inFlight.set(id, controller);
    entry.health.lastAttemptAt = nowIso(this.now);
    entry.health.polls += 1;
    const started = Date.now();
    let timer = null;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(Object.assign(new Error(`provider timed out after ${entry.config.timeoutMs} ms`), { code: 'PROVIDER_TIMEOUT' }));
      }, entry.config.timeoutMs);
    });
    try {
      const result = await Promise.race([
        provider.poll({
          config: entry.config,
          checkpoint: entry.checkpoint,
          now: this.now,
          dataDir: this.dataDir,
          signal: controller.signal,
          fetchImpl: this.fetchImpl,
        }),
        timeout,
      ]);
      if (!result || typeof result !== 'object' || !Array.isArray(result.observations)) {
        throw new Error('provider returned no observation list');
      }
      const observations = result.observations.slice(0, entry.config.maxObservations);
      const truncated = result.observations.length > observations.length;
      let accepted = 0;
      let duplicates = 0;
      let rejected = 0;
      for (const raw of observations) {
        try {
          const observation = normalizeObservation(raw, id);
          const ingested = await this.situation.ingest({
            source: SOURCE,
            sourceEventId: wireSourceId(id, observation.key),
            type: observation.type,
            category: observation.category,
            observedAt: observation.observedAt ?? nowIso(this.now),
            payload: observation.payload,
            confidence: observation.confidence,
            entityRefs: observation.entityRefs,
            goalRefs: observation.goalRefs,
            planRefs: observation.planRefs,
            taskRefs: observation.taskRefs,
            validUntil: observation.validUntil,
            provenance: { reporter: id, provider: id },
          });
          if (ingested.duplicate) {
            duplicates += 1;
            this.#record(entry, { at: nowIso(this.now), type: observation.type, summary: observation.summary, duplicate: true });
          } else {
            accepted += 1;
            this.#record(entry, { at: nowIso(this.now), type: observation.type, summary: observation.summary, eventId: ingested.event.id });
          }
        } catch (err) {
          rejected += 1;
          this.#record(entry, { at: nowIso(this.now), type: 'rejected', summary: 'an observation was refused', error: safeError(err) });
          this.#recordError(entry, safeError(err), nowIso(this.now));
        }
      }
      entry.health.lastSuccessAt = nowIso(this.now);
      entry.health.lastMetrics = result.health ?? null;
      entry.health.consecutiveFailures = 0;
      entry.health.nextAttemptAt = null;
      entry.health.exhausted = false;
      entry.health.lastError = rejected > 0 ? `${rejected} observation(s) were refused; see errors` : null;
      if (rejected > 0) entry.health.lastErrorAt = nowIso(this.now);
      entry.health.observed += observations.length;
      entry.health.accepted += accepted;
      entry.health.duplicates += duplicates;
      entry.health.rejected += rejected;
      entry.health.durationMs = Date.now() - started;
      entry.checkpoint = result.checkpoint && typeof result.checkpoint === 'object' ? result.checkpoint : entry.checkpoint;
      entry.checkpoint.lastPollAt = nowIso(this.now);
      if (entry.health.outageStartedAt) {
        await this.#providerStateEvent(provider, entry, 'provider_recovered', `provider ${id} recovered and is answering again`);
        entry.health.outageStartedAt = null;
      }
      await this.#persistProvider(id, entry);
      return {
        id, status: 'polled', observed: observations.length, accepted, duplicates, rejected, truncated,
        durationMs: entry.health.durationMs, nextPollAt: this.#nextPollAt(entry),
      };
    } catch (err) {
      entry.health.consecutiveFailures += 1;
      entry.health.lastError = safeError(err);
      entry.health.lastErrorAt = nowIso(this.now);
      entry.health.durationMs = Date.now() - started;
      this.#recordError(entry, safeError(err), nowIso(this.now));
      if (controller.signal.aborted && !timedOut) {
        entry.health.consecutiveFailures = Math.max(0, entry.health.consecutiveFailures - 1);
        await this.#persistProvider(id, entry);
        return { id, status: 'cancelled', reason: 'the poll was cancelled' };
      }
      const attempts = entry.health.consecutiveFailures;
      const maxAttempts = entry.config.retry.maxAttempts;
      if (attempts >= maxAttempts) {
        entry.health.exhausted = true;
        entry.health.nextAttemptAt = null;
      } else {
        entry.health.nextAttemptAt = new Date(this.now().getTime() + retryDelay(attempts, entry.config)).toISOString();
      }
      if (!entry.health.outageStartedAt) {
        entry.health.outageStartedAt = nowIso(this.now);
        await this.#providerStateEvent(provider, entry, 'provider_unavailable', `provider ${id} is unavailable: ${entry.health.lastError}`);
      }
      await this.#persistProvider(id, entry);
      return {
        id, status: 'failed', error: entry.health.lastError, attempts, exhausted: entry.health.exhausted,
        retryAt: entry.health.nextAttemptAt,
      };
    } finally {
      if (timer) clearTimeout(timer);
      this.inFlight.delete(id);
    }
  }

  async pollDue({ limit = 2 } = {}) {
    const { state } = await this.#load();
    if (state.paused) return { paused: true, polled: [], skipped: [{ reason: 'external observation is paused' }], observed: 0, accepted: 0, duplicates: 0, rejected: 0 };
    const nowMs = this.now().getTime();
    const due = [];
    for (const provider of this.registry.providers.values()) {
      const entry = state.providers[provider.id];
      if (!entry.enabled || entry.health.exhausted) continue;
      if (entry.health.nextAttemptAt && Date.parse(entry.health.nextAttemptAt) > nowMs) continue;
      if (!entry.health.nextAttemptAt && entry.health.lastAttemptAt && nowMs - Date.parse(entry.health.lastAttemptAt) < entry.config.intervalMs) continue;
      due.push({ id: provider.id, dueAt: entry.health.nextAttemptAt ?? entry.health.lastAttemptAt ?? '' });
    }
    due.sort((a, b) => (a.dueAt === b.dueAt ? (a.id < b.id ? -1 : 1) : (a.dueAt < b.dueAt ? -1 : 1)));
    const selected = due.slice(0, Math.max(1, Math.min(limit, LIMITS.maxProviders)));
    const results = [];
    for (const item of selected) {
      results.push(await this.poll(item.id));
    }
    const summary = {
      paused: false,
      polled: results.filter((row) => row.status === 'polled'),
      skipped: results.filter((row) => row.status !== 'polled'),
      observed: results.reduce((sum, row) => sum + (row.observed ?? 0), 0),
      accepted: results.reduce((sum, row) => sum + (row.accepted ?? 0), 0),
      duplicates: results.reduce((sum, row) => sum + (row.duplicates ?? 0), 0),
      rejected: results.reduce((sum, row) => sum + (row.rejected ?? 0), 0),
    };
    summary.skipped.push(...due.slice(selected.length).map((item) => ({ id: item.id, reason: 'bounded provider budget for this cycle' })));
    return summary;
  }

  async observations({ provider = null, limit = 20 } = {}) {
    const size = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, LIMITS.maxObservationsRead) : 20;
    const page = await this.situation.events({ limit: LIMITS.maxEventsRead });
    const rows = page.rows
      .filter((row) => row.event.source === SOURCE)
      .filter((row) => (provider === null ? true : row.event.provenance?.provider === provider))
      .slice(-size)
      .reverse()
      .map((row) => ({
        id: row.event.id,
        provider: row.event.provenance?.provider ?? null,
        type: row.event.type,
        category: row.event.category,
        observedAt: row.event.observedAt,
        ingestedAt: row.event.ingestedAt,
        summary: row.event.payload?.summary ?? null,
        significance: row.assessment?.significance?.level ?? null,
        decision: row.decision?.response ?? null,
        validUntil: row.event.validUntil,
      }));
    return { observations: rows, total: page.total };
  }

  async diagnose() {
    const { state, corruption } = await this.#load();
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });
    add('configuration', !corruption, corruption ? `${corruption.reason}; preserved at ${corruption.quarantinedAt}` : 'configuration parses and its checksum matches');
    add('paused', true, state.paused ? 'external observation is paused' : 'external observation is allowed');
    let validConfigs = 0;
    for (const provider of this.registry.providers.values()) {
      const entry = state.providers[provider.id];
      try {
        provider.validate(entry.config);
        validConfigs += 1;
      } catch (err) {
        add(`config ${provider.id}`, false, safeError(err));
      }
    }
    add('provider configuration', validConfigs === this.registry.providers.size, `${validConfigs} of ${this.registry.providers.size} provider configurations validate`);
    const enabled = Object.entries(state.providers).filter(([, entry]) => entry.enabled);
    add('enabled providers', true, enabled.length === 0 ? 'none are enabled' : enabled.map(([id]) => id).join(', '));
    add('polling', true, this.inFlight.size === 0 ? 'no poll is in flight' : `in flight: ${[...this.inFlight.keys()].join(', ')}`);
    add('inference', true, 'no provider holds a model or inference handle');
    add('listener', true, 'providers open no listening socket and the fabric adds no listener');
    try {
      const situation = await this.situation.status();
      add('situational log', situation.available === true, situation.available ? `${situation.counts.events} event(s)` : situation.detail);
    } catch (err) {
      add('situational log', false, safeError(err));
    }
    for (const [id, entry] of enabled) {
      if (entry.health.lastError) add(`health ${id}`, false, `${entry.health.lastError}${entry.health.nextAttemptAt ? `; retry at ${entry.health.nextAttemptAt}` : ''}`);
    }
    return { at: nowIso(this.now), paused: state.paused, checks, healthy: checks.every((check) => check.ok) };
  }

  async configHash() {
    const { state } = await this.#load();
    return hash(canonical(state));
  }
}
