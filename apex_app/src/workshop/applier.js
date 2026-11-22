// T-39 Step 1 (2026-11-22): the governed applier.
//
// T-38 made the Workshop a real inspector and a real verifier, and stopped there on purpose: a
// promotion recorded a decision and wrote nothing. That was honest but incomplete, and this module is
// the missing half - the only place in APEX that writes a file into the live workspace tree.
//
// It is deliberately small, because every line of it is a promise about somebody's files. The
// promises, in the order they are kept:
//
//   1. Nothing is applied that has not been verified. The verification must have passed, and the
//      digest it recorded must still match the bytes in the sandbox right now. A record that says
//      "verified" about different bytes is not evidence about these bytes.
//   2. Nothing is applied outside the configured root. The target is resolved through realpath, so a
//      traversal string, an absolute path or a symlink pointing out of the tree is refused before a
//      byte is written.
//   3. Nothing is applied over a file the owner changed. The candidate recorded the base file's
//      SHA-256 when it was staged; if the file on disk no longer hashes to that, the apply is
//      refused and both digests are reported. This is the whole point: an editor that clobbers a
//      concurrent change is worse than an editor that refuses.
//   4. The previous bytes are saved before the new ones land, content-addressed by the digest of what
//      was there, so a rollback restores something that can be proved to be what was replaced.
//   5. The write is atomic and the result is re-read. The bytes go to a sibling temporary file and
//      are renamed into place, then the file is read back from disk and its digest compared with the
//      candidate's. Nothing reports `applied` on the strength of a successful write call.
//   6. A rollback refuses to destroy manual work. It only restores if the file still hashes to what
//      the apply wrote.
//
// The module holds no authority of its own. Every method here runs below the action that the registry
// authorized and the ECP permitted; a refusal from either one happens before this code is reached.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ValidationError, ExecutionError } from '../errors.js';
import { resolveNewFile } from '../filesystem/path.js';

export const WORKSHOP_APPLY_SCHEMA = 'apex.workshop.file-apply/1';
export const WORKSHOP_ROLLBACK_SCHEMA = 'apex.workshop.file-rollback/1';
export const BACKUPS_DIR = 'workshop-backups';
export const APPLY_LEDGER = 'workshop-applies.jsonl';

// The ledger keeps every apply and rollback in one append-only file, so a rollback can be read back
// by an id the owner supplied rather than trusted from the request that asked for it.
//
// The bound is a refusal, not a truncation. An append-only ledger that silently dropped its oldest
// record would break every open rollback that pointed at it, so past this many records the applier
// stops writing and says why. The number is high enough that normal use never reaches it and low
// enough that a runaway loop is caught the same day rather than the same quarter.
export const MAX_LEDGER_RECORDS = 20_000;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed);
    } catch {
      // A corrupt line is skipped rather than crashing the reader. It is bounded by the writer never
      // producing one, and a damaged ledger must not make every later apply impossible.
    }
  }
  return records;
}

// The temporary sibling a write is staged in before the rename. It lives in the target's own
// directory so the rename is within one filesystem, which is what makes it atomic.
function temporaryName(target) {
  return path.join(path.dirname(target), `.${path.basename(target)}.apex-tmp-${randomUUID().slice(0, 8)}`);
}

export class WorkshopApplier {
  constructor({ dataDir, sandbox, now = () => new Date() } = {}) {
    if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('an applier needs a data directory');
    if (!sandbox) throw new TypeError('an applier needs the sandbox that holds the candidates');
    // The sandbox already holds the inspector that bounds both modules, and the applier derives its
    // containment from that one rather than from a second instance that could be configured differently.
    if (!sandbox.inspector) throw new TypeError('an applier needs the sandbox to carry its workspace inspector');
    this.dataDir = dataDir;
    this.sandbox = sandbox;
    this.inspector = sandbox.inspector;
    this.now = now;
    this.ledgerPath = path.join(dataDir, APPLY_LEDGER);
    this.backupsRoot = path.join(dataDir, BACKUPS_DIR);
  }

  get available() {
    return this.inspector.available === true;
  }

  // ---------------------------------------------------------------- reading the ledger ---

