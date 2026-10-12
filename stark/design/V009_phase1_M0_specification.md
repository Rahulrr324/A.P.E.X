# STARK Phase 1 (M0) — Measurement, Parameter Accounting, Budget Ledger

> STATUS: **SPECIFIED — READY FOR IMPLEMENTATION (rev 1.1, specification-correction pass applied).**
> Implements the Phase-1 slice of the V008.1 gate (`design/V008.1_architecture_gate.md`).
> No STARK-001..007 source is modified. This document specifies; no implementation code exists yet.
>
> Rev 1.1 changes (specification corrections only, architecture unchanged): exact TINY-DENSE-2L
> parameter count; optimizer accounting generalized; stored-size accounting split into
> nominal-payload vs stored-with-overhead; canonical `active_parameters` definition; compute
> budget made informational-only; per-resource memory budget dimensions; memory-compression
> heuristic removed; theoretical vs measured bandwidth separated; determinism expressed as
> requested/available/bit-identical; machine-specific RAM sanity bound removed. Audit: §M.

## Purpose

Replace assumptions about the target hardware (HP Victus: i5-12450H, RTX 2050 4 GB VRAM, 24 GB
RAM, Windows-first) with **measurements**, and establish the accounting vocabulary that every
later architecture experiment must use. Phase 1 selects **no** cognitive-core architecture.

Non-goals (from gate C8, restated): no marketplace, no billing, no autonomous external access, no
cloud memory, no CUDA kernels, no computer control, no architecture choice, no Phase 6+ work.

## Ground rules

1. **Do not fabricate measurements.** Every value in a record must come from a real query, a real
   timed run, or a real counter read. If a quantity cannot be obtained, the field is `null` with
   the reason recorded — never a guess or a web-table constant.
2. **CPU-only must remain possible.** Every benchmark has a CPU path; GPU paths are conditional.
3. **Offline.** Zero network access anywhere in Phase 1 (gate C7).
4. **Deterministic records.** Reuse the STARK-007 pattern: deterministic execution + versioned
   transactional serialization.
5. **Windows-first, POSIX-tolerant.** Missing platform sources produce `null` + reason, not a crash.
6. All code is C++17 (matches the repo; no Python toolchain introduced).

---

## A. HardwareProfiler interface

Two strictly separated value structs + one profiler:

```
// STATIC facts — change only on hardware/driver/OS change. Queried once, cached, stamped with collection time.
struct StaticHardwareProfile {
    // CPU
    std::string cpu_model;                  // from cpuid brand string (never registry guesses)
    std::optional<uint32_t> physical_cores; // null if unavailable
    std::optional<uint32_t> logical_cores;  // std::thread::hardware_concurrency(); null if 0
    std::optional<std::string> cpu_instruction_set_notes; // e.g. AVX2 present — from cpuid feature bits only

    // RAM (installed capacity only — static)
    std::optional<uint64_t> ram_total_bytes;   // GlobalMemoryStatusExullTotalPhys is INSTALLED size; null on failure

    // GPU (via CUDA runtime if built with it, else null + reason)
    std::optional<std::string> gpu_model;
    std::optional<uint64_t> vram_total_bytes;
    std::optional<int>  gpu_compute_capability_major, gpu_compute_capability_minor;
    std::optional<double> theoretical_memory_bandwidth_gbps; // computed from device props (memoryClockRate * busWidth * 2 / 8). ALWAYS labeled theoretical; never "measured".
    bool cuda_available = false;                 // runtime query result, not an assumption
    std::optional<std::string> cuda_version;     // driver + runtime versions when available

    // Storage (per monitored volume)
    struct Volume { std::string path; std::optional<uint64_t> total_bytes; std::optional<uint64_t> free_bytes; };
    std::vector<Volume> storage_volumes;         // repo volume + user-configured extra paths

    // Platform
    std::string os_name, os_version;
    std::string toolchain;                       // compiler id + version (CMAKE_CXX_COMPILER or _MSC_VER/_GCCVER macros)
    std::string build_type;                      // Debug/Release — affects benchmark validity, must be recorded
};

// DYNAMIC telemetry — sampled, timestamped, never cached as truth.
struct RuntimeTelemetry {
    uint64_t ram_total_bytes;        // GlobalMemoryStatusEx ullTotalPhys, sampled (also mirrored in static profile)
    uint64_t ram_available_bytes;    // GlobalMemoryStatusEx ullAvailPhys, sampled
    std::optional<uint64_t> vram_free_bytes;   // cudaMemGetInfo when available
    std::chrono::steady_clock::time_point sampled_at;  // timestamp (rev 1.1: no compression heuristic — see rules)
    std::string platform_source;     // e.g. "GlobalMemoryStatusEx", "cudaMemGetInfo" — provenance per sample
};

class HardwareProfiler {
public:
    StaticHardwareProfile collectStatic();     // idempotent; safe to call repeatedly
    RuntimeTelemetry     sampleDynamic();      // point-in-time sample
    static std::string   schemaVersion();      // "STARKP1 1"
};
```

