// T-43 Package 1 (2026-11-19): the governed git executive and its non-destructive checkpoint engine.
//
// The owner's real workspace is a git repository, and until now APEX could read a branch name and a
// dirty count from it and nothing else. This module is the deeper reading, and the one thing APEX may
// safely *write* into that tree: a checkpoint, which records what the tree looked like without
// changing it.
//
// Three properties govern the whole file.
//
//   1. **No shell, ever.** Every git call goes through `execFileSync('git', args, { shell: false })`
//      with an explicit argument array, a 3000 ms timeout, and a bounded buffer. Nothing is
//      interpolated into a string a shell would parse, so a ref that contains a semicolon is a ref,
//      not a command.
//
//   2. **Arguments are validated, not escaped.** A git ref is matched against a closed charset
//      (`REF_RE`) and anything beginning with `-` is refused outright. The second rule matters more
//      than the first: `--output=/tmp/x` is a perfectly ordinary-looking string, and it is an
//      option injection if it ever reaches `git` as an argument. Validation happens before the call,
//      so there is no path by which a caller's string becomes a flag.
//
//   3. **Paths are contained, not normalised by string.** A `targetPath` is resolved with
//      `realpathSync` and compared against the realpath of the workspace root. A `..` and a symlink
//      pointing outside the tree are the same escape and get the same refusal.
//
// The checkpoint is non-destructive by construction: `git stash create` builds a commit object and
// prints its SHA without touching the working tree or the index, and `update-ref` writes a ref. If the
// tree is clean relative to HEAD there is nothing to snapshot, so HEAD itself is the snapshot commit.
// Restoring is the only operation that writes to the tree, and it refuses to run over uncommitted work
// that is not already the checkpoint's own content.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ValidationError } from '../errors.js';

export const GIT_EXECUTIVE_SCHEMA = 'apex.git-executive/1';
export const GIT_CHECKPOINT_SCHEMA = 'apex.git-checkpoint/1';

// The git invocation bounds. A git call that has not finished in three seconds is not going to
// answer a question the deck is waiting on.
export const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;

// A git ref, as this module accepts one. The charset is deliberately narrower than git's own: it
// admits the revision syntax an owner types (`HEAD`, `main`, `origin/main`, `HEAD~2`, `v1.0.0`, a full
// SHA) and nothing else. A leading `-` is excluded by the first rule below as well, so the two checks
// overlap on purpose - defence that depends on one regex being exactly right is not defence.
const REF_RE = /^[A-Za-z0-9._/~^-]{1,120}$/;
const LABEL_RE = /^[\w .,:;()\-/]{1,120}$/;
const CHECKPOINT_ID_RE = /^chk_[a-z0-9]{8,40}$/;
const DEFAULT_DIFF_MAX_BYTES = 65536;
const MAX_DIFF_MAX_BYTES = 1024 * 1024;
const RECENT_COMMIT_LIMIT = 10;

const CHECKPOINT_REF_PREFIX = 'refs/apex-checkpoints/';

// ------------------------------------------------------------------------------- validation ---

export class GitRefusal extends ValidationError {
  constructor(code, message, detail = null) {
    super(message, code);
    this.name = 'GitRefusal';
    this.detail = detail;
  }
}

function refused(code, message, detail = null) {
  return new GitRefusal(code, message, detail);
}

