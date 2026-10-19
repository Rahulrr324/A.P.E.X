# Phase 52 — Bootstrap Null-Distribution Test (read-only)

**Mode:** strictly read-only statistical analysis of existing evidence. No build, no launch, no new measurements.
**Question:** Can the observed B7 worst-case calibration failures plausibly arise from noisy paired measurements and the max-of-300 percentage statistic, or do the data suggest an additional systematic difference?

**Method:** seeded, reproducible Monte-Carlo null models over the six verified CSVs; frozen formulas and thresholds unchanged.
**Analysis script:** [phase52_analysis.py](work/b7_diag_20261011_paired_capture/phase52_bootstrap/phase52_analysis.py) — SHA-256 `4b3c9bfcaefeef098d405f171ad0b16c1dfa4b5ea4a7706e907801a36efc7895`
**Machine-readable results:** [results.json](work/b7_diag_20261011_paired_capture/phase52_bootstrap/results.json) — SHA-256 `d4602c36396861019f2f1289ae016c7f1be202fa212a6223bd298446954de3c5`

---

## 1. Input integrity

| Run | CSV path (relative to repo root) | Expected SHA-256 | Actual | Result |
|---|---|---|---|---|
| p44r1 | `.../phase45_fresh_baseline/p44r1/paired_samples.csv` | `9ade00aaeefb06878c29b06cae0727fb683a520c0937c3ae51324001c839e1bc` | same | ✅ match |
| p44r2 | `.../p44r2/paired_samples.csv` | `6fba8677890374fa80ce6badf1bc7f144952afc07e8e9a81f7de85aea59b75aa` | same | ✅ match |
| p44r3 | `.../p44r3/paired_samples.csv` | `90273ab3afd6785a6d10dc7a29396cd50c8f1dcf44c119cc88763236250d930c` | same | ✅ match |
| p44r4 | `.../p44r4/paired_samples.csv` | `32d6540b01de7355fd6f34ced4db4dd0df2852a2790419dd7e63c44b87b0b541` | same | ✅ match |
| p44r5 | `.../p44r5/paired_samples.csv` | `ddb3a92b10957118aa88516b81bd959f0f25cf75b4ffaaa26d56a6703f58fee0` | same | ✅ match |
| p49r01 | `.../phase49_single_capture/r01/paired_samples.csv` | `5dc78fc5b1b82fdd7c5a52eb21d90572f89acb3c345ce37bfe50537dd208618b` | same | ✅ match |

All six hashes match the recorded values. The script re-verifies each hash at load time and refuses to continue on mismatch (`HASH MISMATCH` guard in `main()`). No evidence was substituted.

**Provenance / dependence caveat (important):** p44r1–p44r5 are five process-local executions on the **same machine in the same session** (Phase 45, 2026-10-18); p49r01 is a single later execution (Phase 49, 2026-10-19). They are **not six independent machine sessions**. All analyses below are therefore computed **per run**, and no p-values are pooled or combined across runs. Any cross-run statement is qualitative and explicitly flagged as temporally dependent.

---

## 2. Recomputed frozen results (independent of the recorded reports)

Formulas unchanged: `mean = 100·(mean_instr − mean_min)/mean_min` (pooled); `worst = max over aligned (replicate,iteration) pairs of 100·(instr − min)/min` (signed, unclamped); `median_dev = 100·|median_instr − median_min|/median_min`. Thresholds: mean ≤ 2 %, worst ≤ 10 %, median-dev ≤ 2 %.

