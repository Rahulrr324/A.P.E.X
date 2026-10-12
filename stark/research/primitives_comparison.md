# STARK-001 Research: Computational Primitive Comparison

## Objective
Compare computational neural units to select the best foundation for STARK's neural substrate.

---

## A. Conventional Artificial Neuron (Perceptron)

### 1. Mathematical state
- Single scalar activation value: `a ∈ ℝ`
- Weighted sum of inputs before activation

### 2. Inputs
- `x ∈ ℝ^n`: input vector from previous layer or external source

### 3. Outputs
- `a ∈ ℝ`: activation scalar, typically passed through step or sigmoid

### 4. Trainable parameters
- `w ∈ ℝ^n`: weight vector
- `b ∈ ℝ`: bias scalar

### 5. State update equation
```
z = w·x + b   (weighted sum)
a = σ(z)      (activation)
```

### 6. Activation function
- Step function: `a = 1 if z > 0 else 0` (original perceptron)
- Sigmoid: `σ(z) = 1/(1+e^{-z})`
- ReLU: `a = max(0, z)`
- tanh: `σ(z) = (e^z - e^{-z})/(e^z + e^{-z})`

### 7. Learning/plasticity mechanism
- Perceptron learning rule: Δw = η(y - a)x
- Gradient descent for differentiable activations

### 8. Temporal behavior
- Purely feedforward — no internal state persistence
- Output depends only on current input

### 9. Computational cost
- O(n) for n inputs: one dot product + activation
- Minimal memory: n weights + 1 bias

### 10. Memory requirements
- Store: weight vector + bias
- No persistent internal state between invocations

### 11. Advantages
- Simplest neural unit
- Interpretable weights
- Well-understood training
- Fast inference

### 12. Disadvantages
- No temporal dynamics
- No memory of past inputs
- Binary output (with step activation)
- Cannot process sequences

### 13. Suitability for STARK
- **Low** — STARK requires persistent state and temporal processing

### 14. How multiple cells connect
- Layer: all-to-all from previous layer
- Feedforward network: sequential layers

### 15. Sparse connectivity
- Can be implemented by zeroing some weights
- Not native — all inputs still computed

### 16. Recurrent connections
- Not supported natively
- Would require external state management

### 17. CUDA acceleration
- Trivially parallelizable across many independent neurons
- Each neuron independent of others

---

## B. Recurrent Neuron

### 1. Mathematical state
- `h_t ∈ ℝ^n`: hidden state at time t
- Can maintain internal recurrent state

### 2. Inputs
- `x_t ∈ ℝ^m`: external input at time t
- `h_{t-1} ∈ ℝ^n`: recurrent hidden state from previous time step

### 3. Outputs
- `a_t ∈ ℝ^p`: activation/output at time t
- Can be same dimension as hidden state or projected

### 4. Trainable parameters
- `W_xh ∈ ℝ^{n×m}`: input-to-hidden weights
- `W_hh ∈ ℝ^{n×n}`: recurrent (hidden-to-hidden) weights
- `W_hy ∈ ℝ^{p×n}`: hidden-to-output weights
- `b_h ∈ ℝ^n`: hidden bias
- `b_y ∈ ℝ^p`: output bias

### 5. State update equation
```
i_t = tanh(W_xh · x_t + W_hh · h_{t-1} + b_h)
o_t = σ(W_hy · i_t + b_y)
```

### 6. Activation function
- Typically tanh or ReLU for hidden state
- Sigmoid for output gate

### 7. Learning/plasticity mechanism
- Backpropagation Through Time (BPTT)
- Can use gradient descent, RMSprop, Adam through time

### 8. Temporal behavior
- Maintains state across time steps
- Output depends on entire input history
- Can remember information over time

### 9. Computational cost
- O(n·m + n²) per time step: input projection + recurrent projection
- Higher than feedforward due to recurrent matrix

### 10. Memory requirements
- Store: hidden state h_t, all weight matrices
- Must persist h_t between time steps

