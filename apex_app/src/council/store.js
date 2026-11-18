// Council session store: append-only persistence of council deliberations.
// No metadata, no duplicate stores; evidence references point back to source records.
import crypto from 'node:crypto';
import { StoreError } from '../errors.js';
import { COUNCIL_SCHEMA } from './index.js';

const MAX_LINE_BYTES = 64 * 1024;
const DIGEST_PREFIX = 'sha256:';

export class CouncilStore {
  #path;
  #now;
  #idFactory;

  constructor(path, { now = () => new Date(), idFactory } = {}) {
    this.#path = path;
    this.#now = now;
    this.#idFactory = idFactory ?? (() => crypto.randomUUID());
  }

  newSessionId() {
    return `cs-${this.#idFactory()}`;
  }

  async append(session) {
    if (!session || typeof session !== 'object') throw new StoreError('session must be an object');
    if (typeof session.sessionId !== 'string' || session.sessionId.length === 0) {
      throw new StoreError('session must have a session id');
    }
    if (session.schema !== COUNCIL_SCHEMA) {
      throw new StoreError('session schema is not council');
    }
    const record = {
      schema: COUNCIL_SCHEMA,
      sessionId: session.sessionId,
      objective: session.objective,
      at: session.at,
      status: session.status,
      authorizesExecution: false,
      contentDigest: crypto.createHash('sha256').update(JSON.stringify({
        objective: session.objective,
        at: session.at,
      })).digest('hex'),
    };
    const line = JSON.stringify(record) + '\n';
    const encoder = new TextEncoder();
    const bytes = encoder.encode(line);
    if (bytes.byteLength > MAX_LINE_BYTES) {
      throw new StoreError('session record exceeds the size bound');
    }
    const fd = await fsOpen(this.#path, 'a');
    try {
      await fsWrite(fd, bytes);
    } finally {
      await fsClose(fd);
    }
    return { appended: true, sessionId: session.sessionId };
  }

  async list({ limit = 20 } = {}) {
    const rows = await readLines(this.#path);
    const out = [];
    const count = Math.max(1, Math.min(limit, 200));
    for (let i = rows.length - 1; i >= 0 && out.length < count; i--) {
      const parsed = parseLine(rows[i]);
      if (!parsed) continue;
      out.push({
        sessionId: parsed.sessionId,
        objective: parsed.objective,
        at: parsed.at,
        status: parsed.status,
        authorizesExecution: false,
      });
    }
    return { sessions: out, total: rows.length };
  }

  async get(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { found: false, detail: 'session id is required' };
    }
    const rows = await readLines(this.#path);
    for (const raw of rows) {
      const parsed = parseLine(raw);
      if (!parsed) continue;
      if (parsed.sessionId === sessionId || parsed.sessionId.endsWith(sessionId)) {
        return {
          found: true,
          session: {
            sessionId: parsed.sessionId,
            objective: parsed.objective,
            at: parsed.at,
            status: parsed.status,
            authorizesExecution: false,
            contentDigest: parsed.contentDigest,
          },
        };
      }
    }
    return { found: false, detail: `no council session for ${sessionId}` };
  }

  async status() {
    try {
      const rows = await readLines(this.#path);
      const sessions = [];
      for (let i = rows.length - 1; i >= 0 && sessions.length < 200; i--) {
        const parsed = parseLine(rows[i]);
        if (!parsed) continue;
        sessions.push({ sessionId: parsed.sessionId, at: parsed.at, status: parsed.status });
      }
      return { records: rows.length, sessions };
    } catch (err) {
      if (err && err.status === 503) throw err;
      return { records: 0, sessions: [], unavailable: err?.message ?? 'could not read council store' };
    }
  }
}

// ---------------------------------------------------------------------------
// Low-level file helpers (append-only, no rename semantics)
// ---------------------------------------------------------------------------

async function fsOpen(path, flag) {
  const fs = await import('node:fs/promises');
  return await fs.open(path, flag, { mode: 0o600 });
}

async function fsWrite(fd, bytes) {
  const fs = await import('node:fs/promises');
  await fs.write(fd, bytes, { position: fd.statSync?.().size ?? 0 });
}

async function fsClose(fd) {
  const fs = await import('node:fs/promises');
  await fd.close();
}

async function readLines(path) {
  const fs = await import('node:fs/promises');
  try {
    const text = await fs.readFile(path, 'utf8');
    if (!text) return [];
    const lines = text.replace(/\r\n/g, '\n').split('\n').filter((line) => line.length > 0);
    return lines;
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw new StoreError(`council store read failed: ${err?.message ?? err}`);
  }
}

function parseLine(raw) {
  try {
    const record = JSON.parse(raw);
    if (record && record.schema === COUNCIL_SCHEMA && typeof record.sessionId === 'string') {
      return {
        sessionId: record.sessionId,
        objective: record.objective ?? null,
        at: record.at ?? null,
        status: record.status ?? null,
        contentDigest: record.contentDigest ?? null,
      };
    }
    return null;
  } catch {
    return null;
  }
}
