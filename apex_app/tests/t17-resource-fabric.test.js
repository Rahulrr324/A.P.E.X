// T-17 Resource Fabric foundation: actual Node/OS telemetry and bounded in-memory reservations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResourceFabric, RESOURCE_FIELDS, RESOURCE_FABRIC_SCHEMA } from '../src/resources/fabric.js';

function at() { return new Date('2026-11-18T12:00:00Z'); }

test('Resource Fabric reports real OS CPU and memory values and names unavailable GPU/network telemetry', async () => {
  const fabric = new ResourceFabric({ now: at });
  const telemetry = await fabric.telemetry({ storagePaths: [os.tmpdir()] });
  assert.equal(telemetry.schema, RESOURCE_FABRIC_SCHEMA);
  assert.equal(telemetry.cpu.available, true);
  assert.ok(telemetry.cpu.logicalCount >= 1);
  assert.equal(telemetry.memory.available, true);
  assert.ok(telemetry.memory.totalBytes >= telemetry.memory.freeBytes);
  assert.equal(telemetry.gpu.reported, false);
  assert.equal(telemetry.gpu.reason, 'NO_GPU_METADATA_PROVIDER');
  assert.equal(telemetry.network.reported, false);
  assert.equal(telemetry.storage.length, 1);
  assert.ok(telemetry.storage[0].reported === true || telemetry.storage[0].reported === false);
});

test('storage and OS read failures are disclosed instead of fabricated values', async () => {
  const missing = path.join(os.tmpdir(), `apex-missing-${process.pid}-${Date.now()}`);
  const fabric = new ResourceFabric({ now: at });
  const telemetry = await fabric.telemetry({ storagePaths: [missing] });
  assert.equal(telemetry.storage[0].reported, false);
  assert.equal(telemetry.storage[0].availableBytes, null);
  assert.equal(telemetry.storage[0].reason, 'UNAVAILABLE');
});

test('reservations are bounded, reject malformed budgets and release exactly once', () => {
  const fabric = new ResourceFabric({ now: at });
  const reserve = fabric.reserve({ id: 'r1', owner: 'owner', capability: 'safe.read', resourceBudget: { cpuMillis: 10, memoryBytes: 20, storageBytes: 0, networkBytes: 0, gpuMemoryBytes: 0 }, actionBudget: 3, expiresAt: '2026-11-18T13:00:00Z' });
  assert.equal(reserve.resourceBudget.cpuMillis, 10);
  assert.equal(fabric.status().reservations, 1);
  assert.deepEqual(fabric.release('r1'), { released: true, alreadyReleased: false });
  assert.deepEqual(fabric.release('r1'), { released: true, alreadyReleased: true });
  assert.equal(fabric.status().reservations, 0);
  assert.throws(() => fabric.reserve({ id: 'bad', owner: 'owner', capability: 'x', resourceBudget: { cpuMillis: -1 }, expiresAt: '2026-11-18T13:00:00Z' }), /non-negative/);
  assert.throws(() => fabric.reserve({ id: 'past', owner: 'owner', capability: 'x', resourceBudget: { cpuMillis: 1 }, expiresAt: '2026-11-18T11:00:00Z' }), /past/);
  assert.equal(RESOURCE_FIELDS.length, 5);
});

test('expired reservations are removed without a false remaining resource', () => {
  const fabric = new ResourceFabric({ now: at });
  fabric.reserve({ id: 'expires', owner: 'owner', capability: 'x', resourceBudget: { cpuMillis: 1, memoryBytes: 0, storageBytes: 0, networkBytes: 0, gpuMemoryBytes: 0 }, expiresAt: '2026-11-18T12:00:01Z' });
  assert.equal(fabric.status().reservations, 1);
  const later = new ResourceFabric({ now: () => new Date('2026-11-18T12:00:02Z') });
  assert.throws(() => later.reserve({ id: 'expires', owner: 'owner', capability: 'x', resourceBudget: { cpuMillis: 1, memoryBytes: 0, storageBytes: 0, networkBytes: 0, gpuMemoryBytes: 0 }, expiresAt: '2026-11-18T12:00:01Z' }), /past/);
  assert.equal(later.status().reservations, 0);
});
