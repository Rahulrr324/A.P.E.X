// Persistent personal memory. Every record carries provenance: `source` says
// who supplied the content ('user' or 'model'), and `kind` separates user facts
// from model conclusions. A content SHA-256 lets reads detect tampering.
// `sensitivity` marks records that must never be sent to a model ('private').
import { createHash, randomUUID } from 'node:crypto';
import { JsonlStore } from './jsonl-store.js';
import { StoreError, ValidationError } from '../errors.js';
import { CONTROL_CHARS } from '../util.js';
import { containsSecret } from '../security/secrets.js';

export const MEMORY_SCHEMA = 1;
export const MAX_CONTENT_CHARS = 4000;
// Minimum retrieval score for a record to be included in a model prompt.
// Records below it are still shown to the user by the memory actions.
export const PROMPT_RELEVANCE_MIN = 0.2;
const KINDS = new Set(['user_fact', 'model_conclusion']);
const SOURCES = new Set(['user', 'model']);
const SENSITIVITIES = new Set(['normal', 'private']);
const OPERATION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const BACKEND_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const FUZZY_MIN_SIMILARITY = 0.6;
const FUZZY_MIN_LENGTH = 4;

// Words that carry no retrieval signal.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'of', 'to', 'in', 'on', 'at',
  'for', 'from', 'by', 'with', 'and', 'or', 'it', 'its', 'this', 'that', 'these', 'those',
  'my', 'me', 'i', 'you', 'your', 'we', 'our', 'they', 'their', 'he', 'she', 'his', 'her',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'do', 'does', 'did', 'about',
  'as', 'if', 'so', 'not', 'no', 'yes', 'can', 'could', 'would', 'should', 'will', 'have', 'has',
  'had', 'please', 'tell', 'say', 'said', 'know', 'just', 'any', 'some', 'there', 'here',
]);

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
  return out;
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

function dedupeKey(record) {
  return `${record.kind}|${record.source}|${record.sensitivity ?? 'normal'}|${String(record.content).trim().toLowerCase()}`;
}

function isPotentialConflict(a, b) {
  if (!a || !b || a.id === b.id) return false;
  const aText = String(a.content).trim();
  const bText = String(b.content).trim();
  if (aText === bText) return false;
  const aWords = new Set(tokenize(a.content));
  const bWords = new Set(tokenize(b.content));
  const overlap = [...aWords].filter((word) => bWords.has(word));
  return overlap.length >= 2 && aWords.size >= 2 && bWords.size >= 2;
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
    const { records } = await this.log.load();
    const id = randomUUID();
    // Never overwrite: a colliding identifier aborts the write.
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
      provenance: sanitizeProvenance(provenance),
    };
    await this.log.append(record);
    return record;
  }

  async get(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    const { records } = await this.log.load();
    return records.find((r) => r.id === id) ?? null;
  }

  async list({ limit = 20, includePrivate = true } = {}) {
    const { records } = await this.log.load();
    const visible = records.filter((r) => includePrivate || r.sensitivity !== 'private');
    return visible.slice(-Math.max(1, limit)).reverse();
  }

  // Ranked retrieval. Each query term is weighted by its rarity in the store
  // (IDF) and matches a record term exactly, or approximately (character
  // trigram similarity >= 0.6) for longer words. The score is in [0, 1].
  // Ties go to the newer record. `includePrivate: false` omits private records.
  async search(query, { limit = 5, includePrivate = true } = {}) {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    const { records } = await this.log.load();
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

    const conflictIds = new Map();
    for (let i = 0; i < scored.length; i += 1) {
      for (let j = i + 1; j < scored.length; j += 1) {
        const left = scored[i].record;
        const right = scored[j].record;
        if (!isPotentialConflict(left, right)) continue;
        const leftIds = conflictIds.get(left.id) ?? [];
        leftIds.push(right.id);
        conflictIds.set(left.id, leftIds);
        const rightIds = conflictIds.get(right.id) ?? [];
        rightIds.push(left.id);
        conflictIds.set(right.id, rightIds);
      }
    }

    const unique = [];
    const seen = new Set();
    for (const item of scored) {
      const key = dedupeKey(item.record);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }
    return unique.slice(0, Math.max(1, limit)).map(({ record, score }) => ({
      record,
      score,
      conflict: conflictIds.get(record.id) ?? [],
    }));
  }

  async status() {
    const { records, corrupt } = await this.log.load();
    return { path: this.filePath, records: records.length, corrupt: corrupt.length };
  }
}
