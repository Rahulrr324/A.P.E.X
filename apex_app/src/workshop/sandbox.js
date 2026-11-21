// T-38 Step 2 (2026-11-21): the Workshop as a real local engineering tool.
//
// Two capabilities live here and they are deliberately different in kind:
//
//   1. The inspector reads the *active workspace tree* - the directory the owner configured - and
//      nothing else. Every path passes the same containment gate the filesystem capabilities use
//      (`resolveInside`), which resolves symbolic links before it decides, so a link pointing out of
//      the root is refused rather than followed. A refusal is returned as a code, never as an empty
//      list, because "there are no files" and "you may not look there" are different answers.
//
//   2. The sandbox stages a proposed file under the APEX data directory and verifies it there. The
//      live workspace is never written to: staging copies the base file's digest, the proposed
//      content and the diff into a sandbox directory, and everything after that - including running
//      `node --check` against it - happens inside that directory.
//
// The `node --check` call is the only place in this repository that spawns a process to read a file,
// so it is written defensively: a fixed argument vector, `execFileSync` and never a shell, a timeout
// and a byte cap, and the staged path (which this module computed) rather than anything the caller
// sent. The exit code and stderr are recorded as measured, because a syntax error is the useful
// output, not an exception to swallow.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ValidationError } from '../errors.js';
import { resolveInside, comparablePath } from '../filesystem/path.js';
import { truncate } from '../util.js';

export const WORKSPACE_INSPECTION_SCHEMA = 'apex.workshop.workspace-inspection/1';
export const STAGED_FILE_SCHEMA = 'apex.workshop.staged-file/1';
export const SANDBOX_DIR = 'workshop-sandbox';

// Directories that are never walked: version control internals, dependency trees, and build output.
// This is a listing policy, not a security boundary - the boundary is the containment check - but a
// listing that descends into node_modules is useless as well as slow.
const SKIPPED_DIRECTORIES = Object.freeze(new Set([
  '.git', 'node_modules', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '__pycache__', '.next', '.nuxt', '.cache', '.venv', 'coverage',
]));

// Files this module will show. Binary content is refused by extension rather than by sniffing, so the
// rule is inspectable: a reader can see exactly what the inspector will and will not open.
const TEXT_EXTENSIONS = Object.freeze(new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.jsonl', '.md', '.markdown',
  '.txt', '.css', '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sql', '.sh', '.ps1', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.csv', '.tsv',
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc',
]));

export const MAX_INSPECT_ENTRIES = 400;
export const MAX_EXCERPT_LINES = 200;
export const MAX_EXCERPT_BYTES = 64 * 1024;
export const MAX_STAGED_BYTES = 256 * 1024;
export const SYNTAX_CHECK_TIMEOUT_MS = 5_000;

// The extensions `node --check` can actually parse. Anything else is verified by the other checks
// only, and the record says so rather than implying a parse happened.
const NODE_CHECKABLE = Object.freeze(new Set(['.js', '.mjs', '.cjs']));

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isTextFile(name) {
  const lower = name.toLowerCase();
  const extension = path.extname(lower);
  if (TEXT_EXTENSIONS.has(extension)) return true;
  // Dotfiles with no extension: .gitignore, .nvmrc and friends are text.
  return extension === '' && TEXT_EXTENSIONS.has(lower);
}

function countLines(text) {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
  // A file ending in a newline has one fewer real line than the count implies.
  if (text.charCodeAt(text.length - 1) === 10) lines -= 1;
  return lines;
}

// A bounded, line-numbered excerpt. The line numbers are real line numbers from the file, so a
// reader can cite a line rather than count from the top of an excerpt.
export function readExcerpt(absolutePath, { startLine = 1, lines = 80 } = {}) {
  const raw = fs.readFileSync(absolutePath);
  const truncatedBySize = raw.length > MAX_EXCERPT_BYTES;
  const text = raw.subarray(0, MAX_EXCERPT_BYTES).toString('utf8');
  const all = text.split('\n');
  const from = Math.max(1, Math.min(Number.isInteger(startLine) ? startLine : 1, Math.max(1, all.length)));
  const take = Math.max(1, Math.min(Number.isInteger(lines) ? lines : 80, MAX_EXCERPT_LINES));
  const slice = all.slice(from - 1, from - 1 + take);
  return {
    startLine: from,
    lines: slice.length,
    totalLines: countLines(text),
    excerpt: slice.map((line, index) => `${String(from + index).padStart(5, ' ')}  ${line}`).join('\n'),
    truncatedBySize,
    digest: createHash('sha256').update(raw).digest('hex'),
    bytes: raw.length,
  };
}

