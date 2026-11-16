// Experience, feedback, adaptation, and governance-review store. One append-only JSONL log holds
// eight record kinds, and every state a reader reports is derived from them:
//
//   experience               an event that happened: a verified reference to one audit record
//   feedback                 the user's own assessment of that event, in the user's own words
//   adaptation               a candidate behaviour change, derived deterministically from the two above
//   adaptation_decision      the user's approval or rejection of one candidate
//   adaptation_retirement    the user's explicit end for one adaptation
//   adaptation_guidance      the user's recorded shape for one adaptation
//   adaptation_review        the user's opening of a governance review on exact recorded evidence
//   adaptation_review_decision  the user's explicit lifecycle decision on one review
//
// A review is not an approval, a retirement, or a finding. It records that a question was opened
// against a bounded evidence snapshot; what happens next is a separate user decision or the existing
// `adaptation.retire` record. Nothing in the review kinds changes how any other record is read.
//
// An experience is deliberately *not* a copy of the conversation. The audit log already records
// what APEX did and what outcome followed, so duplicating that here would create a second, weaker
// copy of the same history. An experience therefore stores the structural evidence of one audited
// operation - its capability, origin, outcome, decision, timing, and the authorization / execution
// / verification state of each step - plus a hash over that subset. The hash is recomputed on
// every read, so a line whose evidence was altered or truncated is reported as damage rather than
// silently read, and an independent check can prove the summary still matches the audit record it
// names. Request and output text are never copied.
//
// Recording an experience requires the referenced operation to exist in the audit log. Without that
// cross-store check a typo, or a model that wanted a piece of history it could act on, would be
// enough to create one.
//
// Trust boundaries, in the order a record can appear:
//   1 observed experience  - copied from the audit record, either because the user asked for it
//     (`user_recorded`) or because APEX captured a verified outcome on its own (`system_observed`);
//   2 user feedback        - user origin only, always a new record;
//   3 candidate adaptation - written by deterministic derivation, marked `candidate_unapproved`;
//   4 approved adaptation  - only when a user-origin decision record says so;
//   5 active adaptation    - approved, not retired, and still supported by evidence that is present.
// Nothing promotes itself. A model-origin request can read candidates but cannot write feedback,
// approve one, or retire one; the registry refuses those writes before this store is reached and
// the store refuses them again for the same reason. Silence is never read as approval, and an
// adaptation never grants permission for an action - authorization stays in the registry.
//
// The rules are the ones the other stores use: records are appended and never rewritten or deleted,
// a corrupt line is reported and refused rather than repaired, supersession and retirement are new
// events next to the record they describe (so previous feedback stays as history and contradictory
// feedback stays visible), reads and retrieval are bounded, and every write happens inside the
// store's writer lock because it derives its decision from the whole authoritative log.
import { randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { WriterLock } from '../memory/writer-lock.js';
import { sha256Hex, tokenize } from '../memory/memory-store.js';
import { StoreError, ValidationError } from '../errors.js';
import { CONTROL_CHARS, parseIsoInstant, shortId, singleLine } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { stableStringify } from '../tasks/model.js';
import { OUTCOME_VALUES } from '../outcomes.js';
import {
  DERIVATION_METHOD,
  MIN_SUPPORT_FEEDBACK,
  normalizeRuleText,
  deriveCandidateSpecs,
} from './derivation.js';
import {
  ADAPTATION_METHODS,
  LONGITUDINAL_DERIVATION_METHOD,
  LONGITUDINAL_PROPOSAL_TYPE,
  MAX_PROPOSAL_LIMITATIONS,
  OUTCOME_PROPOSAL_FIELD,
  PREDICTION_DECISION_DIMENSION,
  PREDICTION_DERIVATION_METHOD,
  PREDICTION_PROPOSAL_TYPE,
  decidingOutcomeOf,
  derivationBasis,
  evidenceDigest,
  isPredictionDerived,
  predictionEligibility,
  proposalFor,
  proposalKey,
  proposalRule,
} from './prediction-derivation.js';
import {
  MAX_LONGITUDINAL_OBSERVATIONS,
  MIN_REPEATED_OBSERVATIONS,
  PATTERN_DEFINITIONS,
  PROPOSAL_FIELD_BY_PATTERN,
  analyzeLongitudinal,
  longitudinalEvidenceDigest,
  longitudinalProposalFor,
  longitudinalRule,
} from '../prediction/longitudinal.js';
import {
  MAX_PATTERNS,
  MAX_TEMPORAL_EVENTS,
  MIN_PATTERN_EVENTS,
  analyzeTemporal,
  compareTemporalWindows,
  outcomeClass,
  parseInstant,
  resolveWindow,
  summarizeTemporal,
  temporalPreparation,
} from './temporal.js';
import {
  REVIEW_DECISION_KIND,
  REVIEW_DECISIONS,
  REVIEW_KIND,
  canonicalReviewEvidence,
  reconcileReviewEvidence,
  reviewAwaitingEvidence,
  reviewEvidenceDigest,
  validateReviewDecisionRecord,
  validateReviewRecord,
} from './review.js';
import {
  EVALUATION_KIND,
  MEASUREMENT_KIND,
  OBSERVED_OUTCOME_METHOD,
  ROLLBACK_KIND,
} from '../learning/vocabulary.js';
import { evaluationDigest, validateEvaluationRecord } from '../learning/evaluate.js';
import { buildMeasurement, validateMeasurementRecord } from '../learning/measurement.js';
import { validateOutcomeProposal } from '../learning/proposals.js';

export const EXPERIENCE_SCHEMA = 1;

export const EXPERIENCE_KIND = 'experience';
export const FEEDBACK_KIND = 'feedback';
export const ADAPTATION_KIND = 'adaptation';
export const DECISION_KIND = 'adaptation_decision';
export const RETIREMENT_KIND = 'adaptation_retirement';
export const GUIDANCE_KIND = 'adaptation_guidance';
export { REVIEW_KIND, REVIEW_DECISION_KIND };
// T-08 adds three record kinds to this same log rather than a second ledger: what a run achieved, what
// an adaptation measured afterwards, and the user's rollback of a rule a measurement showed regressing.
// They share this store's append-only history, writer lock, recovery and health read.
export { EVALUATION_KIND, MEASUREMENT_KIND, ROLLBACK_KIND };
export const RECORD_KINDS = Object.freeze([
  EXPERIENCE_KIND, FEEDBACK_KIND, ADAPTATION_KIND, DECISION_KIND, RETIREMENT_KIND, GUIDANCE_KIND,
  REVIEW_KIND, REVIEW_DECISION_KIND, EVALUATION_KIND, MEASUREMENT_KIND, ROLLBACK_KIND,
]);

// The vocabulary an approved adaptation's guidance may be expressed in, and nothing else. Batch AM's
// learning package needs recorded guidance to be able to change the order candidates are compared in,
// and the only honest way to do that is to compare a candidate's *structure* against a structure the
// user named. A rule's prose is the user's own words and stays visible forever; it is not parsed here,
// because a ranking read out of free text would be APEX deciding what the user meant.
//   - `reads_first`  - the steps that look come before the steps that write
//   - `writes_first` - the reverse, for guidance about recording something before it is examined
// `avoid` and `prefer` name capabilities; `maxSteps` bounds how many steps the guidance considers
// whole. All four are optional: a guidance record that names nothing checks nothing, and says so.
export const GUIDANCE_ORDERS = Object.freeze(['reads_first', 'writes_first']);
export const MAX_GUIDANCE_NAMES = 4;
export const MAX_GUIDANCE_STEPS = 8;

// The feedback vocabulary. Every value is something a user can state about one recorded event;
// none of them is inferred by APEX.
export const ASSESSMENTS = Object.freeze([
  'correct',
  'incorrect',
  'partially_correct',
  'useful',
  'not_useful',
  'user_correction',
  'outcome_succeeded',
  'outcome_failed',
]);
export const ADAPTATION_DECISIONS = Object.freeze(['approved', 'rejected']);

// The updateMode a candidate carries until a user decision exists. It is the only mode that is not
// user-confirmed, and no reader may treat it as one.
export const CANDIDATE_UPDATE_MODE = 'candidate_unapproved';

export const MAX_SUBJECT_CHARS = 300;
export const MAX_RULE_CHARS = 300;
export const MAX_REASON_CHARS = 500;
export const MAX_CONTEXT_CHARS = 200;
export const MAX_SUPERSEDES = 10;
export const MAX_SUPPORT_REFS = 20;
export const MAX_SAMPLES = 8;
export const MAX_HEALTH_SAMPLES = 20;
export const MAX_ACTIVE_ADAPTATIONS = 10;
export const DEFAULT_ACTIVE_ADAPTATIONS = 3;
// The bound on expectations one derivation or eligibility read opens. A ledger larger than this is
// reported as truncated rather than silently halved: an outcome outside the window is not considered,
// and the reader is told so.
export const MAX_PREDICTION_CANDIDATES = 20;
export const EXPERIENCE_PARSE_CACHE_BYTES = 32 * 1024 * 1024;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const CAPABILITY_RE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;
// The capability an audit record carries when a request was refused before any capability was
// chosen. Real in the log, useless as an adaptation scope.
const NON_SCOPABLE_CAPABILITY = 'none';
const DECISION_VALUES = new Set(['answer', 'clarify', 'propose_action', 'refuse_or_block']);
const OPERATION_ORIGINS = new Set(['user', 'model']);

const PROVENANCE_BY_KIND = Object.freeze({
  [EXPERIENCE_KIND]: { origin: 'user_recorded', updateMode: 'user_confirmed' },
  [FEEDBACK_KIND]: { origin: 'user_feedback', updateMode: 'user_confirmed' },
  [ADAPTATION_KIND]: { origin: 'deterministic_derivation', updateMode: CANDIDATE_UPDATE_MODE },
  [DECISION_KIND]: { origin: 'user_approval', updateMode: 'user_confirmed' },
  [RETIREMENT_KIND]: { origin: 'user_retirement', updateMode: 'user_confirmed' },
  [GUIDANCE_KIND]: { origin: 'user_guidance', updateMode: 'user_confirmed' },
  // A review is user-origin because only the user opens a governance question, and a review decision
  // is user-origin because only the user may decide what happens to an adaptation. A model may read
  // either record; it may not write one.
  [REVIEW_KIND]: { origin: 'user_review', updateMode: 'user_confirmed' },
  [REVIEW_DECISION_KIND]: { origin: 'user_review_decision', updateMode: 'user_confirmed' },
  // An evaluation, a measurement, and a rollback are all the user's own recorded reads of evidence.
  // The derivation is deterministic, but the act of recording one is a user-origin operation.
  [EVALUATION_KIND]: { origin: 'recorded_evaluation', updateMode: 'user_confirmed' },
  [MEASUREMENT_KIND]: { origin: 'recorded_measurement', updateMode: 'user_confirmed' },
  [ROLLBACK_KIND]: { origin: 'user_rollback', updateMode: 'user_confirmed' },
});

// An experience can arrive two ways, and the difference must stay visible forever: the user named
// the operation and asked for it, or APEX captured a verified outcome on the user's behalf. Both are
// evidence that the event happened; neither is the user's judgement of it, which is what only a
// feedback record can say. A caller selects one of these two, never a value of its own making, so
// the field that says who authorized the record cannot be set free-form.
export const CAPTURE_EXPLICIT = 'explicit';
export const CAPTURE_AUTOMATIC = 'automatic';
export const CAPTURE_VALUES = Object.freeze([CAPTURE_EXPLICIT, CAPTURE_AUTOMATIC]);
// The answer every reader gives for a record whose provenance names no capture route at all: a
// line written before this distinction, or one no writer could have produced.
export const CAPTURE_UNKNOWN = 'unknown';
const EXPERIENCE_ORIGIN_BY_CAPTURE = Object.freeze({
  [CAPTURE_EXPLICIT]: 'user_recorded',
  [CAPTURE_AUTOMATIC]: 'system_observed',
});
const EXPERIENCE_CAPTURE_BY_ORIGIN = Object.freeze({
  user_recorded: CAPTURE_EXPLICIT,
  system_observed: CAPTURE_AUTOMATIC,
});

// How an experience entered the log, read the same way by every reader. A record whose provenance
// predates this distinction, or that no writer could have produced, is reported as unknown rather
// than assumed to be the user's own.
export function captureOf(record) {
  const origin = record?.provenance?.origin;
  return EXPERIENCE_CAPTURE_BY_ORIGIN[origin] ?? CAPTURE_UNKNOWN;
}

// ---- field validators -------------------------------------------------------

// An error message here never quotes the offending value: it can reach the audit record through
// the execution error, and a target or guidance string is user text.
function validateTextField(value, name, { required = true, max = MAX_RULE_CHARS } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const t = value.trim();
  if (required && t.length === 0) throw new ValidationError(`${name} is empty`);
  if (t.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if (CONTROL_CHARS.test(t)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(t)) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  }
  return t || null;
}

// Stored-field version of the same rules, returning a problem string for the reader's validator.
function storedTextProblem(value, name, max) {
  if (typeof value !== 'string' || value.length === 0) return `missing ${name}`;
  if (value.length > max) return `${name} is too long`;
  if (CONTROL_CHARS.test(value)) return `${name} contains control characters`;
  if (containsSecret(value)) return `${name} looks like a password, key, or token`;
  return null;
}

function optionalStoredTextProblem(value, name, max) {
  if (value === undefined) return null;
  return storedTextProblem(value, name, max);
}

function validateRef(value, label) {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text`);
  const ref = value.trim();
  if (ref.length === 0) throw new ValidationError(`${label} is empty`);
  if (ref.length > 64) throw new ValidationError(`${label} is longer than 64 characters`);
  if (CONTROL_CHARS.test(ref)) throw new ValidationError(`${label} contains control characters`);
  if (containsSecret(ref)) throw new ValidationError(`the ${label} looks like a password, key, or token; it was not used`, 'SECRET_REFUSED');
  return ref;
}

function validateOperationRef(value) {
  const ref = validateRef(value, 'operation reference');
  if (!OPERATION_ID_RE.test(ref)) throw new ValidationError('operation reference has an invalid format');
  return ref;
}

function validateRefList(values, label, max) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new ValidationError(`${label} must be a list of record ids`);
  if (values.length > max) throw new ValidationError(`${label} may name at most ${max} records`);
  return values.map((value) => validateRef(value, label));
}

// A capability name in a guidance record is an identifier, so it is checked as one: the same shape the
// derivation accepts for a scope, and nothing else. A reader comparing a candidate against the guidance
// matches names exactly, so a name that only looks like one - prose, a path, a wildcard - would turn an
// explicit instruction into a guess about which capability the user meant.
function validateCapabilityName(value, label) {
  if (typeof value !== 'string') throw new ValidationError(`${label} must hold capability names`);
  const name = value.trim();
  if (!isScopableCapability(name)) throw new ValidationError(`${label} holds "${singleLine(name, 40)}", which is not a capability name`);
  return name;
}

function storedIdListProblem(value, name, max) {
  if (!Array.isArray(value) || value.length === 0) return `${name} must be a non-empty list`;
  if (value.length > max) return `${name} lists more than ${max} entries`;
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return `${name} has an invalid id`;
    if (seen.has(id)) return `${name} names the same id twice`;
    seen.add(id);
  }
  return null;
}

function optionalIdListProblem(value, name, max) {
  if (value === undefined) return null;
  return storedIdListProblem(value, name, max);
}

// A list that must be present but may be empty. An outcome-derived candidate cites no feedback for
// most patterns but may cite the user's own corrections for one of them, so absence and emptiness are
// different answers and the record has to say which it means.
function allowanceListProblem(value, name, max) {
  if (!Array.isArray(value)) return `${name} must be a list`;
  if (value.length === 0) return null;
  return storedIdListProblem(value, name, max);
}

// A prediction-derived adaptation names no feedback; the field is present and empty rather than
// absent so a reader can tell "researched and found none" from a record written before the field
// existed.
function emptyIdListProblem(value, name) {
  if (!Array.isArray(value) || value.length !== 0) return `${name} must be an empty list`;
  return null;
}

function validateTimestamp(value, name, { nullable = false } = {}) {
  if (value === null) return nullable ? null : `${name} must be a timestamp`;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return `${name} has a bad timestamp`;
  return null;
}

function validateProvenance(r, kind) {
  const expected = PROVENANCE_BY_KIND[kind];
  if (!r.provenance || typeof r.provenance !== 'object' || Array.isArray(r.provenance)) return 'missing provenance';
  if (kind === EXPERIENCE_KIND) {
    if (!Object.hasOwn(EXPERIENCE_CAPTURE_BY_ORIGIN, r.provenance.origin)) {
      return 'experience provenance origin must be user_recorded or system_observed';
    }
  } else if (r.provenance.origin !== expected.origin) return `provenance origin must be ${expected.origin}`;
  if (r.provenance.updateMode !== expected.updateMode) return `provenance updateMode must be ${expected.updateMode}`;
  if (r.provenance.operationId !== undefined
    && (typeof r.provenance.operationId !== 'string' || !OPERATION_ID_RE.test(r.provenance.operationId))) {
    return 'provenance operationId has an invalid format';
  }
  if (r.provenance.context !== undefined) {
    const problem = storedTextProblem(r.provenance.context, 'provenance context', MAX_CONTEXT_CHARS);
    if (problem) return problem;
  }
  return null;
}

// Provenance is derived from the record kind and the operation that wrote it. A caller can attach
// its operation id and a short context, and nothing else: `origin` and `updateMode` are refused
// because they are the fields that say who authorized the record. For an experience the caller may
// say *how* the record arrived - `explicit` or `automatic` - and that choice is mapped to the fixed
// origin vocabulary here, so the field stays non-forgeable while still distinguishing a captured
// outcome from one the user asked for by name.
function sanitizeProvenance(p, kind, { capture = CAPTURE_EXPLICIT } = {}) {
  const expected = PROVENANCE_BY_KIND[kind];
  if (!CAPTURE_VALUES.includes(capture)) throw new ValidationError(`an experience is either ${CAPTURE_EXPLICIT} or ${CAPTURE_AUTOMATIC} captured`);
  if (kind !== EXPERIENCE_KIND && capture !== CAPTURE_EXPLICIT) {
    throw new ValidationError('only an experience carries a capture kind');
  }
  const base = {
    origin: kind === EXPERIENCE_KIND ? EXPERIENCE_ORIGIN_BY_CAPTURE[capture] : expected.origin,
    updateMode: expected.updateMode,
  };
  if (p === undefined || p === null) return base;
  if (typeof p !== 'object' || Array.isArray(p)) throw new ValidationError('provenance must be an object');
  if (p.origin !== undefined || p.updateMode !== undefined) {
    throw new ValidationError('provenance origin and updateMode may not be supplied directly; they are derived from the record kind and the operation');
  }
  if (p.operationId !== undefined) {
    if (typeof p.operationId !== 'string' || !OPERATION_ID_RE.test(p.operationId)) {
      throw new ValidationError('provenance operationId has an invalid format');
    }
    base.operationId = p.operationId;
  }
  if (p.context !== undefined && p.context !== null) {
    const ctx = validateTextField(p.context, 'provenance context', { max: MAX_CONTEXT_CHARS });
    if (ctx) base.context = ctx;
  }
  return base;
}

// ---- evidence: the canonical subset copied from one audit record -------------

// A capability names the scope an adaptation applies to. `none` (a request that was refused before
// any capability was chosen) and a missing capability are legitimate audit values but cannot scope
// a rule, so they are excluded from adaptation use rather than from the record.
export function isScopableCapability(capability) {
  return typeof capability === 'string'
    && capability.length <= 64
    && capability !== NON_SCOPABLE_CAPABILITY
    && CAPABILITY_RE.test(capability);
}

// What an experience may carry as its capability: nothing at all, the `none` sentinel, or a real
// capability name. The record must still equal the audit record it was copied from, which is what
// keeps this field from becoming a second, editable copy of the event.
export function isRecordableCapability(capability) {
  return capability === NON_SCOPABLE_CAPABILITY || isScopableCapability(capability);
}

// The structural fields of an audit record, in a fixed key order. Nothing personal is included:
// `request`, `output`, `errors[].message`, `steps[].summary`, `steps[].display`, `steps[].result`,
// and the prompt/retrieval detail all stay in the audit log, where their own minimization rules
// already apply to them.
// One step, reduced to its structural facts. An audit record nests its decisions
// (`authorization.decision`, `execution.status`, `verification.outcome`), while the stored evidence
// keeps each as a plain string. Both shapes must reduce to the same canonical step, otherwise
// re-deriving evidence from an already-canonical experience would erase those three fields and
// `validateExperience` would report every real experience as non-canonical: an experience could
// only ever be recorded for an operation with no steps at all.
function stepEvidence(s) {
  const pick = (value, nested) => (typeof value === 'string' ? value : typeof value?.[nested] === 'string' ? value[nested] : null);
  return {
    action: typeof s?.action === 'string' && s.action.length <= 64 ? s.action : null,
    origin: OPERATION_ORIGINS.has(s?.origin) ? s.origin : null,
    authorization: pick(s?.authorization, 'decision'),
    execution: pick(s?.execution, 'status'),
    verification: pick(s?.verification, 'outcome'),
    outcome: typeof s?.outcome === 'string' ? s.outcome : null,
  };
}

export function evidenceFromOperation(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    throw new ValidationError('an experience must reference an audit record');
  }
  return {
    capability: typeof op.capability === 'string' && op.capability.length <= 64 ? op.capability : null,
    origin: OPERATION_ORIGINS.has(op.origin) ? op.origin : null,
    status: typeof op.status === 'string' ? op.status : null,
    decision: DECISION_VALUES.has(op.decision) ? op.decision : null,
    requestedAt: typeof op.requestedAt === 'string' ? op.requestedAt : null,
    finishedAt: typeof op.finishedAt === 'string' ? op.finishedAt : null,
    steps: (Array.isArray(op.steps) ? op.steps : []).map(stepEvidence),
  };
}

export function evidenceSha(evidence) {
  return sha256Hex(stableStringify(evidence));
}

// ---- record validation (used by JsonlStore) ---------------------------------

export function validateExperienceRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if (r.schema !== EXPERIENCE_SCHEMA) return 'unsupported schema';
  if (r.kind === EXPERIENCE_KIND) return validateExperience(r);
  if (r.kind === FEEDBACK_KIND) return validateFeedback(r);
  if (r.kind === ADAPTATION_KIND) return validateAdaptation(r);
  if (r.kind === DECISION_KIND) return validateDecision(r);
  if (r.kind === RETIREMENT_KIND) return validateRetirement(r);
  if (r.kind === GUIDANCE_KIND) return validateGuidance(r);
  if (r.kind === REVIEW_KIND) return validateReviewRecord(r);
  if (r.kind === REVIEW_DECISION_KIND) return validateReviewDecisionRecord(r);
  if (r.kind === EVALUATION_KIND) return validateEvaluationRecord(r);
  if (r.kind === MEASUREMENT_KIND) return validateMeasurementRecord(r);
  if (r.kind === ROLLBACK_KIND) return validateRollback(r);
  return 'unknown record kind';
}

function validateExperience(r) {
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'missing or invalid id';
  if (typeof r.operationId !== 'string' || !OPERATION_ID_RE.test(r.operationId)) return 'missing or invalid operationId';
  // The capability is copied verbatim from the audit record, including the `none` sentinel a
  // request refused before any capability was chosen carries: that event is still real, so it stays
  // recordable. Whether a capability can scope a rule is decided by `adaptationEligible` and by the
  // derivation filter, not here.
  if (r.capability !== null && !isRecordableCapability(r.capability)) return 'capability is neither null, the none sentinel, nor a capability name';
  const subject = storedTextProblem(r.subject, 'subject', MAX_SUBJECT_CHARS);
  if (subject) return subject;
  if (!OUTCOME_VALUES.has(r.outcome)) return 'unknown outcome';
  if (r.decision !== null && !DECISION_VALUES.has(r.decision)) return 'unknown decision';
  if (!OPERATION_ORIGINS.has(r.origin)) return 'unknown operation origin';
  const requested = validateTimestamp(r.requestedAt, 'requestedAt');
  if (requested) return requested;
  const finished = validateTimestamp(r.finishedAt, 'finishedAt', { nullable: true });
  if (finished) return finished;
  if (!r.evidence || typeof r.evidence !== 'object' || Array.isArray(r.evidence)) return 'missing evidence';
  if (stableStringify(r.evidence) !== stableStringify(evidenceFromOperation(r.evidence))) return 'evidence is not in canonical form';
  if (typeof r.evidenceSha256 !== 'string' || r.evidenceSha256.length !== 64) return 'missing or invalid evidenceSha256';
  if (r.evidenceSha256 !== evidenceSha(r.evidence)) return 'evidenceSha256 does not match the stored evidence';
  // The fields a reader uses must be the evidence itself, so a hand-edited line cannot show one
  // outcome in its header and another in the copy it was taken from.
  for (const field of ['capability', 'origin', 'status', 'decision', 'requestedAt', 'finishedAt']) {
    const projected = field === 'status' ? r.outcome : r[field];
    if (r.evidence[field] !== projected) return `evidence ${field} disagrees with the record`;
  }
  if (typeof r.adaptationEligible !== 'boolean') return 'adaptationEligible must be true or false';
  const replaces = optionalIdListProblem(r.replaces, 'replaces', MAX_SUPERSEDES);
  if (replaces) return replaces;
  const created = validateTimestamp(r.createdAt, 'createdAt');
  if (created) return created;
  return validateProvenance(r, EXPERIENCE_KIND);
}

function validateFeedback(r) {
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'feedback record has missing or invalid id';
  if (typeof r.experienceId !== 'string' || !ID_RE.test(r.experienceId)) return 'feedback record has missing or invalid experienceId';
  if (!ASSESSMENTS.includes(r.assessment)) return 'unknown assessment';
  const guidance = optionalStoredTextProblem(r.guidance, 'guidance', MAX_RULE_CHARS);
  if (guidance) return guidance;
  const reason = optionalStoredTextProblem(r.reason, 'reason', MAX_REASON_CHARS);
  if (reason) return reason;
  const supersedes = optionalIdListProblem(r.supersedes, 'supersedes', MAX_SUPERSEDES);
  if (supersedes) return supersedes;
  const created = validateTimestamp(r.createdAt, 'createdAt');
  if (created) return created;
  return validateProvenance(r, FEEDBACK_KIND);
}

// A prediction-derived candidate states one recorded outcome as a rule in the same four-field guidance
// vocabulary a user already uses. Nothing in it is free text: the type, the dimension, the field, the
// capability and the rule text are each re-derived from the stored outcome class, so a hand-edited line
// that claims a rule its evidence does not state is refused rather than read. A longitudinal candidate
// states a pattern of between two and twenty recorded observations instead, and the two shapes are
// validated separately so neither can borrow the other's checks.
function validateProposal(r, capability) {
  const p = r.proposal;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'a prediction-derived adaptation must carry a proposal';
  if (p.type === PREDICTION_PROPOSAL_TYPE) return validateSingleProposal(r, capability);
  if (p.type === LONGITUDINAL_PROPOSAL_TYPE) return validateLongitudinalProposal(r, capability);
  return 'proposal type is not a recorded proposal type';
}

function validateSingleProposal(r, capability) {
  const p = r.proposal;
  if (p.dimension !== PREDICTION_DECISION_DIMENSION) return `proposal must feed the ${PREDICTION_DECISION_DIMENSION} dimension and no other`;
  if (!Array.isArray(p.verdicts) || p.verdicts.length !== 1) return 'a proposal states exactly one recorded verdict';
  const verdict = p.verdicts[0];
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return 'proposal verdict is not an object';
  if (typeof verdict.predictionId !== 'string' || !ID_RE.test(verdict.predictionId)) return 'proposal verdict has an invalid prediction id';
  if (typeof verdict.evaluationId !== 'string' || !ID_RE.test(verdict.evaluationId)) return 'proposal verdict has an invalid evaluation id';
  if (verdict.capability !== capability) return 'proposal verdict names a different capability than the adaptation';
  if (!Object.hasOwn(OUTCOME_PROPOSAL_FIELD, verdict.expectation)) return 'proposal verdict has an unknown expectation';
  if (verdict.verdict !== 'matched' && verdict.verdict !== 'contradicted') return 'proposal verdict must be matched or contradicted';
  if (!Object.hasOwn(OUTCOME_PROPOSAL_FIELD, verdict.outcomeClass)) return 'proposal verdict has an unknown deciding outcome class';
  // The single mapping, re-applied: an outcome class may only propose the field the rule states, so a
  // record cannot propose "avoid" while its verdict says the capability succeeded.
  const field = OUTCOME_PROPOSAL_FIELD[verdict.outcomeClass];
  const guidance = p.guidance;
  if (!guidance || typeof guidance !== 'object' || Array.isArray(guidance)) return 'proposal carries no guidance shape';
  if (guidance.order !== null) return 'a proposal names no step order';
  if (guidance.maxSteps !== null) return 'a proposal names no step bound';
  for (const name of ['avoid', 'prefer']) {
    const list = guidance[name];
    if (!Array.isArray(list) || list.length > MAX_GUIDANCE_NAMES) return `proposal ${name} must be a list of at most ${MAX_GUIDANCE_NAMES} capability names`;
    if (list.some((item) => typeof item !== 'string' || !CAPABILITY_RE.test(item))) return `proposal ${name} holds a name that is not a capability name`;
    if (new Set(list).size !== list.length) return `proposal ${name} names the same capability twice`;
  }
  const expectedNames = field === 'prefer' ? guidance.prefer : guidance.avoid;
  const otherNames = field === 'prefer' ? guidance.avoid : guidance.prefer;
  if (expectedNames.length !== 1 || expectedNames[0] !== capability) return `proposal ${field} must name exactly the adaptation's own capability`;
  if (otherNames.length !== 0) return `a ${verdict.outcomeClass} outcome proposes ${field} and nothing else`;
  if (r.rule !== proposalRule(capability, verdict.outcomeClass)) return 'proposal rule text is not the text its recorded outcome states';
  if (!Array.isArray(p.limitations) || p.limitations.length === 0 || p.limitations.length > MAX_PROPOSAL_LIMITATIONS) {
    return `proposal must record between 1 and ${MAX_PROPOSAL_LIMITATIONS} limitations`;
  }
  if (p.limitations.some((item) => typeof item !== 'string' || item.length === 0 || item.length > MAX_RULE_CHARS)) return 'proposal limitation text is invalid';
  if (typeof p.evidenceDigest !== 'string' || p.evidenceDigest.length !== 64) return 'proposal has a missing or invalid evidence digest';
  if (p.evidenceDigest !== evidenceDigest({
    predictionId: verdict.predictionId,
    evaluationId: verdict.evaluationId,
    verdict: verdict.verdict,
    outcomeClass: verdict.outcomeClass,
    outcomeExperienceIds: r.support.experienceIds,
  })) return 'proposal evidence digest does not match the evidence it cites';
  return null;
}

// The longitudinal shape. Every field is re-derived the same way: the pattern kind may only be one that
// states a direction, its definition text is the recorded definition, its observations count is the
// number of verdicts, the rule text is the text that pattern and count state, and the digest covers
// every observation plus the outcome records the candidate cites.
function validateLongitudinalProposal(r, capability) {
  const p = r.proposal;
  if (p.dimension !== PREDICTION_DECISION_DIMENSION) return `proposal must feed the ${PREDICTION_DECISION_DIMENSION} dimension and no other`;
  const pattern = p.pattern;
  if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)) return 'a longitudinal proposal carries no pattern';
  const field = PROPOSAL_FIELD_BY_PATTERN[pattern.kind];
  if (field !== 'prefer' && field !== 'avoid') return 'proposal pattern is not one that states a direction';
  if (pattern.definition !== PATTERN_DEFINITIONS[pattern.kind]) return 'proposal pattern definition is not the recorded definition';
  if (!Array.isArray(p.verdicts)
    || p.verdicts.length < MIN_REPEATED_OBSERVATIONS || p.verdicts.length > MAX_LONGITUDINAL_OBSERVATIONS) {
    return `a longitudinal proposal states between ${MIN_REPEATED_OBSERVATIONS} and ${MAX_LONGITUDINAL_OBSERVATIONS} recorded observations`;
  }
  if (pattern.observations !== p.verdicts.length) return 'proposal pattern count does not match its verdicts';
  const predictionIds = new Set();
  for (const verdict of p.verdicts) {
    if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return 'proposal verdict is not an object';
    if (typeof verdict.predictionId !== 'string' || !ID_RE.test(verdict.predictionId)) return 'proposal verdict has an invalid prediction id';
    if (typeof verdict.evaluationId !== 'string' || !ID_RE.test(verdict.evaluationId)) return 'proposal verdict has an invalid evaluation id';
    if (verdict.capability !== capability) return 'proposal verdict names a different capability than the adaptation';
    if (verdict.verdict !== 'matched' && verdict.verdict !== 'contradicted') return 'proposal verdict must be matched or contradicted';
    // Only a success or a failure can appear in a pattern that states a direction. A blocked or other
    // outcome is excluded from these patterns by the analysis, so a record claiming one is damage.
    if (verdict.outcomeClass !== 'success' && verdict.outcomeClass !== 'failure') return 'a longitudinal verdict states a success or failure outcome';
    if (predictionIds.has(verdict.predictionId)) return 'proposal verdicts cite the same prediction twice';
    predictionIds.add(verdict.predictionId);
  }
  const classes = p.verdicts.map((v) => v.outcomeClass);
  if (pattern.kind === 'repeated_success' && !classes.every((c) => c === 'success')) return 'a repeated-success pattern requires every verdict to be a success';
  if (pattern.kind === 'repeated_failure' && !classes.every((c) => c === 'failure')) return 'a repeated-failure pattern requires every verdict to be a failure';
  if ((pattern.kind === 'consistent_improvement' || pattern.kind === 'consistent_regression')
    && (classes.every((c) => c === 'success') || classes.every((c) => c === 'failure'))) {
    return 'a directional pattern requires both a success and a failure observation';
  }
  if (pattern.window !== null) {
    if (!pattern.window || typeof pattern.window !== 'object' || Array.isArray(pattern.window)) return 'proposal pattern window is not an object';
    for (const key of ['since', 'until']) {
      if (typeof pattern.window[key] !== 'string' || parseInstant(pattern.window[key]) === null) return 'proposal pattern window has an invalid instant';
    }
  }
  const calibration = pattern.calibration;
  if (!calibration || typeof calibration !== 'object' || Array.isArray(calibration)) return 'proposal pattern carries no calibration state';
  if (typeof calibration.available !== 'boolean') return 'proposal pattern calibration availability must be true or false';
  if (!Number.isInteger(calibration.denominator) || calibration.denominator < 0) return 'proposal pattern calibration denominator is invalid';
  if (!Number.isInteger(calibration.requiredForRate) || calibration.requiredForRate < 1) return 'proposal pattern calibration floor is invalid';
  const guidance = p.guidance;
  if (!guidance || typeof guidance !== 'object' || Array.isArray(guidance)) return 'proposal carries no guidance shape';
  if (guidance.order !== null) return 'a proposal names no step order';
  if (guidance.maxSteps !== null) return 'a proposal names no step bound';
  for (const name of ['avoid', 'prefer']) {
    const list = guidance[name];
    if (!Array.isArray(list) || list.length > MAX_GUIDANCE_NAMES) return `proposal ${name} must be a list of at most ${MAX_GUIDANCE_NAMES} capability names`;
    if (list.some((item) => typeof item !== 'string' || !CAPABILITY_RE.test(item))) return `proposal ${name} holds a name that is not a capability name`;
    if (new Set(list).size !== list.length) return `proposal ${name} names the same capability twice`;
  }
  const expectedNames = field === 'prefer' ? guidance.prefer : guidance.avoid;
  const otherNames = field === 'prefer' ? guidance.avoid : guidance.prefer;
  if (expectedNames.length !== 1 || expectedNames[0] !== capability) return `proposal ${field} must name exactly the adaptation's own capability`;
  if (otherNames.length !== 0) return `a ${pattern.kind} pattern proposes ${field} and nothing else`;
  if (r.rule !== longitudinalRule(capability, pattern.kind, pattern.observations)) return 'proposal rule text is not the text its recorded pattern states';
  if (!Array.isArray(p.limitations) || p.limitations.length === 0 || p.limitations.length > MAX_PROPOSAL_LIMITATIONS) {
    return `proposal must record between 1 and ${MAX_PROPOSAL_LIMITATIONS} limitations`;
  }
  if (p.limitations.some((item) => typeof item !== 'string' || item.length === 0 || item.length > MAX_RULE_CHARS)) return 'proposal limitation text is invalid';
  if (typeof p.evidenceDigest !== 'string' || p.evidenceDigest.length !== 64) return 'proposal has a missing or invalid evidence digest';
  if (p.evidenceDigest !== longitudinalEvidenceDigest({
    capability,
    kind: pattern.kind,
    verdicts: p.verdicts,
    outcomeExperienceIds: r.support.experienceIds,
  })) return 'proposal evidence digest does not match the evidence it cites';
  return null;
}

