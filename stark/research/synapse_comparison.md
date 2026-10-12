# STARK-002 Synapse Model Comparison

## Overview
We need to connect two or more STARK-001 neural cells. The synapse is the computational primitive that transmits spikes from a pre-synaptic neuron to a post-synaptic neuron.

## Candidate Models

### A. Instantaneous Weighted Spike
**Mathematical state**: None (stateless)
**Inputs**: Pre-synaptic spike `s_pre ∈ {0, 1}`
**Outputs**: Post-synaptic current `I_post = w * s_pre`
**Parameters**: Weight `w ∈ R`
**Temporal behavior**: Zero duration - current only exists in the exact timestep of the spike
**Computational cost**: 1 multiplication per spike
**Advantages**: Extremely simple, minimal memory, no state to manage
**Disadvantages**: No temporal dynamics, no integration window, no biological plausibility for chemical synapses
**Suitability for STARK**: Too limited - lacks temporal integration needed for temporal processing

---

### B. Weighted Synaptic Current (Rectangular Pulse)
**Mathematical state**: None (stateless with fixed duration)
**Inputs**: Pre-synaptic spike `s_pre ∈ {0, 1}`
**Outputs**: Post-synaptic current `I_post = w` for `d` timesteps after spike
**Parameters**: Weight `w ∈ R`, duration `d ∈ N`
**Temporal behavior**: Fixed-duration rectangular pulse
**Computational cost**: 1 multiplication + counter per active connection
**Advantages**: Simple temporal integration, some biological plausibility
**Disadvantages**: Fixed duration is inflexible; step-function dynamics; memory for each active synapse
**Suitability for STARK**: Better but fixed duration limits expressivity

---

### C. Exponentially Decaying Synaptic Current (Alpha Function / Single Exponential)
**Mathematical state**: `x_t` = synaptic state (synaptic efficacy / current)
**Inputs**: Pre-synaptic spike `s_pre ∈ {0, 1}`
**Outputs**: Post-synaptic current `I_post = w * x_t`
**Parameters**: Weight `w ∈ R`, time constant `τ_s > 0`
**State update**: `x_t = x_{t-1} * (1 - Δt/τ_s) + s_pre`
**Temporal behavior**: Spike causes instantaneous jump in `x`, then exponential decay
**Computational cost**: 1 multiply + 1 add + 1 multiply per timestep per synapse
**Advantages**: 
- Biologically plausible (AMPA-like or GABA-like)
- Continuous temporal dynamics
- Single state variable
- Natural integration window
- Computationally efficient
**Disadvantages**: 
- Rise time is instantaneous (no rise phase)
- Single time constant for both rise and decay
**Suitability for STARK**: **High** - good balance of simplicity, temporal dynamics, and biological inspiration

---

### D. Exponentially Decaying Synaptic Current with Transmission Delay
**Mathematical state**: `x_t` (synaptic state) + delay queue
**Inputs**: Pre-synaptic spike `s_pre ∈ {0, 1}`
**Outputs**: Post-synaptic current `I_post = w * x_t` (after delay)
**Parameters**: Weight `w ∈ R`, time constant `τ_s > 0`, delay `d ∈ N` (timesteps)
**State update**: Delay queue + `x_t = x_{t-1} * (1 - Δt/τ_s) + delayed_spike`
**Temporal behavior**: Spike → delay → exponential response
**Computational cost**: Same as C + delay queue management
**Advantages**: Models axonal conduction delay; more realistic
**Disadvantages**: Additional complexity; delay queue memory per synapse
**Suitability for STARK**: Good for later (STARK-003+); overkill for STARK-002

---

### E. Dual-Exponential Synapse (Alpha Function with Rise and Decay)
**Mathematical state**: `x_t` (rise), `y_t` (decay) or equivalent
**Inputs**: Pre-synaptic spike
**Outputs**: Post-synaptic current with distinct rise and decay phases
**Parameters**: `w`, `τ_rise`, `τ_decay`
**Temporal behavior**: Gradual rise, then decay
**Advantages**: Most biologically plausible (AMPA: ~0.5ms rise, ~2ms decay)
**Disadvantages**: Two state variables, more complex
**Suitability for STARK**: Overkill for STARK-002; can add later if needed

---

## Excitatory vs Inhibitory Connections

**Weight sign convention**:
- `w > 0` → **Excitatory**: increases post-synaptic membrane potential (depolarizes)
- `w < 0` → **Inhibitory**: decreases post-synaptic membrane potential (hyperpolarizes)

