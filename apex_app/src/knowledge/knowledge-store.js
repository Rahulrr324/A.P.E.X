// Persistent knowledge representation. A knowledge record is an explicit
// relationship triple: subject -> relationship -> object, together with
// evidence, provenance, and status.
//
// Design rules (mirroring memory-store):
//  - every record carries provenance: who or what supplied the claim;
//  - model-origin requests may retrieve knowledge but never write it;
//  - write authority requires an explicit user-origin operation;
//  - conflicting relationships are preserved, never silently discarded;
//  - corrupt storage is detected and handled without destroying valid records;
//  - sensitive-looking field values are refused.
import { createHash, randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { StoreError, ValidationError } from '../errors.js';
import { CONTROL_CHARS, STOPWORDS, shortId } from '../util.js';
import { containsSecret } from '../security/secrets.js';

export const KNOWLEDGE_SCHEMA = 1;

// Field length limits.
const MAX_FIELD_CHARS = 500;
const MAX_EVIDENCE_CHARS = 1000;
const MAX_CONTEXT_CHARS = 200;

const VALID_STATUSES = new Set(['supported', 'uncertain', 'conflicting', 'superseded']);
const VALID_PROVENANCE_ORIGINS = new Set(['user_supplied', 'user_approved']);
// model_proposed is the only model-origin provenance a knowledge record may carry,
// but it may only arrive via the retrieval path, never through a write.
const MODEL_PROVENANCE_ORIGIN = 'model_proposed';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

// ---- field validators -------------------------------------------------------

function validateTextField(value, name, { required = true, max = MAX_FIELD_CHARS } = {}) {
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
    throw new ValidationError(
      `${name} looks like a password, key, or token; it was not stored`,
      'SECRET_REFUSED',
    );
  }
  return t || null;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function tripleHash(subject, relationship, object) {
  return sha256Hex(`${subject}\x00${relationship}\x00${object}`);
}

// ---- record validation (used by JsonlStore) ---------------------------------

export function validateKnowledgeRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if (r.schema !== KNOWLEDGE_SCHEMA) return 'unsupported schema';
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'missing or invalid id';
  if (typeof r.subject !== 'string' || r.subject.length === 0) return 'missing subject';
  if (typeof r.relationship !== 'string' || r.relationship.length === 0) return 'missing relationship';
  if (typeof r.object !== 'string' || r.object.length === 0) return 'missing object';
  if (typeof r.tripleHash !== 'string' || r.tripleHash.length !== 64) return 'missing or invalid tripleHash';
  if (r.tripleHash !== tripleHash(r.subject, r.relationship, r.object)) return 'tripleHash mismatch';
  if (!VALID_STATUSES.has(r.status)) return 'unknown status';
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return 'bad timestamp';
  if (!r.provenance || typeof r.provenance !== 'object') return 'missing provenance';
  const originOk = r.provenance.origin === MODEL_PROVENANCE_ORIGIN
    || VALID_PROVENANCE_ORIGINS.has(r.provenance.origin);
  if (!originOk) return 'unknown provenance origin';
  if (r.provenance.updateMode !== 'user_confirmed' && r.provenance.updateMode !== 'model_proposed') {
    return 'unknown provenance updateMode';
  }
  // model_proposed provenance must never carry user_confirmed updateMode.
  if (r.provenance.origin === MODEL_PROVENANCE_ORIGIN && r.provenance.updateMode === 'user_confirmed') {
    return 'model-proposed origin cannot carry user_confirmed updateMode';
  }
  // user_supplied/user_approved must have user_confirmed updateMode.
  if (VALID_PROVENANCE_ORIGINS.has(r.provenance.origin) && r.provenance.updateMode !== 'user_confirmed') {
    return 'user-origin provenance must carry user_confirmed updateMode';
  }
  // supersededBy must be an array of valid id strings when present.
  if (r.supersededBy !== undefined) {
    if (!Array.isArray(r.supersededBy) || r.supersededBy.some((id) => typeof id !== 'string' || !ID_RE.test(id))) {
      return 'invalid supersededBy list';
    }
  }
  return null;
}

