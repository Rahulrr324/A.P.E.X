// Batch AP-15: historical belief reconstruction over the World Model and its evidence stores.
//
// These tests exercise three separate questions through the real controller, stores and CLI:
// what APEX believed at a requested historical instant, what it believes now, and what changed
// between the two. The past view replays only records stored at or before the cutoff, so a later
// correction, retraction, supersession, or resolution is never projected backward. Every fixture
// is synthetic and deterministic; no model is contacted.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { ValidationError } from '../src/errors.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const UE = [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }];
const DATA_FILES = ['memory.jsonl', 'knowledge.jsonl', 'world-model.jsonl', 'predictions.jsonl', 'experiences.jsonl'];

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

// The clock is mutable so one fixture can record facts at distinct stored times without sleeping.
function appOn(dir, start = '2026-01-01T00:00:00.000Z') {
  const state = { now: new Date(start) };
  const app = createApp({
    dataDir: dir,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    experienceCapture: CAPTURE_OFF,
    now: () => state.now,
  });
  return {
    app,
    setNow(iso) { state.now = new Date(iso); },
  };
}

function dataOf(res) {
  return res.operation.steps[0].result.data;
}

function snapshot(dir) {
  const out = {};
  for (const file of DATA_FILES) {
    try {
      out[file] = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      out[file] = null;
    }
  }
  return out;
}

function scalar(value) {
  return { kind: 'scalar', valueType: 'string', value };
}

async function write(app, action, input) {
  const res = await app.controller.worldWrite(action, input);
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
  return dataOf(res);
}

async function read(app, action, input) {
  return app.controller.worldRead(action, input);
}

async function readOk(app, action, input) {
  const res = await read(app, action, input);
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
  return { res, data: dataOf(res) };
}

async function addEntity(app, id, name = 'North Gate') {
  return write(app, 'world.entity.add', { id, category: 'place', name, evidence: UE });
}

async function addFact(app, input) {
  return write(app, 'world.fact.add', {
    evidence: UE,
    object: scalar('open'),
    validFrom: '2024-01-01',
    ...input,
  });
}

async function trace(app, targetType, target, extra = {}) {
  return readOk(app, 'world.belief.trace', { targetType, target, ...extra });
}

function beliefRow(data, prefix) {
  return (data.belief?.statements ?? []).find((row) => row.startsWith(prefix)) ?? null;
}

