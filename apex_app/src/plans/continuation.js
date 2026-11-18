// Partial execution and safe continuation: what the records say about a run that stopped, and what
// may be taken up again.
//
// A plan that was interrupted leaves a fact pattern no single record states: some steps have
// verified operation records, one step may have run without ever being audited, the rest never
// started, and the process that was running them is gone. Batch AL could report six classes of step
// and could resume a paused task; it could not say which state the *run* is in, could not tell a
// step that is waiting for the user's confirmation from one whose outcome is simply unknown, and
// had no way to name the steps a continuation may take up. This module supplies those three answers
// from records that already exist, and nothing else.
//
// What it deliberately does not do is decide anything the records do not support:
//   - A process that stopped is not a step that failed. An interrupted step is `outcome uncertain`
//     unless its own operation record resolves it, and no absence of a record is read as an absence
//     of an effect.
//   - A step whose effect may have happened is never offered for replay, whatever its action returned
//     or its permission is: the audit contract already established that an append-only write cannot
//     be un-written, so a repeat is a second fact in the store, not a correction of the first.
//   - A function returning is not proof about the world. `verified successful` requires the step's own
//     operation record ending `success_verified`, which is what the action's verifier re-read.
//   - Whether a step is safe to take up is decided after re-reading the plan bytes, the approval that
//     binds them, the live registry, the goal's constraints and the dependency records - not from the
//     state the plan was left in. A plan whose content or constraints moved needs a fresh approval;
//     this module says so and names the record that moved.
//
// The nine states are in `executive/vocabulary.js`, each with the record it is read from. This file
// reads records and derives states: it writes nothing, runs nothing, approves nothing, and grants no
// permission. The command that would act on its answer is a separate user act, authorized again when
// each step runs.
import { createHash } from 'node:crypto';
import { Outcome } from '../outcomes.js';
import { StepStatus, TaskStatus, topologicalOrder, dependencyProblems } from '../tasks/model.js';
import { PlanStatus, planContentHash, isOpenPlan } from './model.js';
import { shortId, singleLine } from '../util.js';
import { BOUNDS, ContinuationState, CONTINUATION_STATES, CONTINUATION_EVIDENCE, CONTINUATION_NOTE, CONTINUATION_RULE } from '../executive/vocabulary.js';
import { constraintFinding } from './constraints.js';

export const CONTINUATION_SCHEMA = 1;

// The eight places a run can be interrupted, named by what each leaves in the records. The list is
// the test surface for this module as well as its documentation: a boundary no test reaches is a
// boundary whose behaviour is a claim rather than a finding.
export const INTERRUPTION_BOUNDARY = Object.freeze({
  BEFORE_STEP_CREATION: 'before_step_creation',
  AFTER_STEP_CREATION: 'after_step_creation',
  AFTER_RUNNING_RECORDED: 'after_running_recorded',
  DURING_EXECUTION: 'during_execution',
  AFTER_EXECUTION_BEFORE_VERIFICATION: 'after_execution_before_verification',
  AFTER_VERIFICATION_BEFORE_FINALIZATION: 'after_verification_before_finalization',
  AFTER_FINALIZATION_BEFORE_NEXT_STEP: 'after_finalization_before_next_step',
  BETWEEN_DEPENDENT_STEPS: 'between_dependent_steps',
});

export const INTERRUPTION_BOUNDARIES = Object.freeze(Object.values(INTERRUPTION_BOUNDARY));

// What each boundary is expected to leave behind, in the words the tests assert. A boundary whose
// signature the records do not carry is reported as such rather than fitted to the nearest one.
export const BOUNDARY_SIGNATURE = Object.freeze({
  [INTERRUPTION_BOUNDARY.BEFORE_STEP_CREATION]: 'an approved plan with no activation record and no task in the task log',
  [INTERRUPTION_BOUNDARY.AFTER_STEP_CREATION]: 'a task whose steps are all pending with no operation link, and no step record in the audit log',
  [INTERRUPTION_BOUNDARY.AFTER_RUNNING_RECORDED]: 'a step recorded as running with an operation id allocated, no audit record for that id, and the effect it would produce absent',
  [INTERRUPTION_BOUNDARY.DURING_EXECUTION]: 'a step recorded as running, its effect present, and no audit record for it',
  [INTERRUPTION_BOUNDARY.AFTER_EXECUTION_BEFORE_VERIFICATION]: 'a step recorded as running with its effect present, and no audit record, because the verifier never ran',
  [INTERRUPTION_BOUNDARY.AFTER_VERIFICATION_BEFORE_FINALIZATION]: 'a step recorded as running while its effect and its verification both happened and the audit append never landed',
  [INTERRUPTION_BOUNDARY.AFTER_FINALIZATION_BEFORE_NEXT_STEP]: 'a completed step whose audit record ends success_verified, with the following step still pending and no operation link',
  [INTERRUPTION_BOUNDARY.BETWEEN_DEPENDENT_STEPS]: 'a verified step and a dependent step that was never started, with the run stopped between them',
});

const TERMINAL_STEP = new Set([
  StepStatus.COMPLETED, StepStatus.FAILED, StepStatus.UNCERTAIN, StepStatus.SKIPPED, StepStatus.CANCELLED,
]);

// The plan bytes an approval binds. A plan whose hash moved cannot be continued on an older
// approval, so the comparison is made on the bytes and not on any wording.
function contentDigest(plan) {
  try {
    return planContentHash(plan);
  } catch {
    return null;
  }
}

