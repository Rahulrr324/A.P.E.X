// T-35 Step 2 (2026-11-19): trusted presence handoff envelopes.
//
// Part 3's fifth layer is presence: the owner's work should follow the owner between the surfaces
// they have already trusted. What exists here is the honest local half of that - an envelope staged
// against the device-trust registry, bound by a SHA-256 digest, expiring, claimable exactly once by a
// trusted device, and revocable before it is claimed.
//
// What deliberately does not exist: a network transport. There is no socket mesh, no peer discovery
// and no remote session. `status()` says `remoteTransport: false` with the reason, and the route the
// deck reads repeats it, so a reader cannot mistake a local envelope for a distributed handoff.
//
// Two properties carry the honesty of the whole thing:
//
//   * A device is an identity, never a capability. Neither side of an envelope is granted anything by
//     being named in one; the ECP still authorizes every action a claimer takes afterwards.
//   * The digest is recomputed from the stored record on every claim. A ledger line edited on disk is
//     not a handoff, it is a tamper, and the claim is refused with DIGEST_MISMATCH.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StoreError, ValidationError } from '../errors.js';

export const HANDOFF_SCHEMA = 'apex.presence.handoff/1';
export const HANDOFF_LEDGER = 'presence-handoffs.jsonl';
export const HANDOFF_TTL_MS = 30 * 60 * 1000;

// The views a handoff may open. A typo is refused at staging rather than stored and then discovered
// by a deck that cannot go there.
export const HANDOFF_VIEWS = Object.freeze([
  'deck', 'conversations', 'missions', 'tasks', 'approvals', 'sentinel', 'memory', 'documents',
  'reasoning', 'council', 'cognition', 'presence', 'system', 'integrations', 'workshop',
]);

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const HANDOFF_ID_RE = /^ph-[a-f0-9]{8,32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new ValidationError(`${label} must be null or a 1-96 character identifier`);
  }
  return value;
}

function noteField(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('note must be text');
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 240) throw new ValidationError('note must be at most 240 characters');
  return trimmed;
}

function viewField(value) {
  if (typeof value !== 'string' || !HANDOFF_VIEWS.includes(value.trim())) {
    throw new ValidationError(`targetView must be one of: ${HANDOFF_VIEWS.join(', ')}`);
  }
  return value.trim();
}

function deviceField(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new ValidationError(`${label} must be a 1-96 character device identifier`);
  }
  return value;
}

function reasonField(value) {
  if (typeof value !== 'string') throw new ValidationError('a revocation reason is required');
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length < 3 || trimmed.length > 240) {
    throw new ValidationError('a revocation reason of 3-240 characters is required');
  }
  return trimmed;
}

// The exact bytes the digest covers. Everything that makes the envelope a destination is in here,
// including the expiry, so changing any of them invalidates the digest.
function digestOf(envelope) {
  return sha256(canonical({
    schema: HANDOFF_SCHEMA,
    id: envelope.id,
    sourceDeviceId: envelope.sourceDeviceId,
    targetDeviceId: envelope.targetDeviceId,
    targetView: envelope.targetView,
    taskId: envelope.taskId,
    briefingCheckpointId: envelope.briefingCheckpointId,
    artifactId: envelope.artifactId,
    note: envelope.note,
    stagedAt: envelope.stagedAt,
    expiresAt: envelope.expiresAt,
  }));
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter((line) => line.trim().length > 0);
}

