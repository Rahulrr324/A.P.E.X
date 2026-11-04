// Batch AJ: deterministic request understanding.
//
// These tests call the reasoning layer's first stage directly. They pin the intent vocabulary, the
// reference resolution it can justify from the reduced state, the missing-information codes, and the
// rule that classification never grants authorization. No model is contacted and no store is read:
// the state is a small in-memory projection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { understandRequest } from '../src/cognition/request.js';
import { Intent, INTENT_NOTE, MissingInfo } from '../src/cognition/vocabulary.js';

function entity(id, name, extra = {}) {
  return {
    id, name, category: 'project', status: 'active', aliases: [], ...extra,
  };
}

function worldOf(...entities) {
  return { entities: new Map(entities.map((item) => [item.id, item])) };
}

function understand(request, options = {}) {
  return understandRequest({
    request,
    now: new Date('2026-05-01T00:00:00.000Z'),
    ...options,
  });
}

test('a request with no recognizable subject is a general question and grants nothing', () => {
  const result = understand('hello there');
  assert.equal(result.intent, Intent.GENERAL_QUESTION);
  assert.deepEqual(result.entities, []);
  assert.equal(result.authorization.granted, false);
  assert.equal(result.authorization.note, INTENT_NOTE);
});

test('memory questions are classified as stored-information questions with a named topic', () => {
  const result = understand('what do you remember about the audit finding?');
  assert.equal(result.intent, Intent.STORED_INFORMATION);
  assert.equal(result.missing.some((item) => item.code === MissingInfo.TOPIC), false);
});

test('a question naming a stored entity is a World Model question, matched by name', () => {
  const state = worldOf(entity('e-locker', 'Parcel Locker'));
  const result = understand('is Parcel Locker operational?', { worldState: state });
  assert.equal(result.intent, Intent.WORLD_MODEL);
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0].id, 'e-locker');
  assert.equal(result.entities[0].matchedBy, 'name');
});

test('an alias resolves to the entity and an unknown name is not invented', () => {
  const state = worldOf(entity('e-locker', 'Parcel Locker', { aliases: ['Locker 7'] }));
  const alias = understand('is Locker 7 operational?', { worldState: state });
  assert.equal(alias.entities[0]?.id, 'e-locker');
  assert.equal(alias.entities[0]?.matchedBy, 'alias');

  const unknown = understand('is Zephyr Gate operational?', { worldState: state });
  assert.deepEqual(unknown.entities, []);
  assert.equal(unknown.intent, Intent.GENERAL_QUESTION);
});

test('a name shared by two active entities is reported as ambiguous, not resolved by order', () => {
  const state = worldOf(
    entity('e-a', 'Atlas', { aliases: ['Project Atlas'] }),
    entity('e-b', 'Atlas Two', { aliases: ['Project Atlas'] }),
  );
  const result = understand('what is the status of Project Atlas?', { worldState: state });
  const ambiguity = result.ambiguities.find((item) => item.code === MissingInfo.AMBIGUOUS_REFERENCE);
  assert.ok(ambiguity, 'the shared surface must be reported');
  assert.equal(ambiguity.candidates.length, 2);
  assert.ok(result.entities.every((item) => item.ambiguous === true));
  assert.match(result.clarification, /Which entity do you mean\?/);
});

test('historical wording asks for a time range instead of assuming one', () => {
  const state = worldOf(entity('e-atlas', 'Project Atlas'));
  const result = understand('who owned Project Atlas last month?', { worldState: state });
  assert.equal(result.intent, Intent.HISTORICAL);
  assert.equal(result.timeRange, null);
  assert.equal(result.missing.some((item) => item.code === MissingInfo.TIME_RANGE), true);
  assert.equal(result.historical, true);
});

test('an as-of date is parsed and keeps its instant', () => {
  const state = worldOf(entity('e-atlas', 'Project Atlas'));
  const result = understand('who owned Project Atlas as of 2024-05-01?', { worldState: state });
  assert.equal(result.intent, Intent.HISTORICAL);
  assert.equal(result.timeRange.kind, 'as-of');
  assert.equal(result.timeRange.parsed, true);
  assert.equal(result.timeRange.at, '2024-05-01T00:00:00.000Z');
  assert.equal(result.missing.some((item) => item.code === MissingInfo.TIME_RANGE), false);
});

test('a comparison names both referents and keeps them separate', () => {
  const state = worldOf(entity('e-atlas', 'Project Atlas'), entity('e-locker', 'Parcel Locker'));
  const result = understand('compare Project Atlas and Parcel Locker', { worldState: state });
  assert.equal(result.intent, Intent.COMPARISON);
  assert.deepEqual(result.entities.map((item) => item.id), ['e-atlas', 'e-locker']);
  assert.deepEqual(result.required, ['two_referents']);
});

