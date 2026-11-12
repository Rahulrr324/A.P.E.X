// Bounded, model-free benchmark for the decision path Batch AP-02 extended (AP-01 vs prediction).
//
// The measured path is the one `plan.candidates` and `plan.replan` run: a read of the approved
// adaptation ledger, then a comparison of the candidate bytes. Both conditions here are that path,
// with the same candidates and the same total number of approved records; only the provenance of the
// records differs:
//
//   AP-01 path         every record was derived from user feedback and shaped by a guidance record.
//   prediction path    the same set, with P of the records derived from one evaluated prediction each
//                      (a typed proposal restating the recorded outcome, the same four fields).
//
// The difference is what AP-02 added: a prediction-derived record carries a separated support list and
// a prediction-evidence read, and the decision disclosure names source, prediction, evaluation and the
// considered set for it. Nothing here caches, indexes, or skips a validation; the benchmark exists to
// show what the existing code costs, not to change it.
//
// No inference is run or simulated and no backend or application is constructed: the comparison is a
// pure function over synthetic candidates and synthetic ledger rows. The second section measures the
// pure eligibility rule (`predictionEligibility` / `proposalFor`) over projections of evaluated
// predictions, which is the rule the store applies per record and per candidate; it reads no ledger.
//
//   node benchmarks/run-prediction-adaptation-benchmark.mjs [--sizes S,M,L] [--repeats R]
import os from 'node:os';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { evaluateCandidates, renderAdaptationDecision } from '../src/plans/evaluation.js';
import { guidanceFrom } from '../src/plans/guidance.js';
import { planRisk, validatePlanContent } from '../src/plans/model.js';
import {
  PREDICTION_DERIVATION_METHOD, predictionEligibility, proposalFor,
} from '../src/experience/prediction-derivation.js';
import { Outcome } from '../src/outcomes.js';

const MAX_REPEATS = 25;
const MAX_ELIGIBILITY_RECORDS = 400;

// The two axes the decision disclosure reads: how many candidate bytes the Pareto pass compares, and
// how many approved records it must state with which provenance. `predictions` is the number of those
// records that are prediction-derived; the feedback count is the remainder, so the two conditions
// always name the same total number of records.
const SIZES = {
  S: { candidates: 4, records: 1, predictions: 1, support: 2 },
  M: { candidates: 10, records: 6, predictions: 2, support: 10 },
  L: { candidates: 20, records: 12, predictions: 4, support: 20 },
};

