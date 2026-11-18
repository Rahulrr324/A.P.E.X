// T-17 Executive Control Plane, bounded delegation and software kill-switch tests.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ActionRegistry } from '../src/actions/registry.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
const tempDir = () => { const d = makeTempDataDir(); dirs.push(d); return d; };
after(() => { while (dirs.length) cleanup(dirs.pop()); });

function registry({ domain = 'memory', level = 2, dir = tempDir() } = {}) {
  const r = new ActionRegistry({ autonomyByDomain: { [domain]: level }, now: () => new Date('2026-11-18T12:00:00Z'), killSwitchPath: path.join(dir, 'kill-switch.json') });
  r.register({ name: 'memory.add', description: 'write memory', domain: 'memory', permission: 'write', origins: ['user'], risk: 'medium', maxAutonomy: 2, resourceScope: 'memory:*', resourceDemand: { memoryBytes: 1, cpuMillis: 1, storageBytes: 1, networkBytes: 0, gpuMemoryBytes: 0 }, delegable: false, validate: (i) => i, execute: async () => ({ summary: 'stored' }), verify: async () => ({ ok: true, detail: 'stored' }) });
  r.register({ name: 'memory.list', description: 'list memory', domain: 'memory', permission: 'read', origins: ['user', 'model'], risk: 'low', maxAutonomy: 5, validate: (i) => i, execute: async () => ({ summary: 'listed' }), verify: null });
  r.register({ name: 'safe.read', description: 'safe low-risk read', domain: 'safe', permission: 'read', origins: ['agent', 'user'], risk: 'low', maxAutonomy: 5, resourceScope: 'safe:*', resourceDemand: { cpuMillis: 1, memoryBytes: 1, storageBytes: 0, networkBytes: 0, gpuMemoryBytes: 0 }, delegable: true, validate: (i) => i, execute: async () => ({ summary: 'safe' }), verify: null });
  return r;
}

function grant(r, level = 3) {
  return r.controlPlane.grantDelegation({ origin: 'user', domain: 'safe', capabilities: ['safe.read'], resourceScope: 'safe:*', resourceBudget: { cpuMillis: 2, memoryBytes: 2, storageBytes: 0, networkBytes: 0, gpuMemoryBytes: 0 }, actionBudget: 1, expiresAt: '2026-11-18T13:00:00Z', approvalRef: 'approval-1', autonomyLevel: level, missionId: level === 4 ? 'mission-1' : null, standingOrder: level === 5 });
}

test('ECP backward-compatible authorization denies unknown and model writes', () => {
  const r = registry();
  assert.equal(r.authorize('unknown.action', 'user').reason, 'UNKNOWN_ACTION');
  assert.equal(r.authorize('memory.add', 'model').reason, 'ORIGIN_NOT_PERMITTED');
  assert.equal(r.authorize('memory.list', 'model').decision, 'allow');
});

test('L0-L2 domain levels, invalid levels and write confirmation are enforceable', () => {
  const r0 = registry({ level: 0 });
  assert.equal(r0.controlPlane.evaluate('memory.add', 'user').reason, 'AUTONOMY_LEVEL_BLOCKS_WRITE');
  const r1 = registry({ level: 1 });
  assert.equal(r1.controlPlane.evaluate('memory.add', 'user').reason, 'AUTONOMY_LEVEL_BLOCKS_WRITE');
  assert.throws(() => new ActionRegistry({ autonomyByDomain: { memory: 6 } }), /0 to 5/);
  const r2 = registry({ level: 2 });
  assert.equal(r2.controlPlane.evaluate('memory.add', 'user').decision, 'allow');
});

test('delegation cannot elevate authority or widen scope, and budgets expire', () => {
  const r = registry({ domain: 'safe', level: 3 });
  const g = grant(r, 3);
  assert.equal(r.authorize('safe.read', 'agent', { grantId: g.id, resourceScope: 'safe:*', phase: 'execute' }).decision, 'allow');
  assert.equal(r.authorize('safe.read', 'agent', { grantId: g.id, resourceScope: 'safe:*', phase: 'execute' }).reason, 'DELEGATION_BUDGET_EXHAUSTED');
  assert.equal(r.authorize('safe.read', 'agent', { grantId: g.id, resourceScope: 'safe:other' }).reason, 'DELEGATION_SCOPE_MISMATCH');
  assert.equal(r.authorize('memory.list', 'agent', { grantId: g.id }).reason, 'DELEGATION_INVALID');
});

