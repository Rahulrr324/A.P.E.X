// Deterministic pattern extraction over recorded outcomes, experiences, and feedback.
//
// Six kinds, a closed vocabulary, and one rule: a pattern is a count over records that already exist.
// It is never a cause, a probability, or a forecast, and the evidence that disagrees with it is
// carried beside it rather than dropped. Every pattern names the threshold it had to meet, and the
// threshold's reason is stated in ./vocabulary.js.
//
//   repeated_success        one capability completed every step it appeared in, at least three times
//   repeated_failure        one capability failed a step at least twice and is not outnumbered by successes
//   correction_hotspot      the user corrected at least two recorded outcomes of one capability
//   inefficient_execution   a capability appeared only in failed runs of an objective that succeeded without it
//   ordering_dependency     one capability before another in successes, reversed in failures
//   condition_association   a recorded condition (step count) is associated with a different success count
//
// No consumer may read a pattern as permission or as proof. `condition_association` is reported and
// never proposable, because acting on a correlated condition would be a causal claim the records
// cannot support.
import {
  MAX_PATTERN_SUPPORT,
  MAX_PATTERNS,
  MIN_CORRECTION_OBSERVATIONS,
  MIN_FAILURE_OBSERVATIONS,
  MIN_MEASUREMENT_OBSERVATIONS,
  MIN_ORDER_OBSERVATIONS,
  MIN_PATTERN_OBSERVATIONS,
  PATTERN_DEFINITIONS,
  PATTERN_LIMITATIONS,
  PROPOSABLE_PATTERNS,
} from './vocabulary.js';

const CORRECTIVE = new Set(['incorrect', 'not_useful', 'user_correction', 'outcome_failed']);
const APPROVING = new Set(['correct', 'useful', 'partially_correct', 'outcome_succeeded']);
// A run with this many steps or fewer is the "few" band in a condition association; the cut is the
// smallest count at which a run stops looking like a single action and its verification.
const FEW_STEPS = 2;

function confidenceOf({ supporting, contradicting, minimum }) {
  if (supporting < minimum) return 'low';
  if (supporting >= minimum + 2 && contradicting === 0) return 'high';
  if (contradicting > supporting) return 'low';
  return 'moderate';
}

function evidence(kind, ids, max = MAX_PATTERN_SUPPORT) {
  return [...new Set(ids)].slice(0, max).map((id) => ({ kind, id }));
}

// Per-capability observations inside one evaluation. A capability's own outcome is about its own
// steps; the evaluation's overall classification is kept beside it because a run can fail later.
// Observations are grouped by capability *and* objective. A rule learned while pursuing one
// intention is not evidence about another, so two objectives that happen to use the same capability
// never pool their counts into one pattern.
function capabilityObservations(evaluations) {
  const groups = new Map();
  for (const evaluation of evaluations) {
    for (const row of evaluation.capabilities ?? []) {
      const key = `${row.capability}\u0000${evaluation.objectiveKey ?? ''}`;
      const bucket = groups.get(key) ?? { capability: row.capability, objectiveKey: evaluation.objectiveKey ?? null, observations: [] };
      bucket.observations.push({
        evaluationId: evaluation.id,
        objectiveKey: evaluation.objectiveKey,
        outcome: row.outcome,
        classification: evaluation.classification,
        steps: evaluation.steps.total,
      });
      groups.set(key, bucket);
    }
  }
  return groups;
}

function failuresOf(observations) {
  return observations.filter((o) => o.outcome === 'failure');
}

function successesOf(observations) {
  return observations.filter((o) => o.outcome === 'success');
}

