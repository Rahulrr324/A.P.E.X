// Batch AP-16: one read-only reconstruction across the stores that can answer a cutoff.
//
// The question is what APEX had recorded by a specified historical instant, and what each store
// recorded afterwards. Every test here is deterministic: the clock is injected, the fixtures are
// real audit, experience, prediction and world records written by the real stores, and no model is
// contacted. The assertions are about the separation the milestone is built on:
//
//   recorded time, not event time   a cutoff filters on when a record was stored; the event it
//                                  describes keeps its own time and is reported beside it;
//   later is never folded back      an evaluation, withdrawal, correction, feedback or retraction
//                                  recorded after the cutoff is counted and marked as later, and it
//                                  never changes the past reading;
//   a source that cannot answer is named   a damaged or unsupported source is disclosed, never
//                                  omitted into an optimistic "nothing was recorded";
//   bounded and read-only           rows and citations are bounded and the bound is declared; the
//                                  historical read writes nothing and authorizes nothing.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome, OPERATION_SCHEMA } from '../src/outcomes.js';
import { planRefusal } from '../src/tasks/planner.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const UE = [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }];
const FILES = ['memory.jsonl', 'knowledge.jsonl', 'world-model.jsonl', 'predictions.jsonl', 'experiences.jsonl'];
const EXP = 'experiences.jsonl';
const LEDGER = 'predictions.jsonl';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

// The clock is mutable so one fixture can record events at distinct stored times without sleeping.
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
    now() { return state.now; },
  };
}

const dataOf = (res) => res.operation.steps[0].result.data;
const viewOf = (res) => dataOf(res).view;

// Seed the audit record an experience must cite. `at` is when the event happened; the experience
// itself is recorded at the clock's current instant, which is what a cutoff is compared against.
let seq = 0;
async function audited(app, { at, capability = 'memory.add' } = {}) {
  seq += 1;
  const id = `ap16-op-${String(seq).padStart(4, '0')}`;
  assert.equal(typeof at, 'string', 'an event needs an explicit time');
  await app.operations.append({
    schema: OPERATION_SCHEMA,
    id,
    capability,
    origin: 'user',
    decision: 'answer',
    status: Outcome.SUCCESS_VERIFIED,
    requestedAt: at,
    finishedAt: at,
    output: 'verified',
  });
  return id;
}

async function experience(app, { eventAt, subject = 'a recorded operation', replaces = [], capability = 'memory.add' } = {}) {
  const operationId = await audited(app, { at: eventAt, capability });
  const res = await app.controller.experienceRecord({ operationId, subject, replaces });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
  return dataOf(res);
}

async function prediction(app, { capability = 'memory.add', expectation = 'success', subject, expiresAt, evidence } = {}) {
  const res = await app.controller.predictionRecord({ capability, expectation, subject, expiresAt, evidence });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
  return dataOf(res);
}

async function history(app, at, extra = {}) {
  const res = await app.controller.historyReconstruct({ at, ...extra });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
  return viewOf(res);
}

