// Implementation Batch T: the bounded epistemic world-state projection.
//
// These tests pin cognitive semantics rather than plumbing. A belief is a stored record,
// so the projection must keep user assertions separate from unverified model conclusions,
// must report a contradiction without deciding it, must treat a recorded user decision as
// a decision rather than truth, and must keep history (superseded, retracted) out of the
// current belief list while still counting it. It owns no state: the read paths here are
// proven to write nothing, call no model, and repair nothing.
//
// No live model inference is involved. The model path uses a test-double backend that
// counts calls, so "no model was asked" is measured rather than asserted in prose.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { sha256Hex } from '../src/memory/memory-store.js';
import { worldActions } from '../src/actions/world-actions.js';
import { route } from '../src/controller/router.js';
import {
  buildWorldState,
  renderWorldState,
  MAX_WORLD_BELIEFS,
  MAX_WORLD_CONFLICT_MEMBERS,
  MAX_WORLD_LIMIT,
  WORLD_RECORD_LIMIT,
} from '../src/world/world-state.js';

const AT = '2026-02-02T00:00:00.000Z';
const FIXED_NOW = () => new Date(AT);

function tempDir() {
  return makeTempDataDir();
}

function envFor(dataDir) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
}

function snapshot(dir) {
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) out[name] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

// A backend that records how often it was asked. A world-state read must leave it at zero.
function countingGateway() {
  const state = { calls: 0 };
  const backend = {
    name: 'test-double',
    provider: 'test-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'test-double', endpoint: 'test-double', model: 'test-double' }),
    health: async () => ({ available: true, detail: 'test double' }),
    async complete() {
      state.calls += 1;
      return {
        ok: true, backend: 'test-double', provider: 'test-double', model: 'test-double',
        text: 'double answer', finishReason: 'stop', truncated: false, latencyMs: 0,
      };
    },
  };
  return { gateway: new ModelGateway({ backend }), calls: state };
}

function seededApp(dir, extra = {}) {
  return createApp({ dataDir: dir, now: FIXED_NOW, gateway: new ModelGateway({ backend: new NoBackend() }), ...extra });
}

async function storeUserFact(app, content, opts = {}) {
  const step = await app.controller.runAction('memory.add', { content, ...opts }, 'user', 'op-seed');
  assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, `seed failed: ${step.summary}`);
  return step.result.data.id;
}

async function storeModelConclusion(app, content) {
  const step = await app.controller.runAction(
    'memory.save_conclusion',
    { content, operationId: 'op-source', backend: 'stub' },
    'user',
    'op-seed',
  );
  assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, `seed failed: ${step.summary}`);
  return step.result.data.id;
}

async function storeClaim(app, { subject, relationship, object, evidence = null, supersedes = [] }) {
  const res = await app.controller.knowledgeAdd({ subject, relationship, object, evidence, supersedes });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, `claim failed: ${res.output}`);
  const [newest] = await app.knowledge.list({ limit: 1 });
  return newest.id;
}

function beliefIds(world) {
  return world.beliefs.userAsserted.concat(world.beliefs.unverifiedModel).map((belief) => belief.id);
}

test('world state - empty stores read as empty and complete, and create no files', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);

  const res = await app.controller.worldState();
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
  assert.equal(res.world.complete, true);
  assert.equal(res.world.attention, false);
  assert.equal(res.world.counts.representedBeliefs, 0);
  assert.deepEqual(res.world.contradictions, []);
  assert.deepEqual(res.world.unknowns, []);
  assert.equal(res.recorded, false);
  assert.equal(res.operation, null);

  // Nothing was persisted, not even the store files.
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.match(res.display, /^World state \(read-only/);
  assert.match(res.display, /User-asserted beliefs: \(none\)/);
  assert.match(res.display, /Unknowns:       \(none detected within the projection\)/);
});

