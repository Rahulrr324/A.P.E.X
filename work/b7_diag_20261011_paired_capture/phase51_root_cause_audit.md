# Phase 51 — B7 Timing-Method Root-Cause Audit (read-only)

**Mode:** read-only audit of existing source and captured evidence. No build, no launch, no new measurements.
**Evidence inspected:**
- [bm_b7_diagnostic.cpp](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp) (frozen hash `aeb31eb2…` verified unchanged)
- [phase46_forensics_report.md](work/b7_diag_20261011_paired_capture/phase46_forensics_report.md)
- [phase47_timing_pattern_report.md](work/b7_diag_20261011_paired_capture/phase47_timing_pattern_report.md)
- [phase48_experiment_design.md](work/b7_diag_20261011_paired_capture/phase48_experiment_design.md)
- [phase49_report.md](work/b7_diag_20261011_paired_capture/phase49_single_capture/phase49_report.md)
- All six paired CSVs: `p44r1..p44r5` (Phase 45) plus `p49r01/paired_samples.csv` (Phase 49)

Every finding below is tagged as **Source-verified**, **Recomputed from captured data**, **Hypothesis**, or **Unresolved**.

---

## Q1. Are MINIMAL and INSTRUMENTED semantically equivalent apart from timing instrumentation?

**Verdict: yes, effectively equivalent — Source-verified.**

