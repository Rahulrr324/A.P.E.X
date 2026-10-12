/**
 * STARK Phase 1 (M0): test_phase1_accounting (spec §K)
 * G5 rules: logical >= active; five-component sum; stored = nominal + overhead for
 * uniform AND quantized fixtures; canonical active-parameter counting (MoE fixture);
 * optimizer rules (sgd_plain -> 0 valid, adam -> nonzero, unknown -> null+reason).
 */

#include <iostream>

#include "test_harness.h"
#include "bench/ParameterAccounting.h"
#include "bench/TinyDenseModel.h"

using namespace stark_p1;

int main() {
    test::set_test_name("test_phase1_accounting");
    // --- Exact parameter count (M4) ---
    CHECK(TinyDenseDims::kLogicalParameters == 262912ULL);
    TinyDenseModel model(1);
    CHECK(model.logicalParameters() == 262912ULL);

    // --- FP32 dense accounting: uniform identity holds ---
    {
        ParameterAccounting a = model.accounting(StorageFormat::FP32);
        CHECK(a.logical_parameters.value() == 262912ULL);
        CHECK(a.active_parameters.value() == 262912ULL);  // dense: active == logical
        CHECK(a.checkConsistency().empty());
        // Uniform unquantized: nominal == logical * 4
        CHECK(*a.nominal_parameter_payload_bytes == 262912ULL * 4);
        CHECK(*a.stored_parameter_bytes == *a.nominal_parameter_payload_bytes + *a.packing_overhead_bytes);
        CHECK(*a.packing_overhead_bytes == 16);  // documented header only
        // Inference record: optimizer none -> genuine 0
        CHECK(a.training_or_inference == TrainingMode::INFERENCE);
        CHECK(a.optimizer_type == OptimizerType::NONE);
        CHECK(a.optimizer_bytes.value() == 0);
        // kv/state: MLP has none — real zero
        CHECK(a.kv_or_state_bytes.value() == 0);
        // Component sum identity
        CHECK(*a.total_peak_memory ==
              *a.runtime_parameter_bytes + *a.activation_bytes + *a.kv_or_state_bytes +
              *a.optimizer_bytes + *a.temporary_workspace_bytes);
        CHECK(!a.total_peak_memory_measured.has_value());      // not measured in unit test
    }

    // --- FP16 dense accounting ---
    {
        ParameterAccounting a = model.accounting(StorageFormat::FP16);
        CHECK(*a.nominal_parameter_payload_bytes == 262912ULL * 2);
        CHECK(a.checkConsistency().empty());
    }

    // --- INT8 quantized fixture: real scale/zero-point overhead ---
    {
        // 262,912 elements at 1 B payload; scales: 1 per-tensor FP32 + 16B header
        uint64_t nominal = 262912;
        uint64_t metadata = sizeof(float) + 16;   // scale + header
        uint64_t stored = nominal + metadata;
        ParameterAccounting a = quantized_accounting(
            262912, 262912, StorageFormat::INT8,
            stored, nominal, /*runtime=*/262912, /*activation=*/1024, /*kv=*/0, /*workspace=*/2048);
        CHECK(a.checkConsistency().empty());
        CHECK(*a.packing_overhead_bytes == metadata);
        CHECK(*a.stored_parameter_bytes == *a.nominal_parameter_payload_bytes + *a.packing_overhead_bytes);
        // NOT the uniform identity: logical * 1.0 would equal nominal here only coincidentally;
        // the identity test is format-gated, and INT8 is NOT uniform-unquantized:
        CHECK(!is_uniform_unquantized(StorageFormat::INT8));
        // Large metadata fixture: block-quantized with per-64-block scales
        {
            uint64_t blocks = (262912 + 63) / 64;
            uint64_t meta2 = blocks * sizeof(float) + 16;
            ParameterAccounting b = quantized_accounting(
                262912, 262912, StorageFormat::INT8,
                nominal + meta2, nominal, 262912, 1024, 0, 2048);
            CHECK(b.checkConsistency().empty());
            CHECK(*b.packing_overhead_bytes == meta2);
        }
    }

    // --- Packed 4-bit fixture: header padding + scales ---
    {
        uint64_t elements = 262912;
        uint64_t nominal = (elements + 1) / 2;               // two values per byte
        uint64_t blocks = (elements + 63) / 64;
        uint64_t meta = blocks * (sizeof(float) + sizeof(int8_t))  // scale + zero-point per block
                        + 8;                                        // alignment padding
        ParameterAccounting a = quantized_accounting(
            262912, 262912, StorageFormat::INT4_PACKED,
            nominal + meta, nominal, 262912 * 4, 1024, 0, 2048);
        CHECK(a.checkConsistency().empty());
        CHECK(*a.packing_overhead_bytes == meta);
        CHECK(!is_uniform_unquantized(StorageFormat::INT4_PACKED));
    }

    // --- Ternary packed fixture (future-format representability, M5) ---
    {
        uint64_t elements = 262912;
        uint64_t nominal = (elements * 2 + 7) / 8;  // 2 bits/value
        uint64_t meta = sizeof(float) + 16;
        ParameterAccounting a = quantized_accounting(
            262912, 262912, StorageFormat::TERNARY_PACKED,
            nominal + meta, nominal, 262912, 1024, 0, 2048);
        CHECK(a.checkConsistency().empty());
    }

    // --- Canonical active-parameter counting: MoE fixture ---
    {
        // 8 experts, 2 active: active = shared + 2 * params_per_expert
        uint64_t shared = 1000, per_expert = 500;
        CHECK(moe_active_parameters(shared, per_expert, 2) == 1000 + 2 * 500);
        CHECK(moe_active_parameters(shared, per_expert, 8) == 1000 + 8 * 500);
        // canonical rule: active <= logical
        uint64_t logical = shared + 8 * per_expert;
        CHECK(moe_active_parameters(shared, per_expert, 8) == logical);
        CHECK(moe_active_parameters(shared, per_expert, 3) < logical);
    }

    // --- Optimizer accounting ---
    {
        std::map<std::string, std::string> sgd_cfg{{"lr", "0.01"}};
        ParameterAccounting sgd = dense_accounting(
            262912, StorageFormat::FP32, 16, 262912 * 4, 1024, 0, 2048,
            TrainingMode::TRAINING, OptimizerType::SGD_PLAIN, sgd_cfg);
        CHECK(sgd.optimizer_bytes.value() == 0);           // genuine stateless zero
        CHECK(sgd.optimizer_configuration.has_value());    // config recorded
        CHECK(sgd.checkConsistency().empty());

        std::map<std::string, std::string> adam_cfg{{"state_bytes_per_param", "8"}};  // 2 buffers x 4B
        ParameterAccounting adam = dense_accounting(
            262912, StorageFormat::FP32, 16, 262912 * 4, 1024, 0, 2048,
            TrainingMode::TRAINING, OptimizerType::ADAM, adam_cfg);
        CHECK(adam.optimizer_bytes.value() == 2ULL * 262912 * 8);
        CHECK(adam.checkConsistency().empty());

        std::map<std::string, std::string> mom_cfg{{"state_bytes_per_param", "4"}};
        ParameterAccounting mom = dense_accounting(
            262912, StorageFormat::FP32, 16, 262912 * 4, 1024, 0, 2048,
            TrainingMode::TRAINING, OptimizerType::SGD_MOMENTUM, mom_cfg);
        CHECK(mom.optimizer_bytes.value() == 1ULL * 262912 * 4);
        CHECK(mom.checkConsistency().empty());

        // UNKNOWN state size -> null + reason, never zero
        std::map<std::string, std::string> adam_nocfg{};
        ParameterAccounting unknown = dense_accounting(
            262912, StorageFormat::FP32, 16, 262912 * 4, 1024, 0, 2048,
            TrainingMode::TRAINING, OptimizerType::ADAM, adam_nocfg);
        CHECK(unknown.optimizer_bytes == std::nullopt);
        CHECK(unknown.provenance.count("optimizer_bytes") == 1);
        CHECK(unknown.provenance.at("optimizer_bytes").rfind("unavailable:", 0) == 0);
    }

    // --- Violations caught by the checker ---
    {
        ParameterAccounting a = model.accounting(StorageFormat::FP32);
        a.active_parameters = a.logical_parameters.value() + 1;
        CHECK(!a.checkConsistency().empty());              // active > logical

        ParameterAccounting b = model.accounting(StorageFormat::FP32);
        b.stored_parameter_bytes = b.nominal_parameter_payload_bytes.value();  // overhead dropped
        CHECK(!b.checkConsistency().empty());

        ParameterAccounting c = model.accounting(StorageFormat::INT8);
        c.packing_overhead_bytes = 0;                      // quantized with zero overhead
        c.stored_parameter_bytes = c.nominal_parameter_payload_bytes.value();
        CHECK(!c.checkConsistency().empty());

        ParameterAccounting d = model.accounting(StorageFormat::FP32);
        d.optimizer_type = OptimizerType::ADAM;
        d.optimizer_bytes = 0;                             // zero with stateful optimizer
        CHECK(!d.checkConsistency().empty());

        ParameterAccounting e = model.accounting(StorageFormat::FP32);
        e.total_peak_memory = e.component_sum().value() + 1;  // internal sum mismatch
        CHECK(!e.checkConsistency().empty());

        // measured-vs-sum >10% disagreement -> flagged inconsistent
        ParameterAccounting f = model.accounting(StorageFormat::FP32);
        f.total_peak_memory = f.component_sum();
        f.total_peak_memory_measured = f.component_sum().value() / 2;  // 50% off
        CHECK(!f.checkConsistency().empty());
        f.checkConsistency();
        CHECK(f.inconsistent);
    }

    // --- Unknown field -> null + reason, never zero (round-trip preserves) ---
    {
        ParameterAccounting a = model.accounting(StorageFormat::FP32);
        a.temporary_workspace_bytes = std::nullopt;
        a.provenance["temporary_workspace_bytes"] = "unavailable: workspace not tracked in this run";
        JsonValue j = a.to_json();
        // Serialized as {"value": null, "reason": ...}
        const JsonValue& f = j.get("temporary_workspace_bytes");
        CHECK(f.isObject() && f.get("value").isNull());
        CHECK(f.get("reason").asString().find("workspace") != std::string::npos);
        ParameterAccounting b = ParameterAccounting::from_json(j);
        CHECK(b.temporary_workspace_bytes == std::nullopt);
        CHECK(b.provenance.at("temporary_workspace_bytes") == a.provenance.at("temporary_workspace_bytes"));
    }

    // --- Invalid arithmetic rejected ---
    {
        bool threw = false;
        try {
            quantized_accounting(100, 100, StorageFormat::INT8,
                                 /*stored=*/10, /*nominal=*/50, 0, 0, 0, 0);  // stored < nominal
        } catch (const std::exception&) {
            threw = true;
        }
        CHECK(threw);
    }

    // --- JSON round-trip preserves all fields bit-exactly ---
    {
        ParameterAccounting a = model.accounting(StorageFormat::FP16);
        a.experts_total = 0;   // dense: no experts (explicit zero, meaningful)
        a.experts_active = 0;
        JsonValue j = a.to_json();
        ParameterAccounting b = ParameterAccounting::from_json(j);
        CHECK(b.logical_parameters == a.logical_parameters);
        CHECK(b.active_parameters == a.active_parameters);
        CHECK(b.stored_parameter_bytes == a.stored_parameter_bytes);
        CHECK(b.nominal_parameter_payload_bytes == a.nominal_parameter_payload_bytes);
        CHECK(b.packing_overhead_bytes == a.packing_overhead_bytes);
        CHECK(b.runtime_parameter_bytes == a.runtime_parameter_bytes);
        CHECK(b.activation_bytes == a.activation_bytes);
        CHECK(b.kv_or_state_bytes == a.kv_or_state_bytes);
        CHECK(b.optimizer_bytes == a.optimizer_bytes);
        CHECK(b.temporary_workspace_bytes == a.temporary_workspace_bytes);
        CHECK(b.storage_format == a.storage_format);
        CHECK(b.training_or_inference == a.training_or_inference);
        CHECK(b.optimizer_type == a.optimizer_type);
        CHECK(b.experts_total == a.experts_total);
        CHECK(b.checkConsistency().empty());
    }

    std::cout << "test_phase1_accounting: " << test::assertions << " assertions, " << test::failures << " failures\n";
    return test::report();
}
