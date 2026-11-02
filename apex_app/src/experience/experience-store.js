// Experience, feedback, and adaptation store. One append-only JSONL log holds five record kinds,
// and every state a reader reports is derived from them:
//
//   experience             an event that happened: a verified reference to one audit record
//   feedback               the user's own assessment of that event, in the user's own words
//   adaptation             a candidate behaviour change, derived deterministically from the two above
//   adaptation_decision    the user's approval or rejection of one candidate
//   adaptation_retirement  the user's explicit end for one adaptation
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
import { CONTROL_CHARS, shortId } from '../util.js';
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
  MAX_PATTERNS,
  MAX_TEMPORAL_EVENTS,
  MIN_PATTERN_EVENTS,
  analyzeTemporal,
  compareTemporalWindows,
  outcomeClass,
  parseInstant,
  resolveWindow,
  summarizeTemporal,
} from './temporal.js';

export const EXPERIENCE_SCHEMA = 1;

export const EXPERIENCE_KIND = 'experience';
export const FEEDBACK_KIND = 'feedback';
export const ADAPTATION_KIND = 'adaptation';
export const DECISION_KIND = 'adaptation_decision';
export const RETIREMENT_KIND = 'adaptation_retirement';
export const RECORD_KINDS = Object.freeze([
  EXPERIENCE_KIND, FEEDBACK_KIND, ADAPTATION_KIND, DECISION_KIND, RETIREMENT_KIND,
]);

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

