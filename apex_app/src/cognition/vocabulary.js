// Vocabulary shared by the cognitive layer.
//
// The cognition layer coordinates the existing stores; it does not own one. Everything here is a
// fixed, documented label used in an audit record or in a structured response, so a later reader can
// tell an intent from an outcome and an inference from a recorded fact.

export const COGNITION_SCHEMA = 1;

export const Intent = Object.freeze({
  GENERAL_QUESTION: 'general_question',
  STORED_INFORMATION: 'stored_information_question',
  WORLD_MODEL: 'world_model_question',
  HISTORICAL: 'historical_question',
  COMPARISON: 'comparison',
  EXPLANATION: 'explanation',
  GOAL_CREATION: 'goal_creation',
  GOAL_PROGRESS: 'goal_progress',
  PLANNING: 'planning',
  PLAN_REVIEW: 'plan_review',
  NEXT_STEP: 'next_step',
  TASK_EXECUTION: 'task_execution',
  CLARIFICATION: 'clarification',
  FEEDBACK: 'feedback',
  UNSUPPORTED: 'unsupported',
  AMBIGUOUS: 'ambiguous',
});

// Intent classification is a description of the request, never a permission. Every result carries
// `authorization.granted === false` so no caller can mistake a category for an approval.
export const INTENT_NOTE = 'intent classification describes the request and grants no authorization; every action is still authorized by the action registry';

export const EvidenceSource = Object.freeze({
  MEMORY: 'memory',
  KNOWLEDGE: 'knowledge',
  EXPERIENCE: 'experience',
  FEEDBACK: 'feedback',
  ADAPTATION: 'adaptation',
  TEMPORAL: 'temporal',
  PREDICTION: 'prediction',
  WORLD_ENTITY: 'world_entity',
  WORLD_FACT: 'world_fact',
  WORLD_RELATIONSHIP: 'world_relationship',
  WORLD_EVENT: 'world_event',
  WORLD_CONFLICT: 'world_conflict',
  GOAL: 'goal',
  PLAN: 'plan',
  TASK: 'task',
  CONVERSATION: 'conversation',
  USER_INSTRUCTION: 'user_instruction',
  AUDIT: 'audit',
});

// Source status separates "nothing is recorded" from "the store could not be read". A damaged source
// is reported with the same vocabulary as an unavailable one but keeps its own label so the
// disclosure can name what happened.
export const SourceStatus = Object.freeze({
  OK: 'ok',
  EMPTY: 'empty',
  UNAVAILABLE: 'unavailable',
  DAMAGED: 'damaged',
  SKIPPED: 'skipped',
});

// Claim kinds. A claim is a statement copied from a record, or a conclusion the deterministic
// deliberation drew from copied statements. The layer never turns an inference into a fact.
export const ClaimKind = Object.freeze({
  SUPPORTED: 'supported',
  CONTRADICTED: 'contradicted',
  PARTIALLY_SUPPORTED: 'partially_supported',
  HISTORICAL: 'historical',
  INFERENCE: 'inference',
  ASSUMPTION: 'assumption',
  UNKNOWN: 'unknown',
  RECOMMENDATION: 'recommendation',
  EXPECTATION: 'expectation',
  RULE: 'rule',
  OBSERVATION: 'observation',
  GOAL_STATE: 'goal_state',
  PLAN_STATE: 'plan_state',
  TASK_STATE: 'task_state',
  STATEMENT: 'statement',
});

export const CLAIM_KINDS = Object.freeze(Object.values(ClaimKind));

// The evidence state says what the records behind one claim can actually carry. It is derived from
// the claim kind, the record's validity, and the conflict links, and it never replaces the claim
// kind: a supported claim whose record is contested is conflicting evidence, not a verified fact.
export const EvidenceState = Object.freeze({
  DIRECTLY_SUPPORTED: 'directly_supported',
  PARTIALLY_SUPPORTED: 'partially_supported',
  CONFLICTING: 'conflicting',
  UNVERIFIED: 'unverified',
  UNSUPPORTED: 'unsupported',
  TEMPORALLY_STALE: 'temporally_stale',
});

export const EVIDENCE_STATES = Object.freeze(Object.values(EvidenceState));

// Uncertainty categories are qualitative and rule-derived. There is deliberately no numeric
// confidence field anywhere in this layer: a percentage would imply a calibration this system does
// not have, and a prediction ledger score is never a probability that a stored claim is true.
export const Uncertainty = Object.freeze({
  STRONGLY_SUPPORTED: 'strongly_supported',
  SUPPORTED_INCOMPLETE: 'supported_but_incomplete',
  CONFLICTING: 'conflicting',
  WEAKLY_SUPPORTED: 'weakly_supported',
  INFERRED: 'inferred',
  ASSUMED: 'assumed',
  UNKNOWN: 'unknown',
  OUTDATED: 'outdated',
  UNVERIFIABLE: 'unverifiable',
});

