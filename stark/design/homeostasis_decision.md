# STARK-005 Design Decision: Homeostatic Plasticity Mechanism

## Executive Summary

**STARK-005 homeostatic mechanism = Multiplicative Synaptic Scaling**

This decision adds a slow-timescale stability mechanism to STARK-004's STDP learning rule, preventing runaway weight growth and network instability while preserving STDP's ability to learn temporal patterns and relative weight structure.

---

## Why Homeostatic Plasticity is Needed

### The STDP Problem

STARK-004's pair-based STDP is an unsupervised learning rule that modifies weights based on spike timing:

```
When PRE fires:   Δw = -A_minus * x_post  (LTD)
When POST fires:  Δw = +A_plus * x_pre   (LTP)
```

**Problems:**
1. **Runaway potentiation**: If pre→post pairing is consistently correlated, weights grow without bound (until hitting w_max)
2. **Synaptic silence**: If post→pre pairing dominates, weights decrease (until hitting w_min)
3. **No activity regulation**: STDP doesn't care about overall network activity levels

### The Homeostasis Solution

Homeostatic plasticity provides a counterbalance:

```
If r_mean > r_target: scale DOWN incoming weights (scale < 1)
If r_mean < r_target: scale UP incoming weights (scale > 1)
```

This operates on a **slow timescale** relative to STDP, allowing both mechanisms to coexist.

---

## Chosen Mechanism: Multiplicative Synaptic Scaling

### Mathematical Formulation

**State Variable (per neuron, owned by Network):**

| Variable | Description | Units | Initial |
|----------|-------------|-------|---------|
| $r_{mean}(t)$ | Exponential moving average of firing rate | Hz (spikes/second) | 0.0 |

**Parameters:**

| Parameter | Description | Units | Constraint |
|-----------|-------------|-------|------------|
| $\tau_r$ | Rate estimation time constant | seconds | $\tau_r > 0$ |
| $\kappa$ | Homeostatic scaling rate | dimensionless | $\kappa > 0$ |
| $r_{target}$ | Target firing rate | Hz | $r_{target} \geq 0$ |
| $\varepsilon$ | Hysteresis dead-zone threshold | Hz | $\varepsilon \geq 0$ |

**Firing Rate Estimation (Exact Exponential):**

The continuous-time equation for rate estimation:

$$\tau_r \frac{dr_{mean}}{dt} = -r_{mean} + r(t)$$

Discretized with exact exponential decay for timestep dt:

$$r_{mean}(t+dt) = r_{mean}(t) \cdot e^{-dt/\tau_r} + r_{inst} \cdot (1 - e^{-dt/\tau_r})$$

where $r_{inst} = s(t) / dt$ (Hz) and $s(t) \in \{0, 1\}$ is the spike indicator.

**Homeostatic Scaling:**

For postsynaptic neuron $j$:

$$error_j = r_{target} - r_{mean\_j}$$

If $|error_j| \leq \varepsilon$: $scale_j = 1.0$ (no scaling, within dead zone)

Otherwise:

$$scale_j = \exp(\kappa \cdot error_j \cdot dt)$$

Applied to ALL incoming synapses:

$$w_{ij}' = w_{ij} \cdot scale_j$$

