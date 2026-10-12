/**
 * APEX M0 v2.2 — G3 SKIPPED-semantics regression test (independent audit).
 *
 * This test invokes the EXACT production seam evaluate_gates() (phase1/gates.h)
 * and probes ONLY the G3 gate. It does NOT modify any frozen rule; it documents
 * the *observable* G3 semantics, including the behaviours the v2.2 audit calls
 * out (reason text is not validated/provenanced; arbitrary SKIPPED records pass).
 *
 * It is kept OUTSIDE the frozen v2.1 test suite so the v2.1 source state is
 * preserved byte-for-byte. Build/run commands are recorded in the report.
 */
#include <cstdio>
#include <string>
#include <vector>

#include "common/ExperimentRecord.h"
#include "common/HardwareProfiler.h"
#include "gates.h"

using namespace stark_p1;

static int g_checks = 0;
static int g_fails = 0;
#define CHECK(cond)                                                          \
    do {                                                                     \
        ++g_checks;                                                          \
        if (!(cond)) { ++g_fails;                                            \
            std::printf("  FAIL: %s (line %d)\n", #cond, __LINE__); }        \
    } while (0)

static ExperimentRecord mk(const std::string& exp, RunStatus status,
                           const std::string& reason, const std::string& rid) {
    ExperimentRecord r;
    r.record_id = rid;
    r.schema_version = "STARKP1 1";
    r.stark_phase = "P1";
    r.created_utc = "2026-10-05T00:00:00.000Z";
    r.kind = (exp == "E2") ? "baseline" : "benchmark";
    r.experiment_id = exp;
    r.status = status;
    r.status_reason = reason;
    r.hardware = JsonValue::object();
    r.hardware.set("cuda_available", JsonValue::boolean(false));
    r.software = JsonValue::object();
    // minimal configuration so the record has a benchmark_id (not required by G3)
    JsonValue c = JsonValue::object();
    c.set("benchmark_id", JsonValue::str(exp));
    r.configuration = c;
    return r;
}

static bool g3(const std::vector<ExperimentRecord>& recs, std::string& detail) {
    const auto gates = evaluate_gates(recs);
    for (const auto& g : gates) {
        if (g.gate.rfind("G3", 0) == 0) { detail = g.detail; return g.pass; }
    }
    return false;
}

int main() {
    std::printf("cudaRuntimeAvailable() on this build = %s\n",
                HardwareProfiler::cudaRuntimeAvailable() ? "true" : "false");

    std::string d;

    // --- Case 1: all three present as SKIPPED with non-empty reasons -> PASS ---
    {
        std::vector<ExperimentRecord> v = {
            mk("E2", RunStatus::SKIPPED, "skipped: no CUDA in this build", "P1-E2-skip"),
            mk("B4", RunStatus::SKIPPED, "skipped: no CUDA in this build", "P1-B4-skip"),
            mk("B5", RunStatus::SKIPPED, "skipped: no CUDA in this build", "P1-B5-skip"),
        };
        bool p = g3(v, d);
        std::printf("[1] three valid SKIPPED records      -> %s | %s\n", p ? "PASS" : "FAIL", d.c_str());
        CHECK(p);
    }

    // --- Case 2: NOT_ATTEMPTED is also accepted ---
    {
        std::vector<ExperimentRecord> v = {
            mk("E2", RunStatus::NOT_ATTEMPTED, "not attempted: no CUDA build", "P1-E2-na"),
            mk("B4", RunStatus::NOT_ATTEMPTED, "not attempted: no CUDA build", "P1-B4-na"),
            mk("B5", RunStatus::NOT_ATTEMPTED, "not attempted: no CUDA build", "P1-B5-na"),
        };
        bool p = g3(v, d);
        std::printf("[2] NOT_ATTEMPTED accepted           -> %s | %s\n", p ? "PASS" : "FAIL", d.c_str());
        CHECK(p);
    }

    // --- Case 3: missing record -> FAIL (distinguishes skip from missing) ---
    {
        std::vector<ExperimentRecord> v = {
            mk("E2", RunStatus::SKIPPED, "skipped: no CUDA in this build", "P1-E2-skip"),
            mk("B5", RunStatus::SKIPPED, "skipped: no CUDA in this build", "P1-B5-skip"),
            // B4 omitted
        };
        bool p = g3(v, d);
        std::printf("[3] B4 record missing                -> %s | %s\n", p ? "PASS" : "FAIL", d.c_str());
        CHECK(!p);
        CHECK(d.find("missing") != std::string::npos);
    }

    // --- Case 4: empty skip reason -> FAIL (reason must be non-empty) ---
    {
        std::vector<ExperimentRecord> v = {
            mk("E2", RunStatus::SKIPPED, "", "P1-E2-skip"),
            mk("B4", RunStatus::SKIPPED, "skipped: no CUDA in this build", "P1-B4-skip"),
            mk("B5", RunStatus::SKIPPED, "skipped: no CUDA in this build", "P1-B5-skip"),
        };
        bool p = g3(v, d);
        std::printf("[4] E2 SKIPPED with empty reason     -> %s | %s\n", p ? "PASS" : "FAIL", d.c_str());
        CHECK(!p);
        CHECK(d.find("without reason") != std::string::npos);
    }

    // --- Case 5: present but PASSED (not skipped) on a no-CUDA build -> FAIL ---
    {
        std::vector<ExperimentRecord> v = {
            mk("E2", RunStatus::PASSED, "", "P1-E2-pass"),
            mk("B4", RunStatus::SKIPPED, "skipped: no CUDA in this build", "P1-B4-skip"),
            mk("B5", RunStatus::SKIPPED, "skipped: no CUDA in this build", "P1-B5-skip"),
        };
        bool p = g3(v, d);
        std::printf("[5] E2 PASSED (no CUDA expected)     -> %s | %s\n", p ? "PASS" : "FAIL", d.c_str());
        CHECK(!p);
    }

    // --- Case 6: ARBITRARY / fabricated reason text is accepted -> PASS ---
    //     (Documents that G3 does NOT validate reason truthfulness or provenance.)
    {
        std::vector<ExperimentRecord> v = {
            mk("E2", RunStatus::SKIPPED, "x", "P1-E2-skip"),
            mk("B4", RunStatus::SKIPPED, "because", "P1-B4-skip"),
            mk("B5", RunStatus::SKIPPED, "lorem ipsum", "P1-B5-skip"),
        };
        bool p = g3(v, d);
        std::printf("[6] arbitrary fabricated reasons     -> %s | %s\n", (p ? "PASS" : "FAIL"), d.c_str());
        CHECK(p);  // current semantics: any non-empty string satisfies G3
    }

    // --- Case 7: CONTRADICTORY capability evidence is not cross-checked -> PASS ---
    //     E2 skip record whose embedded hardware still claims cuda_available=true.
    {
        ExperimentRecord e2 = mk("E2", RunStatus::SKIPPED, "skipped: contradiction", "P1-E2-skip");
        e2.hardware.set("cuda_available", JsonValue::boolean(true));  // contradicts SKIPPED
        std::vector<ExperimentRecord> v = {
            e2,
            mk("B4", RunStatus::SKIPPED, "skipped: no CUDA in this build", "P1-B4-skip"),
            mk("B5", RunStatus::SKIPPED, "skipped: no CUDA in this build", "P1-B5-skip"),
        };
        bool p = g3(v, d);
        std::printf("[7] contradictory capability evidence-> %s | %s\n", p ? "PASS" : "FAIL", d.c_str());
        CHECK(p);  // G3 does not reconcile the record's own cuda_available with its SKIPPED status
    }

    // --- Case 8: no E2/B4/B5 at all -> FAIL ---
    {
        std::vector<ExperimentRecord> v = {
            mk("E1", RunStatus::PASSED, "", "P1-E1-x"),
        };
        bool p = g3(v, d);
        std::printf("[8] no E2/B4/B5 records at all       -> %s | %s\n", p ? "PASS" : "FAIL", d.c_str());
        CHECK(!p);
    }

    std::printf("v2.2 G3 semantics test: %d checks, %d failures\n", g_checks, g_fails);
    return g_fails == 0 ? 0 : 1;
}
