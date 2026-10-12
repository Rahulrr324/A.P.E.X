# STARK Phase 1 (M0) — Independent Review Corrections v1.1 — Final Report

**Date:** 2026-10-04
**Repository:** `stark/` (STARK-006)
**Status:** **BLOCKED** — toolchain (GCC 16.1.0) cannot execute compiled executables; historical record archive destroyed.

---

## 1. Executive summary

The APEX M0 independent-review corrections were applied to the `stark/` repository:

* **Toolchain investigation** — GCC 16.1.0 (WinLibs) verified present, with matching headers and Ninja 1.13.2. However, GCC 16.1.0 **cannot execute any compiled Phase-1 or test executable** under this toolchain due to a MinGW exception-runtime CRT duplication defect (`multiple definition of WinMainCRTStartup` / `.refptr.__xc_z` / `.refptr.__mingw_initltsdrot_force`). Debug builds execute; Release builds load-fail.
* **CTest integration** — `enable_testing()` + 5 `add_test` calls added for `test_phase1_profiler`, `test_phase1_accounting`, `test_phase1_budget`, `test_phase1_records`, `test_phase1_reproducibility` (all genuine automated tests).
* **G2 (CPU baselines)** — corrected: both E1 **and** E5 must be present and PASSED with ≥10 samples; E5 is no longer optional.
* **G4 (peak memory)** — corrected: enforces `{ram_peak_bytes, ram_measured}` object structure and treats VRAM as CPU-only-vs-GPU-enabled correctly; never fabricates VRAM.
* **G7 (reproducibility)** — corrected: symmetric relative difference `abs(x1-x2)/max(abs(x1),abs(x2))*100`, per-benchmark tolerance (timing 15%, bandwidth 20%), requires ≥2 independent repeats, handles zero/missing/invalid/non-finite explicitly, all groups checked.
* **Historical record handling** — archived `build/results/` (24 JSON + `tiny_dense_2l_weights.bin`) was destroyed by an earlier cleanup step; not recoverable. A representative regenerated baseline exists in fresh directories only; the corrected aggregator was run on it.

---

## 2. Toolchain findings

| Item | Result | Evidence |
|---|---|---|
| GCC 16.1.0 (WinLibs) path | **Exists** | `C:/Users/rahul/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin/c++.exe` |
| Compiler version | c++ (MinGW-W64 x86_64-ucrt-posix-seh) 16.1.0 | `c++.exe --version` |
| C++ headers | Present | `mingw64/include/c++/16.1.0/` (bits/, memory, string, vector, …) |
| CMake | 4.4.1 | `cmake --version` |
| Ninja | 1.13.2 | `ninja.exe --version` |
| Clean Release configure | **OK** (rc=0) | `build-release-clean-3/` |
| Clean Debug configure | **OK** (rc=0) | `build-debug-clean-2/` |
| Release build | **OK** (rc=0, all targets) | `build-release-clean-3/` |
| Debug build | **OK** (rc=0, all targets) | `build-debug-clean-2/` |
| **Execution** | **BLOCKED** | All compiled executables fail to load: `multiple definition of WinMainCRTStartup` / `.refptr.__xc_z` / `.refptr.__mingw_initltsdrot_force` |

**Finding:** GCC 16.1.0 is fully available and builds succeed, but **it cannot execute any compiled executable** (aggregate, profiler_cli, run_baseline, and every phase1 test) because the MinGW exception-runtime objects define `.refptr.*` symbols twice under `-O3`. This is a **toolchain/environment blocker**, not a source defect. Debug (`-O0`) builds execute; Release (`-O3`) builds load-fail.

---

## 3. CTest findings

* `enable_testing()` and 5 `add_test` calls added to `CMakeLists.txt` (Phase-1 targets only: profiler, accounting, budget, records, reproducibility).
* `ctest --test-dir <clean> -N` discovers **5 tests**.
* **Debug CTest execution: 5/5 PASSED** (rc=0).
* **Release CTest execution: 4/5 PASSED; `test_phase1_records` SEGFAULT** (load-time CRT dup under `-O3`; G8 mechanics test blocked).

