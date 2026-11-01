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
import { discussedTaskIds, selectTaskReferent } from './task-context.js';
import { MAX_PROPOSALS, parseModelOutput } from './proposals.js';
import { executeAction } from '../actions/executor.js';
import { CONTROL_CHARS, redact, round3, shortId, truncate } from '../util.js';
import { APP_NAME, APP_STAGE } from '../identity.js';
import { buildPrompt, dedupeKnowledge, knowledgeLine, selectPromptKnowledge, selectPromptMemory, systemPrompt, adaptationLine, adaptationOmittedNote, MAX_CONTEXT_CHARS } from './context.js';
import { classifyDecision, clarificationFor, turnsResolveContext, unsupportedOperationFor } from './decision.js';
import { TURN_ORIGINS } from '../memory/conversation-store.js';
import { containsSecret } from '../security/secrets.js';
import { planFromText, redactGoal, splitGoal, checkSteps, parseModelPlan, planningPrompt } from '../tasks/planner.js';
import { TaskRunner } from './task-runner.js';
import { TaskStatus, StepStatus } from '../tasks/model.js';
import { buildTaskSummary, taskStateSignature } from '../tasks/summary.js';
import { renderTask, renderTaskList, explainTask } from '../tasks/format.js';
import { StoreError } from '../errors.js';
import { KNOWLEDGE_PROMPT_LIMIT } from '../actions/knowledge-actions.js';
import { MAX_HEALTH_SAMPLES, MAX_HISTORY_CHAIN } from '../knowledge/knowledge-store.js';
import { buildWorldState, renderWorldState } from '../world/world-state.js';
import { autoCaptureDecision, captureSettingPhrase, CAPTURE_OFF } from '../experience/capture.js';
import { CAPTURE_AUTOMATIC } from '../experience/experience-store.js';
import { finalizeOperation } from './finalization.js';

export const MAX_REQUEST_CHARS = 4000;
const MAX_OUTPUT_CHARS = 4000;
const MEMORY_SHOWN_CHARS = 1000;
// A reported load time below this is ordinary server overhead, not a cold start worth
// mentioning. The number is display-only and never becomes part of the model's turn.
const LOAD_NOTICE_MS = 1000;

export const NO_MODEL_MESSAGE =
  'No inference backend is configured, so APEX cannot write a free-form answer. ' +
  'Nothing has been generated. Non-model functions still work: "status", "calc 2+2", ' +
  '"remember that ...", "remember privately that ...", "recall ...", "list memory". ' +
  'APEX does not install, start, or recommend an inference server; if you have chosen an ' +
  'endpoint yourself, point APEX_MODEL_URL at it (see README). ' +
  'Retrying this request will not produce an answer until a model is configured.';

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

// The advice after a failed model call depends on why it failed. A reachable endpoint
// that does not serve the configured model is not an outage, and telling the operator to
// wait for the backend would point at the wrong fix.
function modelFailureAdvice(code) {
  switch (code) {
    case 'MODEL_NOT_FOUND':
      return 'The endpoint is reachable but does not serve this model name; no action was proposed or run. Correct APEX_MODEL_NAME before retrying.';
    case 'EMPTY_RESPONSE':
      return 'No answer was generated. A retry is safe, but if the same empty answer repeats, adjust the token budget or model as described above rather than retrying unchanged.';
    case 'CONTEXT_TOO_LARGE':
      return 'No action was proposed or run; shorten the request rather than retrying it unchanged.';
    case 'TIMEOUT':
      // A timeout says nothing about the model's ability to answer: a first request is
      // slow while the server loads the model. APEX never resends a timed-out request,
      // so the advice has to describe a deliberate retry rather than a hidden one.
      return 'No answer and no action were produced, and APEX did not resend the request. A first request can exceed the limit while the server loads the model; wait for it, then retry once. If timeouts repeat, raise APEX_MODEL_TIMEOUT_MS (100-600000) or lower APEX_MODEL_MAX_TOKENS.';
    case 'INTERRUPTED':
    case 'UNREACHABLE':
      return 'No action was proposed or run, so retrying this request after the backend is available is safe.';
    default:
      return 'No action was proposed or run; retrying is safe, and if the same failure repeats check the model server.';
  }
}

function renderShown(hits) {
  return hits
    .map((h) => `  [${h.record.id.slice(0, 8)}] ${h.record.kind === 'model_conclusion' ? 'model conclusion (unverified)' : 'user fact'}: ${truncate(h.record.content, MEMORY_SHOWN_CHARS)}`)
    .join('\n');
}

const AUDIT_OMITTED_SECRET = '[omitted: contained a password, key, or token]';

function knowledgeAddRequest(subject, relationship, object, supersedes = []) {
  const values = [subject, relationship, object];
  if (values.some((value) => typeof value !== 'string')) return 'knowledge add [invalid input]';
  if (containsSecret(values.join('\n'))) {
    return 'knowledge add [content omitted: contained a password, key, or token]';
  }
  const supersedeNote = Array.isArray(supersedes) && supersedes.length > 0
    ? `; supersedes ${supersedes.length} record(s)`
    : '';
  return `knowledge add [${subject} -> ${relationship} -> ${object}${supersedeNote}]`;
}

function knowledgeRetractRequest(target, reason) {
  if (typeof target !== 'string' || target.trim().length === 0) return 'knowledge retract [invalid input]';
  const ref = containsSecret(target) ? '[target omitted: contained a password, key, or token]' : target.trim();
  const reasonNote = typeof reason === 'string' && reason.trim().length > 0 ? ' (reason recorded)' : '';
  return `knowledge retract [${ref}]${reasonNote}`;
}

function knowledgeResolveRequest(target, choose, reason) {
  const ref = (value) => {
    if (typeof value !== 'string' || value.trim().length === 0) return '[invalid input]';
    return containsSecret(value) ? '[id omitted: contained a password, key, or token]' : value.trim();
  };
  const reasonNote = typeof reason === 'string' && reason.trim().length > 0 ? ' (reason recorded)' : '';
  return `knowledge resolve [target ${ref(target)}; choose ${ref(choose)}]${reasonNote}`;
}

const KNOWLEDGE_AUDIT_FIELDS = Object.freeze({
  'knowledge.add': Object.freeze({
    allowed: ['subject', 'relationship', 'object', 'evidence', 'supersedes'],
    text: ['subject', 'relationship', 'object', 'evidence'],
    arrays: ['supersedes'],
  }),
  'knowledge.search': Object.freeze({
    allowed: ['query', 'limit'],
    text: ['query'],
    arrays: [],
  }),
  'knowledge.retract': Object.freeze({
    allowed: ['target', 'reason'],
    text: ['target', 'reason'],
    arrays: [],
  }),
  'knowledge.resolve': Object.freeze({
    allowed: ['target', 'choose', 'reason'],
    text: ['target', 'choose', 'reason'],
    arrays: [],
  }),
});