Rules:
- Every `std::optional` that is `null` must be accompanied by a `reason` string in the profile's
  `provenance` map (field name → "source: X" or "unavailable: why").
- CUDA/PyTorch availability: Phase 1 is C++-only, so CUDA availability = CUDA Runtime API query
  (`cudaGetDeviceCount`, `cudaGetDeviceProperties`). PyTorch CUDA availability is **out of scope
  for C++ Phase 1** and is recorded as a deliberately-undecided item for the phase that introduces
  PyTorch (see §L.7). The schema reserves `pytorch_cuda_available : null` so records stay
  forward-compatible.
- **Theoretical vs measured (rev 1.1):** device-property-derived bandwidth
  (`memoryClockRate × busWidth × 2 / 8` GB/s) is stored as `theoretical_memory_bandwidth_gbps` and
  must never be labeled measured. The B3 streaming benchmark produces
  `measured_memory_bandwidth_gbps`. The same distinction applies to every hardware throughput
  value in the schema: any value derived from specifications/properties is `theoretical_*`, any
  value from a timed run is `measured_*`; a field may never carry both meanings.
- **Memory compression (rev 1.1):** the former `ram_compression_suspect = (available − free)`
  heuristic is REMOVED — "free RAM" is not a well-defined canonical quantity (standby/compressed/
  modified pages differ per platform and query). Runtime telemetry records only total physical
  RAM, available physical RAM, timestamp, and platform/source. Memory-compression interpretation
  may become informational platform telemetry in a later phase; it must never affect canonical
  accounting or budget evaluation.

## B. Compute benchmark suite

All benchmarks: fixed workload sizes, fixed seeds, ≥3 warmup iterations, ≥10 timed iterations
(configurable), CPU thread count pinned (single-thread AND all-core variants), report
mean/median/p95 plus raw samples. Sizes chosen to complete in seconds on an i5-12450H / RTX 2050.

| # | Benchmark | What it measures | Definition (fixed workload) |
|---|---|---|---|
| B1 | `cpu_gemm` | CPU matrix throughput | SGEMM C = A×B, K=1024 (single-thread + multi-thread), GFLOP/s from FLOPs/time |
| B2 | `cpu_axpy` | CPU vector throughput | y += a·x over 64M elements, GB/s and GFLOP/s |
| B3 | `memory_bandwidth` | RAM streaming bandwidth (MEASURED) | Large sequential read+write sweep (≥512 MB working set, exceeds LLC), GB/s. Output field is `measured_memory_bandwidth_gbps`; compare against the profile's `theoretical_memory_bandwidth_gbps` but never conflate them. |
| B4 | `gpu_gemm` | GPU matrix throughput | CUBLAS SGEMM 1024–4096 ladder; skipped (recorded null) if no CUDA |
| B5 | `host_device_transfer` | PCIe transfer bandwidth | Timed `cudaMemcpy` H2D/D2H of 256 MB, GB/s both directions |
| B6 | `tiny_inference` | Small-model inference latency | Fixed tiny deterministic model (see §E), single-stream latency distribution over N=200 inferences |
| B7 | `model_load_time` | Weight-load time | Wall time from file-open to first-inference-ready, warm and cold cache |
| B8 | `peak_ram` / `peak_vram` | Peak memory under load | Peak working set (Windows `GetProcessMemoryInfo`) / peak VRAM delta (`cudaMemGetInfo` before/after), during B6/B7 and stress ladder |
| B9 | `inference_stability` | Repeated-inference drift | Same input 200×; report p50/p95/p99 latency. Determinism is recorded per rev-1.1 rules: `deterministic_mode_requested`, `deterministic_mode_available`, `outputs_bit_identical` (see §E determinism block). |

