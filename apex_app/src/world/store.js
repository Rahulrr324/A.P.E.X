// Authoritative World Model store: one append-only JSON Lines log, coordinated writes.
//
// Every record is user origin. The current world is derived by replaying the log; nothing is
// rewritten. A write refuses on a damaged log, validates every named evidence reference against
// the store that owns it, simulates the record on the replayed state, and appends only when the
// simulation succeeds. Reads that present the world are fail-closed; `inspect()` is the one read
// that reports damage instead of refusing, because a diagnostic must be able to say "damaged".
import { randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { WriterLock } from '../memory/writer-lock.js';
import { StoreError, ValidationError } from '../errors.js';
import { maskSecretLeaves } from '../security/secrets.js';
import { singleLine } from '../util.js';
import {
  IDENTITY_DECISIONS,
  TARGET_TYPES,
  WORLD_SCHEMA,
  canonicalId,
  hasValidity,
  normalizeName,
  objectLabel,
  parseInstant,
  reduceRecords,
  retractionFor,
  supersessionFor,
  validateWorldRecord,
  latestIdentityDecision,
} from './model.js';
import { EVIDENCE_RELATIONS, EVIDENCE_SOURCE_TYPES } from './vocabulary.js';
import { computeConflicts, conflictsForEntity } from './conflicts.js';
import { relationshipType } from './vocabulary.js';
import {
  aliasLookup,
  changesBetween,
  checkFact,
  entityHistory,
  entityView,
  evidenceFor,
  factsFor,
  attributesFor,
  eventsFor,
  related,
  relationshipsFor,
  resolveEntityRef,
  stateAt,
  statementHistory,
} from './query.js';
import { identityCandidates, pairAssessment } from './resolution.js';
import { reconstructBelief } from './historical.js';

function requireText(value, name, max = 500) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ValidationError(`${name} is required`);
  const text = value.trim();
  if (text.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  return text;
}

function instantOrNull(value, name) {
  if (value === undefined || value === null) return null;
  const instant = parseInstant(value);
  if (instant === null) throw new ValidationError(`${name} must be an ISO date or an ISO date-time with a time zone`);
  return instant;
}

function idList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be a list`);
  return value.map((entry) => requireText(entry, `${name} entry`, 64));
}

// Evidence source adapters are supplied by the composition root. Each returns
// `{ found, active, state?, classification }`; a missing adapter is a configuration error and a
// lookup failure is a store failure, never "no evidence".
export const EVIDENCE_ADAPTER_TYPES = Object.freeze([...EVIDENCE_SOURCE_TYPES]);

export class WorldModelStore {
  constructor(filePath, {
    now = () => new Date(),
    idFactory = randomUUID,
    sources = {},
    lockWaitMs,
    lockRetryMs,
    lockRetryMaxMs,
  } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.idFactory = idFactory;
    this.sources = sources;
    this.log = new JsonlStore(filePath, { validateRecord: validateWorldRecord });
    this.lock = new WriterLock(filePath, { waitMs: lockWaitMs, retryMs: lockRetryMs, retryMaxMs: lockRetryMaxMs });
  }

  #requireUser(origin) {
    if (origin !== 'user') {
      throw new ValidationError('world model writes require an authorized user-origin operation');
    }
  }

  // ---- integrity ------------------------------------------------------------

  async #readComplete({ beforeAppend = false } = {}) {
    const { records, corrupt } = beforeAppend ? await this.log.loadForAppend() : await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`world model log contains ${corrupt.length} corrupt line(s); refusing incomplete world state`);
    }
    const state = reduceRecords(records);
    if (state.problems.length > 0) {
      throw new StoreError(`world model log contains ${state.problems.length} record(s) that cannot be applied; refusing incomplete world state`);
    }
    return { records, state };
  }

  async load() {
    return this.#readComplete();
  }

  async state() {
    return (await this.#readComplete()).state;
  }

  // The diagnostic read. Corrupt lines and unapplied records are reported, not thrown, so a
  // damaged store is never presented as an empty one. An unreadable file still throws.
  async inspect() {
    const { records, corrupt } = await this.log.load();
    const state = reduceRecords(records);
    const conflicts = computeConflicts(state);
    const active = [...state.entities.values()].filter((entity) => entity.status === 'active');
    return {
      path: this.filePath,
      records: records.length,
      corrupt,
      problems: state.problems,
      complete: corrupt.length === 0 && state.problems.length === 0,
      counts: {
        entities: state.entities.size,
        activeEntities: active.length,
        mergedEntities: [...state.entities.values()].filter((entity) => entity.status === 'merged').length,
        retiredEntities: [...state.entities.values()].filter((entity) => entity.status === 'retired').length,
        facts: state.facts.size,
        relationships: state.relationships.size,
        events: state.events.size,
        merges: state.merges.size,
        identityDecisions: state.identityDecisions.size,
        retractions: state.retractions.length,
        supersessions: state.supersessions.length,
        conflictGroups: conflicts.counts.groups,
      },
      conflicts: conflicts.counts,
    };
  }

  async status() {
    try {
      const inspected = await this.inspect();
      return {
        ...inspected,
        available: true,
        detail: inspected.complete ? null : 'the world model log has damage; reads that present the world are refused',
      };
    } catch (err) {
      return { path: this.filePath, available: false, complete: false, detail: err?.message ?? String(err), counts: null };
    }
  }

  async lockReport() {
    return this.lock.state();
  }

  async recover() {
    return this.lock.recover();
  }

  // ---- evidence -------------------------------------------------------------

  // Validates evidence references without writing. Entries are returned with the classification
  // the owning store justifies; a caller-supplied classification that disagrees is refused.
  async checkEvidence(entries) {
    if (!Array.isArray(entries)) throw new ValidationError('evidence must be a list of references');
    if (entries.length === 0) throw new ValidationError('at least one evidence reference is required');
    const checked = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ValidationError('each evidence reference must be an object');
      }
      if (!EVIDENCE_RELATIONS.includes(entry.relation)) {
        throw new ValidationError(`evidence relation must be one of: ${EVIDENCE_RELATIONS.join(', ')}`);
      }
      if (!EVIDENCE_SOURCE_TYPES.includes(entry.sourceType)) {
        throw new ValidationError(`evidence source type must be one of: ${EVIDENCE_SOURCE_TYPES.join(', ')}`);
      }
      const sourceId = requireText(entry.sourceId, 'evidence source id', 128);

      if (entry.sourceType === 'user') {
        if (sourceId !== 'user') throw new ValidationError('user evidence must name the user, not another record');
        if (entry.classification !== undefined && entry.classification !== 'user_statement') {
          throw new ValidationError('user evidence is classified as a user statement, not as a stored record');
        }
        checked.push({ ...entry, sourceId, classification: 'user_statement' });
        continue;
      }

      const adapter = this.sources[entry.sourceType];
      if (typeof adapter !== 'function') {
        throw new ValidationError(`no ${entry.sourceType} store is available in this configuration, so that evidence reference cannot be verified`);
      }
      let result;
      try {
        result = await adapter(sourceId);
      } catch (err) {
        if (err instanceof StoreError) throw err;
        throw new StoreError(`evidence ${entry.sourceType}:${sourceId} could not be checked: ${err?.message ?? String(err)}`);
      }
      if (!result || result.found !== true) {
        throw new ValidationError(`evidence ${entry.sourceType}:${sourceId} does not exist`);
      }
      if (result.active === false) {
        throw new ValidationError(`evidence ${entry.sourceType}:${sourceId} is ${singleLine(result.state ?? 'not current', 40)} and cannot be cited for a new assertion`);
      }
      if (typeof result.classification !== 'string' || result.classification.length === 0) {
        throw new StoreError(`the ${entry.sourceType} store did not classify evidence ${sourceId}`);
      }
      if (entry.classification !== undefined && entry.classification !== result.classification) {
        throw new ValidationError(`evidence ${entry.sourceType}:${sourceId} is classified as ${result.classification}, not ${singleLine(entry.classification, 40)}`);
      }
      if (entry.sourceType === 'prediction' && entry.relation !== 'qualifies') {
        throw new ValidationError('a prediction is an expectation, not evidence for or against a fact; cite it only as qualifying context');
      }
      checked.push({ ...entry, sourceId, classification: result.classification });
    }
    return checked;
  }

  // The read-side counterpart of checkEvidence: one reference, checked against the store that
  // owns it, reporting what that store says without refusing. A store that cannot be read is
  // reported as unavailable - never as "no such evidence" - and a missing adapter is a
  // configuration difference the caller is told about rather than a silent absence.
  async checkReference(entry) {
    if (!entry || typeof entry !== 'object') throw new ValidationError('an evidence reference must be an object');
    if (!EVIDENCE_SOURCE_TYPES.includes(entry.sourceType)) {
      throw new ValidationError(`evidence source type must be one of: ${EVIDENCE_SOURCE_TYPES.join(', ')}`);
    }
    if (entry.sourceType === 'user') {
      return { check: 'ok', found: true, active: true, state: 'user_statement', classification: 'user_statement', detail: null };
    }
    const sourceId = requireText(entry.sourceId, 'evidence source id', 128);
    const adapter = this.sources[entry.sourceType];
    if (typeof adapter !== 'function') {
      return {
        check: 'no-store',
        found: false,
        active: null,
        state: null,
        classification: null,
        detail: `no ${entry.sourceType} store is configured, so this reference cannot be checked`,
      };
    }
    let result;
    try {
      result = await adapter(sourceId);
    } catch (err) {
      return {
        check: 'unavailable',
        found: null,
        active: null,
        state: null,
        classification: null,
        detail: `${entry.sourceType}:${sourceId} could not be checked: ${err?.message ?? String(err)}`,
      };
    }
    if (!result || result.found !== true) {
      return {
        check: 'ok',
        found: false,
        active: false,
        state: null,
        classification: null,
        detail: `${entry.sourceType}:${sourceId} does not exist in that store`,
      };
    }
    const active = result.active !== false;
    return {
      check: 'ok',
      found: true,
      active,
      state: result.state ?? null,
      classification: result.classification ?? null,
      detail: active
        ? null
        : `${entry.sourceType}:${sourceId} is no longer current (${singleLine(result.state ?? 'not current', 40)})`,
    };
  }

  // ---- mutation -------------------------------------------------------------

  #base(type, fields) {
    const record = {
      schema: WORLD_SCHEMA,
      eventId: this.idFactory(),
      type,
      at: this.now().toISOString(),
      origin: 'user',
      ...fields,
    };
    const shape = validateWorldRecord(record);
    if (shape) throw new ValidationError(shape);
    return record;
  }

  async #mutate(build) {
    return this.lock.run(async () => {
      const { records, state } = await this.#readComplete({ beforeAppend: true });
      const built = build(state);
      const masked = maskSecretLeaves(built);
      const safe = masked.masked > 0 ? { ...masked.value, secretsMasked: true } : masked.value;
      const next = reduceRecords([...records, safe]);
      const refused = next.problems.find((problem) => problem.index === records.length);
      if (refused) throw new ValidationError(`refused: ${refused.reason}`, 'ILLEGAL_TRANSITION');
      await this.log.append(safe);
      return { record: safe, state: next };
    });
  }

  #entityId(state, ref, label = 'entity') {
    const resolved = resolveEntityRef(state, ref);
    if (!resolved.entity) throw new ValidationError(`${label}: ${resolved.note}`);
    return resolved.id;
  }

  #statement(state, targetType, ref) {
    if (!TARGET_TYPES.includes(targetType)) throw new ValidationError(`target type must be one of: ${TARGET_TYPES.join(', ')}`);
    const table = targetType === 'fact' ? state.facts
      : targetType === 'relationship' ? state.relationships : state.events;
    const text = requireText(ref, `${targetType} reference`, 64);
    if (table.has(text)) return table.get(text);
    const matches = [...table.values()].filter((statement) => statement.id.startsWith(text));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new ValidationError(`"${text}" is a prefix of ${matches.length} ${targetType} records; give more characters or the full id`);
    throw new ValidationError(`${targetType} ${text} does not exist`);
  }

  async createEntity({ origin, entityId, category, name, aliases = [], description = null, externalIds = [], observedAt = null, evidence } = {}) {
    this.#requireUser(origin);
    const checked = await this.checkEvidence(evidence);
    const id = entityId === undefined || entityId === null ? this.idFactory() : requireText(entityId, 'entity id', 64);
    return this.#mutate(() => this.#base('entity_created', {
      entityId: id,
      category,
      name,
      aliases: Array.isArray(aliases) ? aliases : [aliases],
      description: description ?? null,
      externalIds,
      observedAt: instantOrNull(observedAt, 'observedAt'),
      evidence: checked,
    }));
  }

  async addAlias({ origin, entityId, alias, evidence } = {}) {
    this.#requireUser(origin);
    const checked = await this.checkEvidence(evidence);
    return this.#mutate((state) => this.#base('entity_alias_added', {
      entityId: this.#entityId(state, entityId),
      alias,
      evidence: checked,
    }));
  }

  async retireEntity({ origin, entityId, reason, evidence } = {}) {
    this.#requireUser(origin);
    const checked = await this.checkEvidence(evidence);
    return this.#mutate((state) => this.#base('entity_retired', {
      entityId: this.#entityId(state, entityId),
      reason,
      evidence: checked,
    }));
  }

  // A merge is accepted only when the pair has a recorded confirmation or a shared trusted
  // external identifier. A similar name is never a merge basis.
  async mergeEntities({ origin, fromId, toId, reason, evidence, mergeId = null } = {}) {
    this.#requireUser(origin);
    const checked = await this.checkEvidence(evidence);
    return this.#mutate((state) => {
      const from = this.#entityId(state, fromId, 'source entity');
      const to = this.#entityId(state, toId, 'target entity');
      const assessment = pairAssessment(state, from, to);
      if (!assessment.allowed) throw new ValidationError(`merge refused: ${assessment.reason}`);
      return this.#base('entity_merged', {
        mergeId: mergeId === null ? this.idFactory() : requireText(mergeId, 'merge id', 64),
        fromId: from,
        toId: to,
        reason,
        evidence: checked,
      });
    });
  }

  async undoMerge({ origin, mergeId, reason, evidence } = {}) {
    this.#requireUser(origin);
    const checked = await this.checkEvidence(evidence);
    return this.#mutate((state) => {
      const text = requireText(mergeId, 'merge reference', 64);
      const matches = [...state.merges.values()].filter((merge) => merge.id === text || merge.id.startsWith(text));
      if (matches.length === 0) throw new ValidationError(`merge ${text} does not exist`);
      if (matches.length > 1) throw new ValidationError(`"${text}" is a prefix of ${matches.length} merges; give more characters or the full id`);
      return this.#base('entity_merge_undone', { mergeId: matches[0].id, reason, evidence: checked });
    });
  }

  async decideIdentity({ origin, leftId, rightId, decision, reason, evidence } = {}) {
    this.#requireUser(origin);
    if (!IDENTITY_DECISIONS.includes(decision)) throw new ValidationError(`decision must be one of: ${IDENTITY_DECISIONS.join(', ')}`);
    const checked = await this.checkEvidence(evidence);
    return this.#mutate((state) => {
      const left = this.#entityId(state, leftId, 'left entity');
      const right = this.#entityId(state, rightId, 'right entity');
      if (left === right) throw new ValidationError('an identity decision needs two different active entities');
      return this.#base('identity_decision', {
        leftId: left,
        rightId: right,
        decision,
        reason,
        evidence: checked,
      });
    });
  }

  async assertFact({
    origin, factId, subjectId, predicate, object, validFrom = null, validUntil = null,
    observedAt = null, confidence = null, supersedes = [], evidence,
  } = {}) {
    this.#requireUser(origin);
    const checked = await this.checkEvidence(evidence);
    return this.#mutate((state) => {
      const subject = this.#entityId(state, subjectId, 'subject entity');
      let normalizedObject = object;
      if (object && object.kind === 'entity') {
        normalizedObject = { kind: 'entity', entityId: this.#entityId(state, object.entityId, 'object entity') };
      }
      return this.#base('fact_asserted', {
        factId: factId === undefined || factId === null ? this.idFactory() : requireText(factId, 'fact id', 64),
        subjectId: subject,
        predicate,
        object: normalizedObject,
        validFrom: instantOrNull(validFrom, 'validFrom'),
        validUntil: instantOrNull(validUntil, 'validUntil'),
        observedAt: instantOrNull(observedAt, 'observedAt'),
        confidence: confidence ?? null,
        supersedes: idList(supersedes, 'supersedes'),
        evidence: checked,
      });
    });
  }

  async assertRelationship({
    origin, relationshipId, subjectId, objectId, predicate, directionality = null,
    properties = null, validFrom = null, validUntil = null, observedAt = null,
    supersedes = [], evidence,
  } = {}) {
    this.#requireUser(origin);
    const checked = await this.checkEvidence(evidence);
    return this.#mutate((state) => {
      const subject = this.#entityId(state, subjectId, 'subject entity');
      const object = this.#entityId(state, objectId, 'object entity');
      if (subject === object) throw new ValidationError('a relationship cannot point an entity at itself');
      const resolvedDirectionality = directionality ?? (relationshipType(predicate).symmetric ? 'symmetric' : 'directed');
      return this.#base('relationship_asserted', {
        relationshipId: relationshipId === undefined || relationshipId === null ? this.idFactory() : requireText(relationshipId, 'relationship id', 64),
        subjectId: subject,
        objectId: object,
        predicate,
        directionality: resolvedDirectionality,
        properties: properties ?? null,
        validFrom: instantOrNull(validFrom, 'validFrom'),
        validUntil: instantOrNull(validUntil, 'validUntil'),
        observedAt: instantOrNull(observedAt, 'observedAt'),
        supersedes: idList(supersedes, 'supersedes'),
        evidence: checked,
      });
    });
  }

  async recordEvent({
    origin, worldEventId, eventType, participants, affected = [], occurredAt = null,
    observedAt = null, properties = null, evidence,
  } = {}) {
    this.#requireUser(origin);
    const checked = await this.checkEvidence(evidence);
    return this.#mutate((state) => this.#base('event_recorded', {
      worldEventId: worldEventId === undefined || worldEventId === null ? this.idFactory() : requireText(worldEventId, 'event id', 64),
      eventType,
      participants: idList(participants, 'participants').map((id) => this.#entityId(state, id, 'participant')),
      affected: idList(affected, 'affected').map((id) => this.#entityId(state, id, 'affected entity')),
      occurredAt: instantOrNull(occurredAt, 'occurredAt'),
      observedAt: instantOrNull(observedAt, 'observedAt'),
      properties: properties ?? null,
      evidence: checked,
    }));
  }

  async retractStatement({ origin, targetType, targetId, reason, evidence } = {}) {
    this.#requireUser(origin);
    const checked = await this.checkEvidence(evidence);
    return this.#mutate((state) => this.#base('statement_retracted', {
      targetType,
      targetId: this.#statement(state, targetType, targetId).id,
      reason,
      evidence: checked,
    }));
  }

  async supersedeStatement({ origin, targetType, targetId, byId, reason, evidence } = {}) {
    this.#requireUser(origin);
    const checked = await this.checkEvidence(evidence);
    return this.#mutate((state) => this.#base('statement_superseded', {
      targetType,
      targetId: this.#statement(state, targetType, targetId).id,
      byId: this.#statement(state, targetType, byId).id,
      reason,
      evidence: checked,
    }));
  }

  // ---- reads ----------------------------------------------------------------

  async listEntities({ limit = 20, includeMerged = false, includeRetired = false } = {}) {
    const { state } = await this.#readComplete();
    const bounded = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 20, 500));
    const rows = [...state.entities.values()]
      .filter((entity) => entity.status === 'active' || (includeMerged && entity.status === 'merged') || (includeRetired && entity.status === 'retired'))
      .sort((a, b) => (a.name.normalize('NFKC').toLowerCase() < b.name.normalize('NFKC').toLowerCase() ? -1
        : a.name.normalize('NFKC').toLowerCase() > b.name.normalize('NFKC').toLowerCase() ? 1
          : (a.id < b.id ? -1 : 1)));
    return {
      entities: rows.slice(0, bounded).map((entity) => ({
        id: entity.id,
        name: entity.name,
        category: entity.category,
        aliases: [...entity.aliases],
        status: entity.status,
        mergedInto: entity.mergedInto,
        createdAt: entity.createdAt,
      })),
      total: rows.length,
      truncated: rows.length > bounded,
    };
  }

  async showEntity(ref, options = {}) {
    const { state, records } = await this.#readComplete();
    const view = entityView(state, ref, options);
    if (view.problem) return view;
    view.history = entityHistory(records, view.entity.id);
    return view;
  }

  async findEntities(text) {
    const { state } = await this.#readComplete();
    return aliasLookup(state, text);
  }

  async facts(ref, options = {}) {
    const { state } = await this.#readComplete();
    return factsFor(state, this.#entityId(state, ref), options);
  }

  async attributes(ref, options = {}) {
    const { state } = await this.#readComplete();
    return attributesFor(state, this.#entityId(state, ref), options);
  }

  async relationships(ref, options = {}) {
    const { state } = await this.#readComplete();
    return relationshipsFor(state, this.#entityId(state, ref), options);
  }

  async events(ref, options = {}) {
    const { state } = await this.#readComplete();
    return eventsFor(state, this.#entityId(state, ref), options);
  }

  async related(ref, options = {}) {
    const { state } = await this.#readComplete();
    return related(state, ref, options);
  }

  async conflicts(options = {}) {
    const { state } = await this.#readComplete();
    const result = computeConflicts(state, { now: options.now ?? this.now().toISOString() });
    if (options.entityId) {
      const canonical = this.#entityId(state, options.entityId);
      return { ...result, groups: conflictsForEntity(state, canonical, result) };
    }
    return result;
  }

  async identityCandidates(ref, options = {}) {
    const { state } = await this.#readComplete();
    return identityCandidates(state, this.#entityId(state, ref), options);
  }

  async pairAssessment(leftRef, rightRef) {
    const { state } = await this.#readComplete();
    return pairAssessment(state, this.#entityId(state, leftRef), this.#entityId(state, rightRef));
  }

  async identityDecision(leftRef, rightRef) {
    const { state } = await this.#readComplete();
    return latestIdentityDecision(state, this.#entityId(state, leftRef), this.#entityId(state, rightRef));
  }

  async evidence(options = {}) {
    const { state } = await this.#readComplete();
    let entityId = null;
    if (options.entityId) entityId = this.#entityId(state, options.entityId);
    return evidenceFor(state, { ...options, entityId });
  }

  async history(ref) {
    const { state, records } = await this.#readComplete();
    const resolved = resolveEntityRef(state, ref);
    if (!resolved.entity) throw new ValidationError(resolved.note);
    return {
      entity: { id: resolved.id, name: resolved.entity.name },
      entries: entityHistory(records, resolved.id),
    };
  }

  async statementHistory(targetType, targetId) {
    const { state, records } = await this.#readComplete();
    const statement = this.#statement(state, targetType, targetId);
    return { statement: { type: targetType, id: statement.id }, entries: statementHistory(records, targetType, statement.id) };
  }

  async changes(from, to) {
    const { records } = await this.#readComplete();
    return changesBetween(records, from, to);
  }

  // A bounded projection of the append-only world log for the executive timeline. Each row is a
  // recorded change with its user origin and cited evidence references; this view does not infer
  // whether the assertion is true or whether it remains current.
  async timeline({ limit = 20 } = {}) {
    const size = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 20;
    const { records } = await this.#readComplete();
    const objectText = (object) => {
      if (!object || typeof object !== 'object') return 'an untyped value';
      if (object.kind === 'entity') return `entity ${object.entityId}`;
      const value = object.valueType === 'datetime' ? object.value : String(object.value ?? '');
      return `${value}${object.unit ? ` ${object.unit}` : ''}`;
    };
    const describe = (record) => {
      switch (record.type) {
        case 'entity_created': return `Created ${record.category} "${record.name}"`;
        case 'entity_alias_added': return `Added alias "${record.alias}" to entity ${record.entityId}`;
        case 'entity_retired': return `Retired entity ${record.entityId}: ${record.reason}`;
        case 'entity_merged': return `Merged entity ${record.fromId} into ${record.toId}: ${record.reason}`;
        case 'entity_merge_undone': return `Undid entity merge ${record.mergeId}: ${record.reason}`;
        case 'identity_decision': return `Recorded identity decision ${record.decision} for ${record.leftId} and ${record.rightId}`;
        case 'fact_asserted': return `Recorded fact ${record.subjectId} ${record.predicate} ${objectText(record.object)}`;
        case 'relationship_asserted': return `Recorded relationship ${record.subjectId} ${record.predicate} ${record.objectId}`;
        case 'event_recorded': return `Recorded world event ${record.eventType}`;
        case 'statement_retracted': return `Retracted ${record.targetType} ${record.targetId}${record.reason ? `: ${record.reason}` : ''}`;
        case 'statement_superseded': return `Superseded ${record.targetType} ${record.targetId} with ${record.byId}${record.reason ? `: ${record.reason}` : ''}`;
        default: return `Recorded world-model change ${record.type}`;
      }
    };
    const items = records.map((record, index) => ({
      id: record.eventId,
      kind: 'world_change',
      at: record.at,
      type: record.type,
      summary: singleLine(describe(record), 360),
      provenance: {
        origin: record.origin ?? null,
        evidence: (Array.isArray(record.evidence) ? record.evidence : []).slice(0, 8).map((entry) => ({
          relation: entry.relation ?? null,
          sourceType: entry.sourceType ?? null,
          sourceId: entry.sourceId ?? null,
          classification: entry.classification ?? null,
        })),
      },
      _index: index,
    })).sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b._index - a._index);
    return {
      items: items.slice(0, size).map(({ _index, ...item }) => item),
      total: items.length,
      truncated: items.length > size,
      limit: size,
    };
  }

  // One file read yields the replayed state, its belief reconstruction, the current state, and the
  // changes recorded since the cutoff. A historical trace needs both views, and reading the log
  // twice would let an append between the reads split the answer across two states. A caller that
  // needs only the past view (`stateAt`) asks for it and skips the second reduction.
  async historicalView(knownAt, { withCurrent = true } = {}) {
    const { records } = await this.#readComplete();
    const replay = stateAt(records, knownAt);
    if (replay.problem) throw new ValidationError(replay.problem);
    const now = this.now().toISOString();
    return {
      ...replay,
      belief: reconstructBelief(replay.state, { at: replay.cutoff }),
      current: withCurrent ? reduceRecords(records) : null,
      // A cutoff at or after the present has no later window. Asking changesBetween for one would
      // report reversed bounds as a problem, when the honest answer is that no change is later.
      later: withCurrent && replay.cutoff <= now ? changesBetween(records, replay.cutoff, now) : null,
    };
  }

  async stateAt(knownAt) {
    const result = await this.historicalView(knownAt, { withCurrent: false });
    return {
      state: result.state,
      cutoff: result.cutoff,
      records: result.records,
      excluded: result.excluded,
      problems: result.problems,
      note: result.note,
      belief: result.belief,
    };
  }

  async checkFact({ entityId, predicate, expected = null, at = undefined } = {}) {
    const { state } = await this.#readComplete();
    return checkFact(state, { entityId, predicate, expected, at: at ?? this.now() });
  }

  // A record written by another path is reported as unverified rather than assumed valid: the
  // action layer uses this after a write to confirm the log holds the id it returned.
  async holds(recordType, id) {
    const { state } = await this.#readComplete();
    const table = recordType === 'fact' ? state.facts
      : recordType === 'relationship' ? state.relationships
        : recordType === 'event' ? state.events
          : recordType === 'entity' ? state.entities
            : null;
    if (!table) return false;
    return table.has(id);
  }

  // A plan can cite one entity or statement as a fact it depends on. This read reports whether
  // the citation still holds. A retracted or superseded statement and a retired or merged entity
  // are named with their reason; a missing record is reported as missing, never as a negative
  // finding about the world. Changing state is reported, never repaired: nothing here writes.
  async checkStatement({ targetType, targetId, expected = null } = {}) {
    const { state } = await this.#readComplete();
    const matches = (wanted, ...candidates) => {
      const key = normalizeName(String(wanted));
      return candidates.some((c) => c !== null && c !== undefined && normalizeName(String(c)) === key);
    };
    if (targetType === 'entity') {
      const resolved = resolveEntityRef(state, targetId);
      if (!resolved.entity) {
        return { ok: false, state: 'missing', value: null, detail: resolved.note ?? `entity ${targetId} does not exist` };
      }
      const entity = resolved.entity;
      if (entity.status === 'retired') {
        return { ok: false, state: 'retired', value: entity.name, detail: `entity ${entity.id} is retired` };
      }
      if (expected !== null && expected !== undefined && !matches(expected, entity.name, entity.id)) {
        return {
          ok: false,
          state: 'changed',
          value: entity.name,
          detail: `the current name is "${singleLine(entity.name, 80)}", not "${singleLine(String(expected), 80)}"`,
        };
      }
      return { ok: true, state: entity.status, value: entity.name, detail: `entity ${entity.id} is ${entity.status}` };
    }

    const table = targetType === 'fact' ? state.facts
      : targetType === 'relationship' ? state.relationships
        : targetType === 'event' ? state.events
          : null;
    if (!table) return { ok: false, state: 'unsupported', value: null, detail: `unsupported statement type ${targetType}` };
    const record = table.get(targetId);
    if (!record) return { ok: false, state: 'missing', value: null, detail: `${targetType} ${targetId} does not exist` };
    const retraction = retractionFor(state, targetType, record.id);
    if (retraction) {
      return {
        ok: false,
        state: 'retracted',
        value: null,
        detail: `${targetType} ${record.id} was retracted${retraction.reason ? `: ${singleLine(retraction.reason, 120)}` : ''}`,
      };
    }
    const supersession = supersessionFor(state, targetType, record.id);
    if (supersession) {
      return {
        ok: false,
        state: 'superseded',
        value: null,
        detail: `${targetType} ${record.id} was superseded by ${supersession.byId ?? 'another record'}`,
      };
    }
    // A citation is live only while the statement's recorded validity includes now. An interval
    // that excludes now is historical; a statement with no valid-from time has unknown validity
    // and is not treated as current. Both fail the citation rather than let a plan rest on an
    // expired or undated claim.
    if (targetType !== 'event') {
      const instant = this.now();
      if (record.validFrom === null || record.validFrom === undefined) {
        return {
          ok: false,
          state: 'validity_unknown',
          value: null,
          detail: `${targetType} ${record.id} has no valid-from time, so it is not treated as current`,
        };
      }
      if (!hasValidity(record, instant)) {
        const until = record.validUntil === null || record.validUntil === undefined ? 'open' : record.validUntil;
        return {
          ok: false,
          state: 'historical',
          value: null,
          detail: `${targetType} ${record.id} is valid ${record.validFrom}..${until}, which does not include the current time`,
        };
      }
    }
    // The value a plan compares against: a fact's object (an entity's current name, or the typed
    // scalar as rendered), a relationship's type, or an event's type.
    const live = targetType === 'fact'
      ? (record.object.kind === 'entity'
        ? (state.entities.get(canonicalId(state, record.object.entityId) ?? record.object.entityId)?.name ?? record.object.entityId)
        : objectLabel(record.object))
      : targetType === 'relationship' ? record.predicate
        : record.eventType;
    const liveIds = targetType === 'fact' && record.object.kind === 'entity' ? [record.object.entityId] : [];
    if (expected !== null && expected !== undefined && !matches(expected, live, ...liveIds)) {
      return {
        ok: false,
        state: 'changed',
        value: live,
        detail: `the current value is "${singleLine(String(live), 80)}", not "${singleLine(String(expected), 80)}"`,
      };
    }
    return { ok: true, state: 'current', value: live, detail: `${targetType} ${record.id} still holds` };
  }
}
