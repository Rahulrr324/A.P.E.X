// T-12 content understanding. This service owns the explicit content permission, bounded local
// extraction and the document version index. It never writes knowledge directly: derived facts go
// through KnowledgeStore.addSourceCandidate, and every change is emitted through T-09 ingest.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ValidationError } from '../errors.js';
import { containsSecret } from '../security/secrets.js';
import { CONTENT_PERMISSION, DEFAULT_CONFIG, DEFAULT_EXTENSIONS, DOCUMENT_SCHEMA, EXTRACTOR_ID, EXTRACTOR_VERSION, LIMITS } from './vocabulary.js';
import { DocumentStore, currentDocuments } from './store.js';
import { extractDocument, MAX_DOCUMENT_BYTES, TEXT_EXTENSIONS } from '../filesystem/documents.js';
import { SENSITIVE_FILE_RE, SENSITIVE_PATH_SEGMENTS } from '../integrations/vocabulary.js';

const STOPWORDS = new Set('a an and are as at be by for from has have in is it its of on or that the this to was were will with what which who how does do did document documents says say about'.split(' '));
const KEY_VALUE = /^\s*([A-Za-z][A-Za-z0-9 _.-]{0,40})\s*:\s*(.{1,240})\s*$/;
const QUESTION_COMPARE = /\b(compare|difference|different|changed|between|versus|vs\.?|from version|to version)\b/i;
const QUESTION_TERMS = new Set('what where when who why how does do did the a an of in on for to about says say state states state?'.split(' '));

function hashBuffer(buf) { return createHash('sha256').update(buf).digest('hex'); }
function hashText(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function normalisePath(value) { return String(value).replace(/\\/g, '/'); }
function safeLabel(value, max = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function tokenize(text) {
  return [...new Set((String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word)))];
}
function rootLabel(root, index) {
  const base = path.basename(root).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 24);
  return `${base || 'root'}-${index + 1}`;
}
function sensitiveSegment(name) {
  return SENSITIVE_PATH_SEGMENTS.some((entry) => entry.toLowerCase() === String(name).toLowerCase());
}
function identityFor(root, relative) {
  return `doc:${createHash('sha256').update(`${normalisePath(root)}\u0000${normalisePath(relative)}`).digest('hex').slice(0, 32)}`;
}
function extensionOf(name) { return path.extname(name).replace(/^\./, '').toLowerCase(); }

function sectionList(text, format) {
  const lines = text.split('\n');
  const offsets = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const marks = [];
  if (['text', 'md', 'markdown', 'json', 'text'].includes(format)) {
    lines.forEach((line, index) => {
      if (/^#{1,6}\s+\S/.test(line) || (format === 'text' && /^[A-Z][A-Za-z0-9 _-]{2,80}\s*$/.test(line) && lines[index + 1]?.trim() === '')) {
        marks.push({ index, label: safeLabel(line.replace(/^#+\s*/, ''), 120), start: offsets[index] });
      }
    });
  }
  if (marks.length === 0) {
    // A bounded paragraph window is still a real boundary; it is never presented as a semantic
    // section. CSV gets header-aware row windows instead of arbitrary prose chunks.
    const chunk = format === 'csv' ? 25 * 160 : 4000;
    for (let start = 0; start < text.length && marks.length < LIMITS.maxSections;) {
      const end = Math.min(text.length, start + chunk);
      marks.push({ index: marks.length, label: `lines ${text.slice(0, start).split('\n').length}-${text.slice(0, end).split('\n').length}`, start });
      start = end;
    }
  }
  if (marks.length === 0) marks.push({ index: 0, label: 'document', start: 0 });
  const sections = [];
  for (let i = 0; i < marks.length && sections.length < LIMITS.maxSections; i += 1) {
    const start = marks[i].start;
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    sections.push({ index: sections.length, label: safeLabel(marks[i].label, 120), start, end });
  }
  return sections;
}

function candidateFacts(doc, text, sections) {
  const facts = [];
  const push = (relationship, object, section = null, locator = null) => {
    const rel = safeLabel(relationship, 120);
    const obj = safeLabel(object, 300);
    if (!rel || !obj || containsSecret(obj)) return;
    facts.push({ relationship: rel, object: obj, section, locator });
  };
  // Version and hash are index metadata, not facts about the subject. Keeping them out of the
  // knowledge store avoids turning every re-index into a new candidate claim.
  if (doc.format === 'json') {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed).slice(0, 10)) {
          if (['string', 'number', 'boolean'].includes(typeof value)) push(`field:${key}`, String(value), 0, `key ${key}`);
        }
      }
    } catch { /* extraction succeeded as text, but this is not valid JSON */ }
  } else if (doc.format === 'csv') {
    const rows = text.split('\n').filter((line) => line.trim().length > 0).slice(0, 20).map((line) => line.split('\t'));
    const headers = rows[0] ?? [];
    for (let r = 1; r < rows.length; r += 1) {
      rows[r].forEach((value, c) => {
        if (headers[c] && value.trim()) push(`column:${headers[c]}`, value, 0, `row ${r}`);
      });
    }
  }
  for (const line of text.split('\n')) {
    const match = KEY_VALUE.exec(line);
    if (match && !match[1].toLowerCase().startsWith('http')) push(`field:${match[1]}`, match[2], 0, `line ${text.slice(0, lineOffset(text, line)).split('\n').length}`);
    if (facts.length >= LIMITS.maxCandidates) break;
  }
  return facts.slice(0, LIMITS.maxCandidates);
}

