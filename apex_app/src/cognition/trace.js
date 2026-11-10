// Bounded reasoning trace.
//
// The trace records what the deterministic layer did, not what a model thought: the stages that ran,
// which evidence ids each stage used, conflicts it kept, assumptions it stated, conclusions it drew,
// and the result of validating the answer. It never stores request text, evidence text, model text,
// or a chain of thought. `toAudit()` is the only shape that leaves the process, and it contains
// identifiers, labels, counts, and validation results only.
import { BOUNDS } from './vocabulary.js';

// What the executive boundary did with the model's output. Every field is derived from step records
// the action registry already produced, so the record restates a decision and can never supply one.
const BOUNDARY_OUTCOMES = new Set([
  'not_reached', 'no_proposals', 'malformed_only', 'all_denied', 'partially_executed', 'all_executed',
]);

function boundedNumber(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

// Fixed-token labels only: an authorization reason or a refusal code is APEX-authored, and a value
// that cannot be printed as one token is dropped rather than copied into the audit.
function boundedLabel(value, max = 80) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  return /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value) ? value : null;
}

export function executionBoundary({
  reached = true, proposals = null, steps = null, durationMs = null,
} = {}) {
  const records = Array.isArray(steps) ? steps : [];
  const proposalCounts = proposals && typeof proposals === 'object'
    ? {
      observed: boundedNumber(proposals.observed),
      wellFormed: boundedNumber(proposals.wellFormed),
      malformed: boundedNumber(proposals.malformed),
      overflow: boundedNumber(proposals.overflow),
    }
    : null;
  const decision = (step) => (step && typeof step.authorization === 'object' ? step.authorization.decision : null);
  const allowed = records.filter((step) => decision(step) === 'allow').length;
  const denied = records.length - allowed;
  const status = (step) => (typeof step?.execution?.status === 'string' ? step.execution.status : 'not_run');
  const verification = (step) => (typeof step?.verification?.outcome === 'string' ? step.verification.outcome : 'not_run');
  const refusalReasons = [...new Set(records
    .filter((step) => decision(step) !== 'allow')
    .map((step) => boundedLabel(step?.authorization?.reason))
    .filter(Boolean))].slice(0, 3);

  let outcome = 'not_reached';
  if (reached === true) {
    if (!proposalCounts || (proposalCounts.wellFormed === 0 && proposalCounts.malformed === 0)) outcome = 'no_proposals';
    else if (proposalCounts.wellFormed === 0) outcome = 'malformed_only';
    else if (records.length === 0) outcome = 'no_proposals';
    else if (allowed === 0) outcome = 'all_denied';
    else if (denied === 0 && records.every((step) => status(step) === 'ok')) outcome = 'all_executed';
    else outcome = 'partially_executed';
  }

  return {
    reached: reached === true,
    outcome: BOUNDARY_OUTCOMES.has(outcome) ? outcome : 'partially_executed',
    proposals: proposalCounts,
    authorization: { requests: records.length, allowed, denied },
    execution: {
      attempted: allowed,
      ok: records.filter((step) => status(step) === 'ok').length,
      rejected: records.filter((step) => status(step) === 'rejected').length,
      failed: records.filter((step) => status(step) === 'failed').length,
    },
    verification: {
      verified: records.filter((step) => verification(step) === 'success_verified').length,
      failed: records.filter((step) => verification(step) === 'verification_failed').length,
      unavailable: records.filter((step) => verification(step) === 'verification_unavailable').length,
    },
    refusalReasons,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs * 1000) / 1000) : null,
    // The two constants a reader of the audit can rely on without reading prose or code.
    authorizes: false,
    authorizationOwner: 'action_registry',
  };
}

// Adds an already-computed boundary record to an existing trace audit. The trace object itself lives
// inside the cognitive analysis; the boundary is known only after the executive path has run, so the
// caller hands its step records back here rather than the trace re-reading anything.
export function attachBoundary(audit, boundary) {
  if (!audit || typeof audit !== 'object' || !boundary) return audit ?? null;
  return { ...audit, boundary, authorizes: false };
}

function plainCounts(counts) {
  const out = {};
  for (const [key, value] of Object.entries(counts ?? {})) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.max(0, Math.trunc(value));
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function idList(values, max = 32) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length <= 200))].slice(0, max);
}

export class CognitionTrace {
  #stages = [];
  #evidence = [];
  #excluded = [];
  #conflicts = [];
  #assumptions = new Set();
  #subquestions = [];
  #conclusions = [];
  #disclosures = new Set();
  #refusals = [];
  #validation = null;
  #decision = null;
  #uncertainty = null;
  #boundary = null;
  #timings = {};

  constructor({ requestId = null, intent = null } = {}) {
    this.requestId = typeof requestId === 'string' ? requestId.slice(0, 100) : null;
    this.intent = typeof intent === 'string' ? intent.slice(0, 60) : null;
  }

