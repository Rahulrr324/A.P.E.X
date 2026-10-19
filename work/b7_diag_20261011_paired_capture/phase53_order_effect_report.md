# Phase 53 — Read-Only Condition-Order / Marginal-Shift Analysis

**Mode:** read-only analysis of existing evidence. No build, no launch, no new measurements.
**Question:** Are the unresolved mean/median differences in the six B7 captures associated with **condition execution order** (which condition ran first within a replicate), rather than with the condition itself?

**Deliverables**
- This report: `work/b7_diag_20261011_paired_capture/phase53_order_effect_report.md`
- Script: [phase53_analysis.py](work/b7_diag_20261011_paired_capture/phase53_order_effect/phase53_analysis.py) — SHA-256 `f8e906cf58bc97e801f6019a6164df468d86e6b73d603983d426b2aa6981d141`
- Results: [results.json](work/b7_diag_20261011_paired_capture/phase53_order_effect/results.json) — SHA-256 `645e31c5a5a01e06373875b2941c230e6a3bf706418c2fd7e8664106c7acd11b`

**Reproducibility:** the whole analysis was executed twice end-to-end; `results.json` was byte-identical across runs (same SHA-256). Seeded (`SEED_BASE = 20261019`).

---

## 1. Input integrity

| Run | Session | CSV (relative to repo root) | Expected SHA-256 | Actual | Result |
|---|---|---|---|---|---|
| p44r1 | A | `.../phase45_fresh_baseline/p44r1/paired_samples.csv` | `9ade00aaeefb06878c29b06cae0727fb683a520c0937c3ae51324001c839e1bc` | same | ✅ |
| p44r2 | A | `.../p44r2/paired_samples.csv` | `6fba8677890374fa80ce6badf1bc7f144952afc07e8e9a81f7de85aea59b75aa` | same | ✅ |
| p44r3 | A | `.../p44r3/paired_samples.csv` | `90273ab3afd6785a6d10dc7a29396cd50c8f1dcf44c119cc88763236250d930c` | same | ✅ |
| p44r4 | A | `.../p44r4/paired_samples.csv` | `32d6540b01de7355fd6f34ced4db4dd0df2852a2790419dd7e63c44b87b0b541` | same | ✅ |
| p44r5 | A | `.../p44r5/paired_samples.csv` | `ddb3a92b10957118aa88516b81bd959f0f25cf75b4ffaaa26d56a6703f58fee0` | same | ✅ |
| p49r01 | B | `.../phase49_single_capture/r01/paired_samples.csv` | `5dc78fc5b1b82fdd7c5a52eb21d90572f89acb3c345ce37bfe50537dd208618b` | same | ✅ |

All six match. The script re-verifies each hash at load and aborts on mismatch. Session A = five Phase-45 executions on one machine/session (2026-10-18); Session B = the Phase-49 single execution (2026-10-19). **They are not independent sessions and are never pooled.**

---

## 2. Schedule verification against source