describe('historical state reconstruction', () => {
  test('a fact recorded before its valid-from is known but not yet valid at an earlier cutoff', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir);
    await addEntity(app, 'e-gate');
    await addFact(app, { id: 'f-future', subject: 'e-gate', predicate: 'has_status', validFrom: '2026-06-01' });
    setNow('2026-02-01T00:00:00.000Z');

    const early = await readOk(app, 'world.state_at', { at: '2026-03-01T00:00:00Z' });
    assert.equal(early.data.cutoff, '2026-03-01T00:00:00.000Z');
    assert.equal(early.data.counts.facts, 1);
    assert.equal(beliefRow(early.data, 'fact:f-future:'), 'fact:f-future:historical:not_yet_valid');
    assert.equal(early.data.belief.counts.believed, 0);
    assert.equal(early.data.belief.counts.notYetValid, 1);
    assert.match(early.res.display, /1 not yet valid/);
    assert.match(early.res.display, /no statement was in force at that time/);

    const later = await readOk(app, 'world.state_at', { at: '2026-07-01T00:00:00Z' });
    assert.equal(beliefRow(later.data, 'fact:f-future:'), 'fact:f-future:supported:in_force');
    assert.equal(later.data.belief.counts.believed, 1);

    // The cutoff is after the application clock. The past view is still the past view, but there
    // is no later window, and that is stated rather than reported as a reversed range.
    const future = await trace(app, 'fact', 'f-future', { at: '2026-07-01T00:00:00Z' });
    assert.equal(future.data.disposition, 'supported');
    assert.equal(future.data.validity, 'in_force');
    assert.equal(future.data.laterChanges.total, 0);
    assert.match(future.data.laterChanges.note, /at or after the current time/);
    assert.equal(future.data.current.status, 'historical');
  });

  test('a record written after the cutoff is excluded, never projected backward', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-01-05T00:00:00.000Z');
    await addEntity(app, 'e-gate');
    await addFact(app, { id: 'f-late', subject: 'e-gate', predicate: 'has_status' });

    const early = await readOk(app, 'world.state_at', { at: '2026-01-02T00:00:00Z' });
    assert.equal(early.data.counts.entities, 0);
    assert.equal(early.data.counts.facts, 0);
    assert.equal(early.data.excluded, 2);
    assert.equal(early.data.records, 0);
    assert.equal(early.data.belief.counts.total, 0);
    assert.match(early.res.display, /2 later record\(s\) are not included/);

    const traced = await trace(app, 'fact', 'f-late', { at: '2026-01-02T00:00:00Z' });
    assert.equal(traced.data.found, false);
    assert.equal(traced.data.status, 'not_yet_recorded');
    assert.equal(traced.data.disposition, 'not_yet_recorded');
    assert.equal(traced.data.current.found, true);
    assert.equal(traced.data.current.status, 'supported');
    assert.match(traced.res.display, /after the cutoff/);
  });

  test('validity expiry is distinguished from a statement that was never in force at that time', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2024-01-01T00:00:00.000Z');
    await addEntity(app, 'e-gate');
    await addFact(app, {
      id: 'f-exp', subject: 'e-gate', predicate: 'has_status',
      validFrom: '2024-01-01', validUntil: '2025-01-01',
    });
    setNow('2025-07-01T00:00:00.000Z');

    const during = await trace(app, 'fact', 'f-exp', { at: '2024-06-01T00:00:00Z' });
    assert.equal(during.data.status, 'supported');
    assert.equal(during.data.validity, 'in_force');
    assert.equal(during.data.disposition, 'supported');
    assert.equal(during.data.current.status, 'historical');
    assert.equal(during.data.current.disposition, 'expired');
    // Stored time records when APEX learned the interval; the later end of that interval is a
    // valid-time change, not a retraction, and it is reported only in the later window.
    assert.ok(during.data.laterChanges.changes.some((change) => change.includes('|validity_ended|f-exp')));
    assert.match(during.res.display, /Current standing at/);

    const after = await trace(app, 'fact', 'f-exp', { at: '2025-06-01T00:00:00Z' });
    assert.equal(after.data.status, 'historical');
    assert.equal(after.data.validity, 'expired');
    assert.equal(after.data.disposition, 'expired');
    assert.match(after.res.display, /validity at the trace time: expired/);
  });

  test('two contradictory statements are one supported belief, then two conflicting ones', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-01-01T00:00:00.000Z');
    await addEntity(app, 'e-gate');
    await addFact(app, { id: 'f-open', subject: 'e-gate', predicate: 'has_status', object: scalar('open') });
    setNow('2026-01-02T00:00:00.000Z');
    await addFact(app, { id: 'f-closed', subject: 'e-gate', predicate: 'has_status', object: scalar('closed') });
    setNow('2026-01-03T00:00:00.000Z');

    const before = await trace(app, 'fact', 'f-open', { at: '2026-01-01T12:00:00Z' });
    assert.equal(before.data.status, 'supported');
    assert.equal(before.data.disposition, 'supported');

    const after = await trace(app, 'fact', 'f-open', { at: '2026-01-02T12:00:00Z' });
    assert.equal(after.data.status, 'conflicting');
    assert.equal(after.data.disposition, 'contradicted');
    assert.equal(after.data.complete, true);
    assert.match(after.res.display, /Same-store disagreements \(1\)/);

    const earlyState = await readOk(app, 'world.state_at', { at: '2026-01-01T12:00:00Z' });
    assert.equal(earlyState.data.belief.counts.conflicting, 0);
    assert.equal(earlyState.data.belief.counts.believed, 1);

    const lateState = await readOk(app, 'world.state_at', { at: '2026-01-02T12:00:00Z' });
    assert.equal(lateState.data.belief.counts.conflicting, 2);
    // A conflicting statement is still an in-force belief; it is not silently dropped.
    assert.equal(lateState.data.belief.counts.believed, 2);
  });

  test('event happened-at, learned-at and stored-at stay separate across an observation boundary', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2024-03-02T00:00:00.000Z');
    await addEntity(app, 'e-gate');
    await write(app, 'world.event.add', {
      id: 'ev-early', eventType: 'inspection', participants: ['e-gate'],
      occurredAt: '2024-03-01T09:00:00Z', observedAt: '2024-03-02T00:00:00Z', evidence: UE,
    });
    setNow('2024-03-06T00:00:00.000Z');
    await write(app, 'world.event.add', {
      id: 'ev-late', eventType: 'inspection', participants: ['e-gate'],
      occurredAt: '2024-03-01T09:00:00Z', observedAt: '2024-03-06T00:00:00Z', evidence: UE,
    });
    setNow('2024-03-07T00:00:00.000Z');

    const early = await trace(app, 'event', 'ev-early', { at: '2024-03-04T00:00:00Z' });
    assert.equal(early.data.status, 'supported');
    assert.equal(early.data.validity, 'occurred');
    assert.equal(early.data.recordedAt, '2024-03-02T00:00:00.000Z');

    const notYet = await trace(app, 'event', 'ev-late', { at: '2024-03-04T00:00:00Z' });
    assert.equal(notYet.data.disposition, 'not_yet_recorded');
    assert.equal(notYet.data.current.found, true);

    const known = await trace(app, 'event', 'ev-late', { at: '2024-03-06T00:00:00Z' });
    assert.equal(known.data.status, 'supported');
    assert.equal(known.data.validity, 'occurred');
    assert.ok(known.data.laterChanges.changes.some((change) => change.includes('|event_learned|ev-late')));

    const state = await readOk(app, 'world.state_at', { at: '2024-03-04T00:00:00Z' });
    assert.equal(beliefRow(state.data, 'event:ev-early:'), 'event:ev-early:supported:occurred');
    assert.equal(beliefRow(state.data, 'event:ev-late:'), null);
  });

  test('a missing valid-from time is disclosed as unknown, not assumed current', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-01-01T00:00:00.000Z');
    await addEntity(app, 'e-gate');
    await addFact(app, { id: 'f-unknown', subject: 'e-gate', predicate: 'has_status', validFrom: null });
    setNow('2026-01-02T00:00:00.000Z');

    const state = await readOk(app, 'world.state_at', { at: '2026-01-02T00:00:00Z' });
    assert.equal(beliefRow(state.data, 'fact:f-unknown:'), 'fact:f-unknown:validity_unknown:unknown');
    assert.equal(state.data.belief.counts.validityUnknown, 1);
    assert.equal(state.data.belief.counts.believed, 0);
    assert.match(state.res.display, /1 without a usable time/);

    const traced = await trace(app, 'fact', 'f-unknown', { at: '2026-01-02T00:00:00Z' });
    assert.equal(traced.data.disposition, 'unknown');
    assert.equal(traced.data.complete, false);
    assert.match(traced.res.display, /validity at the trace time: unknown/);
  });

  test('a cutoff after the present keeps the past view and reports the present separately', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2024-01-01T00:00:00.000Z');
    await addEntity(app, 'e-gate');
    await addFact(app, { id: 'f-stable', subject: 'e-gate', predicate: 'has_status' });
    setNow('2024-01-02T00:00:00.000Z');

    const traced = await trace(app, 'fact', 'f-stable', { at: '2024-01-01T12:00:00Z' });
    assert.equal(traced.data.mode, 'historical');
    assert.equal(traced.data.asOf.cutoff, '2024-01-01T12:00:00.000Z');
    assert.equal(traced.data.asOf.excluded, 0);
    assert.equal(traced.data.current.status, 'supported');
    assert.equal(traced.data.disposition, 'supported');
    assert.equal(traced.data.authorizes, false);
  });
});

