// Batch AL, work packages G, K and L: the planning bridge a user actually talks to.
//
// Work packages A-F put a candidate generator, a disclosed comparison rule, an outcome evaluator and a
// goal-progress derivation in the repository as library modules and store actions. This suite is about
// the part that faces the user, and it holds three guarantees:
//
//   1. Selection. One plan is recorded only when the disclosed rule separates it from every candidate
//      that passed every gate. Where it cannot, the trade-off is the answer, nothing is recorded, and
//      the approaches that were not recorded are named with the position the rule gave them - so a
//      reader can disagree with the choice instead of guessing at it. A revision never replaces the plan
//      it revises: the earlier record and its approval are re-read and asserted byte-identical.
//   2. Continuation readiness. Six named states, each read from a record the answer points at, each with
//      the command that takes it up - and where the state is answered by a read rather than an act on a
//      record, the answer says that instead of naming a command that would be a lie. A score orders a
//      list; it is asserted not to be a probability, an importance, or a permission.
//   3. The user-facing questions. "what are my options", "is this ready", "what was the outcome" are
//      answered from records, and every line carries the kind of claim it is: [fact], [verified outcome],
//      [assumption], [suggestion], [prediction]. The suite asserts both that the marks appear and that
//      no deliberation trace does - there is none to expose, and the answer says so.
//
// Everything here runs through the real application: the live action registry, the goal store, the plan
// store, the task runner, the verifier and the audit log, driven by the words a user would type
// (`controller.handle`) wherever a state can be reached that way. Where a record shape cannot be produced
// by any user-visible request - a candidate excluded by a hard gate, a comparison whose bytes moved
// under it - the test takes a real `plan.candidates` read and changes one field, and says so at the
// fixture. The labelled test doubles in tests/helpers.js stand in for a failing and an uncheckable step;
// they are not evidence about a real action. No model service is contacted and no inference is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { planContentHash } from '../src/plans/model.js';
import { READINESS_BASIS, READINESS_RULE } from '../src/executive/vocabulary.js';
import { SELECTION_NOTE, selectCandidate, renderSelection } from '../src/executive/selection.js';
import { makeTempDataDir, cleanup, makeFakeTaskActions } from './helpers.js';

const CLOCK = () => new Date('2026-11-05T09:00:00.000Z');
const short = (id) => String(id).slice(0, 8);

async function openApp(dir, extraActions = []) {
  return createApp({ dataDir: dir, now: CLOCK, experienceCapture: CAPTURE_OFF, extraActions });
}

const stepsOf = (res) => (res.operation?.steps ?? []).map((s) => `${s.action}:${s.outcome}`);

// Every assertion below is against text a user reads, so the helper names the view it failed on.
function says(display, needles, label = 'answer') {
  for (const needle of needles) {
    assert.ok(display.includes(needle), `${label} is missing: ${needle}\n---\n${display}`);
  }
}

function neverSays(display, needles, label = 'answer') {
  for (const needle of needles) {
    assert.ok(!display.includes(needle), `${label} should not contain: ${needle}\n---\n${display}`);
  }
}

async function plansFor(app, goalId) {
  return (await app.plans.list()).filter((p) => p.goalId === goalId);
}

async function goalOf(app, { request, criteria }) {
  const res = await app.controller.goalAdd({ request, criteria });
  assert.equal(res.status, Outcome.GOAL_CREATED, res.output);
  return res.operation.steps[0].result.data.goalId;
}

// A remembered fact is the one thing every shipped capability can carry, so the goal shapes below are
// reached by their words alone; `extra` criteria are the ones no capability can take.
const REMEMBER = 'remember the release date';
const SEARCH = 'search memory for alpha';

function readStep(id, action, criterion = null) {
  return {
    id,
    description: `${action} step ${id}`,
    action,
    input: { tag: id },
    dependsOn: [],
    expectedResult: `the ${id} read is recorded`,
    verification: 'the sink holds the read',
    criterion,
    risk: 'low',
  };
}

