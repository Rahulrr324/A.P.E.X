// T-37 Step 2 (2026-11-21): the Values & Constraints Core and its Council position.
//
// V2-0317 asked for owner-defined values and hard rules evaluated before action, with the hard rules
// living in policy rather than in a prompt. The core is data: six rules, four values, and a verdict
// per rule. This suite checks the three things that make it policy rather than decoration - that it
// evaluates real declarations, that an unreadable input is reported as unverifiable rather than
// passing, and that it can never itself authorize anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CORE, CONSTRAINTS, CONSTRAINT_VERDICTS, VALUES, VALUES_CORE_SCHEMA,
  constraintPerspective, evaluateConstraints,
} from '../src/council/values-core.js';
import { createApp } from '../src/app.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t37-values-'));
}

// A well-formed candidate: a read, owner-only or model-readable, plannable, with a cited record.
const GOOD_READ = {
  definition: { name: 'example.read', permission: 'read', origins: ['user', 'model'], plannable: true, reversibility: 'reversible' },
  evidence: [{ evidenceId: 'memory:1', current: true }],
  latch: { active: false },
  claims: { authorizesExecution: false, mutatesObservedFacts: false },
  inPlan: true,
};

test('T-37 values: the core is data, and it declares that it authorizes nothing', () => {
  assert.equal(CORE.schema, VALUES_CORE_SCHEMA);
  assert.equal(CORE.authorizesExecution, false);
  assert.equal(CORE.mutatesObservedFacts, false);
  // The most important declaration in the module: reaching these verdicts contacts no model.
  assert.equal(CORE.requiresInference, false);
  assert.ok(CONSTRAINTS.length >= 6, `expected at least six hard rules, got ${CONSTRAINTS.length}`);
  assert.ok(VALUES.length >= 4, `expected at least four values, got ${VALUES.length}`);
  for (const constraint of CONSTRAINTS) {
    assert.ok(typeof constraint.id === 'string' && constraint.id.length > 0);
    // Every rule states the value it protects and the reason it exists, so the owner can disagree
    // with a rule rather than with an unstated opinion.
    assert.ok(typeof constraint.value === 'string' && constraint.value.length > 0, `${constraint.id} states no value`);
    assert.ok(typeof constraint.because === 'string' && constraint.because.length > 0, `${constraint.id} states no reason`);
    assert.ok(['blocking', 'caution'].includes(constraint.severity), `${constraint.id} has no severity`);
    assert.equal(typeof constraint.evaluate, 'function');
  }
});

test('T-37 values: a conforming candidate satisfies every applicable rule', () => {
  const evaluation = evaluateConstraints(GOOD_READ);
  assert.equal(evaluation.schema, 'apex.values.constraint-evaluation/1');
  assert.equal(evaluation.overall, 'satisfied');
  assert.equal(evaluation.counts.violated, 0);
  assert.equal(evaluation.counts.unverifiable, 0);
  assert.equal(evaluation.authorizesExecution, false);
  for (const entry of evaluation.evaluations) {
    assert.ok(CONSTRAINT_VERDICTS.includes(entry.verdict), `${entry.id} has an unknown verdict ${entry.verdict}`);
  }
});

test('T-37 values: a model-authored write violates a blocking rule and the verdict says which', () => {
  const evaluation = evaluateConstraints({
    ...GOOD_READ,
    definition: { name: 'danger.write', permission: 'write', origins: ['user', 'model'], plannable: false, reversibility: 'irreversible' },
  });
  assert.equal(evaluation.overall, 'violated');
  assert.ok(evaluation.blocking.includes('no-model-authored-write'), 'the model-write rule must be named as blocking');
  assert.ok(evaluation.blocking.includes('irreversible-needs-the-owner'), 'the reversibility rule must be named as blocking');
  const rule = evaluation.evaluations.find((entry) => entry.id === 'no-model-authored-write');
  assert.equal(rule.verdict, 'violated');
  assert.match(rule.detail, /danger\.write/);
  assert.match(rule.detail, /model origin/);
});

test('T-37 values: an engaged lockdown latch violates the fail-closed rule', () => {
  const evaluation = evaluateConstraints({ ...GOOD_READ, latch: { active: true } });
  assert.equal(evaluation.overall, 'violated');
  const rule = evaluation.evaluations.find((entry) => entry.id === 'lockdown-fails-closed');
  assert.equal(rule.verdict, 'violated');
  assert.match(rule.detail, /engaged/);
  // And an unreadable policy is unverifiable, never satisfied: an unknown latch is not a released one.
  const unknown = evaluateConstraints({ ...GOOD_READ, latch: { active: false, policyUnavailable: true } });
  assert.equal(unknown.evaluations.find((entry) => entry.id === 'lockdown-fails-closed').verdict, 'unverifiable');
});

test('T-37 values: an unplannable candidate is only a violation when it is proposed as a plan step', () => {
  const candidate = {
    ...GOOD_READ,
    definition: { name: 'neural.step', permission: 'write', origins: ['user'], plannable: false, reversibility: 'reversible' },
  };
  const notInPlan = evaluateConstraints({ ...candidate, inPlan: false });
  assert.equal(notInPlan.evaluations.find((entry) => entry.id === 'no-unplannable-in-a-plan').verdict, 'not_applicable');

  const inPlan = evaluateConstraints({ ...candidate, inPlan: true });
  assert.equal(inPlan.evaluations.find((entry) => entry.id === 'no-unplannable-in-a-plan').verdict, 'violated');
});

