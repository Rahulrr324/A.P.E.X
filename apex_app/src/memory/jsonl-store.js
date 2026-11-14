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
// The snapshot's records are frozen and shared between reads, so a caller cannot mutate
// them into something the file does not contain, and a read pays the cost of the record
// list rather than a copy of every record and every nested field. Stores that do not
// enable it (tasks, conversation, operations) behave exactly as before and pay nothing.
//
// Snapshot work is skipped on the read that immediately follows one of this instance's own
// appends: those bytes were just changed by this instance, so a snapshot match cannot exist and
// hashing plus copying every record would be pure overhead. The snapshot is left exactly as it
// was: stale snapshots miss, they never serve stale records.
//
// Incremental validated state for writes (`loadForAppend()`). An ordinary append used to re-read,
// re-parse and re-validate the whole store, which made every write cost what the whole store
// costs and a series of appends quadratic. Instead, the read a write performs keeps the records it
// parsed and validated, keyed by the SHA-256 of the exact bytes that produced them, and that key
// is advanced after one of this instance's own appends by hashing only the bytes that append
// wrote. The next write reads the file (the bytes are always read) and hashes what it found before
// reusing anything, so a reuse proves the file is byte-for-byte the sequence these records were
// validated from. Anything else - another process's append, a truncation, a same-length rewrite of
// history, a replaced file - fails that check and is parsed and validated again by the same rules,
// and a store with corrupt lines retains nothing at all. A record this instance appends enters the
// state only after it has been read back from the exact line written and passed the same
// validation a cold read applies.
// Reusing validated records is not the same as trusting them: they were produced by the current
// integrity rules on bytes that are still byte-for-byte present. Nor is a write now constant time:
// it still reads and hashes the whole store, so it costs the store's size, just not the much larger
// cost of parsing and validating every record in it. This is not a persisted structure either, so a
// restart simply rebuilds it, and no store that leaves `parseCacheBytes` at 0 tracks anything. The
// same cap bounds this state: a store of more than `parseCacheBytes` bytes is neither re-derived
// into it nor grown into it, so the records one instance retains can never exceed that many bytes.
// The records are frozen, so neither a caller nor this class's own code can edit them into something
// the file does not contain.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StoreError } from '../errors.js';

function snapshotCorrupt(corrupt) {
  return corrupt.map((entry) => ({ ...entry }));
}

// Freezes a record to the depth the stores actually use: the record itself, every field that is an
// object or array, and the arrays and objects inside those fields. A retained record has to be
// uneditable by everyone including the code that handed it out, because sharing it without a copy
// is what the per-write whole-store copy exists to avoid; the freeze is what makes that sharing
// safe rather than merely convenient. The records a rebuild parsed are already exclusive to this
// instance, so they are frozen where they stand rather than copied first.
function freezeRecord(record) {
  Object.freeze(record);
  for (const value of Object.values(record)) {
    if (!value || typeof value !== 'object') continue;
    Object.freeze(value);
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === 'object') Object.freeze(item);
    } else {
      for (const inner of Object.values(value)) if (inner && typeof inner === 'object') Object.freeze(inner);
    }
  }
  return record;
}

