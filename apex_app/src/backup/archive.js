// Versioned export and restore of the APEX data directory.
//
// The archive is one JSON document: a manifest (format, version, creation time, and one entry per
// file with its byte length and SHA-256) beside the exact text of every APEX-owned file. Export
// reads only the fixed file list below, so lock claims, temporary files, and a pre-restore archive
// in `backups/` are never swept into a newer export. Restore validates the whole archive before it
// writes anything: structure, versions, paths, lengths, digests, and that every JSONL line parses.
//
// What the digests prove and what they do not: they detect corruption and truncation of an archive
// and of what was written back. The archive is not signed and has no external anchor, so it does not
// prove who produced it or that it was not deliberately edited.
//
// Restore is deliberately hard to invoke by accident. It needs the archive's digest prefix as an
// explicit confirmation, refuses while a store lock file is present, refuses to replace existing
// bytes without `replaceExisting`, and writes a pre-restore archive of what it is about to replace
// before replacing it. Files the archive does not contain are left in place rather than deleted.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StoreError, ValidationError } from '../errors.js';
import { sha256 } from '../filesystem/workspace.js';

export const ARCHIVE_FORMAT = 'apex-backup';
export const ARCHIVE_VERSION = 1;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
export const MAX_DESTINATION_CHARS = 500;
export const CONFIRMATION_MIN_CHARS = 8;

// The files APEX owns in its data directory. The list is a contract, not a directory scan: a lock
// claim, a staged restore file, or an archive someone put there must never become backup content.
export const DATA_FILES = Object.freeze([
  'memory.jsonl',
  'conversation.jsonl',
  'operations.jsonl',
  'session.json',
  'tasks.jsonl',
  'task-summary-queue.json',
  'knowledge.jsonl',
  'notes.jsonl',
  'experiences.jsonl',
  'predictions.jsonl',
  'goals.jsonl',
  'plans.jsonl',
  'proposals.jsonl',
  'deadlines.jsonl',
  'world-model.jsonl',
]);

const JSONL_FILES = new Set(DATA_FILES.filter((name) => name.endsWith('.jsonl')));
const PRE_RESTORE_DIR = 'backups';
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

function isContained(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function decodeUtf8(buffer, what) {
  try {
    return STRICT_UTF8.decode(buffer);
  } catch {
    throw new StoreError(`${what} is not valid UTF-8, so its bytes cannot be stored as text`);
  }
}

function lineCounts(text) {
  let lines = 0;
  let unparsed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    lines += 1;
    try {
      JSON.parse(line);
    } catch {
      unparsed += 1;
    }
  }
  return { lines, unparsed };
}

