// Bounded runtime diagnostics for one request.
//
// This records what the process did, not what the user asked or what a model said: stage names, stage
// outcomes, monotonic durations, record counts, validation results, cancellation, handoff provenance,
// and a failure category. It never stores request text, evidence text, model text, prompts, or
// private reasoning, and it never captures a chain of thought.
//
// Two rules shape the types here:
//   - `null` means "not measured". It is not zero. A stage that was not reached has no duration and
//     no counts; a stage that was entered but whose clock failed has an outcome but no duration.
//   - the record is an observation. `authorizes` is always false, and nothing in this module is read
//     by the lifecycle, the registry, the executor, or the verifier to decide anything.
//
// The cognitive stages reuse the timings the analysis already measured; the controller records the
// spans it owns (model call, validation, handoff, authorization, execution, verification, plans,
// tasks, finalization preparation). Deriving from what ran is the point: a stage the path skipped is
// reported as not reached, never as executed.
import { performance } from 'node:perf_hooks';

export const RUNTIME_DIAGNOSTICS_SCHEMA = 1;

export const DIAGNOSTICS_BOUNDS = Object.freeze({
  maxStages: 20,
  maxCountKeys: 10,
  maxDurationMs: 24 * 60 * 60 * 1000,
});

// The stages this build can observe. A name outside this list is refused, so a caller cannot grow
// the record by inventing stages, and every record has the same bounded shape.
export const RUNTIME_STAGES = Object.freeze([
  Object.freeze({ id: 'request_interpretation', name: 'request interpretation', owner: 'cognition' }),
  Object.freeze({ id: 'evidence_retrieval', name: 'evidence retrieval', owner: 'cognition' }),
  Object.freeze({ id: 'claim_extraction', name: 'claim extraction', owner: 'cognition' }),
  Object.freeze({ id: 'contradiction_detection', name: 'contradiction detection', owner: 'cognition', overlaps: 'claim_extraction' }),
  Object.freeze({ id: 'deliberation', name: 'deliberation', owner: 'cognition' }),
  Object.freeze({ id: 'grounded_response', name: 'grounded response construction', owner: 'cognition' }),
  Object.freeze({ id: 'model_call', name: 'model call', owner: 'gateway' }),
  Object.freeze({ id: 'model_output_validation', name: 'model-output validation', owner: 'controller' }),
  Object.freeze({ id: 'proposal_validation', name: 'proposal validation', owner: 'controller' }),
  Object.freeze({ id: 'handoff_preparation', name: 'executive handoff preparation', owner: 'executive' }),
  Object.freeze({ id: 'plan_validation', name: 'plan validation', owner: 'executive' }),
  Object.freeze({ id: 'authorization', name: 'authorization', owner: 'action_registry' }),
  Object.freeze({ id: 'execution', name: 'execution', owner: 'action_executor' }),
  Object.freeze({ id: 'verification', name: 'verification', owner: 'verifier' }),
  Object.freeze({ id: 'task_execution', name: 'task execution', owner: 'task_runner', overlaps: 'authorization,execution,verification' }),
  Object.freeze({ id: 'finalization', name: 'finalization preparation', owner: 'operations' }),
]);

export const StageOutcome = Object.freeze({
  RAN: 'ran',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  UNAVAILABLE: 'unavailable',
  NOT_REACHED: 'not_reached',
});

const OUTCOMES = new Set(Object.values(StageOutcome));
const STAGE_BY_ID = new Map(RUNTIME_STAGES.map((stage) => [stage.id, stage]));

// Fixed-token readers. These values already exist as APEX-authored identifiers, and a value that
// cannot be printed as one bounded token is dropped rather than copied into the record.
function token(value, max = 60) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  return /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value) ? value : null;
}

// Operation ids are UUIDs, so roughly five in eight begin with a digit. `token` refuses those, which
// would leave a record unable to name its own request. An id is still bounded and printable, so it is
// read by this wider rule rather than by the vocabulary rule used for stage and outcome names.
function idToken(value, max = 100) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) ? value : null;
}

