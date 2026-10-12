/**
 * STARK Phase 1 (M0): test_phase1_records (spec §K)
 * G8 mechanics: serialize -> deserialize round-trip preserves all fields;
 * schema_version enforced; store rejects schema mismatch; failed-run record
 * with populated failures is valid; malformed JSON rejected cleanly.
 */

#include <chrono>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

#include "test_harness.h"
#include "bench/BenchmarkHarness.h"
#include "bench/ParameterAccounting.h"
#include "bench/TinyDenseModel.h"
#include "common/HardwareAffinity.h"
#include "common/HardwareProfiler.h"

using namespace stark_p1;

namespace {
int counter = 0;
std::string uniq(const std::string& tag) {
    return tag + "-" + std::to_string(counter++) + "-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count() % 1000000);
}
} // namespace

int main() {
    test::set_test_name("test_phase1_records");
    StaticHardwareProfile hw = HardwareProfiler::collectStatic();
    JsonValue hw_json = hw.to_json();

    // --- Round-trip: full record with all blocks ---
    {
        BenchConfig cfg;
        cfg.benchmark_id = "B6";
        cfg.warmup_count = 3;
        cfg.measurement_count = 10;
        cfg.batch_size = 1;
        cfg.precision = "FP32";
        cfg.deterministic_mode_requested = true;
        BenchResult r = run_benchmark(cfg, [] { std::vector<float> v(1024); for (auto& x : v) x += 1.0f; });
        CHECK(r.ok);

        ParameterAccounting acct = TinyDenseModel(1).accounting(StorageFormat::FP32);
        ExperimentRecord rec = make_benchmark_record(
            uniq("P1-TEST-B6"), "B6", "benchmark", RunStatus::PASSED, "", r, hw_json,
            DeterminismInfo{true, true, std::optional<bool>(true)},
            acct.to_json(), JsonValue::null());

        std::string text = rec.serialize();
        ExperimentRecord back = ExperimentRecord::parse(text);

        CHECK(back.record_id == rec.record_id);
        CHECK(back.schema_version == "STARKP1 1");
        CHECK(back.created_utc == rec.created_utc);
        CHECK(back.stark_phase == "P1");
        CHECK(back.kind == rec.kind);
        CHECK(back.experiment_id == rec.experiment_id);
        CHECK(back.status == rec.status);
        CHECK(back.determinism.requested == true);
        CHECK(back.determinism.available == true);
        CHECK(back.determinism.bit_identical.has_value() && *back.determinism.bit_identical == true);
        CHECK(back.statistics.has_value());
        CHECK(back.statistics->samples.size() == r.stats.samples.size());
        for (size_t i = 0; i < r.stats.samples.size(); ++i)
            CHECK(back.statistics->samples[i] == r.stats.samples[i]);   // bit-exact doubles
        CHECK(back.statistics->median == r.stats.median);
        CHECK(back.statistics->p95 == r.stats.p95);
        CHECK(back.accounting.isObject());
        CHECK(back.software.isNull() == rec.software.isNull());

        // Additive optional affinity provenance: absent in this record, so round-trip
        // must preserve absence.
        CHECK(!back.has("affinity"));

        // validate() accepts the record
        CHECK(back.validate().empty());

        // Round-trip #2: parse(serialize(parse(text))) — stability
        std::string text2 = back.serialize();
        ExperimentRecord back2 = ExperimentRecord::parse(text2);
        CHECK(back2.statistics->median == back.statistics->median);
        CHECK(!back2.has("affinity"));
    }

    // --- Additive affinity provenance round-trips cleanly and stays optional ---
    {
        BenchConfig cfg;
        cfg.benchmark_id = "B6";
        cfg.warmup_count = 3;
        cfg.measurement_count = 10;
        cfg.batch_size = 1;
        cfg.precision = "FP32";
        cfg.deterministic_mode_requested = true;
        BenchResult r = run_benchmark(cfg, [] { std::vector<float> v(1024); for (auto& x : v) x += 1.0f; });
        CHECK(r.ok);

        // Apply the same campaign instrumentation the campaign uses.
        apply_campaign_affinity(r);
        CHECK(r.optional_affinity_provenance.has_value());

        ExperimentRecord rec = make_benchmark_record(
            uniq("P1-AFF"), "B6", "benchmark", RunStatus::PASSED, "", r, hw_json,
            DeterminismInfo{true, true, std::optional<bool>(true)},
            JsonValue::null(), JsonValue::null());

        CHECK(rec.has("affinity"));
        const JsonValue& aff = rec.get("affinity");
        CHECK(aff.isObject());
        CHECK(aff.has("supported"));
        CHECK(aff.has("query_ok"));
        CHECK(aff.has("set_ok"));
        CHECK(aff.has("effective_logical_cpus"));
        CHECK(aff.has("reason"));

        // No false 'pinned' claim anywhere in the record.
        std::string full = rec.serialize();
        CHECK(full.find("pinned") == std::string::npos);

        ExperimentRecord back = ExperimentRecord::parse(rec.serialize());
        CHECK(back.has("affinity"));
        CHECK(back.get("affinity").get("supported").asBool() == aff.get("supported").asBool());
        CHECK(back.get("affinity").get("query_ok").asBool() == aff.get("query_ok").asBool());
        CHECK(back.get("affinity").get("set_ok").asBool() == aff.get("set_ok").asBool());
        CHECK(back.get("affinity").get("effective_logical_cpus").items().size() ==
              aff.get("effective_logical_cpus").items().size());
        CHECK(back.validate().empty());
    }

    // --- Schema mismatch rejected ---
    {
        ExperimentRecord rec;
        rec.record_id = uniq("P1-BAD");
        rec.created_utc = RecordStore::utc_timestamp_now();
        rec.kind = "benchmark";
        rec.experiment_id = "X";
        rec.hardware = hw_json;
        rec.schema_version = "STARKP1 2";
        bool threw = false;
        try { (void)ExperimentRecord::parse(rec.serialize()); }
        catch (const std::runtime_error&) { threw = true; }
        CHECK(threw);
    }

    // --- Failed record with populated failures is valid ---
    {
        ExperimentRecord rec;
        rec.record_id = uniq("P1-FAIL");
        rec.created_utc = RecordStore::utc_timestamp_now();
        rec.kind = "benchmark";
        rec.experiment_id = "B99";
        rec.status = RunStatus::FAILED;
        rec.status_reason = "iteration 3 failed: simulated error";
        rec.hardware = hw_json;
        rec.software = JsonValue::object();
        rec.failures.push_back({"iteration", "simulated error", false});
        CHECK(rec.validate().empty());
        ExperimentRecord back = ExperimentRecord::parse(rec.serialize());
        CHECK(back.status == RunStatus::FAILED);
        CHECK(back.failures.size() == 1);
        CHECK(back.failures[0].error == "simulated error");
        CHECK(!back.failures[0].recovered);
    }

    // --- Skipped record requires a reason; missing reason is invalid ---
    {
        ExperimentRecord rec;
        rec.record_id = uniq("P1-SKIP");
        rec.created_utc = RecordStore::utc_timestamp_now();
        rec.kind = "baseline";
        rec.experiment_id = "E2";
        rec.status = RunStatus::SKIPPED;
        rec.status_reason = "skipped: no CUDA device";
        rec.hardware = hw_json;
        rec.software = JsonValue::object();
        CHECK(rec.validate().empty());

        ExperimentRecord bad = rec;
        bad.status_reason = "";
        CHECK(!bad.validate().empty());
    }

    // --- Malformed JSON rejected cleanly (not silently accepted) ---
    {
        const char* cases[] = {
            "{",                       // truncated
            "{\"a\":}",                // missing value
            "{\"a\": 1,}",             // trailing comma
            "not json at all",         // garbage
            "[]",                      // array not object (missing keys -> throw)
        };
        for (const char* c : cases) {
            bool threw = false;
            try { (void)ExperimentRecord::parse(c); }
            catch (const std::exception&) { threw = true; }
            CHECK(threw);
        }
    }

    // --- Append-only store: append, load all, reject nothing valid ---
    {
        std::string dir = "build/test_records_tmp";
        RecordStore store(dir);
        for (int i = 0; i < 3; ++i) {
            ExperimentRecord rec;
            rec.record_id = uniq("P1-STORE");
            rec.created_utc = RecordStore::utc_timestamp_now();
            rec.kind = "benchmark";
            rec.experiment_id = "B2";
            rec.hardware = hw_json;
            rec.software = JsonValue::object();
            rec.status = RunStatus::PASSED;
            BenchResult r;
            r.config = BenchConfig{};
            r.config.benchmark_id = "B2";
            r.stats = compute_statistics({1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0});
            rec.statistics = r.stats;
            store.append(rec);
        }
        auto entries = store.loadAll();
        int mine = 0;
        for (const auto& e : entries)
            if (e.parse_ok && e.record.experiment_id == "B2") ++mine;
        CHECK(mine >= 3);

        // Malformed file in store is reported, never silently dropped
        {
            std::ofstream f(dir + "/P1-BROKEN.json", std::ios::binary | std::ios::trunc);
            f << "{{{not json";
        }
        auto entries2 = store.loadAll();
        bool broken_reported = false;
        for (const auto& e : entries2)
            if (!e.parse_ok && e.path.find("P1-BROKEN") != std::string::npos) broken_reported = true;
        CHECK(broken_reported);
    }

    // --- Statistics: computed values from stored samples (G7 mechanics) ---
    {
        Statistics s = compute_statistics({1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0});
        CHECK(s.computed);
        CHECK(s.min == 1.0);
        CHECK(s.max == 10.0);
        CHECK(s.mean == 5.5);
        CHECK(s.median == 5.5);
        // p95 of 10 samples via linear interpolation: position 8.55 -> 9.55
        CHECK(s.p95 > 9.5 && s.p95 < 9.6);
        JsonValue j = s.to_json();
        Statistics s2 = Statistics::from_json(j);
        CHECK(s2.median == s.median);
        CHECK(s2.samples.size() == s.samples.size());
        // Empty samples -> not computed, no fabrication
        Statistics empty = compute_statistics({});
        CHECK(!empty.computed);
        CHECK(empty.samples.empty());
    }

    std::cout << "test_phase1_records: " << test::assertions << " assertions, " << test::failures << " failures\n";
    return test::report();
}
