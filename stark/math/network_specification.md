# STARK-003 Mathematical Specification

## Centralized Sparse Network with Flat Synapse Array

This section defines the network model mathematically, specifying all state variables, inputs, parameters, outputs, and update rules.

---

## 1. Network State Variables

| Symbol | Description | Dimension |
|--------|-------------|-----------|
| `N` | Number of neurons | `ℕ` |
| `E` | Number of synapses | `ℕ` |
| `V_i(t)` | Membrane potential of neuron `i` at time `t` | `R` |
| `a_i(t)` | Adaptation state of neuron `i` at time `t` | `R≥0` |
| `θ_i(t)` | Adaptive threshold of neuron `i` at time `t` | `R≥θ_0,i` |
| `s_i(t)` | Spike indicator of neuron `i` at time `t` | `{0, 1}` |
| `x_k(t)` | Synaptic state of synapse `k` at time `t` | `R≥0` |
| `w_k` | Weight of synapse `k` | `R` |
| `τ_s,k` | Time constant of synapse `k` | `R>0` |
| `d_k` | Transmission delay of synapse `k` (in timesteps) | `ℕ₀` |
| `I_ext,i(t)` | External input to neuron `i` at time `t` | `R` |
| `t` | Current simulation timestep | `ℕ₀` |

### Connectivity Structure

- **Synapse index `k`** maps to a directed edge `(pre_k, post_k)` where `pre_k, post_k ∈ {0, ..., N-1}`
- **Outgoing adjacency**: `out[i] = {k : pre_k = i}` — synapses originating from neuron `i`
- **Incoming adjacency**: `in[i] = {k : post_k = i}` — synapses targeting neuron `i`

---

## 2. Inputs

| Symbol | Description | Type |
|--------|-------------|------|
| `I_ext,i(t)` | External input current to neuron `i` at time `t` | `R` (set before step `t`) |
| `Δt` | Simulation time step | `R+` (must satisfy all component constraints) |

---

## 3. Parameters (Per Component)

### Neuron `i` Parameters (STARK-001)
| Symbol | Description | Constraint |
|--------|-------------|------------|
| `τ_m,i` | Membrane time constant | `> 0` |
| `θ_0,i` | Baseline threshold | `≥ 0` |
| `τ_a,i` | Adaptation time constant | `> 0` |
| `b_i` | Adaptation increment | `≥ 0` |
| `V_reset,i` | Reset potential | `∈ R` |

### Synapse `k` Parameters (STARK-002 + delay)
| Symbol | Description | Constraint |
|--------|-------------|------------|
| `w_k` | Synaptic weight | `∈ R` |
| `τ_s,k` | Synaptic time constant | `> 0` |
| `d_k` | Transmission delay (timesteps) | `≥ 0` |

---

## 4. Outputs

| Symbol | Description | Value Range |
|--------|-------------|-------------|
| `s_i(t)` | Spike indicator of neuron `i` at time `t` | `{0, 1}` |
| `V_i(t)` | Membrane potential (readable) | `R` |
| `θ_i(t)` | Adaptive threshold (readable) | `R` |
| `x_k(t)` | Synaptic state (readable) | `R≥0` |
| `I_syn,k(t)` | Synaptic current from synapse `k` | `R` |

---

## 5. Update Rule: Discrete Network Step

### Convention: Causal Ordering

**Spikes emitted at timestep `t` produce synaptic current effective at timestep `t+1`.**

This prevents same-timestep recursive propagation and matches the two-neuron experiment.

### Complete Update Algorithm: `t → t+1`

Given: All state at start of timestep `t`, external inputs `I_ext,i(t)`, time step `Δt`

#### Step 1: Validate Time Step
```
Require: 0 < Δt < min( min_i(τ_m,i, τ_a,i), min_k(τ_s,k) )
Require: Δt is finite
```

