# G7 Resolution Campaign — Report

## A. Frozen contract

Source: `design/V009_phase1_M0_specification.md` (frozen).

Requirements used, exactly as implemented by the production harness and aggregator:

- benchmark identity/configuration: `BenchConfig` serialized block; B6/B7/B9; TINY-DENSE-2L where applicable
- same-configuration comparison: group by serialized configuration; E1 and E5 are independent repeats of the same CPU FP32 configuration
- minimum sample count: 10
- warmup count: >=3
- number of independent runs/groups: at least 2 valid independent executions per same-configuration group (all-pairs rule)
- CPU affinity requirements: thread_count=1; OS-level pinning not independently asserted
- timing measurement method: steady_clock wall timing (harness)
- median calculation: linear interpolation on sorted samples at quantile 0.5 using index 0.5*(n-1)
- symmetric relative difference: abs(x-y)/max(abs(x),abs(y))*100, with 0/0 -> 0 and one-zero -> 100
- tolerance thresholds: timing 15%, bandwidth 20% (B3/B5)
- required recorded metadata: record_id, experiment_id, configuration, raw samples, median, statistics, provenance, hardware/ software blocks
- what constitutes a valid baseline: PASSED benchmark/baseline record with computed statistics, >=10 finite samples, and a median consistent with the recomputed median within 0.001% relative tolerance

## B. Campaign design

Frozen before measurement:

- n = 50 samples per independent execution (>=10 spec floor)
- warmup = 10 iterations per execution (>=3 spec floor)
- independent runs = 5 per experiment_id, for both E1 and E5
- thread_count = 1
- batch_size = 1, sequence_length = 0
- deterministic_mode_requested = true for B6 and B9
- 30s delay between independent runs
- experiment_ids: E1 and E5
- benchmarks: B6, B7, B9

Rationale: n=50 and warmup=10 are permitted by the spec and substantially exceed the historical minima, to test whether tighter within-execution measurement reduces the observed run-to-run spread.

## C. Environment

- CPU: 12th Gen Intel(R) Core(TM) i5-12450H (from embedded PROFILE snapshot in earlier evidence)
- OS/build: from embedded hardware/software blocks in each record
- compiler/build: from embedded software blocks in each record
- thread_count: 1 (enforced by runner)
- thread_affinity: recorded as provenance; OS-level pinning not independently asserted
- power/performance state: not locked; thermal/frequency scaling may still occur
- background interference: not independently guaranteed

## D. Raw measurement summary

30 records produced: 10 per benchmark (5 E1 + 5 E5), each with 50 raw samples.

Summary:

- B6: 10 valid executions, 50 samples each, CV 28.67%
- B7: 10 valid executions, 50 samples each, CV 26.12%
- B9: 10 valid executions, 50 samples each, CV 32.46%

All raw samples stored; all medians independently recomputed and validated.

## E. Independent calculations

Independent calculator: `reports/g7-campaign/verify_g7.py`

Per benchmark (all-pairs symmetric relative difference):

- B6: max 64.84%, min 2.23% — FAIL
- B7: max 56.19%, min 0.55% — FAIL
- B9: max 67.04%, min 0.41% — FAIL

Stored medians matched recomputed medians within the 0.001% tolerance for all records used.

## F. Production aggregator result

Command: `aggregate --out build/g7-campaign`

Exit code: 1 (FAIL)

G7 verdict: FAIL

Representative aggregator G7 diagnostics:

- B6 medians differ 64.84% (allowed 15.00%) between runs 6 and 9
- B7 medians differ 56.19% (allowed 15.00%) between runs 1 and 9
- B9 medians differ 67.04% (allowed 15.00%) between runs 4 and 10

Output captured in: `reports/g7-campaign/aggregator_g7.txt`

## G. Historical comparison

The nine historical recovered records are unchanged and preserved. Their G7 failure remains recorded. A new current baseline does not retroactively make the historical nine pass.

## H. Final conclusion

**G7 REMAINS FAILED**

Under the frozen V009 contract and the controls permitted by it, the current baseline evidence does not satisfy the G7 ±15% all-pairs requirement for B6, B7, or B9. The controlled-variability hypothesis (larger n, longer warmup, inter-run spacing) was tested and did not resolve the spread.

This is a valid measurement outcome, not a threshold or configuration change.
