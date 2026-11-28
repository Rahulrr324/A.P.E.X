// Local device-trust foundation. This is a registry and message-authentication
// primitive, not a network transport, owner identity provider, or authorization
// authority. ECP remains the only component that authorizes capabilities.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createHash, createHmac, randomBytes, randomUUID, timingSafeEqual,
} from 'node:crypto';
import { StoreError, ValidationError } from '../errors.js';

const HEX_256 = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !HEX_256.test(a) || !HEX_256.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function validateId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new ValidationError(`${label} must be a 1-96 character identifier`);
  return value;
}
function validateReason(value) {
  if (typeof value !== 'string' || value.trim().length < 3 || value.length > 240) {
    throw new ValidationError('a revocation reason of 3-240 characters is required');
  }
  return value.trim();
}
// The metadata is a small, bounded, printable object. Anything else - a function, an array, a
// number that is not finite - is refused rather than coerced, because a device description that
// cannot be read back is not a description.
const METADATA_KEYS = Object.freeze([
  'deviceId', 'kind', 'hostname', 'platform', 'arch', 'capability', 'enrolledBy',
]);
function normalizeMetadata(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('device metadata must be an object');
  }
  const out = {};
  for (const key of Object.keys(value)) {
    if (!METADATA_KEYS.includes(key)) {
      throw new ValidationError(`unexpected device metadata field: ${key}`);
    }
    const entry = value[key];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'string' || entry.length > 120 || /[\r\n\0]/.test(entry)) {
      throw new ValidationError(`device metadata ${key} must be printable text of at most 120 characters`);
    }
    out[key] = entry;
  }
  return Object.keys(out).length === 0 ? null : Object.freeze(out);
}

function eventHash(event) {
  const { hash, ...body } = event;
  return sha256(canonical(body));
}
function validateEvent(event, previousHash, sequence) {
  if (!event || event.sequence !== sequence || event.previousHash !== previousHash
    || !HEX_256.test(event.hash ?? '') || event.hash !== eventHash(event)
    || !['enrolled', 'revoked', 'message_accepted'].includes(event.type)
    || typeof event.deviceId !== 'string' || !ID.test(event.deviceId)
    || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) {
    return false;
  }
  if (event.type === 'enrolled' && (!HEX_256.test(event.secretHash ?? '') || typeof event.label !== 'string')) return false;
  // T-36 Step 1: an enrollment may carry a metadata object - the hostname, the platform, the
  // capability the device has. It is part of the hashed body, so it cannot be edited afterwards
  // without breaking the chain, and it is optional: an enrollment without it stays valid.
  if (event.metadata !== undefined && event.metadata !== null
    && (typeof event.metadata !== 'object' || Array.isArray(event.metadata))) return false;
  if (event.type === 'revoked' && (typeof event.reason !== 'string' || typeof event.priorSecretHash !== 'string')) return false;
  if (event.type === 'message_accepted' && (!Number.isSafeInteger(event.deviceSequence) || event.deviceSequence < 1)) return false;
  return true;
}

export class DeviceTrustService {
  #events = [];
  #devices = new Map();
  #loaded = false;
  #now;
  #idFactory;

  constructor(filePath, { now = () => new Date(), idFactory = randomUUID } = {}) {
    this.filePath = filePath;
    this.#now = now;
    this.#idFactory = idFactory;
  }

