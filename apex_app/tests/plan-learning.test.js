// Batch AL, work package H and I at the plan layer: what the records about past attempts say, and
// what they are not allowed to do.
//
// The learning already exists in this application as three kinds of record - an adaptation the user
// approved, an expectation the user recorded, and an outcome assessment recorded against a plan - and
// this batch attaches all three to the planning answers as disclosure. Read carelessly, four
// distinctions get lost, and each loss makes a plan look better supported than the records support: a
// candidate adaptation read as an approved one, an expectation read as an observation, an expired
// prediction read as a wrong one, and a count of three evaluations read as a probability. Every test
// here checks one of those four inverting states, plus the guarantee that holds them all apart:
// nothing in this read is an input to the comparison it is printed under. No gate, no ranked
// dimension, no score and no candidate digest is computed from it, and that is measured by comparing
// the candidate bytes with and without the records present rather than asserted in prose.
//
// Everything runs through the real controller, the real plan/goal/experience/prediction stores and
// the live action registry against a temporary data directory, with a deterministic clock. The only
// test doubles are a store that throws, to show an unreadable log is reported as unreadable rather
// than as empty, and the same read taken with no stores configured at all. No model service is
// contacted; no inference is performed; nothing here approves or executes anything on the user's
// behalf.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { ClaimKind, BOUNDS } from '../src/executive/vocabulary.js';
import { describePlanOptions, describePlanOutcome } from '../src/executive/status.js';
import {
  LEARNING_SCHEMA,
  LEARNING_RULE,
  LEARNING_SEPARATIONS,
  LEARNING_BOUNDS,
  LEARNING_NOT_APPLIED,
  learningScope,
  learningDigest,
  learningStatements,
  learningAbsenceParts,
  learningAbsence,
  readLearning,
  renderLearning,
} from '../src/executive/learning.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const HOUR = 3_600_000;

// A clock the test can move: an expired expectation needs a horizon that has passed, and the stores
// derive that status from the configured clock rather than from wall time.
function clock() {
  const state = { now: new Date('2026-11-05T09:00:00.000Z') };
  return {
    now: () => new Date(state.now),
    advance(ms) { state.now = new Date(state.now.getTime() + ms); },
  };
}

async function appIn(dir, t) {
  return createApp({ dataDir: dir, now: t.now, experienceCapture: CAPTURE_OFF, extraActions: [] });
}

const dOf = (res) => res.operation?.steps?.[0]?.result?.data ?? {};
const dataOf = (step) => step.result?.data ?? {};
const run = (app, name, input, operationId) => app.controller.runAction(name, input, 'user', operationId);

async function newGoal(app, request = 'remember the release date') {
  const res = await app.controller.goalAdd({ request, criteria: [request] });
  assert.equal(res.status, Outcome.GOAL_CREATED, res.output);
  return dOf(res).goalId;
}

// memory.add operations recorded through the real conversation bridge, because an adaptation's support
// is a set of experiences and an experience cites one operation.
async function rememberWrites(app, count = 2) {
  for (let i = 0; i < count; i += 1) {
    await app.controller.handle(`remember that the release date is 2026-12-0${i + 1}`, { origin: 'user' });
  }
  const log = await app.operations.list({ limit: 40 });
  return log.records.filter((r) => r.capability === 'memory.add');
}

// One user correction about one operation, repeated over two operations so the derivation has support.
async function correctTwice(app, ops, guidance) {
  for (const op of ops.slice(0, 2)) {
    const e = await app.controller.experienceRecord({ operationId: op.id, subject: 'a memory write' });
    const f = await app.controller.feedbackRecord({
      target: dOf(e).id,
      assessment: 'user_correction',
      guidance,
      reason: 'the date was already recorded once',
    });
    assert.equal(f.status, Outcome.SUCCESS_VERIFIED, f.output);
  }
}

// A full chain to one in-scope approved adaptation, as the shipped actions write it.
async function approvedAdaptation(app, guidance = 'check the calendar before recording a date') {
  const ops = await rememberWrites(app, 2);
  assert.ok(ops.length >= 2, 'the bridge recorded no memory.add operation to correct');
  await correctTwice(app, ops, guidance);
  const derived = dOf(await app.controller.adaptationDerive({}));
  const mine = (derived.created ?? []).filter((a) => a.rule === guidance);
  assert.equal(mine.length, 1, `deriving "${guidance}" gave ${JSON.stringify(derived.created)}`);
  const decided = await app.controller.adaptationDecide({
    target: mine[0].id, decision: 'approved', reason: 'this is how I want it done',
  });
  assert.equal(decided.status, Outcome.SUCCESS_VERIFIED, decided.output);
  return mine[0];
}

function expectation(kind, needle) {
  return (s) => s.kind === kind && s.text.includes(needle);
}