describe('later corrections, retractions and supersessions', () => {
  test('a retraction recorded later leaves the earlier belief and preserves the record', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-01-01T00:00:00.000Z');
    await addEntity(app, 'e-gate');
    await addFact(app, { id: 'f-ret', subject: 'e-gate', predicate: 'has_status' });
    setNow('2026-01-02T00:00:00.000Z');
    await write(app, 'world.statement.retract', {
      targetType: 'fact', target: 'f-ret', reason: 'the reading was entered against the wrong gate',
      evidence: [{ relation: 'retracts', sourceType: 'user', sourceId: 'user' }],
    });
    setNow('2026-01-03T00:00:00.000Z');

    const then = await trace(app, 'fact', 'f-ret', { at: '2026-01-01T12:00:00Z' });
    assert.equal(then.data.status, 'supported');
    assert.equal(then.data.disposition, 'supported');
    assert.equal(then.data.current.status, 'retracted');
    assert.equal(then.data.current.disposition, 'withdrawn');
    assert.ok(then.data.laterChanges.changes.some((change) => change.includes('|retracted|f-ret')));
    assert.match(then.res.display, /Changes recorded after the cutoff/);
    assert.match(then.res.display, /still readable in history/);

    const now = await trace(app, 'fact', 'f-ret');
    assert.equal(now.data.status, 'retracted');
    assert.equal(now.data.disposition, 'withdrawn');
    assert.equal(now.data.mode, 'current');
  });

  test('a supersession recorded later keeps both records and changes only the present standing', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-01-01T00:00:00.000Z');
    await addEntity(app, 'e-gate');
    await addFact(app, { id: 'f-old', subject: 'e-gate', predicate: 'has_status', object: scalar('open') });
    setNow('2026-01-02T00:00:00.000Z');
    await addFact(app, { id: 'f-new', subject: 'e-gate', predicate: 'has_owner', object: scalar('north trust') });
    setNow('2026-01-03T00:00:00.000Z');
    await write(app, 'world.statement.supersede', {
      targetType: 'fact', target: 'f-old', by: 'f-new', reason: 'a later record replaces the provisional one',
      evidence: [{ relation: 'supersedes', sourceType: 'user', sourceId: 'user' }],
    });
    setNow('2026-01-04T00:00:00.000Z');

    const then = await trace(app, 'fact', 'f-old', { at: '2026-01-01T12:00:00Z' });
    assert.equal(then.data.status, 'supported');
    assert.equal(then.data.disposition, 'supported');
    assert.equal(then.data.current.status, 'superseded');
    assert.equal(then.data.current.disposition, 'superseded');
    assert.ok(then.data.laterChanges.changes.some((change) => change.includes('|superseded|f-old')));

    const now = await trace(app, 'fact', 'f-old');
    assert.equal(now.data.status, 'superseded');
    assert.equal(now.data.disposition, 'superseded');
    assert.match(now.res.display, /both statements remain|original statement is unchanged/i);
  });

  test('a memory correction after the cutoff leaves the earlier support intact and marks it superseded now', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-01-01T00:00:00.000Z');
    const memory = await app.memory.add({ content: 'the north gate is open', kind: 'user_fact', source: 'user' });
    setNow('2026-01-02T00:00:00.000Z');
    await addEntity(app, 'e-gate');
    await addFact(app, {
      id: 'f-memory', subject: 'e-gate', predicate: 'has_status',
      evidence: [{ relation: 'supports', sourceType: 'memory', sourceId: memory.id }],
    });
    setNow('2026-01-03T00:00:00.000Z');
    const correction = await app.memory.correct({
      targetId: memory.id, content: 'the north gate is closed', origin: 'user',
    });
    assert.ok(correction.id);

    const then = await trace(app, 'memory', memory.id, { at: '2026-01-02T12:00:00Z' });
    assert.equal(then.data.found, true);
    assert.equal(then.data.disposition, 'supported');
    assert.equal(then.data.complete, true);
    assert.deepEqual(then.data.citations, ['fact:f-memory:supports:supported']);

    const now = await trace(app, 'memory', memory.id);
    assert.equal(now.data.status, 'superseded');
    assert.equal(now.data.disposition, 'superseded');
    assert.match(now.res.display, new RegExp(`replaced by ${correction.id.slice(0, 8)}`));

    const absent = await trace(app, 'memory', memory.id, { at: '2025-12-31T00:00:00Z' });
    assert.equal(absent.data.found, false);
    assert.equal(absent.data.disposition, 'not_yet_recorded');
  });

  test('knowledge conflicts and supersessions are reconstructed from records created by the cutoff', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-01-01T00:00:00.000Z');
    const k1 = (await app.knowledge.add({
      subject: 'gate', relationship: 'has_status', object: 'open', origin: 'user',
    })).record;
    setNow('2026-01-02T00:00:00.000Z');
    const k2 = (await app.knowledge.add({
      subject: 'gate', relationship: 'has_status', object: 'closed', origin: 'user',
    })).record;

    // The record exists at the cutoff but no world statement cites it, so its trace is its own
    // store's standing rather than support borrowed from a citation that does not exist yet.
    const alone = await trace(app, 'knowledge', k1.id, { at: '2026-01-01T12:00:00Z' });
    assert.equal(alone.data.found, true);
    assert.equal(alone.data.disposition, 'uncited');

    const conflicted = await trace(app, 'knowledge', k1.id, { at: '2026-01-02T12:00:00Z' });
    assert.equal(conflicted.data.disposition, 'contradicted');
    assert.match(conflicted.res.display, /conflicts with/);

    setNow('2026-01-03T00:00:00.000Z');
    // Superseding the earlier claim records a new claim and a separate event; the earlier record
    // and its conflict history stay stored.
    await app.knowledge.add({
      subject: 'gate', relationship: 'has_status', object: 'closed', supersedes: [k1.id], origin: 'user',
    });
    setNow('2026-01-04T00:00:00.000Z');

    const supersededThen = await trace(app, 'knowledge', k1.id, { at: '2026-01-02T12:00:00Z' });
    assert.equal(supersededThen.data.disposition, 'contradicted');
    assert.match(supersededThen.res.display, /history|conflicts with/);

    const now = await trace(app, 'knowledge', k1.id);
    assert.equal(now.data.status, 'superseded');
    assert.equal(now.data.disposition, 'superseded');
    assert.match(now.res.display, /lifecycle superseded/);

    const before = await trace(app, 'knowledge', k1.id, { at: '2025-12-31T00:00:00Z' });
    assert.equal(before.data.disposition, 'not_yet_recorded');
  });
});

