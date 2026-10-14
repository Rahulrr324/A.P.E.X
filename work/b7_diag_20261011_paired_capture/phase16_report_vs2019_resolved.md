# Phase 16 — B7 Diagnostic: Toolchain Root Cause Resolved, Build Completed, Single Run Executed

**status:** COMPLETE. Build unblocked, CLI contract verified, preflight passed, one authorized run
executed, CSV produced and independently validated.
**date_utc:** 2026-10-14
**repo:** `E:\My Local AI` — branch `main`, HEAD `1b7616f` ("failed"), parent `a53fd83`.
**source fix preserved:** `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp`,
sha256 `aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b` (committed in `a53fd83`).

Nothing was staged, committed, pushed, reset, amended, or cleaned. No frozen evidence was modified.
The fresh push remains deferred to the agreed final cleanup phase.

---

## 1. Diagnosed cause of the earlier build failures

### 1.1 What was actually wrong

The toolchain was **never** the problem. Every failed attempt traces to the *driver commands*, not to
MSVC, CMake, or Ninja. Two independent defects:

**Defect 1 — POSIX redirection syntax inside `cmd.exe` scripts (primary).**

`work/_b7_msvc_configure.cmd` (added in `1b7616f`) began with:

```bat
call "C:\Program Files (x86)\...\vcvars64.bat" >/dev/null 2>&1
...
rmdir /s /q "...\build-b7diag-msvc-20261014" 2>/dev/null
```

`>/dev/null` and `2>/dev/null` are POSIX syntax. `cmd.exe` parses `>/dev/null` as *redirect stdout to the
file* `\dev\null` on the current drive. That directory does not exist, so the redirection cannot be
established and **cmd aborts the entire command line**. The consequence is that `vcvars64.bat` never ran.

Evidence — the first line of both failure logs is the redirection error, not a compiler error:

```
work/b7_diag_20261011_paired_capture/phase15_msvc/configure3_out.txt
  line 1:  The system cannot find the path specified.
  then  :  -- The CXX compiler identification is unknown
           The CMAKE_CXX_COMPILER:  cl  is not a full path and was not found in the PATH.
```

Because `vcvars64.bat` never ran, MSVC's `bin`, `INCLUDE`, and `LIB` were never added to the child
environment, so CMake's compiler-ID probe could not resolve `cl`. The reported symptom — *"`cl` is not a
full path and was not found in the PATH"* — is therefore an **environment-inheritance artifact of a broken
batch script**, not a missing or malformed compiler.

**Defect 2 — a backslash Windows path interpolated unquoted into a CMake string.**

Attempt 2 passed the compiler as `-DCMAKE_CXX_COMPILER="%CL%"`, which wrote the raw backslash path into the
generated cache file:

```
work/b7_diag_20261011_paired_capture/phase15_msvc/configure2_stderr.txt
  CMakeCXXCompiler.cmake:1 (set):
    C:\Program Files (x86)\...\cl.exe
    Invalid character escape '\P'.
```

and `work/.../phase15_msvc/toolchain_msvc14_29.cmake` contains `set(CMAKE_MAKE_PROGRAM ".../Ninja/ninja.exe")`.
So attempt 2/3/4 failures were a **CMake-string quoting/escaping defect**, again in the driver layer.

### 1.2 What was ruled out with evidence

- **MSVC toolset present and C++17-capable:** `14.29.30133` at
  `...\BuildTools\VC\Tools\MSVC\14.29.30133\bin\Hostx64\x64\cl.exe`.
- **Windows SDK present:** `C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0`.
- **CMake present:** `cmake version 3.20.21032501-MSVC_2` (VS-bundled).
- **Ninja present:** `1.10.2` (VS-bundled).
- **A separate, real environmental loss (contributing context, not the cause):** the toolchain that built
  the project originally is *gone*. `work/b7_diag_20261011/MANIFEST.txt` records
  `g++ 16.2.0` from the WinLibs WinGet package, and
  `stark/build-b7diag-20261011/CMakeCache.txt` points at
  `...\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_...\mingw64\bin\g++.exe`.
  That directory **no longer exists**, yet its path is *still present on `PATH`* — a stale `PATH` entry
  advertising a deleted directory. The remaining `PATH` compiler is `C:\MinGW\bin\g++.exe`
  (**MinGW.org GCC 6.3.0**, 2017), which is not a viable C++17 compiler. So MSVC was the correct
  (and only) available choice.
