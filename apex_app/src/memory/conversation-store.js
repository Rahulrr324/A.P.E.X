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
export const TURN_ORIGINS = Object.freeze({
  USER: 'user',
  ACTION: 'apex_action',
  MODEL: 'model',
  NOTICE: 'apex_notice',
  QUESTION: 'apex_question',
});
const REPLAYED = new Set([TURN_ORIGINS.USER, TURN_ORIGINS.ACTION, TURN_ORIGINS.MODEL, TURN_ORIGINS.QUESTION]);
const ORIGINS = new Set(Object.values(TURN_ORIGINS));

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

  async append({ sessionId, role, origin, text, verified = false, operationId = null }) {
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
      createdAt: this.now().toISOString(),
    };
    const problem = validateTurn(turn);
    if (problem) throw new ValidationError(`invalid turn: ${problem}`);
    await this.log.append(turn);
    return turn;
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