function approvalState(plan) {
  const approval = plan?.approval ?? null;
  if (!approval) return { bound: false, why: 'the plan carries no recorded approval', record: { store: 'plans', ref: null } };
  const digest = contentDigest(plan);
  if (digest === null) {
    return { bound: null, why: 'the recorded plan could not be re-hashed from this read, so the approval cannot be confirmed', record: { store: 'plans', ref: shortId(plan.id) } };
  }
  if (digest !== approval.contentHash) {
    return { bound: false, why: `the approval names content ${shortId(approval.contentHash)} and the plan now hashes to ${shortId(digest)}`, record: { store: 'plans', ref: shortId(plan.id) } };
  }
  if (approval.version !== plan.version) {
    return { bound: false, why: `the approval names version ${approval.version} and the plan is version ${plan.version}`, record: { store: 'plans', ref: shortId(plan.id) } };
  }
  return { bound: true, why: `the approval binds the plan bytes at version ${plan.version}`, record: { store: 'plans', ref: shortId(plan.id) } };
}

// The audit record for one step, matched exactly the way the runner matches it: this task, this step,
// the `task.step` capability. A record that names a different step is not evidence about this one.
function stepRecord(operations, task, step) {
  if (!operations) return { found: null, readable: false };
  const found = operations.find((op) => op?.capability === 'task.step'
    && op?.task?.id === task?.id && op?.task?.stepId === step?.id);
  return { found: found ?? null, readable: true };
}

// The step's own operation id as recorded, which is the claim the runner wrote before executing.
// A step whose recorded id has no matching record is the case the whole module exists for.
function recordedOperation(step) {
  return typeof step?.operationId === 'string' && step.operationId.length > 0 ? step.operationId : null;
}