function readLines(dir, file) {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function bytesOf(dir) {
  const out = {};
  for (const file of FILES) {
    try {
      out[file] = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      out[file] = null;
    }
  }
  return out;
}

function cloneLine(dir, file, index, edit) {
  const lines = readLines(dir, file);
  const source = lines.at(index);
  assert.ok(source, `fixture expected a record at ${file}[${index}]`);
  return { ...JSON.parse(JSON.stringify(source)), ...edit(JSON.parse(JSON.stringify(source))) };
}

function appendLine(dir, file, record) {
  fs.appendFileSync(path.join(dir, file), `${JSON.stringify(record)}\n`);
}

// A fixture with one event, one expectation over that capability, and one event inside the horizon.
// The cutoff falls between the recorded evidence and everything the user said afterwards.
const CUTOFF = '2026-01-15T12:00:00.000Z';
async function lifecycleFixture(dir) {
  const { app, setNow } = appOn(dir, '2026-01-10T09:00:00.000Z');
  const first = await experience(app, { eventAt: '2026-01-10T08:00:00.000Z', subject: 'the note was stored' });
  const opened = await prediction(app, {
    subject: 'the next note write is accepted',
    expiresAt: '2026-01-20T00:00:00.000Z',
    evidence: { supportingExperienceIds: [first.id] },
  });
  setNow('2026-01-12T10:00:00.000Z');
  const deciding = await experience(app, { eventAt: '2026-01-12T09:00:00.000Z', subject: 'the second note was stored' });
  setNow('2026-01-13T10:00:00.000Z');
  assert.equal((await app.controller.worldWrite('world.entity.add', {
    id: 'e-gate', category: 'place', name: 'North Gate', evidence: UE,
  })).status, Outcome.SUCCESS_VERIFIED);
  assert.equal((await app.controller.worldWrite('world.fact.add', {
    id: 'f-open', subject: 'e-gate', predicate: 'has_status', object: { kind: 'scalar', valueType: 'string', value: 'open' },
    validFrom: '2026-01-01', evidence: UE,
  })).status, Outcome.SUCCESS_VERIFIED);

  // Everything below this line is recorded after the cutoff.
  setNow('2026-01-16T00:00:00.000Z');
  assert.equal((await app.controller.feedbackRecord({
    target: deciding.id, assessment: 'useful', guidance: 'keep doing it this way',
  })).status, Outcome.SUCCESS_VERIFIED);
  setNow('2026-01-17T00:00:00.000Z');
  const correction = await experience(app, { eventAt: '2026-01-17T00:00:00.000Z', subject: 'the first note, corrected', replaces: [first.id] });
  assert.equal((await app.controller.worldWrite('world.statement.retract', {
    targetType: 'fact', target: 'f-open', reason: 'the gate closed', evidence: UE,
  })).status, Outcome.SUCCESS_VERIFIED);
  setNow('2026-01-18T00:00:00.000Z');
  assert.equal((await app.controller.predictionEvaluate({ target: opened.id })).status, Outcome.SUCCESS_VERIFIED);
  setNow('2026-01-19T00:00:00.000Z');
  const later = await prediction(app, { capability: 'knowledge.add', subject: 'the next knowledge write is accepted', expiresAt: '2026-01-29T00:00:00.000Z' });
  setNow('2026-01-20T00:00:00.000Z');
  assert.equal((await app.controller.predictionInvalidate({ target: later.id, reason: 'the plan changed' })).status, Outcome.SUCCESS_VERIFIED);
  setNow('2026-02-01T00:00:00.000Z');

  return { app, setNow, first, opened, deciding, correction, later };
}

describe('AP-16 the cross-store reconstruction is a read', () => {
  test('the action is read-only, user and model origins, and refuses a plan step', () => {
    const dir = tempDir();
    const { app } = appOn(dir);
    const def = app.registry.get('history.reconstruct');
    assert.equal(def.permission, 'read');
    assert.deepEqual([...def.origins].sort(), ['model', 'user']);
    assert.equal(def.plannable, false);
    assert.equal(app.registry.authorize('history.reconstruct', 'user').decision, 'allow');
    assert.equal(app.registry.authorize('history.reconstruct', 'model').decision, 'allow');
    // A plan step that names it is refused for a stated reason, not by being silently dropped.
    assert.equal(planRefusal(app.registry, def, 'user'), 'action history.reconstruct cannot be part of a plan');
    assert.equal(planRefusal(app.registry, def, 'model'), 'action history.reconstruct cannot be part of a plan');
  });

  test('the cutoff is required, and a zone-less or impossible instant is refused before anything is read', async () => {
    const dir = tempDir();
    const { app } = appOn(dir);
    const before = bytesOf(dir);

    for (const at of [undefined, null, '', '2026-02-02T00:00:00', '2026-02-30', 'yesterday']) {
      const res = await app.controller.historyReconstruct({ at });
      assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED, `"${at}" must be refused`);
      assert.match(String(res.display ?? res.output), /at (is required|must be an ISO)/);
    }
    assert.deepEqual(bytesOf(dir), before, 'a refused cutoff reads and writes nothing');
  });

  test('unsupported sources are named with a reason, and the answer authorizes nothing', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const view = await history(app, CUTOFF);

    assert.equal(view.authorizes, false);
    assert.equal(view.schema, 'apex.cognitive-history.v1');
    assert.match(view.rule, /recorded time is not event time/);
    // AP-17 integrated the executive logs; memory and knowledge remain the disclosed boundary.
    assert.deepEqual(view.unsupported.map((entry) => entry.source), ['memory', 'knowledge']);
    for (const entry of view.unsupported) {
      assert.equal(entry.status, 'unsupported');
      assert.ok(entry.reason.length > 20, `${entry.source} must state why it cannot answer`);
    }
    // The operations audit log is the one an unwary reader would assume is queryable: its
    // `requestedAt` is not a recorded-at field, and the answer must say so even though a current
    // audit view is included.
    assert.equal(view.operations.supportsCutoff, false);
    assert.equal(view.operations.recordedAtKnown, false);
    assert.match(view.cutoffSemantics.operations, /no recorded-at/);
  });
});