// ---- KnowledgeStore ---------------------------------------------------------

export class KnowledgeStore {
  constructor(filePath, { now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.log = new JsonlStore(filePath, { validateRecord: validateKnowledgeRecord });
  }

  // --- write (user origin only) ---

  async add({
    subject,
    relationship,
    object,
    evidence = null,
    provenance = {},
    origin,
  } = {}) {
    if (origin !== 'user') {
      throw new ValidationError(
        'knowledge records require an authorized user-origin operation; model output cannot write knowledge',
        'WRITE_REQUIRES_USER_ORIGIN',
      );
    }

    // Validate all text fields.
    const sub = validateTextField(subject, 'subject');
    const rel = validateTextField(relationship, 'relationship');
    const obj = validateTextField(object, 'object');
    const evi = evidence !== null && evidence !== undefined
      ? validateTextField(evidence, 'evidence', { required: false, max: MAX_EVIDENCE_CHARS })
      : null;

    // Validate and sanitize provenance.
    const sanitized = sanitizeProvenance(provenance, origin);

    // Conflict detection reads the whole store, so it must refuse a damaged store
    // rather than silently compare against an incomplete record set.
    const records = await this.#loadComplete();
    const id = randomUUID();
    if (records.some((r) => r.id === id)) {
      throw new StoreError('identifier collision; nothing written');
    }

    // Detect conflicts: another live record with the same subject+relationship but a
    // different object is a conflict. Equality is trimmed and case-insensitive for all
    // three fields, so case variants of the same triple are duplicates, not conflicts.
    const tHash = tripleHash(sub, rel, obj);
    const reqKey = normalizedTriple(sub, rel, obj);
    const supersededByMap = buildSupersededByMap(records);
    const conflictingIds = records
      .filter((r) => {
        if (isSuperseded(r, supersededByMap)) return false;
        if (normalizedTriple(r.subject, r.relationship, r.object) === reqKey) return false;
        return sameSubjectRelationship(r, sub, rel);
      })
      .map((r) => r.id);

    const status = conflictingIds.length > 0 ? 'conflicting' : 'supported';

    const record = {
      schema: KNOWLEDGE_SCHEMA,
      id,
      subject: sub,
      relationship: rel,
      object: obj,
      evidence: evi,
      tripleHash: tHash,
      status,
      createdAt: this.now().toISOString(),
      provenance: sanitized,
    };

    await this.log.append(record);
    return { record, conflictingIds };
  }

  async get(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    const records = await this.#loadComplete();
    return records.find((r) => r.id === id) ?? null;
  }

  // Loads all valid records; throws on any corrupt lines.
  async #loadComplete() {
    const { records, corrupt } = await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`knowledge store contains ${corrupt.length} corrupt line(s); refusing an incomplete knowledge operation`);
    }
    return records;
  }

  // Resolve a full id or an id prefix. Never returns a partial or guessed match.
  async findByPrefix(prefix) {
    const p = typeof prefix === 'string' ? prefix.trim() : '';
    if (p.length === 0) return [];
    const records = await this.#loadComplete();
    const supersededByMap = buildSupersededByMap(records);
    return records
      .filter((r) => r.id === p || r.id.startsWith(p) || shortId(r.id) === p)
      .map((r) => annotate(r, records, supersededByMap));
  }

  async list({ limit = 20 } = {}) {
    const records = await this.#loadComplete();
    const supersededByMap = buildSupersededByMap(records);
    return records.slice(-Math.max(1, limit)).reverse().map((r) => annotate(r, records, supersededByMap));
  }

  // Keyword search over subject+relationship+object+evidence.
  // Returns up to `limit` records, scored by term overlap. Superseded records
  // are excluded from results. Results are bounded (never the full store).
  async search(query, { limit = 5 } = {}) {
    const records = await this.#loadComplete();
    if (!query || typeof query !== 'string' || query.trim().length === 0) return [];

    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const supersededByMap = buildSupersededByMap(records);

    const scored = records
      .filter((r) => {
        const ann = annotate(r, records, supersededByMap);
        return ann.status !== 'superseded';
      })
      .map((r) => {
        const corpus = tokenize(`${r.subject} ${r.relationship} ${r.object} ${r.evidence ?? ''}`);
        const corpusSet = new Set(corpus);
        let matched = 0;
        for (const t of terms) {
          if (corpusSet.has(t)) matched += 1;
        }
        return { record: r, score: matched / terms.length };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => {
        const delta = b.score - a.score;
        if (delta !== 0) return delta;
        return Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt);
      })
      .slice(0, Math.max(1, limit));

    return scored.map(({ record, score }) => ({
      record: annotate(record, records, supersededByMap),
      score,
    }));
  }

  async status() {
    const { records, corrupt } = await this.log.load();
    return { path: this.filePath, records: records.length, corrupt: corrupt.length };
  }
}

