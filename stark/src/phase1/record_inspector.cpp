/** Read-only developer record inspection. Not a cognitive shell or acceptance evaluator. */
#include <filesystem>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include "common/ExperimentRecord.h"
using namespace stark_p1;
namespace {
uint64_t positive(const std::string& text, uint64_t maximum) {
    if (text.empty() || text.find_first_not_of("0123456789") != std::string::npos)
        throw std::runtime_error("limit must be a positive decimal integer");
    const auto value = std::stoull(text);
    if (value == 0 || value > maximum) throw std::runtime_error("limit outside supported range");
    return value;
}
}
int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: record_inspector DIRECTORY [--max-files N] [--max-bytes N]\n"
                  << "Read-only structural inspection; never evaluates acceptance or runs benchmarks.\n";
        return 2;
    }
    try {
        const std::filesystem::path root(argv[1]);
        uint64_t max_files = 1000, max_bytes = 16 * 1024 * 1024;
        for (int i = 2; i < argc; i += 2) {
            if (i + 1 >= argc) throw std::runtime_error("option requires a value");
            if (std::string(argv[i]) == "--max-files") max_files = positive(argv[i+1], 10000);
            else if (std::string(argv[i]) == "--max-bytes") max_bytes = positive(argv[i+1], 128 * 1024 * 1024);
            else throw std::runtime_error("unknown option");
        }
        if (!std::filesystem::is_directory(root)) throw std::runtime_error("record directory missing or unreadable");
        uint64_t count = 0, total = 0;
        for (const auto& file : std::filesystem::directory_iterator(root)) {
            if (file.path().extension() != ".json") continue;
            if (file.is_symlink() || !file.is_regular_file()) throw std::runtime_error("JSON entries must be regular files, not symlinks/directories");
            if (++count > max_files) throw std::runtime_error("file budget exceeded; raise --max-files explicitly");
            const auto bytes = file.file_size();
            if (bytes > max_bytes - total) throw std::runtime_error("byte budget exceeded; raise --max-bytes explicitly");
            total += bytes;
        }
        const auto entries = RecordStore(root.string()).loadAll();
        JsonValue report = JsonValue::object(), records = JsonValue::array();
        size_t invalid = 0;
        for (const auto& entry : entries) {
            JsonValue row = JsonValue::object();
            row.set("file", JsonValue::str(std::filesystem::path(entry.path).filename().string()));
            row.set("structurally_valid", JsonValue::boolean(entry.parse_ok));
            if (entry.parse_ok) {
                row.set("record_id", JsonValue::str(entry.record.record_id));
                row.set("experiment_id", JsonValue::str(entry.record.experiment_id));
                row.set("run_status", JsonValue::str(run_status_name(entry.record.status)));
                row.set("created_utc", JsonValue::str(entry.record.created_utc));
            } else { ++invalid; row.set("parse_error", JsonValue::str(entry.error)); }
            records.append(std::move(row));
        }
        report.set("schema", JsonValue::str("apex.record-inspection/1"));
        report.set("scope", JsonValue::str("structural inspection only; no acceptance inference"));
        report.set("record_count", JsonValue::uinteger(entries.size()));
        report.set("invalid_count", JsonValue::uinteger(invalid));
        report.set("records", std::move(records));
        std::cout << report.dump(2) << '\n';
        return invalid ? 1 : 0;
    } catch (const std::exception& error) {
        std::cerr << "record_inspector: " << error.what() << '\n';
        return 2;
    }
}