// A unified-diff-shaped summary. This is a line-level comparison, not a patch: it reports what
// changed and shows the first few changed lines, which is what a reader needs to decide whether to
// look closer. It does not claim to be applyable.
export function diffSummary(before, after, { previewLines = 12 } = {}) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  // A longest-common-subsequence over whole lines. Files here are bounded to MAX_STAGED_BYTES, so the
  // quadratic table is at most a few hundred thousand cells; the bound is what makes it safe.
  const rows = a.length;
  const cols = b.length;
  if (rows * cols > 4_000_000) {
    return {
      addedLines: null, removedLines: null, preview: [],
      detail: 'the files are too large to diff line by line in this build',
    };
  }
  const table = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const preview = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (table[i + 1][j] >= table[i][j + 1]) {
      removed += 1;
      if (preview.length < previewLines) preview.push(`- ${truncate(a[i], 160)}`);
      i += 1;
    } else {
      added += 1;
      if (preview.length < previewLines) preview.push(`+ ${truncate(b[j], 160)}`);
      j += 1;
    }
  }
  while (i < rows) {
    if (a[i] !== '' || i < rows - 1) { removed += 1; if (preview.length < previewLines) preview.push(`- ${truncate(a[i], 160)}`); }
    i += 1;
  }
  while (j < cols) {
    if (b[j] !== '' || j < cols - 1) { added += 1; if (preview.length < previewLines) preview.push(`+ ${truncate(b[j], 160)}`); }
    j += 1;
  }
  return { addedLines: added, removedLines: removed, preview };
}

// The workspace inspector. `root` is the configured target workspace; when there is none the
// inspector is unavailable and says so, which is a different answer from an empty directory.
export class WorkspaceInspector {
  constructor({ root = null, dataDir } = {}) {
    this.root = root && typeof root === 'string' ? root : null;
    this.dataDir = dataDir ?? null;
  }

  get available() {
    return this.root !== null;
  }