function validateAdaptation(r) {
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'adaptation has missing or invalid id';
  if (!isScopableCapability(r.capability)) return 'adaptation capability is not a dotted capability name';
  const rule = storedTextProblem(r.rule, 'rule', MAX_RULE_CHARS);
  if (rule) return rule;
  if (typeof r.ruleHash !== 'string' || r.ruleHash.length !== 64) return 'adaptation has missing or invalid ruleHash';
  if (r.ruleHash !== sha256Hex(normalizeRuleText(r.rule))) return 'adaptation ruleHash does not match its rule';
  if (!ADAPTATION_METHODS.includes(r.method) && r.method !== OBSERVED_OUTCOME_METHOD) {
    return 'adaptation was not produced by a recorded derivation method';
  }
  if (!Number.isInteger(r.minSupport) || r.minSupport < 1 || r.minSupport > MAX_SUPPORT_REFS) return 'adaptation minSupport is out of range';
  const single = r.method === PREDICTION_DERIVATION_METHOD;
  const repeated = r.method === LONGITUDINAL_DERIVATION_METHOD;
  const outcomeDerived = r.method === OBSERVED_OUTCOME_METHOD;
  if (single && r.minSupport !== 1) return 'a prediction-derived adaptation rests on one evaluation, so its minSupport must be 1';
  // A longitudinal candidate's support count is its observation count, and a pattern needs at least two
  // observations before it can repeat anything. The upper bound is the same reference bound everything
  // else uses.
  if (repeated && (r.minSupport < MIN_REPEATED_OBSERVATIONS || r.minSupport > MAX_LONGITUDINAL_OBSERVATIONS)) {
    return `a longitudinal adaptation rests on between ${MIN_REPEATED_OBSERVATIONS} and ${MAX_LONGITUDINAL_OBSERVATIONS} observations`;
  }
  if (!r.support || typeof r.support !== 'object' || Array.isArray(r.support)) return 'adaptation has no supporting evidence';
  // An outcome-derived candidate normally rests on evaluations rather than on recorded experiences;
  // the field must still be present, and any id it does name must be well formed.
  const experiences = outcomeDerived
    ? allowanceListProblem(r.support.experienceIds, 'adaptation supporting experiences', MAX_SUPPORT_REFS)
    : storedIdListProblem(r.support.experienceIds, 'adaptation supporting experiences', MAX_SUPPORT_REFS);
  if (experiences) return experiences;
  const feedback = single || repeated
    ? emptyIdListProblem(r.support.feedbackIds, 'adaptation supporting feedback')
    : outcomeDerived
      ? allowanceListProblem(r.support.feedbackIds, 'adaptation supporting feedback', MAX_SUPPORT_REFS)
      : storedIdListProblem(r.support.feedbackIds, 'adaptation supporting feedback', MAX_SUPPORT_REFS);
  if (feedback) return feedback;
  if (single) {
    const predictions = storedIdListProblem(r.support.predictionIds, 'adaptation supporting predictions', 1);
    if (predictions) return predictions;
    const evaluations = storedIdListProblem(r.support.evaluationIds, 'adaptation supporting evaluations', 1);
    if (evaluations) return evaluations;
    const proposalProblem = validateProposal(r, r.capability);
    if (proposalProblem) return proposalProblem;
    if (r.proposal.type !== PREDICTION_PROPOSAL_TYPE) return 'a single-evaluation adaptation must carry a single-evaluation proposal';
    if (r.support.predictionIds[0] !== r.proposal.verdicts[0].predictionId) return 'adaptation support names a different prediction than its proposal';
    if (r.support.evaluationIds[0] !== r.proposal.verdicts[0].evaluationId) return 'adaptation support names a different evaluation than its proposal';
  } else if (repeated) {
    const predictions = storedIdListProblem(r.support.predictionIds, 'adaptation supporting predictions', MAX_LONGITUDINAL_OBSERVATIONS);
    if (predictions) return predictions;
    const evaluations = storedIdListProblem(r.support.evaluationIds, 'adaptation supporting evaluations', MAX_LONGITUDINAL_OBSERVATIONS);
    if (evaluations) return evaluations;
    const proposalProblem = validateProposal(r, r.capability);
    if (proposalProblem) return proposalProblem;
    if (r.proposal.type !== LONGITUDINAL_PROPOSAL_TYPE) return 'a longitudinal adaptation must carry a longitudinal proposal';
    const verdicts = r.proposal.verdicts;
    if (r.support.predictionIds.length !== verdicts.length) return 'adaptation support cites a different number of predictions than its proposal';
    if (r.support.evaluationIds.length !== verdicts.length) return 'adaptation support cites a different number of evaluations than its proposal';
    if (r.minSupport !== verdicts.length) return 'adaptation minSupport does not match the number of recorded observations';
    for (let i = 0; i < verdicts.length; i += 1) {
      if (r.support.predictionIds[i] !== verdicts[i].predictionId) return 'adaptation support names a different prediction than its proposal';
      if (r.support.evaluationIds[i] !== verdicts[i].evaluationId) return 'adaptation support names a different evaluation than its proposal';
    }
  } else if (outcomeDerived) {
    const evaluations = storedIdListProblem(r.support.evaluationIds, 'adaptation supporting evaluations', MAX_SUPPORT_REFS);
    if (evaluations) return evaluations;
    if (Array.isArray(r.support.predictionIds) && r.support.predictionIds.length > 0) {
      return 'an outcome-derived adaptation must not carry prediction evidence';
    }
    if (r.support.predictionIds !== undefined && !Array.isArray(r.support.predictionIds)) {
      return 'adaptation supporting predictions must be a list';
    }
    const proposalProblem = validateOutcomeProposal(r);
    if (proposalProblem) return proposalProblem;
    if (r.minSupport !== r.proposal.pattern.observations) {
      return 'adaptation minSupport does not match the observations its proposal states';
    }
  } else {
    if (r.support.predictionIds !== undefined || r.support.evaluationIds !== undefined) return 'a feedback-derived adaptation must not carry prediction evidence';
    if (r.proposal !== undefined) return 'a feedback-derived adaptation must not carry a prediction proposal';
  }
  for (const field of ['targetId', 'decision', 'assessment', 'experienceId']) {
    if (r[field] !== undefined) return `adaptation must not carry ${field}`;
  }
  const created = validateTimestamp(r.createdAt, 'createdAt');
  if (created) return created;
  return validateProvenance(r, ADAPTATION_KIND);
}

