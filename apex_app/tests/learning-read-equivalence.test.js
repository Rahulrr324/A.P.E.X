// Batch AM, work package A: the shared window read must answer exactly what a record-by-record scan
// answers, and it must not lose the fail-closed behaviour that made the scan trustworthy.
//
// The engine used to rebuild the whole experience log's per-record structures inside every window
// query, so one query cost time proportional to the size of the store even when it returned nothing,
// and the prediction ledger ran one query per recorded prediction. This batch prepares those structures
// once per read of the log and turns a window into a bounded range read over the records that answer
// it. These tests are the equivalence half of that change: for every window and capability they compare
// the range read against a reference computed record by record in the test, with no shared structure.
//
// Synthetic records only. No model, no backend, no network, no inference. Store fixtures are written
// through the real experience store, the real prediction ledger and the real audit log, and every
// record cited here is one an application call actually produced.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { analyzeTemporal, isCorrectiveAssessment, parseInstant, resolveWindow } from '../src/experience/temporal.js';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const NOW = () => new Date('2026-11-01T00:00:00.000Z');
const DAY = 86_400_000;
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function app(dir) {
  return createApp({
    dataDir: dir,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    experienceCapture: CAPTURE_OFF,
    now: NOW,
  });
}

let seq = 0;
function exp({
  at = null,
  outcome = Outcome.SUCCESS_VERIFIED,
  capability = 'calc.evaluate',
  finishedAt,
  requestedAt,
  createdAt,
  ...rest
} = {}) {
  seq += 1;
  return {
    id: rest.id ?? `exp-${String(seq).padStart(4, '0')}`,
    operationId: rest.operationId ?? `op-${String(seq).padStart(4, '0')}`,
    capability,
    outcome,
    capture: rest.capture ?? 'explicit',
    active: rest.active ?? true,
    superseded: rest.superseded ?? false,
    requestedAt: requestedAt === undefined ? at : requestedAt,
    finishedAt: finishedAt === undefined ? null : finishedAt,
    createdAt: createdAt === undefined ? at : createdAt,
    replaces: rest.replaces ?? [],
    replacedBy: rest.replacedBy ?? [],
  };
}

const windowFor = (since, until) => resolveWindow({ since, until, now: NOW() });

// The authoritative derivation: one record at a time, in file order, with the timestamp rule the engine
// documents (finishedAt, then requestedAt, then createdAt), the window compared inclusively, and the
// order inside a window taken from the time and then the position in the log. Nothing here is shared
// between queries, which is precisely the cost the batch removed and precisely the answer it must match.
function reference(records, feedback, retiredFeedback, { window, capability }) {
  const corrective = (assessment) => assessment !== 'correct' && assessment !== 'unclear';
  const retired = retiredFeedback instanceof Set ? retiredFeedback : new Set(retiredFeedback ?? []);
  const rows = records.map((record, position) => {
    const entries = (feedback ?? []).filter((entry) => entry.experienceId === record.id);
    const current = entries.filter((entry) => !retired.has(entry.id));
    const ms = parseInstant(record.finishedAt) ?? parseInstant(record.requestedAt) ?? parseInstant(record.createdAt);
    return {
      id: record.id,
      capability: record.capability ?? null,
      ms,
      position,
      undated: ms === null,
      corrective: current.filter((entry) => corrective(entry.assessment)).length,
      feedbackCurrent: current.length,
      feedbackTotal: entries.length,
      superseded: record.superseded === true,
      active: record.active === true,
      outcome: record.outcome ?? null,
    };
  });
  const scoped = capability ? rows.filter((row) => row.capability === capability) : rows;
  const dated = scoped.filter((row) => !row.undated && row.ms >= window.sinceMs && row.ms <= window.untilMs);
  const undated = scoped.filter((row) => row.undated);
  const outside = scoped.filter((row) => !row.undated && (row.ms < window.sinceMs || row.ms > window.untilMs));
  const order = (a, b) => {
    if (a.ms !== b.ms) return a.ms - b.ms;
    return a.position - b.position;
  };
  return {
    capability: capability ?? null,
    stored: records.length,
    dated: [...dated].sort(order).map((row) => row.id),
    undatedCount: undated.length,
    outsideCount: outside.length,
    total: dated.length,
    corrective: dated.reduce((sum, row) => sum + row.corrective, 0),
    feedback: dated.reduce((sum, row) => sum + row.feedbackCurrent, 0),
    superseded: dated.filter((row) => row.superseded).length,
    live: dated.filter((row) => row.active).length,
  };
}

function view(actual) {
  return actual.view.counts;
}

