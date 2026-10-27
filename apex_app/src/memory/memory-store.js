// Persistent personal memory. Every record carries provenance: `source` says
// who supplied the content ('user' or 'model'), and `kind` separates user facts
// from model conclusions. A content SHA-256 lets reads detect tampering.
import { createHash, randomUUID } from 'node:crypto';
import { JsonlStore } from './jsonl-store.js';
import { StoreError, ValidationError } from '../errors.js';
import { CONTROL_CHARS } from '../util.js';

export const MEMORY_SCHEMA = 1;
export const MAX_CONTENT_CHARS = 4000;
const KINDS = new Set(['user_fact', 'model_conclusion']);
const SOURCES = new Set(['user', 'model']);
const OPERATION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const BACKEND_RE = /^[A-Za-z0-9._:-]{1,64}$/;

// Words that carry no retrieval signal.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'of', 'to', 'in', 'on', 'at',
  'for', 'from', 'by', 'with', 'and', 'or', 'it', 'its', 'this', 'that', 'my', 'me',
  'i', 'you', 'your', 'what', 'do', 'does', 'about', 'as',
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
  if (typeof r.content !== 'string') return 'missing content';
  if (sha256Hex(r.content) !== r.contentSha256) return 'content hash mismatch';
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return 'bad timestamp';
  if (!r.provenance || typeof r.provenance !== 'object') return 'missing provenance';
  return null;
}

function tokenize(text) {
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const out = [];
  for (const w of words) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.push(w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
  }
  return out;
}

export class MemoryStore {
  constructor(filePath, { now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.log = new JsonlStore(filePath, { validateRecord: validateMemoryRecord });
  }

  async add({ content, kind = 'user_fact', source = 'user', provenance = {} } = {}) {
    const text = validateContent(content);
    validateKindSource(kind, source);
    const { records } = await this.log.load();
    const id = randomUUID();
    // Never overwrite: a colliding identifier aborts the write.
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
    const record = {
      schema: MEMORY_SCHEMA,
      id,
      kind,
      source,
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

  async list({ limit = 20 } = {}) {
    const { records } = await this.log.load();
    return records.slice(-Math.max(1, limit)).reverse();
  }

  // Keyword retrieval: score = fraction of distinct query terms present in the
  // record. This is lexical, not semantic. Ties go to the newer record.
  async search(query, { limit = 5 } = {}) {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    const { records } = await this.log.load();
    const scored = [];
    records.forEach((record, index) => {
      const present = new Set(tokenize(record.content));
      const matched = terms.filter((t) => present.has(t)).length;
      if (matched > 0) scored.push({ record, score: matched / terms.length, index });
    });
    scored.sort((a, b) => b.score - a.score || b.index - a.index);
    return scored.slice(0, Math.max(1, limit)).map(({ record, score }) => ({ record, score }));
  }

  async status() {
    const { records, corrupt } = await this.log.load();
    return { path: this.filePath, records: records.length, corrupt: corrupt.length };
  }
}
