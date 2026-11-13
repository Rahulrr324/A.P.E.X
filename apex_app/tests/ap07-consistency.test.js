// Batch AP-07: evidence snapshot integrity, consumer-wide consistency, and read reliability.
//
// The claim this suite defends is narrow: a consumer that combines several stores either reads them
// through a window that was certified, or it says which read it could not certify. A snapshot is not
// a lock and proves nothing about the truth of a record; a bounded read is evidence of what was read,
// never of what was not. The numbered cases below are the adversarial ones: a same-size rewrite, a
// deletion, a creation, a truncation, a moved window, an uninspectable path, an unnamed truncation,
// and the consumers that must disclose each. The end-to-end block runs the real stores, the real
// action registry, and the real controller with NoBackend and a fixed clock. No model is contacted,
// no inference runs, and nothing is repaired.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import {
  SNAPSHOT_SCHEMA,
  MAX_SNAPSHOT_STORES,
  storeIdentity,
  openEvidenceSnapshot,
  runConsistentEvidenceRead,
  contributingStores,
} from '../src/evidence/snapshot.js';
import {
  INTEGRITY_STATES,
  integrityFinding,
  integrityReport,
  evidenceIntegrityReport,
} from '../src/evidence/integrity.js';
import {
  READ_STATES,
  sourceRead,
  readReport,
  absenceProven,
  readFindings,
} from '../src/evidence/read-contract.js';
import {
  WORLD_RECORD_LIMIT,
  buildWorldState,
  renderWorldState,
  certifyWorldRead,
} from '../src/world/world-state.js';
import { analyzeLongitudinal, renderLongitudinal } from '../src/prediction/longitudinal.js';
import { retrieveEvidence, sourceUncertainty } from '../src/cognition/evidence.js';
import { understandRequest } from '../src/cognition/request.js';
import { extractClaims } from '../src/cognition/claims.js';
import { deliberate } from '../src/cognition/deliberation.js';
import { Disclosure, Uncertainty } from '../src/cognition/vocabulary.js';
import { analyzeRequest } from '../src/cognition/engine.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
const dir = () => { const d = makeTempDataDir(); dirs.push(d); return d; };

function clock(start = '2026-11-13T09:00:00.000Z') {
  let ms = Date.parse(start);
  const now = () => new Date(ms);
  now.advance = (minutes) => { ms += minutes * 60_000; };
  return now;
}

const appIn = (dataDir, now = clock()) => createApp({
  dataDir,
  now,
  gateway: new ModelGateway({ backend: new NoBackend() }),
  experienceCapture: CAPTURE_OFF,
});

const data = (res) => res?.operation?.steps?.[0]?.result?.data ?? res?.result?.data ?? {};
const display = (res) => String(res?.display ?? res?.result?.display ?? res?.output ?? '');

function fixture(name = 'store.jsonl', text = '') {
  const d = dir();
  const filePath = path.join(d, name);
  fs.writeFileSync(filePath, text);
  return { dir: d, filePath };
}

