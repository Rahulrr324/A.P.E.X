// Read-only belief tracing across the stores.
//
// A trace answers two different questions and keeps them apart:
//  - for a world statement, which stored records support or contradict it, and whether those
//    records are still current in their own store;
//  - for a memory or knowledge record, which world statements cite it, and what the citing
//    statements say about it (support, contradiction, or qualification).
//
// This module derives only from records the caller already read. It never writes, never calls a
// model, never resolves a disagreement, and never authorises anything: `authorizes` is always
// false, and a trace is evidence for a person to read, not a decision.
import { computeConflicts, statementStatus } from './conflicts.js';
import { evidenceFor, statementsCiting } from './query.js';

export const TRACE_TARGET_TYPES = ['memory', 'knowledge', 'fact', 'relationship', 'event'];
export const MAX_TRACE_CITATIONS = 100;
export const MAX_TRACE_REFS = 100;

const WORLD_TYPES = new Set(['fact', 'relationship', 'event']);
const CITED_TYPES = new Set(['memory', 'knowledge']);

function emptyCounts() {
  return {
    citations: 0,
    liveCitations: 0,
    supportingCitations: 0,
    contradictingCitations: 0,
    evidenceRefs: 0,
    unavailableRefs: 0,
    missingRefs: 0,
    staleRefs: 0,
  };
}

function tableFor(state, targetType) {
  if (targetType === 'fact') return state.facts;
  if (targetType === 'relationship') return state.relationships;
  if (targetType === 'event') return state.events;
  return null;
}

function instantOf(at) {
  if (at === undefined || at === null) return new Date().toISOString();
  return at;
}

function describeRef(ref, checked) {
  const state = checked ?? { check: 'not_checked', found: null, active: null, state: null, classification: null, detail: null };
  const unavailable = state.check === 'unavailable' || state.check === 'no-store';
  const missing = state.check === 'ok' && state.found === false;
  const stale = state.check === 'ok' && state.found === true && state.active === false;
  return {
    relation: ref.relation,
    sourceType: ref.sourceType,
    sourceId: ref.sourceId,
    note: ref.note ?? null,
    classification: ref.classification ?? state.classification ?? null,
    from: [...(ref.from ?? [])],
    check: state.check,
    found: state.found ?? null,
    active: state.active ?? null,
    state: state.state ?? null,
    detail: state.detail ?? null,
    unavailable,
    missing,
    stale,
  };
}

