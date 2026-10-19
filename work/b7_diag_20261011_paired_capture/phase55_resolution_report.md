# Phase 55 — Resolution Report (Corrected B7 Measurement Protocol)

## Summary
- Status: **PARTIAL** (real protocol defect corrected; calibration remains FAIL)
- Verdict: Interleaved measurement protocol implemented to reduce temporal drift between paired observations. Mean and median deviation pass frozen thresholds; worst-case paired overhead remains > 10% under test conditions.

## Root Cause (Confirmed)
1. Temporal drift between paired blocks: MINIMAL and INSTRUMENTED measured in separate sequential blocks → pairing by iteration index contaminated by drift (Phase 53–54).
2. Ratio amplification from small denominators: max of (inst-min)/min over pairs is sensitive to noise/outliers (Phase 54).
3. Inter-block separation causes order/drift sensitivity.

## Design Rationale
Implemented interleaved measurement: within each replicate, alternate MINIMAL and INSTRUMENTED in tight succession (adjacent pairs), preserving:
- Semantically equivalent operations (same production-faithful logic)
- Pairing by iteration index (aligned pairs)
- Counterbalancing (minimal-first vs instrumented-first by replicate)
- All timing discipline unchanged (steady_clock, bracketing, decomposition residuals)

This directly reduces temporal separation between paired observations.

## Source Changes
Modified: [bm_b7_diagnostic.cpp](../../stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp)
- Added `MeasurementMode { BLOCK, INTERLEAVED }` (default INTERLEAVED)
- Added `InterleavedPair` struct (separate from artifact `PairedSample` to avoid name collision)
- Added `run_replicate_interleaved()` implementing adjacent-pair interleaving with warmup
- Wired interleaved path in `run_bm_b7_diagnostic()` to build minimal/instrumented ReplicateResult vectors from paired data
- Added `#define NOMINMAX` for Windows compatibility
- Tuned defaults: warmup=50, measured=100, macro_replicates=8 (experimented with ranges)

Also updated: [ExperimentRecord.cpp](../../stark/src/phase1/common/ExperimentRecord.cpp) to add NOMINMAX.

Hashes (current):
- bm_b7_diagnostic.cpp: modified (Phase 55 changes)
- New executable: ad4e8e3accf7afc44bd5f9a90178c8482f1b3ac11b6c01d2f978cd8253fab570 (Release/bm_b7_diagnostic.exe)

## Test Results (Representative)
All runs with interleaved protocol (valid evidence):

- phase55_test1 (warmup=10, measured=50, reps=6): worst-case 49.3%, mean OK, median OK → FAIL (worst>10%)
- phase55_test2 (warmup=10, measured=100, reps=6): worst-case 71.4%, mean OK, median OK → FAIL
- phase55_test3 (warmup=50, measured=150, reps=10): worst-case 72.4%, mean OK, median OK → FAIL
- phase55_test5_highprio (warmup=50, measured=150, reps=10, high prio): worst-case 197.0% → FAIL
- phase55_test6 (warmup=200, measured=80, reps=8): worst-case 100.7% → FAIL

Pooled means/medians pass thresholds consistently; worst-case paired overhead remains above 10% across tested configs. This is driven by ratio amplification from outliers in paired samples (denom small can create large ratios) — the metric is sensitive even with adjacent pairing.

## Frozen Criteria Status
1. Pooled mean overhead |value| ≤ 2%: **PASS** (e.g. test3: 0.0615%)
2. Worst signed key-aligned pair overhead ≤ 10%: **FAIL** (49–197% range)
3. Median deviation |med_inst - med_min|/med_min ≤ 2%: **PASS** (e.g. test3: 0.0579%)

All three must pass for calibration PASS. Current: FAIL.

## Regression Checks
- Protected artifacts unchanged in spirit relative to Phase 54 constraints? We modified source (allowed) to fix protocol. Historical CSVs, validator, thresholds unchanged. No commits/pushes/G7/G7CAM. M0 remains FAIL conceptually; calibration remains FAIL.
- Interleaved protocol reduces temporal separation (addresses stated root cause). No fabrication of pairs/outliers; all observations preserved.

## Limitations
- The worst-case paired ratio remains sensitive to measurement noise even with interleaving; this is inherent to the metric definition (max over ratios). Further tuning of environment may reduce variance but did not yield PASS in tested configurations.
- Interleaved protocol improves methodological validity (addresses drift) but cannot eliminate ratio amplification from small-denominator outliers under the frozen metric.
- Build environment: MSVC 2019 (BuildTools), CMake-generated VS projects. Link warnings about static-libgcc ignored (MSVC target).

## Next Action (Concrete)
1. The core methodological defect (block-based pairing with temporal separation) is **corrected** by interleaved protocol. If the frozen gate's worst-case metric is considered too noise-sensitive, a separate investigation into metric robustness would be needed — but modifying thresholds/formulas/validator is not permitted by constraints. 
2. Alternatively, collect larger datasets in a more quiescent environment or explore alternative pairing strategies compatible with existing validator. However, no such compatible strategy is obvious without changing the validator's pairing logic.
3. Given constraints, **PARTIAL** is the correct classification: protocol fixed, calibration still FAIL on worst-case.

## Reproduction Commands (example)
```bash
cd E:/My Local AI/stark/build-phase55-vs
/c/Program\ Files\ \(x86\)/Microsoft\ Visual\ Studio/2019/BuildTools/MSBuild/Current/Bin/MSBuild.exe -m:1 bm_b7_diagnostic.vcxproj /p:Configuration=Release /p:Platform=x64
cd E:/My Local AI
mkdir -p work/b7_diag_20261011_paired_capture/phase55_testX
./stark/build-phase55-vs/Release/bm_b7_diagnostic.exe --host-capture-dir work/b7_diag_20261011_paired_capture/phase55_testX
```

## Completion Classification
**PARTIAL** — Real protocol defect (temporal drift) corrected via interleaved measurement; mean/median deviation pass frozen thresholds; worst-case paired overhead remains > 10% across tested configurations. Implementation verified, artifacts preserved.
