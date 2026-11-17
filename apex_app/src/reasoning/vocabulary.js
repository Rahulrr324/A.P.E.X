// Closed vocabulary for T-13. A reasoning session describes evidence and possible readings; it is
// not a permission, an action, or a probability model.
export const REASONING_SCHEMA = 'apex.reasoning/1';

export const BOUNDS = Object.freeze({
  maxRequestChars: 2000,
  maxEvidence: 40,
  maxEvidencePerSource: 8,
  maxHypotheses: 6,
  maxEvidencePerHypothesis: 12,
  maxSteps: 120,
  maxDepth: 12,
  maxSessions: 200,
  maxTraceSteps: 24,
  maxReasonChars: 500,
  maxStatementChars: 400,
  maxEvidenceClaimChars: 500,
});

export const Trust = Object.freeze({
  USER_STATEMENT: 'user_statement',
  USER_CONFIRMED: 'user_confirmed',
  USER_OBJECTIVE: 'user_objective',
  AUTHORIZED_DOCUMENT: 'authorized_document',
  EXTERNAL_OBSERVATION: 'external_observation',
  WORLD_MODEL: 'world_model',
  OPERATIONAL_RECORD: 'operational_record',
  OUTCOME: 'outcome',
  EXPECTATION: 'expectation',
  DERIVED: 'derived',
  MODEL_UNVERIFIED: 'model_unverified',
  CANDIDATE: 'source_derived_candidate',
  UNKNOWN: 'unknown',
});

export const TRUST_LABELS = Object.freeze(Object.values(Trust));

// Whether a trust class may support a settled conclusion on its own. A candidate is deliberately
// absent: extraction may inform a reading but can never become confirmed knowledge here. An external
// observation or an authorized document can support a cited statement, but not silently become a
// user-confirmed fact.
export const SETTLING_TRUST = Object.freeze(new Set([
  Trust.USER_STATEMENT,
  Trust.USER_CONFIRMED,
  Trust.USER_OBJECTIVE,
  Trust.AUTHORIZED_DOCUMENT,
  Trust.WORLD_MODEL,
  Trust.OPERATIONAL_RECORD,
  Trust.OUTCOME,
]));

export const EvidenceRelation = Object.freeze({
  SUPPORTING: 'supporting',
  CONTRADICTING: 'contradicting',
  CONTEXTUAL: 'contextual',
  HISTORICAL: 'historical',
  UNKNOWN: 'unknown',
});

export const RELATIONS = Object.freeze(Object.values(EvidenceRelation));

export const TimeState = Object.freeze({
  CURRENT: 'current',
  HISTORICAL: 'historical',
  FUTURE: 'not_yet_valid',
  EXPIRED: 'expired',
  UNKNOWN: 'unknown',
});

export const ConclusionClass = Object.freeze({
  DIRECTLY_SUPPORTED: 'directly_supported',
  STRONGLY_SUPPORTED: 'strongly_supported',
  TENTATIVE: 'tentative',
  CONFLICTING: 'conflicting',
  UNSUPPORTED: 'unsupported',
  UNKNOWN: 'unknown',
});

export const CONCLUSION_CLASSES = Object.freeze(Object.values(ConclusionClass));

export const HypothesisStatus = Object.freeze({
  PREFERRED: 'preferred',
  UNRESOLVED: 'unresolved',
  REJECTED: 'rejected',
});

export const DecisionKind = Object.freeze({
  ANSWER: 'answer',
  CLARIFY: 'clarify',
  GATHER_EVIDENCE: 'gather_evidence',
  COMPLETE_PREREQUISITE: 'complete_prerequisite',
  REVIEW_OUTDATED: 'review_outdated',
  NO_ACTION: 'no_action',
});

export const ORIGIN_NOTE = 'a reasoning conclusion is data and grants no authorization; every action is still authorized by the action registry';

// A deterministic source priority for display only. It never settles a conflict.
export const SOURCE_ORDER = Object.freeze([
  'user_instruction', 'memory', 'knowledge', 'document', 'document_history',
  'external_observation', 'world_fact', 'world_relationship', 'world_event',
  'world_entity', 'world_conflict', 'goal', 'plan', 'task', 'experience',
  'prediction', 'temporal', 'adaptation', 'feedback', 'conversation', 'audit',
]);

export function sourceOrder(source) {
  const index = SOURCE_ORDER.indexOf(source);
  return index >= 0 ? index : 50;
}

export function isConclusionClass(value) {
  return CONCLUSION_CLASSES.includes(value);
}