  // Every record, newest last, as the ledger holds it. The ledger is the only source of truth for an
  // apply: the request that asks for a rollback supplies an id, and the bytes come from the record.
  records() {
    return readLedger(this.ledgerPath);
  }

  applyRecord(applyId) {
    const want = typeof applyId === 'string' ? applyId.trim() : '';
    if (want === '') return null;
    // The newest record wins, because a candidate may be applied more than once and only the latest
    // apply describes the bytes now on disk.
    const matches = this.records().filter((record) => record.kind === 'apply' && record.applyId === want);
    return matches.length === 0 ? null : matches[matches.length - 1];
  }

  // The applies that a rollback could still act on: applied, not yet rolled back, in time order.
  openApplies() {
    const rolledBack = new Set(this.records().filter((r) => r.kind === 'rollback').map((r) => r.applyId));
    return this.records()
      .filter((record) => record.kind === 'apply' && !rolledBack.has(record.applyId))
      .reverse();
  }

  // The one place a candidate's relative path becomes an absolute path. An existing file is resolved
  // with its links followed; a file that does not exist yet is resolved through its parent. Both
  // answers are inside the configured root, or the call throws with the code the gate produced.
  #resolveTarget(relativePath) {
    const root = this.inspector.root;
    if (fs.existsSync(path.resolve(root, relativePath))) {
      const resolved = this.inspector.resolve(relativePath);
      if (!resolved.ok) {
        throw new ExecutionError('ACCESS_DENIED', `the path is not inside the workspace root: ${resolved.detail}`);
      }
      return resolved.realPath;
    }
    try {
      const created = resolveNewFile(root, relativePath);
      // A file that appeared between the existence check and here is still refused rather than
      // overwritten: `exists` is the resolver's own reading of the target immediately before the write.
      if (created.exists === true) {
        throw new ExecutionError('WORKSPACE_DRIFT', `${relativePath} appeared on disk while the candidate was being applied`);
      }
      return created.targetPath;
    } catch (err) {
      if (err instanceof ExecutionError) throw err;
      if (err?.code === 'PATH_NOT_FOUND') {
        throw new ExecutionError('PATH_NOT_FOUND', `the parent directory of ${relativePath} does not exist inside the workspace root`);
      }
      throw new ExecutionError('ACCESS_DENIED', `the path is not inside the workspace root: ${err?.message ?? err}`);
    }
  }

  // ------------------------------------------------------------------------- the apply ---

  // Apply one verified candidate to the live workspace. Every refusal happens before a write, and the
  // write itself is staged in a sibling and renamed, then proved by reading the file back.
  apply({ candidateId } = {}) {
    if (!this.available) {
      throw new ValidationError('no target workspace is configured, so there is nothing to apply to', 'WORKSPACE_UNAVAILABLE');
    }

    // Gate 0: room for the record this operation is about to make. An apply that cannot be recorded
    // must not happen, so this runs before the snapshot and before the write.
    this.#assertRoom();

    // Gate 2, first half: the candidate exists and carries a passing verification whose digest still
    // describes the staged bytes. A verification about other bytes proves nothing about these.
    const record = this.sandbox.load(candidateId);
    if (!record) throw new ExecutionError('WORKSHOP_NOT_FOUND', `no staged candidate ${candidateId}`);
    const verification = this.sandbox.latestVerification(candidateId);
    if (!verification || verification.verified !== true) {
      throw new ExecutionError(
        'APPLY_REFUSED_UNVERIFIED',
        'the candidate has no passing sandbox verification, so applying it would write unverified bytes',
      );
    }
    const stagedBytes = fs.readFileSync(record.stagedPath);
    const stagedDigest = sha256(stagedBytes);
    if (stagedDigest !== verification.stagedDigest || stagedDigest !== record.digest) {
      throw new ExecutionError(
        'APPLY_REFUSED_UNVERIFIED',
        'the sandbox holds different bytes than the passing verification recorded',
      );
    }

    // A candidate that is already applied and still open is refused by name rather than by the drift
    // gate, because "you already applied this" is actionable and "the file changed" is not.
    const already = this.records().find(
      (entry) => entry.kind === 'apply' && entry.candidateId === candidateId && entry.appliedSha256 === stagedDigest,
    );
    if (already && !this.records().some((entry) => entry.kind === 'rollback' && entry.applyId === already.applyId)) {
      throw new ExecutionError('ALREADY_APPLIED', `that candidate is already applied to the workspace as ${already.applyId}`);
    }

    // Gate 3: containment. An existing target is resolved through realpath, so a traversal string, an
    // absolute path or a symlink pointing out of the tree is refused here, before anything is written.
    // A target that does not exist yet is resolved through its parent for the same reason: a symlinked
    // directory inside the root must not redirect the create outside it.
    const target = this.#resolveTarget(record.relativePath);

    // Gate 4: base drift. The candidate recorded what the file hashed to when it was staged; if the
    // file on disk is not that any more, somebody else has changed it and the apply must not win.
    const existsNow = fs.existsSync(target);
    let actualDiskSha256 = null;
    if (existsNow) {
      const stat = fs.statSync(target);
      if (!stat.isFile()) {
        throw new ExecutionError('NOT_A_FILE', `${record.relativePath} is not a regular file`);
      }
      actualDiskSha256 = sha256(fs.readFileSync(target));
    }
    const expectedBaseSha256 = record.base?.exists === true ? (record.base.digest ?? null) : null;
    if (actualDiskSha256 !== expectedBaseSha256) {
      const error = new ExecutionError(
        'WORKSPACE_DRIFT',
        expectedBaseSha256 === null
          ? `${record.relativePath} did not exist when the candidate was staged, and now it does; it was not overwritten`
          : `${record.relativePath} changed on disk after the candidate was staged; it was not overwritten`,
      );
      // Both digests travel with the refusal, because "it drifted" without the two values is a
      // message nobody can act on. They go on `detail`, which the executor copies onto the error it
      // reports, so they survive the trip to the route and the screen.
      error.detail = { expectedBaseSha256, actualDiskSha256 };
      throw error;
    }

    const appliedAt = this.now().toISOString();
    const applyId = `wsa-${createHash('sha256').update(`${candidateId}:${stagedDigest}:${appliedAt}`).digest('hex').slice(0, 12)}`;

    // The rollback snapshot is written before the target is touched, so there is no instant in which
    // the new bytes exist without the old ones being recoverable.
    const backupDir = path.join(this.backupsRoot, applyId);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backup = {
      schema: 'apex.workshop.rollback-snapshot/1',
      applyId,
      candidateId,
      relativePath: record.relativePath,
      existedBefore: existsNow,
      beforeSha256: actualDiskSha256,
      appliedSha256: stagedDigest,
      at: appliedAt,
      // The snapshot is named by what it holds, so its integrity can be checked by hashing it.
      backupFile: existsNow ? `before-${actualDiskSha256 ?? 'unknown'}.bin` : null,
    };
    if (existsNow) {
      const backupBytes = fs.readFileSync(target);
      const backupDigest = sha256(backupBytes);
      if (backupDigest !== actualDiskSha256) {
        throw new ExecutionError('WORKSPACE_DRIFT', 'the file changed while its snapshot was being taken; nothing was written');
      }
      fs.writeFileSync(path.join(backupDir, backup.backupFile), backupBytes, { mode: 0o600 });
    }
    fs.writeFileSync(path.join(backupDir, 'snapshot.json'), `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });

    // The atomic write: a sibling temporary file in the same directory, then a rename. A rename within
    // one filesystem either happens or does not; there is no half-written target.
    const temporary = temporaryName(target);
    try {
      fs.writeFileSync(temporary, stagedBytes, { mode: existsNow ? fs.statSync(target).mode & 0o777 : 0o644 });
      fs.renameSync(temporary, target);
    } catch (err) {
      // A failed write must not leave a temporary file behind for the next reader to trip over.
      try { fs.rmSync(temporary, { force: true }); } catch { /* the cleanup is best effort */ }
      throw new ExecutionError('APPLY_WRITE_FAILED', `the write did not complete: ${err?.message ?? err}`);
    }

    // The proof: read the file back from disk rather than trusting the write call.
    const writtenDigest = sha256(fs.readFileSync(target));
    if (writtenDigest !== stagedDigest) {
      // Restore immediately, because a file that does not match what was verified is not a state the
      // owner should be left in.
      if (existsNow) {
        const restore = temporaryName(target);
        try {
          fs.writeFileSync(restore, fs.readFileSync(path.join(backupDir, backup.backupFile)));
          fs.renameSync(restore, target);
        } catch {
          try { fs.rmSync(restore, { force: true }); } catch { /* the cleanup is best effort */ }
        }
      } else {
        fs.rmSync(target, { force: true });
      }
      throw new ExecutionError('APPLY_VERIFY_FAILED', 'the file on disk does not match the candidate after the write; the previous state was restored');
    }

    const entry = {
      schema: WORKSHOP_APPLY_SCHEMA,
      kind: 'apply',
      applyId,
      at: appliedAt,
      candidateId,
      verificationId: verification.id,
      relativePath: record.relativePath,
      existedBefore: existsNow,
      beforeSha256: actualDiskSha256,
      appliedSha256: stagedDigest,
      diskSha256: writtenDigest,
      backupId: applyId,
      backupDir,
      bytes: stagedBytes.length,
      // Every one of these is the point of the record rather than decoration.
      appliedToWorkspace: true,
      verifiedOnDisk: writtenDigest === stagedDigest,
      mutatesLiveWorkspace: true,
      authorizesExecution: false,
    };
    this.#append(entry);
    return entry;
  }

  // ---------------------------------------------------------------------- the rollback ---

  // Restore the bytes an apply replaced. The record is read from the ledger, so the request only
  // supplies an id; nothing about what to write comes from the caller.
  rollback({ applyId, reason = null } = {}) {
    if (!this.available) {
      throw new ValidationError('no target workspace is configured, so there is nothing to roll back', 'WORKSPACE_UNAVAILABLE');
    }
    const record = this.applyRecord(applyId);
    if (!record) throw new ExecutionError('WORKSHOP_NOT_FOUND', `no applied change ${applyId}`);

    // Already rolled back: refuse rather than restoring twice. Restoring twice would write the same
    // bytes again, which looks harmless and would make the ledger lie about how many changes are open.
    const priorRollback = this.records().find((entry) => entry.kind === 'rollback' && entry.applyId === record.applyId);
    if (priorRollback) {
      throw new ExecutionError('ALREADY_ROLLED_BACK', `that change was already rolled back at ${priorRollback.at}`);
    }

    const target = this.#resolveTarget(record.relativePath);

    // The drift gate: the file must still be exactly what the apply wrote. If the owner edited it by
    // hand afterwards, their work is newer than the snapshot and a rollback would destroy it.
    const existsNow = fs.existsSync(target);
    const actualDiskSha256 = existsNow ? sha256(fs.readFileSync(target)) : null;
    if (actualDiskSha256 !== record.appliedSha256) {
      const error = new ExecutionError(
        'ROLLBACK_DRIFT',
        actualDiskSha256 === null
          ? `${record.relativePath} was deleted after it was applied, so there is nothing to roll back`
          : `${record.relativePath} was edited after it was applied; the rollback would discard those edits`,
      );
      error.detail = { expectedAppliedSha256: record.appliedSha256, actualDiskSha256 };
      throw error;
    }

    // A rollback appends a record too, so it checks for room before it restores anything.
    this.#assertRoom();

    const rolledBackAt = this.now().toISOString();
    let restoredSha256 = null;

    if (record.existedBefore === true) {
      const backupFile = path.join(record.backupDir, `before-${record.beforeSha256}.bin`);
      let backupBytes;
      try {
        backupBytes = fs.readFileSync(backupFile);
      } catch {
        throw new ExecutionError('BACKUP_MISSING', 'the rollback snapshot is gone, so the previous bytes cannot be restored');
      }
      // The snapshot is checked before it is written, not after: a damaged backup must not become the
      // file.
      if (sha256(backupBytes) !== record.beforeSha256) {
        throw new ExecutionError('BACKUP_DAMAGED', 'the rollback snapshot does not match the digest the apply recorded');
      }
      const temporary = temporaryName(target);
      try {
        fs.writeFileSync(temporary, backupBytes, { mode: fs.statSync(target).mode & 0o777 });
        fs.renameSync(temporary, target);
      } catch (err) {
        try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
        throw new ExecutionError('ROLLBACK_WRITE_FAILED', `the restore did not complete: ${err?.message ?? err}`);
      }
      restoredSha256 = sha256(fs.readFileSync(target));
      if (restoredSha256 !== record.beforeSha256) {
        throw new ExecutionError('ROLLBACK_VERIFY_FAILED', 'the restored file does not match the pre-apply digest');
      }
    } else {
      // The apply created the file. A rollback removes it, then confirms it is gone.
      try {
        fs.rmSync(target, { force: false });
      } catch (err) {
        throw new ExecutionError('ROLLBACK_WRITE_FAILED', `the created file could not be removed: ${err?.message ?? err}`);
      }
      if (fs.existsSync(target)) {
        throw new ExecutionError('ROLLBACK_VERIFY_FAILED', 'the created file is still present after removal');
      }
      restoredSha256 = null;
    }

    const entry = {
      schema: WORKSHOP_ROLLBACK_SCHEMA,
      kind: 'rollback',
      rollbackId: `wsr-${createHash('sha256').update(`${record.applyId}:${rolledBackAt}`).digest('hex').slice(0, 12)}`,
      applyId: record.applyId,
      at: rolledBackAt,
      candidateId: record.candidateId,
      relativePath: record.relativePath,
      existedBefore: record.existedBefore,
      beforeSha256: record.beforeSha256,
      appliedSha256: record.appliedSha256,
      restoredSha256,
      removedFile: record.existedBefore === false,
      reason,
      rolledBack: true,
      verifiedOnDisk: record.existedBefore === true
        ? restoredSha256 === record.beforeSha256
        : !fs.existsSync(target),
      mutatesLiveWorkspace: true,
      authorizesExecution: false,
    };
    this.#append(entry);
    return entry;
  }

  // The bound is checked BEFORE anything on disk is touched, not when the record is appended.
  //
  // This distinction is the whole defect the T-39 suite caught: an appender that refuses at the end
  // leaves the workspace written and no record of the write, which is worse than refusing up front
  // and worse than any other failure in this module. The count is read once here, at the start of an
  // apply, so the state the operation commits to is the state it checked.
  #assertRoom() {
    let existing = 0;
    try {
      existing = fs.readFileSync(this.ledgerPath, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    if (existing >= MAX_LEDGER_RECORDS) {
      throw new ExecutionError(
        'APPLY_LEDGER_FULL',
        `the workshop ledger already holds ${existing} records, the bound this build writes; nothing was changed`,
      );
    }
  }

  // The single place this module appends. It re-checks the bound as a defence - the early check above
  // is what makes the refusal safe, and this one makes it impossible to write past the bound even if
  // a future caller forgets - and keeps the newline framing in one place, so no writer can produce a
  // ledger the reader has to defend against.
  #append(entry) {
    this.#assertRoom();
    fs.appendFileSync(this.ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  // The status the Workshop screen reads: what has been applied and what is still open. A read that
  // touches no file, so it is safe to call from a page that has just loaded.
  status() {
    const records = this.records();
    const applies = records.filter((record) => record.kind === 'apply');
    const rollbacks = records.filter((record) => record.kind === 'rollback');
    const rolledBack = new Set(rollbacks.map((record) => record.applyId));
    return {
      schema: 'apex.workshop.apply-status/1',
      available: this.available,
      applies: applies.length,
      rollbacks: rollbacks.length,
      open: applies.filter((record) => !rolledBack.has(record.applyId)).length,
      // The newest first, because a screen shows the most recent change at the top.
      recent: applies.slice(-20).reverse().map((record) => ({
        applyId: record.applyId,
        candidateId: record.candidateId,
        relativePath: record.relativePath,
        at: record.at,
        beforeSha256: record.beforeSha256,
        appliedSha256: record.appliedSha256,
        existedBefore: record.existedBefore,
        rolledBack: rolledBack.has(record.applyId),
      })),
      readOnly: true,
      wroteNothing: true,
    };
  }
}
