// World Model record model and reducer. Pure functions only: no I/O, no execution, no model.
//
// The authoritative store is one append-only JSON Lines log (world.jsonl). Every record is a
// user-origin statement or decision; the current world is the result of replaying the log in
// order. Nothing is ever rewritten to make the latest state look consistent, so a retraction,
// a supersession, a merge, and a compensating unmerge all remain visible.
//
// A record is not a belief that APEX verified. It is what the user recorded, with the evidence
// they named. The reducer preserves conflicting records; deciding which side is true is not a
// reducer operation and is never inferred from a source ranking.
import {
  CATEGORY_RE,
  ENTITY_CATEGORIES,
  EVIDENCE_CLASSES,
  EVIDENCE_RELATIONS,
  EVIDENCE_SOURCE_TYPES,
  EXTERNAL_SCHEME_RE,
  ID_RE,
  NAME_RE,
  factPredicate,
  relationshipType,
} from './vocabulary.js';

export const WORLD_SCHEMA = 1;
export const MAX_ENTITY_NAME_CHARS = 200;
export const MAX_ENTITY_DESCRIPTION_CHARS = 1000;
export const MAX_ENTITY_ALIASES = 16;
export const MAX_EXTERNAL_IDS = 8;
export const MAX_EXTERNAL_VALUE_CHARS = 200;
export const MAX_PREDICATE_CHARS = 64;
export const MAX_SCALAR_CHARS = 500;
export const MAX_UNIT_CHARS = 40;
export const MAX_LANGUAGE_CHARS = 24;
export const MAX_EVIDENCE = 8;
export const MAX_EVIDENCE_NOTE_CHARS = 240;
export const MAX_CONFIDENCE_BASIS_CHARS = 200;
export const MAX_REASON_CHARS = 500;
export const MAX_EVENT_PARTICIPANTS = 16;
export const MAX_EVENT_PROPERTIES = 12;
export const MAX_RELATIONSHIP_PROPERTIES = 12;
export const MAX_PROPERTY_VALUE_CHARS = 300;
export const MAX_PROPERTY_JSON_CHARS = 2000;
export const MAX_SUPERSEDES = 8;

export const SCALAR_TYPES = Object.freeze(['string', 'number', 'boolean', 'datetime']);
export const IDENTITY_DECISIONS = Object.freeze(['confirmed', 'rejected']);
export const TARGET_TYPES = Object.freeze(['fact', 'relationship', 'event']);

const RECORD_TYPES = new Set([
  'entity_created', 'entity_alias_added', 'entity_retired', 'entity_merged', 'entity_merge_undone',
  'fact_asserted', 'relationship_asserted', 'event_recorded',
  'statement_retracted', 'statement_superseded', 'identity_decision',
]);

function textProblem(value, max, name, { required = true } = {}) {
  if (value === undefined || value === null) return required ? `${name} is required` : null;
  if (typeof value !== 'string') return `${name} must be text`;
  const text = value.trim();
  if (required && text.length === 0) return `${name} is empty`;
  if (text.length > max) return `${name} exceeds ${max} characters`;
  if (/[\u0000-\u001f\u007f]/.test(text)) return `${name} contains control characters`;
  return null;
}

// A date-only value is midnight UTC. A date-time must carry an explicit zone (`Z` or `±hh:mm`):
// a local-time string would parse differently on two machines, and a stored instant must not
// depend on the reader's time zone.
export function parseInstant(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T00:00:00.000Z`);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function timeProblem(value, name, { nullable = true } = {}) {
  if (value === undefined || value === null) return nullable ? null : `${name} is required`;
  if (typeof value !== 'string' || parseInstant(value) === null) {
    return `${name} must be an ISO date or an ISO date-time with a time zone, such as 2024-05-01 or 2024-05-01T09:00:00Z`;
  }
  return null;
}

function evidenceProblem(entry, i) {
  const label = `evidence ${i + 1}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `${label} is not an object`;
  if (!EVIDENCE_RELATIONS.includes(entry.relation)) return `${label} relation must be one of: ${EVIDENCE_RELATIONS.join(', ')}`;
  if (!EVIDENCE_SOURCE_TYPES.includes(entry.sourceType)) return `${label} source type must be one of: ${EVIDENCE_SOURCE_TYPES.join(', ')}`;
  const idProblem = textProblem(entry.sourceId, 128, `${label} source id`);
  if (idProblem) return idProblem;
  if (entry.sourceType === 'user' && entry.sourceId !== 'user') return `${label} user evidence must name the user`;
  if (entry.note !== undefined && entry.note !== null) {
    const noteProblem = textProblem(entry.note, MAX_EVIDENCE_NOTE_CHARS, `${label} note`, { required: false });
    if (noteProblem) return noteProblem;
  }
  if (entry.classification !== undefined && !EVIDENCE_CLASSES.includes(entry.classification)) {
    return `${label} classification is not recognized`;
  }
  return null;
}

