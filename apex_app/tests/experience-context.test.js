// Batch Z: bounded retrieval of approved adaptations, and how the request path uses it.
//
// This is the last mile of the capability: the rules the user approved are retrieved for a later
// request, in a bounded way, and they change wording only. The suite pins the four exclusions the
// store must enforce (undecided, rejected, retired, and an approval whose evidence has been
// corrected), the difference between an empty store and an unreadable one, the disclosure when the
// bound cuts the list, and the trust boundary that a rule the user approved never becomes
// permission for anything. Fixtures are deterministic and no inference is run or simulated: the
// stub model is a local HTTP endpoint that returns fixed text so the prompt the system assembles
// can be read back; it is not a model, and nothing here claims that a real backend was tested.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTempDataDir, cleanup, startStubModel } from './helpers.js';
import { createApp } from '../src/app.js';
import { createGateway, ModelGateway, NoBackend } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { DEFAULT_ACTIVE_ADAPTATIONS, MAX_ACTIVE_ADAPTATIONS } from '../src/experience/experience-store.js';
import { ADAPTATION_DISCIPLINE } from '../src/controller/context.js';

const CLOCK = () => new Date('2026-11-01T09:00:00.000Z');
const dirs = [];
const stubs = [];

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function appNoModel() {
  return createApp({ dataDir: tempDir(), gateway: new ModelGateway({ backend: new NoBackend() }), now: CLOCK });
}

async function appWithModel(reply = 'stub answer') {
  const stub = await startStubModel();
  stubs.push(stub);
  stub.behavior.reply = reply;
  const gateway = createGateway({ url: stub.url, name: 'stub', timeoutMs: 3000, retries: 0, allowRemote: false });
  return { stub, app: createApp({ dataDir: tempDir(), gateway, now: CLOCK }) };
}

afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop());
});
afterEach(async () => {
  while (stubs.length > 0) await stubs.pop().close();
});

// One experience of one real audited event.
async function experienceOf(target, request) {
  const res = await target.controller.handle(request, { origin: 'user' });
  const rec = await target.controller.experienceRecord({ operationId: res.operation.id, subject: 'what APEX did here' });
  assert.equal(rec.status, Outcome.SUCCESS_VERIFIED, rec.display ?? rec.output);
  const [record] = await target.experience.list({ limit: 1 });
  return record;
}

// Two experiences and the same corrective feedback on both: the minimum support one candidate needs.
async function supportFor(target, guidance, requests = [
  `remember that the report was late because of: ${guidance}`,
  `remember that the second report was late because of: ${guidance}`,
]) {
  const ids = [];
  for (const request of requests) {
    const record = await experienceOf(target, request);
    const fb = await target.controller.feedbackRecord({ target: record.id, assessment: 'incorrect', guidance });
    assert.equal(fb.status, Outcome.SUCCESS_VERIFIED, fb.display ?? fb.output);
    ids.push(record.id);
  }
  return ids;
}

// Derived candidates, keyed by their rule text, from one derivation pass over the whole store.
async function deriveAll(target) {
  const res = await target.controller.adaptationDerive({});
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
  const byRule = new Map(res.operation.steps[0].result.data.created.map((c) => [c.rule, c]));
  return { byRule, created: res.operation.steps[0].result.data.created };
}

async function approve(target, id) {
  const res = await target.controller.adaptationDecide({ target: id, decision: 'approved' });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
  return res;
}

// One memory.add rule in effect, and the state every retrieval test below reads back.
async function ruleInEffect(target, guidance = 'put the date at the top') {
  await supportFor(target, guidance);
  const { byRule } = await deriveAll(target);
  const candidate = byRule.get(guidance);
  assert.ok(candidate, `no candidate was derived for "${guidance}"`);
  await approve(target, candidate.id);
  return candidate;
}

function corrupt(target) {
  fs.appendFileSync(target.experience.filePath, 'this line is not a record\n');
}

function promptMessage(stub, role) {
  return stub.requests.at(-1).messages.find((m) => m.role === role).content;
}

