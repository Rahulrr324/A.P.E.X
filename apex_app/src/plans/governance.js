// Batch AP-05: adaptation governance - the read path that turns a recorded effectiveness report
// into an evidence-bound review question for the user.
//
// This module reads. It opens nothing, decides nothing, retires nothing, and changes no rule. Its
// three jobs are:
//
//   1. assemble the exact, bounded evidence bundle a review is opened against, from the same stores
//      the effectiveness report reads, so a review cannot cite evidence that was never recorded;
//   2. reconcile a stored review's evidence against the live stores, naming what changed - added,
//      withdrawn, superseded, stale, conflicting, missing, unreadable - without saying whether the
//      change is good or bad;
//   3. classify one of the nine review states for a reader, from those two facts.
//
// The digest a review stores over its evidence is the canonical bundle's digest (../experience/review.js).
// The effectiveness report digest is tracked beside it, never instead of it: the full report also counts
// audit lines and other adaptations' uses, so it can move while every item this review cites is unchanged.
import { createHash } from 'node:crypto';
import { stableStringify } from '../tasks/model.js';
import { StoreError, ValidationError } from '../errors.js';
import { shortId, singleLine } from '../util.js';
import { analyzeEffectivenessWithSnapshot, MAX_EFFECTIVENESS_ADAPTATIONS } from './effectiveness.js';
import { DEFAULT_SNAPSHOT_ATTEMPTS, contributingStores, runConsistentEvidenceRead } from '../evidence/snapshot.js';
import { integrityFinding, integrityReport } from '../evidence/integrity.js';
import { planContentHash } from './model.js';
import {
  MAX_REVIEW_CHANGES,
  MAX_REVIEW_REFS,
  REVIEW_STATES,
  canonicalReviewEvidence,
  classifyReviewState,
  reconcileReviewEvidence,
} from '../experience/review.js';

export const GOVERNANCE_SCHEMA = 'apex.adaptation-governance.v1';
export const GOVERNANCE_NOTE = 'A governance review records that a question was opened on recorded evidence. It approves nothing, changes no rule, increases no influence, and executes nothing. Retention stays the existing `adaptation.retire`; a recommendation is never a decision.';

export const MAX_GOVERNANCE_ADAPTATIONS = MAX_EFFECTIVENESS_ADAPTATIONS;
const MAX_REVIEW_HISTORY = 20;

