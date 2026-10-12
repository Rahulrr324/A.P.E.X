# APEX / STARK Phase 1 — B7 Paired Diagnostic Completion
## Phase 1 Report: Baseline Established; Root Cause Identified; No Run Yet

status: Phase 1 complete. Build, preflight, execution, CSV validation, calibration, and final report
(Phases 4–9) are NOT started. This is a Phase 1 evidence report only.

date_utc: 2026-10-12T20:20Z

## 0. Decision points gated (not answered yet)

Before I build or run anything, the mission’s Phase 1 says to inspect the local copy and establish the
baseline. I have done that. The remaining questions that affect Phases 3–6 are:

1. **Build location:** Should the corrected diagnostic be built into the already-existing isolated build
   directory `stark/build-b7diag-20261011/` (reusing the previously approved executable path), or into a
   fresh isolated build directory?
2. **Host-capture runtime config mechanism:** The current source has no CLI flag to set the host-capture
   directory. The smallest safe correction is adding a CLI option (recommended `--host-capture-dir`). Is
   that acceptable, or do you want a different invocation model?
3. **Run authorization:** I will not launch the diagnostic until you confirm the build succeeded and the
   preflight conditions are satisfied. I am stopping before any launch.

I can proceed with Phase 3 (smallest safe correction) once you confirm (1) and (2), or I can propose a
concrete default and wait for objection.

## 1. Exact local baseline (read-only for evidence capture; helpers under work/)

Run helper used:
- `work/_phase1_baseline.py` -> `work/_phase1_baseline_stdout.txt` (stdout), `work/_phase1_baseline_stderr.txt` (stderr, empty)

Git state (via `git.exe -C "E:\My Local AI"`):
- `.git` present at project root: **yes**
- branch: **main**
- latest commit (short): **ba19cda**
- `git status --short`:
  ```text
  D  .freebuff/project-id
  D  .vscode/settings.json
  ?? .freebuff/
  ?? .vscode/
  ?? stark/nul
  ?? work/_phase1_baseline.py
  ?? work/_phase1_baseline_stderr.txt
  ?? work/_phase1_baseline_stdout.txt
  ```
- remotes:
  ```text
  origin	https://github.com/Rahulrr324/A.P.E.X.git (fetch)
  origin	https://github.com/Rahulrr324/A.P.E.X.git (push)
  ```

Important nuance: only `.freebuff/project-id` and `.vscode/settings.json` are currently **deleted** from
the index relative to the checked-out HEAD; the other items are untracked. `.freebuff/` and `.vscode/`
show as untracked directories because their contents differ from what is committed. `stark/nul`,
`work/_phase1_*.py`, and the two `work/_phase1_baseline_*.txt` are untracked new files. I have not
staged or committed anything.

Source baseline:
- `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp`
  - exists: yes
  - size: 67389 bytes
  - sha256: `5ff3a4e4fa952aa0761734e4b4e34bfbbe4810fbb1f89b73d85e5426a4e38ac9`
- `stark/CMakeLists.txt`
  - exists: yes
  - size: 12920 bytes
  - sha256: `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8`

Executable baseline:
- `stark/build-b7diag-20261011/bm_b7_diagnostic.exe`
  - exists: yes
  - size: 3168146 bytes
  - sha256: `a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6`
  - file type: PE32+ executable for MS Windows 5.02 (console), x86-64, 20 sections
- Note: the source currently on disk matches the previously recorded source hash and the exe matches the
  previously recorded executable hash, so the existing isolated build artifact is consistent with the local
  source before any correction.

Intended persistent CSV destination (relative to project root):
- `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`
  - exists: **no**
- `work/b7_diag_20261011_paired_capture/run2/` exists: **yes** (directory)
  - contents:
    - `exec_meta.json` (586 bytes, sha `b9fa55373a218d8b5c2d6eecea38883c774f33f32affa21da3a9018e5e21c5b1`)
    - `exitcode.txt` (4 bytes, sha `743c7850cccfba5e53a9002663ec1ddd1079315a98bdbfdde10e6044f56abefe`)
    - `stderr.txt` (0 bytes)
    - `stdout.txt` (0 bytes)

Diagnostic-owned base directory (relative to project root):
- `build/bm_b7_diagnostic/` exists: **yes** (directory)
  - contents: one run directory `run_1791799501127597800_0/`
- This is the directory the diagnostic wants to create/manage under the chosen working directory.

Old CSV under root `build/` (preserve; do not overwrite):
- `build/bm_b7_diagnostic/run_1791799501127597800_0/paired_samples.csv`
  - exists: yes
  - size: 13358 bytes
  - sha256: `d0fca204c9443ef2d0113c12884dfc0fbfc1d64f08c3903f89c98c0c4bf5163a`
  - structural sanity (read-only):
    - header: `replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct`
    - total lines incl header: 301
    - data rows: 300
    - unique (replicate, iteration) pairs: 300
    - rows not matching expected 5 cols / finite positive numeric: 0
    - per-replicate counts: `{0: 50, 1: 50, 2: 50, 3: 50, 4: 50, 5: 50}`
  - This is a valid-looking 300-row paired CSV and should be preserved untouched. It is NOT the new
    capture destination.

