# STARK-L10.4 — Official L10-K1 Evaluation Protocol

**Version:** 1.0 (registered)
**Schema:** STARK-L10-4
**Date:** 2026-10-24
**Status:** **registered before any official primary-seed measurement.**
**Acceptance specification under evaluation:** `stark/design/context_conditioned_memory_milestone.md`
**v1.7** (§8, criterion **L10-K1**).
**Owner decision authorising the criterion:** `stark/reports/L10_3_ACCEPTANCE_DECISION.md`
§5 — Option B, repository owner, 2026-10-24.
**Prior milestone:** L10.3 (`work/L10_3_CONTEXT_CONTRIBUTION.md`), whose L10-K1
numbers were **exploratory** and are **not** the results reported here.

---

## 1. Scope

This protocol registers the **first official evaluation of L10-K1**. It
executes the criterion exactly as ratified, on a fresh run, with a frozen
protocol hash committed before the run, independent recomputation, the full
regression battery, and a mechanical disposition.

It does **not** re-open L10-E. L10-E remains FAILED at 0.425926 under its
unchanged 0.40 threshold; nothing in this protocol can change that.

It does **not** start L11 and introduces **no new mechanism**. The only source
difference from L10.3 is none at all: the evaluator is the same source tree,
rebuilt, and its binary hash is recorded in §9 so the official run is tied to an
exact executable.

## 2. Exact revisions

| Item | Value |
|---|---|
| Repository | `Rahulrr324/A.P.E.X` |
| Branch | `validation/l10-4-official-evaluation` (created from L10.3 head) |
| Starting commit | `082856cd0ae3d3fce32a81ea60791d7ffd24274f` (verified L10.3 head) |
| Acceptance specification | `stark/design/context_conditioned_memory_milestone.md` **v1.7** |
| Evaluator source | `stark/src/learning/l10_validation_harness.cpp` + CCM engine, at the commit that carries this protocol |
| Binary | built by the command in §9; sha256 recorded in the registration commit message and in the evidence manifest |

## 3. Primary seeds (fixed, unchanged from L10/L10.1/L10.2/L10.3)

`123456789`, `218213831`, `171473193` — the L8/L9 evaluation masters.

Task seeds `master + {0, 10007, 20011}`; evaluation seed `master + 5001 + t`;
cue seed `master + 6001 + k`; probe seed `master + 6100 + k`; held-out seed
`master + 8001 + t`; shuffle/routing seeds as implemented in the harness.
No seed is selected, dropped or replaced after the run.

Exploratory seeds (`1`, `2`, `7`, `42`) are **not** part of this evaluation and
if re-run appear only in a clearly separated exploratory section.

## 4. Arms and matched controls

Training configuration is the frozen L10 configuration: `K = 3` banks, sealing
on, `commit_trials = 480`, 720 training trials per task step, 3 tasks presented
in order 0, 1, 2. **Every condition below is evaluated on the same trained
agent and the same 120-trial schedule (6 identities × 20), with
`snapshot → evaluate → restore`, so no measurement can perturb a result.**

| ID | Condition | `eval_kind` | Cue | Bank selection | Role in L10-K1 |
|---|---|---|---|---|---|
| K0 | correct | 0 | the task's own training cue | learned router (argmax) | numerator of CAA and CRA |
| K2 | off | 2 | **none** | learned router (argmax ⇒ bank 0) | retained L10-E measurement, reported; **not** part of L10-K1 |
| K7 | forced-bank sweep | — | **none** | bank `k` forced, `k = 0,1,2` | denominator of CAA (`A(k,t)`) |
| K1 | holdout | 1 | held-out cue pair of the same task | learned router | secondary diagnostic |
| K3 | shuffled | 3 | another task's cue (misleading) | learned router | secondary diagnostic |
| K5 | partial | 5 | one of the two features, alternating | learned router | secondary diagnostic |
| K6 | off-uniform | 6 | **none** | explicit uniform fallback, seeded | secondary diagnostic |

The **only** quantity that differs between K0 and K7 is the bank-selection rule
(and, for K7, the absence of the cue **by construction of the sweep**, which is
the point: `A(k,t)` is conditional bank competence). K2 and K6 differ only in the
fallback rule. Coverage differences are declared rather than hidden:
K7 varies the bank, so the attention/route dynamics are identical to K2 but the
retrieved bank is not.

**Forced-bank accuracy is never reported as context-off accuracy**, and the
`off` condition is never reported as a context-contribution measurement.

## 5. Metric definitions (transcribed from the ratified text; not re-derived)

