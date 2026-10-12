# Root cause analysis for G7 failure (frozen 30-record campaign)

## Classification

**ENVIRONMENT REPRODUCIBILITY LIMITATION**

This determination is based on the frozen 30-record G7 campaign and the source trace of the benchmark implementation. It is not a claim that the code is perfectly controlled; it is a classification of what the evidence does and does not support.

## 1. Concrete evidence for the classification

### 1.1 The failures are cross-benchmark and cross-operation

The worst-case pairwise differences are not isolated to one benchmark:
- B6 worst pair: 64.84% (189.55 us vs 539.05 us)
- B7 worst pair: 56.19% (2983.00 us vs 6808.60 us)
- B9 worst pair: 67.04% (187.60 us vs 569.20 us)

These are three different operations (B6 forward, B7 deserialize+IO, B9 forward+reference check), yet the same campaign exhibits large spreads in each. That pattern is more consistent with a shared execution-environment effect than with a defect in one benchmark's arithmetic.

### 1.2 The campaign ordering is strongly run-correlated

The strongest signal is that runs are clustered by `run_suffix`:
- `...-run1` is the fastest cluster for B6, B7, and B9.
- `...-run2` is among the slowest clusters for B6, B7, and B9.
- `...-run3` is also slow for B6, B7, and B9.
- `...-run5` is the slowest for B9 and slow for B7 and B6.

Using a within-benchmark min/max normalization, the normalized positions are:
- run1: B6 0.12, B7 0.01, B9 0.01  (fast across all three)
- run2: B6 1.00, B7 1.00, B9 0.96  (slow across all three)
- run3: B6 0.96, B7 0.96, B9 0.81  (slow across all three)
- run4: B6 0.63, B7 0.92, B9 0.55  (mixed but mostly slow)
- run5: B6 0.77, B7 0.88, B9 1.00  (slow across all three)

That is not a single-benchmark outlier. The same campaign execution is slow (or fast) across B6, B7, and B9 simultaneously. The strongest interpretation is that the run-time environment, not one benchmark's code, is driving the spread.

### 1.3 The timed operations are very short

Median wall durations are small:
- B6: 189.55 us to 539.05 us
- B9: 187.60 us to 569.20 us
- B7: 2983.00 us to 6808.60 us

For B6/B9, the median is below 1 ms and the spread includes both ~200 us and ~550 us measurements. At that scale:
- steady_clock wall timing has non-trivial overhead and granularity.
- OS scheduling jitter and processor frequency state can change the measured wall time by a large fraction of the operation.
- thread migration between cores can expose different turbo/C-state behavior even when thread_count=1 in user space.

### 1.4 Affinity was not proven

The campaign recorded `thread_count=1` and a provenance string claiming "single-thread pinned (thread_count=1)". The traced source shows:
- `BenchConfig::thread_count` is set to 1.
- `run_benchmark()` does not call any OS affinity API.
- `HardwareProfiler` does not call any pinning API and does not query the actual thread/process affinity mask.
- There is no verification of the actual affinity mask before/after timing.

So the campaign cannot prove that the same core was used across runs or that the thread was prevented from migrating. The recorded affinity is an assertion, not evidence.

### 1.5 No implementation defect was found in the timed core

The traced code shows:
- `TinyDenseModel::forward()` is deterministic on CPU FP32 with fixed weights/input.
- No allocation, IO, thread creation, or async in the timed region for B6/B9.
- B7 timed region is IO+deserialization, which is inherently more variable and also includes file reads and allocation; that is a different operation and more variable by construction.
- The harness correctly separates warmup from measurement.
- The harness stores raw samples and computes statistics from them.

There is no evidence of lazy init inside timed regions, hidden state leaking across runs at the model level, or a timer bug.

## 2. Evidence that is insufficient

### 2.1 What is not recorded

The campaign does not contain:
- actual OS/thread affinity mask before or during timing
- CPU frequency or P-state during timing
- turbo state
- thermal state
- process priority
- background load measurements
- cycle counts
- timer overhead measurements
- per-sample scheduling information

Because these are absent, the report cannot prove the exact mechanism. The conclusion is probabilistic/diagnostic, not proven-by-direct-measurement.

### 2.2 What cannot be ruled out

- Thermal/frequency scaling across the ~2 minute campaign window.
- OS scheduling differences across runs.
- Page cache / file cache effects for B7.
- Timer granularity effects for the sub-millisecond B6/B9 medians.
- Machine state differences between the first and later runs.

None of these is proven, but each is plausible and none is ruled out by the existing evidence.

## 3. Why this is not classified as a benchmark implementation defect

A benchmark implementation defect would require evidence that the benchmark produces inconsistent measurements because of a code problem under controlled conditions. The trace shows:
- deterministic forward math
- correct warmup/measurement separation
- raw sample retention
- no GPU/OpenMP/async in the timed region

The large spreads appear for three different operations and correlate by run, with the same code/configuration. That is more consistent with uncontrolled environment variability than with an arithmetic or logic defect in the benchmarks.

There is one real documentation/instrumentation defect, but it is a campaign-control defect, not a benchmark-computation defect:
- The campaign claims OS-level pinning in provenance without implementing or verifying it.
That weakens the claim of controlled placement, but it does not show the benchmark math or harness timer is wrong.

## 4. Why this is not classified as frozen-contract incompatibility yet

The frozen contract permits configurable sample count, warmup, thread_count, and deterministic seeds, and it requires same-configuration median reproducibility across independent repeats with a 15% tolerance. None of that inherently makes reproducibility impossible.

What is missing is proof that the environment can satisfy that requirement under the controls actually enforced. On this machine, with one long-running process, a wall-clock timer for sub-millisecond ops, and no proven affinity pinning, the campaign did not achieve 15% agreement. That is an environment-control limitation under the current campaign, not necessarily proof that the contract is incompatible with the machine under any permissible control.

So the honest classification is environment reproducibility limitation, with a note that a stronger admissible control (proven pinned affinity, better timing, or process-per-run isolation, if all permitted) might change the result, but the present evidence does not establish that.

## 5. Is another G7 campaign justified?

### Not as a blind rerun

No. Rerunning the same campaign design and hoping for a different result is not justified by the evidence.

### Possibly justified only as a targeted control-improvement study

A further campaign could be justified only if it first fixes the concrete instrumentation/control gap and then re-measures under a clearly frozen design. The candidate control improvements are:
- Implement and verify actual OS affinity pinning, and record the actual mask.
- If the frozen spec permits, use a fresh process per independent run to reduce shared-process environment carryover.
- If the frozen spec permits, record CPU frequency/power/thermal state where observable.
- If the frozen spec permits, quantify and possibly reduce timer overhead for sub-millisecond measurements.

Any such campaign must be designed and frozen before measurement and must not change thresholds, formula, groups, medians, benchmark identity, or acceptance logic.

## 6. Does M0 remain FAIL?

Yes.

G7 remains failed on the frozen 30-record campaign:
- B6 max pairwise 64.84% > 15%
- B7 max pairwise 56.19% > 15%
- B9 max pairwise 67.04% > 15%

Production aggregator and independent calculator agree.

## 7. Does M1 remain LOCKED?

Yes.

No gate criteria were changed and no new passing G7 evidence was produced.
