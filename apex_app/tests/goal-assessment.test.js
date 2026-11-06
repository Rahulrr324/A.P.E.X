// Goal assessment: what a goal claims about its own evidence, checked against what the other
// stores hold now.
//
// These tests go through the real controller and the real append-only stores against a temporary
// data directory. They cover Batch AL work packages B and F on the read side: a proof that is still
// in the log but has been withdrawn from the knowledge store is not the same thing as a proof that
// still stands, a citation the audit log does not contain is reported rather than trusted, and what
// the goal is missing comes back as a question instead of as an invented criterion. Two tests use a
// labelled hand-written goal log line or a labelled test double reader, because the stores refuse to
// write those states themselves - they are exactly the shapes an older log or a failing read can
// produce. No model is used, no inference is run, and nothing here approves or executes anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { EvidenceVerdict, MAX_QUESTIONS, assessGoal } from '../src/goals/assess.js';
import { renderAssessment } from '../src/goals/format.js';
import { SECRET_OMITTED } from '../src/security/secrets.js';
import { makeTempDataDir, cleanup, cleanEnv, runCli } from './helpers.js';

async function appIn(dir) {
  return createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF });
}

function goalIdOf(res) {
  return res.operation.steps[0].result.data.goalId;
}

function claimIdOf(res) {
  return res.operation.steps[0].result.data.id;
}

function operationIdOf(res) {
  return res.operation.id;
}

function request(tag) {
  return `${tag} ${Math.random().toString(36).slice(2, 10)}`;
}

async function activeGoal(app, criteria, tag = 'assessment', extra = {}) {
  const created = await app.controller.goalAdd({ request: request(tag), criteria, ...extra });
  assert.equal(created.status, Outcome.GOAL_CREATED, created.output);
  const id = goalIdOf(created);
  await app.controller.goalUpdate({ target: id, status: 'accepted' });
  await app.controller.goalUpdate({ target: id, status: 'active' });
  return id;
}

// A verified operation that establishes one knowledge claim. Retracting it later is what makes an
// assessment differ from the goal log.
async function claimOperation(app, key, object = 'holds') {
  const res = await app.controller.knowledgeAdd({
    subject: `assess subject ${key}`,
    relationship: 'was checked by',
    object: `${key} ${object}`,
  });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
  return { operationId: operationIdOf(res), claimId: claimIdOf(res) };
}

// The goal log's own `goal_evidence` line, copied and changed. The stores will not write either of
// the shapes below - goal.evidence checks the audit log first - so a labelled fixture is the only
// honest way to produce them.
function appendEvidenceLine(dir, goalId, { criterionId, operationId }) {
  const file = path.join(dir, 'goals.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const source = lines.map((l) => JSON.parse(l)).find((e) => e.type === 'goal_evidence');
  const line = { ...source, eventId: randomUUID(), goalId, criterionId, operationId };
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
}

function readAll(dir, name) {
  const file = path.join(dir, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

test('a standing proof is reported as standing, and the assessment writes nothing anywhere', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const first = await claimOperation(app, 'standing');
    const id = await activeGoal(app, ['the claim is recorded', 'the stale claim is retracted']);
    await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'supports', operationId: first.operationId });
    // A retraction is a verified success that establishes no claim of its own: the assessment says
    // that plainly instead of claiming every record it wrote still stands.
    const retraction = await app.controller.knowledgeRetract({ target: first.claimId, reason: 'the test replaced it' });
    assert.equal(retraction.status, Outcome.SUCCESS_VERIFIED, retraction.output);
    await app.controller.goalEvidence({ target: id, criterion: 'c2', kind: 'supports', operationId: operationIdOf(retraction) });

    const before = {
      'goals.jsonl': readAll(dir, 'goals.jsonl'),
      'knowledge.jsonl': readAll(dir, 'knowledge.jsonl'),
      'operations.jsonl': readAll(dir, 'operations.jsonl'),
      'plans.jsonl': readAll(dir, 'plans.jsonl'),
    };
    const res = await app.controller.assessStoredGoal(id);
    const text = res.display;

    // c1's own proof was withdrawn by the very operation that proves c2, so c1 is stale while c2 is
    // current. The goal log records both as satisfied; only the read can tell them apart.
    assert.equal(res.assessment.criteria[0].verdict, EvidenceVerdict.STALE);
    assert.equal(res.assessment.criteria[1].verdict, EvidenceVerdict.CURRENT);
    assert.match(text, /established no knowledge record, so nothing has been withdrawn from it/);
    assert.match(text, /2 criterion\(s\): 1 current, 1 withdrawn since recorded/);
    assert.equal(res.assessment.ok, false, 'a withdrawn proof is a finding, not a clean read');
    assert.equal(res.goal.status, 'active', 'the read changes no status');

    for (const [name, bytes] of Object.entries(before)) {
      assert.equal(readAll(dir, name), bytes, `${name} is untouched by the assessment`);
    }
    assert.deepEqual(res.assessment.uncheckable, [], 'both stores were available, so nothing was uncheckable');
    assert.match(text, /Nothing was written, linked, completed, or run by this read/);
  } finally {
    cleanup(dir);
  }
});

