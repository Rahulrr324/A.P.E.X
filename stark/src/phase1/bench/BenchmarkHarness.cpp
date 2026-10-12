#include "bench/BenchmarkHarness.h"

#include <algorithm>
#include <chrono>
#include <fstream>
#include <iterator>
#include <stdexcept>

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
#else
#include <sys/resource.h>
#endif

#if defined(STARK_ENABLE_CUDA)
#include <cuda_runtime.h>
#define STARK_P1_CUDA_COMPILED 1
#endif

namespace stark_p1 {

using Clock = std::chrono::steady_clock;

std::vector<std::string> BenchConfig::validate() const {
    std::vector<std::string> errs;
    if (benchmark_id.empty()) errs.push_back("benchmark_id empty");
    if (warmup_count < 3) errs.push_back("warmup_count must be >= 3 (spec §B)");
    if (measurement_count < 10) errs.push_back("measurement_count must be >= 10 (spec §B)");
    return errs;
}

PeakMemorySample sample_peak_memory() {
    PeakMemorySample s;
#ifdef _WIN32
    PROCESS_MEMORY_COUNTERS pmc{};
    pmc.cb = sizeof(pmc);
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) {
        s.ram_peak_bytes = static_cast<uint64_t>(pmc.PeakWorkingSetSize);
        s.ram_measured = true;
        s.provenance["ram_peak_bytes"] = "source: GetProcessMemoryInfo PeakWorkingSetSize (measured)";
    } else {
        s.provenance["ram_peak_bytes"] = "unavailable: GetProcessMemoryInfo failed";
    }
#ifdef STARK_P1_CUDA_COMPILED
    if (HardwareProfiler::cudaRuntimeAvailable()) {
        size_t freeb = 0, totalb = 0;
        if (cudaMemGetInfo(&freeb, &totalb) == cudaSuccess) {
            (void)freeb; (void)totalb;
            // VRAM peak tracking in Phase 1: free-VRAM delta sampled by the caller
            // around an allocation. The harness records the delta if a callback sets it.
            s.vram_measured = false;
            s.provenance["vram_peak_bytes"] = "unavailable: no CUDA allocation scope in this benchmark";
        }
    } else {
        s.provenance["vram_peak_bytes"] = "unavailable: built without CUDA";
    }
#else
    s.provenance["vram_peak_bytes"] = "unavailable: binary built without CUDA";
#endif
#else
    struct rusage ru{};
    if (getrusage(RUSAGE_SELF, &ru) == 0) {
        s.ram_peak_bytes = static_cast<uint64_t>(ru.ru_maxrss) * 1024ULL; // Linux: KB
        s.ram_measured = true;
        s.provenance["ram_peak_bytes"] = "source: getrusage ru_maxrss (measured)";
    } else {
        s.provenance["ram_peak_bytes"] = "unavailable: getrusage failed";
    }
    s.provenance["vram_peak_bytes"] = "unavailable: binary built without CUDA";
#endif
    return s;
}

BenchResult run_benchmark(const BenchConfig& config, const TimedOp& op) {
    auto cfg_errors = config.validate();
    BenchResult result;
    result.config = config;
    for (const auto& e : cfg_errors) {
        result.failures.push_back({"config", e, false});
    }
    if (!cfg_errors.empty()) {
        result.ok = false;
        result.error = "invalid configuration";
        return result;
    }

    try {
        for (uint32_t i = 0; i < config.warmup_count; ++i) op();
    } catch (const std::exception& ex) {
        result.ok = false;
        result.error = std::string("warmup failed: ") + ex.what();
        result.failures.push_back({"warmup", result.error, false});
        return result;
    }

    std::vector<double> samples;
    samples.reserve(config.measurement_count);
    for (uint32_t i = 0; i < config.measurement_count; ++i) {
        auto t0 = Clock::now();
        try {
            op();
        } catch (const std::exception& ex) {
            result.ok = false;
            result.error = std::string("iteration ") + std::to_string(i) + " failed: " + ex.what();
            result.failures.push_back({"iteration", result.error, false});
            result.stats = compute_statistics(std::move(samples));  // partial samples kept
            return result;
        }
        auto t1 = Clock::now();
        double sec = std::chrono::duration<double>(t1 - t0).count();
        if (!(sec >= 0.0)) {  // clock sanity; steady_clock should never go backwards
            result.failures.push_back({"timer", "non-monotonic sample discarded", false});
            continue;
        }
        samples.push_back(sec);
    }

    if (samples.size() < config.measurement_count && result.failures.empty()) {
        result.failures.push_back({"timer", "some samples discarded by clock sanity check", false});
    }
    result.stats = compute_statistics(std::move(samples));
    result.peak = sample_peak_memory();
    result.ok = true;
    return result;
}

