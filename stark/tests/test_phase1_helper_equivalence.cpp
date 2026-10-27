/**
 * Focused compatibility test, NOT an official arm or acceptance measurement.
 * Compares complete serialized records produced by original local helpers and
 * retained harness helpers. The original CLI was ill-formed; the test reference
 * changes namespace placement, not helper bodies. No campaign or RecordStore.
 *
 * Only host-variable fields are normalized: creation timestamp, timing values
 * (but NOT sample count/computed), numeric peak-memory values (but NOT measured
 * flags or unavailable reasons). All remaining JSON fields compare exactly.
 */
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
#include "test_harness.h"
#include "bench/BenchmarkHarness.h"
#include "common/HardwareProfiler.h"

namespace reference_v371d06f {
using namespace stark_p1;
#include "compatibility/baseline_helpers_v371d06f.inc"
}

using namespace stark_p1;
namespace {
struct Scratch {
    std::filesystem::path path;
    explicit Scratch(const char* name) : path(std::filesystem::current_path() / name) {
        // Refuse to overwrite prior outputs, including an existing empty directory.
        if (!std::filesystem::create_directory(path)) throw std::runtime_error("scratch directory already exists");
    }
    ~Scratch() { std::error_code ec; std::filesystem::remove_all(path, ec); }
};

JsonValue normalized(const JsonValue& v, const std::string& path = "") {
    if (v.isObject()) {
        JsonValue result = JsonValue::object();
        for (const auto& [key, value] : v.entries()) {
            const auto child = path.empty() ? key : path + "." + key;
            if (child == "created_utc") continue;
            if (path == "statistics" && key != "computed" && key != "samples") continue;
            if (path == "peak_memory" && (key == "ram_peak_bytes" || key == "vram_peak_bytes") &&
                (value.type() == JsonValue::Type::UInt || value.type() == JsonValue::Type::Int ||
                 value.type() == JsonValue::Type::Double)) continue;
            result.set(key, normalized(value, child));
        }
        return result;
    }
    if (path == "statistics.samples") return JsonValue::uinteger(v.items().size());
    return v;
}

ExperimentRecord record(const BenchResult& b, const JsonValue& hardware, std::optional<bool> stable = {}) {
    const bool deterministic = b.config.deterministic_mode_requested;
    return make_benchmark_record("P1-COMPAT-" + b.config.benchmark_id,
        b.config.benchmark_id, "benchmark", b.ok ? RunStatus::PASSED : RunStatus::FAILED,
        b.error, b, hardware, DeterminismInfo{deterministic, true, stable},
        TinyDenseModel(1).accounting(StorageFormat::FP32).to_json(), JsonValue::null());
}

void compare(const BenchResult& before, const BenchResult& after, const JsonValue& hardware,
             std::optional<bool> stable = {}) {
    CHECK(before.ok);
    CHECK(after.ok);
    CHECK(before.stats.samples.size() == 10);
    CHECK(after.stats.samples.size() == 10);
    for (const auto* result : {&before, &after}) {
        for (double sample : result->stats.samples) CHECK(std::isfinite(sample) && sample >= 0.0);
    }
    const auto a = record(before, hardware, stable);
    const auto b = record(after, hardware, stable);
    CHECK(a.validate().empty());
    CHECK(b.validate().empty());
    // Parse the serialized records through the production parser, not hand-picked fields.
    const auto aj = JsonValue::parse(a.serialize());
    const auto bj = JsonValue::parse(b.serialize());
    CHECK(normalized(aj).dump() == normalized(bj).dump());
    // Negative control: a changed workload must be detected by the same comparison.
    auto changed = b;
    changed.configuration.set("batch_size", JsonValue::uinteger(999));
    CHECK(normalized(aj).dump() != normalized(changed.to_json()).dump());
    std::cout << "full-record comparison " << before.config.benchmark_id << ": compatible\n";
}

std::vector<char> bytes(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw std::runtime_error("missing helper output");
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
}

int main() {
    test::set_test_name("test_phase1_helper_equivalence");
    try {
        Scratch old_dir("helper_equivalence_before"), new_dir("helper_equivalence_after");
        BenchConfig config;
        config.benchmark_id = "compatibility";
        config.warmup_count = 3;
        config.measurement_count = 10;
        // Non-default fields detect accidental loss during helper config copying.
        config.thread_count = 2;
        config.batch_size = 3;
        config.sequence_length = 7;
        const auto hw = HardwareProfiler::collectStatic().to_json();
        TinyDenseModel before(1), after(1);
        compare(reference_v371d06f::bench_tiny_inference(config, before),
                stark_p1::bench_tiny_inference(config, after), hw);
        const auto old_st = reference_v371d06f::bench_inference_stability(before, config);
        const auto new_st = stark_p1::bench_inference_stability(after, config);
        CHECK(old_st.bit_identical);
        CHECK(new_st.bit_identical);
        CHECK(old_st.bit_identical == new_st.bit_identical);
        compare(old_st.result, new_st.result, hw, old_st.bit_identical);
        compare(reference_v371d06f::bench_model_load_time(before, old_dir.path.string(), config),
                stark_p1::bench_model_load_time(after, new_dir.path.string(), config), hw);
        CHECK(bytes(old_dir.path / "tiny_dense_2l_weights.bin") == bytes(new_dir.path / "tiny_dense_2l_weights.bin"));
        // Negative controls on normalization itself: do not mask failures, precision,
        // absent-vs-present statistics, measured flags, or unexpected metadata.
        auto one = record(old_st.result, hw, true).to_json();
        auto two = one;
        two.set("status", JsonValue::str("FAILED"));
        CHECK(normalized(one).dump() != normalized(two).dump());
        two = one;
        two.set("statistics", JsonValue::null());
        CHECK(normalized(one).dump() != normalized(two).dump());
        two = one;
        two.set("precision", JsonValue::object());
        CHECK(normalized(one).dump() != normalized(two).dump());
    } catch (const std::exception& e) {
        CHECK_MSG(false, e.what());
    }
    return test::report();
}