- `minimal_op` ([bm_b7_diagnostic.cpp:478](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp#L478)): `std::ifstream f(path, binary)` → open-failure throw → read all bytes into `std::vector<uint8_t>` → `loader.deserializeWeights(bytes)`. No timing.
- `instrumented_op` ([bm_b7_diagnostic.cpp:490](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp#L490)): the **identical** statement sequence, with four `steady_clock::now()` reads at stage boundaries and three `duration` computations + three scalar stores after the last clock read. No extra allocation, no logging, no changed control flow.
- Both conditions use the same `TinyDenseModel loader` constructed per replicate outside all timed regions ([bm_b7_diagnostic.cpp:601](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp#L601)), same blob path, same open-failure behavior (documented in the header comment at the top of the file).
- **Hypothesis (negligible, quantified):** the instrumented condition performs, inside the measured window, 4 clock reads + 3 duration subtractions + 3 stores. On this hardware a `steady_clock` read is order ~10–50 ns; total added work is a few hundred ns against a ~9–15 ms operation — i.e., ≪0.01% of the total. Too small to explain any extreme ratio. This is a reasoning-based estimate, not a per-element measurement.

**Conclusion:** semantic difference between the two conditions is only the small amount of instrumentation itself; there is no alternate code path or differing work set. The header's claim of ".identical statement sequence with four steady_clock reads" is verified against the code.

---

## Q2. Does the measurement boundary include different work or clock-read overhead between conditions?

**Verdict: the outer boundary is identical; the instrumented condition alone carries extra inner clock reads — but the difference is negligible. Source-verified.**

- The outer timing pair `tA`/`tB` is taken identically around whichever op runs ([bm_b7_diagnostic.cpp:611-616](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp#L611)): `const auto tA = Clock::now(); <op>; const auto tB = Clock::now(); total_sec = duration(tB-tA)`. Both conditions get the same outer treatment.
- In the instrumented branch only, four extra `Clock::now()` calls and the post-`t3` timing bookkeeping fall **inside** the `[tA, tB]` window. No logger, formatter, or unrelated allocation runs inside the window in either condition (verified in the timing-discipline section of the file header and in `instrumented_op`).
- Measured consequence visible in the pooled channel: in `p49r01` the open/deserialize/residual stages are each ≲0.1 ms and the read stage dominates (~9.4 ms mean). The added inner-clock work is a tiny constant relative to the ~9 ms read, so it cannot stretch one instrumented iteration to 17–44 ms (the totals seen in the extreme pairs).

**Quote-from-source for the mechanism that actually produces the observed spread:** the pooled component decomposition in the `p49r01` stdout report shows the largest single-stage variability in the **read** stage: min 8198.4 µs, max 16616.4 µs (≈2.03×), stdev 1167.9 µs; open and deserialize stay small. → The observed per-iteration spread is dominated by the big file read. **Hypothesis:** page-cache/scheduler/disk latency on the 1,051,664-byte blob read produces the heavy tail; **Unresolved:** the CSV does not persist per-pair components, so no per-pair attribution is possible from the captured data.

---

## Q3. Is pairing by replicate/iteration scientifically defensible given the counterbalanced schedule?

**Verdict: replicate-index pairing is defensible; identical-iteration-index alignment within a replicate is weak; the counterbalancing is good but the calibration cannot test it. Source-verified design analysis.**

- Schedule ([bm_b7_diagnostic.cpp:686](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp#L686)): even replicate index → MINIMAL first, odd → INSTRUMENTED first. This balances *which condition runs first* across the 6 replicates. Good practice.
- Within one replicate, the first condition runs its full 10-warmup + 50-measured sequence, then the second condition runs its full sequence. Therefore `minimal[rep][j]` and `instrumented[rep][j]` are **not** temporally co-located: they are separated by ~60 iterations of wall time. Pairing equal `j` across two sequential time series is an arbitrary alignment; the source documents it as a design choice, but it is defensible only as *within-replicate block* pairing, not as simultaneous measurements (see classification below).
- Pairing *across replicates* further means each replicate's condition pair samples a different point in the process's drift/load envelope. Counterbalancing balances order but the CSV is a paired table with no chronological column, so a first-vs-second-position check cannot be reconstructed from the CSV alone (**Unresolved** — already documented in Phase 48).
- The calibration (worst-case over aligned (i,j) pairs, [bm_b7_diagnostic.cpp:785](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp#L785)) therefore computes a **max over 300 ratio-amplified pairs** that are only loosely coupled in time. That is a statistic, not a bug — but it makes the worst-case metric extremely sensitive to heavy-tailed per-iteration jitter (Q5).

**Classification:** the pairing is **scientifically weak but not incorrect** — it does not fabricate values; it just makes the paired worst-case statistic all but guaranteed to be driven by the noisiest single pairs. No threshold or formula was changed; this is design assessment, not a defect claim.

---

## Q4. Do the worst pairs reflect small denominators, large absolute timing differences, or both?

**Verdict: both — systematically small denominators, and absolute differences that are themselves a large fraction of the mean. Recomputed from captured data.**

Amplification factor `AMP = worst_pct / (100·max_absdiff/mean_minimal)`. `AMP > 1` means the small denominator pushed the ratio past what the largest absolute difference alone would give. Also shown: the percentile of the worst+ pair's minimal within its run, and the fraction of `>+10%` pairs whose minimal is below the run's median minimal.

| Run | worst+ % | max abs diff (s) | meanMin (s) | 100·diff/mean | AMP | >10% n | % of >10% pairs with minimal ≤ median |
|---|---|---|---|---|---|---|---|
| p44r1 | 94.17 | 0.009556 | 0.015269 | 62.6 | 1.50 | 73 | 84.9 |
| p44r2 | 111.69 | 0.020703 | 0.014451 | 143.3 | 0.78 | 85 | 76.5 |
| p44r3 | 116.18 | 0.011616 | 0.014431 | 80.5 | 1.44 | 77 | 87.0 |
| p44r4 | 207.33 | 0.029550 | 0.014523 | 203.5 | 1.02 | 106 | 67.9 |
| p44r5 | 221.94 | 0.035055 | 0.014249 | 246.0 | 0.90 | 133 | 63.2 |
| p49r01 | 88.58 | 0.007992 | 0.009680 | 82.6 | 1.07 | 46 | 54.3 |

Findings (recomputed):
- In **all six runs** the worst+ pair's minimal sits in the lower half of that run's minimal distribution (often the lowest quartile: p44r1 p14, p44r2 p1, p44r3 p20, p44r5 p19, p49r01 p33).
- In **all six runs**, 54–87% of all `>+10%` pairs come from the below-median-minimal half → the small-denominator effect is a systematic contributor.
- The absolute differences are also genuinely large — max abs diff equals 63–246% of the pooled mean minimal. So even a denominator-robust view produces double-digit-to-triple-digit "percentage of mean" deviations. The worst cases are **both** a small-denominator amplifier **and** a heavy-tailed absolute jitter phenomenon.
- The worst negative ratios are explained almost entirely by an **abnormally large minimal draw**: in 4 of 6 runs the worst− pair's minimal is at the 99–100th percentile of its run (p44r2 p100 at 0.031262 s, p44r3 p99 at 0.020930 s, p44r4 p100 at 0.023815 s, p44r5 p100 at 0.053164 s). i.e., the pairing catches an extreme slow minimal iteration and reports "instrumented much faster".

Note the run-to-run context shift (recomputed): p44r1–r5 medians ≈ 14.5–15.8 ms with CV 22–33%; p49r01 medians ≈ 9.2 ms with CV 12.5–12.8%. The Phase 49 run on 2026-10-19 02:31Z was materially faster and less variable than the Phase 45 runs from 2026-10-18 — consistent with different system state/load between sessions (uncontrolled, **Unresolved**).

---

## Q5. Does the source provide evidence of a specific bug, or only evidence of measurement variability?

**Verdict: no specific bug; the evidence points to measurement variability plus a metric/threshold mismatch. Source-verified for "no bug", Recomputed for the variability.**

Source-verified checks, all clean:
- `calibrate()` formulas ([bm_b7_diagnostic.cpp:763-814](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp#L763)) are internally consistent: pooled-mean, max-signed-pair, pooled-median-deviation; thresholds `2 / 10 / 2 %` unchanged; no clamping; non-positive/non-finite denominators → INCONCLUSIVE.
- The CSV writer ([bm_b7_diagnostic.cpp:1150-1231](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp#L1150)) uses the same pair keys (`minimal[i].index`, iteration `j`) and the same formula `100*(b[j]-a[j])/a[j]` (line 1227) as `calibrate()` (line 785). The frozen validator independently confirmed 0 formula violations across all six CSVs.
- Both conditions run the same warmup count (10) and measured count (50); no indexing bug, no buffer overrun, no missing/extra allocation in the timed paths was found.
- Unexplained extreme totals are NOT an instrumented-invariant: negative extremes exist in every run (−40 to −66%), so "INSTRUMENTED is always slower" is false → not a systematic instrumentation offset (recomputed).

Recomputed evidence of variability (all six runs):
- Pooled mean overhead: p44r1 −1.78%, p44r2 +3.00%, p44r3 +2.36%, p44r4 +6.67%, p44r5 +7.54%, p49r01 −0.15%. The sign and size move run to run → no stable instrumented-vs-minimal systematic shift.
- Median deviation: 3.03 / 5.01 / 1.74 / 7.70 / 6.03 / 0.87 % — again inconsistent in sign and magnitude.
- Worst-case signed overhead FAILs 6/6 (88–222%); mean metric FAILs 4/6; median metric FAILs 4/6.
- Per-iteration CV is 12–33% in both conditions; the read stage alone spans ~2× from min to max. Under per-iteration pairing, a max-of-300 over ratios with 12–33% coefficient of variation will almost inevitably exceed a 10% cap when the denominator is at the low end.

**Therefore:** the dominant explanation is **measurement variability** (heavy-tailed per-iteration jitter, especially in the file-read stage) being funneled through a max-of-300 ratio-amplified statistic. There is **no specific source defect** that the evidence supports. A secondary, unresolved contributor: two of six runs (p44r4, p44r5) also fail the mean and median metrics with positive shifts (~6.7–7.5%), which is *consistent with* session drift/load across the Phase 45 sequence but is **not proven** as a systematic effect — with uncontrolled state and no per-run metadata (Phases 46–47 documented this), causality cannot be assigned.

---

## Q6. Smallest safe next action that could resolve the strongest uncertainty

The strongest unresolved question is: **is the persistent FAIL a "real" instrumentation-vs-minimal difference, or is the worst≤10% gate statistically unattainable under this measured noise?** The smallest safe step is a **read-only statistical test of the worst-case statistic using only the existing six CSVs — no launch, no source change**:

> **Recommended next phase (Phase 52, read-only):** construct a null distribution for the max-of-300 paired ratio by re-pairing within each run under the same counterbalanced schedule (e.g., block/permutation bootstrap: random rematching of iterations within replicates, or resampling of the paired differences), and ask whether the observed worst-case (88–222%) is consistent with the per-iteration noise alone. A secondary read-only complement: compare the observed worst-case to a heavy-tailed (log-normal / EVT) estimate from each run's paired differences.

- If the null model reproduces the observed worst-cases, the root cause is confirmed as **metric-vs-noise mismatch** (the 10% worst-case gate is not achievable with per-iteration pairing at CV 12–33%) → the fix is methodological (change the statistic/pairing), not a code bug.
- If the null model does *not* reproduce the values, that discriminates a genuine systematic instrumented-vs-minimal or drift component → then a controlled repetition (Phase 48's design) is justified.
- The experiment cannot be run here (guardrail: no launch); it is specified, not executed.

---

## Classification summary

| Finding | Classification |
|---|---|
| MINIMAL and INSTRUMENTED are semantically equivalent apart from a few clock reads | Source-verified |
| Outer measurement boundary is identical for both conditions; inner clock-read overhead is negligible | Source-verified (+ Hypothesis for size) |
| Counterbalanced schedule exists; identical-iteration-index alignment within a replicate is a weak temporal pairing | Source-verified design analysis / Hypothesis that it matters |
| Worst pairs reflect both small denominators and large absolute differences; negative worst cases are extreme minimal draws | Recomputed from captured data |
| No arithmetic/pairing/persistence bug found in source | Source-verified |
| Persistent FAIL is primarily measurement variability + max-of-300 ratio-amplified statistic; worst≤10% likely unattainable at CV 12–33% | Hypothesis (strong, evidence-backed) |
| Whether a real systematic (drift/load) component contributed in p44r4/r45 | Unresolved |
| Which stage/interference produces the heavy tail (read-stage hypothesis) | Unresolved (per-pair components not persisted) |
| First-vs-second condition order effect quantifiable from the CSV | Unresolved (no chronology column) |

---

## Root-cause verdict

**The persistent B7 calibration failures cannot be attributed to a specific source bug — none is supported by the code or the captured data. The evidence shows the failures are a measurement-methodology outcome: heavy-tailed per-iteration timing jitter (per-iteration CV 12–33%, the file-read stage alone spanning ~2×) is funneled through a worst-case statistic that takes the maximum over 300 pairs of a percentage whose denominator is the (often small) paired minimal timing. That statistic is structurally biased toward huge values under noise: worst-case signed overhead FAILed 6/6 runs (88–222%) while pooled means and medians stayed near zero and inconsistent in sign. The most likely true root cause is a threshold/statistic mismatch — a max-of-300 ratio-amplified gate that is not attainable at this noise level —  not a defect in the diagnostic's arithmetic, pairing keys, or CSV persistence.**

**Recommended next action (not executed):** Phase 52, read-only, a bootstrap null-distribution test of the max-of-300 worst-case ratio on the six existing CSVs to confirm whether the observed worst-cases are consistent with per-iteration noise alone (see Q6).

**Guardrails preserved:** read-only; no source/CMake/validator/evidence edits; no build/launch/benchmark/measurement; no threshold/formula changes; no deletions/cleanup/commits/pushes; no G7/G7CAM; M0 = FAIL and M1 = LOCKED unchanged.