function buildPattern({ kind, capability, objectiveKey = null, observations, supporting, contradicting, minimum, detail = {} }) {
  const successes = successesOf(observations).length;
  const failures = failuresOf(observations).length;
  return {
    kind,
    capability,
    objectiveKey,
    definition: PATTERN_DEFINITIONS[kind],
    observations: {
      total: observations.length,
      successes,
      failures,
      partial: observations.filter((o) => o.outcome === 'partial' || o.outcome === 'not_run').length,
    },
    supporting: evidence('evaluation', supporting),
    contradicting: evidence('evaluation', contradicting),
    confidence: confidenceOf({ supporting: supporting.length, contradicting: contradicting.length, minimum }),
    minObservations: minimum,
    proposalEligible: PROPOSABLE_PATTERNS.includes(kind) && supporting.length >= minimum,
    detail,
    limitations: [...PATTERN_LIMITATIONS],
  };
}

// The six analyses. Every list is bounded and every result is sorted, so the same records always
// produce the same patterns in the same order.
export function analyzePatterns({ evaluations = [], experiences = [], minObservations = MIN_PATTERN_OBSERVATIONS } = {}) {
  const threshold = Math.max(MIN_PATTERN_OBSERVATIONS, Number.isInteger(minObservations) ? minObservations : MIN_PATTERN_OBSERVATIONS);
  const patterns = [];
  const byCapability = capabilityObservations(evaluations);

  for (const group of byCapability.values()) {
    const { capability, objectiveKey, observations } = group;
    const successes = successesOf(observations);
    const failures = failuresOf(observations);
    if (successes.length >= threshold && successes.length >= failures.length) {
      patterns.push(buildPattern({
        kind: 'repeated_success',
        capability,
        objectiveKey,
        observations,
        supporting: successes.map((o) => o.evaluationId),
        contradicting: failures.map((o) => o.evaluationId),
        minimum: threshold,
      }));
    }
    if (failures.length >= MIN_FAILURE_OBSERVATIONS && failures.length >= successes.length) {
      patterns.push(buildPattern({
        kind: 'repeated_failure',
        capability,
        objectiveKey,
        observations,
        supporting: failures.map((o) => o.evaluationId),
        contradicting: successes.map((o) => o.evaluationId),
        minimum: MIN_FAILURE_OBSERVATIONS,
      }));
    }
  }

  // Ordering: a pair of capabilities that appear in one objective's runs. The claim needs both sides:
  // successes that preserved the order and failures that reversed it.
  const byObjective = new Map();
  for (const evaluation of evaluations) {
    const key = evaluation.objectiveKey ?? 'none';
    const list = byObjective.get(key) ?? [];
    list.push(evaluation);
    byObjective.set(key, list);
  }
  const outcomeOfCapability = (run, capability) => (run.capabilities ?? [])
    .find((row) => row.capability === capability)?.outcome ?? null;
  for (const [objectiveKey, allRuns] of byObjective) {
    const runs = allRuns.filter((run) => Array.isArray(run.sequence) && run.sequence.length >= 2);
    const pairs = new Map();
    for (const run of runs) {
      const sequence = run.sequence;
      for (let i = 0; i < sequence.length; i += 1) {
        for (let j = i + 1; j < sequence.length; j += 1) {
          const key = `${sequence[i]}\u0000${sequence[j]}`;
          const bucket = pairs.get(key) ?? { first: sequence[i], second: sequence[j], kept: [], reversed: [] };
          bucket.kept.push(run);
          pairs.set(key, bucket);
        }
        // A reversal is the same pair seen the other way round.
        for (let j = 0; j < i; j += 1) {
          const key = `${sequence[j]}\u0000${sequence[i]}`;
          const bucket = pairs.get(key) ?? { first: sequence[j], second: sequence[i], kept: [], reversed: [] };
          bucket.reversed.push(run);
          pairs.set(key, bucket);
        }
      }
    }
    for (const bucket of pairs.values()) {
      // The claim is about the second capability's own steps: it succeeded when it ran after the
      // predecessor, and failed when the order was reversed. Both sides are required.
      const heldSuccesses = bucket.kept.filter((r) => outcomeOfCapability(r, bucket.second) === 'success');
      const reversedFailures = bucket.reversed.filter((r) => outcomeOfCapability(r, bucket.second) === 'failure');
      if (heldSuccesses.length < MIN_ORDER_OBSERVATIONS || reversedFailures.length < MIN_ORDER_OBSERVATIONS) continue;
      const heldFailures = bucket.kept.filter((r) => outcomeOfCapability(r, bucket.second) === 'failure');
      const reversedSuccesses = bucket.reversed.filter((r) => outcomeOfCapability(r, bucket.second) === 'success');
      const observations = [
        ...heldSuccesses.map((r) => ({ evaluationId: r.id, outcome: 'success', objectiveKey: r.objectiveKey })),
        ...reversedFailures.map((r) => ({ evaluationId: r.id, outcome: 'failure', objectiveKey: r.objectiveKey })),
      ];
      patterns.push(buildPattern({
        kind: 'ordering_dependency',
        capability: bucket.second,
        objectiveKey: objectiveKey === 'none' ? null : objectiveKey,
        observations,
        supporting: [...heldSuccesses.map((r) => r.id), ...reversedFailures.map((r) => r.id)],
        contradicting: [...heldFailures.map((r) => r.id), ...reversedSuccesses.map((r) => r.id)],
        minimum: MIN_ORDER_OBSERVATIONS,
        detail: {
          predecessor: bucket.first,
          orderHeld: heldSuccesses.length,
          orderReversed: reversedFailures.length,
        },
      }));
    }
  }

  // A capability that appears only in failed runs of an objective the same capability-free runs
  // achieved. Its absence from every success is why this is "inefficient", not merely "failed".
  for (const [objectiveKey, runs] of byObjective) {
    const successes = runs.filter((r) => r.classification === 'achieved');
    if (successes.length < MIN_FAILURE_OBSERVATIONS) continue;
    const capabilities = new Set(runs.flatMap((r) => (r.capabilities ?? []).map((row) => row.capability)));
    for (const capability of capabilities) {
      const failing = runs.filter((r) => (r.capabilities ?? []).some((row) => row.capability === capability && row.outcome === 'failure'));
      if (failing.length < MIN_FAILURE_OBSERVATIONS) continue;
      const successWith = successes.filter((r) => (r.capabilities ?? []).some((row) => row.capability === capability));
      if (successWith.length > 0) continue;
      const successWithout = successes.filter((r) => !(r.capabilities ?? []).some((row) => row.capability === capability));
      if (successWithout.length < MIN_FAILURE_OBSERVATIONS) continue;
      const observations = [
        ...failing.map((r) => ({ evaluationId: r.id, outcome: 'failure', objectiveKey: r.objectiveKey })),
        ...successWithout.map((r) => ({ evaluationId: r.id, outcome: 'success', objectiveKey: r.objectiveKey })),
      ];
      patterns.push({
        ...buildPattern({
          kind: 'inefficient_execution',
          capability,
          objectiveKey: objectiveKey === 'none' ? null : objectiveKey,
          observations,
          // The failing runs and the successful runs that omitted the capability both support the
          // claim that the capability is what the failures have in common.
          supporting: [...failing.map((r) => r.id), ...successWithout.map((r) => r.id)],
          contradicting: successWith.map((r) => r.id),
          minimum: MIN_FAILURE_OBSERVATIONS,
          detail: { failedRuns: failing.length, succeededWithoutIt: successWithout.length },
        }),
        supporting: evidence('evaluation', [...failing.map((r) => r.id), ...successWithout.map((r) => r.id)]),
        contradicting: evidence('evaluation', successWith.map((r) => r.id)),
      });
    }
  }

  // Condition association: the step-count band of a run, per capability. Reported, never proposed.
  for (const group of byCapability.values()) {
    const { capability, objectiveKey, observations } = group;
    const few = observations.filter((o) => o.outcome !== 'not_run' && o.steps <= FEW_STEPS);
    const many = observations.filter((o) => o.outcome !== 'not_run' && o.steps > FEW_STEPS);
    if (few.length < MIN_MEASUREMENT_OBSERVATIONS || many.length < MIN_MEASUREMENT_OBSERVATIONS) continue;
    const fewSuccess = successesOf(few).length;
    const manySuccess = successesOf(many).length;
    if (fewSuccess === manySuccess) continue;
    const betterIsFew = fewSuccess > manySuccess;
    patterns.push({
      kind: 'condition_association',
      capability,
      objectiveKey,
      definition: PATTERN_DEFINITIONS.condition_association,
      observations: {
        total: few.length + many.length,
        successes: fewSuccess + manySuccess,
        failures: failuresOf(few).length + failuresOf(many).length,
        partial: observations.length - few.length - many.length,
      },
      supporting: evidence('evaluation', (betterIsFew ? few : many)
        .filter((o) => o.outcome === 'success')
        .map((o) => o.evaluationId)),
      contradicting: evidence('evaluation', (betterIsFew ? many : few)
        .filter((o) => o.outcome === 'success')
        .map((o) => o.evaluationId)),
      confidence: confidenceOf({
        supporting: betterIsFew ? fewSuccess : manySuccess,
        contradicting: betterIsFew ? manySuccess : fewSuccess,
        minimum: MIN_MEASUREMENT_OBSERVATIONS,
      }),
      minObservations: MIN_MEASUREMENT_OBSERVATIONS,
      proposalEligible: false,
      detail: {
        condition: 'step_count',
        band: betterIsFew ? `at most ${FEW_STEPS}` : `more than ${FEW_STEPS}`,
        successesInBand: betterIsFew ? fewSuccess : manySuccess,
        successesOutside: betterIsFew ? manySuccess : fewSuccess,
        stepBandFew: few.length,
        stepBandMany: many.length,
      },
      limitations: [
        ...PATTERN_LIMITATIONS,
        'this is an association between a recorded condition and an outcome count. It is not a cause, and no proposal is drawn from it.',
      ],
    });
  }

  // Corrections: the user's own repeated assessment of one capability.
  const corrections = new Map();
  for (const experience of experiences) {
    const capability = experience.capability;
    if (!capability) continue;
    for (const feedback of experience.feedbackSamples ?? []) {
      const bucket = corrections.get(capability) ?? { corrective: [], approving: [], experiences: [] };
      if (CORRECTIVE.has(feedback.assessment)) bucket.corrective.push({ id: feedback.id, experienceId: experience.id });
      else if (APPROVING.has(feedback.assessment)) bucket.approving.push({ id: feedback.id, experienceId: experience.id });
      if (!bucket.experiences.includes(experience.id)) bucket.experiences.push(experience.id);
      corrections.set(capability, bucket);
    }
  }
  for (const [capability, bucket] of corrections) {
    if (bucket.corrective.length < MIN_CORRECTION_OBSERVATIONS) continue;
    patterns.push({
      kind: 'correction_hotspot',
      capability,
      objectiveKey: null,
      definition: PATTERN_DEFINITIONS.correction_hotspot,
      observations: {
        total: bucket.corrective.length + bucket.approving.length,
        successes: bucket.approving.length,
        failures: bucket.corrective.length,
        partial: 0,
      },
      supporting: evidence('feedback', bucket.corrective.map((f) => f.id)),
      contradicting: evidence('feedback', bucket.approving.map((f) => f.id)),
      confidence: confidenceOf({
        supporting: bucket.corrective.length,
        contradicting: bucket.approving.length,
        minimum: MIN_CORRECTION_OBSERVATIONS,
      }),
      minObservations: MIN_CORRECTION_OBSERVATIONS,
      proposalEligible: false,
      detail: { correctedExperiences: bucket.experiences.length },
      limitations: [
        ...PATTERN_LIMITATIONS,
        'a correction is the user\'s own judgement of one recorded outcome; it is not a measurement of the capability.',
      ],
    });
  }

  const sorted = patterns.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.capability !== b.capability) return a.capability < b.capability ? -1 : 1;
    return String(a.objectiveKey ?? '').localeCompare(String(b.objectiveKey ?? ''));
  });
  return {
    patterns: sorted.slice(0, MAX_PATTERNS),
    truncated: sorted.length > MAX_PATTERNS,
    considered: { evaluations: evaluations.length, experiences: experiences.length, minObservations: threshold },
  };
}
