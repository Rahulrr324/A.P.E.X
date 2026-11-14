// World Model actions: the user-facing surface of the world-model store.
//
// Trust boundaries:
//  - every write here is user-origin only and unplannable, so a model can neither create an
//    entity nor assert a fact, a relationship, an event, a retraction, a merge, or an identity
//    decision, and cannot smuggle one into a plan;
//  - every read here is user-origin only as well. A world record can be private, and the model
//    origin has no need to read the store back through an action;
//  - a statement is a record of what the user supplied with the evidence they named. It is not a
//    belief APEX verified, and no action here resolves a disagreement or ranks a source.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, shortId, singleLine } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { ORIGIN_USER } from './origins.js';
import {
  ENTITY_CATEGORIES,
  EVIDENCE_CLASSES,
  EVIDENCE_RELATIONS,
  EVIDENCE_SOURCE_TYPES,
  EXTERNAL_SCHEME_RE,
  ID_RE,
  NAME_RE,
} from '../world/vocabulary.js';
import {
  IDENTITY_DECISIONS,
  MAX_CONFIDENCE_BASIS_CHARS,
  MAX_ENTITY_ALIASES,
  MAX_ENTITY_DESCRIPTION_CHARS,
  MAX_ENTITY_NAME_CHARS,
  MAX_EVENT_PARTICIPANTS,
  MAX_EVIDENCE,
  MAX_EVIDENCE_NOTE_CHARS,
  MAX_EXTERNAL_IDS,
  MAX_EXTERNAL_VALUE_CHARS,
  MAX_LANGUAGE_CHARS,
  MAX_PREDICATE_CHARS,
  MAX_PROPERTY_VALUE_CHARS,
  MAX_PROPERTY_JSON_CHARS,
  MAX_REASON_CHARS,
  MAX_SCALAR_CHARS,
  MAX_SUPERSEDES,
  MAX_UNIT_CHARS,
  SCALAR_TYPES,
  TARGET_TYPES,
  identityKey,
  normalizeName,
  parseInstant,
  timeProblem,
} from '../world/model.js';
import {
  MAX_QUERY_LIMIT,
  MAX_RELATED_DEPTH,
  MAX_RELATED_NODES,
  evidenceFor,
  statementsCiting,
} from '../world/query.js';
import {
  MAX_TRACE_CITATIONS,
  TRACE_TARGET_TYPES,
  traceBelief,
} from '../world/belief-trace.js';
import { relevantChanges } from '../world/historical.js';
import {
  renderAttributes,
  renderCandidates,
  renderChanges,
  renderConflicts,
  renderEntity,
  renderEntityCreated,
  renderEntityList,
  renderEventRecorded,
  renderEvents,
  renderEvidence,
  renderFactRecorded,
  renderFacts,
  renderFind,
  renderHistory,
  renderIdentityDecision,
  renderIdentityDecisionRead,
  renderBeliefTrace,
  renderInspect,
  renderMerge,
  renderPair,
  renderRelated,
  renderRelationshipRecorded,
  renderRelationships,
  renderStateAt,
  renderStatementHistory,
  renderStatementLifecycle,
  renderStatus,
} from '../world/format.js';

const MAX_ENTITY_LIST_LIMIT = 500;

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

function textField(value, name, max) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const text = value.trim();
  if (text.length === 0) throw new ValidationError(`${name} is empty`);
  if (text.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if (CONTROL_CHARS.test(text)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(text)) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  }
  return text;
}

function optionalTextField(value, name, max) {
  if (value === undefined || value === null) return null;
  return textField(value, name, max);
}

function recordRef(value, name) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const ref = value.trim();
  if (ref.length === 0) throw new ValidationError(`${name} is empty`);
  if (ref.length > 64) throw new ValidationError(`${name} is longer than 64 characters`);
  if (CONTROL_CHARS.test(ref)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(ref)) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not used`, 'SECRET_REFUSED');
  }
  return ref;
}

function optionalIdField(value, name) {
  if (value === undefined || value === null) return null;
  const id = recordRef(value, name);
  if (!ID_RE.test(id)) throw new ValidationError(`${name} must be 1-64 letters, digits, or hyphens`);
  return id;
}

function timeField(value, name) {
  if (value === undefined || value === null) return null;
  const problem = timeProblem(value, name);
  if (problem) throw new ValidationError(problem);
  return String(value).trim();
}

function booleanField(value, name, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new ValidationError(`${name} must be true or false`);
  return value;
}

function enumField(value, name, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value.trim())) {
    throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value.trim();
}

function integerField(value, name, { fallback, min, max }) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function stringList(value, name, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be a list`);
  if (value.length > max) throw new ValidationError(`${name} may name at most ${max} entries`);
  return value.map((entry, i) => textField(entry, `${name} entry ${i + 1}`, MAX_ENTITY_NAME_CHARS));
}

function refList(value, name, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${name} is required`);
    return [];
  }
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be a list`);
  if (required && value.length === 0) throw new ValidationError(`${name} must name at least one entity`);
  if (value.length > max) throw new ValidationError(`${name} may name at most ${max} entities`);
  const refs = value.map((entry, i) => recordRef(entry, `${name} entry ${i + 1}`));
  if (new Set(refs).size !== refs.length) throw new ValidationError(`${name} names the same reference twice`);
  return refs;
}

function supersedesField(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('supersedes must be a list');
  if (value.length > MAX_SUPERSEDES) throw new ValidationError(`supersedes may name at most ${MAX_SUPERSEDES} records`);
  return value.map((entry, i) => optionalIdField(entry, `supersedes entry ${i + 1}`));
}

function externalIdsField(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('externalIds must be a list');
  if (value.length > MAX_EXTERNAL_IDS) throw new ValidationError(`externalIds may name at most ${MAX_EXTERNAL_IDS} identifiers`);
  const seen = new Set();
  return value.map((entry, i) => {
    const label = `externalIds entry ${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ValidationError(`${label} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!['scheme', 'value'].includes(key)) throw new ValidationError(`${label} has an unexpected field "${singleLine(key, 40)}"`);
    }
    if (typeof entry.scheme !== 'string' || !EXTERNAL_SCHEME_RE.test(entry.scheme)) {
      throw new ValidationError(`${label} scheme must be lowercase letters, digits, dots, underscores, or hyphens`);
    }
    const externalValue = textField(entry.value, `${label} value`, MAX_EXTERNAL_VALUE_CHARS);
    const key = `${entry.scheme}\u0000${externalValue.normalize('NFKC').toLowerCase()}`;
    if (seen.has(key)) throw new ValidationError(`${label} repeats an earlier identifier`);
    seen.add(key);
    return { scheme: entry.scheme, value: externalValue };
  });
}

function evidenceField(value) {
  if (value === undefined || value === null) throw new ValidationError('at least one evidence reference is required');
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError('at least one evidence reference is required');
  if (value.length > MAX_EVIDENCE) throw new ValidationError(`at most ${MAX_EVIDENCE} evidence references are allowed`);
  return value.map((entry, i) => {
    const label = `evidence ${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ValidationError(`${label} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!['relation', 'sourceType', 'sourceId', 'note', 'classification'].includes(key)) {
        throw new ValidationError(`${label} has an unexpected field "${singleLine(key, 40)}"`);
      }
    }
    if (!EVIDENCE_RELATIONS.includes(entry.relation)) {
      throw new ValidationError(`${label} relation must be one of: ${EVIDENCE_RELATIONS.join(', ')}`);
    }
    if (!EVIDENCE_SOURCE_TYPES.includes(entry.sourceType)) {
      throw new ValidationError(`${label} source type must be one of: ${EVIDENCE_SOURCE_TYPES.join(', ')}`);
    }
    if (typeof entry.sourceId !== 'string' || entry.sourceId.trim().length === 0 || entry.sourceId.length > 128) {
      throw new ValidationError(`${label} source id must be text of 1-128 characters`);
    }
    const sourceId = entry.sourceId.trim();
    if (entry.sourceType === 'user' && sourceId !== 'user') {
      throw new ValidationError(`${label} user evidence must name the user, not another record`);
    }
    const out = { relation: entry.relation, sourceType: entry.sourceType, sourceId };
    if (entry.note !== undefined && entry.note !== null) out.note = textField(entry.note, `${label} note`, MAX_EVIDENCE_NOTE_CHARS);
    if (entry.classification !== undefined && entry.classification !== null) {
      if (!EVIDENCE_CLASSES.includes(entry.classification)) {
        throw new ValidationError(`${label} classification must be one of: ${EVIDENCE_CLASSES.join(', ')}`);
      }
      out.classification = entry.classification;
    }
    return out;
  });
}

function predicateField(value) {
  if (typeof value !== 'string' || !NAME_RE.test(value.trim())) {
    throw new ValidationError(`predicate must be lowercase letters, digits, and underscores, at most ${MAX_PREDICATE_CHARS} characters`);
  }
  return value.trim();
}

function objectField(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('object is required');
  if (value.kind === 'entity') {
    for (const key of Object.keys(value)) {
      if (!['kind', 'entityId'].includes(key)) throw new ValidationError(`entity object has an unexpected field "${singleLine(key, 40)}"`);
    }
    return { kind: 'entity', entityId: recordRef(value.entityId, 'object entity') };
  }
  if (value.kind !== 'scalar') throw new ValidationError('object kind must be entity or scalar');
  for (const key of Object.keys(value)) {
    if (!['kind', 'valueType', 'value', 'unit', 'language'].includes(key)) throw new ValidationError(`scalar object has an unexpected field "${singleLine(key, 40)}"`);
  }
  if (!SCALAR_TYPES.includes(value.valueType)) throw new ValidationError(`scalar value type must be one of: ${SCALAR_TYPES.join(', ')}`);
  let scalar = value.value;
  if (value.valueType === 'string') {
    if (typeof scalar !== 'string' || scalar.trim().length === 0 || scalar.length > MAX_SCALAR_CHARS) {
      throw new ValidationError(`scalar string value must be 1-${MAX_SCALAR_CHARS} characters`);
    }
    scalar = scalar.trim();
    if (containsSecret(scalar)) {
      throw new ValidationError('scalar value looks like a password, key, or token; it was not stored', 'SECRET_REFUSED');
    }
  } else if (value.valueType === 'number') {
    if (typeof scalar !== 'number' || !Number.isFinite(scalar)) throw new ValidationError('scalar number value must be finite');
  } else if (value.valueType === 'boolean') {
    if (typeof scalar !== 'boolean') throw new ValidationError('scalar boolean value must be true or false');
  } else {
    const problem = timeProblem(scalar, 'scalar datetime value');
    if (problem) throw new ValidationError(problem);
    scalar = String(scalar).trim();
  }
  const out = { kind: 'scalar', valueType: value.valueType, value: scalar };
  if (value.unit !== undefined && value.unit !== null) out.unit = textField(value.unit, 'unit', MAX_UNIT_CHARS);
  if (value.language !== undefined && value.language !== null) {
    if (typeof value.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value.language)) {
      throw new ValidationError('language must be a language tag such as en or en-GB');
    }
    if (value.language.length > MAX_LANGUAGE_CHARS) throw new ValidationError(`language exceeds ${MAX_LANGUAGE_CHARS} characters`);
    out.language = value.language;
  }
  return out;
}