const planLog = (dir) => {
  const file = path.join(dir, 'plans.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
};

// A real, separated selection through the application path, reused by the readiness fixtures so each one
// starts from a record the bridge itself wrote.
async function preparedDraft(app, { request = REMEMBER, criteria = [REMEMBER] } = {}) {
  const goalId = await goalOf(app, { request, criteria });
  const res = await app.controller.handle(`prepare a plan for goal ${goalId}`, { origin: 'user' });
  assert.equal(res.status, Outcome.PLAN_STORED, res.output);
  const draft = (await plansFor(app, goalId))[0];
  assert.ok(draft, 'a draft was not recorded');
  return { goalId, draft, res };
}

// ---------------------------------------------------------------------------
// 1. Selection refuses, and says why, wherever the rule does not separate one candidate.
// ---------------------------------------------------------------------------

test('a selection refuses when there is no comparison, and when the comparison itself refused', async () => {
  // The no-comparison path: a caller that never read anything cannot select from it.
  const nothing = selectCandidate({});
  assert.equal(nothing.ok, false);
  assert.equal(nothing.reason, 'no-comparison');
  assert.equal(nothing.chosen, null);
  assert.deepEqual(nothing.alternatives, []);
  assert.equal(nothing.note, SELECTION_NOTE);
  says(renderSelection(nothing), [
    'Nothing was selected, and nothing was recorded: no-comparison.',
    '  - no comparison was read, so there is nothing to select from and nothing was recorded',
    `  ${SELECTION_NOTE}`,
  ], 'no-comparison rendering');

  // A comparison that refused is passed through in the generator's own words, not re-reasoned about.
  const refused = selectCandidate({
    comparison: {
      ok: false,
      reason: 'no-capability',
      problems: ['no part of this goal can be carried by a registered capability now'],
      whatWouldSettleIt: ['a capability for the criterion'],
      leading: null,
    },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'no-capability');
  assert.deepEqual(refused.problems, ['no part of this goal can be carried by a registered capability now']);
  assert.deepEqual(refused.whatWouldSettleIt, ['a capability for the criterion']);
});

test('an unresolved comparison selects nothing, and a leader whose bytes moved is refused', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    // Two required criteria, one a write and one a read: the ranked dimensions leave both candidates on
    // the front, so the real read is the fixture for `unresolved`.
    const goalId = await goalOf(app, { request: `${REMEMBER} and ${SEARCH}`, criteria: [REMEMBER, SEARCH] });
    const read = await app.controller.runAction('plan.candidates', { goal: goalId }, 'user', 'op-unresolved');
    assert.equal(read.outcome, Outcome.SUCCESS_VERIFIED, read.summary);
    const comparison = read.result.data.comparison;
    const rows = read.result.data.candidates;
    assert.equal(comparison.leading, null);
    assert.equal(comparison.unresolvedTradeOff, true);

    const unresolved = selectCandidate({ comparison, candidates: rows, goalId });
    assert.equal(unresolved.ok, false);
    assert.equal(unresolved.reason, 'unresolved');
    assert.equal(unresolved.chosen, null);
    // Both candidates that matched are disclosed as unseparated rather than dropped.
    assert.deepEqual(unresolved.alternatives.map((a) => a.position), ['unseparated', 'unseparated']);
    says(renderSelection(unresolved), [
      'Nothing was selected, and nothing was recorded: unresolved.',
      '[unseparated]',
      'one plan is recorded only when the disclosed comparison rule separates it from the others',
    ], 'unresolved rendering');

    // FIXTURE on the real read: no user-visible request produces a comparison that names a leader the
    // candidate list does not carry, because the read derives both together. The refusal is what matters.
    const movedLeader = selectCandidate({
      comparison: { ...comparison, leading: 'required_only' },
      candidates: rows.filter((r) => r.strategy !== 'required_only'),
      goalId,
    });
    assert.equal(movedLeader.ok, false);
    assert.equal(movedLeader.reason, 'leader-not-in-candidate-set');
    assert.match(movedLeader.problems[0], /the comparison names required_only as leading, but the candidate list it came with holds no such candidate/);

    // FIXTURE on the real read: the same for a candidate whose bytes changed after the comparison bound
    // to them - selecting it would record bytes this read never saw.
    const separated = await goalOf(app, { request: REMEMBER, criteria: [REMEMBER] });
    const second = await app.controller.runAction('plan.candidates', { goal: separated }, 'user', 'op-separated');
    const data = second.result.data;
    assert.equal(data.comparison.leading, 'required_only');
    const tampered = {
      ...data.comparison,
      boundTo: {
        ...data.comparison.boundTo,
        candidateDigests: data.comparison.boundTo.candidateDigests.map((d) => ({
          ...d, digest: `${d.digest.startsWith('f') ? '0' : 'f'}${d.digest.slice(1)}`,
        })),
      },
    };
    const changed = selectCandidate({ comparison: tampered, candidates: data.candidates, goalId: separated });
    assert.equal(changed.ok, false);
    assert.equal(changed.reason, 'candidate-changed');
    assert.match(changed.problems[0], /no longer has the bytes the comparison was bound to/);

    // A separated comparison does select, and its note is the last line the reader is given.
    const chosen = selectCandidate({
      comparison: data.comparison,
      candidates: data.candidates,
      skipped: data.skipped,
      goalId: separated,
    });
    assert.equal(chosen.ok, true);
    assert.equal(chosen.reason, null);
    assert.equal(chosen.chosen.strategy, 'required_only');
    assert.equal(chosen.chosen.digest, data.candidates.find((r) => r.strategy === 'required_only').digest);
    const rendered = renderSelection(chosen).split('\n');
    assert.equal(rendered[rendered.length - 1].trim(), SELECTION_NOTE);
    says(rendered.join('\n'), [
      `Selected: required_only (${chosen.chosen.steps} step(s), ${chosen.chosen.writes} write(s), ${chosen.chosen.risk} risk), digest ${short(chosen.chosen.digest)}.`,
      '  why this one:',
      `  rule: ${data.comparison.rule.slice(0, 60)}`,
      '  the approaches not recorded, and why (2):',
      '[not offered]',
    ], 'selection rendering');
  } finally {
    cleanup(dir);
  }
});

test('a candidate excluded by a hard gate is disclosed with the gate that excluded it', () => {
  // FIXTURE: every goal shape the shipped registry can reach either separates or ties, so a gate
  // exclusion is built here rather than claimed from a record. The gate name and the disclosure shape
  // are the ones `evaluateCandidates` writes.
  const excluded = selectCandidate({
    comparison: {
      ok: true,
      leading: 'required_only',
      basis: 'it is the only candidate left after the gates',
      rule: 'Hard gates first',
      included: ['required_only'],
      behind: [],
      ties: [],
      tradeOffs: [],
      excluded: [{
        strategy: 'read_before_write',
        digest: 'a'.repeat(64),
        failedGates: [{ gate: 'capability_available_now', detail: 'step s1 names an action the registry does not hold' }],
      }],
      boundTo: { candidateDigests: [{ strategy: 'required_only', digest: 'b'.repeat(64) }], candidateSetDigest: 'c'.repeat(64) },
      whatWouldSettleIt: [],
    },
    candidates: [{ strategy: 'required_only', digest: 'b'.repeat(64), steps: 1, writes: 1, risk: 'medium' }],
  });
  assert.equal(excluded.ok, true);
  const row = excluded.alternatives.find((a) => a.strategy === 'read_before_write');
  assert.equal(row.position, 'excluded');
  says(renderSelection(excluded), [
    '- read_before_write [excluded]: gate capability_available_now: step s1 names an action the registry does not hold',
  ], 'excluded rendering');
});