### 11. Advantages
- Temporal processing capability
- Can maintain context over time
- Suitable for sequences and time series

### 12. Disadvantages
- Vanishing/exploding gradients through time
- BPTT requires storing all intermediate states
- Memory grows with sequence length
- Slower than feedforward per step

### 13. Suitability for STARK
- **High** — persistent state and temporal processing are core requirements

### 14. How multiple cells connect
- Fully connected recurrent network
- Can have arbitrary connection topology
- Each cell has its own hidden state

### 15. Sparse connectivity
- Can zero out W_hh entries to create sparse recurrent connections
- Sparse matrix multiplication possible

### 16. Recurrent connections
- Native — W_hh explicitly models recurrent connections

### 17. CUDA acceleration
- Possible but more complex than feedforward
- Need to handle dependency chain h_t → h_{t+1}
- Can parallelize across independent recurrent chains

---

## C. Leaky/Integrator Neuron

### 1. Mathematical state
- `V_t ∈ ℝ`: membrane potential/voltage
- `s_t ∈ {0,1}`: spike indicator (for leaky integrator version)

### 2. Inputs
- `I_t ∈ ℝ`: external current/input at time t

### 3. Outputs
- `s_t ∈ {0,1}`: spike output (0 or 1)
- `V_t`: membrane potential (can be read as continuous output)

### 4. Trainable parameters
- `τ` (tau): membrane time constant
- `V_th`: spike threshold
- `V_reset`: reset potential after spike
- Optional: `V_leak`: leak reversal potential

### 5. State update equation (discrete-time leaky integrator):
```
V_t = V_{t-1} * (1 - Δt/τ) + I_t * Δt
```
or continuous:
```
dV/dt = -(V - V_leak)/τ + I(t)
```

### 6. Activation function
- Spike: `s_t = 1 if V_t ≥ V_th else 0`
- Can also output continuous `V_t` directly

### 7. Learning/plasticity mechanism
- Spike-timing-dependent plasticity (STDP)
- Can adjust threshold V_th or time constant τ
- Weight updates based on pre/post-synaptic spike timing

### 8. Temporal behavior
- **Leaky**: membrane "leaks" over time, forgetting past
- **Integrator**: accumulates input over time without leakage
- Time constant τ determines memory duration

### 9. Computational cost
- O(1) per time step: simple leak + add + scale
- Very low computational overhead

### 10. Memory requirements
- Store: membrane potential V_t only
- No weight matrix needed for basic leaky integrator

### 11. Advantages
- Simple, efficient temporal integration
- Leaky version has finite memory (forgets old inputs)
- Integrator version has unbounded accumulation
- Can model biological membrane dynamics

### 12. Disadvantages
- Very simple dynamics — no complex temporal patterns
- Leaky version loses information over time
- Integrator version can have unbounded voltage
- Spike output is binary/ discrete

### 13. Suitability for STARK
- **High** — combines temporal processing with biological plausibility
- Leaky version provides natural forgetting/decay
- Good balance of simplicity and functionality

### 14. How multiple cells connect
- Can form recurrent networks
- Connections can be weighted: I_t → V_t with weight w
- Can have leaky integrators in parallel with different thresholds

### 15. Sparse connectivity
- Trivially sparse — each neuron has its own V_t
- Connections are naturally local (one input per neuron)

### 16. Recurrent connections
- Native — V_t at next step depends on V_{t-1} (intrinsic recurrence)
- Can also have explicit recurrent weight connections

### 17. CUDA acceleration
- Excellent — each neuron independent
- Only need to store V_t per neuron
- Simple element-wise operations

---

## D. Spiking Neuron-Inspired Unit

### 1. Mathematical state
- `V_t ∈ ℝ`: membrane potential
- `spike_t ∈ {0,1}`: discrete spike event
- May have refractory period counter `r_t ∈ {0,1,2,...,R}`

### 2. Inputs
- `I_t ∈ ℝ`: external input current
- May have synaptic weights `w_ij` modulating input

### 3. Outputs
- `spike_t ∈ {0,1}`: spike event output
- Time of spike `t_spike` can encode information

