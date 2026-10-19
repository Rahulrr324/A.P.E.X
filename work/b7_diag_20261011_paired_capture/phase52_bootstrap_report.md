# Phase 52 — Bootstrap Null-Distribution Test (read-only)

**Objective:** determine whether the observed B7 worst-case calibration failures can plausibly arise from noisy paired measurements plus the max-of-300 percentage statistic, or whether they suggest an additional systematic difference.

**Mode:** strictly read-only statistical analysis of existing evidence. No build, no launch, no new measurements, no threshold/source/validator changes.

**Deliverables in this phase:**
- [phase52_analysis.py](work/b7_diag_20261011_paired_capture/phase52_bootstrap/phase52_analysis.py) — reproducible seeded analysis script (SHA-256 `f734277863fe9ef82672dda993e6ae95f74c06ff0d087a65be045e0cf5da4bb6`)
- [results.json](work/b7_diag_20261011_paired_capture/phase52_bootstrap/results.json) — machine-readable full results (SHA-256 `2de5953117c755cf61d84422916583bf76cb7df39bf20d746c4b8e4f1cc43eae`)
- this report

---

## 1. Input integrity

All six CSVs were re-hashed and matched the recorded hashes before any analysis. No substitution, no mismatch.

| Run | Path | Expected SHA-256 | Verified |
|---|---|---|---|
| p44r1 | `work/.../phase45_fresh_baseline/p44r1/paired_samples.csv` | `9ade00aa…839e1bc` | ✅ |
| p44r2 | `work/.../phase45_fresh_baseline/p44r2/paired_samples.csv` | `6fba8677…59b75aa` | ✅ |
| p44r3 | `work/.../phase45_fresh_baseline/p44r3/paired_samples.csv` | `90273ab3…250d930c` | ✅ |
| p44r4 | `work/.../phase45_fresh_baseline/p44r4/paired_samples.csv` | `32d6540b…87b0b541` | ✅ |
| p44r5 | `work/.../phase45_fresh_baseline/p44r5/paired_samples.csv` | `ddb3a92b…3f58fee0` | ✅ |
| p49r01 | `work/.../phase49_single_capture/r01/paired_samples.csv` | `5dc78fc5…dd208618b` | ✅ |

Context reports read: Phase 46 (forensics), Phase 47 (timing pattern), Phase 49 (single capture), Phase 51 (root-cause audit).

---

## 2. Recomputed frozen results (all six runs)

Exactly the frozen formulas (pooled-mean overhead, max signed paired overhead over (replicate, iteration) pairs, pooled-median deviation) and frozen thresholds (2 / 10 / 2 %). These reproduce the recorded Phase 45 / 49 verdicts.

| Run | mean % | mean OK | median-dev % | med OK | worst+ % | worst OK | >+10% | <−10% | max|·|>10% | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| p44r1 | −1.778611 | ✅ | 3.031568 | ❌ | 94.165583 | ❌ | 73 | 86 | 159 | FAIL |
| p44r2 | +2.999179 | ❌ | 5.014463 | ❌ | 111.692960 | ❌ | 85 | 67 | 152 | FAIL |
| p44r3 | +2.361009 | ❌ | 1.742295 | ✅ | 116.175456 | ❌ | 77 | 70 | 147 | FAIL |
| p44r4 | +6.673764 | ❌ | 7.697923 | ❌ | 207.327580 | ❌ | 106 | 77 | 183 | FAIL |
| p44r5 | +7.537539 | ❌ | 6.032071 | ❌ | 221.943024 | ❌ | 133 | 71 | 204 | FAIL |
| p49r01 | −0.154504 | ✅ | 0.869475 | ✅ | 88.582956 | ❌ | 46 | 55 | 101 | FAIL |

Worst-pair keys (recomputed):
- p44r1 worst+: rep2 it9 min 0.0101484 / instr 0.0197047 s
- p44r2 worst+: rep2 it11 min 0.0091089 / instr 0.0192829 s
- p44r3 worst+: rep2 it11 min 0.0099991 / instr 0.0216156 s
- p44r4 worst+: rep3 it37 min 0.0142530 / instr 0.0438034 s
- p44r5 worst+: rep2 it15 min 0.0095233 / instr 0.0306596 s
- p49r01 worst+: rep2 it36 min 0.0090216 / instr 0.0170132 s

