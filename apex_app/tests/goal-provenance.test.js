// Goal provenance: who put each part of a goal there, and what that makes it count for.
//
// These tests go through the real controller and the real append-only stores against a temporary
// data directory. They cover the rules Batch AL work package B exists to enforce: a criterion APEX
// inferred is a suggestion until the user decides it, a criterion the user stated cannot be quietly
// taken out, the goal-level decomposition round-trips with its source, and a goal log written
// before any of this existed still replays as it meant then. No model is used and nothing is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { makeTempDataDir, cleanup, cleanEnv, runCli } from './helpers.js';

async function appIn(dir) {
  return createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF });
}

function goalIdOf(res) {
  return res.operation.steps[0].result.data.goalId;
}

// The text the user would see for this operation. The audit record keeps only the one-line summary
// (the step's display body is stripped before it is appended), so the disclosure lines are read
// from the operation result the CLI would print.
function display(res) {
  return res.display;
}

async function verifiedOperation(app, key) {
  const res = await app.controller.knowledgeAdd({
    subject: `goal provenance ${key}`,
    relationship: 'was checked by',
    object: `the goal-provenance test ${key}`,
  });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, 'the supporting operation must itself be a verified success');
  return res.operation.id;
}

// A distinct request each time, so no test trips the duplicate-open-goal check by accident.
function request(tag) {
  return `${tag} ${Math.random().toString(36).slice(2, 10)}`;
}

async function activeGoal(app, criteria, tag = 'intention') {
  const created = await app.controller.goalAdd({ request: request(tag), criteria });
  assert.equal(created.status, Outcome.GOAL_CREATED, created.output);
  const id = goalIdOf(created);
  await app.controller.goalUpdate({ target: id, status: 'accepted' });
  await app.controller.goalUpdate({ target: id, status: 'active' });
  return id;
}

test('a criterion APEX inferred is stored as a suggestion and gates nothing until the user decides it', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const created = await app.controller.goalAdd({
      request: 'the stale claim stops winning in search',
      criteria: [
        'the stale claim is retracted',
        {
          description: 'a search for the term returns the corrected claim',
          basis: 'system_inferred',
          requiredEvidence: 'a search result naming the corrected claim',
        },
      ],
    });
    assert.equal(created.status, Outcome.GOAL_CREATED);
    const id = goalIdOf(created);
    // The record says where each criterion came from, and an inference did not arrive as a requirement.
    assert.deepEqual(created.operation.steps[0].result.data.criteria, [
      { id: 'c1', description: 'the stale claim is retracted', basis: 'user_stated', requirement: 'required' },
      { id: 'c2', description: 'a search for the term returns the corrected claim', basis: 'system_inferred', requirement: 'suggested' },
    ]);

    const shown = await app.controller.showGoal(id);
    assert.equal(shown.goal.criteria[1].basis, 'system_inferred');
    assert.equal(shown.goal.criteria[1].confirmation, null, 'nothing has decided the suggestion yet');
    assert.match(shown.display, /from system_inferred, suggested, needs your decision/);
    assert.match(shown.display, /would be proved by: a search result naming the corrected claim/);
    // What gates completion is printed apart from what was written down.
    assert.match(shown.display, /Progress: 0 of 2 criterion\(s\) satisfied, 2 pending; 0 of 1 required for completion/);
    assert.match(shown.display, /Your decision is owed on: c2 - node bin\/apex\.js goal confirm/);

    await app.controller.goalUpdate({ target: id, status: 'accepted' });
    await app.controller.goalUpdate({ target: id, status: 'active' });
    const op = await verifiedOperation(app, 'retraction');
    const evidence = await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'supports', operationId: op });
    assert.equal(evidence.status, Outcome.GOAL_UPDATED);

    // One satisfied requirement is not a completed goal while an inference is still an open question.
    const early = await app.controller.goalComplete({ target: id });
    assert.equal(early.status, Outcome.EXECUTION_FAILED);
    assert.match(early.output, /goal cannot be completed: c2 is recorded as a suggestion with no user decision/);
    assert.match(early.output, /goal confirm [0-9a-f]{8} c2 required\|suggested\|declined --reason <text>/);
    const after = await app.controller.showGoal(id);
    assert.equal(after.goal.status, 'active', 'a refused completion changes nothing');
    assert.equal((await app.goals.inspect()).events, 4, 'the refusal appended no event');
  } finally {
    cleanup(dir);
  }
});

