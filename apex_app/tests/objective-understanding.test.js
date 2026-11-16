// Structured objective understanding.
//
// These tests call the decomposition directly and through the existing understanding stage. Every
// fixture is deterministic and synthetic: no model is contacted and no store is read. They pin the
// rules that matter for honesty - a part is split only at an explicit boundary, a constraint is
// recorded only when the user stated one, a lexical similarity is never presented as a mapping, and
// a decomposition without a capability catalogue says mapping was not evaluated.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decomposeObjective, objectiveAudit, renderObjective, CapabilityStatus, ConstraintKind,
  OBJECTIVE_NOTE, OBJECTIVE_SCHEMA, PartKind, UnknownCode,
} from '../src/cognition/objective.js';
import { understandRequest } from '../src/cognition/request.js';
import { analyzeRequest } from '../src/cognition/engine.js';

const NOW = new Date('2026-05-01T00:00:00.000Z');

const CAPS = [
  { name: 'memory.add', description: 'remember a fact for later recall', inputHint: 'content and sensitivity', permission: 'write' },
  { name: 'memory.search', description: 'search stored memories by query', inputHint: 'query', permission: 'read' },
  { name: 'note.search', description: 'search notes for a topic', inputHint: 'query', permission: 'read' },
  { name: 'note.add', description: 'save a note with a title and body', inputHint: 'title and body', permission: 'write' },
  { name: 'deadline.list', description: 'list recorded deadlines within a horizon', inputHint: 'horizonDays', permission: 'read' },
  { name: 'plan.candidates', description: 'propose candidate plans for a recorded goal', inputHint: 'goalId', permission: 'read' },
];

function decompose(text, options = {}) {
  return decomposeObjective(text, { capabilities: CAPS, ...options });
}

test('the decomposition names its schema and grants no authorization', () => {
  const objective = decompose('what do you remember about the launch?');
  assert.equal(objective.schema, OBJECTIVE_SCHEMA);
  assert.equal(objective.authorization.granted, false);
  assert.equal(objective.authorization.note, OBJECTIVE_NOTE);
  assert.equal(objective.parts.length, 1);
  assert.equal(objective.parts[0].kind, PartKind.QUESTION);
});

test('a sequenced request is decomposed with the dependency the user stated', () => {
  const objective = decompose('First search my notes about the launch. Then list my deadlines.');
  assert.equal(objective.parts.length, 2);
  assert.deepEqual(objective.parts.map((part) => part.kind), [PartKind.REQUEST, PartKind.REQUEST]);
  assert.deepEqual(objective.parts[1].dependency, { prerequisite: 0, kind: 'sequence' });
  assert.deepEqual(objective.dependencies, [{ prerequisite: 0, dependent: 1, kind: 'sequence' }]);
  assert.deepEqual(objective.parts.map((part) => part.capability.action), ['note.search', 'deadline.list']);
  assert.equal(objective.capabilities.routed, 2);
});

test('coordination splits only when both sides are requests of their own', () => {
  const joined = decompose('search my notes about the release and list my deadlines');
  assert.equal(joined.parts.length, 2);
  assert.deepEqual(joined.parts.map((part) => part.splitBy), ['coordination', 'coordination']);
  assert.deepEqual(joined.parts.map((part) => part.capability.action), ['note.search', 'deadline.list']);
  // The two parts were written as a conjunction, not as a sequence; no dependency is invented.
  assert.deepEqual(joined.dependencies, []);

  const oneRequest = decompose('remember the date and the release');
  assert.equal(oneRequest.parts.length, 1);
  assert.equal(oneRequest.parts[0].capability.action, 'memory.add');
});

test('a numbered list is read as a list, not as sentences ending in a period', () => {
  const objective = decompose('1. search my notes about launch\n2. list deadlines');
  assert.equal(objective.parts.length, 2);
  assert.deepEqual(objective.parts.map((part) => part.splitBy), ['list', 'list']);
  assert.deepEqual(objective.parts.map((part) => part.text), ['search my notes about launch', 'list deadlines']);
});

test('a condition is recorded only when the user stated one, and it governs only the parts it accompanies', () => {
  const objective = decompose('search my notes about the release and keep it private; do not send anything to a model.');
  const kinds = objective.constraints.map((item) => item.kind);
  assert.equal(kinds.includes(ConstraintKind.PRIVACY), true);
  assert.equal(kinds.includes(ConstraintKind.PROHIBITION), true);
  const standalone = objective.constraints.find((item) => item.kind === ConstraintKind.PROHIBITION);
  assert.deepEqual(standalone.appliesTo, [0]);

  const plain = decompose('search my notes about the launch');
  assert.deepEqual(plain.constraints, []);
});

test('an authorization condition is kept as a condition, not as a request to run something', () => {
  const objective = decompose('make a plan for the launch and ask me before running it');
  const condition = objective.parts.find((part) => part.kind === PartKind.CONSTRAINT);
  assert.ok(condition);
  assert.equal(objective.constraints.some((item) => item.kind === ConstraintKind.AUTHORIZATION), true);
});

test('a pronoun with no earlier turn is an unresolved reference, and context resolves it', () => {
  const withoutContext = decompose('do it');
  assert.equal(withoutContext.parts[0].kind, PartKind.REQUEST);
  assert.equal(withoutContext.unknowns.some((item) => item.code === UnknownCode.UNRESOLVED_REFERENCE), true);

  const withContext = decompose('do it', { hasContext: true });
  assert.equal(withContext.unknowns.some((item) => item.code === UnknownCode.UNRESOLVED_REFERENCE), false);
});