function validateDecision(r) {
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'decision record has missing or invalid id';
  if (typeof r.targetId !== 'string' || !ID_RE.test(r.targetId)) return 'decision record has missing or invalid targetId';
  if (!ADAPTATION_DECISIONS.includes(r.decision)) return 'unknown adaptation decision';
  const reason = optionalStoredTextProblem(r.reason, 'reason', MAX_REASON_CHARS);
  if (reason) return reason;
  const created = validateTimestamp(r.createdAt, 'createdAt');
  if (created) return created;
  return validateProvenance(r, DECISION_KIND);
}

function validateRetirement(r) {
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'retirement record has missing or invalid id';
  if (typeof r.targetId !== 'string' || !ID_RE.test(r.targetId)) return 'retirement record has missing or invalid targetId';
  const reason = optionalStoredTextProblem(r.reason, 'reason', MAX_REASON_CHARS);
  if (reason) return reason;
  const created = validateTimestamp(r.createdAt, 'createdAt');
  if (created) return created;
  return validateProvenance(r, RETIREMENT_KIND);
}

// A rollback is a user act on one measured regression. It names both the adaptation and the
// measurement that justified it, so a reader can always re-read the evidence behind a deactivation.
function validateRollback(r) {
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'rollback record has missing or invalid id';
  if (typeof r.targetId !== 'string' || !ID_RE.test(r.targetId)) return 'rollback record has missing or invalid targetId';
  if (typeof r.measurementId !== 'string' || !ID_RE.test(r.measurementId)) return 'rollback record has missing or invalid measurementId';
  const reason = optionalStoredTextProblem(r.reason, 'reason', MAX_REASON_CHARS);
  if (reason) return reason;
  const created = validateTimestamp(r.createdAt, 'createdAt');
  if (created) return created;
  return validateProvenance(r, ROLLBACK_KIND);
}

// A guidance record is allowed to name nothing but its own reason, because "I recorded the shape of
// this guidance" is a real act; what it may not do is name a shape the readers cannot check. So the
// fields are validated against the fixed vocabulary, not against each other, and an empty one is
// inert by construction rather than an error.
function validateGuidance(r) {
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'guidance record has missing or invalid id';
  if (typeof r.targetId !== 'string' || !ID_RE.test(r.targetId)) return 'guidance record has missing or invalid targetId';
  if (r.order !== null && !GUIDANCE_ORDERS.includes(r.order)) return `order must be one of: ${GUIDANCE_ORDERS.join(', ')}`;
  for (const field of ['avoid', 'prefer']) {
    const list = r[field];
    if (!Array.isArray(list) || list.length > MAX_GUIDANCE_NAMES) return `${field} must be a list of at most ${MAX_GUIDANCE_NAMES} capability names`;
    if (list.some((name) => typeof name !== 'string' || !CAPABILITY_RE.test(name))) return `${field} holds a name that is not a capability name`;
    if (new Set(list).size !== list.length) return `${field} names the same capability twice`;
  }
  if (r.maxSteps !== null && (!Number.isInteger(r.maxSteps) || r.maxSteps < 1 || r.maxSteps > MAX_GUIDANCE_STEPS)) {
    return `maxSteps must be null or an integer from 1 to ${MAX_GUIDANCE_STEPS}`;
  }
  const reason = optionalStoredTextProblem(r.reason, 'reason', MAX_REASON_CHARS);
  if (reason) return reason;
  const created = validateTimestamp(r.createdAt, 'createdAt');
  if (created) return created;
  return validateProvenance(r, GUIDANCE_KIND);
}

// ---- derived state ----------------------------------------------------------

function splitRecords(records) {
  const experiences = [];
  const feedback = [];
  const adaptations = [];
  const decisions = [];
  const retirements = [];
  const guidance = [];
  const reviews = [];
  const reviewDecisions = [];
  const evaluations = [];
  const measurements = [];
  const rollbacks = [];
  for (const record of records) {
    if (record.kind === EXPERIENCE_KIND) experiences.push(record);
    else if (record.kind === FEEDBACK_KIND) feedback.push(record);
    else if (record.kind === ADAPTATION_KIND) adaptations.push(record);
    else if (record.kind === DECISION_KIND) decisions.push(record);
    else if (record.kind === RETIREMENT_KIND) retirements.push(record);
    else if (record.kind === GUIDANCE_KIND) guidance.push(record);
    else if (record.kind === REVIEW_KIND) reviews.push(record);
    else if (record.kind === REVIEW_DECISION_KIND) reviewDecisions.push(record);
    else if (record.kind === EVALUATION_KIND) evaluations.push(record);
    else if (record.kind === MEASUREMENT_KIND) measurements.push(record);
    else if (record.kind === ROLLBACK_KIND) rollbacks.push(record);
    // A line that is none of the eight kinds is damage, and `deriveStore` has reported it that way
    // since Batch AD: it is counted by `health()` rather than filed under whichever kind happens to
    // be the last branch, which is what an `else` here would have done to a guidance record's
    // sibling.
  }
  return {
    experiences, feedback, adaptations, decisions, retirements, guidance, reviews, reviewDecisions,
    evaluations, measurements, rollbacks,
  };
}

// Every id named by a correction, followed transitively, so a chain retires each of its own earlier
// links. Transitive closure also handles a cycle: every member of a `replaces` loop is retired,
// which is the fail-closed answer to a hand-edited pair that claims to correct the other. `health()`
// reports the loop instead of this list silently picking a winner.
function correctionClosure(records, field) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const retired = new Set();
  const queue = [];
  for (const record of records) {
    for (const id of record[field] ?? []) {
      if (!retired.has(id)) {
        retired.add(id);
        queue.push(id);
      }
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    const target = byId.get(queue[i]);
    if (!target) continue;
    for (const id of target[field] ?? []) {
      if (!retired.has(id)) {
        retired.add(id);
        queue.push(id);
      }
    }
  }
  return retired;
}

// A correction chain retires each of its earlier links, and each retirement is legitimate because a
// record that still stands reaches it transitively. A retired record that no standing record reaches
// is retired only because it belongs to a loop, where the closure above retired every member.
// `health()` reports those records rather than letting the closure silently pick a winner.
function loopRetired(records, retired, field) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const reached = new Set();
  const queue = [];
  const add = (id) => {
    if (!reached.has(id)) {
      reached.add(id);
      queue.push(id);
    }
  };
  for (const record of records) {
    if (retired.has(record.id)) continue;
    for (const id of record[field] ?? []) add(id);
  }
  for (let i = 0; i < queue.length; i += 1) {
    for (const id of byId.get(queue[i])?.[field] ?? []) add(id);
  }
  return records.filter((r) => retired.has(r.id) && !reached.has(r.id));
}

function groupBy(values, key) {
  const out = new Map();
  for (const value of values) {
    const k = key(value);
    const list = out.get(k) ?? [];
    list.push(value);
    out.set(k, list);
  }
  return out;
}

function summarizeFeedback(entry) {
  return {
    id: entry.id,
    assessment: entry.assessment,
    guidance: entry.guidance ?? null,
    reason: entry.reason ?? null,
    createdAt: entry.createdAt,
    operationId: entry.provenance?.operationId ?? null,
    // Provenance is part of what a reader of feedback must see: it is the record of who said it.
    provenance: { origin: entry.provenance?.origin ?? null, updateMode: entry.provenance?.updateMode ?? null },
    supersedes: [...(entry.supersedes ?? [])],
  };
}

function summarizeDecision(event) {
  return {
    id: event.id,
    decision: event.decision,
    reason: event.reason ?? null,
    createdAt: event.createdAt,
    operationId: event.provenance?.operationId ?? null,
  };
}

// The shape of one guidance record, copied field by field rather than spread: a reader of an adaptation
// must see the four things the user named and nothing the log did not say, and an absent field is
// reported as null rather than as an empty list that reads like "avoid nothing in particular".
function summarizeGuidance(event) {
  return {
    id: event.id,
    order: event.order ?? null,
    avoid: [...(event.avoid ?? [])],
    prefer: [...(event.prefer ?? [])],
    maxSteps: event.maxSteps ?? null,
    reason: event.reason ?? null,
    createdAt: event.createdAt,
    operationId: event.provenance?.operationId ?? null,
  };
}

// One measurement, reduced to the counts and the verdict a reader needs. The windows' evaluation ids
// stay in the record; a summary that carried them would be a second, partial copy of the evidence.
function summarizeMeasurement(event) {
  return {
    id: event.id,
    verdict: event.verdict,
    baseline: {
      observations: event.baseline.observations,
      achieved: event.baseline.achieved,
      partiallyAchieved: event.baseline.partiallyAchieved,
      notAchieved: event.baseline.notAchieved,
    },
    followUp: {
      observations: event.followUp.observations,
      achieved: event.followUp.achieved,
      partiallyAchieved: event.followUp.partiallyAchieved,
      notAchieved: event.followUp.notAchieved,
    },
    minObservations: event.minObservations,
    createdAt: event.createdAt,
    operationId: event.provenance?.operationId ?? null,
  };
}

function summarizeRollback(event) {
  return {
    id: event.id,
    measurementId: event.measurementId,
    reason: event.reason ?? null,
    createdAt: event.createdAt,
    operationId: event.provenance?.operationId ?? null,
  };
}

function summarizeRetirement(event) {
  return {
    id: event.id,
    reason: event.reason ?? null,
    createdAt: event.createdAt,
    operationId: event.provenance?.operationId ?? null,
  };
}

function summarizeReviewDecision(event) {
  return {
    id: event.id,
    reviewId: event.reviewId,
    decision: event.decision,
    reviewedEvidenceDigest: event.reviewedEvidenceDigest,
    currentEvidenceDigest: event.currentEvidenceDigest,
    reportDigest: event.reportDigest ?? null,
    retirementId: event.retirementId ?? null,
    reason: event.reason ?? null,
    createdAt: event.createdAt,
    operationId: event.provenance?.operationId ?? null,
  };
}

// A review and every decision recorded against it. A later review of the same adaptation supersedes
// an earlier one by log order, which is the same rule every other derived state uses; the earlier
// record stays readable and is never rewritten.
function annotateReviews(index) {
  const decisionsByReview = groupBy(index.reviewDecisions, (d) => d.reviewId);
  const position = new Map(index.reviews.map((review, i) => [review.id, i]));
  const targetGroups = groupBy(index.reviews, (r) => r.targetId);
  return index.reviews.map((review) => {
    const decisions = decisionsByReview.get(review.id) ?? [];
    const latest = decisions.length > 0 ? decisions.at(-1) : null;
    const order = position.get(review.id) ?? 0;
    const supersededBy = (targetGroups.get(review.targetId) ?? [])
      .filter((other) => (position.get(other.id) ?? 0) > order)
      .map((other) => other.id);
    let awaitingEvidence = false;
    try {
      awaitingEvidence = reviewAwaitingEvidence(review.evidence);
    } catch {
      // A stored review that passed record validation always canonicalises; if it does not, the
      // evidence is damaged and health reports it. The review itself stays readable as history.
      awaitingEvidence = true;
    }
    return {
      ...review,
      decisions: decisions.slice(-MAX_SAMPLES).map(summarizeReviewDecision),
      decisionCount: decisions.length,
      decision: latest ? summarizeReviewDecision(latest) : null,
      awaitingEvidence,
      supersededBy,
      current: supersededBy.length === 0,
    };
  });
}

// The one derivation used by every reader, so no two paths can report different lifecycle state
// for the same bytes. Cost is linear in the store; nothing is indexed across reads.
function deriveStore(records) {
  const index = splitRecords(records);
  const retiredExperiences = correctionClosure(index.experiences, 'replaces');
  const retiredFeedback = correctionClosure(index.feedback, 'supersedes');
  const feedbackByExperience = groupBy(index.feedback, (f) => f.experienceId);
  const replacedBy = new Map();
  for (const record of index.experiences) {
    for (const id of record.replaces ?? []) {
      const list = replacedBy.get(id) ?? [];
      list.push(record.id);
      replacedBy.set(id, list);
    }
  }
  const experiences = index.experiences.map((record) => annotateExperience(record, {
    feedbackByExperience,
    replacedBy,
    retiredExperiences,
    retiredFeedback,
  }));
  const adaptations = annotateAdaptations(index, { retiredExperiences, retiredFeedback });
  const reviews = annotateReviews(index);
  return { index, retiredExperiences, retiredFeedback, experiences, adaptations, reviews };
}

// The shape every temporal reader consumes, built over one record list and its derivation. The
// position map spans every record kind, because the file holds all of them and a tie inside one
// timestamp is broken by where the record sits in the log. Both the live read and the cutoff replay
// are built here, so a historical view cannot quietly differ from the current one in how it is shaped.
function temporalSourceOf(records, derived) {
  const position = new Map();
  for (let i = 0; i < records.length; i += 1) position.set(records[i].id, i);
  return {
    experiences: derived.experiences,
    feedback: derived.index.feedback,
    retiredFeedback: derived.retiredFeedback,
    adaptations: derived.adaptations,
    position,
  };
}

function annotateExperience(record, { feedbackByExperience, replacedBy, retiredExperiences, retiredFeedback }) {
  const entries = feedbackByExperience.get(record.id) ?? [];
  const current = entries.filter((f) => !retiredFeedback.has(f.id));
  return {
    ...record,
    active: !retiredExperiences.has(record.id),
    superseded: retiredExperiences.has(record.id),
    // How this event entered the log, so a reader can tell the user's own record from one APEX
    // captured, and never reads a captured outcome as a judgement the user made.
    capture: captureOf(record),
    replaces: [...(record.replaces ?? [])],
    replacedBy: replacedBy.get(record.id) ?? [],
    feedbackCount: current.length,
    feedbackTotal: entries.length,
    feedbackCorrected: entries.length - current.length,
    assessments: [...new Set(current.map((f) => f.assessment))],
    latestFeedback: current.length > 0 ? summarizeFeedback(current.at(-1)) : null,
    feedbackSamples: current.slice(-MAX_SAMPLES).map(summarizeFeedback),
    feedbackTruncated: current.length > MAX_SAMPLES,
  };
}

// Derives each adaptation's state from the events that name it. No record stores a status, so an
// adaptation is reported active only when a user decision says approved, no retirement names it,
// and every piece of its supporting evidence is still present and still current. Anything else is
// a candidate, history, or ambiguous - and each reader says which.
function annotateAdaptations(index, { retiredExperiences, retiredFeedback }) {
  const experiencesById = new Map(index.experiences.map((r) => [r.id, r]));
  const feedbackById = new Map(index.feedback.map((r) => [r.id, r]));
  const retirementsByTarget = groupBy(index.retirements, (r) => r.targetId);
  const decisionsByTarget = groupBy(index.decisions, (r) => r.targetId);
  const guidanceByTarget = groupBy(index.guidance ?? [], (g) => g.targetId);
  const measurementsByTarget = groupBy(index.measurements ?? [], (m) => m.targetId);
  const rollbacksByTarget = groupBy(index.rollbacks ?? [], (r) => r.targetId);

  const annotated = index.adaptations.map((record) => {
    const events = decisionsByTarget.get(record.id) ?? [];
    const retirements = retirementsByTarget.get(record.id) ?? [];
    const guidanceEvents = guidanceByTarget.get(record.id) ?? [];
    const latest = events.length > 0 ? events.at(-1) : null;
    const missingExperiences = record.support.experienceIds.filter((id) => !experiencesById.has(id));
    const missingFeedback = record.support.feedbackIds.filter((id) => !feedbackById.has(id));
    const staleExperiences = record.support.experienceIds.filter((id) => retiredExperiences.has(id));
    const staleFeedback = record.support.feedbackIds.filter((id) => retiredFeedback.has(id));
    const supportIntact = missingExperiences.length === 0
      && missingFeedback.length === 0
      && staleExperiences.length === 0
      && staleFeedback.length === 0;

    let decisionState;
    if (retirements.length > 1) decisionState = 'ambiguous';
    else if (retirements.length === 1) decisionState = 'retired';
    else if (!latest) decisionState = 'candidate';
    else if (latest.decision === 'rejected') decisionState = 'rejected';
    else decisionState = 'approved';

    let inactiveReason = null;
    if (decisionState === 'approved' && !supportIntact) {
      inactiveReason = missingExperiences.length > 0 || staleExperiences.length > 0
        ? 'a supporting experience no longer stands as recorded evidence'
        : 'a piece of supporting feedback has been corrected by later feedback';
    }

    // Measurement and rollback are derived the same way every other state here is: from the events
    // that name this adaptation. A measurement never activates anything, and a rollback never erases
    // the approval or the evidence behind it - it only takes the rule out of force.
    const measurementEvents = measurementsByTarget.get(record.id) ?? [];
    const latestMeasurement = measurementEvents.length > 0 ? measurementEvents.at(-1) : null;
    const rollbackEvents = rollbacksByTarget.get(record.id) ?? [];
    const rolledBack = rollbackEvents.length > 0;
    if (decisionState === 'approved' && rolledBack) {
      inactiveReason = 'a recorded measurement showed a regression, and you rolled this rule back';
    }
    const inForce = decisionState === 'approved' && supportIntact && !rolledBack;
    let stage;
    if (rolledBack) stage = 'rolled_back';
    else if (decisionState === 'retired') stage = 'retired';
    else if (decisionState === 'ambiguous') stage = 'ambiguous';
    else if (decisionState === 'rejected') stage = 'rejected';
    else if (decisionState === 'approved') {
      if (!inForce) stage = 'authorized';
      else if (latestMeasurement && latestMeasurement.verdict !== 'insufficient_evidence') {
        stage = latestMeasurement.verdict === 'regressed' ? 'measured' : 'retained';
      } else stage = 'active';
    } else stage = record.proposal ? 'evaluated' : 'proposed';

    // A prediction-derived candidate arrives carrying its own shape: the typed proposal is what the
    // recorded outcome states, so approval alone can put it in force. A guidance record the user writes
    // afterwards restates the shape and supersedes the proposal's, exactly as it supersedes an earlier
    // guidance record. `source` says which of the two a reader is looking at, and `basis` says whether
    // the rule rests on one evaluation or on a supported longitudinal pattern.
    const outcomeDerived = record.method === OBSERVED_OUTCOME_METHOD;
    const proposal = isPredictionDerived(record.method) || outcomeDerived ? record.proposal ?? null : null;
    const recordedGuidance = guidanceEvents.length > 0 ? guidanceEvents.at(-1) : null;
    const effectiveGuidance = recordedGuidance
      ? { ...summarizeGuidance(recordedGuidance), source: 'record' }
      : proposal
        ? {
          id: record.id,
          order: proposal.guidance.order,
          avoid: [...proposal.guidance.avoid],
          prefer: [...proposal.guidance.prefer],
          maxSteps: proposal.guidance.maxSteps,
          reason: null,
          createdAt: record.createdAt,
          operationId: record.provenance?.operationId ?? null,
          source: 'proposal',
        }
        : null;

    return {
      ...record,
      // How this candidate was produced. The two derivation sources are never pooled: a reader can tell
      // a rule the user's corrections support from one a recorded outcome proposes, and neither claims
      // the other. `basis` separates the single observation from the supported pattern inside the
      // prediction source, because the two rest on different amounts of evidence.
      source: isPredictionDerived(record.method) ? 'prediction' : outcomeDerived ? 'outcome' : 'feedback',
      basis: outcomeDerived ? 'recorded_outcome_pattern' : derivationBasis(record.method),
      proposal,
      pattern: proposal?.pattern ? { ...proposal.pattern } : null,
      decisionState,
      active: inForce,
      inactiveReason,
      // The governed lifecycle, stated from the records that exist. `authorized` is approval whose rule
      // is not in force; `measured`/`retained` are a measurement's two non-regressing answers.
      stage,
      rolledBack,
      rollback: rollbackEvents.length > 0 ? summarizeRollback(rollbackEvents.at(-1)) : null,
      measurement: latestMeasurement ? summarizeMeasurement(latestMeasurement) : null,
      measurementCount: measurementEvents.length,
      retired: decisionState === 'retired',
      ambiguous: decisionState === 'ambiguous',
      retirement: retirements.length === 1 ? summarizeRetirement(retirements[0]) : null,
      decisions: events.slice(-MAX_SAMPLES).map(summarizeDecision),
      decision: latest ? summarizeDecision(latest) : null,
      // The shape in force, as the last record of it names it. Store order governs, as with a decision:
      // a later record restates the shape and every earlier one stays readable. An adaptation with no
      // guidance record answers questions about its rule text and nothing else, and no reader may treat
      // the absence as "the user asked for nothing in particular".
      guidance: effectiveGuidance,
      guidanceCount: guidanceEvents.length,
      shapeSource: effectiveGuidance?.source ?? null,
      shapeVersion: guidanceEvents.length > 0 ? guidanceEvents.length : (proposal ? 1 : null),
      guidanceHistory: guidanceEvents.slice(-MAX_SAMPLES).map(summarizeGuidance),
      supportState: supportIntact ? 'intact' : 'stale',
      supportProblems: [
        ...missingExperiences.map((id) => `supporting experience ${shortId(id)} is not in the store`),
        ...missingFeedback.map((id) => `supporting feedback ${shortId(id)} is not in the store`),
        ...staleExperiences.map((id) => `supporting experience ${shortId(id)} was corrected by a later record`),
        ...staleFeedback.map((id) => `supporting feedback ${shortId(id)} was corrected by later feedback`),
      ],
      conflicts: [],
    };
  });

  // Conflicts stay visible. Two active adaptations in one scope whose rules differ are both
  // reported, each naming the other and repeating its rule, so retrieval shows a disagreement
  // instead of choosing a winner the user never chose.
  const activeByScope = groupBy(annotated.filter((a) => a.active), (a) => a.capability);
  for (const group of activeByScope.values()) {
    if (new Set(group.map((r) => r.ruleHash)).size < 2) continue;
    for (const record of group) {
      record.conflicts = group
        .filter((o) => o.id !== record.id && o.ruleHash !== record.ruleHash)
        .slice(0, MAX_SAMPLES)
        .map((o) => ({ id: o.id, capability: o.capability, rule: o.rule }));
    }
  }
  return annotated;
}