test('recording the decision as required makes the inference gate completion', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const id = await activeGoal(app, [
      'the stale claim is retracted',
      { description: 'a search for the term returns the corrected claim', basis: 'system_inferred' },
    ]);
    const op = await verifiedOperation(app, 'decision');
    const decided = await app.controller.goalConfirm({
      target: id,
      criterion: 'c2',
      decision: 'required',
      reason: 'that search is how I would know the goal was met',
      operationId: op,
    });
    assert.equal(decided.status, Outcome.GOAL_UPDATED, decided.output);
    assert.equal(decided.operation.steps[0].result.data.requirement, 'required');
    assert.match(display(decided), /it now gates completion/);
    assert.match(display(decided), /decision operation:/);

    const { goal, display: text } = await app.controller.showGoal(id);
    assert.equal(goal.criteria[1].requirement, 'required');
    assert.equal(goal.criteria[1].basis, 'system_inferred', 'the decision does not rewrite where the criterion came from');
    assert.equal(goal.criteria[1].confirmation.decision, 'required');
    assert.equal(goal.criteria[1].confirmation.reason, 'that search is how I would know the goal was met');
    assert.equal(goal.criteria[1].confirmation.operationId, op);
    assert.match(text, /your decision: required/);
    assert.doesNotMatch(text, /Your decision is owed on/);
    assert.match(text, /Progress: 0 of 2 criterion\(s\) satisfied, 2 pending/);
    // Both criteria gate now, so what gates completion is the same as what was written down and the
    // renderer says it once instead of printing two matching counts.
    assert.doesNotMatch(text, /required for completion/);

    // Now it gates: the goal cannot complete on c1's evidence alone.
    const op1 = await verifiedOperation(app, 'retraction');
    await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'supports', operationId: op1 });
    const refused = await app.controller.goalComplete({ target: id });
    assert.equal(refused.status, Outcome.EXECUTION_FAILED);
    assert.match(refused.output, /goal cannot be completed: c2 is pending/);

    const op2 = await verifiedOperation(app, 'search');
    await app.controller.goalEvidence({ target: id, criterion: 'c2', kind: 'supports', operationId: op2 });
    const done = await app.controller.goalComplete({ target: id });
    assert.equal(done.status, Outcome.GOAL_COMPLETED, done.output);
    const final = await app.controller.showGoal(id);
    assert.deepEqual(final.goal.completion.criteria.map((c) => c.criterionId), ['c1', 'c2']);
  } finally {
    cleanup(dir);
  }
});

