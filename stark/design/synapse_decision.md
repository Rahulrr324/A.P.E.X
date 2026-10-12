# STARK-002 Design Decision

## Recommended Synapse Design

**STARK-002 synapse = Exponentially Decaying Synaptic Current (Single-Exponential)**

---

## Why This Design?

After comprehensive comparison of computational synapse models, the exponentially decaying synaptic current was selected as the foundational synaptic primitive for STARK-002. This section explains the decision in detail.

---

## Core Rationale

The selected design must balance several competing requirements for STARK's neural substrate:

1. **Temporal processing** — Synapses must transmit spikes with temporal dynamics
2. **Excitatory and inhibitory** — Both connection types must be supported naturally
3. **Computational efficiency** — Must run efficiently on CPU (Intel i5-12450H) and eventually GPU (RTX 2050 4GB)
4. **Sparse connectivity** — Network should support sparse, localized connections
5. **Composability** — Multiple synapses should naturally sum at post-synaptic neuron
6. **Future plasticity** — State must be available for STDP/learning
7. **Minimal state** — Keep the primitive as simple as possible for STARK-002

---

## How Exponentially Decaying Synapse Meets Each Requirement

### 1. Temporal Processing
- **Mechanism**: Spike causes instantaneous jump in `x_t`, then exponential decay with time constant `τ_s`
- **Result**: Natural temporal integration window — recent spikes contribute more than distant ones
- **Tunable**: `τ_s` controls integration window (fast for coincidence detection, slow for temporal summation)

### 2. Excitatory and Inhibitory Connections
- **Mechanism**: Weight `w ∈ R` determines sign of post-synaptic current
  - `w > 0` → Excitatory: `I_post > 0` depolarizes post-synaptic neuron
  - `w < 0` → Inhibitory: `I_post < 0` hyperpolarizes post-synaptic neuron
- **No artificial restriction**: Both signs fully supported, no separate classes needed
- **Biological analog**: Matches glutamate (excitatory) vs GABA/glycine (inhibitory) neurotransmitters

### 3. Computational Efficiency
- **Operations per timestep per synapse**:
  - 1 multiply + 1 add for state update: `x = x * (1 - dt/τ_s) + spike`
  - 1 multiply for current: `I = w * x`
- **Total**: ~3 FLOPs per synapse per timestep
- **Memory**: 1 scalar state (`x_t`) + 2 parameters (`w`, `τ_s`)
- **Branch**: Single conditional (spike vs no-spike)

### 4. Sparse Connectivity
- **Mechanism**: Each synapse is an independent object with its own state
- **Sparse implementation**: Only compute synapses that have `x_t > 0` or recent spikes
- **Natural fit**: Silent synapses (`x_t ≈ 0`) contribute negligible current; can be skipped
- **Scalability**: O(number of active synapses) not O(N²)

### 5. Composability
- **Identical synapses**: All synapses share the same mathematical structure
- **Different parameters**: Each synapse can have its own `w`, `τ_s`
- **Linear summation**: Multiple synapses onto same neuron naturally sum currents
  - `I_total = Σ w_i * x_i`
- **Network formation**: Populations of neurons connected by synapses form recurrent networks

### 6. Future Plasticity (STDP-ready)
- **Pre-synaptic trace**: `x_t` is exactly the pre-synaptic trace needed for STDP
- **Standard STDP**: `Δw ∝ x_t * (post_spike - target)` or similar
- **No additional state needed**: Current design already has the trace

### 7. Minimal State
- **1 state variable**: `x_t` per synapse
- **2 parameters**: `w`, `τ_s` per synapse
- **Clean separation**: Synapse has no neuron state; neuron has no synapse state

---

## Comparison with Alternatives

| Requirement | Instantaneous | Rectangular Pulse | **Exponential** | Dual-Exponential | Delayed Exponential |
|-------------|---------------|-------------------|-----------------|------------------|---------------------|
| Temporal dynamics | ❌ | ⚠️ (fixed) | ✅✅ | ✅✅✅ | ✅✅ |
| E/I support | ✅ | ✅ | ✅✅ | ✅✅ | ✅✅ |
| CPU efficiency | ✅✅✅ | ✅✅ | ✅✅ | ✅ | ✅ |
| State variables | 0 | 1 (timer) | 1 | 2 | 1 + queue |
| STDP-ready | ❌ | ⚠️ | ✅✅ | ✅✅ | ✅✅ |
| Sparse-friendly | ✅✅✅ | ✅✅ | ✅✅ | ✅✅ | ✅ |
| Biological plausibility | ❌ | ⚠️ | ✅✅ | ✅✅✅ | ✅✅✅ |
| Parameters | 1 | 2 | 2 | 3 | 3 |

