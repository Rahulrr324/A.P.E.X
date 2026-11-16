// The closed vocabulary of T-08 outcome learning.
//
// Everything this package says is derived from records that already exist (audit operations,
// experiences, feedback, plans, goals, tasks, predictions) plus three new append-only record kinds
// written into the experience log:
//
//   outcome_evaluation     one plan run judged against its objective and recorded criteria
//   adaptation_measurement the before/after reading of one authorised adaptation
//   adaptation_rollback    the user's deactivation of an adaptation a measurement showed regressing
//
// The words below are the only answers a reader may give. Nothing here is a score, a probability,
// or a claim of causation, and no threshold is a fitted parameter: each is the smallest count at
// which the statement it enables can be contradicted by the evidence it looks at.
export const EVALUATION_KIND = 'outcome_evaluation';
export const MEASUREMENT_KIND = 'adaptation_measurement';
export const ROLLBACK_KIND = 'adaptation_rollback';

// How one run is classified. `indeterminate` is not a failure and not a success: it is APEX saying
// the records do not settle the question.
export const CLASSIFICATIONS = Object.freeze([
  'achieved',
  'partially_achieved',
  'not_achieved',
  'indeterminate',
]);

// Confidence is a closed grade, never a number. It is decided by which evidence is present, not by
// how strongly the evidence points one way.
export const CONFIDENCES = Object.freeze(['high', 'moderate', 'low']);

// One criterion's state in an evaluation. `unverified` is the honest answer when the goal store
// records neither support nor contradiction.
export const CRITERION_STATES = Object.freeze(['met', 'not_met', 'unverified']);

// A capability's own outcome inside one evaluation. `not_run` is recorded separately from a skip:
// a step that never had an outcome is not the same thing as one that was deliberately skipped.
export const CAPABILITY_OUTCOMES = Object.freeze(['success', 'failure', 'partial', 'not_run']);

// The verdict of a before/after measurement. `insufficient_evidence` is a real answer and is never
// rounded up to `no_change`.
export const MEASUREMENT_VERDICTS = Object.freeze([
  'improved',
  'no_change',
  'regressed',
  'insufficient_evidence',
]);

// The governed lifecycle, printed from the records that exist. `proposed` and `evaluated` are
// separated because a candidate whose risk and validation were never written down is a different
// thing from one that carries a bounded proposal.
export const LIFECYCLE_STAGES = Object.freeze([
  'proposed',
  'evaluated',
  'authorized',
  'active',
  'measured',
  'retained',
  'rolled_back',
  'rejected',
  'retired',
  'ambiguous',
]);

// ---- thresholds -------------------------------------------------------------
// Each threshold is stated with the reason it is that number, so a reader can disagree with the
// rule instead of discovering it in the output.

// Repetition needs at least three observations: two is a coincidence and a contradiction, not a
// pattern. Three is also the smallest count that can survive one contradicting observation and
// still repeat.
export const MIN_PATTERN_OBSERVATIONS = 3;
// A failure pattern is allowed to form from two failures because a repeated failure is itself the
// thing worth noticing, but it is only proposed when the failures are not outnumbered by successes.
export const MIN_FAILURE_OBSERVATIONS = 2;
// Two corrective feedback records on the same capability are the smallest evidence that a
// correction is a habit rather than a single disagreement.
export const MIN_CORRECTION_OBSERVATIONS = 2;
// A measurement compares two windows. Two determinate outcomes on each side is the smallest
// comparison that is not a single event read twice; below it the verdict is
// `insufficient_evidence` rather than a guess.
export const MIN_MEASUREMENT_OBSERVATIONS = 2;
// An ordering pattern needs two successes that preserved the order and two failures that reversed
// it, so the claim rests on both sides.
export const MIN_ORDER_OBSERVATIONS = 2;

// ---- bounds -----------------------------------------------------------------
export const MAX_OBJECTIVE_CHARS = 300;
export const MAX_CRITERIA = 8;
export const MAX_CAPABILITIES = 8;
export const MAX_STEP_DETAIL = 40;
export const MAX_EVIDENCE_REFS = 40;
export const MAX_LIMITATIONS = 7;
export const MAX_LIMITATION_CHARS = 300;
export const MAX_RULE_CHARS = 300;
export const MAX_EVALUATIONS = 40;
export const MAX_PATTERNS = 24;
export const MAX_PATTERN_SUPPORT = 20;
export const MAX_RISKS = 4;
export const MAX_RISK_CHARS = 220;

// The derivation method and proposal type this package adds to the adaptation record. They are
// separate from `repeated_outcome_pattern` (AP-03's prediction-ledger pattern) so a reader can
// always tell which ledger a rule came from.
export const OBSERVED_OUTCOME_METHOD = 'recorded_outcome_evidence';
export const OBSERVED_OUTCOME_PROPOSAL_TYPE = 'recorded_outcome_evidence';
// The one ranked dimension an outcome-derived rule may feed. It is the same dimension AP-01 built;
// no second ordering rule is introduced here.
export const OUTCOME_DECISION_DIMENSION = 'approved_adaptation_fit';

export const PATTERN_DEFINITIONS = Object.freeze({
  repeated_success: 'the same capability completed every recorded step it appeared in, in at least three recorded outcomes',
  repeated_failure: 'the same capability failed a recorded step in at least two recorded outcomes, and the failures are not outnumbered by successes',
  correction_hotspot: 'the user corrected at least two recorded outcomes of the same capability',
  inefficient_execution: 'a capability appeared only in failed runs of an objective that succeeded without it',
  ordering_dependency: 'outcomes succeeded when one capability ran before another and failed when the order was reversed',
  condition_association: 'a recorded condition (the number of steps in the run) is associated with a different success count for one capability',
});

// Which pattern kinds may become a proposal, and which are reported only. `condition_association`
// is deliberately not proposable: acting on a correlated condition would turn an association into a
// causal claim the records do not support. `correction_hotspot` is reported for the same kind of
// reason from the other side: a correction is the user's judgement in their own words, so the rule it
// implies is written by the user (`feedback.record` guidance), never paraphrased from a count.
export const PROPOSABLE_PATTERNS = Object.freeze([
  'repeated_success', 'repeated_failure', 'inefficient_execution', 'ordering_dependency',
]);

export const PATTERN_LIMITATIONS = Object.freeze([
  'a pattern is a count over recorded outcomes. It is not a cause, a probability, or a forecast.',
  'recorded experience is limited to what APEX actually ran and the plan store recorded; an unrecorded attempt cannot appear here.',
]);
