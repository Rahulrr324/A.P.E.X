# Sequential-Context Milestone (STARK-L3) — versioned design and frozen protocol

Version: 1.1 — **protocol and success criteria frozen before implementation**
(2026-10-23; v1.0 same day; v1.1 corrections below, applied before any code
was run). Implementation may not alter §4–§7. If the design must change after
results are seen, it is versioned (1.2, …) with the reason recorded BEFORE
evaluating the revised protocol; v1.1 verdicts stand as measured.

**v1.1 corrections (found during implementation, before any run):** §2
parameters theta_cue 1.0 → 0.6, adapt_b 0.5(S/D) → 0.0 (all), w_self 1.0 →
1.2, and the delay phase zeroes **task** input while the tonic baseline
I_base persists. Reasons: (i) v1.0's theta=1.0 makes single-step distractor
and anti-cue pulses silent (V = 0.7 < 1.0) — the task would have no
distractors; (ii) sensory adaptation (b = 0.5) suppresses the anti-cue
response after the cue's spikes and self-extinguishes sustained A firing —
both contradict H1/H3; (iii) w_self = 1.2 is required for the attractor to
survive the probe anti-kick and to sustain a clean 2-step cycle; (iv) v1.0's
literal "zero external input" at the delay would stall the attractor
mid-delay, contradicting H1. All seeds, conditions, metrics, and success
criteria of §4–§7 are unchanged.

## 1. Goal, capability, and mechanistic hypotheses

L1: immediate reward, static cue. L2: reward delayed after an *empty* quiet
period. Neither requires holding task-relevant sequential context.

L3 asks whether the existing architecture can learn a task where an **early
cue determines the correct action after intervening distractor input**, with
reward delivered after a further controllable delay — genuine sequential
context use, not merely waiting through silence.

Mechanistic hypotheses (preregistered, falsifiable):

- **H1 (retention):** behavioral retention of the early cue is carried by
  **persistent activity** — a winner-take-all attractor on the action neurons
  (self-excitation + mutual inhibition), started by the cue-evoked kick and
  held across the sequence. NOT by eligibility traces. Predicted evidence:
  ablating self-excitation collapses long-sequence accuracy (L3-E), and
  action-neuron spike records show sustained cue-aligned activity through the
  sequence.
- **H2 (credit assignment):** cue→action credit is bridged by the pre-synaptic
  trace (`tau_pre`), decision→reward credit by the eligibility trace
  (`tau_e`) — same three-factor mechanism as L1/L2 (STARK-006), unchanged.
- **H3 (recency):** a late input contradicting the early cue competes with
  the attractor; a context-retaining agent keeps answering from the first cue
  more often than from the recency input (L3-D).

No claim that eligibility traces constitute working memory. Non-claims
unchanged from L2 §8 (toy task family only; M0 acceptance untouched: G7
environmental, M0 = FAIL, M1 = LOCKED).

## 2. Task — early cue, distractor sequence, delayed reward

Per trial (dt = 1 step; network state reset between trials; weights persist):

```
[CUE  2 steps]  S_cued <- I_cue=1.2 (spikes both steps); S_other silent
[SEQ  K steps]  distractor pattern per step: none | D0 | D1  (cue-independent)
                D-neuron spikes deliver symmetric fixed drive to BOTH A's
[DEC  6 steps]  exploration noise on A's; choice = spike-count majority
                (tie: first spike; then seeded draw)      <- decision point
[DELAY D steps] zero TASK input; tonic baseline I_base persists on A's
                (attractor state persists or decays)
[REWARD 1 step] m = +1 if choice == first cue else -1 (three-factor update)
```

- Correct action = first-cue identity (cue 0 → A0, cue 1 → A1).
- Distractor patterns are generated independently of the cue value
  (structural: RNG draws never branch on cue) and are balanced
  (P(none)=0.25, P(D0)=P(D1)=0.375 per step).
- Agent (6 neurons): S0,S1 sensory; A0,A1 action; D0,D1 distractor.
  Synapses: 4 trainable S→A (`THREEFACTOR`, STARK-006); A0↔A1 WTA inhibition
  (fixed, −1.2); A0→A0, A1→A1 self-excitation (fixed, **+1.2** — the
  attractor; **ablation: 0.0**); D→A ×4 fixed symmetric (+0.15).
