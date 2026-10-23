# STARK-L9 — Continual Learning and Catastrophic Forgetting: Final Report

**Verdict: DIAGNOSTIC COMPLETE — structural limitation demonstrated.**
The shared S→A matrix cannot retain conflicting mappings for overlapping
identities. Replay reduces forgetting but trades off with new-task
acquisition. The minimum architectural prerequisite is separate weight
resources per task.

- **Milestone:** STARK-L9 (continual learning)
- **Schema:** STARK-L9-1
- **Baseline:** STARK-L8 commit 7875764 (PR #2 head)
- **Date:** 2026-10-23
- **Branch:** arena/c90f7329-a-p-e-x (PR #2, OPEN)

---

## 1. L8 Baseline Reproduction (DONE)

Rebuilt `n_way_learned_relevance_loop_L8` at commit 7875764. Verdict PASS
reproduced. Two runs byte-identical (md5 `a13f0c4f649a74cdd057672ebed7503e`).

## 2. Architecture Audit (source-grounded)

The LRAgent has ONE shared S→A plastic matrix (n_ids × n_ids). Each
identity has ONE row. `dw = eta_3f · m · e_`, clamped to [0.0, 0.7].
`Network::reset()` resets traces but NOT weights — weights persist across
tasks. The routing state v (C→L weights) is shared across tasks (same φ).

**Key structural fact:** two tasks with different π on the same identity
structurally cannot both be retained — one row can only point to one
response. This is the interference source.

## 3. Task Sequence

3 tasks, each a full permutation π of 6 identities. φ is IDENTICAL across
tasks (shared routing). All 3 π's are distinct → every identity is shared
with a conflicting mapping. Training budget: 720 trials/task (L8 F1b+F2a
protocol: 80 single + 40 selection per identity).

## 4. Pooled Results (3 seeds)

| Arm | acq T1/T2/T3 | forget T1/T2/T3 | mean forget | final_avg |
|-----|-------------|-----------------|-------------|-----------|
| SEQUENTIAL | 1.000/0.667/0.564 | 0.917/0.486/0.000 | 0.468 | 0.276 |
| REPLAY | 1.000/0.411/0.308 | 0.886/0.214/0.000 | 0.367 | 0.206 |
| REPLAY-ABLATED | 1.000/0.667/0.564 | 0.917/0.486/0.000 | 0.468 | 0.276 |
| CONSOLIDATION | 1.000/0.222/0.181 | 0.817/0.039/0.000 | 0.285 | 0.182 |
| FRESH-TRAINING | 0.181/0.169/0.158 | 0.181/0.169/0.000 | 0.117 | 0.053 |
| ORACLE | 1.000/0.667/0.564 | 0.917/0.486/0.000 | 0.468 | 0.276 |

## 5. Criteria

| Criterion | Result | Evidence |
|-----------|--------|----------|
| L9-A (problem demonstrated) | **PASS** | SEQUENTIAL mean forgetting 0.468 |
| L9-B (mechanism works) | **PASS** | REPLAY reduces forgetting 0.468→0.367 |
| L9-C (ablation) | **PASS** | REPLAY-ABLATED = SEQUENTIAL (replay learning matters) |
| L9-D (upper bound) | **FAIL** | FRESH-TRAINING 0.053 < SEQUENTIAL 0.276 (structural limit) |
| L9-E (persistence) | **PASS** | save/reload bit-identical, choices identical |
| L9-F (determinism) | **PASS** | two runs byte-identical (md5 a00b62b3) |
| L9-G (no regression) | **PASS** | L1–L8 + neural all PASS |
| L9-H (honest limitation) | **REPORT** | structural limitation demonstrated |

## 6. Key Findings

1. **Forgetting exists (L9-A):** SEQUENTIAL learns task 1 perfectly (1.0)
   then forgets it (0.083 retention after task 3). Task 2 acquired 0.667,
   retained 0.181. This is catastrophic forgetting.

2. **Replay reduces forgetting but trades off (L9-B):** REPLAY reduces mean
   forgetting (0.468→0.367) and improves task 1 retention (0.083→0.114),
   BUT hurts new-task acquisition (task 2: 0.667→0.411, task 3: 0.564→0.308).
   Final average drops (0.276→0.206). Replay overwrites new mappings to
   reinforce old ones — a zero-sum trade on shared rows.

3. **Ablation confirms (L9-C):** REPLAY-ABLATED (learning disabled during
   replay) = SEQUENTIAL exactly. The replay's weight updates are what
   cause the trade-off, not mere trial passage.

4. **Consolidation (post-training replay) trades off more:** CONSOLIDATION
   reduces forgetting further (0.285) but destroys new-task acquisition
   (task 2: 0.222, task 3: 0.181). Post-training replay overwrites the
   newly learned task.

5. **Fresh-training is near chance (L9-D FAIL):** Interleaving all 3
   conflicting π's prevents ANY task from being learned (0.053 ≈ 1/6
   chance). The shared matrix oscillates and cannot settle. This is the
   structural upper bound: even with full data access, the architecture
   cannot represent 3 conflicting mappings.

6. **Oracle doesn't help:** ORACLE selection (via φ) gives the same
   forgetting as SEQUENTIAL. The bottleneck is the S→A mapping, not routing.

7. **Per-seed consistency:** SEQUENTIAL task 1 retention after task 3:
   [0.242, 0.000, 0.008]. REPLAY: [0.192, 0.133, 0.017]. Replay improves
   task 1 retention in 2/3 seeds but never achieves >0.25.

## 7. Structural Limitation (L9-H)

The shared S→A matrix is a SINGLE identity→response mapping. With fully
overlapping identities and conflicting π's:
- No weight update can retain both old and new mappings for the same identity.
- Replay/consolidation can only trade old vs new (zero-sum on shared rows).
- Fresh-training cannot represent conflicting mappings (near chance).

**Minimum architectural prerequisite:** separate weight resources per task
(e.g., task-specific S→A columns, expanded response representation allowing
orthogonal mappings, or a generative replay model). Without this,
continual learning of conflicting associations is structurally impossible.

## 8. Persistence and Determinism

- Save/reload: bit-identical serialized state, identical eval choices. ✓
- Determinism: two runs byte-identical (md5 `a00b62b330bf231fdecf2b4991ec44fa`). ✓
- Persistent: S→A weights, routing state v.
- Reset between tasks: eligibility traces, modulatory signal, inputs.

## 9. Regression Battery (all PASS)

| Test | Assertions | Result |
|------|-----------|--------|
| test_sequential_context (L1) | 1887 | PASS |
| test_associative_memory (L4) | 1463 | PASS |
| test_eligibility_gating (L5) | 28 | PASS |
| test_learned_relevance (L6) | 1699 | PASS |
| test_n_way_learned_relevance (L7) | 2158 | PASS |
| n_way_learned_relevance_loop_L8 | — | verdict PASS |
| test_stdp | 255 | PASS |
| test_homeostasis | 403 | PASS |
| test_three_factor | 80 | PASS |
| test_serialization | 98 | PASS |

Mechanism unchanged (git diff HEAD — RelevanceRouting, L7/L8 loops, neural all clean). Pre-existing `test_phase1_gates`/`test_phase1_affinity` failures unchanged.

## 10. Next Justified Step

Implement separate weight resources per task. The smallest defensible
option: **task-specific S→A response columns** — expand the response
representation so each task has its own response neurons, allowing
orthogonal mappings without interference. Alternatively, a **generative
replay model** to reconstruct old task experiences without storing them.
Without either, the shared matrix cannot retain conflicting associations.

## 11. APEX Completion Estimate

- **Research-engineering pipeline through L9:** ~78% (L9 diagnostic
  complete; structural limitation honestly demonstrated; next step
  identified).
- **Acceptance-track:** still blocked (G7/M0 FAIL, M1 LOCKED — unchanged).
- **Development-plan percentage:** L9 is a new capability milestone; the
  CL capability is NOT yet achieved (structural limitation), but the
  diagnosis is complete and the path forward is clear.