const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - String(s).length))}`;
const ms = (n) => `${(Math.round(n * 1000) / 1000).toFixed(3)}`;
const us = (n) => `${(Math.round(n * 1000) / 1) / 1000}`;

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const line = (label, samples) => `  ${pad(label, 44)} ${pad(ms(median(samples)), 10)} min ${pad(ms(Math.min(...samples)), 10)}`
  + ` samples ${samples.map((x) => (Math.round(x * 1000) / 1000).toFixed(2)).join('/')}ms`;

// The registry shape the comparison reads: a permission class per action, nothing else.
const NAMES = ['memory.add', 'memory.list', 'memory.search', 'calc.evaluate'];
const registry = {
  names: () => [...NAMES],
  get: (name) => (NAMES.includes(name)
    ? { name, permission: name === 'memory.add' ? 'write' : 'read', plannable: true }
    : null),
  authorize: () => ({ decision: 'allow' }),
};

function candidateOf(index, structure, seconds) {
  const write = { action: 'memory.add', risk: 'medium' };
  const read = { action: 'memory.list', risk: 'low' };
  const ordered = structure === 'writes_first' ? [write, read, write, read] : [read, write, read, write];
  const steps = ordered.slice(0, 2 + (index % 3)).map((s, i) => ({
    id: `s${i + 1}`,
    description: `${s.action} is the ${i + 1} step of this approach`,
    action: s.action,
    input: {},
    dependsOn: i === 0 ? [] : [`s${i}`],
    expectedResult: `the ${s.action} result is recorded`,
    verification: 'the action re-checks its own result',
    risk: s.risk,
    estimate: { seconds: null },
    reversibility: s.action === 'memory.add' ? 'reversible' : 'read_only',
    recovery: 'the task stops here and later steps do not run',
  }));
  const content = {
    goalId: 'goal-bench',
    outcome: 'the recorded criteria are settled',
    steps,
    preconditions: [],
    assertions: [],
    resources: { estimatedSeconds: seconds },
  };
  const problems = validatePlanContent(content);
  const strategy = `${structure}_${String(index).padStart(2, '0')}`;
  const writes = steps.filter((s) => registry.get(s.action)?.permission === 'write').length;
  return {
    strategy,
    note: `${strategy} as an approach`,
    outcome: content.outcome,
    content,
    digest: createHash('sha256').update(strategy).digest('hex'),
    steps: content.steps.length,
    writes,
    reads: content.steps.length - writes,
    risk: planRisk(content.steps),
    reversibility: content.steps.map((s) => ({ id: s.id, action: s.action, reversibility: s.reversibility })),
    failurePaths: content.steps.map((s) => ({ id: s.id, action: s.action, recovery: s.recovery })),
    validation: problems.length === 0 ? { ok: true, problems: [] } : { ok: false, problems },
    capabilities: content.steps.map((s) => ({ action: s.action, permission: registry.get(s.action)?.permission, hasVerifier: false })),
    criteriaCovered: [],
    criteriaLeftUnaddressed: [],
    criteriaAssumedFromTheGoalRequest: [],
    criteriaSharedWithAnEarlierStep: [],
    criteriaBeyondThePlanBound: [],
    criteriaFromInference: [],
    criteriaLeftOutOfThisApproach: [],
    stepsBeyondThePlanBound: [],
    estimatedSeconds: seconds,
    executable: false,
    approved: false,
    readyForApproval: problems.length === 0,
  };
}

// A feedback-derived record in the shape the learning read produces. The first states the step order
// and can move the ordering; the others state a preference the steps either match or do not.
function feedbackRow(index, support) {
  return {
    id: `adapt-bench-${String(index).padStart(2, '0')}`,
    capability: index === 0 ? 'memory' : 'memory.list',
    rule: index === 0
      ? 'read the list before writing to it, in this order'
      : 'when a step of this work is available, it should be used',
    supportCount: support + 1,
    guidanceCount: index + 1,
    shapeVersion: index + 1,
    ruleHash: createHash('sha256').update(`rule-${index}`).digest('hex'),
    method: 'repeated_user_correction',
    source: 'feedback',
    support: {
      experienceIds: Array.from({ length: support }, (_, j) => `exp-bench-${index}-${j}`),
      feedbackIds: Array.from({ length: support }, (_, j) => `fb-bench-${index}-${j}`),
      predictionIds: [],
      evaluationIds: [],
    },
    predictionEvidence: null,
    decidedAt: '2026-11-01T00:00:00.000Z',
    decisionState: 'approved',
    active: true,
    conflicts: 0,
    conflictsWith: [],
    guidance: index === 0
      ? { id: `guide-${index}`, order: 'reads_first', avoid: [], prefer: [], maxSteps: null, createdAt: '2026-11-02T00:00:00.000Z', operationId: `op-guide-${index}` }
      : { id: `guide-${index}`, order: null, avoid: [], prefer: ['memory.list'], maxSteps: null, createdAt: '2026-11-02T00:00:00.000Z', operationId: `op-guide-${index}` },
  };
}

// One prediction-derived record: one recorded evaluation of one expectation, restated as the same
// four guidance fields. Several records may prefer the same capability; that is not a contradiction
// (a contradiction is an opposite statement), so the ordering is still applied.
function predictionRow(index, capability = 'memory.add') {
  const predictionId = `pred-bench-${index}`;
  const evaluationId = `eval-bench-${index}`;
  const experienceId = `exp-outcome-${index}`;
  const rule = `prefer work that names ${capability}: the latest live recorded outcome inside the expectation's horizon was a success`;
  const guidance = { order: null, avoid: [], prefer: [capability], maxSteps: null };
  return {
    id: `adapt-pred-${String(index).padStart(2, '0')}`,
    capability,
    rule,
    ruleHash: createHash('sha256').update(rule).digest('hex'),
    method: PREDICTION_DERIVATION_METHOD,
    source: 'prediction',
    supportCount: 1,
    guidanceCount: 0,
    shapeVersion: 1,
    support: {
      experienceIds: [experienceId],
      feedbackIds: [],
      predictionIds: [predictionId],
      evaluationIds: [evaluationId],
    },
    predictionEvidence: { eligible: true, state: 'eligible', reason: null },
    proposal: {
      type: 'evaluated_prediction',
      dimension: 'approved_adaptation_fit',
      verdicts: [{ predictionId, evaluationId, capability, expectation: 'success', verdict: 'matched', outcomeClass: 'success' }],
      guidance,
      limitations: ['one recorded evaluation of one expectation is a single observation, not a pattern'],
      evidenceDigest: createHash('sha256').update(`evidence-${index}`).digest('hex'),
    },
    decidedAt: '2026-11-02T00:00:00.000Z',
    decisionState: 'approved',
    active: true,
    conflicts: 0,
    conflictsWith: [],
    guidance: { id: `adapt-pred-${index}`, ...guidance, createdAt: '2026-11-02T00:00:00.000Z', source: 'proposal' },
  };
}