function manifestDigest({ createdAt, appVersion, files }) {
  const canonical = [
    `format=${ARCHIVE_FORMAT}`,
    `version=${ARCHIVE_VERSION}`,
    `createdAt=${createdAt}`,
    `appVersion=${appVersion}`,
    ...[...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((file) => `file=${file.name}\t${file.bytes}\t${file.sha256}`),
  ].join('\n');
  return sha256(canonical);
}

async function statOrNull(full) {
  try {
    return await fs.stat(full);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new StoreError(`cannot inspect ${path.basename(full)}: ${err?.code || err?.message}`);
  }
}

async function writeAtomic(destination, text, { operationId = null } = {}) {
  const directory = path.dirname(destination);
  const suffix = operationId ? String(operationId).replace(/[^A-Za-z0-9-]/g, '').slice(0, 32) : randomUUID();
  const temp = path.join(directory, `.${path.basename(destination)}.${suffix}.tmp`);
  let handle = null;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (err) {
    await handle?.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw new StoreError(`cannot write ${path.basename(destination)}: ${err?.code || err?.message}`);
  }
  await handle.close().catch(() => {});
  try {
    await fs.rename(temp, destination);
  } catch (err) {
    await fs.unlink(temp).catch(() => {});
    throw new StoreError(`cannot publish ${path.basename(destination)}: ${err?.code || err?.message}`);
  }
}

// Reads the fixed data-file list. Every file is read twice around the whole pass (size and
// modification time before, then after), so an export that overlapped a writer is refused rather
// than stored as a mixture of two moments. This is not a transactional snapshot across files; it is
// a stable read of each file, and the display says so.
export async function collectDataFiles(dataDir) {
  const collected = [];
  const first = new Map();
  for (const name of DATA_FILES) {
    const full = path.join(dataDir, name);
    const stat = await statOrNull(full);
    if (stat === null) continue;
    if (!stat.isFile()) throw new StoreError(`${name} is not a regular file; the data directory was not exported`);
    if (stat.size > MAX_FILE_BYTES) {
      throw new StoreError(`${name} is ${stat.size} bytes, above the ${MAX_FILE_BYTES}-byte per-file export bound`);
    }
    first.set(name, { size: stat.size, mtimeMs: stat.mtimeMs });
    let buffer;
    try {
      buffer = await fs.readFile(full);
    } catch (err) {
      throw new StoreError(`cannot read ${name}: ${err?.code || err?.message}`);
    }
    const text = decodeUtf8(buffer, name);
    const counts = JSONL_FILES.has(name) ? lineCounts(text) : { lines: null, unparsed: null };
    collected.push({
      name,
      bytes: buffer.length,
      sha256: sha256(buffer),
      text,
      lines: counts.lines,
      unparsed: counts.unparsed,
    });
  }
  for (const [name, before] of first) {
    const after = await statOrNull(path.join(dataDir, name));
    if (after === null || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new StoreError(`APEX data changed while it was being exported (${name}); nothing was written - retry when no other APEX process is writing`, 'BACKUP_SOURCE_CHANGED');
    }
  }
  const totalBytes = collected.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new StoreError(`the APEX data files total ${totalBytes} bytes, above the ${MAX_TOTAL_BYTES}-byte export bound; nothing was written`);
  }
  return { files: collected, totalBytes, missing: DATA_FILES.filter((name) => !first.has(name)) };
}

// Builds the archive document from the data directory. The public export applies its destination
// rules around this; the pre-restore archive deliberately writes *inside* the data directory and
// must therefore reuse the same construction rather than go through exportArchive's refusal.
async function buildArchive({ dataDir, now = () => new Date(), appVersion }) {
  const { files, totalBytes, missing } = await collectDataFiles(dataDir);
  const createdAt = now().toISOString();
  const manifest = files.map(({ name, bytes, sha256: digest }) => ({ name, bytes, sha256: digest }));
  const archiveDigest = manifestDigest({ createdAt, appVersion, files: manifest });
  const contents = Object.fromEntries(files.map((file) => [file.name, file.text]));
  const text = JSON.stringify({
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    createdAt,
    appVersion,
    archiveSha256: archiveDigest,
    files: manifest,
    contents,
  }, null, 2);
  const size = Buffer.byteLength(text, 'utf8');
  if (size > MAX_ARCHIVE_BYTES) {
    throw new StoreError(`the archive would be ${size} bytes, above the ${MAX_ARCHIVE_BYTES}-byte bound; nothing was written`);
  }
  return {
    text,
    createdAt,
    appVersion,
    archiveSha256: archiveDigest,
    size,
    totalBytes,
    missing,
    files: files.map(({ name, bytes, sha256: digest, lines, unparsed }) => ({ name, bytes, sha256: digest, lines, unparsed })),
  };
}

