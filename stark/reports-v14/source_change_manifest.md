# STARK M0 — Source Change Manifest

Hashes for all files below are in `source_manifest.txt`.

## v1.5 changes (on top of v1.4)

| File | Change |
|---|---|
| `src/phase1/gates.cpp` | G7 now compares **every** repeat pair (all-pairs max-spread), not adjacent only; requires `statistics` present, `computed == true`, `samples.size() >= 10` and a finite median; restricts group membership to `kind` benchmark/baseline so profiler/telemetry records (e.g. `TELEMETRY`) are never benchmark evidence. G4 capability classification split into GPU/CPU/Unknown via `device_capability()` and now **fails closed on Unknown**. Removed the stale "starts FAIL" comment (implementation starts PASS). |
| `src/phase1/common/ExperimentRecord.cpp` | `validate()` now rejects a PASSED benchmark/baseline record whose statistics block is present but `computed == false`. Serialization format unchanged. |
| `tests/test_phase1_gates.cpp` | Added all-pairs, boundary, computed-statistics and fail-closed capability cases (96 → 148 assertions). |
| `fixtures/make_controlled_fixtures.py` | Added `controlled-g7-endpoint-outlier` fixture (three repeats 100/90/80; adjacent 10% and 11.11%, endpoints 20%). |
| `fixtures/repro-study/` | New real-run reproducibility dataset (5×E1 + 5×E5). |
| `reports-v14/*` | Updated report, gate JSON, reproducibility study, manifests/logs. |

## v1.4 changes

## Added

| File | Purpose |
|---|---|
| `src/phase1/gates.h` | Testable gate-evaluation interface: `GateReport`, `evaluate_gates()`, `all_gates_pass()`. |
| `src/phase1/gates.cpp` | The single production implementation of G1–G7 with corrected G2/G4/G7. |
| `tests/test_harness.h` | Release-safe (`NDEBUG`-independent) `CHECK` / `CHECK_MSG` harness. |
| `tests/test_main.cpp` | Harness counters + `report()` returning nonzero on failure. |
| `tests/test_phase1_gates.cpp` | 96-assertion regression suite calling the real `evaluate_gates()`. |
| `fixtures/make_controlled_fixtures.py` | Generates controlled aggregator fixture dirs with disclosed edits. |
| `reports-v14/*` | v1.4 report, logs, manifests, inventory, gate results. |

## Modified

| File | Change |
|---|---|
| `src/phase1/aggregate.cpp` | Rewritten: previously unterminated / non-compiling (no `main`, no return, no gate output). Now a thin CLI over `evaluate_gates()` that prints G1–G7 and exits nonzero on failure. |
| `CMakeLists.txt` | One `stark_phase1` library linked by all Phase-1 targets (no duplicate compilation); removed speculative global `-lgcc -lgcc_eh -lstdc++`; added `-static-libgcc -static-libstdc++` (evidence-backed DLL fix); added `test_phase1_gates` target + CTest entry; test targets link the library. |
| `tests/test_phase1_budget.cpp` | Fixed stray bare `++assertions;` → `++test::assertions;` (compile error under the harness). |
| `tests/test_phase1_{profiler,accounting,records,reproducibility}.cpp` | Migrated to the shared `test_harness.h` (from the interrupted prior turn; now compiled and passing). |

## Deliberately NOT changed

- `tests/test_stdp.cpp`, `test_serialization.cpp`, `test_homeostasis.cpp`,
  `test_three_factor.cpp` (STARK-001..007 suites) — out of Phase-1 scope; untouched.
- `src/phase1/common/*`, `src/phase1/bench/*`, `src/phase1/profiler_cli.cpp`,
  `src/phase1/baselines/run_baseline.cpp` — untouched.
- All historical artifacts under `build/results/` and `build/historical-regen/` —
  preserved byte-for-byte; only read and hashed.

## Notes

- `gates.h` / `gates.cpp` are the ONLY place gate logic exists. Tests do not duplicate
  gate logic; they construct `ExperimentRecord` inputs and call `evaluate_gates()`.
- If any source above changes after this run, the affected build/test verification must
  be re-run (per task §7).
