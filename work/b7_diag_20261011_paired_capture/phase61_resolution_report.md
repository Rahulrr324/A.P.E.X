# Phase 61 — Build, Verify, and Capture (corrected, Phase 62 reconciliation)

## Summary

**Classification: PARTIAL** — the Phase 61 build, CLI matrix, fresh capture, and validation **were performed** and are evidenced by committed artifacts. The prior version of this report incorrectly stated they were not completed (that text was written from a broken working-directory context and is superseded). The gate result itself is: **structural PASS, calibration FAIL** — a structurally valid capture that legitimately fails the frozen calibration thresholds. M0 remains FAIL and M1 remains LOCKED; neither was touched.

Reconciled in Phase 62 against the repository at `git rev-parse HEAD` = `3252eea7c553eab7942d0c53615fe44245cfbc95` (commit `61`, 2026-10-19T18:13:38+05:30; parent `112d9f2a440b37db261a7f9af1c9dacd1fb39e90` = commit `60`). `git status --short` was **empty** at the start of Phase 62 and remained empty through all verification; the only working-tree change made by Phase 62 is this report file.

---

## 1. Starting and Final Git Status

| Item | Value |
|---|---|
| Starting HEAD | `3252eea7c553eab7942d0c53615fe44245cfbc95` (commit `61`) |
| Starting `git status --short` | empty (clean) |
| Final `git status --short` | only this report (`work/b7_diag_20261011_paired_capture/phase61_resolution_report.md`) modified by Phase 62 |
| Commits made | none (no commit, no push) |

Commit `61` (made at the end of the Phase 61 session) contains: the rebuilt executable and object/tlog files, the Phase 61 source edit, `p61cli_default/`, `p61cli_exp50/`, `p61cli_min10/`, `p61host_rel2/` capture CSVs, `phase61_test_b50/paired_samples.csv`, `phase61_test_b50_stdout.txt`, and the (previously incorrect) version of this report.

---

## 2. Source and Executable Hashes

| Artifact | SHA-256 | mtime (+0530) | Size |
|---|---|---|---|
| `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` | `36e5043bcef79e904572b78d197656e13e206e7ac203b5c8a51690ee92b2397f` | 2026-10-19 15:22:59 | 83,885 B (1,764 lines) |
| `stark/build-b7diag-fresh-p39b/Release/bm_b7_diagnostic.exe` | `ce4e57cd935c092eb907cd3c0499b36cff7b253c626b3f2b8fcbfeef2c31f817` | 2026-10-19 15:23:26 | 128,000 B |
| `work/b7_diag_20261011_paired_capture/phase61_test_b50/paired_samples.csv` | `3cefd70ccba9e1fc69a56266f9e007c9ebce7a148158790708e807ef3118205c` | 2026-10-19 16:12 | 12,022 B (301 lines) |

Both the source and the executable are tracked and committed in `61`; the working tree is clean, so the hashes above are the committed content.

---

## 3. Build Evidence

- **Build configuration**: CMake generator `Visual Studio 16 2019` (`stark/build-b7diag-fresh-p39b/CMakeCache.txt`), configuration `Release`, MSVC v142 toolset.
- **Actual compile command** recorded in `bm_b7_diagnostic.tlog/CL.command.1.tlog` (MSBuild tracker log):
  `cl /c /I"E:\MY LOCAL AI\STARK\SRC" /I"E:\MY LOCAL AI\STARK\SRC\PHASE1" /nologo /W1 /WX- /O2 /Ob2 /D NOMINMAX /D NDEBUG /D "CMAKE_INTDIR=\"Release\"" /MD /GS /fp:precise /Zc:wchar_t /Zc:forScope /Zc:inline /std:c++17 ... /TP E:\MY LOCAL AI\STARK\SRC\PHASE1\DIAGNOSTICS\BM_B7_DIAGNOSTIC.CPP` (plus `EXPERIMENTRECORD.CPP`), followed by a link step recorded in `link.command.1.tlog`.
