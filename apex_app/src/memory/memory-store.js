// Persistent personal memory. Every record carries provenance: `source` says
// who supplied the content ('user' or 'model'), and `kind` separates user facts
// from model conclusions. A content SHA-256 lets reads detect tampering.
// `sensitivity` marks records that must never be sent to a model ('private').
import { createHash, randomUUID } from 'node:crypto';
import { JsonlStore } from './jsonl-store.js';
import { StoreError, ValidationError } from '../errors.js';
import { CONTROL_CHARS, STOPWORDS } from '../util.js';
import { containsSecret } from '../security/secrets.js';

export const MEMORY_SCHEMA = 1;
export const MAX_CONTENT_CHARS = 4000;
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
  if (!KINDS.has(kind)) throw new ValidationError(`unknown memory kind: ${String(kind)}`);
  if (!SOURCES.has(source)) throw new ValidationError(`unknown memory source: ${String(source)}`);
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
    throw new ValidationError(`unsupported source: ${String(source)}`);
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

// Light normalisation: lower-case words, drop stopwords, strip common suffixes.
export function tokenize(text) {
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const out = [];
  for (const w of words) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
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
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return (2 * shared) / (ta.size + tb.size);
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

function isPotentialConflict(a, b) {
  if (!a || !b || a.id === b.id) return false;
  const aText = String(a.content).trim();
  const bText = String(b.content).trim();
  if (aText === bText) return false;

  const left = extractConflictClause(aText);
  const right = extractConflictClause(bText);
  if (!left || !right) return false;
  if (left.subject !== right.subject) return false;
  if (left.value === right.value) return false;
  // A longer value that merely qualifies an existing value is not enough
  // evidence to call the claims contradictory.
  if (left.value.startsWith(`${right.value} `) || right.value.startsWith(`${left.value} `)) return false;

  const dateWords = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'today', 'tomorrow', 'yesterday']);
  if (left.value.split(' ').some((word) => dateWords.has(word)) || right.value.split(' ').some((word) => dateWords.has(word))) {
    return false;
  }
  return true;
}

export class MemoryStore {
  constructor(filePath, { now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.log = new JsonlStore(filePath, { validateRecord: validateMemoryRecord });
  }

  async add({ content, kind = 'user_fact', source = 'user', sensitivity = 'normal', provenance = {} } = {}) {
    const text = validateContent(content);
    validateKindSource(kind, source);
    if (!SENSITIVITIES.has(sensitivity)) throw new ValidationError(`unknown sensitivity: ${String(sensitivity)}`);
    // A damaged store must not accept new records: appending would bury the
    // corrupt lines, and the write would be reported as verified while earlier
    // memory is unreadable.
    const records = await this.#loadComplete('write');
    const normalizedProvenance = finalizeProvenance({ source, provenance });
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
  }

  async correct({ targetId, content, origin } = {}) {
    if (origin !== 'user') throw new ValidationError('memory corrections require an authorized user-origin operation');
    if (typeof targetId !== 'string' || !MEMORY_ID_RE.test(targetId)) {
      throw new ValidationError('replacement target must be a full memory record ID');
    }
    const text = validateContent(content);
    const records = await this.#loadComplete();
    const target = records.find((record) => record.id === targetId);
    if (!target) throw new ValidationError(`replacement target ${targetId} not found in memory`);
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
  }

  async get(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    const { records } = await this.log.load();
    return records.find((r) => r.id === id) ?? null;
  }

  async #loadComplete(operation = 'retrieval') {
    const { records, corrupt } = await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`memory store contains ${corrupt.length} corrupt line(s); refusing incomplete ${operation}`);
    }
    return records;
  }

  async list({ limit = 20, includePrivate = true } = {}) {
    const records = await this.#loadComplete();
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

  // Ranked retrieval. Each query term is weighted by its rarity in the store
  // (IDF) and matches a record term exactly, or approximately (character
  // trigram similarity >= 0.6) for longer words. The score is in [0, 1].
  // Ties go to the newer record. `includePrivate: false` omits private records.
  async search(query, { limit = 5, includePrivate = true } = {}) {
    const terms = [...new Set(tokenize(query))];
    const records = await this.#loadComplete();
    if (terms.length === 0) return [];
    const pool = records.filter((r) => includePrivate || r.sensitivity !== 'private');
    const docs = pool.map((record) => new Set(tokenize(record.content)));

    const df = new Map();
    for (const t of terms) df.set(t, docs.filter((d) => d.has(t) || [...d].some((w) => w.length >= FUZZY_MIN_LENGTH && t.length >= FUZZY_MIN_LENGTH && similarity(t, w) >= FUZZY_MIN_SIMILARITY)).length);
    const n = pool.length;
    // IDF is floored at 1. With a small personal store, an absent word would otherwise
    // outweigh a matched one and a clearly relevant record would score below threshold.
    const idf = new Map(terms.map((t) => [t, Math.max(1, Math.log(1 + (n - df.get(t) + 0.5) / (df.get(t) + 0.5)))]));
    const totalWeight = terms.reduce((s, t) => s + idf.get(t), 0) || 1;

    const scored = [];
    pool.forEach((record, index) => {
      const words = docs[index];
      let matched = 0;
      for (const t of terms) {
        let best = 0;
        if (words.has(t)) best = 1;
        else if (t.length >= FUZZY_MIN_LENGTH) {
          for (const w of words) {
            if (w.length < FUZZY_MIN_LENGTH) continue;
            const s = similarity(t, w);
            if (s >= FUZZY_MIN_SIMILARITY && s > best) best = s;
          }
        }
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
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const left = unique[i].record;
        const right = unique[j].record;
        if (replacesRecord(left, right)) continue;
        if (!isPotentialConflict(left, right)) continue;
        const leftIds = conflictIds.get(left.id) ?? [];
        leftIds.push(right.id);
        conflictIds.set(left.id, leftIds);
        const rightIds = conflictIds.get(right.id) ?? [];
        rightIds.push(left.id);
        conflictIds.set(right.id, rightIds);
      }
    }
    return unique.slice(0, Math.max(1, limit)).map(({ record, score }) => ({
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
}
