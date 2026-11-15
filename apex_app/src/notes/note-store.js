// Structured personal notes: a note is the user's own composition, with the records and files
// it was built from named beside it.
//
// Design rules, shared with the other cognitive stores:
//  - append-only. A correction appends a new revision that names the revision it replaces; no
//    stored line is ever edited or removed, so history is the log rather than a reconstruction.
//  - provenance. Every revision carries the operation that wrote it and the sources it cites,
//    and a source reference is a name, never a claim that the source says what the note says.
//  - compare-and-swap. A revision names the exact head it was written against; if the head moved
//    first, the write is refused as a conflicting revision instead of silently replacing another
//    edit. Two writers cannot each believe they corrected the current note.
//  - privacy. A note marked private is excluded from search and from list bodies unless the
//    caller explicitly asks for it, exactly as a private memory is.
//  - a note is neither a memory nor a knowledge claim: it may cite both, and it asserts nothing
//    about the world on its own. Nothing derives facts, adaptations, or plans from a note.
import { createHash, randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { WriterLock } from '../memory/writer-lock.js';
import { StoreError, ValidationError } from '../errors.js';
import { CONTROL_CHARS, shortId } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { normalizeTokens, queryTokens } from '../retrieval/normalize.js';

export const NOTE_SCHEMA = 1;
export const MAX_TITLE_CHARS = 160;
export const MAX_BODY_CHARS = 20000;
export const MAX_TAGS = 20;
export const MAX_TAG_CHARS = 40;
export const MAX_SOURCES = 20;
export const MAX_SOURCE_REF_CHARS = 300;
export const MAX_HISTORY_VERSIONS = 50;

export const SOURCE_KINDS = Object.freeze([
  'memory', 'knowledge', 'experience', 'prediction', 'goal', 'plan', 'task',
  'note', 'file', 'digest', 'history',
]);

const SENSITIVITIES = new Set(['normal', 'private']);
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function textField(value, name, { required = true, max = MAX_TITLE_CHARS, multiline = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const t = value.replace(/\r\n/g, '\n').trim();
  if (required && t.length === 0) throw new ValidationError(`${name} is empty`);
  if (t.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if ((multiline ? BODY_CONTROL : CONTROL_CHARS).test(t)) {
    throw new ValidationError(`${name} contains control characters`);
  }
  if (containsSecret(t)) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  }
  return t;
}

function validateSources(sources) {
  if (sources === undefined || sources === null) return [];
  if (!Array.isArray(sources)) throw new ValidationError('sources must be a list');
  if (sources.length > MAX_SOURCES) throw new ValidationError(`at most ${MAX_SOURCES} sources may be cited`);
  return sources.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`source #${index + 1} must be an object`);
    }
    const allowed = ['kind', 'ref', 'label', 'sha256'];
    for (const key of Object.keys(entry)) {
      if (!allowed.includes(key)) throw new ValidationError(`source #${index + 1} has unexpected field "${key}"`);
    }
    if (!SOURCE_KINDS.includes(entry.kind)) {
      throw new ValidationError(`source #${index + 1} kind must be one of: ${SOURCE_KINDS.join(', ')}`);
    }
    const ref = textField(entry.ref, `source #${index + 1} reference`, { max: MAX_SOURCE_REF_CHARS });
    let label = null;
    if (entry.label !== undefined && entry.label !== null) {
      label = textField(entry.label, `source #${index + 1} label`, { required: false, max: 120 }) || null;
    }
    let sha = null;
    if (entry.sha256 !== undefined && entry.sha256 !== null) {
      if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256.trim())) {
        throw new ValidationError(`source #${index + 1} sha256 must be a 64-character hexadecimal digest`);
      }
      sha = entry.sha256.trim().toLowerCase();
    }
    return { kind: entry.kind, ref, ...(label ? { label } : {}), ...(sha ? { sha256: sha } : {}) };
  });
}

function validateTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new ValidationError('tags must be a list');
  if (tags.length > MAX_TAGS) throw new ValidationError(`at most ${MAX_TAGS} tags may be stored`);
  const seen = new Set();
  const out = [];
  for (const value of tags) {
    const tag = textField(value, 'tag', { max: MAX_TAG_CHARS });
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export function validateNoteRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if (r.schema !== NOTE_SCHEMA) return 'unsupported schema';
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'missing or invalid id';
  if (!Number.isInteger(r.revision) || r.revision < 1) return 'missing or invalid revision';
  if (r.supersedes !== undefined) {
    if (!Array.isArray(r.supersedes) || r.supersedes.length > 1) return 'invalid supersedes list';
    if (r.supersedes.some((id) => typeof id !== 'string' || !ID_RE.test(id))) return 'invalid supersedes id';
  }
  if (typeof r.title !== 'string' || r.title.length === 0 || r.title.length > MAX_TITLE_CHARS) return 'invalid title';
  if (typeof r.body !== 'string' || r.body.length > MAX_BODY_CHARS) return 'invalid body';
  if (r.bodySha256 !== sha256Hex(r.body)) return 'body hash mismatch';
  if (!Array.isArray(r.tags) || r.tags.length > MAX_TAGS) return 'invalid tags';
  if (r.tags.some((t) => typeof t !== 'string' || t.length === 0 || t.length > MAX_TAG_CHARS)) return 'invalid tag value';
  if (!Array.isArray(r.sources) || r.sources.length > MAX_SOURCES) return 'invalid sources';
  for (const s of r.sources) {
    if (!s || typeof s !== 'object') return 'invalid source';
    if (!SOURCE_KINDS.includes(s.kind)) return 'unknown source kind';
    if (typeof s.ref !== 'string' || s.ref.length === 0 || s.ref.length > MAX_SOURCE_REF_CHARS) return 'invalid source ref';
    if (s.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(s.sha256)) return 'invalid source sha256';
  }
  if (!SENSITIVITIES.has(r.sensitivity ?? 'normal')) return 'unknown sensitivity';
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return 'bad timestamp';
  if (!r.provenance || typeof r.provenance !== 'object') return 'missing provenance';
  if (r.provenance.origin !== 'user_supplied') return 'notes require user provenance';
  if (r.provenance.updateMode !== 'user_confirmed') return 'notes require user_confirmed provenance';
  return null;
}

// One logical note: a root revision and every revision that names its predecessor. Store order
// is the revision order, so the last record in a chain is the head. A record named by two later
// revisions is a conflicting revision, not a merge: both edits happened, and which one is current
// cannot be decided from the log, so it is reported and neither is treated as superseding quietly.
function buildChains(records) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const successors = new Map();
  for (const record of records) {
    for (const previous of record.supersedes ?? []) {
      successors.set(previous, [...(successors.get(previous) ?? []), record.id]);
    }
  }
  const heads = [];
  const problems = [];
  for (const record of records) {
    const next = successors.get(record.id) ?? [];
    if (next.length === 0) heads.push(record);
    if (next.length > 1) {
      problems.push(`[${shortId(record.id)}] was revised by ${next.length} later records; the current revision is ambiguous`);
    }
  }
  return { byId, successors, heads, problems };
}

function headOf(records, id) {
  const { byId, successors } = buildChains(records);
  let current = byId.get(id);
  if (!current) return null;
  const seen = new Set([current.id]);
  for (;;) {
    const next = successors.get(current.id) ?? [];
    if (next.length !== 1) break;
    const following = byId.get(next[0]);
    if (!following || seen.has(following.id)) break;
    seen.add(following.id);
    current = following;
  }
  return current;
}

