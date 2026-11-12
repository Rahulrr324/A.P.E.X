// Longitudinal outcome analysis: what a sequence of recorded predictions and their recorded
// evaluations says about one capability over time, stated only in a closed vocabulary.
//
// Batch AP-02 let one evaluated prediction propose one candidate adaptation. Batch AP-03 asks the
// next, narrower question: when several evaluations have accumulated for the same capability, does
// their recorded order support a repeated or directional statement, and which records may not be
// counted? The answer is derived here and nowhere else, at read time, from records that already
// exist. Nothing is written, no prediction or experience is created, and no model is consulted.
//
// Three rules bound what this module may say:
//   - a group is one exact capability. A parent name never absorbs a child, so `memory` records and
//     `memory.add` records are two groups; merging them would be inventing a scope the user never
//     recorded.
//   - only a current, eligible, evaluated prediction is an observation. `predictionEligibility` is
//     the same rule the AP-02 derivation uses, so a prediction withdrawn, replaced, unevaluated,
//     stale, citing a record that no longer resolves, or resting on an outcome a later record
//     corrected is excluded with the state that excluded it. Missing evidence is never counted as a
//     failure: expiry, an awaiting expectation, and an unreadable ledger are three different facts.
//   - the pattern vocabulary is fixed and each kind has one sentence of definition. The user's
//     prediction subject text is never read, parsed, or shown here; it cannot become a rule.
//
// What this module deliberately does not claim:
//   - causation. A sequence of recorded outcomes is an association in time.
//   - confidence or predictive accuracy. Calibration is computed with the existing ledger
//     methodology, reported beside the group, and never used to choose the pattern or to authorize
//     a rule. Below the existing floor of 20 scored evaluations it is reported as unavailable, not
//     as a poor or a good result.
//   - that a pattern is an instruction. A supported pattern may propose a candidate adaptation (see
//     `longitudinalProposalFor`), and that candidate is inert until the user approves it.
import { createHash } from 'node:crypto';
import { shortId } from '../util.js';
import { parseInstant } from '../experience/temporal.js';
import { decidingOutcomeOf, predictionEligibility } from '../experience/prediction-derivation.js';
import { MIN_CALIBRATION_EVALUATIONS, deriveCalibration } from './prediction-engine.js';

export const LONGITUDINAL_SCHEMA = 'apex.longitudinal.v1';
export const LONGITUDINAL_NOTE = 'a longitudinal analysis describes the order of recorded outcomes in one scope; it makes no causal claim, states no confidence, and approves nothing';

// The two counts the vocabulary is built from. They are definitions of "repeated" and "a sequence",
// not accuracy thresholds: 2 observations can repeat, and 3 are needed before an order can alternate
// or turn. Nothing about calibration's existing floor of 20 moves.
export const MIN_REPEATED_OBSERVATIONS = 2;
export const MIN_SEQUENCE_OBSERVATIONS = 3;
export const MAX_LONGITUDINAL_PREDICTIONS = 20;
export const MAX_LONGITUDINAL_GROUPS = 20;
export const MAX_LONGITUDINAL_OBSERVATIONS = 20;
export const MAX_LONGITUDINAL_EXCLUSIONS = 20;

export const LONGITUDINAL_PATTERN_KINDS = Object.freeze([
  'repeated_success',
  'repeated_failure',
  'alternating_outcomes',
  'consistent_improvement',
  'consistent_regression',
  'mixed_outcomes',
  'insufficient_evidence',
  'conflicting_evidence',
]);

// The four kinds that state a direction a candidate may carry. The other four are descriptions of
// evidence that does not support a single direction, so they propose nothing at all.
export const PROPOSAL_FIELD_BY_PATTERN = Object.freeze({
  repeated_success: 'prefer',
  repeated_failure: 'avoid',
  consistent_improvement: 'prefer',
  consistent_regression: 'avoid',
});

