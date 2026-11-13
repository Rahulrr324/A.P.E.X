// Batch AP-05: the vocabulary and pure derivation for adaptation governance reviews.
//
// A review is a record that says: "on this evidence, the user opened a governance question about this
// adaptation". It is never a finding, an approval, or an instruction. The nine states below are the
// whole vocabulary a reader may use; every one of them is derived from records at read time, and no
// record stores a status.
//
// The evidence bundle a review carries is a bounded, canonical snapshot of what the effectiveness
// report cited: the adaptation and rule shape, the report's adaptation-specific classification, the
// support references, prediction/evaluation references, the uses (decision disclosures, plans,
// outcome assessments, execution and verification references), and the goal state each plan named.
// It contains identifiers, hashes and fixed vocabulary values - never request or output text.
//
// Reconciliation re-derives that bundle from the live stores and diffs the two canonical forms. A
// changed digest means the review needs reconciliation; it is never evidence that the adaptation
// became better or worse. Nothing here reads a store, writes a record, or decides anything.
import { sha256Hex } from '../memory/memory-store.js';
import { stableStringify } from '../tasks/model.js';
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS } from '../util.js';

export const REVIEW_KIND = 'adaptation_review';
export const REVIEW_DECISION_KIND = 'adaptation_review_decision';
export const REVIEW_EVIDENCE_SCHEMA = 'apex.review-evidence.v1';

// The closed vocabulary §3 requires. A reader that needs a tenth word must add it here, in one place,
// rather than inventing a prose status at a call site.
export const REVIEW_STATES = Object.freeze([
  'no_review_required',
  'review_recommended',
  'review_opened',
  'review_awaiting_evidence',
  'review_evidence_changed',
  'review_completed',
  'review_dismissed',
  'review_decision_superseded',
  'review_unavailable',
]);

// The user's own lifecycle decisions. Retirement is not a third mechanism: it is recorded through the
// same `adaptation_retirement` record the existing `adaptation.retire` path writes.
export const REVIEW_DECISIONS = Object.freeze(['keep_active', 'dismiss', 'retire']);

// How live evidence differs from what a review recorded. `added` is not an improvement; `withdrawn`,
// `superseded` and `missing` are not a failure; `conflicting` is not a verdict. The distinction is
// the message.
export const EVIDENCE_CHANGES = Object.freeze([
  'unchanged', 'added', 'withdrawn', 'superseded', 'stale', 'conflicting', 'missing', 'unreadable',
]);

export const MAX_REVIEW_REFS = 20;
export const MAX_REVIEW_TEXT = 500;
export const MAX_REVIEW_CHANGES = 40;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
// A reference is any bounded identifier the stores already record: an operation or task id, an action
// name (`plan.candidates`), a guidance capability (`task.create`), or a verdict (`awaiting_confirmation`).
// Dots and underscores are part of those vocabularies, so a pattern that excluded them would make a
// genuine captured bundle impossible to canonicalise.
const REF_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CAPABILITY_RE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;

const DECISION_STATES = new Set(['candidate', 'approved', 'rejected', 'retired', 'ambiguous']);
const SUPPORT_STATES = new Set(['intact', 'stale']);
const SOURCES = new Set(['feedback', 'prediction']);
const RECOMMENDATIONS = new Set(['none', 'review', 'consider_retirement']);
const USE_ATTRIBUTIONS = new Set([
  'adapted_unique', 'adapted_shared', 'declined', 'applied_not_changed', 'stale_rule_version',
  'applied_unlinked', 'goal_mismatch', 'plan_unbound', 'plan_content_changed', 'adapted_not_leading',
  'not_applicable',
]);
const OUTCOME_STATES = new Set(['evaluated', 'pending', 'not_executed', 'unavailable']);
const PATTERN_KINDS = new Set([
  'repeated_success', 'repeated_failure', 'alternating_outcomes',
  'consistent_improvement', 'consistent_regression', 'mixed_outcomes',
  'insufficient_evidence', 'conflicting_evidence',
]);
// `unreadable` is not a ledger status: it is what the governance reader records when the prediction
// store could not be read at all. Evidence that could not be read is not evidence of expiry.
const PREDICTION_STATUSES = new Set([
  'recorded', 'awaiting_evaluation', 'evaluated', 'expired', 'invalidated', 'superseded', 'unreadable',
]);

// Fields a stored record may not carry: the evidence is a snapshot, and a status, decision, or
// timestamp written beside it would be a second, editable copy of what the log already says.
const FORBIDDEN_REVIEW_FIELDS = Object.freeze([
  'state', 'status', 'decision', 'approved', 'retired', 'active', 'applies', 'applied', 'current',
]);

// A decision record names its own decision - that is the one field it is allowed to state - but every
// other status-shaped field is still a second editable copy of what the log already says.
const FORBIDDEN_DECISION_FIELDS = Object.freeze(
  FORBIDDEN_REVIEW_FIELDS.filter((field) => field !== 'decision'),
);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOrNull(value, max = MAX_REVIEW_TEXT) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('evidence text must be text');
  const t = value.trim();
  if (t.length === 0) return null;
  if (t.length > max) throw new ValidationError(`evidence text exceeds ${max} characters`);
  if (CONTROL_CHARS.test(t)) throw new ValidationError('evidence text contains control characters');
  return t;
}

