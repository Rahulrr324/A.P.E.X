// Workshop artifact store: append-only persistence of composed design sheets.
//
// A sheet is the user's own composition, held in its own log. The rules are the same as every
// other append-only store in APEX:
//  - a record is never rewritten or deleted;
//  - identity is the digest of the content, so composing the same sheet twice is one record;
//  - each line commits to the previous line's digest, so a removed or reordered line is visible;
//  - the log is bounded, and reaching the bound refuses the write instead of dropping history;
//  - a damaged line is counted and reported, never repaired silently.
import { createHash } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { WriterLock } from '../memory/writer-lock.js';
import { StoreError } from '../errors.js';
import { WORKSHOP_SCHEMA } from './index.js';

export const MAX_WORKSHOP_ARTIFACTS = 500;
export const MAX_ARTIFACT_BYTES = 128 * 1024;
const MAX_LIST_LIMIT = 200;

export class WorkshopStore {
  #log;
  #lock;
  #now;

  constructor(filePath, { now = () => new Date() } = {}) {
    this.#now = now;
    this.#log = new JsonlStore(filePath, { validateRecord });
    this.#lock = new WriterLock(filePath, { label: 'workshop store' });
    this.filePath = filePath;
  }

  async append(artifact) {
    if (!artifact || typeof artifact !== 'object') throw new StoreError('artifact must be an object');
    if (artifact.schema !== WORKSHOP_SCHEMA) throw new StoreError('artifact schema is not workshop');
    if (typeof artifact.artifactId !== 'string' || artifact.artifactId.length === 0) {
      throw new StoreError('artifact must have an id');
    }
    if (artifact.authorizesExecution !== false || artifact.executedCode !== false) {
      throw new StoreError('a workshop artifact may never authorize execution or claim code ran');
    }
    const candidate = boundRecord(artifact);
    return this.#lock.run(async () => {
      const { records, corrupt } = await this.#log.loadForAppend();
      const existing = records.find((record) => record.artifactId === candidate.artifactId);
      if (existing) {
        if (existing.identityDigest !== candidate.identityDigest) {
          throw new StoreError('duplicate artifact id with different content; refusing to overwrite an append-only record');
        }
        return { appended: false, duplicate: true, artifactId: candidate.artifactId, identityDigest: candidate.identityDigest, corrupt: corrupt.length };
      }
      if (records.length >= MAX_WORKSHOP_ARTIFACTS) {
        throw new StoreError(`workshop history bound reached (${MAX_WORKSHOP_ARTIFACTS} artifacts); no further artifact was written`);
      }
      const previous = records[records.length - 1] ?? null;
      const record = {
        ...candidate,
        previousDigest: previous?.contentDigest ?? null,
        contentDigest: null,
        recordedAt: this.#now().toISOString(),
      };
      record.contentDigest = digestRecord(record);
      const line = JSON.stringify(record);
      if (Buffer.byteLength(line, 'utf8') > MAX_ARTIFACT_BYTES) {
        throw new StoreError('artifact record exceeds the size bound');
      }
      await this.#log.append(record);
      return { appended: true, artifactId: record.artifactId, identityDigest: record.identityDigest, contentDigest: record.contentDigest, corrupt: corrupt.length };
    });
  }

  async list({ limit = 20 } = {}) {
    const { records, corrupt } = await this.#log.load();
    const count = Number.isInteger(limit) ? Math.max(1, Math.min(limit, MAX_LIST_LIMIT)) : 20;
    const out = [];
    for (let i = records.length - 1; i >= 0 && out.length < count; i -= 1) {
      const record = records[i];
      out.push({
        artifactId: record.artifactId,
        title: record.title,
        domain: record.domain,
        components: record.components.length,
        connections: record.connections.length,
        budget: record.budget === null ? null : record.budget.total,
        at: record.createdAt,
        authorizesExecution: false,
      });
    }
    return { artifacts: out, total: records.length, corrupt: corrupt.length };
  }

  async get(artifactId) {
    if (typeof artifactId !== 'string' || artifactId.length === 0) {
      return { found: false, detail: 'artifact id is required' };
    }
    const { records, corrupt } = await this.#log.load();
    const exact = records.find((record) => record.artifactId === artifactId);
    if (exact) return { found: true, artifact: publicArtifact(exact), corrupt: corrupt.length };
    const prefix = records.filter((record) => record.artifactId.startsWith(artifactId));
    if (prefix.length === 1) return { found: true, artifact: publicArtifact(prefix[0]), corrupt: corrupt.length };
    if (prefix.length > 1) return { found: false, detail: 'artifact id is ambiguous; use a longer prefix' };
    return { found: false, detail: `no workshop artifact for ${artifactId}` };
  }

  async status() {
    try {
      const { records, corrupt } = await this.#log.load();
      const chain = verifyChain(records);
      return {
        artifacts: records.length,
        corrupt: corrupt.length,
        bound: MAX_WORKSHOP_ARTIFACTS,
        chain: chain.ok ? 'intact' : 'damaged',
        chainDetail: chain.detail,
        latest: records.length ? { artifactId: records[records.length - 1].artifactId, at: records[records.length - 1].createdAt } : null,
      };
    } catch (err) {
      if (err && err.code === 'STORE_UNAVAILABLE') throw err;
      return {
        artifacts: 0, corrupt: 0, bound: MAX_WORKSHOP_ARTIFACTS,
        chain: 'unavailable', chainDetail: err?.message ?? 'could not read the workshop store',
      };
    }
  }
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'workshop record must be an object';
  if (record.schema !== WORKSHOP_SCHEMA) return 'workshop record schema is not workshop';
  if (typeof record.artifactId !== 'string' || record.artifactId.length === 0) return 'workshop record needs an artifact id';
  if (typeof record.identityDigest !== 'string' || record.identityDigest.length === 0) return 'workshop record needs an identity digest';
  if (record.authorizesExecution !== false) return 'a workshop artifact may never authorize execution';
  if (record.executedCode !== false) return 'a workshop artifact may never claim code ran';
  if (record.contentDigest !== null && typeof record.contentDigest !== 'string') return 'workshop content digest must be text';
  return null;
}