Let `m` be a primary seed, `t ∈ {0,1,2}` a task, `K = 3`.

- `acc_correct(m,t)` — accuracy over the 120 `eval_kind 0` trials of task `t`.
- `A(m,k,t)` — accuracy over the 120 `eval_kind 2` trials of task `t` with bank
  `k` forced (the sweep), i.e. conditional bank competence.
- `acc_null(m,t) = (1/K) · Σ_{k=0}^{K−1} A(m,k,t)` — accuracy of a
  context-ignoring policy on this task draw.
- `CAA(m,t) = acc_correct(m,t) − acc_null(m,t)`.
- `R_correct(m,t) = (number of `eval_kind 0` trials of task `t` whose selected
  bank equals the task's bank) / 120`.
- `CRA(m,t) = R_correct(m,t) − 1/K`.
- `CAA_pooled(m) = (1/3) · Σ_t CAA(m,t)`; `CRA_pooled(m) = (1/3) · Σ_t CRA(m,t)`.
- Descriptive only: grand means over the 9 (seed, task) cells.

The task's bank is the bank allocated to that task during training as recorded in
the run's `task_bank` column; it is not inferred.

## 6. Denominators, trial counts, inclusion rules

- Exactly **120 trials** per (seed, task, condition); the schedule is
  `makeLRTrials(cfg, 0 single, 20 pair per identity)`, balanced over the 6
  identities (20 each), so the denominator of every accuracy is 120 and every
  identity contributes equally.
- A trial counts as **correct** iff `choice == perm(task)[queried]`.
- A trial counts as **routed to the task's bank** iff `bank == task_bank(m,t)`.
- **Inclusion rule:** only rows with `eval_kind` in `{0,1,2,3,5,6}` contribute to
  any evaluation statistic; `eval_kind = -1` rows are training and are excluded.
  The forced-bank sweep contributes through `ctxperbank_*.csv`.
- **No trial is excluded after the fact.** If a row is missing, the run is
  invalid (§11) rather than partially scored.

## 7. Missing, invalid or incomplete records

- An expected artifact that is absent ⇒ the arm is **INVALID**; the affected
  metric is reported as **`null`**, never as 0, and L10-K1 is **not** declared
  passed.
- A (seed, task, condition) cell with fewer than 120 trials ⇒ **INVALID**.
- A non-finite value ⇒ **INVALID**.
- A determinism mismatch (§8) ⇒ the run is **INVALID** and must be rerun; the
  invalid run's evidence is preserved.
- Reruns are permitted **only** for invalidity or for the registered determinism
  repetition. Every rerun is logged in the evidence manifest with its reason.
  No rerun may be triggered by an inconvenient value.

## 8. Determinism and save/load checks

1. **Byte-identical repetition.** The full primary run is executed twice into
   two directories; every emitted CSV must be byte-identical (15 artifacts).
2. **Non-perturbation of the retained L10-E result.** The official run's
   `metrics_*.csv` and `sealing_*.csv` must equal the L10.2 R0 evidence
   (`work/l10_raw/spec_ratification_20261024/R0/`) byte for byte, proving that
   the added diagnostic conditions change no registered number.
3. **Checkpoint resume.** `--mode restart --stage 0` then `--stage 1` in a
   separate process, all three seeds; the resumed final retention and bank map
   must match the uninterrupted run.
4. **Save/load.** The engine's `save_reload_state` / `save_reload_choices` flags
   must be true in every seed (they are emitted in the metrics row).

## 9. Build, run commands, artifacts

Working directory `stark/`, compiler `g++ 12.2.0`, flags `-O2 -std=c++17 -Isrc`:

```bash
g++ -O2 -std=c++17 -Isrc -o harness src/learning/l10_validation_harness.cpp \
    src/learning/ContextConditionedMemory.cpp src/learning/RelevanceRouting.cpp \
    src/neural/NeuralCell.cpp src/neural/Synapse.cpp src/neural/Network.cpp
sha256sum harness     # recorded in the manifest and in the report

S=123456789,218213831,171473193
./harness --mode tasks --out K1  --seeds $S --seal 1 --ctx-contribution --ctxperbank --tag _K1
./harness --mode tasks --out K1b --seeds $S --seal 1 --ctx-contribution --ctxperbank --tag _K1
./harness --mode tasks --out KX  --seeds 1,2,7,42 --seal 1 --ctx-contribution --ctxperbank --tag _K1x   # exploratory
./harness --mode perm  --seeds $S,1,2,7,42 > perm/perm.csv
```