// ---------------------------------------------------------------------------
// 2. The preparation the user asks for in words, and what it records.
// ---------------------------------------------------------------------------

test('preparing a plan for a recorded goal reads the approaches and records exactly one draft', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const goalId = await goalOf(app, { request: REMEMBER, criteria: [REMEMBER] });
    const res = await app.controller.handle(`prepare a plan for goal ${goalId}`, { origin: 'user' });
    assert.equal(res.status, Outcome.PLAN_STORED, res.output);
    assert.equal(res.operation.capability, 'executive.prepare');
    // One audited read of the comparison, then one write: nothing else, and no invented action.
    assert.deepEqual(stepsOf(res), ['plan.candidates:success_verified', 'plan.add:success_verified']);

    const drafts = await plansFor(app, goalId);
    assert.equal(drafts.length, 1, 'exactly one draft was to be recorded');
    const draft = drafts[0];
    assert.equal(draft.status, 'draft');
    assert.ok(!draft.approval, 'a recorded draft carries no approval');
    assert.equal(draft.steps.length, 1);
    for (const step of draft.steps) {
      assert.ok(app.registry.get(step.action), `step ${step.id} names ${step.action}, which is not registered`);
    }

    const display = res.display;
    says(display, [
      'Planning options, answered from APEX records: the goal\'s own criteria, the live action registry, and the disclosed comparison rule.',
      `[fact] goal ${short(goalId)} is recorded as proposed at revision 1: 1 criterion(s) on record, 1 made required by the user (0 satisfied), 0 put forward by APEX, 0 declined.`,
      '1 candidate digest(s) [',
      'What the approaches mean:',
      '  required_only - works on the criteria the user made required',
      'Selected: required_only (1 step(s), 1 write(s), medium risk), digest',
      '  why this one: no other candidate that passed every gate is as good on all ranked dimensions and better on one',
      '  the approaches not recorded, and why (2):',
      '[not offered]: this approach is the plan already offered as required_only: nothing recorded makes its steps differ',
      '[not offered]: every step this approach takes on is a write, so there is no read-before-write order to choose',
      'Readiness: ready for approval.',
      `no plan record exists to take up, so what is named is the read: node bin/apex.js plan candidates ${short(goalId)}`,
      `[fact] as the read reported it: the plan store holds 0 draft(s) for this goal of at most 3, and 0 live plan(s); it would accept 3 more.`,
      `[fact] recorded draft ${short(draft.id)}: 1 step(s), recorded from the required_only candidate`,
      `  to approve it: node bin/apex.js plan approve ${short(draft.id)}`,
      'Learning read, applied to nothing:',
      'This read changed nothing above it: no gate, no ranked dimension, no score, and no candidate digest is computed from these records.',
      'Intended outcome: remember the release date',
      'recorded as draft: plan',
      'Nothing has run. No step has been started, no record has been changed, and no approval has been given.',
    ], 'preparation answer');
    // The draft is an intention on screen and in the store, never a run.
    neverSays(display, ['chain of thought', 'thinking process', 'reasoning steps are:'], 'preparation answer');
    // The learning block is added to an answer that was already near its bound, and an answer whose
    // disclosure is cut mid-sentence discloses nothing: the block gives way from inside itself instead.
    neverSays(display, ['cut at 40 lines', 'cut at 4000 characters'], 'preparation answer');
  } finally {
    cleanup(dir);
  }
});

test('the same goal read twice gives the same candidate set and the same leader', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const goalId = await goalOf(app, { request: `${REMEMBER} and ${SEARCH}`, criteria: [REMEMBER, SEARCH] });
    const a = await app.controller.runAction('plan.candidates', { goal: goalId }, 'user', 'op-read-a');
    const b = await app.controller.runAction('plan.candidates', { goal: goalId }, 'user', 'op-read-b');
    assert.equal(a.outcome, Outcome.SUCCESS_VERIFIED, a.summary);
    assert.equal(b.outcome, Outcome.SUCCESS_VERIFIED, b.summary);
    assert.equal(a.result.data.candidateSetDigest, b.result.data.candidateSetDigest);
    assert.deepEqual(a.result.data.candidates.map((c) => [c.strategy, c.digest]), b.result.data.candidates.map((c) => [c.strategy, c.digest]));
    assert.equal(a.result.data.comparison.leading, b.result.data.comparison.leading);
    assert.equal(a.result.data.comparison.boundTo.candidateSetDigest, b.result.data.candidateSetDigest);
    // What was read is not what was done: the read authorizes nothing and executes nothing.
    for (const read of [a, b]) {
      assert.equal(read.result.data.recorded, false);
      assert.equal(read.result.data.approved, false);
      assert.equal(read.result.data.executable, false);
    }
  } finally {
    cleanup(dir);
  }
});

