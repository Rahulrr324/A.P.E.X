// Persistent personal memory. Every record carries provenance: `source` says
// who supplied the content ('user' or 'model'), and `kind` separates user facts
// from model conclusions. A content SHA-256 lets reads detect tampering.
// `sensitivity` marks records that must never be sent to a model ('private').
import { createHash, randomUUID } from 'node:crypto';
import { JsonlStore } from './jsonl-store.js';
import { WriterLock } from './writer-lock.js';
import { StoreError, ValidationError } from '../errors.js';
import { CONTROL_CHARS, parseIsoInstant, shortId, singleLine } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { normalizeTokens, queryTokens } from '../retrieval/normalize.js';
import { isIdentifierToken, queryWeights } from '../retrieval/relevance.js';

export const MEMORY_SCHEMA = 1;
export const MAX_CONTENT_CHARS = 4000;
// A store this large is not snapshotted in process memory: the derived parse cache is a
// performance aid, so it is bounded rather than allowed to grow with the user's data.
export const MEMORY_PARSE_CACHE_BYTES = 32 * 1024 * 1024;
// Minimum retrieval score for a record to be included in a model prompt.
// Records below it are still shown to the user by the memory actions.
export const PROMPT_RELEVANCE_MIN = 0.2;
const KINDS = new Set(['user_fact', 'model_conclusion']);
const SOURCES = new Set(['user', 'model']);
const SENSITIVITIES = new Set(['normal', 'private']);
const UPDATE_MODES = new Set(['user_confirmed', 'model_proposed', 'unresolved_conflict']);
const OPERATION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const BACKEND_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MEMORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FUZZY_MIN_SIMILARITY = 0.6;
const FUZZY_MIN_LENGTH = 4;
// Health output is a summary, not a dump: exact counts, bounded examples.
const MAX_HEALTH_SAMPLES = 20;

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function validateContent(content) {
  if (typeof content !== 'string') throw new ValidationError('content must be text');
  const text = content.trim();
  if (text.length === 0) throw new ValidationError('content is empty');
  if (text.length > MAX_CONTENT_CHARS) {
    throw new ValidationError(`content exceeds ${MAX_CONTENT_CHARS} characters`);
  }
  if (CONTROL_CHARS.test(text)) throw new ValidationError('content contains control characters');
  if (containsSecret(text)) {
    throw new ValidationError('content looks like a password, key, or token; it was not stored', 'SECRET_REFUSED');
  }
  return text;
}

function validateKindSource(kind, source) {
  if (!KINDS.has(kind)) throw new ValidationError(`unknown memory kind: ${singleLine(kind, 40)}`);
  if (!SOURCES.has(source)) throw new ValidationError(`unknown memory source: ${singleLine(source, 40)}`);
  if ((kind === 'model_conclusion') !== (source === 'model')) {
    throw new ValidationError('model_conclusion must come from the model, and only the model may produce it');
  }
}

function sanitizeProvenance(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  if (typeof p.origin === 'string' && p.origin.length <= 64) out.origin = p.origin;
  if (typeof p.operationId === 'string' && OPERATION_ID_RE.test(p.operationId)) out.operationId = p.operationId;
  if (typeof p.backend === 'string' && BACKEND_RE.test(p.backend)) out.backend = p.backend;
  if (typeof p.context === 'string' && p.context.length <= 128) out.context = p.context;
  return out;
}

function finalizeProvenance({ source, provenance = {} }) {
  const base = sanitizeProvenance(provenance);
  const provenanceObject = provenance && typeof provenance === 'object' ? provenance : {};
  if (provenanceObject.updateMode !== undefined || provenanceObject.replaces !== undefined) {
    throw new ValidationError('correction provenance can only be created by an authorized correction operation');
  }

  if (source === 'model') {
    return { ...base, updateMode: 'model_proposed' };
  }

  if (source !== 'user') {
    throw new ValidationError(`unsupported source: ${singleLine(source, 40)}`);
  }

  const origin = base.origin ?? 'user_request';
  if (!['user_request', 'user_approved', 'user_confirmation'].includes(origin)) {
    throw new ValidationError('user memory provenance must come from an authorized user operation');
  }
  return {
    ...base,
    origin,
    updateMode: 'user_confirmed',
  };
}