// =================================================================================================
// §3/§10: what a content-certified window can and cannot see
// =================================================================================================
describe('AP-07 §3 adversarial: the window names the change it saw', () => {
  test('01 a same-size rewrite with the original mtime restored is content_changed', async () => {
    const a = fixture('a.jsonl', 'aaaa\n');
    const before = await storeIdentity(a.filePath);
    const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'a', filePath: a.filePath }] });
    fs.writeFileSync(a.filePath, 'bbbb\n');
    fs.utimesSync(a.filePath, new Date(before.mtimeMs), new Date(before.mtimeMs));
    const verdict = await snapshot.verify();
    assert.equal(verdict.state, 'concurrent_modification');
    assert.equal(verdict.changed.length, 1);
    assert.equal(verdict.changed[0].kind, 'content_changed');
    assert.match(verdict.note, /byte for byte/);
  });

  test('02 a deletion inside the window is reported as deleted, not as an empty store', async () => {
    const a = fixture('a.jsonl', '{"n":1}\n');
    const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'a', filePath: a.filePath }] });
    fs.rmSync(a.filePath);
    const verdict = await snapshot.verify();
    assert.equal(verdict.changed[0].kind, 'deleted');
    assert.equal(verdict.state, 'concurrent_modification');
  });

  test('03 a file created inside the window is reported as created', async () => {
    const d = dir();
    const filePath = path.join(d, 'later.jsonl');
    const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'later', filePath }] });
    fs.writeFileSync(filePath, '{"n":1}\n');
    const verdict = await snapshot.verify();
    assert.equal(verdict.changed[0].kind, 'created');
    assert.equal(verdict.changed[0].from.exists, false);
  });

  test('04 a shorter rewrite is truncation, so a lost tail cannot pass as history', async () => {
    const a = fixture('a.jsonl', '{"n":1}\n{"n":2}\n');
    const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'a', filePath: a.filePath }] });
    fs.writeFileSync(a.filePath, '{"n":1}\n');
    const verdict = await snapshot.verify();
    assert.equal(verdict.changed[0].kind, 'truncated');
    assert.ok(verdict.changed[0].to.size < verdict.changed[0].from.size);
  });

  test('05 a metadata-only window cannot see the same-size rewrite and says so', async () => {
    const a = fixture('a.jsonl', 'aaaa\n');
    const before = await storeIdentity(a.filePath, { content: false });
    const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'a', filePath: a.filePath }], content: false });
    fs.writeFileSync(a.filePath, 'bbbb\n');
    fs.utimesSync(a.filePath, new Date(before.mtimeMs), new Date(before.mtimeMs));
    const verdict = await snapshot.verify();
    assert.equal(snapshot.certification, 'metadata');
    assert.equal(verdict.state, 'consistent');
    assert.match(verdict.note, /cannot see a same-size rewrite/);
  });

  test('06 a retried read re-reads every store and certifies the second attempt', async () => {
    const a = fixture('a.jsonl', '{"n":1}\n');
    let moved = false;
    const run = await runConsistentEvidenceRead({
      stores: [{ name: 'a', filePath: a.filePath }],
      read: async () => {
        if (moved === false) {
          moved = true;
          await fs.promises.appendFile(a.filePath, '\n');
        }
        return 'read';
      },
    });
    assert.equal(run.ok, true);
    assert.equal(run.state, 'consistent');
    assert.equal(run.attempts, 2);
    assert.equal(run.value, 'read');
  });

  test('07 an uninspectable path is not retried, because a retry cannot make it readable', async () => {
    const d = dir();
    const run = await runConsistentEvidenceRead({
      stores: [{ name: 'directory', filePath: d }],
      read: async () => 'never used',
    });
    assert.equal(run.ok, false);
    assert.equal(run.state, 'unverifiable');
    assert.equal(run.attempts, 1);
  });

  test('08 more stores than the window covers are refused, never silently dropped', async () => {
    const stores = Array.from({ length: MAX_SNAPSHOT_STORES + 1 }, (_, i) => ({ name: `s${i}`, filePath: path.join(dir(), `${i}.jsonl`) }));
    await assert.rejects(() => openEvidenceSnapshot({ stores }), /at most 32 stores/);
  });
});

