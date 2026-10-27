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
 *       measured VRAM valid & invalid / structured VRAM unavailability
 *       (corroborated PASS; uncorroborated / contradictory / estimated FAIL) /
 *       capability states (gpu_present / cuda_available) informational only
 *       (v2.4 frozen-text correction: Case B)
 *   G7  all groups pass / failure survives a later passing group (both orders) /
 *       single-run group / missing repeat / duplicate-only repeat /
 *       boundary just inside & just outside / both-zero & one-zero /
 *       non-finite metric / missing statistics / grouping by configuration /
 *       multiple groups with mixed outcomes / different distributions identical
 *       different distributions identical median (G7 PASS) / different
 *       medians out of tolerance (G7 FAIL)
 *   v1.8 deserialization boundary (real production path):
 *       Statistics::from_json / ExperimentRecord::parse / RecordStore::loadAll
 *       / aggregator record loading + strict mode:
 *       numeric samples / string-bool-null-object samples / missing samples /
 *       empty / <10 samples / NaN & +/-inf (text and constructed) /
 *       missing median / string-bool-null-malformed median / wrong typed
 *       stored median / missing or wrong-typed computed / valid record /
 *       malformed input rejected cleanly with no crash, no coercion, no
 *       silent drop and no accidental G7 PASS
 */
#include <cmath>
#include <cstdio>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "test_harness.h"
#include "common/ExperimentRecord.h"
#include "common/HardwareProfiler.h"
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
    // Explicit hardware snapshot: gpu_present=false (OS device inventory reports
    // no physical GPU) and cuda_available=false (CUDA-less build). v2.4: G4 does
    // not gate on capability; hardware.cuda_available=false is what corroborates
    // a structured VRAM unavailability claim (G3 provenance principle).
    r.hardware = JsonValue::object();
    r.hardware.set("gpu_present", JsonValue::boolean(false));
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
    // Keep reports alive while the pointer returned by find_gate is read.
    // The previous temporary vector was destroyed at the end of this statement.
    const auto reports = evaluate_gates(recs);
    const GateReport* g = find_gate(reports, prefix);
    CHECK(g != nullptr);
    return g != nullptr && g->pass;
}

// ---------------------------------------------------------------------------
// Deserialization-boundary helpers (v1.8 §2)
//
// These exercise the REAL production seam: JsonValue::parse ->
// Statistics::from_json / ExperimentRecord::parse -> RecordStore::loadAll ->
// evaluate_gates. Nothing is reimplemented; only the input documents differ.
// ---------------------------------------------------------------------------

/// A fully populated Statistics JSON document with every required key.
const std::string& valid_stats_json() {
    static const std::string s =
        "{\"samples\":[1,2,3,4,5,6,7,8,9,10],\"mean\":5.5,\"median\":5.5,"
        "\"p95\":9.55,\"p99\":9.91,\"min\":1,\"max\":10,\"stdev\":3.03,"
        "\"computed\":true}";
    return s;
}

/// Serialize a complete valid record, then splice in a replacement
/// statistics value (object or null) so a single field can be varied while
/// every other field stays schema-valid.
std::string record_with_stats(const std::string& stats_json,
                              const std::string& record_id = "boundary-1") {
    ExperimentRecord r = mk("E1", "B6", 1.0, record_id);
    const std::string full = r.serialize();
    const std::string key = "\"statistics\":";
    const size_t k = full.find(key);
    if (k == std::string::npos) return full;  // defensive; cannot happen
    const size_t start = full.find('{', k);
    if (start == std::string::npos) return full;
    int depth = 0;
    size_t end = start;
    for (size_t i = start; i < full.size(); ++i) {
        if (full[i] == '{') ++depth;
        else if (full[i] == '}') {
            if (--depth == 0) { end = i; break; }
        }
    }
    return full.substr(0, start) + stats_json + full.substr(end + 1);
}

/// Parse a statistics JSON fragment; true when the production decoder throws.
bool stats_rejected(const std::string& json) {
    try {
        JsonValue v = JsonValue::parse(json);
        (void)Statistics::from_json(v);
        return false;
    } catch (const std::exception&) {
        return true;
    }
}

/// Parse a full record document; true when the production parser throws.
bool record_rejected(const std::string& stats_json) {
    try {
        (void)ExperimentRecord::parse(record_with_stats(stats_json));
        return false;
    } catch (const std::exception&) {
        return true;
    }
}