| Run | mean % | mean ok | worst % | worst ok | median-dev % | med ok | Verdict | > +10 % | < −10 % | \|·\| > 10 % |
|---|---|---|---|---|---|---|---|---|---|---|
| p44r1 | −1.778611 | ✅ | 94.165583 | ❌ | 3.031568 | ❌ | FAIL | 73 | 86 | 159 |
| p44r2 | 2.999179 | ❌ | 111.692960 | ❌ | 5.014463 | ❌ | FAIL | 85 | 67 | 152 |
| p44r3 | 2.361009 | ❌ | 116.175456 | ❌ | 1.742295 | ✅ | FAIL | 77 | 70 | 147 |
| p44r4 | 6.673764 | ❌ | 207.327580 | ❌ | 7.697923 | ❌ | FAIL | 106 | 77 | 183 |
| p44r5 | 7.537539 | ❌ | 221.943024 | ❌ | 6.032071 | ❌ | FAIL | 133 | 71 | 204 |
| p49r01 | −0.154504 | ✅ | 88.582956 | ❌ | 0.869475 | ✅ | FAIL | 46 | 55 | 101 |

Worst positive pairs (key / raw timings):

| Run | replicate | iteration | minimal_sec | instrumented_sec | signed % |
|---|---|---|---|---|---|
| p44r1 | 2 | 9 | 0.0101484 | 0.0197047 | +94.165583 |
| p44r2 | 2 | 11 | 0.0091089 | 0.0192829 | +111.692960 |
| p44r3 | 2 | 11 | 0.0099991 | 0.0216156 | +116.175456 |
| p44r4 | 3 | 37 | 0.0142530 | 0.0438034 | +207.327580 |
| p44r5 | 2 | 15 | 0.0095233 | 0.0306596 | +221.943024 |
| p49r01 | 2 | 36 | 0.0090216 | 0.0170132 | +88.582956 |

Worst negative pairs:

| Run | replicate | iteration | minimal_sec | instrumented_sec | signed % |
|---|---|---|---|---|---|
| p44r1 | 1 | 22 | 0.0166013 | 0.0092801 | −44.100161 |
| p44r2 | 5 | 39 | 0.0312616 | 0.0151138 | −51.653786 |
| p44r3 | 0 | 23 | 0.0209303 | 0.0100356 | −52.052288 |
| p44r4 | 3 | 1 | 0.0238154 | 0.0141635 | −40.527978 |
| p44r5 | 4 | 38 | 0.0531644 | 0.0181090 | −65.937733 |
| p49r01 | 0 | 31 | 0.0158919 | 0.0094077 | −40.801918 |

These independently reproduce the Phase 46/47/49 numbers exactly (all six FAIL; worst ≈ 88–222 %). The recompute is a control on the pipeline, not a new result.

---

## 3. Statistical methods, randomization semantics, and reproducibility

**Statistic under test.** For each simulated dataset we form 6 × 50 = 300 aligned pairs, compute the signed percentage `100·(instr − min)/min` for each, and take the **maximum over the 300 pairs** — the same statistic the frozen calibration uses for the worst-case gate. The observed value is compared against the simulated distribution of that maximum.

**Data structure and what the CSV does and does not contain.** Each run is 6 replicates × 50 measured iterations per condition. Per the diagnostic source, each replicate runs the two conditions as **separate sequential blocks** (10 untimed warmups + 50 measured iterations each), with a counterbalanced order (even replicate index → MINIMAL first; odd → INSTRUMENTED first). The CSV is a paired table keyed by `(replicate, iteration)`; it carries **no chronological column and no per-pair timestamps**. Consequences used throughout:
- The iteration index within a replicate does reflect the measured loop order (rows are emitted in that order), so the CSV *does* contain within-condition order information; but the relative wall-clock position of the two conditions inside a replicate is not recoverable.
- Pairing `minimal[rep][j]` with `instrumented[rep][j]` aligns two blocks that were measured at different times, not simultaneously.
- Therefore no null model here can perfectly separate "instrumentation effect" from "timing noise"; each model isolates a specific, stated notion of "no effect."

**Random seeds.** Fixed base seed `20261019`. Per run `i` (0-based), Models use `20261019 + i·1000 + code`, with code = 1 (within-replicate permutation), 20 (block L=5), 30 (block L=10), 40 (zero-mean noise). Seed-sensitivity runs use `20261019 + i·100000 + {7000,8000} + s` for s ∈ {0,7,13,29,101}.

