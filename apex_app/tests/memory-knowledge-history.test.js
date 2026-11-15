// Batch AP-18: memory and knowledge in the cross-store reconstruction - what each store had recorded
// by a cutoff, what its own lifecycle implied then, and what later records changed.
//
// Every test is deterministic. The clock is injected, the fixtures are real memory and knowledge
// records written through the real actions and stores, and no model is contacted. The assertions are
// about the separation the milestone is built on:
//
//   recorded time, not event time   memory and knowledge carry only `createdAt`: when the record was
//                                  appended. A cutoff filters on that and nothing else, so an old
//                                  event described in a later-recorded claim is absent from the
//                                  earlier view.
//   later is never folded back      a correction, retraction, resolution, or supersession recorded
//                                  after the cutoff is counted and marked as later. The past row
//                                  keeps the state its record set implied then, and the present
//                                  standing is reported beside it.
//   the record models are not merged  memory has no retraction event and derives supersession from a
//                                  later record naming its target; knowledge has retraction and
//                                  resolution events. Each answer keeps its own vocabulary.
//   a source that cannot answer is named   a corrupt store is disclosed as damaged and makes the
//                                  combined reading incomplete, never an optimistic empty listing.
//   bounded and read-only           rows are bounded and the bound is declared; the read writes
//                                  nothing, calls no model, and authorizes nothing.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome, OPERATION_SCHEMA } from '../src/outcomes.js';
import { contributingStores } from '../src/evidence/snapshot.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const EARLY = '2026-01-05T09:00:00.000Z';
const CUTOFF = '2026-01-15T12:00:00.000Z';
const AFTER = '2026-01-20T10:00:00.000Z';
const LATE = '2026-01-25T00:00:00.000Z';

const MEMORY = 'memory.jsonl';
const KNOWLEDGE = 'knowledge.jsonl';
const OPERATIONS = 'operations.jsonl';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

