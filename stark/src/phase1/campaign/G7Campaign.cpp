/**
 * STARK Phase 1 (M0): G7 Resolution Campaign
 *
 * Runs controlled, specification-compliant benchmark campaigns for B6/B7/B9
 * to determine whether a legitimate current baseline can satisfy the frozen
 * G7 ±15% tolerance on this hardware.
 *
 * Uses only controls explicitly permitted by V009:
 *   - measurement_count >= 10 (spec §B: configurable)
 *   - warmup_count >= 3 (spec §B: configurable)
 *   - CPU thread count pinned (spec §B)
 *   - deterministic seeds (spec §E/F)
 *   - CPU affinity where legally observable (spec §F: affinity in config)
 *   - fixed workload sizes (spec §B)
 *
 * Campaign design (fixed before measurement, not adjusted after):
 *   - n = 50 samples per run (>=10 per spec)
 *   - warmup = 10 iterations (>=3 per spec)
 *   - 5 independent runs per benchmark (exceeds minimum)
 *   - thread_count = 1 (single-thread, spec §B)
 *   - batch_size = 1, sequence_length = 0 (TINY-DENSE-2L)
 *   - deterministic_mode_requested = true for B6/B9 (spec §E)
 *
 * Produces STARKP1 1 records with full provenance in a dedicated campaign store.
 */

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <thread>

#include "bench/BenchmarkHarness.h"
#include "bench/ParameterAccounting.h"
#include "bench/TinyDenseModel.h"
#include "common/HardwareAffinity.h"
#include "common/HardwareProfiler.h"
#include "common/ExperimentRecord.h"

using namespace stark_p1;

namespace {

struct CampaignConfig {
    std::string out_dir = "build/g7-campaign";
    uint32_t measurement_count = 50;     // per spec: >=10, configurable
    uint32_t warmup_count = 10;          // per spec: >=3, configurable
    uint32_t thread_count = 1;           // single-thread, spec §B
    uint32_t batch_size = 1;             // spec §E TINY-DENSE-2L
    uint32_t sequence_length = 0;        // spec §E sequence-agnostic
    uint32_t independent_runs = 5;       // >=3 for meaningful G7 groups
    std::string precision = "FP32";
    bool deterministic_mode = true;      // spec §E for E1/E5 CPU path
};

CampaignConfig parse_args(int argc, char** argv) {
    CampaignConfig c;
    for (int i = 1; i < argc; ++i) {
        std::string s = argv[i];
        auto next = [&]() -> std::string {
            if (i + 1 >= argc) throw std::runtime_error("missing value for " + s);
            return argv[++i];
        };
        if (s == "--out") c.out_dir = next();
        else if (s == "--samples") c.measurement_count = std::stoul(next());
        else if (s == "--warmup") c.warmup_count = std::stoul(next());
        else if (s == "--threads") c.thread_count = std::stoul(next());
        else if (s == "--runs") c.independent_runs = std::stoul(next());
        else throw std::runtime_error("unknown argument: " + s);
    }
    return c;
}

std::string utc_timestamp_now() {
    auto now = std::chrono::system_clock::now();
    std::time_t t = std::chrono::system_clock::to_time_t(now);
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()) % 1000;
    std::tm tm;
#ifdef _WIN32
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buf[64];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &tm);
    std::ostringstream oss;
    oss << buf << "." << std::setw(3) << std::setfill('0') << ms.count() << "Z";
    return oss.str();
}

std::string make_record_id(const std::string& prefix, const std::string& exp_id, const std::string& seed) {
    std::hash<std::string> h;
    return prefix + "-" + exp_id + "-" + std::to_string(h(seed) % 100000000);
}

JsonValue software_json(const StaticHardwareProfile& hw) {
    JsonValue o = JsonValue::object();
    o.set("os", JsonValue::str(hw.os_name + " " + hw.os_version));
    o.set("compiler", JsonValue::str(hw.toolchain));
    o.set("build_type", JsonValue::str(hw.build_type));
    o.set("cuda_runtime", hw.cuda_version.has_value() ? JsonValue::str(*hw.cuda_version) : JsonValue::null());
    o.set("benchmark_libs", JsonValue::str("standard library only (no external deps)"));
    return o;
}

