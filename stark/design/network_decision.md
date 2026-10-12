# STARK-003 Design Decision

## Recommended Network Architecture

**STARK-003 network = Centralized Sparse Network with Flat Synapse Array and Per-Neuron Adjacency Lists**

---

## Core Rationale

After comprehensive comparison of network representations, the centralized sparse network with flat synapse array was selected as the foundational network substrate for STARK-003. This section explains the decision in detail.

---

## How Centralized Network Meets STARK-003 Requirements

### 1. Sparse Structured Connectivity
- **Mechanism**: Flat `std::vector<SynapseInstance>` stores all synapses; `outgoing[neuron_id]` and `incoming[neuron_id]` provide O(1) adjacency access
- **Result**: Memory O(N + E), computation O(E) per timestep
- **Structured builders**: Helper functions `connectRandomSparse()`, `connectLocal()`, `connectAllToAll()` can populate the flat array deterministically

### 2. Transmission Delays (1-5 ms)
- **Mechanism**: Each `SynapseInstance` has `size_t delay` (in timesteps) and a small circular buffer or queue for delayed spike delivery
- **Result**: Spike emitted at `t` arrives at post-synaptic neuron at `t + delay`
- **Implementation**: During step, collect spikes; schedule delivery to synapses at `current_time + delay`

### 3. Event-Driven Simulation for Sparse Spiking
- **STARK-003 approach**: Start with **fixed-timestep** for determinism and simplicity
- **Future**: Add `EventDrivenNetwork` subclass or scheduler option
- **Rationale**: For 10-100 neurons, fixed-timestep overhead is negligible; determinism is more valuable

### 4. 10-100 Neurons — Network-Level Dynamics
- **Mechanism**: Centralized arrays make it trivial to iterate all neurons, all synapses
- **Observables**: Population firing rates, synchrony, oscillations, attractor states
- **Diagnostics**: Per-neuron spike counts, per-synapse states, connectivity queries

### 5. Excitatory and Inhibitory Connections
- **Mechanism**: Synapse weight `w ∈ R` already supports both signs (STARK-002)
- **E/I balance**: Network builders can enforce ratios (e.g., 80/20) as experimental configuration

### 6. Multiple Incoming/Outgoing Connections
- **Mechanism**: Adjacency lists naturally support fan-in and fan-out
- **Summation**: Post-synaptic neuron receives sum of all incoming synaptic currents

---

## Architecture: Three-Layer Separation

| Layer | Class | Responsibility | State Owned |
|-------|-------|----------------|-------------|
| **Primitive** | `NeuralCell` | Membrane dynamics, spike generation, adaptation | `V, a, θ, spike` |
| **Primitive** | `Synapse` | Synaptic current transformation, temporal decay | `x` |
| **Composite** | `Network` | Routing, scheduling, connectivity, diagnostics | Neuron array, Synapse array, adjacency, time |

### Key Principle: Network Does NOT Duplicate Neuron/Synapse Math

The `Network::step()` orchestrates but does NOT reimplement:
- Neuron membrane equation (stays in `NeuralCell::update`)
- Synaptic decay equation (stays in `Synapse::receiveSpike`)
- Network only manages: input accumulation, spike routing, time advancement

---

## Network API Design