function evidenceListProblem(list, { required = true } = {}) {
  if (list === undefined) return required ? 'at least one evidence reference is required' : null;
  if (!Array.isArray(list)) return 'evidence must be a list';
  if (required && list.length === 0) return 'at least one evidence reference is required';
  if (list.length > MAX_EVIDENCE) return `at most ${MAX_EVIDENCE} evidence references are allowed`;
  for (let i = 0; i < list.length; i += 1) {
    const problem = evidenceProblem(list[i], i);
    if (problem) return problem;
  }
  return null;
}

function propertiesProblem(properties, max, name) {
  if (properties === undefined || properties === null) return null;
  if (typeof properties !== 'object' || Array.isArray(properties)) return `${name} must be an object`;
  const keys = Object.keys(properties);
  if (keys.length > max) return `${name} may have at most ${max} entries`;
  for (const key of keys) {
    if (!NAME_RE.test(key)) return `${name} has an invalid key "${key.slice(0, 40)}"`;
    const value = properties[key];
    const type = typeof value;
    if (value !== null && type !== 'string' && type !== 'number' && type !== 'boolean') {
      return `${name}.${key} must be a string, number, boolean, or null`;
    }
    if (type === 'string' && value.length > MAX_PROPERTY_VALUE_CHARS) return `${name}.${key} exceeds ${MAX_PROPERTY_VALUE_CHARS} characters`;
    if (type === 'number' && !Number.isFinite(value)) return `${name}.${key} must be finite`;
  }
  try {
    if (JSON.stringify(properties).length > MAX_PROPERTY_JSON_CHARS) return `${name} is too large`;
  } catch {
    return `${name} cannot be serialized`;
  }
  return null;
}

function objectProblem(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return 'the fact object is required';
  if (object.kind === 'entity') {
    if (typeof object.entityId !== 'string' || !ID_RE.test(object.entityId)) return 'entity object needs a valid entity id';
    return null;
  }
  if (object.kind !== 'scalar') return 'the fact object kind must be entity or scalar';
  if (!SCALAR_TYPES.includes(object.valueType)) return `scalar value type must be one of: ${SCALAR_TYPES.join(', ')}`;
  const { value } = object;
  if (object.valueType === 'string') {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_SCALAR_CHARS) return 'scalar string value is invalid';
  } else if (object.valueType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'scalar number value is invalid';
  } else if (object.valueType === 'boolean') {
    if (typeof value !== 'boolean') return 'scalar boolean value is invalid';
  } else if (parseInstant(value) === null) {
    return 'scalar datetime value must be an ISO date or time';
  }
  if (object.unit !== undefined && object.unit !== null) {
    const problem = textProblem(object.unit, MAX_UNIT_CHARS, 'unit', { required: false });
    if (problem) return problem;
  }
  if (object.language !== undefined && object.language !== null) {
    if (typeof object.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(object.language)) {
      return 'language must be a language tag such as en or en-GB';
    }
    if (object.language.length > MAX_LANGUAGE_CHARS) return `language exceeds ${MAX_LANGUAGE_CHARS} characters`;
  }
  return null;
}

function idListProblem(list, max, name, { required = false } = {}) {
  if (list === undefined || list === null) return required ? `${name} is required` : null;
  if (!Array.isArray(list)) return `${name} must be a list`;
  if (required && list.length === 0) return `${name} must name at least one entity`;
  if (list.length > max) return `${name} may name at most ${max} entities`;
  const seen = new Set();
  for (const id of list) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return `${name} contains an invalid entity id`;
    if (seen.has(id)) return `${name} names ${id} twice`;
    seen.add(id);
  }
  return null;
}