test('world state - user assertions and model conclusions stay in separate epistemic classes', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  const userId = await storeUserFact(app, 'The garage door is sticking');
  const modelId = await storeModelConclusion(app, 'The garage motor is worn out');
  const claimId = await storeClaim(app, {
    subject: 'Garage door', relationship: 'condition', object: 'sticking', evidence: 'reported by the user',
  });

  const { world } = await app.controller.worldState();
  assert.equal(world.counts.userAsserted, 2);
  assert.equal(world.counts.unverifiedModel, 1);
  assert.deepEqual(beliefIds(world).filter((id) => id !== modelId).sort(), [claimId, userId].sort());
  const listed = beliefIds(world);
  assert.ok(listed.indexOf(userId) < listed.indexOf(modelId), 'user assertions are listed before model conclusions');

  // Provenance is carried through, so a reader can see who recorded each belief.
  const modelBelief = world.beliefs.unverifiedModel[0];
  assert.equal(modelBelief.provenance.origin, 'model_output_approved_by_user');
  assert.equal(modelBelief.provenance.updateMode, 'model_proposed');
  assert.equal(modelBelief.epistemic, 'unverified_model');
  const userBelief = world.beliefs.userAsserted.find((b) => b.id === userId);
  assert.equal(userBelief.provenance.origin, 'user_request');
  assert.equal(userBelief.provenance.updateMode, 'user_confirmed');

  const display = renderWorldState(world);
  assert.match(display, /The garage door is sticking/);
  assert.ok(display.indexOf('User-asserted beliefs') < display.indexOf('Unverified model conclusions'));
  assert.ok(display.indexOf('The garage motor is worn out') > display.indexOf('Unverified model conclusions'),
    'a model conclusion is shown only in its own section');
  assert.match(display, /model conclusion\(s\) are stored but unverified/);
});

test('world state - evidence is represented and its absence is an explicit unknown', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  const withEvidence = await storeClaim(app, {
    subject: 'Project Alpha', relationship: 'owner', object: 'Riya', evidence: 'stated in the kickoff note',
  });
  const withoutEvidence = await storeClaim(app, {
    subject: 'Project Beta', relationship: 'owner', object: 'Amit',
  });

  const { world } = await app.controller.worldState();
  const supported = world.beliefs.userAsserted.find((b) => b.id === withEvidence);
  const bare = world.beliefs.userAsserted.find((b) => b.id === withoutEvidence);
  assert.equal(supported.evidence, 'stated in the kickoff note');
  assert.equal(bare.evidence, null);
  assert.ok(world.unknowns.some((u) => /no recorded evidence; their support is unknown/.test(u.detail)));
  assert.match(renderWorldState(world), /evidence: "stated in the kickoff note"/);
});

test('world state - an unresolved knowledge conflict is a contradiction that needs attention', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  const a = await storeClaim(app, { subject: 'Meeting', relationship: 'room', object: 'Birch', evidence: 'calendar invite' });
  const b = await storeClaim(app, { subject: 'Meeting', relationship: 'room', object: 'Cedar', evidence: 'email update' });

  const { world } = await app.controller.worldState();
  assert.equal(world.complete, true, 'the stores were read fully');
  assert.equal(world.attention, true, 'an unresolved contradiction must be surfaced');
  assert.equal(world.counts.unresolvedConflicts, 1);
  const group = world.contradictions[0];
  assert.equal(group.kind, 'knowledge');
  assert.equal(group.state, 'unresolved');
  assert.deepEqual(group.claimIds, [a, b].sort());
  assert.equal(group.chosenId, null);
  assert.ok(world.unknowns.some((u) => /no user decision; choose one explicitly/.test(u.detail)));

  const display = renderWorldState(world);
  assert.match(display, /unresolved\): claims/);
  assert.doesNotMatch(display, /user decision chose/, 'nothing has been decided, so nothing may read as decided');

  const cli = await runCli(['world'], envFor(dir));
  assert.equal(cli.code, 1, 'attention is required while a contradiction is unresolved');
});

test('world state - reading a conflict does not resolve it', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  await storeClaim(app, { subject: 'Meeting', relationship: 'room', object: 'Birch' });
  await storeClaim(app, { subject: 'Meeting', relationship: 'room', object: 'Cedar' });

  const before = await app.knowledge.health();
  for (let i = 0; i < 2; i += 1) await app.controller.worldState();
  const after = await app.knowledge.health();
  assert.deepEqual(after, before, 'the projection cannot change the store it reads');
  assert.equal(after.conflicts.groups, 1);
  assert.equal(after.conflicts.resolvedGroups, 0);
});

