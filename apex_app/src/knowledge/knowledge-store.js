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
export const MAX_SUPERSEDES = 10;
export const MAX_RETRACTION_REASON_CHARS = 500;
// A resolution names one live conflict group. The bound keeps a single decision from
// silently covering an unbounded set of claims; a larger group must be split explicitly.
export const MAX_RESOLUTION_TARGETS = 20;
export const MAX_RESOLUTION_REASON_CHARS = 500;
// A history chain is bounded so one damaged or enormous store cannot produce
// unbounded output. The view says when it stopped rather than implying completeness.
export const MAX_HISTORY_CHAIN = 20;
// The derived parse snapshot is bounded: a claim file this large is parsed on every read
// rather than held in process memory alongside the user's other state.
export const KNOWLEDGE_PARSE_CACHE_BYTES = 32 * 1024 * 1024;
// Store-wide health is a summary, not a dump. Counts are exact; examples of conflict
// groups and anomalies are capped so a damaged store cannot produce unbounded output.
export const MAX_HEALTH_SAMPLES = 20;
const MAX_CONFLICT_SAMPLES = 5;

// A retraction is a lifecycle event appended to the same log as the claims. It never
// rewrites, moves, or deletes the record it names: readers derive the record's state
// from the events that target it. Keeping one append-only source of truth means a
// reader that sees the claim also sees the evidence that retired it.
const RETRACTION_KIND = 'retraction';
// A resolution records an explicit user decision about one exact conflict group. It is
// appended next to the claims and events and never edits them: the chosen claim is not
// rewritten and every other claim stays readable. A recorded decision is not a verified
// fact, so readers keep the conflict and its alternatives visible.
const RESOLUTION_KIND = 'resolution';

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
  if (r.kind === RETRACTION_KIND) return validateRetractionEvent(r);
  if (r.kind === RESOLUTION_KIND) return validateResolutionEvent(r);
  if (r.kind !== undefined) return 'unknown record kind';
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

// A lifecycle event is not a claim: it carries no triple or status. Accepting one in
// place of a claim would let a reader treat an event as knowledge, so the shape is
// strict and a retraction may only carry user-origin provenance.
function validateRetractionEvent(r) {
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'retraction event has missing or invalid id';
  if (typeof r.targetId !== 'string' || !ID_RE.test(r.targetId)) return 'retraction event has missing or invalid targetId';
  if (r.reason !== undefined && r.reason !== null) {
    if (typeof r.reason !== 'string') return 'retraction reason must be text';
    if (r.reason.trim().length === 0) return 'retraction reason is empty';
    if (r.reason.length > MAX_RETRACTION_REASON_CHARS) return 'retraction reason is too long';
    if (CONTROL_CHARS.test(r.reason)) return 'retraction reason contains control characters';
    if (containsSecret(r.reason)) return 'retraction reason looks like a password, key, or token';
  }
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return 'bad timestamp';
  if (!r.provenance || typeof r.provenance !== 'object') return 'missing provenance';
  if (!VALID_PROVENANCE_ORIGINS.has(r.provenance.origin)) return 'retraction event requires user provenance';
  if (r.provenance.updateMode !== 'user_confirmed') return 'retraction event provenance must be user_confirmed';
  for (const field of ['subject', 'relationship', 'object', 'evidence', 'tripleHash', 'status', 'supersededBy']) {
    if (r[field] !== undefined) return `retraction event must not carry ${field}`;
  }
  return null;
}

// A resolution event names the exact claims it decides between and the one the user
// selected. The chosen claim must be one of the named claims, the group must contain at
// least two claims, and the event may only carry user provenance. It cannot carry claim
// fields: a decision is not itself knowledge, and a damaged or hand-edited event must
// never be readable as a claim.
function validateResolutionEvent(r) {
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'resolution event has missing or invalid id';
  if (!Array.isArray(r.targetIds)) return 'resolution event has no target claim list';
  if (r.targetIds.length < 2) return 'resolution event must name at least two claims';
  if (r.targetIds.length > MAX_RESOLUTION_TARGETS) {
    return `resolution event names more than ${MAX_RESOLUTION_TARGETS} claims`;
  }
  const seen = new Set();
  for (const id of r.targetIds) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return 'resolution event has an invalid target claim id';
    if (seen.has(id)) return 'resolution event names the same claim more than once';
    seen.add(id);
  }
  if (typeof r.chosenId !== 'string' || !ID_RE.test(r.chosenId)) {
    return 'resolution event has missing or invalid chosenId';
  }
  if (!seen.has(r.chosenId)) return 'resolution chosen id is not one of its targeted claims';
  if (r.reason !== undefined && r.reason !== null) {
    if (typeof r.reason !== 'string') return 'resolution reason must be text';
    if (r.reason.trim().length === 0) return 'resolution reason is empty';
    if (r.reason.length > MAX_RESOLUTION_REASON_CHARS) return 'resolution reason is too long';
    if (CONTROL_CHARS.test(r.reason)) return 'resolution reason contains control characters';
    if (containsSecret(r.reason)) return 'resolution reason looks like a password, key, or token';
  }
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return 'bad timestamp';
  if (!r.provenance || typeof r.provenance !== 'object') return 'missing provenance';
  if (!VALID_PROVENANCE_ORIGINS.has(r.provenance.origin)) return 'resolution event requires user provenance';
  if (r.provenance.updateMode !== 'user_confirmed') return 'resolution event provenance must be user_confirmed';
  for (const field of [
    'subject', 'relationship', 'object', 'evidence', 'tripleHash', 'status', 'supersededBy', 'targetId',
  ]) {
    if (r[field] !== undefined) return `resolution event must not carry ${field}`;
  }
  return null;
}

// ---- KnowledgeStore ---------------------------------------------------------

// The newest `limit` claims, newest first, annotated with supersession, conflict and
// resolution state. Shared by list() and projectionRead() so the two can never apply
// different lifecycle rules to the same record.
function knowledgeWindow(records, limit) {
  const { claims, retractionsByTarget, resolutionEvents } = splitLifecycle(records);
  const supersededByMap = buildSupersededByMap(claims);
  const conflictIndex = buildConflictIndex(claims, supersededByMap, retractionsByTarget);
  const resolutionIndex = buildResolutionIndex(claims, supersededByMap, retractionsByTarget, resolutionEvents);
  return claims.slice(-Math.max(1, limit)).reverse()
    .map((r) => annotate(r, supersededByMap, conflictIndex, retractionsByTarget, resolutionIndex));
}

