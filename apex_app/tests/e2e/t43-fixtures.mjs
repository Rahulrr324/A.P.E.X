// T-43 Step 4 (2026-11-19): the fixture the workstation, git executive and telemetry walk drives.
//
// Same shape as the T-40 fixture, with one difference that is the whole point of the milestone: the
// workspace is a REAL git repository, initialised here with the system git binary, with a known commit
// and a worktree that has a known edit in it. Nothing about the status the panel shows is staged for the
// screen - it is measured from this repository by the same code the product runs.
//
// Nothing contacts a model, reads the real APEX data directory, or touches the repository's tree.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createApp } from '../../src/app.js';
import { createUiServer } from '../../src/ui/server.js';
import { ModelGateway, NoBackend } from '../../src/model/gateway.js';

export const T43_TOKEN = 'T43-workstation-git-telemetry-token-0123456789';
export const T43_SCHEMA = 'apex.t43.workstation-git-telemetry/1';

// The committed bytes and the working-tree bytes. The diff between them is exactly one line changed
// in each of the two files the walk inspects, so the +N/-N badges have a number that is stated here.
export const T43_GREETING_COMMITTED = 'export function greet(name) {\n  return "hello " + name;\n}\n';
export const T43_GREETING_EDITED = 'export function greet(name) {\n  return "hello " + name + "!";\n}\n';
export const T43_DATA_COMMITTED = '{\n  "version": 1,\n  "name": "apex"\n}\n';
export const T43_DATA_EDITED = '{\n  "version": 2,\n  "name": "apex"\n}\n';
// Written AFTER the checkpoint exists, to prove a restore reverts work done since. A restore that
// reverted to HEAD would pass a check written against the committed bytes; one that reverts to the
// checkpoint can only pass against the checkpointed bytes.
export const T43_GREETING_POST_CHECKPOINT = 'export function greet(name) {\n  return "written after the checkpoint";\n}\n';
export const T43_UNTRACKED = 'a file nobody has committed\n';

// A git invocation with an isolated identity and no user or system configuration, so the fixture does not
// read the machine's git settings and a developer's `commit.gpgsign` cannot make the walk hang.
function git(cwd, args) {
  // No trim. Porcelain output begins each line with a two-character XY field, and the leading space of
  // " M" is the whole difference between a worktree edit and a staged one - trimming it turns a careful
  // read into a wrong one. The helpers that do want a single line trim it themselves.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'APEX T-43',
      GIT_AUTHOR_EMAIL: 't43@apex.invalid',
      GIT_COMMITTER_NAME: 'APEX T-43',
      GIT_COMMITTER_EMAIL: 't43@apex.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

// A single-line read: rev-parse and rev-parse --abbrev-ref answer with one line and a newline.
const gitLine = (cwd, args) => git(cwd, args).trim();

export async function startT43Ui({ token = T43_TOKEN, port = 0, withRepo = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-t43-e2e-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  const greetingPath = path.join(workspace, 'src', 'greeting.js');
  const dataPath = path.join(workspace, 'src', 'data.json');
  const untrackedPath = path.join(workspace, 'fresh.txt');
  await fsp.writeFile(greetingPath, T43_GREETING_COMMITTED, 'utf8');
  await fsp.writeFile(dataPath, T43_DATA_COMMITTED, 'utf8');
  await fsp.writeFile(path.join(workspace, 'README.md'), '# the T-43 workspace\n\nA real git repository.\n', 'utf8');

  let headSha = null;
  let repo = null;
  if (withRepo) {
    git(workspace, ['init', '--quiet', '--initial-branch=main']);
    // Written after the init so it is not committed: a one-file untracked count is a number the walk
    // asserts, and a stray .gitignore would change it.
    git(workspace, ['add', '--', 'README.md', 'src/greeting.js', 'src/data.json']);
    git(workspace, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'T-43 fixture baseline']);
    // The index is empty of pending work after the commit; anything later is a worktree edit or an
    // untracked file, never a staged change. The fixture asserts it here so a bad baseline cannot be
    // mistaken for a product bug three phases into the walk.
    const cleanAfterCommit = git(workspace, ['status', '--porcelain=v1']);
    if (cleanAfterCommit !== '') {
      throw new Error(`the T-43 fixture baseline is not clean: ${JSON.stringify(cleanAfterCommit)}`);
    }
    headSha = gitLine(workspace, ['rev-parse', 'HEAD']);
    // The worktree edit: one line changed in each file, both tracked, neither staged.
    await fsp.writeFile(greetingPath, T43_GREETING_EDITED, 'utf8');
    await fsp.writeFile(dataPath, T43_DATA_EDITED, 'utf8');
    await fsp.writeFile(untrackedPath, T43_UNTRACKED, 'utf8');
    repo = { root: workspace, headSha, branch: gitLine(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']) };
  }

  const app = createApp({
    dataDir,
    filesystemRoot: workspace,
    gateway: new ModelGateway({ backend: new NoBackend() }),
  });
  const ui = createUiServer({ app, token, host: '127.0.0.1', port });
  let started;
  try {
    started = await ui.start();
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const base = `http://127.0.0.1:${started.port}`;
  const headers = { authorization: `Bearer ${token}`, 'x-apex-ui': '1' };

  const get = async (pathname) => {
    const response = await fetch(`${base}${pathname}`, { headers });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const post = async (pathname, body) => {
    const response = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const stop = async () => {
    await ui.stop();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  };

  return {
    app, ui, root, dataDir, workspace, greetingPath, dataPath, untrackedPath, base, token, headers,
    headSha, repo, get, post,
    // Read from disk every time: a cached value would let the walk assert a claim about the file
    // without ever looking at it.
    readGreeting: () => fs.readFileSync(greetingPath, 'utf8'),
    readData: () => fs.readFileSync(dataPath, 'utf8'),
    // The checkpoint ledger, parsed. The walk reads this rather than trusting a response field, because
    // "the restore happened" is a claim about the ledger and the tree, not about a JSON body.
    checkpointLedger: () => {
      const file = path.join(dataDir, 'git-checkpoints.json');
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    operationLedger: () => {
      const file = path.join(dataDir, 'operations.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    // Whether a checkpoint ref still resolves to the commit it names - measured with git, not with the
    // product's own answer to the same question.
    refResolves: (refName, expectedSha) => {
      try {
        return gitLine(workspace, ['rev-parse', '--verify', '--quiet', refName]) === expectedSha;
      } catch {
        return false;
      }
    },
    // Move a checkpoint ref so that it no longer names its commit. This is what an operator would do by
    // hand, and it is what the panel's REF DRIFT badge must notice on its own.
    driftRef: (refName, toSha) => {
      git(workspace, ['update-ref', refName, toSha]);
      return gitLine(workspace, ['rev-parse', refName]);
    },
    git: (args) => git(workspace, args),
    async stop() { await stop(); },
  };
}