**Reproducibility.** The whole analysis was executed twice end-to-end; the resulting `results.json` was **byte-identical** across runs (same SHA-256 `d4602c36…`), confirming the seeded pipeline is deterministic.

**Monte-Carlo counts:** within-replicate permutation 100 000; block bootstrap L=5 and L=10 20 000 each; zero-mean noise 50 000. Reported p-value is `(k+1)/(n+1)` where `k` = number of simulations with maximum ≥ observed; when `k = 0` the reported p equals the finite-simulation floor `1/(n+1)` (e.g. ≈ 5.0e-5 at n = 20 000, ≈ 1.0e-5 at n = 100 000) and must be read as an upper bound, not a precise probability.

---

## 4. Null models — what is randomized, what is held fixed, what null is represented

### Model A — within-replicate permutation / rematching
- **Randomized:** the instrumented iterations are permuted **within each replicate**; the minimal iterations are held fixed in place.
- **Held fixed:** both conditions' empirical marginal distributions per replicate; the replicate structure; the counterbalanced schedule.
- **Null:** the observed `(minimal, instrumented)` pairing within a replicate is exchangeable — the specific pairing carries no systematic information; the worst-case percentage is what you would obtain by pairing the same measured timings in a random order.
- **Valid scope:** tests whether the observed maximum is just a property of the two marginals' shapes (heavy tails + small denominators). It **cannot** detect a genuine marginal location shift, because it holds the marginals fixed (see §6).

### Model B — block-aware (moving-block) bootstrap, L = 5 and L = 10
- **Randomized:** each condition's 50-iteration series is resampled **independently** from overlapping circular blocks of length L (10 blocks of 5, or 5 blocks of 10 per replicate), then the two resampled series are paired by position.
- **Held fixed:** within-block short-range temporal structure of each condition's series; the replicate boundaries.
- **Null:** no systematic instrumented-vs-minimal relationship; pairing between conditions is erased while local autocorrelation within a condition is preserved.
- **Note on a corrected implementation detail:** an earlier draft resampled both conditions with the *same* block index, which merely reordered each replicate's existing pairs and reproduced the observed maximum exactly (a degenerate, invalid null). The final code resamples the two conditions **independently**. Only the corrected results are reported here; the script documents this. 
- **Valid scope:** a conservative, autocorrelation-aware companion to Model A. Same marginal-fixed limitation.

### Model C — additive zero-mean Gaussian noise on differences (supplementary, assumption-limited)
- **Randomized:** `instrumented = observed minimal + ε`, with `ε ~ N(0, s²)`, `s` = the run's observed pooled SD of the paired differences, mean forced to zero, independent across the 300 pairs. The minimal values stay at their observed values (so the small-denominator amplification is preserved).
- **Null:** timing differences are independent, zero-mean, thin-tailed (Gaussian) noise of the observed magnitude.
- **Status:** this model's Gaussian assumption is **contradicted by the data** — the paired differences are strongly leptokurtic (excess kurtosis 0.6–12.4, §5). Its outputs are therefore reported for completeness only and are **not** treated as evidence of a real effect (see §6). Where a null's assumptions are unsupported, it cannot validly distinguish an instrumentation effect from timing noise.

---

## 5. Null-distribution results

For each run: the simulated distribution of the max-of-300 signed percentage (median / p90 / p95 / p99 / max) and the observed value. `p` = P(sim max ≥ observed), `(k+1)/(n+1)`.

