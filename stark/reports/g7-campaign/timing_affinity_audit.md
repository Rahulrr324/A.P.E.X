# Timing and affinity audit (G7 campaign, frozen)

## Timer implementation

Source: `src/phase1/bench/BenchmarkHarness.cpp`

- Timer type: `using Clock = std::chrono::steady_clock`
- Start: `auto t0 = Clock::now()` immediately before `op()`
- Stop: `auto t1 = Clock::now()` immediately after `op()`
- Conversion: `double sec = duration<double>(t1 - t0).count()`
- Sanity check: samples with `sec < 0.0` are discarded as non-monotonic.

### What is timed

- Exactly the `op()` call.
- Nothing else from the harness.

### What is not timed

- Warmup iterations.
- `compute_statistics()`.
- `sample_peak_memory()`.
- File IO outside B7 op (B6/B9 have no IO in op).
- Model construction / weight init (outside op).

### Timer quality observations

- `steady_clock` is the correct choice for wall duration; it is monotonic.
- The timer overhead is not directly measured by the harness.
- Timer granularity depends on the OS steady_clock implementation.
- The harness stores each raw sample as double seconds; no cycle counter is used.

### Timer correctness assessment

- There is no evidence of a timer bug in the traced code.
- The placement is correct: t0 before op, t1 after op, no extra work inside the timed region other than what `op()` itself does.
- The discipline of recording raw samples and computing statistics from them is correct.
- There is no evidence that warmup leaks into measurement: warmup and measurement loops are separate.

### Remaining timer uncertainty

- Timer overhead for very short operations can be material. B6 median is ~190–540 us; at that scale, timer overhead and scheduling can be a meaningful fraction of a sample.
- The harness does not measure or subtract timer overhead.
- The harness does not use a high-resolution CPU cycle counter, so it cannot isolate frequency-independent work from wall duration.

## Affinity implementation

Source: `src/phase1/bench/BenchmarkHarness.h`, `src/phase1/bench/BenchmarkHarness.cpp`, `src/phase1/campaign/G7Campaign.cpp`, `src/phase1/common/HardwareProfiler.cpp`

### What the campaign records

Each G7 campaign record carries:
- `configuration.thread_count = 1`
- `provenance.thread_affinity = "single-thread pinned (thread_count=1)"`

### What the code actually does

- `BenchConfig::thread_count` is set to 1 by the campaign.
- `RunBenchmark` does NOT use `thread_count` to set OS affinity.
- `HardwareProfiler` never sets thread or process affinity.
- There is no call to `SetThreadAffinityMask`, `SetProcessAffinityMask`, `SetThreadIdealProcessor`, `SetThreadGroupAffinity`, or any other pinning API in the traced Phase-1 source.
- There is no call to `GetThreadAffinityMask`/`GetProcessAffinityMask` to verify actual affinity.

### Assessment

- The harness stores `thread_count=1` as a configuration/policy field, but it is not enforced as an OS affinity constraint.
- The provenance string claims "single-thread pinned (thread_count=1)", but the evidence shows thread_count=1 is a user-space thread-count policy, not a verified OS affinity mask.
- Therefore the recorded affinity claim is an assertion, not a proven measurement.
- The campaign does not prove that the same physical core was used across runs, nor that the thread was prevented from migrating.

### Why this matters

- On a multi-core system with frequency scaling, thread migration and non-pinned scheduling can move a short benchmark between cores/P-costs and expose different turbo/frequency states.
- If affinity is not actually pinned, run-to-run variability can include scheduling-driven variation that is not intrinsic to the benchmark code.
- This is a campaign implementation limitation: the campaign cannot prove it controlled CPU placement.

## Timer + affinity interaction

- The combination that matters for G7 reproducibility is:
  - very short timed operations (B6 ~200–540 us, B9 ~190–570 us)
  - single-thread policy without enforced OS pinning
  - steady_clock wall timing without cycle counter
- In that regime, wall-clock medians can vary because the OS can schedule the thread differently across runs and the CPU can be at different performance states.
- This is consistent with the observed pattern: some runs are fast (e.g. B6 ~190 us, B9 ~190 us) and some runs are much slower (B6 ~540 us, B9 ~570 us), with the same code and same configuration.

## Shared-state audit

Traced sharing:

- `TinyDenseModel` is constructed per benchmark call in `G7Campaign.cpp`, so the model buffers are freshly allocated+initialized each time.
- `run_benchmark()` uses a fresh `samples` vector each call.
- The process is long-lived across all benchmark calls within a campaign run and across the 5-run loop.
- No thread pool, no global PRNG state inside the timed op, no CUDA context in the timed op on a CUDA-less build.
- `TinyDenseModel::forward()` is deterministic given fixed weights/input and CPU FP32 math.

Conclusion on shared state:
- There is no evidence of hidden mutable benchmark state that leaks across independent runs at the model level.
- The process-level environment (OS scheduling, CPU frequency, working-set state, page cache, file cache for B7) is shared by construction because it is one process.
- That environment sharing is normal for a single long-running process and is not itself a benchmark logic defect, but it can be a reproducibility problem when timing is short and placement is not pinned.

## Summary

Timing:
- Implementation looks correct.
- No demonstrated timer defect.
- Residual uncertainty from short operations + wall-clock timer + no overhead subtraction.

Affinity:
- Concrete limitation: thread_count=1 is recorded, but OS-level pinning is not implemented or verified.
- The recorded "single-thread pinned" provenance is therefore not substantiated by the code.
- This is a campaign instrumentation defect in the sense that the campaign claims pinning it does not enforce/verify.

This audit does not itself change the 30 frozen records. It documents what the existing evidence can and cannot prove.