export const PATTERN_DEFINITIONS = Object.freeze({
  repeated_success: `every eligible, current, evaluated expectation in this scope was followed by a success outcome (at least ${MIN_REPEATED_OBSERVATIONS} observations)`,
  repeated_failure: `every eligible, current, evaluated expectation in this scope was followed by a failure outcome (at least ${MIN_REPEATED_OBSERVATIONS} observations)`,
  alternating_outcomes: `success and failure outcomes alternate strictly in recorded order, with at least ${MIN_SEQUENCE_OBSERVATIONS} observations`,
  consistent_improvement: `at least ${MIN_SEQUENCE_OBSERVATIONS} success or failure outcomes show exactly one change from failure to success and no change back`,
  consistent_regression: `at least ${MIN_SEQUENCE_OBSERVATIONS} success or failure outcomes show exactly one change from success to failure and no change back`,
  mixed_outcomes: 'the eligible outcomes include more than one class and do not form a strict alternation or a single direction',
  insufficient_evidence: `fewer than ${MIN_REPEATED_OBSERVATIONS} eligible, current, evaluated expectations exist in this scope`,
  conflicting_evidence: 'the eligible outcomes are uniform, but a record that no longer stands as current evidence records a different outcome class for the same scope',
});

export const LONGITUDINAL_LIMITATIONS = Object.freeze([
  'derived at read time from stored predictions and their recorded evaluations; nothing is persisted, repaired, or approved',
  'a repeated pattern is an association in recorded order, not evidence that the capability caused the outcome',
  'a pattern is not a forecast: no probability or confidence is stated, and calibration is reported separately',
  'records withdrawn, replaced, expired, stale, or unreadable are excluded by kind, and each exclusion states why',
  'a capability is its own group; a parent name never absorbs a child capability\'s records',
  'nothing here derives, approves, or applies a rule; a candidate still needs adaptation.derive and the user\'s explicit decision',
]);

const CLASSIFIED = new Set(['success', 'failure']);
const EXCLUSION_WORDING = Object.freeze({
  not_scopable: 'its scope is not a capability name',
  provenance_not_user: 'it was not recorded as the user\'s own expectation',
  invalidated: 'the user withdrew it, so it is not current evidence',
  superseded: 'a later expectation replaced it, so it is not current evidence',
  evaluation_missing: 'it carries no recorded evaluation',
  evaluation_stale: 'a fresh read would settle it differently than the recorded verdict',
  evidence_unavailable: 'the experience log behind its outcome could not be read',
  unresolved_citation: 'a record it cites no longer resolves in the experience log',
  outcome_evidence_not_current: 'the outcome record it rests on no longer stands',
  expired: 'its horizon passed with no recorded evaluation; expiry is not a failed outcome',
  awaiting_evaluation: 'outcome evidence exists but no evaluation was recorded',
  not_evaluated: 'no outcome inside its horizon established anything',
});

const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The state a record is excluded under, kept close to the facts rather than to the eligibility rule:
// an expired horizon and an expectation still waiting both carry no evaluation, so eligibility would
// report only "it carries no recorded evaluation". They are different facts, and neither is a failed
// outcome, so the ledger's own status names them before the rule's collapsed answer is used.
function exclusionState(projection, eligibility) {
  if (!projection.evaluation?.id) {
    if (projection.status === 'expired') return 'expired';
    if (projection.status === 'awaiting_evaluation') return 'awaiting_evaluation';
  }
  if (eligibility.state !== 'not_evaluated') return eligibility.state;
  if (projection.status === 'invalidated') return 'invalidated';
  if (projection.status === 'superseded') return 'superseded';
  return 'not_evaluated';
}

// When an outcome was recorded as happening. The deciding experience's own occurrence time is used
// when it can be read, because an evaluation may be recorded well after the outcome and ordering by
// evaluation time would misstate the sequence. Without the read, the evaluation's recording time is
// the closest fact available.
function observationAt(projection, experiencesById = null) {
  const recorded = projection?.deciding?.occurredAt;
  if (typeof recorded === 'string') return recorded;
  const decidingId = projection?.evaluation?.decidingExperienceId ?? null;
  const experience = decidingId && experiencesById ? experiencesById.get(decidingId) : null;
  if (typeof experience?.occurredAt === 'string') return experience.occurredAt;
  return projection?.evaluation?.createdAt
    ?? projection?.expiresAt
    ?? projection?.createdAt
    ?? null;
}

// The outcome class the recorded evaluation was read from. A projection of an evaluated prediction
// keeps the deciding record id but not its class, so the class is resolved exactly as the AP-02
// derivation resolves it: from a derived `deciding` when one was supplied, otherwise from the
// deciding experience in the evidence read. Without either, the class is unknown and the group is
// described as mixed rather than guessed.
function outcomeOf(projection, experiencesById = null) {
  return decidingOutcomeOf(projection, experiencesById)?.outcomeClass ?? null;
}

