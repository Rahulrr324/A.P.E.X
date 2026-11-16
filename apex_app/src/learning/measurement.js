// Before/after measurement of one authorised adaptation.
//
// The comparison is a count of recorded classifications, not a score. A run counts as a success only
// when its evaluation recorded `achieved`; `partially_achieved` and `not_achieved` are both kept
// apart from it, and an `indeterminate` run is excluded because it settles nothing. A rate is never
// printed as a probability, and a difference of one observation is reported as exactly that.
//
// Windows are chosen by log position, not by wall-clock time: the baseline is every determinate
// evaluation of the adaptation's capability recorded before the approving decision, and the follow-up
// is every determinate evaluation recorded after it. Position is stable under an injected clock and
// cannot reorder two events that share a timestamp.
import { sha256Hex } from '../memory/memory-store.js';
import { stableStringify } from '../tasks/model.js';
import {
  MAX_LIMITATION_CHARS,
  MAX_LIMITATIONS,
  MEASUREMENT_KIND,
  MEASUREMENT_VERDICTS,
  MIN_MEASUREMENT_OBSERVATIONS,
} from './vocabulary.js';

function metricsOf(evaluations) {
  const determinate = evaluations.filter((e) => e.classification !== 'indeterminate');
  return {
    evaluationIds: determinate.map((e) => e.id),
    observations: determinate.length,
    achieved: determinate.filter((e) => e.classification === 'achieved').length,
    partiallyAchieved: determinate.filter((e) => e.classification === 'partially_achieved').length,
    notAchieved: determinate.filter((e) => e.classification === 'not_achieved').length,
    excluded: evaluations.length - determinate.length,
  };
}

// The verdict. Both windows must hold the minimum number of determinate outcomes; below that the
// answer is `insufficient_evidence` and is never rounded to `no_change`. The comparison itself is
// cross-multiplied so it uses counts only and needs no floating point.
export function compareWindows(baseline, followUp, { minObservations = MIN_MEASUREMENT_OBSERVATIONS } = {}) {
  if (baseline.observations < minObservations || followUp.observations < minObservations) return 'insufficient_evidence';
  const before = baseline.achieved * followUp.observations;
  const after = followUp.achieved * baseline.observations;
  if (after < before) return 'regressed';
  if (after > before) return 'improved';
  return 'no_change';
}

export function measurementDigest(measurement) {
  return sha256Hex(stableStringify({
    targetId: measurement.targetId,
    decisionId: measurement.activation?.decisionId ?? null,
    baseline: measurement.baseline.evaluationIds,
    followUp: measurement.followUp.evaluationIds,
    baselineCounts: {
      observations: measurement.baseline.observations,
      achieved: measurement.baseline.achieved,
    },
    followUpCounts: {
      observations: measurement.followUp.observations,
      achieved: measurement.followUp.achieved,
    },
    minObservations: measurement.minObservations,
    verdict: measurement.verdict,
  }));
}

// Build the record the store appends. `split` supplies the two windows already chosen by position.
export function buildMeasurement({
  targetId, targetRule, capability, activation, split, minObservations = MIN_MEASUREMENT_OBSERVATIONS, now = null,
}) {
  const baseline = metricsOf(split.baseline);
  const followUp = metricsOf(split.followUp);
  const verdict = compareWindows(baseline, followUp, { minObservations });
  const limitations = [
    'this compares outcomes recorded before and after the approving decision. It does not establish that the adaptation caused the difference.',
    `a run counts as a success only when its evaluation recorded achieved; partially achieved and not achieved are counted separately, and indeterminate runs are excluded.`,
  ];
  if (verdict === 'insufficient_evidence') {
    limitations.push(`each window needs ${minObservations} determinate outcome(s); this read has ${baseline.observations} before and ${followUp.observations} after`);
  }
  if (baseline.observations > 0 || followUp.observations > 0) {
    limitations.push(`the windows are chosen by log position around decision ${activation?.decisionId ?? '(none)'}, so a later correction does not move the baseline`);
  }
  const measurement = {
    targetId,
    capability,
    rule: targetRule,
    activation: activation ? { decisionId: activation.decisionId, at: activation.at ?? null } : null,
    baseline,
    followUp,
    minObservations,
    verdict,
    limitations: limitations.slice(0, MAX_LIMITATIONS).map((text) => text.slice(0, MAX_LIMITATION_CHARS)),
  };
  measurement.evidenceSha256 = measurementDigest(measurement);
  if (now) measurement.createdAt = now;
  return measurement;
}