// =================================================================================================
// §8/§9: one closed vocabulary, and a truncation that must name its source
// =================================================================================================
describe('AP-07 §8/§9 adversarial: a bound is never a fact about the world', () => {
  test('09 a truncation that names no source is a caller error, not a finding', () => {
    assert.throws(() => integrityReport({ truncated: true }), /must name the source/);
    assert.throws(() => integrityReport({ truncated: true, truncatedSources: [] }), /must name the source/);
  });

  test('10 a named truncation is valid_bounded and changes the digest', () => {
    const plain = integrityReport({ subject: 'evidence' });
    const cut = integrityReport({ subject: 'evidence', truncated: true, truncatedSources: ['memory'] });
    assert.equal(cut.state, 'valid_bounded');
    assert.equal(cut.truncated, true);
    assert.deepEqual(cut.truncatedSources, ['memory']);
    assert.equal(cut.usable, true);
    assert.notEqual(cut.digest, plain.digest);
  });

  test('11 an unknown integrity state and an unknown read state are both refused', () => {
    assert.throws(() => integrityFinding('not_a_state', { check: 'x' }), /unknown integrity state/);
    assert.deepEqual([...INTEGRITY_STATES], [
      'valid', 'valid_bounded', 'missing', 'stale', 'conflicting', 'broken_reference',
      'damaged_store', 'truncated_history', 'concurrent_modification', 'unverifiable',
    ]);
    assert.deepEqual([...READ_STATES], [
      'complete_empty', 'complete_nonempty', 'bounded_usable', 'truncated', 'missing',
      'unavailable', 'damaged', 'inconsistent', 'unverifiable',
    ]);
    assert.throws(() => sourceRead({ source: 'x', status: 'almost' }), /unknown source read status/);
  });

  test('12 readFindings maps the read vocabulary onto the integrity vocabulary', () => {
    const read = readReport({
      subject: 'evidence',
      reads: [
        sourceRead({ source: 'a', status: 'truncated', returned: 2, total: 5, stoppedAt: 'limit' }),
        sourceRead({ source: 'b', status: 'unavailable' }),
        sourceRead({ source: 'c', status: 'damaged', returned: 1 }),
      ],
    });
    assert.equal(read.state, 'damaged');
    assert.deepEqual(read.truncatedSources, ['a']);
    assert.deepEqual(readFindings(read).map((finding) => finding.state).sort(), [
      'damaged_store', 'truncated_history', 'unverifiable',
    ]);
  });

  test('13 a damaged store is reported as damaged and the report stays available', async () => {
    const memory = fixture('memory.jsonl');
    const knowledge = fixture('knowledge.jsonl');
    const report = await evidenceIntegrityReport({
      stores: {
        memory: { filePath: memory.filePath, health: async () => ({ available: true, inspected: true, corruptLines: 1, records: 2 }) },
        knowledge: { filePath: knowledge.filePath, health: async () => ({ available: true, inspected: true, corruptLines: 0, records: 0 }) },
      },
    });
    assert.equal(report.state, 'damaged_store');
    assert.equal(report.available, true);
    assert.equal(report.usable, false);
    assert.equal(report.integrity.state, 'damaged_store');
  });

  test('14 a report digest binds certification and window state, so the weaker read reads differently', () => {
    const findings = [integrityFinding('stale', { check: 'currency', subject: 'memory:1' })];
    const base = { findings, snapshot: { state: 'consistent', digest: 'same-bytes' } };
    const content = integrityReport({ ...base, snapshot: { ...base.snapshot, certification: 'content' } });
    const metadata = integrityReport({ ...base, snapshot: { ...base.snapshot, certification: 'metadata' } });
    const moved = integrityReport({ ...base, snapshot: { ...base.snapshot, certification: 'content', state: 'concurrent_modification' } });
    assert.notEqual(content.digest, metadata.digest);
    assert.notEqual(content.digest, moved.digest);
    assert.equal(content.certification, 'content');
    assert.equal(moved.snapshotState, 'concurrent_modification');
  });

  test('15 every read, integrity, and evidence report denies authorization', async () => {
    const read = readReport({ reads: [sourceRead({ source: 'a', returned: 0 })] });
    const integrity = integrityReport({ subject: 'evidence' });
    const evidence = await evidenceIntegrityReport({
      stores: { memory: { filePath: fixture('m.jsonl').filePath, health: async () => ({ available: true, inspected: true, corruptLines: 0, records: 0 }) } },
    });
    assert.equal(read.authorizes, false);
    assert.equal(integrity.authorizes, false);
    assert.equal(evidence.authorizes, false);
  });
});

// =================================================================================================
// §4: cognition retrieval discloses an uncertified or moved bundle
// =================================================================================================
function cognitionFixture({ window = null, stores = {}, seeds = {}, request = 'what do you remember about the release note' } = {}) {
  const understanding = understandRequest({ request });
  return retrieveEvidence({ request, understanding, stores, seeds, window });
}