export function validateWorldRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'not an object';
  if (record.schema !== WORLD_SCHEMA) return 'unsupported schema';
  if (typeof record.eventId !== 'string' || record.eventId.length === 0) return 'missing event id';
  if (!RECORD_TYPES.has(record.type)) return 'unknown event type';
  if (typeof record.at !== 'string' || parseInstant(record.at) === null) return 'bad record timestamp';
  // There is no model-origin write path in this subsystem. A log line claiming another origin
  // is damaged input and is refused rather than interpreted.
  if (record.origin !== 'user') return 'world model records must be user origin';

  if (record.type === 'entity_created') {
    if (typeof record.entityId !== 'string' || !ID_RE.test(record.entityId)) return 'bad entity id';
    if (!ENTITY_CATEGORIES.includes(record.category)) return `category must be one of: ${ENTITY_CATEGORIES.join(', ')}`;
    const nameProblem = textProblem(record.name, MAX_ENTITY_NAME_CHARS, 'name');
    if (nameProblem) return nameProblem;
    if (record.description !== undefined && record.description !== null) {
      const descriptionProblem = textProblem(record.description, MAX_ENTITY_DESCRIPTION_CHARS, 'description', { required: false });
      if (descriptionProblem) return descriptionProblem;
    }
    if (record.aliases !== undefined) {
      if (!Array.isArray(record.aliases)) return 'aliases must be a list';
      if (record.aliases.length > MAX_ENTITY_ALIASES) return `at most ${MAX_ENTITY_ALIASES} aliases are allowed`;
      const seen = new Set();
      for (const alias of record.aliases) {
        const aliasProblem = textProblem(alias, MAX_ENTITY_NAME_CHARS, 'alias');
        if (aliasProblem) return aliasProblem;
        const key = normalizeName(alias);
        if (seen.has(key)) return 'an alias is listed twice';
        seen.add(key);
      }
    }
    if (record.externalIds !== undefined) {
      if (!Array.isArray(record.externalIds)) return 'externalIds must be a list';
      if (record.externalIds.length > MAX_EXTERNAL_IDS) return `at most ${MAX_EXTERNAL_IDS} external ids are allowed`;
      const seen = new Set();
      for (const external of record.externalIds) {
        if (!external || typeof external !== 'object' || Array.isArray(external)) return 'an external id is malformed';
        if (typeof external.scheme !== 'string' || !EXTERNAL_SCHEME_RE.test(external.scheme)) return 'an external id scheme is malformed';
        const valueProblem = textProblem(external.value, MAX_EXTERNAL_VALUE_CHARS, 'external id value');
        if (valueProblem) return valueProblem;
        const key = `${external.scheme}\u0000${normalizeExternal(external.value)}`;
        if (seen.has(key)) return 'an external id is listed twice';
        seen.add(key);
      }
    }
    const timeProblemValue = timeProblem(record.observedAt, 'observedAt');
    if (timeProblemValue) return timeProblemValue;
    return evidenceListProblem(record.evidence);
  }

  if (record.type === 'entity_alias_added') {
    if (typeof record.entityId !== 'string' || !ID_RE.test(record.entityId)) return 'bad entity id';
    const aliasProblem = textProblem(record.alias, MAX_ENTITY_NAME_CHARS, 'alias');
    if (aliasProblem) return aliasProblem;
    return evidenceListProblem(record.evidence);
  }

  if (record.type === 'entity_retired') {
    if (typeof record.entityId !== 'string' || !ID_RE.test(record.entityId)) return 'bad entity id';
    const reasonProblem = textProblem(record.reason, MAX_REASON_CHARS, 'reason');
    if (reasonProblem) return reasonProblem;
    return evidenceListProblem(record.evidence);
  }

  if (record.type === 'entity_merged') {
    if (typeof record.mergeId !== 'string' || !ID_RE.test(record.mergeId)) return 'bad merge id';
    if (typeof record.fromId !== 'string' || !ID_RE.test(record.fromId)) return 'bad source entity id';
    if (typeof record.toId !== 'string' || !ID_RE.test(record.toId)) return 'bad target entity id';
    if (record.fromId === record.toId) return 'an entity cannot be merged into itself';
    const reasonProblem = textProblem(record.reason, MAX_REASON_CHARS, 'reason');
    if (reasonProblem) return reasonProblem;
    return evidenceListProblem(record.evidence);
  }

  if (record.type === 'entity_merge_undone') {
    if (typeof record.mergeId !== 'string' || !ID_RE.test(record.mergeId)) return 'bad merge id';
    const reasonProblem = textProblem(record.reason, MAX_REASON_CHARS, 'reason');
    if (reasonProblem) return reasonProblem;
    return evidenceListProblem(record.evidence);
  }

  if (record.type === 'fact_asserted') {
    if (typeof record.factId !== 'string' || !ID_RE.test(record.factId)) return 'bad fact id';
    if (typeof record.subjectId !== 'string' || !ID_RE.test(record.subjectId)) return 'bad subject entity id';
    if (typeof record.predicate !== 'string' || !NAME_RE.test(record.predicate)) return 'bad predicate';
    const objectShape = objectProblem(record.object);
    if (objectShape) return objectShape;
    const fromProblem = timeProblem(record.validFrom, 'validFrom');
    if (fromProblem) return fromProblem;
    const untilProblem = timeProblem(record.validUntil, 'validUntil');
    if (untilProblem) return untilProblem;
    const observedProblem = timeProblem(record.observedAt, 'observedAt');
    if (observedProblem) return observedProblem;
    if (record.validFrom !== null && record.validUntil !== null
      && parseInstant(record.validUntil) < parseInstant(record.validFrom)) {
      return 'validUntil is before validFrom';
    }
    const evidenceShape = evidenceListProblem(record.evidence);
    if (evidenceShape) return evidenceShape;
    if (record.supersedes !== undefined && record.supersedes !== null) {
      if (!Array.isArray(record.supersedes)) return 'supersedes must be a list';
      if (record.supersedes.length > MAX_SUPERSEDES) return `supersedes may name at most ${MAX_SUPERSEDES} facts`;
      for (const id of record.supersedes) {
        if (typeof id !== 'string' || !ID_RE.test(id)) return 'supersedes contains an invalid fact id';
        if (id === record.factId) return 'a fact cannot supersede itself';
      }
    }
    if (record.confidence !== undefined && record.confidence !== null) {
      if (typeof record.confidence !== 'object' || Array.isArray(record.confidence)) return 'confidence must be an object';
      if (typeof record.confidence.value !== 'number' || !Number.isFinite(record.confidence.value)
        || record.confidence.value < 0 || record.confidence.value > 1) {
        return 'confidence.value must be a number from 0 to 1';
      }
      const basisProblem = textProblem(record.confidence.basis, MAX_CONFIDENCE_BASIS_CHARS, 'confidence basis');
      if (basisProblem) return basisProblem;
    }
    return null;
  }

  if (record.type === 'relationship_asserted') {
    if (typeof record.relationshipId !== 'string' || !ID_RE.test(record.relationshipId)) return 'bad relationship id';
    if (typeof record.subjectId !== 'string' || !ID_RE.test(record.subjectId)) return 'bad subject entity id';
    if (typeof record.objectId !== 'string' || !ID_RE.test(record.objectId)) return 'bad object entity id';
    if (record.subjectId === record.objectId) return 'a relationship cannot point an entity at itself';
    if (typeof record.predicate !== 'string' || !NAME_RE.test(record.predicate)) return 'bad relationship type';
    if (!['directed', 'symmetric'].includes(record.directionality)) return 'directionality must be directed or symmetric';
    const propertiesShape = propertiesProblem(record.properties, MAX_RELATIONSHIP_PROPERTIES, 'properties');
    if (propertiesShape) return propertiesShape;
    const fromProblem = timeProblem(record.validFrom, 'validFrom');
    if (fromProblem) return fromProblem;
    const untilProblem = timeProblem(record.validUntil, 'validUntil');
    if (untilProblem) return untilProblem;
    const observedProblem = timeProblem(record.observedAt, 'observedAt');
    if (observedProblem) return observedProblem;
    if (record.validFrom !== null && record.validUntil !== null
      && parseInstant(record.validUntil) < parseInstant(record.validFrom)) {
      return 'validUntil is before validFrom';
    }
    const evidenceShape = evidenceListProblem(record.evidence);
    if (evidenceShape) return evidenceShape;
    if (record.supersedes !== undefined && record.supersedes !== null) {
      if (!Array.isArray(record.supersedes)) return 'supersedes must be a list';
      if (record.supersedes.length > MAX_SUPERSEDES) return `supersedes may name at most ${MAX_SUPERSEDES} relationships`;
      for (const id of record.supersedes) {
        if (typeof id !== 'string' || !ID_RE.test(id)) return 'supersedes contains an invalid relationship id';
        if (id === record.relationshipId) return 'a relationship cannot supersede itself';
      }
    }
    return null;
  }

  if (record.type === 'event_recorded') {
    if (typeof record.worldEventId !== 'string' || !ID_RE.test(record.worldEventId)) return 'bad event id';
    if (typeof record.eventType !== 'string' || !NAME_RE.test(record.eventType)) return 'bad event type';
    const participantShape = idListProblem(record.participants, MAX_EVENT_PARTICIPANTS, 'participants', { required: true });
    if (participantShape) return participantShape;
    const affectedShape = idListProblem(record.affected, MAX_EVENT_PARTICIPANTS, 'affected');
    if (affectedShape) return affectedShape;
    const occurredProblem = timeProblem(record.occurredAt, 'occurredAt');
    if (occurredProblem) return occurredProblem;
    const observedProblem = timeProblem(record.observedAt, 'observedAt');
    if (observedProblem) return observedProblem;
    // occurredAt and observedAt are independent: a scheduled event can be learned before it
    // happens, and a past event can be learned long after. Neither order is refused here; the
    // query view reports both instants and their order instead of forcing one onto the other.
    const propertiesShape = propertiesProblem(record.properties, MAX_EVENT_PROPERTIES, 'properties');
    if (propertiesShape) return propertiesShape;
    return evidenceListProblem(record.evidence);
  }

  if (record.type === 'statement_retracted') {
    if (!TARGET_TYPES.includes(record.targetType)) return 'targetType must be fact, relationship, or event';
    if (typeof record.targetId !== 'string' || !ID_RE.test(record.targetId)) return 'bad target id';
    const reasonProblem = textProblem(record.reason, MAX_REASON_CHARS, 'reason');
    if (reasonProblem) return reasonProblem;
    return evidenceListProblem(record.evidence);
  }

  if (record.type === 'statement_superseded') {
    if (!TARGET_TYPES.includes(record.targetType)) return 'targetType must be fact, relationship, or event';
    if (typeof record.targetId !== 'string' || !ID_RE.test(record.targetId)) return 'bad target id';
    if (typeof record.byId !== 'string' || !ID_RE.test(record.byId)) return 'bad replacement id';
    if (record.targetId === record.byId) return 'a statement cannot supersede itself';
    const reasonProblem = textProblem(record.reason, MAX_REASON_CHARS, 'reason');
    if (reasonProblem) return reasonProblem;
    return evidenceListProblem(record.evidence);
  }

  if (record.type === 'identity_decision') {
    if (typeof record.leftId !== 'string' || !ID_RE.test(record.leftId)) return 'bad left entity id';
    if (typeof record.rightId !== 'string' || !ID_RE.test(record.rightId)) return 'bad right entity id';
    if (record.leftId === record.rightId) return 'an identity decision needs two different entities';
    if (!IDENTITY_DECISIONS.includes(record.decision)) return 'decision must be confirmed or rejected';
    const reasonProblem = textProblem(record.reason, MAX_REASON_CHARS, 'reason');
    if (reasonProblem) return reasonProblem;
    return evidenceListProblem(record.evidence);
  }

  return 'unknown event type';
}

