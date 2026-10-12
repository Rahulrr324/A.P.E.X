#pragma once

/**
 * STARK Phase 1 (M0): BenchmarkHarness (spec §B/F)
 *
 * Deterministic, reproducible timing infrastructure:
 *   - steady_clock wall timing (never clock())
 *   - >=3 warmup iterations, >=10 timed iterations (configurable, validated)
 *   - raw samples ALWAYS stored; statistics computed from them
 *   - peak RAM via process queries (Windows GetProcessMemoryInfo / POSIX ru_maxrss)
 *   - peak VRAM via cudaMemGetInfo delta (CUDA builds only)
 *   - failures recorded, never swallowed: a failed benchmark is a measurement
 *   - no fabricated values anywhere
 *
 * Affinity (campaign instrumentation addition):
 *   - thread_count remains a policy field; it is NOT an OS affinity guarantee.
 *   - affinity provenance is recorded as an optional structured block via
 *     optional_affinity_provenance on BenchResult when the caller has
 *     performed/verified affinity control through HardwareAffinity.
 *   - The harness does not itself claim pinning; it merely carries whatever
 *     the caller asserts, honestly.
 */

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "common/ExperimentRecord.h"
#include "common/HardwareAffinity.h"
#include "bench/TinyDenseModel.h"

namespace stark_p1 {

struct BenchConfig {
    std::string benchmark_id;    // "B1".."B9" or baseline id
    uint32_t warmup_count = 3;   // >= 3 per spec
    uint32_t measurement_count = 10; // >= 10 per spec
    uint32_t thread_count = 0;   // 0 = natural; pinned per benchmark
    uint32_t batch_size = 1;
    uint32_t sequence_length = 0; // 0 = sequence-agnostic (MLP)
    std::string precision = "FP32";
    std::string storage_format = "FP32";
    std::map<std::string, std::string> workload_params; // fixed workload description
    bool deterministic_mode_requested = false;

    std::vector<std::string> validate() const;
};

struct AffinityProvenance {
    // From HardwareAffinity::query()/requestAndVerifyFirstCpu()/effectiveMaskJson()
    bool supported = false;
    bool query_ok = false;
    bool set_ok = false;
    std::vector<uint32_t> effective_logical_cpus;
    std::string reason;            // empty when ok; "unavailable: ..." / "failed: ..." otherwise

    // Raw production evidence captured by HardwareAffinity (nullopt = not
    // observed on this platform / not attempted; never fabricated).
    std::optional<uint32_t> requested_cpu;
    std::optional<int64_t> set_api_return;
    std::optional<uint32_t> set_api_last_error;
    std::optional<uint64_t> raw_process_mask;
    std::optional<uint64_t> raw_system_mask;
    bool verified_single_cpu = false;
};

struct PeakMemorySample {
    std::optional<uint64_t> ram_peak_bytes;    // process peak working set (Windows) / maxrss (POSIX)
    std::optional<uint64_t> vram_peak_bytes;   // CUDA only: free-VRAM delta
    bool ram_measured = false;
    bool vram_measured = false;
    std::map<std::string, std::string> provenance;
};

/// Sample current process peak RAM. Never fabricated.
PeakMemorySample sample_peak_memory();

using TimedOp = std::function<void()>;  // returns nothing; harness times wall duration

/// Result of one benchmark execution.
struct BenchResult {
    BenchConfig config;
    Statistics stats;                 // computed from samples (seconds)
    PeakMemorySample peak;            // measured peak memory
    std::vector<FailureEntry> failures;
    bool ok = false;                  // all iterations completed without error
    std::string error;                // first error if !ok

    // Additive optional campaign instrumentation: verified affinity provenance.
    // When present and verified, the campaign may truthfully record effective
    // affinity; when absent/incomplete, the harness makes no pinning claim.
    std::optional<AffinityProvenance> optional_affinity_provenance;

    JsonValue peak_memory_json() const;
    JsonValue affinity_provenance_json() const;
};

/// Run `op` warmup_count times, then measurement_count times, recording each
/// timed duration. Catches exceptions from op: a throwing iteration is recorded
/// as a failure and the benchmark is marked failed (a failed benchmark is a
/// measurement, not a silent discard).
BenchResult run_benchmark(const BenchConfig& config, const TimedOp& op);

/// Assemble a complete ExperimentRecord from a BenchResult.
/// `hardware` must be an embedded static-profile snapshot (never name-only).
ExperimentRecord make_benchmark_record(const std::string& record_id,
                                       const std::string& experiment_id,
                                       const std::string& kind,
                                       RunStatus status,
                                       const std::string& status_reason,
                                       const BenchResult& result,
                                       const JsonValue& hardware,
                                       const DeterminismInfo& determinism,
                                       const JsonValue& accounting /* null ok */,
                                       const JsonValue& budget /* null ok */,
                                       const std::map<std::string, JsonValue>& extra_provenance = {});

/// Apply campaign affinity instrumentation to a BenchResult BEFORE any timed
/// benchmark work begins. This sets optional_affinity_provenance from the
/// verified HardwareAffinity implementation. It does NOT modify the timed op
/// and does NOT introduce affinity cost into measured samples.
void apply_campaign_affinity(BenchResult& result);

// ---- Campaign-usable benchmark functions (exported from the harness) ----

// B6: Tiny inference latency (TINY-DENSE-2L forward)
BenchResult bench_tiny_inference(const BenchConfig& base, TinyDenseModel& model);

// B7: Model load time (deserialize weights)
BenchResult bench_model_load_time(TinyDenseModel& model, const std::string& out_dir, const BenchConfig& base);

// B9: Inference stability (200 repeats, bit-identical check)
struct StabilityOutcome {
    BenchResult result;
    bool bit_identical = false;
};
StabilityOutcome bench_inference_stability(TinyDenseModel& model, const BenchConfig& base);

} // namespace stark_p1
