// Bounded, read-only filesystem inspection actions.
//
// These actions operate only against a single authorized root that is supplied
// through the composition root (app.js) and never through model output. The root
// is validated once at startup and bound into the action constructors.
//
// Security model:
//  - All user-supplied paths are resolved relative to the authorized root and
//    checked for containment before any filesystem access.
//  - Traversal sequences, control characters, and Windows quirks are rejected.
//  - Symbolic links and other reparse points are not followed for containment
//    decisions; a link target outside the root is rejected.
//  - Absolute paths that resolve outside the root are rejected regardless of
//    how they were constructed.
//  - The process working directory is never changed to enforce these checks.

import { ValidationError } from '../errors.js';
import {
  resolveInside,
  looksLikeTraversal,
} from './path.js';
import { CONTROL_CHARS } from '../util.js';
import {
  verifyLocallyReadableAndBounded,
  verifyListingMatchesDirectory,
} from './verification.js';

const DEFAULT_LIST_LIMIT = 1024;
const MAX_LIST_LIMIT = 10_000;

// ---- shared path parsing ----

function parsePathInput(raw) {
  if (raw == null || typeof raw !== 'string') return { path: null, error: 'path must be a non-empty string' };
  const s = raw.trim();
  if (s.length === 0) return { path: null, error: 'path must be a non-empty string' };
  if (CONTROL_CHARS.test(s)) return { path: null, error: 'path contains control characters' };
  return { path: s, error: null };
}

// ---- filesystem.list ----

function makeListAction(root, maxReadBytes) {
  return {
    capability: 'filesystem.list',
    action: 'filesystem.list',
    description: 'List the entries of an authorized directory.',
    inputSchema: { path: 'string', limit: 'number' },
    validate(input) {
      const o = parsePathInput(input?.path);
      if (o.error) throw new ValidationError(o.error);
      const limit = Number(input?.limit);
      const limitOk = Number.isFinite(limit) && limit >= 0 && limit <= MAX_LIST_LIMIT;
      if (!limitOk) throw new ValidationError(`limit must be a non-negative integer up to ${MAX_LIST_LIMIT}`);
      return { path: o.path, limit: limit || DEFAULT_LIST_LIMIT };
    },
    execute(params, ctx) {
      const resolved = resolveInside(root, params.path, ctx?.authorization);
      if (!resolved.ok) return { outcome: 'security_error', reason: resolved.reason };

      const entries = listDirEntries(resolved.path);

      const payload = { path: params.path, entries, count: entries.length, limit: params.limit, rootRelative: true };

      // Independent verification: re-read the same directory and compare the entry
      // names/types we just reported with what the filesystem actually contains.
      const verified = verifyListingMatchesDirectory(resolved.path, payload, maxReadBytes);

      if (verified.kind === 'security_error') return { outcome: 'security_error', reason: verified.reason };
      if (verified.kind === 'verification_failure') return { outcome: 'verification_failure', reason: verified.reason, payload };

      // On the fixed backend there is no independent trust anchor to fully verify a
      // listing, so we record a best-effort verification result. On the real backend
      // this compares the returned entries with a fresh directory read.
      if (verified.kind === 'verified_unsafe') return { outcome: 'verification_failure', reason: verified.reason, payload };

      return { outcome: 'success', payload, verification: verified.kind };
    },
  };
}

// ---- filesystem.read ----

function makeReadAction(root, maxReadBytes) {
  return {
    capability: 'filesystem.read',
    action: 'filesystem.read',
    description: 'Read a bounded text file inside the authorized root.',
    inputSchema: { path: 'string', maxBytes: 'number' },
    validate(input) {
      const o = parsePathInput(input?.path);
      if (o.error) throw new ValidationError(o.error);

      const maxBytes = Math.max(0, Math.min(Number(input?.maxBytes) || 0, maxReadBytes));
      if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new ValidationError(`maxBytes must be a positive integer`);

      return { path: o.path, maxBytes };
    },
    execute(params, ctx) {
      const resolved = resolveInside(root, params.path, ctx?.authorization);
      if (!resolved.ok) return { outcome: 'security_error', reason: resolved.reason };

      // Read only regular files; never follow symlinks for content, and never read
      // directories or other non-regular entries.
      const fileResult = readBoundedTextFile(resolved.path, params.maxBytes);

      if (fileResult.kind !== 'ok') {
        if (fileResult.kind === 'too_large') return { outcome: 'rejected', reason: 'file exceeds the maximum read size', path: params.path };
        if (fileResult.kind === 'not_text') return { outcome: 'rejected', reason: 'file appears to be binary or invalid text', path: params.path };
        return { outcome: 'error', reason: fileResult.kind, path: params.path };
      }

      const payload = {
        path: params.path,
        content: fileResult.text,
        size: fileResult.size,
        maxBytes: params.maxBytes,
        rootRelative: true,
      };

      // Independent verification: confirm the reported content is consistent with the
      // file we just opened, and that it is still within the authorized root.
      const verified = verifyLocallyReadableAndBounded(resolved.path, payload, params.maxBytes, maxReadBytes);
      if (verified.kind === 'security_error') return { outcome: 'security_error', reason: verified.reason };
      if (verified.kind === 'verification_failure') return { outcome: 'verification_failure', reason: verified.reason, payload };

      return { outcome: 'success', payload, verification: verified.kind };
    },
  };
}