// ---- normalization ----------------------------------------------------------

export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`([{]+|[\s"'`)\]}.,;:!?]+$/g, '')
    .trim();
}

export function normalizeExternal(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

export function scalarKey(object) {
  if (!object) return 'none';
  if (object.kind === 'entity') return `entity:${object.entityId}`;
  const unit = object.unit ? String(object.unit).toLowerCase() : '';
  const language = object.language ? String(object.language).toLowerCase() : '';
  let value;
  if (object.valueType === 'string') value = normalizeName(object.value);
  else if (object.valueType === 'datetime') value = parseInstant(object.value) ?? String(object.value);
  else value = String(object.value);
  return `scalar:${object.valueType}:${value}:${unit}:${language}`;
}

export function objectLabel(object, entityName = null) {
  if (!object) return 'unknown';
  if (object.kind === 'entity') return entityName ? `${entityName} (${object.entityId})` : object.entityId;
  if (object.valueType === 'datetime') return String(object.value);
  if (object.unit) return `${object.value} ${object.unit}`;
  return String(object.value);
}

// Follows merges to the surviving entity. A cycle is reported rather than guessed: a damaged
// log must not silently resolve to whichever entity happened to be visited first.
export function canonicalId(state, entityId, seen = new Set()) {
  const entity = state.entities.get(entityId);
  if (!entity || entity.status !== 'merged') return entityId;
  if (seen.has(entityId)) return null;
  seen.add(entityId);
  if (!entity.mergedInto) return entityId;
  return canonicalId(state, entity.mergedInto, seen);
}

export function canonicalEntity(state, entityId) {
  const id = canonicalId(state, entityId);
  return id === null ? null : (state.entities.get(id) ?? null);
}

export function createState() {
  return {
    entities: new Map(),
    facts: new Map(),
    relationships: new Map(),
    events: new Map(),
    merges: new Map(),
    identityDecisions: new Map(),
    retractions: [],
    supersessions: [],
    problems: [],
    recordCount: 0,
  };
}

export function identityKey(leftId, rightId) {
  return [leftId, rightId].sort().join('\u0000');
}

export function retractionFor(state, targetType, targetId) {
  return state.retractions.find((r) => r.targetType === targetType && r.targetId === targetId) ?? null;
}

export function supersessionFor(state, targetType, targetId) {
  return state.supersessions.find((r) => r.targetType === targetType && r.targetId === targetId) ?? null;
}

export function latestIdentityDecision(state, leftId, rightId) {
  return state.identityDecisions.get(identityKey(leftId, rightId)) ?? null;
}

function addAlias(entity, alias) {
  const key = normalizeName(alias);
  if (entity.aliases.some((existing) => normalizeName(existing) === key)) return false;
  entity.aliases.push(String(alias).trim());
  return true;
}

function entityProblem(state, id, label) {
  const entity = state.entities.get(id);
  if (!entity) return `${label} entity ${id} does not exist`;
  if (entity.status === 'merged') {
    const target = canonicalId(state, id);
    return `${label} entity ${id} was merged into ${target ?? 'an unknown entity'}; use the surviving entity`;
  }
  if (entity.status !== 'active') return `${label} entity ${id} is ${entity.status}, so no new statement can name it`;
  return null;
}

// Applies one record to `state`. Returns a problem string, or null when applied. On a problem,
// nothing is changed. This is the only place a record becomes derived state.
export function applyRecord(state, record) {
  const shape = validateWorldRecord(record);
  if (shape) return shape;

  if (record.type === 'entity_created') {
    if (state.entities.has(record.entityId)) return 'entity id already exists';
    const aliases = [];
    for (const alias of record.aliases ?? []) {
      if (!aliases.some((a) => normalizeName(a) === normalizeName(alias))) aliases.push(alias.trim());
    }
    state.entities.set(record.entityId, {
      id: record.entityId,
      category: record.category,
      name: record.name.trim(),
      aliases,
      description: record.description?.trim() ?? null,
      externalIds: (record.externalIds ?? []).map((e) => ({ scheme: e.scheme, value: e.value.trim() })),
      status: 'active',
      mergedInto: null,
      mergeId: null,
      mergedFrom: [],
      retiredReason: null,
      evidence: record.evidence,
      observedAt: record.observedAt ?? null,
      createdAt: record.at,
      updatedAt: record.at,
    });
    return null;
  }

  if (record.type === 'entity_alias_added') {
    const entity = state.entities.get(record.entityId);
    if (!entity) return 'unknown entity';
    if (entity.status === 'merged') return `entity was merged into ${canonicalId(state, entity.id)}; add the alias to the surviving entity`;
    if (entity.status !== 'active') return `entity is ${entity.status}; no alias is accepted`;
    if (!addAlias(entity, record.alias)) return 'this alias is already recorded for the entity';
    entity.updatedAt = record.at;
    return null;
  }

  if (record.type === 'entity_retired') {
    const entity = state.entities.get(record.entityId);
    if (!entity) return 'unknown entity';
    if (entity.status !== 'active') return `entity is already ${entity.status}`;
    entity.status = 'retired';
    entity.retiredReason = record.reason;
    entity.updatedAt = record.at;
    return null;
  }

  if (record.type === 'entity_merged') {
    if (state.merges.has(record.mergeId)) return 'merge id already exists';
    const from = state.entities.get(record.fromId);
    const to = state.entities.get(record.toId);
    if (!from) return 'source entity does not exist';
    if (!to) return 'target entity does not exist';
    if (from.status !== 'active') return `source entity is ${from.status}`;
    if (to.status !== 'active') return `target entity is ${to.status}`;
    const fromRoot = canonicalId(state, from.id);
    const toRoot = canonicalId(state, to.id);
    if (fromRoot === null || toRoot === null) return 'an entity merge chain contains a cycle';
    if (fromRoot === toRoot) return 'the entities already resolve to the same entity';
    const preAliases = to.aliases.map(normalizeName);
    const addedAliases = [];
    for (const alias of [from.name, ...from.aliases]) {
      if (!addAlias(to, alias)) continue;
      if (preAliases.includes(normalizeName(alias))) continue;
      addedAliases.push(alias);
    }
    const merge = {
      id: record.mergeId,
      fromId: from.id,
      toId: to.id,
      reason: record.reason,
      evidence: record.evidence,
      addedAliases,
      undoneAt: null,
      at: record.at,
    };
    state.merges.set(merge.id, merge);
    from.status = 'merged';
    from.mergedInto = to.id;
    from.mergeId = merge.id;
    from.updatedAt = record.at;
    to.mergedFrom.push(from.id);
    to.updatedAt = record.at;
    return null;
  }

  if (record.type === 'entity_merge_undone') {
    const merge = state.merges.get(record.mergeId);
    if (!merge) return 'unknown merge';
    if (merge.undoneAt !== null) return 'this merge was already undone';
    const from = state.entities.get(merge.fromId);
    const to = state.entities.get(merge.toId);
    if (!from || !to) return 'a merged entity no longer exists';
    if (from.status !== 'merged' || from.mergeId !== merge.id) {
      return 'the source entity is no longer merged by this merge; a later record changed its identity';
    }
    from.status = 'active';
    from.mergedInto = null;
    from.mergeId = null;
    from.updatedAt = record.at;
    to.mergedFrom = to.mergedFrom.filter((id) => id !== from.id);
    for (const alias of merge.addedAliases ?? []) {
      const key = normalizeName(alias);
      const stillUsed = [...state.entities.values()].some((e) => e.id !== to.id
        && (normalizeName(e.name) === key || e.aliases.some((a) => normalizeName(a) === key)));
      if (!stillUsed) to.aliases = to.aliases.filter((a) => normalizeName(a) !== key);
    }
    to.updatedAt = record.at;
    merge.undoneAt = record.at;
    merge.undoneReason = record.reason;
    return null;
  }

  if (record.type === 'fact_asserted') {
    if (state.facts.has(record.factId)) return 'fact id already exists';
    const subjectProblem = entityProblem(state, record.subjectId, 'subject');
    if (subjectProblem) return subjectProblem;
    if (record.object.kind === 'entity') {
      const objectEntityProblem = entityProblem(state, record.object.entityId, 'object');
      if (objectEntityProblem) return objectEntityProblem;
    }
    const targets = record.supersedes ?? [];
    for (const targetId of targets) {
      const target = state.facts.get(targetId);
      if (!target) return `superseded fact ${targetId} does not exist`;
      if (target.subjectId !== record.subjectId || target.predicate !== record.predicate) {
        return `fact ${targetId} is not about the same subject and predicate`;
      }
      if (retractionFor(state, 'fact', targetId)) return `fact ${targetId} was retracted and cannot be superseded`;
      if (supersessionFor(state, 'fact', targetId)) return `fact ${targetId} is already superseded`;
    }
    state.facts.set(record.factId, {
      id: record.factId,
      subjectId: record.subjectId,
      predicate: record.predicate,
      object: record.object,
      validFrom: record.validFrom ?? null,
      validUntil: record.validUntil ?? null,
      observedAt: record.observedAt ?? null,
      evidence: record.evidence,
      confidence: record.confidence ?? null,
      recordedAt: record.at,
    });
    for (const targetId of targets) {
      state.supersessions.push({
        targetType: 'fact', targetId, byId: record.factId, reason: 'superseded by a later fact', at: record.at,
      });
    }
    return null;
  }

  if (record.type === 'relationship_asserted') {
    if (state.relationships.has(record.relationshipId)) return 'relationship id already exists';
    const subjectProblem = entityProblem(state, record.subjectId, 'subject');
    if (subjectProblem) return subjectProblem;
    const objectProblemValue = entityProblem(state, record.objectId, 'object');
    if (objectProblemValue) return objectProblemValue;
    const targets = record.supersedes ?? [];
    for (const targetId of targets) {
      const target = state.relationships.get(targetId);
      if (!target) return `superseded relationship ${targetId} does not exist`;
      if (retractionFor(state, 'relationship', targetId)) return `relationship ${targetId} was retracted and cannot be superseded`;
      if (supersessionFor(state, 'relationship', targetId)) return `relationship ${targetId} is already superseded`;
    }
    state.relationships.set(record.relationshipId, {
      id: record.relationshipId,
      subjectId: record.subjectId,
      predicate: record.predicate,
      objectId: record.objectId,
      directionality: record.directionality,
      properties: record.properties ?? null,
      validFrom: record.validFrom ?? null,
      validUntil: record.validUntil ?? null,
      observedAt: record.observedAt ?? null,
      evidence: record.evidence,
      recordedAt: record.at,
    });
    for (const targetId of targets) {
      state.supersessions.push({
        targetType: 'relationship', targetId, byId: record.relationshipId, reason: 'superseded by a later relationship', at: record.at,
      });
    }
    return null;
  }

  if (record.type === 'event_recorded') {
    if (state.events.has(record.worldEventId)) return 'world event id already exists';
    for (const id of [...record.participants, ...(record.affected ?? [])]) {
      const problem = entityProblem(state, id, 'event');
      if (problem) return problem;
    }
    state.events.set(record.worldEventId, {
      id: record.worldEventId,
      eventType: record.eventType,
      participants: [...record.participants],
      affected: [...(record.affected ?? [])],
      occurredAt: record.occurredAt ?? null,
      observedAt: record.observedAt ?? null,
      properties: record.properties ?? null,
      evidence: record.evidence,
      recordedAt: record.at,
    });
    return null;
  }

  if (record.type === 'statement_retracted') {
    const table = record.targetType === 'fact' ? state.facts
      : record.targetType === 'relationship' ? state.relationships : state.events;
    if (!table.has(record.targetId)) return `target ${record.targetType} ${record.targetId} does not exist`;
    if (retractionFor(state, record.targetType, record.targetId)) return 'this statement is already retracted';
    state.retractions.push({
      targetType: record.targetType,
      targetId: record.targetId,
      reason: record.reason,
      evidence: record.evidence,
      at: record.at,
    });
    return null;
  }

  if (record.type === 'statement_superseded') {
    const table = record.targetType === 'fact' ? state.facts
      : record.targetType === 'relationship' ? state.relationships : state.events;
    const target = table.get(record.targetId);
    const by = table.get(record.byId);
    if (!target) return `target ${record.targetType} ${record.targetId} does not exist`;
    if (!by) return `replacement ${record.targetType} ${record.byId} does not exist`;
    if (retractionFor(state, record.targetType, record.targetId)) return 'a retracted statement cannot be superseded';
    if (supersessionFor(state, record.targetType, record.targetId)) return 'this statement is already superseded';
    // A supersession chain may be long, but it must not loop.
    let cursor = record.byId;
    const seen = new Set([record.targetId]);
    while (cursor) {
      if (seen.has(cursor)) return 'the supersession chain would contain a cycle';
      seen.add(cursor);
      cursor = supersessionFor(state, record.targetType, cursor)?.byId ?? null;
    }
    state.supersessions.push({
      targetType: record.targetType,
      targetId: record.targetId,
      byId: record.byId,
      reason: record.reason,
      evidence: record.evidence,
      at: record.at,
    });
    return null;
  }

  if (record.type === 'identity_decision') {
    const left = state.entities.get(record.leftId);
    const right = state.entities.get(record.rightId);
    if (!left) return 'left entity does not exist';
    if (!right) return 'right entity does not exist';
    state.identityDecisions.set(identityKey(record.leftId, record.rightId), {
      leftId: record.leftId,
      rightId: record.rightId,
      decision: record.decision,
      reason: record.reason,
      evidence: record.evidence,
      at: record.at,
    });
    return null;
  }

  return 'unknown event type';
}

export function reduceRecords(records) {
  const state = createState();
  records.forEach((record, index) => {
    const problem = applyRecord(state, record);
    state.recordCount = index + 1;
    if (problem) state.problems.push({ index, eventId: record?.eventId ?? null, reason: problem });
  });
  return state;
}

// ---- validity ---------------------------------------------------------------

// Instants are compared as milliseconds so an open interval's `Infinity` cannot be compared
// against an ISO string (a string-to-number comparison yields NaN, which is always false). Every
// caller may pass an ISO string, a Date, or a millisecond count.
function instantMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  const iso = parseInstant(value);
  return iso === null ? null : Date.parse(iso);
}

