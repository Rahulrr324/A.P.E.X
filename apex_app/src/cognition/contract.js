// The explicit cognitive runtime contract.
//
// One request passes through ten stages in a fixed order. The cognitive layer owns the first five,
// the model may propose at the sixth, and the last four belong to the executive path that already
// exists (action registry, action execution, independent verifier, and the operation/learning
// records). This module does not orchestrate anything: it reads the records those stages already
// produced and states, per request, which stage ran, what it decided, and where authority lives.
//
// The authority statement is the point of the contract. A cognitive answer, a structured response,
// or a model proposal is input to the executive path, never a substitute for it. `buildContract`
// checks the invariants behind that claim: no step may execute without an allow decision, and no
// step may execute without an authorization record at all.

export const COGNITIVE_CONTRACT_SCHEMA = 1;

export const ContractStage = Object.freeze({
  REQUEST: 'user_request',
  INTERPRETATION: 'cognitive_interpretation',
  EVIDENCE: 'retrieved_evidence',
  CLAIMS: 'grounded_claims',
  RESPONSE: 'proposed_response',
  PROPOSED_ACTIONS: 'proposed_actions',
  AUTHORIZATION: 'executive_authorization',
  EXECUTION: 'actual_execution',
  VERIFICATION: 'verification',
  LEARNING: 'learning_and_outcome',
});

// Declared in order, with the component that owns the decision at each stage. The cognitive layer
// cannot move a request past stage 6; the executive stages are recorded here from their own records.
export const CONTRACT_STAGES = Object.freeze([
  Object.freeze({ order: 1, name: ContractStage.REQUEST, owner: 'user' }),
  Object.freeze({ order: 2, name: ContractStage.INTERPRETATION, owner: 'cognitive' }),
  Object.freeze({ order: 3, name: ContractStage.EVIDENCE, owner: 'cognitive' }),
  Object.freeze({ order: 4, name: ContractStage.CLAIMS, owner: 'cognitive' }),
  Object.freeze({ order: 5, name: ContractStage.RESPONSE, owner: 'cognitive' }),
  Object.freeze({ order: 6, name: ContractStage.PROPOSED_ACTIONS, owner: 'model' }),
  Object.freeze({ order: 7, name: ContractStage.AUTHORIZATION, owner: 'executive' }),
  Object.freeze({ order: 8, name: ContractStage.EXECUTION, owner: 'executive' }),
  Object.freeze({ order: 9, name: ContractStage.VERIFICATION, owner: 'executive' }),
  Object.freeze({ order: 10, name: ContractStage.LEARNING, owner: 'executive' }),
]);

export const StageStatus = Object.freeze({
  RAN: 'ran',
  SKIPPED: 'skipped',
  NOT_REACHED: 'not_reached',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed',
});

// Fixed statement of where authority lives. Every contract carries it verbatim, so a reader of the
// audit record does not have to infer the boundary from prose or from a code path.
export const COGNITION_AUTHORITY = Object.freeze({
  cognitiveOutputGrantsAuthorization: false,
  authorizationOwner: 'action_registry',
  executionPerformedByCognitiveLayer: false,
  canSkipAuthorization: false,
  verificationIndependent: true,
  modelOutputUntrusted: true,
});

const CONTRACT_NOTE = 'stages 1-5 describe a cognitive reading, stage 6 is where a model may propose, and stages 7-10 are the existing executive path; carrying a proposal or an answer past stage 6 is not possible from this layer';

const LABEL_RE = /^[a-z][a-z0-9_]{0,40}$/;

function count(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

// Shared with the executable lifecycle so one stage can never carry two different sanitizations.
export function sanitizeCounts(values) {
  const out = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!LABEL_RE.test(key)) continue;
    if (typeof value === 'boolean') out[key] = value;
    else if (Number.isFinite(value)) out[key] = count(value);
  }
  return out;
}

export function sanitizeLabels(values) {
  const out = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!LABEL_RE.test(key) || typeof value !== 'string' || !LABEL_RE.test(value)) continue;
    out[key] = value;
  }
  return out;
}

function stage(order, status, counts = {}, labels = {}) {
  const definition = CONTRACT_STAGES[order - 1];
  return {
    order: definition.order,
    name: definition.name,
    owner: definition.owner,
    status,
    counts: sanitizeCounts(counts),
    labels: sanitizeLabels(labels),
  };
}

// A lifecycle is handed in either as the object or as its already-taken snapshot. Only the declared
// ten stages and their fixed vocabulary are read; nothing else on the object is copied.
function lifecycleSnapshotOf(lifecycle) {
  if (!lifecycle || typeof lifecycle !== 'object') return null;
  const snapshot = typeof lifecycle.snapshot === 'function' ? lifecycle.snapshot() : lifecycle;
  if (!Array.isArray(snapshot?.stages) || snapshot.stages.length !== CONTRACT_STAGES.length) return null;
  return snapshot;
}

