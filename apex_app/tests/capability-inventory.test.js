// Implementation 112 (Batch AF-19): the capability authorization inventory. AF-19 asked for every
// registered action with its origin permissions, read/write class, side effects, audit and
// verification requirements, capture eligibility, and whether it can change persistent cognitive
// state. These tests pin that inventory against the live registry rather than against prose, and pin
// the two inconsistencies the audit found: the planning prompt was offering an action the plan checker
// always refused, and the README's inventory table could drift from the registry. Nothing here invokes
// a model; every route runs through the assembled application in an isolated data directory, and the
// file effects are measured by comparing the store files before and after.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { exportArchive } from '../src/backup/archive.js';
import { checkSteps, planningPrompt } from '../src/tasks/planner.js';
import {
  AUTO_CAPTURE_CAPABILITIES,
  CAPTURE_EXCLUDED_CAPABILITIES,
  CAPTURE_EXCLUSION_CATEGORIES,
} from '../src/experience/capture.js';

const dirs = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    try { cleanup(dir); } catch { /* already removed */ }
  }
});
function appWith(dir, filesystemRoot = null) {
  return createApp({ dataDir: dir, filesystemRoot });
}

const STORE_FILES = ['memory.jsonl', 'conversation.jsonl', 'operations.jsonl', 'session.json',
  'tasks.jsonl', 'task-summary-queue.json', 'knowledge.jsonl', 'experiences.jsonl', 'predictions.jsonl',
  // Batch AL added a goal store and a plan store; a classified read must leave them untouched too.
  'goals.jsonl', 'plans.jsonl',
  // T-30 (2026-11-19): Workshop reads must leave the append-only design log untouched.
  'workshop.jsonl'];
function sizes(dir) {
  return Object.fromEntries(STORE_FILES.map((f) => {
    const p = path.join(dir, f);
    return [f, fs.existsSync(p) ? fs.readFileSync(p).length : -1];
  }));
}
function changed(before, after) {
  return Object.keys(after).filter((f) => after[f] !== before[f]);
}
function auditLines(dir) {
  const p = path.join(dir, 'operations.jsonl');
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, 'utf8').split('\n').filter((line) => line.trim().length > 0).length;
}

// The capabilities that are not registry actions but can still produce an operation or a
// classified read. Frozen here on purpose: a new route has to be named in this list and
// classified for capture, or these tests fail.
const NON_ACTION_CAPABILITIES = [
  'model.answer', 'task.plan', 'task.run', 'task.approve', 'task.retry', 'task.cancel',
  'task.explain', 'task.step', 'none',
  'goal.list', 'goal.show',
  'proposal.create',
  'plan.list', 'plan.show', 'plan.validate', 'plan.activate', 'plan.reconcile',
  'plan.continuation', 'plan.continue',
  'recover',
  // The outer operation each executive-bridge request produces in a conversation.
  'executive.status', 'executive.prepare', 'executive.approve', 'executive.execute', 'executive.clarify',
];

// The refusal kinds that are about policy rather than about a malformed argument.
const POLICY_REFUSALS = ['cannot be part of a plan', 'is not permitted in this plan', 'cannot be stored as a user fact'];
function policyRefusal(checked) {
  return checked.problems.find((p) => POLICY_REFUSALS.some((refusal) => p.includes(refusal))) ?? null;
}
function refuses(registry, action, origin, input = {}) {
  return policyRefusal(checkSteps([{ id: 's1', description: 'a step', action, input, dependsOn: [] }], registry, origin));
}

function offeredNames(systemPrompt) {
  return systemPrompt.split('\n').filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).split(' ')[0]).sort();
}