// One step, in the state its records put it in. `why` states the reading and `evidence` names the
// record it came from, so a reader who disagrees can go and look.
function stepStateOf({ step, task, plan, operations, auditReadable, lock, registry, depsVerified, constraints, approval }) {
  const op = stepRecord(operations, task, step);
  const recorded = recordedOperation(step);
  const permission = step.permission ?? registry?.get?.(step.action)?.permission ?? null;
  const base = {
    id: step.id,
    action: step.action ?? null,
    permission,
    recordedStatus: step.status ?? null,
    recordedOutcome: step.outcome ?? null,
    operation: op.found ? shortId(op.found.id) : (recorded ? `${shortId(recorded)} recorded, no such audit record` : null),
    boundary: null,
    blockingDeps: [],
  };
  const evidence = (ref, note) => ({ record: { store: ref.store, ref: ref.ref }, note });

  switch (step.status) {
    case StepStatus.COMPLETED: {
      if (!op.readable) {
        return {
          ...base,
          state: ContinuationState.OUTCOME_UNCERTAIN,
          why: 'the task log records it completed and the audit log could not be read, so its verification was not checked here',
          evidence: evidence({ store: 'tasks', ref: shortId(task.id) }),
          mayRun: 'nothing runs again: its recorded outcome stands until the audit can be read',
        };
      }
      if (!op.found) {
        // The task log claims a verified step and the audit holds nothing for it. That is a thinner
        // claim than a verification, and it is not the same thing as a failure either.
        return {
          ...base,
          state: ContinuationState.VERIFIED_SUCCESSFUL,
          boundary: null,
          why: `the task log records it completed${recorded ? ` as operation ${shortId(recorded)}` : ''}; its own audit record was not found, so this rests on the task log alone`,
          evidence: evidence({ store: 'tasks', ref: shortId(task.id) }),
          mayRun: 'it does not run again; a later step that needs its result reads the recorded outcome',
          thin: true,
        };
      }
      if (op.found.status !== Outcome.SUCCESS_VERIFIED) {
        return {
          ...base,
          state: ContinuationState.OUTCOME_UNCERTAIN,
          boundary: null,
          why: `the task log records it completed while its own audit record ${shortId(op.found.id)} ends ${op.found.status}: the two logs disagree, so neither is taken as the outcome`,
          evidence: evidence({ store: 'operations', ref: shortId(op.found.id) }),
          mayRun: 'it does not run again, and no state is built on either record until the disagreement is read',
          contradictory: true,
        };
      }
      return {
        ...base,
        state: ContinuationState.VERIFIED_SUCCESSFUL,
        why: `its own audit record ${shortId(op.found.id)} ends ${op.found.status}, which is what the action's verifier re-read`,
        evidence: evidence({ store: 'operations', ref: shortId(op.found.id) }),
        mayRun: 'it does not run again; a verified result stands',
      };
    }

    case StepStatus.UNCERTAIN: {
      const uncertainWrite = permission !== 'read';
      return {
        ...base,
        state: ContinuationState.OUTCOME_UNCERTAIN,
        boundary: recorded && op.found
          ? INTERRUPTION_BOUNDARY.AFTER_EXECUTION_BEFORE_VERIFICATION
          : INTERRUPTION_BOUNDARY.DURING_EXECUTION,
        why: op.found
          ? `its audit record ${shortId(op.found.id)} ends ${op.found.status}: the action ran and was never independently verified`
          : 'the task log records it uncertain, and no audit record resolves it, so whether its effect happened is not known',
        evidence: evidence({ store: op.found ? 'operations' : 'tasks', ref: op.found ? shortId(op.found.id) : shortId(task.id) }),
        mayRun: uncertainWrite
          ? 'never: a write whose effect cannot be established is not produced a second time'
          : 'only on your explicit retry, because a read produces no record of its own',
        neverReplay: uncertainWrite,
        retryable: !uncertainWrite,
      };
    }

    case StepStatus.FAILED: {
      const outcome = step.outcome ?? op.found?.status ?? null;
      if (outcome === Outcome.VERIFICATION_UNAVAILABLE || (recorded && !op.found)) {
        // A step that reached an effect and never got a verification is uncertain, not failed,
        // whatever the task log's word for it was. The distinction decides whether it may run again.
        return {
          ...base,
          state: ContinuationState.OUTCOME_UNCERTAIN,
          boundary: INTERRUPTION_BOUNDARY.AFTER_EXECUTION_BEFORE_VERIFICATION,
          why: `the run stopped at ${outcome ?? 'a step with no audit record'}, which is not evidence that nothing happened`,
          evidence: evidence({ store: 'tasks', ref: shortId(task.id) }),
          mayRun: permission === 'read'
            ? 'only on your explicit retry'
            : 'never: its effect cannot be established, so a second attempt would add a second record',
          neverReplay: permission !== 'read',
          retryable: permission === 'read',
        };
      }
      return {
        ...base,
        state: ContinuationState.VERIFIED_FAILED,
        boundary: INTERRUPTION_BOUNDARY.DURING_EXECUTION,
        why: `the step ran and its recorded result is a failure the audit holds (${outcome ?? 'no outcome recorded'})`,
        evidence: evidence({ store: op.found ? 'operations' : 'tasks', ref: op.found ? shortId(op.found.id) : shortId(task.id) }),
        mayRun: permission === 'read'
          ? 'a read failed in a way the records establish, so you may retry it explicitly'
          : 'not by APEX: a write that failed is settled by a new plan or your own correction, not by a repeat',
        retryable: permission === 'read',
      };
    }

    case StepStatus.RUNNING: {
      if (op.found && op.found.status === Outcome.SUCCESS_VERIFIED) {
        // The whole operation was finalized; only the task log never got the word. This is the
        // boundary the runner resolves from the audit without executing anything a second time.
        return {
          ...base,
          state: ContinuationState.VERIFIED_SUCCESSFUL,
          boundary: INTERRUPTION_BOUNDARY.AFTER_VERIFICATION_BEFORE_FINALIZATION,
          why: `its audit record ${shortId(op.found.id)} ends ${op.found.status} while the task log still shows it running: the effect and the verification are recorded, the completion was not`,
          evidence: evidence({ store: 'operations', ref: shortId(op.found.id) }),
          mayRun: 'it does not run again: the audit record settles it',
          resolvable: true,
        };
      }
      if (op.found) {
        // The audit record exists and it is not a success. Whether that settles the step or leaves it
        // uncertain is the record's own status, and the difference decides what a read may be tried
        // again for: an unfinished verification is not a failure the user can retry blind.
        const unsettled = op.found.status === Outcome.VERIFICATION_UNAVAILABLE;
        return {
          ...base,
          state: unsettled ? ContinuationState.OUTCOME_UNCERTAIN : ContinuationState.VERIFIED_FAILED,
          boundary: INTERRUPTION_BOUNDARY.AFTER_EXECUTION_BEFORE_VERIFICATION,
          why: `the task log still shows it running while its audit record ${shortId(op.found.id)} ends ${op.found.status}`,
          evidence: evidence({ store: 'operations', ref: shortId(op.found.id) }),
          mayRun: unsettled && permission === 'read'
            ? 'only on your explicit retry, because a read produces no record of its own'
            : (unsettled
              ? 'never: its effect cannot be established, so a second attempt would add a second record'
              : 'it does not run again on the strength of this read; the step is settled by what its record says'),
          neverReplay: unsettled && permission !== 'read',
          retryable: unsettled && permission === 'read',
        };
      }
      if (!auditReadable) {
        return {
          ...base,
          state: ContinuationState.OUTCOME_UNCERTAIN,
          boundary: INTERRUPTION_BOUNDARY.DURING_EXECUTION,
          why: 'the step is recorded as running and the audit log could not be read, so nothing here can say whether it finished',
          evidence: evidence({ store: 'tasks', ref: shortId(task.id) }),
          mayRun: 'not until the audit log can be read: an unreadable log proves nothing in either direction',
          neverReplay: permission !== 'read',
        };
      }
      // The operation id was allocated before the step executed. Whether that id appears in the
      // audit log is the difference between "the effect happened" and "cannot be told" - and its
      // absence is not proof of the absence of the effect.
      // A lock held by the command making this reading is not another process mid-run: the command
      // acquires the lock before deriving, so the only holder it can see is itself.
      const live = lock && lock.present && lock.alive === true && lock.heldByThisCommand !== true;
      if (live) {
        return {
          ...base,
          state: ContinuationState.RUNNING,
          boundary: INTERRUPTION_BOUNDARY.DURING_EXECUTION,
          why: `the step is recorded as running and a live process holds the task lock (pid ${lock.pid ?? 'unknown'}), so this run may still be in the step now`,
          evidence: evidence({ store: 'tasks', ref: shortId(task.id) }),
          mayRun: 'nothing is taken up while another process holds the run; the lock is the record that says so',
          neverReplay: true,
        };
      }
      return {
        ...base,
        state: ContinuationState.OUTCOME_UNCERTAIN,
        boundary: recorded ? INTERRUPTION_BOUNDARY.AFTER_RUNNING_RECORDED : INTERRUPTION_BOUNDARY.AFTER_STEP_CREATION,
        why: recorded
          ? `the step is recorded as running with operation ${shortId(recorded)} allocated and no such audit record, and no live process holds the task lock: the interruption fell between those two writes, and the effect it may have produced is not recorded either way`
          : 'the step is recorded as running with no operation link and no live holder of the task lock, so its outcome is not established',
        evidence: evidence({ store: 'tasks', ref: shortId(task.id) }),
        mayRun: permission === 'read'
          ? 'a read may be taken up explicitly, because it produces no record of its own'
          : 'never: taking it up again would write a second fact over one whose existence is unknown',
        neverReplay: permission !== 'read',
        retryable: permission === 'read',
      };
    }

    case StepStatus.AWAITING_APPROVAL:
      return {
        ...base,
        state: ContinuationState.AWAITING_CONFIRMATION,
        boundary: INTERRUPTION_BOUNDARY.BEFORE_STEP_CREATION,
        why: 'a write a model proposed is waiting for the user\'s own approval, which is a confirmation APEX does not hold',
        evidence: evidence({ store: 'tasks', ref: shortId(task.id) }),
        mayRun: 'only after you approve this step; nothing here approves it',
      };

    case StepStatus.CANCELLED:
      return {
        ...base,
        state: ContinuationState.REQUIRES_USER,
        why: 'the step was cancelled, which is a decision rather than an outcome',
        evidence: evidence({ store: 'tasks', ref: shortId(task.id) }),
        mayRun: 'not in this task: a cancelled step is settled by a new plan the user records',
      };

    case StepStatus.SKIPPED:
      return {
        ...base,
        state: ContinuationState.BLOCKED,
        blockingDeps: (step.dependsOn ?? []).filter((d) => !depsVerified.get(d)),
        boundary: INTERRUPTION_BOUNDARY.BETWEEN_DEPENDENT_STEPS,
        why: step.summary ? singleLine(step.summary, BOUNDS.maxReasonChars) : 'it depends on a step that did not complete',
        evidence: evidence({ store: 'tasks', ref: shortId(task.id) }),
        mayRun: 'only after the step it depends on holds a verified success',
      };

    case StepStatus.PENDING:
      break;

    default:
      return {
        ...base,
        state: ContinuationState.REQUIRES_USER,
        why: `the task log records a step status this vocabulary does not know (${String(step.status ?? 'missing')})`,
        evidence: evidence({ store: 'tasks', ref: shortId(task.id) }),
        mayRun: 'nothing is taken up on the strength of a status that cannot be read',
      };
  }

  // PENDING. The plan bytes, the approval, the registry, the constraints and the dependencies all
  // have to answer for the step before it is called safe - which is why this branch is last.
  const unmet = (step.dependsOn ?? []).filter((d) => !depsVerified.get(d));
  if (unmet.length > 0) {
    return {
      ...base,
      state: ContinuationState.BLOCKED,
      blockingDeps: unmet,
      boundary: INTERRUPTION_BOUNDARY.BETWEEN_DEPENDENT_STEPS,
      why: `it has not run, and its dependencies ${unmet.join(', ')} hold no verified success`,
      evidence: evidence({ store: 'tasks', ref: shortId(task.id) }),
      mayRun: 'only when the steps it depends on are settled',
    };
  }
  if (approval?.bound === null || approval?.bound === false) {
    return {
      ...base,
      state: ContinuationState.REQUIRES_USER,
      why: `it has not run, and the approval on the plan no longer binds the bytes the step belongs to: ${approval.why}`,
      evidence: evidence({ store: 'plans', ref: shortId(plan?.id ?? '') }),
      mayRun: 'not until the plan is approved again; a continuation is not a way to keep an old approval alive',
    };
  }
  const auth = registry?.authorize?.(step.action, 'user');
  if (!registry || auth?.decision !== 'allow') {
    return {
      ...base,
      state: ContinuationState.REQUIRES_USER,
      why: `it has not run, and the live registry no longer authorizes ${step.action} for this step (${auth?.reason ?? 'no registry was readable'})`,
      evidence: evidence({ store: 'registry', ref: step.action ?? null }),
      mayRun: 'not while the registry refuses the capability; the step is authorized again when it runs, and that answer is the registry\'s',
    };
  }
  const finding = constraints ? constraintFinding(constraints, { steps: [step], strategy: plan?.id ?? 'plan' }) : null;
  if (finding && finding.passed === false) {
    return {
      ...base,
      state: ContinuationState.BLOCKED,
      why: `it has not run, and a recorded constraint stops it: ${singleLine(finding.detail, BOUNDS.maxReasonChars)}`,
      evidence: evidence({ store: 'goals', ref: shortId(plan?.goalId ?? '') }),
      mayRun: 'only after the record that gates it is cleared, discharged, or retracted',
      gates: (finding.blockedBy ?? []).map((b) => b.class),
    };
  }
  return {
    ...base,
    state: ContinuationState.SAFE_TO_CONTINUE,
    boundary: null,
    why: 'it has no operation link and no audit record, every step it depends on holds a verified success, the approval still binds these bytes, the registry authorizes its action, and no recorded constraint stops it',
    evidence: evidence({ store: 'tasks', ref: shortId(task.id) }),
    mayRun: 'it may be taken up: the run it belongs to never started it, and these are the records that say so',
    runnable: true,
  };
}

