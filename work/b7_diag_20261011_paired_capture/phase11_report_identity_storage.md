# Phase 11 — Read-Only Identity and Storage Investigation
status: read-only; no B7 execution, no directory creation, no file creation, no edit, no retry.
date_utc: 2026-10-12T18:10Z

## 1. Objective and boundary

Investigate the two unresolved items from `phase10_report_launch_method.md` without running the
diagnostic again:

- Part A: whether independent process image identity can be established from existing launch
  evidence;
- Part B: the evidence-supported explanation for the `status: ABORTED — cannot create diagnostic
  base directory: build/bm_b7_diagnostic` failure seen in the Phase 10 launch probe.

Hard boundary for this phase: do not execute or relaunch `bm_b7_diagnostic.exe`, do not create
directories or files as probes, do not edit source/config/environment/mounts/shell startup, do not
move/copy/rename/replace artifacts, do not alter the persistent CSV destination, and do not modify
G7CAM records, frozen evidence, thresholds, formulas, calibration, or M0/M1.

## 2. Read-only sources inspected

### 2.1 Reports
- `work/b7_diag_20261011_paired_capture/phase10_report_launch_method.md`
- `work/b7_diag_20261011_paired_capture/phase9_report_launch_path.md`
- `work/b7_diag_20261011_paired_capture/phase8_report_path_mapping.md`
- `work/b7_diag_20261011_paired_capture/run2/exec_meta.json`
- `work/b7_diag_20261011_paired_capture/run2/exitcode.txt`

### 2.2 Phase 10 probe artifacts (read-only; these are the only preserved launch records)
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
- `work/b7_diag_20261011_paired_capture/run10_stdout.bin`
- `work/b7_diag_20261011_paired_capture/run10_stderr.bin`

### 2.3 Diagnostic source (read-only; Windows branch only, with line ranges)
- `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp`
  - diagnostic directory constant and isolation design: lines 40-79, 155-244
  - path construction and validation: lines 155-244 (esp. `validate_diagnostic_path` and
    `make_blob_path`), 267-282 (`validate_diagnostic_dir`), 325-339 (`create_run_owned_blob`
    failure path)
  - run entry point, default directory, exit codes: lines 1360-1427
  - host-capture/paired-artifact path handling: lines 1104-1239 (`PairedArtifact::write`,
    `validate_host_capture_path`, `make_paired_artifact_path`)
  - main abort/exit logic: lines 1240-1359, 1360-1427

## 3. Part A — Process image identity: can it be completed from existing records?

### 3.1 What was preserved
The Phase 10 probes preserved:
- stdout text of the diagnostic report (`run10_probe_stdout.txt`), which includes the diagnostic’s
  own header and the `status: ABORTED — ... build/bm_b7_diagnostic` message;
- stderr (empty) (`run10_probe_stderr.txt`);
- raw captured stdout/stderr bytes (`run10_stdout.bin`, `run10_stderr.bin`), both empty
  (sha256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, the empty-file hash);
- probe helper stderr logs recording the resolved executable path, the SHA-256 of that exe
  (matches expected), the `CreateProcessW ok=1 last_error=0` result, the child pid, and the
  `WaitForSingleObject=0` / `GetExitCodeProcess ok=1 exit_code=2` results;
- a few recorded child pids from the helper logs (e.g. 26108, 7464, 23712), captured at probe time.

### 3.2 What was NOT preserved
- The child process handle (`pi.hProcess`) was not saved to a file; it was closed by the probe
  after waiting and reading.
- No image-path query result was successfully preserved: `QueryFullProcessImageNameW` returned
  empty/success-false in the probe, and `GetProcessImageFileNameW` is not available from
  `kernel32.dll` in the probe’s ctypes view. The probe did not complete a working `Psapi.dll`
  equivalent before closing the handle.
- No independent kernel-derived image path (device path or Win32 path) is present in the artifacts.

### 3.3 Conclusion for Part A
Independent image-path verification by the kernel API **cannot be completed from the existing
records**, because the only available child handle was closed and no successful image-path query
result was preserved. The Phase 10 report’s identity claim therefore remains a strong inference
(exe file SHA-256 match plus diagnostic-specific report text), not a kernel-verified image path.

This does not overturn the launch-mechanics finding: the process did start and printed the
diagnostic’s own report, which is specific to this executable. But the exact “kernel image path”
proof requested in Phase 10/11 is not available from what was saved.