// `capability` may name one capability exactly, or a family of them (`memory` covers `memory.add`).
// A capability never matches a name it does not prefix, so a rule asked for when adding memories is
// not returned for a lookup. With no capability to compare, every active adaptation is in scope and
// `scopesNamedIn` only ranks them.
function scopeMatches(adaptation, { capability }) {
  if (typeof capability !== 'string' || capability.length === 0) return true;
  const scopeParts = String(adaptation.capability).toLowerCase().split('.');
  const parts = capability.toLowerCase().split('.');
  return scopeParts.length <= parts.length && parts.slice(0, scopeParts.length).join('.') === scopeParts.join('.');
}

// Whether the request happens to name this adaptation's scope. Used only to order retrieval, so a
// bound on the number of adaptations cuts the ones least related to the request first.
function scopesNamedIn(adaptation, terms) {
  return tokenize(String(adaptation.capability).toLowerCase()).some((t) => terms.has(t));
}

// Whether one capability name falls inside another's scope. The same family rule the existing
// retrieval uses: `memory` covers `memory.add`, and a name never matches one it does not prefix.
function scopeIncludes(name, scope) {
  if (typeof name !== 'string' || typeof scope !== 'string') return false;
  return name === scope || name.startsWith(`${scope}.`) || scope.startsWith(`${name}.`);
}

function matchesRef(record, ref, extraIds = []) {
  if (record.id === ref) return true;
  if (record.id.startsWith(ref)) return true;
  if (shortId(record.id) === ref) return true;
  return extraIds.some((value) => value === ref || String(value).startsWith(ref) || shortId(String(value)) === ref);
}

// The largest id list `evidenceIndex` will resolve in one call. A caller that names more ids than
// this is refusing to bound its own read, so it is an error rather than a silent truncation.
const MAX_INDEX_IDS = 100;

function indexIdList(values, label) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new ValidationError(`${label} must be a list of record ids`);
  if (values.length > MAX_INDEX_IDS) throw new ValidationError(`${label} may name at most ${MAX_INDEX_IDS} records`);
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64 || CONTROL_CHARS.test(value)) {
      throw new ValidationError(`${label} has an invalid id`);
    }
    seen.add(value.trim());
  }
  return [...seen].sort();
}

// When an event happened, and which field said so. Same precedence the temporal view uses: a finished
// operation is timed by its completion, then its request, then its record. `source` is reported so a
// reader can see which of the three a timestamp came from. Exported because a cross-store historical
// read must report event time exactly as this store's own temporal view does.
export function occurredAtOf(record) {
  for (const source of ['finishedAt', 'requestedAt', 'createdAt']) {
    const ms = parseInstant(record?.[source]);
    if (ms !== null) return { ms, source };
  }
  return { ms: null, source: null };
}

// ---- ExperienceStore --------------------------------------------------------

export class ExperienceStore {
  constructor(filePath, {
    now = () => new Date(),
    operations = null,
    predictions = null,
    parseCacheBytes = EXPERIENCE_PARSE_CACHE_BYTES,
    lockWaitMs,
    lockRetryMs,
    lockRetryMaxMs,
  } = {}) {
    this.filePath = filePath;
    this.now = now;
    // The audit log an experience must reference. Reads work without it; every experience write
    // refuses, because an unverified pointer would be a claim about an event nothing can confirm.
    this.operations = operations;
    // The prediction ledger a prediction-derived candidate is checked against on every read. Feedback
    // derivation works without it; a prediction-derived candidate is reported inert when it is absent,
    // because "the evidence may have changed" cannot be answered by a store that does not hold it.
    this.predictions = predictions;
    this.log = new JsonlStore(filePath, { validateRecord: validateExperienceRecord, parseCacheBytes });
    // Each write derives its decision from the whole authoritative log - what is already recorded
    // for that operation, which feedback is still current, which candidates exist - and then
    // appends. The lock covers read-derive-append for one store, so two processes cannot each
    // decide from a state the other has not written yet.
    this.writeLock = new WriterLock(filePath, { waitMs: lockWaitMs, retryMs: lockRetryMs, retryMaxMs: lockRetryMaxMs });
  }

  // The two stores are constructed in one direction (the prediction store already holds this one for
  // its evidence reads), so the reverse edge is attached rather than passed through the constructor.
  // Until it is attached, feedback-derived records behave exactly as they did and every prediction-
  // derived record is reported inert.
  attachPredictions(store) {
    this.predictions = store;
    return this;
  }

