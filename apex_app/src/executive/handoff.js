// Executive handoff records.
//
// A handoff is the one place where cognitive or executive intent crosses into execution. It is a
// record of that crossing, never a permission: every record says `authorizes: false`, and nothing
// here can allow an action. Authorization stays with the action registry (per step) and with the
// user's own approval acts (plan approval, task approval); this module only states what those
// records decided and what the execution and verification records show.
//
// A record is built around identities and hashes, not payloads: request id, proposal or plan
// identity and content hash, approval identity and scope, the authorization decision, the audit
// operation that carried the execution, and the independent verification outcome. Action inputs,
// request text, model text, and private reasoning are never copied here; an input is represented
// only by a hash so a later reader can detect a change without reading the content.
//
// The validator checks a record against itself and against the live stores. It fails closed and
// returns `authorizes: false` in every case, including success.
import { createHash } from 'node:crypto';
import { stableStringify, TaskStatus, StepStatus } from '../tasks/model.js';
import { ACTION_NAME_RE } from '../actions/registry.js';
import { Outcome } from '../outcomes.js';
import { planContentHash } from '../plans/model.js';

export const HANDOFF_SCHEMA = 1;

export const HandoffKind = Object.freeze({
  MODEL_PROPOSAL: 'model_proposal',
  PLAN_ACTIVATION: 'plan_activation',
  TASK_RUN: 'task_run',
});

export const HandoffState = Object.freeze({
  PREPARED: 'prepared',
  NOT_RUN: 'not_run',
  DENIED: 'denied',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  UNCERTAIN: 'uncertain',
  PARTIAL: 'partial',
  VERIFIED: 'verified',
});

const MAX_EVIDENCE_REFS = 8;
const MAX_EXECUTION_STEPS = 32;
const MAX_PROBLEMS = 8;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,79}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const EVIDENCE_REF_RE = /^ev:[a-z_]+:[A-Za-z0-9_.:\-]{1,200}$/;
const PROPOSAL_ID_RE = /^mp:[1-9][0-9]?$/;
const REASON_RE = /^[A-Z][A-Z0-9_]{2,39}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T[A-Za-z0-9:.+\-]{1,30}$/;
const STEP_VALUES = new Set(Object.values(StepStatus));
const TASK_VALUES = new Set(Object.values(TaskStatus));
const EXECUTION_VALUES = new Set(['ok', 'rejected', 'failed']);
const OUTCOME_VALUES = new Set(Object.values(Outcome));
const MODEL_VERIFICATION_OUTCOMES = new Set([
  Outcome.SUCCESS_VERIFIED,
  Outcome.VERIFICATION_FAILED,
  Outcome.VERIFICATION_UNAVAILABLE,
]);