### 3.4 What would be required to complete Part A
- Repeat the launch mechanic in a probe that preserves the child `hProcess` until after a
  successful image-name query using a working API (e.g. `Psapi.dll` `GetProcessImageFileNameW` or
  `GetModuleFileNameExW`, or `QueryFullProcessImageNameW` when it returns a usable path), and save
  the resulting image path verbatim.
- Compare that saved image path to the resolved exe path.
- This is a probe-engineering task; it is not a B7 execution, and it is not carried out in this
  phase by request.

## 4. Part B — Run-owned storage failure: evidence-supported explanation

### 4.1 Observed result
The Phase 10 probe that did start the diagnostic printed, near the top of its report:
- `diagnostic blob: (no run-owned blob was created)`
- `status: ABORTED — run-owned storage could not be created (nothing overwritten): cannot create
  diagnostic base directory: build/bm_b7_diagnostic`
- `classification: INSUFFICIENT_REPLICATION (incomplete run is NOT reported as success)`
- `cleanup: no run-owned storage was created; nothing removed`
- exit code `2`

This matches the source’s fail-closed path: when `create_run_owned_blob()` cannot create the base
diagnostic directory, it sets `out.failure = "cannot create diagnostic base directory: " +
paths.directory`, and `run_bm_b7_diagnostic()` aborts with exactly that text.

