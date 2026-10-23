# Eligibility-Gating Milestone (STARK-L5) — versioned design and frozen protocol

Version: 1.0 — **protocol and success criteria frozen before implementation**
(2026-10-23). Implementation may not alter §4–§7. Post-results revisions must
be versioned with the reason recorded BEFORE evaluating the revision; v1.0
verdicts stand as measured.

## 1. Problem statement and source-level diagnosis

STARK-L4 v1.0 (preserved report
`work/dev_associative_memory_report_STARK-L4-v1.0-FAIL.json`) failed when
unrelated distractor cues were present **during training**: the weight
matrix collapsed (N=8 mean w 0.041) or captured single units. The L4 v1.1
workaround (silent training) does not fix the mechanism. Source audit of
`Synapse`/`Network` (STARK-006) proves the update path:

- `Network::step` step 6: every THREEFACTOR synapse runs
  `accumulateEligibility(pre_spiked, post_spiked)`: `e += E_plus·x_pre` on
  any post-spike of its target and `e −= E_minus·x_post` on pre-spikes.
  A distractor cue's pre-spike sets `x_pre` for that row (decay tau_pre =
  20 steps); subsequent spikes of *any* co-active response unit then build
  eligibility on that unrelated row.
- step 7: one global modulator m applies `dw = eta_3f·m·e` to every
  THREEFACTOR synapse with e ≠ 0 — indiscriminate with respect to which
  association the reward is for.
- The tonic attractor winner spikes every step, multiplying e on all
  co-active rows (amplifier, not root cause).
- Trace lifecycle is correct: `Network::reset()` → `Synapse::reset()`
  clears x/x_pre/x_post/e per trial; no stale-eligibility leak.

Instrumented single-event proof (identical schedules/seeds, N=8 training
with distractors): on one modulatory event, distractor rows received
Σ|Δw| = 0.05–0.13 each while the queried row received 0.00–0.35 — in one
trial the query row received **zero** and three distractor rows absorbed
the entire update. Root cause: **eligibility remains active for unrelated
cue–response associations and the modulator is global**; no mechanism ties
an eligibility trace to the association episode it belongs to.

## 2. Candidate mechanism: pre-side eligibility gate (attention/encoding signal)

Smallest justified extension (missing prerequisite identified above):
a per-neuron **eligibility gate** on the pre-synaptic side.

- `Network::setEligibilityGate(neuron_id, bool on)` / `getEligibilityGate`.
  Default: all on (true). `accumulateEligibility` is called only for
  THREEFACTOR synapses whose pre-neuron gate is on. Accumulation is
  blocked at **trace creation**; decay, modulation, and the STARK-006 rule
  itself (`dw = eta·m·e`) are unchanged.
- `Network::reset()` restores all gates to true (gates are per-trial task
  state, not learned state). Serialization format is **unchanged**: gates
  are volatile driver state, default true after `deserialize` (the driver
  re-sets them each trial after `reset()`). Documented in code.
- Task-relevant signal: the cue presented as the **queried item** of the
  current trial (the attention/encoding signal of the task). It is
  available at the time of accumulation and of the update; it is NOT the
  response label, NOT a future reward, NOT an evaluation artifact. The
  response mapping π is never consulted to set gates.
- Gate modes (task config, default preserves existing behavior):
  0 = none (existing ungated rule, reference mode); 1 = query-only
  (candidate); 2 = inverted (query OFF, all other cues ON — negative
  control). No per-item hardcoding; distractor weights are not frozen.

Causal justification: with the query gate on and distractor gates off, the
query row's eligibility is created by the query cue's pre-spikes and the
co-active response activity — exactly the cue→response pairing the reward
is about; unrelated rows receive no eligibility and therefore no updates
from this trial's modulator. The inverted control must fail to learn the
task, proving the improvement comes from the *signal*, not from suppressing
learning.

## 3. Task and protocol (multi-association training with distractors)