```cpp
class Network {
public:
    // Construction
    Network() = default;
    ~Network() = default;
    
    // Neuron management
    size_t addNeuron(const NeuralCell& neuron);           // Returns neuron_id
    size_t addNeuron(double tau_m, double theta_0,        // Convenience: create + add
                     double tau_a, double b, double v_reset);
    NeuralCell& getNeuron(size_t id);
    const NeuralCell& getNeuron(size_t id) const;
    size_t getNeuronCount() const;
    
    // Synapse management
    size_t addSynapse(size_t pre_id, size_t post_id,      // Returns synapse_id
                      double weight, double tau_s = 2.0,
                      size_t delay = 0);
    Synapse& getSynapse(size_t id);
    const Synapse& getSynapse(size_t id) const;
    size_t getSynapseCount() const;
    
    // Connectivity queries
    const std::vector<size_t>& getOutgoingSynapses(size_t neuron_id) const;
    const std::vector<size_t>& getIncomingSynapses(size_t neuron_id) const;
    bool hasConnection(size_t pre_id, size_t post_id) const;
    
    // External input
    void setExternalInput(size_t neuron_id, double I);    // For next step
    void clearExternalInputs();
    
    // Simulation control
    void step(double dt);                                 // Single timestep
    void run(size_t steps, double dt);                    // Multiple steps
    void reset();                                         // Reset all neurons + synapses + time
    
    // State inspection
    size_t getCurrentTimeStep() const;
    const std::vector<bool>& getSpikesThisStep() const;   // Which neurons spiked
    const std::vector<double>& getExternalInputs() const;
    
    // Structured connectivity builders (optional convenience)
    void connectRandomSparse(double connection_probability,
                             double exc_weight, double inh_weight,
                             double exc_tau_s, double inh_tau_s,
                             double exc_ratio = 0.8);
    void connectLocal(size_t radius, double weight, double tau_s);
    void connectAllToAll(double weight, double tau_s);
    
private:
    // State
    std::vector<NeuralCell> neurons_;
    std::vector<SynapseInstance> synapses_;
    std::vector<std::vector<size_t>> outgoing_;  // per neuron: list of synapse indices
    std::vector<std::vector<size_t>> incoming_;  // per neuron: list of synapse indices
    
    // Simulation state
    size_t timestep_ = 0;
    std::vector<double> external_inputs_;  // per neuron
    std::vector<bool> spikes_this_step_;   // per neuron
    
    // Delayed spike delivery (for transmission delays)
    std::vector<std::vector<std::pair<size_t, bool>>> delayed_spikes_;  // [target_neuron] = list of (synapse_id, spike)
    
    // Helpers
    void validateNeuronId(size_t id) const;
    void validateSynapseId(size_t id) const;
    void deliverSpikes(double dt);
};
```

---

## Mathematical Model: Discrete Network Update

### Convention: Spikes at `t` → Synaptic Current at `t+1`

This avoids same-timestep recursive propagation and matches the two-neuron experiment in `main.cpp`.

### Network State at Time `t`

| Component | State at Start of `t` |
|-----------|----------------------|
| Neuron `i` | `V_i(t), a_i(t), θ_i(t)` |
| Synapse `k` (pre→post) | `x_k(t)` |
| External input to `i` | `I_ext,i(t)` (set before step) |
| Delayed spikes arriving at `t` | Queued from previous steps |

### Update Algorithm (Single Timestep `t → t+1`)

```
Input: dt (validated against all neurons' min(tau_m, tau_a) and all synapses' tau_s)

1. EXTERNAL INPUT
   For each neuron i: I_total[i] = external_inputs_[i]

2. SYNAPTIC CURRENTS FROM PREVIOUS STEP
   For each neuron i:
       For each incoming synapse k to neuron i:
           I_total[i] += synapses_[k].synapse.getCurrent()  // w * x from previous step

3. NEURON UPDATE (determines spikes at time t)
   For each neuron i:
       spike[i] = neurons_[i].update(I_total[i], dt)
   Record spikes_this_step_[i] = spike[i]

4. SPIKE DELIVERY TO SYNAPSES (for next timestep's current)
   For each neuron i that spiked:
       For each outgoing synapse k from neuron i:
           if delay == 0:
               synapses_[k].synapse.receiveSpike(true, dt)  // updates x, current ready for t+1
           else:
               Schedule delivery to target neuron at timestep t + delay

   For neurons that didn't spike:
       For each outgoing synapse k:
           synapses_[k].synapse.receiveSpike(false, dt)  // decay only

5. DELAYED SPIKE PROCESSING
   For each neuron i receiving delayed spikes at this timestep:
       For each (synapse_id, spike) in delayed_spikes_[i]:
           synapses_[synapse_id].synapse.receiveSpike(spike, dt)

6. ADVANCE TIME
   timestep_++
   Clear external_inputs_
   Advance delayed_spikes_ queues
```

### Reset Semantics

```
reset():
   For each neuron: neuron.reset()  // V=v_reset, a=0, θ=θ_0, spike=false
   For each synapse: synapse.reset()  // x=0
   timestep_ = 0
   external_inputs_ = zeros
   spikes_this_step_ = false
   delayed_spikes_ = empty
```