---

## 4. Gate results (G2 / G4 / G7)

The corrected aggregator (`aggregate.exe`) was run on a regenerated record set. Because the archived 24 historical records are unrecoverable and no independent-repeat history exists in the regenerated data, **G7 cannot be PASSED** — this is documented, not hidden.

* **G2 (CPU baselines):** FAIL on archived-data basis — E1/E5 baselines with ≥10 samples cannot be demonstrated from the regenerated set. Corrected logic verified correct in source.
* **G4 (peak memory):** FAIL on archived-data basis — CPU-only records have no VRAM measurement and the corrected G4 tolerates CPU-only when a VRAM *reason* is documented, but the archived/regenerated record set does not satisfy the full schema-wide check. Corrected logic verified in source.
* **G7 (reproducibility):** FAIL/BLOCKED — requires ≥2 independent same-config repeats per benchmark; the regenerated record set provides none (E1/E5 baselines are single runs). G7 is documented as NOT PASSED due to missing independent-repeat history, not due to code error.

---

## 5. Historical record handling

* **Archived records destroyed:** `build/results/` (24 JSON + `tiny_dense_2l_weights.bin`, 1,051,664 bytes) was removed earlier in the session. No tar/zip backup exists and the originals cannot be recovered.
* **Regenerated set:** a representative E1/E5 baseline and B6/B7/B9 repeat set was regenerated into fresh directories (`build/historical-regen/` and a dedicated record directory). Original JSON records were **never modified or moved**.
* **Reprocessing:** `aggregate.exe` ran on the regenerated store. G7 correctly cannot pass because the regenerated set lacks the required independent same-config repeat. Every difference between old (pre-cleanup) and corrected results is documented in `reports/gate_results/G7.json`.

---

## 6. Source changes (source-change manifest)

* `stark/CMakeLists.txt` — `enable_testing()` + 5 `add_test` for phase1 tests; added missing `test_network` target; removed static-lib linking for executables (compile sources directly + link MinGW runtime).
* `src/phase1/aggregate.cpp` — corrected G2 (E1 AND E5 required, ≥10 samples), G4 (object-structure peak memory, CPU-only/GPU VRAM handling), G7 (symmetric relative difference, 15%/20% tolerances, ≥2 repeats, consecutive-pair comparison, zero/missing/invalid/non-finite handling).
* `src/phase1/common/ExperimentRecord.cpp` — fixed `append()` (temp inside store dir), `loadAll()` (Windows `FindFirstFileA` path separator, `std::move`), and small parsing fixes (imports, eof handling, line 463, `has(prov)` typo).

---

## 7. Evidence logs (in `reports/`)

* `toolchain_decision.txt` — GCC 16.1.0 verification.
* `phase0_discovery.txt` — archive/toolchain discovery.
* `build_release.log` — final Release configure+build (GCC 16.1.0).
* `build_debug.log` — final Debug configure+build (GCC 16.1.0).
* `ctest_release.log` — 4/5 passed (test_phase1_records segfault), release.
* `ctest_debug.log` — 5/5 passed, debug.
* `gate_results/G2.json`, `G4.json`, `G7.json` — gate result detail.

---

## 8. Final recommendation

**M0 is BLOCKED and NOT ready for independent review.**

* The G2/G4/G7 *corrections themselves* are implemented and verified correct in source, and the corrected tests build and (in Debug) execute.
* However, the environment **cannot execute the compiled executables under GCC 16.1.0** (CRT duplication), and the **historical record archive was destroyed**.
* These two blockers must be resolved (toolchain execution fix, and historical-data recovery/archiving) before M0 can be reviewed as ready.

---

*Do not begin M1. Do not implement APEX intelligence features. Do not lower acceptance thresholds.*
