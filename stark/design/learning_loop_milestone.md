# Learning-Loop Milestone (STARK-L1) — design and frozen success criteria

Status: **criteria frozen before implementation** (2026-10-23). Implementation
must not alter the criteria below; tuning of implementation parameters
(learning rates, episode counts within the stated ranges) is allowed.

## 1. Why this milestone (code audit, 2026-10-23)

Present and tested in the tree:

- STARK-001 `NeuralCell` — leaky integrator + adaptive threshold
  (`test_neuron`, `test_params`).
- STARK-002/004 `Synapse` — pair-based STDP with traces and clamps
  (`test_synapse`, `test_stdp`).
- STARK-003 `Network` — deterministic fixed-step sparse network with delays,
  spike routing, external input broadcast (`test_network`, `test_integration`).
- STARK-005 homeostasis — multiplicative scaling (`test_homeostasis`).
- STARK-006 **three-factor modulator-gated plasticity** — eligibility trace
  `e`, update `dw = eta_3f * m(t) * e`, plus full serialization
  (`test_three_factor`, `test_serialization`).
- STARK-007 `Experiment`/`Recorder` — deterministic schedule harness and
  trajectory recorder.

Missing: any task-level agent loop — no toy environment, no action selection,
no reward-driven learning evaluation, no learned-vs-baseline evidence.

The smallest useful cognitive capability that does not depend on formal M0
acceptance is therefore a **reproducible reward-modulated learning loop**.
Plain STDP is deliberately NOT used as the learning claim: STDP alone is
unsupervised and cannot credit an action with a delayed reward. The
technically valid mechanism already in the tree is STARK-006 three-factor
plasticity with the modulator `m(t)` carrying the reward signal (the "reward
modulation" extension anticipated by `learning_decision.md`).

## 2. Task — two-cue, two-action discrimination (toy environment)

- Environment presents one cue per trial: cue 0 or cue 1 (balanced, seeded
  shuffle). Correct action: cue 0 → action 0, cue 1 → action 1.
- Agent: 4 neurons — S0, S1 (sensory), A0, A1 (action) — with 4 plastic
  synapses S_i → A_j (`THREEFACTOR` mode). Revision 2 (during implementation,
  criteria unchanged): 2 fixed non-plastic lateral inhibitory synapses
  A0→A1, A1→A0 (`PlasticityMode::NONE`, weight `w_inh`) provide winner-take-all
  competition so the chosen action dominates the trial's spiking and
  eligibility concentrates on the chosen cue→action pathway. Revision note:
  the first prototype (no lateral inhibition) co-potentiated both action
  pathways — spike-count decisions and timing-based eligibility were
  misaligned — and failed C1/C4; the diagnostic and fix are recorded in the
  milestone report.
- Trial: cue drive to the cued sensory neuron for a fixed decision window
  (with seeded background noise on action neurons for exploration); the
  action with the most spikes in the window is the choice (tie: seeded draw).
- Outcome: reward r = +1 for the correct action, −1 otherwise, delivered as
  the modulator for exactly one timestep: `m = r` ⇒ `dw = eta * r * e`.
  Eligibility `e` accumulated during the cue window credits only the active
  cue→chosen-action pathway (silent neurons contribute no eligibility).
- Between trials the network state resets; weights persist.

## 3. Baseline and controls

- **Frozen baseline:** identical architecture, identical initial weights,
  identical cue schedule and identical noise streams, with plasticity disabled
  (`PlasticityMode::NONE`). Evaluated on the same held-out trials (paired
  comparison). Expected to stay near chance (50%).
- **Sham negative control:** identical protocol, but the modulator is +1 on
  every training trial instead of the task reward (`reward_contingent=false`);
  task reward is still measured by correctness. Expected NOT to learn —
  demonstrates that reward contingency, not weight drift, drives the effect.
- **Decision ties** (equal counts/first-spike, or no spikes) are broken by a
  seeded per-trial draw — never a fixed default action.

## 4. Reproducibility contract

- All randomness from recorded `std::mt19937` seeds (master seed default
  20261023): cue schedule, training noise, evaluation noise. The full
  trial-by-trial schedules are generated once and replayed to both agents.
- The experiment writes one JSON report (`schema: STARK-L1-1`) containing
  config, seeds, per-trial training log, evaluation rewards for both agents,
  final weights, and the criteria verdicts.
- Two runs with the same seed must produce **byte-identical** reports.

## 5. Success criteria (frozen)

Let `acc_T` = trained agent accuracy on the 50 held-out evaluation trials,
`acc_B` = frozen baseline accuracy on the identical trials. Chance = 50%.

| # | Criterion | Threshold |
|---|---|---|
| C1 | Task learning: `acc_T` | ≥ 80% |
| C2 | Improvement over baseline: `acc_T − acc_B` | ≥ 25 percentage points |
| C3 | Learning trend: mean reward last 20 training trials > mean reward first 20 | strictly greater |
| C4 | Mechanism: mean(correct-pair weights) − mean(wrong-pair weights) after training | > 0.10 (on the weight scale) |
| C5 | Determinism: two runs, same seed | byte-identical report |
| C6 | Regression: all existing STARK-001..007 tests + Phase-1 §K tests | all PASS, unchanged |

Training: 100 trials, balanced cues. Evaluation: 50 trials, balanced cues,
modulator never set (m ≡ 0 makes weight change impossible by construction).

## 6. Explicit non-claims

This milestone does not claim: general task learning, biological realism,
sample efficiency, or anything about M0/Phase-1 acceptance (unchanged: G7
blocker stands, M0 = FAIL, M1 = LOCKED). It is a focused, deterministic
demonstration that the existing three-factor mechanism produces
reward-contingent behavioral improvement on a toy task, recorded so the claim
can be independently reproduced.

## 7. Outcome (2026-10-23, post-implementation record)

Protocol as frozen above, master seed 20261023. Measured (report
`learning_loop_report_STARK-L1-1.json`, regenerable with
`learning_loop --out <path>`):

| Criterion | Required | Measured | Verdict |
|---|---|---|---|
| C1 trained eval accuracy | ≥ 80% | **100%** (25/25 each cue) | PASS |
| C2 minus baseline | ≥ 25 pp | **56 pp** (baseline 44%, near chance) | PASS |
| C3 first20 → last20 reward | increase | **−0.10 → +1.00** | PASS |
| C4 correct−wrong pair gap | > 0.10 | **0.603** (w = [1.00, 0.32, 0.47, 1.00]) | PASS |
| C5 two runs same seed | byte-identical | `cmp` clean | PASS |
| C6 regressions | all PASS | STARK-001..007 9/9 binaries; §K 5/5 (265 assertions) | PASS |

Sham negative control (modulator ≡ +1): eval accuracy **30%** — no task
learning without reward contingency. Frozen baseline (plasticity off): 44%.
Evaluation blocks leave weights unchanged (m ≡ 0 by construction).