function resolveOne(records, ref) {
  if (typeof ref !== 'string' || ref.trim().length === 0) throw new ValidationError('note reference is empty');
  const value = ref.trim();
  if (value.length > 64) throw new ValidationError('note reference is longer than 64 characters');
  if (CONTROL_CHARS.test(value)) throw new ValidationError('note reference contains control characters');
  const matches = records.filter((r) => r.id === value || r.id.startsWith(value) || shortId(r.id) === value);
  if (matches.length === 0) throw new ValidationError('note not found');
  if (matches.length > 1) throw new ValidationError('note reference is ambiguous; use a longer id prefix');
  return matches[0];
}

function bodyForDisplay(record, includePrivate, { allowBody = false } = {}) {
  const isPrivate = record.sensitivity === 'private';
  return {
    id: record.id,
    shortId: shortId(record.id),
    revision: record.revision,
    title: record.title,
    // A private note's body is never handed out by a list or search; only an explicit show for
    // that note, with includePrivate, returns it. Its title is shown so the note can be found.
    body: isPrivate && !(includePrivate && allowBody) ? null : record.body,
    bodyHidden: isPrivate && !(includePrivate && allowBody),
    bodySha256: record.bodySha256,
    tags: [...record.tags],
    sources: record.sources.map((s) => ({ ...s })),
    sensitivity: record.sensitivity ?? 'normal',
    createdAt: record.createdAt,
    supersedes: [...(record.supersedes ?? [])],
    provenance: {
      origin: record.provenance.origin,
      operationId: record.provenance.operationId ?? null,
      updateMode: record.provenance.updateMode,
    },
  };
}

export class NoteStore {
  constructor(filePath, { now = () => new Date(), parseCacheBytes, lockWaitMs, lockRetryMs, lockRetryMaxMs } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.log = new JsonlStore(filePath, { validateRecord: validateNoteRecord, parseCacheBytes });
    this.writeLock = new WriterLock(filePath, { waitMs: lockWaitMs, retryMs: lockRetryMs, retryMaxMs: lockRetryMaxMs });
  }

