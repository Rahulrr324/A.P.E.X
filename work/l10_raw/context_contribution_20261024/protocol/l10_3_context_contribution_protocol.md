# STARK-L10.3 — Context Contribution Protocol

**Version:** 1.0 (registered)
**Schema:** STARK-L10-3
**Date:** 2026-10-24
**Status:** diagnostics are **exploratory** (no pass/fail authority). The single
criterion proposed here (**L10-K1**) is **submitted for owner approval** and is
**not** applied to any result in this milestone.
**Parent protocol:** `stark/design/l10_2_protocol_v1_1.md` v1.1.1
**Governing acceptance document:** `stark/design/context_conditioned_memory_milestone.md`
§8 (frozen criteria) — unchanged by this protocol.

---

## 1. Purpose and scope

L10.2 established that the mechanism works (L10-F2, L10-G2 pass) and that the
original **L10-E** criterion still fails at 0.425926 > 0.40. This protocol does
three things and nothing else:

1. it fixes, **before any measurement**, the definitions of a set of
   context-contribution **diagnostics** that separate the six properties that
   L10-E conflates (availability, routing, conditional bank competence,
   contribution, fallback behaviour, robustness);
2. it pre-declares the **analysis formulas, seeds, trial counts, hypotheses and
   failure conditions** used to evaluate them;
3. it defines **L10-K1**, a criterion that measures context *contribution* on a
   scale that is not degenerate. L10-K1 is **proposed only**. It becomes
   official only if the repository owner ratifies it (see
   `stark/reports/L10_3_ACCEPTANCE_DECISION.md`, Options A–C).

This protocol does **not** change L10-E, its threshold, its metric, the task
distribution, or any historical result. L10-E remains FAILED under v1.0.

Not in scope: L11, new mechanisms, tuning the mechanism to make any number
smaller or larger. No source change in this milestone can alter a registered
number; the only engine change is an additional *evaluation* mode that is
unreachable unless the harness is invoked with `--ctx-contribution`.

## 2. What the original L10-E context-off half actually measures

L10-E reads *"shuffled-cue mean accuracy ≤ 0.40 **and** context-off mean ≤ 0.40"*.

Measured behaviour of the current system when the cue is withheld
(`CM_OFF`: the cue feature vector is empty):

- `bankScores()` sums router weights over the *active features of the cue*.
  With an empty cue every score is exactly `0.0`.
- Evaluation selection is `ccPreferredBank()`, i.e. an argmax with a strict `>`
  comparison over the selectable banks, so the tie resolves to the **lowest
  allocated bank**, which is bank 0 for every master.
- Bank 0 answers with its own stored mapping `π₀`, which is correct for task `t`
  exactly when `π₀[i] = π_t[i]` for the queried identity `i`.

With `n_ids = 6`, equal query frequencies (20 repetitions per identity, 120
trials per task), and permutations drawn uniformly by `makeVTask(master, t)`:

    acc_off(t) = A(0, t) = (1/6) · #{ i : π₀[i] = π_t[i] }        (t = 1, 2)
    acc_off(0) = 1

i.e. the context-off statistic is the **fixed-point agreement between the
fallback bank's permutation and the task's permutation** — a property of the
random task draw, not of whether the system uses context. §4 quantifies this.

## 3. Definitions (fixed at registration)

`n_ids = 6`, `T = 3` tasks, `K = 3` banks, `n_feat = 12` (4 features per task).

**Condition set** (all evaluated on the same trained agent, same master, same
evaluation seed `master + 5001 + t`, same 120-trial schedule, snapshot → restore
around every evaluation so measurement cannot perturb learning):

| ID | Trial tag | `eval_kind` | Cue presented | Bank selection |
|---|---|---|---|---|
| K0 | correct | 0 | the task's own training cue | learned router (argmax) |
| K1 | holdout | 1 | a held-out cue pair of the same task | learned router |
| K2 | off | 2 | **none** | learned router (argmax ⇒ bank 0) |
| K3 | shuffled | 3 | another task's training cue (misleading) | learned router |
| K4 | cross | 4 | one feature from each of two tasks (ambiguous) | learned router |
| K5 | partial | 5 | **one** of the two features of the correct cue, alternating | learned router |
| K6 | off-uniform | 6 | **none** | **explicit uniform fallback** over allocated banks, seeded draw |
| K7 | forced-bank sweep | — | none | bank `k` forced, `k = 0…K−1` |

K7 is the pre-existing L10.1 D-CTX-3 sweep (`--ctxperbank`). It measures
**conditional bank competence** and is never reported as context-off accuracy.