function eventIds(actual) {
  // The view shows the most recent `limit` events; the reference lists them oldest first.
  return actual.view.events.map((event) => event.id);
}

describe('AM-A1: a shared window read equals the record-by-record derivation', () => {
  const records = [
    exp({ id: 'a1', at: '2026-10-01T00:00:00.000Z' }),
    exp({ id: 'a2', at: '2026-10-02T00:00:00.000Z', outcome: Outcome.EXECUTION_FAILED }),
    exp({ id: 'a3', at: '2026-10-03T00:00:00.000Z' }),
    // Two records at one instant: their order comes from the log, not from an id.
    exp({ id: 'b1', at: '2026-10-04T00:00:00.000Z', capability: 'memory.list' }),
    exp({ id: 'b2', at: '2026-10-04T00:00:00.000Z', capability: 'memory.list' }),
    exp({ id: 'c1', at: null, createdAt: null, requestedAt: null, finishedAt: null }),
    exp({ id: 'c2', finishedAt: '2026-10-05T12:00:00.000Z', requestedAt: '2026-10-01T00:00:00.000Z' }),
    exp({ id: 'd1', at: '2026-10-06T00:00:00.000Z', superseded: true, active: false }),
    exp({ id: 'd2', at: '2026-10-07T00:00:00.000Z', replaces: ['d1'] }),
    exp({ id: 'e1', at: '2026-10-08T00:00:00.000Z', capability: 'memory.search' }),
    exp({ id: 'e2', at: '2026-10-09T00:00:00.000Z', capability: null }),
  ];
  const feedback = [
    { id: 'f1', experienceId: 'a1', assessment: 'incorrect', guidance: 'put the date first', createdAt: '2026-10-01T06:00:00.000Z' },
    { id: 'f2', experienceId: 'a1', assessment: 'misleading', createdAt: '2026-10-02T06:00:00.000Z' },
    { id: 'f3', experienceId: 'b1', assessment: 'correct', createdAt: '2026-10-04T09:00:00.000Z' },
    { id: 'f4', experienceId: 'd1', assessment: 'incorrect', createdAt: '2026-10-06T09:00:00.000Z' },
  ];

  const WINDOWS = [
    ['2026-09-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'],
    ['2026-10-01T00:00:00.000Z', '2026-10-04T00:00:00.000Z'],
    ['2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z'],
    ['2026-10-04T00:00:00.001Z', '2026-10-04T23:59:59.999Z'],
    ['2026-10-05T12:00:00.000Z', '2026-10-05T12:00:00.000Z'],
    ['2026-10-06T00:00:00.000Z', '2026-10-08T00:00:00.000Z'],
    ['2026-11-01T00:00:00.000Z', '2026-11-11T00:00:00.000Z'],
    ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'],
  ];
  const CAPS = [null, 'calc.evaluate', 'memory.list', 'memory.search', 'nonexistent.action'];

  for (const [since, until] of WINDOWS) {
    for (const capability of CAPS) {
      test(`window ${since.slice(0, 10)}..${until.slice(0, 10)} capability ${capability ?? '(all)'}`, () => {
        const window = windowFor(since, until);
        const actual = analyzeTemporal({ experiences: records, feedback, retiredFeedback: new Set(), window, capability, limit: 50 });
        const expected = reference(records, feedback, new Set(), { window, capability });
        assert.equal(view(actual).storedExperiences, expected.stored);
        assert.equal(view(actual).inWindow, expected.total, 'the window selected a different set of records than a scan does');
        assert.equal(view(actual).outsideWindow, expected.outsideCount);
        assert.equal(view(actual).undated, expected.undatedCount);
        assert.equal(view(actual).superseded, expected.superseded);
        assert.equal(view(actual).live, expected.live);
        assert.deepEqual(eventIds(actual), expected.dated.slice(-50), 'the range read orders records differently than the log does');
      });
    }
  }

  test('retired feedback is excluded from the counts the same way a scan excludes it', () => {
    const window = windowFor('2026-09-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    const retired = new Set(['f2']);
    const actual = analyzeTemporal({ experiences: records, feedback, retiredFeedback: retired, window, capability: null, limit: 50 });
    const expected = reference(records, feedback, retired, { window, capability: null });
    assert.equal(view(actual).inWindow, expected.total);
    assert.deepEqual(eventIds(actual), expected.dated);
    const corrective = actual.slice.dated
      .reduce((sum, event) => sum + event.feedback.corrective, 0);
    assert.equal(corrective, expected.corrective);
  });

  test('the two windows of one comparison agree with two separate scans of the same records', () => {
    const a = windowFor('2026-10-01T00:00:00.000Z', '2026-10-04T00:00:00.000Z');
    const b = windowFor('2026-10-05T00:00:00.000Z', '2026-10-09T00:00:00.000Z');
    const one = analyzeTemporal({ experiences: records, feedback, window: a, capability: null, limit: 50 });
    const two = analyzeTemporal({ experiences: records, feedback, window: b, capability: null, limit: 50 });
    assert.deepEqual(eventIds(one), reference(records, feedback, new Set(), { window: a, capability: null }).dated);
    assert.deepEqual(eventIds(two), reference(records, feedback, new Set(), { window: b, capability: null }).dated);
    // The same records prepared once and asked twice: reusing the preparation must not leak a window
    // into the next answer.
    const again = analyzeTemporal({ experiences: records, feedback, window: a, capability: null, limit: 50 });
    assert.deepEqual(eventIds(again), eventIds(one));
    assert.equal(view(again).inWindow, view(one).inWindow);
  });
});

describe('AM-A2: the range read is exact at the boundaries', () => {
  const at = [1, 2, 3, 4, 5].map((i) => exp({ id: `x${i}`, at: new Date(Date.UTC(2026, 9, i)).toISOString() }));
  at.push(exp({ id: 'x2b', at: new Date(Date.UTC(2026, 9, 2)).toISOString() }));

  test('a record exactly on a bound is inside it', () => {
    for (const record of at) {
      const ms = parseInstant(record.createdAt ?? record.finishedAt);
      const window = windowFor(new Date(ms).toISOString(), new Date(ms).toISOString());
      const actual = analyzeTemporal({ experiences: at, feedback: [], window, capability: null, limit: 50 });
      assert.ok(eventIds(actual).includes(record.id), `${record.id} was dropped by its own instant`);
    }
  });

  test('adjacent windows neither drop nor repeat a record', () => {
    const first = Date.UTC(2026, 9, 1);
    const last = Date.UTC(2026, 9, 5);
    const endOfDay = last + DAY - 1;
    const whole = analyzeTemporal({
      experiences: at,
      feedback: [],
      window: windowFor(new Date(first).toISOString(), new Date(endOfDay).toISOString()),
      capability: null,
      limit: 50,
    });
    const pieces = [];
    for (let day = first; day <= endOfDay; day += DAY) {
      pieces.push(analyzeTemporal({
        experiences: at,
        feedback: [],
        window: windowFor(new Date(day).toISOString(), new Date(Math.min(day + DAY - 1, endOfDay)).toISOString()),
        capability: null,
        limit: 50,
      }));
    }
    const sum = pieces.reduce((total, piece) => total + view(piece).inWindow, 0);
    assert.equal(sum, view(whole).inWindow, 'splitting a window changed how many records answer it');
    const ids = pieces.flatMap(eventIds);
    assert.equal(new Set(ids).size, ids.length, 'a record appeared in two adjacent windows');
    assert.deepEqual([...ids].sort(), [...eventIds(whole)].sort());
  });

  test('a capability filter selects exactly the records that name it', () => {
    const records = [
      exp({ id: 'k1', at: '2026-10-01T00:00:00.000Z', capability: 'memory.list' }),
      exp({ id: 'k2', at: '2026-10-02T00:00:00.000Z', capability: 'memory.add' }),
      exp({ id: 'k3', at: '2026-10-03T00:00:00.000Z', capability: 'memory.list' }),
      exp({ id: 'k4', at: '2026-10-04T00:00:00.000Z', capability: null }),
    ];
    const window = windowFor('2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z');
    const scoped = analyzeTemporal({ experiences: records, feedback: [], window, capability: 'memory.list', limit: 50 });
    assert.deepEqual(eventIds(scoped), ['k1', 'k3']);
    const everything = analyzeTemporal({ experiences: records, feedback: [], window, capability: null, limit: 50 });
    assert.equal(view(everything).inWindow, 4, 'an unscoped read lost a record with no capability');
    const absent = analyzeTemporal({ experiences: records, feedback: [], window, capability: 'never.done', limit: 50 });
    assert.deepEqual(eventIds(absent), []);
    assert.equal(view(absent).storedExperiences, 4, 'a read that answers nothing must still report the log it read');
  });
});

describe('AM-A3: the store answers the same with a shared snapshot and without one', () => {
  async function seeded(dir) {
    const application = app(dir);
    const ops = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await application.controller.handle(`remember that the equivalence fact ${i} holds`, { origin: 'user' });
      ops.push(res.operation.id);
    }
    for (const operationId of ops) {
      await application.experience.recordExperience({ operationId, subject: `equivalence experience for ${operationId}`, origin: 'user' });
    }
    return application;
  }

  test('every window and capability agrees between the two routes, named citations included', async () => {
    const application = await seeded(tempDir());
    const snapshot = await application.experience.evidenceSnapshot();
    const since = new Date(Date.UTC(2026, 9, 25)).toISOString();
    const cases = [
      [since, new Date(Date.UTC(2026, 10, 2)).toISOString(), 'memory.add'],
      [since, new Date(Date.UTC(2026, 10, 2)).toISOString(), 'calc.evaluate'],
      [since, new Date(Date.UTC(2026, 10, 2)).toISOString(), null],
      [since, since, null],
      [new Date(Date.UTC(2026, 10, 1)).toISOString(), new Date(Date.UTC(2026, 10, 1, 12)).toISOString(), 'memory.add'],
      ['2027-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z', 'memory.add'],
    ];
    const listed = await application.experience.list({ limit: 20 });
    const records = listed.experiences ?? listed;
    const cited = records.slice(0, 3).map((record) => record.id);
    for (const [since, until, capability] of cases) {
      const bounds = { since, until };
      const shared = await application.experience.evidenceIndex({
        experienceIds: cited, feedbackIds: [], ...bounds, capability, limit: 50, snapshot,
      });
      const alone = await application.experience.evidenceIndex({
        experienceIds: cited, feedbackIds: [], ...bounds, capability, limit: 50,
      });
      assert.deepEqual(shared, alone, `the shared snapshot disagrees with a fresh read for ${capability} ${bounds.since}..${bounds.until}`);
    }
  });

  test('a preparation cannot outlive the read it was built from', async () => {
    const application = await seeded(tempDir());
    const before = await application.experience.evidenceSnapshot();
    const window = { since: new Date(Date.UTC(2026, 9, 25)).toISOString(), until: new Date(Date.UTC(2026, 11, 1)).toISOString() };
    const initialCount = before.experiences.length;
    const extraOp = await application.controller.handle('remember that the equivalence later fact holds', { origin: 'user' });
    await application.experience.recordExperience({ operationId: extraOp.operation.id, subject: 'the later experience', origin: 'user' });

    const after = await application.experience.evidenceSnapshot();
    assert.equal(after.experiences.length, initialCount + 1, 'a fresh read did not see the record that was appended');
    const readAfter = await application.experience.evidenceIndex({ experienceIds: [], feedbackIds: [], ...window, capability: 'memory.add', limit: 50, snapshot: after });
    assert.equal(readAfter.counts.storedExperiences, initialCount + 1);
    // The older snapshot still describes the instant it was taken at: it neither gains the new record
    // nor borrows the newer snapshot's preparation.
    const readBefore = await application.experience.evidenceIndex({ experienceIds: [], feedbackIds: [], ...window, capability: 'memory.add', limit: 50, snapshot: before });
    assert.equal(readBefore.counts.storedExperiences, initialCount, 'a snapshot answered for records appended after it was taken');
    assert.notEqual(readAfter.window.since, undefined);
  });

  test('a damaged experience log fails closed on both routes, with the same refusal', async () => {
    const dir = tempDir();
    const application = await seeded(dir);
    fs.appendFileSync(path.join(dir, 'experiences.jsonl'), 'not a record\n');
    const rebuilt = app(dir);
    const codes = [];
    for (const useSnapshot of [false, true]) {
      const snapshot = useSnapshot ? await rebuilt.experience.evidenceSnapshot().catch((error) => ({ error })) : null;
      const result = snapshot?.error
        ? { code: snapshot.error.code }
        : await rebuilt.experience.evidenceIndex({
          experienceIds: [], feedbackIds: [], since: new Date(Date.UTC(2026, 9, 25)).toISOString(),
          until: new Date(Date.UTC(2026, 11, 1)).toISOString(), capability: 'memory.add', limit: 50, snapshot,
        }).then((r) => ({ ok: r.counts })).catch((error) => ({ code: error.code }));
      codes.push(result);
    }
    assert.deepEqual(codes[0], codes[1], 'the shared route and the fresh route report damage differently');
    const health = await rebuilt.experience.health();
    assert.ok(health.corrupt > 0 || health.attention, 'a damaged log was reported as clean');
  });
});

