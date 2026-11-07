// Task runner: sequences the steps of a task. It owns task state transitions and
// nothing else. Each step is executed by the controller's own action path (the
// `execute` callback: authorization, execution, verification), so there is one
// policy and one verifier. The state of every step is written to the task log
// before the next step starts, and each step is also written to the operation log
// with a link back to its task.
//
// Stop rules: a failed or uncertain step stops the task, and steps that depend on it
// are marked skipped. A write step proposed by a model waits for the user's explicit
// approval. Nothing is retried automatically. An interrupted step is resolved from its
// own audit record when that record exists; otherwise its outcome stays unknown.
import { Outcome, OPERATION_SCHEMA } from '../outcomes.js';
import { StoreError, ValidationError } from '../errors.js';
import { APP_NAME, APP_STAGE } from '../identity.js';
import { truncate, shortId, redact } from '../util.js';
import { StepStatus, TaskStatus, topologicalOrder, dependentsOf, progressOf, inputHash } from '../tasks/model.js';

// Maps a step's verified outcome to the next state. Only a verified success lets
// the task continue. An unconfirmed result is uncertain, never success.
function stepResultFor(outcome) {
  if (outcome === Outcome.SUCCESS_VERIFIED) return { step: StepStatus.COMPLETED, task: TaskStatus.RUNNING };
  if (outcome === Outcome.VERIFICATION_UNAVAILABLE) return { step: StepStatus.UNCERTAIN, task: TaskStatus.FAILED };
  return { step: StepStatus.FAILED, task: TaskStatus.FAILED };
}

function stripDisplay(step) {
  const { display, ...rest } = step;
  return rest;
}

export class TaskRunner {
  constructor({ store, execute, recordOperation, readOperations = null, idFactory }) {
    this.store = store;
    this.execute = execute; // (actionName, input, origin, operationId) => step (the controller's action path)
    this.recordOperation = recordOperation; // (operationRecord) => Promise<void>, throws on failure
    this.readOperations = readOperations; // () => Promise<operationRecord[]>, read-only, for recovery evidence
    this.idFactory = idFactory;
  }

  // Who a step runs as. A user's own task runs as the user. A model's proposal runs as
  // the model, except a write step the user has approved individually.
  stepOrigin(task, step) {
    if (task.origin === 'user') return 'user';
    return step.approval ? 'user' : 'model';
  }

  // The step to act on next, in dependency order. A failed or uncertain step blocks
  // everything after it: the stop rule applies to the whole task.
  nextStep(task) {
    const byId = new Map(task.steps.map((s) => [s.id, s]));
    for (const id of topologicalOrder(task.steps)) {
      const s = byId.get(id);
      if (s.status === StepStatus.FAILED || s.status === StepStatus.UNCERTAIN) return { blocked: s, step: null };
      if (s.status === StepStatus.PENDING || s.status === StepStatus.AWAITING_APPROVAL) return { blocked: null, step: s };
    }
    return { blocked: null, step: null };
  }

  // The step a continuation may take up: pending, with every dependency holding a completed
  // outcome. A step that ran and failed, or ran and cannot be established, is not pending and so is
  // never chosen here; a step whose dependency is one of those stays pending and is reported as
  // left behind rather than skipped. This is the selector that makes partial execution resumable
  // without relaxing anything about a step whose effect is unknown.
  nextContivableStep(task) {
    const byId = new Map(task.steps.map((s) => [s.id, s]));
    for (const id of topologicalOrder(task.steps)) {
      const s = byId.get(id);
      if (s.status !== StepStatus.PENDING) continue;
      const unmet = (s.dependsOn ?? []).filter((d) => byId.get(d)?.status !== StepStatus.COMPLETED);
      if (unmet.length === 0) return s;
    }
    return null;
  }

