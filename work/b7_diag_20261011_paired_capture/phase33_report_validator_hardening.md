# Phase 33 Report — Validator Hardening and Adversarial Test Audit

**Repository:** `Rahulrr324/A.P.E.X`
**Branch:** `main`
**HEAD:** `ef76c8a187eec02c13a71e0aeb1b5525557cac1e`
**Upstream:** `origin/main`
**Final status:** `READY FOR NEXT-STEP REVIEW`

This phase audits and hardens the Phase 32 paired-CSV validator so that malformed
or internally inconsistent data cannot be accepted as valid evidence. A new,
separate validator was created; no benchmark was run and no measurement was
collected.

---

## 1. Pre-flight and repository state

| Item | Value |
|---|---|
| Branch | `main` |
| HEAD SHA | `ef76c8a187eec02c13a71e0aeb1b5525557cac1e` |
| Upstream | `origin/main` |
| Git status (start) | `?? stark/nul` (pre-existing, untouched) |

The pre-existing untracked `stark/nul` artifact was present before this phase
and was left in place. It was not deleted, moved, or modified.

## 2. SHA-256 hashes of protected files

Recorded before any work and re-checked after all work. Every hash is identical
between the two checks, confirming no protected file was modified.

| File | SHA-256 | unchanged |
|---|---|---|
| `work/b7_diag_20261011_paired_capture/phase32_paired_csv_validator.py` | `3c703a423ef9c46102ff04f533a9e8db1f38b0d6d0155c8512aaff896ab54e38` | yes |
| `work/b7_diag_20261011_paired_capture/phase32_report_validator_correction.md` | `9445fdcfddfb06fd3ec186c16a44d013875ad8758971ab163216f19a7fca5202` | yes |
| `work/b7_diag_20261011_paired_capture/phase19_planning/phase19_validate.py` | `6285cc12bd03742ebba20e8abccc4d356d26db3c9f37224b45de65580b1aa2a3` | yes |
| `work/b7_diag_20261011_paired_capture/phase28_b7_read_path/phase30_validate.py` | `34b93afb912f752bfdd6b0d0a61fd6d4ab581cfd7b1427b0f4a99d29dbad6fc0` | yes |
| `work/b7_diag_20261011_paired_capture/phase28_b7_read_path/probe/pr30_probe_warm/paired_samples.csv` | `9c9a89306a8e22534f034b659725d996864380129770bc7ab2c2dae590353262` | yes |
| `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` | `aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b` | yes |
| `stark/CMakeLists.txt` | `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8` | yes |
| `work/b7_diag_20261011_paired_capture/phase32_test/six_good.csv` | `9928bf0107025b7679fd0bc54e08530c73030d6bda3bf931fe0b8d79ea891535` | yes |
| `work/b7_diag_20261011_paired_capture/phase32_test/eight_good.csv` | `366ea1e606b3517f066b045de1ff400998895aef73547b1d7fd6defbf6d23b81` | yes |

## 3. New files created (nothing existing was modified)

| Path | Role |
|---|---|
| `work/b7_diag_20261011_paired_capture/phase33_paired_csv_validator.py` | Hardened validator (new, separate) |
| `work/b7_diag_20261011_paired_capture/phase33_test/make_fixtures.py` | Deterministic fixture generator |
| `work/b7_diag_20261011_paired_capture/phase33_test/run_tests.py` | Adversarial test runner |
| `work/b7_diag_20261011_paired_capture/phase33_test/test_results.json` | Machine-readable results (25 cases) |
| `work/b7_diag_20261011_paired_capture/phase33_test/*.csv` | 25 synthetic fixtures |
| `work/b7_diag_20261011_paired_capture/phase33_report_validator_hardening.md` | This report |

## 4. Implementation decisions

### Retained from Phase 32 / Phase 19 (frozen, unchanged)

- Explicit profiles: `six` = 6×50 = **300** rows, `eight` = 8×50 = **400** rows
  (plus one header line).
- Exact header check against `replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct`.
- Frozen calibration formulas (verbatim from `bm_b7_diagnostic.cpp` `calibrate()`):
  - mean overhead = `100 × (mean_instr − mean_min) / mean_min`
  - worst signed pair overhead = `max` over aligned pairs of `100 × (instr − min) / min` (signed, unclamped)
  - median deviation = `100 × |median_instr − median_min| / median_min`
- Frozen thresholds: `|mean| ≤ 2 %`, `worst ≤ 10 %`, `median_dev ≤ 2 %`.
- Overhead-formula tolerance, consistent with the Phase 19/30 validators:
  `|recorded − 100×(instr−min)/min| ≤ 1e-6 × max(1.0, |recorded|)`.

### Hardening added in Phase 33

1. **Strict numeric parsing.** Timing and overhead fields must match a plain
   decimal/scientific literal regex **and** be finite. This rejects `nan`,
   `inf`, `-inf`, `1e400` (overflows to `inf`), `1_0`, and whitespace-padded
   values — all of which Python's bare `float()` would otherwise accept. The
   Phase 32 validator used `float()` directly and would have accepted `nan`
   into its metrics.