function ledger(spec, predictionCount) {
  const rows = [];
  for (let i = 0; i < predictionCount; i += 1) rows.push(predictionRow(i));
  for (let i = 0; i < spec.records - predictionCount; i += 1) rows.push(feedbackRow(i, spec.support));
  return rows;
}

function fixture(spec, predictionCount) {
  const candidates = Array.from({ length: spec.candidates }, (_, i) => {
    const structure = i % 2 === 0 ? 'writes_first' : 'read_then_write';
    const seconds = 40 + (i % 5) * 10 + (structure === 'read_then_write' ? 15 : 0);
    return candidateOf(i, structure, seconds);
  });
  const result = { ok: true, candidates, skipped: [], unaddressed: [], assumedFromGoalRequest: [] };
  const goal = { id: 'goal-bench', revision: 1, status: 'active', criteria: [] };
  const adaptations = ledger(spec, predictionCount);
  const guidance = guidanceFrom({ adaptations, candidates, registry });
  return { adaptations, args: { result, goal, registry, guidance }, guidance, candidates };
}

// Every field the comparison produced apart from the decision block, the ledger it was handed, and the
// one ranked dimension a record is allowed to feed. The two conditions must agree on all of them, or
// the measurement would be comparing different work.
function shape(value) {
  return JSON.stringify({
    candidates: value.candidates.map((c) => ({
      strategy: c.strategy,
      digest: c.digest,
      steps: c.steps,
      writes: c.writes,
      reads: c.reads,
      risk: c.risk,
      gates: c.gates,
      included: c.included,
      failedGates: c.failedGates,
    })),
    included: value.included,
    excluded: value.excluded,
    gates: value.gates,
    boundTo: value.boundTo,
    rankedDimensions: value.rankedDimensions,
  });
}

function projectionOf(index) {
  return {
    id: `pred-scan-${index}`,
    capability: 'memory.add',
    expectation: 'success',
    status: 'evaluated',
    provenance: { origin: 'user_recorded' },
    evaluation: { id: `eval-scan-${index}`, verdict: 'matched', decidingExperienceId: `exp-scan-${index}`, outcomeExperienceIds: [`exp-scan-${index}`] },
    lineage: { available: true, atCreation: { unresolvedExperienceIds: [], unresolvedFeedbackIds: [], unavailableDeclared: false } },
  };
}

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--')
    ? process.argv[at + 1] : (process.argv.includes(`--${name}`) ? true : fallback);
}

