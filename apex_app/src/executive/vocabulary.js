// Executive vocabulary: the fixed words the bridge between understanding and execution uses.
//
// APEX already had the parts - a router, an action registry, a plan store, a task runner, an audit
// log, a continuation engine - but nothing read a user's request and turned it into a plan record
// whose approval the user could see before it ran. This layer is that bridge and nothing more. It
// owns no store, registers no action, and grants no permission: every step it proposes is resolved
// against the existing registry, stored through the existing `plan.add` action, approved through the
// existing `plan.approve` action, and run by the existing TaskRunner with per-step authorization.
//
// Everything here is a documented label rather than prose, so a later reader can tell what a state
// word means and which record it was read from. Nothing in this file may be used as authorization.
import { PlanStatus } from '../plans/model.js';
import { StepStatus } from '../tasks/model.js';

export const EXECUTIVE_SCHEMA = 1;

// What the bridge decided the user is asking for. These are descriptions of a request, never
// permissions: `approve` and `execute` name the class of user act required, and the registry still
// decides whether the underlying action runs.
export const RequestMode = Object.freeze({
  INFORMATIONAL: 'informational',   // asks what APEX knows: stays on the ordinary answer path
  RECOMMENDATION: 'recommendation',  // asks what the user should do: advice, no work proposed
  STATUS: 'status',                  // asks what APEX's own records say about open work
  PREPARE: 'prepare',                // asks APEX to record an intended course of action
  REPLAN: 'replan',                  // asks for a revised approach to a plan already recorded
  APPROVE: 'approve',                // the user authorizes a plan they have already seen
  EXECUTE: 'execute',                // the user starts a plan that is already approved
  APPROVAL_REQUIRED: 'approval_required', // work was asked for that has no approval yet
  CLARIFY: 'clarify',                // the request cannot be resolved against the records
  UNSUPPORTED: 'unsupported',        // no registered capability could carry out any part of it
  REFUSE: 'refuse',                  // a registered policy refused it
});

export const MODE_NOTE = 'the request mode describes what was asked and grants nothing; every action is authorized by the action registry when it runs';

// The ten states APEX may report about work in progress. Each one names the record it can be read
// from: a state that no record supports is not reported at all, which is how this vocabulary keeps
// a proposed step from being described as a completed one.
export const ExecutionState = Object.freeze({
  SUGGESTED: 'suggested',
  PREPARED: 'prepared',
  AWAITING_APPROVAL: 'awaiting_approval',
  APPROVED: 'approved',
  RUNNING: 'running',
  VERIFIED: 'verified',
  PARTIALLY_COMPLETED: 'partially_completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  UNCERTAIN: 'uncertain',
});

export const EXECUTION_STATES = Object.freeze(Object.values(ExecutionState));

// Which record proves which state. The bridge prints this with the state it reports, so a reader can
// check the claim instead of taking the word for it.
export const STATE_EVIDENCE = Object.freeze({
  [ExecutionState.SUGGESTED]: 'a proposal record with no user decision on it',
  [ExecutionState.PREPARED]: 'a plan recorded as a draft, with its content hash',
  [ExecutionState.AWAITING_APPROVAL]: 'a draft plan, or a task step recorded as awaiting_approval',
  [ExecutionState.APPROVED]: 'a plan approval event whose content hash still matches the stored plan',
  [ExecutionState.RUNNING]: 'a task recorded as running while its lock is held',
  [ExecutionState.VERIFIED]: 'an operation record that ends success_verified, re-read by the action verifier',
  [ExecutionState.PARTIALLY_COMPLETED]: 'a plan or task with some completed step outcomes and some not',
  [ExecutionState.FAILED]: 'a step or task recorded as failed',
  [ExecutionState.BLOCKED]: 'a plan or goal recorded as blocked, with its blocker',
  [ExecutionState.UNCERTAIN]: 'a step recorded as uncertain: it may or may not have happened',
});

export const STATE_RULE = 'a state is reported only from a recorded plan, task, proposal, or operation; no state is inferred from a model statement or from a request';

// Continuation readiness: the six answers to "can this be taken up now, and if not, what is missing?".
// A state of a record, not a forecast: `ready to execute` means an approval is on file and the live
// check still passes against the records it names, not that the run will succeed.
export const ContinuationReadiness = Object.freeze({
  READY_TO_EXECUTE: 'ready to execute',
  READY_FOR_APPROVAL: 'ready for approval',
  REQUIRES_CLARIFICATION: 'requires clarification',
  BLOCKED: 'blocked',
  WAITING_FOR_EVIDENCE: 'waiting for evidence',
  NOT_FEASIBLE: 'not feasible',
});