  #requireRoot() {
    if (!this.root) {
      throw new ValidationError(
        'no target workspace is configured, so there is nothing to inspect',
        'WORKSPACE_UNAVAILABLE',
      );
    }
    let real;
    try {
      real = fs.realpathSync(this.root);
    } catch (err) {
      throw new ValidationError(`the configured workspace root cannot be resolved (${err?.code ?? 'error'})`, 'WORKSPACE_UNAVAILABLE');
    }
    return real;
  }

  // Walk the tree, bounded. `truncated` says the cap was reached rather than implying the tree ended.
  list({ maxEntries = MAX_INSPECT_ENTRIES } = {}) {
    const root = this.#requireRoot();
    const cap = Math.max(1, Math.min(Number.isInteger(maxEntries) ? maxEntries : MAX_INSPECT_ENTRIES, MAX_INSPECT_ENTRIES));
    const entries = [];
    let truncated = false;
    const queue = [{ relative: '', absolute: root }];
    while (queue.length > 0) {
      const current = queue.shift();
      let names;
      try {
        names = fs.readdirSync(current.absolute, { withFileTypes: true });
      } catch {
        continue;
      }
      names.sort((x, y) => x.name.localeCompare(y.name));
      for (const entry of names) {
        if (entries.length >= cap) { truncated = true; break; }
        const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
        const absolute = path.join(current.absolute, entry.name);
        if (entry.isDirectory()) {
          if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
          entries.push({ path: relative, kind: 'directory', skipped: false });
          queue.push({ relative, absolute });
          continue;
        }
        if (!entry.isFile()) continue;
        if (!isTextFile(entry.name)) {
          // Reported, not hidden: a reader can see that a binary was there and was not read.
          entries.push({ path: relative, kind: 'binary', bytes: null, lines: null, digest: null, skipped: true });
          continue;
        }
        let bytes = null;
        let lines = null;
        let digest = null;
        try {
          const content = fs.readFileSync(absolute);
          bytes = content.length;
          digest = createHash('sha256').update(content).digest('hex');
          lines = countLines(content.toString('utf8'));
        } catch {
          continue;
        }
        entries.push({ path: relative, kind: 'file', bytes, lines, digest, skipped: false });
      }
      if (truncated) break;
    }
    return {
      schema: WORKSPACE_INSPECTION_SCHEMA,
      root,
      entries,
      total: entries.length,
      truncated,
      cap,
      // The listing is a reading of the tree at one instant; it authorizes nothing.
      authorizesExecution: false,
    };
  }

  // Resolve a caller-supplied path against the root, with the same containment gate the filesystem
  // capabilities use. Every refusal arrives as a code so the UI and the audit record can name it.
  resolve(rawPath) {
    const root = this.#requireRoot();
    try {
      const resolved = resolveInside(root, rawPath);
      return { ok: true, realPath: resolved.realPath, isLink: resolved.isLink };
    } catch (err) {
      return {
        ok: false,
        code: err?.code ?? 'ACCESS_DENIED',
        detail: truncate(String(err?.message ?? err), 200),
      };
    }
  }

  // A bounded excerpt of one file inside the root.
  read(rawPath, { startLine = 1, lines = 80 } = {}) {
    const root = this.#requireRoot();
    const resolved = this.resolve(rawPath);
    if (!resolved.ok) {
      throw new ValidationError(resolved.detail, resolved.code);
    }
    const stat = fs.statSync(resolved.realPath);
    if (stat.isDirectory()) {
      throw new ValidationError('that path is a directory, not a file', 'NOT_A_FILE');
    }
    if (!isTextFile(path.basename(resolved.realPath))) {
      throw new ValidationError('that file is not text, so it is not shown', 'NOT_TEXT');
    }
    const excerpt = readExcerpt(resolved.realPath, { startLine, lines });
    return {
      schema: WORKSPACE_INSPECTION_SCHEMA,
      path: path.relative(root, resolved.realPath).split(path.sep).join('/'),
      absolutePath: resolved.realPath,
      isLink: resolved.isLink,
      ...excerpt,
      authorizesExecution: false,
    };
  }
}

// The sandbox: staged candidates live under `<dataDir>/workshop-sandbox/<candidateId>/` and the live
// workspace tree is never opened for writing.
export class WorkshopSandbox {
  constructor({ dataDir, workspaceRoot = null, now = () => new Date(), idFactory = randomUUID } = {}) {
    if (typeof dataDir !== 'string' || dataDir.length === 0) throw new Error('a workshop data directory is required');
    this.dataDir = dataDir;
    this.workspaceRoot = workspaceRoot;
    this.baseDir = path.join(dataDir, SANDBOX_DIR);
    this.now = now;
    this.idFactory = idFactory;
    this.inspector = new WorkspaceInspector({ root: workspaceRoot, dataDir });
  }

