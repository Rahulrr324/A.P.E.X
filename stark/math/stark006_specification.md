# STARK-006 Mathematical Specification: Three-factor Modulator-Gated Plasticity

> STATUS: IMPLEMENTED AND VERIFIED. This specification matches the actual C++ implementation.
> All STARK-001..005 phases are frozen. STARK-006 extends the verified baseline with
> three-factor modulator-gated learning via an eligibility trace. See the implementation in
> src/neural/Synapse.h/.cpp and src/neural/Network.h/.cpp, tested by tests/test_three_factor.cpp
> and demonstrated by tests/examples/three_factor_demo.cpp.

## 0. Model class

**Three-factor, eligibility-trace, modulator-gated plasticity (R-STDP-style).**

STARK-004 implements instantaneous pair-based trace STDP (two factors: pre, post; immediate
`w` update). STARK-006 **defers** that credit into a signed eligibility trace `e_ij` and only
applies it to the weight when a third, broadcast modulatory signal `m(t)` is present:

```
weight change  =  eta_3f * m(t) * e_ij
```

The eligibility is built from the SAME `x_pre`/`x_post` traces STARK-004 already maintains, so
the temporal (causal) asymmetry of STDP is preserved.

---

## 1. State variables

### Per-synapse state (owned by `Synapse`)

| Variable     | Description                                          | Units       | Initial |
|--------------|------------------------------------------------------|-------------|---------|
| `w`          | Synaptic weight (STARK-002, unchanged)               | dimensionless | `w_init` |
| `x`          | Synaptic current state (STARK-002, Euler)            | dimensionless | 0.0 |
| `x_pre`      | Pre-synaptic spike trace (STARK-004)                 | dimensionless | 0.0 |
| `x_post`     | Post-synaptic spike trace (STARK-004)                | dimensionless | 0.0 |
| `e`          | **New** eligibility trace                            | dimensionless | 0.0 |

Mode flag `mode ∈ {NONE, STDP, THREEFACTOR}` (the `THREEFACTOR` mode is new; `NONE`/`STDP` are the
frozen STARK-002/004 states). `mode` is per-synapse and mutually exclusive.

### Per-neuron state — **unchanged** (`NeuralCell`, `Network`)

- `NeuralCell`: `V`, `a`, `theta` (STARK-001) — untouched.
- `Network`: `r_mean`, `homeostatic_scale` (STARK-005) — untouched.
- New `Network` transient: the current modulatory broadcast `m(t)` (scalar, per timestep).

---

## 2. Parameters

### Three-factor parameters (new, owned by `Synapse`)

| Parameter  | Description                         | Units       | Constraint            |
|------------|-------------------------------------|-------------|-----------------------|
| `E_plus`   | Eligibility potentiation amplitude  | dimensionless | `E_plus >= 0`, finite |
| `E_minus`  | Eligibility depression amplitude    | dimensionless | `E_minus >= 0`, finite |
| `tau_e`    | Eligibility time constant           | seconds     | `tau_e > 0`, finite   |
| `eta_3f`   | Three-factor learning rate (gate)   | dimensionless | `eta_3f > 0`, finite |

### Modulatory signal (owned by `Network`)

| Parameter | Description                            | Units       | Constraint                |
|-----------|----------------------------------------|-------------|---------------------------|
| `m(t)`    | Broadcast modulator for timestep t     | dimensionless | finite; user-validated |

### Reused frozen parameters

- STDP trace params: `tau_pre`, `tau_post` (seconds, `> 0`) — already in `Synapse`.
- Weight bounds: `w_min`, `w_max` — STARK-005 sign-derived defaults or explicit.

### Units summary (all consistent with the frozen codebase)

| Quantity | Units |
|----------|-------|
| `dt`     | seconds |
| `tau_e`, `tau_pre`, `tau_post` | seconds |
| `w`, `e`, `x_pre`, `x_post` | dimensionless |
| `E_plus`, `E_minus`, `eta_3f`, `m(t)` | dimensionless |
| `w_min`, `w_max` | dimensionless |

Idea: every exponential argument (`dt/tau_e`, `dt/tau_pre`, `dt/tau_post`) is dimensionless;
every multiplicative composition yields `w`-units (dimensionless).

---

## 3. Update rules

### 3.1 Eligibility decay (exact exponential)

```
e <- e * exp(-dt / tau_e)
```

Stable for any `dt > 0` (exact exponential, identical discipline to the STARK-004 traces).
Eligibility decays toward 0 when no further credit is added.

