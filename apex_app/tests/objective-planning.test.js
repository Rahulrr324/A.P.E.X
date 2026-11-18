// T-17: general objective planning.
//
// The planning read is composed over the existing T-03 outline: a typed intake that keeps the
// user's words apart from what this read inferred, a milestone hierarchy proposed from the
// capability families the mapped steps already name, a six-way feasibility class for every task,
// and a recordable draft that carries the milestones. Nothing here records, approves, or runs.
//
// The pure cases run against a stub registry so each class is exact. The integration cases run
// through the real app, the real registry, the real plan store, and the CLI; no model endpoint is
// contacted and no inference of any kind is performed.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { ActionRegistry } from '../src/actions/registry.js';
import { validatePlanContent } from '../src/plans/model.js';
import { planObjective, planningContent, PLANNING_SCHEMA } from '../src/planning/compose.js';
import { classifyTasks, TASK_CLASSES } from '../src/planning/feasibility.js';
import { intakeOf, INTAKE_SCHEMA } from '../src/planning/intake.js';
import { renderPlanning } from '../src/planning/render.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function stubRegistry(extra = []) {
  const registry = new ActionRegistry();
  const add = (name, permission, description, { plannable = true } = {}) => registry.register({
    name,
    description,
    permission,
    plannable,
    origins: permission === 'write' ? ['user'] : ['user', 'model'],
    validate: (input) => input ?? {},
    async execute() { return { summary: name }; },
    async verify() { return { ok: true, detail: 'stub' }; },
  });
  add('memory.add', 'write', 'Save a fact or note into memory');
  add('memory.search', 'read', 'Search stored memories');
  add('note.list', 'read', 'List structured notes');
  add('calc.evaluate', 'read', 'Evaluate an arithmetic expression');
  add('knowledge.digest', 'read', 'Summarise what the knowledge store holds');
  add('filesystem.list', 'read', 'List the contents of a directory');
  for (const action of extra) add(...action);
  return registry;
}

