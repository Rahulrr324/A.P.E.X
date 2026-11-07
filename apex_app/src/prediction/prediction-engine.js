// Prediction ledger: the vocabulary and the pure derivations.
//
// APEX already keeps three kinds of information about the past - what happened (an experience,
// copied from an audit record), what the user said about it (feedback), and what order those two
// describe (the temporal projection). None of them is an expectation. This module adds the fourth
// and fifth kinds, and keeps them apart:
//
//   prediction               what the user expects to happen, by when, and on what evidence
//   prediction_invalidation  the user's explicit withdrawal of one expectation, with its reason
//   prediction_evaluation    the deterministic result of judging one expectation against recorded
//                            outcome evidence
//
// Everything a reader reports is derived from those records plus what the caller supplies from the
// experience log; no record stores a status. Six states have precise, testable meanings (see
// PREDICTION_STATUSES). `proposed` is deliberately absent: a proposal is a request that has not been
// authorized yet, and a stored record cannot be one.
//
// Two guarantees are structural rather than polite:
//   1. no evidence dated before the prediction can establish its outcome - the evaluation horizon
//      starts at the prediction's own createdAt, so nothing that was already true when the user made
//      the expectation can later be presented as the thing that proved it right;
//   2. an expectation is never an observation - nothing here reads, writes, or becomes an
//      experience, a feedback record, an adaptation, or an authorization decision.
import { ValidationError } from '../errors.js';
import { OUTCOME_VALUES } from '../outcomes.js';
import { CONTROL_CHARS, shortId, singleLine, truncate } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { PATTERN_KINDS, outcomeClass, parseInstant } from '../experience/temporal.js';

export const PREDICTION_SCHEMA = 1;

export const PREDICTION_KIND = 'prediction';
export const INVALIDATION_KIND = 'prediction_invalidation';
export const EVALUATION_KIND = 'prediction_evaluation';
export const PREDICTION_RECORD_KINDS = Object.freeze([PREDICTION_KIND, INVALIDATION_KIND, EVALUATION_KIND]);

// What a prediction expects. These are the three outcome classes the experience log can establish
// (temporal.js `outcomeClass`), so an expectation is only ever about something a later record can
// settle; there is no `improved` or `succeeded_eventually` left for a reader to guess at.
export const EXPECTATIONS = Object.freeze(['success', 'failure', 'blocked']);

// Whether the prediction cites stored records. Derived from the citation lists and then checked, so
// a record cannot claim support it does not name.
export const EVIDENCE_BASIS = Object.freeze(['cited', 'none_cited']);

// The six lifecycle states, listed in precedence order: the first one whose rule holds is the state
// a reader reports (see `resolveStatus`). A retired expectation reports `superseded` even when it
// carries a recorded verdict, because its own reader decision is `superseded` and the aggregate rate
// excludes it: two derived fields about one record must not disagree, and a state that counts toward
// `evaluated` while no denominator includes it would overstate how much of the ledger was scored.
// The verdict itself stays with the record and stays readable.
export const PREDICTION_STATUSES = Object.freeze([
  'invalidated',
  'superseded',
  'evaluated',
  'awaiting_evaluation',
  'expired',
  'recorded',
]);

// The two verdicts a record can carry. Every other decision the evaluator derives writes nothing.
export const EVALUATION_VERDICTS = Object.freeze(['matched', 'contradicted']);

// Every outcome the deterministic evaluator can report, including the ones that record nothing.
export const EVALUATION_DECISIONS = Object.freeze([
  ...EVALUATION_VERDICTS,
  'already_evaluated',
  'invalidated',
  'superseded',
  'outcome_unavailable',
  'insufficient_evidence',
  'expired',
  'evidence_unavailable',
]);

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The outcome classes that can settle an expectation. `other` and `unknown` are outcomes a record
// really carries, and they establish nothing either way, so they are counted and excluded.
const ESTABLISHING_CLASSES = new Set(['success', 'failure', 'blocked']);

export const MAX_SUBJECT_CHARS = 300;
export const MAX_REASON_CHARS = 500;
export const MAX_CONTEXT_CHARS = 200;
export const MAX_EVIDENCE_IDS = 20;
export const MAX_PATTERN_KIND_CITES = PATTERN_KINDS.length;
export const MAX_REPLACES = 10;
export const MAX_PREDICTION_LIST = 50;
export const MAX_PREDICTION_HORIZON_DAYS = 366;
export const MAX_EVIDENCE_SHOWN = 20;
export const MAX_CALIBRATION_CAPABILITIES = 20;
export const MAX_PREDICTION_LINE_CHARS = 220;
// How many standing expectations a model context or projection may be shown at all. The ledger may
// hold far more; a reader that lists them all would be injecting the whole ledger into a prompt.
export const MAX_PREDICTION_PROMPT_ITEMS = 4;
// Below this many recorded evaluations no ratio is printed at all. Three evaluations look like a
// measurement and are one, so the counts are reported and the rate is withheld with its reason.
export const MIN_CALIBRATION_EVALUATIONS = 20;

const DAY_MS = 86_400_000;

// Every prediction carries this list, and every reader recomputes it from the record's own canonical
// fields. Storing it means the statement of limitations travels with the record; deriving it means
// the author cannot pick a weaker one.
export const LIMITATION_CODES = Object.freeze([
  'expectation_not_observation',
  'confidence_unavailable',
  'no_cited_evidence',
  'pattern_kinds_descriptive',
  'expiry_not_failure',
  'no_authorization',
]);

export const LIMITATION_TEXT = Object.freeze({
  expectation_not_observation: 'an expectation about a later event, not evidence that anything happened',
  confidence_unavailable: 'no confidence value: this build supplies none and computes none',
  no_cited_evidence: 'names no supporting record, so nothing here shows why it was expected',
  pattern_kinds_descriptive: 'cited patterns describe the order of recorded outcomes, not a cause',
  expiry_not_failure: 'passing its horizon without outcome evidence is expiry, not a wrong prediction',
  no_authorization: 'grants no permission, approval, or adaptation to anything',
});

export const CONFIDENCE_UNAVAILABLE_REASON = 'this build records no confidence: no defensible method exists for supplying one, so none is invented';

// What any aggregate read of this ledger states. A count of evaluations is not a calibration, and a
// rate printed under a stated denominator is still not a reliability claim.
export const PREDICTION_LIMITS = Object.freeze([
  'A prediction is the user\'s recorded expectation. It is not an observation, an experience, a verified outcome, or evidence that anything happened.',
  'Outcome evidence is only a live experience record dated at or after the prediction and inside its horizon. Nothing recorded before the prediction was made can establish its result.',
  'A verdict needs a recorded outcome that classifies as success, failure, or blocked. No such record means no result, not a failed prediction.',
  'A prediction whose horizon passed with no outcome evidence is expired. Expiry is never counted as wrong and never as a match.',
  'Match rates are counts of recorded evaluations over a stated denominator, with every exclusion named. They are not calibrated probabilities, not reliability claims, and not a basis for adjusting any confidence.',
  'No prediction carries a confidence value in this build, so none is compared, averaged, or calibrated.',
  'A prediction authorizes nothing: not an action, not an adaptation, not a memory or knowledge write. Authorization stays with the action registry.',
  'Records are ordered by their horizon timestamp, then by log position, then by id; equal timestamps keep append order.',
]);

export function citesEvidence(record) {
  const evidence = record?.evidence ?? {};
  return [evidence.supportingExperienceIds, evidence.contradictingExperienceIds, evidence.feedbackIds, evidence.patternKinds]
    .some((list) => Array.isArray(list) && list.length > 0);
}

export function deriveLimitations(record) {
  const codes = ['expectation_not_observation', 'confidence_unavailable'];
  if (!citesEvidence(record)) codes.push('no_cited_evidence');
  if ((record?.evidence?.patternKinds ?? []).length > 0) codes.push('pattern_kinds_descriptive');
  codes.push('expiry_not_failure', 'no_authorization');
  return codes;
}

// ---- field rules ------------------------------------------------------------

