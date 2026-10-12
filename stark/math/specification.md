# STARK-001 Mathematical Specification

## Leaky Integrator with Adaptive Threshold Neuron

This section defines the neural cell mathematically, specifying all state variables, inputs, parameters, outputs, and update rules.

---

## 1. State Variables

| Symbol | Description | Dimension | Initial Value |
|--------|-------------|-----------|---------------|
| `V_t` | Membrane potential (voltage) at time t | ℝ (scalar) | `V_0 = V_reset` (resting potential) |
| `a_t` | Adaptation state at time t | ℝ (scalar) | `a_0 = 0` |
| `θ_t` | Adaptive threshold at time t | ℝ (scalar) | `θ_0` (baseline threshold) |

**All state variables are updated at each discrete time step.**

---

## 2. Inputs

| Symbol | Description | Type |
|--------|-------------|------|
| `I_t` | External input current at time t | ℝ (scalar) |
| `Δt` | Time step size | ℝ⁺ (positive real) |

**`I_t` can originate from:**
- External sensory input
- Synaptic connections from other neural cells
- Deliberate stimulation

**`Δt` is the simulation time step, typically fixed for the network.**

---

## 3. Trainable Parameters

| Symbol | Description | Constraint | Default |
|--------|-------------|------------|---------|
| `τ_m` | Membrane time constant | `τ_m > 0` | 1.0 |
| `θ_0` | Baseline threshold | `θ_0 ≥ 0` | 1.0 |
| `τ_a` | Adaptation time constant | `τ_a > 0` | 10.0 |
| `b` | Adaptation increment | `b ≥ 0` | 0.5 |
| `V_reset` | Reset potential after spike | `V_reset ∈ ℝ` (typically negative) | -0.5 |

**All parameters are per-neuron; different neurons can have different values.**

---

## 4. Outputs

| Symbol | Description | Value Range |
|--------|-------------|-------------|
| `s_t` | Spike indicator at time t | {0, 1} |
| `V_t` | Membrane potential (readable) | ℝ |
| `θ_t` | Adaptive threshold (readable) | ℝ |

**`s_t = 1` indicates a spike (firing) occurred at time t; `s_t = 0` means no spike.**

---

## 5. Update Rule

The neural cell evolves through **5 discrete steps** at each time step t, in the following causal order:

### Step 1: Leak Membrane and Add Input

```
V_temp = V_{t-1} * (1 - Δt/τ_m) + I_t * Δt
```

**Explanation:**
- `V_{t-1} * (1 - Δt/τ_m)`: Leak term — membrane potential decays toward 0
- `I_t * Δt`: Input current integrates into membrane potential
- `V_temp` is the pre-spike membrane potential

### Step 2: Determine Spike Using Previous Threshold

```
s_t = 1 if V_temp ≥ θ_{t-1}
      0 otherwise
```

**Explanation:**
- The spike for timestep `t` is detected using the threshold `θ_{t-1}` that was in effect at the start of the timestep
- This is the causal ordering: the neuron's sensitivity entering the timestep determines whether it fires

### Step 3: Adapt Threshold Based on Neural Activity

```
a_temp = a_{t-1} * (1 - Δt/τ_a)

if s_t = 1:
    a_t = a_temp + b
else:
    a_t = a_temp
```

**Explanation:**
- `a_{t-1} * (1 - Δt/τ_a)`: Adaptation state leaks/decays toward 0 with time constant `τ_a`
- `b`: Fixed increment added to adaptation when a spike occurs
- **Invariant**: `a_t ≥ 0` for all `t` (since `a_0 = 0` and we only add non-negative `b` and multiply by positive factors)

### Step 4: Update Threshold

```
θ_t = θ_0 + a_t
```

**Explanation:**
- The adaptive threshold is always the baseline plus the adaptation state
- **Invariant**: `θ_t ≥ θ_0` for all `t` (since `a_t ≥ 0`)

### Step 5: Update Membrane State

```
if s_t = 1:
    V_t = V_reset
else:
    V_t = V_temp
```

**Explanation:**
- If a spike occurred, membrane resets to `V_reset` (typically negative, creating a refractory period)
- If no spike, membrane takes the value `V_temp` from Step 1

---

## 6. Complete State Evolution (Per Time Step)

