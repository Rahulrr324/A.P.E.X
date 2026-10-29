// Task store: an append-only JSON Lines event log (tasks.jsonl). Task state is the
// result of replaying the log, so progress survives a restart after every step.
//
// Writes are validated before they are appended: the new event is replayed on top
// of the existing history, and it is refused if the reducer would reject it. A lock
// file (tasks.jsonl.lock) stops two processes from running the same task at once.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { StoreError, ValidationError } from '../errors.js';
import { TASK_SCHEMA, reduceEvents, validateEventShape } from './model.js';

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // exists, but belongs to another user
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
    if (q.length < 4) throw new ValidationError(`task id "${q}" is too short; use at least 4 characters`);
    const matches = [...tasks.values()].filter((t) => t.id.startsWith(q));
    if (matches.length === 0) throw new ValidationError(`no task matches "${q}"`);
    if (matches.length > 1) throw new ValidationError(`"${q}" matches ${matches.length} tasks; use a longer id`);
    return matches[0];
  }

  // Runs `fn` while holding the store lock. A lock left by a process that has
  // exited is removed. A lock held by a live process is refused, not waited for.
  async withLock(fn) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const body = JSON.stringify({ pid: process.pid, at: this.now().toISOString() });
    let acquired = false;
    for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
      try {
        await fs.writeFile(this.lockPath, body, { flag: 'wx' });
        acquired = true;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw new StoreError(`cannot create task lock: ${err?.code || err?.message}`);
        let holder = null;
        try {
          holder = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
        } catch {
          holder = null; // unreadable or still being written: treat as in use
        }
        const pid = Number(holder?.pid);
        if (Number.isInteger(pid) && pid > 0 && !processAlive(pid)) {
          await fs.rm(this.lockPath, { force: true });
        } else {
          throw new StoreError(`tasks are in use by process ${holder?.pid ?? 'unknown'}; try again when it finishes`);
        }
      }
    }
    if (!acquired) throw new StoreError('could not acquire the task lock');
    try {
      return await fn();
    } finally {
      await fs.rm(this.lockPath, { force: true }).catch(() => {});
    }
  }

  // Validates by replay, then appends. Refused events are never written, and a
  // damaged log is not extended: its state cannot be trusted as a base.
  async #append(event) {
    const { records } = await this.#readComplete();
    const { problems } = reduceEvents([...records, event]);
    const refused = problems.find((p) => p.index === records.length);
    if (refused) throw new ValidationError(`refused: ${refused.reason}`, 'ILLEGAL_TRANSITION');
    await this.log.append(event);
    return event;
  }

  #base(type, taskId) {
    return { schema: TASK_SCHEMA, eventId: this.idFactory(), type, taskId, at: this.now().toISOString() };
  }

  async createTask({ taskId, goal, origin, planner, steps, reason }) {
    return this.#append({ ...this.#base('task_created', taskId), goal, origin, planner, steps, reason: reason ?? 'created' });
  }

  // One atomic change: any task status change, step status changes, and an optional
  // step approval. Either all of it is recorded, or none of it.
  async transition(taskId, { reason, task = null, steps = [], approval = null }) {
    return this.#append({ ...this.#base('transition', taskId), reason, task, steps, approval });
  }
}