// The observation one eligible projection contributes. The subject is deliberately absent: it is the
// user's prose, and nothing in this analysis reads it.
function observationOf(projection, experiencesById = null) {
  return {
    predictionId: projection.id,
    evaluationId: projection.evaluation.id,
    capability: projection.capability,
    expectation: projection.expectation,
    verdict: projection.evaluation.verdict,
    outcomeClass: outcomeOf(projection, experiencesById),
    at: observationAt(projection, experiencesById),
    recordedAt: projection.evaluation.createdAt ?? null,
    evidenceIds: [...new Set(projection.evaluation.outcomeExperienceIds ?? [])],
    horizon: { since: projection.createdAt ?? null, until: projection.expiresAt ?? null },
  };
}

function alternates(sequence) {
  for (let i = 1; i < sequence.length; i += 1) if (sequence[i] === sequence[i - 1]) return false;
  return true;
}

// The one classification rule. `sequence` is the chronological success/failure sequence, and the
// pattern is chosen from the closed vocabulary only when the definitions above are met exactly.
function classify({ observations, sequence, conflict }) {
  if (conflict) return 'conflicting_evidence';
  if (observations.length < MIN_REPEATED_OBSERVATIONS) return 'insufficient_evidence';
  const classes = observations.map((o) => o.outcomeClass);
  if (classes.every((c) => c === 'success')) return 'repeated_success';
  if (classes.every((c) => c === 'failure')) return 'repeated_failure';
  // A blocked or other outcome is evidence, but the vocabulary has no repeated or directional kind
  // for it, so the group is described as mixed rather than folded into success or failure.
  if (classes.some((c) => !CLASSIFIED.has(c))) return 'mixed_outcomes';
  if (sequence.length >= MIN_SEQUENCE_OBSERVATIONS && alternates(sequence)) return 'alternating_outcomes';
  if (sequence.length >= MIN_SEQUENCE_OBSERVATIONS) {
    const switches = [];
    for (let i = 1; i < sequence.length; i += 1) {
      if (sequence[i] !== sequence[i - 1]) switches.push(`${sequence[i - 1]}->${sequence[i]}`);
    }
    if (switches.length === 1 && switches[0] === '0->1') return 'consistent_improvement';
    if (switches.length === 1 && switches[0] === '1->0') return 'consistent_regression';
  }
  return 'mixed_outcomes';
}

function patternOf(kind, observations) {
  const field = PROPOSAL_FIELD_BY_PATTERN[kind] ?? null;
  return {
    kind,
    definition: PATTERN_DEFINITIONS[kind],
    observations: observations.length,
    sufficient: field !== null,
    proposalField: field,
    confidence: null,
    confidenceReason: 'a pattern of recorded outcomes is a description, not a probability that the next outcome repeats',
    causalClaim: false,
  };
}

// Calibration is the ledger's own methodology, applied to this scope. It is reported beside the
// pattern and is never an input to it: a scope below the existing floor of 20 scored evaluations
// states "unavailable" and says why, and a scope above it states a rate the pattern still does not use.
function calibrationOf(rows, now) {
  const derived = deriveCalibration({ ledger: { projections: rows, derivedAt: now } });
  const rate = derived.matchRate;
  return {
    available: rate.value !== null,
    value: rate.value,
    numerator: rate.numerator,
    denominator: rate.denominator,
    requiredForRate: MIN_CALIBRATION_EVALUATIONS,
    reason: rate.reason,
    reliability: derived.reliability,
    confidence: { ...derived.confidence },
    usedForPattern: false,
    note: 'calibration counts the live scored evaluations in this scope; it does not decide the pattern and does not authorize a rule',
  };
}

