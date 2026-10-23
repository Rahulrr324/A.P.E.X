# STARK-L9 — Continual Learning and Catastrophic Forgetting

**Version:** 1.0 (frozen 2026-10-23)
**Schema:** STARK-L9-1
**Baseline:** STARK-L8 commit 7875764 (PR #2 head)

## 1. Mission

Build and evaluate a continual-learning capability for APEX: learn a
sequence of new associations while retaining previously learned ones,
including when tasks share neural resources and produce overlapping
activity. This is a new capability milestone, not another candidate-count
increase.

## 2. Architecture audit (source-grounded)

The LRAgent (STARK-L6/L7/L8) has:
- **S→A plastic synapses** (3-factor STDP): the ONLY weights encoding the
  identity→response mapping π. `dw = eta_3f · m · e_`, clamped to
  [w_min, w_max] = [0.0, 0.7]. Per-identity row w[i][:].
- **Routing state v** stored in C→L synapse weights, updated by REINFORCE
  (β_route) during selection trials. v is per-context; φ maps context→channel.
- **Network::reset()** resets traces (x_, x_pre_, x_post_, e_) and eligibility
  gates but NOT weights — learned weights persist across trials/tasks.
- **Eligibility gates** (STARK-L5): on single-candidate trials, only the
  queried identity's S→A row accumulates eligibility; on selection trials,
  all gates are OFF (no mapping update).

**Key structural fact:** the S→A matrix is a SINGLE shared n_ids×n_ids
mapping. Each identity has ONE row. Two tasks with different π on the same
identity structurally cannot both be retained — the row can only point to
one response. This is the interference source.

## 3. Task sequence

- n_ids = 6, n_chan = 2, n_ctx = 2 (L8 configuration).
- **3 tasks**, each a full permutation π of 6 identities.
- **φ is identical across tasks** (shared routing; the context→channel
  mapping is fixed). Tasks differ ONLY in π.
- Task 1: π_1 = makeLRMapping(seed_T1, 6, 2).perm, φ = φ_1
- Task 2: π_2 = makeLRMapping(seed_T2, 6, 2).perm, φ = φ_1 (same φ)
- Task 3: π_3 = makeLRMapping(seed_T3, 6, 2).perm, φ = φ_1 (same φ)

All three π's are distinct full permutations → every identity is shared
with a conflicting mapping across tasks. This maximizes interference and
tests the structural limitation directly.

**Training budget per task** (L8 F1b+F2a protocol):
- Phase 1: 80 single-candidate trials/identity (mapping credit, gate ON
  for queried row only) = 480 trials.
- Phase 2: 40 selection trials/identity (policy update, gates OFF) = 240 trials.
- Total: 720 trials/task. Softmax T = 1/√N/2 (F2a fix).

**Evaluation** (learning disabled, 20 trials/identity = 120/task):
- After task 1: eval task 1 (acquisition).
- After task 2: eval task 1 (retention) + task 2 (acquisition).
- After task 3: eval task 1,2 (retention) + task 3 (acquisition).
- After save/reload: eval all 3 tasks (persistence).

## 4. Definitions

- **Acquisition (task T at step k):** eval accuracy on task T immediately
  after its training phase at step k.
- **Retention (task T at step k>k_T):** eval accuracy on task T after
  subsequently trained tasks.
- **Forgetting (task T):** acquisition(T) − retention(T at final step).
- **Final average:** mean eval accuracy across all 3 tasks after task 3.
- **Interference:** forgetting(task A after task B) for B > A.
- **Held-out:** fresh π' (different mapping, same φ), v reused, phase 1'
  trains new mapping. Tests whether routing v generalizes (L8 convention).
- **Weight-update mass:** intended (queried identity row) vs unintended
  (other rows) |Δw| per trial, averaged.

## 5. Arms

1. **SEQUENTIAL (LEARNED):** learn tasks 1→2→3 with no continual-learning
   intervention. Baseline; expected to show forgetting.
2. **REPLAY:** learn tasks 1→2→3, interleaving replay of old-task trials
   during new-task learning. Replay ratio: 1 old trial per 4 new trials.
   Replay uses old task's π and the shared φ; learning enabled.
3. **REPLAY-ABLATED:** same interleaving as REPLAY but learning disabled
   during replay trials (learning_enabled=false). Controls for the mere
   passage of trials; isolates replay's learning effect.
4. **CONSOLIDATION (v-freeze):** learn tasks 1→2→3; freeze the routing
   state v (no REINFORCE update) during new-task phase 2. Lightweight
   protection of shared routing. Tests whether v-updates contribute to
   mapping interference.
5. **FRESH-TRAINING:** train on ALL 3 tasks' trial data interleaved
   together (2160 trials) as an upper-bound reference. NOT a CL method;
   the shared S→A matrix cannot represent 3 conflicting π's, so this
   bounds what the architecture can achieve even with full data access.
6. **ORACLE:** ORACLE selection arm (driver selects via φ). Routing
   upper bound; the S→A mapping bottleneck remains.

All replay-buffer content is TRAINING experiences only (old task trials).
No held-out eval examples, answer keys, or future rewards enter training.

## 6. Metrics (per N/arm/seed)

1. Acquisition accuracy per task.
2. Retention accuracy per task at each subsequent step.
3. Forgetting per task (acquisition − final retention).
4. Final average accuracy across all tasks.
5. Interference matrix (forgetting of task A after task B).
6. Held-out generalization (fresh π', same φ).
7. Intended vs unintended weight-update mass.
8. Per-seed results (3 seeds) and learning curves (reward trend).

Reported per-task, NOT pooled — a high average must not conceal the
complete forgetting of one task.

## 7. Pass/fail criteria

- **L9-A (problem demonstrated):** SEQUENTIAL shows forgetting > 0 on at
  least one task (the CL problem exists).
- **L9-B (mechanism works):** REPLAY reduces mean forgetting vs SEQUENTIAL
  (positive CL benefit).
- **L9-C (ablation):** REPLAY-ABLATED forgetting ≥ REPLAY forgetting
  (replay's learning is what helps, not trial passage).
- **L9-D (upper bound):** FRESH-TRAINING final average ≥ SEQUENTIAL final
  average (full-data training is at least as good).
- **L9-E (persistence):** save/reload produces bit-identical state and
  identical eval choices.
- **L9-F (determinism):** two runs byte-identical.
- **L9-G (no regression):** full L1–L8 + STARK-001–007 + §K battery PASS
  (pre-existing failures tracked separately).
- **L9-H (honest limitation):** if REPLAY cannot retain conflicting tasks,
  report the structural limitation and the minimum architectural
  prerequisite (separate weight resources per task or generative replay).
  Do NOT claim success if retention stays at chance for conflicting tasks.

## 8. Persistence and lifecycle

- **Persistent:** S→A weights, routing state v, replay buffer (serialized
  trial schedules), consolidation metadata.
- **Reset between tasks:** eligibility traces, modulatory signal,
  external inputs, firing-rate estimates (via Network::reset()).
- **Round-trip:** serialize full agent state → fresh agent → load → eval
  on fixed sequence → choices identical.

## 9. Regression and integrity

- Preserve all L1–L8 source, reports, and failed experiments.
- Run L1–L8 + STARK-001–007 + §K battery.
- Track pre-existing failures (test_phase1_gates 19, test_phase1_affinity
  Windows compile) separately; verify at base 3870804.
- Do NOT alter M0/G7 thresholds, evaluator arithmetic, or acceptance status.
- Do NOT execute E3 or launch M0 campaign. Do NOT merge PR #2.

## 10. Report schema (STARK-L9-1)

- `work/dev_continual_learning_report_STARK-L9-1.json`
- `work/dev_continual_learning_report_STARK-L9-1_FINAL.md`
- Raw per-seed data in the JSON.

## 11. Seeds

- Master seeds (L8-compatible): 123456789, 218213831, 171473193.
- Task seeds: T1 = master, T2 = master+10007, T3 = master+20011.
- φ fixed from T1's seed (shared across tasks).