2. **Canonical integer keys.** `replicate`/`iteration` must be non-negative
   decimal integers with no sign, whitespace, or leading zeros. `1.0`, `abc`,
   `+1`, `007`, and ` 1 ` are all rejected.
3. **Strict CSV parsing** (`csv.reader(..., strict=True)`) with UTF-8 decode and
   BOM rejection, plus a per-row field-count check so a 4- or 6-field row is
   rejected rather than silently coerced.
4. **Explicit key-integrity checks:** uniqueness (duplicates), exact key set
   (missing/extra), range bounds, and per-replicate counts — each reported as a
   named, independent check.
5. **Row-order independence (documented contract).** Row order is **not**
   required. Pairs are aligned by the `(replicate, iteration)` key before any
   paired metric is computed; rows are never paired by file position. Metric
   arrays are built in sorted key order for determinism. The contract is echoed
   in the JSON output (`ordering_contract`, `pair_alignment`).
6. **Positivity enforced on both timing fields** (`minimal_sec > 0` and
   `instrumented_sec > 0`), preventing division-by-zero/negative-time evidence.
7. **Structural validity reported separately from calibration.** Calibration is
   computed **only** after all structural checks pass; otherwise its status is
   `NOT_EVALUATED` (never a misleading PASS/FAIL).
8. **Structured JSON + safe exit codes; no unhandled traceback.** The whole run
   is wrapped so malformed input emits a JSON error object. Exit codes:
   `0` structural PASS + calibration PASS, `1` structural FAIL, `2` calibration
   FAIL (a legitimate data result), `3` usage/internal error.

## 5. Adversarial synthetic tests (25 cases, 0 failures)

Fixtures generated deterministically in `phase33_test/` only. **These are not
benchmark evidence.** Every malformed fixture was rejected structurally without
an unhandled exception (no `Traceback` in stderr for any case).

| # | Fixture | Exit | Structural | Calibration | Result |
|---|---|---|---|---|---|
| 1 | `valid_six.csv` | 0 | PASS | PASS | PASS |
| 2 | `valid_eight.csv` | 0 | PASS | PASS | PASS |
| 3 | `dup_key.csv` (duplicate pair key) | 1 | FAIL | NOT_EVALUATED | PASS |
| 4 | `missing_key.csv` (missing pair key) | 1 | FAIL | NOT_EVALUATED | PASS |
| 5 | `unexpected_key.csv` (replicate 99) | 1 | FAIL | NOT_EVALUATED | PASS |
| 6 | `wrong_row_count.csv` (301 rows) | 1 | FAIL | NOT_EVALUATED | PASS |
| 7 | `wrong_header.csv` | 1 | FAIL | NOT_EVALUATED | PASS |
| 8 | `missing_column.csv` (4-field row) | 1 | FAIL | NOT_EVALUATED | PASS |
| 8 | `malformed_row.csv` (6-field row) | 1 | FAIL | NOT_EVALUATED | PASS |
| 9 | `non_integer_key.csv` (`1.5`, `two`) | 1 | FAIL | NOT_EVALUATED | PASS |
| 10 | `non_numeric_timing.csv` (`abc`) | 1 | FAIL | NOT_EVALUATED | PASS |
| 11 | `bad_minimal_sec_nan.csv` | 1 | FAIL | NOT_EVALUATED | PASS |
| 11 | `bad_minimal_sec_inf.csv` | 1 | FAIL | NOT_EVALUATED | PASS |
| 11 | `bad_instrumented_sec_nan.csv` | 1 | FAIL | NOT_EVALUATED | PASS |
| 11 | `bad_instrumented_sec_inf.csv` | 1 | FAIL | NOT_EVALUATED | PASS |
| 11 | `bad_instrumented_sec_neginf.csv` | 1 | FAIL | NOT_EVALUATED | PASS |
| 11 | `bad_signed_overhead_pct_nan.csv` | 1 | FAIL | NOT_EVALUATED | PASS |
| 11 | `bad_signed_overhead_pct_inf.csv` | 1 | FAIL | NOT_EVALUATED | PASS |
| 12 | `zero_minimal.csv` | 1 | FAIL | NOT_EVALUATED | PASS |
| 12 | `negative_minimal.csv` | 1 | FAIL | NOT_EVALUATED | PASS |
| 13 | `zero_instrumented.csv` | 1 | FAIL | NOT_EVALUATED | PASS |
| 13 | `negative_instrumented.csv` | 1 | FAIL | NOT_EVALUATED | PASS |
| 14 | `bad_overhead_pct.csv` (recorded pct off by +3) | 1 | FAIL | NOT_EVALUATED | PASS |
| 15 | `reordered_six.csv` (rows shuffled) | 0 | PASS | PASS | PASS |
| 16 | valid rows passing calibration (= `valid_six.csv`) | 0 | PASS | PASS | PASS |
| 17 | `fail_calibration.csv` (~5 % mean overhead) | 2 | PASS | FAIL | PASS |