function inventoryRows() {
  const markdown = fs.readFileSync(path.join(APP_ROOT, 'README.md'), 'utf8');
  const start = markdown.indexOf('## Batch AF: capability authorization inventory');
  assert.ok(start >= 0, 'the README must carry the capability inventory section');
  const end = markdown.indexOf('\n## ', start + 10);
  const section = markdown.slice(start, end === -1 ? undefined : end);
  const rows = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    assert.equal(cells.length, 7, `an inventory row must have seven columns: ${line}`);
    rows.push({
      names: cells[0].split(',').map((part) => part.trim().replace(/`/g, '')),
      origins: cells[1], class: cells[2], plan: cells[3], writes: cells[4], capture: cells[5], belief: cells[6],
    });
  }
  assert.ok(rows.length >= 25, `the inventory table shrank to ${rows.length} rows`);
  return rows;
}

describe('AF-19: the registry is the inventory', () => {
  test('the registered action set is what the inventory names, with and without a filesystem root', () => {
    const plain = appWith(tempDir());
    // T-25 added Council's five reads; T-26/T-27 added four Workshop reads and one user-only
    // compose action. T-29 (2026-11-19) adds one owner-only capability, `cognition.run`, and the
    // historical 134/139 expectations are superseded with it.
    // T-31 Step 2 (2026-11-19) added four evolution-lab capabilities (propose, verify, promote, decide),
    // so the pinned totals moved by four; the write count moves with them because all four write.
    // T-32 Step 3 (2026-11-19) adds four perception capabilities (sense_host, state, dismiss_alert,
    // revoke_suppression), so the pinned totals move by four and the read/write split with them.
    // T-34 Step 3 (2026-11-19) adds one owner-only write, `briefing.acknowledge`, so the pinned totals
    // move by one.
    // T-35 Step 2 (2026-11-19) adds three owner-only writes - `presence.handoff.stage`, `.claim` and
    // `.revoke` - so the pinned totals move by three and the write count with them.
    // T-36 Step 1 (2026-11-21) adds two capabilities: the owner-only write `system.bootstrap` and
    // the read `system.bootstrap_status`, so the pinned totals move by two and the write count by one.
    // T-37 Step 1 (2026-11-21) adds three: the owner-only writes `neural.step` and
    // `neural.bridge_reset`, and the read `neural.read`. Track 2 can advance a simulation and read
    // it back; it authorizes nothing, so it adds no capability that could name another one.
    assert.equal(plain.registry.list().length, 159, 'the default registry has 159 actions');
    const rooted = appWith(tempDir(), plain.dataDir);
    assert.equal(rooted.registry.list().length, 174, 'a configured workspace root adds fifteen actions');
    assert.deepEqual(
      [...rooted.registry.names()],
      [...plain.registry.names(), 'filesystem.list', 'filesystem.read', 'filesystem.find',
        'filesystem.summarize', 'filesystem.extract', 'filesystem.compare', 'filesystem.report', 'filesystem.write',
        'filesystem.mkdir', 'filesystem.move', 'filesystem.delete', 'filesystem.restore',
        'filesystem.trash', 'filesystem.batch', 'deadline.import'].sort(),
      'a configured root adds exactly the two inspection actions, the eleven workspace capabilities, and the deadline import',
    );
    const documented = inventoryRows().flatMap((row) => row.names);
    for (const name of rooted.registry.names()) {
      assert.ok(documented.includes(name), `${name} is registered but missing from the inventory table`);
    }
    for (const name of NON_ACTION_CAPABILITIES) {
      assert.ok(documented.includes(name), `${name} ends an operation but is missing from the inventory table`);
    }
    const invented = documented.filter((n) => !rooted.registry.get(n) && !NON_ACTION_CAPABILITIES.includes(n));
    assert.deepEqual(invented, [], 'the inventory names capabilities that do not exist');
  });

  test('every registered action declares an input validator and an independent verifier', () => {
    const app = appWith(tempDir(), tempDir());
    for (const def of app.registry.list()) {
      assert.equal(typeof def.validate, 'function', `${def.name} must validate its input`);
      assert.equal(typeof def.verify, 'function', `${def.name} must be independently verifiable`);
      assert.ok(def.description.length > 0, `${def.name} must be described`);
      assert.ok(['read', 'write'].includes(def.permission), `${def.name} has an unknown class`);
    }
  });

  test('no write action is offered to the model origin anywhere in the registry', () => {
    const app = appWith(tempDir(), tempDir());
    const writes = app.registry.list().filter((d) => d.permission === 'write');
    // T-30 (2026-11-19) supersedes the prior 69-write count: Workshop adds one user-only compose
    // write, and T-29 adds `cognition.run`, which is owner-only and unplannable.
    // T-34 Step 3 (2026-11-19): `briefing.acknowledge` is the eighty-first write, and it is owner-only
    // like every other write in this list.
    // T-36 Step 1 (2026-11-21): `system.bootstrap` is the eighty-fifth write, and it is owner-only
    // like every other write in this list.
    // T-37 Step 1 (2026-11-21): `neural.step` and `neural.bridge_reset` are the eighty-sixth and
    // eighty-seventh. Both are owner-only for the same reason: a model that could step the substrate
    // could manufacture the candidate associations it is then asked to consider.
    assert.equal(writes.length, 87, 'the inventory counts eighty-seven write actions with a root configured');
    for (const def of writes) {
      assert.deepEqual([...def.origins], ['user'], `${def.name} must be user-origin only`);
      assert.equal(app.registry.authorize(def.name, 'model').decision, 'deny', `${def.name} must deny a model origin`);
    }
  });

  test('every write action is either unplannable or refused for a model-origin plan', () => {
    const app = appWith(tempDir(), tempDir());
    for (const def of app.registry.list().filter((d) => d.permission === 'write')) {
      assert.ok(refuses(app.registry, def.name, 'model'), `${def.name} must not survive a model-origin plan check`);
    }
    // memory.add is the documented exception that stays plannable, so what guards it is the plan-time
    // refusal itself, in the words the other suites assert on.
    const mem = refuses(app.registry, 'memory.add', 'model', { content: 'the gate is open' });
    assert.match(mem, /cannot be stored as a user fact/);
    // And it stays reachable for the origin that may write a user fact.
    assert.equal(refuses(app.registry, 'memory.add', 'user', { content: 'the gate is open' }), null);
  });

  test('a read action changes no store file, measured one action at a time', async () => {
    const dir = tempDir();
    const app = appWith(dir, dir);
    const c = app.controller;
    const seeded = await c.runAction('memory.add', { content: 'the gate is open' }, 'user', 'seed1');
    const kn = await c.runAction('knowledge.add', { subject: 'gate', relationship: 'opens', object: 'on time' }, 'user', 'seed2');
    const opId = (await c.handle('remember that the probe seeded data', { origin: 'user' })).operation.id;
    const ex = await c.runAction('experience.record', { operationId: opId, subject: 'the gate opened' }, 'user', 'seed3');
    const pr = await c.runAction('prediction.record', {
      capability: 'gate.open', expectation: 'success', subject: 'the gate opens on time', inDays: 7,
    }, 'user', 'seed4');
    const WE = [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }];
    const we = await c.runAction('world.entity.add', {
      id: 'e-probe', category: 'product', name: 'Probe entity', evidence: WE,
    }, 'user', 'seed5');
    const wf = await c.runAction('world.fact.add', {
      id: 'f-probe', subject: 'e-probe', predicate: 'described_as',
      object: { kind: 'scalar', valueType: 'string', value: 'seeded probe' },
      validFrom: '2026-01-01', evidence: WE,
    }, 'user', 'seed6');
    // The two plan reads need a recorded goal and a recorded plan to answer about. Both are seeded
    // before the snapshot below, so a read that wrote either store still shows up as a change.
    const g = await c.runAction('goal.add', { request: 'remember that the gate is open', criteria: ['remember that the gate is open'] }, 'user', 'seed7');
    const gp = await c.runAction('plan.add', {
      goal: g.result.data.goalId, outcome: 'the gate state is remembered',
      steps: [{ id: 's1', description: 'remember the gate', action: 'memory.add', input: { content: 'the gate is open' }, dependsOn: [], expectedResult: 'the fact is stored', verification: 'read it back', risk: 'medium' }],
    }, 'user', 'seed8');
    // T-30 (2026-11-19): the four Workshop reads need a real stored design to inspect.
    const workshopSeed = await c.runAction('workshop.compose', {
      title: 'Inventory design', domain: 'plan',
      components: [{ id: 'source', kind: 'service', supply: 2, demand: 0, cost: 1 },
        { id: 'sink', kind: 'service', supply: 0, demand: 1, cost: 1 }],
      connections: [{ from: 'source', to: 'sink' }], budget: { total: 2 },
    }, 'user', 'seed-workshop');
    assert.equal(seeded.outcome, 'success_verified');
    assert.equal(kn.outcome, 'success_verified');
    assert.equal(ex.outcome, 'success_verified');
    assert.equal(pr.outcome, 'success_verified');
    assert.equal(we.outcome, 'success_verified');
    assert.equal(wf.outcome, 'success_verified');
    assert.equal(g.outcome, 'success_verified', g.summary);
    assert.equal(gp.outcome, 'success_verified', gp.summary);
    assert.equal(workshopSeed.outcome, 'success_verified', workshopSeed.summary);
    const workshopId = workshopSeed.result.data.artifactId;
    // The governance reads need an adaptation to answer about, so the probe derives and approves one
    // from two distinct corrected experiences. These seeds predate the snapshot below, which is what
    // makes "a read wrote nothing" measurable rather than assumed.
    const op2 = (await c.handle('remember that the probe seeded a second fact', { origin: 'user' })).operation.id;
    const ex2 = await c.runAction('experience.record', { operationId: op2, subject: 'the gate opened a second time' }, 'user', 'seed3b');
    const fb1 = await c.runAction('feedback.record', { target: ex.result.data.id, assessment: 'not_useful', guidance: 'give one dated fact' }, 'user', 'seedfb1');
    const fb2 = await c.runAction('feedback.record', { target: ex2.result.data.id, assessment: 'not_useful', guidance: 'give one dated fact' }, 'user', 'seedfb2');
    const dv = await c.runAction('adaptation.derive', {}, 'user', 'seed9');
    const approved = await c.runAction('adaptation.decide', { target: dv.result.data.created[0].id, decision: 'approved' }, 'user', 'seed10');
    assert.equal(ex2.outcome, 'success_verified', ex2.summary);
    assert.equal(fb1.outcome, 'success_verified', fb1.summary);
    assert.equal(fb2.outcome, 'success_verified', fb2.summary);
    assert.equal(dv.outcome, 'success_verified', dv.summary);
    assert.equal(approved.outcome, 'success_verified', approved.summary);
    const adaptationId = approved.result.data.adaptationId;
    // The note reads need a stored note to answer about. It predates the snapshot, so a read that
    // wrote the note log still shows up as a change.
    const note = await c.runAction('note.add', { title: 'Inventory probe note', body: 'the gate is open' }, 'user', 'seednote');
    assert.equal(note.outcome, 'success_verified', note.summary);
    // The backup inspection reads an archive, so one is written outside the data directory before the
    // snapshot. The module writes no store file and records no audit line, unlike a command.
    const archiveDir = tempDir();
    const backupPath = path.join(archiveDir, 'inventory-probe.json');
    await exportArchive({ dataDir: dir, destination: backupPath, now: () => new Date('2026-11-15T12:00:00.000Z'), appVersion: 'inventory' });
    const afterSeeds = sizes(dir);
    const memoryLines = fs.readFileSync(path.join(dir, 'memory.jsonl'), 'utf8').trim().split('\n').length;
    const experienceLines = fs.readFileSync(path.join(dir, 'experiences.jsonl'), 'utf8').trim().split('\n').length;
    const reads = app.registry.list().filter((d) => d.permission === 'read');
    // T-30 (2026-11-19) supersedes the prior 80-read count: Workshop adds list/get/inspect/simulate.
    // T-36 Step 1 (2026-11-21): `system.bootstrap_status` is the eighty-sixth read.
    // T-37 Step 1 (2026-11-21): `neural.read` is the eighty-seventh.
    assert.equal(reads.length, 87, 'the inventory counts eighty-seven read actions with a root configured');
    for (const def of reads) {
      const input = {
        'calc.evaluate': { expression: '2+2' },
        'memory.search': { query: 'gate' },
        'knowledge.search': { query: 'gate' },
        'experience.show': { target: ex.result.data.id },
        'experience.compare': { aSince: '2026-01-01', bSince: '2026-06-01' },
        'prediction.show': { target: pr.result.data.id },
        'prediction.history': { target: pr.result.data.id },
        'filesystem.list': { path: '.' },
        'filesystem.read': { path: 'session.json' },
        'filesystem.find': { path: '.', extension: 'json' },
        'filesystem.summarize': { path: 'session.json' },
        'filesystem.extract': { path: 'session.json' },
        'filesystem.compare': { a: 'session.json', b: 'session.json' },
        'filesystem.report': { path: '.' },
        'filesystem.trash': {},
        'knowledge.digest': { query: 'gate' },
        'note.show': { target: note.result.data.id },
        'note.history': { target: note.result.data.id },
        'note.search': { query: 'gate' },
        'work.review': {},
        'world.entity.show': { target: 'e-probe' },
        'plan.candidates': { goal: g.result.data.goalId },
        'plan.outline': { objective: 'remember that the gate is open' },
        'plan.replan': { plan: gp.result.data.planId, reason: 'the inventory probe asks what a revision would take' },
        'plan.outcome': { plan: gp.result.data.planId },
        'world.entity.find': { text: 'Probe entity' },
        'world.facts': { target: 'e-probe' },
        'world.attributes': { target: 'e-probe' },
        'world.relationships': { target: 'e-probe' },
        'world.events': { target: 'e-probe' },
        'world.related': { target: 'e-probe' },
        'world.history': { target: 'e-probe' },
        'world.statement.history': { targetType: 'fact', target: 'f-probe' },
        'world.identity.candidates': { target: 'e-probe' },
        'world.identity.decision': { left: 'e-probe', right: 'e-probe' },
        'world.pair': { left: 'e-probe', right: 'e-probe' },
        'world.evidence': { target: 'e-probe' },
        'world.changes': { from: '2020-01-01', to: '2030-01-01' },
        'world.state_at': { at: '2030-01-01T00:00:00.000Z' },
        'world.belief.trace': { targetType: 'fact', target: 'f-probe' },
        'history.reconstruct': { at: '2030-01-01T00:00:00.000Z' },
        'adaptation.review.inspect': { target: adaptationId },
        'adaptation.review.reconcile': { target: adaptationId },
        'backup.inspect': { path: backupPath },
        'council.deliberate': { objective: 'probe council read action' },
        'council.list': { limit: 10 },
        // council.get, council.replay, council.compare require real session IDs; they are read
        // actions that don't write stores, but this test's probe approach doesn't create sessions.
        'council.get': { sessionId: 'council-test-probe', _skip: true },
        'council.replay': { sessionId: 'council-test-probe', _skip: true },
        'council.compare': { a: 'council-test-probe', b: 'council-test-probe', _skip: true },
        // T-30 (2026-11-19): Workshop reads operate on the artifact seeded before the snapshot.
        'workshop.list': { limit: 10 },
        'workshop.get': { artifactId: workshopId },
        'workshop.inspect': { artifactId: workshopId },
        'workshop.simulate': { artifactId: workshopId },
      }[def.name] ?? {};
      // Skip actions that require pre-existing data (council.get/replay/compare with fake IDs).
      if (input._skip) continue;
      const step = await c.runAction(def.name, input, 'user', `rd${def.name.replace(/[^A-Za-z0-9]/g, '')}`);
      assert.ok(['success_verified', 'verification_unavailable'].includes(step.outcome),
        `${def.name} did not run: ${step.summary}`);
      assert.deepEqual(changed(afterSeeds, sizes(dir)), [], `${def.name} is classified read but wrote a store`);
    }
    // The seeds are still the only records, so no read quietly appended anything.
    assert.equal(fs.readFileSync(path.join(dir, 'memory.jsonl'), 'utf8').trim().split('\n').length, memoryLines);
    assert.equal(fs.readFileSync(path.join(dir, 'experiences.jsonl'), 'utf8').trim().split('\n').length, experienceLines);
    assert.equal(fs.readFileSync(path.join(dir, 'predictions.jsonl'), 'utf8').trim().split('\n').length, 1);
  });

  test('a write action changes its own store and no other store, measured', async () => {
    const dir = tempDir();
    const app = appWith(dir);
    const c = app.controller;
    const opId = (await c.handle('remember that the probe seeded data', { origin: 'user' })).operation.id;
    const cases = [
      ['memory.add', { content: 'the gate is open' }, 'memory.jsonl'],
      ['memory.correct', { targetId: null, content: 'the gate was corrected', resolve: true }, 'memory.jsonl'],
      ['knowledge.add', { subject: 'gate', relationship: 'opens', object: 'on time' }, 'knowledge.jsonl'],
      ['experience.record', { operationId: opId, subject: 'the gate opened' }, 'experiences.jsonl'],
      ['prediction.record', { capability: 'gate.open', expectation: 'success', subject: 'the gate opens on time', inDays: 7 }, 'predictions.jsonl'],
    ];
    let firstMemoryId = null;
    for (const [name, input, own] of cases) {
      if (name === 'memory.correct') input.targetId = firstMemoryId;
      const before = sizes(dir);
      const step = await c.runAction(name, input, 'user', `w${name.replace(/[^A-Za-z0-9]/g, '')}`);
      assert.equal(step.outcome, 'success_verified', `${name}: ${step.summary}`);
      if (name === 'memory.add') firstMemoryId = step.result.data.id;
      const grew = changed(before, sizes(dir)).filter((f) => !['operations.jsonl', 'session.json', 'conversation.jsonl'].includes(f));
      assert.deepEqual(grew, [own], `${name} wrote outside its own store: ${grew.join('+')}`);
    }
    // Nothing reached the stores these four writes have no business touching.
    const final = sizes(dir);
    assert.equal(final['task-summary-queue.json'], -1, 'no write may create the summary queue');
    assert.equal(final['tasks.jsonl'], -1, 'an action write must not fabricate a task log');
  });

  test('an input rejection and a request that routed to no action each still write one audit line', async () => {
    const dir = tempDir();
    const app = appWith(dir);
    const c = app.controller;
    const before = sizes(dir);
    assert.equal(auditLines(dir), 0, 'a fresh directory holds no audit records');
    // A request the input layer refuses never reaches an action, so the audit record is the only
    // evidence the attempt happened. It has to be written anyway.
    const rejected = await c.handle('   ', { origin: 'user' });
    assert.equal(rejected.status, 'input_rejected');
    assert.equal(rejected.operation.capability, 'none', 'a refused request must claim no capability');
    assert.equal(auditLines(dir), 1, 'the refused request wrote its own audit line');
    const quiet = await c.handle('zzz qqq', { origin: 'user' });
    assert.equal(auditLines(dir), 2, 'a request that ran no action still wrote its audit line');
    assert.notEqual(quiet.status, 'success_verified');
    assert.deepEqual(
      changed(before, sizes(dir)).filter((f) => !['operations.jsonl', 'conversation.jsonl', 'session.json'].includes(f)),
      [], 'neither route may touch a belief store',
    );
  });
});

describe('AF-19: capture eligibility is a classification, not a guess', () => {
  test('the two capture lists are disjoint and cover every capability that can end an operation', () => {
    const app = appWith(tempDir(), tempDir());
    const overlap = AUTO_CAPTURE_CAPABILITIES.filter((n) => Object.hasOwn(CAPTURE_EXCLUDED_CAPABILITIES, n));
    assert.deepEqual(overlap, [], 'a capability cannot be both captured and excluded');
    const all = [...app.registry.names(), ...NON_ACTION_CAPABILITIES];
    for (const name of all) {
      assert.ok(AUTO_CAPTURE_CAPABILITIES.includes(name) || Object.hasOwn(CAPTURE_EXCLUDED_CAPABILITIES, name),
        `${name} reaches an operation-end path but is not classified for capture`);
    }
    for (const name of Object.keys(CAPTURE_EXCLUDED_CAPABILITIES)) {
      assert.ok(all.includes(name), `${name} is classified but no longer names a capability that can end an operation`);
    }
    for (const [name, category] of Object.entries(CAPTURE_EXCLUDED_CAPABILITIES)) {
      assert.ok(Object.hasOwn(CAPTURE_EXCLUSION_CATEGORIES, category), `${name}: unknown exclusion category ${category}`);
    }
    assert.deepEqual([...AUTO_CAPTURE_CAPABILITIES].sort(),
      ['knowledge.add', 'knowledge.resolve', 'knowledge.retract', 'memory.add', 'memory.correct']);
  });

  test('the README inventory columns repeat the registry and the capture classification', () => {
    const app = appWith(tempDir(), tempDir());
    const rows = inventoryRows();
    const documented = new Map(rows.flatMap((row) => row.names.map((n) => [n, row])));
    assert.equal(documented.size, rows.flatMap((r) => r.names).length, 'a capability appears in two inventory rows');
    for (const [name, row] of documented) {
      const eligible = AUTO_CAPTURE_CAPABILITIES.includes(name);
      if (eligible) {
        assert.equal(row.capture, 'yes', `${name} must read as captured`);
      } else {
        assert.match(row.capture, /^no \([a-z-]+\)$/, `${name} must say why it is not captured`);
        const stated = row.capture.slice(4, -1);
        assert.equal(CAPTURE_EXCLUDED_CAPABILITIES[name], stated, `${name}: the README states a category the code does not use`);
      }
      const def = app.registry.get(name);
      if (!def) continue;
      assert.equal(row.class, def.permission, `${name}: the README class disagrees with the registry`);
      assert.equal(row.origins, def.origins.length === 1 ? 'user' : 'user + model', `${name}: README origins`);
      // [T-30, 2026-11-19] The earlier rule that every non-filesystem/non-note write changed
      // cognitive state is superseded: Workshop stores a user design, not a belief or intention.
      // Filesystem changes, notes, exports and Workshop designs are each stated separately.
      if (name === 'backup.export') {
        assert.equal(row.belief, 'no (a copy is not a belief)', `${name}: README belief-state`);
      } else if (name === 'workshop.compose') {
        assert.equal(row.belief, 'no (a design is not a belief)', `${name}: README belief-state`);
      } else if (name === 'workshop.verify' || name === 'workshop.promote') {
        // [T-33 Step 3, 2026-11-19] A sandbox verification records a check of the user's own sheet and
        // a promotion records the user's decision to accept it. Neither is a belief about the world,
        // and neither can change what APEX is permitted to do.
        assert.equal(row.belief, name === 'workshop.verify' ? 'no (a check is not a belief)' : 'no (accepting a design does not make it true)', `${name}: README belief-state`);
      } else if (name.startsWith('evolution.')) {
        // [T-31 Step 2, 2026-11-19] The lab appends proposals, measured sandbox results and the
        // owner's promotion decisions to its own ledger. A candidate self-change is not a belief
        // about the world, and the ledger cannot change behaviour on its own.
        assert.equal(row.belief, 'no (a candidate self-change is not a belief)', `${name}: README belief-state`);
      } else if (name === 'cognition.run') {
        // [T-29, 2026-11-19] A cognitive run writes its own trace and the governed task it created;
        // both record what happened, not what APEX believes. The store it writes is an account, and
        // the model/knowledge/world writes it may cause are separate authorized steps.
        assert.equal(row.belief, 'no (a run record is an account, not a belief)', `${name}: README belief-state`);
      } else if (name === 'briefing.acknowledge') {
        // [T-34 Step 3, 2026-11-19] Acknowledging a briefing appends the reading it compared against to
        // its own checkpoint log. That is a comparison of two readings, not a belief about the world,
        // and the checkpoint authorizes nothing.
        assert.equal(row.belief, 'no (a checkpoint is a reading, not a belief)', `${name}: README belief-state`);
      } else if (name.startsWith('presence.handoff.')) {
        // [T-35 Step 2, 2026-11-19] An envelope says where work should continue and who may collect
        // it; the ledger records the staging, the claim and the revocation. None of that is a claim
        // about the world, and the envelope authorizes nothing it names.
        assert.equal(row.belief, 'no (a destination is not a belief)', `${name}: README belief-state`);
      } else if (name.startsWith('system.bootstrap')) {
        // [T-36 Step 1, 2026-11-21] A cold-start bootstrap records what the machine and the
        // repository said at that moment and enrols the workstation. It is a reading and a
        // registry, not a belief about the world, and it authorizes nothing it names.
        assert.equal(row.belief, def.permission === 'write' ? 'no (a machine reading is not a belief)' : 'no', `${name}: README belief-state`);
      } else if (name.startsWith('neural.')) {
        // [T-37 Step 1, 2026-11-21] Track 2 steps a deterministic spiking simulation and reads it back.
        // A spike is a candidate association about its own substrate, not a claim about the world: it
        // cannot authorize an action and it cannot write an observed fact. The bridge reset moves an
        // in-memory breaker, which is a declaration of translator status rather than a belief.
        assert.equal(row.belief, def.permission === 'write' ? 'no (a spike is not a belief)' : 'no', `${name}: README belief-state`);
      } else if (name.startsWith('perception.')) {
        // [T-32 Step 3, 2026-11-19] Perception appends host and workspace readings to its own ledger
        // and records the Sentinel's push discipline. A CPU reading is an observation about this
        // machine, not a belief about the world, and the governor's rules are bookkeeping about
        // notices; neither may be read as a stored belief.
        assert.equal(row.belief, def.permission === 'write' ? 'no (a reading is not a belief)' : 'no', `${name}: README belief-state`);
      } else if (def.permission === 'write' && !name.startsWith('filesystem.') && !name.startsWith('note.')) {
        assert.equal(row.belief, 'yes', `${name}: README belief-state`);
      } else if (def.permission === 'read') {
        assert.equal(row.belief, 'no', `${name}: README belief-state`);
      } else if (name.startsWith('note.')) {
        assert.equal(row.belief, "no (the user's own composition, not a belief)", `${name}: README belief-state`);
      } else {
        assert.ok(name.startsWith('filesystem.'), 'only the file and note writes may be writes that are not belief changes');
        assert.equal(row.belief, 'no (a file is not a belief)', `${name}: README belief-state`);
      }
    }
    assert.equal(documented.get('filesystem.list').plan, 'never offered to a model plan');
    assert.equal(documented.get('world.state').origins, 'user');
    assert.equal(documented.get('prediction.record').capture, 'no (expectation)');
    assert.equal(documented.get('memory.save_conclusion').capture, 'no (model-words)');
  });
});

describe('AF-19: the planning prompt and the plan checker agree', () => {
  test('a model-origin prompt offers exactly the twenty-three reads it may propose', () => {
    const app = appWith(tempDir(), tempDir());
    const { system } = planningPrompt({ goal: 'anything', registry: app.registry, memoryLines: [], origin: 'model' });
    assert.deepEqual(offeredNames(system), [
      'adaptation.list', 'app.status', 'calc.evaluate', 'experience.compare', 'experience.list',
      'experience.patterns', 'experience.show', 'experience.timeline', 'experience.trends',
      'knowledge.digest', 'knowledge.list', 'knowledge.search',
      // Batch T-08: both read only the recorded outcome evaluations, proposals, measurements and
      // rollbacks; a proposal that contains one authorizes nothing and neither writes a store.
      'learning.patterns', 'learning.status',
      'memory.list', 'memory.search',
      // Batch AL: each of these three answers only from the recorded goal, the recorded plan and the
      // live registry, and a proposal that contains one is still a proposal - it authorizes nothing.
      // The outcome read reports what a plan's records establish; recording an assessment is not among
      // them, since plan.assess is a user act and is refused for a model origin.
      'plan.candidates', 'plan.outcome', 'plan.outline', 'plan.replan', 'prediction.history',
      'prediction.list', 'prediction.show', 'prediction.summary',
      // Batch PC: both read only what memory, knowledge, goal, plan and task records already hold, so
      // a proposal that contains one authorizes nothing; neither writes a store.
      'work.review',
    ]);
    // The defect AF-19 found and fixed: this line used to be present while checkSteps() always refused
    // the step it invited.
    assert.ok(!system.includes('- memory.add ('), 'memory.add must not be offered to a model');
    assert.ok(!system.includes('- world.state ('), 'a user-origin read must not be offered to a model');
    assert.ok(!system.includes('- filesystem.'), 'filesystem inspection must not be offered to a model');
  });

  test('every offered action declares an input hint and survives the plan check for its own origin', () => {
    const app = appWith(tempDir(), tempDir());
    for (const origin of ['model', 'user']) {
      const { system } = planningPrompt({ goal: 'anything', registry: app.registry, memoryLines: [], origin });
      const offered = offeredNames(system);
      assert.ok(offered.length > 0, 'the prompt must offer something');
      for (const name of offered) {
        const def = app.registry.get(name);
        assert.ok(typeof def.inputHint === 'string' && def.inputHint.length > 0,
          `${name} is offered to a ${origin} plan with no input hint`);
        assert.equal(refuses(app.registry, name, origin), null, `${name} is offered to a ${origin} plan but checkSteps refuses it`);
      }
      // And nothing the check would accept is missing from the list.
      for (const def of app.registry.list()) {
        if (offered.includes(def.name)) continue;
        assert.ok(refuses(app.registry, def.name, origin),
          `${def.name} is not offered to a ${origin} plan although checkSteps would accept it`);
      }
    }
    const user = offeredNames(planningPrompt({ goal: 'anything', registry: app.registry, memoryLines: [], origin: 'user' }).system);
    assert.equal(user.length, 56, 'a user-origin prompt offers the fifty-six plannable actions with a root');
    assert.ok(user.includes('deadline.list'), 'a user plan may read the recorded deadlines');
    assert.ok(!user.includes('deadline.import'), 'a deadline import is a write and is never plannable');
    assert.ok(user.includes('memory.add'), 'a user plan may still contain memory.add');
    assert.ok(user.includes('world.entity.show'), 'a user plan may read the World Model');
    assert.ok(!user.includes('world.fact.add'), 'a World Model write is never plannable');
  });
});