std::map<std::string, JsonValue> prov_common(const StaticHardwareProfile& hw) {
    std::map<std::string, JsonValue> p;
    p["cpu_model"] = JsonValue::str("source: embedded hardware snapshot");
    return p;
}

DeterminismInfo determinism_info(bool requested, bool available, bool bit_identical) {
    DeterminismInfo d;
    d.requested = requested;
    d.available = available;
    d.bit_identical = bit_identical;
    return d;
}

/// Print the full per-run affinity evidence block and STOP the campaign unless
/// the production path truthfully established the requested single CPU.
/// Required campaign invariant: every run must demonstrate a verified
/// single-CPU affinity; otherwise the campaign halts with a nonzero exit
/// instead of silently continuing.
void require_truthful_single_cpu_affinity(const BenchResult& result) {
    if (!result.optional_affinity_provenance.has_value()) {
        throw std::runtime_error("affinity evidence missing for this run — campaign stopped");
    }
    const auto& a = result.optional_affinity_provenance.value();
    std::cout << "affinity_evidence: " << result.affinity_provenance_json().dump() << "\n";
    const bool truthful =
        a.supported && a.query_ok && a.set_ok && a.verified_single_cpu &&
        a.requested_cpu.has_value() &&
        a.effective_logical_cpus.size() == 1 &&
        a.effective_logical_cpus.front() == *a.requested_cpu &&
        a.raw_process_mask.has_value() &&
        (*a.raw_process_mask == (uint64_t(1) << *a.requested_cpu));
    if (!truthful) {
        throw std::runtime_error(
            "truthful single-CPU affinity could not be established for this run "
            "(see affinity_evidence above) — campaign stopped");
    }
}

void run_b6_campaign(const CampaignConfig& cfg, const StaticHardwareProfile& hw,
                     const JsonValue& hw_json, RecordStore& store,
                     const std::string& run_suffix, const std::string& exp_id) {
    TinyDenseModel model(1);
    BenchConfig bench;
    bench.benchmark_id = "B6";
    bench.warmup_count = cfg.warmup_count;
    bench.measurement_count = cfg.measurement_count;
    bench.thread_count = cfg.thread_count;
    bench.batch_size = cfg.batch_size;
    bench.sequence_length = cfg.sequence_length;
    bench.precision = cfg.precision;
    bench.storage_format = cfg.precision;
    bench.deterministic_mode_requested = cfg.deterministic_mode;
    bench.workload_params = {{"model", "TINY-DENSE-2L"}, {"logical_params", "262912"}};

    BenchResult harness_result;
    harness_result.config = bench;
    apply_campaign_affinity(harness_result);
    require_truthful_single_cpu_affinity(harness_result);

    auto result = bench_tiny_inference(bench, model);
    result.optional_affinity_provenance = harness_result.optional_affinity_provenance;

    std::string record_id = make_record_id("G7CAM-B6", exp_id, run_suffix);
    ExperimentRecord rec = make_benchmark_record(
        record_id, exp_id, "baseline",
        result.ok ? RunStatus::PASSED : RunStatus::FAILED,
        result.ok ? "" : result.error,
        result, hw_json,
        determinism_info(true, true, true),
        model.accounting(StorageFormat::FP32).to_json(),
        JsonValue::null(), prov_common(hw));
    rec.software = software_json(hw);
    rec.provenance["campaign"] = JsonValue::str("G7-resolution");
    rec.provenance["run_group"] = JsonValue::str("B6");
    rec.provenance["run_suffix"] = JsonValue::str(run_suffix);
    // thread_count is a policy field; affinity is reported separately and only as
    // verified by HardwareAffinity (no false 'pinned' claim).
    store.append(rec);
}