- **Build timing chain**: source mtime 15:22:59 → `bm_b7_diagnostic.obj` written 15:23:25.875 → `CL.*.tlog` 15:23:25–26 → exe written 15:23:26.195 → `bm_b7_diagnostic.lastbuildstate` 15:23:26. The compile of `bm_b7_diagnostic.cpp` therefore demonstrably occurred **after** the Phase 60/61 source edit and produced the executable on disk. The exe was exercised successfully afterward (capture at 16:12, CLI probes at 16:30 and in Phase 62).
- **Limitation (stated explicitly)**: no compiler stdout log and no build exit-code file were preserved for this build. Build success is established from the MSBuild tracker logs, object/exe timestamps, and the executable's subsequent correct behavior — not from a captured build transcript. This provenance gap cannot be reconstructed after the fact.

No rebuild was performed in Phase 62 (not warranted: the committed executable is consistent with the committed source).

---

## 4. CLI Test Matrix (`--measured-iterations`)

Parser contract from source (`bm_b7_diagnostic.cpp` lines 1716–1740): range 10..1000, rejects missing/option-as-value/malformed/duplicate with exit code 2. All probes below were executed in Phase 62 against the committed executable `ce4e57cd…` unless noted.

| Case | Command | Exit | Observed stderr first line |
|---|---|---|---|
| Explicit 50 | `bm_b7_diagnostic.exe … --measured-iterations 50` (Phase 61 session) | capture produced | `p61cli_exp50/paired_samples.csv` = 301 lines (300 rows = 6×50) |
| Documented default | no flag (Phase 61 session) | capture produced | `p61cli_default/paired_samples.csv` = 301 lines |
| Minimum (10) | `--measured-iterations 10` | **0** | full diagnostic ran to completion (no host CSV requested; run dir cleaned up) |
| Minimum capture evidence | Phase 61 session `--measured-iterations 10` | capture produced | `p61cli_min10/paired_samples.csv` = 61 lines (60 rows = 6×10) |
| Maximum (1000) — parse acceptance | `--measured-iterations 1000 --batch-size 0` | 2 | `error: batch-size out of range` (i.e. 1000 was **accepted**; error is from the next flag) |
| Maximum (1000) — parse acceptance (2nd probe) | `--measured-iterations 1000 --batch-size 1 --measured-iterations 500` | 2 | `error: duplicate --measured-iterations` (1000 accepted before duplicate check) |
| Below minimum | `--measured-iterations 9` | 2 | `error: --measured-iterations out of range (10..1000)` |
| Below minimum (0) | `--measured-iterations 0` | 2 | `error: --measured-iterations out of range (10..1000)` |
| Above maximum | `--measured-iterations 1000`… `1001` | 2 | `error: --measured-iterations out of range (10..1000)` |
| Missing value | `--measured-iterations` (last arg) | 2 | `error: --measured-iterations requires a value` |
| Option as value | `--measured-iterations --batch-size` | 2 | `error: --measured-iterations requires a non-option value` |
| Malformed value | `--measured-iterations abc` | 2 | `error: --measured-iterations invalid value` (`invalid --measured-iterations value`) |
| Duplicate option | `--measured-iterations 50 --measured-iterations 50` | 2 | `error: duplicate --measured-iterations` |

**Limitation**: a full run at the maximum (1000 iterations × 6 replicates × 2 conditions ≈ 88+ minutes of timed samples) was **not** executed; max-value acceptance is verified at the parse level only (two independent probes prove 1000 passes range validation while 1001 does not). Host-capture-dir behavior is evidenced by `p61host_rel2/paired_samples.csv` (301 lines) from the Phase 61 session. No CLI defect was found; no fix or rebuild was needed.

---

## 5. Fresh Capture Provenance

