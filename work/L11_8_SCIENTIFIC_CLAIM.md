# STARK-L11.8 — The Scientific Claim and the Estimand

**Branch:** `validation/l11-8-claim-redesign` · **Base:** `cf79201a` (verified L11.7)
**Nature:** documentation only · **nothing here is ratified**

Labels: **[V]** verified from a file or the source · **[D]** derived, arithmetic shown ·
**[P]** proposed · **[U]** unresolved · **[X]** not executed.

---

## 0. Why the claim has to be defined before the contract

L11.7 established that the frozen contract's operating point is ~0.94–0.99 per cell
rather than the nominal 0.90, that L11-B is near-infeasible, and that no criterion
states a test **[D]**. Every one of those findings is a *mismatch between the claim the
authors meant and the rule they wrote*. This document fixes the claim first; §7 of the
package then derives the contract from it.

---

## 1. Q1 — What does "cross-signature compositional generalization" mean, operationally?

> **Candidate definition [P].** A cue built from features belonging to **two distinct
> training signatures**, in a **feature-count ratio that never occurs in training**,
> must be answered by the system **from the signature that owns the majority of the
> cue's features**, with the answer retrieved from **that signature's own mapping**, and
> the choice of signature must be **invariant to the order in which signatures were
> allocated to storage banks**.

Four clauses, each separately measurable:

| Clause | Operational form | Frozen metric |
|---|---|---|
| **C-majority** | the resolved bank is the one owning the group with more cue features | `Comp` on `CROSS21`/`CROSS31` |
| **C-novel-ratio** | the ratio (2:1, 3:1) is absent from training (training is 2:2 within-group) | construction **[V]** |
| **C-retrieval** | the answer comes from the resolved bank's own mapping | `Read` |
| **C-order** | the resolution does not depend on allocation order | `Comp(A2) − Comp(A9)` |

The definition deliberately says **"must be answered from the signature that owns the
majority"** rather than "must answer correctly", because accuracy alone is satisfiable by
wrong-bank leakage (§3, Q4). Retrieval is a **guard**, not evidence: `Read = 1.0` shows a
bank is intact, not that composition happened **[D]**.

---

## 2. Q2 — What must be generalized to that was not supplied by the task design?

Three things, and only three:

1. **The count ratio.** Training presents 2 features from one group, always. Evaluation
   presents 2:1 and 3:1 mixes. Nothing in the task design supplies a rule for
   mixtures **[V]**.
2. **Multi-signature cues.** A cue spanning two signatures never occurs in training **[V]**.
3. **The linking of "more features" to "this bank".** Whether the system resolves by
   *counting* is a property of its mechanism, not of the task.

And one thing that **is** supplied and must not be counted as generalization:

**The additive form of the router.** `bankScores()` is literally

    sc[k] = Σ_{f ∈ cue} w_router[f][k]        [V]

so the majority simply dominates a sum. **R-majority is emergent from additivity, not
from a majority detector.** That is a perfectly respectable mechanism — but it means the
system is *not* learning a composition rule; it is learning per-feature bank affinities
whose sum happens to implement majority. The claim must be worded accordingly: *"a cue's
bank is determined by the summed per-feature affinities, so that the signature with more
features dominates"* — a claim about **additive cue integration**, not about symbolic
composition.

**Consequence for the contract:** the additive model makes a *sharp, falsifiable
prediction* that a general "accuracy ≥ 0.90" test cannot express — **3:1 cues must route
at least as well as 2:1 cues**, because three votes beat one and two votes beat one, with
a larger margin in the first case. **No criterion in the frozen contract tests this.**
A3 has no criterion at all (§7.9).

---

## 3. Q3 and Q4 — unit of generalization, and what distinguishes learning from artefacts

### Q3. Candidate unit of generalization **[P]**

> **The primary unit is the individual task, within a fixed three-task battery, over
> three independent training runs.**

