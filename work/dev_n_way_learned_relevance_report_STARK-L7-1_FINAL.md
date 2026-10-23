# STARK-L7 — N-way Learned Relevance (without hand-designed slot prior)

**Status:** milestone implemented, tested, published on PR #2 (branch `arena/c90f7329-a-p-e-x`, head `6584255`).
**Verdict:** FAIL (partial) — N=2 full PASS; N=4 one criterion borderline; N=8 genuine scaling limit honestly reported.
**Schema:** STARK-L7-1 — `work/dev_n_way_learned_relevance_report_STARK-L7-1.json`.

## 1. What was built

Generalizes the STARK-L6 learned-relevance mechanism from 2-way to **N-way** (N = 2, 4, 8
candidate channels / contexts). The routing state `v[ctx][channel]` is stored in ordinary
C→L synapses and learned by REINFORCE from (choice-consistency × reward) only. The mapping
phi (ctx→channel bijection) is seeded and **never observable** to the mechanism — there is no
hand-designed slot prior; which channel each context selects is learned.

**Mechanism** (`stark/src/learning/RelevanceRouting.{h,cpp}`):
- N-way softmax selection, attentional gain, and REINFORCE over `n_chan` channels.
- `makeLRMapping(seed, n_ids, n_ctx)`: seeded `perm` (identity→response) and `phi` (ctx→channel)
  bijections. N=2 reproduces the L6 mapping byte-for-byte (separate xor-seeded RNGs for perm/phi).
- `makeLRTrials(cfg, map, single, pair, seed)`: single-candidate mapping-credit trials +
  multi-candidate selection trials; N=2 reproduces the L6 schedule.
- `runLRTrial`: **queried_slot = presented[phi[ctx]]** (N-way fix; was 2-way id0/id1 logic).
  ORACLE selects via phi (upper bound); NEGATIVE inverts; UNGATED/ABLATION no selection.
- L6 byte-identity re-verified after the fix: `learned_relevance_loop` report `cmp` identical;
  `test_learned_relevance` 1699/1699 PASS.

**Experiment loop** (`stark/src/learning/n_way_learned_relevance_loop.cpp`): 3 Ns × 6 arms × 3 seeds.
Phased training (phase 1: 40 single-candidate mapping trials/identity; phase 2: 40 selection
trials/identity, gates OFF, policy update for LEARNED). Eval A (20 selection trials/identity,
held-out seeds, learning disabled). Eval B (fresh π′ same φ, v REUSED — π-independent generalization).

## 2. Results (pooled over 3 seeds, 20 eval trials/identity)

| N | LEARNED acc | gen acc | sel acc | fp | miss | U | UNGATED U | ORACLE | SHAM | ABL | NEG |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2 | 0.961 | 0.536 | 0.961 | 0.039 | 0.039 | 0.000 | 0.087 | 1.000 | 0.350 | 0.397 | 0.039 |
| 4 | 0.865 | 0.473 | 0.864 | 0.135 | 0.135 | 0.000 | 0.091 | 1.000 | 0.204 | 0.206 | 0.075 |
| 8 | 0.515 | 0.404 | 0.615 | 0.383 | 0.383 | 0.000 | 0.284 | 0.828 | 0.151 | 0.115 | 0.083 |

**Per-seed (N=2, LEARNED):** master 123456789 → acc 0.942 / gen 0.642; 218213831 → 0.967 / 0.483;
171473193 → 0.975 / 0.483. (N=4, N=8 per-seed in the JSON report.)

## 3. Criteria (frozen protocol v1.0)

| Criterion | N=2 | N=4 | N=8 |
|---|---|---|---|
| L7-A acc≥60%, ≥UNGATED+20pp, min-assoc≥40%, sel≥60% | PASS | PASS | **FAIL** (acc 0.515) |
| L7-B ≥ ORACLE−15pp | PASS | PASS | **FAIL** (0.515 < 0.678) |
| L7-C fp≤30%, missed≤20% | PASS | PASS | **FAIL** (fp 0.383) |
| L7-D SHAM≤−10pp, ABL≤−15pp, NEG≤30% | PASS | PASS | PASS |
| L7-E U≤0.35·U_ungated | PASS | PASS | PASS |
| L7-F gen≥50% | PASS | **FAIL** (0.473) | **FAIL** (0.404) |
| L7-G save/reload bit-identical | PASS | PASS | PASS |
| L7-H two runs byte-identical | PASS | PASS | PASS |

