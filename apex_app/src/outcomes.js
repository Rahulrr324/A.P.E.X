// Outcome vocabulary. A result is reported as verified success ONLY when the
// independent verifier confirms the postcondition (SUCCESS_VERIFIED).
export const OPERATION_SCHEMA = 1;

export const Outcome = Object.freeze({
  SUCCESS_VERIFIED: 'success_verified',
  EXECUTION_FAILED: 'execution_failed',
  VERIFICATION_FAILED: 'verification_failed',
  VERIFICATION_UNAVAILABLE: 'verification_unavailable',
  AUDIT_INTEGRITY_FAILED: 'audit_integrity_failed',
  ACTION_DENIED: 'action_denied',
  INPUT_REJECTED: 'input_rejected',
  CLARIFICATION_REQUIRED: 'clarification_required', // the request is missing information needed to proceed
  MODEL_UNAVAILABLE: 'model_unavailable',
  PLAN_CREATED: 'plan_created', // a validated deterministic task plan was stored
  PLAN_PROPOSED: 'plan_proposed', // a validated model plan was stored; waits for user approval
  PLAN_REJECTED: 'plan_rejected', // a plan failed validation; nothing was stored
  TASK_PAUSED: 'task_paused', // stopped for an explicit user decision
  TASK_CANCELLED: 'task_cancelled',
});

export const OUTCOME_VALUES = new Set(Object.values(Outcome));
