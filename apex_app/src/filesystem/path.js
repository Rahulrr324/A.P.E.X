// Path containment and resolution for the read-only filesystem inspection capability.
// The configured root is a security boundary. Every access is resolved, normalised,
// and checked before any filesystem call, and symlinks/reparse points are resolved
// so a link that points outside the root is rejected. The process working directory is
// never changed to enforce security.

import fs from 'node:fs/promises';
import path from 'node:path';
import { ValidationError } from '../errors.js';

// Reason codes surfaced to callers.
export const ESCAPE_REASON = 'path outside authorized root';
export const ABSOLUTE_REASON = 'absolute paths are not allowed';
export const UNC_REASON = 'UNC paths are not allowed';
export const LINK_ESCAPE_REASON = 'resolved path points outside the authorized root';
export const NOT_DIR_REASON = 'authorized root is not a directory';
export const MISSING_ROOT_REASON = 'authorized root does not exist';

// A relative input path must not itself contain traversal components. This is
// defense-in-depth: the real gate is the resolved containment check below, but
// rejecting obvious traversal early gives clearer errors and avoids surprising
// resolution behaviour on some platforms.
export function looksLikeTraversal(relativePath) {
  if (typeof relativePath !== 'string') return false;
  const normalised = relativePath.replace(/[/\\]+/g, '/');
  return normalised.split('/').some((segment) => segment === '..');
}

// Windows-style absolute paths: drive letters (C:\, C:/), UNC (\\server\share),
// and paths that already start with a separator are all treated as absolute for
// our purposes. The configured root is the only allowed absolute base.
export function looksAbsolute(p) {
  if (typeof p !== 'string') return false;
  if (p.startsWith('/')) return true;
  if (p.startsWith('\\')) return true;
  if (/^[A-Za-z]:[/\\]/.test(p)) return true;
  return false;
}

export function looksLikeUnc(p) {
  if (typeof p !== 'string') return false;
  return p.startsWith('\\\\') || p.startsWith('//');
}

// Re-export isInside so the action module can use it without duplicating the comparison logic.
export { isInside };

// Lowest common denominator of path separators in the raw input. We normalise
// separators before we do any containment work.
export function normaliseSeparators(p) {
  return String(p).replace(/[/\\]+/g, path.sep);
}

// Resolve the authorized root once, at configuration time, so it is fixed before
// any action runs. The caller supplies the env value; this returns a resolved,
// validated absolute directory path or throws.
export function resolveRoot(rawRoot) {
  if (typeof rawRoot !== 'string' || rawRoot.trim().length === 0) {
    throw new ValidationError('APEX_FILESYSTEM_ROOT must be set', 'INVALID_CONFIG');
  }
  const trimmed = rawRoot.trim();
  if (looksLikeUnc(trimmed)) {
    throw new ValidationError('UNC roots are not supported', 'INVALID_CONFIG');
  }
  const resolved = path.resolve(trimmed);
  if (!path.isAbsolute(resolved)) {
    throw new ValidationError('APEX_FILESYSTEM_ROOT must resolve to an absolute path', 'INVALID_CONFIG');
  }
  return resolved;
}

// Validate the resolved root at startup: it must exist and be a directory.
export async function validateRoot(resolvedRoot) {
  let stat;
  try {
    stat = await fs.stat(resolvedRoot);
  } catch (err) {
    throw new ValidationError(
      `APEX_FILESYSTEM_ROOT does not exist or cannot be read: ${resolvedRoot}`,
      'INVALID_CONFIG',
    );
  }
  if (!stat.isDirectory()) {
    throw new ValidationError(`APEX_FILESYSTEM_ROOT is not a directory: ${resolvedRoot}`, 'INVALID_CONFIG');
  }
  return resolvedRoot;
}

// Normalise a path for case-insensitive containment comparison.
// Windows compares paths case-insensitively (and drive letters can differ in case);
// POSIX is case-sensitive. We derive a comparable form that works on both: lower-case
// the resolved path, and on Windows also normalise the drive letter to upper case so
// C:\ and c:\ compare equal.
export function comparablePath(p) {
  // path.resolve already produces a platform-native absolute path. Lower-casing it is
  // safe on POSIX (where it changes nothing semantically for our containment check) and
  // correct on Windows for the common case. Drive letters are uppercased so the comparison
  // is consistent regardless of how the root was typed.
  const lower = p.toLowerCase();
  if (lower.length >= 2 && lower[1] === ':' && lower[0] !== lower[0].toUpperCase()) {
    return `${lower[0].toUpperCase()}${lower.slice(1)}`;
  }
  return lower;
}

// Assert that a user-supplied relative path names something inside the authorized root.
// Returns the resolved, real (symlink-resolved) absolute path that may be used for the
// actual filesystem operation. Throws on any attempted escape, absolute input, UNC input,
// traversal input, or unreadable path.
//
// The algorithm:
//  1. Reject absolute or UNC input outright (the root is the only absolute base).
//  2. Reject obvious traversal components in the raw input (defense-in-depth).
//  3. Resolve relative to the root.
//  4. Resolve symlinks / reparse points on the resulting path. If the real path cannot be
//     determined (broken link, permission), reject.
//  5. Confirm the real path is inside the root (case-insensitive, platform-aware).
export async function resolveInside(relativePath, resolvedRoot) {
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    throw new ValidationError('path must be a non-empty relative path', 'INVALID_INPUT');
  }
  const raw = relativePath;
  if (looksAbsolute(raw)) {
    throw new ValidationError(ABSOLUTE_REASON, 'ACCESS_DENIED');
  }
  if (looksLikeUnc(raw)) {
    throw new ValidationError(UNC_REASON, 'ACCESS_DENIED');
  }
  if (looksLikeTraversal(raw)) {
    throw new ValidationError(ESCAPE_REASON, 'ACCESS_DENIED');
  }

  const resolved = path.resolve(resolvedRoot, normaliseSeparators(raw));
  let real;
  try {
    real = await fs.realpath(resolved);
  } catch (err) {
    // A path that cannot be resolved (broken symlink, missing component, permission) is
    // not safe to use. Report it honestly rather than guessing.
    throw new ValidationError(
      `cannot resolve path: ${err?.message ?? err}`,
      err.code === 'ENOENT' ? 'PATH_NOT_FOUND' : 'ACCESS_DENIED',
    );
  }

  // Containment check on the real path. The root itself should also be realpath'd once at
  // config time, but we re-resolve here so a misconfigured root (symlink) is caught too.
  const realRoot = await fs.realpath(resolvedRoot).catch((err) => {
    throw new ValidationError(
      `authorized root cannot be resolved: ${err?.message ?? err}`,
      'INVALID_CONFIG',
    );
  });

  if (!isInside(real, realRoot)) {
    throw new ValidationError(LINK_ESCAPE_REASON, 'ACCESS_DENIED');
  }
  return real;
}

// Case-insensitive containment check. The candidate must be equal to the root, or start
// with the root followed by a path separator (so /allowed-root-2 is not inside
// /allowed-root). For Windows drive roots like C:\, the separator check still works because
// realpath produces C:\... and root is C:\.
export function isInside(candidate, root) {
  const c = comparablePath(candidate);
  const r = comparablePath(root);
  if (c === r) return true;
  if (c.startsWith(r + path.sep)) return true;
  return false;
}
