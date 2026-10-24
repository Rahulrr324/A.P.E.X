# STARK-L11.7 — Owner Decision Register

**Status of every row: NOT APPROVED.** No decision in this repository has been
authorised. Recommendations are **[P]**; evidence labels are as elsewhere.

Existing decisions are **carried forward unchanged** — this milestone resolves none of
them. Four new decisions (S1–S4) arise from the statistical audit.

---

## Part I — carried forward from L11.6 (status unchanged)

| ID | Question | L11.7 evidence | Recommendation | Blocks |
|---|---|---|---|---|
| **R4** | what does A4 report? | unchanged: `AMBIG11` still unimplemented (`grep AMBIG11 stark/src` = 0) **[V]** | two named metrics `Comp_task(A4)`, `Comp_rule(A4)` | unambiguity |
| **R4b** | tie-break convention | unchanged: rule is in no ratified document **[V]** | lowest **bank** index, map required | A4 |
| **R4c** | `Read_rule(A4)` status | unchanged | diagnostic, non-criterion | — |
| **R5** | L11-C metric | **strengthened**: 0.50 requires 10 % of headroom above a context-ignoring policy, and L10.3's 0.5611 *passes* it **[D]** | `MixAcc`, per cell — **but see S3**, which now proposes restricting it to A3 | every run |
| **R5b** | pooled ≥ 0.75 | unchanged; no population, no formula, no derivation | defer | — |
| **F1** | `MISLEAD` vs `SHUFFLED` | unchanged: constructionally identical, one implemented mode | distinguish by `o`-selection, or merge | A6/A7 |
| **F2** | `o` distribution | unchanged; no distribution anywhere in the protocol | uniform over the other two, shared across arms | all cross-family arms |
| **F4** | §5 stream seeds | **re-verified against the code this milestone**: eval `master+5001+t`, shuffled `master+9100+t`, cross `master+9400+t`, while the table says `9300`/`9500`/`9600` **[V]** | correct the table to the code | L11-E, C6 check 14 |
| **R6** | hash recording | unchanged | additive; retain v0.1 | provenance |
| **R1** | ratify L11-A…G | **materially changed by this milestone**: three of seven criteria have no stated test, and one is near-infeasible | **do not ratify as written**; ratify only with S1–S4 decided | any official run |
| **R2** | non-building inherited test | unchanged (`DWORD_PTR` undeclared) | fix before L11-F means anything | L11-F |
| **C1–C7** | readiness | **0 of 7** (5 blocked pending implementation, 1 pending a runtime test, C4 specification-level only with an erratum) | unchanged | implementation |

---

## Part II — new decisions from the statistical audit

### S1 — the aggregation rule for L11-A

**Question.** Should a complete L11-A pass require all nine cells, or a k-of-n pattern?

**Frozen text.** "`Comp(A2,t) ≥ 0.90` on every task `t` and every seed" **[V]**.

**Evidence.** Per-cell power at a true 0.90 = 0.5761 **[V]**. Joint power: 0.00699 under
independence; **[0, 0.576]** by Fréchet; 0.075 / 0.193 / 0.387 at copula ρ = 0.3 / 0.6 /
0.9 **[D]**. A true per-cell accuracy of 0.9412 is needed for 80 % joint power **[D]**.
The threshold itself is unchanged by this decision.

**Interpretations.** (a) all nine — the literal text; (b) ≥ 7 or ≥ 8 of nine; (c) every
task on ≥ 2 of 3 seeds, mirroring L11-B's existing structure.

**Recommendation [P].** (c). It preserves "every task" — the scientific point — while
removing the one-seed lottery; power at 0.90 rises from 0.007 to 0.231.

**Consequence.** Scientific: a single bad seed no longer decides the milestone, but a
consistently failing task still does. Implementation: no change; the same 9 cells.

**Does it change an acceptance criterion?** **Yes.**

**Exact approval sentence.** *"L11-A is ratified as: on every primary seed, at least two
of the three tasks reach `Comp(A2,t) ≥ 0.90`, with the per-cell threshold unchanged at
108/120; the per-cell results are reported for all nine cells."*

---

### S2 — the specification of L11-B

**Question.** `MixAcc − Null(t) ≥ 0.50` has no constant meaning, because `Null(t)` is
measured and runs 0.333–0.500.