test('evidence that was retracted after it was recorded reads back as withdrawn, not as satisfied', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { operationId, claimId } = await claimOperation(app, 'retract');
    const id = await activeGoal(app, ['the claim is recorded', 'search prefers the correction']);
    await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'supports', operationId });

    const before = await app.controller.assessStoredGoal(id);
    assert.equal(before.assessment.criteria[0].verdict, EvidenceVerdict.CURRENT);
    assert.equal(before.assessment.ok, true);
    assert.match(before.display, /the proof still stands/);
    assert.match(before.display, /1 record\(s\) it established is still current/);

    await app.controller.knowledgeRetract({ target: claimId, reason: 'it was wrong about the deploy window' });
    const after = await app.controller.assessStoredGoal(id);
    const c1 = after.assessment.criteria[0];
    assert.equal(c1.status, 'satisfied', 'the goal log still says what was recorded then');
    assert.equal(c1.verdict, EvidenceVerdict.STALE);
    assert.match(c1.reason, /is retracted/);
    assert.equal(after.assessment.ok, false);
    assert.match(after.display, /NO LONGER HOLDS .* \(retracted - it was wrong about the deploy window\)/);
    assert.match(after.display, /the proof recorded for c1 has since been withdrawn/);
    // c2 is only awaiting evidence: nothing here turns a missing proof into a failure.
    assert.equal(after.assessment.counts.none, 1);
    assert.equal(after.assessment.counts.stale, 1);
    // The goal is unchanged by the read: it is still active with the same satisfied count.
    assert.equal(after.assessment.progress.satisfied, 1);
    assert.equal(after.goal.status, 'active');
  } finally {
    cleanup(dir);
  }
});

test('a superseded proof reads back as withdrawn and names the record that replaced it', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { operationId, claimId } = await claimOperation(app, 'supersede', 'the first answer');
    const id = await activeGoal(app, ['the answer is recorded']);
    await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'supports', operationId });

    const replacement = await app.controller.knowledgeAdd({
      subject: 'assess subject supersede',
      relationship: 'was checked by',
      object: 'the second answer',
      supersedes: [claimId],
    });
    assert.equal(replacement.status, Outcome.SUCCESS_VERIFIED, replacement.output);

    const res = await app.controller.assessStoredGoal(id);
    const record = res.assessment.criteria[0].evidence[0].records[0];
    assert.equal(record.active, false);
    assert.equal(record.state, 'superseded');
    assert.match(record.note, /^replaced by /);
    assert.match(res.display, /NO LONGER HOLDS .* \(superseded - replaced by [0-9a-f]{8}\)/);
    // The replacement is itself current, so the withdrawal is reported as a retirement, not as an
    // unknown state, and the goal still owes the user nothing but the finding.
    assert.equal(res.assessment.counts.stale, 1);
    assert.equal(res.assessment.ok, false);
  } finally {
    cleanup(dir);
  }
});