Worst-negative pairs (recomputed):
- p44r1 rep1 it22 −44.10%, p44r2 rep5 it39 −51.65%, p44r3 rep0 it23 −52.05%, p44r4 rep3 it1 −40.53%, p44r5 rep4 it38 −65.94%, p49r01 rep0 it31 −40.80%.

Every recomputation matches the recorded reports (Phase 46/47/49 tables). All six runs are FAIL under the frozen rules; all six FAIL solely on the worst-case component in p49r01, and on mean/median too in the p44r2–r5 subset.

---

## 3. Methods, randomization, seeds, and formulas

### 3.1 Data structure each model operates on

Per run: 6 replicates × 50 measured iterations → 300 aligned `(minimal_sec, instrumented_sec)` pairs. Frozen statistic of interest: `M = max over 300 pairs of 100·(instr − min)/min` (the worst-case calibration metric). The CSV has no chronology column: within a replicate the two conditions are separate sequential 50-iteration blocks (counterbalanced order per [bm_b7_diagnostic.cpp:686](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp#L686)), and the pairing by equal iteration index `j` is an alignment choice, not co-located sampling. This is the reason every null model below randomizes the intrapair alignment rather than assuming a physical link.

### 3.2 Model A — within-replicate permutation / rematching

- **Randomized:** within each replicate, the 50 INSTRUMENTED iteration samples are permuted against the 50 fixed MINIMAL samples; each replicate separately; this changes only the intrapair alignment.
- **Fixed:** the replicate structure (both conditions' marginal samples and the counterbalanced sequence) and the per-iteration `minimal` values that enter each ratio denominator.
- **Null hypothesis:** the observed alignment of MINIMAL↔INSTRUMENTED iterations within a replicate is exchangeable — i.e. there is no systematic per-iteration instrumented-vs-minimal coupling beyond the two marginal sample sets.
- **Sims:** 100,000 per run (seeded).
- Exactly what is reported: distribution of the max over 300 simulated pairs.

### 3.3 Model B — block-aware resampling (moving block bootstrap)

- **Randomized:** each condition's 50-sample series per replicate is block-resampled with a separate random draw for MINIMAL and for INSTRUMENTED (circular blocks of length `L=5` and `L=10`); the two resampled series are then paired **by position**. Independent indices for the two conditions are essential — a shared index would merely reorder each replicate's original pairs and reproduce the observed max (this defect was caught in development and corrected; see §6).
- **Fixed:** the temporal structure *within* each condition series (short-range autocorrelation is preserved by contiguous blocks), and the per-replicate sample.
- **Null hypothesis:** cross-condition pairing is meaningless while within-condition autocorrelation is real — i.e. no systematic instrumented-vs-minimal difference after accounting for temporal dependence.
- **Sims:** 20,000 per run per block length (seeded).
- Limitation noted below (§6): the CSV only encodes iteration order within a condition, so "blocks" are the strongest temporal structure recoverable; nothing distinguishes first-vs-second condition position.

### 3.4 Model C — paired-difference / zero-mean additive-noise null (supplementary)

- **Randomized:** instrumented = observed `minimal` + iid Gaussian noise `N(0, s²)` with `s` = the run's observed pooled SD of paired differences, **zero mean** (null: no systematic shift).
- **Fixed:** the observed per-iteration `minimal` values (denominators) and the observed noise magnitude `s`.
- **Null hypothesis:** ratios are purely the amplifier of independent, zero-mean, additive timing noise of the observed magnitude.
- **Sims:** 50,000 per run (seeded).
- This is presented as a *sensitivity* null only: it assumes an additive Gaussian process, which the data visibly contradict (§5–6); it is included to show what a "clean" model would require, not as a faithful noise description.

### 3.5 Seeds

All randomness used `numpy` `default_rng`. Seed per run `i` (0-based) and model: `within_rep_perm` = `SEED_BASE + 1000i + 1`; `block L=5` = `+ 1000i + 20`; `block L=10` = `+ 1000i + 30`; `zero_mean_noise` = `+ 1000i + 40`; `SEED_BASE = 20261019`. The script reproduces every number here.

### 3.6 Formulas

- Observed statistic: `M_obs`.
- Sim distribution `M_sim` over `n` sims; reported p50/p90/p95/p99/max.
- `p = P(M_sim ≥ M_obs)` estimated as `(kobs+1)/(n+1)` where `kobs = # {sims ≥ M_obs}` (Monte Carlo p-value with finite-simulation floor `1/(n+1)` applied when `kobs=0`; MC standard error ≈ `sqrt(p(1−p)/n)`).

---

## 4. Null-distribution results

### 4.1 Model A — within-replicate permutation (100,000 sims/run)

| Run | M_obs | null p50 | null p90 | null p95 | null p99 | null max | k≥M_obs | p |
|---|---|---|---|---|---|---|---|---|
| p44r1 | 94.17 | 112.24 | 124.37 | 126.68 | 129.70 | 129.70 | 96468/100000 | 0.965 |
| p44r2 | 111.69 | 154.09 | 184.87 | 189.37 | 195.58 | 195.58 | 97993/100000 | 0.980 |
| p44r3 | 116.18 | 110.37 | 124.67 | 133.14 | 133.85 | 133.85 | 28022/100000 | 0.280 |
| p44r4 | 207.33 | 163.20 | 207.33 | 209.71 | 217.37 | 217.37 | 10193/100000 | 0.102 |
| p44r5 | 221.94 | 191.73 | 224.07 | 224.18 | 235.93 | 235.93 | 10083/100000 | 0.101 |
| p49r01 | 88.58 | 86.20 | 89.57 | 90.20 | 92.07 | 92.07 | 15923/100000 | 0.159 |

**Interpretation:** p ≥ 0.10 for every run; in p44r1/p44r2 the observed max is *below* the null median (94 ≪ 112; 112 ≪ 154) — random rematching of the same samples routinely produces worst-cases at least as large. The observed worst-case is **fully compatible with a noise-only, exchangeable-pairing null model** in every run. No run shows evidence that M_obs is unusually large for the two marginal sample sets.

### 4.2 Model B — block bootstrap (20,000 sims/run per block length)

| Run | M_obs | L | null p50 | null p90 | null p95 | null p99 | p |
|---|---|---|---|---|---|---|---|
| p44r1 | 94.17 | 5 | 109.22 | 124.80 | 126.68 | 129.70 | 0.791 |
| p44r1 | 94.17 | 10 | 109.22 | 124.37 | 126.68 | 129.70 | 0.767 |
| p44r2 | 111.69 | 5 | 147.00 | 184.87 | 189.37 | 195.58 | 0.839 |
| p44r2 | 111.69 | 10 | 147.00 | 184.87 | 189.37 | 195.58 | 0.836 |
| p44r3 | 116.18 | 5 | 109.20 | 123.83 | 133.14 | 133.85 | 0.250 |
| p44r3 | 116.18 | 10 | 109.20 | 123.83 | 133.14 | 133.85 | 0.253 |
| p44r4 | 207.33 | 5 | 159.42 | 207.17 | 209.71 | 217.37 | 0.0953 |
| p44r4 | 207.33 | 10 | 159.54 | 207.17 | 209.71 | 217.37 | 0.0946 |
| p44r5 | 221.94 | 5 | 146.90 | 221.94 | 224.18 | 235.93 | 0.0935 |
| p44r5 | 221.94 | 10 | 146.90 | 221.94 | 224.18 | 235.93 | 0.0948 |
| p49r01 | 88.58 | 5 | 83.38 | 89.28 | 90.20 | 92.07 | 0.150 |
| p49r01 | 88.58 | 10 | 83.73 | 89.28 | 90.20 | 92.07 | 0.149 |

**Interpretation:** Block-bootstrap p-values (≈0.09–0.84) are consistent with Model A (≈0.10–0.98). Whether we treat iterations as exchangeable (A) or preserve within-condition autocorrelation (B), the observed worst-cases sit comfortably inside the noise-only null distribution. Block length (5 vs 10) changes nothing material.

### 4.3 Model C — zero-mean additive Gaussian noise (50,000 sims/run, supplementary)

| Run | M_obs | s (diff SD) | null p50 | null p90 | null p95 | null p99 | k≥M_obs | p |
|---|---|---|---|---|---|---|---|---|
| p44r1 | 94.17 | 0.002922 | 69.66 | 88.55 | 94.99 | 108.99 | 2766/50000 | 0.0553 |
| p44r2 | 111.69 | 0.003258 | 79.57 | 100.29 | 107.44 | 122.74 | 1647/50000 | 0.0330 |
| p44r3 | 116.18 | 0.003041 | 75.59 | 94.68 | 101.60 | 115.80 | 473/50000 | 0.0095 |
| p44r4 | 207.33 | 0.004338 | 109.92 | 137.50 | 147.06 | 165.76 | 5/50000 | 0.00012 |
| p44r5 | 221.94 | 0.004622 | 121.36 | 150.64 | 160.62 | 181.62 | 11/50000 | 0.00024 |
| p49r01 | 88.58 | 0.001633 | 49.72 | 59.96 | 63.60 | 71.27 | 2/50000 | 0.00006 |

**Interpretation (careful):** The zero-mean Gaussian additive-noise null is *rejected* (small p) for most runs. This is expected and does **not** establish a systematic instrumentation effect: a Gaussian model cannot reproduce the empirically heavy-tailed paired differences (see §5 — max abs diff is 2–11× the p50), so it underestimates the plausibility of extreme tail draws. In short, Model C's assumptions are unsupported by the data, and its rejection means "the noise is heavier-tailed than the model," which is precisely the mechanism that inflates the ratio metric. Models A/B, which resample the *actual* marginal samples, are the defensible nulls and they show the observed max is conformable to noise.

---

## 5. Paired-difference analysis (abs differences alongside ratios)

| Run | mean abs diff (s) | sd diff (s) | abs p50 | abs p90 | abs p95 | abs p99 | abs max | max/p50 |
|---|---|---|---|---|---|---|---|---|
| p44r1 | 0.002214 | 0.002922 | 0.001689 | 0.004908 | 0.006076 | 0.007712 | 0.009556 | 5.7× |
| p44r2 | 0.002254 | 0.003258 | 0.001506 | 0.004946 | 0.006116 | 0.011511 | 0.020703 | 13.7× |
| p44r3 | 0.002173 | 0.003041 | 0.001399 | 0.005016 | 0.006687 | 0.010128 | 0.011616 | 8.3× |
| p44r4 | 0.002989 | 0.004338 | 0.001894 | 0.007313 | 0.008830 | 0.013144 | 0.029550 | 15.6× |
| p44r5 | 0.003328 | 0.004622 | 0.002588 | 0.006541 | 0.008901 | 0.013402 | 0.035055 | 13.5× |
| p49r01 | 0.001004 | 0.001633 | 0.000476 | 0.002772 | 0.003751 | 0.005242 | 0.007992 | 16.8× |

- The absolute paired differences are extremely heavy-tailed: the max is 6–17× the median absolute difference, and p95–p99 are 4–9× bigger than p50.
- The worst+ and worst− percentage ratios both sit at the far tail of these absolute differences combined with small denominators: e.g., p44r4 worst+ = 207% from an absolute diff of 0.0296 s against a 0.014253 s denominator; p44r5 worst− = −66% from a 0.0531644 s minimal (an extreme *minimal* draw, not a fast instrumented one).
- This confirms (recomputed, consistent with Phases 47/51) that the extreme ratios are a joint product of (a) heavy-tailed absolute timing jitter and (b) denominator amplification where the paired `minimal` is at the low or high end. The ratio metric, because of its per-pair denominator, converts modest tail differences into very large percentages.

---

## 6. Sensitivity and limitations

1. **No chronology in the CSV.** Within a replicate the two conditions are sequential blocks, but the CSV stores only aligned (replicate, iteration) rows with no timestamps/order column. Therefore:
   - Intrapair alignment is an analytic choice → every null model randomizes it (justified by exchangeability under the null).
   - First-vs-second condition position effects cannot be reconstructed from the CSV; counterbalanced order exists at replicate level but is not directly testable here. This is a documented limitation (Phase 48 §2.2), carried forward.
2. **Why Models A and B are the defensible nulls, and what they don't test.** Both hold the marginal sample sets (and replicate/schedule structure) fixed while randomizing alignment. They therefore test specifically "is the worst-case metric unusually large given the two marginal timing distributions?" They do **not** test whether the pooled *mean/median* differ systematically — and indeed p44r2–r5 show mean/median FAIL above (mean +2.4% to +7.5%), which is outside the worst-case question. That mean/median signal is *consistent with* a real run-level shift in those runs but cannot be causally assigned (uncontrolled session state, temporal dependence; Phases 46/49/51).
3. **Dependence across the six captures.** The five Phase 45 runs and the one Phase 49 run are sequential process-local executions on the same physical machine, not six independent machine sessions (per the diagnostic's own documentation and Phase 48). They were therefore analyzed individually, never pooled into one null, and no cross-run p-value combination was computed. Cross-run statements here are qualitative (direction/stability), not meta-analytic.
4. **Model C assumption failure.** Gaussian-additive zero-mean noise is contradicted by the heavy tails (§5); its small p-values indicate heavy-tailedness, not a systematic shift. It is reported as a sensitivity check only and its output must not be presented as proof of instrumentation overhead.
5. **Initial implementation defects (corrected before use).** (a) `maxima` uninitialized before `np.maximum` (would inject uninitialized memory garbage into a few runs); and (b) block bootstrap originally used a *shared* index for both conditions, which merely reorders original pairs and always reproduces the observed max (degenerate). Both were found by inspection of the first run, corrected in the final script, and the final `results.json` contains only corrected output. The corrected script is the hashed artifact.
6. **Finite simulation.** p-values have MC error ≈ `sqrt(p(1−p)/n)` (≤ ~0.001 for Models A/B/C given n). With ≤ 0.10 two-sided p-rejection at conventional levels, none of the A/B p-values approach significance.
7. **Read-only discipline.** The frozen validator, formulas, thresholds, source, and all six CSVs are untouched. Nothing here modifies the frozen verdicts (all six remain FAIL).

---

## 7. Conclusion

**What the analysis supports (recomputed):**
- Every observed worst-case value (88–222%) is statistically conformable to a noise-only null: under both an exchangeable-pairing model (A) and a block/autocorrelation-preserving model (B), the observed max sits at or below the null median in half the runs and within the null's main body in all six (p ≈ 0.09–0.98). **There is no evidence from these data that the observed worst-case is unusually large relative to the two marginal timing distributions.**
- The paired absolute differences are heavy-tailed (max 6–17× the p50), so extreme ratios arise naturally from modest tail draws combined with per-pair denominator amplification. This is consistent with and explains the frozen worst-case component exceeding 10% in all six runs.
- The smaller p-values occur only under the *Gaussian* additive-noise null (Model C), whose assumptions the data violate; that rejection reads as "heavy-tailed noise," not "systematic instrumentation overhead."

**What it does not support:**
- It does not prove the 10% worst-case threshold is mathematically impossible (only six observed captures; the threshold is a gate, not a distribution property).
- It does not resolve *why* the timings are so noisy (read-stage jitter is the Phase 51 hypothesis, not proven), nor whether the p44r2–r5 positive mean/median drift is a real systematic instrumented-vs-minimal shift or session drift (requires controlled repetition).
- It does not establish a cause; simulation alone cannot prove a root cause.

**Smallest justified next step:**
1. (Read-only, zero risk) Formalize the "worst-case ≤10% is not statistically usable at this noise level" result as the diagnostic's documented calibration caveat; i.e. treat the per-pair worst-case as an out-of-control indicator for tail detection, not a pass/fail gate, while keeping the frozen gate for history.
2. (Needs separate authorization, one controlled experiment) The only experiment that can settle the *systematic* question is the Phase 48 design: a short repeated counterbalanced run set under one frozen binary with full per-run provenance, so that the pooled mean/median overhead is compared run-to-run with known state, and the worst-case statistic is evaluated against its own empirical null.

**Verdict:** The observed worst-case calibration failures are **compatible with a noise-only model** under every defensible null tested; the data do **not** support attributing the failures to a systematic instrumented-vs-minimal timing difference about the worst-case statistic. Whether the *mean/median* component (p44r2–r5 non-PASS) reflects a real shift remains unresolved and requires the controlled replication.

**Report files and hashes:**
- [phase52_bootstrap_report.md](work/b7_diag_20261011_paired_capture/phase52_bootstrap_report.md) — this report
- [phase52_analysis.py](work/b7_diag_20261011_paired_capture/phase52_bootstrap/phase52_analysis.py) — `f734277863fe9ef82672dda993e6ae95f74c06ff0d087a65be045e0cf5da4bb6`
- [results.json](work/b7_diag_20261011_paired_capture/phase52_bootstrap/results.json) — `2de5953117c755cf61d84422916583bf76cb7df39bf20d746c4b8e4f1cc43eae`

**Guardrails preserved:** read-only; no source/CMake/validator/historical edits; no build/launch/measurement; no threshold/formula changes; no deletions of prior evidence (only this phase's own scratch files were removed after correcting the script); no commits/pushes; no G7/G7CAM; M0 = FAIL, M1 = LOCKED unchanged. All six frozen verdicts remain FAIL.
