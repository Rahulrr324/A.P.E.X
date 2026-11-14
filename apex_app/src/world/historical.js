// Historical belief reconstruction over the World Model.
//
// Replaying records stored at or before an instant answers "which records existed". It does not
// answer "what did APEX believe then, on what evidence, and how did that statement stand". This
// module turns a replayed state into that prior-belief view. It is a pure read over state the
// caller already reduced: it writes nothing, calls no model, and never applies a record stored
// after the cutoff.
//
// Two clocks are kept separate. Stored time (`recordedAt`) decides whether APEX knew a record at
// all at the cutoff. Valid time (`validFrom`/`validUntil`/`occurredAt`) decides whether it was in
// force then. A statement can be known and not yet valid, or known and already expired. The
// current-state status vocabulary reports both as `historical`; belief reconstruction names the
// difference without changing that vocabulary, so existing readers keep their contract.
import { canonicalId, objectLabel, parseInstant } from './model.js';
import { computeConflicts, conflictingStatementIds, statementStatus } from './conflicts.js';
import { changesBetween, evidenceFor } from './query.js';

export const MAX_HISTORICAL_STATEMENTS = 100;
export const MAX_LATER_CHANGES = 100;

const HISTORICAL_TYPES = ['fact', 'relationship', 'event'];
const BELIEVED_STATUSES = new Set(['supported', 'contested', 'conflicting']);
const BELIEVED_VALIDITY = new Set(['in_force', 'occurred']);

function cmpStr(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

function tableFor(state, targetType) {
  if (targetType === 'fact') return state.facts;
  if (targetType === 'relationship') return state.relationships;
  if (targetType === 'event') return state.events;
  return null;
}

function instantMs(value) {
  const iso = parseInstant(value);
  return iso === null ? null : Date.parse(iso);
}

function subjectName(state, id) {
  const canonical = canonicalId(state, id) ?? id;
  return state.entities.get(canonical)?.name ?? id;
}

function statementLabel(state, targetType, statement) {
  if (targetType === 'fact') {
    const objectName = statement.object.kind === 'entity'
      ? state.entities.get(canonicalId(state, statement.object.entityId) ?? statement.object.entityId)?.name ?? statement.object.entityId
      : null;
    return `${subjectName(state, statement.subjectId)} ${statement.predicate} ${objectLabel(statement.object, objectName)}`;
  }
  if (targetType === 'relationship') {
    return `${subjectName(state, statement.subjectId)} ${statement.predicate} ${subjectName(state, statement.objectId)}`;
  }
  return statement.eventType;
}

// Names why a statement is not in force at an instant. This is deliberately separate from
// `statementStatus`: the status contract is used by every current-state reader, while the
// historical view must tell "not yet valid" from "expired" without rewriting that contract.
export function validityStanding(statement, targetType, at) {
  const instant = instantMs(at);
  if (instant === null || !statement) return 'unknown';
  if (targetType === 'event') {
    if (instantMs(statement.occurredAt) === null) return 'unknown';
    return instantMs(statement.occurredAt) > instant ? 'not_yet_occurred' : 'occurred';
  }
  if (instantMs(statement.validFrom) === null) return 'unknown';
  if (instantMs(statement.validFrom) > instant) return 'not_yet_valid';
  if (statement.validUntil !== null && instantMs(statement.validUntil) <= instant) return 'expired';
  return 'in_force';
}

function standingReason(status, validity, statement, cutoff) {
  if (status === 'retracted') return `retracted before ${cutoff}; the stored statement is history`;
  if (status === 'superseded') return `superseded before ${cutoff}; the replacement is a separate stored record`;
  if (validity === 'not_yet_valid') return `valid from ${statement.validFrom}, which is after the cutoff`;
  if (validity === 'expired') return `valid until ${statement.validUntil}, which is at or before the cutoff`;
  if (validity === 'not_yet_occurred') return `occurred at ${statement.occurredAt}, which is after the cutoff`;
  if (validity === 'unknown') {
    return `no ${statement.eventType !== undefined ? 'occurred-at' : 'valid-from'} time is recorded, so its standing at the cutoff cannot be placed on a timeline`;
  }
  if (status === 'conflicting') return 'another statement in force at the cutoff disagrees at an overlapping valid time';
  if (status === 'contested') return 'a record cited as evidence is marked as contradicting this statement';
  if (status === 'supported') return 'stored at or before the cutoff and in force then';
  return `the replayed store reported status ${status}`;
}

// One statement's standing against a replayed state. `conflicts` and `conflictIds` may be supplied
// to avoid rebuilding the disagreement index for every statement.
export function statementStanding(state, targetType, id, { at, conflicts = null, conflictIds = null } = {}) {
  const cutoff = parseInstant(at);
  if (cutoff === null) {
    return { status: 'invalid_time', validity: null, recordedAt: null, observedAt: null, reason: 'the cutoff is not an ISO date or time' };
  }
  const table = tableFor(state, targetType);
  const statement = table?.get(id) ?? null;
  if (!statement) {
    return { status: 'missing', validity: null, recordedAt: null, observedAt: null, reason: `no ${targetType} ${id} is stored at or before the cutoff` };
  }
  const status = statementStatus(state, targetType, id, {
    at: cutoff,
    conflicts: conflicts ?? computeConflicts(state, { now: cutoff }),
    conflictIds,
  });
  const validity = validityStanding(statement, targetType, cutoff);
  return {
    status,
    validity,
    recordedAt: statement.recordedAt ?? null,
    observedAt: statement.observedAt ?? null,
    reason: standingReason(status, validity, statement, cutoff),
  };
}

function bucketOf(row) {
  if (row.status === 'retracted') return 'retracted';
  if (row.status === 'superseded') return 'superseded';
  if (row.validity === 'not_yet_valid') return 'notYetValid';
  if (row.validity === 'not_yet_occurred') return 'notYetOccurred';
  if (row.validity === 'expired') return 'expired';
  if (row.validity === 'unknown') return row.targetType === 'event' ? 'timingUnknown' : 'validityUnknown';
  if (row.status === 'conflicting') return 'conflicting';
  if (row.status === 'contested') return 'contested';
  if (row.status === 'supported') return 'supported';
  return 'unclassified';
}

const BUCKET_RANK = {
  supported: 0,
  contested: 1,
  conflicting: 2,
  notYetValid: 3,
  notYetOccurred: 4,
  expired: 5,
  validityUnknown: 6,
  timingUnknown: 7,
  retracted: 8,
  superseded: 9,
  unclassified: 10,
};

function boundedLimit(limit) {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_HISTORICAL_STATEMENTS) : MAX_HISTORICAL_STATEMENTS;
}

