# STARK-006 Design Decision: Three-factor Modulator-Gated Plasticity

> STATUS: DECIDED — reconciles and supersedes the earlier DRAFT.
> STARK-005 is FROZEN and verified; earlier draft claims that STARK-005's bound handling is
> "broken" are now obsolete and are corrected here.
> No source files are modified by this document.

## Decision

**STARK-006 = Three-factor, modulator-gated synaptic plasticity built on an eligibility trace
that accumulates signed STDP credit.**

STARK-004 learns *which* synapses are correlated and *in which temporal order* (two-factor,
immediate). STARK-005 keeps overall activity stable (slow, multiplicative). STARK-006 adds a
**third factor** — a broadcast modulatory signal `m(t)` — that decides *whether* recently
eligible synapses are actually allowed to change, and in which direction.

This separates:
- **detection of contingency** (pre/post pairing) -> eligibility trace `e_ij`
- **decision to learn** (modulator present) -> weight change `dw = eta_3f * m(t) * e_ij`

## Why this mechanism

1. **Scientific progression.** The stack so far is unsupervised. The three-factor rule is the
   canonical, minimal bridge from correlation learning to outcome/value-guided learning. It is
   the gateway for every later modulatory signal (reward, curiosity, satisfaction, frustration,
   concern) and for eventual memory that depends on outcome.
2. **Clean responsibility boundaries (mirrors STARK-004/005).**
   - `Synapse` owns the eligibility trace `e_ij` and its time constant (synapse-specific state),
     exactly as it already owns `x_pre`/`x_post`.
   - `Network` owns/broadcasts the scalar modulatory signal `m(t)` for the current timestep and
     orchestrates the per-synapse three-factor update — exactly as it orchestrates STDP and
     homeostatasis.
   - `NeuralCell` is NOT modified (no compelling mathematical reason to touch it).
3. **Low risk / isolated.** No topology mutation. Reuses STARK-004 traces/bounds and STARK-005
   stability machinery. Deterministic and unit-/network-testable.
4. **Foundational.** Later reward/value/affective signals are simply instances of `m(t)`.

## Critical review of the naive proposal

The initial proposal was:
```
e_ij <- e_ij * exp(-dt/tau_e)
if pre AND post in same timestep: e_ij += 1
dw = eta_3f * m(t) * e_ij ;  w <- clamp(w + dw, w_min, w_max)
```

Three problems are identified and resolved:

1. **Coincidence-only eligibility discards STARK-004 temporal asymmetry.**
   A bare `+1` on same-step coincidence cannot distinguish `pre -> post` (LTP) from
   `post -> pre` (LTD). This throws away the single most valuable property STARK-004 established.
   **Resolution:** the eligibility accumulates the *signed STDP credit* by reusing the existing
   `x_pre`/`x_post` traces:
   ```
   on post spike:  e_ij += E_plus  * x_pre      (potential potentiation  credit)
   on pre spike:   e_ij += -E_minus * x_post    (potential depression credit)
   ```
   Eligibility is therefore signed and timing-sensitive, inheriting STDP's causal structure.

2. **Potential double application with STDP (item 9).**
   If a synapse's immediate STDP update *and* a three-factor gated update are both triggered by
   the same pre/post pairing, the weight is edited twice per event.
   **Resolution — mutual exclusivity per synapse (the biologically faithful R-STDP form):**
   a synapse is in exactly one of three plasticity modes: `NONE`, `STDP` (STARK-004, immediate,
   ungated), or `THREEFACTOR` (STARK-006, deferred, modulator-gated). On a `THREEFACTOR` synapse
   the *immediate* `applyLTP`/`applyLTD` weight step is suppressed; the STDP-style credit is
   accumulated into `e_ij` and the weight only changes when `m(t)` is present. Therefore no
   weight is ever updated twice per timestep. STDP-mode synapses are byte-for-byte unchanged
   (STARK-004 frozen behavior preserved).

3. **Same-timestep policy, units, and ordering were unspecified.**
   These are now defined unambiguously in `math/stark006_specification.md` (sections 4, 6, 8).

## Ownership model

| State / parameter | Owner | Notes |
|-------------------|-------|-------|
| `e_ij` eligibility trace | `Synapse` | New per-synapse state; reset to 0 on reset() |
| `tau_e` eligibility time constant | `Synapse` | seconds, `> 0` |
| `E_plus`, `E_minus` eligibility credit amplitudes | `Synapse` | dimensionless, `>= 0` |
| `eta_3f` three-factor learning rate | `Synapse` | dimensionless, `> 0` |
| `m(t)` modulatory signal | `Network` | scalar broadcast per timestep; external input, cleared each step |
| weight bounds `w_min`,`w_max` | `Synapse` | reuse STARK-005 sign-derived bounds |
| plasticity mode | `Synapse` | `NONE` / `STDP` / `THREEFACTOR`; mutual exclusivity enforced |

