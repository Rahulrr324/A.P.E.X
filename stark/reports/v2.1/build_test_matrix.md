# APEX M0 v2.1 — Build, Test and Aggregator Matrix

**Date:** 2026-10-05
**Source change in v2.1:** yes (G4 physical-capability classification + precise G3 skip reason). Fresh Debug and Release builds were therefore made from scratch.

---

## 1. Toolchain (unchanged)

| Item | Value |
|---|---|
| Compiler | `g++.exe (MinGW-W64 x86_64-ucrt-posix-seh, built by Brecht Sanders, r4) 16.1.0` |
| C++ standard | 17 (required, extensions off) |
| CMake | 4.4.1 |
| Ninja | 1.13.2 |
| Generator | Ninja |

Compiler path: `C:/Users/rahul/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin/g++.exe`

---

## 2. Fresh builds (from scratch)

Directories created fresh with `rm -rf` then configured:

```
rm -rf build-v21-debug build-v21-release
cmake -S . -B build-v21-debug   -G Ninja -DCMAKE_BUILD_TYPE=Debug   -DCMAKE_CXX_COMPILER=<winlibs g++>
cmake -S . -B build-v21-release -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=<winlibs g++>
cmake --build build-v21-debug
cmake --build build-v21-release
```

| Build dir | Configure exit | Build exit | Targets | Compile errors |
|---|---|---|---|---|
| `build-v21-debug` | 0 | 0 | 103/103 | 0 |
| `build-v21-release` | 0 | 0 | 103/103 | 0 |

Logs: `build-v21-debug.configure.log`, `build-v21-debug.build.log`, `build-v21-release.configure.log`, `build-v21-release.build.log` (in `stark/`). No generated CMake/Ninja file was hand-edited.

---

## 3. CTest — the six Phase-1 suites

```
cd build-v21-debug   && ctest --output-on-failure
cd build-v21-release && ctest --output-on-failure
```

| | Debug | Release |
|---|---|---|
| tests run | 6 | 6 |
| passed | 6/6 | 6/6 |
| exit code | 0 | 0 |

Suites: `test_phase1_profiler`, `test_phase1_accounting`, `test_phase1_budget`, `test_phase1_records`, `test_phase1_reproducibility`, `test_phase1_gates`.

### Exact assertion counts

| Suite | Debug | Release |
|---|---|---|
| test_phase1_profiler | 35 | 35 |
| test_phase1_accounting | 67 | 67 |
| test_phase1_budget | 55 | 55 |
| test_phase1_records | 54 | 54 |
| test_phase1_reproducibility | 37 | 37 |
| **test_phase1_gates** | **340** | **340** |
| failures (all suites) | 0 | 0 |

`test_phase1_gates` grew from 328 (v2.0) to **340** assertions: +12 checks for the six new G4 capability regression blocks.

---

## 4. Legacy test executables — CTest coverage audit

The build produces **15 test executables**. CTest registers **only the 6 Phase-1 suites**.

| Executable | Covered by CTest? | Status when run directly (Debug) |
|---|---|---|
| test_phase1_profiler | **yes** | PASS (35 assertions) |
| test_phase1_accounting | **yes** | PASS (67 assertions) |
| test_phase1_budget | **yes** | PASS (55 assertions) |
| test_phase1_records | **yes** | PASS (54 assertions) |
| test_phase1_reproducibility | **yes** | PASS (37 assertions) |
| test_phase1_gates | **yes** | PASS (340 assertions) |
| test_neuron | **no** | exit 0 |
| test_params | **no** | exit 0 |
| test_synapse | **no** | exit 0 |
| test_integration | **no** | exit 0 |
| test_network | **no** | exit 0 |
| test_stdp | **no** | exit 0 |
| test_homeostasis | **no** | exit 0 |
| test_three_factor | **no** | exit 0 |
| test_serialization | **no** | exit 0 |