- **Not a path-quoting problem in a shell:** the VS generator reaches MSBuild and `cl` correctly with no
  `vcvars` at all (below), which excludes shell quoting as the root cause.
- **Not a "CMake can't find the compiler" problem:** CMake found it immediately once not sabotaged.

### 1.3 The fix that worked

The **native Visual Studio generator**, invoked directly from bash — no `cmd.exe`, no `vcvars64.bat`, no
compiler path on the command line. CMake discovers the MSVC toolset itself via the VS instance registry, so
neither defect 1 nor defect 2 can occur.

Additionally, one **later, distinct** failure had to be fixed — and it was mine, not the project's:
passing `-DCMAKE_CXX_FLAGS=/DNOMINMAX` from Git Bash. MSYS path conversion rewrote the bare `/DNOMINMAX`
into a Windows path, which `cl` then treated as a source file:

```
cl /c ... /D "CMAKE_INTDIR=\"Debug\"" C:/Program Files/Git/DNOMINMAX testCXXCompiler.cxx
c1xx : fatal error C1083: Cannot open source file: 'C:/Program'
```

Fixed with `-DNOMINMAX` (leading `-`) plus `MSYS2_ARG_CONV_EXCL='*'`. This is recorded because it is a real
trap for anyone re-running this build from Git Bash.

---

## 2. Build (successful)

New, separately named, isolated build directory — the original `stark/build-b7diag-20261011/` was **not**
reused, deleted, or modified.

| item | value |
|---|---|
| build dir | `stark/build-b7diag-vs2019b/` |
| generator | `Visual Studio 16 2019` (`-A x64`) |
| CMake | `3.20.21032501-MSVC_2` |
| compiler | MSVC `19.29.30159.0` (toolset `14.29.30133`) |
| MSBuild | `16.11.6+a918ceb31` |
| Windows SDK | `10.0.19041.0` |
| build type | `Release` |
| target | `bm_b7_diagnostic` |
| compile flags | `-DNOMINMAX /EHsc` (configure-time only; **no file was edited**) |
| configure exit | `0` |
| build exit | `0` |
| warnings | 2, both benign: `LNK4044: unrecognized option '/static-libgcc'` and `'/static-libstdc++'` — GCC runtime flags from `CMakeLists.txt` that `link.exe` ignores |
| artifact | `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe` |
| artifact size | 114176 bytes |
| artifact sha256 | `86ee9f3ee2c1daac8f2815be4516e2ea03fd19273166978cbf09e6d69ca09d88` |

Two compile-flag decisions, both required for MSVC and applied **without touching the repository**:

- **`-DNOMINMAX`** — `ExperimentRecord.cpp` includes `<windows.h>` and uses
  `std::numeric_limits<int64_t>::max()` and `std::min(...)`. Windows' `min`/`max` macros break these. This is
  the pre-existing MSVC incompatibility noted in `phase15_report_toolchain_blocked.md`.
- **`/EHsc`** — the first build emitted `warning C4530: C++ exception handler used, but unwind semantics are
  not enabled` in all four translation units. These TUs throw (`ExperimentRecord.cpp` throws
  `std::runtime_error`), so proper unwind semantics matter for a measurement binary. After adding `/EHsc`
  the rebuild was clean: **no C4530**, no errors, only the two benign link warnings.

The resulting executable is built from the **current edited source**, established by three independent
checks rather than assumed:

1. **Compiled-in parser string.** The literal `--host-capture-dir` occurs **7 times in the new binary and
   0 times in the old one** — the new option is genuinely compiled in.
2. **Behavioural differentiator.** Given the identical argv, the old binary
   (`stark/build-b7diag-20261011/bm_b7_diagnostic.exe`) prints its *old* usage
   (`… [diagnostic-directory]`) and exits 2 without accepting the flag, whereas the new binary accepts it.
   Evidence: `phase16_vs2019/old_binary_differentiator.txt`.
3. **Kernel identity.** `QueryFullProcessImageNameW` proves the process that produced the CSV was the new
   binary at the new path (§5).