test('support the audit log does not hold, or holds only as a refusal, is reported as unsupported', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const id = await activeGoal(app, ['the claim is recorded', 'the correction is stored']);
    const good = await claimOperation(app, 'cited');
    await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'supports', operationId: good.operationId });
    // A refused write is still an audit record; it just does not verify anything.
    const refused = await app.controller.knowledgeAdd({
      subject: 'assess subject refused', relationship: 'r', object: 'rotate the deploy password: hunter2secret',
    });
    assert.equal(refused.status, Outcome.INPUT_REJECTED, refused.output);

    appendEvidenceLine(dir, id, { criterionId: 'c1', operationId: randomUUID() });
    appendEvidenceLine(dir, id, { criterionId: 'c2', operationId: operationIdOf(refused) });

    const res = await app.controller.assessStoredGoal(id);
    assert.equal(res.assessment.criteria[0].verdict, EvidenceVerdict.INVALID);
    assert.match(res.assessment.criteria[0].reason, /is not in the audit log/);
    assert.match(res.display, /not supported by the audit log/);
    // The later hand-written support is the one that has to hold; the verified operation before it
    // does not carry the criterion.
    assert.equal(res.assessment.criteria[0].evidence.length, 2);
    assert.equal(res.assessment.criteria[1].verdict, EvidenceVerdict.INVALID);
    assert.match(res.assessment.criteria[1].reason, /ended as input_rejected/);
    assert.equal(res.assessment.counts.invalid, 2);
    assert.equal(res.assessment.ok, false);
    assert.equal(readAll(dir, 'goals.jsonl').trim().split('\n').length, 6, 'the read appended no goal event');
  } finally {
    cleanup(dir);
  }
});

test('a plan assertion citing a withdrawn record no longer validates, and a current one still does', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const step = {
      id: 's1',
      description: 'remember the fact',
      action: 'memory.add',
      input: { content: 'an assessment validity fact' },
      expectedResult: 'the fact is stored',
      verification: 'the record is read back',
    };
    const stale = await claimOperation(app, 'plan-assertion');
    const live = await claimOperation(app, 'plan-assertion-live');
    const added = await app.controller.planAdd({
      outcome: 'the fact is stored',
      steps: [step],
      assertions: [
        { kind: 'stored_knowledge', ref: stale.claimId, text: 'the claim the plan leans on' },
        { kind: 'stored_knowledge', ref: live.claimId, text: 'a claim that still stands' },
      ],
    });
    assert.equal(added.status, Outcome.PLAN_STORED, added.output);
    const planId = added.operation.steps[0].result.data.planId;

    const before = await app.controller.validateStoredPlan(planId);
    assert.equal(before.validation.ok, true, before.display);

    await app.controller.knowledgeRetract({ target: stale.claimId, reason: 'the assessment test withdrew it' });
    const after = await app.controller.validateStoredPlan(planId);
    assert.equal(after.validation.ok, false, 'a retracted claim cannot support a plan assertion');
    const assertionCheck = after.validity.checks.find((c) => c.check === 'assertions');
    assert.match(assertionCheck.detail, new RegExp(`${stale.claimId} is retracted`));
    assert.doesNotMatch(assertionCheck.detail, new RegExp(`${live.claimId} is retracted`), 'the current claim stays valid');
    assert.match(after.display, /evidence the record/);

    // A record that never existed is still reported the way it always was.
    const missing = await app.controller.planAdd({
      outcome: 'nothing cites a real record',
      steps: [step],
      assertions: [{ kind: 'retrieved_evidence', ref: randomUUID(), text: 'a record that is not there' }],
    });
    const missingCheck = (await app.controller.validateStoredPlan(missing.operation.steps[0].result.data.planId))
      .validity.checks.find((c) => c.check === 'assertions');
    assert.match(missingCheck.detail, /no longer resolves/);
  } finally {
    cleanup(dir);
  }
});