const repeats = Math.min(Math.max(1, Number(arg('repeats', 9)) || 9), MAX_REPEATS);
const wanted = String(arg('sizes', 'S,M,L')).split(',').map((s) => s.trim().toUpperCase()).filter((s) => SIZES[s]);

// `os` is imported for the interpretation note below; a benchmark that quietly measured a path it did
// not name would be worse than no benchmark, so the machine is printed once with the procedure.
console.log(`prediction-informed decision benchmark: ${os.platform()} ${os.arch()}, Node ${process.version}`);
console.log('pure functions only; no backend, no application, no store and no inference\n');
console.log(`repeats: ${repeats} per measurement, the two conditions interleaved per sample\n`);

const failed = [];

for (const size of wanted) {
  const spec = SIZES[size];
  const before = fixture(spec, 0);
  const after = fixture(spec, spec.predictions);

  // Warm both conditions before any sample: the first call pays JIT compilation for the whole path,
  // which would otherwise land on whichever build ran first. The calls are interleaved so they compile
  // under the same conditions.
  for (let i = 0; i < 20; i += 1) {
    guidanceFrom({ adaptations: before.adaptations, candidates: before.candidates, registry });
    evaluateCandidates(before.args);
    guidanceFrom({ adaptations: after.adaptations, candidates: after.candidates, registry });
    evaluateCandidates(after.args);
  }

  const times = {
    ledgerA: [], ledgerB: [], comparisonA: [], comparisonB: [], combinedA: [], combinedB: [],
  };
  let firstB = null;
  for (let i = 0; i < repeats; i += 1) {
    let started = performance.now();
    guidanceFrom({ adaptations: before.adaptations, candidates: before.candidates, registry });
    times.ledgerA.push(performance.now() - started);
    started = performance.now();
    guidanceFrom({ adaptations: after.adaptations, candidates: after.candidates, registry });
    times.ledgerB.push(performance.now() - started);

    started = performance.now();
    evaluateCandidates(before.args);
    times.comparisonA.push(performance.now() - started);
    started = performance.now();
    const b = evaluateCandidates(after.args);
    times.comparisonB.push(performance.now() - started);
    if (i === 0) firstB = b;

    started = performance.now();
    evaluateCandidates({ ...before.args, guidance: guidanceFrom({ adaptations: before.adaptations, candidates: before.candidates, registry }) });
    times.combinedA.push(performance.now() - started);
    started = performance.now();
    evaluateCandidates({ ...after.args, guidance: guidanceFrom({ adaptations: after.adaptations, candidates: after.candidates, registry }) });
    times.combinedB.push(performance.now() - started);
  }

  const shapeA = shape(evaluateCandidates(before.args));
  const shapeB = shape(evaluateCandidates(after.args));
  if (shapeA !== shapeB) failed.push(`${size}: the candidate evaluation differs between the two conditions`);

  const decision = firstB.adaptationDecision;
  const beforeDecision = evaluateCandidates(before.args).adaptationDecision;
  const ledgerA = before.guidance;
  const ledgerB = after.guidance;
  const predictionCount = spec.predictions;
  const feedbackCount = spec.records - predictionCount;
  console.log(`### size ${size}  ${spec.candidates} candidates; AP-01 path ${spec.records} feedback-derived record(s); `
    + `prediction path ${predictionCount} prediction-derived + ${feedbackCount} feedback-derived record(s)`);
  console.log(`  AP-01 ledger: applicable ${ledgerA.applicable.length}, applied ${ledgerA.influencesSelection}, `
    + `predictions considered ${ledgerA.sources.predictionConsidered}, sources ${beforeDecision.sources.predictionEvidence}`);
  console.log(`  prediction ledger: applicable ${ledgerB.applicable.length}, applied ${ledgerB.influencesSelection}, `
    + `predictions considered ${ledgerB.sources.predictionConsidered}, sources ${decision.sources.predictionEvidence}, `
    + `prediction records ${predictionCount}, evaluations ${predictionCount}`);
  console.log(`  decision: outcome ${decision.outcome}, rules ${decision.rules.length}, `
    + `evidence ${decision.evidence.experienceIds.length} experience / ${decision.evidence.feedbackIds.length} feedback / `
    + `${decision.evidence.predictionIds.length} prediction / ${decision.evidence.evaluationIds.length} evaluation, `
    + `records considered ${decision.considered.length}`);
  console.log(line('ledger read: AP-01 path', times.ledgerA));
  console.log(line('ledger read: prediction path', times.ledgerB));
  console.log(line('comparison: AP-01 path', times.comparisonA));
  console.log(line('comparison: prediction path', times.comparisonB));
  console.log(line('ledger + comparison: AP-01 path', times.combinedA));
  console.log(line('ledger + comparison: prediction path', times.combinedB));
  const addedLedger = median(times.ledgerB) - median(times.ledgerA);
  const addedComparison = median(times.comparisonB) - median(times.comparisonA);
  const addedCombined = median(times.combinedB) - median(times.combinedA);
  console.log(`  ${pad('added ledger read', 44)} ${pad(`${addedLedger >= 0 ? '+' : ''}${ms(addedLedger)}`, 10)}ms`);
  console.log(`  ${pad('added comparison', 44)} ${pad(`${addedComparison >= 0 ? '+' : ''}${ms(addedComparison)}`, 10)}ms`);
  console.log(`  ${pad('added decision path (ledger + comparison)', 44)} ${pad(`${addedCombined >= 0 ? '+' : ''}${ms(addedCombined)}`, 10)}ms`
    + ` (${median(times.combinedA) === 0 ? 'n/a' : `${((addedCombined / median(times.combinedA)) * 100).toFixed(1)}% of the AP-01 median`})`);
  for (let i = 0; i < 20; i += 1) renderAdaptationDecision(decision);
  const renderSamples = [];
  for (let i = 0; i < repeats; i += 1) {
    const started = performance.now();
    renderAdaptationDecision(decision);
    renderSamples.push(performance.now() - started);
  }
  console.log(line('decision disclosure render', renderSamples));
  console.log(`  the two conditions produce the same candidate bytes, gates and binding: ${shapeA === shapeB ? 'yes' : 'NO'}\n`);
}

