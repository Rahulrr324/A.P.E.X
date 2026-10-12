# STARK-001 Design Decision

## Recommended Neural Cell Design

**STARK-001 neural cell = Leaky Integrator with Adaptive Threshold**

## Why This Design?

After comprehensive comparison of computational primitives, the Leaky Integrator with Adaptive Threshold was selected as the foundational neural cell for STARK-001. This section explains the decision in detail.

### Core Rationale

The selected design must balance several competing requirements for a persistent cognitive architecture:

1. **Temporal processing** — STARK must maintain state across time steps to support continuous perception and attention
2. **Persistent state** — The cell must remember its internal state between invocations
3. **Numerical stability** — Prevent unbounded accumulation over long periods
4. **Computational efficiency** — Must run efficiently on CPU (Intel i5-12450H) and eventually GPU (RTX 2050 4GB)
5. **Sparse connectivity** — Network should support sparse, localized connections
6. **Recurrent connections** — Must support feedback and recurrent processing
7. **Adaptability** — Sensitivity/sensitivity adjustment based on input statistics
8. **Composability** — Multiple cells should naturally form networks

### How Leaky Integrator with Adaptive Threshold Meets Each Requirement

#### 1. Temporal Processing
- **Mechanism**: Membrane potential `V_t` leaks decayingly toward zero each timestep: `V_t = V_{t-1} * (1 - Δt/τ) + I_t * Δt`
- **Result**: Maintains history of recent inputs with exponential decay
- **Forgetting time constant**: Determined by `τ` — larger τ = longer memory

#### 2. Persistent State
- **State variable**: `V_t` (membrane potential) persists across time steps
- **Additional state**: `θ_t` (adaptive threshold) also persists
- **Reset**: After spike, `V_t` resets to `V_reset`, providing a natural "clearing" mechanism

#### 3. Numerical Stability
- **Leak term** `(1 - Δt/τ)` ensures `V_t` cannot grow unboundedly
- Even with constant input, `V_t` asymptotically approaches `I * τ`
- Prevents the "integrator runaway" problem of pure integrators

#### 4. Computational Efficiency
- **Operations per timestep**: 
  - 1 multiply + 1 add for leak + input
  - 1 absolute value + 1 multiply + 1 add for threshold adaptation
  - 1 comparison for spike check
- **Total**: ~6 floating-point operations per neuron per timestep
- **Memory**: 2 scalars per neuron (V_t, θ_t) + parameters (τ, θ_0, α, β, V_reset)

#### 5. Sparse Connectivity
- **Mechanism**: Each neuron has its own `V_t` and `θ_t`
- **Connections**: Synaptic weights modulate input current `I_t`
- **Sparse implementation**: Only compute connections that have non-zero weights
- **Natural fit**: One neuron = one membrane potential; connections are explicit weighted inputs

#### 6. Recurrent Connections
- **Intrinsic recurrence**: `V_t` depends on `V_{t-1}` — each cell recurrently processes its own history
- **Explicit recurrence**: Output of one cell can become input to another through synaptic weights
- **Feedback loops**: Threshold adaptation can be modulated by other cells' activity
- **Network formation**: Populations of cells with sparse inter-connections form recurrent networks

#### 7. Adaptability (Key Feature)
- **Adaptive threshold** `θ_t` normalizes response to input magnitude:
  - Strong inputs → threshold rises → neuron becomes less sensitive (contrast normalization)
  - Weak inputs → threshold decays → neuron becomes more sensitive
  - `α` controls adaptation speed; `β` controls decay rate
- **Biological analog**: Could model arousal, attention, or sensory adaptation
- **STARK application**: The adaptive threshold could represent "concern," "satisfaction," or "urgency" levels that adjust based on activity patterns

#### 8. Composability
- **Identical cells**: All cells share the same mathematical structure
- **Different parameters**: Each cell can have its own `τ`, `θ_0`, `α`, `β`, `V_reset`
- **Synaptic connections**: Weighted inputs from other cells' outputs
- **Population coding**: Many cells with different thresholds/thyme constants can encode different features
- **Layer formation**: Can stack cells in layers (feedforward) or interconnect them recurrently

