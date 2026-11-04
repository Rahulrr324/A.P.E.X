// Conservative contradiction detection over the World Model.
//
// A contradiction is a claim that two records cannot both hold at the same valid time. Not every
// difference is one: a former employer and a current employer are two non-overlapping records, a
// project that was active last month and completed today has two valid periods, an unknown value is
// not a negative value, and two sources that observed different things at different times may both
// be right. This module therefore detects only:
//  - different values for a declared single-valued fact predicate whose valid intervals overlap;
//  - different objects for a declared single-valued relationship whose valid intervals overlap;
//  - two active entities claiming the same trusted external identifier.
//
// It keeps both sides, names the evidence on each, and never chooses a winner from source ranking.
import {
  canonicalId,
  hasValidity,
  intervalOverlaps,
  objectLabel,
  parseInstant,
  retractionFor,
  scalarKey,
  singleValuedFact,
  singleValuedRelationship,
  supersessionFor,
} from './model.js';
import { factPredicate, relationshipType } from './vocabulary.js';

function evidenceIds(evidence) {
  return (evidence ?? []).map((entry) => `${entry.sourceType}:${entry.sourceId}`);
}

function subjectOf(state, id) {
  return canonicalId(state, id) ?? id;
}

function overlapping(a, b) {
  return a.validFrom !== null && b.validFrom !== null && intervalOverlaps(a, b);
}