Artifacts (new directory `work/l10_raw/official_evaluation_20261024/`):
`protocol/`, `K1/` (official), `K1b/` (determinism repeat), `KX/`
(exploratory, separated), `perm/`, `restart/`, `regression/`, `analysis/`,
and a sha256 `MANIFEST.md`. Historical evidence directories are **not** touched.

Manifest procedure: every file under the directory is hashed with sha256 and
listed; the deliverables and the changed sources are hashed in a second section;
the manifest itself is verified after writing.

## 10. L10-K1 pass/fail rules (mechanical)

Read literally from the ratified text — *"On every primary seed: (a) …"* — the
per-seed quantifier governs all three clauses. Registered evaluation:

For each primary seed `m ∈ {123456789, 218213831, 171473193}`:

- **(a)** `CAA_pooled(m) ≥ 0.40`
- **(b)** `CAA(m,t) ≥ 0.25` for at least **2 of the 3** tasks
- **(c)** `CRA_pooled(m) ≥ 0.50`

**L10-K1 = PASS** iff (a), (b) and (c) hold for **all three** seeds.

The grand pooled values (mean over the 9 cells) are reported descriptively. The
disposition is **not** taken from them. If the strict per-seed reading and the
grand-pooled reading ever disagree, the strict reading governs and the
disagreement is reported explicitly; this sentence is fixed at registration, so
the reading cannot be chosen after the fact.

## 11. Conditions that invalidate the run

- Binary hash ≠ the hash recorded at registration.
- Source tree dirty with respect to the registration commit at run time.
- Any missing/partial cell (§7).
- Determinism mismatch (§8.1) or mismatch with the retained L10-E artifacts (§8.2).
- Checkpoint-resume mismatch (§8.3).
- Any regression target failing (§12).
- A deviation from this protocol that is not recorded in a versioned entry
  **before** the official disposition is written.

## 12. Regression suite

Run from `stark/` (the documented working directory), exactly the target list
used since L10.1:

```bash
# 26 targets, one g++ invocation each, as in the L10.1/L10.2/L10.3 batteries
bash <battery script>   # content reproduced in work/l10_raw/official_evaluation_20261024/regression/
```

Required: all targets exit 0; assertion counts for
`test_context_conditioned_memory` (330), `test_l10_structural_audit` (357),
`test_l10_1_sealing` (276), `test_phase1_gates` (437, 0 failures) are recorded.
`test_phase1_affinity` cannot be built on Linux (`DWORD_PTR`) and is reported
**UNEXECUTED / UNKNOWN** — never as passed, and it is not fixed.

## 13. Hypotheses and expected outcomes

Exploratory L10.3 diagnostics (CAA 0.5799, CRA 0.6667) predict a pass. That
prediction is **not** evidence and carries no weight in the disposition; it is
recorded here so that a negative result cannot be described as surprising.

- **H-K1.1** — (a) holds on every seed.
- **H-K1.2** — (b) holds on every seed.
- **H-K1.3** — (c) holds on every seed.
- **Failure condition:** any of the three failing on any seed ⇒ L10-K1 FAILS
  and the report says so with the number.

## 14. Known limitations and unresolved questions (declared before the run)

1. **The anomalous forced-bank cell.** L10.3 reported one cell
   (`master 218213831, task 1, bank 2`) at 0.008333 where the permutation model
   predicts 0.0 — exactly one trial in 120. The hypothesis (a channel-attention
   mis-selection producing a coincidentally correct answer) is **not verified**;
   the existing trial rows do not record the selected channel slot, so they
   cannot resolve it. This protocol does **not** add instrumentation to the
   registered run: adding a field would change the artifact schema mid-stream.
   If the cell affects a threshold in this evaluation it must be reported; it is
   predicted to move that seed's `CAA` by ~0.0009, far below the 0.40 margin.
   A per-trial channel-slot field is proposed as a **separate** follow-up
   registration, not a change to this one.
2. Context selects a memory bank; it does not modulate retrieval within a bank.
   The criterion measures the former.
3. Cross-signature generalization is weak (L10.3: 0.5611 pooled, 0.0–1.0 per
   task) and misleading cues are destructive (0.1322). Neither is scored here.
4. The task family is finite and toy-scale (3 tasks, 6 identities, 12 features).
5. Passing L10-K1 would not establish general compositional intelligence or
   autonomous cognition, and would not make L10-E pass.
6. `acc_null` uses a measured matrix and inherits its ~0.2 % noise.

## 15. Version log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-24 | Registered before the official run: revisions, seeds, arms, definitions, denominators, invalid-run rules, determinism/regression requirements, mechanical pass/fail rules, limitations. |
