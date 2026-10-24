# STARK-L10.2 — Frozen Protocol v1.1 (specification ratification)

**Version:** 1.1
**Status at registration:** **PROPOSED — NOT IN FORCE.**
This document is registered so that its hash is fixed *before* any evaluation
runs. It becomes the governing protocol for L10-E/L10-F **only** if the
repository owner records an approval decision (see §9). Until then every result
produced under it is a **provisional diagnostic**, and the frozen L10 criteria
(protocol v1.0) remain the only official ones.

**Authority:** the frozen L10 criteria live in
`stark/design/context_conditioned_memory_milestone.md` §8. That document
contains **no delegation clause**: nothing authorises an autonomous agent, a
tool, or a report to amend a success criterion. Amendment authority therefore
rests with the repository owner (`Rahulrr324`), recorded in this repository in
the established form of an Owner Decision Record under `stark/reports/`
(precedent: `stark/reports/G7_OPTION1_OWNER_DECISION.md`, 2026-10-08).

**Supersedes:** nothing. Protocol v1.0 remains authoritative for L10-E and
L10-F and is not edited by this document.

---

## 1. Three immutable evidence categories

| Category | Location | Status |
|---|---|---|
| **H1 — frozen L10 results** | `work/l10_raw/final_run/`, `determinism/`, `l9_reproduction/`, `protocol_v1.0_engineering_run/`, `work/dev_context_conditioned_memory_report_STARK-L10-1.{md,json}` | **immutable**; md5 `b38736bb…`, `17beb41e…`, `a00b62b3…` |
| **H2 — L10.1 corrected diagnostics** | `work/l10_raw/control_validation_20261025/`, `work/L10_1_CONTROL_VALIDATION.{md,json}` | **immutable**; 275 hashes verified |
| **N — L10.2 v1.1 results** | `work/l10_raw/spec_ratification_20261026/` | **new**; never merged into H1/H2 |

No L10.2 result may overwrite, recompute or replace anything in H1 or H2.
L10-E and L10-F are quoted from H1 in every table that reports them.

## 2. Amendment proposals (exact text)

### A-1 — sealing experiment (L10-F)

**Existing requirement (protocol v1.0, §8):**
> `L10-F | NO-SEAL mean forgetting > CCM mean forgetting`

**Demonstrated incompatibility.** The training stream is
`makeLRTrials(80 single/identity)` (= 480 single-candidate trials) followed by
`makeLRTrials(0, 40/identity)` (= 240 multi-candidate trials), and
`commit_trials = 480`. The single-candidate set and the forced commitment window
are therefore **the same 480 trials**. Mapping credit requires
`single && writable`, and during a forced trial the selected bank is the active
bank by construction, so the seal predicate never binds. Measured opportunity
count = 0 on every seed and both arms (L10.1 §B.2). The criterion is
unsatisfiable under v1.0 for *any* implementation of sealing.

**Proposed change (smallest that makes the criterion meaningful):** keep the
criterion's decision rule (unsealed forgets more than sealed) but state the
protocol it applies to:

> **L10-F2.** Run `SEAL-PAIR`, a protocol identical to v1.0 except
> `commit_trials = 240` (half the frozen window). The arm pair differs **only**
> in `cfg.seal_superseded`; seeds, permutations, cue stream, initialisation,
> training budget, probe schedule and evaluation are identical. The criterion is
> satisfied iff, on **each** of the three frozen masters:
> 1. sealing opportunities (`single && selected bank != active bank`) > 0;
> 2. sealed-arm mean forgetting ≤ 0.10;
> 3. unsealed-arm mean forgetting ≥ sealed-arm mean forgetting + 0.10;
> 4. total |ΔW| written into sealed banks in the sealed arm = 0.
>
> Arms that fail (1) are INVALID, not PASS or FAIL.

The 0.10 band is the L10-A forgetting band, reused rather than invented; the
margin is the same 0.10. Both are declared before the run.

### A-2 — context criterion (L10-E)