test('a criterion that names a record is checked against that record, and one that names nothing is said so', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { claimId } = await claimOperation(app, 'named');
    const id = await activeGoal(app, [
      { description: 'the recorded fact is still the fact', ref: claimId },
      { description: 'a fact from somewhere else', ref: '00000000-0000-4000-8000-000000000000' },
    ], 'named', {
      prerequisites: [
        { text: 'the deployment window is known', basis: 'verified_fact', ref: claimId },
        'a test double reader is not needed',
      ],
    });

    const res = await app.controller.assessStoredGoal(id);
    assert.equal(res.assessment.records.length, 3, 'two criteria and one prerequisite each name a record');
    const named = res.assessment.records[0];
    assert.equal(named.found, true);
    assert.equal(named.active, true);
    const unknown = res.assessment.records[1];
    assert.equal(unknown.found, false);
    assert.equal(unknown.state, 'no such knowledge record');
    assert.match(unknown.detail, /the goal does not name which other store it belongs to/);
    assert.match(res.display, /criterion c2 -> 00000000-0000-4000-8000-000000000000: not readable back/);
    assert.match(res.display, /prerequisites "the deployment window is known"/);
    // A reference APEX cannot read back is a question, not an answer: the assessment does not
    // decide that the fact is wrong, and it does not invent where it came from.
    const question = res.assessment.questions.find((q) => q.includes('not a knowledge record APEX can read back'));
    assert.ok(question, 'the unreadable citation is asked about');
    assert.match(question, /Where does that fact come from\?/);
    // Nothing here is a proof: no criterion carries evidence, so none is satisfied.
    assert.equal(res.assessment.counts.none, 2);
  } finally {
    cleanup(dir);
  }
});

test('questions come only from what the goal records, and the bound is stated', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    // 7 open required criteria and 2 recorded unknowns is 9 questions, one more than the bound:
    // the printed set is the fixed order, and the held-back remainder is announced rather than lost.
    const criteria = Array.from({ length: 7 }, (_, i) => `criterion ${i + 1} is still open`);
    const id = await activeGoal(app, criteria, 'bounded', {
      unknowns: ['who owns the corrected index', 'whether the old reader is still deployed'],
    });

    const res = await app.controller.assessStoredGoal(id);
    assert.equal(res.assessment.questions.length, MAX_QUESTIONS);
    assert.equal(res.assessment.questionsTruncated, true);
    assert.equal(res.assessment.questionsHeldBack, 1);
    assert.match(res.display, /\(1 further question\(s\) of the same kind are not printed\)/);
    // Every printed question names where it came from, and none of them proposes a criterion.
    for (const q of res.assessment.questions) {
      assert.match(q, /c\d+|the goal records an unknown/);
      assert.doesNotMatch(q, /APEX suggests|you should probably/);
    }
    assert.ok(res.assessment.questions.some((q) => /What would you accept as proof\?/.test(q)));
    assert.ok(res.assessment.questions.some((q) => /Can you settle it, or should it stay open\?/.test(q)));
    assert.equal(res.assessment.ok, true, 'an open goal with no evidence recorded is not a damaged one');
  } finally {
    cleanup(dir);
  }
});

test('a completed goal reports a withdrawn proof, and asks only what a closed goal can still settle', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { operationId, claimId } = await claimOperation(app, 'completed');
    const created = await app.controller.goalAdd({
      request: request('completed'),
      criteria: ['the claim is recorded'],
      unknowns: ['who owns the corrected index'],
    });
    assert.equal(created.status, Outcome.GOAL_CREATED, created.output);
    const id = goalIdOf(created);
    await app.controller.goalUpdate({ target: id, status: 'accepted' });
    await app.controller.goalUpdate({ target: id, status: 'active' });
    await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'supports', operationId });
    const done = await app.controller.goalComplete({ target: id });
    assert.equal(done.status, Outcome.GOAL_COMPLETED, done.output);

    const whileClean = await app.controller.assessStoredGoal(id);
    assert.equal(whileClean.assessment.ok, true);
    // An unknown is not a finding, and a closed goal is not asked to settle one.
    assert.deepEqual(whileClean.assessment.questions, [], 'a clean, closed goal is asked nothing');

    await app.controller.knowledgeRetract({ target: claimId, reason: 'withdrawn after the goal closed' });
    const res = await app.controller.assessStoredGoal(id);
    assert.equal(res.assessment.status, 'completed');
    assert.equal(res.assessment.open, false);
    assert.equal(res.assessment.criteria[0].verdict, EvidenceVerdict.STALE);
    assert.equal(res.assessment.ok, false);
    // A withdrawn proof is asked about even after completion, because only the user can reopen the
    // goal or record what replaced the claim. The open-only questions stay suppressed.
    assert.deepEqual(res.assessment.questions, [
      'the proof recorded for c1 has since been withdrawn from the knowledge record. What stands in its place, if anything?',
    ]);
    assert.doesNotMatch(res.display, /who owns the corrected index/, 'a closed goal is not asked about its unknowns');
    assert.match(res.display, /These findings change no record/);
    assert.equal(res.goal.status, 'completed', 'the assessment did not reopen the goal');
  } finally {
    cleanup(dir);
  }
});

