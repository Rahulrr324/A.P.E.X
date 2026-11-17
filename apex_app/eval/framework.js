// Reusable evaluation framework for T-15.
//
// It measures whether APEX achieves a user-level outcome through its supported interfaces. It is
// deliberately separate from `src/`: a scenario describes what a person is trying to accomplish,
// the fixture supplies the initial state, and the checks are written against public results
// (outcome statuses, displayed text, records a user can read back), never against private
// helpers or internal strings.
//
// Two rules shape the whole file:
//
// 1. A successful call is not a successful task. A scenario that returns without throwing but
//    asserts nothing about the outcome is `invalid_scenario`, not a pass. At least one
//    correctness or completeness assertion is required, and a pass means every asserted
//    dimension held. The runner never derives a pass from an exit code.
//
// 2. Dimensions stay separate. Correctness, completeness, reliability, safety, continuity,
//    performance and UX measure different promises. A dimension a scenario does not exercise is
//    null and is excluded from its rate; null is never counted as a pass and no composite score
//    is produced. A single number would hide which promise moved.
//
// The framework also records a bounded execution trace, an evidence list, failure classes, and a
// repeat signature so two runs on identical fixtures can be compared for reproducibility.
//
// This is not a real-world intelligence benchmark. These scenarios use synthetic fixtures, the
// no-backend gateway or an in-process scripted fixture, and deterministic clocks. No inference
// system is contacted, started, downloaded, or recommended.
import { createHash } from 'node:crypto';

export const DIMENSIONS = Object.freeze([
  'correctness',
  'completeness',
  'reliability',
  'safety',
  'continuity',
  'performance',
  'ux',
]);

// What a person relies on when they say the task worked. Each failure class names a distinct
// cause, so a failing run says what kind of promise broke rather than only that something did.
export const FAILURE_CLASSES = Object.freeze([
  'wrong_outcome',       // the request was not carried out, or the outcome status was not the expected one
  'missing_evidence',    // the work may have happened, but the record that proves it is absent
  'unsupported_claim',   // an answer asserted something the records do not support
  'unsafe_side_effect',  // something ran or was stored that the user did not authorize
  'continuity_loss',     // state was lost, duplicated, stale, or inconsistent across sessions
  'performance_exceeded',// a declared time or size budget was exceeded
  'unusable_output',     // the answer was absent, unbounded, or omitted what the user needed
  'unexpected_exception',// the operation threw instead of reporting a result
  'invalid_scenario',    // the scenario asserted no task-level outcome; a clean return is not a pass
  'oracle_disagreement', // two runs on identical fixtures disagreed, so the result is not reproducible
  'harness_error',       // the scenario or its fixture is wrong; it is not evidence about APEX
]);

const FAILURE_FOR_DIMENSION = Object.freeze({
  correctness: 'wrong_outcome',
  completeness: 'missing_evidence',
  safety: 'unsafe_side_effect',
  continuity: 'continuity_loss',
  performance: 'performance_exceeded',
  ux: 'unusable_output',
  reliability: 'wrong_outcome',
});

export const MAX_TRACE_ENTRIES = 60;
export const MAX_EVIDENCE_ENTRIES = 40;
const MAX_TRACE_TEXT = 2000;
const MAX_EVIDENCE_BYTES = 6000;

export function check(ok, expected, actual) {
  return { ok: Boolean(ok), expected, actual };
}

// A scenario is data plus one `run` function. `preconditions` and `steps` are documentation the
// runner prints, so a reader can see the setup and the user interactions without reading code.
export function validateScenario(scenario) {
  const problems = [];
  for (const field of ['id', 'category', 'title', 'intent']) {
    if (typeof scenario?.[field] !== 'string' || scenario[field].trim() === '') problems.push(`${field} must be a non-empty string`);
  }
  if (!Array.isArray(scenario?.preconditions)) problems.push('preconditions must be a list');
  if (!Array.isArray(scenario?.steps) || scenario.steps.length === 0) problems.push('steps must be a non-empty list');
  if (typeof scenario?.run !== 'function') problems.push('run must be a function');
  if (scenario?.performance !== undefined) {
    const max = scenario.performance?.maxDurationMs;
    if (!Number.isFinite(max) || max <= 0) problems.push('performance.maxDurationMs must be a positive number');
  }
  if (problems.length > 0) {
    const err = new Error(`invalid evaluation scenario ${scenario?.id ?? '(no id)'}: ${problems.join('; ')}`);
    err.code = 'EVAL_HARNESS';
    throw err;
  }
}

