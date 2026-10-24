# STARK-L11.6 — Owner Decision Register

**Nine decisions. Nothing here is approved.** Each entry separates **evidence**,
**inference**, **recommendation** and **authorization**.

Tag key: **[V]** verified in file/source · **[A]** committed artifact · **[C]**
computed in this milestone · **[I]** inferred · **[P]** proposed · **[?]** unknown.

**Base:** `d09c6c41872faeb1b26233c4e8050f649fbe352f` (L11.5), working tree clean.

**Authorization column convention:** *none* means no owner authorization exists in the
repository or the conversation. Nothing in this file creates one.

---

## R1 — Ratify the L11-A … L11-G acceptance contract

| Field | Content |
|---|---|
| **Question** | Are L11-A … L11-G, at their stated thresholds, the criteria that will decide the official L11 result? |
| **Frozen wording** | Protocol §7: "As specified in the specification §6: L11-A … L11-G. **Status: PENDING OWNER RATIFICATION.**" **[V]** `l11_1_protocol.md:121–124`. The preregistration's `criteria_candidate.ratification` = `PENDING_OWNER_DECISION`; `owner_decisions_required` lists R1 with `blocking: true` **[V]** |
| **Evidence** | All seven criteria are stated verbatim in the specification §6 **[V]**. Statistical character was computed **for L11-A only, per single cell** **[V]** `…generalization.md:151–157`. No statistical character exists for L11-B, C, D, F or G **[V]** |
| **Competing interpretations** | (a) Ratify as written. (b) Ratify the metric definitions but re-open thresholds. (c) Ratify nothing until R4/R5 are settled. |
| **New finding [C]** | **The criteria are conjunctions over many cells, and their documented statistical character describes one cell.** L11-A "on every task and every seed" = 3 tasks × 3 seeds = **9 cells**. At a true rate of 0.90, per-cell P(pass) = 0.5761 (as documented), but **P(all 9 cells pass) = 0.00699** — 0.7 %. At a true rate of 0.95 the joint is 0.9371. **The published "coin flip at 0.90" is a coin flip only if the criterion were a single cell.** It is not. |
| **Recommendation [P]** | **Do not ratify as written until the conjunction is acknowledged.** The owner should ratify with an explicit statement of which multiplicity the criterion is meant to impose. This is a *documentation* deficiency, not an argument to lower a threshold — no threshold change is proposed. |
| **Scientific consequence** | ratifying as written commits to a criterion whose power is ~130× lower than documented against a true 0.90, and which cannot distinguish 0.90 from 0.95 in practice (0.7 % vs 93.7 %) |
| **Implementation consequence** | none directly; the evaluator must compute per-cell values and the conjunction, and must report the joint power beside the result |
| **Changes an acceptance criterion?** | **No** — R1 ratifies or withholds; it does not alter text. But ratifying in ignorance of [C] would ratify a rule whose stated statistics are wrong |
| **Exact approval required** | "R1: I ratify L11-A … L11-G as stated in specification §6 with the metric definitions established by R4 and R5, acknowledging that each criterion is a conjunction over all primary seeds × tasks and reporting the corresponding joint power." |
| **Dependents** | **depends on R4 and R5** (a criterion cannot be ratified while its metric is undefined); **blocks** any official run |

---

## R4 — `Comp` for `AMBIG11`: what is reported

