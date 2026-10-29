// Conversation history: what was said in a session, kept apart from long-term
// memory. A model reply is recorded here as an UNVERIFIED turn. It never becomes a
// memory record unless the user explicitly saves it (memory.save_conclusion).
// Turns are append-only JSON Lines and are used only as short-term context.
import { randomUUID } from 'node:crypto';
import { JsonlStore } from './jsonl-store.js';
import { StoreError, ValidationError } from '../errors.js';
import { containsSecret } from '../security/secrets.js';
import { truncate } from '../util.js';

export const TURN_SCHEMA = 1;
const MAX_TURN_CHARS = 2000;
const ROLES = new Set(['user', 'assistant']);
// Who produced the text. Only these origins are replayed as context. Notices
// (for example "model unavailable") are kept for the user's history, not replayed.
// A question APEX itself asked is replayed: without it the user's next message
// arrives with no record of what it was answering, and APEX asks again.
// A task result is replayed too: it is the only history record of what a task
// actually did, because a task's steps are audited, not conversed.
export const TURN_ORIGINS = Object.freeze({
  USER: 'user',
  ACTION: 'apex_action',
  MODEL: 'model',
  NOTICE: 'apex_notice',
  QUESTION: 'apex_question',
  TASK: 'apex_task',
});
const REPLAYED = new Set([
  TURN_ORIGINS.USER,
  TURN_ORIGINS.ACTION,
  TURN_ORIGINS.MODEL,
  TURN_ORIGINS.QUESTION,
  TURN_ORIGINS.TASK,
]);
const ORIGINS = new Set(Object.values(TURN_ORIGINS));

// A task-result turn is a system statement about an operation, so it must carry the
// provenance it was derived from. Model text is always stored under the model origin,
// so a model cannot put its own prose in this class no matter what it writes.
export const TASK_SIGNATURE_RE = /^[0-9a-f]{64}$/;
const MAX_TASK_ID_CHARS = 64;

function validateTurn(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'not an object';
  if (t.schema !== TURN_SCHEMA) return 'unsupported schema';
  if (typeof t.id !== 'string' || t.id.length === 0) return 'missing id';
  if (typeof t.sessionId !== 'string' || t.sessionId.length === 0) return 'missing session';
  if (!ROLES.has(t.role)) return 'unknown role';
  if (!ORIGINS.has(t.origin)) return 'unknown origin';
  if (typeof t.text !== 'string') return 'missing text';
  if (typeof t.verified !== 'boolean') return 'missing verified flag';
  if (typeof t.createdAt !== 'string' || Number.isNaN(Date.parse(t.createdAt))) return 'bad timestamp';
  if (t.taskId !== undefined && t.taskId !== null
    && (typeof t.taskId !== 'string' || t.taskId.length === 0 || t.taskId.length > MAX_TASK_ID_CHARS)) {
    return 'bad task id';
  }
  if (t.signature !== undefined && t.signature !== null && !TASK_SIGNATURE_RE.test(String(t.signature))) {
    return 'bad task signature';
  }
  if (t.origin === TURN_ORIGINS.TASK && (typeof t.taskId !== 'string' || !TASK_SIGNATURE_RE.test(String(t.signature ?? '')))) {
    return 'a task result turn needs the task id and its state signature';
  }
  return null;
}

// Text is shortened and, if it looks like a credential, replaced entirely.
export function prepareTurnText(text) {
  const s = String(text ?? '');
  if (containsSecret(s)) return '[omitted: contained a password, key, or token]';
  return truncate(s, MAX_TURN_CHARS);
}

export class ConversationStore {
  constructor(filePath, { now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.log = new JsonlStore(filePath, { validateRecord: validateTurn });
  }

  async append({ sessionId, role, origin, text, verified = false, operationId = null, taskId = null, signature = null }) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new ValidationError('sessionId is required');
    const turn = {
      schema: TURN_SCHEMA,
      id: randomUUID(),
      sessionId,
      role,
      origin,
      text: prepareTurnText(text),
      verified: verified === true,
      operationId,
      taskId,
      signature,
      createdAt: this.now().toISOString(),
    };
    const problem = validateTurn(turn);
    if (problem) throw new ValidationError(`invalid turn: ${problem}`);
    await this.log.append(turn);
    return turn;
  }

  // The state signatures already summarised for one task in one session. Used to keep
  // repeated recovery or resume attempts from writing the same summary twice; it is
  // read-only and writes nothing. A damaged log is reported instead of answering "no
  // summary yet", because a partial read could duplicate a turn that exists.
  async summarisedTaskStates(sessionId, taskId) {
    const { records, corrupt } = await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`conversation store contains ${corrupt.length} corrupt line(s); cannot check for an existing task summary`);
    }
    return new Set(records
      .filter((t) => t.origin === TURN_ORIGINS.TASK
        && t.sessionId === sessionId
        && t.taskId === taskId
        && TASK_SIGNATURE_RE.test(String(t.signature ?? '')))
      .map((t) => t.signature));
  }

  // The last `limit` replayable turns of one session, oldest first. A damaged log
  // is refused rather than replayed partially: an omitted turn could make an
  // earlier conversation look different from what the user actually said.
  async recent(sessionId, limit) {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const { records, corrupt } = await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`conversation store contains ${corrupt.length} corrupt line(s); refusing incomplete history`);
    }
    return records
      .filter((t) => t.sessionId === sessionId && REPLAYED.has(t.origin))
      .slice(-limit);
  }

  async countForSession(sessionId) {
    const { records } = await this.log.load();
    return records.filter((t) => t.sessionId === sessionId).length;
  }

  async status() {
    const { records, corrupt } = await this.log.load();
    return { turns: records.length, corrupt: corrupt.length };
  }
}