test('contradicting evidence on record is reported as a contradiction, not as an absence of proof', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { operationId } = await claimOperation(app, 'contradicted');
    const id = await activeGoal(app, ['the claim is recorded']);
    await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'supports', operationId });
    const contra = await app.controller.goalEvidence({
      target: id, criterion: 'c1', kind: 'contradicts', detail: 'the correction was reverted on the next run',
    });
    assert.equal(contra.status, Outcome.GOAL_UPDATED, contra.output);

    const res = await app.controller.assessStoredGoal(id);
    const c1 = res.assessment.criteria[0];
    assert.equal(c1.status, 'contradicted');
    assert.equal(c1.verdict, EvidenceVerdict.CONTRADICTED);
    assert.equal(c1.contradictedDetail, 'the correction was reverted on the next run');
    assert.equal(res.assessment.ok, false);
    assert.match(res.display, /contradicted by later evidence/);
    assert.match(res.display, /Do you want to revise the goal, block it, or record what resolves the contradiction\?/);
    assert.equal(res.assessment.counts.contradicted, 1);
  } finally {
    cleanup(dir);
  }
});

test('a store that cannot be read is reported as not checkable rather than as a clean result', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { operationId } = await claimOperation(app, 'missing-reader');
    const id = await activeGoal(app, ['the claim is recorded']);
    await app.controller.goalEvidence({ target: id, criterion: 'c1', kind: 'supports', operationId });
    const { goal } = await app.controller.showGoal(id);

    const noKnowledge = await assessGoal(goal, { operations: app.operations, plans: app.plans });
    assert.equal(noKnowledge.ok, false);
    assert.ok(noKnowledge.uncheckable.some((u) => /no knowledge store is available/.test(u)));
    // The operation itself is still a verified success; only its reach into the knowledge store is
    // unknown, so the verdict is `unverifiable` and not `invalid`.
    assert.equal(noKnowledge.criteria[0].verdict, EvidenceVerdict.UNVERIFIABLE);
    assert.match(noKnowledge.criteria[0].reason, /no knowledge store is available/);
    assert.equal(noKnowledge.criteria[0].evidence[0].verdict, EvidenceVerdict.UNVERIFIABLE);

    const noAudit = await assessGoal(goal, { knowledge: app.knowledge, plans: app.plans });
    assert.equal(noAudit.ok, false);
    assert.ok(noAudit.uncheckable.some((u) => /no audit log is available/.test(u)));
    assert.equal(noAudit.criteria[0].verdict, EvidenceVerdict.UNVERIFIABLE);
  } finally {
    cleanup(dir);
  }
});