// Where the run as a whole stands. The order is a precedence, not a vote, and it is the order a
// reader has to act in: a live process owns the run before anything else is said about it; a write
// whose effect cannot be established is the user's to settle, because APEX can neither replay it nor
// call it absent; a read in the same state is simply unknown; a plan whose steps are all verified is
// settled only when the plan record says so.
function rollUp(rows, task, plan) {
  const has = (state) => rows.some((r) => r.state === state);
  if (has(ContinuationState.RUNNING)) return ContinuationState.RUNNING;
  const uncertainWrites = rows.filter((r) => r.state === ContinuationState.OUTCOME_UNCERTAIN && r.permission !== 'read');
  if (uncertainWrites.length > 0) return ContinuationState.REQUIRES_USER;
  if (has(ContinuationState.REQUIRES_USER)) return ContinuationState.REQUIRES_USER;
  if (has(ContinuationState.OUTCOME_UNCERTAIN)) return ContinuationState.OUTCOME_UNCERTAIN;
  if (has(ContinuationState.AWAITING_CONFIRMATION)) return ContinuationState.AWAITING_CONFIRMATION;
  if (rows.length > 0 && rows.every((r) => r.state === ContinuationState.VERIFIED_SUCCESSFUL)) {
    return plan?.status === PlanStatus.COMPLETED
      ? ContinuationState.VERIFIED_SUCCESSFUL
      : ContinuationState.REQUIRES_USER;
  }
  if (has(ContinuationState.VERIFIED_FAILED)) return ContinuationState.VERIFIED_FAILED;
  if (has(ContinuationState.SAFE_TO_CONTINUE)) {
    // Nothing of this run ever began, which is a different answer from "some of it began and the rest
    // is waiting": the first is a run that has not started, the second is a partially executed one.
    return rows.every((r) => r.state === ContinuationState.SAFE_TO_CONTINUE)
      ? ContinuationState.NOT_STARTED
      : ContinuationState.SAFE_TO_CONTINUE;
  }
  if (has(ContinuationState.BLOCKED)) return ContinuationState.BLOCKED;
  return task?.status === TaskStatus.PENDING ? ContinuationState.NOT_STARTED : ContinuationState.REQUIRES_USER;
}

