# Phase 13 — One-Shot Execution and Evidence Capture
status: preflight partially passed; execution halted before launch due to a confirmed path-compatibility blocker.
date_utc: 2026-10-12T18:30Z

## 1. Authorization and boundary note

This phase was authorized to perform one B7 diagnostic execution and evidence capture, but only if all
preflight checks in the phase brief pass. This report documents both the checks that passed and the
one check that failed, and it halts before execution because the failed check is a hard requirement and
the brief says: if any required condition fails, do not launch, record the blocker, and halt.

Hard boundaries for this phase:
- no rebuild, no source edit, no CMake edit, no directory creation as a probe, no file creation, no
  move/copy/rename/replace, no retry, no change to G7CAM/frozen evidence/thresholds/formulas/calibration,
  no change to M0/M1.
- preserve all earlier reports and artifacts.

## 2. Preflight checks that passed

### 2.1 Approved artifacts verified (read-only)

- Executable: `stark/build-b7diag-20261011/bm_b7_diagnostic.exe`
  - exists: True
  - size: 3168146 bytes
  - sha256: `a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6`
  - expected exe sha256: `a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6`
  - expected exe size: 3168146
  - result: MATCH

- Source: `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp`
  - exists: True
  - sha256: `5ff3a4e4fa952aa0761734e4b4e34bfbbe4810fbb1f89b73d85e5426a4e38ac9`
  - recorded exec_meta.json src_sha256: `5ff3a4e4fa952aa0761734e4b4e34bfbbe4810fbb1f89b73d85e5426a4e38ac9`
  - result: MATCH

- CMake: `stark/CMakeLists.txt`
  - exists: True
  - sha256: `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8`
  - recorded exec_meta.json cmake_sha256: `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8`
  - result: MATCH

- Exact native executable path (read-only):
  `E:\My Local AI\stark\build-b7diag-20261011\bm_b7_diagnostic.exe`
  - path exists: True
  - size: 3168146
  - sha256: `a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6`
  - result: MATCH

No artifact was rebuilt, edited, moved, copied, renamed, or replaced.

### 2.2 Proven launch mechanic available (read-only)

- The launch mechanic proven in Phase 10 is available and the executable is launchable via the
  resolved native absolute path with cwd = exe parent. This phase did not re-prove launchability by
  relaunching; it relied on the preserved Phase 10 evidence for that mechanic.

## 3. Working-directory and CSV-path compatibility check

This was the critical preflight step. The brief requires both:

- diagnostic base directory reachability via the chosen cwd, and
- exact persistent CSV destination reachability via the configured/existing host path, using the
  existing approved source and configuration, without forbidden paths and without changing configuration.

### 3.1 Diagnostic base directory

From the proposed candidate cwd `stark/` (read-only inspection):

- `stark/build/bm_b7_diagnostic` exists, is a directory, is empty, and is stat-able.
- resolved native: `E:\My Local AI\stark\build\bm_b7_diagnostic`
- From `stark/`, the default relative base directory `build/bm_b7_diagnostic` resolves to an existing
  directory. So the diagnostic base-directory precondition is satisfiable from this cwd.

This matches the intended design and the earlier successful runs.

### 3.2 Persistent CSV destination

The required persistent CSV destination is:

`work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`

The existing `run2/exec_meta.json` records:

`"host_csv": "work/b7_diag_20261011_paired_capture/run2/paired_samples.csv"`

Read-only inspection found:

- From project root, `work/b7_diag_20261011_paired_capture/run2` exists and is inspectable.
- The intended csv does not yet exist: `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`
  does not exist.
- There is also a `stark/work/` directory present in the tree (read-only): `stark/work` exists and is a
  directory, containing `stark/work/b7_diag_20261011_corrected`.
- There is **not** a `stark/work/b7_diag_20261011_paired_capture` tree; specifically
  `stark/work/b7_diag_20261011_paired_capture/run2` does not exist, and
  `stark/work/b7_diag_20261011_paired_capture/run2/paired_samples.csv` does not exist.

### 3.3 The conflict

If the diagnostic is launched from cwd `stark/`, a relative host-capture path
`work/b7_diag_20261011_paired_capture/run2/paired_samples.csv` is interpreted relative to the cwd.
Read-only resolution shows:

- From `stark/`, `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv` resolves to
  `stark/work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`, which is the **wrong tree**:
  `stark/work/...`, not the intended project-root `work/...`.
- From project root `/e/My Local AI`, the same literal relative path resolves to the intended tree
  `E:\My Local AI\work\b7_diag_20261011_paired_capture\run2\paired_samples.csv`.

So the literal host_csv value can reach the intended tree only if the cwd is the project root (or a
cwd where `work/...` still maps to the project root `work/`), not to `stark/`.

### 3.4 Why no approved configuration resolves the conflict

Two candidate ways to reach the intended tree from cwd `stark/` were inspected read-only against the
existing validator rules (sourced from `validate_host_capture_path` in
`bm_b7_diagnostic.cpp`, lines 1134-1159):

Candidate A: `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`
- Validator result: accepted (empty reason string).
- Actual target from `stark/`: `stark/work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`
  (wrong tree).
- So this candidate is validator-acceptable but writes to the wrong destination from cwd `stark/`.

Candidate B: `../work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`
- Validator result: rejected, reason: `'..' path traversal is not allowed`.
- Actual target from `stark/`: the intended tree
  `E:\My Local AI\work\b7_diag_20261011_paired_capture\run2\paired_samples.csv`.
- So this candidate reaches the intended tree from cwd `stark/` but is forbidden by the validator.

