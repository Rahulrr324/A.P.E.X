// Delivery work list for the task summaries that conversation history refused. A
// summary is the history record of what a task run established; when history cannot be
// written the failure is disclosed, but the reference to an otherwise completed task is
// then missing from future conversation. This queue keeps that unsaved turn so the next
// task write can offer it again.
//
// It is a work list, not evidence. The task log and the audit log stay the authoritative
// records, nothing here can cause a step to run, and an entry is removed only once its
// turn is confirmed written. The stored text is the bounded summary APEX had already
// built from those records, so a reissued turn states exactly what the refused turn would
// have stated - including that a step is uncertain or has no audit record.
//
// The file is replaced atomically (write a temp file, then rename) the way session.json
// is written. Replacing it whole means two read-modify-write calls interleaved across
// processes would keep only the later file, so each change runs under a lock file
// (task-summary-queue.json.lock): the lock is excluded for the duration of the read and
// the write, and a waiting caller is refused with an error rather than told its intent
// was queued when it was not.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StoreError } from '../errors.js';
import { TASK_SIGNATURE_RE, prepareTurnText } from '../memory/conversation-store.js';
import { MAX_TASK_SUMMARY_CHARS } from './summary.js';
import { inspectLock, recoverLock, identifiedPid, TAKEOVER_EPOCHS } from './lock-recovery.js';

export const SUMMARY_QUEUE_SCHEMA = 1;
// How long an update waits for another process's in-progress update. The critical
// section is one small read and one small rename, so a wait this long means the holder
// is stuck or gone; refusing then is honest, and the caller discloses the missed reissue.
// Exported so a test can pin the budget the same way the writer lock's is pinned.
export const LOCK_WAIT_MS = 2000;
export const LOCK_RETRY_MS = 10;
// Past this size history has refused summaries across many task states. A new intent is
// then refused and disclosed rather than displacing an older one.
export const MAX_QUEUED_SUMMARIES = 32;
// How many intents one turn offers, oldest first. The rest wait for the next one.
export const SUMMARIES_PER_DELIVERY = 4;

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'not an object';
  for (const key of ['id', 'sessionId', 'taskId', 'signature', 'text']) {
    if (typeof entry[key] !== 'string' || entry[key].length === 0) return `missing ${key}`;
  }
  if (!TASK_SIGNATURE_RE.test(entry.signature)) return 'bad task signature';
  if (entry.text.length > MAX_TASK_SUMMARY_CHARS) return 'summary text exceeds the task summary limit';
  if (typeof entry.verified !== 'boolean') return 'missing verified flag';
  if (typeof entry.queuedAt !== 'string' || Number.isNaN(Date.parse(entry.queuedAt))) return 'bad queuedAt';
  return null;
}

// Liveness of a process number, not identity: a recycled number keeps the queue lock
// fail-closed exactly as it does for the task lock in ../tasks/store.js.
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // exists, but belongs to another user
  }
}

