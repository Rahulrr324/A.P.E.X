// Goal system: the append-only lifecycle, its history, and the evidence rules that keep a
// goal from being completed by assertion. Everything here goes through the real controller and
// action registry against a temporary data directory; nothing is committed and no model is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { makeTempDataDir, cleanup } from './helpers.js';

async function appIn(dir) {
  return createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF });
}

function goalIdOf(res) {
  return res.operation.steps[0].result.data.goalId;
}

async function verifiedOperation(app, key) {
  const res = await app.controller.knowledgeAdd({
    subject: `goal evidence ${key}`,
    relationship: 'was checked by',
    object: `the goal-system test ${key}`,
  });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, 'the supporting operation must itself be a verified success');
  return res.operation.id;
}

test('goal lifecycle records every transition and refuses an illegal one', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const created = await app.controller.goalAdd({
      request: 'the index stops returning the stale claim',
      criteria: ['the stale claim is retracted', 'a search for the term returns the corrected claim'],
      priority: 2,
      deadline: '2026-12-31T00:00:00.000Z',
    });
    assert.equal(created.status, Outcome.GOAL_CREATED);
    const id = goalIdOf(created);

    const accepted = await app.controller.goalUpdate({ target: id, status: 'accepted' });
    assert.equal(accepted.status, Outcome.GOAL_UPDATED);
    const active = await app.controller.goalUpdate({ target: id, status: 'active' });
    assert.equal(active.status, Outcome.GOAL_UPDATED);

    // A goal cannot be completed on the strength of having been started.
    const early = await app.controller.goalComplete({ target: id });
    assert.equal(early.status, Outcome.EXECUTION_FAILED);
    assert.match(early.output, /goal cannot be completed/);
    assert.match(early.output, /c1 is pending/);

    const op1 = await verifiedOperation(app, 'one');
    const op2 = await verifiedOperation(app, 'two');
    for (const [criterion, operationId] of [['c1', op1], ['c2', op2]]) {
      const evidence = await app.controller.goalEvidence({ target: id, criterion, kind: 'supports', operationId });
      assert.equal(evidence.status, Outcome.GOAL_UPDATED);
    }

    const completed = await app.controller.goalComplete({ target: id });
    assert.equal(completed.status, Outcome.GOAL_COMPLETED);
    const { goal } = await app.controller.showGoal(id);
    assert.equal(goal.status, 'completed');
    assert.equal(goal.origin, 'user');
    assert.deepEqual(goal.criteria.map((c) => c.status), ['satisfied', 'satisfied']);
    assert.equal(goal.completion.criteria.length, 2);
    assert.deepEqual(
      goal.statusHistory.map((h) => [h.from, h.to]),
      [[null, 'proposed'], ['proposed', 'accepted'], ['accepted', 'active'], ['active', 'completed']],
    );
    assert.equal(goal.statusHistory[0].reason, 'recorded by the user');

    // The history is append-only: a later illegal move is refused and adds nothing.
    const illegal = await app.controller.goalUpdate({ target: id, status: 'active' });
    assert.equal(illegal.status, Outcome.EXECUTION_FAILED);
    assert.match(illegal.output, /illegal goal transition/);
    const after = await app.controller.showGoal(id);
    assert.equal(after.goal.statusHistory.length, 4);
  } finally {
    cleanup(dir);
  }
});

test('duplicate open goals are detected by normalized request, not by exact text', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const first = await app.controller.goalAdd({
      request: 'Ship the corrected memory index',
      criteria: ['the corrected claim is stored'],
    });
    assert.equal(first.status, Outcome.GOAL_CREATED);
    const duplicate = await app.controller.goalAdd({
      request: '  ship   the corrected MEMORY index!  ',
      criteria: ['a different criterion'],
    });
    assert.equal(duplicate.status, Outcome.EXECUTION_FAILED);
    assert.match(duplicate.output, /refused: an open goal already records this request/);

    // Case and punctuation are presentation: a genuinely different request is not blocked.
    const other = await app.controller.goalAdd({
      request: 'Ship the corrected knowledge index',
      criteria: ['the corrected claim is stored'],
    });
    assert.equal(other.status, Outcome.GOAL_CREATED);
    const list = await app.controller.listGoals();
    assert.match(list, /Ship the corrected knowledge index/);
    assert.match(list, /Ship the corrected memory index/);
  } finally {
    cleanup(dir);
  }
});