function validateAdaptation(r) {
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'adaptation has missing or invalid id';
  if (!isScopableCapability(r.capability)) return 'adaptation capability is not a dotted capability name';
  const rule = storedTextProblem(r.rule, 'rule', MAX_RULE_CHARS);
  if (rule) return rule;
  if (typeof r.ruleHash !== 'string' || r.ruleHash.length !== 64) return 'adaptation has missing or invalid ruleHash';
  if (r.ruleHash !== sha256Hex(normalizeRuleText(r.rule))) return 'adaptation ruleHash does not match its rule';
  if (r.method !== DERIVATION_METHOD) return 'adaptation was not produced by the recorded derivation method';
  if (!Number.isInteger(r.minSupport) || r.minSupport < 1 || r.minSupport > MAX_SUPPORT_REFS) return 'adaptation minSupport is out of range';
  if (!r.support || typeof r.support !== 'object' || Array.isArray(r.support)) return 'adaptation has no supporting evidence';
  const experiences = storedIdListProblem(r.support.experienceIds, 'adaptation supporting experiences', MAX_SUPPORT_REFS);
  if (experiences) return experiences;
  const feedback = storedIdListProblem(r.support.feedbackIds, 'adaptation supporting feedback', MAX_SUPPORT_REFS);
  if (feedback) return feedback;
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

// ---- derived state ----------------------------------------------------------

function splitRecords(records) {
  const experiences = [];
  const feedback = [];
  const adaptations = [];
  const decisions = [];
  const retirements = [];
  for (const record of records) {
    if (record.kind === EXPERIENCE_KIND) experiences.push(record);
    else if (record.kind === FEEDBACK_KIND) feedback.push(record);
    else if (record.kind === ADAPTATION_KIND) adaptations.push(record);
    else if (record.kind === DECISION_KIND) decisions.push(record);
    else retirements.push(record);
  }
  return { experiences, feedback, adaptations, decisions, retirements };
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

function summarizeRetirement(event) {
  return {
    id: event.id,
    reason: event.reason ?? null,
    createdAt: event.createdAt,
    operationId: event.provenance?.operationId ?? null,
  };
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
  return { index, retiredExperiences, retiredFeedback, experiences, adaptations };
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

  const annotated = index.adaptations.map((record) => {
    const events = decisionsByTarget.get(record.id) ?? [];
    const retirements = retirementsByTarget.get(record.id) ?? [];
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

    return {
      ...record,
      decisionState,
      active: decisionState === 'approved' && supportIntact,
      inactiveReason,
      retired: decisionState === 'retired',
      ambiguous: decisionState === 'ambiguous',
      retirement: retirements.length === 1 ? summarizeRetirement(retirements[0]) : null,
      decisions: events.slice(-MAX_SAMPLES).map(summarizeDecision),
      decision: latest ? summarizeDecision(latest) : null,
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
// reader can see which of the three a timestamp came from.
function occurredAtOf(record) {
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
    this.log = new JsonlStore(filePath, { validateRecord: validateExperienceRecord, parseCacheBytes });
    // Each write derives its decision from the whole authoritative log - what is already recorded
    // for that operation, which feedback is still current, which candidates exist - and then
    // appends. The lock covers read-derive-append for one store, so two processes cannot each
    // decide from a state the other has not written yet.
    this.writeLock = new WriterLock(filePath, { waitMs: lockWaitMs, retryMs: lockRetryMs, retryMaxMs: lockRetryMaxMs });
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
    const { index, retiredExperiences, retiredFeedback } = deriveStore(records);
    const retiredTargets = new Set(index.retirements.map((r) => r.targetId));
    const experiences = index.experiences.filter((r) =>
      !retiredExperiences.has(r.id) && r.adaptationEligible === true && isScopableCapability(r.capability));

    const specs = deriveCandidateSpecs({
      experiences,
      feedback: index.feedback,
      supersededFeedbackIds: [...retiredFeedback],
      existingAdaptations: index.adaptations.map((a) => ({ capability: a.capability, rule: a.rule, retired: retiredTargets.has(a.id) })),
      minSupport,
    });

    const created = [];
    const skipped = [...specs.skipped];
    for (const spec of specs.created) {
      if (spec.support.experienceIds.length > MAX_SUPPORT_REFS || spec.support.feedbackIds.length > MAX_SUPPORT_REFS) {
        skipped.push({
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
    return { created, skipped, minSupport: specs.minSupport };
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

  // --- reads -----------------------------------------------------------------

  // One authoritative read. `beforeAppend` marks the read a write performs first, which may reuse
  // this instance's incrementally maintained validated records (see ../memory/jsonl-store.js).
  async #loadComplete({ beforeAppend = false } = {}) {
    const { records, corrupt } = beforeAppend ? await this.log.loadForAppend() : await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`experience store contains ${corrupt.length} corrupt line(s); refusing an incomplete experience operation`);
    }
    return records;
  }

  async lockReport() {
    return this.writeLock.state();
  }

  async recover() {
    return this.writeLock.recover();
  }

  async status() {
    const { records, corrupt } = await this.log.load();
    const { index, adaptations } = deriveStore(records);
    return {
      path: this.filePath,
      records: records.length,
      experiences: index.experiences.length,
      recordedByUser: index.experiences.filter((r) => captureOf(r) === CAPTURE_EXPLICIT).length,
      capturedAutomatically: index.experiences.filter((r) => captureOf(r) === CAPTURE_AUTOMATIC).length,
      unknownCapture: index.experiences.filter((r) => captureOf(r) === CAPTURE_UNKNOWN).length,
      feedback: index.feedback.length,
      adaptations: index.adaptations.length,
      decisions: index.decisions.length,
      retirements: index.retirements.length,
      activeAdaptations: adaptations.filter((a) => a.active).length,
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
    const { adaptations } = deriveStore(records);
    const kept = includeRetired ? adaptations : adaptations.filter((a) => a.decisionState !== 'retired');
    return kept.slice(-Math.max(1, limit)).reverse();
  }

  async adaptationDetail(target) {
    const ref = typeof target === 'string' ? target.trim() : '';
    if (ref.length === 0) return null;
    const records = await this.#loadComplete();
    const { adaptations } = deriveStore(records);
    const matches = adaptations.filter((a) => matchesRef(a, ref));
    if (matches.length === 0) return null;
    if (matches.length > 1) throw new ValidationError('the adaptation target is ambiguous; use a longer id prefix');
    return matches[0];
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
    const { adaptations } = deriveStore(records);
    const inScope = adaptations.filter((a) => a.active && scopeMatches(a, { capability, terms: null }));
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
    const derived = deriveStore(records);
    // Order within one timestamp comes from the file, and the file holds every record kind, so the
    // position map is built over all of them rather than over the derived experience array.
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

  // The derived log, read once, for a caller that must answer questions about many windows inside one
  // operation. Each window is still sliced, scoped and pattern-detected on its own; sharing this
  // removes only the repeated file read, hash and per-record validation, and it makes the whole
  // operation describe one instant of the log instead of one instant per window.
  async evidenceSnapshot() {
    return this.#temporalSource();
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
    const analysis = analyzeTemporal({ ...source, window, capability, limit });
    const experienceById = new Map(source.experiences.map((record) => [record.id, record]));
    const feedbackById = new Map(source.feedback.map((record) => [record.id, record]));
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
  const { index, retiredExperiences, retiredFeedback, experiences, adaptations } = deriveStore(records);
  const experiencesById = new Map(index.experiences.map((r) => [r.id, r]));
  const feedbackById = new Map(index.feedback.map((r) => [r.id, r]));
  const adaptationsById = new Map(index.adaptations.map((r) => [r.id, r]));

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