// ---- the scope ----------------------------------------------------------------
test('a learning read asks by the capability each recorded step names, in order and deduplicated', () => {
  const candidates = [
    { content: { steps: [{ action: 'memory.add' }, { action: 'knowledge.add' }, { action: 'memory.add' }] } },
    { content: { steps: [{ action: 'filesystem.list' }] } },
  ];
  const scope = learningScope(candidates, null);
  assert.deepEqual(scope.capabilities, ['memory.add', 'knowledge.add', 'filesystem.list'], 'a step that is not a capability question is not asked');
  assert.equal(scope.considered, 3);
  assert.equal(scope.truncated, false);

  // The prior plan's own steps join the scope, so a revision is read against what was actually attempted.
  const withPrior = learningScope(candidates, { steps: [{ action: 'memory.search' }] });
  assert.deepEqual(withPrior.capabilities, ['memory.add', 'knowledge.add', 'filesystem.list', 'memory.search']);

  // Bounded, and stated as bounded: a candidate set that names more capabilities than the read prints
  // reports how many were considered rather than implying the list was complete.
  const many = [{ content: { steps: Array.from({ length: LEARNING_BOUNDS.capabilities + 3 }, (_, i) => ({ action: `cap.${i}` })) } }];
  const wide = learningScope(many, null);
  assert.equal(wide.capabilities.length, LEARNING_BOUNDS.capabilities);
  assert.equal(wide.considered, LEARNING_BOUNDS.capabilities + 3);
  assert.equal(wide.truncated, true);

  // A step with no action of its own names nothing: the scope cannot invent a capability.
  assert.deepEqual(learningScope([{ content: { steps: [{ id: 's1' }, null] } }], null).capabilities, []);
});

// ---- empty, absent and unreadable ---------------------------------------------
test('an empty read states each absence in the scope it is an absence within, and claims nothing', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    const step = await run(app, 'plan.candidates', { goal: goalId }, 'op-empty');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
    const learning = dataOf(step).learning;
    assert.equal(learning.schema, LEARNING_SCHEMA);
    assert.equal(learning.recordsRead, 0);
    assert.deepEqual(learning.unavailable, [], 'every store in this build was reached, so nothing is reported as unreadable');
    assert.equal(learning.authorizes, false);
    assert.equal(learning.influencesSelection, false);

    const statements = learningStatements(learning).map((s) => s.text);
    // Each part is a different store's absence, printed apart because an answer that bounds its lines
    // would lose the last part of one joined sentence.
    assert.deepEqual(statements, learningAbsenceParts(learning).map((p) => `${p}.`));
    assert.match(learningAbsence(learning), /no adaptation the user approved is recorded/);
    assert.match(learningAbsence(learning), /no expectation is recorded/);
    assert.match(learningAbsence(learning), /no other plan for this goal carries a recorded outcome assessment/);
    // "nothing is recorded" is not what happened: the read is scoped, and a run leaves its evidence
    // under task.step, so the reader is told which absence is which.
    assert.match(learningAbsence(learning), /filed under task\.step/);
    for (const s of learningStatements(learning)) assert.equal(s.kind, ClaimKind.FACT);
  } finally {
    cleanup(dir);
  }
});

test('a store this build does not have is reported as absent, never as an empty set of records', async () => {
  const bare = await readLearning({ scope: { capabilities: ['memory.add'], truncated: false, considered: 1 } });
  assert.equal(bare.recordsRead, 0);
  assert.equal(bare.unavailable.length, 3, JSON.stringify(bare.unavailable));
  assert.deepEqual(bare.unavailable, [
    'no experience store is configured in this build',
    'no prediction store is configured in this build',
    'no plan store is configured in this build',
  ]);
  const statements = learningStatements(bare).map((s) => s.text);
  assert.equal(statements.length, 3);
  for (const s of statements) assert.match(s, /^the learning read was incomplete: /);
  // The distinction the batch asks for: an absent store does not get to report that nothing is recorded.
  assert.ok(!statements.some((s) => /no adaptation the user approved is recorded/.test(s)), statements.join(' | '));
  assert.match(learningAbsence(bare), /^the learning read was incomplete: /);
  assert.equal(learningAbsence(null), 'no learning read was taken, so nothing about past attempts is claimed here');
});

test('a store that cannot be read gives its own reason, and never a blank or an undefined', async () => {
  const read = await readLearning({
    experience: { async activeAdaptations() { throw new Error('the experience log is unreadable'); } },
    predictions: { async calibration() { throw new Error('the prediction log is corrupt at line 12'); } },
    plans: { async list() { throw new Error('the plan log is locked'); } },
    scope: { capabilities: ['memory.add'], truncated: false, considered: 1 },
    goalId: 'goal-under-test',
  });
  assert.equal(read.recordsRead, 0);
  assert.deepEqual(read.unavailable, [
    'the experience log could not be read: the experience log is unreadable',
    'the prediction log could not be read: the prediction log is corrupt at line 12',
    'the plan records could not be read: the plan log is locked',
  ]);
  assert.ok(!JSON.stringify(read.unavailable).includes('undefined'), JSON.stringify(read.unavailable));
  // An unreadable store is not an empty one, so the absence parts stay out of the answer.
  const statements = learningStatements(read).map((s) => s.text);
  assert.equal(statements.length, 3);
  assert.ok(statements.every((s) => s.startsWith('the learning read was incomplete: ')), statements.join(' | '));
});