describe('AP-07 §4 adversarial: retrieval never presents a moved window as complete', () => {
  test('16 an inconsistent window makes the retrieval inconsistent, its uncertainty unverifiable, and is disclosed', async () => {
    const window = { state: 'concurrent_modification', certification: 'content' };
    const retrieval = await cognitionFixture({ seeds: { knowledge: [] }, window });
    assert.equal(retrieval.read.state, 'inconsistent');
    assert.equal(retrieval.read.complete, false);
    assert.equal(sourceUncertainty(retrieval), Uncertainty.UNVERIFIABLE);
    const understanding = understandRequest({ request: 'what do you remember about the release note' });
    const claims = extractClaims({ evidence: retrieval.evidence, understanding, conflicts: [] });
    const reading = deliberate({ understanding, retrieval, claims });
    assert.ok(reading.disclosures.includes(Disclosure.EVIDENCE_NOT_SINGLE_INSTANT), JSON.stringify(reading.disclosures));
  });

  test('17 an uninspectable window is unverifiable and discloses that no snapshot was certified', async () => {
    const window = { state: 'unverifiable', certification: 'content' };
    const retrieval = await cognitionFixture({ seeds: { knowledge: [] }, window });
    assert.equal(retrieval.read.state, 'unverifiable');
    assert.equal(retrieval.read.window, 'unverifiable');
    const understanding = understandRequest({ request: 'what do you remember about the release note' });
    const claims = extractClaims({ evidence: retrieval.evidence, understanding, conflicts: [] });
    const reading = deliberate({ understanding, retrieval, claims });
    assert.ok(reading.disclosures.includes(Disclosure.EVIDENCE_SNAPSHOT_UNVERIFIED), JSON.stringify(reading.disclosures));
  });

  test('18 a relevance-gated empty result is bounded_usable, never proof of absence', async () => {
    const retrieval = await cognitionFixture({ stores: { memory: { search: async () => [] } } });
    const memory = retrieval.read.reads.find((read) => read.source === 'memory');
    assert.equal(memory.state, 'bounded_usable');
    assert.equal(memory.complete, false);
    assert.equal(absenceProven(memory), false);
    assert.equal(absenceProven(readReport({ reads: [sourceRead({ source: 'x', returned: 0 })] })), true);
  });

  test('19 an unreadable source reports null counts and is named unavailable', async () => {
    const retrieval = await cognitionFixture({ seeds: { memoryUnavailable: true, knowledge: [] } });
    const memory = retrieval.read.reads.find((read) => read.source === 'memory');
    assert.equal(memory.state, 'unavailable');
    assert.equal(memory.returned, null);
    assert.ok(retrieval.counts.unavailable.includes('memory'));
  });

  test('20 a seeded source discloses that it was read before the window opened', async () => {
    const retrieval = await cognitionFixture({ seeds: { knowledge: [] } });
    const knowledge = retrieval.read.reads.find((read) => read.source === 'knowledge');
    assert.equal(knowledge.state, 'bounded_usable');
    assert.match(knowledge.reason, /caller retrieved this source/);
  });
});

