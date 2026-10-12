# STARK-004 Learning Specification: Spike-Timing-Dependent Plasticity (STDP)

This document is the authoritative mathematical specification for the pair-based
trace STDP learning rule implemented in STARK-004. It is written to match the
actual C++ implementation exactly (`src/neural/Synapse.cpp`,
`src/neural/Network.cpp`).

**Model class:** pair-based, trace-mediated STDP.

**Causal principle:**
- pre fires, then post fires  →  potentiation (LTP)  →  weight increases
- post fires, then pre fires  →  depression (LTD)    →  weight decreases

---

## 1. State Variables

### Synaptic state variables (owned by `Synapse`)

| Variable   | Description                                              | Initial |
|------------|----------------------------------------------------------|---------|
| `w`        | Synaptic weight (connection strength)                    | `w_init`|
| `x`        | Synaptic current state (STARK-002, unchanged)            | 0.0     |
| `x_pre`    | Pre-synaptic spike trace (recent pre activity)           | 0.0     |
| `x_post`   | Post-synaptic spike trace (recent post activity)         | 0.0     |

### Neuronal state variables (owned by `NeuralCell`, unchanged from STARK-001)

| Variable | Description              | Initial   |
|----------|--------------------------|-----------|
| `V`      | Membrane potential       | `V_reset` |
| `a`      | Adaptation state         | 0.0       |
| `theta`  | Adaptive threshold       | `theta_0` |

---

## 2. Parameters

### Plasticity parameters (STARK-004)

| Parameter  | Description                              | Constraint        |
|------------|------------------------------------------|-------------------|
| `A_plus`   | LTP learning rate                        | `A_plus >= 0`     |
| `A_minus`  | LTD learning rate                        | `A_minus >= 0`    |
| `tau_pre`  | Pre-synaptic trace decay time constant   | `tau_pre > 0`     |
| `tau_post` | Post-synaptic trace decay time constant  | `tau_post > 0`    |
| `w_min`    | Lower weight bound                       | finite            |
| `w_max`    | Upper weight bound                       | `w_max >= w_min`  |

### Synaptic parameters (unchanged from STARK-002)

| Parameter | Description                    | Constraint |
|-----------|--------------------------------|------------|
| `w_init`  | Initial synaptic weight        | finite     |
| `tau_s`   | Synaptic current time constant | `tau_s > 0`|

### Neuronal parameters (unchanged from STARK-001)

| Parameter | Description              | Constraint     |
|-----------|--------------------------|----------------|
| `tau_m`   | Membrane time constant   | `tau_m > 0`    |
| `theta_0` | Baseline threshold       | `theta_0 >= 0` |
| `tau_a`   | Adaptation time constant | `tau_a > 0`    |
| `b`       | Adaptation increment     | `b >= 0`       |
| `V_reset` | Reset potential          | finite         |

---

## 3. Update Rules

### 3.1 Trace decay (exact exponential)

At the start of each timestep, both traces decay via **exact exponential decay**:

```
x_pre  <- x_pre  * exp(-dt / tau_pre)
x_post <- x_post * exp(-dt / tau_post)
```

This is the exact discrete solution of `dx/dt = -x/tau` for piecewise-constant
input. It is **not** an Euler approximation.

### 3.2 Trace increment on spike

```
When a PRE-synaptic spike occurs:   x_pre  += 1
When a POST-synaptic spike occurs:  x_post += 1
```

### 3.3 STDP weight update (the learning rule)

The rule is trace-mediated and local to the synapse:

```
When a PRE-synaptic spike occurs:
    x_pre   += 1
    Δw_LTD  = -A_minus * x_post        (depression, driven by post trace)

When a POST-synaptic spike occurs:
    x_post  += 1
    Δw_LTP  = +A_plus * x_pre          (potentiation, driven by pre trace)
```

After each update the weight is clamped:

```
w <- clamp(w + Δw, w_min, w_max)
```

**Why this produces the correct timing dependence:**

- *pre → post:* A pre spike raises `x_pre`. A later post spike reads the still-
  elevated `x_pre` and applies `Δw_LTP = +A_plus * x_pre > 0`. **Weight rises.**
- *post → pre:* A post spike raises `x_post`. A later pre spike reads the still-
  elevated `x_post` and applies `Δw_LTD = -A_minus * x_post < 0`. **Weight falls.**