- Neurons (STARK-001): all tau_m = 10, v_reset = −0.5, **adapt_b = 0**
  (sensory transduction and sustained firing must not self-extinguish).
  S/D theta = 0.6 (single-step distractor and anti-cue pulses must
  transduce to a spike; the 2-step cue drives 2 spikes). A theta = 1.2.
  Tonic baseline I_base = 0.08 on A's only (A stays subthreshold without
  kicks: V* = 0.8).
- S→A plastic: w_init = 0.5, bounds [0, 0.7], eta_3f = 0.6, E = 0.05/0.02,
  tau_e = 8, tau_pre = tau_post = 20 (bridge cue→decision-time spikes).

## 3. Recency-probe evaluation (context vs most-recent input)

Probe schedules: identical trial structure, but the **last sequence step
delivers an anti-cue** — a single full-strength cue pulse to S_other (the
sensory neuron whose trained pathway favors the *wrong* action for this
trial). The probe schedule is disjoint from training and from standard
evaluation, identical for trained and control agents.

Reported per agent: `acc_first` = P(choice == first cue), `acc_last` =
P(choice == anti-cue action). With two actions, acc_last ≈ 1 − acc_first; a
recency-driven responder scores acc_first ≈ 0 (acc_last ≈ 1). Genuine
context retention: acc_first stays well above 0.5.

## 4. Conditions, seeds, schedules (frozen)

All conditions × 3 master seeds {20261023, 20261024, 20261025}. Per seed:
train schedule (seed = master), standard eval (master + 1), probe eval
(master + 2). **Identical paired schedules** for trained / sham / frozen
baseline within a condition. 100 training, 50 standard-eval, 50 probe trials.
Cue balance exactly half/half per schedule (seeded shuffle).

| Condition | K (seq) | D (reward delay) | self-excitation | role |
|---|---|---|---|---|
| C1-SHORT | 4 | 2 | 1.0 | core sequential learning |
| C2-LONG | 12 | 2 | 1.0 | long-sequence context |
| C3-LONG-D8 | 12 | 8 | 1.0 | reward-delay robustness |
| C4-ABLATE | 12 | 2 | **0.0** | H1 mechanism ablation |

Agents per condition per seed: **trained** (task reward), **sham** (modulator
≡ +1; `reward_contingent=false`), **frozen baseline** (`PlasticityMode::NONE`).

## 5. Metrics (frozen)

- Per (condition, seed) and pooled over seeds: standard-eval accuracy with
  Wilson 95% CI (pooled n = 150); per-cue accuracy; probe acc_first / acc_last
  with Wilson CIs; final plastic weights [w00, w01, w10, w11]; pair gap;
  training reward trend (first 20 vs last 20).
- Length effect: Δ_len = acc(C1) − acc(C2), pooled, with CIs (reported; the
  sign is informative either way — no pass/fail bound).
- Mechanism diagnostics: mean action-neuron spikes during the SEQ window per
  condition (attractor persistence), and the same for the ablation.
- Cue-leak check: mean distractor load conditional on cue (|mean0 − mean1|
  reported; structural independence holds by construction).

## 6. Success criteria (frozen) — pooled over the 3 seeds

| # | Criterion | Threshold |
|---|---|---|
| L3-A | Sequential learning (C1-SHORT) | acc ≥ 80%; ≥ baseline + 25 pp; each cue ≥ 75% |
| L3-B | Long-sequence context (C2-LONG) | acc ≥ 70%; ≥ baseline + 20 pp |
| L3-C | Reward-delay robustness (C3-LONG-D8) | acc ≥ 60%; ≥ sham + 15 pp |
| L3-D | Context vs recency (probe on C2 agents) | acc_first ≥ 60%; acc_first − acc_last ≥ 20 pp |
| L3-E | Mechanism: persistent activity required | acc(C2) − acc(C4-ABLATE) ≥ 20 pp |
| L3-F | Controls | sham ≤ 65% in every condition; acc(C1) − sham(C1) ≥ 25 pp |
| L3-G | Determinism | two runs, same seed set, byte-identical report |
| L3-H | Regression | L1 and L2 reproduce byte-identically; STARK-001..007 9/9; Phase-1 §K 5/5 |

Failures are reported as measured; criteria are never relaxed post-hoc.
Implementation defects found by the experiment are fixed by the smallest
justified change and the full protocol is re-run.

## 7. Reproducibility contract