  async #load() {
    if (this.#loaded) return;
    let text;
    try { text = await fs.readFile(this.filePath, 'utf8'); }
    catch (err) {
      if (err?.code === 'ENOENT') { this.#loaded = true; return; }
      throw new StoreError(`cannot read device registry: ${err?.code || err?.message}`);
    }
    const lines = text.split('\n').filter((line) => line.length > 0);
    let previousHash = '0'.repeat(64);
    const events = [];
    const devices = new Map();
    for (let i = 0; i < lines.length; i += 1) {
      let event;
      try { event = JSON.parse(lines[i]); } catch { throw new StoreError(`device registry is corrupt at line ${i + 1}`); }
      if (!validateEvent(event, previousHash, i + 1)) throw new StoreError(`device registry integrity failure at line ${i + 1}`);
      if (event.type === 'enrolled') {
        if (devices.has(event.deviceId)) throw new StoreError(`duplicate device enrollment at line ${i + 1}`);
        devices.set(event.deviceId, { deviceId: event.deviceId, label: event.label, secretHash: event.secretHash, metadata: event.metadata ?? null, enrolledAt: event.at, revokedAt: null, revocationReason: null, lastSequence: 0 });
      } else if (event.type === 'revoked') {
        const prior = devices.get(event.deviceId);
        if (!prior || prior.revokedAt || prior.secretHash !== event.priorSecretHash) throw new StoreError(`invalid device revocation at line ${i + 1}`);
        prior.revokedAt = event.at;
        prior.revocationReason = event.reason;
      } else {
        const prior = devices.get(event.deviceId);
        if (!prior || prior.revokedAt || event.deviceSequence <= prior.lastSequence) throw new StoreError(`invalid accepted message sequence at line ${i + 1}`);
        prior.lastSequence = event.deviceSequence;
      }
      events.push(event);
      previousHash = event.hash;
    }
    this.#events = events;
    this.#devices = devices;
    this.#loaded = true;
  }

  async #append(type, fields) {
    await this.#load();
    const body = {
      sequence: this.#events.length + 1,
      type,
      at: this.#now().toISOString(),
      previousHash: this.#events.at(-1)?.hash ?? '0'.repeat(64),
      ...fields,
    };
    const event = { ...body, hash: eventHash(body) };
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const handle = await fs.open(this.filePath, 'a');
      try { await handle.writeFile(JSON.stringify(event) + '\n', 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
    } catch (err) {
      throw new StoreError(`cannot append device registry: ${err?.code || err?.message}`);
    }
    this.#events.push(event);
    if (type === 'enrolled') this.#devices.set(fields.deviceId, {
      deviceId: fields.deviceId, label: fields.label, secretHash: fields.secretHash,
      metadata: fields.metadata ?? null,
      enrolledAt: event.at, revokedAt: null, revocationReason: null, lastSequence: 0,
    });
    if (type === 'revoked') {
      const device = this.#devices.get(fields.deviceId);
      device.revokedAt = event.at;
      device.revocationReason = fields.reason;
    }
    if (type === 'message_accepted') this.#devices.get(fields.deviceId).lastSequence = fields.deviceSequence;
    return event;
  }

  // T-36 Step 1: `metadata` is optional and bounded. It is the device's own description of itself
  // - the hostname, the platform, the capability it holds - and it is hashed into the chain with
  // everything else, so it cannot be rewritten after the fact without detection.
  async enroll({ origin, label, deviceId = this.#idFactory(), metadata = null } = {}) {
    if (origin !== 'user') throw new ValidationError('device enrollment requires explicit user origin');
    validateId(deviceId, 'deviceId');
    if (typeof label !== 'string' || label.trim().length < 1 || label.length > 80 || /[\r\n\0]/.test(label)) {
      throw new ValidationError('device label must be 1-80 printable characters');
    }
    const described = normalizeMetadata(metadata);
    await this.#load();
    if (this.#devices.has(deviceId)) throw new ValidationError('deviceId has already been enrolled');
    const secret = randomBytes(32).toString('base64url');
    await this.#append('enrolled', {
      deviceId,
      label: label.trim(),
      secretHash: sha256(Buffer.from(secret, 'base64url')),
      ...(described === null ? {} : { metadata: described }),
    });
    return Object.freeze({ deviceId, secret, secretShownOnce: true, status: 'trusted', metadata: described });
  }

  async revoke(deviceId, { origin, reason } = {}) {
    if (origin !== 'user') throw new ValidationError('device revocation requires explicit user origin');
    validateId(deviceId, 'deviceId');
    const safeReason = validateReason(reason);
    await this.#load();
    const device = this.#devices.get(deviceId);
    if (!device || device.revokedAt) throw new ValidationError('active device was not found');
    await this.#append('revoked', { deviceId, priorSecretHash: device.secretHash, reason: safeReason });
    return this.get(deviceId);
  }

  async get(deviceId) {
    validateId(deviceId, 'deviceId');
    await this.#load();
    const d = this.#devices.get(deviceId);
    if (!d) return null;
    return Object.freeze({
      deviceId: d.deviceId, label: d.label, enrolledAt: d.enrolledAt,
      revokedAt: d.revokedAt, revocationReason: d.revocationReason,
      status: d.revokedAt ? 'revoked' : 'trusted',
      lastAcceptedSequence: d.lastSequence,
      // T-36 Step 1: the device's own description of itself, when it was given one.
      metadata: d.metadata ?? null,
    });
  }

  async list() {
    await this.#load();
    return Promise.all([...this.#devices.keys()].map((id) => this.get(id)));
  }

  async authenticate(envelope) {
    await this.#load();
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).some((key) => !['deviceId', 'sequence', 'timestamp', 'payload', 'secret', 'signature'].includes(key))) {
      return { accepted: false, reason: 'INVALID_ENVELOPE' };
    }
    const device = this.#devices.get(envelope.deviceId);
    if (!device) return { accepted: false, reason: 'UNKNOWN_DEVICE' };
    if (device.revokedAt) return { accepted: false, reason: 'DEVICE_REVOKED' };
    if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 || envelope.sequence <= device.lastSequence) {
      return { accepted: false, reason: 'REPLAY_OR_OUT_OF_ORDER' };
    }
    const timestamp = Date.parse(envelope.timestamp);
    const now = this.#now().getTime();
    if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) {
      return { accepted: false, reason: 'TIMESTAMP_OUT_OF_RANGE' };
    }
    if (!Object.hasOwn(envelope, 'payload')) return { accepted: false, reason: 'INVALID_ENVELOPE' };
    const expected = createHmac('sha256', Buffer.from(envelope.secret ?? '', 'base64url'))
      .update(canonical({ deviceId: envelope.deviceId, sequence: envelope.sequence, timestamp: envelope.timestamp, payload: envelope.payload }))
      .digest('hex');
    if (!safeEqualHex(envelope.signature, expected)) return { accepted: false, reason: 'INVALID_SIGNATURE' };
    // The secret is supplied only to calculate the signature and is never persisted.
    // It must match the enrolled hash before the signed payload can advance sequence.
    if (!safeEqualHex(sha256(Buffer.from(envelope.secret ?? '', 'base64url')), device.secretHash)) {
      return { accepted: false, reason: 'INVALID_CREDENTIAL' };
    }
    device.lastSequence = envelope.sequence;
    return { accepted: true, deviceId: device.deviceId, sequence: device.lastSequence, authorization: 'not_granted' };
  }

  async status() {
    await this.#load();
    return Object.freeze({
      available: true, persistence: 'append-only hash-chained local JSONL',
      devices: this.#devices.size,
      trusted: [...this.#devices.values()].filter((d) => !d.revokedAt).length,
      revoked: [...this.#devices.values()].filter((d) => d.revokedAt).length,
      transport: 'not implemented', remotePresence: 'not implemented',
      grantsAuthority: false, hashChainValid: true,
    });
  }
}

export function signDeviceEnvelope({ deviceId, secret, sequence, timestamp, payload }) {
  validateId(deviceId, 'deviceId');
  if (typeof secret !== 'string' || secret.length < 32) throw new ValidationError('device secret is invalid');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new ValidationError('sequence must be a positive safe integer');
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) throw new ValidationError('timestamp must be an ISO date');
  const body = { deviceId, sequence, timestamp, payload };
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(canonical(body)).digest('hex');
  return { ...body, secret, signature };
}
