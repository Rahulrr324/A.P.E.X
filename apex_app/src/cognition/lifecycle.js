// Executable request lifecycle.
//
// Batch AN described the ten-stage contract after the fact. This module makes the same ten stages a
// state machine the request actually passes through: a stage may start only when the stages it depends
// on have finished and did not fail, a stage that never runs is recorded as skipped or not reached,
// and a failed stage closes every later stage instead of leaving it available to be reported as a
// success.
//
// It is not an orchestrator and not a second authorization system. Callers still run understanding,
// retrieval, deliberation, the model, the action registry, the executor, and the verifier; this class
// only records which of those stages happened, in what order, and whether the record is internally
// consistent. Stage 7 is recorded from the registry's own decisions and is never derived here.
import {
  CONTRACT_STAGES, COGNITIVE_CONTRACT_SCHEMA, StageStatus, sanitizeCounts, sanitizeLabels,
} from './contract.js';

export const LIFECYCLE_SCHEMA = 1;

export const LifecycleStatus = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  RAN: StageStatus.RAN,
  SKIPPED: StageStatus.SKIPPED,
  NOT_REACHED: StageStatus.NOT_REACHED,
  UNAVAILABLE: StageStatus.UNAVAILABLE,
  FAILED: StageStatus.FAILED,
});

const TERMINAL = new Set([
  LifecycleStatus.RAN,
  LifecycleStatus.SKIPPED,
  LifecycleStatus.NOT_REACHED,
  LifecycleStatus.UNAVAILABLE,
  LifecycleStatus.FAILED,
]);

// Allowed entry conditions, stated per stage. `requires` names the stages whose recorded outcome
// decides whether this stage may start at all; `forbidSkipped` marks a dependency that must actually
// have run, because a skipped authorization or execution cannot carry a dependent stage.
//
// Stage 6 names no required predecessor on purpose: the model is asked after the cognitive reading
// has finished, but the cognitive reading is supplementary and is disclosed as unavailable rather
// than blocking the answer. The earlier-stage rule still applies in full - stage 6 cannot start while
// any of stages 1-5 is open, and cannot start after one is not reached - so the model is never asked
// ahead of the cognitive layer, and a cognitive failure is visible as a gap rather than as a refusal.
export const STAGE_ENTRY = Object.freeze({
  1: Object.freeze({ requires: Object.freeze([]) }),
  2: Object.freeze({ requires: Object.freeze([1]) }),
  3: Object.freeze({ requires: Object.freeze([2]) }),
  4: Object.freeze({ requires: Object.freeze([3]) }),
  5: Object.freeze({ requires: Object.freeze([4]) }),
  6: Object.freeze({ requires: Object.freeze([]) }),
  7: Object.freeze({ requires: Object.freeze([6]) }),
  8: Object.freeze({ requires: Object.freeze([7]), forbidSkipped: true }),
  9: Object.freeze({ requires: Object.freeze([8]), forbidSkipped: true }),
  10: Object.freeze({ requires: Object.freeze([8]) }),
});

export const TransitionRejection = Object.freeze({
  UNKNOWN_STAGE: 'unknown_stage',
  ALREADY_FINALIZED: 'lifecycle_already_finalized',
  STAGE_ALREADY_TERMINAL: 'stage_already_terminal',
  STAGE_ALREADY_RUNNING: 'stage_already_running',
  EARLIER_STAGE_PENDING: 'earlier_stage_pending',
  EARLIER_STAGE_NOT_REACHED: 'earlier_stage_not_reached',
  PREREQUISITE_FAILED: 'prerequisite_failed',
  PREREQUISITE_UNAVAILABLE: 'prerequisite_unavailable',
  PREREQUISITE_NOT_REACHED: 'prerequisite_not_reached',
  PREREQUISITE_SKIPPED: 'prerequisite_skipped',
  PREREQUISITE_NOT_TERMINAL: 'prerequisite_not_terminal',
});

const MAX_REJECTIONS = 8;

function stageDefinition(order) {
  return CONTRACT_STAGES[order - 1] ?? null;
}

