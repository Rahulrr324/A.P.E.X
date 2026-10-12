# STARK-007 Design Decision: State Serialization & Reproducible Experiment Harness

> STATUS: DECIDED. This document reconciles the approved design spec with the actual implementation.
> STARK-001..006 remain frozen. The serialization infrastructure existed as part of STARK-006
> (attributed there by convention); STARK-007 layers the experiment harness and comprehensive
> test matrix on top of that foundation.

---

## Decision

**STARK-007 = Deterministic state serialization + thin experiment harness + trajectory recording.**

The implementation preserves the existing `STARK006 2` text-token format, adds a thin `Experiment` harness and `Recorder` component, and introduces a comprehensive 18-test matrix proving round-trip correctness, atomic failure handling, and cross-platform numerical reproducibility guarantees.

---

## Why this scope

1. **Observability gap.** Before STARK-007, there was no way to save a network state and resume later, nor was there a structured way to record trajectories for offline analysis. Experiments were ephemeral.

2. **Reproducibility requirement.** Scientific results must be reproducible. Without checkpoint/resume, debugging a failed long run means restarting from scratch.

3. **Test-gating.** The mandatory checkpoint/resume continuity test (`test_checkpoint_resume_continuity`) ensures the serialization actually preserves enough state to continue identical future dynamics — not just that fields happen to parse correctly.

4. **Thin harness.** The experiment runner must not duplicate simulation logic. It simply drives `Network::step()` with explicit schedules and records the result. This keeps the testing surface small and the harness maintainable.

---

## Architecture

```
STARK-001 NeuralCell      (frozen)
STARK-002 Synapse         (frozen)
STARK-003 Network         (frozen)
STARK-004 STDP            (frozen)
STARK-005 Homeostasis     (frozen)
STARK-006 Three-factor    (frozen)
          ↓
STARK-007 Layer:
   Network::serialize()/deserialize()/save()/load()   [existing, verified]
   Network::getPreNeuron(), getPostNeuron(), getDelay() [new accessors]
   src/experiment/Recorder.h/.cpp
   src/experiment/Experiment.h/.cpp
   tests/test_serialization.cpp                       (18 tests)
   tests/examples/serialization_demo.cpp
   math/serialization_specification.md
   research/serialization_comparison.md
   design/serialization_decision.md
   design/technical_debt.md  (updated)
```

Serialization lives **above** the model. No neural class is polluted with format logic.

---

## Checkpoint contract

- Checkpoints are taken at completed `step(dt)` boundaries only.
- `dt` is NOT serialized — caller resumes with the same dt.
- The transient modulatory signal `m(t)` IS captured at the moment of serialization (before clear), so a resumed network knows the last modulator value even though it will be overwritten by the next call to `setModulatorySignal()`.
- `theta_i` is reconstructed as `theta_0_i + a_i` on load, preserving the model invariant.

---

## Format decision

**Retained: text-token with magic `STARK006`, schema version `2`.**

Reasons (see `research/serialization_comparison.md`):
- Zero new dependencies (MinGW/GCC constraint).
- Human-readable checkpoint files for debugging.
- `max_digits10` gives exact double round-trip on same build.
- Simple version rejection policy for unknown future versions.
- No need to rename to `STARK007` — format identity ≠ project phase.

---

## Atomic load guarantee

`deserialize()` builds all state into temporaries first. Only after every token is parsed and validated does it move into the Network. A thrown `std::invalid_argument` at any point leaves the Network byte-for-byte unchanged.

This is critical because the repository already documents mutation-before-validation technical debt in `NeuralCell::setParameters()` and `Synapse::setPlasticityParameters()`. The serialization path is the **one place where atomic restoration is actually enforced** — the test `test_failed_load_atomicity` verifies it.

---

## Determinism guarantee

Same build, same platform, same dt, same input sequence → bitwise-identical trajectory after checkpoint/resume.

No claim of cross-compiler or cross-OS bitwise identity. Floating-point associativity differences can cause tiny divergence between, e.g., GCC 6.3.0 (MinGW) and Clang 14 on Linux. Within the CI build, identity is strict.

---

## What STARK-007 explicitly excludes

- Binary checkpoints
- Compression
- JSON / protobuf / HDF5
- GUI or visualization
- Event-driven scheduler
- GPU / distributed execution
- Structural plasticity
- Reward / reinforcement learning
- RNG frameworks
- Threading

---

## API surface added

```cpp
// Network (observability)
size_t getPreNeuron(size_t synapse_id) const;
size_t getPostNeuron(size_t synapse_id) const;
size_t getDelay(size_t synapse_id) const;

// Experiment harness
class Experiment { ... };      // thin driver
class Recorder { ... };        // trajectory capture

// Tests
tests/test_serialization.cpp  // 18 named tests
tests/examples/serialization_demo.cpp
```

---

## Implementation notes

- No new files were added to `src/neural/`. Only `src/experiment/` and `tests/`.
- No changes to `Network::step()` ordering.
- The `deliverSpikes()` and `processDelayedDeliveries()` dead declarations in `Network.h` remain (STARK-003 technical debt, not in scope for STARK-007).
- CMakeLists.txt was extended with two new targets: `test_serialization` and `serialization_demo`.

---

*Design decision documented. Implementation matches specification.*
