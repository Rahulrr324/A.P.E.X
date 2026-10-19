# Phase 54 — B7 Calibration Root-Cause Resolution and Verified Fix

**Status:** UNRESOLVED (within hard constraints)  
**Time budget:** ~60 minutes (utilized)  
**Date:** 2026-10-19

## 1. Initial state and protected-artifact verification

### Protected artifacts (hashes verified unchanged)
- Source `bm_b7_diagnostic.cpp`: `aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b` ✓
- CMake `CMakeLists.txt`: `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8` ✓  
- Validator `phase33_paired_csv_validator.py`: `9f6d6c29a1b1c1e59ddec1fa4ad4b6499cb2b2f8c692e421bf94c10fc6a1e8e6` ✓
- Frozen executable: `f50fda5a3486fa7d3225869d978a841c2d1fa10f92413530b1cda067b1000147` ✓ (at `stark/build-b7diag-fresh-p39b/Release/bm_b7_diagnostic.exe`)
- Historical Phase 36 CSV: `a09a0d3c37168dc88ecce79013d6e523c5aa2d101c726bb1ad0edadc0e89706d` ✓

All six input CSVs from previous phases (p44r1–p44r5, p49r01) re-verified unchanged by prior phase checks. No modifications to protected artifacts.

### Baseline (from existing evidence)
- All six captures structurally valid; all FAIL frozen calibration gate.
- Frozen criteria (unchanged): mean |overhead| ≤ 2%, worst signed paired overhead ≤ 10%, median deviation ≤ 2%; PASS only if all three pass.
- Phase 52: extreme worst-pair ratios compatible with noise-only nulls under tested models; does not resolve mean/median failures.
- Phase 53: strong within-run temporal drift (common-mode) identified; condition-position analysis inconclusive; drift-robust DID null.

### Environment
- Repository: `E:/My Local AI`
- Git status: working tree clean relative to HEAD (no uncommitted changes to tracked files)
- Build dirs present with multiple executables (MinGW, VS2019 builds); frozen exe confirmed present.

## 2. Root causes confirmed

Based on inspection of the implementation and existing evidence:

**Root Cause 1: Ratio amplification from small denominators combined with measurement noise.** The worst-case paired overhead is `max_j (100*(inst_{i,j} - min_{i,j}) / min_{i,j})`. When minimal timings are small (e.g. ~9–15ms), even modest absolute differences (hundreds of µs to ms) produce large percentage ratios (>200% in historical data). The paired comparison by iteration index across temporally separated blocks exacerbates this effect.

**Root Cause 2: Temporal drift between paired blocks within each replicate.** As implemented, each replicate runs: (10 warmup + 50 measured) of condition A, then (10 warmup + 50 measured) of condition B (or vice versa per counterbalancing). The "pairing" in the CSV/calibration is by iteration index j within each block (minimal[i].total_samples_sec[j] paired with instrumented[i].total_samples_sec[j]). These are separated by ~100ms+ of the other condition's work plus overhead. Phase 53 demonstrated strong within-run drift (session A slows 24–74%, session B speeds ~9%) — this drift occurs across time and contaminates iteration-index-based pairing, producing large artificial differences for some pairs.

**Root Cause 3: Measurement methodology couples order/duration with pairing.** The current design trades off drift control against counterbalancing. While counterbalancing addresses order bias in aggregate, the per-pair worst-case statistic is highly sensitive to drift between the two sequential blocks within a replicate. This is a design trade-off in the implementation; the frozen thresholds (worst ≤ 10%) are strict relative to this methodology.

These causes are consistent with all prior analyses (Phases 46–53). No other actionable defect was identified in the implementation logic (timing boundaries, calibration computation, pairing logic match the documented formulas).

## 3. Hypotheses tested / rejected

- **Hypothesis: Environmental noise (OS scheduling, CPU throttling)** — tested by running multiple captures and checking different executables; results remained consistent (worst-case ~120% across runs). No improvement sufficient to satisfy worst ≤ 10%. (Not excludable as contributor, but not the sole fixable cause.)
- **Hypothesis: Different compiler/build might reduce variance** — tested frozen exe (f50fda5a, VS2019 build context) and vs2019 Release build (86ee9f3e); both produce similar failing calibration (worst-case ~121%, mean sometimes passes boundary). No material improvement.
- **Hypothesis: Process priority/affinity** — attempted conceptually (would require system control beyond tool constraints in this environment); not practically actionable within the tool set. Even so, the methodology issue remains.

No hypotheses were supported by evidence as leading to a consistent fix satisfying all three frozen criteria.

## 4. Implementation attempts

No source/CMake/validator modifications were made (all are hash-protected per hard constraints: "Do not modify source, CMake, validator, historical CSVs, thresholds, formulas, or frozen evidence").

New diagnostic captures were executed with the frozen executable to characterize current behavior under Phase 54:

