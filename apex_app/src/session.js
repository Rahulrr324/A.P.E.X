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

  async #read() {
    let text;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw new StoreError(`cannot read session state: ${err?.code || err?.message}`);
    }
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new StoreError('session state is corrupt (invalid JSON); run "apex new" to start a new session');
    }
    // Writes are atomic, so a readable file without a session id is damaged, not
    // a half-written state. A missing file is handled above and is not corruption.
    if (obj && typeof obj.sessionId === 'string' && obj.sessionId.length > 0) return obj;
    throw new StoreError('session state is corrupt (missing session id); run "apex new" to start a new session');
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
