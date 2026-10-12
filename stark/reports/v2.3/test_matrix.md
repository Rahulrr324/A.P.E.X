# v2.3 Test Matrix

Toolchain: WinLibs GCC 16.1.0 (`C:/Users/rahul/AppData/Local/Microsoft/WinGet/
Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/
mingw64/bin/g++.exe`), CMake 4.4.1, Ninja 1.13.2, C++17 (EXTENSIONS=OFF).

## 1. Fresh builds

| Build dir | Config | Configure | Build | Warnings | Errors | Edges | NDEBUG |
|---|---|---|---|---|---|---|---|
| `build-v23-debug` | Debug | exit 0 | exit 0 | 0 | 0 | 96/96 | 0 |
| `build-v23-release` | Release | exit 0 | exit 0 | 0 | 0 | 96/96 | 103 |

Build logs: `build-v23-{debug,release}.{configure,build}.log`.

## 2. CTest (6 registered Phase-1 suites)

| Suite | Debug | Release | Assertions |
|---|---|---|---|
| test_phase1_profiler | Passed | Passed | 35 |
| test_phase1_accounting | Passed | Passed | 67 |
| test_phase1_budget | Passed | Passed | 55 |
| test_phase1_records | Passed | Passed | 54 |
| test_phase1_reproducibility | Passed | Passed | 37 |
| test_phase1_gates | Passed | Passed | 417 |

Both configs: **6/6 passed, exit 0.**

## 3. G3 matrix (Release aggregator; Debug identical)

| # | Evidence set | Branch | G3 | exit |
|---|---|---|---|---|
| 1 | nine recovered (`aggregator_input`) | no-CUDA | FAIL | 1 |
| 2 | `v21_evidence` (pre-v2.3, no attestation) | no-CUDA | FAIL | 1 |
| 3 | `v23-valid` (fresh, attested) | no-CUDA | PASS | 1 (G4/G7) |
| 4 | `v23-attested` | no-CUDA | PASS | 1 (G4/G7) |
| 5 | `v23-fabricated` | no-CUDA | FAIL | 1 |
| 6 | `v23-contradictory` | no-CUDA | FAIL | 1 |
| 7 | `v23-missing-e2` | no-CUDA | FAIL | 1 |
| 8 | `v23-malformed` | no-CUDA | FAIL (+1 invalid) | 1 |
| 9 | seam, skipped E2/B4/B5 | CUDA-present | FAIL | — |
| 10 | seam, all PASSED | CUDA-present | PASS | — |

Unit-level (in `test_phase1_gates`): 12 G3 cases + sub-cases, all as specified.

## 4. GPU detection matrix (unit-level, deterministic)

| Case | Expected `gpu_present` | Result |
|---|---|---|
| physical NVIDIA | true | ✔ |
| Intel integrated | true | ✔ |
| duplicate enumeration | true, deduped | ✔ |
| Microsoft Basic Display only | false | ✔ |
| remote/virtual only | false | ✔ |
| empty inventory | Unknown (nullopt) | ✔ |
| ambiguous adapter | Unknown (nullopt) | ✔ |
| mixed physical + virtual | true | ✔ |
| PCI id, unknown vendor | true | ✔ |
| dedupe by name | unique_count==1 | ✔ |
| determinism | identical output | ✔ |

## 5. G4 matrix (Release)

| Evidence | G4 |
|---|---|
| nine recovered | FAIL — capability unknown |
| `v23-valid` | FAIL — GPU-capable but vram_measured false |
| `fixtures/v21/controlled-gpu-cuda-off` | FAIL — GPU-capable but vram_measured false |
| `fixtures/v21/controlled-gpu-vram-measured` | PASS |
| `fixtures/v21/controlled-unknown-capability` | FAIL — capability unknown |

## 6. G7 matrix (unchanged)

| Evidence | G7 | Detail |
|---|---|---|
| nine recovered | FAIL | B6 16.13%; B7 18.38%/21.26%; B9 27.65%/28.18%/48.04% |
| `v21_diagnostics` | FAIL | B6 53.99% |
| `v23-valid` (fresh) | FAIL | B6 47.55% |

Historical numbers reproduce v2.2 exactly. No threshold/grouping change.

## 7. Debug/Release parity

Aggregator logs for every v2.3 evidence set are byte-identical between Debug and
Release (`reports/v2.3/aggregator/*.{debug,release}.log`).

## 8. Independent weakness probe

`reports/v2.2/tests/test_v22_g3_semantics.cpp` recompiled against the v2.3
library → `10 checks, 5 failures`; the 5 failures are exactly the v2.2 test's
weak-behaviour assertions, proving the G3 weakness is closed.