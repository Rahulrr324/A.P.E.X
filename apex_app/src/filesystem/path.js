// Path containment for the filesystem capabilities: bounded reads, and the
// create-or-hash-guarded replace whose target may not exist yet.
//
// The configured root is a security boundary, not a hint. Every path is resolved
// and checked before any filesystem call, and the process working directory is
// never changed to enforce anything. All functions here are synchronous so the
// containment decision and the filesystem operation that follows it cannot be
// separated by an await point.
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../errors.js';

export const MAX_PATH_CHARS = 1024;

// C0 control characters plus DEL. NUL in particular must never reach the OS.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function hasControlChars(text) {
  return typeof text === 'string' && CONTROL_CHARS.test(text);
}

// A relative input path must not contain a `..` component. This is defense in
// depth: the real gate is the resolved containment check, but rejecting an obvious
// traversal early gives an honest error instead of a confusing resolution result.
export function looksLikeTraversal(relativePath) {
  if (typeof relativePath !== 'string') return false;
  const normalised = relativePath.replace(/[/\\]+/g, '/');
  return normalised.split('/').some((segment) => segment === '..');
}

// Drive-letter paths (C:\, C:/), leading separators, and UNC paths are all absolute
// for our purposes. The configured root is the only absolute base an action may use.
export function looksAbsolute(p) {
  if (typeof p !== 'string') return false;
  if (p.startsWith('/')) return true;
  if (p.startsWith('\\')) return true;
  if (/^[A-Za-z]:[/\\]?/.test(p)) return true;
  return false;
}

export function looksLikeUnc(p) {
  if (typeof p !== 'string') return false;
  return p.startsWith('\\\\') || p.startsWith('//');
}

export function isWindowsPathSyntax(p) {
  if (typeof p !== 'string') return false;
  return /^[A-Za-z]:[/\\]/.test(p) || p.includes('\\') || looksLikeUnc(p);
}

// Comparison form of a resolved path. Windows and macOS compare case-insensitively
// for practical purposes; Linux is case-sensitive. A trailing separator is removed
// (except for a filesystem root) so `C:\dir\` and `C:\dir` compare equal.
export function comparablePath(p) {
  let s = String(p);
  if (process.platform === 'win32' || process.platform === 'darwin') s = s.toLowerCase();
  if (s.length > 1 && (s.endsWith('/') || s.endsWith('\\'))) {
    const trimmed = s.replace(/[/\\]+$/, '');
    // Keep the separator for a drive root ("c:") so the prefix check still works.
    s = trimmed.length === 2 && trimmed[1] === ':' ? `${trimmed}${path.sep}` : trimmed;
  }
  return s;
}

// The candidate must be the root itself or start with the root followed by a
// separator, so `/data/allowed-2` is not treated as inside `/data/allowed`.
export function isInside(candidate, root) {
  const c = comparablePath(candidate);
  const r = comparablePath(root);
  if (c === r) return true;
  const base = r.endsWith(path.sep) || r.endsWith('/') || r.endsWith('\\') ? r : r + path.sep;
  return c.startsWith(base);
}

// Resolve and validate the configured root. Absolute paths only: a relative value
// would silently depend on the process working directory, which is exactly the
// ambiguity this boundary must not have. Filesystem/UNC roots are refused.
export function resolveRoot(rawRoot) {
  if (typeof rawRoot !== 'string' || rawRoot.trim().length === 0) {
    throw new ValidationError('APEX_FILESYSTEM_ROOT must be set', 'INVALID_CONFIG');
  }
  const trimmed = rawRoot.trim();
  if (hasControlChars(trimmed)) {
    throw new ValidationError('APEX_FILESYSTEM_ROOT contains control characters', 'INVALID_CONFIG');
  }
  if (trimmed.length > MAX_PATH_CHARS) {
    throw new ValidationError(`APEX_FILESYSTEM_ROOT exceeds ${MAX_PATH_CHARS} characters`, 'INVALID_CONFIG');
  }
  if (looksLikeUnc(trimmed)) {
    throw new ValidationError('APEX_FILESYSTEM_ROOT may not be a UNC path', 'INVALID_CONFIG');
  }
  if (!path.isAbsolute(trimmed)) {
    throw new ValidationError('APEX_FILESYSTEM_ROOT must be an absolute path', 'INVALID_CONFIG');
  }
  const normalised = path.resolve(trimmed);
  const parsed = path.parse(normalised);
  if (parsed.root === normalised) {
    // A bare drive or "/" would authorize an entire volume. Refuse it rather than
    // quietly turning one env var into whole-disk access.
    throw new ValidationError('APEX_FILESYSTEM_ROOT may not be a drive or filesystem root', 'INVALID_CONFIG');
  }
  return normalised;
}

// Validate the configured root once, at startup: it must exist, be a directory,
// and be reachable. Returns its real path, which is the form used for every
// containment comparison.
// `label` names the setting being validated, so a named workspace's failure does not
// claim APEX_FILESYSTEM_ROOT is wrong.
export function validateRoot(root, label = 'APEX_FILESYSTEM_ROOT') {
  let real;
  try {
    real = fs.realpathSync(root);
  } catch (err) {
    throw new ValidationError(
      `${label} does not exist or cannot be read (${err?.code ?? 'error'})`,
      'INVALID_CONFIG',
    );
  }
  let stat;
  try {
    stat = fs.statSync(real);
  } catch (err) {
    throw new ValidationError(
      `${label} cannot be inspected (${err?.code ?? 'error'})`,
      'INVALID_CONFIG',
    );
  }
  if (!stat.isDirectory()) {
    throw new ValidationError(`${label} is not a directory`, 'INVALID_CONFIG');
  }
  return real;
}

