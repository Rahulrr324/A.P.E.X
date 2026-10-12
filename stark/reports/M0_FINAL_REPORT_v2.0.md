# APEX M0 — v2.0 Historical Data Reconciliation & Final Verification — Final Report

**Date:** 2026-10-05
**Repository:** `stark/` (STARK-006)
**Supersedes:** `M0_FINAL_REPORT_v1.9.md` (preserved intact at
`reports/M0_FINAL_REPORT_v1.9.md` and `reports/historical/superseded/M0_FINAL_REPORT_v1.9.md`)
and v1.8/v1.6/v1.1 (preserved in `reports/historical/superseded/`).
**Scope:** M0 corrective reconciliation and verification only. No M1 work, no APEX features,
no threshold or acceptance-gate changes, no source changes.

---

## 0. Headline

| Area | Result |
|---|---|
| Toolchain / build | **PASS** — no source change; both existing build dirs rebuilt and re-verified |
| CTest (6 suites × Debug + Release) | **PASS** — 6/6 both configs, exit 0 |
| `test_phase1_gates` | **PASS** — 328 assertions, 0 failures, both configs |
| Aggregator matrix | **PASS (as a harness)** — 52 runs (13 inputs × Debug/Release × normal/strict), byte-identical Debug/Release, 0 crashes |
| Aggregator input handling (§2) | **CORRECTED** — dedicated 9-record input dir; `RECOVERY_MANIFEST.json` no longer enters the loader; 0 invalid records (was 1) |
| G7 grouping explanation (§3) | **CORRECTED** — production groups by `r.configuration.dump()`, not by experiment+benchmark |
| G2 over recovered records | **PASS** |
| G4 over recovered records | **PASS** |
| G7 over recovered records | **FAIL** — genuine, retained |
| Evidence count reconciliation (§7) | **CORRECTED** — checksum list and manifest now agree |
| Historical dataset completeness | **NOT PROVEN** — the recovery set is 9 records; no artifact proves a 24-record dataset |
| **M0 overall** | **FAIL** — historical G7 fails; G1/G3 lack evidence; historical completeness unproven |

**M0 is FAIL (not accepted). M1 remains LOCKED.**

> The four v1.9 defects addressed here were: (1) the recovery *count* narrative, (2) the
> manifest being fed to the aggregator as a record, (3) the incorrect G7 grouping
> explanation, and (4) the SHA-256 list/manifest count disagreement. None of these involved a
> production-source defect, so **no source file was changed in v2.0**.

---

## 1. Historical records actually available in the project

The project contains a single recovered historical set and its in-tree equivalents. Nothing
external was searched for, extracted, or referenced in v2.0.

### 1.1 The recovery set (verified)

Source of origin: `archive_recovery/original_historical_records/`, verified against
`RECOVERY_MANIFEST.json`.

| Field | Value |
|---|---|
| Recovered experiment JSON records | **9** |
| Recovered weights binary | 1 (`tiny_dense_2l_weights.bin`, 1,051,664 bytes) |
| Files listed in manifest | 10 |
| Manifest checksums verified | **10/10 OK** |
| Manifest-asserted source archive | `My Local AI(20261003-134219).zip` |
| Manifest-asserted source SHA-256 | `cb5e85e8b446ef0a0c0acf64f4151142489a73c9a9cb0cb5c6f5d28e92fdc733` |
| Source SHA independently re-derived | **No** — the original `.zip` is not in this workspace, so the digest is manifest-asserted only |

### 1.2 Per-record inventory (recovered = original)