function digestOf(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

// The digest covers what the read found, not when it ran. `generatedAt` is read-time metadata, the
// snapshot identity says which bytes were present rather than what they meant, and the integrity
// summary is represented by its own digest (which already excludes both). A second read over unchanged
// records therefore returns the same digest even though its own audit line grew the file.
function reportHashOf(report) {
  return digestOf({
    ...report,
    generatedAt: null,
    digest: null,
    snapshot: null,
    integrity: report.integrity?.digest ?? null,
  });
}

function limitValue(value) {
  if (!Number.isInteger(value) || value < 1) return MAX_GOVERNANCE_ADAPTATIONS;
  return Math.min(value, MAX_GOVERNANCE_ADAPTATIONS);
}

function progressOf(plan) {
  const progress = { completed: 0, failed: 0, uncertain: 0, skipped: 0, pending: 0 };
  for (const step of plan.steps ?? []) {
    const status = plan.stepResults?.[step.id]?.status ?? null;
    if (status === 'completed') progress.completed += 1;
    else if (status === 'failed') progress.failed += 1;
    else if (status === 'uncertain') progress.uncertain += 1;
    else if (status === 'skipped') progress.skipped += 1;
    else progress.pending += 1;
  }
  return progress;
}

// An assessment entry keeps its bindings but not an id of its own: the reducer projects it from the
// audit-backed event, and the event id is not part of the projection. The review therefore cites a
// deterministic reference derived from what the assessment actually binds to, so two assessments of
// the same plan stay distinguishable and a withdrawn one is a reference change, not a new verdict.
function assessmentRefOf(planId, assessment) {
  return createHash('sha256')
    .update(`${planId}\u0000${assessment.at ?? ''}\u0000${assessment.planVersion ?? ''}\u0000${assessment.verdict ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

// A plan reference is read from the plan store, not from the report row: the row states counts, and a
// review must cite the assessment records themselves so a later correction is a reference change and
// not a silently different count.
function planRefFromPlan(plan) {
  const currentHash = planContentHash(plan);
  const all = Array.isArray(plan.assessments) ? plan.assessments : [];
  const assessments = all
    .filter((a) => a && typeof a.verdict === 'string')
    .map((a) => ({
      assessmentId: assessmentRefOf(plan.id, a),
      planVersion: Number.isInteger(a.planVersion) ? a.planVersion : null,
      contentHash: typeof a.contentHash === 'string' ? a.contentHash : null,
      verdict: a.verdict,
      stale: !(a.planVersion === plan.version && a.contentHash === currentHash),
    }))
    .sort((a, b) => a.assessmentId.localeCompare(b.assessmentId))
    .slice(0, MAX_REVIEW_REFS);
  return {
    planId: plan.id,
    status: plan.status,
    version: Number.isInteger(plan.version) ? plan.version : 0,
    contentHash: currentHash,
    goalId: plan.goalId ?? null,
    taskId: plan.activation?.taskId ?? null,
    stepStatuses: progressOf(plan),
    assessments,
  };
}

function useRefFromRow(use) {
  const outcome = use.outcome ?? {};
  const evidence = outcome.evidence ?? {};
  const decision = use.decision ?? {};
  return {
    operationId: use.operationId ?? null,
    decidedAt: use.decidedAt ?? null,
    via: use.via ?? null,
    attribution: use.attribution,
    ruleVersion: Number.isInteger(use.ruleVersion) ? use.ruleVersion : null,
    planId: use.planId ?? null,
    planStatus: use.planStatus ?? outcome.planStatus ?? null,
    applied: decision.applied === true,
    changed: decision.changed === true,
    beforeLeading: decision.before?.leading ?? null,
    afterLeading: decision.after?.leading ?? null,
    outcome: {
      state: outcome.state ?? 'unavailable',
      kind: outcome.kind ?? null,
      source: outcome.source ?? null,
      verdict: outcome.verdict ?? null,
      planVersion: Number.isInteger(outcome.planVersion) ? outcome.planVersion : null,
      contentHash: typeof outcome.contentHash === 'string' ? outcome.contentHash : null,
      taskId: outcome.taskId ?? null,
      stepStatuses: outcome.steps ?? {},
      assessments: evidence.assessments ?? 0,
      staleAssessments: evidence.staleAssessments ?? 0,
      verdicts: Array.isArray(evidence.verdicts) ? evidence.verdicts : [],
      operations: Array.isArray(evidence.operations) ? evidence.operations : [],
      derived: evidence.derived === true,
      derivedVerdict: evidence.derivedVerdict ?? null,
      derivedError: evidence.derivedError ?? null,
    },
  };
}

function patternRefFromAdaptation(adaptation) {
  const pattern = adaptation.pattern;
  if (!pattern || typeof pattern !== 'object' || typeof pattern.kind !== 'string') return null;
  return {
    kind: pattern.kind,
    observations: Number.isInteger(pattern.observations) ? pattern.observations : 0,
    since: pattern.window?.since ?? null,
    until: pattern.window?.until ?? null,
    calibration: {
      available: pattern.calibration?.available === true,
      denominator: Number.isInteger(pattern.calibration?.denominator) ? pattern.calibration.denominator : 0,
      requiredForRate: Number.isInteger(pattern.calibration?.requiredForRate) ? pattern.calibration.requiredForRate : 1,
    },
  };
}

// The evidence digest the review records for its report, kept beside the canonical bundle digest. It
// covers the row this review was opened on, so a later reconciliation can say whether the report
// itself moved even when every item the review cites is identical.
function reportDigestOf({ adaptationId, row, report }) {
  return digestOf({
    schema: 'apex.review-report.v1',
    adaptationId,
    available: report.available === true,
    classification: row.classification ?? null,
    summary: row.summary ?? null,
    recommendation: row.recommendation ?? null,
    lifecycle: row.lifecycle ?? null,
    version: row.version ?? null,
    supportState: row.supportState ?? null,
    supportProblems: row.supportProblems ?? [],
    uses: row.uses ?? [],
    usesTruncated: row.usesTruncated === true,
    readings: row.readings ?? null,
  });
}

// One shared read per label inside a snapshot; without a snapshot the read simply happens.
function sharedRead(snapshot, label, fn) {
  return snapshot ? snapshot.read(label, fn) : fn();
}

// What a reader may know about how the window was established, without the identity internals.
function snapshotView(verdict) {
  if (!verdict) return null;
  return {
    schema: verdict.schema,
    state: verdict.state,
    consistent: verdict.consistent === true,
    complete: verdict.complete === true,
    stores: verdict.stores ?? [],
    reads: verdict.reads ?? 0,
    digest: verdict.digest ?? null,
    beginDigest: verdict.beginDigest ?? null,
    bounded: verdict.bounded === true,
    note: verdict.note ?? null,
  };
}

// A projection that cannot be read is recorded as `unreadable` rather than as an older status: the
// ledger did not say what became of it.
async function predictionRefsFor(adaptation, predictions, snapshot = null) {
  const cited = [...new Set((adaptation.support?.predictionIds ?? []).map(String))].sort();
  const truncated = cited.length > MAX_REVIEW_REFS;
  const wanted = cited.slice(0, MAX_REVIEW_REFS);
  if (wanted.length === 0) return { refs: [], truncated };
  let answered = null;
  if (predictions && typeof predictions.details === 'function') {
    try {
      answered = await sharedRead(snapshot, `predictions:details:${wanted.join(',')}`, () => predictions.details(wanted));
    } catch {
      answered = null;
    }
  }
  const refs = wanted.map((predictionId) => {
    const projection = answered?.get(predictionId)?.projection ?? null;
    if (!projection) {
      return { predictionId, evaluationId: null, status: 'unreadable', verdict: null, current: false };
    }
    const current = projection.invalidation === null
      && (projection.supersededBy ?? []).length === 0
      && projection.retired !== true
      && projection.status !== 'expired'
      && projection.evaluationStale !== true;
    return {
      predictionId,
      evaluationId: projection.evaluation?.id ?? null,
      status: projection.status,
      verdict: projection.evaluation?.verdict ?? null,
      current,
    };
  });
  return { refs, truncated };
}

// Resolve every goal a cited plan names. A goal that is absent, or a goal store that is not attached,
// is recorded as a goal reference with no state - not guessed, and not dropped, because dropping it
// would make the evidence look like no plan named a goal.
async function goalRefsFor(plans, goals, cache, snapshot = null) {
  const ids = [...new Set(plans.map((p) => p.goalId).filter((id) => typeof id === 'string'))].sort();
  const refs = [];
  for (const goalId of ids.slice(0, MAX_REVIEW_REFS)) {
    if (!cache.has(goalId)) {
      let goal = null;
      if (goals && typeof goals.get === 'function') {
        try {
          goal = await sharedRead(snapshot, `goals:get:${goalId}`, () => goals.get(goalId));
        } catch {
          goal = null;
        }
      }
      cache.set(goalId, goal);
    }
    const goal = cache.get(goalId);
    refs.push({
      goalId,
      status: goal?.status ?? null,
      revision: Number.isInteger(goal?.revision) ? goal.revision : null,
    });
  }
  return refs;
}

// Assemble the canonical evidence bundle for one adaptation from the report row that describes it and
// the stores the row was read from. Every list is bounded and sorted by the canonicaliser.
async function buildEvidence({ experience, plans, goals, predictions, adaptation, row, report, goalCache = new Map(), snapshot = null }) {
  const supportExperiences = [...new Set((adaptation.support?.experienceIds ?? []).map(String))];
  const supportFeedback = [...new Set((adaptation.support?.feedbackIds ?? []).map(String))];
  const supportTruncated = supportExperiences.length > MAX_REVIEW_REFS || supportFeedback.length > MAX_REVIEW_REFS;
  const citedExperiences = supportExperiences.slice(0, MAX_REVIEW_REFS);
  const citedFeedback = supportFeedback.slice(0, MAX_REVIEW_REFS);
  const states = await sharedRead(
    snapshot,
    `experience:supportStates:${[...citedExperiences].sort().join(',')}:${[...citedFeedback].sort().join(',')}`,
    () => experience.supportStates({ experienceIds: citedExperiences, feedbackIds: citedFeedback }),
  );

  const uses = (row.uses ?? []).slice(0, MAX_REVIEW_REFS).map(useRefFromRow);
  const planMap = plans instanceof Map ? plans : new Map();
  const citedPlans = [...new Set(uses.map((u) => u.planId).filter((id) => typeof id === 'string'))].sort();
  const planRefs = citedPlans
    .map((id) => planMap.get(id))
    .filter(Boolean)
    .slice(0, MAX_REVIEW_REFS)
    .map(planRefFromPlan);
  const goalRefs = await goalRefsFor(planRefs, goals, goalCache, snapshot);
  const prediction = await predictionRefsFor(adaptation, predictions, snapshot);

  return canonicalReviewEvidence({
    targetId: adaptation.id,
    capability: adaptation.capability,
    rule: {
      text: adaptation.rule,
      hash: adaptation.ruleHash,
      version: adaptation.shapeVersion ?? null,
      shape: adaptation.guidance ? {
        source: adaptation.guidance.source ?? null,
        order: adaptation.guidance.order ?? null,
        avoid: adaptation.guidance.avoid ?? [],
        prefer: adaptation.guidance.prefer ?? [],
        maxSteps: adaptation.guidance.maxSteps ?? null,
      } : null,
    },
    adaptation: {
      decisionState: adaptation.decisionState,
      active: adaptation.active === true,
      retired: adaptation.retired === true,
      supportState: adaptation.supportState ?? null,
      source: adaptation.source ?? null,
      basis: adaptation.basis ?? null,
      conflictIds: (adaptation.conflicts ?? []).map((c) => c.id),
    },
    report: {
      available: report.available === true,
      state: row.classification?.state ?? null,
      stateWhy: row.classification?.why ?? null,
      summaryKind: row.summary?.kind ?? null,
      summaryStatement: row.summary?.statement ?? null,
      recommendation: row.recommendation?.kind ?? 'none',
      recommendationWhy: row.recommendation?.why ?? null,
      observations: row.summary?.observations ?? {},
    },
    support: {
      experienceIds: states.presentExperienceIds,
      feedbackIds: states.presentFeedbackIds,
      missingExperienceIds: states.missingExperienceIds,
      missingFeedbackIds: states.missingFeedbackIds,
      retiredExperienceIds: states.retiredExperienceIds,
      retiredFeedbackIds: states.retiredFeedbackIds,
    },
    predictions: prediction.refs,
    pattern: patternRefFromAdaptation(adaptation),
    uses,
    plans: planRefs,
    goals: goalRefs,
    bounds: {
      truncated: supportTruncated
        || prediction.truncated
        || row.usesTruncated === true
        || report.reads?.auditTruncated === true
        || report.totals?.truncatedUses === true,
      limit: MAX_REVIEW_REFS,
    },
  });
}

async function planMapOf(plans, snapshot = null) {
  if (!plans || typeof plans.load !== 'function') {
    throw new StoreError('the plan store is not available in this configuration; no review evidence can be assembled');
  }
  const read = await sharedRead(snapshot, 'plans:load', () => plans.load());
  return read.plans instanceof Map
    ? read.plans
    : new Map((read.plans ?? []).map((p) => [p.id, p]));
}

// The one read that turns a target into the exact evidence a review would cite, plus the report row it
// came from. Target-scoped on purpose: a review's evidence must describe its own adaptation, not the
// bounded window a list read happened to return. Inside a shared snapshot the adaptation, the plan
// ledger, and every goal are read once for the whole operation rather than once per target.
async function prepareTarget({
  experience, plans, operations, goals, knowledge, memory, predictions, now, target, snapshot = null,
}) {
  const ref = typeof target === 'string' ? target.trim() : '';
  if (ref.length === 0) throw new ValidationError('a review needs an adaptation reference');
  const adaptation = await sharedRead(snapshot, `experience:adaptation:${ref}`, () => experience.adaptationDetail(ref));
  if (!adaptation) throw new ValidationError(`no adaptation matches "${singleLine(ref, 40)}"`);
  const { report } = await analyzeEffectivenessWithSnapshot({
    experience,
    plans,
    operations,
    goals,
    knowledge,
    memory,
    now,
    target: adaptation.id,
    limit: 1,
    snapshot,
  });
  if (report.available !== true) {
    return { adaptation, report, row: null, evidence: null, reportDigest: null };
  }
  const row = (report.adaptations ?? []).find((r) => r.id === adaptation.id) ?? null;
  if (!row) return { adaptation, report, row: null, evidence: null, reportDigest: null };
  const planMap = await planMapOf(plans, snapshot);
  const evidence = await buildEvidence({
    experience, plans: planMap, goals, predictions, adaptation, row, report, snapshot,
  });
  return { adaptation, report, row, evidence, reportDigest: reportDigestOf({ adaptationId: adaptation.id, row, report }) };
}

// The current review for one adaptation: the newest review no later review supersedes. Older reviews
// stay readable as history and are never rewritten.
function currentReviewOf(reviews) {
  return (reviews ?? []).find((r) => (r.supersededBy ?? []).length === 0) ?? null;
}

function reviewSummary(review) {
  return {
    id: review.id,
    targetId: review.targetId,
    createdAt: review.createdAt,
    recommendation: review.recommendation,
    evidenceDigest: review.evidenceDigest,
    reportDigest: review.reportDigest ?? null,
    reason: review.reason ?? null,
    awaitingEvidence: review.awaitingEvidence === true,
    origin: review.provenance?.origin ?? null,
    decision: review.decision ? { ...review.decision } : null,
    decisionCount: review.decisionCount ?? 0,
    supersededBy: [...(review.supersededBy ?? [])],
    current: review.current === true,
  };
}

// Classify one review against the live evidence. `unavailable` reports a read that could not establish
// the evidence at all; `diff` is the reconciliation when it could.
function stateOf(review, diff, recommendation, unavailable = null) {
  return classifyReviewState({
    recommendation,
    review,
    diff,
    unavailable,
  });
}

function reconciliationSummary(diff) {
  if (!diff) return null;
  return {
    state: diff.state,
    changed: diff.changed === true,
    current: diff.current === true,
    kinds: [...diff.kinds],
    counts: { ...diff.counts },
    changes: diff.changes.slice(0, MAX_REVIEW_CHANGES).map((c) => ({ ...c })),
    evidenceDigest: diff.evidenceDigest,
    storedDigest: diff.storedDigest,
    reportChanged: diff.reportChanged === true,
    rule: { ...diff.rule },
    conflict: diff.conflict === true,
    why: diff.why,
  };
}

// Reconcile one stored review against freshly assembled evidence. An evidence bundle that cannot be
// read is reported as unreadable; it is never treated as an unchanged or empty bundle.
function reconcile(stored, current, storedReportDigest, currentReportDigest, unreadable = null) {
  if (unreadable) {
    return reconcileReviewEvidence({ unreadable });
  }
  return reconcileReviewEvidence({
    stored: stored.evidence,
    current,
    storedReportDigest,
    currentReportDigest,
  });
}

function requireStores({ experience, operations }) {
  if (!experience || typeof experience.adaptationDetail !== 'function') {
    return 'the experience store is not available in this configuration';
  }
  if (!operations || typeof operations.inspect !== 'function') {
    return 'the audit log is not available in this configuration';
  }
  return null;
}

function unavailableReport(reason, generatedAt, scope) {
  const report = {
    schema: GOVERNANCE_SCHEMA,
    available: false,
    reason,
    generatedAt,
    scope,
    adaptations: [],
    totals: null,
    authorizes: false,
    note: GOVERNANCE_NOTE,
  };
  report.digest = digestOf({ schema: report.schema, available: false, reason, adaptations: [] });
  return report;
}

// The list read: for each bounded adaptation, the live recommendation and the state of its current
// review. A review's evidence is assembled only when a review exists; an unreviewed adaptation costs
// the recommendation it is shown with and nothing more. Everything here runs inside one snapshot, so
// the effectiveness rows, the review history, and every review's live evidence describe the same
// instant rather than a sequence of separately consistent reads.
async function governanceReportWithin({
  experience,
  plans,
  operations,
  goals = null,
  knowledge = null,
  memory = null,
  predictions = null,
  now = () => new Date(),
  limit = MAX_GOVERNANCE_ADAPTATIONS,
  snapshot = null,
} = {}) {
  const generatedAt = now().toISOString();
  const size = limitValue(limit);
  const scope = { target: null, limit: size };
  const missing = requireStores({ experience, operations });
  if (missing) return { report: unavailableReport(missing, generatedAt, scope), diagnostics: null };

  const { report } = await analyzeEffectivenessWithSnapshot({
    experience, plans, operations, goals, knowledge, memory, now, limit: size, snapshot,
  });
  if (report.available !== true) {
    return { report: unavailableReport(report.reason ?? 'the effectiveness report is unavailable', generatedAt, scope), diagnostics: null };
  }

  let reviews;
  try {
    reviews = (await sharedRead(snapshot, 'experience:reviews:current', () => experience.reviews({ limit: MAX_REVIEW_HISTORY * 2 }))).reviews;
  } catch (err) {
    throw new StoreError(`the review history could not be read: ${err?.message ?? String(err)}`);
  }
  const byTarget = new Map();
  for (const review of reviews) {
    if ((review.supersededBy ?? []).length > 0) continue;
    if (!byTarget.has(review.targetId)) byTarget.set(review.targetId, review);
  }

  const rows = [];
  const findings = [];
  const counts = Object.fromEntries(REVIEW_STATES.map((state) => [state, 0]));
  let requiringReview = 0;
  for (const row of report.adaptations.slice(0, size)) {
    const review = byTarget.get(row.id) ?? null;
    let diff = null;
    let unavailable = null;
    let targetRow = row;
    let targetReport = report;
    if (review) {
      try {
        const prepared = await prepareTarget({
          experience, plans, operations, goals, knowledge, memory, predictions, now, target: row.id, snapshot,
        });
        if (prepared.evidence) {
          targetRow = prepared.row ?? row;
          targetReport = prepared.report;
          diff = reconcile(review, prepared.evidence, review.reportDigest, null);
        } else {
          unavailable = targetReport.reason ?? 'the effectiveness report is unavailable';
        }
      } catch (err) {
        if (err instanceof StoreError) {
          unavailable = err.message;
        } else {
          throw err;
        }
      }
    }
    const recommendation = targetRow.recommendation?.kind ?? 'none';
    const reviewState = stateOf(review, diff, recommendation, unavailable);
    counts[reviewState.state] = (counts[reviewState.state] ?? 0) + 1;
    const requiresReview = recommendation !== 'none'
      || reviewState.state === 'review_opened'
      || reviewState.state === 'review_awaiting_evidence'
      || reviewState.state === 'review_evidence_changed';
    if (requiresReview) requiringReview += 1;
    if (unavailable) {
      findings.push(integrityFinding('unverifiable', {
        check: 'review_evidence', subject: row.id, detail: unavailable,
      }));
    }
    if (diff) {
      for (const change of diff.changes ?? []) {
        const state = REVIEW_CHANGE_STATES[change.kind] ?? null;
        if (!state) continue;
        findings.push(integrityFinding(state, {
          check: `review_${change.kind}`, subject: change.id ?? row.id, from: review.id, detail: change.detail,
        }));
      }
      if (diff.reportChanged === true) {
        findings.push(integrityFinding('stale', {
          check: 'report_digest', subject: row.id, from: review.id,
          detail: 'the effectiveness report digest changed after the review was opened',
        }));
      }
    }
    rows.push({
      id: row.id,
      capability: row.capability,
      rule: row.rule,
      ruleHash: row.ruleHash ?? null,
      version: row.version ?? null,
      decisionState: row.decisionState,
      active: row.active === true,
      retired: row.retired === true,
      supportState: row.supportState ?? null,
      recommendation: targetRow.recommendation ?? { kind: 'none', why: null, authorizes: false },
      classification: targetRow.classification ?? null,
      review: review ? reviewSummary(review) : null,
      reviewState: reviewState.state,
      reviewStateWhy: reviewState.why,
      reviewCurrent: reviewState.current === true,
      awaitingEvidence: review?.awaitingEvidence === true,
      reconciliation: reconciliationSummary(diff),
      unavailable,
      requiresReview,
    });
  }
  const truncatedSources = [];
  if (report.reads?.auditTruncated === true) truncatedSources.push('audit');
  if (report.totals?.truncatedUses === true) truncatedSources.push('uses');
  if (report.integrity?.truncated === true) truncatedSources.push('effectiveness-findings');
  if (reviews.length >= MAX_REVIEW_HISTORY * 2) truncatedSources.push('reviews');
  const out = {
    schema: GOVERNANCE_SCHEMA,
    available: true,
    reason: report.reason ?? null,
    generatedAt,
    scope,
    adaptations: rows,
    totals: {
      adaptations: rows.length,
      requiringReview,
      states: counts,
      reviews: reviews.length,
      truncated: report.adaptations.length > rows.length,
    },
    snapshot: snapshot ? snapshot.summary() : null,
    integrity: integrityReport({
      subject: 'adaptation-governance',
      findings,
      truncated: truncatedSources.length > 0,
      truncatedSources,
      counts: { adaptations: rows.length, reviews: reviews.length, requiringReview },
      snapshot: snapshot ? snapshot.summary() : null,
      generatedAt,
    }),
    authorizes: false,
    note: GOVERNANCE_NOTE,
  };
  out.digest = reportHashOf(out);
  return { report: out, diagnostics: { findings, truncatedSources } };
}

// Which reconciliation change is an integrity condition, and which is simply a later record. `added`
// is not a fault, and `superseded` is the lifecycle working as recorded; neither is a finding.
const REVIEW_CHANGE_STATES = Object.freeze({
  withdrawn: 'broken_reference',
  missing: 'missing',
  stale: 'stale',
  conflicting: 'conflicting',
  unreadable: 'unverifiable',
});

// The public list read. One snapshot spans the effectiveness analysis, the review history and every
// review's live evidence; a writer seen inside the window is retried at most twice more, and a read
// that still cannot be certified is refused rather than reported as a result.
export async function governanceReport({
  experience,
  plans,
  operations,
  goals = null,
  knowledge = null,
  memory = null,
  predictions = null,
  now = () => new Date(),
  limit = MAX_GOVERNANCE_ADAPTATIONS,
  snapshot = null,
  attempts = DEFAULT_SNAPSHOT_ATTEMPTS,
} = {}) {
  const input = { experience, plans, operations, goals, knowledge, memory, predictions, now, limit };
  if (snapshot) return (await governanceReportWithin({ ...input, snapshot })).report;
  const stores = contributingStores({ experience, plans, operations, goals, knowledge, memory, predictions });
  if (stores.length === 0) return (await governanceReportWithin(input)).report;
  const generatedAt = now().toISOString();
  const scope = { target: null, limit: limitValue(limit) };
  const run = await runConsistentEvidenceRead({
    stores,
    attempts,
    read: (view) => governanceReportWithin({ ...input, snapshot: view }),
  });
  const { report, diagnostics } = run.value;
  const verdict = run.snapshot;
  if (verdict.state !== 'consistent') {
    const refused = unavailableReport(
      verdict.state === 'unverifiable'
        ? 'a contributing store could not be inspected while the governance read was in progress, so no consistent report can be stated'
        : `the stores changed while the governance read was in progress${run.attempts > 1 ? ` (retried ${run.attempts - 1} time(s))` : ''}; no report is stated for a combination that did not exist at one instant`,
      generatedAt,
      scope,
    );
    refused.state = verdict.state;
    refused.attempts = run.attempts;
    refused.snapshot = snapshotView(verdict);
    refused.integrity = integrityReport({ subject: 'adaptation-governance', snapshot: verdict, generatedAt });
    return refused;
  }
  report.snapshot = snapshotView(verdict);
  report.integrity = integrityReport({
    subject: 'adaptation-governance',
    findings: diagnostics?.findings ?? [],
    truncated: (diagnostics?.truncatedSources ?? []).length > 0,
    truncatedSources: diagnostics?.truncatedSources ?? [],
    counts: report.integrity?.counts ?? {},
    snapshot: verdict,
    generatedAt,
  });
  report.digest = reportHashOf(report);
  return report;
}

// One review or one adaptation's governance detail: the current review, its decision, the live
// reconciliation of every item it cites, and the review history the adaptation still holds. The review
// lookup, the adaptation, the review history and the live bundle are read inside one snapshot.
async function governanceDetailWithin({
  experience,
  plans,
  operations,
  goals = null,
  knowledge = null,
  memory = null,
  predictions = null,
  now = () => new Date(),
  target,
  snapshot = null,
} = {}) {
  const generatedAt = now().toISOString();
  const missing = requireStores({ experience, operations });
  if (missing) {
    return { report: { schema: GOVERNANCE_SCHEMA, available: false, reason: missing, generatedAt, authorizes: false, note: GOVERNANCE_NOTE }, diagnostics: null };
  }
  const ref = typeof target === 'string' ? target.trim() : '';
  if (ref.length === 0) throw new ValidationError('a review or adaptation reference is required');

  let review = null;
  const byReview = await sharedRead(snapshot, `experience:review:${ref}`, () => experience.reviewDetail(ref));
  if (byReview) {
    review = byReview.review;
    if (!byReview.adaptation) {
      throw new StoreError(`review [${shortId(review.id)}] names an adaptation that is not in the store`);
    }
  } else if (!(await sharedRead(snapshot, `experience:adaptation:${ref}`, () => experience.adaptationDetail(ref)))) {
    throw new ValidationError(`no review or adaptation matches "${singleLine(ref, 40)}"`);
  }

  const prepared = await prepareTarget({
    experience, plans, operations, goals, knowledge, memory, predictions, now,
    target: byReview?.adaptation?.id ?? ref, snapshot,
  });
  const adaptation = prepared.adaptation;
  const history = await sharedRead(
    snapshot,
    `experience:reviews:${adaptation.id}`,
    () => experience.reviews({ target: adaptation.id, limit: MAX_REVIEW_HISTORY }),
  );
  if (!review) review = currentReviewOf(history.reviews);
  const recommendation = prepared.row?.recommendation?.kind ?? 'none';
  let diff = null;
  let unavailable = null;
  if (prepared.evidence) {
    if (review) diff = reconcile(review, prepared.evidence, review.reportDigest, prepared.reportDigest);
  } else {
    unavailable = prepared.report?.reason ?? 'the effectiveness report is unavailable';
  }
  const reviewState = stateOf(review, diff, recommendation, unavailable);

  const findings = [];
  if (unavailable) {
    findings.push(integrityFinding('unverifiable', { check: 'review_evidence', subject: adaptation.id, detail: unavailable }));
  }
  for (const change of diff?.changes ?? []) {
    const state = REVIEW_CHANGE_STATES[change.kind] ?? null;
    if (!state) continue;
    findings.push(integrityFinding(state, {
      check: `review_${change.kind}`, subject: change.id ?? adaptation.id, from: review?.id ?? null, detail: change.detail,
    }));
  }
  if (diff?.reportChanged === true && review) {
    findings.push(integrityFinding('stale', {
      check: 'report_digest', subject: adaptation.id, from: review.id,
      detail: 'the effectiveness report digest changed after the review was opened',
    }));
  }

  const historyRows = history.reviews.map((item) => ({
    id: item.id,
    createdAt: item.createdAt,
    recommendation: item.recommendation,
    decision: item.decision ? { decision: item.decision.decision, at: item.decision.createdAt, reason: item.decision.reason ?? null } : null,
    superseded: (item.supersededBy ?? []).length > 0,
    supersededBy: [...(item.supersededBy ?? [])],
    awaitingEvidence: item.awaitingEvidence === true,
    current: item.current === true,
  }));

  const out = {
    schema: GOVERNANCE_SCHEMA,
    available: true,
    reason: null,
    generatedAt,
    adaptation: {
      id: adaptation.id,
      capability: adaptation.capability,
      rule: adaptation.rule,
      ruleHash: adaptation.ruleHash ?? null,
      version: adaptation.shapeVersion ?? null,
      decisionState: adaptation.decisionState,
      active: adaptation.active === true,
      retired: adaptation.retired === true,
      supportState: adaptation.supportState ?? null,
      source: adaptation.source ?? null,
      basis: adaptation.basis ?? null,
      shapeSource: adaptation.shapeSource ?? null,
    },
    report: prepared.row ? {
      digest: prepared.reportDigest,
      recommendation: prepared.row.recommendation,
      classification: prepared.row.classification,
      summary: prepared.row.summary,
      usesTruncated: prepared.row.usesTruncated === true,
      readings: prepared.row.readings,
    } : { digest: null, recommendation: { kind: 'none', why: prepared.report?.reason ?? null, authorizes: false }, classification: null, summary: null, usesTruncated: false, readings: null },
    review: review ? reviewSummary(review) : null,
    reviewState: reviewState.state,
    reviewStateWhy: reviewState.why,
    reviewCurrent: reviewState.current === true,
    awaitingEvidence: reviewState.state === 'review_awaiting_evidence',
    reconciliation: reconciliationSummary(diff),
    unavailable,
    snapshot: snapshot ? snapshot.summary() : null,
    integrity: integrityReport({
      subject: `adaptation-review:${adaptation.id}`,
      findings,
      truncated: history.truncated === true || prepared.row?.usesTruncated === true,
      truncatedSources: [
        ...(history.truncated === true ? ['review-history'] : []),
        ...(prepared.row?.usesTruncated === true ? ['uses'] : []),
      ],
      counts: { reviews: history.reviews.length, changes: diff?.changes?.length ?? 0 },
      snapshot: snapshot ? snapshot.summary() : null,
      generatedAt,
    }),
    history: historyRows,
    historyTruncated: history.truncated === true,
    authorizes: false,
    note: GOVERNANCE_NOTE,
  };
  out.digest = reportHashOf(out);
  return { report: out, diagnostics: { findings } };
}

// The public detail read, with the same consistency contract as the list: one window, bounded retry,
// explicit refusal rather than a report assembled from different instants.
export async function governanceDetail({
  experience,
  plans,
  operations,
  goals = null,
  knowledge = null,
  memory = null,
  predictions = null,
  now = () => new Date(),
  target,
  snapshot = null,
  attempts = DEFAULT_SNAPSHOT_ATTEMPTS,
} = {}) {
  const input = { experience, plans, operations, goals, knowledge, memory, predictions, now, target };
  if (snapshot) return (await governanceDetailWithin({ ...input, snapshot })).report;
  const stores = contributingStores({ experience, plans, operations, goals, knowledge, memory, predictions });
  if (stores.length === 0) return (await governanceDetailWithin(input)).report;
  const generatedAt = now().toISOString();
  const run = await runConsistentEvidenceRead({
    stores,
    attempts,
    read: (view) => governanceDetailWithin({ ...input, snapshot: view }),
  });
  const { report, diagnostics } = run.value;
  const verdict = run.snapshot;
  if (verdict.state !== 'consistent') {
    const refused = {
      schema: GOVERNANCE_SCHEMA,
      available: false,
      reason: verdict.state === 'unverifiable'
        ? 'a contributing store could not be inspected while the review was read, so no consistent detail can be stated'
        : `the stores changed while the review was read${run.attempts > 1 ? ` (retried ${run.attempts - 1} time(s))` : ''}; no detail is stated for a combination that did not exist at one instant`,
      state: verdict.state,
      attempts: run.attempts,
      generatedAt,
      snapshot: snapshotView(verdict),
      integrity: integrityReport({ subject: 'adaptation-review', snapshot: verdict, generatedAt }),
      authorizes: false,
      note: GOVERNANCE_NOTE,
    };
    return refused;
  }
  report.snapshot = snapshotView(verdict);
  report.integrity = integrityReport({
    subject: `adaptation-review:${report.adaptation?.id ?? 'unknown'}`,
    findings: diagnostics?.findings ?? [],
    truncated: report.historyTruncated === true || report.report?.usesTruncated === true,
    truncatedSources: [
      ...(report.historyTruncated === true ? ['review-history'] : []),
      ...(report.report?.usesTruncated === true ? ['uses'] : []),
    ],
    counts: {...(report.integrity?.counts ?? {})},
    snapshot: verdict,
    generatedAt,
  });
  report.digest = reportHashOf(report);
  return report;
}

// The exact bundle an open or decision will cite, together with the report row and recommendation it
// was read from. Actions use this so the record they write and the record they verify are assembled
// by one function; nothing here writes. The bundle is assembled inside its own consistency window: a
// write that lands mid-read is retried at most twice more, and a bundle that cannot be certified is
// refused, because a record must not cite evidence assembled from two different instants.
export async function prepareReview({
  experience,
  plans,
  operations,
  goals = null,
  knowledge = null,
  memory = null,
  predictions = null,
  now = () => new Date(),
  target,
  snapshot = null,
  attempts = DEFAULT_SNAPSHOT_ATTEMPTS,
} = {}) {
  const missing = requireStores({ experience, operations });
  if (missing) throw new ValidationError(missing);
  const input = { experience, plans, operations, goals, knowledge, memory, predictions, now, target };
  if (snapshot) return prepareTarget({ ...input, snapshot });
  const stores = contributingStores({ experience, plans, operations, goals, knowledge, memory, predictions });
  if (stores.length === 0) return prepareTarget(input);
  const run = await runConsistentEvidenceRead({
    stores,
    attempts,
    read: (view) => prepareTarget({ ...input, snapshot: view }),
  });
  const verdict = run.snapshot;
  if (verdict.state !== 'consistent') {
    throw new StoreError(
      verdict.state === 'unverifiable'
        ? 'a contributing store could not be inspected while the review evidence was assembled; no bundle is recorded from a read that cannot be verified'
        : `the stores changed while the review evidence was assembled${run.attempts > 1 ? ` (retried ${run.attempts - 1} time(s))` : ''}; no bundle is recorded for a combination of records that did not exist at one instant`,
    );
  }
  return { ...run.value, snapshot: snapshotView(verdict) };
}

// A reader-facing view of the nine states, so a display can explain a state without inventing prose.
const STATE_TEXT = Object.freeze({
  no_review_required: 'no review is required by the recorded evidence',
  review_recommended: 'the report recommends a review; opening one is your decision',
  review_opened: 'a review is open on evidence that is still current',
  review_awaiting_evidence: 'a review is open, but the evidence it would assess is not recorded yet',
  review_evidence_changed: 'the evidence changed after the review; reconcile before deciding',
  review_completed: 'you recorded a lifecycle decision and the evidence still supports it',
  review_dismissed: 'you dismissed the recommendation and kept the adaptation unchanged',
  review_decision_superseded: 'a later review replaced this one; it stays readable as history',
  review_unavailable: 'the evidence this review cites cannot be read now',
});

export function describeReviewState(state) {
  return STATE_TEXT[state] ?? 'unknown review state';
}

function countLine(counts) {
  return REVIEW_STATES
    .filter((state) => (counts?.[state] ?? 0) > 0)
    .map((state) => `${state} ${counts[state]}`)
    .join(', ');
}

export function renderGovernance(report, { indent = '' } = {}) {
  if (!report) return `${indent}No adaptation-governance report was produced.`;
  if (report.available === false) return `${indent}Adaptation governance unavailable: ${report.reason}`;
  const lines = [
    `${indent}Adaptation governance (${report.totals.adaptations} record(s) read; ${report.totals.requiringReview} need your attention):`,
  ];
  const states = countLine(report.totals.states);
  if (states) lines.push(`${indent}  states: ${states}`);
  if (report.adaptations.length === 0) {
    lines.push(`${indent}  ${report.reason ?? 'no adaptation record is stored, so there is nothing to review'}`);
  }
  for (const row of report.adaptations) {
    lines.push(`${indent}  [${shortId(row.id)}] ${row.capability} | ${row.decisionState}${row.retired ? ', retired' : ''} | ${row.reviewState}`);
    lines.push(`${indent}    rule: ${singleLine(row.rule, 200)}`);
    lines.push(`${indent}    review: ${describeReviewState(row.reviewState)}`);
    if (row.review) {
      lines.push(`${indent}    opened: [${shortId(row.review.id)}] ${row.review.createdAt}${row.review.reason ? ` - ${singleLine(row.review.reason, 200)}` : ''}`);
      if (row.review.decision) lines.push(`${indent}    decision: ${row.review.decision.decision}${row.review.decision.reason ? ` - ${singleLine(row.review.decision.reason, 200)}` : ''}`);
    }
    if (row.reconciliation) {
      const r = row.reconciliation;
      const kinds = r.kinds.length > 0 ? r.kinds.join(', ') : 'unchanged';
      lines.push(`${indent}    evidence: ${r.state} (${kinds})${r.reportChanged ? '; the report digest changed' : ''}`);
      for (const change of r.changes.slice(0, 5)) {
        lines.push(`${indent}      ${change.area}/${change.kind}: ${singleLine(change.detail, 220)}`);
      }
      if (r.changes.length > 5) lines.push(`${indent}      ... ${r.changes.length - 5} more change(s) omitted from this printed view`);
    }
    if (row.recommendation?.kind && row.recommendation.kind !== 'none') {
      lines.push(`${indent}    recommendation: ${row.recommendation.kind} - ${singleLine(row.recommendation.why ?? '', 260)} (it authorizes nothing)`);
    }
    if (row.unavailable) lines.push(`${indent}    unavailable: ${singleLine(row.unavailable, 300)}`);
  }
  lines.push(`${indent}  ${report.note}`);
  return lines.join('\n');
}

export function renderReview(detail, { indent = '' } = {}) {
  if (!detail) return `${indent}No review detail was produced.`;
  if (detail.available === false) return `${indent}Review detail unavailable: ${detail.reason}`;
  const a = detail.adaptation;
  const lines = [
    `${indent}Adaptation [${shortId(a.id)}] ${a.capability} | ${a.decisionState}${a.retired ? ', retired' : ''} | version ${a.version ?? 'none'}`,
    `${indent}  rule: ${singleLine(a.rule, 240)}`,
    `${indent}  review state: ${detail.reviewState} - ${describeReviewState(detail.reviewState)}`,
  ];
  if (detail.review) {
    const r = detail.review;
    lines.push(`${indent}  review [${shortId(r.id)}] opened ${r.createdAt}${r.reason ? ` - ${singleLine(r.reason, 220)}` : ''}`);
    lines.push(`${indent}  evidence digest: ${r.evidenceDigest.slice(0, 16)}...${r.reportDigest ? `; report digest: ${r.reportDigest.slice(0, 16)}...` : ''}`);
    if (r.decision) {
      lines.push(`${indent}  decision: ${r.decision.decision} at ${r.decision.createdAt}${r.decision.reason ? ` - ${singleLine(r.decision.reason, 220)}` : ''}`);
      lines.push(`${indent}  decided against evidence ${String(r.decision.reviewedEvidenceDigest ?? '').slice(0, 16)}...`);
      if (r.decision.retirementId) lines.push(`${indent}  retirement recorded: [${shortId(r.decision.retirementId)}] (through adaptation.retire)`);
    } else {
      lines.push(`${indent}  no decision is recorded; this review is open`);
    }
  } else {
    lines.push(`${indent}  no review has been opened for this adaptation`);
  }
  if (detail.reconciliation) {
    const d = detail.reconciliation;
    lines.push(`${indent}  evidence: ${d.state}${d.reportChanged ? ' (the report digest changed)' : ''} - ${singleLine(d.why, 300)}`);
    for (const change of d.changes.slice(0, 10)) {
      lines.push(`${indent}    ${change.area}/${change.kind}: ${singleLine(change.detail, 240)}`);
    }
    if (d.changes.length > 10) lines.push(`${indent}    ... ${d.changes.length - 10} more change(s) omitted from this printed view`);
  }
  if (detail.unavailable) lines.push(`${indent}  unavailable: ${singleLine(detail.unavailable, 300)}`);
  if (detail.history.length > 0) {
    lines.push(`${indent}  history (${detail.history.length}${detail.historyTruncated ? '+ truncated' : ''}):`);
    for (const item of detail.history.slice(0, 5)) {
      lines.push(`${indent}    [${shortId(item.id)}] ${item.createdAt} ${item.recommendation}${item.decision ? ` -> ${item.decision.decision}` : ' -> open'}${item.superseded ? ' (superseded)' : ''}`);
    }
  }
  lines.push(`${indent}  ${detail.note}`);
  return lines.join('\n');
}