// What the uncertainty is about: the truth of a claim, whether the evidence is current, which entity
// a reference means, whether an inference follows, or whether an action succeeded.
export const UncertaintyAbout = Object.freeze({
  FACT: 'fact_truth',
  CURRENCY: 'evidence_currency',
  IDENTITY: 'entity_identity',
  INFERENCE: 'inference_validity',
  ACTION: 'action_success',
});

export const DecisionKind = Object.freeze({
  ANSWER: 'answer',
  CLARIFY: 'clarify',
  PROPOSE_ACTION: 'propose_action',
  REFUSE: 'refuse',
  DECLINE: 'decline',
});

export const DECISION_KINDS = Object.freeze(Object.values(DecisionKind));

export const MissingInfo = Object.freeze({
  ENTITY: 'missing_entity',
  AMBIGUOUS_REFERENCE: 'ambiguous_reference',
  TIME_RANGE: 'missing_time_range',
  CONFLICTING_REQUIREMENTS: 'conflicting_requirements',
  GOAL_CRITERIA: 'missing_goal_success_criteria',
  PLAN_STEP: 'unsupported_plan_step',
  ACTION_PARAMETER: 'missing_action_parameter',
  INTENT: 'ambiguous_intent',
  TOPIC: 'missing_topic',
});

// Disclosure codes travel with an answer or an audit record. They are fixed strings so a caller can
// translate them without parsing prose.
export const Disclosure = Object.freeze({
  NO_EVIDENCE: 'no_evidence_found',
  SOURCE_UNAVAILABLE: 'source_unavailable',
  SOURCE_DAMAGED: 'source_damaged',
  CONFLICT_UNRESOLVED: 'conflict_unresolved',
  EVIDENCE_HISTORICAL: 'evidence_historical',
  EVIDENCE_UNKNOWN_VALIDITY: 'evidence_validity_unknown',
  EXPECTATION_NOT_FACT: 'expectation_is_not_a_fact',
  INFERENCE_MARKED: 'inference_marked',
  ASSUMPTION_STATED: 'assumption_stated',
  CLARIFICATION_REQUIRED: 'clarification_required',
  CONTEXT_TRUNCATED: 'context_truncated',
  MODEL_OUTPUT_UNVERIFIED: 'model_output_unverified',
  MODEL_STRUCTURE_REJECTED: 'model_structure_rejected',
  RECOMMENDATION_NOT_EXECUTED: 'recommendation_not_executed',
});

// Bounds for every stage. They are exported so tests and the audit can cite the same numbers the
// implementation used.
export const BOUNDS = Object.freeze({
  maxEvidenceTotal: 36,
  maxEvidencePerSource: 6,
  maxClaimChars: 400,
  maxClaimText: 500,
  maxClaims: 24,
  maxSubquestions: 8,
  maxAssumptions: 6,
  maxInterpretations: 3,
  maxContextLines: 14,
  maxContextChars: 1400,
  maxTraceStages: 16,
  maxTraceEvidence: 64,
  maxTraceNotes: 16,
  maxStructuredClaims: 12,
});

// Deterministic ordering for sources: user instructions first, then the stores closest to an
// answer, then derived views, then conversation. Ties inside a source are broken by record id.
export const SOURCE_RANK = Object.freeze({
  [EvidenceSource.USER_INSTRUCTION]: 0,
  [EvidenceSource.WORLD_CONFLICT]: 1,
  [EvidenceSource.WORLD_FACT]: 2,
  [EvidenceSource.WORLD_RELATIONSHIP]: 3,
  [EvidenceSource.WORLD_EVENT]: 4,
  [EvidenceSource.WORLD_ENTITY]: 5,
  [EvidenceSource.KNOWLEDGE]: 6,
  [EvidenceSource.MEMORY]: 7,
  [EvidenceSource.EXPERIENCE]: 8,
  [EvidenceSource.FEEDBACK]: 9,
  [EvidenceSource.ADAPTATION]: 10,
  [EvidenceSource.GOAL]: 11,
  [EvidenceSource.PLAN]: 12,
  [EvidenceSource.TASK]: 13,
  [EvidenceSource.TEMPORAL]: 14,
  [EvidenceSource.PREDICTION]: 15,
  [EvidenceSource.AUDIT]: 16,
  [EvidenceSource.CONVERSATION]: 17,
});

export function sourceRank(source) {
  return SOURCE_RANK[source] ?? 50;
}