The old executable was therefore **not** used to claim the source fix is tested, as required.

Configure/build logs: `work/b7_diag_20261011_paired_capture/phase16_vs2019/`
(`configure_vs2019b_stdout.txt`, `build_vs2019c_stdout.txt`, `*_rc.txt`).

---

## 3. CLI test results

Harness: `phase16_vs2019/cli_tests.sh` → `cli_tests_report.txt`. **18/18 cases behaved exactly as
designed.** Every case is a rejection path; **no case executed a diagnostic run**. The backward-compatible
positional forms are exercised through the isolation guard, which aborts *before* any storage creation.

| case | invocation | exit | message |
|---|---|---|---|
| A1 | `--host-capture-dir` (no value) | 2 | `--host-capture-dir requires a value` |
| A2 | `--host-capture-dir --other` | 2 | `requires a non-option value` |
| A3 | `--host-capture-dir ""` | 2 | `requires a non-option value` |
| A4 | duplicate `--host-capture-dir` | 2 | `duplicate --host-capture-dir` |
| A5 | `C:hostcaps` | 2 | `absolute paths are not allowed (drive letters / schemes)` |
| A6 | `/hostcaps` | 2 | `absolute paths are not allowed` |
| A7 | `../hostcaps` | 2 | `'..' path traversal is not allowed` |
| A8 | `a/../b` | 2 | `'..' path traversal is not allowed` |
| A9 | `reports/x` | 2 | `forbidden marker 'reports'` |
| A10 | `records/x` | 2 | `forbidden marker 'records'` |
| A11 | `g7-campaign/x` | 2 | `forbidden marker 'g7-campaign'` |
| A12 | `x.jsonl` | 2 | `forbidden marker '.jsonl'` |
| A13 | `evidence_manifest` | 2 | `forbidden marker 'evidence_manifest'` |
| B1 | `--bogus` | 2 | `unknown option: --bogus` |
| B2 | `dir_one dir_two` | 2 | `more than one diagnostic-directory argument` |
| B3 | `--host-capture-dir --host-capture-dir` | 2 | `requires a non-option value` |
| C1 | `not_the_diagnostic_dir` | 2 | positional **accepted**; aborts at isolation check |
| C2 | `not_the_diagnostic_dir --host-capture-dir work/…/run2` | 2 | both **accepted**; aborts at isolation check |

**Invalid arguments cannot launch the diagnostic or create artifacts.** A `find | sha256sum` snapshot of
`build/bm_b7_diagnostic/` and `work/…/run2/` taken before and after all 18 invocations is **byte-identical**
(`snapshot_before.txt` vs `snapshot_after.txt`, `diff` empty). C2's stderr is empty, proving the approved host
path passes `validate_host_capture_path` rather than being rejected.

Honest limit: the *no-argument* default form cannot be tested without actually running the diagnostic
(the default diagnostic directory is valid, so it proceeds to a full run). It is therefore verified by
source inspection — `host_capture_dir` defaults to empty ⇒ *"paired artifact not written: no host path
configured"* ⇒ backward compatible — plus the fact that the authorized run in §5 exercises the default
diagnostic directory `build/bm_b7_diagnostic`.

### 3.1 Old-vs-new binary differentiator (new binary really contains the fix)

Identical argv, both binaries:

| binary | `--host-capture-dir` found in image | exit | first stderr line |
|---|---|---|---|
| old `stark/build-b7diag-20261011/…exe` | 0 occurrences | 2 | `usage: …bm_b7_diagnostic.exe [diagnostic-directory]` (old usage; flag unsupported) |
| new `stark/build-b7diag-vs2019b/Release/…exe` | 7 occurrences | 2 | *(empty)* — flag accepted; aborts only on the deliberately invalid directory |

Running the old binary produced **no** filesystem change: a snapshot pair spanning only that invocation
(`cli/snapshot_after_old.txt` vs `cli/snapshot_pre_old.txt`) is identical. Note that
`cli/snapshot_after.txt` (taken before the authorized run) differs from `cli/snapshot_after_old.txt` by
exactly one added line — the new `run2/paired_samples.csv` created by the authorized run in between — and
nothing else; the historical CSV hash is unchanged in both.

---

## 4. Mandatory preflight (all hard checks passed)