// Returns a problem description for a stored line, or null when it is valid.
export function validateMemoryRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if (r.schema !== MEMORY_SCHEMA) return 'unsupported schema';
  if (typeof r.id !== 'string' || r.id.length === 0) return 'missing id';
  if (!KINDS.has(r.kind)) return 'unknown kind';
  if (!SOURCES.has(r.source)) return 'unknown source';
  if ((r.kind === 'model_conclusion') !== (r.source === 'model')) return 'kind/source mismatch';
  if (r.sensitivity !== undefined && !SENSITIVITIES.has(r.sensitivity)) return 'unknown sensitivity';
  if (typeof r.content !== 'string') return 'missing content';
  if (sha256Hex(r.content) !== r.contentSha256) return 'content hash mismatch';
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return 'bad timestamp';
  if (!r.provenance || typeof r.provenance !== 'object') return 'missing provenance';
  if (r.provenance.updateMode !== undefined && !UPDATE_MODES.has(r.provenance.updateMode)) return 'bad provenance update mode';
  if (r.provenance.replaces !== undefined && (!Array.isArray(r.provenance.replaces) || r.provenance.replaces.some((id) => typeof id !== 'string' || id.length === 0))) return 'bad provenance replaces list';
  return null;
}

// Light normalisation, shared with the knowledge store: lower-case words, drop the words that carry
// no retrieval signal, keep negations and identifiers whole, strip common suffixes.
export function tokenize(text) {
  return normalizeTokens(text, { stem: true });
}

function trigrams(word) {
  const padded = `  ${word} `;
  const set = new Set();
  for (let i = 0; i < padded.length - 2; i += 1) set.add(padded.slice(i, i + 3));
  return set;
}

// Dice coefficient over character trigrams: 1 for identical words, high for
// near-misses such as typos or related word forms.
export function similarity(a, b) {
  if (a === b) return 1;
  return similarityOfTrigrams(a, trigrams(a), b, trigrams(b));
}

function similarityOfTrigrams(a, ta, b, tb) {
  if (a === b) return 1;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return (2 * shared) / (ta.size + tb.size);
}

// Near-miss lookup for one search. Comparing every query term with every word of
// every record is quadratic in a way a long request can reach: a 4,000-character
// request is within the controller's limit and made a 1,000-record search take about
// 32 seconds. A word that shares no trigram with the term has similarity 0, so only
// words reached from the term's own trigrams are candidates. Each word's trigrams are
// built once, so both the candidate lookup and the direct comparison reuse them.
function buildFuzzyIndex(docs) {
  const words = new Map();
  docs.forEach((wordSet, index) => {
    for (const word of wordSet) {
      if (word.length < FUZZY_MIN_LENGTH) continue;
      // An identifier, version, or date is compared exactly. A near-miss match would let AP-10
      // retrieve AP-11 and 2026 retrieve 2027, which is the distinction retrieval must keep.
      if (isIdentifierToken(word)) continue;
      let entry = words.get(word);
      if (!entry) {
        entry = { trigrams: trigrams(word), docs: [] };
        words.set(word, entry);
      }
      entry.docs.push(index);
    }
  });
  const byTrigram = new Map();
  for (const [word, entry] of words) {
    for (const trigram of entry.trigrams) {
      const list = byTrigram.get(trigram) ?? [];
      list.push(word);
      byTrigram.set(trigram, list);
    }
  }
  return { words, byTrigram };
}

// For each term, the best fuzzy score per record, against an index built from one record set.
// Terms shorter than the minimum are never compared, exactly as before.
function fuzzyScores(terms, index) {
  const scores = new Map();
  for (const term of terms) {
    if (term.length < FUZZY_MIN_LENGTH) continue;
    if (isIdentifierToken(term)) continue;
    const termTrigrams = trigrams(term);
    const candidates = new Set();
    for (const trigram of termTrigrams) {
      for (const word of index.byTrigram.get(trigram) ?? []) candidates.add(word);
    }
    const perDoc = new Map();
    for (const word of candidates) {
      const entry = index.words.get(word);
      const score = similarityOfTrigrams(term, termTrigrams, word, entry.trigrams);
      if (score < FUZZY_MIN_SIMILARITY) continue;
      for (const docIndex of entry.docs) {
        if (score > (perDoc.get(docIndex) ?? 0)) perDoc.set(docIndex, score);
      }
    }
    if (perDoc.size > 0) scores.set(term, perDoc);
  }
  return scores;
}

export function isPromptEligible(record) {
  return record.sensitivity !== 'private' && !containsSecret(record.content);
}

