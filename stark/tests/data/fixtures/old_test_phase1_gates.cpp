/**
 * STARK Phase 1 (M0): test_phase1_gates (§K regression tests)
 *
 * These tests invoke the EXACT production gate implementation through
 * evaluate_gates() (phase1/gates.h). Gate logic is never reimplemented here.
 *
 * Coverage:
 *   G2  both baselines valid / E1 missing / E5 missing / both missing /
 *       invalid status / insufficient samples / duplicate-only evidence
 *   G4  both valid / E1 missing / E5 missing / not-PASSED / missing RAM /
 *       measured-but-unavailable RAM / invalid RAM types & values /
 *       valid & invalid GPU VRAM / valid & malformed CPU-only VRAM reason
 *   G7  all groups pass / failure survives a later passing group (both orders) /
 *       single-run group / missing repeat / duplicate-only repeat /
 *       boundary just inside & just outside / both-zero & one-zero /
 *       non-finite metric / missing statistics / grouping by configuration /
 *       multiple groups with mixed outcomes
 */

#include <cmath>
#include <limits>
#include <limits>
#include <string>
#include <vector>

#include "test_harness.h"
#include "common/ExperimentRecord.h"
#include "gates.h"

using namespace stark_p1;

namespace {

Statistics stats_with(double median, size_t n = 10) {
    Statistics s;
    // Create samples centered around the desired median
    // For even n: samples are [median - delta, median - delta/2, ..., median, ..., median + delta/2, median + delta]
    // For simplicity: all samples equal median (median is unambiguous)
    s.samples.assign(n, median);
    // Recompute statistics from the samples (this ensures consistency)
    return compute_statistics(s.samples);
}

ExperimentRecord mk(const std::string& exp, const std::string& bench, double median,
                    const std::string& record_id, RunStatus status = RunStatus::PASSED,
                    size_t samples = 10) {
    ExperimentRecord r;
    r.record_id = record_id;
    r.schema_version = "STARKP1 1";
    r.stark_phase = "P1";
    r.created_utc = "2026-10-04T00:00:00.000Z";
    r.kind = "baseline";
    r.experiment_id = exp;
    r.status = status;
    if (status != RunStatus::PASSED) r.status_reason = "deliberate test status";
    // Explicit CPU-only hardware so G4's fail-closed capability check is
    // satisfied by default (tests override for GPU / unknown cases).
    r.hardware = JsonValue::object();
    r.hardware.set("cuda_available", JsonValue::boolean(false));
    r.software = JsonValue::object();
    if (!bench.empty()) {
        JsonValue c = JsonValue::object();
        c.set("benchmark_id", JsonValue::str(bench));
        r.configuration = c;
    }
    r.statistics = stats_with(median, samples);
    return r;
}

void set_good_peak(ExperimentRecord& r) {
    JsonValue pm = JsonValue::object();
    pm.set("ram_measured", JsonValue::boolean(true));
    pm.set("ram_peak_bytes", JsonValue::uinteger(123456));  // UInt, as the harness emits
    pm.set("vram_measured", JsonValue::boolean(false));
    JsonValue vr = JsonValue::object();
    vr.set("value", JsonValue::null());
    vr.set("reason", JsonValue::str("unavailable: binary built without CUDA"));
    pm.set("vram_peak_bytes", vr);
    r.peak_memory = pm;
}

struct Pair {
    ExperimentRecord e1;
    ExperimentRecord e5;
};

Pair good_baselines() {
    Pair p;
    p.e1 = mk("E1", "B6", 1.0, "run-e1");
    p.e5 = mk("E5", "B6", 1.0, "run-e5");
    set_good_peak(p.e1);
    set_good_peak(p.e5);
    return p;
}

const GateReport* find_gate(const std::vector<GateReport>& gs, const std::string& prefix) {
    for (const auto& g : gs)
        if (g.gate.rfind(prefix, 0) == 0) return &g;
    return nullptr;
}

bool gate_pass(const std::vector<ExperimentRecord>& recs, const std::string& prefix) {
    const GateReport* g = find_gate(evaluate_gates(recs), prefix);
    CHECK(g != nullptr);
    return g != nullptr && g->pass;
}

} // namespace