### 4.2 What the diagnostic actually tries to create
- `kDiagnosticDir` is the relative string `"build/bm_b7_diagnostic"` (source line 162).
- `DiagnosticPaths::directory` defaults to `kDiagnosticDir` (source line 235).
- Validation (`validate_diagnostic_dir`) accepts only that exact directory or a subdirectory of it;
  it rejects absolute paths, leading `/` or `\`, colons, `..`, and anything outside the prefix
  `build/bm_b7_diagnostic/`.
- Creation is via `ensure_directory()` = `create_directory_exclusive()` (source lines 263-282),
  i.e. an exclusive `mkdir`/_mkdir. The run-owned blob directory is then created as a subdirectory
  of that base directory (source lines 325-339).

So the diagnostic does **not** create `stark/build-b7diag-20261011/build`; it creates
`**/build/bm_b7_diagnostic`. The path is relative and interpreted relative to the process working
directory at launch.

### 4.3 What was actually present
Read-only inspection of the filesystem:
- Under the exe’s parent `stark/build-b7diag-20261011`, there is **no** `build/` entry and
  **no** `build/bm_b7_diagnostic`. The build tree in that folder contains only the exe, build
  scripts, and CMake/Ninja metadata.
- There **is** a `stark/build/bm_b7_diagnostic` directory (empty) elsewhere in the project — this is
  the directory used by the earlier successful runs (run1/run2/run3), not a directory under the
  exe’s build folder.
- `find ... -name bm_b7_diagnostic -type d` returns only `stark/build/bm_b7_diagnostic`.
- The student/query requested destination `work/b7_diag_20261011_paired_capture/run2` exists,
  is a directory, is resolvable, and is stat-able read-only. Its parent `work/b7_diag_20261011_paired_capture/`
  is also present. The intended persistent CSV `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`
  does **not** exist.

### 4.4 Conclusion for Part B
The most direct, evidence-supported explanation is:

- The Phase 10 probe launched the exe from `cwd = exe parent` = `stark/build-b7diag-20261011`.
- From that cwd, the diagnostic’s default relative base directory resolves to
  `stark/build-b7diag-20261011/build/bm_b7_diagnostic`.
- That directory did not exist, and the probe did not (and, per the read-only boundary, could not)
  create it.
- The diagnostic’s exclusive `mkdir` for `build/bm_b7_diagnostic` therefore failed, and the
  fail-closed path produced exactly the observed `status: ABORTED ... cannot create diagnostic base
  directory: build/bm_b7_diagnostic`.

This is not a permissions problem, not a “wrong destination” problem, and not evidence that the
diagnostic cannot run when launched from a directory that already contains its required base
directory. It is the expected behavior when the default relative directory does not exist under the
exe’s cwd and the diagnostic runs in its fail-closed mode.

This is also consistent with the earlier successful runs, which were launched from a cwd where
`build/bm_b7_diagnostic` already existed (`stark/` in the earlier run environment, where
`stark/build/bm_b7_diagnostic` was present).

### 4.5 Caveat
This conclusion is about the Phase 10 probe’s failure mode, not a claim that a later authorized B7
run would succeed. The probe did not establish that the required base directory can be created in the
chosen launch cwd, nor that the persistent host CSV path could be successfully written. Those remain
open preconditions.

## 5. Relationship to the persistent host CSV destination

The persistent destination in scope is `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`.
Read-only inspection shows:
- its parent directory exists and is stat-able;
- no `paired_samples.csv` exists there yet;
- the diagnostic does **not** write the CSV to that location from its default behavior — the CSV is
  written under the validated diagnostic directory (`build/bm_b7_diagnostic/.../paired_samples.csv`)
  by `PairedArtifact::write()` (source lines 1120-1239), using a host path configured by the caller
  via `set_host_path()`.

So the fact that the Phase 10 probe aborted before any CSV write is explained by the base-directory
failure, not by a CSV-path issue. Whether the intended persistent host CSV would be produced in a
later authorized run depends on (a) the launch cwd/base-directory precondition and (b) whether a host
path is configured and valid. That is outside this phase’s read-only scope and is not tested here.

## 6. Confirmed facts / hypotheses / unresolved

### Confirmed
- The Phase 10 probe artifacts preserve the diagnostic’s stdout report text and the helper logs
  recording the resolved exe path, its SHA-256 match, `CreateProcessW ok=1 last_error=0`, child pids,
  wait result, and exit code 2.
- The child process handle was not saved; no successful kernel image-path query result was saved.
- `QueryFullProcessImageNameW` returned empty/false-success in the probe; `GetProcessImageFileNameW`
  is not available from `kernel32.dll` in this probe’s ctypes view.
- `run10_stdout.bin` and `run10_stderr.bin` are empty (empty-file sha256), because the pipes were
  drained after exit by the probes that used inheritable pipes in the later helper variants.
- The diagnostic’s default base directory is the relative string `build/bm_b7_diagnostic`, validated
  to be exactly that or a subdirectory of it, created via exclusive mkdir.
- From the probe’s launch cwd (`stark/build-b7diag-20261011`), `build/bm_b7_diagnostic` did not
  exist, and the exe-parent folder itself contains no `build/` entry.
- `stark/build/bm_b7_diagnostic` exists elsewhere (the earlier run base directory), but is not
  under the exe’s build folder and was not the probe’s cwd.

### Hypotheses (not proven)
- The Phase 10 storage failure would likely not occur if the diagnostic were launched from a cwd
  where `build/bm_b7_diagnostic` already exists and is writable by the process, because the same
  relative path would then resolve to an existing (or creatable) base directory.
- The intended persistent host CSV is not produced by default; it requires a configured host path and
  a successful (non-aborted) run that satisfies the per-replicate validity preconditions in
  `PairedArtifact::write()`.

### Unresolved
- Whether a later authorized run would actually create the required base directory and write the CSV
  in this environment — not tested and not provable from the existing probe records.
- Whether the persistent CSV path as literally written in `exec_meta.json`
  (`work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`) would be accepted/writable when
  configured as the host path — not tested here (would require either a successful run or a
  non-creating probe of the path, which the read-only pickup boundary discourages).

## 7. Minimum proposed corrective action (do not perform)

For a later authorized run to be possible, the minimum precondition is to launch the diagnostic from
a working directory where the default relative base directory `build/bm_b7_diagnostic` either already
exists and is writable, or can be created by the process. Concretely, that likely means either:

- launching from a cwd such that the relative path `build/bm_b7_diagnostic` resolves to an existing
  writable directory (e.g. the earlier successful run’s base directory), **or**
- ensuring the required base directory exists and is writable relative to the chosen launch cwd
  before launch.

Additionally, if a persistent host CSV is required at
`work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`, the launch must configure that host
path via the diagnostic’s host-path interface and the path must be valid and writable by the process.

None of this is carried out in this phase.

## 8. Hard boundaries held

- No execution or relaunch of `bm_b7_diagnostic.exe`.
- No directory or file creation as probes.
- No build/compile/cmake/ninja.
- No source/config/environment/mount/shell-startup edits.
- No move/copy/rename/replace of artifacts.
- No change to the persistent CSV destination, G7CAM records, frozen evidence, thresholds, formulas,
  calibration, or M0/M1.
- All prior reports and artifacts preserved without modification.

## 9. Deliverables

- `work/b7_diag_20261011_paired_capture/phase11_report_identity_storage.md` — this report.

## 10. Suggested next read-only work, if any

If Part A is to be closed read-only before any authorized run, the next step is a non-executing
probe design review (or a one-shot probe that preserves the child handle only long enough to perform
and save a successful `Psapi.dll`/`QueryFullProcessImageNameW` image path), with the probe itself
running only if separately authorized. If the storage precondition is to be closed, the next read-only
step is to choose an explicit launch cwd (and, separately, an explicit host-capture path) and verify
read-only that the required base directory exists and is stat-able/writable from that cwd, without
creating anything.