export function createPresenceHandoffs({
  dataDir,
  deviceTrust = null,
  now = () => new Date(),
  idFactory = randomUUID,
  idPrefix = null,
  ttlMs = HANDOFF_TTL_MS,
  // Optional read-only lookups, so an envelope cannot name a target that does not exist. When a
  // lookup is not supplied the field is recorded as the owner stated it and the payload says which
  // lookups were available; when it is supplied, an unknown target refuses the staging.
  lookups = {},
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('presence handoffs need a data directory');
  const ledgerPath = path.join(dataDir, HANDOFF_LEDGER);
  const rows = new Map();
  let loaded = false;

  function load() {
    if (loaded) return;
    const lines = readLines(ledgerPath);
    for (let index = 0; index < lines.length; index += 1) {
      let record;
      try {
        record = JSON.parse(lines[index]);
      } catch {
        throw new StoreError(`the handoff ledger is corrupt at line ${index + 1}`);
      }
      if (!record || record.schema !== HANDOFF_SCHEMA || typeof record.id !== 'string' || !HANDOFF_ID_RE.test(record.id)) {
        throw new StoreError(`the handoff ledger has an unreadable record at line ${index + 1}`);
      }
      if (record.event === 'staged') {
        if (rows.has(record.id)) throw new StoreError(`the handoff ledger stages ${record.id} twice`);
        const envelope = record.envelope;
        if (!envelope || typeof envelope !== 'object' || !DIGEST_RE.test(record.sha256Digest ?? '')) {
          throw new StoreError(`the handoff ledger has an incomplete envelope at line ${index + 1}`);
        }
        rows.set(record.id, {
          id: record.id,
          envelope,
          sha256Digest: record.sha256Digest,
          status: 'staged',
          stagedAt: record.at,
          stagedBy: record.by ?? null,
          claimedAt: null,
          claimedBy: null,
          revokedAt: null,
          revokeReason: null,
        });
        continue;
      }
      const row = rows.get(record.id);
      if (!row) throw new StoreError(`the handoff ledger refers to ${record.id} before it was staged`);
      if (record.event === 'claimed') {
        if (row.status !== 'staged') throw new StoreError(`the handoff ledger claims ${record.id} twice`);
        row.status = 'claimed';
        row.claimedAt = record.at;
        row.claimedBy = record.by ?? null;
      } else if (record.event === 'revoked') {
        if (row.status !== 'staged') throw new StoreError(`the handoff ledger revokes ${record.id} after it was claimed`);
        row.status = 'revoked';
        row.revokedAt = record.at;
        row.revokeReason = record.reason ?? null;
      } else {
        throw new StoreError(`the handoff ledger has an unknown event at line ${index + 1}`);
      }
    }
    loaded = true;
  }

  function append(record) {
    try {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      const handle = fs.openSync(ledgerPath, 'a');
      try {
        fs.writeFileSync(handle, `${JSON.stringify(record)}\n`, 'utf8');
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    } catch (err) {
      throw new StoreError(`cannot append to the handoff ledger: ${err?.code || err?.message}`);
    }
  }

  function envelopeOf(row) {
    const expired = row.status === 'staged' && Date.parse(row.envelope.expiresAt) <= now().getTime();
    return Object.freeze({
      id: row.id,
      status: expired ? 'expired' : row.status,
      sourceDeviceId: row.envelope.sourceDeviceId,
      targetDeviceId: row.envelope.targetDeviceId,
      targetView: row.envelope.targetView,
      taskId: row.envelope.taskId,
      briefingCheckpointId: row.envelope.briefingCheckpointId,
      artifactId: row.envelope.artifactId,
      note: row.envelope.note,
      sha256Digest: row.sha256Digest,
      stagedAt: row.stagedAt,
      stagedBy: row.stagedBy,
      expiresAt: row.envelope.expiresAt,
      expired,
      claimedAt: row.claimedAt,
      claimedBy: row.claimedBy,
      revokedAt: row.revokedAt,
      revokeReason: row.revokeReason,
      restoration: row.status === 'claimed'
        ? Object.freeze({
          view: row.envelope.targetView,
          taskId: row.envelope.taskId,
          artifactId: row.envelope.artifactId,
          briefingCheckpointId: row.envelope.briefingCheckpointId,
        })
        : null,
      authorizesExecution: false,
    });
  }

  async function deviceStatus(deviceId) {
    if (!deviceTrust || typeof deviceTrust.get !== 'function') return { available: false, deviceId, status: 'unverified' };
    let device = null;
    try {
      device = await deviceTrust.get(deviceId);
    } catch (err) {
      throw new StoreError(`the device registry could not be read: ${err?.message || err}`);
    }
    if (!device) return { available: true, deviceId, status: 'unknown', device: null };
    return { available: true, deviceId, status: device.status === 'trusted' ? 'trusted' : 'revoked', device };
  }

  async function requireTrusted(deviceId, label) {
    const read = await deviceStatus(deviceId);
    if (read.available !== true) {
      throw new ValidationError(`${label} ${deviceId} cannot be checked: no device-trust registry is configured`);
    }
    if (read.status === 'unknown') throw new ValidationError(`${label} ${deviceId} is not enrolled in the device-trust registry`);
    if (read.status !== 'trusted') throw new ValidationError(`${label} ${deviceId} is revoked and cannot take part in a handoff`);
    return read.device;
  }

  async function verifyTargets(envelope) {
    const checked = { task: false, artifact: false, checkpoint: false };
    if (envelope.taskId !== null) {
      if (typeof lookups.task === 'function') {
        const task = await lookups.task(envelope.taskId);
        if (!task) throw new ValidationError(`TARGET_UNKNOWN: no task ${envelope.taskId} exists to hand off`);
        checked.task = true;
      }
    }
    if (envelope.artifactId !== null) {
      if (typeof lookups.artifact === 'function') {
        const found = await lookups.artifact(envelope.artifactId);
        if (!found) throw new ValidationError(`TARGET_UNKNOWN: no workshop artifact ${envelope.artifactId} exists to hand off`);
        checked.artifact = true;
      }
    }
    if (envelope.briefingCheckpointId !== null) {
      if (typeof lookups.checkpoint === 'function') {
        const found = await lookups.checkpoint(envelope.briefingCheckpointId);
        if (!found) throw new ValidationError(`TARGET_UNKNOWN: no briefing checkpoint ${envelope.briefingCheckpointId} exists`);
        checked.checkpoint = true;
      }
    }
    return checked;
  }

  async function stage({
    sourceDeviceId, targetDeviceId, targetView, taskId = null, briefingCheckpointId = null,
    artifactId = null, note = null, by = 'owner', ttl = ttlMs,
  } = {}) {
    load();
    const source = deviceField(sourceDeviceId, 'sourceDeviceId');
    const target = deviceField(targetDeviceId, 'targetDeviceId');
    if (source === target) throw new ValidationError('a handoff needs two different devices');
    const view = viewField(targetView);
    const envelopeFields = {
      sourceDeviceId: source,
      targetDeviceId: target,
      targetView: view,
      taskId: optionalId(taskId, 'taskId'),
      briefingCheckpointId: optionalId(briefingCheckpointId, 'briefingCheckpointId'),
      artifactId: optionalId(artifactId, 'artifactId'),
      note: noteField(note),
    };
    await requireTrusted(source, 'sourceDeviceId');
    await requireTrusted(target, 'targetDeviceId');
    const checkedTargets = await verifyTargets(envelopeFields);

    const at = now();
    const id = idPrefix
      ? `${idPrefix}-${sha256(`${source}:${target}:${at.toISOString()}:${idFactory()}`).slice(0, 12)}`
      : `ph-${String(idFactory()).replace(/[^a-f0-9]/gi, '').slice(0, 24)}`;
    if (!HANDOFF_ID_RE.test(id)) throw new ValidationError('the handoff id could not be formed');
    if (rows.has(id)) throw new ValidationError('a handoff with that id already exists');
    const ttlValue = Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 24 * 60 * 60 * 1000) : ttlMs;
    const envelope = Object.freeze({ ...envelopeFields, id, stagedAt: at.toISOString(), expiresAt: new Date(at.getTime() + ttlValue).toISOString() });
    const sha256Digest = digestOf(envelope);
    const record = Object.freeze({
      schema: HANDOFF_SCHEMA,
      event: 'staged',
      id,
      at: at.toISOString(),
      by,
      envelope,
      sha256Digest,
      verifiedTargets: checkedTargets,
    });
    append(record);
    rows.set(id, {
      id,
      envelope,
      sha256Digest,
      status: 'staged',
      stagedAt: record.at,
      stagedBy: by,
      claimedAt: null,
      claimedBy: null,
      revokedAt: null,
      revokeReason: null,
    });
    return Object.freeze({ staged: true, handoff: envelopeOf(rows.get(id)), verifiedTargets: checkedTargets });
  }

  async function claim(id, { by = 'owner' } = {}) {
    load();
    if (typeof id !== 'string' || !HANDOFF_ID_RE.test(id)) throw new ValidationError('id must be a handoff id');
    const row = rows.get(id);
    if (!row) throw new ValidationError(`HANDOFF_UNKNOWN: no handoff ${id} is recorded`);
    if (row.status === 'claimed') throw new ValidationError(`HANDOFF_ALREADY_CLAIMED: ${id} was claimed at ${row.claimedAt}`);
    if (row.status === 'revoked') throw new ValidationError(`HANDOFF_REVOKED: ${id} was revoked at ${row.revokedAt}`);
    const at = now();
    if (Date.parse(row.envelope.expiresAt) <= at.getTime()) {
      throw new ValidationError(`HANDOFF_EXPIRED: ${id} expired at ${row.envelope.expiresAt}`);
    }
    const recomputed = digestOf(row.envelope);
    if (recomputed !== row.sha256Digest) {
      throw new ValidationError(`HANDOFF_DIGEST_MISMATCH: the stored envelope does not match its digest (${row.sha256Digest.slice(0, 12)}… vs ${recomputed.slice(0, 12)}…)`);
    }
    // Trust is re-read at the claim, not remembered from the staging: a device revoked between the
    // two must not be able to collect the work.
    await requireTrusted(row.envelope.sourceDeviceId, 'sourceDeviceId');
    await requireTrusted(row.envelope.targetDeviceId, 'targetDeviceId');
    const record = Object.freeze({ schema: HANDOFF_SCHEMA, event: 'claimed', id, at: at.toISOString(), by, sha256Digest: row.sha256Digest });
    append(record);
    row.status = 'claimed';
    row.claimedAt = record.at;
    row.claimedBy = by;
    const handoff = envelopeOf(row);
    return Object.freeze({ claimed: true, handoff, restoration: handoff.restoration });
  }

  async function revoke(id, { reason, by = 'owner' } = {}) {
    load();
    if (typeof id !== 'string' || !HANDOFF_ID_RE.test(id)) throw new ValidationError('id must be a handoff id');
    const row = rows.get(id);
    if (!row) throw new ValidationError(`HANDOFF_UNKNOWN: no handoff ${id} is recorded`);
    if (row.status === 'claimed') throw new ValidationError(`HANDOFF_ALREADY_CLAIMED: ${id} was claimed at ${row.claimedAt} and cannot be revoked`);
    if (row.status === 'revoked') throw new ValidationError(`HANDOFF_ALREADY_REVOKED: ${id} was revoked at ${row.revokedAt}`);
    const safeReason = reasonField(reason);
    const at = now();
    const record = Object.freeze({ schema: HANDOFF_SCHEMA, event: 'revoked', id, at: at.toISOString(), by, reason: safeReason });
    append(record);
    row.status = 'revoked';
    row.revokedAt = record.at;
    row.revokeReason = safeReason;
    return Object.freeze({ revoked: true, handoff: envelopeOf(row) });
  }

  function list() {
    load();
    return [...rows.values()]
      .map((row) => envelopeOf(row))
      .sort((a, b) => (a.stagedAt < b.stagedAt ? 1 : a.stagedAt > b.stagedAt ? -1 : 0));
  }

  function get(id) {
    load();
    if (typeof id !== 'string' || !HANDOFF_ID_RE.test(id)) return null;
    const row = rows.get(id);
    return row ? envelopeOf(row) : null;
  }

  function status() {
    load();
    const all = [...rows.values()].map((row) => envelopeOf(row));
    return Object.freeze({
      schema: HANDOFF_SCHEMA,
      available: true,
      implemented: true,
      remoteTransport: false,
      transport: 'local loopback & store-backed handoff only',
      remoteTransportDetail: 'no socket mesh, peer discovery or remote session exists; a handoff is a local envelope in a store',
      persistence: 'append-only local JSONL',
      ledger: HANDOFF_LEDGER,
      total: all.length,
      staged: all.filter((row) => row.status === 'staged').length,
      claimed: all.filter((row) => row.status === 'claimed').length,
      revoked: all.filter((row) => row.status === 'revoked').length,
      expired: all.filter((row) => row.status === 'expired').length,
      ttlMs,
      views: HANDOFF_VIEWS,
      grantsAuthority: false,
      authorizesExecution: false,
    });
  }

  return Object.freeze({
    schema: HANDOFF_SCHEMA,
    ledgerPath,
    stage,
    claim,
    revoke,
    list,
    get,
    status,
    digestOf,
  });
}