### 3.2 Eligibility credit accumulation (reuses STDP traces)

Using the post-increment trace values for the current timestep (same values STARK-004 STDP uses):

```
if post spiked:  e <- e +  E_plus  * x_pre
if pre  spiked:  e <- e + (-E_minus) * x_post     // i.e. e -= E_minus * x_post
```

This gives eligibility the same causal directionality as STDP:
- `pre -> post` (pre fired, then post)  ->  positive credit -> later potentiation (if `m>0`)
- `post -> pre` (post fired, then pre)  ->  negative credit -> later depression (if `m>0`)

### 3.3 Modulator-gated weight update (the learning rule)

```
dw = eta_3f * m(t) * e
w  <- clamp(w + dw, w_min, w_max)
```

Only on `THREEFACTOR`-mode synapses. On STDP-mode synapses the immediate STDP update is used and
this section does not apply; on `NONE` neither does.

### 3.4 Same-timestep pre/post policy

If pre and post both spike in the same timestep, both credit contributions are applied, in the
fixed order used by STARK-004 STDP (post-processing first, then pre-processing):

```
e <- e  +  E_plus  * x_pre     (post spike, uses updated x_pre)
e <- e  -  E_minus * x_post    (pre  spike, uses updated x_post)
```

`x_pre`/`x_post` are the trace values **after** both increments for this timestep (post trace
incremented during neuron update step 4, pre trace incremented during delivery step 5), exactly
mirroring STARK-004's section 3.4. Net credit:

```
Delta_e_same_step = E_plus * x_pre - E_minus * x_post
```

This is deterministic and matches the STARK-004 same-timestep convention.

### 3.5 Interaction on the SAME weight (no double application)

Because the plasticity `mode` is mutually exclusive per synapse:

- `STDP`-mode synapse: weight edited once (step 7), by `Delta_w_STDP`.
- `THREEFACTOR`-mode synapse: weight edited once (step 8), by `eta_3f * m(t) * e`.
- `NONE`-mode synapse: no learning edit.

No single weight is ever additively updated twice in one timestep. Homeostasis (multiplicative)
optionally follows and applies to all modes.

---

## 4. Timestep ordering

Extended proposal built on the **frozen** STARK-005 `Network::step()` order
(STARK-001..005 order is NOT changed; items marked `[new]` are added and the relative placement
of the three learning weight updates is the only new decision):

1. **Decay STDP traces** — `decayTraces(dt)` on every synapse (`[frozen]`).
2. **Decay eligibility** — `e *= exp(-dt/tau_e)` on THREEFACTOR synapses `[new]`.
3. **Compute neuron inputs** — external + synaptic `w*x` from previous step `[frozen]`.
4. **Update neurons** — collect spikes; `updatePostTrace()` on incoming (`x_post += 1`) `[frozen]`.
5. **Deliver pre spikes** — `receiveSpike(true,dt)` (`x_pre += 1`, `x` update); non-spikers decay `[frozen]`.
6. **Accumulate eligibility credit** — post/pre spike contributions into `e` `[new]`.
7. **Apply STDP** — `applyLTP`/`applyLTD` on **STDP-mode** synapses only `[frozen, mode-restricted]`.
8. **Apply three-factor** — `w += eta_3f * m(t) * e`, clamp, on **THREEFACTOR-mode** synapses only `[new]`.
9. **Homeostatic EMA + multiplicative scaling** — all synapses `[frozen]`.
10. **Process delayed deliveries** — scheduled spikes for `timestep_+1` `[frozen]`.
11. **Advance timestep, clear external inputs, clear modulator `m`** `[frozen + clear m]`.

**Key consequences:**
- STDP and three-factor edits are disjoint (per-synapse mode), so there is never accidental
  double application (Section 3.5).
- Homeostasis always runs last multiplicatively, so the total per-step effect on a THREEFACTOR
  synapse is `w_final = clamp(clamp(w + eta_3f*m*e, w_min, w_max) * scale_j, w_min, w_max)`.
- The modulator `m(t)` used in step 8 is the value supplied for the current timestep and is
  cleared after step 11 (it is transient, not persistent learned state).

---

## 5. Units and dimensional consistency

All new quantities are dimensionless in the sense of the codebase's weights (the codebase treats
`w`, traces, and learning rates as dimensionless magnitudes; physical units exist only for time
and firing rate).