Source-verified in [bm_b7_diagnostic.cpp](stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp#L690): `build_schedule()` sets `minimal_first = (i % 2u) == 0u`.

- **Even replicate index (0, 2, 4) → MINIMAL first, then INSTRUMENTED.**
- **Odd replicate index (1, 3, 5) → INSTRUMENTED first, then MINIMAL.**

Cross-checked against each run's recorded stdout order block in Phase 49 (`replicate 0: MINIMAL then INSTRUMENTED` … `replicate 5: INSTRUMENTED then MINIMAL`), which agrees. One untimed warmup block of 10 iterations precedes each condition's 50 measured iterations.

---

## 3. Frozen metrics recomputed independently

Formulas unchanged (mean = `100·(mean_instr − mean_min)/mean_min` pooled; worst = max signed paired pct; median-dev = `100·|med_instr − med_min|/med_min`). Thresholds 2 / 10 / 2 %.

| Run | mean % | mean ok | worst % | worst ok | median-dev % | med ok | Verdict |
|---|---|---|---|---|---|---|---|
| p44r1 | −1.778611 | ✅ | 94.165583 | ❌ | 3.031568 | ❌ | FAIL |
| p44r2 | 2.999179 | ❌ | 111.692960 | ❌ | 5.014463 | ❌ | FAIL |
| p44r3 | 2.361009 | ❌ | 116.175456 | ❌ | 1.742295 | ✅ | FAIL |
| p44r4 | 6.673764 | ❌ | 207.327580 | ❌ | 7.697923 | ❌ | FAIL |
| p44r5 | 7.537539 | ❌ | 221.943024 | ❌ | 6.032071 | ❌ | FAIL |
| p49r01 | −0.154504 | ✅ | 88.582956 | ❌ | 0.869475 | ✅ | FAIL |

These match Phases 46/47/49/52 exactly. The **mean** metric fails in 4/6 runs and **median-dev** in 4/6 — the unresolved marginal-shift signals this phase targets. (The worst-case gate is handled in Phase 52 and is not revisited here.)

---

## 4. Design and unit of analysis

At the replicate level the schedule is a 2 × 2 with **3 replicates per cell**:

| | first position | second position |
|---|---|---|
| MINIMAL | even reps (0,2,4) | odd reps (1,3,5) |
| INSTRUMENTED | odd reps (1,3,5) | even reps (0,2,4) |

Per-replicate paired delta `d[i] = median(INSTRUMENTED_i) − median(MINIMAL_i)`:
- `d_even = INST(2nd) − MIN(1st)`, `d_odd = INST(1st) − MIN(2nd)`.
- **Difference-in-differences** `DID = mean(d_even) − mean(d_odd)`.

**Unit of analysis = the replicate (block).** The 50 iterations inside a block are repeated measures, **not** 50 independent executions; iteration-level values are used only inside per-replicate robust summaries (median / 10 % trimmed mean), and all inference uses the six replicates. Robust summaries are used because the timings are heavy-tailed (Phase 52: excess kurtosis 0.6–12.4).

**Key algebraic property:** `DID = (MIN 2nd − 1st) + (INST 2nd − 1st)` (verified numerically for every run). Under a drift that is **common to both conditions within a replicate** (a function of replicate index only), `d[i]` is unchanged, so **`DID` is invariant to additive common-mode drift** — it estimates `2 ×` any condition-position effect. The two within-condition "position effects" (MIN 2nd−1st, INST 2nd−1st) are **not** drift-invariant, because they compare the same condition across different replicate indices.

---

## 5. Position-group robust summaries

Condition × position cells (µs; descriptive only — cells pool dependent iterations, so use the replicate-level table in §6 and the DID in §7 for inference):

| Run | MIN 1st median | MIN 2nd median | INST 1st median | INST 2nd median | MIN 1st trim10 | MIN 2nd trim10 | INST 1st trim10 | INST 2nd trim10 |
|---|---|---|---|---|---|---|---|---|
| p44r1 | 16260.2 | 15456.4 | 14958.3 | 15607.7 | 15913.4 | 14776.2 | 14693.9 | 15341.0 |
| p44r2 | 14686.5 | 14792.9 | 15535.0 | 15451.9 | 14183.5 | 14613.5 | 15002.8 | 14653.1 |
| p44r3 | 14561.5 | 15595.1 | 15610.0 | 15629.8 | 13951.8 | 14861.5 | 15062.5 | 14725.9 |
| p44r4 | 14222.5 | 14871.0 | 16086.0 | 15108.5 | 13937.2 | 14773.2 | 15514.1 | 15169.0 |
| p44r5 | 11658.5 | 15156.5 | 15268.6 | 15546.5 | 12738.5 | 15027.8 | 15250.6 | 15207.7 |
| p49r01 | 9378.4 | 9085.5 | 9202.1 | 9318.6 | 9720.4 | 9191.6 | 9399.3 | 9400.6 |

Quantiles / IQR per condition × position cell (µs; `p25 / p75 / iqr`):

| Run | MIN 1st | MIN 2nd | INST 1st | INST 2nd |
|---|---|---|---|---|
| p44r1 | 13852.3 / 18183.1 / 4330.7 | 10687.5 / 17599.8 / 6912.4 | 11241.3 / 17243.7 / 6002.4 | 12360.4 / 17815.7 / 5455.3 |
| p44r2 | 10326.8 / 17319.5 / 6992.7 | 12833.1 / 16582.2 / 3749.0 | 12683.2 / 17120.7 / 4437.4 | 11254.9 / 16913.3 / 5658.4 |
| p44r3 | 10079.8 / 17154.8 / 7075.0 | 11874.7 / 17032.7 / 5158.0 | 11690.7 / 17336.0 / 5645.3 | 11838.8 / 16729.0 / 4890.3 |
| p44r4 | 9957.6 / 18075.7 / 8118.1 | 10933.9 / 17853.9 / 6920.0 | 10686.5 / 19296.2 / 8609.7 | 11699.2 / 17998.7 / 6299.5 |
| p44r5 | 9459.7 / 16245.6 / 6786.0 | 10906.9 / 18040.6 / 7133.8 | 10922.2 / 19153.9 / 8231.6 | 11981.4 / 17689.6 / 5708.2 |
| p49r01 | 9021.7 / 10599.3 / 1577.6 | 8856.5 / 9471.2 / 614.7 | 8949.0 / 9788.0 / 839.0 | 9064.8 / 9719.0 / 654.3 |

The IQRs are wide and overlapping across all four cells (session A IQRs ≈ 3.7–8.6 ms; session B ≈ 0.6–1.6 ms), consistent with the heavy-tailed, drift-contaminated spread; they show no order-specific separation.

Condition-specific position changes (replicate-level means, µs):

| Run | MIN 2nd − 1st | INST 2nd − 1st |
|---|---|---|
| p44r1 | −1477.5 | +729.9 |
| p44r2 | +413.5 | +32.1 |
| p44r3 | +237.0 | −132.0 |
| p44r4 | +884.4 | −843.2 |
| p44r5 | +2435.5 | −339.7 |
| p49r01 | −533.7 | +20.0 |

The two within-condition changes have **opposite signs in 5 of 6 runs** and vary by hundreds to ~2400 µs in both directions — the signature of drift/heterogeneity rather than a one-directional position shift. (They are also confounded by the strong within-run drift documented in §7.)

Per-replicate medians (µs) underlying `d[i]`:

| Run | MIN medians (reps 0..5) | INST medians (reps 0..5) | deltas (µs) |
|---|---|---|---|
| p44r1 | 13364.8, 9855.1, 17833.9, 18060.3, 17060.7, 15911.4 | 11183.5, 10046.5, 18119.3, 17398.4, 16189.1, 15857.3 | −2181.3, +191.4, +285.4, −661.9, −871.6, −54.0 |
| p44r2 | 10169.9, 10844.1, 14270.7, 16402.7, 17105.0, 15539.2 | 10113.9, 10419.6, 17585.3, 16677.7, 15718.8, 16224.4 | −56.0, −424.5, +3314.6, +275.0, −1386.2, +685.2 |
| p44r3 | 10478.6, 9972.0, 14472.4, 16585.8, 17079.0, 16183.1 | 10353.7, 10352.9, 16299.5, 16656.8, 16424.5, 16464.1 | −124.9, +380.9, +1827.1, +71.0, −654.5, +280.9 |
| p44r4 | 10096.5, 9920.4, 12637.9, 17828.8, 17879.9, 15518.2 | 10559.3, 10204.8, 17601.7, 17330.3, 16481.7, 19637.1 | +462.8, +284.4, +4963.8, −498.5, −1398.2, +4118.9 |
| p44r5 | 9355.0, 9946.2, 10504.6, 16324.0, 17297.0, 18192.9 | 10576.8, 9359.6, 17421.0, 17519.5, 16972.1, 19109.8 | +1221.8, −586.6, +6916.4, +1195.5, −324.9, +916.9 |
| p49r01 | 10913.2, 9366.9, 9141.4, 9101.1, 8884.7, 8870.3 | 9564.2, 9810.8, 9318.6, 9067.9, 9003.8, 8947.9 | −1349.0, +443.9, +177.2, −33.2, +119.1, +77.5 |

The per-replicate deltas are dominated by a few large values (e.g. p44r5 rep2 = +6916 µs; p44r4 rep5 = +4119 µs) with the rest scattered around zero — heavy heterogeneity, not a consistent condition offset.

---

## 6. Order test (replicate level)

**Primary statistic (drift-robust):** `DID = mean(d_even) − mean(d_odd)`, which estimates `2 ×` any condition-position effect. **Test:** exact permutation — under the null of no parity/position association the six replicate deltas are exchangeable with respect to which three are labelled "even"; all `C(6,3) = 20` assignments are enumerated. Two-sided `p = #{|DID_perm| ≥ |DID_obs|}/20`. **Assumptions:** the per-replicate deltas are treated as exchangeable measurements and only the parity labels are permuted; no iteration-level independence is assumed. **Power:** with 20 permutations the smallest attainable two-sided p is 0.10, so this test can only detect very strong effects.

| Run | mean Δ even (µs) | mean Δ odd (µs) | **DID (µs)** | DID/2 (µs) | k ≥ obs | **p (exact)** | bootstrap 95 % CI for DID (µs) | positive deltas |
|---|---|---|---|---|---|---|---|---|
| p44r1 | −545.2 | +202.4 | **−747.6** | −373.8 | 10/20 | 0.50 | [−1936.1, +460.2] | 2/6 |
| p44r2 | +737.2 | +291.5 | **+445.6** | +222.8 | 18/20 | 0.90 | [−1564.7, +2999.3] | 3/6 |
| p44r3 | +591.0 | +486.0 | **+105.0** | +52.5 | 20/20 | 1.00 | [−865.5, +1549.5] | 4/6 |
| p44r4 | +721.8 | +680.6 | **+41.2** | +20.6 | 20/20 | 1.00 | [−3618.6, +3701.0] | 4/6 |
| p44r5 | +862.7 | −1233.1 | **+2095.8** | +1047.9 | 8/20 | 0.40 | [−912.0, +6314.9] | 4/6 |
| p49r01 | −227.6 | +285.9 | **−513.6** | −256.8 | 12/20 | 0.60 | [−1474.8, +154.2] | 4/6 |

- **DID signs are inconsistent** (4 positive, 2 negative) and the permutation p-values are 0.40–1.00 (minimum 0.40, observed for the largest |DID|, p44r5). No run approaches the achievable 0.10 floor, let alone 0.05.
- **Every bootstrap 95 % CI for DID spans zero**, including those with width up to ~7 ms (n = 3 per group; bootstrap over replicates is itself very wide and should be read as a coarse interval, not a precise CI).
- Direction of the condition effect itself is not stable: condition effect (mean INST median − mean MIN median) is −548.6 (r1), +401.4 (r2), +296.7 (r3), +1322.2 (r4), +1556.5 (r5), −94.1 (r6) µs.

**No statistically supportable condition‑position effect** is present in any capture. Reporting a pooled p-value across runs is not done: the six captures are temporally dependent (five from one session) and are not independent trials.

---

## 7. Within-run drift — the dominant, confounded order signal

Because replicates execute sequentially, **replicate index is the run's internal time order**. Regressing each condition's per-replicate median on replicate index:

| Run | MIN drift (µs/rep) | MIN r | MIN last3/first3 | INST drift (µs/rep) | INST r | INST last3/first3 |
|---|---|---|---|---|---|---|
| p44r1 | +987.9 | +0.58 | 1.243 | +1173.6 | +0.65 | 1.257 |
| p44r2 | +1364.6 | +0.88 | 1.390 | +1301.2 | +0.74 | 1.276 |
| p44r3 | +1484.5 | +0.88 | 1.427 | +1403.5 | +0.83 | 1.339 |
| p44r4 | +1605.1 | +0.83 | 1.569 | +1827.1 | +0.87 | 1.393 |
| p44r5 | +2058.9 | +0.94 | 1.738 | +1874.3 | +0.85 | 1.435 |
| p49r01 | −334.3 | −0.81 | 0.913 | −164.4 | −0.89 | 0.942 |

**Session A (p44r1–r5): both conditions slow substantially across the run** (last-three replicates are 24–74 % slower than the first three; per-replicate slope up to ≈ +2.1 ms/replicate). **Session B (p49r01): both conditions speed up** (last three ≈ 9 % faster; slope ≈ −0.3 ms/rep). Crucially, **within a run the two conditions drift in the same direction with similar magnitude** — this is a temporal/session drift, not a condition-specific effect.

Implications:
- The **within-condition position effects** in §5 compare the same condition across different replicate indices and are therefore **contaminated by this drift**; they are not interpretable as a clean "position" effect.
- The **DID** cancels any additive common-mode drift (it depends only on `d[i] = INST_i − MIN_i`), so the DID result in §6 is the drift-robust statement about condition position — and it is null.
- Because the drift affects both conditions together, it **by itself does not create a condition difference**; the mean/median differences (§3) are not explained by a common-mode drift either. What is clear is that the runs are **strongly non-stationary**, so a stationary "condition vs order" decomposition is not well identified here.

---

## 8. Identifiability limits (explicit)

1. **Condition and execution position are perfectly confounded within each replicate**: every replicate always runs one condition first and the other second. Only *across* replicates (3 per cell) can position be separated from condition — with n = 3 per cell.
2. **The CSV has no timestamps and no chronology column.** The relative wall-clock span between a replicate's two condition blocks is not recoverable, and because blocks are sequential, iteration index does not align the two conditions in time.
3. **Replicate index carries the within-run drift**, and the two order groups occupy interleaved indices (even {0,2,4} vs odd {1,3,5}); with a strong, non-linear drift this is a serious confound for any index-based contrast (mitigated for the DID, which cancels common-mode additive drift, but not for higher-order drift).
4. **Power is minimal:** 6 replicate blocks, 3 per group, 20 permutations (min two-sided p = 0.10); and only two sessions (A and B), each internally dependent.
5. Therefore this analysis **may identify an order-associated pattern but cannot establish causation, and cannot fully separate instrumentation from temporal drift.**

---

## 9. Cross-check against Phase 52

Phase 52 tested the **worst-case** statistic with shuffle/block nulls that **hold the marginal distributions fixed**; it explicitly stated it could **not** address the mean/median metric failures, and it did not. Phase 53 targets those failures directly. Consistent with Phase 52, this phase **does not** reinterpret the worst-case null result as making the mean/median failures harmless — they remain real threshold failures (4/6 runs each). What Phase 53 adds: those failures show **no supportable dependence on condition execution position** (DID null, sign-inconsistent), and they coexist with a **large within-run temporal drift** — consistent with Phase 52's residual "temporal dependence" caveat, but not explicable as a clean condition-position effect.

---

## 10. Conclusion

**Inconclusive** regarding the specific claim that the mean/median differences are attributable to **condition execution order**.

- The **drift-robust** condition-order contrast (`DID`) is **null and sign-inconsistent** across all six runs (p = 0.40–1.00; all bootstrap CIs span zero): the data **do not support** a condition-position effect on the mean/median difference.
- The data **do** exhibit a strong, consistent **within-run temporal drift** (both conditions slow in session A, speed up in session B) — an order-associated pattern, but **common-mode**, not condition-specific.
- Because condition and position are confounded, power is minimal (3 replicates/cell, 20 permutations), there are no timestamps, and the drift is large and non-linear, an order contribution **cannot be excluded** either. The mean/median differences therefore cannot be attributed to condition execution order on this evidence, nor can such a contribution be ruled out.

No causal claim is made from these observational timing data.

---

## 11. Guardrails

Read-only; no source/CMake/validator/historical-CSV edits; no build/launch/benchmark/measurement; no threshold/formula changes; no deletion/move/overwrite of existing artifacts; no commits/pushes; no G7/G7CAM; **M0 = FAIL and M1 = LOCKED preserved**. Protected artifacts re-verified unchanged after the analysis (source `aeb31eb2…`, CMake `575fe264…`, validator `9f6d6c29…`, exe `f50fda5a…`, Phase 36 CSV `a09a0d3c…`; all six input CSVs unchanged).