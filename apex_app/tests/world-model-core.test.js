// World Model core: append-only records, reducer, temporal queries, contradictions, identity,
// evidence validation, integrity and the prompt view.
//
// These tests drive WorldModelStore directly with a fixed clock and deterministic ids. No model,
// no network and no existing user store is involved: every byte read here was written by the test
// into a temporary directory. What is demonstrated is the subsystem's own contract - what it
// records, what it refuses, and what it reports - not real inference or a real backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WorldModelStore } from '../src/world/store.js';
import {
  WORLD_MODEL_DISCIPLINE,
  buildWorldModelContext,
  worldModelRelevant,
  worldModelRequested,
} from '../src/world/context.js';
import { StoreError, ValidationError } from '../src/errors.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const T0 = '2024-01-01T00:00:00.000Z';
const UE = [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }];

function tempDir() { return makeTempDataDir(); }

function clock(start = T0) {
  let at = start;
  return { now: () => new Date(at), set: (value) => { at = value; }, at: () => at };
}

function newStore(dir, { time = clock(), sources = {} } = {}) {
  let n = 0;
  return new WorldModelStore(path.join(dir, 'world-model.jsonl'), {
    now: time.now,
    idFactory: () => `rec-${String(n += 1).padStart(4, '0')}`,
    sources,
    lockWaitMs: 5000,
  });
}

async function rejectsWith(promise, pattern, type = ValidationError) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof type, `expected ${type.name}, got ${err?.name}: ${err?.message}`);
    assert.match(err.message, pattern);
    return true;
  });
}

async function addEntity(store, entityId, name, { category = 'project', ...extra } = {}) {
  const { record } = await store.createEntity({ origin: 'user', entityId, category, name, evidence: UE, ...extra });
  return record;
}

async function addFact(store, factId, subjectId, predicate, object, extra = {}) {
  const { record } = await store.assertFact({ origin: 'user', factId, subjectId, predicate, object, evidence: UE, ...extra });
  return record;
}

async function addRelationship(store, relationshipId, subjectId, predicate, objectId, extra = {}) {
  const { record } = await store.assertRelationship({
    origin: 'user', relationshipId, subjectId, predicate, objectId, evidence: UE, ...extra,
  });
  return record;
}

const scalar = (value, valueType = 'string', extra = {}) => ({ kind: 'scalar', valueType, value, ...extra });
const entityObject = (entityId) => ({ kind: 'entity', entityId });

// ---- entities ---------------------------------------------------------------

test('entities: stable ids, aliases, lifecycle, and names that select more than one entity', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const time = clock();
  const store = newStore(dir, { time });

  const alpha = await addEntity(store, 'e-alpha-01', 'Atlas Relay', {
    category: 'device', aliases: ['Relay Alpha'], description: 'a relay unit',
    externalIds: [{ scheme: 'registry', value: 'AR-1' }], observedAt: '2024-01-01',
  });
  assert.equal(alpha.entityId, 'e-alpha-01', 'the caller-supplied id is stored as given');
  assert.equal(alpha.origin, 'user');
  assert.equal(alpha.at, T0);
  await addEntity(store, 'e-beta-02', 'Beta Relay', { aliases: ['Relay Beta'] });
  await addEntity(store, 'e-mercury-01', 'Mercury', { category: 'project' });
  await addEntity(store, 'e-mercury-02', 'Mercury', { category: 'product' });

  const listed = await store.listEntities();
  assert.equal(listed.total, 4);
  assert.deepEqual(listed.entities.map((e) => e.id), ['e-alpha-01', 'e-beta-02', 'e-mercury-01', 'e-mercury-02']);

  // A name that selects two active entities is an ambiguity, never a first match.
  const ambiguous = await store.showEntity('Mercury');
  assert.equal(ambiguous.entity, null);
  assert.match(ambiguous.problem, /matches 2 active entities/);
  assert.match(ambiguous.problem, /identity is not inferred from a name/);
  assert.equal(ambiguous.resolved.candidates.length, 2);
  await rejectsWith(store.facts('Mercury'), /matches 2 active entities/);

  // A unique id prefix resolves; a prefix shared by several entities does not.
  const byPrefix = await store.showEntity('e-alph');
  assert.equal(byPrefix.entity.id, 'e-alpha-01');
  assert.equal(byPrefix.resolved.matchedBy, 'id-prefix');
  const sharedPrefix = await store.showEntity('e-me');
  assert.equal(sharedPrefix.entity, null);
  assert.match(sharedPrefix.problem, /prefix of 2 entity ids/);

  const found = await store.findEntities('relay alpha');
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].matchedOn, 'alias');

  // The same alias cannot be recorded twice; a second entity id cannot reuse an id.
  await rejectsWith(
    store.addAlias({ origin: 'user', entityId: 'e-alpha-01', alias: 'relay alpha', evidence: UE }),
    /refused: this alias is already recorded for the entity/,
  );
  await rejectsWith(
    store.createEntity({ origin: 'user', entityId: 'e-alpha-01', category: 'device', name: 'Other', evidence: UE }),
    /refused: entity id already exists/,
  );
  await rejectsWith(
    store.createEntity({ origin: 'user', entityId: 'e-dup', category: 'device', name: 'Dup', aliases: ['Ace', 'ace'], evidence: UE }),
    /an alias is listed twice/,
  );

  // Retirement is a recorded fact: it hides the entity from ordinary listing but not from
  // history, and no new statement may name it.
  await store.retireEntity({ origin: 'user', entityId: 'e-beta-02', reason: 'decommissioned', evidence: UE });
  const afterRetire = await store.listEntities();
  assert.equal(afterRetire.total, 3);
  const withRetired = await store.listEntities({ includeRetired: true });
  assert.equal(withRetired.total, 4);
  assert.equal(withRetired.entities.find((e) => e.id === 'e-beta-02').status, 'retired');
  await rejectsWith(
    store.assertFact({ origin: 'user', factId: 'f-retired', subjectId: 'e-beta-02', predicate: 'has_status', object: scalar('on'), evidence: UE }),
    /refused: subject entity e-beta-02 is retired/,
  );
  await rejectsWith(
    store.addAlias({ origin: 'user', entityId: 'e-beta-02', alias: 'Ghost', evidence: UE }),
    /refused: entity is retired/,
  );
  const shown = await store.showEntity('e-beta-02');
  assert.equal(shown.entity.status, 'retired');
  assert.equal(shown.entity.retiredReason, 'decommissioned');
  assert.equal(shown.entity.externalIds.length, 0);
  assert.ok(shown.history.some((entry) => entry.type === 'entity_retired'));
});

// ---- facts and valid time ---------------------------------------------------

