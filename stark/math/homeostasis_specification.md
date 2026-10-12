# STARK-005 Homeostatic Plasticity Specification

This document is the authoritative mathematical specification for the multiplicative synaptic scaling mechanism implemented in STARK-005. It matches the actual C++ implementation exactly (`src/neural/Network.cpp`, `src/neural/Synapse.cpp`).

**Model class:** Multiplicative Synaptic Scaling with Firing-Rate Homeostasis

**Causal principle:**
- High firing rate → decrease incoming weights (scale < 1)
- Low firing rate → increase incoming weights (scale > 1)
- Target firing rate is maintained through gradual multiplicative adjustments
- Sign is always preserved (excitatory stays excitatory, inhibitory stays inhibitory)

---

## 1. State Variables

### Per-Neuron State (owned by Network)

| Variable | Description | Units | Initial |
|----------|-------------|-------|---------|
| $r_{mean}(t)$ | Exponential moving average of firing rate | Hz (spikes/second) | 0.0 |
| $scale_{last}(t)$ | Last homeostatic scaling factor applied | dimensionless | 1.0 |

### Per-Synapse State (owned by Synapse, unchanged from STARK-004)

| Variable | Description | Initial |
|----------|-------------|---------|
| $w$ | Synaptic weight | $w_{init}$ |
| $x$ | Synaptic current state (STARK-002, Euler) | 0.0 |
| $x_{pre}$ | Pre-synaptic trace (STARK-004) | 0.0 |
| $x_{post}$ | Post-synaptic trace (STARK-004) | 0.0 |

### Per-Neuron State (owned by NeuralCell, unchanged from STARK-001)

| Variable | Description | Initial |
|----------|-------------|---------|
| $V$ | Membrane potential | $V_{reset}$ |
| $a$ | Adaptation state | 0.0 |
| $\theta$ | Adaptive threshold | $\theta_0$ |

---

## 2. Parameters

### Homeostatic Parameters (STARK-005)

| Parameter | Description | Units | Constraint |
|-----------|-------------|-------|------------|
| $\tau_r$ | Rate estimation time constant | seconds | $\tau_r > 0$, finite |
| $\kappa$ | Homeostatic scaling rate | dimensionless | $\kappa > 0$, finite |
| $r_{target}$ | Target firing rate | Hz | $r_{target} \geq 0$, finite |
| $\varepsilon$ | Hysteresis dead-zone threshold | Hz | $\varepsilon \geq 0$, finite |

### Synaptic Parameters (unchanged from STARK-002)

| Parameter | Description | Constraint |
|-----------|-------------|------------|
| $w_{min}$ | Lower weight bound | finite, sign-appropriate |
| $w_{max}$ | Upper weight bound | $w_{max} \geq w_{min}$, sign-appropriate |

Default bounds derived from initial weight sign:
- $w > 0$: $[0, +\max(1, |w|)]$
- $w < 0$: $[-\max(1, |w|), 0]$
- $w = 0$: $[-\max(1, |w|), +\max(1, |w|)]$

### Neuronal Parameters (unchanged from STARK-001)

| Parameter | Description | Constraint |
|-----------|-------------|------------|
| $\tau_m$ | Membrane time constant | $\tau_m > 0$ |
| $\theta_0$ | Baseline threshold | $\theta_0 \geq 0$ |
| $\tau_a$ | Adaptation time constant | $\tau_a > 0$ |
| $b$ | Adaptation increment | $b \geq 0$ |
| $V_{reset}$ | Reset potential | finite |

---

## 3. Update Rules

### 3.1 Synaptic Current Update (unchanged from STARK-002, Euler)

```
x <- x * (1 - dt/tau_s) + s_pre
I_post = w * x
```

This is the **Euler discretization** of `dx/dt = -x/tau_s + s_pre`. Constraint: $0 < dt < \tau_s$.