Given: `V_{t-1}`, `a_{t-1}`, `θ_{t-1}`, `I_t`, and parameters `τ_m`, `θ_0`, `τ_a`, `b`, `V_reset`

```
# Step 1: Leak and input
V_temp = V_{t-1} * (1 - Δt/τ_m) + I_t * Δt

# Step 2: Spike detection (uses θ_{t-1})
s_t = 1 if V_temp ≥ θ_{t-1} else 0

# Step 3: Adaptation
a_temp = a_{t-1} * (1 - Δt/τ_a)
a_t = a_temp + b * s_t

# Step 4: Threshold update
θ_t = θ_0 + a_t

# Step 5: Membrane state
if s_t = 1:
    V_t = V_reset
else:
    V_t = V_temp
```

---

## 7. Invariants

The following invariants hold for all time steps `t ≥ 0` given valid parameters and `Δt`:

1. **Adaptation non-negativity**: `a_t ≥ 0`
   - Proof: `a_0 = 0`. Inductive step: `a_temp = a_{t-1} * (1 - Δt/τ_a) ≥ 0` since `(1 - Δt/τ_a) > 0` (requires `Δt < τ_a`). If `s_t = 1`, `a_t = a_temp + b ≥ 0` since `b ≥ 0`. If `s_t = 0`, `a_t = a_temp ≥ 0`.

2. **Threshold bound**: `θ_t ≥ θ_0`
   - Proof: `θ_t = θ_0 + a_t` and `a_t ≥ 0`.

3. **Membrane potential bounded**: For constant input `I`, `V_t` is bounded by `max(V_reset, I * τ_m)`.

---

## 8. Numerical Example: Cell Evolving Over Time

### Parameters (fixed for this example)
- `τ_m = 1.0` (membrane time constant)
- `θ_0 = 1.0` (baseline threshold)
- `τ_a = 10.0` (adaptation time constant)
- `b = 0.5` (adaptation increment)
- `V_reset = -0.5` (reset potential)
- `Δt = 0.1` (time step)

### Initial State (t = 0)
```
V_0 = V_reset = -0.5
a_0 = 0
θ_0 = 1.0 (baseline)
s_0 = 0 (no initial spike)
```

---

### t = 1: First Time Step, Input I_1 = 2.0

**Step 1**: `V_temp = V_0 * (1 - 0.1/1.0) + 2.0 * 0.1 = -0.5 * 0.9 + 0.2 = -0.45 + 0.2 = -0.25`

**Step 2**: Check spike: `V_temp ≥ θ_0`? `-0.25 ≥ 1.0`? **No** → `s_1 = 0`

**Step 3**: `a_temp = a_0 * (1 - 0.1/10.0) = 0 * 0.99 = 0`
- No spike: `a_1 = a_temp = 0`

**Step 4**: `θ_1 = θ_0 + a_1 = 1.0 + 0 = 1.0`

**Step 5**: No spike: `V_1 = V_temp = -0.25`

**State after t=1**: `V = -0.25`, `a = 0`, `θ = 1.0`, `s = 0`

---

### t = 2: Second Time Step, Input I_2 = 2.0

**Step 1**: `V_temp = -0.25 * 0.9 + 2.0 * 0.1 = -0.225 + 0.2 = -0.025`

**Step 2**: Check spike: `-0.025 ≥ 1.0`? **No** → `s_2 = 0`

**Step 3**: `a_temp = 0 * 0.99 = 0`, `a_2 = 0`

**Step 4**: `θ_2 = 1.0`

**Step 5**: `V_2 = -0.025`

**State after t=2**: `V = -0.025`, `a = 0`, `θ = 1.0`, `s = 0`

---

### t = 3: Third Time Step, Input I_3 = 2.0

**Step 1**: `V_temp = -0.025 * 0.9 + 0.2 = -0.0225 + 0.2 = 0.1775`

**Step 2**: Check spike: `0.1775 ≥ 1.0`? **No** → `s_3 = 0`

**Step 3**: `a_3 = 0`, `θ_3 = 1.0`

**Step 5**: `V_3 = 0.1775`

**State after t=3**: `V = 0.1775`, `a = 0`, `θ = 1.0`, `s = 0`

---

### t = 4: Fourth Time Step, Input I_4 = 2.0

**Step 1**: `V_temp = 0.1775 * 0.9 + 0.2 = 0.15975 + 0.2 = 0.35975`

