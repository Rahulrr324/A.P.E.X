# STARK Technical Debt Log

This document tracks known technical debt items for future maintenance.

---

## STARK-003: validateDt() Made Public (API Addition)

**Severity**: Low (additive, non-breaking)  
**Reported**: STARK-003 Implementation  
**Status**: Accepted (required for Network-level validation)

### Description

To enable `Network::validateDt()` to check timestep validity against all neurons and synapses before simulation, the `validateDt()` method was moved from `private` to `public` in both `NeuralCell` and `Synapse`.

**Change**: 
- `NeuralCell::validateDt(double dt)` — moved from private to public
- `Synapse::validateDt(double dt)` — moved from private to public

**Justification**: The Network must validate its timestep against all components before executing a step. Without public access to `validateDt()`, the Network would need to duplicate the validation logic or rely on exceptions from the first update call.

**Impact**: None on existing behavior. This is a purely additive API change. All existing tests pass unchanged.

---

## STARK-001: NeuralCell::setParameters() Atomicity Issue

**Severity**: Medium  
**Reported**: STARK-002 Patch Review  
**Status**: Open (STARK-001 frozen, to be fixed in future maintenance patch)

### Description

`NeuralCell::setParameters()` currently mutates member variables **before** validation:

```cpp
void NeuralCell::setParameters(double tau_m, double theta_0, double tau_a, double b, double v_reset) {
    // Mutate FIRST
    tau_m_ = tau_m;
    theta_0_ = theta_0;
    tau_a_ = tau_a;
    b_ = b;
    v_reset_ = v_reset;
    
    // Validate SECOND
    validateParameters();  // May throw
    
    // Reset state
    V_ = v_reset;
    theta_ = theta_0;
    a_ = 0.0;
    spiked_ = false;
}
```

**Problem**: If `validateParameters()` throws, the object is left in a partially modified state with some parameters updated and others not. The state reset at the end also doesn't execute.

### Required Fix

Validate all proposed parameters **first**, then commit them atomically:

```cpp
void NeuralCell::setParameters(double tau_m, double theta_0, double tau_a, double b, double v_reset) {
    // 1. Validate all proposed parameters FIRST
    if (tau_m <= 0.0) throw std::invalid_argument("tau_m must be > 0");
    if (theta_0 < 0.0) throw std::invalid_argument("theta_0 must be >= 0");
    if (tau_a <= 0.0) throw std::invalid_argument("tau_a must be > 0");
    if (b < 0.0) throw std::invalid_argument("b must be >= 0");
    if (!std::isfinite(tau_m) || !std::isfinite(theta_0) || 
        !std::isfinite(tau_a) || !std::isfinite(b) || !std::isfinite(v_reset)) {
        throw std::invalid_argument("all parameters must be finite");
    }
    
    // 2. Commit atomically (no throws after this point)
    tau_m_ = tau_m;
    theta_0_ = theta_0;
    tau_a_ = tau_a;
    b_ = b;
    v_reset_ = v_reset;
    
    // 3. Reset state
    V_ = v_reset;
    theta_ = theta_0;
    a_ = 0.0;
    spiked_ = false;
}
```

### Impact

- Low probability in practice (parameters typically set once at construction)
- Could cause inconsistent state if called with invalid parameters after valid ones
- Does not affect current test suite (no tests call `setParameters` with invalid values after valid ones)

### Target Fix

Future maintenance patch after STARK-003 or when `setParameters` is needed for plasticity/learning.

---

## STARK-002: None Currently

STARK-002 implementation is clean. No technical debt identified at this time.

---

## STARK-003: Network Implementation Notes

**Status**: Complete, pending review

### Known Limitations

1. **Fixed-timestep only**: No event-driven scheduler yet. For sparse activity, this is wasteful.
2. **Delay queue per neuron**: Current implementation uses `delayed_spikes_[target_neuron]` vector. For large networks with many delays, a single priority queue would be more efficient.
3. **No serialization**: Network state cannot be saved/loaded yet.
4. **Single-threaded**: No parallelization. For GPU, need to restructure update order.
5. **connectRandomSparse uses fixed seed**: Deterministic but not configurable. May want seeded RNG parameter.

### Future Improvements

- Event-driven scheduler for sparse spiking efficiency
- Network serialization (save/load)
- Configurable RNG seed for connectivity builders
- Parallel neuron updates (GPU-ready)
- Synapse removal/structural plasticity support

---

## STARK-003: Delayed-Delivery Off-by-One (transmission delay = 1)

**Severity**: Low (behavioral quirk in a frozen, passing phase)
**Reported**: STARK-006 design review (no source change made)
**Status**: Open (STARK-003 frozen; recorded as technical debt only)

### Description

In `Network::step()`, a synapse scheduled with `delay = D` records a delivery at `timestep_ + D`
(Step 4). In Step 7 the network processes deliveries scheduled for `new_timestep = timestep_ + 1`.
For `D = 1` the delivery time equals `new_timestep`, so a `delay = 1` spike is delivered in the
SAME step in which it was scheduled — i.e. it behaves like `delay = 0`. Effective delays are
therefore `D_effective = max(0, D - 1)`.