#### Step 2: Compute Total Input Current for Each Neuron
```
For each neuron i ∈ {0, ..., N-1}:
    I_total,i = I_ext,i(t)                              // External input
    
    For each k ∈ in[i] (incoming synapses to i):
        I_total,i += w_k * x_k(t)                       // Synaptic current from previous step
```

#### Step 3: Update All Neurons (Determine Spikes at `t`)
```
For each neuron i ∈ {0, ..., N-1}:
    // STARK-001 NeuralCell update (5 steps):
    V_temp = V_i(t) * (1 - Δt/τ_m,i) + I_total,i * Δt
    s_i(t) = 1 if V_temp ≥ θ_i(t) else 0                // Uses θ_i(t) from start of step
    
    a_temp = a_i(t) * (1 - Δt/τ_a,i)
    a_i(t+1) = a_temp + b_i * s_i(t)
    θ_i(t+1) = θ_0,i + a_i(t+1)
    
    if s_i(t) = 1:
        V_i(t+1) = V_reset,i
    else:
        V_i(t+1) = V_temp
```

#### Step 4: Deliver Spikes to Synapses (Update Synaptic State for `t+1`)
```
For each neuron i that spiked (s_i(t) = 1):
    For each k ∈ out[i] (outgoing synapses from i):
        if d_k = 0:
            // Immediate delivery: synapse state updates for next step
            x_k(t+1) = x_k(t) * (1 - Δt/τ_s,k) + 1
        else:
            // Delayed delivery: schedule for future step
            schedule delivery of spike to synapse k at timestep t + d_k

For each neuron i that did NOT spike (s_i(t) = 0):
    For each k ∈ out[i]:
        // Synapse decays with no spike input
        x_k(t+1) = x_k(t) * (1 - Δt/τ_s,k)
```

#### Step 5: Process Delayed Spike Deliveries
```
For each neuron i:
    For each scheduled spike delivery (synapse k, spike=1) arriving at timestep t+1:
        x_k(t+1) = x_k(t+1) + 1          // Add to already-decayed state
        // Note: synapse already decayed in Step 4; we add the spike contribution
```

#### Step 6: Advance Time
```
t := t + 1
I_ext,i(t) := 0  for all i   // Clear external inputs (unless explicitly set again)
```

---

## 6. Complete State Evolution Equations (Summary)

For each timestep `t → t+1`:

```
# 1. Total input
I_total,i(t) = I_ext,i(t) + Σ_{k∈in[i]} w_k * x_k(t)

# 2. Neuron update (STARK-001)
V_temp,i = V_i(t) * (1 - Δt/τ_m,i) + I_total,i(t) * Δt
s_i(t) = H(V_temp,i - θ_i(t))                          # H = Heaviside step

a_temp,i = a_i(t) * (1 - Δt/τ_a,i)
a_i(t+1) = a_temp,i + b_i * s_i(t)
θ_i(t+1) = θ_0,i + a_i(t+1)

V_i(t+1) = s_i(t) * V_reset,i + (1 - s_i(t)) * V_temp,i

# 3. Synapse update (STARK-002) for each synapse k
x_temp,k = x_k(t) * (1 - Δt/τ_s,k)

if pre_k spiked at t and d_k = 0:
    x_k(t+1) = x_temp,k + 1
else if pre_k spiked at t and d_k > 0:
    x_k(t+1) = x_temp,k              # Spike delayed, will add later
    schedule (k, 1) for delivery at t + d_k
else:
    x_k(t+1) = x_temp,k              # No spike from pre

# 4. Delayed deliveries arriving at t+1
For each (k, 1) scheduled for delivery at t+1:
    x_k(t+1) = x_k(t+1) + 1

# 5. Synaptic current for next step
I_syn,k(t+1) = w_k * x_k(t+1)
```

---

## 7. Invariants

The following invariants hold for all `t ≥ 0` given valid parameters and `Δt`:

1. **Neuron adaptation non-negativity**: `a_i(t) ≥ 0` for all `i, t`
   - From STARK-001: `a_0 = 0`, decay factor > 0, `b ≥ 0`