test('an unresolved comparison is a clarification: nothing is selected, recorded, or queued', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    // A draft from an earlier goal so the plan log exists and its bytes can be compared afterwards.
    const earlier = await preparedDraft(app);
    assert.ok(earlier.draft.id);
    const before = planLog(dir);

    const goalId = await goalOf(app, { request: `${REMEMBER} and ${SEARCH}`, criteria: [REMEMBER, SEARCH] });
    const res = await app.controller.handle(`prepare a plan for goal ${goalId}`, { origin: 'user' });
    assert.equal(res.status, Outcome.CLARIFICATION_REQUIRED, res.output);
    assert.equal(res.operation.capability, 'executive.prepare');
    assert.deepEqual(stepsOf(res), ['plan.candidates:success_verified']);
    assert.equal((await plansFor(app, goalId)).length, 0);
    // The refusal is a read: the plan log is the bytes it was before the request.
    assert.equal(planLog(dir), before);

    says(res.display, [
      'Nothing was selected, and nothing was recorded: unresolved.',
      '  what the rule found:',
      'required_only and read_before_write match on every ranked dimension: the comparison finds nothing recorded that separates them.',
      '  the approaches not recorded, and why (3):',
      '  what would settle the choice: nothing in the records separates these candidates on the ranked dimensions; the choice rests on their text, which a comparison of recorded facts cannot weigh',
      'Readiness: requires clarification.',
      'what answers this state is a read, not an act on a record:',
      '  Nothing was recorded, because the rule did not separate one candidate. Naming a priority settles it: say which of the approaches you want and APEX records that one.',
      '[planning options cut at 4000 characters; "node bin/apex.js plan candidates <goal-id>" prints the comparison gate by gate]',
      'What each mark means:',
      'No reasoning steps are shown, because there are none to show: this answer is produced from the records it names, and APEX keeps no hidden deliberation about them.',
    ], 'unresolved answer');
    // The legend is appended outside the bound, so a cut answer still explains its own marks.
    assert.ok(res.display.indexOf('What each mark means:') > res.display.indexOf('cut at 4000 characters'));
  } finally {
    cleanup(dir);
  }
});

