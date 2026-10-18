# Phase 47 — Timing-Pattern Analysis (Read-Only)

**Scope:** analyze the five existing Phase 45 `paired_samples.csv` files and the Phase 46 report. No build, no launch, no benchmark, no new measurement, no edits.

**Evidence used (read-only, preserved):**
- Phase 45 CSVs:
  - `work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r1/paired_samples.csv`
  - `work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r2/paired_samples.csv`
  - `work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r3/paired_samples.csv`
  - `work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r4/paired_samples.csv`
  - `work/b7_diag_20261011_paired_capture/phase45_fresh_baseline/p44r5/paired_samples.csv`
- Phase 46 report:
  - [phase46_forensics_report.md](work/b7_diag_20261011_paired_capture/phase46_forensics_report.md)
- Frozen artifacts (hashes verified unchanged):
  - validator `phase33_paired_csv_validator.py` → `9f6d6c29a1b1c1e59ddec1fa4ad4b6499cb2b2f8c692e421bf94c10fc6a1e8e6`
  - exe `bm_b7_diagnostic.exe` → `f50fda5a3486fa7d3225869d978a841c2d1fa10f92413530b1cda067b1000147`
  - source `bm_b7_diagnostic.cpp` → `aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b`
  - cmake `CMakeLists.txt` → `575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8`
  - historical Phase 36 CSV `pr35r1/paired_samples.csv` → `a09a0d3c37168dc88ecce79013d6e523c5aa2d101c726bb1ad0edadc0e89706d`

M0 = FAIL, M1 = LOCKED preserved.

---

## 1. Integrity check

Each CSV was re-read and re-hashed for this phase.

| Run | rows | SHA-256 | matches Phase 46 record | validation.json structural |
|---|---|---|---|---|
| p44r1 | 300 | `9ade00aaeefb06878c29b06cae0727fb683a520c0937c3ae51324001c839e1bc` | ✅ | PASS |
| p44r2 | 300 | `6fba8677890374fa80ce6badf1bc7f144952afc07e8e9a81f7de85aea59b75aa` | ✅ | PASS |
| p44r3 | 300 | `90273ab3afd6785a6d10dc7a29396cd50c8f1dcf44c119cc88763236250d930c` | ✅ | PASS |
| p44r4 | 300 | `32d6540b01de7355fd6f34ced4db4dd0df2852a2790419dd7e63c44b87b0b541` | ✅ | PASS |
| p44r5 | 300 | `ddb3a92b10957118aa88516b81bd959f0f25cf75b4ffaaa26d56a6703f58fee0` | ✅ | PASS |

Frozen formulas and thresholds verified for this analysis:
- Mean overhead = `100 × (mean_instrumented − mean_minimal) / mean_minimal`, PASS ≤ 2%
- Worst signed paired overhead = `max over aligned pairs of 100 × (instrumented − minimal) / minimal`, PASS ≤ 10%
- Median deviation = `100 × |median_instrumented − median_minimal| / median_minimal`, PASS ≤ 2%

All five frozen verdicts are reproduced: **all five FAIL**.

Executable identity preserved and confirmed: `f50fda5a3486fa7d3225869d978a841c2d1fa10f92413530b1cda067b1000147`, unchanged from Phase 45.
Prior build dirs preserved: `stark/build-b7diag-fresh-p39` and `stark/build-b7diag-fresh-p39b`, both present.
Historical Phase 36 CSV preserved and confirmed: `a09a0d3c37168dc88ecce79013d6e523c5aa2d101c726bb1ad0edadc0e89706d`.

---

## 2. Per-run paired timing distributions and overhead quantiles

All timings are seconds. Overhead quantiles are percent. Negative overhead means instrumented was faster than minimal for that pair.

### p44r1
- mean minimal `0.015268547 s`, mean instrumented `0.014996979 s`
- median minimal `0.0158103 s`, median instrumented `0.015331 s`
- mean overhead **`-1.778611%`**
- quantiles p50 / p90 / p95 / p99 / max / min:  
  `-2.175099 / 23.116016 / 41.457885 / 79.243181 / 94.165583 / -44.100161%`
- `|overhead| > 10%` count: **159**

### p44r2
- mean minimal `0.014451033 s`, mean instrumented `0.0148844453 s`
- median minimal `0.01474435 s`, median instrumented `0.0154837 s`
- mean overhead **`2.999179%`**
- quantiles: `0.883139 / 35.563190 / 57.905784 / 88.693523 / 111.692960 / -51.653786%`
- `|overhead| > 10%` count: **152**

