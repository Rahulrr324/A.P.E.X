# APEX development workflow

This document covers how we build APEX across several coding environments. It is
about our tooling, not about APEX's own runtime capabilities. APEX's filesystem
inspection, model routing, Resource Fabric, and controlled execution are product
features implemented in `apex_app/`; they are unrelated to this process.

## Canonical repository

- GitHub `origin`: `https://github.com/Rahulrr324/A.P.E.X.git`
- Canonical branch: `main`, tracked as `main -> origin/main`
- `main` is the single integration branch. No permanent agent-, tool-, or
  environment-specific branches.

## Environments and what has actually been verified

| Environment | Kind | Sharing model | Verified in this session |
|---|---|---|---|
| VS Code | local editor | can use this same checkout | Assumption: not exercised here |
| Freebuff | local AI agent | uses this same checkout | Yes: read/inspect/test the workspace |
| OmniRush AI | local AI agent | can use this same checkout | Assumption: not exercised here |
| Antigravity | local coding environment | either shared checkout or its own clone | Assumption: not exercised here |
| Arena AI | cloud workspace | its own clone; nothing shared with this disk | Assumption: not exercised here |

Two tools using the same GitHub repository does **not** mean they share a working
tree. A cloud workspace always has its own filesystem and its own checkout.

Verified facts about the current checkout (Windows 11, Node 26.4.0):

- `git status --short --branch` reported `## main...origin/main` — no local commits
  ahead of the recorded remote ref, no unpushed work.
- `git fetch origin` **failed**: `remote: Repository not found.` The configured
  remote is unreachable from this machine (repository renamed, made private, or
  credentials missing). Nothing can be fetched or pushed until that is resolved.
  Because the remote cannot be inspected, "up to date with origin" is only as
  reliable as the last successful fetch.
- `git diff --check` reported no whitespace errors.

Assumptions that remain unverified:

- whether Antigravity and OmniRush use this same folder or their own clones;
- whether Arena can push to this repository (it cannot be tested from here);
- whether any Git hosting protection rules apply to `main`.

## Operating rules

1. **Inspect before touching.** `git status --short --branch`, `git fetch origin`,
   `git log -5 --oneline --decorate --all`, `git rev-parse HEAD`,
   `git rev-parse origin/main`. Read the files you are about to change.
2. **Preserve uncommitted work.** Never `reset --hard`, `clean`, force-push, or
   overwrite a file you did not write. If the tree is dirty with someone else's
   work, inspect it and leave it alone.
3. **One writer per file set.** If two environments share a checkout, simultaneous
   editing of the same files is unsafe: an editor buffer, an agent write, and a
   formatter can each silently overwrite the others, and no lock prevents it. Only
   one agent edits a given set of files at a time unless the changes are provably
   independent.
4. **Small, scoped changes with a stated definition of done.** One capability per
   change; keep unrelated files untouched.
5. **Validate against the revision you will publish.** Run the project's checks
   (`npm test`, `git diff --check`) and report the exact commands and counts. Results
   belong to a commit SHA, not to "the project".
6. **Reconcile before publishing.** Fetch again; if `origin/main` advanced, integrate
   it and rerun the affected tests. Never force-push or merge an entire agent
   branch wholesale.
7. **Push only a fast-forward.** After pushing, fetch and confirm
   `git rev-parse origin/main` equals the intended commit, and report the SHA.
8. **Say what was not verified.** If an environment cannot inspect a tree, run tests,
   or push, say so plainly.

## Separate checkouts (Arena, or a second local clone)

```sh
git fetch origin          # get the latest shared state
git status --short        # keep your own work visible
git log --oneline origin/main..HEAD   # what only you have
```

Integrate with a normal merge or rebase of `origin/main` onto your work — never with
a reset — resolve conflicts by understanding both sides, rerun the tests, then push
the fast-forward. If the remote is unreachable, stop: report the blocker instead of
inventing a sync path.

## Shared checkout (VS Code, Freebuff, OmniRush on this machine)

- Assume the other tools are editing right now. Re-read a file before rewriting it.
- Do not run commands that rewrite many files (formatters, codemods) without saying
  so first.
- Do not leave half-applied edits behind; finish a change or revert only your own
  hunks.
- A dev server or test run in one tool can collide with another (ports, temp files,
  the data directory). The test suite already isolates itself in `apex-test-*`
  temporary directories and never touches `~/.apex`. That isolation is enforced, not
  conventional: the harness sets `APEX_DATA_ISOLATED=1`, which makes APEX refuse to
  start unless `APEX_DATA_DIR` names a directory inside the OS temporary directory and
  not that root itself, and `createApp` re-checks it so a programmatic caller fails at
  construction instead of writing. Run any ad-hoc command the same way - an explicit
  `APEX_DATA_DIR` under the temp folder, or unset it and accept that the run targets
  your real store. Benchmarks are isolated the same way and refuse to delete anything
  they did not create.
- Run one benchmark at a time and never alongside a test run: both are timing
  measurements on a shared machine, and overlapping them invalidates the numbers
  rather than just the tests.

## Current milestone: Implementation 002

Bounded read-only filesystem inspection in `apex_app/`. Scope: explicit root,
containment, conservative link handling, bounded listings and reads, existing
authorization, independent verification, audit integrity, regression tests. Out of
scope: writes, deletion, shell execution, recursion, a broad ECP rewrite, new
dependencies, a UI.