function group(sorted, key) {
  const map = new Map();
  for (const item of sorted) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function factMember(state, fact) {
  const subject = state.entities.get(subjectOf(state, fact.subjectId));
  const objectName = fact.object.kind === 'entity'
    ? state.entities.get(subjectOf(state, fact.object.entityId))?.name ?? fact.object.entityId
    : null;
  return {
    id: fact.id,
    entityId: fact.subjectId,
    subjectId: subjectOf(state, fact.subjectId),
    subjectName: subject?.name ?? fact.subjectId,
    value: objectLabel(fact.object, objectName),
    valueKey: fact.object.kind === 'entity'
      ? `entity:${subjectOf(state, fact.object.entityId)}`
      : scalarKey(fact.object),
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    observedAt: fact.observedAt,
    evidence: evidenceIds(fact.evidence),
    evidenceDetail: fact.evidence,
  };
}

function relationshipMember(state, relationship) {
  const subject = state.entities.get(subjectOf(state, relationship.subjectId));
  const object = state.entities.get(subjectOf(state, relationship.objectId));
  return {
    id: relationship.id,
    entityId: relationship.subjectId,
    subjectId: subjectOf(state, relationship.subjectId),
    subjectName: subject?.name ?? relationship.subjectId,
    objectId: subjectOf(state, relationship.objectId),
    objectName: object?.name ?? relationship.objectId,
    value: object?.name ?? relationship.objectId,
    valueKey: `entity:${subjectOf(state, relationship.objectId)}`,
    validFrom: relationship.validFrom,
    validUntil: relationship.validUntil,
    observedAt: relationship.observedAt,
    evidence: evidenceIds(relationship.evidence),
    evidenceDetail: relationship.evidence,
  };
}

function activeFacts(state) {
  return [...state.facts.values()].filter((fact) => !retractionFor(state, 'fact', fact.id)
    && !supersessionFor(state, 'fact', fact.id));
}

function activeRelationships(state) {
  return [...state.relationships.values()].filter((relationship) => !retractionFor(state, 'relationship', relationship.id)
    && !supersessionFor(state, 'relationship', relationship.id));
}

// All conflict groups, deterministically ordered. `at` is not used to hide a historical
// disagreement: two records whose valid periods overlapped are reported as a disagreement
// even if neither is current today. A disagreement that is no longer current is labelled
// `historical`; it is still shown because the log still contains both sides.
export function computeConflicts(state, { now = Date.now() } = {}) {
  const nowMs = typeof now === 'number' && Number.isFinite(now)
    ? now
    : (parseInstant(now) === null ? Date.now() : Date.parse(parseInstant(now)));
  const groups = [];

  const facts = activeFacts(state);
  const factGroups = group(
    facts.filter((fact) => singleValuedFact(fact.predicate)),
    (fact) => `${subjectOf(state, fact.subjectId)}\u0000${fact.predicate}`,
  );
  for (const [key, members] of factGroups) {
    const [subjectId, predicate] = key.split('\u0000');
    const conflicting = members.filter((fact, index) => members.some((other, otherIndex) => otherIndex !== index
      && overlapping(fact, other)
      && (fact.object.kind === 'entity' && other.object.kind === 'entity'
        ? subjectOf(state, fact.object.entityId) !== subjectOf(state, other.object.entityId)
        : scalarKey(fact.object) !== scalarKey(other.object))));
    if (conflicting.length < 2) continue;
    const shown = conflicting.map((fact) => factMember(state, fact));
    const current = members.filter((fact) => hasValidity(fact, nowMs)).length;
    groups.push({
      kind: 'fact',
      state: current >= 2 ? 'active' : 'historical',
      subjectId,
      subjectName: state.entities.get(subjectId)?.name ?? subjectId,
      predicate,
      cardinality: factPredicate(predicate).cardinality,
      reason: `two different values for single-valued predicate "${predicate}" have overlapping valid times`,
      members: shown,
      memberIds: shown.map((member) => member.id),
      resolved: false,
    });
  }

  const relationships = activeRelationships(state);
  const relationshipGroups = group(
    relationships.filter((relationship) => singleValuedRelationship(relationship.predicate)),
    (relationship) => `${subjectOf(state, relationship.subjectId)}\u0000${relationship.predicate}\u0000${relationship.directionality}`,
  );
  for (const [key, members] of relationshipGroups) {
    const [subjectId, predicate] = key.split('\u0000');
    const conflicting = members.filter((relationship, index) => members.some((other, otherIndex) => otherIndex !== index
      && overlapping(relationship, other)
      && subjectOf(state, relationship.objectId) !== subjectOf(state, other.objectId)));
    if (conflicting.length < 2) continue;
    const shown = conflicting.map((relationship) => relationshipMember(state, relationship));
    const current = members.filter((relationship) => hasValidity(relationship, nowMs)).length;
    groups.push({
      kind: 'relationship',
      state: current >= 2 ? 'active' : 'historical',
      subjectId,
      subjectName: state.entities.get(subjectId)?.name ?? subjectId,
      predicate,
      cardinality: relationshipType(predicate).cardinality,
      reason: `two different objects for single-valued relationship "${predicate}" have overlapping valid times`,
      members: shown,
      memberIds: shown.map((member) => member.id),
      resolved: false,
    });
  }

  // A trusted external identifier is deterministic identity evidence. If two active entities
  // carry the same scheme/value, APEX does not merge them; it reports the conflict and leaves the
  // decision to the user.
  const external = new Map();
  for (const entity of state.entities.values()) {
    if (entity.status !== 'active') continue;
    for (const identifier of entity.externalIds) {
      const key = `${identifier.scheme}\u0000${String(identifier.value).trim().toLowerCase()}`;
      if (!external.has(key)) external.set(key, { scheme: identifier.scheme, value: identifier.value, entityIds: [] });
      const entry = external.get(key);
      if (!entry.entityIds.includes(entity.id)) entry.entityIds.push(entity.id);
    }
  }
  for (const entry of external.values()) {
    if (entry.entityIds.length < 2) continue;
    groups.push({
      kind: 'identity',
      state: 'active',
      externalScheme: entry.scheme,
      externalValue: entry.value,
      entityIds: entry.entityIds,
      members: entry.entityIds.map((id) => ({
        id,
        entityId: id,
        value: state.entities.get(id)?.name ?? id,
        evidence: [],
      })),
      memberIds: entry.entityIds,
      reason: `two active entities claim the same external identifier ${entry.scheme}:${entry.value}`,
      resolved: false,
    });
  }

  // Code-point ordering, not locale collation: two machines replaying one log produce one order.
  const cmpStr = (a, b) => {
    const left = String(a ?? '');
    const right = String(b ?? '');
    return left < right ? -1 : left > right ? 1 : 0;
  };
  groups.sort((a, b) => {
    if (a.kind !== b.kind) return cmpStr(a.kind, b.kind);
    const aKey = `${a.subjectId ?? ''}\u0000${a.externalScheme ?? ''}\u0000${a.predicate ?? ''}`;
    const bKey = `${b.subjectId ?? ''}\u0000${b.externalScheme ?? ''}\u0000${b.predicate ?? ''}`;
    return cmpStr(aKey, bKey);
  });

  const contested = [...activeFacts(state).map((fact) => ({ targetType: 'fact', statement: fact })),
    ...activeRelationships(state).map((relationship) => ({ targetType: 'relationship', statement: relationship }))]
    .filter(({ statement }) => (statement.evidence ?? []).some((entry) => entry.relation === 'contradicts'))
    .map(({ targetType, statement }) => ({
      targetType,
      id: statement.id,
      subjectId: targetType === 'fact' ? subjectOf(state, statement.subjectId) : subjectOf(state, statement.subjectId),
      predicate: statement.predicate,
      evidence: statement.evidence.filter((entry) => entry.relation === 'contradicts')
        .map((entry) => `${entry.sourceType}:${entry.sourceId}`),
      at: statement.recordedAt,
    }))
    .sort((a, b) => cmpStr(`${a.targetType}:${a.id}`, `${b.targetType}:${b.id}`));

  return {
    groups,
    contested,
    counts: {
      groups: groups.length,
      active: groups.filter((g) => g.state === 'active').length,
      historical: groups.filter((g) => g.state === 'historical').length,
      fact: groups.filter((g) => g.kind === 'fact').length,
      relationship: groups.filter((g) => g.kind === 'relationship').length,
      identity: groups.filter((g) => g.kind === 'identity').length,
      contested: contested.length,
    },
  };
}

export function conflictsForEntity(state, entityId, conflicts = computeConflicts(state)) {
  const canonical = canonicalId(state, entityId) ?? entityId;
  return conflicts.groups.filter((group) => group.subjectId === canonical
    || (group.members ?? []).some((member) => canonicalId(state, member.entityId) === canonical))
    .map((group) => ({
      ...group,
      members: group.members.map((member) => ({
        ...member,
        entityId: canonicalId(state, member.entityId) ?? member.entityId,
      })),
    }));
}

export function conflictingStatementIds(conflicts) {
  const ids = new Set();
  for (const group of conflicts.groups) for (const id of group.memberIds) ids.add(id);
  return ids;
}

export function statementStatus(state, targetType, id, { at = new Date(), conflicts = null } = {}) {
  const table = targetType === 'fact' ? state.facts
    : targetType === 'relationship' ? state.relationships : state.events;
  const statement = table.get(id);
  if (!statement) return 'missing';
  if (retractionFor(state, targetType, id)) return 'retracted';
  if (supersessionFor(state, targetType, id)) return 'superseded';
  const instant = typeof at === 'string' ? parseInstant(at)
    : at instanceof Date ? at.getTime() : Number.isFinite(at) ? at : null;
  if (instant === null) return 'validity_unknown';
  if (targetType === 'event') {
    if (statement.occurredAt !== null && parseInstant(statement.occurredAt) > instant) return 'future';
    return 'supported';
  }
  if (statement.validFrom === null) return 'validity_unknown';
  const conflictSet = conflicts ?? computeConflicts(state, { now: instant });
  if (conflictingStatementIds(conflictSet).has(id)) return 'conflicting';
  if (!hasValidity(statement, instant)) return 'historical';
  if ((statement.evidence ?? []).some((entry) => entry.relation === 'contradicts')) return 'contested';
  return 'supported';
}