// The clock is mutable so one fixture can record events at distinct stored times without sleeping.
function appOn(dir, start = EARLY) {
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

async function historyResponse(app, at, extra = {}) {
  return app.controller.historyReconstruct({ at, ...extra });
}

async function history(app, at, extra = {}) {
  const res = await historyResponse(app, at, extra);
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
  return dataOf(res).view;
}

// Every write below goes through the real action and the real store. The operation id is explicit
// where a test resolves an audit citation, and null elsewhere so the fixture does not manufacture
// citation rows it is not testing.
async function addMemory(app, content, { sensitivity = 'normal', operationId = null } = {}) {
  const input = { content };
  if (sensitivity !== 'normal') input.sensitivity = sensitivity;
  const step = await app.controller.runAction('memory.add', input, 'user', operationId);
  assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
  return step.result.data;
}

async function correctMemory(app, targetId, content, operationId = null) {
  const step = await app.controller.runAction('memory.correct', { targetId, content, resolve: true }, 'user', operationId);
  assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
  return step.result.data;
}

async function addKnowledge(app, {
  subject, relationship, object, evidence = null, supersedes = [], operationId = null,
}) {
  const input = { subject, relationship, object };
  if (evidence !== null) input.evidence = evidence;
  if (supersedes.length > 0) input.supersedes = supersedes;
  const step = await app.controller.runAction('knowledge.add', input, 'user', operationId);
  assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
  return step.result.data;
}

async function retractKnowledge(app, target, reason = null) {
  const input = { target };
  if (reason !== null) input.reason = reason;
  const step = await app.controller.runAction('knowledge.retract', input, 'user', null);
  assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
  return step.result.data;
}

async function resolveKnowledge(app, { target, choose, reason = null }) {
  const input = { target, choose };
  if (reason !== null) input.reason = reason;
  const step = await app.controller.runAction('knowledge.resolve', input, 'user', null);
  assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
  return step.result.data;
}

// A real audit line, appended through the audit log's own write path.
async function audit(app, { id, requestedAt, finishedAt = requestedAt }) {
  await app.operations.append({
    schema: OPERATION_SCHEMA,
    id,
    capability: 'memory.add',
    origin: 'user',
    decision: 'answer',
    status: Outcome.SUCCESS_VERIFIED,
    requestedAt,
    finishedAt,
    output: 'recorded',
  });
  return id;
}

function readLines(dir, file) {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

function storeBytes(dir) {
  const out = {};
  for (const file of [MEMORY, KNOWLEDGE]) {
    try {
      out[file] = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      out[file] = null;
    }
  }
  return out;
}

// One fixture containing both stores' full lifecycle, with every later change dated after CUTOFF:
//
//   memory     a claim later corrected twice, a second claim corrected once, a private record, an
//              unrelated live record, and two records in a live heuristic conflict.
//   knowledge  two pre-cutoff conflict groups (one resolved later, one lost to a retraction), a
//              claim later superseded by a successor, free-text evidence naming another claim, and
//              a claim appended after the cutoff.
async function lifecycleFixture(dir) {
  const { app, setNow } = appOn(dir);

  setNow('2026-01-05T09:00:00.000Z');
  const mGate = await addMemory(app, 'The gate is open');
  setNow('2026-01-05T09:30:00.000Z');
  const mPrivate = await addMemory(app, 'The picnic blanket is in the attic', { sensitivity: 'private' });
  setNow('2026-01-05T10:00:00.000Z');
  const mLamp = await addMemory(app, 'The lamp is green');
  setNow('2026-01-06T09:00:00.000Z');
  const mNorthOpen = await addMemory(app, 'The north gate is open');
  setNow('2026-01-06T10:00:00.000Z');
  const mNorthClosed = await addMemory(app, 'The north gate is closed');

  setNow('2026-01-07T09:00:00.000Z');
  const kNorthClosed = await addKnowledge(app, {
    subject: 'the north gate', relationship: 'has_status', object: 'closed',
  });
  setNow('2026-01-07T10:00:00.000Z');
  const kNorthOpen = await addKnowledge(app, {
    subject: 'the north gate',
    relationship: 'has_status',
    object: 'open',
    evidence: `the guard report for ${kNorthClosed.id} was checked`,
  });
  setNow('2026-01-08T09:00:00.000Z');
  const kEastOpen = await addKnowledge(app, { subject: 'the east gate', relationship: 'has_status', object: 'open' });
  setNow('2026-01-08T10:00:00.000Z');
  const kEastClosed = await addKnowledge(app, { subject: 'the east gate', relationship: 'has_status', object: 'closed' });
  setNow('2026-01-09T09:00:00.000Z');
  const kSouthOpen = await addKnowledge(app, { subject: 'the south gate', relationship: 'has_status', object: 'open' });
  setNow('2026-01-09T10:00:00.000Z');
  const kEvidence = await addKnowledge(app, {
    subject: 'the west gate',
    relationship: 'was_reported_by',
    object: 'the guard',
    evidence: `claim ${kEastClosed.id}`,
  });

  // Everything below this line is recorded after the cutoff.
  setNow('2026-01-16T09:00:00.000Z');
  const mGateCorrected = await correctMemory(app, mGate.id, 'The gate is closed');
  setNow('2026-01-16T10:00:00.000Z');
  const mNorthCorrected = await correctMemory(app, mNorthOpen.id, 'The north gate is locked');
  setNow('2026-01-17T09:00:00.000Z');
  const kWestOpen = await addKnowledge(app, { subject: 'the west gate', relationship: 'has_status', object: 'open' });
  setNow('2026-01-18T09:00:00.000Z');
  const retraction = await retractKnowledge(app, kEastClosed.id, 'the east sensor was faulty');
  setNow('2026-01-19T09:00:00.000Z');
  const resolution = await resolveKnowledge(app, {
    target: kNorthOpen.id, choose: kNorthOpen.id, reason: 'the user chose the guard report',
  });
  setNow('2026-01-20T09:00:00.000Z');
  const kSouthClosed = await addKnowledge(app, {
    subject: 'the south gate',
    relationship: 'has_status',
    object: 'closed',
    evidence: 'the user inspected the south gate',
    supersedes: [kSouthOpen.id],
  });
  setNow('2026-01-21T09:00:00.000Z');
  const mGateCorrectedAgain = await correctMemory(app, mGateCorrected.id, 'The gate is locked');

  return {
    app, setNow,
    mGate, mPrivate, mLamp, mNorthOpen, mNorthClosed,
    mGateCorrected, mNorthCorrected, mGateCorrectedAgain,
    kNorthOpen, kNorthClosed, kEastOpen, kEastClosed, kSouthOpen, kEvidence,
    kWestOpen, retraction, resolution, kSouthClosed,
  };
}

describe('AP-18 memory and knowledge answer the unified cutoff', () => {
  test('both stores are cutoff-capable, and each record model states its own cutoff rule', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const view = await history(app, CUTOFF);

    // AP-18 closed the last disclosed boundary: no integrated source is unsupported now.
    assert.deepEqual(view.unsupported, []);
    const sources = Object.fromEntries(view.asOf.sources.map((entry) => [entry.name, entry]));
    assert.equal(sources.memory.supportsCutoff, true);
    assert.equal(sources.knowledge.supportsCutoff, true);
    assert.equal(sources.memory.status, 'read');
    assert.equal(sources.knowledge.status, 'read');
    assert.equal(view.memory.available, true);
    assert.equal(view.knowledge.available, true);
    assert.equal(view.asOf.state, 'consistent');
    assert.equal(view.asOf.complete, true);
    assert.equal(view.asOf.verifiable, true);

    assert.match(view.cutoffSemantics.memory, /only `createdAt`/);
    assert.match(view.cutoffSemantics.memory, /no event time, valid interval, or retraction event/);
    assert.match(view.cutoffSemantics.knowledge, /retraction and resolution events carry only `createdAt`/);
    assert.match(view.cutoffSemantics.knowledge, /cannot apply to an earlier view/);
    assert.match(view.rule, /recorded time is not event time/);
  });

  test('at the cutoff each store lists what it had recorded and counts everything later', async () => {
    const dir = tempDir();
    const fixture = await lifecycleFixture(dir);
    const { app } = fixture;
    const view = await history(app, CUTOFF);

    // Memory: four visible records at or before the cutoff, one private record excluded and counted,
    // no correction applied yet, and the north gate pair in one heuristic conflict group.
    assert.equal(view.memory.records, 4);
    assert.equal(view.memory.privateExcluded, 1);
    assert.equal(view.memory.excluded, 3);
    assert.equal(view.memory.counts.memories, 4);
    assert.equal(view.memory.counts.corrections, 0);
    assert.equal(view.memory.counts.superseded, 0);
    assert.equal(view.memory.counts.conflictGroups, 1);
    assert.equal(view.memory.counts.byStatus.user_confirmed, 2);
    assert.equal(view.memory.counts.byStatus.unresolved_conflict, 2);
    assert.equal(view.memory.problemCount, 0);
    for (const record of [fixture.mGateCorrected, fixture.mNorthCorrected, fixture.mGateCorrectedAgain]) {
      assert.equal(view.memory.rows.some((row) => row.id === record.id), false, 'a later correction is not in the past listing');
    }

    // Knowledge: six claims, no lifecycle event yet, and two live unresolved conflict groups.
    assert.equal(view.knowledge.records, 6);
    assert.equal(view.knowledge.excluded, 4);
    assert.equal(view.knowledge.counts.claims, 6);
    assert.equal(view.knowledge.counts.retractions, 0);
    assert.equal(view.knowledge.counts.resolutions, 0);
    assert.equal(view.knowledge.counts.active, 6);
    assert.deepEqual(view.knowledge.counts.conflicts, { total: 2, unresolved: 2, resolved: 0, claims: 4 });
    assert.equal(view.knowledge.problemCount, 0);
    assert.equal(view.knowledge.rows.some((row) => row.id === fixture.kWestOpen.id), false);
    assert.equal(view.knowledge.rows.some((row) => row.id === fixture.kSouthClosed.id), false);

    // The later totals are counted without being used to decide the past.
    assert.equal(view.later.memoryRecordsAdded, 3);
    assert.equal(view.later.memoryCorrectionsRecorded, 3);
    assert.equal(view.later.knowledgeClaimsRecorded, 2);
    assert.equal(view.later.knowledgeRetractionsRecorded, 1);
    assert.equal(view.later.knowledgeResolutionsRecorded, 1);
    assert.equal(view.later.knowledgeSupersessionsRecorded, 1);
  });

  test('a memory claim corrected after the cutoff remains the belief recorded at the cutoff', async () => {
    const dir = tempDir();
    const { app, mGate, mGateCorrected, mGateCorrectedAgain } = await lifecycleFixture(dir);
    const view = await history(app, CUTOFF);

    const row = view.memory.rows.find((entry) => entry.id === mGate.id);
    // The operation's persisted result minimises every `content` payload, so the verbatim record is
    // read from the store's own historical view while the operation row keeps identity and standing.
    assert.equal(row.content, '[omitted 16 chars]');
    assert.equal(row.createdAt, '2026-01-05T09:00:00.000Z');
    assert.equal(row.provenance.origin, 'user_request');
    assert.equal(row.status, 'user_confirmed');
    assert.deepEqual(row.replacedBy, []);
    assert.equal(row.later.replacedLater, true);
    assert.equal(row.later.standingChangedLater, true);
    assert.deepEqual(row.later.replacedByIds, [mGateCorrected.id]);
    assert.equal(row.now.status, 'superseded');
    assert.deepEqual(row.now.replacedBy, [mGateCorrected.id]);

    // A later cutoff applies the recorded corrections without rewriting the original content.
    const storedPast = await app.memory.historicalView(CUTOFF);
    assert.equal(storedPast.memories.find((entry) => entry.id === mGate.id).content, 'The gate is open');
    const after = await history(app, LATE);
    const past = after.memory.rows.find((entry) => entry.id === mGate.id);
    const storedAfter = await app.memory.historicalView(LATE);
    assert.equal(storedAfter.memories.find((entry) => entry.id === mGate.id).content, 'The gate is open',
      'the earlier claim is preserved verbatim');
    assert.equal(past.status, 'superseded');
    assert.deepEqual(past.replacedBy, [mGateCorrected.id]);
    assert.equal(past.later.replacedLater, false, 'inside this cutoff the correction is not later');
    const first = after.memory.rows.find((entry) => entry.id === mGateCorrected.id);
    assert.equal(first.status, 'superseded');
    assert.deepEqual(first.replacedBy, [mGateCorrectedAgain.id]);
    assert.equal(first.provenance.origin, 'user_memory_correction');
    assert.equal(first.provenance.updateMode, 'user_confirmed');
    assert.deepEqual(first.provenance.replaces, [mGate.id]);
    assert.equal(first.sensitivity, 'normal', 'a correction inherits the claim it replaces');
    const current = after.memory.rows.find((entry) => entry.id === mGateCorrectedAgain.id);
    assert.equal(current.status, 'user_confirmed');
    assert.deepEqual(current.replacedBy, []);
  });

  test('multiple corrections are resolved by the cutoff they fall in, not by the newest record', async () => {
    const dir = tempDir();
    const { app, mGate, mGateCorrected, mGateCorrectedAgain } = await lifecycleFixture(dir);

    const beforeFirst = await history(app, '2026-01-05T12:00:00.000Z');
    assert.equal(beforeFirst.memory.counts.corrections, 0);
    assert.equal(beforeFirst.memory.rows.find((row) => row.id === mGate.id).status, 'user_confirmed');
    assert.equal(beforeFirst.memory.excluded, 5, 'the five records appended after this cutoff, private excluded separately');

    const between = await history(app, '2026-01-17T00:00:00.000Z');
    assert.equal(between.memory.counts.corrections, 2, 'the first gate correction and the north gate correction are in');
    assert.equal(between.memory.rows.find((row) => row.id === mGate.id).status, 'superseded');
    assert.equal(between.memory.rows.find((row) => row.id === mGateCorrected.id).status, 'user_confirmed');
    assert.equal(between.memory.rows.some((row) => row.id === mGateCorrectedAgain.id), false);
    assert.equal(between.memory.excluded, 1, 'only the last correction is still later');

    const after = await history(app, LATE);
    assert.equal(after.memory.counts.corrections, 3);
    assert.equal(after.memory.rows.find((row) => row.id === mGateCorrected.id).status, 'superseded');
    assert.equal(after.memory.rows.find((row) => row.id === mGateCorrectedAgain.id).status, 'user_confirmed');
    assert.equal(after.memory.excluded, 0);
  });

  test('a memory conflict that existed at the cutoff is reconstructed, and a later correction changes it beside the past', async () => {
    const dir = tempDir();
    const { app, mNorthOpen, mNorthClosed, mNorthCorrected } = await lifecycleFixture(dir);
    const view = await history(app, CUTOFF);

    const open = view.memory.rows.find((row) => row.id === mNorthOpen.id);
    const closed = view.memory.rows.find((row) => row.id === mNorthClosed.id);
    assert.equal(open.status, 'unresolved_conflict');
    assert.equal(closed.status, 'unresolved_conflict');
    assert.deepEqual(open.conflict.recordIds, [mNorthClosed.id]);
    assert.deepEqual(closed.conflict.recordIds, [mNorthOpen.id]);
    assert.equal(open.conflict.subject, closed.conflict.subject);
    assert.equal(open.later.replacedLater, true);
    assert.equal(closed.later.replacedLater, false);
    assert.equal(closed.later.conflictChangedLater, true, 'the later correction replaces one side of the disagreement');
    assert.deepEqual(closed.now.conflictIds, [mNorthCorrected.id]);

    const after = await history(app, LATE);
    assert.equal(after.memory.counts.conflictGroups, 1);
    const replaced = after.memory.rows.find((row) => row.id === mNorthOpen.id);
    assert.equal(replaced.status, 'superseded');
    const stillClosed = after.memory.rows.find((row) => row.id === mNorthClosed.id);
    assert.equal(stillClosed.status, 'unresolved_conflict');
    assert.deepEqual(stillClosed.conflict.recordIds, [mNorthCorrected.id]);
    assert.equal(stillClosed.later.conflictChangedLater, false);
  });

  test('memory has no retraction event, and the reconstruction says so rather than inventing one', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const view = await history(app, CUTOFF);

    // There is no memory retraction action, and the answer's vocabulary says so: memory is retired
    // only by a later correction that names the claim it replaces.
    assert.equal(app.registry.get('memory.retract'), null);
    assert.match(view.memory.note, /no event time, valid interval, or retraction event/);
    assert.match(view.cutoffSemantics.memory, /no event time, valid interval, or retraction event/);
    assert.equal(view.limitations.some((line) => /memory has no event time, valid interval, or retraction event/.test(line)), true);
    for (const row of view.memory.rows) {
      assert.equal('retraction' in row, false);
      assert.equal('retractedBy' in row, false);
    }
    assert.equal('memoryRetractionsRecorded' in view.later, false);

    // The only retirement the model has is supersession, and it is never claimed at the cutoff when
    // the correcting record is later.
    const corrected = view.memory.rows.filter((row) => row.later.replacedLater);
    assert.equal(corrected.length, 2);
    assert.equal(corrected.every((row) => row.later.replacedByIds.length > 0), true);
  });
});