describe('evidence availability at a historical cutoff', () => {
  test('a prediction citation is reported unavailable at a cutoff rather than reused from the present', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-01-01T00:00:00.000Z');
    const prediction = (await app.predictions.recordPrediction({
      capability: 'memory.list', expectation: 'success', subject: 'the gate stays open',
      expiresAt: '2027-01-01', origin: 'user',
    })).record;
    await addEntity(app, 'e-gate');
    await addFact(app, {
      id: 'f-pred', subject: 'e-gate', predicate: 'has_status',
      evidence: [{ relation: 'qualifies', sourceType: 'prediction', sourceId: prediction.id }],
    });
    setNow('2026-01-02T00:00:00.000Z');

    const then = await trace(app, 'fact', 'f-pred', { at: '2026-01-01T12:00:00Z' });
    assert.deepEqual(then.data.evidence, [
      `qualifies:prediction:${prediction.id}:as_of_unavailable:null:null`,
    ]);
    assert.equal(then.data.disposition, 'unverified');
    assert.equal(then.data.complete, false);
    assert.match(then.res.display, /\[NOT AVAILABLE AT CUTOFF\]/);

    const now = await trace(app, 'fact', 'f-pred');
    assert.deepEqual(now.data.evidence, [
      `qualifies:prediction:${prediction.id}:ok:true:true`,
    ]);
    assert.equal(now.data.disposition, 'supported');
    assert.equal(now.data.complete, true);
  });

  test('a damaged memory store makes the support unverifiable at any cutoff, not absent', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-01-01T00:00:00.000Z');
    const memory = await app.memory.add({ content: 'the north gate is open', kind: 'user_fact', source: 'user' });
    await addEntity(app, 'e-gate');
    await addFact(app, {
      id: 'f-damaged', subject: 'e-gate', predicate: 'has_status',
      evidence: [{ relation: 'supports', sourceType: 'memory', sourceId: memory.id }],
    });
    setNow('2026-01-02T00:00:00.000Z');
    const memoryPath = path.join(dir, 'memory.jsonl');
    const good = fs.readFileSync(memoryPath);
    fs.appendFileSync(memoryPath, 'this line is not JSON\n');
    try {
      const then = await trace(app, 'fact', 'f-damaged', { at: '2026-01-01T12:00:00Z' });
      assert.equal(then.data.disposition, 'unverified');
      assert.equal(then.data.complete, false);
      assert.equal(then.data.unavailable, 1);
      assert.match(then.res.display, /\[UNREADABLE\]/);

      const now = await trace(app, 'fact', 'f-damaged');
      assert.equal(now.data.disposition, 'unverified');
      assert.equal(now.data.unavailable, 1);
    } finally {
      fs.writeFileSync(memoryPath, good);
    }
  });

  test('a damaged world log refuses both historical reads instead of reporting an empty past', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-01-01T00:00:00.000Z');
    await addEntity(app, 'e-gate');
    await addFact(app, { id: 'f-broken', subject: 'e-gate', predicate: 'has_status' });
    setNow('2026-01-02T00:00:00.000Z');
    const worldPath = path.join(dir, 'world-model.jsonl');
    const good = fs.readFileSync(worldPath);
    fs.appendFileSync(worldPath, '{broken}\n');
    try {
      const state = await read(app, 'world.state_at', { at: '2026-01-01T12:00:00Z' });
      assert.notEqual(state.status, Outcome.SUCCESS_VERIFIED);
      assert.match(String(state.display ?? state.output), /corrupt|damaged|refusing incomplete/i);

      const traced = await read(app, 'world.belief.trace', {
        targetType: 'fact', target: 'f-broken', at: '2026-01-01T12:00:00Z',
      });
      assert.notEqual(traced.status, Outcome.SUCCESS_VERIFIED);
      assert.match(String(traced.display ?? traced.output), /corrupt|damaged|refusing incomplete/i);
    } finally {
      fs.writeFileSync(worldPath, good);
    }
  });
});