| Term | Dimension check |
|------|-----------------|
| `e *= exp(-dt/tau_e)` | `dt/tau_e` = s/s = dimensionless; `e` stays the same units as itself ✓ |
| `e += E_plus * x_pre` | dimensionless * dimensionless = e-units ✓ |
| `dw = eta_3f * m * e` | dimensionless * dimensionless * dimensionless = w-units ✓ |
| weight clamp | `w_min <= w <= w_max`, same units ✓ |

`m(t)` is a dimensionless signed scalar; a **positive** value is "reward-like" (apply credit in
its natural sign), a **negative** value is "punishment-like" (invert credit). No claim of physical
modulator units is made — `m` is an abstract gate.

---

## 6. Bounds, stability, and numerical requirements

- **Weight bounds:** reuse STARK-005. Additive `w += dw` with clamping to sign-appropriate bounds
  (`[0, max]` excitatory, `[-max, 0]` inhibitory, `[-max, +max]` for `w=0`) guarantees an
  excitatory weight cannot become negative, an inhibitory weight cannot become positive, and a
  zero weight never leaves zero (it is a fixed point of the additive rule when `w=0`).
- **Eligibility bound:** `e` is a leaky integrator of bounded, finite contributions, so it is
  finite and bounded for finite validated parameters. Formally, sustained maximum-rate input
  yields `e_steady <= (E_plus * x_pre_max) / (1 - exp(-dt/tau_e))`, finite for finite parameters.
- **Modulator:** must be finite and bounded by the caller. Because `dw = eta_3f*m*e`, an
  unbounded `m` can overflow `dw`; the implementation must validate `m` is finite (`NaN`/`±inf`
  rejected) and guard `eta_3f*m*e` for finiteness before applying, rejecting or clamping to
  protect state. This mirrors the STARK-005 `scaleWeight`/homeostatic `exp()` guards.
- **Eligibility decay:** exact exponential -> stable for any `dt > 0`; no upper bound on `dt`
  from `tau_e`. The network's global `dt` constraint remains the frozen `dt < min(tau_m, tau_a)`
  and `dt < tau_s` requirements.

---

## 7. Behavior for specific situations

| Situation | Behavior |
|-----------|----------|
| `m(t) = 0` always | `dw = 0` regardless of eligibility; weight unchanged (primary signature) |
| `m(t) > 0`, `e > 0` | potentiation `dw > 0` |
| `m(t) > 0`, `e < 0` | depression `dw < 0` |
| `m(t) < 0`, `e > 0` | depression `dw < 0` (credit inverted) |
| `m(t) < 0`, `e < 0` | potentiation `dw > 0` |
| no spike pairing | `e` decays toward 0; `dw -> 0` even if `m(t) != 0` |
| repeated pairing | `e` accumulates; larger `|e|` -> larger `|dw|` per modulator |
| eligibility decay | `tau_e` sets the credit window; longer `tau_e` = longer memory of pairings |
| saturated weight | `w` clamps at `w_min`/`w_max`; `e` keeps updating, so continued credit stays "pending" until polarity/`m` allows un-clamping |
| inhibitory synapse | sign preserved by clamping; `E_plus/E_minus` and `m` shape magnitude only |
| extreme/invalid `m` | `NaN`/`±inf` rejected; large finite `m` guarded against `dw` overflow |

---

## 8. Interaction summary (STDP + three-factor + homeostasis)

All can run concurrently on the SAME network:
- Different synapses in different `mode`s.
- Homestasis scales every synapse multiplicatively after learning edits.
- STDP edits only STDP-mode; three-factor edits only THREEFACTOR-mode; no single weight is
  additively updated twice.
- Neither STDP nor three-factor modifies the other's traces; three-factor only *reads* the shared
  `x_pre`/`x_post` (written by STDP trace machinery) and writes its own `e` and (gated) `w`.
  No trace corruption.

Ordering of the three weight-affecting operations within a step: **STDP / three-factor (additive)
then homeostasis (multiplicative)**, matching STARK-005's existing STDP->homeostasis composition.

---

## 9. API surface (IMPLEMENTED)

### `Synapse`
- `void enableThreeFactor(double E_plus, double E_minus, double tau_e, double eta_3f,
   double w_min, double w_max);`
  Sets `mode = THREEFACTOR`, configures params, sets bounds. (Enabling three-factor on a synapse
  puts it exclusively in THREEFACTOR mode.)
