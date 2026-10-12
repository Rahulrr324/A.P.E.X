# APEX M0 v2.2 — G7 Statistical Verification

**Date:** 2026-10-05
**Scope:** Independent recomputation of every G7 number from raw records only. No threshold,
grouping key, sample, or record was altered. Reproducible script: `reports/v2.2/verify_g7.py`.

**Legend:** **[V]** verified by independent recomputation, **[T]** tool output, **[I]** inference,
**[U]** unresolved/not established.

---

## 1. Method

- Raw samples were read directly from the record JSON (`statistics.samples`), never from the v2.1
  summary files.
- **Median** uses the production convention `compute_statistics()`: sort, `pos = 0.5·(n−1)`, linear
  interpolation.
- **Grouping** matches production: key = the serialized `configuration` object (so E1 and E5 of the
  same benchmark fall in one group); only `status == PASSED` and `kind ∈ {benchmark, baseline}` with
  a non-empty `benchmark_id` participate.
- **Pairwise metric** matches production `symmetric_rel_diff_pct(a,b) = |a−b| / max(|a|,|b|) · 100`,
  all pairs `i<j`, tolerance 15% (timing) / 20% (B3, B5). **[V]**

---

## 2. Historical nine records — medians and statistics

**[V]** All nine stored medians equal the independently recomputed medians (9/9). The v2.1 claim
"stored median == recomputed median" is **correct**.

| record | bench | n | stored=recomputed median (µs) | mean (µs) | min (µs) | max (µs) | sample stdev (µs) | pop stdev (µs) | CV% (pop) | CV% (sample) |
|---|---|---|---|---|---|---|---|---|---|---|
| P1-E1-B6-24899 | B6 | 10 | 978.30 | 1055.15 | 931.40 | 1394.10 | 170.76 | 161.99 | 15.35 | 16.18 |
| P1-E1-B6-57493 | B6 | 10 | 999.50 | 1074.43 | 933.80 | 1352.90 | 161.23 | 152.96 | 14.24 | 15.01 |
| P1-E1-B7-24899 | B7 | 10 | 58168.25 | 58495.78 | 49122.50 | 69968.50 | 7455.22 | 7072.64 | 12.09 | 12.74 |
| P1-E1-B7-57493 | B7 | 10 | 60302.85 | 62489.51 | 47972.20 | 79406.40 | 10775.08 | 10222.14 | 16.36 | 17.24 |
| P1-E1-B9-24899 | B9 | 10 | 1449.60 | 1467.07 | 944.60 | 2204.40 | 419.26 | 397.75 | 27.11 | 28.58 |
| P1-E1-B9-57493 | B9 | 10 | 2003.60 | 1947.40 | 1697.00 | 2013.00 | 118.89 | 112.78 | 5.79 | 6.10 |
| P1-E5-B6-90937 | B6 | 10 | 1166.50 | 1201.94 | 1000.70 | 1559.20 | 177.25 | 168.16 | 13.99 | 14.75 |
| P1-E5-B7-90937 | B7 | 10 | 47479.75 | 54477.53 | 47068.80 | 82587.00 | 13193.52 | 12516.47 | 22.98 | 24.22 |
| P1-E5-B9-90937 | B9 | 10 | 1041.15 | 1093.23 | 935.40 | 1608.70 | 203.59 | 193.14 | 17.67 | 18.62 |

### 2.1 Discrepancy found: CV/stdev convention **[V]**

The v2.1 `reports/v2.1-aggregator/g7_stats_raw.txt` `stdev`/`CV%` columns reproduce the
**population** convention (`ddof=0`), e.g. E1-B6-24899 = 161.99 µs / 15.35%, whereas the record's
**stored** `statistics.stdev` field is the **sample** stdev (`ddof=n−1`) = 170.76 µs, i.e. CV 16.18%.
The v2.1 report quotes "CV ranges 5.8%–27.1%", which is the population-based range
(sample-based range is 6.10%–28.58%). This is a **descriptive-statistic convention mismatch, not an
error in the medians or the verdict**. Recorded here so the CV numbers are not misread as the stored
field.

---

## 3. Historical config groups — all-pairs (production metric)

**[V]** Reproduced exactly, matching the v2.1 report and the aggregator's own G7 detail text.

| group | runs | pairs | pairs > 15% | failing pair(s) |
|---|---|---|---|---|
| B6 | 3 | 3 | 1 | runs 1&3 = **16.13%** |
| B7 | 3 | 3 | 2 | runs 1&3 = **18.38%**; runs 2&3 = **21.26%** |
| B9 | 3 | 3 | 3 | runs 1&2 = **27.65%**; 1&3 = **28.18%**; 2&3 = **48.04%** |

Independently reproduced by `aggregate --out ../archive_recovery/aggregator_input`, which prints the
same six failing pairs. **G7 = FAIL is genuine.** **[T]**