function lineOffset(text, line) {
  const index = text.indexOf(line);
  return index < 0 ? 0 : index;
}

function snippetAt(text, offset, max = LIMITS.maxExcerptChars) {
  const start = Math.max(0, offset - Math.floor(max / 3));
  const end = Math.min(text.length, start + max);
  return {
    start,
    end,
    text: `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')}${end < text.length ? '…' : ''}`,
  };
}

function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    removed: a.filter((line) => line.trim() && !setB.has(line)).slice(0, 100),
    added: b.filter((line) => line.trim() && !setA.has(line)).slice(0, 100),
    unchanged: a.filter((line) => setB.has(line)).length,
  };
}

export class DocumentService {
  constructor({ dataDir, knowledge = null, situation = null, worldModel = null, goals = null, now = () => new Date(), idFactory = randomUUID } = {}) {
    if (!dataDir) throw new TypeError('DocumentService requires a data directory');
    this.dataDir = dataDir;
    this.knowledge = knowledge;
    this.situation = situation;
    this.worldModel = worldModel;
    this.goals = goals;
    this.now = now;
    this.idFactory = idFactory;
    this.store = new DocumentStore(dataDir, { now, idFactory });
    this.inFlight = false;
    this.lastReport = null;
  }

  #config() {
    return this.store.loadConfig() ?? { ...DEFAULT_CONFIG, roots: [], extensions: [...DEFAULT_EXTENSIONS], exclude: [] };
  }

  #validateConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('document configuration must be an object');
    const merged = { ...DEFAULT_CONFIG, ...input };
    if (!Array.isArray(merged.roots)) throw new ValidationError('roots must be a list');
    if (merged.roots.length > LIMITS.maxRoots) throw new ValidationError(`roots may name at most ${LIMITS.maxRoots} directories`);
    const roots = merged.roots.map((root, index) => {
      if (typeof root !== 'string' || !path.isAbsolute(root)) throw new ValidationError(`root ${index + 1} must be an absolute path`);
      const resolved = path.resolve(root);
      if (path.parse(resolved).root === resolved) throw new ValidationError(`root ${index + 1} is a filesystem root; configure a narrower directory`);
      const sensitive = resolved.split(path.sep).filter(Boolean).find((part) => sensitiveSegment(part));
      if (sensitive) throw new ValidationError(`root ${index + 1} passes through excluded directory \"${sensitive}\"`);
      let stat;
      try {
        if (fs.lstatSync(resolved).isSymbolicLink()) throw new ValidationError(`root ${index + 1} is a symbolic link; configure its target instead`);
        stat = fs.statSync(resolved);
      } catch (err) { throw new ValidationError(`root ${index + 1} cannot be read: ${err?.code ?? err?.message}`); }
      if (!stat.isDirectory()) throw new ValidationError(`root ${index + 1} is not a directory`);
      return resolved;
    });
    if (!Array.isArray(merged.extensions) || merged.extensions.length === 0 || merged.extensions.length > 40) throw new ValidationError('extensions must name between 1 and 40 extensions');
    const extensions = [...new Set(merged.extensions.map((value) => String(value).replace(/^\./, '').toLowerCase()))];
    if (extensions.some((value) => !TEXT_EXTENSIONS.includes(`.${value}`) && !['pdf', 'docx', 'xlsx', 'markdown'].includes(value))) {
      throw new ValidationError('an extension is not a supported text or document format');
    }
    if (!Array.isArray(merged.exclude) || merged.exclude.length > 20) throw new ValidationError('exclude may name at most 20 names');
    if (!Number.isInteger(merged.maxFiles) || merged.maxFiles < 1 || merged.maxFiles > LIMITS.maxFiles) throw new ValidationError(`maxFiles must be 1-${LIMITS.maxFiles}`);
    if (!Number.isInteger(merged.maxBytes) || merged.maxBytes < 1 || merged.maxBytes > LIMITS.maxFileBytes) throw new ValidationError(`maxBytes must be 1-${LIMITS.maxFileBytes}`);
    if (!Number.isInteger(merged.intervalMs ?? 60000) || (merged.intervalMs ?? 60000) < 1000 || (merged.intervalMs ?? 60000) > 86400000) throw new ValidationError('intervalMs must be 1000-86400000');
    if (merged.entityId !== null && merged.entityId !== undefined && (typeof merged.entityId !== 'string' || merged.entityId.length > 64)) throw new ValidationError('entityId must be an id up to 64 characters');
    return { ...merged, roots, extensions, exclude: merged.exclude.map((value) => safeLabel(value, 80)), entityId: merged.entityId ?? null, intervalMs: merged.intervalMs ?? 60000 };
  }

  async configure(patch = {}) {
    const current = this.#config();
    for (const key of Object.keys(patch)) {
      if (!['roots', 'extensions', 'exclude', 'maxFiles', 'maxBytes', 'entityId', 'intervalMs'].includes(key)) throw new ValidationError(`unknown document configuration field \"${key}\"`);
    }
    const next = this.#validateConfig({ ...current, ...patch });
    if (next.entityId && this.worldModel) {
      const view = await this.worldModel.showEntity(next.entityId).catch(() => null);
      if (!view || view.problem) throw new ValidationError(`entity ${next.entityId} cannot be used`);
    }
    await this.store.saveConfig(next);
    return { config: this.#publicConfig(next) };
  }

  #publicConfig(config) {
    return { schema: config.schema, enabled: config.enabled, paused: config.paused, roots: [...config.roots], extensions: [...config.extensions], exclude: [...config.exclude], maxFiles: config.maxFiles, maxBytes: config.maxBytes, entityId: config.entityId, intervalMs: config.intervalMs ?? 60000 };
  }

  async enable() {
    const config = this.#config();
    if (config.roots.length === 0) throw new ValidationError('content ingestion needs at least one authorized root');
    const next = this.#validateConfig({ ...config, enabled: true });
    await this.store.saveConfig(next);
    return { enabled: true, permission: CONTENT_PERMISSION };
  }

  async disable() {
    const next = { ...this.#config(), enabled: false };
    await this.store.saveConfig(next);
    return { enabled: false };
  }

  async pause() { const next = { ...this.#config(), paused: true }; await this.store.saveConfig(next); return { paused: true }; }
  async resume() { const next = { ...this.#config(), paused: false }; await this.store.saveConfig(next); return { paused: false }; }

  async #scan(config, signal) {
    const files = [];
    let truncated = false;
    let skipped = 0;
    for (let rootIndex = 0; rootIndex < config.roots.length; rootIndex += 1) {
      const root = config.roots[rootIndex];
      const queue = [{ dir: root, depth: 0 }];
      while (queue.length > 0) {
        if (signal?.aborted) throw Object.assign(new Error('document scan was cancelled'), { code: 'ABORTED' });
        const { dir, depth } = queue.shift();
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (err) {
          if (depth === 0) throw new Error(`authorized root ${rootIndex + 1} cannot be read: ${err?.code ?? err?.message}`);
          continue;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : 1));
        for (const entry of entries) {
          if (signal?.aborted) throw Object.assign(new Error('document scan was cancelled'), { code: 'ABORTED' });
          if (sensitiveSegment(entry.name) || SENSITIVE_FILE_RE.test(entry.name) || entry.name.startsWith('~$') || config.exclude.includes(entry.name)) { skipped += 1; continue; }
          const absolute = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) { skipped += 1; continue; }
          if (entry.isDirectory()) { if (depth < 8) queue.push({ dir: absolute, depth: depth + 1 }); continue; }
          if (!entry.isFile()) continue;
          const extension = extensionOf(entry.name);
          if (!config.extensions.includes(extension)) continue;
          if (files.length >= config.maxFiles) { truncated = true; break; }
          let stat;
          try { stat = await fs.promises.stat(absolute); } catch { skipped += 1; continue; }
          if (!stat.isFile()) continue;
          const relative = path.relative(root, absolute);
          if (relative.startsWith('..') || path.isAbsolute(relative)) { skipped += 1; continue; }
          files.push({ root, rootLabel: rootLabel(root, rootIndex), path: normalisePath(relative), absolute, extension, size: stat.size, mtimeMs: stat.mtimeMs });
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
    return { files, truncated, skipped };
  }

  #documentFor(file, version, buf, textResult) {
    const documentId = identityFor(file.root, file.path);
    const contentHash = hashBuffer(buf);
    return {
      schema: 1,
      kind: undefined,
      id: this.idFactory(),
      documentId,
      version,
      contentHash,
      textHash: textResult?.textSha256 ?? hashText(''),
      bytes: buf.length,
      source: { provider: 'filesystem_content', root: file.rootLabel, path: file.path },
      format: textResult
        ? (textResult.format === 'text' && ['json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf'].includes(file.extension) ? file.extension : textResult.format)
        : file.extension,
      status: textResult ? 'indexed' : 'failed',
      error: textResult ? undefined : 'the file could not be extracted',
      text: textResult?.text ?? '',
      sections: textResult ? sectionList(textResult.text, textResult.format) : [],
      limitations: textResult?.limitations ?? [],
      warnings: [],
      observedAt: new Date(file.mtimeMs).toISOString(),
      createdAt: this.now().toISOString(),
      extractor: { id: EXTRACTOR_ID, version: EXTRACTOR_VERSION },
      permissionScope: CONTENT_PERMISSION,
    };
  }

  async #candidates(document, textResult) {
    if (!this.knowledge || !textResult) return [];
    const sections = document.sections;
    const facts = candidateFacts(document, textResult.text, sections);
    const ids = [];
    for (const fact of facts) {
      try {
        const result = await this.knowledge.addSourceCandidate({
          subject: document.source.path,
          relationship: fact.relationship,
          object: fact.object,
          evidence: `document ${document.documentId} version ${document.version}${fact.locator ? `; ${fact.locator}` : ''}`,
          document: {
            documentId: document.documentId,
            path: document.source.path,
            version: document.version,
            contentHash: document.contentHash,
            section: fact.section,
            locator: fact.locator,
          },
        });
        if (!result.duplicate) ids.push(result.record.id);
      } catch { /* a rejected candidate is not an extraction success and is not stored */ }
    }
    return ids;
  }

  async #goalsFor(pathName, text) {
    if (!this.goals) return [];
    const words = new Set([...tokenize(pathName), ...tokenize(text.slice(0, 2000))]);
    let records;
    try { records = await this.goals.list(); } catch { return []; }
    return (Array.isArray(records) ? records : []).filter((goal) => {
      if (!['open', 'active', 'proposed'].includes(goal.status)) return false;
      const hay = tokenize(`${goal.request ?? ''} ${goal.title ?? ''} ${goal.statement ?? ''} ${goal.description ?? ''}`);
      return hay.some((word) => words.has(word));
    }).slice(0, 3).map((goal) => goal.id);
  }

  async #emit(document, type, extra = {}) {
    if (!this.situation) return null;
    const goalRefs = await this.#goalsFor(document.source.path, document.text ?? '');
    const excerpt = (document.text ?? '').slice(0, 600);
    try {
      const result = await this.situation.ingest({
        source: 'external_provider',
        sourceEventId: `doc:${document.documentId}:v${document.version}${extra.eventIdSuffix ? `:${extra.eventIdSuffix}` : ''}`,
        type,
        category: 'external',
        observedAt: document.observedAt,
        payload: {
          summary: `${type.replaceAll('_', ' ')}: ${document.source.path} (${document.format})`,
          document: {
            id: document.documentId,
            path: document.source.path,
            root: document.source.root,
            format: document.format,
            version: document.version,
            contentHash: document.contentHash,
            status: document.status,
          },
          excerpt,
          candidateIds: extra.candidateIds ?? [],
          affectedGoals: goalRefs,
          limitations: [...document.limitations, ...(extra.limitations ?? [])].slice(0, 5),
        },
        confidence: 0.9,
        entityRefs: document.entityId ? [document.entityId] : [],
        goalRefs,
        planRefs: [],
        taskRefs: [],
        provenance: { reporter: 'documents', provider: 'filesystem_content' },
      });
      return result.event?.id ?? null;
    } catch { return null; }
  }

  async ingest({ force = false, signal = null } = {}) {
    const config = this.#config();
    if (!config.enabled) return { status: 'skipped', reason: 'content ingestion is disabled' };
    if (config.paused) return { status: 'skipped', reason: 'content ingestion is paused' };
    if (this.inFlight) return { status: 'skipped', reason: 'content ingestion is already in flight' };
    this.inFlight = true;
    const started = Date.now();
    try {
      const existing = currentDocuments((await this.store.load()).records);
      // The cap bounds the index, not the scan. Refusing the whole read at the cap made every later
      // scheduled ingest fail - including one that had nothing new to add - and left existing
      // documents unable to gain versions or deletions. Deleted documents release their slot, and
      // only a document that would newly occupy one is skipped.
      let occupied = [...existing.values()].filter((doc) => !doc.deleted).length;
      let limited = 0;
      let limitStated = false;
      const scan = await this.#scan(config, signal);
      const seen = new Set();
      const report = { status: 'ingested', observed: 0, indexed: 0, changed: 0, duplicates: 0, failed: 0, deleted: 0, limited: 0, truncated: scan.truncated, warnings: [], documents: [] };
      for (const file of scan.files) {
        const documentId = identityFor(file.root, file.path);
        if (seen.has(documentId)) continue;
        seen.add(documentId);
        const prior = existing.get(documentId);
        if ((!prior || prior.deleted) && occupied >= LIMITS.maxDocuments) {
          limited += 1;
          report.limited = limited;
          if (!limitStated) {
            limitStated = true;
            report.warnings.push(`the document index is at its ${LIMITS.maxDocuments}-document limit; new documents are not indexed until a current document is deleted`);
          }
          continue;
        }
        if ((prior?.version ?? 0) >= LIMITS.maxVersions) {
          report.warnings.push(`${file.path}: version limit ${LIMITS.maxVersions} reached; the current indexed version is retained`);
          continue;
        }
        if (file.size > config.maxBytes) {
          const oversizeHash = createHash('sha256').update(`oversize:${file.path}`).digest('hex');
          if (prior?.status !== 'failed' || prior.contentHash !== oversizeHash) {
            const record = this.#documentFor(file, (prior?.version ?? 0) + 1, Buffer.alloc(0), null);
            record.status = 'failed'; record.error = `file is ${file.size} bytes; the limit is ${config.maxBytes}`; record.contentHash = oversizeHash;
            await this.store.append([record]);
            report.failed += 1;
            if (!prior || prior.deleted) occupied += 1;
            await this.#emit(record, 'document_extraction_failed', { limitations: [record.error] });
          }
          continue;
        }
        let buf;
        try { buf = await fs.promises.readFile(file.absolute); } catch (err) { report.warnings.push(`${file.path}: ${err?.code ?? 'read_error'}`); continue; }
        report.observed += 1;
        const contentHash = hashBuffer(buf);
        if (!force && prior && prior.contentHash === contentHash && prior.status === 'indexed') { report.duplicates += 1; continue; }
        let extracted = null;
        let error = null;
        try { extracted = extractDocument(file.path, buf); } catch (err) { error = err?.message ?? String(err); }
        let record = this.#documentFor(file, (prior?.version ?? 0) + 1, buf, extracted);
        record.entityId = config.entityId ?? null;
        if (error) {
          record.status = 'failed'; record.error = safeLabel(error, 500); record.text = ''; record.sections = [];
          report.failed += 1;
        } else {
          report.indexed += 1;
          if (prior) report.changed += 1;
          if (extracted.truncated) record.warnings.push(`extracted text truncated at ${LIMITS.maxTextChars} characters`);
        }
        await this.store.append([record]);
        if (!prior || prior.deleted) occupied += 1;
        const candidateIds = record.status === 'indexed' ? await this.#candidates(record, extracted) : [];
        const type = record.status === 'failed' ? 'document_extraction_failed' : (prior ? 'document_updated' : 'document_indexed');
        const eventId = await this.#emit(record, type, { candidateIds });
        report.documents.push({ documentId, path: file.path, version: record.version, status: record.status, eventId, candidateIds: candidateIds.length });
      }
      // Only a complete scan can prove a document is gone. A capped scan or an unreadable root
      // never turns a bounded view into a mass deletion.
      if (!scan.truncated) {
        for (const [documentId, doc] of existing) {
          if (doc.deleted || seen.has(documentId)) continue;
          const deletion = { schema: 1, kind: 'deleted', documentId, reason: 'source file is no longer present', createdAt: this.now().toISOString() };
          await this.store.append([deletion]);
          report.deleted += 1;
          doc.text = ''; doc.version = doc.version + 1; doc.status = 'deleted'; doc.documentId = documentId;
          doc.source = { provider: 'filesystem_content', path: doc.path, root: doc.root };
          doc.limitations = []; doc.warnings = []; doc.format = doc.format ?? 'unknown';
          await this.#emit(doc, 'document_deleted', { eventIdSuffix: 'deleted' });
        }
      }
      report.durationMs = Date.now() - started;
      report.totalIndexed = (await this.#state()).documents.length;
      this.lastReport = report;
      return report;
    } finally {
      this.inFlight = false;
    }
  }

  async ingestDue() {
    const config = this.#config();
    if (!config.enabled || config.paused) return { status: 'skipped', reason: config.paused ? 'content ingestion is paused' : 'content ingestion is disabled' };
    const records = (await this.store.load()).records;
    const last = records.filter((r) => r.kind === undefined).map((r) => Date.parse(r.createdAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (last && this.now().getTime() - last < (config.intervalMs ?? 60000)) return { status: 'skipped', reason: 'the document interval has not elapsed' };
    return this.ingest();
  }

  async #state() {
    const loaded = await this.store.load();
    const docs = [...currentDocuments(loaded.records).values()];
    return { config: this.#config(), records: loaded.records, corrupt: loaded.corrupt, documents: docs };
  }

  async status() {
    const state = await this.#state();
    return {
      schema: DOCUMENT_SCHEMA,
      permission: CONTENT_PERMISSION,
      config: this.#publicConfig(state.config),
      documents: state.documents.length,
      indexed: state.documents.filter((doc) => !doc.deleted && doc.status === 'indexed').length,
      failed: state.documents.filter((doc) => !doc.deleted && doc.status === 'failed').length,
      deleted: state.documents.filter((doc) => doc.deleted).length,
      corrupt: state.corrupt.length,
      running: this.inFlight,
      lastReport: this.lastReport,
    };
  }

  async list({ limit = 20, includeDeleted = false } = {}) {
    const state = await this.#state();
    const docs = state.documents.filter((doc) => includeDeleted || !doc.deleted).sort((a, b) => (b.ingestedAt ?? '').localeCompare(a.ingestedAt ?? '')).slice(0, Math.max(1, Math.min(limit, 100)));
    return docs.map((doc) => ({
      documentId: doc.documentId, path: doc.path, root: doc.root, format: doc.format, version: doc.version,
      status: doc.deleted ? 'deleted' : doc.status, contentHash: doc.contentHash, bytes: doc.bytes,
      observedAt: doc.observedAt, ingestedAt: doc.ingestedAt, deleted: doc.deleted,
      limitations: doc.limitations, warnings: doc.warnings,
    }));
  }

  async document(documentId) {
    const state = await this.#state();
    const doc = state.documents.find((item) => item.documentId === documentId || item.documentId.startsWith(documentId));
    if (!doc) return null;
    return { ...doc, config: this.#publicConfig(state.config) };
  }

  async search(query, { limit = 5, documentId = null, version = null, section = null } = {}) {
    const q = String(query ?? '').trim();
    if (q.length === 0) throw new ValidationError('query is empty');
    if (q.length > 1000) throw new ValidationError('query exceeds 1000 characters');
    const terms = tokenize(q);
    const phraseMatch = /"([^"]{2,200})"/.exec(q);
    const phrase = phraseMatch ? phraseMatch[1].toLowerCase() : null;
    const state = await this.#state();
    const results = [];
    for (const doc of state.documents) {
      if (doc.deleted || doc.status !== 'indexed') continue;
      if (documentId && !doc.documentId.startsWith(documentId)) continue;
      if (version !== null && doc.version !== version) continue;
      if (section !== null && !doc.sections.some((item) => item.index === section)) continue;
      const hay = doc.text.toLowerCase();
      const exact = phrase ? hay.includes(phrase) : false;
      let score = exact ? 100 : 0;
      const matched = [];
      for (const term of terms) {
        const count = (hay.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
        if (count > 0) { score += Math.min(10, count); matched.push(term); }
      }
      if (phrase && !exact) continue;
      if (score === 0) continue;
      let offset = -1;
      if (exact) offset = hay.indexOf(phrase);
      else {
        for (const term of terms) {
          const at = hay.search(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          if (at >= 0) { offset = at; break; }
        }
      }
      const atSection = offset >= 0 ? (doc.sections.find((item) => offset >= item.start && offset < item.end) ?? null) : null;
      if (section !== null && atSection?.index !== section) continue;
      results.push({
        documentId: doc.documentId, path: doc.path, format: doc.format, version: doc.version,
        score, reasons: [exact ? `exact phrase "${phrase}"` : '', ...matched.map((term) => `term "${term}"`)].filter(Boolean),
        matchedTerms: matched, exactPhrase: exact, section: atSection ? { index: atSection.index, label: atSection.label, start: atSection.start, end: atSection.end } : null,
        excerpt: snippetAt(doc.text, Math.max(0, offset)),
        contentHash: doc.contentHash, ingestedAt: doc.ingestedAt,
      });
    }
    results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return results.slice(0, Math.min(limit, LIMITS.maxQueryResults));
  }

  async contextFor(request, { maxChars = LIMITS.maxContextChars } = {}) {
    const terms = tokenize(request);
    if (terms.length === 0) return { lines: [], results: 0, truncated: false, note: 'no search terms in the request' };
    let results;
    try { results = await this.search(request, { limit: 3 }); } catch { return { lines: [], results: 0, truncated: false, error: 'document retrieval failed' }; }
    const lines = [];
    let used = 0;
    for (const result of results) {
      const line = `- ${result.path} [document ${result.documentId}, v${result.version}, section ${result.section?.label ?? 'document'}]: ${safeLabel(result.excerpt.text, 500)}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    return { lines, results: results.length, shown: lines.length, truncated: results.length > lines.length, note: 'deterministic exact-term retrieval; no semantic or vector search' };
  }

  async ask(question, { limit = 5 } = {}) {
    const q = String(question ?? '').trim();
    if (!q) throw new ValidationError('question is empty');
    const docs = await this.list({ limit: 100 });
    if (QUESTION_COMPARE.test(q)) {
      const id = docs.find((doc) => q.toLowerCase().includes(doc.documentId.toLowerCase()))?.documentId
        ?? docs.find((doc) => q.toLowerCase().includes(doc.path.toLowerCase()))?.documentId;
      if (id) {
        const comparison = await this.compare(id);
        return {
          question: q, kind: 'version_comparison', documents: [id],
          explicit: comparison.versions.length < 2 ? [] : [`${comparison.path} has ${comparison.versions.length} recorded version(s); version ${comparison.versions.at(-1).version} is current.`],
          extracted: [], inferred: comparison.versions.length < 2 ? [] : [`Rule: a changed content hash creates a new version; compared version ${comparison.versions.at(-2).version} with ${comparison.versions.at(-1).version}.`],
          unknown: comparison.versions.length < 2 ? ['Only one version is indexed; a version-to-version comparison cannot be made.'] : [],
          comparison,
        };
      }
    }
    const results = await this.search(q, { limit });
    const explicit = results.map((result) => `${result.path} (v${result.version}, ${result.section?.label ?? 'document'}): "${safeLabel(result.excerpt.text, 500)}"`);
    const extracted = [];
    if (this.knowledge) {
      try {
        const claims = await this.knowledge.list({ limit: 100 });
        for (const claim of claims) {
          if (claim.active === true && claim.document && results.some((result) => result.documentId === claim.document.documentId)) {
            extracted.push(`${claim.candidate ? 'candidate: ' : ''}${claim.subject} --[${claim.relationship}]--> ${claim.object}`);
          }
        }
      } catch { /* the answer marks that extraction facts were unavailable */ }
    }
    const unknown = [];
    if (results.length === 0) unknown.push('No indexed document matched the question terms; this is not proof that the information does not exist.');
    const words = new Set(results.flatMap((result) => result.matchedTerms));
    const missing = tokenize(q).filter((term) => !words.has(term));
    if (results.length > 0 && missing.length > 0) unknown.push(`These question terms were not found together in the matching excerpts: ${missing.join(', ')}.`);
    return {
      question: q,
      kind: 'grounded_document_answer',
      documents: [...new Set(results.map((result) => result.documentId))],
      explicit,
      extracted,
      inferred: results.length > 0 ? [`Rule: results are ranked by exact-phrase and term overlap across the current indexed versions; ${results.length} document(s) matched.`] : [],
      unknown,
      results,
    };
  }

  async versions(documentId) {
    const state = await this.#state();
    const docs = state.records.filter((record) => record.documentId === documentId && record.kind === undefined);
    if (docs.length === 0) return null;
    return docs.sort((a, b) => a.version - b.version).map((record) => ({
      documentId: record.documentId, version: record.version, path: record.source.path, format: record.format,
      contentHash: record.contentHash, status: record.status, createdAt: record.createdAt, bytes: record.bytes,
      limitations: record.limitations, warnings: record.warnings,
    }));
  }

  async evidence(documentId, { version = null, section = null } = {}) {
    const state = await this.#state();
    const versions = state.records.filter((record) => record.documentId === documentId && record.kind === undefined).sort((a, b) => a.version - b.version);
    if (versions.length === 0) return null;
    const record = version === null ? versions.at(-1) : versions.find((item) => item.version === version);
    if (!record) return null;
    const current = state.documents.find((doc) => doc.documentId === documentId) ?? null;
    const sec = section === null ? null : record.sections.find((item) => item.index === section);
    const excerpt = sec ? record.text.slice(sec.start, sec.end) : record.text.slice(0, LIMITS.maxExcerptChars);
    return {
      document: { id: record.documentId, path: record.source.path, root: record.source.root, format: record.format, version: record.version, status: record.status, contentHash: record.contentHash, createdAt: record.createdAt, current: current !== null && !current.deleted && current.version === record.version },
      section: sec, excerpt: safeLabel(excerpt, LIMITS.maxExcerptChars), fullTextAvailable: record.status === 'indexed',
      extractor: record.extractor, limitations: record.limitations, warnings: record.warnings,
    };
  }

  async compare(documentId, { from = null, to = null } = {}) {
    const versions = await this.versions(documentId);
    if (!versions) return null;
    const usable = versions.filter((version) => version.status === 'indexed');
    if (usable.length === 0) return { documentId, versions, error: 'no successfully extracted version is available for comparison' };
    const left = from === null ? usable.at(-2) ?? usable.at(-1) : usable.find((version) => version.version === from);
    const right = to === null ? usable.at(-1) : usable.find((version) => version.version === to);
    if (!left || !right) return { documentId, versions, error: 'the requested version is not available' };
    const state = await this.#state();
    const lrec = state.records.find((record) => record.documentId === documentId && record.version === left.version);
    const rrec = state.records.find((record) => record.documentId === documentId && record.version === right.version);
    return {
      documentId, path: right.path,
      from: { version: left.version, contentHash: left.contentHash },
      to: { version: right.version, contentHash: right.contentHash },
      changed: left.contentHash !== right.contentHash,
      diff: lineDiff(lrec.text, rrec.text),
      versions: versions.map((version) => ({ version: version.version, status: version.status, contentHash: version.contentHash, createdAt: version.createdAt })),
    };
  }

  async candidateFacts(documentId) {
    if (!this.knowledge) return [];
    const claims = await this.knowledge.list({ limit: 100 });
    const state = await this.#state();
    const doc = state.documents.find((item) => item.documentId === documentId);
    return claims.filter((claim) => claim.active === true && claim.document?.documentId === documentId).map((claim) => ({
      id: claim.id, subject: claim.subject, relationship: claim.relationship, object: claim.object,
      status: claim.status, candidate: claim.candidate === true, conflictsWith: claim.conflictsWith,
      sourceState: doc && !doc.deleted && doc.status === 'indexed' && doc.version === claim.document.version ? 'available' : 'unavailable',
    }));
  }

  async diagnose() {
    const state = await this.#state();
    const checks = [
      { name: 'configuration', ok: state.corrupt.length === 0, detail: state.corrupt.length ? `${state.corrupt.length} corrupt document record(s)` : 'document index parses' },
      { name: 'permission', ok: true, detail: `${CONTENT_PERMISSION} is ${state.config.enabled ? 'granted' : 'not granted'}` },
      { name: 'formats', ok: true, detail: 'text, Markdown, JSON, CSV/TSV, PDF, DOCX, XLSX and configured source/config extensions' },
      { name: 'inference', ok: true, detail: 'no extractor holds a model or inference handle' },
      { name: 'network', ok: true, detail: 'content extraction is local and uploads nothing' },
      { name: 'bounds', ok: true, detail: `${state.config.maxFiles} file(s), ${state.config.maxBytes} bytes each, ${LIMITS.maxTextChars} text characters` },
    ];
    return { at: this.now().toISOString(), healthy: checks.every((check) => check.ok), checks, status: await this.status() };
  }

  async invalidate(documentId, { reason } = {}) {
    if (typeof reason !== 'string' || reason.trim().length < 4) throw new ValidationError('invalidation requires a reason of at least 4 characters');
    const state = await this.#state();
    const doc = state.documents.find((item) => item.documentId === documentId || item.documentId.startsWith(documentId));
    if (!doc) throw new ValidationError('document not found');
    await this.store.append([{ schema: 1, kind: 'deleted', documentId: doc.documentId, reason: `manual invalidation: ${safeLabel(reason, 200)}`, createdAt: this.now().toISOString() }]);
    return { documentId: doc.documentId, invalidated: true, historyPreserved: true };
  }

  async reprocess(documentId) {
    const doc = await this.document(documentId);
    if (!doc) throw new ValidationError('document not found');
    this.lastReport = null;
    const report = await this.ingest({ force: true });
    return { ...report, reprocessed: doc.documentId };
  }
}
