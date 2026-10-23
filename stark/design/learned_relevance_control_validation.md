# Learned-Relevance Control Validation (STARK-L6-D) — versioned protocol

Version: 1.0 — frozen 2026-10-23, BEFORE the revised control study runs.
This protocol exists to resolve the L6-D question scientifically. It does
NOT modify the frozen L6 protocol, does NOT overwrite L6 results, and does
NOT relabel the L6-D FAIL verdict. Any new criterion introduced here is
separately versioned and justified.

## 1. The question

STARK-L6 (protocol `learned_relevance_milestone.md` v1.0/v1.1) reported
L6-D FAIL: the reward-independent sham arm reached pooled accuracy 0.725,
exceeding the frozen threshold 0.55. The L6 outcome analysis argued the
sham was a valid null (its routing state uncorrelated with φ; 4/6 context
rows matched = chance; per-seed accuracy consistent with a random
2-decision policy) and that the frozen threshold was miscalibrated. That
argument was based on 3 seeds — insufficient to establish a null
distribution. This protocol supplies the missing statistical evidence.

## 2. Null hypothesis and expected distribution

**H0 (sham null):** with reward-independent routing updates (m drawn from
the seeded `sham_u` stream, never from the task reward), the routing state
v is uncorrelated with the context→candidate mapping φ. Selection is
then uniform over the N candidates, and per-seed task accuracy is
distributed around chance 1/N with variance driven by the random policy's
luck on the finite evaluation set.

**Independent statistical unit:** the SEED. A policy state (the full
routing state v) is one unit; trials within a seed share the policy and
their outcomes are correlated through it (selection accuracy is a
property of the policy, not of independent trials). Pooled accuracy over
trials within a seed is a single observation; the seed is the sample.
Reporting per-seed accuracies (with Wilson 95% CIs) and summarizing over
seeds avoids treating correlated trials as independent samples.

## 3. Study design

Task and schedules: the STARK-L6 v1.1 task and phased training (mapping-
credit single-candidate trials; selection trials with routing updates),
N ∈ {2, 4}, masters {20261023, 20261024, 20261025} for the positive and
shuffled-cue arms; the sham null uses 12 independent seeds
{20261023, …, 20261034} (the first three shared with the positive control
for direct comparability; the remaining nine extend the null).

Arms:

| Arm | routing updates | modulator | role |
|---|---|---|---|
| SHAM | REINFORCE | reward-independent (sham_u) | null: H0 |
| LEARNED | REINFORCE | task reward | positive control (H1) |
| SHUFFLED-CUE | REINFORCE | task reward, but π shuffled per trial | mapping-consistency control |

SHUFFLED-CUE: the identity→response mapping is re-drawn per trial (no
consistent association exists). Rows cannot learn a consistent mapping;
accuracy must remain at chance — the mechanism's success depends on
consistent mappings, not on an artifact.

## 4. Metrics and uncertainty

Per arm × seed: evaluation accuracy (Wilson 95% CI); per-context selection
accuracy P(s* = φ(ctx)). Summary: per-seed accuracy list; mean, SD; the
null distribution's 5th/50th/95th percentiles; pooled accuracy with CI
over all sham trials (reported with the seed-unit caveat). Runtime
overhead relative to L6 (same build flags, same machine).

## 5. Predeclared decision rules (before running)

- **R1 (null centered):** the sham null mean at each N lies within
  [1/N − 0.10, 1/N + 0.10]. If violated, the sham control is contaminated
  (investigate before any conclusion).
- **R2 (reward dependence):** LEARNED pooled accuracy ≥ the sham null's
  95th percentile at each N. This is the reward-dependent vs
  reward-independent separation.
- **R3 (mapping dependence):** SHUFFLED-CUE accuracy lies within the sham
  null's [5th, 95th] percentile range at each N (no consistent mapping →
  no learning).
- **R4 (unit discipline):** all summaries report per-seed values; no
  trial-level independence is assumed.

## 6. What this protocol does and does not do

Does: establish the sham null distribution with enough independent seeds;
test the L6 outcome analysis's claim; provide the statistical basis for
any future recalibration request. Does NOT: change L6-D's FAIL verdict;
change the L6 report; change any frozen L6 criterion; substitute for the
L6 protocol. Any recalibration of L6-D requires separate owner
authorization; this study supplies evidence, not a verdict change.

## 7. Reproducibility

One JSON report (`schema: STARK-L6D-1`) at
`work/dev_learned_relevance_control_validation_STARK-L6D-1.json`:
per-arm per-seed blocks, the null percentiles, the decision-rule
verdicts, runtime. Deterministic (mt19937-only); two runs byte-identical.
