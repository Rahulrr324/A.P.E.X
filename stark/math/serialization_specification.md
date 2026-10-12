# STARK-007 Mathematical Specification: State Serialization & Reproducible Experiment Harness

> STATUS: IMPLEMENTED AND VERIFIED. This specification matches the actual C++ implementation in
> `src/neural/Network.h/.cpp`, `src/experiment/Recorder.{h,cpp}`, `src/experiment/Experiment.{h,cpp}`,
> and `tests/test_serialization.cpp`.

---

## 0. Model class

**Deterministic checkpoint/resume + thin experiment harness.**

The goal is to make STARK observable, checkpointable, and reproducible — without adding a second simulation engine or polluting the frozen neural primitives.

STARK-001..006 implement a fully deterministic fixed-timestep simulator. There is **no RNG state** in the current stepping logic (`connectRandomSparse` uses a local seed 42 but does not expose it as network state). Therefore reproducibility requires only saving and restoring the **complete mutable state** that affects future `step(dt)` execution.

---

## 1. Checkpoint boundary

A checkpoint is **only legal at completed `Network::step(dt)` boundaries**.

Formally:

```
state_before = Network after step(t) has returned
save(state_before) -> string
load(string) -> fresh Network identical to state_before
```

Mid-step serialization is **not supported** and must not be implemented. The caller must ensure the Network has completed at least one `step(dt)` before calling `serialize()`, or call it on a freshly-constructed empty Network (which is also a valid boundary — step 0).

---

## 2. Format identity

**Magic identifier:** `STARK006`
**Schema version:** `2`

These are **canonical**. Do NOT rename them to `STARK007`. The format identity reflects the infrastructure layer, not the project phase number. Schema version bumps occur only when an actual wire-format field change is made.

### Compatibility matrix

| Serialized version | Supported? | Notes |
|--------------------|------------|-------|
| `1`                  | Yes        | Legacy format; three-factor fields absent, decoded as zero/default |
| `2`                  | Yes        | Current format; includes eligibility, mode, modulator |
| `3+`                 | Rejected   | `std::invalid_argument` — no silent defaults invented |
| Unknown magic        | Rejected   | `std::invalid_argument` |

**Unknown future versions:** rejected. Future schema extensions may introduce new tokens but must never silently ignore unknown required fields. Extra fields at end of file are tolerated if parsing consumes all required tokens for the declared version.

---

## 3. Authoritative serialized state inventory

Every field below can affect future `step(dt)` execution. Fields that are purely derived from other stored state are **not** serialized separately.

### 3.1 Header

| Token | Field | Type | Validation |
|-------|-------|------|------------|
| Magic | `"STARK006"` | literal | exact match |
| Version | `"2"` | literal | exact match (or `"1"` for v1) |
| N | neuron count | `size_t` | `>= 0` |
| E | synapse count | `size_t` | `>= 0` |
| timestep | current step index | `size_t` | `>= 0` |
| homeo_flag | homeostasis enabled | `{0,1}` | binarized |

### 3.2 Homeostatic parameters

| Token | Field | Constraint |
|-------|-------|------------|
| H | `tau_r` | `> 0`, finite |
|   | `kappa` | `> 0` when enabled, finite |
|   | `target_hz` | `>= 0`, finite |
|   | `hysteresis_hz` | `>= 0`, finite |

### 3.3 Per-neuron arrays

| Token | Field | Size | Constraint |
|-------|-------|------|------------|
| R | `r_mean[i]` | N | `>= 0`, finite |
| S | `homeostatic_scale[i]` | N | `> 0`, finite |
| SP | `spikes_this_step[i]` | N | `{0, 1}` |
| E | `external_inputs[i]` | N | finite |

### 3.4 Neurons (NC tokens)

For each neuron `i`:

| Token | Field | Constraint |
|-------|-------|------------|
| NC i | `tau_m` | `> 0`, finite |
|      | `theta_0` | `>= 0`, finite |
|      | `tau_a` | `> 0`, finite |
|      | `b` | `>= 0`, finite |
|      | `v_reset` | finite |
|      | `V` | finite |
|      | `a` | `>= 0`, finite |
|      | `spiked` | `{0, 1}` |

Note: `theta` is **not serialized**. It is reconstructed as `theta_0 + a` on load to preserve the invariant `theta == theta_0 + a`.

### 3.5 Synapses (SC tokens)

For each synapse `k`:

| Token | Field | Constraint |
|-------|-------|------------|
| SC k | `pre_neuron` | `in [0, N)` |
|      | `post_neuron` | `in [0, N)` |
|      | `delay` | `>= 0` integer |
|      | `tau_s` | `> 0`, finite |
|      | `w` | finite |
|      | `x` | `>= 0`, finite |
|      | `x_pre` | `>= 0`, finite |
|      | `x_post` | `>= 0`, finite |
|      | `w_min` | finite, `<= w_max` |
|      | `w_max` | finite, `>= w_min` |
|      | `A_plus` | `>= 0`, finite (when plasticity enabled) |
|      | `A_minus` | `>= 0`, finite (when plasticity enabled) |
|      | `tau_pre` | `> 0`, finite (when plasticity enabled) |
|      | `tau_post` | `> 0`, finite (when plasticity enabled) |
|      | `plasticity_enabled` | `{0, 1}` |
|      | `e` (v2 only) | finite |
|      | `E_plus` (v2) | `>= 0`, finite (when TF enabled) |
|      | `E_minus` (v2) | `>= 0`, finite (when TF enabled) |
|      | `tau_e` (v2) | `> 0`, finite (when TF enabled) |
|      | `eta_3f` (v2) | `> 0`, finite (when TF enabled) |
|      | `three_factor_enabled` (v2) | `{0, 1}` |
|      | `mode` (v2) | `{0, 1, 2}` = NONE / STDP / THREEFACTOR |