**Matched controls.** Every condition uses the identical trained state, the
identical evaluation schedule and the identical number of trials (120 per task);
the only quantity that changes between conditions is the cue vector (and, for
K6, the fallback rule). K2 and K6 differ **only** in the fallback rule; K0 and
K5 differ **only** in how many cue features are present.

**Derived quantities** (per seed, per task, then pooled):

- `A(k, t)` — accuracy of bank `k` answering task `t`, measured by K7.
- `acc_null(t) = (1/K) · Σ_k A(k, t)` — the accuracy of a **context-ignoring
  policy** that picks a bank uniformly on this particular task draw. This is the
  correct null: it uses the *actual* stored mappings, so it contains no
  permutation luck.
- **CAA(t)** (context accuracy advantage) `= acc_correct(t) − acc_null(t)`.
- **CAA_pooled** `= mean over seeds of (mean over t of CAA(t))` (equal weights;
  every (seed, task) cell contributes the same 120 trials, so this equals the
  trial-weighted mean).
- **CRA(t)** (context routing advantage) `= R_correct(t) − 1/K`, where
  `R_correct(t)` is the fraction of correct-cue trials whose selected bank is
  the task's bank. Under the null "context carries no routing information",
  `E[R] = 1/K`, so `E[CRA] = 0`.
- **CRA_pooled** `= mean over seeds of (mean over t of CRA(t))`.
- **Degradation profile** `D(c) = acc_correct,pooled − acc_c(c),pooled` for
  `c ∈ {holdout, partial, shuffled, cross, off, off_uniform}`.
- **Fallback descriptors**: modal bank under K2, its share, and the bank-choice
  histogram under K6.

## 4. Null-model derivation (fixed at registration)

Take `π₀` as the reference (relabelling identities makes this WLOG). For each
`t ≠ 0`, the number of fixed points `a_t = #{i : π₀[i] = π_t[i]}` of a uniform
random permutation of 6 elements has the derangement distribution

    P(a = k) = C(6,k)·D(6−k)/6!  →  [265, 264, 135, 40, 15, 0, 1] / 720

so `E[a] = 1` and therefore

    E[acc_off(t)] = 1/6 · E[a] = 1/6,   E[acc_off(0)] = 1
    E[per-seed context-off mean] = (1 + 2/6)/3 = **4/9 = 0.4444**

Consequences, computed exhaustively from that distribution:

- the attainable range of the pooled context-off mean is **[1/3, 1]**;
- a system with a **perfect** router and the deterministic fallback passes the
  second half of L10-E (`pooled ≤ 0.40`) with probability **0.1512**;
- on a single seed it passes with probability **0.4054**.

The 0.40 threshold therefore sits only 0.067 above the theoretical floor of a
system that ignores context completely, and below the mean of a system that is
perfect apart from its fallback rule. **No mechanism change can make this
criterion measure context use.** This is the basis of the incompatibility
finding in `work/L10_3_CONTEXT_CONTRIBUTION.md` §5.

## 5. Proposed criterion (submitted, NOT applied)

**L10-K1 — Context Contribution.**

> On every primary seed, (a) `CAA_pooled ≥ 0.40`, (b) `CAA(t) ≥ 0.25` for at
> least two of the three tasks, and (c) `CRA_pooled ≥ 0.50`.

Threshold justification, fixed **before** the measurement:

- under the null (a system that ignores context) both statistics are 0 by
  construction, so the criterion cannot be passed without context use;
- the maximum attainable value is `1 − E[acc_null] = 5/9 = 0.5556` for CAA and
  `1 − 1/K = 0.6667` for CRA (perfect routing, random permutations);
- `0.40` is 72 % of the CAA headroom — deliberately far above the null and
  below the ceiling, and numerically identical to the failed L10-E threshold so
  that no reader can suspect a threshold was chosen to fit an outcome.

L10-K1 is reported as **proposed**. This protocol declares that no result in
this milestone can be labelled PASS/FAIL against L10-K1 until the owner
ratifies it; until then L10-K1 results are *diagnostic measurements*.

## 6. Seeds, trials, budgets

- Primary seeds (unchanged from L10/L10.1/L10.2): `123456789`, `218213831`,
  `171473193`. Task seeds `master + {0, 10007, 20011}`, eval seed
  `master + 5001 + t`, cue seed `master + 6001 + k`, probe `master + 6100 + k`,
  held-out `master + 8001 + t` — exactly as the frozen L10 protocol.
- Exploratory seeds, declared here and reported **separately**: `1`, `2`, `7`,
  `42`. They carry no criterion and cannot replace a primary result.