test('facts: validity, historical values, unknown validity, and typed scalars', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = newStore(dir);

  await addEntity(store, 'e-locker', 'Parcel Locker', { category: 'device' });
  await addFact(store, 'f-status-op', 'e-locker', 'has_status', scalar('operational'), {
    validFrom: '2024-01-01', validUntil: '2024-06-01',
  });
  await addFact(store, 'f-status-maint', 'e-locker', 'has_status', scalar('maintenance'), {
    validFrom: '2024-06-01', observedAt: '2024-06-02',
  });
  await addFact(store, 'f-located', 'e-locker', 'located_in', scalar('bay 4'), {
    validFrom: '2024-01-01', validUntil: '2024-03-01',
  });
  const unknown = await addFact(store, 'f-described', 'e-locker', 'described_as', scalar('blue steel unit'));
  await addFact(store, 'f-weight', 'e-locker', 'weight', scalar(2.5, 'number', { unit: 'kg' }), { validFrom: '2024-01-01' });
  await addFact(store, 'f-open', 'e-locker', 'is_open', scalar(true, 'boolean'), { validFrom: '2024-01-01' });
  await addFact(store, 'f-checked', 'e-locker', 'last_checked', scalar('2024-02-02T10:00:00Z', 'datetime'), { validFrom: '2024-01-01' });
  await addFact(store, 'f-label', 'e-locker', 'label', scalar('boîte', 'string', { language: 'fr' }), { validFrom: '2024-01-01' });

  const july = await store.facts('e-locker', { at: '2024-07-01' });
  const statuses = july.facts.filter((fact) => fact.predicate === 'has_status');
  assert.deepEqual(statuses.map((fact) => [fact.id, fact.status]), [
    ['f-status-op', 'historical'],
    ['f-status-maint', 'supported'],
  ]);

  // As-of filters by valid time while each row's status is computed at the read instant.
  const march = await store.facts('e-locker', { asOf: '2024-03-15', at: '2024-07-01' });
  assert.deepEqual(march.facts.filter((fact) => fact.predicate === 'has_status').map((fact) => fact.id), ['f-status-op']);
  assert.equal(march.problem, null);
  assert.match(march.note, /valid time covers 2024-03-15/);

  // An unknown valid-from is not current and is never rendered as a value.
  assert.equal(unknown.validFrom, null);
  assert.equal(july.facts.find((fact) => fact.id === 'f-described').status, 'validity_unknown');
  const attributes = await store.attributes('e-locker', { at: '2024-07-01' });
  assert.deepEqual(Object.keys(attributes.attributes).sort(), ['has_status', 'is_open', 'label', 'last_checked', 'weight']);
  assert.equal(attributes.attributes.has_status.length, 1);
  assert.equal(attributes.attributes.has_status[0].id, 'f-status-maint');

  const labels = Object.fromEntries(july.facts.map((fact) => [fact.id, fact.objectLabel]));
  assert.equal(labels['f-weight'], '2.5 kg');
  assert.equal(labels['f-open'], 'true');
  assert.equal(labels['f-checked'], '2024-02-02T10:00:00Z');
  assert.equal(july.facts.find((fact) => fact.id === 'f-label').object.language, 'fr');

  // A local-time string would parse differently on two machines, so it is refused.
  await rejectsWith(
    store.assertFact({ origin: 'user', subjectId: 'e-locker', predicate: 'has_status', object: scalar('x'), validFrom: '2024-05-01T09:00:00', evidence: UE }),
    /validFrom must be an ISO date or an ISO date-time with a time zone/,
  );
  await rejectsWith(
    store.assertFact({ origin: 'user', subjectId: 'e-locker', predicate: 'has_status', object: scalar('x'), validFrom: 'not-a-date', evidence: UE }),
    /validFrom must be an ISO date or an ISO date-time with a time zone/,
  );
  await rejectsWith(
    store.assertFact({ origin: 'user', subjectId: 'e-locker', predicate: 'has_status', object: scalar('x'), validFrom: '2024-05-01', validUntil: '2024-04-01', evidence: UE }),
    /validUntil is before validFrom/,
  );
  await rejectsWith(
    store.assertFact({ origin: 'user', subjectId: 'e-nope', predicate: 'has_status', object: scalar('x'), evidence: UE }),
    /subject entity: no entity matches "e-nope"/,
  );
  await rejectsWith(
    store.createEntity({ origin: 'user', entityId: 'e-none', category: 'device', name: 'No Evidence' }),
    /evidence must be a list of references/,
  );
});

// ---- contradictions ---------------------------------------------------------

test('contradictions: single-valued overlap is kept unresolved with both sides', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const sources = {
    memory: async (id) => (id === 'mem-contra'
      ? { found: true, active: true, classification: 'recorded_claim' }
      : { found: false }),
  };
  const store = newStore(dir, { sources });

  await addEntity(store, 'e-site', 'Atlas Site', { category: 'project' });
  await addFact(store, 'f-active', 'e-site', 'has_status', scalar('active'), { validFrom: '2024-01-01' });
  await addFact(store, 'f-paused', 'e-site', 'has_status', scalar('paused'), { validFrom: '2024-03-01' });
  // Two values of a multi-valued predicate are not a contradiction.
  await addFact(store, 'f-tech-a', 'e-site', 'uses_technology', scalar('node'), { validFrom: '2024-01-01' });
  await addFact(store, 'f-tech-b', 'e-site', 'uses_technology', scalar('sqlite'), { validFrom: '2024-01-01' });
  // Non-overlapping intervals are a change of value, not a disagreement.
  await addFact(store, 'f-loc-a', 'e-site', 'located_in', scalar('building a'), {
    validFrom: '2024-01-01', validUntil: '2024-02-01',
  });
  await addFact(store, 'f-loc-b', 'e-site', 'located_in', scalar('building b'), { validFrom: '2024-02-01' });

  // A statement that cites contradicting evidence is contested, even when nothing else disagrees.
  await addFact(store, 'f-note', 'e-site', 'described_as', scalar('quiet site'), {
    validFrom: '2024-01-01',
    evidence: [{ relation: 'contradicts', sourceType: 'memory', sourceId: 'mem-contra' }],
  });

  const conflicts = await store.conflicts({ now: '2024-04-01' });
  const statusGroup = conflicts.groups.find((group) => group.predicate === 'has_status');
  assert.ok(statusGroup, 'overlapping single-valued values are a group');
  assert.equal(statusGroup.kind, 'fact');
  assert.equal(statusGroup.state, 'active');
  assert.equal(statusGroup.resolved, false);
  assert.deepEqual(statusGroup.memberIds.sort(), ['f-active', 'f-paused']);
  assert.equal(statusGroup.members.find((m) => m.id === 'f-active').value, 'active');
  assert.deepEqual(statusGroup.members.find((m) => m.id === 'f-paused').evidence, ['user:user']);
  assert.equal(conflicts.groups.filter((group) => group.predicate === 'uses_technology').length, 0);
  assert.equal(conflicts.groups.filter((group) => group.predicate === 'located_in').length, 0);

  const facts = await store.facts('e-site', { at: '2024-04-01' });
  assert.equal(facts.facts.find((fact) => fact.id === 'f-active').status, 'conflicting');
  assert.equal(facts.facts.find((fact) => fact.id === 'f-paused').status, 'conflicting');
  assert.equal(facts.facts.find((fact) => fact.id === 'f-note').status, 'contested');
  assert.deepEqual(conflicts.contested.map((entry) => entry.id), ['f-note']);

  // Two active entities claiming one trusted external identifier are an identity disagreement;
  // they are reported, never merged automatically.
  await addEntity(store, 'e-acme-1', 'Acme One', { category: 'organization', externalIds: [{ scheme: 'registry', value: 'ACME-7' }] });
  await addEntity(store, 'e-acme-2', 'Acme Two', { category: 'organization', externalIds: [{ scheme: 'registry', value: 'acme-7' }] });
  const second = await store.conflicts({ now: '2024-04-01' });
  const identity = second.groups.find((group) => group.kind === 'identity');
  assert.ok(identity);
  assert.deepEqual(identity.entityIds.sort(), ['e-acme-1', 'e-acme-2']);
  assert.equal(identity.resolved, false);
});