// The prior-belief listing: every statement in the replayed state, ordered with beliefs in force
// first, each carrying stored time, valid time, its standing, and the stored evidence references.
// The listing is bounded; the counts describe the whole replayed state, not just the listing.
export function reconstructBelief(state, { at, limit = MAX_HISTORICAL_STATEMENTS } = {}) {
  const cutoff = typeof at === 'string' ? parseInstant(at) : at instanceof Date && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
  if (cutoff === null || !state) {
    return {
      cutoff: null,
      problem: 'the cutoff is not an ISO date or time',
      statements: [],
      counts: null,
      truncated: false,
      note: 'no belief can be reconstructed without a valid cutoff',
    };
  }
  const conflicts = computeConflicts(state, { now: cutoff });
  const conflictIds = conflictingStatementIds(conflicts);
  const rows = [];
  for (const targetType of HISTORICAL_TYPES) {
    for (const statement of tableFor(state, targetType).values()) {
      const standing = statementStanding(state, targetType, statement.id, { at: cutoff, conflicts, conflictIds });
      const evidence = evidenceFor(state, { targetType, targetId: statement.id }).refs ?? [];
      rows.push({
        targetType,
        id: statement.id,
        label: statementLabel(state, targetType, statement),
        status: standing.status,
        validity: standing.validity,
        // A statement whose validity cannot be placed on the timeline is not counted as a belief
        // at that time, even when its stored status is otherwise supported.
        believed: BELIEVED_STATUSES.has(standing.status) && BELIEVED_VALIDITY.has(standing.validity),
        recordedAt: statement.recordedAt ?? null,
        observedAt: statement.observedAt ?? null,
        validFrom: statement.validFrom ?? null,
        validUntil: statement.validUntil ?? null,
        occurredAt: statement.occurredAt ?? null,
        evidence: evidence.map((ref) => `${ref.relation}:${ref.sourceType}:${ref.sourceId}`),
        note: standing.reason,
      });
    }
  }
  rows.sort((a, b) => {
    const rank = (a.believed ? 0 : 1) - (b.believed ? 0 : 1);
    if (rank !== 0) return rank;
    const byBucket = (BUCKET_RANK[bucketOf(a)] ?? 10) - (BUCKET_RANK[bucketOf(b)] ?? 10);
    if (byBucket !== 0) return byBucket;
    return cmpStr(a.targetType, b.targetType) || cmpStr(a.id, b.id);
  });

  const counts = {
    total: rows.length,
    believed: rows.filter((row) => row.believed).length,
    supported: 0,
    contested: 0,
    conflicting: 0,
    notYetValid: 0,
    notYetOccurred: 0,
    expired: 0,
    validityUnknown: 0,
    timingUnknown: 0,
    retracted: 0,
    superseded: 0,
    unclassified: 0,
  };
  for (const row of rows) counts[bucketOf(row)] += 1;

  const bounded = boundedLimit(limit);
  return {
    cutoff,
    problem: null,
    statements: rows.slice(0, bounded),
    counts,
    truncated: rows.length > bounded,
    note: `reconstructed from ${state.recordCount} applied record(s); a statement recorded after ${cutoff} is absent, and a later retraction or supersession is not applied`,
  };
}

// Later changes that touch the traced ids: the target itself and any statement that cited it.
// Reuses the existing window comparison so there is one change vocabulary, not a second one.
export function relevantChanges(result, ids, { limit = MAX_LATER_CHANGES } = {}) {
  if (!result || result.problem) {
    return { from: null, to: null, changes: [], total: 0, truncated: false, problem: result?.problem ?? 'no change window was computed' };
  }
  const wanted = new Set((ids ?? []).filter((id) => typeof id === 'string' && id.length > 0));
  const all = wanted.size === 0 ? [] : result.changes.filter((change) => wanted.has(change.id));
  const bounded = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LATER_CHANGES) : MAX_LATER_CHANGES;
  return {
    from: result.from,
    to: result.to,
    changes: all.slice(0, bounded),
    total: all.length,
    truncated: all.length > bounded,
    problem: null,
  };
}