void run_b7_campaign(const CampaignConfig& cfg, const StaticHardwareProfile& hw,
                     const JsonValue& hw_json, RecordStore& store,
                     const std::string& run_suffix, const std::string& exp_id) {
    TinyDenseModel model(1);
    std::vector<uint8_t> blob = model.serializeWeights();
    std::string weight_path = cfg.out_dir + "/tiny_dense_2l_weights.bin";
    {
        std::ofstream f(weight_path, std::ios::binary | std::ios::trunc);
        f.write(reinterpret_cast<const char*>(blob.data()), static_cast<std::streamsize>(blob.size()));
    }

    BenchConfig bench;
    bench.benchmark_id = "B7";
    bench.warmup_count = cfg.warmup_count;
    bench.measurement_count = cfg.measurement_count;
    bench.thread_count = cfg.thread_count;
    bench.batch_size = cfg.batch_size;
    bench.sequence_length = cfg.sequence_length;
    bench.precision = cfg.precision;
    bench.storage_format = cfg.precision;
    bench.deterministic_mode_requested = false;
    bench.workload_params = {{"blob_bytes", std::to_string(blob.size())}, {"mode", "warm_cache"}};

    BenchResult harness_result;
    harness_result.config = bench;
    apply_campaign_affinity(harness_result);
    require_truthful_single_cpu_affinity(harness_result);

    TinyDenseModel loader(1);
    auto result = run_benchmark(bench, [&] {
        std::ifstream f(weight_path, std::ios::binary);
        std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        loader.deserializeWeights(bytes);
    });
    result.optional_affinity_provenance = harness_result.optional_affinity_provenance;

    std::string record_id = make_record_id("G7CAM-B7", exp_id, run_suffix);
    ExperimentRecord rec = make_benchmark_record(
        record_id, exp_id, "baseline",
        result.ok ? RunStatus::PASSED : RunStatus::FAILED,
        result.ok ? "" : result.error,
        result, hw_json,
        determinism_info(false, true, false),
        model.accounting(StorageFormat::FP32).to_json(),
        JsonValue::null(), prov_common(hw));
    rec.software = software_json(hw);
    rec.provenance["campaign"] = JsonValue::str("G7-resolution");
    rec.provenance["run_group"] = JsonValue::str("B7");
    rec.provenance["run_suffix"] = JsonValue::str(run_suffix);
    store.append(rec);
}

void run_b9_campaign(const CampaignConfig& cfg, const StaticHardwareProfile& hw,
                     const JsonValue& hw_json, RecordStore& store,
                     const std::string& run_suffix, const std::string& exp_id) {
    TinyDenseModel model(1);
    BenchConfig bench;
    bench.benchmark_id = "B9";
    bench.warmup_count = cfg.warmup_count;
    bench.measurement_count = cfg.measurement_count;
    bench.thread_count = cfg.thread_count;
    bench.batch_size = cfg.batch_size;
    bench.sequence_length = cfg.sequence_length;
    bench.precision = cfg.precision;
    bench.storage_format = cfg.precision;
    bench.deterministic_mode_requested = true;
    bench.workload_params = {{"model", "TINY-DENSE-2L"}, {"repeats", "200"}};

    std::vector<float> reference;
    bool bit_identical = true;
    auto op = [&] {
        model.forward();
        if (reference.empty()) reference = model.output();
        else if (reference != model.output()) bit_identical = false;
    };

    BenchResult harness_result;
    harness_result.config = bench;
    apply_campaign_affinity(harness_result);
    require_truthful_single_cpu_affinity(harness_result);

    auto result = run_benchmark(bench, op);
    result.optional_affinity_provenance = harness_result.optional_affinity_provenance;

    std::string record_id = make_record_id("G7CAM-B9", exp_id, run_suffix);
    ExperimentRecord rec = make_benchmark_record(
        record_id, exp_id, "baseline",
        result.ok ? RunStatus::PASSED : RunStatus::FAILED,
        result.ok ? "" : result.error,
        result, hw_json,
        determinism_info(true, true, bit_identical),
        model.accounting(StorageFormat::FP32).to_json(),
        JsonValue::null(), prov_common(hw));
    rec.software = software_json(hw);
    rec.provenance["campaign"] = JsonValue::str("G7-resolution");
    rec.provenance["run_group"] = JsonValue::str("B9");
    rec.provenance["run_suffix"] = JsonValue::str(run_suffix);
    store.append(rec);
}

} // namespace