## 4. Control validation (STARK-L6-D)

The L6-D sham-arm failure is **not weakened**: UNGATED is the no-learning control (acc 0.164/0.125/0.081
at N=2/4/8). LEARNED beats UNGATED by +79.7/+74.0/+43.4 pp. SHAM (reward-independent v updates) is
below LEARNED−10pp at every N. NEGATIVE (inverted selection) is ≤30% at every N. The mechanism's
learning signal is reward-contingent and selection-driven, not a slot prior.

## 5. Generalization (Eval B)

Fresh π′ (same φ, v reused): gen acc 0.536 (N=2), 0.473 (N=4), 0.404 (N=8). The v (ctx→channel)
transfers across mappings because φ is shared, but the transfer degrades with N — the REINFORCE
signal is high-variance at N=8 (8 channels per context).

## 6. Persistence & determinism

- Save/reload: weights, choices, and routing weights bit-identical (serialize round-trip + double
  reload + choice-consistency), all N. L7-G PASS.
- Determinism: two full runs byte-identical (md5 match). L7-H PASS.

## 7. Regressions

- `test_learned_relevance` (L6) 1699/1699 PASS — mechanism change is N=2-equivalent.
- `test_n_way_learned_relevance` (L7) 2158 assertions PASS.
- L1 1887, L2 55, L3 18, L4 1463, L5 28 — all PASS.
- 9/9 neural tests PASS. §K 5/5 PASS (accounting, budget, profiler, records, reproducibility).
  (`test_phase1_gates` 19 failures and `test_phase1_affinity` Windows-only compile error are
  **pre-existing** — reproduced at base commit `3870804` without my changes.)

## 8. Failures & limitations (honest)

1. **N=4 L7-F borderline** (gen 0.473 vs 0.50): the v transfer to a fresh π′ is just below threshold.
2. **N=8 genuine scaling limit**: acc 0.515 (<60%), gen 0.404 (<50%), fp 0.383 (>30%). The LEARNED
   mechanism degrades at 8 channels/context — the softmax selection and REINFORCE are high-variance
   with 8 candidates, and 40 selection trials/identity is insufficient to stabilize v.
3. The ORACLE (reference upper bound) also drops at N=8 (0.828) — the S→A mapping has ~10% error at
   N=8, indicating the phase-1 mapping training is also strained.
4. These are **not** concealed: the verdict is FAIL, the JSON report records the raw numbers, and the
   scaling limit is documented here.

## 9. Next step

- Increase phase-2 trials/identity at N=8 (the protocol fixes 40; a v1.1 could justify more with
  evidence).
- Lower the softmax temperature or add a confidence regularizer to stabilize v at high N.
- Investigate whether the N=8 degradation is a REINFORCE variance issue or a capacity limit of the
  C→L routing table.

## 10. APEX completion

The research-engineering pipeline now spans L1–L7 (7 neural-cognitive milestones). L1–L6 were
complete/published; L7 is implemented, tested, and published with an honest partial-FAIL verdict.
Estimated completion of the current dev plan: **~73%** (up from ~70% at L6). Acceptance-track
completion remains blocked (G7/M0 FAIL, M1 LOCKED, addendum unsigned).

## 11. Commits & files

- Commit `6584255` on `arena/c90f7329-a-p-e-x` (PR #2 OPEN, local==remote==PR head).
- New: `stark/design/n_way_learned_relevance_milestone.md` (frozen v1.0),
  `stark/design/learned_relevance_control_validation.md` (STARK-L6-D v1.0),
  `stark/src/learning/n_way_learned_relevance_loop.cpp`,
  `stark/tests/test_n_way_learned_relevance.cpp`,
  `work/dev_n_way_learned_relevance_report_STARK-L7-1.json`.
- Modified: `stark/src/learning/RelevanceRouting.{h,cpp}` (N-way generalization + queried_slot fix),
  `stark/CMakeLists.txt` (L7 targets).