  #requireUser(origin, what) {
    if (origin !== 'user') {
      throw new ValidationError(
        `${what} requires an authorized user-origin operation; model output cannot write experience evidence, feedback, or adaptation state`,
        'WRITE_REQUIRES_USER_ORIGIN',
      );
    }
  }

  // --- writes ----------------------------------------------------------------

  // Record one audited event as an experience. `operationId` names the audit record and its
  // structural evidence is copied from it, hashed so a later reader can prove the two still agree.
  // `replaces` corrects an earlier experience; the corrected record stays in the log.
  // `capture` says how the request arrived: `explicit` (the user named the operation) or
  // `automatic` (APEX captured a verified outcome). Both require a user-origin operation; neither
  // writes feedback, an assessment, or any adaptation state.
  async recordExperience({ operationId, subject, replaces = [], provenance = {}, capture = CAPTURE_EXPLICIT, origin } = {}) {
    this.#requireUser(origin, 'recording an experience');
    if (!CAPTURE_VALUES.includes(capture)) {
      throw new ValidationError(`an experience is recorded as either ${CAPTURE_EXPLICIT} or ${CAPTURE_AUTOMATIC} captured`);
    }
    const opRef = validateOperationRef(operationId);
    const label = validateTextField(subject, 'subject', { max: MAX_SUBJECT_CHARS });
    const refs = validateRefList(replaces, 'corrected experience', MAX_SUPERSEDES);
    const recorded = sanitizeProvenance(provenance, EXPERIENCE_KIND, { capture });
    return this.writeLock.run(() => this.#recordExperienceFromAuthority({ opRef, label, refs, recorded }));
  }

  async #recordExperienceFromAuthority({ opRef, label, refs, recorded }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const { index, retiredExperiences } = deriveStore(records);
    const targets = resolveReplacedExperiences(index.experiences, refs, retiredExperiences);
    const targetIds = new Set(targets.map((r) => r.id));

    const live = index.experiences.filter((r) => r.operationId === opRef && !retiredExperiences.has(r.id));
    if (live.length > 0 && !(live.length === 1 && targetIds.has(live[0].id))) {
      throw new ValidationError(
        `operation [${shortId(opRef)}] already has a recorded experience${live.length > 1 ? ', and a duplicate of it' : ''}; correct it by naming that record in replaces`,
        'EXPERIENCE_EXISTS',
      );
    }

    const audit = await this.#auditRecord(opRef);
    const evidence = evidenceFromOperation(audit);
    // An experience whose outcome is not a recorded outcome, or whose capability cannot name a
    // scope, is still a real event and stays recordable; it is simply not usable as adaptation
    // support, and the record says so instead of leaving a reader to guess.
    const adaptationEligible = isScopableCapability(evidence.capability) && OUTCOME_VALUES.has(evidence.status);

    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');

    const record = {
      schema: EXPERIENCE_SCHEMA,
      kind: EXPERIENCE_KIND,
      id,
      operationId: opRef,
      capability: evidence.capability,
      subject: label,
      outcome: evidence.status,
      decision: evidence.decision,
      origin: evidence.origin,
      requestedAt: evidence.requestedAt,
      finishedAt: evidence.finishedAt,
      evidence,
      evidenceSha256: evidenceSha(evidence),
      adaptationEligible,
      createdAt: this.now().toISOString(),
      provenance: recorded,
      ...(targets.length > 0 ? { replaces: targets.map((r) => r.id) } : {}),
    };
    const problem = validateExperienceRecord(record);
    if (problem) throw new StoreError(`the recorded experience failed validation (${problem}); nothing written`);
    await this.log.append(record);
    return { record, supersededIds: targets.map((r) => r.id) };
  }

  // The audit record behind a reference, or a refusal. Absence is a refusal: the event was never
  // recorded, so there is nothing to have experienced.
  async #auditRecord(opRef) {
    if (!this.operations || typeof this.operations.findById !== 'function') {
      throw new ValidationError('an experience must reference an audited operation, and no audit log is configured for this store');
    }
    let found;
    try {
      found = await this.operations.findById(opRef);
    } catch (err) {
      if (err instanceof StoreError) throw err;
      throw new StoreError(`cannot read the audit log to record an experience: ${err?.message ?? String(err)}`);
    }
    if (!found?.found || !found.record) {
      throw new ValidationError(`operation [${shortId(opRef)}] is not in the audit log; an experience can only reference an event that was actually recorded`);
    }
    return found.record;
  }

  // The user's own assessment of one recorded event. `target` may be an experience id or the
  // operation id of an event that has one, so feedback always lands on an identifiable experience.
  // Previous feedback is never rewritten: a correction is a new record naming what it supersedes.
  async recordFeedback({ target, assessment, guidance = null, reason = null, supersedes = [], provenance = {}, origin } = {}) {
    this.#requireUser(origin, 'recording feedback');
    if (typeof assessment !== 'string' || !ASSESSMENTS.includes(assessment)) {
      throw new ValidationError(`assessment must be one of ${ASSESSMENTS.join(', ')}`);
    }
    const ref = validateRef(target, 'feedback target');
    const guidanceText = validateTextField(guidance, 'guidance', { required: false, max: MAX_RULE_CHARS });
    const reasonText = validateTextField(reason, 'reason', { required: false, max: MAX_REASON_CHARS });
    const refs = validateRefList(supersedes, 'superseded feedback', MAX_SUPERSEDES);
    const recorded = sanitizeProvenance(provenance, FEEDBACK_KIND);
    return this.writeLock.run(() => this.#feedbackFromAuthority({ ref, assessment, guidanceText, reasonText, refs, recorded }));
  }

  async #feedbackFromAuthority({ ref, assessment, guidanceText, reasonText, refs, recorded }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const { index, retiredExperiences, retiredFeedback } = deriveStore(records);
    const experience = await this.#resolveExperienceRef(index.experiences, ref, retiredExperiences);
    const targets = resolveSupersededFeedback(index.feedback, refs, retiredFeedback, experience.id);

    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');

    const record = {
      schema: EXPERIENCE_SCHEMA,
      kind: FEEDBACK_KIND,
      id,
      experienceId: experience.id,
      assessment,
      ...(guidanceText ? { guidance: guidanceText } : {}),
      ...(reasonText ? { reason: reasonText } : {}),
      createdAt: this.now().toISOString(),
      provenance: recorded,
      ...(targets.length > 0 ? { supersedes: targets.map((r) => r.id) } : {}),
    };
    const problem = validateExperienceRecord(record);
    if (problem) throw new StoreError(`the recorded feedback failed validation (${problem}); nothing written`);
    await this.log.append(record);
    return { record, experience, supersededIds: targets.map((r) => r.id) };
  }

  // One experience from a reference that may also be an operation id. Missing and ambiguous both
  // refuse, and a corrected experience is not a valid target: the live record that replaced it is
  // where feedback belongs. When nothing matches, the audit log is asked whether the reference is
  // at least a real audited operation, because only that case has a next step the user can take.
  async #resolveExperienceRef(experiences, ref, retired) {
    const exact = experiences.filter((r) => r.id === ref || r.operationId === ref);
    if (exact.length === 1) {
      if (retired.has(exact[0].id)) {
        throw new ValidationError(`experience [${shortId(exact[0].id)}] was corrected by a later record; give feedback on the record that replaced it`);
      }
      return exact[0];
    }
    if (exact.length > 1) {
      throw new ValidationError(`that reference matches ${exact.length} recorded experiences; use a full id`);
    }
    const byPrefix = experiences.filter((r) => matchesRef(r, ref, [r.operationId]));
    const live = byPrefix.filter((r) => !retired.has(r.id));
    if (live.length === 1) return live[0];
    if (live.length > 1) throw new ValidationError('the feedback target is ambiguous; use a longer id prefix');
    if (byPrefix.length > 0) {
      throw new ValidationError('the feedback target is an experience that a later record corrected; give feedback on the record that replaced it');
    }
    if (OPERATION_ID_RE.test(ref) && this.operations && typeof this.operations.findById === 'function') {
      let inAudit;
      try {
        inAudit = (await this.operations.findById(ref))?.found === true;
      } catch {
        throw new ValidationError('the feedback target was not found, and the audit log could not be read to check it');
      }
      if (inAudit) {
        throw new ValidationError(`operation [${shortId(ref)}] is in the audit log but has no recorded experience; record the experience first`);
      }
    }
    throw new ValidationError('feedback target not found; it must be a recorded experience or an operation that has one');
  }

  // Deterministic candidate derivation over the stored evidence, appended as candidates. The rule
  // lives in derivation.js; this supplies the live records and writes what comes back.
  async deriveAdaptations({ minSupport = MIN_SUPPORT_FEEDBACK, provenance = {}, origin } = {}) {
    this.#requireUser(origin, 'deriving a candidate adaptation');
    if (!Number.isInteger(minSupport) || minSupport < 1 || minSupport > MAX_SUPPORT_REFS) {
      throw new ValidationError(`minSupport must be an integer from 1 to ${MAX_SUPPORT_REFS}`);
    }
    const recorded = sanitizeProvenance(provenance, ADAPTATION_KIND);
    return this.writeLock.run(() => this.#deriveFromAuthority({ recorded, minSupport }));
  }

  async #deriveFromAuthority({ recorded, minSupport }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const { index, retiredExperiences, retiredFeedback, experiences: derivedExperiences } = deriveStore(records);
    const retiredTargets = new Set(index.retirements.map((r) => r.targetId));
    const experiences = derivedExperiences.filter((r) =>
      !retiredExperiences.has(r.id) && r.adaptationEligible === true && isScopableCapability(r.capability));

    const specs = deriveCandidateSpecs({
      experiences,
      feedback: index.feedback,
      supersededFeedbackIds: [...retiredFeedback],
      existingAdaptations: index.adaptations.map((a) => ({ capability: a.capability, rule: a.rule, retired: retiredTargets.has(a.id) })),
      minSupport,
    });

    const created = [];
    const skipped = specs.skipped.map((s) => ({ ...s, source: 'feedback' }));
    for (const spec of specs.created) {
      if (spec.support.experienceIds.length > MAX_SUPPORT_REFS || spec.support.feedbackIds.length > MAX_SUPPORT_REFS) {
        skipped.push({
          source: 'feedback',
          capability: spec.capability,
          reason: `its supporting evidence is larger than the ${MAX_SUPPORT_REFS} reference bound for one adaptation`,
          supportingExperienceIds: spec.support.experienceIds.slice(0, MAX_HEALTH_SAMPLES),
        });
        continue;
      }
      const id = randomUUID();
      if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
      const record = {
        schema: EXPERIENCE_SCHEMA,
        kind: ADAPTATION_KIND,
        id,
        capability: spec.capability,
        rule: spec.rule,
        ruleHash: sha256Hex(normalizeRuleText(spec.rule)),
        method: DERIVATION_METHOD,
        minSupport: specs.minSupport,
        support: { experienceIds: spec.support.experienceIds, feedbackIds: spec.support.feedbackIds },
        createdAt: this.now().toISOString(),
        provenance: recorded,
      };
      const problem = validateExperienceRecord(record);
      if (problem) throw new StoreError(`the derived candidate failed validation (${problem}); nothing written`);
      await this.log.append(record);
      created.push(record);
    }

    // The feedback candidates just written are part of what a prediction-derived proposal must not
    // duplicate, so they join the taken set before the second derivation runs.
    const taken = new Set(index.adaptations
      .filter((a) => !retiredTargets.has(a.id))
      .map((a) => proposalKey(a.capability, a.rule)));
    for (const record of created) taken.add(proposalKey(record.capability, record.rule));
    const prediction = await this.#derivePredictionCandidates({
      index,
      experiencesById: new Map(derivedExperiences.map((r) => [r.id, r])),
      recorded,
      taken,
      records,
    });
    created.push(...prediction.created);
    skipped.push(...prediction.skipped);

    return { created, skipped, minSupport: specs.minSupport, prediction: prediction.report };
  }

  // The second, separate derivation: one eligible recorded outcome proposes one candidate. It reads the
  // prediction ledger once, judges every expectation with the same rule the read path uses, and appends
  // nothing unless the user asked for a derivation - an evaluation still approves and derives nothing.
  // A scope-and-rule pair already stated by a candidate that has not been retired is not restated, so two
  // evaluations of the same capability cannot double the influence one rule has.
  async #derivePredictionCandidates({ index, experiencesById, recorded, taken, records }) {
    const report = {
      available: false,
      reason: null,
      considered: 0,
      eligible: 0,
      ineligible: 0,
      created: 0,
      truncated: false,
      limit: MAX_PREDICTION_CANDIDATES,
      // The longitudinal pass is reported beside the single-evaluation one even when it proposed
      // nothing: "no scope holds a supported pattern" and "the read was bounded" are different facts.
      longitudinal: {
        groups: 0,
        supported: 0,
        created: 0,
        coveredCapabilities: [],
        skipped: [],
      },
    };
    if (!this.predictions || typeof this.predictions.list !== 'function') {
      report.reason = 'no prediction ledger is attached to this store, so no recorded outcome was read';
      return { created: [], skipped: [], report };
    }
    let ledger;
    try {
      ledger = await this.predictions.list({ limit: MAX_PREDICTION_CANDIDATES });
    } catch (err) {
      report.available = true;
      report.reason = `the prediction ledger could not be read: ${err?.message ?? String(err)}`;
      return { created: [], skipped: [], report };
    }
    report.available = true;
    report.truncated = ledger.truncated === true;
    const projections = ledger.projections ?? [];
    report.considered = projections.length;
    if (report.truncated) {
      report.reason = `only the most recent ${MAX_PREDICTION_CANDIDATES} of ${ledger.total ?? projections.length} expectation(s) were read; an older one is not considered by this derivation`;
    }

    const created = [];
    const skipped = [];
    // Evidence already cited by a candidate that has not been retired. Re-citing it would let one
    // recorded evaluation move two rules, which is the double-count the derivation is meant to refuse.
    const retiredTargets = new Set(index.retirements.map((r) => r.targetId));
    const claimed = new Set();
    for (const record of index.adaptations) {
      if (retiredTargets.has(record.id)) continue;
      for (const id of record.support?.predictionIds ?? []) claimed.add(id);
    }

    // The longitudinal pass runs first and claims the scopes it describes. A scope holding a supported
    // pattern is not also reduced to a rule read from one of its members: the pattern is the stronger
    // statement the records support, and a single observation beside it would present the same evidence
    // twice. Scopes whose pattern states no direction fall through to the single-evaluation pass.
    const analysis = analyzeLongitudinal({
      projections,
      experiencesById,
      readTotal: ledger.total ?? projections.length,
      readTruncated: report.truncated,
      now: this.now().toISOString(),
    });
    report.longitudinal.groups = analysis.totals.groups;
    const covered = new Map();
    for (const group of analysis.groups) {
      // A pattern the analysis itself withheld (a bounded prefix or a window that moved) is reported
      // as skipped, not supported: the rule must not be derived from a read that is not a history.
      if (group.pattern.withheld) {
        report.longitudinal.skipped.push({
          capability: group.capability,
          pattern: group.pattern.kind,
          reason: group.pattern.withheldReason,
        });
        continue;
      }
      if (!group.pattern.sufficient) continue;
      report.longitudinal.supported += 1;
      covered.set(group.capability, { kind: group.pattern.kind, created: false });
      report.longitudinal.coveredCapabilities.push(group.capability);
      if (report.truncated || group.observationsTruncated) {
        report.longitudinal.skipped.push({
          capability: group.capability,
          pattern: group.pattern.kind,
          reason: 'the prediction read was bounded, so an observation outside it could change this pattern; a rule is not derived from a partial sequence',
        });
        continue;
      }
      const proposal = longitudinalProposalFor(group);
      const rule = longitudinalRule(group.capability, group.pattern.kind, group.pattern.observations);
      if (!proposal || !rule) continue;
      const key = proposalKey(group.capability, rule);
      if (taken.has(key)) {
        report.longitudinal.skipped.push({
          capability: group.capability,
          pattern: group.pattern.kind,
          reason: 'a candidate that has not been retired already states this rule for this scope',
        });
        continue;
      }
      const cited = group.evidenceRefs.predictionIds;
      const alreadyClaimed = cited.filter((id) => claimed.has(id));
      if (alreadyClaimed.length > 0) {
        report.longitudinal.skipped.push({
          capability: group.capability,
          pattern: group.pattern.kind,
          reason: `its evidence is already cited by a candidate that has not been retired (${alreadyClaimed.map((id) => shortId(id)).join(', ')})`,
        });
        continue;
      }
      if (group.evidenceRefs.truncated
        || cited.length < MIN_REPEATED_OBSERVATIONS || cited.length > MAX_LONGITUDINAL_OBSERVATIONS) {
        report.longitudinal.skipped.push({
          capability: group.capability,
          pattern: group.pattern.kind,
          reason: `its evidence spans ${cited.length} prediction(s), and a candidate carries between ${MIN_REPEATED_OBSERVATIONS} and ${MAX_LONGITUDINAL_OBSERVATIONS}`,
        });
        continue;
      }
      const experienceIds = [...new Set(group.evidenceRefs.experienceIds)];
      if (experienceIds.length === 0 || experienceIds.length > MAX_SUPPORT_REFS) {
        report.longitudinal.skipped.push({
          capability: group.capability,
          pattern: group.pattern.kind,
          reason: `its observations cite ${experienceIds.length} outcome record(s), and a candidate carries between 1 and ${MAX_SUPPORT_REFS}`,
        });
        continue;
      }
      const id = randomUUID();
      if (records.some((r) => r.id === id) || created.some((r) => r.id === id)) {
        throw new StoreError('identifier collision; nothing written');
      }
      const record = {
        schema: EXPERIENCE_SCHEMA,
        kind: ADAPTATION_KIND,
        id,
        capability: group.capability,
        rule,
        ruleHash: sha256Hex(normalizeRuleText(rule)),
        method: LONGITUDINAL_DERIVATION_METHOD,
        minSupport: proposal.pattern.observations,
        support: {
          experienceIds,
          feedbackIds: [],
          predictionIds: [...group.evidenceRefs.predictionIds],
          evaluationIds: [...group.evidenceRefs.evaluationIds],
        },
        proposal,
        createdAt: this.now().toISOString(),
        provenance: recorded,
      };
      const problem = validateExperienceRecord(record);
      if (problem) throw new StoreError(`the derived longitudinal candidate failed validation (${problem}); nothing written`);
      await this.log.append(record);
      created.push(record);
      for (const predictionId of cited) claimed.add(predictionId);
      taken.add(key);
      covered.get(group.capability).created = true;
      report.longitudinal.created += 1;
    }

    for (const projection of projections) {
      // A scope the longitudinal pass described is answered there, whether or not it produced a
      // candidate; reducing it to one observation would state the same evidence a second time.
      const coverage = covered.get(projection.capability);
      if (coverage) {
        if (projection.status === 'evaluated') {
          skipped.push({
            source: 'prediction',
            predictionId: projection.id,
            capability: projection.capability,
            reason: `its scope's recorded outcomes support a ${coverage.kind} pattern, so a single-observation rule is not derived${coverage.created ? '' : ' and the pattern candidate was not created'}`,
          });
        }
        continue;
      }
      const eligibility = predictionEligibility({ projection, experiencesById });
      if (!eligibility.eligible) {
        report.ineligible += 1;
        // Only an expectation that was actually evaluated is reported here: the rest are the subject of
        // the eligibility read, and listing them in a derivation result would bury the candidates.
        if (projection.status === 'evaluated') {
          skipped.push({
            source: 'prediction',
            predictionId: projection.id,
            capability: projection.capability ?? null,
            reason: `its recorded outcome cannot propose a rule: ${eligibility.reason}`,
            eligibility: eligibility.state,
          });
        }
        continue;
      }
      report.eligible += 1;
      const proposal = proposalFor({ projection, experiencesById });
      const deciding = decidingOutcomeOf(projection, experiencesById);
      const rule = proposalRule(projection.capability, deciding.outcomeClass);
      const key = proposalKey(projection.capability, rule);
      if (taken.has(key)) {
        skipped.push({
          source: 'prediction',
          predictionId: projection.id,
          capability: projection.capability,
          reason: 'a candidate that has not been retired already states this rule for this scope, so this outcome is not counted again',
        });
        continue;
      }
      const experienceIds = [...new Set(projection.evaluation.outcomeExperienceIds)];
      if (experienceIds.length === 0 || experienceIds.length > MAX_SUPPORT_REFS) {
        skipped.push({
          source: 'prediction',
          predictionId: projection.id,
          capability: projection.capability,
          reason: `its recorded evaluation cites ${experienceIds.length} outcome record(s), and a candidate carries between 1 and ${MAX_SUPPORT_REFS}`,
        });
        continue;
      }
      const id = randomUUID();
      if (records.some((r) => r.id === id) || created.some((r) => r.id === id)) {
        throw new StoreError('identifier collision; nothing written');
      }
      const record = {
        schema: EXPERIENCE_SCHEMA,
        kind: ADAPTATION_KIND,
        id,
        capability: projection.capability,
        rule,
        ruleHash: sha256Hex(normalizeRuleText(rule)),
        method: PREDICTION_DERIVATION_METHOD,
        minSupport: 1,
        support: {
          experienceIds,
          feedbackIds: [],
          predictionIds: [projection.id],
          evaluationIds: [projection.evaluation.id],
        },
        proposal,
        createdAt: this.now().toISOString(),
        provenance: recorded,
      };
      const problem = validateExperienceRecord(record);
      if (problem) throw new StoreError(`the derived prediction candidate failed validation (${problem}); nothing written`);
      await this.log.append(record);
      created.push(record);
      taken.add(key);
      report.created += 1;
    }
    return { created, skipped, report };
  }

  // The user's decision on one candidate. A model cannot reach this path: the registry refuses a
  // model-origin write of this action, and this store refuses a non-user origin for the same
  // request, so a candidate cannot approve itself.
  async decideAdaptation({ target, decision, reason = null, provenance = {}, origin } = {}) {
    this.#requireUser(origin, 'approving or rejecting an adaptation');
    if (!ADAPTATION_DECISIONS.includes(decision)) throw new ValidationError('decision must be approved or rejected');
    const ref = validateRef(target, 'adaptation reference');
    const reasonText = validateTextField(reason, 'reason', { required: false, max: MAX_REASON_CHARS });
    const recorded = sanitizeProvenance(provenance, DECISION_KIND);
    return this.writeLock.run(() => this.#decideFromAuthority({ ref, decision, reasonText, recorded }));
  }

  async #decideFromAuthority({ ref, decision, reasonText, recorded }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const { index, adaptations } = deriveStore(records);
    // Resolved against the derived records, not the raw ones: a reader of the decision needs to be
    // told the state the candidate was in, and a raw log line has no state to report.
    const adaptation = resolveAdaptationRef(adaptations, ref, 'decision target');
    const retiredTargets = new Set(index.retirements.map((r) => r.targetId));
    if (retiredTargets.has(adaptation.id)) {
      throw new ValidationError(`adaptation [${shortId(adaptation.id)}] was retired; derive a new candidate instead of deciding a retired one`);
    }
    // Store order governs, so a changed mind is allowed and every earlier decision stays readable.
    const events = index.decisions.filter((d) => d.targetId === adaptation.id);
    const latest = events.length > 0 ? events.at(-1) : null;
    if (latest && latest.decision === decision) {
      throw new ValidationError(`adaptation [${shortId(adaptation.id)}] is already ${decision}`);
    }

    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
    const record = {
      schema: EXPERIENCE_SCHEMA,
      kind: DECISION_KIND,
      id,
      targetId: adaptation.id,
      decision,
      ...(reasonText ? { reason: reasonText } : {}),
      createdAt: this.now().toISOString(),
      provenance: recorded,
    };
    const problem = validateExperienceRecord(record);
    if (problem) throw new StoreError(`the recorded decision failed validation (${problem}); nothing written`);
    await this.log.append(record);
    return { record, adaptation, previous: latest ?? null };
  }

  // Explicit end for one adaptation. The candidate, its decision, and the evidence behind both stay
  // in the log; only the derived state changes.
  async retireAdaptation({ target, reason = null, provenance = {}, origin } = {}) {
    this.#requireUser(origin, 'retiring an adaptation');
    const ref = validateRef(target, 'adaptation reference');
    const reasonText = validateTextField(reason, 'reason', { required: false, max: MAX_REASON_CHARS });
    const recorded = sanitizeProvenance(provenance, RETIREMENT_KIND);
    return this.writeLock.run(() => this.#retireFromAuthority({ ref, reasonText, recorded }));
  }

  async #retireFromAuthority({ ref, reasonText, recorded }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const { index, adaptations } = deriveStore(records);
    // The retirement is reported from the derived state, so the reader is told what the adaptation
    // was before it ended instead of being shown no state at all.
    const adaptation = resolveAdaptationRef(adaptations, ref, 'retirement target');
    const existing = index.retirements.filter((r) => r.targetId === adaptation.id);
    if (existing.length > 0) {
      throw new ValidationError(`adaptation [${shortId(adaptation.id)}] is already retired`);
    }

    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
    const record = {
      schema: EXPERIENCE_SCHEMA,
      kind: RETIREMENT_KIND,
      id,
      targetId: adaptation.id,
      ...(reasonText ? { reason: reasonText } : {}),
      createdAt: this.now().toISOString(),
      provenance: recorded,
    };
    const problem = validateExperienceRecord(record);
    if (problem) throw new StoreError(`the recorded retirement failed validation (${problem}); nothing written`);
    await this.log.append(record);
    return { record, adaptation };
  }

  // The shape the user gave one approved adaptation, as a record rather than as an implication of its
  // rule text. Batch AM's learning package needs recorded guidance to be able to change the order
  // candidates are compared in, and the only honest way to let it is to compare a candidate's structure
  // against a structure the user named: `reads_first`, `writes_first`, capabilities to avoid or prefer,
  // and a step bound. Nothing here is a permission - a guidance record can move an approach up a
  // comparison and can never make a step runnable, authorized, or safe.
  //
  // The target must exist and must not be retired. It need not be approved: the state of approval is
  // derived elsewhere and the influence layer refuses an unapproved adaptation, so a guidance record on
  // a candidate is inert text beside an inert candidate - which is what the tests for "unapproved
  // adaptations remain inert" check.
  async guideAdaptation({
    target, order = null, avoid = [], prefer = [], maxSteps = null, reason = null, provenance = {}, origin,
  } = {}) {
    this.#requireUser(origin, 'recording the shape of an approved adaptation');
    const ref = validateRef(target, 'adaptation reference');
    if (order !== null && !GUIDANCE_ORDERS.includes(order)) {
      throw new ValidationError(`order must be one of: ${GUIDANCE_ORDERS.join(', ')}`);
    }
    const names = (value, label) => {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value) || value.length > MAX_GUIDANCE_NAMES) {
        throw new ValidationError(`${label} must be a list of at most ${MAX_GUIDANCE_NAMES} capability names`);
      }
      const list = value.map((name) => validateCapabilityName(name, label));
      if (new Set(list).size !== list.length) throw new ValidationError(`${label} names the same capability twice`);
      return list;
    };
    const avoided = names(avoid, 'avoid');
    const preferred = names(prefer, 'prefer');
    if (maxSteps !== null && (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_GUIDANCE_STEPS)) {
      throw new ValidationError(`maxSteps must be null or an integer from 1 to ${MAX_GUIDANCE_STEPS}`);
    }
    if (order === null && avoided.length === 0 && preferred.length === 0 && maxSteps === null) {
      throw new ValidationError('guidance must name at least one shape: an order, a capability to avoid or prefer, or a step bound');
    }
    const reasonText = validateTextField(reason, 'reason', { required: false, max: MAX_REASON_CHARS });
    const recorded = sanitizeProvenance(provenance, GUIDANCE_KIND);
    return this.writeLock.run(() => this.#guideFromAuthority({
      ref, order, avoided, preferred, maxSteps, reasonText, recorded,
    }));
  }

  async #guideFromAuthority({
    ref, order, avoided, preferred, maxSteps, reasonText, recorded,
  }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const { index, adaptations } = deriveStore(records);
    const adaptation = resolveAdaptationRef(adaptations, ref, 'guidance target');
    const retiredTargets = new Set(index.retirements.map((r) => r.targetId));
    if (retiredTargets.has(adaptation.id)) {
      throw new ValidationError(`adaptation [${shortId(adaptation.id)}] was retired; guidance belongs to a candidate that still stands`);
    }
    // A later record restates the shape and the earlier ones stay readable, as with a decision. What
    // must not happen is two records that agree being appended twice, because that would let a reader
    // count restatements as support.
    const existing = (index.guidance ?? []).filter((g) => g.targetId === adaptation.id);
    const latest = existing.length > 0 ? existing.at(-1) : null;
    if (latest && stableStringify(summarizeGuidance(latest)) === stableStringify(summarizeGuidance({
      id: latest.id, order, avoid: avoided, prefer: preferred, maxSteps, reason: reasonText, createdAt: latest.createdAt, provenance: latest.provenance,
    }))) {
      throw new ValidationError(`adaptation [${shortId(adaptation.id)}] already carries this guidance`);
    }

    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
    const record = {
      schema: EXPERIENCE_SCHEMA,
      kind: GUIDANCE_KIND,
      id,
      targetId: adaptation.id,
      order,
      avoid: avoided,
      prefer: preferred,
      maxSteps,
      ...(reasonText ? { reason: reasonText } : {}),
      createdAt: this.now().toISOString(),
      provenance: recorded,
    };
    const problem = validateExperienceRecord(record);
    if (problem) throw new StoreError(`the recorded guidance failed validation (${problem}); nothing written`);
    await this.log.append(record);
    return { record, adaptation, previous: latest ?? null };
  }

  // --- governance reviews ----------------------------------------------------

  // Open one review against one exact evidence bundle. The bundle is built by the governance module
  // from the live stores and canonicalised here; a bundle that names another adaptation, another rule
  // hash, or another rule version than the adaptation as it now stands is refused rather than stored,
  // because a review of a different shape must never be readable as a review of this one.
  async openReview({ target, evidence, reportDigest = null, reason = null, provenance = {}, origin } = {}) {
    this.#requireUser(origin, 'opening a governance review');
    const ref = validateRef(target, 'review target');
    let canonical;
    try {
      canonical = canonicalReviewEvidence(evidence);
    } catch (err) {
      throw new ValidationError(`the review evidence is not a readable bundle: ${err?.message ?? String(err)}`, 'REVIEW_EVIDENCE_INVALID');
    }
    if (reportDigest !== null && (typeof reportDigest !== 'string' || !/^[0-9a-f]{64}$/.test(reportDigest))) {
      throw new ValidationError('reportDigest must be a sha256 digest or null');
    }
    const reasonText = validateTextField(reason, 'reason', { required: false, max: MAX_REASON_CHARS });
    const recorded = sanitizeProvenance(provenance, REVIEW_KIND);
    return this.writeLock.run(() => this.#openReviewFromAuthority({
      ref, canonical, reportDigest, reasonText, recorded,
    }));
  }

  async #openReviewFromAuthority({ ref, canonical, reportDigest, reasonText, recorded }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const { adaptations, reviews } = deriveStore(records);
    const adaptation = resolveAdaptationRef(adaptations, ref, 'review target');
    if (canonical.targetId !== adaptation.id) {
      throw new ValidationError('the review evidence names a different adaptation than the review target', 'REVIEW_TARGET_MISMATCH');
    }
    if (canonical.rule.hash !== adaptation.ruleHash) {
      throw new ValidationError('the review evidence does not describe the rule the adaptation now states', 'REVIEW_RULE_MISMATCH');
    }
    if ((canonical.rule.version ?? null) !== (adaptation.shapeVersion ?? null)) {
      throw new ValidationError(
        `adaptation [${shortId(adaptation.id)}] now stands at version ${adaptation.shapeVersion ?? 'unrecorded'}; review the version on record rather than an earlier shape`,
        'REVIEW_VERSION_MISMATCH',
      );
    }
    if (adaptation.retired) {
      throw new ValidationError(`adaptation [${shortId(adaptation.id)}] is retired; there is no active rule to review`, 'REVIEW_TARGET_RETIRED');
    }

    const digest = reviewEvidenceDigest(canonical);
    const current = reviews.filter((r) => r.targetId === adaptation.id && r.supersededBy.length === 0);
    if (current.some((r) => r.evidenceDigest === digest)) {
      throw new ValidationError(
        `adaptation [${shortId(adaptation.id)}] already has a current review of this exact evidence; record a decision on it or wait for the evidence to change`,
        'REVIEW_EXISTS',
      );
    }

    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
    const record = {
      schema: EXPERIENCE_SCHEMA,
      kind: REVIEW_KIND,
      id,
      targetId: adaptation.id,
      evidence: canonical,
      evidenceDigest: digest,
      reportDigest,
      recommendation: canonical.report.recommendation,
      awaitingEvidence: reviewAwaitingEvidence(canonical),
      ...(reasonText ? { reason: reasonText } : {}),
      createdAt: this.now().toISOString(),
      provenance: recorded,
    };
    const problem = validateExperienceRecord(record);
    if (problem) throw new StoreError(`the recorded review failed validation (${problem}); nothing written`);
    await this.log.append(record);
    return { record, adaptation, previousReview: current.length > 0 ? current.at(-1) : null };
  }

  // Record the user's explicit decision on one review. The decision is bound to the exact evidence
  // that was reviewed and to the evidence as it stands now; if the two differ, the decision is refused
  // rather than attached to evidence the user did not see. Retirement reuses the existing retirement
  // authority in this same lock, so there is one retirement record kind and one lifecycle.
  async recordReviewDecision({ review, decision, evidence, reportDigest = null, reason = null, provenance = {}, origin } = {}) {
    this.#requireUser(origin, 'deciding an adaptation review');
    if (!REVIEW_DECISIONS.includes(decision)) throw new ValidationError(`decision must be one of: ${REVIEW_DECISIONS.join(', ')}`);
    const ref = validateRef(review, 'review reference');
    let canonical;
    try {
      canonical = canonicalReviewEvidence(evidence);
    } catch (err) {
      throw new ValidationError(`the current evidence is not a readable bundle: ${err?.message ?? String(err)}`, 'REVIEW_EVIDENCE_INVALID');
    }
    const reasonText = validateTextField(reason, 'reason', { required: false, max: MAX_REASON_CHARS });
    if (reportDigest !== null && (typeof reportDigest !== 'string' || !/^[0-9a-f]{64}$/.test(reportDigest))) {
      throw new ValidationError('reportDigest must be a sha256 digest or null');
    }
    const recorded = sanitizeProvenance(provenance, REVIEW_DECISION_KIND);
    return this.writeLock.run(() => this.#reviewDecisionFromAuthority({
      ref, decision, canonical, reportDigest, reasonText, provenance, recorded,
    }));
  }

  async #reviewDecisionFromAuthority({
    ref, decision, canonical, reportDigest, reasonText, provenance, recorded,
  }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const { adaptations, reviews } = deriveStore(records);
    const review = resolveReviewRef(reviews, ref, 'review reference');
    if (review.supersededBy.length > 0) {
      throw new ValidationError(
        `review [${shortId(review.id)}] was superseded by a later review; decide the current review instead`,
        'REVIEW_SUPERSEDED',
      );
    }
    if (review.decisionCount > 0) {
      throw new ValidationError(
        `review [${shortId(review.id)}] already records a decision; open a new review on current evidence to revisit it`,
        'REVIEW_ALREADY_DECIDED',
      );
    }
    const adaptation = adaptations.find((a) => a.id === review.targetId) ?? null;
    if (!adaptation) {
      throw new ValidationError('the adaptation this review names is not in the store; nothing can be decided', 'REVIEW_TARGET_MISSING');
    }
    if (canonical.targetId !== adaptation.id) {
      throw new ValidationError('the current evidence names a different adaptation than the review', 'REVIEW_TARGET_MISMATCH');
    }
    const diff = reconcileReviewEvidence({
      stored: review.evidence,
      current: canonical,
      storedReportDigest: review.reportDigest,
      currentReportDigest: reportDigest,
    });
    if (diff.state === 'unreadable') {
      throw new StoreError(`the review evidence cannot be reconciled (${diff.why}); no decision was recorded`);
    }
    if (diff.changed) {
      throw new ValidationError(
        `the evidence changed since review [${shortId(review.id)}] was opened (${diff.why}); reconcile it and open a new review on current evidence rather than deciding the earlier one`,
        'REVIEW_EVIDENCE_CHANGED',
      );
    }
    if (decision === 'retire' && adaptation.retired) {
      throw new ValidationError(`adaptation [${shortId(adaptation.id)}] is already retired; the decision was not recorded`, 'ADAPTATION_ALREADY_RETIRED');
    }

    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');

    // Retirement first, through the same authority method `adaptation.retire` uses. If the second
    // append then fails, the retirement stands and the error says so; the reverse order would leave a
    // decision claiming a retirement that was never recorded.
    let retirement = null;
    if (decision === 'retire') {
      const retirementReason = reasonText
        ?? `retirement recorded through governance review [${shortId(review.id)}]`;
      const retirementProvenance = sanitizeProvenance(provenance, RETIREMENT_KIND);
      retirement = await this.#retireFromAuthority({
        ref: adaptation.id,
        reasonText: retirementReason,
        recorded: retirementProvenance,
      });
    }

    const decisionRecord = {
      schema: EXPERIENCE_SCHEMA,
      kind: REVIEW_DECISION_KIND,
      id,
      reviewId: review.id,
      targetId: adaptation.id,
      decision,
      reviewedEvidenceDigest: review.evidenceDigest,
      currentEvidenceDigest: diff.evidenceDigest,
      reportDigest,
      ...(retirement ? { retirementId: retirement.record.id } : {}),
      ...(reasonText ? { reason: reasonText } : {}),
      createdAt: this.now().toISOString(),
      provenance: recorded,
    };
    const problem = validateExperienceRecord(decisionRecord);
    if (problem) {
      throw new StoreError(
        `the review decision failed validation (${problem}); ${retirement ? 'the retirement was recorded but the decision was not' : 'nothing written'}`,
      );
    }
    try {
      await this.log.append(decisionRecord);
    } catch (err) {
      if (retirement) {
        throw new StoreError(
          `the retirement was recorded but the review decision could not be appended: ${err?.message ?? String(err)}`,
        );
      }
      throw err;
    }
    return {
      record: decisionRecord,
      review,
      adaptation,
      retirement: retirement?.record ?? null,
    };
  }

  // --- outcome learning (T-08) -------------------------------------------------
  //
  // These writes share this store's log, lock, validation and derived state. The computation they
  // accept is bounded and re-checked here: an evaluation's classification is re-derived from its own
  // step counts, a measurement's verdict from its own windows, and a proposal's digest from the
  // evaluations it cites. Nothing in this block approves anything.

  async recordEvaluation(spec, { provenance = {}, origin } = {}) {
    this.#requireUser(origin, 'recording an outcome evaluation');
    if (!spec || typeof spec !== 'object') throw new ValidationError('an evaluation is required');
    const recorded = sanitizeProvenance(provenance, EVALUATION_KIND);
    return this.writeLock.run(() => this.#recordEvaluationFromAuthority({ spec, recorded }));
  }

  async #recordEvaluationFromAuthority({ spec, recorded }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const { index } = deriveStore(records);
    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
    const record = {
      schema: EXPERIENCE_SCHEMA,
      kind: EVALUATION_KIND,
      id,
      planId: spec.planId,
      planVersion: spec.planVersion,
      goalId: spec.goalId ?? null,
      taskId: spec.taskId ?? null,
      objective: spec.objective,
      objectiveKey: spec.objectiveKey ?? null,
      activated: spec.activated === true,
      planStatus: spec.planStatus ?? null,
      classification: spec.classification,
      confidence: spec.confidence,
      steps: { ...spec.steps },
      capabilities: (spec.capabilities ?? []).map((row) => ({ ...row })),
      sequence: [...(spec.sequence ?? [])],
      criteria: (spec.criteria ?? []).map((c) => ({ ...c })),
      evidence: {
        operationIds: [...(spec.evidence?.operationIds ?? [])],
        experienceIds: [...(spec.evidence?.experienceIds ?? [])],
        feedbackIds: [...(spec.evidence?.feedbackIds ?? [])],
        predictionIds: [...(spec.evidence?.predictionIds ?? [])],
      },
      limitations: [...(spec.limitations ?? [])],
      createdAt: this.now().toISOString(),
      provenance: recorded,
    };
    // The digest is recomputed here, not copied from the caller: the record can only carry a hash of
    // the evidence it actually contains.
    record.evidenceSha256 = evaluationDigest(record);
    const duplicate = index.evaluations.find((e) => e.planId === record.planId
      && e.planVersion === record.planVersion
      && e.evidenceSha256 === record.evidenceSha256);
    if (duplicate) {
      throw new ValidationError(
        `plan [${shortId(record.planId)}] already has this exact evaluation recorded as [${shortId(duplicate.id)}]; nothing was written`,
        'EVALUATION_EXISTS',
      );
    }
    const problem = validateExperienceRecord(record);
    if (problem) throw new StoreError(`the recorded evaluation failed validation (${problem}); nothing written`);
    await this.log.append(record);
    return { record };
  }

  async measureAdaptation({ target, provenance = {}, origin } = {}) {
    this.#requireUser(origin, 'measuring an adaptation');
    const ref = validateRef(target, 'adaptation reference');
    const recorded = sanitizeProvenance(provenance, MEASUREMENT_KIND);
    return this.writeLock.run(() => this.#measureFromAuthority({ ref, recorded }));
  }

  async #measureFromAuthority({ ref, recorded }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const derived = deriveStore(records);
    const adaptation = resolveAdaptationRef(derived.adaptations, ref, 'measurement target');
    const retired = new Set(derived.index.retirements.map((r) => r.targetId));
    if (retired.has(adaptation.id)) {
      throw new ValidationError(`adaptation [${shortId(adaptation.id)}] was retired; there is no rule in force to measure`);
    }
    if (adaptation.decisionState === 'ambiguous') {
      throw new ValidationError(`adaptation [${shortId(adaptation.id)}] has contradictory lifecycle events; APEX cannot say what is in force`);
    }
    if (adaptation.decisionState !== 'approved') {
      throw new ValidationError(
        `adaptation [${shortId(adaptation.id)}] is ${adaptation.decisionState}; only a rule you approved can be measured`,
        'ADAPTATION_NOT_AUTHORIZED',
      );
    }
    if (adaptation.rolledBack) {
      throw new ValidationError(`adaptation [${shortId(adaptation.id)}] was rolled back; it is no longer in force, so there is nothing to measure`);
    }
    if (adaptation.supportState !== 'intact') {
      throw new ValidationError(`adaptation [${shortId(adaptation.id)}] is not in force because ${adaptation.inactiveReason ?? 'its support no longer stands'}`);
    }
    const decisions = derived.index.decisions.filter((d) => d.targetId === adaptation.id);
    const approval = decisions.at(-1);
    const position = new Map(records.map((record, index) => [record.id, index]));
    const cut = position.get(approval?.id) ?? position.get(adaptation.id) ?? records.length;
    const scoped = derived.index.evaluations.filter((e) =>
      e.capabilities.some((row) => scopeIncludes(row.capability, adaptation.capability)));
    const baseline = scoped.filter((e) => (position.get(e.id) ?? 0) < cut);
    const followUp = scoped.filter((e) => (position.get(e.id) ?? 0) > cut);
    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
    const measurement = buildMeasurement({
      targetId: adaptation.id,
      targetRule: adaptation.rule,
      capability: adaptation.capability,
      activation: approval ? { decisionId: approval.id, at: approval.createdAt } : null,
      split: { baseline, followUp },
      now: this.now().toISOString(),
    });
    const record = {
      schema: EXPERIENCE_SCHEMA,
      kind: MEASUREMENT_KIND,
      id,
      ...measurement,
      provenance: recorded,
    };
    const problem = validateExperienceRecord(record);
    if (problem) throw new StoreError(`the recorded measurement failed validation (${problem}); nothing written`);
    await this.log.append(record);
    return { record, adaptation };
  }

  // Deactivation is the user's act on measured evidence. It never rewrites the approval, the rule or
  // the supporting records; it appends one more event that takes the rule out of force.
  async rollbackAdaptation({
    target, measurement = null, reason = null, provenance = {}, origin,
  } = {}) {
    this.#requireUser(origin, 'rolling back an adaptation');
    const ref = validateRef(target, 'adaptation reference');
    const measurementRef = measurement === null || measurement === undefined ? null : validateRef(measurement, 'measurement reference');
    const reasonText = validateTextField(reason, 'reason', { required: false, max: MAX_REASON_CHARS });
    const recorded = sanitizeProvenance(provenance, ROLLBACK_KIND);
    return this.writeLock.run(() => this.#rollbackFromAuthority({
      ref, measurementRef, reasonText, recorded,
    }));
  }

  async #rollbackFromAuthority({
    ref, measurementRef, reasonText, recorded,
  }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const derived = deriveStore(records);
    const adaptation = resolveAdaptationRef(derived.adaptations, ref, 'rollback target');
    const retired = new Set(derived.index.retirements.map((r) => r.targetId));
    if (retired.has(adaptation.id)) throw new ValidationError(`adaptation [${shortId(adaptation.id)}] was retired; nothing is in force to roll back`);
    if (adaptation.rolledBack) throw new ValidationError(`adaptation [${shortId(adaptation.id)}] has already been rolled back`);
    if (adaptation.decisionState !== 'approved') {
      throw new ValidationError(`adaptation [${shortId(adaptation.id)}] is ${adaptation.decisionState}; only an approved rule can be rolled back`);
    }
    const events = derived.index.measurements.filter((m) => m.targetId === adaptation.id);
    const chosen = measurementRef === null
      ? (events.length > 0 ? events.at(-1) : null)
      : events.find((m) => matchesRef(m, measurementRef));
    if (!chosen) {
      throw new ValidationError(
        measurementRef === null
          ? `adaptation [${shortId(adaptation.id)}] has no recorded measurement, so there is no evidence a rollback could rest on`
          : `no measurement of adaptation [${shortId(adaptation.id)}] matches that reference`,
      );
    }
    if (chosen.verdict !== 'regressed') {
      throw new ValidationError(
        `measurement [${shortId(chosen.id)}] recorded ${chosen.verdict}, not a regression; only measured evidence of harm can justify a rollback`,
        'ROLLBACK_UNSUPPORTED',
      );
    }
    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
    const record = {
      schema: EXPERIENCE_SCHEMA,
      kind: ROLLBACK_KIND,
      id,
      targetId: adaptation.id,
      measurementId: chosen.id,
      ...(reasonText ? { reason: reasonText } : {}),
      createdAt: this.now().toISOString(),
      provenance: recorded,
    };
    const problem = validateExperienceRecord(record);
    if (problem) throw new StoreError(`the recorded rollback failed validation (${problem}); nothing written`);
    await this.log.append(record);
    return { record, adaptation, measurement: chosen };
  }

  // Candidate adaptations derived from recorded outcomes. They are candidates until the user's own
  // decision says otherwise; this method cannot approve one, and it refuses a support list that names
  // an evaluation or experience the log does not hold.
  async recordOutcomeCandidates({ specs = [] } = {}, { provenance = {}, origin } = {}) {
    this.#requireUser(origin, 'recording proposed adaptations');
    if (!Array.isArray(specs)) throw new ValidationError('proposed adaptations must be a list');
    const recorded = sanitizeProvenance(provenance, ADAPTATION_KIND);
    return this.writeLock.run(() => this.#recordOutcomeCandidatesFromAuthority({ specs, recorded }));
  }

  async #recordOutcomeCandidatesFromAuthority({ specs, recorded }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const derived = deriveStore(records);
    const evaluationsById = new Map(derived.index.evaluations.map((e) => [e.id, e]));
    const experiencesById = new Map(derived.index.experiences.map((e) => [e.id, e]));
    const feedbackById = new Map(derived.index.feedback.map((f) => [f.id, f]));
    const taken = new Set(derived.adaptations
      .filter((a) => a.decisionState !== 'retired')
      .map((a) => `${a.capability}\u0000${a.proposal?.objectiveKey ?? ''}\u0000${normalizeRuleText(a.rule)}`));
    const created = [];
    const skipped = [];
    for (const spec of specs) {
      const rule = String(spec?.rule ?? '').trim();
      const key = `${spec?.capability}\u0000${spec?.proposal?.objectiveKey ?? ''}\u0000${normalizeRuleText(rule)}`;
      if (taken.has(key)) {
        skipped.push({ capability: spec?.capability ?? null, reason: 'a candidate for this scope, objective and rule is already recorded' });
        continue;
      }
      const evaluationIds = [...new Set(spec?.support?.evaluationIds ?? [])];
      if (evaluationIds.length === 0) throw new ValidationError('a proposed adaptation must cite at least one recorded evaluation');
      const missingEvaluation = evaluationIds.find((id) => !evaluationsById.has(id));
      if (missingEvaluation) {
        throw new ValidationError(`a proposed adaptation cites evaluation [${shortId(missingEvaluation)}], which is not recorded`);
      }
      const experienceIds = [...new Set(spec?.support?.experienceIds ?? [])];
      const missingExperience = experienceIds.find((id) => !experiencesById.has(id));
      if (missingExperience) throw new ValidationError(`a proposed adaptation cites experience [${shortId(missingExperience)}], which is not recorded`);
      const feedbackIds = [...new Set(spec?.support?.feedbackIds ?? [])];
      const missingFeedback = feedbackIds.find((id) => !feedbackById.has(id));
      if (missingFeedback) throw new ValidationError(`a proposed adaptation cites feedback [${shortId(missingFeedback)}], which is not recorded`);
      const id = randomUUID();
      if (records.some((r) => r.id === id) || created.some((r) => r.id === id)) {
        throw new StoreError('identifier collision; nothing written');
      }
      const record = {
        schema: EXPERIENCE_SCHEMA,
        kind: ADAPTATION_KIND,
        id,
        capability: spec.capability,
        rule,
        ruleHash: sha256Hex(normalizeRuleText(rule)),
        method: OBSERVED_OUTCOME_METHOD,
        minSupport: spec.proposal.pattern.observations,
        support: { experienceIds, feedbackIds, evaluationIds },
        proposal: spec.proposal,
        createdAt: this.now().toISOString(),
        provenance: recorded,
      };
      const problem = validateExperienceRecord(record);
      if (problem) throw new StoreError(`the proposed adaptation failed validation (${problem}); nothing written`);
      await this.log.append(record);
      created.push(record);
      taken.add(key);
    }
    return { created, skipped };
  }

  //--- reads -----------------------------------------------------------------

  // One authoritative read. `beforeAppend` marks the read a write performs first, which may reuse
  // this instance's incrementally maintained validated records (see ../memory/jsonl-store.js).
  async #loadComplete({ beforeAppend = false } = {}) {
    const { records, corrupt } = beforeAppend ? await this.log.loadForAppend() : await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`experience store contains ${corrupt.length} corrupt line(s); refusing an incomplete experience operation`);
    }
    return records;
  }

  // Every predicate outside this method treats an adaptation's stored evidence as sufficient. A
  // prediction-derived candidate is the one kind whose evidence lives in another store and can change
  // without this log changing at all, so each read re-checks it against the ledger as it stands now. The
  // check can only make a record less active, never more: approval, retirement, and support are still
  // decided here. Nothing is cached between reads, so an evaluation or withdrawal appended a moment ago
  // is seen by the next read.
  async #predictionCurrentness(rows, experiencesById) {
    const derived = rows.filter((r) => isPredictionDerived(r.method));
    if (derived.length === 0) return { rows, report: null };
    const available = Boolean(this.predictions && typeof this.predictions.detail === 'function');
    const report = {
      available,
      checked: derived.length,
      current: 0,
      stale: 0,
      reason: available ? null : 'the prediction ledger is not attached to this store, so no prediction-derived candidate can be confirmed current',
    };
    const cache = new Map();
    // Every distinct cited prediction, read once. A per-id fallback stays for a ledger object that
    // exposes only `detail`, and for a batch read that fails: the check then costs one read per
    // citation, which is what it did before, rather than judging citations it could not read.
    const cited = [...new Set(derived.flatMap((row) => row.support?.predictionIds ?? []))];
    let prefetched = null;
    if (cited.length > 0 && typeof this.predictions.details === 'function') {
      try {
        prefetched = await this.predictions.details(cited);
      } catch {
        prefetched = null;
      }
    }
    const projectionOf = async (predictionId) => {
      if (prefetched && prefetched.has(predictionId)) {
        const answered = prefetched.get(predictionId);
        return answered.error !== undefined ? { unavailable: answered.error } : answered.projection;
      }
      if (!cache.has(predictionId)) {
        try {
          cache.set(predictionId, await this.predictions.detail(predictionId));
        } catch (err) {
          cache.set(predictionId, { unavailable: err?.message ?? String(err) });
        }
      }
      return cache.get(predictionId);
    };
    const out = [];
    for (const row of rows) {
      if (!isPredictionDerived(row.method)) {
        out.push(row);
        continue;
      }
      const single = row.method === PREDICTION_DERIVATION_METHOD;
      const predictionIds = row.support?.predictionIds ?? [];
      const evaluationIds = row.support?.evaluationIds ?? [];
      let judgment;
      if (!available) {
        judgment = { eligible: false, state: 'prediction_store_unavailable', reason: report.reason };
      } else if (predictionIds.length === 0 || (single && predictionIds.length !== 1)) {
        judgment = { eligible: false, state: 'evaluation_missing', reason: 'the candidate names no prediction record' };
      } else if (evaluationIds.length !== predictionIds.length) {
        judgment = { eligible: false, state: 'evaluation_missing', reason: 'the candidate cites a different number of predictions and evaluations' };
      } else {
        judgment = { eligible: true, state: 'eligible', reason: null };
        // Every cited observation is re-judged, not only the first. A longitudinal rule rests on the
        // whole sequence, so any single withdrawn, replaced, stale, or unreadable member makes it inert
        // until the user derives again.
        for (let i = 0; i < predictionIds.length; i += 1) {
          const projection = await projectionOf(predictionIds[i]);
          if (projection?.unavailable !== undefined) {
            judgment = { eligible: false, state: 'prediction_store_unavailable', reason: `the prediction ledger could not be read: ${projection.unavailable}` };
            break;
          }
          if (projection?.evaluation?.id !== evaluationIds[i]) {
            judgment = { eligible: false, state: 'evaluation_changed', reason: 'an evaluation this candidate cites is no longer the evaluation on record for its prediction' };
            break;
          }
          const item = predictionEligibility({ projection, experiencesById });
          if (!item.eligible) {
            judgment = item;
            break;
          }
        }
        // The proposal is a statement of recorded outcomes. If any part of that statement no longer
        // matches the records it was taken from, the candidate is inert until the user derives again.
        if (judgment.eligible && row.proposal) {
          let recomputed;
          if (single) {
            const verdict = row.proposal.verdicts?.[0] ?? null;
            recomputed = verdict && evidenceDigest({
              predictionId: predictionIds[0],
              evaluationId: evaluationIds[0],
              verdict: verdict.verdict,
              outcomeClass: verdict.outcomeClass,
              outcomeExperienceIds: row.support?.experienceIds ?? [],
            });
          } else {
            recomputed = row.proposal.verdicts && row.proposal.pattern && longitudinalEvidenceDigest({
              capability: row.capability,
              kind: row.proposal.pattern.kind,
              verdicts: row.proposal.verdicts,
              outcomeExperienceIds: row.support?.experienceIds ?? [],
            });
          }
          if (recomputed !== row.proposal.evidenceDigest) {
            judgment = { eligible: false, state: 'evaluation_changed', reason: 'the recorded outcome, verdict, or evidence behind this candidate has changed since it was derived' };
          }
        }
      }
      if (judgment.eligible) {
        report.current += 1;
        out.push({ ...row, predictionEvidence: { eligible: true, state: 'eligible', reason: null } });
        continue;
      }
      report.stale += 1;
      out.push({
        ...row,
        // An unapproved candidate was already inert for its own reason; an approved one loses its effect
        // here, and the reason names the evidence rather than the approval, which still stands.
        active: false,
        inactiveReason: row.decisionState === 'approved'
          ? `the prediction evidence no longer supports this candidate: ${judgment.reason}`
          : row.inactiveReason,
        predictionEvidence: { eligible: false, state: judgment.state, reason: judgment.reason },
      });
    }
    return { rows: out, report };
  }

  // Read-only inspection of what each recorded expectation could propose, judged by the same rule the
  // derivation uses. Nothing is written; an eligible row is not a candidate until the user asks for one.
  async predictionEligibilityReport({ capability = null, limit = MAX_PREDICTION_CANDIDATES } = {}) {
    const size = Number.isInteger(limit) && limit >= 1
      ? Math.min(limit, MAX_PREDICTION_CANDIDATES)
      : MAX_PREDICTION_CANDIDATES;
    const report = { available: false, reason: null, considered: [], total: 0, truncated: false, limit: size };
    if (!this.predictions || typeof this.predictions.list !== 'function') {
      report.reason = 'no prediction ledger is attached to this store';
      return report;
    }
    let ledger;
    try {
      ledger = await this.predictions.list({ limit: size });
    } catch (err) {
      report.available = true;
      report.reason = `the prediction ledger could not be read: ${err?.message ?? String(err)}`;
      return report;
    }
    report.available = true;
    const records = await this.#loadComplete();
    const derived = deriveStore(records);
    const experiencesById = new Map(derived.experiences.map((r) => [r.id, r]));
    const projections = (ledger.projections ?? []).filter((p) => scopeMatches({ capability: p.capability }, { capability }));
    report.total = projections.length;
    report.truncated = ledger.truncated === true;
    report.considered = projections.slice(0, size).map((projection) => {
      const eligibility = predictionEligibility({ projection, experiencesById });
      return {
        predictionId: projection.id,
        capability: projection.capability,
        subject: projection.subject,
        expectation: projection.expectation,
        status: projection.status,
        verdict: projection.evaluation?.verdict ?? null,
        evaluationId: projection.evaluation?.id ?? null,
        outcomeExperienceIds: [...(projection.evaluation?.outcomeExperienceIds ?? [])],
        outcomeClass: decidingOutcomeOf(projection, experiencesById)?.outcomeClass ?? null,
        eligible: eligibility.eligible,
        state: eligibility.state,
        reason: eligibility.reason,
        proposal: eligibility.eligible ? proposalFor({ projection, experiencesById }) : null,
        alreadyCandidate: derived.adaptations.some((a) => a.decisionState !== 'retired'
          && (a.support?.predictionIds ?? []).includes(projection.id)),
      };
    });
    return report;
  }

  async lockReport() {
    return this.writeLock.state();
  }

  async recover() {
    return this.writeLock.recover();
  }

  async status() {
    const { records, corrupt } = await this.log.load();
    const { index, experiences, adaptations } = deriveStore(records);
    const experiencesById = new Map(experiences.map((r) => [r.id, r]));
    const current = await this.#predictionCurrentness(adaptations.filter((a) => a.active), experiencesById);
    return {
      path: this.filePath,
      records: records.length,
      experiences: index.experiences.length,
      recordedByUser: index.experiences.filter((r) => captureOf(r) === CAPTURE_EXPLICIT).length,
      capturedAutomatically: index.experiences.filter((r) => captureOf(r) === CAPTURE_AUTOMATIC).length,
      unknownCapture: index.experiences.filter((r) => captureOf(r) === CAPTURE_UNKNOWN).length,
      feedback: index.feedback.length,
      adaptations: index.adaptations.length,
      feedbackDerivedAdaptations: index.adaptations.filter((a) => !isPredictionDerived(a.method)).length,
      predictionDerivedAdaptations: index.adaptations.filter((a) => isPredictionDerived(a.method)).length,
      longitudinalDerivedAdaptations: index.adaptations.filter((a) => a.method === LONGITUDINAL_DERIVATION_METHOD).length,
      predictionEvidenceStale: current.report?.stale ?? 0,
      decisions: index.decisions.length,
      retirements: index.retirements.length,
      guidance: index.guidance.length,
      activeAdaptations: current.rows.filter((a) => a.active).length,
      corrupt: corrupt.length,
    };
  }

  async list({ limit = 20 } = {}) {
    const records = await this.#loadComplete();
    const { experiences } = deriveStore(records);
    return experiences.slice(-Math.max(1, limit)).reverse();
  }

  async get(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    const records = await this.#loadComplete();
    return deriveStore(records).experiences.find((r) => r.id === id) ?? null;
  }

  async findByPrefix(prefix) {
    const p = typeof prefix === 'string' ? prefix.trim() : '';
    if (p.length === 0) return [];
    const records = await this.#loadComplete();
    const { experiences } = deriveStore(records);
    return experiences.filter((r) => matchesRef(r, p, [r.operationId])).reverse();
  }

  // The feedback counterpart to `findByPrefix`, matching a feedback id only and never the experience
  // it describes, so a reference cannot change which record is meant. It exists because a prediction
  // may cite a recorded assessment, and the id a reader prints for one is its first eight characters.
  async findFeedbackByPrefix(prefix) {
    const p = typeof prefix === 'string' ? prefix.trim() : '';
    if (p.length === 0) return [];
    const records = await this.#loadComplete();
    return deriveStore(records).index.feedback.filter((r) => matchesRef(r, p)).reverse();
  }

  // Read-only lifecycle view for one experience: its current feedback and the full history, so a
  // correction never hides what the user said first, even when the two disagree.
  async feedbackFor(target, { limit = 20 } = {}) {
    const ref = typeof target === 'string' ? target.trim() : '';
    if (ref.length === 0) return null;
    const records = await this.#loadComplete();
    const { index, retiredExperiences, retiredFeedback, experiences } = deriveStore(records);
    const matches = experiences.filter((r) => matchesRef(r, ref, [r.operationId]));
    if (matches.length === 0) return null;
    if (matches.length > 1) throw new ValidationError('the feedback view target is ambiguous; use a longer id prefix');
    const entries = index.feedback.filter((f) => f.experienceId === matches[0].id);
    const capped = entries.slice(-Math.max(1, limit));
    return {
      experience: matches[0],
      current: capped.filter((r) => !retiredFeedback.has(r.id)).map(summarizeFeedback),
      history: capped.map((r) => ({ ...summarizeFeedback(r), superseded: retiredFeedback.has(r.id) })),
      supersededExperience: retiredExperiences.has(matches[0].id),
      truncated: entries.length > capped.length,
    };
  }

  async adaptations({ limit = 20, includeRetired = true } = {}) {
    const records = await this.#loadComplete();
    const { experiences, adaptations } = deriveStore(records);
    const kept = includeRetired ? adaptations : adaptations.filter((a) => a.decisionState !== 'retired');
    const window = kept.slice(-Math.max(1, limit)).reverse();
    const current = await this.#predictionCurrentness(window, new Map(experiences.map((r) => [r.id, r])));
    return current.rows;
  }

  // The recorded outcome evaluations, oldest first so a window read is position-stable. The
  // capability filter follows the same family rule the existing scope reads use.
  async evaluations({ capability = null, objectiveKey = null, limit = 20 } = {}) {
    const records = await this.#loadComplete();
    const { index } = deriveStore(records);
    const size = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 100) : 20;
    const all = index.evaluations.filter((e) => {
      if (objectiveKey !== null && e.objectiveKey !== objectiveKey) return false;
      if (capability === null) return true;
      return e.capabilities.some((row) => scopeIncludes(row.capability, capability));
    });
    return {
      evaluations: all.slice(-size),
      total: all.length,
      truncated: all.length > size,
      limit: size,
    };
  }

  async adaptationDetail(target) {
    const ref = typeof target === 'string' ? target.trim() : '';
    if (ref.length === 0) return null;
    const records = await this.#loadComplete();
    const { experiences, adaptations } = deriveStore(records);
    const matches = adaptations.filter((a) => matchesRef(a, ref));
    if (matches.length === 0) return null;
    if (matches.length > 1) throw new ValidationError('the adaptation target is ambiguous; use a longer id prefix');
    const current = await this.#predictionCurrentness(matches, new Map(experiences.map((r) => [r.id, r])));
    return current.rows[0];
  }

  // Reviews, newest first, bounded. `target` is an adaptation reference; when it is supplied the read
  // is that adaptation's history, and a reference that matches no adaptation is an error rather than
  // an empty list. Every other record kind is untouched: a review changes no state by being listed.
  async reviews({ limit = 20, target = null } = {}) {
    const size = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 50) : 20;
    const records = await this.#loadComplete();
    const { adaptations, reviews } = deriveStore(records);
    let scoped = reviews;
    if (target !== null && target !== undefined && String(target).trim().length > 0) {
      const adaptation = resolveAdaptationRef(adaptations, String(target).trim(), 'review target');
      scoped = reviews.filter((r) => r.targetId === adaptation.id);
    }
    const newest = [...scoped].reverse();
    return { reviews: newest.slice(0, size), total: scoped.length, truncated: scoped.length > size, limit: size };
  }

  // One review with its decisions and its supersession state. The adaptation is included so a reader
  // does not have to join two reads; it is resolved from the same authoritative log.
  async reviewDetail(target) {
    const ref = typeof target === 'string' ? target.trim() : '';
    if (ref.length === 0) return null;
    const records = await this.#loadComplete();
    const { adaptations, reviews } = deriveStore(records);
    const matches = reviews.filter((r) => matchesRef(r, ref));
    if (matches.length === 0) return null;
    if (matches.length > 1) throw new ValidationError('the review target is ambiguous; use a longer id prefix');
    const review = matches[0];
    const adaptation = adaptations.find((a) => a.id === review.targetId) ?? null;
    return { review, adaptation };
  }

  // Exact support state for a bounded list of cited ids, from one authoritative read. A support
  // reference can be present, missing, or superseded (corrected by a later record); a governance
  // review records which of the three it saw so reconciliation can tell a withdrawal from damage.
  async supportStates({ experienceIds = [], feedbackIds = [] } = {}) {
    const wantedExperiences = new Set(Array.isArray(experienceIds) ? experienceIds.map(String) : []);
    const wantedFeedback = new Set(Array.isArray(feedbackIds) ? feedbackIds.map(String) : []);
    if (wantedExperiences.size > MAX_INDEX_IDS || wantedFeedback.size > MAX_INDEX_IDS) {
      throw new ValidationError(`supportStates may resolve at most ${MAX_INDEX_IDS} ids per kind`);
    }
    const records = await this.#loadComplete();
    const { index, retiredExperiences, retiredFeedback } = deriveStore(records);
    const experiencesById = new Map(index.experiences.map((r) => [r.id, r]));
    const feedbackById = new Map(index.feedback.map((r) => [r.id, r]));
    const experiences = [...wantedExperiences].sort();
    const feedback = [...wantedFeedback].sort();
    return {
      presentExperienceIds: experiences.filter((id) => experiencesById.has(id) && !retiredExperiences.has(id)),
      missingExperienceIds: experiences.filter((id) => !experiencesById.has(id)),
      retiredExperienceIds: experiences.filter((id) => retiredExperiences.has(id)),
      presentFeedbackIds: feedback.filter((id) => feedbackById.has(id) && !retiredFeedback.has(id)),
      missingFeedbackIds: feedback.filter((id) => !feedbackById.has(id)),
      retiredFeedbackIds: feedback.filter((id) => retiredFeedback.has(id)),
    };
  }

  // Bounded retrieval of the adaptations in effect: approved by the user's latest applicable
  // decision, not retired, and still supported by evidence that is present. A damaged or unreadable
  // store throws instead of returning an empty list, so a caller can tell "nothing applies" from
  // "nothing could be read".
  //
  // `capability` is a hard filter: an explicit scope question must not answer with unrelated rules.
  // `query` is only a ranking, never a filter. A scope is a capability name, and a later request
  // rarely repeats it ("remember the review date" matches `memory.add`, but "how often do we review
  // the budget?" does not), so dropping a rule the user approved because the wording differed would
  // silently undo an approval. Scope overlap decides which rules survive the bounded window; the
  // rest still reach the caller.
  async activeAdaptations({ query = null, capability = null, limit = DEFAULT_ACTIVE_ADAPTATIONS } = {}) {
    const size = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_ACTIVE_ADAPTATIONS) : DEFAULT_ACTIVE_ADAPTATIONS;
    const records = await this.#loadComplete();
    const { experiences, adaptations } = deriveStore(records);
    // Overlay only what could possibly be active: the currentness check can remove a row, never add one,
    // so an unapproved or retired candidate costs no ledger read at all.
    const current = await this.#predictionCurrentness(
      adaptations.filter((a) => a.active),
      new Map(experiences.map((r) => [r.id, r])),
    );
    const inScope = current.rows.filter((a) => a.active && scopeMatches(a, { capability, terms: null }));
    const terms = typeof query === 'string' && query.trim().length > 0 ? new Set(tokenize(query)) : null;
    const ranked = inScope
      .map((a, index) => ({ a, index, related: terms ? scopesNamedIn(a, terms) : false }))
      .sort((x, y) => Number(y.related) - Number(x.related) || y.index - x.index);
    // Related scopes first, then newest first: when the bound cuts the list, what the user approved
    // most recently survives, and `truncated` says the rest exists.
    const window = ranked.slice(0, size).map((r) => r.a);
    return { adaptations: window, total: inScope.length, truncated: inScope.length > window.length, limit: size };
  }

  // --- temporal reads --------------------------------------------------------
  //
  // The temporal view is derived from the same append-only log, with one read per query. Nothing is
  // persisted, so a log written by an older process is read the same way as one written now.
  async #temporalSource() {
    const records = await this.#loadComplete();
    return temporalSourceOf(records, deriveStore(records));
  }

  // The derived log, read once, for a caller that must answer questions about many windows inside one
  // operation. Each window is still sliced, scoped and pattern-detected on its own; sharing this
  // removes only the repeated file read, hash and per-record validation, and it makes the whole
  // operation describe one instant of the log instead of one instant per window.
  async evidenceSnapshot() {
    return this.#temporalSource();
  }

  // The same log replayed to one cutoff: only records stored at or before it, derived by the one
  // derivation every other reader uses. This is what makes "what did APEX know at 09:00" a different
  // question from "what is true now" rather than a filter applied to the current answer: a feedback
  // record, a correction, a review, or an adaptation written after the cutoff is not in the replay at
  // all, so it cannot retire, supersede, or support anything in it.
  //
  // The filter is on recorded time (`createdAt`), the only time every one of the eight kinds carries.
  // Event time is reported by the derived rows and is never used as a cutoff: an operation that
  // requested at 08:59 but finished at 09:01 was recorded after 09:00, and pretending otherwise would
  // rewrite the order in which APEX learned things. A record whose `createdAt` cannot be parsed is
  // excluded and counted, never guessed at; record validation already refuses such a line, so the
  // count is expected to be zero and is reported anyway.
  //
  // `current` is derived from every record and kept separate. Nothing in this method merges the two
  // views, and a later correction cannot reach the historical one. `withCurrent: false` skips the
  // second derivation for a caller that only needs the past view.
  async historicalView(knownAt, { withCurrent = true } = {}) {
    const cutoff = parseIsoInstant(knownAt);
    if (cutoff === null) {
      throw new ValidationError(`"${singleLine(knownAt, 60)}" is not an ISO date or an ISO date-time with a time zone`);
    }
    const cutoffMs = Date.parse(cutoff);
    const records = await this.#loadComplete();
    const known = [];
    let excluded = 0;
    let undated = 0;
    for (const record of records) {
      const at = parseInstant(record.createdAt);
      if (at === null) undated += 1;
      else if (at <= cutoffMs) known.push(record);
      else excluded += 1;
    }
    const derived = deriveStore(known);
    const snapshot = temporalSourceOf(known, derived);
    const current = withCurrent ? deriveStore(records) : null;
    return {
      cutoff,
      records: known.length,
      excluded,
      undated,
      // The derived log at the cutoff, in the shape `evidenceIndex` accepts, so a prediction read at
      // the same cutoff can judge its horizon against exactly these records instead of the live log.
      snapshot,
      experiences: derived.experiences,
      feedback: derived.index.feedback,
      adaptations: derived.adaptations,
      reviews: derived.reviews,
      retiredExperiences: [...derived.retiredExperiences].sort(),
      retiredFeedback: [...derived.retiredFeedback].sort(),
      currentSnapshot: withCurrent ? temporalSourceOf(records, current) : null,
      current: withCurrent ? {
        experiences: current.experiences,
        feedback: current.index.feedback,
        adaptations: current.adaptations,
        reviews: current.reviews,
      } : null,
      note: `replayed ${known.length} experience-log record(s) stored at or before ${cutoff}; ${excluded} later record(s) are not included, so a later feedback, correction, review, or adaptation does not apply`,
    };
  }

  async temporalAnalysis({ since, until, days, capability = null, limit = MAX_TEMPORAL_EVENTS, minEvents = MIN_PATTERN_EVENTS, maxPatterns = MAX_PATTERNS } = {}) {
    const source = await this.#temporalSource();
    const window = resolveWindow({ since, until, days, now: this.now() });
    return analyzeTemporal({ ...source, window, capability, limit, minEvents, maxPatterns });
  }

  // Two windows over one read of the log. With no window A given, A is the same-length period
  // immediately before B, so the default comparison is "the period before" against "now" rather
  // than one window against itself.
  async temporalComparison({ aSince, aUntil, bSince, bUntil, days, capability = null } = {}) {
    const source = await this.#temporalSource();
    const now = this.now();
    const b = resolveWindow({ since: bSince, until: bUntil, days, now });
    const aUngiven = aSince === undefined && aUntil === undefined;
    let a;
    if (aUngiven) {
      const span = b.untilMs - b.sinceMs + 1;
      if (b.sinceMs - span < 0) {
        throw new ValidationError('there is no earlier period of the same length to compare against');
      }
      a = resolveWindow({
        since: new Date(b.sinceMs - span).toISOString(),
        until: new Date(b.sinceMs - 1).toISOString(),
        now,
      });
    } else {
      a = resolveWindow({ since: aSince, until: aUntil, days, now });
    }
    return compareTemporalWindows({ ...source, windowA: a, windowB: b, capability });
  }

  // The bounded form the world-state projection and the model context receive: counts, at most a few
  // capabilities and named patterns, and the limitations that keep it from being read as more.
  async temporalSummary({ since, until, days, capability = null, limit = MAX_TEMPORAL_EVENTS } = {}) {
    const analysis = await this.temporalAnalysis({ since, until, days, capability, limit });
    return summarizeTemporal({ view: analysis.view, patterns: analysis.patterns, adaptations: analysis.adaptations });
  }

  // One authoritative read of the experience log that answers two questions at once, for a caller
  // that must be able to prove what a reference points at: which dated experiences fall in this
  // window (ordered, scoped, bounded, and marked superseded), and whether each named id exists.
  // Read-only and derived - it writes nothing and knows nothing about why it is asked. A corrupt
  // log throws rather than returning a partial index, so an unresolved id always means the record
  // is absent and never that a line could not be read.
  //
  // `snapshot` is the derived log from `evidenceSnapshot()`, for a caller that reads many windows of
  // one operation. It is not a cache: nothing here keeps it, and a caller that holds it across two
  // operations is holding a point-in-time view by its own choice.
  async evidenceIndex({ experienceIds = [], feedbackIds = [], since, until, capability = null, limit = MAX_TEMPORAL_EVENTS, snapshot = null } = {}) {
    if (typeof since !== 'string' || typeof until !== 'string') {
      throw new ValidationError('evidenceIndex needs explicit since and until bounds');
    }
    const wantedExperiences = indexIdList(experienceIds, 'experience ids');
    const wantedFeedback = indexIdList(feedbackIds, 'feedback ids');
    const source = snapshot ?? await this.#temporalSource();
    const window = resolveWindow({ since, until, now: this.now() });
    // The same preparation the window read uses, so the id lookups below are read from the one derived
    // view of the log rather than rebuilt over it. Nothing here is kept between reads: the preparation
    // lives as long as the snapshot it was built from.
    const prep = temporalPreparation(source);
    const analysis = analyzeTemporal({ ...source, window, capability, limit });
    const experienceById = prep.experienceById;
    const feedbackById = prep.feedbackById;
    const resolvedExperiences = [];
    const unresolvedExperienceIds = [];
    for (const id of wantedExperiences) {
      const record = experienceById.get(id);
      if (!record) {
        unresolvedExperienceIds.push(id);
        continue;
      }
      const occurred = occurredAtOf(record);
      resolvedExperiences.push({
        id: record.id,
        operationId: record.operationId,
        capability: record.capability ?? null,
        outcome: record.outcome ?? null,
        outcomeClass: outcomeClass(record.outcome),
        occurredAt: occurred.ms === null ? null : new Date(occurred.ms).toISOString(),
        timeSource: occurred.source,
        undated: occurred.ms === null,
        createdAt: record.createdAt ?? null,
        active: record.active === true,
        superseded: record.superseded === true,
      });
    }
    const resolvedFeedback = [];
    const unresolvedFeedbackIds = [];
    for (const id of wantedFeedback) {
      const record = feedbackById.get(id);
      if (!record) {
        unresolvedFeedbackIds.push(id);
        continue;
      }
      resolvedFeedback.push({
        id: record.id,
        experienceId: record.experienceId,
        assessment: record.assessment,
        createdAt: record.createdAt ?? null,
        experiencePresent: experienceById.has(record.experienceId),
        experienceSuperseded: experienceById.get(record.experienceId)?.superseded === true,
      });
    }
    return {
      window: { since: window.since, until: window.until },
      capability,
      events: analysis.view.events,
      counts: {
        storedExperiences: source.experiences.length,
        storedFeedback: source.feedback.length,
        inWindow: analysis.view.counts.inWindow,
        shown: analysis.view.counts.shown,
        undated: analysis.view.counts.undated,
      },
      truncated: analysis.view.counts.inWindow > analysis.view.counts.shown,
      patternKinds: analysis.patterns.patterns.map((pattern) => pattern.kind),
      experiences: resolvedExperiences,
      unresolvedExperienceIds,
      feedback: resolvedFeedback,
      unresolvedFeedbackIds,
    };
  }

  // Independent verification of one experience against the audit log it names: re-read that record,
  // recompute the canonical evidence and its hash, and compare. This is what the write action's
  // verify runs, and it is why an experience cannot quietly disagree with history.
  async evidenceCheck(target) {
    const ref = typeof target === 'string' ? target.trim() : '';
    if (ref.length === 0) return { ok: false, detail: 'no experience reference was given' };
    if (!this.operations || typeof this.operations.findById !== 'function') {
      return { ok: false, detail: 'no audit log is configured, so this experience cannot be checked against the event it names' };
    }
    const records = await this.#loadComplete();
    const { experiences } = deriveStore(records);
    const matches = experiences.filter((r) => matchesRef(r, ref, [r.operationId]));
    if (matches.length !== 1) {
      return { ok: false, detail: matches.length === 0 ? 'the experience record is not in the store' : 'the experience reference is ambiguous' };
    }
    const experience = matches[0];
    let found;
    try {
      found = await this.operations.findById(experience.operationId);
    } catch (err) {
      return { ok: false, detail: `the audit log could not be read: ${err?.message ?? String(err)}` };
    }
    const result = checkEvidenceAgainstAudit(experience, found?.found ? found.record : null);
    return { ok: result.state === 'verified', detail: result.detail };
  }

  // The same check across the newest `limit` experiences, from one audit read rather than one scan
  // per record. It is a diagnostic: it writes nothing and changes nothing.
  async evidenceReport({ limit = 20 } = {}) {
    const records = await this.#loadComplete();
    const { experiences } = deriveStore(records);
    const window = experiences.slice(-Math.max(1, limit)).reverse();
    let byId = null;
    let auditCorrupt = null;
    let detail = null;
    if (this.operations && typeof this.operations.inspect === 'function') {
      try {
        const loaded = await this.operations.inspect();
        byId = new Map();
        for (const op of loaded.records ?? []) {
          if (!byId.has(op.id)) byId.set(op.id, op);
        }
        auditCorrupt = (loaded.corrupt ?? []).length;
      } catch (err) {
        detail = err?.message ?? String(err);
      }
    } else {
      detail = 'no audit log is configured for this store';
    }

    const samples = [];
    let verified = 0;
    let mismatched = 0;
    let missingAudit = 0;
    for (const experience of window) {
      const result = byId
        ? checkEvidenceAgainstAudit(experience, byId.get(experience.operationId))
        : { state: 'unavailable', detail };
      if (result.state === 'verified') verified += 1;
      else if (result.state === 'mismatch') mismatched += 1;
      else if (result.state === 'missing_audit') missingAudit += 1;
      if (result.state !== 'verified' && samples.length < MAX_HEALTH_SAMPLES) {
        samples.push({
          id: experience.id,
          shortId: shortId(experience.id),
          operationId: experience.operationId,
          state: result.state,
          detail: result.detail,
        });
      }
    }
    return {
      checked: window.length,
      experiences: experiences.length,
      verified,
      mismatched,
      missingAudit,
      auditReadable: byId !== null,
      auditCorruptLines: auditCorrupt,
      samples,
    };
  }

  async health() {
    let loaded;
    try {
      loaded = await this.log.load();
    } catch (err) {
      return summarizeExperienceHealth(null, [], { path: this.filePath, detail: err?.message ?? String(err) });
    }
    return summarizeExperienceHealth(loaded.records, loaded.corrupt, { path: this.filePath });
  }
}