describe('AM-A4: the ledger agrees with itself at every size', () => {
  async function ledger(dir, count) {
    const application = app(dir);
    const ops = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await application.controller.handle(`remember that the calibration fact ${i} holds`, { origin: 'user' });
      ops.push(res.operation.id);
    }
    const experienceIds = [];
    for (const operationId of ops) {
      const recorded = await application.experience.recordExperience({
        operationId, subject: `calibration experience for ${operationId}`, origin: 'user',
      });
      if (recorded.record) experienceIds.push(recorded.record.id);
    }
    for (let i = 0; i < count; i += 1) {
      await application.predictions.recordPrediction({
        capability: 'memory.add',
        expectation: 'success',
        subject: `calibration expectation ${i}`,
        expiresAt: new Date(Date.parse('2026-11-01T00:00:00.000Z') + (i + 2) * DAY).toISOString(),
        evidence: { supportingExperienceIds: experienceIds.slice(0, 2) },
        origin: 'user',
      });
    }
    return application;
  }

  test('calibration reports what the per-record route reports for the same expectations', async () => {
    const application = await ledger(tempDir(), 8);
    const { calibration, ledger: book } = await application.predictions.calibration({});
    assert.equal(book.projections.length, 8, 'the aggregate route projected a different number of expectations');
    assert.equal(calibration.totals.stored, 8);
    for (const projection of book.projections) {
      const detail = await application.predictions.detail(projection.id);
      assert.ok(detail, `${projection.id} is listed but cannot be read on its own`);
      assert.equal(detail.status, projection.status, `${projection.id} has two statuses`);
      assert.equal(detail.capability, projection.capability);
      assert.equal(detail.expiresAt, projection.expiresAt);
      assert.equal(detail.evaluation?.verdict ?? null, projection.evaluation?.verdict ?? null);
    }
    const scoped = await application.predictions.calibration({ capability: 'memory.add' });
    assert.equal(scoped.ledger.projections.length, book.projections.length);
    assert.equal(scoped.calibration.totals.stored, scoped.ledger.projections.length,
      'a scoped summary counted records it did not list');
    const absent = await application.predictions.calibration({ capability: 'never.done' });
    assert.equal(absent.ledger.projections.length, 0);
    assert.equal(absent.calibration.totals.stored, 0,
      'a scope that matches nothing must report nothing, not fall back to the whole store');
    // Every one of those reads walked the same log. None of them may have changed what it says.
    const after = await application.predictions.calibration({});
    assert.equal(after.calibration.totals.stored, calibration.totals.stored);
    assert.equal(after.ledger.projections.length, book.projections.length);
  });

  test('the aggregate read no longer costs the log times the expectations', () => {
    // A shape guard, not a benchmark: 160 window reads over one 400-record log used to cost about
    // 4 ms each (roughly 640 ms here) because every read rebuilt the whole log's per-record
    // structures. They now cost a range read over the records that answer, the structures having been
    // prepared once for the log.
    //
    // The bound is a ratio measured inside this run, not a millisecond figure. An absolute bound here
    // was satisfied in 27 ms on an idle machine and failed at 353 ms in a full parallel `npm test`
    // run, which tells one nothing about the derivation and the other everything about the load. The
    // second battery passes a fresh copy of the same array to every read, which is the condition that
    // forces the preparation to be built again: if the shared read ever pays that cost, the ratio
    // falls towards 1 and this fails, however busy the machine is.
    const records = [];
    for (let i = 0; i < 400; i += 1) {
      records.push(exp({
        id: `s${i}`,
        at: new Date(Date.UTC(2026, 9, 1) + i * 3_600_000).toISOString(),
        capability: i % 3 === 0 ? 'memory.list' : 'memory.add',
      }));
    }
    const battery = (rebuildEveryRead) => {
      const start = performance.now();
      let selected = 0;
      for (let i = 0; i < 160; i += 1) {
        const since = new Date(Date.UTC(2026, 9, 1) + i * 2 * 3_600_000).toISOString();
        const until = new Date(Date.UTC(2026, 9, 1) + (i * 2 + 2) * 3_600_000).toISOString();
        const actual = analyzeTemporal({
          experiences: rebuildEveryRead ? records.slice() : records,
          feedback: [], window: windowFor(since, until), capability: 'memory.list', limit: 50,
        });
        selected += view(actual).inWindow;
      }
      return { ms: performance.now() - start, selected };
    };
    const shared = battery(false);
    const rebuilt = battery(true);
    assert.equal(rebuilt.selected, shared.selected, 'both batteries must answer the same question');
    assert.ok(shared.selected > 0, 'the battery selected nothing, so it proved nothing');
    assert.ok(shared.ms * 4 < rebuilt.ms,
      `160 window reads over one prepared log took ${Math.round(shared.ms)} ms against ${Math.round(rebuilt.ms)} ms for the same 160 reads with the log's structures built for each one; the per-query rebuild may be back`);
  });
});
