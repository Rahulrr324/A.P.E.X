#include "bench/ParameterAccounting.h"

#include <cmath>
#include <stdexcept>

namespace stark_p1 {

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
const char* storage_format_name(StorageFormat f) {
    switch (f) {
        case StorageFormat::FP32: return "FP32";
        case StorageFormat::FP16: return "FP16";
        case StorageFormat::BF16: return "BF16";
        case StorageFormat::INT8: return "INT8";
        case StorageFormat::INT4_PACKED: return "INT4_PACKED";
        case StorageFormat::TERNARY_PACKED: return "TERNARY_PACKED";
        case StorageFormat::CODEBOOK: return "CODEBOOK";
        case StorageFormat::MIXED: return "MIXED";
        case StorageFormat::CUSTOM: return "CUSTOM";
    }
    return "UNKNOWN";
}

StorageFormat storage_format_from(const std::string& name) {
    if (name == "FP32") return StorageFormat::FP32;
    if (name == "FP16") return StorageFormat::FP16;
    if (name == "BF16") return StorageFormat::BF16;
    if (name == "INT8") return StorageFormat::INT8;
    if (name == "INT4_PACKED") return StorageFormat::INT4_PACKED;
    if (name == "TERNARY_PACKED") return StorageFormat::TERNARY_PACKED;
    if (name == "CODEBOOK") return StorageFormat::CODEBOOK;
    if (name == "MIXED") return StorageFormat::MIXED;
    if (name == "CUSTOM") return StorageFormat::CUSTOM;
    throw std::runtime_error("unknown storage format: " + name);
}

bool is_uniform_unquantized(StorageFormat f) {
    switch (f) {
        case StorageFormat::FP32:
        case StorageFormat::FP16:
        case StorageFormat::BF16:
            return true;
        default:
            return false;
    }
}

std::optional<double> nominal_bytes_per_param(StorageFormat f) {
    switch (f) {
        case StorageFormat::FP32: return 4.0;
        case StorageFormat::FP16: return 2.0;
        case StorageFormat::BF16: return 2.0;
        case StorageFormat::INT8: return 1.0;   // payload only; metadata is overhead
        default: return std::nullopt;           // packed/ternary/codebook/mixed: per-tensor table
    }
}

// ---------------------------------------------------------------------------
// Optimizer helpers
// ---------------------------------------------------------------------------
const char* training_mode_name(TrainingMode m) {
    return m == TrainingMode::TRAINING ? "TRAINING" : "INFERENCE";
}
TrainingMode training_mode_from(const std::string& name) {
    if (name == "TRAINING") return TrainingMode::TRAINING;
    if (name == "INFERENCE") return TrainingMode::INFERENCE;
    throw std::runtime_error("unknown training mode: " + name);
}

const char* optimizer_type_name(OptimizerType t) {
    switch (t) {
        case OptimizerType::NONE: return "none";
        case OptimizerType::SGD_PLAIN: return "sgd_plain";
        case OptimizerType::SGD_MOMENTUM: return "sgd_momentum";
        case OptimizerType::ADAM: return "adam";
        case OptimizerType::ADAMW: return "adamw";
        case OptimizerType::CUSTOM: return "custom";
    }
    return "unknown";
}

OptimizerType optimizer_type_from(const std::string& name) {
    if (name == "none") return OptimizerType::NONE;
    if (name == "sgd_plain") return OptimizerType::SGD_PLAIN;
    if (name == "sgd_momentum") return OptimizerType::SGD_MOMENTUM;
    if (name == "adam") return OptimizerType::ADAM;
    if (name == "adamw") return OptimizerType::ADAMW;
    if (name == "custom") return OptimizerType::CUSTOM;
    throw std::runtime_error("unknown optimizer type: " + name);
}

int auxiliary_state_buffers(OptimizerType t) {
    switch (t) {
        case OptimizerType::NONE: return 0;
        case OptimizerType::SGD_PLAIN: return 0;      // genuinely stateless
        case OptimizerType::SGD_MOMENTUM: return 1;
        case OptimizerType::ADAM: return 2;
        case OptimizerType::ADAMW: return 2;
        case OptimizerType::CUSTOM: return -1;        // unknown: must be measured/declared
    }
    return -1;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------
static JsonValue field_json(const std::optional<uint64_t>& v, const char* key,
                            const std::map<std::string, std::string>& prov) {
    if (v.has_value()) return JsonValue::uinteger(*v);
    JsonValue o = JsonValue::object();
    o.set("value", JsonValue::null());
    auto it = prov.find(key);
    o.set("reason", JsonValue::str(it != prov.end() ? it->second : "unavailable: no reason recorded"));
    return o;
}
static std::optional<uint64_t> field_from(const JsonValue& v) {
    if (v.isNull()) return std::nullopt;
    if (v.isObject()) {
        if (v.has("value") && !v.get("value").isNull()) return v.get("value").asUInt();
        return std::nullopt;
    }
    return v.asUInt();
}
static JsonValue prov_json(const std::map<std::string, std::string>& prov) {
    JsonValue o = JsonValue::object();
    for (const auto& [k, s] : prov) o.set(k, JsonValue::str(s));
    return o;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
ParameterAccounting dense_accounting(uint64_t logical_params, StorageFormat fmt,
                                     uint64_t file_header_bytes,
                                     uint64_t runtime_bytes, uint64_t activation_bytes,
                                     uint64_t kv_or_state_bytes,
                                     uint64_t workspace_bytes,
                                     TrainingMode mode, OptimizerType opt,
                                     const std::map<std::string, std::string>& opt_config) {
    ParameterAccounting a;
    a.logical_parameters = logical_params;
    a.active_parameters = logical_params;  // dense: active == logical (canonical definition)
    a.storage_format = fmt;

    double bpp = nominal_bytes_per_param(fmt).value();
    // Guard overflow: logical_params * bpp may exceed uint64 in pathological cases
    long double nominal = static_cast<long double>(logical_params) * bpp;
    if (nominal > 1.8e19) throw std::runtime_error("nominal payload overflows uint64");
    uint64_t nominal_bytes = static_cast<uint64_t>(nominal);
    a.nominal_parameter_payload_bytes = nominal_bytes;
    a.packing_overhead_bytes = file_header_bytes;
    a.stored_parameter_bytes = nominal_bytes + file_header_bytes;

    a.runtime_parameter_bytes = runtime_bytes;
    a.activation_bytes = activation_bytes;
    a.kv_or_state_bytes = kv_or_state_bytes;
    a.temporary_workspace_bytes = workspace_bytes;

    a.training_or_inference = mode;
    a.optimizer_type = opt;
    int buffers = auxiliary_state_buffers(opt);
    if (buffers == 0) {
        a.optimizer_bytes = 0;  // genuine zero (e.g. sgd_plain), or NONE for inference
        a.optimizer_configuration = mode == TrainingMode::TRAINING && opt == OptimizerType::SGD_PLAIN
                                        ? std::optional<std::map<std::string, std::string>>(opt_config)
                                        : std::nullopt;
    } else if (buffers > 0) {
        // optimizer state bytes = buffers * trainable_params * 4 (FP32 state assumption is
        // NOT fabricated here — it is declared in the configuration map when used)
        auto it = opt_config.find("state_bytes_per_param");
        if (it != opt_config.end()) {
            uint64_t per = std::stoull(it->second);
            a.optimizer_bytes = buffers * logical_params * per;
            a.optimizer_configuration = opt_config;
        } else {
            a.provenance["optimizer_bytes"] =
                "unavailable: optimizer_configuration.state_bytes_per_param not declared";
        }
    } else {
        a.provenance["optimizer_bytes"] = "unavailable: custom optimizer state size not declared";
    }

    // Component sum (always set when all five components are known — they are here)
    a.total_peak_memory = a.component_sum();
    return a;
}

ParameterAccounting quantized_accounting(uint64_t logical_params, uint64_t active_params,
                                         StorageFormat fmt,
                                         uint64_t stored_bytes, uint64_t nominal_payload_bytes,
                                         uint64_t runtime_bytes, uint64_t activation_bytes,
                                         uint64_t kv_or_state_bytes,
                                         uint64_t workspace_bytes) {
    if (stored_bytes < nominal_payload_bytes)
        throw std::runtime_error("stored bytes < nominal payload: invalid quantized layout");
    ParameterAccounting a;
    a.logical_parameters = logical_params;
    a.active_parameters = active_params;
    a.storage_format = fmt;
    a.stored_parameter_bytes = stored_bytes;
    a.nominal_parameter_payload_bytes = nominal_payload_bytes;
    a.packing_overhead_bytes = stored_bytes - nominal_payload_bytes;
    a.runtime_parameter_bytes = runtime_bytes;
    a.activation_bytes = activation_bytes;
    a.kv_or_state_bytes = kv_or_state_bytes;
    a.temporary_workspace_bytes = workspace_bytes;
    a.training_or_inference = TrainingMode::INFERENCE;
    a.optimizer_type = OptimizerType::NONE;
    a.optimizer_bytes = 0;
    a.total_peak_memory = a.component_sum();
    return a;
}

uint64_t moe_active_parameters(uint64_t shared_params, uint64_t params_per_expert,
                               uint64_t experts_active) {
    return shared_params + experts_active * params_per_expert;
}

// ---------------------------------------------------------------------------
// Component sum + consistency (gate G5)
// ---------------------------------------------------------------------------
std::optional<uint64_t> ParameterAccounting::component_sum() const {
    if (!runtime_parameter_bytes.has_value() || !activation_bytes.has_value() ||
        !kv_or_state_bytes.has_value() || !optimizer_bytes.has_value() ||
        !temporary_workspace_bytes.has_value())
        return std::nullopt;
    // Overflow-safe sum
    long double s = 0;
    s += static_cast<long double>(*runtime_parameter_bytes);
    s += static_cast<long double>(*activation_bytes);
    s += static_cast<long double>(*kv_or_state_bytes);
    s += static_cast<long double>(*optimizer_bytes);
    s += static_cast<long double>(*temporary_workspace_bytes);
    if (s > 1.8e19) throw std::runtime_error("component sum overflows uint64");
    return static_cast<uint64_t>(s);
}

std::vector<std::string> ParameterAccounting::checkConsistency() {
    std::vector<std::string> errs;

    // (a) logical >= active
    if (logical_parameters.has_value() && active_parameters.has_value() &&
        *active_parameters > *logical_parameters)
        errs.push_back("active_parameters > logical_parameters");

    // (b) stored = nominal + overhead [EVERY record]
    if (stored_parameter_bytes.has_value() && nominal_parameter_payload_bytes.has_value() &&
        packing_overhead_bytes.has_value()) {
        if (*stored_parameter_bytes != *nominal_parameter_payload_bytes + *packing_overhead_bytes)
            errs.push_back("stored_parameter_bytes != nominal + packing_overhead");
    } else if (stored_parameter_bytes.has_value() &&
               (!nominal_parameter_payload_bytes.has_value() || !packing_overhead_bytes.has_value())) {
        errs.push_back("stored_parameter_bytes present but nominal/overhead missing");
    }

    // (c) uniform unquantized: nominal == logical * bytes_per_param; overhead typically small
    if (is_uniform_unquantized(storage_format) && nominal_parameter_payload_bytes.has_value() &&
        logical_parameters.has_value()) {
        double bpp = nominal_bytes_per_param(storage_format).value();
        long double expect = static_cast<long double>(*logical_parameters) * bpp;
        long double got = static_cast<long double>(*nominal_parameter_payload_bytes);
        if (expect != got)
            errs.push_back("uniform format: nominal_payload != logical * bytes_per_param");
        if (packing_overhead_bytes.has_value() && *packing_overhead_bytes > 4096)
            errs.push_back("uniform format: packing_overhead > 4096 (document large headers explicitly)");
    }

    // (d) quantized/packed: overhead expected > 0
    if (!is_uniform_unquantized(storage_format) && packing_overhead_bytes.has_value() &&
        *packing_overhead_bytes == 0) {
        errs.push_back("quantized/packed format with zero packing_overhead (must be explained)");
    }

    // (e) optimizer zero rule
    if (optimizer_bytes.has_value() && *optimizer_bytes == 0) {
        int buffers = auxiliary_state_buffers(optimizer_type);
        if (buffers != 0)
            errs.push_back("optimizer_bytes == 0 but optimizer type requires auxiliary state");
        if (training_or_inference == TrainingMode::TRAINING &&
            (optimizer_type == OptimizerType::NONE))
            errs.push_back("TRAINING record with optimizer_type 'none'");
    }
    if (optimizer_bytes.has_value() && *optimizer_bytes > 0) {
        int buffers = auxiliary_state_buffers(optimizer_type);
        if (buffers == 0)
            errs.push_back("optimizer_bytes > 0 but optimizer type is stateless (sgd_plain/none)");
    }

    // (f) component sum vs measured total (10% rule)
    auto sum = component_sum();
    if (sum.has_value()) {
        if (!total_peak_memory.has_value()) {
            errs.push_back("component sum computable but total_peak_memory not set");
        } else if (*sum != *total_peak_memory) {
            errs.push_back("total_peak_memory != component sum (internal field error)");
        }
        if (total_peak_memory_measured.has_value()) {
            long double s = static_cast<long double>(*sum);
            long double m = static_cast<long double>(*total_peak_memory_measured);
            long double rel = (s > 0) ? fabsl(s - m) / s : 0.0L;
            if (rel > 0.10) {
                inconsistent = true;
                errs.push_back("measured total disagrees with component sum by >10%");
            }
        }
    }

    return errs;
}

// ---------------------------------------------------------------------------
// JSON codec
// ---------------------------------------------------------------------------
JsonValue ParameterAccounting::to_json() const {
    JsonValue o = JsonValue::object();
    o.set("logical_parameters", field_json(logical_parameters, "logical_parameters", provenance));
    o.set("active_parameters", field_json(active_parameters, "active_parameters", provenance));
    if (experts_total.has_value()) o.set("experts_total", JsonValue::uinteger(*experts_total));
    if (experts_active.has_value()) o.set("experts_active", JsonValue::uinteger(*experts_active));
    o.set("stored_parameter_bytes", field_json(stored_parameter_bytes, "stored_parameter_bytes", provenance));
    o.set("nominal_parameter_payload_bytes", field_json(nominal_parameter_payload_bytes, "nominal_parameter_payload_bytes", provenance));
    o.set("packing_overhead_bytes", field_json(packing_overhead_bytes, "packing_overhead_bytes", provenance));
    o.set("runtime_parameter_bytes", field_json(runtime_parameter_bytes, "runtime_parameter_bytes", provenance));
    o.set("activation_bytes", field_json(activation_bytes, "activation_bytes", provenance));
    o.set("kv_or_state_bytes", field_json(kv_or_state_bytes, "kv_or_state_bytes", provenance));
    o.set("optimizer_bytes", field_json(optimizer_bytes, "optimizer_bytes", provenance));
    o.set("temporary_workspace_bytes", field_json(temporary_workspace_bytes, "temporary_workspace_bytes", provenance));
    o.set("total_peak_memory", field_json(total_peak_memory, "total_peak_memory", provenance));
    o.set("total_peak_memory_measured", field_json(total_peak_memory_measured, "total_peak_memory_measured", provenance));
    o.set("peak_memory_estimated", JsonValue::boolean(peak_memory_estimated));
    o.set("inconsistent", JsonValue::boolean(inconsistent));
    o.set("storage_format", JsonValue::str(storage_format_name(storage_format)));
    o.set("training_or_inference", JsonValue::str(training_mode_name(training_or_inference)));
    o.set("optimizer_type", JsonValue::str(optimizer_type_name(optimizer_type)));
    if (optimizer_configuration.has_value()) {
        JsonValue cfg = JsonValue::object();
        for (const auto& [k, s] : *optimizer_configuration) cfg.set(k, JsonValue::str(s));
        o.set("optimizer_configuration", std::move(cfg));
    } else {
        o.set("optimizer_configuration", JsonValue::null());
    }
    if (!per_tensor_table.empty()) {
        JsonValue t = JsonValue::object();
        for (const auto& [name, eb] : per_tensor_table) {
            JsonValue e = JsonValue::object();
            e.set("elements", JsonValue::uinteger(eb.first));
            e.set("bytes_per_element", JsonValue::number(eb.second));
            t.set(name, std::move(e));
        }
        o.set("per_tensor_table", std::move(t));
    }
    o.set("provenance", prov_json(provenance));
    return o;
}

ParameterAccounting ParameterAccounting::from_json(const JsonValue& o) {
    ParameterAccounting a;
    a.logical_parameters = field_from(o.get("logical_parameters"));
    a.active_parameters = field_from(o.get("active_parameters"));
    if (o.has("experts_total") && !o.get("experts_total").isNull())
        a.experts_total = o.get("experts_total").asUInt();
    if (o.has("experts_active") && !o.get("experts_active").isNull())
        a.experts_active = o.get("experts_active").asUInt();
    a.stored_parameter_bytes = field_from(o.get("stored_parameter_bytes"));
    a.nominal_parameter_payload_bytes = field_from(o.get("nominal_parameter_payload_bytes"));
    a.packing_overhead_bytes = field_from(o.get("packing_overhead_bytes"));
    a.runtime_parameter_bytes = field_from(o.get("runtime_parameter_bytes"));
    a.activation_bytes = field_from(o.get("activation_bytes"));
    a.kv_or_state_bytes = field_from(o.get("kv_or_state_bytes"));
    a.optimizer_bytes = field_from(o.get("optimizer_bytes"));
    a.temporary_workspace_bytes = field_from(o.get("temporary_workspace_bytes"));
    a.total_peak_memory = field_from(o.get("total_peak_memory"));
    a.total_peak_memory_measured = field_from(o.get("total_peak_memory_measured"));
    a.peak_memory_estimated = o.get("peak_memory_estimated").asBool();
    a.inconsistent = o.get("inconsistent").asBool();
    a.storage_format = storage_format_from(o.get("storage_format").asString());
    a.training_or_inference = training_mode_from(o.get("training_or_inference").asString());
    a.optimizer_type = optimizer_type_from(o.get("optimizer_type").asString());
    const JsonValue& cfg = o.get("optimizer_configuration");
    if (!cfg.isNull()) {
        std::map<std::string, std::string> m;
        for (const auto& [k, v] : cfg.entries()) m[k] = v.asString();
        a.optimizer_configuration = m;
    }
    if (o.has("per_tensor_table") && o.get("per_tensor_table").isObject()) {
        for (const auto& [name, e] : o.get("per_tensor_table").entries())
            a.per_tensor_table[name] = {e.get("elements").asUInt(), e.get("bytes_per_element").asDouble()};
    }
    if (o.has("provenance") && o.get("provenance").isObject())
        for (const auto& [k, v] : o.get("provenance").entries()) a.provenance[k] = v.asString();
    return a;
}

} // namespace stark_p1