export const READINESS_STATES = Object.freeze(Object.values(ContinuationReadiness));

// The record each readiness state is read from, printed beside the state so the reader can check the
// claim instead of taking the word for it.
export const READINESS_BASIS = Object.freeze({
  [ContinuationReadiness.READY_TO_EXECUTE]: 'a plan recorded as approved, whose live validity check passes against the records it names',
  [ContinuationReadiness.READY_FOR_APPROVAL]: 'a plan recorded as a draft, or a candidate that passed every gate, whose steps the live registry authorizes',
  [ContinuationReadiness.REQUIRES_CLARIFICATION]: 'a comparison the disclosed rule cannot separate, a goal whose revision moved after the plan was written, or a goal with no open criterion to plan against',
  [ContinuationReadiness.BLOCKED]: 'a plan or goal recorded as blocked, an approval that no longer matches the plan bytes, an unmet goal dependency, or a failed step outcome',
  [ContinuationReadiness.WAITING_FOR_EVIDENCE]: 'a step with no recorded outcome, an evidence citation the stores no longer support, or an outcome verdict of awaiting confirmation',
  [ContinuationReadiness.NOT_FEASIBLE]: 'a candidate set no registered capability can carry, or a step naming an action the registry does not hold or does not authorize',
});

export const READINESS_RULE = 'readiness is read from a recorded plan, goal, task, operation, or candidate comparison, and the check it was read from is named beside it. '
  + 'It is not a forecast that a run will succeed, and no readiness state authorizes a step: the registry decides that again when each step runs.';

// Side-effect classes for a proposed step. APEX has no capability that destroys or overwrites
// anything outside its own stores, so there is no destructive class to report, and the bridge must
// not imply one exists.
export const SideEffect = Object.freeze({
  NONE: 'none',
  APPEND: 'append',
});

// What a class means for the user, in the words the preview prints. `append` is persistent: a later
// record can correct or supersede it, and nothing erases the earlier one.
export const SIDE_EFFECT_NOTE = Object.freeze({
  [SideEffect.NONE]: 'no persistent change; the result is re-derived from the stores each time it runs',
  [SideEffect.APPEND]: 'one persistent record appended to the store that action owns; it can later be corrected or superseded, and it is never erased',
});

// Whether an operation can be undone by APEX. Every write here is an append to APEX's own record, so
// the honest statement is "correctable, not erasable" rather than "reversible".
export const Reversibility = Object.freeze({
  READ: 'no change to undo',
  APPEND: 'correctable by a later record; not erasable',
});

// Where an interruption can fall, per step. The bridge reports the boundary it can prove from the
// records rather than guessing that a step did or did not happen.
export const FailureBoundary = Object.freeze({
  BEFORE_EXECUTION: 'before_execution',
  DURING_ACTION: 'during_action',
  AFTER_ACTION_BEFORE_VERIFICATION: 'after_action_before_verification',
  AFTER_VERIFICATION_BEFORE_FINALIZATION: 'after_verification_before_finalization',
  AUDIT_APPEND_FAILED: 'audit_append_failed',
  LOCK_CONTENTION: 'lock_contention',
  LOST_LOCK_OWNERSHIP: 'lost_lock_ownership',
  STORE_CORRUPTION: 'store_corruption',
  STALE_APPROVAL: 'stale_approval',
  CHANGED_REGISTRY: 'changed_registry',
  CHANGED_PLAN: 'changed_plan',
  CAPABILITY_UNAVAILABLE: 'capability_unavailable',
  UNCERTAIN_SIDE_EFFECT: 'uncertain_side_effect',
});

// What recovery may conclude about a step at each boundary. `started_unknown` is the class that must
// never be replayed automatically, and the runner already records RUNNING before it executes a step
// so that an interruption lands here instead of looking like a step that never ran.
export const RecoveryClass = Object.freeze({
  NOT_STARTED: 'not_started',
  STARTED_UNKNOWN: 'started_unknown',
  VERIFIED_SUCCESS: 'verified_success',
  VERIFIED_FAILED: 'verified_failed',
  BLOCKED: 'blocked',
  REQUIRES_USER: 'requires_user',
});

export const RECOVERY_NOTE = 'recovery reads the task log and the operation audit: an uncertain step is never retried automatically, and a step whose outcome is not verified is not reported as done';

