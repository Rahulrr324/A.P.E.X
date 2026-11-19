import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DeviceTrustService, signDeviceEnvelope } from '../src/security/device-trust.js';
import { makeTempDataDir, cleanup } from './helpers.js';

test('device enrollment is user-origin only, persists hashed credentials, and survives restart', async () => {
  const dir = makeTempDataDir();
  try {
    const file = path.join(dir, 'devices.jsonl');
    const service = new DeviceTrustService(file);
    await assert.rejects(service.enroll({ origin: 'model', label: 'Laptop' }), /user origin/);
    const enrolled = await service.enroll({ origin: 'user', label: 'Laptop', deviceId: 'laptop-1' });
    assert.equal(enrolled.secretShownOnce, true);
    assert.equal((await service.get('laptop-1')).status, 'trusted');
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes(enrolled.secret), false);
    assert.match(raw, /secretHash/);
    const restarted = new DeviceTrustService(file);
    assert.equal((await restarted.get('laptop-1')).status, 'trusted');
  } finally { cleanup(dir); }
});

test('signed envelopes reject tampering, replay, unknown and revoked devices', async () => {
  const dir = makeTempDataDir();
  try {
    let now = new Date('2026-11-19T10:00:00.000Z');
    const service = new DeviceTrustService(path.join(dir, 'devices.jsonl'), { now: () => now });
    const enrolled = await service.enroll({ origin: 'user', label: 'Victus', deviceId: 'victus' });
    const make = (sequence, payload = { ping: true }) => signDeviceEnvelope({
      deviceId: enrolled.deviceId, secret: enrolled.secret, sequence, timestamp: now.toISOString(), payload,
    });
    assert.deepEqual(await service.authenticate(make(1)), {
      accepted: true, deviceId: 'victus', sequence: 1, authorization: 'not_granted',
    });
    assert.equal((await service.authenticate(make(1))).reason, 'REPLAY_OR_OUT_OF_ORDER');
    const tampered = make(2);
    tampered.payload = { ping: false };
    assert.equal((await service.authenticate(tampered)).reason, 'INVALID_SIGNATURE');
    assert.equal((await service.authenticate({ ...make(2), deviceId: 'unknown' })).reason, 'UNKNOWN_DEVICE');
    await service.revoke('victus', { origin: 'user', reason: 'device retired' });
    assert.equal((await service.authenticate(make(2))).reason, 'DEVICE_REVOKED');
    assert.equal((await service.get('victus')).status, 'revoked');
  } finally { cleanup(dir); }
});

test('device registry fails closed on hash-chain tampering and stale timestamps', async () => {
  const dir = makeTempDataDir();
  try {
    const file = path.join(dir, 'devices.jsonl');
    let now = new Date('2026-11-19T10:00:00.000Z');
    const service = new DeviceTrustService(file, { now: () => now });
    const enrolled = await service.enroll({ origin: 'user', label: 'Test', deviceId: 'test-device' });
    const stale = signDeviceEnvelope({
      deviceId: enrolled.deviceId, secret: enrolled.secret, sequence: 1,
      timestamp: '2020-01-01T00:00:00.000Z', payload: { ping: true },
    });
    assert.equal((await service.authenticate(stale)).reason, 'TIMESTAMP_OUT_OF_RANGE');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const record = JSON.parse(lines[0]);
    record.label = 'tampered';
    fs.writeFileSync(file, JSON.stringify(record) + '\n');
    await assert.rejects(new DeviceTrustService(file).status(), /integrity failure/);
  } finally { cleanup(dir); }
});