const LIFECYCLE_TERMINAL = new Set([
  StageStatus.RAN, StageStatus.SKIPPED, StageStatus.NOT_REACHED, StageStatus.UNAVAILABLE, StageStatus.FAILED,
]);

function stagesFromLifecycle(snapshot) {
  return CONTRACT_STAGES.map((definition) => {
    const entry = snapshot.stages.find((candidate) => candidate?.order === definition.order);
    const status = LIFECYCLE_TERMINAL.has(entry?.status) ? entry.status : StageStatus.NOT_REACHED;
    return stage(definition.order, status, entry?.counts, entry?.labels);
  });
}

// The first five stages, read from a completed analysis. An analysis that could not be taken leaves
// its own stage unavailable and every later cognitive stage unavailable; nothing downstream is claimed.
function cognitiveStages(analysis) {
  if (!analysis || analysis.available !== true) {
    return [
      stage(1, StageStatus.RAN, { received: 1 }),
      stage(2, StageStatus.UNAVAILABLE),
      stage(3, StageStatus.UNAVAILABLE),
      stage(4, StageStatus.UNAVAILABLE),
      stage(5, StageStatus.UNAVAILABLE),
    ];
  }
  const u = analysis.understanding ?? {};
  const r = analysis.retrieval?.counts ?? {};
  const c = analysis.claims?.counts ?? {};
  const d = analysis.deliberation ?? {};
  const sources = Array.isArray(analysis.retrieval?.sources) ? analysis.retrieval.sources : [];
  return [
    stage(1, StageStatus.RAN, { received: 1 }),
    stage(2, StageStatus.RAN, {
      entities: u.entities?.length,
      goals: u.goals?.length,
      plans: u.plans?.length,
      tasks: u.tasks?.length,
      missing: u.missing?.length,
      ambiguities: u.ambiguities?.length,
      execution_requested: u.executionRequested === true,
    }),
    stage(3, StageStatus.RAN, {
      evidence: r.total,
      sources: sources.filter((source) => source.status === 'ok').length,
      unavailable: r.unavailable?.length,
      damaged: r.damaged?.length,
      dropped: r.dropped,
    }),
    stage(4, StageStatus.RAN, {
      total: c.total,
      material: c.material,
      contradicted: c.contradicted,
      historical: c.historical,
      inference: c.inference,
    }),
    stage(5, StageStatus.RAN, {
      clarification: d.clarification?.needed === true,
      disclosures: d.disclosures?.length,
    }, {
      decision: d.decision,
      uncertainty: d.uncertainty?.category,
    }),
  ];
}

// Stages 6-10, read only from records the executive path produced. `proposals` is this request's
// parse result; `steps` is the array of step records `runAction` returned, in order. When either is
// absent the stage is not reached rather than guessed at.
function executiveStages({ proposals, steps, learning }) {
  const out = [];
  if (!proposals) {
    for (let order = 6; order <= 10; order += 1) out.push(stage(order, StageStatus.NOT_REACHED));
    return out;
  }
  out.push(stage(6, StageStatus.RAN, {
    observed: count(proposals.observed),
    well_formed: count(proposals.wellFormed),
    malformed: count(proposals.malformed),
    overflow: count(proposals.overflow),
  }));

  if (!Array.isArray(steps)) {
    for (let order = 7; order <= 10; order += 1) out.push(stage(order, StageStatus.NOT_REACHED));
    return out;
  }
  if (steps.length === 0) {
    out.push(stage(7, StageStatus.SKIPPED, { requests: 0 }));
    for (let order = 8; order <= 10; order += 1) out.push(stage(order, StageStatus.NOT_REACHED));
    return out;
  }
  const allowed = steps.filter((s) => s.authorization?.decision === 'allow').length;
  out.push(stage(7, StageStatus.RAN, {
    requests: steps.length,
    allowed,
    denied: steps.length - allowed,
  }));

  const ran = steps.filter((s) => s.execution?.status === 'ok');
  if (allowed === 0) {
    out.push(stage(8, StageStatus.SKIPPED, { attempted: 0 }));
    out.push(stage(9, StageStatus.NOT_REACHED));
  } else {
    out.push(stage(8, StageStatus.RAN, {
      attempted: allowed,
      ok: ran.length,
      rejected: steps.filter((s) => s.execution?.status === 'rejected').length,
      failed: steps.filter((s) => s.execution?.status === 'failed').length,
    }));
    if (ran.length === 0) {
      out.push(stage(9, StageStatus.SKIPPED, { checked: 0 }));
    } else {
      out.push(stage(9, StageStatus.RAN, {
        checked: ran.length,
        verified: ran.filter((s) => s.verification?.outcome === 'success_verified').length,
        failed: ran.filter((s) => s.verification?.outcome === 'verification_failed').length,
        unavailable: ran.filter((s) => s.verification?.outcome === 'verification_unavailable').length,
      }));
    }
  }

  // The learning stage is the operation's own outcome record. It is read, not written, here. A
  // caller that knows the record was finalized passes `learning`; otherwise nothing is claimed.
  if (learning?.recorded === true) {
    out.push(stage(10, StageStatus.RAN, { recorded: 1, failed: count(learning.failed) }));
  } else if (learning?.recorded === false) {
    out.push(stage(10, StageStatus.FAILED, { recorded: 0 }));
  } else {
    out.push(stage(10, StageStatus.NOT_REACHED));
  }
  return out;
}