describe('AP-16 what each store had recorded by a cutoff', () => {
  test('experience, predictions and world replay to the cutoff while later records stay separate', async () => {
    const dir = tempDir();
    const { app, first, deciding, correction, opened, later } = await lifecycleFixture(dir);
    const view = await history(app, CUTOFF);

    // The read was consistent and complete, and every integrated source answered.
    assert.equal(view.cutoff, CUTOFF);
    assert.equal(view.asOf.state, 'consistent');
    assert.equal(view.asOf.complete, true);
    assert.equal(view.asOf.verifiable, true);
    assert.deepEqual(view.asOf.sources.map((entry) => entry.name), ['experience', 'predictions', 'world', 'goals', 'plans', 'tasks', 'operations']);
    const sourceStatus = Object.fromEntries(view.asOf.sources.map((entry) => [entry.name, entry.status]));
    assert.deepEqual(sourceStatus, {
      experience: 'read',
      predictions: 'read',
      world: 'read',
      // This fixture records no executive events, so those logs do not exist yet; that is `absent`,
      // which the snapshot still certifies, rather than an omission.
      goals: 'absent',
      plans: 'absent',
      tasks: 'absent',
      operations: 'read',
    });
    for (const entry of view.asOf.sources) assert.equal(entry.inspectable, true);
    // The three executive logs answer the cutoff; the audit log is a current read and says so.
    assert.deepEqual(view.asOf.sources.filter((entry) => entry.supportsCutoff === false).map((entry) => entry.name), ['operations']);

    // Experience: the two events recorded by the cutoff, neither correction nor feedback yet.
    assert.equal(view.experience.available, true);
    assert.equal(view.experience.counts.experiences, 2);
    assert.equal(view.experience.counts.feedback, 0);
    assert.equal(view.experience.counts.live, 2);
    assert.equal(view.experience.counts.superseded, 0);
    assert.equal(view.experience.excluded, 2, 'the later feedback and the correction are dated after the cutoff');
    const firstRow = view.experience.rows.find((row) => row.id === first.id);
    const decidingRow = view.experience.rows.find((row) => row.id === deciding.id);
    assert.equal(firstRow.active, true);
    assert.equal(firstRow.superseded, false);
    assert.deepEqual(firstRow.replacedBy, []);
    assert.equal(firstRow.correctedLater, true, 'the later correction is disclosed, not applied');
    assert.equal(firstRow.now.active, false);
    assert.equal(firstRow.occurredAt, '2026-01-10T08:00:00.000Z', 'event time is kept beside recorded time');
    assert.equal(decidingRow.feedback.total, 0);
    assert.equal(decidingRow.feedbackAddedLater, true);

    // Predictions: one expectation by the cutoff, not evaluated and not withdrawn then.
    assert.equal(view.predictions.available, true);
    assert.equal(view.predictions.recorded, 1);
    assert.equal(view.predictions.excluded, 3, 'the later prediction, its withdrawal, and the evaluation');
    const openedRow = view.predictions.rows.find((row) => row.id === opened.id);
    assert.equal(openedRow.evaluationAt, null);
    assert.equal(openedRow.verdict, null);
    assert.equal(openedRow.evaluationRecordedLater, true);
    assert.equal(openedRow.decision, 'matched', 'evidence inside the horizon at the cutoff supports it');
    assert.equal(openedRow.deciding.id, deciding.id);
    assert.equal(openedRow.invalidation, null);
    const current = view.predictions.current.rows.find((row) => row.id === opened.id);
    assert.equal(current.verdict, 'matched');
    assert.equal(current.evaluationAt, '2026-01-18T00:00:00.000Z');
    assert.equal(view.predictions.current.rows.find((row) => row.id === later.id).status, 'invalidated');
    assert.equal(view.predictions.rows.some((row) => row.id === later.id), false, 'a later expectation is not in the past view');

    // World: the fact was asserted and not yet retracted at the cutoff.
    assert.equal(view.world.available, true);
    assert.equal(view.world.counts.entities, 1);
    assert.equal(view.world.counts.facts, 1);
    assert.equal(view.world.counts.retractions, 0);
    assert.equal(view.world.later.changes >= 1, true);
    assert.equal(view.world.later.rows.some((row) => row.kind === 'retracted'), true);

    // Later totals are counted without being used to decide the past.
    assert.equal(view.later.experiencesRecorded, 1);
    assert.equal(view.later.feedbackRecorded, 1);
    assert.equal(view.later.evaluationsRecorded, 1);
    assert.equal(view.later.predictionsRecorded, 1);
    assert.equal(view.later.invalidationsRecorded, 1);
    assert.equal(view.experience.rows.some((row) => row.id === correction.id), false);

    // A cited record that existed at the cutoff is resolved, not assumed.
    const cited = view.citations.rows.find((row) => row.kind === 'experience' && row.id === first.id);
    assert.equal(cited.state, 'recorded');
  });

  test('the same fixture at a later cutoff includes the later lifecycle rather than absorbing it backward', async () => {
    const dir = tempDir();
    const { app, first, deciding, correction, opened } = await lifecycleFixture(dir);
    const past = await history(app, CUTOFF);
    const after = await history(app, '2026-01-21T00:00:00.000Z');

    assert.equal(after.experience.counts.experiences, 3);
    assert.equal(after.experience.counts.feedback, 1);
    assert.equal(after.experience.counts.superseded, 1);
    const firstRow = after.experience.rows.find((row) => row.id === first.id);
    assert.equal(firstRow.active, false);
    assert.deepEqual(firstRow.replacedBy, [correction.id]);
    assert.equal(firstRow.correctedLater, false, 'inside this cutoff the correction is not later');

    assert.equal(after.predictions.recorded, 2);
    const openedRow = after.predictions.rows.find((row) => row.id === opened.id);
    assert.equal(openedRow.verdict, 'matched');
    assert.equal(openedRow.status, 'evaluated');
    assert.equal(openedRow.evaluationRecordedLater, false);
    assert.equal(after.world.counts.facts, 1);
    assert.equal(after.world.counts.retractions, 1);
    assert.equal(after.world.later.changes, 0, 'a cutoff at the last recorded change has nothing later to report');

    // The past view did not move because a later cutoff was asked for.
    assert.equal(past.experience.counts.feedback, 0);
    assert.equal(past.predictions.rows[0].verdict, null);
  });

  test('a ledger line citing a record dated after the cutoff is recorded_later, never past evidence', async () => {
    const dir = tempDir();
    const { app, correction } = await lifecycleFixture(dir);
    // A line the store would refuse to write: an expectation recorded before the cutoff that cites
    // an experience recorded after it. This is the conflicting-evidence shape the reader must not
    // resolve in favour of the past, so it is placed directly in the ledger.
    // A capability no experience recorded by the cutoff covers keeps the only candidate evidence the
    // cited record, so the later record cannot be reached by an independent event in the horizon.
    const line = cloneLine(dir, LEDGER, 0, (source) => ({
      id: randomUUID(),
      capability: 'knowledge.add',
      evidence: {
        ...source.evidence,
        supportingExperienceIds: [correction.id],
        contradictingExperienceIds: [],
        feedbackIds: [],
      },
    }));
    appendLine(dir, LEDGER, line);

    const view = await history(app, CUTOFF);
    const cited = view.citations.rows.find((entry) => entry.kind === 'experience' && entry.id === correction.id);
    assert.equal(cited.state, 'recorded_later');
    assert.match(cited.reason, /dated after 2026-01-15T12:00:00.000Z/);
    // The fabricated expectation is replayed as it was: nothing established it at the cutoff.
    const crafted = view.predictions.rows.find((entry) => entry.id === line.id);
    assert.equal(crafted.verdict, null);
    assert.equal(crafted.decision, 'outcome_unavailable', 'nothing inside the horizon established it by the cutoff');
  });
});

