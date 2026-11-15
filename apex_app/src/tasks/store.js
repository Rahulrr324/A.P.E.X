// Task store: an append-only JSON Lines event log (tasks.jsonl). Task state is the
// result of replaying the log, so progress survives a restart after every step.
//
// Writes are validated before they are appended: the new event is replayed on top
// of the existing history, and it is refused if the reducer would reject it. A lock
// file (tasks.jsonl.lock) stops two processes from running the same task at once.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { parseIsoInstant, singleLine } from '../util.js';
import { StoreError, ValidationError } from '../errors.js';
import { TASK_SCHEMA, reduceEvents, validateEventShape } from './model.js';
import { maskSecretLeaves } from '../security/secrets.js';
import { inspectLock, recoverLock, identifiedPid, TAKEOVER_EPOCHS } from './lock-recovery.js';


// Liveness, not identity: this asks whether *some* process currently has this number. A
// process that exited can have its number reassigned immediately - Windows returns freed
// process ids to the allocator without delay - so a live answer may describe a stranger.
// A claim whose number is live is therefore treated as held, never as a stale claim to
// remove: refusing is safe, guessing is not. No portable start-identity check exists
// without a native dependency, so a recycled number keeps the lock fail-closed until an
// operator verifies it by hand (see README, the task-lock limitation under Known
// limitations).
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // exists, but belongs to another user
  }
}

// A sync-then-close helper for the lock's staging file. The completed body is
// published under the lock name only after every byte is on disk, so a competing
// process can never observe an empty or half-written lock and misreport the holder
// as "process unknown".
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

