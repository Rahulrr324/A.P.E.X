// Outbound-only service contract for a future authorized integration. There is no credential field,
// no arbitrary method, no redirect following and no URL supplied by a response. The endpoint must be
// explicitly allowlisted, the response is read under a byte cap, and its JSON is treated as data:
// only bounded scalar metadata is kept. Tests point this at a local deterministic server; the same
// code is the real outbound adapter when a user authorizes a service later.
import { ValidationError } from '../../errors.js';
import { DEFAULT_COMMON_CONFIG, LIMITS, PERMISSIONS, PROVIDER_API_VERSION } from '../vocabulary.js';
import {
  hash, integer, isoInstant, mergeCommon, number, optionalText, plainObject, safeText, stringList, text,
} from '../model.js';

const DEFAULTS = Object.freeze({
  ...DEFAULT_COMMON_CONFIG,
  endpoint: null,
  allowlist: Object.freeze([]),
  maxBytes: 64 * 1024,
  entityId: null,
  predicate: null,
});

const ALLOWED_ENDPOINT_KEYS = ['endpoint', 'allowlist', 'maxBytes', 'entityId', 'predicate', 'intervalMs', 'timeoutMs', 'maxObservations', 'retry'];

function validateEndpoint(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ValidationError('endpoint is required');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ValidationError('endpoint must be an absolute http or https URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ValidationError('endpoint must use http or https');
  if (url.username || url.password) throw new ValidationError('endpoint must not contain credentials');
  if (url.search || url.hash) throw new ValidationError('endpoint must not contain a query or fragment');
  return url;
}

function validate(config) {
  const merged = mergeCommon(DEFAULTS, config);
  for (const key of Object.keys(merged)) {
    if (!ALLOWED_ENDPOINT_KEYS.includes(key)) throw new ValidationError(`external service configuration has an unexpected field "${String(key).slice(0, 40)}"`);
  }
  // A disabled provider may have no endpoint yet. Enabling is refused by the fabric until one is
  // configured and allowlisted.
  if (merged.endpoint === null || merged.endpoint === '') {
    return { ...merged, endpoint: null, allowlist: [], maxBytes: integer(merged.maxBytes, 'maxBytes', { min: 1024, max: 256 * 1024 }) };
  }
  const url = validateEndpoint(merged.endpoint);
  const allowlist = stringList(merged.allowlist, 'allowlist', { max: 10, each: 512 }).map((entry) => {
    let origin;
    try {
      const parsed = new URL(entry);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('not http');
      origin = parsed.origin;
    } catch {
      throw new ValidationError(`allowlist entry "${entry.slice(0, 80)}" is not an http or https origin`);
    }
    return origin;
  });
  if (!allowlist.includes(url.origin)) throw new ValidationError(`endpoint origin ${url.origin} is not in the allowlist`);
  return {
    ...merged,
    endpoint: url.toString(),
    allowlist: [...new Set(allowlist)],
    maxBytes: integer(merged.maxBytes, 'maxBytes', { min: 1024, max: 256 * 1024 }),
    entityId: optionalText(merged.entityId, 'entityId', 64),
    predicate: optionalText(merged.predicate, 'predicate', 80),
  };
}

function scopeOf(config) {
  return hash({ endpoint: config.endpoint, entityId: config.entityId, predicate: config.predicate });
}

function scalar(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(`${name} must be finite`);
    return value;
  }
  if (typeof value === 'string') return safeText(value, name, 300);
  throw new ValidationError(`${name} must be a string, number or boolean`);
}

function propertiesOf(value) {
  if (value === undefined || value === null) return {};
  const object = plainObject(value, 'properties');
  const out = {};
  let count = 0;
  for (const [key, entry] of Object.entries(object)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) throw new ValidationError(`property "${String(key).slice(0, 32)}" is not a simple key`);
    if (count >= 10) throw new ValidationError('properties holds more than 10 entries');
    out[key] = scalar(entry, `property ${key}`);
    count += 1;
  }
  return out;
}