### 4. Trainable parameters
- `V_th`: spike threshold
- `V_reset`: reset potential
- `τ_m`: membrane time constant
- `τ_ref`: refractory period
- Synaptic weights `w_ij` for each incoming connection

### 5. State update equation (leaky integrate-and-fire model):
```
V_t = V_{t-1} * (1 - Δt/τ_m) + I_t * Δt   (if r_t = 0)
if V_t ≥ V_th:
    spike_t = 1
    V_t = V_reset
    r_t = τ_ref   (enter refractory period)
else:
    spike_t = 0
    r_t = max(0, r_t - 1)   (decrement refractory)
```

### 6. Activation function
- Spike event: `spike_t = H(V_t - V_th)` (Heaviside step)
- Can also use smooth approximation for training

### 7. Learning/plasticity mechanism
- STDP: Δw ∝ F(t_post - t_pre)
- Can adjust synaptic weights, thresholds, or time constants
- Multiple STDP variants: additive, multiplicative, normalization

### 8. Temporal behavior
- Spike-based communication
- Refractory period prevents immediate re-firing
- Spike timing carries information
- Population coding through spike patterns

### 9. Computational cost
- O(n) per neuron per time step
- Slightly more than leaky integrator due to spike detection and refractory

### 10. Memory requirements
- Store: V_t, r_t, plus all synaptic weights
- Memory grows with number of connections

### 11. Advantages
- Event-driven computation (spikes are sparse)
- Biological plausibility
- Spike timing carries information
- Natural sparsity: neurons don't spike every timestep
- Can encode information in precise spike timing

### 12. Disadvantages
- More complex state management (refractory period)
- Requires careful time step selection
- Training can be difficult (gradient through spikes)
- Less predictable than rate-coded units

### 13. Suitability for STARK
- **Medium-High** — rich temporal dynamics
- Event-driven nature suits low-power operation
- Spike timing could encode STARK's "attention" or "urgency"
- May be overkill for initial implementation

### 14. How multiple cells connect
- Full synaptic matrix between cells
- Sparse connectivity common in implementations
- Axonal conduction delays can be modeled

### 15. Sparse connectivity
- Naturally supports sparse connections
- Only active synapses compute updates
- Key feature of spiking neural networks

### 16. Recurrent connections
- Native support
- Synaptic delays can be modeled
- Feedback loops through recurrent connections

### 17. CUDA acceleration
- Very good for massive parallelism
- Spike events are sparse → efficient
- Requires careful memory access patterns
- Existing frameworks: Brian2, NEST, cuDNN spiking primitives

---

## E. Leaky Integrator with Adaptive Threshold (Proposed Hybrid)

### Rationale
Combines the best of leaky integrator (temporal dynamics, low cost) with adaptive elements for enhanced STARK suitability.

### 1. Mathematical state
- `V_t ∈ ℝ`: membrane potential
- `θ_t ∈ ℝ`: adaptive threshold

### 2. Inputs
- `I_t ∈ ℝ`: external input current

### 3. Outputs
- `s_t ∈ {0,1}`: spike/spike indicator
- `V_t`: continuous membrane potential (readable)

### 4. Trainable parameters
- `τ_m`: membrane time constant
- `θ_0`: baseline threshold
- `α`: threshold adaptation rate
- `β`: threshold decay/forgetting rate
- `V_reset`: reset potential

### 5. State update equation:
```
# Step 1: leak membrane and add input
V_t = V_{t-1} * (1 - Δt/τ_m) + I_t * Δt

# Step 2: adapt threshold based on recent activity
θ_t = θ_{t-1} * (1 - Δt/β) + |I_t| * α * Δt

# Step 3: check for spike
if V_t ≥ θ_t:
    s_t = 1
    V_t = V_reset
else:
    s_t = 0
```

### 6. Activation function
- Spike when `V_t ≥ θ_t`
- Threshold adapts based on input magnitude