test('a read with no goal to trace cannot claim anything about earlier attempts', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const read = await readLearning({
      predictions: app.predictions,
      experience: app.experience,
      plans: app.plans,
      scope: { capabilities: ['memory.add'], truncated: false, considered: 1 },
      goalId: null,
    });
    assert.deepEqual(read.unavailable, ['this read has no goal to trace earlier attempts to']);
    assert.equal(read.assessments.unavailable, 'this read has no goal to trace earlier attempts to');
    assert.equal(read.recordsRead, 0);
  } finally {
    cleanup(dir);
  }
});

// ---- adaptations: only what the user approved ---------------------------------
test('a candidate, a rejected and a retired adaptation never reach the read; an approved one does', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    const scope = { capabilities: ['memory.add'], truncated: false, considered: 1 };
    const guidance = 'check the calendar before recording a date';

    const ops = await rememberWrites(app, 4);
    await correctTwice(app, ops.slice(0, 2), guidance);
    await correctTwice(app, ops.slice(2, 4), 'quote the source of the date');

    // Derived but not decided: the user has not approved either, so neither is guidance.
    const derived = dOf(await app.controller.adaptationDerive({}));
    assert.equal((derived.created ?? []).length, 2, JSON.stringify(derived.created));
    const first = derived.created.find((a) => a.rule === guidance);
    const second = derived.created.find((a) => a.rule === 'quote the source of the date');
    let read = await readLearning({ predictions: app.predictions, experience: app.experience, plans: app.plans, scope, goalId });
    assert.equal(read.adaptations.rows.length, 0, 'a candidate adaptation is not an approved one');
    assert.equal(learningAbsence(read), 'no adaptation the user approved is recorded; no expectation is recorded; no other plan for this goal carries a recorded outcome assessment; this read asks by the capability each step names, and a step recorded while a plan ran is filed under task.step');

    await app.controller.adaptationDecide({ target: first.id, decision: 'approved', reason: 'this is how I want it done' });
    await app.controller.adaptationDecide({ target: second.id, decision: 'rejected', reason: 'not needed here' });
    read = await readLearning({ predictions: app.predictions, experience: app.experience, plans: app.plans, scope, goalId });
    assert.equal(read.adaptations.rows.length, 1, JSON.stringify(read.adaptations.rows));
    assert.equal(read.adaptations.rows[0].id, first.id);
    assert.equal(read.adaptations.rows[0].rule, guidance);
    assert.equal(read.adaptations.rows[0].capability, 'memory.add');
    assert.equal(read.adaptations.rows[0].supportCount, 2, 'the support the user approved is the experiences behind it');
    assert.equal(read.adaptations.rows[0].decisionReason, 'this is how I want it done');
    assert.equal(read.adaptations.total, 1, 'the store counts one active adaptation, not two records');
    const line = learningStatements(read).find(expectation(ClaimKind.FACT, 'an adaptation the user approved'));
    assert.match(line.text, /check the calendar before recording a date/);
    assert.match(line.text, /from 2 experience\(s\)/);
    assert.match(line.text, /decided 2026-11-05T09:00:00\.000Z/);
    assert.ok(!line.text.includes('quote the source'), 'a rejected adaptation is not surfaced as guidance');

    // Retired: the approval stood and the user ended it, so it leaves the read entirely.
    await app.controller.adaptationRetire({ target: first.id, reason: 'no longer wanted' });
    read = await readLearning({ predictions: app.predictions, experience: app.experience, plans: app.plans, scope, goalId });
    assert.equal(read.adaptations.rows.length, 0);
    assert.equal(read.adaptations.total, 0);
    assert.equal(learningAbsence(read).split('; ')[0], 'no adaptation the user approved is recorded');
  } finally {
    cleanup(dir);
  }
});

test('an adaptation approved for another capability is absent from this scope, and says so', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    await approvedAdaptation(app);
    const read = await readLearning({
      predictions: app.predictions,
      experience: app.experience,
      plans: app.plans,
      scope: { capabilities: ['filesystem.list'], truncated: false, considered: 1 },
      goalId,
    });
    assert.equal(read.adaptations.rows.length, 0);
    assert.equal(read.adaptations.total, 1, 'the store still holds the approval; this scope does not reach it');
    const statements = learningStatements(read).map((s) => s.text);
    assert.ok(statements.some((s) => /^1 adaptation\(s\) the user approved are recorded, none in the capabilities these steps name\.$/.test(s)), statements.join(' | '));
  } finally {
    cleanup(dir);
  }
});