export class KnowledgeStore {
  constructor(filePath, { now = () => new Date(), parseCacheBytes = KNOWLEDGE_PARSE_CACHE_BYTES } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.log = new JsonlStore(filePath, { validateRecord: validateKnowledgeRecord, parseCacheBytes });
  }

  // --- write (user origin only) ---

  // `supersedes` names existing live records this new record replaces. The stored field
  // is `supersededBy` (the direction the readers use: a later record lists the earlier
  // ids it supersedes). Only a conflicting claim can be superseded — same subject and
  // relationship, different object. Unrelated records are never retired, so a mistyped
  // id cannot hide an unrelated fact.
  async add({
    subject,
    relationship,
    object,
    evidence = null,
    provenance = {},
    origin,
    supersedes = [],
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
    const refs = validateSupersedeRefs(supersedes);

    // Conflict detection reads the whole store, so it must refuse a damaged store
    // rather than silently compare against an incomplete record set.
    const records = await this.#loadComplete({ beforeAppend: true });
    const id = randomUUID();
    if (records.some((r) => r.id === id)) {
      throw new StoreError('identifier collision; nothing written');
    }

    const { claims, retractionsByTarget } = splitLifecycle(records);

    // Resolve every reference before writing. A missing, ambiguous, already-retired,
    // unrelated, or identical record refuses the whole write rather than partially
    // applying a change to durable knowledge.
    const supersededByMap = buildSupersededByMap(claims);
    const targetIds = resolveSupersedeTargets(claims, refs, supersededByMap, retractionsByTarget, sub, rel, obj);
    const targetSet = new Set(targetIds);

    // Detect conflicts: another live record with the same subject+relationship but a
    // different object is a conflict. Equality is trimmed and case-insensitive for all
    // three fields, so case variants of the same triple are duplicates, not conflicts.
    // A record this write supersedes is no longer a live conflict; a retracted record
    // never is one.
    const tHash = tripleHash(sub, rel, obj);
    const reqKey = normalizedTriple(sub, rel, obj);
    const conflictIndex = buildConflictIndex(claims, supersededByMap, retractionsByTarget);
    const conflictingIds = (conflictIndex.get(conflictIndexKey(sub, rel)) ?? [])
      .filter((r) => !targetSet.has(r.id))
      .filter((r) => normalizedTriple(r.subject, r.relationship, r.object) !== reqKey)
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
      ...(targetIds.length > 0 ? { supersededBy: targetIds } : {}),
    };

    await this.log.append(record);
    return { record, conflictingIds, supersededIds: targetIds };
  }

  // Retraction: an authorized user marks an existing claim as no longer active.
  // The event is appended; the claim itself is never rewritten. A target that is
  // missing, ambiguous, already superseded, already retracted, or ambiguous in its
  // lifecycle is refused, so one record can never be in two terminal states.
  async retract({ target, reason = null, provenance = {}, origin } = {}) {
    if (origin !== 'user') {
      throw new ValidationError(
        'retracting a knowledge record requires an authorized user-origin operation; model output cannot retract knowledge',
        'WRITE_REQUIRES_USER_ORIGIN',
      );
    }
    const ref = validateRetractionRef(target);
    const why = validateRetractionReason(reason);
    const sanitized = sanitizeProvenance(provenance, origin);

    const records = await this.#loadComplete({ beforeAppend: true });
    const { claims, retractionsByTarget } = splitLifecycle(records);
    const supersededByMap = buildSupersededByMap(claims);

    const matches = claims.filter((r) => r.id === ref || r.id.startsWith(ref) || shortId(r.id) === ref);
    if (matches.length === 0) throw new ValidationError('retraction target not found');
    if (matches.length > 1) {
      throw new ValidationError('retraction target is ambiguous; use a longer id prefix');
    }
    const record = matches[0];
    if (isSuperseded(record, supersededByMap)) {
      throw new ValidationError(`retraction target ${shortId(record.id)} is already superseded; historical records are not retracted`);
    }
    const existing = retractionsByTarget.get(record.id) ?? [];
    if (existing.length > 0) {
      throw new ValidationError(`retraction target ${shortId(record.id)} is already retracted`);
    }

    const eventId = randomUUID();
    if (records.some((r) => r.id === eventId)) {
      throw new StoreError('identifier collision; nothing written');
    }
    const event = {
      schema: KNOWLEDGE_SCHEMA,
      kind: RETRACTION_KIND,
      id: eventId,
      targetId: record.id,
      ...(why ? { reason: why } : {}),
      createdAt: this.now().toISOString(),
      provenance: sanitized,
    };
    await this.log.append(event);
    return { event, record };
  }

  // Explicit conflict resolution: an authorized user selects one claim from an exact
  // live conflict group. The decision is appended as its own event; no claim is edited,
  // retracted, or superseded, so a different choice later is a new event and every
  // alternative stays readable. The chosen claim is recorded, never asserted as true.
  async resolve({ target, choose, reason = null, provenance = {}, origin } = {}) {
    if (origin !== 'user') {
      throw new ValidationError(
        'resolving a knowledge conflict requires an authorized user-origin operation; model output cannot decide which claim is correct',
        'WRITE_REQUIRES_USER_ORIGIN',
      );
    }
    const targetRef = validateResolutionRef(target, 'resolution target');
    const chooseRef = validateResolutionRef(choose, 'chosen claim');
    const why = validateRetractionReason(reason);
    const sanitized = sanitizeProvenance(provenance, origin);

    const records = await this.#loadComplete({ beforeAppend: true });
    const { claims, resolutionEvents, retractionsByTarget } = splitLifecycle(records);
    const supersededByMap = buildSupersededByMap(claims);
    const conflictIndex = buildConflictIndex(claims, supersededByMap, retractionsByTarget);

    const matches = matchClaimRefs(claims, targetRef);
    if (matches.length === 0) throw new ValidationError('resolution target not found');
    if (matches.length > 1) {
      throw new ValidationError('resolution target is ambiguous; use a longer id prefix');
    }
    const record = matches[0];
    if (!isActive(record, supersededByMap, retractionsByTarget)) {
      throw new ValidationError(
        `resolution target ${shortId(record.id)} is not active; only a live conflicting claim can be resolved`,
      );
    }

    const group = conflictIndex.get(conflictIndexKey(record.subject, record.relationship)) ?? [];
    const distinctObjects = new Set(group.map((r) => normalizedTriple(r.subject, r.relationship, r.object)));
    if (distinctObjects.size < 2) {
      throw new ValidationError(`resolution target ${shortId(record.id)} has no live conflicting claim`);
    }
    if (group.length > MAX_RESOLUTION_TARGETS) {
      throw new ValidationError(
        `the live conflict group has ${group.length} claims; at most ${MAX_RESOLUTION_TARGETS} may be resolved at once`,
      );
    }

    const targetIds = group.map((r) => r.id);
    const chosenMatches = matchClaimRefs(group, chooseRef);
    if (chosenMatches.length === 0) {
      throw new ValidationError(`chosen claim is not part of the conflict group that contains ${shortId(record.id)}`);
    }
    if (chosenMatches.length > 1) {
      throw new ValidationError('chosen claim is ambiguous within the conflict group; use a longer id prefix');
    }
    const chosen = chosenMatches[0];

    // A repeated identical decision would add no information, so it is refused before
    // anything is written. A different choice over the same group is allowed and becomes
    // a separately recorded event; store order then makes the latest decision govern.
    const setKey = claimSetKey(targetIds);
    const previous = resolutionEvents.filter((event) => claimSetKey(event.targetIds) === setKey).at(-1) ?? null;
    if (previous && previous.chosenId === chosen.id) {
      throw new ValidationError('this resolution has already been recorded for the same claims');
    }

    const eventId = randomUUID();
    if (records.some((r) => r.id === eventId)) {
      throw new StoreError('identifier collision; nothing written');
    }
    const event = {
      schema: KNOWLEDGE_SCHEMA,
      kind: RESOLUTION_KIND,
      id: eventId,
      targetIds,
      chosenId: chosen.id,
      ...(why ? { reason: why } : {}),
      createdAt: this.now().toISOString(),
      provenance: sanitized,
    };
    await this.log.append(event);
    return { event, record, chosen, targetIds, claims: group };
  }