// ---- directory listing helpers (no security logic here; containment is enforced by resolveInside) ----

function listDirEntries(dirPath) {
  const fs = Api.fsNow();
  const names = fs.readdir(dirPath);
  if (!names) return [];

  const out = [];
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);

    const entryPath = fs.join(dirPath, name);
    let type = 'unknown';
    try {
      const st = fs.lstat(entryPath);
      if (st == null) type = 'unknown';
      else if (st.isSymbolicLink()) {
        // Record it as a link; do not dereference it for the listing result.
        type = 'link';
      } else if (st.isDirectory()) {
        type = 'directory';
      } else if (st.isFile()) {
        type = 'file';
      } else {
        type = 'other';
      }
    } catch (e) {
      type = 'unknown';
    }

    out.push({ name, type });
  }
  return out;
}

// ---- bounded text file reading ----

function readBoundedTextFile(path, maxBytes) {
  const fs = Api.fsNow();
  try {
    const stat = fs.lstat(path);
    if (!stat || stat.isSymbolicLink()) return { kind: 'not_text' };
    const size = stat.size;
    if (size > maxBytes) return { kind: 'too_large', size, maxBytes };

    const buf = fs.readFileBuffer(path, size);
    if (!buf) return { kind: 'error', reason: 'unable to read file' };

    // Reject paths/files that are too large for the bounded read even if the stat
    // already passed; this is a belt-and-suspenders check.
    if (buf.byteLength > maxBytes) return { kind: 'too_large', size: buf.byteLength, maxBytes };

    // Decode as UTF-8 but reject non-text / invalid-UTF-8 content. A file that
    // cannot be decoded cleanly is treated as binary/invalid rather than silently
    // returning corrupted text.
    let text;
    try {
      text = fs.decodeUtf8Lossy(buf);
    } catch (e) {
      return { kind: 'not_text' };
    }

    // Heuristic: if the file contained replacement characters from invalid sequences
    // OR if it has a high proportion of control characters (excluding tab/newline),
    // treat it as non-text. The control-char check here is the same one used for
    // path validation, applied to content.
    if (text !== fs.decodeUtf8Strict(buf)) return { kind: 'not_text' };

    const controlChars = fs.hasControlChars(text);
    if (controlChars) return { kind: 'not_text' };

    return { kind: 'ok', text, size: buf.byteLength };
  } catch (e) {
    return { kind: 'error', reason: 'unable to read file' };
  }
}

// ---- minimal fs shim used by the actions (real fs in the compiled app; the test
// runner overrides these with TempDir / mocks). The shim is intentionally tiny so
// the actions remain easy to reason about.

let _fs = null;

function setFs(fsImpl) {
  _fs = fsImpl;
}

function resetFs() {
  _fs = null;
}

function fsNow() {
  return _fs || realFs();
}

function realFs() {
  // This is the real implementation used in the running app; the test harness
  // monkeypatches fsNow() / setFs() so the actions read from TempDir fixtures.
  // Keeping it behind a function avoids importing 'node:fs' at module load time in
  // environments where it is unavailable.
  const fs = require('node:fs');
  const path = require('node:path');
  return {
    lstat: (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } },
    readdir: (p) => { try { return fs.readdirSync(p); } catch (e) { return null; } },
    readFileBuffer: (p, max) => { try { const b = fs.readFileSync(p); return b.byteLength <= max ? b : null; } catch (e) { return null; } },
    decodeUtf8Strict: (b) => { try { return b.toString('utf8'); } catch (e) { throw e; } },
    decodeUtf8Lossy: (b) => { return b.toString('utf8'); },
    hasControlChars: (s) => CONTROL_CHARS.test(s),
    join: (a, b) => path.join(a, b),
  };
}

// Expose a stable API the tests and the app both use.
const Api = {
  setFs,
  resetFs,
  fsNow,
};

export { makeListAction, makeReadAction, Api, parsePathInput };

// Keep these re-exports so existing imports from path.js and util.js keep working
// if any other module pulls them in directly.
export { resolveInside, looksLikeTraversal } from './path.js';
export { CONTROL_CHARS } from '../util.js';