test('goal dependencies must exist and must be completed before the dependent goal starts', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const unknown = await app.controller.goalAdd({
      request: 'a goal with an unknown dependency',
      criteria: ['anything'],
      dependsOn: ['no-such-goal'],
    });
    assert.equal(unknown.status, Outcome.EXECUTION_FAILED);
    assert.match(unknown.output, /refused: unknown dependency goal/);

    const dependency = await app.controller.goalAdd({
      request: 'the prerequisite correction is recorded',
      criteria: ['the prerequisite operation verified'],
    });
    const dependencyId = goalIdOf(dependency);

    const dependent = await app.controller.goalAdd({
      request: 'the follow-up correction is recorded',
      criteria: ['the follow-up operation verified'],
      dependsOn: [dependencyId],
    });
    assert.equal(dependent.status, Outcome.GOAL_CREATED);
    const dependentId = goalIdOf(dependent);

    const tooSoon = await app.controller.goalUpdate({ target: dependentId, status: 'accepted' });
    assert.equal(tooSoon.status, Outcome.GOAL_UPDATED);
    // accepted is allowed; active is what requires the dependency to be completed.
    const blockedByDependency = await app.controller.goalUpdate({ target: dependentId, status: 'active' });
    assert.equal(blockedByDependency.status, Outcome.EXECUTION_FAILED);
    assert.match(blockedByDependency.output, /is proposed, not completed/);

    await app.controller.goalUpdate({ target: dependencyId, status: 'accepted' });
    await app.controller.goalUpdate({ target: dependencyId, status: 'active' });
    const op = await verifiedOperation(app, 'dependency');
    await app.controller.goalEvidence({ target: dependencyId, criterion: 'c1', kind: 'supports', operationId: op });
    const done = await app.controller.goalComplete({ target: dependencyId });
    assert.equal(done.status, Outcome.GOAL_COMPLETED);

    const nowAllowed = await app.controller.goalUpdate({ target: dependentId, status: 'active' });
    assert.equal(nowAllowed.status, Outcome.GOAL_UPDATED);
    const { goal } = await app.controller.showGoal(dependentId);
    assert.equal(goal.status, 'active');
    assert.deepEqual(goal.dependsOn, [dependencyId]);
  } finally {
    cleanup(dir);
  }
});

