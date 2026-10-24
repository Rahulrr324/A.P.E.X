# STARK-L10.3 — Context Contribution, Acceptance-Criterion Review, and L10-E Disposition

**Milestone status:** diagnostics executed and independently recomputed. **No
historical criterion changed. L10-E remains FAILED at 0.425926 against the
unchanged 0.40 threshold.** The new criterion (**L10-K1**) was **ratified by the
owner on 2026-10-24 (Option B)** as a criterion *definition*; it is **ratified
but unevaluated** and is not applied to any L10.3 number.

**Headline**

| Criterion / statistic | Governing status | Value | Disposition |
|---|---|---|---|
| L10-E, shuffled half | v1.0, unchanged | 0.132407 ≤ 0.40 | passes (unchanged) |
| L10-E, context-off half | v1.0, unchanged | **0.425926 > 0.40** | **FAILED** |
| L10-E overall | v1.0, unchanged | — | **FAILED** |
| Context-off, recomputed from trials | diagnostic | 0.425926 | identical to analytic floor |
| **CAA** (context accuracy advantage) | diagnostic | **0.5799** | per seed 0.5185 / 0.5917 / 0.6296 |
| **CRA** (context routing advantage) | diagnostic | **0.6667** (= ceiling 1−1/K) | all seeds |
| **L10-K1** (ratified 2026-10-24, Option B) | v1.7 pending (L10.4) | diagnostics suggest it would pass; **not an evaluation** | **ratified but unevaluated** |

---

## A. Provenance

Verified against the live repository and GitHub before any change.

| Item | Value |
|---|---|
| Repository | `Rahulrr324/A.P.E.X` (private, `main` @ `563395f1…`) |
| Starting branch / SHA | `validation/l10-2-spec-ratification` @ `8218615397ab5cfddad13765683788967d33d558` |
| L10.3 branch | `validation/l10-3-context-contribution`, created from `8218615` |
| Protocol registration | commit `3500c03`, sha256 `7e90699b3db7d6c2f68998f46141f9f92c2dd1d26cc9dec0341f30aaed8cef82` — **before any registered run** |
| Protocol v1.1 (K4 execution-path entry) | commit `f60d1e9`, sha256 `a046d38f35f88d131b825228d1a330212fcbcf5dc917d5ac383b5955eda9da6d` |
| Prior evidence verified | L10.2 manifest **200/200** sha256 entries, 0 mismatches; L10.1 manifest 275 entries with **one** expected difference (`stark/src/learning/l10_validation_harness.cpp`, extended additively in L10.2 and again here; its frozen reproduction was re-verified, see §F) |
| PR #2 / PR #3 | OPEN, unmerged, heads `5f5a577…` / `49cc6ba…` — untouched |
| New PRs | none |

Branch choice: the work is on a dedicated `validation/*` branch, as in L10.1 and
L10.2, because pushing to `arena/86da64f9-a-p-e-x` would move PR #3's head.

## B. The original L10-E

**Exact governing text** — `stark/design/context_conditioned_memory_milestone.md`
§8 *Frozen success criteria*:

> `L10-E | shuffled-cue mean accuracy ≤ 0.40 and context-off mean ≤ 0.40 (see §13: the context-off half is arithmetically floored at ≈0.33; reported as-is)`

The criterion is applied to the pooled mean over the 9 (seed, task) cells of the
three primary masters, with 120 trials per cell.

**Independently calculated floor.** Re-derived from the task permutations only:

```
acc_off(t) = A(0, t) = (1/6) · #{ i : π₀[i] = π_t[i] },   acc_off(0) = 1
```

Measured 0.425926 = analytic 0.425926, maximum deviation **0** over the nine
cells (both recomputed from the 1080 context-off trial rows and from
`--mode perm` output).

**Measured result:** pooled context-off **0.425926** (per seed 0.5000 / 0.4444 /
0.3333); shuffled-cue 0.132407.

**Final status under the unchanged criterion: L10-E = FAILED.** Nothing in this
milestone alters that, and nothing here re-scopes it.

## C. The new diagnostic

**What it measures.** How much *informative context contributes to performance*,
on a scale calibrated by a **context-ignoring policy on the same task draw**:

- `A(k,t)` — accuracy of bank `k` answering task `t`, measured by forcing each
  bank with the cue removed (the pre-existing D-CTX-3 sweep).
- `acc_null(t) = (1/K) · Σ_k A(k,t)` — what a policy that ignores context and
  picks a bank uniformly achieves on this draw.
- `CAA(t) = acc_correct(t) − acc_null(t)`; `CAA_pooled` = mean over seeds.
- `CRA(t) = R_correct(t) − 1/K`; `CRA_pooled` = mean over seeds.