Then clamp: $w_{ij}'' = \text{clamp}(w_{ij}', w_{min}, w_{max})$

**Weight Bounds:**

$$w_{min} \leq w \leq w_{max}$$

**Why multiplicative is superior to additive for STARK:**

The critical property of multiplicative scaling is **relative weight preservation**: if $w_A > w_B$ before homeostasis, and neither hits a bound, then $w_A' / w_B' = w_A / w_B$ after homeostasis. This is essential for future memory formation — learned patterns are preserved up to a global gain factor.

Additive weight adjustment ($w \leftarrow w + \Delta w$) flattens weight distributions over time, destroying learned relative differences.

---

## Postsynaptic Homeostasis (Incoming Synapse Targeting)

### Design Decision: Modify INCOMING synapses

**Rationale:**
- A neuron's firing rate is determined by the sum of inputs it receives
- To increase a neuron's firing rate, we must increase the weights of synapses *driving* that neuron
- To decrease a neuron's firing rate, we must decrease the weights of synapses *driving* that neuron

Therefore, the homeostatic mechanism operates on the synapses **receiving** input to the neuron being regulated.

To control neuron $j$'s firing rate:
- Scale the weights of synapses $i \rightarrow j$ (incoming to $j$)
- Do NOT scale synapses $j \rightarrow k$ (outgoing from $j$)

This directly controls the neuron's excitability through its input currents.

---

## Why Not Other Mechanisms?

### Not Additive Homeostasis (Previous Design)

While additive updates ($w \leftarrow w + \Delta w$) are simpler, they destroy relative weight structure over long timescales. Multiplicative scaling preserves $w_A/w_B$ ratios unless clamping occurs.

### Not Intrinsic Plasticity

Would require extending NeuralCell to track firing rates and adjust threshold. Too invasive for STARK-005's goals.

### Not Sliding Threshold

Similar issues to intrinsic plasticity — requires NeuralCell changes.

### Not BCM-Style

More mathematically elegant but requires tracking $y^2$ (mean of squared activity), which is unnecessary complexity for the minimal stability mechanism.

---

## Interface Design

### Network Additions

```cpp
class Network {
private:
    std::vector<double> r_mean_;              // Per-neuron firing rate estimate (Hz)
    std::vector<double> homeostatic_scale_;   // Per-neuron last scaling factor (diagnostic)
    double homeostasis_tau_r_ = 1.0;          // Rate estimation time constant (seconds)
    double homeostasis_kappa_ = 0.001;        // Homeostatic scaling rate (dimensionless)
    double homeostasis_target_hz_ = 5.0;      // Target firing rate (Hz)
    double homeostasis_hysteresis_hz_ = 0.1;  // Hysteresis threshold (Hz)
    bool homeostasis_enabled_ = false;        // Whether homeostasis is enabled

public:
    void setHomeostasisParameters(double tau_r, double kappa, double target_hz, double hysteresis_hz);
    void homeostaticUpdate(double dt);
    void resetFiringRates();
    
    const std::vector<double>& getFiringRates() const;
    double getHomeostaticScale(size_t neuron_id) const;
    bool isHomeostasisEnabled() const;
    double getHomeostasisTauR() const;
    double getHomeostasisKappa() const;
    double getHomeostasisTargetHz() const;
    double getHomeostasisHysteresisHz() const;
};
```

### Synapse Additions

```cpp
class Synapse {
public:
    // Multiplicative weight scaling (STARK-005 homeostasis)
    // factor must be > 0 and finite; preserves sign, respects bounds.
    void scaleWeight(double factor);
};
```

### NeuralCell (No Changes Required)

NeuralCell continues to provide spike output for counting. No internal changes needed.

---

## Parameter Choices

### Physical Units Analysis

All parameters use physical units:
- Time: seconds
- Rate: Hz (spikes/second)
- kappa: dimensionless

**Dimensional analysis:**
- $\kappa$ is dimensionless
- $error$ is in Hz (1/s)
- $dt$ is in seconds
- $\kappa \cdot error \cdot dt$ is dimensionless ✓
- $\exp(\kappa \cdot error \cdot dt)$ is dimensionless ✓

**Example with dt = 0.001 seconds (1 ms):**

| Parameter | Value | Unit | Effect |
|-----------|-------|------|--------|
| r_target | 5.0 | Hz | Target firing rate |
| tau_r | 1.0 | seconds | Rate estimate integrates over ~1000 timesteps |
| kappa | 0.001 | dimensionless | Weights scale by ~0.1% per second per Hz of error |

In discrete form with dt = 1 ms:
- Rate estimate: $r_{mean} = r_{mean} \cdot \exp(-0.001/\tau_r) + r_{inst} \cdot (1 - \exp(-0.001/\tau_r))$
- Weight scaling: $scale = \exp(\kappa \cdot error \cdot 0.001)$

---

## Expected Behavior

### Case A: Hyperactive Neuron

1. Neuron fires above target rate
2. $r_{mean} > r_{target}$
3. $error = r_{target} - r_{mean} < 0$
4. $scale = \exp(\kappa \cdot error \cdot dt) < 1$
5. Incoming weights decrease multiplicatively
6. Firing rate decreases over time
7. $r_{mean}$ converges toward $r_{target}$

### Case B: Hypoactive Neuron

1. Neuron fires below target rate
2. $r_{mean} < r_{target}$
3. $error = r_{target} - r_{mean} > 0$
4. $scale = \exp(\kappa \cdot error \cdot dt) > 1$
5. Incoming weights increase multiplicatively
6. Firing rate increases over time
7. $r_{mean}$ converges toward $r_{target}$

### Case C: STDP + Homeostasis

1. STDP modifies weights based on spike timing
2. Homeostasis monitors overall firing rates
3. When activity diverges from target, homeostasis applies multiplicative correction
4. Both mechanisms can coexist (different timescales, different mechanisms)

STDP changes weight by $A_+ \cdot x_{pre}$ (additive, based on trace state), while homeostasis scales the resulting weight by a positive factor (multiplicative). They do not interfere as long as $\kappa$ is small relative to STDP's $A_+$.

---

## Timescale Separation

| Process | Timescale | Timescale (ms) | Parameter |
|---------|-----------|-----------------|-----------|
| Membrane (V) | Fast (ms) | ~10-20 | tau_m |
| Synapse (x) | Fast (ms) | ~2-5 | tau_s |
| STDP traces | Medium | ~10-100 | tau_pre, tau_post |
| STDP weight | Medium (per spike pair) | ~instant | A_+, A_- |
| Rate estimate | Slow | ~500-5000 | tau_r |
| Homeostasis | Very Slow | ~seconds to minutes | kappa |

The homeostatic correction per timestep is:

$$\Delta w_{rel} = scale - 1 = \exp(\kappa \cdot error \cdot dt) - 1$$

For small $\kappa \cdot error \cdot dt$:

$$\Delta w_{rel} \approx \kappa \cdot error \cdot dt$$

This means the effective rate of weight change is $\kappa \cdot error$ (per second), which is slow compared to STDP's per-spike updates.

---

## Known Limitations

1. **Rate estimation lag**: Slow timescale means slow response to activity changes
2. **No spike-timing sensitivity**: Homeostasis cares about rate, not timing
3. **Global target**: All neurons share the same target rate (can be extended per-neuron later)
4. **Hysteresis tuning**: $\varepsilon$ must be tuned to prevent oscillation
5. **Clamping breaks ratios**: When weights hit bounds, relative structure is altered until STDP compensates
6. **No structural plasticity**: Cannot create or eliminate synapses (deferred to later phases)

---

## Conclusion

Multiplicative synaptic scaling provides the minimal necessary mechanism to stabilize STDP learning in STARK networks. It adds stability without disrupting the existing architecture, preserves relative weight structure essential for future memory, and sets the stage for more sophisticated learning mechanisms in future phases.