export function getRecordStatus(record, conflictIds = [], replacedByIds = []) {
  if (conflictIds.length > 0) return 'unresolved_conflict';
  if (replacedByIds.length > 0) return 'superseded';
  const mode = record?.provenance?.updateMode ?? (record?.source === 'model' ? 'model_proposed' : 'user_confirmed');
  if (mode === 'model_proposed') return 'model_proposed';
  if (mode === 'user_confirmed') return 'user_confirmed';
  if (mode === 'unresolved_conflict') return 'unresolved_conflict';
  return 'stored';
}

function replacesRecord(a, b) {
  return a?.provenance?.replaces?.includes(b?.id) || b?.provenance?.replaces?.includes(a?.id);
}

function dedupeKey(record) {
  return `${record.kind}|${record.source}|${record.sensitivity ?? 'normal'}|${String(record.content).trim().toLowerCase()}`;
}

function normalizeConflictText(text) {
  let normalized = String(text).toLowerCase();
  normalized = normalized.replace(/\bcode\s+name\b/g, 'codename');
  normalized = normalized.replace(/\bcode-name\b/g, 'codename');
  normalized = normalized.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return tokenize(normalized).join(' ');
}

function extractConflictClause(text) {
  const cleaned = String(text).trim().replace(/\s+/g, ' ');
  const patterns = [
    /^(.*?)(?:\s+(?:is|are|was|were|be|been))\s+(.+)$/i,
    /^(.*?)(?:\s+(?:called|named|known as|nicknamed))\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (!match) continue;
    const subject = normalizeConflictText(match[1]);
    const value = normalizeConflictText(match[2]);
    if (subject && value) return { subject, value };
  }
  return null;
}

const DATE_WORDS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'today', 'tomorrow', 'yesterday']);

// Two claims already reduced to subject and value. Claims with different subjects
// cannot contradict each other, which is what lets search compare within subject
// groups instead of every pair.
function claimsConflict(left, right) {
  if (left.subject !== right.subject) return false;
  if (left.value === right.value) return false;
  // A longer value that merely qualifies an existing value is not enough
  // evidence to call the claims contradictory.
  if (left.value.startsWith(`${right.value} `) || right.value.startsWith(`${left.value} `)) return false;
  if (left.value.split(' ').some((word) => DATE_WORDS.has(word)) || right.value.split(' ').some((word) => DATE_WORDS.has(word))) {
    return false;
  }
  return true;
}

function isPotentialConflict(a, b) {
  if (!a || !b || a.id === b.id) return false;
  const aText = String(a.content).trim();
  const bText = String(b.content).trim();
  if (aText === bText) return false;

  const left = extractConflictClause(aText);
  const right = extractConflictClause(bText);
  if (!left || !right) return false;
  return claimsConflict(left, right);
}

// Read-only, store-wide conflict scan for a bounded set of records. Retrieval compares
// only the records it returns; a caller that needs to describe what the store holds uses
// this instead, and must state that the clause patterns are heuristic. Records are grouped
// by clause subject and the same pairwise rule retrieval applies is tested between the
// distinct values, so one contested subject yields one group rather than one entry per
// record pair. It never merges records and never decides which value is right.
export function findMemoryConflictGroups(records) {
  if (!Array.isArray(records)) return [];
  const bySubject = new Map();
  for (const record of records) {
    const clause = extractConflictClause(String(record?.content ?? '').trim());
    if (!clause) continue;
    const list = bySubject.get(clause.subject) ?? [];
    list.push({ record, value: clause.value });
    bySubject.set(clause.subject, list);
  }
  const groups = [];
  for (const [subject, entries] of bySubject) {
    const values = [...new Set(entries.map((entry) => entry.value))];
    if (values.length < 2) continue;
    let contested = false;
    for (let i = 0; i < values.length && !contested; i += 1) {
      for (let j = i + 1; j < values.length && !contested; j += 1) {
        if (claimsConflict({ subject, value: values[i] }, { subject, value: values[j] })) contested = true;
      }
    }
    if (!contested) continue;
    groups.push({ subject, records: entries.map((entry) => entry.record), values });
  }
  return groups;
}

// The newest `limit` visible records, newest first, each annotated with the corrections
// that retired it and the status those imply. Shared by list() and projectionRead() so the
// two can never disagree about what a record means.
function memoryWindow(records, { limit, includePrivate }) {
  const visible = records.filter((r) => includePrivate || r.sensitivity !== 'private');
  const replacedByIds = new Map();
  for (const record of records) {
    for (const targetId of record.provenance?.replaces ?? []) {
      const ids = replacedByIds.get(targetId) ?? [];
      ids.push(record.id);
      replacedByIds.set(targetId, ids);
    }
  }
  return visible.slice(-Math.max(1, limit)).reverse().map((record) => {
    const replacedBy = replacedByIds.get(record.id) ?? [];
    return {
      ...record,
      replacedBy,
      status: getRecordStatus(record, [], replacedBy),
    };
  });
}

