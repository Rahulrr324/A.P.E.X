// Workspace assistance: bounded discovery, deterministic summarisation, file comparison,
// a directory report, and an explicitly authorized create-or-replace write.
//
// Every action here is user-origin only. Read actions never execute or change anything;
// the write action is create-only unless the caller supplies the exact hash of the file
// it intends to replace, so a stale edit can never silently overwrite another change.
// The authorized root is captured in these closures by app.js and is never an input.
//
// Guarantees shared with actions.js: containment is checked before every fs call; reads
// and scans are bounded; symlinks are refused at the requested path and never followed
// while scanning; errors do not include absolute paths; and every action verifies its
// own reported result against the filesystem independently of execute().
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ValidationError, ExecutionError } from '../errors.js';
import { resolveInside, resolveNewFile, hasControlChars } from './path.js';
import { workspaceField } from './roots.js';
import { lifecycleActions, TRASH_DIR } from './lifecycle.js';
import { extractDocument, detectFormat, MAX_DOCUMENT_BYTES, MAX_EXTRACTED_CHARS } from './documents.js';
import { singleLine } from '../util.js';
import { ORIGIN_USER } from '../actions/origins.js';

export const MAX_FIND_LIMIT = 500;
export const DEFAULT_FIND_LIMIT = 100;
export const MAX_SCAN_ENTRIES = 10_000;
export const MAX_SCAN_DEPTH = 12;
export const MAX_COMPARE_BYTES = 512 * 1024;
export const MAX_WRITE_BYTES = 1_048_576;
export const MAX_REPORT_FILES = 50;

const DOCUMENT_LIMITATION_NOTE = 'A deterministic extraction, not an interpretation: it reads what the document format exposes and does not execute embedded content.';

// Extracted text can carry bytes that were never meant for a terminal (a PDF octal
// escape, a quoted CSV field). Display keeps newlines and tabs and replaces the rest.
function displayText(text) {
  return String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?');
}

const NON_TEXT_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const decoder = new TextDecoder('utf-8', { fatal: true });

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was',
  'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now',
  'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'she', 'use', 'with', 'this', 'that', 'from',
  'they', 'have', 'were', 'been', 'will', 'each', 'more', 'than', 'into', 'when', 'what', 'then',
  'them', 'some', 'such', 'only', 'over', 'also', 'back', 'after', 'would', 'there', 'their',
  'about', 'which', 'because', 'while', 'where', 'these', 'those', 'being', 'before', 'under',
  'between', 'through', 'should', 'could', 'other', 'first', 'very', 'much', 'many', 'still',
  'just', 'like', 'make', 'made', 'does', 'most', 'even', 'well', 'here', 'both', 'same',
]);

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

export function pathField(value, name = 'path') {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const t = value.trim();
  if (t.length === 0) throw new ValidationError(`${name} is empty`);
  if (hasControlChars(t)) throw new ValidationError(`${name} contains control characters`);
  return t;
}

export function optionalPath(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return pathField(value);
}

export function displaySafe(text, max = 160) {
  return String(text).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, max);
}

export function ioCode(err) {
  const code = err?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'PERMISSION_DENIED';
  if (code === 'ENOENT') return 'PATH_NOT_FOUND';
  if (code === 'ELOOP') return 'TOO_MANY_LINKS';
  if (code === 'EEXIST') return 'FILE_EXISTS';
  return 'IO_ERROR';
}

export function resolveForAction(root, inputPath) {
  const resolved = resolveInside(root, inputPath);
  if (resolved.isLink) {
    throw new ExecutionError('SYMLINK_REFUSED', 'refusing to follow a symbolic link');
  }
  return resolved.realPath;
}

export function readBuf(file, limit) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    throw new ExecutionError(ioCode(err), `file cannot be inspected (${err?.code ?? 'error'})`);
  }
  if (!stat.isFile()) throw new ExecutionError('NOT_A_REGULAR_FILE', 'path is not a regular file');
  if (stat.size > limit) {
    throw new ExecutionError('FILE_TOO_LARGE', `file is ${stat.size} bytes; the limit is ${limit}`);
  }
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    throw new ExecutionError(ioCode(err), `file cannot be read (${err?.code ?? 'error'})`);
  }
  if (buf.length > limit) {
    throw new ExecutionError('FILE_TOO_LARGE', `file grew to ${buf.length} bytes; the limit is ${limit}`);
  }
  return buf;
}

export function decodeText(buf) {
  let text;
  try {
    text = decoder.decode(buf);
  } catch {
    throw new ExecutionError('FILE_NOT_TEXT', 'file is not valid UTF-8 text');
  }
  if (NON_TEXT_CHARS.test(text)) {
    throw new ExecutionError('FILE_NOT_TEXT', 'file contains binary control characters');
  }
  return text;
}

