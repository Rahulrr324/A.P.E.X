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
// is written. Two processes writing at the same moment can lose one intent; that loss is
// reported by the same disclosure as any other failed history write.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StoreError } from '../errors.js';
import { TASK_SIGNATURE_RE, prepareTurnText } from '../memory/conversation-store.js';
import { MAX_TASK_SUMMARY_CHARS } from './summary.js';

export const SUMMARY_QUEUE_SCHEMA = 1;
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

  async #write(entries) {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
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
  }

  // Drops an intent: its turn is written, or the state it described is no longer what
  // the task log records. Nothing is rewritten in place, and an entry that cannot be
  // removed is harmless - its state is recognised as already summarised next time.
  async settle(id) {
    const all = await this.entries();
    const kept = all.filter((entry) => entry.id !== id);
    if (kept.length === all.length) return false;
    await this.#write(kept);
    return true;
  }
}