// ---- the pure eligibility rule the store applies per record ---------------------------------------
const experiencesById = new Map();
for (let i = 0; i < MAX_ELIGIBILITY_RECORDS; i += 1) {
  experiencesById.set(`exp-scan-${i}`, { id: `exp-scan-${i}`, outcome: Outcome.SUCCESS_VERIFIED, active: true });
}

console.log('### prediction eligibility rule (pure, one recorded evaluation per projected expectation)');
for (const count of [25, 100, MAX_ELIGIBILITY_RECORDS]) {
  const projections = Array.from({ length: count }, (_, i) => projectionOf(i));
  for (let i = 0; i < 5; i += 1) {
    for (const projection of projections) predictionEligibility({ projection, experiencesById });
  }
  const samples = [];
  let eligible = 0;
  let proposed = 0;
  for (let i = 0; i < repeats; i += 1) {
    const started = performance.now();
    let n = 0;
    let p = 0;
    for (const projection of projections) {
      if (predictionEligibility({ projection, experiencesById }).eligible) n += 1;
      if (proposalFor({ projection, experiencesById })) p += 1;
    }
    samples.push(performance.now() - started);
    eligible = n;
    proposed = p;
  }
  const total = median(samples);
  console.log(`  ${pad(`${count} projection(s)`, 44)} ${pad(ms(total), 10)} min ${pad(ms(Math.min(...samples)), 10)}`
    + ` ${pad(`${us((total * 1000) / count)} us/record`, 22)} eligible ${eligible}, proposal ${proposed}`
    + ` samples ${samples.map((x) => (Math.round(x * 1000) / 1000).toFixed(2)).join('/')}ms`);
}
console.log('  (a scan re-runs the rule for every record: no result is cached between records or between reads)');

if (failed.length > 0) {
  console.log('\nThe run is not comparable:');
  for (const problem of failed) console.log(`  - ${problem}`);
  process.exitCode = 1;
}