// ---- reference resolution ---------------------------------------------------

function resolveReplacedExperiences(experiences, refs, retired) {
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const matches = experiences.filter((r) => matchesRef(r, ref));
    if (matches.length === 0) throw new ValidationError('a corrected experience was not found');
    if (matches.length > 1) throw new ValidationError('a corrected experience is ambiguous; use a longer id prefix');
    const target = matches[0];
    if (seen.has(target.id)) throw new ValidationError(`a corrected experience names [${shortId(target.id)}] more than once`);
    if (retired.has(target.id)) throw new ValidationError(`experience [${shortId(target.id)}] is already corrected by a later record`);
    if (!isScopableCapability(target.capability)) {
      throw new ValidationError(`experience [${shortId(target.id)}] has no capability scope; only a scoped experience can be corrected`);
    }
    seen.add(target.id);
    out.push(target);
  }
  return out;
}

function resolveSupersededFeedback(feedback, refs, retired, experienceId) {
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const matches = feedback.filter((r) => matchesRef(r, ref));
    if (matches.length === 0) throw new ValidationError('a superseded feedback record was not found');
    if (matches.length > 1) throw new ValidationError('a superseded feedback record is ambiguous; use a longer id prefix');
    const target = matches[0];
    if (target.experienceId !== experienceId) {
      throw new ValidationError(`feedback [${shortId(target.id)}] is about a different experience; only feedback on the same experience can be corrected`);
    }
    if (seen.has(target.id)) throw new ValidationError(`feedback [${shortId(target.id)}] is named more than once`);
    if (retired.has(target.id)) throw new ValidationError(`feedback [${shortId(target.id)}] has already been corrected by a later record`);
    seen.add(target.id);
    out.push(target);
  }
  return out;
}