function groupOf(capability, rows, now, experiencesById) {
  const eligible = [];
  const exclusions = [];
  for (const projection of rows) {
    const eligibility = predictionEligibility({ projection, experiencesById });
    if (eligibility.eligible) {
      eligible.push(observationOf(projection, experiencesById));
      continue;
    }
    const state = exclusionState(projection, eligibility);
    // An expired or awaiting record is named by its own wording: the eligibility rule's sentence would
    // say only that no evaluation exists, which is true but hides whether the horizon passed or is
    // still open. Every other state keeps the rule's own reason.
    const ownWording = state === 'expired' || state === 'awaiting_evaluation' || state === 'not_evaluated';
    exclusions.push({
      predictionId: projection.id,
      state,
      status: projection.status ?? null,
      reason: ownWording
        ? (EXCLUSION_WORDING[state] ?? EXCLUSION_WORDING.not_evaluated)
        : (eligibility.reason ?? EXCLUSION_WORDING[state] ?? 'it is not current evidence'),
      evaluated: Boolean(projection.evaluation?.id),
      verdict: projection.evaluation?.verdict ?? null,
      outcomeClass: outcomeOf(projection, experiencesById),
      at: observationAt(projection, experiencesById),
    });
  }
  // Chronological order is the observation order, with the record id breaking exact ties so two
  // reads of the same log always produce the same analysis.
  eligible.sort((a, b) => {
    const at = parseInstant(a.at);
    const bt = parseInstant(b.at);
    if (at !== null && bt !== null && at !== bt) return at - bt;
    return a.predictionId < b.predictionId ? -1 : a.predictionId > b.predictionId ? 1 : 0;
  });

  const classes = eligible.map((o) => o.outcomeClass);
  const uniform = eligible.length >= MIN_REPEATED_OBSERVATIONS && classes.every((c) => c === classes[0]);
  // A record that no longer stands but records a different outcome class is a disagreement the reader
  // has to see. The current set is not silently preferred: the pattern is withheld instead.
  const conflict = uniform && exclusions.some((e) => e.evaluated
    && typeof e.outcomeClass === 'string' && e.outcomeClass !== classes[0]);
  const sequence = classes.filter((c) => CLASSIFIED.has(c)).map((c) => (c === 'success' ? 1 : 0));
  const kind = classify({ observations: eligible, sequence, conflict });

  const totals = {
    recorded: rows.length,
    evaluated: rows.filter((r) => Boolean(r.evaluation?.id)).length,
    eligibleScored: eligible.length,
    excluded: exclusions.length,
    excludedEvaluated: exclusions.filter((e) => e.evaluated).length,
    success: classes.filter((c) => c === 'success').length,
    failure: classes.filter((c) => c === 'failure').length,
    blocked: classes.filter((c) => c === 'blocked').length,
    other: classes.filter((c) => c !== 'success' && c !== 'failure' && c !== 'blocked').length,
  };
  const byExclusionState = {};
  for (const exclusion of exclusions) byExclusionState[exclusion.state] = (byExclusionState[exclusion.state] ?? 0) + 1;

  const times = eligible.map((o) => parseInstant(o.at)).filter((ms) => ms !== null);
  const window = times.length === 0
    ? null
    : { since: new Date(Math.min(...times)).toISOString(), until: new Date(Math.max(...times)).toISOString() };

  const shown = eligible.slice(0, MAX_LONGITUDINAL_OBSERVATIONS);
  const predictionIds = [...new Set(shown.map((o) => o.predictionId))];
  const evaluationIds = [...new Set(shown.map((o) => o.evaluationId))];
  const experienceIds = [...new Set(shown.flatMap((o) => o.evidenceIds))];
  return {
    capability,
    pattern: patternOf(kind, eligible),
    window,
    counts: { ...totals, byExclusionState },
    // Every reference used, in the same chronological order the pattern was read in. The bounds are
    // stated rather than silently applied.
    evidenceRefs: {
      predictionIds,
      evaluationIds,
      experienceIds,
      truncated: eligible.length > shown.length
        || predictionIds.length > MAX_LONGITUDINAL_OBSERVATIONS
        || experienceIds.length > MAX_LONGITUDINAL_OBSERVATIONS,
    },
    observations: shown.map((o) => ({
      predictionId: o.predictionId,
      evaluationId: o.evaluationId,
      verdict: o.verdict,
      outcomeClass: o.outcomeClass,
      at: o.at,
      evidenceIds: o.evidenceIds.slice(0, MAX_LONGITUDINAL_OBSERVATIONS),
      horizon: o.horizon,
    })),
    observationsTruncated: eligible.length > shown.length,
    exclusions: exclusions.slice(0, MAX_LONGITUDINAL_EXCLUSIONS),
    exclusionsTruncated: exclusions.length > MAX_LONGITUDINAL_EXCLUSIONS,
    calibration: calibrationOf(rows, now),
    limitations: [...LONGITUDINAL_LIMITATIONS],
    authorizes: false,
  };
}