### Model A — within-replicate permutation (n = 100 000)
| Run | observed | null p50 | null p90 | null p95 | null p99 | null max | k ≥ obs | p |
|---|---|---|---|---|---|---|---|---|
| p44r1 | 94.166 | 112.244 | 124.371 | 126.684 | 129.699 | 129.699 | 96 468 | 0.9647 |
| p44r2 | 111.693 | 154.095 | 184.872 | 189.367 | 195.582 | 195.582 | 97 993 | 0.9799 |
| p44r3 | 116.175 | 110.371 | 124.666 | 133.135 | 133.852 | 133.852 | 28 022 | 0.2802 |
| p44r4 | 207.328 | 163.199 | 207.328 | 209.714 | 217.370 | 217.370 | 10 193 | 0.1019 |
| p44r5 | 221.943 | 191.729 | 224.073 | 224.183 | 235.933 | 235.933 | 10 083 | 0.1008 |
| p49r01 | 88.583 | 86.195 | 89.566 | 90.204 | 92.075 | 92.075 | 15 923 | 0.1592 |

### Model B — block bootstrap L = 5 (n = 20 000)
| Run | observed | null p50 | null p90 | null p95 | null p99 | null max | k ≥ obs | p |
|---|---|---|---|---|---|---|---|---|
| p44r1 | 94.166 | 109.221 | 124.801 | 126.684 | 129.699 | 129.699 | 15 814 | 0.7907 |
| p44r2 | 111.693 | 146.999 | 184.872 | 189.367 | 195.582 | 195.582 | 16 770 | 0.8385 |
| p44r3 | 116.175 | 109.199 | 123.827 | 133.135 | 133.852 | 133.852 | 5 003 | 0.2502 |
| p44r4 | 207.328 | 159.417 | 207.175 | 209.714 | 217.370 | 217.370 | 1 905 | 0.0953 |
| p44r5 | 221.943 | 146.904 | 221.943 | 224.183 | 235.933 | 235.933 | 1 869 | 0.0935 |
| p49r01 | 88.583 | 83.377 | 89.275 | 90.204 | 92.075 | 92.075 | 2 993 | 0.1497 |

### Model B — block bootstrap L = 10 (n = 20 000)
| Run | observed | null p50 | null p90 | null p95 | null p99 | null max | k ≥ obs | p |
|---|---|---|---|---|---|---|---|---|
| p44r1 | 94.166 | 109.221 | 124.371 | 126.684 | 129.699 | 129.699 | 15 344 | 0.7672 |
| p44r2 | 111.693 | 146.999 | 184.872 | 189.367 | 195.582 | 195.582 | 16 722 | 0.8361 |
| p44r3 | 116.175 | 109.199 | 123.827 | 133.135 | 133.852 | 133.852 | 5 063 | 0.2532 |
| p44r4 | 207.328 | 159.542 | 207.175 | 209.714 | 217.370 | 217.370 | 1 891 | 0.0946 |
| p44r5 | 221.943 | 146.904 | 221.943 | 224.183 | 235.933 | 235.933 | 1 895 | 0.0948 |
| p49r01 | 88.583 | 83.732 | 89.275 | 90.204 | 92.075 | 92.075 | 2 972 | 0.1486 |

### Model C — additive zero-mean Gaussian noise (n = 50 000) — assumption-limited
| Run | observed | s_diff (s) | null p50 | null p90 | null p95 | null p99 | null max | k ≥ obs | p |
|---|---|---|---|---|---|---|---|---|---|
| p44r1 | 94.166 | 0.0029218 | 69.665 | 88.548 | 94.986 | 108.995 | 161.584 | 2 766 | 0.0553 |
| p44r2 | 111.693 | 0.0032579 | 79.568 | 100.288 | 107.440 | 122.738 | 167.790 | 1 647 | 0.0330 |
| p44r3 | 116.175 | 0.0030412 | 75.589 | 94.676 | 101.599 | 115.797 | 163.040 | 473 | 0.0095 |
| p44r4 | 207.328 | 0.0043380 | 109.925 | 137.501 | 147.062 | 165.759 | 242.466 | 5 | 0.00012 |
| p44r5 | 221.943 | 0.0046216 | 121.357 | 150.637 | 160.621 | 181.625 | 247.123 | 11 | 0.00024 |
| p49r01 | 88.583 | 0.0016328 | 49.718 | 59.961 | 63.602 | 71.274 | 89.787 | 2 | 0.00006 |