// =================================================================================================
// §5: the World Model reports what its projection actually covered
// =================================================================================================
describe('AP-07 §5 adversarial: a projection names the bound that cut it', () => {
  test('21 the record limit produces a truncated memory read and the render names it', async () => {
    const now = clock();
    const app = await appIn(dir(), now);
    for (const n of [1, 2, 3]) {
      const written = await app.controller.handle(`remember that the AP07 note ${n} holds`, { origin: 'user' });
      assert.equal(written.status, Outcome.SUCCESS_VERIFIED, written.output);
    }
    const world = await buildWorldState({
      memory: app.memory, knowledge: app.knowledge, recordLimit: 2, now,
    });
    assert.equal(world.read.state, 'truncated');
    assert.deepEqual(world.read.truncatedSources, ['memory']);
    assert.equal(world.read.patternsAllowed, false);
    assert.equal(world.complete, false);
    assert.match(renderWorldState(world), /truncated at \d+ recent records: memory/);
  });

  test('22 an uninspectable store is unavailable with null counts, never an empty store', async () => {
    const now = clock();
    const app = await appIn(dir(), now);
    const world = await buildWorldState({
      memory: {
        projectionRead: async () => ({
          records: null,
          health: { inspected: false, detail: 'the memory store could not be inspected' },
        }),
      },
      knowledge: app.knowledge,
      now,
    });
    const memory = world.read.reads.find((read) => read.source === 'memory');
    assert.equal(memory.state, 'unavailable');
    assert.equal(memory.returned, null);
    assert.equal(world.read.state, 'unavailable');
    assert.match(renderWorldState(world), /memory: unavailable/);
  });

  test('23 a moved window re-derives the projection as inconsistent and keeps the per-source state', () => {
    const world = {
      read: readReport({ subject: 'world-state', reads: [sourceRead({ source: 'memory', returned: 2 })] }),
      complete: true,
      attention: false,
    };
    const certified = certifyWorldRead(world, { state: 'concurrent_modification', certification: 'content', consistent: false });
    assert.equal(certified.read.state, 'inconsistent');
    assert.equal(certified.read.reads[0].sourceState, 'complete_nonempty');
    assert.equal(certified.complete, false);
    assert.equal(certified.attention, true);
  });

  test('24 certification can never promote an incomplete projection to complete', () => {
    const world = {
      read: readReport({ subject: 'world-state', reads: [sourceRead({ source: 'memory', returned: 0 })] }),
      complete: false,
      attention: false,
    };
    const certified = certifyWorldRead(world, { state: 'consistent', certification: 'content', consistent: true, complete: true });
    assert.equal(certified.read.state, 'complete_empty');
    assert.equal(certified.read.complete, true);
    assert.equal(certified.complete, false);
    assert.equal(certified.attention, true);
  });
});

// =================================================================================================
// §6: a pattern over a prefix is not a pattern over history
// =================================================================================================
const BASE = Date.parse('2026-11-05T00:00:00.000Z');
const at = (index) => new Date(BASE + index * 3_600_000).toISOString();
let projectionSeq = 0;

function projection({ outcomeClass = 'success', index = 0, capability = 'calc.evaluate' } = {}) {
  projectionSeq += 1;
  const id = `pred-ap07-${projectionSeq}`;
  return {
    id,
    capability,
    expectation: 'success',
    status: 'evaluated',
    provenance: { origin: 'user_recorded' },
    invalidation: null,
    retired: false,
    supersededBy: [],
    evaluation: {
      id: `eval-${id}`,
      verdict: outcomeClass === 'success' ? 'matched' : 'contradicted',
      decidingExperienceId: `exp-${id}`,
      outcomeExperienceIds: [`exp-${id}`],
      createdAt: at(index),
    },
    evaluationStale: false,
    deciding: { id: `exp-${id}`, occurredAt: at(index), outcomeClass },
    lineage: { available: true, atCreation: { unresolvedExperienceIds: [], unresolvedFeedbackIds: [], unavailableDeclared: false } },
    createdAt: at(index),
    expiresAt: at(index + 1),
  };
}

function analyse(projections, extra = {}) {
  return analyzeLongitudinal({
    projections,
    experiencesById: new Map(projections.flatMap((p) => (p.evaluation?.outcomeExperienceIds ?? []).map((id) => [id, { id, active: true }]))),
    now: '2026-11-20T00:00:00.000Z',
    ...extra,
  });
}