✅✅✅ = Excellent, ✅✅ = Very Good, ✅ = Good, ⚠️ = Limited, ❌ = Not supported

---

## Design Choices and Alternatives Considered

### Alternative 1: Instantaneous Weighted Spike
- **Pros**: Zero state, simplest possible
- **Cons**: No temporal dynamics; no integration window; no biological plausibility for chemical synapses
- **Decision**: Rejected — STARK needs temporal processing at the synapse level

### Alternative 2: Rectangular Pulse (Fixed Duration)
- **Pros**: Simple temporal integration
- **Cons**: Fixed duration is inflexible; step-function dynamics unnatural; requires per-synapse timer
- **Decision**: Rejected — exponential decay is more natural and equally efficient

### Alternative 3: Dual-Exponential (Alpha Function)
- **Pros**: Separate rise and decay time constants; most biologically plausible (AMPA-like)
- **Cons**: Two state variables; more complex; overkill for STARK-002
- **Decision**: Save for STARK-003 if rise-time dynamics become important

### Alternative 4: Delayed Exponential
- **Pros**: Models axonal conduction delay
- **Cons**: Additional delay queue per synapse; overkill for STARK-002
- **Decision**: Save for STARK-003 when network-scale delays matter

---

## Interface Architecture

### Responsibility Separation

| Component | Responsibility |
|-----------|----------------|
| `NeuralCell` (STARK-001) | Maintains `V`, `a`, `θ`, `spike`. Computes own spike from total input `I`. |
| `Synapse` (STARK-002) | Maintains `x`. Receives pre-synaptic spike. Produces current `I = w * x`. |
| `Network` (STARK-003+) | Routes spikes from pre- to post-synaptic cells via synapses. |

### No Modifications to STARK-001
- `NeuralCell` is **unchanged** from STARK-001
- The synapse connects to the neuron via the existing `update(I, dt)` interface
- Neuron's input `I` can come from external sources, synapses, or both
- Clean composition: `neuron.update(synapse.receiveSpike(pre_spike, dt), dt)`

---

## Two-Neuron Experiment Validation

The design was validated with a minimal two-neuron network:

```
Neuron A (external input) → Synapse A→B (w=0.5, τ_s=2.0) → Neuron B (synaptic only)
```

**Verified behaviors:**
1. ✅ Neuron A spikes with external input
2. ✅ Spike travels through synapse → post-synaptic current
3. ✅ Excitatory synapse (w > 0) increases B's membrane potential
4. ✅ Inhibitory synapse (w < 0) decreases B's membrane potential
5. ✅ Synaptic current decays exponentially (τ_s = 2.0)
6. ✅ Multiple spikes sum temporally (temporal integration)
7. ✅ Multiple synapses onto same neuron sum linearly
8. ✅ With sufficient weight, Neuron B spikes from synaptic input alone

---

## Final Design Specification Summary

The STARK-002 synapse implements an **exponentially decaying synaptic current**, providing:

- **1 state variable**: `x_t` (synaptic efficacy, ≥ 0)
- **2 parameters**: `w ∈ R` (weight, sign = E/I), `τ_s > 0` (time constant)
- **1 input**: `s_pre,t ∈ {0,1}` (pre-synaptic spike)
- **1 output**: `I_post,t ∈ R` (post-synaptic current)
- **2 update steps**: decay+spike, current generation
- **Numerical stability**: Requires `Δt < τ_s`
- **Sparse connectivity**: Each synapse independent
- **E/I support**: Weight sign determines excitatory/inhibitory
- **Temporal integration**: Exponential decay provides natural integration window
- **STDP-ready**: Pre-synaptic trace `x_t` available for learning

This design represents the minimal useful synaptic primitive that enables temporal spike transmission between STARK-001 neural cells while providing the computational foundation for future network-level dynamics and plasticity.

---

*Decision documented as part of STARK-002 research phase.*