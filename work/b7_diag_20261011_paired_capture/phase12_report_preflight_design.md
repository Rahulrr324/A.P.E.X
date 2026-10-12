# Phase 12 — Read-Only Preflight and Probe Design
status: read-only; no B7 execution, no build, no directory/file creation, no edit.
date_utc: 2026-10-12T18:20Z

## 1. Objective and boundary

Prepare a technically justified plan and validation contract for a future, separately authorized B7
diagnostic run. This phase performs read-only inspection and probe design only. It does **not**
execute or relaunch `bm_b7_diagnostic.exe`, does **not** build/CMake/Ninja, does **not** create
directories or files, and does **not** edit source/config/environment/mounts/shell startup.

All prior reports and artifacts are preserved unchanged.

## 2. Read-only sources inspected for this plan

- `work/b7_diag_20261011_paired_capture/phase10_report_launch_method.md`
- `work/b7_diag_20261011_paired_capture/phase11_report_identity_storage.md`
- `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` (read-only; specific regions below)
- Filesystem state, inspected read-only:
  - `stark/build-b7diag-20261011/bm_b7_diagnostic.exe` (present; not launched)
  - `stark/build/bm_b7_diagnostic` (exists; empty; inspected read-only)
  - `work/b7_diag_20261011_paired_capture/run2` (exists; contains exec_meta.json, exitcode.txt,
    empty stdout.txt, empty stderr.txt; intended CSV not present)
  - `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv` (not present)

## 3. Part A — Process identity probe design

### 3.1 Goal
Independently confirm that a launched child process is actually running the expected executable image,
by querying the child’s image path from the parent while the child handle is still valid, and saving
the result verbatim.

### 3.2 Candidate launch form used by the probe
Use the launch form already proven to start the process in Phase 10:
- `executable = str(pathlib.Path("stark/build-b7diag-20261011/bm_b7_diagnostic.exe").resolve())`
  → `E:\My Local AI\stark\build-b7diag-20261011\bm_b7_diagnostic.exe`
- `cwd = executable parent directory`
- launch by direct `CreateProcessW` with `app = exe path`, `command line = exe path`,
  `bInheritHandles = True`, and `hStdOutput/hStdError` inherited pipes so stdout/stderr can be
  captured and saved.

This is the form that previously produced `CreateProcessW ok=1 last_error=0` and a child that
printed the diagnostic report before exiting with rc 2. It is reused here as the launch mechanic for
an identity probe, not as a B7 scientific run.

### 3.3 API sequence to retain and query the image path
1. Build inheritable stdout/stderr pipes (SECURITY_ATTRIBUTES with `bInheritHandle = True`).
2. Call `CreateProcessW`:
   - `lpApplicationName` = executable path (quoted if needed)
   - `lpCommandLine` = executable path (quoted)
   - `lpCurrentDirectory` = executable parent (or NULL if a NULL cwd is acceptable)
   - `lpStartupInfo.hStdOutput/hStdError` = write ends of the pipes
   - `bInheritHandles = TRUE`
   - receive `PROCESS_INFORMATION` including `hProcess`, `hThread`, `dwProcessId`.
3. Close the write ends of the pipes in the parent immediately after `CreateProcessW` succeeds
   (so the child sees EOF when it finishes writing).
4. **Important:** do **not** close `hProcess` yet. Keep it open.
5. Optionally wait briefly or poll until the child has produced its initial report header, but keep
   `hProcess` open until after the image query.
6. Query the image path **while `hProcess` is still open**:
   - Preferred first attempt: `QueryFullProcessImageNameW(hProcess, 0, buf, &len)`.
     - Pass a buffer large enough for a full Win32 path. A safe choice is at least
       `MAX_PATH` (260) chars and preferably `32767`/```WCHAR` or larger, because some images can
       exceed `MAX_PATH` unless long-path handling is enabled. Record the actual returned `len`.
     - On failure, record `GetLastError()` and do **not** treat an empty buffer as proof.
     - If `QueryFullProcessImageNameW` returns the empty-string result seen in the Phase 10 probe
       (`ok=0`, `len=1024`, name empty), that result must be treated as **unsuccessful**, not as a
       path. The Phase 10 probe closed the handle after that unsuccessful query, so no usable path was
       preserved. The likely contributing factors (not proven here, only plausible) include using a
       buffer that was too small or interpreting `len` incorrectly, or an OS/access issue with that
       specific handle/pid at that moment. The design below mitigates the obvious buffer/size pitfalls.
   - If `QueryFullProcessImageNameW` does not return a usable path, fall back to a Psapi query:
     - `GetProcessImageFileNameW` or `GetModuleFileNameExW` from `Psapi.dll`, with a buffer sized
       for a full path. Note: a Psapi image path may be returned as a device/path string rather than
       a normalized Win32 path, so the saved artifact should record the raw returned string verbatim
       and the API used.