**Evidence.** `E[Null] = 4/9` **[D]**; measured values in L10.4 on the same three primary
seeds **[V]**; required `MixAcc` therefore runs 0.833–1.000, and on two cells is exactly
1.000 (i.e. 120/120) **[D]**. At a true `MixAcc` of 0.95 the criterion passes with
probability 2.6 × 10⁻³ **[D]**.

**Interpretations.** (a) keep as written and accept near-infeasibility; (b) normalise by
headroom — `(MixAcc − Null)/(1 − Null) ≥ τ`, τ = 0.75; (c) absolute floor `MixAcc ≥ 0.90`
on ≥ 2 of 3 tasks; (d) replace the forced-bank null with a paired A10 contrast (changes
the claim).

**Recommendation [P].** (b) as the criterion, (c) as the reported line.

**Consequence.** Scientific: the criterion becomes *interpretable* rather than merely
hard. Implementation: none — the same measurements are already required.

**Does it change an acceptance criterion?** **Yes.**

**Exact approval sentence.** *"L11-B is ratified as: on every primary seed, `(MixAcc(A2,t)
− Null(t)) / (1 − Null(t)) ≥ 0.75` on at least two of the three tasks, with `Null(t)`
measured exactly as protocol §6 defines it, and with `MixAcc ≥ 0.90` on those two tasks
reported as a secondary line."*

---

### S3 — the scope of L11-C

**Question.** Should L11-C apply to A2 as well as A3?

**Evidence.** `MixAcc = Comp·Read + (1−Comp)·Wrong`; on A2 the A2-gates already require
`Comp ≥ 0.90` and `Read ≥ 0.90`, which implies `MixAcc ≥ 0.81` — so L11-C's A2 clause
cannot bind **[D]**. The 0.50 floor is 10 % of headroom **[D]**. L10.3's 0.5611 passes a
0.50 floor **[D]**.

**Interpretations.** (a) keep 18 cells; (b) restrict to A3 (9 cells); (c) drop entirely.

**Recommendation [P].** (b). A3 is the only arm nothing else gates.

**Consequence.** Scientific: the residual floor applies where it is informative.
Implementation: none.

**Does it change an acceptance criterion?** **Yes.**

**Exact approval sentence.** *"L11-C is ratified as applying to the nine `CROSS31` cells
only, with the 0.50 floor unchanged; `MixAcc` is reported for A2 as a headline number and
is not an acceptance criterion on A2."*

---

### S4 — what the claim is

**Question.** Is the L11 claim "every task exceeds the bar" or "the pooled composition
rate exceeds the bar"?

**Evidence.** The specification explicitly forbids pooled substitution ("reported
alongside per-cell values, never instead of them") **[V]**. A pooled exact test at
α = 0.05 needs 989/1080 and has 72 % power at 0.92 **[D]** — a genuinely valid and
far more powerful design, but for a **different claim**.

**Interpretations.** (a) per-cell (status quo, hence the low power); (b) pooled global
statistic; (c) both — per-cell reported, pooled tested, with the difference declared.

**Recommendation [P].** (a) **retained**, with the joint power printed beside the result.
Switching to (b) would reverse a stated design principle and must be a deliberate owner
decision, not a power optimisation.

**Does it change an acceptance criterion?** **Yes, if (b).** It changes **the scientific
claim** either way it is decided.

**Exact approval sentence.** *"The L11 claim is ratified as a per-task claim: no pooled
statistic may substitute for a per-cell result, and every conjunctive result is reported
with its joint power."*

---

## Part III — what is deliberately *not* proposed

| Not proposed | Why |
|---|---|
| Raising `n` above 120 | changes the frozen configuration; the owner may consider it, but it is not this milestone's to propose |
| Changing 0.90, 0.50, 0.75, −0.10 | frozen; a threshold change needs its own decision with its own derivation |
| Making `AMBIG11` metrics criteria | unauthorised (R4) |
| Distinguishing `MISLEAD`/`SHUFFLED` by definition | unauthorised (F1) |
| Choosing the `o` distribution | unauthorised (F2) |
| Declaring any result PASS/FAIL | **no run exists** **[X]** |

---

## Part IV — the queue

**Nine carried-forward decisions plus four new ones. Thirteen sentences.**

R5 was first in L11.6; **it is no longer the blocking item** — R1 now cannot be
signed until S1–S4 are decided, because three of the seven criteria have no stated test
and one cannot in practice be passed. **S2 is the one that most changes what the
milestone means.**