/// Build a record whose Statistics block was produced by the production
/// decoder (the honest path for feeding deserialized evidence to the gates).
ExperimentRecord parsed_record(const std::string& stats_json,
                               const std::string& record_id) {
    ExperimentRecord r = ExperimentRecord::parse(record_with_stats(stats_json, record_id));
    return r;
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
        // CUDA available at run time (device query exists) but VRAM claimed
        // unavailable -> self-contradictory -> FAIL (never trust the claim).
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

        // --- Uncorroborated VRAM unavailability must FAIL (G3 provenance
        // principle): hardware.cuda_available missing entirely (empty hardware
        // object) leaves the free-text reason alone as evidence -> FAIL.
        {
            ExperimentRecord r1 = p.e1;
            r1.hardware = JsonValue::object();
            CHECK(!gate_pass({r1, p.e5}, "G4"));           // E1 uncorroborated
            ExperimentRecord r5 = p.e5;
            r5.hardware = JsonValue::object();
            CHECK(!gate_pass({p.e1, r5}, "G4"));           // E5 uncorroborated
        }
        // cuda_available null / string / integer -> non-boolean, cannot
        // corroborate the unavailability claim -> FAIL on E1 and E5.
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
        // Authoritative GPU field with a measured VRAM value -> PASS (the
        // measurement stands on its own); the same record with an unmeasured
        // numeric peak (vram_measured=false) is an estimated peak -> FAIL.
        {
            ExperimentRecord r = p.e1;
            r.hardware = JsonValue::object();
            r.hardware.set("gpu_model", JsonValue::str("NVIDIA Test GPU"));
            r.peak_memory.set("vram_measured", JsonValue::boolean(true));
            r.peak_memory.set("vram_peak_bytes", JsonValue::uinteger(2048));
            CHECK(gate_pass({r, p.e5}, "G4"));             // measured VRAM -> PASS
            ExperimentRecord bad = r;
            bad.peak_memory.set("vram_measured", JsonValue::boolean(false));
            CHECK(!gate_pass({bad, p.e5}, "G4"));          // unmeasured numeric peak = estimated
        }

        // --- v2.1: physical GPU presence is INDEPENDENT of the CUDA build flag ---

        // (a) cuda_available=false ALONE: CUDA-less build, no gpu_present field.
        //     v2.4 Case B: physical capability is NOT a G4 criterion; the
        //     structured VRAM unavailability is corroborated by the embedded
        //     cuda_available=false probe result -> PASS. This is exactly the
        //     shape of the nine recovered historical records.
        {
            ExperimentRecord r = p.e1;
            r.hardware = JsonValue::object();
            r.hardware.set("cuda_available", JsonValue::boolean(false));  // CUDA-less build
            CHECK(gate_pass({r, p.e5}, "G4"));   // corroborated unavailability (frozen G4)
        }
        // (b) Physical GPU present, CUDA build DISABLED, VRAM unavailable.
        //     v2.4 Case B: the frozen G4 text does NOT require measured VRAM on
        //     a GPU-capable host - §A prescribes null+reason for GPU fields on
        //     a CUDA-less build, and ground rule 1 allows null+reason for any
        //     unobtainable quantity. Corroborated -> PASS (v2.3: FAIL).
        {
            ExperimentRecord r = p.e1;
            r.hardware = JsonValue::object();
            r.hardware.set("gpu_present", JsonValue::boolean(true));
            r.hardware.set("cuda_available", JsonValue::boolean(false));
            r.peak_memory.set("vram_measured", JsonValue::boolean(false));
            JsonValue vr = JsonValue::object();
            vr.set("value", JsonValue::null());
            vr.set("reason", JsonValue::str("unavailable: binary built without CUDA"));
            r.peak_memory.set("vram_peak_bytes", vr);
            CHECK(gate_pass({r, p.e5}, "G4"));   // null+reason is not an estimate (frozen G4)
        }
        // (c) Physical GPU present, CUDA ENABLED, VRAM measured -> PASS.
        {
            ExperimentRecord r = p.e1;
            r.hardware = JsonValue::object();
            r.hardware.set("gpu_present", JsonValue::boolean(true));
            r.hardware.set("cuda_available", JsonValue::boolean(true));
            r.hardware.set("gpu_model", JsonValue::str("NVIDIA Test GPU"));
            r.peak_memory.set("vram_measured", JsonValue::boolean(true));
            r.peak_memory.set("vram_peak_bytes", JsonValue::uinteger(1024 * 1024));
            CHECK(gate_pass({r, p.e5}, "G4"));
        }
        // (d) Confirmed CPU-only hardware (gpu_present=false): CPU workload under
        //     the frozen G4 rule passes with measured RAM and a documented VRAM
        //     unavailability reason (not an estimate).
        {
            ExperimentRecord r = p.e1;
            r.hardware = JsonValue::object();
            r.hardware.set("gpu_present", JsonValue::boolean(false));
            r.hardware.set("cuda_available", JsonValue::boolean(false));
            CHECK(gate_pass({r, p.e5}, "G4"));
        }
        // (e) Malformed gpu_present (object with null value): physical presence
        //     unknown, but gpu_present is NOT a G4 criterion (v2.4 Case B); the
        //     VRAM unavailability is corroborated by cuda_available=false -> PASS
        //     (v2.3: FAIL on Unknown capability).
        {
            ExperimentRecord r = p.e1;
            r.hardware = JsonValue::object();
            JsonValue gp = JsonValue::object();
            gp.set("value", JsonValue::null());
            gp.set("reason", JsonValue::str("unavailable: inventory failed"));
            r.hardware.set("gpu_present", gp);
            r.hardware.set("cuda_available", JsonValue::boolean(false));
            CHECK(gate_pass({r, p.e5}, "G4"));
        }
        // (f) GPU workload requiring VRAM evidence: gpu_present=true and
        //     vram_measured=true but VRAM value unavailable -> FAIL.
        {
            ExperimentRecord r = p.e1;
            r.hardware = JsonValue::object();
            r.hardware.set("gpu_present", JsonValue::boolean(true));
            r.peak_memory.set("vram_measured", JsonValue::boolean(true));
            JsonValue vr = JsonValue::object();
            vr.set("value", JsonValue::null());
            vr.set("reason", JsonValue::str("unavailable"));
            r.peak_memory.set("vram_peak_bytes", vr);
            CHECK(!gate_pass({r, p.e5}, "G4"));
        }

        // --- v2.4 (Case B): deterministic coverage of every corrected state ---

        // (g) Estimated peak: raw numeric VRAM while vram_measured=false -> FAIL.
        {
            ExperimentRecord r = p.e1;
            r.peak_memory.set("vram_measured", JsonValue::boolean(false));
            r.peak_memory.set("vram_peak_bytes", JsonValue::uinteger(123456789));
            CHECK(!gate_pass({r, p.e5}, "G4"));
        }
        // (h) Estimated peak nested inside an unavailability object -> FAIL.
        {
            ExperimentRecord r = p.e1;
            r.peak_memory.set("vram_measured", JsonValue::boolean(false));
            JsonValue o = JsonValue::object();
            o.set("value", JsonValue::uinteger(4096));
            o.set("reason", JsonValue::str("measured elsewhere"));
            r.peak_memory.set("vram_peak_bytes", o);
            CHECK(!gate_pass({r, p.e5}, "G4"));
        }
        // (i) vram_measured=false with the vram_peak_bytes key missing entirely
        //     (no structured unavailability at all) -> FAIL.
        {
            ExperimentRecord r = p.e1;
            JsonValue pm2 = JsonValue::object();
            pm2.set("ram_measured", JsonValue::boolean(true));
            pm2.set("ram_peak_bytes", JsonValue::uinteger(123456));
            pm2.set("vram_measured", JsonValue::boolean(false));
            r.peak_memory = pm2;
            CHECK(!gate_pass({r, p.e5}, "G4"));
        }
        // (j) RAM not measured (ram_measured=false despite a numeric value) ->
        //     FAIL: RAM is always obtainable via a process query (B8).
        {
            ExperimentRecord r = p.e1;
            r.peak_memory.set("ram_measured", JsonValue::boolean(false));
            CHECK(!gate_pass({r, p.e5}, "G4"));
        }
        // (k) Empty hardware (no cuda evidence) but a MEASURED VRAM value ->
        //     PASS: a measurement stands on its own.
        {
            ExperimentRecord r = p.e1;
            r.hardware = JsonValue::object();
            r.peak_memory.set("vram_measured", JsonValue::boolean(true));
            r.peak_memory.set("vram_peak_bytes", JsonValue::uinteger(1024));
            CHECK(gate_pass({r, p.e5}, "G4"));
        }
        // (l) Full GPU path: gpu_present + cuda_available=true + measured VRAM
        //     -> PASS.
        {
            ExperimentRecord r = p.e1;
            r.hardware = JsonValue::object();
            r.hardware.set("gpu_present", JsonValue::boolean(true));
            r.hardware.set("cuda_available", JsonValue::boolean(true));
            r.hardware.set("gpu_model", JsonValue::str("NVIDIA Test GPU"));
            r.peak_memory.set("vram_measured", JsonValue::boolean(true));
            r.peak_memory.set("vram_peak_bytes", JsonValue::uinteger(1024 * 1024));
            CHECK(gate_pass({r, p.e5}, "G4"));
        }
        // (m) cuda_available=true contradicts a VRAM unavailability claim even
        //     when gpu_present declares CPU-only: the device query existed ->
        //     FAIL (physical presence never overrides the probe result).
        {
            ExperimentRecord r = p.e1;
            r.hardware = JsonValue::object();
            r.hardware.set("gpu_present", JsonValue::boolean(false));
            r.hardware.set("cuda_available", JsonValue::boolean(true));
            CHECK(!gate_pass({r, p.e5}, "G4"));
        }
        // (n) gpu_present=true + cuda_available=false + MEASURED VRAM -> PASS
        //     (a measured value is always acceptable; the flag is provenance).
        {
            ExperimentRecord r = p.e1;
            r.hardware = JsonValue::object();
            r.hardware.set("gpu_present", JsonValue::boolean(true));
            r.hardware.set("cuda_available", JsonValue::boolean(false));
            r.peak_memory.set("vram_measured", JsonValue::boolean(true));
            r.peak_memory.set("vram_peak_bytes", JsonValue::uinteger(2048));
            CHECK(gate_pass({r, p.e5}, "G4"));
        }
        // (o) "Every baseline record": an OLDER PASSED E1 record with an
        //     estimated peak FAILS G4 even when the latest E1 record is valid.
        {
            ExperimentRecord stale = p.e1;
            stale.record_id = "run-e1-stale";
            stale.created_utc = "2026-10-03T00:00:00.000Z";
            stale.peak_memory.set("vram_measured", JsonValue::boolean(false));
            stale.peak_memory.set("vram_peak_bytes", JsonValue::uinteger(777));
            CHECK(!gate_pass({stale, p.e1, p.e5}, "G4"));
        }
        // (p) Multiple valid PASSED baseline records of the same experiment ->
        //     PASS (all of them are validated, none is skipped).
        {
            ExperimentRecord e1b = p.e1;
            e1b.record_id = "run-e1-second";
            set_good_peak(e1b);
            CHECK(gate_pass({p.e1, e1b, p.e5}, "G4"));
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

    // A PROFILER-kind record with a benchmark_id must likewise never enter a
    // benchmark group: it must not create a group of its own, must not count
    // toward the two-distinct-id requirement, and must never fail G7.
    {
        ExperimentRecord prof = mk("PROFILE", "B6", 1.0, "prof-1");
        prof.kind = "profiler";
        // A profiler record has no statistics in the real store; even if it
        // did, its kind excludes it before evidence checks run.
        prof.statistics = std::nullopt;

        // Alone, it forms no group -> "no same-configuration groups" -> FAIL.
        CHECK(!gate_pass({prof}, "G7"));

        // Paired with a real B6 group it is excluded, and the real group (100 vs
        // 90, 10% <= 15%) still passes.
        std::vector<ExperimentRecord> with_group = {
            mk("E1", "B6", 100.0, "pg1"),
            mk("E5", "B6", 90.0, "pg2"),
            prof,
        };
        CHECK(gate_pass(with_group, "G7"));

        // Critically: profiler + ONE benchmark record must NOT satisfy the
        // independent-repeat requirement (profiler never counted as a repeat).
        std::vector<ExperimentRecord> one_real = {
            mk("E1", "B6", 100.0, "pg3"),
            prof,
        };
        CHECK(!gate_pass(one_real, "G7"));

        // Same via a PASSED profiler that DOES carry computed statistics.
        ExperimentRecord prof2 = mk("PROFILE", "B6", 100.0, "prof-2");
        prof2.kind = "profiler";
        std::vector<ExperimentRecord> one_real2 = {
            mk("E1", "B6", 100.0, "pg4"),
            prof2,
        };
        CHECK(!gate_pass(one_real2, "G7"));
    }

    // G7 median-consistency tolerance is exactly 0.001% (production constant
    // G7_MEDIAN_TOLERANCE_PCT). Just inside must PASS, just outside must FAIL.
    // Values verified against the production formula
    //   rel = |stored - recomputed| / max(|stored|,|recomputed|) * 100
    // with recomputed == 1.0.
    {
        // Just INSIDE: stored=1.00001 -> rel = 0.00099999% <= 0.001% -> PASS.
        ExperimentRecord a = mk("E1", "B6", 1.0, "tol-in-1");
        a.statistics->median = 1.00001;
        ExperimentRecord b = mk("E5", "B6", 1.0, "tol-in-2");
        CHECK(gate_pass({a, b}, "G7"));

        // Just OUTSIDE: stored=1.000011 -> rel = 0.00109999% > 0.001% -> FAIL.
        ExperimentRecord c = mk("E1", "B6", 1.0, "tol-out-1");
        c.statistics->median = 1.000011;
        ExperimentRecord d = mk("E5", "B6", 1.0, "tol-out-2");
        CHECK(!gate_pass({c, d}, "G7"));

        // And the tolerance is unchanged at 0.001%, not silently loosened:
        // a 0.1% discrepancy (well outside) must still FAIL.
        ExperimentRecord e = mk("E1", "B6", 1.0, "tol-out-3");
        e.statistics->median = 1.001;
        ExperimentRecord f = mk("E5", "B6", 1.0, "tol-out-4");
        CHECK(!gate_pass({e, f}, "G7"));
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

    // ------------------------------------------------------------------
    // v1.7: different-distributions G7 regression tests (real distributions)
    // ------------------------------------------------------------------

    // G7 PASS: two genuinely different raw distributions that happen to share
    // the same median. G7 compares medians, not whole distributions.
    {
        // Distribution A: 10 samples, median = 1.0 (sorted indices 4 and 5 are
        // 0.95 and 1.05 -> (0.95 + 1.05) / 2 = 1.0), e.g. half below, half above.
        const std::vector<double> samplesA = {0.4, 0.6, 0.7, 0.8, 0.95,
                                              1.05, 1.1, 1.2, 1.3, 1.6};
        const Statistics stA = compute_statistics(samplesA);
        CHECK(stA.samples.size() == 10);
        CHECK(std::isfinite(stA.median));
        const double medianA = stA.median;

        // Distribution B: 10 samples, median = 1.0, but clearly different values.
        // Sorted indices 4 and 5 are 0.9 and 1.1 -> median = 1.0.
        const std::vector<double> samplesB = {0.1, 0.4, 0.65, 0.85, 0.9,
                                              1.1, 1.25, 1.45, 1.6, 1.85};
        const Statistics stB = compute_statistics(samplesB);
        CHECK(stB.samples.size() == 10);
        CHECK(std::isfinite(stB.median));
        const double medianB = stB.median;

        // Both arrays must be genuinely different.
        CHECK(samplesA != samplesB);

        // Recomputed medians must be identical.
        CHECK(medianA == medianB);

        // Both recomputed medians must be EXACTLY 1.0 under the production
        // statistics convention (0.95+1.05)/2 and (0.9+1.1)/2.
        CHECK(medianA == 1.0);
        CHECK(medianB == 1.0);

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
        r1.statistics = stA;
        // Stored median must match its own recomputed median.
        CHECK(r1.statistics->median == medianA);

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
        r2.statistics = stB;
        // Stored median must match its own recomputed median.
        CHECK(r2.statistics->median == medianB);

        // Configuration objects must be exactly equal.
        CHECK(r1.configuration.dump() == r2.configuration.dump());

        // Stored medians must be identical.
        CHECK(r1.statistics->median == r2.statistics->median);

        // Distinct record IDs.
        CHECK(r1.record_id != r2.record_id);

        std::vector<ExperimentRecord> recs = {r1, r2};
        CHECK(gate_pass(recs, "G7"));  // G7 passes because medians agree
    }

    // G7 FAIL: two genuinely different distributions whose medians differ by
    // more than the 15% timing tolerance.
    {
        // Distribution A: median = 1.0
        const std::vector<double> samplesA = {0.4, 0.6, 0.7, 0.8, 0.95,
                                              1.05, 1.1, 1.2, 1.3, 1.6};
        const Statistics stA = compute_statistics(samplesA);
        const double medianA = stA.median;

        // Distribution B: median = 3.0  ->  symmetric relative difference =
        // abs(1-3)/max(1,3)*100 = 2/3*100 = 66.7%  >> 15% tolerance -> G7 FAIL.
        const std::vector<double> samplesB = {2.4, 2.6, 2.7, 2.8, 2.95,
                                              3.05, 3.1, 3.2, 3.3, 3.6};
        const Statistics stB = compute_statistics(samplesB);
        const double medianB = stB.median;

        CHECK(samplesA != samplesB);
        CHECK(medianA != medianB);

        ExperimentRecord r1;
        r1.record_id = "dist2-r1";
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
        r1.statistics = stA;

        ExperimentRecord r2;
        r2.record_id = "dist2-r2";
        r2.schema_version = "STARKP1 1";
        r2.stark_phase = "P1";
        r2.created_utc = "2026-10-04T00:00:00.000Z";
        r2.kind = "baseline";
        r2.experiment_id = "E5";
        r2.status = RunStatus::PASSED;
        r2.hardware = JsonValue::object();
        r2.hardware.set("cuda_available", JsonValue::boolean(true));
        JsonValue c2 = JsonValue::object();
        c2.set("benchmark_id", JsonValue::str("B6"));
        r2.configuration = c2;
        r2.statistics = stB;

        std::vector<ExperimentRecord> recs = {r1, r2};
        CHECK(!gate_pass(recs, "G7"));  // G7 fails because the medians differ too much
    }

    // Reordered raw samples must not change the result (median and all-pairs
    // comparison are order-independent).
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

    // =====================================================================
    // v1.8 §2: DESERIALIZATION-BOUNDARY REGRESSION TESTS
    //
    // Every case below goes through the real production path:
    //   JsonValue::parse -> Statistics::from_json
    //   ExperimentRecord::parse
    //   RecordStore::loadAll + ExperimentRecord::validate
    //   evaluate_gates (the aggregator's own gate seam)
    // The contract under test: malformed input is REJECTED CLEANLY -- no
    // crash, no silent coercion, no silent record drop, and never an
    // accidental G7 PASS.
    // =====================================================================

    // --------------------------------------------------------------------
    // A. Statistics::from_json — numeric samples (the valid path)
    // --------------------------------------------------------------------
    {
        JsonValue v = JsonValue::parse(valid_stats_json());
        Statistics s = Statistics::from_json(v);
        CHECK(s.samples.size() == 10);
        CHECK(s.median == 5.5);
        CHECK(s.mean == 5.5);
        CHECK(s.min == 1.0);
        CHECK(s.max == 10.0);
        CHECK(s.computed == true);
        CHECK(!stats_rejected(valid_stats_json()));  // sanity: valid is not rejected

        // Int/UInt samples (as emitted by a hand-built document) are numeric too.
        JsonValue v2 = JsonValue::parse(
            "{\"samples\":[1,2,3],\"mean\":2,\"median\":2,\"p95\":3,\"p99\":3,"
            "\"min\":1,\"max\":3,\"stdev\":1,\"computed\":true}");
        Statistics s2 = Statistics::from_json(v2);
        CHECK(s2.samples.size() == 3);
        CHECK(s2.samples[0] == 1.0);
    }

    // --------------------------------------------------------------------
    // B. Non-numeric values INSIDE samples must be rejected, not coerced
    // --------------------------------------------------------------------
    {
        const char* bad_samples[] = {
            "{\"samples\":[1,\"x\"],\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}",  // string
            "{\"samples\":[true],\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}",    // bool
            "{\"samples\":[null],\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}",     // null
            "{\"samples\":[{\"a\":1}],\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}",// object
            "{\"samples\":[[1]],\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}",   // nested array
        };
        for (const char* c : bad_samples) {
            CHECK(stats_rejected(c));   // rejected, never accepted as a number
            CHECK(record_rejected(c));  // and therefore rejected through the record path too
        }
        // samples present but not an array
        CHECK(stats_rejected("{\"samples\":\"abc\",\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}"));
        // samples field missing entirely
        CHECK(stats_rejected("{\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}"));
        CHECK(record_rejected("{\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}"));
    }

    // --------------------------------------------------------------------
    // C. Empty and undersized sample arrays: parseable, but never enough
    //    evidence for a G7 PASS.
    // --------------------------------------------------------------------
    {
        const std::string empty =
            "{\"samples\":[],\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,"
            "\"min\":1,\"max\":1,\"stdev\":0,\"computed\":false}";
        CHECK(!stats_rejected(empty));                 // parses (schema allows empty)
        Statistics e = Statistics::from_json(JsonValue::parse(empty));
        CHECK(e.samples.empty());
        CHECK(!e.computed);                            // never fabricated

        const std::string nine =
            "{\"samples\":[1,2,3,4,5,6,7,8,9],\"mean\":5,\"median\":5,\"p95\":9,"
            "\"p99\":9,\"min\":1,\"max\":9,\"stdev\":0,\"computed\":true}";
        CHECK(!stats_rejected(nine));                  // parses: schema-valid
        Statistics n9 = Statistics::from_json(JsonValue::parse(nine));
        CHECK(n9.samples.size() == 9);

        // Through the record path: empty samples must never be accepted as
        // valid measurement evidence. Either the parser rejects it outright, or
        // validate() rejects it — what may NOT happen is parse+validate both
        // succeeding (that would let zero samples reach a gate as evidence).
        bool empty_accepted_as_evidence = false;
        try {
            ExperimentRecord r = ExperimentRecord::parse(record_with_stats(empty));
            empty_accepted_as_evidence = r.validate().empty();
        } catch (const std::exception&) {
            empty_accepted_as_evidence = false;   // rejected at parse: correct
        }
        CHECK(!empty_accepted_as_evidence);
    }

    // --------------------------------------------------------------------
    // D. NaN / +/-inf — not representable in the JSON text; when they can
    //    only be produced by constructing values in memory, G7 must fail
    //    closed rather than compare garbage.
    // --------------------------------------------------------------------
    {
        const char* nonfinite_text[] = {
            "{\"samples\":[nan],\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}",
            "{\"samples\":[NaN],\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}",
            "{\"samples\":[inf],\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}",
            "{\"samples\":[Infinity],\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}",
            "{\"samples\":[1e400],\"mean\":1,\"median\":1,\"p95\":1,\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}",
            "{\"samples\":[1,2,3,4,5,6,7,8,9,10],\"mean\":5.5,\"median\":nan,\"p95\":1,\"p99\":1,\"min\":1,\"max\":10,\"stdev\":0,\"computed\":true}",
        };
        for (const char* c : nonfinite_text) CHECK(stats_rejected(c));

        // Constructed in-memory (not expressible as JSON): G7 fails closed.
        const double nan_v = std::numeric_limits<double>::quiet_NaN();
        const double inf_v = std::numeric_limits<double>::infinity();

        ExperimentRecord a = mk("E1", "B6", 1.0, "nf-a");
        ExperimentRecord b = mk("E5", "B6", 1.0, "nf-b");
        b.statistics->samples[0] = nan_v;
        b.statistics->median = nan_v;
        CHECK(!gate_pass({a, b}, "G7"));

        ExperimentRecord c = mk("E1", "B6", 1.0, "nf-c");
        ExperimentRecord d = mk("E5", "B6", 1.0, "nf-d");
        d.statistics->samples[0] = inf_v;
        CHECK(!gate_pass({c, d}, "G7"));

        ExperimentRecord e = mk("E1", "B6", 1.0, "nf-e");
        ExperimentRecord f = mk("E5", "B6", 1.0, "nf-f");
        f.statistics->samples[0] = -inf_v;
        CHECK(!gate_pass({e, f}, "G7"));

        // Non-finite STORED median alone (samples fine) must also fail closed.
        ExperimentRecord g = mk("E1", "B6", 1.0, "nf-g");
        ExperimentRecord h = mk("E5", "B6", 1.0, "nf-h");
        h.statistics->median = inf_v;
        CHECK(!gate_pass({g, h}, "G7"));
    }

    // --------------------------------------------------------------------
    // E. Median: missing / string / bool / null / object / malformed
    //    -> rejected at the decoder, never coerced to 0.
    // --------------------------------------------------------------------
    {
        const char* bad_median[] = {
            "{\"samples\":[1,2,3,4,5,6,7,8,9,10],\"mean\":5.5,\"p95\":1,\"p99\":1,\"min\":1,\"max\":10,\"stdev\":0,\"computed\":true}",              // missing
            "{\"samples\":[1,2,3,4,5,6,7,8,9,10],\"mean\":5.5,\"median\":\"5.5\",\"p95\":1,\"p99\":1,\"min\":1,\"max\":10,\"stdev\":0,\"computed\":true}", // string
            "{\"samples\":[1,2,3,4,5,6,7,8,9,10],\"mean\":5.5,\"median\":true,\"p95\":1,\"p99\":1,\"min\":1,\"max\":10,\"stdev\":0,\"computed\":true}",   // bool
            "{\"samples\":[1,2,3,4,5,6,7,8,9,10],\"mean\":5.5,\"median\":null,\"p95\":1,\"p99\":1,\"min\":1,\"max\":10,\"stdev\":0,\"computed\":true}",   // null
            "{\"samples\":[1,2,3,4,5,6,7,8,9,10],\"mean\":5.5,\"median\":{},\"p95\":1,\"p99\":1,\"min\":1,\"max\":10,\"stdev\":0,\"computed\":true}",       // object
            "{\"samples\":[1,2,3,4,5,6,7,8,9,10],\"mean\":5.5,\"median\":5.5x,\"p95\":1,\"p99\":1,\"min\":1,\"max\":10,\"stdev\":0,\"computed\":true}",   // malformed token
        };
        for (const char* c : bad_median) {
            CHECK(stats_rejected(c));
            CHECK(record_rejected(c));
        }
    }

    // --------------------------------------------------------------------
    // F. Correctly typed but INCORRECT stored median: parses cleanly, is
    //    schema-valid, and G7 rejects it via independent recomputation.
    // --------------------------------------------------------------------
    {
        const std::string wrong_median =
            "{\"samples\":[1,2,3,4,5,6,7,8,9,10],\"mean\":5.5,\"median\":999,"
            "\"p95\":1,\"p99\":1,\"min\":1,\"max\":10,\"stdev\":0,\"computed\":true}";
        CHECK(!stats_rejected(wrong_median));   // decodes: type is fine
        CHECK(!record_rejected(wrong_median));  // record parses...
        ExperimentRecord bad = ExperimentRecord::parse(record_with_stats(wrong_median, "wm-bad"));
        CHECK(bad.validate().empty());          // ...and is schema-valid...
        ExperimentRecord good = mk("E5", "B6", 5.5, "wm-good");
        good.statistics = Statistics::from_json(JsonValue::parse(valid_stats_json()));
        CHECK(!gate_pass({good, bad}, "G7"));   // ...but G7 must still FAIL it
    }

    // --------------------------------------------------------------------
    // G. `computed` missing or wrongly typed -> rejected, never defaulted.
    // --------------------------------------------------------------------
    {
        const char* bad_computed[] = {
            "{\"samples\":[1,2,3,4,5,6,7,8,9,10],\"mean\":5.5,\"median\":5.5,\"p95\":1,\"p99\":1,\"min\":1,\"max\":10,\"stdev\":0}",                  // missing
            "{\"samples\":[1,2,3,4,5,6,7,8,9,10],\"mean\":5.5,\"median\":5.5,\"p95\":1,\"p99\":1,\"min\":1,\"max\":10,\"stdev\":0,\"computed\":\"true\"}", // string
            "{\"samples\":[1,2,3,4,5,6,7,8,9,10],\"mean\":5.5,\"median\":5.5,\"p95\":1,\"p99\":1,\"min\":1,\"max\":10,\"stdev\":0,\"computed\":1}",     // int
            "{\"samples\":[1,2,3,4,5,6,7,8,9,10],\"mean\":5.5,\"median\":5.5,\"p95\":1,\"p99\":1,\"min\":1,\"max\":10,\"stdev\":0,\"computed\":null}",  // null
        };
        for (const char* c : bad_computed) {
            CHECK(stats_rejected(c));
            CHECK(record_rejected(c));
        }

        // A decoded record with computed=false must never pass G7.
        ExperimentRecord a = mk("E1", "B6", 1.0, "cf-a");
        ExperimentRecord b = mk("E5", "B6", 1.0, "cf-b");
        b.statistics->computed = false;
        CHECK(!gate_pass({a, b}, "G7"));
    }

    // --------------------------------------------------------------------
    // H. Correct valid record end-to-end: decode -> validate -> G7 PASS.
    // --------------------------------------------------------------------
    {
        ExperimentRecord r1 = parsed_record(valid_stats_json(), "valid-r1");
        ExperimentRecord r2 = parsed_record(valid_stats_json(), "valid-r2");
        CHECK(r1.validate().empty());
        CHECK(r2.validate().empty());
        CHECK(r1.statistics.has_value());
        CHECK(r1.statistics->samples.size() == 10);
        CHECK(r1.statistics->computed);
        CHECK(r1.record_id != r2.record_id);
        CHECK(gate_pass({r1, r2}, "G7"));
    }

    // --------------------------------------------------------------------
    // I. A PASSED benchmark record with NO statistics at all fails closed.
    // --------------------------------------------------------------------
    {
        ExperimentRecord a = mk("E1", "B6", 1.0, "nostat-a");
        ExperimentRecord b = mk("E5", "B6", 1.0, "nostat-b");
        b.statistics = std::nullopt;
        CHECK(!gate_pass({a, b}, "G7"));

        // Same through the JSON boundary: statistics: null on a PASSED record
        // must never be accepted as valid evidence.
        bool null_stats_accepted = false;
        try {
            ExperimentRecord r = ExperimentRecord::parse(record_with_stats("null", "nullstats"));
            null_stats_accepted = r.validate().empty();
        } catch (const std::exception&) {
            null_stats_accepted = false;   // rejected at parse: correct
        }
        CHECK(!null_stats_accepted);
    }

    // --------------------------------------------------------------------
    // J. RecordStore::loadAll — malformed files are REPORTED, never
    //    silently dropped; valid siblings still load.
    // --------------------------------------------------------------------
    {
        const std::string dir = "build/test_gates_boundary_tmp";
        RecordStore store(dir);

        // Two valid records written through the production store.
        store.append(parsed_record(valid_stats_json(), "BL-boundary-1"));
        store.append(parsed_record(valid_stats_json(), "BL-boundary-2"));

        // One file that is not decodable at all.
        {
            std::ofstream bad(dir + "/BL-boundary-BROKEN.json",
                              std::ios::binary | std::ios::trunc);
            bad << "{\"schema_version\":\"STARKP1 1\",\"statistics\":{\"samples\":[\"oops\"]}}";
        }
        // One file whose statistics decode fails (wrong-typed sample).
        {
            std::ofstream bad(dir + "/BL-boundary-BADSAMPLE.json",
                              std::ios::binary | std::ios::trunc);
            bad << record_with_stats(
                "{\"samples\":[\"oops\"],\"mean\":1,\"median\":1,\"p95\":1,"
                "\"p99\":1,\"min\":1,\"max\":1,\"stdev\":0,\"computed\":true}",
                "BL-boundary-badsample");
        }

        auto entries = store.loadAll();
        int ok = 0, failed = 0;
        bool saw_broken = false, saw_badsample = false;
        for (const auto& e : entries) {
            if (e.parse_ok) {
                ++ok;
            } else {
                ++failed;
                CHECK(!e.error.empty());               // an explanation, always
                if (e.path.find("BROKEN") != std::string::npos) saw_broken = true;
                if (e.path.find("BADSAMPLE") != std::string::npos) saw_badsample = true;
            }
        }
        CHECK(failed >= 2);            // both malformed files surfaced
        CHECK(saw_broken);             // not silently dropped
        CHECK(saw_badsample);          // not silently dropped
        CHECK(ok >= 2);                // valid siblings still load

        // The aggregator's own loading contract (aggregate.cpp): invalid files
        // are excluded from the gate input and reported. Reproduce it exactly.
        std::vector<ExperimentRecord> records;
        int invalid = 0;
        for (const auto& e : entries) {
            if (!e.parse_ok) { ++invalid; continue; }
            auto errs = e.record.validate();
            if (!errs.empty()) { ++invalid; continue; }
            records.push_back(e.record);
        }
        CHECK(invalid == failed);
        CHECK(static_cast<int>(records.size()) == ok);

        // With only our two valid same-config records present, G7 passes.
        CHECK(gate_pass(records, "G7"));

        // Mirror aggregate.cpp's exit decision EXACTLY, then assert the
        // contract: an invalid record forces strict to fail regardless of the
        // gate outcome, while non-strict fails only on gate results.
        const bool gates_ok = all_gates_pass(evaluate_gates(records));
        auto agg_exit = [&](bool strict) {
            if (!gates_ok) return 1;
            if (strict && invalid > 0) return 1;
            return 0;
        };
        CHECK(invalid > 0);                 // malformed files were surfaced
        CHECK(agg_exit(true) == 1);         // strict fails: invalid record present
        CHECK(agg_exit(false) == (gates_ok ? 0 : 1));  // non-strict: gates only

        // Cleanup so repeated runs start from the same state.
        std::remove((dir + "/BL-boundary-BROKEN.json").c_str());
        std::remove((dir + "/BL-boundary-BADSAMPLE.json").c_str());
        std::remove((dir + "/BL-boundary-1.json").c_str());
        std::remove((dir + "/BL-boundary-2.json").c_str());
    }

    // --------------------------------------------------------------------
    // J2. The aggregator's strict-mode contract against a REAL passing
    //     dataset: every gate passes, so strict is the ONLY thing that can
    //     make the run fail. A malformed sibling must flip strict to 1 while
    //     leaving non-strict at 0 — proving the invalid record is reported,
    //     never silently dropped, and never silently ignored.
    // --------------------------------------------------------------------
    {
        const std::string src = "fixtures/controlled-valid";
        const std::string dir = "build/test_gates_agg_tmp";
        const char* names[] = {
            "P1-B4-skip.json", "P1-B5-skip.json", "P1-E1-B6-52043.json",
            "P1-E2-skip.json",  "P1-E5-B6-7336.json", "P1-PROFILE-24-0.json",
            "P1-TELEMETRY-24-1.json",
        };
        auto copy_file = [](const std::string& a, const std::string& b) {
            std::ifstream in(a, std::ios::binary);
            std::ofstream out(b, std::ios::binary | std::ios::trunc);
            if (!in || !out) return false;
            out << in.rdbuf();
            return static_cast<bool>(out);
        };
        // Create the destination directory through the production store
        // (RecordStore::append creates it), then drop the seed file.
        {
            RecordStore seed(dir);
            seed.append(parsed_record(valid_stats_json(), "BL-agg-dirseed"));
            std::remove((dir + "/BL-agg-dirseed.json").c_str());
        }
        auto run_agg = [&](bool with_malformed) {
            // Reset the directory contents.
            for (const char* n : names) std::remove((dir + "/" + n).c_str());
            std::remove((dir + "/BL-agg-malformed.json").c_str());
            for (const char* n : names) CHECK(copy_file(src + "/" + n, dir + "/" + n));
            if (with_malformed) {
                std::ofstream bad(dir + "/BL-agg-malformed.json",
                                  std::ios::binary | std::ios::trunc);
                bad << "{\"schema_version\":\"STARKP1 1\",\"record_id\":";
            }
            RecordStore store(dir);
            auto entries = store.loadAll();
            std::vector<ExperimentRecord> recs;
            int invalid = 0;
            for (const auto& e : entries) {
                if (!e.parse_ok) { ++invalid; continue; }
                auto errs = e.record.validate();
                if (!errs.empty()) { ++invalid; continue; }
                recs.push_back(e.record);
            }
            const bool ok_gates = all_gates_pass(evaluate_gates(recs));
            int exit_code = ok_gates ? 0 : 1;
            if (ok_gates && invalid > 0) exit_code = 1;  // strict path
            return std::make_pair(std::make_pair(ok_gates, invalid), exit_code);
        };

        // Clean dataset: all gates pass, nothing invalid -> strict exits 0.
        auto clean = run_agg(false);
        CHECK(clean.first.first == true);     // all gates pass
        CHECK(clean.first.second == 0);       // nothing invalid
        CHECK(clean.second == 0);             // strict exits 0

        // Same dataset + one malformed file: gates still pass (the bad file is
        // excluded from gate input), invalid == 1 -> strict flips to 1.
        auto dirty = run_agg(true);
        CHECK(dirty.first.first == true);     // gates STILL pass...
        CHECK(dirty.first.second == 1);       // ...but one record is invalid
        CHECK(dirty.second == 1);             // ...so strict fails

        // Cleanup.
        for (const char* n : names) std::remove((dir + "/" + n).c_str());
        std::remove((dir + "/BL-agg-malformed.json").c_str());
    }

    // --------------------------------------------------------------------
    // K. Empty / evidence-free input fails closed (never an accidental PASS).
    // --------------------------------------------------------------------
    {
        CHECK(!gate_pass({}, "G7"));   // no records at all -> G7 FAIL
    }

    // =====================================================================
    // v1.8 §3: FAIL-CLOSED ON UNDECODABLE EVIDENCE (no throw escapes
    // evaluate_gates). Two production paths decoded record blocks without a
    // guard and threw std::runtime_error, aborting the aggregator instead of
    // failing the gate:
    //   G1 StaticHardwareProfile::from_json(hw_rec.hardware)
    //   G5 ParameterAccounting::from_json(r.accounting)
    // Both are now caught and reported as a gate FAIL with a reason.
    // =====================================================================
    {
        // G1: PROFILE record whose hardware is non-null but undecodable
        // (passes ExperimentRecord::validate()'s isNull check, then throws
        // inside from_json on the missing cpu_model key).
        ExperimentRecord prof = mk("PROFILE", "", 1.0, "badprof-1");
        prof.kind = "profiler";
        prof.experiment_id = "PROFILE";
        prof.hardware = JsonValue::object();
        prof.hardware.set("cuda_available", JsonValue::boolean(false));  // incomplete
        prof.statistics = std::nullopt;

        bool threw = false;
        std::vector<GateReport> gs;
        try {
            gs = evaluate_gates({prof});
        } catch (const std::exception&) {
            threw = true;
        }
        CHECK(!threw);                              // must NOT escape evaluate_gates
        const GateReport* g1 = find_gate(gs, "G1");
        CHECK(g1 != nullptr);
        CHECK(g1 && !g1->pass);                     // fails closed...
        CHECK(g1 && g1->detail.find("malformed") != std::string::npos);  // ...with a reason

        // G5: a record whose accounting block is a non-null object that
        // cannot be decoded (wrong value type).
        ExperimentRecord a = mk("E1", "B6", 1.0, "badacct-e1");
        a.experiment_id = "E1";
        a.accounting = JsonValue::object();
        a.accounting.set("logical_parameters", JsonValue::str("not-a-number"));
        ExperimentRecord b = mk("E5", "B6", 1.0, "badacct-e5");
        b.accounting = JsonValue::null();
        set_good_peak(a); set_good_peak(b);

        threw = false;
        gs.clear();
        try {
            gs = evaluate_gates({a, b});
        } catch (const std::exception&) {
            threw = true;
        }
        CHECK(!threw);                              // must NOT escape evaluate_gates
        const GateReport* g5 = find_gate(gs, "G5");
        CHECK(g5 != nullptr);
        CHECK(g5 && !g5->pass);                     // fails closed...
        CHECK(g5 && g5->detail.find("malformed") != std::string::npos);  // ...with a reason
    }

    // =====================================================================
    // v2.3 §G3: STRUCTURED, provenance-bearing skip attestation.
    //
    // OLD (pre-v2.3): a no-CUDA skip passed on any non-empty status_reason.
    // NEW: G3 requires a machine-verifiable skip_attestation object; free text
    // is NOT evidence. Both G3 branches are exercised through the deterministic
    // CUDA seam evaluate_gates_with_cuda() -- production still calls the real
    // probe. No CUDA runtime is faked and no PASS is manufactured.
    // =====================================================================
    {
        // Helper: a well-formed no-CUDA attestation.
        auto att = [](const char* code, const char* state, const char* avail,
                      const char* src, const char* prod, bool cuda) {
            JsonValue a = JsonValue::object();
            a.set("schema", JsonValue::str("STARKP1 skip-attestation 1"));
            a.set("reason_code", JsonValue::str(code));
            a.set("capability_state", JsonValue::str(state));
            a.set("execution_availability", JsonValue::str(avail));
            a.set("capability_source", JsonValue::str(src));
            a.set("producer", JsonValue::str(prod));
            a.set("cuda_available", JsonValue::boolean(cuda));
            return a;
        };
        const JsonValue good = att("cuda_unavailable", "cuda_unavailable", "not_available",
                                   "cudaGetDeviceCount", "run_baseline", false);

        auto skip_rec = [&](const char* id, const char* kind, const JsonValue& a) {
            ExperimentRecord r;
            r.record_id = std::string("skip-") + id;
            r.schema_version = "STARKP1 1";
            r.stark_phase = "P1";
            r.created_utc = "2026-10-05T00:00:00.000Z";
            r.kind = kind;
            r.experiment_id = id;
            r.status = RunStatus::SKIPPED;
            r.status_reason = "skipped: CUDA unavailable in this build";
            r.skip_attestation = a;
            r.hardware = JsonValue::object();
            r.hardware.set("cuda_available", JsonValue::boolean(false));
            r.software = JsonValue::object();
            JsonValue c = JsonValue::object();
            c.set("benchmark_id", JsonValue::str(id));
            r.configuration = c;
            return r;
        };
        auto g3_cuda = [&](const std::vector<ExperimentRecord>& recs, bool cuda,
                           std::string& detail) {
            const auto gs = evaluate_gates_with_cuda(recs, cuda);
            const GateReport* g = find_gate(gs, "G3");
            CHECK(g != nullptr);
            if (g) { detail = g->detail; return g->pass; }
            return false;
        };

        // (1) Valid recognized no-CUDA skip -> PASS.
        {
            std::vector<ExperimentRecord> v = {
                skip_rec("E2", "baseline", good), skip_rec("B4", "benchmark", good),
                skip_rec("B5", "benchmark", good)};
            std::string d;
            CHECK(g3_cuda(v, false, d));
            CHECK(d.find("cuda_unavailable") != std::string::npos);
        }
        // (2) Missing E2 -> FAIL.
        {
            std::vector<ExperimentRecord> v = {skip_rec("B4", "benchmark", good),
                                               skip_rec("B5", "benchmark", good)};
            std::string d;
            CHECK(!g3_cuda(v, false, d));
            CHECK(d.find("E2") != std::string::npos && d.find("missing") != std::string::npos);
        }
        // (3) Missing B4 -> FAIL.
        {
            std::vector<ExperimentRecord> v = {skip_rec("E2", "baseline", good),
                                               skip_rec("B5", "benchmark", good)};
            std::string d;
            CHECK(!g3_cuda(v, false, d));
            CHECK(d.find("B4") != std::string::npos && d.find("missing") != std::string::npos);
        }

        // (4) Missing B5 -> FAIL.
        {
            std::vector<ExperimentRecord> v = {skip_rec("E2", "baseline", good),
                                               skip_rec("B4", "benchmark", good)};
            std::string d;
            CHECK(!g3_cuda(v, false, d));
            CHECK(d.find("B5") != std::string::npos);
        }
        // (5) Empty reason/provenance -> FAIL.
        {
            ExperimentRecord e2 = skip_rec("E2", "baseline", good);
            e2.status_reason.clear();  // no reason
            std::vector<ExperimentRecord> v = {e2, skip_rec("B4", "benchmark", good),
                                               skip_rec("B5", "benchmark", good)};
            std::string d;
            CHECK(!g3_cuda(v, false, d));
            CHECK(d.find("without reason") != std::string::npos);
            // Missing provenance inside the attestation also fails.
            ExperimentRecord e2b = skip_rec("E2", "baseline", att("cuda_unavailable", "cuda_unavailable",
                                                                   "not_available", "", "run_baseline", false));
            std::vector<ExperimentRecord> v2 = {e2b, skip_rec("B4", "benchmark", good),
                                                skip_rec("B5", "benchmark", good)};
            std::string d2;
            CHECK(!g3_cuda(v2, false, d2));
            CHECK(d2.find("capability_source") != std::string::npos);
        }
        // (6) Arbitrary "x" reason -> FAIL (free text is not evidence).
        {
            ExperimentRecord e2 = skip_rec("E2", "baseline", JsonValue::null());
            e2.status_reason = "x";
            std::vector<ExperimentRecord> v = {e2, skip_rec("B4", "benchmark", good),
                                               skip_rec("B5", "benchmark", good)};
            std::string d;
            CHECK(!g3_cuda(v, false, d));
            CHECK(d.find("structured skip attestation") != std::string::npos);
        }
        // (7) "lorem ipsum" reason -> FAIL.
        {
            ExperimentRecord e2 = skip_rec("E2", "baseline", JsonValue::null());
            e2.status_reason = "lorem ipsum";
            std::vector<ExperimentRecord> v = {e2, skip_rec("B4", "benchmark", good),
                                               skip_rec("B5", "benchmark", good)};
            std::string d;
            CHECK(!g3_cuda(v, false, d));
        }
        // (7b) Unrecognized reason_code with full provenance -> FAIL.
        {
            ExperimentRecord e2 = skip_rec("E2", "baseline",
                                           att("because_i_said_so", "cuda_unavailable", "not_available",
                                               "src", "prod", false));
            std::vector<ExperimentRecord> v = {e2, skip_rec("B4", "benchmark", good),
                                               skip_rec("B5", "benchmark", good)};
            std::string d;
            CHECK(!g3_cuda(v, false, d));
            CHECK(d.find("reason_code") != std::string::npos);
        }
        // (8) Contradictory cuda_available=true + no-CUDA skip -> FAIL.
        {
            // (8a) contradiction inside the attestation
            ExperimentRecord e2 = skip_rec("E2", "baseline",
                                           att("cuda_unavailable", "cuda_unavailable", "not_available",
                                               "src", "prod", true));
            std::vector<ExperimentRecord> v = {e2, skip_rec("B4", "benchmark", good),
                                               skip_rec("B5", "benchmark", good)};
            std::string d;
            CHECK(!g3_cuda(v, false, d));
            CHECK(d.find("cuda_available=true") != std::string::npos);
            // (8b) contradiction with the record's own hardware snapshot
            ExperimentRecord e2b = skip_rec("E2", "baseline", good);
            e2b.hardware.set("cuda_available", JsonValue::boolean(true));
            std::vector<ExperimentRecord> v2 = {e2b, skip_rec("B4", "benchmark", good),
                                                skip_rec("B5", "benchmark", good)};
            std::string d2;
            CHECK(!g3_cuda(v2, false, d2));
            CHECK(d2.find("contradicts") != std::string::npos);
            // (8c) capability_state claiming CUDA available -> FAIL
            ExperimentRecord e2c = skip_rec("E2", "baseline",
                                            att("cuda_unavailable", "cuda_available", "not_available",
                                                "src", "prod", false));
            std::vector<ExperimentRecord> v3 = {e2c, skip_rec("B4", "benchmark", good),
                                                skip_rec("B5", "benchmark", good)};
            std::string d3;
            CHECK(!g3_cuda(v3, false, d3));
            CHECK(d3.find("capability_state") != std::string::npos);
        }
        // (9) GPU physically present + CUDA unavailable -> the FROZEN G3 rule
        //     applies (structured skip accepted; hardware.gpu_present=true does
        //     NOT flip the record to a CPU-only classification and does NOT fail
        //     G3 -- "missing-GPU must not fail the suite" is symmetric: a
        //     present GPU with an unavailable runtime is still an env skip).
        {
            ExperimentRecord e2 = skip_rec("E2", "baseline", good);
            e2.hardware.set("gpu_present", JsonValue::boolean(true));
            ExperimentRecord b4 = skip_rec("B4", "benchmark", good);
            b4.hardware.set("gpu_present", JsonValue::boolean(true));
            ExperimentRecord b5 = skip_rec("B5", "benchmark", good);
            b5.hardware.set("gpu_present", JsonValue::boolean(true));
            std::string d;
            CHECK(g3_cuda({e2, b4, b5}, false, d));
            // The same records under a CUDA-present runtime are NOT acceptable
            // as skips (they must be PASSED): the branch stays strict.
            std::string d2;
            CHECK(!g3_cuda({e2, b4, b5}, true, d2));
        }
        // (10) CUDA-present branch with skipped E2/B4/B5 -> FAIL.
        {
            std::vector<ExperimentRecord> v = {
                skip_rec("E2", "baseline", good), skip_rec("B4", "benchmark", good),
                skip_rec("B5", "benchmark", good)};
            std::string d;
            CHECK(!g3_cuda(v, true, d));
            CHECK(d.find("not PASSED") != std::string::npos);
        }
        // (11) CUDA-present branch with all required PASSED records -> PASS.
        {
            ExperimentRecord e2 = mk("E2", "E2", 1.0, "pass-e2");
            ExperimentRecord b4 = mk("B4", "B4", 1.0, "pass-b4");
            ExperimentRecord b5 = mk("B5", "B5", 1.0, "pass-b5");
            std::string d;
            CHECK(g3_cuda({e2, b4, b5}, true, d));
            CHECK(d.find("required PASSED") != std::string::npos);
        }
        // (12) Malformed capability metadata -> FAIL closed (never throws out).
        {
            // (12a) attestation present but not an object
            ExperimentRecord e2 = skip_rec("E2", "baseline", JsonValue::str("not-an-object"));
            std::vector<ExperimentRecord> v = {e2, skip_rec("B4", "benchmark", good),
                                               skip_rec("B5", "benchmark", good)};
            std::string d;
            bool threw = false;
            try { CHECK(!g3_cuda(v, false, d)); } catch (const std::exception&) { threw = true; }
            CHECK(!threw);
            // (12b) wrong field types (numbers where strings are required)
            JsonValue bad = JsonValue::object();
            bad.set("schema", JsonValue::str("STARKP1 skip-attestation 1"));
            bad.set("reason_code", JsonValue::integer(7));
            bad.set("capability_state", JsonValue::str("cuda_unavailable"));
            bad.set("execution_availability", JsonValue::str("not_available"));
            bad.set("capability_source", JsonValue::str("src"));
            bad.set("producer", JsonValue::str("prod"));
            bad.set("cuda_available", JsonValue::boolean(false));
            ExperimentRecord e2b = skip_rec("E2", "baseline", bad);
            std::vector<ExperimentRecord> v2 = {e2b, skip_rec("B4", "benchmark", good),
                                                skip_rec("B5", "benchmark", good)};
            std::string d2;
            CHECK(!g3_cuda(v2, false, d2));
            // (12c) missing cuda_available field
            JsonValue bad2 = JsonValue::object();
            bad2.set("schema", JsonValue::str("STARKP1 skip-attestation 1"));
            bad2.set("reason_code", JsonValue::str("cuda_unavailable"));
            bad2.set("capability_state", JsonValue::str("cuda_unavailable"));
            bad2.set("execution_availability", JsonValue::str("not_available"));
            bad2.set("capability_source", JsonValue::str("src"));
            bad2.set("producer", JsonValue::str("prod"));
            ExperimentRecord e2c = skip_rec("E2", "baseline", bad2);
            std::vector<ExperimentRecord> v3 = {e2c, skip_rec("B4", "benchmark", good),
                                                skip_rec("B5", "benchmark", good)};
            std::string d3;
            CHECK(!g3_cuda(v3, false, d3));
            CHECK(d3.find("cuda_available") != std::string::npos);
        }
        // (12d) a malformed attestation is also a malformed RECORD (validate())
        {
            ExperimentRecord r = skip_rec("E2", "baseline", JsonValue::str("nope"));
            CHECK(!r.validate().empty());
            ExperimentRecord ok = skip_rec("E2", "baseline", good);
            CHECK(ok.validate().empty());
        }
    }

    // =====================================================================
    // v2.3 §4: physical GPU detection (dedupe + real-vs-virtual classification).
    // Pure, deterministic classification -- NOT host-hardware dependent.
    // =====================================================================
    {
        auto A = [](const char* name, const char* id) {
            DisplayAdapterInfo a;
            a.name = name;
            a.device_id = id;
            return a;
        };

        // Physical NVIDIA adapter -> present == true.
        {
            auto r = HardwareProfiler::classifyDisplayAdapters(
                {A("NVIDIA GeForce RTX 2050", "PCI\\VEN_10DE&DEV_25A9&SUBSYS_8A1C103C&REV_A1")});
            CHECK(r.present.has_value() && *r.present == true);
            CHECK(r.physical.size() == 1);
        }
        // Intel integrated adapter -> present == true.
        {
            auto r = HardwareProfiler::classifyDisplayAdapters(
                {A("Intel(R) UHD Graphics", "PCI\\VEN_8086&DEV_46A3&SUBSYS_8A1C103C&REV_0C")});
            CHECK(r.present.has_value() && *r.present == true);
        }
        // Duplicate enumeration of ONE adapter -> deduped, still present, and the
        // count is NOT multiplied (the v2.2 over-count weakness).
        {
            const char* id = "PCI\\VEN_10DE&DEV_25A9&SUBSYS_8A1C103C&REV_A1";
            auto r = HardwareProfiler::classifyDisplayAdapters(
                {A("NVIDIA GeForce RTX 2050", id), A("NVIDIA GeForce RTX 2050", id),
                 A("NVIDIA GeForce RTX 2050", id), A("NVIDIA GeForce RTX 2050", id)});
            CHECK(r.raw_count == 4);
            CHECK(r.unique_count == 1);
            CHECK(r.physical.size() == 1);
            CHECK(r.present.has_value() && *r.present == true);
        }
        // Microsoft Basic Display Adapter only -> confirmed non-GPU -> false.
        {
            auto r = HardwareProfiler::classifyDisplayAdapters(
                {A("Microsoft Basic Display Adapter", "ROOT\\BASICDISPLAY\\0000")});
            CHECK(r.present.has_value() && *r.present == false);
            CHECK(r.virtual_adapters.size() == 1);
        }
        // Remote/virtual adapters only (Parsec / SpaceDesk) -> false (v2.2 bug:
        // these used to be accepted as real hardware).
        {
            auto r = HardwareProfiler::classifyDisplayAdapters(
                {A("Parsec Virtual Display Adapter", "ROOT\\PARSEC\\0000"),
                 A("SpaceDesk Display Adapter", "ROOT\\SPACEDESK\\0001")});
            CHECK(r.present.has_value() && *r.present == false);
        }
        // Unknown/unavailable enumeration -> Unknown (nullopt), NEVER CPU-only.
        {
            auto r = HardwareProfiler::classifyDisplayAdapters({});
            CHECK(!r.present.has_value());
            CHECK(r.reason.find("unavailable") != std::string::npos);
        }
        // Ambiguous adapter (no PCI id, no known vendor) -> Unknown, never false.
        {
            auto r = HardwareProfiler::classifyDisplayAdapters({A("Acme Display Thing", "")});
            CHECK(!r.present.has_value());
            CHECK(r.reason.find("unknown") != std::string::npos);
        }
        // Mixed physical + virtual -> physical wins (present == true).
        {
            auto r = HardwareProfiler::classifyDisplayAdapters(
                {A("Parsec Virtual Display Adapter", "ROOT\\PARSEC\\0000"),
                 A("Intel(R) UHD Graphics", "PCI\\VEN_8086&DEV_46A3&REV_0C")});
            CHECK(r.present.has_value() && *r.present == true);
            CHECK(r.virtual_adapters.size() == 1);
        }
        // PCI device id alone (unknown vendor name) is sufficient physical
        // evidence -> true.
        {
            auto r = HardwareProfiler::classifyDisplayAdapters(
                {A("Some Future GPU", "PCI\\VEN_1234&DEV_5678")});
            CHECK(r.present.has_value() && *r.present == true);
        }
        // Dedupe by name when no device id is available.
        {
            auto r = HardwareProfiler::classifyDisplayAdapters(
                {A("NVIDIA GeForce RTX 2050", ""), A("NVIDIA GeForce RTX 2050", "")});
            CHECK(r.raw_count == 2);
            CHECK(r.unique_count == 1);
        }
        // Determinism: identical input -> identical classification.
        {
            std::vector<DisplayAdapterInfo> in = {
                A("NVIDIA GeForce RTX 2050", "PCI\\VEN_10DE&DEV_25A9"),
                A("Microsoft Basic Display Adapter", "ROOT\\BASICDISPLAY\\0000")};
            auto r1 = HardwareProfiler::classifyDisplayAdapters(in);
            auto r2 = HardwareProfiler::classifyDisplayAdapters(in);
            CHECK(r1.present == r2.present);
            CHECK(r1.physical.size() == r2.physical.size());
            CHECK(r1.reason == r2.reason);
        }
    }

    return test::report();
}