export async function exportArchive({ dataDir, destination, now = () => new Date(), appVersion }) {
  const target = path.resolve(destination);
  if (isContained(dataDir, target)) {
    throw new ValidationError('the archive destination must be outside the APEX data directory; nothing was written', 'BACKUP_DESTINATION_INSIDE_DATA');
  }
  const parent = await statOrNull(path.dirname(target));
  if (parent === null || !parent.isDirectory()) {
    throw new ValidationError(`the destination directory does not exist: ${path.dirname(target)}`, 'BACKUP_DESTINATION_MISSING');
  }
  if (await statOrNull(target) !== null) {
    throw new ValidationError(`the destination already exists and was not overwritten: ${target}`, 'BACKUP_DESTINATION_EXISTS');
  }
  const { text, ...built } = await buildArchive({ dataDir, now, appVersion });
  await writeAtomic(target, text);
  return { path: target, ...built };
}

function describeProblems(problems) {
  const shown = problems.slice(0, 3).join('; ');
  return problems.length > 3 ? `${shown}; and ${problems.length - 3} more` : shown;
}

// Loads and checks an archive without writing anything. Every problem is collected so `inspect`
// can report all of them; restore refuses on the first summary.
export async function inspectArchive({ source }) {
  const full = path.resolve(source);
  const stat = await statOrNull(full);
  if (stat === null) throw new ValidationError(`archive not found: ${full}`, 'BACKUP_NOT_FOUND');
  if (!stat.isFile()) throw new ValidationError(`not a file: ${full}`, 'BACKUP_NOT_A_FILE');
  if (stat.size > MAX_ARCHIVE_BYTES) {
    throw new ValidationError(`the archive is ${stat.size} bytes, above the ${MAX_ARCHIVE_BYTES}-byte read bound`, 'BACKUP_TOO_LARGE');
  }
  let buffer;
  try {
    buffer = await fs.readFile(full);
  } catch (err) {
    throw new StoreError(`cannot read the archive: ${err?.code || err?.message}`);
  }
  const problems = [];
  let archive;
  try {
    archive = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ValidationError('the archive is not valid JSON, so nothing can be restored from it', 'BACKUP_INVALID');
  }
  if (!archive || typeof archive !== 'object' || Array.isArray(archive)) {
    throw new ValidationError('the archive is not an object, so nothing can be restored from it', 'BACKUP_INVALID');
  }
  if (archive.format !== ARCHIVE_FORMAT) problems.push(`not an APEX backup (format ${JSON.stringify(archive.format)})`);
  if (archive.version !== ARCHIVE_VERSION) problems.push(`unsupported archive version ${JSON.stringify(archive.version)}; this build reads version ${ARCHIVE_VERSION}`);
  if (typeof archive.createdAt !== 'string' || Number.isNaN(Date.parse(archive.createdAt))) problems.push('createdAt is not a readable timestamp');
  if (typeof archive.appVersion !== 'string' || archive.appVersion.length > 100) problems.push('appVersion is missing or too long');
  const manifest = Array.isArray(archive.files) ? archive.files : null;
  if (manifest === null) problems.push('files is not a list');
  const contents = archive.contents && typeof archive.contents === 'object' && !Array.isArray(archive.contents) ? archive.contents : null;
  if (contents === null) problems.push('contents is not an object');
  const files = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const entry of manifest ?? []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push('a file entry is not an object');
      continue;
    }
    const { name, bytes, sha256: digest } = entry;
    if (typeof name !== 'string' || !DATA_FILES.includes(name)) {
      problems.push(`unknown file ${JSON.stringify(name)}`);
      continue;
    }
    if (seen.has(name)) {
      problems.push(`${name} appears more than once`);
      continue;
    }
    seen.add(name);
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_FILE_BYTES) {
      problems.push(`${name} has an unacceptable byte length`);
      continue;
    }
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      problems.push(`${name} has no valid SHA-256`);
      continue;
    }
    const text = contents?.[name];
    if (typeof text !== 'string') {
      problems.push(`${name} has no stored content`);
      continue;
    }
    if (Buffer.byteLength(text, 'utf8') !== bytes) {
      problems.push(`${name} does not match its recorded byte length`);
      continue;
    }
    if (sha256(text) !== digest) {
      problems.push(`${name} does not match its recorded SHA-256`);
      continue;
    }
    totalBytes += bytes;
    const counts = JSONL_FILES.has(name) ? lineCounts(text) : { lines: null, unparsed: null };
    files.push({ name, bytes, sha256: digest, text, lines: counts.lines, unparsed: counts.unparsed });
  }
  if (contents) {
    for (const name of Object.keys(contents)) {
      if (!DATA_FILES.includes(name)) problems.push(`contents holds an unknown file ${JSON.stringify(name)}`);
    }
  }
  if (totalBytes > MAX_TOTAL_BYTES) problems.push(`stored content totals ${totalBytes} bytes, above the ${MAX_TOTAL_BYTES}-byte bound`);
  const archiveSha256 = manifestDigest({
    createdAt: typeof archive.createdAt === 'string' ? archive.createdAt : '',
    appVersion: typeof archive.appVersion === 'string' ? archive.appVersion : '',
    files: (manifest ?? []).filter((entry) => entry && typeof entry === 'object' && typeof entry.name === 'string'),
  });
  if (typeof archive.archiveSha256 === 'string' && archive.archiveSha256 !== archiveSha256) {
    problems.push('the archive digest does not match its manifest');
  }
  return {
    path: full,
    archive: { createdAt: archive.createdAt ?? null, appVersion: archive.appVersion ?? null },
    archiveSha256,
    size: buffer.length,
    totalBytes,
    files,
    problems,
    ok: problems.length === 0,
  };
}