describe('AP-18 knowledge claims, retractions, conflicts, and resolutions', () => {
  test('a knowledge claim added after the cutoff is absent from the earlier view', async () => {
    const dir = tempDir();
    const { app, kWestOpen } = await lifecycleFixture(dir);
    const view = await history(app, CUTOFF);
    assert.equal(view.knowledge.rows.some((row) => row.id === kWestOpen.id), false);

    const after = await history(app, LATE);
    const row = after.knowledge.rows.find((entry) => entry.id === kWestOpen.id);
    assert.equal(row.createdAt, '2026-01-17T09:00:00.000Z');
    assert.equal(row.active, true);
    assert.equal(row.lifecycleState, 'supported');
  });

  test('a retraction recorded after the cutoff is disclosed, never applied backwards', async () => {
    const dir = tempDir();
    const { app, kEastOpen, kEastClosed, retraction } = await lifecycleFixture(dir);
    const view = await history(app, CUTOFF);

    const then = view.knowledge.rows.find((row) => row.id === kEastClosed.id);
    assert.equal(then.active, true);
    assert.equal(then.lifecycleState, 'conflicting');
    assert.equal(then.retraction, null);
    assert.equal(then.later.retractedLater, true);
    assert.deepEqual(then.later.retractedByIds, [retraction.retractionId]);
    assert.equal(then.later.standingChangedLater, true);

    const surviving = view.knowledge.rows.find((row) => row.id === kEastOpen.id);
    assert.equal(surviving.later.retractedLater, false);
    assert.equal(surviving.later.conflictChangedLater, true, 'the later retraction removes the other side of its disagreement');

    const after = await history(app, LATE);
    const now = after.knowledge.rows.find((row) => row.id === kEastClosed.id);
    assert.equal(now.active, false);
    assert.equal(now.lifecycleState, 'retracted');
    assert.equal(now.retraction.reason, 'the east sensor was faulty');
    assert.equal(now.retraction.origin, 'user_supplied');
    assert.equal(now.subject, kEastClosed.subject);
    assert.equal(now.object, kEastClosed.object);
    assert.equal(now.createdAt, '2026-01-08T10:00:00.000Z', 'the original claim was not rewritten');
    const alone = after.knowledge.rows.find((row) => row.id === kEastOpen.id);
    assert.deepEqual(alone.conflictsWith, []);
    assert.equal(alone.lifecycleState, 'supported');
  });

  test('a conflict that existed at the cutoff stays unresolved there after it is resolved later', async () => {
    const dir = tempDir();
    const { app, kNorthOpen, kNorthClosed } = await lifecycleFixture(dir);
    const view = await history(app, CUTOFF);

    const open = view.knowledge.rows.find((row) => row.id === kNorthOpen.id);
    assert.equal(open.conflictState, 'unresolved');
    assert.equal(open.resolution, null);
    assert.deepEqual(open.conflictsWith, [kNorthClosed.id]);
    assert.equal(open.later.resolutionRecordedLater, true);
    assert.equal(open.later.standingChangedLater, true);
    const closed = view.knowledge.rows.find((row) => row.id === kNorthClosed.id);
    assert.equal(closed.conflictState, 'unresolved');
    assert.equal(closed.later.resolutionRecordedLater, true, 'a resolution names every claim in the group');

    const after = await history(app, LATE);
    const resolved = after.knowledge.rows.find((row) => row.id === kNorthOpen.id);
    assert.equal(resolved.conflictState, 'resolved');
    assert.equal(resolved.resolution.chosenId, kNorthOpen.id);
    assert.equal(resolved.resolution.chosen, true);
    assert.equal(resolved.resolution.createdAt, '2026-01-19T09:00:00.000Z');
    // The decision is recorded; the disagreement and every alternative remain visible.
    assert.equal(after.knowledge.rows.find((row) => row.id === kNorthClosed.id).resolution.chosen, false);
    assert.deepEqual(resolved.conflictsWith, [kNorthClosed.id]);
    assert.equal(resolved.status, 'conflicting');
    assert.deepEqual(after.knowledge.counts.conflicts, { total: 1, unresolved: 0, resolved: 1, claims: 0 });
  });

  test('a recorded resolution is a user decision at that time, not proof the chosen claim is true', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const res = await historyResponse(app, LATE);
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);

    assert.match(res.display, /resolved by user decision \(not verified truth\)/);
    assert.equal(dataOf(res).view.limitations.some((line) => /never as proof the chosen claim is true/.test(line)), true);
    assert.match(dataOf(res).view.rule, /recorded time is not event time/);
  });

  test('a successor claim recorded after the cutoff does not retroactively supersede its predecessor', async () => {
    const dir = tempDir();
    const { app, kSouthOpen, kSouthClosed } = await lifecycleFixture(dir);
    const view = await history(app, CUTOFF);

    const then = view.knowledge.rows.find((row) => row.id === kSouthOpen.id);
    assert.equal(then.active, true);
    assert.equal(then.lifecycleState, 'supported');
    assert.deepEqual(then.replacedBy, []);
    assert.equal(then.later.supersededLater, true);
    assert.deepEqual(then.later.supersededByIds, [kSouthClosed.id]);

    const after = await history(app, LATE);
    const now = after.knowledge.rows.find((row) => row.id === kSouthOpen.id);
    assert.equal(now.active, false);
    assert.equal(now.lifecycleState, 'superseded');
    assert.deepEqual(now.replacedBy, [kSouthClosed.id]);
    const successor = after.knowledge.rows.find((row) => row.id === kSouthClosed.id);
    assert.deepEqual(successor.replaces, [kSouthOpen.id]);
    assert.equal(after.later.knowledgeSupersessionsRecorded, 0);
  });

  test('free-text evidence is never resolved into a record citation, before or after a retraction', async () => {
    const dir = tempDir();
    const { app, kNorthOpen, kNorthClosed, kEvidence, kEastClosed } = await lifecycleFixture(dir);
    const view = await history(app, CUTOFF);

    const row = view.knowledge.rows.find((entry) => entry.id === kNorthOpen.id);
    assert.equal(row.evidence, `the guard report for ${kNorthClosed.id} was checked`);
    assert.equal(view.citations.rows.some((entry) => entry.kind === 'knowledge'), false);
    assert.equal(view.operationCitations.total, 0, 'nothing structured was cited by the fixture rows');

    const evidenced = view.knowledge.rows.find((entry) => entry.id === kEvidence.id);
    assert.match(evidenced.evidence, new RegExp(kEastClosed.id));
    assert.equal(view.limitations.some((line) => /`evidence` is stored free text, not a record reference/.test(line)), true);

    // The retraction of the claim the text names changes that claim, not the text or its interpretation.
    const after = await history(app, LATE);
    const later = after.knowledge.rows.find((entry) => entry.id === kEvidence.id);
    assert.equal(later.evidence, evidenced.evidence);
    assert.equal(after.citations.rows.some((entry) => entry.kind === 'knowledge'), false);
    const rendered = String((await historyResponse(app, CUTOFF)).display);
    assert.match(rendered, /free-text evidence, not a record reference/);
  });
});