Re-run from disk in this phase; **not** copied from older reports.

**Historical CSV — preserved, hash intact.** The old paired CSV is `git`-tracked and is the recorded
reference artifact:

```
build/bm_b7_diagnostic/run_1791799501127597800_0/paired_samples.csv
  sha256 d0fca204c9443ef2d0113c12884dfc0fbfc1d64f08c3903f89c98c0c4bf5163a   -> MATCH (before and after the run)
  13358 bytes, header + 300 data rows, replicates 0..5 x iterations 0..49
```

**Frozen G7 / M0 / M1 evidence — every baseline verified OK:**

| baseline set | items | result |
|---|---|---|
| `hashes_frozen_before.txt` (gates, BenchmarkHarness, TinyDenseModel, ExperimentRecord, G7Campaign, aggregate, source_change_manifest) | 10 | ALL OK |
| `hashes_evidence_before.txt` (evidence manifests + records_sha256) | 7 | ALL OK |
| `hashes_g7cam_before.txt` | 30 | ALL OK |
| `hashes_g7cam_frozen20261008_before.txt` | 35 | ALL OK |
| `hashes_prodbin_before.txt` (aggregate/profiler_cli/run_baseline exes) | 3 | ALL OK |
| explicit M0/M1 files (`m0_acceptance_matrix.json`, `M0_FINAL_REPORT_v2.3.md`, `historical_artifact_inventory.json`, `G7_FROZEN_CAMPAIGN_RESULT.md`, `gate_results/G7.json`, `gate_results/G4.json`) | 6 | ALL MATCH |

