// Batch AP-06: a cross-store read snapshot for evidence assembled from several append-only logs.
//
// The problem this solves: a report such as adaptation effectiveness reads the experience log, the plan
// log and the audit log one after another. Each read is internally consistent, but a write that lands
// between them can make the combined result describe a combination of states that never existed at one
// instant. There is no cross-store transaction in APEX and this module does not invent one.
//
// What it does instead is prove a quiescent window. Every contributing store is a JSON Lines file that is
// only ever appended to (see `jsonl-store.js`), so its size never decreases without a truncation or a
// replacement, both of which are damage this module also detects. The snapshot records each file's
// identity - existence, byte size, modification time, and (AP-07) the SHA-256 of the exact bytes - before
// the first read and again after the last one. If no identity moved, every read in it observed the bytes
// that were present at the start; the combination therefore did exist at that moment. If an identity
// moved, the result is reported as `concurrent_modification`, which is a statement about the read, never
// about the underlying evidence.
//
// AP-07 added content certification because file metadata is not content. AP-06 compared existence, size
// and modification time, so a replacement that preserved both size and mtime was invisible. The identity
// now carries a digest of the whole file, taken at both inspections, and a digest that differs is a
// change even when every metadata field still agrees. That makes truncation, replacement, deletion and
// creation detectable from the snapshot itself rather than delegated to the stores, and it lets the
// report name which of them happened. The digest is of the bytes as they read; it is not a signature and
// it certifies nothing about their truth.
//
// Limits, stated plainly: a consistent snapshot is not a distributed transaction, it holds no lock, and
// it cannot stop a writer. It only certifies that no writer it could see changed a contributing file
// while the read was in progress. A store that cannot be inspected makes the whole snapshot
// `unverifiable`, which is also a refusal to claim consistency - not an empty snapshot. Content
// certification tightens the window to bytes, but a write that lands between the two inspections of the
// same window can still make the digest describe a moment that is neither the beginning nor the end; the
// comparison detects that the bytes differ, not which instant either read observed. A same-size rewrite
// that is later rewritten back to the original bytes is invisible to any before/after comparison; the
// stores' own validation remains the authority for their records. Certification is configurable
// (`content: false`), but a metadata-only window says so explicitly and never claims content equality.
//
// A retry is bounded and explicit: `runConsistentEvidenceRead` may re-run the whole read (three attempts
// by default and at most) when a change is detected, because replaying a read has no external effect. It
// never retries indefinitely, and it never retries an unverifiable store.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../memory/memory-store.js';
import { stableStringify } from '../tasks/model.js';

export const SNAPSHOT_SCHEMA = 'apex.evidence-snapshot.v1';
export const SNAPSHOT_STATES = Object.freeze([
  'consistent',
  'concurrent_modification',
  'unverifiable',
]);
export const MAX_SNAPSHOT_STORES = 32;
// A window is retired only when a writer was actually seen inside it, and one write invalidates at
// most one window. Two concurrent appends (a record and its audit line) can therefore retire at most
// two windows, so three attempts certify the read; the budget never grows with the store.
export const DEFAULT_SNAPSHOT_ATTEMPTS = 3;
export const MAX_SNAPSHOT_ATTEMPTS = 3;

const singleLine = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function attemptCount(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return DEFAULT_SNAPSHOT_ATTEMPTS;
  return Math.min(number, MAX_SNAPSHOT_ATTEMPTS);
}

// One file's identity. A missing file is a real identity - the store has not been created - and is
// different from a path that exists but cannot be inspected, which makes the snapshot unverifiable.
// Modification time is rounded to whole milliseconds so the digest is not noisy across platforms.
//
// With `content: true` (the default) the identity also carries the SHA-256 of the exact bytes, read
// once and before the size is taken. This is what closes the AP-06 blind spot: a replacement that
// preserves size and mtime changes the digest. It is a digest of what the bytes are, never a claim
// that they are true or that the file is authentic; a store that cannot be read is `unavailable`, not
// an empty file.
export async function storeIdentity(filePath, { content = true } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { exists: false, size: 0, mtimeMs: null, digest: null, state: 'not_configured', detail: null };
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return {
        exists: false, size: 0, mtimeMs: null, digest: null, state: 'unavailable',
        detail: `${singleLine(filePath, 120)} is not a regular file`,
      };
    }
    let digest = null;
    if (content) {
      const bytes = await fs.readFile(filePath);
      digest = createHash('sha256').update(bytes).digest('hex');
    }
    return {
      exists: true,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      digest,
      state: 'read',
      detail: null,
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { exists: false, size: 0, mtimeMs: null, digest: null, state: 'absent', detail: null };
    }
    return {
      exists: false, size: 0, mtimeMs: null, digest: null, state: 'unavailable',
      detail: `${singleLine(err?.code ?? err?.message ?? 'store error', 120)} reading ${singleLine(filePath, 120)}`,
    };
  }
}