**Derived topology (`outgoing_`, `incoming_`) is NOT serialized.** It is reconstructed deterministically from the `(pre_neuron, post_neuron)` pairs.

### 3.6 Modulatory signal (M token, v2 only)

| Token | Field | Constraint |
|-------|-------|------------|
| M | `modulatory_signal` | finite |

This is a transient input captured immediately before clear. On resume, the caller supplies a new schedule.

### 3.7 Delay queue (DQ tokens)

| Token | Field | Constraint |
|-------|-------|------------|
| DQ | N queues | count must equal neuron count |
| Q i | queue size | `>= 0` |
|     | per-entry: `synapse_id`, `delivery_timestep` | `synapse_id < E` |

Each entry is `(synapse_id, delivery_timestep)` where `delivery_timestep` is an absolute integer matching the `timestep_` semantics used during scheduling (`timestep_ + delay`).

### 3.8 Not serialized

| Item | Reason |
|------|--------|
| `dt` | Configuration, not state. Caller resumes with same dt. |
| `outgoing_`, `incoming_` | Derived from synapse topology; reconstructible. |
| `theta_i` | Derived: `theta_0_i + a_i`. |
| RNG state | No simulation RNG exists in current STARK-001..006. |
| Wall-clock time | Non-deterministic; excluded from reproducible output. |

---

## 4. Deterministic semantics

Given:
- Network `N` at step `K`
- Same `dt`
- Same external-input sequence for steps `K+1 .. K+T`
- Same modulator schedule

Then:

```
run(N, K→K+T)  ≡  run(deserialize(serialize(N)), K→K+T)
```

on the **same build/platform/compiler**. Cross-platform bitwise identity is **not claimed** because floating-point ordering and rounding can vary.

Within the same build, `serialize()` produces bit-identical strings for identical state, and repeated `deserialize` of the same string produces byte-identical fields (verified by test).

---

## 5. Atomic deserialization

`Network::deserialize(const std::string&)` is transactional:

1. Parse all tokens into temporary variables.
2. Validate every value (range checks, finiteness, reference checks, topology consistency).
3. Reconstruct adjacency lists (`outgoing_`, `incoming_`) from parsed synapse data.
4. Only after all validation passes: commit by moving temporaries into the Network.

Any exception between steps 1–3 leaves the original Network **byte-for-byte unchanged**.

Tested explicitly by:
```cpp
std::string before = net.serialize();
try { net.deserialize(corrupt); } catch (...) { /* expected */ }
CHECK(net.serialize() == before);
// And: continue stepping net and verify trajectory unchanged.
```

---

## 6. Timestep ordering (unchanged from STARK-005/006)

Serialization does **not** alter `Network::step()` ordering. The existing order is:

1. Decay STDP traces
2. Decay eligibility traces
3. Compute neuron inputs
4. Update neurons + post-traces
5. Deliver pre spikes
6. Accumulate eligibility
7. Apply STDP (STDP-mode only)
8. Apply three-factor (THREEFACTOR-mode only)
9. Homeostatic EMA + scaling
10. Process delayed deliveries
11. Advance timestep, clear external inputs, clear modulator

Checkpoints capture state **after** step N completes, before step N+1 begins.

---

## 7. Experiment harness

### Location

```
src/experiment/Experiment.h/.cpp
src/experiment/Recorder.h/.cpp
```

### Design principles

- The harness is a **thin driver**, not a second simulation engine.
- It holds **explicit replayable schedules**: `external_inputs[step][neuron]` and `modulatory_signal[step]`.
- It calls `Network::step(dt)` directly.
- It records via `Recorder` at each completed step boundary.

### Recorder modes

| Mode | Memory per step | Use case |
|------|-----------------|----------|
| `SPIKES_ONLY` | O(N) bits | Quick spike raster |
| `SELECTED_NEURONS` | O(K) structs | Focused neuron diagnostics |
| `SELECTED_SYNAPSES` | O(L) structs | Weight trace for key synapses |
| `FULL_STATE` | O(N+E) structs | Full trajectory for comparison |
| `PERIODIC_SNAPSHOT` | O((T/interval)·(N+E)) structs | Long runs with periodic fidelity |

Memory complexity is explicitly bounded. `FULL_STATE` stores everything but is only used for short experiments or direct state comparison.

### Canonical record fields