| Filename = record_id | Exp | Bench | Kind | Schema | Status | n | Stored median | Recomputed median | SHA-256 (short) |
|---|---|---|---|---|---|---|---|---|---|
| P1-E1-B6-24899.json | E1 | B6 | baseline | STARKP1 1 | PASSED | 10 | 0.00097830 | 0.00097830 | 32cff076 |
| P1-E1-B6-57493.json | E1 | B6 | baseline | STARKP1 1 | PASSED | 10 | 0.00099950 | 0.00099950 | fcda5ecc |
| P1-E1-B7-24899.json | E1 | B7 | benchmark | STARKP1 1 | PASSED | 10 | 0.05816825 | 0.05816825 | bd312702 |
| P1-E1-B7-57493.json | E1 | B7 | benchmark | STARKP1 1 | PASSED | 10 | 0.06030285 | 0.06030285 | a4f1c2d5 |
| P1-E1-B9-24899.json | E1 | B9 | baseline | STARKP1 1 | PASSED | 10 | 0.00144960 | 0.00144960 | 7f0c204d |
| P1-E1-B9-57493.json | E1 | B9 | baseline | STARKP1 1 | PASSED | 10 | 0.00200360 | 0.00200360 | 3f9557b1 |
| P1-E5-B6-90937.json | E5 | B6 | baseline | STARKP1 1 | PASSED | 10 | 0.00116650 | 0.00116650 | c77e5721 |
| P1-E5-B7-90937.json | E5 | B7 | benchmark | STARKP1 1 | PASSED | 10 | 0.04747975 | 0.04747975 | 8c235d6f |
| P1-E5-B9-90937.json | E5 | B9 | baseline | STARKP1 1 | PASSED | 10 | 0.00104115 | 0.00104115 | 47f9dc80 |

All 9 records parse and validate cleanly (parse OK, validation OK). No profiler, telemetry,
skipped, or invalid records are present in the recovered set.

### 1.3 Original vs regenerated vs surviving

| Category | Location | Count | Relationship |
|---|---|---|---|
| **ORIGINAL (recovered)** | `archive_recovery/original_historical_records/` | 9 records + weights | verified against manifest |
| **REGENERATED** (v1.4 label) | `build/historical-regen/` | 6 records + weights | all 6 byte-identical to recovered originals |
| **SURVIVING-ORIGINAL** (v1.4 label) | `build/results/` | 3 records + weights | all 3 byte-identical to recovered originals |

Every recovered record has a **byte-identical** equivalent already present in the working
tree (6 in `build/historical-regen/`, 3 in `build/results/`). The recovery therefore
**confirms existing artifacts**; it introduces no new measurement. "Regenerated" in this
project means "present in `build/historical-regen/`", not "re-measured", because the bytes
are identical to the originals.

### 1.4 `P1-E5-B7-90937` filename / record-id investigation

The v1.9 report table listed the E5/B7 row filename as `P1-E5-B7-909138.json`. Investigation:

* The file on disk is `P1-E5-B7-90937.json`; its embedded `record_id` is `P1-E5-B7-90937`.
* **All 9 files** have a filename exactly equal to their embedded `record_id`.
* Conclusion: the v1.9 entry was a **transcription typo in the report table**, not a data
  inconsistency. No record was renamed and no record content was modified. Corrected in v2.0.

---

## 2. Historical inventory completeness (stated honestly)

* The recovery package contains **exactly nine** JSON experiment records plus the weights
  binary. That is the complete set present in this project.
* **No artifact in this project proves a 24-record historical dataset.** The "24" figure was
  spec/claim text, not backed by any manifest, directory, or checksum list found here.
* The nine records present are **not** claimed to represent a complete historical dataset.
* The 15 absent records were **not fabricated and not inferred**. They are unaccounted-for
  historical evidence (see §7.1).
* Because the recovered set is byte-identical to artifacts already in the tree, the recovery
  cannot be used to claim any historical measurement beyond what the tree already held.

---

## 3. Aggregator input handling (corrected)

### 3.1 The v1.9 defect

In v1.9 the aggregator was pointed at `archive_recovery/original_historical_records/`
directly. That directory contains `RECOVERY_MANIFEST.json`, which `RecordStore::loadAll()`
globbed as a record (`*.json`). The aggregator reported `records found: 10` and counted
`RECOVERY_MANIFEST.json` as **1 invalid record**. This was a directory-layout mistake, not a
parser defect.

### 3.2 The v2.0 correction

A dedicated input directory was created containing **only** the nine experiment JSON files:

```
archive_recovery/aggregator_input/        # exactly 9 records, no manifest, no weights
archive_recovery/original_historical_records/   # pristine originals + manifest + weights (untouched)
```

