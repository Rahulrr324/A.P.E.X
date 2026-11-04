// World Model integration scenarios A-O.
//
// These tests exercise the world model through the real application surfaces: the controller
// commands, the action registry, the model prompt builder, plan validity, the CLI, and the writer
// lock. They are deterministic and use only synthetic records; no model endpoint is contacted.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { WORLD_MODEL_DISCIPLINE } from '../src/world/context.js';
import {
  makeTempDataDir, cleanup, runCli, cleanEnv, deadPid, makePlanGateway, taskStep,
} from './helpers.js';

const T0 = '2024-04-01T00:00:00.000Z';
const T1 = '2024-04-02T00:00:00.000Z';
const T2 = '2024-04-03T00:00:00.000Z';
const UE = [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }];

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function clock(start = T0) {
  let at = start;
  return { now: () => new Date(at), set: (value) => { at = value; }, at: () => at };
}

function appOn(dir, { now, gateway, extraActions } = {}) {
  return createApp({
    dataDir: dir,
    gateway: gateway ?? new ModelGateway({ backend: new NoBackend() }),
    experienceCapture: CAPTURE_OFF,
    now,
    extraActions,
  });
}

function dataOf(res) {
  return res.operation.steps[0].result.data;
}

async function write(app, action, input) {
  const res = await app.controller.worldWrite(action, input);
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
  return res;
}

async function writeData(app, action, input) {
  return dataOf(await write(app, action, input));
}

async function read(app, action, input) {
  const res = await app.controller.worldRead(action, input);
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
  return res;
}

async function addEntity(app, id, name, extra = {}) {
  return writeData(app, 'world.entity.add', {
    id, category: 'project', name, evidence: UE, ...extra,
  });
}

async function addFact(app, id, subject, predicate, object, extra = {}) {
  return writeData(app, 'world.fact.add', {
    id, subject, predicate, object, validFrom: '2024-01-01', evidence: UE, ...extra,
  });
}

function scalar(value, valueType = 'string', extra = {}) {
  return { kind: 'scalar', valueType, value, ...extra };
}

function entityObject(entityId) {
  return { kind: 'entity', entityId };
}

function logLines(dir) {
  return fs.readFileSync(path.join(dir, 'world-model.jsonl'), 'utf8')
    .split('\n').filter((line) => line.trim() !== '');
}

function worldFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith('world-model.jsonl')).sort();
}

function captureGateway(reply = 'stub answer') {
  const prompts = [];
  const backend = {
    name: 'capture',
    provider: 'capture',
    configured: true,
    describe: () => ({ configured: true, provider: 'capture', endpoint: 'capture', model: 'capture' }),
    health: async () => ({ available: true, detail: 'capture' }),
    complete: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        ok: true, backend: 'capture', provider: 'capture', model: 'capture',
        text: reply, finishReason: 'stop', truncated: false, latencyMs: 0,
      };
    },
  };
  return { gateway: new ModelGateway({ backend }), prompts };
}