### Impact

- Pre-existing, frozen STARK-003 behavior; all STARK-001..005 tests pass.
- Network-level STARK-006 tests that schedule delayed three-factor/STDP events must account for
  this when asserting delivery timing. Document the actual effective delay rather than relying on
  the nominal `D`.

### Required Fix (future, not this phase)

Decide the intended timing convention (deliver at `timestep_ + D` vs `timestep_ + D - 1`) and, if
changed, update `Network::step()` and any delay-dependent tests together. Do NOT change until a
frozen-phase regression is coordinated.

---

## STARK-001/004: test_params Is a Diagnostic (No Assertions)

**Severity**: Low (reporting/coverage caveat)
**Reported**: STARK-006 design review
**Status**: Open (frozen STARK-001; not a test harness)

`src/test_params.cpp` prints per-parameter diagnostics and always exits 0 with no assertion
mechanism. Scope it as a demonstration, not an assertion-based test; it contributes no assertion
count. Do not "fix" in this phase (frozen STARK-001).

---

## STARK-005/006-adjacent: Homeostatic `setHomeostasisParameters()` Re-initializes State

**Severity**: Low (API behavior worth documenting for STARK-006)
**Reported**: STARK-006 design review
**Status**: By design (frozen STARK-005)

`Network::setHomeostasisParameters()` resizes and zeroes `r_mean_`/`homeostatic_scale_` after
validation. This is correct (atomic, post-validation commit) but means reconfiguring homeostatis
after neurons exist resets rate histories. STARK-006 should preserve the same atomic-commit
pattern and document any analogous behavior for eligibility state.

---

## STARK-002/004: Synapse::setPlasticityParameters() Mutation-Before-Validation

**Severity**: Medium (latent robustness defect on invalid input)
**Reported**: STARK-005 freeze review (no source change made)
**Status**: Open (frozen STARK-004; documented only)

### Description

`Synapse::setPlasticityParameters()` (`Synapse.cpp`, ~L199-211) mutates all plasticity members
(`A_plus_`, `A_minus_`, `tau_pre_`, `tau_post_`, `w_min_`, `w_max_`) and sets
`plasticity_enabled_ = true` **before** calling `validatePlasticityParameters()`. If validation
throws (e.g. `A_plus < 0`, `tau_pre <= 0`, `w_min > w_max`, or any non-finite), the synapse is left
with partially-mutated, possibly-invalid plasticity parameters and `plasticity_enabled_ == true`.
A subsequent `applyLTP()`/`applyLTD()` would then use the invalid `A_plus_`/`A_minus_`.

This is the same class of defect as the already-logged `NeuralCell::setParameters()` entry, but it is
reachable through the **public** `Network::enablePlasticity(synapse_id, ...)` API
(`Network.cpp`, ~L488-494), so a caller can corrupt a synapse with an invalid call before the
exception propagates.

### Required Fix (future, not this phase)

Validate all arguments first, then commit atomically and set `plasticity_enabled_` only after all
validation succeeds. Add a test that calls `enablePlasticity`/`setPlasticityParameters` with an
invalid value after a valid one and asserts the synapse state is unchanged.

### Impact

- Low probability in practice (parameters set once at construction).
- Not triggered by the current test suite (no test passes invalid values after valid ones).
- Frozen STARK-004; do not patch in a STARK-005 review. Coordinate a maintenance patch if needed.

---

## STARK-003: Dead Private Helper Declarations in Network.h

**Severity**: Low (dead code / cleanliness)
**Reported**: STARK-005 freeze review (no source change made)
**Status**: Open (frozen STARK-003; documented only)

### Description

`Network.h` (L320-321) declares two private helpers:

```cpp
void deliverSpikes(double dt);
void processDelayedDeliveries();
```

Neither is defined in `Network.cpp` nor called anywhere. The spike-delivery and delayed-delivery
logic was inlined into `Network::step()`, and these declarations were left behind. They compile
(never odr-used) but are misleading dead declarations.

### Required Fix (future, not this phase)

Remove the two unused private member declarations from `Network.h`. No behavioral change.

---

*End of Technical Debt Log*

---

## STARK-007: Serialization Infrastructure

**Severity**: Low (completed)
**Reported**: STARK-007 Implementation
**Status**: Resolved

`Network::serialize()` / `deserialize()` / `save()` / `load()` are implemented with transactional semantics, `STARK006 2` format, and full 18-test coverage including checkpoint/resume continuity.

New accessor methods `getPreNeuron()`, `getPostNeuron()`, `getDelay()` were added to `Network` for observability (low severity — purely additive).

The `src/experiment/` harness (Recorder + Experiment) is thin: it calls `Network::step(dt)` and records, without duplicating simulation logic.