Not "task families": there is exactly one family. Not "held-out signatures": the
signatures are the three groups, all seen in training. Not "the complete evaluation set":
a set-level average is the construct L10.3's 0.5611 already provided and it **hid a
0.0/0.5/1.0 collapse** **[V]**. The task is the right unit precisely because the
historical failure was task-structured.

**Explicit limitation [U]:** the three tasks are **fixed, not sampled**. No task
population is defined anywhere in the record. A per-task claim is therefore a
*demonstration on a specified battery*, not an inference to a task distribution. This
must be stated in any report; it cannot be repaired without new tasks.

### Q4. What evidence separates learned composition from the four artefacts

| Artefact | Discriminator | Status in the frozen contract |
|---|---|---|
| **Task-index routing** (the router keys on which task is being evaluated) | structurally excluded: `bankScores(agent, cue)` takes the cue only, and in the learned path `task_bank` is never used to choose the bank **[V]** | **no criterion needed** — but the exclusion is a *code fact*, not a documented invariant, so it should be asserted as a schema/unit-test invariant **[P]** |
| **Memorized mappings** (the answer is a lookup, not composition) | the CROSS cues are absent from training **[V]**; `Read` separates "the bank knows the answer" from "the cue reached the right bank" | **partly covered** by D, but D is a *guard*, not a discriminator |
| **Supplied architectural structure** (the rule is hard-coded rather than learned) | **A10 — the zero-weight router** — resolves to the lowest allocated bank and therefore scores ≈1/3. The A2-vs-A10 contrast is exactly "learned vs default" and they see the **same cues** | **NOT USED BY ANY CRITERION** **[V]** — the contract cannot distinguish a learned router from a fixed tie-break |
| **Additive-sum artefact** (the effect is a consequence of the mechanism, not of learning a rule) | A2 vs A3 ordering (3:1 ≥ 2:1) | **NOT TESTED — A3 has no criterion** **[V]** |

**This is the most important gap in the whole contract.** L11's title is about learning,
and its acceptance contract contains **no comparison that isolates learning**. A10 exists,
is matched, and is unused.

**Candidate remedy [P]:** add a *matched control contrast* — `Comp(A2) − Comp(A10) ≥ δ`,
paired on the same 360 cues, with δ unresolved until an expected value for A10 is
measured. **Marked [U]: the evidence does not currently justify a δ.**

---

## 4. Q5 — Primary claim and secondary diagnostics

> **Primary claim [P].** *On a fixed three-task battery, over three independent training
> runs, the system resolves 2:1 and 3:1 cross-signature cues to the signature owning the
> majority of features — and retrieves from that signature — in every task, on at least
> two of the three runs.*

> **Secondary diagnostics (reported, not gating).**
> (a) pooled composition accuracy, the number L10.3 published;
> (b) `Read` with its denominator;
> (c) the measured forced-bank null `Null(t)`;
> (d) `MixAcc` against `Null` on every cell;
> (e) the `A2` vs `A10` contrast;
> (f) the `A2` vs `A3` ordering;
> (g) `AMBIG11` behaviour (diagnostic only until R4 is decided).

The primary claim names **both** the routing clause and the retrieval guard, **and** the
robustness form ("at least two of the three runs"), because that is what the proposed
aggregation rule actually measures (§7/S1).

---

## 5. Q6 — What a complete pass would justify, and what it would not

**Justified by a complete pass [P]:**

- On this battery, with these three seeds, the system is *consistent with* the primary
  claim at n = 120 trials per cell.
- The effect is **not** attributable to task-index routing (structure excluded), to
  within-bank memorization of the test cue (cues absent from training), or to a default
  tie-break (A10 contrast).
- The effect survives a change of allocation order (L11-G).

**Not justified:**

- Any claim about a **task population** — three fixed tasks are not a sample **[U]**.
- Any claim of a **general** composition law — one family, one ratio pair, one
  mechanism.