function countsProblem(window, name) {
  if (!window || typeof window !== 'object' || Array.isArray(window)) return `${name} window is missing`;
  if (!Array.isArray(window.evaluationIds) || window.evaluationIds.length > 40) return `${name} evaluation list is invalid`;
  if (new Set(window.evaluationIds).size !== window.evaluationIds.length) return `${name} names the same evaluation twice`;
  for (const key of ['observations', 'achieved', 'partiallyAchieved', 'notAchieved', 'excluded']) {
    if (!Number.isInteger(window[key]) || window[key] < 0) return `${name} ${key} count is invalid`;
  }
  if (window.achieved + window.partiallyAchieved + window.notAchieved !== window.observations) {
    return `${name} outcome counts do not add up to its observations`;
  }
  if (window.observations !== window.evaluationIds.length) return `${name} observation count disagrees with its evaluation list`;
  return null;
}

// The validator the experience log runs on every stored measurement. The verdict is re-derived, so a
// line that claims `improved` over counts that did not improve is refused as damage.
export function validateMeasurementRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if (r.kind !== MEASUREMENT_KIND) return 'not an adaptation measurement';
  if (typeof r.id !== 'string' || r.id.length === 0) return 'measurement has missing or invalid id';
  if (typeof r.targetId !== 'string' || r.targetId.length === 0) return 'measurement has missing or invalid targetId';
  if (typeof r.capability !== 'string' || !/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/.test(r.capability)) return 'measurement has invalid capability';
  if (typeof r.rule !== 'string' || r.rule.length === 0 || r.rule.length > 300) return 'measurement has invalid rule text';
  if (r.activation !== null) {
    if (!r.activation || typeof r.activation !== 'object' || Array.isArray(r.activation)) return 'measurement activation is invalid';
    if (typeof r.activation.decisionId !== 'string' || r.activation.decisionId.length === 0) return 'measurement activation names no decision';
  }
  const baseline = countsProblem(r.baseline, 'baseline');
  if (baseline) return baseline;
  const followUp = countsProblem(r.followUp, 'follow-up');
  if (followUp) return followUp;
  if (!Number.isInteger(r.minObservations) || r.minObservations < MIN_MEASUREMENT_OBSERVATIONS) return 'measurement minimum observation count is invalid';
  if (!MEASUREMENT_VERDICTS.includes(r.verdict)) return 'measurement has an unknown verdict';
  const expected = compareWindows(r.baseline, r.followUp, { minObservations: r.minObservations });
  if (r.verdict !== expected) return `measurement claims ${r.verdict}, but its own counts state ${expected}`;
  if (!Array.isArray(r.limitations) || r.limitations.length === 0 || r.limitations.length > MAX_LIMITATIONS) {
    return `measurement must record between 1 and ${MAX_LIMITATIONS} limitations`;
  }
  if (r.limitations.some((text) => typeof text !== 'string' || text.length === 0 || text.length > MAX_LIMITATION_CHARS)) {
    return 'measurement limitation text is invalid';
  }
  if (typeof r.evidenceSha256 !== 'string' || r.evidenceSha256.length !== 64) return 'measurement has a missing or invalid evidence digest';
  if (r.evidenceSha256 !== measurementDigest(r)) return 'measurement digest does not match the measurement it summarises';
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return 'measurement has a bad createdAt';
  if (!r.provenance || typeof r.provenance !== 'object') return 'measurement has no provenance';
  return null;
}