**Paired-difference context (why Model C behaves as it does).** Absolute paired differences are heavy-tailed: mean |diff| 0.0010–0.0033 s, p99 0.0052–0.0134 s, max 0.0080–0.0351 s, and excess kurtosis is uniformly positive (p44r1 0.58, p44r2 6.96, p44r3 1.85, p44r4 6.18, p44r5 12.38, p49r01 4.08). The observed maxima sit well above a thin-tailed Gaussian null (Model C) but comfortably **inside** the empirical, heavy-tailed nulls (Models A/B). That pattern is the expected signature of heavy-tailed noise meeting a max-of-300 ratio statistic, **not** of a novel systematic effect.

**Seed sensitivity (Models A and B, 5 seeds, reduced n = 20 000/10 000):** p-values are stable to ≤ 0.006 across seeds. E.g. within-replicate permutation: p44r1 ∈ [0.9640, 0.9658], p44r4 ∈ [0.0984, 0.1018], p44r5 ∈ [0.0986, 0.1023], p49r01 ∈ [0.1576, 0.1659]; block L=5: p44r1 ∈ [0.7881, 0.7969], p44r4 ∈ [0.0906, 0.0955], p44r5 ∈ [0.0905, 0.1003]. Monte-Carlo noise does not change any conclusion.

---

## 6. Interpretation

Applied against the three allowed conclusions:

1. **Compatible with the tested noise-only null model.**
   - **Models A and B (both runs):** the observed worst-case maximum is **inside** the null distribution for every run, with two-sided-style p-values of 0.09–0.98. For p44r1, p44r2, p44r3, p49r01 the observed maximum is at or **below the null median** — random re-pairing of the *same measured timings* typically yields a **larger** max than the one observed. In p44r4/p44r5 the observed maximum sits near the null p90–p95 (p ≈ 0.09–0.10), i.e. high but not unusual at conventional levels. **Conclusion: the worst-case calibration failures are compatible with noisy paired measurements and the max-of-300 percentage statistic.**

2. **Inconsistent with the tested null model.**
   - **Model C only (all runs, p ≈ 0.0001–0.055):** the observed maxima exceed this null. But Model C assumes independent zero-mean **Gaussian** differences, and the data are strongly leptokurtic (excess kurtosis up to 12.4) and, in some runs, the pooled mean is shifted (see below). This rejection is therefore evidence that the **Gaussian assumption is wrong**, not evidence of an instrumentation effect. It is reported as an assumption failure, not as proof of anything.