### Reordering / key-alignment verification

`reordered_six.csv` is `valid_six.csv` with rows deterministically shuffled.
Both were validated and their `metrics` and `calibration` objects compared for
exact equality: **identical**. This proves pairs are aligned by
`(replicate, iteration)` key and never by file position. Mean minimal
`0.00951778 s`, mean instrumented `0.009565369 s`, 0 pairs over 10 %.

### Additional edge cases (beyond the 25)

- Empty file → exit 1, `file_non_empty` FAIL, no traceback.
- Nonexistent path → exit 1, `file_readable` FAIL, no traceback.
- Six-replicate CSV validated under `--profile eight` → exit 1, structural FAIL
  (row/line count, key set, per-replicate counts all detect the mismatch).
- Invalid CLI arg (`--profile ten`) → exit **3** (usage), not 2. Exit 2 is
  reserved exclusively for calibration FAIL.

### Test-runner false-pass caught and fixed

The first test run reported a case `bad_instrumented_sec_inf.csv` that did not
exist — the generator had only written a `_neginf` variant — and a missing file
coincidentally also exits 1, so the case passed for the wrong reason. Root cause
fixed rather than suppressed: the generator now emits a genuine `inf` fixture
for `instrumented_sec` (and keeps the `-inf` variant), and the runner now fails
any case whose fixture file is absent. The guard was self-tested by requesting a
deliberately missing filename and confirming the case is marked failed. Final
run: **25 cases, 0 failures**.

## 6. Existing probe CSV (six-replicate profile)

File: `work/b7_diag_20261011_paired_capture/phase28_b7_read_path/probe/pr30_probe_warm/paired_samples.csv`
SHA-256 `9c9a89306a8e22534f034b659725d996864380129770bc7ab2c2dae590353262`
(unchanged before/after), 301 lines = header + 300 data rows.

| Aspect | Result |
|---|---|
| Structural validity | **PASS** — all 18 named checks OK, `failed_checks: []` |
| Calibration status | **FAIL** — reported independently of structure |
| mean_overhead_pct | `-1.634636 %` (threshold ≤ 2 %) → OK |
| worst_case_overhead_pct | `72.222177 %` (threshold ≤ 10 %) → **NOT OK** |
| median_deviation_pct | `1.59402 %` (threshold ≤ 2 %) → OK |
| Exit code | 2 (structural PASS, calibration FAIL) |

Because the worst-case pair overhead exceeds the frozen 10 % threshold, the
probe CSV is **not** claimed as calibration PASS. This is consistent with the
Phase 32 report; the hardened validator reproduces the same verdict and is the
first to also confirm full structural integrity under strict parsing (the probe
values are all canonical literals within tolerance). The probe CSV and its
existing metadata were not modified.

## 7. Remaining limitations

- Synthetic fixtures are constructed, not measured; they exercise the
  validator's rejection logic only and must never be cited as benchmark results.
- The strict numeric literal regex is intentionally stricter than Python
  `float()`; a future producer that emits exponent-formatted or signed-zero
  timings could be rejected. The frozen diagnostic emits fixed-`%.11f` values,
  which the parser accepts, so this does not affect real artifacts.
- `worst_case_overhead_pct` on the probe (72 %) is a property of the captured
  data (scheduler noise on ~9 ms operations), not a validator defect; resolving
  it is a measurement-experiment question outside this phase.
- This phase modified no C++, CMake, runner, existing validator, historical CSV,
  stdout, metadata, or prior report; ran no diagnostic executable; collected no
  new measurements; and performed no G7/G7CAM activity, M0/M1 change, or Git
  commit/push/history rewrite.

## 8. Final verification

| Requirement | Status |
|---|---|
| New validator at exact path, Phase 32 & original validators untouched | ✅ |
| Six/eight profiles, 300/400 rows, exact header, frozen formulas & thresholds | ✅ |
| Rejects malformed rows, bad/missing/extra fields, bad keys, duplicates, missing/unexpected keys, wrong per-replicate & total counts | ✅ |
| Numeric parse + finiteness enforced; both timings strictly positive | ✅ |
| Every `signed_overhead_pct` verified against formula with documented tolerance | ✅ |
| Metrics computed only after structural PASS | ✅ |
| Structural vs calibration reported separately | ✅ |
| Structured JSON + clear exit codes; no unhandled traceback | ✅ |
| Row-order contract documented; pairs aligned by key (proved identical metrics) | ✅ |
| All 17 required adversarial categories covered (25 cases) | ✅ |
| Existing probe CSV validated; structural PASS / calibration FAIL recorded independently; file unmodified | ✅ |
| All protected file hashes unchanged | ✅ |
| Git status rechecked; no commit/push/history rewrite | ✅ |

**Final status: `READY FOR NEXT-STEP REVIEW`** — the hardened validator passes
every required adversarial test (25/25, 0 failures, 0 unhandled exceptions).
This phase stops here and does not begin the measurement experiment.