2. **Neuron threshold bound**: `θ_i(t) ≥ θ_0,i` for all `i, t`
   - From STARK-001: `θ_i = θ_0,i + a_i`, `a_i ≥ 0`

3. **Synaptic state non-negativity**: `x_k(t) ≥ 0` for all `k, t`
   - From STARK-002: `x_0 = 0`, decay factor > 0 (requires `Δt < τ_s,k`), add `s_pre ∈ {0,1}`

4. **Time step validity**: `0 < Δt < min( min_i(τ_m,i, τ_a,i), min_k(τ_s,k) )`
   - Enforced by `Network::validateDt()`

---

## 8. Numerical Example: Three-Neuron Chain

### Parameters
- **All neurons**: `τ_m=1.0, θ_0=1.0, τ_a=10.0, b=0.5, V_reset=-0.5`
- **Synapse 0 (0→1)**: `w=0.8, τ_s=2.0, d=0`
- **Synapse 1 (1→2)**: `w=0.8, τ_s=2.0, d=0`
- **Δt = 0.1**
- **External input**: `I_ext,0 = 2.5` (constant), `I_ext,1 = I_ext,2 = 0`

### Initial State (t = 0)
```
Neuron 0: V=-0.5, a=0, θ=1.0, s=0
Neuron 1: V=-0.5, a=0, θ=1.0, s=0
Neuron 2: V=-0.5, a=0, θ=1.0, s=0
Synapse 0: x=0
Synapse 1: x=0
```

### t = 1: First Step
```
I_total,0 = 2.5 + 0 = 2.5
I_total,1 = 0 + 0.8*0 = 0
I_total,2 = 0 + 0.8*0 = 0

Neuron 0: V_temp = -0.5*0.9 + 2.5*0.1 = -0.45 + 0.25 = -0.2
          s_0 = 0 (-0.2 < 1.0)
          V_0(1) = -0.2, a_0(1)=0, θ_0(1)=1.0

Neuron 1: V_temp = -0.5*0.9 + 0 = -0.45
          s_1 = 0
          V_1(1) = -0.45, a_1(1)=0, θ_1(1)=1.0

Neuron 2: V_temp = -0.5*0.9 + 0 = -0.45
          s_2 = 0
          V_2(1) = -0.45

Synapse 0: x_0(1) = 0*0.95 + 0 = 0
Synapse 1: x_1(1) = 0*0.95 + 0 = 0
```

### t = 7: Neuron 0 First Spike
```
At t=7: V_0 ≈ 0.9, θ_0 = 1.0 → no spike yet
At t=8: V_0 ≈ 1.05, θ_0 = 1.0 → SPIKE! s_0(8) = 1
        V_0(9) = -0.5, a_0(9) = 0.5, θ_0(9) = 1.5
        
Synapse 0: x_0(9) = x_0(8)*0.95 + 1 = 0 + 1 = 1.0  (immediate delivery, d=0)
Synapse 1: x_1(9) = 0 (neuron 1 didn't spike)
```

### t = 9: Neuron 1 Receives Excitatory Current
```
I_total,1(9) = 0 + 0.8 * x_0(9) = 0.8 * 1.0 = 0.8
Neuron 1: V_temp = -0.5*0.9 + 0.8*0.1 = -0.45 + 0.08 = -0.37
          s_1 = 0
          V_1(10) = -0.37

Synapse 0: x_0(10) = 1.0 * 0.95 = 0.95 (decay)
```

### t = 15-20: Neuron 1 Spikes → Neuron 2
```
After several steps of synaptic input, Neuron 1 spikes
Synapse 1 receives spike, x_1 jumps, Neuron 2 receives current
Neuron 2 may spike if weight is sufficient
```

---

## 9. Determinism Guarantee

Given identical:
- Initial network construction (same neurons, synapses, connections in same order)
- Same sequence of external inputs `I_ext,i(t)` for all `t`
- Same `Δt`
- Same floating-point environment (compiler, architecture, optimization)