export function relativeTo(root, full) {
  return path.relative(root, full).split(path.sep).join('/');
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// ---- filesystem.find --------------------------------------------------------

function findEntries(root, startDir, { name = null, extension = null, maxDepth, maxScan }) {
  const needle = name === null ? null : name.toLowerCase();
  const ext = extension === null ? null : extension.toLowerCase().replace(/^\./, '');
  const matches = [];
  const stack = [{ dir: startDir, depth: 0 }];
  let scanned = 0;
  let skippedLinks = 0;
  let unreadable = 0;
  let truncated = false;

  while (stack.length > 0 && !truncated) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true }).sort(byName);
    } catch {
      unreadable += 1;
      continue;
    }
    const subdirectories = [];
    for (const dirent of dirents) {
      if (scanned >= maxScan) {
        truncated = true;
        break;
      }
      scanned += 1;
      const full = path.join(dir, dirent.name);
      const rel = relativeTo(root, full);
      const type = dirent.isSymbolicLink()
        ? 'link'
        : dirent.isDirectory()
          ? 'directory'
          : dirent.isFile()
            ? 'file'
            : 'other';
      // A deleted entry is quarantined, not gone; it stays out of ordinary discovery so a
      // scan does not report what the user asked to remove. "workspace trash" is the view
      // for it, and naming the directory directly still reaches it.
      if (type === 'directory' && depth === 0 && dirent.name === TRASH_DIR) continue;
      if (type === 'link') skippedLinks += 1;
      if (type === 'directory') subdirectories.push({ dir: full, depth: depth + 1 });
      const entryExt = type === 'file' ? path.extname(dirent.name).toLowerCase().replace(/^\./, '') : '';
      const nameOk = needle === null || dirent.name.toLowerCase().includes(needle);
      const extOk = ext === null || entryExt === ext;
      if (nameOk && extOk) {
        let size = null;
        if (type === 'file') {
          try {
            size = fs.statSync(full).size;
          } catch {
            size = null;
          }
        }
        matches.push({ path: rel, name: dirent.name, type, size });
      }
    }
    for (let i = subdirectories.length - 1; i >= 0; i -= 1) stack.push(subdirectories[i]);
  }
  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { matches, scanned, skippedLinks, unreadable, truncated };
}