function identityOf(entry) {
  return {
    name: entry.name,
    exists: entry.identity.exists,
    size: entry.identity.size,
    mtimeMs: entry.identity.mtimeMs,
    digest: entry.identity.digest ?? null,
  };
}

function sameIdentity(a, b) {
  return a.exists === b.exists && a.size === b.size && a.mtimeMs === b.mtimeMs && a.digest === b.digest;
}

// What kind of movement the window saw. It names the observed difference, not a cause: `truncated`
// is a shorter file, `replaced` is new bytes of the same length, `content_changed` is new bytes whose
// metadata agrees, and `touched` is metadata alone with byte-identical content.
function changeKind(from, to) {
  if (from.exists && !to.exists) return 'deleted';
  if (!from.exists && to.exists) return 'created';
  if (from.size !== to.size) return from.size < to.size ? 'appended' : 'truncated';
  if (from.digest !== null && to.digest !== null && from.digest !== to.digest) {
    return from.mtimeMs === to.mtimeMs ? 'content_changed' : 'replaced';
  }
  return 'touched';
}

function digestOf(value) {
  return sha256Hex(stableStringify(value));
}

// A read-scoped snapshot. `read` memoises one store read per label for the life of the snapshot, so a
// report that needs the same store twice in one operation reads it once - which is also what makes the
// second read consistent by construction rather than by luck. The cache is never shared across
// operations and is never persisted; a new operation opens a new snapshot.
export class EvidenceSnapshot {
  #verified = null;

  constructor(entries, { content = true } = {}) {
    this.schema = SNAPSHOT_SCHEMA;
    this.entries = entries;
    this.reads = new Map();
    // Content certification compares the bytes, not only their metadata. A metadata-only window is
    // still a window, but it can never claim the content was unchanged, and it says so.
    this.certification = content ? 'content' : 'metadata';
  }

  // The identity recorded before the first contributing read.
  get begin() {
    return this.entries.map((entry) => ({ name: entry.name, ...identityOf(entry) }));
  }

  async read(label, fn) {
    const key = String(label ?? 'read');
    if (this.reads.has(key)) return this.reads.get(key);
    const pending = (async () => fn())();
    this.reads.set(key, pending);
    return pending;
  }

  // Re-inspect every contributing file. An unreadable identity outranks a changed one: a store that
  // cannot be inspected could have changed, so consistency cannot be claimed either way. A change is
  // any identity difference, including a digest difference whose metadata still agrees.
  async verify() {
    if (this.#verified) return this.#verified;
    const content = this.certification === 'content';
    const after = await Promise.all(this.entries.map((entry) => storeIdentity(entry.identity.filePath, { content })));
    const changed = [];
    const unverifiable = [];
    const stores = [];
    for (let i = 0; i < this.entries.length; i += 1) {
      const entry = this.entries[i];
      const from = identityOf(entry);
      const to = { name: entry.name, ...identityOf({ name: entry.name, identity: after[i] }) };
      if (entry.identity.state === 'not_configured' || after[i].state === 'not_configured') {
        stores.push({ ...from, state: 'not_configured', changed: false });
        continue;
      }
      if (entry.identity.state === 'unavailable' || after[i].state === 'unavailable') {
        unverifiable.push(entry.name);
        stores.push({
          ...from, state: 'unavailable', changed: false,
          detail: after[i].detail ?? entry.identity.detail ?? 'the store could not be inspected',
        });
        continue;
      }
      const moved = !sameIdentity(from, to);
      if (moved) changed.push({ name: entry.name, kind: changeKind(from, to), from, to });
      stores.push({
        ...from, state: entry.identity.state === 'absent' ? 'absent' : 'read', changed: moved,
        ...(moved ? { to, kind: changeKind(from, to) } : {}),
      });
    }
    const state = unverifiable.length > 0
      ? 'unverifiable'
      : changed.length > 0 ? 'concurrent_modification' : 'consistent';
    const canonical = {
      schema: this.schema,
      certification: this.certification,
      state,
      stores: this.entries.map((entry, i) => ({
        name: entry.name,
        begin: identityOf(entry),
        end: { name: entry.name, ...identityOf({ name: entry.name, identity: after[i] }) },
      })),
    };
    this.#verified = {
      schema: this.schema,
      certification: this.certification,
      state,
      consistent: state === 'consistent',
      complete: state === 'consistent',
      changed,
      unverifiable,
      stores,
      reads: this.reads.size,
      digest: digestOf(canonical),
      beginDigest: digestOf({ schema: this.schema, certification: this.certification, stores: this.begin }),
      bounded: this.entries.length >= MAX_SNAPSHOT_STORES,
      note: content
        ? 'a consistent snapshot proves that no contributing append-only file differed, byte for byte, between the start and end of this read; it is not a transaction, holds no lock, and says nothing about whether the records are true'
        : 'a metadata-only snapshot proves that no contributing file changed size or modification time during this read; it cannot see a same-size rewrite, and says nothing about whether the records are true',
    };
    return this.#verified;
  }