const COMMON_KEYS = [
  'schema', 'kind', 'authorizes', 'state', 'requestId', 'source', 'evidence',
  'authorization', 'execution', 'verification', 'finalization',
];
const KIND_KEYS = {
  [HandoffKind.MODEL_PROPOSAL]: ['proposal', 'step', 'approval'],
  [HandoffKind.PLAN_ACTIVATION]: ['plan', 'approval', 'goal', 'task'],
  [HandoffKind.TASK_RUN]: ['approval', 'task'],
};
const AUTHORIZATION_OWNER = {
  [HandoffKind.MODEL_PROPOSAL]: 'action_registry',
  [HandoffKind.PLAN_ACTIVATION]: 'plan_approval',
  [HandoffKind.TASK_RUN]: 'task_status',
};
const AUTHORIZATION_BASIS = {
  [HandoffKind.MODEL_PROPOSAL]: 'registry_decision',
  [HandoffKind.PLAN_ACTIVATION]: 'approval_bound_to_live_plan',
  [HandoffKind.TASK_RUN]: 'task_status_and_approval',
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function isHash(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function exactKeys(value, keys) {
  if (!isObject(value)) return false;
  const own = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return own.length === wanted.length && own.every((key, i) => key === wanted[i]);
}

function hashOf(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

// The exact bytes a model proposal is bound to. Two proposals with the same action and the same
// canonical input hash the same; a change to either produces a different hash, so an execution
// record can be checked against the proposal it claims to come from.
export function proposalBindingHash(action, input) {
  return hashOf({ action: typeof action === 'string' ? action : null, input: input ?? null });
}

// The steps a task was created with, as the identity a task approval is bound to. Execution state
// is deliberately excluded: an approval binds the plan of work, not how far it has run.
export function taskBindingHash(task) {
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  return hashOf(steps.map((step) => ({
    id: step?.id ?? null,
    action: step?.action ?? null,
    input: step?.input ?? {},
    dependsOn: Array.isArray(step?.dependsOn) ? [...step.dependsOn] : [],
  })));
}

function boundedEvidence(refs) {
  const seen = new Set();
  const unique = [];
  for (const ref of refs ?? []) {
    if (typeof ref !== 'string' || !EVIDENCE_REF_RE.test(ref) || seen.has(ref)) continue;
    seen.add(ref);
    unique.push(ref);
  }
  return { refs: unique.slice(0, MAX_EVIDENCE_REFS), total: unique.length };
}

function operationRef(operationId) {
  return isId(operationId) ? `ev:operation:${operationId}` : null;
}

function traceEvidenceRefs(cognition) {
  const items = cognition?.trace?.evidence;
  if (!Array.isArray(items)) return [];
  return items.map((item) => item?.id).filter((id) => typeof id === 'string');
}

function baseRecord(kind, requestId, source, evidence) {
  return {
    schema: HANDOFF_SCHEMA,
    kind,
    authorizes: false,
    state: HandoffState.PREPARED,
    requestId,
    source,
    evidence,
    authorization: null,
    execution: null,
    verification: null,
    // Whether the operation line that carries this record was appended is established by the
    // operation log itself, not by a field inside the record. It stays null by construction.
    finalization: { recorded: null },
  };
}

export function buildModelProposalHandoff({ requestId, proposal, stepIndex, evidenceRefs = [] }) {
  const record = baseRecord(
    HandoffKind.MODEL_PROPOSAL,
    requestId,
    'model',
    boundedEvidence(evidenceRefs),
  );
  record.proposal = {
    id: proposal?.proposalId ?? null,
    version: 1,
    contentHash: proposalBindingHash(proposal?.action, proposal?.input),
    action: proposal?.action ?? null,
    origin: 'model',
    trusted: false,
    authority: 'none',
  };
  record.step = stepIndex;
  record.approval = null;
  return record;
}

// Completes a model-proposal handoff from the step the controller actually produced. The step's
// authorization, execution, and verification are the only source; nothing from the model reply is
// consulted here.
export function completeModelProposalHandoff(record, { step }) {
  // The completed record binds the content that was actually handed to execution. The audit input
  // is the controller's representation of that content (credential-like values are omitted), so
  // the hash is taken from the step, not from the raw reply.
  const completed = {
    ...record,
    proposal: { ...record.proposal, contentHash: proposalBindingHash(step?.action, step?.input) },
  };
  const auth = step?.authorization;
  if (auth && (auth.decision === 'allow' || auth.decision === 'deny')) {
    completed.authorization = {
      owner: 'action_registry',
      decision: auth.decision,
      reason: typeof auth.reason === 'string' && auth.reason.length > 0 ? auth.reason : null,
      basis: AUTHORIZATION_BASIS[HandoffKind.MODEL_PROPOSAL],
      perStep: 'this_step',
    };
  }
  if (step?.execution && step.execution.status !== 'not_run') {
    completed.execution = {
      operationId: record.requestId,
      step: record.step,
      status: step.execution.status,
    };
  }
  const outcome = step?.verification?.outcome;
  if (completed.execution?.status === 'ok' && MODEL_VERIFICATION_OUTCOMES.has(outcome)) {
    completed.verification = {
      basis: 'independent_verifier',
      outcome,
      checked: 1,
      verified: outcome === Outcome.SUCCESS_VERIFIED ? 1 : 0,
      failed: outcome === Outcome.VERIFICATION_FAILED ? 1 : 0,
      unavailable: outcome === Outcome.VERIFICATION_UNAVAILABLE ? 1 : 0,
    };
  }
  completed.state = modelState(completed);
  return completed;
}

function modelState(record) {
  if (record.authorization?.decision === 'deny') return HandoffState.DENIED;
  if (!record.execution) return HandoffState.NOT_RUN;
  if (record.execution.status === 'rejected') return HandoffState.REJECTED;
  if (record.execution.status === 'failed') return HandoffState.FAILED;
  if (record.verification?.outcome === Outcome.SUCCESS_VERIFIED) return HandoffState.VERIFIED;
  if (record.verification?.outcome === Outcome.VERIFICATION_UNAVAILABLE) return HandoffState.UNCERTAIN;
  return HandoffState.FAILED;
}

function planApproval(plan) {
  const approval = plan?.approval;
  if (!approval) return null;
  return {
    scope: 'plan_approval',
    at: approval.at ?? null,
    version: approval.version ?? null,
    contentHash: approval.contentHash ?? null,
  };
}

function approvalBindsPlan(plan) {
  if (!plan?.approval) return false;
  return plan.approval.version === plan.version
    && plan.approval.contentHash === planContentHash(plan);
}

// A plan activation handoff is built after the plan passed live validation and a task exists for
// it, and before the plan is activated. Its approval is the stored plan approval; if that approval
// is missing or does not bind the live bytes, the record says the crossing is denied and the
// controller refuses rather than recording a crossing it cannot justify.
export function buildPlanActivationHandoff({ requestId, plan, goal = null, task }) {
  const record = baseRecord(
    HandoffKind.PLAN_ACTIVATION,
    requestId,
    'user',
    boundedEvidence([]),
  );
  record.plan = {
    id: plan?.id ?? null,
    version: plan?.version ?? null,
    contentHash: plan ? planContentHash(plan) : null,
  };
  record.approval = approvalBindsPlan(plan) ? planApproval(plan) : null;
  record.goal = goal
    ? { id: goal.id ?? null, revision: goal.revision ?? null, status: goal.status ?? null }
    : null;
  record.task = taskIdentity(task);
  record.authorization = {
    owner: AUTHORIZATION_OWNER[HandoffKind.PLAN_ACTIVATION],
    decision: record.approval ? 'allow' : 'deny',
    reason: record.approval ? null : 'APPROVAL_NOT_BOUND_TO_PLAN',
    basis: AUTHORIZATION_BASIS[HandoffKind.PLAN_ACTIVATION],
    perStep: 'registry_decided_at_run',
  };
  return record;
}

function taskIdentity(task) {
  return {
    id: task?.id ?? null,
    planId: task?.planId ?? null,
    origin: task?.origin ?? null,
    stepCount: Array.isArray(task?.steps) ? task.steps.length : 0,
  };
}

// A task-run handoff names how the task came to be allowed to run: a user-created task needs no
// further approval, while a model-proposed task needs the user's approval act, recorded on the
// task itself. If a model task has no approval, the crossing is denied before the runner refuses it.
export function buildTaskRunHandoff({ requestId, task }) {
  const record = baseRecord(
    HandoffKind.TASK_RUN,
    requestId,
    'user',
    boundedEvidence((task?.steps ?? []).map((step) => operationRef(step?.operationId)).filter(Boolean)),
  );
  record.task = taskIdentity(task);
  const modelTask = task?.origin === 'model';
  const approvalAt = modelTask ? task?.approvedAt ?? null : task?.createdAt ?? null;
  record.approval = approvalAt
    ? {
      scope: modelTask ? 'task_approval' : 'task_creation',
      at: approvalAt,
      version: null,
      contentHash: taskBindingHash(task),
    }
    : null;
  const runnable = task?.status === TaskStatus.PENDING || task?.status === TaskStatus.PAUSED;
  const allowed = Boolean(record.approval) && runnable;
  record.authorization = {
    owner: AUTHORIZATION_OWNER[HandoffKind.TASK_RUN],
    decision: allowed ? 'allow' : 'deny',
    reason: allowed ? null : (record.approval ? 'TASK_STATE_NOT_RUNNABLE' : 'TASK_APPROVAL_MISSING'),
    basis: AUTHORIZATION_BASIS[HandoffKind.TASK_RUN],
    perStep: 'registry_decided_at_run',
  };
  return record;
}

function terminalOutcomes(task) {
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  let verified = 0;
  let failed = 0;
  let unavailable = 0;
  let skipped = 0;
  let attempted = false;
  for (const step of steps) {
    if (isId(step?.operationId)) attempted = true;
    if (step?.status === StepStatus.SKIPPED) {
      skipped += 1;
      continue;
    }
    if (step?.status === StepStatus.COMPLETED && step?.outcome === Outcome.SUCCESS_VERIFIED && isId(step?.operationId)) {
      verified += 1;
      continue;
    }
    if (step?.status === StepStatus.UNCERTAIN || step?.outcome === Outcome.VERIFICATION_UNAVAILABLE) {
      unavailable += 1;
      continue;
    }
    if (step?.status === StepStatus.FAILED || step?.outcome === Outcome.VERIFICATION_FAILED
      || (step?.status === StepStatus.COMPLETED && step?.outcome !== Outcome.SUCCESS_VERIFIED)) {
      failed += 1;
    }
  }
  return { verified, failed, unavailable, skipped, attempted, total: steps.length };
}

// Completes a plan-activation or task-run handoff from the task records the runner left behind.
// A step is reported as verified only when its own task record names an operation and the outcome
// that operation produced is SUCCESS_VERIFIED. An absent record stays uncertain or not-run; it is
// never read as success.
//
// `refused` says the runner refused this crossing before any step of it ran. The task may still
// carry another crossing's history, so none of it is reported here: the record states that the
// crossing did not happen and why, exactly as a prepared denial does.
export function completeTaskHandoff(record, { task, refused = false } = {}) {
  // Only the keys the record already has are touched. A task-run record has no plan or goal, and
  // adding them as absent keys would make its own exact-key contract refuse it.
  const completed = {
    ...record,
    task: taskIdentity(task),
    authorization: record.authorization ? { ...record.authorization } : null,
  };
  // A denied crossing establishes nothing about execution, even if the task it names has its own
  // history. The steps the task ran in an earlier crossing belong to that crossing's record.
  if (refused || completed.authorization?.decision === 'deny') {
    const base = completed.authorization ?? {
      owner: AUTHORIZATION_OWNER[record.kind],
      basis: AUTHORIZATION_BASIS[record.kind],
      perStep: 'registry_decided_at_run',
    };
    completed.authorization = {
      ...base,
      decision: 'deny',
      // A prepared denial keeps its own reason; a refusal after preparation names the one that
      // kept this crossing from running.
      reason: completed.authorization?.reason ?? 'TASK_STATE_NOT_RUNNABLE',
    };
    completed.execution = null;
    completed.verification = null;
    completed.evidence = boundedEvidence([]);
    completed.state = HandoffState.DENIED;
    return completed;
  }
  const counts = terminalOutcomes(task);
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  const executed = steps
    .filter((step) => isId(step?.operationId) || step?.status === StepStatus.COMPLETED
      || step?.status === StepStatus.FAILED || step?.status === StepStatus.UNCERTAIN
      || step?.status === StepStatus.SKIPPED)
    .slice(0, MAX_EXECUTION_STEPS)
    .map((step) => ({
      id: step?.id ?? null,
      operationId: isId(step?.operationId) ? step.operationId : null,
      status: STEP_VALUES.has(step?.status) ? step.status : null,
      outcome: step?.outcome && OUTCOME_VALUES.has(step.outcome) ? step.outcome : null,
    }));
  const attempted = counts.attempted || executed.length > 0;
  if (attempted) {
    completed.execution = {
      taskId: task?.id ?? null,
      status: TASK_VALUES.has(task?.status) ? task.status : null,
      steps: executed,
      stepsTotal: steps.length,
    };
    completed.evidence = boundedEvidence(
      steps.map((step) => operationRef(step?.operationId)).filter(Boolean),
    );
  } else {
    completed.execution = null;
    completed.evidence = boundedEvidence([]);
  }
  const checked = counts.verified + counts.failed + counts.unavailable;
  completed.verification = checked > 0
    ? {
      basis: 'task_step_records',
      checked,
      verified: counts.verified,
      failed: counts.failed,
      unavailable: counts.unavailable,
    }
    : null;
  completed.state = taskState(completed, counts, task);
  return completed;
}

function taskState(record, counts, task) {
  const checked = counts.verified + counts.failed + counts.unavailable;
  if (counts.total > 0 && counts.verified === counts.total && counts.verified > 0) return HandoffState.VERIFIED;
  if (counts.unavailable > 0) return HandoffState.UNCERTAIN;
  if (counts.verified > 0) return HandoffState.PARTIAL;
  if (counts.failed > 0 || counts.skipped > 0 || task?.status === TaskStatus.FAILED) return HandoffState.FAILED;
  if (task?.status === TaskStatus.CANCELLED) return HandoffState.CANCELLED;
  if (checked > 0) return HandoffState.UNCERTAIN;
  return HandoffState.NOT_RUN;
}

// ---- validation --------------------------------------------------------------

function problemList() {
  const problems = [];
  return {
    add(message) {
      if (problems.length < MAX_PROBLEMS) problems.push(message);
    },
    result() {
      return { ok: problems.length === 0, problems, authorizes: false };
    },
  };
}

function authorizationProblems(record, problems) {
  const auth = record.authorization;
  if (auth === null) {
    // A prepared model handoff is built before the registry is asked anything, so it carries no
    // decision yet. Every recorded crossing carries one.
    if (record.state === HandoffState.PREPARED) return;
    problems.add('a completed handoff must name the authorization it crossed under');
    return;
  }
  if (!exactKeys(auth, ['owner', 'decision', 'reason', 'basis', 'perStep'])) {
    problems.add('authorization must name its owner, decision, reason, basis, and per-step scope');
    return;
  }
  if (auth.owner !== AUTHORIZATION_OWNER[record.kind]) problems.add('authorization owner does not belong to this handoff kind');
  if (auth.decision !== 'allow' && auth.decision !== 'deny') problems.add('authorization decision must be allow or deny');
  if (auth.reason !== null && !(typeof auth.reason === 'string' && REASON_RE.test(auth.reason))) {
    problems.add('authorization reason must be null or a bounded uppercase token');
  }
  if (auth.decision === 'allow' && record.kind === HandoffKind.MODEL_PROPOSAL && auth.reason !== 'PERMITTED') {
    problems.add('a model-proposal allow must cite the registry decision PERMITTED');
  }
  if (auth.decision === 'deny' && auth.reason === null) problems.add('a denial must state its reason');
  if (auth.basis !== AUTHORIZATION_BASIS[record.kind]) problems.add('authorization basis does not belong to this handoff kind');
  if (auth.perStep !== (record.kind === HandoffKind.MODEL_PROPOSAL ? 'this_step' : 'registry_decided_at_run')) {
    problems.add('authorization per-step scope is not the one this crossing uses');
  }
}

function evidenceProblems(evidence, problems) {
  if (!exactKeys(evidence, ['refs', 'total'])) {
    problems.add('evidence must be a bounded reference list with a total');
    return;
  }
  if (!Array.isArray(evidence.refs) || evidence.refs.length > MAX_EVIDENCE_REFS) {
    problems.add(`evidence may list at most ${MAX_EVIDENCE_REFS} references`);
    return;
  }
  if (evidence.refs.some((ref) => typeof ref !== 'string' || !EVIDENCE_REF_RE.test(ref))) {
    problems.add('every evidence reference must be a well-formed ev:<source>:<record> reference');
  }
  if (new Set(evidence.refs).size !== evidence.refs.length) problems.add('evidence references must be unique');
  if (!isCount(evidence.total) || evidence.total < evidence.refs.length) problems.add('evidence total must be a count of at least the listed references');
}

function modelExecutionProblems(execution, record, problems) {
  if (!exactKeys(execution, ['operationId', 'step', 'status'])) {
    problems.add('a model execution record must name its operation, step, and status');
    return;
  }
  if (execution.operationId !== record.requestId) problems.add('a model execution must name the request operation that carried it');
  if (execution.step !== record.step) problems.add('a model execution step does not match the handoff step');
  if (!EXECUTION_VALUES.has(execution.status)) problems.add('model execution status must be ok, rejected, or failed');
}

function taskExecutionProblems(execution, record, problems) {
  if (!exactKeys(execution, ['taskId', 'status', 'steps', 'stepsTotal'])) {
    problems.add('a task execution record must name its task, status, steps, and step total');
    return;
  }
  if (execution.taskId !== record.task.id) problems.add('a task execution must name the task this handoff crossed for');
  if (!TASK_VALUES.has(execution.status)) problems.add('task execution status is not a task state');
  if (!Array.isArray(execution.steps) || execution.steps.length > MAX_EXECUTION_STEPS) {
    problems.add(`task execution may list at most ${MAX_EXECUTION_STEPS} steps`);
    return;
  }
  if (!isCount(execution.stepsTotal) || execution.stepsTotal < execution.steps.length) {
    problems.add('task execution step total must be at least the listed steps');
  } else if (execution.stepsTotal !== record.task?.stepCount) {
    problems.add('task execution step total differs from the task it names');
  }
  for (const step of execution.steps) {
    if (!exactKeys(step, ['id', 'operationId', 'status', 'outcome'])) {
      problems.add('each task execution step names only its id, operation, status, and outcome');
      break;
    }
    if (!isId(step.id)) problems.add('a task execution step id is not bounded');
    if (step.operationId !== null && !isId(step.operationId)) problems.add('a task execution operation id is not bounded');
    if (step.status !== null && !STEP_VALUES.has(step.status)) problems.add('a task execution step status is not a step state');
    if (step.outcome !== null && !OUTCOME_VALUES.has(step.outcome)) problems.add('a task execution outcome is not a known outcome');
  }
}

function verificationProblems(verification, record, problems) {
  if (record.kind === HandoffKind.MODEL_PROPOSAL) {
    if (!exactKeys(verification, ['basis', 'outcome', 'checked', 'verified', 'failed', 'unavailable'])) {
      problems.add('a model verification record must name its basis, outcome, and counts');
      return;
    }
    if (verification.basis !== 'independent_verifier') problems.add('a model verification must name the independent verifier');
    if (!MODEL_VERIFICATION_OUTCOMES.has(verification.outcome)) problems.add('model verification outcome is not a verifier outcome');
    if (verification.checked !== 1) problems.add('a model verification checks exactly one proposal');
    const sum = (verification.verified ?? 0) + (verification.failed ?? 0) + (verification.unavailable ?? 0);
    if (![verification.verified, verification.failed, verification.unavailable].every(isCount) || sum !== 1) {
      problems.add('model verification counts must sum to one check');
    }
    const expected = verification.outcome === Outcome.SUCCESS_VERIFIED
      ? { verified: 1, failed: 0, unavailable: 0 }
      : verification.outcome === Outcome.VERIFICATION_FAILED
        ? { verified: 0, failed: 1, unavailable: 0 }
        : { verified: 0, failed: 0, unavailable: 1 };
    if (verification.verified !== expected.verified || verification.failed !== expected.failed
      || verification.unavailable !== expected.unavailable) {
      problems.add('model verification counts do not match its outcome');
    }
    return;
  }
  if (!exactKeys(verification, ['basis', 'checked', 'verified', 'failed', 'unavailable'])) {
    problems.add('a task verification record must name its basis and counts');
    return;
  }
  if (verification.basis !== 'task_step_records') problems.add('a task verification must name the task step records');
  if (![verification.checked, verification.verified, verification.failed, verification.unavailable].every(isCount)) {
    problems.add('task verification counts must be non-negative integers');
    return;
  }
  if (verification.checked !== verification.verified + verification.failed + verification.unavailable) {
    problems.add('task verification checked count must equal its parts');
  }
}

function approvalProblems(record, problems) {
  if (record.kind === HandoffKind.MODEL_PROPOSAL) {
    if (record.approval !== null) problems.add('a model proposal carries no approval; a model cannot approve itself');
    return;
  }
  const allow = record.authorization?.decision === 'allow';
  if (record.approval === null) {
    if (allow) problems.add('an allowed crossing must name the approval it rests on');
    return;
  }
  if (!exactKeys(record.approval, ['scope', 'at', 'version', 'contentHash'])) {
    problems.add('an approval must name its scope, time, version, and content hash');
    return;
  }
  if (typeof record.approval.at !== 'string' || !TIME_RE.test(record.approval.at)) {
    problems.add('an approval must carry the recorded time of the approval act');
  }
  if (!isHash(record.approval.contentHash)) problems.add('an approval content hash must be a sha256 digest');
  if (record.kind === HandoffKind.PLAN_ACTIVATION) {
    if (record.approval.scope !== 'plan_approval') problems.add('a plan activation rests on the plan approval');
    if (record.approval.version !== record.plan?.version) problems.add('the approval version does not match the plan version');
    if (record.approval.contentHash !== record.plan?.contentHash) problems.add('the approval hash does not match the plan content');
  } else {
    if (record.approval.scope !== 'task_approval' && record.approval.scope !== 'task_creation') {
      problems.add('a task run rests on a task approval or the user\'s own creation of the task');
    }
    if (record.approval.version !== null) problems.add('a task approval has no plan version');
  }
}

function shapeProblems(record, phase, problems) {
  if (!isObject(record)) {
    problems.add('a handoff record must be an object');
    return;
  }
  const kind = record.kind;
  if (!Object.values(HandoffKind).includes(kind)) {
    problems.add('unknown handoff kind');
    return;
  }
  if (!exactKeys(record, [...COMMON_KEYS, ...KIND_KEYS[kind]])) {
    problems.add('a handoff record has missing or unrecognized fields');
  }
  if (record.schema !== HANDOFF_SCHEMA) problems.add('unsupported handoff schema');
  if (record.authorizes !== false) problems.add('a handoff record authorizes nothing and must say so');
  if (!Object.values(HandoffState).includes(record.state)) problems.add('unknown handoff state');
  if (!isId(record.requestId)) problems.add('a handoff must name a bounded request operation id');
  if (record.source !== (kind === HandoffKind.MODEL_PROPOSAL ? 'model' : 'user')) {
    problems.add('handoff source does not match its crossing');
  }
  evidenceProblems(record.evidence, problems);
  if (!exactKeys(record.finalization, ['recorded']) || record.finalization.recorded !== null) {
    problems.add('finalization state belongs to the operation log, not inside the handoff record');
  }
  authorizationProblems(record, problems);
  approvalProblems(record, problems);

  if (kind === HandoffKind.MODEL_PROPOSAL) {
    if (!exactKeys(record.proposal, ['id', 'version', 'contentHash', 'action', 'origin', 'trusted', 'authority'])) {
      problems.add('a model proposal record must name its id, version, hash, action, origin, trust, and authority');
    } else {
      if (typeof record.proposal.id !== 'string' || !PROPOSAL_ID_RE.test(record.proposal.id)) problems.add('a model proposal id is not bounded');
      if (record.proposal.version !== 1) problems.add('a model proposal handoff is version 1');
      if (!isHash(record.proposal.contentHash)) problems.add('a model proposal hash must be a sha256 digest');
      if (typeof record.proposal.action !== 'string' || !ACTION_NAME_RE.test(record.proposal.action)) problems.add('a model proposal action name is not bounded');
      if (record.proposal.origin !== 'model' || record.proposal.trusted !== false || record.proposal.authority !== 'none') {
        problems.add('a model proposal is untrusted and carries no authority');
      }
    }
    if (!isCount(record.step) || record.step > MAX_EXECUTION_STEPS) problems.add('a handoff step index is not bounded');
  }

  if (kind === HandoffKind.PLAN_ACTIVATION) {
    if (!exactKeys(record.plan, ['id', 'version', 'contentHash'])) {
      problems.add('a plan handoff must name its plan id, version, and content hash');
    } else {
      if (!isId(record.plan.id)) problems.add('a plan id is not bounded');
      if (!Number.isInteger(record.plan.version) || record.plan.version < 1) problems.add('a plan version must be a positive integer');
      if (!isHash(record.plan.contentHash)) problems.add('a plan content hash must be a sha256 digest');
    }
    if (record.goal !== null) {
      if (!exactKeys(record.goal, ['id', 'revision', 'status'])) {
        problems.add('a goal reference names only its id, revision, and status');
      } else {
        if (!isId(record.goal.id)) problems.add('a goal id is not bounded');
        if (record.goal.revision !== null && !(Number.isInteger(record.goal.revision) && record.goal.revision >= 1)) problems.add('a goal revision is not bounded');
        if (typeof record.goal.status !== 'string' || !ID_RE.test(record.goal.status)) problems.add('a goal status is not bounded');
      }
    }
  }

  if (kind === HandoffKind.PLAN_ACTIVATION || kind === HandoffKind.TASK_RUN) {
    if (!exactKeys(record.task, ['id', 'planId', 'origin', 'stepCount'])) {
      problems.add('a task reference names only its id, plan, origin, and step count');
    } else {
      if (!isId(record.task.id)) problems.add('a task id is not bounded');
      if (record.task.planId !== null && !isId(record.task.planId)) problems.add('a task plan id is not bounded');
      if (record.task.origin !== 'user' && record.task.origin !== 'model') problems.add('a task origin must be user or model');
      if (!isCount(record.task.stepCount) || record.task.stepCount > 64) problems.add('a task step count is not bounded');
    }
    if (kind === HandoffKind.PLAN_ACTIVATION) {
      if (record.task?.planId !== record.plan?.id) problems.add('the task does not name the plan this handoff activates');
      if (record.task?.origin !== 'user') problems.add('a plan activates a user-origin task');
      if (!(record.task?.stepCount > 0)) problems.add('a plan task has at least one step');
    }
  }

  // Execution and verification are read only when the shape above is sound.
  const executionShapeOk = kind === HandoffKind.MODEL_PROPOSAL
    ? (record.execution === null || isObject(record.execution))
    : (record.execution === null || isObject(record.execution));
  if (executionShapeOk && record.execution !== null) {
    if (kind === HandoffKind.MODEL_PROPOSAL) modelExecutionProblems(record.execution, record, problems);
    else taskExecutionProblems(record.execution, record, problems);
  }
  if (record.verification !== null) verificationProblems(record.verification, record, problems);

  stateProblems(record, phase, problems);
}

function stateProblems(record, phase, problems) {
  const state = record.state;
  const allow = record.authorization?.decision === 'allow';
  const hasExecution = record.execution !== null;
  const hasVerification = record.verification !== null;

  if (state === HandoffState.PREPARED) {
    if (phase !== 'prepared') problems.add('a prepared handoff was not completed before it was recorded');
    if (hasExecution) problems.add('a prepared handoff has not executed anything');
    if (hasVerification) problems.add('a prepared handoff has not been verified');
    return;
  }
  if (phase === 'prepared') problems.add('a completed handoff cannot be used where a prepared one is required');

  if (state === HandoffState.DENIED) {
    if (allow) problems.add('a denied handoff cannot record an allowing authorization');
    if (hasExecution) problems.add('a denied handoff cannot name an execution');
    if (hasVerification) problems.add('a denied handoff cannot name a verification');
    return;
  }
  if (state === HandoffState.NOT_RUN || state === HandoffState.CANCELLED) {
    if (!allow) problems.add('a not-run crossing must name the authorization that was never exercised');
    if (hasExecution) problems.add('a crossing that did not run cannot name an execution');
    if (hasVerification) problems.add('a crossing that did not run cannot name a verification');
    return;
  }
  if (!allow) problems.add('a crossing that executed must name an allowing authorization');
  if (!hasExecution) problems.add('this handoff state requires an execution record');

  if (state === HandoffState.REJECTED || state === HandoffState.FAILED) return;
  if (!hasVerification) problems.add('this handoff state requires a verification record');
  if (!hasVerification) return;

  if (state === HandoffState.VERIFIED) {
    if (record.kind === HandoffKind.MODEL_PROPOSAL) {
      if (record.verification.outcome !== Outcome.SUCCESS_VERIFIED) problems.add('a verified model handoff must record a verified success');
    } else {
      if (record.verification.verified !== record.verification.checked) problems.add('a verified task handoff must verify every checked step');
      if (record.execution?.stepsTotal !== record.verification.verified) problems.add('a verified task handoff must verify every step of the task');
      if (record.execution?.steps.length !== record.execution?.stepsTotal) problems.add('a verified task handoff must list every step it verified');
    }
    return;
  }
  if (state === HandoffState.UNCERTAIN) {
    if (record.kind === HandoffKind.MODEL_PROPOSAL) {
      if (record.verification.outcome !== Outcome.VERIFICATION_UNAVAILABLE) problems.add('an uncertain model handoff must record verification as unavailable');
    } else if (!(record.verification.unavailable > 0)) {
      problems.add('an uncertain task handoff must name at least one unavailable verification');
    }
    return;
  }
  if (state === HandoffState.PARTIAL) {
    if (record.kind === HandoffKind.MODEL_PROPOSAL) problems.add('a model proposal cannot be partially executed');
    else {
      if (!(record.verification.verified > 0)) problems.add('a partial handoff must name at least one verified step');
      if (!(record.verification.verified < record.execution?.stepsTotal)) problems.add('a partial handoff cannot have verified every step');
    }
  }
}

// Structural validation: the record agrees with itself. It does not read a store. `phase` is
// 'prepared' for a record built before the crossing and 'recorded' for one about to be persisted.
export function validateHandoff(record, { phase = 'recorded' } = {}) {
  const problems = problemList();
  shapeProblems(record, phase, problems);
  return problems.result();
}

// Reference validation: the record agrees with the live records it names. The caller supplies what
// it read; this function never authorizes, and it never treats a missing record as a match.
export function validateHandoffReferences(record, {
  plan = null,
  task = null,
  operation = null,
  stepOperations = [],
} = {}) {
  const problems = problemList();
  if (!isObject(record)) {
    problems.add('a handoff record must be an object');
    return problems.result();
  }
  const byId = new Map();
  for (const entry of Array.isArray(stepOperations) ? stepOperations : []) {
    if (entry && typeof entry.id === 'string') byId.set(entry.id, entry);
  }

  if (record.kind === HandoffKind.MODEL_PROPOSAL) {
    validateModelReferences(record, operation, problems);
  } else if (record.kind === HandoffKind.PLAN_ACTIVATION) {
    validatePlanReferences(record, { plan, task, stepOperations: byId }, problems);
  } else if (record.kind === HandoffKind.TASK_RUN) {
    validateTaskReferences(record, { task, stepOperations: byId }, problems);
  } else {
    problems.add('unknown handoff kind');
  }
  return problems.result();
}

function stepOperationMatches(entry, record, step, problems) {
  if (!entry) {
    problems.add('a task step names an operation that is not in the audit log');
    return;
  }
  if (entry.capability !== 'task.step') problems.add('a task step operation is not a task step record');
  if (entry.task?.id !== record.task?.id) problems.add('a task step operation belongs to a different task');
  if (entry.task?.stepId !== step.id) problems.add('a task step operation belongs to a different step');
  if (step.outcome === Outcome.SUCCESS_VERIFIED && entry.status !== Outcome.SUCCESS_VERIFIED) {
    problems.add('a step recorded as verified names an operation that did not verify');
  }
  if (step.operationId !== null && entry.id !== step.operationId) problems.add('a task step operation id does not match the audited operation');
}

function validateModelReferences(record, operation, problems) {
  if (!isObject(operation)) {
    problems.add('the request operation this handoff names was not provided');
    return;
  }
  if (operation.id !== record.requestId) problems.add('the request operation does not match the handoff request id');
  if (!isObject(record.proposal)) {
    problems.add('the handoff does not name a proposal');
    return;
  }
  const steps = Array.isArray(operation.steps) ? operation.steps : [];
  const step = steps[record.step];
  if (!step || !isCount(record.step)) {
    problems.add('the handoff step is not present in the request operation');
    return;
  }
  if (step.proposalId !== `${record.requestId}/${record.proposal.id}`) {
    problems.add('the executed step does not name the proposal this handoff names');
  }
  if (step.action !== record.proposal.action) problems.add('the executed step action differs from the proposal');
  if (proposalBindingHash(step.action, step.input) !== record.proposal.contentHash) {
    problems.add('the executed step input does not match the proposal content hash');
  }
  if (record.authorization) {
    if (step.authorization?.decision !== record.authorization.decision) problems.add('the recorded authorization differs from the step\'s registry decision');
    const stepReason = typeof step.authorization?.reason === 'string' ? step.authorization.reason : null;
    if (stepReason !== record.authorization.reason) problems.add('the recorded authorization reason differs from the registry decision');
  }
  if (record.execution) {
    if (step.execution?.status !== record.execution.status) problems.add('the recorded execution status differs from the step record');
  }
  if (record.verification) {
    if (step.verification?.outcome !== record.verification.outcome) problems.add('the recorded verification differs from the step record');
  }
  const traceIds = new Set(traceEvidenceRefs(operation.cognition));
  if (traceIds.size > 0 && Array.isArray(record.evidence?.refs)) {
    for (const ref of record.evidence.refs) {
      if (!traceIds.has(ref)) {
        problems.add('an evidence reference is not in the request\'s bounded cognitive trace');
        break;
      }
    }
  }
}

function validatePlanReferences(record, { plan, task, stepOperations }, problems) {
  if (!isObject(plan)) {
    problems.add('the plan this handoff names was not provided');
  } else {
    if (plan.id !== record.plan?.id) problems.add('the plan id differs from the live plan');
    if (plan.version !== record.plan?.version) problems.add('the plan version differs from the live plan');
    if (planContentHash(plan) !== record.plan?.contentHash) problems.add('the plan content hash differs from the live plan');
    if (!plan.approval) {
      problems.add('the live plan has no recorded approval');
    } else {
      if (plan.approval.version !== record.approval?.version) problems.add('the live approval version differs from the handoff');
      if (plan.approval.contentHash !== record.approval?.contentHash) problems.add('the live approval hash differs from the handoff');
      if (plan.approval.at !== record.approval?.at) problems.add('the live approval time differs from the handoff');
    }
    if (plan.activation) {
      if (plan.activation.taskId !== record.task?.id) problems.add('the plan is activated by a different task');
      if (plan.activation.version !== record.plan?.version) problems.add('the activation version differs from the handoff');
      if (plan.activation.contentHash !== record.plan?.contentHash) problems.add('the activation hash differs from the handoff');
    }
    if (record.goal !== null && plan.goalId !== record.goal?.id) problems.add('the goal reference differs from the live plan');
  }
  validateTaskIdentity(record, task, stepOperations, problems);
  if (record.task && task && record.task.planId !== (task.planId ?? null)) problems.add('the task plan differs from the live task');
}

function validateTaskReferences(record, { task, stepOperations }, problems) {
  validateTaskIdentity(record, task, stepOperations, problems);
  if (!record.task || !task) return;
  if (record.task.planId !== (task.planId ?? null)) problems.add('the task plan differs from the live task');
  const modelTask = task.origin === 'model';
  const approvalAt = modelTask ? task.approvedAt ?? null : task.createdAt ?? null;
  if (record.approval?.at !== approvalAt) problems.add('the approval time differs from the task record');
  if (record.approval?.scope !== (modelTask ? 'task_approval' : 'task_creation')) problems.add('the approval scope differs from how the task came to be');
  if (record.approval?.contentHash !== taskBindingHash(task)) problems.add('the task content hash differs from the live task');
}

function validateTaskIdentity(record, task, stepOperations, problems) {
  if (!isObject(task)) {
    problems.add('the task this handoff names was not provided');
    return;
  }
  if (task.id !== record.task?.id) problems.add('the task id differs from the live task');
  if ((task.origin ?? null) !== record.task?.origin) problems.add('the task origin differs from the live task');
  if ((task.steps?.length ?? 0) !== record.task?.stepCount) problems.add('the task step count differs from the live task');
  if (!isObject(record.execution) || !Array.isArray(record.execution.steps)) return;
  const live = new Map((Array.isArray(task.steps) ? task.steps : []).map((step) => [step.id, step]));
  for (const step of record.execution.steps) {
    if (!isObject(step)) {
      problems.add('a recorded execution step is not an object');
      continue;
    }
    const current = live.get(step.id);
    if (!current) {
      problems.add('a recorded execution step is not in the live task');
      continue;
    }
    if ((current.operationId ?? null) !== step.operationId) problems.add('a recorded step operation differs from the live task');
    if ((current.status ?? null) !== step.status) problems.add('a recorded step status differs from the live task');
    if ((current.outcome ?? null) !== step.outcome) problems.add('a recorded step outcome differs from the live task');
    if (step.operationId !== null) stepOperationMatches(stepOperations.get(step.operationId), record, step, problems);
  }
  if (isObject(record.execution) && record.execution.status !== task.status) {
    problems.add('the recorded task status differs from the live task');
  }
  if (record.verification) {
    const liveCounts = terminalOutcomes(task);
    if (record.verification.verified !== liveCounts.verified
      || record.verification.failed !== liveCounts.failed
      || record.verification.unavailable !== liveCounts.unavailable
      || record.verification.checked !== liveCounts.verified + liveCounts.failed + liveCounts.unavailable) {
      problems.add('the recorded verification counts differ from the live task records');
    }
  }
}