Each copy was hash-verified against the original (9/9 identical). No original record was
modified, moved, or destroyed. **Production parser behavior was not changed** — the fix is
purely the input directory.

### 3.3 Result

| | v1.9 | v2.0 |
|---|---|---|
| Input | `original_historical_records/` | `aggregator_input/` |
| Records found | 10 | **9** |
| Records loaded | 9 | **9** |
| Invalid records | 1 (`RECOVERY_MANIFEST.json`) | **0** |
| Manifest treated as a record | **yes** | **no** |
| Normal vs strict | both exit 1 (gates already fail) | both exit 1 (identical) |

Every input record is accounted for: 9 found = 9 loaded = 9 PASSED; 0 skipped; 0 invalid.

---

## 4. Real aggregator execution on the corrected input

Command shape (run from `stark/`):

```
./build-v18-debug/aggregate.exe   --out ../archive_recovery/aggregator_input [--strict]
./build-v18-release/aggregate.exe --out ../archive_recovery/aggregator_input [--strict]
```

Exit code: **1** in all four configurations, with **byte-identical** output.

```
records found: 9
STATUS SUMMARY:
  E1: 6 record(s)
  E5: 3 record(s)
  PASSED=9 FAILED=0 SKIPPED=0 NOT_ATTEMPTED=0
GATE RESULTS:
  [FAIL] G1 hardware profile collected            no PROFILE record found
  [PASS] G2 CPU baselines present and complete    E1 and E5 present, distinct, each with >=10 samples
  [FAIL] G3 GPU branch complete-or-skipped        E2 record missing entirely
  [PASS] G4 peak memory measured                  E1 and E5 present, PASSED, RAM peak measured; VRAM documented
  [PASS] G5 parameter accounting consistent        all accounting records pass G5 checks
  [PASS] G6 budget evaluator rejects over-budget   VRAM-only violation detected; compute fields informational
  [FAIL] G7 same-config medians reproducible       (see §6)
OVERALL: FAIL (3 gate(s) failed)
```

Logs: `reports/v20-aggregator/historical.{debug,release}.{normal,strict}.log`.

---

## 5. G2 and G4 re-evaluation (over the nine actual records)

### G2 — CPU baselines present and complete → **PASS**

Production `latest_by_experiment()` resolves the newest E1 and newest E5 record. G2 then
requires both present, PASSED, distinct record_ids, and each ≥10 samples.

* E1 present (6 records), E5 present (3 records) — **both independent baselines**, no shortcut.
* Latest E1 and latest E5 resolve to different `record_id`s — not duplicate-only evidence.
* All 9 are PASSED with exactly 10 samples each.
* Duplicates were not counted as independent coverage: the 9 record_ids are distinct.

### G4 — peak memory measured → **PASS**

`check_peak_memory()` is applied to the latest E1 and latest E5 record; both must be PASSED
and carry a strictly validated measured-memory block. Verified across all 9 records:

| Evidence kind | Value used by G4 | Distinction |
|---|---|---|
| Allocated bytes | `accounting.nominal_parameter_payload_bytes` | parameter footprint — **not** the G4 peak |
| Reserved/estimated | `accounting.total_peak_memory` (`peak_memory_estimated=false`) | model-side estimate, informational |
| **Peak bytes** | `peak_memory.ram_peak_bytes` | **this is what G4 validates** (6,262,784–10,973,184 bytes; all >0, finite) |
| Device-reported | `peak_memory.vram_peak_bytes` | documented unavailable (reason + null) on this CPU-only host |

Every record: `ram_measured=true`, positive finite `ram_peak_bytes`, `cuda_available=false`,
VRAM unavailability object with a non-empty reason and null value. Missing required evidence
fails closed (regression-tested). G4 PASS is not inherited from prior reports; it is read
from the production source and re-run against the records.

Gate JSONs: [G2.json](stark/reports/gate_results/G2.json), [G4.json](stark/reports/gate_results/G4.json).

---

## 6. G7 — corrected grouping and full calculation

### 6.1 The production grouping key

`src/phase1/gates.cpp` groups G7 records by:

```cpp
const std::string key = r.configuration.dump();
```

That is the **serialized configuration block** — not `experiment_id`, and not
`(experiment_id, benchmark_id)`. Two records with identical serialized configurations are
grouped together *even when their experiment ids differ*; two records sharing an experiment
id but differing in configuration are *not* grouped. Independence inside a group is by
**distinct `record_id`**.

> **v1.9 error corrected here:** v1.9's report explained grouping as "E1/B6, E1/B7, … E5/B6,
> …", i.e. by experiment+benchmark, and concluded the E5 groups had "no repeats". The
> production code does not work that way. Because an E1 and an E5 record for the same
> benchmark have **identical serialized configurations**, they land in the **same** group.
> Each of B6, B7, B9 is therefore a **three-run** group (E1 ×2 + E5 ×1), and the aggregator's
> own output — "between runs 1 and 3" — was always consistent with three runs per group.

### 6.2 Per-group detail (unchanged thresholds: 15% timing; 0.001% median consistency; ≥10 samples; distinct record ids)

**Group `config:B6`** (tolerance 15.00%, 3 distinct record ids) — **FAIL**

| Run | record_id | exp | n | stored median | recomputed median |
|---|---|---|---|---|---|
| 1 | P1-E1-B6-24899 | E1 | 10 | 0.00097830 | 0.00097830 |
| 2 | P1-E1-B6-57493 | E1 | 10 | 0.00099950 | 0.00099950 |
| 3 | P1-E5-B6-90937 | E5 | 10 | 0.00116650 | 0.00116650 |

| Pair | records | symmetric diff | allowed | verdict |
|---|---|---|---|---|
| 1&2 | 24899 vs 57493 | 2.12% | 15% | within |
| 1&3 | 24899 vs 90937 | **16.13%** | 15% | **FAIL** |
| 2&3 | 57493 vs 90937 | 14.32% | 15% | within |

Failure reason: `B6 medians differ 16.13% (allowed 15.00%) between runs 1 and 3`.

**Group `config:B7`** (tolerance 15.00%, 3 distinct record ids) — **FAIL**

| Run | record_id | exp | n | stored median | recomputed median |
|---|---|---|---|---|---|
| 1 | P1-E1-B7-24899 | E1 | 10 | 0.05816825 | 0.05816825 |
| 2 | P1-E1-B7-57493 | E1 | 10 | 0.06030285 | 0.06030285 |
| 3 | P1-E5-B7-90937 | E5 | 10 | 0.04747975 | 0.04747975 |

| Pair | records | symmetric diff | allowed | verdict |
|---|---|---|---|---|
| 1&2 | 24899 vs 57493 | 3.54% | 15% | within |
| 1&3 | 24899 vs 90937 | **18.38%** | 15% | **FAIL** |
| 2&3 | 57493 vs 90937 | **21.26%** | 15% | **FAIL** |

Failure reason: `B7 medians differ 18.38% (runs 1&3) and 21.26% (runs 2&3)`.

**Group `config:B9`** (tolerance 15.00%, 3 distinct record ids) — **FAIL**

| Run | record_id | exp | n | stored median | recomputed median |
|---|---|---|---|---|---|
| 1 | P1-E1-B9-24899 | E1 | 10 | 0.00144960 | 0.00144960 |
| 2 | P1-E1-B9-57493 | E1 | 10 | 0.00200360 | 0.00200360 |
| 3 | P1-E5-B9-90937 | E5 | 10 | 0.00104115 | 0.00104115 |

| Pair | records | symmetric diff | allowed | verdict |
|---|---|---|---|---|
| 1&2 | 24899 vs 57493 | **27.65%** | 15% | **FAIL** |
| 1&3 | 24899 vs 90937 | **28.18%** | 15% | **FAIL** |
| 2&3 | 57493 vs 90937 | **48.04%** | 15% | **FAIL** |

Failure reason: `B9 medians differ 27.65% (1&2), 28.18% (1&3), 48.04% (2&3)`.

### 6.3 G7 conclusion

