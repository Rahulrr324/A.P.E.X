// Append-only JSON Lines store. Design rules:
//  - records are only ever appended; existing bytes are never rewritten;
//  - each append is fsynced before it is reported as written;
//  - malformed lines are reported as corrupt and skipped, never deleted;
//  - a missing file is an empty store; an unreadable path is a StoreError.
//
// Optional derived parse snapshot (constructor option `parseCacheBytes`): the parsed and
// validated records of one exact byte sequence, kept per store instance in process memory
// and keyed by the SHA-256 of those bytes. It is a performance aid and never evidence:
// every read still reads the file, and every read that could be served from the snapshot
// hashes what it found first, so an append, a truncation, a same-length rewrite or a
// replaced file misses the snapshot and is parsed and validated again by the same rules.
// Reads hand out freshly copied records, so a caller cannot mutate
// the snapshot, and a store larger than the cap is never snapshotted. Stores that do not
// enable it (tasks, conversation, operations) behave exactly as before and pay nothing.
//
// Snapshot work is skipped on the two reads that surround one of this instance's own
// appends: the read immediately after it, and a read whose caller has said it is about to
// append (`load({ maintainSnapshot: false })`, used by the stores' write paths). In both
// cases the bytes returned are certain to be superseded by the append that follows or were
// just changed by the append that preceded, so a snapshot match cannot exist and hashing
// plus copying every record would be pure overhead on the authoritative write path. The
// snapshot is left exactly as it was: stale snapshots miss, they never serve stale records.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StoreError } from '../errors.js';

// Copies a record to the depth the stores actually use: the record itself, every field
// that is an object or array, and the arrays and objects inside those fields. Deeper
// values are JSON scalars in every validated record, so they are shared deliberately.
function isolateRecord(record) {
  const copy = { ...record };
  for (const key of Object.keys(copy)) {
    const value = copy[key];
    if (Array.isArray(value)) {
      copy[key] = value.map((item) => (item && typeof item === 'object' ? { ...item } : item));
    } else if (value && typeof value === 'object') {
      const nested = { ...value };
      for (const inner of Object.keys(nested)) {
        if (nested[inner] && typeof nested[inner] === 'object') {
          nested[inner] = Array.isArray(nested[inner]) ? [...nested[inner]] : { ...nested[inner] };
        }
      }
      copy[key] = nested;
    }
  }
  return copy;
}

function snapshotRecords(records, corrupt) {
  return {
    records: records.map(isolateRecord),
    corrupt: corrupt.map((entry) => ({ ...entry })),
  };
}

// The one parser. Every read of a store, cached or not, gets its records and its damage
// from here, so a cache hit cannot apply weaker integrity rules than a cold read.
function parseLines(text, validateRecord) {
  const records = [];
  const corrupt = [];
  const lines = text.split('\n');
  // A file ending with a newline has an empty final element. The last line that
  // carries content is what an interrupted append leaves unterminated.
  const endsWithNewline = text.endsWith('\n');
  let lastContent = lines.length - 1;
  while (lastContent >= 0 && lines[lastContent] === '') lastContent -= 1;
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      // Invalid JSON on an unterminated final line is what a crash during an
      // append leaves. It is still damage and still blocks the stores that
      // require a complete log; the flag only lets diagnostics tell that
      // recoverable residue apart from damage in the middle of the file.
      const truncatedTail = index === lastContent && !endsWithNewline;
      corrupt.push({ line: index + 1, reason: 'invalid JSON', ...(truncatedTail ? { truncatedTail: true } : {}) });
      return;
    }
    const problem = validateRecord(obj);
    if (problem) {
      corrupt.push({ line: index + 1, reason: problem });
      return;
    }
    records.push(obj);
  });
  return { records, corrupt };
}

export class JsonlStore {
  #snapshot = null;
  #justWrote = false;
  #cacheHits = 0;
  #cacheMisses = 0;

  constructor(filePath, { validateRecord = () => null, parseCacheBytes = 0 } = {}) {
    this.filePath = filePath;
    this.label = path.basename(filePath);
    this.validateRecord = validateRecord;
    this.parseCacheBytes = Number.isInteger(parseCacheBytes) && parseCacheBytes > 0 ? parseCacheBytes : 0;
  }

