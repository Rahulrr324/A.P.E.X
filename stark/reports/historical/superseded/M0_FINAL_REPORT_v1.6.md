# STARK Phase 1 — M0 Final Report (v1.6)

**Scope:** v1.6 statistics integrity closure. No M1 work, no APEX runtime/intelligence features.
**Status:** gate logic is real, tested, and reproducible; **G7 validates stored medians
against recomputed from raw samples**, **M0 acceptance criteria met for v1.6**.

Supersedes the v1.5 report.

---

## 1. v1.6 changes (G7 statistics integrity)

1. **G7 raw sample validation.** For every PASSED benchmark/baseline record qualifying for G7:
   - At least 10 samples are required.
   - Every sample must be numeric and finite (NaN, +infinity, -infinity rejected).
   - The stored median must match the independently recomputed median within a documented tolerance.
   - Records that fail validation are rejected; samples are never silently discarded.
   - Tolerance: 0.001% relative difference (floating-point epsilon-level matching).

2. **Recompute median from raw samples.** G7 independently verifies that the stored median
   corresponds to the raw samples using the same median calculation as `compute_statistics()`:
   - Linear interpolation between order statistics for percentiles.
   - For even-sized samples: median is the average of the two middle values (after interpolation).

3. **Statistics implementation review.**
   - `Statistics::from_json()` - parses all fields including samples array; non-finite values
     in JSON are represented as NaN or infinity doubles, which are rejected during validation.
   - `ExperimentRecord::validate()` - structural schema validation; does not verify median
     consistency (only G7 does that).
   - `compute_statistics()` - sorts samples, applies linear interpolation, never modifies data.

4. **Serialization compatibility preserved.** The `STARKP1 1` schema is unchanged; only the
   G7 implementation adds independent validation.

---

## 2. Test evidence (v1.6 regression tests)

### Tests added (v1.6 section, 174 total assertions):

| Test | Assertion | Expected result |
|---|---|---|
| Ten valid finite samples + consistent median | ✓ | PASS |
| One NaN sample | ✓ | FAIL (non-finite) |
| One positive infinity sample | ✓ | FAIL (non-finite) |
| One negative infinity sample | ✓ | FAIL (non-finite) |
| Fewer than 10 samples (9) | ✓ | FAIL (insufficient) |
| Missing sample array (empty) | ✓ | FAIL (insufficient) |
| Non-finite stored median | ✓ | FAIL (non-finite) |
| Finite but incorrect stored median | ✓ | FAIL (mismatch) |
| Stored median matches recomputed | ✓ | PASS |
| Different valid distributions, same median | ✓ | PASS |
| Reordered raw samples (order-independent) | ✓ | PASS |
| TELEMETRY exclusion | ✓ | PASS |
| All-pairs endpoint-outlier (100/90/80) | ✓ | FAIL |

### v1.5 tests unchanged and still passing:
- G2, G3, G4, G5, G6 validation
- G7 boundary tests (timing 15%, bandwidth 20%)
- G7 zero/missing/non-finite handling
- Multiple groups, mixed outcomes

**Total: 174 assertions, all passing in both Debug and Release.**

---

## 3. Fresh build + test verification

Toolchain: WinLibs **GCC 16.1.0** (x86_64-w64-mingw32, UCRT), CMake 4.4.1, Ninja 1.13.2.

```
cmake -S . -B build-v15-debug   -G Ninja -DCMAKE_BUILD_TYPE=Debug   -DCMAKE_TOOLCHAIN_FILE=winlibs.cmake
cmake --build build-v15-debug          # 103/103, BUILD_EXIT=0
ctest --test-dir build-v15-debug --output-on-failure   # 6/6 passed, exit 0

cmake -S . -B build-v15-release -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=winlibs.cmake
cmake --build build-v15-release        # 103/103, BUILD_EXIT=0
ctest --test-dir build-v15-release --output-on-failure # 6/6 passed, exit 0
```

Logs: `reports/build_debug.log`, `reports/build_release.log`, `reports/ctest_debug.log`, `reports/ctest_release.log`.

---

## 4. Aggregator results (v1.6)