// The audit input is derived from the raw request before validation, so a refused
// credential-like value must be replaced here rather than copied into the audit log.
// For knowledge inputs only the declared fields are kept; unexpected fields are
// marked and their values discarded.
function auditInputFor(name, rawInput) {
  const fields = KNOWLEDGE_AUDIT_FIELDS[name];
  if (fields && rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const secretTexts = fields.text.map((key) => rawInput[key]).filter((value) => typeof value === 'string');
    for (const key of fields.arrays) {
      if (Array.isArray(rawInput[key])) {
        secretTexts.push(...rawInput[key].filter((value) => typeof value === 'string'));
      }
    }
    const secret = containsSecret(secretTexts.join('\n'));
    const out = {};
    for (const key of fields.allowed) {
      if (!(key in rawInput)) continue;
      const value = rawInput[key];
      out[key] = !secret
        ? value
        : typeof value === 'string'
          ? AUDIT_OMITTED_SECRET
          : Array.isArray(value)
            ? value.map((entry) => (typeof entry === 'string' ? AUDIT_OMITTED_SECRET : entry))
            : value;
    }
    for (const key of Object.keys(rawInput)) {
      if (!fields.allowed.includes(key)) out[key] = '[unexpected field omitted]';
    }
    return out;
  }
  return redact(rawInput);
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
    summaryQueue = null,
    rootForContext = null,
    knowledge = null,
    experience = null,
    experienceCapture = CAPTURE_OFF,
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
    this.summaryQueue = summaryQueue;
    this.rootForContext = rootForContext;
    this.knowledge = knowledge;
    // The experience store contributes only approved behaviour rules to a prompt. It is optional:
    // with no store configured the section is simply absent, and nothing claims rules were checked.
    this.experience = experience;
    // Whether APEX may write an experience of a verified outcome without being asked. The mode is
    // read in one place (autoCaptureDecision), which states its reason, so an unrecognized value
    // is reported as a capture that did not happen rather than silently treated as a different one.
    this.experienceCapture = typeof experienceCapture === 'string' ? experienceCapture : CAPTURE_OFF;
    this.tasks = taskStore
      ? new TaskRunner({
          store: taskStore,
          execute: (name, input, origin, operationId) => this.runAction(name, input, origin, operationId),
          recordOperation: (record) => this.operations.append(record),
          readOperations: async () => (await this.operations.inspect()).records,
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

  async handle(requestText, { origin = 'user', saveAnswer = false, sessionId = null, onProgress = null } = {}) {
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
      decision: null,
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
      let routed = route(request);
      if (routed.kind === 'task_question' && !this.taskStore) {
        // No task records exist in this configuration, so there is nothing to read
        // back. The request stays on the ordinary path instead of being answered here.
        routed = { kind: 'model', capability: 'model.answer', action: null, input: null };
      }
      if (containsSecret(request)) {
        op.request = '[request omitted: contained a password, key, or token]';
      } else if (routed.kind === 'action' && routed.action === 'memory.add') {
        const verb = request.split(/\s+/)[0];
        op.request = `${verb} [content omitted: ${routed.input.content.length} chars]`;
      } else if (splitGoal(request).some((part) => route(part).action === 'memory.add')) {
        // A memory write mixed with other requests: its text is not kept in the audit.
        op.request = `[request omitted: it combined a memory write with other requests; ${request.length} chars]`;
      }

      const blocked = unsupportedOperationFor(request);
      // A lookup with no topic or a file request with no target cannot proceed.
      // Ask before any retrieval, action, or model call. Follow-ups that depend on
      // conversation context are checked after recent turns are loaded.
      const clarification = origin === 'user' && !blocked
        ? clarificationFor(request, { checkContinuation: false })
        : null;
      if (blocked) {
        // The requested operation does not exist in APEX. Refuse before any model
        // call, so no model can imply that it was carried out.
        op.capability = 'none';
        op.errors.push({ stage: 'policy', code: 'UNSUPPORTED_OPERATION', message: blocked });
        status = Outcome.ACTION_DENIED;
        output = blocked;
        displayText = blocked;
        await this.#recordTurns(op, sid, op.request, [
          { origin: TURN_ORIGINS.NOTICE, text: blocked, verified: false },
        ]);
      } else if (clarification) {
        // Missing target or topic: ask instead of guessing. No action runs and no
        // model is called, so nothing can be implied to have happened.
        op.capability = 'none';
        status = Outcome.CLARIFICATION_REQUIRED;
        output = clarification;
        displayText = clarification;
        await this.#recordTurns(op, sid, op.request, [
          { origin: TURN_ORIGINS.QUESTION, text: clarification, verified: false },
        ]);
      } else {
      // 2. Determine the capability.
      op.capability = routed.capability;

      if (routed.kind === 'task_question') {
        // 3-6, but for a read of the task log: no action, no model, no state change.
        const answer = await this.#explainTaskRequest(op, sid, routed);
        status = answer.status;
        output = answer.output;
        displayText = answer.display;
      } else if (routed.kind === 'action') {
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
        const followUpClarification = origin === 'user'
          ? clarificationFor(request, { hasContext: turnsResolveContext(turns) })
          : null;
        if (followUpClarification) {
          // A follow-up with nothing to refer back to: ask instead of guessing, and
          // do not let a model imply that an action was carried out.
          status = Outcome.CLARIFICATION_REQUIRED;
          output = followUpClarification;
          displayText = followUpClarification;
          await this.#recordTurns(op, sid, op.request, [
            { origin: TURN_ORIGINS.QUESTION, text: followUpClarification, verified: false },
          ]);
        } else {
        // 1. Retrieve the stored context this answer is built from (ids go to the
        // audit). Retrieval belongs here and not to every request: a deterministic
        // action reads exactly what it needs, and an unused lookup was audited as
        // though it had supplied context, and could report a store failure on an
        // unrelated successful operation.
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
        const m = await this.answerWithModel(request, {
          relevant: selectPromptMemory(context),
          turns,
          // If the session or conversation log cannot be read, the prompt must not
          // claim that no earlier messages exist.
          historyUnavailable: op.errors.some((e) => e.stage === 'context' || e.stage === 'session'),
        }, op, onProgress);
        status = m.status;
        // Any model proposal that did not execute and verify gets a deterministic
        // counter-notice, even if the model's own text claims success. The wording
        // distinguishes a proposal that never ran from one that ran but failed or
        // could not be verified, so the notice never claims an execution did not
        // happen when it did.
        const failedProposals = op.steps.filter((s) => s.origin === 'model' && s.outcome !== Outcome.SUCCESS_VERIFIED);
        const notExecuted = failedProposals.filter((s) => s.outcome !== Outcome.EXECUTION_FAILED
          && s.outcome !== Outcome.VERIFICATION_FAILED
          && s.outcome !== Outcome.VERIFICATION_UNAVAILABLE);
        const executedNotVerified = failedProposals.filter((s) => !notExecuted.includes(s));
        const noticeParts = [];
        if (notExecuted.length) {
          const label = notExecuted.length === 1 ? 'a proposed action' : `${notExecuted.length} proposed actions`;
          noticeParts.push(`did not execute ${label}: ${notExecuted.map((s) => s.summary).join('; ')}`);
        }
        for (const s of executedNotVerified) {
          if (s.outcome === Outcome.EXECUTION_FAILED) {
            noticeParts.push(`proposed an action that did not complete: ${s.summary}`);
          } else if (s.outcome === Outcome.VERIFICATION_FAILED) {
            noticeParts.push(`executed a proposed action but its result was NOT confirmed: ${s.summary}`);
          } else {
            noticeParts.push(`executed a proposed action but could not be independently verified: ${s.summary}`);
          }
        }
        const actionNotice = noticeParts.length ? `[APEX ${noticeParts.join('; ')}]` : '';
        // The audit output never includes content copied out of the stores. When no
        // model is configured, the directly shown records live only in `display`.
        output = [m.answer, m.annotation, actionNotice].filter(Boolean).join('\n\n');
        // Results of verified, model-proposed read actions are shown too, so the
        // user sees what was actually retrieved, not only the model's wording.
        const shownSteps = op.steps
          .filter((s) => s.origin === 'model' && s.outcome === Outcome.SUCCESS_VERIFIED && s.display)
          .map((s) => s.display);
        // A proposal the system declined to consider must be stated, not just
        // counted in the audit. This is display-only, like the other notices.
        const overflowNotice = m.proposalOverflow
          ? `[APEX considered only the first ${MAX_PROPOSALS} proposed actions; ${m.proposalOverflow} more ${m.proposalOverflow === 1 ? 'was' : 'were'} ignored.]`
          : '';
        displayText = [m.display ?? m.answer, ...shownSteps, m.annotation, actionNotice, overflowNotice].filter(Boolean).join('\n\n');
        op.backend = m.backend;
        if (m.error) op.errors.push(m.error);
        const turnRows = [];
        if (m.status === Outcome.VERIFICATION_UNAVAILABLE && m.hasText) {
          turnRows.push({ origin: TURN_ORIGINS.MODEL, text: m.modelText, verified: false });
        } else {
          turnRows.push({ origin: TURN_ORIGINS.NOTICE, text: m.answer, verified: false });
        }
        // A model-proposed action is an executed operation or a refusal, and the
        // next turn must be able to see which. Deterministic actions already record
        // their summary as a turn; proposals did not, so a later follow-up saw only
        // the model's own claim (or a placeholder) and lost the verified result or
        // the denial. A malformed proposal is rejected before it has an action name,
        // and that rejection must be replayable for the same reason. The summary
        // never includes retrieved memory or file content.
        for (const step of op.steps) {
          if (step.origin !== 'model') continue;
          if (typeof step.summary !== 'string' || step.summary.length === 0) continue;
          turnRows.push({
            origin: TURN_ORIGINS.ACTION,
            text: step.summary,
            verified: step.outcome === Outcome.SUCCESS_VERIFIED,
          });
        }
        await this.#recordTurns(op, sid, op.request, turnRows);

        if (saveAnswer && m.status === Outcome.VERIFICATION_UNAVAILABLE && m.hasText) {
          // Storing a model answer is a user-approved write, never automatic.
          const step = await this.runAction(
            'memory.save_conclusion',
            { content: m.modelText, operationId: op.id, backend: m.backend },
            'user',
            op.id,
          );
          op.steps.push(step);
          displayText = `${displayText}\n\n${step.display ?? step.summary}`;
        }
        }
      }
      }
      }
    }

    // A turn that could not be saved to conversation history must not vanish
    // silently: the answer itself is still valid, but a later turn may not see it.
    // This is display-only and never becomes part of the model's turn text.
    const notice = this.#historyGapNotice(op, 'exchange');
    if (notice) {
      displayText = displayText ? `${displayText}\n\n${notice}` : notice;
    }

    op.status = status;
    op.decision = classifyDecision(op);
    op.output = output ? truncate(output, MAX_OUTPUT_CHARS) : null;
    op.finishedAt = this.now().toISOString();

    const persisted = { ...op, steps: op.steps.map(stripDisplay) };
    const { recorded, recordError, captureNotice } = await finalizeOperation(persisted, {
      append: (record) => this.operations.append(record),
      capture: (record, opts) => this.#captureExperience(record, opts),
    });
    const finalDisplay = captureNotice ? `${displayText ? `${displayText}\n\n` : ''}${captureNotice}` : displayText;
    return { operation: persisted, status, decision: persisted.decision, output: op.output, display: finalDisplay, recorded, recordError };
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
    op.decision = classifyDecision(op);
    op.output = step.summary ? truncate(step.summary, MAX_OUTPUT_CHARS) : null;
    op.finishedAt = this.now().toISOString();

    const { recorded, recordError, captureNotice } = await finalizeOperation(op, {
      append: (record) => this.operations.append({ ...record, steps: record.steps.map(stripDisplay) }),
      capture: (record, opts) => this.#captureExperience(record, opts),
      onAuditFailure: (err) => {
        op.errors.push({ stage: 'audit', code: 'AUDIT_WRITE_FAILED', message: err.message });
        op.status = Outcome.AUDIT_INTEGRITY_FAILED;
        op.decision = classifyDecision(op);
        op.output = 'The correction may have been stored, but its audit record could not be written; it is not reported as verified success.';
      },
    });
    const baseDisplay = recorded ? (step.display ?? step.summary) : op.output;
    return {
      operation: op,
      status: op.status,
      decision: op.decision,
      output: op.output,
      display: captureNotice ? `${baseDisplay}\n\n${captureNotice}` : baseDisplay,
      recorded,
      recordError,
    };
  }

  // Read-only memory integrity summary. Like `knowledge health` it is a direct,
  // unaudited read that never calls the model and writes nothing. Counts cover
  // readable records only when the log is damaged; an unreadable store is never
  // reported as empty.
  async memoryHealth() {
    const health = await this.memory.health();
    const lines = ['Memory health (read-only; derived from stored records; nothing is repaired)'];
    if (!health.inspected) {
      lines.push(`  Store:          unavailable (${truncate(health.detail ?? 'the store could not be read', 200)})`);
      lines.push('  Records:        unavailable');
      lines.push('  Inspection:     incomplete: no record, provenance, correction, or integrity count can be established');
      lines.push('  Note:           an unreadable store is not an empty store; check APEX_DATA_DIR, permissions, and free space.');
    } else {
      const empty = health.records === 0;
      lines.push(`  Store:          ${health.corruptLines > 0
        ? `damaged - ${health.corruptLines} corrupt line(s); inspection incomplete`
        : empty
          ? 'ok - empty store (no memory records)'
          : 'ok - fully inspected'}`);
      lines.push(`  Records:        ${health.records} readable`);
      lines.push(`    user facts:   ${health.kinds.user_fact}`);
      lines.push(`    model conclusions: ${health.kinds.model_conclusion}`);
      lines.push(`    private:      ${health.privateRecords} (never sent to a model)`);
      lines.push(`    corrections:  ${health.corrections} (replacing ${health.replacedClaims} claim(s))`);
      lines.push(`  Provenance:     user_confirmed ${health.updateModes.user_confirmed}, model_proposed ${health.updateModes.model_proposed}, unresolved_conflict ${health.updateModes.unresolved_conflict}`);
      lines.push(`  Corrupt lines:  ${health.corruptLines}`);
      for (const entry of health.corrupt.slice(0, MAX_HEALTH_SAMPLES)) {
        lines.push(`    - line ${entry.line}: ${truncate(entry.reason, 160)}${entry.truncatedTail ? ' (final line without a newline)' : ''}`);
      }
      if (health.corrupt.length > MAX_HEALTH_SAMPLES) {
        lines.push(`    - ${health.corrupt.length - MAX_HEALTH_SAMPLES} more corrupt line(s) not shown`);
      }
      lines.push(`  Anomalies:      ${health.anomalies.count === 0
        ? 'none detected among readable records'
        : `${health.anomalies.count}${health.anomalies.truncated ? ` (first ${health.anomalies.samples.length} shown)` : ''}`}`);
      for (const sample of health.anomalies.samples) lines.push(`    - ${sample}`);
      if (health.corruptLines > 0) {
        lines.push('  Inspection:     incomplete: counts cover readable records only; corrupt lines could change every count.');
      }
    }
    lines.push('  Note:           a record proves only that it parsed and its content hash matches; it does not prove the content is true. No integrity count proves the log is authentic or free of deliberate editing.');
    const display = lines.join('\n');
    const status = health.inspected ? Outcome.SUCCESS_VERIFIED : Outcome.EXECUTION_FAILED;
    return {
      operation: null,
      status,
      decision: classifyDecision({ status }),
      output: display,
      display,
      recorded: false,
      recordError: null,
      health,
    };
  }

  // Read-only audit integrity summary. It never appends an operation record, never
  // reads a request or output body, and does not claim tamper evidence the format does
  // not provide: the log is append-only JSONL with no hash chain, signature, or anchor.
  async auditHealth() {
    const health = await this.operations.health();
    const lines = ['Audit health (read-only; derived from stored operation records; nothing is repaired)'];
    if (!health.inspected) {
      lines.push(`  Store:          unavailable (${truncate(health.detail ?? 'the log could not be read', 200)})`);
      lines.push('  Records:        unavailable');
      lines.push('  Inspection:     incomplete: no operation, outcome, or integrity count can be established');
      lines.push('  Note:           an unreadable log is not an empty log; check APEX_DATA_DIR, permissions, and free space.');
    } else {
      const empty = health.records === 0;
      lines.push(`  Store:          ${health.corruptLines > 0
        ? `damaged - ${health.corruptLines} corrupt line(s); inspection incomplete`
        : empty
          ? 'ok - empty log (no operation records)'
          : 'ok - fully inspected'}`);
      lines.push(`  Records:        ${health.records} readable operation record(s)`);
      const outcomes = Object.entries(health.outcomes).filter(([, count]) => count > 0);
      lines.push(`  Outcomes:       ${outcomes.length > 0
        ? outcomes.map(([name, count]) => `${name} ${count}`).join(', ')
        : 'none'}`);
      lines.push(`  Corrupt lines:  ${health.corruptLines}`);
      for (const entry of health.corrupt.slice(0, MAX_HEALTH_SAMPLES)) {
        lines.push(`    - line ${entry.line}: ${truncate(entry.reason, 160)}${entry.truncatedTail ? ' (final line without a newline)' : ''}`);
      }
      if (health.corrupt.length > MAX_HEALTH_SAMPLES) {
        lines.push(`    - ${health.corrupt.length - MAX_HEALTH_SAMPLES} more corrupt line(s) not shown`);
      }
      lines.push(`  Anomalies:      ${health.anomalies.count === 0
        ? 'none detected among readable records'
        : `${health.anomalies.count}${health.anomalies.truncated ? ` (first ${health.anomalies.samples.length} shown)` : ''}`}`);
      for (const sample of health.anomalies.samples) lines.push(`    - ${sample}`);
      if (health.corruptLines > 0) {
        lines.push('  Inspection:     incomplete: counts cover readable records only; corrupt lines could change every count.');
      }
    }
    lines.push('  Integrity:      parse-only: records are checked structurally. There is no hash chain, signature, or external anchor, so a clean parse does not prove authenticity and deliberate editing cannot be detected.');
    lines.push('  Note:           this check writes no audit record and displays no request or output body.');
    const display = lines.join('\n');
    const status = health.inspected ? Outcome.SUCCESS_VERIFIED : Outcome.EXECUTION_FAILED;
    return {
      operation: null,
      status,
      decision: classifyDecision({ status }),
      output: display,
      display,
      recorded: false,
      recordError: null,
      health,
    };
  }

  // Read-only epistemic projection. It owns no state: it reads memory and knowledge,
  // writes no audit record, calls no model, and never repairs or resolves anything.
  // The temporal section is derived from the experience log by deterministic code; when that log
  // cannot be read it is reported as unavailable, and the projection is not presented as complete.
  async worldState({ limit } = {}) {
    let temporal = null;
    if (this.experience) {
      try {
        temporal = { available: true, ...(await this.experience.temporalSummary()) };
      } catch (err) {
        temporal = { available: false, detail: err?.message ?? String(err) };
      }
    }
    const world = await buildWorldState({ memory: this.memory, knowledge: this.knowledge, now: this.now, limit, temporal });
    const display = renderWorldState(world);
    const status = world.complete ? Outcome.SUCCESS_VERIFIED : Outcome.EXECUTION_FAILED;
    return {
      operation: null,
      status,
      decision: classifyDecision({ status }),
      output: display,
      display,
      recorded: false,
      recordError: null,
      world,
    };
  }

  // ---- knowledge operations --------------------------------------------------
  // All knowledge writes require user origin and go through runAction so that
  // authorization, execution, and verification follow the same path as memory.

  #knowledgeOp(capability) {
    if (!this.knowledge) throw new ValidationError('knowledge store is not available in this configuration');
    return this.#newOp({ capability, origin: 'user', request: capability });
  }

  // A direct, unaudited read (`show`, `history`) that could not resolve one record.
  // Nothing was written, so there is no operation record to point at.
  #knowledgeReadMiss(output) {
    return {
      operation: null,
      status: Outcome.INPUT_REJECTED,
      decision: classifyDecision({ status: Outcome.INPUT_REJECTED }),
      output,
      display: output,
      recorded: false,
      recordError: null,
    };
  }

  // Automatic capture, attempted only after the audit record has been written: an experience is a
  // verified reference to one, so without the audit line there is nothing for it to point at.
  //
  // It returns a notice for the user or `null`, and it never changes `op.status`. An operation that
  // succeeded stays successful whether or not the experience was written, because the two claims
  // rest on different evidence: the operation was confirmed by its own verifier, while the
  // experience can only be reported once the store has read it back against the audit record.
  async #captureExperience(op, { recorded }) {
    if (!this.experience || typeof this.experience.recordExperience !== 'function') return null;
    if (this.experienceCapture === CAPTURE_OFF) return null;
    const decision = autoCaptureDecision(op, { mode: this.experienceCapture, recorded });
    // An ineligible operation stays silent: nothing was asked for and nothing was attempted, so a
    // line about it would read as a failure. Only a capture that was tried is reported.
    if (!decision.eligible) return null;
    const about = `operation ${shortId(op.id)} (${op.capability})`;
    let written;
    try {
      // `origin` here is the store's permission check, not a claim about who authored the record:
      // the user enabled capture, and the record's own provenance says `system_observed`.
      written = await this.experience.recordExperience({
        operationId: op.id,
        subject: decision.subject,
        capture: CAPTURE_AUTOMATIC,
        provenance: { operationId: op.id },
        origin: 'user',
      });
    } catch (err) {
      if (err?.code === 'EXPERIENCE_EXISTS') {
        return `Experience: ${about} already had a record, so nothing was duplicated.`;
      }
      return `Experience: not captured (${err?.message ?? String(err)}). ${about} succeeded and its audit record is unchanged; "experience record ${shortId(op.id)}" asks for it explicitly.`;
    }
    let check;
    try {
      check = await this.experience.evidenceCheck(written.record.id);
    } catch (err) {
      check = { ok: false, detail: `the independent check could not run (${err?.message ?? String(err)})` };
    }
    // Reported as captured only after that read-back agrees with the audit record.
    if (!check.ok) {
      return `Experience: appended as ${shortId(written.record.id)} for ${about}, but it does not match the audit record (${check.detail}); "experience health" shows the damage. ${about} itself succeeded and its audit record is unchanged.`;
    }
    return `Experience: captured automatically as ${shortId(written.record.id)} from ${about}. APEX recorded no assessment of it - feedback is yours alone.`;
  }

  async #finishCommandOp(op, step, failMsg) {
    op.steps.push(step);
    op.status = step.outcome;
    op.decision = classifyDecision(op);
    op.output = step.summary ? truncate(step.summary, MAX_OUTPUT_CHARS) : null;
    op.finishedAt = this.now().toISOString();
    const { recorded, recordError, captureNotice } = await finalizeOperation(op, {
      append: (record) => this.operations.append({ ...record, steps: record.steps.map(stripDisplay) }),
      capture: (record, opts) => this.#captureExperience(record, opts),
      onAuditFailure: (err) => {
        // An audited read has nothing that could have changed, so it keeps its own outcome; a
        // command whose failMsg is set may have changed something and must not claim success.
        if (!failMsg) return;
        op.errors.push({ stage: 'audit', code: 'AUDIT_WRITE_FAILED', message: err.message });
        op.status = Outcome.AUDIT_INTEGRITY_FAILED;
        op.decision = classifyDecision(op);
        op.output = failMsg;
      },
    });
    const display = step.display ?? step.summary;
    return {
      operation: op,
      status: op.status,
      decision: op.decision,
      output: op.output,
      display: captureNotice ? `${display}\n\n${captureNotice}` : display,
      recorded,
      recordError,
    };
  }

  async knowledgeAdd({ subject, relationship, object: obj, evidence = null, supersedes = [] } = {}) {
    const op = this.#knowledgeOp('knowledge.add');
    op.request = knowledgeAddRequest(subject, relationship, obj, supersedes);
    const step = await this.runAction(
      'knowledge.add',
      { subject, relationship, object: obj, evidence, supersedes },
      'user',
      op.id,
    );
    return this.#finishCommandOp(op, step, 'The knowledge record may have been stored, but its audit record could not be written.');
  }

  async knowledgeRetract({ target, reason = null } = {}) {
    const op = this.#knowledgeOp('knowledge.retract');
    op.request = knowledgeRetractRequest(target, reason);
    const step = await this.runAction('knowledge.retract', { target, reason }, 'user', op.id);
    return this.#finishCommandOp(op, step, 'The knowledge record may have been retracted, but its audit record could not be written.');
  }

  async knowledgeResolve({ target, choose, reason = null } = {}) {
    const op = this.#knowledgeOp('knowledge.resolve');
    op.request = knowledgeResolveRequest(target, choose, reason);
    const step = await this.runAction('knowledge.resolve', { target, choose, reason }, 'user', op.id);
    return this.#finishCommandOp(
      op,
      step,
      'The resolution decision may have been recorded, but its audit record could not be written; it is not reported as verified success.',
    );
  }

  async knowledgeList({ limit } = {}) {
    const op = this.#knowledgeOp('knowledge.list');
    const step = await this.runAction('knowledge.list', { limit: limit ?? 20 }, 'user', op.id);
    return this.#finishCommandOp(op, step, null);
  }

  async knowledgeSearch(query) {
    if (!this.knowledge) throw new ValidationError('knowledge store is not available in this configuration');
    const safeQuery = typeof query === 'string' ? query : '';
    const request = containsSecret(safeQuery)
      ? 'knowledge search [query omitted: contained a password, key, or token]'
      : `knowledge search [${safeQuery}]`;
    const op = this.#newOp({ capability: 'knowledge.search', origin: 'user', request });
    const step = await this.runAction('knowledge.search', { query, limit: 10 }, 'user', op.id);
    return this.#finishCommandOp(op, step, null);
  }

  async knowledgeShow(idPrefix) {
    if (!this.knowledge) throw new ValidationError('knowledge store is not available in this configuration');
    if (typeof idPrefix !== 'string' || idPrefix.trim().length === 0) throw new ValidationError('knowledge show requires a record id');
    const records = await this.knowledge.findByPrefix(idPrefix);
    if (records.length === 0) {
      return this.#knowledgeReadMiss(`No knowledge record found with id prefix "${idPrefix.trim()}"`);
    }
    if (records.length > 1) {
      return this.#knowledgeReadMiss(`Id prefix "${idPrefix.trim()}" matches ${records.length} knowledge records; use a longer prefix.`);
    }
    const match = records[0];
    const conflictLine = match.conflictsWith?.length
      ? `  CONFLICTS WITH: ${match.conflictsWith.map(shortId).join(', ')}`
      : '';
    const resolutionLine = match.resolution
      ? `  RESOLUTION:    ${match.resolution.chosen
        ? 'this claim was chosen'
        : `another claim ${shortId(match.resolution.chosenId)} was chosen`} by explicit user decision (event ${shortId(match.resolution.id)}); this records a decision, not verified truth`
      : match.conflictState === 'unresolved'
        ? '  RESOLUTION:    none recorded; the conflict is unresolved'
        : '';
    const replacesLine = match.replaces?.length
      ? `  REPLACES:      ${match.replaces.map(shortId).join(', ')}`
      : '';
    const supersededLine = match.supersededBy?.length
      ? `  SUPERSEDED BY:  ${match.supersededBy.map(shortId).join(', ')}`
      : '';
    const retractedLine = match.retraction
      ? `  RETRACTED:     ${match.retraction.createdAt}${match.retraction.reason ? ` — ${match.retraction.reason}` : ' (no reason given)'} (event ${shortId(match.retraction.id)})`
      : '';
    const lifecycleLine = match.lifecycleState === 'ambiguous'
      ? `  LIFECYCLE:     ambiguous — ${match.lifecycleNote}; not active`
      : '';
    const evidenceLine = match.evidence ? `  Evidence:      ${match.evidence}` : '';
    const display = [
      `Knowledge Record ${match.id}`,
      `  Subject:       ${match.subject}`,
      `  Relationship:  ${match.relationship}`,
      `  Object:        ${match.object}`,
      evidenceLine,
      `  Status:        ${match.status}`,
      lifecycleLine,
      conflictLine,
      resolutionLine,
      replacesLine,
      supersededLine,
      retractedLine,
      `  Provenance:    ${match.provenance?.origin ?? 'unknown'} (${match.provenance?.updateMode ?? 'unknown'})`,
      match.provenance?.operationId ? `  Operation:     ${match.provenance.operationId}` : '',
      `  Recorded at:   ${match.createdAt}`,
    ].filter(Boolean).join('\n');
    return {
      operation: null,
      status: Outcome.SUCCESS_VERIFIED,
      decision: classifyDecision({ status: Outcome.SUCCESS_VERIFIED }),
      output: display,
      display,
      recorded: false,
      recordError: null,
    };
  }

  // Read-only lifecycle inspection. Resolves exactly one claim, then reports only what
  // the stored records and events establish. It never calls the model and writes nothing;
  // like `show`, it is a direct read with no operation record.
  async knowledgeHistory(idPrefix) {
    if (!this.knowledge) throw new ValidationError('knowledge store is not available in this configuration');
    if (typeof idPrefix !== 'string' || idPrefix.trim().length === 0) {
      throw new ValidationError('knowledge history requires a record id');
    }
    const records = await this.knowledge.findByPrefix(idPrefix);
    if (records.length === 0) {
      return this.#knowledgeReadMiss(`No knowledge record found with id prefix "${idPrefix.trim()}"`);
    }
    if (records.length > 1) {
      return this.#knowledgeReadMiss(`Id prefix "${idPrefix.trim()}" matches ${records.length} knowledge records; use a longer prefix.`);
    }
    const view = await this.knowledge.history(records[0].id);
    if (!view) {
      return this.#knowledgeReadMiss(`No knowledge record found with id prefix "${idPrefix.trim()}"`);
    }
    const rec = view.record;
    const stateLine = view.lifecycleNote
      ? `  State:         ambiguous — ${view.lifecycleNote}; not active`
      : `  State:         ${rec.lifecycleState}${rec.active ? '' : ' (historical)'}`;
    const retractionLine = view.retraction
      ? `  Retraction:    ${view.retraction.createdAt}${view.retraction.reason ? ` — ${view.retraction.reason}` : ' (no reason given)'} (event ${shortId(view.retraction.id)})`
      : view.retractionAmbiguous
        ? '  Retraction:    ambiguous — more than one retraction event targets this record'
        : '';
    const resolutionLines = (view.resolutions ?? []).map((entry) => {
      const choice = entry.chosen ? 'chose this claim' : `chose ${shortId(entry.chosenId)}`;
      const standing = entry.applicable
        ? 'governs the current conflict group'
        : `does not govern the current conflicts${entry.note ? `: ${entry.note}` : ''}`;
      return `  Resolution:    ${entry.createdAt}${entry.reason ? ` — ${entry.reason}` : ' (no reason given)'} — ${choice} (event ${shortId(entry.id)}); a user decision, not verified truth; ${standing}`;
    });
    if (view.resolutionsTruncated) resolutionLines.unshift('  Resolution:    earlier events are not shown (bounded view)');
    const replacesLine = view.replaces.length
      ? `  Supersedes:    ${view.replaces.map((r) => `${r.shortId} (recorded ${String(r.createdAt).slice(0, 10)})`).join(', ')}`
      : '  Supersedes:    (none)';
    const replacedByLine = view.replacedBy.length
      ? `  Superseded by: ${view.replacedBy.map((r) => `${r.shortId} (recorded ${String(r.createdAt).slice(0, 10)})`).join(', ')}`
      : '  Superseded by: (none)';
    const chainLines = view.chain.length
      ? [
          `  Chain:         ${view.chain.length} record(s), oldest first${view.chainTruncated ? ' (truncated)' : ''}`,
          ...view.chain.map((entry, index) => `    ${index + 1}. [${entry.shortId}] ${truncate(entry.subject, 60)} --[${truncate(entry.relationship, 40)}]--> ${truncate(entry.object, 60)}  state: ${entry.state}`),
        ]
      : ['  Chain:         (none)'];
    const chainNote = view.complete
      ? '  Chain note:    complete: every supersession link resolves'
      : `  Chain note:    limited: ${view.problems.join('; ') || 'chain was truncated'}`;
    const evidenceLine = rec.evidence ? `  Evidence:      ${truncate(rec.evidence, 200)}` : '';
    const display = [
      `Knowledge lifecycle for ${rec.id}`,
      `  Claim:         ${truncate(rec.subject, 60)} --[${truncate(rec.relationship, 40)}]--> ${truncate(rec.object, 60)}`,
      evidenceLine,
      `  Provenance:    ${rec.provenance?.origin ?? 'unknown'} (${rec.provenance?.updateMode ?? 'unknown'})`,
      rec.provenance?.operationId ? `  Operation:     ${rec.provenance.operationId}` : '',
      `  Recorded at:   ${rec.createdAt}`,
      stateLine,
      replacesLine,
      replacedByLine,
      retractionLine,
      ...resolutionLines,
      ...chainLines,
      chainNote,
    ].filter(Boolean).join('\n');
    return {
      operation: null,
      status: Outcome.SUCCESS_VERIFIED,
      decision: classifyDecision({ status: Outcome.SUCCESS_VERIFIED }),
      output: display,
      display,
      recorded: false,
      recordError: null,
    };
  }

  // Read-only store-wide health. Like `show` and `history` it is a direct, unaudited
  // read: no model is consulted and nothing is written. A damaged or unreadable store
  // is reported as such and never as empty. The summary is derived at read time; there
  // is no persisted copy that could go stale.
  async knowledgeHealth() {
    if (!this.knowledge) throw new ValidationError('knowledge store is not available in this configuration');
    const health = await this.knowledge.health();
    const lines = ['Knowledge health (read-only; derived from stored records; nothing is repaired)'];
    if (!health.inspected) {
      lines.push(`  Store:          unavailable (${truncate(health.detail ?? 'the store could not be read', 200)})`);
      lines.push('  Claims:         unavailable');
      lines.push('  Lifecycle:      unavailable');
      lines.push('  Inspection:     incomplete: no claim, event, lifecycle, or conflict count can be established');
      lines.push('  Note:           an unreadable store is not an empty store; check APEX_DATA_DIR, permissions, and free space.');
    } else {
      const empty = health.claims === 0 && health.lifecycleEvents === 0;
      lines.push(`  Store:          ${health.corruptLines > 0
        ? `damaged - ${health.corruptLines} corrupt line(s); inspection incomplete`
        : empty
          ? 'ok - empty store (no claims or lifecycle events)'
          : 'ok - fully inspected'}`);
      lines.push(`  Claims:         ${health.claims} total`);
      lines.push(`    active:       ${health.active}`);
      lines.push(`    superseded:   ${health.superseded}`);
      lines.push(`    retracted:    ${health.retracted}`);
      lines.push(`    ambiguous:    ${health.ambiguous}`);
      const conflictNote = health.conflicts.groups > 0
        ? ` (${health.conflicts.samples.join('; ')})`
        : '';
      const resolvedNote = health.conflicts.resolvedGroups > 0
        ? `; ${health.conflicts.resolvedGroups} group(s) with a recorded user decision (a decision, not verified truth)`
        : '';
      lines.push(`  Conflicts:      ${health.conflicts.groups > 0
        ? `${health.conflicts.groups} unresolved group(s), ${health.conflicts.claims} active claim(s)${conflictNote}`
        : 'none unresolved among active claims'}${resolvedNote}`);
      lines.push(`  Lifecycle:      ${health.lifecycleEvents > 0 && health.resolutions > 0
        ? `${health.lifecycleEvents} event(s) (${health.retractions} retraction + ${health.resolutions} resolution; not claims)`
        : `${health.lifecycleEvents} event(s) (retraction events; not claims)`}`);
      const chainNote = health.chains.truncated > 0
        ? `; ${health.chains.truncated} exceed the ${MAX_HISTORY_CHAIN}-record history view bound (history shows a truncated chain, not damage)`
        : '';
      lines.push(`  Chains:         ${health.chains.components} linked component(s), largest ${health.chains.largest} claim(s)${chainNote}`);
      lines.push(`  Corrupt lines:  ${health.corruptLines}`);
      for (const c of health.corrupt.slice(0, MAX_HEALTH_SAMPLES)) {
        lines.push(`    - line ${c.line}: ${truncate(c.reason, 160)}${c.truncatedTail ? ' (final line without a newline)' : ''}`);
      }
      if (health.corrupt.length > MAX_HEALTH_SAMPLES) {
        lines.push(`    - ${health.corrupt.length - MAX_HEALTH_SAMPLES} more corrupt line(s) not shown`);
      }
      lines.push(`  Anomalies:      ${health.anomalies.count === 0
        ? 'none detected among readable records'
        : `${health.anomalies.count}${health.anomalies.truncated ? ` (first ${health.anomalies.samples.length} shown)` : ''}`}`);
      for (const sample of health.anomalies.samples) lines.push(`    - ${sample}`);
      if (health.corruptLines > 0) {
        lines.push('  Inspection:     incomplete: counts cover readable records only; corrupt lines could change every count, and lifecycle completeness cannot be established.');
      }
    }
    lines.push('  Note:           supersession, retraction, and resolution record history or decisions, not truth; unresolved conflicts require explicit handling.');
    const display = lines.join('\n');
    const status = health.inspected ? Outcome.SUCCESS_VERIFIED : Outcome.EXECUTION_FAILED;
    return {
      operation: null,
      status,
      decision: classifyDecision({ status }),
      output: display,
      display,
      recorded: false,
      recordError: null,
      health,
    };
  }

  // ---- experience, feedback, and adaptation operations -------------------------
  // Every command below names one registered action and runs it through `runAction`, so
  // authorization, execution, and independent verification are the same as for any other write.
  // There is deliberately no natural-language route to them: a model choosing words like
  // "remember that this worked" must not be able to record the user's assessment or approve a
  // behaviour rule, so this explicit, user-origin call is the only entry point besides the CLI.

  #experienceOp(capability) {
    if (!this.experience) throw new ValidationError('the experience store is not available in this configuration');
    return this.#newOp({ capability, origin: 'user', request: capability });
  }

  async experienceRecord({ operationId, subject, replaces = [] } = {}) {
    const op = this.#experienceOp('experience.record');
    const step = await this.runAction('experience.record', { operationId, subject, replaces }, 'user', op.id);
    return this.#finishCommandOp(op, step, 'The experience may have been recorded, but its audit record could not be written; it is not reported as verified success.');
  }

  async experienceList({ limit } = {}) {
    const op = this.#experienceOp('experience.list');
    const step = await this.runAction('experience.list', { limit: limit ?? 20 }, 'user', op.id);
    return this.#finishCommandOp(op, step, null);
  }

  async experienceShow({ target } = {}) {
    const op = this.#experienceOp('experience.show');
    const step = await this.runAction('experience.show', { target }, 'user', op.id);
    return this.#finishCommandOp(op, step, null);
  }

  // Temporal reads. Each one runs through the same registry, verifier, and finalization path as
  // every other command, but it writes nothing and its failure mode is a read error: an unreadable
  // or corrupt log is reported as unreadable rather than as an empty history.
  async experienceTimeline({ since, until, days, capability, limit } = {}) {
    const op = this.#experienceOp('experience.timeline');
    const step = await this.runAction('experience.timeline', { since, until, days, capability, limit }, 'user', op.id);
    return this.#finishCommandOp(op, step, null);
  }

  async experienceTrends({ since, until, days, capability, limit } = {}) {
    const op = this.#experienceOp('experience.trends');
    const step = await this.runAction('experience.trends', { since, until, days, capability, limit }, 'user', op.id);
    return this.#finishCommandOp(op, step, null);
  }

  async experiencePatterns({ since, until, days, capability, limit } = {}) {
    const op = this.#experienceOp('experience.patterns');
    const step = await this.runAction('experience.patterns', { since, until, days, capability, limit }, 'user', op.id);
    return this.#finishCommandOp(op, step, null);
  }

  async experienceCompare({ aSince, aUntil, bSince, bUntil, days, capability } = {}) {
    const op = this.#experienceOp('experience.compare');
    const step = await this.runAction(
      'experience.compare',
      { aSince, aUntil, bSince, bUntil, days, capability },
      'user',
      op.id,
    );
    return this.#finishCommandOp(op, step, null);
  }

  async feedbackRecord({ target, assessment, guidance = null, reason = null, supersedes = [] } = {}) {
    const op = this.#experienceOp('feedback.record');
    const step = await this.runAction(
      'feedback.record',
      { target, assessment, guidance, reason, supersedes },
      'user',
      op.id,
    );
    return this.#finishCommandOp(op, step, 'The feedback may have been recorded, but its audit record could not be written; it is not reported as verified success.');
  }

  async adaptationDerive({ minSupport } = {}) {
    const op = this.#experienceOp('adaptation.derive');
    const input = minSupport === undefined || minSupport === null ? {} : { minSupport };
    const step = await this.runAction('adaptation.derive', input, 'user', op.id);
    return this.#finishCommandOp(op, step, 'The candidates may have been derived, but their audit record could not be written; they are not reported as verified success.');
  }

  // `decision` comes from the command that was typed (approve / reject), never from a default:
  // silence is not approval, and neither is a missing argument.
  async adaptationDecide({ target, decision, reason = null } = {}) {
    const op = this.#experienceOp(`adaptation.${decision === 'rejected' ? 'reject' : 'approve'}`);
    const step = await this.runAction('adaptation.decide', { target, decision, reason }, 'user', op.id);
    return this.#finishCommandOp(op, step, 'The decision may have been recorded, but its audit record could not be written; it is not reported as verified success.');
  }

  async adaptationRetire({ target, reason = null } = {}) {
    const op = this.#experienceOp('adaptation.retire');
    const step = await this.runAction('adaptation.retire', { target, reason }, 'user', op.id);
    return this.#finishCommandOp(op, step, 'The retirement may have been recorded, but its audit record could not be written; it is not reported as verified success.');
  }

  async adaptationList({ limit, includeRetired } = {}) {
    const op = this.#experienceOp('adaptation.list');
    const input = { limit: limit ?? 20 };
    // Passed through as written: a value that is not a boolean is refused by the action's validator
    // rather than quietly read as one, because the difference decides whether retired rules the
    // user approved are hidden from the list they are checking.
    if (includeRetired !== undefined && includeRetired !== null) input.includeRetired = includeRetired;
    const step = await this.runAction('adaptation.list', input, 'user', op.id);
    return this.#finishCommandOp(op, step, null);
  }

  // Read-only inspection of the whole experience log, plus the check that gives the store its
  // meaning: every recorded experience re-verified against the audit record it names. Nothing is
  // repaired, nothing is approved, and an unreadable store is reported as unreadable, never as an
  // empty one.
  // Stated from the configuration this controller holds, never from what a request claimed.
  #captureSettingLine() {
    return captureSettingPhrase(this.experienceCapture);
  }

  async experienceHealth() {
    if (!this.experience) throw new ValidationError('the experience store is not available in this configuration');
    const health = await this.experience.health();
    const evidenceCheck = await this.#experienceEvidenceSummary();
    const evidence = evidenceCheck.line;
    const lines = ['Experience health (read-only; derived from stored records; nothing is repaired or approved)'];
    lines.push(`  Capture:        ${this.#captureSettingLine()}`);
    if (!health.inspected) {
      lines.push(`  Store:          unavailable (${truncate(health.detail ?? 'the store could not be read', 200)})`);
      lines.push(`  Evidence:       ${evidence}`);
      lines.push('  Inspection:     incomplete: no experience, feedback, or adaptation count can be established');
      lines.push('  Note:           an unreadable store is not an empty store; check APEX_DATA_DIR, permissions, and free space.');
    } else {
      const empty = health.experiences === 0 && health.feedback === 0 && health.adaptations === 0;
      lines.push(`  Store:          ${health.corruptLines > 0
        ? `damaged - ${health.corruptLines} corrupt line(s); inspection incomplete`
        : empty
          ? 'ok - empty store (no experiences, feedback, or adaptations)'
          : 'ok - fully inspected'}`);
      lines.push(`  Experiences:    ${health.experiences} record(s) (${health.activeExperiences} live, ${health.supersededExperiences} corrected by a later record)`);
      lines.push(`  How recorded:   ${health.recordedByUser} recorded by you, ${health.capturedAutomatically} captured automatically${health.unknownCapture > 0 ? `, ${health.unknownCapture} with capture provenance no writer produces` : ''}`);
      lines.push(`  Feedback:       ${health.feedback} record(s) (${health.currentFeedback} current, ${health.supersededFeedback} corrected)`);
      lines.push(`  Adaptations:    ${health.adaptations} derived - candidate ${health.candidates}, approved ${health.approved}, in effect ${health.activeAdaptations}, rejected ${health.rejectedAdaptations}, retired ${health.retiredAdaptations}, ambiguous ${health.ambiguousAdaptations}`);
      lines.push(`  Decisions:      ${health.decisions} user decision(s), ${health.retirements} retirement(s) recorded`);
      lines.push(`  Evidence:       ${evidence}`);
      lines.push(`  Conflicts:      ${health.conflicts.scopes > 0
        ? `${health.conflicts.scopes} scope(s) with ${health.conflicts.adaptations} active rule(s) that say different things (${health.conflicts.samples.join('; ')}) - both are shown as conflicting; APEX does not choose`
        : 'none among adaptations in effect'}`);
      lines.push(`  Next step:      ${health.pending.derivableCandidates > 0
        ? `${health.pending.derivableCandidates} candidate(s) could be derived from feedback already recorded${health.pending.scopes.length ? ` (scope(s): ${health.pending.scopes.join(', ')})` : ''}; run "apex adaptation derive"`
        : 'no feedback support that has not already been derived'}`);
      lines.push(`  Corrupt lines:  ${health.corruptLines}`);
      for (const c of health.corrupt.slice(0, MAX_HEALTH_SAMPLES)) {
        lines.push(`    - line ${c.line}: ${truncate(c.reason, 160)}${c.truncatedTail ? ' (final line without a newline)' : ''}`);
      }
      if (health.corrupt.length > MAX_HEALTH_SAMPLES) {
        lines.push(`    - ${health.corrupt.length - MAX_HEALTH_SAMPLES} more corrupt line(s) not shown`);
      }
      lines.push(`  Anomalies:      ${health.anomalies.count === 0
        ? 'none detected among readable records'
        : `${health.anomalies.count}${health.anomalies.truncated ? ` (first ${health.anomalies.samples.length} shown)` : ''}`}`);
      for (const sample of health.anomalies.samples) lines.push(`    - ${sample}`);
      if (health.corruptLines > 0) {
        lines.push('  Inspection:     incomplete: counts cover readable records only; corrupt lines could change every count, and no lifecycle state can be established for them.');
      }
    }
    lines.push('  Note:           an experience is a reference to an audited event, not a fact about the user; feedback is the user\'s own assessment, never a model\'s; a rule applies only after the user approves it, and approval is not permission for any action.');
    const display = lines.join('\n');
    const status = health.inspected ? Outcome.SUCCESS_VERIFIED : Outcome.EXECUTION_FAILED;
    return {
      operation: null,
      status,
      decision: classifyDecision({ status }),
      output: display,
      display,
      recorded: false,
      recordError: null,
      health,
      // Carried apart from `health.attention`, which the store derives from its own log alone:
      // an experience that contradicts the audit event it names needs the user even when the
      // experience log itself parses.
      evidenceMismatch: evidenceCheck.mismatched,
    };
  }

  // The distinctive claim of this store is that a recorded experience still matches the event it
  // names, so health recomputes that instead of only counting lines. An audit log that cannot be
  // read is stated as unprovable, never as a pass. `mismatched` is returned separately because a
  // positive disagreement between two readable records is a defect the exit code must carry, while
  // an experience whose audit record is simply absent is not proof that it was invented.
  async #experienceEvidenceSummary() {
    try {
      const report = await this.experience.evidenceReport({ limit: 20 });
      if (!report.auditReadable) return { line: 'could not be checked against the audit log', mismatched: 0 };
      const parts = [`${report.verified}/${report.checked} recent experience(s) re-verified against the audit log`];
      if (report.mismatched > 0) parts.push(`${report.mismatched} disagree with the event they name`);
      if (report.missingAudit > 0) parts.push(`${report.missingAudit} name an operation that is not in the audit log`);
      if (report.experiences > report.checked) parts.push(`${report.experiences - report.checked} older experience(s) not sampled`);
      if (report.auditCorruptLines > 0) parts.push(`${report.auditCorruptLines} corrupt audit line(s)`);
      return { line: parts.join('; '), mismatched: report.mismatched };
    } catch (err) {
      return { line: `could not be checked (${truncate(err?.message ?? String(err), 160)})`, mismatched: 0 };
    }
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
  // failure is reported in the operation's errors; it never hides the answer. `subject`
  // names what the failed write was, so the disclosure can only ever be about that.
  async #recordTurns(op, sid, userText, replies, { subject = 'exchange' } = {}) {
    if (!this.conversation || !sid) return;
    try {
      await this.conversation.append({ sessionId: sid, role: 'user', origin: TURN_ORIGINS.USER, text: userText, operationId: op.id });
    } catch (err) {
      op.errors.push({ stage: 'conversation', subject, code: err.code || 'STORE_ERROR', message: err.message });
      return;
    }
    for (const r of replies) await this.#recordAssistantTurn(op, sid, { ...r, subject });
  }

  // One assistant turn, with no user turn of its own. A task run has no conversational
  // request to record, only its result.
  async #recordAssistantTurn(op, sid, { origin, text, verified, taskId = null, signature = null, subject = 'exchange' }) {
    if (!this.conversation || !sid) return false;
    try {
      await this.conversation.append({
        sessionId: sid,
        role: 'assistant',
        origin,
        text,
        verified,
        operationId: op.id,
        taskId,
        signature,
      });
      return true;
    } catch (err) {
      op.errors.push({ stage: 'conversation', subject, code: err.code || 'STORE_ERROR', message: err.message });
      return false;
    }
  }

  // A turn that could not be saved to history must not vanish silently: the result
  // itself stands, but a later turn may not see it. Display-only: it never becomes part
  // of a stored turn or of the audited output. Both the failure and the queue outcome
  // are read only from errors about this same subject, so a failure that belongs to an
  // earlier result is never reported as this one.
  #historyGapNotice(op, subject) {
    const own = op.errors.filter((e) => e.stage === 'conversation' && (e.subject ?? 'exchange') === subject);
    const error = own.find((e) => e.code !== 'SUMMARY_QUEUED' && e.code !== 'SUMMARY_NOT_QUEUED');
    if (!error) return '';
    let reissue = '';
    if (own.some((e) => e.code === 'SUMMARY_QUEUED')) {
      reissue = ' APEX has queued it for reissue at the next task write.';
    } else if (own.some((e) => e.code === 'SUMMARY_NOT_QUEUED')) {
      reissue = ' It could not be queued, so it will not be reissued automatically.';
    }
    return `[This ${subject} could not be fully saved to conversation history (${error.code || 'STORE_ERROR'}); a later turn may not see it.${reissue}]`;
  }

  // Shown when a summary an earlier turn could not save is still owed after this turn
  // tried to reissue it. It is kept apart from the notice above so that a failed reissue
  // of an older result is never presented as this turn's own result being lost.
  #owedReissueNotice(op) {
    const own = op.errors.filter((e) => e.stage === 'conversation' && e.subject === 'earlier task result');
    if (own.length === 0) return '';
    const error = own.find((e) => e.code !== 'SUMMARY_QUEUED');
    const count = Math.max(1, own.filter((e) => e.code === 'SUMMARY_QUEUED').length);
    const what = count === 1 ? 'An earlier task result is' : `${count} earlier task results are`;
    const object = count === 1 ? 'it' : 'them';
    return ` [${what} still not in history (${error?.code || 'STORE_ERROR'}). APEX has queued ${object} for reissue at the next task write.]`;
  }

  // Shown when this turn wrote a task summary an earlier turn could not save. Claimed
  // only after the write has returned, so a reissue is never reported before it happened.
  #reissueNotice(op) {
    const count = op.errors.filter((e) => e.stage === 'queue' && e.code === 'SUMMARY_REISSUED').length;
    if (count === 0) return '';
    const verb = count === 1 ? 'has' : 'have';
    const plural = count === 1 ? '' : 's';
    return `\n\n[${count} earlier task result${plural} that could not be saved ${verb} now been written to history.]`;
  }

  // The summary turn history refused is kept as a delivery intent, so a later task write
  // can offer it again. Nothing here re-runs a step or changes task state: the queued
  // text is the summary of the state the task log already records.
  async #queueSummaryIntent(op, sid, summary) {
    if (!this.summaryQueue || !sid) {
      op.errors.push({
        stage: 'conversation',
        subject: 'task result',
        code: 'SUMMARY_NOT_QUEUED',
        message: `the task summary for ${shortId(summary.taskId)} cannot be queued in this configuration; it will not be reissued automatically`,
      });
      return false;
    }
    try {
      const result = await this.summaryQueue.add({
        sessionId: sid,
        taskId: summary.taskId,
        signature: summary.signature,
        text: summary.text,
        verified: summary.verified,
      });
      op.errors.push({
        stage: 'conversation',
        subject: 'task result',
        code: result.queued ? 'SUMMARY_QUEUED' : 'SUMMARY_NOT_QUEUED',
        message: result.queued
          ? `the task summary for ${shortId(summary.taskId)} (${result.reason}) is queued for reissue at the next task write`
          : `the task summary for ${shortId(summary.taskId)} could not be queued (${result.reason}); it will not be reissued automatically`,
      });
      return result.queued;
    } catch (err) {
      op.errors.push({
        stage: 'conversation',
        subject: 'task result',
        code: 'SUMMARY_NOT_QUEUED',
        message: `the task summary for ${shortId(summary.taskId)} could not be queued (${err.code || err.name}): it will not be reissued automatically`,
      });
      return false;
    }
  }

  async #settleSummaryIntent(op, entryId, reason) {
    if (!this.summaryQueue) return;
    try {
      await this.summaryQueue.settle(entryId);
    } catch (err) {
      // The intent outlives the failed cleanup, and the next pass recognises the state as
      // already summarised. This is queue housekeeping, not a lost turn, so it is recorded
      // apart from the history-gap notice rather than reported as one.
      op.errors.push({ stage: 'queue', code: 'SUMMARY_INTENT_KEPT', message: `a task summary intent (${reason}) could not be removed from the queue: ${err.code || err.name}` });
    }
  }

  // The reissue path for task summaries an earlier turn could not write. It reads the
  // task log to check that the state the intent describes is still the recorded state,
  // writes history, and stops there: no step runs, no task changes, and an intent is
  // dropped only once its turn is confirmed written or its state has moved on. A check
  // that cannot be made (a task log or history that cannot be read) leaves the intent in
  // place instead of guessing.
  async #deliverPendingSummaries(op, sid) {
    if (!this.conversation || !this.summaryQueue || !sid || !this.taskStore) return 0;
    let entries;
    try {
      entries = await this.summaryQueue.pending({ sessionId: sid });
    } catch (err) {
      op.errors.push({ stage: 'queue', code: err.code || 'STORE_ERROR', message: `queued task summaries could not be read (${err.message}); nothing was reissued` });
      return 0;
    }
    let delivered = 0;
    for (const entry of entries) {
      let current = null;
      try {
        current = await this.taskStore.get(entry.taskId);
      } catch (err) {
        op.errors.push({ stage: 'queue', code: err.code || 'STORE_ERROR', message: `the task log could not be read (${err.message}); a queued task summary was not reissued` });
        break;
      }
      // The state the intent describes is no longer the recorded state, or there is no
      // task to describe. Its summary would be stale, so it is dropped rather than
      // written; the state the task log holds now is summarised by the turn that produced
      // it, or queued by that turn's own failure.
      if (!current || taskStateSignature(current) !== entry.signature) {
        await this.#settleSummaryIntent(op, entry.id, current ? 'superseded' : 'task no longer in the log');
        continue;
      }
      // A duplicate is the worse failure: the write may have succeeded while the queue
      // cleanup did not. So the history is checked first, and a history that cannot be
      // checked stops the pass instead of writing over it.
      let already = null;
      try {
        already = await this.conversation.summarisedTaskStates(sid, entry.taskId);
      } catch (err) {
        op.errors.push({ stage: 'queue', code: err.code || 'STORE_ERROR', message: `an existing task summary could not be checked (${err.message}); nothing further was reissued` });
        break;
      }
      if (already.has(entry.signature)) {
        await this.#settleSummaryIntent(op, entry.id, 'already in history');
        continue;
      }
      const wrote = await this.#recordAssistantTurn(op, sid, {
        origin: TURN_ORIGINS.TASK,
        text: entry.text,
        verified: entry.verified,
        taskId: entry.taskId,
        signature: entry.signature,
        subject: 'earlier task result',
      });
      if (!wrote) {
        // Still owed. Stated as queued because that is what just happened: the intent is
        // in the queue, and the next task write will try again. The subject is distinct
        // from this turn's own task result, so the disclosure is never misattributed.
        op.errors.push({
          stage: 'conversation',
          subject: 'earlier task result',
          code: 'SUMMARY_QUEUED',
          message: `the queued task summary for task ${shortId(entry.taskId)} is still owed to history`,
        });
        continue;
      }
      delivered += 1;
      op.errors.push({ stage: 'queue', code: 'SUMMARY_REISSUED', message: `reissued the task summary for task ${shortId(entry.taskId)} (state ${entry.signature.slice(0, 8)}) that an earlier turn could not save` });
      await this.#settleSummaryIntent(op, entry.id, 'delivered');
    }
    return delivered;
  }

  // The history record of what a task run established. It is built from the task's own
  // replayed state plus the evidence the runner gathered, never from model text, and it
  // is written after the task lock is released. A task whose state is already summarised
  // in this session gets no second turn, so repeated recovery attempts cannot stack up
  // summaries of the same facts. If the turn cannot be written, the task log and the
  // audit record are already complete and are left exactly as they are: only the
  // operation's errors note the gap, and the turn is queued for a later write opportunity.
  async #recordTaskSummary(op, task, { recovery = null, auditGaps = [] } = {}) {
    if (!this.conversation || !task) return;
    const summary = buildTaskSummary(task, {
      evidence: {
        interrupted: recovery?.interrupted === true,
        recovered: recovery?.steps ?? [],
        auditGaps,
      },
    });
    if (!summary) return;
    const sid = await this.#resolveSession(null, op);
    if (!sid) return;
    await this.#deliverPendingSummaries(op, sid);
    let alreadySummarised = null;
    try {
      alreadySummarised = await this.conversation.summarisedTaskStates(sid, summary.taskId);
    } catch (err) {
      op.errors.push({
        stage: 'conversation',
        subject: 'task result',
        code: err.code || 'STORE_ERROR',
        message: `${err.message}; this task summary was written without checking for an earlier one`,
      });
    }
    if (alreadySummarised?.has(summary.signature)) return;
    const wrote = await this.#recordAssistantTurn(op, sid, {
      origin: TURN_ORIGINS.TASK,
      text: summary.text,
      verified: summary.verified,
      taskId: summary.taskId,
      signature: summary.signature,
      subject: 'task result',
    });
    if (!wrote) await this.#queueSummaryIntent(op, sid, summary);
  }

  async runAction(name, rawInput, origin, operationId) {
    const step = {
      action: typeof name === 'string' ? name : null,
      origin,
      input: auditInputFor(name, rawInput),
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
    const ctx = { memory: this.memory, knowledge: this.knowledge, experience: this.experience, now: this.now, getStatus: this.getStatus, operationId, origin, root: this.rootForContext };
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
      decision: null,
      output: null,
      errors: [],
      finishedAt: null,
    };
  }

  async #finishTaskOp(op, status, display, task = null, extra = {}) {
    op.status = status;
    op.decision = classifyDecision(op);
    op.output = truncate(display ?? '', MAX_OUTPUT_CHARS);
    op.finishedAt = this.now().toISOString();
    if (task) op.task = { id: task.id, status: task.status };
    // Capture is attempted here for the same reason as everywhere else - one contract - and is
    // refused by eligibility: task.* is outside the capture subset, and a task operation covers
    // several steps whose outcomes the task log already records separately.
    const { recorded, recordError } = await finalizeOperation(op, {
      append: (record) => this.operations.append(record),
      capture: (record, opts) => this.#captureExperience(record, opts),
    });
    return { status, decision: op.decision, display, output: op.output, operation: op, recorded, recordError, task, ...extra };
  }

  // A task-store refusal that happened before any step ran is not a failed task. The
  // message says so, because "try again when it finishes" is wrong for a lock whose
  // holder cannot be identified, and a corrupt log needs inspection rather than a retry.
  #taskStoreFailure(err) {
    if (err.code === 'LOCKED') {
      const unreadableHolder = /process unknown/i.test(err.message);
      return unreadableHolder
        ? `task run refused: ${err.message}. No task step was run and nothing was changed. The lock holder cannot be identified, so a retry may be refused again; run "node bin/apex.js diagnose" and, if no task run or recovery is active, "node bin/apex.js repair locks".`
        : `task run refused: ${err.message}. No task step was run and nothing was changed. If no other task run is active, run "node bin/apex.js repair locks" to inspect abandoned takeover tokens; retrying after the active run finishes is safe.`;
    }
    const damaged = /corrupt/i.test(err.message) || /cannot be applied/i.test(err.message);
    return `task store unavailable: ${err.message}. No task step was run and nothing was changed.${damaged
      ? ' Run "node bin/apex.js diagnose" for what is readable and what is uncertain; do not append to or replace the task log.'
      : ' Check APEX_DATA_DIR, its permissions, and free space; run "node bin/apex.js diagnose" for a read-only report.'}`;
  }

  // A refusal is a result, not a crash: the reason is shown and nothing changes.
  async #refused(op, err, status = Outcome.INPUT_REJECTED, notice = '') {
    if (err instanceof ValidationError) return this.#finishTaskOp(op, status, `${err.message}${notice}`);
    if (err instanceof StoreError) return this.#finishTaskOp(op, Outcome.EXECUTION_FAILED, `${this.#taskStoreFailure(err)}${notice}`);
    throw err;
  }

  // A task-log write failed after a step had already run. The report states what the run
  // established (the step, its outcome, and whether its own audit record exists) and what
  // it did not (the task log's recorded state). An executed step is never reported as an
  // execution that failed, and a missing record is never presented as proof that nothing
  // happened.
  #unrecordedTaskState(err) {
    const one = err.executedSteps.length === 1;
    const steps = err.executedSteps.map((s) => {
      const name = `step ${s.id}${s.action ? ` (${s.action})` : ''}`;
      const audit = s.auditRecorded
        ? `its own audit record ${shortId(s.operationId)} was written`
        : 'no audit record for it could be written';
      return `${name} had already returned ${s.outcome} and ${audit}`;
    });
    return `the task log could not record this run: ${err.message}. ${steps.join('; ')}.`
      + ` The task log may still show ${one ? 'that step' : 'those steps'} as running; APEX will not run ${one ? 'it' : 'them'} again.`
      + ` To reconcile the recorded state from the audit: node bin/apex.js task run ${shortId(err.taskId)}`;
  }

  async #createTask({ goal, origin, planner, steps }) {
    return this.taskStore.withLock(async () => {
      const taskId = this.idFactory();
      await this.taskStore.createTask({ taskId, goal, origin, planner, steps });
      return this.taskStore.get(taskId);
    });
  }

  async planTask(goalText, { onProgress = null } = {}) {
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
      return await this.#modelPlan(op, safeGoal, onProgress);
    } catch (err) {
      return this.#refused(op, err, Outcome.PLAN_REJECTED);
    }
  }

  // Asks the model for a plan. The prompt gets the redacted goal and only relevant,
  // non-private memory. The reply is parsed strictly and checked against the registry.
  async #modelPlan(op, safeGoal, onProgress = null) {
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
    if (typeof onProgress === 'function') {
      try {
        onProgress({ stage: 'model', timeoutMs: Number.isFinite(this.gateway.timeoutMs) ? this.gateway.timeoutMs : null });
      } catch {
        // Ignored: the caller's display failure is not the request's failure.
      }
    }
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
      // Written after the lock is released, from the task state the runner left behind.
      await this.#recordTaskSummary(op, result.task, { recovery: result.recovery, auditGaps: result.auditGaps });
      return this.#finishTaskOp(
        op,
        result.status,
        `${renderTask(result.task)}${warning}${this.#historyGapNotice(op, 'task result')}${this.#owedReissueNotice(op)}${this.#reissueNotice(op)}`,
        result.task,
        {
          auditGaps: gaps,
          auditGapSteps: result.auditGaps,
          underlyingStatus: result.underlyingStatus,
          recovery: result.recovery ?? null,
        },
      );
    } catch (err) {
      // A task-log write that refused after a step ran is not an execution failure. The
      // runner attached what it executed; report that instead of "the task did not run".
      if (err instanceof StoreError && err.executedSteps?.length) {
        const message = this.#unrecordedTaskState(err);
        op.errors.push({ stage: 'task', code: 'TASK_LOG_WRITE_FAILED', message: err.message, steps: err.executedSteps.map((s) => s.id) });
        const current = err.taskId ? await this.taskStore.get(err.taskId).catch(() => null) : null;
        return this.#finishTaskOp(op, Outcome.AUDIT_INTEGRITY_FAILED, `${message}${this.#historyGapNotice(op, 'task result')}`, current);
      }
      // A recovery that established evidence before the run was refused is still a fact
      // about this task, so it is recorded once. Nothing here re-runs a step: the refusal
      // stands, the task state is only read back, and the same state never gets a second
      // summary.
      if (err.recovery) {
        const current = await this.taskStore.get(err.taskId).catch(() => null);
        await this.#recordTaskSummary(op, current, { recovery: err.recovery });
      }
      return this.#refused(op, err, Outcome.INPUT_REJECTED, `${this.#historyGapNotice(op, 'task result')}${this.#owedReissueNotice(op)}${this.#reissueNotice(op)}`);
    }
  }

  // Approval actions read the log back and report success only if the change is there.
  async #approval(op, label, change, confirm, { taskSummary = false } = {}) {
    try {
      this.#requireTasks();
      const updated = await this.taskStore.withLock(() => change());
      if (!confirm(updated)) {
        return this.#finishTaskOp(op, Outcome.EXECUTION_FAILED, `${label}: the change could not be confirmed in the task log.`, updated);
      }
      // A cancelled task is a terminal state the next turn has to be able to see, so it
      // is recorded like a run. An approval or a retry changes intent, not evidence, so
      // it produces no task-result turn.
      if (taskSummary) await this.#recordTaskSummary(op, updated);
      const notice = taskSummary ? `${this.#historyGapNotice(op, 'task result')}${this.#owedReissueNotice(op)}${this.#reissueNotice(op)}` : '';
      return this.#finishTaskOp(op, Outcome.SUCCESS_VERIFIED, `${label}.\n${renderTask(updated)}${notice}`, updated);
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
        { taskSummary: true },
      );
    } catch (err) {
      return this.#refused(op, err);
    }
  }

  // Which steps the task log records as verified complete have no operation entry to
  // show for them. The audit can refuse a write while the task log still records the
  // outcome, and an audit log that cannot be read establishes nothing: either way the
  // answer says so rather than repeating the claim. Read-only - it changes no state and
  // grants no permission. The log is scanned once and the scan stops as soon as every
  // step's record has been found; it is never cut short while a step is still unaccounted
  // for, because a truncated scan cannot prove that a record is absent.
  async #missingStepEvidence(task) {
    const done = task.steps.filter((s) => s.status === StepStatus.COMPLETED);
    if (done.length === 0) return { missing: [], unreadable: false, corrupt: 0 };
    try {
      // A damaged line could be the record being looked for, so the skipped-line count
      // travels with the answer: without it, "no record" would turn a damaged log into
      // proof of absence.
      const { missing, corrupt } = await this.operations.missingTaskStepRecords(task.id, done);
      return { missing, unreadable: false, corrupt };
    } catch {
      return { missing: done.map((s) => s.id), unreadable: true, corrupt: 0 };
    }
  }

  // Inside handle(): a follow-up about a task, answered from the task log. The referent is
  // resolved from records, in one order: an id the user named is looked up in the task log
  // (an id that matches nothing is refused, not guessed at), and otherwise it is the task
  // this conversation holds a record of. More than one candidate is a real ambiguity, so the
  // user is asked rather than a guess being made - unless they asked for the most recently
  // discussed task by name, which is their choice, not ours. An unreadable history is
  // reported as unreadable instead of answered from what a model remembers of it, and an
  // unreadable task log is reported as unreadable rather than as an empty one. Nothing here
  // runs a step or changes task state. It is also a write opportunity for history, so a task
  // summary an earlier turn could not save is offered again first: that is what restores the
  // reference this answer is looking for. A reissued turn is only claimed once the write has
  // returned, and the answer itself still comes from the task log.
  async #explainTaskRequest(op, sid, { intent, taskIds = [], recency = false }) {
    const contextUnavailable = () => op.errors.some((e) => e.stage === 'context' || e.stage === 'session');
    await this.#deliverPendingSummaries(op, sid);
    let task = null;
    let failure = null;
    let clarify = null;
    try {
      let discussed = [];
      if (taskIds.length === 0) discussed = discussedTaskIds(await this.#recentTurns(sid, op));
      const referent = selectTaskReferent({ ids: taskIds, recency, discussed });
      const named = (ids) => ids.map((id) => shortId(id)).join(', ');
      if (referent.kind === 'ambiguous-id') {
        clarify = `Which task do you mean? You named ${referent.ids.length} of them (${named(referent.ids)}). Ask about one at a time, for example: what happened to task ${shortId(referent.ids[0])}?`;
      } else if (referent.kind === 'ambiguous') {
        clarify = `Which task do you mean? This conversation has ${referent.ids.length} of them recorded (${named(referent.ids)}). Name one, for example: what happened to task ${shortId(referent.ids[0])}?`;
      } else if (referent.kind === 'none') {
        if (contextUnavailable()) {
          failure = { status: Outcome.EXECUTION_FAILED, text: 'The conversation history could not be read, so APEX could not tell which task you mean. Nothing was run, and no task state changed.' };
        } else {
          clarify = 'Which task do you mean? This conversation has no task result recorded yet. To list the tasks APEX has records of: node bin/apex.js task list';
        }
      } else if (referent.kind === 'named-id') {
        task = await this.taskStore.resolve(referent.id);
      } else {
        task = await this.taskStore.get(referent.id);
        if (!task) clarify = `The task this conversation recorded (${shortId(referent.id)}) is no longer in the task log, so APEX cannot tell you what it did. Nothing was run.`;
      }
    } catch (err) {
      if (err instanceof ValidationError) {
        failure = { status: Outcome.INPUT_REJECTED, text: err.message };
      } else {
        failure = { status: Outcome.EXECUTION_FAILED, text: `The task log could not be read (${err.code || err.name || 'STORE_ERROR'}), so APEX did not answer about the task. Nothing was run, and no task state changed.` };
      }
    }

    if (clarify) {
      await this.#recordTurns(op, sid, op.request, [
        { origin: TURN_ORIGINS.QUESTION, text: clarify, verified: false },
      ], { subject: 'answer' });
      const reissued = this.#reissueNotice(op);
      return {
        status: Outcome.CLARIFICATION_REQUIRED,
        output: clarify,
        display: `${clarify}${this.#historyGapNotice(op, 'task result')}${this.#owedReissueNotice(op)}${reissued}`,
      };
    }
    if (failure) {
      return {
        status: failure.status,
        output: failure.text,
        display: `${failure.text}${this.#historyGapNotice(op, 'answer')}${this.#historyGapNotice(op, 'task result')}${this.#owedReissueNotice(op)}${this.#reissueNotice(op)}`,
      };
    }

    const { missing, unreadable, corrupt } = await this.#missingStepEvidence(task);
    const text = explainTask(task, intent, { missingAudit: missing, unreadableAudit: unreadable, damagedAudit: corrupt });
    await this.#recordTurns(op, sid, op.request, [
      { origin: TURN_ORIGINS.ACTION, text, verified: true, taskId: task.id },
    ], { subject: 'answer' });
    return {
      status: Outcome.SUCCESS_VERIFIED,
      output: text,
      display: `${text}${this.#historyGapNotice(op, 'answer')}${this.#historyGapNotice(op, 'task result')}${this.#owedReissueNotice(op)}${this.#reissueNotice(op)}`,
    };
  }

  // Read-only: no operation record. Unknown ids are usage errors for the caller.
  async showTask(ref) {
    this.#requireTasks();
    const task = await this.taskStore.resolve(ref);
    return { task, display: renderTask(task) };
  }

  // `task explain`: what the records say about one task, in the same view the conversation
  // uses. Read-only and unaudited like `task show` - no model is consulted, nothing is run,
  // resumed, retried, or approved, and no state changes. The task log gives the recorded
  // status and step outcomes; the operation audit is then checked for each step the log
  // records as verified, and the evidence line states what it found. A record that is absent
  // and a log that cannot be read are both reported as no independent support, never as
  // success. `gaps` names steps by id only: no audit line, step output, or memory content is
  // copied into the display. The text stays bounded because the view is capped in format.js
  // and a task holds at most MAX_STEPS steps, so the evidence line can name at most that
  // many ids.
  async describeTask(ref, intent = 'status') {
    this.#requireTasks();
    const task = await this.taskStore.resolve(ref);
    const { missing, unreadable, corrupt } = await this.#missingStepEvidence(task);
    const verified = task.steps.filter((s) => s.status === StepStatus.COMPLETED).length;
    const evidence = missing.length === 0
      ? verified === 0
        ? 'Evidence: no step is recorded as verified, so there is nothing to check the audit against.'
        : `Evidence: all ${verified} step result(s) the task log records as verified have an operation record of their own.`
      : unreadable
        ? `Evidence: the operation log could not be read, so none of the ${verified} recorded step result(s) is independently supported.`
        : corrupt > 0
          ? `Evidence: the operation log holds ${corrupt} damaged line(s), so it cannot establish that ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no operation record; ${missing.length === 1 ? 'it is' : 'they are'} not independently supported.`
          : `Evidence: ${verified - missing.length} of ${verified} recorded step result(s) have an operation record; ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} none, so ${missing.length === 1 ? 'it is' : 'they are'} not independently supported.`;
    const display = `${explainTask(task, intent, { missingAudit: missing, unreadableAudit: unreadable, damagedAudit: corrupt })}\n${evidence}`;
    return { task, intent, evidenceState: unreadable ? 'unreadable' : corrupt > 0 && missing.length ? 'damaged' : missing.length ? 'gaps' : 'complete', gaps: missing, display };
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
      // The task's own result turn, the same record `task run` writes, so a follow-up
      // sees the verified step outcomes whichever way the task was started.
      await this.#recordTaskSummary(op, fresh, { recovery: result.recovery, auditGaps: result.auditGaps });
      const warning = result.auditGaps.length
        ? `\nAudit integrity failure: ${result.auditGaps.length} required task-step operation record(s) could not be written (${result.auditGaps.join(', ')}). Underlying task result: ${result.underlyingStatus}.`
        : '';
      const display = `${renderTask(fresh)}${warning}`;
      // Disclosure of what history refused, and of what this turn wrote that an earlier
      // turn could not. Shown, never part of the audited output.
      const notices = `${this.#historyGapNotice(op, 'task result')}${this.#owedReissueNotice(op)}${this.#reissueNotice(op)}`;
      return {
        status: result.status,
        output: display,
        display: `${display}${notices}`,
        auditGaps: result.auditGaps.length,
        auditGapSteps: result.auditGaps,
        underlyingStatus: result.underlyingStatus,
      };
    } catch (err) {
      if (err instanceof ValidationError) return { status: Outcome.INPUT_REJECTED, output: err.message, display: err.message };
      // The step ran before the task-log write was refused: say so, and do not report it
      // as an execution that failed.
      if (err instanceof StoreError && err.executedSteps?.length) {
        const message = this.#unrecordedTaskState(err);
        op.errors.push({ stage: 'task', code: 'TASK_LOG_WRITE_FAILED', message: err.message, steps: err.executedSteps.map((s) => s.id) });
        return { status: Outcome.AUDIT_INTEGRITY_FAILED, output: message, display: message };
      }
      if (err instanceof StoreError) return { status: Outcome.EXECUTION_FAILED, output: this.#taskStoreFailure(err), display: this.#taskStoreFailure(err) };
      throw err;
    }
  }


  // Bounded retrieval of the behaviour rules the user approved, for this request only. The store
  // returns active records alone: a candidate, a rejected rule, a retired rule, and an approved
  // rule whose supporting evidence has since been corrected all stay out. A store that cannot be
  // read is disclosed as unavailable, which is a different statement from "no rule applies", so
  // the caller is told which of the two it is showing. The same distinction applies to the bound:
  // `omitted` counts the active rules the window cut, because a partial list read as a complete
  // one would tell the user that no other rule they approved applies.
  async #adaptationsFor(request, op) {
    if (!this.experience) return { adaptations: [], unavailable: false, omitted: 0 };
    try {
      const { adaptations, total, truncated } = await this.experience.activeAdaptations({ query: request });
      return { adaptations, unavailable: false, omitted: truncated ? total - adaptations.length : 0 };
    } catch (err) {
      op.errors.push({ stage: 'adaptation', code: err.code || 'STORE_ERROR', message: err.message });
      return { adaptations: [], unavailable: true, omitted: 0 };
    }
  }

  // Model path. `relevant` is the already-filtered memory that may enter a prompt
  // or be shown directly. Everything retrieved but ineligible (private, secret,
  // superseded) stays out of both the prompt and the direct display.
  async answerWithModel(request, { relevant, turns, historyUnavailable = false }, op, onProgress = null) {
    const retrievalError = op.errors.find((error) => error.stage === 'retrieval');
    if (retrievalError) {
      return {
        status: Outcome.EXECUTION_FAILED,
        answer: `Memory retrieval failed (${retrievalError.code}). APEX did not generate an answer because stored context could not be checked.`,
        hasText: false,
        backend: null,
        error: null,
        annotation: '',
      };
    }
    if (!this.gateway.isConfigured()) {
      // Without a model, relevant stored records are shown directly. Only records
      // eligible for a model prompt are shown: private and credential-like memory
      // stays out of this path too. The record content appears in the display but
      // never in the audited output.
      const sections = [];
      if (relevant.length > 0) {
        sections.push(`Relevant memory found (shown directly, not summarised by a model):\n${renderShown(relevant)}`);
      }
      let failureNotice = '';
      if (this.knowledge) {
        try {
          const khits = await this.knowledge.search(request, { limit: KNOWLEDGE_PROMPT_LIMIT });
          const records = dedupeKnowledge(selectPromptKnowledge(khits));
          if (records.length > 0) {
            sections.push(`Relevant knowledge found (shown directly, not summarised by a model):\n${records.map(knowledgeLine).join('\n')}`);
          }
        } catch (err) {
          const code = err.code || 'STORE_ERROR';
          op.errors.push({ stage: 'knowledge', code, message: err.message });
          failureNotice = `[Knowledge context was unavailable (${code}); this display did not use stored knowledge.]`;
          sections.push(failureNotice);
        }
      }
      const shown = await this.#adaptationsFor(request, op);
      if (shown.adaptations.length > 0) {
        // Shown, not applied: with no model there is nothing to follow a rule, and saying that
        // plainly is part of the disclosure. The record is the user's own approved wording.
        const omitted = adaptationOmittedNote(shown.omitted);
        sections.push(`Approved adaptations covering this request (shown directly; without a model APEX did not apply them):\n${shown.adaptations.map(adaptationLine).join('\n')}${omitted ? `\nNote: ${omitted}.` : ''}`);
      } else if (shown.unavailable) {
        sections.push('[APEX could not read its approved adaptations for this request, so a behaviour rule you approved may be missing from what is shown here.]');
      }
      return {
        status: Outcome.MODEL_UNAVAILABLE,
        answer: failureNotice ? `${NO_MODEL_MESSAGE}\n\n${failureNotice}` : NO_MODEL_MESSAGE,
        display: [NO_MODEL_MESSAGE, ...sections].join('\n\n'),
        hasText: false,
        backend: null,
        error: null,
        annotation: '',
      };
    }

    // A damaged conversation log or session is not silently ignored. The model is
    // told that history is unavailable; the user gets the same limitation. The
    // notice is added to the display only, never to the stored model turn, so it
    // cannot be replayed later as if the model had said it.
    const contextError = op.errors.find((error) => error.stage === 'context');
    const sessionError = op.errors.find((error) => error.stage === 'session');
    const historyNotice = !historyUnavailable
      ? ''
      : contextError
        ? `[Earlier conversation was unavailable (${contextError.code || 'STORE_ERROR'}); this answer did not use earlier turns.]`
        : sessionError
          ? `[The session could not be loaded (${sessionError.code || 'STORE_ERROR'}); this answer was not saved to conversation history.]`
          : '[Earlier conversation was unavailable; this answer did not use earlier turns.]';

    // Retrieve relevant knowledge before building the prompt so memory, knowledge,
    // and turns share one size budget. The store is bounded and fails safely.
    let knowledge = [];
    let knowledgeUnavailable = false;
    let knowledgeNotice = '';
    if (this.knowledge) {
      try {
        const khits = await this.knowledge.search(request, { limit: KNOWLEDGE_PROMPT_LIMIT });
        knowledge = dedupeKnowledge(selectPromptKnowledge(khits));
      } catch (err) {
        // Knowledge is supplementary, so it does not block the answer. The failure
        // must still be auditable and visible; it must not look like an empty store.
        op.errors.push({ stage: 'knowledge', code: err.code || 'STORE_ERROR', message: err.message });
        knowledgeUnavailable = true;
        knowledgeNotice = `\n\n[Knowledge context was unavailable (${err.code || 'STORE_ERROR'}); this answer did not use stored knowledge.]`;
      }
    }
    // The approved behaviour rules for this request, retrieved once and bounded. Supplementary
    // like knowledge: an unreadable store does not stop the answer, but the model is told that no
    // rule could be checked rather than that none applies.
    const { adaptations, unavailable: adaptationsUnavailable, omitted: adaptationsOmitted } = await this.#adaptationsFor(request, op);
    // Read the epistemic projection once, from the same store instances this answer was
    // retrieved from, so the model is told what the stores as a whole hold rather than
    // only the records that happened to match. It is a read-only derivation: it writes
    // nothing, and a failure here is disclosed rather than shown as an empty store. The
    // model cannot request this projection itself (the `world.state` action is user-origin
    // only) because the projection is built with private records included; the privacy
    // boundary is enforced by the prompt view, which never reproduces private content.
    let world = null;
    let worldUnavailable = false;
    if (this.memory && this.knowledge) {
      try {
        world = await buildWorldState({ memory: this.memory, knowledge: this.knowledge, now: this.now });
      } catch (err) {
        // Supplementary, like knowledge: the answer still goes ahead, but the model is
        // told the whole-store check did not happen.
        op.errors.push({ stage: 'world', code: err.code || 'STORE_ERROR', message: err.message });
        worldUnavailable = true;
      }
    }
    // A bounded temporal summary from the same experience log the experience commands read. It is
    // offered to the prompt only when the request is about time, outcomes, or one of the represented
    // capabilities, and the prompt drops it before any retrieved record. A store that cannot be read
    // is disclosed for a relevant request rather than rendered as "no recorded history".
    let temporal = null;
    let temporalUnavailable = false;
    if (this.experience) {
      try {
        temporal = await this.experience.temporalSummary();
      } catch (err) {
        op.errors.push({ stage: 'temporal', code: err.code || 'STORE_ERROR', message: err.message });
        temporalUnavailable = true;
      }
    }
    const built = buildPrompt({
      request,
      memoryHits: relevant,
      turns,
      knowledge,
      knowledgeUnavailable,
      adaptations,
      adaptationsUnavailable,
      adaptationsOmitted,
      historyUnavailable,
      world,
      worldUnavailable,
      temporal,
      temporalUnavailable,
      maxChars: this.maxContextChars,
    });
    const system = systemPrompt({ appName: APP_NAME, actions: this.readableActions(), now: this.now() });
    op.prompt = {
      memoryIds: built.memoryIds,
      turnIds: built.turnIds,
      knowledgeIds: built.knowledgeIds,
      adaptationIds: built.adaptationIds,
      chars: built.prompt.length,
    };
    // The projection contributes counts and record ids to the audit, never a belief
    // statement, so the stored audit stays free of memory content.
    if (world) {
      op.prompt.world = {
        included: built.worldIncluded,
        lines: built.worldLines,
        linesTotal: built.worldLinesTotal,
        representedBeliefs: world.counts.representedBeliefs,
        unresolvedConflicts: world.counts.unresolvedConflicts,
        memoryConflictGroups: world.counts.memoryConflictGroups,
        unknowns: world.unknowns.length,
        complete: world.complete,
      };
    } else if (worldUnavailable) {
      op.prompt.world = { included: false, unavailable: true };
    }
    // The temporal contribution is recorded as counts, the window, and whether the prompt kept it.
    // No capability list, pattern detail, or subject is needed in the audit to say what was sent.
    if (temporal) {
      op.prompt.temporal = {
        included: built.temporalIncluded,
        lines: built.temporalLines,
        linesTotal: built.temporalLinesTotal,
        events: temporal.counts?.events ?? 0,
        undated: temporal.counts?.undated ?? 0,
        patterns: temporal.counts?.patterns ?? 0,
        window: temporal.window ?? null,
      };
    } else if (temporalUnavailable) {
      op.prompt.temporal = { included: false, unavailable: true };
    }

    // A conflict stays visible even if the model ignores the in-context markers.
    const includedMemory = new Set(built.memoryIds);
    const memoryConflict = relevant.some((h) => includedMemory.has(h.record.id)
      && (h.conflict ?? []).some((id) => includedMemory.has(id)));
    const includedKnowledge = new Set(built.knowledgeIds);
    // A resolved group still carries its `conflictsWith` list, so an open conflict and a
    // settled decision must not produce the same notice: the second one is false. The
    // decision itself stays marked on the record line inside the prompt.
    const knowledgeConflict = knowledge.some((r) => includedKnowledge.has(r.id)
      && (r.conflictsWith?.length ?? 0) > 0 && r.conflictState !== 'resolved');
    // Retrieval only compares the records it returned, so one side of a stored
    // disagreement can reach the model with no marker. The projection reads the whole
    // bounded window, so it can say that the record APEX showed is contested even when
    // the record that disagrees with it was never retrieved.
    const shownIds = new Set([...includedMemory, ...includedKnowledge]);
    const worldConflict = (world?.contradictions ?? []).filter((group) => group.state === 'unresolved')
      .some((group) => (group.claimIds ?? []).some((id) => shownIds.has(id)));
    const storedNotice = memoryConflict || knowledgeConflict
      ? '[Stored context contains conflicting records; APEX has not resolved them.]'
      : worldConflict
        ? '[APEX showed one side of a disagreement stored in its own records; the other record is not shown in this answer and APEX has not resolved them. Run "world" to list stored conflicts.]'
        : worldUnavailable
          ? '[APEX could not read its world-state projection for this answer, so it cannot say whether other stored records disagree with what was shown.]'
          : '';
    // An approved adaptation changes how APEX behaves, so the user is told which rule was in the
    // answer rather than only reading it out of the audit record. Two rules that disagree for one
    // scope are reported as unresolved: the system did not pick a winner and must not imply one.
    const includedAdaptations = new Set(built.adaptationIds);
    const conflicting = adaptations.filter((a) => includedAdaptations.has(a.id) && (a.conflicts?.length ?? 0) > 0);
    const omission = adaptationsOmitted > 0 && !adaptationsUnavailable
      ? ` [${adaptationOmittedNote(adaptationsOmitted)}.]`
      : '';
    const adaptationNotice = conflicting.length > 0
      ? `[${conflicting.length} of your approved adaptations cover this scope and say different things; APEX has not resolved which one you would prefer.]${omission}`
      : adaptationsUnavailable
        ? '[APEX could not read its approved adaptations for this answer, so a behaviour rule you approved may not have reached it.]'
        : includedAdaptations.size > 0
          ? `[APEX included ${includedAdaptations.size} approved adaptation(s) you recorded for this scope: ${adaptations.filter((a) => includedAdaptations.has(a.id)).map((a) => `"${truncate(a.rule, 120)}"`).join('; ')}]${omission}`
          : '';
    const annotation = [storedNotice, adaptationNotice].filter(Boolean).join('\n\n');

    // Called once, immediately before the model is asked. It reports only the wait
    // and its limit; the transport is not streaming, so no progress or partial text is
    // implied. A display callback must never change the request's outcome.
    if (typeof onProgress === 'function') {
      try {
        onProgress({ stage: 'model', timeoutMs: Number.isFinite(this.gateway.timeoutMs) ? this.gateway.timeoutMs : null });
      } catch {
        // Ignored: the caller's display failure is not the request's failure.
      }
    }

    const res = await this.gateway.complete({ system, prompt: built.prompt });

    if (!res.ok) {
      op.model = { provider: res.provider ?? null, latencyMs: res.latencyMs };
      return {
        status: Outcome.EXECUTION_FAILED,
        answer: `The model backend did not produce an answer (${res.error.code}: ${res.error.message}). No answer has been generated. ${modelFailureAdvice(res.error.code)}`,
        hasText: false,
        backend: res.backend,
        error: { stage: 'model', code: res.error.code, message: res.error.message },
        annotation: '',
      };
    }
    op.model = { name: res.model, provider: res.provider, latencyMs: res.latencyMs, finishReason: res.finishReason };
    // Numeric backend counters are recorded only when the server reported them, so a
    // missing measurement is visible as absent rather than as a zero.
    if (res.usage) op.model.usage = res.usage;
    if (res.timings) op.model.timings = res.timings;
    // A large reported load time explains a slow first answer. It is display-only and
    // never part of the model's turn; the exact number stays in the audit record.
    const loadNotice = res.timings && Number.isFinite(res.timings.loadMs) && res.timings.loadMs >= LOAD_NOTICE_MS
      ? `[The backend reported ${(res.timings.loadMs / 1000).toFixed(1)} s of model load time for this answer.]`
      : '';

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
    const overflow = Math.max(0, parsed.proposals.length - MAX_PROPOSALS);
    if (overflow > 0) {
      op.errors.push({ stage: 'proposals', code: 'TOO_MANY', message: `only the first ${MAX_PROPOSALS} of ${parsed.proposals.length} proposals were considered` });
    }
    for (const p of parsed.proposals.slice(0, MAX_PROPOSALS)) {
      op.steps.push(await this.runAction(p.action, p.input, 'model', op.id));
    }

    let answer = parsed.text || '(the model returned no answer text)';
    if (res.truncated) {
      answer += res.truncatedBy === 'output-size-limit'
        ? '\n\n[The answer was cut off at APEX\'s output-size limit.]'
        : '\n\n[The answer was cut off at the model output limit (APEX_MODEL_MAX_TOKENS).]';
      op.errors.push({
        stage: 'model',
        code: 'TRUNCATED',
        message: res.truncatedBy === 'output-size-limit' ? 'answer exceeded the output-size limit' : 'answer reached the output token limit',
      });
    }
    // The model's own conclusion has no independent check, so it is reported
    // honestly as verification_unavailable, never as verified.
    const answerText = answer + knowledgeNotice;
    const displayExtras = [loadNotice, historyNotice].filter(Boolean).join('\n\n');
    return {
      status: Outcome.VERIFICATION_UNAVAILABLE,
      answer: answerText,
      // The text the model actually produced, without APEX notices. Conversation
      // turns and a user-approved saved conclusion use this, so a notice can never be
      // replayed later as if the model had said it.
      modelText: parsed.text,
      display: displayExtras ? `${answerText}\n\n${displayExtras}` : undefined,
      hasText: parsed.text.length > 0,
      backend: res.backend,
      error: null,
      annotation,
      proposalOverflow: overflow,
    };
  }
}
