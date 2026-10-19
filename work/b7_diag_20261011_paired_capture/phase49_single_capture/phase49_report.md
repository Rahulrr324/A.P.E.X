# Phase 49 — Single Metadata-Complete B7 Capture (r01)

**Mode:** evidence capture, exactly one diagnostic invocation, no build, no source changes.
**Run id:** `phase49_single_capture/r01`
**Capture time (UTC):** `2026-10-19T02:31:22.862380Z`
**Verification status:** full capture completed successfully.

---

## 1. Preflight checks and hashes

Read the Phase 48 design ([phase48_experiment_design.md](work/b7d69b4f7e47d76e9306d40fa6c106e1/../../work/b7_diag_20261011_paired_capture/phase48_experiment_design.md)), the diagnostic source, and the validator before launching.

| Artifact | Path (relative to repo root) | Frozen hash | Actual hash | Match |
|---|---|---|---|---|
| Executable | `stark/build-b7diag-fresh-p39b/Release/bm_b7_diagnostic.exe` | `f50fda5a3486fa7d3225869d978a841c2d1fa10f92413530b1cda067b1000147` | `f50fda5a3486fa7d3225869d978a841c2d1fa10f92413530b1cda067b1000147` | ✅ |
| Source | `stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp` | `aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b` | `aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b` | ✅ |
| CMake | `stark/CMakeLists.txt` | `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8` | `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8` | ✅ |
| Validator | `work/.../phase33_paired_csv_validator.py` | `9f6d6c29a1b1c1e59ddec1fa4ad4b6499cb2b2f8c692e421bf94c10fc6a1e8e6` | `9f6d6c29a1b1c1e59ddec1fa4ad4b6499cb2b2f8c692e421bf94c10fc6a1e8e6` | ✅ |
| Historical Phase 36 CSV | `work/.../phase35_readpath_experiment/pr35r1/paired_samples.csv` | `a09a0d3c37168dc88ecce79013d6e523c5aa2d101c726bb1ad0edadc0e89706d` | `a09a0d3c37168dc88ecce79013d6e523c5aa2d101c726bb1ad0edadc0e89706d` | ✅ |

**No preflight failure. All frozen hashes match; nothing was rebuilt.**

---

## 2. Output isolation

- Parent: `work/b7_diag_20261011_paired_capture/phase49_single_capture/` (created)
- Run dir: `work/b7_diag_20261011_paired_capture/phase49_single_capture/r01/` (created, then confirmed **empty** before launch)
- The diagnostic's own run-owned storage went under `build/bm_b7_diagnostic/run_17923770831797030_0/` and was cleaned up by the diagnostic itself (blob removed, empty run dir removed) as its normal protocol.
- Previous phase artifacts were not modified, moved, or cleaned.

---

## 3. Provenance recorded (pre-launch artifacts persisted inside r01)

| File | Content |
|---|---|
| `argv.txt` | Full command line, one argument per line: exe path, `build/bm_b7_diagnostic`, `--host-capture-dir`, `work/b7_diag_20261011_paired_capture/phase49_single_capture/r01` |
| `cwd.txt` | `E:\My Local AI` |
| `launch_ts.txt` | `launch_local=2026-10-19T08:01:22+0530`, `launch_utc=2026-10-19T02:31:22.862380+00:00`, `monotonic_before_launch=125218.1246803` |
| `exec_sha256_before.txt` | `f50fda5a...0147` (computed live before spawn) |
| `source_rev.txt` | HEAD `36e8c954eed850471b530c90062d6ff883386308`; working tree clean except untracked `stark/nul` and this phase's own `work/.../phase49_single_capture/` |
| `build_config.txt` | VS 16 2019 generator, Release config, exe path/bytes (108544), no rebuild |
| `system_state.txt` | Windows 11 10.0.26300 SP0, AMD64, Intel 6/154/3, 12 logical CPUs, power scheme `dfe97760-...` Performance Mode; wmic unavailable; affinity/cache not controlled — recorded as observed |
| `condition_order.json` | Filled post-run from actual stdout: replicate 0,2,4 MINIMAL-first; 1,3,5 INSTRUMENTED-first (counterbalanced) |

**Provenance completeness:** all requested pre-launch artifacts were persisted. No field was fabricated; where a datum was not observable (wmic CPU, compiler version without rebuild), it is marked explicitly as unavailable/limitation.

---

## 4. Exact invocation and execution

- Command line: `E:\My Local AI\stark\build-b7diag-fresh-p39b\Release\bm_b7_diagnostic.exe build/bm_b7_diagnostic --host-capture-dir work/b7_diag_20261011_paired_capture/phase49_single_capture/r01`
- cwd: `E:\My Local AI`
- Launcher: `work/b7_diag_20261011_paired_capture/phase49_single_capture/launch_r01.py` (subprocess, shell=False, preserves real exit code)
- Invocations: exactly **one** (child pid 4112). No retry, no second launch.
- Process exit code: **0** (run completed with sufficient replication; classification INCONCLUSIVE — a finding, not a process failure)
- stdout/stderr: `stdout.txt` (report, 344-ish lines incl. calibration), `stderr.txt` (empty)
- `exec_sha256_after.txt` = `f50fda5a...0147` — executable unchanged after run.

---

## 5. Persistence and integrity