### p44r3
- mean minimal `0.0144311767 s`, mean instrumented `0.014771898 s`
- median minimal `0.0153447 s`, median instrumented `0.01561205 s`
- mean overhead **`2.361009%`**
- quantiles: `0.815121 / 39.147392 / 60.827018 / 109.463353 / 116.175456 / -52.052288%`
- `|overhead| > 10%` count: **147**

### p44r4
- mean minimal `0.014523488 s`, mean instrumented `0.0154927513 s`
- median minimal `0.01458965 s`, median instrumented `0.01571275 s`
- mean overhead **`6.673764%`**
- quantiles: `3.306944 / 52.450494 / 91.851835 / 142.651011 / 207.327580 / -40.527978%`
- `|overhead| > 10%` count: **183**

### p44r5
- mean minimal `0.014249461 s`, mean instrumented `0.0153235197 s`
- median minimal `0.0145489 s`, median instrumented `0.0154265 s`
- mean overhead **`7.537539%`**
- quantiles: `6.687727 / 57.925461 / 81.278191 / 137.377040 / 221.943024 / -65.937733%`
- `|overhead| > 10%` count: **204**

Run-level comparison table (temporal order):
| run | mean_min | mean_ins | mean_oh% | med_min | med_ins | med_dev% | worst% | |>10%| | worst_rep | worst_iter | min_rep | min_iter |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0.015268547 | 0.014996979 | -1.778611 | 0.0158103 | 0.015331 | 3.031568 | 94.165583 | 159 | 2 | 9 | 1 | 22 |
| 2 | 0.014451033 | 0.0148844453 | 2.999179 | 0.01474435 | 0.0154837 | 5.014463 | 111.692960 | 152 | 2 | 11 | 5 | 39 |
| 3 | 0.0144311767 | 0.014771898 | 2.361009 | 0.0153447 | 0.01561205 | 1.742295 | 116.175456 | 147 | 2 | 11 | 0 | 23 |
| 4 | 0.014523488 | 0.0154927513 | 6.673764 | 0.01458965 | 0.01571275 | 7.697923 | 207.327580 | 183 | 3 | 37 | 3 | 1 |
| 5 | 0.014249461 | 0.0153235197 | 7.537539 | 0.0145489 | 0.0154265 | 6.032071 | 221.943024 | 204 | 2 | 15 | 4 | 38 |

Label: rows are in temporal collection order. Any run-to-run comparison here is **potentially temporally dependent**, not independent replication.

---

## 3. Largest positive and negative ratios — exact keys and raw timings

### p44r1
- Largest positive: replicate **2**, iteration **9**, minimal `0.0101484 s`, instrumented `0.0197047 s`, overhead **`94.165583%`**
- Largest negative: replicate **1**, iteration **22**, minimal `0.0166013 s`, instrumented `0.0092801 s`, overhead **`-44.100161%`**

### p44r2
- Largest positive: replicate **2**, iteration **11**, minimal `0.0091089 s`, instrumented `0.0192829 s`, overhead **`111.692960%`**
- Largest negative: replicate **5**, iteration **39**, minimal `0.0312616 s`, instrumented `0.0151138 s`, overhead **`-51.653786%`**

### p44r3
- Largest positive: replicate **2**, iteration **11**, minimal `0.0099991 s`, instrumented `0.0216156 s`, overhead **`116.175456%`**
- Largest negative: replicate **0**, iteration **23**, minimal `0.0209303 s`, instrumented `0.0100356 s`, overhead **`-52.052288%`**

### p44r4
- Largest positive: replicate **3**, iteration **37**, minimal `0.014253 s`, instrumented `0.0438034 s`, overhead **`207.327580%`**
- Largest negative: replicate **3**, iteration **1**, minimal `0.0238154 s`, instrumented `0.0141635 s`, overhead **`-40.527978%`**

### p44r5
- Largest positive: replicate **2**, iteration **15**, minimal `0.0095233 s`, instrumented `0.0306596 s`, overhead **`221.943024%`**
- Largest negative: replicate **4**, iteration **38**, minimal `0.0531644 s`, instrumented `0.018109 s`, overhead **`-65.937733%`**

---

## 4. Grouping by replicate and iteration

### 4.1 Within-run replicate grouping

Per-run per-replicate mean overhead and extreme range:

| run | rep0 mean_oh% | rep1 | rep2 | rep3 | rep4 | rep5 |
|---|---|---|---|---|---|---|
| p44r1 | -9.438711 | 4.697242 | 11.184715 | -1.833760 | -3.726928 | 2.095369 |
| p44r2 | -1.318023 | 2.330678 | 27.798840 | 5.891933 | -7.449955 | 4.359304 |
| p44r3 | -1.775367 | 5.939641 | 31.117563 | 0.328337 | -3.580614 | 0.723151 |
| p44r4 | 3.821689 | -0.519399 | 44.102509 | 4.031934 | -1.497057 | 16.378630 |
| p44r5 | 13.189621 | 0.926110 | 57.964536 | 7.262671 | -3.160294 | 1.588110 |

Observations:
- **Replicate 2 is the largest positive-tail contributor in all five runs.** Its per-run mean overhead rises across run order: +4.90% / +20.89% / +21.39% / +26.71% / +49.32%.
- **Replicate 3 also contributes an extreme positive pair in p44r4**, but in other runs its per-replicate mean overhead is much smaller (0.73% in p44r4, -0.23% in p44r3, -2.93% in p44r1). This is a within-run outlier pattern for p44r4, not a stable per-replicate property across runs.
- Negative extremes are more dispersed across replicates; they do not consistently concentrate in a single replicate.

Per-replicate raw range extremes (minimal_sec min/max within each replicate, across all 50 iterations of that run) show that replicate 2 often has **both** a high maximum instrumented time and some of the **smallest** minimal times in the same run. For example:
- p44r1 rep2: minimal range `0.0092289–0.0273499 s`, instrumented range `0.0139985–0.0211987 s`
- p44r2 rep2: minimal range `0.0089812–0.0212347 s`, instrumented range `0.0141401–0.0259487 s`
- p44r3 rep2: minimal range `0.0092433–0.0202751 s`, instrumented range `0.0137956–0.0216156 s`
- p44r4 rep2: minimal range `0.0090537–0.0240352 s`, instrumented range `0.0138254–0.0245957 s`
- p44r5 rep2: minimal range `0.0091267–0.0210595 s`, instrumented range `0.0141987–0.0306596 s`

This is important for interpretation below: the worst positive ratios in replicate 2 are not always the absolute smallest minimal times, but replicate 2 repeatedly contains both very small minimal values and very large instrumented values, and the ratio is highly sensitive to that combination.

### 4.2 Within-run iteration grouping

Direct iteration-by-iteration pairing across runs is not reliable from these data because the same `(replicate, iteration)` key has only one sample per run, and the five runs sample different timing draws. I therefore report iteration-level aggregation as **cross-run mean of per-run means** for descriptive context only.

Across the 50 iterations, across-run mean of per-run mean_minimal ranges roughly `0.0134–0.0163 s`, and across-run mean of per-run mean_instrumented ranges roughly `0.0142–0.0162 s`. No single iteration stands out as a global outlier in either condition at this aggregation level; the extreme pairs are better explained by specific `(replicate, iteration)` draws within runs than by a single globally pathological iteration index.

### 4.3 Do extremes coincide with low minimal timings?

Partly, but not exclusively.

**Positive extremes:**
- The very largest positive ratios tend to occur when minimal is small **and** instrumented is unusually large for that run. Example:
  - p44r5 rep2 iter15: minimal `0.0095233 s`, instrumented `0.0306596 s`
  - p44r4 rep3 iter37: minimal `0.014253 s`, instrumented `0.0438034 s`
  - p44r2 rep2 iter11: minimal `0.0091089 s`, instrumented `0.0192829 s`
  - p44r3 rep2 iter11: minimal `0.0099991 s`, instrumented `0.0216156 s`
  - p44r1 rep2 iter9: minimal `0.0101484 s`, instrumented `0.0197047 s`
- A small minimal alone is not sufficient: many very small minimal values have modest instrumented values and therefore modest ratios. The worst positive ratios cluster where a small minimal coincides with a disproportionately large instrumented value.

**Negative extremes:**
- Negative extremes tend to occur when instrumented is unusually small relative to a minimal value that is not especially small. Example:
  - p44r5 rep4 iter38: minimal `0.0531644 s`, instrumented `0.018109 s`, overhead `-65.937733%`
  - p44r2 rep5 iter39: minimal `0.0312616 s`, instrumented `0.0151138 s`, overhead `-51.653786%`
  - p44r3 rep0 iter23: minimal `0.0209303 s`, instrumented `0.0100356 s`, overhead `-52.052288%`
- In these cases the minimal is not in the smallest-timing regime; the extreme ratio is driven by an unusually **small instrumented** relative to a moderate/large minimal.

