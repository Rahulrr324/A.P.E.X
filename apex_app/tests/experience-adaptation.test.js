// Batch Z: the five controlled states, and how a rule moves through them.
//
// Experience -> feedback -> candidate -> approved -> active is the whole claim of this capability,
// so this suite walks it through the assembled application: every event is an audited operation,
// every write goes through the controller and the action's own independent verification, and every
// state a test asserts is one a reader of the store would derive from the log. Fixtures are
// deterministic and no inference is run or simulated: a model-origin request is refused by the
// registry because no model authorized it, not because a stub was told to refuse.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { sha256Hex } from '../src/memory/memory-store.js';
import { normalizeRuleText, DERIVATION_METHOD, MIN_SUPPORT_FEEDBACK } from '../src/experience/derivation.js';
import { MAX_SUPPORT_REFS } from '../src/experience/experience-store.js';

const CLOCK = () => new Date('2026-11-01T09:00:00.000Z');
const dirs = [];

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function app() {
  return createApp({ dataDir: tempDir(), now: CLOCK });
}

afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop());
});

// One experience of one real audited event, returned as the record a later reader resolves.
async function exp(target, request) {
  const res = await target.controller.handle(request, { origin: 'user' });
  const rec = await target.controller.experienceRecord({ operationId: res.operation.id, subject: 'what APEX did here' });
  assert.equal(rec.status, Outcome.SUCCESS_VERIFIED, rec.display ?? rec.output);
  const [record] = await target.experience.list({ limit: 1 });
  return { op: res.operation, id: record.id, capability: record.capability };
}

async function fb(target, expId, guidance, assessment = 'incorrect') {
  const res = await target.controller.feedbackRecord({ target: expId, assessment, guidance });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
  return res;
}

async function derive(target, minSupport = MIN_SUPPORT_FEEDBACK) {
  return target.controller.adaptationDerive({ minSupport });
}

function derivationResult(res) {
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
  return res.operation.steps[0].result.data;
}