// Status question classes. They are asked of the records, so a model is never the one that says
// whether a step ran. Each class names the record that answers it.
export const StatusQuestion = Object.freeze({
  ACTIVITY: 'activity',
  NEXT: 'next',
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  APPROVAL: 'approval',
  UNCERTAIN: 'uncertain',
  CONTINUE: 'continue',
  CANCEL: 'cancel',
  PROGRESS: 'progress',
  // The three planning questions. Each is answered from records the task log cannot reach: the
  // candidate set a goal supports, the comparison of it, and what a plan's own execution established.
  OPTIONS: 'options',                       // what other approaches are on the table, and why
  OUTCOME: 'outcome',                       // what the records establish about a plan's result
  READINESS: 'readiness',                   // whether this plan can be taken up now, and what is missing
});

export const STATUS_QUESTIONS = Object.freeze(Object.values(StatusQuestion));

// Which of the five claim classes a line of an answer belongs to. A reader has to be able to tell
// what APEX stores from what APEX concluded, so the answer marks its own lines rather than leaving
// the distinction to be inferred.
export const ClaimKind = Object.freeze({
  FACT: 'fact',                             // a field of a record, read back here
  VERIFIED_OUTCOME: 'verified outcome',     // an operation the audit log holds and the action's verifier re-read
  ASSUMPTION: 'assumption',                 // recorded as an assumption in the plan's own assertions
  SUGGESTION: 'suggestion',                 // APEX's reading of the records: never permission
  PREDICTION: 'prediction',                 // a recorded expectation, not yet resolved either way
});

export const CLAIM_KINDS = Object.freeze(Object.values(ClaimKind));

// One line per mark, so a view that is bounded line by line still states what each mark means. A
// legend in one long sentence is the sentence a bounded view drops.
export const CLAIM_LEGEND = Object.freeze([
  [ClaimKind.FACT, 'a field read from a named record'],
  [ClaimKind.VERIFIED_OUTCOME, 'an operation the audit log holds, and the action\'s own verifier re-read'],
  [ClaimKind.ASSUMPTION, 'recorded as an assumption, not as established'],
  [ClaimKind.SUGGESTION, 'APEX\'s reading of the records, which grants nothing'],
  [ClaimKind.PREDICTION, 'a recorded expectation that has resolved neither way'],
]);

export const CLAIM_NOTE = 'No reasoning steps are shown, because there are none to show: this answer is produced from the records it names, and APEX keeps no hidden deliberation about them.';

// The answer to "can you continue?" has to start from a fact about this architecture, not from a
// record: APEX runs only while a command is running. Nothing is in progress between commands.
export const NO_BACKGROUND_NOTE = 'APEX runs only when you run a command: it has no background process, so nothing is in progress between commands';

// Bounds on the bridge's own output. The plan content bounds live in the plan model and are reused
// rather than repeated here; these cap what is printed.
export const BOUNDS = Object.freeze({
  maxPreviewLines: 64,
  maxPreviewChars: 6000,
  maxStatusLines: 40,
  maxStatusChars: 4000,
  maxNamedSteps: 8,
  maxListedRecords: 12,
  maxReasonChars: 200,
  maxUnmappedDisclosed: 6,
});

const PLAN_STATE = Object.freeze({
  [PlanStatus.DRAFT]: ExecutionState.AWAITING_APPROVAL,
  [PlanStatus.APPROVED]: ExecutionState.APPROVED,
  [PlanStatus.ACTIVE]: ExecutionState.RUNNING,
  [PlanStatus.BLOCKED]: ExecutionState.BLOCKED,
  [PlanStatus.COMPLETED]: ExecutionState.VERIFIED,
  [PlanStatus.FAILED]: ExecutionState.FAILED,
  [PlanStatus.CANCELLED]: ExecutionState.FAILED,
  [PlanStatus.SUPERSEDED]: ExecutionState.FAILED,
});

// A plan's recorded status and a step's recorded status, translated into the shared vocabulary. An
// unrecognised value returns null so the caller reports "the record says something unexpected"
// instead of inventing a state.
export function stateOfPlanStatus(status) {
  return PLAN_STATE[status] ?? null;
}

const STEP_STATE = Object.freeze({
  [StepStatus.PENDING]: ExecutionState.AWAITING_APPROVAL,
  [StepStatus.AWAITING_APPROVAL]: ExecutionState.AWAITING_APPROVAL,
  [StepStatus.RUNNING]: ExecutionState.RUNNING,
  [StepStatus.COMPLETED]: ExecutionState.VERIFIED,
  [StepStatus.FAILED]: ExecutionState.FAILED,
  [StepStatus.UNCERTAIN]: ExecutionState.UNCERTAIN,
  [StepStatus.SKIPPED]: ExecutionState.BLOCKED,
});

export function stateOfStepStatus(status) {
  return STEP_STATE[status] ?? null;
}