// Only the fields the workshop defines are copied, so a caller-supplied extra field (including
// anything that looks like an authorization) cannot ride into the append-only log.
function boundRecord(artifact) {
  return {
    schema: WORKSHOP_SCHEMA,
    schemaVersion: 1,
    kind: 'artifact',
    artifactId: artifact.artifactId,
    identityDigest: artifact.identityDigest,
    title: String(artifact.title ?? '').slice(0, 160),
    domain: artifact.domain ?? 'generic',
    components: Array.isArray(artifact.components) ? artifact.components.slice(0, 200) : [],
    connections: Array.isArray(artifact.connections) ? artifact.connections.slice(0, 400) : [],
    budget: artifact.budget ?? null,
    note: String(artifact.note ?? '').slice(0, 2000),
    createdAt: artifact.createdAt ?? null,
    authorizesExecution: false,
    executedCode: false,
  };
}

function digestRecord(record) {
  const { contentDigest, ...body } = record;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function publicArtifact(record) {
  return {
    schema: record.schema,
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    artifactId: record.artifactId,
    identityDigest: record.identityDigest,
    title: record.title,
    domain: record.domain,
    components: record.components,
    connections: record.connections,
    budget: record.budget,
    note: record.note,
    createdAt: record.createdAt,
    contentDigest: record.contentDigest,
    previousDigest: record.previousDigest,
    recordedAt: record.recordedAt,
    authorizesExecution: false,
    executedCode: false,
  };
}

export function verifyChain(records = []) {
  let previous = null;
  for (const record of records) {
    if ((record.previousDigest ?? null) !== (previous?.contentDigest ?? null)) {
      return { ok: false, detail: `artifact ${record.artifactId} does not follow the recorded chain` };
    }
    if (digestRecord(record) !== record.contentDigest) {
      return { ok: false, detail: `artifact ${record.artifactId} content does not match its digest` };
    }
    previous = record;
  }
  return { ok: true, detail: `${records.length} artifact(s) verified in order` };
}