  async get(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    const records = await this.#loadComplete();
    return records.find((r) => r.kind === undefined && r.id === id) ?? null;
  }

  // Reads one lifecycle event (retraction or resolution) by full id. Events are not
  // claims, so this exists separately from get() and never returns a claim.
  async getEvent(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    const records = await this.#loadComplete();
    return records.find((r) => r.kind !== undefined && r.id === id) ?? null;
  }

  // Loads all valid records; throws on any corrupt lines. `beforeAppend` marks the read that a
  // write performs to inspect the store first: it goes through `loadForAppend()`, which reuses
  // this instance's incrementally maintained validated records when the file is still byte-for-byte
  // the sequence they were validated from, so an ordinary append no longer re-parses and
  // re-validates the whole store. Records from a reused state are exactly the records a full
  // re-read would have produced, and such a state only ever exists for a file with no damage in it,
  // so the refusal below still fires on a damaged store.
  async #loadComplete({ beforeAppend = false } = {}) {
    const { records, corrupt } = beforeAppend ? await this.log.loadForAppend() : await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`knowledge store contains ${corrupt.length} corrupt line(s); refusing an incomplete knowledge operation`);
    }
    return records;
  }

  // Resolve a full id or an id prefix among claims. A retraction event id is not a
  // claim and is never returned here. Never returns a partial or guessed match.
  async findByPrefix(prefix) {
    const p = typeof prefix === 'string' ? prefix.trim() : '';
    if (p.length === 0) return [];
    const records = await this.#loadComplete();
    const { claims, retractionsByTarget, resolutionEvents } = splitLifecycle(records);
    const supersededByMap = buildSupersededByMap(claims);
    const conflictIndex = buildConflictIndex(claims, supersededByMap, retractionsByTarget);
    const resolutionIndex = buildResolutionIndex(claims, supersededByMap, retractionsByTarget, resolutionEvents);
    return claims
      .filter((r) => r.id === p || r.id.startsWith(p) || shortId(r.id) === p)
      .map((r) => annotate(r, supersededByMap, conflictIndex, retractionsByTarget, resolutionIndex));
  }

  async list({ limit = 20 } = {}) {
    const records = await this.#loadComplete();
    return knowledgeWindow(records, limit);
  }

  // One authoritative read for the world-state projection: the store-wide lifecycle summary
  // and the newest bounded claims, both from the same snapshot of the file. Calling health()
  // and list() separately parses and validates the file twice and can report a lifecycle
  // summary that does not describe the records the projection was given. Same parser, same
  // integrity rules, same annotation as list(); nothing is written or repaired.
  async projectionRead({ limit = 20 } = {}) {
    let loaded;
    try {
      loaded = await this.log.load();
    } catch (err) {
      return {
        health: summarizeKnowledgeHealth(null, [], { path: this.filePath, detail: err?.message ?? String(err) }),
        claims: null,
      };
    }
    const health = summarizeKnowledgeHealth(loaded.records, loaded.corrupt, { path: this.filePath });
    const usable = health.inspected === true && health.corruptLines === 0;
    return {
      health,
      claims: usable ? knowledgeWindow(loaded.records, limit) : null,
    };
  }

  // Read-only lifecycle view: the stored claim, its direct supersession links in both
  // directions, its retraction event when there is exactly one, and the connected
  // chain. The chain reports when it is incomplete or truncated instead of asserting
  // a completeness the store cannot establish.
  async history(recordId) {
    if (typeof recordId !== 'string' || recordId.length === 0) return null;
    const records = await this.#loadComplete();
    const { claims, retractionsByTarget, resolutionEvents } = splitLifecycle(records);
    const byId = new Map(claims.map((r) => [r.id, r]));
    const record = byId.get(recordId);
    if (!record) return null;
    const supersededByMap = buildSupersededByMap(claims);
    const conflictIndex = buildConflictIndex(claims, supersededByMap, retractionsByTarget);
    const resolutionIndex = buildResolutionIndex(claims, supersededByMap, retractionsByTarget, resolutionEvents);
    return buildKnowledgeHistory(
      record, claims, byId, supersededByMap, conflictIndex, retractionsByTarget, resolutionIndex,
    );
  }

  // Keyword search over subject+relationship+object+evidence. Returns up to `limit`
  // records. Each query term is weighted by its rarity in the store (IDF), the same
  // policy the memory store uses, so a distinctive name match outranks an incidental
  // common-word match; raw term overlap made the two indistinguishable. Superseded and
  // retracted records are excluded. Results are bounded (never the full store).
  async search(query, { limit = 5 } = {}) {
    const records = await this.#loadComplete();
    if (!query || typeof query !== 'string' || query.trim().length === 0) return [];

    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];

    const { claims, retractionsByTarget, resolutionEvents } = splitLifecycle(records);
    const supersededByMap = buildSupersededByMap(claims);
    const conflictIndex = buildConflictIndex(claims, supersededByMap, retractionsByTarget);
    const resolutionIndex = buildResolutionIndex(claims, supersededByMap, retractionsByTarget, resolutionEvents);

    const pool = claims.filter((r) => isActive(r, supersededByMap, retractionsByTarget));
    const docs = pool.map((r) => new Set(tokenize(`${r.subject} ${r.relationship} ${r.object} ${r.evidence ?? ''}`)));

    const df = new Map(terms.map((t) => [t, docs.filter((d) => d.has(t)).length]));
    const n = pool.length;
    // Floored at 1 for the same reason as the memory store: in a small personal
    // store an unseen word would otherwise outweigh a matched one.
    const idf = new Map(terms.map((t) => [t, Math.max(1, Math.log(1 + (n - df.get(t) + 0.5) / (df.get(t) + 0.5)))]));
    const totalWeight = terms.reduce((sum, t) => sum + idf.get(t), 0) || 1;

    const scored = pool.map((record, index) => {
      const words = docs[index];
      let matched = 0;
      for (const t of terms) {
        if (words.has(t)) matched += idf.get(t);
      }
      if (matched > 0) return { record, score: matched / totalWeight, index };
      return null;
    }).filter(Boolean).sort((a, b) => {
      const delta = b.score - a.score;
      if (delta !== 0) return delta;
      const timeDelta = Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt);
      if (timeDelta !== 0) return timeDelta;
      return b.index - a.index;
    }).slice(0, Math.max(1, limit));

    return scored.map(({ record, score }) => ({
      record: annotate(record, supersededByMap, conflictIndex, retractionsByTarget, resolutionIndex),
      score,
    }));
  }

  async status() {
    const { records, corrupt } = await this.log.load();
    const { claims, retractionEvents, resolutionEvents } = splitLifecycle(records);
    return {
      path: this.filePath,
      records: claims.length,
      retractions: retractionEvents.length,
      resolutions: resolutionEvents.length,
      corrupt: corrupt.length,
    };
  }

  // Store-wide, read-only lifecycle summary. The raw log is loaded rather than the
  // complete-only path: the purpose is to report readable records and damage together,
  // not to refuse and hide the readable part. Nothing is written, repaired, or inferred;
  // a corrupt line makes every count cover readable records only.
  async health() {
    let loaded;
    try {
      loaded = await this.log.load();
    } catch (err) {
      return summarizeKnowledgeHealth(null, [], {
        path: this.filePath,
        detail: err?.message ?? String(err),
      });
    }
    return summarizeKnowledgeHealth(loaded.records, loaded.corrupt, { path: this.filePath });
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

function validateSupersedeRefs(supersedes) {
  if (supersedes === undefined || supersedes === null) return [];
  if (!Array.isArray(supersedes)) throw new ValidationError('supersedes must be a list of record ids');
  if (supersedes.length > MAX_SUPERSEDES) {
    throw new ValidationError(`supersedes may name at most ${MAX_SUPERSEDES} records`);
  }
  const refs = [];
  for (const value of supersedes) {
    if (typeof value !== 'string') throw new ValidationError('each supersedes entry must be text');
    const ref = value.trim();
    if (ref.length === 0) throw new ValidationError('a supersedes entry is empty');
    if (ref.length > 64) throw new ValidationError('a supersedes entry is longer than 64 characters');
    if (CONTROL_CHARS.test(ref)) throw new ValidationError('a supersedes entry contains control characters');
    refs.push(ref);
  }
  return refs;
}

function resolveSupersedeTargets(records, refs, supersededByMap, retractionsByTarget, subject, relationship, object) {
  const ids = [];
  const seen = new Set();
  const relatedKey = conflictIndexKey(subject, relationship);
  const newTriple = normalizedTriple(subject, relationship, object);
  for (const [index, ref] of refs.entries()) {
    // A reference that matches no record is quoted back as a position, never as the
    // value the user typed: the value reaches the audit log through this error, so
    // echoing it would defeat the input redaction that already ran.
    const label = refs.length === 1 ? 'supersession target' : `supersession target #${index + 1}`;
    const matches = records.filter((r) => r.id === ref || r.id.startsWith(ref) || shortId(r.id) === ref);
    if (matches.length === 0) throw new ValidationError(`${label} not found`);
    if (matches.length > 1) {
      throw new ValidationError(`${label} is ambiguous; use a longer id prefix`);
    }
    const target = matches[0];
    if (seen.has(target.id)) {
      throw new ValidationError(`supersession target ${shortId(target.id)} is named more than once`);
    }
    if (isSuperseded(target, supersededByMap)) {
      throw new ValidationError(`supersession target ${shortId(target.id)} is already superseded`);
    }
    if ((retractionsByTarget.get(target.id)?.length ?? 0) > 0) {
      throw new ValidationError(`supersession target ${shortId(target.id)} is retracted; a historical record cannot be replaced`);
    }
    if (conflictIndexKey(target.subject, target.relationship) !== relatedKey) {
      throw new ValidationError(`supersession target ${shortId(target.id)} has a different subject or relationship; only a conflicting claim can be superseded`);
    }
    if (normalizedTriple(target.subject, target.relationship, target.object) === newTriple) {
      throw new ValidationError(`supersession target ${shortId(target.id)} states the same object; it is a duplicate, not a conflicting claim`);
    }
    seen.add(target.id);
    ids.push(target.id);
  }
  return ids;
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

// Live (non-superseded) records grouped by subject+relationship. Two records can only
// conflict when those fields match, so an index turns conflict lookup into a scan of one
// group instead of the whole store. Groups keep store order, so reported ids are unchanged.
function conflictIndexKey(subject, relationship) {
  return `${String(subject).trim().toLowerCase()}\x00${String(relationship).trim().toLowerCase()}`;
}

function buildConflictIndex(records, supersededByMap, retractionsByTarget) {
  const index = new Map();
  for (const record of records) {
    if (!isActive(record, supersededByMap, retractionsByTarget)) continue;
    const key = conflictIndexKey(record.subject, record.relationship);
    const group = index.get(key) ?? [];
    group.push(record);
    index.set(key, group);
  }
  return index;
}

function isSuperseded(record, supersededByMap) {
  return record.status === 'superseded' || (supersededByMap.get(record.id)?.length ?? 0) > 0;
}

function isRetracted(record, retractionsByTarget) {
  return (retractionsByTarget.get(record.id)?.length ?? 0) > 0;
}

// A claim participates in retrieval and conflict detection only when neither a
// supersession link nor a retraction event has retired it. Both are derived from the
// append-only log, so a reader that sees the claim also sees the event that retired it.
function isActive(record, supersededByMap, retractionsByTarget) {
  return !isSuperseded(record, supersededByMap) && !isRetracted(record, retractionsByTarget);
}

function summarizeRetraction(event) {
  return {
    id: event.id,
    reason: event.reason ?? null,
    createdAt: event.createdAt,
    operationId: event.provenance?.operationId ?? null,
    origin: event.provenance?.origin ?? null,
    updateMode: event.provenance?.updateMode ?? null,
  };
}

function annotate(record, supersededByMap, conflictIndex, retractionsByTarget = new Map(), resolutionIndex = null) {
  const sby = supersededByMap.get(record.id) ?? [];
  const selfSuperseded = isSuperseded(record, supersededByMap);
  const events = retractionsByTarget.get(record.id) ?? [];
  const retracted = events.length > 0;
  const retractionAmbiguous = events.length > 1;
  const both = retracted && selfSuperseded;
  const lifecycleNote = both
    ? 'both retracted and superseded'
    : retractionAmbiguous
      ? 'multiple retraction events'
      : null;
  const lifecycleState = lifecycleNote
    ? 'ambiguous'
    : retracted
      ? 'retracted'
      : selfSuperseded
        ? 'superseded'
        : null;
  const active = lifecycleState === null;

  // Detect live conflicts only among active claims with the same subject+relationship
  // but a different object. A historical record has no live conflicts, and an
  // ambiguous record is not treated as active.
  const recordKey = normalizedTriple(record.subject, record.relationship, record.object);
  const group = conflictIndex.get(conflictIndexKey(record.subject, record.relationship)) ?? [];
  const conflictIds = active ? group
    .filter((r) => r.id !== record.id && normalizedTriple(r.subject, r.relationship, r.object) !== recordKey)
    .map((r) => r.id) : [];

  // The stored status is a snapshot from write time. A conflict that has since been
  // retired is not live, so a stale "conflicting" status becomes "supported".
  const effectiveStatus = lifecycleState
    ?? (conflictIds.length > 0
      ? 'conflicting'
      : record.status === 'conflicting'
        ? 'supported'
        : record.status);

  // A recorded resolution is a user decision about this exact live group, not evidence
  // that the chosen claim is true. The conflict itself is kept: status stays
  // "conflicting" and every alternative remains in conflictsWith.
  let resolution = null;
  let conflictState = null;
  if (active && conflictIds.length > 0) {
    const applicable = resolutionIndex?.applicableGroups?.get(claimSetKey(group.map((r) => r.id))) ?? null;
    if (applicable) {
      resolution = { ...applicable, chosen: applicable.chosenId === record.id };
      conflictState = 'resolved';
    } else {
      conflictState = 'unresolved';
    }
  }

  return {
    ...record,
    status: effectiveStatus,
    lifecycleState: lifecycleState ?? effectiveStatus,
    lifecycleNote,
    active,
    conflictsWith: conflictIds,
    conflictState,
    resolution,
    supersededBy: sby,
    replaces: [...(record.supersededBy ?? [])],
    retractedBy: events.length === 1 ? events[0].id : null,
    retraction: events.length === 1 ? summarizeRetraction(events[0]) : null,
    retractionAmbiguous,
  };
}

// ---- lifecycle helpers ------------------------------------------------------

function splitLifecycle(records) {
  const claims = [];
  const retractionEvents = [];
  const resolutionEvents = [];
  for (const record of records) {
    if (record.kind === RETRACTION_KIND) retractionEvents.push(record);
    else if (record.kind === RESOLUTION_KIND) resolutionEvents.push(record);
    else claims.push(record);
  }
  const retractionsByTarget = new Map();
  for (const event of retractionEvents) {
    const list = retractionsByTarget.get(event.targetId) ?? [];
    list.push(event);
    retractionsByTarget.set(event.targetId, list);
  }
  return { claims, retractionEvents, resolutionEvents, retractionsByTarget };
}

// A resolution applies only to the exact conflict group it names: every named claim must
// still exist and be active, all must share subject and relationship with at least two
// different objects, and the live group must contain no other active claim. If the group
// grows or loses a member, the earlier decision is still stored and shown in history but
// no longer governs the current group, so the new state stays visible as unresolved.
// Events are read in store order, so the last applicable event for the same group wins.
// A verdict carrying one of these notes is ordinary history rather than damage: a newer
// decision overruled an earlier one, or the group changed after the decision was made.
// Both stay readable and neither makes the lifecycle view incomplete.
const ORDINARY_RESOLUTION_NOTES = new Set([
  'the live conflict group has a different set of claims',
  'a later resolution for the same claims governs',
]);

function buildResolutionIndex(claims, supersededByMap, retractionsByTarget, resolutionEvents) {
  const byId = new Map(claims.map((r) => [r.id, r]));
  const conflictIndex = buildConflictIndex(claims, supersededByMap, retractionsByTarget);
  const byClaim = new Map();
  const applicableGroups = new Map();
  const statusById = new Map();

  // Each event is first judged against the current store; then, among applicable events
  // for the same claim set, only the last one governs. An earlier decision over a group
  // that is still intact is not damage - the user changed their mind - so it stays in
  // history as a recorded decision that no longer governs.
  const judged = [];
  const lastApplicableBySet = new Map();
  for (const event of resolutionEvents) {
    for (const id of event.targetIds) {
      const list = byClaim.get(id) ?? [];
      list.push(event);
      byClaim.set(id, list);
    }
    const verdict = resolutionApplicability(event, byId, conflictIndex, supersededByMap, retractionsByTarget);
    judged.push({ event, verdict });
    if (verdict.applicable) lastApplicableBySet.set(claimSetKey(event.targetIds), event.id);
  }
  for (const { event, verdict } of judged) {
    const setKey = claimSetKey(event.targetIds);
    let effective = verdict;
    if (verdict.applicable) {
      if (lastApplicableBySet.get(setKey) !== event.id) {
        effective = { applicable: false, note: 'a later resolution for the same claims governs' };
      } else {
        applicableGroups.set(setKey, summarizeResolution(event));
      }
    }
    statusById.set(event.id, effective);
  }
  return { byClaim, applicableGroups, statusById };
}

function resolutionApplicability(event, byId, conflictIndex, supersededByMap, retractionsByTarget) {
  const targets = event.targetIds.map((id) => byId.get(id));
  if (targets.some((target) => !target)) {
    return { applicable: false, note: 'a targeted claim is not in the store' };
  }
  if (targets.some((target) => !isActive(target, supersededByMap, retractionsByTarget))) {
    return { applicable: false, note: 'a targeted claim is no longer active' };
  }
  const groupKeys = new Set(targets.map((target) => conflictIndexKey(target.subject, target.relationship)));
  if (groupKeys.size !== 1) {
    return { applicable: false, note: 'the targeted claims do not share a subject and relationship' };
  }
  const objects = new Set(targets.map((target) => normalizedTriple(target.subject, target.relationship, target.object)));
  if (objects.size < 2) {
    return { applicable: false, note: 'the targeted claims do not state at least two different objects' };
  }
  const group = conflictIndex.get([...groupKeys][0]) ?? [];
  const groupIds = new Set(group.map((r) => r.id));
  if (group.length !== event.targetIds.length || event.targetIds.some((id) => !groupIds.has(id))) {
    return { applicable: false, note: 'the live conflict group has a different set of claims' };
  }
  return { applicable: true, note: null };
}

function claimSetKey(ids) {
  return [...ids].sort().join('\x00');
}

function summarizeResolution(event) {
  return {
    id: event.id,
    targetIds: [...event.targetIds],
    chosenId: event.chosenId,
    reason: event.reason ?? null,
    createdAt: event.createdAt,
    operationId: event.provenance?.operationId ?? null,
    origin: event.provenance?.origin ?? null,
    updateMode: event.provenance?.updateMode ?? null,
  };
}

// ---- store-wide health ------------------------------------------------------

// Counting rules, applied to readable records only:
//  - a retraction event is a lifecycle event, never a claim;
//  - a supersession link is a property of a claim, so it never adds to the count;
//  - every claim is counted in exactly one state: active, superseded, retracted, or
//    ambiguous. Retracted-and-superseded and multiple-retraction records are ambiguous,
//    never active;
//  - conflict groups contain only active claims, grouped by normalized subject and
//    relationship, and count as a group only when at least two distinct objects remain;
//  - anomalies are detected facts about readable records. Missing links and corrupt
//    lines are limitations, not proof that the remainder of the store is healthy.
export function summarizeKnowledgeHealth(records, corrupt = [], { path = null, detail = null } = {}) {
  if (!Array.isArray(records)) {
    return {
      path,
      state: 'unavailable',
      inspected: false,
      complete: false,
      detail,
      claims: null,
      lifecycleEvents: null,
      retractions: null,
      resolutions: null,
      active: null,
      superseded: null,
      retracted: null,
      ambiguous: null,
      conflicts: {
        groups: null, claims: null, samples: [], resolvedGroups: null, resolvedClaims: null, totalGroups: null,
      },
      corruptLines: null,
      corrupt: [],
      chains: { components: null, largest: null, truncated: null },
      anomalies: { count: null, samples: [], truncated: false },
      attention: true,
    };
  }

  const { claims, retractionEvents, resolutionEvents, retractionsByTarget } = splitLifecycle(records);
  const byId = new Map(claims.map((r) => [r.id, r]));
  const supersededByMap = buildSupersededByMap(claims);
  const conflictIndex = buildConflictIndex(claims, supersededByMap, retractionsByTarget);
  const resolutionIndex = buildResolutionIndex(claims, supersededByMap, retractionsByTarget, resolutionEvents);

  const samples = [];
  let anomalyCount = 0;
  const anomaly = (message) => {
    anomalyCount += 1;
    if (samples.length < MAX_HEALTH_SAMPLES) samples.push(message);
  };

  let active = 0;
  let superseded = 0;
  let retracted = 0;
  let ambiguous = 0;
  for (const claim of claims) {
    const targets = retractionsByTarget.get(claim.id) ?? [];
    const isRet = targets.length > 0;
    const isSup = isSuperseded(claim, supersededByMap);
    if (targets.length > 1 || (isRet && isSup)) ambiguous += 1;
    else if (isRet) retracted += 1;
    else if (isSup) superseded += 1;
    else active += 1;
  }

  for (const claim of claims) {
    for (const predecessorId of new Set(claim.supersededBy ?? [])) {
      const predecessor = byId.get(predecessorId);
      if (!predecessor) {
        anomaly(`[${shortId(claim.id)}] supersedes [${shortId(predecessorId)}], which is not in the store`);
        continue;
      }
      if (conflictIndexKey(predecessor.subject, predecessor.relationship)
        !== conflictIndexKey(claim.subject, claim.relationship)) {
        anomaly(`[${shortId(claim.id)}] supersedes [${shortId(predecessor.id)}] with a different subject or relationship`);
      } else if (normalizedTriple(predecessor.subject, predecessor.relationship, predecessor.object)
        === normalizedTriple(claim.subject, claim.relationship, claim.object)) {
        anomaly(`[${shortId(claim.id)}] and [${shortId(predecessor.id)}] state the same triple; the link replaces no conflict`);
      }
    }
    if (claim.status === 'superseded' && (supersededByMap.get(claim.id)?.length ?? 0) === 0) {
      anomaly(`[${shortId(claim.id)}] has stored status superseded, but no successor names it`);
    }
  }

  for (const [targetId, successors] of supersededByMap) {
    if (successors.length > 1) {
      anomaly(`[${shortId(targetId)}] is named by ${successors.length} later records as superseded`);
    }
  }

  for (const event of retractionEvents) {
    if (!byId.has(event.targetId)) {
      anomaly(`retraction event [${shortId(event.id)}] targets [${shortId(event.targetId)}], which is not in the store`);
    }
  }
  for (const [targetId, list] of retractionsByTarget) {
    if (list.length > 1) anomaly(`[${shortId(targetId)}] has ${list.length} retraction events`);
    const target = byId.get(targetId);
    if (target && isSuperseded(target, supersededByMap)) {
      anomaly(`[${shortId(targetId)}] is both retracted and superseded`);
    }
  }

  const cycleNodes = countUnorderableClaims(claims, byId);
  if (cycleNodes > 0) {
    anomaly(`supersession links contain a cycle (${cycleNodes} claim(s) cannot be ordered by them)`);
  }

  // Resolution history is checked against the readable store. A missing target or an
  // incompatible group is damage, not a decision; a group that changed after the fact is
  // ordinary history and simply no longer governs. Every event remains in the log.
  for (const event of resolutionEvents) {
    const targets = event.targetIds.map((id) => byId.get(id));
    const missing = event.targetIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      anomaly(`resolution event [${shortId(event.id)}] targets ${missing.length} claim(s) not in the store`);
      continue;
    }
    const groupKeys = new Set(targets.map((target) => conflictIndexKey(target.subject, target.relationship)));
    if (groupKeys.size !== 1) {
      anomaly(`resolution event [${shortId(event.id)}] names claims with different subjects or relationships`);
    } else if (new Set(targets.map((target) => normalizedTriple(target.subject, target.relationship, target.object))).size < 2) {
      anomaly(`resolution event [${shortId(event.id)}] names fewer than two different objects`);
    }
    if (!event.targetIds.includes(event.chosenId)) {
      anomaly(`resolution event [${shortId(event.id)}] chooses a claim it does not name`);
    }
  }

  const conflicts = summarizeConflicts(conflictIndex, resolutionIndex);
  const chains = summarizeChains(claims, byId);

  return {
    path,
    state: corrupt.length > 0 ? 'damaged' : 'ok',
    inspected: true,
    complete: corrupt.length === 0,
    detail: null,
    claims: claims.length,
    lifecycleEvents: retractionEvents.length + resolutionEvents.length,
    retractions: retractionEvents.length,
    resolutions: resolutionEvents.length,
    active,
    superseded,
    retracted,
    ambiguous,
    conflicts,
    corruptLines: corrupt.length,
    corrupt: corrupt.map((c) => ({
      line: c.line,
      reason: c.reason,
      truncatedTail: Boolean(c.truncatedTail),
    })),
    chains,
    anomalies: { count: anomalyCount, samples, truncated: anomalyCount > samples.length },
    // Conflicts and ambiguity require a decision; superseded and retracted claims are
    // ordinary history and do not. A chain beyond the view bound is reported as a
    // limitation, not as damage.
    attention: corrupt.length > 0 || anomalyCount > 0 || ambiguous > 0 || conflicts.groups > 0,
  };
}

// A live conflict group counts as resolved only when an applicable resolution names
// exactly its current claims. `groups` and `claims` count what still requires a user
// decision; resolved groups are reported separately so a recorded decision is visible
// without making an unresolved conflict disappear.
function summarizeConflicts(conflictIndex, resolutionIndex) {
  const samples = [];
  let groups = 0;
  let claims = 0;
  let resolvedGroups = 0;
  let resolvedClaims = 0;
  let totalGroups = 0;
  for (const group of conflictIndex.values()) {
    const distinct = new Set(group.map((r) => normalizedTriple(r.subject, r.relationship, r.object)));
    if (distinct.size < 2) continue;
    totalGroups += 1;
    const resolved = resolutionIndex?.applicableGroups?.has(claimSetKey(group.map((r) => r.id))) ?? false;
    if (resolved) {
      resolvedGroups += 1;
      resolvedClaims += group.length;
      continue;
    }
    groups += 1;
    claims += group.length;
    if (samples.length < MAX_CONFLICT_SAMPLES) {
      samples.push(group.slice(0, MAX_CONFLICT_SAMPLES).map((r) => shortId(r.id)).join(', '));
    }
  }
  return { groups, claims, samples, resolvedGroups, resolvedClaims, totalGroups };
}

// Connected components of valid supersession links. A component larger than the
// history view bound is counted, but it is a display limit: the store is still readable.
function summarizeChains(claims, byId) {
  const adjacency = new Map();
  for (const claim of claims) {
    for (const predecessorId of claim.supersededBy ?? []) {
      if (!byId.has(predecessorId)) continue;
      if (!adjacency.has(claim.id)) adjacency.set(claim.id, new Set());
      if (!adjacency.has(predecessorId)) adjacency.set(predecessorId, new Set());
      adjacency.get(claim.id).add(predecessorId);
      adjacency.get(predecessorId).add(claim.id);
    }
  }
  const seen = new Set();
  let components = 0;
  let largest = 0;
  let truncated = 0;
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const queue = [start];
    seen.add(start);
    let size = 0;
    for (let i = 0; i < queue.length; i += 1) {
      size += 1;
      for (const neighbour of adjacency.get(queue[i]) ?? []) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          queue.push(neighbour);
        }
      }
    }
    components += 1;
    if (size > largest) largest = size;
    if (size > MAX_HISTORY_CHAIN) truncated += 1;
  }
  return { components, largest, truncated };
}