export class MemoryStore {
  // Tokenised corpus and fuzzy index for one certified snapshot. The content hash is the identity:
  // a changed file - append, same-length rewrite, replacement - produces a different key, so an
  // entry can never describe records this read did not receive. A read that certifies nothing
  // (uncertified, oversize, or one immediately after this instance's own append) neither reuses nor
  // retains. Two entries at most: one with private records, one without.
  #retrievalMemo = null;
  #retrievalBuilds = 0;
  #retrievalHits = 0;
  #retrievalMisses = 0;

  constructor(filePath, {
    now = () => new Date(),
    parseCacheBytes = MEMORY_PARSE_CACHE_BYTES,
    lockWaitMs,
    lockRetryMs,
    lockRetryMaxMs,
  } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.log = new JsonlStore(filePath, { validateRecord: validateMemoryRecord, parseCacheBytes });
    // Every write here is a read-modify-write: it reads the whole authoritative log, derives a
    // decision from those records, and appends one record. The lock covers that whole sequence so
    // a second process cannot make its decision from a state this process has not written yet.
    this.writeLock = new WriterLock(filePath, { waitMs: lockWaitMs, retryMs: lockRetryMs, retryMaxMs: lockRetryMaxMs });
  }

  // Read-only introspection of retrieval reuse, like the parse snapshot stats: it describes a
  // performance aid, never stored state, and no decision about a record may be taken from it. A
  // build counts one tokenised corpus and fuzzy index; a hit counts a search answered from one.
  get retrievalIndexStats() {
    return {
      cached: this.#retrievalMemo !== null,
      builds: this.#retrievalBuilds,
      hits: this.#retrievalHits,
      misses: this.#retrievalMisses,
      authorizes: false,
    };
  }

  async add({ content, kind = 'user_fact', source = 'user', sensitivity = 'normal', provenance = {} } = {}) {
    const text = validateContent(content);
    validateKindSource(kind, source);
    if (!SENSITIVITIES.has(sensitivity)) throw new ValidationError(`unknown sensitivity: ${singleLine(sensitivity, 40)}`);
    // The provenance is derived from the request alone, so it is normalised before coordination is
    // sought: an unauthorized or malformed request must not occupy the lock.
    const normalizedProvenance = finalizeProvenance({ source, provenance });
    return this.writeLock.run(async () => {
      // A damaged store must not accept new records: appending would bury the
      // corrupt lines, and the write would be reported as verified while earlier
      // memory is unreadable.
      const records = await this.#loadComplete({ operation: 'write', beforeAppend: true });
      const id = randomUUID();
      if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
      const record = {
        schema: MEMORY_SCHEMA,
        id,
        kind,
        source,
        sensitivity,
        content: text,
        contentSha256: sha256Hex(text),
        createdAt: this.now().toISOString(),
        provenance: normalizedProvenance,
      };
      await this.log.append(record);
      return record;
    });
  }

  async correct({ targetId, content, origin } = {}) {
    if (origin !== 'user') throw new ValidationError('memory corrections require an authorized user-origin operation');
    if (typeof targetId !== 'string' || !MEMORY_ID_RE.test(targetId)) {
      throw new ValidationError('replacement target must be a full memory record ID');
    }
    const text = validateContent(content);
    return this.writeLock.run(async () => {
      const records = await this.#loadComplete({ beforeAppend: true });
      const target = records.find((record) => record.id === targetId);
      if (!target) throw new ValidationError(`replacement target ${targetId} not found in memory`);
      // Read under the lock, so a correction recorded by another process while this one waited is
      // seen here and refused instead of becoming a second replacement of the same claim.
      if (records.some((record) => record.provenance?.replaces?.includes(targetId))) {
        throw new ValidationError('that claim was already corrected; target the current claim instead');
      }
      if (!SENSITIVITIES.has(target.sensitivity ?? 'normal')) {
        throw new ValidationError('replacement target has invalid sensitivity metadata');
      }

      const record = {
        schema: MEMORY_SCHEMA,
        id: randomUUID(),
        kind: 'user_fact',
        source: 'user',
        sensitivity: target.sensitivity ?? 'normal',
        content: text,
        contentSha256: sha256Hex(text),
        createdAt: this.now().toISOString(),
        provenance: {
          origin: 'user_memory_correction',
          updateMode: 'user_confirmed',
          replaces: [target.id],
        },
      };
      if (!isPotentialConflict(target, record)) {
        throw new ValidationError('replacement content does not contradict the selected claim; nothing was changed');
      }
      if (records.some((existing) => existing.id === record.id)) throw new StoreError('identifier collision; nothing written');
      await this.log.append(record);
      return record;
    });
  }