test('world state - a recorded user decision is a decision, never verified truth', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  const a = await storeClaim(app, { subject: 'Meeting', relationship: 'room', object: 'Birch' });
  const b = await storeClaim(app, { subject: 'Meeting', relationship: 'room', object: 'Cedar' });
  const res = await app.controller.knowledgeResolve({ target: a, choose: b, reason: 'reception confirmed' });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED);

  const { world } = await app.controller.worldState();
  assert.equal(world.counts.resolvedConflicts, 1);
  assert.equal(world.counts.unresolvedConflicts, 0);
  assert.equal(world.attention, false, 'a decided conflict no longer needs attention');
  const group = world.contradictions[0];
  assert.equal(group.state, 'resolved');
  assert.equal(group.chosenId, b);
  assert.ok(group.reason);
  // Both claims stay stored and represented: a decision does not delete evidence.
  assert.ok(beliefIds(world).includes(a));
  assert.ok(beliefIds(world).includes(b));

  const display = renderWorldState(world);
  assert.match(display, /a decision, not verified truth/);
  assert.equal((await runCli(['world'], envFor(dir))).code, 0);
});

test('world state - superseded and retracted records are history, not current beliefs', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  const oldRoom = await storeClaim(app, { subject: 'Standup', relationship: 'room', object: 'Birch' });
  const newRoom = await storeClaim(app, {
    subject: 'Standup', relationship: 'room', object: 'Cedar', supersedes: [oldRoom],
  });
  const temporary = await storeClaim(app, { subject: 'Old vendor', relationship: 'contract', object: 'active' });
  const retract = await app.controller.knowledgeRetract({ target: temporary, reason: 'contract ended' });
  assert.equal(retract.status, Outcome.SUCCESS_VERIFIED);

  const { world } = await app.controller.worldState();
  const listed = beliefIds(world);
  assert.ok(listed.includes(newRoom));
  assert.ok(!listed.includes(oldRoom), 'a superseded claim is not presented as current');
  assert.ok(!listed.includes(temporary), 'a retracted claim is not presented as current');
  assert.equal(world.history.superseded, 1);
  assert.equal(world.history.retracted, 1);
  assert.match(renderWorldState(world), /History:        1 superseded, 1 retracted/);
  assert.match(renderWorldState(world), /history or decisions, not beliefs/);
  assert.equal(world.attention, false);
});

test('world state - a memory contradiction is one subject group, and an explicit correction clears it', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  const blue = await storeUserFact(app, 'My favourite colour is blue');
  const green = await storeUserFact(app, 'My favourite colour is green');

  const first = (await app.controller.worldState()).world;
  assert.equal(first.counts.memoryConflictGroups, 1);
  assert.equal(first.attention, true);
  const group = first.contradictions[0];
  assert.equal(group.kind, 'memory');
  assert.equal(group.state, 'unresolved');
  assert.deepEqual(new Set(group.claimIds), new Set([blue, green]));
  assert.match(group.note, /heuristic clause match/);
  assert.equal(group.valueCount, 2);
  assert.match(renderWorldState(first), /memory subject group\(s\) in the projection carry different values/);
  assert.match(renderWorldState(first), /memory \(unresolved\): claims/);

  // A third value for the same subject is still one disagreement, not two more pairs.
  await storeUserFact(app, 'My favourite colour is amber');
  const three = (await app.controller.worldState()).world;
  assert.equal(three.counts.memoryConflictGroups, 1, 'a contested subject is reported once');
  assert.equal(three.contradictions[0].valueCount, 3);
  assert.equal(three.contradictions[0].claimIds.length, 3);

  // A user-confirmed correction supersedes the earlier claim, so it is no longer a belief.
  const step = await app.controller.runAction(
    'memory.correct',
    { targetId: blue, content: 'My favourite colour is green', resolve: true },
    'user',
    'op-correct',
  );
  assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);

  const second = (await app.controller.worldState()).world;
  assert.ok(second.counts.memoryConflictGroups >= 1);
  assert.ok(!beliefIds(second).includes(blue), 'the corrected claim is history, not a belief');
  assert.ok(beliefIds(second).includes(green));
});