test('the options question answers from records and records nothing itself', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const goalId = await goalOf(app, { request: `${REMEMBER} and ${SEARCH}`, criteria: [REMEMBER, SEARCH] });
    const res = await app.controller.handle(`what are my options for goal ${goalId}?`, { origin: 'user' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    assert.equal(res.operation.capability, 'executive.status');
    assert.deepEqual(stepsOf(res), ['plan.candidates:success_verified']);
    assert.equal((await plansFor(app, goalId)).length, 0);
    says(res.display, [
      'Read and audited under operation',
      'The read changed nothing, and this answer records nothing.',
      '2 candidate digest(s) [',
      'What the approaches mean:',
      `what answers this state is a read, not an act on a record: node bin/apex.js plan candidates ${short(goalId)}`,
    ], 'options answer');
    neverSays(res.display, ['to approve it:', 'recorded as draft:'], 'options answer');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 3. Replanning: a revision is a new record, and the approved plan it revises is untouched.
// ---------------------------------------------------------------------------

test('replanning records a revision beside the approved plan and leaves that plan and its approval unchanged', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const { goalId, draft } = await preparedDraft(app);
    const approve = await app.controller.handle(`approve plan ${short(draft.id)}`, { origin: 'user' });
    assert.equal(approve.status, Outcome.PLAN_STORED, approve.output);
    const prior = await app.plans.get(draft.id);
    const priorHash = planContentHash(prior);
    assert.equal(prior.status, 'approved');

    const res = await app.controller.handle(`replan plan ${short(draft.id)}`, { origin: 'user' });
    assert.equal(res.status, Outcome.PLAN_STORED, res.output);
    assert.equal(res.operation.capability, 'executive.replan');
    assert.deepEqual(stepsOf(res), ['plan.replan:success_verified', 'plan.add:success_verified']);

    // The plan the user approved is exactly where they left it - same status, version, bytes, approval.
    const after = await app.plans.get(draft.id);
    assert.equal(after.status, 'approved');
    assert.equal(after.version, 1);
    assert.equal(planContentHash(after), priorHash);
    assert.ok(after.approval, 'the approval recorded against the prior plan survives the revision');

    const all = await plansFor(app, goalId);
    assert.equal(all.length, 2);
    const revision = all.find((p) => p.id !== draft.id);
    assert.equal(revision.status, 'draft', 'a revision comes back as a draft, never as an approved plan');
    assert.ok(!revision.approval, 'a revision needs fresh approval');
    // A revision of a goal whose records have not moved can carry the same bytes as the plan it revises.
    // What makes it a new decision is the record beside those bytes: the approval the user gave is
    // bound to the plan id and version it was written against, and this record has none.
    assert.equal(after.approval.contentHash, priorHash);
    assert.notEqual(revision.id, draft.id);

    says(res.display, [
      `Read and audited under operation ${short(res.operation.id)}. The read changed nothing, and one draft was recorded from it (${short(revision.id)}).`,
      `[fact] this is a revision of plan ${short(draft.id)}, recorded as v1 (approved): that plan and its approval are unchanged by this read, and a revision needs fresh validation and fresh approval.`,
      '[fact] the plan record holds no failed or uncertain step outcome, so this revision answers the stated reason and the constraints given, not a recorded failure.',
      `[fact] as the read reported it: the plan store holds 0 draft(s) for this goal of at most 3, and 1 live plan(s); it would accept 3 more.`,
      `recorded as draft: plan ${short(revision.id)} v1, 1 step(s), medium risk - waiting for your approval`,
    ], 'revision answer');
    neverSays(res.display, ['replaces plan', 'superseded plan'], 'revision answer');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 4. Continuation readiness: the seven states, each naming the record it was read from.
// ---------------------------------------------------------------------------

const SEVEN_STATES = [
  '  ready to execute - a plan recorded as approved, whose live validity check passes against the records it names',
  `  ready to continue - ${READINESS_BASIS['ready to continue']}`,
  '  ready for approval - a plan recorded as a draft, or a candidate that passed every gate, whose steps the live registry authorizes',
  '  requires clarification - a comparison the disclosed rule cannot separate, a goal whose revision moved after the plan was written, or a goal with no open criterion to plan against',
  '  blocked - a plan or goal recorded as blocked, an approval that no longer matches the plan bytes, an unmet goal dependency, or a failed step outcome',
  '  waiting for evidence - a step with no recorded outcome, an evidence citation the stores no longer support, or an outcome verdict of awaiting confirmation',
  '  not feasible - a candidate set no registered capability can carry, or a step naming an action the registry does not hold or does not authorize',
];

function readinessCore(display) {
  says(display, [
    'Continuation readiness, answered from the plan, goal, task and comparison records and the live validity check.',
    'Nothing here was run, approved, recorded, or cancelled.',
    ...SEVEN_STATES,
    `  ${READINESS_RULE}`,
  ], 'readiness answer');
}

test('a draft reads as ready for approval and names the approval command', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const { draft } = await preparedDraft(app);
    const res = await app.controller.handle(`what is the readiness of plan ${short(draft.id)}?`, { origin: 'user' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    assert.equal(res.operation.capability, 'executive.status');
    assert.deepEqual(stepsOf(res), []);
    const display = res.display;
    readinessCore(display);
    says(display, [
      `The seven states, and the record each one is read from (asked about ${short(draft.id)}):`,
      'Readiness: ready for approval.',
      `  read as: ${READINESS_BASIS['ready for approval']}`,
      '  - the plan is a draft of 1 step(s) and every live check passed',
      `  to take it up: node bin/apex.js plan approve ${short(draft.id)}`,
      'No reasoning steps are shown, because there are none to show',
    ], 'draft readiness');
    neverSays(display, ['to take it up: node bin/apex.js plan start', 'to take it up: node bin/apex.js plan candidates'], 'draft readiness');
  } finally {
    cleanup(dir);
  }
});

test('an approved plan whose live checks pass reads as ready to execute and names the start command', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const { goalId, draft } = await preparedDraft(app);
    assert.equal((await app.controller.handle(`approve plan ${short(draft.id)}`, { origin: 'user' })).status, Outcome.PLAN_STORED);
    const res = await app.controller.handle(`is plan ${short(draft.id)} ready to start?`, { origin: 'user' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    const display = res.display;
    readinessCore(display);
    says(display, [
      'Readiness: ready to execute.',
      '  - live check `capabilities` passed: 1 step(s) name available, authorized capabilities [from: assessPlanValidity check capabilities]',
      `  - live check \`goal\` passed: goal ${goalId} is proposed at revision 1 [from: assessPlanValidity check goal]`,
      '  - live check `goal-revision` passed: plan names goal revision 1, which is current',
      '  - live check `goal-dependencies` passed: every goal dependency is complete',
      '  - live check `assertions` passed: every referenced record is still in the store and still current',
      '  - live check `recorded-outcomes` passed: 0 completed step(s) still cite verified operations',
      '  - the plan is approved against its current content and every live check passed',
      `  to take it up: node bin/apex.js plan start ${short(draft.id)}`,
    ], 'approved readiness');
    neverSays(display, ['to take it up: node bin/apex.js plan approve'], 'approved readiness');
  } finally {
    cleanup(dir);
  }
});

test('a plan a failed step stopped reads as blocked and points at the task record, not at itself', async () => {
  const dir = makeTempDataDir();
  try {
    const sink = [];
    const app = await openApp(dir, makeFakeTaskActions(sink));
    const goalId = await goalOf(app, { request: 'the failing run goal', criteria: ['remember that the failing run fact holds'] });
    const added = await app.controller.planAdd({ goalId, outcome: 'the failing run settles', steps: [readStep('s1', 'test.fail', 'c1')] });
    assert.equal(added.status, Outcome.PLAN_STORED, added.output);
    const planId = added.operation.steps[0].result.data.planId;
    assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);
    const run = await app.controller.handle(`start plan ${short(planId)}`, { origin: 'user' });
    assert.notEqual(run.status, Outcome.SUCCESS_VERIFIED, 'the labelled failing double was to stop the run');
    const blocked = await app.plans.get(planId);
    assert.equal(blocked.status, 'blocked');

    const res = await app.controller.handle(`is plan ${short(planId)} ready to start?`, { origin: 'user' });
    const display = res.display;
    readinessCore(display);
    says(display, [
      'Readiness: blocked.',
      `  - the plan is recorded as blocked: a step did not complete; the task record states why [from: plan ${short(planId)} status and blockedReason]`,
      `  to take it up: node bin/apex.js plan validate ${short(planId)}`,
    ], 'blocked readiness');
    // The answer names the task record for the reason and does not re-derive a cause of its own.
    neverSays(display, ['Readiness: ready'], 'blocked readiness');
  } finally {
    cleanup(dir);
  }
});

test('an evidence citation the stores no longer support reads as waiting for evidence', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const goalId = await goalOf(app, { request: 'remember the assertion fact', criteria: ['remember that the assertion fact holds'] });
    const claim = await app.controller.runAction('knowledge.add', {
      subject: 'the north gate', relationship: 'is', object: 'open', evidence: 'seen at the gate',
    }, 'user', 'op-claim');
    assert.equal(claim.outcome, Outcome.SUCCESS_VERIFIED, claim.summary);
    const claimId = claim.result.data.id;
    const added = await app.controller.planAdd({
      goalId,
      outcome: 'the assertion fact is remembered',
      steps: [{
        id: 's1',
        description: 'remember the assertion fact',
        action: 'memory.add',
        input: { content: 'the assertion fact' },
        dependsOn: [],
        expectedResult: 'the fact is stored',
        verification: 'the stored record is read back',
        criterion: 'c1',
        risk: 'medium',
      }],
      assertions: [{ kind: 'stored_knowledge', ref: claimId, text: 'the claim this plan rests on' }],
    });
    assert.equal(added.status, Outcome.PLAN_STORED, added.output);
    const planId = added.operation.steps[0].result.data.planId;

    const before = await app.controller.handle(`what is the readiness of plan ${short(planId)}?`, { origin: 'user' });
    says(before.display, ['Readiness: ready for approval.', '  - live check `assertions` passed'], 'readiness before retraction');

    const retracted = await app.controller.runAction('knowledge.retract', { target: claimId, reason: 'the gate was found shut' }, 'user', 'op-retract');
    assert.equal(retracted.outcome, Outcome.SUCCESS_VERIFIED, retracted.summary);

    const res = await app.controller.handle(`what is the readiness of plan ${short(planId)}?`, { origin: 'user' });
    const display = res.display;
    readinessCore(display);
    says(display, [
      'Readiness: waiting for evidence.',
      `  - live check \`assertions\` failed: the record ${claimId} is retracted (the gate was found shut), so it no longer supports this assertion [from: assessPlanValidity check assertions]`,
      `  to take it up: node bin/apex.js plan outcome ${short(planId)}`,
    ], 'waiting-for-evidence readiness');
    // The plan record itself is unchanged by an assertion falling away: this is a read of state.
    assert.equal((await app.plans.get(planId)).status, 'draft');
  } finally {
    cleanup(dir);
  }
});

test('a plan whose goal moved reads as requires clarification and points at a read, not at an act', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const { goalId, draft } = await preparedDraft(app);
    assert.equal((await app.controller.handle(`approve plan ${short(draft.id)}`, { origin: 'user' })).status, Outcome.PLAN_STORED);
    const revised = await app.controller.goalRevise({ target: goalId, criteria: ['remember that the revised fact holds'], reason: 'the criterion changed' });
    assert.equal(revised.status, Outcome.GOAL_UPDATED, revised.output);

    const res = await app.controller.handle(`is plan ${short(draft.id)} ready to start?`, { origin: 'user' });
    const display = res.display;
    readinessCore(display);
    says(display, [
      'Readiness: requires clarification.',
      '  - live check `goal-revision` failed: plan names goal revision 1, but the goal is revision 2',
      `  what answers this state is a read, not an act on a record: node bin/apex.js plan candidates ${short(goalId)}`,
    ], 'moved-goal readiness');
    // The approved plan is still approved against its own bytes; the revision is a fact about the goal.
    const still = await app.plans.get(draft.id);
    assert.equal(still.status, 'approved');
    neverSays(display, ['to take it up: node bin/apex.js plan start'], 'moved-goal readiness');
  } finally {
    cleanup(dir);
  }
});

