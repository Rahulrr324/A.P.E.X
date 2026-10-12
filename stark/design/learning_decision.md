# STARK-004 Learning Decision

## What "Learning" Means for STARK-004

For STARK-004, **learning** is defined as the ability of the neural network to modify its behavior based on experience. Specifically, this means:

1. **Synaptic Weight Modification**: The primary mechanism of learning in STARK-004 is the adjustment of synaptic weights based on the timing of pre- and post-synaptic spikes. This is implemented using Spike-Timing-Dependent Plasticity (STDP).

2. **Temporal Sensitivity**: Learning is sensitive to the timing of spikes, allowing the network to capture temporal patterns in the input.

3. **Local Information**: Learning occurs using only local information available at the synapse (pre- and post-synaptic spike timing).

4. **Stability**: Learning includes mechanisms to prevent runaway weight growth and maintain network stability.

5. **Deterministic Behavior**: Learning updates are deterministic and reproducible given the same initial conditions and input sequence.

---

## What Changes When STARK Learns?

In STARK-004, the following changes occur during learning:

### Plastic Components

1. **Synaptic Weights ($w$)**: The strength of connections between neurons is modified based on STDP rules.
2. **Synaptic Traces ($x_{pre}$, $x_{post}$)**: Temporary state variables that track recent spike activity for use in STDP updates.

### Non-Plastic Components (for STARK-004)

The following components are **not** plastic in STARK-004 but may become plastic in future phases:

1. **Neuronal Excitability**: Thresholds ($	heta_0$) and adaptation parameters ($b$, $\tau_a$) remain fixed.
2. **Membrane Time Constants ($\tau_m$)**: Remain fixed.
3. **Synaptic Time Constants ($\tau_s$)**: Remain fixed.
4. **Structural Connectivity**: The existence of synapses remains fixed. Structural plasticity (synapse formation/elimination) is not implemented in STARK-004.
5. **Internal State Variables**: Membrane potential ($V$) and adaptation state ($a$) are not directly modified by learning.

---

## Why Synaptic Weights?

Synaptic weights are the most natural and well-studied substrate for learning in neural networks. They:

1. **Capture Experience**: Weights encode the network's experience and determine how information flows through the network.
2. **Are Local**: Weight updates can be computed using only local information, making them scalable and biologically plausible.
3. **Are Compatible with STARK's Architecture**: STARK already has a `Synapse` class with a weight parameter, making it straightforward to extend.
4. **Support Future Extensions**: Synaptic weights can be modulated by reward signals, attention, or other mechanisms in future phases.

---

## Learning Mechanism Selection

### Primary Mechanism: Pair-based STDP

**Rationale:**
- **Compatibility**: STDP is directly compatible with STARK's spike-based architecture.
- **Temporal Sensitivity**: STDP captures temporal patterns in the input, which is critical for STARK's eventual goal of real-time interaction.
- **Computational Efficiency**: STDP updates are computationally efficient and suitable for CPU execution.
- **Foundation for Future Work**: STDP provides a foundation for future extensions like reward modulation or structural plasticity.

### Complementary Mechanism: Weight Bounds and Normalization

**Rationale:**
- **Stability**: Unbounded weight growth can lead to instability. Hard bounds and normalization prevent this.
- **Determinism**: Bounds ensure that weights remain within a predictable range, which is important for debugging and reproducibility.
- **Simplicity**: Hard bounds are simple to implement and validate.

---

## Mathematical Definition of Learning in STARK-004

### STDP Update Rule

The weight update $\Delta w$ is defined as:

$$\Delta w = \begin{cases}
  +A_+ \cdot x_{pre} & \text{when a POST-synaptic spike occurs (LTP)} \\
  -A_- \cdot x_{post} & \text{when a PRE-synaptic spike occurs (LTD)}
\end{cases}$$

Where:
- $A_+$ is the learning rate for long-term potentiation (LTP).
- $A_-$ is the learning rate for long-term depression (LTD).
- $x_{pre}(t)$ is the pre-synaptic trace at time $t$.
- $x_{post}(t)$ is the post-synaptic trace at time $t$.