| Field | Value |
|---|---|
| Capture path | `work/b7_diag_20261011_paired_capture/phase61_test_b50/paired_samples.csv` (unique directory, created 2026-10-19 16:12, previously unused) |
| CSV SHA-256 | `3cefd70ccba9e1fc69a56266f9e007c9ebce7a148158790708e807ef3118205c` |
| Line count | 301 = 1 header + 300 data rows |
| Protocol (from `phase61_test_b50_stdout.txt`) | `warmup=30 (untimed), measured=50, macro_replicates_per_condition=6`, `measurement_mode=INTERLEAVED batch_size=50` |
| Measured iterations | 50 (matches `kMeasuredIterations = 50` in the committed source) |
| Batch size | 50 — chosen from Phase 56/57 evidence: batch-50 was the best-performing historical configuration (0.43% / 12.94% / 0.23%) versus batch-100 (3.07% / 54.67% / 3.82%); not selected to force a pass |
| Stdout | `work/b7_diag_20261011_paired_capture/phase61_test_b50_stdout.txt` (4,856 B, same mtime) |
| Diagnostic's own verdict (stdout) | `status: FAIL … mean worst-case median-deviation`; `classification: INCONCLUSIVE` |

**Provenance limitation (distinct from structural validity)**: unlike Phase 49's `r01` (which saved `argv.txt` and `exec_sha256_before.txt`), the Phase 61 capture directory contains **only** the CSV — the exact command line and the executable hash *at capture time* were not recorded alongside it. The linkage between the committed exe and this capture rests on: exe built 15:23, capture written 16:12 with no later rebuild (exe mtime unchanged), stdout protocol (`warmup=30, measured=50, batch_size=50`) exactly matching the constants in the committed source, and both being committed together in `61`. This is strong circumstantial provenance, not a recorded hash-at-run. It cannot be strengthened retroactively; it does not affect the CSV's structural validity, which is verified directly below.

---

## 6. Validator Output and Independent Recomputation

The Phase 33 validator (`work/b7_diag_20261011_paired_capture/phase33_paired_csv_validator.py`, unchanged — sha256 unchanged since Phase 33, 17,784 B, mtime Oct 17) was executed in Phase 62 because the Phase 61 session did not save its output:

```bash
cd "/e/My Local AI" && python work/b7_diag_20261011_paired_capture/phase33_paired_csv_validator.py \
  --csv work/b7_diag_20261011_paired_capture/phase61_test_b50/paired_samples.csv --profile six
```

**Actual exit code: 2** (validator semantics: 0 = structural + calibration PASS; 1 = structural FAIL; 2 = structural PASS + calibration FAIL; 3 = fatal).

**Structural validation — PASS** (`"structural_pass": true`, `"failed_checks": []`, all 20 checks `ok: true`):
- 301 lines = header + 300 data rows; exact header `replicate,iteration,minimal_sec,instrumented_sec,signed_overhead_pct`; 5 fields per row
- 300 unique canonical `(replicate, iteration)` keys, exact set = {0..5} × {0..49}, none missing/extra/out of range, none duplicated
- per-replicate counts all 6×50; all numerics finite; `minimal_sec` and `instrumented_sec` all positive
- per-row formula: 0 mismatches against `100*(instr-min)/min` (tolerance `1e-6 * max(1, |recorded|)`)

**Calibration — FAIL** (frozen thresholds, unmodified):

| Metric | Validator | Independent recompute (Phase 62, `statistics` module) | Threshold | Result |
|---|---|---|---|---|
| Mean overhead `100*(mean_i−mean_m)/mean_m` | **5.796377%** | **5.796377%** | ≤ 2% | FAIL |
| Worst signed aligned-pair overhead `max 100*(i−m)/m` | **15.812366%** | **15.812366%** | ≤ 10% | FAIL |
| Median deviation `100*|med_i−med_m|/med_m` | **5.667681%** | **5.667681%** | ≤ 2% | FAIL |