function requiredText(value, max = MAX_REVIEW_TEXT) {
  const text = textOrNull(value, max);
  if (text === null) throw new ValidationError('evidence text is required');
  return text;
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new ValidationError(`${label} must be a record id`);
  return value.toLowerCase();
}

function uuidOrNull(value, label) {
  if (value === undefined || value === null) return null;
  return uuid(value, label);
}

function refOrNull(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a reference`);
  const ref = value.trim();
  if (!REF_RE.test(ref)) throw new ValidationError(`${label} is not a valid reference`);
  return ref;
}

function hashOrNull(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw new ValidationError(`${label} must be a sha256 digest`);
  return value.toLowerCase();
}

function intOrNull(value, label, { min = 0, max = 1000000 } = {}) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < min || value > max) throw new ValidationError(`${label} is out of range`);
  return value;
}

function bool(value, label) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new ValidationError(`${label} must be true or false`);
  return value;
}

function oneOf(value, allowed, label, { nullable = false } = {}) {
  if (value === undefined || value === null) {
    if (nullable) return null;
    throw new ValidationError(`${label} is required`);
  }
  if (typeof value !== 'string' || !allowed.has(value)) throw new ValidationError(`${label} has an unknown value`);
  return value;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function idList(values, label, { max = MAX_REVIEW_REFS } = {}) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new ValidationError(`${label} must be a list of record ids`);
  if (values.length > max) throw new ValidationError(`${label} may name at most ${max} records`);
  return sortedUnique(values.map((value) => uuid(value, label)));
}

function refList(values, label, { max = MAX_REVIEW_REFS } = {}) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new ValidationError(`${label} must be a list of references`);
  if (values.length > max) throw new ValidationError(`${label} may name at most ${max} references`);
  return sortedUnique(values.map((value) => refOrNull(value, label)).filter(Boolean));
}

function evidenceIdList(values, label) {
  return idList(values, label);
}

function stepStatuses(value) {
  const s = isObject(value) ? value : {};
  return {
    completed: intOrNull(s.completed, 'step count', { min: 0 }) ?? 0,
    failed: intOrNull(s.failed, 'step count', { min: 0 }) ?? 0,
    uncertain: intOrNull(s.uncertain, 'step count', { min: 0 }) ?? 0,
    skipped: intOrNull(s.skipped, 'step count', { min: 0 }) ?? 0,
    pending: intOrNull(s.pending, 'step count', { min: 0 }) ?? 0,
  };
}

function observations(value) {
  const o = isObject(value) ? value : {};
  const count = (name) => intOrNull(o[name], `observation count ${name}`, { min: 0 }) ?? 0;
  return {
    uses: count('uses'),
    evaluated: count('evaluated'),
    adapted: count('adapted'),
    baseline: count('baseline'),
    pending: count('pending'),
    excluded: count('excluded'),
  };
}

// One prediction/evaluation reference. `current` is a fact about the projection: an invalidated or
// superseded prediction, or an evaluation about older evidence, is not current evidence even though
// the reference still exists.
function predictionRef(value) {
  if (!isObject(value)) throw new ValidationError('a prediction reference must be an object');
  return {
    predictionId: uuid(value.predictionId, 'prediction id'),
    evaluationId: uuidOrNull(value.evaluationId, 'evaluation id'),
    status: oneOf(value.status, PREDICTION_STATUSES, 'prediction status'),
    verdict: textOrNull(value.verdict, 80),
    current: bool(value.current, 'prediction current'),
  };
}

// One recorded use: the decision disclosure, the plan it produced, and the outcome evidence that
// report attributed to it. `verdicts` and assessment counts are kept apart from the per-assessment
// references in `plans`, so a withdrawn assessment is visible as a reference change rather than as a
// silently different count.
function useRef(value) {
  if (!isObject(value)) throw new ValidationError('a use reference must be an object');
  const outcome = isObject(value.outcome) ? value.outcome : {};
  return {
    operationId: refOrNull(value.operationId, 'use operation id'),
    decidedAt: textOrNull(value.decidedAt, 40),
    via: refOrNull(value.via, 'use action'),
    attribution: oneOf(value.attribution, USE_ATTRIBUTIONS, 'use attribution'),
    ruleVersion: intOrNull(value.ruleVersion, 'use rule version'),
    planId: uuidOrNull(value.planId, 'plan id'),
    planStatus: textOrNull(value.planStatus, 40),
    applied: bool(value.applied, 'use applied'),
    changed: bool(value.changed, 'use changed'),
    beforeLeading: textOrNull(value.beforeLeading, 80),
    afterLeading: textOrNull(value.afterLeading, 80),
    outcome: {
      state: oneOf(outcome.state, OUTCOME_STATES, 'outcome state'),
      kind: textOrNull(outcome.kind, 60),
      source: textOrNull(outcome.source, 60),
      verdict: textOrNull(outcome.verdict, 60),
      planVersion: intOrNull(outcome.planVersion, 'plan version'),
      contentHash: hashOrNull(outcome.contentHash, 'plan content hash'),
      taskId: refOrNull(outcome.taskId, 'task id'),
      stepStatuses: stepStatuses(outcome.stepStatuses),
      assessments: intOrNull(outcome.assessments, 'assessment count', { min: 0 }) ?? 0,
      staleAssessments: intOrNull(outcome.staleAssessments, 'stale assessment count', { min: 0 }) ?? 0,
      verdicts: refList(outcome.verdicts, 'assessment verdicts'),
      operations: refList(outcome.operations, 'outcome operations'),
      derived: bool(outcome.derived, 'outcome derived'),
      derivedVerdict: textOrNull(outcome.derivedVerdict, 60),
      derivedError: textOrNull(outcome.derivedError, 240),
    },
  };
}

function assessmentRef(value) {
  if (!isObject(value)) throw new ValidationError('an assessment reference must be an object');
  return {
    assessmentId: refOrNull(value.assessmentId, 'assessment id'),
    planVersion: intOrNull(value.planVersion, 'assessment plan version'),
    contentHash: hashOrNull(value.contentHash, 'assessment content hash'),
    verdict: requiredText(value.verdict, 60),
    stale: bool(value.stale, 'assessment stale'),
  };
}

function planRef(value) {
  if (!isObject(value)) throw new ValidationError('a plan reference must be an object');
  const assessments = Array.isArray(value.assessments) ? value.assessments : [];
  if (assessments.length > MAX_REVIEW_REFS) throw new ValidationError(`a plan may cite at most ${MAX_REVIEW_REFS} assessments`);
  const refs = assessments.map(assessmentRef);
  const seen = new Set();
  for (const ref of refs) {
    const key = `${ref.assessmentId ?? ''}\u0000${ref.planVersion ?? ''}\u0000${ref.contentHash ?? ''}\u0000${ref.verdict}`;
    if (seen.has(key)) throw new ValidationError('a plan cites the same assessment twice');
    seen.add(key);
  }
  refs.sort((a, b) => String(a.assessmentId ?? '').localeCompare(String(b.assessmentId ?? ''))
    || String(a.planVersion ?? '').localeCompare(String(b.planVersion ?? ''))
    || String(a.verdict).localeCompare(String(b.verdict)));
  return {
    planId: uuid(value.planId, 'plan id'),
    status: requiredText(value.status, 40),
    version: intOrNull(value.version, 'plan version', { min: 0 }) ?? 0,
    contentHash: hashOrNull(value.contentHash, 'plan content hash'),
    goalId: uuidOrNull(value.goalId, 'goal id'),
    taskId: refOrNull(value.taskId, 'task id'),
    stepStatuses: stepStatuses(value.stepStatuses),
    assessments: refs,
  };
}

function goalRef(value) {
  if (!isObject(value)) throw new ValidationError('a goal reference must be an object');
  return {
    goalId: uuid(value.goalId, 'goal id'),
    status: textOrNull(value.status, 40),
    revision: intOrNull(value.revision, 'goal revision'),
  };
}

function patternRef(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new ValidationError('a pattern reference must be an object');
  const calibration = isObject(value.calibration) ? value.calibration : {};
  return {
    kind: oneOf(value.kind, PATTERN_KINDS, 'pattern kind'),
    observations: intOrNull(value.observations, 'pattern observations', { min: 0 }) ?? 0,
    since: textOrNull(value.since, 40),
    until: textOrNull(value.until, 40),
    calibration: {
      available: bool(calibration.available, 'calibration available'),
      denominator: intOrNull(calibration.denominator, 'calibration denominator', { min: 0 }) ?? 0,
      requiredForRate: intOrNull(calibration.requiredForRate, 'calibration floor', { min: 1 }) ?? 1,
    },
  };
}

// The canonical evidence bundle. Every caller - the store, the governance builder, a test - gets the
// same field order, the same bounds and the same refusals, so two bundles can be compared by digest
// without a normalisation step at the comparison.
export function canonicalReviewEvidence(input) {
  if (!isObject(input)) throw new ValidationError('review evidence must be an object');
  if (input.schema !== undefined && input.schema !== REVIEW_EVIDENCE_SCHEMA) {
    throw new ValidationError('review evidence has an unsupported schema');
  }
  const rule = isObject(input.rule) ? input.rule : {};
  const adaptation = isObject(input.adaptation) ? input.adaptation : {};
  const report = isObject(input.report) ? input.report : {};
  const support = isObject(input.support) ? input.support : {};
  const bounds = isObject(input.bounds) ? input.bounds : {};
  const capability = input.capability === null || input.capability === undefined
    ? null
    : requiredText(input.capability, 64);
  if (capability !== null && !CAPABILITY_RE.test(capability)) throw new ValidationError('capability is not a capability name');

  const predictions = Array.isArray(input.predictions) ? input.predictions.map(predictionRef) : [];
  const uses = Array.isArray(input.uses) ? input.uses.map(useRef) : [];
  const plans = Array.isArray(input.plans) ? input.plans.map(planRef) : [];
  const goals = Array.isArray(input.goals) ? input.goals.map(goalRef) : [];
  for (const [label, list] of [['predictions', predictions], ['uses', uses], ['plans', plans], ['goals', goals]]) {
    if (list.length > MAX_REVIEW_REFS) throw new ValidationError(`review evidence may cite at most ${MAX_REVIEW_REFS} ${label}`);
  }
  predictions.sort((a, b) => a.predictionId.localeCompare(b.predictionId));
  uses.sort((a, b) => String(a.operationId ?? '').localeCompare(String(b.operationId ?? '')));
  plans.sort((a, b) => a.planId.localeCompare(b.planId));
  goals.sort((a, b) => a.goalId.localeCompare(b.goalId));

  return {
    schema: REVIEW_EVIDENCE_SCHEMA,
    targetId: uuid(input.targetId, 'adaptation id'),
    capability,
    rule: {
      text: requiredText(rule.text, 300),
      hash: hashOrNull(rule.hash, 'rule hash') ?? (() => { throw new ValidationError('rule hash is required'); })(),
      version: intOrNull(rule.version, 'rule version', { min: 0 }),
      shape: rule.shape === null || rule.shape === undefined ? null : {
        source: textOrNull(rule.shape.source, 40),
        order: textOrNull(rule.shape.order, 40),
        avoid: refList(rule.shape.avoid, 'guidance avoid', { max: 4 }),
        prefer: refList(rule.shape.prefer, 'guidance prefer', { max: 4 }),
        maxSteps: intOrNull(rule.shape.maxSteps, 'guidance step bound', { min: 1, max: 8 }),
      },
    },
    adaptation: {
      decisionState: oneOf(adaptation.decisionState, DECISION_STATES, 'adaptation decision state'),
      active: bool(adaptation.active, 'adaptation active'),
      retired: bool(adaptation.retired, 'adaptation retired'),
      supportState: oneOf(adaptation.supportState, SUPPORT_STATES, 'support state', { nullable: true }),
      source: oneOf(adaptation.source, SOURCES, 'adaptation source', { nullable: true }),
      basis: textOrNull(adaptation.basis, 80),
      conflictIds: idList(adaptation.conflictIds, 'conflicting adaptations'),
    },
    report: {
      available: bool(report.available, 'report available'),
      state: textOrNull(report.state, 80),
      stateWhy: textOrNull(report.stateWhy, 400),
      summaryKind: textOrNull(report.summaryKind, 80),
      summaryStatement: textOrNull(report.summaryStatement, 400),
      recommendation: oneOf(report.recommendation, RECOMMENDATIONS, 'recommendation'),
      recommendationWhy: textOrNull(report.recommendationWhy, 400),
      observations: observations(report.observations),
    },
    support: {
      experienceIds: evidenceIdList(support.experienceIds, 'supporting experiences'),
      feedbackIds: evidenceIdList(support.feedbackIds, 'supporting feedback'),
      missingExperienceIds: evidenceIdList(support.missingExperienceIds, 'missing experiences'),
      missingFeedbackIds: evidenceIdList(support.missingFeedbackIds, 'missing feedback'),
      retiredExperienceIds: evidenceIdList(support.retiredExperienceIds, 'superseded experiences'),
      retiredFeedbackIds: evidenceIdList(support.retiredFeedbackIds, 'superseded feedback'),
    },
    predictions,
    pattern: patternRef(input.pattern),
    uses,
    plans,
    goals,
    bounds: {
      truncated: bool(bounds.truncated, 'truncated read'),
      limit: intOrNull(bounds.limit, 'evidence bound', { min: 1 }) ?? MAX_REVIEW_REFS,
    },
  };
}

export function reviewEvidenceDigest(evidence) {
  return sha256Hex(stableStringify(canonicalReviewEvidence(evidence)));
}

// A bundle's own consistency: the adaptation it names is the adaptation the review names, and the
// support lists do not claim an id twice under two different headings. These are claims inside one
// record, so a failure is damage rather than a change in the world.
export function evidenceProblem(evidence) {
  try {
    const canonical = canonicalReviewEvidence(evidence);
    if (stableStringify(canonical) !== stableStringify(evidence)) return 'review evidence is not in canonical form';
    const all = [
      ...canonical.support.experienceIds.map((id) => `e:${id}`),
      ...canonical.support.missingExperienceIds.map((id) => `e:${id}`),
      ...canonical.support.retiredExperienceIds.map((id) => `e:${id}`),
    ];
    if (new Set(all).size !== all.length) return 'review evidence names one experience under two states';
    const feedback = [
      ...canonical.support.feedbackIds.map((id) => `f:${id}`),
      ...canonical.support.missingFeedbackIds.map((id) => `f:${id}`),
      ...canonical.support.retiredFeedbackIds.map((id) => `f:${id}`),
    ];
    if (new Set(feedback).size !== feedback.length) return 'review evidence names one feedback record under two states';
    return null;
  } catch (err) {
    return err?.message ?? String(err);
  }
}

// A review is awaiting evidence when the report could not classify a single evaluated use of the
// current version. That is not "no review required": the user opened one, and the honest answer is
// that the evidence it would assess has not been recorded yet.
const AWAITING_STATES = new Set([
  'not_approved',
  'approved_never_applied',
  'applied_outcome_pending',
  'retired_before_evaluation',
  'applied_to_earlier_version',
]);

export function reviewAwaitingEvidence(evidence) {
  const e = canonicalReviewEvidence(evidence);
  if (!e.report.available) return true;
  if (AWAITING_STATES.has(e.report.state ?? '')) return true;
  return e.report.observations.evaluated === 0 || e.report.observations.adapted === 0;
}

export function reviewHasConflict(evidence) {
  const e = canonicalReviewEvidence(evidence);
  if (e.adaptation.conflictIds.length > 0) return true;
  if (e.report.summaryKind === 'conflicting_evidence') return true;
  if ((e.report.state ?? '').includes('conflicting')) return true;
  if (e.uses.some((u) => u.outcome.kind === 'conflicting_evidence' || u.outcome.verdicts.length > 1)) return true;
  return false;
}

// ---- reconciliation ---------------------------------------------------------

const CHANGE_RANK = Object.freeze({
  unchanged: 0,
  added: 1,
  stale: 2,
  conflicting: 3,
  withdrawn: 4,
  superseded: 5,
  missing: 6,
  unreadable: 7,
});

function note(changes, area, kind, detail, id = null) {
  if (kind === 'unchanged') return;
  if (changes.length >= MAX_REVIEW_CHANGES) return;
  changes.push({ area, kind, id, detail: String(detail).slice(0, 400) });
}

function sameJson(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function keyed(list, keyOf) {
  return new Map(list.map((item) => [keyOf(item), item]));
}

function diffKeyed({ stored, current, keyOf, area, changes, labelOf = (k) => k, onRemoved = 'withdrawn', onAdded = 'added', onChanged = null }) {
  const left = keyed(stored, keyOf);
  const right = keyed(current, keyOf);
  for (const key of left.keys()) {
    if (!right.has(key)) {
      note(changes, area, onRemoved, `${labelOf(key)} was part of the reviewed evidence and is no longer recorded`, key);
      continue;
    }
    if (!sameJson(left.get(key), right.get(key))) {
      const kind = onChanged ? onChanged(left.get(key), right.get(key)) : 'stale';
      note(changes, area, kind, `${labelOf(key)} changed after the review was opened`, key);
    }
  }
  for (const key of right.keys()) {
    if (!left.has(key)) note(changes, area, onAdded, `${labelOf(key)} was recorded after the review was opened`, key);
  }
}

function compareSets({ stored, current, area, changes, label, onRemoved = 'withdrawn' }) {
  const left = new Set(stored);
  const right = new Set(current);
  for (const id of left) {
    if (!right.has(id)) note(changes, area, onRemoved, `${label} ${id.slice(0, 8)} is no longer present`, id);
  }
  for (const id of right) {
    if (!left.has(id)) note(changes, area, 'added', `${label} ${id.slice(0, 8)} was recorded after the review was opened`, id);
  }
}

// Compare the evidence a review recorded with the evidence the live stores give now. The result names
// what changed; it does not say whether the change is good, bad, or an improvement. `reportDigest` is
// reported separately because it covers the whole report (including how many audit records were read)
// and can move while every item this review cites stays identical.
export function reconcileReviewEvidence({
  stored,
  current,
  storedReportDigest = null,
  currentReportDigest = null,
  unreadable = null,
} = {}) {
  if (unreadable) {
    return {
      state: 'unreadable',
      changed: false,
      current: false,
      kinds: ['unreadable'],
      changes: [{ area: 'read', kind: 'unreadable', id: null, detail: String(unreadable).slice(0, 400) }],
      counts: { added: 0, withdrawn: 0, superseded: 0, stale: 0, conflicting: 0, missing: 0, unreadable: 1 },
      evidenceDigest: null,
      storedDigest: null,
      reportChanged: false,
      rule: { changed: false, versionChanged: false, hashChanged: false, conflict: false },
      conflict: false,
      why: String(unreadable).slice(0, 400),
    };
  }
  let before;
  let after;
  try {
    before = canonicalReviewEvidence(stored);
    after = canonicalReviewEvidence(current);
  } catch (err) {
    const detail = `the evidence could not be read as a review bundle: ${err?.message ?? String(err)}`;
    return {
      state: 'unreadable',
      changed: false,
      current: false,
      kinds: ['unreadable'],
      changes: [{ area: 'evidence', kind: 'unreadable', id: null, detail }],
      counts: { added: 0, withdrawn: 0, superseded: 0, stale: 0, conflicting: 0, missing: 0, unreadable: 1 },
      evidenceDigest: null,
      storedDigest: null,
      reportChanged: false,
      rule: { changed: false, versionChanged: false, hashChanged: false, conflict: false },
      conflict: false,
      why: detail,
    };
  }

  const changes = [];
  const truncated = after.bounds.truncated === true;
  const storedDigest = sha256Hex(stableStringify(before));
  const evidenceDigest = sha256Hex(stableStringify(after));

  // The rule shape first: a version change and a hash change are different facts, and a hash change
  // at the same version is a conflict rather than an ordinary edit.
  const versionChanged = before.rule.version !== after.rule.version;
  const hashChanged = before.rule.hash !== after.rule.hash;
  const shapeChanged = !sameJson(before.rule.shape, after.rule.shape);
  if (versionChanged) note(changes, 'rule', 'stale', `the rule version moved from ${before.rule.version ?? 'unrecorded'} to ${after.rule.version ?? 'unrecorded'}`);
  if (hashChanged && !versionChanged) note(changes, 'rule', 'conflicting', 'the rule hash changed without a version change, so the record no longer says which shape was reviewed');
  else if (hashChanged) note(changes, 'rule', 'stale', 'the rule text has a different hash than the reviewed shape');
  if (shapeChanged) note(changes, 'rule', 'stale', 'the guidance shape in force changed after the review was opened');

  const stateChanged = before.adaptation.decisionState !== after.adaptation.decisionState
    || before.adaptation.active !== after.adaptation.active
    || before.adaptation.supportState !== after.adaptation.supportState;
  if (stateChanged) {
    note(changes, 'adaptation', after.adaptation.retired && !before.adaptation.retired ? 'superseded' : 'stale',
      `the adaptation moved from ${before.adaptation.decisionState}/${before.adaptation.supportState ?? 'no support state'} to ${after.adaptation.decisionState}/${after.adaptation.supportState ?? 'no support state'}`);
  }

  compareSets({
    stored: before.support.experienceIds,
    current: after.support.experienceIds,
    area: 'support',
    changes,
    label: 'supporting experience',
    onRemoved: truncated ? 'unreadable' : 'withdrawn',
  });
  compareSets({
    stored: before.support.feedbackIds,
    current: after.support.feedbackIds,
    area: 'support',
    changes,
    label: 'supporting feedback',
    onRemoved: truncated ? 'unreadable' : 'withdrawn',
  });
  for (const id of after.support.missingExperienceIds) note(changes, 'support', 'missing', `supporting experience ${id.slice(0, 8)} is not in the store`, id);
  for (const id of after.support.missingFeedbackIds) note(changes, 'support', 'missing', `supporting feedback ${id.slice(0, 8)} is not in the store`, id);
  for (const id of after.support.retiredExperienceIds) {
    note(changes, 'support', before.support.retiredExperienceIds.includes(id) ? 'stale' : 'superseded',
      `supporting experience ${id.slice(0, 8)} was corrected by a later record`, id);
  }
  for (const id of after.support.retiredFeedbackIds) {
    note(changes, 'support', before.support.retiredFeedbackIds.includes(id) ? 'stale' : 'superseded',
      `supporting feedback ${id.slice(0, 8)} was corrected by a later record`, id);
  }

  const reportFields = ['available', 'state', 'summaryKind', 'recommendation'];
  const reportChangedFields = reportFields.filter((field) => !sameJson(before.report[field], after.report[field]));
  if (reportChangedFields.length > 0) {
    note(changes, 'report', 'stale', `the effectiveness report now reports ${reportChangedFields.join(', ')} differently`, null);
  } else if (!sameJson(before.report.observations, after.report.observations)) {
    note(changes, 'report', 'stale', 'the effectiveness report now counts different observations', null);
  }

  diffKeyed({
    stored: before.predictions,
    current: after.predictions,
    keyOf: (p) => p.predictionId,
    area: 'predictions',
    changes,
    labelOf: (id) => `prediction ${id.slice(0, 8)}`,
    onRemoved: truncated ? 'unreadable' : 'withdrawn',
    onChanged: (oldRef, newRef) => {
      if (oldRef.current && !newRef.current) return 'superseded';
      if (newRef.status === 'invalidated' || newRef.status === 'superseded') return 'superseded';
      return 'stale';
    },
  });

  diffKeyed({
    stored: before.uses,
    current: after.uses,
    keyOf: (u) => u.operationId ?? `${u.attribution}:${u.planId ?? ''}`,
    area: 'uses',
    changes,
    labelOf: (key) => `use ${String(key).slice(0, 24)}`,
    onRemoved: truncated ? 'unreadable' : 'withdrawn',
    onChanged: () => 'stale',
  });

  diffKeyed({
    stored: before.plans,
    current: after.plans,
    keyOf: (p) => p.planId,
    area: 'plans',
    changes,
    labelOf: (id) => `plan ${id.slice(0, 8)}`,
    onRemoved: truncated ? 'unreadable' : 'missing',
    onChanged: (oldPlan, newPlan) => (oldPlan.contentHash !== newPlan.contentHash ? 'stale' : 'stale'),
  });
  // Assessments are their own references: a revision or correction supersedes the old assessment
  // without erasing it, so a stored assessment that is now stale is `superseded`, not `stale`.
  const beforeAssessments = before.plans.flatMap((p) => p.assessments.map((a) => ({ planId: p.planId, ...a })));
  const afterAssessments = after.plans.flatMap((p) => p.assessments.map((a) => ({ planId: p.planId, ...a })));
  diffKeyed({
    stored: beforeAssessments,
    current: afterAssessments,
    keyOf: (a) => `${a.planId}\u0000${a.assessmentId ?? ''}\u0000${a.planVersion ?? ''}\u0000${a.contentHash ?? ''}\u0000${a.verdict}`,
    area: 'assessments',
    changes,
    labelOf: (key) => `assessment ${String(key).split('\u0000')[1]?.slice(0, 8) || '(unidentified)'}`,
    onRemoved: 'withdrawn',
    onChanged: () => 'stale',
  });
  for (const assessment of afterAssessments) {
    if (assessment.stale && beforeAssessments.some((a) => a.assessmentId === assessment.assessmentId)) {
      note(changes, 'assessments', 'superseded', `assessment ${String(assessment.assessmentId ?? '').slice(0, 8)} describes an older plan version`, assessment.assessmentId);
    }
  }

  diffKeyed({
    stored: before.goals,
    current: after.goals,
    keyOf: (g) => g.goalId,
    area: 'goals',
    changes,
    labelOf: (id) => `goal ${id.slice(0, 8)}`,
    onRemoved: 'missing',
    onChanged: () => 'stale',
  });

  diffKeyed({
    stored: before.pattern ? [before.pattern] : [],
    current: after.pattern ? [after.pattern] : [],
    keyOf: (p) => `${p.kind}:${p.observations}`,
    area: 'pattern',
    changes,
    labelOf: (key) => `pattern ${key}`,
    onRemoved: 'withdrawn',
    onChanged: () => 'stale',
  });

  const evidenceVerificationMissing = after.uses.some((u) => {
    const prior = before.uses.find((p) => p.operationId === u.operationId);
    return prior && prior.outcome.derived === true && u.outcome.derived !== true;
  });
  if (evidenceVerificationMissing) note(changes, 'verification', 'missing', 'outcome evidence that was previously derived can no longer be derived');

  const beforeConflict = reviewHasConflict(before);
  const afterConflict = reviewHasConflict(after);
  if (afterConflict && !beforeConflict) note(changes, 'conflict', 'conflicting', 'the live evidence now disagrees with itself');
  if (beforeConflict && !afterConflict) note(changes, 'conflict', 'stale', 'the conflict recorded by the review is no longer present');

  const counts = { added: 0, withdrawn: 0, superseded: 0, stale: 0, conflicting: 0, missing: 0, unreadable: 0 };
  for (const change of changes) counts[change.kind] = (counts[change.kind] ?? 0) + 1;
  const kinds = Object.keys(counts).filter((kind) => counts[kind] > 0);
  const state = kinds.length === 0
    ? 'unchanged'
    : kinds.reduce((worst, kind) => (CHANGE_RANK[kind] > CHANGE_RANK[worst] ? kind : worst), 'unchanged');

  const reportChanged = Boolean(storedReportDigest && currentReportDigest && storedReportDigest !== currentReportDigest);

  return {
    state,
    changed: kinds.length > 0,
    current: kinds.length === 0,
    kinds,
    changes,
    counts,
    evidenceDigest,
    storedDigest,
    reportChanged,
    rule: { changed: versionChanged || hashChanged || shapeChanged, versionChanged, hashChanged, conflict: hashChanged && !versionChanged },
    conflict: afterConflict,
    why: kinds.length === 0
      ? 'the evidence this review recorded is unchanged'
      : changes[0]?.detail ?? 'the evidence changed',
  };
}

// ---- review state -----------------------------------------------------------

// The state a reader reports for one review (or for an adaptation with no review yet). `diff` is the
// reconciliation of the review's evidence against the live stores; `recommendation` is the live
// report's recommendation. Nothing here mutates, approves, retires, or executes.
export function classifyReviewState({
  recommendation = 'none',
  review = null,
  diff = null,
  unavailable = null,
} = {}) {
  if (unavailable) {
    return { state: 'review_unavailable', current: false, why: String(unavailable).slice(0, 400) };
  }
  if (!review) {
    if (recommendation === 'review' || recommendation === 'consider_retirement') {
      return {
        state: 'review_recommended',
        current: false,
        why: 'the effectiveness report recommends a review; opening one is the user\'s decision',
      };
    }
    return {
      state: 'no_review_required',
      current: false,
      why: 'the effectiveness report records no recommendation for this adaptation',
    };
  }
  if ((review.supersededBy ?? []).length > 0) {
    return {
      state: 'review_decision_superseded',
      current: false,
      why: 'a later review names this adaptation, so this review is history rather than the current one',
    };
  }
  if (diff?.state === 'unreadable') {
    return { state: 'review_unavailable', current: false, why: diff.why ?? 'the evidence could not be read' };
  }
  const awaiting = review.awaitingEvidence === true;
  if (review.decision) {
    if (diff?.state === 'missing' || diff?.state === 'unreadable') {
      return {
        state: 'review_awaiting_evidence',
        current: false,
        why: 'a decision is recorded, but the evidence it was based on can no longer be established in full',
      };
    }
    // Retirement is the decision's own effect: the retirement record it cites is what changes the
    // live bundle, the adaptation can never be used or reviewed again, and a new review of it is
    // refused. The only honest terminal state is that the decision stands.
    if (review.decision.decision === 'retire') {
      return {
        state: 'review_completed',
        current: true,
        why: 'the user retired the adaptation; the retirement is the decision\'s recorded effect and the adaptation cannot be reviewed again',
      };
    }
    // For keep_active and dismiss, the review stays current only while the live evidence still matches
    // the bundle the decision cited; a later, unrelated change moves it to `review_evidence_changed`.
    const decidedOnCurrent = review.decision.currentEvidenceDigest === diff?.evidenceDigest;
    if (diff?.changed && !decidedOnCurrent) {
      return {
        state: 'review_evidence_changed',
        current: false,
        why: 'the evidence changed after the decision; the decision stays recorded but is no longer current',
      };
    }
    if (review.decision.decision === 'dismiss') {
      return { state: 'review_dismissed', current: true, why: 'the user dismissed the recommendation and kept the adaptation unchanged' };
    }
    return { state: 'review_completed', current: true, why: `the user decided: ${review.decision.decision}` };
  }
  if (diff?.state === 'missing' || diff?.state === 'unreadable') {
    return { state: 'review_awaiting_evidence', current: false, why: diff.why ?? 'required evidence is not currently readable' };
  }
  if (awaiting) {
    return {
      state: 'review_awaiting_evidence',
      current: true,
      why: 'the review is open, but the report could not classify any evaluated use of the current version',
    };
  }
  if (diff?.changed) {
    return { state: 'review_evidence_changed', current: false, why: 'the evidence changed since the review was opened; reconcile before deciding' };
  }
  return { state: 'review_opened', current: true, why: 'the review is open on the evidence it recorded' };
}

// ---- record validation (used by JsonlStore) ---------------------------------

// A review names one adaptation and one exact piece of evidence. It carries no state, no decision and
// no retirement; those are separate records, so a review can never become an approval by being read.
export function validateReviewRecord(r) {
  if (!isObject(r)) return 'not an object';
  if (typeof r.id !== 'string' || !UUID_RE.test(r.id)) return 'review has missing or invalid id';
  if (typeof r.targetId !== 'string' || !UUID_RE.test(r.targetId)) return 'review has missing or invalid targetId';
  const problem = evidenceProblem(r.evidence);
  if (problem) return problem;
  if (r.evidence.targetId !== r.targetId) return 'review evidence names a different adaptation';
  if (typeof r.evidenceDigest !== 'string' || !HASH_RE.test(r.evidenceDigest)) return 'review has a missing or invalid evidence digest';
  if (r.evidenceDigest !== sha256Hex(stableStringify(r.evidence))) return 'review evidence digest does not match its evidence';
  if (r.reportDigest !== null && (typeof r.reportDigest !== 'string' || !HASH_RE.test(r.reportDigest))) return 'review has an invalid report digest';
  if (!RECOMMENDATIONS.has(r.recommendation)) return 'review has an unknown recommendation';
  if (r.recommendation !== r.evidence.report.recommendation) return 'review recommendation disagrees with its evidence';
  if (typeof r.awaitingEvidence !== 'boolean') return 'review awaitingEvidence must be true or false';
  if (typeof r.reason !== 'undefined') {
    if (typeof r.reason !== 'string' || r.reason.length === 0 || r.reason.length > MAX_REVIEW_TEXT || CONTROL_CHARS.test(r.reason)) {
      return 'review reason is invalid';
    }
  }
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return 'review has a bad createdAt';
  for (const field of FORBIDDEN_REVIEW_FIELDS) {
    if (r[field] !== undefined) return `review must not carry ${field}`;
  }
  return null;
}

// A decision names one review and the exact evidence digest it was made against. The current digest
// is stored beside it so a later reader can tell whether the decision is still current without
// re-deriving at read time - and reconciliation re-derives it anyway, because a stored claim is not
// evidence.
export function validateReviewDecisionRecord(r) {
  if (!isObject(r)) return 'not an object';
  if (typeof r.id !== 'string' || !UUID_RE.test(r.id)) return 'review decision has missing or invalid id';
  if (typeof r.reviewId !== 'string' || !UUID_RE.test(r.reviewId)) return 'review decision has missing or invalid reviewId';
  if (typeof r.targetId !== 'string' || !UUID_RE.test(r.targetId)) return 'review decision has missing or invalid targetId';
  if (!REVIEW_DECISIONS.includes(r.decision)) return 'unknown review decision';
  for (const field of ['reviewedEvidenceDigest', 'currentEvidenceDigest']) {
    if (typeof r[field] !== 'string' || !HASH_RE.test(r[field])) return `review decision has a missing or invalid ${field}`;
  }
  if (r.reportDigest !== null && (typeof r.reportDigest !== 'string' || !HASH_RE.test(r.reportDigest))) return 'review decision has an invalid report digest';
  if (r.decision === 'retire') {
    if (typeof r.retirementId !== 'string' || !UUID_RE.test(r.retirementId)) return 'a retirement decision must name the retirement record it used';
  } else if (r.retirementId !== undefined && r.retirementId !== null) {
    return 'only a retirement decision may name a retirement record';
  }
  if (r.reason !== undefined) {
    if (typeof r.reason !== 'string' || r.reason.length === 0 || r.reason.length > MAX_REVIEW_TEXT || CONTROL_CHARS.test(r.reason)) {
      return 'review decision reason is invalid';
    }
  }
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return 'review decision has a bad createdAt';
  for (const field of FORBIDDEN_DECISION_FIELDS) {
    if (r[field] !== undefined) return `review decision must not carry ${field}`;
  }
  return null;
}
