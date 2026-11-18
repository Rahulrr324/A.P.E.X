// T-17 reusable prompt maker and rejecting prompt analyser tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSubsystemSpec, SPEC_SCHEMA } from '../src/governance/prompt-maker.js';
import { analysePromptSpec, rejectPromptSpec, ANALYSIS_SCHEMA } from '../src/governance/prompt-analyser.js';

function valid(overrides = {}) {
  return makeSubsystemSpec({
    subsystem: 'ecp',
    purpose: 'Enforce the sole authorization authority for consequential operations.',
    owner: 'Executive Control Plane',
    evidenceTier: 'V',
    implementationMaturity: 'Integrated',
    inputs: ['owner request', 'registered capability'],
    outputs: ['allow', 'deny', 'approval-required'],
    interfaces: ['evaluate(name, origin, context)'],
    dependencies: ['action registry', 'operation audit'],
    invariants: [2, 13, 14, 15, 16, 17],
    acceptanceTests: ['unauthorized execution denied', 'malformed policy fails closed'],
    explicitNonGoals: ['model inference', 'second controller'],
    failureAndRollback: 'Fail closed, preserve audit records and cancel cooperative work.',
    permissions: { capability: 'safety.lockdown', resourceScope: 'owner-local:*', autonomyLevel: 2 },
    performance: { timing: 'sync decision bounded by 100 capability entries', resourceBudget: 'finite' },
    repositoryGit: { root: 'E:\\A.P.E.X', branch: 'main', inference: 'inactive' },
    ...overrides,
  });
}

test('prompt maker creates a bounded subsystem specification', () => {
  const spec = valid();
  assert.equal(spec.schema, SPEC_SCHEMA);
  assert.equal(spec.subsystem, 'ecp');
  assert.equal(spec.evidenceTier, 'V');
  assert.deepEqual(spec.invariants, [2, 13, 14, 15, 16, 17]);
});

test('valid prompt specification passes deterministic analysis', () => {
  const report = analysePromptSpec(valid());
  assert.equal(report.schema, ANALYSIS_SCHEMA);
  assert.equal(report.accepted, true);
  assert.deepEqual(report.violations, []);
  assert.equal(report.inferenceActivated, false);
});

test('analyser rejects proposal-as-authority and duplicate-owner specifications', () => {
  const spec = valid({ architecturalOwners: ['ECP', 'ECP'] });
  const report = analysePromptSpec(spec);
  assert.equal(report.accepted, false);
  assert.ok(report.violations.some((row) => row.code === 'DUPLICATE_OWNER'));
});

test('analyser rejects missing acceptance, missing invariants and unverifiable claims', () => {
  const spec = makeSubsystemSpec({
    subsystem: 'ecp', purpose: 'Perfectly provides all capabilities instantly.', owner: 'ECP',
    evidenceTier: 'V', interfaces: ['evaluate'], acceptanceTests: ['valid test'], invariants: [2],
    permissions: { autonomyLevel: 2, resourceScope: 'owner:*' },
  });
  spec.acceptanceTests = [];
  spec.invariants = [];
  const report = analysePromptSpec(spec);
  assert.equal(report.accepted, false);
  assert.ok(report.violations.some((row) => row.code === 'ACCEPTANCE_TEST'));
  assert.ok(report.violations.some((row) => row.code === 'INVARIANTS'));
  assert.ok(report.violations.some((row) => row.code === 'UNVERIFIABLE_CLAIM'));
});

test('analyser rejects inference activation, reimplementation without reuse and L5 without standing-order form', () => {
  const spec = valid({ purpose: 'Start Ollama and run remote inference.', reimplementation: 'replace the existing task controller and memory store', permissions: { autonomyLevel: 5, resourceScope: 'owner:*', standingOrder: false }, invariants: [2] });
  const report = analysePromptSpec(spec);
  assert.equal(report.accepted, false);
  assert.ok(report.violations.some((row) => row.code === 'INFERENCE_ACTIVATION'));
  assert.ok(report.violations.some((row) => row.code === 'REIMPLEMENTATION'));
  assert.ok(report.violations.some((row) => row.code === 'L5_RESTRICTION'));
});

test('rejectPromptSpec throws a stable code and rejected analysis', () => {
  assert.throws(() => rejectPromptSpec(makeSubsystemSpec({
    subsystem: 'ecp', purpose: 'enforce policy', owner: 'ECP', evidenceTier: 'C',
    interfaces: ['evaluate'], acceptanceTests: ['check'], invariants: [2],
    permissions: { autonomyLevel: 2, resourceScope: 'owner:*' },
  })), (error) => {
    assert.equal(error.code, 'PROMPT_SPEC_REJECTED');
    assert.equal(error.analysis.accepted, false);
    return true;
  });
});