The STARK-L4 v1.0 task **unchanged**: C = 8 cues, R = 8 responses, seeded
bijection π, nested trained sets, trial = cue (3 steps) → interference
window (K = 8, p(silent) = 0.25, other-item cues) → decision (6) → delay
(2) → reward. **Training trials carry distractor cues** (the L4 v1.0
configuration) in every arm. Evaluation: identical distractor stream,
learning disabled.

Loads: N = 8 (primary — the v1.0 failure case) and N = 4 (per-association
detail). Masters {20261023, 20261024, 20261025}; train = master, validation
= master+1 (monitoring only), evaluation = master+2. 40 training trials
per item, 24 evaluation queries per item per seed. Identical schedules
across arms (paired).

Arms per (load, seed):

| Arm | gate mode | modulator | role |
|---|---|---|---|
| UNGATED | 0 (off) | task reward | reference: existing rule; must reproduce the v1.0 failure |
| GATED | 1 (query-only) | task reward | candidate |
| INVERTED | 2 (distractors-only) | task reward | signal-specificity control |
| SHAM | 1 (query-only) | +1 always | sham reward control |

## 4. Metrics (frozen)

- Per-association accuracy (Wilson 95% CI) and aggregate accuracy (CI),
  pooled over seeds; validation accuracy (monitoring).
- **Unintended update mass** U = mean over training trials of
  Σ_{rows≠query} Σ_r |Δw| (per-trial weight snapshots around the trial);
  **intended update mass** I = mean Σ_r |Δw| on the query row; ratio U/I.
- Trained-row selectivity (argmax = π(cue) rate); training reward trend
  (first 20 vs last 20); final weight rows.
- Persistence: save→reload behavioral equivalence on all evaluation
  queries (identical choices), weights bit-identical, serialize round-trip
  byte-identical, double-reload deterministic (on GATED N=8 agents).

## 5. Success criteria (frozen) — pooled over the 3 seeds

| # | Criterion | Threshold |
|---|---|---|
| L5-A | Learning under training distractors | GATED acc(N=8) ≥ 80%; ≥ UNGATED + 30 pp; every association ≥ 55% (pooled, N=8) |
| L5-B | Unintended updates suppressed | mean U_gated ≤ 0.25 × mean U_ungated; and U_gated / I_gated ≤ 0.25 |
| L5-C | Signal-specific, not learning suppression | I_gated ≥ 0.5 × I_ungated; INVERTED acc(N=8) ≤ 35%; INVERTED updates go to non-query rows (U_inverted ≥ I_inverted) |
| L5-D | Sham control | SHAM acc ≤ 35% at both loads |
| L5-E | Persistence | save/reload exact (as §4) |
| L5-F | Determinism | two runs, byte-identical report |
| L5-G | Regression | L1, L2, L3, L4-v1.1 reproduce byte-identically (default ungated path unchanged); L4 suites + new L5 suite pass; STARK-001..007 9/9; Phase-1 §K 5/5 |

Additionally the UNGATED arm is required to reproduce the L4 v1.0 failure
signature under identical seeds/schedules (same config as the preserved
v1.0 report) — the reference arm must be the real failure case.

Failures are reported as measured; criteria are never relaxed post-hoc.

## 6. Reproducibility contract

One JSON report (`schema: STARK-L5-1`) with per-arm, per-seed blocks:
per-association tables, U/I metrics, weights, trends, save/reload flags,
every criterion verdict. Two runs byte-identical. mt19937-only randomness;
gates set only from the presented query identity (never from π or rewards);
no evaluation data in any decision.

## 7. Preregistered expectations (predictions, not guarantees)

From the L4 v1.0/v1.1 measurements: UNGATED acc(N=8) ≈ 0.10–0.20
(reproducing v1.0's 0.116); GATED ≈ 0.85–0.98 (close to v1.1's silent-
training 0.979, possibly slightly lower — training-time distractor kicks
add race noise to choices during training); INVERTED ≈ 0.10–0.25 (no
consistent mapping learnable from distractor rows); SHAM ≈ 0.10–0.25.
U_gated = 0 exactly (blocked at trace creation); U_ungated ≈ 0.1–0.3 per
trial. I ratios as defined. If GATED underperforms v1.1 substantially, the
suspected cause is training-choice noise from distractor dynamics (not
credit assignment) — distinguishable by per-association weight selectivity
(rows clean but reward trend lower).

