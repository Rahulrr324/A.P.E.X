// Bounded, deterministic queries over the World Model. Pure functions over a reduced state.
//
// Every function here is a read: it writes nothing, runs nothing, and calls no model. Results are
// ordered by code-point comparison rather than locale collation so two machines replay the same
// answer. A query never invents a field the store does not hold: a missing fact is reported as
// missing, not as a negative value, and a statement with no valid-from time is reported as
// `validity_unknown` rather than treated as current.
import {
  canonicalId,
  hasValidity,
  parseInstant,
  reduceRecords,
  retractionFor,
  scalarKey,
  supersessionFor,
  objectLabel,
} from './model.js';
import { computeConflicts, conflictsForEntity, statementStatus } from './conflicts.js';
import { categoryLabel, factPredicate, relationshipType } from './vocabulary.js';

export const MAX_QUERY_LIMIT = 100;
export const MAX_RELATED_DEPTH = 3;
export const MAX_RELATED_NODES = 60;
export const MAX_HISTORY_ENTRIES = 200;

function cmpStr(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

function toIso(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return parseInstant(value);
}

function atFor(options) {
  if (options.at === undefined || options.at === null) return new Date().toISOString();
  return toIso(options.at);
}

function timeOf(value) {
  return typeof value === 'string' ? parseInstant(value) : null;
}

function sortByValidFrom(a, b) {
  const left = timeOf(a.validFrom);
  const right = timeOf(b.validFrom);
  if (left === null && right === null) return cmpStr(a.id, b.id);
  if (left === null) return 1;
  if (right === null) return -1;
  if (left !== right) return left < right ? -1 : 1;
  return cmpStr(a.id, b.id);
}

function sortByPredicate(a, b) {
  const byPredicate = cmpStr(a.predicate, b.predicate);
  if (byPredicate !== 0) return byPredicate;
  return sortByValidFrom(a, b);
}

function entityName(state, id) {
  const canonical = canonicalId(state, id);
  if (canonical === null) return id;
  return state.entities.get(canonical)?.name ?? id;
}

function evidenceIds(evidence) {
  return (evidence ?? []).map((entry) => `${entry.sourceType}:${entry.sourceId}`);
}

// ---- entity resolution ------------------------------------------------------

export function activeEntities(state) {
  return [...state.entities.values()]
    .filter((entity) => entity.status === 'active')
    .sort((a, b) => {
      const byName = cmpStr(a.name.normalize('NFKC').toLowerCase(), b.name.normalize('NFKC').toLowerCase());
      return byName !== 0 ? byName : cmpStr(a.id, b.id);
    });
}

function matchesName(entity, normalized) {
  if (!normalized) return false;
  const name = String(entity.name ?? '').normalize('NFKC').toLowerCase();
  if (name === normalized) return true;
  return entity.aliases.some((alias) => String(alias).normalize('NFKC').toLowerCase() === normalized);
}

// Resolves a user-supplied reference. Identity is never inferred from a name match: a name that
// selects more than one active entity is returned as an ambiguity with every candidate, not as the
// first match. A reference to a merged entity resolves to the surviving entity and says so.
export function resolveEntityRef(state, ref) {
  const text = String(ref ?? '').trim();
  if (text === '') return { ref: text, id: null, entity: null, matchedBy: null, candidates: [], note: 'no entity reference was given' };

  const direct = state.entities.get(text);
  if (direct) {
    if (direct.status === 'merged') {
      const target = canonicalId(state, text);
      const entity = target === null ? null : state.entities.get(target) ?? null;
      return {
        ref: text,
        id: target ?? text,
        entity,
        matchedBy: 'id',
        candidates: [],
        note: target === null
          ? `entity ${text} is merged through a chain that does not resolve; the store needs repair`
          : `entity ${text} was merged into ${target}; the surviving entity is shown`,
      };
    }
    return { ref: text, id: direct.id, entity: direct, matchedBy: 'id', candidates: [], note: null };
  }

  const normalized = text.normalize('NFKC').toLowerCase();
  const named = activeEntities(state).filter((entity) => matchesName(entity, normalized));
  if (named.length === 1) {
    return { ref: text, id: named[0].id, entity: named[0], matchedBy: 'name', candidates: [], note: null };
  }
  if (named.length > 1) {
    return {
      ref: text,
      id: null,
      entity: null,
      matchedBy: 'name',
      candidates: named.map((entity) => ({ id: entity.id, name: entity.name, category: entity.category })),
      note: `"${text}" matches ${named.length} active entities; identity is not inferred from a name, so choose one by id`,
    };
  }

  // A unique id prefix is accepted only for references that can be an id at all. Two entities
  // sharing a prefix is reported as ambiguous rather than resolved by position.
  if (/^[A-Za-z0-9-]{4,64}$/.test(text)) {
    const prefixed = [...state.entities.values()].filter((entity) => entity.id.startsWith(text));
    const active = prefixed.filter((entity) => entity.status === 'active');
    if (active.length === 1) {
      return { ref: text, id: active[0].id, entity: active[0], matchedBy: 'id-prefix', candidates: [], note: null };
    }
    if (prefixed.length > 1) {
      return {
        ref: text,
        id: null,
        entity: null,
        matchedBy: 'id-prefix',
        candidates: prefixed.map((entity) => ({ id: entity.id, name: entity.name, category: entity.category })),
        note: `"${text}" is a prefix of ${prefixed.length} entity ids; give more characters or the full id`,
      };
    }
  }
  return { ref: text, id: null, entity: null, matchedBy: null, candidates: [], note: `no entity matches "${text}"` };
}

// Alias and name lookup without resolving to one answer. Used for identity work, where a shared
// name is a candidate and never a merge.
export function aliasLookup(state, text) {
  const normalized = String(text ?? '').trim().normalize('NFKC').toLowerCase();
  if (normalized === '') return { text: '', matches: [] };
  const matches = [...state.entities.values()]
    .filter((entity) => entity.status === 'active' && matchesName(entity, normalized))
    .sort((a, b) => cmpStr(a.name, b.name) || cmpStr(a.id, b.id))
    .map((entity) => ({
      id: entity.id,
      name: entity.name,
      category: entity.category,
      matchedOn: entity.name.normalize('NFKC').toLowerCase() === normalized ? 'name' : 'alias',
    }));
  return { text, matches };
}

// ---- fact and relationship views -------------------------------------------

function factDirectionOf(state, fact, entityId) {
  const subject = canonicalId(state, fact.subjectId) ?? fact.subjectId;
  if (subject === entityId) return 'outgoing';
  if (fact.object.kind === 'entity') {
    const object = canonicalId(state, fact.object.entityId) ?? fact.object.entityId;
    if (object === entityId) return 'incoming';
  }
  return null;
}

function factView(state, fact, { at, conflicts, direction = 'outgoing' }) {
  const objectName = fact.object.kind === 'entity' ? entityName(state, fact.object.entityId) : null;
  const supersession = supersessionFor(state, 'fact', fact.id);
  const retraction = retractionFor(state, 'fact', fact.id);
  return {
    id: fact.id,
    direction,
    predicate: fact.predicate,
    subjectId: canonicalId(state, fact.subjectId) ?? fact.subjectId,
    subjectName: entityName(state, fact.subjectId),
    object: fact.object,
    objectLabel: objectLabel(fact.object, objectName),
    objectValueKey: fact.object.kind === 'entity'
      ? `entity:${canonicalId(state, fact.object.entityId) ?? fact.object.entityId}`
      : scalarKey(fact.object),
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    observedAt: fact.observedAt,
    recordedAt: fact.recordedAt,
    confidence: fact.confidence ?? null,
    evidence: evidenceIds(fact.evidence),
    evidenceDetail: fact.evidence,
    status: statementStatus(state, 'fact', fact.id, { at, conflicts }),
    supersededBy: supersession?.byId ?? null,
    retractedReason: retraction?.reason ?? null,
    cardinality: factPredicate(fact.predicate).cardinality,
  };
}

function relationshipView(state, relationship, { at, conflicts, direction = 'outgoing' }) {
  const subjectCanonical = canonicalId(state, relationship.subjectId) ?? relationship.subjectId;
  const objectCanonical = canonicalId(state, relationship.objectId) ?? relationship.objectId;
  const type = relationshipType(relationship.predicate);
  const label = direction === 'incoming'
    ? (type.inverse ?? `${relationship.predicate} (inverse)`)
    : relationship.predicate;
  const counterpartId = direction === 'outgoing' ? objectCanonical : subjectCanonical;
  const supersession = supersessionFor(state, 'relationship', relationship.id);
  const retraction = retractionFor(state, 'relationship', relationship.id);
  return {
    id: relationship.id,
    direction,
    predicate: relationship.predicate,
    label,
    directionality: relationship.directionality,
    subjectId: subjectCanonical,
    subjectName: entityName(state, relationship.subjectId),
    objectId: objectCanonical,
    objectName: entityName(state, relationship.objectId),
    counterpartId,
    counterpartName: entityName(state, counterpartId),
    properties: relationship.properties ?? null,
    validFrom: relationship.validFrom,
    validUntil: relationship.validUntil,
    observedAt: relationship.observedAt,
    recordedAt: relationship.recordedAt,
    evidence: evidenceIds(relationship.evidence),
    evidenceDetail: relationship.evidence,
    status: statementStatus(state, 'relationship', relationship.id, { at, conflicts }),
    supersededBy: supersession?.byId ?? null,
    retractedReason: retraction?.reason ?? null,
    cardinality: type.cardinality,
  };
}

function filterStatements(list, options) {
  const {
    includeRetracted = false,
    includeSuperseded = false,
    currentOnly = false,
    asOf = null,
    at = null,
    limit = null,
  } = options;
  let rows = list;
  if (!includeRetracted) rows = rows.filter((row) => row.status !== 'retracted');
  if (!includeSuperseded) rows = rows.filter((row) => row.status !== 'superseded');
  if (currentOnly) rows = rows.filter((row) => row.status === 'supported' || row.status === 'contested' || row.status === 'conflicting');
  if (asOf !== null) {
    const instant = parseInstant(asOf);
    if (instant === null) return { rows: [], problem: `"${asOf}" is not an ISO date or time` };
    rows = rows.filter((row) => {
      if (row.validFrom === null) return false;
      return hasValidity({ validFrom: row.validFrom, validUntil: row.validUntil }, parseInstant(instant));
    });
  }
  const bounded = Number.isInteger(limit) && limit > 0 ? rows.slice(0, Math.min(limit, MAX_QUERY_LIMIT)) : rows;
  return { rows: bounded, problem: null };
}

export function factsFor(state, entityId, options = {}) {
  const canonical = canonicalId(state, entityId);
  if (canonical === null) return { entityId, problem: 'the entity merge chain does not resolve', facts: [], incoming: [] };
  if (!state.entities.has(canonical)) return { entityId, problem: `entity ${entityId} does not exist`, facts: [], incoming: [] };
  const at = atFor(options);
  if (at === null) return { entityId, problem: `"${options.at}" is not an ISO date or date-time with a time zone`, facts: [], incoming: [] };
  const conflicts = options.conflicts ?? computeConflicts(state, { now: at });
  const relevant = [...state.facts.values()].filter((fact) => factDirectionOf(state, fact, canonical) !== null);
  const views = relevant.map((fact) => factView(state, fact, {
    at,
    conflicts,
    direction: factDirectionOf(state, fact, canonical),
  }));
  const outgoing = views.filter((view) => view.direction === 'outgoing').sort(sortByPredicate);
  const incoming = views.filter((view) => view.direction === 'incoming').sort(sortByPredicate);
  const all = [...outgoing, ...incoming];
  const filtered = filterStatements(all, { ...options, at });
  return {
    entityId: canonical,
    entityName: entityName(state, canonical),
    asOf: options.asOf ?? null,
    facts: filtered.rows,
    outgoing: filtered.rows.filter((view) => view.direction === 'outgoing'),
    incoming: filtered.rows.filter((view) => view.direction === 'incoming'),
    problem: filtered.problem,
    note: options.asOf
      ? `filtered to statements whose valid time covers ${toIso(options.asOf)}; retraction and supersession are still reported as recorded`
      : null,
  };
}

// Current attribute map: one entry per predicate with every currently valid value. A predicate
// with no current value is absent; that absence is not a claim that the value is false.
export function attributesFor(state, entityId, options = {}) {
  // An as-of view asks what was valid at that instant, so status must be evaluated at the same
  // instant. Judged at "now" a fact that has since ended is historical and would be filtered out
  // of the past view that asked for it.
  const scoped = options.at === undefined || options.at === null
    ? { ...options, at: options.asOf ?? null }
    : options;
  const facts = factsFor(state, entityId, { ...scoped, currentOnly: true });
  if (facts.problem) return { entityId: facts.entityId ?? entityId, attributes: {}, problem: facts.problem };
  const map = new Map();
  for (const fact of facts.facts) {
    if (fact.direction !== 'outgoing') continue;
    if (!map.has(fact.predicate)) map.set(fact.predicate, []);
    map.get(fact.predicate).push(fact);
  }
  const attributes = {};
  for (const predicate of [...map.keys()].sort(cmpStr)) {
    attributes[predicate] = map.get(predicate);
  }
  return { entityId: facts.entityId, entityName: facts.entityName, attributes, asOf: options.asOf ?? null, problem: null };
}

export function relationshipsFor(state, entityId, options = {}) {
  const canonical = canonicalId(state, entityId);
  if (canonical === null) return { entityId, problem: 'the entity merge chain does not resolve', relationships: [], outgoing: [], incoming: [] };
  if (!state.entities.has(canonical)) return { entityId, problem: `entity ${entityId} does not exist`, relationships: [], outgoing: [], incoming: [] };
  const at = atFor(options);
  if (at === null) return { entityId, problem: `"${options.at}" is not an ISO date or date-time with a time zone`, relationships: [], outgoing: [], incoming: [] };
  const conflicts = options.conflicts ?? computeConflicts(state, { now: at });
  const directionFilter = options.direction ?? 'both';
  const predicateFilter = options.predicate ? new Set([].concat(options.predicate)) : null;
  const views = [];
  for (const relationship of state.relationships.values()) {
    const subject = canonicalId(state, relationship.subjectId) ?? relationship.subjectId;
    const object = canonicalId(state, relationship.objectId) ?? relationship.objectId;
    if (subject !== canonical && object !== canonical) continue;
    if (predicateFilter && !predicateFilter.has(relationship.predicate)) continue;
    if (subject === canonical && directionFilter !== 'incoming') {
      views.push(relationshipView(state, relationship, { at, conflicts, direction: 'outgoing' }));
    }
    if (object === canonical && directionFilter !== 'outgoing') {
      views.push(relationshipView(state, relationship, { at, conflicts, direction: 'incoming' }));
    }
  }
  views.sort((a, b) => sortByPredicate(a, b) || cmpStr(a.direction, b.direction) || cmpStr(a.id, b.id));
  const filtered = filterStatements(views, { ...options, at });
  return {
    entityId: canonical,
    entityName: entityName(state, canonical),
    asOf: options.asOf ?? null,
    relationships: filtered.rows,
    outgoing: filtered.rows.filter((view) => view.direction === 'outgoing'),
    incoming: filtered.rows.filter((view) => view.direction === 'incoming'),
    problem: filtered.problem,
    note: options.asOf
      ? `filtered to relationships whose valid time covers ${toIso(options.asOf)}; retraction and supersession are still reported as recorded`
      : null,
  };
}

export function eventsFor(state, entityId, options = {}) {
  const canonical = canonicalId(state, entityId);
  if (canonical === null) return { entityId, problem: 'the entity merge chain does not resolve', events: [] };
  if (!state.entities.has(canonical)) return { entityId, problem: `entity ${entityId} does not exist`, events: [] };
  const at = atFor(options);
  if (at === null) return { entityId, problem: `"${options.at}" is not an ISO date or date-time with a time zone`, events: [] };
  const conflicts = options.conflicts ?? computeConflicts(state, { now: at });
  const rows = [];
  for (const event of state.events.values()) {
    const participants = event.participants.map((id) => canonicalId(state, id) ?? id);
    const affected = event.affected.map((id) => canonicalId(state, id) ?? id);
    if (!participants.includes(canonical) && !affected.includes(canonical)) continue;
    if (!options.includeRetracted && retractionFor(state, 'event', event.id)) continue;
    if (!options.includeSuperseded && supersessionFor(state, 'event', event.id)) continue;
    const retraction = retractionFor(state, 'event', event.id);
    rows.push({
      id: event.id,
      eventType: event.eventType,
      role: participants.includes(canonical) ? 'participant' : 'affected',
      participants: participants.map((id) => ({ id, name: entityName(state, id) })),
      affected: affected.map((id) => ({ id, name: entityName(state, id) })),
      occurredAt: event.occurredAt,
      observedAt: event.observedAt,
      recordedAt: event.recordedAt,
      properties: event.properties ?? null,
      evidence: evidenceIds(event.evidence),
      evidenceDetail: event.evidence,
      status: statementStatus(state, 'event', event.id, { at, conflicts }),
      retractedReason: retraction?.reason ?? null,
      supersededBy: supersessionFor(state, 'event', event.id)?.byId ?? null,
    });
  }
  rows.sort((a, b) => {
    const left = timeOf(a.occurredAt);
    const right = timeOf(b.occurredAt);
    if (left === null && right === null) return cmpStr(a.id, b.id);
    if (left === null) return 1;
    if (right === null) return -1;
    if (left !== right) return left < right ? -1 : 1;
    return cmpStr(a.id, b.id);
  });
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? Math.min(options.limit, MAX_QUERY_LIMIT) : rows.length;
  return {
    entityId: canonical,
    entityName: entityName(state, canonical),
    events: rows.slice(0, limit),
    total: rows.length,
    truncated: rows.length > limit,
    problem: null,
    note: 'occurredAt is when the event happened, observedAt is when it was learned, recordedAt is when it was stored; a null occurredAt is unknown, not current',
  };
}

// The full view of one entity. Like every query here it is assembled from stored records only.
export function entityView(state, entityId, options = {}) {
  const resolved = resolveEntityRef(state, entityId);
  if (!resolved.entity) return { resolved, entity: null, problem: resolved.note };
  const id = resolved.id;
  const at = atFor(options);
  if (at === null) return { resolved, entity: null, problem: `"${options.at}" is not an ISO date or date-time with a time zone` };
  const conflicts = options.conflicts ?? computeConflicts(state, { now: at });
  const facts = factsFor(state, id, { ...options, at, conflicts });
  if (facts.problem) return { resolved, entity: null, problem: facts.problem };
  const relationships = relationshipsFor(state, id, { ...options, at, conflicts });
  if (relationships.problem) return { resolved, entity: null, problem: relationships.problem };
  const events = eventsFor(state, id, { ...options, at, conflicts });
  if (events.problem) return { resolved, entity: null, problem: events.problem };
  const entityConflicts = conflictsForEntity(state, id, conflicts);
  const merges = [...state.merges.values()]
    .filter((merge) => merge.fromId === id || merge.toId === id)
    .sort((a, b) => cmpStr(a.id, b.id))
    .map((merge) => ({
      id: merge.id,
      fromId: merge.fromId,
      fromName: entityName(state, merge.fromId),
      toId: merge.toId,
      toName: entityName(state, merge.toId),
      reason: merge.reason,
      at: merge.at,
      undoneAt: merge.undoneAt ?? null,
    }));
  const identityDecisions = [...state.identityDecisions.values()]
    .filter((decision) => decision.leftId === id || decision.rightId === id)
    .sort((a, b) => cmpStr(a.leftId, b.leftId) || cmpStr(a.rightId, b.rightId));
  const entity = resolved.entity;
  return {
    resolved,
    entity: {
      id: entity.id,
      category: entity.category,
      categoryLabel: categoryLabel(entity.category),
      name: entity.name,
      aliases: [...entity.aliases],
      description: entity.description,
      externalIds: entity.externalIds.map((external) => ({ scheme: external.scheme, value: external.value })),
      status: entity.status,
      mergedInto: entity.mergedInto,
      mergedFrom: [...entity.mergedFrom],
      retiredReason: entity.retiredReason,
      observedAt: entity.observedAt,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      evidence: evidenceIds(entity.evidence),
      evidenceDetail: entity.evidence,
    },
    facts: facts.facts,
    relationships: relationships.relationships,
    events: events.events,
    merges,
    identityDecisions,
    conflicts: entityConflicts,
    counts: {
      outgoingFacts: facts.outgoing.length,
      incomingFacts: facts.incoming.length,
      relationships: relationships.relationships.length,
      events: events.total,
      conflictGroups: entityConflicts.length,
    },
    problem: null,
  };
}

// ---- evidence ---------------------------------------------------------------

// Every distinct evidence reference that bears on an entity or one statement about it. The
// sources are returned as references; the referenced records are not copied here.
export function evidenceFor(state, { entityId = null, targetType = null, targetId = null } = {}) {
  const refs = new Map();
  const targets = [];
  const note = (entry) => {
    const key = `${entry.relation}\u0000${entry.sourceType}\u0000${entry.sourceId}`;
    if (!refs.has(key)) {
      refs.set(key, {
        relation: entry.relation,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        note: entry.note ?? null,
        classification: entry.classification ?? null,
        from: [],
      });
    }
    return refs.get(key);
  };

  const addStatement = (type, statement) => {
    targets.push({ type, id: statement.id ?? statement.worldEventId });
    for (const entry of statement.evidence ?? []) note(entry).from.push(`${type}:${statement.id ?? statement.worldEventId}`);
  };

  if (targetType && targetId) {
    const table = targetType === 'fact' ? state.facts
      : targetType === 'relationship' ? state.relationships : state.events;
    const statement = table.get(targetId);
    if (!statement) return { problem: `no ${targetType} ${targetId} is stored`, refs: [], targets: [] };
    addStatement(targetType, statement);
  } else if (entityId) {
    const canonical = canonicalId(state, entityId);
    if (canonical === null) return { problem: 'the entity merge chain does not resolve', refs: [], targets: [] };
    const entity = state.entities.get(canonical);
    if (!entity) return { problem: `entity ${entityId} does not exist`, refs: [], targets: [] };
    for (const entry of entity.evidence ?? []) note(entry).from.push(`entity:${entity.id}`);
    for (const fact of state.facts.values()) {
      if (factDirectionOf(state, fact, canonical) === null) continue;
      const retracted = retractionFor(state, 'fact', fact.id);
      addStatement('fact', { ...fact, evidence: [...(fact.evidence ?? []), ...(retracted?.evidence ?? [])] });
    }
    for (const relationship of state.relationships.values()) {
      const subject = canonicalId(state, relationship.subjectId) ?? relationship.subjectId;
      const object = canonicalId(state, relationship.objectId) ?? relationship.objectId;
      if (subject !== canonical && object !== canonical) continue;
      const retracted = retractionFor(state, 'relationship', relationship.id);
      addStatement('relationship', { ...relationship, evidence: [...(relationship.evidence ?? []), ...(retracted?.evidence ?? [])] });
    }
    for (const event of state.events.values()) {
      const participants = event.participants.map((id) => canonicalId(state, id) ?? id);
      const affected = event.affected.map((id) => canonicalId(state, id) ?? id);
      if (!participants.includes(canonical) && !affected.includes(canonical)) continue;
      addStatement('event', event);
    }
  } else {
    return { problem: 'evidence needs an entity or a statement to look up', refs: [], targets: [] };
  }

  const rows = [...refs.values()].sort((a, b) => cmpStr(a.sourceType, b.sourceType)
    || cmpStr(a.sourceId, b.sourceId)
    || cmpStr(a.relation, b.relation));
  const bySourceType = {};
  for (const row of rows) bySourceType[row.sourceType] = (bySourceType[row.sourceType] ?? 0) + 1;
  return { refs: rows, targets, bySourceType, problem: null };
}

// ---- cross-store citations --------------------------------------------------

export const MAX_CITATION_REFS = 100;

function entityCitationStatus(entity) {
  if (entity.status === 'active') return 'supported';
  if (entity.status === 'merged') return 'superseded';
  if (entity.status === 'retired') return 'retracted';
  return String(entity.status ?? 'unknown');
}

function citationRow(state, targetType, statement, { at, conflicts, relation }) {
  let status;
  let label;
  let subjectId = null;
  let predicate = null;
  if (targetType === 'entity') {
    status = entityCitationStatus(statement);
    label = statement.name;
    subjectId = statement.id;
  } else if (targetType === 'fact') {
    const objectName = statement.object.kind === 'entity' ? entityName(state, statement.object.entityId) : null;
    status = statementStatus(state, 'fact', statement.id, { at, conflicts });
    subjectId = canonicalId(state, statement.subjectId) ?? statement.subjectId;
    predicate = statement.predicate;
    label = `${entityName(state, statement.subjectId)} ${statement.predicate} ${objectLabel(statement.object, objectName)}`;
  } else if (targetType === 'relationship') {
    status = statementStatus(state, 'relationship', statement.id, { at, conflicts });
    subjectId = canonicalId(state, statement.subjectId) ?? statement.subjectId;
    predicate = statement.predicate;
    label = `${entityName(state, statement.subjectId)} ${statement.predicate} ${entityName(state, statement.objectId)}`;
  } else {
    status = statementStatus(state, 'event', statement.id, { at, conflicts });
    label = statement.eventType;
  }
  return {
    targetType,
    id: statement.id,
    label,
    subjectId,
    subjectName: subjectId === null ? null : entityName(state, subjectId),
    predicate,
    relation,
    relations: [relation],
    status,
    live: status === 'supported' || status === 'contested' || status === 'conflicting',
    validFrom: statement.validFrom ?? null,
    validUntil: statement.validUntil ?? null,
    occurredAt: statement.occurredAt ?? null,
    recordedAt: statement.recordedAt ?? null,
    evidence: evidenceIds(statement.evidence),
  };
}

// The reverse of evidenceFor: every world record whose stored evidence names one external record
// (a memory or knowledge id, or any other configured source). The index is derived from the log,
// so a citation is a stored fact about the world model rather than a guess from similar wording.
// One index serves every lookup in a read; building it is the only whole-state scan.
export function buildCitationIndex(state, { at = undefined, conflicts = null } = {}) {
  const instant = atFor({ at });
  const scopedConflicts = conflicts ?? computeConflicts(state, { now: instant });
  const index = new Map();
  const add = (targetType, statement) => {
    for (const entry of statement.evidence ?? []) {
      const key = `${entry.sourceType}\u0000${entry.sourceId}`;
      if (!index.has(key)) index.set(key, []);
      const list = index.get(key);
      const existing = list.find((row) => row.targetType === targetType && row.id === statement.id);
      if (existing) {
        if (!existing.relations.includes(entry.relation)) {
          existing.relations.push(entry.relation);
          existing.relations.sort(cmpStr);
        }
        continue;
      }
      list.push(citationRow(state, targetType, statement, { at: instant, conflicts: scopedConflicts, relation: entry.relation }));
    }
  };
  for (const entity of state.entities.values()) add('entity', entity);
  for (const fact of state.facts.values()) add('fact', fact);
  for (const relationship of state.relationships.values()) add('relationship', relationship);
  for (const event of state.events.values()) add('event', event);
  for (const list of index.values()) {
    list.sort((a, b) => cmpStr(a.targetType, b.targetType) || cmpStr(a.id, b.id));
  }
  return index;
}

// Rows are ordered live statements first, then by target type and id, so a bounded answer keeps
// the citations that could still change a belief and reports how many it omitted.
export function statementsCiting(state, {
  sourceType,
  sourceId,
  at = undefined,
  conflicts = null,
  limit = null,
  index = null,
} = {}) {
  const instant = atFor({ at });
  const citationIndex = index ?? buildCitationIndex(state, { at: instant, conflicts });
  const rows = [...(citationIndex.get(`${sourceType}\u0000${sourceId}`) ?? [])]
    .sort((a, b) => (a.live === b.live ? 0 : a.live ? -1 : 1)
      || cmpStr(a.targetType, b.targetType) || cmpStr(a.id, b.id));
  const bounded = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, MAX_CITATION_REFS) : rows.length;
  return {
    rows: rows.slice(0, bounded),
    total: rows.length,
    truncated: rows.length > bounded,
    problem: null,
  };
}