`Network` orchestrates: (a) holds `m(t)` for the current step, (b) calls the per-synapse
eligibility accumulation and gated update. It does not embed learning math. `NeuralCell` is
untouched.

## Mathematical model (summary; see spec)

```
eligibility (exact exp decay):  e_ij <- e_ij * exp(-dt / tau_e)

signed credit (reuses traces):  post spiked -> e_ij +=  E_plus  * x_pre
                                pre  spiked -> e_ij += -E_minus * x_post

modulator-gated weight change:  dw_ij = eta_3f * m(t) * e_ij
                                w_ij  <- clamp(w_ij + dw_ij, w_min, w_max)
```

Behavioral signature:
- `m(t) = 0` all t  ->  `dw = 0` regardless of eligibility. Weight unchanged (key test).
- `m(t) > 0` + positive credit  ->  potentiate; `m(t) > 0` + negative credit -> depress.
- `m(t) < 0` inverts the sign of the applied credit.
- Pairing then modulator removed -> `e_ij` decays, learning tapers.
- No pairing, modulator present  ->  `e_ij = 0`, no change.

## Interaction with STDP and homeostasis

Three mechanisms may act on a synapse in one timestep, in this fixed order
(matches a proposed extension of the frozen STARK-005 `step()` ordering; see
`math/stark006_specification.md` section 8):

```
STDP (mode=STDP)     : w <- clamp(w + Delta_w_STDP)
THREEFACTOR (mode)   : w <- clamp(w + eta_3f * m(t) * e_ij)     [on THREEFACTOR synapses only]
Homeostasis (all)    : w <- clamp(w * scale_j)                  [multiplicative, incoming]
```

- STDP and three-factor are **mutually exclusive per synapse** (mode), so a single weight is
  never additively updated twice per step.
- Homeostasis is multiplicative and applies to **all** synapses regardless of mode; additive
  STDP/three-factor updates compose with it exactly as STARK-005 documents
  (`w_final = clamp((w + dw_learning) * scale)`).
- No mechanism modifies another's traces: homeostasis only multiplies `w`; three-factor only reads
  `x_pre`/`x_post` (owned by STDP machinery) and writes `e_ij` and (gated) `w`. No trace corruption.

## Timestep ordering (proposed addition to frozen STARK-005 ordering)

1. Decay STDP traces (`decayTraces`) — unchanged
2. Decay eligibility traces `e_ij *= exp(-dt/tau_e)` (new; same phase as STDP trace decay)
3. Compute neuron inputs — unchanged
4. Update neurons + post-traces — unchanged
5. Deliver pre-spikes — unchanged
6. Accumulate signed eligibility credit from current spikes — new
7. Apply STDP weight update (STDP-mode synapses only) — unchanged for STDP synapses
8. Apply three-factor gated update (THREEFACTOR-mode synapses only) — new
9. Update firing-rate EMA + multiplicative homeostasis — unchanged
10. Process delayed deliveries — unchanged
11. Advance timestep, clear external inputs, clear modulator — unchanged + clear `m(t)`

## What is explicitly NOT in STARK-006

- No RL agent, policy, value function, TD error, reward generator (modulator is externally injected).
- No memory system, attention, language, vision, voice, emotion model.
- No structural plasticity, no topology changes.
- No event-driven sim, no GPU/CUDA.
- No multiple modulator channels / per-synapse routing (single scalar broadcast only).

## Rejected-alternative summary

| Direction | Why it waits |
|-----------|--------------|
| Structural plasticity | Mutates STARK-003 topology; highest risk; needs stable fixed-topology learning first |
| Intrinsic plasticity | Overlaps STARK-005's activity regulation; incremental, no new capability axis |
| Memory / sequence | Emergent higher-level feature; needs recurrent substrate + outcome learning first |
| Recurrent microcircuit | A benchmark/testbed, not a new primitive; build it later to measure STARK-006 |
| Event-driven sim | Engineering optimization; premature at current scale |

## API (IMPLEMENTED)

Implemented in `math/stark006_specification.md` section 9 — synapse setters/getters for eligibility state and
parameters, and a Network API to broadcast `m(t)` and enable/disable per-synapse three-factor mode.

## Technical debt / risks

Recorded in `math/stark006_specification.md` section 11 and logged in `design/technical_debt.md`
(unchanged frozen phases). Key items: STARK-003 delay=1 off-by-one (pre-existing, untouched);
`test_params` is a diagnostic without assertions (pre-existing); eligibility magnitude bounds and
`exp()` defense-in-depth to (re)verify at implementation time.