- `void decayEligibility(double dt);` — `e *= exp(-dt/tau_e)`.
- `void accumulateEligibility(bool pre_spiked, bool post_spiked);` — section 3.2.
- `void applyThreeFactor(double m);` — `dw = eta_3f*m*e`, `w += dw`, clamp. (Placed near
  `applyLTP`/`applyLTD`; STDP-mode synapse skips it. Note: no `dt` parameter — the learning
  rate `eta_3f` absorbs the timestep, consistent with all STARK phases.)
- `double getEligibility() const;`
- `PlasticityMode getPlasticityMode() const;`
- `bool getThreeFactorEnabled() const;`
- `double getTauE()`, `getEta3f()`, `getEPlus()`, `getEMinus()` getters for diagnostics/serialization.
- Extend `reset()` to zero `e`.
- Extended `setFullState(...)` overload (18 params) for transactional state restore with
three-factor fields.

### `Network`
- `void setModulatorySignal(double m);` — set `m` for the current timestep (validated finite).
- `void clearModulatorySignal();` — cleared each step; part of `reset()`.
- `double getModulatorySignal() const;`
- `void enableThreeFactor(size_t synapse_id, double E_plus, double E_minus, double tau_e,
   double eta_3f, double w_min, double w_max);` — delegates to `Synapse`.
- `double getEligibility(size_t synapse_id) const;`
- `PlasticityMode getPlasticityMode(size_t synapse_id) const;`
- `void step(dt)` — integrates the ordering in Section 4 (steps 2, 6, 8, 11 added).
- `reset()` — additionally zeros all `e` and clears `m`; homeostatic configuration preserved.
- Serialization: version 2 format includes three-factor state and modulator; version 1
deserialized with defaults (three-factor disabled).

No change to `NeuralCell`.

---

## 10. Numerical worked example

Setup: ONE synapse `A -> B` in `THREEFACTOR` mode.
- `E_plus = E_minus = 0.01`, `tau_e = 50`, `eta_3f = 0.5`, `dt = 1` s
- `tau_pre = tau_post = 20`
- `w_init = 0.5`, `w_min = 0`, `w_max = 1`
- decay factors: `d_pre = exp(-1/20) = 0.951229`, `d_e = exp(-1/50) = 0.980199`

All quantities below are dimensionless (weight/time as tabulated).

### Step-by-step (m = 0 through t=3, m = 1 at t=4)

| t | event | x_pre (after) | x_post (after) | e (after) | m | dw = eta_3f*m*e | w |
|---|-------|---------------|----------------|-----------|-----|------------------|-----|
| 0 | init  | 0.000000 | 0.000000 | 0.000000 | -  | - | 0.500000 |
| 1 | pre   | 1.000000 | 0.000000 | 0.000000 | 0 | 0 | 0.500000 |
| 2 | post  | 0.951229 | 1.000000 | 0.009512 | 0 | 0 | 0.500000 |
| 3 | none  | 0.904837 | 0.951229 | 0.009324 | 0 | 0 | 0.500000 |
| 4 | none  | 0.860708 | 0.904837 | **0.009140** | 1 | +0.004570 | **0.504570** |

Details:
- **t=1 (pre spike):** `x_pre` becomes 1.0. No post spike, no pre spike (pre trace was incremented,
  but eligibility decrement uses `x_post = 0`) -> `e = 0`. `m=0`, so `dw = 0`.
- **t=2 (post spike):** `x_pre` decays to `0.951229` (step 1). Post spike -> `e += E_plus*x_pre =
  0.01*0.951229 = 0.009512`. `x_post` becomes 1.0. `m=0` -> no weight change.
- **t=3 (no spike):** `e` decays: `0.009512*0.980199 = 0.0093236`. `m=0` -> `dw=0`.
- **t=4 (m=1, modulator arrives):** `e` decays: `0.0093236*0.980199 = 0.0091395`.
  `dw = 0.5 * 1 * 0.0091395 = 0.0045698`. `w = 0.5 + 0.0045698 = 0.5045698`.

**Result:** the `pre -> post` pairing at t=1..2 left a positive eligibility trace that, when a
modulator `m=+1` arrived at t=4, potentiated `w` from `0.500000` to `0.504570`. Had `m` remained
`0`, `w` would still be `0.500000` (the primary signature). Had the pairing been `post -> pre`,
`e` would be negative and `m=+1` would depress `w`.

---

## 11. Technical debt / risks (resolved in implementation)

- **STARK-003 delay=1 off-by-one** (pre-existing, frozen). A `delay=1` scheduled delivery is
  processed in the same step, so it behaves like `delay=0`. Recorded but NOT fixed here.