test('contradictions: single-valued relationship conflicts and historical status', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = newStore(dir);
  await addEntity(store, 'e-alice', 'Alice', { category: 'person' });
  await addEntity(store, 'e-acme', 'Acme', { category: 'organization' });
  await addEntity(store, 'e-beta', 'Beta', { category: 'organization' });

  await addRelationship(store, 'r-acme', 'e-alice', 'employed_by', 'e-acme', { validFrom: '2024-01-01', validUntil: '2024-06-01' });
  await addRelationship(store, 'r-beta', 'e-alice', 'employed_by', 'e-beta', { validFrom: '2024-05-01', validUntil: '2024-09-01' });

  const current = await store.conflicts({ now: '2024-07-01' });
  const group = current.groups.find((entry) => entry.kind === 'relationship');
  assert.ok(group);
  assert.equal(group.predicate, 'employed_by');
  assert.equal(group.state, 'historical', 'neither overlapping interval covers the read instant');
  assert.deepEqual(group.memberIds.sort(), ['r-acme', 'r-beta']);

  const live = await store.conflicts({ now: '2024-05-15' });
  assert.equal(live.groups.find((entry) => entry.kind === 'relationship').state, 'active');
});

// ---- relationships ----------------------------------------------------------

test('relationships: directionality, inverse labels, one stored edge, and refusals', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = newStore(dir);
  await addEntity(store, 'e-alice', 'Alice', { category: 'person' });
  await addEntity(store, 'e-acme', 'Acme', { category: 'organization' });
  await addEntity(store, 'e-beta', 'Beta', { category: 'organization' });
  await addEntity(store, 'e-x', 'X', { category: 'concept' });
  await addEntity(store, 'e-y', 'Y', { category: 'concept' });

  await addRelationship(store, 'r-1', 'e-alice', 'employed_by', 'e-acme', { validFrom: '2024-01-01' });
  await addRelationship(store, 'r-sym', 'e-x', 'associated_with', 'e-y', { validFrom: '2024-01-01' });
  await addRelationship(store, 'r-custom', 'e-x', 'collaborates_with', 'e-acme', { validFrom: '2024-01-01' });

  const alice = await store.relationships('e-alice', { at: '2024-02-01' });
  assert.equal(alice.relationships.length, 1);
  assert.equal(alice.outgoing[0].label, 'employed_by');
  assert.equal(alice.outgoing[0].counterpartId, 'e-acme');

  const acme = await store.relationships('e-acme', { at: '2024-02-01' });
  const incoming = acme.incoming.find((row) => row.id === 'r-1');
  assert.ok(incoming);
  assert.equal(incoming.label, 'employs', 'the inverse is a view, not a second stored edge');
  assert.equal(acme.relationships.filter((row) => row.id === 'r-1').length, 1);

  const x = await store.relationships('e-x', { at: '2024-02-01' });
  const symOut = x.outgoing.find((row) => row.id === 'r-sym');
  assert.equal(symOut.label, 'associated_with');
  assert.equal(symOut.directionality, 'symmetric');
  const y = await store.relationships('e-y', { at: '2024-02-01' });
  assert.equal(y.incoming.find((row) => row.id === 'r-sym').label, 'associated_with');
  const customIn = acme.incoming.find((row) => row.id === 'r-custom');
  assert.equal(customIn.label, 'collaborates_with (inverse)');
  assert.equal(customIn.cardinality, 'multi');

  await rejectsWith(
    store.assertRelationship({ origin: 'user', relationshipId: 'r-self', subjectId: 'e-x', predicate: 'associated_with', objectId: 'e-x', evidence: UE }),
    /a relationship cannot point an entity at itself/,
  );
  await rejectsWith(
    store.assertRelationship({ origin: 'user', relationshipId: 'r-ghost', subjectId: 'e-x', predicate: 'associated_with', objectId: 'e-ghost', evidence: UE }),
    /object entity: no entity matches "e-ghost"/,
  );

  // Two objects for a single-valued relationship at overlapping times disagree.
  await addRelationship(store, 'r-two', 'e-alice', 'owned_by', 'e-acme', { validFrom: '2024-01-01' });
  await addRelationship(store, 'r-three', 'e-alice', 'owned_by', 'e-beta', { validFrom: '2024-02-01' });
  const conflicts = await store.conflicts({ now: '2024-03-01' });
  assert.ok(conflicts.groups.some((group) => group.kind === 'relationship' && group.predicate === 'owned_by'));
});

// ---- events -----------------------------------------------------------------

test('events: three instants, late recording, future occurrences, roles and retraction', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const time = clock('2024-04-10T00:00:00.000Z');
  const store = newStore(dir, { time });
  await addEntity(store, 'e-device', 'Parcel Locker', { category: 'device' });
  await addEntity(store, 'e-site', 'Atlas Site', { category: 'place' });
  await addEntity(store, 'e-tech', 'Tech', { category: 'person' });

  // Learned before it happened: occurredAt and observedAt are independent.
  await store.recordEvent({
    origin: 'user', worldEventId: 'ev-planned', eventType: 'inspection_scheduled',
    participants: ['e-tech'], affected: ['e-device'],
    occurredAt: '2024-03-01T00:00:00Z', observedAt: '2024-02-20T00:00:00Z',
    evidence: UE,
  });
  // Recorded late and out of order: the query sorts by occurred time, not by store time.
  time.set('2024-05-01T00:00:00.000Z');
  await store.recordEvent({
    origin: 'user', worldEventId: 'ev-old', eventType: 'inspection_completed',
    participants: ['e-device'], affected: ['e-site'],
    occurredAt: '2024-02-01T00:00:00Z', observedAt: '2024-04-30T00:00:00Z',
    evidence: UE,
  });
  await store.recordEvent({
    origin: 'user', worldEventId: 'ev-future', eventType: 'inspection_due',
    participants: ['e-device'], occurredAt: '2024-12-01T00:00:00Z', evidence: UE,
  });

  const device = await store.events('e-device', { at: '2024-06-01' });
  assert.equal(device.events[0].id, 'ev-old', 'ordering is by occurredAt');
  assert.equal(device.events[0].role, 'participant');
  assert.equal(device.events[0].occurredAt, '2024-02-01T00:00:00.000Z');
  assert.equal(device.events[0].observedAt, '2024-04-30T00:00:00.000Z');
  assert.equal(device.events[0].recordedAt, '2024-05-01T00:00:00.000Z');
  assert.equal(device.events.find((event) => event.id === 'ev-future').status, 'future');
  assert.equal(device.events.find((event) => event.id === 'ev-planned').status, 'supported');
  assert.match(device.note, /occurredAt is when the event happened/);

  const site = await store.events('e-site', { at: '2024-06-01' });
  assert.equal(site.events[0].role, 'affected');

  await store.retractStatement({
    origin: 'user', targetType: 'event', targetId: 'ev-planned', reason: 'the visit never happened', evidence: UE,
  });
  const hidden = await store.events('e-tech', { at: '2024-06-01' });
  assert.equal(hidden.events.length, 0);
  const visible = await store.events('e-tech', { at: '2024-06-01', includeRetracted: true });
  assert.equal(visible.events[0].status, 'retracted');
  assert.equal(visible.events[0].retractedReason, 'the visit never happened');
});