**One apparent mismatch, resolved as a transcription error in an older report — not a change.**
`work/_task_b7_phase1_report.md` lists `stark/reports/evidence_manifest.json` as
sha `7a8dd9de17c4effdc9153ac4505a6f6f95ed662ef204cab52ad279c4bf01fc5a`. That value is in fact the hash of
`stark/reports/g7-campaign/evidence_manifest.json`. The top-level file's real hash is
`14975fa285362d4bb6f92f08840841de6edfad88b29dfd101107075731d473d3`, which matches **both** the Oct-11
`hashes_evidence_before.txt` **and** `hashes_evidence_after.txt`, and the file is byte-identical to its
committed `HEAD` blob (`git hash-object` == `HEAD:…` == `3d16059ea25613e67f74ca5f300f148c49cff949`; size
10822 bytes, matching the report's stated size). Verified intact; the report's quoted hash was mislabelled.

**Expected, legitimate differences from the Oct-11 pre-fix baseline** (`work/b7_diag_20261011/hashes_before.txt`):
`stark/CMakeLists.txt` (`532bc249…` → `575fe264…`) and `bm_b7_diagnostic.cpp` (`cf3c1e54…` → `aeb31eb2…`).
Both are the intended, already-committed fixes. `hashes_artifact.txt` (`978d0400…`) is likewise a superseded
pre-fix record of the old MinGW executable; the authoritative expected old-exe hash is `a2e9e0ad…`
(`phase13_report_one_shot.md`), which matches that file today. Neither is frozen G7/M0/M1 evidence.

**Run preconditions:** approved host dir exists; the destination
`work/b7_diag_20261011_paired_capture/run2/paired_samples.csv` was **absent** before the run;
`build/bm_b7_diagnostic/` exists (1 pre-existing run dir, preserved); build basis confirmed
(`CMakeLists.txt 575fe264…`, source `aeb31eb2…`).

Logs: `phase16_vs2019/preflight_hashes.txt`, `preflight_frozen.txt`, `final_state.txt`.

---

## 5. The single authorized run

Executed **exactly once**; no retry, no automatic relaunch.

| item | value |
|---|---|
| cwd | `E:\My Local AI` (approved) |
| executable | `stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe` |
| argv | `build/bm_b7_diagnostic --host-capture-dir work/b7_diag_20261011_paired_capture/run2` |
| launcher | `phase16_vs2019/run_once.py` (`subprocess.Popen`, `shell=False`) |
| start / end | 2026-10-14T20:10:33 → 20:10:45 local |
| elapsed | 11.169 s |
| **exit code** | **0** (run completed with sufficient replication) |
| stdout | 4695 bytes, sha `33f7b52f74b948d8a9e54794b3419b9d11ecb6bac66d85eeb1b18c6186d419d6` |
| stderr | 0 bytes (empty) |
| child pid | 22956 |

**Process-identity proof (kernel API, taken while the child was alive).** This closes the gap left open in
`phase10_report_launch_method.md` §6 and `phase12_report_preflight_design.md` §3:

```
api                     : QueryFullProcessImageNameW
ok                      : True      last_error: 0
image_path_raw          : E:\My Local AI\stark\build-b7diag-vs2019b\Release\bm_b7_diagnostic.exe
image_path_matches_exe  : True
```

The child image is proven by the kernel to be exactly the newly built binary — not a stale one.

**The valid host path reached the real `PairedArtifact` writer.** The CSV was created at the configured
destination:

```
work/b7_diag_20261011_paired_capture/run2/paired_samples.csv
  12766 bytes   sha256 818bf1a541b8115f2393a3da2b912eb3757b7f187199d5e9b60beca4e167998f
```

**Cleanup behaved as designed.** The diagnostic reported
*"run-owned blob removed (created by this invocation); run dir removed (empty…)"*. `build/bm_b7_diagnostic/`
still contains exactly one directory — the pre-existing `run_1791799501127597800_0/` with its untouched CSV.
No run-owned residue was left behind, and the historical CSV hash re-verified as `MATCH` after the run.

Evidence: `phase16_vs2019/run_expected/{stdout.txt,stderr.txt,exitcode.txt,exec_meta.json}`.

---

## 6. CSV validation and result

Independent validator: `phase16_vs2019/validate_csv.py` (recomputes every metric from the CSV bytes,
reimplemented from `bm_b7_diagnostic.cpp` `calibrate()`). Output: `csv_validation.json`,
`csv_validation_report.txt`.

### 6.1 Structural integrity — 27 / 27 checks PASS

- Header exactly `replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct`.
- **Exactly 300 data rows** (301 lines including header).
- Pair keys: **300 unique**, exactly `{0..5} x {0..49}`, 50 rows per replicate, none missing, none extra.
- All values finite; all `minimal_sec` / `instrumented_sec` strictly positive.
- Per-row formula `signed_overhead_pct = 100*(instrumented-minimal)/minimal`: **0 violations** over 300 rows.
- Recomputed pooled values reproduce the report exactly:
  mean overhead `8.550597` vs reported `8.5506`; worst signed overhead `109.088219` vs `109.0882`;
  median deviation `2.116052` vs `2.1161`; pooled medians `15469.85 / 15797.20` us and pooled means
  `14761.781 / 16024.001` us all match.
- Per-replicate medians recomputed from the CSV match the report for all 6 replicates in both conditions.
- No forbidden marker in the CSV path or contents.

### 6.2 Calibration against the **frozen, unchanged** thresholds

| metric | measured | threshold | check |
|---|---|---|---|
| `mean_overhead_pct` | **8.5506 %** | ≤ 2.0000 % | **NOT OK** |
| `worst_case_overhead_pct` (max signed paired) | **109.0882 %** | ≤ 10.0000 % | **NOT OK** |
| `median_deviation_pct` | **2.1161 %** | ≤ 2.0000 % | **NOT OK** |

No formula or threshold was altered.

### 6.3 Reported context (recorded verbatim, not altered)

- `status: FAIL — instrumentation overhead exceeds threshold(s): mean worst-case median-deviation`
- `classification: INCONCLUSIVE`
- MINIMAL pooled: n=300, median `15469.850` us, mean `14761.781` us, cv `15.12 %`
- INSTRUMENTED pooled: n=300, median `15797.200` us, mean `16024.001` us, cv `15.82 %`
- Component decomposition (INSTRUMENTED): open ~264 us, read ~15180 us, deserialize ~139 us,
  residual ~177 us median — all positive, none hidden.
- Historical comparison datum (not a verdict): `5721.90 us` (frozen record `G7CAM-B7-E5-11933807`),
  re-verified intact.

### 6.4 Verdict

## **FAIL**

**Not** INCONCLUSIVE. The measurement itself is sound and complete (exit 0, 6/6 valid replicates in both
conditions, all 300 pairs structurally valid), and it **definitively exceeds all three frozen calibration
thresholds**. The paired-samples-CSV deliverable now exists for the first time; the diagnostic's own
verdict on that data is a genuine FAIL on instrumentation overhead, not a missing-data outcome.

Note the notable behavior: median deviation (2.1161 %) is only marginally over its 2 % threshold, while
`worst_case_overhead_pct` is 109.09 %. That is the maximum *signed* paired overhead over aligned
(replicate, iteration) pairs, unclamped by design — an outlier-dominated statistic, consistent with the
much tighter pooled medians. The thresholds were not designed to be forgiving of single-iteration outliers,
and they were not adjusted.

---

## 7. Final Git status

Branch `main`, HEAD `1b7616f`, working tree **unchanged by this phase except for new untracked artifacts**.
Nothing staged, committed, pushed, or cleaned.

```
 M stark/build-b7diag-20261011/CMakeCache.txt     <- pre-existing at the start of this turn; NOT touched by this phase
?? stark/build-b7diag-msvc-vs2019/                <- prior failed attempt (preserved)
?? stark/build-b7diag-nomax/                      <- prior failed attempt (preserved)
?? stark/build-b7diag-vs2019b/                    <- this phase's successful isolated build
?? stark/nul                                      <- prior artifact (preserved)
?? stark/work/_b7_cmake_*.bat, _b7_cmake_vs2019_log.txt, work_b7_cmake_vs2019*.bat  <- prior attempts (preserved)
?? work/b7_diag_20261011_paired_capture/phase15_msvc/toolchain_msvc_nomax.cmake
?? work/b7_diag_20261011_paired_capture/phase16_vs2019/           <- this phase's evidence
?? work/b7_diag_20261011_paired_capture/run2/paired_samples.csv   <- THE DELIVERABLE
```

No tracked file was modified. No frozen evidence was touched. The commit `a53fd83` source fix is preserved
unamended; `1b7616f` is untouched.

---

## 8. Artifacts produced in this phase

| path | purpose |
|---|---|
| `phase16_vs2019/configure_vs2019b_stdout.txt`, `configure_vs2019b_rc.txt` | successful VS-generator configure |
| `phase16_vs2019/build_vs2019c_stdout.txt`, `build_vs2019c_rc.txt` | successful Release build |
| `phase16_vs2019/cli_tests.sh`, `cli_tests_report.txt`, `cli/` | 18-case CLI contract + before/after artifact snapshots |
| `phase16_vs2019/preflight_hashes.txt`, `preflight_frozen.txt`, `final_state.txt` | frozen-evidence and precondition verification |
| `phase16_vs2019/old_binary_differentiator.txt` | old-vs-new binary proof that the fix is compiled in |
| `phase16_vs2019/run_once.py` | single-run launcher with kernel image-identity capture |
| `phase16_vs2019/run_expected/{stdout.txt,stderr.txt,exitcode.txt,exec_meta.json}` | run evidence |
| `phase16_vs2019/validate_csv.py`, `csv_validation.json`, `csv_validation_report.txt` | independent CSV validation |
| `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv` | **the deliverable** (12766 bytes, sha `818bf1a5…`) |

---

## 9. Honest limitations

- The no-argument default CLI form was verified by source inspection and by the authorized run's use of the
  default diagnostic directory, not by a dedicated invocation (§3) — a dedicated invocation would itself
  have launched a run, and the brief authorized exactly one.
- `bm_b7_diagnostic` was built with MSVC 19.29, whereas all frozen historical G7CAM records were produced
  with GCC 16.x (`"compiler": "GCC 16.1.0"`). Absolute timings are therefore **not** comparable to the
  frozen campaign; the diagnostic itself states no cache-state or CPU-affinity equivalence is claimed. This
  affects interpretation of the 8.55 %/109.09 % magnitudes, not the threshold comparison, which uses this
  run's own paired minimal-vs-instrumented data.
- The `worst_case_overhead_pct` of 109.09 % is driven by paired outliers; the exact contributing
  (replicate, iteration) coordinates are recorded in the CSV and in `csv_validation.json` but were not
  forensically attributed to a specific component timer.
- `1b7616f` ("failed") remains in history above the preserved source fix `a53fd83`. Rewriting it was
  explicitly out of scope for this phase.