test('world state - a value that only qualifies another is not reported as a contradiction', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  await storeUserFact(app, 'My favourite colour is blue');
  await storeUserFact(app, 'My favourite colour is blue on weekends');

  const { world } = await app.controller.worldState();
  assert.equal(world.counts.memoryConflictGroups, 0, 'the projection uses the store clause rule');
  assert.equal(world.attention, false);
  assert.equal(world.contradictions.length, 0);
});

test('world state - a large contested subject is listed within bounds', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  const colours = ['crimson', 'umber', 'indigo', 'sienna', 'cobalt', 'ochre', 'vermilion', 'sepia', 'azure', 'puce', 'teal', 'buff'];
  for (const colour of colours) {
    await storeUserFact(app, `The archive index is colour ${colour}`);
  }

  const { world } = await app.controller.worldState();
  assert.equal(world.counts.memoryConflictGroups, 1);
  const group = world.contradictions[0];
  assert.equal(group.claimIds.length, colours.length);
  assert.equal(group.valueCount, colours.length);
  assert.equal(group.claims.length, MAX_WORLD_CONFLICT_MEMBERS, 'listed members are bounded');
  const display = renderWorldState(world);
  assert.match(display, /\(\+4 more record\(s\) in this group\)/);
  assert.equal(display.split('\n').filter((line) => line.includes('memory (unresolved)')).length, 1);
});

test('world state - private memory is marked, and the projection is not available to model origin', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  const privateId = await storeUserFact(app, 'My dentist appointment is Tuesday', { sensitivity: 'private' });

  const { world } = await app.controller.worldState();
  const belief = world.beliefs.userAsserted.find((b) => b.id === privateId);
  assert.equal(belief.private, true);
  assert.equal(world.counts.private, 1);
  assert.match(renderWorldState(world), /\[private: never sent to a model\]/);

  // A model must not be able to ask for a read that can surface private memory.
  assert.doesNotMatch(app.controller.readableActions(), /world\.state/, 'the projection is not offered to the model');
  const denied = await app.controller.runAction('world.state', {}, 'model', 'op-model');
  assert.equal(denied.outcome, Outcome.ACTION_DENIED);
  assert.equal(denied.result, null);
});

test('world state - the audited result carries counts and ids only, never belief content', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  const id = await storeUserFact(app, 'The spare key sits behind the planter');

  const step = await app.controller.runAction('world.state', {}, 'user', 'op-world');
  assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
  const serialized = JSON.stringify(step.result.data);
  assert.doesNotMatch(serialized, /spare key|planter/, 'the audited result holds no belief statement');
  assert.doesNotMatch(step.summary, /spare key|planter/);
  assert.ok(serialized.includes('counts'));
  assert.ok(step.result.data.beliefIds.includes(id), 'the ids read are recorded so a later reader can re-derive them');
  assert.equal(step.verification.outcome, Outcome.SUCCESS_VERIFIED);
});

test('world state - a damaged memory store does not erase the knowledge projection', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  const claimId = await storeClaim(app, { subject: 'Router', relationship: 'firmware', object: '2.4.1' });
  await storeUserFact(app, 'The router firmware was checked manually');
  const memoryPath = path.join(dir, 'memory.jsonl');
  const good = fs.readFileSync(memoryPath, 'utf8');
  fs.writeFileSync(memoryPath, `{not json\n${good}`, 'utf8');

  const res = await app.controller.worldState();
  assert.equal(res.status, Outcome.EXECUTION_FAILED, 'an incomplete projection is not reported as verified success');
  assert.equal(res.world.complete, false);
  assert.equal(res.world.attention, true);
  assert.equal(res.world.sources.memory.inspected, true);
  assert.equal(res.world.sources.memory.corruptLines, 1);
  assert.equal(res.world.sources.knowledge.inspected, true);
  // The readable store is still represented.
  assert.ok(beliefIds(res.world).includes(claimId));
  assert.equal(res.world.beliefs.userAsserted.filter((b) => b.store === 'memory').length, 0,
    'a damaged store contributes no beliefs rather than a partial guess');
  assert.ok(res.world.unknowns.some((u) => /memory store has 1 corrupt line/.test(u.detail)));
  assert.match(res.display, /memory: damaged - 1 corrupt line\(s\); incomplete/);
  assert.equal((await runCli(['world'], envFor(dir))).code, 1);
});