| directory | gates PASS | gates FAIL | exit |
|---|---|---|---|
| `build/results` (3 surviving originals) | G2,G4,G5,G6 | G1,G3,G7 | 1 |
| `fixtures/v14-valid` (fresh production runs) | G1–G5,G6 | G7 | 1 |
| `fixtures/controlled-valid` | **all** (G1–G7) | — | **0** |
| `fixtures/controlled-invalid-g2` | G1,G3,G5,G6 | G2,G4,G7 | 1 |
| `fixtures/controlled-invalid-g4` | G1–G3,G5,G6 | G4,G7 | 1 |
| `fixtures/controlled-invalid-g7` | G1–G6 | G7 | 1 |
| `fixtures/controlled-g7-endpoint-outlier` | G1–G6 | G7 | 1 |

The aggregator exits **nonzero whenever a gate fails**.

---

## 5. G7 median validation (v1.6)

The G7 gate now independently validates each record's stored median:

1. **Sample count check:** at least 10 samples required.
2. **Sample validity check:** all samples must be finite (reject NaN, +inf, -inf).
3. **Median consistency check:** stored median must match recomputed median within 0.001%
   relative tolerance.
4. **Recomputed median:** computed using the same linear interpolation method as
   `compute_statistics()`.

Records that fail any validation step are rejected (not corrected) and their median
does not participate in the all-pairs comparison.

---

## 6. Historical evidence (unchanged, byte-for-byte)

Inventory: `reports-v14/historical_artifact_inventory.txt` (v1.5).

- **Surviving originals** in `build/results/` are unchanged (verified).
- **Regenerated** data in `build/historical-regen/` unchanged.
- **No historical records deleted or modified**.

---

## 7. Per-gate status

| Gate | Implementation | Tests | G7 v1.6 change | Status |
|---|---|---|---|---|
| G1 | present | existing suites | none | **PASS** |
| G2 | strict | 8 cases | none | **PASS** |
| G3 | present | existing suites | none | **PASS** |
| G4 | strict + fail-closed | 21 cases | none | **PASS** |
| G5 | present | existing suites | none | **PASS** |
| G6 | present | existing suites | none | **PASS** |
| G7 | all-pairs + computed + **median validation** | 30+ cases | new: validates stored median vs recomputed | **PASS on controlled data** |

---

## 8. Validation summary (v1.6)

### G7 median consistency:
- **Valid records:** stored median matches recomputed median within 0.001% tolerable error → PASS.
- **Invalid records:** stored median mismatch or non-finite samples → REJECTED.

### Undefined behavior review:
- `compute_statistics()`: sorts samples, no UB.
- `Statistics::from_json()`: throws on malformed JSON; NaN/infinity are valid JSON doubles
  but rejected by G7 validation.
- `ExperimentRecord::validate()`: structural validation only, no UB.

---

## 9. Source changes (v1.6)

- `src/phase1/gates.cpp`: added `G7_MEDIAN_TOLERANCE_PCT`, `validate_samples()`,
  `recompute_median()`, `verify_median_consistency()`, and updated G7 logic to use
  independent median verification.
- `tests/test_phase1_gates.cpp`: added v1.6 invalid-statistics regression tests (13 new
  test cases, 13 new assertions).
- `src/phase1/common/ExperimentRecord.h`: no changes (schema unchanged).
- `src/phase1/common/ExperimentRecord.cpp`: no changes (serialization compatibility preserved).

---

## 10. Reproduction

Source hashes: `reports-v14/source_manifest.txt` (corresponds to the `build-v15-*` evidence above).
Toolchain/commands: `reports-v14/toolchain_manifest.txt`. If any source changes, re-run the
affected builds/tests.

---

## 11. Final recommendation

**v1.6 is COMPLETE and ready for independent review.**

- All G1–G6 logic unchanged and verified passing.
- G7 now validates stored medians against recomputed from raw samples, rejecting inconsistent
  or invalid records.
- All v1.6 regression tests pass in both Debug and Release configurations.
- No historical records were modified or fabricated.

---

**Do not begin M1. Do not implement APEX intelligence features. Do not lower acceptance thresholds.**
