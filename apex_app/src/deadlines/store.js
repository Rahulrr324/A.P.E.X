// Recorded deadlines: dates the owner read from a local file and asked APEX to keep.
//
// A deadline here is a recorded date, not a schedule. APEX does not infer a due date from a
// title, does not compute a reminder time, and does not act when one passes. Every record
// carries the file it was imported from, that file's digest, and the line it came from, so a
// later reader can re-open the source and check the date rather than trusting this log.
//
// Design rules shared with the other stores:
//  - append-only. An import appends records; no stored line is edited or removed.
//  - strict dates. A value must be a calendar date (YYYY-MM-DD) or a UTC instant ending in Z.
//    Anything else is refused with its line number rather than parsed leniently.
//  - idempotent import. A deadline already recorded with the same title and due date is not
//    appended again, so re-importing an unchanged file adds nothing.
//  - provenance. Every record names the source path, the source file's SHA-256, and the line.
import { randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { WriterLock } from '../memory/writer-lock.js';
import { StoreError, ValidationError } from '../errors.js';
import { CONTROL_CHARS, shortId } from '../util.js';
import { containsSecret } from '../security/secrets.js';

export const DEADLINE_SCHEMA = 1;
export const MAX_TITLE_CHARS = 200;
export const MAX_SOURCE_PATH_CHARS = 300;
export const MAX_DEADLINES = 500;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Canonical form of a due date. A calendar date stays a calendar date; an instant is normalized
// to the same instant in ISO form. A value that is not a real calendar date (2026-02-30) or not a
// real time (24:00, :60) is refused; nothing here guesses what the author meant.
export function normalizeDueAt(value) {
  if (typeof value !== 'string') throw new ValidationError('dueAt must be text');
  const text = value.trim();
  if (text.length === 0) throw new ValidationError('dueAt is empty');
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      throw new ValidationError(`dueAt is not a real calendar date: ${text}`);
    }
    return text;
  }
  const instant = DATE_INSTANT.exec(text);
  if (!instant) {
    throw new ValidationError('dueAt must be a date (YYYY-MM-DD) or a UTC instant ending in Z');
  }
  const year = Number(instant[1]);
  const month = Number(instant[2]);
  const day = Number(instant[3]);
  const hour = Number(instant[4]);
  const minute = Number(instant[5]);
  const second = instant[6] === undefined ? 0 : Number(instant[6]);
  const millis = instant[7] === undefined ? 0 : Number(instant[7].padEnd(3, '0'));
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) {
    throw new ValidationError(`dueAt is not a real UTC instant: ${text}`);
  }
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis)).toISOString();
}

// Whole calendar days from `now` to the recorded date, measured at UTC midnight, so a deadline
// recorded for today reads as 0 rather than "0.4 days ago".
export function daysUntil(dueAt, now) {
  const target = Date.parse(dueAt);
  if (Number.isNaN(target)) return null;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const d = new Date(target);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((end - start) / 86400000);
}

export function validateDeadlineRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if (r.schema !== DEADLINE_SCHEMA) return 'unsupported schema';
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'missing or invalid id';
  if (typeof r.title !== 'string' || r.title.length === 0 || r.title.length > MAX_TITLE_CHARS) return 'invalid title';
  if (CONTROL_CHARS.test(r.title)) return 'title contains control characters';
  if (typeof r.dueAt !== 'string') return 'missing dueAt';
  try {
    if (normalizeDueAt(r.dueAt) !== r.dueAt) return 'dueAt is not canonical';
  } catch {
    return 'invalid dueAt';
  }
  if (!r.source || typeof r.source !== 'object') return 'missing source';
  if (typeof r.source.path !== 'string' || r.source.path.length === 0 || r.source.path.length > MAX_SOURCE_PATH_CHARS) return 'invalid source path';
  if (typeof r.source.sha256 !== 'string' || !SHA256_RE.test(r.source.sha256)) return 'invalid source sha256';
  if (!Number.isInteger(r.source.line) || r.source.line < 1) return 'invalid source line';
  if (typeof r.recordedAt !== 'string' || Number.isNaN(Date.parse(r.recordedAt))) return 'bad timestamp';
  if (!r.provenance || typeof r.provenance !== 'object') return 'missing provenance';
  if (r.provenance.origin !== 'user_supplied') return 'deadlines require user provenance';
  if (r.provenance.operationId !== undefined
    && (typeof r.provenance.operationId !== 'string' || !OPERATION_ID_RE.test(r.provenance.operationId))) {
    return 'invalid operation id';
  }
  return null;
}

// A deadline is identified by its content, not by the line it arrived on: importing the same
// schedule twice, or a file whose lines moved, must not multiply the board.
export function deadlineIdentity(title, dueAt) {
  return `${title.toLowerCase().replace(/\s+/g, ' ')}\u0000${dueAt}`;
}