function resolveAdaptationRef(adaptations, ref, label) {
  const matches = adaptations.filter((a) => matchesRef(a, ref));
  if (matches.length === 0) throw new ValidationError(`${label} not found; it must be a derived adaptation record`);
  if (matches.length > 1) throw new ValidationError(`${label} is ambiguous; use a longer id prefix`);
  return matches[0];
}

function resolveReviewRef(reviews, ref, label) {
  const matches = reviews.filter((r) => matchesRef(r, ref));
  if (matches.length === 0) throw new ValidationError(`${label} not found; it must be a recorded governance review`);
  if (matches.length > 1) throw new ValidationError(`${label} is ambiguous; use a longer id prefix`);
  return matches[0];
}

// ---- independent evidence check ---------------------------------------------

function checkEvidenceAgainstAudit(experience, auditRecord) {
  if (!auditRecord) {
    return { state: 'missing_audit', detail: `operation [${shortId(experience.operationId)}] is not in the audit log, so this experience cannot be re-checked` };
  }
  let evidence;
  try {
    evidence = evidenceFromOperation(auditRecord);
  } catch (err) {
    return { state: 'mismatch', detail: `the audit record could not be read as evidence: ${err?.message ?? String(err)}` };
  }
  if (experience.evidenceSha256 !== evidenceSha(evidence)) {
    return { state: 'mismatch', detail: `the audit record for [${shortId(experience.operationId)}] no longer matches the experience summary of it` };
  }
  if (stableStringify(experience.evidence) !== stableStringify(evidence)) {
    return { state: 'mismatch', detail: `the stored evidence for [${shortId(experience.operationId)}] disagrees with the audit record it names` };
  }
  return { state: 'verified', detail: `experience [${shortId(experience.id)}] matches the audit record [${shortId(experience.operationId)}]` };
}