export function intervalOverlaps(a, b) {
  if (a.validFrom === null || b.validFrom === null) return false;
  const aStart = instantMs(a.validFrom);
  const bStart = instantMs(b.validFrom);
  const aEnd = a.validUntil === null ? Infinity : instantMs(a.validUntil);
  const bEnd = b.validUntil === null ? Infinity : instantMs(b.validUntil);
  if (aStart === null || bStart === null || aEnd === null || bEnd === null) return false;
  return aStart < bEnd && bStart < aEnd;
}

export function hasValidity(statement, at) {
  if (!statement || statement.validFrom === null) return false;
  const start = instantMs(statement.validFrom);
  const end = statement.validUntil === null ? Infinity : instantMs(statement.validUntil);
  const instant = instantMs(at);
  if (start === null || end === null || instant === null) return false;
  return start <= instant && instant < end;
}

export function validityProblem(statement) {
  if (statement.validFrom === null) return 'validity unknown: no valid-from time is recorded, so this statement is not treated as current';
  return null;
}

// A fact or relationship is a candidate for contradiction only when its predicate is declared
// single-valued. An unknown predicate is multi-valued by contract.
export function singleValuedFact(predicate) {
  return factPredicate(predicate).cardinality === 'single';
}

export function singleValuedRelationship(predicate) {
  return relationshipType(predicate).cardinality === 'single';
}