## 8. Outcome (2026-10-23)

Executed unchanged; no parameter or criterion altered after results.
Report: `work/dev_eligibility_gating_report_STARK-L5-1.json` (schema
STARK-L5-1). Pooled over 3 seeds; eval n = 24/item/seed (N=8: 576/arm);
Wilson 95% CIs; U/I = mean per-trial unintended/intended |dw| mass.

| # | Criterion | Threshold | Measured | Verdict |
|---|---|---|---|---|
| L5-A | Learning under training distractors | GATED(N=8) >= 80%; >= UNGATED + 30 pp; min item >= 55% | 0.9965 [0.987,0.999]; UNGATED 0.1163 (gap 0.880); min item 0.972 | PASS |
| L5-B | Unintended updates suppressed | U_gated <= 0.25*U_ungated; U/I <= 0.25 | U_gated = 0.0000 exactly; U_ungated = 0.0963; U/I = 0 | PASS |
| L5-C | Signal-specific, not suppression | I_gated >= 0.5*I_ungated; INVERTED <= 35%; U_inv >= I_inv | I_gated 0.0468 >= 0.5*0.0424; INVERTED 0.0799 [0.060,0.105]; U_inv 0.0840 / I_inv 0.0000 | PASS |
| L5-D | Sham control | <= 35% both loads | sham 0.125 (N=8), 0.083 (N=4) | PASS |
| L5-E | Persistence | exact save/reload | 3/3 seeds: weights bit-identical; 0/576 choice mismatches; serialize round-trip byte-identical; double reload deterministic | PASS |
| L5-F | Determinism | two runs byte-identical | cmp identical | PASS |
| L5-G | Regression | L1-L4 byte-identical; suites; 9/9; K 5/5 | all pass | PASS |

**L4 v1.0 reproduction:** the UNGATED arm reproduces the preserved v1.0
failure exactly under identical seeds/schedules/config — pooled acc
0.116319 at N=8 and 0.368056 at N=4 (identical to the preserved v1.0
report) — the reference arm is the real failure case.

Before/after under identical training conditions (N=8, distractors during
training, same schedules): acc 0.1163 -> 0.9965; unintended update mass
0.0963 -> 0.0000; intended mass 0.0424 -> 0.0468 (learning not suppressed —
slightly strengthened on the correct rows). N=4: acc 0.3681 -> 1.0000.
Gated training reward trend -0.5..-1.0 (first 20) -> 1.00 (last 20) at both
loads; every trained row's argmax equals pi(cue) at the 0.7 ceiling;
per-association accuracy 22/24-24/24 everywhere. The inverted gate routes
100% of update mass to non-query rows (I_inv = 0) and fails to learn
(0.0799) — the improvement comes from the task-relevance signal, not from
suppressing plasticity. Sham acquires no skill (0.125 / 0.083) despite
nonzero intended mass (m = +1 drift only).

Mechanism accounting: the gate blocks eligibility at **trace creation**
for gated-off pre-neurons; decay (tau_e) and modulation (dw = eta*m*e) are
untouched; reset() restores all gates to true (per-trial task state);
serialization format unchanged — gates default true after deserialize and
are re-set by the driver each trial (documented in Network.h). The default
path (no gate touched) is bit-identical: L1, L2, L3, and L4-v1.1 reports
reproduce byte-for-byte; all suites pass (55/18/1887/1463/28 assertions);
STARK-001..007 9/9 (test_three_factor and test_serialization required a
deserialize sizing fix for the new gate vector — regression suite caught
it); Phase-1 K 5/5.

Remaining limitations: the gate signal (queried-item identity) is supplied
by the task driver as an attention/encoding signal — a network that learns
its own relevance signal is future work; gate state is per-trial driver
state, not learned or serialized; the toy family and single-modulator
three-factor rule are otherwise unchanged. Next milestone: self-organized
attention/eligibility coupling, or finer-granularity gating (synapse-level
tags) for overlapping associations.
