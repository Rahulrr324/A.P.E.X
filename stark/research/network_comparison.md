# STARK-003 Research: Network Representation Comparison

## Objective
Compare network representations to select the best foundation for STARK's network substrate built on NeuralCell + Synapse.

---

## A. Adjacency-List Graph

### 1. Mathematical state
- Neurons: set of N neuron objects `{neuron_i}`
- Synapses: adjacency list `adj[i] = list of (target_id, synapse_ptr)`

### 2. Inputs
- External inputs per neuron: `I_ext[i]`

### 3. Outputs
- Spike indicators per neuron: `s[i] ∈ {0,1}`
- Readable states: `V[i], θ[i], x[synapse]`

### 4. Parameters
- Neuron parameters (per neuron)
- Synapse parameters (per synapse)
- Global simulation time step `Δt`

### 5. Temporal behavior
- Fixed time step update
- Can support event-driven if sparse

### 6. Computational cost
- O(E) per timestep where E = number of edges/synapses
- Sparse: E << N²

### 7. Memory requirements
- O(N + E) — neurons + synapses

### 8. Advantages
- Natural for sparse connectivity
- Easy to iterate outgoing edges from a neuron
- Memory efficient for sparse networks
- Supports heterogeneous parameters per neuron/synapse

### 9. Disadvantages
- Finding incoming edges requires reverse adjacency or scan
- Random access to specific synapse slower

### 10. Suitability for STARK
- **High** — STARK needs sparse, structured connectivity

### 11. How multiple neurons connect
- Explicit directed edges with individual synapse objects

### 12. Sparse connectivity
- Native — only store existing connections

### 13. Recurrent connections
- Native — any directed edge including self-loops

### 14. Future plasticity
- Easy — each synapse object has own weight, state, parameters

### 15. Serialization
- Straightforward: list neurons, list edges

### 16. Debugging/Inspection
- Good — can trace any path

---

## B. Adjacency-Matrix Graph

### 1. Mathematical state
- Dense matrix `W[i][j]` of weights
- Dense matrix `τ_s[i][j]` of time constants
- State matrix `x[i][j]` for synaptic states

### 2. Advantages
- O(1) random access to any connection
- Simple dense matrix operations
- Natural for linear algebra / GPU

### 3. Disadvantages
- O(N²) memory — impractical for large sparse networks
- Wasted computation on zero weights
- Hard to support heterogeneous `τ_s` per synapse efficiently

### 4. Suitability for STARK
- **Low** — STARK targets sparse connectivity from the start

---

## C. Neuron-Owned Outgoing Synapse Lists

### 1. Mathematical state
- Each `NeuralCell` owns a `std::vector<Synapse*>` or `std::vector<Synapse>` of outgoing synapses
- Each synapse knows its target neuron ID

### 2. Advantages
- Very natural: neuron "knows" where it projects
- Easy to iterate: `for (syn : neuron.outgoing) { ... }`
- Clear ownership semantics

### 3. Disadvantages
- Finding all synapses *targeting* a specific neuron requires reverse lookup
- Global synapse management split across neurons
- Harder to implement global network operations (reset all, count all)

### 4. Suitability for STARK
- **Medium** — good for feedforward, less for recurrent analysis

---

## D. Centralized Network Graph (Chosen)

### 1. Mathematical state
- `std::vector<NeuralCell> neurons` — indexed by neuron ID (0..N-1)
- `std::vector<Synapse> synapses` — flat array of all synapses
- `std::vector<std::vector<size_t>> outgoing_synapses` — per-neuron list of synapse indices
- `std::vector<std::vector<size_t>> incoming_synapses` — per-neuron list of synapse indices (optional, for inspection)

### 2. Synapse struct
```cpp
struct SynapseInstance {
    size_t pre_neuron;      // Source neuron ID
    size_t post_neuron;     // Target neuron ID
    Synapse synapse;        // Synapse object (state + params)
    size_t delay;           // Transmission delay in timesteps (STARK-003+)
};
```