describe('AP-18 evidence lineage and audit citations', () => {
  test('a record whose operation id has no audit line is reported missing, never counted as precedent', async () => {
    const dir = tempDir();
    const { app } = appOn(dir);
    const record = await addMemory(app, 'The gate is open', { operationId: 'ap18-missing-op' });
    const view = await history(app, CUTOFF);

    const row = view.memory.rows.find((entry) => entry.id === record.id);
    assert.equal(row.provenance.operationId, 'ap18-missing-op');
    const citation = view.operationCitations.rows.find((entry) => entry.id === 'ap18-missing-op');
    assert.equal(citation.state, 'missing');
    assert.match(citation.reason, /no audit record/);
    assert.equal(view.asOf.complete, true, 'a missing audit line is a citation problem, not a failed read');
  });

  test('an unreadable audit line makes an unresolved citation unavailable rather than absent', async () => {
    const dir = tempDir();
    const { app } = appOn(dir);
    await addMemory(app, 'The gate is open', { operationId: 'ap18-unreadable-op' });
    fs.appendFileSync(path.join(dir, OPERATIONS), '{ this is not an audit record\n');

    const view = await history(app, CUTOFF);
    const citation = view.operationCitations.rows.find((entry) => entry.id === 'ap18-unreadable-op');
    assert.equal(citation.state, 'unavailable');
    assert.match(citation.reason, /unreadable line/);
    assert.equal(view.asOf.sources.find((entry) => entry.name === 'operations').status, 'damaged');
    assert.equal(view.asOf.complete, false);
  });

  test('a record stored by the cutoff that cites an operation finishing later is inconsistent, not past evidence', async () => {
    const dir = tempDir();
    const { app } = appOn(dir);
    await addMemory(app, 'The gate is open', { operationId: 'ap18-late-finish' });
    await audit(app, { id: 'ap18-late-finish', requestedAt: AFTER });

    const past = await history(app, CUTOFF);
    const citation = past.operationCitations.rows.find((entry) => entry.id === 'ap18-late-finish');
    assert.equal(citation.state, 'later');
    assert.equal(citation.inconsistent, true);
    assert.match(citation.reason, /after the cutoff/);
    assert.equal(past.operationCitations.inconsistent, 1);

    const later = await history(app, LATE);
    const settled = later.operationCitations.rows.find((entry) => entry.id === 'ap18-late-finish');
    assert.equal(settled.state, 'finished_by_cutoff');
    assert.equal(settled.inconsistent, false);
  });
});