// ---- temporal ---------------------------------------------------------------

// Replays only the records stored at or before `knownAt`. This is the prior-belief view: a
// retraction or supersession recorded later is absent, so the state is what APEX held then. The
// filter is on stored time (record.at), not on valid time; valid time is queried with `asOf`.
export function stateAt(records, knownAt) {
  const cutoff = parseInstant(knownAt);
  if (cutoff === null) return { state: null, problem: `"${knownAt}" is not an ISO date or time` };
  const kept = [];
  let excluded = 0;
  for (const record of records) {
    const at = parseInstant(record?.at);
    if (at !== null && at <= cutoff) kept.push(record);
    else excluded += 1;
  }
  const state = reduceRecords(kept);
  return {
    state,
    cutoff: new Date(cutoff).toISOString(),
    records: kept.length,
    excluded,
    problems: state.problems,
    note: `replayed ${kept.length} record(s) stored at or before ${new Date(cutoff).toISOString()}; ${excluded} later record(s) are not included, so a later retraction, supersession, or merge does not apply`,
  };
}

// Statements that became valid, stopped being valid, were recorded, or were withdrawn inside a
// window. A statement whose validity interval merely surrounds the window is not a change.
export function changesBetween(records, from, to) {
  const start = parseInstant(from);
  const end = parseInstant(to);
  if (start === null || end === null) return { problem: 'both bounds must be ISO dates or times', changes: [] };
  if (start > end) return { problem: 'the start of the window is after its end', changes: [] };
  const inside = (value) => {
    const instant = parseInstant(value);
    return instant !== null && instant >= start && instant <= end;
  };
  const changes = [];
  const push = (kind, record, detail) => {
    changes.push({
      kind,
      at: record.at,
      recordType: record.type,
      id: record.factId ?? record.relationshipId ?? record.worldEventId
        ?? record.entityId ?? record.mergeId ?? record.targetId ?? record.eventId,
      detail,
    });
  };
  const seen = new Set();
  const once = (key, kind, record, detail) => {
    if (seen.has(key)) return;
    seen.add(key);
    push(kind, record, detail);
  };

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (record.type === 'fact_asserted' || record.type === 'relationship_asserted') {
      const id = record.factId ?? record.relationshipId;
      const type = record.type === 'fact_asserted' ? 'fact' : 'relationship';
      if (inside(record.validFrom)) once(`${type}:${id}:start`, 'validity_started', record, `${type} ${id} became valid at ${record.validFrom}`);
      if (inside(record.validUntil)) once(`${type}:${id}:end`, 'validity_ended', record, `${type} ${id} stopped being valid at ${record.validUntil}`);
      if (inside(record.at)) once(`${type}:${id}:recorded`, 'recorded', record, `${type} ${id} was recorded`);
    }
    if (record.type === 'event_recorded') {
      if (inside(record.occurredAt)) once(`event:${record.worldEventId}:occurred`, 'event_occurred', record, `event ${record.worldEventId} happened at ${record.occurredAt}`);
      if (inside(record.observedAt ?? record.at)) once(`event:${record.worldEventId}:learned`, 'event_learned', record, `event ${record.worldEventId} was learned`);
    }
    if (record.type === 'statement_retracted') {
      if (inside(record.at)) once(`${record.targetType}:${record.targetId}:retracted`, 'retracted', record, `${record.targetType} ${record.targetId} was retracted`);
    }
    if (record.type === 'statement_superseded') {
      if (inside(record.at)) once(`${record.targetType}:${record.targetId}:superseded`, 'superseded', record, `${record.targetType} ${record.targetId} was superseded by ${record.byId}`);
    }
    if (['entity_created', 'entity_retired', 'entity_merged', 'entity_merge_undone'].includes(record.type) && inside(record.at)) {
      once(`entity:${record.eventId}`, record.type, record, `${record.type} recorded`);
    }
  }
  changes.sort((a, b) => cmpStr(a.at, b.at) || cmpStr(a.kind, b.kind) || cmpStr(a.id, b.id));
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), changes, problem: null };
}