describe('time zones, boundaries and malformed cutoffs', () => {
  test('offsets and date-only cutoffs resolve to the same instants; expiry is half-open', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2023-12-01T00:00:00.000Z');
    await addEntity(app, 'e-gate');
    await addFact(app, {
      id: 'f-tz', subject: 'e-gate', predicate: 'has_status', validFrom: '2024-01-01T01:00:00+02:00',
    });
    await addFact(app, {
      id: 'f-window', subject: 'e-gate', predicate: 'has_owner', object: scalar('north trust'),
      validFrom: '2024-01-01', validUntil: '2025-01-01',
    });
    setNow('2026-01-01T00:00:00.000Z');

    const justBefore = await readOk(app, 'world.state_at', { at: '2023-12-31T22:59:59Z' });
    assert.equal(beliefRow(justBefore.data, 'fact:f-tz:'), 'fact:f-tz:historical:not_yet_valid');

    const boundary = await readOk(app, 'world.state_at', { at: '2023-12-31T23:00:00Z' });
    assert.equal(boundary.data.cutoff, '2023-12-31T23:00:00.000Z');
    assert.equal(beliefRow(boundary.data, 'fact:f-tz:'), 'fact:f-tz:supported:in_force');

    const sameInstant = await readOk(app, 'world.state_at', { at: '2024-01-01T01:00:00+02:00' });
    assert.equal(sameInstant.data.cutoff, '2023-12-31T23:00:00.000Z');
    assert.deepEqual(sameInstant.data.belief, boundary.data.belief);

    const dateOnly = await readOk(app, 'world.state_at', { at: '2024-01-01' });
    assert.equal(dateOnly.data.cutoff, '2024-01-01T00:00:00.000Z');
    assert.equal(beliefRow(dateOnly.data, 'fact:f-window:'), 'fact:f-window:supported:in_force');

    const lastSecond = await readOk(app, 'world.state_at', { at: '2024-12-31T23:59:59Z' });
    assert.equal(beliefRow(lastSecond.data, 'fact:f-window:'), 'fact:f-window:supported:in_force');

    const expiredAt = await readOk(app, 'world.state_at', { at: '2025-01-01T00:00:00Z' });
    assert.equal(beliefRow(expiredAt.data, 'fact:f-window:'), 'fact:f-window:historical:expired');
  });

  test('impossible dates and zone-less local times are rejected at the action and store boundaries', async () => {
    const dir = tempDir();
    const { app } = appOn(dir);
    const memory = await app.memory.add({ content: 'the north gate is open', kind: 'user_fact', source: 'user' });
    const knowledge = (await app.knowledge.add({
      subject: 'gate', relationship: 'has_status', object: 'open', origin: 'user',
    })).record;

    for (const at of ['2026-02-30', '2026-01-01T00:00:00', 'not-a-date']) {
      const state = await read(app, 'world.state_at', { at });
      assert.equal(state.status, Outcome.INPUT_REJECTED, `state_at accepted ${at}`);
      const traced = await read(app, 'world.belief.trace', { targetType: 'fact', target: 'f-any', at });
      assert.equal(traced.status, Outcome.INPUT_REJECTED, `trace accepted ${at}`);
    }

    await assert.rejects(() => app.memory.traceMany([memory.id], { at: '2026-02-30' }), (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /ISO date/);
      return true;
    });
    await assert.rejects(() => app.knowledge.getMany([knowledge.id], { at: '2026-01-01T00:00:00' }), (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /ISO date/);
      return true;
    });
  });
});

