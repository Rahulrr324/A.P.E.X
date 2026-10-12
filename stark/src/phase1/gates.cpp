/**
 * STARK Phase 1 (M0): gate evaluation implementation (spec §G/J).
 *
 * See gates.h for the contract. This file is the single source of truth for
 * the M0 acceptance gates; the CLI and the tests both call evaluate_gates().
 */

#include "gates.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <set>
#include <utility>

#include "bench/BudgetLedger.h"
#include "bench/ParameterAccounting.h"
#include "common/ExperimentRecord.h"
#include "common/HardwareProfiler.h"

namespace stark_p1 {
namespace {

static const double G7_MEDIAN_TOLERANCE_PCT = 0.001; // 0.001% absolute tolerance for median comparison

std::string pct(double v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.2f%%", v);
    return buf;
}

/// Symmetric relative difference, expressed directly in percent:
///     abs(x1 - x2) / max(abs(x1), abs(x2)) * 100
/// Both zero  -> 0.0%   (identical)
/// Exactly one zero -> 100.0% (definitely out of tolerance)
/// Non-finite input -> nullopt (caller treats as failure; never a pass)
std::optional<double> symmetric_rel_diff_pct(double x, double y) {
    if (!std::isfinite(x) || !std::isfinite(y)) return std::nullopt;
    if (x == 0.0 && y == 0.0) return 0.0;
    if (x == 0.0 || y == 0.0) return 100.0;
    const double denom = std::max(std::fabs(x), std::fabs(y));
    if (denom == 0.0) return 0.0;  // unreachable (both-zero handled above)
    return std::fabs(x - y) / denom * 100.0;
}

/// Validate that all samples are numeric and finite. Returns error message if invalid, empty if OK.
std::string validate_samples(const std::vector<double>& samples) {
    if (samples.empty() || samples.size() < 10) {
        return "insufficient samples (has " + std::to_string(samples.size()) + ", need at least 10)";
    }
    for (size_t i = 0; i < samples.size(); ++i) {
        if (!std::isfinite(samples[i])) {
            return "non-finite sample at index " + std::to_string(i) + ": " + std::to_string(samples[i]);
        }
    }
    return "";
}

/// Recompute median from raw samples using the same convention as compute_statistics().
double recompute_median(std::vector<double> samples) {
    std::sort(samples.begin(), samples.end());
    auto n = samples.size();
    if (n == 0) return std::nan("");
    if (n == 1) return samples[0];
    double pos = 0.5 * static_cast<double>(n - 1);
    size_t lo = static_cast<size_t>(pos);
    size_t hi = std::min(lo + 1, n - 1);
    double frac = pos - static_cast<double>(lo);
    return samples[lo] + frac * (samples[hi] - samples[lo]);
}

/// Check if stored median matches recomputed median within tolerance.
/// Returns {pass, reason} where reason is empty on success.
std::pair<bool, std::string> verify_median_consistency(
    const std::vector<double>& samples, double stored_median, const std::string& bench_id)
{
    std::string err = validate_samples(samples);
    if (!err.empty()) {
        return {false, bench_id + ": " + err};
    }
    if (!std::isfinite(stored_median)) {
        return {false, bench_id + ": non-finite stored median (" + std::to_string(stored_median) + ")"};
    }
    double recomputed = recompute_median(samples);
    // Use relative tolerance compared to magnitude
    double abs_diff = std::fabs(stored_median - recomputed);
    double max_val = std::max(std::fabs(stored_median), std::fabs(recomputed));
    double rel_diff = (max_val > 0.0) ? (abs_diff / max_val) * 100.0 : 0.0;
    if (rel_diff > G7_MEDIAN_TOLERANCE_PCT) {
        return {false, bench_id + ": stored median mismatch: stored=" + std::to_string(stored_median) +
                       ", recomputed=" + std::to_string(recomputed) +
                       " (diff=" + std::to_string(rel_diff) + "%, allowed=" +
                       std::to_string(G7_MEDIAN_TOLERANCE_PCT) + "%)"};
    }
    return {true, ""};
}

/// Extract a numeric measurement from a JSON value, tolerating Int, UInt and
/// Double (the harness serializes a measured RAM peak as UInt). Non-numeric
/// types (including the {value:null,reason} unavailable object) return false.
bool numeric_measurement(const JsonValue& v, double& out) {
    switch (v.type()) {
        case JsonValue::Type::Int:    out = static_cast<double>(v.asInt());  return true;
        case JsonValue::Type::UInt:   out = static_cast<double>(v.asUInt()); return true;
        case JsonValue::Type::Double: out = v.asDouble();                    return true;
        default:                      return false;
    }
}

/// True only for a JSON boolean whose value is true.
bool is_true_bool(const JsonValue& v) {
    return v.type() == JsonValue::Type::Bool && v.asBool();
}

/// A non-empty JSON string.
bool is_nonempty_string(const JsonValue& v) {
    return v.type() == JsonValue::Type::String && !v.asString().empty();
}

/// Hardware device capability classification (fail-closed), rev 1.2.
///
/// The physical question ("does this machine have a GPU?") is SEPARATE from the
/// build question ("was this binary built with CUDA?"). `cuda_available == false`
/// means only that CUDA could not be queried in this build; it is NOT evidence
/// that the machine lacks a GPU. A CUDA-disabled build on a GPU host must never be
/// silently classified as CPU-only.
///
///   GPU      gpu_present == true (OS device inventory), OR cuda_available == true,
///            OR an authoritative GPU field (non-empty gpu_model / cuda_version,
///            or a positive vram_total_bytes)
///   CPU      gpu_present == false (the OS inventory explicitly reports NO real
///            display adapter, i.e. confirmed CPU-only hardware)
///   Unknown  no physical-presence evidence and no authoritative GPU field
///
/// Unknown MUST NOT be treated as CPU-only: absence of evidence is not evidence
/// that the hardware is CPU-only, so Unknown fails closed at every caller.
enum class Capability { GPU, CPU, Unknown };

Capability device_capability(const ExperimentRecord& r) {
    if (!r.hardware.isObject()) return Capability::Unknown;
    const JsonValue& hw = r.hardware;

    // 1. Authoritative PHYSICAL presence (OS device inventory, CUDA-build independent).
    //    Explicit false is the ONLY way to reach a confirmed CPU-only classification.
    if (hw.has("gpu_present")) {
        const JsonValue& gp = hw.get("gpu_present");
        if (gp.type() == JsonValue::Type::Bool) {
            return gp.asBool() ? Capability::GPU : Capability::CPU;
        }
        if (gp.isObject() && gp.has("value") &&
            gp.get("value").type() == JsonValue::Type::Bool) {
            return gp.get("value").asBool() ? Capability::GPU : Capability::CPU;
        }
        // malformed / null-valued gpu_present -> no physical evidence; continue
    }

    // 2. A positive CUDA runtime query implies a physical GPU.
    if (hw.has("cuda_available")) {
        const JsonValue& c = hw.get("cuda_available");
        if (c.type() == JsonValue::Type::Bool && c.asBool()) return Capability::GPU;
        // cuda_available == false (incl. "built without CUDA") is NOT proof of CPU-only.
    }

    // 3. Authoritative GPU fields.
    if (hw.has("gpu_model") && is_nonempty_string(hw.get("gpu_model")))
        return Capability::GPU;
    if (hw.has("cuda_version") && is_nonempty_string(hw.get("cuda_version")))
        return Capability::GPU;
    if (hw.has("vram_total_bytes")) {
        double v = 0.0;
        if (numeric_measurement(hw.get("vram_total_bytes"), v) && v > 0.0)
            return Capability::GPU;
    }
    return Capability::Unknown;
}

/// Benchmark id from the record configuration ("" when absent).
std::string benchmark_id_of(const ExperimentRecord& r) {
    if (!r.configuration.isObject()) return {};
    if (!r.configuration.has("benchmark_id")) return {};
    const JsonValue& b = r.configuration.get("benchmark_id");
    if (b.type() != JsonValue::Type::String) return {};
    return b.asString();
}

/// True for the §E baseline experiments E1..E5 (any record of such an
/// experiment is a "baseline record" for G4, whatever its `kind` says —
/// historical E1-B7 records carry kind=="benchmark" but are baseline runs).
bool is_baseline_experiment(const std::string& id) {
    return id == "E1" || id == "E2" || id == "E3" || id == "E4" || id == "E5";
}

/// Short label for a capability classification (used in informational G4 detail).
const char* capability_label(Capability c) {
    switch (c) {
        case Capability::GPU: return "gpu";
        case Capability::CPU: return "cpu";
        default:              return "unknown";
    }
}

/// Build the "latest record per experiment_id" view (by created_utc, tie broken
/// by record_id for determinism).
std::map<std::string, ExperimentRecord> latest_by_experiment(
    const std::vector<ExperimentRecord>& records) {
    std::map<std::string, ExperimentRecord> latest;
    for (const auto& r : records) {
        auto it = latest.find(r.experiment_id);
        if (it == latest.end()) {
            latest[r.experiment_id] = r;
        } else if (r.created_utc > it->second.created_utc ||
                   (r.created_utc == it->second.created_utc &&
                    r.record_id > it->second.record_id)) {
            latest[r.experiment_id] = r;
        }
    }
    return latest;
}

// ---------------------------------------------------------------------------
// G4 helper: validate the measured peak-memory block of one baseline record.
// Returns true when the block satisfies the frozen measured-memory contract.
//
// Frozen contract (V009 §G, G4): "Every baseline record's peak RAM/VRAM comes
// from process/device queries (B8), with measured: true; any estimated field is
// flagged and gate G4 fails if a *peak memory* field is estimated."
//
// v2.4 (Case B) corrections — the frozen text does NOT require measured VRAM on
// a GPU-capable host running a CUDA-less build:
//   * ground rule 1 + §A: a quantity that cannot be obtained is
//     {value:null, reason} — "else null + reason" is the SPEC's prescribed
//     representation for GPU fields without a CUDA runtime, not an estimate;
//   * E5 ("always") excludes CUDA by definition, so a literal "measured VRAM
//     for every baseline" reading is unsatisfiable for E5 on any build —
//     the spec cannot intend it;
//   * physical capability (gpu_present) is NOT a G4 criterion at all.
// What G4 still fails on (fail closed, integrity per the G3 provenance
// principle):
//   * RAM peak not measured (RAM is always obtainable via B8);
//   * a VRAM peak VALUE present while vram_measured=false → estimated → the
//     frozen G4 fail condition;
//   * vram_measured=true without a positive finite numeric value;
//   * a VRAM unavailability claim ({value:null, reason}) that is malformed,
//     empty-reasoned, uncorroborated (no embedded hardware.cuda_available
//     boolean) or contradicted (hardware.cuda_available=true).
// Free-form reason text alone is never sufficient evidence.
// ---------------------------------------------------------------------------
bool check_peak_memory(const ExperimentRecord& r, const std::string& id, std::string& err) {
    if (!r.peak_memory.isObject()) {
        err = id + ": peak_memory block missing or not an object";
        return false;
    }
    const JsonValue& pm = r.peak_memory;

    // --- RAM: must be a boolean true with a positive finite numeric peak ---
    if (!pm.has("ram_measured") || !pm.has("ram_peak_bytes")) {
        err = id + ": peak_memory missing ram_measured or ram_peak_bytes";
        return false;
    }
    const JsonValue& ram_m = pm.get("ram_measured");
    const JsonValue& ram_p = pm.get("ram_peak_bytes");
    if (ram_m.type() != JsonValue::Type::Bool) {
        err = id + ": ram_measured is not a boolean";
        return false;
    }
    if (!ram_m.asBool()) {
        err = id + ": ram_measured is false (RAM peak was not measured)";
        return false;
    }
    double ram_val = 0.0;
    if (!numeric_measurement(ram_p, ram_val)) {
        // Includes the {value:null,reason} unavailable object: an unavailable
        // RAM object can never satisfy a measured-RAM requirement.
        err = id + ": ram_measured=true but ram_peak_bytes is not a numeric measurement";
        return false;
    }
    if (!std::isfinite(ram_val) || ram_val <= 0.0) {
        err = id + ": ram_peak_bytes measured value is not positive/finite";
        return false;
    }

    // --- VRAM (v2.4, corrected to the frozen G4 text) ---
    if (!pm.has("vram_measured")) {
        err = id + ": peak_memory missing vram_measured";
        return false;
    }
    const JsonValue& vram_m = pm.get("vram_measured");
    if (vram_m.type() != JsonValue::Type::Bool) {
        err = id + ": vram_measured is not a boolean";
        return false;
    }
    const bool vram_measured = vram_m.asBool();

    if (vram_measured) {
        // A claimed measurement must stand on its own: positive, finite,
        // numeric. Null / unavailability objects / zero are never "measured".
        if (!pm.has("vram_peak_bytes")) {
            err = id + ": vram_measured=true but vram_peak_bytes missing";
            return false;
        }
        double vram_val = 0.0;
        if (!numeric_measurement(pm.get("vram_peak_bytes"), vram_val)) {
            err = id + ": vram_measured=true but vram_peak_bytes is not a numeric measurement";
            return false;
        }
        if (!std::isfinite(vram_val) || vram_val <= 0.0) {
            err = id + ": vram_measured=true but vram_peak_bytes is not positive/finite";
            return false;
        }
        return true;  // measured VRAM satisfies G4 regardless of capability state
    }

    // vram_measured == false: the record asserts VRAM was NOT measured.
    if (!pm.has("vram_peak_bytes")) {
        err = id + ": vram_measured=false but vram_peak_bytes missing (no structured unavailability)";
        return false;
    }
    const JsonValue& vram_p = pm.get("vram_peak_bytes");

    // FROZEN FAIL CONDITION: any peak value present while not flagged measured
    // is an estimated peak — top-level or nested inside an unavailability object.
    double maybe = 0.0;
    if (numeric_measurement(vram_p, maybe)) {
        err = id + ": peak VRAM value present while vram_measured=false "
                  "(estimated peak — forbidden by G4)";
        return false;
    }
    if (vram_p.isObject() && vram_p.has("value") &&
        numeric_measurement(vram_p.get("value"), maybe)) {
        err = id + ": nested VRAM value present while vram_measured=false "
                  "(estimated peak — forbidden by G4)";
        return false;
    }
    if (!vram_p.isObject()) {
        err = id + ": vram_peak_bytes is neither a numeric measurement nor "
                  "a structured unavailability object";
        return false;
    }
    if (!vram_p.has("value") || !vram_p.get("value").isNull()) {
        err = id + ": VRAM unavailability must carry a null value "
                  "(a non-null value with vram_measured=false is an unmeasured peak)";
        return false;
    }
    if (!vram_p.has("reason") || !is_nonempty_string(vram_p.get("reason"))) {
        err = id + ": VRAM unavailability has no non-empty reason";
        return false;
    }

    // Structured corroboration (G3 provenance principle, applied to VRAM
    // unavailability): the free-form reason alone is NOT evidence. The record's
    // own embedded capability snapshot must show the designated device query
    // (cudaMemGetInfo, §A/B8) was unavailable at run time.
    if (!r.hardware.isObject()) {
        err = id + ": VRAM unavailability not corroborated (no embedded hardware snapshot)";
        return false;
    }
    const JsonValue& hw = r.hardware;
    if (!hw.has("cuda_available") ||
        hw.get("cuda_available").type() != JsonValue::Type::Bool) {
        err = id + ": VRAM unavailability not corroborated by embedded capability "
                  "evidence (hardware.cuda_available missing/non-boolean; free text "
                  "alone is not evidence)";
        return false;
    }
    if (hw.get("cuda_available").asBool()) {
        err = id + ": VRAM unavailability contradicts hardware.cuda_available=true "
                  "(device query was available at run time)";
        return false;
    }
    return true;  // structured + corroborated unavailability satisfies G4
}

// ---------------------------------------------------------------------------
// G3 helper (v2.3): validate ONE no-CUDA skip attestation.
//
// A no-CUDA skip is accepted ONLY when the record carries a structured,
// provenance-bearing `skip_attestation` object that machine-verifiably asserts
// the execution-environment condition (CUDA unavailable) and is free of
// contradictions with the record's own embedded hardware snapshot. Free text
// in `status_reason` is NOT evidence. Anything missing, unrecognized, of the
// wrong type, or self-contradictory FAILS closed.
//
// Recognized (and only recognized) no-CUDA condition:
//   reason_code            == "cuda_unavailable"
//   capability_state       == "cuda_unavailable"
//   execution_availability == "not_available"
// plus non-empty capability_source and producer, and cuda_available == false.
// ---------------------------------------------------------------------------
bool validate_no_cuda_skip(const ExperimentRecord& r, const std::string& id, std::string& detail) {
    if (r.status != RunStatus::SKIPPED && r.status != RunStatus::NOT_ATTEMPTED) {
        detail = id + " present but not marked skipped (no CUDA available)";
        return false;
    }
    if (r.status_reason.empty()) {
        detail = id + " skipped without reason";
        return false;
    }
    if (!r.skip_attestation.isObject()) {
        detail = id + " skipped without structured skip attestation "
                      "(free-text status_reason alone is not evidence; fail closed)";
        return false;
    }
    const JsonValue& a = r.skip_attestation;
    auto str_field = [&](const char* k) -> std::optional<std::string> {
        if (!a.has(k)) return std::nullopt;
        const JsonValue& v = a.get(k);
        if (v.type() != JsonValue::Type::String) return std::nullopt;
        return v.asString();
    };

    const auto schema = str_field("schema");
    if (!schema || *schema != "STARKP1 skip-attestation 1") {
        detail = id + " skip attestation schema missing or unsupported";
        return false;
    }
    const auto code = str_field("reason_code");
    if (!code || *code != "cuda_unavailable") {
        detail = id + " skip attestation reason_code unrecognized "
                      "(expected 'cuda_unavailable')";
        return false;
    }
    const auto state = str_field("capability_state");
    if (!state || *state != "cuda_unavailable") {
        detail = id + " skip attestation capability_state is not 'cuda_unavailable' "
                      "(contradictory capability evidence)";
        return false;
    }
    const auto avail = str_field("execution_availability");
    if (!avail || *avail != "not_available") {
        detail = id + " skip attestation execution_availability is not 'not_available'";
        return false;
    }
    const auto src = str_field("capability_source");
    if (!src || src->empty()) {
        detail = id + " skip attestation capability_source absent (no provenance)";
        return false;
    }
    const auto prod = str_field("producer");
    if (!prod || prod->empty()) {
        detail = id + " skip attestation producer absent (no provenance)";
        return false;
    }
    if (!a.has("cuda_available") ||
        a.get("cuda_available").type() != JsonValue::Type::Bool) {
        detail = id + " skip attestation cuda_available missing or not a boolean";
        return false;
    }
    if (a.get("cuda_available").asBool()) {
        detail = id + " skip attestation contradicts itself: cuda_available=true "
                      "on a no-CUDA skip";
        return false;
    }
    // Cross-check against the record's own embedded hardware snapshot: a record
    // whose hardware claims CUDA was available cannot be an environment skip.
    if (r.hardware.isObject() && r.hardware.has("cuda_available")) {
        const JsonValue& hc = r.hardware.get("cuda_available");
        if (hc.type() == JsonValue::Type::Bool && hc.asBool()) {
            detail = id + " hardware.cuda_available=true contradicts a no-CUDA skip";
            return false;
        }
    }
    detail = id + ": SKIPPED (cuda_unavailable) — " + r.status_reason;
    return true;
}

}  // namespace

std::vector<GateReport> evaluate_gates_with_cuda(const std::vector<ExperimentRecord>& records,
                                                 bool cuda_available) {
    std::vector<GateReport> gates;
    const auto latest = latest_by_experiment(records);

    // ---- G1: hardware profile collected, provenance for nulls ----
    {
        GateReport g;
        g.gate = "G1 hardware profile collected";
        auto it = latest.find("PROFILE");
        if (it == latest.end()) {
            g.detail = "no PROFILE record found (run profiler_cli)";
        } else {
            const ExperimentRecord& hw_rec = it->second;
            bool pass = hw_rec.status == RunStatus::PASSED && !hw_rec.hardware.isNull();
            std::string detail;
            if (pass) {
                // Fail closed on malformed hardware evidence: a PROFILE record
                // that survives ExperimentRecord::validate() but whose hardware
                // block cannot be decoded must FAIL G1 with a reason, never
                // throw out of evaluate_gates (aborting the aggregator).
                try {
                    StaticHardwareProfile hw = StaticHardwareProfile::from_json(hw_rec.hardware);
                    auto errs = hw.validate();
                    pass = errs.empty();
                    detail = errs.empty()
                                 ? "cpu=" + hw.cpu_model +
                                       ", ram_total=" + std::to_string(hw.ram_total_bytes.value_or(0))
                                 : errs[0];
                } catch (const std::exception& ex) {
                    pass = false;
                    detail = std::string("malformed PROFILE hardware snapshot: ") + ex.what();
                }
            } else {
                detail = hw_rec.status_reason;
            }
            g.pass = pass;
            g.detail = detail;
        }
        gates.push_back(g);
    }

    // ---- G2: CPU baselines present and complete (both E1 and E5, >=10 samples) ----
    {
        GateReport g;
        g.gate = "G2 CPU baselines present and complete";
        bool pass = false;
        std::string detail;

        auto e1_it = latest.find("E1");
        auto e5_it = latest.find("E5");
        const bool e1_present = e1_it != latest.end();
        const bool e5_present = e5_it != latest.end();
        const bool e1_ok = e1_present && e1_it->second.status == RunStatus::PASSED;
        const bool e5_ok = e5_present && e5_it->second.status == RunStatus::PASSED;

        if (!e1_present) {
            detail = "E1 baseline record missing (run run_baseline --baseline E1)";
        } else if (!e5_present) {
            detail = "E5 baseline record missing (required independent repeat)";
        } else if (!e1_ok) {
            detail = "E1 baseline not PASSED";
        } else if (!e5_ok) {
            detail = "E5 baseline not PASSED";
        } else if (e1_it->second.record_id == e5_it->second.record_id) {
            detail = "E1 and E5 resolve to the same record_id (duplicate-only evidence)";
        } else {
            const ExperimentRecord& e1 = e1_it->second;
            const ExperimentRecord& e5 = e5_it->second;
            const size_t n1 = e1.statistics.has_value() ? e1.statistics->samples.size() : 0;
            const size_t n5 = e5.statistics.has_value() ? e5.statistics->samples.size() : 0;
            if (n1 < 10) {
                detail = "E1 baseline has <10 samples (has " + std::to_string(n1) + ")";
            } else if (n5 < 10) {
                detail = "E5 baseline has <10 samples (has " + std::to_string(n5) + ")";
            } else {
                pass = true;
                detail = "E1 and E5 present, distinct, each with >=10 samples";
            }
        }
        g.pass = pass;
        g.detail = detail;
        gates.push_back(g);
    }

    // ---- G3: GPU branch — records exist and complete OR explicitly skipped ----
    {
        GateReport g;
        g.gate = "G3 GPU branch complete-or-skipped with reason";
        bool pass = true;
        std::string detail;
        if (cuda_available) {
            // STRICT branch (unchanged): E2/B4/B5 must be present AND PASSED.
            // A SKIPPED record can never satisfy the CUDA-present branch.
            detail = "CUDA present: E2/B4/B5 records required PASSED";
            for (const char* id : {"E2", "B4", "B5"}) {
                auto it = latest.find(id);
                if (it == latest.end() || it->second.status != RunStatus::PASSED) {
                    pass = false;
                    detail = std::string(id) + " missing or not PASSED (CUDA available)";
                    break;
                }
            }
        } else {
            // No-CUDA branch (v2.3): each of E2/B4/B5 must exist as an explicit
            // environment skip carrying a STRUCTURED, provenance-bearing
            // attestation. Free-text status_reason alone no longer suffices.
            detail.clear();
            for (const char* id : {"E2", "B4", "B5"}) {
                auto it = latest.find(id);
                if (it == latest.end()) {
                    detail = std::string(id) + " record missing entirely (must record skipped status)";
                    pass = false;
                    break;
                }
                std::string why;
                if (!validate_no_cuda_skip(it->second, id, why)) {
                    detail = why;
                    pass = false;
                    break;
                }
                detail = why;  // last validated id's detail
            }
            if (pass && detail.empty()) detail = "no CUDA; structured skip records required";
        }
        g.pass = pass;
        g.detail = detail;
        gates.push_back(g);
    }

    // ---- G4: baselines present + measured peak memory (frozen text) ----
    //
    // v2.4 (Case B): the frozen G4 rule (V009 §G) requires peak RAM/VRAM
    // evidence to come from process/device queries with measured:true and
    // fails ONLY when a peak memory field is estimated (or the evidence is
    // missing/malformed/self-contradictory). Two stricter interpretations that
    // v2.1–v2.3 layered on top of the frozen text are REMOVED:
    //   * "GPU-capable host requires measured VRAM" — not in the frozen text;
    //     §A prescribes null+reason for GPU fields on a CUDA-less build;
    //   * "capability Unknown fails closed at G4" — physical capability is not
    //     a G4 input at all (gpu_present is not mentioned by frozen G4).
    // E1/E5 presence + PASSED is unchanged (rev 1.4 contract; §E baselines are
    // "always" required). EVERY PASSED baseline record's peak block is now
    // validated ("Every baseline record's peak RAM/VRAM ..."), not just the
    // latest E1/E5. Physical capability is computed but informational only.
    {
        GateReport g;
        g.gate = "G4 peak memory measured";
        bool pass = true;
        std::string detail;
        const ExperimentRecord* e1_rec = nullptr;
        const ExperimentRecord* e5_rec = nullptr;

        for (const char* id : {"E1", "E5"}) {
            auto it = latest.find(id);
            if (it == latest.end()) {
                pass = false;
                detail = std::string(id) + ": baseline record missing (G4 requires both E1 and E5)";
                continue;
            }
            const ExperimentRecord& r = it->second;
            if (std::string(id) == "E1") e1_rec = &r;
            else                          e5_rec = &r;
            if (r.status != RunStatus::PASSED) {
                pass = false;
                detail = std::string(id) + ": baseline not PASSED (G4 requires a measured baseline)";
                continue;
            }
        }

        // Validate the measured peak-memory block of EVERY PASSED baseline
        // record (E1..E5 experiments or kind=="baseline"), not only the latest
        // E1/E5: the frozen text says "Every baseline record". Non-PASSED
        // records (skipped/failed/not-attempted) carry no measurement
        // obligation — a failed measurement is recorded via `failures`.
        if (pass) {
            for (const auto& r : records) {
                if (r.status != RunStatus::PASSED) continue;
                if (r.kind != "baseline" && !is_baseline_experiment(r.experiment_id)) continue;
                std::string err;
                if (!check_peak_memory(r, r.experiment_id + "/" + r.record_id, err)) {
                    pass = false;
                    detail = err;  // first failure wins (deterministic order)
                    break;
                }
            }
        }

        if (pass && e1_rec && e5_rec) {
            detail = "E1 and E5 present, PASSED; every PASSED baseline: RAM peak measured; "
                     "VRAM measured or structured unavailability corroborated by embedded "
                     "capability evidence (physical capability " +
                     std::string(capability_label(device_capability(*e1_rec))) + "/" +
                     capability_label(device_capability(*e5_rec)) +
                     " — informational, not a G4 criterion)";
        }
        g.pass = pass;
        g.detail = detail;
        gates.push_back(g);
    }

    // ---- G5: accounting consistency ----
    {
        GateReport g;
        g.gate = "G5 parameter accounting consistent";
        bool pass = true;
        bool any = false;
        std::string detail;
        for (const auto& r : records) {
            if (r.accounting.isNull() || !r.accounting.isObject()) continue;
            any = true;
            // Fail closed on malformed accounting evidence: undecodable blocks
            // FAIL G5 with a reason instead of throwing out of evaluate_gates.
            try {
                ParameterAccounting acct = ParameterAccounting::from_json(r.accounting);
                const auto errs = acct.checkConsistency();
                if (!errs.empty()) {
                    pass = false;
                    detail = std::string(r.experiment_id) + ": " + errs[0];
                    break;
                }
            } catch (const std::exception& ex) {
                pass = false;
                detail = std::string(r.experiment_id) +
                         ": malformed accounting block: " + ex.what();
                break;
            }
        }
        if (!any) {
            pass = false;
            detail = "no accounting records found";
        } else if (pass) {
            detail = "all accounting records pass G5 checks";
        }
        g.pass = pass;
        g.detail = detail;
        gates.push_back(g);
    }

    // ---- G6: BudgetLedger rejects over-budget (synthetic self-test) ----
    {
        GateReport g;
        g.gate = "G6 budget evaluator rejects over-budget demands";
        BudgetLedger ledger;
        ledger.vram_budget_bytes = 1000;
        ledger.ram_budget_bytes = 10000;
        ledger.storage_budget_bytes = 100000;
        ledger.safety_headroom_frac = 0.10;
        ResourceDemand d;
        d.peak_vram_bytes = 901;      // 90% of 1000 > 900 effective -> VIOLATION
        d.peak_ram_bytes = 5000;      // within
        d.storage_bytes = 50000;      // within
        d.cpu_compute_seconds = 999.0;  // informational only
        auto ev = evaluate(d, ledger);
        bool pass = !ev.within_budget;
        std::string detail;
        if (pass) {
            bool vram_hit = false, no_flip_from_compute = true;
            for (const auto& v : ev.violations) {
                if (v.field == "peak_vram_bytes" && v.severity == ViolationSeverity::ENFORCED)
                    vram_hit = true;
                if (v.field == "cpu_compute_seconds" && v.severity != ViolationSeverity::INFORMATIONAL)
                    no_flip_from_compute = false;
            }
            pass = vram_hit && no_flip_from_compute;
            detail = "VRAM-only violation detected; compute fields informational";
        } else {
            detail = "over-budget demand accepted (BUG)";
        }
        auto ev2 = evaluate(d, ledger);
        if (pass && ev2.within_budget != ev.within_budget) {
            pass = false;
            detail = "evaluate() not deterministic across identical calls";
        }
        g.pass = pass;
        g.detail = detail;
        gates.push_back(g);
    }

    // ---- G7: same-config median reproducibility across independent repeats ----
    //
    // Grouping is by CONFIGURATION (the serialized configuration block), not by
    // experiment id: E1 and E5 are independent executions of the same
    // configuration, and two records that merely share an experiment id are not
    // assumed independent. Independence within a group is established by
    // distinct record_id (an exact duplicate is the same execution, not a
    // repeat).
    //
    // Every independent repeat must agree with every OTHER repeat in its group
    // (all-pairs max-spread test), NOT merely adjacent entries: 100/90/80 has
    // adjacent differences of 10% and 11.11% but endpoints 20% apart and must
    // FAIL.
    //
    // V1.6补充: Each PASSED record's raw samples must pass validation:
    // - At least 10 samples
    // - All samples are numeric and finite
    // - The stored median must match the recomputed median within tolerance
    // - Records that fail validation are rejected, not corrected
    //
    // The overall result starts PASS and is only ever assigned false; a later
    // passing group can never overwrite an earlier failure, and diagnostics
    // accumulate.
    {
        GateReport g;
        g.gate = "G7 same-config medians reproducible across repeats";
        bool overall_pass = true;
        std::string detail;
        bool any_group = false;

        struct RunSample {
            std::string record_id;
            double median = 0.0;
            bool median_valid = false;
            std::string median_error;
        };
        std::map<std::string, std::vector<RunSample>> groups;  // config key -> runs
        std::map<std::string, std::string> group_bench;        // config key -> benchmark id

        for (const auto& r : records) {
            if (r.status != RunStatus::PASSED) continue;
            // Only actual measurement records form benchmark groups. Profiler /
            // telemetry records may carry an informational configuration block
            // (e.g. TELEMETRY has benchmark_id="TELEMETRY") and must never be
            // treated as benchmark evidence.
            if (r.kind != "benchmark" && r.kind != "baseline") continue;
            const std::string bench = benchmark_id_of(r);
            if (bench.empty()) continue;  // not a benchmark-group member

            // Evidence must be present, computed, sufficient and finite.
            // A PASSED benchmark record that lacks usable evidence FAILS G7
            // (it is never silently dropped from its group).
            if (!r.statistics.has_value()) {
                overall_pass = false;
                detail += bench + ": PASSED benchmark record without statistics\n";
                continue;
            }
            const Statistics& st = *r.statistics;
            if (!st.computed) {
                overall_pass = false;
                detail += bench + ": statistics not computed\n";
                continue;
            }
            // V1.6: Median consistency validation - independently verify stored median
            auto median_result = verify_median_consistency(st.samples, st.median, bench);
            const bool median_pass = median_result.first;
            const std::string& median_err = median_result.second;
            if (!median_pass) {
                overall_pass = false;
                detail += median_err + "\n";
                // Record the invalid median so it doesn't participate in comparisons
                const std::string key = r.configuration.dump();
                groups[key].push_back(RunSample{r.record_id, st.median, false, median_err});
                group_bench[key] = bench;
                continue;
            }
            // Final check for minimum samples (after validation passed)
            if (st.samples.size() < 10) {
                overall_pass = false;
                detail += bench + ": insufficient sample evidence (" +
                          std::to_string(st.samples.size()) + " < 10)\n";
                continue;
            }
            const std::string key = r.configuration.dump();
            groups[key].push_back(RunSample{r.record_id, st.median, true, ""});
            group_bench[key] = bench;
        }

        for (auto& [key, runs] : groups) {
            any_group = true;
            // Deduplicate by record_id: two records sharing a record_id are the
            // same execution and do not constitute an independent repeat.
            std::vector<RunSample> unique;
            std::set<std::string> seen;
            for (const auto& rs : runs) {
                if (seen.insert(rs.record_id).second) unique.push_back(rs);
            }
            const std::string bench = group_bench[key];
            // Filter to only valid median entries for the all-pairs comparison
            std::vector<RunSample> valid_runs;
            for (const auto& rs : unique) {
                if (rs.median_valid) valid_runs.push_back(rs);
                else {
                    overall_pass = false;
                    detail += bench + ": record " + rs.record_id +
                              " rejected: " + rs.median_error + "\n";
                }
            }
            if (valid_runs.size() < 2) {
                overall_pass = false;
                detail += "missing independent repeat for " + bench +
                          " (only " + std::to_string(valid_runs.size()) +
                          " valid median execution(s)); insufficient evidence\n";
                continue;
            }
            const bool bandwidth = (bench == "B3" || bench == "B5");
            const double allowed = bandwidth ? 20.0 : 15.0;
            // All-pairs: EVERY repeat must agree with EVERY other repeat.
            for (size_t i = 0; i < valid_runs.size(); ++i) {
                for (size_t j = i + 1; j < valid_runs.size(); ++j) {
                    auto d = symmetric_rel_diff_pct(valid_runs[i].median, valid_runs[j].median);
                    if (!d.has_value()) {
                        overall_pass = false;
                        detail += bench + ": non-finite median between runs " +
                                  std::to_string(i + 1) + " and " + std::to_string(j + 1) + "\n";
                        continue;
                    }
                    if (*d > allowed) {
                        overall_pass = false;
                        detail += bench + " medians differ " + pct(*d) + " (allowed " +
                                  pct(allowed) + ") between runs " + std::to_string(i + 1) +
                                  " and " + std::to_string(j + 1) + "\n";
                    }
                }
            }
        }

        if (!any_group) {
            overall_pass = false;
            detail += "no same-configuration benchmark groups found "
                      "(G7 requires an independent repeat; single runs do not qualify)\n";
        } else if (overall_pass) {
            detail = "all repeats within every same-configuration group agree pairwise "
                     "within tolerance (timing 15% / bandwidth 20%)";
        }
        g.pass = overall_pass;
        g.detail = detail;
        gates.push_back(g);
    }

    return gates;
}

std::vector<GateReport> evaluate_gates(const std::vector<ExperimentRecord>& records) {
    // Production entry point: probe the real CUDA runtime availability once and
    // evaluate every gate. Tests use evaluate_gates_with_cuda() to exercise both
    // G3 branches deterministically; production behaviour is unchanged.
    return evaluate_gates_with_cuda(records, HardwareProfiler::cudaRuntimeAvailable());
}

bool all_gates_pass(const std::vector<GateReport>& gates) {
    for (const auto& g : gates)
        if (!g.pass) return false;
    return true;
}

}  // namespace stark_p1