**Existing requirement (protocol v1.0, §8):**
> `L10-E | shuffled-cue mean accuracy ≤ 0.40 and context-off mean ≤ 0.40`

**Demonstrated incompatibility.** With the cue withheld, all router scores are
0, the softmax is uniform and the masked argmax returns the lowest-index
allocated bank (bank 0 = task 0). Measured context-off accuracy therefore equals
the permutation-determined quantity
`A(t) = |{q : π₀(q) = π_t(q)}| / 6`, which for the frozen masters is
0.5000 / 0.4444 / 0.3333 (pooled **0.425926**), matching measurement to 7e-08.
The bound 0.40 is below the floor of the *task distribution*: no implementation
that answers when the cue is removed can satisfy it. The two halves of the
compound criterion behave differently: shuffled-cue (0.132407) passes; only the
context-off half is unsatisfiable.

**Proposed change:**

> **L10-E3.** L10-E is replaced by three separate requirements, all of which must
> hold on each of the three frozen masters:
> - **E3a (no hidden context channel):** `|pooled context-off accuracy − pooled
>   analytic floor A| ≤ 0.02`.
> - **E3b (context is causally load-bearing):** per-task margin
>   `M(t) = accuracy(correct cue) − accuracy(cue off) ≥ 0.60` on at least two of
>   three tasks (this is L10-E2's first half, retained unchanged).
> - **E3c (memory intact without context):** in the per-bank forced sweep, the
>   diagonal (bank *k* answering task *k* with the cue withheld) is ≥ 0.99 for
>   every allocated bank.
>
> The original context-off number and threshold are **preserved and reported**
> in the historical record (`0.425926 > 0.40`, FAIL under v1.0). The forced-bank
> sweep is a *memory* measurement and is never reported as context-off
> performance.

### A-3 — control separation

**Existing requirements (protocol v1.0, §5/§8):** `L10-G | K2-STRESS worse than
CCM`; FROZEN-ROUTER is a control arm with no criterion of its own.

**Demonstrated confound.** K2-STRESS's capacity-exhaustion branch both reuses a
bank *and* sets every bank `ACTIVE` (`reuse_unseals = true`), so the arm changes
capacity and write protection together. FROZEN-ROUTER's published record is
field-for-field identical to CONTEXT-OFF because both select bank 0; the two
controls therefore cannot be distinguished from the numbers as published.

**Proposed change (no threshold change):**
> **L10-G2.** The capacity arm runs with `--reuse-seal 0`: at exhaustion only the
> reused bank becomes active; every other bank stays SEALED. The decision rule is
> **unchanged** from L10-G (K2 worse than CCM on forgetting *or* final average).
> **L10-R1 (informational, no criterion).** FROZEN-ROUTER is reported as four
> separate quantities — routing accuracy, fallback share, accuracy on trials
> where the selected bank is the task's bank, accuracy on trials where it is not
> — alongside CONTEXT-OFF, never merged with it.
> **L10-S1 (informational, no criterion).** A sealing stress arm (K = 3,
> sealing toggled, 20 % declared cue corruption) is reported separately from the
> primary sealing comparison.

## 3. Arms

Every arm is 3 tasks unless stated. "Frozen configuration" means: 6 identities,
2 channels, 12 cue features (4 per task signature), 4 training pairs + 2 held-out
pairs per task, 80 single-candidate + 40 multi-candidate trials per identity
(720 per task), 20 probe trials per bank, `theta_alloc = 0.5`,
`explore_eps = 0.2`, `beta_route_bank = 0.5`, `router_T = 0.5`,
global reward baseline rate 0.02, evaluation 20 multi-candidate trials per
identity (120 per task) with learning off and snapshot/restore.

| ID | Name | Configuration | Difference under test | Criterion |
|---|---|---|---|---|
| R0 | `CCM` | frozen configuration, K=3, sealing ON | — (reference) | existing L10-A…D |
| R1 | `SEAL-PAIR-240` | as R0 but `commit_trials = 240`; pair differs only in `seal_superseded` | write protection | **L10-F2** |
| R2 | `SEAL-PAIR-60` | as R1 with `commit_trials = 60` (sensitivity) | write protection | direction only |
| R3 | `SEAL-STRESS` | R1 config + 20 % declared cue corruption during learning | mis-routing under sealing | informational (L10-S1) |
| R4 | `CONTEXT-OFF` | R0, cue zeroed at evaluation | context absence | **L10-E3a/E3b** |
| R5 | `CTX-SWEEP` | R0, cue zeroed, each allocated bank forced in turn | stored memory per bank | **L10-E3c** |
| R6 | `K2-CAPACITY` | K=2, 3 tasks, sealing ON, `--reuse-seal 0` | capacity only | **L10-G2** |
| R7 | `FROZEN-ROUTER` | R0, router never updated (all scores 0 → lowest allocated bank) | learned routing | informational (L10-R1) |
| R8 | `SEQ-L9` | 1 bank, no cue, no probe, L9 evaluation order | baseline parity | unchanged |

## 4. Seeds and matched-pair rules

- **Primary (criterion-bearing):** `123456789`, `218213831`, `171473193`
  (L8/L9/L10 masters).
- **Exploratory (no criterion):** `1`, `2`, `7`, `42`.
- Task seeds `master + {0, 10007, 20011}`; training-schedule seeds
  `master + k*1000` and `+1` for phase 2; cue assignment `master + 6001 + k`;
  probe `master + 6100 + k`; evaluation `master + 5001 + k`; held-out
  `master + 8001 + k`. All exactly as protocol v1.0.
- **Matched-pair rule:** within a pair, the two arms consume *the same* RNG
  streams for everything except the intervention. The mis-route decision stream
  is seeded by `(master, task)` only and never by the arm flag; verified in
  L10.1 and re-verified here by checking that pre-divergence trial rows match.
- **Divergence rule:** after the first executed-vs-blocked write the arms
  legitimately diverge (different bank content ⇒ different later routing). Any
  comparison must therefore be reported with the opportunity counters, never as
  "identical except the flag".

## 5. Metrics

Per arm, per seed, per task, plus pooled (mean over the three masters):

- acquisition; final retention; forgetting (`acquisition − final retention`);
  mean forgetting; final average;
- routing accuracy at evaluation (share of evaluation trials whose selected bank
  is the task's bank);
- conditional task accuracy: on trials where the selected bank **is** the task's
  bank, and on trials where it is **not**;
- fallback share per task (distribution of selected banks);
- context-off accuracy per task (the v1.0 definition, unchanged);
- per-bank forced context-off accuracy (memory, not routing);
- sealing telemetry: opportunities, blocked writes, executed writes,
  total |ΔW| written into non-active banks;
- unintended update mass (bank-level), as in v1.0.

Definitions:
`A(t) = |{q : π₀(q) = π_t(q)}| / 6`, `pooled floor = mean_t A(t)`,
`excess = measured pooled context-off − pooled floor`,
`M(t) = acquisition(t) − context_off(t)`.

**Context-off is defined exactly as in v1.0**: all `n_feat` cue inputs driven at
0.0, standard 20-trials-per-identity multi-candidate evaluation, routing by the
masked argmax (no exploration). No other change.

**Sealing opportunity** = a learning trial with `single == true` whose selected
bank differs from the active bank. L10-F2 requires this count > 0.

## 6. Decision rules

| Criterion | Rule | Status if unmet |
|---|---|---|
| L10-F2 | §2 A-1 conditions 1–4 on all three masters (R1) | FAIL (or INVALID if opportunities = 0) |
| L10-E3a | pooled excess ≤ 0.02 (R4) | FAIL |
| L10-E3b | margin ≥ 0.60 on ≥ 2 of 3 tasks, each master (R4) | FAIL |
| L10-E3c | diagonal ≥ 0.99 for every allocated bank (R5) | FAIL |
| L10-G2 | K2 strictly worse than CCM on forgetting **or** final average (R6 vs R0) | FAIL |
| L10-R1, L10-S1 | reported, no criterion | never PASS/FAIL |
| Historical L10-E, L10-F | re-quoted from H1 exactly | **remain FAILED** |

A criterion is **PASS only if the registered run produces the supporting
output**. No criterion may be satisfied by an L10.1 diagnostic, by a
post-registration arm, or by an exploratory seed.

## 7. Expected outcomes and failure conditions

Pre-declared before the run:

1. R1 sealed: mean forgetting 0.00; unsealed: ≥ 0.10 (L10.1 measured 0.000 vs
   0.451). Expectation, not a criterion: if the effect were absent, L10-F2
   would FAIL and that would be the finding.
2. R2 shows the same direction with a larger effect (L10.1: 0.000 vs 0.533).
3. R3 shows a smaller gap (L10.1: 0.481 vs 0.564) because the active bank is
   corrupted by the same mis-routing.
4. R4 pooled context-off = 0.425926 ± 1e-6, i.e. excess ≈ 0 → E3a PASS.
5. R5 diagonal = 1.000 → E3c PASS.
6. R6 (capacity, without the seal confound) is still worse than CCM.
7. R7 routing accuracy ≈ 1/3 with ≥ 99 % of selections landing on bank 0.

**Failure conditions that invalidate a run (reported as INVALID, not FAIL):**
zero opportunities in R1/R2; any arm failing to build; non-deterministic
results across the two registered repetitions; a hash mismatch against this
protocol; fewer than three masters completed.

**Post-registration deviations:** any change to this document after the
registration commit is a new version (v1.1.x) recorded in §10 with its
motivation, the run id it preceded, and an explicit deviation statement.

## 8. Execution and artifacts

```bash
cd stark
CORE="src/learning/ContextConditionedMemory.cpp src/learning/RelevanceRouting.cpp \
      src/neural/NeuralCell.cpp src/neural/Synapse.cpp src/neural/Network.cpp"
g++ -O2 -std=c++17 -Isrc -o harness src/learning/l10_validation_harness.cpp $CORE
./harness --mode tasks --out DIR --seeds 123456789,218213831,171473193 --commit 240 --seal 1 --tag _sealON
./harness --mode tasks --out DIR --seeds 123456789,218213831,171473193 --commit 240 --seal 0 --tag _sealOFF
# R2: --commit 60   R3: --commit 240 --misroute 0.20   R5: --ctxperbank
# R6: --tasks 3 --banks 2 --reuse-seal 0   R7: --bank-mode frozen
```

Artifacts: `work/l10_raw/spec_ratification_20261026/{R0..R8}/` with
`metrics_*.csv`, `sealing_*.csv`, `trials_*.csv.gz`, `ctxperbank_*.csv`, a
second full repetition for determinism, the independent recomputation script and
its output, the regression logs, and `MANIFEST.md` (sha256 of every file).
`null` is used for unmeasured values; a missing measurement is never written
as 0.

## 9. Approval record (to be completed by the repository owner)

| Field | Value |
|---|---|
| Authority | repository owner (`Rahulrr324`) |
| Decision requested on | A-1 (→ L10-F2), A-2 (→ L10-E3), A-3 (→ L10-G2, L10-R1, L10-S1) |
| Decision | **PENDING** |
| Date | — |
| Approved protocol version | — |
| Recorded in | — |

Until this table is completed by the owner, this protocol is **PROPOSED**, and
any run made under it is labelled *provisional diagnostic* in every artifact and
report. L10-E and L10-F remain **FAILED** in the official record regardless of
what the provisional run shows.

## 10. Version log

- **v1.1** — 2026-10-26. Initial registration. Written before any L10.2 run;
  thresholds derived from the frozen design's own bands (L10-A's 0.10) or from
  the analytic floor, not tuned to L10.1 measurements. Acknowledged as
  **post-hoc relative to the L10 failures** — the amendments were proposed after
  seeing why the original criteria could not be met, which is precisely why they
  require owner ratification rather than agent decision.