This yields the correct timing dependence:
- **pre → post** (pre fires, then post fires): the post spike reads the
  elevated $x_{pre}$ and applies $+A_+ x_{pre} > 0$. **Weight increases (LTP).**
- **post → pre** (post fires, then pre fires): the pre spike reads the
  elevated $x_{post}$ and applies $-A_- x_{post} < 0$. **Weight decreases (LTD).**

### Synaptic Traces

The pre- and post-synaptic traces decay exponentially:

$$x_{pre}(t) = \sum_{t_{pre}} \exp\left(-\frac{t - t_{pre}}{\tau_{pre}}\right)$$

$$x_{post}(t) = \sum_{t_{post}} \exp\left(-\frac{t - t_{post}}{\tau_{post}}\right)$$

In practice, these are implemented as:

$$x_{pre}(t+dt) = x_{pre}(t) \cdot \exp\left(-\frac{dt}{\tau_{pre}}\right)$$
$$x_{post}(t+dt) = x_{post}(t) \cdot \exp\left(-\frac{dt}{\tau_{post}}\right)$$

And updated on spikes:

$$x_{pre}(t) += 1 \quad \text{when a pre-synaptic spike occurs}$$
$$x_{post}(t) += 1 \quad \text{when a post-synaptic spike occurs}$$

### Weight Bounds

Weights are clamped to a range $[w_{min}, w_{max}]$:

$$w = \text{clamp}(w + \Delta w, w_{min}, w_{max})$$

---

## Timestep Ordering

Learning updates occur in the following order within a single timestep (this
matches `Network::step()` exactly):

1. **Decay Traces**: `decayTraces(dt)` on every synapse (exact exponential).
2. **Accumulate Inputs**: Calculate the total input current for each neuron.
3. **Update Neurons**: Update neuron state and collect spikes. For each spiking
   neuron, increment `x_post` on all its incoming synapses.
4. **Deliver Pre Spikes**: For each spiking neuron, `receiveSpike` on its
   outgoing synapses (increments `x_pre` and updates synaptic current).
5. **STDP Update**: For each synapse, if post spiked apply LTP
   (`+A_+ x_pre`); if pre spiked apply LTD (`-A_- x_post`).
6. **Weight Clamping**: Clamp weights to $[w_{min}, w_{max}]$ after each update.
7. **Advance Timestep**: Process delayed deliveries and clear external inputs.

This ordering ensures that:
- Spikes generated in the current timestep affect traces and weights in the same timestep.
- Weight updates are based on the most recent spike activity.
- If both pre and post spike in the same timestep, BOTH updates are applied:
  $\Delta w_{total} = A_+ x_{pre} - A_- x_{post}$.

---

## Deterministic Behavior

STDP updates are deterministic and reproducible given:

1. The same initial network state.
2. The same input sequence.
3. The same random seed (if any stochasticity is introduced in future phases).

This is critical for debugging, testing, and eventual self-verification.

---

## Limitations and Future Work

### Limitations

1. **No Structural Plasticity**: Synapses cannot be created or eliminated in STARK-004.
2. **No Reward Modulation**: STDP is purely unsupervised; there is no reward signal to guide learning.
3. **Fixed Neuronal Parameters**: Neuronal excitability and time constants are fixed.
4. **No Homeostatic Plasticity**: While weight bounds prevent runaway growth, there is no mechanism to maintain target activity levels.

### Future Work

1. **Structural Plasticity**: Allow synapses to form or eliminate based on activity.
2. **Reward-Modulated STDP**: Introduce a reward signal to guide learning.
3. **Homeostatic Plasticity**: Adjust neuronal excitability or synaptic weights to maintain target activity levels.
4. **Three-Factor Learning**: Introduce eligibility traces for more complex learning rules.
5. **Meta-Learning**: Allow the network to adjust its own learning rates or plasticity rules.