export class TaskStore {
  constructor(filePath, { now = () => new Date(), idFactory = randomUUID } = {}) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.now = now;
    this.idFactory = idFactory;
    this.log = new JsonlStore(filePath, { validateRecord: validateEventShape });
  }

  // Replays the log. An incomplete log is refused: a corrupt line or an event
  // that cannot be applied would otherwise be reported as a different task state.
  async #readComplete() {
    const { records, corrupt } = await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`task log contains ${corrupt.length} corrupt line(s); refusing incomplete task state`);
    }
    const { tasks, problems } = reduceEvents(records);
    if (problems.length > 0) {
      throw new StoreError(`task log contains ${problems.length} event(s) that cannot be applied; refusing incomplete task state`);
    }
    return { records, tasks, problems };
  }

  // Replays the log. Returns tasks (Map) and the number of events. The counts of
  // corrupt lines and unapplied events are zero: those cases refuse above.
  async load() {
    const { records, tasks, problems } = await this.#readComplete();
    return { tasks, problems, corrupt: 0, events: records.length };
  }

  // The log replayed to one cutoff: only events stamped at or before it. A step is running,
  // awaiting approval, completed, failed, uncertain, or skipped as it was recorded by then, and a
  // later retry, recovery, or completion is not folded back. This is a read: no runner is started
  // and no step resumes, which is what keeps a historical view from becoming a replay of work.
  //
  // Filtering by `at` preserves append order among the events it keeps. A non-monotonic clock can
  // leave a subsequence whose transitions do not apply; those problems are reported rather than
  // repaired by reordering, because the records carry no chronology other than their timestamps.
  async historicalView(knownAt, { withCurrent = true } = {}) {
    const cutoff = parseIsoInstant(knownAt);
    if (cutoff === null) {
      throw new ValidationError(`"${singleLine(knownAt, 60)}" is not an ISO date or an ISO date-time with a time zone`);
    }
    const cutoffMs = Date.parse(cutoff);
    const { records } = await this.#readComplete();
    const known = [];
    const later = [];
    let undated = 0;
    for (const record of records) {
      const at = Date.parse(record.at);
      if (Number.isNaN(at)) undated += 1;
      else if (at <= cutoffMs) known.push(record);
      else later.push({ at: record.at, type: record.type, taskId: record.taskId });
    }
    const derived = reduceEvents(known);
    const current = withCurrent ? reduceEvents(records) : null;
    return {
      cutoff,
      records: known.length,
      excluded: later.length,
      undated,
      tasks: derived.tasks,
      problems: derived.problems,
      later,
      current: withCurrent ? { tasks: current.tasks, problems: current.problems } : null,
      note: `replayed ${known.length} task-log event(s) recorded at or before ${cutoff}; ${later.length} later event(s) are not included, so a later start, completion, failure, retry, approval, or cancellation does not apply`,
    };
  }

  // Read-only diagnostics view. It does not throw on corrupt lines or events that
  // cannot be replayed: it reports them so a caller can distinguish damage from
  // an empty store. An unreadable file still throws, which means unavailable.
  async inspect() {
    const { records, corrupt } = await this.log.load();
    const { tasks, problems } = reduceEvents(records);
    return { events: records.length, tasks: [...tasks.values()], corrupt, problems };
  }

  async get(taskId) {
    const { tasks } = await this.load();
    return tasks.get(taskId) ?? null;
  }

  async list() {
    const { tasks } = await this.load();
    return [...tasks.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  // Accepts a full id or a unique prefix of at least 4 characters.
  async resolve(idOrPrefix) {
    const q = String(idOrPrefix ?? '').trim();
    if (q.length === 0) throw new ValidationError('a task id is required');
    const { tasks } = await this.load();
    if (tasks.has(q)) return tasks.get(q);
    if (q.length < 4) throw new ValidationError(`task id "${singleLine(q, 40)}" is too short; use at least 4 characters`);
    const matches = [...tasks.values()].filter((t) => t.id.startsWith(q));
    if (matches.length === 0) throw new ValidationError(`no task matches "${singleLine(q, 40)}"`);
    if (matches.length > 1) throw new ValidationError(`"${singleLine(q, 40)}" matches ${matches.length} tasks; use a longer id`);
    return matches[0];
  }

  // Runs `fn` while holding the store lock. A lock left by a process that has
  // exited is taken over by exactly one process. A lock held by a live process is
  // refused, not waited for.
  //
  // "Live" means the recorded number is in use by some process, not that the
  // original holder is the one running it: a recycled process id is indistinguishable
  // from the original holder. Such a claim is refused, and recovery refuses it too;
  // only a number no process owns is treated as a stale claim.
  //
  // Deletion cannot be made conditional without a native dependency, and a plain
  // "read the dead claim, remove it, create ours" took over the same claim twice under
  // concurrency: both takers validated the dead body, one created a fresh lock, the other
  // then removed that fresh lock and created its own, and two task runs executed at once
  // on one data directory. So the right to remove is elected first, with create-once hard
  // links: one token per (claim, epoch). A taker that finds a live token holder is refused;
  // a token whose holder has exited is dead bookkeeping and the next epoch supersedes it.
  // Only the elected taker re-reads and removes the claim, so no taker can remove a lock
  // another process created. Both the takeover and the release act on the lock only when
  // it still holds the exact claim this process validated.
  async withLock(fn) {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    } catch (err) {
      throw new StoreError(`cannot prepare the task data directory: ${err?.code || err?.message}`);
    }
    const body = JSON.stringify({ pid: process.pid, nonce: this.idFactory(), at: this.now().toISOString() });
    // Stage the complete lock body under a private name, then publish it with a hard
    // link. Creating the lock name with `writeFile({flag:'wx'})` made the name visible
    // before its bytes were, so a racer could read an empty file, call the holder
    // unknown, and lose the pid the user needs. The link only succeeds if the name is
    // still free, so create-once is preserved.
    const staged = `${this.lockPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeSynced(staged, body);
    } catch (err) {
      await fs.rm(staged, { force: true }).catch(() => {});
      throw new StoreError(`cannot create task lock: ${err?.code || err?.message}`);
    }
    let acquired = false;
    try {
      for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
        try {
          await fs.link(staged, this.lockPath);
          acquired = true;
          break;
        } catch (err) {
          if (err?.code !== 'EEXIST') {
            // Some filesystems do not support hard links. Fall back to an exclusive
            // create; it is still create-once, though a reader could briefly see the
            // name before its body is complete (reported as unknown, never as free).
            try {
              await writeExclusive(this.lockPath, body);
              acquired = true;
              break;
            } catch (createErr) {
              if (createErr?.code !== 'EEXIST') {
                throw new StoreError(`cannot create task lock: ${createErr?.code || createErr?.message}`);
              }
            }
          }
          let raw = null;
          let released = false;
          try {
            raw = await fs.readFile(this.lockPath, 'utf8');
          } catch (err) {
            // The holder released between the failed link and this read. The name is free
            // now, so retry the link instead of claiming an unknown holder; any other read
            // failure is still treated as "in use", because it proves nothing about the holder.
            if (err?.code === 'ENOENT') released = true;
            else raw = null;
          }
          if (released) continue;
          let holder = null;
          try {
            holder = JSON.parse(raw);
          } catch {
            holder = null;
          }
          const pid = Number(holder?.pid);
          if (raw !== null && Number.isInteger(pid) && pid > 0 && !processAlive(pid)) {
            const election = await this.#electTakeover(raw);
            if (!election.won) {
              throw new StoreError(`tasks are in use by process ${election.pid ?? 'unknown'}; try again when it finishes`, 'LOCKED');
            }
            try {
              const stillThere = await fs.readFile(this.lockPath, 'utf8').catch(() => null);
              if (stillThere === raw) await fs.rm(this.lockPath, { force: true });
            } finally {
              await election.release();
            }
            continue;
          }
          throw new StoreError(`tasks are in use by process ${identifiedPid(holder?.pid) ?? 'unknown'}; try again when it finishes`, 'LOCKED');
        }
      }
    } finally {
      await fs.rm(staged, { force: true }).catch(() => {});
    }
    if (!acquired) throw new StoreError('could not acquire the task lock', 'LOCKED');
    try {
      return await fn();
    } finally {
      const mine = await fs.readFile(this.lockPath, 'utf8').catch(() => null);
      if (mine === body) await fs.rm(this.lockPath, { force: true }).catch(() => {});
    }
  }

  // Elects one taker for one dead claim. Tokens are hard links published under a name
  // derived from the claim and an epoch, so the link either succeeds (we are the taker)
  // or proves another taker got there first. A live token holder means the claim is being
  // taken over now, and we are refused. A token whose holder has exited cannot act, so the
  // next epoch supersedes it; this is what keeps a process killed during a takeover from
  // blocking the data directory forever. Tokens are small, created once, and removed by
  // their own holder; an abandoned one is inert bookkeeping. Token liveness has the same
  // limit as the claim's: a number that is live is treated as a live taker even if it has
  // been recycled, which refuses the takeover instead of risking two owners.
  async #electTakeover(raw) {
    const key = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
    const body = JSON.stringify({ pid: process.pid, nonce: this.idFactory(), at: this.now().toISOString() });
    const staged = `${this.lockPath}.takeover.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeSynced(staged, body);
    } catch (err) {
      throw new StoreError(`cannot create task lock: ${err?.code || err?.message}`);
    }
    try {
      for (let epoch = 0; epoch < TAKEOVER_EPOCHS; epoch += 1) {
        const tokenPath = `${this.lockPath}.takeover.${key}.${epoch}`;
        try {
          await fs.link(staged, tokenPath);
          return this.#takeoverWon(tokenPath, body);
        } catch (err) {
          if (err?.code !== 'EEXIST') {
            // Same fallback as the lock itself: exclusive create is still create-once,
            // though a loser could briefly read an incomplete token and be refused.
            try {
              await writeExclusive(tokenPath, body);
              return this.#takeoverWon(tokenPath, body);
            } catch (createErr) {
              if (createErr?.code !== 'EEXIST') {
                throw new StoreError(`cannot create task lock: ${createErr?.code || createErr?.message}`);
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
        // A token with no readable holder proves nothing about the taker, so it is
        // reported as in use rather than assumed abandoned.
        if (tokenPid === null) return { won: false, pid: null, release: async () => {} };
        if (processAlive(tokenPid)) return { won: false, pid: tokenPid, release: async () => {} };
      }
    } finally {
      await fs.rm(staged, { force: true }).catch(() => {});
    }
    throw new StoreError(`cannot take over the task lock: ${TAKEOVER_EPOCHS} takeover attempts are recorded as abandoned; run "apex repair locks" after confirming no task run is active`, 'LOCKED');
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

  // Read-only view of the lock. It never creates, removes, or waits for the lock.
  // A dead holder and an unreadable lock are reported rather than treated as free,
  // so a caller can tell "nobody is running this now" from "cannot tell".
  async lockState() {
    let raw;
    try {
      raw = await fs.readFile(this.lockPath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return { present: false, pid: null, alive: false };
      return { present: true, pid: null, alive: null, error: err?.code || 'unreadable' };
    }
    let holder = null;
    try {
      holder = JSON.parse(raw);
    } catch {
      holder = null;
    }
    const pid = Number(holder?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return { present: true, pid: null, alive: null };
    return { present: true, pid, alive: processAlive(pid) };
  }

  // Read-only view of the lock plus its takeover tokens and recovery guard.
  async lockReport() {
    return inspectLock(this.lockPath);
  }

  // Explicit recovery for a claim whose holder has exited. It never takes the lock,
  // and it refuses if the holder or any takeover token names a live process.
  async recover() {
    return recoverLock(this.lockPath, 'task');
  }

  // Validates by replay, then appends. Refused events are never written, and a
  // damaged log is not extended: its state cannot be trusted as a base.
  // A task log is audit evidence, and a model-proposed step input is unvalidated text until the
  // step runs, so the shared mask runs here before the event is replayed and appended. What the log
  // holds and what the replayed state holds are then the same bytes, which keeps an approval's
  // input hash matching the step it names. A masked input fails its own action validation when the
  // step runs: a credential is not a plan argument, and it is not stored as one either.
  async #append(event) {
    const masked = maskSecretLeaves(event);
    const safe = masked.masked > 0 ? { ...masked.value, secretsMasked: true } : masked.value;
    const { records } = await this.#readComplete();
    const { problems } = reduceEvents([...records, safe]);
    const refused = problems.find((p) => p.index === records.length);
    if (refused) throw new ValidationError(`refused: ${refused.reason}`, 'ILLEGAL_TRANSITION');
    await this.log.append(safe);
    return safe;
  }

  #base(type, taskId) {
    return { schema: TASK_SCHEMA, eventId: this.idFactory(), type, taskId, at: this.now().toISOString() };
  }

  async createTask({ taskId, goal, origin, planner, steps, reason, goalId = null, planId = null }) {
    return this.#append({
      ...this.#base('task_created', taskId),
      goal,
      origin,
      planner,
      ...(goalId ? { goalId } : {}),
      ...(planId ? { planId } : {}),
      steps,
      reason: reason ?? 'created',
    });
  }

  // One atomic change: any task status change, step status changes, and an optional
  // step approval. Either all of it is recorded, or none of it.
  async transition(taskId, { reason, task = null, steps = [], approval = null }) {
    return this.#append({ ...this.#base('transition', taskId), reason, task, steps, approval });
  }
}