describe('AP-18 source integrity and the certified window', () => {
  test('a corrupt memory store is named while knowledge still answers its cutoff', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    fs.appendFileSync(path.join(dir, MEMORY), '{ this is not a memory record\n');

    const res = await historyResponse(app, CUTOFF);
    // The verification confirms the read is reproducible, not that every source was intact: damage is
    // disclosed in the view and makes the combined answer incomplete and unverifiable.
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.match(res.operation.steps[0].verification.detail, /not complete/);
    const view = dataOf(res).view;
    assert.equal(view.memory.available, false);
    assert.equal(view.memory.status, 'damaged');
    assert.match(view.memory.reason, /corrupt line/);
    assert.equal(view.knowledge.available, true);
    assert.equal(view.knowledge.counts.claims, 6);
    assert.equal(view.asOf.sources.find((entry) => entry.name === 'memory').status, 'damaged');
    assert.equal(view.asOf.sources.find((entry) => entry.name === 'knowledge').status, 'read');
    assert.equal(view.asOf.complete, false);
    assert.equal(view.asOf.verifiable, false);
  });

  test('a corrupt knowledge store is named while memory still answers its cutoff', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    fs.appendFileSync(path.join(dir, KNOWLEDGE), 'not json\n');

    const res = await historyResponse(app, CUTOFF);
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.match(res.operation.steps[0].verification.detail, /not complete/);
    const view = dataOf(res).view;
    assert.equal(view.knowledge.available, false);
    assert.equal(view.knowledge.status, 'damaged');
    assert.match(view.knowledge.reason, /corrupt line/);
    assert.equal(view.memory.available, true);
    assert.equal(view.memory.counts.memories, 4);
    assert.equal(view.asOf.complete, false);
    assert.equal(view.asOf.verifiable, false);
  });

  test('both files contribute to one content-certified read window', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const stores = contributingStores({ memory: app.memory, knowledge: app.knowledge });
    assert.deepEqual(stores.map((entry) => entry.name), ['knowledge', 'memory']);
    assert.equal(stores.every((entry) => typeof entry.store.filePath === 'string'), true);

    const view = await history(app, CUTOFF);
    assert.equal(view.asOf.state, 'consistent');
    assert.equal(view.asOf.snapshot.state, 'consistent');
    assert.equal(view.asOf.snapshot.certification, 'content');
    assert.match(String(view.asOf.snapshot.digest), /^[0-9a-f]{64}$/);
    assert.equal(view.asOf.sources.find((entry) => entry.name === 'memory').inspectable, true);
    assert.equal(view.asOf.sources.find((entry) => entry.name === 'knowledge').inspectable, true);
  });

  test('a record appended by another store instance during the read is concurrent_modification', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const other = appOn(dir, AFTER);
    let writes = 0;
    const original = app.knowledge.historicalView.bind(app.knowledge);
    // A writer over the same file, driven by a second application instance with its own clock. The
    // append lands after the memory read of each attempt and before that attempt's certification.
    app.knowledge.historicalView = async (...args) => {
      const result = await original(...args);
      await other.app.memory.add({
        content: 'a concurrent record', kind: 'user_fact', source: 'user', provenance: { origin: 'user_request' },
      });
      writes += 1;
      return result;
    };

    const res = await historyResponse(app, CUTOFF);
    assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED);
    const view = dataOf(res).view;
    assert.equal(view.asOf.state, 'concurrent_modification');
    assert.equal(view.asOf.complete, false);
    assert.equal(view.asOf.attempts >= 2, true, 'the read retried before reporting the movement');
    assert.equal(view.asOf.attempts <= 3, true, 'the retry is bounded and disclosed');
    assert.equal(writes >= 2, true);
    assert.equal(view.memory.rows.length, 4, 'the answer is still assembled from the cutoff records');
    assert.equal(view.memory.rows.some((row) => row.content === 'a concurrent record'), false);
  });

  test('a store modified during the read aborts the complete claim even when the past listing still forms', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const other = appOn(dir, AFTER);
    const added = [];
    const original = app.memory.historicalView.bind(app.memory);
    app.memory.historicalView = async (...args) => {
      const result = await original(...args);
      const written = await other.app.knowledge.add({
        subject: 'the north gate', relationship: 'has_status', object: 'propped open', provenance: {}, origin: 'user',
      });
      added.push(written.record.id);
      return result;
    };

    const res = await historyResponse(app, CUTOFF);
    assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED);
    const view = dataOf(res).view;
    assert.equal(view.asOf.state, 'concurrent_modification');
    assert.equal(view.asOf.complete, false);
    assert.equal(view.asOf.attempts >= 2, true);
    assert.equal(view.asOf.attempts <= 3, true);
    assert.equal(view.knowledge.rows.length, 6);
    assert.equal(view.knowledge.rows.some((row) => added.includes(row.id)), false);
  });
});