describe('read-only and cross-process guarantees', () => {
  test('repeated historical queries are deterministic and write no data store', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-01-01T00:00:00.000Z');
    const memory = await app.memory.add({ content: 'the north gate is open', kind: 'user_fact', source: 'user' });
    const knowledge = (await app.knowledge.add({
      subject: 'gate', relationship: 'has_status', object: 'open', origin: 'user',
    })).record;
    await addEntity(app, 'e-gate');
    await addFact(app, {
      id: 'f-readonly', subject: 'e-gate', predicate: 'has_status',
      evidence: [{ relation: 'supports', sourceType: 'memory', sourceId: memory.id }],
    });
    setNow('2026-01-02T00:00:00.000Z');

    const before = snapshot(dir);
    const one = await trace(app, 'fact', 'f-readonly', { at: '2026-01-01T12:00:00Z' });
    const two = await trace(app, 'fact', 'f-readonly', { at: '2026-01-01T12:00:00Z' });
    const memoryTrace = await trace(app, 'memory', memory.id, { at: '2026-01-01T12:00:00Z' });
    const knowledgeTrace = await trace(app, 'knowledge', knowledge.id, { at: '2026-01-01T12:00:00Z' });
    const state = await readOk(app, 'world.state_at', { at: '2026-01-01T12:00:00Z' });

    assert.deepEqual(one.data, two.data);
    assert.equal(one.data.authorizes, false);
    assert.equal(memoryTrace.data.authorizes, false);
    assert.equal(knowledgeTrace.data.authorizes, false);
    assert.equal(state.data.authorizes, undefined);
    assert.deepEqual(snapshot(dir), before);
  });

  test('records added by another process are visible to historical reads in this one', async () => {
    const dir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
    const added = await runCli([
      'world', 'entity', 'add', '--category', 'place', 'North Gate',
    ], env);
    assert.equal(added.code, 0, added.stdout + added.stderr);
    assert.match(added.stdout, /Entity [A-Za-z0-9-]+ created/);
    const worldRecords = () => fs.readFileSync(path.join(dir, 'world-model.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const entityId = worldRecords().find((record) => record.type === 'entity_created').entityId;

    const fact = await runCli([
      'world', 'fact', 'add', '--subject', entityId, '--predicate', 'has_status',
      '--object-value', 'open', '--valid-from', '2024-01-01',
    ], env);
    assert.equal(fact.code, 0, fact.stdout + fact.stderr);
    // The CLI prints a short id; the store's full id is the one that keys the replayed state.
    const factId = worldRecords().find((record) => record.type === 'fact_asserted').factId;

    // A cutoff far beyond the child process's real clock still replays every record it wrote.
    const { app } = appOn(dir);
    const replay = await app.worldModel.stateAt('2099-01-01T00:00:00Z');
    assert.equal(replay.excluded, 0);
    assert.equal(replay.state.entities.has(entityId), true);
    assert.equal(replay.state.facts.has(factId), true);
    assert.equal(replay.belief.counts.believed, 1);

    const traced = await trace(app, 'fact', factId, { at: '2099-01-01T00:00:00Z' });
    assert.equal(traced.data.disposition, 'supported');
    assert.equal(traced.data.mode, 'historical');
    assert.equal(traced.data.asOf.records, 2);

    const cliOne = await runCli(['world', 'trace', 'fact', factId, '--at', '2099-01-01T00:00:00Z'], env);
    const cliTwo = await runCli(['world', 'trace', 'fact', factId, '--at', '2099-01-01T00:00:00Z'], env);
    assert.equal(cliOne.code, 0, cliOne.stdout + cliOne.stderr);
    assert.equal(cliTwo.code, 0, cliTwo.stdout + cliTwo.stderr);
    // Two separate processes read at two instants and write two audit records. Everything the
    // historical reading consists of is identical; only the read instant and the audit id differ.
    const stable = (out) => out
      .replace(/Current standing at \S+:/, 'Current standing at <read time>:')
      .replace(/Audit: recorded in operations\.jsonl \([^)]*\)\n?/, '');
    assert.equal(stable(cliOne.stdout), stable(cliTwo.stdout));
    assert.match(cliOne.stdout, /historical cutoff: 2099-01-01T00:00:00\.000Z/);
    assert.match(cliOne.stdout, /A trace is descriptive/);
  });
});
