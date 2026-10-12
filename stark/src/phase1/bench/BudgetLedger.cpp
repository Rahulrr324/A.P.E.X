#include "bench/BudgetLedger.h"

#include <cmath>
#include <limits>
#include <stdexcept>

namespace stark_p1 {

namespace {

std::string u64s(uint64_t v) { return std::to_string(v); }
std::string ds(double v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.6f", v);
    return buf;
}

// Saturated headroom subtraction: budget * (1 - frac), clamped to >= 0, no overflow.
uint64_t effective_u64(uint64_t budget, double headroom) {
    double eff = static_cast<double>(budget) * (1.0 - headroom);
    if (eff <= 0.0) return 0;
    const double max_u64 = static_cast<double>(std::numeric_limits<uint64_t>::max());
    if (eff >= max_u64) return std::numeric_limits<uint64_t>::max();
    return static_cast<uint64_t>(eff);
}

double effective_d(double budget, double headroom) {
    double eff = budget * (1.0 - headroom);
    return eff > 0.0 ? eff : 0.0;
}

struct CmpResult {
    bool over;
    std::string requested;
    std::string eff;
    std::string margin;
};

CmpResult cmp_u64(uint64_t requested, uint64_t eff) {
    CmpResult r;
    r.over = requested > eff;
    r.requested = u64s(requested);
    r.eff = u64s(eff);
    r.margin = requested > eff ? u64s(requested - eff) : ("-" + u64s(eff - requested));
    return r;
}

} // namespace

// ---------------------------------------------------------------------------
// JSON codecs
// ---------------------------------------------------------------------------
static JsonValue opt_u64_json(const std::optional<uint64_t>& v) {
    return v.has_value() ? JsonValue::uinteger(*v) : JsonValue::null();
}
static JsonValue opt_d_json(const std::optional<double>& v) {
    return v.has_value() ? JsonValue::number(*v) : JsonValue::null();
}
static std::optional<uint64_t> json_opt_u64(const JsonValue& v) {
    return v.isNull() ? std::nullopt : std::optional<uint64_t>(v.asUInt());
}
static std::optional<double> json_opt_d(const JsonValue& v) {
    return v.isNull() ? std::nullopt : std::optional<double>(v.asDouble());
}

JsonValue BudgetLedger::to_json() const {
    JsonValue o = JsonValue::object();
    o.set("vram_budget_bytes", opt_u64_json(vram_budget_bytes));
    o.set("ram_budget_bytes", opt_u64_json(ram_budget_bytes));
    o.set("storage_budget_bytes", opt_u64_json(storage_budget_bytes));
    o.set("latency_target_ms", opt_d_json(latency_target_ms));
    o.set("cpu_compute_seconds", opt_d_json(cpu_compute_seconds));
    o.set("gpu_compute_seconds", opt_d_json(gpu_compute_seconds));
    o.set("estimated_flops", opt_u64_json(estimated_flops));
    o.set("training_budget_bytes_reporting", opt_u64_json(training_budget_bytes_reporting));
    o.set("inference_budget_bytes_reporting", opt_u64_json(inference_budget_bytes_reporting));
    o.set("safety_headroom_frac", JsonValue::number(safety_headroom_frac));
    return o;
}

BudgetLedger BudgetLedger::from_json(const JsonValue& o) {
    BudgetLedger l;
    l.vram_budget_bytes = json_opt_u64(o.get("vram_budget_bytes"));
    l.ram_budget_bytes = json_opt_u64(o.get("ram_budget_bytes"));
    l.storage_budget_bytes = json_opt_u64(o.get("storage_budget_bytes"));
    l.latency_target_ms = json_opt_d(o.get("latency_target_ms"));
    l.cpu_compute_seconds = json_opt_d(o.get("cpu_compute_seconds"));
    l.gpu_compute_seconds = json_opt_d(o.get("gpu_compute_seconds"));
    l.estimated_flops = json_opt_u64(o.get("estimated_flops"));
    l.training_budget_bytes_reporting = json_opt_u64(o.get("training_budget_bytes_reporting"));
    l.inference_budget_bytes_reporting = json_opt_u64(o.get("inference_budget_bytes_reporting"));
    l.safety_headroom_frac = o.get("safety_headroom_frac").asDouble();
    return l;
}

std::vector<std::string> BudgetLedger::validate() const {
    std::vector<std::string> errs;
    if (!(safety_headroom_frac >= 0.0 && safety_headroom_frac < 1.0))
        errs.push_back("safety_headroom_frac must be in [0,1)");
    auto check_nonneg_u64 = [&](const std::optional<uint64_t>& v, const char* name) {
        if (v.has_value() && *v == 0) errs.push_back(std::string(name) + " must be > 0 when set");
    };
    auto check_nonneg_d = [&](const std::optional<double>& v, const char* name) {
        if (v.has_value() && (!std::isfinite(*v) || *v <= 0.0))
            errs.push_back(std::string(name) + " must be finite and > 0 when set");
    };
    check_nonneg_u64(vram_budget_bytes, "vram_budget_bytes");
    check_nonneg_u64(ram_budget_bytes, "ram_budget_bytes");
    check_nonneg_u64(storage_budget_bytes, "storage_budget_bytes");
    check_nonneg_d(latency_target_ms, "latency_target_ms");
    check_nonneg_d(cpu_compute_seconds, "cpu_compute_seconds");
    check_nonneg_d(gpu_compute_seconds, "gpu_compute_seconds");
    check_nonneg_u64(estimated_flops, "estimated_flops");
    return errs;
}

JsonValue ResourceDemand::to_json() const {
    JsonValue o = JsonValue::object();
    o.set("peak_vram_bytes", opt_u64_json(peak_vram_bytes));
    o.set("peak_ram_bytes", opt_u64_json(peak_ram_bytes));
    o.set("storage_bytes", opt_u64_json(storage_bytes));
    o.set("latency_p95_ms", opt_d_json(latency_p95_ms));
    o.set("cpu_compute_seconds", opt_d_json(cpu_compute_seconds));
    o.set("gpu_compute_seconds", opt_d_json(gpu_compute_seconds));
    o.set("estimated_flops", opt_u64_json(estimated_flops));
    return o;
}

ResourceDemand ResourceDemand::from_json(const JsonValue& o) {
    ResourceDemand d;
    d.peak_vram_bytes = json_opt_u64(o.get("peak_vram_bytes"));
    d.peak_ram_bytes = json_opt_u64(o.get("peak_ram_bytes"));
    d.storage_bytes = json_opt_u64(o.get("storage_bytes"));
    d.latency_p95_ms = json_opt_d(o.get("latency_p95_ms"));
    d.cpu_compute_seconds = json_opt_d(o.get("cpu_compute_seconds"));
    d.gpu_compute_seconds = json_opt_d(o.get("gpu_compute_seconds"));
    d.estimated_flops = json_opt_u64(o.get("estimated_flops"));
    return d;
}

JsonValue Violation::to_json() const {
    JsonValue o = JsonValue::object();
    o.set("field", JsonValue::str(field));
    o.set("requested", JsonValue::str(requested));
    o.set("budget_after_headroom", JsonValue::str(budget_after_headroom));
    o.set("margin", JsonValue::str(margin));
    o.set("severity", JsonValue::str(severity == ViolationSeverity::ENFORCED ? "enforced" : "informational"));
    return o;
}

JsonValue BudgetEvaluation::to_json() const {
    JsonValue o = JsonValue::object();
    o.set("within_budget", JsonValue::boolean(within_budget));
    JsonValue vs = JsonValue::array();
    for (const auto& v : violations) vs.append(v.to_json());
    o.set("violations", std::move(vs));
    return o;
}

BudgetLedger default_ledger_from_hardware(uint64_t vram_total_bytes, uint64_t ram_total_bytes) {
    BudgetLedger l;
    // Spec default policy: VRAM = 80% of measured total; RAM = 60% of installed.
    l.vram_budget_bytes = static_cast<uint64_t>(static_cast<double>(vram_total_bytes) * 0.80);
    l.ram_budget_bytes = static_cast<uint64_t>(static_cast<double>(ram_total_bytes) * 0.60);
    l.safety_headroom_frac = 0.10;
    return l;
}

BudgetEvaluation evaluate(const ResourceDemand& demand, const BudgetLedger& ledger) {
    BudgetEvaluation out;
    out.within_budget = true;

    const double hr = ledger.safety_headroom_frac;

    auto enforce_u64 = [&](const std::optional<uint64_t>& requested,
                           const std::optional<uint64_t>& budget,
                           const char* field) {
        if (!requested.has_value() || !budget.has_value()) return;
        uint64_t eff = effective_u64(*budget, hr);
        CmpResult c = cmp_u64(*requested, eff);
        if (c.over) {
            Violation v;
            v.field = field;
            v.requested = c.requested;
            v.budget_after_headroom = c.eff;
            v.margin = c.margin;
            v.severity = ViolationSeverity::ENFORCED;
            out.violations.push_back(std::move(v));
        }
    };
    auto enforce_d = [&](const std::optional<double>& requested,
                         const std::optional<double>& budget,
                         const char* field) {
        if (!requested.has_value() || !budget.has_value()) return;
        double eff = effective_d(*budget, hr);
        if (*requested > eff) {
            Violation v;
            v.field = field;
            v.requested = ds(*requested);
            v.budget_after_headroom = ds(eff);
            v.margin = ds(*requested - eff);
            v.severity = ViolationSeverity::ENFORCED;
            out.violations.push_back(std::move(v));
        }
    };
    auto inform = [&](const std::optional<double>& requested,
                      const std::optional<double>& budget,
                      const char* field) {
        if (!requested.has_value() || !budget.has_value()) return;
        double eff = effective_d(*budget, hr);
        if (*requested > eff) {
            Violation v;
            v.field = field;
            v.requested = ds(*requested);
            v.budget_after_headroom = ds(eff);
            v.margin = ds(*requested - eff);
            v.severity = ViolationSeverity::INFORMATIONAL;
            out.violations.push_back(std::move(v));
        }
    };
    auto inform_u64 = [&](const std::optional<uint64_t>& requested,
                          const std::optional<uint64_t>& budget,
                          const char* field) {
        if (!requested.has_value() || !budget.has_value()) return;
        uint64_t eff = effective_u64(*budget, hr);
        CmpResult c = cmp_u64(*requested, eff);
        if (c.over) {
            Violation v;
            v.field = field;
            v.requested = c.requested;
            v.budget_after_headroom = c.eff;
            v.margin = c.margin;
            v.severity = ViolationSeverity::INFORMATIONAL;
            out.violations.push_back(std::move(v));
        }
    };

    // ---- Per-resource ENFORCED dimensions (independent; no combined pools) ----
    enforce_u64(demand.peak_vram_bytes, ledger.vram_budget_bytes, "peak_vram_bytes");
    enforce_u64(demand.peak_ram_bytes, ledger.ram_budget_bytes, "peak_ram_bytes");
    enforce_u64(demand.storage_bytes, ledger.storage_budget_bytes, "storage_bytes");
    enforce_d(demand.latency_p95_ms, ledger.latency_target_ms, "latency_p95_ms");

    // ---- INFORMATIONAL-ONLY compute dimensions (can never flip within_budget) ----
    inform(demand.cpu_compute_seconds, ledger.cpu_compute_seconds, "cpu_compute_seconds");
    inform(demand.gpu_compute_seconds, ledger.gpu_compute_seconds, "gpu_compute_seconds");
    inform_u64(demand.estimated_flops, ledger.estimated_flops, "estimated_flops");

    // ---- Reporting-only aggregates: deliberately NOT consulted ----
    // (ledger.training_budget_bytes_reporting / inference_budget_bytes_reporting unused)

    for (const auto& v : out.violations)
        if (v.severity == ViolationSeverity::ENFORCED) out.within_budget = false;

    return out;
}

} // namespace stark_p1