// Bounded, deterministic serialisation for traces and evidence. Values that cannot be serialised
// are reported as such rather than dropped silently.
export function stableValue(value, { max = MAX_TRACE_TEXT } = {}) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = '[unserialisable value]';
  }
  if (typeof text !== 'string') text = String(value);
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} chars omitted]` : text;
}

export function signatureOf(result) {
  const checks = Object.fromEntries(DIMENSIONS.map((dimension) => {
    const entry = result.checks?.[dimension];
    return [dimension, entry ? Boolean(entry.ok) : null];
  }));
  return createHash('sha256').update(JSON.stringify({
    id: result.id,
    pass: result.pass,
    failureClass: result.failureClass,
    expected: result.expected ?? null,
    actual: result.actual ?? null,
    checks,
  })).digest('hex');
}

function normalizeChecks(raw) {
  const checks = {};
  for (const dimension of DIMENSIONS) {
    const entry = raw?.[dimension];
    if (entry === undefined || entry === null) {
      checks[dimension] = null;
      continue;
    }
    if (typeof entry !== 'object' || typeof entry.ok !== 'boolean') {
      const err = new Error(`scenario check ${dimension} must be { ok, expected, actual }`);
      err.code = 'EVAL_HARNESS';
      throw err;
    }
    checks[dimension] = { ok: entry.ok, expected: entry.expected ?? null, actual: entry.actual ?? null };
  }
  return checks;
}

function classify(scenario, checks) {
  const failed = DIMENSIONS.filter((dimension) => checks[dimension] !== null && !checks[dimension].ok);
  if (failed.length === 0) return null;
  const explicit = scenario.failureClasses ?? {};
  for (const dimension of failed) {
    const named = explicit[dimension];
    if (named && FAILURE_CLASSES.includes(named)) return named;
    const byDimension = FAILURE_FOR_DIMENSION[dimension];
    if (byDimension) return byDimension;
  }
  return 'wrong_outcome';
}

function outcomeAsserted(checks) {
  return (checks.correctness !== null && checks.correctness !== undefined)
    || (checks.completeness !== null && checks.completeness !== undefined);
}

// Runs one scenario against one fresh context. It measures the wall-clock duration and appends a
// performance check only when the scenario declares a budget and did not write its own.
export async function runScenario(scenario, { makeContext } = {}) {
  validateScenario(scenario);
  if (typeof makeContext !== 'function') throw new Error('runScenario needs a makeContext function');
  const startedAt = Date.now();
  let ctx;
  let raw;
  let thrown = null;
  try {
    ctx = await makeContext(scenario);
    raw = await scenario.run(ctx);
  } catch (err) {
    thrown = err;
  } finally {
    if (ctx) await ctx.dispose?.().catch(() => {});
  }
  const durationMs = Date.now() - startedAt;

  if (thrown) {
    const harness = thrown?.code === 'EVAL_HARNESS';
    return {
      id: scenario.id,
      category: scenario.category,
      title: scenario.title,
      intent: scenario.intent,
      preconditions: scenario.preconditions,
      steps: scenario.steps,
      blind: scenario.blind === true,
      pass: false,
      expected: 'the user interaction completes and its outcome is asserted',
      actual: `${harness ? 'harness' : thrown?.code ?? 'ERROR'}: ${thrown?.message ?? String(thrown)}`,
      checks: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, null])),
      failedDimensions: harness ? [] : DIMENSIONS,
      failureClass: harness ? 'harness_error' : 'unexpected_exception',
      durationMs,
      trace: ctx?.traceEntries?.() ?? [],
      evidence: ctx?.evidenceEntries?.() ?? [],
      notes: harness ? ['the scenario or fixture is wrong; this result is not evidence about APEX'] : [],
    };
  }

  if (raw === null || typeof raw !== 'object') {
    return {
      id: scenario.id,
      category: scenario.category,
      title: scenario.title,
      intent: scenario.intent,
      preconditions: scenario.preconditions,
      steps: scenario.steps,
      blind: scenario.blind === true,
      pass: false,
      expected: 'the scenario returns an outcome description',
      actual: stableValue(raw),
      checks: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, null])),
      failedDimensions: [],
      failureClass: 'harness_error',
      durationMs,
      trace: ctx?.traceEntries?.() ?? [],
      evidence: ctx?.evidenceEntries?.() ?? [],
      notes: ['the scenario returned no result object'],
    };
  }

  const checks = normalizeChecks(raw.checks);
  if (scenario.performance?.maxDurationMs && checks.performance === null) {
    checks.performance = check(
      durationMs <= scenario.performance.maxDurationMs,
      `the scenario completes within ${scenario.performance.maxDurationMs} ms`,
      `${durationMs} ms`,
    );
  }
  const failedDimensions = DIMENSIONS.filter((dimension) => checks[dimension] !== null && !checks[dimension].ok);
  const asserted = outcomeAsserted(checks);
  const failureClass = !asserted && failedDimensions.length === 0
    ? 'invalid_scenario'
    : (thrown ? 'unexpected_exception' : classify(scenario, checks));
  const pass = asserted && failedDimensions.length === 0;

  return {
    id: scenario.id,
    category: scenario.category,
    title: scenario.title,
    intent: scenario.intent,
    preconditions: scenario.preconditions,
    steps: scenario.steps,
    blind: scenario.blind === true,
    expected: raw.expected ?? null,
    actual: raw.actual ?? null,
    checks,
    failedDimensions,
    failureClass,
    pass,
    durationMs,
    metrics: raw.metrics ?? {},
    recovery: raw.recovery ?? null,
    trace: ctx?.traceEntries?.() ?? [],
    evidence: ctx?.evidenceEntries?.() ?? [],
    notes: raw.notes ?? [],
  };
}

// Runs every selected scenario. `repeat` re-runs each scenario in a fresh context and compares a
// signature of the result; a disagreement marks the result as not reproducible and classifies it
// as `oracle_disagreement`, because a number that moves between identical runs cannot support a
// conclusion.
export async function runEvaluation({ scenarios, makeContext, repeat = 1, filter = null } = {}) {
  const selected = filter ? scenarios.filter(filter) : scenarios;
  const ids = new Set();
  for (const scenario of selected) {
    if (ids.has(scenario.id)) throw new Error(`duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
  }
  const results = [];
  for (const scenario of selected) {
    const runs = [];
    for (let index = 0; index < Math.max(1, repeat); index += 1) {
      runs.push(await runScenario(scenario, { makeContext }));
    }
    const first = runs[0];
    if (runs.length > 1) {
      const signatures = runs.map(signatureOf);
      const reproducible = signatures.every((signature) => signature === signatures[0]);
      first.reproducible = reproducible;
      first.repeatRuns = runs.length;
      if (!reproducible) {
        first.pass = false;
        first.failureClass = 'oracle_disagreement';
        first.failedDimensions = [...new Set([...first.failedDimensions, ...DIMENSIONS])];
        first.notes = [...(first.notes ?? []), 'repeated runs on identical fixtures disagreed; the result is not reproducible'];
      }
    } else {
      first.reproducible = null;
      first.repeatRuns = 1;
    }
    results.push(first);
  }
  return { results, summary: summarize(results) };
}

