// Shared validation for provider configuration and observations. Bounds are enforced here as well as
// in the situational action, because a provider is another producer and must not rely on a caller to
// be careful. Nothing in this module reads a file or opens a socket.
import { createHash } from 'node:crypto';
import { ValidationError } from '../errors.js';
import { containsSecret, redactSecrets } from '../security/secrets.js';
import { LIMITS } from './vocabulary.js';

export function plainObject(value, name, allowed = null) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object`);
  }
  if (allowed) {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) throw new ValidationError(`${name} has an unexpected field "${String(key).slice(0, 40)}"`);
    }
  }
  return value;
}

export function text(value, name, max = 200) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ValidationError(`${name} is empty`);
  if (trimmed.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(trimmed)) throw new ValidationError(`${name} looks like a credential; it was refused`, 'SECRET_REFUSED');
  return trimmed;
}

export function optionalText(value, name, max = 400) {
  if (value === undefined || value === null || value === '') return null;
  return text(value, name, max);
}

export function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

export function number(value, name, { min = 0, max = 100 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

export function bool(value, name) {
  if (typeof value !== 'boolean') throw new ValidationError(`${name} must be true or false`);
  return value;
}

export function stringList(value, name, { max = LIMITS.maxRoots, each = 512 } = {}) {
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be a list`);
  if (value.length > max) throw new ValidationError(`${name} holds more than ${max} entries`);
  return value.map((entry, index) => text(entry, `${name} ${index + 1}`, each));
}

export function isoInstant(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${name} must be an ISO date or date-time`);
  }
  return value;
}

export function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function safeText(value, name, max = 400) {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  const clean = redactSecrets(raw.replace(/[\u0000-\u001f\u007f]/g, ' ')).trim();
  if (clean.length === 0) throw new ValidationError(`${name} is empty`);
  return clean.slice(0, max);
}

// An observation is metadata. It may carry a small fact or world-event request, but it never carries
// executable input and its payload is bounded before it reaches the situational service.
export function normalizeObservation(observation, providerId) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new ValidationError(`provider ${providerId} returned a non-object observation`);
  }
  const key = text(observation.key, 'observation key', 200);
  const type = text(observation.type, 'observation type', 80);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(type)) throw new ValidationError(`observation type "${type.slice(0, 40)}" is not a snake_case type`);
  const summary = safeText(observation.summary, 'observation summary', 400);
  const payload = observation.payload && typeof observation.payload === 'object' && !Array.isArray(observation.payload)
    ? observation.payload
    : {};
  const withSummary = { ...payload, summary };
  const bytes = Buffer.byteLength(JSON.stringify(withSummary), 'utf8');
  if (bytes > LIMITS.maxPayloadBytes) {
    throw new ValidationError(`observation payload is ${bytes} bytes; the limit is ${LIMITS.maxPayloadBytes}`);
  }
  if (JSON.stringify(withSummary).includes('\u0000')) throw new ValidationError('observation payload contains a null byte');
  return {
    key,
    type,
    category: observation.category ?? 'external',
    summary,
    observedAt: observation.observedAt ? isoInstant(observation.observedAt, 'observedAt') : null,
    validUntil: observation.validUntil ? isoInstant(observation.validUntil, 'validUntil') : null,
    confidence: typeof observation.confidence === 'number' && observation.confidence >= 0 && observation.confidence <= 1
      ? observation.confidence
      : 0.7,
    payload: withSummary,
    entityRefs: Array.isArray(observation.entityRefs) ? observation.entityRefs : [],
    goalRefs: Array.isArray(observation.goalRefs) ? observation.goalRefs : [],
    planRefs: Array.isArray(observation.planRefs) ? observation.planRefs : [],
    taskRefs: Array.isArray(observation.taskRefs) ? observation.taskRefs : [],
  };
}

// A stable source identity: readable when it fits the situational log's 64-character source id,
// otherwise a digest. It is derived from provider id + the provider's stable observation key, so a
// repeated poll maps to the same event and an update uses a new key.
export function wireSourceId(providerId, key) {
  const readable = `${providerId}:${key}`;
  if (readable.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(readable)) return readable;
  return `int:${hash(readable).slice(0, 48)}`;
}

export function mergeCommon(current, patch) {
  const merged = { ...current, ...patch };
  if (patch.retry) merged.retry = { ...(current.retry ?? {}), ...patch.retry };
  merged.intervalMs = integer(merged.intervalMs, 'intervalMs', { min: LIMITS.minIntervalMs, max: LIMITS.maxIntervalMs });
  merged.timeoutMs = integer(merged.timeoutMs, 'timeoutMs', { min: LIMITS.minTimeoutMs, max: LIMITS.maxTimeoutMs });
  merged.maxObservations = integer(merged.maxObservations, 'maxObservations', { min: 1, max: LIMITS.maxObservationsPerPoll });
  merged.retry = {
    maxAttempts: integer(merged.retry?.maxAttempts ?? LIMITS.maxRetryAttempts, 'retry.maxAttempts', { min: 1, max: 5 }),
    baseDelayMs: integer(merged.retry?.baseDelayMs ?? LIMITS.baseRetryMs, 'retry.baseDelayMs', { min: 100, max: 3600000 }),
  };
  return merged;
}