Under the null (context ignored) both are 0 by construction; with perfect
routing and random permutations the ceilings are 5/9 = 0.5556 and 0.6667.

**Protocol hash:** v1.0 `7e90699b…` (commit `3500c03`, registered before the
run); v1.1 entry `a046d38f…` (commit `f60d1e9`, K4 execution-path correction,
labelled as written after inspection).

**Authorization:** the diagnostics are **exploratory**. At the time of the run
no owner decision existed; the owner ratified L10-K1 afterwards (2026-10-24,
Option B) as a *definition*, which does not retroactively convert these
measurements into an official evaluation. Every value below is a diagnostic
measurement; no PASS/FAIL is assigned to L10-K1 here.

**Matched controls.** Every condition runs on the identical trained state, the
identical evaluation schedule and 120 trials per (seed, task). The only quantity
that changes is the cue vector — and for `off-uniform`, the fallback rule, which
is why that condition is reported as a *separate* diagnostic and never as
context-off.

**Results (primary seeds, 3 × 3 cells, 120 trials each)**

| Condition | Pooled accuracy | Pooled routing | Degradation vs correct |
|---|---|---|---|
| correct | 1.0000 | 1.0000 | — |
| holdout (unseen cue pair) | 0.9981 | 1.0000 | 0.0019 |
| **partial (1 of 2 cue features)** | **1.0000** | 1.0000 | 0.0000 |
| cross (ambiguous: features of two tasks) | 0.5611 | 0.5019 | 0.4389 |
| **off (learned-router fallback)** | **0.4259** | **0.3333** | 0.5741 |
| off-uniform (explicit uniform fallback) | 0.4157 | 0.3407 | 0.5843 |
| shuffled (misleading cue) | 0.1324 | 0.0000 | 0.8676 |

| Seed | CAA(t₀,t₁,t₂) | CAA | CRA |
|---|---|---|---|
| 123456789 | 0.5000 / 0.5556 / 0.5000 | 0.5185 | 0.6667 |
| 218213831 | 0.5556 / 0.6083 / 0.6111 | 0.5917 | 0.6667 |
| 171473193 | 0.6667 / 0.6111 / 0.6111 | 0.6296 | 0.6667 |
| **pooled** | | **0.5799** | **0.6667** |

Exploratory seeds 1 / 2 / 7 / 42 (no criterion): CAA = 0.5556 / **0.4019** /
0.5537 / 0.5926, pooled 0.5259; CRA 0.6667 on all four; conditions: correct
0.9979, partial 0.9979, off 0.4736, off-uniform 0.4785, shuffled 0.2194.

**Fallback behaviour.** With the cue removed the learned router picks bank 0 on
**1080/1080** trials (score vector all zeros → strict-argmax tie-break to the
lowest allocated bank); the explicit uniform fallback spreads over
0.337 / 0.316 / 0.347 (bank 0/1/2). The two fallbacks differ by only 0.010
pooled, which is the point: the context-off *number* is a property of the
fallback rule, not of context use.

**Hypotheses, as pre-registered**

| ID | Result |
|---|---|
| H1 `CAA_pooled ≥ 0.40` every primary seed | **holds** (0.5185 / 0.5917 / 0.6296) |
| H2 `CRA_pooled ≥ 0.50` | **holds** (0.6667 = ceiling) |
| H3 correct ≥ partial ≥ off | **holds** (1.0000 ≥ 1.0000 ≥ 0.4259); no leak |
| H4 `|acc_off − acc_off_uniform| ≤ 0.15`, both in [1/3, 0.60] | **holds** (0.0102; 0.4259 and 0.4157) — and it demonstrates the fallback dependence |
| H5 routing under off = 1/K exactly | **holds** (0.3333, bank 0 in every trial) |
| H6 `A(k,t) = agreement(π_k,π_t)/6` | **26 of 27 cells exact; 1 cell deviates by exactly one trial** — see §D |

## D. Scientific interpretation

**What the evidence establishes.**

1. **The context-off half of L10-E does not measure context dependence.** It is
   a deterministic function of the task draw: the fixed-point agreement between
   bank 0's random permutation and each task's permutation. Measured values match
   the analytic values exactly (max deviation 0 over nine cells).
2. **That criterion is a lottery even for a flawless system.** With n = 6
   identities and K = 3 banks, `E[pooled context-off] = 4/9 = 0.4444`, the
   attainable range is [1/3, 1], and a **perfect** model passes the ≤ 0.40
   threshold with probability **0.1512** (0.4054 on a single seed). The 0.40
   threshold sits 0.067 above the floor of a system that ignores context
   entirely and 0.018 below the mean of a perfect one. No mechanism change can
   make it discriminate.