void apply_campaign_affinity(BenchResult& result) {
    // Query effective affinity before any timed work.
    AffinityInfo info = HardwareAffinity::query();
    if (info.supported && info.query_ok && !info.effective.empty()) {
        // Attempt the intended single-CPU restriction.
        AffinityInfo rv = HardwareAffinity::requestAndVerifyFirstCpu();
        result.optional_affinity_provenance.emplace();
        auto& a = result.optional_affinity_provenance.value();
        a.supported = info.supported;
        a.query_ok = info.query_ok;
        a.set_ok = rv.set_ok;
        a.reason = rv.reason.empty() ? info.reason : rv.reason;
        a.effective_logical_cpus = rv.effective.empty() ? info.effective : rv.effective;
        a.requested_cpu = rv.requested_cpu;
        a.set_api_return = rv.set_api_return;
        a.set_api_last_error = rv.set_api_last_error;
        a.raw_process_mask = rv.raw_process_mask;
        a.raw_system_mask = rv.raw_system_mask;
        a.verified_single_cpu = rv.verified_single_cpu;
    } else {
        result.optional_affinity_provenance.emplace();
        auto& a = result.optional_affinity_provenance.value();
        a.supported = info.supported;
        a.query_ok = info.query_ok;
        a.set_ok = false;
        a.reason = info.reason.empty() ? "affinity not established or verified" : info.reason;
        a.raw_process_mask = info.raw_process_mask;
        a.raw_system_mask = info.raw_system_mask;
    }
}

JsonValue BenchResult::peak_memory_json() const {
    JsonValue o = JsonValue::object();
    auto reasoned = [&](const std::optional<uint64_t>& v, const char* key) {
        if (v.has_value()) return JsonValue::uinteger(*v);
        JsonValue r = JsonValue::object();
        r.set("value", JsonValue::null());
        auto it = peak.provenance.find(key);
        r.set("reason", JsonValue::str(it != peak.provenance.end() ? it->second : "unavailable"));
        return r;
    };
    o.set("ram_peak_bytes", reasoned(peak.ram_peak_bytes, "ram_peak_bytes"));
    o.set("vram_peak_bytes", reasoned(peak.vram_peak_bytes, "vram_peak_bytes"));
    o.set("ram_measured", JsonValue::boolean(peak.ram_measured));
    o.set("vram_measured", JsonValue::boolean(peak.vram_measured));
    return o;
}

JsonValue BenchResult::affinity_provenance_json() const {
    if (!optional_affinity_provenance.has_value()) return JsonValue::null();
    const auto& a = optional_affinity_provenance.value();
    JsonValue o = JsonValue::object();
    o.set("supported", JsonValue::boolean(a.supported));
    o.set("query_ok", JsonValue::boolean(a.query_ok));
    o.set("set_ok", JsonValue::boolean(a.set_ok));
    JsonValue arr = JsonValue::array();
    for (uint32_t i : a.effective_logical_cpus) arr.append(JsonValue::uinteger(i));
    o.set("effective_logical_cpus", std::move(arr));
    o.set("reason", a.reason.empty() ? JsonValue::null() : JsonValue::str(a.reason));
    // Raw production evidence (nullopt serialized as null; never fabricated).
    o.set("requested_cpu",
          a.requested_cpu ? JsonValue::uinteger(*a.requested_cpu) : JsonValue::null());
    o.set("set_api_return",
          a.set_api_return ? JsonValue::integer(*a.set_api_return) : JsonValue::null());
    o.set("set_api_last_error",
          a.set_api_last_error ? JsonValue::uinteger(*a.set_api_last_error) : JsonValue::null());
    o.set("raw_process_mask",
          a.raw_process_mask ? JsonValue::uinteger(*a.raw_process_mask) : JsonValue::null());
    o.set("raw_system_mask",
          a.raw_system_mask ? JsonValue::uinteger(*a.raw_system_mask) : JsonValue::null());
    o.set("verified_single_cpu", JsonValue::boolean(a.verified_single_cpu));
    return o;
}

