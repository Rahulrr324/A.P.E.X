# Associative-Memory Milestone (STARK-L4) — versioned design and frozen protocol

Version: 1.1 — protocol and success criteria frozen before v1.1 evaluation
(2026-10-23; v1.0 frozen and executed the same day — **v1.0 verdicts: FAIL on
L4-A..E, PASS on L4-F/G**, report preserved as
`work/dev_associative_memory_report_STARK-L4-v1.0-FAIL.json`). Criteria of
§6 are unchanged. v1.1 is a targeted task-design correction for the
documented v1.0 failure mechanism; v1.1 results are evaluated against the
identical §6 thresholds.

**v1.1 correction (diagnosed from v1.0 training trajectories; not tuned on
evaluation data):** training trials use a **silent** interference window
(p(silent) = 1.0); evaluation schedules are unchanged (standard p = 0.25,
heavy p = 0.0). Reason: v1.0 demonstrated H3 destructively — the STARK-006
rule applies m to **all** active eligibilities, and a tonic-winning response
unit makes eligibility large on every co-presented distractor row (e ≈
E+·x_pre·#spikes ≈ 0.45); m = −1 trials then decay whole rows (N=8 matrix
collapsed to mean w = 0.04, correct-path mean 0.08) and m = +1 trials capture
rows toward the query's response (all 8 rows converged to one unit in one
N=2 run). Distinguishing experiment (64 trials, N=8, distractors vs silent,
same seeds): mean w 0.041 vs 0.292; correct-path mean 0.080 vs 0.389 —
training-side co-activation is causal; eval-time dynamics were not (v1.0
training reward was negative: choices were wrong during training itself).
The missing capability is **eligibility gating by item role** in the frozen
three-factor rule; the smallest correction that does not modify STARK-006 is
to confine distractor co-activation to evaluation (learning disabled).
Retrieval-time interference from unrelated items (the mission's requirement)
is unchanged and remains the load/heavy manipulations.

## 9. Outcome (2026-10-23)

**v1.0 (executed as frozen; FAILED):** L4-A..E FAIL, L4-F/G PASS — report
preserved at `work/dev_associative_memory_report_STARK-L4-v1.0-FAIL.json`
(sha 8d9b1faf…). Signature: N=8 matrix collapsed to mean w = 0.041,
correct-path mean 0.080; N=2 capture (all rows → one unit). Cause:
training-side eligibility cross-talk (H3), confirmed by the distinguishing
experiment (distractors vs silent, same seeds: mean w 0.041 vs 0.292).

**v1.1 (targeted correction as documented above; criteria unchanged):**
Report `work/dev_associative_memory_report_STARK-L4-1.json` (schema
STARK-L4-1). Pooled over 3 seeds; eval n = 24/item/seed; Wilson 95% CIs.

| # | Criterion | Threshold | Measured (v1.1) | Verdict |
|---|---|---|---|---|
| L4-A | Retrieval at load 4 | ≥ 70%; ≥ base + 25 pp | 0.997 [0.981,0.999]; base 0.108 | PASS |
| L4-B | Per-association at load 4 | every item ≥ 55% | min 0.958 (pooled per-item) | PASS |
| L4-C | Capacity at load 8 | ≥ 55%; ≥ base + 20 pp | 0.979 [0.964,0.988]; base 0.120 | PASS |
| L4-D | Interference robustness | acc_heavy(N=8) ≥ 45% | 0.972 (std 0.979; Δ = 0.007) | PASS |
| L4-E | Memory ablation | ≤ 35%; gap ≥ 35 pp | amnesic 0.108; gap 0.889 | PASS |
| L4-F | Controls | sham ≤ 40%, base ≤ 35% all loads; max share ≤ 40% | sham ≤ 0.153, base ≤ 0.120; max share 0.134 | PASS |
| L4-G | Save/reload | exact equalities | weights bit-identical; 0/576 choice mismatches; serialize round-trip byte-identical; double reload deterministic (3/3 seeds) | PASS |
| L4-H | Determinism | two runs byte-identical | `cmp` identical | PASS |
| L4-I | Regression | L1/L2/L3 repro; suites; 9/9; §K 5/5 | all pass | PASS |

Load curve (pooled trained): N=2 1.000 [0.974,1]; N=4 0.997; N=6 0.958;
N=8 0.979. Training reward trend −0.5..−1.0 (first 20) → 1.00 (last 20) at
every load. Every trained row's argmax equals its mapped response at the
0.7 ceiling (bindings, not weight drift). Hijack diagnostics: 1.1–1.9
challenger spikes/trial vs 3.6–5.1 correct-unit spikes (tonic persistence);
measured errors concentrate on late-rung (delay-3) items — e.g. seed
20261024 cues→units 6,7 at 21/24; seed 20261025 cues→units 7,6 at 22/24,
20/24 — confirming the preregistered ignition-race steal mechanism (H2
holds directionally; the overall load effect is small because query kicks
begin before any distractor). Sham/baseline/amnesic at 8-way chance
(0.056–0.153) — no fixed-action shortcut (max share 0.134), no cue leakage
(structural tests), no evaluation-time learning.

Layer separation (as claimed in §1): architecture = neurons/WTA/attractors/
delay rungs/three-factor rule/serialization; learned = the cue→response
weight matrix (selective rows); stored state = that matrix (save/reload
restores behavior exactly); retrieval = cue-evoked ignition race + tonic
persistence + spike-count readout. The v1.0→v1.1 history additionally
documents that the frozen three-factor rule lacks eligibility gating by
item role — without it, multi-item training under distractor co-activation
collapses (missing capability, recorded).

Limitations: toy family; one attractor per response unit is architecture
(capacity beyond 8 items untested); tonic attractor makes post-ignition
hijack nearly impossible, so interference sensitivity is concentrated in a
short race window; training-side distractor co-activation remains
unsupported (would require eligibility gating in STARK-006). Next: either
eligibility gating (neural-module extension, regression-tested) or larger
vocabularies with rung-structured response spaces.

## 1. Goal, capability claims, and mechanistic hypotheses

L3 held **one** cue in a two-action attractor. L4 asks whether the
architecture can **store and retrieve multiple distinct cue–response
bindings**, handle interference from unrelated items, and preserve the
learned state across save/reload. This is *not* a claim of general memory:
the scope is N-item heteroassociative retrieval in a fixed toy family.

Four layers, kept distinct throughout the report:

- **Architecture provided** (hard-wired, NOT learned): 8 cue + 8 response
  neurons; pairwise WTA inhibition among response units; one persistent-
  activity attractor per response unit (self-excitation); the STARK-006
  three-factor rule; fixed per-synapse delivery **delays** forming exploration
  rungs (label-free); STARK-007 serialization.
- **Associations learned from experience**: the 8×8 cue→response weight
  matrix, updated only by rewarded retrieval trials (m = ±1). The N stored
  bindings live in the trained rows; untrained rows must stay unselective.
- **Stored internal state**: the trained weight matrix — the same
  representation written by `Network::save/serialize` and rebuilt on reload.
- **Retrieval mechanism**: query cue → learned pathway kick → attractor
  competition among response units → state held across an interference
  window → spike-count readout at the decision point. Behavioral accuracy
  (not weight inspection) is the evidence of retrieval.

Hypotheses (preregistered, falsifiable):

- **H1 (binding):** rewarded training produces one dominant weight per
  trained row (correct response), yielding per-association retrieval well
  above chance (1/8) — a learned property, destroyed by wiping the weights.
- **H2 (interference):** distractor presentations of *other trained items*
  can hijack the held attractor (their pathways are strong); interference
  therefore grows with memory load N and with distractor density. Load curve
  and heavy-interference accuracy measure this.
- **H3 (credit cross-talk):** because the three-factor rule applies m to all
  active eligibilities, a co-presented distractor item's pathway receives
  updates from the query's reward (retroactive interference in weight space);
  this appears in row trajectories and per-item errors.
- **H4 (persistence):** the learned state is the weight matrix; save→reload
  restores behavior exactly (choice-for-choice equivalence on held-out
  queries), not merely a readable file.

## 2. Task — multi-item delayed retrieval with unrelated-item interference

Vocabulary: C = 8 cue neurons; R = 8 response units; mapping π: cue →
response is a seeded permutation per master seed (bijective: every response
is the answer for exactly one cue — no frequency shortcut). Load N ∈
{2,4,6,8}: the trained item set is the first N of a seeded cue shuffle σ
(nested across loads). Untrained cues exist only as distractor material.

Per trial (dt = 1; `Network::reset()` between trials — weights persist):

```
[CUE  3 steps]  S_query <- 1.2 (3 spikes); all other cues silent
[INTERF K=8]    each step: silent (p=0.25) or ONE distractor cue j != query
                uniform over the other 7 cues (seeded, with replacement)
[DEC  6 steps]  exploration noise; choice = spike-count majority over the 8
                response units (tie: earliest first spike; then seeded draw)
[DELAY 2 steps] zero task input; tonic baseline persists
[REWARD 1 step] m = +1 iff choice == pi(query), else -1
```

- Training: 40 trials per trained item (balanced exposure), item order
  shuffled; interleaved across items. **[v1.1]** Training trials use a
  silent interference window (eligibility confined to the queried item);
  validation/evaluation/heavy schedules carry the distractor streams and
  run with evaluation-time learning disabled. Validation (monitoring only)
  and evaluation use disjoint seeds; queries are balanced exactly per item.
- Distractor draws never branch on the response label (no answer leakage);
  the distractor pool excludes the queried cue; distractor identity carries
  no response information — the answer is recoverable only through the
  learned binding.
- Heavy-interference evaluation: identical generator with p(silent) = 0
  (every step a distractor item), disjoint seed.

## 3. Agent and dynamics (frozen parameters)

- Cue neurons S0..S7: tau_m 10, theta 0.6, tau_a 20, adapt 0, v_reset −0.5.
  Response neurons A0..A7: same but theta 1.2, tonic baseline I_base 0.08
  (subthreshold alone: V* = 0.8).
- Plastic S_i→A_r ×64: THREEFACTOR (STARK-006), w_init 0.35, bounds [0, 0.7],
  eta_3f 0.6, E 0.05/0.02, tau_e 8, tau_pre = tau_post = 20, tau_s 2.
  Delivery delay of S_i→A_r = floor(r/2) ∈ {0,1,2,3} — fixed rungs: units
  receive cue kicks in a fixed order, breaking the symmetric start without
  any label information (architecture-supplied exploration scaffold).
- Fixed: pairwise WTA A_r→A_r′ (r≠r′), w_inh −1.2, tau_s 2; self-excitation
  A_r→A_r, **w_self 1.05** (ablation 0.0). *Pre-evaluation dynamics note
  (verified in focused tests before the frozen experiment, criteria
  untouched):* a response unit that spikes ~2 steps in a row ignites
  **tonic self-sustained firing** (x_self → 2.0, I_self → 2.1) and holds it
  through the interference window; interference therefore acts in the
  **ignition race** (early interference window), not by post-ignition
  hijack. H2's load-dependent hijack is testable via trained-distractor
  kicks during that race and via training-side quality; post-ignition
  hijack is not expected.
- Noise on response units: ±0.04 (cue/sequence), ±0.10 (decision). Tie
  breaks seeded (never a fixed default).

## 4. Conditions, seeds, schedules (frozen)

Masters {20261023, 20261024, 20261025}. Per master: π and σ seeded
deterministically; train seed = master; validation = master+1 (reported,
never used for decisions); evaluation = master+2 (headline); heavy
evaluation = master+3. Queries per item per schedule: 24 (validation,
evaluation, heavy), training 40/item. Identical paired schedules for
trained / sham / baseline within a condition.

| Group | Loads | Agents | Purpose |
|---|---|---|---|
| core | N = 2, 4, 6, 8 | trained, sham, baseline | load curve, retrieval |
| amnesic | N = 4, 8 | trained then weights reset to w_init | memory ablation |
| heavy | N = 8 | trained agents, heavy eval | interference robustness |
| save/reload | N = 8 | trained agents | persistence |

Amnesic = the trained agent with every S→A weight reset to w_init after
training (architecture intact, stored state wiped). Sham = plastic with
m ≡ +1 (`reward_contingent=false`). Baseline = `PlasticityMode::NONE`.

## 5. Metrics (frozen)

Per (load, seed) and pooled over the 3 seeds: aggregate retrieval accuracy
with Wilson 95% CI; **per-association accuracy** with Wilson CIs; response
frequency distribution (fixed-action detector); final weight rows
(selectivity); training reward trend (first 20 vs last 20); hijack
diagnostics (non-winner response spikes during the interference window);
validation accuracy (monitoring). Load curve: acc(N) with CIs. Heavy:
acc_heavy(N=8) and Δ = acc(N=8) − acc_heavy (reported; the sign is
informative either way).

## 6. Success criteria (frozen) — pooled over the 3 seeds

| # | Criterion | Threshold |
|---|---|---|
| L4-A | Retrieval at load 4 | aggregate acc ≥ 70%; ≥ baseline + 25 pp |
| L4-B | Per-association at load 4 | every trained association ≥ 55% (pooled) |
| L4-C | Multi-item capacity at load 8 | aggregate acc ≥ 55%; ≥ baseline + 20 pp |
| L4-D | Interference robustness | acc_heavy(N=8) ≥ 45% (chance = 12.5%) |
| L4-E | Memory ablation | acc(amnesic, N=4) ≤ 35%; acc(N=4) − acc(amnesic) ≥ 35 pp |
| L4-F | Controls | sham ≤ 40% and baseline ≤ 35% at every load; max response share ≤ 40% at N=8 trained |
| L4-G | Save/reload | weights bit-identical after save→load; identical choices on every held-out query; serialize→deserialize→serialize byte-identical; double reload deterministic |
| L4-H | Determinism | two full runs, byte-identical report |
| L4-I | Regression | L1, L2, L3 reproduce byte-identically; their suites pass (55/18/1887 assertions); STARK-001..007 9/9; Phase-1 §K 5/5 |

Failures are reported as measured; criteria are never relaxed post-hoc.
Implementation defects found by the experiment are fixed by the smallest
justified change and the full protocol is re-run.

## 7. Reproducibility contract

One JSON report (`schema: STARK-L4-1`) recording configs, seeds, π and σ,
per-item accuracy tables, weight rows, hijack diagnostics, heavy-interference
block, save/reload block, and every criterion verdict. Two runs
byte-identical. mt19937-only randomness; no evaluation data in any training
or parameter decision.

## 8. Preregistered expectations (predictions, not guarantees)

Updated before v1.1 evaluation (v1.0 text predicated on distractor-free
training being unnecessary — refuted by the preserved v1.0 run; dynamics
note §3 also predates v1.0 results). From the v1.0 failure analysis, the
mini-tests, and the ignition-race arithmetic: acc(N=2) ≈ 0.85–1.0;
acc(N=4) ≈ 0.70–0.95; acc(N=8) ≈ 0.65–0.85 (errors from training-side
per-item locking and ignition-race steals — trained distractors whose
target rung fires before the query's target can capture the trial; items
mapped to late rungs are more steal-prone); acc_heavy ≈ 0.55–0.80; amnesic
≈ 0.10–0.25; sham/baseline ≈ 0.10–0.30 (8-way chance = 0.125). H2 should
now appear as load- and density-dependent race steals. H3's cross-talk is
removed from training by design and can only appear in eval schedules,
where learning is disabled (so: not at all). A flat load curve would be a
capacity finding.