Frozen evidence / manifests present (preserve; do not modify):
- `stark/reports/evidence_manifest.json` (10822 bytes, sha `7a8dd9de17c4effdc9153ac4505a6f6f95ed662ef204cab52ad279c4bf01fc5a`)
- `stark/reports/source_change_manifest.json` (5583 bytes, sha `533f01ebbea8bc32c69007a22fe945dff3cb52e9cd5440011121f010240c8aa2`)
- `stark/reports/historical_artifact_inventory.json` (14231 bytes, sha `5f5532b47a5e620618cd8f029a70edcca5be2095f8c4f4e743fe125d13a391cf`)
- `stark/reports/m0_acceptance_matrix.json` (10724 bytes, sha `869ea3fc620567bdb6a2a04deb0359d6e427c55d66f3bbb80aaae6a5504bc795`)
- `stark/reports/M0_FINAL_REPORT_v2.3.md` (13242 bytes, sha `cd7772f9c311e132b884ba0d9bccc2887351c9be89c676fb88875183ff9f159b`)
- `stark/reports/g7-campaign-affinityfix/G7_FROZEN_CAMPAIGN_RESULT.md` (17567 bytes, sha `7473cb866b7d915156518f189df8d98797c54277576d0a5cff1674ca90876dc9`)
- `stark/reports/g7-campaign-affinityfix/records_sha256.txt` (3660 bytes, sha `bf479cbcf08eef94bfd6481f16e6a881e0e15b52cbec05aaed0377afe2edc6ae`)
- `stark/reports/gate_results/G7.json` (9233 bytes, sha `9e090fda4e42ad342a11606060a602d1f4d9211539b3cd1e0e2898a192c77c50`)
- `stark/reports/gate_results/G4.json` (5895 bytes, sha `d0f727a332b3f52684f1a42e0a183fd9b93a55f640ede7b0f533f36a1319ba30`)
- `stark/M0/verifier.txt`: **not present**
- `stark/M0/M0.json`: **not present**

Frozen integrity scripts available locally (used as references for the frozen-evidence invariants):
- `stark/scripts/recompute_g7_frozen.py` (9388 bytes)
- `work/scripts/v8_postrun_integrity.py` (5720 bytes)
- `work/scripts/v8_prrun_integrity.py` (4256 bytes)
- `work/scripts/verify_freeze30_end.py` (4738 bytes)
- `work/scripts/g7frozen_after.txt`, `work/scripts/g7frozen_before.txt`, `work/scripts/v8_postrun_integrity.json`,
  `work/scripts/v8_prrun_integrity.json`

## 2. Core finding from Phase 1 source inspection: host path is never configured

### 2.1 Where the host-capture capability is defined
All locations below are in `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp`:

- `PairedArtifact::set_host_path()` is defined at line 1253:
  `void set_host_path(const std::string& p) { host_path = p; }`
- `PairedArtifact::write()` checks `host_path` at line 1152:
  `if (host_path.empty()) { note = "paired artifact not written: no host path configured"; return; }`
- `PairedArtifact::write()` builds the final CSV path at lines 1159-1162 using `host_path + "paired_samples.csv"`.
- `PairedArtifact::write()` validates the final path at line 1183 via `validate_host_capture_path(path)`.
- `PairedArtifact` is instantiated in `run_bm_b7_diagnostic()` at line 1323:
  `PairedArtifact paired;`
- `PairedArtifact` is passed to `write_paired_artifact_if_valid()` at line 1378:
  `write_paired_artifact_if_valid(paired, rep.minimal, rep.instrumented);`
- `write_paired_artifact_if_valid()` at lines 1288-1290 simply calls `art.write(minimal, instrumented);`.

### 2.2 Where the missing call is
`main()` at lines 1400-1424:
- parses only `[diagnostic-directory]` from `argv[1]` into `DiagnosticPaths paths.directory`
- does **not** call `paired.set_host_path(...)` anywhere
- calls `run_bm_b7_diagnostic(Protocol{}, paths)` at line 1419
- `run_bm_b7_diagnostic()` creates `PairedArtifact paired;` at line 1323 and never has a host path
  configured because nothing called `set_host_path()` before `write_paired_artifact_if_valid()`.

So the missing call is not “deep” in the write path; it is simply absent from `main()` (and there is no CLI
surface to supply it). That is the direct root cause of “CSV never produced” for any invocation that does
not otherwise configure the host path.

### 2.3 Why the previously explored “run from stark/” idea does not work as stated
From project root, the intended host-capture parent
`work/b7_diag_20261011_paired_capture/run2/` exists. But from `stark/` as cwd:
- the literal relative path `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv` resolves to
  `stark/work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`, which does **not** exist and is
  the **wrong tree** (`stark/work/...` vs the intended top-level `work/...`);