// ---- predictions: five states, two claim kinds -------------------------------
test('an open expectation is a [prediction] and a resolved one is a [fact], never a verified outcome', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    const ops = await rememberWrites(app, 2);
    for (const subject of ['the next write lands', 'a later write lands']) {
      await app.controller.predictionRecord({ capability: 'memory.add', expectation: 'success', subject, inDays: 3 });
    }
    const scope = { capabilities: ['memory.add'], truncated: false, considered: 1 };
    let read = await readLearning({ predictions: app.predictions, experience: app.experience, plans: app.plans, scope, goalId });
    assert.equal(read.predictions.rows.length, 2);
    // Nothing has established either one yet: the store reports them as standing, and the read marks
    // them as predictions rather than as facts.
    let statements = learningStatements(read);
    for (const s of statements.filter((x) => x.text.includes('an expectation the user recorded'))) {
      assert.equal(s.kind, ClaimKind.PREDICTION, s.text);
      assert.match(s.text, /it stands until 2026-11-08T09:00:00\.000Z/);
    }

    // An experience of this capability, inside the horizon: the expectation now has evidence that could
    // settle it, and the store moves it to awaiting an evaluation.
    await app.controller.experienceRecord({ operationId: ops[0].id, subject: 'a memory write' });
    read = await readLearning({ predictions: app.predictions, experience: app.experience, plans: app.plans, scope, goalId });
    assert.equal(read.predictions.rows.length, 2);
    statements = learningStatements(read);
    for (const s of statements.filter((x) => x.text.includes('an expectation the user recorded'))) {
      assert.equal(s.kind, ClaimKind.PREDICTION, s.text);
      assert.match(s.text, /outcome evidence exists but no evaluation was recorded/);
      assert.match(s.text, /its horizon is 2026-11-08T09:00:00\.000Z/);
    }

    // Settled by a recorded evaluation: the same record is now a fact about the log, and its kind moves.
    const evaluable = read.predictions.rows.filter((r) => r.canRecordEvaluation);
    assert.ok(evaluable.length > 0, 'a standing expectation with outcome evidence can be evaluated');
    const ev = await run(app, 'prediction.evaluate', { target: evaluable[0].id }, 'op-eval');
    assert.equal(ev.outcome, Outcome.SUCCESS_VERIFIED, ev.summary);
    read = await readLearning({ predictions: app.predictions, experience: app.experience, plans: app.plans, scope, goalId });
    statements = learningStatements(read);
    const settled = statements.find(expectation(ClaimKind.FACT, 'a recorded evaluation judged it'));
    assert.ok(settled, JSON.stringify(statements.map((s) => s.text)));
    assert.equal(settled.text.match(/record (\w{8})/)[1], String(evaluable[0].id).slice(0, 8));
    const still = statements.filter((s) => s.kind === ClaimKind.PREDICTION);
    assert.equal(still.length, 1, 'only the unresolved expectation keeps the prediction mark');
    assert.ok(!statements.some((s) => s.kind === ClaimKind.VERIFIED_OUTCOME), 'no expectation is ever reported as a verified outcome');
    // The expectation's own subject prose stays out of a plan answer, which can reach a model context.
    assert.ok(!learningStatements(read).some((s) => s.text.includes('the next write lands')), JSON.stringify(statements.map((s) => s.text)));
  } finally {
    cleanup(dir);
  }
});

test('expiry is expiry: never wrong, never a match, and never counted as one', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    // An experience of this capability, so the standing expectation has evidence that could settle it.
    const ops = await rememberWrites(app, 1);
    await app.controller.experienceRecord({ operationId: ops[0].id, subject: 'a memory write' });
    const horizon = new Date(t.now().getTime() + 600_000).toISOString();
    await app.controller.predictionRecord({
      capability: 'filesystem.list', expectation: 'success',
      subject: 'a listing that never happens', expiresAt: horizon,
    });
    await app.controller.predictionRecord({ capability: 'memory.add', expectation: 'success', subject: 'a write that will not be settled', inDays: 3 });
    t.advance(2 * HOUR);

    const read = await readLearning({
      predictions: app.predictions,
      experience: app.experience,
      plans: app.plans,
      scope: { capabilities: ['filesystem.list'], truncated: false, considered: 1 },
      goalId,
    });
    assert.equal(read.predictions.rows.length, 1);
    assert.equal(read.predictions.rows[0].status, 'expired');
    assert.equal(read.predictions.rows[0].verdict, null, 'an expired expectation has no verdict');
    const [line] = learningStatements(read).filter((s) => s.text.includes('an expectation the user recorded'));
    assert.equal(line.kind, ClaimKind.PREDICTION, line.text);
    assert.match(line.text, /its horizon passed on 2026-11-05T09:10:00\.000Z with nothing establishing it; expiry is not a wrong prediction/);
    assert.ok(!/wrong prediction\b(?!;)/.test(line.text.replace('expiry is not a wrong prediction', '')), line.text);
    assert.ok(!line.text.includes('contradicted'), line.text);
    assert.equal(LEARNING_SEPARATIONS[2], 'a prediction whose horizon passed with no outcome evidence is expired. Expiry is never counted as wrong, and never as a match.');

    // Evidence inside the horizon keeps an expectation awaiting an evaluation, not expired, past its own
    // horizon - so "expired" cannot be read as "the user was wrong" either way.
    const standing = await readLearning({
      predictions: app.predictions,
      experience: app.experience,
      plans: app.plans,
      scope: { capabilities: ['memory.add'], truncated: false, considered: 1 },
      goalId,
    });
    assert.equal(standing.predictions.rows[0].status, 'awaiting_evaluation', JSON.stringify(standing.predictions.rows[0]));
    assert.match(standing.predictions.rows[0].statusReason, /outcome evidence exists inside the horizon/);
    assert.equal(standing.predictions.expired, 1);
  } finally {
    cleanup(dir);
  }
});