  async #loadComplete({ beforeAppend = false } = {}) {
    const { records, corrupt } = beforeAppend ? await this.log.loadForAppend() : await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`note store contains ${corrupt.length} corrupt line(s); refusing an incomplete note operation`);
    }
    return records;
  }

  async add({ title, body = '', tags = [], sources = [], sensitivity = 'normal', provenance = {}, origin } = {}) {
    if (origin !== 'user') {
      throw new ValidationError('writing a note requires an authorized user-origin operation; model output cannot write notes', 'WRITE_REQUIRES_USER_ORIGIN');
    }
    const cleanTitle = textField(title, 'title');
    const cleanBody = textField(body, 'body', { required: false, max: MAX_BODY_CHARS, multiline: true });
    const cleanTags = validateTags(tags);
    const cleanSources = validateSources(sources);
    if (!SENSITIVITIES.has(sensitivity)) throw new ValidationError(`unknown sensitivity: ${String(sensitivity).slice(0, 40)}`);
    const prov = sanitizeProvenance(provenance);
    return this.writeLock.run(() => this.#addFromAuthority({
      cleanTitle, cleanBody, cleanTags, cleanSources, sensitivity, prov,
    }));
  }

  async #addFromAuthority({ cleanTitle, cleanBody, cleanTags, cleanSources, sensitivity, prov }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
    const record = {
      schema: NOTE_SCHEMA,
      id,
      revision: 1,
      title: cleanTitle,
      body: cleanBody,
      bodySha256: sha256Hex(cleanBody),
      tags: cleanTags,
      sources: cleanSources,
      sensitivity,
      createdAt: this.now().toISOString(),
      provenance: prov,
    };
    const problem = validateNoteRecord(record);
    if (problem) throw new StoreError(`note record failed its own validation: ${problem}`);
    await this.log.append(record);
    return { record, revision: 1 };
  }

  // A correction names the head it was written against. If that record is no longer the head,
  // another revision was appended first and this write is refused as a conflicting revision - the
  // caller's text is not applied to a note that has moved. Fields not supplied are carried over
  // unchanged from the head, so a correction can change one field without restating the rest.
  async update({ target, title, body, tags, sources, sensitivity, provenance = {}, origin } = {}) {
    if (origin !== 'user') {
      throw new ValidationError('revising a note requires an authorized user-origin operation; model output cannot revise notes', 'WRITE_REQUIRES_USER_ORIGIN');
    }
    const ref = resolveOne(await this.#loadComplete(), target);
    const prov = sanitizeProvenance(provenance);
    return this.writeLock.run(() => this.#updateFromAuthority({ ref, title, body, tags, sources, sensitivity, prov }));
  }

  async #updateFromAuthority({ ref, title, body, tags, sources, sensitivity, prov }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const known = records.find((r) => r.id === ref.id);
    if (!known) throw new ValidationError('note not found');
    const { successors } = buildChains(records);
    const head = headOf(records, known.id);
    const siblings = successors.get(known.id) ?? [];
    if (known.id !== head.id) {
      if (siblings.length > 1) {
        throw new ValidationError(
          `note [${shortId(known.id)}] has ${siblings.length} competing revisions; name the revision you mean to correct`,
          'REVISION_CONFLICT',
        );
      }
      throw new ValidationError(
        `note [${shortId(known.id)}] was revised to [${shortId(head.id)}] after it was read; correct the current revision instead`,
        'REVISION_CONFLICT',
      );
    }
    const nextTitle = title === undefined || title === null ? head.title : textField(title, 'title');
    const nextBody = body === undefined || body === null
      ? head.body
      : textField(body, 'body', { required: false, max: MAX_BODY_CHARS, multiline: true });
    const nextTags = tags === undefined || tags === null ? [...head.tags] : validateTags(tags);
    const nextSources = sources === undefined || sources === null
      ? head.sources.map((s) => ({ ...s }))
      : validateSources(sources);
    const nextSensitivity = sensitivity === undefined || sensitivity === null ? (head.sensitivity ?? 'normal') : sensitivity;
    if (!SENSITIVITIES.has(nextSensitivity)) throw new ValidationError(`unknown sensitivity: ${String(nextSensitivity).slice(0, 40)}`);

    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
    const record = {
      schema: NOTE_SCHEMA,
      id,
      revision: head.revision + 1,
      supersedes: [head.id],
      title: nextTitle,
      body: nextBody,
      bodySha256: sha256Hex(nextBody),
      tags: nextTags,
      sources: nextSources,
      sensitivity: nextSensitivity,
      createdAt: this.now().toISOString(),
      provenance: prov,
    };
    const problem = validateNoteRecord(record);
    if (problem) throw new StoreError(`note record failed its own validation: ${problem}`);
    await this.log.append(record);
    return { record, revision: record.revision, previous: head };
  }

  // The newest head revisions, newest first. Private bodies are withheld unless asked for; the
  // title and identifier remain visible so the note can still be opened deliberately.
  async list({ limit = 20, includePrivate = false } = {}) {
    const records = await this.#loadComplete();
    const chains = buildChains(records);
    return chains.heads.slice(-Math.max(1, limit)).reverse()
      .map((record) => bodyForDisplay(record, includePrivate));
  }

  async search(query, { limit = 5, includePrivate = false } = {}) {
    const records = await this.#loadComplete();
    const chains = buildChains(records);
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return { results: [], excludedPrivate: 0, terms: [] };
    let excludedPrivate = 0;
    const scored = [];
    for (const record of chains.heads) {
      if ((record.sensitivity ?? 'normal') === 'private' && !includePrivate) {
        // A private note is not a search result even when its title matches. Counting it keeps the
        // answer honest about what was withheld instead of implying the store held nothing.
        const words = tokenSet(`${record.title} ${record.tags.join(' ')} ${record.body}`);
        if (terms.some((t) => words.has(t))) excludedPrivate += 1;
        continue;
      }
      const titleWords = tokenSet(record.title);
      const tagWords = tokenSet(record.tags.join(' '));
      const bodyWords = tokenSet(record.body);
      let score = 0;
      for (const term of terms) {
        if (titleWords.has(term)) score += 3;
        if (tagWords.has(term)) score += 2;
        if (bodyWords.has(term)) score += 1;
      }
      if (score > 0) scored.push({ record, score });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const delta = Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt);
      return delta !== 0 ? delta : a.record.id.localeCompare(b.record.id);
    });
    const window = scored.slice(0, Math.max(1, limit));
    return {
      results: window.map(({ record, score }) => ({ ...bodyForDisplay(record, includePrivate), score })),
      excludedPrivate,
      terms,
      matched: scored.length,
    };
  }

  // One note at its current revision. `includePrivate` is required for a private body; without it
  // the note is reported with its body withheld rather than as missing.
  async show(ref, { includePrivate = false } = {}) {
    const records = await this.#loadComplete();
    const found = resolveOne(records, ref);
    const head = headOf(records, found.id);
    return bodyForDisplay(head, includePrivate, { allowBody: true });
  }

  // The whole revision chain of one note, oldest first, bounded. `conflict` is set when the log
  // holds more than one successor for a revision: both edits exist, and no head is asserted.
  async history(ref) {
    const records = await this.#loadComplete();
    const found = resolveOne(records, ref);
    const { successors, problems } = buildChains(records);
    const chain = [];
    let current = found;
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      const next = successors.get(current.id) ?? [];
      if (next.length !== 1) break;
      current = records.find((r) => r.id === next[0]) ?? null;
    }
    // Walk backwards from the record the caller named as well, so a correction of an older
    // revision still shows the earlier versions it was written over.
    let earlier = found;
    const back = new Set(chain.map((r) => r.id));
    while (earlier?.supersedes?.length === 1) {
      const previous = records.find((r) => r.id === earlier.supersedes[0]);
      if (!previous || back.has(previous.id)) break;
      back.add(previous.id);
      chain.unshift(previous);
      earlier = previous;
    }
    // Re-order by store position; revision numbers are per chain but the log is authoritative.
    const order = new Map(records.map((r, i) => [r.id, i]));
    chain.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const shown = chain.slice(-MAX_HISTORY_VERSIONS);
    return {
      id: found.id,
      current: headOf(records, found.id)?.id ?? null,
      versions: shown.map((r) => bodyForDisplay(r, true, { allowBody: false })),
      truncated: chain.length > shown.length,
      conflict: (successors.get(found.id)?.length ?? 0) > 1
        || problems.some((p) => p.includes(shortId(found.id))),
      problems: problems.filter((p) => chain.some((r) => p.includes(shortId(r.id)))),
      note: 'a revision is a separate append-only record; the newest revision of a chain is its current text, and nothing here rewrites an earlier version',
    };
  }

  async status() {
    const { records, corrupt } = await this.log.load();
    const chains = buildChains(records);
    return {
      path: this.filePath,
      records: records.length,
      notes: chains.heads.length,
      privateNotes: chains.heads.filter((r) => r.sensitivity === 'private').length,
      conflicts: chains.problems.length,
      corrupt: corrupt.length,
    };
  }
}

function sanitizeProvenance(p) {
  const base = {};
  if (p && typeof p === 'object') {
    if (typeof p.operationId === 'string' && OPERATION_ID_RE.test(p.operationId)) base.operationId = p.operationId;
    if (p.origin !== undefined || p.updateMode !== undefined) {
      throw new ValidationError('provenance origin and updateMode are derived from the operation and may not be supplied');
    }
  }
  return { ...base, origin: 'user_supplied', updateMode: 'user_confirmed' };
}

function tokenize(text) {
  return normalizeTokens(text, { stem: false });
}

function tokenSet(text) {
  return new Set(queryTokens(text, { stem: false }).tokens);
}