describe('D. retrieval returns approved rules only, and only within its bound', () => {
  test('an undecided candidate, a rejection, a retirement, and stale support are all excluded', async () => {
    const app = appNoModel();
    for (const guidance of [
      'leave the undecided one alone',
      'the rejected one never applies',
      'the retired one used to apply',
      'the stale one was approved on evidence since corrected',
      'the one that applies',
    ]) {
      await supportFor(app, guidance);
    }
    const { byRule } = await deriveAll(app);
    assert.equal(byRule.size, 5);
    const candidate = byRule.get('leave the undecided one alone');
    await app.controller.adaptationDecide({ target: byRule.get('the rejected one never applies').id, decision: 'rejected' });
    const retired = byRule.get('the retired one used to apply');
    await approve(app, retired.id);
    await app.controller.adaptationRetire({ target: retired.id });
    const stale = byRule.get('the stale one was approved on evidence since corrected');
    await approve(app, stale.id);
    const live = byRule.get('the one that applies');
    await approve(app, live.id);
    assert.equal((await app.experience.adaptationDetail(stale.id)).active, true, 'the stale rule is in effect until its evidence is corrected');

    // Correct the experience that supports `stale`: the rule keeps its approval, and loses its evidence.
    const supportExperience = (await app.experience.adaptationDetail(stale.id)).support.experienceIds[0];
    const found = await app.experience.get(supportExperience);
    const replacement = await app.controller.experienceRecord({
      operationId: found.operationId, subject: 'a better account of the same event', replaces: [supportExperience],
    });
    assert.equal(replacement.status, Outcome.SUCCESS_VERIFIED, replacement.display ?? replacement.output);

    const { adaptations, total, truncated, limit } = await app.experience.activeAdaptations({ limit: MAX_ACTIVE_ADAPTATIONS });
    assert.deepEqual(adaptations.map((a) => a.id), [live.id], 'only the approved, unretired, intact rule is retrievable');
    assert.equal(total, 1);
    assert.equal(truncated, false);
    assert.equal(limit, MAX_ACTIVE_ADAPTATIONS);
    assert.equal((await app.experience.adaptationDetail(stale.id)).active, false, 'correcting its evidence stopped it');
    assert.equal((await app.experience.adaptationDetail(candidate.id)).decisionState, 'candidate', 'the undecided one is still awaiting its decision');

    const health = await app.experience.health();
    assert.equal(health.candidates, 1);
    assert.equal(health.approved, 2, 'the retired and the stale approvals are still approvals in the log');
    assert.equal(health.activeAdaptations, 1);
  });

  test('the retrieval window is bounded, states its limit, and says when it cut records', async () => {
    const app = appNoModel();
    for (const guidance of ['put the date at the top', 'keep it to one line', 'use a numbered list', 'quote the source file']) {
      await supportFor(app, guidance);
    }
    const { created } = await deriveAll(app);
    assert.equal(created.length, 4);
    for (const c of created) await approve(app, c.id);

    const byNewest = [...created].reverse().map((c) => c.id);
    const dflt = await app.experience.activeAdaptations();
    assert.equal(dflt.limit, DEFAULT_ACTIVE_ADAPTATIONS);
    assert.deepEqual(dflt.adaptations.map((a) => a.id), byNewest.slice(0, DEFAULT_ACTIVE_ADAPTATIONS), 'newest first within the bound');
    assert.equal(dflt.total, 4);
    assert.equal(dflt.truncated, true);

    const one = await app.experience.activeAdaptations({ limit: 1 });
    assert.equal(one.adaptations.length, 1);
    assert.equal(one.truncated, true);
    assert.equal(one.total, 4);

    const clamped = await app.experience.activeAdaptations({ limit: MAX_ACTIVE_ADAPTATIONS + 50 });
    assert.equal(clamped.limit, MAX_ACTIVE_ADAPTATIONS);
    assert.equal(clamped.adaptations.length, 4);
    assert.equal(clamped.truncated, false);

    const notANumber = await app.experience.activeAdaptations({ limit: 0 });
    assert.equal(notANumber.limit, DEFAULT_ACTIVE_ADAPTATIONS, 'an unusable bound falls back to the documented default, not to no limit');
  });

  test('a scope filter is a boundary and a query only changes the order', async () => {
    const app = appNoModel();
    await supportFor(app, 'answer in one line', ['status', 'who are you']);
    const { byRule: first } = await deriveAll(app);
    await approve(app, first.get('answer in one line').id);
    assert.equal(first.get('answer in one line').capability, 'app.status');

    await supportFor(app, 'answer in one paragraph', ['list memory', 'show my memories']);
    const { byRule: second } = await deriveAll(app);
    const memoryRule = second.get('answer in one paragraph');
    assert.ok(memoryRule, 'the second scope derived its own candidate');
    assert.equal(memoryRule.capability, 'memory.list');
    await approve(app, memoryRule.id);

    const statusOnly = await app.experience.activeAdaptations({ capability: 'app.status', limit: 10 });
    assert.deepEqual(statusOnly.adaptations.map((a) => [a.capability, a.rule]), [['app.status', 'answer in one line']]);
    const insideFamily = await app.experience.activeAdaptations({ capability: 'app.status.detail', limit: 10 });
    assert.equal(insideFamily.adaptations.length, 1, 'a rule scoped to a scope family covers a request deeper inside it');
    const coarser = await app.experience.activeAdaptations({ capability: 'app', limit: 10 });
    assert.equal(coarser.total, 0, 'a filter coarser than the rule\'s scope does not claim the rule covers it');
    const noneOther = await app.experience.activeAdaptations({ capability: 'memory.write', limit: 10 });
    assert.equal(noneOther.total, 0, 'a scope nobody approved for retrieves nothing');

    const namedMemory = await app.experience.activeAdaptations({ query: 'memory list please' });
    assert.equal(namedMemory.adaptations[0].capability, 'memory.list', 'a request naming a scope ranks it first');
    const namedApp = await app.experience.activeAdaptations({ query: 'status of the app' });
    assert.equal(namedApp.adaptations[0].capability, 'app.status');
    const unrated = await app.experience.activeAdaptations({ query: 'nothing of the sort here' });
    assert.deepEqual(unrated.adaptations.map((a) => a.capability), ['memory.list', 'app.status'], 'with nothing to rank by, newest first');
    assert.equal(unrated.adaptations.length, 2);
  });

  test('two approved rules that disagree for one scope are both retrieved and both marked', async () => {
    const app = appNoModel();
    await supportFor(app, 'put the date at the top');
    await supportFor(app, 'keep it to one line');
    const { created } = await deriveAll(app);
    for (const c of created) await approve(app, c.id);

    const { adaptations } = await app.experience.activeAdaptations({ limit: 10 });
    assert.equal(adaptations.length, 2, 'neither side of a disagreement is dropped');
    for (const a of adaptations) {
      assert.equal(a.conflicts.length, 1);
      assert.equal(a.conflicts[0].id, adaptations.find((other) => other.id !== a.id).id);
      assert.notEqual(a.conflicts[0].rule, a.rule);
    }
    assert.notEqual(adaptations[0].ruleHash, adaptations[1].ruleHash);

    const conflicts = await app.experience.health();
    assert.equal(conflicts.conflicts.scopes, 1);
    assert.equal(conflicts.attention, true, 'APEX does not choose between rules the user approved');
  });

  test('an unreadable store refuses retrieval instead of reporting no rules', async () => {
    const app = appNoModel();
    await ruleInEffect(app);
    corrupt(app);
    await assert.rejects(
      app.experience.activeAdaptations({ query: 'how should I write it' }),
      /experience store contains 1 corrupt line\(s\); refusing an incomplete experience operation/,
    );

    const untouched = appNoModel();
    const empty = await untouched.experience.activeAdaptations({ query: 'how should I write it' });
    assert.deepEqual(empty, { adaptations: [], total: 0, truncated: false, limit: DEFAULT_ACTIVE_ADAPTATIONS });
  });
});