The transcript values (5.796377 / 15.812366 / 5.667681) are confirmed against the actual CSV to all six decimals. Supporting metrics from the validator: `n_pairs=300`, `mean_minimal=0.419035215667 s`, `mean_instrumented=0.443324078333 s`, `median_minimal=0.42064115 s`, `median_instrumented=0.44448175 s`, `min_pair_overhead=-7.022763%`, `count_pairs_over_10pct=14`. The diagnostic's own stdout (5.7964 / 15.8124 / 5.6677, rounded to 4 dp) agrees with both computations. No outliers were clipped, filtered, or discarded.

**Gate conclusion**: structural PASS does not imply calibration PASS — this capture is structurally valid and fails calibration on all three frozen thresholds. M0 stays FAIL; M1 stays LOCKED. No validator, formula, threshold, or historical evidence was modified.

---

## 7. Batch-100 Discrepancy Resolution

The Phase 60 report claimed the batch-100 CSV recompute "matches" its `run.txt` with "small differences due to median computation method." **That claim is not supported by the data** and is corrected here.

| Source | mean | worst signed pair | median dev |
|---|---|---|---|
| `phase56_test_b100/paired_samples.csv` recompute (Phase 62, exit 0) | 3.068743% | 54.674837% | 3.824495% |
| `phase56_test_b100/run.txt` calibration lines | 3.1126% | 50.7066% | 3.5242% |
| `phase56_test_b50` CSV recompute | 0.431750% | 12.941623% | 0.226086% |
| `phase56_test_b50/run.txt` | 0.4317% | 12.9416% | 0.2261% |