export function statementHistory(records, targetType, targetId) {
  const rows = records.filter((record) => record && (
    (record.type === 'statement_retracted' || record.type === 'statement_superseded')
    && record.targetType === targetType && (record.targetId === targetId || record.byId === targetId)));
  rows.sort((a, b) => cmpStr(a.at, b.at) || cmpStr(a.eventId, b.eventId));
  return rows.map((record) => ({
    at: record.at,
    eventId: record.eventId,
    kind: record.type,
    targetId: record.targetId,
    byId: record.byId ?? null,
    reason: record.reason,
    evidence: evidenceIds(record.evidence),
  }));
}

export function entityHistory(records, entityId) {
  const rows = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    let relevant = false;
    let summary = '';
    switch (record.type) {
      case 'entity_created':
        relevant = record.entityId === entityId;
        summary = `entity created as ${record.category} "${record.name}"`;
        break;
      case 'entity_alias_added':
        relevant = record.entityId === entityId;
        summary = `alias "${record.alias}" added`;
        break;
      case 'entity_retired':
        relevant = record.entityId === entityId;
        summary = `entity retired: ${record.reason}`;
        break;
      case 'entity_merged':
        relevant = record.fromId === entityId || record.toId === entityId;
        summary = record.fromId === entityId
          ? `merged into ${record.toId}: ${record.reason}`
          : `absorbed ${record.fromId}: ${record.reason}`;
        break;
      case 'entity_merge_undone': {
        relevant = true;
        summary = `merge ${record.mergeId} undone: ${record.reason}`;
        break;
      }
      case 'fact_asserted':
        relevant = record.subjectId === entityId || (record.object?.kind === 'entity' && record.object.entityId === entityId);
        summary = record.subjectId === entityId
          ? `fact ${record.factId}: ${record.predicate} ${objectLabel(record.object, null)}`
          : `incoming fact ${record.factId}: ${record.subjectId} ${record.predicate} this entity`;
        break;
      case 'relationship_asserted':
        relevant = record.subjectId === entityId || record.objectId === entityId;
        summary = `relationship ${record.relationshipId}: ${record.subjectId} ${record.predicate} ${record.objectId}`;
        break;
      case 'event_recorded':
        relevant = [...(record.participants ?? []), ...(record.affected ?? [])].includes(entityId);
        summary = `event ${record.worldEventId} (${record.eventType}) remembered`;
        break;
      case 'statement_retracted':
        relevant = record.targetId === entityId;
        summary = `${record.targetType} ${record.targetId} retracted`;
        break;
      case 'statement_superseded':
        relevant = record.targetId === entityId || record.byId === entityId;
        summary = `${record.targetType} ${record.targetId} superseded by ${record.byId}`;
        break;
      case 'identity_decision':
        relevant = record.leftId === entityId || record.rightId === entityId;
        summary = `identity ${record.decision}: ${record.leftId} and ${record.rightId}`;
        break;
      default:
        break;
    }
    if (!relevant) continue;
    if (record.type === 'entity_merge_undone') {
      const merge = records.find((candidate) => candidate?.type === 'entity_merged' && candidate.mergeId === record.mergeId);
      if (!merge || (merge.fromId !== entityId && merge.toId !== entityId)) continue;
    }
    rows.push({ at: record.at, eventId: record.eventId, type: record.type, summary });
  }
  rows.sort((a, b) => cmpStr(a.at, b.at) || cmpStr(a.eventId, b.eventId));
  return rows.slice(-MAX_HISTORY_ENTRIES);
}