// The revalidation, as one line per check with the record it read. `validity` is the live plan
// validity the caller already computed, folded in rather than recomputed here: the two answers have
// to agree, and one derivation is the only way they can.
function revalidationOf({ plan, task, approval, validity, constraints, steps, registry }) {
  const checks = [];
  const digest = contentDigest(plan);
  checks.push({
    check: 'plan_bytes',
    ok: digest !== null,
    detail: digest === null
      ? 'the recorded plan could not be re-hashed, so no continuation can be bound to its content'
      : `the plan re-hashes to ${shortId(digest)} at version ${plan.version}`,
    record: { store: 'plans', ref: shortId(plan.id) },
  });
  checks.push({
    check: 'approval',
    ok: approval.bound === true,
    detail: approval.why,
    record: approval.record,
  });
  // A closed plan is a settled record, and taking its steps up again would reopen a decision the user
  // already made with `plan cancel`, `plan supersede`, or a run that finished. The step states below
  // still describe the run as it was left; nothing may be taken up from a plan that has closed.
  checks.push({
    check: 'plan_open',
    ok: isOpenPlan(plan.status),
    detail: isOpenPlan(plan.status)
      ? `the plan records itself ${plan.status}, which is work still open`
      : `the plan records itself ${plan.status}, and a closed plan is not work to take up again: reopening it is a decision the user makes, not a continuation`,
    record: { store: 'plans', ref: shortId(plan.id) },
  });
  // A pause is a decision recorded against the plan, not a gap in the run. Taking steps up while it
  // stands would be this command overturning the user's hold, so the reading refuses and names the
  // command that lifts it. Lifting the hold is `plan resume`, which checks the same records again.
  checks.push({
    check: 'plan_held',
    ok: plan.status !== PlanStatus.PAUSED,
    detail: plan.status === PlanStatus.PAUSED
      ? 'a pause is recorded against this plan, so no step is taken up until the user resumes it ("plan resume")'
      : `no pause is recorded against this plan (it records itself ${plan.status})`,
    record: { store: 'plans', ref: shortId(plan.id) },
  });
  const stepProblems = dependencyProblems(plan.steps ?? []);
  checks.push({
    check: 'step_structure',
    ok: stepProblems.length === 0,
    detail: stepProblems.length === 0 ? 'the steps and their dependencies replay in order' : stepProblems.join('; '),
    record: { store: 'plans', ref: shortId(plan.id) },
  });
  const unregistered = steps.filter((r) => r.state === ContinuationState.REQUIRES_USER && /registry/.test(r.why)).map((r) => r.id);
  checks.push({
    check: 'registry',
    ok: unregistered.length === 0 && registry != null,
    detail: registry == null
      ? 'no action registry was readable, so no step can be shown to be authorized'
      : (unregistered.length === 0
        ? `every step that may be taken up names a capability the live registry authorizes (${registry.names().length} registered)`
        : `the registry now refuses the action of ${unregistered.join(', ')}`),
    record: { store: 'registry', ref: null },
  });
  checks.push({
    check: 'constraints',
    ok: constraints != null || !plan.goalId,
    detail: !plan.goalId
      ? 'the plan names no goal, so no constraint is recorded against the work it does'
      : (constraints == null
        ? 'the goal\'s constraints could not be read, so a blocker recorded after approval would not be seen here and nothing is taken up on that gap'
        : ((constraints.gating ?? []).length === 0
          ? `${(constraints.constraints ?? []).length} item(s) on record, none able to stop work`
          : `${constraints.gating.length} recorded constraint(s) gate this plan's own steps: ${(constraints.constraints ?? []).filter((c) => constraints.gating.includes(c.id)).map((c) => c.class).join(', ')}`)),
    record: { store: 'goals', ref: plan.goalId ? shortId(plan.goalId) : null },
  });
  // A run whose every step holds a verified success is only settled when the plan record says so too.
  // The plan's own status is what the user's later commands act on, so the derivation reads it rather
  // than concluding it.
  const everyStepVerified = steps.length > 0 && steps.every((r) => r.state === ContinuationState.VERIFIED_SUCCESSFUL);
  checks.push({
    check: 'plan_status',
    ok: !everyStepVerified || plan.status === PlanStatus.COMPLETED,
    detail: everyStepVerified
      ? (plan.status === PlanStatus.COMPLETED
        ? 'every step holds a verified success and the plan records itself completed'
        : `every step holds a verified success and the plan still records itself ${plan.status}, so the reconciliation is what has not run`)
      : `${steps.filter((r) => r.state === ContinuationState.VERIFIED_SUCCESSFUL).length} of ${steps.length} step(s) hold a verified success`,
    record: { store: 'plans', ref: shortId(plan.id) },
  });
  for (const c of validity?.checks ?? []) {
    checks.push({
      check: `validity_${c.check}`,
      ok: c.ok === true,
      detail: singleLine(c.detail, BOUNDS.maxReasonChars),
      record: { store: c.check === 'goal' || c.check === 'goal-revision' || c.check === 'goal-dependencies' ? 'goals' : 'plans', ref: plan.goalId ? shortId(plan.goalId) : shortId(plan.id) },
    });
  }
  checks.push({
    check: 'task_belongs_to_plan',
    ok: Boolean(task?.planId) && task.planId === plan.id,
    detail: task?.planId === plan.id
      ? `task ${shortId(task.id)} names this plan`
      : `task ${shortId(task?.id ?? '')} does not name plan ${shortId(plan.id)}, so its steps are not this plan's to continue`,
    record: { store: 'tasks', ref: task ? shortId(task.id) : null },
  });
  return checks;
}