test('an explanation keeps its intent even when it names an entity', () => {
  const state = worldOf(entity('e-locker', 'Parcel Locker'));
  const result = understand('why is Parcel Locker offline?', { worldState: state });
  assert.equal(result.intent, Intent.EXPLANATION);
  assert.equal(result.entities[0]?.id, 'e-locker');
});

test('goal creation without a success criterion is stated as missing information', () => {
  const vague = understand('create a goal to get fit');
  assert.equal(vague.intent, Intent.GOAL_CREATION);
  assert.equal(vague.missing.some((item) => item.code === MissingInfo.GOAL_CRITERIA), true);

  const concrete = understand('create a goal to finish the report by Friday');
  assert.equal(concrete.intent, Intent.GOAL_CREATION);
  assert.equal(concrete.missing.some((item) => item.code === MissingInfo.GOAL_CRITERIA), false);
});

test('goal progress binds the only open goal but asks which one when several are open', () => {
  const one = understand('what is the progress on my goal?', {
    goals: [{ id: 'g-1', status: 'active', request: 'ship the report', criteria: [] }],
  });
  assert.equal(one.intent, Intent.GOAL_PROGRESS);
  assert.equal(one.goals[0]?.id, 'g-1');
  assert.equal(one.goals[0]?.matchedBy, 'only-open');

  const many = understand('what is the progress on my goal?', {
    goals: [
      { id: 'g-1', status: 'active', request: 'ship the report', criteria: [] },
      { id: 'g-2', status: 'active', request: 'revise the plan', criteria: [] },
    ],
  });
  assert.equal(many.goals.length, 0);
  assert.ok(many.ambiguities.some((item) => item.kind === 'goal'));
  assert.match(many.clarification, /Which goal do you mean\?/);
});

test('planning and plan review are distinct intents', () => {
  const planning = understand('make a plan to migrate the database');
  assert.equal(planning.intent, Intent.PLANNING);
  assert.deepEqual(planning.required, ['outcome', 'success_criteria']);

  const review = understand('review the plan for the migration', {
    plans: [{ id: 'p-1', status: 'draft', outcome: 'a safe migration' }],
  });
  assert.equal(review.intent, Intent.PLAN_REVIEW);
  assert.equal(review.plans[0]?.id, 'p-1');
  assert.equal(review.plans[0]?.matchedBy, 'only-open');
});

test('a next-step request is advice, and only explicit execution wording requests execution', () => {
  const advice = understand("what's next?");
  assert.equal(advice.intent, Intent.NEXT_STEP);
  assert.equal(advice.executionRequested, false);
  assert.equal(advice.authorization.granted, false);

  const execute = understand("what's next? run it");
  assert.equal(execute.intent, Intent.NEXT_STEP);
  assert.equal(execute.executionRequested, true);
  assert.equal(execute.authorization.granted, false, 'even an execution request is not authorization');
});

test('task execution is classified without being authorized', () => {
  const result = understand('run the next task');
  assert.equal(result.intent, Intent.TASK_EXECUTION);
  assert.equal(result.executionRequested, true);
  assert.equal(result.authorization.granted, false);
  assert.deepEqual(result.required, ['task_reference', 'authorization']);
});

test('unsupported and under-specified requests are classified and explained', () => {
  const unsupported = understand('run a shell command to list files');
  assert.equal(unsupported.intent, Intent.UNSUPPORTED);
  assert.match(unsupported.unsupported, /no capability/);

  const clarification = understand('recall');
  assert.equal(clarification.intent, Intent.CLARIFICATION);
  assert.match(clarification.clarification, /What topic/);
});

test('multiple intents are all reported, with the first rule still naming the request', () => {
  const result = understand("what should I do next, and explain why");
  assert.equal(result.intent, Intent.NEXT_STEP);
  assert.ok(result.intents.includes(Intent.EXPLANATION));
  assert.ok(result.intents.includes(Intent.NEXT_STEP));
});

test('explicit instructions are extracted as bounded constraints, not as permission', () => {
  const result = understand('Explain the status but do not cite the raw record');
  assert.ok(result.instructions.length >= 1);
  assert.equal(result.instructions[0].kind, 'constraint');
  assert.ok(result.instructions.every((item) => item.text.length <= 200));
  assert.equal(result.authorization.granted, false);
});

test('the described open work is counted, not acted on', () => {
  const result = understand('what is the progress on my goal?', {
    goals: [
      { id: 'g-1', status: 'active', request: 'ship the report', criteria: [] },
      { id: 'g-2', status: 'completed', request: 'write the report', criteria: [] },
    ],
    plans: [{ id: 'p-1', status: 'draft', outcome: 'a report', steps: [] }],
    tasks: [{ id: 't-1', status: 'completed', request: 'draft' }],
  });
  assert.equal(result.open.goals, 1);
  assert.equal(result.open.plans, 1);
  assert.equal(result.open.tasks, 0);
  assert.equal(result.open.goalProgress[0].id, 'g-1');
});