### 3.2 Neuronal Update (unchanged from STARK-001)

```
V_temp = V * (1 - dt/tau_m) + I*dt
s      = 1 if V_temp >= theta, else 0    (theta from previous step)
a      = a*(1 - dt/tau_a) + b*s
theta  = theta_0 + a
V      = V_reset if s else V_temp
```

Constraint: $0 < dt < \min(\tau_m, \tau_a)$.

### 3.3 STDP Trace Decay (unchanged from STARK-004, exact exponential)

```
x_pre  <- x_pre  * exp(-dt/tau_pre)
x_post <- x_post * exp(-dt/tau_post)
```

No upper bound on dt from these equations (exact exponential is stable for all $dt > 0$).

### 3.4 STDP Weight Update (unchanged from STARK-004)

```
When a PRE-synaptic spike occurs:
    x_pre += 1
    dw_LTD = -A_minus * x_post

When a POST-synaptic spike occurs:
    x_post += 1
    dw_LTP = +A_plus * x_pre

w <- clamp(w + dw, w_min, w_max)
```

### 3.5 Firing Rate Estimation (STARK-005, exact exponential)

**Instantaneous physical firing rate:**

$$r_{inst}(t) = \frac{s(t)}{dt}$$

where $s(t) \in \{0, 1\}$ is the spike indicator and $dt$ is in seconds. This gives units of Hz (spikes/second).

**Exact exponential EMA:**

$$r_{mean}(t+dt) = r_{mean}(t) \cdot e^{-dt/\tau_r} + r_{inst}(t) \cdot (1 - e^{-dt/\tau_r})$$

This is the exact discrete solution of $\tau_r \cdot dr_{mean}/dt = -r_{mean} + r(t)$.

### 3.6 Homeostatic Scaling (STARK-005, multiplicative)

For postsynaptic neuron $j$:

$$\text{error}_j = r_{target} - r_{mean\_j}$$

**Dead zone (hysteresis):**

If $|\text{error}_j| \leq \varepsilon$: $scale_j = 1.0$ (no scaling)

Otherwise:

$$scale_j = \exp(\kappa \cdot \text{error}_j \cdot dt)$$

**Apply to all incoming synapses:**

$$w_{ij}' = w_{ij} \cdot scale_j$$

**Clamp to bounds:**