test('declining an inference takes it out of completion and stays on the record', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const id = await activeGoal(app, [
      'the stale claim is retracted',
      { description: 'the correction is also announced in the changelog', basis: 'system_inferred' },
    ]);
    const declined = await app.controller.goalConfirm({
      target: id, criterion: 'c2', decision: 'declined', reason: 'a changelog is not part of what I asked for',
    });
    assert.equal(declined.status, Outcome.GOAL_UPDATED, declined.output);
    assert.match(display(declined), /it no longer counts toward completion/);

    const shown = await app.controller.showGoal(id);
    assert.equal(shown.goal.criteria[1].requirement, 'declined');
    assert.match(shown.display, /Declined by you, so not counted toward completion: c2/);
    assert.doesNotMatch(shown.display, /Your decision is owed on/);

    const op = await verifiedOperation(app, 'retraction');
    await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'supports', operationId: op });
    const done = await app.controller.goalComplete({ target: id });
    assert.equal(done.status, Outcome.GOAL_COMPLETED, done.output);
    assert.match(display(done), /not counted because you declined them: c2/);
    const { goal } = await app.controller.showGoal(id);
    // The completion names only the required criterion; the declined one is recorded as declined,
    // not dropped, so a later reader can see what the completion did not prove.
    assert.deepEqual(goal.completion.criteria.map((c) => c.criterionId), ['c1']);
    assert.deepEqual(goal.completion.declined, ['c2']);

    // Contradicting evidence reopens the goal; the user can then change their mind, and the
    // earlier decision is still in the log.
    await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'contradicts', detail: 'the stale claim returned', reopen: true });
    const reversed = await app.controller.goalConfirm({
      target: id, criterion: 'c2', decision: 'required', reason: 'the changelog turned out to matter',
    });
    assert.equal(reversed.status, Outcome.GOAL_UPDATED, reversed.output);
    assert.match(display(reversed), /it was declined before; the earlier decision stays in the event log/);
    const back = await app.controller.goalUpdate({ target: id, status: 'active' });
    assert.equal(back.status, Outcome.GOAL_UPDATED, back.output);
    const refused = await app.controller.goalComplete({ target: id });
    assert.equal(refused.status, Outcome.EXECUTION_FAILED);
    assert.match(refused.output, /c2 is pending/);
    const bytes = fs.readFileSync(path.join(dir, 'goals.jsonl'), 'utf8').trim().split('\n');
    assert.ok(bytes.some((line) => line.includes('"decision":"declined"')), 'the declined decision is still in the log');
    assert.ok(bytes.some((line) => line.includes('"decision":"required"')), 'and the later decision was appended beside it');
  } finally {
    cleanup(dir);
  }
});

test("a criterion the user stated cannot be declined, and their own suggestion is not an open question", async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const id = await activeGoal(app, ['the correction is stored', 'the correction is read back']);
    const refused = await app.controller.goalConfirm({
      target: id, criterion: 'c1', decision: 'declined', reason: 'I changed my mind about it',
    });
    assert.equal(refused.status, Outcome.EXECUTION_FAILED);
    assert.match(refused.output, /a criterion the user stated cannot be declined; revise the goal to remove it/);
    const { goal } = await app.controller.showGoal(id);
    assert.equal(goal.criteria[0].requirement, 'required', 'the refusal changed nothing');

    // The user may relax their own criterion; that is a recorded decision, not a silent rewrite.
    const relaxed = await app.controller.goalConfirm({
      target: id, criterion: 'c1', decision: 'suggested', reason: 'storing it is enough on its own',
    });
    assert.equal(relaxed.status, Outcome.GOAL_UPDATED, relaxed.output);
    assert.match(display(relaxed), /it stays a suggestion: it does not gate completion/);
    const shown = await app.controller.showGoal(id);
    assert.match(shown.display, /your decision: suggested/);
    assert.doesNotMatch(shown.display, /Your decision is owed on/, 'their own choice is not a question APEX waits on');

    const op = await verifiedOperation(app, 'read-back');
    await app.controller.goalEvidence({ target: id, criterion: 'c2', kind: 'supports', operationId: op });
    const done = await app.controller.goalComplete({ target: id });
    assert.equal(done.status, Outcome.GOAL_COMPLETED, done.output);
    const final = await app.controller.showGoal(id);
    assert.deepEqual(final.goal.completion.criteria.map((c) => c.criterionId), ['c2']);
    assert.deepEqual(final.goal.completion.declined, []);
  } finally {
    cleanup(dir);
  }
});

