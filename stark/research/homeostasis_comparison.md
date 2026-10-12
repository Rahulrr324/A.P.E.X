# STARK-005: Homeostatic Plasticity Mechanism Comparison

## Overview

STARK-004 implemented pair-based STDP for synaptic weight plasticity. However, STDP alone cannot guarantee stable network activity — it can lead to runaway potentiation, permanent silencing, or oscillatory dynamics.

Homeostatic plasticity provides the necessary counterbalance to maintain stable, functional network activity while preserving STDP's ability to learn temporal patterns.

This document compares several homeostatic plasticity mechanisms for STARK-005.

---

## Comparison Table

| Mechanism | Mathematical Complexity | Local Information | Biological Plausibility | Computational Cost | Stability | Temporal Patterns | Label-Free | Compatibility with STARK | CPU Suitability | GPU Suitability |
|-----------|------------------------|-------------------|-------------------------|--------------------|-----------|-------------------|------------|--------------------------|-----------------|-----------------|
| Multiplicative Synaptic Scaling | Low | Yes | High | Low | High | No | Yes | High | High | High |
| Intrinsic Plasticity | Medium | Yes | High | Medium | High | Yes | Yes | Medium | High | High |
| Sliding Threshold | Medium | Yes | High | Medium | High | Yes | Yes | High | High | High |
| Firing-Rate Homeostasis | Medium | Yes | High | Medium | High | Yes | Yes | High | High | High |
| BCM-Style | Medium | Yes | High | Medium | High | Yes | Yes | Medium | High | High |

---

## Detailed Analysis

### A. Multiplicative Synaptic Scaling (CHOSEN)

**Mathematical Model:**
- Maintain target firing rate $r_{target}$ for each neuron
- Track mean firing rate using exact exponential EMA: $r_{mean}(t+dt) = r_{mean}(t) \cdot e^{-dt/\tau_r} + r_{inst} \cdot (1 - e^{-dt/\tau_r})$
- When $r_{mean} > r_{target}$: scale all incoming weights down by a factor
- When $r_{mean} < r_{target}$: scale all incoming weights up by a factor

```
scale = exp(kappa * (r_target - r_mean) * dt)
w_ij <- w_ij * scale
```

where:
- $r_{inst} = s / dt$ (instantaneous firing rate in Hz, where $s \in \{0, 1\}$ is the spike indicator)
- $\kappa$ is a dimensionless scaling rate
- The scale factor is always positive: $\exp(x) > 0$

**Advantages:**
- Simple to implement
- Global stability mechanism
- **Preserves relative weight ratios** (w1'/w2' = w1/w2) unless clamping occurs
- Naturally bounded (scale > 0, weights clamped to bounds)
- Very compatible with spike-based architecture
- CPU and GPU efficient
- Sign-preserving (excitatory stays excitatory, inhibitory stays inhibitory)
- Zero weights remain zero

**Disadvantages:**
- Requires tracking firing rates (extra state per neuron)
- Less biologically precise (global rate)
- May interfere with STDP if applied too frequently

**Suitability for STARK:** High. Multiplicative synaptic scaling complements STDP well and prevents runaway weights while preserving learned structure. The implementation is straightforward and efficient.

**Critical property for future memory:** if $w_A > w_B$ before homeostasis, then $w_A' > w_B'$ after homeostasis (unless clamping forces one to a bound). This relative weight preservation is essential for maintaining learned representations.

---

### B. Intrinsic Plasticity

**Mathematical Model:**
- Adjust neuronal excitability parameters (threshold, membrane time constant, etc.)
- Track post-synaptic firing rate: $r(t) = \sum_{t_{spike}} \exp(-(t - t_{spike})/\tau_r)$
- Adjust threshold to maintain target rate:

```
theta_0 <- theta_0 - eta * (r - r_target)
```

**Advantages:**
- Works at the neuron level (local)
- Preserves synaptic patterns
- Can compensate for changes in input statistics

**Disadvantages:**
- Requires additional neuronal state (firing rate accumulator)
- More complex than synaptic scaling
- Threshold must stay within bounds

**Suitability for STARK:** Medium. Requires extending NeuralCell to track firing rates, which is more invasive than synaptic scaling.

---

### C. Sliding Threshold (Dynamic Threshold Homeostasis)

**Mathematical Model:**
- Similar to STARK-001's adaptation, but slower timescale
- Track cumulative activity: $a(t) = a(t-1) \cdot (1 - dt/\tau_h) + s(t)$
- Adjust baseline threshold: $\theta_0(t) = \theta_{base} + \beta \cdot (a - a_{target})$

```
theta_0 <- theta_0 + eta * (a - a_target)
```

**Advantages:**
- Natural extension of STARK-001's adaptive threshold
- Slow timescale prevents interference with fast STDP
- Very biologically plausible (cortical pyramidal cells)

**Disadvantages:**
- Modifies NeuralCell parameters (requires API change)
- Must ensure $\theta_0$ stays within bounds

**Suitability for STARK:** Medium-High. This could leverage the existing adaptive threshold mechanism but requires extending NeuralCell to expose its firing rate and allow threshold adjustment.

---

### D. Firing-Rate Homeostasis (Additive Weight Adjustment)

**Mathematical Model:**
- Track exponential moving average of firing rate per neuron
- Apply slow weight updates proportional to activity error