test('a goal no registered capability can carry reads as not feasible and names the read that answers it', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const goalId = await goalOf(app, { request: 'archive the vault to cold storage', criteria: ['the vault is archived to cold storage'] });
    const res = await app.controller.handle(`what is the readiness of goal ${goalId}?`, { origin: 'user' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    const display = res.display;
    says(display, [
      `[fact] 0 approach(es) were generated from those records and compared; the candidate set digest is 0 candidate digest(s) [].`,
      '[fact] no registered capability can carry c1 ("the vault is archived to cold storage") now, so no approach on the table settles it.',
      'Nothing was selected, and nothing was recorded: no-capability.',
      '  - no part of this goal can be carried by a registered capability now, so APEX records no candidate rather than inventing steps',
      'other approaches: none were compared, so there is nothing to disclose beside this one.',
      'Readiness: not feasible.',
      '  read as: a candidate set no registered capability can carry, or a step naming an action the registry does not hold or does not authorize',
      '  - no part of this goal can be carried by a registered capability now, so APEX records no candidate rather than inventing steps [from: candidate generation reason `no-capability`]',
      '  what answers this state is a read, not an act on a record: node bin/apex.js plan list',
      '  Nothing was recorded, because the rule did not separate one candidate. Naming a priority settles it: say which of the approaches you want and APEX records that one.',
    ], 'not-feasible answer');
    // The zero-arg command is what the state names; no plan or goal id is stitched onto it.
    neverSays(display, [`plan list ${short(goalId)}`, `plan approve ${short(goalId)}`, `plan start ${short(goalId)}`], 'not-feasible answer');
    // The state's own line is a read. The ranking below it may name an act on the goal record, and
    // that is a different question: which open record is most urgent, not what answers this state.
    const ranking = display.indexOf('What the continuation ranking used');
    const start = display.lastIndexOf('Readiness: not feasible.', ranking);
    assert.ok(start > 0 && start < ranking, 'the readiness state block was not printed before the ranking');
    const state = display.slice(start, ranking);
    neverSays(state, ['to take it up:'], 'not-feasible state block');
    assert.equal((await plansFor(app, goalId)).length, 0);
  } finally {
    cleanup(dir);
  }
});

test('a closed plan states no readiness and points the question at the outcome read', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const { draft } = await preparedDraft(app);
    assert.equal((await app.controller.handle(`approve plan ${short(draft.id)}`, { origin: 'user' })).status, Outcome.PLAN_STORED);
    const run = await app.controller.handle(`start plan ${short(draft.id)}`, { origin: 'user' });
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.output);
    assert.equal((await app.plans.get(draft.id)).status, 'completed');

    const res = await app.controller.handle(`is plan ${short(draft.id)} ready to start?`, { origin: 'user' });
    says(res.display, [
      `Readiness: not stated - plan ${short(draft.id)} is closed as completed; no continuation of it is recorded as waiting. What it established is a different question: "plan outcome".`,
      `  - plan ${short(draft.id)} is recorded as completed with 1 of 1 step outcome(s) recorded [from: plan ${short(draft.id)} status field]`,
    ], 'closed-plan readiness');
    neverSays(res.display,
      ['Readiness: ready', `to take it up: node bin/apex.js plan start ${short(draft.id)}`, 'to take it up: node bin/apex.js plan approve'],
      'closed-plan readiness');
  } finally {
    cleanup(dir);
  }
});

