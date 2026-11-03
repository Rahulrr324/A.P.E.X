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
  'tasks.jsonl', 'task-summary-queue.json', 'knowledge.jsonl', 'experiences.jsonl', 'predictions.jsonl'];
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

// The capabilities that are not registry actions but do end an operation. Frozen here on purpose: a new
// route has to be named in this list and classified for capture, or these tests fail.
const NON_ACTION_CAPABILITIES = [
  'model.answer', 'task.plan', 'task.run', 'task.approve', 'task.retry', 'task.cancel',
  'task.explain', 'task.step', 'none',
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
    assert.equal(plain.registry.list().length, 32, 'the default registry has 32 actions');
    const rooted = appWith(tempDir(), plain.dataDir);
    assert.deepEqual(
      [...rooted.registry.names()],
      [...plain.registry.names(), 'filesystem.list', 'filesystem.read'].sort(),
      'a configured root adds exactly the two inspection actions',
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
    assert.equal(writes.length, 14, 'the inventory counts fourteen write actions');
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
    assert.equal(seeded.outcome, 'success_verified');
    assert.equal(kn.outcome, 'success_verified');
    assert.equal(ex.outcome, 'success_verified');
    assert.equal(pr.outcome, 'success_verified');
    const afterSeeds = sizes(dir);
    const reads = app.registry.list().filter((d) => d.permission === 'read');
    assert.equal(reads.length, 20, 'the inventory counts twenty read actions with a root configured');
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
      }[def.name] ?? {};
      const step = await c.runAction(def.name, input, 'user', `rd${def.name.replace(/[^A-Za-z0-9]/g, '')}`);
      assert.ok(['success_verified', 'verification_unavailable'].includes(step.outcome),
        `${def.name} did not run: ${step.summary}`);
      assert.deepEqual(changed(afterSeeds, sizes(dir)), [], `${def.name} is classified read but wrote a store`);
    }
    // The seeds are still the only records, so no read quietly appended anything.
    assert.equal(fs.readFileSync(path.join(dir, 'memory.jsonl'), 'utf8').trim().split('\n').length, 2);
    assert.equal(fs.readFileSync(path.join(dir, 'experiences.jsonl'), 'utf8').trim().split('\n').length, 1);
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
      assert.equal(row.belief, def.permission === 'write' ? 'yes' : 'no', `${name}: README belief-state`);
    }
    assert.equal(documented.get('filesystem.list').plan, 'never offered to a model plan');
    assert.equal(documented.get('world.state').origins, 'user');
    assert.equal(documented.get('prediction.record').capture, 'no (expectation)');
    assert.equal(documented.get('memory.save_conclusion').capture, 'no (model-words)');
  });
});

describe('AF-19: the planning prompt and the plan checker agree', () => {
  test('a model-origin prompt offers exactly the seventeen reads it may propose', () => {
    const app = appWith(tempDir(), tempDir());
    const { system } = planningPrompt({ goal: 'anything', registry: app.registry, memoryLines: [], origin: 'model' });
    assert.deepEqual(offeredNames(system), [
      'adaptation.list', 'app.status', 'calc.evaluate', 'experience.compare', 'experience.list',
      'experience.patterns', 'experience.show', 'experience.timeline', 'experience.trends',
      'knowledge.list', 'knowledge.search', 'memory.list', 'memory.search', 'prediction.history',
      'prediction.list', 'prediction.show', 'prediction.summary',
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
    assert.equal(user.length, 21, 'a user-origin prompt offers the twenty-one plannable actions');
    assert.ok(user.includes('memory.add'), 'a user plan may still contain memory.add');
  });
});