- Any claim that the system *learned a rule* rather than *summed affinities* (§2).
- Any numeric claim of the form "accuracy ≥ 0.90 is established"; at n = 120 the
  supported phrasing is "consistent with ≥ 0.90" (Wilson half-width 0.0543) **[V]**.
- Any claim about tasks, ratios or signature counts **not** in the battery.
- Any claim that the architecture is general, or that performance implies general
  intelligence — explicitly out of scope for this milestone and for APEX.

---

## 6. Estimand and evaluation unit **[P]**

| Quantity | Definition |
|---|---|
| **Cell** | `(seed s, task t, arm a)`; 120 trials |
| **Cell estimand** | `θ_{s,t} = P(choice = perm_t[queried] | cue ~ CROSS21(t), checkpoint(s))` |
| **Task estimand** | `θ_t = E_s[θ_{s,t}]` — expectation over the training procedure, estimated from 3 runs |
| **Battery estimand** | `θ̄ = (1/3) Σ_t θ_t` (equal weights; identical to trial-weighting because every cell is 120 trials) |
| **Unit of observation** | the trial |
| **Unit of randomization** | the training seed (3 values) |
| **Experimental unit for a method-level claim** | **the training run — n = 3** |
| **Effective sample size** | 120 per cell for *measurement*; **3** for *generalization across runs* |

**The pseudoreplication statement, which belongs in every L11 report [P]:**

> *1080 trials are not 1080 independent observations. All trials within a cell share one
> frozen checkpoint; there are three independent runs and three fixed tasks. Statements
> about the training procedure rest on n = 3.*

The contrast is stark and must be reported: `P(cell passes | p = 0.90) = 0.5761` is a
statement about 120 Bernoulli draws from **one** model; the probability that **the method**
produces such a model is estimated from three runs, and three runs cannot resolve it.

---

## 7. Recommendation and trade-offs **([P] — not ratified)**

| Candidate claim | Rule it implies | Strength | Feasibility at n=120 |
|---|---|---|---|
| **P1 — every cell** | all 9 cells | strongest wording | joint 0.007 at a true 0.90 **[D]** |
| **P2 — every task, 2 of 3 runs** ← recommended | S1/D3 | "every task, robust to one run" | 0.231 at 0.90 **[D]** |
| **P3 — battery mean ≥ 0.90** | S1/D4 | allows one task to compensate | 0.161 at 0.90 **[D]** |
| **P4 — pooled rate** | S1/D5 | a different, weaker claim | 0.526 at 0.90 **[D]** |

**Recommend P2.** It is the only one whose *wording* matches its *rule*: "on at least two
of three runs" is a robustness claim, and 2-of-3 is exactly its operational test. It keeps
every task in the claim, so a task-structured collapse still fails. And it is the most
dependence-robust of the four (spread 0.19–0.23 across dependence assumptions, versus
0.007–0.576 for P1).

**The trade is explicit and must be owned:** P2 concedes that a model which is perfect on
two runs and catastrophic on the third can pass. If the owner wants that excluded, the
honest alternative is **more seeds**, not a stricter rule at three (S1 §4).

**What P2 does not fix:** at a true 0.90 per cell, P2 still passes only 23 % of the time.
That is not a defect of the rule — it is what n = 120 can resolve. The claim is therefore
stated as *"consistent with"*, and the report must print the joint power beside the result.

---

## 8. Questions this document deliberately leaves open

| # | Open | Owner decision |
|---|---|---|
| 1 | is the primary claim P2? | **S4 / S1** |
| 2 | is the A10 contrast a criterion, and with what δ? | **new — U1** |
| 3 | is the A2/A3 ordering a criterion? | **new — U2** |
| 4 | is "learned additive integration" acceptable wording for what L11 demonstrates? | **new — U3** |
| 5 | does the owner accept that no task-population inference is available? | **S4** |