test('readiness factors name the record each one was read from and disclaim the score', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const { goalId, draft } = await preparedDraft(app);
    const res = await app.controller.handle(`what is the readiness of plan ${short(draft.id)}?`, { origin: 'user' });
    const display = res.display;
    says(display, [
      'What the continuation ranking used, in this order:',
      `  1. goal ${short(goalId)} - "Goal ${short(goalId)}: remember the release date" (proposed)`,
      '     ranking rule: explicit user priority, where 1 is most urgent; score ',
      '     [fact] the next action named is `accept-goal` [read from: the continuation rule\'s own ordering (explicit user priority, where 1 is most urgent)]',
      `     [fact] priority 3 is recorded on it, and 1 is the most urgent the records allow [read from: goal ${short(goalId)} priority field]`,
      `     [fact] no deadline is recorded on it [read from: goal ${short(goalId)} deadline field]`,
      `     [fact] no risk is recorded on it [read from: goal ${short(goalId)}]`,
      '     [fact] taking it up is your own act, and APEX will not take it for you [read from: the authorization rule each action runs under]',
      'orders this list under explicit user priority, where 1 is most urgent. It is not a probability, an importance, or a permission.',
      '  readiness is read from a recorded plan, goal, task, operation, or candidate comparison, and the check it was read from is named beside it. It is not a forecast that a run will succeed, and no readiness state authorizes a step: the registry decides that again when each step runs.',
    ], 'prioritization factors');
    // A factor line always carries where it came from; a bare assertion never does. The legend below
    // the body prints `[fact]` as a mark explanation, so the check is scoped to the ranking block.
    const ranking = display.indexOf('What the continuation ranking used');
    const legend = display.indexOf('What each mark means:');
    assert.ok(ranking > 0 && legend > ranking, 'the ranking block or its legend was not printed');
    for (const line of display.slice(ranking, legend).split('\n').filter((l) => /^\s+\[fact\] /.test(l))) {
      assert.ok(line.includes('[read from:'), `factor line names no record: ${line}`);
    }
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 5. The kinds of claim a user-facing answer makes, and what it refuses to show.
// ---------------------------------------------------------------------------

test('an inferred criterion stays a suggestion and no plan completes the goal against it', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const goalId = await goalOf(app, {
      request: 'the suggested goal',
      criteria: [
        'remember the suggested fact',
        { description: 'list the memories so the fact is seen', basis: 'system_inferred', requiredEvidence: 'a listing that shows the fact' },
        'the vault is archived',
      ],
    });
    const res = await app.controller.handle(`what are my options for goal ${goalId}?`, { origin: 'user' });
    says(res.display, [
      `[fact] goal ${short(goalId)} is recorded as proposed at revision 1: 3 criterion(s) on record, 2 made required by the user (0 satisfied), 1 put forward by APEX, 0 declined.`,
      '[suggestion] c2 ("list the memories so the fact is seen") is a criterion APEX put forward (system_inferred); it is not a requirement until you record one, and no plan completes the goal against it.',
      '[fact] no registered capability can carry c2 ("list the memories so the fact is seen") now, so no approach on the table settles it.',
      '[fact] no registered capability can carry c3 ("the vault is archived") now, so no approach on the table settles it.',
      '  what would settle the choice: a criterion no registered capability can carry: c2 ("list the memories so the fact is seen"), c3 ("the vault is archived")',
    ], 'suggested-criterion answer');
    // The suggested criterion is not promoted into the plan: the leader settles c1 alone.
    assert.match(res.display, /\[fact\] required_only: 1 step\(s\), 1 write\(s\), medium risk, digest \w{8}, settles c1;/);
    neverSays(res.display, ['[suggestion] c1'], 'suggested-criterion answer');
    assert.equal((await plansFor(app, goalId)).length, 0, 'the options question records no draft');
  } finally {
    cleanup(dir);
  }
});

test('a criterion planned only from the goal\'s own request is marked an assumption, not a fact', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const goalId = await goalOf(app, {
      request: 'remember the fact and confirm it in the world',
      criteria: ['the fact is remembered', 'the world confirms it'],
    });
    const res = await app.controller.handle(`what are my options for goal ${goalId}?`, { origin: 'user' });
    says(res.display, [
      '[assumption] c1 ("the fact is remembered") is planned only from the goal\'s recorded request, not from its own words: the step offered for it settles nothing by itself.',
      '[assumption] c2 ("the world confirms it") is planned only from the goal\'s recorded request, not from its own words: the step offered for it settles nothing by itself.',
      '  [assumption] - recorded as an assumption, not as established',
    ], 'assumption answer');
    // An assumption is never printed as though the records established it.
    neverSays(res.display, ['[fact] c1 (', '[fact] c2 ('], 'assumption answer');
  } finally {
    cleanup(dir);
  }
});