test('a goal that requires nothing cannot be completed, because a completion would prove nothing', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const id = await activeGoal(app, ['the correction is stored']);
    const op = await verifiedOperation(app, 'stored');
    await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'supports', operationId: op });
    // Satisfied while it is a requirement, so this is the state before the user relaxes it.
    const before = await app.controller.goalComplete({ target: id });
    assert.equal(before.status, Outcome.GOAL_COMPLETED, before.output);

    const second = await activeGoal(app, [{ description: 'the correction is stored', basis: 'user_stated', requirement: 'suggested' }]);
    const refused = await app.controller.goalComplete({ target: second });
    assert.equal(refused.status, Outcome.EXECUTION_FAILED);
    assert.match(refused.output, /no criterion is recorded as required/);
    const shown = await app.controller.showGoal(second);
    assert.match(shown.display, /Progress: 0 of 1 criterion\(s\) satisfied, 1 pending; 0 of 0 required for completion/);
    // Putting it back as a requirement is the way forward, and it is the user's own act.
    const decided = await app.controller.goalConfirm({
      target: second, criterion: 'c1', decision: 'required', reason: 'it is required after all',
    });
    assert.equal(decided.status, Outcome.GOAL_UPDATED, decided.output);
    const op2 = await verifiedOperation(app, 'stored again');
    await app.controller.goalEvidence({ target: second, criterion: 'c1', kind: 'supports', operationId: op2 });
    const done = await app.controller.goalComplete({ target: second });
    assert.equal(done.status, Outcome.GOAL_COMPLETED, done.output);
  } finally {
    cleanup(dir);
  }
});

test('provenance that would smuggle a requirement in is refused and never stored', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const cases = [
      [{ description: 'an inference written as a demand', basis: 'system_inferred', requirement: 'required' }, Outcome.EXECUTION_FAILED, /cannot be recorded as a requirement/],
      [{ description: 'an assumption written as a demand', basis: 'assumption', requirement: 'required' }, Outcome.EXECUTION_FAILED, /cannot be recorded as a requirement/],
      [{ description: 'a declined criterion written into the goal', requirement: 'declined' }, Outcome.EXECUTION_FAILED, /recorded by goal confirm/],
      [{ description: 'a fact as a criterion', basis: 'verified_fact' }, Outcome.EXECUTION_FAILED, /basis must be one of/],
      [{ description: 'a criterion with a caller-chosen id', id: 'c7' }, Outcome.EXECUTION_FAILED, /ids are assigned by position/],
      [{ description: 'a criterion with a loose requirement', requirement: 'mandatory' }, Outcome.EXECUTION_FAILED, /requirement must be required or suggested/],
      [{ description: 'a criterion with an extra field', note: 'whatever' }, Outcome.INPUT_REJECTED, /unexpected field/],
      [{ description: '' }, Outcome.INPUT_REJECTED, /criterion 1 is empty/],
    ];
    for (const [criterion, status, pattern] of cases) {
      const refused = await app.controller.goalAdd({ request: request('refusal probe'), criteria: [criterion] });
      assert.equal(refused.status, status, `${JSON.stringify(criterion)} should be refused`);
      assert.match(refused.output, pattern);
    }
    const state = await app.goals.inspect();
    assert.equal(state.events, 0, 'a refused write appends nothing');
    assert.equal(state.goals.length, 0);

    // An assumption is a legitimate basis, and it arrives as a suggestion like any other inference.
    const created = await app.controller.goalAdd({
      request: 'an assumption offered as a possible criterion',
      criteria: [{ description: 'the index rebuilds overnight', basis: 'assumption' }],
    });
    assert.equal(created.status, Outcome.GOAL_CREATED);
    assert.deepEqual(created.operation.steps[0].result.data.criteria, [
      { id: 'c1', description: 'the index rebuilds overnight', basis: 'assumption', requirement: 'suggested' },
    ]);
    const shown = await app.controller.showGoal(goalIdOf(created));
    assert.match(shown.display, /from assumption, suggested, needs your decision/);
  } finally {
    cleanup(dir);
  }
});