### Comparison with Alternatives

| Requirement | Conventional Neuron | Recurrent Neuron | Leaky Integrator | Spiking Neuron | **Leaky + Adaptive Threshold** |
|-------------|-------------------|------------------|-----------------|---------------|-------------------------------|
| Temporal processing | ❌ | ✅ | ✅ | ✅ | ✅✅ |
| Persistent state | ❌ | ✅ | ✅ | ✅ | ✅✅ |
| Numerical stability | ✅ | ⚠️ (BPTT issues) | ✅✅ | ✅ | ✅✅ |
| CPU efficiency | ✅✅ | ⚠️ (BPTT overhead) | ✅✅ | ⚠️ (refractory mgmt) | ✅✅ |
| Sparse connectivity | ⚠️ (ad hoc) | ⚠️ (matrix sparsity) | ✅✅ | ✅✅ | ✅✅ |
| Recurrent connections | ❌ | ✅ | ✅ (intrinsic) | ✅✅ | ✅✅ |
| Adaptability | ❌ | ⚠️ (separate mechanism) | ✅ | ✅ (STDP) | ✅✅✅ |
| Composability | ✅ | ✅ | ✅ | ✅ | ✅✅✅ |

✅✅ = Excellent, ✅ = Good, ⚠️ = Acceptable with limitations, ❌ = Not supported

### Design Choices and Alternatives Considered

#### Alternative 1: Pure Leaky Integrator (without adaptive threshold)
- **Pros**: Simpler (only V_t to store), even lower computational cost
- **Cons**: No built-in sensitivity adjustment; fixed threshold means same response regardless of input statistics; less biological plausibility
- **Decision**: Adaptive threshold adds minimal overhead but provides crucial functionality for STARK's persistent cognitive behavior

#### Alternative 2: Leaky Integrator with Fixed Reset
- **Pros**: Simpler reset mechanism
- **Cons**: Fixed reset potential doesn't adapt to input statistics; less robust across varying input levels
- **Decision**: Adaptive threshold replaces fixed threshold with dynamic sensitivity control

#### Alternative 3: Hodgkin-Huxley Spiking Neuron
- **Pros**: Most biologically detailed; rich spike dynamics
- **Cons**: 7+ state variables per neuron; computationally expensive; difficult to implement in pure C++ without framework; overkill for STARK-001
- **Decision**: Save for STARK-002 if spiking dynamics are needed

#### Alternative 4: LSTM-style Gated Recurrent Unit
- **Pros**: Proven for sequence learning; gates control information flow
- **Cons**: More state variables (4+ per cell); matrix operations; less biological inspiration; harder to interpret individual parameters
- **Decision**: Too complex for STARK-001's goal of a minimal, understandable neural primitive

### Final Design Specification Summary

The STARK-001 neural cell implements a **leaky integrate-and-fire unit with adaptive threshold**, providing:

- **2 state variables**: `V_t` (membrane potential), `θ_t` (adaptive threshold)
- **5 trainable parameters**: `τ_m` (time constant), `θ_0` (baseline threshold), `α` (adaptation rate), `β` (decay rate), `V_reset` (reset potential)
- **1 input**: `I_t` (external input current)
- **1 output**: `s_t` (spike indicator: 0 or 1), plus readable `V_t`
- **3 update steps**: leak+input, threshold adaptation, spike check
- **Numerical stability**: Leak term prevents unbounded accumulation
- **Sparse connectivity**: Each neuron independent; synaptic weights modulate input
- **Recurrent support**: Intrinsic V_t recurrence + explicit synaptic connections
- **Adaptability**: Threshold normalizes to input statistics

This design represents the minimal useful computational unit that can eventually become part of STARK's neural substrate while providing the temporal dynamics, persistence, and adaptability required for a persistent cognitive entity.

---
*Decision documented as part of STARK-001 research phase.*