// ---- traversal --------------------------------------------------------------

function traversalEdges(state) {
  const edges = [];
  for (const relationship of state.relationships.values()) {
    if (retractionFor(state, 'relationship', relationship.id) || supersessionFor(state, 'relationship', relationship.id)) continue;
    edges.push({
      kind: 'relationship',
      id: relationship.id,
      subjectId: canonicalId(state, relationship.subjectId) ?? relationship.subjectId,
      objectId: canonicalId(state, relationship.objectId) ?? relationship.objectId,
      predicate: relationship.predicate,
      validFrom: relationship.validFrom,
      validUntil: relationship.validUntil,
      status: 'supported',
    });
  }
  for (const fact of state.facts.values()) {
    if (fact.object.kind !== 'entity') continue;
    if (retractionFor(state, 'fact', fact.id) || supersessionFor(state, 'fact', fact.id)) continue;
    edges.push({
      kind: 'fact',
      id: fact.id,
      subjectId: canonicalId(state, fact.subjectId) ?? fact.subjectId,
      objectId: canonicalId(state, fact.object.entityId) ?? fact.object.entityId,
      predicate: fact.predicate,
      validFrom: fact.validFrom,
      validUntil: fact.validUntil,
      status: 'supported',
    });
  }
  return edges;
}

// Breadth-first traversal with a depth cap, a node cap, and repeated-node detection. Each edge is
// reported once per direction from the node being expanded, so a cycle is shown as a cycle rather
// than expanded forever. Ordering is deterministic: distance, then name, then id.
export function related(state, entityId, options = {}) {
  const resolved = resolveEntityRef(state, entityId);
  if (!resolved.entity) return { start: null, nodes: [], edges: [], cycles: [], problem: resolved.note };
  const depthLimit = Math.max(1, Math.min(Number.isInteger(options.depth) ? options.depth : 1, MAX_RELATED_DEPTH));
  const nodeLimit = Math.max(1, Math.min(Number.isInteger(options.limit) ? options.limit : 20, MAX_RELATED_NODES));
  const asOf = options.asOf ? parseInstant(options.asOf) : null;
  if (options.asOf && asOf === null) return { start: null, nodes: [], edges: [], cycles: [], problem: `"${options.asOf}" is not an ISO date or time` };
  const predicateFilter = options.predicate ? new Set([].concat(options.predicate)) : null;
  const edges = traversalEdges(state).filter((edge) => {
    if (predicateFilter && !predicateFilter.has(edge.predicate)) return false;
    if (asOf !== null) {
      if (edge.validFrom === null) return false;
      return hasValidity({ validFrom: edge.validFrom, validUntil: edge.validUntil }, asOf);
    }
    return true;
  });

  const byNode = new Map();
  for (const edge of edges) {
    if (!byNode.has(edge.subjectId)) byNode.set(edge.subjectId, []);
    byNode.get(edge.subjectId).push({ edge, direction: 'outgoing' });
    if (!byNode.has(edge.objectId)) byNode.set(edge.objectId, []);
    byNode.get(edge.objectId).push({ edge, direction: 'incoming' });
  }
  for (const list of byNode.values()) {
    list.sort((a, b) => cmpStr(a.edge.predicate, b.edge.predicate)
      || cmpStr(a.direction, b.direction)
      || cmpStr(entityName(state, a.direction === 'outgoing' ? a.edge.objectId : a.edge.subjectId),
        entityName(state, b.direction === 'outgoing' ? b.edge.objectId : b.edge.subjectId))
      || cmpStr(a.edge.id, b.edge.id));
  }

  const start = resolved.id;
  const visited = new Map([[start, 0]]);
  const touchedEdges = [];
  const seenEdges = new Set();
  const cycles = [];
  let queue = [start];
  let truncated = false;
  for (let depth = 1; depth <= depthLimit && queue.length > 0; depth += 1) {
    const next = [];
    for (const current of queue) {
      for (const { edge, direction } of byNode.get(current) ?? []) {
        const otherId = direction === 'outgoing' ? edge.objectId : edge.subjectId;
        const edgeKey = `${direction}:${edge.id}:${current}`;
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          touchedEdges.push({
            kind: edge.kind,
            id: edge.id,
            predicate: edge.predicate,
            label: direction === 'outgoing' ? edge.predicate : (relationshipType(edge.predicate).inverse ?? `${edge.predicate} (inverse)`),
            fromId: current,
            fromName: entityName(state, current),
            toId: otherId,
            toName: entityName(state, otherId),
            depth,
            direction,
          });
        }
        if (visited.has(otherId)) {
          if (otherId === current || visited.get(otherId) <= depth) {
            cycles.push({ fromId: current, toId: otherId, kind: edge.kind, id: edge.id, depth });
          }
          continue;
        }
        if (visited.size >= nodeLimit) {
          truncated = true;
          continue;
        }
        visited.set(otherId, depth);
        next.push(otherId);
      }
    }
    queue = next.sort((a, b) => cmpStr(entityName(state, a), entityName(state, b)) || cmpStr(a, b));
  }

  const nodes = [...visited.entries()]
    .map(([id, depth]) => {
      const entity = state.entities.get(id);
      return {
        id,
        name: entity?.name ?? id,
        category: entity?.category ?? null,
        categoryLabel: entity?.category ? categoryLabel(entity.category) : null,
        status: entity?.status ?? 'unknown',
        depth,
      };
    })
    .sort((a, b) => a.depth - b.depth || cmpStr(a.name, b.name) || cmpStr(a.id, b.id));

  return {
    start: { id: start, name: entityName(state, start) },
    depth: depthLimit,
    nodes,
    edges: touchedEdges,
    cycles,
    truncated,
    problem: null,
    note: truncated
      ? `the traversal stopped at ${nodeLimit} nodes; more entities are reachable`
      : 'edges come from recorded relationships and entity-valued facts; only unretracted, unsuperseded records are followed',
  };
}

