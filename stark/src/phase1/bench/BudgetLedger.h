#pragma once

/**
 * STARK Phase 1 (M0): BudgetLedger (spec §D, rev 1.1)
 *
 * Pure budget evaluator — gate C5 applied at Phase-1 scale:
 *   - takes all state explicitly; queries NO live registry/health/quota/clock
 *   - same inputs -> same verdict (deterministic)
 *
 * Rev-1.1 semantics:
 *   - per-resource enforcement: peak_vram_bytes / peak_ram_bytes / storage_bytes
 *     each checked independently after headroom. A VRAM violation FAILS even if a
 *     combined RAM+VRAM total would appear to fit. No combined pool is ever enforced.
 *   - compute fields (cpu_compute_seconds, gpu_compute_seconds, estimated_flops) are
 *     INFORMATIONAL ONLY in Phase 1: they may emit violations with
 *     severity="informational" but can never make within_budget == false.
 *   - training/inference aggregate budgets are REPORTING-ONLY and never consulted
 *     by evaluate().
 *   - headroom: effective = budget * (1 - safety_headroom_frac); default 0.10; never 0.
 *   - latency: p95-based (latency_p95_ms vs latency_target_ms), enforceable.
 *
 * Overflow-safety: budget headroom subtraction uses saturation; a demand equal to
 * UINT64_MAX can never pass by wrap-around.
 */

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "common/ExperimentRecord.h"

namespace stark_p1 {

enum class ViolationSeverity { ENFORCED, INFORMATIONAL };

struct Violation {
    std::string field;            // "peak_vram_bytes", "peak_ram_bytes", "storage_bytes",
                                  // "latency_p95_ms", "cpu_compute_seconds",
                                  // "gpu_compute_seconds", "estimated_flops"
    std::string requested;        // human-readable value (string for JSON simplicity)
    std::string budget_after_headroom;
    std::string margin;           // requested - budget (signed text)
    ViolationSeverity severity = ViolationSeverity::ENFORCED;

    JsonValue to_json() const;
};

struct BudgetLedger {
    // Enforceable ceilings
    std::optional<uint64_t> vram_budget_bytes;
    std::optional<uint64_t> ram_budget_bytes;
    std::optional<uint64_t> storage_budget_bytes;
    std::optional<double> latency_target_ms;      // p95 target

    // Informational-only compute ceilings (Phase 1)
    std::optional<double> cpu_compute_seconds;
    std::optional<double> gpu_compute_seconds;
    std::optional<uint64_t> estimated_flops;

    // Reporting-only aggregates — NEVER enforced
    std::optional<uint64_t> training_budget_bytes_reporting;
    std::optional<uint64_t> inference_budget_bytes_reporting;

    double safety_headroom_frac = 0.10;           // default per spec; must be in [0,1)

    JsonValue to_json() const;
    static BudgetLedger from_json(const JsonValue& v);

    /// Structural validation: headroom in [0,1), negative fields rejected.
    std::vector<std::string> validate() const;
};

struct ResourceDemand {
    std::optional<uint64_t> peak_vram_bytes;
    std::optional<uint64_t> peak_ram_bytes;
    std::optional<uint64_t> storage_bytes;
    std::optional<double> latency_p95_ms;
    std::optional<double> cpu_compute_seconds;
    std::optional<double> gpu_compute_seconds;
    std::optional<uint64_t> estimated_flops;

    JsonValue to_json() const;
    static ResourceDemand from_json(const JsonValue& v);
};

struct BudgetEvaluation {
    bool within_budget = true;
    std::vector<Violation> violations;

    JsonValue to_json() const;
};

/// Default-policy ledger derived from measured hardware (pure function of inputs):
/// VRAM budget = 80% of measured vram_total; RAM budget = 60% of installed.
/// Returns nullopt fields when the hardware value is unavailable.
BudgetLedger default_ledger_from_hardware(uint64_t vram_total_bytes, uint64_t ram_total_bytes);

/// The pure evaluator. Same inputs -> identical verdict. Queries nothing live.
BudgetEvaluation evaluate(const ResourceDemand& demand, const BudgetLedger& ledger);

} // namespace stark_p1