test('world state - an unreadable store is unavailable, never silently empty', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.join(dir, 'memory.jsonl'));
  const app = seededApp(dir);
  const claimId = await storeClaim(app, { subject: 'Router', relationship: 'firmware', object: '2.4.1' });

  const { world } = await app.controller.worldState();
  assert.equal(world.complete, false);
  assert.equal(world.attention, true);
  assert.equal(world.sources.memory.inspected, false);
  assert.equal(world.sources.memory.records, null);
  assert.equal(world.sources.knowledge.records, 1);
  assert.ok(beliefIds(world).includes(claimId));
  assert.ok(world.unknowns.some((u) => /memory store is unavailable/.test(u.detail)));
  assert.match(renderWorldState(world), /memory: unavailable/);
  // Zero memory beliefs here is not evidence of an empty memory, and the projection says
  // so instead of claiming completeness.
  assert.equal(world.beliefs.userAsserted.filter((b) => b.store === 'memory').length, 0);
});

test('world state - the projection is bounded and announces what it left out', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  await storeUserFact(app, 'The first stored claim is recorded');
  await storeUserFact(app, 'The second stored claim is recorded');
  await storeUserFact(app, 'The third stored claim is recorded');
  const read = (options) => buildWorldState({ memory: app.memory, knowledge: app.knowledge, now: FIXED_NOW, ...options });

  const small = await read({ limit: 1 });
  assert.equal(small.beliefs.shown, 1);
  assert.equal(small.counts.representedBeliefs, 3);
  assert.ok(small.unknowns.some((u) => /not shown because the projection is bounded to 1/.test(u.detail)));

  const window = await read({ recordLimit: 2 });
  assert.equal(window.counts.representedBeliefs, 2, 'the read window bounds represented records');
  assert.ok(window.unknowns.some((u) => /most recent 2 records per store are represented/.test(u.detail)));

  const clamped = await read({ limit: 5000 });
  assert.equal(clamped.beliefs.total, 3);
  assert.ok(clamped.limits.length >= 5);
  assert.equal(clamped.beliefs.shown, 3);
  assert.equal(MAX_WORLD_BELIEFS, 20);
  assert.equal(MAX_WORLD_LIMIT, 50);
  assert.equal(WORLD_RECORD_LIMIT, 100);
});

test('world state - direct reads write nothing, change nothing, and call no model', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const { gateway, calls } = countingGateway();
  const app = seededApp(dir, { gateway });
  await storeUserFact(app, 'The lease renewal date is pending');
  await storeUserFact(app, 'The lease renewal needs the landlord');
  await storeClaim(app, { subject: 'Lease', relationship: 'renewal', object: 'pending' });

  const before = snapshot(dir);
  assert.ok(Object.keys(before).includes('memory.jsonl'));
  assert.ok(Object.keys(before).includes('operations.jsonl'));
  const auditBefore = before['operations.jsonl'];

  for (let i = 0; i < 3; i += 1) {
    const res = await app.controller.worldState();
    assert.equal(res.recorded, false);
    assert.equal(res.operation, null);
    const step = await app.controller.runAction('world.state', {}, 'user', 'op-read');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
  }

  assert.deepEqual(snapshot(dir), before, 'a world-state read must not modify any file');
  assert.equal(auditBefore, before['operations.jsonl']);
  assert.equal(calls.calls, 0, 'the projection must not call a model');

  const invalid = await app.controller.runAction('world.state', { limit: 0 }, 'user', 'op-bad');
  assert.equal(invalid.outcome, Outcome.INPUT_REJECTED);
  assert.deepEqual(snapshot(dir), before, 'a rejected read writes nothing either');
});