// A single git argument that may be a ref. Refuses a leading dash before it looks at anything else:
// that is the option-injection shape, and it is refused as an argument problem rather than as a
// ref-syntax problem so the caller is told which rule it broke.
export function validateGitRef(value, { label = 'ref', allowEmpty = false } = {}) {
  if (value === undefined || value === null) {
    if (allowEmpty) return null;
    throw refused('INVALID_GIT_ARGUMENT', `${label} is required`);
  }
  if (typeof value !== 'string') throw refused('INVALID_GIT_ARGUMENT', `${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (allowEmpty) return null;
    throw refused('INVALID_GIT_ARGUMENT', `${label} must be a non-empty string`);
  }
  if (trimmed.startsWith('-')) {
    throw refused('INVALID_GIT_ARGUMENT', `${label} may not begin with "-": ${trimmed.slice(0, 40)}`);
  }
  if (!REF_RE.test(trimmed)) {
    throw refused('INVALID_GIT_ARGUMENT', `${label} contains characters a git ref may not: ${trimmed.slice(0, 40)}`);
  }
  return trimmed;
}

export function validateLabel(value) {
  if (typeof value !== 'string') throw refused('INVALID_INPUT', 'label must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) throw refused('INVALID_INPUT', 'label must be a non-empty string');
  if (trimmed.length > 120) throw refused('INVALID_INPUT', 'label must be at most 120 characters');
  if (!LABEL_RE.test(trimmed)) throw refused('INVALID_INPUT', 'label may contain letters, digits, spaces and . , : ; ( ) - / only');
  return trimmed;
}

export function validateCheckpointId(value) {
  if (typeof value !== 'string' || !CHECKPOINT_ID_RE.test(value.trim())) {
    throw refused('INVALID_INPUT', 'checkpointId must look like chk_<hex>');
  }
  return value.trim();
}

// A path inside the workspace. The check is on the *real* path, so `a/../b`, an absolute path, and a
// symlink that leaves the tree are all the same refusal.
export function resolveInside(root, targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw refused('INVALID_INPUT', 'targetPath must be a non-empty string');
  }
  const raw = targetPath.trim();
  if (raw.startsWith('-')) {
    throw refused('INVALID_GIT_ARGUMENT', `targetPath may not begin with "-": ${raw.slice(0, 40)}`);
  }
  // A NUL byte cannot be in a path and would truncate it if it reached the OS.
  if (raw.includes('\u0000')) throw refused('INVALID_INPUT', 'targetPath contains a NUL byte');

  const rootReal = fs.realpathSync(root);
  const absolute = path.isAbsolute(raw) ? raw : path.join(rootReal, raw);
  // The file may not exist yet (a candidate for a new file), so the *nearest existing ancestor* is
  // what gets resolved. Resolving the literal path would throw ENOENT for a legitimate new file.
  let probe = absolute;
  const suffix = [];
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      const resolved = suffix.length === 0 ? real : path.join(real, ...suffix);
      const relative = path.relative(rootReal, resolved);
      if (relative === '') return { absolute: rootReal, relativePath: '' };
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw refused('WORKSPACE_PATH_ESCAPE', `the path resolves outside the workspace: ${raw.slice(0, 80)}`, { workspaceRoot: rootReal });
      }
      return { absolute: resolved, relativePath: relative.split(path.sep).join('/') };
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      if (err?.code !== 'ENOENT') throw refused('INVALID_INPUT', `the path could not be resolved: ${raw.slice(0, 80)}`);
      const parent = path.dirname(probe);
      if (parent === probe) throw refused('WORKSPACE_PATH_ESCAPE', `the path resolves outside the workspace: ${raw.slice(0, 80)}`, { workspaceRoot: rootReal });
      suffix.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

// ----------------------------------------------------------------------------------- the run ---

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function short(sha) {
  return typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : (sha ?? null);
}

// The unified-diff parser. Exported because the parse is the part worth testing on its own, and
// because a hunk header is exactly the kind of thing that is easy to get subtly wrong.
export function parseUnifiedDiff(rawText) {
  const hunks = [];
  let additions = 0;
  let deletions = 0;
  if (typeof rawText !== 'string' || rawText.length === 0) return { hunks, additions, deletions };
  const lines = rawText.split('\n');
  let current = null;
  // The two line counters are independent: a hunk's old side and new side advance at different rates
  // through context, adds and deletes.
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (header) {
      current = {
        header: line,
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        section: header[5].trim() || null,
        lines: [],
      };
      hunks.push(current);
      oldLine = current.oldStart;
      newLine = current.newStart;
      continue;
    }
    if (current === null) continue;
    // `\ No newline at end of file` is a marker, not a line of content.
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      current.lines.push({ type: 'add', oldLine: null, newLine, text: line.slice(1) });
      newLine += 1;
      additions += 1;
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'del', oldLine, newLine: null, text: line.slice(1) });
      oldLine += 1;
      deletions += 1;
    } else if (line.startsWith(' ')) {
      current.lines.push({ type: 'ctx', oldLine, newLine, text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
    // Anything else (the `diff --git` preamble, `index`, `---`/`+++` headers) ends the current hunk's
    // line stream but does not close the hunk: a second `@@` starts a new one regardless.
  }
  return { hunks, additions, deletions };
}

// One git invocation. `git` may be injected for a test; the default is the real binary. The argument
// array is passed as an array - there is no string form of this call anywhere in the file.
function gitRunner({ git = null, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  if (typeof git === 'function') return git;
  return (args, cwd) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: GIT_MAX_BUFFER,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

// A git failure that means "this is not a repository" rather than "git is broken".
function isNotARepo(err) {
  const text = `${err?.stderr ?? ''}${err?.message ?? ''}`;
  return /not a git repository/i.test(text) || /not a git repo/i.test(text);
}

export class GitExecutive {
  #root;
  #dataDir;
  #now;
  #git;
  #idFactory;
  #operations;
  #clock;

  constructor({ workspaceRoot, dataDir, now = () => new Date(), git = null, idFactory = null, operations = null } = {}) {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
      throw new TypeError('the git executive needs a workspace root');
    }
    if (typeof dataDir !== 'string' || dataDir.length === 0) {
      throw new TypeError('the git executive needs a data directory');
    }
    this.#root = workspaceRoot;
    this.#dataDir = dataDir;
    this.#now = now;
    this.#git = gitRunner({ git });
    this.#idFactory = idFactory ?? (() => createHash('sha256')
      .update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16));
    // T-43: an injectable operation ledger, so a test can read the record it just caused without
    // reaching into the app. In the running system this is the same `operations.jsonl` writer the
    // rest of APEX uses.
    this.#operations = typeof operations === 'function' ? operations : null;
    this.#clock = now;
  }

  get workspaceRoot() { return this.#root; }
  get checkpointsPath() { return path.join(this.#dataDir, 'git-checkpoints.json'); }

  // Run git, and turn a thrown call into a typed shape rather than an exception the caller must
  // guess at. `ok: false` always carries the reason.
  #run(args, { cwd = this.#root } = {}) {
    try {
      const stdout = this.#git(args, cwd);
      return { ok: true, stdout: typeof stdout === 'string' ? stdout : String(stdout ?? '') };
    } catch (err) {
      return {
        ok: false,
        notARepo: isNotARepo(err),
        status: typeof err?.status === 'number' ? err.status : null,
        stderr: typeof err?.stderr === 'string' ? err.stderr : '',
        message: err?.message ?? 'git failed',
      };
    }
  }

  // ------------------------------------------------------------------------------ status ---

  statusDetailed() {
    // `rev-parse --git-dir` is the cheapest honest test of "is this a repository": it does not depend
    // on a commit existing, and it fails with the not-a-repository message this module recognises.
    const probe = this.#run(['rev-parse', '--git-dir']);
    if (!probe.ok) {
      // A git binary that is missing and a directory that is not a repository are different facts and
      // are reported differently; neither throws, because "there is no repository here" is an answer.
      const gitMissing = /ENOENT|not recognized|command not found/i.test(`${probe.message}`);
      return {
        verified: true,
        available: true,
        isRepo: false,
        reason: gitMissing ? 'git_unavailable' : 'not_a_git_repository',
        workspaceRoot: this.#root,
        branch: null,
        headSha: null,
        ahead: null,
        behind: null,
        staged: [],
        unstaged: [],
        untracked: [],
        recentCommits: [],
        checkpointsCount: 0,
      };
    }

    const branchRun = this.#run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchRun.ok ? branchRun.stdout.trim() : null;
    const headRun = this.#run(['rev-parse', 'HEAD']);
    const headSha = headRun.ok ? headRun.stdout.trim() : null;

    // Ahead/behind needs an upstream. A repository with no upstream is not an error; it is a
    // repository with nothing to compare against, and the count is reported as null rather than 0.
    let ahead = null;
    let behind = null;
    if (headSha !== null) {
      const counts = this.#run(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
      if (counts.ok) {
        const [behindText, aheadText] = counts.stdout.trim().split(/\s+/);
        const parsedBehind = Number(behindText);
        const parsedAhead = Number(aheadText);
        behind = Number.isFinite(parsedBehind) ? parsedBehind : null;
        ahead = Number.isFinite(parsedAhead) ? parsedAhead : null;
      }
    }

    const staged = [];
    const unstaged = [];
    const untracked = [];
    const statusRun = this.#run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (statusRun.ok) {
      // `-z` separates records with NUL and does not quote paths, which is the only form in which a
      // path containing a newline or a space survives the trip intact.
      const records = statusRun.stdout.split('\u0000').filter((entry) => entry.length > 0);
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (record.length < 4) continue;
        const indexStatus = record[0];
        const worktreeStatus = record[1];
        const relativePath = record.slice(3);
        if (indexStatus === '?' && worktreeStatus === '?') {
          untracked.push(relativePath);
          continue;
        }
        // A rename carries its original path as the following NUL-separated record.
        if (indexStatus === 'R' || indexStatus === 'C') index += 1;
        if (indexStatus !== ' ' && indexStatus !== '?') staged.push({ path: relativePath, indexStatus });
        if (worktreeStatus !== ' ' && worktreeStatus !== '?') unstaged.push({ path: relativePath, worktreeStatus });
      }
    }

    const recentCommits = [];
    const logRun = this.#run(['log', `-${RECENT_COMMIT_LIMIT}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI']);
    if (logRun.ok) {
      for (const line of logRun.stdout.split('\n')) {
        if (line.trim() === '') continue;
        const [sha, shortSha, subject, author, committedAt] = line.split('\u001f');
        if (!sha) continue;
        recentCommits.push({
          sha,
          shortSha: shortSha ?? short(sha),
          subject: subject ?? '',
          author: author ?? '',
          committedAt: committedAt ?? null,
        });
      }
    }

    const checkpoints = this.listCheckpoints();
    return {
      verified: true,
      available: true,
      isRepo: true,
      workspaceRoot: this.#root,
      branch,
      headSha,
      ahead,
      behind,
      staged,
      unstaged,
      untracked,
      recentCommits,
      checkpointsCount: checkpoints.length,
    };
  }

  // -------------------------------------------------------------------------------- diff ---

  diffInspect({ targetPath = null, baseRef = 'HEAD', staged = false, maxBytes = DEFAULT_DIFF_MAX_BYTES } = {}) {
    const ref = validateGitRef(baseRef, { label: 'baseRef', allowEmpty: true }) ?? 'HEAD';
    const bounded = Number.isInteger(maxBytes) ? Math.min(Math.max(maxBytes, 1), MAX_DIFF_MAX_BYTES) : DEFAULT_DIFF_MAX_BYTES;

    const status = this.statusDetailed();
    if (status.isRepo !== true) {
      return {
        verified: true,
        available: true,
        isRepo: false,
        reason: status.reason,
        targetPath: targetPath ?? null,
        baseRef: ref,
        staged: staged === true,
        additions: 0,
        deletions: 0,
        hunks: [],
        rawDiff: '',
        truncated: false,
        sha256: sha256(''),
      };
    }

    const args = ['diff', '--no-color', '--no-ext-diff', '--unified=3'];
    if (staged === true) args.push('--cached');
    args.push(ref);
    let relative = null;
    if (targetPath !== null && targetPath !== undefined) {
      const resolved = resolveInside(this.#root, targetPath);
      relative = resolved.relativePath;
      // `--` ends option parsing. Even with validation upstream this is the right call: it states to
      // git that the next argument is a path and can never be read as a flag.
      args.push('--', relative);
    }

    const run = this.#run(args);
    const raw = run.ok ? run.stdout : '';
    const truncated = raw.length > bounded;
    const rawDiff = truncated ? raw.slice(0, bounded) : raw;
    const parsed = parseUnifiedDiff(rawDiff);
    return {
      verified: true,
      available: true,
      isRepo: true,
      targetPath: relative,
      baseRef: ref,
      staged: staged === true,
      additions: parsed.additions,
      deletions: parsed.deletions,
      hunks: parsed.hunks,
      rawDiff,
      truncated,
      sha256: sha256(rawDiff),
    };
  }

  // --------------------------------------------------------------------------- checkpoints ---

  #readLedger() {
    let text;
    try {
      text = fs.readFileSync(this.checkpointsPath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return { present: false, checkpoints: [], corrupt: 0 };
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A corrupt file is reported as corrupt, never replaced by an empty list as though nothing had
      // ever been checkpointed.
      return { present: true, checkpoints: [], corrupt: 1, unreadable: true };
    }
    const list = Array.isArray(parsed?.checkpoints) ? parsed.checkpoints : [];
    return { present: true, checkpoints: list.filter((entry) => entry && typeof entry === 'object'), corrupt: 0 };
  }

  #writeLedger(checkpoints) {
    const temporary = `${this.checkpointsPath}.${process.pid}.tmp`;
    const body = JSON.stringify({ schema: GIT_CHECKPOINT_SCHEMA, checkpoints }, null, 2);
    fs.writeFileSync(temporary, `${body}\n`, 'utf8');
    fs.renameSync(temporary, this.checkpointsPath);
  }

  #recordOperation(entry) {
    if (this.#operations === null) return;
    try {
      this.#operations(entry);
    } catch {
      // The checkpoint is already durable; a ledger failure must not make the caller believe the
      // checkpoint was not created.
    }
  }

  listCheckpoints() {
    const ledger = this.#readLedger();
    if (ledger.unreadable === true) return [];
    return ledger.checkpoints.map((entry) => {
      // `refIntact` is measured now, not remembered: a checkpoint whose ref was deleted or moved is
      // reported as drifted, which is exactly the fact an owner needs before trusting a restore.
      const refName = typeof entry.refName === 'string' ? entry.refName : `${CHECKPOINT_REF_PREFIX}${entry.checkpointId}`;
      const live = this.#run(['rev-parse', '--verify', '--quiet', refName]);
      const liveSha = live.ok ? live.stdout.trim() : null;
      return {
        ...entry,
        refIntact: liveSha !== null && liveSha === entry.commitSha,
        liveCommitSha: liveSha,
      };
    });
  }

  // Whether the worktree and the index both hold a given commit's content.
  //
  // The comparison is restricted to the paths the snapshot CONTAINS, and that restriction is the
  // correctness of the check rather than a convenience. `git checkout <sha> -- .` writes every path the
  // snapshot has; it does not delete a file created after the checkpoint, because a restore that
  // silently removed files would be a far larger act than the one the owner confirmed. So a file
  // added after the checkpoint is present and is *not* a failure - while a snapshot path whose content
  // differs IS. Files outside the snapshot are reported as `extraPaths` so the owner can see what the
  // restore left alone instead of having to infer it.
  #restoredState(commitSha) {
    const snapshotTree = this.#run(['rev-parse', `${commitSha}^{tree}`]);
    const listing = this.#run(['ls-tree', '-r', '--name-only', commitSha]);
    if (!snapshotTree.ok || !listing.ok) {
      return { verified: false, worktreeMatches: false, indexMatches: false, treeSha: null, differingPaths: [], extraPaths: [], inspected: false };
    }
    const owned = new Set(listing.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0));
    const changed = (args) => {
      const run = this.#run(args);
      // A failed `diff --name-only` is a failed read, not "no difference". Saying the tree matches when
      // the comparison never ran would be the one verdict this method must never give.
      if (!run.ok) return { read: false, paths: [] };
      return { read: true, paths: run.stdout.split('\n').map((line) => line.trim()).filter((line) => owned.has(line)) };
    };
    const worktree = changed(['diff', '--name-only', commitSha, '--', '.']);
    const index = changed(['diff', '--cached', '--name-only', commitSha, '--', '.']);
    const worktreeMatches = worktree.read && worktree.paths.length === 0;
    const indexMatches = index.read && index.paths.length === 0;
    // Everything the worktree holds that the snapshot does not, so "what the restore did not touch" is a
    // list rather than an omission.
    const present = this.#run(['ls-files', '--cached', '--others', '--exclude-standard']);
    const extraPaths = present.ok
      ? [...new Set(present.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && !owned.has(line)))]
      : [];
    return {
      verified: worktreeMatches && indexMatches,
      worktreeMatches,
      indexMatches,
      treeSha: snapshotTree.stdout.trim(),
      differingPaths: [...new Set([...worktree.paths, ...index.paths])],
      extraPaths,
      inspected: true,
    };
  }

  // The public form of the post-condition, so an action's independent verifier can ask the engine the
  // same question the engine asked itself - and so a test can ask it too.
  restoredState(checkpointId) {
    const id = validateCheckpointId(checkpointId);
    const record = this.#readLedger().checkpoints.find((entry) => entry.checkpointId === id) ?? null;
    if (record === null) throw refused('CHECKPOINT_NOT_FOUND', `no checkpoint ${id} is recorded`);
    return { checkpointId: id, commitSha: record.commitSha, ...this.#restoredState(record.commitSha) };
  }

  checkpointCreate({ label, reason = null } = {}) {
    const cleanLabel = validateLabel(label);
    const status = this.statusDetailed();
    if (status.isRepo !== true) {
      throw refused('GIT_NOT_A_REPOSITORY', 'the workspace is not a git repository, so there is nothing to checkpoint');
    }
    if (status.headSha === null) {
      throw refused('GIT_NO_COMMITS', 'the repository has no commit yet; make an initial commit before checkpointing');
    }

    const checkpointId = `chk_${this.#idFactory()}`;
    // `stash create` builds the commit and prints its SHA. It does not stash, does not touch the index,
    // and does not move HEAD - which is what makes this a record rather than an interruption.
    const stashRun = this.#run(['stash', 'create']);
    const stashSha = stashRun.ok ? stashRun.stdout.trim() : '';
    const wasDirty = stashSha.length > 0;
    // A clean tree has nothing to snapshot beyond HEAD itself.
    const commitSha = wasDirty ? stashSha : status.headSha;

    const treeRun = this.#run(['rev-parse', `${commitSha}^{tree}`]);
    if (!treeRun.ok) throw refused('GIT_CHECKPOINT_FAILED', 'the snapshot commit could not be read back');
    const treeSha = treeRun.stdout.trim();

    const refName = `${CHECKPOINT_REF_PREFIX}${checkpointId}`;
    const update = this.#run(['update-ref', refName, commitSha]);
    if (!update.ok) throw refused('GIT_CHECKPOINT_FAILED', `the checkpoint ref could not be written: ${update.message}`);
    // Verify what the ref resolves to *now*. A written ref that does not point where it was told is a
    // failure whether or not git returned success, and only a read can tell the difference.
    const verify = this.#run(['rev-parse', '--verify', '--quiet', refName]);
    const verifiedSha = verify.ok ? verify.stdout.trim() : null;
    if (verifiedSha !== commitSha) {
      throw refused('GIT_CHECKPOINT_FAILED', `the checkpoint ref does not resolve to the snapshot commit (${verifiedSha ?? 'unresolved'})`);
    }

    const trackedModifiedCount = status.staged.length + status.unstaged.length;
    const untrackedPaths = [...status.untracked];
    // The manifest is the SHA-256 of each modified tracked file's bytes *now*, so a later reader can
    // tell whether the tree still holds what was checkpointed.
    const manifest = [];
    for (const entry of [...status.staged, ...status.unstaged]) {
      try {
        const bytes = fs.readFileSync(path.join(this.#root, entry.path));
        manifest.push({ path: entry.path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
      } catch {
        // A path deleted in the worktree has no bytes to hash; the absence is recorded as null rather
        // than as an empty file's digest, which would be a different claim.
        manifest.push({ path: entry.path, sha256: null, bytes: null });
      }
    }

    const record = {
      checkpointId,
      label: cleanLabel,
      reason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim().slice(0, 240) : null,
      refName,
      commitSha,
      headShaAtCreation: status.headSha,
      treeSha,
      wasDirty,
      trackedModifiedCount,
      untrackedPaths,
      manifest,
      createdAt: this.#now().toISOString(),
      verified: true,
      restoreCount: 0,
      lastRestoredAt: null,
    };

    const ledger = this.#readLedger();
    if (ledger.unreadable === true) throw refused('GIT_CHECKPOINT_LEDGER_CORRUPT', 'the checkpoint ledger is unreadable and will not be overwritten');
    this.#writeLedger([...ledger.checkpoints, record]);
    this.#recordOperation({
      at: record.createdAt,
      capability: 'git.checkpoint_create',
      checkpointId,
      refName,
      commitSha,
      label: cleanLabel,
      verified: true,
    });
    return { ...record, refIntact: true };
  }

  checkpointRestore({ checkpointId, reason = null } = {}) {
    const id = validateCheckpointId(checkpointId);
    const ledger = this.#readLedger();
    if (ledger.unreadable === true) throw refused('GIT_CHECKPOINT_LEDGER_CORRUPT', 'the checkpoint ledger is unreadable');
    const record = ledger.checkpoints.find((entry) => entry.checkpointId === id) ?? null;
    if (record === null) throw refused('CHECKPOINT_NOT_FOUND', `no checkpoint ${id} is recorded`);

    const refName = typeof record.refName === 'string' ? record.refName : `${CHECKPOINT_REF_PREFIX}${id}`;
    const live = this.#run(['rev-parse', '--verify', '--quiet', refName]);
    const liveSha = live.ok ? live.stdout.trim() : null;
    if (liveSha === null || liveSha !== record.commitSha) {
      // Tampering and disappearance are the same hazard to a restore, and both are 409: the record
      // says one thing and the repository says another.
      throw refused('CHECKPOINT_REF_DRIFT',
        `the checkpoint ref does not resolve to its recorded commit (recorded ${short(record.commitSha)}, found ${liveSha === null ? 'nothing' : short(liveSha)})`,
        { recorded: record.commitSha, found: liveSha });
    }

    // The fail-closed preflight. If the owner has uncommitted tracked changes that are not already
    // exactly the checkpoint's content, a restore would destroy them silently. It refuses instead,
    // and says what to do about it.
    const status = this.statusDetailed();
    const dirtyTracked = [...status.staged, ...status.unstaged];
    if (dirtyTracked.length > 0) {
      // "Already matches the checkpoint" is a real case, and it has two shapes: restoring twice in a
      // row, where the worktree and index both hold the snapshot, and a checkpoint taken from exactly
      // the state the tree is in now, where the worktree already holds the snapshot's content but the
      // index does not. Both are no-ops, and a restore that would change nothing is safe by
      // definition. The test is a comparison against the snapshot commit itself, not against HEAD:
      // `git diff --quiet <sha>` exits 0 when the worktree already holds that commit's content.
      const worktreeMatches = this.#run(['diff', '--quiet', record.commitSha, '--', '.']).ok;
      const indexTree = this.#run(['write-tree']);
      const checkpointTree = this.#run(['rev-parse', `${record.commitSha}^{tree}`]);
      const matches = worktreeMatches
        && indexTree.ok && checkpointTree.ok
        && indexTree.stdout.trim() === checkpointTree.stdout.trim()
        && status.unstaged.length === 0;
      if (!matches && !worktreeMatches) {
        throw refused('GIT_CHECKPOINT_DIRTY_TREE',
          `the working tree has ${dirtyTracked.length} uncommitted tracked change(s); restore would discard them. `
          + 'Create a checkpoint of the current state or commit/stash the changes first.',
          { dirtyPaths: dirtyTracked.map((entry) => entry.path) });
      }
    }

    // `checkout <sha> -- .` writes the snapshot's tracked content into the working tree and index. It
    // is the one operation in this module that changes the tree, which is why the preflight above and
    // the verification below both exist.
    const checkout = this.#run(['checkout', record.commitSha, '--', '.']);
    if (!checkout.ok) throw refused('GIT_CHECKPOINT_RESTORE_FAILED', `the snapshot could not be restored: ${checkout.message}`);

    // Post-condition: the worktree AND the index now hold the snapshot's tree. Verified by a fresh
    // read, not by the checkout's exit code.
    //
    // The comparison is against the snapshot commit, never against HEAD, and that distinction is the
    // whole correctness of this check. Restoring an older checkpoint onto a newer HEAD legitimately
    // leaves staged changes relative to HEAD - that is what restoring means - so asking for "no
    // changes" would refuse every useful restore. What must be true is that the tree is the
    // checkpoint's tree.
    const after = this.#restoredState(record.commitSha);
    if (after.verified !== true) {
      throw refused('GIT_CHECKPOINT_RESTORE_UNVERIFIED',
        `the restore did not verify: the ${after.worktreeMatches ? 'worktree matches' : 'worktree differs from'} the snapshot and the ${after.indexMatches ? 'index matches' : 'index differs from'} it`,
        { worktreeMatches: after.worktreeMatches, indexMatches: after.indexMatches });
    }

    const restoredAt = this.#now().toISOString();
    const updated = {
      ...record,
      lastRestoredAt: restoredAt,
      restoreCount: (Number.isInteger(record.restoreCount) ? record.restoreCount : 0) + 1,
      lastRestoreReason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim().slice(0, 240) : null,
    };
    this.#writeLedger(ledger.checkpoints.map((entry) => (entry.checkpointId === id ? updated : entry)));
    this.#recordOperation({
      at: restoredAt,
      capability: 'git.checkpoint_restore',
      checkpointId: id,
      refName,
      commitSha: record.commitSha,
      verified: true,
    });
    // The tree SHA is the snapshot's own tree, read above, and it is returned so the caller can
    // compare it with what a later reading reports.
    return { ...updated, refIntact: true, verified: true, treeSha: after.treeSha, dirtyPathsCleared: dirtyTracked.length };
  }
}