So the pattern is not "all extremes come from low minimal timings." The **positive tail** is biased toward small-minimal-plus-large-instrumented combinations; the **negative tail** is biased toward moderate/minimal-timing-plus-small-instrumented combinations.

### 4.4 Are both conditions broadly elevated for extreme pairs?

No — and that matters.
- For the worst positive pairs, instrumented is usually elevated **relative to minimal**, but minimal is not necessarily elevated; often it is among the smaller values.
- For the worst negative pairs, instrumented is the smaller side and minimal is the larger side; again, this is a relative shift, not both conditions being large.

This means within-run extremes are dominated by **relative disagreement** between the two conditions for specific pairs, not by both conditions being uniformly high or both uniformly low. That is consistent with a highly variable paired relationship at the individual-sample level.

---

## 5. Run-level comparison: means, medians, tail counts, worst-pair locations

### 5.1 Central tendency
- Mean minimal is stable across runs: `0.0142–0.0153 s`.
- Median minimal is also stable: `0.0145–0.0158 s`.
- Mean instrumented is stable in absolute terms too: `0.0148–0.0155 s`.
- **The main run-level change is the signed gap**, not a huge shift in either condition's absolute scale.

### 5.2 Tail counts
- `|overhead| > 10%` count: 159 / 152 / 147 / 183 / 204
- Pairs above +10%: 73 / 85 / 77 / 106 / 133
- Pairs below −10%: 86 / 67 / 70 / 77 / 71

Reading carefully:
- Total extreme-mass count is lowest in p44r3 and highest in p44r5.
- In p44r1, the negative tail (86) is larger than the positive tail (73).
- In p44r2–p44r5, positive tail counts are generally equal to or larger than negative tail counts.
- p44r5 has the largest positive tail and the largest total extreme count.

### 5.3 Worst-pair location
- p44r1: rep2 iter9
- p44r2: rep2 iter11
- p44r3: rep2 iter11
- p44r4: rep3 iter37
- p44r5: rep2 iter15

There is a notable tendency for the worst-case to fall in **replicate 2**, with a single exception in p44r4 (replicate 3). But the iteration index of the worst case is not constant; it is 9, 11, 11, 37, 15 across runs. This suggests some replicate-level sensitivity across runs but no stable single iteration key.

### 5.4 Median behavior
- Only p44r3 has median deviation within 2% (1.742295%).
- p44r1, p44r2, p44r4, p44r5 all fail median deviation.
- Median deviation fails even where mean overhead is not the largest (e.g. p44r1 mean passes but median dev fails), confirming that median and mean do not move together here.

---

## 6. Hypotheses: supported, contradicted, unresolved

### Hypothesis A: "The five runs are consistent replicates of the same underlying overhead behavior."
**Unresolved / weakly contradicted by the evidence as independent evidence.**
- Shared features: all FAIL; all have extreme positive and negative pairs; all show substantial within-run variability.
- Divergent features: mean overhead ranges from −1.78% to +7.54%; worst-case ranges from 94.17% to 221.94%; tail mass trends upward in later runs.
- The data are more consistent with **a broad, unstable, heavy-tailed paired process** than with five draws from a tight stable distribution. They are not inconsistent with each other in sign, but they are **not tightly consistent** in magnitude.

### Hypothesis B: "Worst-case overhead is driven mainly by a single pathological replicate."
**Partially supported, but not proven and not the whole story.**
- Supported: replicate 2 dominates the worst positive tail across all five runs in terms of total extreme mass, and the single worst pair lands on replicate 2 in 4 of 5 runs.
- Not proven: this could be sensitivity to specific timing draws within replicate 2 rather than an inherent property of replicate 2. Also, p44r4's worst pair is on replicate 3, so replicate 2 is not uniquely capable of producing the worst pair.
- Not the whole story: other replicates still produce large positive and negative extremes (e.g. rep3 iter37 in p44r4; rep4 iter38 in p5; rep0 iter23 in p44r3; rep5 iter39 in p44r2).

### Hypothesis C: "Extreme paired ratios are caused primarily by measurement instability in minimal timings."
**Unresolved.**
- Some positive extremes coincide with very small minimal timings, which is consistent with ratio sensitivity to small denominators.
- But the negative extremes are not driven by small minimal timings; they are driven by small instrumented timings relative to moderate/minimal minimal timings.
- So a pure "minimal instability" story does not explain both tails. The data suggest both conditions contribute to extreme ratios in different ways.

