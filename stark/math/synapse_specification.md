# STARK-002 Mathematical Specification

## Euler-Discretized First-Order Synaptic Decay

This section defines the synapse model mathematically, specifying all state variables, inputs, parameters, outputs, and update rules.

The model is the **explicit Euler discretization** of the continuous-time first-order synaptic differential equation. It is NOT the exact discrete exponential solution.

---

## 1. State Variables

| Symbol | Description | Dimension | Initial Value |
|--------|-------------|-----------|---------------|
| `x_t` | Synaptic state (efficacy) at time t | R (scalar, ≥ 0) | `x_0 = 0` |

**The state is updated at each discrete time step using explicit Euler integration.**

---

## 2. Inputs

| Symbol | Description | Type |
|--------|-------------|------|
| `s_pre,t` | Pre-synaptic spike indicator at time t | {0, 1} |
| `Δt` | Time step size | R+ (positive real) |

**`s_pre,t = 1` if the pre-synaptic neuron fired at time t; `s_pre,t = 0` otherwise.**

---

## 3. Parameters

| Symbol | Description | Constraint | Default |
|--------|-------------|------------|---------|
| `w` | Synaptic weight | `w ∈ R` (can be positive, negative, or zero) | 1.0 |
| `τ_s` | Synaptic time constant | `τ_s > 0` | 2.0 |

**Interpretation of weight:**
- `w > 0` → **Excitatory** synapse (depolarizing, increases post-synaptic V)
- `w < 0` → **Inhibitory** synapse (hyperpolarizing, decreases post-synaptic V)
- `w = 0` → No effect

---

## 4. Outputs

| Symbol | Description | Value Range |
|--------|-------------|-------------|
| `I_post,t` | Post-synaptic current at time t | R |

**This current is fed directly into the post-synaptic neuron's membrane equation.**

---

## 5. Update Rule

The synapse evolves through the following steps at each time step `t`:

### Step 1: Synaptic State Update (Euler Discretization)

```
x_temp = x_{t-1} * (1 - Δt/τ_s)

if s_pre,t = 1:
    x_t = x_temp + 1
else:
    x_t = x_temp
```

**Explanation:**
- This is the explicit Euler update for the continuous-time equation `dx/dt = -x/τ_s + s_pre(t)`
- `x_{t-1} * (1 - Δt/τ_s)`: Euler discretization of the decay term `-x/τ_s`
- `+ 1` when pre-synaptic spike arrives: discrete spike contribution (Euler treatment of Dirac delta input)
- **Invariant**: `x_t ≥ 0` for all `t` (since `x_0 = 0`, decay factor > 0 requires `Δt < τ_s`, and we only add 1)

**Note**: The factor `(1 - Δt/τ_s)^n` is the discrete Euler decay after `n` steps, not the exact continuous exponential `exp(-n·Δt/τ_s)`. The continuous-time model has exact solution `x(t) = x(0)·exp(-t/τ_s)` between spikes.

### Step 2: Post-Synaptic Current Generation

```
I_post,t = w * x_t
```

**Explanation:**
- The synaptic current is the weight multiplied by the current synaptic state
- Sign of current is determined by `w`: positive for excitatory, negative for inhibitory

---

## 6. Complete State Evolution (Per Time Step)

Given: `x_{t-1}`, `s_pre,t`, and parameters `w`, `τ_s`

```
# Step 1: Decay and add spike
x_temp = x_{t-1} * (1 - Δt/τ_s)
x_t = x_temp + s_pre,t

# Step 2: Generate post-synaptic current
I_post,t = w * x_t
```

---

## 7. Invariants

The following invariants hold for all time steps `t ≥ 0` given valid parameters and `Δt`:

1. **Synaptic state non-negativity**: `x_t ≥ 0`
   - Proof: `x_0 = 0`. Inductive step: `x_temp = x_{t-1} * (1 - Δt/τ_s) ≥ 0` since `(1 - Δt/τ_s) > 0` (requires `Δt < τ_s`). If `s_pre,t = 1`, `x_t = x_temp + 1 ≥ 0`. If `s_pre,t = 0`, `x_t = x_temp ≥ 0`.

2. **Current sign determined by weight**: `sign(I_post,t) = sign(w)` (when `x_t > 0`)

---

## 8. Numerical Example: Single Spike Response (Euler Discretization)

### Parameters
- `w = 1.0` (excitatory)
- `τ_s = 1.0`
- `Δt = 0.1`

### Initial State (t = 0)
```
x_0 = 0
I_post,0 = 0
```

### t = 1: Pre-synaptic spike arrives
```
x_temp = 0 * (1 - 0.1/1.0) = 0
x_1 = 0 + 1 = 1
I_post,1 = 1.0 * 1 = 1.0
```

### t = 2: No spike, decay begins
```
x_temp = 1 * 0.9 = 0.9
x_2 = 0.9
I_post,2 = 1.0 * 0.9 = 0.9
```

### t = 3: Continued decay
```
x_temp = 0.9 * 0.9 = 0.81
x_3 = 0.81
I_post,3 = 0.81
```

### t = 6: After 5 decay steps
```
x_6 = 0.9^5 = 0.59049
I_post,6 = 0.59049
```

**Note**: `0.9 = (1 - Δt/τ_s)` is the Euler decay factor per step. The exact continuous decay would be `exp(-0.1) ≈ 0.904837` per step. After 5 steps: Euler `0.9^5 = 0.59049`, exact `exp(-0.5) ≈ 0.60653`.

