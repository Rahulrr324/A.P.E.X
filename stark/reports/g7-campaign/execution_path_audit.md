# Execution path audit for B6/B7/B9 (G7 campaign, frozen)

Source files traced:
- `src/phase1/bench/BenchmarkHarness.h`
- `src/phase1/bench/BenchmarkHarness.cpp`
- `src/phase1/bench/TinyDenseModel.h`
- `src/phase1/bench/TinyDenseModel.cpp`
- `src/phase1/campaign/G7Campaign.cpp`

## Common harness path (all three benchmarks)

`G7Campaign.cpp` constructs a `BenchConfig` and calls either:
- `bench_tiny_inference(bench, model)` — B6, B9
- `run_benchmark(bench, op)` — B7
- `bench_inference_stability(model, bench)` — B9 wrapper that internally calls `run_benchmark`

Harness entry: `BenchmarkHarness.cpp::run_benchmark()`

Execution order in `run_benchmark()`:
1. Validate configuration; on error return immediately with `ok=false` and no samples.
2. Warmup loop: `for i in 0..warmup_count: op()`. Any exception fails the benchmark immediately.
3. Timed loop: `for i in 0..measurement_count:`
   - `auto t0 = Clock::now()` — `using Clock = std::chrono::steady_clock`
   - `op()`
   - `auto t1 = Clock::now()`
   - `double sec = duration<double>(t1 - t0).count()`
   - Reject non-monotonic samples (`!(sec >= 0.0)`) as discarded with a failure entry.
   - Otherwise append `sec` to `samples`.
4. After loop: `result.stats = compute_statistics(move(samples))`
5. `result.peak = sample_peak_memory()`
6. `result.ok = true`

What is included in each timed sample:
- The entire `op()` call.
- Nothing else from the harness is inside the timed region.

What is excluded from each timed sample:
- Warmup iterations.
- `compute_statistics()` work.
- `sample_peak_memory()` work.
- Any exception handling across iterations other than the failing iteration itself.

## B6 path

`bench_tiny_inference()`:
- Builds `BenchConfig` with `benchmark_id="B6"`.
- Workload params: `model=TINY-DENSE-2L`, `logical_params=262912`.
- `op = [&]{ model.forward(); }`.

`TinyDenseModel` construction (`TinyDenseModel.cpp`):
- `TinyDenseModel(1)` allocates `w1_, b1_, w2_, b2_, in_, hidden_, out_` to fixed sizes and calls `initWeights()` then `initInput()`.
- Constructor and initialization are NOT inside the timed region.
- `forward()` computes:
  - `h = GELU(W1 * x + b1)` over hidden dim
  - `y = W2 * h + b2`
- `forward()` is deterministic on CPU FP32 (same seed/build).

B6 timed operation: a single forward pass with batch=1. No IO, no deserialization, no allocation inside `forward()` (all buffers preallocated in constructor).

## B7 path

`run_b7_campaign()` in `G7Campaign.cpp`:
1. `TinyDenseModel model(1)` (constructor weights+input init).
2. `model.serializeWeights()` → blob.
3. Write blob to temp file `tiny_dense_2l_weights.bin`.
4. Build `BenchConfig` with `benchmark_id="B7"`.
5. `op = [&]{ read file bytes; loader.deserializeWeights(bytes); }`.
6. Timed operation: read file into `vector<uint8_t>`, then `deserializeWeights()`.

`B7 timed region` includes:
- File read of the weight blob.
- Allocation of `vector<uint8_t>` for the file bytes.
- `deserializeWeights()` memcpy of 4 weight arrays into preallocated model buffers.

`B7 timed region` excludes:
- Model construction.
- Weight generation / serialization.
- File creation.
- The second `TinyDenseModel loader(1)` is constructed before `run_benchmark()`, so its allocation is outside the timed region.

Important: B7 measures a different operation than B6/B9. B7 is I/O + deserialization, not a forward pass.

## B9 path

`bench_inference_stability()`:
- Sets `benchmark_id="B9"`, `deterministic_mode_requested=true`.
- Maintains a reference output vector.
- `op = [&]{ model.forward(); if(first) reference=output(); else check bit-identical; }`.
- Calls `run_benchmark(cfg, op)`.

B9 timed operation: 50 calls to `forward()`, each followed by a comparison against reference output for bit-identical tracking (comparison is inside timed region).

Note: the `repeats=200` workload param is metadata only; the actual harness loops `measurement_count=50` times.

## Shared component

The primary shared implementation is:
- `TinyDenseModel` storage and forward().
- `run_benchmark()` timing and statistics.
- `compute_statistics()` (median via linear interpolation on sorted samples).

B6 and B9 share the exact timed core operation: `model.forward()`. B7 shares the harness but exercises a different timed operation (deserialize).

## No evidence of GPU, OpenMP, thread pools, or async in timed region

The traced code uses:
- Single-threaded `op()`.
- No CUDA calls in the timed region for B6/B7/B9 on a CUDA-less build.
- No OpenMP pragmas in `TinyDenseModel::forward()` (naive nested loops).
- No thread creation in the timed region.
- No asynchronous operations.

## Initialization behavior

- Model buffers are allocated and initialized once per campaign run function call.
- Each `run_b*_campaign()` creates its own `TinyDenseModel` instance, so there is no reuse of a single model across independent runs within the campaign loop.
- `G7Campaign.cpp` loop does create a new model for each benchmark call.
- However, the process itself is long-running across all 10 benchmark calls per independent run and across all 5 independent runs.