async function listExisting(dataDir, names) {
  const found = [];
  for (const name of names) {
    if (await statOrNull(path.join(dataDir, name)) !== null) found.push(name);
  }
  return found;
}

async function writeSafetyCopy(dataDir, now, operationId, appVersion) {
  const directory = path.join(dataDir, PRE_RESTORE_DIR);
  try {
    await fs.mkdir(directory, { recursive: true });
  } catch (err) {
    throw new StoreError(`cannot create the pre-restore archive directory: ${err?.code || err?.message}`);
  }
  const stamp = now().toISOString().replace(/[-:.]/g, '');
  const suffix = operationId ? String(operationId).replace(/[^A-Za-z0-9-]/g, '').slice(0, 32) : randomUUID();
  const destination = path.join(directory, `pre-restore-${stamp}-${suffix}.json`);
  const { text } = await buildArchive({ dataDir, now, appVersion });
  await writeAtomic(destination, text);
  return destination;
}

export async function restoreArchive({
  dataDir,
  source,
  confirm,
  replaceExisting = false,
  now = () => new Date(),
  operationId = null,
  appVersion,
}) {
  const loaded = await inspectArchive({ source });
  if (!loaded.ok) {
    throw new ValidationError(`the archive cannot be restored: ${describeProblems(loaded.problems)}`, 'BACKUP_INVALID');
  }
  const given = typeof confirm === 'string' ? confirm.trim().toLowerCase() : '';
  if (!new RegExp(`^[0-9a-f]{${CONFIRMATION_MIN_CHARS},64}$`).test(given) || !loaded.archiveSha256.startsWith(given)) {
    throw new ValidationError(
      `confirmation does not match this archive; inspect it and pass at least the first ${CONFIRMATION_MIN_CHARS} characters of its digest (${loaded.archiveSha256.slice(0, 12)}...)`,
      'BACKUP_CONFIRMATION_REQUIRED',
    );
  }
  const busy = await listExisting(dataDir, DATA_FILES.map((name) => `${name}.lock`));
  if (busy.length > 0) {
    throw new StoreError(`a store lock is present (${busy.join(', ')}), so another APEX process may be writing; stop it and retry`, 'BACKUP_STORE_BUSY');
  }

  const replace = [];
  const unchanged = [];
  for (const file of loaded.files) {
    const full = path.join(dataDir, file.name);
    let current = null;
    try {
      current = await fs.readFile(full);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw new StoreError(`cannot read ${file.name}: ${err?.code || err?.message}`);
    }
    if (current !== null && sha256(current) === file.sha256) unchanged.push(file.name);
    else replace.push(file);
  }
  const archived = new Set(loaded.files.map((file) => file.name));
  const leftInPlace = await listExisting(dataDir, DATA_FILES.filter((name) => !archived.has(name)));
  if (replace.length > 0 && !replaceExisting) {
    throw new ValidationError(
      `restoring would replace ${replace.length} existing file(s) (${replace.map((file) => file.name).join(', ')}); pass replaceExisting to replace them - a pre-restore archive is written first`,
      'BACKUP_REPLACE_REQUIRED',
    );
  }

  let safetyPath = null;
  if (replace.length > 0) safetyPath = await writeSafetyCopy(dataDir, now, operationId, appVersion);

  const staged = [];
  try {
    for (const file of loaded.files) {
      const full = path.join(dataDir, file.name);
      const temp = `${full}.restore-${operationId ? String(operationId).replace(/[^A-Za-z0-9-]/g, '').slice(0, 32) : randomUUID()}`;
      await writeAtomic(temp, file.text);
      staged.push({ file, temp, full });
    }
  } catch (err) {
    await Promise.all(staged.map((entry) => fs.unlink(entry.temp).catch(() => {})));
    throw new StoreError(`staging the archive failed, so no file was replaced: ${err?.message ?? String(err)}`);
  }

  const applied = [];
  try {
    for (const entry of staged) {
      await fs.rename(entry.temp, entry.full);
      applied.push(entry.file.name);
    }
  } catch (err) {
    await Promise.all(staged.filter((entry) => !applied.includes(entry.file.name)).map((entry) => fs.unlink(entry.temp).catch(() => {})));
    throw new StoreError(
      `restore stopped after replacing ${applied.length} file(s)${applied.length > 0 ? ` (${applied.join(', ')})` : ''}; ${safetyPath === null ? 'no pre-restore archive was needed because nothing existed before' : `the pre-restore archive at "${safetyPath}" holds what was there before`}: ${err?.code || err?.message}`,
      'BACKUP_RESTORE_PARTIAL',
    );
  }

  for (const file of loaded.files) {
    let current;
    try {
      current = await fs.readFile(path.join(dataDir, file.name));
    } catch (err) {
      throw new StoreError(`restored ${file.name} cannot be read back: ${err?.code || err?.message}`, 'BACKUP_RESTORE_MISMATCH');
    }
    if (sha256(current) !== file.sha256) {
      throw new StoreError(`restored ${file.name} does not match the archive; the pre-restore archive at "${safetyPath}" holds what was there before`, 'BACKUP_RESTORE_MISMATCH');
    }
  }

  return {
    source: loaded.path,
    archiveSha256: loaded.archiveSha256,
    archiveCreatedAt: loaded.archive.createdAt,
    safetyPath,
    replaced: replace.map((file) => file.name),
    unchanged,
    leftInPlace,
    files: loaded.files.map(({ name, bytes, sha256: digest, lines, unparsed }) => ({ name, bytes, sha256: digest, lines, unparsed })),
  };
}

// Independent read-back for the action's verifier. It re-opens what the archive says restore wrote
// and compares digests; it is not the same object the restore returned.
export async function verifyRestored({ dataDir, files }) {
  const problems = [];
  for (const file of files ?? []) {
    let buffer;
    try {
      buffer = await fs.readFile(path.join(dataDir, file.name));
    } catch (err) {
      problems.push(`${file.name} cannot be read back (${err?.code || err?.message})`);
      continue;
    }
    if (sha256(buffer) !== file.sha256) problems.push(`${file.name} does not match the archive digest`);
  }
  return { ok: problems.length === 0, problems };
}