// Resolve a user-supplied relative path against the already-validated real root.
// Returns { realPath, isLink }: the link-resolved absolute path, and whether the
// requested path itself is a symbolic link (the actions refuse those). Throws a
// ValidationError with a stable code for every refusal, so callers never have to
// interpret message text:
//   INVALID_INPUT     not a usable relative path
//   ACCESS_DENIED     absolute, UNC, traversal, or resolves outside the root
//   PATH_NOT_FOUND    missing component or unresolvable link
export function resolveInside(root, rawPath) {
  if (typeof rawPath !== 'string') {
    throw new ValidationError('path must be text', 'INVALID_INPUT');
  }
  const input = rawPath.trim();
  if (input.length === 0) throw new ValidationError('path is empty', 'INVALID_INPUT');
  if (input.length > MAX_PATH_CHARS) {
    throw new ValidationError(`path exceeds ${MAX_PATH_CHARS} characters`, 'INVALID_INPUT');
  }
  if (hasControlChars(input)) {
    throw new ValidationError('path contains control characters', 'INVALID_INPUT');
  }
  if (looksLikeUnc(input)) {
    throw new ValidationError('UNC paths are not allowed', 'ACCESS_DENIED');
  }
  if (looksAbsolute(input)) {
    throw new ValidationError('absolute paths are not allowed', 'ACCESS_DENIED');
  }
  if (looksLikeTraversal(input)) {
    throw new ValidationError('path contains a traversal component', 'ACCESS_DENIED');
  }

  const joined = path.resolve(root, input);
  // A path that is inside the root by string comparison can still escape via a
  // symbolic link, so resolve links first and check the real target.
  let real;
  try {
    real = fs.realpathSync(joined);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new ValidationError('path does not exist', 'PATH_NOT_FOUND');
    }
    throw new ValidationError(`path cannot be resolved (${err?.code ?? 'error'})`, 'ACCESS_DENIED');
  }
  if (!isInside(real, root)) {
    throw new ValidationError('path resolves outside the authorized root', 'ACCESS_DENIED');
  }
  let isLink = false;
  try {
    isLink = fs.lstatSync(joined).isSymbolicLink();
  } catch {
    isLink = true; // cannot prove it is not a link: refuse conservatively
  }
  return { realPath: real, isLink };
}

// Resolve a path that does not exist yet, for a create-only write. resolveInside()
// cannot be used: it requires the target to exist so it can resolve links. Here the
// parent is resolved instead, and the requested name is appended to the parent's real
// path, so a symlinked directory inside the root cannot redirect the write outside it.
// The target itself is never followed or created; a caller must still check `exists`
// and refuse to overwrite. Refusal codes match resolveInside:
//   INVALID_INPUT     not a usable relative path
//   ACCESS_DENIED     absolute, UNC, traversal, or a parent outside the root
//   PATH_NOT_FOUND    the parent directory does not exist or is not a directory
export function resolveNewFile(root, rawPath) {
  if (typeof rawPath !== 'string') {
    throw new ValidationError('path must be text', 'INVALID_INPUT');
  }
  const input = rawPath.trim();
  if (input.length === 0) throw new ValidationError('path is empty', 'INVALID_INPUT');
  if (input.length > MAX_PATH_CHARS) {
    throw new ValidationError(`path exceeds ${MAX_PATH_CHARS} characters`, 'INVALID_INPUT');
  }
  if (hasControlChars(input)) {
    throw new ValidationError('path contains control characters', 'INVALID_INPUT');
  }
  if (looksLikeUnc(input)) {
    throw new ValidationError('UNC paths are not allowed', 'ACCESS_DENIED');
  }
  if (looksAbsolute(input)) {
    throw new ValidationError('absolute paths are not allowed', 'ACCESS_DENIED');
  }
  if (looksLikeTraversal(input)) {
    throw new ValidationError('path contains a traversal component', 'ACCESS_DENIED');
  }

  const joined = path.resolve(root, input);
  const parent = path.dirname(joined);
  if (parent === joined) {
    throw new ValidationError('path names a directory, not a file', 'INVALID_INPUT');
  }
  let parentReal;
  try {
    parentReal = fs.realpathSync(parent);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new ValidationError('the parent directory does not exist', 'PATH_NOT_FOUND');
    }
    throw new ValidationError(`the parent directory cannot be resolved (${err?.code ?? 'error'})`, 'ACCESS_DENIED');
  }
  if (!isInside(parentReal, root)) {
    throw new ValidationError('the parent directory resolves outside the authorized root', 'ACCESS_DENIED');
  }
  let parentStat;
  try {
    parentStat = fs.statSync(parentReal);
  } catch (err) {
    throw new ValidationError(`the parent directory cannot be inspected (${err?.code ?? 'error'})`, 'PATH_NOT_FOUND');
  }
  if (!parentStat.isDirectory()) {
    throw new ValidationError('the parent path is not a directory', 'PATH_NOT_FOUND');
  }
  const target = path.join(parentReal, path.basename(joined));
  let exists = false;
  try {
    fs.lstatSync(target);
    exists = true;
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      throw new ValidationError(`the target cannot be inspected (${err?.code ?? 'error'})`, 'ACCESS_DENIED');
    }
  }
  return { targetPath: target, parentPath: parentReal, exists };
}
