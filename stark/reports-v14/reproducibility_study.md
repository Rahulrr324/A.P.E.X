# STARK M0 v1.5 — G7 Reproducibility Investigation

Raw data: `g7_reproducibility_samples.log` (real, unedited). Thresholds unchanged:
**timing 15%, memory-bandwidth (B3/B5) 20%**.

## 1. Configuration and workload identity — confirmed identical

E1 and E5 are generated with the same `make_cfg()` and the same model. Their
`configuration` blocks are **byte-identical** on B6/B7/B9:

```
{"batch_size":1,"benchmark_id":"B6","measurement_count":10,"sequence_length":0,
 "thread_count":0,"warmup_count":3,"workload_params":{"logical_params":"262912","model":"TINY-DENSE-2L"}}
```

So the G7 failure is **not** a configuration mismatch. Independence is genuine
(distinct `record_id`, distinct process invocations).

## 2. Measurement policy (recorded)

| Parameter | Value |
|---|---|
| warmup_count | 3 |
| measurement_count | 10 |
| thread_count | 0 (unpinned, natural scheduling) |
| batch_size | 1 |
| precision | FP32 |
| deterministic_mode_requested | true |
| clock | `std::chrono::steady_clock` |

The timed B6 operation is a single **TINY-DENSE-2L forward pass** whose median is
~180–400 µs — the same order of magnitude as OS scheduling jitter and timer wake-up.

## 3. Raw per-sample evidence (5×E1 + 5×E5 fresh runs, same build)

One disturbed run vs one clean run of the SAME configuration:

```
E1 run1 B6 samples (us): 343.9 345.5 371.8 584.9 480.0 512.4 425.5 427.4 363.9 368.6   median 398.65  stdev 80.84
E5 run1 B6 samples (us): 236.9 246.5 249.5 245.3 239.0 252.7 225.1 221.2 228.3 235.9   median 237.95  stdev 10.66
```

The E5 run is tight (221–253 µs, stdev 10.7 µs). The E1 run is bimodal: several
samples jump to 480–585 µs. That is a **preemption/interference signature**, not a
property of the workload.

## 4. Variation across independent runs

| benchmark | min median | max median | spread |
|---|---|---|---|
| B6 (inference) | 179.2 µs | 398.7 µs | **55.05%** |
| B7 (model load) | 2929.9 µs | 5712.5 µs | **48.71%** |
| B9 (stability) | 185.1 µs | 428.0 µs | **56.76%** |

## 5. Host state (where available)

- CPU: 12th Gen Intel Core i5-12450H, 8 cores / 12 logical, MaxClockSpeed 2000 MHz,
  `LoadPercentage` 31–40% (laptop, power/thermal-managed).
- Competing processes (cumulative CPU): `find` (≈6636 s), several `chrome`
  processes (≈2300 / 849 / 817 / 281 s). A background machine load was present
  throughout.

Hmm — the `find` CPU figure is cumulative, so it does not by itself prove
concurrent load; the chrome processes and the 31–40% aggregate load do indicate a
shared, non-idle host.

## 6. Classification

The exceedance is **environmental, compounded by a methodological limit**:

- **Environmental (primary):** a ~200 µs workload on a power/thermally managed laptop
  with background load and unpinned threads. Preemption injects 2–3× outliers into a
  10-sample window, moving the median by tens of percent.
- **Methodological (contributing):** the Phase-1 policy collects only 10 timed samples
  with 3 warmups, thread_count=0 (unpinned), batch_size=1, and reports the **median**.
  With this few samples the median is not robust to a handful of preempted iterations.
- **Not unresolved-but-mysterious:** the mechanism is identified; what is *not*
  satisfied is the specified 15% tolerance at this workload size on this host.

## 7. Conclusion (no threshold change, no data edited)

The 15% G7 tolerance is **not achieved** for the tiny-model benchmarks on this machine
under the current measurement policy. Per the task's stop conditions, **G7 is reported
FAIL** and M0 acceptance is **not claimed**. Raising sample count, pinning threads, or
taking a robust low-percentile statistic could plausibly reduce variance, but that would
change the Phase-1 measurement policy and the gate definition — out of scope for this
corrective task. No measurement was fabricated or edited to force a pass.
