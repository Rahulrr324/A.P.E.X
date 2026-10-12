#pragma once

/**
 * STARK Phase 1 (M0): TINY-DENSE-2L baseline model (spec §E)
 *
 * Dense 2-layer MLP: 256 -> 512 -> 256, GELU, fixed seeded weights,
 * fixed seeded input. Batch = 1 and batch = 8 variants. Sequence-agnostic.
 *
 * EXACT parameter count (rev 1.1 — must hold as a test invariant):
 *   W1: 256*512 = 131,072    b1: 512
 *   W2: 512*256 = 131,072    b2: 256
 *   logical_parameters = 262,912
 *
 * CPU FP32 forward is fully deterministic (bit-identical across runs with the
 * same seed on the same build). This model exists only as a small reproducible
 * M0 baseline; it is NOT the Cognitive Core and implies no architecture choice.
 */

#include <cstdint>
#include <vector>

#include "bench/ParameterAccounting.h"

namespace stark_p1 {

struct TinyDenseDims {
    static constexpr uint32_t kIn = 256;
    static constexpr uint32_t kHidden = 512;
    static constexpr uint32_t kOut = 256;
    static constexpr uint64_t kLogicalParameters =
        static_cast<uint64_t>(kIn) * kHidden +   // W1
        static_cast<uint64_t>(kHidden) * kOut +  // W2
        kHidden +                                 // b1
        kOut;                                     // b2  == 262,912
};

class TinyDenseModel {
public:
    /// Fixed seed (spec: "specified constant seed"). Same seed -> same weights.
    static constexpr uint64_t kWeightSeed = 20260921ULL;
    static constexpr uint64_t kInputSeed = 20260922ULL;

    explicit TinyDenseModel(uint32_t batch = 1);

    /// Build with fixed seeded weights. Deterministic.
    void initWeights(uint64_t seed = kWeightSeed);

    /// Fill a fixed seeded input. Deterministic.
    void initInput(uint64_t seed = kInputSeed);

    /// Forward pass: h = GELU(W1 x + b1); y = W2 h + b2. Deterministic on CPU FP32.
    void forward();

    const std::vector<float>& output() const { return out_; }
    const std::vector<float>& input() const { return in_; }

    uint32_t batch() const { return batch_; }
    uint64_t logicalParameters() const { return TinyDenseDims::kLogicalParameters; }

    /// Serialize weights to bytes (for B7 model-load-time benchmark).
    /// Layout: W1, b1, W2, b2 as little-endian float32 + 16-byte header.
    std::vector<uint8_t> serializeWeights() const;

    /// Restore weights from serialized bytes (validates size + header magic).
    void deserializeWeights(const std::vector<uint8_t>& bytes);

    /// Canonical accounting for this model in a given storage format.
    ParameterAccounting accounting(StorageFormat fmt) const;

private:
    uint32_t batch_;
    std::vector<float> w1_, b1_, w2_, b2_;  // row-major [in x hidden], [hidden], [hidden x out], [out]
    std::vector<float> in_, hidden_, out_;
};

/// Deterministic splitmix64-based PRNG (portable, seedable, no platform RNG).
void deterministic_fill(std::vector<float>& v, uint64_t seed, float lo, float hi);

} // namespace stark_p1