  // Read-only view of the writer lock: the claim, its takeover tokens and the recovery guard. It
  // never creates, removes or waits for the lock, so a report on a held write cannot disturb it.
  async lockReport() {
    return this.writeLock.state();
  }

  // Explicit recovery for the abandoned takeover tokens of a dead writer, with the task lock's
  // limits: a live holder, a live takeover or an unidentified holder refuses, and the claim
  // itself is left for the ordinary election. See ../tasks/lock-recovery.js.
  async recover() {
    return this.writeLock.recover();
  }

  async get(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    const { records } = await this.log.load();
    return records.find((r) => r.id === id) ?? null;
  }

  // A bounded read of specific records, used by the late evidence re-check. One file read answers
  // every id, so re-checking a response's citations does not read and hash the store once per id.
  // Each returned record carries the same derived `status` a search hit would: a record that a
  // later correction replaced is superseded even though the raw line still says otherwise.
  async getMany(ids) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.length > 0));
    const found = new Map();
    if (wanted.size === 0) return found;
    const { records } = await this.log.load();
    // The successor's id, not the replaced record's own id: the annotation has to agree with
    // memoryWindow, where a correction names the record that retired the earlier one.
    const replacedBy = new Map();
    for (const record of records) {
      for (const targetId of record.provenance?.replaces ?? []) {
        if (!wanted.has(targetId)) continue;
        const ids = replacedBy.get(targetId) ?? [];
        ids.push(record.id);
        replacedBy.set(targetId, ids);
      }
    }
    for (const record of records) {
      if (!wanted.has(record.id)) continue;
      const successors = replacedBy.get(record.id) ?? [];
      found.set(record.id, { ...record, replacedBy: successors, status: getRecordStatus(record, [], successors) });
    }
    return found;
  }

  // A bounded, fail-closed read for the cross-store belief trace. One file read answers every id
  // and also reports the store-wide heuristic conflict group each record belongs to, so a trace
  // can say that a record disagrees with another stored record without rebuilding the index once
  // per id. Unlike getMany, a damaged store refuses the read: a trace must not describe a partial
  // corpus as the whole store.
  async traceMany(ids, { at = null } = {}) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.length > 0));
    const found = new Map();
    if (wanted.size === 0) return found;
    const records = await this.#loadComplete({ operation: 'trace' });
    // A historical read reconstructs the store as it stood at the cutoff. A record created after
    // it cannot supply a replacement, a conflict, or a status for that earlier time.
    let cutoff = null;
    if (at !== null && at !== undefined) {
      const parsed = parseIsoInstant(at);
      if (parsed === null) throw new ValidationError('at must be an ISO date or an ISO date-time with a time zone');
      cutoff = Date.parse(parsed);
    }
    const known = cutoff === null
      ? records
      : records.filter((record) => {
        const created = Date.parse(record.createdAt);
        return Number.isFinite(created) && created <= cutoff;
      });
    const knownIds = new Set(known.map((record) => record.id));
    const replacedBy = new Map();
    for (const record of known) {
      for (const targetId of record.provenance?.replaces ?? []) {
        const list = replacedBy.get(targetId) ?? [];
        list.push(record.id);
        replacedBy.set(targetId, list);
      }
    }
    // A replaced record is history, so it cannot be part of a live disagreement. The group scan
    // uses the same clause rule retrieval uses and is explicitly heuristic.
    const active = known.filter((record) => (replacedBy.get(record.id) ?? []).length === 0);
    const conflictById = new Map();
    for (const group of findMemoryConflictGroups(active)) {
      const recordIds = group.records.map((record) => record.id).sort();
      for (const record of group.records) {
        conflictById.set(record.id, {
          subject: group.subject,
          values: [...group.values],
          recordIds: recordIds.filter((id) => id !== record.id),
        });
      }
    }
    for (const record of records) {
      if (!wanted.has(record.id)) continue;
      if (!knownIds.has(record.id)) {
        found.set(record.id, {
          found: false,
          id: record.id,
          recordedAt: record.createdAt,
          recordedLater: true,
        });
        continue;
      }
      const replacements = replacedBy.get(record.id) ?? [];
      const conflict = conflictById.get(record.id) ?? null;
      found.set(record.id, {
        found: true,
        id: record.id,
        content: record.content,
        kind: record.kind,
        source: record.source,
        sensitivity: record.sensitivity ?? 'normal',
        createdAt: record.createdAt,
        replacedBy: replacements,
        conflict,
        status: getRecordStatus(record, conflict?.recordIds ?? [], replacements),
      });
    }
    return found;
  }

  async #loadComplete({ operation = 'retrieval', beforeAppend = false, certification = null } = {}) {
    // A write reads through the incremental validated state, so one append no longer costs the
    // whole store's parse and validation. Nothing about the rule below changes: the records it
    // returns come from the same parser and the same integrity rules, and a state is only ever
    // retained for a file that had no damage in it, so a damaged store still reaches this refusal.
    const { records, corrupt } = beforeAppend
      ? await this.log.loadForAppend()
      : await this.log.load({ certification });
    if (corrupt.length > 0) {
      throw new StoreError(`memory store contains ${corrupt.length} corrupt line(s); refusing incomplete ${operation}`);
    }
    return records;
  }

  // The tokenised pool and fuzzy index for these exact records, reused only while the read's
  // content key still describes them. A search asks the same store the same question repeatedly -
  // across requests and within one - and rebuilding 4,000 token sets and their trigram index each
  // time was the dominant cost of memory retrieval.
  #corpusFor(records, key, includePrivate) {
    const memo = key !== null && this.#retrievalMemo?.key === key ? this.#retrievalMemo : null;
    const cached = memo?.corpora.get(includePrivate);
    if (cached) {
      this.#retrievalHits += 1;
      return cached;
    }
    this.#retrievalMisses += 1;
    if (key !== null && !memo) this.#retrievalMemo = { key, corpora: new Map() };
    this.#retrievalBuilds += 1;
    const pool = records.filter((r) => includePrivate || r.sensitivity !== 'private');
    const docs = pool.map((record) => new Set(tokenize(record.content)));
    const corpus = { pool, docs, fuzzyIndex: buildFuzzyIndex(docs) };
    if (key !== null) this.#retrievalMemo.corpora.set(includePrivate, corpus);
    return corpus;
  }

  async list({ limit = 20, includePrivate = true } = {}) {
    const records = await this.#loadComplete();
    return memoryWindow(records, { limit, includePrivate });
  }

  // One authoritative read that answers both questions the world-state projection asks:
  // what the store holds (the store-wide integrity summary) and the newest bounded records
  // with their lifecycle status. health() and list() separately read, parse and validate the
  // file twice; this reads it once, so the two views cannot come from two different file
  // states and a projection cannot be handed a record set that its own integrity summary
  // does not describe. The integrity rules are the same ones health() already applies.
  async projectionRead({ limit = 20, includePrivate = true } = {}) {
    let loaded;
    try {
      loaded = await this.log.load();
    } catch (err) {
      return {
        health: summarizeMemoryHealth(null, [], { path: this.filePath, detail: err?.message ?? String(err) }),
        records: null,
      };
    }
    const health = summarizeMemoryHealth(loaded.records, loaded.corrupt, { path: this.filePath });
    const usable = health.inspected === true && health.corruptLines === 0;
    return {
      health,
      records: usable ? memoryWindow(loaded.records, { limit, includePrivate }) : null,
    };
  }

  // Ranked retrieval. Each query term is weighted by its rarity in the store
  // (IDF) and matches a record term exactly, or approximately (character
  // trigram similarity >= 0.6) for longer words that are not identifiers. The
  // score is in [0, 1] and is a lexical coverage ratio, not a probability.
  // Ties go to the newer record. `includePrivate: false` omits private records.
  // `diagnostics`, when given an object, receives the bounded query profile:
  // the tokens used, how many the token bound dropped, the terms no record
  // holds, and how many records matched and were returned.
  async search(query, { limit = 5, includePrivate = true, diagnostics = null } = {}) {
    const { tokens: terms, dropped: droppedTokens, total: totalTokens } = queryTokens(query, { stem: true });
    const certification = { key: null };
    const records = await this.#loadComplete({ certification });
    // A bounded, fixed-key profile of what this search asked and what the store could answer. It is
    // filled in place so the return shape stays the ranked array every caller already reads.
    const profile = {
      terms, droppedTokens, totalTokens, unmatched: [], corpusSize: 0, matched: 0, returned: 0, limit,
    };
    const explain = diagnostics && typeof diagnostics === 'object' ? diagnostics : null;
    if (explain) Object.assign(explain, profile);
    if (terms.length === 0) return [];
    const { pool, docs, fuzzyIndex } = this.#corpusFor(records, certification.key, includePrivate);

    const fuzzy = fuzzyScores(terms, fuzzyIndex);
    const df = new Map();
    for (const t of terms) {
      let count = docs.filter((d) => d.has(t)).length;
      for (const [index, best] of fuzzy.get(t) ?? []) {
        if (best > 0 && !docs[index].has(t)) count += 1;
      }
      df.set(t, count);
    }
    const n = pool.length;
    const { idf, totalWeight, unmatched } = queryWeights(terms, df, n);

    const scored = [];
    pool.forEach((record, index) => {
      const words = docs[index];
      let matched = 0;
      for (const t of terms) {
        const best = words.has(t) ? 1 : (fuzzy.get(t)?.get(index) ?? 0);
        matched += idf.get(t) * best;
      }
      if (matched > 0) scored.push({ record, score: matched / totalWeight, index });
    });
    scored.sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      const timeDelta = Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt);
      if (timeDelta !== 0) return timeDelta;
      return b.index - a.index;
    });

    const unique = [];
    const seen = new Map();
    for (const item of scored) {
      const key = dedupeKey(item.record);
      const existingIndex = seen.get(key);
      if (existingIndex !== undefined) {
        const existing = unique[existingIndex];
        const existingIsCorrection = (existing.record.provenance?.replaces?.length ?? 0) > 0;
        const itemIsCorrection = (item.record.provenance?.replaces?.length ?? 0) > 0;
        if (itemIsCorrection && !existingIsCorrection) unique[existingIndex] = item;
        continue;
      }
      seen.set(key, unique.length);
      unique.push(item);
    }
    const conflictIds = new Map();
    const replacedByIds = new Map();
    for (const item of unique) {
      for (const targetId of item.record.provenance?.replaces ?? []) {
        const replacements = replacedByIds.get(targetId) ?? [];
        replacements.push(item.record.id);
        replacedByIds.set(targetId, replacements);
      }
    }
    // A claim is reduced to its subject and value once, then compared only with claims
    // that share its subject. Most records state no subject/value claim at all, so the
    // old all-pairs form re-parsed every record for every other record: a broad query
    // over 3,000 records took about 27 seconds, almost all of it in pairs whose subjects
    // could never match. Grouping does one parse per record and visits only the pairs
    // that can conflict; group members keep the ranked order, so the recorded conflict
    // ids and their order are unchanged.
    const groups = new Map();
    // Only the returned window exposes conflict ids. A returned record must still list every
    // partner it conflicts with, but a pair between two records that are both outside the window
    // produces ids nothing can read. At 2,000 same-subject records that unused work was 2 million
    // comparisons and most of a 2.6-second search. Skipping those pairs leaves every observed
    // value unchanged: each window record still receives its partners in the same order.
    const returnedIds = new Set(
      unique.slice(0, Math.max(1, limit)).map((item) => item.record.id),
    );
    for (const item of unique) {
      const text = String(item.record.content).trim();
      const clause = extractConflictClause(text);
      if (!clause) continue;
      const group = groups.get(clause.subject) ?? [];
      group.push({ record: item.record, text, clause });
      groups.set(clause.subject, group);
    }
    for (const group of groups.values()) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const left = group[i];
          const right = group[j];
          if (!returnedIds.has(left.record.id) && !returnedIds.has(right.record.id)) continue;
          if (left.text === right.text) continue;
          if (replacesRecord(left.record, right.record)) continue;
          if (!claimsConflict(left.clause, right.clause)) continue;
          const leftIds = conflictIds.get(left.record.id) ?? [];
          leftIds.push(right.record.id);
          conflictIds.set(left.record.id, leftIds);
          const rightIds = conflictIds.get(right.record.id) ?? [];
          rightIds.push(left.record.id);
          conflictIds.set(right.record.id, rightIds);
        }
      }
    }
    const returned = unique.slice(0, Math.max(1, limit));
    if (explain) {
      // `matched` is the deduplicated set before the bound, so `matched - returned` is exactly what
      // the source limit cut. Counting the pre-dedupe `scored` instead would report a collapsed
      // duplicate as a record the limit excluded, which is a different limitation with a different
      // disclosure.
      Object.assign(explain, {
        unmatched, corpusSize: n, matched: unique.length, returned: returned.length,
      });
    }
    return returned.map(({ record, score }) => ({
      record,
      score,
      conflict: conflictIds.get(record.id) ?? [],
      replaces: record.provenance?.replaces ?? [],
      replacedBy: replacedByIds.get(record.id) ?? [],
      status: getRecordStatus(record, conflictIds.get(record.id) ?? [], replacedByIds.get(record.id) ?? []),
    }));
  }

  async status() {
    const { records, corrupt } = await this.log.load();
    return { path: this.filePath, records: records.length, corrupt: corrupt.length };
  }

  // Read-only integrity summary. The raw log is loaded rather than the complete-only
  // path so damage and the readable part are reported together. Nothing is written,
  // repaired, or sent to a model. A record's presence proves only that it parsed and
  // that its content hash matches; it says nothing about whether the content is true.
  async health() {
    let loaded;
    try {
      loaded = await this.log.load();
    } catch (err) {
      return summarizeMemoryHealth(null, [], {
        path: this.filePath,
        detail: err?.message ?? String(err),
      });
    }
    return summarizeMemoryHealth(loaded.records, loaded.corrupt, { path: this.filePath });
  }
}