### 7. Learning/plasticity mechanism
- Threshold adapts automatically: `|I_t|` increases threshold with strong input
- `α` controls how quickly threshold rises
- `β` controls how quickly threshold decays when input stops
- Can be combined with weight updates for synapses

### 8. Temporal behavior
- Leaky decay provides finite memory
- Adaptive threshold normalizes response to input magnitude
- Can detect sustained vs. transient inputs
- Threshold "learns" what level of input is normal

### 9. Computational cost
- O(1) per time step: same as leaky integrator plus one absolute value and one multiplication/division for threshold
- Negligible overhead

### 10. Memory requirements
- Store: V_t, θ_t (2 scalars per neuron)
- Minimal additional memory

### 11. Advantages
- Normalizes response to input magnitude
- Automatically adapts to input statistics
- Leaky decay prevents unbounded accumulation
- Can detect changes in input statistics
- Biological plausibility with adaptive threshold

### 12. Disadvantages
- Slightly more complex than basic leaky integrator
- Threshold adaptation parameters need tuning
- Still relatively simple dynamics

### 13. Suitability for STARK
- **Very High** — adaptive threshold provides a form of "attention" or "sensitivity" control
- Leaky decay gives natural short-term memory decay
- Threshold adaptation could model arousal/alertness levels
- Minimal computational overhead

### 14. How multiple cells connect
- Each cell has independent V_t, θ_t
- Synaptic weights can modulate I_t entering each cell
- Population of cells can encode different features
- Sparse connectivity natural between cells

### 15. Sparse connectivity
- Each neuron only needs its own V_t, θ_t
- Synaptic weights modulate input current
- Easy to implement sparse weight matrices

### 16. Recurrent connections
- Native — V_t recurrence is intrinsic
- Can add recurrent weights: I_t includes contribution from other cells' outputs
- Feedback possible through threshold modulation

### 17. CUDA acceleration
- Excellent — same as leaky integrator
- Two additional scalar per neuron (θ_t)
- Element-wise operations throughout

---

## Summary Comparison Table

| Primitive | Temporal | Sparse | Recurrent | CUDA | Cost | STARK Suitability |
|-----------|----------|--------|-----------|------|------|-------------------|
| Conventional | No | Manual | No | Trivial | Trivial | Low |
| Recurrent | Yes | Manual | Yes | Complex | Medium | High |
| Leaky/Integrator | Yes | Natural | Yes (intrinsic) | Excellent | Trivial | High |
| Spiking | Yes | Natural | Yes | Very Good | Low-Medium | Medium-High |
| Adaptive Threshold Leaky | Yes | Natural | Yes | Excellent | Trivial | **Very High** |

---

## Research Recommendation

Based on the comparative analysis, the **Leaky Integrator with Adaptive Threshold** (Variant E) provides the best foundation for STARK-001 because:

1. **Temporal processing**: Maintains persistent state across time steps
2. **Leaky decay**: Provides natural short-term memory with forgetting
3. **Adaptive threshold**: Acts as a dynamic sensitivity controller — could model attention/arousal
4. **Computational efficiency**: O(1) per neuron per timestep, trivial to implement in C++
5. **CUDA readiness**: Same operations as basic leaky integrator, just two extra scalars
6. **Sparse connectivity**: Each neuron independent; connections modulate input current
7. **Recurrent support**: Intrinsic recurrence via V_t; can add explicit recurrent weights
8. **Biological inspiration**: Leaky integrate-and-fire is one of the most studied neural models
9. **Numerical stability**: Leak term prevents unbounded voltage accumulation
10. **Composability**: Multiple cells naturally form networks through synaptic connections

The adaptive threshold is the key differentiator — it provides a mechanism where the neuron's sensitivity can change based on input statistics, which is useful for a persistent cognitive entity that needs to adjust its "attention" or "sensitivity" to relevant vs. irrelevant inputs over time.

**STARK-001 neural cell = Leaky Integrator with Adaptive Threshold**

This choice balances simplicity, temporal dynamics, biological plausibility, and computational efficiency while providing features that will be valuable as the system grows toward persistent cognitive processing.