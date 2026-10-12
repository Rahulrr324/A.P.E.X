# APEX M0 v2.1 — G7 Root-Cause Analysis

**Date:** 2026-10-05
**Scope:** Explain *why* the nine recovered records fail G7. No threshold, grouping rule, sample, or record was changed.

**Bottom line:** The G7 failure is **real, reproducible measurement variance**, not a data defect and not a grouping artifact. The frozen rule (±15% median agreement between repeats at n=10 samples, warmup=3) is statistically too tight for this harness on this machine. The existing historical set **permanently fails** G7 and cannot be repaired by reanalysis.

---

## 1. Per-record statistics (the nine recovered records)

Recomputed independently from the stored raw sample arrays (median convention identical to `compute_statistics()`: linear interpolation, `pos = 0.5*(n-1)`).

| record_id | bench | build | n | median (µs) | mean (µs) | min (µs) | max (µs) | stdev (µs) | CV % | MAD (µs) | stored==recomputed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P1-E1-B6-24899 | B6 | Debug | 10 | 978.30 | 1055.15 | 931.40 | 1394.10 | 161.99 | 15.35 | 42.25 | yes |
| P1-E1-B6-57493 | B6 | Debug | 10 | 999.50 | 1074.43 | 933.80 | 1352.90 | 152.96 | 14.24 | 64.00 | yes |
| P1-E1-B7-24899 | B7 | Debug | 10 | 58168.25 | 58495.78 | 49122.50 | 69968.50 | 7072.64 | 12.09 | 6983.05 | yes |
| P1-E1-B7-57493 | B7 | Debug | 10 | 60302.85 | 62489.51 | 47972.20 | 79406.40 | 10222.14 | 16.36 | 6900.75 | yes |
| P1-E1-B9-24899 | B9 | Debug | 10 | 1449.60 | 1467.07 | 944.60 | 2204.40 | 397.75 | 27.11 | 366.20 | yes |
| P1-E1-B9-57493 | B9 | Debug | 10 | 2003.60 | 1947.40 | 1697.00 | 2013.00 | 112.78 | 5.79 | 8.10 | yes |
| P1-E5-B6-90937 | B6 | Debug | 10 | 1166.50 | 1201.94 | 1000.70 | 1559.20 | 168.16 | 13.99 | 72.70 | yes |
| P1-E5-B7-90937 | B7 | Debug | 10 | 47479.75 | 54477.53 | 47068.80 | 82587.00 | 12516.47 | 22.98 | 293.90 | yes |
| P1-E5-B9-90937 | B9 | Debug | 10 | 1041.15 | 1093.23 | 935.40 | 1608.70 | 193.14 | 17.67 | 91.80 | yes |

**Observations**

- **Every stored median equals its independently recomputed median.** Median-integrity (0.001%) is not the problem.
- **Intra-run coefficient of variation is large** (5.8%–27.1%). Within a single run of 10 samples the data are already very noisy.
- All nine were produced by a **Debug** build (`hardware.build_type = Debug`), so build-type differences are *not* the cause.
- All had `thread_count = 0` (no affinity/pinning), `warmup_count = 3` (the minimum allowed), `measurement_count = 10` (the minimum allowed).
- `created_utc` shows the records split into two batches ~23 s apart (`…:14–15` for the `57493` set; `…:37–39` for the `24899`/`90937` set), i.e. separate process invocations on a shared, actively-used machine.
- Reference timing metadata: `determinism.deterministic_mode_requested = true`, `available = true`, and for the latency benchmarks `outputs_bit_identical = true` — so the *computation* is deterministic; only the *timing* varies. (B7 load-time records have `outputs_bit_identical = null`, as designed.)

`stored_median`/`recomputed_median` are identical for all nine records (see the JSON gate report G7.json).

---

## 2. Fresh controlled repeats (new measurements, separate directory)

To test whether the variance is intrinsic to the method, six fresh E1 and six fresh E5 runs were executed with the **current Release binary**, on the same machine, same serialized configuration, sequentially, writing to `archive_recovery/v21_diagnostics/` (18 benchmark records + weights). Full output: `reports/v2.1-aggregator/g7_fresh_repeats.txt`.

| Group | runs | median spread (max−min)/max | intra-run CV range | all-pairs > 15% | G7 verdict |
|---|---|---|---|---|---|
| B6 | 12 | **59.06%** | 1.7%–47.2% | 35 / 66 | FAIL |
| B7 | 12 | **19.03%** | 9.2%–14.6% | 5 / 66 | FAIL |
| B9 | 12 | **59.78%** | 3.3%–34.8% | 19 / 66 | FAIL |

This is decisive: freshly generated, uncontaminated repeats of the *same* configuration on the *same* machine **also fail G7**. The historical failure is therefore a property of the measurement methodology, not of the recovered files.