describe('AP-07 §6 adversarial: the analysis withholds what its read does not support', () => {
  test('25 a truncated ledger withholds every pattern and the render says withheld', () => {
    const report = analyse([projection({ index: 0 }), projection({ index: 1 })], {
      readTotal: 5, readTruncated: true,
    });
    assert.equal(report.read.complete, false);
    assert.equal(report.read.patternsAllowed, false);
    assert.ok(report.groups.length > 0);
    for (const group of report.groups) {
      assert.equal(group.pattern.withheld, true);
      assert.equal(group.pattern.sufficient, false);
      assert.equal(group.pattern.proposalField, null);
      assert.match(group.pattern.withheldReason, /bounded window/);
    }
    assert.match(renderLongitudinal(report), /withheld/);
  });

  test('26 a window that moved withholds every pattern for the window reason', () => {
    const report = analyse([projection({ index: 0 }), projection({ index: 1 })], {
      window: { state: 'concurrent_modification', certification: 'content' },
    });
    assert.equal(report.read.window, 'concurrent_modification');
    assert.equal(report.read.patternsAllowed, false);
    for (const group of report.groups) {
      assert.equal(group.pattern.withheld, true);
      assert.match(group.pattern.withheldReason, /no single instant/);
    }
    assert.match(renderLongitudinal(report), /withheld/);
  });

  test('27 a complete read is stable across input order and permits a stated pattern', () => {
    const first = projection({ index: 0 });
    const second = projection({ index: 1 });
    const a = analyse([first, second]);
    const b = analyse([second, first]);
    assert.equal(a.read.complete, true);
    assert.equal(a.read.patternsAllowed, true);
    assert.equal(a.groups[0].pattern.kind, 'repeated_success');
    assert.equal(a.groups[0].pattern.sufficient, true);
    assert.equal(a.digest, b.digest);
  });
});

// =================================================================================================
// §7: plan outcome and assessment carry the window that produced them
// =================================================================================================
let goalSeq = 0;
async function activeGoal(app) {
  goalSeq += 1;
  const created = await app.controller.goalAdd({
    request: `keep the running note current, AP07 case ${goalSeq}`,
    criteria: [
      { description: 'remember that the note holds', basis: 'user_stated' },
      { description: 'list my memory', basis: 'user_stated' },
    ],
  });
  assert.equal(created.status, Outcome.GOAL_CREATED, created.output);
  const goalId = data(created).goalId;
  for (const status of ['accepted', 'active']) {
    assert.equal((await app.controller.goalUpdate({ target: goalId, status })).status, Outcome.GOAL_UPDATED);
  }
  return goalId;
}

const GUIDANCE = 'read the list before adding to it';

// Two corrected writes derive one candidate; the user approves it and states its shape. Without a
// recorded rule the disclosed comparison separates none of the approaches, so no plan is recorded.
async function seedRule(app, tag = 'AP07') {
  for (const n of [1, 2]) {
    const write = await app.controller.handle(`remember that the ${tag} note ${n} holds`, { origin: 'user' });
    assert.equal(write.status, Outcome.SUCCESS_VERIFIED, write.output);
    const experience = await app.controller.experienceRecord({ operationId: write.operation.id, subject: `an ${tag} memory write` });
    assert.equal(experience.status, Outcome.SUCCESS_VERIFIED, experience.output);
    const feedback = await app.controller.feedbackRecord({
      target: data(experience).id, assessment: 'user_correction', guidance: GUIDANCE, reason: 'done the long way round',
    });
    assert.equal(feedback.status, Outcome.SUCCESS_VERIFIED, feedback.output);
  }
  const derived = data(await app.controller.adaptationDerive({}));
  const adaptation = derived.created.find((record) => record.rule === GUIDANCE);
  assert.ok(adaptation, JSON.stringify(derived.created));
  assert.equal((await app.controller.adaptationDecide({
    target: adaptation.id, decision: 'approved', reason: 'this is how I want it done',
  })).status, Outcome.SUCCESS_VERIFIED);
  assert.equal((await app.controller.adaptationGuide({ target: adaptation.id, order: 'reads_first' })).status, Outcome.SUCCESS_VERIFIED);
  return adaptation;
}