---

## 4. Fresh diagnostic repeats — the 35/66, 5/66, 19/66

**[V]** The v2.1 fresh-repeat figures are **correct**. Recomputed from the 36 raw records in
`archive_recovery/v21_diagnostics/` (6×E1 + 6×E5 per benchmark; Release build). Each benchmark
yields one config group of 12 runs → C(12,2) = **66** all-pairs comparisons.

| group | runs | median spread (max−min)/max | pairs > 15% | v2.1 claim | match |
|---|---|---|---|---|---|
| B6 | 12 | **59.06%** | **35 / 66** | 35/66 | ✅ |
| B7 | 12 | **19.03%** | **5 / 66** | 5/66 | ✅ |
| B9 | 12 | **59.78%** | **19 / 66** | 19/66 | ✅ |

The fresh B6/B9 absolute levels (~200–530 µs) differ from the historical (~1000–2000 µs), i.e. the
machine was in a different load/thermal state — but the **variance pattern reproduces**, and the
all-pairs counts exceed zero in every group, so G7 would fail on the fresh data too. **[V]**

**Definition check [V]:** "spread" is defined as `(max−min)/max` of the 12 medians (not a
percentage-of-mean), and "pairs > 15%" counts pairwise `symmetric_rel_diff_pct` values strictly
greater than 15. Both definitions are the ones the v2.1 files used and are consistent with
`gates.cpp`. No ambiguity found.

---

## 5. Is "permanently fails" justified?

**Partly — and the wording needs correction.**

- **Historical frozen dataset: FAIL under the frozen rule. [V]** The nine records are frozen; the
  ±15% rule is fixed; the medians differ by 16.13–48.04%. No re-analysis of *this data* can make it
  pass. In that narrow sense the dataset "fails permanently".
- **"The harness permanently fails G7" is NOT established. [U]** The fresh repeats also failed, but
  they used the same minimal configuration (n=10, warm-up=3, no affinity). A *different, future*
  measurement configuration has not been run, so it is not established that no configuration can
  pass G7. The report's own §4.4 remediation list concedes this.
- **Future controlled measurement campaign: not yet established. [U]** Larger n, longer warm-up,
  affinity/power pinning, and batched timing are *proposed*, not demonstrated to bring the pairwise
  spread under 15%.
- **Retroactive historical acceptance: not permitted. [V]** The spec states the tolerance "is
  defined here once — later phases may not loosen it silently" (`V009:325`). The frozen set cannot be
  re-accepted by widening the gate.

**Recommended wording:** *"Under the frozen ±15% rule the recovered historical dataset fails
permanently (re-analysis cannot change it). Fresh diagnostic repeats under the same minimal
configuration also fail. A future, better-controlled measurement campaign is not yet established and
cannot retroactively rescue the historical set."*

---

## 6. Measured observations vs plausible explanations

**Measured (facts) [V]:**
- Large intra-run dispersion: sample CV 6.1%–28.6%; within a single run the max/median ratio reaches
  ~1.5–2.2× (e.g. E1-B9-24899: max 2204 µs vs median 1450 µs).
- `thread_count = 0`, `warmup_count = 3`, `measurement_count = 10` on every historical record.
- The nine records fall into two `created_utc` batches ~23 s apart.
- `determinism.outputs_bit_identical = true` for B6/B9 (the computations are identical; only timing
  varies).

**Plausible explanations (NOT proven) [I]:**
- Scheduler/timer jitter at the 200 µs–1 ms scale (B6/B9 measure a single tiny forward pass).
- CPU frequency scaling / turbo / thermal drift on the i5-12450H laptop with no power pinning.
- Insufficient warm-up (3 iterations) before timing a sub-millisecond op.
- Small-n median sampling error (`SE(median) ≈ 0.396·c`; at c≈15% that is ≈5.9%, making a ±15%
  two-median gate only ≈1.8σ).

**Not supported by the data [V]:** data corruption, a grouping error, a wrong threshold, or stored
medians disagreeing with recomputed medians. The v2.1 report is correct to rule these out. It is
**not** proven that "insufficient sampling" is the *sole* cause — it is the best-supported of several
co-occurring contributors.

---

## 7. Conclusion

- All historical sample arrays, stored/recomputed medians, and the six failing pairwise diffs are
  **independently confirmed**.
- The 35/66, 5/66, 19/66 fresh-repeat counts and the 59.06% / 19.03% / 59.78% spreads are
  **independently confirmed** under the production definitions.
- One documentation discrepancy (population vs sample stdev in the CV column) recorded; no effect on
  the verdict.
- **G7 = FAIL** is genuine, reproducible, and correctly retained. The historical set fails
  permanently under the frozen rule; the broader claims about the methodology and any future
  campaign remain unestablished.
