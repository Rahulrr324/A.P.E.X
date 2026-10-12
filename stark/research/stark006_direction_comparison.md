# STARK-006 Direction Comparison

> STATUS: DECIDED — supersedes the earlier DRAFT. STARK-005 is now FROZEN and verified
> (multiplicative synaptic scaling, physical-Hz EMA, sign-derived weight bounds,
> `Synapse::scaleWeight`). Earlier draft text claiming STARK-005 is "broken" is obsolete.

This document compares candidate directions for the next architectural capability after:

```
STARK-001 NeuralCell  (adaptive leaky integrate-and-fire)
STARK-002 Synapse     (synaptic current + STDP trace state)
STARK-003 Network     (topology, spike routing, transmission delays)
STARK-004 STDP        (two-factor, pair-based, trace learning; immediate weight update)
STARK-005 Homeostasis (slow multiplicative synaptic scaling; firing-rate regulation)
```

The selection criterion is not impressiveness. It is: which direction provides the
strongest **scientifically coherent progression from STARK-005**, with a clear mathematical
primitive, measurable behavior, isolated tests, and a reason it belongs *before* higher-level
memory/cognition features.

---

## Candidate A — Structural Plasticity (synapse creation / pruning)

Changes the network GRAPH itself: synapses added, removed, or rewired based on activity/growth.

- Mathematical primitive: a structural rule `add(i,j)`, `remove(i,j)`, or growth probability `p(i,j|activity)`.
- Locality: local rule, but bookkeeping is global (topology mutation).
- Measurable behavior: connection density, path formation over time.
- Stability: **HIGH RISK**. Mutating STARK-003's adjacency lists, `incoming_`/`outgoing_`, and
  `delayed_spikes_` mid-simulation is hard to keep deterministic and hard to isolate from dynamics.
  STARK-003's delay queue already carries a documented off-by-one technical debt — structurtural
  plasticity would build directly on the least-tested part of the stack.
- Compatibility: stresses STARK-003 data structures before the fixed-topology learning + stability
  stack is proven under longer-running dynamics (STDP + homeostasis).
- Verdict: **PREMATURE.** Structural changes should come after fixed-topology outcome-guided
  learning exists and is stable.

## Candidate B — Three-factor / Reward-modulated learning (eligibility trace + modulator)

Extends STARK-004's two-factor rule with a THIRD factor: a scalar modulatory signal `m(t)` that
gates whether recently "eligible" synapses actually change, *deferring* the STDP credit into an
eligibility trace.

- Mathematical primitive: an eligibility trace `e_ij` (leaky accumulator of signed STDP credit)
  and a broadcast modulator `m(t)`; weight change `dw = eta_3f * m(t) * e_ij`.
- Locality: eligibility is local (uses the synapse's own `x_pre`/`x_post` traces); modulator is a
  global scalar broadcast. Clean separation parallel to STDP (synapse-local) + homeostasis
  (network-orchestrated).
- Measurable behavior: **no modulator -> no weight change despite pairing**; modulator present ->
  weight changes by `eta_3f * m * e`. Crisp, isolated, deterministic test.
- Stability: bounded because eligibility decays exponentially and weights clamp to the STARK-005
  sign-appropriate bounds.
- Compatibility: builds directly on STARK-004 traces/bounds and STARK-005 stability; does not
  mutate topology. NeuralCell is unchanged.
- Why it belongs early: STARK is currently an *unsupervised correlation learner* and can never
  learn from outcomes. Three-factor learning is the canonical, minimal bridge from Hebbian
  correlation to outcome/value-guided learning — the substrate every later affective/motivational
  feature (reward, curiosity, satisfaction, frustration, concern) will act upon.
- Verdict: **RECOMMENDED.**

## Candidate C — Intrinsic / homeostatic neuronal plasticity

Regulates each neuron's own excitability (e.g. baseline threshold `theta_0`, leak `tau_m`,
adaptation) toward a target firing rate, complementing STARK-005's *synaptic* homeostasis.

- Mathematical primitive: slow per-neuron parameter drift, e.g. `d(theta_0)/dt = eta_int*(r_target - r_mean)`.
- Locality: fully local per neuron.
- Stability: bounded if the intrinsic parameter is clamped.
- Compatibility: touches `NeuralCell` parameters (frozen STARK-001) only via a slow external
  controller, similar to how STARK-005 touches weights. But it overlaps, not extends, the
  activity-regulation capability STARK-005 already provides.
- Verdict: **VALID but incremental.** Consolidates stability; opens no fundamentally new
  capability axis. Better as a follow-up.

## Candidate D — Memory / sequence mechanisms (working memory, replay)

Persistent or sequential activity patterns used as a memory substrate.

- Mathematical primitive: none elementary; it is an *emergent* property of recurrent dynamics +
  plasticity, not a new primitive.
- Measurable behavior: sustained activity after offset; sequence replay.
- Concern: needs a mature recurrent substrate AND stable, outcome-guided learning first.
- Verdict: **TOO EARLY.**

## Candidate E — Sparse recurrent dynamics / canonical microcircuit benchmark

Build a small structured recurrent circuit (balanced E/I loop) and characterize propagation,
reverberation, E/I balance.

- Mathematical primitive: none new; a CONFIGURATION + benchmark of existing primitives.
- Value: excellent validation harness that STARK-001..005 produce meaningful dynamics.
- Concern: adds no learning/computational primitive.
- Verdict: **VALUABLE as the future testbed for Candidate B, not the next primitive.**

## Candidate F — Event-driven simulation / performance infrastructure

Fixed-timestep -> event-driven spike processing.

- Mathematical primitive: none (engineering).
- Concern: premature; network is small, performance is not the bottleneck.
- Verdict: **DEFER.**

---

## Summary Table

| Candidate | New primitive? | Locality | Testability | Risk | Opens value-guided learning? | Verdict |
|-----------|:-:|:-:|:-:|:-:|:-:|---------|
| A Structural plasticity | yes | mixed | hard | HIGH | no | Premature |
| B Three-factor learning | yes | local signal + global modulator | EASY | low | YES | **Recommended** |
| C Intrinsic plasticity | yes | local | easy | low | partial | Incremental |
| D Memory / sequence | no (emergent) | - | hard | high | partial | Too early |
| E Recurrent microcircuit | no (config) | - | easy | low | no | Supporting testbed |
| F Event-driven sim | no (engineering) | - | medium | medium | no | Defer |

---

## Recommendation

**STARK-006 = Three-factor, modulator-gated synaptic plasticity with an eligibility trace.**

Justification (non-impressiveness-based):
1. It is the minimal primitive that converts STARK's unsupervised correlation learner (STDP) into
   a modulator/outcome-guided learner, without mutating topology or touching `NeuralCell`.
2. Every later affective/motivational feature is computationally a modulatory signal. This phase
   creates the substrate those signals act on. Candidate B is the gateway primitive for all later
   value-based cognition; none of the others is.
3. It has a crisp deterministic signature: modulator absent -> no weight change despite pairing;
   modulator present -> weight change proportional to signed eligibility.
4. It reuses STARK-004 traces/bounds and STARK-005 stability, and is easy to isolate and test.
5. Candidate E is a natural *testbed* for measuring B, but E alone adds no primitive.

Critical refinements to the naive "coincidence counter" version are specified in
`design/stark006_decision.md` and `math/stark006_specification.md`:
- eligibility accumulates **signed STDP credit** (preserves STARK-004 timing asymmetry), not a
  bare +1 coincidence counter;
- the modulator **replaces** the immediate STDP weight update on a three-factor synapse
  (no double application);
- new state/parameters are dimensionally consistent with the frozen baseline.