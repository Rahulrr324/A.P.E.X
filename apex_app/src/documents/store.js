// Append-only document versions and deletion markers. Extracted text is part of the version record
// so a restart needs no second index: the log is the source of truth. Versions are immutable and a
// changed file appends a new version; deletion appends a marker, never a rewrite.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { WriterLock } from '../memory/writer-lock.js';
import { StoreError, ValidationError } from '../errors.js';
import { DOCUMENT_SCHEMA, LIMITS } from './vocabulary.js';

const ID_RE = /^doc:[0-9a-f]{32}$/;
const VERSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value, name, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return `${name} must be non-empty text up to ${max} characters`;
  if (/[\u0000]/.test(value)) return `${name} contains a null byte`;
  return null;
}

export function validateDocumentRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'not an object';
  if (record.schema !== 1) return 'unsupported document schema';
  if (!ID_RE.test(record.documentId ?? '')) return 'invalid document id';
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) return 'bad createdAt';
  if (record.kind === 'deleted') {
    const problem = text(record.reason, 'reason', 300);
    return problem ?? null;
  }
  if (record.kind !== undefined) return 'unknown document record kind';
  if (!VERSION_RE.test(record.id ?? '')) return 'invalid version id';
  if (!Number.isInteger(record.version) || record.version < 1 || record.version > LIMITS.maxVersions) return 'invalid version number';
  if (typeof record.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.contentHash)) return 'invalid content hash';
  if (typeof record.textHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.textHash)) return 'invalid text hash';
  if (!Number.isInteger(record.bytes) || record.bytes < 0 || record.bytes > LIMITS.maxFileBytes) return 'invalid byte count';
  if (!['indexed', 'failed'].includes(record.status)) return 'unknown extraction status';
  if (!record.source || typeof record.source !== 'object') return 'missing source';
  if (text(record.source.path, 'source path', 1024)) return 'invalid source path';
  if (text(record.source.root, 'source root label', 80)) return 'invalid source root label';
  if (typeof record.format !== 'string' || record.format.length > 32) return 'invalid document format';
  if (record.status === 'failed') {
    if (text(record.error, 'extraction error', 500)) return 'invalid extraction error';
    return null;
  }
  if (typeof record.text !== 'string' || record.text.length > LIMITS.maxTextChars) return 'invalid extracted text';
  if (!Array.isArray(record.sections) || record.sections.length > LIMITS.maxSections) return 'invalid section list';
  for (const section of record.sections) {
    if (!section || typeof section !== 'object') return 'invalid section';
    if (!Number.isInteger(section.index) || !Number.isInteger(section.start) || !Number.isInteger(section.end)
      || section.start < 0 || section.end < section.start || section.end > record.text.length) return 'invalid section bounds';
    if (typeof section.label !== 'string' || section.label.length > 200) return 'invalid section label';
  }
  if (!Array.isArray(record.limitations) || record.limitations.length > LIMITS.maxWarnings) return 'invalid limitations';
  if (!Array.isArray(record.warnings) || record.warnings.length > LIMITS.maxWarnings) return 'invalid warnings';
  return null;
}

function checksumOf(config) {
  const { checksum, ...rest } = config;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

export class DocumentStore {
  constructor(dataDir, { now = () => new Date(), idFactory = randomUUID, lockWaitMs, lockRetryMs, lockRetryMaxMs } = {}) {
    this.dataDir = dataDir;
    this.configPath = path.join(dataDir, 'documents.json');
    this.logPath = path.join(dataDir, 'documents.jsonl');
    this.now = now;
    this.idFactory = idFactory;
    this.log = new JsonlStore(this.logPath, { validateRecord: validateDocumentRecord });
    this.lock = new WriterLock(path.join(dataDir, 'documents'), { waitMs: lockWaitMs, retryMs: lockRetryMs, retryMaxMs: lockRetryMaxMs });
  }

  async load() {
    try {
      return await this.log.load();
    } catch (err) {
      throw new StoreError(`document index could not be read: ${err?.message ?? String(err)}`);
    }
  }

  async append(records) {
    if (!Array.isArray(records) || records.length === 0) return;
    for (const record of records) {
      const problem = validateDocumentRecord(record);
      if (problem) throw new ValidationError(`refusing invalid document record: ${problem}`);
    }
    return this.lock.run(async () => {
      for (const record of records) await this.log.append(record);
    });
  }

  loadConfig() {
    let raw;
    try {
      raw = fs.readFileSync(this.configPath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw new StoreError(`document configuration could not be read: ${err?.message ?? String(err)}`);
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new StoreError('document configuration is not valid JSON'); }
    if (!parsed || parsed.schema !== DOCUMENT_SCHEMA) throw new StoreError('document configuration schema is unsupported');
    if (parsed.checksum !== checksumOf(parsed)) throw new StoreError('document configuration checksum does not match');
    return parsed;
  }

  async saveConfig(config) {
    const next = { ...config, schema: DOCUMENT_SCHEMA, version: 1, updatedAt: this.now().toISOString() };
    next.checksum = checksumOf(next);
    return this.lock.run(async () => {
      const temp = `${this.configPath}.${process.pid}.${this.idFactory()}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(next)}\n`, 'utf8');
      fs.renameSync(temp, this.configPath);
      return next;
    });
  }
}

export function currentDocuments(records) {
  const current = new Map();
  for (const record of records) {
    if (record.kind === 'deleted') {
      const prior = current.get(record.documentId);
      if (prior) current.set(record.documentId, {
        ...prior, status: 'deleted', text: '', sections: [], deleted: true,
        deletedAt: record.createdAt, deletionReason: record.reason,
      });
      continue;
    }
    const prior = current.get(record.documentId);
    // A later record always wins; a lower version cannot overwrite a higher one.
    if (prior && prior.version > record.version) continue;
    current.set(record.documentId, {
      documentId: record.documentId,
      path: record.source.path,
      root: record.source.root,
      format: record.format,
      contentHash: record.contentHash,
      textHash: record.textHash,
      version: record.version,
      status: record.status,
      error: record.error ?? null,
      text: record.text ?? '',
      sections: record.sections ?? [],
      limitations: record.limitations ?? [],
      warnings: record.warnings ?? [],
      bytes: record.bytes,
      observedAt: record.observedAt ?? record.createdAt,
      ingestedAt: record.createdAt,
      extractor: record.extractor,
      deleted: false,
      record,
    });
  }
  return current;
}
