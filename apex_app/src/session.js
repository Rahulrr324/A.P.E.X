// Session state: which conversation the next request belongs to. A session id
// survives restarts, so a follow-up question after a restart still has context.
// The file is replaced atomically (write a temp file, then rename).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StoreError } from './errors.js';

export class SessionState {
  constructor(filePath, { now = () => new Date(), idFactory = randomUUID } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.idFactory = idFactory;
  }

  // Read-only classification used by status and diagnostics. It never creates or
  // repairs the file: missing is a valid fresh state, corrupt is reported as such.
  async #inspect() {
    let text;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return { status: 'missing', state: null, detail: 'no session file yet' };
      return { status: 'unavailable', state: null, detail: `cannot read session state: ${err?.code || err?.message}` };
    }
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return { status: 'corrupt', state: null, detail: 'session state is corrupt (invalid JSON)' };
    }
    // Writes are atomic, so a readable file without a session id is damaged, not
    // a half-written state. A missing file is handled above and is not corruption.
    if (obj && typeof obj.sessionId === 'string' && obj.sessionId.length > 0) return { status: 'ok', state: obj, detail: null };
    return { status: 'corrupt', state: null, detail: 'session state is corrupt (missing session id)' };
  }

  async #read() {
    const inspected = await this.#inspect();
    if (inspected.status === 'missing') return null;
    if (inspected.status === 'corrupt') {
      throw new StoreError(`${inspected.detail}; run "apex new" to start a new session`);
    }
    if (inspected.status === 'unavailable') throw new StoreError(inspected.detail);
    return inspected.state;
  }

  // Does not write. Used by callers that must inspect state without creating it.
  async peek() {
    return this.#inspect();
  }

  async #write(state) {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const handle = await fs.open(tmp, 'w');
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw new StoreError(`cannot write session state: ${err?.code || err?.message}`);
    }
  }

  // Returns the current session, creating one on first use.
  async current() {
    const existing = await this.#read();
    if (existing) return existing;
    return this.rotate();
  }

  // Starts a new session. Old turns stay in history but are no longer replayed.
  async rotate() {
    const state = { sessionId: this.idFactory(), startedAt: this.now().toISOString() };
    await this.#write(state);
    return state;
  }
}