3. **Context does contribute, and this is measurable.** `CAA = 0.5799` and
   `CRA = 0.6667` (its exact ceiling) on all three primary seeds, with a
   criterion whose pass probability for a perfect system is 0.9998 and whose
   value under the null is exactly 0. The proposed criterion is not vacuous: an
   exploratory seed scores 0.4019, i.e. it can fail.
4. **The capability is routing-only and this is now explicit.** With the cue
   removed, *every* bank still answers correctly for its own task (diagonal of
   the forced-bank matrix = 1.0000 in all nine cells); only bank selection
   changes. Context contributes by selecting a bank, not by modulating what a
   bank retrieves. That is a design property of CCM v1.6, not a defect, but it
   is the reason an accuracy-after-removal criterion is the wrong instrument.
5. **Robustness profile.** One of the two cue features is sufficient (partial
   accuracy 1.0000 = correct accuracy); a misleading cue is destructive (0.1324);
   ambiguous mixed-feature cues are partially handled (0.5611, and per-task
   0.0–1.0). The system is robust to *degraded* context and brittle to
   *contradictory* context.

**What it does not establish.**

- It does not show that L10-E was passed, or that the system was under-rated:
  L10-E failed and stays failed.
- It does not establish a *causal* necessity of context beyond the routing
  argument: CAA is a behavioural advantage, not an intervention on an internal
  variable.
- It does not establish that CAA is the only reasonable metric, nor that 0.40 is
  the right threshold for a future criterion (it is justified here by headroom,
  not by theory).
- It says nothing about L11 or about capabilities beyond the 3-task/3-bank
  protocol.

**Remaining confounds and open questions.**

- **One deviating cell (H6).** `(master 218213831, task 1, bank 2)` measures
  0.008333 where the permutation model predicts 0.0 — exactly **one** trial in
  120. The most plausible cause is a channel-attention mis-selection making a
  different candidate the retrieved item, whose answer then coincidentally
  matches: holdout accuracy shows 2 such mis-selections per 1080 trials
  (rate 1.85 × 10⁻³), which over the 3240 forced-bank trials predicts ≈ 6
  mis-selections and, at ≈1/6 chance of a coincidental match, ≈ 1 accidental
  correct trial — the observed count. **This is a consistent explanation, not a
  verification**; confirming it needs a per-trial channel-slot field, which
  would change the trial-row schema and was deliberately not added after the
  registered run. Its effect on the reported statistics is +0.0009 on one seed's
  CAA and is reported rather than rounded away.
- `acc_null` uses measured `A(k,t)`; the measurement carries the same ~0.2 %
  attention noise, which is why CAA is reported to four decimals and no further.
- The 3-bank/3-task structure is baked into the floor derivation; the numbers do
  not transfer to other K or T without re-deriving the null (formula is general,
  constants are not).
- The `partial` condition is deterministic-alternating rather than random, so it
  measures "either single feature suffices", not an average over random
  dropouts.

## E. Acceptance decision

Full memo: `stark/reports/L10_3_ACCEPTANCE_DECISION.md`.

| Option | Meaning | Effect on history | Outcome |
|---|---|---|---|
| **A** retain L10-E | keep threshold and metric; stays FAILED | none | not selected |
| **B** add a separate criterion | L10-E stays FAILED; add L10-K1 | none; L10-K1 has no history yet | **RATIFIED by the owner, 2026-10-24** |
| **C** replace L10-E prospectively | §8 row superseded | failure preserved but its criterion removed from §8 | not selected |

**Approval status: OPTION B RATIFIED by the repository owner on 2026-10-24**,
asked directly in this session and recorded verbatim in
`stark/reports/L10_3_ACCEPTANCE_DECISION.md` §6. The agent approved nothing on
the owner's behalf and did not infer approval from L10.2's A-1/A-3.

Consequences, precisely:

- **L10-E is unchanged and remains FAILED** at 0.425926 against 0.40.
- **L10-K1 is ratified as a definition but is not evaluated.** The values in §C
  are diagnostic; assigning them PASS would be exactly the substitution this
  milestone exists to prevent.
- `stark/design/context_conditioned_memory_milestone.md` is **not** modified: it
  is frozen at v1.6. Inserting the ratified L10-K1 row into §8 is a versioned
  change deferred to **L10.4**, which must also carry the official evaluation
  under a fresh registration.

## F. Regression and integration

Run from the documented working directory `stark/`, compiler
`g++ 12.2.0 -O2 -std=c++17`, exactly as in L10.1/L10.2.