**Implications**:
- Excitatory: `I_post > 0` adds to membrane potential → promotes spiking
- Inhibitory: `I_post < 0` subtracts from membrane potential → suppresses spiking
- Both are essential for balanced networks, winner-take-all, oscillations, etc.

**STARK decision**: Allow **both positive and negative weights**. No artificial restriction. The neuron's membrane equation `V_temp = V * (1 - dt/τ_m) + I * dt` naturally handles both signs. Inhibitory synapses simply provide negative current.

---

## Synaptic State Recommendation

**Yes, the synapse should have temporal state.**

Minimal stateful model (Single-Exponential):
- State: `x_t ≥ 0` (synaptic efficacy, decays exponentially)
- Input: pre-synaptic spike `s_pre ∈ {0, 1}`
- Update: `x_t = x_{t-1} * (1 - Δt/τ_s) + s_pre`
- Output: `I_post = w * x_t`

This gives:
- Immediate response to spike
- Exponential decay providing temporal integration window
- Single scalar state per synapse
- Clean mathematical properties
- `x_t ≥ 0` invariant maintained (since `x_0 = 0`, leak factor > 0, add `s_pre ∈ {0,1}`)
- `I_post` sign determined solely by `w`

---

## Design Decision

**STARK-002 synapse = Exponentially Decaying Synaptic Current (Single-Exponential)**

### Why:
1. **Minimal state**: 1 scalar (`x_t`) per synapse
2. **Temporal dynamics**: Natural integration window via `τ_s`
3. **E/I support**: Weight sign handles both excitatory and inhibitory
4. **Computational efficiency**: ~3 FLOPs per timestep per synapse
5. **Biological inspiration**: Matches AMPA/GABA-A receptor dynamics
6. **Composable**: Multiple synapses sum currents at post-synaptic neuron
7. **Future plasticity**: State `x_t` available for STDP (pre-synaptic trace)
8. **Sparse connectivity**: Only active synapses (where `x_t > 0`) need computation
9. **CPU/GPU friendly**: Simple element-wise operations
10. **Minimal API**: Clear separation of concerns

---

## Interface Design

### Responsibilities

| Component | Responsibility |
|-----------|----------------|
| `NeuralCell` | Maintains `V`, `a`, `θ`, `spike`. Computes own spike from `I`. |
| `Synapse` | Maintains `x`. Receives pre-synaptic spike. Produces current `I = w * x`. |
| `Network` (later) | Routes spikes from pre- to post-synaptic cells via synapses. |

### Synapse API

```cpp
class Synapse {
public:
    Synapse(double weight, double tau_s = 1.0);  // weight can be positive or negative
    
    void reset();                                 // x = 0
    double receiveSpike(bool pre_spike, double dt);  // returns I_post
    double getState() const;                      // get x_t
    double getWeight() const;                     // get w
    void setWeight(double w);                     // for future learning
    
private:
    double x_;       // synaptic state x_t >= 0
    double tau_s_;   // synaptic time constant > 0
    double w_;       // synaptic weight (can be negative)
    
    bool validateDt(double dt) const;             // dt < tau_s
};
```

### Network Integration (for STARK-002)

For the two-neuron experiment, we don't need a general `Network` class yet. We can directly wire:

```
Neuron A → Synapse → Neuron B
```

In code:
```cpp
NeuralCell neuron_A(...);
NeuralCell neuron_B(...);
Synapse synapse_A_to_B(weight, tau_s);

for each timestep:
    spike_A = neuron_A.update(I_ext_A, dt);
    I_B = synapse_A_to_B.receiveSpike(spike_A, dt);
    spike_B = neuron_B.update(I_B, dt);  // B only gets synaptic input
```

This keeps STARK-002 minimal while demonstrating the complete spike transmission pathway.

---

## Two-Neuron Experiment Plan

### Parameters
- Neuron A: `τ_m=1.0, θ_0=1.0, τ_a=10.0, b=0.5, V_reset=-0.5`
- Neuron B: same as A
- Synapse: `w=0.5` (excitatory), `τ_s=2.0`, `dt=0.1`

### Expected Behavior
1. External input drives Neuron A
2. Neuron A spikes periodically
3. Each spike from A causes `x` to jump by 1, then decay with `τ_s=2.0`
4. Neuron B receives `I_B = w * x` 
5. If `w` is large enough, B will also spike
6. With `w=0.5`, each spike gives peak current ~0.5; B may or may not spike depending on integration

### Tests
1. **Excitatory test**: `w > 0` → B's membrane depolarizes
2. **Inhibitory test**: `w < 0` → B's membrane hyperpolarizes
3. **Temporal test**: Single spike → exponential decay of synaptic current
4. **Multiple synapses test**: A→B and C→B, currents sum