- `paired_samples.csv` present in `r01` (13,255 bytes, 301 lines / 300 data rows).
- CSV SHA-256 saved in `csv_sha256.txt` and `exec_meta.json`: `5dc78fc5b1b82fdd7c5a52eb21d90572f89acb3c345ce37bfe50537dd208618b`
- Frozen Phase 33 validator run with `--profile six`:
  - complete output saved to `validation.json`
  - exit code saved to `validation_exit.txt` = `validator_exit=2` (structural PASS, calibration FAIL)
  - `validation_stderr.txt` empty
- `hashes.txt` records SHA-256 of every artifact in `r01` (full list below).

---

## 6. Frozen calibration metrics (independent recomputation)

| Metric | Threshold | Value | | |
|---|---|---|---|---|
| Mean overhead | ≤ 2% | **−0.154504%** | OK (PASS) | |
| Worst signed paired overhead | ≤ 10% | **88.582956%** | NOT OK (FAIL) | |
| Median deviation | ≤ 2% | **0.869475%** | OK (PASS) | |

**Verdict: FAIL** — all three metrics computable, worst-case threshold exceeded. (Independent recomputation matches validator: −0.154504 / 88.582956 / 0.869475.)

*Same values in the diagnostic's stdout report: mean −0.1545%, worst 88.5830%, median-dev 0.8695%, status FAIL.*

---

## 7. Supplementary analysis (structurally valid 300 pairs)

- Tail counts: above **+10%** = 46, below **−10%** = 55, |overhead| > 10% = **101 of 300 (33.7%)**.
- Signed overhead percentiles: min **−40.802%**, p50 **0.652%**, p90 **15.616%**, p95 **32.986%**, p99 **52.280%**, max **88.583%**.
- **Largest positive ratio:** replicate 2, iteration 36 — minimal `0.0090216 s`, instrumented `0.0170132 s`, `+88.583%`, abs diff `0.0079916 s` (largest abs diff in the whole data set).
- **Largest negative ratio:** replicate 0, iteration 31 — minimal `0.0158919 s` (a high minimal; near the run max), instrumented `0.0094077 s`, `−40.802%`, abs diff `0.0064842 s`.
- **Abs diff alongside %:** largest abs diff (replicate 2 iteration 36) coincides with the largest positive ratio; the largest negative ratio (rep0 iter31) has the minimal value that is one of the largest (0.0158919 s).
- **Small-minimal vs large-positive ratio:** Pearson r = **−0.591** between `minimal_sec` and `signed_overhead_pct`; among pairs > +10%, mean minimal (0.009361 s) is slightly below the all-pairs mean (0.009680 s); per minimal-quartile, mean overhead is +6.5%/+6.4%/+4.5% in the three lower quartiles and **−14.2%** in the highest quartile. Big positive ratios are more common when the minimal denominator is not large; and negative ratios dominate the largest-minimal bin (mirror: huge minimal + normal instrumented → negative %).
- Per-replicate mean overhead: rep0 −10.404%, rep1 +5.417%, rep2 +6.105%, rep3 −2.623%, rep4 −3.326%, rep5 +5.501%. The worst positive ratio and largest abs diff are on replicate 2 again (consistent with Phase 45/47 pattern, but a single-run observation).

---

## 8. Missing metadata, warnings, limitations

- Single execution only: no claim about timing drift, order effects, or instrumentation causation. The within-run counterbalanced schedule is recorded but the CSV itself is a paired table, and one run cannot establish repeatability.
- Affinity not controlled; warm-cache only; process-local sequential macro-replicates — documented differences vs the historical campaign, recorded, not claimed controlled.
- wmic CPU detail unavailable; compiler version not re-derived without a rebuild.
- This capture is a **fresh** executable (Phase 45 binary), not the historical Phase 36 binary — no claim of historical equivalence.
- Calibration FAIL here is a legitimate experimental result (worst-case signed paired overhead 88.58% ≫ 10%), not a persistence failure and not cause for a rerun.

---

## 9. Files created

Files created under `work/b7_diag_20261011_paired_capture/phase49_single_capture/`:
- `launch_r01.py` (launcher)
- `r01/argv.txt`, `r01/cwd.txt`, `r01/launch_ts.txt`, `r01/exec_sha256_before.txt`, `r01/exec_sha256_after.txt`, `r01/source_rev.txt`, `r01/build_config.txt`, `r01/system_state.txt`, `r01/condition_order.json`, `r01/stdout.txt`, `r01/stderr.txt`, `r01/exitcode.txt`, `r01/paired_samples.csv`, `r01/csv_sha256.txt`, `r01/validation.json`, `r01/validation_exit.txt`, `r01/validation_stderr.txt`, `r01/hashes.txt`, `r01/exec_meta.json` — **19 files** (full SHA-256 list in `r01/hashes.txt`).

---

## 10. Completion confirmation

**The capture completed successfully**: preflight passed, exactly one invocation ran, all provenance artifacts were persisted, the CSV exists and is structurally valid, and the frozen validator ran to completion. The calibration result is **FAIL** (worst-case overhead well above the 10% threshold) — a measured result, preservation intact, no retry.

**Report SHA-256:** computed in section C of the final response.

**Guardrails preserved:** no source/CMake/validator/threshold/historical edits; no build or rebuild; exactly one invocation; no retries/overwrites; no deletion/cleanup/move/rename of prior artifacts; no commit/push; M0 = FAIL and M1 = LOCKED unchanged.