| Field | Content |
|---|---|
| **Question** | Does the `AMBIG11` arm report a single `Comp`, two separately named quantities, or nothing? |
| **Frozen wording** | Protocol §6: "`Comp = routing` on `CROSS21` / `CROSS31` / `ORDERPERM` — this is the R-majority compliance rate. For `AMBIG11` the prescribed bank is the **lowest-index** of the two groups (declared tie-break)." **[V]** `:104–106`. Specification §3: `AMBIG11` = "declared tie-break compliance only; carries no accuracy claim" **[V]** `:80`. Arms table A4 role = "tie-break compliance" **[V]** `:126` |
| **Evidence** | `AMBIG11` is 1 feature from `g(t)` + 1 from `g(o)` — **a 1:1 tie with no majority group** **[V]** protocol §4. The two readings diverge on 0 % / 50 % / 100 % of A4 trials for tasks 0/1/2 (**50 % overall**) under standard allocation **[C]**. No criterion references A4 **[V]** `:143–149`. The arm is **unimplemented** (`git grep AMBIG11 stark/src/` → nothing) **[V]** |
| **Competing interpretations** | (a) `Comp(A4)` := task-bank routing. (b) `Comp(A4)` := tie-break compliance. (c) two named metrics. (d) undefined. |
| **Recommendation [P]** | **(c) two named metrics:** `Comp_task(A4)` and `Comp_rule(A4)`, defined in `work/L11_6_R4_AMBIG11_DECISION.md` §2. `Comp` stays restricted to the three composition categories. |
| **Scientific consequence** | (a) would score a rule-following model as failing on 2 of 3 tasks — it silently repeals the declared tie-break. (b) alone would report a model that never routes to the task bank as fully compliant. (c) keeps both readable and is the only option that does not choose a scientific position on the owner's behalf |
| **Implementation consequence** | the writer needs `task_bank`, `rule_bank`, and both derived booleans — all already in schema v0.2 (fields 21, 22, 25, 26) |
| **Changes an acceptance criterion?** | **No** — no criterion references A4 |
| **Exact approval required** | "R4: report `Comp_task(A4)` and `Comp_rule(A4)` as separately named, non-criterion metrics; `Comp` is defined only on CROSS21/CROSS31/ORDERPERM." |
| **Dependents** | depends on **R4b** (the tie-break defines `rule_bank`); **blocks** calling the protocol unambiguous; **does not block** any criterion |

---

## R4b — The tie-break convention

| Field | Content |
|---|---|
| **Question** | When two groups tie on feature count, which bank is prescribed, and computed from what inputs? |
| **Frozen wording** | Three texts, two different rules. Protocol §6: "the prescribed bank is the **lowest-index of the two groups**" **[V]** `:106`. Specification §2.1: "Ties are broken by the **lowest bank index**" **[V]** `:65`. Preregistration `declared_rule.statement`: "ties broken by lowest **bank** index" **[V]** |
| **Evidence** | Protocol **§4 contains no rule at all** (`grep -i majority` / `-i tie` hit only §1, §6, §11) **[V]**, so the specification's claim that the rule "is declared in `l11_1_protocol.md` §4" is **false** **[V]**. The two wordings coincide **exactly** today because A4 exists only in standard order where `task_bank = [0,1,2]` and hence `min(bank) ≡ min(group)` **[C]** |
| **Competing interpretations** | (a) lowest bank index — a property of banks. (b) lowest group index — a property of feature groups. They differ whenever `bank(g)` is not monotone in `g`, i.e. under any permuted allocation or different allocation policy **[C]** |
| **Recommendation [P]** | **(a) lowest bank index**, because it is what the preregistration and the specification both say, it is well defined even when the two tied groups' banks are non-adjacent, and it is computable from state the driver already has. |
| **Scientific consequence** | none today (zero numeric effect); under a permuted A4 it determines whether the metric measures "lowest-numbered bank" or "lowest-numbered group" — different quantities |
| **Implementation consequence** | `intendedBankByRule(cue, group_to_bank)` must take the read-only group→bank map (a group index is not a bank index — see the schema audit D4) |
| **Changes an acceptance criterion?** | **No** |
| **Exact approval required** | "R4b: the tie-break is the lowest **bank index** among the tied groups' banks, computed from the cue and the read-only group→bank map." |
| **Dependents** | **required by R4**; **blocks** A4 implementation |

---

## R4c — Is `Read_rule(A4)` descriptive, diagnostic, or acceptance-relevant?

| Field | Content |
|---|---|
| **Question** | Should a rule-conditioned retrieval metric be reported for A4, and what status does it carry? |
| **Frozen wording** | Nothing. `Read` is defined as "mean(correct \| routing == 1)" **[V]** `:107`. Schema v0.2 marks `READ` eligible for `AMBIG11` **[A]** |
| **Evidence** | Because `Read` conditions on **task** routing, a rule-following model drops exactly the trials A4 exists to probe: on ~50 % of A4 trials `routing_correct = 0` and those rows leave the denominator **[C]**. `Read(A4)` is well defined — it answers a different question than A4's declared role **[I]**. No criterion references A4 or `Read(A4)` **[V]** |
| **Competing interpretations** | (a) descriptive — report it, no status. (b) diagnostic — report it, excluded from every criterion. (c) acceptance-relevant — add a threshold. (d) omit it. |
| **Recommendation [P]** | **(b) diagnostic, non-criterion.** `Read_rule(A4) = mean(correct \| rule_compliant == 1)`, reported beside `Read(A4)`, never in a criterion, never substituted for `Read`. (c) is rejected: it would be a **new** acceptance criterion, and nothing in the record supports a threshold for it. |
| **Scientific consequence** | makes visible the retrieval behaviour on exactly the trials the declared tie-break governs; adds no claim |
| **Implementation consequence** | one further derived quantity from fields already present; no new capture |
| **Changes an acceptance criterion?** | **No** — and choosing (c) would |
| **Exact approval required** | "R4c: `Read_rule(A4)` is reported as a diagnostic, is not an acceptance criterion, and does not replace `Read`." |
| **Dependents** | depends on **R4/R4b**; blocks nothing |

