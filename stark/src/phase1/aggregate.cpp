/**
 * STARK Phase 1 (M0): results aggregator (spec J/G)
 *
 *   aggregate --out <dir> [--strict]
 *
 * Discovers and validates all STARKP1 1 records, reports the status summary,
 * then evaluates gates G1-G7 through the shared production seam
 * (phase1/gates.h — the same implementation exercised by the regression
 * tests). Exits nonzero when any gate fails, and (under --strict) also when
 * any malformed/invalid record is present.
 *
 * Skipped CUDA branches are reported as SKIPPED, never as PASS.
 */

#include <iostream>
#include <map>
#include <string>
#include <vector>

#include "common/ExperimentRecord.h"
#include "gates.h"

using namespace stark_p1;

int main(int argc, char** argv) {
    std::string out = "build/results";
    bool strict = false;
    for (int i = 1; i < argc; ++i) {
        std::string s = argv[i];
        if (s == "--out" && i + 1 < argc) {
            out = argv[++i];
        } else if (s == "--strict") {
            strict = true;
        } else {
            std::cerr << "aggregate: unknown argument: " << s << "\n";
            return 2;
        }
    }

    RecordStore store(out);
    std::vector<RecordStore::Entry> entries;
    try {
        entries = store.loadAll();
    } catch (const std::exception& ex) {
        std::cerr << "aggregate: cannot read records from '" << out << "': " << ex.what() << "\n";
        return 2;
    }

    std::cout << "=== STARK Phase 1 (M0) Aggregator ===\n";
    std::cout << "records directory: " << out << "\n";
    std::cout << "records found: " << entries.size() << "\n\n";

    std::vector<ExperimentRecord> records;
    std::vector<std::string> invalid;
    for (auto& e : entries) {
        if (!e.parse_ok) {
            invalid.push_back(e.path + ": " + e.error);
            continue;
        }
        auto errs = e.record.validate();
        if (!errs.empty()) {
            invalid.push_back(e.path + ": " + errs[0]);
            continue;
        }
        records.push_back(e.record);
    }

    if (!invalid.empty()) {
        std::cout << "INVALID RECORDS (" << invalid.size() << "):\n";
        for (const auto& s : invalid) std::cout << "  " << s << "\n";
        std::cout << "\n";
    }

    // Status summary over the valid records.
    std::map<RunStatus, int> status_count;
    std::map<std::string, int> by_experiment;
    for (const auto& r : records) {
        status_count[r.status]++;
        by_experiment[r.experiment_id]++;
    }
    std::cout << "STATUS SUMMARY:\n";
    for (const auto& [id, n] : by_experiment)
        std::cout << "  " << id << ": " << n << " record(s)\n";
    std::cout << "  PASSED=" << status_count[RunStatus::PASSED]
              << " FAILED=" << status_count[RunStatus::FAILED]
              << " SKIPPED=" << status_count[RunStatus::SKIPPED]
              << " NOT_ATTEMPTED=" << status_count[RunStatus::NOT_ATTEMPTED] << "\n\n";

    const std::vector<GateReport> gates = evaluate_gates(records);

    std::cout << "GATE RESULTS:\n";
    int failed = 0;
    for (const auto& g : gates) {
        std::cout << "  [" << (g.pass ? "PASS" : "FAIL") << "] " << g.gate << "\n";
        if (!g.detail.empty()) std::cout << "         " << g.detail << "\n";
        if (!g.pass) ++failed;
    }
    std::cout << "\n";

    const bool gates_ok = all_gates_pass(gates);
    std::cout << "OVERALL: " << (gates_ok ? "PASS" : "FAIL") << " (" << failed << " gate(s) failed";
    if (!invalid.empty()) std::cout << ", " << invalid.size() << " invalid record(s)";
    std::cout << ")\n";

    if (!gates_ok) return 1;
    if (strict && !invalid.empty()) return 1;
    return 0;
}
