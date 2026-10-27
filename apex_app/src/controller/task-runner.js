// Task runner: sequences the steps of a task. It owns task state transitions and
// nothing else. Each step is executed by the controller's own action path (the
// `execute` callback: authorization, execution, verification), so there is one
// policy and one verifier. The state of every step is written to the task log
// before the next step starts, and each step is also written to the operation log
// with a link back to its task.
//
// Stop rules: a failed or uncertain step stops the task, and steps that depend on it
// are marked skipped. A write step proposed by a model waits for the user's explicit
// approval. Nothing is retried automatically.
import { Outcome, OPERATION_SCHEMA } from '../outcomes.js';
import { ValidationError } from '../errors.js';
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
  constructor({ store, execute, recordOperation, idFactory }) {
    this.store = store;
    this.execute = execute; // (actionName, input, origin, operationId) => step (the controller's action path)
    this.recordOperation = recordOperation; // (operationRecord) => Promise<void>, throws on failure
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

  async #task(id) {
    const task = await this.store.get(id);
    if (!task) throw new ValidationError(`no task with id ${shortId(id)}`);
    return task;
  }

  async #transition(taskId, reason, { task = null, steps = [], approval = null } = {}) {
    return this.store.transition(taskId, { reason, task, steps, approval });
  }

  // Runs (mode 'run', from pending) or resumes (mode 'resume', from paused or after an
  // interruption) a task. Caller must hold the store lock.
  async run(taskId, { mode }) {
    const auditGaps = [];
    let task = await this.#task(taskId);

    if (task.status === TaskStatus.RUNNING) {
      // No live process holds the lock, so an earlier run was interrupted. The step
      // that was running has an unknown outcome, and it is never executed again.
      await this.#recover(task);
      task = await this.#task(taskId);
    }

    if (task.status === TaskStatus.PROPOSED) throw new ValidationError(`this is a model proposal and needs your approval first: task approve ${shortId(task.id)}`);
    if (task.status === TaskStatus.COMPLETED) throw new ValidationError('this task is already completed; nothing to run');
    if (task.status === TaskStatus.CANCELLED) throw new ValidationError('this task was cancelled');
    if (task.status === TaskStatus.FAILED) throw new ValidationError(`this task stopped after a failed step. Retry a read-only step (task retry ${shortId(task.id)} <step>) or cancel it (task cancel ${shortId(task.id)})`);
    if (mode === 'run' && task.status !== TaskStatus.PENDING) throw new ValidationError(`this task is ${task.status}; use: task resume ${shortId(task.id)}`);
    if (mode === 'resume' && task.status !== TaskStatus.PAUSED) throw new ValidationError(`this task is ${task.status}; use: task run ${shortId(task.id)}`);

    const first = this.nextStep(task);
    if (first.blocked) {
      const s = first.blocked;
      throw new ValidationError(`step ${s.id} is ${s.status} and was not run again. Retry it only if it is read-only (task retry ${shortId(task.id)} ${s.id}); otherwise cancel the task (task cancel ${shortId(task.id)})`);
    }
    if (first.step && first.step.status === StepStatus.AWAITING_APPROVAL) {
      throw new ValidationError(`step ${first.step.id} needs your approval: task approve ${shortId(task.id)} --step ${first.step.id}`);
    }

    await this.#transition(task.id, mode === 'run' ? 'started' : 'resumed', {
      task: { from: task.status, to: TaskStatus.RUNNING },
    });

    for (;;) {
      task = await this.#task(taskId);
      const { step: next } = this.nextStep(task);
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
      if (!(await this.#audit(task, next, step, operationId, origin))) auditGaps.push(next.id);

      const result = stepResultFor(step.outcome);
      if (result.step === StepStatus.COMPLETED) {
        await this.#transition(task.id, `${next.id} completed`, {
          steps: [{ id: next.id, from: StepStatus.RUNNING, to: StepStatus.COMPLETED, outcome: step.outcome, summary: truncate(step.summary, 300), operationId }],
        });
        continue;
      }

      const skip = dependentsOf(task.steps, next.id).filter((id) => byId.get(id).status === StepStatus.PENDING);
      await this.#transition(task.id, `${next.id} ${result.step}: ${truncate(step.summary, 200)}`, {
        task: { from: TaskStatus.RUNNING, to: result.task },
        steps: [
          { id: next.id, from: StepStatus.RUNNING, to: result.step, outcome: step.outcome, summary: truncate(step.summary, 300), operationId },
          ...skip.map((id) => ({ id, from: StepStatus.PENDING, to: StepStatus.SKIPPED, summary: `not run: depends on ${next.id}` })),
        ],
      });
      break;
    }

    task = await this.#task(taskId);
    if (task.status === TaskStatus.RUNNING) {
      const { completed, total } = progressOf(task);
      await this.#transition(task.id, completed === total ? 'all steps completed' : 'stopped with steps unfinished', {
        task: { from: TaskStatus.RUNNING, to: completed === total ? TaskStatus.COMPLETED : TaskStatus.FAILED },
      });
      task = await this.#task(taskId);
    }
    return { ...this.#outcomeFor(task), auditGaps };
  }

  async #recover(task) {
    const running = task.steps.filter((s) => s.status === StepStatus.RUNNING);
    await this.#transition(task.id, 'interrupted: the running step has an unknown outcome and was not run again', {
      task: { from: TaskStatus.RUNNING, to: TaskStatus.PAUSED },
      steps: running.map((s) => ({ id: s.id, from: StepStatus.RUNNING, to: StepStatus.UNCERTAIN, outcome: null, summary: 'interrupted before its outcome was recorded; not run again' })),
    });
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
    return { status: bad?.outcome ?? Outcome.EXECUTION_FAILED, task };
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
    await this.#transition(taskId, `step ${stepId} set to retry by the user`, {
      task: task.status === TaskStatus.FAILED ? { from: TaskStatus.FAILED, to: TaskStatus.PAUSED } : null,
      steps: [{ id: stepId, from: step.status, to: StepStatus.PENDING }, ...back.map((id) => ({ id, from: StepStatus.SKIPPED, to: StepStatus.PENDING }))],
    });
    return this.#task(taskId);
  }

  async cancel(taskId) {
    const task = await this.#task(taskId);
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.CANCELLED) throw new ValidationError(`this task is already ${task.status}`);
    const open = task.steps.filter((s) => s.status === StepStatus.PENDING || s.status === StepStatus.AWAITING_APPROVAL);
    await this.#transition(taskId, 'cancelled by the user', {
      task: { from: task.status, to: TaskStatus.CANCELLED },
      steps: open.map((s) => ({ id: s.id, from: s.status, to: StepStatus.CANCELLED, summary: 'cancelled before it ran' })),
    });
    return this.#task(taskId);
  }
}
