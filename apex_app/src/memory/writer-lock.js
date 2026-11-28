// Writer lock: the critical section a read-modify-write on one append-only JSONL store needs
// when separate processes can write that store. A store write reads the whole authoritative
// log, derives a decision from it (is this a conflict, is this target already corrected,
// already retracted, still live, is this group already resolved), and appends one record. If a
// second process performs the same sequence while the first is between its read and its
// append, both see the state the other has not written yet, both decide from it, and one of
// those decisions is lost: the log then holds two replacements of the same claim, two
// retractions of the same target, or a claim recorded as `supported` beside the claim that
// contradicts it. Locking only the final append cannot prevent that, because the decision was
// taken before the append. So this lock is held across the whole sequence: read the
// authoritative bytes, derive, append, confirm the append.
//
// What it guarantees, and what it does not:
//  - it coordinates one store's writers across processes. It is not a multi-file transaction:
//    an operation that writes two stores still needs each write to be correct on its own;
//  - it never makes a decision for the caller. The caller must perform its read *inside* `run()`
//    so the state it derives from is the state observed after coordination was obtained;
//  - it is a mutual-exclusion claim, not evidence. Nothing here is stored in the log, and no
//    record's validity depends on it.
//
// The claim is created once, never rewritten. The completed body is staged under a private name
// and published by a hard link, so a competing process can never observe the lock name without
// its bytes and misreport the holder as unknown; the link succeeds only if the name is still
// free, which is the create-once property the exclusion depends on. Filesystems without hard
// links fall back to an exclusive create, which is still create-once but can briefly expose the
// name before its body is complete; a reader then sees an unreadable claim and treats it as in
// use, never as free.
//
// Uncertainty fails closed. A claim whose holder cannot be identified is treated as in use, and
// a waiting writer is refused with an explicit error after a bounded wait - never silently, and
// never after waiting forever. Liveness of a process number is not identity: Windows returns a
// freed process id to the allocator immediately, so a live answer may describe a stranger that
// recycled the number. Treating that claim as held refuses the write instead of risking two
// owners, which is why no portable identity check exists without a native dependency, and it is
// the same trade-off the task lock documents.
//
// A claim left by an exited process is taken over by exactly one process, through the election
// this module shares with the task lock (`../tasks/lock-recovery.js`): create-once tokens named
// after the claim's digest and an epoch, so at most one writer may remove a dead claim, and a
// writer killed mid-takeover cannot block the store forever. Recovery of abandoned tokens is the
// same `apex repair locks` path, and it is why this module never deletes a claim itself.
//
// Release proves ownership first. The claim is removed only while its bytes are still exactly the
// body this process wrote; anything else - absent, replaced, unreadable - means another process
// may have been inside the same critical section, and that is raised as `LOCK_LOST`. Because
// release runs only after the append completed, `LOCK_LOST` always describes a failure *after* an
// authoritative side effect, and its message says so: the record was written, so the caller must
// not repeat the write. A failure to remove a claim this process can still prove is its own is
// different: the section was exclusive, the record is safe, and the lingering claim names a live
// pid that other writers see and wait on. It is left in place rather than reported as a lost
// write, and it is visible in `state()` and recoverable once the holder exits.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StoreError } from '../errors.js';
import { TAKEOVER_EPOCHS, inspectLock, processAlive, recoverLock } from '../tasks/lock-recovery.js';

// How long a writer waits for another process's critical section before it is refused. The
// section is one whole-store read plus one fsynced append, so the budget is derived from the
// measured worst case rather than chosen to feel short: a single write at 40,000 records costs
// about 0.65 s (see README, Batch V), so this wait admits roughly fifteen such writers in a row
// before refusing. Correctness is not improved by waiting longer - a refused writer changes
// nothing and says so - and an unbounded wait would turn a stuck holder into a hung command.
export const WRITE_LOCK_WAIT_MS = 10000;

// Polling starts short because the common hold is a few milliseconds, and backs off so a writer
// waiting through a long hold does not spend the whole wait re-reading the claim.
export const WRITE_LOCK_RETRY_MIN_MS = 10;
export const WRITE_LOCK_RETRY_MAX_MS = 250;

// A claim removal is retried a bounded number of times before the claim is remembered as this
// instance's own orphan. Three attempts spread over ~60 ms is enough for the one case that
// motivates it - a reader's handle closing a millisecond after our unlink request - and refusing a
// write is better than the alternative of waiting inside a release.
const CLAIM_REMOVAL_ATTEMPTS = 3;
const CLAIM_REMOVAL_RETRY_MS = 10;
const ACTIVE_WRITER_LOCKS = new AsyncLocalStorage();

