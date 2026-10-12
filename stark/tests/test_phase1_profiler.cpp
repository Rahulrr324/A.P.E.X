/**
 * STARK Phase 1 (M0): test_phase1_profiler (spec §K)
 * G1 completeness; provenance for every null; telemetry monotonicity;
 * collectStatic idempotence; generic-only validity (NO machine-specific caps).
 */

#include <iostream>
#include <string>

#include "test_harness.h"
#include "common/HardwareProfiler.h"

using namespace stark_p1;

int main() {
    test::set_test_name("test_phase1_profiler");
    // --- G1: static profile completeness on this machine ---
    StaticHardwareProfile hw = HardwareProfiler::collectStatic();
    CHECK(hw.validate().empty());                    // generic validity only
    CHECK(!hw.cpu_model.empty());                    // x86 cpuid brand string present
    CHECK(hw.ram_total_bytes.has_value());
    CHECK(*hw.ram_total_bytes > 0);                  // generic lower bound, NO upper cap (rev 1.1)
    CHECK(!hw.os_name.empty());
    CHECK(!hw.toolchain.empty());
    CHECK(!hw.build_type.empty());
    CHECK(!hw.storage_volumes.empty());
    for (const auto& v : hw.storage_volumes) {
        CHECK(v.total_bytes.has_value() && *v.total_bytes > 0);
        CHECK(v.free_bytes.has_value());
    }
    CHECK(hw.logical_cores.has_value() && *hw.logical_cores > 0);

    // No fabrication checks: CUDA fields consistent with cuda_available
    if (!hw.cuda_available) {
        CHECK(!hw.vram_total_bytes.has_value());
        CHECK(!hw.gpu_model.has_value());
        CHECK(hw.provenance.count("gpu_model") == 1);  // reason present
        CHECK(hw.provenance.at("gpu_model").rfind("unavailable:", 0) == 0);
    } else {
        CHECK(hw.vram_total_bytes.has_value() && *hw.vram_total_bytes > 0);
        CHECK(hw.provenance.count("theoretical_memory_bandwidth_gbps") == 1);
        CHECK(hw.provenance.at("theoretical_memory_bandwidth_gbps").find("THEORETICAL") != std::string::npos);
    }
    // Reserved field is always null in C++ Phase 1
    CHECK(hw.provenance.count("pytorch_cuda_available_note") == 1);

    // --- Idempotence: two collections agree on stable facts ---
    StaticHardwareProfile hw2 = HardwareProfiler::collectStatic();
    CHECK(hw2.cpu_model == hw.cpu_model);
    CHECK(hw2.ram_total_bytes == hw.ram_total_bytes);
    CHECK(hw2.logical_cores == hw.logical_cores);
    CHECK(hw2.cuda_available == hw.cuda_available);

    // --- Provenance rule: every unavailable optional has a reason ---
    auto has_reason = [&](const std::string& key) {
        return hw.provenance.count(key) == 1 && !hw.provenance.at(key).empty();
    };
    if (!hw.physical_cores.has_value()) CHECK(has_reason("physical_cores"));
    if (!hw.cpu_instruction_set_notes.has_value()) CHECK(has_reason("cpu_instruction_set_notes"));
    if (!hw.ram_total_bytes.has_value()) CHECK(has_reason("ram_total_bytes"));

    // --- Dynamic telemetry: fields + monotonic timestamps ---
    RuntimeTelemetry t1 = HardwareProfiler::sampleDynamic();
    RuntimeTelemetry t2 = HardwareProfiler::sampleDynamic();
    CHECK(!t1.sampled_at_utc.empty());
    CHECK(!t1.platform_source.empty());
    CHECK(t1.sampled_at_utc <= t2.sampled_at_utc);   // monotonic UTC strings (ISO sorts)
    if (t1.ram_total_bytes.has_value()) CHECK(*t1.ram_total_bytes > 0);
    if (t1.ram_available_bytes.has_value()) {
        CHECK(*t1.ram_available_bytes > 0);
        // available <= total (generic sanity, not machine-specific)
        if (t1.ram_total_bytes.has_value())
            CHECK(*t1.ram_available_bytes <= *t1.ram_total_bytes);
    }
    // rev 1.1: no compression heuristic field exists anywhere in telemetry
    CHECK(t1.provenance.find("ram_compression_suspect") == t1.provenance.end());

    // --- Round-trip: profile serialization preserves facts ---
    JsonValue j = hw.to_json();
    StaticHardwareProfile hw3 = StaticHardwareProfile::from_json(j);
    CHECK(hw3.cpu_model == hw.cpu_model);
    CHECK(hw3.ram_total_bytes == hw.ram_total_bytes);
    CHECK(hw3.cuda_available == hw.cuda_available);
    CHECK(hw3.storage_volumes.size() == hw.storage_volumes.size());
    CHECK(hw3.logical_cores == hw.logical_cores);

    // --- schemaVersion ---
    CHECK(HardwareProfiler::schemaVersion() == "STARKP1 1");

    std::cout << "test_phase1_profiler: " << test::assertions << " assertions, " << test::failures << " failures\n";
    return test::report();
}