test('a ledger count is a count: no rate below the store threshold, and no probability wording', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    await rememberWrites(app, 2);
    for (const subject of ['one', 'two', 'three', 'four', 'five']) {
      await app.controller.predictionRecord({ capability: 'memory.add', expectation: 'success', subject, inDays: 3 });
    }
    const scope = { capabilities: ['memory.add'], truncated: false, considered: 1 };
    const read = await readLearning({ predictions: app.predictions, experience: app.experience, plans: app.plans, scope, goalId });
    const statements = learningStatements(read).map((s) => s.text);
    const count = statements.find((s) => s.startsWith('the expectation ledger as read:'));
    assert.ok(count, statements.join(' | '));
    assert.match(count, /A count of records is not a probability\./);
    // Below twenty evaluations the store withholds the rate, and the read repeats the store's reason
    // rather than computing a ratio of its own.
    const rate = statements.find((s) => s.startsWith('no match rate is stated:'));
    assert.ok(rate, statements.join(' | '));
    assert.match(rate, /below 20|no prediction has been evaluated/);
    assert.ok(!statements.some((s) => /probability|chance|likelihood/.test(s) && !/not a probability/.test(s)), statements.join(' | '));
    // Five bear on this capability, the block prints the bound of four, and the fifth is announced
    // rather than dropped.
    const shown = read.predictions.rows.length;
    assert.equal(shown, LEARNING_BOUNDS.predictions);
    assert.equal(read.predictions.truncated, true);
    const block = renderLearning(read);
    assert.match(block, /1 further expectation\(s\) bear on these capabilities and stay in the ledger/);
  } finally {
    cleanup(dir);
  }
});

test('the whole store ledger is not recited as though it bore on these capabilities', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    await app.controller.predictionRecord({ capability: 'knowledge.add', expectation: 'success', subject: 'another capability', inDays: 3 });
    const read = await readLearning({
      predictions: app.predictions,
      experience: app.experience,
      plans: app.plans,
      scope: { capabilities: ['memory.add'], truncated: false, considered: 1 },
      goalId,
    });
    assert.equal(read.predictions.rows.length, 0);
    assert.equal(read.predictions.storedTotal, 1, 'the store holds the expectation; this scope does not reach it');
    const statements = learningStatements(read).map((s) => s.text);
    // The out-of-scope absence is the fact worth printing, and the store-wide count belongs to it. An
    // answer that led with the bare ledger would spend its bounded lines on a number that says nothing
    // about this plan.
    assert.ok(!statements.some((s) => s.startsWith('the expectation ledger as read:')), statements.join(' | '));
    assert.match(statements.join(' | '), /1 expectation\(s\) are recorded, none scoped to the capabilities these steps name/);
  } finally {
    cleanup(dir);
  }
});

// ---- the printed block --------------------------------------------------------
test('the printed block carries the rule, all five separations, and the absence of any effect', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    await approvedAdaptation(app);
    await app.controller.predictionRecord({ capability: 'memory.add', expectation: 'success', subject: 'the winter solstice ledger', inDays: 3 });
    const scope = { capabilities: ['memory.add'], truncated: false, considered: 1 };
    const read = await readLearning({ predictions: app.predictions, experience: app.experience, plans: app.plans, scope, goalId });
    const block = renderLearning(read);
    assert.match(block, new RegExp(LEARNING_RULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const separation of LEARNING_SEPARATIONS) {
      assert.ok(block.includes(separation), `missing separation: ${separation}`);
    }
    assert.equal(LEARNING_SEPARATIONS.length, 5);
    assert.match(block, new RegExp(LEARNING_NOT_APPLIED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // Nothing in the block may read as an instruction or a permission.
    assert.ok(!/\bGRANT\b|\ballows this\b/.test(block), block);
    // The expectation's prose is not carried here, so it cannot arrive in a model context as something
    // that reads like an observation.
    assert.ok(!block.includes('the winter solstice ledger'), block);
    for (const line of block.split('\n')) assert.ok(!/^\s*$/.test(line) || line === '', 'a statement stays on one line');
    assert.equal(renderLearning(null), 'What the records of past attempts say: nothing read, so nothing claimed.');
  } finally {
    cleanup(dir);
  }
});

// ---- the wired read paths ----------------------------------------------------
test('plan.candidates verifies the learning read it disclosed, and refuses when those records move', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    const def = app.registry.get('plan.candidates');
    const ctx = {
      registry: app.registry, goals: app.goals, plans: app.plans,
      experience: app.experience, predictions: app.predictions,
      operationId: 'op-al09-verify', origin: 'user',
    };
    const input = { goalRef: goalId, work: null, cannotUse: [] };

    const fresh = await def.execute(ctx, input);
    assert.equal(fresh.data.learning.recordsRead, 0);
    assert.equal((await def.verify(ctx, input, fresh)).ok, true);
    assert.match((await def.verify(ctx, input, fresh)).detail, /the learning disclosure re-reads to the same records/);

    // The records the answer disclosed are re-read by the verifier. An expectation recorded after the
    // answer was produced moves that read, so the answer on screen describes records that have moved,
    // and is refused rather than quietly re-stated.
    await app.controller.predictionRecord({ capability: 'memory.add', expectation: 'success', subject: 'recorded afterwards', inDays: 3 });
    const drifted = await def.verify(ctx, input, fresh);
    assert.equal(drifted.ok, false);
    assert.match(drifted.detail, /the learning records disclosed with this comparison no longer read the same/);

    // The same answer, re-read now that the new record is part of both sides, verifies again.
    const again = await def.execute(ctx, input);
    assert.equal(again.data.learning.recordsRead, 1);
    assert.equal((await def.verify(ctx, input, again)).ok, true);
    const through = await run(app, 'plan.candidates', { goal: goalId }, 'op-al09-cand');
    assert.equal(through.outcome, Outcome.SUCCESS_VERIFIED, through.summary);
  } finally {
    cleanup(dir);
  }
});