3. **Inconclusive because model assumptions or evidence are insufficient.**
   - **Marginal location shift (mean / median metrics).** Models A and B hold the marginals fixed, so **by construction they cannot explain or exclude a genuine shift of the instrumented distribution relative to the minimal distribution.** Four of six runs fail the *mean* metric (p44r2 +2.999 %, r3 +2.361 %, r4 +6.674 %, r5 +7.538 %) and three fail the *median-dev* metric (r1 3.03, r2 5.01, r4 7.70, r5 6.03). Those failures are **not** addressed by the shuffle-based nulls and remain **unresolved** here. They are consistent with either a small real instrumentation/order effect or with run-to-run drift/load, and this evidence cannot separate the two (no chronology, no order metadata, uncontrolled state).
   - **Order effects.** The counterbalanced schedule exists, but the CSV has no chronology column, so no model here can test a first-vs-second position effect. Unresolved.
   - **Which stage produces the heavy tail** (the read stage is the plausible candidate from Phase 49's pooled component data, but per-pair components are not persisted). Unresolved.

**What this does *not* claim.** A Monte-Carlo result cannot prove a root cause. The analysis does **not** show the 10 % worst-case threshold is mathematically impossible to meet; it shows only that, in these six captures, the observed maxima are statistically indistinguishable from what the max-of-300 statistic produces when the *same* timings are re-paired. It also does **not** establish that the mean/median failures are noise — those are a separate, unresolved signal.

---

## 7. Sensitivity analysis and limitations

- **Seed sensitivity:** negligible (≤ 0.006 across 5 seeds, §5).
- **Block length:** L=5 and L=10 agree closely (max Δp ≈ 0.012), so the block-bootstrap conclusion is not an artifact of one block size.
- **Determinism:** rerunning the whole analysis reproduces `results.json` byte-for-byte.
- **No pooling:** the six captures are **not** independent sessions (five are one 2026-10-18 session; one is 2026-10-19). All inference is per run; no combined p-value is reported.
- **Gaussian null is misspecified** for these heavy-tailed data (documented, not used as proof).
- **Shuffle nulls hold the marginals fixed**, so they cannot speak to the mean/median metric failures.
- **No chronology / no per-pair components / uncontrolled affinity & cache / no per-run environment metadata** — the same limitations carried from Phases 46–51.
- p-values with `k = 0` are finite-simulation bounds (`1/(n+1)`), not exact probabilities.

---

## 8. Conclusion and smallest justified next step

**Supported:** For all six runs, the worst-case calibration failures (observed maxima ≈ 88 %–222 %) are **compatible with a noise-only explanation** under two empirically grounded nulls that preserve the real marginal distributions and (for the block model) local autocorrelation. The extreme values are the expected behaviour of a **max-of-300 ratio statistic applied to heavy-tailed timings whose denominator is the (often small) paired minimal**. No additional systematic difference is *needed* to explain the worst-case gate.

**Not supported:** There is **no evidence in these data of an instrumentation-specific cause** for the worst-case failures (the only model that rejects is the misspecified Gaussian one). Equally, there is **no evidence that the threshold is impossible** — only that the worst-case statistic is highly sensitivity-amplified (a max over ratio-amplified pairs) and, at this noise level, its threshold is effectively saturated: re-pairing the same data already exceeds 10 % with probability ≈ 1.

**Unresolved and worth isolating:** the *mean* and *median* metric failures in p44r2–r5 are a separate signal that the shuffle-based nulls cannot address. That is the strongest remaining uncertainty.

**Smallest justified next step (read-only, no launch):** Test whether the marginal shift is an **order effect** rather than an instrumentation effect, using only the existing CSVs. Because the schedule alternates deterministically (even replicates MINIMAL-first, odd INSTRUMENTED-first), compare each replicate's two condition medians against its position, and compare pooled instrumented-minus-minimal median by replicate parity. If the shift tracks execution position, it is an order/drift artifact of the sequential blocks; if it tracks the condition regardless of position, it points to a real difference. This requires no new measurement, no source change, and directly targets the one failure mode the present models cannot resolve. If that read-only test is inconclusive, the next step is a properly controlled repetition with randomized condition order and per-run metadata — but that needs separate authorization.

---

## 9. Guardrails

- Read-only with respect to source, CMake, validator, and historical evidence; the frozen validator was **not** modified.
- No build, executable launch, benchmark, or new measurements.
- No threshold or formula changes; frozen verdicts (36, 45, 49) untouched.
- No deletion, cleaning, moving, or overwriting of historical artifacts (only Phase-52 scratch files that this phase itself created were removed).
- No commits, pushes, or history rewriting; no G7/G7CAM activity.
- M0 remains FAIL; M1 remains LOCKED.

**Verdict:** The observed worst-case B7 calibration failures are **compatible with the tested noise-only null models** (within-replicate permutation and block bootstrap, p ≈ 0.09–0.98); the only rejecting model is the Gaussian one, whose assumptions the data violate. The failures are therefore consistent with heavy-tailed timing noise funneled through a max-of-300 ratio statistic — **no instrumentation-specific cause is established**, and the threshold is **not shown to be impossible**. The unresolved mean/median shift is the smallest justified target for the next read-only step.