function logLines(target) {
  if (!fs.existsSync(target.experience.filePath)) return 0;
  return fs.readFileSync(target.experience.filePath, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
}

// Two experiences, the same corrective guidance on both, and one derived candidate: the state every
// test below starts from, reached through the real request path.
async function readyRule() {
  const a = app();
  const e1 = await exp(a, 'remember that the first report was undated');
  const e2 = await exp(a, 'remember that the second report was undated');
  await fb(a, e1.id, 'put the date at the top');
  await fb(a, e2.id, 'put the date at the top');
  const { created } = derivationResult(await derive(a));
  assert.equal(created.length, 1);
  return { a, candidate: created[0], experiences: [e1, e2] };
}

describe('A. a candidate is derived only from repeated, corrective, user-stated guidance', () => {
  test('two experiences answered by the same corrective guidance yield one candidate', async () => {
    const a = app();
    const e1 = await exp(a, 'remember that the first review ran late');
    const e2 = await exp(a, 'remember that the second review ran late');
    const g1 = await fb(a, e1.id, 'state the review date before anything else');
    await fb(a, e2.id, 'state the review date before anything else');

    const { created, skipped, minSupport } = derivationResult(await derive(a));
    assert.equal(minSupport, MIN_SUPPORT_FEEDBACK);
    assert.equal(created.length, 1, 'one repeated request yields exactly one candidate');
    assert.equal(skipped.length, 0);

    const stored = await a.experience.adaptationDetail(created[0].id);
    assert.equal(stored.kind, 'adaptation');
    assert.equal(stored.capability, 'memory.add', 'the candidate is scoped to the capability the events belonged to');
    assert.equal(stored.rule, 'state the review date before anything else', 'the rule text is the user\'s own words');
    assert.equal(stored.ruleHash, sha256Hex(normalizeRuleText(stored.rule)));
    assert.equal(stored.method, DERIVATION_METHOD);
    assert.equal(stored.minSupport, 2);
    assert.deepEqual(stored.support.experienceIds, [e1.id, e2.id]);
    assert.deepEqual(stored.support.feedbackIds, [
      g1.operation.steps[0].result.data.id,
      (await a.experience.feedbackFor(e2.id)).current[0].id,
    ]);
    assert.deepEqual(
      { origin: stored.provenance.origin, updateMode: stored.provenance.updateMode },
      { origin: 'deterministic_derivation', updateMode: 'candidate_unapproved' },
    );
    assert.equal(stored.decisionState, 'candidate');
    assert.equal(stored.active, false);
    assert.equal(stored.decision, null, 'no decision exists yet');
  });

  test('one experience is an event, not a pattern', async () => {
    const a = app();
    const e1 = await exp(a, 'remember that the review ran late once');
    await fb(a, e1.id, 'state the review date before anything else');

    const { created, skipped } = derivationResult(await derive(a));
    assert.equal(created.length, 0, 'a single observation never becomes a rule');
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /1 supporting experience\(s\); 2 are required/);
    assert.equal(skipped[0].capability, 'memory.add');
    assert.equal((await a.experience.adaptations()).length, 0);
    assert.equal(logLines(a), 2, 'only the experience and its feedback are in the log');
  });

  test('repeating feedback on one experience does not manufacture a second observation', async () => {
    const a = app();
    const e1 = await exp(a, 'remember that the review ran late again');
    await fb(a, e1.id, 'state the review date before anything else');
    await fb(a, e1.id, 'state the review date before anything else', 'user_correction');

    const { created, skipped } = derivationResult(await derive(a));
    assert.equal(created.length, 0, 'one experience supports a candidate once');
    assert.match(skipped[0].reason, /1 supporting experience\(s\); 2 are required/);
  });

  test('only a corrective assessment can support a rule', async () => {
    const a = app();
    for (const assessment of ['correct', 'useful', 'partially_correct', 'outcome_succeeded']) {
      const e = await exp(a, `remember that result ${assessment} happened`);
      await fb(a, e.id, 'state the review date before anything else', assessment);
    }

    const { created } = derivationResult(await derive(a, 1));
    assert.equal(created.length, 0, 'an assessment that agrees with the result cannot say what to change');
    assert.equal((await a.experience.adaptations()).length, 0);
  });

  test('a corrective assessment with no guidance asks for nothing', async () => {
    const a = app();
    const e1 = await exp(a, 'remember that the first answer missed the point');
    const e2 = await exp(a, 'remember that the second answer missed the point');
    await a.controller.feedbackRecord({ target: e1.id, assessment: 'incorrect' });
    await a.controller.feedbackRecord({ target: e2.id, assessment: 'incorrect' });

    const { created } = derivationResult(await derive(a));
    assert.equal(created.length, 0, 'silence about what to change is not a request for a rule');
    const health = await a.experience.health();
    assert.equal(health.pending.derivableCandidates, 0);
  });

  test('guidance is grouped past case and spacing but the rule keeps the first wording', async () => {
    const a = app();
    const e1 = await exp(a, 'remember that the first review was undated');
    const e2 = await exp(a, 'remember that the second review was undated');
    await fb(a, e1.id, 'Give the date   FIRST');
    await fb(a, e2.id, 'give the date first');

    const { created } = derivationResult(await derive(a));
    assert.equal(created.length, 1, 'the same request stated twice is one group whatever the typing');
    assert.equal(created[0].rule, 'Give the date   FIRST', 'the rule is the user\'s first words, verbatim');
    const stored = await a.experience.adaptationDetail(created[0].id);
    assert.equal(stored.ruleHash, sha256Hex('give the date first'));
    assert.equal(stored.support.experienceIds[0], e1.id, 'store order decides which wording survives');
  });

  test('a rule asked for in one scope says nothing about another', async () => {
    const a = app();
    const memo = await exp(a, 'remember that the memory review ran late');
    const listed = await a.controller.knowledgeList({ limit: 1 });
    assert.equal(listed.operation.capability, 'knowledge.list', 'the fixture needs a second capability scope');
    const know = await a.controller.experienceRecord({ operationId: listed.operation.id, subject: 'a knowledge read' });
    assert.equal(know.status, Outcome.SUCCESS_VERIFIED, know.display ?? know.output);
    const knowId = (await a.experience.list({ limit: 1 }))[0].id;

    await fb(a, memo.id, 'state the review date before anything else');
    await fb(a, knowId, 'state the review date before anything else');
    let { created } = derivationResult(await derive(a));
    assert.equal(created.length, 0, 'two different scopes are not one repeated request');

    const second = await exp(a, 'remember that the second memory review ran late');
    await fb(a, second.id, 'state the review date before anything else');
    ({ created } = derivationResult(await derive(a)));
    assert.equal(created.length, 1);
    assert.equal(created[0].capability, 'memory.add', 'only the scope the repetition happened in is adapted');
    assert.deepEqual(created[0].support.experienceIds, [memo.id, second.id]);
  });

  test('an experience of a refused request is recorded, and cannot support a rule', async () => {
    const a = app();
    const refused = await a.controller.handle('   ', { origin: 'user' });
    assert.equal(refused.operation.capability, 'none', 'nothing was chosen yet, so nothing can be scoped');

    const rec = await a.controller.experienceRecord({ operationId: refused.operation.id, subject: 'a request that never became an action' });
    assert.equal(rec.status, Outcome.SUCCESS_VERIFIED, rec.display ?? rec.output);
    const [record] = await a.experience.list({ limit: 1 });
    assert.equal(record.capability, 'none', 'the record keeps the capability the event actually had');
    assert.equal(record.adaptationEligible, false);
    assert.match(rec.display, /scope: none/);

    await a.controller.feedbackRecord({ target: record.id, assessment: 'incorrect', guidance: 'ask for the missing detail' });
    const { created } = derivationResult(await derive(a, 1));
    assert.equal(created.length, 0, 'an unscoped event is excluded from derivation even at the lowest threshold');
    const health = await a.experience.health();
    assert.equal(health.anomalies.count, 0, 'an unscoped experience is history, not damage');
    assert.equal(health.attention, false);
  });

  test('deriving twice from the same evidence writes nothing the second time', async () => {
    const a = app();
    const e1 = await exp(a, 'remember that the first schedule slipped');
    const e2 = await exp(a, 'remember that the second schedule slipped');
    await fb(a, e1.id, 'confirm the date before scheduling');
    await fb(a, e2.id, 'confirm the date before scheduling');

    const first = derivationResult(await derive(a));
    assert.equal(first.created.length, 1);
    const before = logLines(a);

    const second = derivationResult(await derive(a));
    assert.equal(second.created.length, 0);
    assert.equal(second.skipped.length, 1);
    assert.match(second.skipped[0].reason, /an adaptation for this scope and rule is already recorded/);
    assert.equal(logLines(a), before, 'a repeat derivation is a read, not a second write');
    assert.equal((await a.experience.adaptations()).length, 1);
  });

  test('the same records derive the same candidates in another process', async () => {
    const a = app();
    const e1 = await exp(a, 'remember that the first handover was late');
    const e2 = await exp(a, 'remember that the second handover was late');
    await fb(a, e1.id, 'name the owner first');
    await fb(a, e2.id, 'name the owner first');
    const dir = dirs[dirs.length - 1];

    // A second application over a copy of the same bytes: nothing is shared in memory, so the only
    // thing that can make these two agree is that the derivation is a function of the log.
    const other = tempDir();
    fs.copyFileSync(path.join(dir, 'experiences.jsonl'), path.join(other, 'experiences.jsonl'));
    fs.copyFileSync(path.join(dir, 'operations.jsonl'), path.join(other, 'operations.jsonl'));
    const b = createApp({ dataDir: other, now: CLOCK });

    const ra = derivationResult(await derive(a));
    const rb = derivationResult(await derive(b));
    assert.equal(ra.created.length, 1);
    assert.equal(rb.created.length, 1);
    const { id: _ida, ...shapeA } = ra.created[0];
    const { id: _idb, ...shapeB } = rb.created[0];
    assert.deepEqual(shapeA, shapeB, 'same evidence, same candidate, down to which records support it');
    assert.notEqual(ra.created[0].id, rb.created[0].id, 'the two processes each wrote their own record');
  });

  test('the support threshold is a bounded integer, and one is a legitimate question', async () => {
    const a = app();
    for (const bad of [0, MAX_SUPPORT_REFS + 1, 2.5, 'two', -1]) {
      const res = await a.controller.adaptationDerive({ minSupport: bad });
      assert.equal(res.status, Outcome.INPUT_REJECTED, `${JSON.stringify(bad)} must be refused as input`);
      assert.match(res.display, /minSupport must be an integer from 1 to 20/);
    }
    assert.equal(logLines(a), 0, 'a refused threshold writes nothing, not even an audit-free candidate');

    const e1 = await exp(a, 'remember that one late review is one event');
    await fb(a, e1.id, 'state the date first');
    const single = derivationResult(await derive(a, 1));
    assert.equal(single.created.length, 1);
    assert.equal(single.created[0].support.experienceIds.length, 1);
    const stored = await a.experience.adaptationDetail(single.created[0].id);
    assert.equal(stored.minSupport, 1, 'the threshold a candidate was derived at is part of its evidence');
    assert.equal(stored.decisionState, 'candidate', 'a lower threshold does not make it any less unapproved');
  });

  test('one candidate cannot carry more support than the reference bound', async () => {
    const a = app();
    const guidance = 'give the summary before the details';
    const ids = [];
    for (let i = 0; i < MAX_SUPPORT_REFS + 1; i += 1) {
      const e = await exp(a, `remember that event number ${i + 1} happened`);
      await fb(a, e.id, guidance);
      ids.push(e.id);
    }

    const { created, skipped } = derivationResult(await derive(a));
    assert.equal(created.length, 0, 'oversized support is refused, not silently cut down');
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, new RegExp(`larger than the ${MAX_SUPPORT_REFS} reference bound`));
    assert.equal(skipped[0].supportingExperienceIds.length, MAX_SUPPORT_REFS, 'the report of the group is itself bounded');
    assert.equal(ids.length, MAX_SUPPORT_REFS + 1);
    assert.equal((await a.experience.adaptations()).length, 0);
  });
});