function traceWorldStatement(state, {
  targetType,
  targetId,
  at,
  conflicts,
  referenceStates,
}) {
  const table = tableFor(state, targetType);
  const statement = table?.get(targetId) ?? null;
  const instant = instantOf(at);
  const conflictSet = conflicts ?? computeConflicts(state, { now: instant });
  const base = {
    target: {
      type: targetType,
      id: targetId,
      found: statement !== null,
      label: null,
      status: 'missing',
      detail: `no ${targetType} ${targetId} is stored`,
    },
    disposition: {
      state: 'missing',
      reason: `no ${targetType} ${targetId} is stored, so there is nothing to trace`,
    },
    citations: { rows: [], total: 0, truncated: false },
    evidence: { refs: [], total: 0, truncated: false },
    conflicts: [],
    sameStore: null,
    references: { checked: 0, unavailable: 0, missing: 0, stale: 0 },
    counts: emptyCounts(),
    notes: [],
    complete: false,
    authorizes: false,
  };
  if (!statement) return base;

  const status = statementStatus(state, targetType, targetId, { at: instant, conflicts: conflictSet });
  const evidence = evidenceFor(state, { targetType, targetId });
  const refs = (evidence.refs ?? []).slice(0, MAX_TRACE_REFS)
    .map((ref) => describeRef(ref, referenceStates?.get(`${ref.sourceType}:${ref.sourceId}`) ?? null));
  const refsTruncated = (evidence.refs ?? []).length > refs.length;
  const unavailable = refs.filter((ref) => ref.unavailable);
  const missing = refs.filter((ref) => ref.missing);
  const stale = refs.filter((ref) => ref.stale && (ref.relation === 'supports' || ref.relation === 'contradicts'));

  const statusMap = {
    missing: ['missing', 'the statement is not in the store'],
    retracted: ['withdrawn', 'the statement was retracted by an authorized user; the retraction is a stored record, and the original statement is still readable in history'],
    superseded: ['superseded', 'a later statement replaced this one; the earlier record is history, not a current belief'],
    conflicting: ['contradicted', 'another live statement about the same subject and predicate disagrees at an overlapping valid time; the store keeps both sides'],
    contested: ['contradicted', 'a record cited as evidence is marked as contradicting this statement'],
    historical: ['historical', 'the statement was valid in the past but its valid interval does not cover the trace time'],
    future: ['unknown', `the event occurs after the trace time ${instant}`],
    validity_unknown: ['unknown', 'the statement has no valid-from time, so its validity cannot be established'],
    supported: ['supported', 'the statement is stored, in force at the trace time, and not contradicted'],
  };
  const [dispositionState, reason] = statusMap[status] ?? ['unknown', `the store reported status ${status}`];
  let stateName = dispositionState;
  let dispositionReason = reason;
  if (status === 'supported' && unavailable.length > 0) {
    stateName = 'unverified';
    dispositionReason = `${unavailable.length} cited record(s) could not be checked, so the support cannot be confirmed even though the statement itself is in force`;
  } else if (status === 'supported' && missing.length > 0) {
    stateName = 'stale_evidence';
    dispositionReason = `${missing.length} cited record(s) no longer exist in their store, so the recorded support has gone stale`;
  } else if (status === 'supported' && stale.length > 0) {
    stateName = 'stale_evidence';
    dispositionReason = `${stale.length} cited record(s) are no longer current in their own store, so the recorded support has gone stale`;
  }

  const groups = (conflictSet?.groups ?? [])
    .filter((group) => group.memberIds.includes(targetId))
    .map((group) => ({
      kind: group.kind,
      state: group.state,
      subjectId: group.subjectId ?? null,
      subjectName: group.subjectName ?? null,
      predicate: group.predicate ?? null,
      memberIds: [...group.memberIds],
      reason: group.reason,
    }));

  const notes = [];
  if (refsTruncated) notes.push(`evidence references were cut at ${MAX_TRACE_REFS}`);
  if (unavailable.length > 0) notes.push(`${unavailable.length} evidence source(s) could not be read; an unreadable store is never reported as "no evidence"`);
  if (missing.length > 0) notes.push(`${missing.length} cited record(s) are absent from the store that should own them`);
  if (stale.length > 0) notes.push(`${stale.length} supporting record(s) are superseded, retracted, or retired in their own store`);
  if (status === 'retracted' || status === 'superseded') notes.push('the original statement is unchanged in the log; retraction and supersession are separate records');

  return {
    target: {
      type: targetType,
      id: targetId,
      found: true,
      label: statementLabel(state, targetType, statement),
      status,
      detail: null,
    },
    disposition: { state: stateName, reason: dispositionReason },
    citations: { rows: [], total: 0, truncated: false },
    evidence: { refs, total: (evidence.refs ?? []).length, truncated: refsTruncated },
    conflicts: groups,
    sameStore: null,
    references: {
      checked: refs.filter((ref) => ref.check === 'ok').length,
      unavailable: unavailable.length,
      missing: missing.length,
      stale: stale.length,
    },
    counts: {
      ...emptyCounts(),
      evidenceRefs: (evidence.refs ?? []).length,
      unavailableRefs: unavailable.length,
      missingRefs: missing.length,
      staleRefs: stale.length,
    },
    notes,
    complete: !refsTruncated && unavailable.length === 0 && missing.length === 0
      && !['missing', 'validity_unknown', 'future'].includes(status),
    authorizes: false,
  };
}

function statementLabel(state, targetType, statement) {
  if (targetType === 'fact') {
    const objectName = statement.object.kind === 'entity'
      ? state.entities.get(statement.object.entityId)?.name ?? statement.object.entityId
      : null;
    return `${subjectName(state, statement.subjectId)} ${statement.predicate} ${objectLabel(statement.object, objectName)}`;
  }
  if (targetType === 'relationship') {
    return `${subjectName(state, statement.subjectId)} ${statement.predicate} ${subjectName(state, statement.objectId)}`;
  }
  return statement.eventType;
}

function subjectName(state, id) {
  return state.entities.get(id)?.name ?? id;
}

function objectLabel(object, entityName) {
  if (object.kind === 'entity') return entityName ?? object.entityId;
  return String(object.value);
}

