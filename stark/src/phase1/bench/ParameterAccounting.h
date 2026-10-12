#pragma once

/**
 * STARK Phase 1 (M0): ParameterAccounting (spec §C, rev 1.1)
 *
 * THE canonical accounting system. Every experimental model record carries all
 * fields; unknown => std::nullopt + reason, never silently zero (except
 * optimizer_bytes == 0, which is legitimate iff the optimizer genuinely has no
 * auxiliary state, e.g. plain SGD without momentum).
 *
 * Identities enforced by checkConsistency (gate G5):
 *   (1) logical_parameters >= active_parameters
 *   (2) total_peak_memory (component sum) =
 *         runtime_parameter_bytes + activation_bytes + kv_or_state_bytes
 *         + optimizer_bytes + temporary_workspace_bytes
 *       (measured total, when present, must agree within 10% or record is inconsistent)
 *   (3) stored_parameter_bytes =
 *         nominal_parameter_payload_bytes + packing_overhead_bytes      [EVERY record]
 *       logical_parameters * bytes_per_param == nominal_parameter_payload_bytes
 *       [REQUIRED only for uniform unquantized formats]
 *   (4) optimizer_bytes == 0 => optimizer_type/config genuinely stateless
 *
 * Quantized/packed formats (INT8, packed 4-bit, ternary, codebook): stored bytes
 * include scales/zero-points/codebooks/headers/padding, all captured in
 * packing_overhead_bytes.
 */

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "common/ExperimentRecord.h"

namespace stark_p1 {

// ---------------------------------------------------------------------------
// Precision / format helpers
// ---------------------------------------------------------------------------
enum class StorageFormat {
    FP32,        // uniform unquantized, 4 B/elem
    FP16,        // uniform unquantized, 2 B/elem
    BF16,        // uniform unquantized, 2 B/elem
    INT8,        // quantized: per-tensor/channel scales + zero-points
    INT4_PACKED, // packed 4-bit: two values/byte + scales + zero-points + headers
    TERNARY_PACKED, // reserved for later phases (2 bits/value + metadata)
    CODEBOOK,    // reserved: codebook index tables + codebook bytes
    MIXED,       // mixed precision: per-tensor table required
    CUSTOM       // anything else: must provide explicit per-tensor table
};

const char* storage_format_name(StorageFormat f);
StorageFormat storage_format_from(const std::string& name);

/// True when the format is uniform AND unquantized (exact logical*bytes_per_param identity).
bool is_uniform_unquantized(StorageFormat f);

/// Nominal bytes per parameter element for uniform formats; nullopt for packed/quantized.
std::optional<double> nominal_bytes_per_param(StorageFormat f);

// ---------------------------------------------------------------------------
// Optimizer accounting (rev 1.1)
// ---------------------------------------------------------------------------
enum class TrainingMode { TRAINING, INFERENCE };
const char* training_mode_name(TrainingMode m);
TrainingMode training_mode_from(const std::string& name);

enum class OptimizerType {
    NONE,        // inference record, no training context
    SGD_PLAIN,   // no momentum / no auxiliary state -> optimizer_bytes == 0 is VALID
    SGD_MOMENTUM,// one velocity buffer per trainable param
    ADAM,        // two state buffers per trainable param
    ADAMW,       // two state buffers per trainable param
    CUSTOM
};
const char* optimizer_type_name(OptimizerType t);
OptimizerType optimizer_type_from(const std::string& name);

/// Number of auxiliary state buffers per trainable parameter this optimizer type
/// genuinely requires. SGD_PLAIN -> 0. ADAM/ADAMW -> 2. SGD_MOMENTUM -> 1.
int auxiliary_state_buffers(OptimizerType t);

// ---------------------------------------------------------------------------
// ParameterAccounting
// ---------------------------------------------------------------------------
struct ParameterAccounting {
    // Counts (dimensionless integers)
    std::optional<uint64_t> logical_parameters;
    std::optional<uint64_t> active_parameters;

    // Optional MoE bookkeeping (canonical-definition implementations store these)
    std::optional<uint64_t> experts_total;
    std::optional<uint64_t> experts_active;

    // Bytes
    std::optional<uint64_t> stored_parameter_bytes;
    std::optional<uint64_t> nominal_parameter_payload_bytes;
    std::optional<uint64_t> packing_overhead_bytes;
    std::optional<uint64_t> runtime_parameter_bytes;
    std::optional<uint64_t> activation_bytes;
    std::optional<uint64_t> kv_or_state_bytes;
    std::optional<uint64_t> optimizer_bytes;
    std::optional<uint64_t> temporary_workspace_bytes;

    // Component sum (computed) vs measured peak (when B8 measured it directly)
    std::optional<uint64_t> total_peak_memory;          // component sum
    std::optional<uint64_t> total_peak_memory_measured; // measured process/device peak
    bool peak_memory_estimated = false;                 // true if activation/state modeled not measured
    bool inconsistent = false;                          // set by checkConsistency on >10% disagreement

    // Precision / format context
    StorageFormat storage_format = StorageFormat::FP32;
    // For MIXED/CUSTOM formats: per-tensor table {tensor_name -> (elements, bytes_per_element)}
    std::map<std::string, std::pair<uint64_t, double>> per_tensor_table;

    // Optimizer triple (rev 1.1)
    TrainingMode training_or_inference = TrainingMode::INFERENCE;
    OptimizerType optimizer_type = OptimizerType::NONE;
    std::optional<std::map<std::string, std::string>> optimizer_configuration;

    // Provenance for any nullopt field
    std::map<std::string, std::string> provenance;

    // --- helpers ---
    std::optional<uint64_t> component_sum() const;      // the five components, if all present
    JsonValue to_json() const;
    static ParameterAccounting from_json(const JsonValue& v);

    /// G5 consistency checker. Returns violations (empty = consistent).
    /// Sets `inconsistent` on >10% measured-vs-sum disagreement (non-const).
    std::vector<std::string> checkConsistency();
};

// ---------------------------------------------------------------------------
// Builders for canonical use cases (used by the model + tests)
// ---------------------------------------------------------------------------

/// Dense uniform-format accounting: e.g. TINY-DENSE-2L FP32/FP16.
/// logical == active for dense models. packing_overhead = header_bytes (documented).
ParameterAccounting dense_accounting(uint64_t logical_params, StorageFormat fmt,
                                     uint64_t file_header_bytes,
                                     uint64_t runtime_bytes, uint64_t activation_bytes,
                                     uint64_t kv_or_state_bytes,
                                     uint64_t workspace_bytes,
                                     TrainingMode mode, OptimizerType opt,
                                     const std::map<std::string, std::string>& opt_config);

/// Quantized-format accounting from an explicit storage layout:
///   stored_bytes:   actual on-disk size (payload + all metadata)
///   nominal_bytes:  elements * bits_per_value / 8 (pure payload, rounded up per tensor)
///   overhead = stored - nominal (must be >= 0)
ParameterAccounting quantized_accounting(uint64_t logical_params, uint64_t active_params,
                                         StorageFormat fmt,
                                         uint64_t stored_bytes, uint64_t nominal_payload_bytes,
                                         uint64_t runtime_bytes, uint64_t activation_bytes,
                                         uint64_t kv_or_state_bytes,
                                         uint64_t workspace_bytes);

/// MoE active-parameter counting per the canonical definition:
/// active = shared_params + experts_active * params_per_expert.
uint64_t moe_active_parameters(uint64_t shared_params, uint64_t params_per_expert,
                               uint64_t experts_active);

} // namespace stark_p1