**The six Phase-1 suites are NOT the whole test surface.** Nine STARK legacy test executables (neuron/params/synapse/integration/network/stdp/homeostasis/three_factor/serialization) build and exit 0, but are **not** registered with CTest and therefore are **not** exercised by `ctest`. This is stated so the Phase-1 CTest result is not mistaken for full project test coverage.

---

## 5. Aggregator matrix (v2.1)

**17 inputs × {Debug, Release} × {normal, --strict} = 68 runs.** Full table: `reports/v2.1-aggregator/matrix.txt`; per-run logs alongside it.

Inputs: the unchanged nine-record recovery (`archive_recovery/aggregator_input`), the v2.1 candidate evidence set (`archive_recovery/v21_evidence`), `build/historical-regen`, `build/results`, `fixtures/v14-valid`, the five controlled fixtures, the two probe fixtures, and the three new `fixtures/v21/*` capability fixtures.

| Input | normal exit | strict exit | pass | fail | records | invalid |
|---|---|---|---|---|---|---|
| `archive_recovery/aggregator_input` (9 recovered) | 1 | 1 | 3 | 4 | 9 | 0 |
| `archive_recovery/v21_evidence` (14) | 1 | 1 | 5 | 2 | 14 | 0 |
| `build/historical-regen` | 1 | 1 | 3 | 4 | 6 | 0 |
| `build/results` | 1 | 1 | 2 | 5 | 3 | 0 |
| `fixtures/v14-valid` | 1 | 1 | 5 | 2 | 11 | 0 |
| `fixtures/controlled-valid` | **0** | **0** | 7 | 0 | 7 | 0 |
| `fixtures/controlled-invalid-g2` | 1 | 1 | 4 | 3 | 6 | 0 |
| `fixtures/controlled-invalid-g4` | 1 | 1 | 6 | 1 | 7 | 0 |
| `fixtures/controlled-invalid-g7` | 1 | 1 | 6 | 1 | 7 | 0 |
| `fixtures/controlled-g7-endpoint-outlier` | 1 | 1 | 6 | 1 | 10 | 0 |
| `fixtures/controlled-invalid-raw-sample` | 1 | 1 | 6 | 1 | 8 | 1 |
| `fixtures/controlled-incorrect-stored-median` | 1 | 1 | 5 | 2 | 8 | 0 |
| `fixtures/probe-malformed-profile` | 1 | 1 | 5 | 2 | 7 | 0 |
| `fixtures/probe-malformed-accounting` | 1 | 1 | 5 | 2 | 7 | 0 |
| `fixtures/v21/controlled-gpu-cuda-off` | 1 | 1 | 6 | 1 | 7 | 0 |
| `fixtures/v21/controlled-gpu-vram-measured` | **0** | **0** | 7 | 0 | 7 | 0 |
| `fixtures/v21/controlled-unknown-capability` | 1 | 1 | 6 | 1 | 7 | 0 |

- **Debug/Release outputs are byte-identical for all 34 input×mode pairs.**
- **Zero crashes / unexpected exits.**
- Strict mode differs from normal only where an invalid record is present (`controlled-invalid-raw-sample`: normal now also exits 1 because G4 fails there, and strict stays 1).
- Note: the recovered nine-record input now shows **pass=3 / fail=4** (G1, G3, G4, G7 fail) versus v2.0's pass=4 / fail=3 — the change is the corrected **G4 FAIL**.
- The fresh `build-v21-{debug,release}` binaries reproduce the `build-v18-*` output byte-for-byte on the candidate evidence set.

---

## 6. Physical-host observations (context for G4)

- `Get-CimInstance Win32_VideoController`: Intel UHD Graphics + **NVIDIA GeForce RTX 2050 (~4.0 GiB)**.
- Production `profiler_cli` PROFILE record: `hardware.gpu_present = true`, provenance lists the RTX 2050 among display adapters.
- `hardware.cuda_available = false` on every record (this binary is built without CUDA).
- Conclusion: the host is **GPU-capable**; CUDA is simply unavailable to this build.