function traceCitedRecord(state, {
  targetType,
  targetId,
  targetState,
  at,
  conflicts,
  limit,
  citations,
}) {
  const fetched = citations ?? statementsCiting(state, { sourceType: targetType, sourceId: targetId, at, conflicts, limit });
  const rows = fetched.rows ?? [];
  const live = rows.filter((row) => row.live);
  const supporting = live.filter((row) => row.relations.includes('supports'));
  const contradicting = live.filter((row) => row.relations.includes('contradicts'));
  const qualifying = live.filter((row) => !row.relations.includes('supports') && !row.relations.includes('contradicts'));
  const found = targetState?.found === true;
  const unavailable = targetState?.unavailable === true;
  const targetStatus = found ? targetState.state ?? 'stored' : unavailable ? 'unknown' : 'missing';
  const beforeCounts = emptyCounts();

  let stateName;
  let reason;
  if (!found) {
    if (unavailable) {
      stateName = 'unknown';
      reason = targetState.detail ?? `the ${targetType} store could not be read, so the record's standing cannot be established`;
    } else if (rows.length > 0) {
      stateName = 'unknown';
      reason = `world statements cite ${targetId}, but the ${targetType} store does not hold that record; the citation and the absence cannot both be right`;
    } else {
      stateName = 'missing';
      reason = `no ${targetType} record ${targetId} is stored and no world statement cites it`;
    }
  } else if (targetStatus === 'retracted') {
    stateName = 'withdrawn';
    reason = 'the record was retracted by an authorized user; the stored claim is history, not a current belief';
  } else if (targetStatus === 'superseded') {
    stateName = 'superseded';
    reason = 'a later record replaced this one; the earlier record is history, not a current belief';
  } else if (targetStatus === 'ambiguous') {
    stateName = 'unknown';
    reason = 'the record has an ambiguous lifecycle (more than one terminal record or both a retraction and a supersession), so its standing cannot be established';
  } else if (targetState?.conflicted === true) {
    stateName = 'contradicted';
    reason = 'another record in the same store states a different value for the same subject';
  } else if (contradicting.length > 0) {
    stateName = 'contradicted';
    reason = `${contradicting.length} live world statement(s) cite this record as contradicting them`;
  } else if (targetStatus === 'model_proposed') {
    stateName = 'proposed';
    reason = 'the record is a model proposal; a citation from a world statement does not confirm it';
  } else if (supporting.length > 0) {
    stateName = 'supported';
    reason = `${supporting.length} live world statement(s) cite this record as support`;
  } else if (qualifying.length > 0) {
    stateName = 'qualified';
    reason = 'no world statement cites this record as support or contradiction; live citations only qualify it';
  } else if (rows.length > 0) {
    stateName = 'historical';
    reason = 'every citing world statement is retracted, superseded, or not in force at the trace time';
  } else {
    stateName = 'uncited';
    reason = 'no world statement cites this record; its trace is the store that owns it';
  }

  const notes = [];
  if (unavailable) notes.push('the owning store could not be read; an unreadable store is never reported as an empty one');
  if (fetched.truncated) notes.push(`citations were cut at ${limit ?? MAX_TRACE_CITATIONS}; ${fetched.total} cite this record`);
  if (targetState?.conflicted === true) notes.push('the same-store conflict is heuristic for memory records: it compares clause subjects and values, and it never decides which value is right');
  if (targetStatus === 'model_proposed') notes.push('a model-proposed record is not user-confirmed, even when another store cites it');

  return {
    target: {
      type: targetType,
      id: targetId,
      found,
      label: targetState?.label ?? null,
      status: targetStatus,
      detail: found
        ? null
        : unavailable
          ? targetState.detail ?? 'the owning store could not be read'
          : 'the owning store does not hold this record',
    },
    disposition: { state: stateName, reason },
    citations: { rows, total: fetched.total ?? rows.length, truncated: fetched.truncated === true },
    evidence: { refs: [], total: 0, truncated: false },
    conflicts: [],
    sameStore: targetState?.sameStore ?? null,
    references: { checked: 0, unavailable: 0, missing: 0, stale: 0 },
    counts: {
      ...beforeCounts,
      citations: rows.length,
      liveCitations: live.length,
      supportingCitations: supporting.length,
      contradictingCitations: contradicting.length,
    },
    notes,
    complete: fetched.truncated !== true && targetState?.complete !== false,
    authorizes: false,
  };
}

// `targetState` is the owning store's reading of a memory or knowledge record:
// `{found, label, state, conflicted, complete, sameStore}`. It is supplied by the action because
// only the owning store can decide what its own lifecycle means. The world state is supplied as
// the reduced state, and this module only reads it.
export function traceBelief(state, {
  targetType,
  targetId,
  targetState = null,
  at = undefined,
  conflicts = null,
  limit = null,
  citations = null,
  referenceStates = null,
} = {}) {
  if (WORLD_TYPES.has(targetType)) {
    return traceWorldStatement(state, { targetType, targetId, at, conflicts, referenceStates });
  }
  if (CITED_TYPES.has(targetType)) {
    return traceCitedRecord(state, { targetType, targetId, targetState, at, conflicts, limit, citations });
  }
  return {
    target: { type: targetType ?? null, id: targetId ?? null, found: false, label: null, status: 'unsupported', detail: null },
    disposition: { state: 'unknown', reason: 'this record type cannot be traced' },
    citations: { rows: [], total: 0, truncated: false },
    evidence: { refs: [], total: 0, truncated: false },
    conflicts: [],
    sameStore: null,
    references: { checked: 0, unavailable: 0, missing: 0, stale: 0 },
    counts: emptyCounts(),
    notes: [`traceable record types: ${TRACE_TARGET_TYPES.join(', ')}`],
    complete: false,
    authorizes: false,
  };
}