---

## R5 — The L11-C metric

| Field | Content |
|---|---|
| **Question** | Which metric does "no cell `(seed, task)` in A2 or A3 below 0.50" refer to? |
| **Frozen wording** | "no cell `(seed, task)` in A2 or A3 below **0.50**" — **metric unnamed** **[V]** `…generalization.md:145`; prereg `:55`; instrumentation record `:127` and `.md:252` |
| **Evidence** | Full analysis in `work/L11_6_R5_L11C_DECISION.md`. In brief: (i) no implementation exists anywhere **[V]**; (ii) the readiness proposal (`ba1cfb3`, a verified ancestor of the freeze) names **`MixAcc`**; (iii) the freeze says the criteria are "unchanged … **except where marked**" and marks only L11-G **[V]**; (iv) on A2, `MixAcc ≥ 0.81` follows from L11-A ∧ L11-D and the criteria are conjunctive, so **L11-C's only decision-relevant content is its A3 clause** **[C]**; (v) the 0.50 threshold has **no derivation anywhere in the record** **[V]** |
| **Competing interpretations** | (a) `MixAcc`. (b) `Comp`. (c) conjoined. (d) undefined. |
| **Recommendation [P]** | **(a) `MixAcc`, per `(seed, task, arm ∈ {A2, A3})` cell, threshold 0.50 unchanged.** |
| **Scientific consequence** | on the only non-redundant cell (A3) the `Comp` reading **passes** "routes perfectly, reads nothing" while `MixAcc` **fails** it. The change is **not monotone** — a cell with `Comp(A3)=0.30, WrongBankAcc=1.00` fails under (b) and passes under (a). It is a **redefinition**, not a strengthening |
| **Implementation consequence** | the reported metric changes; the evaluator must compute `MixAcc` per cell over `record_status == OK`, `ACC`-eligible rows |
| **Changes an acceptance criterion?** | **YES — the only one in this package.** L11-C only |
| **Exact approval required** | "R5: L11-C is `MixAcc` ≥ 0.50 in every `(seed, task, arm)` cell for `arm ∈ {A2, A3}`, threshold 0.50 unchanged, with no pooled clause." *(Category: a new decision — see R5 analysis §5.)* |
| **Dependents** | **blocks every official run**; interacts with R1 and R5b |

---

## R5b — A pooled accuracy clause

| Field | Content |
|---|---|
| **Question** | Is a pooled `MixAcc` clause added, and if so over what population and by what formula? |
| **Frozen wording** | **Nothing.** "`MixAcc` pooled ≥ 0.75" appears only in the readiness proposal **[V]** `L11_READINESS_ASSESSMENT.md:254`, which is superseded and was itself labelled "proposed; requires owner ratification" **[V]** `:245` |
| **Evidence** | Absent from the protocol, the specification, the preregistration and the L11.1 instrumentation record **[V]**. Its pooling population is **undefined in every document** **[V]**. The protocol forbids pooled counts **[V]** `:117` |
| **Competing interpretations** | (a) adopt with a written contract. (b) reject. (c) defer. |
| **Recommendation [P]** | **(c) defer, and if adopted use (a) with the contract below.** A pooled clause cannot be evaluated until it specifies: population (which arms/seeds/tasks), aggregation (`MixAcc_pooled(seed, arm) = (1/3) Σ_task MixAcc(seed, task, arm)` — unweighted mean of per-task values, never a count), threshold (0.75), and missing-cell policy (any `NA` cell ⇒ the pooled value is `NA`, the criterion is INCONCLUSIVE, never imputed and never dropped). |
| **Scientific consequence** | a pooled value reintroduces exactly the failure mode L11-C's per-cell clause exists to prevent — unless it is reported *beside*, never instead of, the per-cell values |
| **Implementation consequence** | one derived aggregate per (seed, arm) |
| **Changes an acceptance criterion?** | **YES, if adopted** — it would add a clause. **Not proposed for adoption here** |
| **Exact approval required** | whichever of (a)/(b)/(c), in so many words |
| **Dependents** | none today; **would block** an official run if adopted without a contract |