// ------------------------------------------------------------------------------ capabilities ---

function commandLine(lines) {
  return lines.filter((line) => typeof line === 'string' && line.length > 0).join('\n');
}

// Factory for the four registered capabilities. Registered rather than called from a route, so the
// same ECP, operation audit and independent verifier apply to a git act as to every other one.
export function gitExecutiveActions(git) {
  if (!git || typeof git.statusDetailed !== 'function') throw new TypeError('gitExecutiveActions requires the git executive');
  return [
    {
      name: 'git.status_detailed',
      description: 'Read the workspace git repository in detail: branch, HEAD, ahead/behind, staged, unstaged and untracked paths, the ten most recent commits, and how many checkpoints APEX holds. Read-only. A directory that is not a repository is reported as such rather than as an error.',
      inputHint: '{}',
      permission: 'read',
      origins: ['user', 'model'],
      plannable: false,
      domain: 'git',
      autonomyLevel: 'L0',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        if (input === undefined || input === null) return {};
        if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('git.status_detailed expects an object');
        for (const key of Object.keys(input)) throw new ValidationError(`unexpected git.status_detailed input: ${key}`);
        return {};
      },
      async execute() {
        const data = git.statusDetailed();
        const lines = data.isRepo !== true
          ? [
            `Workspace ${data.workspaceRoot} is not a git repository (${data.reason}).`,
            'A reading was taken; nothing was assumed about a repository that is not there.',
          ]
          : [
            `Branch ${data.branch ?? 'detached'} at ${short(data.headSha) ?? 'no commit'}`,
            ...(data.ahead === null ? ['No upstream is configured, so ahead/behind is not reported.'] : [`${data.ahead} ahead, ${data.behind} behind the upstream.`]),
            `${data.staged.length} staged · ${data.unstaged.length} unstaged · ${data.untracked.length} untracked · ${data.checkpointsCount} checkpoint(s)`,
            ...(data.recentCommits[0] ? [`Latest: ${data.recentCommits[0].shortSha} ${data.recentCommits[0].subject}`] : ['No commit is recorded.']),
          ];
        return {
          summary: data.isRepo === true
            ? `git: ${data.branch ?? 'detached'} @ ${short(data.headSha) ?? 'no commit'} · ${data.staged.length + data.unstaged.length} changed`
            : `git: not a repository (${data.reason})`,
          data,
          display: commandLine(lines),
        };
      },
      // Verified against a fresh reading. The check is that the two readings agree about the facts
      // they both report; a repository that changed in between is not a failure of this capability.
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || typeof data !== 'object') return { ok: false, detail: 'the action returned no reading' };
        if (data.verified !== true) return { ok: false, detail: 'the reading was not marked verified' };
        if (data.isRepo === true) {
          if (typeof data.headSha !== 'string' || !/^[0-9a-f]{7,64}$/.test(data.headSha)) {
            return { ok: false, detail: 'a repository reading must carry a commit SHA' };
          }
          if (!Array.isArray(data.staged) || !Array.isArray(data.unstaged) || !Array.isArray(data.untracked)) {
            return { ok: false, detail: 'the reading must carry three path lists' };
          }
        }
        return { ok: true, detail: data.isRepo === true ? `read ${data.recentCommits.length} commit(s) and ${data.staged.length + data.unstaged.length} change(s)` : `reported ${data.reason}` };
      },
    },
    {
      name: 'git.diff_inspect',
      description: 'Inspect a unified diff in the workspace repository: additions, deletions and structured hunks with old and new line numbers. Optionally narrowed to one path inside the workspace, and optionally against the index instead of the working tree. Read-only.',
      inputHint: '{"targetPath":"src/greeting.js","baseRef":"HEAD","staged":false,"maxBytes":65536}',
      permission: 'read',
      origins: ['user', 'model'],
      plannable: false,
      domain: 'git',
      autonomyLevel: 'L0',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        if (input === undefined || input === null) return { targetPath: null, baseRef: 'HEAD', staged: false, maxBytes: DEFAULT_DIFF_MAX_BYTES };
        if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('git.diff_inspect expects an object');
        for (const key of Object.keys(input)) {
          if (!['targetPath', 'baseRef', 'staged', 'maxBytes'].includes(key)) throw new ValidationError(`unexpected git.diff_inspect input: ${key}`);
        }
        let targetPath = null;
        if (input.targetPath !== undefined && input.targetPath !== null) {
          if (typeof input.targetPath !== 'string' || input.targetPath.trim().length === 0 || input.targetPath.length > 400) {
            throw new ValidationError('targetPath must be a path of 1-400 characters');
          }
          targetPath = input.targetPath.trim();
        }
        const baseRef = validateGitRef(input.baseRef ?? 'HEAD', { label: 'baseRef' });
        if (input.staged !== undefined && typeof input.staged !== 'boolean') throw new ValidationError('staged must be a boolean');
        let maxBytes = DEFAULT_DIFF_MAX_BYTES;
        if (input.maxBytes !== undefined && input.maxBytes !== null) {
          if (!Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_DIFF_MAX_BYTES) {
            throw new ValidationError(`maxBytes must be an integer from 1 to ${MAX_DIFF_MAX_BYTES}`);
          }
          maxBytes = input.maxBytes;
        }
        return { targetPath, baseRef, staged: input.staged === true, maxBytes };
      },
      async execute(_ctx, input) {
        const data = git.diffInspect(input);
        return {
          summary: data.isRepo === false
            ? `diff: not a repository (${data.reason})`
            : `diff${data.targetPath ? ` ${data.targetPath}` : ''}: +${data.additions} -${data.deletions} · ${data.hunks.length} hunk(s)`,
          data,
          display: commandLine([
            data.isRepo === false ? `No repository at ${git.workspaceRoot} (${data.reason}).` : `Diff against ${data.baseRef}${data.staged ? ' (index)' : ' (working tree)'}${data.targetPath ? ` for ${data.targetPath}` : ''}`,
            `+${data.additions} additions · -${data.deletions} deletions · ${data.hunks.length} hunk(s) · sha256 ${data.sha256.slice(0, 16)}`,
          ]),
        };
      },
      async verify(_ctx, input, result) {
        const data = result?.data;
        if (!data || typeof data !== 'object') return { ok: false, detail: 'the action returned no reading' };
        if (data.verified !== true) return { ok: false, detail: 'the diff was not marked verified' };
        if (typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.sha256)) {
          return { ok: false, detail: 'the diff must carry a sha256 of the text it returned' };
        }
        // The counts must agree with the lines actually parsed, or one of the two is lying.
        const adds = data.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.type === 'add').length, 0);
        const dels = data.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.type === 'del').length, 0);
        if (adds !== data.additions || dels !== data.deletions) {
          return { ok: false, detail: `the reported counts (+${data.additions}/-${data.deletions}) disagree with the parsed hunks (+${adds}/-${dels})` };
        }
        if (input && input.targetPath && data.targetPath === null) return { ok: false, detail: 'a narrowed diff must name the path it narrowed to' };
        return { ok: true, detail: `+${data.additions} -${data.deletions} over ${data.hunks.length} hunk(s)` };
      },
    },
    {
      name: 'git.checkpoint_create',
      description: 'Create a non-destructive checkpoint of the workspace repository: snapshot the tracked working-tree and index state under a durable refs/apex-checkpoints/<id> ref, record the untracked paths and a SHA-256 manifest, and persist the record. The working tree and index are not modified. L2 Confirm; refused under Lockdown.',
      inputHint: '{"label":"before the refactor","reason":"why this point is worth keeping"}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'git',
      autonomyLevel: 'L2',
      reversibility: 'reversible',
      blastRadius: 'workspace_fs',
      validate(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('git.checkpoint_create expects an object');
        for (const key of Object.keys(input)) {
          if (!['label', 'reason', 'stepUp'].includes(key)) throw new ValidationError(`unexpected git.checkpoint_create input: ${key}`);
        }
        const label = validateLabel(input.label);
        let reason = null;
        if (input.reason !== undefined && input.reason !== null) {
          if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 240) {
            throw new ValidationError('reason must be 1-240 characters');
          }
          reason = input.reason.trim();
        }
        let stepUp = null;
        if (input.stepUp !== undefined && input.stepUp !== null) {
          if (typeof input.stepUp !== 'string' || input.stepUp.length === 0 || input.stepUp.length > 200) {
            throw new ValidationError('stepUp must be the configured step-up secret');
          }
          stepUp = input.stepUp;
        }
        return { label, reason, stepUp };
      },
      async execute(ctx, input) {
        // Writing a ref and a ledger record into the owner's repository takes the step-up when one is
        // configured, exactly as a Workshop apply does. Lockdown and origin refusals already happened
        // in the ECP; this is the proof of presence on top of them.
        const controlPlane = ctx?.registry?.controlPlane ?? null;
        if (controlPlane && typeof controlPlane.verifyStepUp === 'function') {
          const gate = controlPlane.verifyStepUp(input.stepUp, { capability: 'git.checkpoint_create' });
          if (!gate.ok) {
            throw new ValidationError(gate.reason === 'STEP_UP_REQUIRED'
              ? 'a step-up secret is configured, so this act needs the step-up proof'
              : 'the step-up proof was refused; no checkpoint was created', gate.reason);
          }
        }
        const record = git.checkpointCreate({ label: input.label, reason: input.reason });
        return {
          summary: `checkpoint ${record.checkpointId} · ${short(record.commitSha)} · ${record.wasDirty ? 'dirty tree snapshotted' : 'clean tree, HEAD snapshotted'}`,
          data: record,
          display: commandLine([
            `Checkpoint ${record.checkpointId} recorded as ${record.label}`,
            `Ref ${record.refName} -> ${short(record.commitSha)} (${record.wasDirty ? 'stashed working state' : 'clean tree, HEAD'})`,
            `${record.trackedModifiedCount} modified tracked file(s) · ${record.untrackedPaths.length} untracked path(s) · the working tree was not touched`,
          ]),
        };
      },
      async verify(_ctx, _input, result) {
        const record = result?.data;
        if (!record || typeof record.checkpointId !== 'string') return { ok: false, detail: 'the action returned no checkpoint record' };
        // Verified from the repository and the ledger, not from the record the action built.
        const live = git.listCheckpoints().find((entry) => entry.checkpointId === record.checkpointId) ?? null;
        if (live === null) return { ok: false, detail: 'the checkpoint was not persisted in the ledger' };
        if (live.refIntact !== true) return { ok: false, detail: 'the checkpoint ref does not resolve to its recorded commit' };
        if (record.verified !== true) return { ok: false, detail: 'the checkpoint record is not marked verified' };
        return { ok: true, detail: `checkpoint ${live.checkpointId} persisted and its ref resolves` };
      },
    },
    {
      name: 'git.checkpoint_restore',
      description: 'Restore the tracked files of the workspace working tree and index to a recorded checkpoint, after verifying the checkpoint ref still resolves and refusing when uncommitted tracked changes would be lost. L2 Confirm; refused under Lockdown.',
      inputHint: '{"checkpointId":"chk_...","reason":"why the tree is being restored"}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'git',
      autonomyLevel: 'L2',
      reversibility: 'reversible',
      blastRadius: 'workspace_fs',
      validate(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('git.checkpoint_restore expects an object');
        for (const key of Object.keys(input)) {
          if (!['checkpointId', 'reason', 'stepUp'].includes(key)) throw new ValidationError(`unexpected git.checkpoint_restore input: ${key}`);
        }
        const checkpointId = validateCheckpointId(input.checkpointId);
        let reason = null;
        if (input.reason !== undefined && input.reason !== null) {
          if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 240) {
            throw new ValidationError('reason must be 1-240 characters');
          }
          reason = input.reason.trim();
        }
        let stepUp = null;
        if (input.stepUp !== undefined && input.stepUp !== null) {
          if (typeof input.stepUp !== 'string' || input.stepUp.length === 0 || input.stepUp.length > 200) {
            throw new ValidationError('stepUp must be the configured step-up secret');
          }
          stepUp = input.stepUp;
        }
        return { checkpointId, reason, stepUp };
      },
      async execute(ctx, input) {
        // Restoring overwrites tracked files in the owner's real tree, so the step-up applies to it for
        // the same reason it applies to a Workshop apply.
        const controlPlane = ctx?.registry?.controlPlane ?? null;
        if (controlPlane && typeof controlPlane.verifyStepUp === 'function') {
          const gate = controlPlane.verifyStepUp(input.stepUp, { capability: 'git.checkpoint_restore' });
          if (!gate.ok) {
            throw new ValidationError(gate.reason === 'STEP_UP_REQUIRED'
              ? 'a step-up secret is configured, so this act needs the step-up proof'
              : 'the step-up proof was refused; nothing was restored', gate.reason);
          }
        }
        const record = git.checkpointRestore({ checkpointId: input.checkpointId, reason: input.reason });
        return {
          summary: `restored ${record.checkpointId} · ${record.dirtyPathsCleared} path(s) cleared · restore #${record.restoreCount}`,
          data: record,
          display: commandLine([
            `Restored checkpoint ${record.checkpointId} (${record.label}) from ${short(record.commitSha)}`,
            `The index now matches the snapshot tree ${short(record.treeSha)}; verified after the write.`,
          ]),
        };
      },
      async verify(_ctx, _input, result) {
        const record = result?.data;
        if (!record || typeof record.checkpointId !== 'string') return { ok: false, detail: 'the action returned no restore record' };
        if (record.verified !== true) return { ok: false, detail: 'the restore is not marked verified' };
        // A fresh reading of the tree is the only honest check: the restore's own return value would
        // verify itself.
        const after = git.statusDetailed();
        if (after.isRepo !== true) return { ok: false, detail: 'the workspace is no longer a repository' };
        // The tree must be the checkpoint's tree, not HEAD's: a restore onto a newer HEAD leaves
        // staged changes against HEAD by design, and demanding a clean status would refuse the very
        // outcome a restore is supposed to produce.
        const state = git.restoredState(record.checkpointId);
        if (state.verified !== true) {
          return { ok: false, detail: `the worktree ${state.worktreeMatches ? 'holds' : 'does not hold'} the snapshot and the index ${state.indexMatches ? 'holds' : 'does not hold'} it` };
        }
        const live = git.listCheckpoints().find((entry) => entry.checkpointId === record.checkpointId) ?? null;
        if (live === null || live.refIntact !== true) return { ok: false, detail: 'the checkpoint ref no longer resolves' };
        if (live.restoreCount !== record.restoreCount) return { ok: false, detail: 'the restore count was not persisted' };
        return { ok: true, detail: `restored to ${short(record.treeSha)} with a clean tree and the restore recorded` };
      },
    },
  ];
}