* 3 configuration groups; 3 runs each; 3 pairwise comparisons each.
* Every stored median equals its independently recomputed median within 0.001% (9/9).
* Six of the nine pairwise comparisons exceed 15%.
* **G7 FAILS.** This is an honest failure of the real recovered data. No measurement,
  grouping rule, or threshold was altered to change the outcome.

Gate JSON: [G7.json](stark/reports/gate_results/G7.json).

---

## 7. Evidence reconciliation (§7 of the task)

### 7.1 SHA-256 list vs manifest vs report

* The v1.9 checksum list (`sha256sums_v18.txt`) contained **32** entries; the v1.9 evidence
  manifest and report stated **30** verified. That was the discrepancy.
* v2.0 publishes `reports/sha256sums_v20.txt` with a fixed enumeration of **46** entries.
* `sha256sum -c` verifies **46/46 OK, 0 FAILED**.
* The evidence manifest's `sha256_evidence_list.entries_verified` is set to **46**, matching
  the list's actual entry count and the number successfully verified. Report, manifest, and
  list now agree.

The v1.9 list itself is preserved unchanged as historical evidence (`sha256sums_v18.txt`);
its 32 entries still verify.

### 7.2 Note on the source archive digest

`RECOVERY_MANIFEST.json` asserts the source archive SHA-256
(`cb5e85e8…`). The original `.zip` is not present in this workspace, so that digest is
**manifest-asserted, not independently re-derived**. This is recorded as a limitation
(§9.3), not hidden.

---

## 8. Aggregator behavior verification

Full matrix: **13 inputs × {Debug, Release} × {normal, --strict} = 52 runs**.

Inputs: the corrected 9-record recovery, `build/historical-regen`, `build/results`,
`fixtures/v14-valid`, `controlled-valid`, `controlled-invalid-g2`, `controlled-invalid-g4`,
`controlled-invalid-g7`, `controlled-g7-endpoint-outlier`, `controlled-invalid-raw-sample`,
`controlled-incorrect-stored-median`, `probe-malformed-profile`, `probe-malformed-accounting`.

| Input | exit (normal/strict) | pass | fail | records | invalid |
|---|---|---|---|---|---|
| recovered (aggregator_input) | 1 / 1 | 4 | 3 | 9 | 0 |
| build/historical-regen | 1 / 1 | 4 | 3 | 6 | 0 |
| build/results | 1 / 1 | 2 | 5 | 3 | 0 |
| fixtures/v14-valid | 1 / 1 | 6 | 1 | 11 | 0 |
| controlled-valid | **0 / 0** | 7 | 0 | 7 | 0 |
| controlled-invalid-g2 | 1 / 1 | 4 | 3 | 6 | 0 |
| controlled-invalid-g4 | 1 / 1 | 6 | 1 | 7 | 0 |
| controlled-invalid-g7 | 1 / 1 | 6 | 1 | 7 | 0 |
| controlled-g7-endpoint-outlier | 1 / 1 | 6 | 1 | 10 | 0 |
| controlled-invalid-raw-sample | **0 / 1** | 7 | 0 | 8 | 1 |
| controlled-incorrect-stored-median | 1 / 1 | 6 | 1 | 8 | 0 |
| probe-malformed-profile | 1 / 1 | 6 | 1 | 7 | 0 |
| probe-malformed-accounting | 1 / 1 | 6 | 1 | 7 | 0 |

* **Debug/Release outputs are byte-identical for all 26 input×mode pairs.**
* **Zero crashes / zero unexpected aborts** (no exit 127, no non-{0,1,2} exit).
* Strict mode changes the exit only where an invalid record exists
  (`controlled-invalid-raw-sample`: 0 → 1), exactly as designed.
* Run count reconciled: 13 × 4 = **52** executions recorded in
  `reports/v20-aggregator/matrix.txt`.

---

## 9. Engineering / build / test status (v1.9 baseline preserved, no source change)

* **No source file changed in v2.0.** The v1.8 fixes (G1/G5 fail-closed, boundary tests,
  `samplesB` correction) remain in place.
* Tested source hashes re-verified against the recorded values and the current tree — all match:

