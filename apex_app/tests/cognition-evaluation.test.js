// Batch AO, work package E: deterministic cognitive quality evaluation.
//
// The harness is fixed and synthetic: frozen scenarios over the real deterministic pipeline, the real
// structured-response validator and the real proposal parser. A pass means this implementation
// matched the written rubric; it says nothing about semantic understanding or a real model's answer
// quality, and the report contains no composite score. These tests pin the harness's own contract:
// the fixed set passes, every dimension is exercised, the report is deterministic and carries no
// record or model text, and a deliberately failing control is attributed to exactly one defect class.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COGNITIVE_EVAL_SCENARIOS, EVAL_DIMENSIONS, EVAL_NOTE, EVAL_SCHEMA, EvalDimension, FindingKind,
  evaluateCognitiveQuality,
} from '../src/cognition/evaluation.js';

const FINDING_KEYS = ['falseSupport', 'missedContradiction', 'unsupportedClaim', 'inappropriateProposal'];

// Fixture strings that must never appear in a report: record text, proposal content, and protocol
// tokens. A report carries labels, counts, and rubric prose only.
const FORBIDDEN_REPORT_TOKENS = [
  'lighthouse', 'PROPOSE_ACTION', 'COGNITION', 'memory.add', 'record the review',
  'Atlas is', 'ev:memory', 'ev:knowledge', 'has_status',
];

function controlScenario(id, dimension, finding) {
  return {
    id,
    description: 'negative control: one deliberately failing rubric check',
    checks: [{
      id: 'deliberate-failure',
      dimension,
      expected: 'this control is meant to fail',
      test: () => ({ ok: false, actual: 'control failure' }),
      finding,
    }],
  };
}

test('fixed scenario set satisfies the rubric with no composite score', async () => {
  const report = await evaluateCognitiveQuality();

  assert.equal(report.schema, EVAL_SCHEMA);
  assert.equal(report.deterministic, true);
  assert.equal(report.note, EVAL_NOTE);
  assert.equal(report.ok, true);
  assert.equal(report.totals.scenarios, 13);
  assert.ok(report.totals.checks >= 50, `expected a substantive rubric, got ${report.totals.checks} checks`);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.passed, report.totals.checks);
  assert.equal(report.scenarios.length, 13);
  assert.equal(new Set(report.scenarios.map((entry) => entry.id)).size, 13, 'scenario ids are unique');

  for (const key of FINDING_KEYS) assert.deepEqual(report.findings[key], [], `${key} is reported separately and empty`);

  // Counts, not a ranking: no score field anywhere at the top level.
  assert.equal(Object.prototype.hasOwnProperty.call(report, 'score'), false);
  assert.equal(report.ok, report.totals.failed === 0);

  // Every declared dimension is exercised, and each scenario ran at least one check.
  for (const dimension of EVAL_DIMENSIONS) {
    const bucket = report.dimensions[dimension];
    assert.ok(bucket, `${dimension} is reported`);
    assert.ok(bucket.checks > 0, `${dimension} has checks`);
    assert.equal(bucket.failed, 0, `${dimension} has no failures`);
    assert.deepEqual(bucket.failures, []);
  }
  for (const scenario of report.scenarios) {
    assert.ok(scenario.checks.length > 0, `${scenario.id} ran checks`);
    for (const entry of scenario.checks) assert.equal(entry.ok, true, `${entry.id} held`);
  }
});

test('the report is deterministic across runs and carries no record or model text', async () => {
  const first = await evaluateCognitiveQuality();
  const second = await evaluateCognitiveQuality();
  assert.deepEqual(second, first, 'two runs over the same fixed fixtures produce the same report');

  const json = JSON.stringify(first);
  for (const token of FORBIDDEN_REPORT_TOKENS) {
    assert.equal(json.includes(token), false, `report must not carry ${token}`);
  }
});

test('each defect class is reported separately by a failing control', async () => {
  const controls = [
    [FindingKind.FALSE_SUPPORT, EvalDimension.CLAIM_GROUNDING, 'falseSupport'],
    [FindingKind.MISSED_CONTRADICTION, EvalDimension.CONTRADICTION_DETECTION, 'missedContradiction'],
    [FindingKind.UNSUPPORTED_CLAIM, EvalDimension.ABSTENTION, 'unsupportedClaim'],
    [FindingKind.INAPPROPRIATE_PROPOSAL, EvalDimension.PROPOSAL_VALIDITY, 'inappropriateProposal'],
  ];

  for (const [finding, dimension, key] of controls) {
    const id = `control-${key}`;
    const report = await evaluateCognitiveQuality({ scenarios: [controlScenario(id, dimension, finding)] });

    assert.equal(report.ok, false, `${key}: a failing control makes the run fail`);
    assert.deepEqual(report.totals, { scenarios: 1, checks: 1, passed: 0, failed: 1 });
    assert.equal(report.dimensions[dimension].failed, 1);

    assert.equal(report.findings[key].length, 1, `${key} holds the failure`);
    for (const other of FINDING_KEYS) {
      if (other === key) continue;
      assert.deepEqual(report.findings[other], [], `${key} does not leak into ${other}`);
    }

    const entry = report.findings[key][0];
    assert.equal(entry.scenario, id);
    assert.equal(entry.check, `${id}:deliberate-failure`);
    assert.equal(entry.expected, 'this control is meant to fail');
    assert.equal(entry.actual, 'control failure');
  }

  // Running controls does not mutate the fixed set.
  assert.equal(COGNITIVE_EVAL_SCENARIOS.length, 13);
  assert.equal(COGNITIVE_EVAL_SCENARIOS.every((scenario) => scenario.id.startsWith('control-') === false), true);
});