// The continuation reading of one plan and the task that was running it.
//
// `operations` is the audit log as read (null when it could not be read at all, which keeps every
// interrupted outcome unknown rather than absent); `lock` is `taskStore.lockState()`; `constraints`
// is a constraint ledger for the plan's goal; `validity` is `assessPlanValidity` for the plan.
// Everything else is derived from those.
export function continuationOf({
  plan, task, operations = null, registry = null, constraints = null, validity = null,
  lock = null, auditReadable = true, goal = null, now = null,
} = {}) {
  if (!plan || !task || !Array.isArray(task.steps)) {
    return {
      schema: CONTINUATION_SCHEMA,
      ok: false,
      states: CONTINUATION_STATES,
      steps: [],
      counts: {},
      revalidation: [],
      blockers: [],
      whatWouldSettleIt: [],
      continue: { safe: false, runnable: [], neverReplay: [], awaiting: [], blockedByRun: [], requiresUser: [] },
      problems: [!plan ? 'no plan record was supplied' : 'no task record was supplied for this plan'],
      note: CONTINUATION_NOTE,
    };
  }

  const approval = approvalState(plan);
  const byId = new Map(task.steps.map((s) => [s.id, s]));
  // A dependency is verified only when the step's own audit record says so, or the task log records
  // it completed with no contradicting record - the thinner of the two, and marked as such below.
  const ops = auditReadable ? operations : null;
  const verified = new Map();
  const preRows = task.steps.map((step) => {
    const op = stepRecord(ops, task, step);
    verified.set(step.id, step.status === StepStatus.COMPLETED && (!op.found || op.found.status === Outcome.SUCCESS_VERIFIED));
    return step;
  });
  const rows = preRows.map((step) => stepStateOf({
    step,
    task,
    plan,
    operations: ops,
    auditReadable,
    lock,
    registry,
    depsVerified: verified,
    constraints: step.status === StepStatus.PENDING ? constraints : null,
    approval,
  }));
  void byId;

  const counts = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;

  const runnable = rows.filter((r) => r.runnable === true).map((r) => r.id);
  const neverReplay = rows.filter((r) => r.neverReplay === true).map((r) => r.id);
  const awaiting = rows.filter((r) => r.state === ContinuationState.AWAITING_CONFIRMATION).map((r) => r.id);
  const blockedByRun = rows.filter((r) => r.state === ContinuationState.BLOCKED).map((r) => r.id);
  const requiresUser = rows.filter((r) => r.state === ContinuationState.REQUIRES_USER).map((r) => r.id);
  const contradictory = rows.filter((r) => r.contradictory === true).map((r) => r.id);
  const thin = rows.filter((r) => r.thin === true).map((r) => r.id);
  const running = rows.filter((r) => r.state === ContinuationState.RUNNING).map((r) => r.id);

  const revalidation = revalidationOf({ plan, task, approval, validity, constraints, steps: rows, registry });
  const failedChecks = revalidation.filter((c) => c.ok !== true);
  const blockers = failedChecks.map((c) => `${c.check}: ${c.detail}`);
  for (const row of rows) {
    if (row.state === ContinuationState.OUTCOME_UNCERTAIN || row.state === ContinuationState.REQUIRES_USER) {
      blockers.push(`step ${row.id} is ${row.state}: ${row.why}`);
    }
  }

  const uncertain = rows.filter((r) => r.state === ContinuationState.OUTCOME_UNCERTAIN).map((r) => r.id);
  // The one decision this derivation is allowed to reach: whether anything may be taken up. Every
  // clause is a refusal, and each names what it refused on - an unreadable audit log, a live holder of
  // the run, a step whose effect cannot be established, a step the records hand back to the user, an
  // approval that no longer binds these bytes, a registry that now refuses, a recorded constraint, a
  // goal that moved. `runnable` alone is never enough, because a step may be proven untouched in a run
  // that is not safe to continue.
  const safe = failedChecks.length === 0
    && running.length === 0
    && requiresUser.length === 0
    && uncertain.length === 0
    && auditReadable
    && runnable.length > 0;
  const whatWouldSettleIt = [];
  if (running.length > 0) {
    whatWouldSettleIt.push('the process that holds the task lock to finish or exit; while it lives, this run is not this command\'s to take up');
  }
  if (!auditReadable) {
    whatWouldSettleIt.push('the operation log to be readable again: while it is not, no interrupted step can be resolved from its own record, and none is taken up');
  }
  for (const id of neverReplay) {
    const r = rows.find((x) => x.id === id);
    whatWouldSettleIt.push(`step ${id}: ${r.permission === 'read'
      ? `an explicit retry of the read ("task retry ${shortId(task.id)} ${id}") is the only way it is taken up`
      : `the effect of step ${id} cannot be established from its records, so a new plan the user records is the way forward - "plan replan ${shortId(plan.id)}" or "plan revise ${shortId(plan.id)}" and a fresh approval`}`);
  }
  for (const r of rows.filter((x) => x.retryable === true && x.state !== ContinuationState.OUTCOME_UNCERTAIN)) {
    whatWouldSettleIt.push(`step ${r.id} is a read whose failure the records establish: "task retry ${shortId(task.id)} ${r.id}" is the user's own command for it, and no continuation runs it by itself`);
  }
  if (approval.bound !== true) {
    whatWouldSettleIt.push('a fresh approval of the plan as it now stands: "plan approve ' + shortId(plan.id) + '" - because a continuation on an approval that no longer binds these bytes would be a new authority, not the old one');
  }
  for (const c of failedChecks) {
    if (c.check === 'constraints') whatWouldSettleIt.push('the recorded constraint cleared, discharged, or retracted on the goal it is written');
    else if (c.check === 'registry') whatWouldSettleIt.push('the capability registered again, or the plan revised so its steps name one that is');
    else if (c.check === 'task_belongs_to_plan') whatWouldSettleIt.push('the task this plan actually activated');
    else if (c.check === 'plan_bytes') whatWouldSettleIt.push('a plan record that can be read and re-hashed');
    else if (c.check === 'plan_held') whatWouldSettleIt.push('the user lifting the hold themselves: "plan resume ' + shortId(plan.id) + '" is that decision, and no continuation takes it for them');
  }
  if (contradictory.length > 0) {
    whatWouldSettleIt.push(`the disagreement in step(s) ${contradictory.join(', ')} read: the task log and the audit log do not agree, and this read does not pick which one to believe`);
  }

  const nextCommand = safe
    ? `plan continue ${shortId(plan.id)}`
    : plan.status === PlanStatus.PAUSED
      ? `plan resume ${shortId(plan.id)}`
      : (requiresUser.length > 0 || approval.bound === false || failedChecks.length > 0)
        ? `plan show ${shortId(plan.id)}`
        : `task show ${shortId(task.id)}`;

  return {
    schema: CONTINUATION_SCHEMA,
    ok: true,
    note: CONTINUATION_NOTE,
    rule: CONTINUATION_RULE,
    states: CONTINUATION_STATES,
    evidence: CONTINUATION_EVIDENCE,
    at: now instanceof Date ? now.toISOString() : (typeof now === 'string' ? now : null),
    plan: {
      id: plan.id,
      status: plan.status,
      version: plan.version,
      goalId: plan.goalId ?? null,
      goalRevision: plan.goalRevision ?? null,
      goalStatus: goal?.status ?? null,
      contentDigest: contentDigest(plan),
      approval: {
        bound: approval.bound,
        why: approval.why,
        version: plan.approval?.version ?? null,
        contentHash: plan.approval?.contentHash ?? null,
      },
      activation: plan.activation ? { taskId: plan.activation.taskId, at: plan.activation.at ?? null } : null,
    },
    task: {
      id: task.id,
      status: task.status,
      origin: task.origin ?? null,
      planId: task.planId ?? null,
      steps: task.steps.length,
      lock: lock
        ? {
          present: lock.present === true,
          alive: lock.alive ?? null,
          pid: lock.pid ?? null,
          ...(lock.heldByThisCommand === true ? { heldByThisCommand: true } : {}),
        }
        : null,
      auditReadable,
    },
    runState: rollUp(rows, task, plan),
    steps: rows.map((r) => ({
      id: r.id,
      action: r.action,
      permission: r.permission,
      recordedStatus: r.recordedStatus,
      recordedOutcome: r.recordedOutcome,
      operation: r.operation,
      state: r.state,
      why: r.why,
      evidence: r.evidence,
      mayRun: r.mayRun,
      boundary: r.boundary,
      blockingDeps: r.blockingDeps,
      ...(r.gates ? { gates: r.gates } : {}),
      ...(r.thin ? { thinEvidence: true } : {}),
      ...(r.contradictory ? { contradictory: true } : {}),
      ...(r.resolvable || r.resolvableFromAudit ? { resolvableFromAudit: true } : {}),
      ...(r.retryable ? { retryable: true } : {}),
      ...(r.neverReplay ? { neverReplay: true } : {}),
    })),
    counts,
    continue: {
      safe,
      runnable,
      neverReplay,
      uncertain: rows.filter((r) => r.state === ContinuationState.OUTCOME_UNCERTAIN).map((r) => r.id),
      retryableReads: rows.filter((r) => r.retryable === true).map((r) => r.id),
      awaiting,
      blockedByRun,
      requiresUser,
      running,
    },
    progress: {
      verified: rows.filter((r) => r.state === ContinuationState.VERIFIED_SUCCESSFUL).length,
      total: rows.length,
    },
    revalidation,
    blockers,
    whatWouldSettleIt,
    nextCommand,
    // The claims the answer has to be able to make about itself: this read started nothing, wrote
    // nothing, authorized nothing, and left the plan's and the task's history exactly as it found it.
    writes: false,
    runs: false,
    authorizes: false,
    historyPreserved: true,
    digest: continuationDigestValue({ plan, task, rows, lock, auditReadable }),
  };
}