async function writeSynced(file, text) {
  const handle = await fs.open(file, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusive(file, text) {
  const handle = await fs.open(file, 'wx');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SummaryQueue {
  constructor(filePath, { now = () => new Date(), idFactory = randomUUID } = {}) {
    this.filePath = filePath;
    this.label = path.basename(filePath);
    this.now = now;
    this.idFactory = idFactory;
  }

  // A missing file is an empty queue. A file that cannot be read, or that cannot be
  // parsed whole, is reported as damage: answering "nothing is owed" from a partial read
  // would drop a summary that was never written.
  async entries() {
    let text;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw new StoreError(`cannot read ${this.label}: ${err?.code || err?.message}`);
    }
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new StoreError(`${this.label} is corrupt (invalid JSON)`);
    }
    if (!obj || obj.schema !== SUMMARY_QUEUE_SCHEMA || !Array.isArray(obj.entries)) {
      throw new StoreError(`${this.label} is corrupt (unsupported shape)`);
    }
    for (const entry of obj.entries) {
      const problem = validateEntry(entry);
      if (problem) throw new StoreError(`${this.label} is corrupt (entry ${problem})`);
    }
    return obj.entries;
  }

  // Serialises one read-modify-write of the queue against other processes. The lock body
  // is staged complete and published with a hard link, so a competing process never reads
  // a half-written lock and mistakes a live holder for a dead one. A lock left by an exited
  // process is taken over by exactly one process: deletion cannot be conditional without a
  // native dependency, so the right to remove is elected with create-once tokens first (the
  // same reasoning as the task lock in ./store.js), and only the elected taker removes it.
  // Filesystems without hard links fall back to an exclusive create, which still admits one
  // holder.
  async #withLock(fn) {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    } catch (err) {
      throw new StoreError(`cannot prepare the task summary queue directory: ${err?.code || err?.message}`);
    }
    const lockPath = `${this.filePath}.lock`;
    const body = JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: this.now().toISOString() });
    const staged = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeSynced(staged, body);
    } catch (err) {
      await fs.rm(staged, { force: true }).catch(() => {});
      throw new StoreError(`cannot update ${this.label}: ${err?.code || err?.message}`);
    }
    const deadline = Date.now() + LOCK_WAIT_MS;
    try {
      for (;;) {
        let acquired = false;
        try {
          await fs.link(staged, lockPath);
          acquired = true;
        } catch (err) {
          if (err?.code !== 'EEXIST') {
            // No hard-link support here: exclusive create is still create-once.
            try {
              await writeExclusive(lockPath, body);
              acquired = true;
            } catch (createErr) {
              if (createErr?.code !== 'EEXIST') {
                throw new StoreError(`cannot update ${this.label}: ${createErr?.code || createErr?.message}`);
              }
            }
          }
        }
        if (acquired) break;

        let raw = null;
        try {
          raw = await fs.readFile(lockPath, 'utf8');
        } catch {
          raw = null; // unreadable or still being written: treat as in use
        }
        let holder = null;
        try {
          holder = JSON.parse(raw);
        } catch {
          holder = null;
        }
        const pid = Number(holder?.pid);
        if (raw !== null && Number.isInteger(pid) && pid > 0 && !processAlive(pid)) {
          const election = await this.#electTakeover(raw);
          let tookOver = false;
          try {
            if (election.won) {
              const stillThere = await fs.readFile(lockPath, 'utf8').catch(() => null);
              if (stillThere === raw) {
                await fs.rm(lockPath, { force: true });
                tookOver = true;
              }
            }
          } finally {
            await election.release();
          }
          if (tookOver) continue;
          if (Date.now() >= deadline) {
            throw new StoreError(`cannot update ${this.label}: it is in use by process ${election.pid ?? identifiedPid(holder?.pid) ?? 'unknown'}; nothing was changed`, 'LOCKED');
          }
          await sleep(LOCK_RETRY_MS);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new StoreError(`cannot update ${this.label}: it is in use by process ${identifiedPid(holder?.pid) ?? 'unknown'}; nothing was changed`, 'LOCKED');
        }
        await sleep(LOCK_RETRY_MS);
      }
      try {
        return await fn();
      } finally {
        const mine = await fs.readFile(lockPath, 'utf8').catch(() => null);
        if (mine === body) await fs.rm(lockPath, { force: true });
      }
    } finally {
      await fs.rm(staged, { force: true }).catch(() => {});
    }
  }

  // Elects one taker for one dead lock claim, exactly as the task lock does: a token name
  // derived from the claim and an epoch is published with a create-once hard link, so at
  // most one process removes the claim. A live token holder means the takeover is in
  // progress; a token whose holder exited is superseded by the next epoch, so a process
  // killed during a takeover cannot block queue updates forever.
  async #electTakeover(raw) {
    const lockPath = `${this.filePath}.lock`;
    const key = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
    const body = JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: this.now().toISOString() });
    const staged = `${lockPath}.takeover.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeSynced(staged, body);
    } catch (err) {
      throw new StoreError(`cannot update ${this.label}: ${err?.code || err?.message}`);
    }
    try {
      for (let epoch = 0; epoch < TAKEOVER_EPOCHS; epoch += 1) {
        const tokenPath = `${lockPath}.takeover.${key}.${epoch}`;
        try {
          await fs.link(staged, tokenPath);
          return this.#takeoverWon(tokenPath, body);
        } catch (err) {
          if (err?.code !== 'EEXIST') {
            // Same fallback as the queue lock itself: exclusive create is create-once.
            try {
              await writeExclusive(tokenPath, body);
              return this.#takeoverWon(tokenPath, body);
            } catch (createErr) {
              if (createErr?.code !== 'EEXIST') {
                throw new StoreError(`cannot update ${this.label}: ${createErr?.code || createErr?.message}`);
              }
            }
          }
        }
        const held = await fs.readFile(tokenPath, 'utf8').catch(() => null);
        if (held === null) continue; // released between our link and read: that taker is done
        let tokenPid = null;
        try {
          const h = JSON.parse(held);
          const p = Number(h?.pid);
          if (Number.isInteger(p) && p > 0) tokenPid = p;
        } catch {
          tokenPid = null;
        }
        // An unreadable token proves nothing about the taker, so it is reported as in use.
        if (tokenPid === null) return { won: false, pid: null, release: async () => {} };
        if (processAlive(tokenPid)) return { won: false, pid: tokenPid, release: async () => {} };
      }
    } finally {
      await fs.rm(staged, { force: true }).catch(() => {});
    }
    throw new StoreError(`cannot update ${this.label}: ${TAKEOVER_EPOCHS} takeover attempts are recorded as abandoned; run "apex repair locks" after confirming no task run is active`, 'LOCKED');
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

  // Read-only view of the queue lock, its takeover tokens, and a recovery guard.
  async lockReport() {
    return inspectLock(`${this.filePath}.lock`);
  }

  // Explicit recovery for a queue-lock claim whose holder has exited.
  async recover() {
    return recoverLock(`${this.filePath}.lock`, 'task summary queue');
  }

  async #write(entries) {
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const handle = await fs.open(tmp, 'w');
      try {
        await handle.writeFile(`${JSON.stringify({ schema: SUMMARY_QUEUE_SCHEMA, entries }, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw new StoreError(`cannot write ${this.label}: ${err?.code || err?.message}`);
    }
  }

  // The intents one session still owes, oldest first. An entry belonging to another
  // session stays where it is: a summary belongs to the conversation that task reported
  // on, and writing it into a different session would present an old task as current
  // context.
  async pending({ sessionId, limit = SUMMARIES_PER_DELIVERY } = {}) {
    const all = await this.entries();
    return all.filter((entry) => entry.sessionId === sessionId).slice(0, Math.max(0, limit));
  }

  // The same task state owed to the same session is never queued twice, so repeated
  // failures of one summary cannot grow the file.
  async add({ sessionId, taskId, signature, text, verified }) {
    return this.#withLock(async () => {
      const all = await this.entries();
      const existing = all.find((entry) => entry.sessionId === sessionId
        && entry.taskId === taskId
        && entry.signature === signature);
      if (existing) return { queued: true, reason: 'already-queued', entry: existing };
      if (all.length >= MAX_QUEUED_SUMMARIES) return { queued: false, reason: 'queue-full' };
      const entry = {
        id: this.idFactory(),
        sessionId,
        taskId,
        signature,
        text: prepareTurnText(text),
        verified: verified === true,
        queuedAt: this.now().toISOString(),
      };
      const problem = validateEntry(entry);
      if (problem) return { queued: false, reason: `invalid entry (${problem})` };
      await this.#write([...all, entry]);
      return { queued: true, reason: 'queued', entry };
    });
  }

  // Drops an intent: its turn is written, or the state it described is no longer what
  // the task log records. Nothing is rewritten in place, and an entry that cannot be
  // removed is harmless - its state is recognised as already summarised next time.
  async settle(id) {
    return this.#withLock(async () => {
      const all = await this.entries();
      const kept = all.filter((entry) => entry.id !== id);
      if (kept.length === all.length) return false;
      await this.#write(kept);
      return true;
    });
  }
}
