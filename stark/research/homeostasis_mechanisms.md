# STARK-005 Homeostatic Plasticity Research

## Executive Summary

This document provides a comprehensive comparison of homeostatic plasticity mechanisms for extending STARK-004's STDP learning rule. Based on the analysis, we recommend **Multiplicative Synaptic Scaling** applied to incoming synapses of the postsynaptic neuron, driven by a physical firing-rate estimate in Hz.

---

## Background: The Problem STARK-004 Solves

STARK-004 implemented pair-based STDP (Spike-Timing-Dependent Plasticity):

```
When PRE fires:   Δw = -A_minus * x_post  (LTD)
When POST fires:  Δw = +A_plus * x_pre   (LTP)
```

**STDP is unsupervised** — it strengthens connections where pre fires before post, weakens where post fires before pre. This is excellent for learning temporal patterns but has a critical limitation:

**STDP alone cannot guarantee stable network activity.**

Without homeostatic control, STDP can lead to:
- Runaway potentiation (weights → w_max)
- Synaptic silence (weights → w_min)
- Oscillatory or chaotic dynamics

---

## The Homeostatic Plasticity Solution

Homeostatic plasticity provides a counterbalance:

```
If firing_rate > target: scale DOWN all incoming weights (scale < 1)
If firing_rate < target: scale UP all incoming weights (scale > 1)
```

This operates on a **slow timescale** relative to STDP, allowing both mechanisms to coexist.

---

## Mechanism Comparison

### 1. Multiplicative Synaptic Scaling (CHOSEN)

**Mathematical Model:**
```
r_inst = spike ? 1/dt : 0                        [Hz]
r_mean(t+dt) = r_mean(t) * exp(-dt/tau_r) + r_inst * (1 - exp(-dt/tau_r))  [Hz]

error = r_target - r_mean                          [Hz]

if |error| > hysteresis:
    scale = exp(kappa * error * dt)                [dimensionless, always > 0]
    for each incoming synapse:
        w <- w * scale
        clamp(w, w_min, w_max)
```

**Key properties:**
- `scale > 0` always (exp is always positive)
- Sign preservation: w > 0 → w*scale > 0; w < 0 → w*scale < 0; w = 0 → w*scale = 0
- Ratio preservation: w1'/w2' = w1/w2 (unless clamping occurs)

**Advantages:**
- Simple to implement
- Preserves relative weight ratios (learned structure)
- Scale factor is always positive (sign-preserving)
- Naturally bounded (scale > 0, weights clamped)
- Very compatible with spike-based architecture
- CPU and GPU efficient

**Disadvantages:**
- Requires tracking firing rates (extra state per neuron)
- May interfere with STDP if applied too frequently

**STARK Suitability: Very High.**

The multiplicative approach is chosen for STARK-005 because:
1. It is the simplest mechanism that provides the required stability
2. Weight bounds [w_min, w_max] already constrain the system
3. The slow timescale prevents destructive interference with STDP
4. Relative weight ratios are preserved, critical for future memory formation
5. It is easily testable and verifiable

---

### 2. Postsynaptic Homeostasis (Incoming Synapse Targeting)

**Key Design Decision:** Homeostasis modifies **incoming** synapses, not outgoing synapses.

**Rationale:**
- A neuron's firing rate is determined by the sum of inputs it receives
- To increase a neuron's firing rate, we must increase the weights of synapses *driving* that neuron
- To decrease a neuron's firing rate, we must decrease the weights of synapses *driving* that neuron

Therefore, the homeostatic mechanism operates on the synapses **receiving** input to the neuron being regulated.

**Mathematical Model:**
```
For neuron j with r_mean(j) < r_target:
    error_j = r_target - r_mean_j > 0
    scale_j = exp(kappa * error_j * dt) > 1
    for each incoming synapse i->j:
        w_ij <- w_ij * scale_j   (w increases)

For neuron j with r_mean(j) > r_target:
    error_j = r_target - r_mean_j < 0
    scale_j = exp(kappa * error_j * dt) < 1
    for each incoming synapse i->j:
        w_ij <- w_ij * scale_j   (w decreases)
```

**Advantages:**
- Direct control over the neuron's excitability
- Intuitive cause-effect relationship
- Preserves outgoing connectivity structure

**Disadvantages:**
- Requires access to incoming synapse list (already available in Network)

---

### 3. Intrinsic Plasticity

**Mathematical Model:**
```
theta_0(t) = theta_0(t-1) - eta * (r - r_target)
```

**Pros:**
- Works at the neuron level
- Preserves synaptic patterns
- Can compensate for changes in input statistics

**Cons:**
- Requires extending NeuralCell to track firing rates
- Must expose threshold adjustment API
- More complex than synaptic scaling

**STARK Suitability: Medium.** Requires modifying NeuralCell.

---

### 4. Sliding Threshold (Dynamic Threshold Homeostasis)

**Mathematical Model:**
```
theta_0(t) = theta_0(t-1) + eta * (a - a_target)
```
where $a$ is the adaptation state from STARK-001.

**Pros:**
- Natural extension of STARK-001's adaptive threshold
- Slow timescale
- Biologically well-studied (cortical pyramidal cells)

**Cons:**
- Modifies NeuralCell parameters (requires API change)
- Must ensure $\theta_0$ stays within bounds