function propertiesField(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  const out = {};
  for (const key of Object.keys(value)) {
    if (!NAME_RE.test(key)) throw new ValidationError(`${name} has an invalid key "${singleLine(key, 40)}"`);
    const entry = value[key];
    if (entry !== null && !['string', 'number', 'boolean'].includes(typeof entry)) {
      throw new ValidationError(`${name}.${key} must be a string, number, boolean, or null`);
    }
    if (typeof entry === 'string' && entry.length > MAX_PROPERTY_VALUE_CHARS) {
      throw new ValidationError(`${name}.${key} exceeds ${MAX_PROPERTY_VALUE_CHARS} characters`);
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new ValidationError(`${name}.${key} must be finite`);
    out[key] = entry;
  }
  if (JSON.stringify(out).length > MAX_PROPERTY_JSON_CHARS) throw new ValidationError(`${name} is too large`);
  return out;
}

function confidenceField(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('confidence must be an object');
  for (const key of Object.keys(value)) {
    if (!['value', 'basis'].includes(key)) throw new ValidationError(`confidence has an unexpected field "${singleLine(key, 40)}"`);
  }
  if (typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0 || value.value > 1) {
    throw new ValidationError('confidence.value must be a number from 0 to 1');
  }
  return { value: value.value, basis: textField(value.basis, 'confidence basis', MAX_CONFIDENCE_BASIS_CHARS) };
}

function targetTypeField(value) {
  return enumField(value, 'targetType', TARGET_TYPES);
}

function readAction(name, description, inputHint, validate, execute, verify) {
  return { name, description, inputHint, permission: 'read', origins: [ORIGIN_USER], validate, execute, verify };
}

function writeAction(name, description, inputHint, validate, execute, verify) {
  return { name, description, inputHint, permission: 'write', origins: [ORIGIN_USER], plannable: false, validate, execute, verify };
}

function sameList(left, right) {
  return left.length === right.length && left.every((entry, i) => entry === right[i]);
}

function sameInstant(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left ?? null) === (right ?? null);
  }
  return parseInstant(left) === parseInstant(right);
}

const TRACE_WORLD_TYPES = new Set(['fact', 'relationship', 'event']);

async function memoryTraceTarget(ctx, id, at = null) {
  if (!ctx.memory || typeof ctx.memory.traceMany !== 'function') {
    return { found: false, unavailable: true, detail: 'the memory store is not available in this configuration', complete: false };
  }
  try {
    const rows = await ctx.memory.traceMany([id], at === null ? {} : { at });
    const row = rows.get(id);
    if (!row) return { found: false };
    if (row.found === false) {
      return {
        found: false,
        recordedLater: row.recordedLater === true,
        recordedAt: row.recordedAt ?? null,
        complete: false,
      };
    }
    // The owning store's own lifecycle vocabulary is reported verbatim, so a superseded or
    // model-proposed record is never displayed as a current belief.
    const state = row.status === 'unresolved_conflict' ? 'conflicting' : row.status;
    return {
      found: true,
      label: row.content,
      state,
      conflicted: row.conflict !== null,
      complete: true,
      sameStore: {
        status: row.status,
        replacedBy: [...row.replacedBy],
        conflict: row.conflict,
      },
    };
  } catch (err) {
    return {
      found: false,
      unavailable: true,
      detail: `the memory store could not be read: ${err?.message ?? String(err)}`,
      complete: false,
    };
  }
}

async function knowledgeTraceTarget(ctx, id, at = null) {
  if (!ctx.knowledge || typeof ctx.knowledge.history !== 'function') {
    return { found: false, unavailable: true, detail: 'the knowledge store is not available in this configuration', complete: false };
  }
  try {
    if (at !== null) {
      const rows = await ctx.knowledge.getMany([id], { at });
      const row = rows.get(id);
      if (!row) return { found: false };
      if (row.found === false) {
        return {
          found: false,
          recordedLater: row.recordedLater === true,
          recordedAt: row.recordedAt ?? null,
          complete: false,
        };
      }
      return {
        found: true,
        label: `${row.subject} ${row.relationship} ${row.object}`,
        state: row.lifecycleState ?? row.status ?? 'stored',
        conflicted: (row.conflictsWith ?? []).length > 0,
        complete: true,
        createdAt: row.createdAt ?? null,
        sameStore: {
          lifecycleState: row.lifecycleState ?? null,
          conflictsWith: [...(row.conflictsWith ?? [])],
          conflictState: row.conflictState ?? null,
          resolution: row.resolution ?? null,
          retractedBy: row.retractedBy ?? null,
          supersededBy: [...(row.supersededBy ?? [])],
          problems: [],
        },
      };
    }
    const history = await ctx.knowledge.history(id);
    if (!history?.record) return { found: false };
    const record = history.record;
    return {
      found: true,
      label: `${record.subject} ${record.relationship} ${record.object}`,
      state: record.lifecycleState ?? record.status ?? 'stored',
      conflicted: (record.conflictsWith ?? []).length > 0,
      complete: history.complete !== false,
      createdAt: record.createdAt ?? null,
      sameStore: {
        lifecycleState: record.lifecycleState ?? null,
        conflictsWith: [...(record.conflictsWith ?? [])],
        conflictState: record.conflictState ?? null,
        resolution: record.resolution ?? null,
        retractedBy: record.retractedBy ?? null,
        supersededBy: [...(record.supersededBy ?? [])],
        problems: [...(history.problems ?? [])],
      },
    };
  } catch (err) {
    return {
      found: false,
      unavailable: true,
      detail: `the knowledge store could not be read: ${err?.message ?? String(err)}`,
      complete: false,
    };
  }
}

// One batched read answers every memory and knowledge reference; only the remaining source types
// go through the store's own adapter, once per distinct source. A store that cannot be read is
// reported as unavailable for every reference it owns - never as "no such evidence".
async function traceReferenceStates(ctx, store, state, targetType, targetId, { at = null } = {}) {
  const refs = evidenceFor(state, { targetType, targetId }).refs ?? [];
  const states = new Map();
  const memoryIds = [...new Set(refs.filter((ref) => ref.sourceType === 'memory').map((ref) => ref.sourceId))];
  const knowledgeIds = [...new Set(refs.filter((ref) => ref.sourceType === 'knowledge').map((ref) => ref.sourceId))];
  let memoryRows = null;
  let knowledgeRows = null;
  let memoryError = null;
  let knowledgeError = null;
  if (memoryIds.length > 0) {
    try {
      memoryRows = await ctx.memory.traceMany(memoryIds, at === null ? {} : { at });
    } catch (err) {
      memoryError = err;
    }
  }
  if (knowledgeIds.length > 0) {
    try {
      knowledgeRows = await ctx.knowledge.getMany(knowledgeIds, at === null ? {} : { at });
    } catch (err) {
      knowledgeError = err;
    }
  }
  for (const ref of refs) {
    const key = `${ref.sourceType}:${ref.sourceId}`;
    if (states.has(key)) continue;
    if (ref.sourceType === 'user') {
      states.set(key, {
        check: 'ok', found: true, active: true, state: 'user_statement', classification: 'user_statement', detail: null,
      });
    } else if (ref.sourceType === 'memory') {
      if (memoryError) {
        states.set(key, {
          check: 'unavailable', found: null, active: null, state: null, classification: null,
          detail: `the memory store could not be read: ${memoryError?.message ?? String(memoryError)}`,
        });
      } else {
        const row = memoryRows?.get(ref.sourceId);
        if (!row) {
          states.set(key, {
            check: 'ok', found: false, active: false, state: null, classification: null,
            detail: `memory:${ref.sourceId} does not exist in that store`,
          });
        } else if (row.found === false) {
          states.set(key, {
            check: 'ok', found: false, active: false, state: 'not_yet_recorded', classification: null,
            detail: `memory:${ref.sourceId} was recorded at ${row.recordedAt ?? 'a later time'}, after the cutoff`,
          });
        } else {
          const current = row.replacedBy.length === 0 && row.status !== 'superseded';
          states.set(key, {
            check: 'ok',
            found: true,
            active: current,
            state: row.status,
            classification: row.source === 'model' ? 'model_generated' : 'user_statement',
            detail: row.replacedBy.length > 0 ? `superseded by ${row.replacedBy.map(shortId).join(', ')}` : null,
          });
        }
      }
    } else if (ref.sourceType === 'knowledge') {
      if (knowledgeError) {
        states.set(key, {
          check: 'unavailable', found: null, active: null, state: null, classification: null,
          detail: `the knowledge store could not be read: ${knowledgeError?.message ?? String(knowledgeError)}`,
        });
      } else {
        const row = knowledgeRows?.get(ref.sourceId);
        if (!row) {
          states.set(key, {
            check: 'ok', found: false, active: false, state: null, classification: null,
            detail: `knowledge:${ref.sourceId} does not exist in that store`,
          });
        } else if (row.found === false) {
          states.set(key, {
            check: 'ok', found: false, active: false, state: 'not_yet_recorded', classification: null,
            detail: `knowledge:${ref.sourceId} was recorded at ${row.recordedAt ?? 'a later time'}, after the cutoff`,
          });
        } else {
          const lifecycle = row.lifecycleState ?? row.status ?? null;
          states.set(key, {
            check: 'ok',
            found: true,
            active: row.active === true,
            state: lifecycle,
            classification: row.provenance?.origin === 'model_proposed' ? 'model_generated' : 'recorded_claim',
            detail: row.active === true ? null : `no longer current (${singleLine(lifecycle ?? 'not current', 40)})`,
          });
        }
      }
    } else if (at !== null) {
      // The other source stores keep their own clocks and lifecycles; none exposes a certified
      // historical read. Saying so is honest; reusing its current answer would project a later
      // record back into the past.
      states.set(key, {
        check: 'as_of_unavailable', found: null, active: null, state: null, classification: null,
        detail: `the ${ref.sourceType} store cannot report its standing at ${at}; only its current standing is available, and it is not used here`,
      });
    } else {
      states.set(key, await store.checkReference(ref));
    }
  }
  return states;
}

