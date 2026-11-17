// Provider discovery. A provider is a frozen contract object: identity, API version, permissions,
// defaults, a validator, an optional scope key and a poll function. Registration checks the contract
// once at construction; it never connects, polls or reads a configured source.
import { PROVIDER_API_VERSION, LIMITS, PROVIDER_IDS } from './vocabulary.js';
import { filesystemProvider } from './providers/filesystem.js';
import { systemHealthProvider } from './providers/system-health.js';
import { calendarProvider } from './providers/calendar.js';
import { externalServiceProvider } from './providers/external-service.js';

export const BUILTIN_PROVIDERS = Object.freeze([
  filesystemProvider,
  systemHealthProvider,
  calendarProvider,
  externalServiceProvider,
]);

function checkProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new TypeError('a provider must be an object');
  if (typeof provider.id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(provider.id)) throw new TypeError('a provider needs a snake_case id');
  if (provider.apiVersion !== PROVIDER_API_VERSION) throw new TypeError(`provider ${provider.id} must declare ${PROVIDER_API_VERSION}`);
  if (typeof provider.validate !== 'function') throw new TypeError(`provider ${provider.id} needs a validator`);
  if (typeof provider.poll !== 'function') throw new TypeError(`provider ${provider.id} needs a poll function`);
  if (!Array.isArray(provider.permissions)) throw new TypeError(`provider ${provider.id} needs a permission list`);
  if (!provider.defaults || typeof provider.defaults !== 'object') throw new TypeError(`provider ${provider.id} needs defaults`);
}

export class ProviderRegistry {
  constructor(providers = BUILTIN_PROVIDERS) {
    this.providers = new Map();
    for (const provider of providers) {
      checkProvider(provider);
      if (this.providers.has(provider.id)) throw new TypeError(`provider ${provider.id} is registered twice`);
      this.providers.set(provider.id, provider);
    }
    if (this.providers.size > LIMITS.maxProviders) throw new TypeError(`at most ${LIMITS.maxProviders} providers can be registered`);
  }

  has(id) { return this.providers.has(id); }

  get(id) {
    const provider = this.providers.get(id);
    if (!provider) throw new TypeError(`unknown external provider "${String(id).slice(0, 60)}"`);
    return provider;
  }

  ids() { return [...this.providers.keys()]; }

  list() {
    return [...this.providers.values()].map((provider) => ({
      ...provider.describe(),
      apiVersion: provider.apiVersion,
      permissions: [...provider.permissions],
    }));
  }
}

export function createProviderRegistry(providers = BUILTIN_PROVIDERS) {
  return new ProviderRegistry(providers);
}

export { PROVIDER_IDS };