- the corrected relative path `../work/b7_diag_20261011_paired_capture/run2/paired_samples.csv` resolves to
  the intended tree, but **fails the existing `validate_host_capture_path()`** because it contains `..`.

So the earlier Phase 13 blocker is real and is caused by a combination of:
- cwd choice changes the meaning of the relative host path, and
- the existing validator rejects `..`, and
- there is no CLI mechanism to pass a host path that is valid from `stark/`.

### 2.4 Why the project-root working directory is the natural fix
From `E:\My Local AI` as cwd:
- the literal relative host path `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv` resolves to
  the intended `E:\My Local AI\work\b7_diag_20261011_paired_capture\run2\paired_samples.csv`, and that
  parent directory exists now;
- the literal relative diagnostic dir `build/bm_b7_diagnostic` resolves to the existing
  `E:\My Local AI\build\bm_b7_diagnostic\`, which currently contains one run directory;
- both paths are relative, non-absolute, non-traversal, and do not contain the forbidden markers, so they
  pass the current validators if the host path is actually configured.

So running from the project root with an explicit host-capture configuration does what the previous Phase 13
attempt could not: it satisfies both the diagnostic-dir and host-capture-path requirements using the existing
validators and the existing relative-path design.

### 2.5 Other blockers considered and disposition
- **Host path never configured:** confirmed blocker. Fix needed.
- **No CLI to supply host-capture dir:** confirmed blocker. Fix needed.
- **Diagnostic-dir validator vs intended path:** not a blocker for the proposed fix; from the project root,
  the intended relative diagnostic dir `build/bm_b7_diagnostic` passes `validate_diagnostic_dir()` (it is
  exactly `kDiagnosticDir`).
- **Host-path validator vs intended path:** not a blocker for the proposed fix from the project root; the
  intended relative host path passes `validate_host_capture_path()`.
- **Intended parent directory missing:** not a blocker; `work/b7_diag_20261011_paired_capture/run2/` exists.
- **Exclusive creation / flush / durability defect:** not evidenced by Phase 1. The existing code already
  uses exclusive create + buffered write + fflush + `_commit`/`fsync` + RAII close. No defect found in
  Phase 1. This is not a root cause of the current “no CSV ever” problem.
- **Old CSV provenance not established by Phase 13:** confirmed; I verified its structure and hash now, but
  its runtime provenance (which invocation created it) is not independently established here. It is preserved
  and will not be overwritten.

## 3. Root cause statement

The paired-sample CSV is never produced because `main()` never configures the host-capture path on the
`PairedArtifact`, and today there is no CLI mechanism to supply one. The `validate_host_capture_path()` and
`validate_diagnostic_dir()` validators are fine for the intended relative paths when the process runs from the
project root; the earlier failure was caused by the cwd choice plus the missing configuration mechanism, not
by a defect in the validators or in exclusive-create/flush logic.

## 4. Recommended smallest safe correction (design only; not applied yet)

1. Keep the existing one-positional-argument form for backward compatibility:
   `bm_b7_diagnostic.exe [diagnostic-directory]`
2. Add a second optional named argument to configure the host-capture directory, for example:
   `--host-capture-dir <relative-dir>`
   - Keep it optional so legacy invocations that do not request persistence continue to work unchanged
     (artifact not attempted).
   - Keep the value relative, non-absolute, non-traversal, and subject to the existing `validate_host_capture_path()`.
3. In `main()`, after parsing:
   - keep existing `DiagnosticPaths paths` behavior,
   - if `--host-capture-dir` was supplied, call `paired.set_host_path(...)` and carry that into
     `run_bm_b7_diagnostic()` / the `paired` instance used there.
4. Ensure the same `paired` instance used in `run_bm_b7_diagnostic()` is the one configured, i.e. configure
   before calling `run_bm_b7_diagnostic()` (or thread the config in the same way the existing `paths` are
   threaded).
5. For the authorized run:
   - working directory: `E:\My Local AI`
   - diagnostic dir: `build/bm_b7_diagnostic`
   - host-capture dir: `work/b7_diag_20261011_paired_capture/run2`

This is the smallest change that unblocks the missing-CSV behavior without weakening validators or altering
benchmark/calibration/frozen-evidence logic.

## 5. What I did not do ( Phase 1 stopping condition )

- I did not edit source or CMake.
- I did not build.
- I did not run preflight beyond read-only verification.
- I did not execute the diagnostic.
- I did not validate any new CSV (none produced).
- I did not change any frozen evidence or acceptance logic.

## 6. Immediate next step

Confirm:
1. build location preference (reuse `stark/build-b7diag-20261011/` vs fresh isolated dir),
2. acceptance of the `--host-capture-dir` CLI extension (or your alternative),
3. go/no-go for me to implement Phase 3 and continue.

Once confirmed, I will:
- back up the original source hash in the report (already recorded above),
- make the smallest safe correction,
- rebuild in isolation,
- run the Phase 5 preflight,
- execute exactly one controlled run from the project root,
- validate the CSV and recalc calibration,
- verify frozen-evidence integrity,
- and produce the single final report.