The traces decay with `tau_pre` / `tau_post`, so the magnitude of the change
depends on the time between the two spikes — this is the STDP timing window.

### 3.4 Same-timestep spike policy

If the pre and post neurons **both spike in the same timestep**, the
implementation applies **both** updates in a fixed order:

```
if post_spiked:  applyLTP()   ->  Δw += +A_plus  * x_pre
if pre_spiked:   applyLTD()   ->  Δw += -A_minus * x_post
```

Therefore the net weight change for simultaneous spikes is:

```
Δw_total = +A_plus * x_pre  -  A_minus * x_post
```

where `x_pre` and `x_post` are the trace values **after** both spikes have been
added in this timestep (post trace is incremented during the neuron update, pre
trace is incremented during spike delivery, both before STDP is applied). This
policy is deterministic and is verified by an explicit test.

### 3.5 Synaptic current update (unchanged from STARK-002, Euler)

```
x <- x * (1 - dt/tau_s) + s_pre
I_post = w * x
```

This is the **Euler discretization** of `dx/dt = -x/tau_s + s_pre`.

### 3.6 Neuronal update (unchanged from STARK-001)

```
V_temp = V * (1 - dt/tau_m) + I*dt
s      = 1 if V_temp >= theta else 0
a      = a*(1 - dt/tau_a) + b*s
theta  = theta_0 + a
V      = V_reset if s else V_temp
```

---

## 4. Timestep Ordering (matches `Network::step()` exactly)

Within a single timestep the implementation performs, in this exact order:

1. **Decay traces** — `decayTraces(dt)` on every synapse
   (`x_pre`, `x_post` multiplied by their exact exponential decay factors).
2. **Compute neuron inputs** — external input + synaptic current `w * x`
   from the previous timestep's delivered spikes.
3. **Update neurons** — `NeuralCell::update()` collects spikes. For every
   neuron that spikes, `updatePostTrace()` is called on all its *incoming*
   synapses (`x_post += 1`).
4. **Deliver pre spikes** — for every neuron that spiked, `receiveSpike(true,dt)`
   is called on all its *outgoing* synapses. This increments `x_pre += 1` and
   updates the synaptic current state `x`. Non-spiking neurons call
   `receiveSpike(false,dt)` to decay `x`.
5. **Apply STDP** — for every synapse:
   - if post neuron spiked → `applyLTP()` (`Δw = +A_plus * x_pre`)
   - if pre neuron spiked → `applyLTD()` (`Δw = -A_minus * x_post`)
   - weight clamped to `[w_min, w_max]` after each update.
6. **Process delayed deliveries** — spikes scheduled via transmission delay
   that arrive at the new timestep are delivered.
7. **Advance timestep** and clear external inputs.

**Key consequence:** the spike for timestep `t` is detected using neuron state
entering `t`; that spike then updates traces and weights within the same
timestep, affecting subsequent timesteps. There is no same-timestep recursive
spike propagation (synaptic current from a spike at `t` reaches the post neuron
at `t+1`).

---

## 5. Invariants

### Synaptic invariants

1. **Weight bounds:** `w_min <= w <= w_max` (enforced by `clampWeight()`).
2. **Trace non-negativity:** `x_pre >= 0`, `x_post >= 0`.
   Exact exponential decay of a non-negative value stays non-negative, and
   spikes only add `+1`, so this invariant holds for all timesteps.
3. **Synaptic state non-negativity:** `x >= 0` (Euler, requires `dt < tau_s`).
4. **Finiteness:** `w`, `x_pre`, `x_post`, `x` are all finite.

### Neuronal invariants (unchanged from STARK-001)

1. `a >= 0`
2. `theta >= theta_0`
3. `V` finite

---

## 6. Numerical Constraints (corrected)

The two integration schemes have **different** timestep requirements:

### Euler constraint (synaptic current `x`, and STARK-001 neuron state)

The synaptic current uses explicit Euler: `x <- x*(1 - dt/tau_s) + s_pre`.
To keep the leak factor `(1 - dt/tau_s)` in `(0,1)` and preserve `x >= 0`:

```
0 < dt < tau_s
```

Likewise STARK-001 neuron integration requires `0 < dt < min(tau_m, tau_a)`.