describe('AP-16 adverse and edge conditions', () => {
  test('a damaged experience log is named, and predictions report their horizons as unread', async () => {
    const dir = tempDir();
    const { app, opened } = await lifecycleFixture(dir);
    fs.appendFileSync(path.join(dir, EXP), '{ this is not a record\n');

    const view = await history(app, CUTOFF);
    assert.equal(view.experience.available, false);
    assert.equal(view.experience.status, 'damaged');
    assert.match(view.experience.reason, /corrupt line/);
    assert.equal(view.asOf.complete, false);
    assert.equal(view.asOf.verifiable, false, 'a damaged source makes the combined reading unverifiable');
    // The ledger is still readable, and its horizons say the past evidence could not be read.
    assert.equal(view.predictions.available, true);
    const row = view.predictions.rows.find((entry) => entry.id === opened.id);
    assert.equal(row.evidenceAvailable, false);
    assert.equal(row.decision, 'evidence_unavailable');
    assert.match(row.decisionReason, /without an experience snapshot/);
    const cited = view.citations.rows.find((entry) => entry.kind === 'experience');
    assert.equal(cited.state, 'unavailable', 'an unread source makes a citation unavailable, never missing');
    assert.match(view.note, /not what was objectively true/);
  });

  test('a damaged prediction ledger is named while the experience and world answers stay available', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    fs.appendFileSync(path.join(dir, LEDGER), 'not json\n');

    const view = await history(app, CUTOFF);
    assert.equal(view.predictions.available, false);
    assert.equal(view.predictions.status, 'damaged');
    assert.match(view.predictions.reason, /corrupt line/);
    assert.equal(view.experience.available, true);
    assert.equal(view.experience.counts.experiences, 2);
    assert.equal(view.world.available, true);
    assert.equal(view.asOf.complete, false);
    assert.equal(view.asOf.verifiable, false);
  });

  test('a ledger line with a missing or malformed stored time is refused as damage, never placed at a cutoff', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const before = await history(app, '2026-01-21T00:00:00.000Z');
    assert.equal(before.predictions.available, true);
    assert.equal(before.predictions.records, 4);
    // The ledger validates `createdAt` when it loads a line, so a record with an unusable stored time
    // is not an undated record to be counted: it is damage, and the whole ledger is disclosed as
    // unreadable rather than replayed with the line guessed into or out of the cutoff.
    appendLine(dir, LEDGER, cloneLine(dir, LEDGER, 0, (source) => ({ ...source, id: randomUUID(), createdAt: 'not-a-date' })));
    appendLine(dir, LEDGER, cloneLine(dir, LEDGER, 0, (source) => {
      const copy = { ...source, id: randomUUID() };
      delete copy.createdAt;
      return copy;
    }));

    const view = await history(app, '2026-01-21T00:00:00.000Z');
    assert.equal(view.predictions.available, false);
    assert.equal(view.predictions.status, 'damaged');
    assert.match(view.predictions.reason, /invalid createdAt|refusing an incomplete/);
    assert.equal(view.predictions.records, null);
    assert.equal(view.asOf.complete, false);
    assert.equal(view.asOf.verifiable, false);
    const rendered = String((await app.controller.historyReconstruct({ at: CUTOFF })).display);
    assert.match(rendered, /predictions: damaged/);
  });

  test('a record appended by another process is visible to the next read and excluded from an earlier cutoff', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const before = await history(app, CUTOFF);

    const other = appOn(dir, '2026-01-25T09:00:00.000Z');
    const added = await experience(other.app, { eventAt: '2026-01-25T09:00:00.000Z', subject: 'a note written by another process' });
    other.setNow('2026-02-02T00:00:00.000Z');

    const after = await history(app, CUTOFF);
    assert.equal(after.experience.counts.experiences, before.experience.counts.experiences, 'the past view does not grow');
    assert.equal(after.experience.excluded, before.experience.excluded + 1);
    assert.equal(after.experience.rows.some((row) => row.id === added.id), false);
    assert.equal(after.later.experiencesRecorded, before.later.experiencesRecorded + 1);
    assert.equal(after.experience.rows.length, before.experience.rows.length);
  });

  test('a store that moves during the read is reported as concurrent_modification, not as a complete answer', async () => {
    const dir = tempDir();
    const { app, opened } = await lifecycleFixture(dir);
    const template = readLines(dir, LEDGER)[0];
    const original = app.worldModel.historicalView.bind(app.worldModel);
    let writes = 0;
    // A writer that appends a valid ledger line every time the last source is read: the certification
    // taken at the start of each attempt can never match the end of that same attempt.
    app.worldModel.historicalView = async (...args) => {
      const result = await original(...args);
      writes += 1;
      appendLine(dir, LEDGER, { ...template, id: randomUUID(), subject: `concurrent write ${writes}` });
      return result;
    };

    const res = await app.controller.historyReconstruct({ at: CUTOFF });
    // A writer that moved the ledger means the first answer cannot be re-read identically, so the
    // operation reports that its verification failed instead of claiming a confirmed reading.
    assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED);
    const view = viewOf(res);
    assert.equal(view.asOf.state, 'concurrent_modification');
    assert.equal(view.asOf.complete, false);
    assert.equal(view.asOf.attempts >= 2, true, 'the read retried before reporting the movement');
    assert.equal(writes >= 2, true);
    // The answer is still assembled and names what it saw; it just does not claim a quiescent window.
    assert.equal(view.predictions.rows.some((row) => row.id === opened.id), true);
    assert.equal(view.asOf.snapshot.state, 'concurrent_modification');
    assert.equal(view.asOf.attempts <= 3, true, 'the retry is bounded and disclosed');
  });

  test('rows and citations are bounded, and the bound is stated rather than presented as all there is', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-03-01T00:00:00.000Z');
    for (let i = 0; i < 3; i += 1) {
      setNow(`2026-03-0${i + 1}T00:00:00.000Z`);
      await experience(app, { eventAt: `2026-03-0${i + 1}T00:00:00.000Z`, subject: `event ${i + 1}` });
    }
    setNow('2026-03-04T00:00:00.000Z');
    await prediction(app, { subject: 'first expectation', expiresAt: '2026-03-10T00:00:00.000Z' });
    setNow('2026-03-05T00:00:00.000Z');
    await prediction(app, { capability: 'knowledge.add', subject: 'second expectation', expiresAt: '2026-03-10T00:00:00.000Z' });

    const view = await history(app, '2026-03-06T00:00:00.000Z', { limit: 1 });
    assert.equal(view.limits.rows, 1);
    assert.equal(view.limits.citations, 40);
    assert.equal(view.experience.rows.length, 1);
    assert.equal(view.experience.total, 3);
    assert.equal(view.experience.truncated, true);
    assert.equal(view.predictions.opened, 1);
    assert.equal(view.predictions.recorded, 2);
    assert.equal(view.predictions.truncated, true);
    assert.match(String((await app.controller.historyReconstruct({ at: '2026-03-06T00:00:00.000Z', limit: 1 })).display), /2 older prediction\(s\) not opened|older row\(s\) not shown/);
  });

  test('two reads of the same cutoff agree on every cutoff-capable source; the audit view is current-only', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const first = await history(app, CUTOFF);
    const second = await history(app, CUTOFF);
    // Every cutoff-capable section is a pure function of the records stored by the cutoff. The
    // operations section is excluded because it is a current read: each completed reconstruction
    // appends its own audit line, so the second read necessarily sees one more record. That growth
    // is disclosed, not smoothed away.
    const cutoffOnly = (view) => JSON.stringify({
      cutoff: view.cutoff,
      experience: view.experience,
      predictions: view.predictions,
      world: view.world,
      goals: view.goals,
      plans: view.plans,
      tasks: view.tasks,
      citations: view.citations,
      operationCitations: view.operationCitations,
      cutoffSemantics: view.cutoffSemantics,
      unsupported: view.unsupported,
      later: { ...view.later, operationsFinishedLater: null },
    });
    assert.equal(cutoffOnly(first), cutoffOnly(second));
    assert.equal(first.readAt, second.readAt);
    assert.equal(first.operations.supportsCutoff, false);
    assert.equal(second.operations.counts.total > first.operations.counts.total, true);
    assert.equal(second.operations.counts.byStateAtCutoff.later > first.operations.counts.byStateAtCutoff.later, true);
    assert.equal(first.asOf.state, 'consistent');
    assert.equal(second.asOf.state, 'consistent');
  });

  test('the historical read writes nothing and calls no model', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const before = bytesOf(dir);
    let gatewayCalls = 0;
    const original = app.gateway.complete.bind(app.gateway);
    app.gateway.complete = (...args) => { gatewayCalls += 1; return original(...args); };

    const res = await app.controller.historyReconstruct({ at: CUTOFF });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    assert.equal(gatewayCalls, 0);
    assert.deepEqual(bytesOf(dir), before, 'no experience, prediction, world, memory, or knowledge line was added');
    // The audited read records itself, and the audit line is the only thing written.
    assert.equal(readLines(dir, 'operations.jsonl').some((record) => record.capability === 'history.reconstruct'), true);
  });

  test('a cutoff is compared as an instant, so offsets and date-only forms normalize to UTC', async () => {
    const dir = tempDir();
    const { app } = appOn(dir, '2026-01-31T23:30:00.000Z');
    await prediction(app, { subject: 'a late expectation', expiresAt: '2026-02-10T00:00:00.000Z' });

    const earlier = await history(app, '2026-02-01T01:00:00+02:00');
    assert.equal(earlier.cutoff, '2026-01-31T23:00:00.000Z', '01:00+02:00 is the same instant as 23:00Z');
    assert.equal(earlier.predictions.recorded, 0);

    const later = await history(app, '2026-02-01T02:00:00+02:00');
    assert.equal(later.cutoff, '2026-02-01T00:00:00.000Z');
    assert.equal(later.predictions.recorded, 1);

    const dateOnly = await history(app, '2026-02-01');
    assert.equal(dateOnly.cutoff, '2026-02-01T00:00:00.000Z');
    assert.equal(dateOnly.predictions.recorded, 1);
  });
});