describe('AP-18 cutoff semantics and normalization', () => {
  test('a missing, zone-less, or impossible cutoff is refused before either store is read', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const before = storeBytes(dir);
    for (const at of [undefined, null, '', '2026-01-15T12:00:00', '2026-02-30', 'yesterday']) {
      const res = await historyResponse(app, at);
      assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED, `"${at}" must be refused`);
      assert.match(String(res.display ?? res.output), /at (is required|must be an ISO)/);
    }
    assert.deepEqual(storeBytes(dir), before, 'a refused cutoff reads and writes nothing');
  });

  test('offsets and date-only cutoffs normalize to UTC, and the boundary instant is inclusive', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, '2026-01-31T23:30:00.000Z');
    await addMemory(app, 'The gate is open');
    await addKnowledge(app, { subject: 'the north gate', relationship: 'has_status', object: 'open' });

    const before = await history(app, '2026-02-01T01:00:00+02:00');
    assert.equal(before.cutoff, '2026-01-31T23:00:00.000Z');
    assert.equal(before.memory.counts.memories, 0);
    assert.equal(before.knowledge.counts.claims, 0);

    const exact = await history(app, '2026-01-31T23:30:00.000Z');
    assert.equal(exact.memory.counts.memories, 1);
    assert.equal(exact.knowledge.counts.claims, 1);

    const justBefore = await history(app, '2026-01-31T23:29:59.999Z');
    assert.equal(justBefore.memory.counts.memories, 0);
    assert.equal(justBefore.knowledge.counts.claims, 0);

    const after = await history(app, '2026-02-01T02:00:00+02:00');
    assert.equal(after.cutoff, '2026-02-01T00:00:00.000Z');
    assert.equal(after.memory.counts.memories, 1);
    assert.equal(after.knowledge.counts.claims, 1);

    const dateOnly = await history(app, '2026-02-01');
    assert.equal(dateOnly.cutoff, '2026-02-01T00:00:00.000Z');
    assert.equal(dateOnly.memory.counts.memories, 1);
    assert.equal(dateOnly.knowledge.counts.claims, 1);
  });

  test('recorded time is not event time: an earlier event described by a later record is absent at the cutoff', async () => {
    const dir = tempDir();
    const { app, setNow } = appOn(dir, AFTER);
    const memory = await addMemory(app, 'On 2026-01-01 the gate was open');
    const knowledge = await addKnowledge(app, {
      subject: 'the north gate', relationship: 'was_observed', object: 'open', evidence: 'observed on 2026-01-01',
    });

    const past = await history(app, CUTOFF);
    assert.equal(past.memory.rows.some((row) => row.id === memory.id), false);
    assert.equal(past.knowledge.rows.some((row) => row.id === knowledge.id), false);
    assert.match(past.cutoffSemantics.memory, /no event time, valid interval, or retraction event/);

    const later = await history(app, LATE);
    const memoryRow = later.memory.rows.find((row) => row.id === memory.id);
    const knowledgeRow = later.knowledge.rows.find((row) => row.id === knowledge.id);
    assert.equal(memoryRow.createdAt, AFTER, 'the cutoff compares the append time');
    const storedRow = (await app.memory.historicalView(LATE)).memories.find((row) => row.id === memory.id);
    assert.match(storedRow.content, /2026-01-01/, 'the described event time travels with the content, not the cutoff');
    assert.equal(knowledgeRow.createdAt, AFTER);
    assert.equal(knowledgeRow.evidence, 'observed on 2026-01-01');
    assert.equal('occurredAt' in memoryRow, false);
    assert.equal('validFrom' in knowledgeRow, false);
  });
});