Constraints:
- No benchmark may allocate more than 1.5 GB host RAM or more than 2 GB VRAM (well below the
  4 GB card's contention threshold).
- GPU benchmarks are **conditionally compiled** (CUDA guard); on a CPU-only build every GPU
  benchmark records `status: "skipped", reason: "no CUDA"` instead of failing.
- Timers: `std::chrono::steady_clock` for wall latency; QPC where needed. No `clock()`.

## C. Parameter accounting (canonical)

One `ParameterAccounting` struct is THE accounting system. Every experimental model record must
carry all fields; unknown fields are `null` with reason, never zero, never omitted. Units are
stated per field below: all `*_bytes` fields are **bytes**; parameter-count fields
(`logical_parameters`, `active_parameters`) are **dimensionless integers**; the optimizer
`training_or_inference` is an enum and `optimizer_type`/`optimizer_configuration` are
descriptors, not byte quantities.

| Field | Exact meaning |
|---|---|
| `logical_parameters` | Total parameter count of the architecture definition (all weights that exist in the definition, including every expert of an MoE and every recurrent state matrix of an SSM). Architecture-level constant. Unit: **count** (dimensionless integer). |
| `active_parameters` | **Canonical definition (rev 1.1):** the number of distinct parameter elements actually participating in the evaluated forward computation for the measured input/configuration. This is THE definition; architecture-specific counting rules below are *implementations* of it, not replacements. Dense models: == logical. MoE: shared params + the experts activated by the measured routing pattern (record also stores `experts_total`, `experts_active`). SSM/state-space, attention, and all other architectures: counted by the same canonical rule — every parameter element whose value influences the evaluated output for the measured configuration. Unit: **count**. |
| `stored_parameter_bytes` | Bytes the model occupies **at rest on disk** in the given format/precision (e.g. FP16 file, INT8 quantized file). Depends on format, not on runtime. Unit: **bytes** (file/storage bytes). |
| `nominal_parameter_payload_bytes` | **(rev 1.1)** The pure parameter payload: `Σ over tensors (elements × bytes_per_element(format))` — what the parameters alone would occupy, excluding all metadata. Unit: **bytes**. |
| `packing_overhead_bytes` | **(rev 1.1)** `stored_parameter_bytes − nominal_parameter_payload_bytes`: scales, zero-points, codebooks, block headers, padding, alignment, and any other quantization/packing metadata actually present in the stored file. Unit: **bytes** (≥ 0). |
| `runtime_parameter_bytes` | Bytes the materialized in-memory weights occupy at inference time in the runtime precision/layout (may differ from stored, e.g. on-the-fly dequantization). |
| `activation_bytes` | Peak bytes of transient activations (all intermediate tensors between input and output) for the measured batch size and sequence length. Measured, not modeled, where the framework exposes it; otherwise modeled **and flagged** `estimated: true`. |
| `kv_or_state_bytes` | Peak bytes of persistent per-sequence state: KV cache for attention models, recurrent state for SSMs, spike/state buffers for spiking models. Function of batch × sequence length × layers. |
| `optimizer_bytes` | Bytes of auxiliary optimizer state (momentum, variance, etc.). Unit: **bytes**. Zero is a valid value whenever the selected optimizer/configuration genuinely requires no auxiliary state (e.g. plain SGD without momentum); zero is then real data, not a placeholder. Unknown optimizer state size is `null` + reason, never zero. |
| `temporary_workspace_bytes` | Peak bytes of workspace allocations that are neither weights, activations, nor persistent state (e.g. cuBLAS workspace, scratch buffers, dequant scratch). |
| `total_peak_memory` | The measured OR computed process peak attributable to the model: `runtime_parameter_bytes + activation_bytes + kv_or_state_bytes + optimizer_bytes + temporary_workspace_bytes`. If measured directly (B8), the record stores BOTH measured and component sum; if they disagree by >10%, the record is flagged `inconsistent: true` (feeds gate G5). |

Rules:
- **Forbidden statements:** any sentence of the form "this is an X-B model but only uses Y-B"
  without the field breakdown above. The phrase has no canonical meaning; the accounting fields replace it.
- Identity check (gate G5): `total_peak_memory` component sum uses exactly the five components;
  `logical_parameters ≥ active_parameters` for every record (equality for dense).
- **Stored-size accounting (rev 1.1):** the universal identity
  `stored_parameter_bytes = logical_parameters × bytes_per_param` is REQUIRED only for **uniform,
  unquantized** formats (e.g. all-FP16, all-FP32), where `nominal_parameter_payload_bytes` may be
  exact and `packing_overhead_bytes` is typically 0 (or documented file-header bytes). For INT8,
  INT4, ternary, packed, and codebook formats, stored bytes MAY exceed the nominal payload —
  scales, zero-points, codebooks, block headers, padding and other metadata are real and are
  captured in `packing_overhead_bytes`. `stored_parameter_bytes = nominal_parameter_payload_bytes +
  packing_overhead_bytes` holds for every record. This distinction is mandatory because later
  STARK experiments will evaluate low-bit/ternary representations.
- **Optimizer accounting (rev 1.1):** every record carries `training_or_inference`
  (`TRAINING` | `INFERENCE`), `optimizer_type` (e.g. `none`, `sgd_plain`, `sgd_momentum`, `adam`,
  `adamw`; `null` for INFERENCE records with no training context), `optimizer_configuration`
  (hyperparameters as a key/value map; `null` if optimizer_type is `none`), and `optimizer_bytes`.
  `optimizer_bytes = 0` is valid iff the selected `optimizer_type`/`optimizer_configuration`
  genuinely defines no auxiliary state (plain no-momentum SGD); it must never be emitted as a
  default when the true state size is merely unknown.
- The accounting schema is architecture-agnostic: fields exist for MoE/SSM/spiking models from
  day one so later phases cannot redefine accounting per-architecture (that would break
  comparability).

## D. BudgetLedger

A machine-readable, serializable budget definition + a pure checking function (the ResourceRouter
purity rule C5 applied at Phase-1 scale):

```
struct BudgetLedger {
    // Configured ceilings — user/phase-authored, machine-readable JSON.
    // REV 1.1: memory resources are dimensionally SEPARATE. There is no combined RAM+VRAM pool.
    std::optional<uint64_t> vram_budget_bytes;   // peak VRAM ceiling; MUST be < measured vram_total when set; default policy: 80% of measured total
    std::optional<uint64_t> ram_budget_bytes;    // peak RAM ceiling; default policy: 60% of installed
    std::optional<uint64_t> storage_budget_bytes;
    std::optional<double>   latency_target_ms;   // p95 target, not mean
    std::optional<double>   cpu_compute_seconds; // (informational in Phase 1 — see rules) max CPU compute time per evaluated run
    std::optional<double>   gpu_compute_seconds; // (informational in Phase 1 — see rules) max GPU compute time per evaluated run
    std::optional<uint64_t> estimated_flops;     // (informational in Phase 1) demand-side annotation only

    // SECONDARY REPORTING AGGREGATES — never enforceable, never a replacement for per-resource limits.
    std::optional<uint64_t> training_budget_bytes_reporting;    // reporting convenience for training-run totals
    std::optional<uint64_t> inference_budget_bytes_reporting;   // reporting convenience for inference-run totals

    double safety_headroom_frac;     // fraction of each ENFORCEABLE budget held back (default 0.10)
};

struct ResourceDemand {              // every enforceable budget dimension has a matching demand dimension
    std::optional<uint64_t> peak_vram_bytes;   // measured/declared peak VRAM of the configuration
    std::optional<uint64_t> peak_ram_bytes;    // measured/declared peak RAM of the configuration
    std::optional<uint64_t> storage_bytes;
    std::optional<double>   latency_p95_ms;
    std::optional<double>   cpu_compute_seconds;
    std::optional<double>   gpu_compute_seconds;
    std::optional<uint64_t> estimated_flops;
    // training/inference aggregate reporting fields mirror these two sums when present
};

struct BudgetEvaluation {   // result of the pure check
    bool within_budget;
    std::vector<Violation> violations;  // {field, requested, budget_after_headroom, margin_bytes_or_seconds}
    // per-resource verdicts are explicit: a VRAM violation is reported even when a combined
    // RAM+VRAM total would appear to fit
};

// PURE: takes immutable snapshots, queries nothing live. Same inputs -> same verdict.
BudgetEvaluation evaluate(const ResourceDemand& demand, const BudgetLedger& ledger);
```

Rules:
- Headroom is subtracted **before** comparison: `effective = budget × (1 − safety_headroom_frac)`.
  Default headroom 10%; never zero.
- Default policy: VRAM budget defaults to **80% of measured** VRAM total (≈3.2 GB of 4 GB), then
  headroom applies. 100% of VRAM is never treated as usable model memory.
- **Per-resource enforcement (rev 1.1):** evaluation compares `peak_vram_bytes` against the VRAM
  ceiling, `peak_ram_bytes` against the RAM ceiling, and `storage_bytes` against the storage
  ceiling, each independently after headroom. A configuration exceeding the VRAM ceiling FAILS
  even if a combined RAM+VRAM total would appear acceptable. The former combined-pool fields
  (`training_budget_bytes` / `inference_budget_bytes`) survive only as the explicitly-named
  secondary `*_reporting` aggregates; they are never consulted by `evaluate()` enforcement and
  never substitute for per-resource limits.
- **Compute budget (rev 1.1):** `compute_budget` (a fraction of measured GFLOP/s) is REMOVED as an
  enforceable field — utilization fraction is not a valid resource-demand quantity. Option B is
  adopted for Phase 1: compute budgeting is **informational-only**. `cpu_compute_seconds`,
  `gpu_compute_seconds`, and `estimated_flops` are recorded and reported but do not cause
  `within_budget = false` in Phase 1; `violations` for these fields are emitted as
  `severity: "informational"`. Enforceable compute budgeting is deferred to a later phase, which
  must define it in measurable time/flop dimensions (option A semantics). No ambiguous
  enforceable compute field remains.
- The ledger distinguishes *configured budget* from *measured availability* (profiler); a
  configuration may fit the ledger yet fail at runtime if availability < budget — the record then
  logs `availability_shortfall`, it is not a gate failure.
- `evaluate()` is deterministic and side-effect free so it is unit-testable exactly like gate C5's
  router.

## E. Baseline experiments (measured baselines, no winner)

All baselines use ONE shared tiny deterministic model so numbers are comparable across precision
and device: **TINY-DENSE-2L**: dense 2-layer MLP, 256→512→256, GELU, fixed seeded weights
(specified constant seed), fixed input tensor (seeded), batch=1 and batch=8 variants,
sequence-agnostic. Exact parameter count (rev 1.1):

```
W1: 256×512 = 131,072   b1: 512
W2: 512×256 = 131,072   b2: 256
logical_parameters = 262,912 (≈ 0.263 M)
```

Inference runs in well under a millisecond on the target hardware.

**Determinism representation (rev 1.1):** every baseline and B9 record carries
`deterministic_mode_requested` (whether the configuration asked for deterministic execution),
`deterministic_mode_available` (whether the runtime/device can provide it — CPU FP32 always can;
GPU may not, depending on op implementations), and `outputs_bit_identical` (the observed result).
Universal bit-identical GPU output is NOT required. The CPU FP32 baseline (E1 CPU path, E5) MAY
require `outputs_bit_identical == true` under its deterministic configuration; if it requests
determinism and the mode is available but outputs differ, that is a failure. GPU determinism is
evaluated strictly according to the declared execution mode and reported runtime capabilities —
`deterministic_mode_available == false` with `outputs_bit_identical == false` is a valid,
non-failing outcome for GPU records.

| Baseline | Definition | Conditional on |
|---|---|---|
| E1 Dense FP32 | TINY-DENSE-2L forward, FP32, CPU; GPU variant if CUDA | always (CPU) |
| E2 Dense FP16 | same, FP16 | GPU with FP16 support |
| E3 INT8 inference | same, INT8 (dynamic-quantized weights) | CPU path always; note: C++ Phase 1 quantizes via runtime tables, no external toolchain |
| E4 4-bit inference | same, 4-bit weight-only (custom dequant-on-load path) | **optional** — implemented only if trivially available; otherwise `status: "not_attempted"` with reason. No custom CUDA kernels (C8) |
| E5 CPU-only equivalent | E1–E3 forced to CPU-only build/run (CUDA excluded), proving the offline path | always |

Each baseline record must contain: full `ParameterAccounting` (§C), the B-suite measurements it
depended on, peak RAM/VRAM (measured), latency distribution (mean/median/p95/p99), throughput,
stability result (B9), and errors if any. The goal is baselines, not selection; no comparative
verdict is emitted.

## F. Reproducibility metadata (every record)

Every experiment record (profiler capture, benchmark run, baseline run) is a versioned
`STARKP1 1` JSON document with:

```
record_id, schema_version, created_utc, stark_phase: "P1",
hardware:        StaticHardwareProfile (embedded at run time — never referenced by name only),
software:        {os, compiler, build_type, cuda_runtime/driver if any, benchmark_lib_versions},
configuration:   {benchmark_id, workload params, thread count, affinity, batch_size, sequence_length},
precision:       {compute precision, storage format, bytes_per_param table, quantization metadata (scales/zero-points/codebook sizes when present)},
seed:            where randomness exists (weight init seed, input seed) — deterministic seeds mandatory,
warmup_count, measurement_count,
statistics:      {mean, median, p95, p99, min, max, stdev, samples[]},
peak_memory:     {ram_peak_bytes, vram_peak_bytes, measured_vs_estimated flags},
accounting:      ParameterAccounting (when the record concerns a model),
determinism:     {deterministic_mode_requested, deterministic_mode_available, outputs_bit_identical},
failures:        [{component, error, recovered}] — empty list on success,
consistency:     {accounting_check_passed, within_budget, availability_shortfall}
```

Rules: raw samples are always stored (not just statistics); every measurement carries the profile
snapshot; records are append-only on disk; a record that cannot be produced must still produce a
record with `failures` populated (a failed measurement is itself a measurement).

## G. Acceptance gates (hard, measurable)

| Gate | Definition — pass condition |
|---|---|
| G1 | `HardwareProfiler::collectStatic()` returns a complete profile; cpu_model, OS, RAM total, storage are non-null; every null field carries a provenance reason. |
| G2 | CPU baselines (E1, E5) produce records with ≥10 samples each; median latency within ±15% of the median of a second independent run on the same machine. |
| G3 | If CUDA exists: GPU baselines (E2 + B4/B5) produce complete records; if no CUDA: records exist with `status: skipped` + reason. Either branch passes; missing-GPU must not fail the suite. |
| G4 | Every baseline record's peak RAM/VRAM comes from process/device queries (B8), with `measured: true`; any estimated field is flagged and gate G4 fails if a *peak memory* field is estimated. |
| G5 | For every record with `accounting`: (a) `logical ≥ active`; (b) component sum vs measured total agree within 10% or the record is flagged `inconsistent` AND the suite fails; (c) for uniform unquantized formats `stored_parameter_bytes == nominal_parameter_payload_bytes + packing_overhead_bytes` with `packing_overhead_bytes` = 0 plus documented header; (d) for quantized/packed/codebook formats the same sum identity holds and `packing_overhead_bytes > 0` is expected (its absence must be explained); (e) `optimizer_bytes = 0` only with `optimizer_type` whose configuration genuinely has no auxiliary state (e.g. plain SGD), never as a default. |
| G6 | Given a synthetic `ResourceDemand` exceeding any per-resource effective budget, `evaluate()` returns `within_budget=false` with the correct violating field — including a VRAM-only violation when combined RAM+VRAM would fit. Demands crossing only informational compute fields produce informational violations but `within_budget=true`. Determinism: two identical calls → identical verdicts. |
| G7 | Full re-run of the same suite with same config: every benchmark median within ±15% of the recorded median (memory bandwidth ±20%). Determinism check per rev-1.1: CPU FP32 deterministic-mode records must be `outputs_bit_identical == true`; GPU records evaluated per declared mode (`deterministic_mode_available == false` ⇒ bit-identity not required). Tolerance is defined here once — later phases may not loosen it silently. |
| G8 | `build/results/` contains a machine-readable record (JSON, `STARKP1 1`) for every executed benchmark/baseline and every profiler capture, parseable by the same reader used in tests. |

No invented performance targets: gates reference only internal consistency, reproducibility, and
completeness — never absolute speed numbers.

## H. Architecture-selection interface (outputs, not choices)

Phase 1 emits **no** architecture verdict. It defines the measurement contract later phases
consume — the *ArchitectureCandidateEvaluation envelope*:

```
struct ArchitectureCandidateEvaluation {
    std::string candidate_id;              // chosen by the LATER phase (transformer/ssm/hybrid/...)
    StaticHardwareProfile hardware;
    ParameterAccounting accounting;
    std::vector<BenchmarkRecord> measurements;   // B-suite subset relevant to the candidate
    BudgetEvaluation budget;                      // evaluated against the current ledger
    StabilityReport stability;                    // B9-style
};
```

Phase-2 (selection) may ONLY compare candidates expressed in this envelope. Anything it needs
that Phase 1 does not measure becomes a Phase-2 requirement, decided at the Phase-2 boundary
(gate C4) — not a reason to reopen this spec.

## I. Exact implementation order (minimal dependency order)

```
1. common/ExperimentRecord        (schema + JSON writer/reader)     — everything serializes through it
2. common/HardwareProfiler        (static + dynamic)                — needs only ExperimentRecord for output
3. bench/BudgetLedger             (struct + pure evaluate())        — needs no other Phase-1 module
4. bench/ParameterAccounting      (struct + consistency checker)    — needs ExperimentRecord
5. bench/BenchmarkHarness         (timing, warmup, stats)           — needs ExperimentRecord
6. bench/tiny model TINY-DENSE-2L (seeded weights, CPU paths)       — needs ParameterAccounting
7. baselines E1/E5 (CPU FP32, CPU-only)   — needs 2,5,6
8. optional CUDA build path + E2/E3/E4 + B4/B5/B8-VRAM   — needs 7's harness + profiler CUDA fields
9. results aggregator (build/results writer + G-gate checker CLI)
```

Steps 1–7 form the CPU-only core and can be delivered and gated without any GPU work; step 8 is
strictly additive and skippable on a CPU-only machine. Nothing else is built (no router, no
adapters, no ledger-persistence daemon, no UI).

## J. Files/modules (exact)

```
stark/src/phase1/
  common/ExperimentRecord.h/.cpp      — record schema, JSON serialization (STARKP1 1), append-only store
  common/HardwareProfiler.h/.cpp      — StaticHardwareProfile, RuntimeTelemetry, collection + provenance
  bench/BenchmarkHarness.h/.cpp       — timing loop, warmup, statistics, sample capture
  bench/BudgetLedger.h/.cpp           — BudgetLedger, ResourceDemand, pure evaluate()
  bench/ParameterAccounting.h/.cpp    — accounting struct + consistency checker (G5)
  bench/TinyDenseModel.h/.cpp         — TINY-DENSE-2L definition + seeded weights (CPU)
  baselines/run_baseline.cpp          — one CLI: --baseline E1|E2|E3|E4|E5 --out build/results/
  profiler_cli.cpp                    — CLI: dump profile record
  aggregate.cpp                       — CLI: validate all records, report gate status G1–G8
stark/tests/
  test_phase1_profiler.cpp
  test_phase1_accounting.cpp
  test_phase1_budget.cpp
  test_phase1_records.cpp
  test_phase1_reproducibility.cpp
stark/math/phase1_specification.md   — (this document; math/ mirrors the per-phase spec convention)
stark/design/phase1_decision.md      — short rationale: why measure-first, rejected alternatives
```

CMake: one static lib `stark_phase1` + test executables mirroring the existing pattern; new
targets only, zero edits to existing targets. Optional CUDA: separate `if(STARK_ENABLE_CUDA)`
block, default OFF.

## K. Tests

| Test file | Covers |
|---|---|
| `test_phase1_profiler.cpp` | Static profile completeness on this machine (G1); provenance reasons present for every null; dynamic sample monotonic timestamps; repeated collectStatic() idempotence; no-fabrication checks using only generic validity (rev 1.1: `ram_total_bytes > 0`, query-reported values fit their integer types, OS query returns success) — NO machine-specific upper bounds such as a 64 GB cap. |
| `test_phase1_accounting.cpp` | G5 rules: logical ≥ active; five-component sum; `stored = nominal_payload + packing_overhead` for uniform AND quantized fixtures (INT8 fixture with realistic scale/zero-point overhead; packed 4-bit fixture with header padding); MoE active-parameter counting per the canonical definition (fixture: 8 experts, 2 active → active = shared + 2·expert); optimizer fixtures: `sgd_plain` → `optimizer_bytes = 0` valid, `adam` → nonzero, `null` state-size → null+reason never 0; unknown field → null+reason, never zero. |
| `test_phase1_budget.cpp` | G6: within/exceeding demands for every ENFORCEABLE budget dimension (VRAM, RAM, storage, latency); VRAM-only violation fails even when combined RAM+VRAM fits; informational compute fields (cpu/gpu_compute_seconds, estimated_flops) never flip `within_budget`; reporting aggregates are ignored by enforcement; headroom subtraction correctness (80% VRAM default × 0.9 headroom); determinism (two identical calls, identical verdicts); purity (no live queries — feed two different ledgers, verdicts differ only per inputs). |
| `test_phase1_records.cpp` | G8: serialize→deserialize round-trip preserves all fields bit-exact; schema_version enforced; append-only store rejects schema mismatch; failed-run record with populated `failures` is valid. |
| `test_phase1_reproducibility.cpp` | G7 mechanics: statistics (mean/median/p95) computed identically from stored samples; seed recording present whenever randomness exists; TINY-DENSE-2L CPU FP32 (deterministic_mode_requested=true, available=true) produces `outputs_bit_identical == true` across two in-process runs with same seed; determinism triple (requested/available/bit-identical) serialized in every record. |

Integration: `run_baseline.cpp --baseline E1` end-to-end produces a parseable record passing G1+G4+G5+G8; `aggregate.cpp` exits nonzero if any gate fails.

## L. Final Phase-1 output

### 1. Architecture gate result
**PASS WITH BINDING CORRECTIONS C1–C8** — see `design/V008.1_architecture_gate.md`. The
repository supports proceeding; no STARK-001..007 change required or permitted.

### 2. Phase-1 specification
This document (`design/V009_phase1_M0_specification.md`, mirrored to `math/phase1_specification.md`).

### 3. Interfaces
`HardwareProfiler` (A), benchmark definitions (B), `ParameterAccounting` (C),
`BudgetLedger` + pure `evaluate()` (D), `ArchitectureCandidateEvaluation` envelope (H),
`ExperimentRecord` (F).

### 4. Data schemas
`StaticHardwareProfile`, `RuntimeTelemetry`, `ParameterAccounting` (canonical fields incl.
`nominal_parameter_payload_bytes`, `packing_overhead_bytes`, optimizer triple), `BudgetLedger`,
`ResourceDemand`, `BudgetEvaluation`, `BenchmarkRecord`, `ArchitectureCandidateEvaluation` — all
versioned `STARKP1 1`, JSON, append-only. Every field has an unambiguous unit (audit §M).

### 5. Dependency graph
§I: `ExperimentRecord → {HardwareProfiler, ParameterAccounting, BenchmarkHarness} →
{TinyDenseModel, BudgetLedger} → baselines → CUDA-optional extras → aggregator`.

### 6. Acceptance tests
G1–G8 (§G) + test files (§K). All gates are internal-consistency/reproducibility gates; none
invents a performance target.

### 7. What remains deliberately undecided
- Enforceable compute budgeting in measurable dimensions (cpu/gpu_compute_seconds,
  estimated_flops): deferred to a later phase (§D rev-1.1 rule); Phase 1 records them
  informationally only.
- PyTorch/CUDA availability fields: schema reserved, value deferred to the phase that introduces a
  Python/PyTorch runtime (C++ Phase 1 records them as null).
- 4-bit baseline (E4): attempted only if trivially available; explicit `not_attempted` status is a
  legitimate outcome.
- Exact CUDA benchmark sizes for the RTX 2050 ladder: parameterized, tuned at implementation time
  within the ≤2 GB VRAM constraint.
- Cognitive Core architecture (Transformer/SSM/hybrid/MoE/ternary/binary/spiking): **Phase 2
  boundary decision**, consuming `ArchitectureCandidateEvaluation`.
- All C4-assigned questions (tokenizer, memory structure, training pipeline): decided at their
  respective phase boundaries.

### 8. Exact next implementation prompt

> **STARK-P1-IMPLEMENT (rev 1.1).** Implement Phase 1 (M0) exactly as specified in
> `design/V009_phase1_M0_specification.md` (rev 1.1), in the dependency order of §I (steps 1–7
> first, CPU-only; step 8 only if CUDA is available on this machine). Create only the files listed
> in §J; add the `stark_phase1` static lib and Phase-1 test targets to `CMakeLists.txt` without
> modifying any existing target. Implement `HardwareProfiler` (§A) with no fabricated values —
> every null carries a provenance reason; record theoretical vs measured bandwidth as separate
> fields (`theoretical_memory_bandwidth_gbps` from device properties, `measured_*` only from the
> B3 run) and sample only total/available RAM + timestamp + source (no compression heuristic).
> Implement `ParameterAccounting` (§C) with the canonical `active_parameters` definition and the
> `stored = nominal_payload + packing_overhead` split (INT8/packed fixtures included), and the
> optimizer triple `training_or_inference` / `optimizer_type` / `optimizer_configuration` where
> `optimizer_bytes = 0` is valid only for genuinely stateless configurations (plain no-momentum
> SGD). Implement `BudgetLedger` (§D) with a pure, deterministic `evaluate()` enforcing per-
> resource limits (peak_vram_bytes, peak_ram_bytes, storage_bytes — VRAM violation fails even
> when a combined total would fit); cpu/gpu compute seconds and estimated_flops are
> informational-only (severity: "informational", never flip `within_budget`);
> `training_budget_bytes_reporting` / `inference_budget_bytes_reporting` are secondary reporting
> aggregates only. Build TINY-DENSE-2L (§E) — exactly 262,912 logical parameters — with fixed
> seeds and run baselines E1 and E5; represent determinism as the triple
> `deterministic_mode_requested` / `deterministic_mode_available` / `outputs_bit_identical` and
> require bit-identical outputs only for the CPU FP32 deterministic configuration; never require
> universal GPU bit-identity. Write every output as `STARKP1 1` JSON into `build/results/`.
> Then implement the five test files of §K and make `aggregate.cpp` report gate status G1–G8.
> Do not implement E2/E3/E4 or any GPU benchmark unless CUDA is present; record them as
> skipped/not_attempted otherwise. Do not modify STARK-001..007 code, do not implement any
> V008/V009 architecture component (Resource Fabric, ProviderAdapter, ResourceRouter, APIs,
> cloud), do not add network access, do not choose an architecture, and do not start Phase 2.
> Exit criteria: all Phase-1 tests pass, §M audit checks pass, and `aggregate.cpp` reports
> G1–G8 pass on this machine (G3 skipped-branch allowed if no CUDA).

---

## M. Specification consistency audit (rev 1.1 — mandatory final pass)

Audit performed after corrections 1–10; each check is a standing property of this spec, not a
one-time assertion.

| # | Check | Result |
|---|---|---|
| M1 | Every schema field has an unambiguous unit | PASS — parameter counts are dimensionless integers; all `*_bytes` fields are bytes; `*_seconds` are seconds (wall/CPU time); bandwidth fields are GB/s with explicit `theoretical_`/`measured_` prefixes; `latency_target_ms` / `latency_p95_ms` are milliseconds; `estimated_flops` is a flop count; headroom is a dimensionless fraction. No unit-overloaded field remains (the old fraction-based `compute_budget` is removed). |
| M2 | Every enforceable budget dimension has a matching demand dimension | PASS — ledger `vram_budget_bytes`/`ram_budget_bytes`/`storage_budget_bytes`/`latency_target_ms` ↔ demand `peak_vram_bytes`/`peak_ram_bytes`/`storage_bytes`/`latency_p95_ms`. Compute dimensions exist on both sides (`cpu_compute_seconds`, `gpu_compute_seconds`, `estimated_flops`) but are informational-only in Phase 1. Reporting aggregates (`training/inference_budget_bytes_reporting`) have no demand dimension because they are never enforced. |
| M3 | Theoretical and measured quantities separated | PASS — `theoretical_memory_bandwidth_gbps` (device properties) vs `measured_memory_bandwidth_gbps` (B3 streaming run); rule generalized to all hardware throughput values; no field may carry both meanings. |
| M4 | Model parameter counts exact | PASS — TINY-DENSE-2L = 262,912 logical parameters (256×512 + 512×256 + 512 + 256); the "~0.33 M" figure is removed. |
| M5 | Quantized storage overhead representable | PASS — `nominal_parameter_payload_bytes` + `packing_overhead_bytes` sum identity holds for every format; INT8/INT4/ternary/packed/codebook metadata (scales, zero-points, codebooks, headers, padding) lands in `packing_overhead_bytes`; exact `logical × bytes_per_param` identity is required only for uniform unquantized formats. |
| M6 | No machine-specific assumption leaked into reusable infrastructure | PASS — the 64 GB RAM sanity cap is removed from profiler tests (generic validity only: `> 0`, integer fit, successful OS query); VRAM/RAM default policies are defined relative to *measured* totals, not absolute numbers; benchmark workload caps (1.5 GB host / 2 GB VRAM) are suite constraints, not schema constraints, and exist only to fit the target laptop. |
| M7 | Phase 1 remains CPU-first and offline | PASS — steps 1–7 of §I are CPU-only; GPU work is additive and skippable (step 8); zero network access (ground rule 3, gate C7). |
| M8 | STARK-001..007 untouched | PASS — this revision edits `design/V009_phase1_M0_specification.md` only; no source, CMake, or test file of STARK-001..007 is modified; no V008/V009 architecture component (Resource Fabric, ProviderAdapter, ResourceRouter, APIs, cloud) is specified for implementation in Phase 1. |
| M9 | Determinism is representable without universal bit-identity | PASS — the triple `deterministic_mode_requested` / `deterministic_mode_available` / `outputs_bit_identical` is in every record; only the CPU FP32 deterministic configuration may *require* bit-identity; GPU outcomes are valid without it. |
| M10 | Optimizer zero-state is legitimate | PASS — `optimizer_bytes = 0` valid iff `optimizer_type`/`optimizer_configuration` genuinely has no auxiliary state (plain SGD without momentum); unknown state size is null + reason. |