  async #task(id) {
    const task = await this.store.get(id);
    if (!task) throw new ValidationError(`no task with id ${shortId(id)}`);
    return task;
  }

  async #transition(taskId, reason, { task = null, steps = [], approval = null } = {}) {
    return this.store.transition(taskId, { reason, task, steps, approval });
  }

  // Runs (mode 'run', from pending), resumes (mode 'resume', from paused or after an
  // interruption), or continues (mode 'continue') a task. Caller must hold the store lock.
  //
  // `continue` is Batch AM's continuation of a partially executed plan. It takes up the steps the
  // records prove never started, in dependency order, and it stops at - without touching - a step
  // whose outcome is uncertain or already verified as a failure. That is the whole of what the mode
  // adds: a step that ran and cannot be established stays exactly where its records hold it, a step
  // that depended on it is not run on the assumption that it did, and the steps that never began are
  // finished. The state machine is not extended for it: a task that stopped on a failed step is moved
  // to paused by the same transition a retry already uses, and every step is then written running
  // before it executes exactly as in a first run, so a second interruption lands on the same records
  // and is read the same way.
  async run(taskId, { mode }) {
    const continuing = mode === 'continue';
    const auditGaps = [];
    let recovery = null;
    let task = await this.#task(taskId);

    if (task.status === TaskStatus.RUNNING) {
      // No live process holds the lock, so an earlier run was interrupted. Each step
      // recorded as running is resolved from its own audit record, or left uncertain,
      // and it is never executed again.
      recovery = await this.#recover(task);
      task = await this.#task(taskId);
    }

    // A refusal below can follow a recovery. The recovery is attached to the error so the
    // caller can still record what was established: an interrupted step whose outcome is
    // unknown is a fact about the run, and it is exactly why the run is being refused.
    // It grants nothing and changes no state.
    const refuse = (message) => {
      const err = new ValidationError(message);
      if (recovery) {
        err.recovery = recovery;
        err.taskId = task.id;
      }
      throw err;
    };

    if (task.status === TaskStatus.PROPOSED) refuse(`this is a model proposal and needs your approval first: task approve ${shortId(task.id)}`);
    if (task.status === TaskStatus.COMPLETED) refuse('this task is already completed; nothing to run');
    if (task.status === TaskStatus.CANCELLED) refuse('this task was cancelled');
    if (task.status === TaskStatus.FAILED && !continuing) refuse(`this task stopped after a failed step. Retry a read-only step (task retry ${shortId(task.id)} <step>) or cancel it (task cancel ${shortId(task.id)})`);
    if (mode === 'run' && task.status !== TaskStatus.PENDING) refuse(`this task is ${task.status}; use: task resume ${shortId(task.id)}`);
    if (mode === 'resume' && task.status !== TaskStatus.PAUSED) refuse(`this task is ${task.status}; use: task run ${shortId(task.id)}`);

    if (!continuing) {
      const first = this.nextStep(task);
      if (first.blocked) {
        const s = first.blocked;
        refuse(`step ${s.id} is ${s.status} and was not run again. Retry it only if it is read-only (task retry ${shortId(task.id)} ${s.id}); otherwise cancel the task (task cancel ${shortId(task.id)})`);
      }
      if (first.step && first.step.status === StepStatus.AWAITING_APPROVAL) {
        refuse(`step ${first.step.id} needs your approval: task approve ${shortId(task.id)} --step ${first.step.id}`);
      }
    }

    // A task that stopped on a failed step is moved to paused before anything is taken up. That is
    // the transition a retry already makes, so the run that follows starts from a state the log can
    // replay, and the reason recorded here is the reason a later reader needs: which steps were left
    // where they were, and which were taken up.
    if (continuing && task.status === TaskStatus.FAILED) {
      await this.#transition(task.id, 'taken up again by the user: the steps that never started are continued, the steps that ran are left as their own records hold them', {
        task: { from: TaskStatus.FAILED, to: TaskStatus.PAUSED },
      });
      task = await this.#task(taskId);
    }

    await this.#transition(task.id, mode === 'run' ? 'started' : (continuing ? 'taken up again' : 'resumed'), {
      task: { from: task.status, to: TaskStatus.RUNNING },
    });

    // The steps this run executed, in order, with what their audit record shows. If the
    // task log then fails a write, the error carries this evidence: a step that already
    // ran and was verified must not be reported as an execution that failed. The process
    // is still alive here, so this is a record that refused a write, not a lost process.
    const executedSteps = [];
    try {
      for (;;) {
        task = await this.#task(taskId);
        const next = continuing ? this.nextContivableStep(task) : this.nextStep(task).step;
        if (!next) break;

        const origin = this.stepOrigin(task, next);
        if (next.permission === 'write' && origin === 'model') {
          // A model proposed this write. Stop before it and wait for an explicit approval.
          await this.#transition(task.id, `${next.id} waits for your approval`, {
            task: { from: TaskStatus.RUNNING, to: TaskStatus.PAUSED },
            steps: [{ id: next.id, from: StepStatus.PENDING, to: StepStatus.AWAITING_APPROVAL }],
          });
          break;
        }

        const byId = new Map(task.steps.map((s) => [s.id, s]));
        const unmet = next.dependsOn.filter((d) => byId.get(d).status !== StepStatus.COMPLETED);
        if (unmet.length) {
          await this.#transition(task.id, `stopped: ${next.id} depends on steps that did not complete (${unmet.join(', ')})`, {
            task: { from: TaskStatus.RUNNING, to: TaskStatus.FAILED },
          });
          break;
        }

        // Recorded as running before it executes. If the process dies after this point,
        // the next run finds an unknown outcome and does not repeat the step.
        const operationId = this.idFactory();
        await this.#transition(task.id, `running ${next.id}`, {
          steps: [{ id: next.id, from: StepStatus.PENDING, to: StepStatus.RUNNING, operationId }],
        });

        const step = await this.execute(next.action, next.input, origin, operationId);
        const audited = await this.#audit(task, next, step, operationId, origin);
        if (!audited) auditGaps.push(next.id);
        executedSteps.push({ id: next.id, action: next.action, outcome: step.outcome, operationId, auditRecorded: audited });

        const result = stepResultFor(step.outcome);
        if (result.step === StepStatus.COMPLETED) {
          await this.#transition(task.id, `${next.id} completed`, {
            steps: [{ id: next.id, from: StepStatus.RUNNING, to: StepStatus.COMPLETED, outcome: step.outcome, summary: truncate(step.summary, 300), operationId }],
          });
          continue;
        }

        const skip = dependentsOf(task.steps, next.id).filter((id) => byId.get(id).status === StepStatus.PENDING);
        await this.#transition(task.id, `${next.id} ${result.step}: ${truncate(step.summary, 200)}`, {
          // A continuation records the step that stopped and stops taking up that branch; it does
          // not move the task, because the run is going on with the steps that never began. The task
          // state is written once, at the end, from what the records then hold. A first run keeps its
          // own rule and moves the task to the failure state here, exactly as it did before.
          task: continuing ? null : { from: TaskStatus.RUNNING, to: result.task },
          steps: [
            { id: next.id, from: StepStatus.RUNNING, to: result.step, outcome: step.outcome, summary: truncate(step.summary, 300), operationId },
            ...skip.map((id) => ({ id, from: StepStatus.PENDING, to: StepStatus.SKIPPED, summary: `not run: depends on ${next.id}` })),
          ],
        });
        if (!continuing) break;
      }

      task = await this.#task(taskId);
      if (task.status === TaskStatus.RUNNING) {
        const { completed, total } = progressOf(task);
        const leftBehind = task.steps.filter((s) => s.status === StepStatus.PENDING || s.status === StepStatus.AWAITING_APPROVAL);
        if (continuing && leftBehind.length > 0) {
          // Steps remain that this run did not take up, because their own records or a step they
          // depend on do not establish that they may be. That is neither a completed run nor a
          // stopped-through-failure run: it is the run paused with what it did written down.
          await this.#transition(task.id, `continued ${executedSteps.length} step(s); ${leftBehind.length} step(s) were not taken up, because the records do not establish that they may be`, {
            task: { from: TaskStatus.RUNNING, to: TaskStatus.PAUSED },
          });
        } else {
          await this.#transition(task.id, completed === total ? 'all steps completed' : 'stopped with steps unfinished', {
            task: { from: TaskStatus.RUNNING, to: completed === total ? TaskStatus.COMPLETED : TaskStatus.FAILED },
          });
        }
        task = await this.#task(taskId);
      }
    } catch (err) {
      if (err instanceof StoreError && executedSteps.length > 0) {
        err.executedSteps = executedSteps;
        err.taskId = taskId;
      }
      throw err;
    }
    const outcome = this.#outcomeFor(task);
    const status = auditGaps.length > 0 && outcome.status === Outcome.SUCCESS_VERIFIED
      ? Outcome.AUDIT_INTEGRITY_FAILED
      : outcome.status;
    return {
      ...outcome,
      status,
      underlyingStatus: outcome.status,
      auditGaps,
      recovery,
      // Which steps this run itself executed, in order. A continuation reports it, because the
      // claim a reader needs after a partial run is not "it resumed" but "these steps ran now, and
      // these were left where their records hold them".
      executed: executedSteps.map((e) => e.id),
      continued: continuing ? executedSteps.map((e) => e.id) : null,
    };
  }

  async #recover(task) {
    const running = task.steps.filter((s) => s.status === StepStatus.RUNNING);
    // The step's own operation record is independent evidence about what happened
    // before the interruption. A step is only left uncertain when that evidence is
    // missing or cannot be matched to it; the audit is never given permission to run
    // anything, and no recovered step is executed again either way.
    let records = null;
    try {
      records = this.readOperations ? await this.readOperations() : [];
    } catch {
      records = null; // an unreadable audit log proves nothing: outcomes stay unknown
    }
    const byId = new Map((records ?? []).map((op) => [op.id, op]));
    const changes = [];
    const basis = [];
    let resolvedFromAudit = 0;
    for (const step of running) {
      const op = typeof step.operationId === 'string' ? byId.get(step.operationId) : null;
      const isThisStep = op !== null && op !== undefined
        && op.capability === 'task.step'
        && op.task?.id === task.id
        && op.task?.stepId === step.id;
      if (!isThisStep) {
        changes.push({
          id: step.id,
          from: StepStatus.RUNNING,
          to: StepStatus.UNCERTAIN,
          outcome: null,
          summary: records === null
            ? 'interrupted, and the audit log could not be read to check it; outcome unknown, not run again'
            : 'interrupted before its outcome was recorded in the task log; not run again',
        });
        basis.push(records === null ? 'unreadable' : 'unknown');
        continue;
      }
      resolvedFromAudit += 1;
      basis.push('audit');
      if (op.status === Outcome.SUCCESS_VERIFIED) {
        changes.push({
          id: step.id,
          from: StepStatus.RUNNING,
          to: StepStatus.COMPLETED,
          outcome: op.status,
          summary: `${truncate(op.output ?? op.steps?.[0]?.summary ?? 'completed', 200)} (recovered from its audit record ${shortId(op.id)})`,
        });
        continue;
      }
      if (op.status === Outcome.VERIFICATION_UNAVAILABLE) {
        changes.push({
          id: step.id,
          from: StepStatus.RUNNING,
          to: StepStatus.UNCERTAIN,
          outcome: op.status,
          summary: `executed but never independently verified (audit record ${shortId(op.id)}); not run again`,
        });
        continue;
      }
      changes.push({
        id: step.id,
        from: StepStatus.RUNNING,
        to: StepStatus.FAILED,
        outcome: op.status,
        summary: `${op.status} according to its audit record ${shortId(op.id)}; not run again`,
      });
    }
    await this.#transition(task.id, changes.length === 0
      ? task.steps.some((s) => s.status === StepStatus.COMPLETED)
        ? 'interrupted after a recorded step; no step was left running'
        : 'interrupted before any step was recorded as running'
      : resolvedFromAudit === changes.length
      ? 'interrupted: every running step was resolved from its own audit record'
      : 'interrupted: a running step whose audit record is missing has an unknown outcome and was not run again', {
      task: { from: TaskStatus.RUNNING, to: TaskStatus.PAUSED },
      steps: changes,
    });
    // Read-only description of what this recovery established, for the caller's
    // task-result turn. It grants nothing and changes nothing.
    return { interrupted: true, steps: changes.map((c, i) => ({ id: c.id, to: c.to, basis: basis[i] })) };
  }

  // Writes the step's operation record. Returns false if the audit log refused it.
  // The task state is recorded either way; the caller reports the gap.
  async #audit(task, step, result, operationId, origin) {
    const now = new Date().toISOString();
    const record = {
      schema: OPERATION_SCHEMA,
      app: APP_NAME,
      stage: APP_STAGE,
      id: operationId,
      requestedAt: now,
      finishedAt: now,
      origin,
      request: `task ${shortId(task.id)} step ${step.id}: ${step.description}`,
      capability: 'task.step',
      task: { id: task.id, stepId: step.id },
      retrieval: [],
      prompt: null,
      backend: null,
      model: null,
      steps: [redact(stripDisplay(result))],
      status: result.outcome,
      output: result.summary ? truncate(result.summary, 4000) : null,
      errors: [],
    };
    try {
      await this.recordOperation(record);
      return true;
    } catch {
      return false;
    }
  }

  #outcomeFor(task) {
    if (task.status === TaskStatus.COMPLETED) return { status: Outcome.SUCCESS_VERIFIED, task };
    if (task.status === TaskStatus.PAUSED) return { status: Outcome.TASK_PAUSED, task };
    if (task.status === TaskStatus.CANCELLED) return { status: Outcome.TASK_CANCELLED, task };
    const bad = task.steps.find((s) => s.status === StepStatus.FAILED || s.status === StepStatus.UNCERTAIN);
    if (bad?.status === StepStatus.UNCERTAIN) return { status: Outcome.VERIFICATION_UNAVAILABLE, task };
    // A failed step can never make a task report verified success, even if a damaged
    // log claimed a verified outcome for it.
    const status = bad?.outcome && bad.outcome !== Outcome.SUCCESS_VERIFIED ? bad.outcome : Outcome.EXECUTION_FAILED;
    return { status, task };
  }

  // Approves a model-proposed plan as a whole: proposed -> pending.
  async approvePlan(taskId) {
    const task = await this.#task(taskId);
    if (task.status !== TaskStatus.PROPOSED) throw new ValidationError(`this task is ${task.status}; only a proposed plan is approved this way`);
    await this.#transition(taskId, 'plan approved by the user', { task: { from: TaskStatus.PROPOSED, to: TaskStatus.PENDING } });
    return this.#task(taskId);
  }

  // Approves one write step of a paused task. The approval is bound to the step's input.
  async approveStep(taskId, stepId) {
    const task = await this.#task(taskId);
    if (task.status !== TaskStatus.PAUSED) throw new ValidationError(`this task is ${task.status}; a step can be approved only while it is paused`);
    const step = task.steps.find((s) => s.id === stepId);
    if (!step) throw new ValidationError(`no step ${stepId} in this task`);
    if (step.status !== StepStatus.AWAITING_APPROVAL) throw new ValidationError(`step ${stepId} is ${step.status}; nothing to approve`);
    await this.#transition(taskId, `step ${stepId} approved by the user`, {
      steps: [{ id: stepId, from: StepStatus.AWAITING_APPROVAL, to: StepStatus.PENDING }],
      approval: { stepId, inputSha256: inputHash(step.input) },
    });
    return this.#task(taskId);
  }

  // Retries one failed or uncertain step. Only read-only steps may be retried, because
  // a write might already have happened.
  async retryStep(taskId, stepId) {
    const task = await this.#task(taskId);
    // A failed task, or a paused one whose step was interrupted (uncertain), can retry a step.
    if (task.status !== TaskStatus.FAILED && task.status !== TaskStatus.PAUSED) {
      throw new ValidationError(`this task is ${task.status}; only a failed or paused task can retry a step`);
    }
    const step = task.steps.find((s) => s.id === stepId);
    if (!step) throw new ValidationError(`no step ${stepId} in this task`);
    if (step.status !== StepStatus.FAILED && step.status !== StepStatus.UNCERTAIN) {
      throw new ValidationError(`step ${stepId} is ${step.status}; only a failed or uncertain step can be retried`);
    }
    if (step.permission !== 'read') {
      throw new ValidationError(`step ${stepId} (${step.action}) changes data, so it is never retried automatically or on request. Cancel this task and create a new one if you need it again`);
    }
    const back = dependentsOf(task.steps, stepId).filter((id) => task.steps.find((s) => s.id === id).status === StepStatus.SKIPPED);
    // The previous attempt's outcome, summary, and operation link are cleared: a pending
    // step must not still read as failed, and the re-run gets a new operation id.
    const cleared = { outcome: null, summary: null, operationId: null };
    await this.#transition(taskId, `step ${stepId} set to retry by the user`, {
      task: task.status === TaskStatus.FAILED ? { from: TaskStatus.FAILED, to: TaskStatus.PAUSED } : null,
      steps: [{ id: stepId, from: step.status, to: StepStatus.PENDING, ...cleared }, ...back.map((id) => ({ id, from: StepStatus.SKIPPED, to: StepStatus.PENDING, ...cleared }))],
    });
    return this.#task(taskId);
  }

  async cancel(taskId) {
    let task = await this.#task(taskId);
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.CANCELLED) throw new ValidationError(`this task is already ${task.status}`);
    if (task.status === TaskStatus.RUNNING) {
      // The caller holds the store lock, so no live process is running this task; it
      // was interrupted. Each running step is resolved from its own audit record, or
      // left uncertain if that record is missing, before the rest of the task is
      // cancelled. Nothing that was already running is executed again.
      await this.#recover(task);
      task = await this.#task(taskId);
    }
    const open = task.steps.filter((s) => s.status === StepStatus.PENDING || s.status === StepStatus.AWAITING_APPROVAL);
    await this.#transition(taskId, 'cancelled by the user', {
      task: { from: task.status, to: TaskStatus.CANCELLED },
      steps: open.map((s) => ({ id: s.id, from: s.status, to: StepStatus.CANCELLED, summary: 'cancelled before it ran' })),
    });
    return this.#task(taskId);
  }
}