Findings, from the actual data:
1. **batch-50 is internally consistent**: its CSV recompute matches its `run.txt` to displayed precision, and both files share mtime 11:21:16 (14 ms apart) — they are one run. This independently confirms the frozen formulas and the diagnostic's `calibrate()` implementation.
2. **batch-100's `run.txt` is internally self-consistent**: recomputing from `run.txt`'s own pooled statistics reproduces its printed calibration exactly (pooled means → 3.1126%; pooled medians → 3.5242%). The `calibrate()` code is not arithmetically wrong.
3. **batch-100's `run.txt` and CSV are from different executions**:
   - Pooled `minimal` statistics disagree: `run.txt` mean 1,385,761.728 µs / median 1,511,648.050 µs vs. CSV mean 1,502,643.484 µs / median 1,620,557.700 µs. Per-replicate medians disagree wholesale (e.g. replicate 0 minimal: `run.txt` 1,668,983.150 µs vs. CSV 1,037,223.950 µs; replicate 2: 923,968.650 vs. 1,776,594.450 µs). These are different data, not a rounding/method artifact — a median method cannot move a worst-case by 4 percentage points (50.71 vs 54.67).
   - mtimes: CSV 13:29:49, `run.txt` 13:38:04 — written 8 minutes apart (compare batch-50's 14 ms).
   - A sweep of **all 45** `paired_samples.csv` files in the repository found **no CSV** whose pooled minimal statistics match this `run.txt` — the paired CSV of the run that produced the `run.txt` was never persisted (or was lost); conversely the CSV's own run has no surviving `run.txt`.

**Conclusion**: the batch-100 discrepancy is an **artifact-pairing mismatch** (a later `run.txt` sits beside an earlier CSV), not a defect in the formulas, validator, or CSV. Each artifact is individually self-consistent; they simply document different runs. Consequences: (a) no formula fix is indicated — batch-50 proves the pipeline correct; (b) calibration figures for the batch-100 CSV must be taken from the CSV (3.068743 / 54.674837 / 3.824495), never from the adjacent `run.txt`; (c) the batch-100 directory cannot serve as a matched run record, and that limitation is now documented rather than open.

---

## 8. Changed-File Inventory and Diff Review

Phase 61 changes (committed in `61`; nothing else was modified then or now):

| File | Change |
|---|---|
| `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` | +10/−5 lines vs commit `60`: `kMeasuredIterations` 60 → 50, `--measured-iterations` CLI option (parse/range/duplicate guards, usage text), residual call-site arithmetic reviewed in Phase 60 |
| `stark/build-b7diag-fresh-p39b/…` | rebuilt `bm_b7_diagnostic.exe` (108,544 → 128,000 B), `bm_b7_diagnostic.obj`, MSBuild tlogs |
| `stark/p61cli_default/`, `stark/p61cli_exp50/`, `stark/p61cli_min10/`, `stark/p61host_rel2/` | CLI-matrix capture CSVs (301/301/61/301 lines) |
| `work/…/phase61_test_b50/`, `phase61_test_b50_stdout.txt` | the fresh capture and its stdout |
| `stark/work/verify_discrepancy.py`, `stark/work/verify_batch100_discrepancy.py` | Phase 60/61 discrepancy probe scripts (committed) |
| `work/…/phase61_resolution_report.md` | this report (rewritten in Phase 62) |

Phase 62 modified **only** this report. The Phase 33 validator, frozen formulas/thresholds, historical reports, captures, build artifacts, and diagnostic source were not touched. No G7/G7CAM records, no campaigns, no M0/M1 status edits, no commits, no pushes.

---

## 9. Verified vs. Unverified, Blockers, Classification

### Verified (this phase, with actual results)
- Git state (clean at `3252eea`), source/exe/CSV hashes (§2)
- Build occurred from the current source, with toolchain and compile command evidenced by MSBuild tracker logs (§3)
- Full CLI matrix behavior and exit codes against the committed executable (§4)
- Fresh capture: unique directory, 301 lines, six replicates × 50 measured iterations, batch 50 (§5)
- Phase 33 validator run: **exit 2**, structural PASS (all 20 checks), calibration FAIL (5.796377 / 15.812366 / 5.667681), independently recomputed to identical values (§6)
- Batch-100 discrepancy resolved as run.txt/CSV pairing mismatch; formulas exonerated by batch-50 consistency (§7)

### Unverified / limitations (cannot be reconstructed)
- Build stdout and build exit code were never captured for the Phase 61 build (§3)
- Capture-time command line and executable hash were not saved with the capture; linkage is circumstantial-timestamp-based (§5)
- Full maximum-value (1000) run not executed — parse-level acceptance only (§4)
- The Phase 61 session's own validator invocation output was not saved; Phase 62 re-ran the unchanged validator on the unchanged CSV instead (§6)

### Remaining blocker
**Calibration FAIL**: instrumentation overhead is 5.80% mean (≤2% required), 15.81% worst signed pair (≤10%), 5.67% median deviation (≤2%) — 14 of 300 pairs exceed 10%. This is a measurement result, not a work-item failure: the gate is genuinely unsatisfied, so M0 stays FAIL and M1 stays LOCKED.

### Next meaningful engineering step
Close the ~486 µs/op gap between conditions (per batch of 50: 443,324 µs − 419,035 µs = 24,289 µs). The instrumented component decomposition accounts for only ~80 µs/op of residual (clock reads + stream teardown), so most of the delta is the instrumented **read path** itself running slower than the minimal read path — i.e. timer-call perturbation, not the timers' direct cost. The next step is to instrument-count the clock reads in `instrumented_op_batch()` (e.g. collapse per-operation component timers to per-batch accumulation) and re-capture at batch 50 with the same unchanged validator. Batch size should not be changed to chase a pass.

### Final classification: **PARTIAL**
All Phase 61 deliverables (build, CLI verification, fresh isolated capture, independent validation, discrepancy resolution) are now evidenced and reconciled; the phase's own acceptance gate — calibration PASS — is not met, and two pieces of provenance (build log, capture-time hash) were never recorded and cannot be recovered.

---

*Corrected in Phase 62 (Evidence Reconciliation). Supersedes the prior version of this report, which incorrectly classified the build, capture, and validation as not performed.*