**STARK Suitability: Medium-High.** Could leverage existing adaptive threshold but requires NeuralCell changes.

---

### 5. BCM-Style Plasticity

**Mathematical Model:**
```
theta_M = gamma * mean(y^2)
Delta w = eta * y * (y - theta_M)
```

**Pros:**
- Stable by design (threshold adapts to mean activity)
- Can learn selectivity
- Biologically well-stududied

**Cons:**
- Requires tracking $y^2$ (mean of squared activity)
- More complex than simple scaling
- Less direct connection to STDP

**STARK Suitability: Medium.** Overcomplicated for STARK-005.

---

## Implementation Strategy

### Step 1: Network State

```cpp
class Network {
private:
    std::vector<double> r_mean_;          // Per-neuron firing rate estimate (Hz)
    std::vector<double> homeostatic_scale_; // Per-neuron last scaling factor (diagnostic)
    double homeostasis_tau_r_;            // Rate estimation time constant (seconds)
    double homeostasis_kappa_;            // Homeostatic scaling rate (dimensionless)
    double homeostasis_target_hz_;        // Target firing rate (Hz)
    double homeostasis_hysteresis_hz_;    // Hysteresis dead-zone threshold (Hz)
    bool homeostasis_enabled_;            // Whether homeostasis is enabled

public:
    void setHomeostasisParameters(double tau_r, double kappa, double target_hz, double hysteresis_hz);
    void homeostaticUpdate(double dt);
    void resetFiringRates();
    
    const std::vector<double>& getFiringRates() const;
    double getHomeostaticScale(size_t neuron_id) const;
};
```

### Step 2: Spike Detection

During `Network::step()`, `spikes_this_step_` records which neurons spiked in the current timestep.

### Step 3: Physical-Hz Rate Update

After STDP updates, update rate estimates using exact exponential decay:
```cpp
double r_inst = spike ? 1.0 / dt : 0.0;  // Hz
double decay = std::exp(-dt / tau_r);
r_mean = r_mean * decay + r_inst * (1.0 - decay);
```

### Step 4: Multiplicative Weight Scaling

Apply homeostatic updates:
```cpp
double error = target_hz - r_mean;
if (std::abs(error) > hysteresis_hz) {
    double scale = std::exp(kappa * error * dt);
    for (synapse_id : incoming_synapses[j]) {
        synapses_[synapse_id].scaleWeight(scale);
    }
}
```

### Step 5: Synapse API

```cpp
class Synapse {
public:
    void scaleWeight(double factor);  // multiplicative, sign-preserving, clamped
};
```

---

## Timescale Separation

| Process | Timescale | Parameter | Physical Units |
|---------|-----------|-----------|----------------|
| Membrane (V) | Fast (ms) | tau_m | seconds |
| Synapse (x) | Fast (ms) | tau_s | seconds |
| STDP traces | Medium (10-100ms) | tau_pre, tau_post | seconds |
| STDP weight | Medium (per spike pair) | A_+, A_- | dimensionless |
| Rate estimate | Slow (seconds) | tau_r | seconds |
| Homeostasis | Very Slow (seconds to minutes) | kappa | dimensionless |

The homeostatic scaling rate $\kappa$ must be small enough that weight changes are gradual compared to STDP updates.

---

## Parameter Choices

| Parameter | Value | Unit | Rationale |
|-----------|-------|------|-----------|
| r_target | 5.0 | Hz | Typical biological cortical firing rate |
| tau_r | 0.5-5.0 | seconds | Smooths over multiple timesteps |
| kappa | 0.01-1.0 | dimensionless | Controls scaling speed |
| hysteresis | 0.1-1.0 | Hz | Prevents oscillation near target |

---

## Expected Behavior

### Case A: Hyperactive Neuron
1. Neuron fires above target rate
2. r_mean > r_target
3. Error = r_target - r_mean < 0
4. scale = exp(kappa * error * dt) < 1
5. Incoming weights decrease multiplicatively
6. Firing rate decreases over time
7. r_mean converges toward r_target

### Case B: Hypoactive Neuron
1. Neuron fires below target rate
2. r_mean < r_target
3. Error = r_target - r_mean > 0
4. scale = exp(kappa * error * dt) > 1
5. Incoming weights increase multiplicatively
6. Firing rate increases over time
7. r_mean converges toward r_target

### Case C: STDP + Homeostasis
1. STDP modifies weights based on spike timing
2. Homeostasis monitors overall firing rates
3. When activity diverges from target, homeostasis applies multiplicative correction
4. Both mechanisms can coexist (different timescales, different mechanisms)

---

## Known Limitations

1. **Rate estimation lag**: Slow timescale means slow response to activity changes
2. **No spike-timing sensitivity**: Homeostasis cares about rate, not timing
3. **Global target**: All neurons share the same target rate (can be extended)
4. **Hysteresis tuning**: Must be tuned to prevent oscillation
5. **Clamping breaks ratios**: When weights hit bounds, relative structure is altered until STDP compensates

---

## Conclusion

Multiplicative synaptic scaling is the optimal choice for STARK-005 because it:

1. Provides essential stability for STDP learning
2. Preserves relative weight structure (critical for future memory)
3. Handles inhibitory and excitatory synapses safely (sign-preserving)
4. Maintains compatibility with STARK's architecture
5. Sets the foundation for future learning extensions