test('the outcome answer separates audit facts from world facts and records nothing itself', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const { draft } = await preparedDraft(app);
    assert.equal((await app.controller.handle(`approve plan ${short(draft.id)}`, { origin: 'user' })).status, Outcome.PLAN_STORED);
    assert.equal((await app.controller.handle(`start plan ${short(draft.id)}`, { origin: 'user' })).status, Outcome.SUCCESS_VERIFIED);
    const ran = await app.plans.get(draft.id);
    assert.equal(ran.status, 'completed');

    const res = await app.controller.handle(`what was the outcome of plan ${short(draft.id)}?`, { origin: 'user' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    assert.deepEqual(stepsOf(res), ['plan.outcome:success_verified']);
    says(res.display, [
      'A plan\'s outcome, answered from its recorded step outcomes, the audit operations they cite, the goal\'s criteria, and what the stores still hold.',
      'This read recorded nothing: an assessment is written by plan.assess, which is your act.',
      `  the rule that gave that reading, in full: ${'the first rule the records satisfy decides the verdict: failed, then uncertain, then blocked, then partial, then awaiting_confirmation, then successful'}`,
      '[verified outcome] awaiting_confirmation:',
      '[fact] step_completion: answered from the records',
      '[fact] external_confirmation: answered from the records',
      'A step that ran and verified is a fact about the audit log.',
      'This reading can be recorded with plan.assess against',
    ], 'outcome answer');
    // Execution success is not outcome success: the run verified, and the verdict is still awaiting.
    assert.ok(res.display.includes('[verified outcome] step_completion: 1 of 1 step(s) recorded completed'), res.display);
    assert.ok(!res.display.includes('[verified outcome] successful'), 'a completed run must not read as a successful outcome');
    neverSays(res.display, ['Readiness: ready'], 'outcome answer');
    // The legend below the body explains the five marks, so the token itself is not a claim.
    // Only a body line that asserted a prediction would make an expectation read as established.
    const legend = res.display.indexOf('What each mark means:');
    assert.ok(legend > 0, 'the outcome answer printed no claim legend');
    assert.ok(!res.display.slice(0, legend).includes('[prediction]'), 'the outcome answer asserted a prediction');
  } finally {
    cleanup(dir);
  }
});

test('a long answer is bounded and still explains its own marks afterwards', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const goalId = await goalOf(app, { request: `${REMEMBER} and ${SEARCH}`, criteria: [REMEMBER, SEARCH] });
    const res = await app.controller.handle(`what are my options for goal ${goalId}?`, { origin: 'user' });
    const body = res.display.slice(0, res.display.indexOf('What each mark means:'));
    assert.ok(body.split('\n').length <= 42, `the bounded body ran past its bound: ${body.split('\n').length} lines`);
    says(res.display, [
      'cut at 4000 characters',
      'What each mark means:',
      '  [fact] - a field read from a named record',
      '  [verified outcome] - an operation the audit log holds, and the action\'s own verifier re-read',
      '  [assumption] - recorded as an assumption, not as established',
      '  [suggestion] - APEX\'s reading of the records, which grants nothing',
      '  [prediction] - a recorded expectation that has resolved neither way',
      'No reasoning steps are shown, because there are none to show: this answer is produced from the records it names, and APEX keeps no hidden deliberation about them.',
    ], 'bounded answer');
    assert.ok(res.display.indexOf('No reasoning steps are shown') > res.display.indexOf('cut at 4000 characters'));
    // The marker names the bound that actually gave way. This answer is inside its line budget and over
    // its character budget, and a reader told the wrong reason cannot tell what the full print still holds.
    assert.ok(!res.display.includes('cut at 40 lines'), 'the answer blamed its line budget for a character cut');
    assert.ok(res.output.length <= 4000 + 2000, `the bounded view exceeded its character budget: ${res.output.length}`);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 6. What the bridge will not take, and what it will not pretend to know.
// ---------------------------------------------------------------------------

test('the bridge answers only a user request that names planning work', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const goalId = await goalOf(app, { request: REMEMBER, criteria: [REMEMBER] });
    const model = await app.controller.handle(`prepare a plan for goal ${goalId}`, { origin: 'model' });
    assert.equal(model.operation.capability, 'model.answer');
    assert.equal(model.status, Outcome.MODEL_UNAVAILABLE, model.output);
    assert.equal((await plansFor(app, goalId)).length, 0, 'a model-origin planning request records nothing');

    const prose = await app.controller.handle('hello there', { origin: 'user' });
    assert.ok(!String(prose.operation.capability).startsWith('executive.'), `an ordinary sentence reached the bridge: ${prose.operation.capability}`);
  } finally {
    cleanup(dir);
  }
});

test('preparation with words nothing can take names the part it could not match', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    const res = await app.controller.handle('prepare me a plan please', { origin: 'user' });
    assert.equal(res.status, Outcome.PLAN_REJECTED, res.output);
    assert.equal(res.operation.capability, 'executive.prepare');
    assert.deepEqual(stepsOf(res), []);
    says(res.display, [
      'No plan was recorded, and nothing has run.',
      'Parts of the request that no registered capability can take (1):',
      '  - "me a plan please" - no registered action matches this part of the request',
      'Nothing was recorded, so there is no plan waiting for approval and nothing is queued to run.',
    ], 'unmapped answer');
    assert.equal((await app.plans.list()).length, 0);
  } finally {
    cleanup(dir);
  }
});

test('a preparation that names only a goal with nothing left to match says so instead of printing an empty list', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await openApp(dir);
    // The goal supports no candidate, so the bridge falls back to the user's own words - and once the
    // goal reference is taken out of that sentence, there are no words left to map.
    const goalId = await goalOf(app, { request: 'archive the vault', criteria: ['the vault is archived'] });
    const res = await app.controller.handle(`prepare a plan for goal ${goalId}`, { origin: 'user' });
    assert.equal(res.status, Outcome.PLAN_REJECTED, res.output);
    assert.deepEqual(stepsOf(res), ['plan.candidates:success_verified']);
    says(res.display, [
      `Goal ${short(goalId)} supports no candidate plan the records can compare (no-capability), so the draft below was worked up from your own words rather than selected from a comparison of approaches. APEX inferred nothing about that goal to make it.`,
      'No plan was recorded, and nothing has run.',
      'Nothing in the request names work for APEX to plan: once the goal reference is taken out, no part of the request is left to match against a registered capability.',
      'Say what the plan should do beside the goal, for example: prepare a plan to remember that <fact> for goal <goal-id>',
    ], 'goal-only preparation answer');
    // A count of unmapped parts is printed only when a part is actually named.
    neverSays(res.display, ['no registered capability can take (0):'], 'goal-only preparation answer');
    assert.equal((await plansFor(app, goalId)).length, 0);
  } finally {
    cleanup(dir);
  }
});
