# STARK Phase 1 — M0 Final Report (v1.5)

**Scope:** corrective M0 closure. No M1 work, no APEX runtime/intelligence features.
**Status:** gate logic is real, tested, and reproducible; **G7 fails on all available
real measurement data**, so **M0 acceptance is NOT claimed**.

Supersedes the v1.1 report (which falsely claimed the records were destroyed) and the
v1.4 report.

---

## 1. v1.5 changes (three gate-correctness gaps closed)

1. **G7 all-pairs.** The v1.4 G7 compared only adjacent entries, so `100/90/80` (adjacent
   10% and 11.11%, endpoints 20%) wrongly passed. G7 now compares **every repeat with
   every other repeat** in its same-configuration group (max-spread). Thresholds
   unchanged (timing 15%, B3/B5 bandwidth 20%). Failure stays sticky; diagnostics
   accumulate.
2. **G4 fail-closed capability.** `cuda_available` missing/malformed no longer means
   "CPU-only". Classification is now explicit:
   - `cuda_available=true` → GPU-capable (measured VRAM required);
   - `cuda_available=false` → CPU-only (valid unavailable-VRAM reason required);
   - missing/malformed → **Unknown → G4 FAILS**, unless an authoritative field
     (non-empty `gpu_model`/`cuda_version`, or positive `vram_total_bytes`) establishes
     GPU capability.
   Absence of evidence is no longer treated as evidence of CPU-only hardware.
3. **G7 requires computed, sufficient statistics.** A record qualifies only if
   `statistics` exists, `computed == true`, has **≥10 samples**, and a finite median.
   Profiler/telemetry records (which carry an informational `benchmark_id`, e.g.
   `TELEMETRY`) are never treated as benchmark evidence.
4. **Schema correction.** `ExperimentRecord::validate()` now rejects a PASSED
   benchmark/baseline record whose statistics block is present but `computed == false`
   (smallest compatible change; serialization format unchanged).
5. **Stale comment removed.** The G7 comment no longer says "starts FAIL"; the
   implementation starts PASS and only transitions to FAIL.

## 2. Test evidence (real production seam)

All tests call `evaluate_gates()` from [`src/phase1/gates.h`](../src/phase1/gates.h) —
no gate logic is duplicated in tests. The suite is now **148 assertions** (was 96),
passing in **Debug and Release** (`regression_test_results.log`). The Release-safe
harness remains active under `NDEBUG`.

## 3. Fresh build + test verification

Single documented toolchain (`toolchain_manifest.txt`): WinLibs **GCC 16.1.0**
(x86_64-w64-mingw32, UCRT), CMake 4.4.1, Ninja 1.13.2.

```
cmake -S . -B build-v15-debug   -G Ninja -DCMAKE_BUILD_TYPE=Debug   -DCMAKE_CXX_COMPILER=<winlibs>/g++.exe
cmake --build build-v15-debug          # 103/103, BUILD_EXIT=0
ctest --test-dir build-v15-debug --output-on-failure     # 6/6 passed, exit 0

cmake -S . -B build-v15-release -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=<winlibs>/g++.exe
cmake --build build-v15-release        # 103/103, BUILD_EXIT=0
ctest --test-dir build-v15-release --output-on-failure   # 6/6 passed, exit 0
```

Logs: `build_debug.log`, `build_release.log`, `ctest_debug.log`, `ctest_release.log`.

## 4. Aggregator results (`aggregator_real_dirs.log`, `aggregator_controlled_fixtures.log`)

| directory | gates PASS | gates FAIL | exit |
|---|---|---|---|
| `build/results` (3 surviving originals) | G5,G6 | G1,G2,G3,G4,G7 | 1 |
| `build/historical-regen` (6 regenerated) | G2,G4,G5,G6 | G1,G3,G7 | 1 |
| `fixtures/v14-valid` (fresh production runs) | G1–G6 | G7 | 1 |
| `fixtures/controlled-valid` | **all** | — | **0** |
| `fixtures/controlled-invalid-g2` | G1,G3,G5,G6 | G2,G4,G7 | 1 |
| `fixtures/controlled-invalid-g4` | G1–G3,G5,G6 | G4 | 1 |
| `fixtures/controlled-invalid-g7` | G1–G6 | G7 | 1 |
| `fixtures/controlled-g7-endpoint-outlier` | G1–G6 | G7 (B2 runs 1 vs 3, 20%) | 1 |

The aggregator exits **nonzero whenever a gate fails**.

## 5. G7 reproducibility — FAIL (unchanged thresholds)

Full study: `reproducibility_study.md`, raw data `g7_reproducibility_samples.log`.

- E1/E5 configuration blocks are **byte-identical** on B6/B7/B9 — not a config mismatch.
- Measurement policy: warmup 3, measurement 10, threads 0 (unpinned), batch 1, FP32.
- Across 5×E1 + 5×E5 fresh runs, medians vary **55.05% (B6), 48.71% (B7), 56.76% (B9)**.
- One disturbed B6 run: samples 221–585 µs (stdev 80.8 µs). A clean B6 run: 221–253 µs
  (stdev 10.7 µs). This is a preemption signature.
- Host: i5-12450H laptop, LoadPercentage 31–40%, background `chrome` processes.
- Classification: **environmental (primary) + methodological (10 samples, unpinned,
  median of a ~200 µs workload) — mechanism identified, tolerance not met.**

No thresholds were changed and no measurement was edited to force a pass.

## 6. Historical evidence (unchanged, byte-for-byte)

Inventory (SHA-256): `historical_artifact_inventory.txt` (174 files).

- **Surviving originals — DO NOT OVERWRITE:** `build/results/`
  `P1-E1-B6-57493.json` `fcda5ecc…`, `P1-E1-B7-57493.json` `a4f1c2d5…`,
  `P1-E1-B9-57493.json` `3f9557b1…`, `tiny_dense_2l_weights.bin` `d7210547…`
  (verified unchanged after this task).
- **Regenerated:** `build/historical-regen/` six JSON + weights copy (same weights hash).
- **Irreversible historical limitation:** only 3 E1 records survive; ~21 others — and
  all original E5/CUDA/INT8 relatives — are gone, not recovered, no replacements
  manufactured.

## 7. Per-gate status

| Gate | Implementation | Tests | Archive result | Status |
|---|---|---|---|---|
| G1 | present | CLI fixtures | FAIL (no PROFILE in old dirs) | **PASS** (fresh PROFILE) |
| G2 | strict | 7 cases | PASS on `historical-regen` | **PASS** |
| G3 | present | CLI fixtures | PASS on fresh dirs | **PASS** |
| G4 | strict + fail-closed | 21 cases | PASS on `historical-regen` | **PASS** |
| G5 | present | existing suites | PASS | **PASS** |
| G6 | present | existing suites | PASS | **PASS** |
| G7 | all-pairs + computed | 25 cases | **FAIL** (48–57% variance) | **FAIL on archive**; logic VERIFIED |

## 8. Non-fabrication statement

No historical record was deleted, overwritten, or manufactured. Controlled fixture
directories are explicitly synthetic test inputs derived from real records with every
edit disclosed in each `README.txt`. No measurement was edited to make real-data G7 pass.

## 9. Reproduction

Source hashes: `source_manifest.txt` (corresponds to the `build-v15-*` evidence above).
Toolchain/commands: `toolchain_manifest.txt`. If any source changes, re-run the
affected builds/tests.