// A digest of the reading, over ids, states and record references only - never prose. Two readers
// that disagree about a step's state must produce different digests; a re-wording must not.
function continuationDigestValue({ plan, task, rows, lock, auditReadable }) {
  const shape = {
    planId: shortId(plan?.id ?? ''),
    planVersion: plan?.version ?? null,
    planStatus: plan?.status ?? null,
    approval: [shortId(plan?.approval?.contentHash ?? ''), plan?.approval?.version ?? null],
    taskId: shortId(task?.id ?? ''),
    taskStatus: task?.status ?? null,
    auditReadable,
    lock: lock ? [lock.present === true ? 1 : 0, lock.alive === true ? 1 : lock.alive === false ? 0 : '?'] : null,
    steps: rows.map((r) => [r.id, r.state, r.recordedStatus, r.operation ?? null]),
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

export function continuationDigest(continuation) {
  return continuation?.digest ?? null;
}

// The compact form an audited answer carries: the counts, the states that stop a continuation, and
// the record references. Enough to compare against an independent re-read, small enough to print.
export function continuationAudit(continuation) {
  if (!continuation) return null;
  return {
    runState: continuation.runState ?? null,
    counts: continuation.counts ?? {},
    safe: continuation.continue?.safe ?? false,
    runnable: continuation.continue?.runnable ?? [],
    neverReplay: continuation.continue?.neverReplay ?? [],
    awaiting: continuation.continue?.awaiting ?? [],
    requiresUser: continuation.continue?.requiresUser ?? [],
    blockers: (continuation.blockers ?? []).slice(0, BOUNDS.maxListedRecords),
    steps: (continuation.steps ?? []).map((s) => [s.id, s.state, s.recordedStatus, s.operation ?? null]),
    digest: continuation.digest ?? null,
  };
}

// The print: the run's state, then each step with the record that put it there, then what stands in
// the way and what would clear it. Bounded like every other view in this layer, and it keeps the
// states that stop a continuation in the part of the answer that survives a cut.
export function renderContinuation(continuation, { indent = '', maxSteps = BOUNDS.maxNamedSteps } = {}) {
  if (!continuation) return `${indent}No continuation reading was taken, so nothing is claimed about what may be taken up.`;
  if (continuation.ok !== true) {
    return [`${indent}No continuation reading could be taken:`,
      ...(continuation.problems ?? []).map((p) => `${indent}  - ${p}`)].join('\n');
  }
  const lines = [
    `${indent}Continuation of plan ${shortId(continuation.plan.id)} (version ${continuation.plan.version}, ${continuation.plan.status}) as task ${shortId(continuation.task.id)} (${continuation.task.status}).`,
    `${indent}  the run is: ${continuation.runState}`,
    `${indent}  steps: ${continuation.progress.verified} of ${continuation.progress.total} hold a verified success; ${continuation.continue.runnable.length} may be taken up, ${continuation.continue.neverReplay.length} must not be run again.`,
    `${indent}  the reading ran nothing, approved nothing, and left the plan's and task's history as it found it.`,
  ];
  if (continuation.task.lock) {
    const lock = continuation.task.lock;
    lines.push(`${indent}  task lock: ${lock.present
      ? lock.heldByThisCommand === true
        ? 'held by this command'
        : `held${lock.alive === true ? ' by a live process' : lock.alive === false ? ' by a process that has exited' : ' by a process this read cannot identify'}`
      : 'free'}.`);
  }
  const notable = continuation.steps.filter((s) => s.recordedStatus !== StepStatus.PENDING || s.state !== ContinuationState.SAFE_TO_CONTINUE);
  lines.push(`${indent}  what each step's records say (${continuation.steps.length} step(s)):`);
  for (const s of notable.slice(0, maxSteps)) {
    lines.push(`${indent}    - ${s.id} (${s.action}, ${s.permission ?? 'unstated'}): ${s.state}`);
    lines.push(`${indent}        read from: ${s.evidence?.record?.store ?? 'the records'}${s.evidence?.record?.ref ? ` ${s.evidence.record.ref}` : ''}: ${singleLine(s.why, BOUNDS.maxReasonChars)}`);
    lines.push(`${indent}        ${singleLine(s.mayRun, BOUNDS.maxReasonChars)}`);
  }
  if (notable.length > maxSteps) {
    lines.push(`${indent}    ... and ${notable.length - maxSteps} more step(s) the same records describe.`);
  }
  if (continuation.revalidation.length > 0) {
    lines.push(`${indent}  re-read before any continuation:`);
    for (const c of continuation.revalidation) {
      lines.push(`${indent}    ${c.ok === true ? 'ok' : 'NOT OK'}  ${c.check}: ${singleLine(c.detail, BOUNDS.maxReasonChars)}`);
    }
  }
  if (continuation.blockers.length > 0) {
    lines.push(`${indent}  what stands in the way (${continuation.blockers.length}):`);
    for (const b of continuation.blockers.slice(0, BOUNDS.maxListedRecords)) {
      lines.push(`${indent}    - ${singleLine(b, BOUNDS.maxReasonChars)}`);
    }
  }
  for (const w of continuation.whatWouldSettleIt.slice(0, 4)) {
    lines.push(`${indent}  what would settle it: ${singleLine(w, BOUNDS.maxReasonChars)}`);
  }
  lines.push(`${indent}  next: ${continuation.nextCommand}`);
  lines.push(`${indent}  ${continuation.note}`);
  return lines.join('\n');
}