test('a linked plan is reported by its live status, and an unreadable one is reported as unreadable', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const id = await activeGoal(app, ['the fact is stored']);
    const added = await app.controller.planAdd({
      goalId: id,
      outcome: 'the fact is stored',
      steps: [{
        id: 's1', description: 'remember the fact', action: 'memory.add',
        input: { content: 'an assessment plan fact' },
        expectedResult: 'the fact is stored', verification: 'the record is read back',
      }],
    });
    assert.equal(added.status, Outcome.PLAN_STORED, added.output);
    const planId = added.operation.steps[0].result.data.planId;

    const asDraft = await app.controller.assessStoredGoal(id);
    assert.deepEqual(asDraft.assessment.plans, [{ id: planId, found: true, status: 'draft', detail: null }]);
    assert.match(asDraft.display, new RegExp(`${planId.slice(0, 8)} draft`));
    assert.doesNotMatch(asDraft.display, /nothing has been proposed for this goal/);

    assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);
    const asApproved = await app.controller.assessStoredGoal(id);
    assert.equal(asApproved.assessment.plans[0].status, 'approved');
    assert.equal(asApproved.assessment.ok, true, 'a plan is intent, not evidence: its status changes no verdict');

    // A goal hand-linked to a plan that is not in the plan store says so instead of failing.
    const other = await activeGoal(app, ['another intention'], 'dangling-plan');
    const link = await app.controller.goalLink({ target: other, planId: randomUUID() });
    assert.equal(link.status, Outcome.GOAL_UPDATED, link.output);
    const res = await app.controller.assessStoredGoal(other);
    assert.equal(res.assessment.plans[0].found, false);
    assert.match(res.assessment.plans[0].detail, /no plan/);
    assert.match(res.display, /cannot be read/);
    // The same goal read without a plan store reports that the link could not be looked at at all.
    const { goal: dangling } = await app.controller.showGoal(other);
    const noPlans = await assessGoal(dangling, { knowledge: app.knowledge, operations: app.operations });
    assert.equal(noPlans.plans[0].found, false);
    assert.match(noPlans.plans[0].detail, /no plan store is available/);
  } finally {
    cleanup(dir);
  }
});

test('assessment verdicts for evidence shapes only a hand-written goal log can hold', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const { operationId } = await claimOperation(app, 'synthetic');
    // A labelled goal object, assembled here rather than read from a store, to check what the
    // derivation says about each evidence shape. The real stores refuse to write these.
    const goal = {
      id: randomUUID(),
      status: 'active',
      origin: 'user',
      request: 'a synthetic goal',
      revision: 1,
      priority: 3,
      deadline: null,
      dependsOn: [],
      criteria: [
        { id: 'c1', description: 'a support with no operation named', basis: 'user_stated', requirement: 'required', status: 'satisfied', confirmation: null, requiredEvidence: null, ref: null, updatedAt: '2026-01-01T00:00:00.000Z', evidence: [{ kind: 'supports', operationId: null, detail: null, at: '2026-01-01T00:00:00.000Z' }] },
        { id: 'c2', description: 'satisfied with nothing behind it', basis: 'user_stated', requirement: 'required', status: 'satisfied', confirmation: null, requiredEvidence: null, ref: null, updatedAt: '2026-01-01T00:00:00.000Z', evidence: [] },
        { id: 'c3', description: 'a real, current proof', basis: 'user_stated', requirement: 'required', status: 'satisfied', confirmation: null, requiredEvidence: null, ref: null, updatedAt: '2026-01-01T00:00:00.000Z', evidence: [{ kind: 'supports', operationId, detail: null, at: '2026-01-01T00:00:00.000Z' }] },
      ],
      prerequisites: [], constraints: [], resources: [], timeConditions: [], blockers: [], unknowns: [],
      completion: null, planIds: [], taskIds: [], entityIds: [], worldEventIds: [],
      statusHistory: [], revisionHistory: [],
    };

    const res = await assessGoal(goal, { knowledge: app.knowledge, operations: app.operations });
    assert.equal(res.criteria[0].verdict, EvidenceVerdict.INVALID);
    assert.match(res.criteria[0].reason, /the support names no audit operation/);
    assert.equal(res.criteria[1].verdict, EvidenceVerdict.INVALID);
    assert.match(res.criteria[1].reason, /satisfied with no supporting entry/);
    assert.equal(res.criteria[2].verdict, EvidenceVerdict.CURRENT);
    assert.equal(res.counts.invalid, 2);
    assert.equal(res.ok, false);

    // A failing read is somebody else's outage, not a withdrawn proof.
    const unreadableAudit = {
      findById: async () => { throw Object.assign(new Error('locked'), { code: 'data_unavailable' }); },
    };
    const failed = await assessGoal(goal, { knowledge: app.knowledge, operations: unreadableAudit });
    assert.equal(failed.criteria[2].verdict, EvidenceVerdict.UNVERIFIABLE);
    assert.match(failed.criteria[2].reason, /the audit log could not be read \(data_unavailable\)/);
    assert.ok(failed.uncheckable.length === 0, 'the audit log was present, only the read failed');

    const unreadableKnowledge = {
      history: async () => ({ record: null }),
      byOperation: async () => { throw Object.assign(new Error('locked'), { code: 'data_unavailable' }); },
    };
    const afterStore = await assessGoal(goal, { knowledge: unreadableKnowledge, operations: app.operations });
    assert.equal(afterStore.criteria[2].verdict, EvidenceVerdict.UNVERIFIABLE);
    assert.match(afterStore.criteria[2].reason, /the knowledge store could not be read/);
  } finally {
    cleanup(dir);
  }
});