// ---- store-wide health ------------------------------------------------------

// Counts are exact over readable records; anomaly samples are capped so a damaged store cannot
// produce unbounded output. Nothing here is written back: health reports, it does not fix.
export function summarizeExperienceHealth(records, corrupt = [], { path = null, detail = null } = {}) {
  if (!Array.isArray(records)) {
    return {
      path,
      state: 'unavailable',
      inspected: false,
      complete: false,
      detail,
      records: null,
      experiences: null,
      feedback: null,
      adaptations: null,
      decisions: null,
      retirements: null,
      guidance: null,
      reviews: null,
      reviewDecisions: null,
      outcomeEvaluations: null,
      measurements: null,
      rollbacks: null,
      openReviews: null,
      currentReviews: null,
      activeExperiences: null,
      supersededExperiences: null,
      recordedByUser: null,
      capturedAutomatically: null,
      unknownCapture: null,
      currentFeedback: null,
      supersededFeedback: null,
      candidates: null,
      approved: null,
      activeAdaptations: null,
      rejectedAdaptations: null,
      retiredAdaptations: null,
      ambiguousAdaptations: null,
      conflicts: { scopes: null, adaptations: null, samples: [] },
      pending: { derivableCandidates: null, scopes: [] },
      corruptLines: null,
      corrupt: [],
      anomalies: { count: null, samples: [], truncated: false },
      attention: true,
    };
  }

  const position = new Map(records.map((r, i) => [r.id, i]));
  const { index, retiredExperiences, retiredFeedback, experiences, adaptations, reviews } = deriveStore(records);
  const experiencesById = new Map(index.experiences.map((r) => [r.id, r]));
  const feedbackById = new Map(index.feedback.map((r) => [r.id, r]));
  const adaptationsById = new Map(index.adaptations.map((r) => [r.id, r]));
  const evaluationsById = new Map(index.evaluations.map((r) => [r.id, r]));
  const measurementsById = new Map(index.measurements.map((r) => [r.id, r]));

  const samples = [];
  let anomalyCount = 0;
  const anomaly = (message) => {
    anomalyCount += 1;
    if (samples.length < MAX_HEALTH_SAMPLES) samples.push(message);
  };

  const liveByOperation = new Map();
  for (const record of experiences) {
    // The `none` sentinel is the expected state of an experience for a request that was refused
    // before any capability was chosen: `adaptationEligible` already tells the reader it cannot
    // support a rule, so it is history rather than damage. Only a capability that record validation
    // should never have accepted is worth the user's attention here.
    if (record.capability !== null && !isRecordableCapability(record.capability)) {
      anomaly(`[${shortId(record.id)}] has a capability that cannot name an adaptation scope`);
    }
    for (const id of record.replaces ?? []) {
      if (id === record.id) anomaly(`[${shortId(record.id)}] corrects itself`);
      else if (!experiencesById.has(id)) anomaly(`[${shortId(record.id)}] corrects [${shortId(id)}], which is not a recorded experience`);
    }
    if (!record.active) continue;
    const prior = liveByOperation.get(record.operationId);
    if (prior) anomaly(`[${shortId(prior)}] and [${shortId(record.id)}] are both live experiences of [${shortId(record.operationId)}]`);
    else liveByOperation.set(record.operationId, record.id);
  }
  const inCycle = loopRetired(index.experiences, retiredExperiences, 'replaces');
  if (inCycle.length > 0) {
    anomaly(`${inCycle.length} experience record(s) are retired only through a correction loop: ${inCycle.slice(0, 3).map((r) => shortId(r.id)).join(', ')}`);
  }

  for (const entry of index.feedback) {
    if (!experiencesById.has(entry.experienceId)) {
      anomaly(`feedback [${shortId(entry.id)}] assesses [${shortId(entry.experienceId)}], which is not a recorded experience`);
    }
    for (const id of entry.supersedes ?? []) {
      const target = feedbackById.get(id);
      if (!target) anomaly(`feedback [${shortId(entry.id)}] corrects [${shortId(id)}], which is not recorded feedback`);
      else if (target.experienceId !== entry.experienceId) {
        anomaly(`feedback [${shortId(entry.id)}] corrects [${shortId(id)}], which is about a different experience`);
      }
    }
  }
  const feedbackCycle = loopRetired(index.feedback, retiredFeedback, 'supersedes');
  if (feedbackCycle.length > 0) {
    anomaly(`${feedbackCycle.length} feedback record(s) are retired only through a correction loop: ${feedbackCycle.slice(0, 3).map((r) => shortId(r.id)).join(', ')}`);
  }
  for (const event of index.decisions) {
    if (!adaptationsById.has(event.targetId)) {
      anomaly(`decision [${shortId(event.id)}] names [${shortId(event.targetId)}], which is not a derived adaptation`);
    }
  }
  for (const event of index.retirements) {
    if (!adaptationsById.has(event.targetId)) {
      anomaly(`retirement [${shortId(event.id)}] names [${shortId(event.targetId)}], which is not a derived adaptation`);
    }
  }
  const reviewsById = new Map(reviews.map((r) => [r.id, r]));
  for (const review of reviews) {
    const target = adaptationsById.get(review.targetId);
    if (!target) {
      anomaly(`review [${shortId(review.id)}] names [${shortId(review.targetId)}], which is not a derived adaptation`);
      continue;
    }
    if (review.evidence.rule.hash !== target.ruleHash) {
      anomaly(`review [${shortId(review.id)}] records a rule hash that the adaptation no longer states`);
    } else if ((review.evidence.rule.version ?? null) !== (target.shapeVersion ?? null)) {
      anomaly(`review [${shortId(review.id)}] records version ${review.evidence.rule.version ?? 'unrecorded'}, but the adaptation stands at ${target.shapeVersion ?? 'unrecorded'}`);
    }
  }
  for (const event of index.reviewDecisions) {
    const review = reviewsById.get(event.reviewId);
    if (!review) {
      anomaly(`review decision [${shortId(event.id)}] names [${shortId(event.reviewId)}], which is not a recorded review`);
      continue;
    }
    if (event.targetId !== review.targetId) {
      anomaly(`review decision [${shortId(event.id)}] names an adaptation the review does not`);
    }
    const prior = index.reviewDecisions.filter((d) => d.reviewId === event.reviewId);
    if (prior.length > 1 && prior.at(-1).id === event.id) {
      anomaly(`review [${shortId(event.reviewId)}] has ${prior.length} decisions`);
    }
    if (event.decision === 'retire') {
      const retirement = index.retirements.find((r) => r.id === event.retirementId) ?? null;
      if (!retirement) anomaly(`review decision [${shortId(event.id)}] names a retirement record that is not stored`);
      else if (retirement.targetId !== event.targetId) {
        anomaly(`review decision [${shortId(event.id)}] names a retirement of a different adaptation`);
      }
    }
  }
  for (const record of adaptations) {
    for (const problem of record.supportProblems) anomaly(`adaptation [${shortId(record.id)}] ${problem}`);
    const ownRetirements = index.retirements.filter((r) => r.targetId === record.id);
    if (ownRetirements.length > 1) anomaly(`adaptation [${shortId(record.id)}] has ${ownRetirements.length} retirement records`);
    const lastDecision = index.decisions.filter((d) => d.targetId === record.id).at(-1) ?? null;
    // Apparent order by timestamp is not enough: with one injected clock two events share a
    // timestamp, so log position is what says whether a decision followed the retirement.
    if (lastDecision && ownRetirements.some((r) => (position.get(r.id) ?? -1) < (position.get(lastDecision.id) ?? 0))) {
      anomaly(`decision [${shortId(lastDecision.id)}] was recorded after adaptation [${shortId(record.id)}] was retired`);
    }
  }
  // T-08 records are checked the same way every other kind is: each citation must resolve, and a
  // rollback must name a measurement that recorded a regression of the same adaptation.
  for (const evaluation of index.evaluations) {
    for (const id of evaluation.evidence.experienceIds) {
      if (!experiencesById.has(id)) anomaly(`evaluation [${shortId(evaluation.id)}] cites experience [${shortId(id)}], which is not recorded`);
    }
    for (const id of evaluation.evidence.feedbackIds) {
      if (!feedbackById.has(id)) anomaly(`evaluation [${shortId(evaluation.id)}] cites feedback [${shortId(id)}], which is not recorded`);
    }
  }
  for (const measurement of index.measurements) {
    if (!adaptationsById.has(measurement.targetId)) {
      anomaly(`measurement [${shortId(measurement.id)}] names [${shortId(measurement.targetId)}], which is not a derived adaptation`);
    }
    for (const id of [...measurement.baseline.evaluationIds, ...measurement.followUp.evaluationIds]) {
      if (!evaluationsById.has(id)) anomaly(`measurement [${shortId(measurement.id)}] cites evaluation [${shortId(id)}], which is not recorded`);
    }
  }
  for (const rollback of index.rollbacks) {
    if (!adaptationsById.has(rollback.targetId)) {
      anomaly(`rollback [${shortId(rollback.id)}] names [${shortId(rollback.targetId)}], which is not a derived adaptation`);
      continue;
    }
    const measurement = measurementsById.get(rollback.measurementId);
    if (!measurement) anomaly(`rollback [${shortId(rollback.id)}] names measurement [${shortId(rollback.measurementId)}], which is not recorded`);
    else if (measurement.targetId !== rollback.targetId) anomaly(`rollback [${shortId(rollback.id)}] names a measurement of a different adaptation`);
    else if (measurement.verdict !== 'regressed') anomaly(`rollback [${shortId(rollback.id)}] rests on a measurement whose verdict is ${measurement.verdict}`);
  }
  const scopeRule = new Map();
  for (const record of adaptations) {
    if (record.decisionState === 'retired' || record.decisionState === 'ambiguous') continue;
    const key = `${record.capability}\u0000${record.ruleHash}`;
    const prior = scopeRule.get(key);
    if (prior) anomaly(`[${shortId(prior)}] and [${shortId(record.id)}] are both recorded for scope ${record.capability} with the same rule`);
    else scopeRule.set(key, record.id);
  }

  const conflicts = summarizeConflicts(adaptations);
  const pending = summarizePending(index, experiencesById, retiredExperiences, retiredFeedback);
  const count = (state) => adaptations.filter((a) => a.decisionState === state).length;

  return {
    path,
    state: corrupt.length > 0 ? 'damaged' : 'ok',
    inspected: true,
    complete: corrupt.length === 0,
    detail: null,
    records: records.length,
    experiences: index.experiences.length,
    feedback: index.feedback.length,
    adaptations: index.adaptations.length,
    decisions: index.decisions.length,
    retirements: index.retirements.length,
    guidance: index.guidance.length,
    reviews: index.reviews.length,
    reviewDecisions: index.reviewDecisions.length,
    outcomeEvaluations: index.evaluations.length,
    measurements: index.measurements.length,
    rollbacks: index.rollbacks.length,
    // A review is open when no decision has been recorded against it and no later review of the
    // same adaptation has replaced it. Both are derived, never stored.
    openReviews: reviews.filter((r) => r.decisionCount === 0 && r.supersededBy.length === 0).length,
    currentReviews: reviews.filter((r) => r.current).length,
    activeExperiences: experiences.length - retiredExperiences.size,
    supersededExperiences: retiredExperiences.size,
    recordedByUser: index.experiences.filter((r) => captureOf(r) === CAPTURE_EXPLICIT).length,
    capturedAutomatically: index.experiences.filter((r) => captureOf(r) === CAPTURE_AUTOMATIC).length,
    unknownCapture: index.experiences.filter((r) => captureOf(r) === CAPTURE_UNKNOWN).length,
    currentFeedback: index.feedback.length - retiredFeedback.size,
    supersededFeedback: retiredFeedback.size,
    candidates: count('candidate'),
    approved: count('approved'),
    activeAdaptations: adaptations.filter((a) => a.active).length,
    measuredAdaptations: adaptations.filter((a) => a.stage === 'measured').length,
    retainedAdaptations: adaptations.filter((a) => a.stage === 'retained').length,
    rolledBackAdaptations: adaptations.filter((a) => a.rolledBack === true).length,
    rejectedAdaptations: count('rejected'),
    retiredAdaptations: count('retired'),
    ambiguousAdaptations: count('ambiguous'),
    conflicts,
    pending,
    corruptLines: corrupt.length,
    corrupt: corrupt.map((entry) => ({ line: entry.line, reason: entry.reason, truncatedTail: Boolean(entry.truncatedTail) })),
    anomalies: { count: anomalyCount, samples, truncated: anomalyCount > samples.length },
    // Damage, ambiguity, an unresolved conflict, and a stale support link all need the user.
    // Candidates, approvals and rejections are ordinary history and do not.
    attention: corrupt.length > 0 || anomalyCount > 0 || conflicts.scopes > 0,
  };
}

function summarizeConflicts(adaptations) {
  const samples = [];
  let scopes = 0;
  let count = 0;
  for (const group of groupBy(adaptations.filter((a) => a.active), (a) => a.capability).values()) {
    if (new Set(group.map((r) => r.ruleHash)).size < 2) continue;
    scopes += 1;
    count += group.length;
    if (samples.length < 5) samples.push(`${group[0].capability}: ${group.map((r) => shortId(r.id)).join(', ')}`);
  }
  return { scopes, adaptations: count, samples };
}

// Evidence that would support another candidate but has not been derived yet. This is the user's
// next step, not damage, so it is reported separately and never raises `attention`.
function summarizePending(index, experiencesById, retiredExperiences, retiredFeedback) {
  const retiredTargets = new Set(index.retirements.map((r) => r.targetId));
  const specs = deriveCandidateSpecs({
    experiences: index.experiences.filter((r) =>
      !retiredExperiences.has(r.id) && r.adaptationEligible === true && isScopableCapability(r.capability)),
    feedback: index.feedback.filter((r) => experiencesById.has(r.experienceId)),
    supersededFeedbackIds: [...retiredFeedback],
    existingAdaptations: index.adaptations.map((a) => ({ capability: a.capability, rule: a.rule, retired: retiredTargets.has(a.id) })),
  });
  return {
    derivableCandidates: specs.created.length,
    scopes: [...new Set(specs.created.map((s) => s.capability))].slice(0, MAX_HEALTH_SAMPLES),
  };
}