### Exact exponential constraint (plasticity traces)

The traces use exact exponential decay: `x_pre *= exp(-dt/tau_pre)`.
For any `dt > 0` and `tau_pre > 0`, `exp(-dt/tau_pre) ∈ (0,1)`, so the trace
stays non-negative and decays monotonically. **No upper bound on `dt` is
required** by the trace equations.

Therefore the practical timestep constraint enforced by `Synapse::validateDt()`
is:

```
0 < dt < tau_s
```

`dt < tau_pre` and `dt < tau_post` are **not** required and are **not**
enforced. (The Network additionally enforces the STARK-001 neuron constraint
`dt < min(tau_m, tau_a)` across all neurons.)

---

## 7. Numerical Examples (corrected)

Parameters used for both cases:

- `A_plus = 0.01`, `A_minus = 0.01`
- `tau_pre = 20`, `tau_post = 20`
- `w_min = 0.0`, `w_max = 1.0`, `w_init = 0.5`
- `dt = 1`
- decay factor per step: `exp(-1/20) = 0.951229`

Traces start at `x_pre = 0`, `x_post = 0`, `w = 0.5`.

### CASE A — PRE BEFORE POST (expect LTP, weight increases)

- t=1: pre spike
- t=3: post spike

| t | event | x_pre (after) | x_post (after) | update applied | Δw | w |
|---|-------|---------------|----------------|----------------|----|----|
| 0 | none  | 0.000000 | 0.000000 | — | 0 | 0.500000 |
| 1 | pre spike | 1.000000 | 0.000000 | LTD: `-A_minus*x_post = -0.01*0 = 0` | 0 | 0.500000 |
| 2 | none (decay) | 0.951229 | 0.000000 | — | 0 | 0.500000 |
| 3 | post spike | 0.904837 | 1.000000 | LTP: `+A_plus*x_pre = +0.01*0.904837` | +0.009048 | 0.509048 |

Detail for t=3: before the post spike, `x_pre` decays from 0.951229 to
`0.951229 * 0.951229 = 0.904837`. The post spike then triggers
`Δw_LTP = +0.01 * 0.904837 = +0.009048`.

**Result: `w` increased from 0.500000 to 0.509048. This is LTP.** ✓

### CASE B — POST BEFORE PRE (expect LTD, weight decreases)

- t=1: post spike
- t=3: pre spike

| t | event | x_pre (after) | x_post (after) | update applied | Δw | w |
|---|-------|---------------|----------------|----------------|----|----|
| 0 | none  | 0.000000 | 0.000000 | — | 0 | 0.500000 |
| 1 | post spike | 0.000000 | 1.000000 | LTP: `+A_plus*x_pre = +0.01*0 = 0` | 0 | 0.500000 |
| 2 | none (decay) | 0.000000 | 0.951229 | — | 0 | 0.500000 |
| 3 | pre spike | 1.000000 | 0.904837 | LTD: `-A_minus*x_post = -0.01*0.904837` | -0.009048 | 0.490952 |

Detail for t=3: before the pre spike, `x_post` decays from 0.951229 to
`0.951229 * 0.951229 = 0.904837`. The pre spike then triggers
`Δw_LTD = -0.01 * 0.904837 = -0.009048`.

**Result: `w` decreased from 0.500000 to 0.490952. This is LTD.** ✓

### CASE C — SIMULTANEOUS spikes (same timestep)

If pre and post both spike at the same timestep `t`, with decayed trace values
entering the step `x_pre = p`, `x_post = q`:

1. post trace incremented: `x_post = q + 1`
2. pre trace incremented: `x_pre = p + 1`
3. LTP applied: `Δw += +A_plus * (p + 1)`
4. LTD applied: `Δw += -A_minus * (q + 1)`

Net: `Δw_total = A_plus*(p+1) - A_minus*(q+1)`.

With `p = q = 0`, `A_plus = A_minus = 0.01`: `Δw_total = 0.01 - 0.01 = 0`.
The weight is unchanged. This symmetric cancellation is deterministic and is
verified by test.

---

## 8. Deterministic Behavior

The STDP update is deterministic and reproducible given:

1. The same initial network state.
2. The same input sequence.
3. The same timestep `dt`.

No stochasticity is introduced in STARK-004. This is critical for debugging,
testing, and eventual self-verification.