test('world state - repeated reads are reproducible for the same stored state', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  await storeUserFact(app, 'The warranty ends in March');
  await storeClaim(app, { subject: 'Warranty', relationship: 'covers', object: 'the motor' });

  const first = await buildWorldState({ memory: app.memory, knowledge: app.knowledge, now: FIXED_NOW });
  const second = await buildWorldState({ memory: app.memory, knowledge: app.knowledge, now: FIXED_NOW });
  assert.deepEqual(first, second);
  assert.equal(first.generatedAt, AT);
  assert.deepEqual(renderWorldState(first), renderWorldState(second));
});

test('world state - the projection survives a restart', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  await storeUserFact(app, 'The invoice approval is with Priya');
  const a = await storeClaim(app, { subject: 'Invoice', relationship: 'approver', object: 'Priya' });
  const b = await storeClaim(app, { subject: 'Invoice', relationship: 'approver', object: 'Nikhil' });
  const before = (await app.controller.worldState()).world;

  const reopened = seededApp(dir);
  const after = (await reopened.controller.worldState()).world;
  assert.deepEqual(after.counts, before.counts);
  assert.deepEqual(beliefIds(after).sort(), beliefIds(before).sort());
  assert.equal(after.attention, true);
  assert.deepEqual(after.contradictions[0].claimIds, [a, b].sort());
});

test('world state - a routed question is answered from the stores without a model', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const { gateway, calls } = countingGateway();
  const app = seededApp(dir, { gateway });
  await storeUserFact(app, 'The backup server is offline');

  for (const question of [
    'what conflicts do you have',
    'which contradictions are stored?',
    'what is currently unresolved',
    'what do you believe',
  ]) {
    const res = await app.controller.handle(question);
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, `"${question}" -> ${res.status}: ${res.output}`);
    assert.match(res.display, /World state \(read-only/);
  }
  assert.equal(calls.calls, 0, 'these questions are answered by the stores, not a model');

  // A question about a topic stays on the model path; the projection is not a keyword trap.
  for (const question of ['what do you believe about quantum tunnelling', 'what conflicts with my schedule tomorrow']) {
    const routed = route(question);
    assert.notEqual(routed?.action, 'world.state', `"${question}" must not be answered by the projection`);
  }

  const operations = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  const worldOps = operations.filter((record) => record.capability === 'world.state');
  assert.equal(worldOps.length, 4, 'a routed read is audited like any other operation');
  assert.ok(worldOps.every((record) => record.status === Outcome.SUCCESS_VERIFIED));
  assert.doesNotMatch(JSON.stringify(worldOps), /backup server/, 'the audit record holds no belief content');

  // Conversation history keeps the bounded summary, never the stored content.
  const turns = fs.readFileSync(path.join(dir, 'conversation.jsonl'), 'utf8');
  assert.doesNotMatch(turns, /backup server/);
});

test('world state - a store that changes mid-read fails verification instead of claiming success', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  const definition = worldActions()[0];
  const firstId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const secondId = 'bbbbbbbb-2222-4222-8222-222222222222';
  let reads = 0;
  // A store double shaped like the real projectionRead: one consulted method that returns
  // the integrity summary and the record window from the same read. The counter is what
  // makes the two reads distinguishable - if verification reused the first read's object,
  // the second read would never happen and the change would go unnoticed.
  const ctx = {
    memory: {
      async projectionRead() {
        reads += 1;
        const id = reads === 1 ? firstId : secondId;
        return {
          health: { inspected: true, corruptLines: 0, records: 1 },
          records: [{ id, content: `Claim ${reads}`, source: 'user', createdAt: AT }],
        };
      },
    },
    knowledge: {
      async projectionRead() {
        return {
          health: { inspected: true, corruptLines: 0, claims: 0, conflicts: { groups: 0, resolvedGroups: 0 } },
          claims: [],
        };
      },
    },
    now: FIXED_NOW,
  };

  const result = await definition.execute(ctx, { limit: undefined });
  const verification = await definition.verify(ctx, { limit: undefined }, result);
  assert.equal(reads, 2, 'the store is consulted again, independently, during verification');
  assert.equal(verification.ok, false);
  assert.match(verification.detail, /second read produced a different world-state projection/);

  // The same action does confirm when the stores are stable.
  const stable = await app.controller.runAction('world.state', {}, 'user', 'op-stable');
  assert.equal(stable.outcome, Outcome.SUCCESS_VERIFIED);
  assert.match(stable.verification.detail, /independent read/);
});