describe('B. only the user\'s own decision moves a candidate into effect', () => {
  test('a derived candidate changes nothing until it is decided', async () => {
    const { a, candidate } = await readyRule();
    assert.equal(candidate.support.experienceIds.length, 2);

    const listed = await a.controller.adaptationList({ limit: 10 });
    assert.equal(listed.status, Outcome.SUCCESS_VERIFIED, listed.display ?? listed.output);
    assert.match(listed.display, /not approved: no user decision recorded/);
    assert.match(listed.display, /0 in effect/);

    const retrieval = await a.experience.activeAdaptations({ query: 'put the date at the top' });
    assert.deepEqual(retrieval.adaptations, [], 'an undecided candidate is not retrieved');
    assert.equal(retrieval.total, 0);

    const health = await a.experience.health();
    assert.equal(health.candidates, 1);
    assert.equal(health.approved, 0);
    assert.equal(health.activeAdaptations, 0);
    assert.equal(health.attention, false, 'a candidate awaiting a decision is ordinary history');
  });

  test('a model cannot derive, approve, reject, or retire', async () => {
    const { a, candidate } = await readyRule();
    const before = logLines(a);

    const attempts = [
      ['adaptation.derive', { minSupport: 2 }, (store) => store.deriveAdaptations({ origin: 'model' })],
      ['adaptation.decide', { target: candidate.id, decision: 'approved' }, (store) => store.decideAdaptation({ target: candidate.id, decision: 'approved', origin: 'model' })],
      ['adaptation.retire', { target: candidate.id }, (store) => store.retireAdaptation({ target: candidate.id, origin: 'model' })],
    ];
    for (const [name, input, storeCall] of attempts) {
      const step = await a.controller.runAction(name, input, 'model', `op-model-${name}`);
      assert.equal(step.outcome, Outcome.ACTION_DENIED, `${name} must be denied to a model proposal`);
      assert.equal(step.authorization.decision, 'deny');
      assert.equal(step.execution.status, 'not_run', 'a denied request never reaches the store');
      assert.equal(a.registry.get(name).plannable, false, `${name} must not appear in a model plan`);
      const refused = await Promise.resolve(storeCall(a.experience)).then(() => null, (err) => err);
      assert.equal(refused?.code, 'WRITE_REQUIRES_USER_ORIGIN', `and the store refuses ${name} again`);
    }
    assert.equal(logLines(a), before, 'nothing was appended by any of the refused requests');
    assert.equal((await a.experience.adaptationDetail(candidate.id)).decisionState, 'candidate');
  });

  test('approval is the user\'s, is verified by a second read, and is not permission', async () => {
    const { a, candidate } = await readyRule();
    const res = await a.controller.adaptationDecide({ target: candidate.id, decision: 'approved', reason: 'yes, do that' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
    assert.equal(res.operation.capability, 'adaptation.approve');

    const step = res.operation.steps[0];
    assert.equal(step.authorization.decision, 'allow');
    assert.equal(step.verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.match(step.verification.detail, /decision confirmed as the user's own/);
    assert.match(res.display, /It grants no permission: an approved rule never authorizes an action/);

    const detail = await a.experience.adaptationDetail(candidate.id);
    assert.equal(detail.decisionState, 'approved');
    assert.equal(detail.active, true);
    assert.equal(detail.supportState, 'intact');
    assert.equal(detail.decisions.length, 1);
    assert.equal(detail.decisions[0].reason, 'yes, do that');
    assert.equal(detail.decisions[0].operationId, res.operation.id, 'the decision names the user operation that recorded it');
    assert.equal(detail.provenance.updateMode, 'candidate_unapproved', 'the candidate keeps the provenance of how it was produced');

    const retrieval = await a.experience.activeAdaptations({ capability: 'memory.add' });
    assert.deepEqual(retrieval.adaptations.map((x) => x.rule), ['put the date at the top']);
  });

  test('rejection is recorded and changes nothing', async () => {
    const { a, candidate } = await readyRule();
    const res = await a.controller.adaptationDecide({ target: candidate.id, decision: 'rejected' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
    assert.equal(res.operation.capability, 'adaptation.reject');
    assert.match(res.display, /This candidate will not change anything/);

    const detail = await a.experience.adaptationDetail(candidate.id);
    assert.equal(detail.decisionState, 'rejected');
    assert.equal(detail.active, false);
    assert.deepEqual((await a.experience.activeAdaptations({ capability: 'memory.add' })).adaptations, []);

    const health = await a.experience.health();
    assert.equal(health.rejectedAdaptations, 1);
    assert.equal(health.activeAdaptations, 0);
    assert.equal(health.attention, false);
  });

  test('a change of mind is a new decision, and the earlier one stays readable', async () => {
    const { a, candidate } = await readyRule();
    const first = await a.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    assert.match(first.display, /this is the first decision on this candidate/);

    const repeated = await a.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    assert.equal(repeated.status, Outcome.EXECUTION_FAILED);
    assert.match(repeated.display, /is already approved/);

    const flipped = await a.controller.adaptationDecide({ target: candidate.id, decision: 'rejected', reason: 'on second thought' });
    assert.equal(flipped.status, Outcome.SUCCESS_VERIFIED, flipped.display ?? flipped.output);
    assert.match(flipped.display, /earlier decision: approved .* kept as history/);
    assert.equal((await a.experience.adaptationDetail(candidate.id)).active, false);

    const back = await a.controller.adaptationDecide({ target: candidate.id, decision: 'approved', reason: 'actually, yes' });
    assert.equal(back.status, Outcome.SUCCESS_VERIFIED, back.display ?? back.output);

    const detail = await a.experience.adaptationDetail(candidate.id);
    assert.equal(detail.decisionState, 'approved');
    assert.equal(detail.active, true);
    assert.deepEqual(detail.decisions.map((d) => d.decision), ['approved', 'rejected', 'approved']);
    assert.equal(detail.decisions[1].reason, 'on second thought', 'the declined decision is not erased');
    assert.equal((await a.experience.health()).decisions, 3, 'every decision the user made is in the log');
  });

  test('a decision names an adaptation the user can point at', async () => {
    const { a, candidate } = await readyRule();
    const unknown = await a.controller.adaptationDecide({ target: 'ffffffff-ffff-4fff-8fff-ffffffffffff', decision: 'approved' });
    assert.equal(unknown.status, Outcome.EXECUTION_FAILED);
    assert.match(unknown.display, /decision target not found; it must be a derived adaptation record/);

    const byPrefix = await a.controller.adaptationDecide({ target: candidate.id.slice(0, 8), decision: 'approved' });
    assert.equal(byPrefix.status, Outcome.SUCCESS_VERIFIED, byPrefix.display ?? byPrefix.output);
    assert.equal((await a.experience.adaptationDetail(candidate.id)).active, true, 'the short id resolved to the same record');
  });

  test('retiring ends a rule without deleting any of its evidence', async () => {
    const { a, candidate } = await readyRule();
    await a.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    const before = logLines(a);

    const ret = await a.controller.adaptationRetire({ target: candidate.id, reason: 'no longer wanted' });
    assert.equal(ret.status, Outcome.SUCCESS_VERIFIED, ret.display ?? ret.output);
    assert.match(ret.display, /it was approved before this retirement/);
    assert.match(ret.display, /remain in the log and are still readable/);
    assert.match(ret.operation.steps[0].verification.detail, /preserved and excluded from active retrieval/);

    const detail = await a.experience.adaptationDetail(candidate.id);
    assert.equal(detail.decisionState, 'retired');
    assert.equal(detail.active, false);
    assert.equal(detail.rule, candidate.rule, 'the rule text is unchanged');
    assert.equal(detail.support.experienceIds.length, 2, 'the supporting evidence is unchanged');
    assert.deepEqual(detail.decisions.map((d) => d.decision), ['approved'], 'the approval is still readable');
    assert.equal(detail.retirement.reason, 'no longer wanted');
    assert.equal(logLines(a), before + 1, 'retirement appended one event and rewrote nothing');

    assert.deepEqual((await a.experience.activeAdaptations({ capability: 'memory.add' })).adaptations, []);
    const health = await a.experience.health();
    assert.equal(health.retiredAdaptations, 1);
    assert.equal(health.experiences, 2, 'the experiences that supported it are still there');
    assert.equal(health.attention, false);

    const again = await a.controller.adaptationRetire({ target: candidate.id });
    assert.equal(again.status, Outcome.EXECUTION_FAILED);
    assert.match(again.display, /is already retired/);
  });

  test('a retired candidate is ended, not decided, and its evidence can speak again', async () => {
    const a = app();
    const e1 = await exp(a, 'remember that the first summary was buried');
    const e2 = await exp(a, 'remember that the second summary was buried');
    await fb(a, e1.id, 'lead with the summary');
    await fb(a, e2.id, 'lead with the summary');
    const { created } = derivationResult(await derive(a));

    const retired = await a.controller.adaptationRetire({ target: created[0].id });
    assert.equal(retired.status, Outcome.SUCCESS_VERIFIED, retired.display ?? retired.output);
    assert.match(retired.display, /it was candidate before this retirement/, 'a never-decided candidate is reported as one, not as nothing');

    const decided = await a.controller.adaptationDecide({ target: created[0].id, decision: 'approved' });
    assert.equal(decided.status, Outcome.EXECUTION_FAILED);
    assert.match(decided.display, /was retired; derive a new candidate instead of deciding a retired one/);

    const again = derivationResult(await derive(a));
    assert.equal(again.created.length, 1, 'retiring a rule does not retire the user\'s evidence');
    assert.notEqual(again.created[0].id, created[0].id);
    assert.equal(again.created[0].rule, 'lead with the summary');
    assert.equal((await a.experience.adaptationDetail(again.created[0].id)).decisionState, 'candidate', 'and the fresh candidate still needs its own decision');
  });
});

describe('C. support is traceable, and staleness and disagreement stay visible', () => {
  // Appending a raw event line the write paths would refuse: the store is append-only, so a reader
  // must derive a truthful state from bytes it did not write, rather than hide them.
  function appendRaw(target, record) {
    fs.appendFileSync(target.experience.filePath, `${JSON.stringify(record)}\n`);
  }

  function event(kind, targetId, extra = {}) {
    const provenance = kind === 'adaptation_decision'
      ? { origin: 'user_approval', updateMode: 'user_confirmed' }
      : { origin: 'user_retirement', updateMode: 'user_confirmed' };
    return {
      schema: 1,
      kind,
      id: randomUUID(),
      targetId,
      createdAt: CLOCK().toISOString(),
      provenance,
      ...extra,
    };
  }

  test('a rule stops applying when the experience behind it is corrected', async () => {
    const { a, candidate, experiences } = await readyRule();
    const [e1] = experiences;
    const approved = await a.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    assert.equal(approved.status, Outcome.SUCCESS_VERIFIED, approved.display ?? approved.output);
    assert.equal((await a.experience.adaptationDetail(candidate.id)).active, true, 'the rule is in effect before the correction');

    const correction = await a.controller.experienceRecord({
      operationId: e1.op.id, subject: 'a better account of the same event', replaces: [e1.id],
    });
    assert.equal(correction.status, Outcome.SUCCESS_VERIFIED, correction.display ?? correction.output);

    const detail = await a.experience.adaptationDetail(candidate.id);
    assert.equal(detail.decisionState, 'approved', 'the user\'s decision is still what it was');
    assert.equal(detail.supportState, 'stale');
    assert.equal(detail.active, false, 'a rule whose evidence no longer stands is not applied');
    assert.match(detail.inactiveReason, /a supporting experience no longer stands as recorded evidence/);
    assert.deepEqual(detail.supportProblems, [`supporting experience ${e1.id.slice(0, 8)} was corrected by a later record`]);
    assert.deepEqual((await a.experience.activeAdaptations({ capability: 'memory.add' })).adaptations, []);

    const health = await a.experience.health();
    assert.equal(health.approved, 1);
    assert.equal(health.activeAdaptations, 0);
    assert.equal(health.anomalies.count, 1);
    assert.match(health.anomalies.samples[0], /supporting experience .* was corrected by a later record/);
    assert.equal(health.attention, true, 'stale support is the user\'s to notice, not the store\'s to repair');
  });

  test('a rule stops applying when the feedback behind it is corrected', async () => {
    const a = app();
    const e1 = await exp(a, 'remember that the first note was undated');
    const e2 = await exp(a, 'remember that the second note was undated');
    const f1 = await fb(a, e1.id, 'put the date at the top');
    await fb(a, e2.id, 'put the date at the top');
    const { created } = derivationResult(await derive(a));
    await a.controller.adaptationDecide({ target: created[0].id, decision: 'approved' });
    const f1Id = f1.operation.steps[0].result.data.id;

    const corrected = await a.controller.feedbackRecord({
      target: e1.id, assessment: 'incorrect', guidance: 'put the date at the top, then the owner', supersedes: [f1Id],
    });
    assert.equal(corrected.status, Outcome.SUCCESS_VERIFIED, corrected.display ?? corrected.output);

    const detail = await a.experience.adaptationDetail(created[0].id);
    assert.equal(detail.active, false);
    assert.match(detail.inactiveReason, /a piece of supporting feedback has been corrected by later feedback/);
    assert.match(detail.supportProblems[0], /was corrected by later feedback/);
    const health = await a.experience.health();
    assert.equal(health.activeAdaptations, 0);
    assert.equal(health.anomalies.count, 1);
  });

  test('two approved rules in one scope are both shown, and neither wins', async () => {
    const a = app();
    const e1 = await exp(a, 'remember that the first review was unclear');
    const e2 = await exp(a, 'remember that the second review was unclear');
    await fb(a, e1.id, 'put the date at the top');
    await fb(a, e2.id, 'put the date at the top');
    const first = derivationResult(await derive(a)).created[0];
    await a.controller.adaptationDecide({ target: first.id, decision: 'approved' });

    const e3 = await exp(a, 'remember that the third review was unclear');
    const e4 = await exp(a, 'remember that the fourth review was unclear');
    await fb(a, e3.id, 'keep it to one line');
    await fb(a, e4.id, 'keep it to one line');
    const second = derivationResult(await derive(a)).created[0];
    await a.controller.adaptationDecide({ target: second.id, decision: 'approved' });

    const retrieval = await a.experience.activeAdaptations({ capability: 'memory.add', limit: 10 });
    assert.equal(retrieval.total, 2);
    assert.deepEqual(retrieval.adaptations.map((x) => x.rule).sort(), ['keep it to one line', 'put the date at the top']);
    for (const rule of retrieval.adaptations) {
      assert.equal(rule.conflicts.length, 1, `${rule.rule} names the rule it disagrees with`);
      assert.notEqual(rule.conflicts[0].id, rule.id);
    }

    const health = await a.experience.health();
    assert.equal(health.conflicts.scopes, 1);
    assert.equal(health.conflicts.adaptations, 2);
    assert.equal(health.activeAdaptations, 2, 'a conflict does not silently deactivate either rule');
    assert.equal(health.attention, true);

    const listed = await a.controller.adaptationList({ limit: 10 });
    assert.match(listed.display, /conflicts with/);
  });

  test('contradictory retirements are reported as ambiguous, never resolved silently', async () => {
    const { a, candidate } = await readyRule();
    await a.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    await a.controller.adaptationRetire({ target: candidate.id, reason: 'ended' });
    appendRaw(a, event('adaptation_retirement', candidate.id, { reason: 'a second end for the same rule' }));

    const detail = await a.experience.adaptationDetail(candidate.id);
    assert.equal(detail.decisionState, 'ambiguous');
    assert.equal(detail.active, false, 'two retirements do not cancel out into an applied rule');
    assert.equal(detail.retirement, null, 'no single retirement event can be named as the reason');

    const health = await a.experience.health();
    assert.equal(health.ambiguousAdaptations, 1);
    assert.match(health.anomalies.samples.join('\n'), /has 2 retirement records/);
    assert.equal(health.attention, true);

    const shown = await a.controller.adaptationList({ limit: 10 });
    assert.match(shown.display, /contradictory decisions: not applied/);
    const third = await a.controller.adaptationRetire({ target: candidate.id });
    assert.equal(third.status, Outcome.EXECUTION_FAILED, 'the store will not add to the contradiction');
  });

  test('a decision that appears after a retirement does not revive the rule', async () => {
    const { a, candidate } = await readyRule();
    await a.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    await a.controller.adaptationRetire({ target: candidate.id });
    appendRaw(a, event('adaptation_decision', candidate.id, { decision: 'approved' }));

    const detail = await a.experience.adaptationDetail(candidate.id);
    assert.equal(detail.decisionState, 'retired', 'the end the user recorded still governs');
    assert.equal(detail.active, false);
    assert.deepEqual(detail.decisions.map((d) => d.decision), ['approved', 'approved']);

    const health = await a.experience.health();
    assert.match(health.anomalies.samples.join('\n'), /was recorded after adaptation .* was retired/);
    assert.equal(health.attention, true, 'the contradiction is the user\'s to see, not the store\'s to bury');
    assert.deepEqual((await a.experience.activeAdaptations({ capability: 'memory.add' })).adaptations, []);
  });

  test('the adaptation list is bounded and can leave retired rules out', async () => {
    const { a, candidate } = await readyRule();
    await a.controller.adaptationDecide({ target: candidate.id, decision: 'approved' });
    const e3 = await exp(a, 'remember that the third review was unclear');
    const e4 = await exp(a, 'remember that the fourth review was unclear');
    await fb(a, e3.id, 'keep it to one line');
    await fb(a, e4.id, 'keep it to one line');
    const second = derivationResult(await derive(a)).created[0];
    await a.controller.adaptationRetire({ target: second.id });

    const all = await a.controller.adaptationList({ limit: 10 });
    assert.equal(all.operation.steps[0].result.data.records.length, 2);
    assert.match(all.display, /scope memory.add \| retired/);

    const live = await a.controller.adaptationList({ limit: 10, includeRetired: false });
    assert.equal(live.operation.steps[0].result.data.records.length, 1);
    assert.ok(!live.display.includes('keep it to one line'), 'the excluded record is not shown as history either');

    assert.equal((await a.experience.adaptations({ limit: 1 })).length, 1);
    assert.equal((await a.experience.adaptations({ limit: 0 })).length, 1, 'a bound of zero still floors to one record');
    const bad = await a.controller.adaptationList({ limit: 0 });
    assert.equal(bad.status, Outcome.INPUT_REJECTED);
    assert.match(bad.display, /limit must be an integer from 1 to 50/);
    const badFlag = await a.controller.adaptationList({ limit: 5, includeRetired: 'yes' });
    assert.equal(badFlag.status, Outcome.INPUT_REJECTED);
    assert.match(badFlag.display, /includeRetired must be true or false/);
  });
});
