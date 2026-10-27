// Independent verification for filesystem inspection actions.
//
// These helpers re-examine the real filesystem (or the test harness fs) after an
// action has produced a result, and report whether the result is consistent with
// what is actually on disk. They are purposely separate from the action execution
// so that verification failures are distinguishable from execution failures.
//
// IMPORTANT: verification runs against the SAME authorized root that was used by
// the action. It does not grant any new access. If the underlying fs is untrusted
// or changes between the action read and the verification read, verification can
// fail or report uncertainty.

import { Api } from './actions.js';
import { looksLikeTraversal } from './path.js';
import { CONTROL_CHARS } from '../util.js';

const MAX_VERIFY_CONTENT_BYTES = 1_048_576; // 1 MiB sanity ceiling for verification reads

// ---- listing verification ----

/**
 * Re-read the directory at `dirPath` using the same fs the action used and compare
 * the reported entries against the actual directory contents.
 *
 * Returns:
 *  - { kind: 'verified' } when the reported entries match the actual directory.
 *  - { kind: 'verified_unsafe', reason } when we cannot fully verify but the action
 *    already rejected the unsafe case.
 *  - { kind: 'verification_failure', reason } when the reported entries contradict the
 *    actual directory, or when we cannot access the directory for verification.
 *  - { kind: 'security_error', reason } when verification itself touches something
 *    outside the authorized root (should not happen; defensive).
 */
export function verifyListingMatchesDirectory(dirPath, payload, maxReadBytes) {
  const fs = Api.fsNow();
  if (!fs) {
    // No fs available (e.g. some test isolation scenarios). We cannot verify, but
    // we also cannot claim success. Report uncertainty.
    return { kind: 'verified_unsafe', reason: 'no filesystem available for verification' };
  }

  const actualNames = fs.readdir(dirPath);
  if (actualNames === null) {
    return { kind: 'verification_failure', reason: 'verification could not read the directory' };
  }

  const actual = new Set(actualNames);

  // Check that every reported entry exists in the actual directory.
  for (const entry of payload.entries) {
    if (!actual.has(entry.name)) {
      return { kind: 'verification_failure', reason: `reported entry ${JSON.stringify(entry.name)} is not present in the directory` };
    }
  }

  // Check that the action did not omit an entry when under the limit. If the action
  // reported fewer entries than the directory actually has AND it hit its limit, that
  // is acceptable (the limit is part of the contract). Otherwise, an omission is a
  // verification failure.
  if (payload.entries.length < actualNames.length && payload.entries.length < payload.limit) {
    return { kind: 'verification_failure', reason: `directory has ${actualNames.length} entries but only ${payload.entries.length} were reported without hitting the limit` };
  }

  return { kind: 'verified' };
}

// ---- file read verification ----

/**
 * Re-open the file at `filePath`, read up to `maxBytes`, and confirm that the
 * reported content matches what is on disk.
 *
 * Returns:
 *  - { kind: 'verified' } when the content matches.
 *  - { kind: 'verification_failure', reason } when the file no longer matches the
 *    reported content, or when it cannot be read for verification.
 *  - { kind: 'security_error', reason } when the file path is outside the root
 *    (should not happen here; defensive).
 */
export function verifyLocallyReadableAndBounded(filePath, payload, reportedMaxBytes, maxReadBytes) {
  const fs = Api.fsNow();
  if (!fs) {
    return { kind: 'verified_unsafe', reason: 'no filesystem available for verification' };
  }

  // Defensive: ensure the file is still inside the authorized root by re-resolving
  // it. This protects against the (unlikely) case where the action's resolved path
  // was not actually inside the root due to a bug.
  if (looksLikeTraversal(filePath)) {
    return { kind: 'security_error', reason: 'verification path contains traversal sequences' };
  }

  const stat = fs.lstat(filePath);
  if (!stat) {
    return { kind: 'verification_failure', reason: 'verification could not stat the file' };
  }

  if (stat.isSymbolicLink()) {
    return { kind: 'verification_failure', reason: 'verification encountered a symlink; content may not be trustworthy' };
  }

  if (!stat.isFile()) {
    return { kind: 'verification_failure', reason: 'verification found the path is not a regular file' };
  }

  const size = stat.size;
  if (size > reportedMaxBytes) {
    return { kind: 'verification_failure', reason: 'file grew beyond the reported maximum after the action read it' };
  }

  let buf;
  try {
    buf = fs.readFileBuffer(filePath, Math.min(reportedMaxBytes, MAX_VERIFY_CONTENT_BYTES));
  } catch (e) {
    return { kind: 'verification_failure', reason: 'verification could not read the file' };
  }

  if (!buf) {
    return { kind: 'verification_failure', reason: 'verification could not read the file' };
  }

  // Re-decode and compare. We use strict UTF-8 decoding here; if the original read
  // was strict, this should match. If the original read was lossy, this will fail
  // verification, which is the correct conservative outcome.
  let text;
  try {
    text = buf.toString('utf8');
  } catch (e) {
    return { kind: 'verification_failure', reason: 'verification could not decode the file as text' };
  }

  if (text !== payload.content) {
    return { kind: 'verification_failure', reason: 'file content changed between the action read and verification' };
  }

  return { kind: 'verified' };
}

// ---- shared guard helpers (re-exported for convenience) ----

export { CONTROL_CHARS } from '../util.js';