Note the fresh absolute levels differ from the historical ones (e.g. fresh B6 ≈ 420 µs vs historical ≈ 1000 µs; fresh B7 ≈ 6.9 ms vs historical ≈ 55 ms). The machine was in a different load/thermal state, but the *variance pattern is identical* — which is exactly what the ±15% tolerance is unable to absorb.

---

## 3. Cause assessment

Ranked by supporting evidence.

### 3.1 Insufficient sampling: n=10 is too small for the observed variance — **primary cause**
With CV ≈ c and n samples, the standard error of the median is ≈ `1.253·σ/√n = 0.396·c`. For c = 15% that is ≈ 5.9%; the difference between two such medians has an expected magnitude ≈ 8.4% (with a heavy right tail). A 15% gate is therefore only ≈ 1.8σ — it is exceeded routinely. The measured CVs (up to 27% historical, 47% fresh) make over-15% disagreements the norm. **The tolerance is not wrong; the sample size is.**

### 3.2 Scheduler / timer jitter on sub-millisecond operations — **major contributor**
B6/B9 measure a single tiny model forward pass at ~200 µs–1.2 ms. At this scale OS scheduler quantum, interrupt handling, and the `steady_clock` read overhead are a large fraction of each sample. Fresh B6 intra-run CV reaches 47%. The max/median ratio within a run reaches 1.4–2.2× (e.g. E1-B9-24899 max 2204 µs vs median 1450 µs).

### 3.3 No CPU affinity and no power/thermal pinning — **contributor**
`thread_count = 0` means the workload is not pinned and the process can migrate across cores. There is no recorded power plan, no frequency pinning, and no thermal state. On a laptop (i5-12450H, 12 logical / 8 physical cores) turbo/thermal drift moves the effective clock between samples and between runs.

### 3.4 Warm-up is minimal (3 iterations) — **contributor**
Spec allows warm-up ≥ 3; the harness uses exactly 3. For a ~200–1000 µs op, 3 warm-up iterations are unlikely to reach a steady cache/frequency state before the 10 timed samples begin.

### 3.5 Historical batch/time separation — **contributor**
The nine records were produced in two batches ~23 s apart. Between batches the machine's load/thermal state changed, adding a *systematic* offset on top of the per-sample noise (e.g. B9: 1449.6 vs 2003.6 µs — a 27.65% offset between batches).

### 3.6 Genuine execution differences despite identical serialized config — **not supported as a distinct cause**
The serialized configuration is identical within each benchmark group, and `determinism.outputs_bit_identical = true` for B6/B9, so the *computations* are identical. Only timing differs. There is no evidence of a workload-initialization/teardown difference beyond the noise sources above.

### 3.7 Cache state (B7 warm vs cold) — **minor / controlled**
B7 is recorded with `mode = warm_cache` in all runs, so cold-cache effects are controlled; B7's variance comes from the same scheduler/frequency sources, not cache transitions.

---

## 4. Remediation choices (for FUTURE measurements only — none applied to history)

These are options for the next measurement cycle; **none can be applied retroactively to the frozen historical set**, and no reanalysis can rescue it.

1. **Increase `measurement_count`** from 10 to e.g. 100–200 (the spec's B9 already uses 200 repeats). SE scales with 1/√n: going 10→100 cuts the median's sampling error by ~3.2×, which is the single most effective change. The spec already marks iteration count "configurable".
2. **Increase warm-up** beyond 3 iterations (e.g. ≥10) to reach a steady frequency/cache state.
3. **Pin affinity and set a fixed power plan**; record power plan / frequency as metadata so cross-run comparability is explicit.
4. **Use a lower-variance timing method** — time a batch of K forward passes and divide, instead of timing single passes at scheduler granularity.
5. **Re-open the ±15% tolerance** — **NOT permitted.** The frozen spec states the tolerance is defined once and "later phases may not loosen it silently". This option is listed only to be explicitly rejected.
6. **Accept the historical G7 FAIL.** Under the frozen rule and the frozen data, this is the only outcome consistent with the evidence.

---

## 5. Conclusion

- The historical G7 failure is **genuine and reproducible**; fresh repeats fail identically.
- Root cause: **10-sample medians with 6–47% intra-run CV on a shared, un-pinned, turbo-scaling laptop**, i.e. a statistical/duty-cycle problem, **not** corrupted data, a grouping error, or a threshold that was ever met before.
- Stored medians are all internally consistent (0.001% check passes everywhere).
- **No threshold, grouping key, sample, or record was altered.** The frozen G7 rule makes the existing historical set fail **permanently**.
- Remediation is possible only for future measurements (larger n, longer warm-up, pinning, batched timing). That does not change v2.1's G7 = **FAIL**.
