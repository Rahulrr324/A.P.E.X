# N-Way Learning Recovery Milestone (STARK-L8) — versioned diagnostic protocol

Version: 1.0 — **protocol frozen before implementation** (2026-10-23).
This is a DIAGNOSTIC milestone. It does not alter the L7 success criteria
(§6 of n_way_learned_relevance_milestone.md v1.0) or the L7 verdict (FAIL,
N=8). It decomposes the L7 N=8 failure into measurable failure modes and
tests the smallest justified fixes. The L7 v1.0 verdict stands as measured.

## 0. Starting point (reproduced, not assumed)

L7 baseline (commit `75a039a`, re-verified 2026-10-23, two runs byte-identical):

| N | LEARNED acc | gen | sel | fp | ORACLE | SHAM | NEG |
|---|---|---|---|---|---|---|---|
| 2 | 0.961 | 0.536 | 0.961 | 0.039 | 1.000 | 0.350 | 0.039 |
| 4 | 0.865 | 0.473 | 0.864 | 0.135 | 1.000 | 0.204 | 0.075 |
| 8 | 0.515 | 0.404 | 0.615 | 0.383 | 0.828 | 0.151 | 0.083 |

The L7 preregistered expectation was ORACLE ≈ 1.00 at all N. At N=8 the
oracle is 0.828 — the oracle itself is weak. This is the central diagnostic
question: a weak oracle and a weak learned arm point to a SHARED bottleneck
(mapping learning), not a routing-only failure.

## 1. Hypotheses and falsifiable tests

Five failure modes are distinguished. Each has a falsifiable test using only
observable quantities (no hidden labels, no φ access by the learned arm).

**H1 — Mapping-learning failure:** the S→A weights (identity→response) are
not trained reliably. *Test:* the ORACLE arm's choice accuracy. The oracle
selects the correct channel via φ (sel_slot = queried_slot always); its
choice accuracy therefore equals the S→A mapping accuracy. If ORACLE < 1.0,
the mapping is a bottleneck. Falsified if ORACLE ≈ 1.0 at all N.

**H2 — Routing failure:** mapping knowledge exists, but the learned policy
v selects the wrong candidate. *Test:* the LEARNED sel accuracy
P(sel_slot == queried_slot). Falsified if sel ≈ ORACLE's selection (which is
1.0 by construction) — i.e. if sel ≈ 1.0.

**H3 — Actuator/task failure:** correct selection does not reliably produce
the correct response. *Test:* P(choice correct | sel_slot == queried_slot).
The oracle conditions on sel == queried always; its accuracy is this
conditional. A separate conditional for the learned arm:
P(choice correct | sel_slot == queried_slot) measured on LEARNED trials where
the selection happened to be correct. Falsified if this ≈ 1.0.

**H4 — Credit-assignment failure:** rewards do not adequately distinguish
the responsible decisions. *Test:* the learning curve — phase-2 mean reward
(first 20 vs last 20 trials) and the v convergence (final |v| vs clamp).
Falsified if the reward trend is strongly positive and v saturates near the
clamp at the correct channel.

**H5 — Evaluation artifact:** training and evaluation differ invalidly.
*Test:* compare the trial schedules (presented sets, distractor sets, noise
streams, seeds) between the training phase and Eval A/B. Falsified if the
schedules are equivalent up to the seed offset (as in L7).

## 2. Diagnostic decomposition (measured per N ∈ {2,4,8})

For each N, each arm, each seed, the following are measured:

1. **Context-to-candidate mapping accuracy** = ORACLE choice accuracy
   (oracle selects correctly; choice = S→A response). Also reported as the
   fraction of identities whose S→A row argmax equals perm[identity].
2. **Candidate-selection accuracy** = P(sel_slot == queried_slot) for LEARNED.
3. **Selection accuracy conditional on mapping correct** = P(sel == queried
   | S→A row for queried is correct) — requires the mapping-correct flag.
4. **End-to-end task accuracy** = P(choice == perm[queried]) for LEARNED.
5. **Conditional actuator accuracy** = P(choice correct | sel == queried)
   and P(choice correct | sel != queried) for LEARNED.
6. **Oracle performance** on the same schedules/actuators (H1 test).
7. **Held-out generalization** = Eval B (fresh π′, same φ, v reused) accuracy.
8. **FP / missed relevance rates** (Eval A, LEARNED).
9. **Intended / unintended update mass** (phase 1: I = Σ|Δw| on the queried
   row, U = Σ|Δw| elsewhere; phase 2: gates off → 0 by construction).
