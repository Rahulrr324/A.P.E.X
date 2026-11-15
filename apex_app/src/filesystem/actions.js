// Bounded, read-only filesystem inspection actions.
//
// The authorized root is supplied by the composition root (app.js) and never by
// model output: it is validated once at startup and captured in the closure of
// these action definitions. Nothing in an action's input can widen it.
//
// Guarantees:
//  - read-only: no write, rename, delete, shell, or process call exists here;
//  - containment: every path goes through resolveInside() before any fs call;
//  - bounded: listings are capped by `limit`, reads by `maxBytes`;
//  - honest: permission and I/O failures are reported, never turned into success;
//  - independent verification: each action re-reads the filesystem to confirm its
//    own reported result instead of trusting the executor.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ValidationError, ExecutionError } from '../errors.js';
import { resolveInside, hasControlChars } from './path.js';
import { workspaceField } from './roots.js';
import { singleLine } from '../util.js';
import { ORIGIN_USER } from '../actions/origins.js';

export const DEFAULT_LIST_LIMIT = 200;
export const MIN_LIST_LIMIT = 1;
export const MAX_LIST_LIMIT = 1000;

// Content may contain tab, newline, and carriage return; any other C0 control
// character (or DEL) means the file is not plain text for our purposes.
const NON_TEXT_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const decoder = new TextDecoder('utf-8', { fatal: true });

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

function pathField(value) {
  if (typeof value !== 'string') throw new ValidationError('path must be text');
  const t = value.trim();
  if (t.length === 0) throw new ValidationError('path is empty');
  if (hasControlChars(t)) throw new ValidationError('path contains control characters');
  return t;
}

function entryType(dirent) {
  if (dirent.isSymbolicLink()) return 'link';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  return 'other';
}

function displaySafe(name) {
  return String(name).replace(/[\u0000-\u001f\u007f]/g, '?');
}