// A not-reached stage ends the request's passage through the contract: every later stage must also
// be not reached. This is derived, not asserted, so a caller that supplies inconsistent records sees
// the inconsistency in the resulting order rather than having a later stage silently keep `ran`.
function closeNotReached(stages) {
  let closed = false;
  return stages.map((entry) => {
    if (entry.status === StageStatus.NOT_REACHED) closed = true;
    return closed && entry.status !== StageStatus.NOT_REACHED
      ? { ...entry, status: StageStatus.NOT_REACHED, counts: {}, labels: {} }
      : entry;
  });
}

export function buildContract({
  requestId = null, analysis = null, proposals = null, steps = null, learning = null, lifecycle = null,
} = {}) {
  // When the request actually passed through the executable lifecycle, the contract restates those
  // recorded transitions instead of re-deriving them from the analysis. The two paths agree on the
  // vocabulary, and this one cannot show a stage the lifecycle refused to enter.
  const snapshot = lifecycleSnapshotOf(lifecycle);
  const stages = snapshot
    ? closeNotReached(stagesFromLifecycle(snapshot))
    : closeNotReached([...cognitiveStages(analysis), ...executiveStages({ proposals, steps, learning })]);
  const records = Array.isArray(steps) ? steps : [];
  const executed = records.filter((s) => s.execution?.status === 'ok');
  const unauthorized = executed.filter((s) => s.authorization?.decision !== 'allow');
  const unrecorded = executed.filter((s) => !s.authorization || typeof s.authorization.decision !== 'string');

  const checks = [
    {
      check: 'execution_requires_authorization',
      ok: unauthorized.length === 0,
      detail: unauthorized.length === 0
        ? 'every executed step carries an allow decision from the action registry'
        : `${unauthorized.length} executed step(s) have no allow decision`,
    },
    {
      check: 'authorization_recorded_before_execution',
      ok: unrecorded.length === 0,
      detail: unrecorded.length === 0
        ? 'every executed step has an authorization decision on its record'
        : `${unrecorded.length} executed step(s) have no authorization decision recorded`,
    },
    {
      // An attempted transition the lifecycle refused means the caller tried to advance outside the
      // recorded order. The refusal is kept in the audit; the contract reports that it happened.
      check: 'lifecycle_transitions_recorded',
      ok: !snapshot || (Array.isArray(snapshot.rejections) && snapshot.rejections.length === 0),
      detail: !snapshot || (Array.isArray(snapshot.rejections) && snapshot.rejections.length === 0)
        ? 'every stage transition passed its recorded entry condition'
        : `${(snapshot.rejections ?? []).length} stage transition(s) were rejected by the lifecycle`,
    },
  ];
  // "Reached" means the stage actually did its work. A skipped stage (nothing to authorize) or an
  // unavailable one (the analysis could not be taken) is not counted as progress through the contract.
  const reachedThrough = stages.reduce(
    (max, entry) => (entry.status === StageStatus.RAN || entry.status === StageStatus.FAILED
      ? Math.max(max, entry.order)
      : max),
    0,
  );

  return {
    schema: COGNITIVE_CONTRACT_SCHEMA,
    note: CONTRACT_NOTE,
    requestId: typeof requestId === 'string' ? requestId.slice(0, 100) : null,
    ok: checks.every((check) => check.ok === true),
    stages,
    reachedThrough,
    authority: { ...COGNITION_AUTHORITY },
    checks,
    authorizes: false,
  };
}

// The shape an audit record carries. Stage names, statuses, bounded counts, fixed labels, and the
// authority block only: no request text, evidence text, model text, proposal values, or reasoning.
export function contractAudit(contract) {
  if (!contract) return null;
  return {
    schema: contract.schema,
    requestId: contract.requestId,
    ok: contract.ok === true,
    reachedThrough: contract.reachedThrough,
    stages: contract.stages.map((entry) => ({
      order: entry.order,
      name: entry.name,
      owner: entry.owner,
      status: entry.status,
      counts: { ...entry.counts },
      ...(Object.keys(entry.labels).length > 0 ? { labels: { ...entry.labels } } : {}),
    })),
    authority: { ...contract.authority },
    checks: contract.checks.map((check) => ({ check: check.check, ok: check.ok === true })),
  };
}