export function summarizeMemoryHealth(records, corrupt = [], { path = null, detail = null } = {}) {
  if (!Array.isArray(records)) {
    return {
      path,
      state: 'unavailable',
      inspected: false,
      complete: false,
      detail,
      records: null,
      corruptLines: null,
      corrupt: [],
      kinds: null,
      sources: null,
      sensitivities: null,
      updateModes: null,
      corrections: null,
      replacedClaims: null,
      privateRecords: null,
      anomalies: { count: null, samples: [], truncated: false },
      attention: true,
    };
  }

  const kinds = { user_fact: 0, model_conclusion: 0 };
  const sources = { user: 0, model: 0 };
  const sensitivities = { normal: 0, private: 0 };
  const updateModes = { user_confirmed: 0, model_proposed: 0, unresolved_conflict: 0 };
  const ids = new Set();
  const duplicateIds = new Set();
  const replacedBy = new Map();
  const replacementTargets = new Set();
  let corrections = 0;

  for (const record of records) {
    kinds[record.kind] = (kinds[record.kind] ?? 0) + 1;
    sources[record.source] = (sources[record.source] ?? 0) + 1;
    const sensitivity = record.sensitivity ?? 'normal';
    sensitivities[sensitivity] = (sensitivities[sensitivity] ?? 0) + 1;
    const updateMode = record.provenance?.updateMode
      ?? (record.source === 'model' ? 'model_proposed' : 'user_confirmed');
    updateModes[updateMode] = (updateModes[updateMode] ?? 0) + 1;
    if (ids.has(record.id)) duplicateIds.add(record.id);
    ids.add(record.id);
    const replaces = record.provenance?.replaces ?? [];
    if (replaces.length > 0) {
      corrections += 1;
      for (const targetId of replaces) {
        replacementTargets.add(targetId);
        const list = replacedBy.get(targetId) ?? [];
        list.push(record.id);
        replacedBy.set(targetId, list);
      }
    }
  }

  const samples = [];
  let anomalyCount = 0;
  const anomaly = (message) => {
    anomalyCount += 1;
    if (samples.length < MAX_HEALTH_SAMPLES) samples.push(message);
  };

  for (const id of duplicateIds) anomaly(`[${shortId(id)}] appears more than once in the store`);
  for (const record of records) {
    for (const targetId of new Set(record.provenance?.replaces ?? [])) {
      if (targetId === record.id) {
        anomaly(`[${shortId(record.id)}] names itself as the claim it replaces`);
      } else if (!ids.has(targetId)) {
        anomaly(`[${shortId(record.id)}] replaces [${shortId(targetId)}], which is not in the store`);
      }
    }
  }
  for (const [targetId, successors] of replacedBy) {
    if (successors.length > 1) {
      anomaly(`[${shortId(targetId)}] is replaced by ${successors.length} records`);
    }
  }

  return {
    path,
    state: corrupt.length > 0 ? 'damaged' : 'ok',
    inspected: true,
    complete: corrupt.length === 0,
    detail: null,
    records: records.length,
    corruptLines: corrupt.length,
    corrupt: corrupt.map((entry) => ({
      line: entry.line,
      reason: entry.reason,
      truncatedTail: Boolean(entry.truncatedTail),
    })),
    kinds,
    sources,
    sensitivities,
    updateModes,
    corrections,
    replacedClaims: replacementTargets.size,
    privateRecords: sensitivities.private,
    anomalies: { count: anomalyCount, samples, truncated: anomalyCount > samples.length },
    attention: corrupt.length > 0 || anomalyCount > 0,
  };
}