// ---- retraction, supersession and prior belief ------------------------------

test('withdrawal: retraction and supersession preserve history and reconstruct prior belief', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const time = clock();
  const store = newStore(dir, { time });
  await addEntity(store, 'e-device', 'Parcel Locker', { category: 'device' });
  await addFact(store, 'f-old', 'e-device', 'has_status', scalar('operational'), { validFrom: '2024-01-01' });
  await addFact(store, 'f-a', 'e-device', 'located_in', scalar('bay 1'), { validFrom: '2024-01-01' });
  await addFact(store, 'f-b', 'e-device', 'located_in', scalar('bay 2'), { validFrom: '2024-03-01' });

  time.set('2024-02-01T00:00:00.000Z');
  await addFact(store, 'f-new', 'e-device', 'has_status', scalar('maintenance'), {
    validFrom: '2024-02-01', supersedes: ['f-old'],
  });
  await store.supersedeStatement({
    origin: 'user', targetType: 'fact', targetId: 'f-a', byId: 'f-b', reason: 'moved', evidence: UE,
  });
  time.set('2024-02-20T00:00:00.000Z');
  await store.retractStatement({
    origin: 'user', targetType: 'fact', targetId: 'f-new', reason: 'the status note was wrong', evidence: UE,
  });

  const visible = await store.facts('e-device', { at: '2024-03-15' });
  assert.deepEqual(visible.facts.map((fact) => fact.id), ['f-b']);
  assert.equal(visible.facts[0].status, 'supported');

  const all = await store.facts('e-device', { at: '2024-03-15', includeSuperseded: true, includeRetracted: true });
  const byId = Object.fromEntries(all.facts.map((fact) => [fact.id, fact]));
  assert.equal(byId['f-old'].status, 'superseded');
  assert.equal(byId['f-old'].supersededBy, 'f-new');
  assert.equal(byId['f-a'].status, 'superseded');
  assert.equal(byId['f-a'].supersededBy, 'f-b');
  assert.equal(byId['f-new'].status, 'retracted');
  assert.equal(byId['f-new'].retractedReason, 'the status note was wrong');

  const attributes = await store.attributes('e-device', { at: '2024-03-15' });
  assert.deepEqual(Object.keys(attributes.attributes), ['located_in']);
  assert.equal(attributes.attributes.located_in[0].id, 'f-b');

  await rejectsWith(
    store.supersedeStatement({ origin: 'user', targetType: 'fact', targetId: 'f-new', byId: 'f-b', reason: 'too late', evidence: UE }),
    /refused: a retracted statement cannot be superseded/,
  );

  // Prior-belief reconstruction filters on stored time, so a later withdrawal does not apply.
  const january = await store.stateAt('2024-01-15');
  assert.equal(january.problem, undefined);
  assert.equal(january.state.supersessions.length, 0);
  assert.equal(january.state.retractions.length, 0);
  assert.ok(january.state.facts.has('f-old'));
  const midFebruary = await store.stateAt('2024-02-15');
  assert.equal(midFebruary.state.supersessions.length, 2);
  assert.equal(midFebruary.state.retractions.length, 0);
  const afterRetraction = await store.stateAt('2024-02-25');
  assert.equal(afterRetraction.state.retractions.length, 1);

  const window = await store.changes('2024-01-01', '2024-02-21');
  assert.equal(window.problem, null);
  const kinds = new Set(window.changes.map((change) => change.kind));
  assert.ok(kinds.has('validity_started'));
  assert.ok(kinds.has('recorded'));
  assert.ok(kinds.has('superseded'));
  assert.ok(kinds.has('retracted'));

  const history = await store.statementHistory('fact', 'f-a');
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].kind, 'statement_superseded');
  assert.equal(history.entries[0].byId, 'f-b');

  const entityHistory = await store.history('e-device');
  assert.equal(entityHistory.entity.id, 'e-device');
  assert.ok(entityHistory.entries.some((entry) => entry.type === 'fact_asserted'));
});

// ---- identity and merges ----------------------------------------------------