7. Save the following as persisted evidence:
   - executable path used to launch (`executable`)
   - resolved executable path (`resolved`)
   - executable SHA-256 (computed read-only before launch)
   - `CreateProcessW` return value and `GetLastError()` if it failed
   - child `dwProcessId`
   - wait result (`WaitForSingleObject` or equivalent)
   - `GetExitCodeProcess` result and exit code
   - **image query API used**, raw parameters, raw returned buffer and length, and `GetLastError()`
     if the query failed
   - saved stdout bytes and saved stderr bytes
   - saved text rendering of stdout/stderr for human review

### 3.4 What must be true to claim Part A is satisfied
The probe must capture and persist a non-empty image path string from a successful query **before**
closing `hProcess`, and that string must be compared to the resolved executable path. Only then is
identity supported by kernel evidence rather than by inference from report text.

If the query fails or returns empty/unsatisfactory results, Part A should be reported as **not
independently confirmed**, with the failure details saved. Do not advance a failed query to a claim of
identity.

### 3.5 What this probe does NOT claim
It does not run a scientific B7 measurement. It does not validate calibration, classification, or the
persistent CSV. It only establishes image identity for the launch mechanic.

## 4. Part B — Working directory and storage preflight

### 4.1 Default diagnostic base directory (from source, read-only)
- `kDiagnosticDir` is the relative string `"build/bm_b7_diagnostic"` (`bm_b7_diagnostic.cpp` line 162).
- `DiagnosticPaths::directory` defaults to `kDiagnosticDir` (source line 235).
- `validate_diagnostic_dir()` accepts only that exact directory or a subdirectory of it; it rejects
  absolute paths, leading `/` or `\`, colons, `..`, and anything outside the prefix
  `build/bm_b7_diagnostic/` (source lines 267-282).
- The base directory is created with `ensure_directory()` = `create_directory_exclusive()` (source
  lines 263-282), i.e. exclusive `mkdir`/`_mkdir`.
- The run-owned blob directory is then created as a subdirectory of that base directory, and the blob
  file is created with exclusive `O_CREAT|O_EXCL` (source lines 325-339 and 284-296).

Therefore:
- Paths are **relative** and interpreted relative to the process working directory at launch.
- The diagnostic does **not** create `<exe parent>/build`; it creates `<cwd>/build/bm_b7_diagnostic`.
- If that relative base directory does not exist under the chosen cwd, and the process cannot create
  it, the run aborts with the exact observed text:
  `cannot create diagnostic base directory: build/bm_b7_diagnostic`.

### 4.2 Host-capture (persistent CSV) behavior (from source, read-only)
- `PairedArtifact::write()` writes `paired_samples.csv` under a caller-configured host path
  (`set_host_path()`), not under the default diagnostic directory (source lines 1104-1239).
- If no host path is configured, the artifact is not attempted (source line 1119).
- The final CSV path is `host_path/paired_samples.csv` (or `host_path/paired_samples.csv` when
  `host_path` ends with a separator).
- Path validation rejects absolute paths, leading separators, `..`, and forbidden markers;
  `host_path` itself must therefore be a relative, non-absolute, non-traversal path acceptable to
  `validate_host_capture_path()` (source lines 1134-1159).
- The CSV is created with exclusive `open`/`_open(..., _O_EXCL, ...)`, written through a buffered
  stream, flushed, and committed with `_commit`/`fsync` (source lines 1179-1205).
- The CSV write is guarded by per-replicate validity preconditions: both conditions must have equal
  sizes, and every replicate in both conditions must be valid (source lines 1160-1177).

Therefore:
- The persistent CSV is **not** produced by default. It requires a configured host path and a completed
  run that satisfies the validity preconditions.
- The value in `run2/exec_meta.json` (`"host_csv": "work/b7_diag_20261011_paired_capture/run2/paired_samples.csv"`)
  is the intended destination, but it is only material if the launch configures that host path and the
  run completes.

### 4.3 Candidate launch working directory (read-only inspection)
Inspected read-only:
- `stark/build/bm_b7_diagnostic` exists and is a directory (`os.path.exists` True, `isdir` True,
  `stat` succeeds). It is empty (`listdir()` returns no children). Resolved native path:
  `E:\My Local AI\stark\build\bm_b7_diagnostic`.
- `stark/build-b7diag-20261011` (the exe’s build folder) contains no `build/` entry at all; from a
  launch cwd of that folder, the default relative base directory would resolve to a non-existent
  `stark/build-b7diag-20261011/build/bm_b7_diagnostic`, which is exactly the failure mode seen in
  Phase 10.
- The intended persistent CSV parent `work/b7_diag_20261011_paired_capture/run2` exists and is
  inspectable read-only. No `paired_samples.csv` exists under `work/` or `stark/`.

Candidate launch cwd: **`stark/`**, i.e. `E:\My Local AI\stark`.

Justification:
- From `stark/`, the default relative base directory `build/bm_b7_diagnostic` resolves to
  `stark/build/bm_b7_diagnostic`, which **already exists** and is inspectable read-only.
- This matches the earlier successful runs (run1/run2/run3), which used a cwd where
  `build/bm_b7_diagnostic` was present.
- Using an already-existing base directory does **not** by itself guarantee safety: the diagnostic
  still creates a unique run-owned subdirectory under it with exclusive creation, and it still writes
  the blob file with exclusive creation. Existing pre-owned content would be preserved. But the base
  directory existing removes the specific failure seen in Phase 10.

Caveat:
- Existence of the base directory is necessary but not sufficient. A future run also depends on the
  process being able to create the unique run-owned subdirectory and the blob file, and on the host
  path being configured and writable if the persistent CSV is required.

### 4.4 Isolation consistency
The candidate cwd is consistent with the diagnostic’s isolation rules:
- The diagnostic only operates under `build/bm_b7_diagnostic` (source lines 40-79, 155-244).
- `validate_diagnostic_dir()` enforces that the base directory is exactly `build/bm_b7_diagnostic` or
  a subdirectory of it, with no absolute/drive-letter/`..` escapes.
- The only directory the diagnostic may touch is under that validated base directory; no project or
  historical artifacts are targeted by the diagnostic’s own code.

So `stark/` as cwd is compatible with the diagnostic’s own path rules, provided the relative path
`build/bm_b7_diagnostic` is acceptable and the process can use it.

## 5. Part C — Future-run evidence contract

A separately authorized run must satisfy and preserve the following.

### 5.1 Pre-run checks (read-only before launch)
- Source file `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` present and unchanged from the
  known build-basis record.
- `stark/CMakeLists.txt` present and unchanged from the known build-basis record.
- Executable `stark/build-b7diag-20261011/bm_b7_diagnostic.exe` present.
- Executable SHA-256 computed read-only and equal to
  `a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6`.
- Executable size and basic type consistent with the known artifact (PE32+ console x86-64; size
  3,168,146 bytes).
- Any other build-basis records referenced by the campaign (for example the SHA records in the b7
  diagnostic investigation manifest) checked against the current files.

### 5.2 Launch specification
- Exact native executable path used, recorded verbatim:
  `E:\My Local AI\stark\build-b7diag-20261011\bm_b7_diagnostic.exe`
- Exact resolved path recorded verbatim (should equal the above when resolved through the same helper).
- Exact working directory used, recorded verbatim:
  `E:\My Local AI\stark` (or another explicitly justified cwd, recorded verbatim).
- Launch method recorded verbatim (for example, `subprocess.run(..., shell=False)` with the resolved
  path and the chosen cwd).
- Host-capture path configured, if required, recorded verbatim:
  `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv` relative to the chosen cwd, or an
  explicit relative host path recorded verbatim.

### 5.3 Process identity evidence (captured while child is alive)
- `CreateProcessW` result and `GetLastError()` if it failed.
- Child `dwProcessId`.
- Image-path query API used and parameters.
- Raw returned image-path buffer/length and `GetLastError()` if the query failed.
- Saved image-path string, compared verbatim to the resolved executable path.
- This evidence must be captured and persisted **before** closing the child process handle.

### 5.4 Run output evidence (preserved after exit)
- Saved stdout bytes and saved stderr bytes.
- Saved text rendering of stdout and stderr.
- Exit status recorded verbatim.
- Timing of launch, child start, child exit, and evidence capture recorded where feasible.

### 5.5 Persistent CSV validation (only if the CSV is produced)
- File exists at the configured host-capture path.
- File is a CSV with a header row.
- Exactly 300 data rows, one per (replicate, iteration) pair across both conditions with
  macro_replicates = 6 and measurement_count = 50, as specified by the protocol.
- Each data row contains:
  - `replicate` (unsigned)
  - `iteration` (unsigned)
  - `minimal_sec` (finite numeric)
  - `instrumented_sec` (finite numeric)
  - `signed_overhead_pct` (finite numeric)
- All numeric fields are finite (no NaN/inf) and consistent with the documented formula
  `signed_overhead_pct = 100 * (instrumented_sec - minimal_sec) / minimal_sec`.
- No historical/campaign/production markers appear in the CSV path or contents, consistent with
  `validate_host_capture_path()` and the isolation design.

### 5.6 Calibration and classification (preserved from stdout/report)
- Calibration values recorded as reported:
  - `mean_overhead_pct` (threshold `<= 2.0000 %`)
  - `worst_case_overhead_pct` (threshold `<= 10.0000 %`)
  - `median_deviation_pct` (threshold `<= 2.0000 %`)
- Each threshold check recorded as OK or NOT OK exactly as reported.
- Classification recorded exactly as reported:
  - possible values include `NOT_ELEVATED`, `INSUFFICIENT_REPLICATION`, `INCONCLUSIVE`,
    `REPRODUCIBLE_ELEVATION`, subject to the diagnostic’s classification rules.
- The report’s protocol, condition order, per-replicate medians, and pooled statistics recorded as
  reported.
- Historical comparison reference (if reported) recorded as a datum only, not as a pass/fail claim.

### 5.7 No-change confirmation
- Confirm that no frozen G7CAM evidence, frozen evidence manifests, frozen hashes, acceptance logic,
  thresholds, calibration formulas, or classification rules were altered.
- Confirm that the persistent CSV destination was only written by the diagnostic’s own exclusive
  creation path if it was written at all, and not by any manual edit or copy.

## 6. Confirmed facts

- The diagnostic’s default base directory is the relative string `build/bm_b7_diagnostic`, validated
  to be exactly that or a subdirectory of it, created via exclusive mkdir.
- From `stark/`, that default base directory resolves to `stark/build/bm_b7_diagnostic`, which exists
  and is inspectable read-only (empty).
- From `stark/build-b7diag-20261011`, that default base directory does **not** exist, which is the
  failure mode seen in Phase 10.
- The intended persistent CSV parent `work/b7_diag_20261011_paired_capture/run2` exists and is
  inspectable read-only; no `paired_samples.csv` exists yet.
- The launch mechanic that previously started the process used the resolved native absolute path with
  cwd = exe parent; that is the basis for the Part A probe design.

## 7. Hypotheses (not proven)

- Launching from `stark/` would likely avoid the Phase 10 base-directory failure because the required
  relative base directory already exists there.
- Independent image-path proof is achievable with a probe that retains the child handle and performs a
  properly sized/buffered image query (preferred `QueryFullProcessImageNameW`, fallback Psapi),
  provided the query actually succeeds and is persisted before the handle is closed.
- The persistent CSV will only be produced if a host path is configured and the run completes with valid
  replicates in both conditions.

## 8. Unresolved issues

- It is not yet proven that `QueryFullProcessImageNameW` will return a usable path in this environment
  for this child; the Phase 10 attempt returned empty, and the probe closed the handle without a
  successful fallback.
- It is not yet proven that the process can create the unique run-owned subdirectory and blob file in
  this environment, even from `stark/`.
- It is not yet proven that the intended host-capture path as a relative string would be valid/writable
  when configured as the host path from the chosen cwd; that would require either a successful run or a
  non-creating probe of the path, which is outside this phase’s read-only pickup boundary.

## 9. Minimum proposed next action (do not perform)

Before any authorized run:
1. Implement the Part A identity probe as designed and run it (separately authorized) so the child
   handle is retained and the image path is queried and persisted before close.
2. Preflight the chosen launch cwd (recommended: `stark/`) read-only to confirm the required base
   directory exists and is inspectable, and confirm the intended host-capture parent exists and is
   inspectable.
3. Record the launch specification verbatim.
4. Then, only if separately authorized, run the B7 diagnostic using the proven launch form, the chosen
   cwd, and the configured host-capture path if required, and validate the resulting CSV and stdout
   evidence against the Part C contract.

## 10. Hard boundaries held

- No execution or relaunch of `bm_b7_diagnostic.exe`.
- No build/compile/cmake/ninja.
- No directory or file creation as probes.
- No source/config/environment/mount/shell-startup edits.
- No move/copy/rename/replace of artifacts.
- No change to the persistent CSV destination, G7CAM records, frozen evidence, thresholds, formulas,
  calibration, or M0/M1.
- All prior reports and artifacts preserved without modification.

## 11. Deliverable

- `work/b7_diag_20261011_paired_capture/phase12_report_preflight_design.md` — this report.