// A low-level append may be called from inside a store's read-modify-write lock. It reuses that
// same lock rather than trying to acquire it recursively; direct JsonlStore appends acquire their
// own lock. This context is process-local bookkeeping only. Cross-process exclusion remains the
// lock file protocol above.
export function isWriterLockHeld(filePath) {
  const held = ACTIVE_WRITER_LOCKS.getStore();
  return held instanceof Set && held.has(path.resolve(filePath));
}

export function runWithWriterLockContext(filePath, fn) {
  const inherited = ACTIVE_WRITER_LOCKS.getStore();
  const held = new Set(inherited instanceof Set ? inherited : []);
  held.add(path.resolve(filePath));
  return ACTIVE_WRITER_LOCKS.run(held, fn);
}

export class WriterLock {
  // `now` deliberately defaults to real wall time and is not the store's injected clock: the
  // timestamp in a claim body is diagnostics about a lock, never record content, and a store's
  // clock belongs to the records being written.
  constructor(filePath, {
    label = path.basename(filePath),
    waitMs = WRITE_LOCK_WAIT_MS,
    retryMs = WRITE_LOCK_RETRY_MIN_MS,
    retryMaxMs = WRITE_LOCK_RETRY_MAX_MS,
    now = () => new Date(),
    idFactory = randomUUID,
  } = {}) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.label = label;
    this.waitMs = Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : WRITE_LOCK_WAIT_MS;
    this.retryMs = Number.isInteger(retryMs) && retryMs > 0 ? retryMs : WRITE_LOCK_RETRY_MIN_MS;
    this.retryMaxMs = Number.isInteger(retryMaxMs) && retryMaxMs >= this.retryMs ? retryMaxMs : WRITE_LOCK_RETRY_MAX_MS;
    this.now = now;
    this.idFactory = idFactory;
  }

  // The exact body of a claim this process proved as its own but could not remove. Only this
  // process can reproduce that byte sequence, because it carries a nonce this instance generated,
  // so the next acquisition may reclaim and remove it. Without that, a claim that survives a
  // removal failure would name this still-live process forever, and every later write from this
  // process would refuse itself.
  #orphanedClaim = null;

  // Run `fn` as the sole writer of this store. Returns whatever `fn` returns. Throws
  // StoreError('LOCKED') when coordination could not be obtained - which always means nothing
  // was written - and StoreError('LOCK_LOST') when the append happened but exclusive ownership
  // of the section could not be proved at release. A failure of the filesystem itself (the store's
  // directory, the staged claim body, a takeover token) is StoreError('STORE_UNAVAILABLE'), the
  // same code the store read uses: it is an environment problem to fix, not contention to wait out,
  // and calling it contention would send the operator hunting for a lock that does not exist.
  async run(fn) {
    const body = await this.#acquire();
    let value;
    try {
      value = await runWithWriterLockContext(this.filePath, fn);
    } catch (err) {
      // The caller's failure is the report. A lingering claim of ours is inert bookkeeping that
      // the next writer takes over, so it must not replace the error that explains the refusal.
      await this.#releaseQuietly(body);
      throw err;
    }
    await this.#release(body);
    return value;
  }

  // Read-only view of the claim, its takeover tokens and the recovery guard. It never creates,
  // removes, or waits for the lock, so diagnostics can report a held write without disturbing it.
  async state() {
    return inspectLock(this.lockPath);
  }

  // Explicit recovery for abandoned takeover tokens, with the same limits as the task lock: a
  // live holder, a live takeover, an unidentified holder, or another recovery attempt all refuse,
  // and the claim itself is never removed here.
  async recover() {
    return recoverLock(this.lockPath, this.label);
  }

  async #acquire() {
    try {
      await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
    } catch (err) {
      throw new StoreError(`cannot write ${this.label}: its directory could not be prepared (${err?.code || err?.message}); nothing was written`, 'STORE_UNAVAILABLE');
    }
    const body = JSON.stringify({ pid: process.pid, nonce: this.idFactory(), at: this.now().toISOString() });
    const staged = `${this.lockPath}.${process.pid}.${randomUUID()}.tmp`;
    // The staged body is written without an fsync. Durability of the lock is not what the protocol
    // relies on: a holder that dies leaves a claim that the next writer takes over through the
    // election, and a machine that loses power loses the lock either way. What matters is that the
    // bytes are visible before the name exists, which the write-then-link order gives from the
    // shared page cache. Requiring the lock's own fsync would charge every write for durability no
    // reader depends on. The write is checked byte for byte: a claim published from an incomplete
    // body would be read by another process as an unidentified holder.
    try {
      await writeFull(staged, body, 'w');
    } catch (err) {
      await fs.rm(staged, { force: true }).catch(() => {});
      throw new StoreError(`cannot write ${this.label}: its claim could not be prepared (${err?.code || err?.message}); nothing was written`, 'STORE_UNAVAILABLE');
    }
    const deadline = Date.now() + this.waitMs;
    let delay = this.retryMs;
    try {
      for (;;) {
        const claimed = await this.#claim(body, staged);
        if (claimed) return body;

        let raw;
        try {
          raw = await fs.readFile(this.lockPath, 'utf8');
        } catch (err) {
          if (err?.code === 'ENOENT') continue; // released between the failed claim and this read
          raw = null; // any other read failure proves nothing about the holder: treat as in use
        }

        // A claim this instance wrote but failed to remove is ours to remove: its body carries a
        // nonce no other process could have generated. Reclaiming it here is what keeps a process
        // whose removal was refused (Windows can refuse to delete a file another process is still
        // reading) from locking itself out of its own store.
        if (raw !== null && raw === this.#orphanedClaim) {
          if (await this.#removeClaim()) continue;
          throw new StoreError(
            `cannot write ${this.label}: a claim this process wrote earlier is still held by the operating system and cannot be removed; nothing was written`,
            'LOCKED',
          );
        }

        const pid = readPid(raw);
        if (pid !== null && !processAlive(pid)) {
          const election = await this.#electTakeover(raw);
          if (election.won) {
            try {
              // Compare before removing: a claim that changed is somebody else's live section now.
              const stillThere = await fs.readFile(this.lockPath, 'utf8').catch(() => null);
              if (stillThere === raw) {
                if (await this.#removeClaim()) continue;
                throw new StoreError(
                  `cannot write ${this.label}: the claim left by process ${pid} could not be removed; nothing was written`,
                  'LOCKED',
                );
              }
            } finally {
              await election.release();
            }
          }
        }
        if (Date.now() >= deadline) throw this.#refusal(pid);
        await sleep(delay);
        delay = Math.min(delay * 2, this.retryMaxMs);
      }
    } finally {
      await fs.rm(staged, { force: true }).catch(() => {});
    }
  }

  // Attempts the create-once publication. True means this process holds the claim.
  async #claim(body, staged) {
    try {
      await fs.link(staged, this.lockPath);
      return true;
    } catch (err) {
      if (err?.code === 'EEXIST') return false;
      try {
        await writeExclusive(this.lockPath, body);
        return true;
      } catch (createErr) {
        if (createErr?.code === 'EEXIST') return false;
        throw new StoreError(`cannot write ${this.label}: its claim could not be created (${createErr?.code || createErr?.message}); nothing was written`, 'STORE_UNAVAILABLE');
      }
    }
  }

  #refusal(pid) {
    return new StoreError(
      `cannot write ${this.label}: it is in use by process ${pid ?? 'unknown'}; nothing was written`,
      'LOCKED',
    );
  }

  // Elects one taker for one dead claim, exactly as the task lock does: a token published with a
  // create-once hard link under a name derived from the claim's digest and an epoch. A live token
  // holder means the takeover is happening now, so this writer is refused; a token whose holder
  // exited is superseded by the next epoch. After TAKEOVER_EPOCHS abandoned attempts the claim is
  // reported as needing `apex repair locks`, which removes tokens and never a claim.
  async #electTakeover(raw) {
    const key = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
    const body = JSON.stringify({ pid: process.pid, nonce: this.idFactory(), at: this.now().toISOString() });
    const staged = `${this.lockPath}.takeover.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFull(staged, body, 'w');
    } catch (err) {
      await fs.rm(staged, { force: true }).catch(() => {});
      throw new StoreError(`cannot write ${this.label}: its takeover claim could not be prepared (${err?.code || err?.message}); nothing was written`, 'STORE_UNAVAILABLE');
    }
    try {
      for (let epoch = 0; epoch < TAKEOVER_EPOCHS; epoch += 1) {
        const tokenPath = `${this.lockPath}.takeover.${key}.${epoch}`;
        try {
          await fs.link(staged, tokenPath);
          return this.#takeoverWon(tokenPath, body);
        } catch (err) {
          if (err?.code !== 'EEXIST') {
            try {
              await writeExclusive(tokenPath, body);
              return this.#takeoverWon(tokenPath, body);
            } catch (createErr) {
              if (createErr?.code !== 'EEXIST') {
                throw new StoreError(`cannot write ${this.label}: its takeover token could not be created (${createErr?.code || createErr?.message}); nothing was written`, 'STORE_UNAVAILABLE');
              }
            }
          }
        }
        const held = await fs.readFile(tokenPath, 'utf8').catch(() => null);
        if (held === null) continue; // released between our link and our read: that taker finished
        const tokenPid = readPid(held);
        // A token with no readable holder proves nothing about its taker, so it is reported as in
        // use rather than assumed abandoned.
        if (tokenPid === null) return { won: false, pid: null, release: async () => {} };
        if (processAlive(tokenPid)) return { won: false, pid: tokenPid, release: async () => {} };
      }
    } finally {
      await fs.rm(staged, { force: true }).catch(() => {});
    }
    throw new StoreError(
      `cannot write ${this.label}: ${TAKEOVER_EPOCHS} takeover attempts are recorded as abandoned; run "apex repair locks" after confirming no writer is active; nothing was written`,
      'LOCKED',
    );
  }

  #takeoverWon(tokenPath, body) {
    return {
      won: true,
      pid: process.pid,
      async release() {
        const mine = await fs.readFile(tokenPath, 'utf8').catch(() => null);
        if (mine === body) await fs.rm(tokenPath, { force: true }).catch(() => {});
      },
    };
  }

  async #release(body) {
    let mine;
    try {
      mine = await fs.readFile(this.lockPath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw new StoreError(this.#lostMessage('the claim is gone before it could be removed'), 'LOCK_LOST');
      }
      throw new StoreError(
        this.#lostMessage(`the claim cannot be read (${err?.code || err?.message})`),
        'LOCK_LOST',
      );
    }
    if (mine !== body) {
      throw new StoreError(this.#lostMessage(`the claim names process ${readPid(mine) ?? 'unknown'}`), 'LOCK_LOST');
    }
    if (!await this.#removeClaim()) this.#orphanedClaim = body;
    // A claim that could not be removed is not a lost write: ownership was proved, the section was
    // exclusive, and the record is in the store. It is remembered so this instance's next
    // acquisition can reclaim it, and it is visible through `state()`.
  }

  async #releaseQuietly(body) {
    let mine = null;
    try {
      mine = await fs.readFile(this.lockPath, 'utf8');
    } catch {
      return;
    }
    if (mine !== body) return; // not ours to remove
    if (!await this.#removeClaim()) this.#orphanedClaim = body;
  }

  // Removes the claim, retrying briefly: Windows can refuse to delete a file that another process
  // still holds open for reading, and the poll that waits for a holder is exactly such a read.
  // The retries are bounded, and a claim that survives them is remembered as this instance's own
  // orphan rather than reported as a failure of the write.
  async #removeClaim() {
    for (let attempt = 0; attempt < CLAIM_REMOVAL_ATTEMPTS; attempt += 1) {
      try {
        await fs.rm(this.lockPath, { force: true });
        this.#orphanedClaim = null;
        return true;
      } catch (err) {
        if (err?.code === 'ENOENT') {
          this.#orphanedClaim = null;
          return true;
        }
        await sleep(CLAIM_REMOVAL_RETRY_MS * (attempt + 1));
      }
    }
    return false;
  }

  #lostMessage(detail) {
    return `the ${this.label} writer lock could not be proved ours on release: ${detail}. The record was written, so do not repeat the write; run "apex diagnose" to see what the store holds.`;
  }
}

function readPid(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const pid = Number(JSON.parse(raw)?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Writes the whole body, checking every byte the file accepted. A claim is published from this
// content, so a write that stopped short must fail here rather than publish a lock that readers
// can only report as unidentified.
async function writeFull(file, text, flag) {
  const handle = await fs.open(file, flag);
  try {
    const data = Buffer.from(text, 'utf8');
    let written = 0;
    while (written < data.length) {
      const { bytesWritten } = await handle.write(data, written, data.length - written);
      if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
        throw new Error(`write accepted ${written} of ${data.length} bytes`);
      }
      written += bytesWritten;
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

// The create-once fallback for filesystems without hard links. `wx` still admits exactly one
// winner; the body write is what makes the name visible, so a racer can briefly find the name
// before its bytes, which readers treat as in use and never as free.
async function writeExclusive(file, text) {
  await writeFull(file, text, 'wx');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