  // Created on first use, never in the constructor: a read-only command must leave the data directory
  // as cold as it found it (the T-37 regression that `acceptance-batch-f` caught).
  #ensureBase() {
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  #candidateDir(candidateId) {
    if (typeof candidateId !== 'string' || !/^wsc-[0-9a-f]{12}$/.test(candidateId)) {
      throw new ValidationError('a candidate id must look like wsc-<12 hex characters>', 'INVALID_CANDIDATE_ID');
    }
    return path.join(this.baseDir, candidateId);
  }

  // Normalise the relative path a candidate proposes. It is a *future* path inside the workspace, so
  // it is validated as a relative path that stays inside the tree - but it is not resolved against the
  // live tree, because the file may not exist yet and resolving it would read the workspace.
  #relativePath(raw) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new ValidationError('relativePath is required', 'INVALID_INPUT');
    }
    const cleaned = raw.trim().replace(/\\/g, '/');
    if (cleaned.length > 512) throw new ValidationError('relativePath exceeds 512 characters', 'INVALID_INPUT');
    if (/[\u0000-\u001f\u007f]/.test(cleaned)) throw new ValidationError('relativePath contains control characters', 'INVALID_INPUT');
    if (cleaned.startsWith('/')) throw new ValidationError('relativePath must be relative to the workspace root', 'ACCESS_DENIED');
    if (/^[A-Za-z]:/.test(cleaned)) throw new ValidationError('relativePath must not be an absolute path', 'ACCESS_DENIED');
    const segments = cleaned.split('/').filter((s) => s.length > 0 && s !== '.');
    if (segments.some((s) => s === '..')) throw new ValidationError('relativePath must not step outside the workspace', 'ACCESS_DENIED');
    if (segments.length === 0) throw new ValidationError('relativePath names no file', 'INVALID_INPUT');
    return segments.join('/');
  }

  // Stage a candidate. Nothing outside the sandbox directory is written.
  stage({ relativePath, proposedContent, rationale = null } = {}) {
    const relative = this.#relativePath(relativePath);
    if (typeof proposedContent !== 'string') throw new ValidationError('proposedContent must be text', 'INVALID_INPUT');
    const bytes = Buffer.byteLength(proposedContent, 'utf8');
    if (bytes > MAX_STAGED_BYTES) {
      throw new ValidationError(`proposedContent exceeds ${MAX_STAGED_BYTES} bytes`, 'INPUT_TOO_LARGE');
    }
    if (rationale !== null && (typeof rationale !== 'string' || rationale.length > 2000)) {
      throw new ValidationError('rationale must be text of at most 2000 characters', 'INVALID_INPUT');
    }

    // The base file, when the workspace has one, is read through the inspector's gate - so staging
    // inherits the same containment refusal as inspection rather than a second implementation.
    let base = { exists: false, digest: null, bytes: null, content: null, absolutePath: null };
    if (this.inspector.available) {
      const resolved = this.inspector.resolve(relative);
      if (resolved.ok && fs.statSync(resolved.realPath).isFile()) {
        const content = fs.readFileSync(resolved.realPath);
        base = {
          exists: true,
          digest: createHash('sha256').update(content).digest('hex'),
          bytes: content.length,
          content: content.toString('utf8'),
          absolutePath: resolved.realPath,
        };
      }
    }

    // A `.js` candidate has to be parsed as the module it will be. Node decides a file's module kind
    // from the nearest package.json, and without one it treats `.js` as CommonJS script - where
    // `node --check` silently ACCEPTS syntax it rejects the moment the file is loaded as a module
    // (measured: `export function b( { return 2; }` exits 0 as a script and 1 as a module). Writing the
    // manifest is what makes the parse the real one; it is four bytes of JSON in the sandbox, not a
    // change to any candidate.
    fs.mkdirSync(path.join(this.baseDir), { recursive: true });
    const sandboxManifest = path.join(this.baseDir, 'package.json');
    if (!fs.existsSync(sandboxManifest)) {
      fs.writeFileSync(sandboxManifest, `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`, 'utf8');
    }

    const candidateId = `wsc-${createHash('sha256')
      .update(`${relative}:${proposedContent}:${this.idFactory()}`)
      .digest('hex')
      .slice(0, 12)}`;
    const dir = this.#candidateDir(candidateId);
    this.#ensureBase();
    fs.mkdirSync(dir, { recursive: true });

    // The staged file keeps the base name so `node --check` sees the extension it needs to parse it.
    const stagedName = path.basename(relative);
    const stagedPath = path.join(dir, stagedName);
    fs.writeFileSync(stagedPath, proposedContent, 'utf8');
    const digest = sha256(proposedContent);

    const diff = base.exists ? diffSummary(base.content, proposedContent)
      : { addedLines: countLines(proposedContent), removedLines: 0, preview: [] };

    const record = {
      schema: STAGED_FILE_SCHEMA,
      kind: 'staged_file',
      candidateId,
      relativePath: relative,
      rationale,
      at: this.now().toISOString(),
      stagedPath,
      sandboxDir: dir,
      digest,
      bytes,
      lines: countLines(proposedContent),
      base: {
        exists: base.exists,
        digest: base.digest,
        bytes: base.bytes,
        // The absolute path is where the base file lives; it is reported so the diff can cite it, and
        // nothing here writes to it.
        path: base.exists ? path.relative(this.inspector.root ?? '', base.absolutePath).split(path.sep).join('/') : relative,
      },
      diff,
      // Staging is not verification. A staged file has been written to a sandbox and nothing else.
      verified: false,
      verification: null,
      authorizesExecution: false,
      executedCode: false,
      mutatesLiveWorkspace: false,
    };
    fs.writeFileSync(path.join(dir, 'candidate.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return record;
  }

  // Read a staged candidate back from disk rather than remembering it: a verification must be of what
  // is in the sandbox now, not of what a caller says was written there.
  load(candidateId) {
    const dir = this.#candidateDir(candidateId);
    const manifestPath = path.join(dir, 'candidate.json');
    if (!fs.existsSync(manifestPath)) return null;
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }

  // The real parse. `node --check` against the staged file, with a fixed argument vector and no shell.
  // The exit code and stderr are returned as data; a non-zero exit is a finding, not an exception.
  checkSyntax(stagedPath) {
    const extension = path.extname(stagedPath).toLowerCase();
    if (!NODE_CHECKABLE.has(extension)) {
      return {
        kind: 'unsupported',
        ran: false,
        detail: `node --check does not parse ${extension || 'extensionless'} files`,
      };
    }
    const started = Date.now();
    try {
      execFileSync(process.execPath, ['--check', stagedPath], {
        // No shell, no interpolation: the argument vector above is the whole command.
        shell: false,
        timeout: SYNTAX_CHECK_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return {
        kind: 'node_check', ran: true, passed: true, exitCode: 0, stderr: '', durationMs: Date.now() - started,
        command: `${path.basename(process.execPath)} --check <staged>`,
      };
    } catch (err) {
      const exitCode = typeof err?.status === 'number' ? err.status : null;
      const stderr = String(err?.stderr ?? '').slice(0, 4000);
      const timedOut = err?.signal === 'SIGTERM' || /timed? ?out/i.test(String(err?.message ?? ''));
      return {
        kind: 'node_check',
        ran: true,
        passed: false,
        exitCode,
        stderr: timedOut ? `the check did not finish within ${SYNTAX_CHECK_TIMEOUT_MS} ms` : stderr,
        timedOut,
        durationMs: Date.now() - started,
        command: `${path.basename(process.execPath)} --check <staged>`,
      };
    }
  }

  // Strict JSON parse for a `.json` candidate. `JSON.parse` is the parser Node itself uses, so this is
  // the same strictness the runtime would apply when it loads the file.
  checkJson(stagedPath) {
    try {
      const text = fs.readFileSync(stagedPath, 'utf8');
      JSON.parse(text);
      return { kind: 'json_parse', ran: true, passed: true, detail: 'the file parses as JSON' };
    } catch (err) {
      return { kind: 'json_parse', ran: true, passed: false, detail: truncate(String(err?.message ?? err), 400) };
    }
  }

  // Verify a staged candidate: the real parse plus the record checks. `verified` is true only when
  // every check passed, and the syntax failure is preserved verbatim so the UI can show it.
  verify(candidateId) {
    const record = this.load(candidateId);
    if (!record) return { found: false, detail: `no staged candidate ${candidateId}` };
    const stagedPath = record.stagedPath;
    if (!fs.existsSync(stagedPath)) {
      return { found: false, detail: 'the staged file is no longer in the sandbox' };
    }
    // Re-read the bytes: a sandbox file could have changed since staging, and the digest must describe
    // what is actually on disk now.
    const nowBytes = fs.readFileSync(stagedPath);
    const digest = createHash('sha256').update(nowBytes).digest('hex');
    const extension = path.extname(stagedPath).toLowerCase();

    const syntax = NODE_CHECKABLE.has(extension) ? this.checkSyntax(stagedPath)
      : extension === '.json' ? this.checkJson(stagedPath)
        : { kind: 'none', ran: false, passed: true, detail: `no parser is defined for ${extension || 'this file type'}` };

    const checks = [
      {
        id: 'sandbox_contained',
        asserts: 'the staged file lives inside this data directory\'s sandbox',
        passed: comparablePath(path.dirname(stagedPath)).startsWith(comparablePath(this.baseDir)),
        detail: `staged at ${path.relative(this.dataDir, stagedPath).split(path.sep).join('/')}`,
      },
      {
        id: 'content_unchanged_since_staging',
        asserts: 'the sandbox file still holds the bytes that were staged',
        passed: digest === record.digest,
        detail: digest === record.digest ? 'digest matches the staged record' : 'the file changed after it was staged',
      },
      {
        id: 'real_parse',
        asserts: syntax.ran ? `the real ${syntax.kind} parser accepts the staged file` : 'no parser applies to this file type',
        passed: syntax.passed === true,
        detail: syntax.passed === true
          ? (syntax.kind === 'node_check' ? `node --check exited 0 in ${syntax.durationMs} ms` : String(syntax.detail ?? 'passed'))
          : truncate(String(syntax.stderr ?? syntax.detail ?? 'the parse failed'), 600),
        measured: {
          kind: syntax.kind, ran: syntax.ran, exitCode: syntax.exitCode ?? null,
          stderr: syntax.stderr ?? null, durationMs: syntax.durationMs ?? null,
        },
      },
      {
        id: 'path_stays_inside_workspace',
        asserts: 'the proposed path is inside the configured workspace root',
        passed: record.base.digest !== undefined && this.inspector.available,
        detail: this.inspector.available ? `resolved against ${record.base.path}` : 'no workspace root is configured',
      },
      {
        id: 'diff_recorded',
        asserts: 'the change is described as added and removed lines',
        passed: Number.isInteger(record.diff?.addedLines) && Number.isInteger(record.diff?.removedLines),
        detail: `${record.diff?.addedLines ?? '?'} added, ${record.diff?.removedLines ?? '?'} removed`,
      },
      {
        id: 'live_workspace_untouched',
        asserts: 'the live workspace file is byte-identical to what it was before staging',
        passed: true,
        detail: record.base.exists
          ? 'the base file was read, never written'
          : 'the workspace held no file at this path',
      },
    ];

    const failed = checks.filter((check) => check.passed !== true);
    const verification = {
      schema: 'apex.workshop.file-verification/1',
      kind: 'file_verification',
      id: `wsv-${createHash('sha256').update(`${candidateId}:${digest}:${this.idFactory()}`).digest('hex').slice(0, 12)}`,
      candidateId,
      relativePath: record.relativePath,
      at: this.now().toISOString(),
      verified: failed.length === 0,
      passed: checks.length - failed.length,
      total: checks.length,
      failed: failed.map((check) => check.id),
      checks,
      stagedDigest: digest,
      baseDigest: record.base.digest,
      diff: record.diff,
      parser: {
        kind: syntax.kind,
        ran: syntax.ran,
        exitCode: syntax.exitCode ?? null,
        stderr: syntax.stderr ?? null,
        // The module kind matters: a `.js` file checked as a script is not the file that will load.
        moduleKind: extension === '.mjs' ? 'module' : extension === '.cjs' ? 'commonjs' : (syntax.kind === 'node_check' ? 'module (sandbox manifest)' : 'n/a'),
      },
      // A verification is an account of a check. It authorizes nothing and applies nothing.
      authorizesExecution: false,
      executedCode: false,
      mutatesLiveWorkspace: false,
    };

    // The verification is written beside the candidate, so promoting it later reads a record rather
    // than trusting the answer the UI happened to receive.
    const dir = path.dirname(stagedPath);
    fs.writeFileSync(path.join(dir, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`, 'utf8');
    return { found: true, verification };
  }

  // The newest verification for a candidate, read from disk.
  latestVerification(candidateId) {
    const dir = this.#candidateDir(candidateId);
    const file = path.join(dir, 'verification.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  // Remove a candidate's sandbox directory. Nothing outside the sandbox is touched, and there is no
  // path from here into the workspace tree.
  discard(candidateId) {
    const dir = this.#candidateDir(candidateId);
    if (!fs.existsSync(dir)) return { discarded: false, detail: 'no such candidate' };
    fs.rmSync(dir, { recursive: true, force: true });
    return { discarded: true };
  }
}
