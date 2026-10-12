#include "bench/TinyDenseModel.h"

#include <cmath>
#include <cstring>
#include <stdexcept>

namespace stark_p1 {

// ---------------------------------------------------------------------------
// Deterministic PRNG: splitmix64 -> float in [lo, hi]
// ---------------------------------------------------------------------------
void deterministic_fill(std::vector<float>& v, uint64_t seed, float lo, float hi) {
    uint64_t state = seed;
    auto next = [&state]() {
        state += 0x9E3779B97F4A7C15ULL;
        uint64_t z = state;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
        return z ^ (z >> 31);
    };
    for (auto& x : v) {
        uint64_t u = next();
        // 53-bit double -> float in [lo, hi]
        double d = static_cast<double>(u >> 11) / static_cast<double>(1ULL << 53);
        x = static_cast<float>(lo + d * (hi - lo));
    }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
TinyDenseModel::TinyDenseModel(uint32_t batch) : batch_(batch) {
    w1_.resize(static_cast<size_t>(TinyDenseDims::kIn) * TinyDenseDims::kHidden);
    b1_.resize(TinyDenseDims::kHidden);
    w2_.resize(static_cast<size_t>(TinyDenseDims::kHidden) * TinyDenseDims::kOut);
    b2_.resize(TinyDenseDims::kOut);
    in_.resize(static_cast<size_t>(batch_) * TinyDenseDims::kIn);
    hidden_.resize(static_cast<size_t>(batch_) * TinyDenseDims::kHidden);
    out_.resize(static_cast<size_t>(batch_) * TinyDenseDims::kOut);
    initWeights();
    initInput();
}

void TinyDenseModel::initWeights(uint64_t seed) {
    deterministic_fill(w1_, seed + 1, -0.05f, 0.05f);
    deterministic_fill(b1_, seed + 2, -0.01f, 0.01f);
    deterministic_fill(w2_, seed + 3, -0.05f, 0.05f);
    deterministic_fill(b2_, seed + 4, -0.01f, 0.01f);
}

void TinyDenseModel::initInput(uint64_t seed) {
    deterministic_fill(in_, seed, -1.0f, 1.0f);
}

// Deterministic GELU (tanh approximation, evaluated identically every call).
static inline float gelu(float x) {
    const float kAlpha = 0.7978845608028654f;  // sqrt(2/pi)
    const float kBeta = 0.044715f;
    float inner = kAlpha * (x + kBeta * x * x * x);
    // tanh via exp (deterministic, no platform differences beyond libm's defined behavior
    // on the same build — records capture the build identity).
    float t = 1.0f - 2.0f / (1.0f + std::exp(2.0f * inner));
    return 0.5f * x * (1.0f + t);
}

void TinyDenseModel::forward() {
    const uint32_t in = TinyDenseDims::kIn;
    const uint32_t hid = TinyDenseDims::kHidden;
    const uint32_t out = TinyDenseDims::kOut;

    for (uint32_t b = 0; b < batch_; ++b) {
        const float* x = &in_[static_cast<size_t>(b) * in];
        float* h = &hidden_[static_cast<size_t>(b) * hid];
        for (uint32_t j = 0; j < hid; ++j) {
            float acc = b1_[j];
            for (uint32_t i = 0; i < in; ++i) acc += w1_[static_cast<size_t>(i) * hid + j] * x[i];
            h[j] = gelu(acc);
        }
        float* y = &out_[static_cast<size_t>(b) * out];
        for (uint32_t k = 0; k < out; ++k) {
            float acc = b2_[k];
            for (uint32_t j = 0; j < hid; ++j) acc += w2_[static_cast<size_t>(j) * out + k] * h[j];
            y[k] = acc;
        }
    }
}

// ---------------------------------------------------------------------------
// Weight serialization (for model-load-time benchmark)
// ---------------------------------------------------------------------------
static constexpr char kMagic[8] = {'S', 'T', 'A', 'R', 'K', 'M', '0', '1'};

std::vector<uint8_t> TinyDenseModel::serializeWeights() const {
    const size_t floats = w1_.size() + b1_.size() + w2_.size() + b2_.size();
    std::vector<uint8_t> bytes(16 + floats * sizeof(float));
    std::memcpy(bytes.data(), kMagic, 8);
    uint64_t count = floats;
    std::memcpy(bytes.data() + 8, &count, 8);
    size_t off = 16;
    auto put = [&](const std::vector<float>& v) {
        std::memcpy(bytes.data() + off, v.data(), v.size() * sizeof(float));
        off += v.size() * sizeof(float);
    };
    put(w1_); put(b1_); put(w2_); put(b2_);
    return bytes;
}

void TinyDenseModel::deserializeWeights(const std::vector<uint8_t>& bytes) {
    if (bytes.size() < 16) throw std::runtime_error("weight blob too small");
    if (std::memcmp(bytes.data(), kMagic, 8) != 0) throw std::runtime_error("weight blob bad magic");
    uint64_t count = 0;
    std::memcpy(&count, bytes.data() + 8, 8);
    const size_t floats = w1_.size() + b1_.size() + w2_.size() + b2_.size();
    if (count != floats || bytes.size() != 16 + floats * sizeof(float))
        throw std::runtime_error("weight blob size mismatch");
    size_t off = 16;
    auto get = [&](std::vector<float>& v) {
        std::memcpy(v.data(), bytes.data() + off, v.size() * sizeof(float));
        off += v.size() * sizeof(float);
    };
    get(w1_); get(b1_); get(w2_); get(b2_);
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------
ParameterAccounting TinyDenseModel::accounting(StorageFormat fmt) const {
    const uint64_t logical = TinyDenseDims::kLogicalParameters;
    const uint32_t in = TinyDenseDims::kIn;
    const uint32_t hid = TinyDenseDims::kHidden;
    const uint32_t out = TinyDenseDims::kOut;

    // Runtime bytes: materialized FP32 weights (dense model stores/uses same layout here)
    uint64_t runtime_bytes = logical * sizeof(float);
    // Activations per forward: input + hidden + output buffers (per batch)
    uint64_t activation_bytes =
        (static_cast<uint64_t>(batch_) * in + static_cast<uint64_t>(batch_) * hid +
         static_cast<uint64_t>(batch_) * out) * sizeof(float);
    // No per-sequence persistent state (MLP): kv_or_state = 0 (real zero, not unknown)
    uint64_t kv_state = 0;
    // Workspace: one hidden scratch buffer
    uint64_t workspace = static_cast<uint64_t>(hid) * sizeof(float);

    // Inference-only record: optimizer 'none' -> genuine 0
    std::map<std::string, std::string> cfg;
    return dense_accounting(logical, fmt,
                            /*file_header_bytes=*/16,
                            runtime_bytes, activation_bytes, kv_state, workspace,
                            TrainingMode::INFERENCE, OptimizerType::NONE, cfg);
}

} // namespace stark_p1