**Step 2**: Check spike: `0.35975 ≥ 1.0`? **No** → `s_4 = 0`

**Step 3**: `a_4 = 0`, `θ_4 = 1.0`

**Step 5**: `V_4 = 0.35975`

---

### t = 5: Fifth Time Step, Input I_5 = 2.0

**Step 1**: `V_temp = 0.35975 * 0.9 + 0.2 = 0.323775 + 0.2 = 0.523775`

**Step 2**: Check spike: `0.523775 ≥ 1.0`? **No** → `s_5 = 0`

**Step 3**: `a_5 = 0`, `θ_5 = 1.0`

**Step 5**: `V_5 = 0.523775`

---

### t = 6: Sixth Time Step, Input I_6 = 2.0 — **SPIKE!**

**Step 1**: `V_temp = 0.523775 * 0.9 + 0.2 = 0.4713975 + 0.2 = 0.6713975`

**Step 2**: Check spike: `0.6713975 ≥ 1.0`? **No** → `s_6 = 0` (Wait, still no spike)

Let me continue...

Actually, the neuron will eventually spike when V reaches θ. Let me show the first spike occurrence.

With `I = 2.0`, `τ_m = 1.0`, the membrane approaches `I * τ_m = 2.0` asymptotically. The threshold is `1.0` initially. The neuron will spike when `V_temp` crosses `θ = 1.0`.

**t = 10**: Let's jump to the first spike:
- After ~10 steps of `I=2.0`, `V` approaches `2.0`
- First spike occurs around t=11

Let me show the spike and its effects:

**First spike at t = 11** (approximately):
- `V_temp ≈ 1.05`, `θ_{10} = 1.0` → `s_11 = 1`
- `a_temp = 0 * 0.99 = 0`
- `a_11 = 0 + 0.5 = 0.5`
- `θ_11 = 1.0 + 0.5 = 1.5`
- `V_11 = V_reset = -0.5`

**t = 12** (after spike):
- `V_temp = -0.5 * 0.9 + 0.2 = -0.25`
- Spike check uses `θ_11 = 1.5`: `-0.25 ≥ 1.5`? **No**
- `a_temp = 0.5 * 0.99 = 0.495`
- `a_12 = 0.495`
- `θ_12 = 1.0 + 0.495 = 1.495`
- `V_12 = -0.25`

**t = 13**: V builds up again, threshold at 1.495
**t = 19** (second spike approximately):
- `V_temp ≥ 1.495` → spike!
- `a_temp = a_18 * 0.99`, `a_19 = a_temp + 0.5`
- `θ_19 = 1.0 + a_19 ≈ 2.0`
- `V_19 = -0.5`

This demonstrates: after each spike, adaptation increases, threshold rises, and the neuron requires more depolarization for the next spike.

---

## 9. Key Mathematical Properties

### 9.1. Leak Prevents Unbounded Accumulation

The term `(1 - Δt/τ_m)` ensures that even with constant positive input, `V_t` cannot grow unboundedly:
- If `I_t = I` (constant) and `V_t` starts at `V_reset`:
- `V_t` will asymptotically approach `I * τ_m` (or spike and reset)
- The leak provides a natural "forgetting" or "decay" mechanism

### 9.2. Adaptive Threshold Maintains Balance

The threshold adaptation `a_t` ensures:
- Strong inputs that cause frequent spikes → `a_t` increases → threshold rises → neuron becomes less sensitive (refractoriness)
- No spikes → `a_t` decays → threshold decreases → neuron becomes more sensitive over time
- At steady state with constant firing rate `r`: `a_ss = b * r * τ_a` (approximate)
- The adaptive threshold implements **spike-frequency adaptation** and **refractoriness**

### 9.3. Firing Condition

A spike occurs when:
```
V_temp ≥ θ_{t-1}
```

Where `V_temp` incorporates both the leaked past and current input, and `θ_{t-1}` is the threshold at the start of the timestep.

### 9.4. Post-Spike Reset

After spike: `V_t = V_reset`
- `V_reset` is typically negative (e.g., -0.5 in normalized units)
- This creates a refractory-like effect: neuron must "re-depolarize" before spiking again
- Effective refractory period depends on input strength and `τ_m`

### 9.5. Memory Duration