test('a request with a missing target and a vague amount are stated, not filled in', () => {
  const missingTarget = decompose('summarize');
  assert.equal(missingTarget.unknowns.some((item) => item.code === UnknownCode.MISSING_TARGET), true);

  const vague = decompose('find some recipes');
  assert.equal(vague.unknowns.some((item) => item.code === UnknownCode.VAGUE_QUANTITY), true);

  const vagueTime = decompose('plan the launch soon');
  assert.equal(vagueTime.unknowns.some((item) => item.code === UnknownCode.VAGUE_TIME), true);
});

test('a routed part is named by the real router and checked against the catalogue', () => {
  const routed = decompose('remember that the build passed');
  assert.equal(routed.parts[0].capability.status, CapabilityStatus.ROUTED);
  assert.equal(routed.parts[0].capability.action, 'memory.add');
  assert.equal(routed.parts[0].capability.registered, true);
  assert.deepEqual(routed.missingCapabilities, []);

  const withoutMemory = decompose('remember that the build passed', {
    capabilities: CAPS.filter((definition) => definition.name !== 'memory.add'),
  });
  assert.equal(withoutMemory.parts[0].capability.status, CapabilityStatus.UNAVAILABLE);
  assert.equal(withoutMemory.missingCapabilities.length, 1);
  assert.equal(withoutMemory.unknowns.some((item) => item.code === UnknownCode.UNREGISTERED_CAPABILITY), true);
});

test('a lexical suggestion is a candidate, never a mapping', () => {
  const objective = decompose('search for deadline records');
  const part = objective.parts[0];
  assert.equal(part.capability.status, CapabilityStatus.CANDIDATE);
  assert.equal(part.capability.action, null);
  assert.equal(part.capability.candidates.some((candidate) => candidate.name === 'deadline.list'), true);
  assert.equal(part.capability.candidates.every((candidate) => candidate.score > 0), true);
  assert.match(part.capability.reason, /suggestion, not a mapping/);
  // A candidate is not a missing capability: it is a suggestion for the user to check.
  assert.deepEqual(objective.missingCapabilities, []);
});

test('an unmatched part is listed as a missing capability only when a catalogue was evaluated', () => {
  const evaluated = decompose('create a new holiday');
  assert.equal(evaluated.parts[0].capability.status, CapabilityStatus.UNMATCHED);
  assert.equal(evaluated.missingCapabilities.length, 1);
  assert.equal(evaluated.unknowns.some((item) => item.code === UnknownCode.NO_MATCHING_CAPABILITY), true);

  const notEvaluated = decompose('create a new holiday', { capabilities: null });
  assert.equal(notEvaluated.parts[0].capability.status, CapabilityStatus.NOT_EVALUATED);
  assert.equal(notEvaluated.capabilities.evaluated, false);
  assert.deepEqual(notEvaluated.missingCapabilities, []);
});

test('a question that matches no action is answered by the model path, not reported as missing', () => {
  const objective = decompose('why did the deployment fail?');
  assert.equal(objective.parts[0].kind, PartKind.QUESTION);
  assert.equal(objective.parts[0].capability.status, CapabilityStatus.MODEL);
  assert.equal(objective.parts[0].capability.capability, 'model.answer');
  assert.deepEqual(objective.missingCapabilities, []);
});

test('the decomposition is bounded and says that it was', () => {
  const long = Array.from({ length: 12 }, (_, index) => `Search my notes about topic ${index}.`).join(' ');
  const objective = decompose(long);
  assert.equal(objective.parts.length, 8);
  assert.equal(objective.bounded.truncated, true);
  assert.equal(objective.bounded.droppedParts, 4);
});

test('the audit record carries counts and fixed labels, never the request wording', () => {
  const objective = decompose('search my notes about Zephyr Gate and list my deadlines');
  const audit = objectiveAudit(objective);
  assert.equal(audit.authorizes, false);
  assert.equal(audit.parts, 2);
  assert.equal(audit.capabilities.routed, 2);
  assert.equal(JSON.stringify(audit).includes('Zephyr'), false);
  assert.equal(JSON.stringify(audit).includes('deadline'), false);
});

test('the same request decomposes the same way twice', () => {
  const text = 'First search my notes about the launch. Then list my deadlines. Keep it private.';
  assert.deepEqual(decompose(text), decompose(text));
});

test('the rendered view says a candidate was not mapped', () => {
  const rendered = renderObjective(decompose('search for deadline records'));
  assert.match(rendered, /deadline\.list \(0\.33\)/);
  assert.match(rendered, /not mapped/);
});

test('request understanding carries the decomposition and still grants nothing', () => {
  const understanding = understandRequest({
    request: 'First search my notes about the launch. Then list my deadlines.',
    now: NOW,
    capabilities: CAPS,
  });
  assert.equal(understanding.objective.schema, OBJECTIVE_SCHEMA);
  assert.equal(understanding.objective.parts.length, 2);
  assert.equal(understanding.authorization.granted, false);
});

test('the engine records an objective stage without copying part text into the audit', async () => {
  const analysis = await analyzeRequest({
    request: 'First search my notes about Zephyr Gate. Then list my deadlines.',
    requestId: 'op-objective',
    now: NOW,
    capabilities: CAPS,
  });
  assert.equal(analysis.available, true);
  const stage = analysis.audit.stages.find((entry) => entry.name === 'objective');
  assert.ok(stage);
  assert.equal(stage.counts.parts, 2);
  assert.equal(stage.counts.routed, 2);
  assert.equal(stage.counts.dependencies, 1);
  assert.equal(analysis.audit.authorizes, false);
  assert.equal(JSON.stringify(analysis.audit).includes('Zephyr'), false);
});