test('identity: a shared name is a candidate, merges need confirmation or an external id', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = newStore(dir);
  await addEntity(store, 'e-j1', 'John Smith', { category: 'person' });
  await addEntity(store, 'e-j2', 'Jon Smith', { category: 'person' });
  await addEntity(store, 'e-shared-1', 'Mercury', { category: 'project' });
  await addEntity(store, 'e-shared-2', 'Mercury Relay', { category: 'project', aliases: ['Mercury'] });

  // A similar name is not identity: no automatic merge basis exists.
  await rejectsWith(
    store.mergeEntities({ origin: 'user', fromId: 'e-j1', toId: 'e-j2', reason: 'looks similar', evidence: UE }),
    /merge refused: no confirmation and no shared trusted external identifier/,
  );
  const johnCandidates = await store.identityCandidates('e-j1');
  assert.equal(johnCandidates.candidates.length, 0, 'John/Jon is not reported as a similarity candidate');
  assert.match(johnCandidates.note, /not a probability/);

  await rejectsWith(
    store.mergeEntities({ origin: 'user', fromId: 'e-shared-1', toId: 'e-shared-2', reason: 'same name', evidence: UE }),
    /merge refused: a shared name is not identity/,
  );

  // An explicit confirmation permits the merge; the records stay, including the source name.
  await addFact(store, 'f-j1', 'e-j1', 'has_name', scalar('John Smith'), { validFrom: '2024-01-01' });
  await store.decideIdentity({
    origin: 'user', leftId: 'e-j1', rightId: 'e-j2', decision: 'confirmed', reason: 'same person', evidence: UE,
  });
  const assessment = await store.pairAssessment('e-j1', 'e-j2');
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.basis, 'user_confirmation');
  await store.mergeEntities({
    origin: 'user', fromId: 'e-j1', toId: 'e-j2', reason: 'same person', mergeId: 'm-j1', evidence: UE,
  });

  const listed = await store.listEntities();
  assert.deepEqual(listed.entities.map((entry) => entry.id), ['e-j2', 'e-shared-1', 'e-shared-2']);
  const merged = await store.listEntities({ includeMerged: true });
  const source = merged.entities.find((entry) => entry.id === 'e-j1');
  assert.equal(source.status, 'merged');
  assert.equal(source.mergedInto, 'e-j2');

  const survivor = await store.showEntity('e-j2');
  assert.ok(survivor.entity.aliases.includes('John Smith'));
  assert.deepEqual(survivor.entity.mergedFrom, ['e-j1']);
  assert.equal(survivor.merges[0].id, 'm-j1');
  assert.equal(survivor.merges[0].undoneAt, null);
  assert.equal(survivor.facts[0].subjectId, 'e-j2', 'statements follow the surviving identity in views');
  const viaSource = await store.showEntity('e-j1');
  assert.equal(viaSource.entity.id, 'e-j2');
  assert.equal(viaSource.resolved.id, 'e-j2');
  assert.match(viaSource.resolved.note, /was merged into e-j2/);
  // A reference to the merged entity is not refused; it is recorded against the survivor, and
  // the stored record names the identity that actually holds the statement.
  const redirected = await addFact(store, 'f-j2', 'e-j1', 'has_status', scalar('active'), { validFrom: '2024-01-01' });
  assert.equal(redirected.subjectId, 'e-j2');

  // Undo is a compensating record, not a deletion, and it cannot be repeated.
  await store.undoMerge({ origin: 'user', mergeId: 'm-j1', reason: 'wrong person', evidence: UE });
  const restored = await store.listEntities();
  assert.ok(restored.entities.some((entry) => entry.id === 'e-j1'));
  const undone = await store.showEntity('e-j2');
  assert.ok(undone.merges[0].undoneAt);
  await rejectsWith(
    store.undoMerge({ origin: 'user', mergeId: 'm-j1', reason: 'again', evidence: UE }),
    /refused: this merge was already undone/,
  );

  // A shared trusted external identifier is deterministic and permits a merge without a decision.
  await addEntity(store, 'e-ext-1', 'Acme Holdings', { category: 'organization', externalIds: [{ scheme: 'registry', value: 'ACME-42' }] });
  await addEntity(store, 'e-ext-2', 'Acme Group', { category: 'organization', externalIds: [{ scheme: 'registry', value: 'acme-42' }] });
  const external = await store.pairAssessment('e-ext-1', 'e-ext-2');
  assert.equal(external.allowed, true);
  assert.equal(external.basis, 'external_id');
  await store.mergeEntities({ origin: 'user', fromId: 'e-ext-1', toId: 'e-ext-2', reason: 'same registry entry', evidence: UE });
  assert.equal((await store.showEntity('e-ext-1')).entity.id, 'e-ext-2');
});

test('identity candidates: similar names, shared aliases, external ids and recorded rejections', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = newStore(dir);
  await addEntity(store, 'e-engine', 'Acme Rocket Engine', { category: 'product' });
  await addEntity(store, 'e-engines', 'Acme Rocket Engines', { category: 'product' });
  await addEntity(store, 'e-alias-1', 'Atlas Console', { category: 'product', aliases: ['Atlas'] });
  await addEntity(store, 'e-alias-2', 'Atlas Console Unit', { category: 'product', aliases: ['Atlas'] });
  await addEntity(store, 'e-reg-1', 'Registry One', { category: 'device', externalIds: [{ scheme: 'serial', value: 'SN-9' }] });
  await addEntity(store, 'e-reg-2', 'Registry Two', { category: 'device', externalIds: [{ scheme: 'serial', value: 'sn-9' }] });
  await addEntity(store, 'e-reject-1', 'Rocket One', { category: 'concept', aliases: ['Rocket'] });
  await addEntity(store, 'e-reject-2', 'Rocket Two', { category: 'concept', aliases: ['Rocket'] });

  const similar = await store.identityCandidates('e-engine');
  const best = similar.candidates.find((entry) => entry.id === 'e-engines');
  assert.ok(best);
  assert.equal(best.kind, 'similar_name');
  assert.equal(best.basis, 'similarity');
  assert.equal(best.score, 0.7);

  const sharedAlias = await store.identityCandidates('e-alias-1');
  const aliasCandidate = sharedAlias.candidates.find((entry) => entry.id === 'e-alias-2');
  assert.equal(aliasCandidate.kind, 'shared_name');
  assert.equal(aliasCandidate.score, 0.9);

  const external = await store.identityCandidates('e-reg-1');
  const externalCandidate = external.candidates.find((entry) => entry.id === 'e-reg-2');
  assert.equal(externalCandidate.kind, 'external_id');
  assert.equal(externalCandidate.score, 1);

  // A rejection removes the pair from candidates but keeps it visible as a recorded decision.
  await store.decideIdentity({
    origin: 'user', leftId: 'e-reject-1', rightId: 'e-reject-2', decision: 'rejected', reason: 'different projects', evidence: UE,
  });
  const afterRejection = await store.identityCandidates('e-reject-1', { includeRejected: true });
  assert.equal(afterRejection.candidates.length, 0);
  assert.equal(afterRejection.rejected.length, 1);
  assert.equal(afterRejection.rejected[0].id, 'e-reject-2');
  assert.equal(afterRejection.rejected[0].decision, 'rejected');
  const hidden = await store.identityCandidates('e-reject-1');
  assert.equal(hidden.rejected.length, 0);
  assert.equal(hidden.rejectedTotal, 1);
  await rejectsWith(
    store.mergeEntities({ origin: 'user', fromId: 'e-reject-1', toId: 'e-reject-2', reason: 'merge anyway', evidence: UE }),
    /merge refused: you recorded that these entities are different/,
  );
});

// ---- evidence ---------------------------------------------------------------