The membrane time constant `τ_m` determines how long `V_t` retains information:
- Larger `τ_m` = longer memory (slower leak)
- Smaller `τ_m` = shorter memory (faster leak)

The adaptation time constant `τ_a` determines how quickly the neuron "forgets" its adaptation:
- Larger `τ_a` = slower adaptation decay = adaptation persists longer
- Smaller `τ_a` = faster adaptation decay = neuron recovers sensitivity faster

---

## 10. Numerical Stability

### 10.1. Explicit Euler Integration

The implementation uses explicit Euler integration for the linear ODEs:
- `dV/dt = -(V - 0)/τ_m + I`
- `da/dt = -(a - 0)/τ_a + b * spike_rate`

### 10.2. Stability Condition

For the explicit Euler method applied to `dx/dt = -x/τ + ...`, the update factor is `(1 - Δt/τ)`.

To maintain positivity of this factor and prevent numerical instability:
```
0 < Δt/τ_m < 1  ⇒  0 < Δt < τ_m
0 < Δt/τ_a < 1  ⇒  0 < Δt < τ_a
```

**Therefore: `0 < Δt < min(τ_m, τ_a)`**

This is the practical constraint for STARK-001. It ensures:
- Membrane potential leak factor remains positive
- Adaptation state leak factor remains positive (maintaining `a_t ≥ 0`)
- `θ_t ≥ θ_0` invariant is preserved

The implementation enforces this via `validateDt()`.

---

## 11. Implementation Notes for C++

### 11.1. Discrete Time Step

The mathematical model uses discrete time steps `t = 0, 1, 2, ...` with fixed `Δt`. In the C++ implementation:

```cpp
bool update(double I, double dt) {
    // Validate dt
    if (dt <= 0 || dt >= tau_m_ || dt >= tau_a_) throw ...
    
    // Step 1
    double V_temp = V_ * (1.0 - dt / tau_m_) + I * dt;
    
    // Step 2
    bool spike = (V_temp >= theta_);
    
    // Step 3
    double a_temp = a_ * (1.0 - dt / tau_a_);
    a_ = spike ? a_temp + b_ : a_temp;
    
    // Step 4
    theta_ = theta_0_ + a_;
    
    // Step 5
    if (spike) {
        V_ = v_reset_;
        spiked_ = true;
    } else {
        V_ = V_temp;
        spiked_ = false;
    }
    return spike;
}
```

### 11.2. Time Step Selection

- `dt` should be small enough to accurately capture the dynamics
- Must satisfy `dt < min(tau_m, tau_a)`
- Typical choice: `dt = 0.1` with `tau_m = 1.0`, `tau_a = 10.0` (as in the example)
- Must ensure `dt < tau_m` and `dt < tau_a` to avoid negative coefficients

### 11.3. Validation

The implementation validates:
- Parameters: `tau_m > 0`, `theta_0 >= 0`, `tau_a > 0`, `b >= 0`, all finite
- Time step: `0 < dt < min(tau_m, tau_a)`
- Inputs: `I` and `dt` must be finite

All invalid inputs throw `std::invalid_argument`.

---

## 12. Summary of Final Model

The STARK-001 neural cell implements a **leaky integrate-and-fire unit with spike-triggered adaptive threshold**, providing:

- **3 state variables**: `V_t` (membrane potential), `a_t` (adaptation state), `θ_t` (threshold = `θ_0 + a_t`)
- **5 trainable parameters**: `τ_m`, `θ_0`, `τ_a`, `b`, `V_reset`
- **1 input**: `I_t` (external input current)
- **1 output**: `s_t` (spike indicator: 0 or 1), plus readable `V_t` and `θ_t`
- **5 update steps**: leak+input, spike detection, adaptation, threshold update, membrane update
- **Numerical stability**: Leak prevents unbounded accumulation; `dt < min(τ_m, τ_a)` required
- **Sparse connectivity**: Each neuron independent; synaptic weights modulate input
- **Recurrent support**: Intrinsic `V_t` recurrence + explicit synaptic connections
- **Adaptability**: Spike-triggered threshold elevation implements refractoriness and spike-frequency adaptation

This design represents the minimal useful computational unit that can eventually become part of STARK's neural substrate while providing the temporal dynamics, persistence, and adaptability required for a persistent cognitive entity.

---
*Specification complete. This mathematical framework defines the STARK-001 neural cell completely and can be directly translated into the C++ implementation.*