test('supporting evidence must cite a verified audit operation', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const created = await app.controller.goalAdd({ request: 'evidence is required', criteria: ['the check passes'] });
    const id = goalIdOf(created);
    await app.controller.goalUpdate({ target: id, status: 'accepted' });
    await app.controller.goalUpdate({ target: id, status: 'active' });

    const missing = await app.controller.goalEvidence({
      target: id,
      criterion: 'c1',
      kind: 'supports',
      operationId: 'no-such-operation',
    });
    assert.equal(missing.status, Outcome.EXECUTION_FAILED);
    assert.match(missing.output, /no operation record/);

    // An input that was refused still has an audit record; it ended as input_rejected and
    // therefore cannot support a completion claim.
    const refusedOp = await app.controller.goalAdd({ request: 'x', criteria: [] });
    assert.equal(refusedOp.status, Outcome.INPUT_REJECTED);
    const rejectedEvidence = await app.controller.goalEvidence({
      target: id,
      criterion: 'c1',
      kind: 'supports',
      operationId: refusedOp.operation.id,
    });
    assert.equal(rejectedEvidence.status, Outcome.EXECUTION_FAILED);
    assert.match(rejectedEvidence.output, /cannot support a completed goal/);

    const { goal } = await app.controller.showGoal(id);
    assert.equal(goal.criteria[0].status, 'pending');
    assert.equal(goal.criteria[0].evidence.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('contradicting evidence reopens a completed goal only when reopen is stated, and preserves history', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const created = await app.controller.goalAdd({ request: 'a checkable claim', criteria: ['the claim holds'] });
    const id = goalIdOf(created);
    await app.controller.goalUpdate({ target: id, status: 'accepted' });
    await app.controller.goalUpdate({ target: id, status: 'active' });
    const firstOp = await verifiedOperation(app, 'first');
    await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'supports', operationId: firstOp });
    const completed = await app.controller.goalComplete({ target: id });
    assert.equal(completed.status, Outcome.GOAL_COMPLETED);

    // Contradicting a completed goal without `reopen` is refused; nothing changes.
    const silent = await app.controller.goalEvidence({
      target: id,
      criterion: 'c1',
      kind: 'contradicts',
      detail: 'a later check disagreed',
    });
    assert.equal(silent.status, Outcome.EXECUTION_FAILED);
    assert.match(silent.output, /must state reopen/);

    const reopened = await app.controller.goalEvidence({
      target: id,
      criterion: 'c1',
      kind: 'contradicts',
      detail: 'a later check disagreed',
      reopen: true,
    });
    assert.equal(reopened.status, Outcome.GOAL_UPDATED);
    const { goal } = await app.controller.showGoal(id);
    assert.equal(goal.status, 'blocked');
    assert.equal(goal.completion, null);
    assert.equal(goal.criteria[0].status, 'contradicted');
    assert.equal(goal.contradiction.detail, 'a later check disagreed');
    const reopenedEntry = goal.statusHistory.at(-1);
    assert.equal(reopenedEntry.from, 'completed');
    assert.equal(reopenedEntry.to, 'blocked');
    assert.equal(reopenedEntry.reason, 'contradicting evidence reopened the goal');
    // The earlier completion record is not rewritten: the history keeps all five entries.
    assert.equal(goal.statusHistory.length, 5);

    // New supporting evidence restores the criterion; the goal can be completed again.
    const secondOp = await verifiedOperation(app, 'second');
    const restored = await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'supports', operationId: secondOp });
    assert.equal(restored.status, Outcome.GOAL_UPDATED);
    const again = await app.controller.goalComplete({ target: id });
    assert.equal(again.status, Outcome.GOAL_COMPLETED);
    const final = await app.controller.showGoal(id);
    assert.equal(final.goal.contradiction, null);
    assert.equal(final.goal.statusHistory.length, 6);
    assert.equal(final.goal.criteria[0].evidence.length, 3);
  } finally {
    cleanup(dir);
  }
});

test('stopping states need a recorded reason, and a superseded goal must name a live replacement', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const first = await app.controller.goalAdd({ request: 'the first intention', criteria: ['something'] });
    const firstId = goalIdOf(first);
    const noReason = await app.controller.goalUpdate({ target: firstId, status: 'cancelled' });
    assert.equal(noReason.status, Outcome.EXECUTION_FAILED);
    assert.match(noReason.output, /needs a recorded reason/);

    const replacement = await app.controller.goalAdd({ request: 'the replacement intention', criteria: ['something else'] });
    const replacementId = goalIdOf(replacement);
    const superseded = await app.controller.goalUpdate({
      target: firstId,
      status: 'superseded',
      reason: 'a better-scoped intention replaced it',
      by: replacementId,
    });
    assert.equal(superseded.status, Outcome.GOAL_UPDATED);
    const { goal } = await app.controller.showGoal(firstId);
    assert.equal(goal.status, 'superseded');
    assert.equal(goal.supersededBy, replacementId);
    assert.equal(goal.statusHistory.at(-1).reason, 'a better-scoped intention replaced it');

    // A terminal goal accepts no further evidence or links.
    const evidence = await app.controller.goalEvidence({ target: firstId, criterion: 'c1', kind: 'contradicts' });
    assert.equal(evidence.status, Outcome.EXECUTION_FAILED);
    assert.match(evidence.output, /no further evidence is accepted/);
  } finally {
    cleanup(dir);
  }
});