export class RequestLifecycle {
  #requestId;
  #stages;
  #rejections = [];
  #finalization = null;
  #finalized = false;

  constructor({ requestId = null } = {}) {
    this.#requestId = typeof requestId === 'string' ? requestId.slice(0, 100) : null;
    this.#stages = CONTRACT_STAGES.map((definition) => ({
      order: definition.order,
      name: definition.name,
      owner: definition.owner,
      status: LifecycleStatus.PENDING,
      counts: {},
      labels: {},
      reason: null,
    }));
  }

  get requestId() {
    return this.#requestId;
  }

  get finalization() {
    return this.#finalization ? { ...this.#finalization } : null;
  }

  get rejections() {
    return this.#rejections.map((entry) => ({ ...entry }));
  }

  statusOf(order) {
    return this.#stages[order - 1]?.status ?? null;
  }

  // Why an entry is not allowed, or null. Kept separate from the attempt so a caller can ask without
  // recording a rejection (for diagnostics) and get the same rule the transition uses.
  blockedReason(order) {
    if (this.#finalized) return TransitionRejection.ALREADY_FINALIZED;
    const definition = stageDefinition(order);
    if (!definition) return TransitionRejection.UNKNOWN_STAGE;
    const entry = STAGE_ENTRY[order];
    const stage = this.#stages[order - 1];
    if (stage.status === LifecycleStatus.RUNNING) return TransitionRejection.STAGE_ALREADY_RUNNING;
    if (TERMINAL.has(stage.status)) return TransitionRejection.STAGE_ALREADY_TERMINAL;
    // A request passes through the stages in order. A later stage cannot start while an earlier one is
    // still open, and a not-reached stage ends the request's passage through the contract.
    for (let prior = 1; prior < order; prior += 1) {
      const status = this.#stages[prior - 1].status;
      if (status === LifecycleStatus.PENDING || status === LifecycleStatus.RUNNING) {
        return TransitionRejection.EARLIER_STAGE_PENDING;
      }
      if (status === LifecycleStatus.NOT_REACHED) return TransitionRejection.EARLIER_STAGE_NOT_REACHED;
    }
    for (const required of entry.requires) {
      const status = this.#stages[required - 1].status;
      if (status === LifecycleStatus.PENDING || status === LifecycleStatus.RUNNING) {
        return TransitionRejection.PREREQUISITE_NOT_TERMINAL;
      }
      if (status === LifecycleStatus.FAILED) return TransitionRejection.PREREQUISITE_FAILED;
      if (status === LifecycleStatus.UNAVAILABLE) return TransitionRejection.PREREQUISITE_UNAVAILABLE;
      if (status === LifecycleStatus.NOT_REACHED) return TransitionRejection.PREREQUISITE_NOT_REACHED;
      if (status === LifecycleStatus.SKIPPED && entry.forbidSkipped) {
        return TransitionRejection.PREREQUISITE_SKIPPED;
      }
    }
    return null;
  }

  // Starts a stage. A rejected transition changes nothing: the stage keeps its status and the attempt
  // is recorded, so an invalid order is visible instead of being silently tolerated.
  start(order, { counts = {}, labels = {} } = {}) {
    const reason = this.blockedReason(order);
    if (reason) return this.#reject(order, reason);
    const stage = this.#stages[order - 1];
    stage.status = LifecycleStatus.RUNNING;
    stage.counts = sanitizeCounts(counts);
    stage.labels = sanitizeLabels(labels);
    return { ok: true, order, status: stage.status };
  }

  // Finishes a stage that ran. If the caller did not call start, the entry condition is still checked
  // first, so a one-shot record cannot bypass the order.
  complete(order, { counts = {}, labels = {} } = {}) {
    const started = this.#ensureRunning(order, counts);
    if (!started.ok) return started;
    const stage = this.#stages[order - 1];
    stage.status = LifecycleStatus.RAN;
    stage.counts = { ...stage.counts, ...sanitizeCounts(counts) };
    stage.labels = { ...stage.labels, ...sanitizeLabels(labels) };
    return { ok: true, order, status: stage.status };
  }

  // A stage with nothing to do. It is explicitly represented, never omitted: "no proposals" and
  // "never reached" are different records and must stay different.
  skip(order, { reason = null, counts = {} } = {}) {
    const started = this.#ensureRunning(order, counts);
    if (!started.ok) return started;
    const stage = this.#stages[order - 1];
    stage.status = LifecycleStatus.SKIPPED;
    stage.counts = { ...stage.counts, ...sanitizeCounts(counts) };
    stage.reason = typeof reason === 'string' ? reason.slice(0, 60) : null;
    return { ok: true, order, status: stage.status };
  }

  // The stage could not be completed and nothing downstream may claim its result.
  unavailable(order, { reason = null, counts = {}, force = false } = {}) {
    if (!force) {
      const started = this.#ensureRunning(order, counts);
      if (!started.ok) return started;
    }
    const definition = stageDefinition(order);
    if (!definition) return this.#reject(order, TransitionRejection.UNKNOWN_STAGE);
    const stage = this.#stages[order - 1];
    if (TERMINAL.has(stage.status)) return this.#reject(order, TransitionRejection.STAGE_ALREADY_TERMINAL);
    stage.status = LifecycleStatus.UNAVAILABLE;
    stage.counts = { ...stage.counts, ...sanitizeCounts(counts) };
    stage.reason = typeof reason === 'string' ? reason.slice(0, 60) : null;
    return { ok: true, order, status: stage.status };
  }

  // A failure is recorded even if the entry condition for the stage would no longer pass: the failure
  // is what prevents later stages, so refusing to record it would hide the cause.
  fail(order, { reason = null, counts = {} } = {}) {
    if (this.#finalized) return this.#reject(order, TransitionRejection.ALREADY_FINALIZED);
    const definition = stageDefinition(order);
    if (!definition) return this.#reject(order, TransitionRejection.UNKNOWN_STAGE);
    const stage = this.#stages[order - 1];
    if (TERMINAL.has(stage.status)) return this.#reject(order, TransitionRejection.STAGE_ALREADY_TERMINAL);
    stage.status = LifecycleStatus.FAILED;
    stage.counts = { ...stage.counts, ...sanitizeCounts(counts) };
    stage.reason = typeof reason === 'string' ? reason.slice(0, 60) : null;
    return { ok: true, order, status: stage.status };
  }

  // Ends the request's passage across a range of stages. A closed stage is not guessed at and cannot
  // be started afterwards.
  closeRange(fromOrder, toOrder, status = LifecycleStatus.NOT_REACHED) {
    if (![LifecycleStatus.NOT_REACHED, LifecycleStatus.UNAVAILABLE].includes(status)) {
      throw new TypeError('closeRange only closes stages as not_reached or unavailable');
    }
    for (const stage of this.#stages) {
      if (stage.order < fromOrder || stage.order > toOrder) continue;
      if (stage.status !== LifecycleStatus.PENDING) continue;
      stage.status = status;
    }
    return this;
  }

  closeRemaining({ fromOrder = null, status = LifecycleStatus.NOT_REACHED } = {}) {
    return this.closeRange(Number.isInteger(fromOrder) ? fromOrder : 1, CONTRACT_STAGES.length, status);
  }

  // Records stages 6-9 from the records the executive path produced. It performs no authorization and
  // reads no model text: `steps` are the step records `runAction` already returned, and each count is
  // derived from the decision those records carry. A stage that is already terminal is left alone, so
  // a caller cannot rewrite a record by calling this twice.
  recordExecution({ proposals, steps = [] } = {}) {
    if (!proposals) return this;
    if (this.statusOf(6) === LifecycleStatus.PENDING) {
      this.complete(6, {
        counts: {
          observed: proposals.observed,
          well_formed: proposals.wellFormed,
          malformed: proposals.malformed,
          overflow: proposals.overflow,
        },
      });
    }
    const records = Array.isArray(steps) ? steps : [];
    if (records.length === 0) {
      if (this.statusOf(7) === LifecycleStatus.PENDING) {
        this.skip(7, {
          reason: proposals.wellFormed > 0 ? 'no_executable_proposal' : 'no_proposals',
          counts: { requests: 0 },
        });
      }
      this.closeRange(8, 10, LifecycleStatus.NOT_REACHED);
      return this;
    }
    const allowed = records.filter((entry) => entry.authorization?.decision === 'allow');
    if (this.statusOf(7) === LifecycleStatus.PENDING) {
      this.complete(7, {
        counts: { requests: records.length, allowed: allowed.length, denied: records.length - allowed.length },
      });
    }
    if (allowed.length === 0) {
      if (this.statusOf(8) === LifecycleStatus.PENDING) {
        this.skip(8, { reason: 'no_authorized_action', counts: { attempted: 0 } });
      }
      this.closeRange(9, 10, LifecycleStatus.NOT_REACHED);
      return this;
    }
    const executed = records.filter((entry) => entry.execution?.status === 'ok');
    if (this.statusOf(8) === LifecycleStatus.PENDING) {
      this.complete(8, {
        counts: {
          attempted: allowed.length,
          ok: executed.length,
          rejected: records.filter((entry) => entry.execution?.status === 'rejected').length,
          failed: records.filter((entry) => entry.execution?.status === 'failed').length,
        },
      });
    }
    if (executed.length === 0) {
      if (this.statusOf(9) === LifecycleStatus.PENDING) {
        this.skip(9, { reason: 'no_execution', counts: { checked: 0 } });
      }
      this.closeRange(10, 10, LifecycleStatus.NOT_REACHED);
      return this;
    }
    if (this.statusOf(9) === LifecycleStatus.PENDING) {
      this.complete(9, {
        counts: {
          checked: executed.length,
          verified: executed.filter((entry) => entry.verification?.outcome === 'success_verified').length,
          failed: executed.filter((entry) => entry.verification?.outcome === 'verification_failed').length,
          unavailable: executed.filter((entry) => entry.verification?.outcome === 'verification_unavailable').length,
        },
      });
    }
    return this;
  }

  // The model stage was entered but produced no answer. It is recorded as a failure so the stages
  // that depend on it are closed, instead of a zero-proposal "ran" that would read as an examined
  // reply. A stage already recorded is left untouched.
  recordModelFailure(reason = 'model_unavailable') {
    if (this.statusOf(6) !== LifecycleStatus.PENDING) return this;
    if (this.fail(6, {
      reason,
      counts: { observed: 0, well_formed: 0, malformed: 0, overflow: 0 },
    }).ok) {
      this.closeRange(7, 10, LifecycleStatus.NOT_REACHED);
    }
    return this;
  }

  // The closure rule the contract already states, applied once, so the snapshot cannot contain a
  // later stage marked ran after a not-reached one.
  #enforceClosure() {
    let closed = false;
    for (const stage of this.#stages) {
      if (stage.status === LifecycleStatus.NOT_REACHED) closed = true;
      else if (closed && stage.status !== LifecycleStatus.NOT_REACHED) {
        stage.status = LifecycleStatus.NOT_REACHED;
        stage.counts = {};
        stage.labels = {};
        stage.reason = null;
      }
    }
  }

  // What a status may claim. A success above a stage that did not run is not a success the records can
  // carry, so the claim is downgraded and the reasons are stated. This never grants anything: it only
  // refuses to let a recorded outcome say more than the recorded stages establish.
  claim(requestedStatus) {
    const success = requestedStatus === 'success_verified';
    if (!success) return { status: requestedStatus, downgraded: false, reasons: [] };
    const reasons = [];
    const stage = (order) => this.#stages[order - 1];
    if (stage(7).status !== LifecycleStatus.RAN || (stage(7).counts.allowed ?? 0) < 1) {
      reasons.push('no authorized action was recorded');
    }
    if (stage(8).status !== LifecycleStatus.RAN || (stage(8).counts.ok ?? 0) < 1) {
      reasons.push('no execution was recorded');
    }
    if (stage(9).status !== LifecycleStatus.RAN || (stage(9).counts.verified ?? 0) < 1) {
      reasons.push('no verification was recorded');
    }
    if (reasons.length === 0) return { status: requestedStatus, downgraded: false, reasons: [] };
    const downgraded = stage(8).status === LifecycleStatus.RAN && (stage(8).counts.ok ?? 0) > 0
      ? 'verification_unavailable'
      : 'execution_failed';
    return { status: downgraded, downgraded: true, reasons };
  }

  // The caller that owns the audit append states its result here. It is recorded outside the audit
  // record because a record cannot contain the outcome of its own append.
  finalize({ requestedStatus = null, finalStatus = null, recorded = null } = {}) {
    if (this.#finalized) return this.#reject(0, TransitionRejection.ALREADY_FINALIZED);
    this.#finalized = true;
    const claim = typeof requestedStatus === 'string'
      ? this.claim(requestedStatus)
      : { status: typeof finalStatus === 'string' ? finalStatus : null, downgraded: false, reasons: [] };
    this.#finalization = {
      // `null` means the caller has not yet established whether the append succeeded; a record
      // cannot contain the outcome of its own append.
      recorded: typeof recorded === 'boolean' ? recorded : null,
      status: claim.status,
      downgraded: claim.downgraded === true,
      reasons: claim.reasons.slice(0, 3),
    };
    return { ok: true, finalization: this.finalization };
  }

  snapshot() {
    this.#enforceClosure();
    return {
      schema: LIFECYCLE_SCHEMA,
      contractSchema: COGNITIVE_CONTRACT_SCHEMA,
      requestId: this.#requestId,
      stages: this.#stages.map((stage) => ({
        order: stage.order,
        name: stage.name,
        owner: stage.owner,
        status: stage.status,
        counts: { ...stage.counts },
        labels: { ...stage.labels },
        ...(stage.reason ? { reason: stage.reason } : {}),
      })),
      rejections: this.rejections,
      finalization: this.finalization,
      // The same statement the contract carries: recording a stage is not permitting it.
      authorizes: false,
    };
  }

  #ensureRunning(order, counts) {
    const stage = this.#stages[order - 1];
    if (stage?.status === LifecycleStatus.RUNNING) return { ok: true, order };
    return this.start(order, { counts });
  }

  #reject(order, code) {
    if (this.#rejections.length < MAX_REJECTIONS) {
      this.#rejections.push({ order: Number.isInteger(order) ? order : null, code });
    } else {
      this.#rejections[this.#rejections.length - 1] = { order: null, code: 'further_rejections_omitted' };
    }
    return { ok: false, order: Number.isInteger(order) ? order : null, code };
  }
}

