# Delayed-Reward Milestone (STARK-L2) — design and frozen experiment protocol

Version: 1.0 — **criteria and protocol frozen before implementation**
(2026-10-23). Implementation may not alter §4–§6; implementation-parameter
tuning within the stated config is allowed only where noted as configurable.

## 1. Goal and hypothesis

STARK-L1 (see `learning_loop_milestone.md`) showed reward-contingent learning
with reward delivered immediately after the decision window. L1 does **not**
establish temporal credit assignment: in L1 the modulator arrives one step
after the last eligibility accumulation, so eligibility is almost intact at
update time.

STARK-L2 asks: **does the existing STARK-006 three-factor mechanism assign
credit across a temporal gap between decision and reward, and does learning
degrade as that gap grows relative to the eligibility time constant tau_e?**

Mechanistic prediction (preregistered): eligibility decays as
`exp(-D / tau_e)` during a D-step silent delay, so the effective per-trial
update scales the same way. Behavioral prediction (preregistered from L1
measurements: gap 0.60 at full signal; honest eval ~74% at gap 0.10, ~100% at
gap 0.6): accuracy decreases with delay at fixed tau_e, and increasing tau_e
at a fixed long delay rescues learning. **These are predictions, not
guarantees.**

## 2. STARK-L1 audit (prerequisite verification, 2026-10-23)

Recomputed from `work/dev_learning_loop_report_STARK-L1-1.json` raw trials:
trained 100% (25/25 each cue), frozen baseline 44%, sham 30%; pair gap 0.6033
matches the reported 0.603269; cue balance 50/50 (train) and 25/25 (eval).
- **Sham control valid:** `reward_contingent=false` changes ONLY the modulator
  (m ≡ +1 vs task reward); schedules, seeds, init, architecture identical.
- **No train/eval leakage:** train schedule seed = master (20261023), eval =
  master+1 (20261024) — disjoint draws; evaluation runs with
  `learning_enabled=false` so no modulator is ever set and weights are frozen
  (report field `eval_weights_unchanged: true`).
- L1 passing does **not** prove general learning (2-cue discrimination only).

## 3. Task — delayed-reward two-cue discrimination

Identical to L1 except the trial timeline (decision is made BEFORE the reward
is known):

```
[cue window: cue_steps=12, cue drive + seeded noise]   <- decision from
                                                          spike counts here
[quiet delay: D steps, zero input, no modulator]        <- eligibility decays
[reward step: 1 step, m = reward]                       <- dw = eta * r * e(D)
[trial end: network state reset; weights persist]
```

- Cue 0 → correct action 0; cue 1 → correct action 1; reward +1 / −1.
- Decision ties broken by the seeded per-trial draw (never a fixed default).
- Delay steps are fully quiet (no noise): any residual post-decision spikes
  are deterministic; eligibility decays each step by `exp(-dt/tau_e)`.
- The delay occurs AFTER the decision, so delay cannot influence the choice;
  every condition shares identical cue-window dynamics and schedules.

## 4. Conditions and controls (frozen)

Paired design: ALL conditions use the same training schedule (seed
`master = 20261023`) and the same held-out evaluation schedule (seed
`master + 1 = 20261024`); 100 training / 50 evaluation trials, balanced cues.
dt = 1.0 step. L1 default agent config unchanged (eta_3f = 0.6, E = 0.05/0.02,
w_inh = −1.2, tau_pre/post = 6, w ∈ [0,1], w_init = 0.5).

| Condition | delay D | tau_e | D/tau_e | role |
|---|---|---|---|---|
| C-D0 | 0 | 8 | 0 | reference (= L1 protocol) |
| C-D4 | 4 | 8 | 0.5 | short delay |
| C-D8 | 8 | 8 | 1.0 | delay = trace constant |
| C-D16 | 16 | 8 | 2.0 | long delay (eligibility ≈ 13.5% at reward) |
| C-RESCUE | 16 | 32 | 0.5 | trace-constant rescue at the long delay |

Per condition: **trained** (THREEFACTOR, task reward), **sham** (identical,
modulator ≡ +1), and **frozen baseline** (PlasticityMode::NONE) evaluated on
the identical held-out schedule. (Sham and baseline cannot learn; they bound
drift and chance.)

## 5. Metrics (frozen)

- Primary: held-out accuracy per condition (trained / sham / baseline), with
  Wilson 95% confidence intervals (n = 50); per-cue accuracy and choice
  histograms (label-leak check).
- Mechanistic: final weights [w00, w01, w10, w11], pair gap
  (mean correct-pair − mean wrong-pair), per-condition training reward trend
  (first 20 vs last 20).
