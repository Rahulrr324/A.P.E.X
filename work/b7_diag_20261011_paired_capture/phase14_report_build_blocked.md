# B7 paired diagnostic: build blocked, run not launched

Repo: `E:\My Local AI`, HEAD `66d8c1c`. No commit, stage, push, or cleanup performed.

## 1. Source change (applied, not built)
File: `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` (52 insertions, 7 deletions).
- `DiagnosticPaths` gains `host_capture_dir` (empty = legacy behaviour).
- `run_bm_b7_diagnostic()` calls `paired.set_host_path(...)` on the `PairedArtifact` it constructs, when the option is set.
- `main()` accepts optional `--host-capture-dir <relative-dir>` alongside the single positional diagnostic directory. It rejects a missing value, a value starting with `--`, duplicates, unknown `--` options, a second positional argument, and any path that fails `validate_host_capture_path()`. Each rejection returns exit 2.
- No-argument and single-positional invocations are unchanged.

Hashes:
- Source after edit: `aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b`
- Source baseline (pre-edit, from earlier session): `5ff3a4...` (not re-verified this session)
- `stark/CMakeLists.txt`: `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8` (unchanged)
- Existing executable `stark/build-b7diag-20261011/bm_b7_diagnostic.exe`: `a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6` (preserved; not replaced)

## 2. Build: BLOCKED
- The isolated build directory is configured for `C:/Users/rahul/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_.../mingw64/bin/g++.exe`. That file does not exist on this machine.
- The only g++ on PATH is `/c/MinGW/bin/g++` (MinGW.org GCC 6.3.0). It fails on `src/phase1/common/ExperimentRecord.h:22`: `fatal error: optional: No such file or directory`. The project requires C++17 (`<optional>`, GCC 7+).
- Searched and not found: `/c/Program Files/Git/mingw64`, `/mingw64`, `/c/msys64/{ucrt64,mingw64}`, `/c/Program Files/LLVM`, Visual Studio 2022 MSVC, chocolatey `g++`, and `/c/Program Files/CMake`. `cmake` is not installed; ninja exists at `/c/Users/rahul/AppData/Roaming/Python/Python314/Scripts/ninja`.
- Evidence: `stark/build-b7diag-20261011/candidate/build_stderr.txt`.
- No build was run in the isolated directory with the new source, so the executable's provenance is not established.

## 3. Preflight and run: NOT REACHED
- Preflight is not satisfied because the new executable does not exist.
- The diagnostic was not launched. No `paired_samples.csv` was created. `work/b7_diag_20261011_paired_capture/run2/` still holds only the earlier `exec_meta.json`, `exitcode.txt`, `stdout.txt`, `stderr.txt`.
- No CSV validation or calibration recompute was performed. Verdict: **INCONCLUSIVE (not run)**.

## 4. Repository state
`git status --short` (relevant lines): `M stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` (this task). Pre-existing/unrelated untracked: `stark/build-b7diag-20261011/candidate/`, `stark/build-b7diag-20261011/preedit/`, `stark/nul`, `work/_b7_apply_host_capture_fix.py` (created by this task's edit script; safe to delete in cleanup).

## 5. Next step
Install a C++17-capable g++ (GCC 7+ or WinLibs UCRT matching the cache) or regenerate the isolated build directory against an available compiler. Then build `bm_b7_diagnostic` there, run the argument-parser checks, and request separate authorization for the single preflighted run.
