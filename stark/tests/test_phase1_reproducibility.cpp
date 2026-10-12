/**
 * STARK Phase 1 (M0): test_phase1_reproducibility (spec §K)
 * G7 mechanics: statistics computed identically from stored samples; seed recording
 * present whenever randomness exists; TINY-DENSE-2L CPU FP32 (deterministic mode
 * requested AND available) produces outputs_bit_identical == true across two
 * in-process runs with the same seed; determinism triple serialized on records.
 */

#include <iostream>
#include <string>

#include "test_harness.h"
#include "bench/BenchmarkHarness.h"
#include "bench/TinyDenseModel.h"
#include "common/HardwareProfiler.h"

using namespace stark_p1;

int main() {
    test::set_test_name("test_phase1_reproducibility");
    StaticHardwareProfile hw = HardwareProfiler::collectStatic();
    JsonValue hw_json = hw.to_json();

    // --- Seeded weights: same seed -> bit-identical weights ---
    {
        TinyDenseModel a(1), b(1);
        CHECK(a.serializeWeights() == b.serializeWeights());
        TinyDenseModel c(1);
        c.initWeights(999ULL);
        CHECK(a.serializeWeights() != c.serializeWeights());  // different seed differs
    }

    // --- Deterministic CPU FP32 forward: bit-identical outputs across runs ---
    {
        TinyDenseModel a(1), b(1);
        a.forward();
        b.forward();
        CHECK(a.output() == b.output());                       // bit-identical
        // Repeat within the same instance too
        std::vector<float> first = a.output();
        a.forward();
        CHECK(a.output() == first);
        // Batch variant is deterministic as well
        TinyDenseModel ba(8), bb(8);
        ba.forward(); bb.forward();
        CHECK(ba.output() == bb.output());
    }

    // --- Deserialized weights reproduce identical outputs ---
    {
        TinyDenseModel a(1);
        auto blob = a.serializeWeights();
        TinyDenseModel b(1);
        b.deserializeWeights(blob);
        // b now holds identical weights; rebuild input deterministically and run
        b.initInput(TinyDenseModel::kInputSeed);
        a.forward();
        b.forward();
        CHECK(a.output() == b.output());
    }

    // --- Determinism triple on a baseline record (serialized) ---
    {
        BenchConfig cfg;
        cfg.benchmark_id = "B6";
        cfg.deterministic_mode_requested = true;
        TinyDenseModel model(1);
        BenchResult r = run_benchmark(cfg, [&] { model.forward(); });
        CHECK(r.ok);
        // deterministic_mode_requested=true + CPU FP32 => available, and outputs bit-identical
        DeterminismInfo det{true, true, std::optional<bool>(true)};
        ExperimentRecord rec = make_benchmark_record(
            "P1-REPRO-B6", "E1", "baseline", RunStatus::PASSED, "", r, hw_json, det,
            model.accounting(StorageFormat::FP32).to_json(), JsonValue::null());
        std::string text = rec.serialize();
        ExperimentRecord back = ExperimentRecord::parse(text);
        CHECK(back.determinism.requested == true);
        CHECK(back.determinism.available == true);
        CHECK(back.determinism.bit_identical.has_value());
        CHECK(*back.determinism.bit_identical == true);
        CHECK(back.validate().empty());
    }

    // --- GPU-style determinism: available=false, bit_identical=false is VALID ---
    {
        DeterminismInfo det{true, false, std::optional<bool>(false)};
        JsonValue j = det.to_json();
        DeterminismInfo back = DeterminismInfo::from_json(j);
        CHECK(back.requested == true);
        CHECK(back.available == false);
        CHECK(back.bit_identical.has_value() && *back.bit_identical == false);
        // Serialized record with this triple passes validate() (no universal GPU bit-identity)
        ExperimentRecord rec;
        rec.record_id = "P1-REPRO-GPU";
        rec.created_utc = RecordStore::utc_timestamp_now();
        rec.kind = "baseline";
        rec.experiment_id = "E2";
        rec.status = RunStatus::SKIPPED;
        rec.status_reason = "skipped: no CUDA";
        rec.hardware = hw_json;
        rec.software = JsonValue::object();
        rec.determinism = det;
        CHECK(rec.validate().empty());
    }

    // --- bit_identical = null (not evaluated) round-trips as null ---
    {
        DeterminismInfo det{false, true, std::nullopt};
        DeterminismInfo back = DeterminismInfo::from_json(det.to_json());
        CHECK(back.bit_identical == std::nullopt);
        CHECK(back.requested == false);
    }

    // --- Harness: configuration validation (warmup >= 3, measurements >= 10) ---
    {
        BenchConfig bad;
        bad.benchmark_id = "BX";
        bad.warmup_count = 1;
        bad.measurement_count = 5;
        CHECK(!bad.validate().empty());
        BenchResult r = run_benchmark(bad, [] {});
        CHECK(!r.ok);                                 // invalid config -> failed measurement
        CHECK(!r.failures.empty());                   // recorded, not silently discarded
        CHECK(r.failures[0].component == "config");

        BenchConfig good;
        good.benchmark_id = "BX";
        good.warmup_count = 3;
        good.measurement_count = 10;
        CHECK(good.validate().empty());
    }

    // --- Harness: throwing op recorded as failure, partial samples kept ---
    {
        BenchConfig cfg;
        cfg.benchmark_id = "BFAIL";
        cfg.warmup_count = 1;
        cfg.measurement_count = 5;   // below spec, but tests failure path
        // Validate we can construct it (validation errors are expected)
        BenchResult r = run_benchmark(cfg, [] { throw std::runtime_error("boom"); });
        CHECK(!r.ok);
        CHECK(r.failures.size() >= 1);
        CHECK(r.error.find("config") != std::string::npos);   // config error precedes op
    }

    // --- Harness: >= 10 samples recorded raw; stats derived identically ---
    {
        BenchConfig cfg;
        cfg.benchmark_id = "BSTAT";
        cfg.warmup_count = 3;
        cfg.measurement_count = 12;
        int calls = 0;
        BenchResult r = run_benchmark(cfg, [&] { ++calls; });
        CHECK(r.ok);
        CHECK(r.stats.samples.size() == 12);
        CHECK(calls == 15);  // 3 warmup + 12 timed
        Statistics recomputed = compute_statistics(r.stats.samples);
        CHECK(recomputed.median == r.stats.median);
        CHECK(recomputed.mean == r.stats.mean);
        CHECK(recomputed.p95 == r.stats.p95);
        CHECK(recomputed.p99 == r.stats.p99);
        CHECK(recomputed.stdev == r.stats.stdev);
    }

    // --- Peak RAM measured (G4 mechanics) ---
    {
        PeakMemorySample s = sample_peak_memory();
        CHECK(s.ram_measured);
        CHECK(s.ram_peak_bytes.has_value() && *s.ram_peak_bytes > 0);
        CHECK(s.provenance.at("ram_peak_bytes").find("measured") != std::string::npos);
    }

    std::cout << "test_phase1_reproducibility: " << test::assertions << " assertions, " << test::failures << " failures\n";
    return test::report();
}