export function summarize(results) {
  const dimensions = {};
  for (const dimension of DIMENSIONS) {
    let passed = 0;
    let total = 0;
    for (const result of results) {
      const entry = result.checks?.[dimension];
      if (!entry) continue;
      total += 1;
      if (entry.ok) passed += 1;
    }
    dimensions[dimension] = { passed, total, rate: total > 0 ? passed / total : null };
  }
  const categories = {};
  for (const result of results) {
    const bucket = categories[result.category] ?? { passed: 0, total: 0 };
    bucket.total += 1;
    if (result.pass) bucket.passed += 1;
    categories[result.category] = bucket;
  }
  const failureClasses = {};
  for (const result of results) {
    if (result.pass || !result.failureClass) continue;
    failureClasses[result.failureClass] = (failureClasses[result.failureClass] ?? 0) + 1;
  }
  return {
    scenarios: results.length,
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass).length,
    dimensions,
    categories,
    failureClasses,
    blindResults: {
      blind: results.filter((result) => result.blind).length,
      nonBlind: results.filter((result) => !result.blind).length,
    },
    reproducibility: {
      checked: results.filter((result) => result.reproducible !== null && result.reproducible !== undefined).length,
      reproducible: results.filter((result) => result.reproducible === true).length,
    },
  };
}

export function renderReport(report) {
  const { results, summary } = report;
  const lines = [
    `Evaluation: ${summary.passed} of ${summary.scenarios} scenario(s) passed.`,
    'A pass requires every stated outcome assertion to hold; a clean return alone is not a pass.',
    '',
  ];
  let category = null;
  for (const result of results) {
    if (result.category !== category) {
      category = result.category;
      lines.push(`[${category}]`);
    }
    const status = result.pass ? 'pass' : `FAIL (${result.failureClass ?? 'unclassified'})`;
    lines.push(`  ${result.id} ${status} - ${result.title}${result.blind ? '' : ' [non-blind]'}`);
    if (!result.pass) {
      for (const dimension of result.failedDimensions ?? []) {
        const entry = result.checks?.[dimension];
        if (entry) lines.push(`      ${dimension}: expected ${stableValue(entry.expected, { max: 300 })}; got ${stableValue(entry.actual, { max: 300 })}`);
      }
      if (result.actual !== null && result.actual !== undefined) lines.push(`      actual: ${stableValue(result.actual, { max: 500 })}`);
    }
  }
  lines.push('', 'Dimensions (each measured only where asserted; null is not a pass):');
  for (const dimension of DIMENSIONS) {
    const entry = summary.dimensions[dimension];
    lines.push(`  ${dimension.padEnd(14)} ${entry.total === 0 ? 'n/a' : `${entry.passed}/${entry.total}`}`);
  }
  lines.push('', 'Categories:');
  for (const [name, entry] of Object.entries(summary.categories)) {
    lines.push(`  ${name.padEnd(22)} ${entry.passed}/${entry.total}`);
  }
  if (Object.keys(summary.failureClasses).length > 0) {
    lines.push('', 'Failure classes:');
    for (const [name, count] of Object.entries(summary.failureClasses)) lines.push(`  ${name.padEnd(22)} ${count}`);
  }
  lines.push('', `Blind scenarios: ${summary.blindResults.blind}; non-blind: ${summary.blindResults.nonBlind}.`);
  if (summary.reproducibility.checked > 0) {
    lines.push(`Reproducibility: ${summary.reproducibility.reproducible}/${summary.reproducibility.checked} scenario(s) matched across repeats.`);
  }
  lines.push('', 'Synthetic fixtures and deterministic clocks. No model inference is used or contacted.');
  return lines.join('\n');
}