test('world state - stored records without a recorded update mode still project safely', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  // Records written before updateMode was part of the stored shape: the validator accepts
  // them, so the projection must classify them from `source` rather than fail or invent a
  // user confirmation for a model record.
  const userId = 'cccccccc-3333-4333-8333-333333333333';
  const modelId = 'eeeeeeee-5555-4555-8555-555555555555';
  const lines = [
    {
      schema: 1,
      id: userId,
      kind: 'user_fact',
      source: 'user',
      sensitivity: 'normal',
      content: 'The old record has no update mode',
      contentSha256: sha256Hex('The old record has no update mode'),
      createdAt: AT,
      provenance: { origin: 'user_request' },
    },
    {
      schema: 1,
      id: modelId,
      kind: 'model_conclusion',
      source: 'model',
      sensitivity: 'normal',
      content: 'The old conclusion has no update mode',
      contentSha256: sha256Hex('The old conclusion has no update mode'),
      createdAt: AT,
      provenance: { origin: 'model_output_approved_by_user' },
    },
  ].map((record) => JSON.stringify(record)).join('\n');
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), `${lines}\n`, 'utf8');

  const app = seededApp(dir);
  const claimId = await storeClaim(app, { subject: 'Old claim', relationship: 'mentions', object: 'nothing else' });

  const res = await app.controller.worldState();
  assert.equal(res.world.complete, true);
  assert.equal(res.world.sources.memory.corruptLines, 0);
  const ids = beliefIds(res.world);
  assert.ok(ids.includes(userId), 'an older memory record is still represented');
  assert.ok(ids.includes(modelId));
  assert.ok(ids.includes(claimId));
  assert.deepEqual(res.world.beliefs.unverifiedModel.map((b) => b.id), [modelId],
    'a stored model record stays a model conclusion even with no stored update mode');
  const userBelief = res.world.beliefs.userAsserted.find((b) => b.id === userId);
  assert.equal(userBelief.provenance.updateMode, 'user_confirmed');
  assert.equal(userBelief.provenance.origin, 'user_request');
  const claimBelief = res.world.beliefs.userAsserted.find((b) => b.id === claimId);
  assert.equal(claimBelief.evidence, null);
});

test('world state - the CLI reads the projection without writing and bounds its output', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = seededApp(dir);
  await storeUserFact(app, 'The archive index is rebuilt weekly');
  const env = envFor(dir);
  const before = snapshot(dir);

  const clean = await runCli(['world'], env);
  assert.equal(clean.code, 0);
  assert.match(clean.stdout, /World state \(read-only/);
  assert.deepEqual(snapshot(dir), before, 'the CLI read must not write');

  await storeClaim(app, { subject: 'Archive index', relationship: 'owner', object: 'Riya' });
  await storeClaim(app, { subject: 'Archive index', relationship: 'owner', object: 'Amit' });
  const afterWrites = snapshot(dir);
  const busy = await runCli(['world'], env);
  assert.equal(busy.code, 1);
  assert.match(busy.stdout, /unresolved\): claims/);
  assert.deepEqual(snapshot(dir), afterWrites, 'the CLI read still writes nothing');

  const bounded = await runCli(['world', '--limit', '1'], env);
  assert.equal(bounded.code, 1);
  assert.match(bounded.stdout, /1 of \d+ represented belief\(s\) shown/);

  for (const bad of [['world', '--limit', '0'], ['world', '--limit', '51'], ['world', 'extra']]) {
    const res = await runCli(bad, env);
    assert.equal(res.code, 2, `"${bad.join(' ')}" is a usage error`);
    assert.match(res.stderr, /usage: world \[--limit N\]/);
  }
  const notNumber = await runCli(['world', '--limit', 'abc'], env);
  assert.equal(notNumber.code, 2);
  assert.match(notNumber.stderr, /--limit needs a whole number/);
  assert.deepEqual(snapshot(dir), afterWrites, 'a rejected CLI call writes nothing');
});