---

## 9. Numerical Example: Multiple Spikes

### Parameters
- `w = 1.0`
- `τ_s = 10.0` (slow decay so spikes sum)
- `Δt = 0.1`

### t = 1: First spike
```
x_1 = 1.0
I_post,1 = 1.0
```

### t = 2: Second spike arrives before much decay
```
x_temp = 1.0 * (1 - 0.1/10.0) = 1.0 * 0.99 = 0.99
x_2 = 0.99 + 1 = 1.99
I_post,2 = 1.99
```

**Result**: Multiple spikes sum together (with decay between them), producing temporal integration.

---

## 10. Connection to STARK-001 Neural Cell

The post-synaptic current `I_post,t` from the synapse becomes the input `I_t` to the post-synaptic neural cell:

**Pre-synaptic neuron (STARK-001):**
```
V_temp = V_{t-1} * (1 - Δt/τ_m) + I_ext * Δt
s_t = 1 if V_temp ≥ θ_{t-1} else 0
...
```

**Synapse (STARK-002):**
```
x_t = x_{t-1} * (1 - Δt/τ_s) + s_t
I_post,t = w * x_t
```

**Post-synaptic neuron (STARK-001):**
```
V_temp = V_{t-1} * (1 - Δt/τ_m) + I_post,t * Δt
s_t = 1 if V_temp ≥ θ_{t-1} else 0
...
```

The complete pathway:
```
External Input → Neuron A → Spike s_A → Synapse A→B → Current I_B → Neuron B
```

---

## 11. Numerical Integration and Stability

### 11.1. Continuous-Time Model

The underlying continuous-time differential equation is:

```
dx/dt = -x/τ_s + s_pre(t)
```

where `s_pre(t)` is a sum of Dirac delta functions at spike times.

### 11.2. Explicit Euler Discretization (Current Implementation)

With fixed time step `Δt`, explicit Euler gives:

```
x_{t+1} = x_t + Δt * (-x_t/τ_s + s_pre,t/Δt)
        = x_t * (1 - Δt/τ_s) + s_pre,t
```

This is the implemented update rule.

### 11.3. Stability Constraint

For explicit Euler applied to `dx/dt = -x/τ_s`, the update factor is `(1 - Δt/τ_s)`.

To maintain positivity of this factor and prevent numerical instability:
```
0 < Δt/τ_s < 1  ⇒  0 < Δt < τ_s
```

**Therefore: `0 < Δt < τ_s`**

This is a **numerical integration constraint** from the Euler discretization, not a fundamental property of the synapse concept. It is enforced by `validateDt()` in the implementation.

### 11.4. Alternative: Exact Discrete Exponential (Future)

A future implementation could use the exact solution of the linear ODE between spikes:

```
x(t + Δt) = x(t) * exp(-Δt/τ_s) + (spike contribution)
```

This would remove the `Δt < τ_s` constraint and provide exact continuous-time decay at the cost of an `exp()` call per timestep. The current implementation remains the simple Euler version for STARK-002.

---

## 12. Computational Complexity

### Per Synapse Per Timestep:
- **Operations**: ~3 FLOPs (1 multiply, 1 add for state update; 1 multiply for current)
- **Memory**: 1 scalar state (`x_t`) + 2 parameters (`w`, `τ_s`)
- **Branching**: 1 conditional (spike or no spike)

### Sparse Connectivity:
- Only synapses with `x_t > 0` or recent spikes need active computation
- Silent synapses (no recent spikes) have `x_t ≈ 0` and contribute negligible current

---

## 13. Future Extensibility

### Spike-Timing-Dependent Plasticity (STDP)
The synaptic state `x_t` serves as a **pre-synaptic trace** for STDP:
- When post-synaptic neuron spikes, `x_t` is available for weight update
- Future STARK phases can implement: `Δw ∝ x_t * (post_spike - target)`

### Structured Connectivity
- Each synapse is independent with its own `w`, `τ_s`, `x_t`
- Networks can have heterogeneous synaptic parameters
- Sparse connectivity is natural: only instantiate synapses for existing connections

### Transmission Delays (STARK-003+)
Can be added by inserting a delay queue before the synaptic state update.

---

## 14. Summary of Final Model

The STARK-002 synapse implements an **Euler-discretized first-order synaptic decay** with:

- **1 state variable**: `x_t` (synaptic efficacy, ≥ 0)
- **2 parameters**: `w` (weight, ∈ R), `τ_s` (time constant, > 0)
- **1 input**: `s_pre,t` (pre-synaptic spike, {0,1})
- **1 output**: `I_post,t` (post-synaptic current, ∈ R)
- **2 update steps**: decay+spike, current generation
- **Numerical stability**: Requires `Δt < τ_s` (Euler constraint)
- **Sparse connectivity**: Each synapse independent
- **Excitatory/Inhibitory**: Weight sign determines effect
- **Temporal integration**: Discrete Euler decay provides integration window
- **STDP-ready**: Pre-synaptic trace `x_t` available for learning

This design represents the minimal useful synaptic primitive that enables temporal spike transmission between STARK-001 neural cells while providing the computational foundation for future network-level dynamics and plasticity.

---

*Specification complete. This mathematical framework defines the STARK-002 synapse completely and can be directly translated into the C++ implementation.*