function byName(a, b) {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

// Map an fs error to a stable execution code. The message stays factual and never
// includes an absolute path, so an operation record cannot leak the root's layout.
function ioCode(err) {
  const code = err?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'PERMISSION_DENIED';
  if (code === 'ENOENT') return 'PATH_NOT_FOUND';
  if (code === 'ELOOP') return 'TOO_MANY_LINKS';
  return 'IO_ERROR';
}

// Resolve a path for an action. `root` is the validated real root. A symbolic link
// at the requested path itself is refused outright: following it is never needed
// for inspection, and refusing removes a whole class of link-based ambiguity.
function resolveForAction(root, inputPath) {
  const resolved = resolveInside(root, inputPath);
  if (resolved.isLink) {
    throw new ExecutionError('SYMLINK_REFUSED', 'refusing to follow a symbolic link');
  }
  return resolved.realPath;
}

// ---- filesystem.list --------------------------------------------------------

export function listAction(roots, { maxEntries = MAX_LIST_LIMIT, defaultLimit = DEFAULT_LIST_LIMIT } = {}) {
  const limitCap = Math.min(maxEntries, MAX_LIST_LIMIT);
  return {
    name: 'filesystem.list',
    description: 'List one directory inside an authorized workspace root. Read-only, one level, bounded.',
    inputHint: `{"path": "relative/dir", "workspace": optional root name, "limit": optional ${MIN_LIST_LIMIT}-${limitCap}}`,
    permission: 'read',
    origins: [ORIGIN_USER],
    validate(input) {
      const o = expectObject(input, ['path', 'workspace', 'limit']);
      const p = pathField(o.path);
      let limit = defaultLimit;
      if (o.limit !== undefined) {
        if (!Number.isInteger(o.limit) || o.limit < MIN_LIST_LIMIT || o.limit > limitCap) {
          throw new ValidationError(`limit must be an integer from ${MIN_LIST_LIMIT} to ${limitCap}`);
        }
        limit = o.limit;
      }
      return { path: p, workspace: workspaceField(o.workspace, roots), limit };
    },
    async execute(ctx, { path: inputPath, workspace, limit }) {
      const root = roots.pick(workspace);
      const dir = resolveForAction(root, inputPath);
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch (err) {
        throw new ExecutionError(ioCode(err), `directory cannot be inspected (${err?.code ?? 'error'})`);
      }
      if (!stat.isDirectory()) throw new ExecutionError('NOT_A_DIRECTORY', 'path is not a directory');

      let dirents;
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        throw new ExecutionError(ioCode(err), `directory cannot be listed (${err?.code ?? 'error'})`);
      }
      dirents.sort(byName);
      const entries = dirents.slice(0, limit).map((d) => ({ name: d.name, type: entryType(d) }));
      const truncated = dirents.length > entries.length;
      const data = {
        path: inputPath,
        entries,
        count: entries.length,
        total: dirents.length,
        limit,
        truncated,
      };
      // Entry names are shown in a terminal, so control characters (for example a
      // crafted escape sequence in a file name) are neutralised for display only.
      const shown = entries.map((e) => `  ${e.type === 'directory' ? 'dir ' : e.type === 'link' ? 'link' : '    '} ${displaySafe(e.name)}`);
      const tail = truncated ? `\n  (showing the first ${entries.length} of ${dirents.length} entries)` : '';
      return {
        summary: `listed ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} in "${inputPath}"${truncated ? ' (truncated)' : ''}`,
        data,
        display: `Contents of "${inputPath}" (${dirents.length} ${dirents.length === 1 ? 'entry' : 'entries'}):\n${shown.join('\n')}${tail}`,
      };
    },
    // Independent check: re-list the same directory and compare what was reported.
    async verify(ctx, input, result) {
      try {
        const dir = resolveForAction(roots.pick(input.workspace), input.path);
        const fresh = fs.readdirSync(dir, { withFileTypes: true }).sort(byName);
        const reported = result.data.entries;
        if (!Array.isArray(reported)) return { ok: false, detail: 'result contains no entry list' };
        if (reported.length > result.data.limit) return { ok: false, detail: 'more entries were reported than the limit allows' };
        if (fresh.length !== result.data.total) {
          return { ok: false, detail: `directory now has ${fresh.length} entries; the action reported ${result.data.total}` };
        }
        if (result.data.truncated !== fresh.length > reported.length) {
          return { ok: false, detail: 'truncation flag does not match the reported entries' };
        }
        for (let i = 0; i < reported.length; i += 1) {
          const expected = fresh[i];
          const got = reported[i];
          if (!expected) return { ok: false, detail: `reported entry "${got.name}" is not present in the directory` };
          if (got.name !== expected.name) return { ok: false, detail: `entry ${i} is "${expected.name}" on disk, not "${got.name}"` };
          if (got.type !== entryType(expected)) {
            return { ok: false, detail: `entry "${got.name}" is ${entryType(expected)} on disk, not ${got.type}` };
          }
        }
        return { ok: true, detail: `${reported.length} entr${reported.length === 1 ? 'y' : 'ies'} confirmed by an independent listing` };
      } catch (err) {
        return { ok: false, detail: `listing could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

// ---- filesystem.read --------------------------------------------------------

export function readAction(roots, { maxBytes = 1_048_576 } = {}) {
  return {
    name: 'filesystem.read',
    description: 'Read a bounded UTF-8 text file inside an authorized workspace root. Read-only.',
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
    async execute(ctx, { path: inputPath, workspace, maxBytes: limit }) {
      const root = roots.pick(workspace);
      const file = resolveForAction(root, inputPath);
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
        // Read through a descriptor and re-check the size, so a file that grows
        // between the stat and the read cannot exceed the bound.
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

      let text;
      try {
        text = decoder.decode(buf);
      } catch {
        throw new ExecutionError('FILE_NOT_TEXT', 'file is not valid UTF-8 text');
      }
      if (NON_TEXT_CHARS.test(text)) {
        throw new ExecutionError('FILE_NOT_TEXT', 'file contains binary control characters');
      }

      return {
        summary: `read ${buf.length} bytes from "${inputPath}"`,
        data: {
          path: inputPath,
          size: buf.length,
          sha256: sha256(buf),
          maxBytes: limit,
          content: text,
        },
        display: `${inputPath} (${buf.length} bytes):\n${text}`,
      };
    },
    // Independent check: re-read the file and compare size, hash, and content.
    async verify(ctx, input, result) {
      try {
        const file = resolveForAction(roots.pick(input.workspace), input.path);
        const stat = fs.statSync(file);
        if (!stat.isFile()) return { ok: false, detail: 'path is no longer a regular file' };
        if (stat.size !== result.data.size) {
          return { ok: false, detail: `file is now ${stat.size} bytes; the action reported ${result.data.size}` };
        }
        if (stat.size > result.data.maxBytes) {
          return { ok: false, detail: 'file now exceeds the size that was read' };
        }
        const fresh = fs.readFileSync(file);
        if (fresh.length !== result.data.size) {
          return { ok: false, detail: 'file changed size between the read and verification' };
        }
        if (sha256(fresh) !== result.data.sha256) {
          return { ok: false, detail: 'file content changed between the read and verification' };
        }
        let text;
        try {
          text = decoder.decode(fresh);
        } catch {
          return { ok: false, detail: 'file is no longer valid UTF-8 text' };
        }
        if (text !== result.data.content) {
          return { ok: false, detail: 're-read content differs from the reported content' };
        }
        return { ok: true, detail: `${fresh.length} bytes confirmed by an independent read (sha256 match)` };
      } catch (err) {
        return { ok: false, detail: `read could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}