### Hypothesis D: "Instrumented is usually slower, so the diagnostic overhead is positive overall."
**Partially supported, but overstated if stated strongly.**
- In later runs (p44r4, p44r5), the mean overhead is clearly positive and the positive tail dominates.
- In p44r1, mean overhead is negative; instrumented is slightly faster on average.
- In p44r2 and p44r3, mean overhead is positive but modest.
- So "instrumented is usually slower" is run-dependent in these five runs and not a stable invariant from these data.

### Hypothesis E: "The five runs form a controlled replicated experiment showing a trend."
**Contradicted as a causal/trend claim.**
- These are five sequential runs with no recorded controlled manipulation of environment/affinity/timing conditions in the capture tree.
- Run-order alignment is temporal and potentially confounded.
- Any apparent monotonic trends (worst-case increasing, tail mass increasing) are **within-session observations**, not established trend or causal effect.

### Hypothesis F: "Extreme ratios alone prove instrumentation-caused overhead."
**Contradicted.**
- Extreme ratios are measured; causation is not. The data show extreme relative disagreement in both directions and no direct attribution to instrumentation overhead versus timing noise, scheduling, cache, iteration alignment, or other factors.

---

## 7. Missing per-run metadata — limitation, not reconstructed

Each Phase 45 run directory currently contains only:
- `paired_samples.csv`
- `validation.json`
- `validation_exit.txt`

The following were **not present** in any Phase 45 run directory and were **not fabricated or reconstructed** for this phase:
- `stdout.txt`
- `stderr.txt`
- `exitcode.txt`
- `hashes.txt`
- `exec_meta.json`

Consequence: from the Phase 45 run directories alone, I cannot independently compare per-run launch environment, executable metadata beyond the frozen SHA-256 of the already-built binary, working directory, affinity, arguments, or wall-clock launch timestamps. I can compare the CSVs and the validator's own per-run reports, but I cannot decompose run-to-run differences from captured run-local metadata because that metadata is absent.

This is the same limitation identified in Phase 46. Phase 47 inherits it and does not claim to overcome it.

---

## 8. Recommended next experiment (not executed)

If a next step is desired, the most useful design is one that makes run-to-run comparison actually possible and separates the plausible drivers enough to test them.

**Recommended capability, not a verdict:** design a controlled paired-collection protocol whose per-run captures include:
1. **Explicit per-run metadata** written into the capture directory for every run:
   - executable SHA-256 at launch
   - working directory, argv, timestamp
   - any affinity / processor / core policy in effect
   - a run id, sequence index, and any session-level context
2. **Controlled repetition under at least one manipulated variable**, for example:
   - same executable repeated multiple times back-to-back, to test within-executable run-to-run variability; and/or
   - a modest number of replicates/iterations large enough to characterize tail behavior, but not so large that cost obscures design clarity.
3. **Tail-aware analysis plan**, not only mean/median thresholds:
   - report worst-case and upper quantile behavior explicitly
   - report whether extreme pairs recur on the same `(replicate, iteration)` keys across controlled repetitions
   - report the relationship between extreme ratios and small minimal/instrumented values directly (for example, bin pairs by minimal magnitude and examine overhead distributions within bins)
4. **Separate concerns before conclusion:**
   - first establish whether the process is stable under repetition at all
   - then, if unstable, test whether instability tracks run order, replicate, iteration, small-timing regime, or system load
   - only then consider whether any remaining systematic component is attributable to instrumentation overhead

**Do not execute this here.** Phase 47 is read-only, and recommending the design is the appropriate boundary.

---

## 9. Conclusion

Phase 47 re-derives the per-run timing distributions, overhead quantiles, extreme-key timings, and replicate/iteration groupings from the existing Phase 45 CSVs and confirms them against the Phase 46 report. The five runs are structurally valid and all FAIL under the frozen formulas and thresholds. The data show a broad, heavy-tailed, highly variable paired relationship with both large positive and large negative extremes. The worst positive tail is concentrated, across these runs, in replicate 2 and in small-minimal-plus-large-instrumented combinations; the negative tail is driven more by small instrumented relative to moderate/minimal minimal. Run-to-run changes in mean overhead, worst-case, and tail mass are observed in temporal order, but they are best described as within-session, temporally dependent observations rather than controlled replication or proof of causation. Because per-run stdout/stderr/exitcode/hashes/exec_meta are absent from the Phase 45 capture directories, environment/identity/run-local conditions cannot be compared across runs from that evidence. The report preserves all files and all frozen verdicts, and it ends with a recommended controlled design rather than an unauthorized measurement.