| Check | Result |
|---|---|
| Canonical suite (`/tmp/battery_l103.sh`, same target list as L10.2) | **26 targets, all exit 0** |
| Assertion counts | CCM **330**, structural audit **357**, L10.1 sealing **276**, Phase-1 gates **437**, profiler/accounting/budget/records/reproducibility 34/67/55/72/37 |
| New failures | **0** |
| `test_phase1_affinity` | **UNEXECUTED** (Win32 `DWORD_PTR`); reported as unknown, not fixed |
| Determinism of the registered run | **15/15 artifacts byte-identical** between two independent runs |
| Non-perturbation of registered numbers | the flagged run's `metrics_*.csv` and `sealing_*.csv` are **byte-identical** to the L10.2 R0 artifacts; only the `trial`/`call` index columns of the trial rows shift |
| Unflagged reproduction | all 12 R0 artifacts (metrics, calls, sealing, trials) reproduced byte-for-byte with the modified binary |
| Checkpoint resume | 3/3 seeds exact (final retention 1.000, bank map 0/1/2 preserved) |
| Independent recomputation | `analysis/recompute.py` from per-trial rows only; matches every aggregate |

**Generalization probes** (declared exploratory; no criterion): held-out cue
pairs 0.9981; 4 tasks/4 banks final 0.9993, forgetting 0.0; 5 tasks/5 banks
0.9989 / 0.0; **8 tasks/8 banks 0.9920 / 0.0 with min acquisition 0.8333** (one
task below the 0.85 level used by L10-B, which governs the frozen 3-task
protocol only — reported, not excused); order 2,0,1 final 1.0000; revisiting
task 0 after the stream 1.0000; misrouted cues during training
(`--misroute 0.20`) final 0.7222 with forgetting 0.2778 and min held-out 0.0 —
a genuine failure mode, reported as such; forced wrong initial bank final
0.6139, forgetting 0.2574.

## G. Limitations and next milestone

**Limitations of this milestone.** The diagnostic is behavioural; the CAA null
depends on a measured forced-bank matrix; one H6 cell is unresolved (documented
above); the proposed threshold is justified by headroom, not by a theory of what
"enough" context contribution is; nothing here was authorised as a criterion.

**Progress estimate: ~50 % (unchanged).** L10.3 removed a measurement
contradiction and made the remaining failure interpretable; it added no
capability. Counting a milestone as progress for correcting its own metric would
inflate the estimate.

**The owner decided (Option B) on 2026-10-24. Recommended next milestone:
L10.4 — bump the design document to v1.7 with the ratified L10-K1 row, register
the protocol, run the primary seeds under that registration, recompute
independently, run the full regression, and record the official disposition.**
L11 should not start before that, because the acceptance specification is not yet
internally consistent: §8 still contains only the superseded-in-effect L10-E
context row.

## H. Deliverables and reproduction

| Path | Contents |
|---|---|
| `work/L10_3_CONTEXT_CONTRIBUTION.md` | this report |
| `work/L10_3_CONTEXT_CONTRIBUTION.json` | machine-readable results, `null` where unmeasured |
| `stark/design/l10_3_context_contribution_protocol.md` | registered protocol v1.0 (+ v1.1 K4 entry) |
| `stark/reports/L10_3_ACCEPTANCE_DECISION.md` | Options A/B/C memo; **Option B ratified 2026-10-24** |
| `work/l10_raw/context_contribution_20261024/` | raw evidence: `protocol/`, `K0/`, `K0b/`, `KX/`, `KC_cross/`, `GEN/`, `perm/`, `regress/`, `restart/`, `analysis/`, `regression/`, `MANIFEST.md` |

```bash
cd stark
CORE="src/learning/ContextConditionedMemory.cpp src/learning/RelevanceRouting.cpp \
      src/neural/NeuralCell.cpp src/neural/Synapse.cpp src/neural/Network.cpp"
g++ -O2 -std=c++17 -Isrc -o harness src/learning/l10_validation_harness.cpp $CORE
S=123456789,218213831,171473193
./harness --mode tasks    --out K0     --seeds $S --seal 1 --ctx-contribution --ctxperbank --tag _KC
./harness --mode tasks    --out K0b    --seeds $S --seal 1 --ctx-contribution --ctxperbank --tag _KC
./harness --mode ctxnovel --out KC_cross --seeds $S --seal 1 --ctx-contribution --ctxperbank --tag _KX
./harness --mode tasks    --out KX     --seeds 1,2,7,42 --seal 1 --ctx-contribution --ctxperbank --tag _KCx
./harness --mode perm     --seeds $S,1,2,7,42 > perm/perm.csv
python3 ../work/l10_raw/context_contribution_20261024/analysis/recompute.py K0 _KC perm/perm.csv
python3 ../work/l10_raw/context_contribution_20261024/analysis/verify_floor.py perm/perm.csv K0 _KC
```