export function findAction(roots, { maxScan = MAX_SCAN_ENTRIES, defaultLimit = DEFAULT_FIND_LIMIT, maxLimit = MAX_FIND_LIMIT } = {}) {
  const scanCap = Math.min(maxScan, MAX_SCAN_ENTRIES);
  const limitCap = Math.min(maxLimit, MAX_FIND_LIMIT);
  return {
    name: 'filesystem.find',
    description: 'Find files or directories by name or extension inside an authorized workspace root. Bounded, read-only, never follows links.',
    inputHint: `{"path": optional "relative/dir", "workspace": optional root name, "name": optional text, "extension": optional "txt", "maxDepth": optional 1-${MAX_SCAN_DEPTH}, "limit": optional 1-${limitCap}}`,
    permission: 'read',
    origins: [ORIGIN_USER],
    validate(input) {
      const o = expectObject(input, ['path', 'workspace', 'name', 'extension', 'maxDepth', 'limit']);
      let name = null;
      if (o.name !== undefined) {
        name = pathField(o.name, 'name');
        if (name.length > 200) throw new ValidationError('name exceeds 200 characters');
      }
      let extension = null;
      if (o.extension !== undefined) {
        extension = pathField(o.extension, 'extension').replace(/^\./, '');
        if (!/^[A-Za-z0-9_+-]{1,16}$/.test(extension)) throw new ValidationError('extension must be 1-16 letters, digits, "_", "+", or "-"');
      }
      let maxDepth = 6;
      if (o.maxDepth !== undefined) {
        if (!Number.isInteger(o.maxDepth) || o.maxDepth < 1 || o.maxDepth > MAX_SCAN_DEPTH) {
          throw new ValidationError(`maxDepth must be an integer from 1 to ${MAX_SCAN_DEPTH}`);
        }
        maxDepth = o.maxDepth;
      }
      let limit = defaultLimit;
      if (o.limit !== undefined) {
        if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > limitCap) {
          throw new ValidationError(`limit must be an integer from 1 to ${limitCap}`);
        }
        limit = o.limit;
      }
      return { path: optionalPath(o.path, '.'), workspace: workspaceField(o.workspace, roots), name, extension, maxDepth, limit };
    },
    async execute(_ctx, { path: inputPath, workspace, name, extension, maxDepth, limit }) {
      const root = roots.pick(workspace);
      const dir = resolveForAction(root, inputPath);
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch (err) {
        throw new ExecutionError(ioCode(err), `directory cannot be inspected (${err?.code ?? 'error'})`);
      }
      if (!stat.isDirectory()) throw new ExecutionError('NOT_A_DIRECTORY', 'path is not a directory');
      const found = findEntries(root, dir, { name, extension, maxDepth, maxScan: scanCap });
      const shown = found.matches.slice(0, limit);
      const truncated = found.truncated || found.matches.length > shown.length;
      const criteria = [
        name === null ? null : `name containing "${displaySafe(name)}"`,
        extension === null ? null : `extension .${extension}`,
      ].filter(Boolean).join(' and ') || 'any entry';
      const lines = shown.map((entry) => `  ${entry.type === 'directory' ? 'dir ' : entry.type === 'link' ? 'link' : '    '} ${displaySafe(entry.path)}${entry.size === null ? '' : ` (${entry.size} bytes)`}`);
      const notes = [
        found.scanned >= scanCap ? `scan stopped at ${scanCap} entries` : null,
        found.skippedLinks > 0 ? `${found.skippedLinks} link(s) not followed` : null,
        found.unreadable > 0 ? `${found.unreadable} directory(ies) could not be read` : null,
        found.matches.length > shown.length ? `showing ${shown.length} of ${found.matches.length} matches` : null,
      ].filter(Boolean);
      return {
        summary: `${found.matches.length} match(es) for ${criteria} under "${inputPath}"${truncated ? ' (bounded)' : ''}`,
        data: {
          path: inputPath,
          name,
          extension,
          maxDepth,
          limit,
          scanned: found.scanned,
          skippedLinks: found.skippedLinks,
          unreadable: found.unreadable,
          truncated,
          total: found.matches.length,
          matches: shown,
        },
        display: `Matches for ${criteria} under "${inputPath}" (${found.matches.length}):\n${lines.join('\n') || '  (none)'}${notes.length ? `\n  (${notes.join('; ')})` : ''}`,
      };
    },
    async verify(ctx, input, result) {
      try {
        const root = roots.pick(input.workspace);
        const dir = resolveForAction(root, input.path);
        const fresh = findEntries(root, dir, {
          name: input.name,
          extension: input.extension,
          maxDepth: input.maxDepth,
          maxScan: scanCap,
        });
        const claimed = (result.data.matches ?? []).map((entry) => `${entry.type}:${entry.path}`);
        const actual = fresh.matches.slice(0, result.data.limit).map((entry) => `${entry.type}:${entry.path}`);
        if (claimed.length !== actual.length || claimed.some((value, i) => value !== actual[i])) {
          return { ok: false, detail: 'the matching entries differ from an independent scan' };
        }
        if (fresh.unreadable !== result.data.unreadable) {
          return { ok: false, detail: 'the count of unreadable directories differs from an independent scan' };
        }
        return { ok: true, detail: `${claimed.length} match(es) confirmed by an independent scan` };
      } catch (err) {
        return { ok: false, detail: `matches could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

// ---- shared text analysis ---------------------------------------------------

function analyseText(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const words = text.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? [];
  const headings = [];
  for (const line of lines) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) headings.push(displaySafe(m[1], 120));
    if (headings.length >= 20) break;
  }
  const opening = lines.map((line) => line.trim()).filter(Boolean).slice(0, 5).map((line) => displaySafe(line, 200));
  const counts = new Map();
  for (const raw of words) {
    const word = raw.toLowerCase().replace(/^['-]+|['-]+$/g, '');
    if (word.length < 3 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const keywords = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const summary = displaySafe(sentences.slice(0, 3).join(' '), 600);
  return {
    lines: lines.length,
    words: words.length,
    chars: text.length,
    headings,
    opening,
    keywords,
    summary,
  };
}

// ---- filesystem.summarize ---------------------------------------------------

export function summarizeAction(roots, { maxBytes = MAX_DOCUMENT_BYTES } = {}) {
  return {
    name: 'filesystem.summarize',
    description: 'Produce a deterministic extractive summary of one bounded file: text, PDF, DOCX, XLSX or CSV. Counts, headings, opening lines, and frequent terms. Read-only; nothing in a document is executed and no model is consulted.',
    inputHint: `{"path": "relative/file.txt", "workspace": optional root name, "maxBytes": optional 1-${maxBytes}}`,
    permission: 'read',
    origins: [ORIGIN_USER],
    validate(input) {
      const o = expectObject(input, ['path', 'workspace', 'maxBytes']);
      const p = pathField(o.path);
      let limit = maxBytes;
      if (o.maxBytes !== undefined) {
        if (!Number.isInteger(o.maxBytes) || o.maxBytes < 1 || o.maxBytes > maxBytes) {
          throw new ValidationError(`maxBytes must be an integer from 1 to ${maxBytes}`);
        }
        limit = o.maxBytes;
      }
      return { path: p, workspace: workspaceField(o.workspace, roots), maxBytes: limit };
    },
    async execute(_ctx, { path: inputPath, workspace, maxBytes: limit }) {
      const root = roots.pick(workspace);
      const file = resolveForAction(root, inputPath);
      const buf = readBuf(file, limit);
      const document = extractDocument(inputPath, buf);
      const analysis = analyseText(document.text);
      const digest = sha256(buf);
      const facts = [
        document.pages === undefined ? null : `${document.pages} page(s)`,
        document.rows === undefined ? null : `${document.rows} row(s)`,
        document.columns === undefined ? null : `${document.columns} column(s)`,
      ].filter(Boolean).join(', ');
      const lines = [
        `Summary of "${inputPath}" (${document.format}${facts ? `, ${facts}` : ''}; ${buf.length} bytes, sha256 ${digest.slice(0, 16)}…):`,
        `  lines: ${analysis.lines}; words: ${analysis.words}; characters: ${analysis.chars}`,
        `  opening: ${analysis.summary || '(no prose found)'}`,
      ];
      if (analysis.headings.length > 0) lines.push(`  headings: ${analysis.headings.map((h) => displaySafe(h, 80)).join(' | ')}`);
      if (analysis.keywords.length > 0) lines.push(`  frequent terms: ${analysis.keywords.map((k) => `${k.word}(${k.count})`).join(', ')}`);
      if (document.truncated) lines.push(`  (text truncated at ${MAX_EXTRACTED_CHARS} characters)`);
      for (const limitation of document.limitations) lines.push(`  (limitation: ${displaySafe(limitation, 200)})`);
      lines.push('  (deterministic extract; it states what the file contains, not what it means)');
      return {
        summary: `summarized "${inputPath}" (${document.format}): ${analysis.lines} line(s), ${analysis.words} word(s), ${analysis.keywords.length} frequent term(s)`,
        data: {
          path: inputPath,
          format: document.format,
          size: buf.length,
          sha256: digest,
          textSha256: document.textSha256,
          maxBytes: limit,
          truncated: document.truncated,
          limitations: document.limitations,
          ...(document.pages === undefined ? {} : { pages: document.pages }),
          ...(document.rows === undefined ? {} : { rows: document.rows }),
          ...(document.columns === undefined ? {} : { columns: document.columns }),
          ...analysis,
        },
        display: lines.join('\n'),
      };
    },
    async verify(ctx, input, result) {
      try {
        const file = resolveForAction(roots.pick(input.workspace), input.path);
        const fresh = readBuf(file, input.maxBytes);
        if (fresh.length !== result.data.size) {
          return { ok: false, detail: 'file size changed since the summary was produced' };
        }
        if (sha256(fresh) !== result.data.sha256) {
          return { ok: false, detail: 'file content changed since the summary was produced' };
        }
        const document = extractDocument(input.path, fresh);
        if (document.format !== result.data.format) {
          return { ok: false, detail: 'the detected format does not match an independent extraction' };
        }
        if (document.textSha256 !== result.data.textSha256) {
          return { ok: false, detail: 'the extracted text does not match an independent extraction' };
        }
        if (document.truncated !== result.data.truncated) {
          return { ok: false, detail: 'the truncation state does not match an independent extraction' };
        }
        const analysis = analyseText(document.text);
        if (analysis.lines !== result.data.lines || analysis.words !== result.data.words || analysis.chars !== result.data.chars) {
          return { ok: false, detail: 'the reported counts do not match the file' };
        }
        if (analysis.summary !== result.data.summary) {
          return { ok: false, detail: 'the reported extract does not match the file' };
        }
        if (JSON.stringify(analysis.keywords) !== JSON.stringify(result.data.keywords)) {
          return { ok: false, detail: 'the reported frequent terms do not match the file' };
        }
        return { ok: true, detail: `${fresh.length} bytes confirmed; ${document.format} text and counts recomputed from an independent read` };
      } catch (err) {
        return { ok: false, detail: `summary could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

// ---- filesystem.extract -----------------------------------------------------

// The extracted text is shown in full to the terminal but is not written into the
// operation record: the data carries the format, bounds, and text hash instead.
export function extractAction(roots, { maxBytes = MAX_DOCUMENT_BYTES } = {}) {
  return {
    name: 'filesystem.extract',
    description: 'Extract bounded text from a PDF, DOCX, XLSX, CSV or UTF-8 text file inside an authorized workspace root. Read-only; embedded content is never executed and no model is consulted.',
    inputHint: `{"path": "relative/report.pdf", "workspace": optional root name, "maxBytes": optional 1-${maxBytes}}`,
    permission: 'read',
    origins: [ORIGIN_USER],
    validate(input) {
      const o = expectObject(input, ['path', 'workspace', 'maxBytes']);
      const p = pathField(o.path);
      let limit = maxBytes;
      if (o.maxBytes !== undefined) {
        if (!Number.isInteger(o.maxBytes) || o.maxBytes < 1 || o.maxBytes > maxBytes) {
          throw new ValidationError(`maxBytes must be an integer from 1 to ${maxBytes}`);
        }
        limit = o.maxBytes;
      }
      return { path: p, workspace: workspaceField(o.workspace, roots), maxBytes: limit };
    },
    async execute(_ctx, { path: inputPath, workspace, maxBytes: limit }) {
      const root = roots.pick(workspace);
      const file = resolveForAction(root, inputPath);
      const buf = readBuf(file, limit);
      const document = extractDocument(inputPath, buf);
      const digest = sha256(buf);
      const facts = [
        document.pages === undefined ? null : `${document.pages} page(s)`,
        document.rows === undefined ? null : `${document.rows} row(s)`,
        document.columns === undefined ? null : `${document.columns} column(s)`,
      ].filter(Boolean).join(', ');
      const lines = [
        `Extracted ${document.chars} character(s) from "${inputPath}" (${document.format}${facts ? `, ${facts}` : ''}; ${buf.length} bytes, sha256 ${digest.slice(0, 16)}…):`,
      ];
      if (document.text.length === 0) lines.push('  (no text could be extracted)');
      else lines.push(displayText(document.text));
      if (document.truncated) lines.push(`  (text truncated at ${MAX_EXTRACTED_CHARS} characters)`);
      for (const limitation of document.limitations) lines.push(`  (limitation: ${displaySafe(limitation, 200)})`);
      lines.push(`  (${DOCUMENT_LIMITATION_NOTE})`);
      return {
        summary: `extracted ${document.chars} character(s) from "${inputPath}" (${document.format})`,
        data: {
          path: inputPath,
          format: document.format,
          size: buf.length,
          sha256: digest,
          textSha256: document.textSha256,
          chars: document.chars,
          words: document.words,
          lines: document.lines,
          truncated: document.truncated,
          limitations: document.limitations,
          maxBytes: limit,
          ...(document.pages === undefined ? {} : { pages: document.pages }),
          ...(document.rows === undefined ? {} : { rows: document.rows }),
          ...(document.columns === undefined ? {} : { columns: document.columns }),
        },
        display: lines.join('\n'),
      };
    },
    async verify(ctx, input, result) {
      try {
        const file = resolveForAction(roots.pick(input.workspace), input.path);
        const fresh = readBuf(file, input.maxBytes);
        if (fresh.length !== result.data.size) {
          return { ok: false, detail: 'file size changed since the extraction' };
        }
        if (sha256(fresh) !== result.data.sha256) {
          return { ok: false, detail: 'file content changed since the extraction' };
        }
        const document = extractDocument(input.path, fresh);
        for (const field of ['format', 'textSha256', 'chars', 'words', 'lines', 'truncated']) {
          if (document[field] !== result.data[field]) {
            return { ok: false, detail: `the extracted ${field} does not match an independent extraction` };
          }
        }
        return { ok: true, detail: `${document.chars} character(s) from ${document.format} confirmed by an independent extraction` };
      } catch (err) {
        return { ok: false, detail: `extraction could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

// ---- filesystem.compare -----------------------------------------------------

function compareText(textA, textB, sampleLimit) {
  const linesA = textA.split(/\r\n|\r|\n/);
  const linesB = textB.split(/\r\n|\r|\n/);
  const common = Math.min(linesA.length, linesB.length);
  const samples = [];
  let differing = 0;
  for (let i = 0; i < common; i += 1) {
    if (linesA[i] === linesB[i]) continue;
    differing += 1;
    if (samples.length < sampleLimit) {
      samples.push({
        line: i + 1,
        a: displaySafe(linesA[i], 200),
        b: displaySafe(linesB[i], 200),
      });
    }
  }
  return {
    identical: textA === textB,
    aLines: linesA.length,
    bLines: linesB.length,
    differingLines: differing,
    aOnlyLines: Math.max(0, linesA.length - common),
    bOnlyLines: Math.max(0, linesB.length - common),
    samples,
    sampleTruncated: differing > samples.length,
    // Named honestly: this pairs lines by position. It is not an edit script and does not
    // claim a minimal set of changes.
    method: 'positional line comparison',
  };
}

export function compareAction(roots, { maxBytes = MAX_COMPARE_BYTES } = {}) {
  return {
    name: 'filesystem.compare',
    description: 'Compare two bounded UTF-8 text files inside an authorized workspace root by position: identity, sizes, hashes, differing lines, and extra trailing lines. Read-only.',
    inputHint: `{"a": "relative/file-a.txt", "b": "relative/file-b.txt", "workspace": optional root name, "maxBytes": optional 1-${maxBytes}}`,
    permission: 'read',
    origins: [ORIGIN_USER],
    validate(input) {
      const o = expectObject(input, ['a', 'b', 'workspace', 'maxBytes']);
      const a = pathField(o.a, 'a');
      const b = pathField(o.b, 'b');
      let limit = maxBytes;
      if (o.maxBytes !== undefined) {
        if (!Number.isInteger(o.maxBytes) || o.maxBytes < 1 || o.maxBytes > maxBytes) {
          throw new ValidationError(`maxBytes must be an integer from 1 to ${maxBytes}`);
        }
        limit = o.maxBytes;
      }
      return { a, b, workspace: workspaceField(o.workspace, roots), maxBytes: limit };
    },
    async execute(_ctx, { a, b, workspace, maxBytes: limit }) {
      const root = roots.pick(workspace);
      const fileA = resolveForAction(root, a);
      const fileB = resolveForAction(root, b);
      const bufA = readBuf(fileA, limit);
      const bufB = readBuf(fileB, limit);
      const textA = decodeText(bufA);
      const textB = decodeText(bufB);
      const cmp = compareText(textA, textB, 10);
      const first = cmp.samples[0];
      const lines = [
        `Comparing "${a}" with "${b}" (${cmp.method}):`,
        `  ${cmp.identical ? 'the files are identical' : 'the files differ'}`,
        `  a: ${bufA.length} bytes, ${cmp.aLines} line(s), sha256 ${sha256(bufA).slice(0, 16)}…`,
        `  b: ${bufB.length} bytes, ${cmp.bLines} line(s), sha256 ${sha256(bufB).slice(0, 16)}…`,
      ];
      if (!cmp.identical) {
        lines.push(`  differing lines: ${cmp.differingLines}; only in a: ${cmp.aOnlyLines}; only in b: ${cmp.bOnlyLines}`);
        if (first) lines.push(`  first difference at line ${first.line}: a="${first.a}" b="${first.b}"`);
        if (cmp.sampleTruncated) lines.push('  (first 10 differences shown)');
      }
      return {
        summary: cmp.identical ? `"${a}" and "${b}" are identical` : `"${a}" and "${b}" differ at ${cmp.differingLines} line(s)`,
        data: {
          a: { path: a, size: bufA.length, sha256: sha256(bufA) },
          b: { path: b, size: bufB.length, sha256: sha256(bufB) },
          maxBytes: limit,
          ...cmp,
        },
        display: lines.join('\n'),
      };
    },
    async verify(ctx, input, result) {
      try {
        const rootNow = roots.pick(input.workspace);
        const fileA = resolveForAction(rootNow, input.a);
        const fileB = resolveForAction(rootNow, input.b);
        const bufA = readBuf(fileA, input.maxBytes);
        const bufB = readBuf(fileB, input.maxBytes);
        if (sha256(bufA) !== result.data.a.sha256) return { ok: false, detail: 'file a changed since the comparison' };
        if (sha256(bufB) !== result.data.b.sha256) return { ok: false, detail: 'file b changed since the comparison' };
        const cmp = compareText(decodeText(bufA), decodeText(bufB), 10);
        if (cmp.identical !== result.data.identical) return { ok: false, detail: 'the identity result does not match an independent comparison' };
        if (cmp.differingLines !== result.data.differingLines) return { ok: false, detail: 'the differing-line count does not match an independent comparison' };
        return { ok: true, detail: 'both files re-read; identity and difference counts confirmed' };
      } catch (err) {
        return { ok: false, detail: `comparison could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

// ---- filesystem.report ------------------------------------------------------

function scanReport(root, startDir, { maxDepth, maxScan, largestLimit }) {
  const totals = {
    files: 0, directories: 0, links: 0, other: 0, bytes: 0, unreadable: 0, scanned: 0, truncated: false,
  };
  const extensions = new Map();
  const largest = [];
  const newest = [];
  const stack = [{ dir: startDir, depth: 0 }];
  while (stack.length > 0 && !totals.truncated) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true }).sort(byName);
    } catch {
      totals.unreadable += 1;
      continue;
    }
    const subdirectories = [];
    for (const dirent of dirents) {
      if (totals.scanned >= maxScan) {
        totals.truncated = true;
        break;
      }
      totals.scanned += 1;
      const full = path.join(dir, dirent.name);
      if (dirent.isSymbolicLink()) {
        totals.links += 1;
        continue;
      }
      if (dirent.isDirectory()) {
        if (depth === 0 && dirent.name === TRASH_DIR) continue;
        totals.directories += 1;
        subdirectories.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!dirent.isFile()) {
        totals.other += 1;
        continue;
      }
      totals.files += 1;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        totals.unreadable += 1;
        continue;
      }
      const rel = relativeTo(root, full);
      totals.bytes += stat.size;
      const ext = path.extname(dirent.name).toLowerCase().replace(/^\./, '') || '(none)';
      extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
      largest.push({ path: rel, size: stat.size });
      newest.push({ path: rel, modifiedAt: stat.mtime.toISOString() });
    }
    for (let i = subdirectories.length - 1; i >= 0; i -= 1) stack.push(subdirectories[i]);
  }
  largest.sort((a, b) => (b.size - a.size) || (a.path < b.path ? -1 : 1));
  newest.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
  const extensionRows = [...extensions.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .slice(0, 15)
    .map(([extension, count]) => ({ extension, count }));
  return {
    ...totals,
    extensions: extensionRows,
    largest: largest.slice(0, largestLimit),
    newest: newest.slice(0, 5),
  };
}

export function reportAction(roots, { maxScan = MAX_SCAN_ENTRIES, maxDepth = MAX_SCAN_DEPTH } = {}) {
  const scanCap = Math.min(maxScan, MAX_SCAN_ENTRIES);
  const depthCap = Math.min(maxDepth, MAX_SCAN_DEPTH);
  return {
    name: 'filesystem.report',
    description: 'Bounded overview of a directory inside an authorized workspace root: file and directory counts, total size, extensions, largest and newest files. Read-only; links are counted, never followed.',
    inputHint: `{"path": optional "relative/dir", "workspace": optional root name, "maxDepth": optional 1-${depthCap}, "limit": optional 1-${MAX_REPORT_FILES}}`,
    permission: 'read',
    origins: [ORIGIN_USER],
    validate(input) {
      const o = expectObject(input, ['path', 'workspace', 'maxDepth', 'limit']);
      let maxDepthValue = 4;
      if (o.maxDepth !== undefined) {
        if (!Number.isInteger(o.maxDepth) || o.maxDepth < 1 || o.maxDepth > depthCap) {
          throw new ValidationError(`maxDepth must be an integer from 1 to ${depthCap}`);
        }
        maxDepthValue = o.maxDepth;
      }
      let limit = 10;
      if (o.limit !== undefined) {
        if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > MAX_REPORT_FILES) {
          throw new ValidationError(`limit must be an integer from 1 to ${MAX_REPORT_FILES}`);
        }
        limit = o.limit;
      }
      return { path: optionalPath(o.path, '.'), workspace: workspaceField(o.workspace, roots), maxDepth: maxDepthValue, limit };
    },
    async execute(_ctx, { path: inputPath, workspace, maxDepth: depth, limit }) {
      const root = roots.pick(workspace);
      const dir = resolveForAction(root, inputPath);
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch (err) {
        throw new ExecutionError(ioCode(err), `directory cannot be inspected (${err?.code ?? 'error'})`);
      }
      if (!stat.isDirectory()) throw new ExecutionError('NOT_A_DIRECTORY', 'path is not a directory');
      const report = scanReport(root, dir, { maxDepth: depth, maxScan: scanCap, largestLimit: limit });
      const lines = [
        `Workspace report for "${inputPath}" (depth ${depth}):`,
        `  ${report.files} file(s), ${report.directories} director(ies), ${report.links} link(s) not followed, ${report.bytes} bytes total`,
        report.extensions.length > 0 ? `  by extension: ${report.extensions.map((e) => `${e.extension}(${e.count})`).join(', ')}` : '  by extension: none',
        report.largest.length > 0 ? `  largest: ${report.largest.map((f) => `${displaySafe(f.path, 80)} (${f.size})`).join(', ')}` : '  largest: none',
        report.newest.length > 0 ? `  newest: ${report.newest.map((f) => displaySafe(f.path, 80)).join(', ')}` : '  newest: none',
      ];
      if (report.truncated) lines.push(`  (scan stopped at ${scanCap} entries)`);
      if (report.unreadable > 0) lines.push(`  (${report.unreadable} entry(ies) could not be inspected)`);
      return {
        summary: `workspace report for "${inputPath}": ${report.files} file(s), ${report.directories} director(ies), ${report.bytes} bytes`,
        data: { path: inputPath, maxDepth: depth, limit, ...report },
        display: lines.join('\n'),
      };
    },
    async verify(ctx, input, result) {
      try {
        const root = roots.pick(input.workspace);
        const dir = resolveForAction(root, input.path);
        const fresh = scanReport(root, dir, {
          maxDepth: input.maxDepth,
          maxScan: scanCap,
          largestLimit: input.limit,
        });
        for (const field of ['files', 'directories', 'links', 'other', 'bytes', 'scanned', 'truncated', 'unreadable']) {
          if (fresh[field] !== result.data[field]) {
            return { ok: false, detail: `the ${field} count differs from an independent scan` };
          }
        }
        if (JSON.stringify(fresh.largest.map((f) => f.path)) !== JSON.stringify(result.data.largest.map((f) => f.path))) {
          return { ok: false, detail: 'the largest files differ from an independent scan' };
        }
        return { ok: true, detail: `${fresh.files} file(s) and ${fresh.directories} director(ies) confirmed by an independent scan` };
      } catch (err) {
        return { ok: false, detail: `report could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

// ---- filesystem.write -------------------------------------------------------

function writeBytes(content) {
  if (typeof content !== 'string') throw new ValidationError('content must be text');
  if (content.length === 0) throw new ValidationError('content is empty');
  if (hasControlChars(content) && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
    throw new ValidationError('content contains control characters other than tab and newline');
  }
  const buf = Buffer.from(content, 'utf8');
  if (buf.length > MAX_WRITE_BYTES) {
    throw new ValidationError(`content is ${buf.length} bytes; the limit is ${MAX_WRITE_BYTES}`);
  }
  return buf;
}

// Writes to a private file in the target's directory, flushes it, and only then publishes
// it. A create uses an exclusive copy so a file that appeared meanwhile is never replaced;
// a replace re-reads the current hash immediately before the rename and refuses if it moved.
// The remaining check-to-rename window cannot be closed without an OS file lock; the
// verification re-reads the published bytes and reports what is actually there.
function publish(root, inputPath, buf, { expectedSha256, create }) {
  const resolved = create ? resolveNewFile(root, inputPath) : null;
  if (create && resolved.exists) {
    throw new ExecutionError('FILE_EXISTS', 'the target already exists; supply expectedSha256 to replace it');
  }
  const target = create ? resolved.targetPath : resolveForAction(root, inputPath);
  const parent = path.dirname(target);
  let previousSha256 = null;
  if (!create) {
    if (expectedSha256 === null) {
      throw new ValidationError('expectedSha256 is required to replace an existing file');
    }
    let stat;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      throw new ExecutionError(ioCode(err), `target cannot be inspected (${err?.code ?? 'error'})`);
    }
    if (!stat.isFile()) throw new ExecutionError('NOT_A_REGULAR_FILE', 'target is not a regular file');
    if (stat.size > MAX_WRITE_BYTES) {
      throw new ExecutionError('FILE_TOO_LARGE', `target is ${stat.size} bytes; the limit is ${MAX_WRITE_BYTES}`);
    }
    let current;
    try {
      current = fs.readFileSync(target);
    } catch (err) {
      throw new ExecutionError(ioCode(err), `target cannot be read (${err?.code ?? 'error'})`);
    }
    previousSha256 = sha256(current);
    if (previousSha256 !== expectedSha256) {
      throw new ExecutionError('HASH_MISMATCH', 'the file has changed since the expected hash was recorded; nothing was written');
    }
  }
  const temp = path.join(parent, `.${path.basename(target)}.apex-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = fs.openSync(temp, 'wx');
    fs.writeFileSync(handle, buf);
    fs.fsyncSync(handle);
  } catch (err) {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* already closed */ }
      handle = undefined;
    }
    try { fs.rmSync(temp, { force: true }); } catch { /* nothing to remove */ }
    throw new ExecutionError(ioCode(err), `the file could not be staged (${err?.code ?? 'error'})`);
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* already closed */ }
    }
  }
  try {
    if (create) {
      try {
        fs.copyFileSync(temp, target, fs.constants.COPYFILE_EXCL);
      } catch (err) {
        if (err?.code === 'EEXIST') throw new ExecutionError('FILE_EXISTS', 'the target appeared while the file was staged; nothing was overwritten');
        throw new ExecutionError(ioCode(err), `the file could not be created (${err?.code ?? 'error'})`);
      }
      fs.rmSync(temp, { force: true });
    } else {
      const current = fs.readFileSync(target);
      if (sha256(current) !== expectedSha256) {
        throw new ExecutionError('HASH_MISMATCH', 'the file changed while the replacement was staged; nothing was overwritten');
      }
      fs.renameSync(temp, target);
    }
  } catch (err) {
    try { fs.rmSync(temp, { force: true }); } catch { /* nothing to remove */ }
    if (err instanceof ExecutionError) throw err;
    throw new ExecutionError(ioCode(err), `the file could not be published (${err?.code ?? 'error'})`);
  }
  return { target, previousSha256 };
}

export function writeAction(roots, { maxBytes = MAX_WRITE_BYTES } = {}) {
  return {
    name: 'filesystem.write',
    description: 'Create a text file inside an authorized workspace root, or replace one only when the caller supplies its current sha256. Write: user origin only; never overwrites silently and never executes content.',
    inputHint: '{"path": "relative/file.txt", "content": "text", "workspace": optional root name, "expectedSha256": optional "64-hex current hash to replace"}',
    permission: 'write',
    origins: [ORIGIN_USER],
    // A file write is a consequential action the user asked for. It is never offered as a plan
    // step: a plan may only contain actions whose effect is checked before approval, and this
    // action's content is the effect.
    plannable: false,
    validate(input) {
      const o = expectObject(input, ['path', 'content', 'workspace', 'expectedSha256']);
      const p = pathField(o.path);
      const buf = writeBytes(o.content);
      if (buf.length > maxBytes) throw new ValidationError(`content exceeds ${maxBytes} bytes`);
      let expectedSha256 = null;
      if (o.expectedSha256 !== undefined && o.expectedSha256 !== null) {
        if (typeof o.expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(o.expectedSha256.trim())) {
          throw new ValidationError('expectedSha256 must be a 64-character hexadecimal digest');
        }
        expectedSha256 = o.expectedSha256.trim().toLowerCase();
      }
      return { path: p, content: o.content, workspace: workspaceField(o.workspace, roots), expectedSha256, size: buf.length, sha256: sha256(buf) };
    },
    async execute(_ctx, { path: inputPath, content, workspace, expectedSha256 }) {
      const root = roots.pick(workspace);
      const buf = Buffer.from(content, 'utf8');
      const create = expectedSha256 === null;
      const { target, previousSha256 } = publish(root, inputPath, buf, { expectedSha256, create });
      const digest = sha256(buf);
      return {
        summary: create
          ? `created "${inputPath}" (${buf.length} bytes, sha256 ${digest.slice(0, 16)}…)`
          : `replaced "${inputPath}" (${buf.length} bytes, sha256 ${digest.slice(0, 16)}…; previous ${previousSha256.slice(0, 16)}…)`,
        data: {
          path: inputPath,
          mode: create ? 'created' : 'replaced',
          size: buf.length,
          sha256: digest,
          previousSha256,
          relativePath: relativeTo(root, target),
        },
        display: create
          ? `Created "${inputPath}" (${buf.length} bytes, sha256 ${digest}).\nThe content was written by you, is not executed, and can be read back with "read ${inputPath}".`
          : `Replaced "${inputPath}" after its current hash matched (${buf.length} bytes, sha256 ${digest}; previous ${previousSha256}).\nThe previous content is not preserved by this action; it was replaced because you supplied its exact hash.`,
      };
    },
    async verify(ctx, input, result) {
      try {
        const rootNow = roots.pick(input.workspace);
        const file = resolveForAction(rootNow, input.path);
        const fresh = fs.readFileSync(file);
        if (fresh.length !== result.data.size) {
          return { ok: false, detail: `the file is ${fresh.length} bytes; the action reported ${result.data.size}` };
        }
        if (sha256(fresh) !== result.data.sha256) {
          return { ok: false, detail: 'the file content differs from the bytes the action reported writing' };
        }
        if (fresh.toString('utf8') !== input.content) {
          return { ok: false, detail: 'the stored text differs from the requested content' };
        }
        if (result.data.mode === 'replaced' && result.data.previousSha256 === result.data.sha256) {
          return { ok: true, detail: `file confirmed at ${fresh.length} bytes (the replacement text equals the previous text)` };
        }
        return { ok: true, detail: `${fresh.length} bytes confirmed by an independent read (sha256 match)` };
      } catch (err) {
        return { ok: false, detail: `the write could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

export function workspaceActions(roots, options = {}) {
  return [
    findAction(roots, options),
    summarizeAction(roots, options),
    extractAction(roots, options),
    compareAction(roots, options),
    reportAction(roots, options),
    writeAction(roots, options),
    ...lifecycleActions(roots),
  ];
}