  // The verdict so far. Before `verify()` this is explicitly unverified rather than consistent.
  summary() {
    if (this.#verified) {
      const { changed, unverifiable, ...rest } = this.#verified;
      return rest;
    }
    return {
      schema: SNAPSHOT_SCHEMA,
      certification: this.certification,
      state: 'unverified',
      consistent: false,
      complete: false,
      changed: [],
      unverifiable: [],
      stores: this.begin,
      reads: this.reads.size,
      digest: null,
      beginDigest: digestOf({ schema: SNAPSHOT_SCHEMA, certification: this.certification, stores: this.begin }),
      bounded: this.entries.length >= MAX_SNAPSHOT_STORES,
    };
  }
}

// Build a snapshot from `[{ name, store }]` or `[{ name, filePath }]`. A store that is not configured in
// this build is recorded as such and is not counted as a change; a store with a path that cannot be
// inspected makes the snapshot unverifiable. `content: false` asks for a metadata-only window; the
// verdict then reports `certification: 'metadata'` and never claims byte equality.
export async function openEvidenceSnapshot({ stores = [], content = true } = {}) {
  if (!Array.isArray(stores)) throw new TypeError('a snapshot needs a list of stores');
  if (typeof content !== 'boolean') throw new TypeError('a snapshot needs content certification to be a boolean');
  const wanted = stores.filter(Boolean);
  if (wanted.length > MAX_SNAPSHOT_STORES) {
    throw new Error(`a snapshot covers at most ${MAX_SNAPSHOT_STORES} stores, not ${wanted.length}`);
  }
  const entries = await Promise.all(wanted.map(async (item, index) => {
    const name = singleLine(item.name ?? `store-${index + 1}`, 64);
    const filePath = typeof item.filePath === 'string'
      ? item.filePath
      : (typeof item.store?.filePath === 'string' ? item.store.filePath : null);
    return { name, identity: { filePath, ...(await storeIdentity(filePath, { content })) } };
  }));
  return new EvidenceSnapshot(entries, { content });
}

// One consistent read with a bounded, disclosed retry. `read(snapshot)` must perform its store reads
// through `snapshot.read(label, fn)`. Returns `{ ok, state, value, snapshot, attempts }`; a store read
// that throws propagates unchanged, because a failed read is not a concurrent modification.
export async function runConsistentEvidenceRead({ stores = [], attempts = DEFAULT_SNAPSHOT_ATTEMPTS, read, content = true } = {}) {
  if (typeof read !== 'function') throw new TypeError('a consistent read needs a read function');
  const limit = attemptCount(attempts);
  let last = null;
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const snapshot = await openEvidenceSnapshot({ stores, content });
    const value = await read(snapshot);
    const verdict = await snapshot.verify();
    last = { value, snapshot: verdict, attempts: attempt, ok: verdict.state === 'consistent', state: verdict.state };
    if (verdict.state === 'consistent') return last;
    if (verdict.state === 'unverifiable') return last;
  }
  return last;
}

// A view of a store whose named read methods are performed through a snapshot. Only the methods named
// are wrapped: a view is a deliberately narrow read surface, never a transparent proxy, so a write
// cannot be cached by accident. Two calls with the same arguments in one window return the same result,
// which is what makes a second read of the same record consistent by construction rather than by luck.
//
// A method that answers synchronously stays synchronous through the view. Wrapping it in the snapshot's
// promise would hand a caller a promise where it was promised a value, which is how a pure check
// (`validatePlan`) turns into a thrown type error at the call site.
export function snapshotView(store, name, read, methods = []) {
  if (!store || typeof store !== 'object') return store;
  const view = {};
  // The store's own data fields travel with the view: a plan check reads the registry its store was
  // built with, and a view that dropped that wiring would make a check fail for a reason that has
  // nothing to do with the records. Only functions are replaced, and only the named ones.
  for (const key of Object.keys(store)) {
    if (typeof store[key] !== 'function') view[key] = store[key];
  }
  for (const method of methods) {
    const fn = store[method];
    if (typeof fn !== 'function') continue;
    view[method] = (...args) => {
      const label = `${name}:${method}:${stableStringify(args)}`;
      if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
        return read(label, () => fn.apply(store, args));
      }
      const value = fn.apply(store, args);
      // A method declared synchronous that still returns a promise is one read, so its promise is
      // memoised under the same label; a method that returns a value is handed back as it came.
      return value && typeof value.then === 'function' ? read(label, () => value) : value;
    };
  }
  return view;
}

// The store list a caller passes for the stores it intends to read. Null stores are omitted rather than
// recorded, because a store this build does not have cannot be an inconsistent one.
export function contributingStores(stores = {}) {
  const labels = [
    ['experience', stores.experience],
    ['plans', stores.plans],
    ['operations', stores.operations],
    ['goals', stores.goals],
    ['knowledge', stores.knowledge],
    ['memory', stores.memory],
    ['predictions', stores.predictions],
    ['world', stores.world],
    ['tasks', stores.tasks],
  ];
  return labels
    .filter(([, store]) => store && typeof store.filePath === 'string')
    .map(([name, store]) => ({ name, store }));
}