describe('World Model scenarios A-O', () => {
  test('A: an entity and a fact are recorded, listed, shown, and audited as user-origin', async () => {
    const dir = tempDir();
    const app = appOn(dir);

    const created = await addEntity(app, 'e-locker', 'Parcel Locker', {
      category: 'product', aliases: ['Locker 7'],
    });
    assert.equal(created.entityId, 'e-locker');
    assert.equal(created.status, 'active');

    await addFact(app, 'f-status', 'e-locker', 'has_status', scalar('operational'));

    const list = await read(app, 'world.entity.list', {});
    assert.match(list.display, /Parcel Locker/);
    assert.match(list.display, /Locker 7/);

    const show = await read(app, 'world.entity.show', { target: 'e-locker' });
    assert.equal(dataOf(show).found, true);
    assert.match(show.display, /Facts \(1\):/);
    assert.match(show.display, /has_status operational/);
    assert.match(show.display, /\[supported\]/);
    assert.match(show.display, /evidence user:user/);

    const facts = await read(app, 'world.facts', { target: 'e-locker' });
    assert.deepEqual(dataOf(facts).factIds, ['f-status']);

    const records = logLines(dir).map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.origin === 'user'));

    assert.deepEqual(worldFiles(dir), ['world-model.jsonl'], 'the writer lock is released and no staged file remains');
  });

  test('B: as-of queries return the value that was valid at that time', async () => {
    const dir = tempDir();
    const app = appOn(dir);

    await addEntity(app, 'e-parcel', 'Parcel 91');
    await addFact(app, 'f-transit', 'e-parcel', 'status_is', scalar('in_transit'), {
      validFrom: '2024-01-01', validUntil: '2024-02-28',
    });
    await addFact(app, 'f-delivered', 'e-parcel', 'status_is', scalar('delivered'), {
      validFrom: '2024-03-01',
    });

    const february = await read(app, 'world.attributes', { target: 'e-parcel', asOf: '2024-02-01' });
    assert.deepEqual(dataOf(february).factIds, ['f-transit']);
    assert.match(february.display, /in_transit/);
    assert.doesNotMatch(february.display, /delivered/);

    const april = await read(app, 'world.attributes', { target: 'e-parcel', asOf: '2024-04-01' });
    assert.deepEqual(dataOf(april).factIds, ['f-delivered']);
    assert.match(april.display, /delivered/);
    assert.doesNotMatch(april.display, /in_transit/);
  });

  test('C: overlapping single-valued facts are a disagreement, and both sides are kept', async () => {
    const dir = tempDir();
    const app = appOn(dir);

    await addEntity(app, 'e-locker', 'Parcel Locker');
    await addFact(app, 'f-op', 'e-locker', 'has_status', scalar('operational'));
    await addFact(app, 'f-maint', 'e-locker', 'has_status', scalar('under_maintenance'));

    const conflicts = await read(app, 'world.conflicts', {});
    const data = dataOf(conflicts);
    assert.ok(data.counts.groups >= 1);
    assert.ok(data.groupKeys.some((key) => key.startsWith('fact|has_status|')), data.groupKeys.join(', '));
    assert.match(conflicts.display, /operational/);
    assert.match(conflicts.display, /under_maintenance/);
    assert.match(conflicts.display, /No source was ranked and no side was chosen automatically/);

    const facts = await read(app, 'world.facts', { target: 'e-locker' });
    assert.deepEqual([...dataOf(facts).factIds].sort(), ['f-maint', 'f-op'], 'neither statement is removed');
  });

  test('D: a retraction is stored, disclosed, reconstructable, and reported as a change', async () => {
    const dir = tempDir();
    const time = clock(T0);
    const app = appOn(dir, { now: time.now });

    await addEntity(app, 'e-locker', 'Parcel Locker');
    await addFact(app, 'f-status', 'e-locker', 'has_status', scalar('operational'));

    time.set(T1);
    await write(app, 'world.statement.retract', {
      targetType: 'fact', target: 'f-status', reason: 'the reading was out of date', evidence: UE,
    });

    time.set(T2);
    const live = await read(app, 'world.facts', { target: 'e-locker' });
    assert.deepEqual(dataOf(live).factIds, [], 'a retracted fact is not current');

    const withHistory = await read(app, 'world.facts', { target: 'e-locker', includeRetracted: true });
    assert.deepEqual(dataOf(withHistory).factIds, ['f-status']);
    assert.match(withHistory.display, /retracted/);
    assert.match(withHistory.display, /the reading was out of date/);

    const history = await read(app, 'world.statement.history', { targetType: 'fact', target: 'f-status' });
    assert.equal(dataOf(history).eventIds.length, 1);

    const past = await read(app, 'world.state_at', { at: T0 });
    assert.equal(dataOf(past).records, 2, 'only the entity and the fact were stored by T0');
    assert.equal(dataOf(past).excluded, 1, 'the later retraction is excluded from the historical state');

    const changes = await read(app, 'world.changes', { from: T0, to: T2 });
    const changesData = dataOf(changes);
    assert.ok(changesData.changes.some((entry) => entry.endsWith('|recorded|f-status')), changesData.changes.join(', '));
    assert.ok(changesData.changes.some((entry) => entry.endsWith('|retracted|f-status')), changesData.changes.join(', '));
  });

  test('E: a shared name is ambiguous and is not resolved by choosing one entity', async () => {
    const dir = tempDir();
    const app = appOn(dir);

    await addEntity(app, 'e-one', 'Parcel Locker');
    await addEntity(app, 'e-two', 'Parcel Locker');

    const show = await read(app, 'world.entity.show', { target: 'Parcel Locker' });
    const data = dataOf(show);
    assert.equal(data.found, false);
    assert.equal(
      show.display,
      'Cannot show the entity: "Parcel Locker" matches 2 active entities; identity is not inferred from a name, so choose one by id',
    );
  });

  test('F: evidence must exist, and a model-produced record cannot be relabelled as the user\'s', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    await addEntity(app, 'e-locker', 'Parcel Locker');

    const missing = await app.controller.worldWrite('world.fact.add', {
      id: 'f-missing',
      subject: 'e-locker',
      predicate: 'has_status',
      object: scalar('operational'),
      validFrom: '2024-01-01',
      evidence: [{ relation: 'supports', sourceType: 'memory', sourceId: 'no-such-record' }],
    });
    // Evidence existence is checked against the owning store while the action runs, so a missing
    // reference is an execution failure that follows input validation (and writes nothing).
    assert.equal(missing.status, Outcome.EXECUTION_FAILED);
    assert.match(missing.display, /evidence memory:no-such-record does not exist/);

    const conclusion = await app.memory.add({
      content: 'the locker code is 4411',
      kind: 'model_conclusion',
      source: 'model',
      provenance: { origin: 'model_output' },
    });

    const relabelled = await app.controller.worldWrite('world.fact.add', {
      id: 'f-relabelled',
      subject: 'e-locker',
      predicate: 'has_status',
      object: scalar('operational'),
      validFrom: '2024-01-01',
      evidence: [{ relation: 'supports', sourceType: 'memory', sourceId: conclusion.id, classification: 'user_statement' }],
    });
    assert.equal(relabelled.status, Outcome.EXECUTION_FAILED);
    assert.match(relabelled.display, /is classified as model_generated, not user_statement/);

    const accepted = await write(app, 'world.fact.add', {
      id: 'f-model-cited',
      subject: 'e-locker',
      predicate: 'has_status',
      object: scalar('operational'),
      validFrom: '2024-01-01',
      evidence: [{ relation: 'qualifies', sourceType: 'memory', sourceId: conclusion.id }],
    });
    assert.equal(dataOf(accepted).factId, 'f-model-cited');

    const evidence = await read(app, 'world.evidence', { targetType: 'fact', targetId: 'f-model-cited' });
    assert.ok(dataOf(evidence).refs.includes(`qualifies|memory|${conclusion.id}`), dataOf(evidence).refs.join(', '));
    assert.match(evidence.display, /\[model_generated\]/);
  });

  test('G: the CLI records and reads a world entity and fact through the real entry point', async () => {
    const dir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });

    const added = await runCli([
      'world', 'entity', 'add', '--category', 'product', '--alias', 'Locker 7', 'Parcel Locker',
    ], env);
    assert.equal(added.code, 0, added.stdout + added.stderr);
    assert.match(added.stdout, /Entity [A-Za-z0-9-]+ created: Parcel Locker/);
    assert.match(added.stdout, /Audit: recorded in operations\.jsonl/);
    const match = added.stdout.match(/Entity ([A-Za-z0-9-]+) created/);
    const entityId = match[1];

    const fact = await runCli([
      'world', 'fact', 'add', '--subject', entityId, '--predicate', 'has_status',
      '--object-value', 'operational', '--valid-from', '2024-01-01',
    ], env);
    assert.equal(fact.code, 0, fact.stdout + fact.stderr);
    assert.match(fact.stdout, /Fact [A-Za-z0-9-]+ recorded: \S+ has_status operational/);

    const list = await runCli(['world', 'entity', 'list'], env);
    assert.equal(list.code, 0, list.stdout + list.stderr);
    assert.match(list.stdout, /Parcel Locker/);

    const show = await runCli(['world', 'entity', 'show', entityId], env);
    assert.equal(show.code, 0, show.stdout + show.stderr);
    assert.match(show.stdout, /has_status operational/);

    const facts = await runCli(['world', 'fact', 'list', entityId], env);
    assert.equal(facts.code, 0, facts.stdout + facts.stderr);
    assert.match(facts.stdout, /has_status operational/);
  });

  test('H: a model origin cannot write the world model, and cannot smuggle a world write into a plan', async () => {
    const dir = tempDir();
    const app = appOn(dir);

    const attempts = [
      ['world.entity.add', { category: 'project', name: 'model entity' }],
      ['world.entity.alias', { target: 'e-model', alias: 'another name' }],
      ['world.entity.retire', { target: 'e-model', reason: 'the model retired it' }],
      ['world.entity.merge', { from: 'e-model', to: 'e-other', reason: 'the model merged them' }],
      ['world.entity.unmerge', { merge: 'm-model', reason: 'the model undid it' }],
      ['world.identity.decide', { left: 'e-model', right: 'e-other', decision: 'confirmed', reason: 'the model decided' }],
      ['world.fact.add', { subject: 'e-model', predicate: 'has_status', object: scalar('operational') }],
      ['world.relationship.add', { subject: 'e-model', relation: 'part_of', object: 'e-other' }],
      ['world.event.add', { eventType: 'deployed', participants: ['e-model'], occurredAt: '2024-01-01' }],
      ['world.statement.retract', { targetType: 'fact', target: 'f-model', reason: 'the model withdrew it' }],
      ['world.statement.supersede', { targetType: 'fact', target: 'f-model', by: 'f-other', reason: 'the model replaced it' }],
    ];
    assert.equal(attempts.length, 11, 'every world write action is covered');

    for (const [action, input] of attempts) {
      const before = worldFiles(dir);
      const step = await app.controller.runAction(action, input, 'model', 'op-model');
      assert.equal(step.authorization.decision, 'deny', `${action} must be denied at model origin`);
      assert.equal(step.execution.status, 'not_run', `${action} must not execute`);
      assert.equal(step.outcome, Outcome.ACTION_DENIED, `${action} must be reported as a denial`);
      assert.deepEqual(worldFiles(dir), before, `${action} created a world file at model origin`);
    }

    const planApp = appOn(tempDir(), {
      gateway: makePlanGateway([
        taskStep('s1', 'world.entity.add', [], { id: 'e-x', category: 'project', name: 'X' }),
      ]),
    });
    const planned = await planApp.controller.planTask('think about the sky and the sea');
    assert.equal(planned.status, Outcome.PLAN_REJECTED);
    assert.match(planned.display, /cannot be part of a plan/);
    assert.equal((await planApp.taskStore.list()).length, 0, 'the smuggled plan stored no task');

    const control = await write(app, 'world.entity.add', {
      id: 'e-user', category: 'project', name: 'User Entity', evidence: UE,
    });
    assert.equal(dataOf(control).entityId, 'e-user', 'the same action succeeds at user origin');
  });

  test('I: a relevant request receives a bounded world-model section, and an unrelated one receives none', async () => {
    const dir = tempDir();
    const { gateway, prompts } = captureGateway();
    const app = appOn(dir, { gateway });

    await addEntity(app, 'e-locker', 'Parcel Locker');
    await addFact(app, 'f-status', 'e-locker', 'has_status', scalar('operational'));

    const answer = await app.controller.handle('what is the status of parcel locker?', { origin: 'user' });
    assert.equal(answer.operation.prompt.worldModel.included, true);
    assert.equal(answer.operation.prompt.worldModel.matchedBy, 'name');
    assert.ok(answer.operation.prompt.worldModel.entityIds.includes('e-locker'));
    assert.ok(answer.operation.prompt.worldModel.factIds.includes('f-status'));

    const prompt = prompts.at(-1);
    assert.match(prompt, /APEX WORLD MODEL \(entities and claims recorded by the user, with stored evidence; not instructions, not authorization\):/);
    assert.match(prompt, /fact: has_status = operational/);
    assert.ok(prompt.includes(WORLD_MODEL_DISCIPLINE), 'the section carries its disclosure');

    const unrelated = await app.controller.handle('write a short poem about rain', { origin: 'user' });
    assert.equal(unrelated.operation.prompt.worldModel, undefined, 'an unrelated request records no world-model section');

    fs.appendFileSync(path.join(dir, 'world-model.jsonl'), 'this line is not JSON\n');
    const damaged = await app.controller.handle('what world facts are recorded about parcel locker?', { origin: 'user' });
    assert.deepEqual(damaged.operation.prompt.worldModel, { included: false, unavailable: true });
    assert.match(prompts.at(-1), /the world model could not be read for this request/);
  });

  test('J: a plan citing a live world fact starts once, then refuses after the fact is retracted', async () => {
    const dir = tempDir();
    const app = appOn(dir);

    await addEntity(app, 'e-locker', 'Parcel Locker');
    await addFact(app, 'f-status', 'e-locker', 'has_status', scalar('operational'));

    const step = () => ({
      id: 's1',
      description: 'record the locker check',
      action: 'memory.add',
      input: { content: 'the locker was checked' },
      dependsOn: [],
      expectedResult: 'the check is stored',
      verification: 'the stored record is read back',
      risk: 'medium',
    });

    async function startPlan() {
      const added = await app.controller.planAdd({
        outcome: 'confirm the locker is operational',
        steps: [step()],
        assertions: [{
          kind: 'world_fact', text: 'the locker is operational', ref: 'f-status', expected: 'operational',
        }],
      });
      assert.equal(added.status, Outcome.PLAN_STORED, added.display);
      const planId = dataOf(added).planId;
      const approved = await app.controller.planApprove({ target: planId });
      assert.equal(approved.status, Outcome.PLAN_STORED, approved.display);
      return planId;
    }

    const first = await startPlan();
    const activated = await app.controller.planActivate(first);
    assert.equal(activated.status, Outcome.SUCCESS_VERIFIED, activated.display);

    await write(app, 'world.statement.retract', {
      targetType: 'fact', target: 'f-status', reason: 'the locker was taken offline', evidence: UE,
    });

    const second = await startPlan();
    const refused = await app.controller.planActivate(second);
    assert.equal(refused.status, Outcome.INPUT_REJECTED);
    assert.match(
      refused.display,
      /plan cannot be started: world assertion the world fact f-status no longer supports the plan \(retracted\)/,
    );
    assert.equal((await app.taskStore.list()).length, 1, 'the refused plan created no second task');
  });

  test('K: a dead writer claim is reported and taken over by the next write', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    const pid = deadPid();
    fs.writeFileSync(
      path.join(dir, 'world-model.jsonl.lock'),
      JSON.stringify({ pid, nonce: 'stale', at: T0 }),
    );

    const report = await app.worldModel.lockReport();
    assert.equal(report.present, true);
    assert.equal(report.pid, pid);
    assert.equal(report.alive, false);

    await addEntity(app, 'e-after', 'After The Crash');
    assert.ok(!fs.existsSync(path.join(dir, 'world-model.jsonl.lock')), 'the takeover released its claim');
    assert.deepEqual(worldFiles(dir), ['world-model.jsonl'], 'no staged or election file is left behind');

    const recovery = await app.worldModel.recover();
    assert.equal(recovery.recovered, false);
    assert.equal(recovery.reason, 'no-lock');
  });

  test('L: concurrent writes to one entity all land and leave a readable log', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    await addEntity(app, 'e-busy', 'Busy Entity');

    const predicates = ['p_one', 'p_two', 'p_three', 'p_four', 'p_five', 'p_six'];
    const results = await Promise.all(predicates.map((predicate, i) => app.worldModel.assertFact({
      origin: 'user',
      factId: `f-busy-${i}`,
      subjectId: 'e-busy',
      predicate,
      object: scalar(`value-${i}`),
      validFrom: '2024-01-01',
      evidence: UE,
    })));
    assert.equal(results.length, 6);

    const records = logLines(dir).map((line) => JSON.parse(line));
    assert.equal(records.filter((record) => record.type === 'fact_asserted').length, 6);
    const state = await app.worldModel.state();
    for (let i = 0; i < predicates.length; i += 1) {
      assert.ok(state.facts.has(`f-busy-${i}`), `fact ${i} is present`);
    }
    assert.deepEqual(worldFiles(dir), ['world-model.jsonl']);
  });

  test('M: traversal detects a cycle, stays bounded, and is deterministic', async () => {
    const dir = tempDir();
    const app = appOn(dir);

    await addEntity(app, 'e-a', 'Alpha');
    await addEntity(app, 'e-b', 'Beta');
    await addEntity(app, 'e-c', 'Gamma');
    await write(app, 'world.relationship.add', {
      id: 'r-ab', subject: 'e-a', relation: 'part_of', object: 'e-b', evidence: UE,
    });
    await write(app, 'world.relationship.add', {
      id: 'r-bc', subject: 'e-b', relation: 'part_of', object: 'e-c', evidence: UE,
    });
    await write(app, 'world.relationship.add', {
      id: 'r-ca', subject: 'e-c', relation: 'part_of', object: 'e-a', evidence: UE,
    });

    const first = await read(app, 'world.related', { target: 'e-a', depth: 3, limit: 10 });
    const firstData = dataOf(first);
    assert.equal(firstData.problem, null);
    assert.equal(firstData.truncated, false);
    assert.deepEqual([...firstData.nodeIds].sort(), ['e-a', 'e-b', 'e-c']);
    assert.ok(firstData.cycleKeys.length > 0, 'the closing edge is reported as a cycle');
    assert.ok(firstData.edgeKeys.length >= 3);

    const second = await read(app, 'world.related', { target: 'e-a', depth: 3, limit: 10 });
    assert.deepEqual(dataOf(second), firstData, 'the traversal is deterministic');
  });

  test('N: world reads write nothing to the world model log', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    await addEntity(app, 'e-locker', 'Parcel Locker');
    await addFact(app, 'f-status', 'e-locker', 'has_status', scalar('operational'));

    const before = fs.readFileSync(path.join(dir, 'world-model.jsonl'));
    const listingBefore = worldFiles(dir);

    for (const [action, input] of [
      ['world.entity.list', {}],
      ['world.entity.show', { target: 'e-locker' }],
      ['world.facts', { target: 'e-locker' }],
      ['world.attributes', { target: 'e-locker' }],
      ['world.conflicts', {}],
      ['world.related', { target: 'e-locker' }],
      ['world.history', { target: 'e-locker' }],
      ['world.inspect', {}],
      ['world.status', {}],
      ['world.state_at', { at: T2 }],
      ['world.changes', { from: T0, to: T2 }],
    ]) {
      await read(app, action, input);
      assert.deepEqual(fs.readFileSync(path.join(dir, 'world-model.jsonl')), before, `${action} changed the world log`);
      assert.deepEqual(worldFiles(dir), listingBefore, `${action} added or removed a world file`);
    }
  });

  test('O: evidence from every owning store resolves, and a goal-linked plan does not change completion rules', async () => {
    const dir = tempDir();
    const app = appOn(dir);

    const entityRes = await write(app, 'world.entity.add', {
      id: 'e-locker', category: 'product', name: 'Parcel Locker', evidence: UE,
    });
    const operationId = entityRes.operation.id;

    const memoryRecord = await app.memory.add({
      content: 'the locker code is 4411', kind: 'user_fact', source: 'user',
    });
    const knowledge = await app.knowledge.add({
      subject: 'parcel locker', relationship: 'has_status', object: 'operational',
      evidence: 'user note', origin: 'user',
    });
    const experienceRes = await app.controller.experienceRecord({
      operationId, subject: 'recorded the parcel locker entity',
    });
    assert.equal(experienceRes.status, Outcome.SUCCESS_VERIFIED, experienceRes.display);
    const experienceId = dataOf(experienceRes).id;

    const predictionRes = await app.controller.predictionRecord({
      capability: 'memory.add', expectation: 'success',
      subject: 'the locker record stays usable', inDays: 30,
    });
    assert.equal(predictionRes.status, Outcome.SUCCESS_VERIFIED, predictionRes.display);
    const predictionId = dataOf(predictionRes).id;

    const cited = await write(app, 'world.fact.add', {
      id: 'f-composite',
      subject: 'e-locker',
      predicate: 'has_status',
      object: scalar('operational'),
      validFrom: '2024-01-01',
      evidence: [
        { relation: 'supports', sourceType: 'user', sourceId: 'user' },
        { relation: 'supports', sourceType: 'memory', sourceId: memoryRecord.id },
        { relation: 'supports', sourceType: 'knowledge', sourceId: knowledge.record.id },
        { relation: 'supports', sourceType: 'experience', sourceId: experienceId },
        { relation: 'supports', sourceType: 'operation', sourceId: operationId },
        { relation: 'qualifies', sourceType: 'prediction', sourceId: predictionId },
      ],
    });
    assert.equal(dataOf(cited).factId, 'f-composite');

    const evidence = await read(app, 'world.evidence', { targetType: 'fact', targetId: 'f-composite' });
    const refs = dataOf(evidence).refs;
    assert.equal(refs.length, 6, refs.join(', '));
    for (const expected of [
      'supports|user|user',
      `supports|memory|${memoryRecord.id}`,
      `supports|knowledge|${knowledge.record.id}`,
      `supports|experience|${experienceId}`,
      `supports|operation|${operationId}`,
      `qualifies|prediction|${predictionId}`,
    ]) {
      assert.ok(refs.includes(expected), `missing ${expected}`);
    }
    assert.match(evidence.display, /\[user_statement\]/);
    assert.match(evidence.display, /\[recorded_claim\]/);
    assert.match(evidence.display, /\[verified_record\]/);
    assert.match(evidence.display, /\[recorded_expectation\]/);

    const goalRes = await app.controller.goalAdd({
      request: 'keep the parcel locker operational',
      criteria: ['the locker is recorded as operational'],
    });
    assert.equal(goalRes.status, Outcome.GOAL_CREATED, goalRes.display);
    const goalId = dataOf(goalRes).goalId;
    assert.equal((await app.controller.goalUpdate({ target: goalId, status: 'accepted' })).status, Outcome.GOAL_UPDATED);
    assert.equal((await app.controller.goalUpdate({ target: goalId, status: 'active' })).status, Outcome.GOAL_UPDATED);
    assert.equal((await app.controller.goalLink({ target: goalId, entityId: 'e-locker' })).status, Outcome.GOAL_UPDATED);

    const planRes = await app.controller.planAdd({
      goalId,
      outcome: 'verify the linked locker entity is still usable',
      steps: [{
        id: 's1',
        description: 'store the verification note',
        action: 'memory.add',
        input: { content: 'the linked locker was verified' },
        dependsOn: [],
        expectedResult: 'the note is stored',
        verification: 'the stored note is read back',
        risk: 'medium',
      }],
      assertions: [{
        kind: 'world_entity', text: 'the locker entity exists', ref: 'e-locker',
      }],
    });
    assert.equal(planRes.status, Outcome.PLAN_STORED, planRes.display);
    const planId = dataOf(planRes).planId;
    assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);

    const activated = await app.controller.planActivate(planId);
    assert.equal(activated.status, Outcome.SUCCESS_VERIFIED, activated.display);

    const goal = await app.goals.get(goalId);
    assert.equal(goal.status, 'active', 'a completed plan does not complete the goal by itself');
  });
});