describe('AP-18 determinism, bounds, and authority', () => {
  test('two reconstructions of one cutoff agree on every memory and knowledge field', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const first = await history(app, CUTOFF);
    const second = await history(app, CUTOFF);
    const cutoffOnly = (view) => JSON.stringify({
      cutoff: view.cutoff,
      memory: view.memory,
      knowledge: view.knowledge,
      cutoffSemantics: view.cutoffSemantics,
      limitations: view.limitations,
      later: {
        memoryRecordsAdded: view.later.memoryRecordsAdded,
        memoryCorrectionsRecorded: view.later.memoryCorrectionsRecorded,
        knowledgeClaimsRecorded: view.later.knowledgeClaimsRecorded,
        knowledgeRetractionsRecorded: view.later.knowledgeRetractionsRecorded,
        knowledgeResolutionsRecorded: view.later.knowledgeResolutionsRecorded,
        knowledgeSupersessionsRecorded: view.later.knowledgeSupersessionsRecorded,
      },
    });
    assert.equal(cutoffOnly(first), cutoffOnly(second));
    assert.equal(first.readAt, second.readAt);
  });

  test('rows are bounded, the bound is declared, and an out-of-range limit is refused', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const view = await history(app, CUTOFF, { limit: 2 });
    assert.equal(view.limits.rows, 2);
    assert.equal(view.memory.rows.length, 2);
    assert.equal(view.memory.total, 4);
    assert.equal(view.memory.truncated, true);
    assert.equal(view.knowledge.rows.length, 2);
    assert.equal(view.knowledge.total, 6);
    assert.equal(view.knowledge.truncated, true);

    const res = await historyResponse(app, CUTOFF, { limit: 2 });
    assert.match(res.display, /2 older record\(s\) not shown/);
    assert.match(res.display, /4 older claim\(s\) not shown/);

    for (const limit of [0, 51, 1.5]) {
      const refused = await historyResponse(app, CUTOFF, { limit });
      assert.notEqual(refused.status, Outcome.SUCCESS_VERIFIED, `limit ${limit} must be refused`);
      assert.match(String(refused.display ?? refused.output), /limit must be/);
    }
  });

  test('the reconstruction writes nothing, calls no model, and records itself in the audit log', async () => {
    const dir = tempDir();
    const { app } = await lifecycleFixture(dir);
    const before = storeBytes(dir);
    let gatewayCalls = 0;
    const original = app.gateway.complete.bind(app.gateway);
    app.gateway.complete = (...args) => { gatewayCalls += 1; return original(...args); };

    const res = await historyResponse(app, CUTOFF);
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    assert.equal(gatewayCalls, 0);
    assert.deepEqual(storeBytes(dir), before, 'no memory or knowledge line was added, rewritten, or retracted');
    assert.equal(readLines(dir, OPERATIONS).some((line) => JSON.parse(line).capability === 'history.reconstruct'), true);
  });

  test('a model-origin request can read history but cannot write memory or knowledge through it', async () => {
    const dir = tempDir();
    const fixture = await lifecycleFixture(dir);
    const { app } = fixture;

    assert.equal(app.registry.authorize('memory.add', 'model').decision, 'deny');
    assert.equal(app.registry.authorize('memory.correct', 'model').decision, 'deny');
    assert.equal(app.registry.authorize('knowledge.add', 'model').decision, 'deny');
    assert.equal(app.registry.authorize('knowledge.retract', 'model').decision, 'deny');
    assert.equal(app.registry.authorize('knowledge.resolve', 'model').decision, 'deny');

    const before = storeBytes(dir);
    const denied = await app.controller.runAction('memory.add', { content: 'the model wrote this' }, 'model', null);
    assert.equal(denied.outcome, Outcome.ACTION_DENIED);
    assert.equal(denied.execution.status, 'not_run');
    const deniedKnowledge = await app.controller.runAction(
      'knowledge.add', { subject: 'the north gate', relationship: 'has_status', object: 'propped open' }, 'model', null,
    );
    assert.equal(deniedKnowledge.outcome, Outcome.ACTION_DENIED);
    await assert.rejects(
      () => app.knowledge.add({
        subject: 'the north gate', relationship: 'has_status', object: 'propped open', provenance: {}, origin: 'model',
      }),
      (err) => err?.code === 'WRITE_REQUIRES_USER_ORIGIN',
    );
    assert.deepEqual(storeBytes(dir), before);

    const read = await app.controller.runAction('history.reconstruct', { at: CUTOFF }, 'model', 'ap18-model-read');
    assert.equal(read.outcome, Outcome.SUCCESS_VERIFIED, read.summary);
    const view = read.result.data.view;
    assert.equal(view.authorizes, false);
    assert.equal(view.memory.privateExcluded, 1);
    assert.equal(JSON.stringify(view.memory).includes('picnic blanket'), false, 'private memory never reaches a model-origin answer');
    assert.equal(view.knowledge.rows.every((row) => row.provenance.origin === 'user_supplied'), true);
  });

  test('adversarial input cannot manufacture provenance, evidence, or historical authority', async () => {
    const dir = tempDir();
    const { app, kNorthOpen } = await lifecycleFixture(dir);
    const before = storeBytes(dir);

    // The action accepts exactly `at` and `limit`. Anything that looks like a provenance, evidence,
    // or authority field is refused rather than carried into a record or a view.
    for (const extra of [
      { provenance: { origin: 'user' } },
      { evidence: ['the model decided this'] },
      { records: [kNorthOpen.id] },
      { authorizes: true },
    ]) {
      const step = await app.controller.runAction('history.reconstruct', { at: CUTOFF, ...extra }, 'user', null);
      assert.equal(step.outcome, Outcome.INPUT_REJECTED, JSON.stringify(extra));
      assert.match(step.summary, /unexpected input field/);
    }

    const injected = await app.controller.runAction('knowledge.add', {
      subject: 'the north gate', relationship: 'has_status', object: 'propped open', provenance: { origin: 'user' },
    }, 'user', null);
    assert.equal(injected.outcome, Outcome.INPUT_REJECTED);
    assert.match(injected.summary, /unexpected input field/);

    const unsourced = await app.controller.runAction('knowledge.add', {
      subject: 'the north gate', relationship: 'has_status', object: 'propped open', origin: 'user',
    }, 'user', null);
    assert.equal(unsourced.outcome, Outcome.INPUT_REJECTED);

    await assert.rejects(
      () => app.memory.add({
        content: 'The gate is now locked',
        provenance: { updateMode: 'user_confirmed', replaces: [kNorthOpen.id] },
      }),
      /correction provenance can only be created by an authorized correction operation/,
    );
    assert.deepEqual(storeBytes(dir), before, 'no refused request wrote a record');

    const view = await history(app, CUTOFF);
    assert.equal(view.authorizes, false);
    assert.equal(view.asOf.complete, true);
    assert.equal(view.memory.rows.every((row) => ['user_request', 'user_memory_correction'].includes(row.provenance.origin)), true);
    assert.equal(view.knowledge.rows.every((row) => row.provenance.updateMode === 'user_confirmed'), true);
  });

  test('a later cutoff reveals every subsequent lifecycle change without moving the past', async () => {
    const dir = tempDir();
    const fixture = await lifecycleFixture(dir);
    const { app } = fixture;
    const past = await history(app, CUTOFF);
    const after = await history(app, LATE);

    assert.equal(past.memory.counts.corrections, 0);
    assert.equal(after.memory.counts.corrections, 3);
    assert.equal(past.memory.counts.superseded, 0);
    assert.equal(after.memory.counts.superseded, 3);
    assert.equal(past.memory.excluded, 3);
    assert.equal(after.memory.excluded, 0);
    assert.equal(past.later.memoryRecordsAdded, 3);
    assert.equal(after.later.memoryRecordsAdded, 0);

    assert.equal(past.knowledge.counts.claims, 6);
    assert.equal(after.knowledge.counts.claims, 8);
    assert.equal(past.knowledge.counts.retractions, 0);
    assert.equal(after.knowledge.counts.retractions, 1);
    assert.equal(past.knowledge.counts.resolutions, 0);
    assert.equal(after.knowledge.counts.resolutions, 1);
    assert.equal(past.knowledge.excluded, 4);
    assert.equal(after.knowledge.excluded, 0);
    assert.equal(after.later.knowledgeClaimsRecorded, 0);
    assert.equal(after.later.knowledgeRetractionsRecorded, 0);
    assert.equal(after.later.knowledgeResolutionsRecorded, 0);
    assert.equal(after.later.knowledgeSupersessionsRecorded, 0);
    assert.equal(after.knowledge.rows.find((row) => row.id === fixture.kEastClosed.id).lifecycleState, 'retracted');
    assert.equal(after.knowledge.rows.find((row) => row.id === fixture.kSouthOpen.id).lifecycleState, 'superseded');
    assert.equal(after.knowledge.rows.find((row) => row.id === fixture.kNorthOpen.id).conflictState, 'resolved');

    // The earlier answer is unchanged by having asked the later question.
    assert.equal(past.knowledge.rows.find((row) => row.id === fixture.kNorthOpen.id).conflictState, 'unresolved');
    assert.equal(past.knowledge.rows.find((row) => row.id === fixture.kEastClosed.id).lifecycleState, 'conflicting');
  });
});