// ---- helpers ----------------------------------------------------------------

function sanitizeProvenance(p, origin) {
  const base = {};
  if (p && typeof p === 'object') {
    if (typeof p.operationId === 'string' && OPERATION_ID_RE.test(p.operationId)) {
      base.operationId = p.operationId;
    }
    if (typeof p.context === 'string' && p.context.trim().length > 0) {
      const ctx = p.context.trim().slice(0, MAX_CONTEXT_CHARS);
      if (!CONTROL_CHARS.test(ctx) && !containsSecret(ctx)) base.context = ctx;
    }
    // Reject attempts to inject provenance fields that must be derived.
    if (p.updateMode !== undefined || p.origin !== undefined) {
      throw new ValidationError(
        'provenance updateMode and origin may not be supplied directly; they are derived from the operation',
      );
    }
  }

  if (origin === 'user') {
    return { ...base, origin: 'user_supplied', updateMode: 'user_confirmed' };
  }
  // Should never reach here (add() already guards), but be explicit.
  throw new ValidationError('cannot determine valid provenance for this origin');
}

function buildSupersededByMap(records) {
  const map = new Map();
  for (const r of records) {
    for (const id of r.supersededBy ?? []) {
      const existing = map.get(id) ?? [];
      existing.push(r.id);
      map.set(id, existing);
    }
  }
  return map;
}

function normalizedTriple(subject, relationship, object) {
  return [subject, relationship, object]
    .map((value) => String(value).trim().toLowerCase())
    .join('\x00');
}

function sameSubjectRelationship(record, subject, relationship) {
  return record.subject.trim().toLowerCase() === subject.trim().toLowerCase()
    && record.relationship.trim().toLowerCase() === relationship.trim().toLowerCase();
}

function isSuperseded(record, supersededByMap) {
  return record.status === 'superseded' || (supersededByMap.get(record.id)?.length ?? 0) > 0;
}

function annotate(record, allRecords, supersededByMap) {
  const sby = supersededByMap.get(record.id) ?? [];
  const selfSuperseded = isSuperseded(record, supersededByMap);
  // Detect live conflicts: other non-superseded records with the same subject+relationship
  // but a different object. A superseded record is historical and has no live conflicts.
  const recordKey = normalizedTriple(record.subject, record.relationship, record.object);
  const conflictIds = selfSuperseded ? [] : allRecords
    .filter((r) => {
      if (r.id === record.id) return false;
      if (isSuperseded(r, supersededByMap)) return false;
      if (normalizedTriple(r.subject, r.relationship, r.object) === recordKey) return false;
      return sameSubjectRelationship(r, record.subject, record.relationship);
    })
    .map((r) => r.id);

  // The stored status is a snapshot from write time. A conflict that has since been
  // superseded is not live, so a stale "conflicting" status becomes "supported".
  const effectiveStatus = selfSuperseded
    ? 'superseded'
    : conflictIds.length > 0
      ? 'conflicting'
      : record.status === 'conflicting'
        ? 'supported'
        : record.status;

  return {
    ...record,
    status: effectiveStatus,
    conflictsWith: conflictIds,
    supersededBy: sby,
  };
}

// Lowercase words, drop short words and words that carry no retrieval signal
// (question words, pronouns, fillers). Mirrors the memory tokenizer's policy.
export function tokenize(text) {
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}