| Field | Required? | Source |
|-------|-----------|--------|
| `step_index` | Yes | `net.getCurrentTimeStep()` (integer, authoritative) |
| `dt` | Yes | Configuration |
| `spikes` | Yes | `net.getSpikesThisStep()` |
| `V` | Optional | `net.getNeuron(i).getV()` |
| `a` | Optional | `net.getNeuron(i).getA()` |
| `x_pre`, `x_post`, `w`, `e` | Optional | `net.getSynapse(k)` |
| `r_mean`, `homeostatic_scale` | Optional | `net.getFiringRates()`, `getHomeostaticScale()` |
| `modulatory_signal` | Optional | `net.getModulatorySignal()` (captured just after step) |

---

## 8. Precision & numerical reproducibility

- All doubles are written with `std::setprecision(std::numeric_limits<double>::max_digits10)` and `defaultfloat`.
- Reading back with `std::strtod` round-trips exactly on IEEE 754 compliant platforms.
- The same Network state always produces the same `serialize()` string (deterministic iteration order over vectors).

**Guarantee:** Bitwise identical state and trajectory on the **same build, same compiler, same architecture, same floating-point environment**.

**No claim of cross-platform bitwise identity** — this would require a standardized floating-point environment not guaranteed by the project's MinGW/GCC constraint.

---

## 9. API

### Network-level (existing, verified)

```cpp
std::string serialize() const;                          // full state -> canonical text
void deserialize(const std::string& data);              // transactional restore
void save(const std::string& path) const;               // serialize -> file
void load(const std::string& path);                     // file -> deserialize
```

### New accessor methods for observability

```cpp
size_t getPreNeuron(size_t synapse_id) const;
size_t getPostNeuron(size_t synapse_id) const;
size_t getDelay(size_t synapse_id) const;
```

### Experiment harness

```cpp
class Experiment {
    Experiment(Network& net, double dt, size_t steps,
             const std::vector<std::vector<double>>& external_inputs = {},
             const std::vector<double>& modulatory_signals = {},
             Recorder recorder = Recorder(RecordMode::SPIKES_ONLY));
    void run();
    void saveCheckpoint(const std::string& path) const;
    void loadCheckpoint(const std::string& path);
    const Recorder& getRecorder() const;
    const ExperimentMetadata& getMetadata() const;
};
```

### Recorder

```cpp
class Recorder {
    Recorder(RecordMode mode, std::vector<size_t> neuron_ids,
             std::vector<size_t> synapse_ids, size_t interval);
    void recordStep(const Network& net);
    const std::vector<SpikeRecord>& getSpikeRecords() const;
    const std::vector<NeuronRecord>& getNeuronRecords() const;
    const std::vector<SynapseRecord>& getSynapseRecords() const;
    const std::vector<FullSnapshot>& getFullSnapshots() const;
    size_t size() const;
};
```

---

## 10. Test plan summary

18 named tests plus full regression:

1. `test_empty_network` — round-trip empty Network
2. `test_single_neuron` — single neuron with dynamics
3. `test_synaptic_network` — excitatory synapse state
4. `test_delays_zero_and_positive` — delay=0 and delay=2 preserved
5. `test_stdp_traces` — x_pre, x_post, A_plus, A_minus, tau_pre, tau_post
6. `test_three_factor_state` — e, E_plus, E_minus, tau_e, eta_3f, mode
7. `test_homeostatic_state` — r_mean, scale, tau_r, kappa, target, hysteresis
8. `test_transient_state` — external inputs and modulator cleared on load
9. `test_checkpoint_resume_continuity` — **mandatory gate**: 100-step save + 100-step resume matches 200 continuous steps with mixed STDP/three-factor/homeostasis/delays
10. `test_deterministic_serialize_output` — repeated serialize() identical
11. `test_deterministic_resumed_execution` — round-trip → same future trajectory
12. `test_corrupted_truncated_input` — 9 malformed strings all rejected
13. `test_nan_inf_input` — NaN/Inf weight, modulator rejected
14. `test_invalid_topology` — out-of-range neuron ID rejected
15. `test_invalid_delay_queue` — wrong queue count, invalid synapse ID rejected
16. `test_unsupported_version` — versions 3, 0, -1 rejected
17. `test_failed_load_atomicity` — corrupted serialized string leaves Network unchanged
18. `test_reset_after_load` — reset preserves config, clears runtime state
+ Regression: compact re-verification of STARK-001..006 core invariants

---

## 11. What STARK-007 does NOT do

- Does NOT add binary format, compression, JSON, protobuf, HDF5.
- Does NOT add a GUI, visualization, or analytics backend.
- Does NOT add RNG, threading, GPU support, event-driven scheduling.
- Does NOT duplicate Network dynamics inside the harness.
- Does NOT persist `dt`; caller resumes with the same dt.
- Does NOT support arbitrary mid-step checkpoints.
- Does NOT invent backward-compatible defaults for missing v2-required fields (unsupported versions rejected outright).
- Does NOT modify frozen STARK-001..006 mathematics or `Network::step()` ordering.

---

*Specification complete. Matches the actual C++ implementation in src/neural/Network.cpp (lines 616–939), src/experiment/, and tests/test_serialization.cpp.*