- **`test_params`** is a diagnostic executable without assertions (pre-existing, frozen). Not part
  of the assertion counts.
- **Eligibility magnitude:** defensively guarded — `applyThreeFactor` checks `!std::isfinite(dw)`
  before applying.
- **Modulator validation:** `setModulatorySignal` rejects NaN/Inf. Large finite values are accepted
  but the `dw` guard protects against overflow.
- **Mode enforcement:** verified by `test_mode_exclusivity` — `applyLTP`/`applyLTD` suppress
  themselves in `THREEFACTOR` mode, and `applyThreeFactor` skips non-THREEFACTOR synapses.

---

## 12. Proposed test matrix (Network-level, STARK-006)

Every row exercises `Network::step()` and real spikes / real modulator broadcast — not helper math
in isolation — except where a unit test is the only sensible place (Synapse-level invariants).

1. **m=0 signature:** pair A->B repeatedly (A then B), keep `m=0`; assert `w` unchanged. (No learning without modulator.)
2. **m>0 gating:** same pairing, `m=+1` at/before B spikes; assert `w` increases > tolerance.
3. **Causal direction:** (a) pre->post pairing + `m>0` -> `w` up; (b) post->pre pairing + `m>0` -> `w` down.
4. **m<0 inversion:** pre->post pairing, `m=-1` -> `w` down (credit applied inverted).
5. **Eligibility decay:** single pre->post pair, then delay modulator many `tau_e`; assert `w`
   change fades toward 0 (decay).
6. **No pairing, m>0:** modulator present, no coincidence -> no change (`e=0`).
7. **Repeated pairing accumulation:** more pairings -> larger eligibility -> larger `|dw|`.
8. **Weight bounds:** repeated potentiation + saturation -> `w` never exceeds `w_max`; depression
   never below `w_min`.
9. **Inhibitory preservation:** synapse `w<0`; m>0 and negative credit cannot make it positive.
10. **Zero-weight invariance:** `w=0` stays exactly 0 under any `m`, `e`.
11. **Same-timestep policy:** pre AND post in one step -> `Delta_e = E_plus*x_pre - E_minus*x_post`;
    then m applied. Assert exact net.
12. **Mode exclusivity:** a THREEFACTOR synapse does NOT also apply the immediate STDP update; a
    STDP synapse does NOT run the gated update (no double application).
13. **STDP + three-factor + homeostasis coherence:** network with some STDP-mode and some
    THREEFACTOR-mode synapses, homeostasis enabled; assert final `w` equals the documented
    composition `clamp((w + dw_learn) * scale)` within tolerance; assert homeostasis still rescales
    all incoming (STDP-005 invariants still hold).
14. **Determinism:** identical network + inputs + `m(t)` sequence + dt -> identical final weights,
    eligibility, rates.
15. **reset():** resets `e` to 0, clears `m`; homeostatic config preserved; neurons/synapses reset.
16. **Parameter validation:** reject `tau_e <= 0`, `E_plus/E_minus < 0`, `eta_3f <= 0`, non-finite
    params; reject `NaN`/`±inf` modulator.
17. **Numerical edge cases:** very small/large valid `dt`; `tau_e` small/large; huge `m` (guarded);
    zero weight; weights at bound; eligibility underflow.
18. **addNeuron isolation:** adding neurons/THREEFACTOR synapes after others configured does not
    disturb existing eligibility/rates.

Regression: all STARK-001..005 executables must still pass unchanged (THREEFACTOR off by default;
STDP-mode synapses byte-for-byte unchanged).

---

## 13. Verdict summary

- Selected mechanism: **three-factor, eligibility-trace, modulator-gated plasticity (R-STDP)**.
- Exact rule: `e` (leaky, from signed STDP credit) and `dw = eta_3f*m(t)*e`, `w <- clamp(w+dw)`.
- Exact ordering: reconciled in Section 4 against the frozen STARK-005 order.
- Ownership: `Synapse` = `e`,`tau_e`,`E_plus`,`E_minus`,`eta_3f`,`mode`; `Network` = `m(t)`;
  `NeuralCell` = unchanged.
- Same-timestep policy: both credit terms, deterministic order.
- No double application: mutual-exclusive per-synapse mode.
- Units/dimensions: all consistent with frozen codebase (dimensionless weights/traces/rates;
  seconds for time constants).
- Implementation status: VERIFIED — all tests pass, demo produces correct signatures.
- Regression: all STARK-001..005 tests pass unchanged.