// A bounded audit view. Stage names, owners, statuses, counts, labels, fixed rejection codes, and the
// finalization result only: no request text, evidence text, model text, or reason prose beyond the
// fixed label an APEX decision already produced.
export function lifecycleAudit(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    schema: snapshot.schema,
    requestId: typeof snapshot.requestId === 'string' ? snapshot.requestId : null,
    stages: (Array.isArray(snapshot.stages) ? snapshot.stages : []).map((stage) => ({
      order: stage.order,
      name: stage.name,
      owner: stage.owner,
      status: stage.status,
      counts: { ...stage.counts },
      ...(Object.keys(stage.labels ?? {}).length > 0 ? { labels: { ...stage.labels } } : {}),
      ...(stage.reason ? { reason: String(stage.reason).slice(0, 60) } : {}),
    })),
    rejections: (Array.isArray(snapshot.rejections) ? snapshot.rejections : [])
      .slice(0, MAX_REJECTIONS)
      .map((entry) => ({ order: Number.isInteger(entry.order) ? entry.order : null, code: String(entry.code ?? '').slice(0, 60) })),
    finalization: snapshot.finalization ? {
      recorded: typeof snapshot.finalization.recorded === 'boolean' ? snapshot.finalization.recorded : null,
      status: typeof snapshot.finalization.status === 'string' ? snapshot.finalization.status : null,
      downgraded: snapshot.finalization.downgraded === true,
      reasons: Array.isArray(snapshot.finalization.reasons)
        ? snapshot.finalization.reasons.slice(0, 3).map((reason) => String(reason).slice(0, 80))
        : [],
    } : null,
    authorizes: false,
  };
}