// Kahn's algorithm over successor -> predecessor links. Any node left without an order
// lies in a cycle or depends on one; the result is a lower bound on the affected claims.
function countUnorderableClaims(claims, byId) {
  const indegree = new Map(claims.map((c) => [c.id, 0]));
  const successorsOf = new Map(claims.map((c) => [c.id, []]));
  for (const claim of claims) {
    for (const predecessorId of new Set(claim.supersededBy ?? [])) {
      if (!byId.has(predecessorId)) continue;
      successorsOf.get(claim.id).push(predecessorId);
      indegree.set(predecessorId, indegree.get(predecessorId) + 1);
    }
  }
  const queue = [];
  for (const [id, degree] of indegree) if (degree === 0) queue.push(id);
  let ordered = 0;
  for (let i = 0; i < queue.length; i += 1) {
    ordered += 1;
    for (const next of successorsOf.get(queue[i])) {
      const degree = indegree.get(next) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  return claims.length - ordered;
}

// A malformed or credential-like target is refused without quoting the value: this
// message can reach the audit record through the execution error.
function validateRetractionRef(target) {
  if (typeof target !== 'string') throw new ValidationError('retraction target must be text');
  const ref = target.trim();
  if (ref.length === 0) throw new ValidationError('retraction target is empty');
  if (ref.length > 64) throw new ValidationError('retraction target is longer than 64 characters');
  if (CONTROL_CHARS.test(ref)) throw new ValidationError('retraction target contains control characters');
  if (containsSecret(ref)) {
    throw new ValidationError(
      'the retraction target looks like a password, key, or token; it was not used',
      'SECRET_REFUSED',
    );
  }
  return ref;
}

// Same refusal rules as a retraction target. The value is never quoted back because the
// message can reach the audit record through the execution error.
function validateResolutionRef(value, label) {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text`);
  const ref = value.trim();
  if (ref.length === 0) throw new ValidationError(`${label} is empty`);
  if (ref.length > 64) throw new ValidationError(`${label} is longer than 64 characters`);
  if (CONTROL_CHARS.test(ref)) throw new ValidationError(`${label} contains control characters`);
  if (containsSecret(ref)) {
    throw new ValidationError(
      `the ${label} looks like a password, key, or token; it was not used`,
      'SECRET_REFUSED',
    );
  }
  return ref;
}

function matchClaimRefs(records, ref) {
  return records.filter((r) => r.id === ref || r.id.startsWith(ref) || shortId(r.id) === ref);
}

function validateRetractionReason(reason) {
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== 'string') throw new ValidationError('reason must be text');
  const text = reason.trim();
  if (text.length === 0) return null;
  if (text.length > MAX_RETRACTION_REASON_CHARS) {
    throw new ValidationError(`reason exceeds ${MAX_RETRACTION_REASON_CHARS} characters`);
  }
  if (CONTROL_CHARS.test(text)) throw new ValidationError('reason contains control characters');
  if (containsSecret(text)) {
    throw new ValidationError('reason looks like a password, key, or token; it was not stored', 'SECRET_REFUSED');
  }
  return text;
}

function buildKnowledgeHistory(record, claims, byId, supersededByMap, conflictIndex, retractionsByTarget, resolutionIndex = null) {
  const annotated = annotate(record, supersededByMap, conflictIndex, retractionsByTarget, resolutionIndex);
  const events = retractionsByTarget.get(record.id) ?? [];
  const problems = new Set();

  const predecessorIds = [...new Set(record.supersededBy ?? [])];
  const successorIds = [...new Set(supersededByMap.get(record.id) ?? [])];
  const replaces = describeLinks(predecessorIds, byId, problems);
  const replacedBy = describeLinks(successorIds, byId, problems);

  if (successorIds.length > 1) problems.add('more than one later record names this record as superseded');
  if (record.status === 'superseded' && successorIds.length === 0) {
    problems.add('stored status is superseded but no successor record names it');
  }
  if (events.length > 1) problems.add('more than one retraction event targets this record');
  if (events.length > 0 && isSuperseded(record, supersededByMap)) {
    problems.add('record is both retracted and superseded');
  }

  // Every resolution that named this record is shown, including one that no longer
  // governs the live group. The decision is historical evidence; its applicability is
  // reported separately instead of being hidden or silently treated as current.
  const allResolutions = resolutionIndex?.byClaim?.get(record.id) ?? [];
  const shownResolutions = allResolutions.slice(-MAX_HISTORY_CHAIN);
  const resolutions = shownResolutions.map((event) => {
    const verdict = resolutionIndex?.statusById?.get(event.id) ?? { applicable: false, note: 'applicability could not be established' };
    if (!verdict.applicable && !ORDINARY_RESOLUTION_NOTES.has(verdict.note)) {
      problems.add(`resolution event ${shortId(event.id)} cannot govern the current store: ${verdict.note}`);
    }
    return {
      ...summarizeResolution(event),
      chosen: event.chosenId === record.id,
      applicable: Boolean(verdict.applicable),
      note: verdict.note,
    };
  });

  const chain = buildLifecycleChain(record.id, claims, byId, supersededByMap, retractionsByTarget, conflictIndex, resolutionIndex);
  for (const problem of chain.problems) problems.add(problem);

  return {
    record: annotated,
    state: annotated.lifecycleState,
    lifecycleNote: annotated.lifecycleNote,
    retraction: events.length === 1 ? summarizeRetraction(events[0]) : null,
    retractions: events.map(summarizeRetraction),
    retractionAmbiguous: events.length > 1,
    resolution: annotated.resolution,
    resolutions,
    resolutionsTruncated: allResolutions.length > shownResolutions.length,
    replaces,
    replacedBy,
    chain: chain.entries,
    chainTruncated: chain.truncated,
    complete: problems.size === 0 && !chain.truncated,
    problems: [...problems],
  };
}

function describeLinks(ids, byId, problems) {
  const out = [];
  for (const id of ids) {
    const linked = byId.get(id);
    if (!linked) {
      problems.add(`link target ${shortId(id)} is not in the store`);
      continue;
    }
    out.push({
      id: linked.id,
      shortId: shortId(linked.id),
      subject: linked.subject,
      relationship: linked.relationship,
      object: linked.object,
      createdAt: linked.createdAt,
    });
  }
  return out;
}

// Bounded traversal of the supersession component around one record. It follows only
// explicit stored links; a missing target is reported, never inferred, and the view
// never claims the chain is complete when it stopped early or a link is unresolved.
function buildLifecycleChain(startId, claims, byId, supersededByMap, retractionsByTarget, conflictIndex, resolutionIndex = null) {
  const problems = new Set();
  const component = new Set([startId]);
  const queue = [startId];
  let truncated = false;
  while (queue.length > 0) {
    const id = queue.shift();
    const claim = byId.get(id);
    if (!claim) continue;
    const neighbours = [
      ...(claim.supersededBy ?? []),
      ...(supersededByMap.get(id) ?? []),
    ];
    for (const neighbour of neighbours) {
      if (!byId.has(neighbour)) {
        problems.add(`link target ${shortId(neighbour)} is not in the store`);
        continue;
      }
      if (component.has(neighbour)) continue;
      if (component.size >= MAX_HISTORY_CHAIN) {
        truncated = true;
        continue;
      }
      component.add(neighbour);
      queue.push(neighbour);
    }
  }
  if (hasSupersessionCycle(component, byId)) {
    problems.add('supersession links form a cycle');
  }
  const ordered = [...component]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .sort((a, b) => {
      const delta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      if (delta !== 0) return delta;
      return claims.indexOf(a) - claims.indexOf(b);
    });
  const entries = ordered.map((item) => {
    const view = annotate(item, supersededByMap, conflictIndex, retractionsByTarget, resolutionIndex);
    return {
      id: item.id,
      shortId: shortId(item.id),
      subject: item.subject,
      relationship: item.relationship,
      object: item.object,
      state: view.lifecycleState,
      recordedAt: item.createdAt,
      replaces: [...(item.supersededBy ?? [])],
      replacedBy: [...new Set(supersededByMap.get(item.id) ?? [])],
    };
  });
  return { entries, truncated, problems: [...problems] };
}

function hasSupersessionCycle(ids, byId) {
  const state = new Map();
  const visit = (id) => {
    const mark = state.get(id) ?? 0;
    if (mark === 1) return true;
    if (mark === 2) return false;
    state.set(id, 1);
    for (const predecessor of byId.get(id)?.supersededBy ?? []) {
      if (ids.has(predecessor) && visit(predecessor)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const id of ids) {
    if (visit(id)) return true;
  }
  return false;
}

// Lowercase words, drop short words and words that carry no retrieval signal
// (question words, pronouns, fillers). Mirrors the memory tokenizer's policy.
export function tokenize(text) {
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}
