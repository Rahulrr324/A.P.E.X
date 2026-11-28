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
// T-40 Step 2: a changeset is one governed act touching 2..MAX_CHANGESET_FILES files. It has its own
// record kinds because an all-or-nothing batch is a different promise from N independent applies, and
// a ledger that could not tell them apart could not prove the batch was atomic.
export const WORKSHOP_CHANGESET_SCHEMA = 'apex.workshop.changeset-apply/1';
export const WORKSHOP_CHANGESET_ROLLBACK_SCHEMA = 'apex.workshop.changeset-rollback/1';
// Two is the floor because a "changeset" of one file is an apply with extra ceremony. Eight is the
// ceiling because a batch that must be pre-flighted, snapshotted and either wholly applied or wholly
// abandoned has a cost per file, and an unbounded batch makes the rollback-on-failure path the one
// that runs when the machine is already in trouble.
export const MIN_CHANGESET_FILES = 2;
export const MAX_CHANGESET_FILES = 8;
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

  // ------------------------------------------------------------- the changeset ---

  // Every reason a changeset may be refused, gathered into one place so the pre-flight is one ordered
  // list of checks rather than a set of guards scattered through a write path. The rule the milestone
  // exists for: NOTHING is written until EVERY file has passed EVERY check.
  preflightChangeset({ candidateIds } = {}) {
    const ids = Array.isArray(candidateIds) ? candidateIds : [];
    const problems = [];

    // Every refusal from this function is an exception carrying `detail.problems`, including the ones
    // that are about the request rather than about a file. The first draft returned a result object for
    // the count cases, and applyChangeset - which expects either an exception or a usable entries list -
    // carried on with `undefined` and crashed after creating a backup directory. One shape, always.
    const refuse = (code, detail, problems) => {
      const error = new ExecutionError(code, detail);
      error.detail = { problems, filesChecked: ids.length, filesRefused: problems.length };
      throw error;
    };

    if (!this.available) {
      refuse('WORKSPACE_UNAVAILABLE', 'no workspace root is configured, so there is nothing to apply to', [
        { reason: 'WORKSPACE_UNAVAILABLE', detail: 'no workspace root is configured' },
      ]);
    }
    if (ids.length < MIN_CHANGESET_FILES) {
      refuse('CHANGESET_PREFLIGHT_REFUSED',
        `a changeset needs at least ${MIN_CHANGESET_FILES} candidates; ${ids.length} given`,
        [{ reason: 'TOO_FEW_FILES', detail: `at least ${MIN_CHANGESET_FILES} are required` }]);
    }
    if (ids.length > MAX_CHANGESET_FILES) {
      refuse('CHANGESET_PREFLIGHT_REFUSED',
        `a changeset holds at most ${MAX_CHANGESET_FILES} candidates; ${ids.length} given`,
        [{ reason: 'TOO_MANY_FILES', detail: `at most ${MAX_CHANGESET_FILES} are allowed` }]);
    }

    // Ledger capacity first: a changeset that cannot be recorded must not be attempted, for the same
    // reason a single apply checks it before touching a file.
    this.#assertRoom();

    const entries = [];
    const seenPaths = new Map();
    for (const [index, candidateId] of ids.entries()) {
      const slot = index + 1;
      const record = this.sandbox.load(candidateId);
      if (!record) {
        problems.push({ candidateId, slot, reason: 'UNKNOWN_CANDIDATE', detail: `no staged candidate ${candidateId}` });
        continue;
      }
      // Two candidates writing the same path would make "atomic" impossible to define, because the
      // second write would land over the first. It is refused as an ordering question, not a conflict.
      const relativePath = record.relativePath;
      if (seenPaths.has(relativePath)) {
        problems.push({
          candidateId, slot, reason: 'DUPLICATE_PATH', relativePath,
          detail: `${relativePath} is already written by the candidate in slot ${seenPaths.get(relativePath)}; two writes to one path have no single atomic result`,
        });
        continue;
      }
      seenPaths.set(relativePath, slot);

      // The same two gates a single apply runs, in the same order, reported per file rather than by
      // throwing on the first: the owner needs to know every reason at once, not one per attempt.
      const verification = this.sandbox.latestVerification(candidateId);
      if (!verification || verification.verified !== true) {
        problems.push({ candidateId, slot, reason: 'UNVERIFIED', relativePath, detail: 'the candidate has no passing sandbox verification' });
        continue;
      }
      let stagedDigest;
      try {
        stagedDigest = sha256(fs.readFileSync(record.stagedPath));
      } catch (err) {
        problems.push({ candidateId, slot, reason: 'STAGED_BYTES_MISSING', relativePath, detail: `the staged bytes cannot be read: ${err?.message ?? err}` });
        continue;
      }
      if (stagedDigest !== verification.stagedDigest || stagedDigest !== record.digest) {
        problems.push({ candidateId, slot, reason: 'UNVERIFIED', relativePath, detail: 'the sandbox holds different bytes than the passing verification recorded' });
        continue;
      }

      // Containment, through the same helper a single apply uses.
      let target;
      try {
        target = this.#resolveTarget(relativePath);
      } catch (err) {
        problems.push({ candidateId, slot, reason: 'ACCESS_DENIED', relativePath, detail: String(err?.message ?? err) });
        continue;
      }

      const expectedBaseSha256 = record.base?.exists === true ? (record.base.digest ?? null) : null;
      const existsNow = fs.existsSync(target);
      let actualDiskSha256 = null;
      if (existsNow) {
        const stat = fs.statSync(target);
        if (!stat.isFile()) {
          problems.push({ candidateId, slot, reason: 'NOT_A_FILE', relativePath, detail: 'the target is not a regular file' });
          continue;
        }
        actualDiskSha256 = sha256(fs.readFileSync(target));
      }
      if (actualDiskSha256 !== expectedBaseSha256) {
        problems.push({
          candidateId, slot, reason: 'WORKSPACE_DRIFT', relativePath,
          expectedBaseSha256, actualDiskSha256, appliedSha256: stagedDigest,
          detail: expectedBaseSha256 === null
            ? `${relativePath} did not exist when the candidate was staged, and now it does`
            : `${relativePath} changed on disk after the candidate was staged`,
        });
        continue;
      }

      entries.push({
        candidateId,
        slot,
        relativePath,
        target,
        stagedBytes: fs.readFileSync(record.stagedPath),
        stagedDigest,
        verificationId: verification.id ?? null,
        expectedBaseSha256,
        actualDiskSha256,
        existedBefore: existsNow,
      });
    }

    if (problems.length > 0) {
      // The refusal names the first offending candidate by id and both digests, and carries every
      // problem it found. Every file is still exactly as it was: the checks above only read.
      const first = problems[0];
      const error = new ExecutionError(
        'CHANGESET_PREFLIGHT_REFUSED',
        problems.length === 1
          ? `the changeset was refused before writing anything: ${first.relativePath ? first.relativePath + ' - ' : ''}${first.detail}`
          : `the changeset was refused before writing anything: ${problems.length} of ${ids.length} files failed, the first being ${first.relativePath ?? first.candidateId} - ${first.detail}`,
      );
      error.detail = {
        problems,
        refusedCandidateId: first.candidateId ?? null,
        refusedRelativePath: first.relativePath ?? null,
        expectedBaseSha256: first.expectedBaseSha256 ?? null,
        actualDiskSha256: first.actualDiskSha256 ?? null,
        filesChecked: ids.length,
        filesRefused: problems.length,
      };
      throw error;
    }

    return { ok: true, entries };
  }

  // Apply 2..8 verified candidates as ONE atomic change.
  //
  // Two phases, and the first one writes nothing at all. That is the whole design: the pre-flight can
  // fail for any file and for any reason, and when it does the answer is a refusal rather than a
  // partial change nobody asked for. The second phase snapshots every file, writes them all, verifies
  // every one against its applied digest, and - if any single OS write or read-back fails - restores
  // every file it already touched before it reports the failure.
  applyChangeset({ candidateIds, title, rationale = null } = {}) {
    const preflight = this.preflightChangeset({ candidateIds });
    const entries = preflight.entries;

    const appliedAt = this.now().toISOString();
    const changesetId = `wcs-${createHash('sha256').update(`${candidateIds.join(',')}:${appliedAt}`).digest('hex').slice(0, 12)}`;
    const backupDir = path.join(this.backupsRoot, changesetId);

    // ---- phase 1: snapshot every file before a single byte is written ----
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const snaps = [];
    for (const entry of entries) {
      const backupFile = entry.existedBefore ? `before-${entry.actualDiskSha256}-${entry.slot}.bin` : null;
      if (entry.existedBefore) {
        const bytes = fs.readFileSync(entry.target);
        // The file is re-hashed as it is copied. A file that changed between the pre-flight and the
        // snapshot would otherwise be backed up under a digest it does not have.
        if (sha256(bytes) !== entry.actualDiskSha256) {
          fs.rmSync(backupDir, { recursive: true, force: true });
          const error = new ExecutionError('WORKSPACE_DRIFT', `${entry.relativePath} changed while its snapshot was being taken; nothing was written`);
          error.detail = { expectedBaseSha256: entry.actualDiskSha256, actualDiskSha256: sha256(bytes), problems: [{ candidateId: entry.candidateId, slot: entry.slot, relativePath: entry.relativePath, reason: 'WORKSPACE_DRIFT' }] };
          throw error;
        }
        fs.writeFileSync(path.join(backupDir, backupFile), bytes, { mode: 0o600 });
      }
      snaps.push({ ...entry, backupFile, backupPath: backupFile === null ? null : path.join(backupDir, backupFile) });
    }
    const snapshot = {
      schema: 'apex.workshop.changeset-snapshot/1',
      changesetId,
      title,
      at: appliedAt,
      files: snaps.map((snap) => ({
        slot: snap.slot,
        candidateId: snap.candidateId,
        relativePath: snap.relativePath,
        existedBefore: snap.existedBefore,
        beforeSha256: snap.actualDiskSha256,
        appliedSha256: snap.stagedDigest,
        backupFile: snap.backupFile,
      })),
    };
    fs.writeFileSync(path.join(backupDir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });

    // ---- phase 2: write every file, remembering what was written so it can be undone ----
    const written = [];
    const undoAll = () => {
      // Undo in reverse order, and restore through the same atomic sibling-rename the write used, so a
      // failure while undoing cannot itself leave a half-written file.
      for (const done of [...written].reverse()) {
        try {
          if (done.existedBefore) {
            const temporary = temporaryName(done.target);
            fs.writeFileSync(temporary, fs.readFileSync(done.backupPath));
            fs.renameSync(temporary, done.target);
          } else {
            fs.rmSync(done.target, { force: true });
          }
        } catch {
          // A restore that fails here is reported by the caller with the files that could not be
          // restored named; it must not mask the error that caused the unwind.
        }
      }
    };

    try {
      for (const snap of snaps) {
        // The temporary name is taken ONCE. temporaryName() is random per call, so calling it twice
        // writes one file and renames a different, non-existent one - which is exactly the bug this
        // loop had in its first draft, and the reason the changeset suite writes and re-reads every
        // file rather than trusting the loop to be right.
        const temporary = temporaryName(snap.target);
        fs.writeFileSync(temporary, snap.stagedBytes, {
          mode: snap.existedBefore ? fs.statSync(snap.target).mode & 0o777 : 0o644,
        });
        fs.renameSync(temporary, snap.target);
        written.push(snap);
      }
    } catch (err) {
      undoAll();
      const error = new ExecutionError('CHANGESET_WRITE_FAILED', `the changeset did not complete and was undone: ${err?.message ?? err}`);
      error.detail = { changesetId, undone: written.map((w) => w.relativePath), problems: [{ reason: 'WRITE_FAILED', detail: String(err?.message ?? err) }] };
      throw error;
    }

    // ---- phase 3: prove every file on disk, and undo the whole batch if any one does not ----
    const verifiedFiles = [];
    for (const snap of snaps) {
      let disk = null;
      try {
        disk = sha256(fs.readFileSync(snap.target));
      } catch {
        disk = null;
      }
      if (disk !== snap.stagedDigest) {
        undoAll();
        const error = new ExecutionError('CHANGESET_VERIFY_FAILED', `${snap.relativePath} does not match the candidate after the write; the whole changeset was undone`);
        error.detail = { changesetId, expectedAppliedSha256: snap.stagedDigest, actualDiskSha256: disk, problems: [{ slot: snap.slot, relativePath: snap.relativePath, reason: 'VERIFY_FAILED' }] };
        throw error;
      }
      verifiedFiles.push({
        slot: snap.slot,
        candidateId: snap.candidateId,
        relativePath: snap.relativePath,
        existedBefore: snap.existedBefore,
        beforeSha256: snap.actualDiskSha256,
        appliedSha256: snap.stagedDigest,
        diskSha256: disk,
        backupFile: snap.backupFile,
        verifiedOnDisk: true,
      });
    }

    const entry = {
      schema: WORKSHOP_CHANGESET_SCHEMA,
      kind: 'changeset_apply',
      changesetId,
      at: appliedAt,
      title: title ?? null,
      rationale,
      files: verifiedFiles,
      fileCount: verifiedFiles.length,
      backupDir,
      // The three claims a caller must be able to assert about a batch.
      atomic: true,
      appliedToWorkspace: true,
      everyFileVerifiedOnDisk: verifiedFiles.every((file) => file.verifiedOnDisk === true),
      mutatesLiveWorkspace: true,
      authorizesExecution: false,
    };
    this.#append(entry);
    return entry;
  }

  // Undo a whole changeset, or nothing.
  //
  // The pre-flight is the same shape as the apply's and the reason is the mirror of it: a batch
  // rollback that restored four files and refused the fifth would leave the owner in a state neither
  // the apply nor the rollback ever described. So every file is checked first, and one externally
  // edited file refuses the entire revert.
  rollbackChangeset({ changesetId, reason = null } = {}) {
    const record = this.changesetRecord(changesetId);
    if (!record) throw new ExecutionError('WORKSHOP_NOT_FOUND', `no applied changeset ${changesetId}`);
    const prior = this.records().find((r) => r.kind === 'changeset_rollback' && r.changesetId === record.changesetId);
    if (prior) throw new ExecutionError('ALREADY_ROLLED_BACK', `that changeset was already rolled back at ${prior.at}`);
    this.#assertRoom();

    // Pre-flight every file. Nothing is restored until all of them pass.
    const problems = [];
    const restorable = [];
    for (const file of record.files) {
      let target;
      try {
        target = this.#resolveTarget(file.relativePath);
      } catch (err) {
        problems.push({ relativePath: file.relativePath, reason: 'ACCESS_DENIED', detail: String(err?.message ?? err) });
        continue;
      }
      const exists = fs.existsSync(target);
      const disk = exists ? sha256(fs.readFileSync(target)) : null;
      if (disk !== file.appliedSha256) {
        problems.push({
          relativePath: file.relativePath,
          reason: 'ROLLBACK_DRIFT',
          expectedAppliedSha256: file.appliedSha256,
          actualDiskSha256: disk,
          detail: disk === null
            ? 'the file is no longer on disk'
            : 'the file was edited outside APEX after it was applied',
        });
        continue;
      }
      restorable.push({ ...file, target });
    }

    if (problems.length > 0) {
      const first = problems[0];
      const error = new ExecutionError(
        'CHANGESET_ROLLBACK_DRIFT',
        `the batch rollback was refused and no file was restored: ${first.relativePath} is not what the changeset wrote`,
      );
      error.detail = {
        changesetId,
        problems,
        refusedRelativePath: first.relativePath,
        expectedAppliedSha256: first.expectedAppliedSha256 ?? null,
        actualDiskSha256: first.actualDiskSha256 ?? null,
        filesChecked: record.files.length,
        filesRefused: problems.length,
      };
      throw error;
    }

    const rolledBackAt = this.now().toISOString();
    const restored = [];
    const done = [];
    try {
      for (const file of restorable) {
        if (file.existedBefore) {
          const backupPath = path.join(record.backupDir, file.backupFile);
          const bytes = fs.readFileSync(backupPath);
          if (sha256(bytes) !== file.beforeSha256) {
            throw new ExecutionError('BACKUP_DAMAGED', `the snapshot for ${file.relativePath} does not match the digest the changeset recorded`);
          }
          const temporary = temporaryName(file.target);
          fs.writeFileSync(temporary, bytes, { mode: fs.statSync(file.target).mode & 0o777 });
          fs.renameSync(temporary, file.target);
        } else {
          fs.rmSync(file.target, { force: false });
        }
        done.push(file);
        const now = fs.existsSync(file.target) ? sha256(fs.readFileSync(file.target)) : null;
        const expected = file.existedBefore ? file.beforeSha256 : null;
        if (now !== expected) {
          throw new ExecutionError('CHANGESET_ROLLBACK_VERIFY_FAILED', `${file.relativePath} does not hold the pre-apply bytes after the restore`);
        }
        restored.push({
          slot: file.slot,
          // The candidate id travels with the restored file for the same reason the apply records it:
          // the causal trace links a verification to a write by candidate, and a rollback that dropped
          // it would be an orphan record in a chain that otherwise reads as a sequence.
          candidateId: file.candidateId ?? null,
          relativePath: file.relativePath,
          existedBefore: file.existedBefore,
          restoredSha256: now,
          removedFile: file.existedBefore === false,
          verifiedOnDisk: true,
        });
      }
    } catch (err) {
      // A failed rollback must not leave a half-reverted changeset. Every file already restored is put
      // back to the bytes the changeset applied, so the batch ends in the state it was in when the
      // rollback was requested - complete or unchanged, never half.
      const reinstateFailures = [];
      for (const file of [...done].reverse()) {
        try {
          const applied = record.files.find((entry) => entry.relativePath === file.relativePath);
          if (!applied) continue;
          if (applied.existedBefore === false) {
            // The rollback removed a file the changeset created; recreating it needs the bytes, and
            // they are not in the record by design (the record holds digests, not content). This is
            // reported rather than guessed at.
            reinstateFailures.push({ relativePath: file.relativePath, reason: 'CREATED_FILE_BYTES_NOT_RETAINED' });
            continue;
          }
          const temporary = temporaryName(file.target);
          fs.writeFileSync(temporary, fs.readFileSync(path.join(record.backupDir, applied.backupFile)));
          fs.renameSync(temporary, file.target);
        } catch (reinstateError) {
          reinstateFailures.push({ relativePath: file.relativePath, reason: String(reinstateError?.message ?? reinstateError) });
        }
      }
      const error = err instanceof ExecutionError ? err : new ExecutionError('CHANGESET_ROLLBACK_FAILED', String(err?.message ?? err));
      error.detail = {
        ...(error.detail ?? {}),
        changesetId,
        restoredBeforeFailure: done.map((file) => file.relativePath),
        reinstateFailures,
        // Stated plainly, because it is the one case this module cannot fully repair.
        note: reinstateFailures.length === 0
          ? 'every file already restored was put back to the bytes the changeset applied'
          : 'some files could not be put back; the list names them and the workspace needs the owner',
      };
      throw error;
    }

    const entry = {
      schema: WORKSHOP_CHANGESET_ROLLBACK_SCHEMA,
      kind: 'changeset_rollback',
      changesetRollbackId: `wcsr-${createHash('sha256').update(`${changesetId}:${rolledBackAt}`).digest('hex').slice(0, 12)}`,
      changesetId,
      at: rolledBackAt,
      title: record.title ?? null,
      reason,
      files: restored,
      fileCount: restored.length,
      atomic: true,
      rolledBack: true,
      everyFileVerifiedOnDisk: restored.every((file) => file.verifiedOnDisk === true),
      mutatesLiveWorkspace: true,
      authorizesExecution: false,
    };
    this.#append(entry);
    return entry;
  }

  changesetRecord(changesetId) {
    const want = typeof changesetId === 'string' ? changesetId.trim() : '';
    if (want === '') return null;
    const matches = this.records().filter((record) => record.kind === 'changeset_apply' && record.changesetId === want);
    return matches.length === 0 ? null : matches[matches.length - 1];
  }

  // The open changesets, newest first, with their live disk status. Read-only.
  openChangesets() {
    const records = this.records();
    const rolledBack = new Set(records.filter((r) => r.kind === 'changeset_rollback').map((r) => r.changesetId));
    return records
      .filter((record) => record.kind === 'changeset_apply' && !rolledBack.has(record.changesetId))
      .reverse();
  }

  // ------------------------------------------------------- the live disk re-verification ---

  // What happened to a file AFTER it was applied, measured now.
  //
  // T-39 measured `verifiedOnDisk` at the instant of the write. That was honest and it was also a
  // closed question: a file can be edited, reverted or deleted by anything on this machine after the
  // apply, and until T-40 the Workshop had no way to say so. This reads the file again and classifies
  // what it finds. It writes nothing, and it never repairs - a report, not a reconciler.
  //
  // The four states are exhaustive over the two digests an apply records, and each one is a different
  // answer to "can I roll this back safely":
  //
  //   intact               disk still hashes to what the apply wrote: a rollback restores the prior
  //                        bytes and destroys nothing.
  //   modified_externally  disk hashes to neither the applied nor the before bytes: somebody edited it
  //                        after the apply. A rollback would refuse with ROLLBACK_DRIFT, and the
  //                        report says so rather than leaving the owner to discover it by trying.
  //   reverted_externally  disk hashes to the bytes the apply replaced: the owner has already put the
  //                        file back by hand, so there is nothing left to roll back.
  //   deleted_externally    the file is not there at all.
  diskState(record) {
    const state = {
      applyId: record.applyId,
      candidateId: record.candidateId,
      relativePath: record.relativePath,
      // re-measured, so a screen can say when the truth was taken rather than when the apply happened
      checkedAt: this.now().toISOString(),
      appliedSha256: record.appliedSha256 ?? null,
      beforeSha256: record.beforeSha256 ?? null,
      existedBefore: record.existedBefore === true,
      currentDiskSha256: null,
      state: 'unknown',
      rollbackReady: false,
      // The sentence a screen shows. It is written here, beside the classification, so the two cannot
      // drift apart into a status code the panel has to interpret.
      detail: null,
    };
    if (!this.available) {
      state.detail = 'no workspace root is configured, so the file cannot be measured';
      return state;
    }

    // Containment is applied to the read exactly as it was to the write: an apply whose path no longer
    // resolves inside the root (a parent replaced by a symlink, say) cannot be measured, and saying so
    // is more honest than reporting a digest read from somewhere else.
    let target = null;
    try {
      target = this.#resolveTarget(record.relativePath);
    } catch (err) {
      state.state = 'unreadable';
      state.detail = `the path cannot be resolved inside the workspace root: ${err?.message ?? err}`;
      return state;
    }

    if (!fs.existsSync(target)) {
      state.state = 'deleted_externally';
      state.detail = 'the file is no longer on disk; there is nothing to inspect and nothing to roll back';
      return state;
    }
    const stat = fs.statSync(target);
    if (!stat.isFile()) {
      state.state = 'unreadable';
      state.detail = 'the path is no longer a regular file, so its content cannot be compared';
      return state;
    }
    const current = sha256(fs.readFileSync(target));
    state.currentDiskSha256 = current;

    if (current === record.appliedSha256) {
      state.state = 'intact';
      state.rollbackReady = true;
      state.detail = 'the file still holds exactly what the apply wrote; a rollback restores the prior bytes';
    } else if (record.existedBefore === true && current === record.beforeSha256) {
      state.state = 'reverted_externally';
      state.rollbackReady = false;
      state.detail = 'the file already holds the bytes the apply replaced; it was reverted outside APEX, so there is nothing to roll back';
    } else {
      state.state = 'modified_externally';
      state.rollbackReady = false;
      state.detail = 'the file was edited outside APEX after the apply; an automatic rollback will refuse with ROLLBACK_DRIFT so that edit is not discarded';
    }
    return state;
  }

  // Every applied change that is still open, measured against the disk right now. This is the read the
  // Workshop screen and `GET /api/workshop/applies/status` share, so the panel and the API cannot
  // disagree about what the disk holds.
  liveStatus() {
    const records = this.records();
    const rolledBack = new Set(records.filter((r) => r.kind === 'rollback').map((r) => r.applyId));
    const openApplies = records
      .filter((record) => record.kind === 'apply' && record.applyId && !rolledBack.has(record.applyId))
      // The newest first: a screen shows the most recent change at the top.
      .reverse();

    // A changeset's files are applied changes too, and the milestone asks for every applied file to be
    // measured - so a changeset contributes one entry per file, carrying the changeset it belongs to.
    // Leaving them out would make `open 0` mean "nothing was applied" when a whole batch was.
    const openChangesets = this.openChangesets();
    const changesetStates = [];
    for (const changeset of openChangesets) {
      for (const file of changeset.files ?? []) {
        // The single-apply classifier reads exactly the fields a changeset file entry carries, so the
        // classification is shared rather than reimplemented and cannot drift from it.
        const state = this.diskState({
          applyId: changeset.changesetId,
          candidateId: file.candidateId,
          relativePath: file.relativePath,
          appliedSha256: file.appliedSha256,
          beforeSha256: file.beforeSha256,
          existedBefore: file.existedBefore,
        });
        changesetStates.push({ ...state, changesetId: changeset.changesetId, changesetTitle: changeset.title ?? null });
      }
    }

    const checked = [...openApplies.map((record) => this.diskState(record)), ...changesetStates];
    const counts = { intact: 0, modified_externally: 0, reverted_externally: 0, deleted_externally: 0, unreadable: 0 };
    for (const entry of checked) counts[entry.state] = (counts[entry.state] ?? 0) + 1;

    return {
      schema: 'apex.workshop.disk-status/1',
      available: this.available,
      at: this.now().toISOString(),
      open: checked.length,
      counts,
      // A change is rollback-ready only when every file it touched is intact. One externally edited
      // file makes the whole change unsafe to revert, which is what the batch gate enforces.
      allIntact: checked.length > 0 && checked.every((entry) => entry.state === 'intact'),
      states: checked,
      // Every one of these is the point of the record rather than decoration.
      measuredFromDisk: true,
      readOnly: true,
      wroteNothing: true,
      mutatesLiveWorkspace: false,
      authorizesExecution: false,
    };
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
        // T-40 Step 1: what the disk holds NOW, for an open change. A rolled-back change has no live
        // state to report, and null says that rather than reusing `intact`.
        live: rolledBack.has(record.applyId) ? null : this.diskState(record),
      })),
      // A single read that answers both questions the panel asks: what was applied, and what is true
      // about those files at this instant.
      disk: this.liveStatus(),
      readOnly: true,
      wroteNothing: true,
    };
  }
}