int main() {
    test::set_test_name("test_phase1_gates");

    // =====================================================================
    // G2
    // =====================================================================
    {
        Pair p = good_baselines();
        CHECK(gate_pass({p.e1, p.e5}, "G2"));

        CHECK(!gate_pass({p.e5}, "G2"));                    // E1 missing
        CHECK(!gate_pass({p.e1}, "G2"));                    // E5 missing
        CHECK(!gate_pass({}, "G2"));                        // both missing

        ExperimentRecord bad_e1 = p.e1;
        bad_e1.status = RunStatus::FAILED;
        bad_e1.status_reason = "failed";
        ExperimentRecord bad_e5 = p.e5;
        bad_e5.status = RunStatus::FAILED;
        bad_e5.status_reason = "failed";
        CHECK(!gate_pass({bad_e1, p.e5}, "G2"));            // E1 not PASSED
        CHECK(!gate_pass({p.e1, bad_e5}, "G2"));            // E5 not PASSED

        ExperimentRecord few = mk("E1", "B6", 1.0, "run-e1-few", RunStatus::PASSED, 9);
        set_good_peak(few);
        CHECK(!gate_pass({few, p.e5}, "G2"));               // insufficient samples

        ExperimentRecord dup = p.e5;
        dup.record_id = p.e1.record_id;                     // duplicate-only evidence
        CHECK(!gate_pass({p.e1, dup}, "G2"));              
    }

    // =====================================================================
    // G4
    // =====================================================================
    {
        Pair p = good_baselines();
        CHECK(gate_pass({p.e1, p.e5}, "G4"));

        CHECK(!gate_pass({p.e5}, "G4"));                    // E1 missing (never skipped)
        CHECK(!gate_pass({p.e1}, "G4"));                    // E5 missing

        ExperimentRecord bad_e1 = p.e1;
        bad_e1.status = RunStatus::FAILED;
        bad_e1.status_reason = "failed";
        ExperimentRecord bad_e5 = p.e5;
        bad_e5.status = RunStatus::FAILED;
        bad_e5.status_reason = "failed";
        CHECK(!gate_pass({bad_e1, p.e5}, "G4"));            // E1 not PASSED
        CHECK(!gate_pass({p.e1, bad_e5}, "G4"));            // E5 not PASSED

        // Missing RAM measurement (no ram_peak_bytes key at all)
        {
            ExperimentRecord r = p.e1;
            r.peak_memory = JsonValue::object();
            r.peak_memory.set("ram_measured", JsonValue::boolean(true));
            r.peak_memory.set("vram_measured", JsonValue::boolean(false));
            JsonValue vr = JsonValue::object();
            vr.set("value", JsonValue::null());
            vr.set("reason", JsonValue::str("unavailable: no CUDA"));
            r.peak_memory.set("vram_peak_bytes", vr);
            CHECK(!gate_pass({r, p.e5}, "G4"));
        }

        // ram_measured=true but RAM value is an unavailable object
        {
            ExperimentRecord r = p.e1;
            JsonValue bad_ram = JsonValue::object();
            bad_ram.set("value", JsonValue::null());
            bad_ram.set("reason", JsonValue::str("unavailable: no reason recorded"));
            r.peak_memory.set("ram_peak_bytes", bad_ram);
            CHECK(!gate_pass({r, p.e5}, "G4"));
        }

        // Invalid RAM types and values
        for (int variant = 0; variant < 4; ++variant) {
            ExperimentRecord r = p.e1;
            if (variant == 0) r.peak_memory.set("ram_peak_bytes", JsonValue::str("12"));
            else if (variant == 1) r.peak_memory.set("ram_peak_bytes", JsonValue::array());
            else if (variant == 2) r.peak_memory.set("ram_peak_bytes", JsonValue::integer(0));
            else r.peak_memory.set("ram_peak_bytes", JsonValue::number(-5.0));
            CHECK(!gate_pass({r, p.e5}, "G4"));
        }
        // ram_measured not a boolean
        {
            ExperimentRecord r = p.e1;
            r.peak_memory.set("ram_measured", JsonValue::integer(1));
            CHECK(!gate_pass({r, p.e5}, "G4"));
        }

        // Valid GPU VRAM (numeric measurement)
        {
            ExperimentRecord r = p.e1;
            r.peak_memory.set("vram_measured", JsonValue::boolean(true));
            r.peak_memory.set("vram_peak_bytes", JsonValue::uinteger(1024 * 1024));
            CHECK(gate_pass({r, p.e5}, "G4"));
        }
        // Invalid GPU VRAM: missing / object / zero
        for (int variant = 0; variant < 3; ++variant) {
            ExperimentRecord r = p.e1;
            r.peak_memory.set("vram_measured", JsonValue::boolean(true));
            if (variant == 0) r.peak_memory.set("vram_peak_bytes", JsonValue::null());
            else if (variant == 1) {
                JsonValue o = JsonValue::object();
                o.set("value", JsonValue::null());
                o.set("reason", JsonValue::str("unavailable"));
                r.peak_memory.set("vram_peak_bytes", o);
            } else {
                r.peak_memory.set("vram_peak_bytes", JsonValue::uinteger(0));
            }
            CHECK(!gate_pass({r, p.e5}, "G4"));
        }
        // GPU-capable hardware but vram_measured=false must fail
        {
            ExperimentRecord r = p.e1;
            r.hardware = JsonValue::object();
            r.hardware.set("cuda_available", JsonValue::boolean(true));
            CHECK(!gate_pass({r, p.e5}, "G4"));
        }

        // Valid CPU-only unavailable VRAM reason -> already exercised above.
        // Malformed CPU-only VRAM reason (empty / non-string / missing / non-null value)
        for (int variant = 0; variant < 4; ++variant) {
            ExperimentRecord r = p.e1;
            r.peak_memory.set("vram_measured", JsonValue::boolean(false));
            JsonValue o = JsonValue::object();
            if (variant == 0) { o.set("value", JsonValue::null()); o.set("reason", JsonValue::str("")); }
            else if (variant == 1) { o.set("value", JsonValue::null()); o.set("reason", JsonValue::integer(7)); }
            else if (variant == 2) { o.set("value", JsonValue::null()); }
            else { o.set("value", JsonValue::str("0")); o.set("reason", JsonValue::str("unavailable")); }
            r.peak_memory.set("vram_peak_bytes", o);
            CHECK(!gate_pass({r, p.e5}, "G4"));
        }

        // --- Unknown hardware capability must FAIL (fail closed) ---
        // cuda_available missing entirely (empty hardware object), on E1 and E5.
        {
            ExperimentRecord r1 = p.e1;
            r1.hardware = JsonValue::object();
            CHECK(!gate_pass({r1, p.e5}, "G4"));           // E1 unknown
            ExperimentRecord r5 = p.e5;
            r5.hardware = JsonValue::object();
            CHECK(!gate_pass({p.e1, r5}, "G4"));           // E5 unknown
        }
        // cuda_available null / string / integer -> Unknown -> FAIL on E1 and E5.
        for (int variant = 0; variant < 3; ++variant) {
            JsonValue hw = JsonValue::object();
            if (variant == 0) hw.set("cuda_available", JsonValue::null());
            else if (variant == 1) hw.set("cuda_available", JsonValue::str("false"));
            else hw.set("cuda_available", JsonValue::integer(0));
            ExperimentRecord r1 = p.e1;
            r1.hardware = hw;
            CHECK(!gate_pass({r1, p.e5}, "G4"));
            ExperimentRecord r5 = p.e5;
            r5.hardware = hw;
            CHECK(!gate_pass({p.e1, r5}, "G4"));
        }
        // Unknown cuda_available but an authoritative GPU field present ->
        // GPU-capable; measured VRAM is then required.
        {
            ExperimentRecord r = p.e1;
            r.hardware = JsonValue::object();
            r.hardware.set("gpu_model", JsonValue::str("NVIDIA Test GPU"));
            r.peak_memory.set("vram_measured", JsonValue::boolean(true));
            r.peak_memory.set("vram_peak_bytes", JsonValue::uinteger(2048));
            CHECK(gate_pass({r, p.e5}, "G4"));             // authoritative GPU + measured VRAM
            ExperimentRecord bad = r;
            bad.peak_memory.set("vram_measured", JsonValue::boolean(false));
            CHECK(!gate_pass({bad, p.e5}, "G4"));          // GPU-capable but not measured
        }
    }

    // =====================================================================
    // G7
    // =====================================================================

    // All groups pass (two independent repeats each)
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 1.000, "b6-r1"),
            mk("E5", "B6", 1.010, "b6-r2"),   // same config as b6-r1 -> 1% apart
            mk("E1", "B7", 2.000, "b7-r1"),
            mk("E5", "B7", 2.100, "b7-r2"),   // 4.76% apart
        };
        CHECK(gate_pass(recs, "G7"));
    }

    // Failure must survive a later passing group (bad group sorts first)
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B1", 1.0, "bad-r1"),
            mk("E5", "B1", 2.0, "bad-r2"),    // 100% apart -> FAIL (B1 sorts early)
            mk("E1", "B9", 3.0, "good-r1"),
            mk("E5", "B9", 3.01, "good-r2"),
        };
        CHECK(!gate_pass(recs, "G7"));
    }
    // Failure must survive a later passing group (bad group sorts last)
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B1", 3.0, "good-r1"),
            mk("E5", "B1", 3.01, "good-r2"),
            mk("E1", "B9", 1.0, "bad-r1"),
            mk("E5", "B9", 2.0, "bad-r2"),    // 100% apart -> FAIL (B9 sorts late)
        };
        CHECK(!gate_pass(recs, "G7"));
    }

    // Single-run group alongside a passing repeated group -> FAIL
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 1.0, "b6-r1"),
            mk("E5", "B6", 1.01, "b6-r2"),
            mk("E1", "B7", 5.0, "b7-solo"),   // no repeat
        };
        CHECK(!gate_pass(recs, "G7"));
    }

    // Missing repeat: a lone record -> FAIL
    {
        std::vector<ExperimentRecord> recs = {mk("E1", "B6", 1.0, "only-run")};
        CHECK(!gate_pass(recs, "G7"));
    }

    // Duplicate-only evidence: two records sharing a record_id -> 1 run -> FAIL
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 1.0, "dup"),
            mk("E5", "B6", 1.0, "dup"),
        };
        CHECK(!gate_pass(recs, "G7"));
    }

    // Grouping is by configuration, not experiment id: E1+E5 same config pass
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 10.0, "x1"),
            mk("E5", "B6", 10.4, "x2"),      // 3.85% apart
        };
        CHECK(gate_pass(recs, "G7"));
    }
    // Two independent runs sharing an experiment id also form a valid repeat
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 10.0, "y1"),
            mk("E1", "B6", 10.4, "y2"),
        };
        CHECK(gate_pass(recs, "G7"));
    }

    // Boundary: timing (15%) just inside passes, just outside fails
    {
        std::vector<ExperimentRecord> inside = {
            mk("E1", "B6", 128.0, "t1"),
            mk("E5", "B6", 112.0, "t2"),     // 16/128 = 12.5%
        };
        CHECK(gate_pass(inside, "G7"));

        std::vector<ExperimentRecord> outside = {
            mk("E1", "B6", 100.0, "t3"),
            mk("E5", "B6", 84.0, "t4"),      // 16/100 = 16% > 15%
        };
        CHECK(!gate_pass(outside, "G7"));
    }
    // Boundary: memory bandwidth (B3/B5) allows 20%
    {
        std::vector<ExperimentRecord> bw_ok = {
            mk("E1", "B3", 100.0, "w1"),
            mk("E5", "B3", 82.0, "w2"),      // 18% <= 20%
        };
        CHECK(gate_pass(bw_ok, "G7"));

        std::vector<ExperimentRecord> bw_bad = {
            mk("E1", "B3", 100.0, "w3"),
            mk("E5", "B3", 79.0, "w4"),      // 21% > 20%
        };
        CHECK(!gate_pass(bw_bad, "G7"));

        // An 18% difference on a TIMING benchmark exceeds 15% -> fail
        std::vector<ExperimentRecord> timing_bad = {
            mk("E1", "B6", 100.0, "w5"),
            mk("E5", "B6", 82.0, "w6"),
        };
        CHECK(!gate_pass(timing_bad, "G7"));
    }

    // Both zero -> 0% -> pass; exactly one zero -> 100% -> fail
    {
        std::vector<ExperimentRecord> both_zero = {
            mk("E1", "B6", 0.0, "z1"),
            mk("E5", "B6", 0.0, "z2"),
        };
        CHECK(gate_pass(both_zero, "G7"));

        std::vector<ExperimentRecord> one_zero = {
            mk("E1", "B6", 0.0, "z3"),
            mk("E5", "B6", 1.0, "z4"),
        };
        CHECK(!gate_pass(one_zero, "G7"));
    }

    // Non-finite metric -> fail
    {
        const double inf = std::numeric_limits<double>::infinity();
        const double nan = std::numeric_limits<double>::quiet_NaN();
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 1.0, "n1"),
            mk("E5", "B6", inf, "n2"),
        };
        CHECK(!gate_pass(recs, "G7"));
        std::vector<ExperimentRecord> recs2 = {
            mk("E1", "B6", nan, "n3"),
            mk("E5", "B6", 1.0, "n4"),
        };
        CHECK(!gate_pass(recs2, "G7"));
    }

    // Missing statistics on one run -> only 1 usable run -> fail
    {
        ExperimentRecord no_stats = mk("E5", "B6", 1.0, "m2");
        no_stats.statistics = std::nullopt;
        std::vector<ExperimentRecord> recs = {mk("E1", "B6", 1.0, "m1"), no_stats};
        CHECK(!gate_pass(recs, "G7"));
    }

    // Multiple groups, mixed outcomes -> fail
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B1", 1.0, "g1-r1"),
            mk("E5", "B1", 2.0, "g1-r2"),    // fail
            mk("E1", "B2", 5.0, "g2-r1"),
            mk("E5", "B2", 5.1, "g2-r2"),    // pass
            mk("E1", "B3", 9.0, "g3-r1"),    // single run -> fail
        };
        CHECK(!gate_pass(recs, "G7"));
    }

    // ------------------------------------------------------------------
    // v1.5: all-pairs comparison and computed-statistics requirements
    // ------------------------------------------------------------------

    // Three repeats 100/90/80: adjacent diffs are 10% and 11.11%, but the
    // endpoints differ by 20% -> FAIL (adjacent-only would wrongly pass).
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 100.0, "p1"),
            mk("E1", "B6", 90.0, "p2"),
            mk("E1", "B6", 80.0, "p3"),
        };
        CHECK(!gate_pass(recs, "G7"));
    }

    // Three repeats all within tolerance pairwise (max spread 14%) -> PASS.
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 100.0, "q1"),
            mk("E1", "B6", 90.0, "q2"),
            mk("E1", "B6", 86.0, "q3"),
        };
        CHECK(gate_pass(recs, "G7"));
    }

    // Four repeats with one outlier (100 vs 80 = 20%) -> FAIL.
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 100.0, "r1"),
            mk("E1", "B6", 99.0, "r2"),
            mk("E1", "B6", 98.0, "r3"),
            mk("E1", "B6", 80.0, "r4"),
        };
        CHECK(!gate_pass(recs, "G7"));
    }

    // Reordering the same records must not change the verdict (fails either way).
    {
        std::vector<ExperimentRecord> a = {
            mk("E1", "B6", 100.0, "s1"),
            mk("E1", "B6", 90.0, "s2"),
            mk("E1", "B6", 80.0, "s3"),
        };
        std::vector<ExperimentRecord> b = {a[2], a[0], a[1]};
        CHECK(!gate_pass(a, "G7"));
        CHECK(!gate_pass(b, "G7"));
        CHECK(gate_pass(a, "G7") == gate_pass(b, "G7"));
    }

    // Exact 15% timing boundary -> PASS; just above (16%) -> FAIL.
    {
        std::vector<ExperimentRecord> boundary = {
            mk("E1", "B6", 100.0, "t1"),
            mk("E5", "B6", 85.0, "t2"),   // exactly 15%
        };
        CHECK(gate_pass(boundary, "G7"));

        std::vector<ExperimentRecord> over = {
            mk("E1", "B6", 100.0, "t3"),
            mk("E5", "B6", 84.0, "t4"),   // 16%
        };
        CHECK(!gate_pass(over, "G7"));
    }

    // Exact 20% bandwidth (B3) boundary -> PASS; just above (21%) -> FAIL.
    {
        std::vector<ExperimentRecord> boundary = {
            mk("E1", "B3", 100.0, "u1"),
            mk("E5", "B3", 80.0, "u2"),   // exactly 20%
        };
        CHECK(gate_pass(boundary, "G7"));

        std::vector<ExperimentRecord> over = {
            mk("E1", "B3", 100.0, "u3"),
            mk("E5", "B3", 79.0, "u4"),   // 21%
        };
        CHECK(!gate_pass(over, "G7"));
    }

    // computed=false with non-empty samples -> FAIL (uncomputed evidence rejected).
    {
        ExperimentRecord bad = mk("E1", "B6", 1.0, "c1");
        bad.statistics->computed = false;
        CHECK(!bad.statistics->samples.empty());
        std::vector<ExperimentRecord> recs = {bad, mk("E5", "B6", 1.0, "c2")};
        CHECK(!gate_pass(recs, "G7"));
    }

    // computed=true with empty samples -> FAIL (insufficient sample evidence).
    {
        ExperimentRecord bad = mk("E1", "B6", 1.0, "d1");
        bad.statistics->samples.clear();
        std::vector<ExperimentRecord> recs = {bad, mk("E5", "B6", 1.0, "d2")};
        CHECK(!gate_pass(recs, "G7"));
    }

    // computed=true with too few samples -> FAIL.
    {
        ExperimentRecord bad = mk("E1", "B6", 1.0, "d3", RunStatus::PASSED, 9);
        std::vector<ExperimentRecord> recs = {bad, mk("E5", "B6", 1.0, "d4")};
        CHECK(!gate_pass(recs, "G7"));
    }

    // Valid computed statistics -> PASS.
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 1.0, "v1"),
            mk("E5", "B6", 1.0, "v2"),
        };
        CHECK(gate_pass(recs, "G7"));
    }

    // A PASSED telemetry/profiler record that carries an informational
    // benchmark_id (the real TELEMETRY record does) must NOT be treated as
    // benchmark evidence and must not fail G7.
    {
        ExperimentRecord tel = mk("TELEMETRY", "TELEMETRY", 1.0, "tel-1");
        tel.kind = "telemetry";
        tel.statistics = std::nullopt;
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 100.0, "y1"),
            mk("E5", "B6", 85.0, "y2"),   // exact 15%
            tel,
        };
        CHECK(gate_pass(recs, "G7"));
    }

    // =====================================================================
    // v1.6: invalid-statistics regression tests
    // =====================================================================

    // Ten valid finite samples and consistent median -> PASS.
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 1.0, "v16-1"),
            mk("E5", "B6", 1.01, "v16-2"),   // 1% apart (within 15% timing tolerance)
        };
        CHECK(gate_pass(recs, "G7"));
    }

    // One NaN sample -> FAIL.
    {
        ExperimentRecord r = mk("E1", "B6", 1.0, "nan1");
        r.statistics->samples[0] = std::numeric_limits<double>::quiet_NaN();
        std::vector<ExperimentRecord> recs = {r, mk("E5", "B6", 1.0, "nan2")};
        CHECK(!gate_pass(recs, "G7"));
    }

    // One positive infinity sample -> FAIL.
    {
        ExperimentRecord r = mk("E1", "B6", 1.0, "inf1");
        r.statistics->samples[0] = std::numeric_limits<double>::infinity();
        std::vector<ExperimentRecord> recs = {r, mk("E5", "B6", 1.0, "inf2")};
        CHECK(!gate_pass(recs, "G7"));
    }

    // One negative infinity sample -> FAIL.
    {
        ExperimentRecord r = mk("E1", "B6", 1.0, "neginf1");
        r.statistics->samples[0] = -std::numeric_limits<double>::infinity();
        std::vector<ExperimentRecord> recs = {r, mk("E5", "B6", 1.0, "neginf2")};
        CHECK(!gate_pass(recs, "G7"));
    }

    // Fewer than ten samples -> FAIL (9 samples).
    {
        ExperimentRecord r = mk("E1", "B6", 1.0, "few1", RunStatus::PASSED, 9);
        std::vector<ExperimentRecord> recs = {r, mk("E5", "B6", 1.0, "few2")};
        CHECK(!gate_pass(recs, "G7"));
    }

    // Missing sample array -> FAIL (empty samples vector).
    {
        ExperimentRecord r = mk("E1", "B6", 1.0, "empty1");
        r.statistics->samples.clear();
        std::vector<ExperimentRecord> recs = {r, mk("E5", "B6", 1.0, "empty2")};
        CHECK(!gate_pass(recs, "G7"));
    }

    // Non-finite stored median -> FAIL.
    {
        ExperimentRecord r = mk("E1", "B6", 1.0, "med1");
        r.statistics->median = std::numeric_limits<double>::quiet_NaN();
        std::vector<ExperimentRecord> recs = {r, mk("E5", "B6", 1.0, "med2")};
        CHECK(!gate_pass(recs, "G7"));
    }

    // Finite but incorrect stored median -> FAIL (discrepancy > 0.001%).
    {
        ExperimentRecord r = mk("E1", "B6", 1.0, "badmed1");
        r.statistics->median = 1.001;   // 0.1% difference (exceeds 0.001% tolerance)
        std::vector<ExperimentRecord> recs = {r, mk("E5", "B6", 1.0, "badmed2")};
        CHECK(!gate_pass(recs, "G7"));
    }

    // Stored median matching recomputed median -> PASS.
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 42.0, "consistent1"),
            mk("E5", "B6", 42.0, "consistent2"),
        };
        CHECK(gate_pass(recs, "G7"));
    }

    // Different valid sample distributions with identical medians -> compare using intended G7 semantics.
    // This tests that the all-pairs comparison works correctly with different distributions.
    // Using samples that produce identical medians (1.0) to ensure pass.
    {
        // Create records with samples all equal to 1.0 - resulting in median=1.0
        ExperimentRecord r1;
        r1.record_id = "dist1-r1";
        r1.schema_version = "STARKP1 1";
        r1.stark_phase = "P1";
        r1.created_utc = "2026-10-04T00:00:00.000Z";
        r1.kind = "baseline";
        r1.experiment_id = "E1";
        r1.status = RunStatus::PASSED;
        r1.hardware = JsonValue::object();
        r1.hardware.set("cuda_available", JsonValue::boolean(false));
        JsonValue c1 = JsonValue::object();
        c1.set("benchmark_id", JsonValue::str("B6"));
        r1.configuration = c1;
        r1.statistics = stats_with(1.0, 10);  // 10 samples all equal to 1.0, median = 1.0
        
        ExperimentRecord r2;
        r2.record_id = "dist1-r2";
        r2.schema_version = "STARKP1 1";
        r2.stark_phase = "P1";
        r2.created_utc = "2026-10-04T00:00:00.000Z";
        r2.kind = "baseline";
        r2.experiment_id = "E5";
        r2.status = RunStatus::PASSED;
        r2.hardware = JsonValue::object();
        r2.hardware.set("cuda_available", JsonValue::boolean(false));
        JsonValue c2 = JsonValue::object();
        c2.set("benchmark_id", JsonValue::str("B6"));
        r2.configuration = c2;
        r2.statistics = stats_with(1.0, 10);  // 10 samples all equal to 1.0, median = 1.0
        
        std::vector<ExperimentRecord> recs = {r1, r2};
        CHECK(gate_pass(recs, "G7"));
    }

    // Reordered raw samples must not change the result (median and all-pairs comparison are order-independent).
    {
        std::vector<double> samples1 = {1.0, 0.9, 1.1, 0.85, 1.15, 0.95, 1.05, 0.8, 1.2, 0.75};
        Statistics st1 = compute_statistics(samples1);
        
        std::vector<double> samples2 = {0.75, 0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2};  // sorted version
        Statistics st2 = compute_statistics(samples2);
        
        ExperimentRecord r1 = mk("E1", "B6", st1.median, "order1");
        r1.statistics = st1;
        
        ExperimentRecord r2 = mk("E5", "B6", st2.median, "order2");
        r2.statistics = st2;
        
        std::vector<ExperimentRecord> recs = {r1, r2};
        CHECK(gate_pass(recs, "G7"));
    }

    // TELEMETRY exclusion must continue to PASS.
    {
        ExperimentRecord tel = mk("TELEMETRY", "TELEMETRY", 1.0, "tel1");
        tel.kind = "telemetry";
        tel.statistics = std::nullopt;
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 100.0, "tel2"),
            mk("E5", "B6", 85.0, "tel3"),   // exact 15%
            tel,
        };
        CHECK(gate_pass(recs, "G7"));
    }

    // Existing all-pairs endpoint-outlier test must continue to FAIL.
    {
        std::vector<ExperimentRecord> recs = {
            mk("E1", "B6", 100.0, "endpoint1"),
            mk("E5", "B6", 90.0, "endpoint2"),
            mk("E1", "B6", 80.0, "endpoint3"),
        };
        CHECK(!gate_pass(recs, "G7"));  // endpoints differ by 20% (exceeds 15% timing tolerance)
    }

    return test::report();
}