async function runPlan(app, goalId) {
  const prepared = await app.controller.handle(`prepare a plan for goal ${goalId}`, { origin: 'user' });
  assert.equal(prepared.status, Outcome.PLAN_STORED, prepared.output);
  const planId = prepared.operation.steps.find((step) => step.action === 'plan.add')?.result?.data?.planId;
  assert.ok(planId, 'the preparation recorded a plan');
  assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);
  const run = await app.controller.planActivate(planId, { mode: 'run' });
  assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.output ?? display(run));
  return planId;
}

describe('AP-07 §7 adversarial: a recorded reading is bound to one window', () => {
  test('28 plan.outcome discloses a consistent content-certified window', async () => {
    const app = await appIn(dir());
    await seedRule(app);
    const goalId = await activeGoal(app);
    const planId = await runPlan(app, goalId);
    const res = await app.controller.planOutcome({ plan: planId });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    const outcome = data(res);
    assert.equal(outcome.evidence.window, 'consistent');
    assert.equal(outcome.evidence.certification, 'content');
    assert.equal(outcome.evidence.consistent, true);
    assert.deepEqual(outcome.evidence.changed, []);
    assert.match(outcome.evidence.note, /not a transaction/);
    assert.match(display(res), /evidence window: consistent; content certification/);
  });

  test('29 plan.assess refuses to record when the plans file moved during the read', async () => {
    const app = await appIn(dir());
    await seedRule(app);
    const goalId = await activeGoal(app);
    const planId = await runPlan(app, goalId);
    const filePath = app.plans.filePath;
    const before = fs.readFileSync(filePath);
    const original = app.plans.resolve;
    app.plans.resolve = async function patchedResolve(...args) {
      const result = await original.apply(this, args);
      fs.appendFileSync(filePath, '\n');
      return result;
    };
    let res;
    try {
      res = await app.controller.planAssess({ target: planId });
    } finally {
      app.plans.resolve = original;
      fs.writeFileSync(filePath, before);
    }
    // The refusal happens while the action runs, so the controller reports it as a failed execution
    // rather than a rejected input: the target was well formed, the records underneath it moved.
    assert.equal(res.status, Outcome.EXECUTION_FAILED, res.output);
    const step = res.operation.steps[0];
    assert.equal(step.outcome, Outcome.EXECUTION_FAILED);
    assert.equal(step.execution.status, 'failed');
    assert.equal(step.execution.error.code, 'EVIDENCE_WINDOW_UNCONFIRMED');
    assert.match(step.execution.error.message, /not provably unchanged/);
    assert.match(step.execution.error.message, /concurrent_modification/);
    assert.deepEqual(await app.plans.assessments(planId), [], 'nothing was recorded on a window that moved');
  });
});