test('the goal decomposition round-trips with its source, and an unstated field stays unstated', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const created = await app.controller.goalAdd({
      request: 'publish the corrected index',
      criteria: ['the corrected index is served'],
      prerequisites: ['the stale claim is retracted'],
      constraints: [{ text: 'no schema migration', basis: 'user_stated' }],
      resources: [{ text: 'the store schema is version 3', basis: 'verified_fact', ref: 'rec-schema-3' }],
      timeConditions: [{ text: 'only outside business hours', basis: 'assumption' }],
      blockers: [],
    });
    assert.equal(created.status, Outcome.GOAL_CREATED, created.output);
    const { goal, display: text } = await app.controller.showGoal(goalIdOf(created));
    assert.deepEqual(goal.prerequisites.map((i) => [i.text, i.basis]), [['the stale claim is retracted', 'user_stated']]);
    assert.deepEqual(goal.constraints, [{ field: 'constraints', text: 'no schema migration', basis: 'user_stated' }]);
    assert.deepEqual(goal.resources, [{ field: 'resources', text: 'the store schema is version 3', basis: 'verified_fact', ref: 'rec-schema-3' }]);
    assert.deepEqual(goal.timeConditions.map((i) => i.basis), ['assumption']);
    assert.deepEqual(goal.blockers, [], 'a stated "none" is kept as none');
    assert.deepEqual(goal.unknowns, [], 'a field nobody mentioned reads back as nothing recorded');

    assert.match(text, /Decomposition \(as recorded, with its source\):/);
    assert.match(text, /- the stale claim is retracted \(user_stated\)/);
    assert.match(text, /- the store schema is version 3 \(verified_fact, from record rec-schema-3\)/);
    assert.match(text, /- only outside business hours \(assumption\)/);
    assert.doesNotMatch(text, /^  blockers:/m, 'an empty field is not printed as a list');

    // What the log holds is the record the user asked for: a field sent empty is present as [], a
    // field never mentioned is absent from the event.
    const event = JSON.parse(fs.readFileSync(path.join(dir, 'goals.jsonl'), 'utf8').split('\n')[0]);
    assert.deepEqual(event.blockers, []);
    assert.equal('unknowns' in event, false);
    assert.equal('prerequisites' in event, true);
  } finally {
    cleanup(dir);
  }
});

test('decomposition input that overreaches is refused and appends nothing', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const nine = Array.from({ length: 9 }, (_, i) => `constraint ${i + 1}`);
    const cases = [
      [{ constraints: nine }, Outcome.INPUT_REJECTED, /constraints may hold at most 8 items/],
      [{ constraints: 'not a list' }, Outcome.INPUT_REJECTED, /constraints must be a list/],
      [{ constraints: [{ text: 'x'.repeat(201) }] }, Outcome.INPUT_REJECTED, /constraints 1 exceeds 200 characters/],
      [{ constraints: [{ text: 'a claim', note: 'x' }] }, Outcome.INPUT_REJECTED, /unexpected field/],
      [{ constraints: [{ text: 'a claim', basis: 'because-i-said-so' }] }, Outcome.EXECUTION_FAILED, /unknown basis/],
      [{ constraints: [{ text: 'a claim', basis: 'verified_fact' }] }, Outcome.EXECUTION_FAILED, /must name the record that verifies it/],
      [{ constraints: [{ text: 'a claim', ref: '' }] }, Outcome.EXECUTION_FAILED, /reference must be between 1 and 64 characters/],
      [{ prerequisites: [{ text: '' }] }, Outcome.INPUT_REJECTED, /prerequisites 1 is empty/],
      [{ unknowns: [{ text: 'rotate the deploy password: hunter2secret' }] }, Outcome.INPUT_REJECTED, /password, key, or token/],
    ];
    for (const [extra, status, pattern] of cases) {
      const refused = await app.controller.goalAdd({ request: request('decomposition probe'), criteria: ['anything'], ...extra });
      assert.equal(refused.status, status, JSON.stringify(extra));
      assert.match(refused.output, pattern);
    }
    const state = await app.goals.inspect();
    assert.equal(state.events, 0, 'nothing was appended by any refusal');
    assert.equal(state.goals.length, 0);

    // Text and object entries describe the same field and both default to the user's own words.
    const created = await app.controller.goalAdd({
      request: 'constraints stated two ways',
      criteria: ['anything'],
      constraints: [{ text: 'a claim' }, 'a claim'],
    });
    assert.equal(created.status, Outcome.GOAL_CREATED, created.output);
    const { goal } = await app.controller.showGoal(goalIdOf(created));
    assert.deepEqual(goal.constraints.map((i) => [i.text, i.basis]), [['a claim', 'user_stated'], ['a claim', 'user_stated']]);
  } finally {
    cleanup(dir);
  }
});