test('evidence: references are re-checked against the store that owns them', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const sources = {
    memory: async (id) => {
      if (id === 'mem-ok') return { found: true, active: true, classification: 'recorded_claim' };
      if (id === 'mem-model') return { found: true, active: true, classification: 'model_generated' };
      if (id === 'mem-old') return { found: true, active: false, state: 'archived', classification: 'recorded_claim' };
      if (id === 'mem-untyped') return { found: true, active: true };
      if (id === 'mem-boom') throw new Error('boom');
      if (id === 'mem-store') throw new StoreError('the memory store is unreadable');
      return { found: false };
    },
    prediction: async () => ({ found: true, active: true, classification: 'recorded_expectation' }),
  };
  const store = newStore(dir, { sources });

  const checked = await store.checkEvidence([
    { relation: 'supports', sourceType: 'memory', sourceId: 'mem-ok' },
    { relation: 'supports', sourceType: 'user', sourceId: 'user' },
  ]);
  assert.deepEqual(checked.map((entry) => entry.classification), ['recorded_claim', 'user_statement']);

  const entity = await addEntity(store, 'e-ev', 'Evidence Holder', { category: 'device', evidence: checked });
  assert.deepEqual(entity.evidence.map((entry) => entry.classification), ['recorded_claim', 'user_statement']);

  const modelGenerated = await addEntity(store, 'e-model-ev', 'Model Evidence', {
    category: 'concept',
    evidence: [{ relation: 'supports', sourceType: 'memory', sourceId: 'mem-model' }],
  });
  assert.equal(modelGenerated.evidence[0].classification, 'model_generated', 'a model-generated record can be cited only as what it is');

  await rejectsWith(
    store.checkEvidence([{ relation: 'supports', sourceType: 'memory', sourceId: 'mem-404' }]),
    /evidence memory:mem-404 does not exist/,
  );
  await rejectsWith(
    store.checkEvidence([{ relation: 'supports', sourceType: 'memory', sourceId: 'mem-old' }]),
    /is archived and cannot be cited for a new assertion/,
  );
  await rejectsWith(
    store.checkEvidence([{ relation: 'supports', sourceType: 'memory', sourceId: 'mem-ok', classification: 'verified_record' }]),
    /is classified as recorded_claim, not verified_record/,
  );
  await rejectsWith(
    store.checkEvidence([{ relation: 'supports', sourceType: 'memory', sourceId: 'mem-untyped' }]),
    /did not classify evidence mem-untyped/,
    StoreError,
  );
  await rejectsWith(
    store.checkEvidence([{ relation: 'supports', sourceType: 'knowledge', sourceId: 'k-1' }]),
    /no knowledge store is available in this configuration/,
  );
  await rejectsWith(
    store.checkEvidence([{ relation: 'supports', sourceType: 'memory', sourceId: 'mem-boom' }]),
    /evidence memory:mem-boom could not be checked: boom/,
    StoreError,
  );
  await rejectsWith(
    store.checkEvidence([{ relation: 'supports', sourceType: 'memory', sourceId: 'mem-store' }]),
    /the memory store is unreadable/,
    StoreError,
  );
  await rejectsWith(
    store.checkEvidence([{ relation: 'supports', sourceType: 'user', sourceId: 'memory:mem-ok' }]),
    /user evidence must name the user, not another record/,
  );
  await rejectsWith(
    store.checkEvidence([{ relation: 'supports', sourceType: 'prediction', sourceId: 'p-1' }]),
    /a prediction is an expectation, not evidence for or against a fact/,
  );
  await rejectsWith(
    store.checkEvidence([{ relation: 'bogus', sourceType: 'user', sourceId: 'user' }]),
    /evidence relation must be one of/,
  );
  const qualifies = await store.checkEvidence([{ relation: 'qualifies', sourceType: 'prediction', sourceId: 'p-1' }]);
  assert.equal(qualifies[0].classification, 'recorded_expectation');

  await rejectsWith(
    store.createEntity({
      origin: 'user', entityId: 'e-many', category: 'concept', name: 'Too Many',
      evidence: Array.from({ length: 9 }, () => ({ relation: 'supports', sourceType: 'user', sourceId: 'user' })),
    }),
    /at most 8 evidence references are allowed/,
  );
});

// ---- model origin and integrity ---------------------------------------------

test('model-origin writes are refused for every mutation and leave no log behind', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = newStore(dir);
  const file = path.join(dir, 'world-model.jsonl');
  const attempts = [
    ['createEntity', { entityId: 'm-e1', category: 'device', name: 'Made Up', evidence: UE }],
    ['addAlias', { entityId: 'm-e1', alias: 'Alias', evidence: UE }],
    ['retireEntity', { entityId: 'm-e1', reason: 'done', evidence: UE }],
    ['mergeEntities', { fromId: 'm-e1', toId: 'm-e2', reason: 'same', evidence: UE }],
    ['undoMerge', { mergeId: 'm-1', reason: 'undo', evidence: UE }],
    ['decideIdentity', { leftId: 'm-e1', rightId: 'm-e2', decision: 'confirmed', reason: 'same', evidence: UE }],
    ['assertFact', { factId: 'm-f1', subjectId: 'm-e1', predicate: 'has_status', object: scalar('on'), evidence: UE }],
    ['assertRelationship', { relationshipId: 'm-r1', subjectId: 'm-e1', objectId: 'm-e2', predicate: 'associated_with', evidence: UE }],
    ['recordEvent', { worldEventId: 'm-ev1', eventType: 'made_up', participants: ['m-e1'], evidence: UE }],
    ['retractStatement', { targetType: 'fact', targetId: 'm-f1', reason: 'no', evidence: UE }],
    ['supersedeStatement', { targetType: 'fact', targetId: 'm-f1', byId: 'm-f2', reason: 'no', evidence: UE }],
  ];
  for (const [method, input] of attempts) {
    await rejectsWith(store[method]({ origin: 'model', ...input }), /world model writes require an authorized user-origin operation/);
  }
  await rejectsWith(
    store.createEntity({ entityId: 'm-e1', category: 'device', name: 'No Origin', evidence: UE }),
    /world model writes require an authorized user-origin operation/,
  );
  assert.equal(fs.existsSync(file), false, 'a refused write never creates the log');
  assert.equal((await store.state()).entities.size, 0);

  const userWrite = await addEntity(store, 'e-real', 'Real Record');
  assert.equal(userWrite.origin, 'user');
  assert.ok(fs.existsSync(file));
});

test('integrity: a damaged log blocks state, but inspection still reports the damage', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = newStore(dir);
  await addEntity(store, 'e-one', 'One');
  const file = path.join(dir, 'world-model.jsonl');
  fs.appendFileSync(file, 'this is not json\n');
  const before = fs.readFileSync(file);

  await rejectsWith(store.load(), /world model log contains 1 corrupt line\(s\); refusing incomplete world state/, StoreError);
  await rejectsWith(store.state(), /refusing incomplete world state/, StoreError);
  await rejectsWith(store.listEntities(), /refusing incomplete world state/, StoreError);
  await rejectsWith(
    store.createEntity({ origin: 'user', entityId: 'e-two', category: 'concept', name: 'Two', evidence: UE }),
    /refusing incomplete world state/,
    StoreError,
  );
  assert.deepEqual(fs.readFileSync(file), before, 'a refused write appends nothing');

  const inspected = await store.inspect();
  assert.equal(inspected.corrupt.length, 1);
  assert.equal(inspected.corrupt[0].reason, 'invalid JSON');
  assert.equal(inspected.complete, false);
  assert.equal(inspected.counts.entities, 1, 'intact records are still counted');
  const status = await store.status();
  assert.equal(status.available, true);
  assert.equal(status.complete, false);
  assert.match(status.detail, /damage/);

  // A well-formed record that cannot be applied is damage too, reported as a problem.
  const dir2 = tempDir();
  t.after(() => cleanup(dir2));
  const file2 = path.join(dir2, 'world-model.jsonl');
  fs.writeFileSync(file2, `${JSON.stringify({
    schema: 1, eventId: 'bad-1', type: 'fact_asserted', at: T0, origin: 'user',
    factId: 'f-bad', subjectId: 'nobody', predicate: 'has_status',
    object: { kind: 'scalar', valueType: 'string', value: 'x' },
    validFrom: null, validUntil: null, observedAt: null, confidence: null,
    supersedes: [], evidence: UE,
  })}\n`);
  const second = newStore(dir2);
  await rejectsWith(second.load(), /record\(s\) that cannot be applied; refusing incomplete world state/, StoreError);
  const report = await second.inspect();
  assert.equal(report.complete, false);
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0].reason, /subject entity nobody does not exist/);
  const secondStatus = await second.status();
  assert.equal(secondStatus.available, true);
  assert.equal(secondStatus.complete, false);
  assert.equal(secondStatus.records, 1);
});