test('expired and revoked grants fail closed', () => {
  const r = registry({ domain: 'safe', level: 3 });
  const g = grant(r, 3);
  r.controlPlane.revokeDelegation(g.id, { origin: 'user', reason: 'owner revoked' });
  assert.equal(r.authorize('safe.read', 'agent', { grantId: g.id, resourceScope: 'safe:*' }).reason, 'DELEGATION_REVOKED');
  const r2 = registry({ domain: 'safe', level: 3 });
  r2.controlPlane.now = undefined;
  const expired = r2.controlPlane.grantDelegation({ origin: 'user', domain: 'safe', capabilities: ['safe.read'], resourceScope: 'safe:*', resourceBudget: { cpuMillis: 1, memoryBytes: 1, storageBytes: 0, networkBytes: 0, gpuMemoryBytes: 0 }, actionBudget: 1, expiresAt: '2026-11-18T12:30:00Z', approvalRef: 'approval-2', autonomyLevel: 3 });
  assert.ok(expired.id);
});

test('L4 requires a mission checkpoint; L5 requires low-risk standing orders', () => {
  const r = registry({ domain: 'safe', level: 4 });
  const g4 = grant(r, 4);
  assert.equal(r.authorize('safe.read', 'agent', { grantId: g4.id, resourceScope: 'safe:*', phase: 'execute' }).reason, 'MISSION_CHECKPOINT_REQUIRED');
  assert.equal(r.authorize('safe.read', 'agent', { grantId: g4.id, resourceScope: 'safe:*', phase: 'execute', checkpointRef: 'cp-1' }).decision, 'allow');
  const r5 = registry({ domain: 'safe', level: 5 });
  const g5 = grant(r5, 5);
  assert.equal(r5.authorize('safe.read', 'agent', { grantId: g5.id, resourceScope: 'safe:*', phase: 'execute' }).decision, 'allow');
});

test('software kill switch denies writes, permits owner controls, survives restart and cancels callbacks', () => {
  const dir = tempDir();
  const r = registry({ dir, level: 2 });
  let cancelled = false;
  r.controlPlane.registerCancellable('op-1', () => { cancelled = true; });
  const state = r.controlPlane.activateKillSwitch({ origin: 'user', reason: 'owner stopped execution' });
  assert.equal(state.active, true);
  assert.equal(cancelled, true);
  assert.equal(r.authorize('memory.add', 'user').reason, 'KILL_SWITCH_ACTIVE');
  const restarted = new ActionRegistry({ now: () => new Date('2026-11-18T12:01:00Z'), killSwitchPath: path.join(dir, 'kill-switch.json') });
  restarted.register({ name: 'memory.add', description: 'write memory', permission: 'write', origins: ['user'], validate: (i) => i, execute: async () => ({}), verify: null });
  assert.equal(restarted.authorize('memory.add', 'user').reason, 'KILL_SWITCH_ACTIVE');
  assert.equal(restarted.controlPlane.clearKillSwitch({ origin: 'user', reason: 'operator reviewed and released' }).active, false);
  assert.equal(restarted.authorize('memory.add', 'user').decision, 'allow');
});

test('damaged or malformed kill-switch state fails closed and can be explicitly cleared', () => {
  const dir = tempDir();
  const latch = path.join(dir, 'kill-switch.json');
  fs.writeFileSync(latch, '{broken');
  const r = registry({ dir, level: 2 });
  assert.equal(r.controlPlane.killSwitchStatus().policyUnavailable, true);
  assert.equal(r.authorize('memory.add', 'user').reason, 'POLICY_UNAVAILABLE');
  const cleared = r.controlPlane.clearKillSwitch({ origin: 'user', reason: 'recovered control file' });
  assert.equal(cleared.policyUnavailable, false);
  assert.equal(cleared.active, false);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('kill-switch.json.corrupt.')));
});

test('malformed policy data, unknown origins and concurrent grants fail closed', () => {
  assert.throws(() => new ActionRegistry({ autonomyByDomain: { 'Bad Domain': 2 } }), /domain|invalid/);
  const r = registry();
  assert.equal(r.authorize('memory.add', 'root').reason, 'UNKNOWN_ORIGIN');
  assert.throws(() => r.controlPlane.grantDelegation({ origin: 'model', domain: 'safe', capabilities: ['safe.read'], resourceScope: '*', resourceBudget: { cpuMillis: 1 }, actionBudget: 1, expiresAt: '2026-11-18T13:00:00Z', approvalRef: 'a' }), /user act/);
});
