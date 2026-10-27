/** Developer persistence-safety tests; never write to historical evidence. */
#include <atomic>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <thread>
#include <vector>
#include "test_harness.h"
#include "common/ExperimentRecord.h"

using namespace stark_p1;
namespace {
std::string read(const std::filesystem::path& p) {
    std::ifstream f(p, std::ios::binary);
    return {std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>()};
}
ExperimentRecord fixture(const std::string& id) {
    ExperimentRecord r;
    r.record_id = id;
    r.created_utc = RecordStore::utc_timestamp_now();
    r.kind = "profiler";
    r.experiment_id = "STORE-SAFETY-TEST";
    // These are explicitly unit-test metadata, not a hardware measurement.
    r.hardware = JsonValue::object();
    r.software = JsonValue::object();
    r.provenance["scope"] = JsonValue::str("unit-test fixture; not campaign evidence");
    return r;
}
bool append_fails(const RecordStore& store, const ExperimentRecord& r) {
    try { store.append(r); return false; } catch (const std::exception&) { return true; }
}
}
int main(int argc, char** argv) {
    // Used only by the cross-process storage integration test. Never an official arm.
    if (argc == 4 && std::string(argv[1]) == "--append-once") {
        try { RecordStore(argv[2]).append(fixture(argv[3])); return 0; }
        catch (const std::exception&) { return 7; }
    }
    if (argc != 1) return 2;
    test::set_test_name("test_phase1_store_safety");
    const std::filesystem::path root("store_safety_scratch");
    if (!std::filesystem::create_directory(root)) return 2; // never delete an unknown directory
    try {
        RecordStore store((root / "nested/records").string());
        auto r = fixture("P1-SAFE-1");
        store.append(r);
        const auto saved = read(root / "nested/records/P1-SAFE-1.json");
        r.experiment_id = "SHOULD-NOT-OVERWRITE";
        CHECK(append_fails(store, r));
        CHECK(saved == read(root / "nested/records/P1-SAFE-1.json"));
        // A new store instance is a restart boundary for the storage interface.
        auto after_restart = RecordStore((root / "nested/records").string()).loadAll();
        CHECK(after_restart.size() == 1);
        CHECK(after_restart[0].parse_ok);
        CHECK(after_restart[0].record.experiment_id == "STORE-SAFETY-TEST");
        for (const auto& id : {"", ".", "..", "../escape", "a/b", "a\\b", "a:b", "a\nb"}) {
            CHECK(append_fails(store, fixture(id)));
        }
        CHECK(!std::filesystem::exists(root / "nested/escape.json"));
        CHECK(append_fails(store, fixture(std::string(201, 'a'))));
        // Independent writers racing one id: exactly one complete record is published.
        std::atomic<int> successes{0}, rejected{0};
        std::vector<std::thread> writers;
        for (int i = 0; i < 16; ++i) writers.emplace_back([&store, &successes, &rejected, i] {
            auto record = fixture("P1-RACE");
            record.experiment_id += "-" + std::to_string(i);
            try { store.append(record); ++successes; } catch (const std::exception&) { ++rejected; }
        });
        for (auto& writer : writers) writer.join();
        CHECK(successes == 1);
        CHECK(rejected == 15);
        auto entries = store.loadAll();
        CHECK(entries.size() == 2);
        for (const auto& entry : entries) CHECK(entry.parse_ok);
        // No per-writer staging files or directories leak after success/failure.
        size_t count = 0;
        for (const auto& entry : std::filesystem::directory_iterator(root / "nested/records")) {
            CHECK(entry.path().extension() == ".json");
            ++count;
        }
        CHECK(count == 2);
        // Malformed file is returned as an error entry, not dropped or overwritten.
        { std::ofstream broken(root / "nested/records/broken.json"); broken << "{"; }
        entries = store.loadAll();
        size_t errors = 0;
        for (const auto& entry : entries) if (!entry.parse_ok) ++errors;
        CHECK(errors == 1);
        CHECK(read(root / "nested/records/broken.json") == "{");
        // A file at the directory path is an IO failure, not a successful append.
        { std::ofstream blocked(root / "not_a_directory"); blocked << "retain"; }
        CHECK(append_fails(RecordStore((root / "not_a_directory").string()), fixture("P1-NO")));
        CHECK(read(root / "not_a_directory") == "retain");
    } catch (const std::exception& e) { CHECK_MSG(false, e.what()); }
    std::error_code ignored;
    std::filesystem::remove_all(root, ignored);
    return test::report();
}