---

## R6 — Record the adopted hashes in the preregistration

| Field | Content |
|---|---|
| **Question** | When an amendment is adopted, what is recorded and where? |
| **Frozen wording** | Preregistration pins protocol v0.1 `322078c8…`, specification `d9cd7dc4…`, schema v0.1 `a8edd674…` **[V]** |
| **Evidence** | All three file hashes currently **equal their recorded values** (recomputed) **[V]**. Adopting any amendment produces a different protocol hash, so the record would go stale — the `e32043c` defect class the L11.2 audit already flagged **[A]** |
| **Competing interpretations** | (a) replace the v0.1 record. (b) add v0.2/v0.2.1 hashes and retain v0.1. |
| **Recommendation [P]** | **(b).** Never overwrite a frozen record: add `registered_protocol_v0_2.sha256` and `schema_sha256_v0_2_1`, retain the originals, and retain the v0.1 L11-C string under `criteria_candidate_v0_1`. |
| **Scientific consequence** | none; purely provenance |
| **Implementation consequence** | none |
| **Changes an acceptance criterion?** | **No** |
| **Exact approval required** | "R6: record the adopted protocol and schema hashes additively; do not overwrite the v0.1 record." |
| **Dependents** | depends on R4/R4b/R4c/R5 being ratified first |

---

## F1 — What distinguishes `MISLEAD` from `SHUFFLED`

| Field | Content |
|---|---|
| **Question** | The two categories have the same cue construction. What, if anything, separates them? |
| **Frozen wording** | Protocol §4: `MISLEAD` = "2 features from `g(o)` only (the *wrong* group)"; `SHUFFLED` = "`TRAIN` pair of another task" **[V]** `:64–65`. Specification §3 gives the same pair **[V]** `:83–85` |
| **Evidence** | **A `TRAIN` pair of another task *is* 2 features from `g(o)`** — the two constructions are identical **[I, but decisive]**. The implementation has **one** mode, `CM_SHUFFLED`, drawing `tasks[ot].train_cues[pick_pair]` **[V]** `harness:215–222`. The two arms are assigned different *causal questions* in the arms table ("rule under contradiction" vs "contradictory context") **[V]** `:125,127` |
| **Competing interpretations** | (a) they are the same arm duplicated; merge. (b) the difference is the **`o`-selection**, not the construction. (c) the difference is the **intended bank** the driver asserts. (d) unresolved. |
| **Recommendation [P]** | **(b), made explicit**, with (a) as the fallback if the owner judges the distinction unsupported. See `work/L11_6_F1_F2_SEMANTICS.md` §2 for the full seven-field comparison. **I do not assert that a defensible distinction exists in the current design** — the record does not establish one, and this is reported as an unresolved design decision. |
| **Scientific consequence** | if (a) holds, the design has 10 distinct arms, not 11, and one causal question is unasked. If (b) holds, the distinction is real but currently unstated and unimplemented |
| **Implementation consequence** | either one mode or two; either way an owner decision precedes implementation |
| **Changes an acceptance criterion?** | **No** — neither arm is referenced by a criterion |
| **Exact approval required** | "F1: MISLEAD and SHUFFLED are [distinguished by X / the same arm, merged], and protocol §4 states the distinguishing rule." |
| **Dependents** | blocks A6/A7 implementation; **not** a class-X change unless merged |

---

## F2 — The `o` sampling distribution

