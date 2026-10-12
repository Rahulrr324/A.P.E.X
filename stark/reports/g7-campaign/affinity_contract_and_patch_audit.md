# Affinity instrumentation audit and patch decision

## Step 1 — Frozen contract finding

Source: `design/V009_phase1_M0_specification.md` (rev 1.1).

Relevant clauses:

- §B: "All benchmarks: fixed workload sizes, fixed seeds, ≥3 warmup iterations, ≥10 timed iterations (configurable), CPU thread count pinned (single-thread AND all-core variants), report mean/median/p95 plus raw samples."
- §F reproducibility metadata schema: `configuration: {benchmark_id, workload params, thread count, affinity, batch_size, sequence_length}, ...`
- §A/HardwareProfiler ground rules: do not fabricate; unavailable => null + provenance reason.
- G7 (§G): same-config median reproducibility ±15% (memory bandwidth ±20%). G7 itself does not name an affinity API; it cares about the measured result.

Explicit classification:

A. Required by frozen contract:
- `configuration` record must carry a thread count and an affinity field (§F schema).
- §B states benchmarks are to be run with CPU thread count pinned (single-thread and all-core variants).
- Ground rule 1: do not fabricate; when a quantity cannot be obtained, represent as null + reason.

B. Recommended/not required by frozen contract (as written):
- The spec names the *notion* of pinning and an `affinity` configuration field, but it does not enumerate a specific OS API, a specific bitmask representation, or a specific verification procedure in the M0 acceptance gates.

C. Not specified by frozen contract:
- Exact affinity API, exact effective-mask representation, exact failure-mode policy, exact multi-platform portability behavior.

Interpretation used here:
- The contract requires that affinity be representable in the configuration/provenance record and that the benchmark be run in a pinned single-thread manner where possible.
- The contract does not require the project to lie. If affinity cannot be requested/verified on a platform, the honest representation is "requested / applied / verified / unavailable / failed", with no false "pinned" claim.
- Therefore adding a minimal request+verify instrumentation is compatible with the frozen contract as long as it is implemented as measurement/control instrumentation and does not change benchmark math, timing-region semantics, statistics, G7 formula, or gate logic.

## Step 2 — Current implementation audit

Current behavior traced:
- `G7Campaign.cpp` sets `BenchConfig::thread_count = 1` and writes `provenance["thread_affinity"] = "single-thread pinned (thread_count=1)"`.
- `BenchmarkHarness.h` carries `thread_count` as a configuration/policy field; `0 = natural; pinned per benchmark`.
- `BenchmarkHarness.cpp::run_benchmark()` does not use `thread_count` to request OS affinity and does not verify effective affinity.
- `HardwareProfiler` queries CPU model, core counts, RAM, GPU, storage, platform; it does not request or query thread/process affinity.
- No call to `SetThreadAffinityMask`, `SetProcessAffinityMask`, `GetThreadAffinityMask`, `GetProcessAffinityMask`, or POSIX `pthread_setaffinity_np`/`sched_getaffinity` exists in the traced Phase-1 sources.

Conclusion:
- The current "single-thread pinned" provenance is an assertion generated from policy (`thread_count=1`), not from a verified OS affinity state.
- This is the concrete instrumentation defect identified by the root-cause investigation.

Smallest insertion point:
- Add a small platform affinity query/set helper in `common/HardwareProfiler` (or a small new file) that:
  - on Windows: uses `GetProcessAffinityMask` (and optionally `SetProcessAffinityMask`) and translates mask bits to logical CPU indices;
  - on POSIX: uses `sched_getaffinity` (and optionally `pthread_setaffinity_np`);
  - returns requested/attempted/effective state plus a provenance reason when unavailable.
- Expose it through `HardwareProfiler` so the existing platform-abstraction pattern is reused.
- Record the result in benchmark provenance via the existing `extra_provenance` path in `make_benchmark_record()`.
- Keep the existing `thread_count` field unchanged; add explicit `affinity_requested`, `affinity_applied`, `affinity_effective` provenance.

## Step 3 — Minimal correction design

Proposed minimal patch:

1. Add `HardwareProfiler::queryProcessAffinity()` returning:
   - `supported: bool`
   - `requested_mask` / `effective_mask` as bit-sets of logical processor indices
   - `applied: bool`
   - `reason: string` when unsupported/failed
2. Add a helper to request single-logical-CPU affinity when supported, and detect success/failure.
3. In campaign/harness record assembly, store provenance such as:
   - `affinity_requested: "single logical cpu"`
   - `affinity_applied: true/false`
   - `affinity_effective_mask: [...]` or `unavailable/failed` with reason
4. Never emit "pinned" unless effective affinity was actually verified.

This is instrumentation/control only:
- It does not change `BenchConfig` timed semantics.
- It does not change warmup/measurement separation.
- It does not change statistics, median definition, symmetric-relative-difference formula, grouping key, thresholds, or gate logic.
- It does not modify the frozen 30 records.

## Step 4 — Patch decision

Decision: PATCH VALIDATED as contract-compatible, because:
- The frozen contract requires thread-count/affinity representation and pinned execution where supported.
- The frozen contract prohibits fabrication; the patch increases honesty by verifying rather than asserting pinning.
- The patch is limited to platform affinity instrumentation and provenance; it does not touch benchmark or gate semantics.

Caveat:
- This task does NOT rerun the G7 campaign. Even if affinity works, G7 status is unchanged until a compliant campaign is re-run under the frozen design.

## Step 5 — Regression coverage plan

New focused tests (do not touch frozen records):

- Affinity supported and queryable on this platform.
- Affinity request sets a single logical CPU and is reported as applied where supported.
- Effective mask is queried and reflected accurately in provenance.
- Unsupported or failed affinity is reported as unsupported/failed, never as pinned.
- No false "pinned" provenance when affinity could not be verified.

## Step 6 — Verification (completed)

- Built `stark_phase1`, `test_phase1_affinity`, `test_phase1_records`, `test_phase1_gates` from the existing release baseline.
- `test_phase1_affinity`: PASS, 43 assertions, 0 failures.
- `test_phase1_records`: PASS, 54 assertions, 0 failures.
- `test_phase1_gates`: PASS, 437 assertions, 0 failures.
- Actual affinity behavior on this machine: supported and queryable; effective process mask includes logical cpus 0 through 11.

## Remaining limitations

- Affinity is platform-dependent; on unsupported or restricted environments only query or honest failure reporting is possible.
- Setting affinity can fail on some environments even when querying works.
- Even with verified affinity, reproducibility depends on the broader environment, which is not fully controlled by affinity alone.
- No G7 campaign rerun was performed in this task, so G7 status is unchanged.