test('a revision replaces only the fields it sends and keeps the rest of the record', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const created = await app.controller.goalAdd({
      request: 'publish the corrected index',
      criteria: ['the corrected index is served'],
      prerequisites: ['the stale claim is retracted'],
      blockers: ['the writer lock is held by another process'],
    });
    const id = goalIdOf(created);
    await app.controller.goalUpdate({ target: id, status: 'accepted' });

    const revised = await app.controller.goalRevise({
      target: id,
      criteria: [{ description: 'a reindex runs without losing the correction', basis: 'system_inferred' }],
      blockers: ['the reindex tool is not installed'],
      reason: 'the criterion changed after the incident review',
    });
    assert.equal(revised.status, Outcome.GOAL_UPDATED, revised.output);
    assert.match(display(revised), /blockers: 1 recorded item\(s\)/);
    const { goal, display: text } = await app.controller.showGoal(id);
    assert.equal(goal.revision, 2);
    assert.deepEqual(goal.prerequisites.map((i) => i.text), ['the stale claim is retracted'], 'a field the revision did not mention keeps its record');
    assert.deepEqual(goal.blockers.map((i) => i.text), ['the reindex tool is not installed']);
    assert.match(text, /- the reindex tool is not installed \(user_stated\)/);
    // The replaced criteria are the new ones, with their own provenance, and pending.
    assert.deepEqual(goal.criteria.map((c) => [c.id, c.basis, c.requirement, c.status]), [['c1', 'system_inferred', 'suggested', 'pending']]);

    // Clearing a field is a statement; a field not sent is not.
    const cleared = await app.controller.goalRevise({
      target: id, criteria: ['the corrected index is served'], blockers: [], reason: 'the tool is installed now',
    });
    assert.equal(cleared.status, Outcome.GOAL_UPDATED, cleared.output);
    const after = await app.controller.showGoal(id);
    assert.deepEqual(after.goal.blockers, []);
    assert.deepEqual(after.goal.prerequisites.map((i) => i.text), ['the stale claim is retracted']);
    assert.equal(after.goal.revision, 3);
  } finally {
    cleanup(dir);
  }
});

test('a criterion decision is bounded: open goals only, known criteria, one decision per direction, a real operation', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const id = await activeGoal(app, [
      'the stale claim is retracted',
      { description: 'the correction is announced', basis: 'system_inferred' },
    ]);

    const unknown = await app.controller.goalConfirm({ target: id, criterion: 'c9', decision: 'required', reason: 'a probe' });
    assert.equal(unknown.status, Outcome.EXECUTION_FAILED);
    assert.match(unknown.output, /no success criterion c9 in this goal/);

    const badId = await app.controller.goalConfirm({ target: id, criterion: 'not-an-id', decision: 'required', reason: 'a probe' });
    assert.equal(badId.status, Outcome.INPUT_REJECTED);
    assert.match(badId.output, /criterion must be an id such as c1/);

    const badDecision = await app.controller.goalConfirm({ target: id, criterion: 'c2', decision: 'mandatory', reason: 'a probe' });
    assert.equal(badDecision.status, Outcome.INPUT_REJECTED);
    assert.match(badDecision.output, /decision must be one of/);

    const noReason = await app.controller.goalConfirm({ target: id, criterion: 'c2', decision: 'required', reason: '  ' });
    assert.equal(noReason.status, Outcome.INPUT_REJECTED);
    assert.match(noReason.output, /reason is empty/);

    const secret = await app.controller.goalConfirm({
      target: id, criterion: 'c2', decision: 'required', reason: 'the deploy password: hunter2secret explains it',
    });
    assert.equal(secret.status, Outcome.INPUT_REJECTED);
    assert.match(secret.output, /password, key, or token/);

    const dangling = await app.controller.goalConfirm({
      target: id, criterion: 'c2', decision: 'required', reason: 'a probe', operationId: 'no-such-operation',
    });
    assert.equal(dangling.status, Outcome.EXECUTION_FAILED);
    assert.match(dangling.output, /no operation record .* exists in the audit log/);

    const decided = await app.controller.goalConfirm({ target: id, criterion: 'c2', decision: 'required', reason: 'it is part of what I asked for' });
    assert.equal(decided.status, Outcome.GOAL_UPDATED, decided.output);
    const repeated = await app.controller.goalConfirm({ target: id, criterion: 'c2', decision: 'required', reason: 'again for good measure' });
    assert.equal(repeated.status, Outcome.EXECUTION_FAILED);
    assert.match(repeated.output, /this decision is already recorded for the criterion/);

    // A terminal goal accepts no decision about what it requires.
    const closed = await app.controller.goalUpdate({ target: id, status: 'cancelled', reason: 'dropped for this test' });
    assert.equal(closed.status, Outcome.GOAL_UPDATED, closed.output);
    const tooLate = await app.controller.goalConfirm({ target: id, criterion: 'c2', decision: 'declined', reason: 'after the fact' });
    assert.equal(tooLate.status, Outcome.EXECUTION_FAILED);
    assert.match(tooLate.output, /a criterion decision is accepted only while it is open/);
    const { goal } = await app.controller.showGoal(id);
    assert.equal(goal.criteria[1].requirement, 'required', 'the refused writes left the record alone');
  } finally {
    cleanup(dir);
  }
});