  stage(name, { status = 'ran', counts = {}, durationMs = null } = {}) {
    if (this.#stages.some((entry) => entry.name === name)) return this;
    if (this.#stages.length >= BOUNDS.maxTraceStages) return this;
    const entry = {
      name: String(name).slice(0, 60),
      status: ['ran', 'skipped', 'failed'].includes(status) ? status : 'ran',
      counts: plainCounts(counts),
    };
    if (Number.isFinite(durationMs)) entry.durationMs = Math.max(0, Math.round(durationMs * 1000) / 1000);
    this.#stages.push(entry);
    return this;
  }

  timing(stage, durationMs) {
    if (!Number.isFinite(durationMs)) return this;
    this.#timings[String(stage).slice(0, 40)] = Math.max(0, Math.round(durationMs * 1000) / 1000);
    return this;
  }

  evidence(items) {
    const seen = new Set(this.#evidence.map((item) => item.id));
    for (const item of items ?? []) {
      if (this.#evidence.length >= BOUNDS.maxTraceEvidence) break;
      if (!item || typeof item.evidenceId !== 'string' || seen.has(item.evidenceId)) continue;
      seen.add(item.evidenceId);
      this.#evidence.push({
        id: item.evidenceId.slice(0, 200),
        source: String(item.source ?? '').slice(0, 40),
        type: String(item.type ?? '').slice(0, 40),
        recordId: String(item.recordId ?? '').slice(0, 200),
      });
    }
    return this;
  }

  excluded(source, reason, count = 1) {
    if (this.#excluded.length >= BOUNDS.maxTraceNotes) return this;
    const existing = this.#excluded.find((entry) => entry.source === source && entry.reason === reason);
    if (existing) {
      existing.count += Math.max(1, Number.isFinite(count) ? Math.trunc(count) : 1);
      return this;
    }
    this.#excluded.push({
      source: String(source).slice(0, 40),
      reason: String(reason).slice(0, 120),
      count: Math.max(1, Number.isFinite(count) ? Math.trunc(count) : 1),
    });
    return this;
  }

  conflict({ id = null, state = null, members = [] } = {}) {
    if (this.#conflicts.length >= BOUNDS.maxTraceNotes) return this;
    this.#conflicts.push({
      id: typeof id === 'string' ? id.slice(0, 100) : null,
      state: typeof state === 'string' ? state.slice(0, 30) : null,
      members: idList(members, 8),
    });
    return this;
  }

  assumption(code) {
    if (typeof code !== 'string' || this.#assumptions.size >= BOUNDS.maxAssumptions) return this;
    this.#assumptions.add(code.slice(0, 60));
    return this;
  }

  subquestion({ code, answerable = false, evidenceIds = [] } = {}) {
    if (this.#subquestions.length >= BOUNDS.maxSubquestions) return this;
    this.#subquestions.push({
      code: String(code ?? '').slice(0, 60),
      answerable: answerable === true,
      evidenceIds: idList(evidenceIds, 8),
    });
    return this;
  }

  conclusion({ claimId = null, kind = null, evidenceIds = [] } = {}) {
    if (this.#conclusions.length >= BOUNDS.maxClaims) return this;
    this.#conclusions.push({
      claimId: typeof claimId === 'string' ? claimId.slice(0, 100) : null,
      kind: typeof kind === 'string' ? kind.slice(0, 40) : null,
      evidenceIds: idList(evidenceIds, 12),
    });
    return this;
  }

  disclose(code) {
    if (typeof code === 'string') this.#disclosures.add(code.slice(0, 60));
    return this;
  }

  // Why the cognitive layer stopped short of an answer: the clarification it needs, or the decision
  // not to answer. The code and its bounded detail are fixed labels, never the request or the
  // question's wording.
  refusal(code, detail = null) {
    if (this.#refusals.length >= 4) return this;
    const entry = boundedLabel(code, 60);
    if (!entry) return this;
    const item = { code: entry };
    const why = boundedLabel(detail, 60);
    if (why) item.detail = why;
    this.#refusals.push(item);
    return this;
  }

  // The executive boundary's answer, supplied after the steps have run. A trace can describe an
  // authorization decision; it cannot make one.
  boundary(options = {}) {
    this.#boundary = executionBoundary(options);
    return this;
  }

  validate(ok, problems = []) {
    this.#validation = {
      ok: ok === true,
      problems: idList(problems, 8).map((problem) => problem.slice(0, 120)),
    };
    return this;
  }

  decide({ decision = null, uncertainty = null } = {}) {
    this.#decision = typeof decision === 'string' ? decision.slice(0, 40) : null;
    this.#uncertainty = typeof uncertainty === 'string' ? uncertainty.slice(0, 40) : null;
    return this;
  }

  get evidenceIds() {
    return this.#evidence.map((item) => item.id);
  }

  get conclusionCount() {
    return this.#conclusions.length;
  }

  toAudit() {
    return {
      requestId: this.requestId,
      intent: this.intent,
      stages: this.#stages.map((entry) => ({ ...entry, counts: { ...entry.counts } })),
      evidence: this.#evidence.map((item) => ({ ...item })),
      excluded: this.#excluded.map((entry) => ({ ...entry })),
      conflicts: this.#conflicts.map((entry) => ({ ...entry, members: [...entry.members] })),
      subquestions: this.#subquestions.map((entry) => ({ ...entry, evidenceIds: [...entry.evidenceIds] })),
      assumptions: [...this.#assumptions],
      conclusions: this.#conclusions.map((entry) => ({ ...entry, evidenceIds: [...entry.evidenceIds] })),
      refusals: this.#refusals.map((entry) => ({ ...entry })),
      validation: this.#validation ? { ok: this.#validation.ok, problems: [...this.#validation.problems] } : null,
      decision: this.#decision,
      uncertainty: this.#uncertainty,
      disclosures: [...this.#disclosures],
      boundary: this.#boundary,
      timings: { ...this.#timings },
      // A trace is a description of what happened, never a permission. It is stated here so a
      // consumer cannot read the record and mistake a recorded decision for an authorization.
      authorizes: false,
      bounds: {
        stages: BOUNDS.maxTraceStages,
        evidence: BOUNDS.maxTraceEvidence,
        notes: BOUNDS.maxTraceNotes,
        truncated: this.#stages.length >= BOUNDS.maxTraceStages
          || this.#evidence.length >= BOUNDS.maxTraceEvidence
          || this.#excluded.length >= BOUNDS.maxTraceNotes,
      },
    };
  }
}