async function runBeliefTrace(ctx, store, { targetType, targetId, at, limit }) {
  const nowIso = ctx.now().toISOString();
  const historical = at !== null && at !== undefined;
  let state;
  let replay = null;
  if (historical) {
    // One read yields the replayed state and the current state, so an append between two reads
    // cannot split the past view from the present one.
    replay = await store.historicalView(at);
    state = replay.state;
  } else {
    state = await store.state();
  }
  const instant = historical ? replay.cutoff : nowIso;
  let targetState = null;
  let citations = null;
  if (targetType === 'memory') targetState = await memoryTraceTarget(ctx, targetId, historical ? instant : null);
  else if (targetType === 'knowledge') targetState = await knowledgeTraceTarget(ctx, targetId, historical ? instant : null);
  if (targetState !== null) {
    citations = statementsCiting(state, { sourceType: targetType, sourceId: targetId, at: instant, limit });
  }
  const referenceStates = TRACE_WORLD_TYPES.has(targetType)
    ? await traceReferenceStates(ctx, store, state, targetType, targetId, historical ? { at: instant } : {})
    : null;

  // A world statement stored after the cutoff is absent from the replayed state. Name that
  // condition instead of reporting the statement as one that never existed.
  let recordedLater = null;
  if (historical && TRACE_WORLD_TYPES.has(targetType)) {
    const thenTable = targetType === 'fact' ? state.facts
      : targetType === 'relationship' ? state.relationships : state.events;
    const nowTable = targetType === 'fact' ? replay.current.facts
      : targetType === 'relationship' ? replay.current.relationships : replay.current.events;
    const current = nowTable?.get(targetId) ?? null;
    if (current && !thenTable.has(targetId)) recordedLater = { recordedAt: current.recordedAt ?? null };
  }

  const trace = traceBelief(state, {
    targetType, targetId, targetState, at: instant, limit, citations, referenceStates, recordedLater,
  });
  if (!historical) return trace;

  trace.asOf = {
    cutoff: replay.cutoff,
    records: replay.records,
    excluded: replay.excluded,
    problems: replay.problems.length,
  };
  trace.disposition.reason = `as of ${replay.cutoff}: ${trace.disposition.reason}`;
  trace.notes = [
    ...(trace.notes ?? []),
    `this trace replays only records stored at or before ${replay.cutoff}; ${replay.excluded} later record(s) are excluded, so a later correction is not projected back`,
  ];

  // The current view is a second, separate answer from the same read. It is never merged into
  // the historical one: a correction recorded later belongs to "now", not to "then".
  let currentTarget = null;
  if (targetType === 'memory') currentTarget = await memoryTraceTarget(ctx, targetId);
  else if (targetType === 'knowledge') currentTarget = await knowledgeTraceTarget(ctx, targetId);
  const currentCitations = currentTarget !== null
    ? statementsCiting(replay.current, { sourceType: targetType, sourceId: targetId, at: nowIso, limit })
    : null;
  const currentRefs = TRACE_WORLD_TYPES.has(targetType)
    ? await traceReferenceStates(ctx, store, replay.current, targetType, targetId)
    : null;
  const currentTrace = traceBelief(replay.current, {
    targetType,
    targetId,
    targetState: currentTarget,
    at: nowIso,
    limit,
    citations: currentCitations,
    referenceStates: currentRefs,
  });
  trace.current = {
    cutoff: nowIso,
    found: currentTrace.target.found,
    status: currentTrace.target.status,
    disposition: currentTrace.disposition.state,
    reason: currentTrace.disposition.reason,
  };

  const relevantIds = new Set([targetId]);
  for (const row of trace.citations.rows) relevantIds.add(row.id);
  for (const row of currentTrace.citations.rows) relevantIds.add(row.id);
  const later = replay.later === null
    ? { from: replay.cutoff, to: nowIso, changes: [], total: 0, truncated: false, problem: null }
    : relevantChanges(replay.later, [...relevantIds]);
  trace.laterChanges = later;
  later.note = later.problem
    ? later.problem
    : replay.later === null
      ? 'the cutoff is at or after the current time, so no change is recorded later than it'
      : `${later.total} change(s) recorded after the cutoff touch this record or its citations`;
  return trace;
}

function traceData(trace) {
  return {
    target: `${trace.target.type}:${trace.target.id}`,
    found: trace.target.found,
    status: trace.target.status,
    recordedAt: trace.target.recordedAt ?? null,
    validity: trace.target.validity ?? null,
    mode: trace.asOf ? 'historical' : 'current',
    disposition: trace.disposition.state,
    citations: trace.citations.rows.map((row) => `${row.targetType}:${row.id}:${row.relations.join('+')}:${row.status}`),
    citationTotal: trace.citations.total,
    citationTruncated: trace.citations.truncated,
    evidence: trace.evidence.refs.map((ref) => `${ref.relation}:${ref.sourceType}:${ref.sourceId}:${ref.check}:${ref.found}:${ref.active}`),
    evidenceTotal: trace.evidence.total,
    unavailable: trace.references.unavailable,
    complete: trace.complete,
    asOf: trace.asOf ?? null,
    current: trace.current ?? null,
    laterChanges: trace.laterChanges
      ? {
        from: trace.laterChanges.from,
        to: trace.laterChanges.to,
        changes: trace.laterChanges.changes.map((change) => `${change.at}|${change.kind}|${change.id ?? ''}`),
        total: trace.laterChanges.total,
        truncated: trace.laterChanges.truncated,
        note: trace.laterChanges.note ?? null,
      }
      : null,
    authorizes: false,
  };
}