**Test 1 (single run, frozen exe f50fda5a):**
- mean_overhead_pct = 2.8480% (> 2% FAIL)
- worst_case_overhead_pct = 127.0191% (> 10% FAIL)  
- median_deviation_pct = 0.0581% (≤ 2% PASS)
- Status: FAIL (mean + worst fail)

**Test 2 (single run):**
- mean_overhead_pct = -2.8837% (> 2% in magnitude FAIL)
- worst_case_overhead_pct = 122.7343% (> 10% FAIL)
- median_deviation_pct = 3.5322% (> 2% FAIL)
- Status: FAIL

**Test 3 (3 repeated runs, frozen exe):**
1. mean=-1.4938% (PASS), worst=121.6889% (FAIL), median=0.6605% (PASS) — FAIL overall
2. mean=2.7044% (FAIL), worst=120.0767% (FAIL), median=1.7487% (PASS) — FAIL overall
3. mean=-3.3055% (FAIL in magnitude), worst=127.7425% (FAIL), median=0.7886% (PASS) — FAIL overall

**Test 4 (vs2019 build exe 86ee9f3e):**
- mean_overhead_pct = -0.6625% (PASS)
- worst_case_overhead_pct = 121.0220% (FAIL)
- median_deviation_pct = 1.0074% (PASS)
- Status: FAIL overall

All attempts confirm the worst-case paired overhead consistently violates the ≤ 10% threshold by a large margin (factor ~12×). Mean and median occasionally approach threshold but do not consistently satisfy all three simultaneously; worst-case never satisfies the frozen criterion.

## 5. Before/after metrics

No code changes were made (by constraint). All runs used the same implementation. Comparative metrics shown above demonstrate no improvement - behavior is consistent with historical captures (Phases 46–47).

## 6. Frozen-gate verdict

**Per-run verdict (current test runs):** All runs FAIL on worst-case; some also fail on mean/median. No run achieved PASS on all three frozen criteria.

**Overall status:** UNRESOLVED. The frozen calibration gate is not satisfied.

## 7. Reproduction commands

Reproduce with frozen executable:
```bash
cd "E:/My Local AI"
mkdir -p work/b7_diag_20261011_paired_capture/phase54_test
./stark/build-b7diag-fresh-p39b/Release/bm_b7_diagnostic.exe \
  --host-capture-dir work/b7_diag_20261011_paired_capture/phase54_test \
  > work/b7_diag_20261011_paired_capture/phase54_test/out.txt 2>&1
grep -B2 -A10 "calibration" work/b7_diag_20261011_paired_capture/phase54_test/out.txt
```

## 8. Regression checks

- Protected artifacts unchanged (hashes verified). ✓
- Historical CSVs unchanged. ✓
- No modifications to frozen evidence. ✓
- No commits/pushes; no G7/G7CAM; M0 remains FAIL, M1 remains LOCKED. ✓

## 9. Remaining limitations and next concrete action

**Limitations:**
1. The core defect (ratio amplification under small denominators + drift between sequential blocks) is embedded in the current measurement protocol as implemented. Without modifying the source code (forbidden by hard constraint "Do not modify source..."), the worst-case statistic cannot be made to satisfy ≤ 10% consistently given the observed timing characteristics.
2. The frozen thresholds (especially worst ≤ 10%) are strict relative to the block-wise iteration-pairing methodology when combined with natural timing variance and drift. The Phase 53/52 analyses suggest the extreme ratios are compatible with noise under certain null models, but the frozen calibration gate as written still fails.
3. Environmental tuning (affinity/priority/quiescence) was not fully exploitable within tool constraints and did not yield sufficient improvement in the worst-case metric.

**Single best next step (if constraints relaxed):**
Modify the measurement protocol in `bm_b7_diagnostic.cpp` to reduce temporal separation between paired measurements. Specifically: (a) interleave conditions within each replicate (e.g. MINIMAL, INSTR, MINIMAL, INSTR, ... with per-pair or minimal warmup) so pairs are temporally adjacent, minimizing drift contamination; or (b) run both conditions in the same tight measurement window with better synchronization. This directly addresses Root Cause 2 without weakening frozen formulas/thresholds/validator semantics. The pairing logic would need to be adjusted to match the new protocol, but the CSV schema and calibration formulas themselves remain unchanged.

**Conclusion (per Phase 54 success criteria):** **UNRESOLVED**. A defensible code fix exists conceptually (protocol redesign to interleave conditions), but implementing it requires modifying the frozen-source-protected implementation (`bm_b7_diagnostic.cpp`) which violates the stated hard constraint "Do not modify source, CMake, validator, historical CSVs, thresholds, formulas, or frozen evidence." Within those constraints, no actionable fix was found that consistently satisfies all three frozen calibration criteria. All evidence is preserved.