| Field | Content |
|---|---|
| **Question** | How is the "other task" `o` drawn for `CROSS21`, `CROSS31`, `AMBIG11` and `MISLEAD`? |
| **Frozen wording** | Protocol §4: "first draw selects `o`" — **no distribution stated in any category** **[V]** `:60–66`. §5 fixes a "cross-family draw" stream at `master + 9600` **[V]** `:91` |
| **Evidence** | Only `o ≠ t` is fixed **[V]**. The one existing implementation (`CM_CROSS`) draws uniformly over the list of other tasks **[V]** `harness:227–231`. The distribution determines the expected `Comp_task`/`Comp_rule` divergence on A4 **[C]**. **New: protocol §5's stream table does not match the code** (see F4 below) |
| **Competing interpretations** | (a) uniform over the two other tasks. (b) determined by task order. (c) a fixed per-seed permutation. |
| **Recommendation [P]** | **(a) uniform over `{0,1,2} \ {t}`, drawn from the arm's cross-family stream**, presented as a **candidate for owner review**, not adopted. Full specification in `work/L11_6_F1_F2_SEMANTICS.md` §3. |
| **Scientific consequence** | affects balance across tasks and the expected value of every cross-family metric; under (a) all three tasks see both `o` values with equal probability, which is the only option that is symmetric in the task index |
| **Implementation consequence** | one distribution + one stream consumer |
| **Changes an acceptance criterion?** | **No** — but it changes the distribution of the statistics the criteria are computed on |
| **Exact approval required** | "F2: `o` is drawn [uniformly over the other two tasks] from [stream X], shared across all cross-family arms." |
| **Dependents** | blocks A2/A3/A4/A6/A9/A10 implementation; independent of R4/R5 |

---

## F4 (new, raised by this milestone) — protocol §5's RNG stream table does not match the implementation

| Field | Content |
|---|---|
| **Question** | Which stream seeds are authoritative for the cross-family and shuffled draws? |
| **Frozen wording** | §5 table: evaluation schedule = `master + 9300`; shuffled-cue draw = `master + 9500`; cross-family draw = `master + 9600` **[V]** `:88–91` |
| **Evidence [V]** | Actual code: evaluation schedule seed = `master + 5001 + t` (`harness:499, 530, 542, 547, 552, 563, 567, 573, 592`); `master + 9300` is passed in the **`shuffle_seed`** argument of `evalTask`, which those modes never consume; shuffled cue = `master + 9100 + t` (`:556`); cross cue = `master + 9400 + t` (`:576`). **Three of the seven rows are wrong**: `9500 → 9100 + t`, `9600 → 9400 + t`, and `evaluation schedule = 9300` mislabels the argument slot. The other four rows (π, trial schedule, training cue index, probe pool) and the `0x5bd1e995` XOR check out **[V]** |
| **Competing interpretations** | (a) the protocol intends *new* L11 streams and the code will be changed to match. (b) the protocol table is simply wrong and must be corrected to the code. |
| **Recommendation [P]** | **(b) — correct the table to the code**, because L11 must reproduce L10 bit-for-bit (protocol §10) and changing an existing stream's seed would break that. The **new** cross-family stream must then be given its own constant that does not collide with `9100+t`, `9300`, `9400+t` or any other live stream. |
| **Scientific consequence** | none directly; a wrong stream seed would silently break the L11-E determinism claim and the L10 non-interference comparison |
| **Implementation consequence** | the writer must record the stream identity it actually used |
| **Changes an acceptance criterion?** | **No** — but it is a **precondition** for L11-E |
| **Exact approval required** | "F4: protocol §5 is corrected to the implemented seeds, and the new cross-family stream is assigned an unused constant." |
| **Dependents** | blocks L11-E; blocks any cross-family arm |

---

## Status board

| ID | Approval | Evidence | Recommendation | Changes a criterion? | Blocks |
|---|---|---|---|---|---|
| **R1** | **none — NOT RATIFIED** | criteria verbatim; [C] conjunction finding | ratify *with* the multiplicity acknowledged | no (withholds/grants) | any official run |
| **R4** | none | [V]+[C] | two named metrics | no | unambiguity |
| **R4b** | none | [V]+[C] | lowest bank index | no | A4 |
| **R4c** | none | [V]+[C] | diagnostic, non-criterion | no | nothing |
| **R5** | none | [V]+[C] | `MixAcc`, per cell, 0.50 | **YES (L11-C)** | **every official run** |
| **R5b** | none | [V] | defer; contract if adopted | yes if adopted | nothing today |
| **R6** | none | [V] | additive record | no | provenance |
| **F1** | none | [I] from [V] | distinguish by `o`-selection, or merge | no | A6/A7 |
| **F2** | none | [V] | uniform over others (candidate) | no | all cross-family arms |
| **F4** | none | [V] | correct §5 to the code | no | L11-E |

**Nine decisions (the mission's list) plus one raised by this milestone (F4). None is
approved. No approval exists in the repository or this conversation.**