describe('E. the request path applies an approved rule within its bounds', () => {
  test('a deterministic action reads no adaptation context, even while one is in effect', async () => {
    const app = appNoModel();
    await ruleInEffect(app);
    let calls = 0;
    const original = app.experience.activeAdaptations.bind(app.experience);
    app.experience.activeAdaptations = (options) => {
      calls += 1;
      return original(options);
    };

    const wrote = await app.controller.handle('remember that the third report was undated', { origin: 'user' });
    assert.equal(wrote.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(calls, 0, 'a request that runs a registered action does not consult behaviour rules');
    assert.deepEqual(wrote.operation.errors, []);

    const asked = await app.controller.handle('how should I write the quarterly report?', { origin: 'user' });
    assert.equal(asked.status, Outcome.MODEL_UNAVAILABLE);
    assert.equal(calls, 1, 'the model path retrieves them once, bounded');
    app.experience.activeAdaptations = original;
  });

  test('an unreadable experience store does not spoil a deterministic action', async () => {
    const app = appNoModel();
    await ruleInEffect(app);
    corrupt(app);
    const res = await app.controller.handle('remember that the store is damaged', { origin: 'user' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
    assert.deepEqual(res.operation.errors, [], 'the damage is not reported against an unrelated successful write');
    const health = await app.experience.health();
    assert.equal(health.corrupt.length, 1, 'and it is still reported where it belongs');
    assert.equal(health.attention, true);
  });

  test('without a model the rule in effect is shown, and shown not applied', async () => {
    const app = appNoModel();
    const rule = await ruleInEffect(app, 'put the date at the top of every report');
    const res = await app.controller.handle('how should I write the quarterly report?', { origin: 'user' });
    assert.equal(res.status, Outcome.SUCCESS_DETERMINISTIC);
    assert.match(res.display, /Approved adaptations covering this request \(shown directly; without a model APEX did not apply them\)/);
    assert.ok(res.display.includes('"put the date at the top of every report"'), 'the user\'s own wording is reproduced');
    assert.match(res.display, new RegExp(`\\[${rule.id.slice(0, 8)}\\] scope memory\\.add`));
    assert.match(res.display, /supported by 2 recorded experience\(s\), not a fact and not authorization/);
    assert.equal(res.operation.prompt, null, 'no prompt was built, so none is audited');
    assert.deepEqual(res.operation.errors, []);
  });

  test('an undecided, rejected, or retired rule never reaches the request path', async () => {
    const app = appNoModel();
    for (const guidance of [
      'this one is still a candidate',
      'this one the user rejected',
      'this one is retired after approval',
      'this one applies',
    ]) {
      await supportFor(app, guidance);
    }
    const { byRule } = await deriveAll(app);
    await app.controller.adaptationDecide({ target: byRule.get('this one the user rejected').id, decision: 'rejected' });
    const toRetire = byRule.get('this one is retired after approval');
    await approve(app, toRetire.id);
    await app.controller.adaptationRetire({ target: toRetire.id });
    const live = byRule.get('this one applies');
    await approve(app, live.id);

    const res = await app.controller.handle('how should I write the quarterly report?', { origin: 'user' });
    assert.ok(res.display.includes('"this one applies"'));
    assert.ok(!res.display.includes('this one is still a candidate'));
    assert.ok(!res.display.includes('this one the user rejected'));
    assert.ok(!res.display.includes('this one is retired after approval'));
    assert.equal((await app.experience.adaptationDetail(live.id)).active, true);
  });

  test('without a model, a store that cannot be read is disclosed as unreadable', async () => {
    const app = appNoModel();
    await ruleInEffect(app);
    corrupt(app);
    const res = await app.controller.handle('how should I write the quarterly report?', { origin: 'user' });
    assert.equal(res.status, Outcome.SUCCESS_DETERMINISTIC);
    assert.match(res.display, /\[APEX could not read its approved adaptations for this request, so a behaviour rule you approved may be missing from what is shown here\.\]/);
    assert.ok(!res.display.includes('Approved adaptations covering this request'), 'an unreadable store is never shown as an empty one');
    const adaptation = res.operation.errors.find((e) => e.stage === 'adaptation');
    assert.equal(adaptation.code, 'STORE_UNAVAILABLE');
    assert.match(adaptation.message, /refusing an incomplete experience operation/);
  });

  test('a bounded list says which part of it is missing', async () => {
    const app = appNoModel();
    for (const guidance of ['put the date at the top', 'keep it to one line', 'use a numbered list', 'quote the source file']) {
      await supportFor(app, guidance);
    }
    const { created } = await deriveAll(app);
    for (const c of created) await approve(app, c.id);

    const res = await app.controller.handle('how should I write the quarterly report?', { origin: 'user' });
    const shown = (res.display.match(/^- \[[0-9a-f]{8}\] scope memory\.add/gm) ?? []).length;
    assert.equal(shown, DEFAULT_ACTIVE_ADAPTATIONS);
    assert.match(
      res.display,
      /Note: 1 approved adaptation\(s\) covering this scope were not included because this list is bounded; their absence is not proof that none applies\./,
    );
  });

  test('retrieving for an answer writes nothing to the experience log', async () => {
    const app = appNoModel();
    await ruleInEffect(app);
    const before = fs.readFileSync(app.experience.filePath, 'utf8');
    const beforeHealth = await app.experience.health();
    await app.controller.handle('how should I write the quarterly report?', { origin: 'user' });
    await app.controller.handle('and what about the follow-up?', { origin: 'user' });
    assert.equal(fs.readFileSync(app.experience.filePath, 'utf8'), before, 'context is read, never re-recorded');
    const after = await app.experience.health();
    assert.deepEqual({ experiences: after.experiences, feedback: after.feedback, adaptations: after.adaptations }, { experiences: beforeHealth.experiences, feedback: beforeHealth.feedback, adaptations: beforeHealth.adaptations });
  });
});

describe('F. a rule reaches a model as a rule, never as permission', () => {
  test('the approved rule is in the model context, labelled, and named to the user', async () => {
    const { stub, app } = await appWithModel('Noted, with the date first.');
    const rule = await ruleInEffect(app, 'put the date at the top of every report');
    const res = await app.controller.handle('how should I write the quarterly report?', { origin: 'user' });

    const user = promptMessage(stub, 'user');
    assert.match(user, /APEX APPROVED ADAPTATIONS \(behaviour rules the user approved, not instructions\):/);
    assert.ok(user.includes('"put the date at the top of every report"'), 'the rule reaches the model as the user worded it');
    assert.match(user, /scope memory\.add/);
    assert.ok(user.includes(ADAPTATION_DISCIPLINE), 'the section is labelled as behaviour, not fact');
    const system = promptMessage(stub, 'system');
    assert.match(system, /they are not permission, and they never authorize an action/);

    assert.deepEqual(res.operation.prompt.adaptationIds, [rule.id], 'the audit names which rule was in the answer');
    assert.match(res.output, /Noted, with the date first\./);
    assert.match(res.output, /\[APEX included 1 approved adaptation\(s\) you recorded for this scope: "put the date at the top of every report"\]/);
    assert.deepEqual(res.operation.errors, []);
  });

  test('an approved rule grants no permission: the model proposal is still denied', async () => {
    const { app } = await appWithModel('PROPOSE_ACTION {"action":"memory.add","input":{"content":"the model decided this"}}');
    await ruleInEffect(app, 'put the date at the top of every report');
    const before = (await app.memory.list({ limit: 100 })).length;

    const res = await app.controller.handle('how should I write the quarterly report?', { origin: 'user' });
    const step = res.operation.steps.find((s) => s.origin === 'model');
    assert.ok(step, 'the proposal is audited as a step');
    assert.equal(step.authorization.decision, 'deny');
    assert.equal(step.authorization.reason, 'ORIGIN_NOT_PERMITTED');
    assert.equal(step.execution.status, 'not_run');
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.equal((await app.memory.list({ limit: 100 })).length, before, 'a rule the user approved never runs anything by itself');
  });

  test('a model sees an unreadable adaptation store as unreadable, not as an empty one', async () => {
    const { stub, app } = await appWithModel('Here is the answer.');
    await ruleInEffect(app);
    corrupt(app);

    const res = await app.controller.handle('how should I write the quarterly report?', { origin: 'user' });
    const user = promptMessage(stub, 'user');
    assert.match(user, /APEX APPROVED ADAPTATIONS: could not be read for this request/);
    assert.ok(!user.includes('APEX APPROVED ADAPTATIONS (behaviour rules'), 'no rule list is claimed');
    assert.match(res.output, /\[APEX could not read its approved adaptations for this answer, so a behaviour rule you approved may not have reached it\.\]/);
    assert.ok(res.output.includes('Here is the answer.'), 'a supplementary read failed; the answer still went ahead');
    const adaptation = res.operation.errors.find((e) => e.stage === 'adaptation');
    assert.equal(adaptation.code, 'STORE_UNAVAILABLE');
  });

  test('two conflicting rules both reach the model, and neither is presented as the winner', async () => {
    const { stub, app } = await appWithModel('Both rules are noted.');
    await supportFor(app, 'put the date at the top');
    await supportFor(app, 'keep it to one line');
    const { created } = await deriveAll(app);
    for (const c of created) await approve(app, c.id);

    const res = await app.controller.handle('how should I write the quarterly report?', { origin: 'user' });
    const user = promptMessage(stub, 'user');
    const marked = user.match(/CONFLICTING: 1 other approved rule\(s\)/g) ?? [];
    assert.equal(marked.length, 2, 'both sides carry the marker');
    assert.ok(user.includes('APEX has not resolved which the user would prefer'));
    assert.match(res.output, /\[2 of your approved adaptations cover this scope and say different things; APEX has not resolved which one you would prefer\.\]/);
  });

  test('a bounded context tells the model that approved rules exist which it cannot see', async () => {
    const { stub, app } = await appWithModel('Answered within the shown rules.');
    for (const guidance of ['put the date at the top', 'keep it to one line', 'use a numbered list', 'quote the source file']) {
      await supportFor(app, guidance);
    }
    const { created } = await deriveAll(app);
    for (const c of created) await approve(app, c.id);

    const res = await app.controller.handle('how should I write the quarterly report?', { origin: 'user' });
    const user = promptMessage(stub, 'user');
    assert.match(user, /Note: 1 approved adaptation\(s\) covering this scope were not included because this list is bounded; their absence is not proof that none applies\./);
    assert.match(res.output, /1 approved adaptation\(s\) covering this scope were not included/);
    assert.equal(res.operation.prompt.adaptationIds.length, DEFAULT_ACTIVE_ADAPTATIONS);
  });
});