```
r_mean(t) = r_mean(t-1) * (1 - alpha) + r(t) * alpha

w_i <- w_i + eta * (r_target - r_mean)
```

**Advantages:**
- Direct stability mechanism
- Very simple to implement
- Works alongside STDP
- No changes to NeuralCell required

**Disadvantages:**
- Rate estimation requires counting spikes
- Slow timescale (hours in biology, must tune for STARK)

**Suitability for STARK:** Lower than multiplicative scaling. The additive approach flattens learned weight structure over long timescales, which is problematic for future memory formation.

---

### E. BCM-Style Plasticity

**Mathematical Model:**
- BCM (Bieneim-Gardner-Clarke) uses a sliding threshold for potentiation/depression
- Track post-synaptic activity: $y(t)$
- Compute threshold: $\theta_M(t) = \gamma \cdot \overline{y^2}(t)$ (mean of squared activity)
- Weight update:

```
Delta w = eta * y * (y - theta_M)
```

**Advantages:**
- Stable by design (threshold adapts to mean activity)
- Can learn selectivity
- Biologically well-studied

**Disadvantages:**
- Requires tracking $y^2$ (mean of squared activity)
- More complex than simple scaling
- Less direct connection to STDP

**Suitability for STARK:** Medium. The mathematical structure is elegant but may be overcomplicated for STARK-005's goals.

---

## Design Decision for STARK-005

### Recommendation: Multiplicative Synaptic Scaling

**STARK-005 homeostatic mechanism = Multiplicative Synaptic Scaling applied to INCOMING synapses, driven by POSTSYNAPTIC firing rate**

### Rationale:

1. **Minimal API changes**: Only requires adding firing rate tracking to the network and weight scaling to synapses. No changes to NeuralCell are strictly required.

2. **Clean separation of concerns**:
   - STDP handles fast, causal, spike-timing-dependent learning
   - Homeostasis handles slow, rate-based stability

3. **Mathematical stability**: The mechanism directly targets the stability issue — if neurons fire too much, weights scale down; if too little, weights scale up. The multiplicative factor $\exp(\kappa \cdot error \cdot dt)$ is always positive, guaranteeing sign preservation.

4. **Preservation of learned structure**: Unlike additive homeostasis, multiplicative scaling preserves relative weight ratios ($w_1'/w_2' = w_1/w_2$) when no clamping occurs. This is critical for future memory formation.

5. **Compatibility with STARK architecture**:
   - Network can count spikes per neuron during simulation
   - Synapses already have weight bounds via `scaleWeight()`
   - No need to modify NeuralCell

6. **Computational efficiency**: O(N) per timestep for spike counting, plus O(E) weight updates where E is number of edges.

7. **Deterministic**: Like STDP, homeostatic updates can be made fully deterministic.

---

## Timescale Separation

| Process | Timescale | Mechanism |
|---------|-----------|-----------|
| Membrane dynamics | Fast (ms) | Euler integration |
| Synaptic dynamics | Fast (ms) | Euler integration |
| STDP traces | Medium (10-100ms) | Exact exponential decay |
| STDP weight update | Medium (per spike pair) | Immediate |
| Rate estimate | Slow (seconds) | Exact exponential EMA |
| Homeostasis | Very Slow (seconds to minutes) | Multiplicative scaling |

The homeostatic scaling rate $\kappa$ must be small enough that weight changes are gradual compared to STDP updates to prevent interference.

---

## Implementation Plan

### State Variables (per neuron, owned by Network)
- $r_{mean}(t)$: Exponential moving average of firing rate in Hz

### Weight Update Rule
```
r_mean(t) = r_mean(t-1) * exp(-dt/tau_r) + r_inst * (1 - exp(-dt/tau_r))

error = r_target - r_mean

if |error| > hysteresis:
    scale = exp(kappa * error * dt)
    for each incoming synapse to neuron j:
        w_ij <- w_ij * scale
        clamp(w_ij, w_min, w_max)
```

### Alternative: Per-Synapse Homeostasis
For more biological accuracy, homeostasis could be implemented per-synapse with postsynaptic activity dependence, but the simpler multiplicative scaling approach is sufficient for STARK-005.

---

## Expected Behavior

### Case 1: Hyperactive Neuron
- Neuron fires above target rate
- $r_{mean} > r_{target}$
- Error < 0, scale < 1
- Incoming weights decrease multiplicatively

### Case 2: Hypoactive Neuron
- Neuron fires below target rate
- $r_{mean} < r_{target}$
- Error > 0, scale > 1
- Incoming weights increase multiplicatively

### Case 3: STDP + Homeostasis
- STDP learns temporal patterns
- Homeostasis prevents runaway growth
- Both mechanisms can coexist without interference (different timescales)

---

## Known Limitations

1. **Rate estimation lag**: Slow timescale means slow response to activity changes
2. **No spike-timing sensitivity**: Homeostasis cares about rate, not timing
3. **Global target**: All neurons share the same target rate (can be extended)
4. **Hysteresis tuning**: Must be tuned to prevent oscillation
5. **Clamping breaks ratios**: When weights hit bounds, relative structure is altered

---

## Conclusion

Multiplicative synaptic scaling is the optimal choice for STARK-005 because it:

1. Provides essential stability for STDP learning
2. Preserves relative weight structure (critical for future memory)
3. Handles inhibitory and excitatory synapses safely (sign-preserving)
4. Maintains compatibility with STARK's architecture
5. Sets the foundation for future learning extensions