Therefore, from cwd `stark/`, there is no way to reach the exact intended project-root destination
using the existing approved source and configuration:
- the literal approved host_csv reaches the wrong tree, and
- the obvious corrected relative path that would reach the intended tree is rejected by the existing
  validator.

### 3.5 No alternative unapproved configuration is used

This report does not invent a different destination, does not change the configured host path, does not
propose editing `validate_host_capture_path`, and does not propose a different cwd that would silently
overwrite another tree. The brief explicitly says: if the diagnostic base directory and exact persistent
CSV destination cannot both be satisfied using the existing approved source and configuration, stop before
execution and report the conflict.

That condition is met here.

## 4. Execution decision

Execution decision: **HALTED before launch.**

Reason: preflight check 2 failed. The diagnostic base directory is reachable from the candidate cwd, but
the exact persistent CSV destination cannot be reached from that cwd using the existing approved source and
configuration without violating the existing validation rules.

No B7 diagnostic execution was performed in this phase.

## 5. Evidence captured

Because execution was halted, no new run evidence was produced. Preserved evidence from prior phases is
unchanged:
- `work/b7_diag_20261011_paired_capture/run10_probe_stdout.txt`
- `work/b7_diag_20261011_paired_capture/run10_probe_stderr.txt`
- `work/b7_diag_20261011_paired_capture/run10_winapi_stdout.txt`
- `work/b7_diag_20261011_paired_capture/run10_winapi_stderr.txt`
- `work/b7_diag_20261011_paired_capture/run10_sha_stdout.txt`
- `work/b7_diag_20261011_paired_capture/run10_sha_stderr.txt`
- `work/b7_diag_20261011_paired_capture/run10_sha2_stdout.txt`
- `work/b7_diag_20261011_paired_capture/run10_sha2_stderr.txt`
- `work/b7_diag_20261011_paired_capture/run10_sha3_stdout.txt`
- `work/b7_diag_20261011_paired_capture/run10_sha3_stderr.txt`
- `work/b7_diag_20261011_paired_capture/run10_stdout.bin` (empty; sha256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`)
- `work/b7_diag_20261011_paired_capture/run10_stderr.bin` (empty; sha256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`)
- `work/b7_diag_20261011_paired_capture/run10_winapi_stdout_only.txt`
- `work/b7_diag_20261011_paired_capture/run2/exec_meta.json`
- `work/b7_diag_20261011_paired_capture/run2/exitcode.txt`
- `work/b7_diag_20261011_paired_capture/run2/stdout.txt`
- `work/b7_diag_20261011_paired_capture/run2/stderr.txt`

No new CSV, stdout, stderr, or exit-status artifact was created by this phase.

## 6. CSV validation

Not applicable: no CSV was produced, because the run was not executed.

If a run is later executed and produces a CSV, the validation contract is:

- file exists at the configured host-capture path;
- CSV with a header row;
- exactly 300 data rows (macro_replicates = 6, measurement_count = 50);
- each row contains replicate, iteration, minimal_sec, instrumented_sec, signed_overhead_pct;
- all numeric fields finite;
- `signed_overhead_pct = 100 * (instrumented_sec - minimal_sec) / minimal_sec`;
- no forbidden markers in path or contents.

This validation was not executed and is stated as the contract, not as a performed result.

## 7. Calibration and classification

Not applicable: no run was executed, so no calibration output or classification was produced in this phase.

If a run is later executed, the calibration values to preserve are:

- `mean_overhead_pct` (threshold `<= 2.0000 %`)
- `worst_case_overhead_pct` (threshold `<= 10.0000 %`)
- `median_deviation_pct` (threshold `<= 2.0000 %`)

and the classification to preserve is the one produced by the diagnostic's own rules
(`NOT_ELEVATED`, `INSUFFICIENT_REPLICATION`, `INCONCLUSIVE`, `REPRODUCIBLE_ELEVATION`), recorded exactly
as produced. The historical comparison reference, if reported, is a datum only, not a pass/fail claim.

## 8. No-change confirmation

Confirmed read-only for this phase:
- no source, executable, or CMake file was modified;
- no thresholds, calibration formulas, or classification rules were changed;
- no G7CAM records, frozen evidence, or acceptance logic were changed;
- no directory or file was created, moved, copied, renamed, or replaced;
- the persistent CSV destination was not written, created, or altered.

## 9. Unresolved issues and minimum next action

Unresolved:
- The exact intended persistent CSV destination cannot be reached from cwd `stark/` using the existing
  approved host_csv value and the existing validator.
- It is not yet determined which exact cwd/host-path combination satisfies both the diagnostic base
  directory and the exact intended CSV destination without a forbidden path and without changing
  configuration.

Minimum next action (do not perform in this phase):
1. Decide and record an explicit cwd and explicit host-capture path that satisfy both constraints:
   - diagnostic base directory reachable and acceptable, and
   - exact intended persistent CSV destination reachable without forbidden paths and without changing
     configuration.
2. If no such combination exists under the existing approved source/config, identify and record that as a
   configuration conflict and do not launch.
3. If a valid combination exists, re-run preflight for that combination, then, only if separately
   authorized, execute once and validate against the Part C contract.

## 10. Hard boundaries held

- No execution of `bm_b7_diagnostic.exe`.
- No rebuild, no source/CMake edit.
- No directory creation as a probe and no file creation.
- No move/copy/rename/replace of artifacts.
- No change to G7CAM records, frozen evidence, thresholds, formulas, calibration, classification, or M0/M1.
- All prior reports and artifacts preserved without modification.

## 11. Deliverable

`work/b7_diag_20261011_paired_capture/phase13_report_one_shot.md`