  // Read-only introspection of the derived snapshot. It reports a performance aid, not
  // stored state: a caller must not use it to decide whether a record exists. Hits and
  // misses are cumulative for this store instance and survive invalidation, so they answer
  // "how many reads did the snapshot serve", never "is this data current". A miss includes
  // both reads that skip snapshot work because an append is adjacent to them: the read
  // after this instance's own append and the read that precedes it.
  get parseCacheStats() {
    return {
      enabled: this.parseCacheBytes > 0,
      maxBytes: this.parseCacheBytes,
      cached: this.#snapshot !== null,
      cachedBytes: this.#snapshot?.bytes ?? 0,
      cachedRecords: this.#snapshot?.records.length ?? 0,
      hits: this.#cacheHits,
      misses: this.#cacheMisses,
    };
  }

  // The file's records and its damage, from one read of the file. The snapshot only ever
  // skips the parse step; the bytes are always read from disk and, unless this instance is
  // about to write or has just written them, hashed and compared before any record is
  // handed out. `maintainSnapshot: false` is the write path's declaration that the bytes
  // read here are about to be superseded by an append: the records are freshly parsed,
  // exactly as on a miss, and the existing snapshot is left untouched so it can only miss.
  async load({ maintainSnapshot = true } = {}) {
    let text;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const parent = path.dirname(this.filePath);
        try {
          const parentStat = await fs.stat(parent);
          if (!parentStat.isDirectory()) {
            throw Object.assign(new Error('parent path is not a directory'), { code: 'ENOTDIR' });
          }
        } catch (statErr) {
          if (statErr && statErr.code === 'ENOENT') return { records: [], corrupt: [] };
          throw new StoreError(`cannot read ${this.label}: ${statErr?.code || statErr?.message}`);
        }
        return { records: [], corrupt: [] };
      }
      throw new StoreError(`cannot read ${this.label}: ${err?.code || err?.message}`);
    }

    if (!maintainSnapshot) {
      this.#cacheMisses += 1;
      return parseLines(text, this.validateRecord);
    }
    const cacheable = this.parseCacheBytes > 0 && text.length <= this.parseCacheBytes;
    if (!cacheable) return parseLines(text, this.validateRecord);
    if (this.#justWrote) {
      // This instance changed the bytes, so a snapshot match cannot exist and hashing plus
      // copying every record would be pure write overhead. Parse and return; the next
      // unchanged read hashes and populates.
      this.#justWrote = false;
      this.#cacheMisses += 1;
      return parseLines(text, this.validateRecord);
    }
    const key = createHash('sha256').update(text).digest('hex');
    if (this.#snapshot && this.#snapshot.key === key) {
      this.#cacheHits += 1;
      return snapshotRecords(this.#snapshot.records, this.#snapshot.corrupt);
    }
    this.#cacheMisses += 1;
    const parsed = parseLines(text, this.validateRecord);
    this.#snapshot = { key, bytes: text.length, ...snapshotRecords(parsed.records, parsed.corrupt) };
    return parsed;
  }

  async append(record) {
    const line = `${JSON.stringify(record)}\n`;
    let handle;
    let written = 0;
    let total = 0;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      handle = await fs.open(this.filePath, 'a+');
      const { size } = await handle.stat();
      let prefix = '';
      if (size > 0) {
        // If a previous crash left a partial last line, start on a fresh line so
        // the new record is not merged into it.
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      }
      // A single write can complete partially. The remainder is appended in follow-up
      // writes until the whole record is on disk; reporting success after a partial
      // write would lose the record while its caller believed it was recorded. A write
      // that accepts no bytes is a failure, not a completed append.
      const data = Buffer.from(prefix + line, 'utf8');
      total = data.length;
      while (written < total) {
        const { bytesWritten } = await handle.write(data, written, total - written);
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
          throw new Error(`write accepted ${written} of ${total} bytes`);
        }
        written += bytesWritten;
      }
      await handle.sync();
    } catch (err) {
      // A failure is not proof that nothing was written. The bytes are visible to readers
      // as soon as the write returns; only durability is unknown until the fsync returns.
      // Say which state the caller is in instead of implying the store is unchanged.
      const note = written === 0
        ? ''
        : written < total
          ? `; ${written} byte(s) may remain as a partial line`
          : '; the record was written but its durability could not be confirmed, so it may be present';
      throw new StoreError(`cannot write ${this.label}: ${err?.code || err?.message}${note}`);
    } finally {
      if (handle) await handle.close().catch(() => {});
      // Whether the append succeeded, partially wrote, or failed, the bytes this instance
      // last snapshotted no longer describe the file. Mark it so the next read does not pay
      // for a comparison that cannot succeed.
      this.#justWrote = true;
    }
  }
}