- Trials: 120 per (seed, task, condition); 6 identities × 20 repetitions.
- Training: unchanged frozen configuration (K=3, sealing on, `commit_trials =
  480`, 720 trials per task step). No hyperparameter was selected on any
  evaluation seed in this milestone.

## 7. Registered runs

All commands are run from the repository root with the binary described in §9.

```
# R-KC-primary  (3 primary seeds, all conditions + forced-bank sweep)
./harness --mode tasks --out OUT --seeds 123456789,218213831,171473193 \
          --seal 1 --ctx-contribution --ctxperbank --tag _KC

# R-KC-determinism  (byte-identical repeat of the same run into a second dir)
(identical command, --out OUT2)

# R-KC-exploratory  (declared extra seeds)
./harness --mode tasks --out OUT --seeds 1,2,7,42 \
          --seal 1 --ctx-contribution --ctxperbank --tag _KCx

# R-perm  (task permutations, input to the analytic null)
./harness --mode perm --seeds 123456789,218213831,171473193

# R-regress  (unflagged re-run; must reproduce the L10.2 R0 artifacts byte-for-byte)
./harness --mode tasks --out REG --seeds 123456789,218213831,171473193 --seal 1 --tag _R0
```

A single-seed smoke run (`--seeds 123456789 --ctx-contribution --tag _K`) was
executed **before registration** to validate the instrumentation (that the new
rows are emitted, that `eval_kind` 5/6 behave as specified, and that the
registered metrics CSV is unchanged). It is not part of the registered evidence
and no threshold in this protocol depends on it.

## 8. Hypotheses and failure conditions (fixed at registration)

| ID | Hypothesis | Failure condition |
|---|---|---|
| H1 | `CAA_pooled ≥ 0.40` on every primary seed | `CAA_pooled < 0.40` ⇒ context contribution not demonstrated |
| H2 | `CRA_pooled ≥ 0.50` on every primary seed | `< 0.50` ⇒ the router does not use context as claimed |
| H3 | `acc_correct ≥ acc_partial ≥ acc_off` (graceful degradation) | `acc_partial > acc_correct`, or `acc_partial < acc_off` ⇒ measurement leak |
| H4 | `abs(acc_off − acc_off_uniform) ≤ 0.15` pooled, both in `[1/3, 0.60]` | outside the band ⇒ the context-off number is a property of the fallback rule alone (this is the *expected* outcome; it is recorded, not "failed") |
| H5 | routing under K2 equals `1/K` exactly (deterministic bank-0 fallback); routing under K6 ≈ `1/K` | routing ≠ `1/K` under K2/K6 ⇒ task identity leaks into the fallback |
| H6 | the analytic `A(k,t) = agreement(π_k, π_t)/6` reproduces the measured K7 matrix | any cell deviating by more than 1 trial ⇒ readout imperfection to be explained, not rounded away |

A negative H1 is a **reportable result**, not a reason to alter the protocol.

## 9. Reproducibility, determinism, artifacts

Binary (built from the repository, no other changes):

```
g++ -O2 -std=c++17 -Isrc -o harness src/learning/l10_validation_harness.cpp \
    src/learning/ContextConditionedMemory.cpp src/learning/RelevanceRouting.cpp \
    src/neural/NeuralCell.cpp src/neural/Synapse.cpp src/neural/Network.cpp
```

- Determinism: the R-KC run is repeated into a second directory; every emitted
  CSV must be **byte-identical**.
- Non-perturbation: the R-KC run's `metrics_*.csv` must be byte-identical to
  the registered L10.2 `R0` metrics (adding read-only diagnostics may not change
  any registered number). The only permitted difference in the trial CSVs is
  the `trial`/`call` index columns, which shift because extra evaluation calls
  are interleaved; all substantive columns must match.
- Independent recomputation: every accuracy in the report is recomputed from
  the per-trial rows by a separate script that does not read the harness's
  aggregate columns.
- Save/load and checkpoint-resume: unchanged code paths, but re-checked (the
  engine gained one enum value).
- Regression: the canonical suite from `stark/`; `test_phase1_affinity` remains
  unexecuted (Win32-only, `DWORD_PTR`).

Artifacts: `work/l10_raw/context_contribution_20261024/` with
`protocol/`, `K0/` (primary run), `K0b/` (determinism repeat), `KX/`
(exploratory seeds), `perm/`, `regress/`, `analysis/`, `regression/`,
`restart/`, and a sha256 `MANIFEST.md`.

## 10. Version log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-24 | Registered before the R-KC run: definitions, null-model derivation, hypotheses, failure conditions, proposed L10-K1. |
