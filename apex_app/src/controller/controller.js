// Cognitive Controller: the coordinator. For each request it interprets the
// request, retrieves persistent memory and recent conversation, then either runs
// a deterministic action or asks the model through the Model Gateway. Actions are
// authorized and verified by components the controller does not replace. A
// result is reported as successful only when verification confirmed it, and every
// operation writes an audit record.
import { randomUUID } from 'node:crypto';
import { Outcome, OPERATION_SCHEMA } from '../outcomes.js';
import { ValidationError } from '../errors.js';
import { route } from './router.js';
import { MAX_PROPOSALS, parseModelOutput } from './proposals.js';
import { executeAction } from '../actions/executor.js';
import { CONTROL_CHARS, redact, round3, shortId, truncate } from '../util.js';
import { APP_NAME, APP_STAGE } from '../identity.js';
import { buildPrompt, selectPromptMemory, systemPrompt, MAX_CONTEXT_CHARS } from './context.js';
import { PROMPT_RELEVANCE_MIN } from '../memory/memory-store.js';
import { TURN_ORIGINS } from '../memory/conversation-store.js';
import { containsSecret } from '../security/secrets.js';
import { planFromText, redactGoal, splitGoal, checkSteps, parseModelPlan, planningPrompt } from '../tasks/planner.js';
import { TaskRunner } from './task-runner.js';
import { TaskStatus, StepStatus, progressOf } from '../tasks/model.js';
import { renderTask, renderTaskList } from '../tasks/format.js';
import { StoreError } from '../errors.js';

export const MAX_REQUEST_CHARS = 4000;
const MAX_OUTPUT_CHARS = 4000;
const MEMORY_SHOWN_CHARS = 1000;

export const NO_MODEL_MESSAGE =
  'No inference backend is configured, so APEX cannot write a free-form answer. ' +
  'Nothing has been generated. Non-model functions still work: "status", "calc 2+2", ' +
  '"remember that ...", "remember privately that ...", "recall ...", "list memory". ' +
  'To enable a model, set APEX_MODEL_URL to a local server (see README).';

export function validateRequest(text) {
  if (typeof text !== 'string') throw new ValidationError('request must be text');
  const t = text.trim();
  if (t.length === 0) throw new ValidationError('request is empty');
  if (t.length > MAX_REQUEST_CHARS) throw new ValidationError(`request exceeds ${MAX_REQUEST_CHARS} characters`);
  if (CONTROL_CHARS.test(t)) throw new ValidationError('request contains control characters');
  return t;
}

function stripDisplay(step) {
  const { display, ...rest } = step;
  return rest;
}

function renderShown(hits) {
  return hits
    .map((h) => `  [${h.record.id.slice(0, 8)}] ${h.record.kind === 'model_conclusion' ? 'model conclusion (unverified)' : 'user fact'}: ${truncate(h.record.content, MEMORY_SHOWN_CHARS)}`)
    .join('\n');
}

// A private memory write must not share a request with other parts. The other parts
// could be sent to a model or stored with the task. A request that is only the private
// write is fine.
function isMixedPrivateWrite(request) {
  const isPrivateWrite = (text) => {
    const r = route(text);
    return r.kind === 'action' && r.action === 'memory.add' && (r.input.sensitivity ?? 'normal') === 'private';
  };
  if (isPrivateWrite(request)) return false;
  const parts = splitGoal(request);
  return parts.length > 1 && parts.some(isPrivateWrite);
}

