# Phase 15: B7 diagnostic toolchain and build (BLOCKED, run not launched)

Repo: `E:\My Local AI`. HEAD `a53fd83` (commit made by another actor after Phase 14; not by this task). Nothing was staged, committed, pushed, or cleaned.

## 1. Source-diff audit
File: `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp`
- Current SHA-256: `aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b` (unchanged from Phase 14).
- The fix is already in `HEAD` (`a53fd83`), so `git status` no longer shows it as modified.
- Parser: optional `--host-capture-dir <relative-dir>` alongside a single positional directory. It rejects missing value, value starting with `--`, duplicates, unknown `--` options, a second positional, and paths failing `validate_host_capture_path()`. Each rejection returns exit 2. No-argument and single-positional forms are unchanged.
- Propagation: `DiagnosticPaths.host_capture_dir` -> `paired.set_host_path()` on the `PairedArtifact` constructed in `run_bm_b7_diagnostic()`.
- Not changed: calibration formulas, thresholds, frozen evidence.
- Caveat: the diff was audited by reading it. No compile has been performed on this source yet, so the audit is not a build.

## 2. Toolchain discovery (read-only)
- `vswhere`: one instance, **Visual Studio Build Tools 2019 16.11.58** at `C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools`.
- MSVC toolset: `14.29.30133`. `cl.exe` present at `VC\Tools\MSVC\14.29.30133\bin\Hostx64\x64\cl.exe`. C++17 capable.
- `vcvars64.bat` exists and runs (`vcvarsall.bat` reported `Environment initialized for: 'x64'`).
- Bundled CMake: `cmake version 3.20.21032501-MSVC_2` at `...\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe`.
- Bundled Ninja: `1.10.2` at `...\CMake\Ninja\ninja.exe`.
- Existing cache `stark/build-b7diag-20261011/CMakeCache.txt`: generator Ninja, CMake 4.4, compiler `...WinGet\...WinLibs...\mingw64\bin\g++.exe` (**missing**). The cached `cmake.exe` is also in that missing WinLibs directory.
- Not found on PATH: `cmake`, `cl`. No `C:\Program Files\CMake`. No LLVM.

## 3. Build attempts (all failed; none replaced the existing executable)
Logs in `work/b7_diag_20261011_paired_capture/phase15_msvc/`.
1. `cmake -G Ninja ... --target bm_b7_diagnostic`: rejected, `--target` is not a configure option. (Mistake, corrected.)
2. Configure with `-DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl` after `vcvars64`: compiler-ID probe fails with `The system cannot find the file specified` (`CMakeError.log`).
3. Configure with full `cl.exe` path via `-D`: `The system cannot find the path specified`, then CMake syntax error in generated `CMakeCXXCompiler.cmake`.
4. Configure with `-DCMAKE_TOOLCHAIN_FILE=...toolchain_msvc14_29.cmake`: same syntax error.

Root cause not yet isolated. The compiler-ID probe cannot spawn `cl` from this bash-driven `cmd` invocation. Likely a quoting or PATH issue in how `cmd.exe` launches the sub-process. No build was produced.

Side effect: attempt 3 created and then re-created `stark/build-b7diag-msvc-20261014/` (a new directory from this task). It holds only CMake failure state and no executable.

## 4. Not done
- No build of `bm_b7_diagnostic` from the edited source.
- No CLI tests.
- No preflight, no diagnostic run, no CSV. Verdict: **INCONCLUSIVE (not run)**.
- Frozen-evidence and historical-CSV integrity checks were not re-run in this phase. Last known hashes: `a2e9e0ada6...` (existing exe), `575fe26492...` (CMakeLists.txt), source `aeb31eb2...`.

## 5. Next action
Get a working `cl`-driven configure. The cleanest option is to run CMake from inside a PowerShell or `.bat`-driven session that has `vcvars64` applied, with no bash quoting in between, and let CMake find `cl` by name. Then build `bm_b7_diagnostic`, run the CLI tests, and request separate authorization for the single preflighted run.