10. **Learning curves**: phase-1 and phase-2 mean reward (first 20 vs last 20);
    final v[ctx][channel] vs φ (correlation, argmax agreement).
11. **Per-seed variation**: all metrics reported per seed, not only pooled.

Conditional results are reported alongside pooled results. A high oracle
score with low learned accuracy indicates a routing bottleneck; a weak oracle
indicates a mapping bottleneck. The two are not conflated.

## 3. Oracle/learned information equivalence (checked before causal claims)

The oracle and learned arms must receive equivalent observable task
information and differ ONLY in the intended relevance signal (the selection
s*). Verified by inspecting `runLRTrial`:
- Both arms see the same context, candidates, distractors, noise, and reward.
- The oracle sets sel = queried_slot (φ-driven); the learned samples s* ~
  softmax(v). The attentional gain and eligibility gates follow s* in both.
- The S→A weights, actuators, and reward computation are identical.
- φ is never passed to the learned arm; the oracle uses φ only for the
  reference selection (upper bound).

If this equivalence does not hold, the experimental comparison is corrected
in a separately versioned protocol BEFORE causal claims. (L8 v1.0 verifies
equivalence holds; no correction needed.)

## 4. Fixes (tested only after the decomposition)

The smallest justified changes, each as a separate named variant, with the
unchanged L7 baseline, oracle, sham, ablation, and negative controls:

- **F1 — Mapping-training strengthening**: increase phase-1 trials per
  identity (e.g. 40 → 80) OR strengthen the S→A credit signal. Justified only
  if H1 (oracle < 1.0) is confirmed.
- **F2 — Routing exploration / anti-saturation**: lower the softmax temperature
  OR raise v_clamp to allow sharper policies at high N. Justified only if H2
  (sel < oracle) is confirmed AND the v does not saturate at the clamp.
- **F3 — Phased combination**: train mapping and routing jointly after each
  has separately converged. Justified if both H1 and H2 are confirmed.
- **F4 — Interference reduction**: reduce distractor contamination of the S→A
  rows. Justified if the unintended update mass (U) is high at N=8.
- **F5 — Actuator correction**: only if H3 (conditional actuator accuracy <
  1.0 given correct selection) is confirmed AND the oracle weakness (H1) is
   ruled out.

No hidden labels, future rewards, hard-coded answer tables, or task-driver-
supplied relevance gates may be used by the learned arm. Seeds are not
cherry-picked; fixes are evaluated on the same 3 preregistered masters.

## 5. Acceptance criteria (diagnostic milestone)

The milestone demonstrates:
- A reproduced and explained L7 baseline (this document §0 + the diagnostic
  decomposition).
- A source-supported diagnosis of the dominant failure mode (H1–H5 tests).
- If a fix is tested: improvement at N=8 across the preregistered seeds, not
  one lucky run, AND improved held-out generalization (not just training
  accuracy).
- Oracle/learned comparisons with equivalent task information (§3).
- No regression in L1–L7 behavior, persistence, or determinism.
- Preserved raw data, negative results, and reproducible records.

If no candidate fix resolves the N=8 degradation, L8 is reported as a
diagnostic milestone and the next necessary experiment is identified.
Success is NOT declared if N=8 training accuracy rises while generalization
remains poor.

## 6. Reproducibility contract

JSON report `work/dev_n_way_learning_recovery_report_STARK-L8-1.json`
(schema STARK-L8-1): per-N, per-arm, per-seed diagnostic blocks with the 11
metrics above, the H1–H5 test outcomes, the fix-variant comparisons, and the
criteria verdicts. Separate raw evidence in
`work/dev_n_way_learning_recovery_raw_STARK-L8-1.json`. Two runs
byte-identical. mt19937-only randomness.

## 7. Constraints (carried forward)

- Do not alter L7 v1.0 criteria or verdict.
- Do not run the prohibited E3 acceptance experiment or launch an M0 campaign.
- Do not merge PR #2 or create another PR.
- Preserve M0=FAIL, M1=LOCKED, addendum UNSIGNED.
- Track the pre-existing `test_phase1_gates` failures separately (verified at
  base commit `3870804`; not caused by L7/L8 changes).