test('reads are pure: queries, inspection and context assembly write nothing', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = newStore(dir);
  await addEntity(store, 'e-pure', 'Pure Reader', { category: 'device', aliases: ['Reader'] });
  await addEntity(store, 'e-pure2', 'Pure Part', { category: 'device' });
  await addFact(store, 'f-pure', 'e-pure', 'has_status', scalar('on'), { validFrom: '2024-01-01' });
  await addRelationship(store, 'r-pure', 'e-pure', 'part_of', 'e-pure2', { validFrom: '2024-01-01' });

  const file = path.join(dir, 'world-model.jsonl');
  const lockFile = `${file}.lock`;
  const before = fs.readFileSync(file);
  const state = await store.state();
  await store.inspect();
  await store.status();
  await store.listEntities();
  await store.showEntity('e-pure');
  await store.facts('e-pure');
  await store.attributes('e-pure');
  await store.relationships('e-pure');
  await store.events('e-pure');
  await store.conflicts();
  await store.identityCandidates('e-pure');
  await store.history('e-pure');
  await store.checkFact({ entityId: 'e-pure', predicate: 'has_status' });
  buildWorldModelContext(state, { request: 'what is the status of the pure reader?', now: new Date('2024-03-01') });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(lockFile), false);
});

// ---- traversal and live checks ----------------------------------------------

test('traversal: bounded breadth-first walk detects cycles and stops at the node cap', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = newStore(dir);
  for (const [id, name] of [['e-1', 'Node One'], ['e-2', 'Node Two'], ['e-3', 'Node Three'], ['e-4', 'Node Four'], ['e-5', 'Node Five']]) {
    await addEntity(store, id, name, { category: 'concept' });
  }
  await addRelationship(store, 'r-12', 'e-1', 'depends_on', 'e-2');
  await addRelationship(store, 'r-23', 'e-2', 'depends_on', 'e-3');
  await addRelationship(store, 'r-31', 'e-3', 'depends_on', 'e-1');
  await addRelationship(store, 'r-34', 'e-3', 'depends_on', 'e-4');
  await addRelationship(store, 'r-45', 'e-4', 'depends_on', 'e-5');

  const walk = await store.related('e-1', { depth: 3, limit: 60 });
  assert.equal(walk.problem, null);
  // Same-depth nodes are ordered by name: "Node Three" precedes "Node Two".
  assert.deepEqual(walk.nodes.map((node) => node.id), ['e-1', 'e-3', 'e-2', 'e-4', 'e-5']);
  assert.equal(walk.depth, 3);
  assert.ok(walk.cycles.length >= 1, 'the cycle is reported rather than followed forever');
  assert.equal(walk.truncated, false);

  const capped = await store.related('e-1', { depth: 3, limit: 2 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.nodes.length, 2);
  assert.match(capped.note, /the traversal stopped at 2 nodes/);

  const missing = await store.related('e-absent');
  assert.equal(missing.start, null);
  assert.match(missing.problem, /no entity matches "e-absent"/);

  // Traversal follows only unretracted statements.
  await store.retractStatement({ origin: 'user', targetType: 'relationship', targetId: 'r-12', reason: 'not a dependency', evidence: UE });
  const afterRetraction = await store.related('e-1', { depth: 1, limit: 60 });
  assert.ok(!afterRetraction.nodes.some((node) => node.id === 'e-2'));
});

test('live checks: a missing fact is not proof of the opposite, and citations report their state', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = newStore(dir);
  await addEntity(store, 'e-check', 'Check Device', { category: 'device' });
  await addFact(store, 'f-on', 'e-check', 'has_status', scalar('on'), { validFrom: '2024-01-01', validUntil: '2024-05-31' });
  await addFact(store, 'f-off', 'e-check', 'has_status', scalar('off'), { validFrom: '2024-06-01' });

  const current = await store.checkFact({ entityId: 'e-check', predicate: 'has_status', expected: 'on' });
  assert.equal(current.ok, true);
  assert.equal(current.supporting.length, 1);
  assert.equal(current.conflicting.length, 0, 'a value that is not valid yet is not a current disagreement');
  assert.deepEqual(current.notCurrent.map((entry) => entry.id), ['f-off']);
  const mismatch = await store.checkFact({ entityId: 'e-check', predicate: 'has_status', expected: 'standby' });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /no current has_status fact matches "standby" \(1 recorded value\(s\) are outside their valid time\)/);
  const inJune = await store.checkFact({
    entityId: 'e-check', predicate: 'has_status', expected: 'off', at: '2024-06-02T00:00:00.000Z',
  });
  assert.equal(inJune.ok, true, 'the live check is evaluated at the requested instant');
  assert.equal(inJune.supporting[0].id, 'f-off');
  assert.deepEqual(inJune.notCurrent.map((entry) => entry.id), ['f-on']);
  const absent = await store.checkFact({ entityId: 'e-check', predicate: 'located_in' });
  assert.equal(absent.ok, false);
  assert.match(absent.reason, /a missing fact is not proof of the opposite/);

  const citation = await store.checkStatement({ targetType: 'fact', targetId: 'f-on', expected: 'on' });
  assert.equal(citation.ok, true);
  assert.equal(citation.state, 'current');
  const changed = await store.checkStatement({ targetType: 'fact', targetId: 'f-on', expected: 'off' });
  assert.equal(changed.ok, false);
  assert.equal(changed.state, 'changed');

  const entityCheck = await store.checkStatement({ targetType: 'entity', targetId: 'e-check', expected: 'Check Device' });
  assert.equal(entityCheck.ok, true);
  const renamed = await store.checkStatement({ targetType: 'entity', targetId: 'e-check', expected: 'Other Device' });
  assert.equal(renamed.ok, false);
  assert.equal(renamed.state, 'changed');
  assert.equal(renamed.value, 'Check Device');
  const missingEntity = await store.checkStatement({ targetType: 'entity', targetId: 'e-absent' });
  assert.equal(missingEntity.state, 'missing');
  const missingFact = await store.checkStatement({ targetType: 'fact', targetId: 'f-absent' });
  assert.equal(missingFact.state, 'missing');
  const unsupported = await store.checkStatement({ targetType: 'nonsense', targetId: 'x' });
  assert.equal(unsupported.state, 'unsupported');

  await store.supersedeStatement({ origin: 'user', targetType: 'fact', targetId: 'f-on', byId: 'f-off', reason: 'corrected', evidence: UE });
  const superseded = await store.checkStatement({ targetType: 'fact', targetId: 'f-on' });
  assert.equal(superseded.state, 'superseded');
  await store.retractStatement({ origin: 'user', targetType: 'fact', targetId: 'f-off', reason: 'wrong', evidence: UE });
  const retracted = await store.checkStatement({ targetType: 'fact', targetId: 'f-off' });
  assert.equal(retracted.state, 'retracted');
  const retractedCheck = await store.checkFact({ entityId: 'e-check', predicate: 'has_status' });
  assert.equal(retractedCheck.ok, false);
  assert.equal(retractedCheck.supporting.length, 0);

  await store.retireEntity({ origin: 'user', entityId: 'e-check', reason: 'gone', evidence: UE });
  const retired = await store.checkStatement({ targetType: 'entity', targetId: 'e-check' });
  assert.equal(retired.ok, false);
  assert.equal(retired.state, 'retired');
});