ExperimentRecord make_benchmark_record(const std::string& record_id,
                                       const std::string& experiment_id,
                                       const std::string& kind,
                                       RunStatus status,
                                       const std::string& status_reason,
                                       const BenchResult& result,
                                       const JsonValue& hardware,
                                       const DeterminismInfo& determinism,
                                       const JsonValue& accounting,
                                       const JsonValue& budget,
                                       const std::map<std::string, JsonValue>& extra_provenance) {
    ExperimentRecord rec;
    rec.record_id = record_id;
    rec.schema_version = "STARKP1 1";
    rec.created_utc = RecordStore::utc_timestamp_now();
    rec.stark_phase = "P1";
    rec.kind = kind;
    rec.experiment_id = experiment_id;
    rec.status = status;
    rec.status_reason = status_reason;
    rec.hardware = hardware;
    rec.software = [] {
        // Software/toolchain identity from compile-time macros (no fabrication).
        JsonValue o = JsonValue::object();
#if defined(_MSC_VER)
        o.set("compiler", JsonValue::str(std::string("MSVC ") + std::to_string(_MSC_VER)));
#elif defined(__clang__)
        o.set("compiler", JsonValue::str(std::string("Clang ") + __clang_version__));
#elif defined(__GNUC__)
        o.set("compiler", JsonValue::str(std::string("GCC ") + std::to_string(__GNUC__) + "." +
                                         std::to_string(__GNUC_MINOR__) + "." +
                                         std::to_string(__GNUC_PATCHLEVEL__)));
#else
        o.set("compiler", JsonValue::str("unknown"));
#endif
#ifdef NDEBUG
        o.set("build_type", JsonValue::str("Release"));
#else
        o.set("build_type", JsonValue::str("Debug"));
#endif
        o.set("benchmark_libs", JsonValue::str("standard library only"));
        return o;
    }();
    rec.determinism = determinism;
    rec.accounting = accounting;
    rec.budget = budget;
    rec.failures = result.failures;
    if (status == RunStatus::PASSED) rec.statistics = result.stats;

    // configuration block
    JsonValue cfg = JsonValue::object();
    cfg.set("benchmark_id", JsonValue::str(result.config.benchmark_id));
    cfg.set("warmup_count", JsonValue::uinteger(result.config.warmup_count));
    cfg.set("measurement_count", JsonValue::uinteger(result.config.measurement_count));
    cfg.set("thread_count", JsonValue::uinteger(result.config.thread_count));
    cfg.set("batch_size", JsonValue::uinteger(result.config.batch_size));
    cfg.set("sequence_length", JsonValue::uinteger(result.config.sequence_length));
    JsonValue wp = JsonValue::object();
    for (const auto& [k, v] : result.config.workload_params) wp.set(k, JsonValue::str(v));
    cfg.set("workload_params", std::move(wp));
    rec.configuration = std::move(cfg);

    // precision block
    JsonValue prec = JsonValue::object();
    prec.set("compute_precision", JsonValue::str(result.config.precision));
    prec.set("storage_format", JsonValue::str(result.config.storage_format));
    rec.precision = std::move(prec);

    // peak memory
    rec.peak_memory = result.peak_memory_json();

    // additive optional affinity provenance (campaign instrumentation)
    if (result.optional_affinity_provenance.has_value()) {
        rec.provenance["affinity"] = result.affinity_provenance_json();
    }

    // provenance
    for (const auto& [k, v] : extra_provenance) rec.provenance[k] = v;

    return rec;
}


// ====================================================================
// Campaign-usable benchmark implementations
// ====================================================================

// B6: Tiny inference latency (TINY-DENSE-2L forward)
BenchResult bench_tiny_inference(const BenchConfig& base, TinyDenseModel& model) {
    BenchConfig cfg = base;
    cfg.benchmark_id = "B6";
    cfg.workload_params = {{"model", "TINY-DENSE-2L"}, {"logical_params", "262912"}};
    return run_benchmark(cfg, [&] { model.forward(); });
}

// B7: Model load time (deserialize weights)
BenchResult bench_model_load_time(TinyDenseModel& model, const std::string& out_dir, const BenchConfig& base) {
    std::vector<uint8_t> blob = model.serializeWeights();
    std::string path = out_dir + "/tiny_dense_2l_weights.bin";
    {
        std::ofstream f(path, std::ios::binary | std::ios::trunc);
        f.write(reinterpret_cast<const char*>(blob.data()), static_cast<std::streamsize>(blob.size()));
        if (!f) throw std::runtime_error("cannot write weight blob");
    }
    BenchConfig cfg = base;
    cfg.benchmark_id = "B7";
    cfg.workload_params = {{"blob_bytes", std::to_string(blob.size())}, {"mode", "warm_cache"}};
    TinyDenseModel loader(1);
    return run_benchmark(cfg, [&] {
        std::ifstream f(path, std::ios::binary);
        if (!f) throw std::runtime_error("cannot open weight blob");
        std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        loader.deserializeWeights(bytes);
    });
}

// B9: Inference stability (200 repeats, bit-identical check)
StabilityOutcome bench_inference_stability(TinyDenseModel& model, const BenchConfig& base) {
    StabilityOutcome out;
    BenchConfig cfg = base;
    cfg.benchmark_id = "B9";
    cfg.deterministic_mode_requested = true;
    cfg.workload_params = {{"model", "TINY-DENSE-2L"}, {"repeats", "200"}};

    std::vector<float> reference;
    bool identical = true;
    auto op = [&] {
        model.forward();
        if (reference.empty()) reference = model.output();
        else if (reference != model.output()) identical = false;
    };
    out.result = run_benchmark(cfg, op);
    out.bit_identical = identical;
    return out;
}

} // namespace stark_p1