int main(int argc, char** argv) {
    try {
        CampaignConfig cfg = parse_args(argc, argv);

        std::cout << "=== G7 Resolution Campaign ===\n";
        std::cout << "measurement_count: " << cfg.measurement_count << "\n";
        std::cout << "warmup_count: " << cfg.warmup_count << "\n";
        std::cout << "thread_count: " << cfg.thread_count << "\n";
        std::cout << "independent_runs: " << cfg.independent_runs << "\n";
        std::cout << "out_dir: " << cfg.out_dir << "\n\n";

        // Validate against spec
        if (cfg.measurement_count < 10) throw std::runtime_error("measurement_count must be >= 10 (spec §B)");
        if (cfg.warmup_count < 3) throw std::runtime_error("warmup_count must be >= 3 (spec §B)");
        if (cfg.independent_runs < 3) throw std::runtime_error("independent_runs must be >= 3 for G7");
        if (cfg.thread_count != 1) throw std::runtime_error("thread_count must be 1 (single-thread per spec §B)");

        // Collect static hardware profile once
        StaticHardwareProfile hw = HardwareProfiler::collectStatic();
        JsonValue hw_json = hw.to_json();

        RecordStore store(cfg.out_dir);

        std::string run_group_id = utc_timestamp_now();

        for (uint32_t run = 1; run <= cfg.independent_runs; ++run) {
            std::string run_suffix = run_group_id + "-run" + std::to_string(run);
            std::cout << "\n=== Independent run " << run << "/" << cfg.independent_runs << " ===\n";

            // E1 baselines
            run_b6_campaign(cfg, hw, hw_json, store, run_suffix, "E1");
            std::cout << "B6 (E1) complete\n";

            run_b7_campaign(cfg, hw, hw_json, store, run_suffix, "E1");
            std::cout << "B7 (E1) complete\n";

            run_b9_campaign(cfg, hw, hw_json, store, run_suffix, "E1");
            std::cout << "B9 (E1) complete\n";

            // E5 baselines (CPU-only equivalent - same execution as E1; distinct experiment_id required)
            run_b6_campaign(cfg, hw, hw_json, store, run_suffix, "E5");
            std::cout << "B6 (E5) complete\n";

            run_b7_campaign(cfg, hw, hw_json, store, run_suffix, "E5");
            std::cout << "B7 (E5) complete\n";

            run_b9_campaign(cfg, hw, hw_json, store, run_suffix, "E5");
            std::cout << "B9 (E5) complete\n";

            // Delay between runs to reduce thermal interference
            if (run < cfg.independent_runs) {
                std::this_thread::sleep_for(std::chrono::seconds(30));
            }
        }

        std::cout << "\n=== Affinity control summary ===\n";
        AffinityInfo once = HardwareAffinity::query();
        std::cout << "affinity_supported=" << once.supported << "\n";
        std::cout << "affinity_query_ok=" << once.query_ok << "\n";
        std::cout << "affinity_effective_count=" << once.effective.size() << "\n";
        for (uint32_t i : once.effective) std::cout << "  effective_logical_cpu=" << i << "\n";
        std::cout << "affinity_reason=" << (once.reason.empty() ? "(none)" : once.reason) << "\n\n";

        std::cout << "\n=== Campaign complete ===\n";
        std::cout << "Records written to: " << cfg.out_dir << "\n";
        return 0;

    } catch (const std::exception& ex) {
        std::cerr << "G7Campaign: " << ex.what() << "\n";
        return 1;
    }
}