// ---- live checks used by plan validity ---------------------------------------

// Checks one fact against the live state at `at` (the store's clock by default). `expected`
// compares against the stored scalar or entity label exactly as recorded (normalized for case and
// spacing). A fact whose recorded interval excludes `at` is reported as not current and counts
// neither as support nor as a conflict; a future value is not a present disagreement. A fact with
// no valid-from time has unknown validity and is still a recorded claim, so it counts. A missing
// fact fails the check and says so; it never counts as proof of the opposite.
export function checkFact(state, { entityId, predicate, expected = null, at = undefined } = {}) {
  const resolved = resolveEntityRef(state, entityId);
  if (!resolved.entity) {
    return {
      ok: false, reason: resolved.note, entityId: null, supporting: [], conflicting: [], superseded: [], notCurrent: [],
    };
  }
  const canonical = resolved.id;
  const instant = at === undefined || at === null ? Date.now() : at;
  const all = [...state.facts.values()]
    .filter((fact) => (canonicalId(state, fact.subjectId) ?? fact.subjectId) === canonical && fact.predicate === predicate);
  const supporting = [];
  const conflicting = [];
  const superseded = [];
  const notCurrent = [];
  const expectedKey = expected === null || expected === undefined ? null : scalarKey({ kind: 'string', valueType: 'string', value: String(expected) });
  for (const fact of all) {
    if (retractionFor(state, 'fact', fact.id)) continue;
    if (supersessionFor(state, 'fact', fact.id)) {
      superseded.push({ id: fact.id, value: objectLabel(fact.object, entityName(state, fact.object.entityId)) });
      continue;
    }
    const value = objectLabel(fact.object, fact.object.kind === 'entity' ? entityName(state, fact.object.entityId) : null);
    if (fact.validFrom !== null && !hasValidity(fact, instant)) {
      notCurrent.push({ id: fact.id, value, validFrom: fact.validFrom, validUntil: fact.validUntil });
      continue;
    }
    const key = fact.object.kind === 'entity'
      ? `entity:${canonicalId(state, fact.object.entityId) ?? fact.object.entityId}`
      : scalarKey(fact.object);
    if (expectedKey === null || key === expectedKey) supporting.push({ id: fact.id, value, fact });
    else conflicting.push({ id: fact.id, value, fact });
  }
  if (supporting.length === 0) {
    const outside = notCurrent.length
      ? ` (${notCurrent.length} recorded value(s) are outside their valid time)`
      : '';
    return {
      ok: false,
      reason: `no current ${predicate} fact matches${expected !== null ? ` "${expected}"` : ''}${outside}; a missing fact is not proof of the opposite`,
      entityId: canonical,
      supporting,
      conflicting,
      superseded,
      notCurrent,
    };
  }
  if (conflicting.length > 0) {
    return {
      ok: false,
      reason: `the live state holds ${supporting.length} supporting and ${conflicting.length} conflicting ${predicate} fact(s); the disagreement is not resolved here`,
      entityId: canonical,
      supporting,
      conflicting,
      superseded,
      notCurrent,
    };
  }
  return {
    ok: true, reason: null, entityId: canonical, supporting, conflicting, superseded, notCurrent,
  };
}

export function checkEntity(state, ref) {
  const resolved = resolveEntityRef(state, ref);
  if (!resolved.entity) return { ok: false, reason: resolved.note, resolved };
  return { ok: true, reason: null, resolved };
}