| File | SHA-256 |
|---|---|
| `src/phase1/gates.cpp` | `7fd240a8…b455f03c43b070e2` |
| `src/phase1/gates.h` | `e335ee97…8525318d731753c` |
| `src/phase1/aggregate.cpp` | `6c372e70…1d5a172afeaf9d` |
| `src/phase1/common/ExperimentRecord.cpp` | `60476435…5ce422ef7523952` |
| `src/phase1/common/ExperimentRecord.h` | `2f75b9b4…1cd277fd4b90f9` |
| `CMakeLists.txt` | `cf8c7ad6…883dc4f1d56e056` |
| `tests/test_phase1_gates.cpp` | `15110df5…edc70b818d44b5` |

* Builds: `build-v18-debug` and `build-v18-release` both present with `aggregate.exe` and
  `test_phase1_gates.exe`; binaries correspond to the source hashes above.
* CTest: **6/6 passed** in Debug and **6/6 passed** in Release (exit 0).
* `test_phase1_gates`: **328 assertions, 0 failures** in both configs.
* Exact aggregator matrix, logs, and exit codes are captured under `reports/v20-aggregator/`.
* No generated CMake/Ninja file was hand-edited.

---

## 10. Remaining failures and limitations

### 10.1 Failures (real)

1. **G7 FAIL** on the recovered historical data (B6 16.13%; B7 18.38%/21.26%; B9 27.65%/28.18%/48.04% vs 15% allowed). The historical records genuinely fail; retained honestly.
2. **G1 FAIL** — no PROFILE record exists in the recovered set (or anywhere in the project's historical data).
3. **G3 FAIL** — no E2 (GPU branch) record exists; the skip receipts required for the no-CUDA path are absent.

### 10.2 Limitation — historical completeness

* The recovered set is 9 records. **No evidence in the project establishes a 24-record
  historical dataset.** M0 cannot be declared accepted on an unverified subset.

### 10.3 Unavailable historical evidence

* The original `.zip` is not in the workspace; its SHA-256 is manifest-asserted only.
* No 15 additional records, no PROFILE, and no E2/skip records are available.
* The recovered measurements are byte-identical to in-tree artifacts, so no independent
  historical repetition beyond those artifacts can be demonstrated.

---

## 11. Final decision

| Mandatory area | Outcome |
|---|---|
| Build / tests / boundary tests / fail-closed harness | PASS |
| Aggregator correctness / Debug-Release equivalence / strict mode | PASS |
| G2 over recovered records | PASS |
| G4 over recovered records | PASS |
| **G7 over recovered records** | **FAIL** |
| **G1 / G3 evidence** | **FAIL (absent)** |
| **Historical completeness** | **NOT PROVEN** |
| Preservation evidence (originals, manifest, prior reports) | PASS |

**M0 = FAIL (not accepted).**
**M1 = LOCKED.**

Passing software tests alone does not establish M0 acceptance. G7 genuinely fails on the
recovered historical data, G1/G3 lack the required historical records, and the historical
dataset is not proven complete. No measurement or threshold was changed to manufacture a
pass, and M1 is not unlocked.

---

## 12. Files changed in v2.0

| File | Change |
|---|---|
| `archive_recovery/aggregator_input/` (new dir, 9 files) | clean aggregator input: the 9 recovered records only |
| `reports/M0_FINAL_REPORT_v2.0.md` | new final report |
| `reports/gate_results/G2.json` | v2.0, recovered-input evidence |
| `reports/gate_results/G4.json` | v2.0, per-record memory evidence |
| `reports/gate_results/G7.json` | v2.0, corrected `configuration.dump()` grouping + full pairwise table |
| `reports/historical_artifact_inventory.json` | v2.0, required per-record fields, classifications, filename investigation |
| `reports/evidence_manifest.json` | v2.0, reconciled counts |
| `reports/sha256sums_v20.txt` | new 46-entry checksum list |
| `reports/v20-aggregator/` (new dir) | 52-run matrix + logs |
| `reports/historical/superseded/M0_FINAL_REPORT_v1.9.md` | preserved copy of v1.9 |

No production source, fixture, threshold, or historical record was modified. v1.1/v1.6/v1.8/
v1.9 reports remain preserved.