test('learning records change no candidate byte, gate, ranked dimension or score', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    const before = await run(app, 'plan.candidates', { goal: goalId }, 'op-al09-bare');
    assert.equal(before.outcome, Outcome.SUCCESS_VERIFIED, before.summary);
    // Everything the comparison is decided by, and nothing the learning block adds to the print. Batch
    // AM prints a second learning disclosure - the guidance ledger, beside the comparison - so the cut
    // has to take both blocks out, or a record that ranked nothing would read as a changed decision.
    const snapshot = (step) => JSON.stringify({
      candidateSetDigest: dataOf(step).candidateSetDigest,
      candidates: dataOf(step).candidates,
      comparison: dataOf(step).comparison,
      summary: step.summary,
      display: (step.display ?? '').split(/(?=What the records of past attempts|Approved guidance that bears on)/)[0],
    });
    const bytesBefore = snapshot(before);
    // Every store except the audit log, which records a read as an operation by design.
    const stateBytes = () => Object.fromEntries(fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && f !== 'operations.jsonl')
      .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

    // Every kind of learning record the read can show, all of it in the candidates' own capability.
    await approvedAdaptation(app);
    await rememberWrites(app, 2);
    for (const subject of ['one', 'two', 'three', 'four', 'five']) {
      await app.controller.predictionRecord({ capability: 'memory.add', expectation: 'success', subject, inDays: 3 });
    }

    const after = await run(app, 'plan.candidates', { goal: goalId }, 'op-al09-full');
    assert.equal(after.outcome, Outcome.SUCCESS_VERIFIED, after.summary);
    assert.ok(dataOf(after).learning.recordsRead > 0, 'the read now has records to disclose');
    assert.equal(snapshot(after), bytesBefore, 'the comparison is byte for byte what it was before any learning record existed');
    assert.deepEqual(dataOf(after).comparison.gates, dataOf(before).comparison.gates);
    assert.deepEqual(dataOf(after).comparison.rankedDimensions, dataOf(before).comparison.rankedDimensions);
    // A read that reads only is a read: the record stores either side of it are the same bytes, so
    // disclosing these records recorded nothing on the user's behalf. The audit log still grows,
    // because a read is an operation and is audited as one.
    assert.equal(dataOf(after).recorded, false);
    assert.equal(dataOf(after).approved, false);
    assert.equal(dataOf(after).executable, false);
    assert.equal(dataOf(after).learning.authorizes, false);
    assert.equal(dataOf(after).learning.influencesSelection, false);
    const justBefore = stateBytes();
    const during = await run(app, 'plan.candidates', { goal: goalId }, 'op-al09-readonly');
    assert.equal(during.outcome, Outcome.SUCCESS_VERIFIED, during.summary);
    assert.deepEqual(stateBytes(), justBefore, 'a learning disclosure wrote to a record store');
  } finally {
    cleanup(dir);
  }
});

test('the digest of the read is stable across answers and moves when a record moves', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    await approvedAdaptation(app);
    const a = await run(app, 'plan.candidates', { goal: goalId }, 'op-al09-d1');
    const b = await run(app, 'plan.candidates', { goal: goalId }, 'op-al09-d2');
    assert.equal(learningDigest(dataOf(a).learning), learningDigest(dataOf(b).learning), 'two reads of the same records must agree');

    // A re-worded record cannot move the digest, because the digest is built from ids, capabilities,
    // statuses, horizons, verdicts and counts - never from a rule's or a summary's prose. A record that
    // actually moved must.
    const sameRecords = structuredClone(dataOf(a).learning);
    sameRecords.adaptations.rows[0].rule = 'a different wording of the same approval';
    sameRecords.adaptations.rows[0].decisionReason = 'phrased another way';
    assert.equal(learningDigest(sameRecords), learningDigest(dataOf(a).learning), 'a verification difference must mean a record moved, not that prose changed');
    const movedSupport = structuredClone(dataOf(a).learning);
    movedSupport.adaptations.rows[0].supportCount += 1;
    assert.notEqual(learningDigest(movedSupport), learningDigest(dataOf(a).learning));
    assert.equal(learningDigest(null), null);

    await app.controller.predictionRecord({ capability: 'memory.add', expectation: 'failure', subject: 'a write is refused', inDays: 1 });
    const c = await run(app, 'plan.candidates', { goal: goalId }, 'op-al09-d3');
    assert.notEqual(learningDigest(dataOf(c).learning), learningDigest(dataOf(a).learning));
  } finally {
    cleanup(dir);
  }
});