function count(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function duration(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(Math.min(value, DIAGNOSTICS_BOUNDS.maxDurationMs) * 1000) / 1000;
}

function plainCounts(counts) {
  const out = {};
  let keys = 0;
  for (const [key, value] of Object.entries(counts ?? {})) {
    if (keys >= DIAGNOSTICS_BOUNDS.maxCountKeys) break;
    if (!/^[a-z][a-z0-9_]{0,24}$/.test(key)) continue;
    if (!Number.isFinite(value) || value < 0) continue;
    out[key] = Math.trunc(value);
    keys += 1;
  }
  return out;
}

function mergeCounts(target, counts) {
  const incoming = plainCounts(counts);
  const merged = { ...target };
  for (const [key, value] of Object.entries(incoming)) {
    if (merged[key] === undefined && Object.keys(merged).length >= DIAGNOSTICS_BOUNDS.maxCountKeys) break;
    merged[key] = (merged[key] ?? 0) + value;
  }
  return merged;
}

// `failed` outranks `unavailable`, which outranks `skipped`, which outranks `ran`: a stage that
// failed in one of several merged spans did not simply run. A merged span is never reported as a
// success the individual spans did not establish.
const OUTCOME_RANK = {
  [StageOutcome.RAN]: 0,
  [StageOutcome.SKIPPED]: 1,
  [StageOutcome.UNAVAILABLE]: 2,
  [StageOutcome.FAILED]: 3,
};

function strongest(a, b) {
  return OUTCOME_RANK[b] > OUTCOME_RANK[a] ? b : a;
}

// A per-request span recorder. Every method is failure-safe: a clock that throws or returns a
// non-number produces "not measured" rather than an exception, because diagnostics must never turn
// a request into a failure. A span that starts and is never ended is reported as entered with an
// unresolved outcome, not as reached or skipped.
export class SpanRecorder {
  #clock;
  #source;
  #enabled;
  #entered = new Map();
  #closed = new Map();
  #clockFault = false;
  #totalStartedAt;

  constructor({ clock = () => performance.now(), source = 'performance.now', enabled = true } = {}) {
    this.#clock = typeof clock === 'function' ? clock : () => performance.now();
    this.#source = typeof source === 'string' ? source.slice(0, 40) : 'performance.now';
    this.#enabled = enabled !== false;
    this.#totalStartedAt = this.#now();
  }

  get enabled() {
    return this.#enabled;
  }

  #now() {
    try {
      const value = this.#clock();
      if (Number.isFinite(value)) return value;
      this.#clockFault = true;
      return null;
    } catch {
      this.#clockFault = true;
      return null;
    }
  }

  start(name) {
    if (!this.#enabled || !STAGE_BY_ID.has(name)) return null;
    const token = { name, startedAt: this.#now() };
    this.#entered.set(name, true);
    return token;
  }

  // Ends a span. The duration is the monotonic difference; a clock that moved backwards is treated
  // as a timing fault (duration null) rather than a zero-length stage.
  end(span, { outcome = StageOutcome.RAN, counts = {} } = {}) {
    if (!this.#enabled || !span || !STAGE_BY_ID.has(span.name)) return;
    const endedAt = this.#now();
    let durationMs = null;
    if (Number.isFinite(span.startedAt) && Number.isFinite(endedAt)) {
      const delta = endedAt - span.startedAt;
      if (delta >= 0) durationMs = duration(delta);
      else this.#clockFault = true;
    }
    this.#record(span.name, {
      outcome: OUTCOMES.has(outcome) ? outcome : StageOutcome.RAN,
      durationMs,
      counts,
    });
  }

  // A stage that is known to have run (or been skipped) but whose duration is not measured here.
  mark(name, { outcome = StageOutcome.RAN, counts = {} } = {}) {
    if (!this.#enabled || !STAGE_BY_ID.has(name)) return;
    this.#record(name, {
      outcome: OUTCOMES.has(outcome) ? outcome : StageOutcome.RAN,
      durationMs: null,
      counts,
    });
  }

  // A duration measured elsewhere (a stage already timed by the analysis). Zero is a measurement;
  // a non-finite value is not.
  addDuration(name, ms, { outcome = StageOutcome.RAN, counts = {} } = {}) {
    if (!this.#enabled || !STAGE_BY_ID.has(name)) return;
    this.#record(name, {
      outcome: OUTCOMES.has(outcome) ? outcome : StageOutcome.RAN,
      durationMs: duration(ms),
      counts,
    });
  }

  #record(name, { outcome, durationMs, counts }) {
    const previous = this.#closed.get(name);
    this.#closed.set(name, {
      outcome: previous ? strongest(previous.outcome, outcome) : outcome,
      durationMs: Number.isFinite(durationMs)
        ? duration((previous?.durationMs ?? 0) + durationMs)
        : (previous?.durationMs ?? null),
      counts: previous ? mergeCounts(previous.counts, counts) : plainCounts(counts),
    });
  }

  // Total wall time of the request so far, from the recorder's construction. Null when the clock
  // could not be read. The audit append happens after this is read and is deliberately outside it.
  elapsedTotal() {
    const endedAt = this.#now();
    if (!Number.isFinite(this.#totalStartedAt) || !Number.isFinite(endedAt)) return null;
    const delta = endedAt - this.#totalStartedAt;
    if (delta < 0) {
      this.#clockFault = true;
      return null;
    }
    return duration(delta);
  }

  snapshot() {
    const stages = {};
    for (const stage of RUNTIME_STAGES) {
      if (this.#closed.has(stage.id)) {
        const entry = this.#closed.get(stage.id);
        stages[stage.id] = {
          outcome: entry.outcome,
          durationMs: entry.durationMs,
          counts: { ...entry.counts },
        };
      } else if (this.#entered.has(stage.id)) {
        // Entered, but the path never said how it ended. That is an unresolved measurement, not a
        // claim that the stage ran or that it was skipped.
        stages[stage.id] = { outcome: StageOutcome.UNAVAILABLE, durationMs: null, counts: {} };
      }
    }
    return {
      stages,
      clock: {
        source: this.#source,
        monotonic: !this.#clockFault,
        fault: this.#clockFault,
      },
    };
  }
}

// Which lifecycle stage owns a cognitive stage. The lifecycle is the executable state machine, so
// its recorded status is what decides whether a stage ran; this module never infers an outcome from
// the presence or absence of a duration.
const COGNITIVE_LIFECYCLE_ORDER = Object.freeze({
  request_interpretation: 2,
  evidence_retrieval: 3,
  claim_extraction: 4,
  contradiction_detection: 4,
  deliberation: 5,
  grounded_response: 5,
});

const COGNITIVE_TIMING_KEY = Object.freeze({
  request_interpretation: 'request',
  evidence_retrieval: 'retrieval',
  claim_extraction: 'claims',
  contradiction_detection: 'contradictions',
  deliberation: 'deliberation',
  grounded_response: 'brief',
});

function lifecycleOutcome(status) {
  if (status === 'ran') return StageOutcome.RAN;
  if (status === 'failed') return StageOutcome.FAILED;
  if (status === 'skipped') return StageOutcome.SKIPPED;
  if (status === 'unavailable') return StageOutcome.UNAVAILABLE;
  if (status === 'not_reached') return StageOutcome.NOT_REACHED;
  return null;
}

function lifecycleStages(cognition) {
  const stages = cognition?.lifecycle?.stages;
  if (!Array.isArray(stages)) return new Map();
  const byOrder = new Map();
  for (const stage of stages) {
    if (Number.isInteger(stage?.order)) byOrder.set(stage.order, stage);
  }
  return byOrder;
}

// A failure category is a fixed classification of the recorded outcome. It is not a root cause and
// not a probability: the code and stage beside it are the bounded identifiers APEX already wrote.
const FAILURE_CATEGORY = Object.freeze({
  input_rejected: 'input',
  action_denied: 'authorization',
  execution_failed: 'execution',
  verification_failed: 'verification',
  verification_unavailable: 'verification',
  audit_integrity_failed: 'audit',
  clarification_required: 'clarification',
  model_unavailable: 'model',
  request_cancelled: 'cancellation',
  duplicate_proposal: 'proposal',
  plan_invalid: 'plan',
  plan_not_found: 'plan',
  goal_not_found: 'goal',
  task_paused: 'task',
  task_cancelled: 'task',
});

function failureFor(status, operation) {
  const category = FAILURE_CATEGORY[status] ?? null;
  if (!category) return null;
  const first = Array.isArray(operation?.errors) ? operation.errors[0] : null;
  return {
    category,
    code: token(first?.code) ?? token(status),
    stage: token(first?.stage),
  };
}

function handoffSummary(operation, spans) {
  const kinds = {};
  const states = {};
  let recorded = 0;
  const add = (handoff) => {
    if (!handoff || typeof handoff !== 'object') return;
    recorded += 1;
    const kind = token(handoff.kind) ?? 'unknown';
    const state = token(handoff.state) ?? 'unknown';
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    states[state] = (states[state] ?? 0) + 1;
  };
  add(operation?.handoff);
  for (const step of Array.isArray(operation?.steps) ? operation.steps : []) add(step?.handoff);
  const prep = spans?.stages?.handoff_preparation?.counts ?? {};
  const prepared = count(prep.prepared);
  const rejected = count(prep.rejected);
  const completed = count(prep.completed);
  const preparedOnly = prepared === null ? null : Math.max(0, prepared - (completed ?? 0) - (rejected ?? 0));
  return {
    recorded,
    prepared,
    completed,
    preparedOnly,
    rejected,
    kinds,
    states,
  };
}

function cognitiveSummary(cognition, modelValidation) {
  if (!cognition || cognition.available !== true) {
    return cognition?.available === false
      ? {
        available: false,
        evidence: null,
        claims: null,
        decision: null,
        uncertainty: null,
        clarification: null,
        validation: validationSummary(modelValidation),
      }
      : null;
  }
  const claims = cognition.claims ?? {};
  const evidence = cognition.evidence ?? {};
  return {
    available: true,
    evidence: count(evidence.total),
    dropped: count(evidence.dropped),
    claims: count(claims.total),
    material: count(claims.material),
    supported: count(claims.supported),
    contradicted: count(claims.contradicted),
    inference: count(claims.inference),
    unknown: count(claims.unknown),
    expectation: count(claims.expectation),
    decision: token(cognition.decision),
    uncertainty: token(cognition.uncertainty),
    clarification: typeof cognition.clarification === 'boolean' ? cognition.clarification : null,
    validation: validationSummary(modelValidation),
  };
}

// Accepts either the validator's return value (`found`/`validation.ok`) or the bounded audit the
// controller stores on the operation (`structured`/`validationOk`). Both describe the same check.
function validationSummary(validation) {
  if (!validation || typeof validation !== 'object') return null;
  const rejected = validation.rejected === true;
  const structured = validation.structured === true || validation.found === true;
  const ok = validation.validationOk === true || validation.ok === true;
  return {
    structured,
    ok,
    rejected,
    code: token(validation.errorCode),
  };
}

function boundarySummary(cognition, lifecycleByOrder) {
  const boundary = cognition?.trace?.boundary ?? null;
  if (boundary) {
    return {
      proposals: boundary.proposals ? { ...plainCounts(boundary.proposals) } : null,
      authorization: boundary.authorization ? { ...plainCounts(boundary.authorization) } : null,
      execution: boundary.execution ? { ...plainCounts(boundary.execution) } : null,
      verification: boundary.verification ? { ...plainCounts(boundary.verification) } : null,
    };
  }
  const countsOf = (order) => {
    const stage = lifecycleByOrder.get(order);
    return stage && typeof stage.counts === 'object' ? { ...plainCounts(stage.counts) } : null;
  };
  const proposals = countsOf(6);
  const authorization = countsOf(7);
  const execution = countsOf(8);
  const verification = countsOf(9);
  if (!proposals && !authorization && !execution && !verification) return null;
  return { proposals, authorization, execution, verification };
}

function cancellationSummary(cancellation) {
  if (!cancellation || typeof cancellation !== 'object') return null;
  return {
    requested: cancellation.requested === true,
    afterResponse: cancellation.afterResponse === true,
  };
}

function retrySummary(retries) {
  return Number.isInteger(retries) && retries >= 0
    ? { available: true, count: retries }
    : { available: false, count: null };
}

function buildStages({ spans, cognition, lifecycleByOrder }) {
  const timings = cognition?.timings && typeof cognition.timings === 'object' ? cognition.timings : {};
  const recordedSpans = spans?.stages ?? {};
  return RUNTIME_STAGES.map((definition) => {
    const span = recordedSpans[definition.id];
    if (span) {
      return {
        id: definition.id,
        name: definition.name,
        owner: definition.owner,
        outcome: OUTCOMES.has(span.outcome) ? span.outcome : StageOutcome.UNAVAILABLE,
        durationMs: Number.isFinite(span.durationMs) ? duration(span.durationMs) : null,
        counts: plainCounts(span.counts),
        ...(definition.overlaps ? { overlaps: definition.overlaps } : {}),
      };
    }
    const order = COGNITIVE_LIFECYCLE_ORDER[definition.id];
    if (order === undefined) {
      return {
        id: definition.id,
        name: definition.name,
        owner: definition.owner,
        outcome: StageOutcome.NOT_REACHED,
        durationMs: null,
        counts: {},
        ...(definition.overlaps ? { overlaps: definition.overlaps } : {}),
      };
    }
    const lifecycleStage = lifecycleByOrder.get(order);
    const outcome = lifecycleOutcome(lifecycleStage?.status) ?? StageOutcome.NOT_REACHED;
    const measured = timings[COGNITIVE_TIMING_KEY[definition.id]];
    return {
      id: definition.id,
      name: definition.name,
      owner: definition.owner,
      outcome,
      durationMs: outcome === StageOutcome.RAN || outcome === StageOutcome.FAILED
        ? duration(measured)
        : null,
      counts: {},
      ...(definition.overlaps ? { overlaps: definition.overlaps } : {}),
    };
  });
}

function unavailableRecord({ requestId = null } = {}) {
  return {
    schema: RUNTIME_DIAGNOSTICS_SCHEMA,
    requestId: idToken(requestId),
    available: false,
    error: 'diagnostics_unavailable',
    totalMs: null,
    stages: [],
    cognitive: null,
    executive: null,
    cancellation: null,
    failure: null,
    retries: { available: false, count: null },
    clock: { source: 'unavailable', monotonic: false, fault: true },
    bounds: { stages: DIAGNOSTICS_BOUNDS.maxStages, countsPerStage: DIAGNOSTICS_BOUNDS.maxCountKeys },
    authorizes: false,
  };
}

// Pure aggregation over measurements that already exist. It reads no store, runs no clock, and
// decides nothing; the only inputs are the operation's recorded outcome, the cognitive audit, the
// span snapshot, and the caller's bounded cancellation/retry statements.
export function buildRuntimeDiagnostics({
  requestId = null,
  operation = null,
  cognition = null,
  spans = null,
  status = null,
  modelValidation = null,
  cancellation = null,
  retries = null,
  totalDurationMs = null,
} = {}) {
  try {
    const lifecycleByOrder = lifecycleStages(cognition);
    const stages = buildStages({ spans, cognition, lifecycleByOrder });
    const measurements = stages.filter((stage) => Number.isFinite(stage.durationMs));
    return {
      schema: RUNTIME_DIAGNOSTICS_SCHEMA,
      requestId: idToken(requestId),
      available: true,
      status: token(status),
      totalMs: duration(totalDurationMs),
      measuredStages: measurements.length,
      stages,
      cognitive: cognitiveSummary(cognition, modelValidation),
      executive: (() => {
        const boundary = boundarySummary(cognition, lifecycleByOrder);
        const handoffs = handoffSummary(operation, spans);
        if (!boundary && handoffs.recorded === 0 && handoffs.prepared === null) return null;
        return { ...(boundary ?? {}), handoffs };
      })(),
      cancellation: cancellationSummary(cancellation),
      failure: failureFor(status, operation),
      retries: retrySummary(retries),
      clock: spans?.clock ?? { source: 'unavailable', monotonic: false, fault: true },
      bounds: { stages: DIAGNOSTICS_BOUNDS.maxStages, countsPerStage: DIAGNOSTICS_BOUNDS.maxCountKeys },
      // The same statement the cognitive contract and the execution boundary carry. Recording a
      // duration is not permitting anything.
      authorizes: false,
    };
  } catch {
    return unavailableRecord({ requestId });
  }
}

// A bounded human-readable view for tests and reports. Counts and stage identifiers only: it never
// prints a request, a record, or model text.
export function renderRuntimeDiagnostics(record) {
  if (!record || record.available !== true) return 'diagnostics unavailable';
  const lines = [];
  const total = Number.isFinite(record.totalMs) ? `${record.totalMs.toFixed(3)} ms` : 'not measured';
  lines.push(`${record.requestId ?? 'request'} ${record.status ?? ''} (${total})`.trim());
  for (const stage of record.stages) {
    const ms = Number.isFinite(stage.durationMs) ? `${stage.durationMs.toFixed(3)} ms` : 'n/a';
    lines.push(`  ${stage.id}: ${stage.outcome} ${ms}`);
  }
  return lines.join('\n');
}
