# STARK-L10.3 — Acceptance Decision Memo: L10-E

**Type:** governance / specification decision record (proposal — **not approved**)
**Date:** 2026-10-24
**Author of the analysis:** engineering (Arena cloud agent)
**Decision owner:** repository owner (`Rahulrr324`)
**Status:** **OPTION B RATIFIED BY THE OWNER, 2026-10-24.** L10-E is retained
unchanged and remains FAILED; **L10-K1 is ratified as a criterion definition but
has not been evaluated** — it becomes official only inside a newly registered
protocol (L10.4). This memo section 6 records the decision; the analysis in
sections 1–4 is unchanged from the version that was pending.
**Governing document:** `stark/design/context_conditioned_memory_milestone.md`
§8, row `L10-E`. That document contains no delegation clause; an agent cannot
amend it. The repository's decision mechanism is an Owner Decision Record under
`stark/reports/` (precedent: `G7_OPTION1_OWNER_DECISION.md`, 2026-10-08;
`L10_2_OWNER_DECISION.md`, 2026-10-24).

---

## 1. The question

L10-E says:

> `L10-E | shuffled-cue mean accuracy ≤ 0.40 **and** context-off mean ≤ 0.40`

Measured, unchanged: shuffled-cue **0.132407** (passes), context-off
**0.425926** (fails by 0.026). **L10-E is FAILED.**

The question before the owner is not "how do we pass L10-E". It is:

> L10.3 shows that the context-off half of L10-E cannot measure what its own
> hypothesis (H3, *"if accuracy depends on the context cue, then shuffling and
> zeroing the cue must both degrade accuracy substantially"*) says it measures:
> with the cue removed, the router's scores are all zero, the argmax resolves to
> bank 0, and the statistic reduces to the fixed-point agreement between bank 0's
> random permutation and each task's permutation. A **perfect** model passes the
> ≤ 0.40 threshold with probability **0.1512**. Should the specification record
> that fact and (a) leave L10-E as a permanent failure, (b) add a separate
> context-contribution criterion, or (c) replace L10-E prospectively?

Evidence: `work/L10_3_CONTEXT_CONTRIBUTION.md` §4–§5 and
`work/l10_raw/context_contribution_20261024/analysis/verify_floor.py`.

## 2. What is established (independent of which option is chosen)

| Fact | Value | Source |
|---|---|---|
| Measured context-off | 0.425926 | recomputed from 1080 per-trial rows |
| Analytic value of the same statistic | 0.425926 | permutations only, max deviation 0 across 9 cells |
| Expected value under a perfect router | 0.4444 | derangement distribution, n = 6 |
| Attainable range (any mechanism) | [0.3333, 1.0] | same |
| P(perfect router passes ≤ 0.40, 3 seeds) | **0.1512** | exact enumeration |
| P(perfect router passes ≤ 0.40, one seed) | 0.4054 | exact enumeration |
| CAA (context accuracy advantage) | **0.5799** | per seed 0.5185 / 0.5917 / 0.6296 |
| CRA (context routing advantage) | **0.6667** = its ceiling (1 − 1/K) | all three seeds |
| Proposed L10-K1 pass probability, perfect router | 0.9998 | exact enumeration |

The mechanism is not in question: L10-A/B/C/D/F2/G2/H all pass, and the
single-feature ("partial context") condition still routes perfectly
(accuracy 1.0000), while a misleading cue drops accuracy to 0.1324. Informative
context plainly carries the performance.

## 3. Options

### Option A — Retain L10-E exactly as written

**What happens:** threshold 0.40, metric unchanged; the milestone records
L10-E = FAILED at 0.425926 permanently, with the derivation attached.

- **Benefits:** zero risk of moving goalposts; the historical record stays
  literally true; no re-interpretation of any earlier number; nothing to
  re-register. *(Not selected — see §6.)*
- **Limitations:** the specification keeps a criterion that a flawless system
  passes only 15 % of the time, so "L10-E failed" will keep being reported
  without indicating any deficiency of the system; the milestone can never be
  closed on capability grounds.
- **Risks:** future readers may read the failure as a mechanism defect.
  Mitigated only by the accompanying explanation, not by the specification.
- **Effect on history:** none.

### Option B — Keep L10-E failed, add a separate context-contribution criterion (recommended and **RATIFIED**, §6)

**What happens:** L10-E stays exactly as it is (FAILED, 0.425926, threshold
0.40, unchanged). A **new** criterion L10-K1 is added to §8 with a distinct
metric and a fresh, explicitly registered evaluation. L10-E is retained as a
historical criterion and is not deleted.

Proposed text (identical to protocol §5, fixed before the run):

> **L10-K1 — Context Contribution.** On every primary seed:
> (a) `CAA_pooled ≥ 0.40`, where `CAA(t) = acc_correct(t) − acc_null(t)` and
> `acc_null(t) = (1/K) Σ_k A(k,t)` is the accuracy of a context-ignoring policy
> measured by forcing each bank with the cue removed;
> (b) `CAA(t) ≥ 0.25` for at least two of the three tasks;
> (c) `CRA_pooled ≥ 0.50`, where `CRA(t) = R_correct(t) − 1/K`.

- **Benefits:** the failure of L10-E is preserved verbatim (no retroactive
  reinterpretation); the new criterion is measurable, null-calibrated (0 under a
  context-ignoring system), and non-degenerate (a perfect system passes 99.98 %
  of the time, an exploratory seed still scores 0.4019, so it discriminates);
  historical numbers stay comparable because nothing is redefined.
- **Limitations:** the milestone carries one permanently-failed criterion next
  to a passing one, which must always be explained together; CAA needs the
  forced-bank sweep (`--ctxperbank`), i.e. one extra evaluation arm per run.
- **Risks:** an owner could mistake "L10-K1 passes" for "L10-E was wrong to
  fail". The memo and protocol state explicitly that L10-E failed and stays
  failed.
- **Effect on history:** L10-E remains FAILED; every prior number is unchanged;
  L10-K1 has no historical results yet (it would be evaluated in a new
  registered run).

### Option C — Replace L10-E prospectively

**What happens:** §8's `L10-E` row is superseded by L10-K1 for all future
milestones. The historical run stays recorded as "failed under the superseded
criterion".

- **Benefits:** the specification stops containing a criterion that cannot
  measure its own hypothesis; a single, clean context criterion going forward.
  *(Not selected — see §6.)*
- **Limitations:** this is the only option that *changes* the meaning of an
  acceptance row; it invites the reading that a failed criterion was removed
  after the fact, even though the change would be prospective.
- **Risks:** highest governance risk; requires the incompatibility finding to
  be accepted as proven (L10.3 does demonstrate it, but the demonstration is one
  milestone old and should ideally be reviewed by the owner).
- **Effect on history:** the failed L10 result is preserved, but the criterion
  that produced it no longer exists in a normative document — a strictly larger
  claim than Option B.

## 4. Recommendation

**Option B.**

Reasons, in order:

1. It changes no historical result and no existing threshold — the constraint
   that has governed every milestone in this session.
2. It is the only option that both *preserves* the failure and *records* the
   measured capability, which is what L10.3 was asked to establish.
3. Option C's additional benefit (a cleaner §8) is smaller than its governance
   risk, and the incompatibility finding is already preserved in the protocol
   and the L10.3 report under Option B.
4. Option A is defensible but leaves the project unable to express the result
   that the evidence actually supports.

If the owner prefers C, the recommendation is to apply it **prospectively
only**, with L10-E's row annotated "superseded 2026-xx-xx; historical result
retained as FAILED", never rewritten.

## 5. Approval record

| Field | Value |
|---|---|
| Decision | **OPTION B — retain L10-E unchanged and add L10-K1 as a separate criterion** |
| Decided by | repository owner (`Rahulrr324`) |
| Date | **2026-10-24** |
| Mechanism | the owner was asked directly, in this session, to choose among Options A, B and C as specified in §3 of this memo; the owner selected **B** |
| Recorded by | engineering (Arena cloud agent) — recorded verbatim, not interpreted |
| Effect on L10-E | **unchanged: FAILED at 0.425926 against the 0.40 threshold; the criterion, its metric and its historical result are untouched** |
| Effect on L10-K1 | **ratified as a criterion definition** (text below). It is **not** an evaluated criterion: the L10.3 diagnostics are exploratory and no PASS/FAIL is assigned to them |
| Effect on history | none — every prior number stands as published |
| Agent authority | none; the agent proposed and recorded, and approved nothing |

### Ratified criterion text (L10-K1)

> On every primary seed: (a) `CAA_pooled ≥ 0.40`, where
> `CAA(t) = acc_correct(t) − acc_null(t)` and
> `acc_null(t) = (1/K) Σ_k A(k,t)` is the accuracy of a context-ignoring policy
> measured by forcing each bank with the cue removed; (b) `CAA(t) ≥ 0.25` for at
> least two of the three tasks; (c) `CRA_pooled ≥ 0.50`, where
> `CRA(t) = R_correct(t) − 1/K` and `R_correct(t)` is the fraction of correct-cue
> trials whose selected bank is the task's bank.

This is the text registered in `stark/design/l10_3_context_contribution_protocol.md`
§5 **before** the run; the owner ratified that text, not a value.

### What the ratification does and does not do

- **Does:** make L10-K1 the authoritative context criterion for future
  milestones, alongside the retained L10-E.
- **Does not:** pass L10-K1. The L10.3 measurement (CAA 0.5799, CRA 0.6667) is
  diagnostic evidence indicating that a properly registered evaluation would
  pass; it is not that evaluation.
- **Does not:** amend `stark/design/context_conditioned_memory_milestone.md`.
  That document is frozen at v1.6 and its §8 row for L10-E is unchanged. The
  insertion of L10-K1 into §8 is a versioned change deferred to **L10.4**,
  together with a fresh registration and the official evaluation.

### Next step implied by this decision

**L10.4 — register L10-K1 and evaluate it officially:** bump the design document
to v1.7 with the ratified §8 row, re-register the protocol (frozen hash before
the run), run the primary seeds under that registration, recompute independently,
run the full regression, and record the disposition. Until that run, L10-K1 is
*ratified but unevaluated*.