test('plan.outcome excludes the plan it is answering; plan.replan keeps that plan as the signal', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    const add = await app.controller.planAdd({
      goal: goalId,
      outcome: 'remember the release date',
      steps: [{
        id: 's1', description: 'remember the date', action: 'memory.add',
        input: { content: 'the launch date is 2026-12-15' },
        expectedResult: 'one memory record', verification: 'a memory search finds the launch date', risk: 'medium',
      }],
      assertions: [{ kind: 'user_fact', text: 'the goal asks for: remember the release date' }],
    });
    assert.equal(add.status, Outcome.PLAN_STORED, add.output);
    const planId = dOf(add).planId;
    await app.controller.planApprove({ target: planId });
    const activated = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(activated.status, Outcome.SUCCESS_VERIFIED, activated.output);

    const out = await run(app, 'plan.outcome', { plan: planId }, 'op-al09-out');
    assert.equal(out.outcome, Outcome.SUCCESS_VERIFIED, out.summary);
    assert.equal(dataOf(out).recordable, true, dataOf(out).unrecordableReason);
    const verdict = dataOf(out).verdict;
    assert.ok(verdict, JSON.stringify(dataOf(out)));
    const assessed = await run(app, 'plan.assess', { target: planId }, 'op-al09-assess');
    assert.equal(assessed.outcome, Outcome.SUCCESS_VERIFIED, assessed.summary);

    // The plan's own assessment is not an "earlier attempt": a read about this plan does not cite itself.
    const outAgain = await run(app, 'plan.outcome', { plan: planId }, 'op-al09-out2');
    assert.equal(outAgain.outcome, Outcome.SUCCESS_VERIFIED, outAgain.summary);
    const learning = dataOf(outAgain).learning;
    assert.deepEqual((learning.assessments.rows ?? []).filter((r) => r.planId === planId), [], JSON.stringify(learning.assessments));
    assert.equal(learning.assessments.plansRead, 0, 'this plan is the only one recorded for the goal, and it is the one excluded');
    assert.equal(learning.recordsRead, 0, 'so the read has nothing in scope, and says which absence is which');
    const absence = learningStatements(learning).map((s) => s.text);
    assert.ok(absence.some((s) => /^no other plan for this goal carries a recorded outcome assessment\.$/.test(s)), absence.join(' | '));

    // A revision answers the question "should this plan be replaced", so the plan's own outcome reading
    // is exactly the evidence in scope, and the read keeps it.
    const re = await run(app, 'plan.replan', { plan: planId, reason: 'the criterion is still not satisfied' }, 'op-al09-replan');
    assert.equal(re.outcome, Outcome.SUCCESS_VERIFIED, re.summary);
    const rows = dataOf(re).learning.assessments.rows ?? [];
    const mine = rows.find((r) => r.planId === planId);
    assert.ok(mine, JSON.stringify(rows));
    assert.equal(mine.verdict, verdict);
    assert.equal(mine.stale, false, 'the plan content has not moved since the assessment');
    assert.ok(mine.findings > 0 && mine.operations.length > 0, JSON.stringify(mine));
    const line = learningStatements(dataOf(re).learning).find(expectation(ClaimKind.FACT, 'an earlier attempt at this goal was assessed'));
    assert.ok(line, JSON.stringify(learningStatements(dataOf(re).learning).map((s) => s.text)));
    assert.match(line.text, new RegExp(`citing ${mine.findings} finding\\(s\\)`));
    assert.match(line.text, /\[operation\(s\) [0-9a-f]{8}\]/);
    assert.equal(line.kind, ClaimKind.FACT, 'a recorded assessment is a fact about the records');
  } finally {
    cleanup(dir);
  }
});

test('an unassessed plan gets a read too, and an empty one leads with its own absences', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    // Records exist, but none of them is about the capability this plan's steps name.
    await approvedAdaptation(app);
    await app.controller.predictionRecord({ capability: 'filesystem.list', expectation: 'success', subject: 'an unrelated capability', inDays: 3 });
    const add = await app.controller.planAdd({
      goal: goalId,
      outcome: 'remember the release date by searching first',
      steps: [{
        id: 's1', description: 'search memory', action: 'memory.search', input: { query: 'release date' },
        expectedResult: 'a hit', verification: 'the search returns a record', risk: 'low',
      }],
      assertions: [{ kind: 'user_fact', text: 'the goal asks for: remember the release date' }],
    });
    assert.equal(add.status, Outcome.PLAN_STORED, add.output);
    const planId = dOf(add).planId;

    const step = await run(app, 'plan.outcome', { plan: planId }, 'op-al09-unrun');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
    const learning = dataOf(step).learning;
    assert.deepEqual(learning.scope.capabilities, ['memory.search']);
    assert.equal(learning.recordsRead, 0);
    const statements = learningStatements(learning).map((s) => s.text);
    assert.match(statements[0], /^1 adaptation\(s\) the user approved are recorded, none in the capabilities these steps name\.$/);
    assert.match(statements[1], /^1 expectation\(s\) are recorded, none scoped to the capabilities these steps name\.$/);
    assert.ok(!statements.some((s) => s.startsWith('the expectation ledger as read:')), statements.join(' | '));
    assert.equal(learningAbsence(learning), statements.map((s) => s.replace(/\.$/, '')).join('; '));
    // Nothing is guessed: no verdict appears for a plan with no execution outcome.
    assert.equal(dataOf(step).verdict ?? null, null, JSON.stringify(dataOf(step)));
  } finally {
    cleanup(dir);
  }
});