describe('AP-16 the CLI history command', () => {
  test('history --at answers as data and keeps the plain listing separate', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const env = cleanEnv({ APEX_DATA_DIR: dir });

    const res = await runCli(['history', '--at', CUTOFF, '--json'], env);
    assert.equal(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.split('\nAudit: recorded in operations.jsonl')[0]);
    assert.equal(parsed.view.schema, 'apex.cognitive-history.v1');
    assert.equal(parsed.view.cutoff, CUTOFF);
    assert.equal(parsed.view.asOf.complete, true);
    assert.equal(parsed.view.authorizes, false);

    const display = await runCli(['history', '--at', CUTOFF], env);
    assert.equal(display.code, 0, display.stderr);
    assert.match(display.stdout, /Cognitive history at 2026-01-15T12:00:00.000Z/);
    assert.match(display.stdout, /unsupported: memory, knowledge/);

    // Without --at the command is still the unaudited audit-log listing it has always been.
    const listing = await runCli(['history'], env);
    assert.equal(listing.code, 0, listing.stderr);
    assert.match(listing.stdout, /history\.reconstruct/);
    assert.doesNotMatch(listing.stdout, /Cognitive history at/);
  });

  test('a zone-less cutoff is a usage-level refusal from the CLI too', async () => {
    const dir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dir });
    const res = await runCli(['history', '--at', '2026-01-15T12:00:00'], env);
    assert.equal(res.code, 1);
    assert.match(`${res.stdout}${res.stderr}`, /time zone/);
  });
});

describe('AP-16 no store read is duplicated for one historical query', () => {
  test('one reconstruction reads each contributing store once per attempt', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    let experienceReads = 0;
    let predictionReads = 0;
    let worldReads = 0;
    const e = app.experience.historicalView.bind(app.experience);
    const p = app.predictions.historicalView.bind(app.predictions);
    const w = app.worldModel.historicalView.bind(app.worldModel);
    app.experience.historicalView = async (...args) => { experienceReads += 1; return e(...args); };
    app.predictions.historicalView = async (...args) => { predictionReads += 1; return p(...args); };
    app.worldModel.historicalView = async (...args) => { worldReads += 1; return w(...args); };

    const res = await app.controller.historyReconstruct({ at: CUTOFF });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    // The action's verifier performs its own independent reconstruction, so the read count is two
    // per store for one operation - not one per prediction, citation, or source.
    assert.equal(experienceReads, 2);
    assert.equal(predictionReads, 2);
    assert.equal(worldReads, 2);
  });
});