$$w_{ij}'' = \text{clamp}(w_{ij}', w_{min\_ij}, w_{max\_ij})$$

**Key properties:**
- $scale_j > 0$ always (exp is always positive)
- Sign preservation: $w > 0 \Rightarrow w' > 0$; $w < 0 \Rightarrow w' < 0$; $w = 0 \Rightarrow w' = 0$
- Ratio preservation: $w_1'/w_2' = w_1/w_2$ (before clamping)

---

## 4. Timestep Ordering (matches Network::step() exactly)

Within a single timestep, the implementation performs, in this exact order:

1. **Decay STDP traces** — `decayTraces(dt)` on every synapse (`x_pre`, `x_post` multiplied by exact exponential decay factors).
2. **Compute neuron inputs** — external input + synaptic current `w * x` from previous timestep's delivered spikes.
3. **Update neurons** — `NeuralCell::update()` collects spikes. For every neuron that spikes, `updatePostTrace()` is called on all its *incoming* synapses (`x_post += 1`).
4. **Deliver pre spikes** — for every neuron that spiked, `receiveSpike(true,dt)` is called on all its *outgoing* synapses (incrementing `x_pre` and updating synaptic state `x`). Non-spiking neurons call `receiveSpike(false,dt)` to decay `x`.
5. **Apply STDP** — for every synapse:
   - if post neuron spiked → `applyLTP()` ($\Delta w = +A_+ \cdot x_{pre}$)
   - if pre neuron spiked → `applyLTD()` ($\Delta w = -A_- \cdot x_{post}$)
   - weight clamped to $[w_{min}, w_{max}]$ after each update.
6. **Update physical-Hz firing-rate EMA** — exact exponential update of $r_{mean}$ for each neuron using $r_{inst} = s/dt$.
7. **Apply homeostatic scaling** — multiplicative weight adjustments based on firing rate error, applied to incoming synapses.
8. **Process delayed deliveries** — spikes scheduled via transmission delay that arrive at the new timestep are delivered.
9. **Advance timestep** and clear external inputs.

**Key consequence:** Homeostatic updates occur AFTER STDP updates in the same timestep, preventing interference between the two learning mechanisms. STDP modifies weight additively (via traces), then homeostasis scales the resulting weight multiplicatively.

---

## 5. Invariants

### Synaptic invariants (unchanged from STARK-004)

1. **Weight bounds:** $w_{min} \leq w \leq w_{max}$ (enforced by clamping).
2. **Trace non-negativity:** $x_{pre} \geq 0$, $x_{post} \geq 0$.
3. **Synaptic state non-negativity:** $x \geq 0$ (Euler, requires $dt < \tau_s$).
4. **Finiteness:** $w$, $x_{pre}$, $x_{post}$, $x$ are all finite.

### Homeostatic invariants

1. **Rate non-negativity:** $r_{mean} \geq 0$ always (since $r_{inst} \geq 0$ and exponential decay preserves non-negativity).
2. **Scale positivity:** $scale > 0$ always (exp of any real number is positive).
3. **Sign preservation:** $sign(w_{new}) = sign(w_{old})$ when $scale > 0$ and no clamping occurs.
4. **Zero-weight preservation:** $w = 0 \Rightarrow w \cdot scale = 0$ (exactly zero).
5. **Relative ratio preservation:** $w_1'/w_2' = w_1/w_2$ when neither is clamped.
6. **Weight bounds preserved:** Clamping ensures $w_{min} \leq w \leq w_{max}$.
7. **Finiteness:** $r_{mean}$ and $scale$ are finite for finite, validated parameters.

---

## 6. Numerical Constraints

### Firing Rate Estimation

The exact exponential update $r_{mean}(t+dt) = r_{mean}(t) \cdot e^{-dt/\tau_r} + r_{inst}(t) \cdot (1 - e^{-dt/\tau_r})$ is stable and bounded for all $dt > 0$ and $\tau_r > 0$.

Since $r_{inst} \geq 0$:
- Maximum $r_{mean}$ occurs with sustained spiking at rate $1/dt$: $r_{mean} \to 1/dt$ as $t \to \infty$.
- Minimum $r_{mean}$ occurs with no spikes: $r_{mean} \to 0$ as $t \to \infty$.

**No constraint on dt from rate estimation.** Only $dt > 0$ and $\tau_r > 0$ required.

### Homeostatic Scaling

The scaling factor $scale = \exp(\kappa \cdot error \cdot dt)$ is always positive and finite for finite, validated parameters.

**Dimensional analysis:**
- $\kappa$: dimensionless
- $error$: Hz = $1/\text{seconds}$
- $dt$: seconds
- $\kappa \cdot error \cdot dt$: dimensionless ✓

To prevent overflow in $exp()$:
- If $|\kappa \cdot error \cdot dt| > 700$, the scale would overflow/underflow
- The implementation guards against non-finite results

### Combined Constraint

The network validates $dt$ against:
1. Neuron constraint: $0 < dt < \min(\tau_m, \tau_a)$
2. Synapse constraint: $0 < dt < \tau_s$

The homeostatic EMA and scaling have no upper bound on $dt$.

---

## 7. Numerical Examples

### Example 1: Rate Estimation with Exact Exponential

Parameters:
- $\tau_r = 1.0$ seconds
- $dt = 0.1$ seconds (100 ms)
- Decay factor: $e^{-0.1/1.0} = e^{-0.1} \approx 0.904837$
- $\alpha = 1 - 0.904837 = 0.095163$

Neuron fires every step (s=1 every timestep):
- $r_{inst} = 1/0.1 = 10$ Hz each step
- Step 1: $r_{mean} = 0 \cdot 0.9048 + 10 \cdot 0.0952 = 0.9516$ Hz
- Step 2: $r_{mean} = 0.9516 \cdot 0.9048 + 10 \cdot 0.0952 = 0.8611 + 0.9516 = 1.8127$ Hz
- ...converges to 10 Hz

Neuron fires once, then stops:
- Step after spike: $r_{mean} = r_{prev} \cdot 0.9048$ (decays toward 0)

### Example 2: Homeostatic Down-Scaling (Hyperactive)

Parameters:
- $\tau_r = 0.5$ s, $\kappa = 0.05$, $r_{target} = 5$ Hz, $\varepsilon = 0$
- $dt = 0.1$ s

Neuron fires every step: $r_{inst} = 10$ Hz
After 50 steps: $r_{mean} \approx 10$ Hz
$error = 5 - 10 = -5$ Hz
$scale = \exp(0.05 \cdot (-5) \cdot 0.1) = \exp(-0.025) \approx 0.9753$

Weight update: $w' = w \cdot 0.9753$ (decreases)

### Example 3: Homeostatic Up-Scaling (Hypoactive)

Parameters:
- $\tau_r = 0.5$ s, $\kappa = 0.05$, $r_{target} = 5$ Hz, $\varepsilon = 0$
- $dt = 0.1$ s

Neuron does not fire: $r_{inst} = 0$ Hz
After 50 steps: $r_{mean} \approx 0$ Hz
$error = 5 - 0 = 5$ Hz
$scale = \exp(0.05 \cdot 5 \cdot 0.1) = \exp(0.025) \approx 1.0253$

Weight update: $w' = w \cdot 1.0253$ (increases)

### Example 4: Ratio Preservation

Two incoming weights: $w_1 = 0.2$, $w_2 = 0.5$
Ratios before: $w_2/w_1 = 2.5$

If $scale = 1.1$ (up-scaling) and neither hits bounds:
- $w_1' = 0.2 \cdot 1.1 = 0.22$
- $w_2' = 0.5 \cdot 1.1 = 0.55$
- $w_2'/w_1' = 0.55/0.22 = 2.5$ ✓ (preserved)

If $w_2$ hits $w_{max} = 1.0$:
- $w_1' = 0.2 \cdot 1.1 = 0.22$
- $w_2' = \min(0.55, 1.0) = 0.55$ (no clamping yet)
- $w_2'/w_1' = 2.5$ ✓ (still preserved)

If scaling continues until $w_2$ hits bound:
- $w_2' = 1.0$ (clamped), $w_1' = 0.2 \cdot scale_{final}$
- $w_2'/w_1' > 2.5$ (ratio altered by clamping)

### Example 5: Sign Preservation

Weights: $w_{exc} = +0.5$, $w_{inh} = -0.4$
$scale = 0.9$ (down-scaling due to hyperactivity)

- $w_{exc}' = 0.5 \cdot 0.9 = 0.45 > 0$ ✓ (excitatory stays excitatory)
- $w_{inh}' = -0.4 \cdot 0.9 = -0.36 < 0$ ✓ (inhibitory stays inhibitory)

### Example 6: Zero-Weight Preservation

$w = 0.0$
$scale = 1.5$ (up-scaling)
$w' = 0.0 \cdot 1.5 = 0.0$ ✓ (zero stays exactly zero)

---

## 8. Deterministic Behavior

The homeostatic update is deterministic and reproducible given:

1. The same initial network state
2. The same input sequence
3. The same timestep $dt$

No stochasticity is introduced in STARK-005.

---

## 9. Interaction with STDP

### Timescale Separation

| Mechanism | Timescale | Effect |
|-----------|-----------|--------|
| STDP | Fast (per spike pair) | Weight changes based on spike timing |
| Homeostasis | Slow (integrated over seconds) | Weight scaling based on firing rate |

### Non-interference

STDP changes weights by $A_+ \cdot x_{pre}$ (additive, based on traces), while homeostasis scales the resulting weight by a positive factor. They apply sequentially in each timestep:

1. STDP modifies $w \leftarrow w + \Delta w_{STDP}$
2. Homeostasis scales $w \leftarrow w \cdot scale$

This is mathematically valid: the final weight is the STDP-modulated weight scaled by a positive factor. Relative STDP changes are preserved.

### Order of Operations

As documented in Section 4:
1. STDP updates weights based on spike timing
2. Homeostasis scales the resulting weights based on firing rate
3. Both can apply to the same synapse in the same timestep

Result: $w_{final} = \text{clamp}(\text{clamp}(w + \Delta w_{STDP}, w_{min}, w_{max}) \cdot scale, w_{min}, w_{max})$

---

## 10. Stability Analysis

### Bounded Rate Estimate

Since $r_{inst} \geq 0$ and the exact exponential update is a convex combination:

$$0 \leq r_{mean}(t) \leq r_{inst\_max}$$

Proof by induction:
- Base: $r_{mean}(0) = 0 \geq 0$
- Inductive: if $0 \leq r_{mean}(t-1) \leq r_{inst\_max}$, then
  $$0 \leq r_{mean}(t) = r_{mean}(t-1) \cdot e^{-dt/\tau_r} + r_{inst}(t) \cdot (1 - e^{-dt/\tau_r})$$
  since $e^{-dt/\tau_r} \in (0,1)$ and $r_{inst} \geq 0$.

### Bounded Scaling Factor

The scaling factor $\exp(\kappa \cdot error \cdot dt)$ is always positive ($> 0$).

With validated parameters ($\kappa > 0$, finite error, finite $dt$), the exponent is finite, so the scale is finite and positive.

### Bounded Weight Updates

Multiplicative scaling: $|w'| = |w| \cdot scale$. Combined with clamping:

$$w_{min} \leq w' \leq w_{max}$$

### Convergence

Under reasonable assumptions (sufficient input variability, stable network dynamics), $r_{mean}$ will converge to $r_{target}$ as weights adjust. The multiplicative nature ensures smooth, gradual correction without oscillation (aided by hysteresis).

---

## 11. Implementation Notes

### Spike Counting

The network records spikes per neuron during each timestep in `spikes_this_step_`. The firing rate is computed from this:

```cpp
double r_inst = spikes_this_step_[i] ? 1.0 / dt : 0.0;  // Hz
double decay = std::exp(-dt / tau_r);
r_mean_[i] = r_mean_[i] * decay + r_inst * (1.0 - decay);
```

### Physical Units

All parameters use physical units:
- Time: seconds
- Rate: Hz (spikes/second)
- Weight: dimensionless
- kappa: dimensionless

### Hysteresis Threshold

The $\varepsilon$ threshold prevents oscillation around $r_{target}$. If $\varepsilon = 0$, small fluctuations could cause continuous weight adjustments. A small positive $\varepsilon$ creates a "dead zone" around the target.

### Synapse API

`Synapse::scaleWeight(factor)` multiplies the weight by a positive factor and clamps to bounds. This is the ONLY weight-modification operation used by STARK-005 homeostasis. It preserves sign and respects the configured bounds.

### Weight Bounds

Default bounds are derived from the initial weight's sign:
- Positive weight → $[0, +\max(1, |w|)]$
- Negative weight → $[-\max(1, |w|), 0]$
- Zero weight → $[-\max(1, |w|), +\max(1, |w|)]$

When `setPlasticityParameters` is called (STDP enabled), explicit bounds override defaults.

`scaleWeight` always clamps to the current bounds, preserving the appropriate sign range.