---

## Numerical Requirements

### Timestep Validation

The network must validate `dt` against **all** components before simulation:

```cpp
bool validateDt(double dt) const {
    if (dt <= 0) return false;
    if (!std::isfinite(dt)) return false;
    
    // Check all neurons
    for (const auto& n : neurons_) {
        if (!n.validateDt(dt)) return false;  // dt < min(tau_m, tau_a)
    }
    
    // Check all synapses
    for (const auto& s : synapses_) {
        if (!s.synapse.validateDt(dt)) return false;  // dt < tau_s
    }
    
    return true;
}
```

### Finite Input Validation

- External inputs must be finite (validated in `setExternalInput`)
- Network propagates this to neurons (already validated in `NeuralCell::update`)

---

## Diagnostic Capabilities

The network must support queries for STARK's future self-modeling:

1. **Neuron count**: `getNeuronCount()`
2. **Synapse count**: `getSynapseCount()`
3. **Spikes this step**: `getSpikesThisStep()` → `vector<bool>`
4. **Neuron state**: `getNeuron(id).getV()`, `.getTheta()`, `.getSpike()`
5. **Synapse state**: `getSynapse(id).getState()`, `.getWeight()`
6. **Connectivity**: `getIncomingSynapses(id)`, `getOutgoingSynapses(id)`
7. **Current timestep**: `getCurrentTimeStep()`
8. **External inputs**: `getExternalInputs()`

---

## Test Plan

| Test | Description | Verifies |
|------|-------------|----------|
| 1 | Single neuron with external input | Basic network + neuron integration |
| 2 | A → B excitatory propagation | Spike routing, E synapse |
| 3 | A → B inhibitory connection | I synapse sign |
| 4 | Multiple synapses → one neuron | Convergence, summation |
| 5 | One neuron → multiple targets | Divergence |
| 6 | Network reset | Deterministic initial state |
| 7 | Deterministic repeated execution | Identical runs produce identical spikes |
| 8 | STARK-001/002 regression | No behavioral changes to primitives |
| 9 | Invalid neuron/synapse references | Bounds checking |
| 10 | Non-finite input / invalid dt | Validation at network level |
| 11 | Transmission delays (1-5 steps) | Delayed spike delivery |
| 12 | Structured connectivity builders | Random sparse, local, all-to-all |

---

## Files to Create/Modify

1. **New**: `src/neural/Network.h` — Network class declaration
2. **New**: `src/neural/Network.cpp` — Network implementation
3. **New**: `math/network_specification.md` — Mathematical specification
4. **New**: `src/test_network.cpp` — Unit/integration tests
5. **New**: `src/network_demo.cpp` — Demonstration program
6. **Modify**: `CMakeLists.txt` — Add new executables

---

## What STARK-003 Does NOT Implement

- ❌ Learning / STDP / plasticity
- ❌ Memory systems (episodic, semantic, procedural)
- ❌ Attention / global workspace
- ❌ Cognition / planning / task graphs
- ❌ Voice / vision / screen awareness
- ❌ Autonomous agents
- ❌ CUDA / GPU acceleration
- ❌ Language models / Transformers

---

## Technical Debt to Track

1. **Event-driven scheduler**: For larger networks, fixed-timestep is wasteful when activity is sparse
2. **SynapseInstance delay queue**: Current design uses per-target-neuron delayed_spikes vector; could optimize with single priority queue
3. **Network serialization**: Needed for persistence (STARK-004+)
4. **Parallel update**: For GPU, need to separate spike detection from state update

---

## Next Step: STARK-004 Proposal

After STARK-003 is frozen, STARK-004 should add:

**STARK-004 = Spike-Timing-Dependent Plasticity (STDP) + Structural Plasticity**

- Pre-synaptic trace `x_t` already available in Synapse (STARK-002)
- Post-synaptic trace needed in NeuralCell (or new eligibility trace)
- Weight update rule: `Δw = A+ * x_pre * post_spike - A- * x_post * pre_spike`
- Structural plasticity: synapse formation/elimination based on activity
- Enables learning from experience, memory formation

---

*Design decision documented. Proceeding to implementation.*