async function readBounded(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) throw new ValidationError(`response declared ${declared} bytes; the limit is ${maxBytes}`);
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new ValidationError(`response exceeded ${maxBytes} bytes`);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ValidationError(`response exceeded ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function normalizeItem(item, index, config, nowIso) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ValidationError(`observation ${index + 1} is not an object`);
  const allowed = ['id', 'type', 'summary', 'observedAt', 'validUntil', 'value', 'properties', 'confidence'];
  for (const key of Object.keys(item)) {
    if (!allowed.includes(key)) throw new ValidationError(`observation ${index + 1} has an unexpected field "${String(key).slice(0, 40)}"`);
  }
  const id = text(item.id, `observation ${index + 1} id`, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new ValidationError(`observation ${index + 1} id is not a stable reference`);
  const type = text(item.type, `observation ${index + 1} type`, 80);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(type)) throw new ValidationError(`observation ${index + 1} type is not snake_case`);
  const summary = safeText(item.summary, `observation ${index + 1} summary`, 300);
  const observedAt = item.observedAt ? isoInstant(item.observedAt, `observation ${index + 1} observedAt`) : nowIso;
  const validUntil = item.validUntil ? isoInstant(item.validUntil, `observation ${index + 1} validUntil`) : null;
  const confidence = typeof item.confidence === 'number'
    ? number(item.confidence, `observation ${index + 1} confidence`, { min: 0, max: 1 })
    : 0.8;
  const properties = propertiesOf(item.properties);
  const value = scalar(item.value, `observation ${index + 1} value`);
  const payload = { summary, ...properties };
  if (value !== null) payload.value = value;
  if (config.entityId && config.predicate && value !== null) {
    payload.fact = { predicate: config.predicate, object: value };
  }
  if (config.entityId) {
    payload.worldEvent = { eventType: type, occurredAt: observedAt, properties: { ...properties } };
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > LIMITS.maxPayloadBytes) {
    throw new ValidationError(`observation ${index + 1} payload is too large`);
  }
  return {
    key: `svc:${id}:${hash({ type, summary, observedAt, validUntil, value, properties }).slice(0, 16)}`,
    type,
    category: 'external',
    summary,
    observedAt,
    validUntil,
    confidence,
    payload,
    entityRefs: config.entityId ? [config.entityId] : [],
  };
}

async function poll({ config, now, signal, fetchImpl }) {
  const fetcher = fetchImpl ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new ValidationError('this Node runtime provides no fetch implementation');
  const response = await fetcher(config.endpoint, {
    method: 'GET',
    redirect: 'manual',
    headers: { accept: 'application/json' },
    signal,
  });
  if (response.status !== 200) {
    try { await response.body?.cancel?.(); } catch { /* the body is already irrelevant */ }
    throw new Error(`the service answered HTTP ${response.status}`);
  }
  const buffer = await readBounded(response, config.maxBytes);
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ValidationError('the service response is not valid JSON');
  }
  const items = Array.isArray(parsed) ? parsed : parsed?.observations;
  if (!Array.isArray(items)) throw new ValidationError('the service response must be a list or {"observations":[...]}');
  if (items.length > LIMITS.maxServiceObservations) throw new ValidationError(`the service returned ${items.length} observations; the limit is ${LIMITS.maxServiceObservations}`);
  const nowIso = now().toISOString();
  const observations = [];
  const rejected = [];
  for (let index = 0; index < items.length; index += 1) {
    try {
      observations.push(normalizeItem(items[index], index, config, nowIso));
    } catch (err) {
      rejected.push(String(err?.message ?? err).slice(0, 160));
    }
  }
  return {
    observations,
    checkpoint: { lastFetchAt: nowIso, lastBodyDigest: hash(buffer.toString('utf8')), rejected: rejected.length },
    health: { httpStatus: response.status, bytes: buffer.length, received: items.length, rejected: rejected.slice(0, 5) },
  };
}

export const externalServiceProvider = Object.freeze({
  id: 'external_service',
  name: 'Allowlisted outbound JSON service',
  apiVersion: PROVIDER_API_VERSION,
  permissions: Object.freeze([PERMISSIONS.NETWORK_OUTBOUND]),
  defaults: DEFAULTS,
  validate,
  scopeOf,
  async poll(ctx) { return poll(ctx); },
  describe() {
    return {
      id: this.id,
      name: this.name,
      apiVersion: this.apiVersion,
      permissions: this.permissions,
      kind: 'real outbound contract (mock server in tests)',
      reads: 'one allowlisted GET returning bounded JSON metadata',
      neverReads: 'credentials, arbitrary URLs, redirects, raw response bodies as instructions',
      defaults: DEFAULTS,
    };
  },
});