// An error never quotes the offending value: subject and reason are user text and can reach the audit
// record through the execution error.
export function storedTextProblem(value, name, max) {
  if (typeof value !== 'string' || value.length === 0) return `missing ${name}`;
  if (value.length > max) return `${name} is too long`;
  if (CONTROL_CHARS.test(value)) return `${name} contains control characters`;
  if (containsSecret(value)) return `${name} looks like a password, key, or token`;
  return null;
}

export function validateTextField(value, name, { required = true, max = MAX_SUBJECT_CHARS } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) throw new ValidationError(`${name} is empty`);
  if (trimmed.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if (CONTROL_CHARS.test(trimmed)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(trimmed)) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  }
  return trimmed || null;
}

export function isPredictionId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

// A reference a caller types is not a stored id. Every read of this application prints a record as
// its first eight characters, so a citation that demanded a whole UUID could never be typed back;
// the store resolves a reference against the log it must exist in and appends the exact id, which
// `storedIdListProblem` then requires. Nothing matches two records: an ambiguous prefix is refused.
const MIN_REF_CHARS = 8;
const REF_RE = /^(?:[0-9a-f]{8,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function isRecordRef(value) {
  return typeof value === 'string' && REF_RE.test(value.trim());
}

// One sentence, shared by the action that refuses the input and the store that refuses the write, so
// the two boundaries can never state the rule differently. The typed value is never quoted back: it
// can reach the audit record through the execution error.
export function invalidRefMessage(name) {
  return `${name} has an invalid id: cite a record by its full id or by at least ${MIN_REF_CHARS} leading characters, exactly as the CLI prints them`;
}

export function validateRefList(values, name, max) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new ValidationError(`${name} must be a list of record ids`);
  if (values.length > max) throw new ValidationError(`${name} may name at most ${max} ids`);
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string') throw new ValidationError(`${name} has a non-text id`);
    const ref = value.trim();
    if (!isRecordRef(ref)) throw new ValidationError(invalidRefMessage(name));
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

export function storedIdListProblem(value, name, { required = false, max = MAX_EVIDENCE_IDS } = {}) {
  if (value === undefined) return required ? `missing ${name}` : null;
  if (!Array.isArray(value)) return `${name} must be a list`;
  if (required && value.length === 0) return `${name} must be a non-empty list`;
  if (value.length > max) return `${name} lists more than ${max} entries`;
  const seen = new Set();
  for (const id of value) {
    if (!isPredictionId(id)) return `${name} has an invalid id`;
    if (seen.has(id)) return `${name} names the same id twice`;
    seen.add(id);
  }
  return null;
}

// A horizon is a bound the ledger can compare recorded outcomes against, so it must be an absolute
// instant, after the prediction, and not so far ahead that "by when" stops meaning anything.
export function horizonProblem(value, createdAtMs) {
  const ms = parseInstant(value);
  if (ms === null) return 'expiresAt is not a recognizable time';
  if (createdAtMs === null) return 'missing createdAt';
  if (ms <= createdAtMs) return 'expiresAt is not after the prediction was recorded';
  if (ms - createdAtMs > MAX_PREDICTION_HORIZON_DAYS * DAY_MS) return `expiresAt is more than ${MAX_PREDICTION_HORIZON_DAYS} days ahead`;
  return null;
}

export function validateTimestamp(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return `${name} has a bad timestamp`;
  return null;
}

export const PROVENANCE_BY_KIND = Object.freeze({
  [PREDICTION_KIND]: { origin: 'user_recorded', updateMode: 'user_confirmed' },
  [INVALIDATION_KIND]: { origin: 'user_retirement', updateMode: 'user_confirmed' },
  [EVALUATION_KIND]: { origin: 'user_authorized_derivation', updateMode: 'user_confirmed' },
});

const PROVENANCE_FIELDS = Object.freeze(['origin', 'updateMode', 'operationId', 'context']);
const OPERATION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function validateProvenanceShape(record, kind) {
  const p = record.provenance;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'missing provenance';
  const expected = PROVENANCE_BY_KIND[kind];
  if (p.origin !== expected.origin) return `provenance origin must be ${expected.origin}`;
  if (p.updateMode !== expected.updateMode) return `provenance updateMode must be ${expected.updateMode}`;
  if (p.operationId !== undefined && (typeof p.operationId !== 'string' || !OPERATION_ID_RE.test(p.operationId))) {
    return 'provenance operationId has an invalid format';
  }
  if (p.context !== undefined) {
    const problem = storedTextProblem(p.context, 'provenance context', MAX_CONTEXT_CHARS);
    if (problem) return problem;
  }
  for (const key of Object.keys(p)) {
    if (!PROVENANCE_FIELDS.includes(key)) return `provenance has an unknown field ${key}`;
  }
  return null;
}

// ---- record validation (used by JsonlStore) ---------------------------------

export function validatePredictionRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if (r.schema !== PREDICTION_SCHEMA) return 'unsupported schema';
  if (r.kind === PREDICTION_KIND) return validatePrediction(r);
  if (r.kind === INVALIDATION_KIND) return validateInvalidation(r);
  if (r.kind === EVALUATION_KIND) return validateEvaluation(r);
  return 'unknown record kind';
}

// A caller-supplied confidence is refused, and a stored one is damage: there is no method in this
// build that could have produced a number, so any number that appears was not derived. `status`,
// `evaluation` and `outcome` are on the list for the same kind of reason: they are derived by the
// reader, so a record that carried one could disagree with the ledger it was read from.
// `confidence` itself is not listed because a prediction stores it as the explicit null that says
// "no value is available"; the store refuses any caller-supplied one before the record is built.
export const FORBIDDEN_PREDICTION_FIELDS = Object.freeze([
  'probability', 'score', 'weight', 'likelihood', 'certainty', 'status', 'evaluation', 'outcome', 'outcomeIds',
]);

function validatePrediction(r) {
  if (!isPredictionId(r.id)) return 'missing or invalid id';
  const created = validateTimestamp(r.createdAt, 'createdAt');
  if (created) return created;
  if (typeof r.capability !== 'string' || r.capability.length === 0 || r.capability.length > 64
    || CONTROL_CHARS.test(r.capability)) return 'capability is not a capability name';
  if (!EXPECTATIONS.includes(r.expectation)) return 'unknown expectation';
  const subject = storedTextProblem(r.subject, 'subject', MAX_SUBJECT_CHARS);
  if (subject) return subject;
  const horizon = horizonProblem(r.expiresAt, parseInstant(r.createdAt));
  if (horizon) return horizon;
  if (!Object.hasOwn(r, 'confidence') || r.confidence !== null) return 'confidence must be present and null';
  for (const field of FORBIDDEN_PREDICTION_FIELDS) {
    if (r[field] !== undefined) return `a prediction must not carry ${field}`;
  }
  if (!r.evidence || typeof r.evidence !== 'object' || Array.isArray(r.evidence)) return 'missing evidence';
  const e = r.evidence;
  for (const key of Object.keys(e)) {
    if (!['supportingExperienceIds', 'contradictingExperienceIds', 'feedbackIds', 'patternKinds'].includes(key)) {
      return `evidence has an unknown field ${key}`;
    }
  }
  for (const key of ['supportingExperienceIds', 'contradictingExperienceIds', 'feedbackIds']) {
    if (!Array.isArray(e[key])) return `evidence ${key} must be a list`;
    const problem = storedIdListProblem(e[key], `evidence ${key}`);
    if (problem) return problem;
  }
  if (!Array.isArray(e.patternKinds)) return 'evidence patternKinds must be a list';
  if (e.patternKinds.length > MAX_PATTERN_KIND_CITES) return `evidence patternKinds lists more than ${MAX_PATTERN_KIND_CITES} entries`;
  if (new Set(e.patternKinds).size !== e.patternKinds.length) return 'evidence names the same pattern kind twice';
  for (const kind of e.patternKinds) {
    if (!PATTERN_KINDS.includes(kind)) return 'evidence names an unknown pattern kind';
  }
  if (r.evidenceBasis !== (citesEvidence(r) ? 'cited' : 'none_cited')) return 'evidenceBasis disagrees with the cited evidence';
  const replaces = storedIdListProblem(r.replaces, 'replaces', { max: MAX_REPLACES });
  if (replaces) return replaces;
  if (Array.isArray(r.replaces) && r.replaces.includes(r.id)) return 'a prediction cannot replace itself';
  if (!Array.isArray(r.limitations)) return 'missing limitations';
  if (JSON.stringify(r.limitations) !== JSON.stringify(deriveLimitations(r))) return 'limitations do not match the record';
  return validateProvenanceShape(r, PREDICTION_KIND);
}

function validateInvalidation(r) {
  if (!isPredictionId(r.id)) return 'invalidation has missing or invalid id';
  if (!isPredictionId(r.predictionId)) return 'invalidation has missing or invalid predictionId';
  // The reason is required: an invalidated expectation must retain why the user withdrew it.
  const reason = storedTextProblem(r.reason, 'reason', MAX_REASON_CHARS);
  if (reason) return reason === 'missing reason' ? 'an invalidation must retain a reason' : `invalidation ${reason}`;
  const created = validateTimestamp(r.createdAt, 'createdAt');
  if (created) return created;
  return validateProvenanceShape(r, INVALIDATION_KIND);
}

function validateEvaluation(r) {
  if (!isPredictionId(r.id)) return 'evaluation has missing or invalid id';
  if (!isPredictionId(r.predictionId)) return 'evaluation has missing or invalid predictionId';
  if (!EVALUATION_VERDICTS.includes(r.verdict)) return 'unknown evaluation verdict';
  const created = validateTimestamp(r.createdAt, 'createdAt');
  if (created) return created;
  const sinceProblem = validateTimestamp(r.window?.since, 'window since');
  if (sinceProblem) return sinceProblem;
  const untilProblem = validateTimestamp(r.window?.until, 'window until');
  if (untilProblem) return untilProblem;
  if (parseInstant(r.window.since) > parseInstant(r.window.until)) return 'the evaluation window is inverted';
  const used = storedIdListProblem(r.outcomeExperienceIds, 'outcomeExperienceIds', { required: true });
  if (used) return used;
  if (!isPredictionId(r.decidingExperienceId)) return 'missing or invalid decidingExperienceId';
  if (!r.outcomeExperienceIds.includes(r.decidingExperienceId)) return 'the deciding record is not among the outcome evidence';
  if (parseInstant(r.decidingOccurredAt) === null) return 'decidingOccurredAt has a bad timestamp';
  for (const field of ['capability', 'expectation', 'subject', 'confidence', 'probability', 'score']) {
    if (r[field] !== undefined) return `an evaluation must not carry ${field}`;
  }
  return validateProvenanceShape(r, EVALUATION_KIND);
}

// ---- ledger derivation ------------------------------------------------------

export function splitPredictionRecords(records = []) {
  const predictions = [];
  const invalidations = [];
  const evaluations = [];
  for (const record of records) {
    if (record.kind === PREDICTION_KIND) predictions.push(record);
    else if (record.kind === INVALIDATION_KIND) invalidations.push(record);
    else if (record.kind === EVALUATION_KIND) evaluations.push(record);
  }
  return { predictions, invalidations, evaluations };
}

// The transitive closure of `replaces`, mirroring the experience store: a correction chain retires
// each of its earlier links, and a hand-edited loop retires every member rather than letting this
// read silently pick a winner. `health()` reports the loop.
export function deriveReplacementState(predictions) {
  const byId = new Map(predictions.map((r) => [r.id, r]));
  const retired = new Set();
  const queue = [];
  for (const record of predictions) {
    for (const id of record.replaces ?? []) {
      if (!retired.has(id)) {
        retired.add(id);
        queue.push(id);
      }
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    for (const id of byId.get(queue[i])?.replaces ?? []) {
      if (!retired.has(id)) {
        retired.add(id);
        queue.push(id);
      }
    }
  }
  const replacedBy = new Map();
  for (const record of predictions) {
    for (const id of record.replaces ?? []) {
      const list = replacedBy.get(id) ?? [];
      list.push(record.id);
      replacedBy.set(id, list);
    }
  }
  return { retired, replacedBy };
}

// The ids that sit on a replacement circle, found by one depth-first walk of the `replaces` edges.
// A hand-edited ledger can name replacements in a ring - A replaces B while B replaces A - and every
// member of that ring is then retired by it, so no standing expectation ends the chain and an
// ordinary retirement count cannot tell a ring from a correction. The write path cannot make one
// (replacing an already-retired prediction is refused), so a ring means the file was edited. A
// reader is told it is on a circle rather than being shown a successor that does not exist, and
// `health()` names every member instead of letting a count pick a winner.
export function replacementCircleIds(predictions) {
  const edges = new Map(predictions.map((record) => [record.id, record.replaces ?? []]));
  const walking = 1;
  const done = 2;
  const color = new Map();
  const circle = new Set();
  for (const root of edges.keys()) {
    if (color.get(root)) continue;
    color.set(root, walking);
    const path = [{ id: root, next: 0 }];
    while (path.length > 0) {
      const frame = path[path.length - 1];
      const targets = edges.get(frame.id);
      if (frame.next >= targets.length) {
        color.set(frame.id, done);
        path.pop();
        continue;
      }
      const target = targets[frame.next];
      frame.next += 1;
      const state = color.get(target);
      if (state === walking) {
        const start = path.findIndex((item) => item.id === target);
        for (let i = start < 0 ? path.length - 1 : start; i < path.length; i += 1) circle.add(path[i].id);
      } else if (state === undefined && edges.has(target)) {
        // An edge to a record that is not in the log cannot close a circle; it is named as a
        // dangling replacement reference instead (see the health read).
        color.set(target, walking);
        path.push({ id: target, next: 0 });
      }
    }
  }
  return [...circle];
}

function boundedIds(ids, max = MAX_EVIDENCE_SHOWN) {
  const shown = ids.slice(0, max);
  return { ids: shown, count: ids.length, truncated: ids.length > shown.length };
}

// An experience event reduced to what a prediction read uses. The engine never reads the experience
// log itself: whatever the caller shows it is what it reports.
function evidenceEvent(event) {
  return {
    id: event.id,
    capability: event.capability ?? null,
    outcome: event.outcome ?? null,
    outcomeClass: event.outcomeClass ?? outcomeClass(event.outcome),
    occurredAt: event.occurredAt ?? null,
    occurredMs: parseInstant(event.occurredAt),
    undated: event.undated === true || parseInstant(event.occurredAt) === null,
    active: event.active !== false,
    superseded: event.superseded === true,
    logPosition: event.logPosition ?? null,
  };
}

// Code-point order, not locale order: the same records must sort the same way on every machine.
function compareByOccurrence(a, b) {
  if (a.undated !== b.undated) return a.undated ? 1 : -1;
  if (!a.undated && a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  if ((a.logPosition ?? 0) !== (b.logPosition ?? 0)) return (a.logPosition ?? 0) - (b.logPosition ?? 0);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const EVALUATION_RULE = 'the latest live experience dated inside the horizon establishes the outcome; only a success, failure, or blocked outcome establishes anything';

function unavailableEvidence(reason) {
  return { available: false, reason };
}

// One expectation judged against the records that can settle it.
//
// `evidence` is the caller's read of the experience log for exactly this prediction's capability and
// horizon. A missing read (no experience store configured, or an unreadable log) is reported as
// `evidence_unavailable`, which is a different statement from "nothing establishes it": one is about
// the store, the other about the world.
export function deriveEvaluation({ prediction, evidence, invalidation, evaluation, supersededBy = [], nowMs }) {
  const sinceMs = parseInstant(prediction.createdAt);
  const untilMs = parseInstant(prediction.expiresAt);
  const window = {
    since: prediction.createdAt,
    until: prediction.expiresAt,
    sinceMs,
    untilMs,
    elapsed: nowMs !== null && untilMs !== null && nowMs > untilMs,
  };
  const base = {
    predictionId: prediction.id,
    capability: prediction.capability,
    expectation: prediction.expectation,
    window,
    rule: EVALUATION_RULE,
    supersededBy,
    evaluation: evaluation ? {
      id: evaluation.id,
      verdict: evaluation.verdict,
      createdAt: evaluation.createdAt,
      decidingExperienceId: evaluation.decidingExperienceId,
      outcomeExperienceIds: [...evaluation.outcomeExperienceIds],
      window: { since: evaluation.window.since, until: evaluation.window.until },
    } : null,
  };
  if (invalidation) {
    return { ...base, decision: 'invalidated', canRecord: false, reason: 'the user withdrew this expectation, so it is not scored' };
  }
  if (supersededBy.length > 0) {
    return { ...base, decision: 'superseded', canRecord: false, reason: 'the user replaced this expectation with a later one, so scoring it would judge a statement no longer held' };
  }
  if (evaluation) {
    // The recorded evaluation is not rewritten. A fresh read is compared against it and any
    // difference is disclosed - but only when the experience log could actually be read, since an
    // unreadable log says nothing about whether the verdict still holds.
    const readable = Boolean(evidence) && evidence.available !== false;
    const settled = readable ? judge({ prediction, evidence, window, nowMs }) : null;
    const differs = settled !== null && settled.decision !== evaluation.verdict;
    return {
      ...base,
      decision: 'already_evaluated',
      verdict: evaluation.verdict,
      canRecord: false,
      reason: 'this prediction already has a recorded evaluation; a second one would duplicate it',
      evaluationStale: differs,
      staleReason: differs
        ? `a read now would report ${settled.decision} rather than ${evaluation.verdict}; the recorded evaluation stands and the difference is disclosed, never rewritten`
        : null,
      current: settled?.current ?? null,
      exclusions: settled?.exclusions ?? null,
    };
  }
  if (!evidence || evidence.available === false) {
    return {
      ...base,
      decision: 'evidence_unavailable',
      canRecord: false,
      reason: evidence?.reason ?? 'no experience log is available, so no outcome can be established',
    };
  }
  return { ...base, ...judge({ prediction, evidence, window, nowMs }) };
}

function judge({ prediction, evidence, window, nowMs }) {
  const all = (evidence.events ?? []).map(evidenceEvent);
  const inHorizon = all.filter((event) => !event.undated
    && event.occurredMs >= window.sinceMs && event.occurredMs <= window.untilMs)
    .sort(compareByOccurrence);
  const live = inHorizon.filter((event) => event.active);
  const establishing = live.filter((event) => ESTABLISHING_CLASSES.has(event.outcomeClass));
  const counts = {
    read: all.length,
    inHorizon: inHorizon.length,
    live: live.length,
    establishing: establishing.length,
    unclassified: live.length - establishing.length,
    superseded: inHorizon.length - live.length,
    undated: evidence.counts?.undated ?? 0,
    storedExperiences: evidence.counts?.storedExperiences ?? null,
  };
  const exclusions = [
    { key: 'superseded', count: counts.superseded, reason: 'a later experience record replaced it, so it is not current evidence' },
    { key: 'unclassified_outcome', count: counts.unclassified, reason: 'its outcome establishes neither success, failure, nor a block' },
    { key: 'undated', count: counts.undated, reason: 'an experience with no time can never fall inside a horizon' },
  ];
  const current = {
    counts,
    supporting: boundedIds(establishing.filter((event) => event.outcomeClass === prediction.expectation).map((event) => event.id)),
    contradicting: boundedIds(establishing.filter((event) => event.outcomeClass !== prediction.expectation).map((event) => event.id)),
    truncated: evidence.truncated === true,
  };

  if (establishing.length === 0) {
    if (live.length > 0) {
      return {
        decision: 'insufficient_evidence', canRecord: false, current, exclusions,
        reason: `${live.length} live experience(s) fall inside the horizon but none carries an outcome that establishes anything, so no verdict is available`,
      };
    }
    if (window.elapsed) {
      return {
        decision: 'expired', canRecord: false, current, exclusions,
        reason: `its horizon passed on ${window.until} with no recorded outcome to judge it against; this is expiry, not a wrong prediction`,
      };
    }
    return {
      decision: 'outcome_unavailable', canRecord: false, current, exclusions,
      reason: nowMs !== null && nowMs < window.sinceMs
        ? 'its horizon has not started yet'
        : 'no live experience inside the horizon has a classifiable outcome yet, so nothing establishes it either way',
    };
  }
  const deciding = establishing.at(-1);
  const verdict = deciding.outcomeClass === prediction.expectation ? 'matched' : 'contradicted';
  return {
    decision: verdict,
    canRecord: true,
    current,
    exclusions,
    deciding: {
      id: deciding.id,
      occurredAt: deciding.occurredAt,
      outcome: deciding.outcome,
      outcomeClass: deciding.outcomeClass,
    },
    outcomeExperienceIds: establishing.map((event) => event.id),
    reason: verdict === 'matched'
      ? `the latest live experience inside the horizon (${shortId(deciding.id)}) ended in a ${deciding.outcomeClass} outcome, which is what was expected`
      : `the latest live experience inside the horizon (${shortId(deciding.id)}) ended ${deciding.outcomeClass}, which is not what was expected`,
  };
}

// The state a reader reports, from the records that exist - never from a field that stores one.
export function resolveStatus({ window, evaluation, invalidation, supersededBy, retired = false, inReplacementCircle = false, decision }) {
  if (invalidation) return { status: 'invalidated', reason: 'the user withdrew it, and the reason stays with the record' };
  if (supersededBy.length > 0 || retired || inReplacementCircle) {
    return {
      status: 'superseded',
      reason: inReplacementCircle
        ? 'a replacement loop retires every member of it; see the ledger health read'
        : `a later prediction replaced it${evaluation ? `, and its recorded ${evaluation.verdict} verdict stays with it` : ''}; this one stays in the log and stays auditable`,
    };
  }
  if (evaluation) return { status: 'evaluated', reason: `a recorded evaluation judged it ${evaluation.verdict}` };
  if (decision === 'matched' || decision === 'contradicted') {
    return { status: 'awaiting_evaluation', reason: 'outcome evidence exists inside the horizon, but no evaluation has been recorded yet' };
  }
  if (decision === 'evidence_unavailable') {
    return { status: 'recorded', reason: 'the experience log could not be read, so no state beyond recorded can be established' };
  }
  if (window.elapsed) {
    return { status: 'expired', reason: `its horizon passed on ${window.until} without outcome evidence; expiry is not a wrong prediction` };
  }
  return { status: 'recorded', reason: 'inside its horizon, with nothing yet establishing its outcome' };
}

// The evidence lineage of one prediction: what was cited when it was made, what has been recorded
// since, and what the outcome was judged against. The three are never merged, and a record dated
// after the prediction can only ever reach the second group.
export function deriveLineage({ prediction, evidence, evaluation }) {
  const at = citedAtCreation(prediction, evidence);
  if (!evidence || evidence.available === false) {
    return {
      available: false,
      reason: evidence?.reason ?? 'no experience log is available',
      basis: prediction.evidenceBasis,
      atCreation: at,
    };
  }
  const createdMs = parseInstant(prediction.createdAt);
  const expiresMs = parseInstant(prediction.expiresAt);
  const citedIds = new Set([
    ...(prediction.evidence.supportingExperienceIds ?? []),
    ...(prediction.evidence.contradictingExperienceIds ?? []),
  ]);
  const later = (evidence.events ?? []).map(evidenceEvent)
    .filter((event) => !citedIds.has(event.id)
      && !event.undated && event.occurredMs > createdMs && event.occurredMs <= expiresMs)
    .sort(compareByOccurrence);
  const supporting = [];
  const contradicting = [];
  const excluded = [];
  for (const event of later) {
    if (!event.active) excluded.push({ id: event.id, reason: 'superseded by a later experience record' });
    else if (!ESTABLISHING_CLASSES.has(event.outcomeClass)) excluded.push({ id: event.id, reason: 'its outcome establishes neither success, failure, nor a block' });
    else if (event.outcomeClass === prediction.expectation) supporting.push(event);
    else contradicting.push(event);
  }
  const detected = new Set(evidence.patternKinds ?? []);
  const establishing = (evidence.events ?? []).map(evidenceEvent)
    .filter((event) => !event.undated && event.active
      && event.occurredMs >= createdMs && event.occurredMs <= expiresMs
      && ESTABLISHING_CLASSES.has(event.outcomeClass))
    .sort(compareByOccurrence)
    .map((event) => event.id);
  return {
    available: true,
    basis: prediction.evidenceBasis,
    atCreation: at,
    addedAfter: {
      supporting: boundedIds(supporting.map((event) => event.id)),
      contradicting: boundedIds(contradicting.map((event) => event.id)),
      excluded: boundedIds(excluded.map((event) => event.id)),
      excludedReasons: [...new Set(excluded.map((event) => event.reason))],
      window: { since: prediction.createdAt, until: prediction.expiresAt },
      note: 'derived at read time from records dated after the prediction; never stored as original support',
    },
    patternKindsNowDetected: (prediction.evidence.patternKinds ?? []).filter((kind) => detected.has(kind)),
    patternKindsNoLongerDetected: (prediction.evidence.patternKinds ?? []).filter((kind) => !detected.has(kind)),
    outcomeEvidence: evaluation ? {
      source: 'recorded evaluation',
      ids: boundedIds(evaluation.outcomeExperienceIds),
      deciding: evaluation.decidingExperienceId,
      window: { since: evaluation.window.since, until: evaluation.window.until },
    } : {
      source: 'derived at read time',
      ids: boundedIds(establishing),
      deciding: null,
      window: { since: prediction.createdAt, until: prediction.expiresAt },
    },
    horizon: { since: prediction.createdAt, until: prediction.expiresAt },
  };
}

function citedAtCreation(prediction, evidence) {
  const logReadable = Boolean(evidence) && evidence.available !== false;
  const byId = new Map((evidence?.experiences ?? []).map((record) => [record.id, record]));
  const feedbackById = new Map((evidence?.feedback ?? []).map((record) => [record.id, record]));
  const unresolvable = logReadable
    ? 'the cited record is not in the experience log'
    : 'the experience log could not be read, so this citation is unverified';
  const shape = (ids, role) => (ids ?? []).map((id) => {
    const record = byId.get(id);
    if (!record) return { id, available: false, role, reason: unresolvable };
    const agrees = record.outcomeClass === prediction.expectation;
    const classifiable = ESTABLISHING_CLASSES.has(record.outcomeClass);
    return {
      id,
      available: true,
      role,
      capability: record.capability,
      outcome: record.outcome,
      outcomeClass: record.outcomeClass,
      occurredAt: record.occurredAt,
      createdAt: record.createdAt,
      superseded: record.superseded === true,
      unverified: OUTCOME_VALUES.has(record.outcome) ? null : 'its outcome is not a recorded outcome value',
      roleDisagreement: classifiable && (agrees !== (role === 'supporting'))
        ? `its recorded outcome is ${record.outcomeClass}, which reads against the role it was cited in`
        : null,
    };
  });
  const supporting = shape(prediction.evidence?.supportingExperienceIds, 'supporting');
  const contradicting = shape(prediction.evidence?.contradictingExperienceIds, 'contradicting');
  const feedback = shape2(prediction.evidence?.feedbackIds, feedbackById, unresolvable);
  const unresolved = [...supporting, ...contradicting].filter((item) => item.available === false).map((item) => item.id);
  const unresolvedFeedback = feedback.filter((item) => item.available === false).map((item) => item.id);
  return {
    // A citation whose record cannot be resolved is marked unavailable and kept in the count; it is
    // never quietly dropped, and never treated as evidence that the event did not happen.
    unavailableDeclared: logReadable === false,
    supporting: wrapCited(supporting),
    contradicting: wrapCited(contradicting),
    feedback: wrapCited(feedback),
    patternKinds: [...(prediction.evidence?.patternKinds ?? [])],
    unresolvedExperienceIds: [...new Set(unresolved)].sort(),
    unresolvedFeedbackIds: [...new Set(unresolvedFeedback)].sort(),
    roleDisagreements: [...supporting, ...contradicting].filter((item) => item.roleDisagreement).map((item) => item.id),
    note: 'cited when the prediction was made and validated then; these records never gain or lose a role later',
  };
}

function shape2(ids, byId, unresolvable) {
  return (ids ?? []).map((id) => {
    const record = byId.get(id);
    if (!record) return { id, available: false, reason: unresolvable };
    return {
      id,
      available: true,
      assessment: record.assessment,
      createdAt: record.createdAt,
      experienceSuperseded: record.experienceSuperseded === true,
    };
  });
}

function wrapCited(items) {
  return { count: items.length, truncated: items.length > MAX_EVIDENCE_SHOWN, shown: items.slice(0, MAX_EVIDENCE_SHOWN) };
}

// One stored prediction, fully projected. `evidenceFor(record)` is a synchronous lookup the caller
// has already filled by reading the experience log; the engine performs no I/O.
export function projectPrediction(record, { ledger, evidenceFor, nowMs }) {
  // The ledger carries first-match indexes over the same records these scans walked, so one projection
  // of the whole log costs the log, not the log squared. The scan is kept for a caller that hands in a
  // hand-built ledger without them; both routes take the earliest record that names the prediction.
  const invalidation = (ledger.invalidationsBy?.get(record.id)
    ?? ledger.invalidations.find((item) => item.predictionId === record.id)) ?? null;
  const evaluation = (ledger.evaluationsBy?.get(record.id)
    ?? ledger.evaluations.find((item) => item.predictionId === record.id)) ?? null;
  const supersededBy = (ledger.replacedBy.get(record.id) ?? [])
    .map((id) => ledger.predictionsById.get(id))
    .filter((item) => item !== undefined)
    .map((item) => item.id);
  const evidence = evidenceFor ? evidenceFor(record) : unavailableEvidence('no experience read was supplied for this prediction');
  const derived = deriveEvaluation({ prediction: record, evidence, invalidation, evaluation, supersededBy, nowMs });
  const lineage = deriveLineage({ prediction: record, evidence, evaluation });
  const retired = ledger.retiredByReplacement.has(record.id);
  const status = resolveStatus({
    window: derived.window,
    evaluation,
    invalidation,
    supersededBy,
    retired,
    inReplacementCircle: ledger.replacementCircles.has(record.id),
    decision: derived.decision,
  });
  return {
    schema: PREDICTION_SCHEMA,
    id: record.id,
    createdAt: record.createdAt,
    capability: record.capability,
    expectation: record.expectation,
    subject: record.subject,
    expiresAt: record.expiresAt,
    confidence: null,
    confidenceReason: CONFIDENCE_UNAVAILABLE_REASON,
    evidenceBasis: record.evidenceBasis,
    evidence: record.evidence,
    limitations: record.limitations,
    replaces: [...(record.replaces ?? [])],
    supersededBy,
    provenance: { ...record.provenance },
    retired,
    status: status.status,
    statusReason: status.reason,
    evaluation: derived.evaluation,
    invalidation: invalidation ? {
      id: invalidation.id,
      reason: invalidation.reason,
      createdAt: invalidation.createdAt,
      provenance: { ...invalidation.provenance },
    } : null,
    evaluationDecision: derived.decision,
    evaluationReason: derived.reason,
    evaluationRule: derived.rule,
    canRecordEvaluation: derived.canRecord === true,
    evaluationStale: derived.evaluationStale === true,
    staleReason: derived.staleReason ?? null,
    deciding: derived.deciding ?? null,
    counts: derived.current?.counts ?? null,
    exclusions: derived.exclusions ?? null,
    supportingEstablishing: derived.current?.supporting ?? null,
    contradictingEstablishing: derived.current?.contradicting ?? null,
    evidenceTruncated: derived.current?.truncated === true,
    lineage,
  };
}

// The earliest record of a kind that names each prediction, which is what a scan with `.find` over the
// same list returns. Built once per projection so a whole-ledger read costs the log rather than the log
// multiplied by itself.
function firstByPrediction(list) {
  const map = new Map();
  for (const item of list) {
    if (item?.predictionId === undefined || item.predictionId === null) continue;
    if (!map.has(item.predictionId)) map.set(item.predictionId, item);
  }
  return map;
}

// The whole ledger, in horizon order (oldest prediction first). `evidenceFor` is the caller's per
// prediction read of the experience log.
export function projectLedger({ records, nowMs, evidenceFor }) {
  const { predictions, invalidations, evaluations } = splitPredictionRecords(records);
  const { retired, replacedBy } = deriveReplacementState(predictions);
  const ordered = [...predictions].sort((a, b) => {
    const at = parseInstant(a.createdAt);
    const bt = parseInstant(b.createdAt);
    if (at !== bt && at !== null && bt !== null) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const seed = {
    predictions,
    invalidations,
    evaluations,
    invalidationsBy: firstByPrediction(invalidations),
    evaluationsBy: firstByPrediction(evaluations),
    retiredByReplacement: retired,
    replacedBy,
    replacementCircles: new Set(replacementCircleIds(predictions)),
    predictionsById: new Map(predictions.map((record) => [record.id, record])),
  };
  const projections = ordered.map((record) => projectPrediction(record, { ledger: seed, evidenceFor, nowMs }));
  const ledger = {
    ...seed,
    projections,
    byId: new Map(projections.map((item) => [item.id, item])),
    derivedAt: nowMs === null ? null : new Date(nowMs).toISOString(),
  };
  return ledger;
}

// ---- calibration ------------------------------------------------------------

// Counts of recorded evaluations, with the denominator of every rate named beside it and every
// exclusion listed. A prediction that was never evaluated, expired, or was withdrawn changes the
// counts, never a rate: only matched and contradicted enter a denominator.
export function deriveCalibration({ ledger }) {
  const live = ledger.projections.filter((item) => !item.retired);
  const statuses = Object.fromEntries(PREDICTION_STATUSES.map((status) => [status, 0]));
  for (const item of ledger.projections) statuses[item.status] += 1;

  const scored = live.filter((item) => item.invalidation === null && item.evaluation !== null);
  const matched = scored.filter((item) => item.evaluation.verdict === 'matched');
  const contradicted = scored.filter((item) => item.evaluation.verdict === 'contradicted');
  const withdrawn = live.filter((item) => item.invalidation !== null);
  const unevaluated = live.filter((item) => item.invalidation === null && item.evaluation === null);
  const denominator = matched.length + contradicted.length;
  const groups = [];
  for (const capability of [...new Set(live.map((item) => item.capability))].sort()) {
    const items = live.filter((item) => item.capability === capability);
    const m = items.filter((item) => item.invalidation === null && item.evaluation?.verdict === 'matched').length;
    const c = items.filter((item) => item.invalidation === null && item.evaluation?.verdict === 'contradicted').length;
    const d = m + c;
    groups.push({
      capability,
      predictions: items.length,
      matched: m,
      contradicted: c,
      denominator: d,
      rate: d >= MIN_CALIBRATION_EVALUATIONS ? roundRate(m, d) : null,
      rateWithheldReason: d === 0
        ? 'no evaluation exists for this capability'
        : d < MIN_CALIBRATION_EVALUATIONS ? `only ${d} evaluation(s), below the ${MIN_CALIBRATION_EVALUATIONS} needed to state a rate` : null,
      awaitingEvaluation: items.filter((item) => item.status === 'awaiting_evaluation').length,
      expired: items.filter((item) => item.status === 'expired').length,
      invalidated: items.filter((item) => item.invalidation !== null).length,
      staleEvaluations: items.filter((item) => item.evaluationStale).length,
    });
  }
  return {
    derivedAt: ledger.derivedAt,
    totals: {
      stored: ledger.projections.length,
      live: live.length,
      superseded: ledger.projections.length - live.length,
      byStatus: statuses,
      matched: matched.length,
      contradicted: contradicted.length,
      evaluated: scored.length,
      unevaluated: unevaluated.length,
      expired: statuses.expired,
      awaitingEvaluation: statuses.awaiting_evaluation,
      invalidated: withdrawn.length,
      staleEvaluations: live.filter((item) => item.evaluationStale).length,
      evidenceUnavailable: live.filter((item) => item.evaluationDecision === 'evidence_unavailable').length,
    },
    matchRate: denominator === 0
      ? { value: null, numerator: 0, denominator: 0, reason: 'no prediction has been evaluated yet' }
      : denominator < MIN_CALIBRATION_EVALUATIONS
        ? { value: null, numerator: matched.length, denominator, reason: `${denominator} evaluation(s) is below ${MIN_CALIBRATION_EVALUATIONS}; a ratio from so few records is not a rate worth stating` }
        : { value: roundRate(matched.length, denominator), numerator: matched.length, denominator, reason: null },
    rateDenominator: 'recorded evaluations whose prediction the user has not withdrawn (matched + contradicted)',
    rateExclusions: [
      { key: 'expired', count: statuses.expired, reason: 'nothing established their outcome; expiry is not a wrong prediction' },
      { key: 'awaiting_evaluation', count: statuses.awaiting_evaluation, reason: 'outcome evidence exists but no evaluation was recorded' },
      { key: 'recorded', count: statuses.recorded, reason: 'still inside the horizon with nothing establishing it' },
      { key: 'invalidated', count: withdrawn.length, reason: 'the user withdrew the expectation, so it is not scored' },
      { key: 'superseded', count: ledger.projections.length - live.length, reason: 'replaced by a later prediction' },
      { key: 'insufficient_evidence', count: count(live, 'insufficient_evidence'), reason: 'every experience inside the horizon carries an outcome that establishes nothing' },
      { key: 'outcome_unavailable', count: count(live, 'outcome_unavailable'), reason: 'nothing inside the horizon has established an outcome yet' },
      { key: 'evidence_unavailable', count: count(live, 'evidence_unavailable'), reason: 'the experience log could not be read' },
    ],
    confidence: {
      available: false,
      predictionsWithConfidence: 0,
      calibrationApplied: false,
      reason: 'no prediction carries a confidence value in this build, so nothing can be calibrated against one',
    },
    reliability: denominator === 0
      ? 'no_evaluations'
      : denominator < MIN_CALIBRATION_EVALUATIONS ? 'insufficient_sample' : 'counts_only',
    byCapability: groups.slice(0, MAX_CALIBRATION_CAPABILITIES),
    capabilitiesTruncated: groups.length > MAX_CALIBRATION_CAPABILITIES,
    limitations: [...PREDICTION_LIMITS],
  };
}

function count(items, decision) {
  return items.filter((item) => item.evaluationDecision === decision).length;
}

function roundRate(numerator, denominator) {
  return Math.round((numerator / denominator) * 1000) / 1000;
}

// ---- audit and prompt shapes -------------------------------------------------

// The minimized projection a write action's independent verifier compares: ids, enums, counts and
// timestamps only. Subject and reason are user words and stay out of the audit record, exactly as
// they do for experiences, feedback, and adaptations.
export function predictionAuditShape(ledger) {
  return {
    derivedAt: ledger.derivedAt,
    records: {
      predictions: ledger.predictions.length,
      invalidations: ledger.invalidations.length,
      evaluations: ledger.evaluations.length,
    },
    predictions: ledger.projections.map((item) => ({
      id: item.id,
      createdAt: item.createdAt,
      capability: item.capability,
      expectation: item.expectation,
      expiresAt: item.expiresAt,
      confidence: item.confidence,
      evidenceBasis: item.evidenceBasis,
      evidence: {
        supportingExperienceIds: [...(item.evidence.supportingExperienceIds ?? [])].sort(),
        contradictingExperienceIds: [...(item.evidence.contradictingExperienceIds ?? [])].sort(),
        feedbackIds: [...(item.evidence.feedbackIds ?? [])].sort(),
        patternKinds: [...(item.evidence.patternKinds ?? [])].sort(),
      },
      limitations: [...item.limitations],
      replaces: [...item.replaces].sort(),
      supersededBy: [...item.supersededBy].sort(),
      retired: item.retired,
      status: item.status,
      evaluationDecision: item.evaluationDecision,
      canRecordEvaluation: item.canRecordEvaluation,
      evaluationStale: item.evaluationStale,
      evidenceTruncated: item.evidenceTruncated,
      invalidation: item.invalidation ? { id: item.invalidation.id, createdAt: item.invalidation.createdAt } : null,
      evaluation: item.evaluation ? {
        id: item.evaluation.id,
        verdict: item.evaluation.verdict,
        createdAt: item.evaluation.createdAt,
        decidingExperienceId: item.evaluation.decidingExperienceId,
        outcomeExperienceIds: [...item.evaluation.outcomeExperienceIds].sort(),
        window: { since: item.evaluation.window.since, until: item.evaluation.window.until },
      } : null,
      deciding: item.deciding ? { id: item.deciding.id, outcomeClass: item.deciding.outcomeClass } : null,
      counts: item.counts,
      lineage: item.lineage.available === false
        ? { available: false, basis: item.lineage.basis, atCreation: citedAudit(item.lineage.atCreation) }
        : {
          available: true,
          basis: item.lineage.basis,
          atCreation: citedAudit(item.lineage.atCreation),
          addedAfter: {
            supporting: item.lineage.addedAfter.supporting.count,
            contradicting: item.lineage.addedAfter.contradicting.count,
            excluded: item.lineage.addedAfter.excluded.count,
            supportingIds: [...item.lineage.addedAfter.supporting.ids].sort(),
            contradictingIds: [...item.lineage.addedAfter.contradicting.ids].sort(),
          },
          patternKindsNowDetected: [...item.lineage.patternKindsNowDetected].sort(),
          outcomeEvidence: {
            source: item.lineage.outcomeEvidence.source,
            ids: [...item.lineage.outcomeEvidence.ids.ids].sort(),
            count: item.lineage.outcomeEvidence.ids.count,
            truncated: item.lineage.outcomeEvidence.ids.truncated,
            deciding: item.lineage.outcomeEvidence.deciding,
            window: { since: item.lineage.outcomeEvidence.window.since, until: item.lineage.outcomeEvidence.window.until },
          },
        },
    })),
  };
}

function citedAudit(at) {
  return {
    supporting: at.supporting.count,
    contradicting: at.contradicting.count,
    feedback: at.feedback.count,
    patternKinds: [...at.patternKinds].sort(),
    unresolved: [...at.unresolvedExperienceIds].sort(),
    unresolvedFeedback: [...at.unresolvedFeedbackIds].sort(),
    roleDisagreements: [...at.roleDisagreements].sort(),
    unavailableDeclared: at.unavailableDeclared,
  };
}

export function calibrationAuditShape(calibration) {
  return {
    derivedAt: calibration.derivedAt,
    totals: calibration.totals,
    matchRate: calibration.matchRate,
    rateDenominator: calibration.rateDenominator,
    reliability: calibration.reliability,
    confidence: calibration.confidence,
    capabilities: calibration.byCapability.map((item) => ({
      capability: item.capability,
      predictions: item.predictions,
      matched: item.matched,
      contradicted: item.contradicted,
      denominator: item.denominator,
      rate: item.rate,
      awaitingEvaluation: item.awaitingEvaluation,
      expired: item.expired,
      invalidated: item.invalidated,
      staleEvaluations: item.staleEvaluations,
    })),
    capabilitiesTruncated: calibration.capabilitiesTruncated,
  };
}

export function summarizePredictions({ calibration, projections, limit = 5 }) {
  const size = Math.max(1, Math.min(limit, 10));
  const pending = projections.filter((item) => !item.retired
    && (item.status === 'recorded' || item.status === 'awaiting_evaluation' || item.status === 'expired'));
  const t = calibration.totals;
  return {
    schema: PREDICTION_SCHEMA,
    generatedAt: calibration.derivedAt,
    counts: {
      live: t.live,
      recorded: t.byStatus.recorded,
      awaiting_evaluation: t.byStatus.awaiting_evaluation,
      expired: t.byStatus.expired,
      evaluated: t.evaluated,
      matched: t.matched,
      contradicted: t.contradicted,
      invalidated: t.invalidated,
      superseded: t.superseded,
      unevaluated: t.unevaluated,
    },
    matchRate: calibration.matchRate,
    reliability: calibration.reliability,
    confidenceAvailable: false,
    predictions: pending.slice(0, size).map((item) => ({
      id: item.id,
      capability: item.capability,
      expectation: item.expectation,
      status: item.status,
      expiresAt: item.expiresAt,
      evidenceBasis: item.evidenceBasis,
      confidence: null,
    })),
    truncated: pending.length > size,
    pendingCount: pending.length,
    limitations: [...PREDICTION_LIMITS],
  };
}

// The bounded form the world-state projection and the model context receive: counts, a handful of
// expectations, and the statements that keep them from being read as history. No subject text.
export function predictionPromptShape({ calibration, projections, limit = MAX_PREDICTION_PROMPT_ITEMS } = {}) {
  const summary = summarizePredictions({ calibration, projections, limit });
  const pending = projections.filter((item) => !item.retired && item.invalidation === null
    && (item.status === 'recorded' || item.status === 'awaiting_evaluation' || item.status === 'expired'));
  return {
    schema: PREDICTION_SCHEMA,
    generatedAt: calibration.derivedAt,
    counts: summary.counts,
    matchRate: calibration.matchRate,
    reliability: calibration.reliability,
    confidenceAvailable: false,
    active: pending.slice(0, limit).map((item) => ({
      id: item.id,
      capability: item.capability,
      expectation: item.expectation,
      status: item.status,
      expiresAt: item.expiresAt,
      evidenceBasis: item.evidenceBasis,
    })),
    omitted: Math.max(0, pending.length - Math.min(pending.length, limit)),
    evaluated: projections.filter((item) => item.evaluation !== null && !item.retired).length,
    awaitingEvaluation: summary.counts.awaiting_evaluation,
    expired: summary.counts.expired,
    lackingOutcomeEvidence: pending.filter((item) => item.evaluationDecision === 'outcome_unavailable'
      || item.evaluationDecision === 'insufficient_evidence' || item.evaluationDecision === 'expired').length,
    limitations: [...PREDICTION_LIMITS],
  };
}

// ---- rendering --------------------------------------------------------------

function line(text) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), MAX_PREDICTION_LINE_CHARS);
}

export function renderPredictionList(projections, { query = null, total = projections.length, truncated = false } = {}) {
  const lines = [`Predictions: ${projections.length} shown of ${total} recorded expectation(s)`];
  if (query?.capability) lines.push(`  Filter:       capability ${query.capability}`);
  if (query?.status) lines.push(`  Filter:       status ${query.status}`);
  if (truncated) lines.push('  Bound:        older expectations are left out of this view; raise --limit to include them');
  if (projections.length === 0) {
    lines.push('  Note:         no prediction record matches this filter. An empty ledger is not a lost one.');
    lines.push('  Limits:       APEX makes no predictions: an expectation is stored only when the user records one.');
    return lines.join('\n');
  }
  for (const item of projections) {
    // `singleLine`, not `truncate`: a subject is user text, and a stored newline must not turn one
    // expectation into two listing lines (or let a subject pose as another record's line).
    lines.push(`- [${shortId(item.id)}] ${item.capability}: expects ${item.expectation}${item.subject ? ` - ${singleLine(item.subject, 90)}` : ''}`);
    lines.push(`    ${item.status}; horizon ${item.createdAt}..${item.expiresAt}; evidence ${item.evidenceBasis}; confidence unavailable${item.evaluation ? `; verdict ${item.evaluation.verdict}` : ''}`);
    lines.push(`    ${line(item.statusReason)}`);
  }
  lines.push('  Limits:       an expectation is not an observation, and none of these authorizes an action or an adaptation.');
  return lines.join('\n');
}

export function renderPredictionDetail(item) {
  const lines = [
    `Prediction [${shortId(item.id)}]`,
    `  Capability:     ${item.capability}`,
    `  Expectation:    ${item.expectation}`,
    `  Subject:        ${singleLine(item.subject, MAX_SUBJECT_CHARS)}`,
    `  Recorded:       ${item.createdAt}`,
    `  Horizon ends:   ${item.expiresAt}`,
    `  Status:         ${item.status} (${line(item.statusReason)})`,
    `  Confidence:     unavailable - ${item.confidenceReason}`,
    `  Evidence basis: ${item.evidenceBasis}`,
  ];
  const at = item.lineage.atCreation;
  lines.push(`  Cited at creation: ${at.supporting.count} supporting, ${at.contradicting.count} contradicting, ${at.feedback.count} feedback, ${at.patternKinds.length} pattern(s)`);
  if (at.unresolvedExperienceIds.length + at.unresolvedFeedbackIds.length > 0) {
    lines.push(`  Unavailable:    ${at.unresolvedExperienceIds.length + at.unresolvedFeedbackIds.length} cited record(s) could not be resolved; marked unavailable, never read as absent evidence`);
  }
  if (at.roleDisagreements.length > 0) {
    lines.push(`  Role check:     ${at.roleDisagreements.length} cited record(s) read against the role they were cited in; the citation stands and the difference is disclosed`);
  }
  if (item.lineage.available === false) {
    lines.push(`  Evidence read:  unavailable - ${line(item.lineage.reason)}`);
  } else {
    const added = item.lineage.addedAfter;
    lines.push(`  Added after:    ${added.supporting.count} supporting, ${added.contradicting.count} contradicting, ${added.excluded.count} excluded (derived now, never stored as original support)`);
    if (item.lineage.patternKindsNowDetected.length || item.lineage.patternKindsNoLongerDetected.length) {
      lines.push(`  Patterns:       ${item.lineage.patternKindsNowDetected.length} cited kind(s) still detected in the horizon, ${item.lineage.patternKindsNoLongerDetected.length} no longer detected`);
    }
  }
  if (item.counts) {
    lines.push(`  In horizon:     ${item.counts.live} live record(s), ${item.counts.establishing} establishing, ${item.counts.unclassified} unclassified, ${item.counts.superseded} superseded`);
  }
  if (item.evidenceTruncated) {
    lines.push('  Bound:          the horizon read is bounded, so older records are counted but not listed');
  }
  if (item.evaluation) {
    lines.push(`  Evaluation:     ${item.evaluation.verdict} as [${shortId(item.evaluation.id)}] at ${item.evaluation.createdAt}`);
    lines.push(`    decided by experience [${shortId(item.evaluation.decidingExperienceId)}] over ${item.evaluation.outcomeExperienceIds.length} outcome record(s)`);
    if (item.evaluationStale) lines.push(`    Stale:        ${line(item.staleReason)}`);
  } else {
    lines.push(`  Evaluation:     none recorded; a read now reports ${item.evaluationDecision} (${line(item.evaluationReason)})`);
  }
  if (item.invalidation) {
    lines.push(`  Invalidated:    [${shortId(item.invalidation.id)}] at ${item.invalidation.createdAt}: ${singleLine(item.invalidation.reason, MAX_REASON_CHARS)}`);
  }
  if (item.replaces.length > 0) lines.push(`  Replaces:       ${item.replaces.map((id) => shortId(id)).join(', ')}`);
  if (item.supersededBy.length > 0) lines.push(`  Superseded by:  ${item.supersededBy.map((id) => shortId(id)).join(', ')}`);
  lines.push(`  Provenance:     ${item.provenance.origin} / ${item.provenance.updateMode}${item.provenance.operationId ? ` (operation ${item.provenance.operationId})` : ''}`);
  lines.push('  Limitations:');
  for (const code of item.limitations) lines.push(`    - ${LIMITATION_TEXT[code] ?? code}`);
  lines.push(`  Rule:           ${line(item.evaluationRule)}`);
  return lines.join('\n');
}

export function renderPredictionHistory(item, history) {
  const lines = [
    `Prediction history [${shortId(item.id)}]`,
    `  ${item.createdAt}  prediction recorded (${item.expectation} for ${item.capability}, horizon to ${item.expiresAt})`,
  ];
  for (const record of history.filter((r) => r.kind !== PREDICTION_KIND)) {
    if (record.kind === INVALIDATION_KIND) {
      lines.push(`  ${record.createdAt}  invalidated: ${singleLine(record.reason, 120)}`);
    } else {
      lines.push(`  ${record.createdAt}  evaluated ${record.verdict} (decided by [${shortId(record.decidingExperienceId)}] over ${record.outcomeExperienceIds.length} record(s))`);
    }
  }
  for (const id of item.supersededBy) lines.push(`  superseded by prediction [${shortId(id)}]`);
  lines.push(`  Current status:   ${item.status}`);
  lines.push('  Note:             each line above is an appended record; none of them replaced another.');
  return lines.join('\n');
}

export function renderEvaluationResult(item, { recorded } = {}) {
  const lines = [
    recorded
      ? `Prediction [${shortId(item.id)}] evaluated as ${item.evaluation?.verdict ?? item.evaluationDecision}`
      : `Prediction [${shortId(item.id)}] was not evaluated: ${item.evaluationDecision}`,
    `  Reason:      ${line(item.evaluationReason)}`,
    `  Rule:        ${line(item.evaluationRule)}`,
    `  Horizon:     ${item.createdAt}..${item.expiresAt}`,
  ];
  if (item.counts) {
    lines.push(`  Evidence:    ${item.counts.establishing} establishing record(s) of ${item.counts.live} live inside the horizon`);
    for (const exclusion of item.exclusions ?? []) {
      if (exclusion.count > 0) lines.push(`    excluded ${exclusion.count} ${exclusion.key}: ${line(exclusion.reason)}`);
    }
  }
  if (item.evaluation) {
    lines.push(`  Recorded:    evaluation [${shortId(item.evaluation.id)}] ${item.evaluation.verdict} at ${item.evaluation.createdAt}`);
    if (item.evaluationStale) lines.push(`  Stale:       ${line(item.staleReason)}`);
  }
  lines.push('  Limits:      this verdict changes no experience, adaptation, or authorization.');
  return lines.join('\n');
}

export function renderCalibration(calibration, { sampleCap = 6 } = {}) {
  const t = calibration.totals;
  const lines = [
    'Prediction ledger',
    `  Live:           ${t.live} expectation(s): ${t.byStatus.recorded} recorded, ${t.byStatus.awaiting_evaluation} awaiting evaluation, ${t.byStatus.expired} expired, ${t.byStatus.evaluated} evaluated, ${t.byStatus.invalidated} invalidated`,
    `  Evaluations:    ${t.matched} matched, ${t.contradicted} contradicted${t.staleEvaluations ? `, ${t.staleEvaluations} stale` : ''}`,
    `  Not scored:     ${t.expired} expired, ${t.awaitingEvaluation} awaiting evaluation, ${t.unevaluated} unevaluated, ${t.invalidated} withdrawn, ${t.superseded} superseded`,
    `  Match rate:     ${calibration.matchRate.value === null
      ? `none stated (${calibration.matchRate.reason})`
      : `${calibration.matchRate.value} over ${calibration.matchRate.denominator} evaluation(s)`}`,
    `  Denominator:    ${calibration.rateDenominator}`,
  ];
  for (const exclusion of calibration.rateExclusions.filter((item) => item.count > 0)) {
    lines.push(`    excluded ${exclusion.count} ${exclusion.key}: ${line(exclusion.reason)}`);
  }
  lines.push(`  Confidence:     unavailable for all ${t.live} record(s) - ${calibration.confidence.reason}`);
  lines.push(`  Reliability:    ${calibration.reliability}`);
  const sample = calibration.byCapability.slice(0, sampleCap);
  if (sample.length > 0) {
    lines.push('  By capability:');
    for (const item of sample) {
      lines.push(`    - ${item.capability}: ${item.predictions} expectation(s), ${item.matched} matched, ${item.contradicted} contradicted${item.rate === null ? `, no rate (${item.rateWithheldReason})` : `, rate ${item.rate} over ${item.denominator}`}`);
    }
    if (calibration.byCapability.length > sample.length) {
      lines.push(`    - ${calibration.byCapability.length - sample.length} more capability group(s) not shown`);
    }
  }
  lines.push('  Limits:');
  for (const limit of calibration.limitations.slice(0, 4)) lines.push(`    - ${line(limit)}`);
  return lines.join('\n');
}
