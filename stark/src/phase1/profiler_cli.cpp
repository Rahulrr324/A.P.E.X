/**
 * STARK Phase 1 (M0): profiler CLI (spec §J)
 *
 *   profiler_cli --out build/results
 *
 * Writes two records:
 *   P1-PROFILE-<n>.json   — static profile capture (kind: "profiler", id: "PROFILE")
 *   P1-TELEMETRY-<n>.json — one runtime telemetry sample (kind: "telemetry", id: "TELEMETRY")
 */

#include <chrono>
#include <iostream>
#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif
#include <string>

#include "common/HardwareProfiler.h"

using namespace stark_p1;

namespace {
unsigned long long counter = 0;
std::string unique_suffix() {
    // Timestamp LENGTH was always 24, so restarting the CLI reused the same ids.
    // Process id + actual high-resolution epoch + counter avoids that deterministic
    // collision. RecordStore also rejects a collision rather than overwriting.
#ifdef _WIN32
    const auto pid = _getpid();
#else
    const auto pid = getpid();
#endif
    return std::to_string(std::chrono::system_clock::now().time_since_epoch().count()) +
           "-" + std::to_string(pid) + "-" + std::to_string(counter++);
}
} // namespace

int main(int argc, char** argv) {
    std::string out = "build/results";
    for (int i = 1; i < argc; ++i) {
        std::string s = argv[i];
        if (s == "--out" && i + 1 < argc) out = argv[++i];
    }
    try {
        RecordStore store(out);
        StaticHardwareProfile hw = HardwareProfiler::collectStatic();

        auto errors = hw.validate();
        ExperimentRecord rec;
        rec.record_id = "P1-PROFILE-" + unique_suffix();
        rec.created_utc = RecordStore::utc_timestamp_now();
        rec.kind = "profiler";
        rec.experiment_id = "PROFILE";
        rec.hardware = hw.to_json();
        rec.software = [&] {
            JsonValue o = JsonValue::object();
            o.set("os", JsonValue::str(hw.os_name + " " + hw.os_version));
            o.set("compiler", JsonValue::str(hw.toolchain));
            o.set("build_type", JsonValue::str(hw.build_type));
            return o;
        }();
        for (const auto& [k, v] : hw.provenance) rec.provenance[k] = JsonValue::str(v);

        if (errors.empty() && hw.ram_total_bytes.has_value()) {
            rec.status = RunStatus::PASSED;
        } else {
            rec.status = RunStatus::FAILED;
            rec.status_reason = errors.empty() ? "" : errors[0];
            for (size_t i = 1; i < errors.size(); ++i)
                rec.failures.push_back({"profile", errors[i], false});
        }
        store.append(rec);
        std::cout << "profile record: " << rec.record_id
                  << " status=" << run_status_name(rec.status) << "\n";

        // Telemetry sample record
        RuntimeTelemetry tel = HardwareProfiler::sampleDynamic();
        ExperimentRecord trec;
        trec.record_id = "P1-TELEMETRY-" + unique_suffix();
        trec.created_utc = RecordStore::utc_timestamp_now();
        trec.kind = "telemetry";
        trec.experiment_id = "TELEMETRY";
        trec.hardware = hw.to_json();
        trec.software = [&] {
            JsonValue o = JsonValue::object();
            o.set("os", JsonValue::str(hw.os_name + " " + hw.os_version));
            o.set("compiler", JsonValue::str(hw.toolchain));
            o.set("build_type", JsonValue::str(hw.build_type));
            return o;
        }();
        JsonValue tel_json = tel.to_json();
        JsonValue peak = JsonValue::object();
        peak.set("ram_available_bytes_sample", tel_json.has("ram_available_bytes") ? tel_json.get("ram_available_bytes") : JsonValue::null());
        peak.set("vram_free_bytes_sample", tel_json.has("vram_free_bytes") ? tel_json.get("vram_free_bytes") : JsonValue::null());
        trec.peak_memory = std::move(peak);
        trec.configuration = [&] {
            JsonValue o = JsonValue::object();
            o.set("benchmark_id", JsonValue::str("TELEMETRY"));
            o.set("platform_source", JsonValue::str(tel.platform_source));
            o.set("sampled_at_utc", JsonValue::str(tel.sampled_at_utc));
            return o;
        }();
        trec.status = RunStatus::PASSED;
        store.append(trec);
        std::cout << "telemetry record: " << trec.record_id << "\n";
        return errors.empty() ? 0 : 1;
    } catch (const std::exception& ex) {
        std::cerr << "profiler_cli: " << ex.what() << "\n";
        return 2;
    }
}