// ---- the executive answer ----------------------------------------------------
test('the executive answer prints the block inside its own budget and points at the rest', async () => {
  const dir = makeTempDataDir();
  try {
    const t = clock();
    const app = await appIn(dir, t);
    const goalId = await newGoal(app);
    await approvedAdaptation(app);
    await rememberWrites(app, 2);
    for (const subject of ['one', 'two', 'three', 'four']) {
      await app.controller.predictionRecord({ capability: 'memory.add', expectation: 'success', subject, inDays: 3 });
    }
    const step = await run(app, 'plan.candidates', { goal: goalId }, 'op-al09-view');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
    const learning = dataOf(step).learning;
    const all = learningStatements(learning);
    assert.ok(all.length > LEARNING_BOUNDS.answerStatements, `${all.length} statements, the cap is ${LEARNING_BOUNDS.answerStatements}`);

    const goal = await app.goals.get(goalId);
    const view = describePlanOptions({ goal, data: dataOf(step), operationId: 'op-al09-view' });
    assert.ok(view.lines.length <= BOUNDS.maxStatusLines, `${view.lines.length} lines against a budget of ${BOUNDS.maxStatusLines}`);
    assert.equal(view.truncated, false, view.lines.join('\n'));
    const printed = view.lines.filter((l) => /an expectation the user recorded|an adaptation the user approved|this learning read is scoped/.test(l));
    assert.equal(printed.length, LEARNING_BOUNDS.answerStatements, printed.join('\n'));
    const pointer = view.lines.find((l) => l.includes('more statement(s) from the same read'));
    assert.ok(pointer, view.lines.join('\n'));
    assert.match(pointer, /the command's own print shows them with the five separations/);
    const text = view.lines.join('\n');
    assert.match(text, new RegExp(LEARNING_NOT_APPLIED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // The view is bounded on characters as well as lines, and a long answer reaches the character bound
    // while it still has lines left. The block gives way inside itself rather than printing a disclaimer
    // the cut clips mid-sentence, so what reaches the screen is complete or it is not there.
    assert.ok(!view.display.includes('cut at'), `the printed answer gave way: ${view.display.slice(-240)}`);
    assert.ok(view.display.includes(LEARNING_NOT_APPLIED), 'the printed answer lost its disclaimer');
    // The marks the reader needs to keep the records apart are the claim kinds, printed as such.
    assert.ok(Object.keys(view.kinds).includes(ClaimKind.PREDICTION), JSON.stringify(view.kinds));
    assert.equal(view.kinds[ClaimKind.VERIFIED_OUTCOME], undefined, 'a learning record is never reported as a verified outcome');

    // The outcome answer carries the same block under the same budget. A plan with no execution outcome
    // still gets its records disclosed, and nothing is pushed off the end of the answer.
    const add = await app.controller.planAdd({
      goal: goalId,
      outcome: 'remember the release date',
      steps: [{
        id: 's1', description: 'remember the date', action: 'memory.add',
        input: { content: 'the launch date is 2026-12-15' },
        expectedResult: 'one memory record', verification: 'a memory search finds the launch date', risk: 'medium',
      }],
      assertions: [{ kind: 'user_fact', text: 'the goal asks for: remember the release date' }],
    });
    assert.equal(add.status, Outcome.PLAN_STORED, add.output);
    const outStep = await run(app, 'plan.outcome', { plan: dOf(add).planId }, 'op-al09-out-view');
    assert.equal(outStep.outcome, Outcome.SUCCESS_VERIFIED, outStep.summary);
    const outcome = describePlanOutcome({ data: dataOf(outStep), operationId: 'op-al09-out-view' });
    assert.ok(outcome.lines.length <= BOUNDS.maxStatusLines, `${outcome.lines.length} lines against a budget of ${BOUNDS.maxStatusLines}`);
    assert.equal(outcome.truncated, false, outcome.lines.join('\n'));
    assert.ok(outcome.lines.some((l) => l.includes('What the records of past attempts about memory.add')), outcome.lines.join('\n'));
    assert.ok(Object.keys(outcome.kinds).includes(ClaimKind.PREDICTION), JSON.stringify(outcome.kinds));
  } finally {
    cleanup(dir);
  }
});