- Trend: OLS slope of trained accuracy vs D over {0, 4, 8, 16} at tau_e = 8
  (units: accuracy points per step).
- Consistency: (a) baseline accuracy must be delay-invariant (the decision
  precedes the delay; identical cue-window dynamics across conditions);
  (b) C-D0 must reproduce the L1 result exactly (same config/seed: accuracy
  1.000, weights [1.0, 0.322017, 0.471444, 1.0]).

## 6. Success criteria (frozen)

| # | Criterion | Threshold |
|---|---|---|
| L2-A | Delayed learning: acc(C-D4) | ≥ 80% **and** ≥ baseline + 25 pp |
| L2-B | Degradation with delay: acc(C-D0) − acc(C-D16) | ≥ 15 pp **and** OLS slope < 0 |
| L2-C | Trace-constant rescue: acc(C-RESCUE) − acc(C-D16) | ≥ 10 pp |
| L2-D | Controls: sham(D0), sham(D16) | each ≤ 65%; acc(C-D0) − sham(D0) ≥ 25 pp |
| L2-E | Determinism: two runs, same seed | byte-identical report |
| L2-F | Regression: L1 suite + STARK-001..007 + Phase-1 §K | all PASS, unchanged |
| L2-G | Consistency: C-D0 ≡ L1; baseline delay-invariant | exact match / identical accuracy across delays |

If a criterion fails: report the failure, analyze the mechanism (raw weights,
per-trial logs), and either make the smallest justified implementation
correction or run a labeled diagnostic — **never** relax a frozen threshold.

## 7. Reproducibility contract

One JSON report (`schema: STARK-L2-1`) recording: full config (per condition),
seeds, per-condition trial logs (training and evaluation, cue/choice/reward),
final weights for every agent, Wilson CIs, trend slope, control outcomes, and
all criterion verdicts. Two runs with the same seed must be byte-identical.
Deterministic mt19937 schedules only.

## 8. Explicit non-claims

No claim of general temporal-credit competence beyond this task family; no
claim about M0/Phase-1 acceptance (unchanged and blocked: G7 environmental,
M0 = FAIL, M1 = LOCKED). STARK-006 mechanism unchanged — L2 tests the
existing rule; no new learning rule is introduced.

## 9. Outcome (2026-10-23, post-implementation record)

Protocol exactly as frozen above (master seed 20261023). Measured (report
`work/dev_delayed_reward_report_STARK-L2-1.json`, regenerable with
`delayed_reward_loop --out <path>`):

| Condition | D | tau_e | trained acc [95% CI] | sham | baseline | pair gap |
|---|---|---|---|---|---|---|
| C-D0 | 0 | 8 | 1.00 [0.93, 1.00] | 0.30 | 0.44 | 0.603 |
| C-D4 | 4 | 8 | 1.00 [0.93, 1.00] | 0.30 | 0.44 | 0.483 |
| C-D8 | 8 | 8 | 1.00 [0.93, 1.00] | 0.50 | 0.44 | 0.505 |
| C-D16 | 16 | 8 | 0.78 [0.65, 0.87] | 0.34 | 0.44 | 0.094 |
| C-RESCUE | 16 | 32 | 1.00 [0.93, 1.00] | 0.50 | 0.44 | 0.510 |

| Criterion | Required | Measured | Verdict |
|---|---|---|---|
| L2-A delayed learning (D4) | ≥80%, ≥base+25 pp | 100%, +56 pp | PASS |
| L2-B degradation | Δ(D0−D16) ≥ 15 pp, slope < 0 | 22 pp, slope −0.0141/step | PASS |
| L2-C tau-rescue | ≥ +10 pp over C-D16 | +22 pp | PASS |
| L2-D controls | sham ≤65% at D0/D16; ≥+25 pp | 30%/34%; +70 pp | PASS |
| L2-E determinism | byte-identical | `cmp` clean | PASS |
| L2-F regression | all PASS | L1 55 asserts; STARK-001..007 9/9; §K 5/5 (265) | PASS |
| L2-G consistency | D0 ≡ L1; baseline delay-invariant | exact; identical across delays | PASS |

Mechanistic evidence: pair gap shrinks with delay and is restored by the
larger tau_e at the same D=16 — the eligibility time constant governs the
temporal credit window, as predicted by `exp(-D/tau_e)` decay. Sham weights
drifted to clamping (e.g. [1,1,1,1]) yet accuracy stayed at chance: weight
drift alone produces no task performance. Per-cue accuracy degrades evenly
(D16: 0.76/0.80) — no label leakage. Weight-level check (test suite): total
|Δw| over 25 trials = 0.875 at D=0 vs 0.151 at D=8.