test('a goal log written before provenance existed replays unchanged and stays append-only', async () => {
  const dir = makeTempDataDir();
  const file = path.join(dir, 'goals.jsonl');
  const legacy = {
    schema: 1,
    eventId: 'legacy-1',
    type: 'goal_created',
    goalId: 'legacy-goal-0001',
    at: '2026-01-01T00:00:00.000Z',
    origin: 'user',
    request: 'the intention recorded last year',
    criteria: [{ id: 'c1', description: 'what the user asked for then' }],
    priority: 3,
    deadline: null,
    dependsOn: [],
    reason: 'recorded by the user',
  };
  fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`);
  try {
    const app = await appIn(dir);
    const { goal, display: text } = await app.controller.showGoal('legacy-goal-0001');
    // An absent basis is the user's own words, and an absent requirement gates as it always did.
    assert.equal(goal.criteria[0].basis, 'user_stated');
    assert.equal(goal.criteria[0].requirement, 'required');
    assert.deepEqual(goal.criteria[0].evidence, []);
    for (const field of ['prerequisites', 'constraints', 'resources', 'timeConditions', 'blockers', 'unknowns']) {
      assert.deepEqual(goal[field], [], `${field} reads back as nothing recorded`);
    }
    assert.match(text, /Progress: 0 of 1 criterion\(s\) satisfied, 1 pending/);
    assert.doesNotMatch(text, /required for completion/, 'the counts agree, so the new clause is not printed');
    assert.doesNotMatch(text, /Decomposition/, 'a goal with no decomposition records is rendered as it was');

    await app.controller.goalUpdate({ target: 'legacy-goal-0001', status: 'accepted' });
    await app.controller.goalUpdate({ target: 'legacy-goal-0001', status: 'active' });
    const op = await verifiedOperation(app, 'legacy');
    await app.controller.goalEvidence({ target: 'legacy-goal-0001', criterion: 'c1', kind: 'supports', operationId: op });
    const done = await app.controller.goalComplete({ target: 'legacy-goal-0001' });
    assert.equal(done.status, Outcome.GOAL_COMPLETED, done.output);

    const before = fs.readFileSync(file, 'utf8');
    const tooLate = await app.controller.goalConfirm({
      target: 'legacy-goal-0001', criterion: 'c1', decision: 'suggested', reason: 'it was not required after all',
    });
    assert.equal(tooLate.status, Outcome.EXECUTION_FAILED, 'a completed goal is reopened by evidence, not by redefining it');
    assert.match(tooLate.output, /a criterion decision is accepted only while it is open/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the refusal appended nothing');

    await app.controller.goalEvidence({ target: 'legacy-goal-0001', criterion: 'c1', kind: 'contradicts', detail: 'it was wrong after all', reopen: true });
    const decided = await app.controller.goalConfirm({
      target: 'legacy-goal-0001', criterion: 'c1', decision: 'suggested', reason: 'it was not required after all',
    });
    assert.equal(decided.status, Outcome.GOAL_UPDATED, decided.output);
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.startsWith(before), 'the earlier records are untouched');
    assert.equal(after.trim().split('\n').length, 7);
    assert.equal(JSON.parse(after.trim().split('\n')[0]).criteria[0].description, 'what the user asked for then');
  } finally {
    cleanup(dir);
  }
});

test('goal.confirm is a user command: it cannot be planned and a model origin is refused before execution', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const action = app.registry.get('goal.confirm');
    assert.ok(action, 'goal.confirm is registered');
    assert.equal(action.permission, 'write');
    assert.equal(action.plannable, false);
    assert.equal(app.registry.authorize('goal.confirm', 'model').decision, 'deny');
    assert.equal(app.registry.authorize('goal.confirm', 'user').decision, 'allow');

    const id = await activeGoal(app, [{ description: 'an inference', basis: 'system_inferred' }]);
    const denied = await app.controller.runAction('goal.confirm', {
      target: id, criterion: 'c1', decision: 'required', reason: 'a model decided for the user',
    }, 'model', 'model-op');
    assert.equal(denied.outcome, Outcome.ACTION_DENIED);
    const { goal } = await app.controller.showGoal(id);
    assert.equal(goal.criteria[0].requirement, 'suggested', 'the denial left the criterion a suggestion');
    assert.equal(goal.criteria[0].confirmation, null);
  } finally {
    cleanup(dir);
  }
});

test('goal confirm through the real CLI records the decision and refuses an undeserved completion', async () => {
  const dir = makeTempDataDir();
  const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
  try {
    const add = await runCli([
      'goal', 'add', 'the stale claim stops winning in search',
      '--criterion', 'the stale claim is retracted',
    ], env);
    assert.equal(add.code, 0, add.stdout + add.stderr);
    const goalId = /^Goal ([0-9a-f]{8})/m.exec(add.stdout)?.[1];
    assert.ok(goalId, add.stdout);

    const missing = await runCli(['goal', 'confirm', goalId, '--criterion', 'c1', '--decision', 'suggested'], env);
    assert.notEqual(missing.code, 0, missing.stdout + missing.stderr);
    assert.match(missing.stdout + missing.stderr, /goal confirm needs --reason/);

    const accepted = await runCli(['goal', 'update', goalId, 'accepted'], env);
    assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
    const relaxed = await runCli([
      'goal', 'confirm', goalId, '--criterion', 'c1', '--decision', 'suggested', '--reason', 'storing it is enough',
    ], env);
    assert.equal(relaxed.code, 0, relaxed.stdout + relaxed.stderr);
    assert.match(relaxed.stdout, /is recorded as suggested/);
    assert.match(relaxed.stdout, /it stays a suggestion/);

    const activated = await runCli(['goal', 'update', goalId, 'active'], env);
    assert.equal(activated.code, 0, activated.stdout + activated.stderr);
    const nothingRequired = await runCli(['goal', 'complete', goalId], env);
    assert.equal(nothingRequired.code, 1, nothingRequired.stdout);
    assert.match(nothingRequired.stdout, /no criterion is recorded as required/);

    const show = await runCli(['goal', 'show', goalId], env);
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /your decision: suggested/);

    const usage = await runCli(['goal', 'confirm'], env);
    assert.notEqual(usage.code, 0, usage.stdout + usage.stderr);
    assert.match(usage.stdout + usage.stderr, /usage: goal confirm/);
  } finally {
    cleanup(dir);
  }
});