### 3. Update algorithm (fixed timestep)
```cpp
void step(double dt) {
    // 1. Determine external inputs for each neuron
    // 2. Update all neurons with their total input (external + synaptic)
    //    Collect which neurons spiked this timestep
    // 3. For each spike, deliver to outgoing synapses
    //    Synapses update state, produce current for NEXT timestep
    //    (Or current timestep depending on convention)
    // 4. Accumulate synaptic currents for next step
}
```

### 4. Advantages
- Single source of truth for all neurons and synapses
- Easy global operations: reset, count, serialize, inspect
- Both incoming and outgoing adjacency available O(1)
- Natural for structured connectivity builders
- Clear separation: Network routes, Neuron computes, Synapse transforms
- Scales: O(N + E) memory, O(E) computation per step
- Deterministic ordering (by neuron ID, then synapse ID)

### 5. Disadvantages
- Slightly more indirection than neuron-owned
- Need to manage synapse IDs carefully

### 6. Suitability for STARK
- **Very High** — best balance for STARK's requirements:
  - Sparse connectivity (O(E) not O(N²))
  - Deterministic behavior (fixed iteration order)
  - Easy inspection (critical for STARK's self-modeling)
  - Supports delays (queue per synapse or global event queue)
  - Easy to add structured connectivity builders
  - Future-proof for plasticity (all synapses in one place)

---

## E. Event-Driven Scheduler (Alternative for STARK-003+)

### 1. Concept
- Maintain priority queue of `(time, event)` where event = spike delivery
- Neurons only update when receiving input or at scheduled times
- More efficient for very sparse spiking

### 2. Advantages
- Computation proportional to spikes, not timesteps
- Natural for transmission delays
- Can run faster than real-time for sparse activity

### 3. Disadvantages
- More complex implementation
- Harder to reason about determinism
- Overkill for 10-100 neurons with fixed `dt`

### 4. Suitability for STARK
- **Medium-High for STARK-003** — implement fixed-timestep first, add event-driven option later
- **High for STARK-004+** when scaling up

---

## Summary Comparison

| Requirement | Adj-List | Adj-Matrix | Neuron-Owned | **Centralized** | Event-Driven |
|-------------|----------|------------|--------------|-----------------|--------------|
| Sparse connectivity | ✅✅✅ | ❌ | ✅✅ | ✅✅✅ | ✅✅✅ |
| Deterministic | ✅✅ | ✅✅ | ✅ | ✅✅✅ | ⚠️ |
| Global ops (reset, count) | ✅✅ | ✅✅ | ⚠️ | ✅✅✅ | ✅✅ |
| Inspection/debugging | ✅✅ | ✅✅ | ⚠️ | ✅✅✅ | ⚠️ |
| Delays | ✅ | ✅ | ⚠️ | ✅✅✅ | ✅✅✅ |
| Heterogeneous params | ✅✅✅ | ⚠️ | ✅✅✅ | ✅✅✅ | ✅✅✅ |
| CPU efficiency (sparse) | ✅✅✅ | ❌ | ✅✅✅ | ✅✅✅ | ✅✅✅ |
| GPU efficiency | ⚠️ | ✅✅✅ | ⚠️ | ⚠️ | ⚠️ |
| Serialization | ✅✅ | ✅✅ | ⚠️ | ✅✅✅ | ⚠️ |
| STARK-003 scale (10-100) | ✅✅ | ❌ | ✅✅ | ✅✅✅ | ✅✅ |
| Scalability | ✅✅✅ | ❌ | ✅✅ | ✅✅✅ | ✅✅✅ |

---

## Research Recommendation

**Choose D: Centralized Network Graph with flat synapse array and per-neuron adjacency lists.**

### Rationale:
1. **Sparse-first design**: O(N + E) memory, O(E) per timestep — matches brain-like sparsity
2. **Determinism**: Fixed iteration order (neuron ID → synapse ID) ensures reproducible results
3. **Inspection**: Can query any neuron's state, any synapse's state, incoming/outgoing connections
4. **STARK-003 requirements**: Delays, structured connectivity, diagnostics all natural
5. **Future-proof**: Easy to add event-driven scheduler, plasticity, serialization
6. **Clean separation**: Network = routing + scheduling; Neuron = membrane dynamics; Synapse = current transformation

This is the minimal substrate that enables the STARK-003 experiments while leaving room for growth.

---

*Research complete. Proceeding to design decision.*