test('the assessment renderer masks a credential it is handed instead of printing it', () => {
  const secret = 'rotate the deploy password: hunter2secret';
  const goal = { id: randomUUID(), status: 'active' };
  const assessment = {
    counts: { current: 0, stale: 0, invalid: 1, unverifiable: 0, contradicted: 0, none: 0 },
    criteria: [{
      id: 'c1', status: 'satisfied', description: 'the note is stored',
      verdict: 'invalid', reason: secret,
      evidence: [{ kind: 'supports', records: [{ active: false, shortId: 'deadbeef', triple: secret, state: 'retracted', note: secret }] }],
    }],
    records: [], plans: [], uncheckable: [secret], questions: [secret],
    questionsTruncated: false, questionsHeldBack: 0, ok: false,
  };

  const text = renderAssessment(goal, assessment);
  assert.ok(text.includes(SECRET_OMITTED), 'the masked marker is printed');
  assert.doesNotMatch(text, /hunter2secret/, 'the credential value never reaches the output');
  assert.match(text, /not supported by the audit log/);
  assert.match(text, /What APEX could not check/);
});

test('the CLI prints the assessment, uses its exit status, and lists the read in its help', async () => {
  const dir = makeTempDataDir();
  try {
    const app = await appIn(dir);
    const env = cleanEnv({ APEX_DATA_DIR: dir });
    const { operationId, claimId } = await claimOperation(app, 'cli');
    const goalId = goalIdOf(await app.controller.goalAdd({
      request: request('cli assessment'), criteria: ['the claim is recorded', 'the correction is stored'],
    }));

    const proposed = await runCli(['goal', 'assess', goalId], env);
    assert.equal(proposed.code, 0, proposed.stderr);
    assert.match(proposed.stdout, /Goal [0-9a-f]{8} \(proposed\) - evidence assessment/);
    assert.match(proposed.stdout, /2 criterion\(s\): 2 awaiting evidence/);

    await runCli(['goal', 'update', goalId, 'accepted'], env);
    await runCli(['goal', 'update', goalId, 'active'], env);
    await runCli(['goal', 'evidence', goalId, '--criterion', 'c1', '--kind', 'supports', '--operation', operationId], env);
    const clean = await runCli(['goal', 'assess', goalId], env);
    assert.equal(clean.code, 0, clean.stderr);
    assert.match(clean.stdout, /the proof still stands/);

    await runCli(['knowledge', 'retract', claimId, '--reason', 'the cli test withdrew it'], env);
    const found = await runCli(['goal', 'assess', goalId], env);
    assert.equal(found.code, 1, 'a withdrawn proof is reported through the exit status');
    assert.match(found.stdout, /withdrawn after it was recorded/);

    const usage = await runCli(['goal', 'assess'], env);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /usage: goal assess <id>/);
    const unknown = await runCli(['goal', 'nonsense'], env);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /goal add\|revise\|confirm\|list\|show\|assess\|update\|evidence\|complete\|link/);
    const help = await runCli(['--help'], env);
    assert.match(help.stdout, /goal assess <id>.*read-only/);
    assert.match(help.stdout, /goal assess <goal-id>/);

    assert.equal((await app.controller.showGoal(goalId)).goal.status, 'active', 'the reads changed nothing');
  } finally {
    cleanup(dir);
  }
});