// ---- the prompt view --------------------------------------------------------

test('context: relevant records are rendered with their evidence and validity', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const time = clock();
  const store = newStore(dir, { time });
  await addEntity(store, 'e-locker', 'Parcel Locker', { category: 'device', aliases: ['Locker 7'] });
  await addFact(store, 'f-status', 'e-locker', 'has_status', scalar('operational'), {
    validFrom: '2024-01-01', observedAt: '2024-01-02',
    confidence: { value: 0.8, basis: 'inspection' },
  });
  await addFact(store, 'f-desc', 'e-locker', 'described_as', scalar('blue steel unit'));
  const state = await store.state();

  const ctx = buildWorldModelContext(state, {
    request: 'what is the status of the parcel locker?',
    now: new Date('2024-04-01T00:00:00.000Z'),
  });
  assert.equal(ctx.available, true);
  assert.equal(ctx.relevant, true);
  assert.equal(ctx.matchedBy, 'name');
  assert.deepEqual(ctx.entityIds, ['e-locker']);
  assert.ok(ctx.factIds.includes('f-status'));
  assert.ok(ctx.factIds.includes('f-desc'));
  assert.equal(ctx.discipline, WORLD_MODEL_DISCIPLINE);
  assert.match(ctx.discipline, /not instructions or authorization/);

  const text = ctx.lines.join('\n');
  assert.match(text, /- Device Parcel Locker \[e-locker\] \(active\); aliases Locker 7; 1 current fact\(s\) of 2 recorded/);
  assert.match(text, /fact: has_status = operational \[supported; valid 2024-01-01T00:00:00\.000Z\.\.open; observed 2024-01-02T00:00:00\.000Z; confidence 0\.8 \(inspection\); evidence user:user\]/);
  assert.match(text, /unknown: described_as is recorded without a valid-from time, so it is not treated as current; evidence user:user/);

  const unrelated = buildWorldModelContext(state, {
    request: 'what is the weather tomorrow?',
    now: new Date('2024-04-01T00:00:00.000Z'),
  });
  assert.equal(unrelated.relevant, false);
  assert.deepEqual(unrelated.lines, []);
  assert.equal(unrelated.discipline, '');

  const overview = buildWorldModelContext(state, {
    request: 'which entities and facts do you have?',
    now: new Date('2024-04-01T00:00:00.000Z'),
  });
  assert.equal(overview.matchedBy, 'overview');
  assert.match(overview.lines[0], /^World model: 1 active entities; 2 fact\(s\); 0 relationship\(s\); 0 event\(s\)/);

  assert.equal(worldModelRelevant('tell me about parcel locker', state), true);
  assert.equal(worldModelRelevant('what is the weather', state), false);
  assert.equal(worldModelRequested('show conflicts'), true);
  assert.equal(worldModelRequested('what is the weather'), false);
  assert.equal(buildWorldModelContext(null, { request: 'entities' }).available, false);
});

test('context: disagreement is disclosed, both sides kept, and the section stays bounded', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = newStore(dir);
  await addEntity(store, 'e-site', 'Atlas Site', { category: 'project' });
  await addFact(store, 'f-active', 'e-site', 'has_status', scalar('active'), { validFrom: '2024-01-01' });
  await addFact(store, 'f-paused', 'e-site', 'has_status', scalar('paused'), { validFrom: '2024-03-01' });
  const state = await store.state();
  const ctx = buildWorldModelContext(state, {
    request: 'what is the status of atlas site?',
    now: new Date('2024-04-01T00:00:00.000Z'),
  });
  const text = ctx.lines.join('\n');
  assert.match(text, /conflict: has_status has 2 overlapping value\(s\) \(active, paused\); both sides kept, unresolved/);
  assert.ok(ctx.conflicts >= 1);
  assert.ok(ctx.lines.some((line) => line.includes('has_status = active')));
  assert.ok(ctx.lines.some((line) => line.includes('has_status = paused')));

  // The overview form names the same disagreement, so its count must not report zero just because
  // no single entity was matched.
  const overview = buildWorldModelContext(state, {
    request: 'which world conflicts are recorded?',
    now: new Date('2024-04-01T00:00:00.000Z'),
  });
  assert.equal(overview.matchedBy, 'overview');
  assert.equal(overview.conflicts, 1);
  assert.match(overview.lines.join('\n'), /1 unresolved disagreement group\(s\)/);
  assert.match(overview.lines.join('\n'), /conflict: has_status has 2 overlapping value\(s\)/);

  // Three matching entities, four facts each, produce more entries than the ten-line budget.
  for (const [id, name] of [['e-relay-1', 'Relay One'], ['e-relay-2', 'Relay Two'], ['e-relay-3', 'Relay Three']]) {
    await addEntity(store, id, name, { category: 'device' });
    for (const predicate of ['metric_a', 'metric_b', 'metric_c', 'metric_d']) {
      await addFact(store, `f-${id}-${predicate.replaceAll('_', '-')}`, id, predicate, scalar(predicate), { validFrom: '2024-01-01' });
    }
  }
  const wide = await store.state();
  const bounded = buildWorldModelContext(wide, {
    request: 'tell me about relay entities',
    now: new Date('2024-04-01T00:00:00.000Z'),
  });
  assert.equal(bounded.matchedBy, 'name');
  assert.equal(bounded.lines.length, 10, 'the section never exceeds its line budget');
  assert.ok(bounded.omitted >= 1, 'records that do not fit are counted as omitted');
  assert.ok(bounded.lines.join('\n').length <= 1200, 'the section never exceeds its character budget');
  assert.ok(bounded.entityIds.length <= 3);

  // An entity with nothing recorded contributes only its summary; no fact is invented.
  const empty = await addEntity(store, 'e-empty', 'Empty Entity', { category: 'concept' });
  const emptyState = await store.state();
  const emptyCtx = buildWorldModelContext(emptyState, {
    request: `what do you know about ${empty.name}?`,
    now: new Date('2024-04-01T00:00:00.000Z'),
  });
  assert.equal(emptyCtx.lines.length, 1);
  assert.match(emptyCtx.lines[0], /0 current fact\(s\) of 0 recorded/);
  assert.equal(emptyCtx.discipline, WORLD_MODEL_DISCIPLINE);
});