test('a model origin cannot create or alter a goal, and authorization is decided before execution', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    assert.equal(app.registry.authorize('goal.add', 'model').decision, 'deny');
    assert.equal(app.registry.authorize('goal.update', 'model').decision, 'deny');
    assert.equal(app.registry.authorize('goal.complete', 'model').decision, 'deny');
    assert.equal(app.registry.authorize('goal.add', 'user').decision, 'allow');

    const denied = await app.controller.runAction('goal.add', {
      request: 'a model-origin goal',
      criteria: ['the model authorized itself'],
    }, 'model', 'model-op');
    assert.equal(denied.outcome, Outcome.ACTION_DENIED);
    assert.match(denied.summary, /denied/);
    const { goals, events } = await app.goals.load();
    assert.equal(goals.size, 0);
    assert.equal(events, 0);
  } finally {
    cleanup(dir);
  }
});

test('credential-shaped goal text is refused and never stored', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const refused = await app.controller.goalAdd({
      request: 'rotate the deploy password: hunter2secret',
      criteria: ['the rotation is verified'],
    });
    assert.equal(refused.status, Outcome.INPUT_REJECTED);
    assert.match(refused.output, /password|key|token/i);
    const state = await app.goals.inspect();
    assert.equal(state.events, 0);
    assert.equal(state.goals.length, 0);
    assert.equal(state.corrupt.length, 0);
    const file = path.join(dir, 'goals.jsonl');
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '', '');
  } finally {
    cleanup(dir);
  }
});

test('a damaged goal log is never presented as an empty or extended lifecycle', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const created = await app.controller.goalAdd({ request: 'the surviving goal', criteria: ['it is recorded'] });
    assert.equal(created.status, Outcome.GOAL_CREATED);
    const file = path.join(dir, 'goals.jsonl');
    const intact = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, '{"schema":1,"eventId":"torn"\n');

    await assert.rejects(() => app.goals.list(), /corrupt|refusing incomplete/);
    await assert.rejects(() => app.controller.listGoals(), /corrupt|refusing incomplete/);

    const inspect = await app.goals.inspect();
    assert.equal(inspect.corrupt.length, 1);
    assert.equal(inspect.goals.length, 1);
    assert.equal(inspect.goals[0].request, 'the surviving goal');

    // A writer refuses to extend a log whose state cannot be trusted as a base.
    const extended = await app.controller.goalAdd({ request: 'a goal that must not be appended', criteria: ['x'] });
    assert.notEqual(extended.status, Outcome.GOAL_CREATED);
    assert.equal(fs.readFileSync(file, 'utf8'), `${intact}{"schema":1,"eventId":"torn"\n`);
  } finally {
    cleanup(dir);
  }
});

test('goal records are append-only: earlier bytes survive every later transition', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const created = await app.controller.goalAdd({ request: 'append-only goal', criteria: ['one criterion'] });
    const id = goalIdOf(created);
    const file = path.join(dir, 'goals.jsonl');
    const firstBytes = fs.readFileSync(file, 'utf8');
    await app.controller.goalUpdate({ target: id, status: 'accepted' });
    const secondBytes = fs.readFileSync(file, 'utf8');
    assert.ok(secondBytes.startsWith(firstBytes));
    assert.ok(secondBytes.length > firstBytes.length);
    await app.controller.goalUpdate({ target: id, status: 'cancelled', reason: 'no longer wanted' });
    const thirdBytes = fs.readFileSync(file, 'utf8');
    assert.ok(thirdBytes.startsWith(secondBytes));
    const { events } = await app.goals.load();
    assert.equal(events, 3);
  } finally {
    cleanup(dir);
  }
});