describe('T-17: objective intake keeps provenance apart', () => {
  test('flags are user_stated, goal items keep their own basis, and deliverables come only from the user', () => {
    const registry = stubRegistry();
    const goal = {
      id: 'goal-1',
      revision: 3,
      status: 'open',
      priority: 2,
      deadline: '2026-12-01',
      prerequisites: [{ text: 'the ledger is open', basis: 'verified_fact', ref: 'op-9' }],
      constraints: [{ text: 'office hours only', basis: 'assumption' }],
      resources: [{ text: 'the shared workspace', basis: 'user_stated' }],
      unknowns: [{ text: 'which vendor to use', basis: 'user_stated' }],
      criteria: [{ id: 'c1', description: 'the note exists', basis: 'user_stated', requirement: 'required' }],
    };
    const planning = planObjective({
      objective: 'remember the build passed; recall build',
      registry,
      goal,
      stated: {
        constraints: ['within the sprint'],
        deliverables: ['a note the user can read'],
        preferences: ['no model calls'],
        resources: ['the local store'],
        deadlines: ['2026-11-30'],
        priority: 'high',
      },
    });
    const intake = planning.intake;
    assert.equal(intake.schema, INTAKE_SCHEMA);
    assert.equal(intake.objective.basis, 'user_stated');
    assert.equal(intake.goal.id, 'goal-1');
    assert.equal(intake.goal.revision, 3);

    const flagConstraint = intake.constraints.find((c) => c.text === 'within the sprint');
    assert.equal(flagConstraint.basis, 'user_stated');
    assert.equal(flagConstraint.source, 'flag');
    const goalConstraint = intake.constraints.find((c) => c.text === 'office hours only');
    assert.equal(goalConstraint.basis, 'assumption', 'a goal assumption is not promoted to a fact');
    assert.equal(goalConstraint.source, 'goal.constraints');
    const prerequisite = intake.constraints.find((c) => c.text === 'the ledger is open');
    assert.equal(prerequisite.basis, 'verified_fact');
    assert.equal(prerequisite.ref, 'op-9');

    assert.deepEqual(intake.deliverables.map((d) => d.text), ['a note the user can read']);
    assert.equal(intake.deliverables[0].basis, 'user_stated');
    assert.equal(intake.resources.some((r) => r.text === 'the shared workspace'), true);
    assert.equal(intake.preferences[0].source, 'flag');
    assert.equal(intake.deadlines.some((d) => d.text === '2026-12-01'), true, 'the goal deadline is read');
    assert.equal(intake.deadlines.some((d) => d.text === '2026-11-30'), true, 'the stated deadline is read');
    assert.equal(intake.priorities.some((p) => p.text === 'goal priority 2 of 5'), true);
    assert.equal(intake.priorities.some((p) => p.text === 'priority: high'), true);

    assert.equal(intake.unknowns.some((u) => u.text === 'which vendor to use'), true);
    assert.equal(intake.successCriteria[0].id, 'c1');
    assert.equal(intake.assumptions.length, 1);
    assert.equal(intake.assumptions[0].basis, 'system_inferred');
    assert.match(intake.assumptions[0].text, /did not check that the goal's success criteria are met/);
    assert.equal(intake.records.goalRead, true);
  });

  test('a part no capability carries becomes an unknown and a competing reading with a question', () => {
    const registry = stubRegistry([['ledger.archive', 'read', 'Archive a vendor bookmark']]);
    const planning = planObjective({
      objective: 'remember the build passed; bookmark the vendor',
      registry,
    });
    const ambiguity = planning.ambiguity;
    assert.equal(ambiguity.material, true);
    assert.deepEqual(ambiguity.interpretations.map((i) => i.kind), ['supported_only', 'supply_missing']);
    assert.equal(ambiguity.questions.length, 1);
    assert.match(ambiguity.questions[0].question, /bookmark the vendor/);
    assert.deepEqual(ambiguity.questions[0].candidates, ['ledger.archive']);

    const unknown = planning.intake.unknowns.find((u) => u.text === 'bookmark the vendor');
    assert.equal(unknown.basis, 'system_inferred', 'an unmatched part is this read\'s finding, not the user\'s fact');
    assert.match(unknown.question, /which registered capability/);
    assert.equal(planning.tasks.find((t) => t.kind === 'unmapped').class, 'needs_input');
  });

  test('a closed goal, a recorded blocker, and an excluded capability are read as conflicts', () => {
    const registry = stubRegistry();
    const closed = planObjective({
      objective: 'remember the build passed',
      registry,
      goal: { id: 'goal-2', revision: 1, status: 'completed' },
    });
    assert.equal(closed.conflicts[0].kind, 'goal_closed');
    assert.equal(closed.conflicts[0].basis, 'verified_fact');

    const blocked = planObjective({
      objective: 'remember the build passed',
      registry,
      goal: { id: 'goal-3', revision: 1, status: 'open', blockers: [{ text: 'the store is locked', basis: 'user_stated' }] },
    });
    assert.equal(blocked.conflicts[0].kind, 'goal_blocker');
    assert.equal(blocked.conflicts[0].text, 'the store is locked');

    const excluded = planObjective({
      objective: 'remember the build passed; recall build',
      registry,
      cannotUse: ['memory.add'],
    });
    const conflict = excluded.conflicts.find((c) => c.kind === 'request_excludes_named_capability');
    assert.ok(conflict);
    assert.equal(conflict.basis, 'user_stated');
    assert.equal(excluded.ambiguity.interpretations.some((i) => i.kind === 'exclusions_honored'), true);
  });

  test('malformed and secret input is refused before a plan is proposed', () => {
    const registry = stubRegistry();
    assert.throws(() => intakeOf({ objective: '' }), /an objective is required/);
    assert.throws(() => planObjective({ objective: 'x'.repeat(501), registry }), /1 to 500 characters/);
    assert.throws(() => planObjective({ objective: 'the password is hunter2', registry }), /password, key, or token/);
    assert.throws(
      () => planObjective({ objective: 'remember the build passed', registry, stated: { constraints: [42] } }),
      /constraints must be text/,
    );
    assert.throws(
      () => planObjective({ objective: 'remember the build passed', registry, stated: { constraints: Array.from({ length: 13 }, (_, i) => `c${i}`) } }),
      /at most 12 items/,
    );
    assert.throws(
      () => planObjective({ objective: 'remember the build passed', registry, stated: { priority: {} } }),
      /priority must be text/,
    );
  });
});

describe('T-17: six-way feasibility is the live registry\'s answer', () => {
  test('an approval is the one plan-level gate: eligible steps are needs_approval, never ready', () => {
    const registry = stubRegistry();
    const planning = planObjective({ objective: 'remember the build passed; recall build', registry });
    assert.deepEqual(planning.feasibility.classes, [...TASK_CLASSES]);
    assert.equal(planning.feasibility.approval.bound, false);
    assert.ok(planning.tasks.every((t) => t.class === 'needs_approval'));
    assert.equal(planning.counts.ready, 0);
    assert.equal(planning.counts.needs_approval, 2);
    assert.ok(registry.get('memory.add'));
    // The same steps become ready only when the caller supplies a bound approval, which this
    // read never does. Tested directly so the class is not a claim the planning read can make.
    const ready = classifyTasks({
      tasks: [
        { id: 's1', kind: 'step', action: 'memory.add', dependsOn: [] },
        { id: 's2', kind: 'step', action: 'memory.search', dependsOn: ['s1'] },
      ],
      registry,
      approval: { bound: true },
    });
    assert.deepEqual(ready.rows.map((r) => r.class), ['ready', 'ready']);
  });

  test('unsupported, blocked cascade, and needs_input are distinguished by evidence', () => {
    const registry = new ActionRegistry();
    const add = (name, permission, description, plannable = true) => registry.register({
      name,
      description,
      permission,
      plannable,
      origins: permission === 'write' ? ['user'] : ['user', 'model'],
      validate: (input) => input ?? {},
      async execute() { return { summary: name }; },
      async verify() { return { ok: true, detail: 'stub' }; },
    });
    add('note.list', 'read', 'List structured notes', false);
    add('memory.search', 'read', 'Search stored memories');
    const cascade = planObjective({ objective: 'list notes; recall build', registry });
    assert.equal(cascade.tasks[0].class, 'unsupported');
    assert.match(cascade.tasks[0].because, /may never appear as a plan step/);
    assert.equal(cascade.tasks[1].class, 'blocked');
    assert.deepEqual(cascade.tasks[1].blockedBy, ['s1']);
    assert.match(cascade.tasks[1].because, /s1 \(unsupported\)/);

    // The router names memory.add, but this configuration does not hold it, and nothing shares its
    // words, so the part is unsupported rather than offered a nearby guess.
    const absent = planObjective({ objective: 'remember the build passed', registry: new ActionRegistry() });
    assert.equal(absent.tasks[0].class, 'unsupported');
    assert.equal(absent.tasks[0].kind, 'unmapped');
    assert.match(absent.tasks[0].because, /not available in this configuration/);

    const withNearby = planObjective({
      objective: 'remember the build passed; bookmark the vendor',
      registry: stubRegistry([['ledger.archive', 'read', 'Archive a vendor bookmark']]),
    });
    const unmatched = withNearby.tasks.find((t) => t.kind === 'unmapped');
    assert.equal(unmatched.class, 'needs_input');
    assert.deepEqual(unmatched.nearby, ['ledger.archive']);
  });

  test('a supplied verified record is completed, and its dependent is not blocked by it', () => {
    const registry = stubRegistry();
    const planning = planObjective({
      objective: 'remember the build passed; recall build',
      registry,
      completed: { s1: { ref: 'op-verified-1' } },
    });
    assert.equal(planning.tasks[0].class, 'completed');
    assert.match(planning.tasks[0].because, /op-verified-1/);
    assert.equal(planning.tasks[1].class, 'needs_approval');
    assert.equal(planning.counts.completed, 1);
  });

  test('an exclusion blocks the step it names and every step that depends on it', () => {
    const registry = stubRegistry();
    const planning = planObjective({
      objective: 'remember the build passed; recall build',
      registry,
      cannotUse: ['memory.add'],
    });
    assert.equal(planning.tasks[0].class, 'blocked');
    assert.match(planning.tasks[0].because, /asked this read not to offer memory\.add/);
    assert.equal(planning.tasks[1].class, 'blocked');
    assert.equal(planning.counts.excludedByRequest >= 1, true);
  });

  test('a dependency cycle blocks its members rather than inventing an order', () => {
    const registry = stubRegistry();
    const result = classifyTasks({
      tasks: [
        { id: 'a', kind: 'step', action: 'memory.add', dependsOn: ['b'] },
        { id: 'b', kind: 'step', action: 'memory.search', dependsOn: ['a'] },
      ],
      registry,
      approval: { bound: true },
    });
    assert.deepEqual(result.cycles, ['a', 'b']);
    assert.deepEqual(result.rows.map((r) => r.class), ['blocked', 'blocked']);
    assert.match(result.rows[0].because, /dependency cycle/);
    assert.throws(() => classifyTasks({ tasks: null, registry }), /requires the tasks/);
    assert.throws(() => classifyTasks({ tasks: [] }), /requires the live action registry/);
  });
});

describe('T-17: milestones and the recordable draft', () => {
  test('steps are grouped by capability family in written order and stay within the plan bound', () => {
    const registry = stubRegistry();
    const planning = planObjective({
      objective: 'remember A; list notes; calc: 2+2; knowledge digest; list files .',
      registry,
    });
    assert.equal(planning.milestones.length, 4);
    assert.deepEqual(planning.milestones.map((m) => m.families), [
      ['memory'], ['note'], ['calc'], ['knowledge', 'filesystem'],
    ]);
    assert.equal(planning.milestones[3].title, 'Remaining steps');
    assert.deepEqual(planning.milestones.map((m) => m.dependsOn), [[], ['m1'], ['m2'], ['m3']]);
    for (const milestone of planning.milestones) {
      assert.equal(milestone.basis, 'system_inferred');
      assert.match(milestone.checkpoint, /operation record whose outcome is verified/);
      assert.match(milestone.verification, /verifiers of/);
    }
    const cross = planning.crossMilestoneDependencies;
    assert.deepEqual(cross.map((d) => `${d.step}:${d.from}->${d.to}`), ['s2:m1->m2', 's3:m2->m3', 's4:m3->m4']);
  });

  test('the draft carries the milestones and validates under the plan content rules', () => {
    const registry = stubRegistry();
    const planning = planObjective({ objective: 'remember the build passed; list notes', registry });
    assert.equal(planning.draft.available, true);
    assert.equal(planning.draft.recordable, true);
    const content = planningContent(planning);
    assert.ok(content);
    assert.deepEqual(validatePlanContent(content), []);
    const contentMilestones = content.milestones.map((m) => m.id);
    assert.deepEqual(contentMilestones, ['m1', 'm2']);
    assert.deepEqual(content.steps.map((s) => s.milestoneId), ['m1', 'm2']);
    assert.equal(planning.draft.content.steps.length, 2);
    assert.equal(planning.authorizes, false);
    assert.equal(planning.recorded, false);
    assert.equal(planning.approved, false);
    assert.equal(planning.executable, false);
  });

  test('a draft that names an excluded capability is withheld instead of rewritten', () => {
    const registry = stubRegistry();
    const planning = planObjective({
      objective: 'remember the build passed; recall build',
      registry,
      cannotUse: ['memory.add'],
    });
    assert.equal(planning.draft.available, false);
    assert.match(planning.draft.reason, /memory\.add/);
    assert.equal(planning.draft.content, null);
  });

  test('per-task explanation states the capability, the basis, completion, and the absent estimate', () => {
    const registry = stubRegistry();
    const planning = planObjective({ objective: 'remember the build passed; bookmark the vendor', registry });
    const step = planning.tasks[0];
    assert.equal(step.explanation.capability, 'memory.add');
    assert.equal(step.explanation.evidence.registered, true);
    assert.equal(step.explanation.evidence.userAuthorized, 'allow');
    assert.equal(step.explanation.evidence.hasVerifier, true);
    assert.match(step.explanation.completion.verifiedBy, /verify\(\)/);
    assert.equal(step.explanation.estimate.seconds, null);
    assert.match(step.explanation.estimate.because, /no per-action duration/);
    assert.match(step.explanation.heuristic, /registry facts/);
    const unmatched = planning.tasks.find((t) => t.kind === 'unmapped');
    assert.equal(unmatched.explanation.capability, null);
    assert.deepEqual(unmatched.explanation.evidence.nearby, []);
    assert.match(unmatched.explanation.heuristic, /not a recommendation/);
  });
});

describe('T-17: determinism, authority, and rendering', () => {
  test('the same inputs reproduce the same digest; a moved goal, statement, or capability moves it', () => {
    const registry = stubRegistry();
    const goal = { id: 'goal-9', revision: 1, status: 'open' };
    const a = planObjective({ objective: 'remember the build passed', registry, goal, stated: { constraints: ['within office hours'] } });
    const b = planObjective({ objective: 'remember the build passed', registry, goal, stated: { constraints: ['within office hours'] } });
    assert.equal(a.digest, b.digest);
    assert.equal(a.schema, PLANNING_SCHEMA);
    const movedGoal = planObjective({ objective: 'remember the build passed', registry, goal: { ...goal, revision: 2 }, stated: { constraints: ['within office hours'] } });
    assert.notEqual(movedGoal.digest, a.digest);
    const movedStatement = planObjective({ objective: 'remember the build passed', registry, goal, stated: { constraints: ['outside office hours'] } });
    assert.notEqual(movedStatement.digest, a.digest);
    // A capability that moves changes the class the read reports, so the bytes change with it. An
    // unrelated action the answer never names is not part of the answer and must not move it.
    const restricted = new ActionRegistry();
    for (const def of registry.list()) {
      restricted.register(def.name === 'memory.add' ? { ...def, plannable: false } : def);
    }
    const movedCapability = planObjective({ objective: 'remember the build passed', registry: restricted, goal, stated: { constraints: ['within office hours'] } });
    assert.notEqual(movedCapability.digest, a.digest);
    assert.equal(movedCapability.tasks[0].class, 'unsupported');
    const unrelated = stubRegistry([['ledger.archive', 'read', 'Archive a vendor bookmark']]);
    const sameAnswer = planObjective({ objective: 'remember the build passed', registry: unrelated, goal, stated: { constraints: ['within office hours'] } });
    assert.equal(sameAnswer.digest, a.digest);
  });

  test('the rendered planning read is bounded and repeats the authority statement', () => {
    const registry = stubRegistry();
    const planning = planObjective({
      objective: 'remember the build passed; bookmark the vendor; list notes',
      registry,
      stated: { deliverables: ['a note'] },
    });
    const text = renderPlanning(planning);
    assert.match(text, /Objective planning \(apex\.objective-planning\.v1\) - nothing recorded, approved, or running/);
    assert.match(text, /Intake \(what the plan was read from\):/);
    assert.match(text, /Competing readings/);
    assert.match(text, /Milestones \(2, proposed from capability families\)/);
    assert.match(text, /Tasks \(3\):/);
    assert.match(text, /This read records, approves, and runs nothing/);
    assert.match(text, /a note \(deliverables, you stated\)/);
    assert.ok(text.length <= 16000, `render exceeded its bound: ${text.length}`);
    assert.equal(text.includes('password'), false);
  });
});

describe('T-17: plan.outline through the real app and CLI', () => {
  async function appIn(dir) {
    return createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF });
  }

  test('the controller composes the planning read and records nothing', async () => {
    const app = await appIn(tempDir());
    const before = (await app.plans.list()).length;
    const res = await app.controller.planOutline({
      objective: 'remember the integrated planning fact is stored; recall planning',
      constraints: ['within office hours'],
      deliverables: ['a readable note'],
      preferences: ['no model calls'],
      resources: ['the local store'],
      deadlines: ['2026-12-01'],
      priority: 'high',
    });
    const step = res.operation.steps[0];
    assert.equal(step.action, 'plan.outline');
    assert.equal(step.outcome, 'success_verified');
    const data = step.result.data;
    assert.equal(data.recorded, false);
    assert.equal(data.approved, false);
    assert.equal(data.executable, false);
    assert.equal(data.planning.schema, PLANNING_SCHEMA);
    assert.equal(data.planning.outlineDigest, data.digest);
    assert.equal(data.planning.intake.constraints.some((c) => c.text === 'within office hours' && c.basis === 'user_stated'), true);
    assert.equal(data.planning.intake.deliverables.some((d) => d.text === 'a readable note'), true);
    assert.equal(data.planning.intake.priorities.some((p) => p.text === 'priority: high'), true);
    assert.ok(data.planning.tasks.every((t) => t.class !== 'ready'), 'no approval binds this read');
    assert.match(res.display, /Objective planning/);
    assert.match(res.display, /nothing recorded, approved, or running/);
    assert.equal((await app.plans.list()).length, before, 'plan.outline stores no plan');
  });

  test('the verifier re-derives the planning bytes and refuses a changed read', async () => {
    const app = await appIn(tempDir());
    const def = app.registry.get('plan.outline');
    const input = def.validate({ objective: 'remember the verified planning fact is stored' });
    const out = await def.execute({ registry: app.registry }, input);
    const clean = await def.verify({ registry: app.registry }, input, out);
    assert.equal(clean.ok, true, clean.detail);
    assert.match(clean.detail, /planning read reproduces/);

    // The outline bytes do not depend on the stated flags, so this mismatch can only be caught by
    // re-deriving the planning read itself.
    const changedInput = { ...input, stated: { ...input.stated, constraints: ['a constraint that was not in the answer'] } };
    const changed = await def.verify({ registry: app.registry }, changedInput, out);
    assert.equal(changed.ok, false);
    assert.match(changed.detail, /independent planning read/);

    const shrunk = new ActionRegistry();
    for (const d of app.registry.list()) {
      if (d.name === 'memory.add') continue;
      shrunk.register(d);
    }
    const gone = await def.verify({ registry: shrunk }, input, out);
    assert.equal(gone.ok, false, 'a registry that no longer holds a listed action invalidates the read');
  });

  test('the CLI accepts the planning flags and prints the read without recording it', async () => {
    const dir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
    const res = await runCli([
      'plan', 'outline', 'remember the cli planning fact is stored; recall build',
      '--constraint', 'within office hours',
      '--deliverable', 'a readable note',
      '--preference', 'no model calls',
      '--resource', 'the local store',
      '--deadline', '2026-12-01',
      '--plan-priority', 'high',
      '--json',
    ], env);
    assert.equal(res.code, 0, res.stderr);
    const payload = JSON.parse(res.stdout.split('\nAudit: recorded in operations.jsonl')[0]);
    assert.equal(payload.planning.schema, PLANNING_SCHEMA);
    assert.equal(payload.recorded, false);
    assert.equal(payload.planning.intake.constraints.some((c) => c.text === 'within office hours'), true);
    assert.equal(payload.planning.intake.deliverables.some((d) => d.text === 'a readable note'), true);
    assert.equal(payload.planning.intake.preferences.some((p) => p.text === 'no model calls'), true);
    assert.equal(payload.planning.intake.resources.some((r) => r.text === 'the local store'), true);
    assert.equal(payload.planning.intake.deadlines.some((d) => d.text === '2026-12-01'), true);
    assert.equal(payload.planning.intake.priorities.some((p) => p.text === 'priority: high'), true);

    const listed = await runCli(['plan', 'list'], env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.doesNotMatch(listed.stdout, /cli planning fact/);
  });

  test('a malformed plan priority is refused and recorded, not silently defaulted', async () => {
    const dir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
    const res = await runCli([
      'plan', 'outline', 'remember the cli planning fact is stored', '--plan-priority', 'urgent',
    ], env);
    assert.equal(res.code, 1);
    assert.match(res.stdout, /input rejected: priority must be one of low, normal, high/);
    assert.match(res.stdout, /Audit: recorded in operations\.jsonl/);
    const listed = await runCli(['plan', 'list'], env);
    assert.doesNotMatch(listed.stdout, /cli planning fact/);
  });
});