// The whole analysis. `projections` are the ledgers's projected predictions, already carrying their
// evaluation and derived lineage; `readTotal` and `readTruncated` describe how the caller bounded the
// read, so a group built from a truncated ledger says so.
export function analyzeLongitudinal({
  projections = [], experiencesById = null, capability = null,
  readTotal = null, readTruncated = false, now = null, evidenceRead = null,
} = {}) {
  const scoped = [];
  const duplicates = [];
  const seen = new Set();
  for (const projection of projections ?? []) {
    if (!projection || typeof projection.id !== 'string') continue;
    if (capability !== null && projection.capability !== capability) continue;
    if (seen.has(projection.id)) {
      duplicates.push(projection.id);
      continue;
    }
    seen.add(projection.id);
    scoped.push(projection);
  }

  const byCapability = new Map();
  for (const projection of scoped) {
    const key = projection.capability ?? 'none';
    const rows = byCapability.get(key) ?? [];
    rows.push(projection);
    byCapability.set(key, rows);
  }
  const groups = [...byCapability.keys()]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_LONGITUDINAL_GROUPS)
    .map((name) => groupOf(name, byCapability.get(name), now, experiencesById));

  const byPattern = {};
  for (const group of groups) byPattern[group.pattern.kind] = (byPattern[group.pattern.kind] ?? 0) + 1;
  const totals = {
    groups: byCapability.size,
    recorded: scoped.length,
    evaluated: scoped.filter((p) => Boolean(p.evaluation?.id)).length,
    eligibleScored: groups.reduce((sum, g) => sum + g.counts.eligibleScored, 0),
    excluded: groups.reduce((sum, g) => sum + g.counts.excluded, 0),
    byPattern,
  };
  const digest = digestOf(groups.map((g) => [
    g.capability,
    g.pattern.kind,
    g.evidenceRefs.predictionIds,
    g.evidenceRefs.experienceIds,
  ]));
  return {
    schema: LONGITUDINAL_SCHEMA,
    note: LONGITUDINAL_NOTE,
    at: now ?? null,
    read: {
      considered: scoped.length,
      total: readTotal ?? scoped.length,
      truncated: readTruncated === true,
      limit: MAX_LONGITUDINAL_PREDICTIONS,
      duplicateReferences: [...new Set(duplicates)],
      // What the caller read of the experience log to judge whether each cited outcome still stands.
      // `null` means no read was supplied, which is reported as an absence rather than as "all current".
      outcomeEvidence: evidenceRead ?? {
        available: null,
        resolved: 0,
        unresolved: [],
        reason: 'no experience read was supplied, so outcome currentness was judged from the ledger projection alone',
      },
    },
    groups,
    groupsTruncated: byCapability.size > MAX_LONGITUDINAL_GROUPS,
    totals,
    limitations: [...LONGITUDINAL_LIMITATIONS],
    authorizes: false,
    digest,
  };
}

// ---- candidate proposal ------------------------------------------------------

// The rule text a supported pattern states, and only that text. It names the pattern, the number of
// observations, and the outcome class or direction it was read from; it never restates a prediction's
// subject, because that sentence is not what the analysis read.
export function longitudinalRule(capability, kind, observations) {
  if (kind === 'repeated_success') {
    return `prefer work that names ${capability}: ${observations} recorded outcomes in this scope were each a success`;
  }
  if (kind === 'repeated_failure') {
    return `avoid work that names ${capability}: ${observations} recorded outcomes in this scope were each a failure`;
  }
  if (kind === 'consistent_improvement') {
    return `prefer work that names ${capability}: ${observations} recorded outcomes in this scope moved from failure to success without a reversal`;
  }
  if (kind === 'consistent_regression') {
    return `avoid work that names ${capability}: ${observations} recorded outcomes in this scope moved from success to failure without a reversal`;
  }
  return null;
}

// A stable identity for a longitudinal proposal: the scope, the pattern, and every observation's
// prediction, evaluation, verdict and class, plus the outcome records cited. Changing any of those is
// a change to the evidence, and the digest is what a later read recomputes.
export function longitudinalEvidenceDigest({ capability, kind, verdicts, outcomeExperienceIds }) {
  return digestOf({
    capability,
    kind,
    verdicts: verdicts.map((v) => [v.predictionId, v.evaluationId, v.verdict, v.outcomeClass]),
    outcomeExperienceIds: [...outcomeExperienceIds],
  });
}