describe('AP-18 the CLI history command includes both stores', () => {
  test('history --at renders and returns the memory and knowledge cutoff listings', async () => {
    const dir = tempDir();
    await lifecycleFixture(dir);
    const env = cleanEnv({ APEX_DATA_DIR: dir });

    const res = await runCli(['history', '--at', CUTOFF, '--json'], env);
    assert.equal(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.split('\nAudit: recorded in operations.jsonl')[0]);
    assert.equal(parsed.view.memory.counts.memories, 4);
    assert.equal(parsed.view.memory.privateExcluded, 1);
    assert.equal(parsed.view.knowledge.counts.claims, 6);
    assert.deepEqual(parsed.view.knowledge.counts.conflicts, { total: 2, unresolved: 2, resolved: 0, claims: 4 });
    assert.equal(parsed.view.asOf.complete, true);

    const display = await runCli(['history', '--at', CUTOFF], env);
    assert.equal(display.code, 0, display.stderr);
    assert.match(display.stdout, /memory: 4 record\(s\) recorded by then, 0 correction\(s\), 1 conflict group/);
    assert.match(display.stdout, /1 private record\(s\) excluded/);
    assert.match(display.stdout, /knowledge: 6 claim\(s\) recorded by then, 0 retraction\(s\), 0 resolution\(s\), 6 active/);
    assert.match(display.stdout, /free-text evidence, not a record reference/);
    assert.match(display.stdout, /unsupported: none - every integrated store answers a cutoff listing/);
  });

  test('the CLI refuses a zone-less cutoff for the combined history too', async () => {
    const dir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dir });
    const res = await runCli(['history', '--at', '2026-01-15T12:00:00'], env);
    assert.equal(res.code, 1);
    assert.match(`${res.stdout}${res.stderr}`, /time zone/);
  });
});