// Retains a rebuilt store: every record frozen, in an array of this state's own so that a caller
// pushing onto the list it was handed cannot push onto the state.
function retainRecords(records) {
  for (const record of records) freezeRecord(record);
  return [...records];
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// The digest of "no bytes at all", which is the key of a store that does not exist yet.
const EMPTY_DIGEST = digest(Buffer.alloc(0));

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
  #appendState = null;
  #justWrote = false;
  #cacheHits = 0;
  #cacheMisses = 0;
  #appendReuses = 0;
  #appendRebuilds = 0;

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
  // the read that skips snapshot work because it immediately follows one of this instance's
  // own appends. The read that precedes an append is a `loadForAppend()` and is counted in
  // `appendStateStats`, not here.
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

  // Read-only introspection of the incremental validated state the write path maintains. Like
  // the snapshot stats it describes a performance aid, never stored data, and no decision about
  // a record may be taken from it: `tracked` says only that this instance is holding records it
  // validated from bytes it can still reproduce. `reuses` counts write reads answered without
  // re-parsing, `rebuilds` counts write reads that parsed and validated the whole file, so
  // `reuses` is never an assertion that the store is healthy - a rebuild is always available and
  // always happens on any mismatch.
  get appendStateStats() {
    const state = this.#appendState;
    return {
      enabled: this.parseCacheBytes > 0,
      maxBytes: this.parseCacheBytes,
      tracked: state !== null,
      trackedRecords: state?.records.length ?? 0,
      trackedBytes: state?.bytes ?? 0,
      reuses: this.#appendReuses,
      rebuilds: this.#appendRebuilds,
    };
  }

  // The file's bytes, or null for the store that does not exist yet. A path that exists but
  // cannot be read is a StoreError, never an empty store.
  async #readBytes() {
    try {
      return await fs.readFile(this.filePath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const parent = path.dirname(this.filePath);
        try {
          const parentStat = await fs.stat(parent);
          if (!parentStat.isDirectory()) {
            throw Object.assign(new Error('parent path is not a directory'), { code: 'ENOTDIR' });
          }
        } catch (statErr) {
          if (statErr && statErr.code === 'ENOENT') return null;
          throw new StoreError(`cannot read ${this.label}: ${statErr?.code || statErr?.message}`);
        }
        return null;
      }
      throw new StoreError(`cannot read ${this.label}: ${err?.code || err?.message}`);
    }
  }

  // The file's records and its damage, from one read of the file. The snapshot only ever
  // skips the parse step; the bytes are always read from disk and, unless this instance has
  // just written them, hashed and compared before any record is handed out.
  // `maintainSnapshot: false` asks for the records without any snapshot work at all: the
  // records are freshly parsed, exactly as on a miss, and the existing snapshot is left
  // untouched so it can only miss. A store write path no longer uses it (see `loadForAppend`);
  // it stays for callers that must not touch the snapshot, and it is how the benchmark measures
  // the pre-Batch V write read.
  // `certification` is an optional caller-owned object that receives `key`: the SHA-256 of the
  // exact bytes these records were parsed from, or null when this read did not establish one.
  // It is the same digest the snapshot compares, so a caller may reuse work derived from these
  // records only while that key still describes the file. It never changes what is returned.
  async load({ maintainSnapshot = true, certification = null } = {}) {
    const certify = certification && typeof certification === 'object' ? certification : null;
    if (certify) certify.key = null;
    const note = (key) => { if (certify) certify.key = key; };
    const buffer = await this.#readBytes();
    if (buffer === null) {
      note(EMPTY_DIGEST);
      return { records: [], corrupt: [] };
    }
    const text = () => buffer.toString('utf8');

    if (!maintainSnapshot) {
      this.#cacheMisses += 1;
      return parseLines(text(), this.validateRecord);
    }
    const cacheable = this.parseCacheBytes > 0 && buffer.length <= this.parseCacheBytes;
    if (!cacheable) return parseLines(text(), this.validateRecord);
    if (this.#justWrote) {
      // This instance changed the bytes, so a snapshot match cannot exist and hashing plus
      // copying every record would be pure write overhead. Parse and return; the next
      // unchanged read hashes and populates.
      this.#justWrote = false;
      this.#cacheMisses += 1;
      return parseLines(text(), this.validateRecord);
    }
    const key = digest(buffer);
    if (this.#snapshot && this.#snapshot.key === key) {
      this.#cacheHits += 1;
      note(key);
      // The records are frozen and shared; only the list around them is per-read, so a caller
      // sorting or pushing onto the list it was handed cannot reach the snapshot. A record field
      // cannot be edited at all, which is the same guarantee `loadForAppend()` already gives.
      return { records: [...this.#snapshot.records], corrupt: snapshotCorrupt(this.#snapshot.corrupt) };
    }
    this.#cacheMisses += 1;
    const parsed = parseLines(text(), this.validateRecord);
    const records = retainRecords(parsed.records);
    this.#snapshot = { key, bytes: buffer.length, records, corrupt: snapshotCorrupt(parsed.corrupt) };
    note(key);
    return { records: [...records], corrupt: parsed.corrupt };
  }

  // The read a write performs. It returns the same shape as `load()`: the file's records and its
  // damage, produced by the same parser and the same integrity rules. The difference is that it
  // may reuse this instance's incremental validated state instead of re-deriving it, which is what
  // stops an ordinary append from costing the whole store over again. Reuse requires proof: the
  // bytes on disk must hash to the key of the sequence those records were validated from, so any
  // other writer's change - appended, rewritten, or truncated - rebuilds the state by full parse
  // and validation instead. A state is only ever retained for a clean file, so a corrupt store is
  // never represented by retained records, and the corrupt lines the rebuild reports reach the
  // caller unchanged.
  async loadForAppend() {
    const buffer = await this.#readBytes();
    if (buffer === null) {
      // A store that does not exist yet has no records and no damage: zero bytes, trivially
      // validated. Installing that as the state costs nothing and lets this instance's first
      // append advance it, so a new store never re-parses what it just wrote. The next write read
      // still verifies the file's actual bytes against the key, so nothing is assumed about what
      // arrived on disk.
      this.#appendState = this.parseCacheBytes > 0
        ? { key: EMPTY_DIGEST, hash: createHash('sha256'), bytes: 0, records: [] }
        : null;
      return { records: [], corrupt: [] };
    }
    const state = this.#appendState;
    // The cap is consulted before anything is compared: a store this instance grew from empty is
    // no more retainable than one it re-derived, so tracked bytes never exceed `parseCacheBytes`.
    if (this.parseCacheBytes === 0 || buffer.length > this.parseCacheBytes) {
      if (state) this.#appendState = null;
      this.#appendRebuilds += 1;
      return parseLines(buffer.toString('utf8'), this.validateRecord);
    }
    // One hashing pass per write read, whichever path it takes: the digest that proves a reuse and
    // the live hash state that a confirmed append advances are both taken from one update of the
    // same bytes. Hashing the buffer twice would add a whole-store pass to the coldest write read.
    const hash = createHash('sha256').update(buffer);
    const key = hash.copy().digest('hex');
    if (state && state.bytes === buffer.length && key === state.key) {
      this.#appendReuses += 1;
      // A copy of the list, not of the records: the records are frozen, so a caller cannot turn
      // the shared ones into something else, and pushing to a returned list cannot push into the
      // state.
      return { records: [...state.records], corrupt: [] };
    }
    this.#appendRebuilds += 1;
    const parsed = parseLines(buffer.toString('utf8'), this.validateRecord);
    this.#appendState = parsed.corrupt.length === 0
      ? { key, hash, bytes: buffer.length, records: retainRecords(parsed.records) }
      : null;
    return parsed;
  }

  // Bring the incremental state up to date after one of this instance's appends. `size` is the
  // file's size this handle observed immediately before writing and `data` is exactly the bytes
  // written, so `size === state.bytes` means the file held nothing but the sequence this instance
  // validated before. Anything else drops the state: a write that raced another process's write,
  // an append onto a store this instance had not read, or a record that does not pass the current
  // integrity rules cannot leave derived state ahead of authoritative state, because the next
  // write read then re-derives the whole store.
  #advanceAfterAppend(line, data, size) {
    const state = this.#appendState;
    const stored = JSON.parse(line);
    if (!state || state.bytes !== size || size + data.length > this.parseCacheBytes || this.validateRecord(stored)) {
      this.#appendState = null;
      return;
    }
    // The record on disk is the one this append produced, and it has now passed the same
    // validation a cold read applies to it, so retaining it is not retaining an assumption.
    state.hash.update(data);
    state.key = state.hash.copy().digest('hex');
    state.bytes = size + data.length;
    state.records.push(freezeRecord(stored));
  }

  async append(record) {
    const line = `${JSON.stringify(record)}\n`;
    let handle;
    let written = 0;
    let total = 0;
    let size = 0;
    let data;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      handle = await fs.open(this.filePath, 'a+');
      size = (await handle.stat()).size;
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
      data = Buffer.from(prefix + line, 'utf8');
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
      // A failure is not proof that nothing was written. The bytes are visible to readers as soon
      // as a write returns; `written` only counts what this loop was told back, and a fault raised
      // after a write reached the file leaves the two disagreeing. Ask the file what it holds
      // before saying what may remain, so the note describes the residue rather than the loop.
      let onDisk = written;
      try {
        const stat = await handle.stat();
        onDisk = Math.max(0, stat.size - size);
      } catch {
        // An unusable handle says nothing about the file; fall back to what this loop accounted for.
      }
      const note = onDisk === 0
        ? ''
        : onDisk < total
          ? `; ${onDisk} byte(s) may remain as a partial line`
          : '; the record was written but its durability could not be confirmed, so it may be present';
      throw new StoreError(`cannot write ${this.label}: ${err?.code || err?.message}${note}`);
    } finally {
      if (handle) await handle.close().catch(() => {});
      // Whether the append succeeded, partially wrote, or failed, the bytes this instance
      // last snapshotted no longer describe the file. Mark it so the next read does not pay
      // for a comparison that cannot succeed.
      this.#justWrote = true;
    }
    // Reached only when the whole record is on disk and fsynced. An unconfirmed append can leave
    // bytes this instance did not account for, and the throw above means that step never runs, so
    // derived state can never advance past the authoritative log.
    this.#advanceAfterAppend(line, data, size);
  }
}