One JSON report (`schema: STARK-L3-1`) recording config (per condition),
seeds, schedule generators' parameters, per-trial training and evaluation
logs (cue, choice, reward), probe logs, all weights, diagnostics, and every
criterion verdict. Two runs byte-identical. mt19937-only randomness; no
evaluation data in any training or hyperparameter decision.

## 8. Preregistered expectations (predictions, not guarantees)

From L1/L2 measurements and the dynamics analysis: C1 ≈ 0.9–1.0; C2 ≈ 0.7–1.0
(attractor makes retention largely length-insensitive until K ~ tau_m-scale
perturbations accumulate); C3 ≈ 0.6–0.9 (tau_e = 8 vs D = 8 leaves ≈ 37%
eligibility — L2 measured 0.78 at equivalent retention); C4-ABLATE ≈ 0.5
(chance); probe acc_first ≈ 0.65–0.85 (anti-kick ≤ 0.7 vs attractor +
inhibition −1.2). Distractor patterns carry no answer information by
construction.

## 9. Outcome (2026-10-23, protocol v1.1 as frozen above)

Executed unchanged; no parameter or criterion was altered after results.
Report: `work/dev_sequential_context_report_STARK-L3-1.json` (schema
STARK-L3-1). Pooled over 3 master seeds × 50 eval trials (n = 150), Wilson
95% CIs; probe = 50 trials/seed.

| # | Criterion | Threshold | Measured | Verdict |
|---|---|---|---|---|
| L3-A | Sequential learning (C1-SHORT) | acc ≥ 80%; ≥ base + 25 pp; per-cue ≥ 75% | 1.000 [0.975,1]; base 0.487; per-cue 1.00/1.00 | PASS |
| L3-B | Long-sequence (C2-LONG) | acc ≥ 70%; ≥ base + 20 pp | 1.000 [0.975,1]; base 0.513 | PASS |
| L3-C | Reward-delay (C3-LONG-D8) | acc ≥ 60%; ≥ sham + 15 pp | 1.000 [0.975,1]; sham 0.167 | PASS |
| L3-D | Context vs recency (probe C2) | acc_first ≥ 60%; margin ≥ 20 pp | acc_first 1.000, acc_last 0.000 | PASS |
| L3-E | Attractor required | acc(C2) − acc(C4) ≥ 20 pp | 1.000 − 0.567 = 0.433 | PASS |
| L3-F | Controls | sham ≤ 65% all; C1 gap ≥ 25 pp | shams 0.233/0.240/0.167/0.487; gap 0.767 | PASS |
| L3-G | Determinism | two runs byte-identical | `cmp` identical | PASS |
| L3-H | Regression | L1/L2 repro byte-identical; 9/9; §K 5/5 | all pass (see report) | PASS |

Mechanism diagnostics: SEQ-window aligned-side spikes trained 3.33 (K=4) /
11.60 (K=12, i.e. sustained ~2-step-cycle firing across the whole sequence)
vs 1.74 (ablation, encoding transients only) and 0.00 (frozen baseline).
Trained weights: correct paths potentiate to the 0.7 ceiling, wrong paths
suppressed (e.g. C2 seed 20261023: [0.700, 0.279, 0.386, 0.700], pair gap
0.368); training reward trend C2 0.60 → 1.00. Length effect
acc(C1) − acc(C2) = 0.000 (retention is length-insensitive over K = 4→12,
consistent with H1's attractor). Sham weight drift alone yields chance or
below-chance behavior (no accidental task learning). Baselines at chance
(0.487 / 0.513 / 0.513 / 0.507) with cue-independent distractor data —
no cue leakage.

Supporting internal mechanisms (H1/H2/H3): persistent activity on the action
neurons (attractor; causally required by L3-E and spike records) carries the
early cue across the distractor sequence; the pre-synaptic trace (tau_pre)
assigns cue-time credit and the eligibility trace (tau_e) bridges the
decision→reward gap (three-factor rule unchanged). Eligibility traces are
not claimed to constitute working memory.

Known limitations: toy 2-cue/2-action family only; attractor state is
architecturally supplied (self-excitation + WTA), not learned; ceiling-level
accuracy leaves little resolution to rank conditions by difficulty; C4's
ablation residual (0.567) shows weak non-attractor bias; WTA/synapse topology
is fixed. Next: context requiring a learned or parametrically richer memory
mechanism, e.g. multi-item sequences or distractor-pair bindings.