export class CognitiveController {
  constructor({
    memory,
    operations,
    registry,
    verifier,
    gateway,
    getStatus,
    conversation = null,
    session = null,
    now = () => new Date(),
    idFactory = randomUUID,
    retrievalLimit = 5,
    contextTurns = 6,
    maxContextChars = MAX_CONTEXT_CHARS,
    taskStore = null,
    rootForContext = null,
  }) {
    this.memory = memory;
    this.operations = operations;
    this.registry = registry;
    this.verifier = verifier;
    this.gateway = gateway;
    this.getStatus = getStatus;
    this.conversation = conversation;
    this.session = session;
    this.now = now;
    this.idFactory = idFactory;
    this.retrievalLimit = retrievalLimit;
    this.contextTurns = contextTurns;
    this.maxContextChars = maxContextChars;
    this.taskStore = taskStore;
    this.rootForContext = rootForContext;
    this.tasks = taskStore
      ? new TaskRunner({
          store: taskStore,
          execute: (name, input, origin, operationId) => this.runAction(name, input, origin, operationId),
          recordOperation: (record) => this.operations.append(record),
          idFactory: this.idFactory,
        })
      : null;
  }

  readableActions() {
    return this.registry.list()
      .filter((d) => d.permission === 'read' && d.origins.includes('model'))
      .map((d) => `- ${d.name}: ${d.description}`)
      .join('\n');
  }