export function worldModelActions(store) {
  if (!store || typeof store.createEntity !== 'function') {
    throw new TypeError('worldModelActions requires a world model store');
  }

  return [
    // ---- entities -----------------------------------------------------------

    writeAction(
      'world.entity.add',
      'Create a world-model entity with a stable id, category, name, and optional aliases, description, and trusted external identifiers. Identity is never inferred from a name. Write: user origin only.',
      '{"category":"person|organization|project|product|place|device|software|document|event|concept|custom","name":"display name","aliases":["optional aliases"],"description":"optional","externalIds":[{"scheme":"trusted-source","value":"id"}],"observedAt":"optional ISO date","evidence":[{"relation":"supports","sourceType":"user","sourceId":"user"}]}',
      (input) => {
        const o = expectObject(input, ['id', 'category', 'name', 'aliases', 'description', 'externalIds', 'observedAt', 'evidence']);
        return {
          id: optionalIdField(o.id, 'entity id'),
          category: enumField(o.category, 'category', ENTITY_CATEGORIES),
          name: textField(o.name, 'name', MAX_ENTITY_NAME_CHARS),
          aliases: stringList(o.aliases, 'aliases', MAX_ENTITY_ALIASES),
          description: optionalTextField(o.description, 'description', MAX_ENTITY_DESCRIPTION_CHARS),
          externalIds: externalIdsField(o.externalIds),
          observedAt: timeField(o.observedAt, 'observedAt'),
          evidence: evidenceField(o.evidence),
        };
      },
      async (_ctx, { id, category, name, aliases, description, externalIds, observedAt, evidence }) => {
        const { record, state } = await store.createEntity({
          origin: ORIGIN_USER, entityId: id, category, name, aliases, description, externalIds, observedAt, evidence,
        });
        const entity = state.entities.get(record.entityId);
        return {
          summary: `created entity ${shortId(record.entityId)} (${record.category}) "${singleLine(record.name, 80)}" with ${entity.aliases.length} alias(es)`,
          data: {
            entityId: record.entityId,
            category: record.category,
            name: entity.name,
            aliases: [...entity.aliases],
            status: entity.status,
          },
          display: renderEntityCreated(record),
        };
      },
      async (_ctx, input, result) => {
        const state = await store.state();
        const entity = state.entities.get(result.data.entityId);
        if (!entity) return { ok: false, detail: 'the created entity cannot be read back' };
        if (entity.name !== result.data.name || entity.category !== result.data.category) {
          return { ok: false, detail: 'the stored name or category differs from the record' };
        }
        if (entity.status !== 'active') return { ok: false, detail: `the new entity is ${entity.status}, not active` };
        if (input.observedAt !== null && !sameInstant(input.observedAt, entity.observedAt)) {
          return { ok: false, detail: 'the stored observation time differs from the one recorded' };
        }
        const storedAliases = new Set(entity.aliases.map(normalizeName));
        if (input.aliases.some((alias) => !storedAliases.has(normalizeName(alias)))) {
          return { ok: false, detail: 'a requested alias is missing from the stored entity' };
        }
        return { ok: true, detail: `entity present as active with ${entity.aliases.length} alias(es) and ${entity.evidence.length} evidence reference(s)` };
      },
    ),

    writeAction(
      'world.entity.alias',
      'Add an alias to an active entity. The alias is kept as another name for the same entity; it is not a merge and grants nothing. Write: user origin only.',
      '{"target":"entity id or unique name","alias":"another name","evidence":[{"relation":"supports","sourceType":"user","sourceId":"user"}]}',
      (input) => {
        const o = expectObject(input, ['target', 'alias', 'evidence']);
        return {
          target: recordRef(o.target, 'target'),
          alias: textField(o.alias, 'alias', MAX_ENTITY_NAME_CHARS),
          evidence: evidenceField(o.evidence),
        };
      },
      async (_ctx, { target, alias, evidence }) => {
        const { record, state } = await store.addAlias({ origin: ORIGIN_USER, entityId: target, alias, evidence });
        const entity = state.entities.get(record.entityId);
        return {
          summary: `alias "${singleLine(alias, 60)}" added to entity ${shortId(record.entityId)}; ${entity.aliases.length} alias(es) recorded`,
          data: { entityId: record.entityId, alias, aliases: [...entity.aliases], status: entity.status },
          display: `Alias "${singleLine(alias, 80)}" added to ${singleLine(entity.name, 80)} (${shortId(entity.id)}). This is another name for the same entity, not a merge.`,
        };
      },
      async (_ctx, input, result) => {
        const state = await store.state();
        const entity = state.entities.get(result.data.entityId);
        if (!entity) return { ok: false, detail: 'the entity cannot be read back' };
        if (!entity.aliases.some((alias) => normalizeName(alias) === normalizeName(input.alias))) {
          return { ok: false, detail: 'the alias is not present on the stored entity' };
        }
        return { ok: true, detail: `alias present; entity ${shortId(entity.id)} remains ${entity.status}` };
      },
    ),

    writeAction(
      'world.entity.retire',
      'Retire an active entity. Its records and history remain stored; no statement can name it afterwards. Write: user origin only.',
      '{"target":"entity id","reason":"why it is retired","evidence":[{"relation":"supports","sourceType":"user","sourceId":"user"}]}',
      (input) => {
        const o = expectObject(input, ['target', 'reason', 'evidence']);
        return {
          target: recordRef(o.target, 'target'),
          reason: textField(o.reason, 'reason', MAX_REASON_CHARS),
          evidence: evidenceField(o.evidence),
        };
      },
      async (_ctx, { target, reason, evidence }) => {
        const { record, state } = await store.retireEntity({ origin: ORIGIN_USER, entityId: target, reason, evidence });
        const entity = state.entities.get(record.entityId);
        return {
          summary: `entity ${shortId(record.entityId)} retired: ${singleLine(reason, 80)}`,
          data: { entityId: record.entityId, status: entity.status, reason },
          display: `Entity ${singleLine(entity.name, 80)} (${shortId(entity.id)}) is retired.\n  reason: ${singleLine(reason, 200)}\nIts facts, relationships, events, and history remain stored and readable.`,
        };
      },
      async (_ctx, input, result) => {
        const state = await store.state();
        const entity = state.entities.get(result.data.entityId);
        if (!entity) return { ok: false, detail: 'the entity cannot be read back' };
        if (entity.status !== 'retired') return { ok: false, detail: `the entity is ${entity.status}, not retired` };
        if (entity.retiredReason !== input.reason) return { ok: false, detail: 'the stored retirement reason differs from the request' };
        return { ok: true, detail: 'entity confirmed retired; its history is preserved' };
      },
    ),

    writeAction(
      'world.entity.merge',
      'Merge one active entity into another. Refused unless the pair has a recorded identity confirmation or a shared trusted external identifier; a similar name is never a merge basis. History and references remain stored. Write: user origin only.',
      '{"from":"source entity id","to":"surviving entity id","reason":"why they are the same","evidence":[{"relation":"supports","sourceType":"user","sourceId":"user"}]}',
      (input) => {
        const o = expectObject(input, ['from', 'to', 'reason', 'mergeId', 'evidence']);
        return {
          from: recordRef(o.from, 'source entity'),
          to: recordRef(o.to, 'target entity'),
          reason: textField(o.reason, 'reason', MAX_REASON_CHARS),
          mergeId: optionalIdField(o.mergeId, 'merge id'),
          evidence: evidenceField(o.evidence),
        };
      },
      async (_ctx, { from, to, reason, mergeId, evidence }) => {
        const { record } = await store.mergeEntities({
          origin: ORIGIN_USER, fromId: from, toId: to, reason, evidence, mergeId,
        });
        return {
          summary: `merged entity ${shortId(record.fromId)} into ${shortId(record.toId)} as merge ${shortId(record.mergeId)}`,
          data: { mergeId: record.mergeId, fromId: record.fromId, toId: record.toId, reason },
          display: renderMerge(record),
        };
      },
      async (_ctx, _input, result) => {
        const state = await store.state();
        const merge = state.merges.get(result.data.mergeId);
        if (!merge) return { ok: false, detail: 'the merge record cannot be read back' };
        if (merge.undoneAt !== null) return { ok: false, detail: 'the merge is recorded as undone' };
        const from = state.entities.get(merge.fromId);
        const to = state.entities.get(merge.toId);
        if (!from || from.status !== 'merged' || from.mergedInto !== merge.toId) {
          return { ok: false, detail: 'the source entity is not merged into the recorded target' };
        }
        if (!to || to.status !== 'active') return { ok: false, detail: 'the target entity is not active' };
        return { ok: true, detail: `merge confirmed; ${shortId(from.id)} resolves to ${shortId(to.id)} and both records remain stored` };
      },
    ),

    writeAction(
      'world.entity.unmerge',
      'Undo a recorded merge with a compensating record. The original merge stays stored and the source entity becomes active again. Write: user origin only.',
      '{"merge":"merge id or unique prefix","reason":"why it is undone","evidence":[{"relation":"supports","sourceType":"user","sourceId":"user"}]}',
      (input) => {
        const o = expectObject(input, ['merge', 'reason', 'evidence']);
        return {
          merge: recordRef(o.merge, 'merge reference'),
          reason: textField(o.reason, 'reason', MAX_REASON_CHARS),
          evidence: evidenceField(o.evidence),
        };
      },
      async (_ctx, { merge, reason, evidence }) => {
        const { record, state } = await store.undoMerge({ origin: ORIGIN_USER, mergeId: merge, reason, evidence });
        const undone = state.merges.get(record.mergeId);
        return {
          summary: `merge ${shortId(record.mergeId)} undone; entity ${shortId(undone.fromId)} is active again`,
          data: { mergeId: record.mergeId, fromId: undone.fromId, toId: undone.toId, reason },
          display: `Merge ${shortId(record.mergeId)} undone: ${shortId(undone.fromId)} and ${shortId(undone.toId)} are separate entities again.\nThe merge record and the undo both remain stored.`,
        };
      },
      async (_ctx, _input, result) => {
        const state = await store.state();
        const merge = state.merges.get(result.data.mergeId);
        if (!merge) return { ok: false, detail: 'the merge record cannot be read back' };
        if (merge.undoneAt === null) return { ok: false, detail: 'the merge is not recorded as undone' };
        const from = state.entities.get(merge.fromId);
        if (!from || from.status !== 'active') return { ok: false, detail: 'the source entity is not active after the undo' };
        return { ok: true, detail: 'merge confirmed undone; both entities and every historical reference remain stored' };
      },
    ),

    readAction(
      'world.entity.list',
      'List recorded entities, sorted by name and id. Merged and retired entities are hidden unless requested. Read-only.',
      '{"limit":20,"includeMerged":false,"includeRetired":false}',
      (input) => {
        const o = expectObject(input, ['limit', 'includeMerged', 'includeRetired']);
        return {
          limit: integerField(o.limit, 'limit', { fallback: 20, min: 1, max: MAX_ENTITY_LIST_LIMIT }),
          includeMerged: booleanField(o.includeMerged, 'includeMerged'),
          includeRetired: booleanField(o.includeRetired, 'includeRetired'),
        };
      },
      async (_ctx, input) => {
        const result = await store.listEntities(input);
        return {
          summary: `listed ${result.entities.length} of ${result.total} entities`,
          data: {
            entityIds: result.entities.map((entity) => entity.id),
            total: result.total,
            truncated: result.truncated,
          },
          display: renderEntityList(result),
        };
      },
      async (_ctx, input, result) => {
        const fresh = await store.listEntities(input);
        if (fresh.total !== result.data.total || fresh.truncated !== result.data.truncated) {
          return { ok: false, detail: 'a second read found a different entity count; the store may have changed during the read' };
        }
        if (!sameList(fresh.entities.map((entity) => entity.id), result.data.entityIds)) {
          return { ok: false, detail: 'a second read found a different entity order or membership' };
        }
        return { ok: true, detail: `entity list confirmed by an independent read; ${fresh.total} record(s)` };
      },
    ),

    readAction(
      'world.entity.show',
      'Show one entity with its facts, relationships, events, disagreements, merge history, identity decisions, and stored history. A name shared by two entities is reported as ambiguous, never resolved by position. Read-only.',
      '{"target":"entity id or unique name","asOf":"optional valid-time instant","at":"optional instant for status","includeRetracted":false,"includeSuperseded":false,"currentOnly":false,"limit":null}',
      (input) => {
        const o = expectObject(input, ['target', 'asOf', 'at', 'includeRetracted', 'includeSuperseded', 'currentOnly', 'limit']);
        return {
          target: recordRef(o.target, 'target'),
          asOf: timeField(o.asOf, 'asOf'),
          at: timeField(o.at, 'at'),
          includeRetracted: booleanField(o.includeRetracted, 'includeRetracted'),
          includeSuperseded: booleanField(o.includeSuperseded, 'includeSuperseded'),
          currentOnly: booleanField(o.currentOnly, 'currentOnly'),
          limit: integerField(o.limit, 'limit', { fallback: null, min: 1, max: MAX_QUERY_LIMIT }),
        };
      },
      async (_ctx, input) => {
        const view = await store.showEntity(input.target, input);
        if (view.problem) {
          return {
            summary: `entity "${singleLine(input.target, 60)}" could not be shown: ${view.problem}`,
            data: { found: false, target: input.target, problem: view.problem },
            display: renderEntity(view),
          };
        }
        return {
          summary: `entity ${shortId(view.entity.id)} "${singleLine(view.entity.name, 60)}": ${view.counts.outgoingFacts} outgoing fact(s), ${view.counts.incomingFacts} incoming, ${view.counts.relationships} relationship(s), ${view.counts.events} event(s), ${view.counts.conflictGroups} disagreement group(s)`,
          data: {
            found: true,
            entityId: view.entity.id,
            name: view.entity.name,
            status: view.entity.status,
            factIds: view.facts.map((fact) => fact.id),
            relationshipIds: view.relationships.map((relationship) => relationship.id),
            eventIds: view.events.map((event) => event.id),
            conflictGroups: view.conflicts.length,
            resolvedNote: view.resolved?.note ?? null,
          },
          display: renderEntity(view),
        };
      },
      async (_ctx, input, result) => {
        const fresh = await store.showEntity(input.target, input);
        if (result.data.found === false) {
          return fresh.problem ? { ok: true, detail: `confirmed unreadable entity: ${fresh.problem}` } : { ok: false, detail: 'a second read resolved the entity that the first could not' };
        }
        if (fresh.problem) return { ok: false, detail: `a second read failed: ${fresh.problem}` };
        if (fresh.entity.id !== result.data.entityId) return { ok: false, detail: 'a second read resolved a different entity' };
        if (!sameList(fresh.facts.map((fact) => fact.id), result.data.factIds)) {
          return { ok: false, detail: 'a second read found a different fact set' };
        }
        if (!sameList(fresh.relationships.map((relationship) => relationship.id), result.data.relationshipIds)) {
          return { ok: false, detail: 'a second read found a different relationship set' };
        }
        if (!sameList(fresh.events.map((event) => event.id), result.data.eventIds)) {
          return { ok: false, detail: 'a second read found a different event set' };
        }
        return { ok: true, detail: `entity view confirmed by an independent read; ${fresh.counts.outgoingFacts + fresh.counts.incomingFacts} fact(s), ${fresh.counts.relationships} relationship(s), ${fresh.counts.events} event(s)` };
      },
    ),

    readAction(
      'world.entity.find',
      'Find active entities by exact normalized name or alias. Every match is returned; a shared name is not identity. Read-only.',
      '{"text":"name or alias"}',
      (input) => {
        const o = expectObject(input, ['text']);
        return { text: textField(o.text, 'text', MAX_ENTITY_NAME_CHARS) };
      },
      async (_ctx, { text }) => {
        const result = await store.findEntities(text);
        return {
          summary: `${result.matches.length} active entity match(es) for "${singleLine(text, 60)}"`,
          data: { text, matches: result.matches.map((match) => ({ id: match.id, matchedOn: match.matchedOn })) },
          display: renderFind(result),
        };
      },
      async (_ctx, { text }, result) => {
        const fresh = await store.findEntities(text);
        if (fresh.matches.length !== result.data.matches.length
          || fresh.matches.some((match, i) => match.id !== result.data.matches[i].id || match.matchedOn !== result.data.matches[i].matchedOn)) {
          return { ok: false, detail: 'a second lookup found a different set of matches' };
        }
        return { ok: true, detail: `${fresh.matches.length} match(es) confirmed; no identity was inferred` };
      },
    ),

    // ---- facts, attributes, relationships, events ---------------------------

    writeAction(
      'world.fact.add',
      'Record a subject-predicate-object fact with validity, observation time, and evidence. The object is an entity reference or a typed scalar. A missing valid-from time means validity is unknown, not current. Write: user origin only.',
      '{"subject":"entity id","predicate":"has_status","object":{"kind":"scalar","valueType":"string","value":"active"},"validFrom":"ISO date","validUntil":"optional","observedAt":"optional","confidence":{"value":0.8,"basis":"why"},"supersedes":["optional fact ids"]}',
      (input) => {
        const o = expectObject(input, ['id', 'subject', 'predicate', 'object', 'validFrom', 'validUntil', 'observedAt', 'confidence', 'supersedes', 'evidence']);
        return {
          id: optionalIdField(o.id, 'fact id'),
          subject: recordRef(o.subject, 'subject'),
          predicate: predicateField(o.predicate),
          object: objectField(o.object),
          validFrom: timeField(o.validFrom, 'validFrom'),
          validUntil: timeField(o.validUntil, 'validUntil'),
          observedAt: timeField(o.observedAt, 'observedAt'),
          confidence: confidenceField(o.confidence),
          supersedes: supersedesField(o.supersedes),
          evidence: evidenceField(o.evidence),
        };
      },
      async (_ctx, { id, subject, predicate, object, validFrom, validUntil, observedAt, confidence, supersedes, evidence }) => {
        const { record } = await store.assertFact({
          origin: ORIGIN_USER, factId: id, subjectId: subject, predicate, object,
          validFrom, validUntil, observedAt, confidence, supersedes, evidence,
        });
        return {
          summary: `recorded fact ${shortId(record.factId)}: ${record.subjectId} ${record.predicate}`,
          data: {
            factId: record.factId,
            subjectId: record.subjectId,
            predicate: record.predicate,
            object: record.object,
            validFrom: record.validFrom,
            validUntil: record.validUntil,
            observedAt: record.observedAt,
          },
          display: renderFactRecorded(record),
        };
      },
      async (_ctx, input, result) => {
        const state = await store.state();
        const fact = state.facts.get(result.data.factId);
        if (!fact) return { ok: false, detail: 'the recorded fact cannot be read back' };
        if (fact.subjectId !== result.data.subjectId || fact.predicate !== input.predicate) {
          return { ok: false, detail: 'the stored subject or predicate differs from the record' };
        }
        if (JSON.stringify(fact.object) !== JSON.stringify(result.data.object)) {
          return { ok: false, detail: 'the stored object differs from the record' };
        }
        if (!sameInstant(input.validFrom, fact.validFrom) || !sameInstant(input.validUntil, fact.validUntil)) {
          return { ok: false, detail: 'the stored validity interval differs from the request' };
        }
        return { ok: true, detail: `fact present with ${fact.evidence.length} evidence reference(s); retraction and supersession are not applied by this check` };
      },
    ),

    writeAction(
      'world.relationship.add',
      'Record a directed or symmetric relationship between two entities, with optional properties, validity, and evidence. An entity cannot point at itself. Write: user origin only.',
      '{"subject":"entity id","relation":"employed_by","object":"entity id","directionality":"directed|symmetric","properties":{"role":"engineer"},"validFrom":"ISO date","validUntil":"optional","observedAt":"optional","supersedes":["optional relationship ids"]}',
      (input) => {
        const o = expectObject(input, ['id', 'subject', 'relation', 'predicate', 'object', 'directionality', 'properties', 'validFrom', 'validUntil', 'observedAt', 'supersedes', 'evidence']);
        if (o.relation !== undefined && o.predicate !== undefined) {
          throw new ValidationError('give the relationship type as either "relation" or "predicate", not both');
        }
        const relation = o.predicate ?? o.relation;
        let directionality = null;
        if (o.directionality !== undefined && o.directionality !== null) {
          directionality = enumField(o.directionality, 'directionality', ['directed', 'symmetric']);
        }
        return {
          id: optionalIdField(o.id, 'relationship id'),
          subject: recordRef(o.subject, 'subject'),
          relation: predicateField(relation),
          object: recordRef(o.object, 'object'),
          directionality,
          properties: propertiesField(o.properties, 'properties'),
          validFrom: timeField(o.validFrom, 'validFrom'),
          validUntil: timeField(o.validUntil, 'validUntil'),
          observedAt: timeField(o.observedAt, 'observedAt'),
          supersedes: supersedesField(o.supersedes),
          evidence: evidenceField(o.evidence),
        };
      },
      async (_ctx, { id, subject, relation, object, directionality, properties, validFrom, validUntil, observedAt, supersedes, evidence }) => {
        const { record } = await store.assertRelationship({
          origin: ORIGIN_USER, relationshipId: id, subjectId: subject, objectId: object, predicate: relation,
          directionality, properties, validFrom, validUntil, observedAt, supersedes, evidence,
        });
        return {
          summary: `recorded relationship ${shortId(record.relationshipId)}: ${record.subjectId} ${record.predicate} ${record.objectId}`,
          data: {
            relationshipId: record.relationshipId,
            subjectId: record.subjectId,
            objectId: record.objectId,
            predicate: record.predicate,
            directionality: record.directionality,
          },
          display: renderRelationshipRecorded(record),
        };
      },
      async (_ctx, input, result) => {
        const state = await store.state();
        const relationship = state.relationships.get(result.data.relationshipId);
        if (!relationship) return { ok: false, detail: 'the recorded relationship cannot be read back' };
        if (relationship.subjectId !== result.data.subjectId
          || relationship.objectId !== result.data.objectId
          || relationship.predicate !== input.relation) {
          return { ok: false, detail: 'the stored endpoints or relationship type differ from the record' };
        }
        if (relationship.subjectId === relationship.objectId) return { ok: false, detail: 'the stored relationship points an entity at itself' };
        return { ok: true, detail: `relationship present as ${relationship.directionality} with ${relationship.evidence.length} evidence reference(s)` };
      },
    ),

    writeAction(
      'world.event.add',
      'Record an event with participants, optionally affected entities, structured properties, occurred-at, and learned-at times. Stored time is recorded separately. Write: user origin only.',
      '{"eventType":"met","participants":["entity ids"],"affected":["optional entity ids"],"occurredAt":"ISO date","observedAt":"optional ISO date","properties":{"place":"office"}}',
      (input) => {
        const o = expectObject(input, ['id', 'eventType', 'participants', 'affected', 'occurredAt', 'observedAt', 'properties', 'evidence']);
        return {
          id: optionalIdField(o.id, 'event id'),
          eventType: predicateField(o.eventType),
          participants: refList(o.participants, 'participants', MAX_EVENT_PARTICIPANTS, { required: true }),
          affected: refList(o.affected, 'affected', MAX_EVENT_PARTICIPANTS),
          occurredAt: timeField(o.occurredAt, 'occurredAt'),
          observedAt: timeField(o.observedAt, 'observedAt'),
          properties: propertiesField(o.properties, 'properties'),
          evidence: evidenceField(o.evidence),
        };
      },
      async (_ctx, { id, eventType, participants, affected, occurredAt, observedAt, properties, evidence }) => {
        const { record } = await store.recordEvent({
          origin: ORIGIN_USER, worldEventId: id, eventType, participants, affected,
          occurredAt, observedAt, properties, evidence,
        });
        return {
          summary: `recorded event ${shortId(record.worldEventId)} (${record.eventType}) with ${record.participants.length} participant(s)`,
          data: {
            eventId: record.worldEventId,
            eventType: record.eventType,
            participants: record.participants,
            affected: record.affected,
            occurredAt: record.occurredAt,
            observedAt: record.observedAt,
          },
          display: renderEventRecorded(record),
        };
      },
      async (_ctx, input, result) => {
        const state = await store.state();
        const event = state.events.get(result.data.eventId);
        if (!event) return { ok: false, detail: 'the recorded event cannot be read back' };
        if (event.eventType !== input.eventType) return { ok: false, detail: 'the stored event type differs from the record' };
        if (!sameList(event.participants, result.data.participants)) return { ok: false, detail: 'the stored participants differ from the record' };
        if (!sameList(event.affected, result.data.affected)) return { ok: false, detail: 'the stored affected entities differ from the record' };
        return { ok: true, detail: 'event present with its participants, times, and evidence; happened-at and learned-at remain separate' };
      },
    ),

    readAction(
      'world.facts',
      'List facts about an entity, including incoming entity-valued facts, with status, validity, observation time, and evidence. Read-only.',
      '{"target":"entity id","asOf":"optional valid-time instant","at":"optional instant for status","currentOnly":false,"includeRetracted":false,"includeSuperseded":false,"limit":null}',
      (input) => {
        const o = expectObject(input, ['target', 'asOf', 'at', 'currentOnly', 'includeRetracted', 'includeSuperseded', 'limit']);
        return {
          target: recordRef(o.target, 'target'),
          asOf: timeField(o.asOf, 'asOf'),
          at: timeField(o.at, 'at'),
          currentOnly: booleanField(o.currentOnly, 'currentOnly'),
          includeRetracted: booleanField(o.includeRetracted, 'includeRetracted'),
          includeSuperseded: booleanField(o.includeSuperseded, 'includeSuperseded'),
          limit: integerField(o.limit, 'limit', { fallback: null, min: 1, max: MAX_QUERY_LIMIT }),
        };
      },
      async (_ctx, input) => {
        const result = await store.facts(input.target, input);
        return {
          summary: `${result.facts?.length ?? 0} fact(s) about ${singleLine(result.entityName ?? input.target, 60)}${result.problem ? `: ${result.problem}` : ''}`,
          data: { entityId: result.entityId ?? null, factIds: (result.facts ?? []).map((fact) => fact.id), problem: result.problem ?? null },
          display: renderFacts(result),
        };
      },
      async (_ctx, input, result) => {
        const fresh = await store.facts(input.target, input);
        if ((fresh.problem ?? null) !== result.data.problem) return { ok: false, detail: 'a second read reported a different problem' };
        if (!sameList((fresh.facts ?? []).map((fact) => fact.id), result.data.factIds)) {
          return { ok: false, detail: 'a second read found a different fact set' };
        }
        return { ok: true, detail: `${(fresh.facts ?? []).length} fact(s) confirmed by an independent read` };
      },
    ),

    readAction(
      'world.attributes',
      'Show the currently valid attributes of an entity, grouped by predicate. An absent attribute is absent, not false. Read-only.',
      '{"target":"entity id","asOf":"optional valid-time instant","at":"optional instant for status"}',
      (input) => {
        const o = expectObject(input, ['target', 'asOf', 'at']);
        return {
          target: recordRef(o.target, 'target'),
          asOf: timeField(o.asOf, 'asOf'),
          at: timeField(o.at, 'at'),
        };
      },
      async (_ctx, input) => {
        const result = await store.attributes(input.target, input);
        const predicates = Object.keys(result.attributes ?? {});
        return {
          summary: `${predicates.length} current attribute predicate(s) for ${singleLine(result.entityName ?? input.target, 60)}${result.problem ? `: ${result.problem}` : ''}`,
          data: {
            entityId: result.entityId ?? null,
            predicates,
            factIds: predicates.flatMap((predicate) => result.attributes[predicate].map((fact) => fact.id)),
            problem: result.problem ?? null,
          },
          display: renderAttributes(result),
        };
      },
      async (_ctx, input, result) => {
        const fresh = await store.attributes(input.target, input);
        const predicates = Object.keys(fresh.attributes ?? {});
        if ((fresh.problem ?? null) !== result.data.problem) return { ok: false, detail: 'a second read reported a different problem' };
        if (!sameList(predicates, result.data.predicates)) return { ok: false, detail: 'a second read found a different predicate set' };
        return { ok: true, detail: `${predicates.length} predicate(s) confirmed; no value was inferred` };
      },
    ),

    readAction(
      'world.relationships',
      'List relationships involving an entity, with inverse labels for incoming edges. Nothing is duplicated: one stored edge is shown once per direction it is asked for. Read-only.',
      '{"target":"entity id","direction":"both|outgoing|incoming","predicate":"optional type or list","asOf":"optional valid-time instant","at":"optional instant for status","currentOnly":false,"includeRetracted":false,"includeSuperseded":false,"limit":null}',
      (input) => {
        const o = expectObject(input, ['target', 'direction', 'predicate', 'asOf', 'at', 'currentOnly', 'includeRetracted', 'includeSuperseded', 'limit']);
        let predicate = null;
        if (o.predicate !== undefined && o.predicate !== null) {
          if (Array.isArray(o.predicate)) {
            predicate = o.predicate.map((entry) => predicateField(entry));
            if (new Set(predicate).size !== predicate.length) throw new ValidationError('predicate names the same type twice');
          } else {
            predicate = predicateField(o.predicate);
          }
        }
        return {
          target: recordRef(o.target, 'target'),
          direction: o.direction === undefined || o.direction === null ? 'both' : enumField(o.direction, 'direction', ['both', 'outgoing', 'incoming']),
          predicate,
          asOf: timeField(o.asOf, 'asOf'),
          at: timeField(o.at, 'at'),
          currentOnly: booleanField(o.currentOnly, 'currentOnly'),
          includeRetracted: booleanField(o.includeRetracted, 'includeRetracted'),
          includeSuperseded: booleanField(o.includeSuperseded, 'includeSuperseded'),
          limit: integerField(o.limit, 'limit', { fallback: null, min: 1, max: MAX_QUERY_LIMIT }),
        };
      },
      async (_ctx, input) => {
        const result = await store.relationships(input.target, input);
        return {
          summary: `${result.relationships?.length ?? 0} relationship(s) for ${singleLine(result.entityName ?? input.target, 60)}${result.problem ? `: ${result.problem}` : ''}`,
          data: {
            entityId: result.entityId ?? null,
            relationshipIds: (result.relationships ?? []).map((relationship) => relationship.id),
            directions: (result.relationships ?? []).map((relationship) => relationship.direction),
            problem: result.problem ?? null,
          },
          display: renderRelationships(result),
        };
      },
      async (_ctx, input, result) => {
        const fresh = await store.relationships(input.target, input);
        if ((fresh.problem ?? null) !== result.data.problem) return { ok: false, detail: 'a second read reported a different problem' };
        if (!sameList((fresh.relationships ?? []).map((relationship) => relationship.id), result.data.relationshipIds)) {
          return { ok: false, detail: 'a second read found a different relationship set' };
        }
        return { ok: true, detail: `${(fresh.relationships ?? []).length} relationship(s) confirmed; inverse edges are labels, not duplicate records` };
      },
    ),

    readAction(
      'world.events',
      'List events involving an entity, ordered by occurred-at, with happened-at, learned-at, and stored-at shown separately. Read-only.',
      '{"target":"entity id","at":"optional instant for status","includeRetracted":false,"includeSuperseded":false,"limit":null}',
      (input) => {
        const o = expectObject(input, ['target', 'at', 'includeRetracted', 'includeSuperseded', 'limit']);
        return {
          target: recordRef(o.target, 'target'),
          at: timeField(o.at, 'at'),
          includeRetracted: booleanField(o.includeRetracted, 'includeRetracted'),
          includeSuperseded: booleanField(o.includeSuperseded, 'includeSuperseded'),
          limit: integerField(o.limit, 'limit', { fallback: null, min: 1, max: MAX_QUERY_LIMIT }),
        };
      },
      async (_ctx, input) => {
        const result = await store.events(input.target, input);
        return {
          summary: `${result.events?.length ?? 0} event(s) involving ${singleLine(result.entityName ?? input.target, 60)}${result.problem ? `: ${result.problem}` : ''}`,
          data: {
            entityId: result.entityId ?? null,
            eventIds: (result.events ?? []).map((event) => event.id),
            total: result.total ?? null,
            truncated: result.truncated ?? false,
            problem: result.problem ?? null,
          },
          display: renderEvents(result),
        };
      },
      async (_ctx, input, result) => {
        const fresh = await store.events(input.target, input);
        if ((fresh.problem ?? null) !== result.data.problem) return { ok: false, detail: 'a second read reported a different problem' };
        if (!sameList((fresh.events ?? []).map((event) => event.id), result.data.eventIds)) {
          return { ok: false, detail: 'a second read found a different event set' };
        }
        return { ok: true, detail: `${(fresh.events ?? []).length} event(s) confirmed in occurred-at order` };
      },
    ),

    readAction(
      'world.conflicts',
      'List conservative disagreement groups: overlapping single-valued values, contested statements, and entities sharing a trusted external identifier. Both sides are shown; no source is ranked and no side is chosen. Read-only.',
      '{"target":"optional entity id","at":"optional instant treated as now"}',
      (input) => {
        const o = expectObject(input, ['target', 'at']);
        return {
          target: o.target === undefined || o.target === null ? null : recordRef(o.target, 'target'),
          at: timeField(o.at, 'at'),
        };
      },
      async (_ctx, { target, at }) => {
        const result = await store.conflicts({ entityId: target ?? undefined, now: at ?? undefined });
        const groupKeys = result.groups.map((group) => `${group.kind}|${group.predicate ?? group.externalScheme ?? ''}|${group.state}|${group.members.map((member) => member.id).join(',')}`);
        return {
          summary: `${result.counts.groups} disagreement group(s): ${result.counts.fact} fact, ${result.counts.relationship} relationship, ${result.counts.identity} identity; no side was chosen`,
          data: {
            counts: result.counts,
            groupKeys,
            contested: result.contested.map((item) => `${item.targetType}|${item.id}`),
          },
          display: renderConflicts(result),
        };
      },
      async (_ctx, { target, at }, result) => {
        const fresh = await store.conflicts({ entityId: target ?? undefined, now: at ?? undefined });
        const groupKeys = fresh.groups.map((group) => `${group.kind}|${group.predicate ?? group.externalScheme ?? ''}|${group.state}|${group.members.map((member) => member.id).join(',')}`);
        if (!sameList(groupKeys, result.data.groupKeys)) {
          return { ok: false, detail: 'a second read found a different disagreement set' };
        }
        if (!sameList(fresh.contested.map((item) => `${item.targetType}|${item.id}`), result.data.contested)) {
          return { ok: false, detail: 'a second read found a different contested statement set' };
        }
        return { ok: true, detail: `${groupKeys.length} disagreement group(s) confirmed; both sides remain stored` };
      },
    ),

    readAction(
      'world.related',
      'Bounded breadth-first traversal from one entity over recorded relationships and entity-valued facts. Depth and node caps apply; repeated nodes are reported, not expanded again. Read-only.',
      '{"target":"entity id","depth":1,"limit":20,"asOf":"optional valid-time instant","predicate":"optional type or list"}',
      (input) => {
        const o = expectObject(input, ['target', 'depth', 'limit', 'asOf', 'predicate']);
        let predicate = null;
        if (o.predicate !== undefined && o.predicate !== null) {
          predicate = Array.isArray(o.predicate)
            ? o.predicate.map((entry) => predicateField(entry))
            : predicateField(o.predicate);
        }
        return {
          target: recordRef(o.target, 'target'),
          depth: integerField(o.depth, 'depth', { fallback: 1, min: 1, max: MAX_RELATED_DEPTH }),
          limit: integerField(o.limit, 'limit', { fallback: 20, min: 1, max: MAX_RELATED_NODES }),
          asOf: timeField(o.asOf, 'asOf'),
          predicate,
        };
      },
      async (_ctx, input) => {
        const result = await store.related(input.target, input);
        return {
          summary: result.problem
            ? `traversal failed: ${result.problem}`
            : `found ${result.nodes.length} node(s) within depth ${result.depth}${result.truncated ? ' (truncated)' : ''}`,
          data: {
            problem: result.problem ?? null,
            nodeIds: (result.nodes ?? []).map((node) => node.id),
            edgeKeys: (result.edges ?? []).map((edge) => `${edge.id}:${edge.fromId}:${edge.toId}`),
            cycleKeys: (result.cycles ?? []).map((cycle) => `${cycle.id}:${cycle.fromId}:${cycle.toId}`),
            truncated: result.truncated ?? false,
          },
          display: renderRelated(result),
        };
      },
      async (_ctx, input, result) => {
        const fresh = await store.related(input.target, input);
        if ((fresh.problem ?? null) !== result.data.problem) return { ok: false, detail: 'a second traversal reported a different problem' };
        if (!sameList((fresh.nodes ?? []).map((node) => node.id), result.data.nodeIds)) {
          return { ok: false, detail: 'a second traversal found a different node set' };
        }
        return { ok: true, detail: `traversal confirmed with ${(fresh.nodes ?? []).length} node(s)` };
      },
    ),

    readAction(
      'world.history',
      'Show the stored event history for one entity, oldest first. History is read from the log, never rewritten. Read-only.',
      '{"target":"entity id or unique name"}',
      (input) => {
        const o = expectObject(input, ['target']);
        return { target: recordRef(o.target, 'target') };
      },
      async (_ctx, { target }) => {
        const result = await store.history(target);
        return {
          summary: `${result.entries.length} history record(s) for ${singleLine(result.entity.name, 60)}`,
          data: {
            entityId: result.entity.id,
            eventIds: result.entries.map((entry) => entry.eventId),
          },
          display: renderHistory(result),
        };
      },
      async (_ctx, { target }, result) => {
        const fresh = await store.history(target);
        if (!sameList(fresh.entries.map((entry) => entry.eventId), result.data.eventIds)) {
          return { ok: false, detail: 'a second read found a different history' };
        }
        return { ok: true, detail: `${fresh.entries.length} history record(s) confirmed in stored order` };
      },
    ),

    readAction(
      'world.statement.history',
      'Show the retraction and supersession events for one fact, relationship, or event. The statement itself stays readable. Read-only.',
      '{"targetType":"fact|relationship|event","target":"statement id or unique prefix"}',
      (input) => {
        const o = expectObject(input, ['targetType', 'target']);
        return { targetType: targetTypeField(o.targetType), target: recordRef(o.target, 'target') };
      },
      async (_ctx, { targetType, target }) => {
        const result = await store.statementHistory(targetType, target);
        return {
          summary: `${result.entries.length} lifecycle event(s) for ${targetType} ${shortId(result.statement.id)}`,
          data: {
            targetType,
            targetId: result.statement.id,
            eventIds: result.entries.map((entry) => entry.eventId),
          },
          display: renderStatementHistory(result),
        };
      },
      async (_ctx, { targetType, target }, result) => {
        const fresh = await store.statementHistory(targetType, target);
        if (!sameList(fresh.entries.map((entry) => entry.eventId), result.data.eventIds)) {
          return { ok: false, detail: 'a second read found a different lifecycle history' };
        }
        return { ok: true, detail: `${fresh.entries.length} lifecycle record(s) confirmed` };
      },
    ),

    // ---- lifecycle writes ---------------------------------------------------

    writeAction(
      'world.statement.retract',
      'Retract a fact, relationship, or event by recording why it is withdrawn. Nothing is deleted; the record and its history remain stored and readable. Write: user origin only.',
      '{"targetType":"fact|relationship|event","target":"statement id or unique prefix","reason":"why it is withdrawn","evidence":[{"relation":"retracts","sourceType":"user","sourceId":"user"}]}',
      (input) => {
        const o = expectObject(input, ['targetType', 'target', 'reason', 'evidence']);
        return {
          targetType: targetTypeField(o.targetType),
          target: recordRef(o.target, 'target'),
          reason: textField(o.reason, 'reason', MAX_REASON_CHARS),
          evidence: evidenceField(o.evidence),
        };
      },
      async (_ctx, { targetType, target, reason, evidence }) => {
        const { record } = await store.retractStatement({ origin: ORIGIN_USER, targetType, targetId: target, reason, evidence });
        return {
          summary: `retracted ${record.targetType} ${shortId(record.targetId)}: ${singleLine(reason, 80)}`,
          data: { targetType: record.targetType, targetId: record.targetId, reason },
          display: renderStatementLifecycle(record),
        };
      },
      async (_ctx, _input, result) => {
        const state = await store.state();
        const row = state.retractions.find((entry) => entry.targetType === result.data.targetType && entry.targetId === result.data.targetId);
        if (!row) return { ok: false, detail: 'the retraction record cannot be read back' };
        if (row.reason !== result.data.reason) return { ok: false, detail: 'the stored retraction reason differs from the request' };
        return { ok: true, detail: 'retraction recorded; the statement and its history remain stored' };
      },
    ),

    writeAction(
      'world.statement.supersede',
      'Supersede a fact, relationship, or event with another stored statement of the same kind, recording why. Both records remain stored. Write: user origin only.',
      '{"targetType":"fact|relationship|event","target":"old statement id","by":"replacement statement id","reason":"why it is superseded","evidence":[{"relation":"supersedes","sourceType":"user","sourceId":"user"}]}',
      (input) => {
        const o = expectObject(input, ['targetType', 'target', 'by', 'reason', 'evidence']);
        return {
          targetType: targetTypeField(o.targetType),
          target: recordRef(o.target, 'target'),
          by: recordRef(o.by, 'replacement'),
          reason: textField(o.reason, 'reason', MAX_REASON_CHARS),
          evidence: evidenceField(o.evidence),
        };
      },
      async (_ctx, { targetType, target, by, reason, evidence }) => {
        const { record } = await store.supersedeStatement({
          origin: ORIGIN_USER, targetType, targetId: target, byId: by, reason, evidence,
        });
        return {
          summary: `superseded ${record.targetType} ${shortId(record.targetId)} by ${shortId(record.byId)}: ${singleLine(reason, 80)}`,
          data: { targetType: record.targetType, targetId: record.targetId, byId: record.byId, reason },
          display: renderStatementLifecycle(record),
        };
      },
      async (_ctx, _input, result) => {
        const state = await store.state();
        const row = state.supersessions.find((entry) => entry.targetType === result.data.targetType
          && entry.targetId === result.data.targetId && entry.byId === result.data.byId);
        if (!row) return { ok: false, detail: 'the supersession record cannot be read back' };
        return { ok: true, detail: 'supersession recorded; both statements remain stored' };
      },
    ),

    // ---- identity -----------------------------------------------------------

    writeAction(
      'world.identity.decide',
      'Record that two active entities are the same or different. The decision is a separate record and merges nothing; a confirmation permits a later merge, a rejection keeps the pair out of the candidate list. Write: user origin only.',
      '{"left":"entity id","right":"entity id","decision":"confirmed|rejected","reason":"why","evidence":[{"relation":"supports","sourceType":"user","sourceId":"user"}]}',
      (input) => {
        const o = expectObject(input, ['left', 'right', 'decision', 'reason', 'evidence']);
        return {
          left: recordRef(o.left, 'left entity'),
          right: recordRef(o.right, 'right entity'),
          decision: enumField(o.decision, 'decision', IDENTITY_DECISIONS),
          reason: textField(o.reason, 'reason', MAX_REASON_CHARS),
          evidence: evidenceField(o.evidence),
        };
      },
      async (_ctx, { left, right, decision, reason, evidence }) => {
        const { record } = await store.decideIdentity({
          origin: ORIGIN_USER, leftId: left, rightId: right, decision, reason, evidence,
        });
        return {
          summary: `identity ${record.decision}: ${shortId(record.leftId)} and ${shortId(record.rightId)}`,
          data: { leftId: record.leftId, rightId: record.rightId, decision: record.decision, reason },
          display: renderIdentityDecision(record),
        };
      },
      async (_ctx, _input, result) => {
        const state = await store.state();
        const decision = state.identityDecisions.get(identityKey(result.data.leftId, result.data.rightId));
        if (!decision) return { ok: false, detail: 'the identity decision cannot be read back' };
        if (decision.decision !== result.data.decision) return { ok: false, detail: 'the stored decision differs from the record' };
        return { ok: true, detail: `identity decision ${decision.decision} confirmed; no entity was merged` };
      },
    ),

    readAction(
      'world.identity.candidates',
      'List deterministic identity candidates for an entity: shared trusted external ids, exact normalized names or aliases, recorded confirmations, and bounded similarity. The score orders reading and is never a merge basis. Read-only.',
      '{"target":"entity id","limit":20,"includeRejected":false}',
      (input) => {
        const o = expectObject(input, ['target', 'limit', 'includeRejected']);
        return {
          target: recordRef(o.target, 'target'),
          limit: integerField(o.limit, 'limit', { fallback: 20, min: 1, max: 20 }),
          includeRejected: booleanField(o.includeRejected, 'includeRejected'),
        };
      },
      async (_ctx, input) => {
        const result = await store.identityCandidates(input.target, input);
        return {
          summary: result.problem
            ? `candidate lookup failed: ${result.problem}`
            : `${result.candidates.length} candidate(s) for ${singleLine(result.entity?.name ?? input.target, 60)}; ${result.rejectedTotal} rejected pair(s)`,
          data: {
            problem: result.problem ?? null,
            entityId: result.entity?.id ?? null,
            candidateIds: result.candidates.map((candidate) => candidate.id),
            rejectedIds: result.rejected.map((candidate) => candidate.id),
            truncated: result.truncated ?? false,
          },
          display: renderCandidates(result),
        };
      },
      async (_ctx, input, result) => {
        const fresh = await store.identityCandidates(input.target, input);
        if ((fresh.problem ?? null) !== result.data.problem) return { ok: false, detail: 'a second lookup reported a different problem' };
        if (!sameList(fresh.candidates.map((candidate) => candidate.id), result.data.candidateIds)) {
          return { ok: false, detail: 'a second lookup found a different candidate set' };
        }
        return { ok: true, detail: `${fresh.candidates.length} candidate(s) confirmed; no candidate was merged` };
      },
    ),

    readAction(
      'world.identity.decision',
      'Show the latest recorded identity decision for a pair of entities, or state that none is recorded. Read-only.',
      '{"left":"entity id","right":"entity id"}',
      (input) => {
        const o = expectObject(input, ['left', 'right']);
        return { left: recordRef(o.left, 'left entity'), right: recordRef(o.right, 'right entity') };
      },
      async (_ctx, { left, right }) => {
        const decision = await store.identityDecision(left, right);
        return {
          summary: decision ? `identity ${decision.decision} recorded for the pair on ${decision.at}` : 'no identity decision is recorded for the pair',
          data: {
            found: Boolean(decision),
            decision: decision?.decision ?? null,
            at: decision?.at ?? null,
            leftId: decision?.leftId ?? null,
            rightId: decision?.rightId ?? null,
          },
          display: renderIdentityDecisionRead(decision, left, right),
        };
      },
      async (_ctx, { left, right }, result) => {
        const fresh = await store.identityDecision(left, right);
        if ((fresh?.decision ?? null) !== result.data.decision || (fresh?.at ?? null) !== result.data.at) {
          return { ok: false, detail: 'a second read returned a different identity decision' };
        }
        return { ok: true, detail: fresh ? `decision ${fresh.decision} confirmed` : 'confirmed that no decision is recorded' };
      },
    ),

    readAction(
      'world.pair',
      'Assess whether a merge between two entities would be permitted, and on what recorded basis. This records nothing. Read-only.',
      '{"left":"entity id","right":"entity id"}',
      (input) => {
        const o = expectObject(input, ['left', 'right']);
        return { left: recordRef(o.left, 'left entity'), right: recordRef(o.right, 'right entity') };
      },
      async (_ctx, { left, right }) => {
        const result = await store.pairAssessment(left, right);
        return {
          summary: result.problem
            ? `pair assessment failed: ${result.problem}`
            : result.allowed
              ? `a merge would be permitted on ${result.basis}`
              : 'a merge would be refused for this pair',
          data: { allowed: result.allowed ?? false, basis: result.basis ?? null, problem: result.problem ?? null },
          display: renderPair(result),
        };
      },
      async (_ctx, { left, right }, result) => {
        const fresh = await store.pairAssessment(left, right);
        if (Boolean(fresh.allowed) !== result.data.allowed || (fresh.basis ?? null) !== result.data.basis || (fresh.problem ?? null) !== result.data.problem) {
          return { ok: false, detail: 'a second assessment reached a different conclusion' };
        }
        return { ok: true, detail: 'pair assessment confirmed; nothing was recorded' };
      },
    ),

    // ---- evidence and history ----------------------------------------------

    readAction(
      'world.evidence',
      'List every distinct evidence reference bearing on an entity or one statement, with the records that cite it. The referenced records are not copied. Read-only.',
      '{"target":"optional entity id","targetType":"optional fact|relationship|event","targetId":"required with targetType"}',
      (input) => {
        const o = expectObject(input, ['target', 'targetType', 'targetId']);
        if (o.target !== undefined && o.target !== null) {
          if (o.targetType !== undefined || o.targetId !== undefined) {
            throw new ValidationError('give either an entity target or a statement target, not both');
          }
          return { entityId: recordRef(o.target, 'target') };
        }
        if (o.targetType === undefined || o.targetId === undefined) {
          throw new ValidationError('evidence needs an entity target or a targetType with a targetId');
        }
        return { targetType: targetTypeField(o.targetType), targetId: recordRef(o.targetId, 'targetId') };
      },
      async (_ctx, input) => {
        const result = await store.evidence(input);
        return {
          summary: `${result.refs?.length ?? 0} evidence reference(s)${result.problem ? `: ${result.problem}` : ''}`,
          data: {
            problem: result.problem ?? null,
            refs: (result.refs ?? []).map((ref) => `${ref.relation}|${ref.sourceType}|${ref.sourceId}`),
          },
          display: renderEvidence(result),
        };
      },
      async (_ctx, input, result) => {
        const fresh = await store.evidence(input);
        if ((fresh.problem ?? null) !== result.data.problem) return { ok: false, detail: 'a second read reported a different problem' };
        const refs = (fresh.refs ?? []).map((ref) => `${ref.relation}|${ref.sourceType}|${ref.sourceId}`);
        if (!sameList(refs, result.data.refs)) return { ok: false, detail: 'a second read found a different evidence set' };
        return { ok: true, detail: `${refs.length} evidence reference(s) confirmed` };
      },
    ),

    readAction(
      'world.belief.trace',
      'Trace one stored record across stores. A world statement lists the records that support or contradict it, the same-store disagreements it belongs to, and whether each cited record is still current. A memory or knowledge record lists the world statements that cite it and whether they support it, contradict it, or merely qualify it. With `at`, the trace replays only records stored at or before that cutoff, reconstructs what the record and its evidence meant then, and reports the current standing and later changes separately instead of projecting them into the past. Read-only; it decides nothing and authorizes nothing.',
      '{"targetType":"memory|knowledge|fact|relationship|event","target":"record id","at":"optional ISO historical cutoff; only records stored at or before it are replayed","limit":"optional 1-100 citation bound"}',
      (input) => {
        const o = expectObject(input, ['targetType', 'target', 'at', 'limit']);
        return {
          targetType: enumField(o.targetType, 'targetType', TRACE_TARGET_TYPES),
          targetId: recordRef(o.target, 'target'),
          at: timeField(o.at, 'at'),
          limit: integerField(o.limit, 'limit', { fallback: MAX_TRACE_CITATIONS, min: 1, max: MAX_TRACE_CITATIONS }),
        };
      },
      async (ctx, input) => {
        const trace = await runBeliefTrace(ctx, store, input);
        const parts = [`${trace.target.type} ${trace.target.id}: ${trace.disposition.state}`];
        if (trace.citations.rows.length > 0) parts.push(`${trace.citations.rows.length} citing world statement(s)`);
        if (trace.evidence.refs.length > 0) parts.push(`${trace.evidence.refs.length} evidence reference(s)`);
        return { summary: parts.join('; '), data: traceData(trace), display: renderBeliefTrace(trace) };
      },
      async (ctx, input, result) => {
        const fresh = traceData(await runBeliefTrace(ctx, store, input));
        // Two reads happen at two instants. The instant of the "current" view and the end of the
        // later window are read times, not readings: masking only those keeps the confirmation
        // about the replayed records, their evidence, and the current standing derived from them.
        const readings = (data) => ({
          ...data,
          current: data.current === null ? null : { ...data.current, cutoff: null },
          laterChanges: data.laterChanges === null ? null : { ...data.laterChanges, to: null },
        });
        if (JSON.stringify(readings(fresh)) !== JSON.stringify(readings(result.data))) {
          return { ok: false, detail: 'a second trace reached a different reading' };
        }
        return { ok: true, detail: `${fresh.citations.length} citation(s) and ${fresh.evidence.length} evidence reference(s) confirmed` };
      },
    ),

    readAction(
      'world.changes',
      'List statements that became valid, stopped being valid, were recorded, or were withdrawn inside a time window. Valid time and stored time are reported separately. Read-only.',
      '{"from":"ISO date or time","to":"ISO date or time"}',
      (input) => {
        const o = expectObject(input, ['from', 'to']);
        const from = timeField(o.from, 'from');
        const to = timeField(o.to, 'to');
        if (from === null) throw new ValidationError('from is required');
        if (to === null) throw new ValidationError('to is required');
        return { from, to };
      },
      async (_ctx, { from, to }) => {
        const result = await store.changes(from, to);
        return {
          summary: result.problem ? `comparison failed: ${result.problem}` : `${result.changes.length} change(s) between ${from} and ${to}`,
          data: {
            problem: result.problem ?? null,
            changes: result.changes.map((change) => `${change.at}|${change.kind}|${change.id ?? ''}`),
          },
          display: renderChanges(result),
        };
      },
      async (_ctx, { from, to }, result) => {
        const fresh = await store.changes(from, to);
        const changes = fresh.changes.map((change) => `${change.at}|${change.kind}|${change.id ?? ''}`);
        if ((fresh.problem ?? null) !== result.data.problem) return { ok: false, detail: 'a second comparison reported a different problem' };
        if (!sameList(changes, result.data.changes)) return { ok: false, detail: 'a second comparison found a different change set' };
        return { ok: true, detail: `${changes.length} change(s) confirmed` };
      },
    ),

    readAction(
      'world.state_at',
      'Reconstruct the world as it was stored at or before a given instant, including which facts, relationships, and events were in force then, which were recorded but not yet valid, which had expired, and what evidence each rested on. Later retractions, supersessions, corrections, and merges are not applied. Read-only.',
      '{"at":"ISO date or time"}',
      (input) => {
        const o = expectObject(input, ['at']);
        const at = timeField(o.at, 'at');
        if (at === null) throw new ValidationError('at is required');
        return { at };
      },
      async (_ctx, { at }) => {
        const result = await store.stateAt(at);
        const belief = result.belief ?? null;
        return {
          summary: `historical state at ${result.cutoff}: ${result.state.entities.size} entity record(s), ${result.state.facts.size} fact(s), ${result.state.relationships.size} relationship(s), ${result.state.events.size} event(s); ${belief?.counts?.believed ?? 0} statement(s) in force`,
          data: {
            cutoff: result.cutoff,
            records: result.records,
            excluded: result.excluded,
            problems: result.problems.length,
            counts: {
              entities: result.state.entities.size,
              facts: result.state.facts.size,
              relationships: result.state.relationships.size,
              events: result.state.events.size,
            },
            belief: belief === null ? null : {
              statements: belief.statements.map((row) => `${row.targetType}:${row.id}:${row.status}:${row.validity}`),
              counts: belief.counts,
              truncated: belief.truncated,
              note: belief.note,
            },
          },
          display: renderStateAt(result),
        };
      },
      async (_ctx, { at }, result) => {
        const fresh = await store.stateAt(at);
        if (!sameInstant(fresh.cutoff, result.data.cutoff) || fresh.records !== result.data.records || fresh.excluded !== result.data.excluded) {
          return { ok: false, detail: 'a second replay found a different historical boundary' };
        }
        if (fresh.state.entities.size !== result.data.counts.entities
          || fresh.state.facts.size !== result.data.counts.facts
          || fresh.state.relationships.size !== result.data.counts.relationships
          || fresh.state.events.size !== result.data.counts.events) {
          return { ok: false, detail: 'a second replay derived different counts' };
        }
        const belief = result.data.belief;
        if (belief !== null) {
          const statements = (fresh.belief?.statements ?? [])
            .map((row) => `${row.targetType}:${row.id}:${row.status}:${row.validity}`);
          if (!sameList(statements, belief.statements)) {
            return { ok: false, detail: 'a second replay reached a different belief reconstruction' };
          }
          if (JSON.stringify(fresh.belief?.counts ?? null) !== JSON.stringify(belief.counts)) {
            return { ok: false, detail: 'a second replay derived different belief counts' };
          }
        }
        return { ok: true, detail: `historical state confirmed from ${fresh.records} record(s); ${fresh.excluded} later record(s) excluded; ${fresh.belief?.counts?.believed ?? 0} statement(s) in force` };
      },
    ),

    // ---- integrity ----------------------------------------------------------

    readAction(
      'world.inspect',
      'Report the world model log path, counts, corrupt lines, and records that cannot be applied. A damaged log is reported as damaged, never as empty. Read-only.',
      '{}',
      (input) => {
        expectObject(input, []);
        return {};
      },
      async (_ctx) => {
        const inspected = await store.inspect();
        return {
          summary: inspected.complete
            ? `world model log complete: ${inspected.records} record(s)`
            : `world model log damaged: ${inspected.corrupt.length} corrupt line(s), ${inspected.problems.length} unappliable record(s)`,
          data: {
            complete: inspected.complete,
            records: inspected.records,
            corrupt: inspected.corrupt.length,
            problems: inspected.problems.length,
            counts: inspected.counts ?? null,
          },
          display: renderInspect(inspected),
        };
      },
      async (_ctx, _input, result) => {
        const fresh = await store.inspect();
        if (fresh.complete !== result.data.complete || fresh.records !== result.data.records
          || fresh.corrupt.length !== result.data.corrupt || fresh.problems.length !== result.data.problems) {
          return { ok: false, detail: 'a second inspection found a different store state' };
        }
        return { ok: true, detail: `inspection confirmed; complete: ${fresh.complete ? 'yes' : 'no'}` };
      },
    ),

    readAction(
      'world.status',
      'Report whether the world model store is available and its record counts. Reads nothing that presents the world; a damaged store is reported with its damage. Read-only.',
      '{}',
      (input) => {
        expectObject(input, []);
        return {};
      },
      async (_ctx) => {
        const status = await store.status();
        return {
          summary: status.available
            ? `world model available with ${status.records} record(s)${status.complete ? '' : '; damaged'}`
            : `world model unavailable: ${status.detail}`,
          data: {
            available: status.available,
            complete: status.complete ?? false,
            records: status.records ?? null,
            counts: status.counts ?? null,
          },
          display: renderStatus(status),
        };
      },
      async (_ctx, _input, result) => {
        const fresh = await store.status();
        if (fresh.available !== result.data.available) return { ok: false, detail: 'a second status read reported a different availability' };
        if (fresh.available && fresh.records !== result.data.records) return { ok: false, detail: 'a second status read found a different record count' };
        return { ok: true, detail: `status confirmed; available: ${fresh.available ? 'yes' : 'no'}` };
      },
    ),
  ];
}