// =================================================================================================
// §10 end to end: every integrated consumer, one assembled application
// =================================================================================================
describe('AP-07 end to end: one application, every integrated consumer', () => {
  test('grounded retrieval, world state, longitudinal, candidates, execution, outcome, effectiveness, governance, integrity', async () => {
    const now = clock();
    const app = await appIn(dir(), now);
    await seedRule(app);
    for (const n of [1, 2]) {
      const written = await app.controller.handle(`remember that the release note ${n} holds`, { origin: 'user' });
      assert.equal(written.status, Outcome.SUCCESS_VERIFIED, written.output);
    }
    const goalId = await activeGoal(app);

    // Grounded cognitive retrieval: the same window the request path opens, with real stores.
    const request = 'what do you remember about the release note';
    const snapshot = await openEvidenceSnapshot({
      stores: contributingStores({
        memory: app.memory,
        knowledge: app.knowledge,
        experience: app.experience,
        predictions: app.predictions,
        goals: app.goals,
        plans: app.plans,
        tasks: app.taskStore,
        world: app.worldModel,
      }),
    });
    const memoryHits = await snapshot.read('memory', () => app.memory.search(request, { limit: 8 }));
    const knowledge = await snapshot.read('knowledge', () => app.knowledge.search(request, { limit: 8 }));
    const verdict = await snapshot.verify();
    assert.equal(verdict.state, 'consistent');
    assert.equal(verdict.certification, 'content');
    const analysis = await analyzeRequest({
      request,
      now: now(),
      stores: { memory: app.memory, knowledge: app.knowledge },
      seeds: { memoryHits, knowledge },
      window: verdict,
    });
    assert.equal(analysis.available, true);
    assert.equal(analysis.retrieval.read.window, 'consistent');
    assert.equal(analysis.retrieval.read.certification, 'content');
    assert.equal(analysis.retrieval.read.state, 'bounded_usable');
    assert.ok(analysis.retrieval.counts.bySource.memory > 0, 'the request was grounded in the stored records');

    // World Model construction: its own read report is present and its stores were readable.
    const worldRes = await app.controller.worldState();
    assert.equal(worldRes.status, Outcome.SUCCESS_VERIFIED, worldRes.output);
    assert.ok(worldRes.world.read);
    assert.notEqual(worldRes.world.read.state, 'unavailable');
    assert.equal(worldRes.world.read.window, 'unverified', 'the projection was not read through a caller window');
    assert.match(display(worldRes), /Store read:/);

    // Prediction longitudinal: the ledger and the experience log are read in one window.
    const longitudinal = await app.controller.predictionLongitudinal({});
    assert.equal(longitudinal.status, Outcome.SUCCESS_VERIFIED, longitudinal.output);
    const report = data(longitudinal).report;
    assert.equal(report.read.window, 'consistent');
    assert.equal(report.read.patternsAllowed, true);
    assert.equal(report.authorizes, false);

    // Candidate generation and comparison: the comparison discloses its window.
    const candidates = await app.controller.planCandidates({ goal: goalId });
    assert.equal(candidates.status, Outcome.SUCCESS_VERIFIED, candidates.output);
    const compared = data(candidates);
    assert.equal(compared.evidence.window, 'consistent');
    assert.equal(compared.evidence.certification, 'content');
    assert.ok(Array.isArray(compared.candidates));

    // Preparation, approval, execution, outcome assessment and continuation reading.
    const planId = await runPlan(app, goalId);
    const outcome = await app.controller.planOutcome({ plan: planId });
    assert.equal(outcome.status, Outcome.SUCCESS_VERIFIED, outcome.output);
    assert.equal(data(outcome).evidence.window, 'consistent');
    const continuation = await app.controller.planContinuation(planId);
    assert.equal(continuation.status, Outcome.SUCCESS_VERIFIED, continuation.output);
    assert.equal(data(continuation).evidence.window, 'consistent');
    assert.match(display(continuation), /Evidence window: consistent; content certification/);

    // Effectiveness and governance: read-only reports that authorize nothing.
    const effectiveness = await app.controller.adaptationEffectiveness({});
    assert.equal(effectiveness.status, Outcome.SUCCESS_VERIFIED, effectiveness.output);
    assert.equal(data(effectiveness).report.authorizes, false);
    assert.match(display(effectiveness), /approves nothing/);
    const reviews = await app.controller.adaptationReviews({});
    assert.equal(reviews.status, Outcome.SUCCESS_VERIFIED, reviews.output);
    assert.equal(data(reviews).report.authorizes, false);

    // Evidence integrity: one content-certified window over every configured store.
    const integrity = await app.controller.evidenceIntegrity();
    assert.equal(integrity.status, Outcome.SUCCESS_VERIFIED, integrity.output);
    const evidence = data(integrity).report;
    assert.equal(evidence.authorizes, false);
    assert.equal(evidence.snapshot.certification, 'content');
    assert.equal(evidence.snapshot.state, 'consistent');
    assert.ok(evidence.counts.stores >= 8, `every configured store was inspected (${evidence.counts.stores})`);
    assert.ok(['valid', 'valid_bounded'].includes(evidence.state), evidence.state);
  });
});

// Keep the world-record limit imported and pinned: a projection claims truncation against this bound.
test('the world record limit is the bound the projection names', () => {
  assert.equal(WORLD_RECORD_LIMIT, 100);
  assert.equal(SNAPSHOT_SCHEMA, 'apex.evidence-snapshot.v1');
});