  async handle(requestText, { origin = 'user', saveAnswer = false, sessionId = null } = {}) {
    const op = {
      schema: OPERATION_SCHEMA,
      app: APP_NAME,
      stage: APP_STAGE,
      id: this.idFactory(),
      requestedAt: this.now().toISOString(),
      origin,
      request: null,
      capability: null,
      retrieval: [],
      prompt: null,
      backend: null,
      model: null,
      steps: [],
      status: null,
      output: null,
      errors: [],
      finishedAt: null,
    };
    let request = null;
    let status;
    let output = null;
    let displayText = null;

    try {
      request = validateRequest(requestText);
      op.request = request;
    } catch (err) {
      // A rejected request is recorded as a placeholder: its text may hold a personal
      // payload, and the reason for rejection is recorded in errors.
      op.request = typeof requestText === 'string'
        ? (containsSecret(requestText) ? '[request omitted: contained a password, key, or token]' : `[request omitted: rejected input of ${requestText.length} chars]`)
        : null;
      op.capability = 'none';
      op.errors.push({ stage: 'input', code: err.code || 'INVALID_INPUT', message: err.message });
      status = Outcome.INPUT_REJECTED;
    }

    if (request !== null && isMixedPrivateWrite(request)) {
      op.capability = 'none';
      op.request = '[request omitted: a private memory write was combined with other requests]';
      output = 'A private memory write must be sent on its own. Nothing was stored, and nothing was sent to a model.';
      displayText = output;
      status = Outcome.INPUT_REJECTED;
      op.errors.push({ stage: 'input', code: 'PRIVATE_WRITE_COMBINED', message: output });
    } else if (request !== null) {
      const sid = await this.#resolveSession(sessionId, op);
      // A request of two or more parts, each a supported action, is a task. Anything
      // else (including a part that is not an action) keeps the single-request path.
      const planned = origin === 'user' && this.tasks && !containsSecret(request) ? planFromText(request, this.registry) : null;
      if (planned && planned.ok && planned.segmentCount >= 2) {
        const t = await this.#runPlannedRequest(op, sid, request, planned);
        status = t.status;
        output = t.output;
        displayText = t.display;
      } else {
      // The audit keeps what was asked, but not the personal payload of a memory
      // write or a credential-like request.
      const routed = route(request);
      if (containsSecret(request)) {
        op.request = '[request omitted: contained a password, key, or token]';
      } else if (routed.kind === 'action' && routed.action === 'memory.add') {
        const verb = request.split(/\s+/)[0];
        op.request = `${verb} [content omitted: ${routed.input.content.length} chars]`;
      } else if (splitGoal(request).some((part) => route(part).action === 'memory.add')) {
        // A memory write mixed with other requests: its text is not kept in the audit.
        op.request = `[request omitted: it combined a memory write with other requests; ${request.length} chars]`;
      }

      // 1. Retrieve persistent context for this request (ids go to the audit).
      let context = [];
      try {
        context = await this.memory.search(request, { limit: this.retrievalLimit });
        op.retrieval = context.map((h) => ({
          id: h.record.id,
          kind: h.record.kind,
          source: h.record.source,
          score: round3(h.score),
        }));
      } catch (err) {
        op.errors.push({ stage: 'retrieval', code: err.code || 'STORE_ERROR', message: err.message });
      }

      // 2. Determine the capability.
      op.capability = routed.capability;

      if (routed.kind === 'action') {
        // 3-6. Authorize, execute, verify, and summarize one deterministic action.
        const step = await this.runAction(routed.action, routed.input, origin, op.id);
        op.steps.push(step);
        status = step.outcome;
        output = step.summary;
        displayText = step.display ?? step.summary;
        // History keeps the summary only, never the displayed content of memory.
        await this.#recordTurns(op, sid, op.request, [
          { origin: TURN_ORIGINS.ACTION, text: step.summary, verified: step.outcome === Outcome.SUCCESS_VERIFIED },
        ]);
      } else {
        // 3. Model path. The model produces text only; any proposal it makes goes
        // through the same authorization and verification as a user request.
        const turns = await this.#recentTurns(sid, op);
        const m = await this.answerWithModel(request, { context, relevant: selectPromptMemory(context), turns }, op);
        status = m.status;
        output = m.answer;
        // Results of verified, model-proposed read actions are shown too, so the
        // user sees what was actually retrieved, not only the model's wording.
        const shownSteps = op.steps
          .filter((s) => s.origin === 'model' && s.outcome === Outcome.SUCCESS_VERIFIED && s.display)
          .map((s) => s.display);
        displayText = [m.answer, ...shownSteps].join('\n\n');
        op.backend = m.backend;
        if (m.error) op.errors.push(m.error);
        const turnRows = [];
        if (m.status === Outcome.VERIFICATION_UNAVAILABLE && m.hasText) {
          turnRows.push({ origin: TURN_ORIGINS.MODEL, text: m.answer, verified: false });
        } else {
          turnRows.push({ origin: TURN_ORIGINS.NOTICE, text: m.answer, verified: false });
        }
        await this.#recordTurns(op, sid, op.request, turnRows);

        if (saveAnswer && m.status === Outcome.VERIFICATION_UNAVAILABLE && m.hasText) {
          // Storing a model answer is a user-approved write, never automatic.
          const step = await this.runAction(
            'memory.save_conclusion',
            { content: m.answer, operationId: op.id, backend: m.backend },
            'user',
            op.id,
          );
          op.steps.push(step);
          displayText = `${displayText}\n\n${step.display ?? step.summary}`;
        }
      }
      }
    }

    op.status = status;
    op.output = output ? truncate(output, MAX_OUTPUT_CHARS) : null;
    op.finishedAt = this.now().toISOString();

    const persisted = { ...op, steps: op.steps.map(stripDisplay) };
    let recorded = true;
    let recordError = null;
    try {
      await this.operations.append(persisted);
    } catch (err) {
      recorded = false;
      recordError = err.message;
    }
    return { operation: persisted, status, output: op.output, display: displayText, recorded, recordError };
  }

  async #resolveSession(sessionId, op) {
    if (sessionId) return sessionId;
    if (!this.session) return null;
    try {
      return (await this.session.current()).sessionId;
    } catch (err) {
      op.errors.push({ stage: 'session', code: err.code || 'STORE_ERROR', message: err.message });
      return null;
    }
  }

  async correctMemory({ targetId, content, resolve } = {}) {
    const op = this.#newOp({
      capability: 'memory.correct',
      origin: 'user',
      request: `memory correct ${String(targetId ?? '')} [replacement omitted: ${typeof content === 'string' ? content.length : 0} chars] --resolve`,
    });
    const operationId = op.id;

    const step = await this.runAction(
      'memory.correct',
      { targetId, content, resolve },
      'user',
      operationId,
    );
    op.steps.push(step);
    op.status = step.outcome;
    op.output = step.summary ? truncate(step.summary, MAX_OUTPUT_CHARS) : null;
    op.finishedAt = this.now().toISOString();

    let recorded = true;
    let recordError = null;
    try {
      await this.operations.append({ ...op, steps: op.steps.map(stripDisplay) });
    } catch (err) {
      recorded = false;
      recordError = err.message;
      op.errors.push({ stage: 'audit', code: 'AUDIT_WRITE_FAILED', message: err.message });
      op.status = Outcome.AUDIT_INTEGRITY_FAILED;
      op.output = 'The correction may have been stored, but its audit record could not be written; it is not reported as verified success.';
    }
    return {
      operation: op,
      status: op.status,
      output: op.output,
      display: recorded ? (step.display ?? step.summary) : op.output,
      recorded,
      recordError,
    };
  }

  async #recentTurns(sid, op) {
    if (!this.conversation || !sid) return [];
    try {
      return await this.conversation.recent(sid, this.contextTurns);
    } catch (err) {
      op.errors.push({ stage: 'context', code: err.code || 'STORE_ERROR', message: err.message });
      return [];
    }
  }

  // Writes the user's turn and the reply turn(s). The user text is the audit-safe
  // request (memory payloads and credentials are never replayed to a model). A
  // failure is reported in the operation's errors; it never hides the answer.
  async #recordTurns(op, sid, userText, replies) {
    if (!this.conversation || !sid) return;
    try {
      await this.conversation.append({ sessionId: sid, role: 'user', origin: TURN_ORIGINS.USER, text: userText, operationId: op.id });
      for (const r of replies) {
        await this.conversation.append({
          sessionId: sid,
          role: 'assistant',
          origin: r.origin,
          text: r.text,
          verified: r.verified,
          operationId: op.id,
        });
      }
    } catch (err) {
      op.errors.push({ stage: 'conversation', code: err.code || 'STORE_ERROR', message: err.message });
    }
  }

  async runAction(name, rawInput, origin, operationId) {
    const step = {
      action: typeof name === 'string' ? name : null,
      origin,
      input: redact(rawInput),
      authorization: null,
      execution: { status: 'not_run' },
      verification: { outcome: 'not_run', detail: null },
      outcome: null,
      summary: '',
      result: null,
      display: null,
    };

    // Authorization: a request is not authorization.
    const auth = this.registry.authorize(name, origin);
    step.authorization = auth;
    if (auth.decision !== 'allow') {
      step.outcome = Outcome.ACTION_DENIED;
      step.summary = `denied (${auth.reason})`;
      return step;
    }

    const def = this.registry.get(name);
    const ctx = { memory: this.memory, getStatus: this.getStatus, operationId, origin, root: this.rootForContext };
    // The filesystem actions receive the authorized root on ctx.root. It is set only by the
    // composition root and cannot be supplied by a model proposal, so the boundary cannot be
    // expanded from model output.

    // Execution.
    const exec = await executeAction(def, ctx, rawInput);
    if (exec.status === 'rejected') {
      step.execution = { status: 'rejected', error: exec.error };
      step.outcome = Outcome.INPUT_REJECTED;
      step.summary = `input rejected: ${exec.error.message}`;
      return step;
    }
    if (exec.status === 'failed') {
      step.execution = { status: 'failed', error: exec.error };
      step.outcome = Outcome.EXECUTION_FAILED;
      step.summary = `execution failed: ${exec.error.message}`;
      return step;
    }
    step.execution = { status: 'ok' };
    const { display, ...resultNoDisplay } = exec.result;
    step.result = redact(resultNoDisplay);

    // Verification: separate component, reads evidence independently.
    const v = await this.verifier.check(def, ctx, exec.input, exec.result);
    step.verification = { outcome: v.outcome, detail: v.detail };
    step.outcome = v.outcome;
    if (v.outcome === Outcome.SUCCESS_VERIFIED) {
      step.summary = `${exec.result.summary} (verified)`;
      step.display = display ?? exec.result.summary;
    } else if (v.outcome === Outcome.VERIFICATION_FAILED) {
      step.summary = `result NOT confirmed: ${v.detail}`;
      step.display = step.summary;
    } else {
      step.summary = `executed; verification unavailable: ${v.detail}`;
      step.display = step.summary;
    }
    return step;
  }

  // ---- tasks ------------------------------------------------------------------
  // Planning validates steps against the registry; a model's plan is only ever
  // stored as a proposal. Running goes step by step through runAction, so each step
  // has the same authorization and verification as any single request. Every
  // operation that changes task state writes one operation record that names the task.

  #requireTasks() {
    if (!this.tasks) throw new ValidationError('tasks are not available in this configuration');
  }

  #newOp({ capability, origin, request }) {
    return {
      schema: OPERATION_SCHEMA,
      app: APP_NAME,
      stage: APP_STAGE,
      id: this.idFactory(),
      requestedAt: this.now().toISOString(),
      origin,
      request,
      capability,
      retrieval: [],
      prompt: null,
      backend: null,
      model: null,
      steps: [],
      status: null,
      output: null,
      errors: [],
      finishedAt: null,
    };
  }

  async #finishTaskOp(op, status, display, task = null, extra = {}) {
    op.status = status;
    op.output = truncate(display ?? '', MAX_OUTPUT_CHARS);
    op.finishedAt = this.now().toISOString();
    if (task) op.task = { id: task.id, status: task.status };
    let recorded = true;
    let recordError = null;
    try {
      await this.operations.append(op);
    } catch (err) {
      recorded = false;
      recordError = err.message;
    }
    return { status, display, output: op.output, operation: op, recorded, recordError, task, ...extra };
  }

  // A refusal is a result, not a crash: the reason is shown and nothing changes.
  async #refused(op, err, status = Outcome.INPUT_REJECTED) {
    if (err instanceof ValidationError) return this.#finishTaskOp(op, status, err.message);
    if (err instanceof StoreError) return this.#finishTaskOp(op, Outcome.EXECUTION_FAILED, `task store unavailable: ${err.message}`);
    throw err;
  }

  async #createTask({ goal, origin, planner, steps }) {
    return this.taskStore.withLock(async () => {
      const taskId = this.idFactory();
      await this.taskStore.createTask({ taskId, goal, origin, planner, steps });
      return this.taskStore.get(taskId);
    });
  }

  async planTask(goalText) {
    const op = this.#newOp({ capability: 'task.plan', origin: 'user', request: null });
    try {
      this.#requireTasks();
      const text = validateRequest(goalText);
      if (containsSecret(text)) throw new ValidationError('the goal contains a password, key, or token; it was not planned');
      const safeGoal = redactGoal(text);
      op.request = safeGoal;
      const det = planFromText(text, this.registry);
      if (det.ok) {
        const task = await this.#createTask({ goal: safeGoal, origin: 'user', planner: 'deterministic', steps: det.steps });
        return this.#finishTaskOp(op, Outcome.PLAN_CREATED, `${renderTask(task)}\nThe plan was checked. Nothing has run yet.`, task);
      }
      if (!this.gateway.isConfigured()) {
        return this.#finishTaskOp(
          op,
          Outcome.PLAN_REJECTED,
          `This goal cannot be planned from supported steps:\n  - ${det.problems.join('\n  - ')}\nNo model is configured to propose a plan. Nothing was stored.`,
        );
      }
      return await this.#modelPlan(op, safeGoal, det.problems);
    } catch (err) {
      return this.#refused(op, err, Outcome.PLAN_REJECTED);
    }
  }

  // Asks the model for a plan. The prompt gets the redacted goal and only relevant,
  // non-private memory. The reply is parsed strictly and checked against the registry.
  async #modelPlan(op, safeGoal) {
    let hits;
    try {
      hits = await this.memory.search(safeGoal, { limit: this.retrievalLimit });
    } catch (err) {
      op.errors.push({ stage: 'retrieval', code: err.code || 'STORE_ERROR', message: err.message });
      return this.#finishTaskOp(op, Outcome.EXECUTION_FAILED, `Memory retrieval failed (${err.code || 'STORE_ERROR'}). No plan was created.`);
    }
    const memoryLines = selectPromptMemory(hits).map(
      (h, i) => {
        const conflictNote = h.conflict.length > 0
          ? ' [conflicting memory: competing claims, not established fact]'
          : '';
        return `[${i + 1}] ${h.record.kind === 'model_conclusion' ? 'model conclusion (UNVERIFIED)' : 'user-provided fact'}: ${truncate(h.record.content, MEMORY_SHOWN_CHARS)}${conflictNote}`;
      },
    );
    // The prompt offers only the actions a model-origin plan may actually use, so the
    // model is not invited to propose user-only actions such as filesystem inspection.
    const { system, prompt } = planningPrompt({ goal: safeGoal, registry: this.registry, memoryLines, origin: 'model' });
    const res = await this.gateway.complete({ system, prompt });
    op.backend = res.backend ?? null;
    op.model = res.ok
      ? { name: res.model, provider: res.provider, latencyMs: res.latencyMs, finishReason: res.finishReason }
      : { provider: res.provider ?? null, latencyMs: res.latencyMs };
    if (!res.ok) {
      op.errors.push({ stage: 'model', code: res.error.code, message: res.error.message });
      return this.#finishTaskOp(op, Outcome.EXECUTION_FAILED, `The model did not return a plan (${res.error.code}: ${res.error.message}). No task was created.`);
    }
    const parsed = parseModelPlan(res.text);
    const checked = parsed.ok ? checkSteps(parsed.steps, this.registry, 'model') : { steps: [], problems: [] };
    const problems = [...parsed.problems, ...checked.problems];
    if (problems.length > 0) {
      return this.#finishTaskOp(
        op,
        Outcome.PLAN_REJECTED,
        `The model's proposed plan was rejected, so nothing was stored:\n  - ${problems.join('\n  - ')}`,
      );
    }
    const task = await this.#createTask({ goal: safeGoal, origin: 'model', planner: 'model', steps: checked.steps });
    return this.#finishTaskOp(op, Outcome.PLAN_PROPOSED, `${renderTask(task)}\nThis plan was proposed by a model. Nothing has run yet.`, task);
  }

  async runTask(ref, mode = 'run') {
    const op = this.#newOp({ capability: 'task.run', origin: 'user', request: `task ${mode}` });
    try {
      this.#requireTasks();
      const found = await this.taskStore.resolve(ref);
      op.request = `task ${mode} ${shortId(found.id)}`;
      const result = await this.taskStore.withLock(() => this.tasks.run(found.id, { mode }));
      const gaps = result.auditGaps.length;
      if (gaps) {
        op.errors.push({
          stage: 'audit',
          code: 'AUDIT_WRITE_FAILED',
          message: `${gaps} step record(s) were not written to the operation log`,
          steps: result.auditGaps,
          underlyingStatus: result.underlyingStatus,
        });
      }
      const warning = gaps
        ? `\nAudit integrity failure: ${gaps} required task-step operation record(s) could not be written (${result.auditGaps.join(', ')}). Underlying task result: ${result.underlyingStatus}.`
        : '';
      return this.#finishTaskOp(
        op,
        result.status,
        `${renderTask(result.task)}${warning}`,
        result.task,
        {
          auditGaps: gaps,
          auditGapSteps: result.auditGaps,
          underlyingStatus: result.underlyingStatus,
        },
      );
    } catch (err) {
      return this.#refused(op, err);
    }
  }

  // Approval actions read the log back and report success only if the change is there.
  async #approval(op, label, change, confirm) {
    try {
      this.#requireTasks();
      const updated = await this.taskStore.withLock(() => change());
      if (!confirm(updated)) {
        return this.#finishTaskOp(op, Outcome.EXECUTION_FAILED, `${label}: the change could not be confirmed in the task log.`, updated);
      }
      return this.#finishTaskOp(op, Outcome.SUCCESS_VERIFIED, `${label}.\n${renderTask(updated)}`, updated);
    } catch (err) {
      return this.#refused(op, err);
    }
  }

  async approveTask(ref, { stepId = null } = {}) {
    const op = this.#newOp({ capability: 'task.approve', origin: 'user', request: stepId ? `approve step ${stepId}` : 'approve plan' });
    let id;
    try {
      this.#requireTasks();
      const found = await this.taskStore.resolve(ref);
      id = found.id;
      op.request = `${stepId ? `approve step ${stepId}` : 'approve plan'} of task ${shortId(id)}`;
    } catch (err) {
      return this.#refused(op, err);
    }
    if (stepId) {
      return this.#approval(
        op,
        `Approved step ${stepId}`,
        () => this.tasks.approveStep(id, stepId),
        (t) => t.status === TaskStatus.PAUSED && t.steps.some((s) => s.id === stepId && s.status === StepStatus.PENDING && s.approval),
      );
    }
    return this.#approval(
      op,
      'Approved plan',
      () => this.tasks.approvePlan(id),
      (t) => t.status === TaskStatus.PENDING && t.approvedAt !== null,
    );
  }

  async retryTask(ref, stepId) {
    const op = this.#newOp({ capability: 'task.retry', origin: 'user', request: `retry step ${stepId}` });
    try {
      this.#requireTasks();
      const found = await this.taskStore.resolve(ref);
      op.request = `retry step ${stepId} of task ${shortId(found.id)}`;
      return await this.#approval(
        op,
        `Retry set for step ${stepId}`,
        () => this.tasks.retryStep(found.id, stepId),
        (t) => t.status === TaskStatus.PAUSED && t.steps.some((s) => s.id === stepId && s.status === StepStatus.PENDING),
      );
    } catch (err) {
      return this.#refused(op, err);
    }
  }

  async cancelTask(ref) {
    const op = this.#newOp({ capability: 'task.cancel', origin: 'user', request: 'cancel task' });
    try {
      this.#requireTasks();
      const found = await this.taskStore.resolve(ref);
      op.request = `cancel task ${shortId(found.id)}`;
      return await this.#approval(
        op,
        'Cancelled',
        () => this.tasks.cancel(found.id),
        (t) => t.status === TaskStatus.CANCELLED && t.steps.every((s) => s.status !== StepStatus.PENDING && s.status !== StepStatus.AWAITING_APPROVAL),
      );
    } catch (err) {
      return this.#refused(op, err);
    }
  }

  // Read-only: no operation record. Unknown ids are usage errors for the caller.
  async showTask(ref) {
    this.#requireTasks();
    const task = await this.taskStore.resolve(ref);
    return { task, display: renderTask(task) };
  }

  async listTasks() {
    this.#requireTasks();
    return renderTaskList(await this.taskStore.list());
  }

  // Inside handle(): a deterministic multi-part request. The plan is stored, then run.
  async #runPlannedRequest(op, sid, request, planned) {
    try {
      const goal = redactGoal(request);
      op.request = goal;
      op.capability = 'task.run';
      const task = await this.#createTask({ goal, origin: 'user', planner: 'deterministic', steps: planned.steps });
      const result = await this.taskStore.withLock(() => this.tasks.run(task.id, { mode: 'run' }));
      const fresh = result.task;
      const { completed, total } = progressOf(fresh);
      if (result.auditGaps.length) {
        op.errors.push({
          stage: 'audit',
          code: 'AUDIT_WRITE_FAILED',
          message: `${result.auditGaps.length} step record(s) not written`,
          steps: result.auditGaps,
          underlyingStatus: result.underlyingStatus,
        });
      }
      op.task = { id: task.id, status: fresh.status };
      await this.#recordTurns(op, sid, op.request, [
        {
          origin: TURN_ORIGINS.ACTION,
          text: `task ${shortId(task.id)}: ${fresh.status}, ${completed} of ${total} step(s) completed`,
          verified: result.status === Outcome.SUCCESS_VERIFIED,
        },
      ]);
      const warning = result.auditGaps.length
        ? `\nAudit integrity failure: ${result.auditGaps.length} required task-step operation record(s) could not be written (${result.auditGaps.join(', ')}). Underlying task result: ${result.underlyingStatus}.`
        : '';
      const display = `${renderTask(fresh)}${warning}`;
      return {
        status: result.status,
        output: display,
        display,
        auditGaps: result.auditGaps.length,
        auditGapSteps: result.auditGaps,
        underlyingStatus: result.underlyingStatus,
      };
    } catch (err) {
      if (err instanceof ValidationError) return { status: Outcome.INPUT_REJECTED, output: err.message, display: err.message };
      if (err instanceof StoreError) return { status: Outcome.EXECUTION_FAILED, output: `task store unavailable: ${err.message}`, display: `task store unavailable: ${err.message}` };
      throw err;
    }
  }


  // Model path. `ctx.relevant` is what may enter the prompt (filtered); `ctx.context`
  // is everything retrieved, which the user can see but the model does not get.
  async answerWithModel(request, { context, relevant, turns }, op) {
    const retrievalError = op.errors.find((error) => error.stage === 'retrieval');
    if (retrievalError) {
      return {
        status: Outcome.EXECUTION_FAILED,
        answer: `Memory retrieval failed (${retrievalError.code}). APEX did not generate an answer because stored context could not be checked.`,
        hasText: false,
        backend: null,
        error: null,
      };
    }
    if (!this.gateway.isConfigured()) {
      const shown = context.filter((h) => h.score >= PROMPT_RELEVANCE_MIN);
      const memoryNote = shown.length
        ? `\n\nRelevant memory found (shown directly, not summarised by a model):\n${renderShown(shown)}`
        : '';
      return { status: Outcome.MODEL_UNAVAILABLE, answer: NO_MODEL_MESSAGE + memoryNote, hasText: false, backend: null, error: null };
    }

    const built = buildPrompt({ request, memoryHits: relevant, turns, maxChars: this.maxContextChars });
    op.prompt = { memoryIds: built.memoryIds, turnIds: built.turnIds, chars: built.prompt.length };
    const system = systemPrompt({ appName: APP_NAME, actions: this.readableActions(), now: this.now() });
    const res = await this.gateway.complete({ system, prompt: built.prompt });

    if (!res.ok) {
      op.model = { provider: res.provider ?? null, latencyMs: res.latencyMs };
      return {
        status: Outcome.EXECUTION_FAILED,
        answer: `The model backend did not produce an answer (${res.error.code}: ${res.error.message}). No answer has been generated.`,
        hasText: false,
        backend: res.backend,
        error: { stage: 'model', code: res.error.code, message: res.error.message },
      };
    }
    op.model = { name: res.model, provider: res.provider, latencyMs: res.latencyMs, finishReason: res.finishReason };

    const parsed = parseModelOutput(res.text);
    for (const bad of parsed.malformed) {
      op.steps.push({
        action: null,
        origin: 'model',
        input: null,
        authorization: null,
        execution: { status: 'not_run' },
        verification: { outcome: 'not_run', detail: null },
        outcome: Outcome.INPUT_REJECTED,
        summary: `malformed proposal rejected: ${bad.reason}`,
        result: null,
      });
    }
    if (parsed.proposals.length > MAX_PROPOSALS) {
      op.errors.push({ stage: 'proposals', code: 'TOO_MANY', message: `only the first ${MAX_PROPOSALS} proposals were considered` });
    }
    for (const p of parsed.proposals.slice(0, MAX_PROPOSALS)) {
      op.steps.push(await this.runAction(p.action, p.input, 'model', op.id));
    }

    let answer = parsed.text || '(the model returned no answer text)';
    if (res.truncated) {
      answer += '\n\n[The answer was cut off at the model output limit (APEX_MODEL_MAX_TOKENS).]';
      op.errors.push({ stage: 'model', code: 'TRUNCATED', message: 'answer reached the output token limit' });
    }
    // The model's own conclusion has no independent check, so it is reported
    // honestly as verification_unavailable, never as verified.
    return {
      status: Outcome.VERIFICATION_UNAVAILABLE,
      answer,
      hasText: parsed.text.length > 0,
      backend: res.backend,
      error: null,
    };
  }
}