function citation(record, now) {
  return {
    id: record.id,
    shortId: shortId(record.id),
    title: record.title,
    dueAt: record.dueAt,
    daysUntil: now ? daysUntil(record.dueAt, now) : null,
    source: { path: record.source.path, sha256: record.source.sha256, line: record.source.line },
    recordedAt: record.recordedAt,
  };
}

export class DeadlineStore {
  constructor(filePath, { now = () => new Date(), parseCacheBytes, lockWaitMs, lockRetryMs, lockRetryMaxMs } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.log = new JsonlStore(filePath, { validateRecord: validateDeadlineRecord, parseCacheBytes });
    this.writeLock = new WriterLock(filePath, { waitMs: lockWaitMs, retryMs: lockRetryMs, retryMaxMs: lockRetryMaxMs });
  }

  async #loadComplete({ beforeAppend = false } = {}) {
    const { records, corrupt } = beforeAppend ? await this.log.loadForAppend() : await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`deadline store contains ${corrupt.length} corrupt line(s); refusing an incomplete deadline operation`);
    }
    return records;
  }

  // Import validated entries from one source file. `entries` is `[{title, dueAt, line}]`, already
  // parsed and bounded by the action. Nothing is written when any entry or the source metadata is
  // invalid: an import is all-or-nothing, so a partially read schedule cannot look complete.
  async import(entries, { path, sha256, provenance = {}, origin } = {}) {
    if (origin !== 'user') {
      throw new ValidationError('importing deadlines requires an authorized user-origin operation; model output cannot record deadlines', 'WRITE_REQUIRES_USER_ORIGIN');
    }
    if (typeof path !== 'string' || path.length === 0 || path.length > MAX_SOURCE_PATH_CHARS) {
      throw new ValidationError('source path is required');
    }
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
      throw new ValidationError('source sha256 must be a 64-character hexadecimal digest');
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new ValidationError('an import needs at least one deadline entry');
    }
    if (entries.length > MAX_DEADLINES) {
      throw new ValidationError(`an import may contain at most ${MAX_DEADLINES} deadlines`);
    }
    const clean = entries.map((entry, index) => {
      const title = typeof entry?.title === 'string' ? entry.title.replace(/\r\n/g, '\n').trim() : '';
      if (title.length === 0) throw new ValidationError(`entry #${index + 1} has no title`);
      if (title.length > MAX_TITLE_CHARS) throw new ValidationError(`entry #${index + 1} title exceeds ${MAX_TITLE_CHARS} characters`);
      if (CONTROL_CHARS.test(title)) throw new ValidationError(`entry #${index + 1} title contains control characters`);
      if (containsSecret(title)) {
        throw new ValidationError(`entry #${index + 1} title looks like a password, key, or token; nothing was stored`, 'SECRET_REFUSED');
      }
      if (!Number.isInteger(entry?.line) || entry.line < 1) throw new ValidationError(`entry #${index + 1} has no source line`);
      return { title, dueAt: normalizeDueAt(entry.dueAt), line: entry.line };
    });
    return this.writeLock.run(() => this.#importFromAuthority({ clean, path, sha256, provenance }));
  }

  async #importFromAuthority({ clean, path, sha256, provenance }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const known = new Set(records.map((r) => deadlineIdentity(r.title, r.dueAt)));
    const operationId = provenance && typeof provenance === 'object' && typeof provenance.operationId === 'string'
      && OPERATION_ID_RE.test(provenance.operationId)
      ? provenance.operationId
      : null;
    const added = [];
    let duplicates = 0;
    for (const entry of clean) {
      const identity = deadlineIdentity(entry.title, entry.dueAt);
      if (known.has(identity)) {
        duplicates += 1;
        continue;
      }
      known.add(identity);
      const id = randomUUID();
      const record = {
        schema: DEADLINE_SCHEMA,
        id,
        title: entry.title,
        dueAt: entry.dueAt,
        source: { path, sha256, line: entry.line },
        recordedAt: this.now().toISOString(),
        provenance: { origin: 'user_supplied', ...(operationId ? { operationId } : {}) },
      };
      const problem = validateDeadlineRecord(record);
      if (problem) throw new StoreError(`deadline record failed its own validation: ${problem}`);
      await this.log.append(record);
      added.push(record);
    }
    return { added, duplicates, total: clean.length };
  }

  // Every stored deadline, earliest due date first. The list is a copy: a caller cannot edit a
  // record into something the file does not contain.
  async list({ now = null } = {}) {
    const records = await this.#loadComplete();
    return records
      .slice()
      .sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.id.localeCompare(b.id)))
      .map((record) => citation(record, now));
  }

  // What the ledger holds, without inventing a count of what is "upcoming": that depends on a
  // horizon and belongs to the reader.
  async status() {
    const { records, corrupt } = await this.log.load();
    return { path: this.filePath, records: records.length, corrupt: corrupt.length };
  }
}