test('T-37 values: a candidate claiming its own authority is refused by name', () => {
  const evaluation = evaluateConstraints({ ...GOOD_READ, claims: { authorizesExecution: true } });
  assert.equal(evaluation.overall, 'violated');
  const rule = evaluation.evaluations.find((entry) => entry.id === 'no-candidate-as-permission');
  assert.equal(rule.verdict, 'violated');
  assert.match(rule.detail, /authority belongs to the ECP/);

  const writing = evaluateConstraints({ ...GOOD_READ, claims: { mutatesObservedFacts: true } });
  assert.equal(writing.evaluations.find((entry) => entry.id === 'no-candidate-as-permission').verdict, 'violated');
});

test('T-37 values: no input at all is reported as unverifiable, never as satisfied', () => {
  const evaluation = evaluateConstraints({});
  // A rule that could not be checked has not passed: that is the whole point of the verdict.
  assert.notEqual(evaluation.overall, 'satisfied');
  assert.equal(evaluation.counts.violated, 0);
  assert.ok(evaluation.counts.unverifiable > 0, 'an empty input must produce unverifiable rules');
  for (const id of evaluation.unverifiable) {
    const rule = evaluation.evaluations.find((entry) => entry.id === id);
    assert.ok(rule.detail.length > 0, `${id} is unverifiable with no explanation`);
  }
});

test('T-37 values: a rule that throws is unverifiable rather than satisfied or violated', () => {
  // A getter that throws stands in for any input the rules cannot read.
  const hostile = {
    get definition() { throw new Error('the declaration could not be read'); },
    evidence: [{ evidenceId: 'memory:1', current: true }],
    latch: { active: false },
    claims: {},
  };
  const evaluation = evaluateConstraints(hostile);
  const rule = evaluation.evaluations.find((entry) => entry.id === 'no-model-authored-write');
  assert.equal(rule.verdict, 'unverifiable');
  assert.match(rule.detail, /could not be evaluated/);
  assert.equal(evaluation.counts.violated, 0);
});

test('T-37 values: the Council perspective carries the rule-by-rule evaluation and no permission', () => {
  const perspective = constraintPerspective(GOOD_READ);
  assert.equal(perspective.perspectiveId, 'constraint_check');
  assert.equal(perspective.status, 'evaluated');
  assert.equal(typeof perspective.position.verdict, 'string');
  assert.ok(perspective.position.summary.length > 0);
  assert.ok(Array.isArray(perspective.position.evidence));
  // The evidence is the rules themselves, each citing the value it protects.
  assert.ok(perspective.position.evidence.every((entry) => entry.kind === 'constraint'));
  assert.ok(perspective.evaluation.evaluations.length > 0);
  assert.ok(Array.isArray(perspective.values) && perspective.values.length >= 4);
  // A perspective is deliberation data. It grants nothing.
  assert.equal(perspective.evaluation.authorizesExecution, false);
});

test('T-37 values: a live deliberation evaluates a real registered declaration', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    const result = await app.controller.runAction('council.deliberate', {
      objective: 'should APEX advance the substrate for this request',
      candidateId: 'neural.step',
    }, 'user', 'op-t37-values-council');
    assert.equal(result.outcome, 'success_verified', JSON.stringify(result.verification));

    const positions = result.result.data.positions;
    // The seven engineering perspectives are still there, and the core is the eighth.
    assert.equal(positions.length, 8, `expected eight positions, got ${positions.length}`);
    assert.deepEqual(positions.slice(0, 7).map((p) => p.perspectiveId), [
      'objective_alignment', 'evidence_quality', 'safety_policy', 'resource_feasibility',
      'operational_reliability', 'temporal_consequences', 'long_term_implications',
    ]);

    const core = positions.find((p) => p.perspectiveId === 'constraint_check');
    assert.ok(core, 'the constraint check must be present as a position');
    assert.ok(core.evaluation, 'the evaluation must travel with the position');
    // `neural.step` is a user-only write, so the model-write rule is satisfied - by reading its real
    // declaration, not by assuming the benign case.
    const modelWrite = core.evaluation.evaluations.find((entry) => entry.id === 'no-model-authored-write');
    assert.equal(modelWrite.verdict, 'satisfied');
    assert.match(modelWrite.detail, /restricted to user/);
    // Its reversibility is undeclared, so that rule must say it could not be read.
    const reversibility = core.evaluation.evaluations.find((entry) => entry.id === 'irreversible-needs-the-owner');
    assert.equal(reversibility.verdict, 'unverifiable');
    assert.match(reversibility.detail, /declares no reversibility/);

    // Deliberation still authorizes nothing.
    assert.equal(result.result.data.authorizesExecution, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-37 values: a deliberation under lockdown names the latch as a violation', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    const latched = await app.controller.runAction('safety.lockdown', { reason: 'T-37 constraint probe' }, 'user', 'op-t37-values-lock');
    assert.equal(latched.outcome, 'success_verified');

    const result = await app.controller.runAction('council.deliberate', {
      objective: 'what should APEX do next',
      candidateId: 'neural.read',
    }, 'user', 'op-t37-values-locked');
    const core = result.result.data.positions.find((p) => p.perspectiveId === 'constraint_check');
    const rule = core.evaluation.evaluations.find((entry) => entry.id === 'lockdown-fails-closed');
    assert.equal(rule.verdict, 'violated', 'an engaged latch must be a violation, not a caution');
    assert.equal(core.evaluation.overall, 'violated');
    // And the deliberation still did not release it.
    assert.equal(app.ecp.killSwitchStatus().active, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