// The typed proposal one supported group states. `null` for every pattern that does not name a
// direction, so a caller cannot build an executable-looking rule from mixed or insufficient evidence.
export function longitudinalProposalFor(group) {
  if (!group || !group.pattern?.sufficient) return null;
  const field = group.pattern.proposalField;
  if (field !== 'prefer' && field !== 'avoid') return null;
  const capability = group.capability;
  const verdicts = group.observations.map((o) => ({
    predictionId: o.predictionId,
    evaluationId: o.evaluationId,
    capability,
    verdict: o.verdict,
    outcomeClass: o.outcomeClass,
  }));
  const experienceIds = [...new Set(group.observations.flatMap((o) => o.evidenceIds))];
  return {
    type: 'repeated_outcome_pattern',
    dimension: 'approved_adaptation_fit',
    pattern: {
      kind: group.pattern.kind,
      // The count is the number of observations the candidate actually cites, which is the bounded
      // slice above; the group's own `counts.eligibleScored` still states the full count.
      observations: verdicts.length,
      definition: group.pattern.definition,
      window: group.window ? { ...group.window } : null,
      calibration: {
        available: group.calibration.available,
        denominator: group.calibration.denominator,
        requiredForRate: group.calibration.requiredForRate,
      },
    },
    verdicts,
    guidance: {
      order: null,
      avoid: field === 'avoid' ? [capability] : [],
      prefer: field === 'prefer' ? [capability] : [],
      maxSteps: null,
    },
    limitations: [
      'a repeated pattern of recorded outcomes is an association in time, not evidence that the capability caused the outcome',
      'the pattern describes the recorded order only; it is not a forecast that the next outcome repeats',
      'the candidate is inert until you approve it, and then it only re-orders approaches in a comparison',
      'calibration is reported beside this rule and was not used to choose or strengthen it',
    ],
    evidenceDigest: longitudinalEvidenceDigest({
      capability,
      kind: group.pattern.kind,
      verdicts,
      outcomeExperienceIds: experienceIds,
    }),
  };
}

// ---- rendering ---------------------------------------------------------------

function refList(ids) {
  return ids.length === 0 ? 'none' : ids.map(shortId).join(', ');
}

export function renderLongitudinal(report) {
  const lines = [
    'Longitudinal outcome analysis (read-only; derived from recorded predictions and evaluations; nothing is approved or applied)',
    `  records considered: ${report.read.considered} of ${report.read.total} prediction record(s)${report.read.truncated ? ' (bounded read; older records were not inspected)' : ''}`,
  ];
  const outcomeEvidence = report.read.outcomeEvidence;
  if (outcomeEvidence && outcomeEvidence.available === false) {
    lines.push(`  outcome evidence: could not be read - ${outcomeEvidence.reason}; currentness was judged from the ledger projection alone`);
  } else if (outcomeEvidence && (outcomeEvidence.unresolved ?? []).length > 0) {
    lines.push(`  outcome evidence: ${outcomeEvidence.unresolved.length} cited record(s) did not resolve in the experience log and were excluded`);
  }
  for (const group of report.groups) {
    const pattern = group.pattern;
    lines.push(
      '',
      `  scope ${group.capability}`,
      `    pattern:        ${pattern.kind}${pattern.sufficient ? '' : ' (proposes nothing)'}`,
      `    definition:     ${pattern.definition}`,
      `    observations:   ${group.counts.eligibleScored} eligible scored of ${group.counts.recorded} recorded`
        + `${group.counts.excluded ? `; ${group.counts.excluded} excluded` : ''}`,
      `    outcomes:       success ${group.counts.success}, failure ${group.counts.failure}, blocked ${group.counts.blocked}, other ${group.counts.other}`,
      `    window:         ${group.window ? `${group.window.since} .. ${group.window.until}` : 'no dated observation'}`,
      `    evidence:       predictions ${refList(group.evidenceRefs.predictionIds)}`
        + ` | evaluations ${refList(group.evidenceRefs.evaluationIds)}`
        + ` | experiences ${refList(group.evidenceRefs.experienceIds)}`,
    );
    if (group.exclusions.length > 0) {
      lines.push(`    excluded:       ${group.exclusions.map((e) => `${shortId(e.predictionId)} ${e.state}`).join('; ')}${group.exclusionsTruncated ? ' (truncated)' : ''}`);
      for (const exclusion of group.exclusions.slice(0, 5)) {
        lines.push(`      ${shortId(exclusion.predictionId)}: ${exclusion.reason}`);
      }
    }
    lines.push(
      `    calibration:    ${group.calibration.available
        ? `${group.calibration.value} over ${group.calibration.denominator} scored evaluation(s)`
        : 'unavailable'}${group.calibration.available ? '' : ` - ${group.calibration.reason}`}`,
      '    not a cause; not a confidence; not an instruction',
    );
  }
  lines.push(
    '',
    'A supported pattern can only be proposed as a candidate by adaptation.derive, and that candidate changes nothing until you approve it.',
  );
  return lines.join('\n');
}