The network will produce **identical spike sequences and state trajectories** for all time.

**Implementation requirements for determinism:**
- Fixed iteration order: neurons by ID `0..N-1`, synapses by ID `0..E-1`
- No uninitialized memory
- No undefined behavior
- IEEE 754 floating-point (standard on modern CPUs)
- No parallelization that changes operation order (single-threaded for STARK-003)

---

## 10. Transmission Delays

### Delay Semantics

A synapse with delay `d_k > 0`:
1. Pre-synaptic neuron spikes at time `t`
2. Spike is **queued** for delivery at time `t + d_k`
3. At time `t + d_k`, the synapse receives the spike and updates:
   ```
   x_k(t + d_k) = x_k(t + d_k) + 1   // After decay has already been applied for step t + d_k
   ```
4. Current `I_syn,k = w_k * x_k` affects post-synaptic neuron at step `t + d_k`

### Delay Queue Implementation

```
delayed_deliveries[target_neuron] = list of (synapse_id, delivery_timestep)
```

At each step `t`:
```
For each (k, delivery_t) in delayed_deliveries[post_k] where delivery_t == t:
    x_k(t) = x_k(t) + 1
    Remove from queue
```

---

## 11. Computational Complexity

### Per Timestep (Fixed-Step Mode)

| Operation | Complexity | Notes |
|-----------|------------|-------|
| Input accumulation | O(E) | Sum over incoming synapses |
| Neuron updates | O(N) | Each neuron O(1) |
| Spike delivery | O(E_spiking) | Only synapses from spiking neurons |
| Delay processing | O(E_delayed) | Synapses with deliveries this step |
| **Total** | **O(N + E)** | For sparse networks, E ~ 0.01-0.1 * N² |

### Memory

| Component | Memory |
|-----------|--------|
| Neurons | N × (5 state + 5 params) ≈ 10N scalars |
| Synapses | E × (1 state + 3 params + 2 IDs) ≈ 6E scalars |
| Adjacency | O(N + E) indices |
| Delay queue | O(E_delayed) |

---

## 12. Future Extensibility

### STDP (STARK-004)
- Pre-synaptic trace: `x_k(t)` already available in `Synapse`
- Post-synaptic trace: Add `y_i(t)` to `NeuralCell` (decays with `τ_y`)
- Weight update on post-synaptic spike: `Δw_k ∝ x_k(t) * A+ - y_post(t) * A-`

### Structural Plasticity (STARK-004+)
- Synapse creation: `if x_k * y_post > θ_create and no connection: addSynapse()`
- Synapse elimination: `if x_k < θ_elim for long time: removeSynapse()`

### Event-Driven Scheduler (STARK-004+)
- Replace fixed `step(dt)` with priority queue of `(time, event)`
- Events: neuron update (when input arrives), synapse decay, delayed delivery
- Only compute when something happens

### Serialization (STARK-004+)
- Save: all neuron params + states, all synapse params + states + connectivity, timestep
- Load: reconstruct identical network state

---

## 13. Summary of Final Model

The STARK-003 network implements a **centralized sparse recurrent network** with:

- **Neurons**: STARK-001 leaky integrators with adaptive threshold (3 state vars each)
- **Synapses**: STARK-002 Euler-discretized exponential decay (1 state var each)
- **Connectivity**: Explicit directed edges with weights, time constants, delays
- **Update**: Fixed timestep, causal (spikes at `t` → current at `t+1`)
- **Delays**: Per-synapse integer delays (0-5+ timesteps)
- **Determinism**: Fixed iteration order, reproducible trajectories
- **Diagnostics**: Full state inspection at any timestep
- **Complexity**: O(N + E) time and memory per step

This design provides the minimal substrate for network-level dynamics experiments while maintaining clean separation from the STARK-001 and STARK-002 primitives.

---

*Specification complete. Ready for C++ implementation.*