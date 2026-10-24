# STARK-L11.4 — R5: L11-C Metric Contract and Ambiguity Analysis

**Status:** analysis and proposal. Nothing applied, nothing ratified.
Labels: **[V]** verified in file/source · **[A]** supported by a committed artifact ·
**[I]** inferred · **[P]** proposed · **[?]** unknown/blocked.

---

## 1. Every reference to L11-C in the repository

| # | Location | Exact text | Metric named? | Pooled clause? |
|---|---|---|---|---|
| 1 | `stark/design/l11_cross_signature_compositional_generalization.md:145` | "no cell `(seed, task)` in A2 or A3 below **0.50**" | **no** | no |
| 2 | `work/L11_1_PREREGISTRATION.json:55` | "no (seed, task) cell in A2 or A3 below 0.50" | **no** | no |
| 3 | `work/L11_1_SPECIFICATION_AND_INSTRUMENTATION.json:127` | "no (seed,task) cell in A2 or A3 below 0.50" | **no** | no |
| 4 | `work/L11_1_SPECIFICATION_AND_INSTRUMENTATION.md:252` | "L11-C no cell < 0.50" | **no** | no |
| 5 | `work/L11_READINESS_ASSESSMENT.md:254` | "`MixAcc` pooled ≥ 0.75 **and** no seed/task cell below 0.50 (the clause that would have caught L10.3's 0.0 cell)" | **`MixAcc`** | **yes** |
| 6 | `work/L11_READINESS_ASSESSMENT.json:116` | "MixAcc pooled >= 0.75 and no seed/task cell below 0.50" | **`MixAcc`** | **yes** |
| 7 | `work/L11_3_OWNER_DECISION_PROPOSED.md:55` | R5 as an open question | no (by design) | — |

**Finding R5-1 [V].** There is **no implementation of L11-C anywhere** — no script,
no function, no analysis file. `git grep -l -i "mixacc" -- '*.py' '*.sh'` returns
only the L11.3 prototype validator, which does not compute L11-C. The criterion has
never been evaluated, and its metric has never been computed.

**Finding R5-2 [V].** The frozen artifacts (rows 1–4) are unanimous in **omitting**
the metric name; the only artifacts that name it (rows 5–6) are **not** the frozen
record.

---

## 2. Provenance chain — the drop was a drafting regression, not a decision

| Commit | Artifact | Content of L11-C |
|---|---|---|
| `ba1cfb3` (STARK-L10.6) | readiness assessment | `MixAcc` pooled ≥ 0.75 **and** no cell < 0.50 |
| `77d261a` (STARK-L11.1) | protocol, spec, prereg | "no cell in A2 or A3 below 0.50" |

**[V]** `git merge-base --is-ancestor ba1cfb3 77d261a` → **true**: the readiness
proposal precedes the freeze.

**[V]** `work/L11_1_SPECIFICATION_AND_INSTRUMENTATION.md:250–253` states:

> **Candidate criteria** (unchanged from the readiness proposal **except where
> marked**): … L11-C no cell < 0.50; … **L11-G (new, DERIVED from §C)**

Only **L11-G** is marked as changed. **[A]** The author of the freeze explicitly
declared L11-C **unchanged** from the readiness proposal — while, in fact, both the
metric name and the pooled clause were dropped.

**Finding R5-3 [I].** The omission is a **drafting regression**, not a deliberate
redefinition. The frozen text therefore does not express an intention to *change*
L11-C; it fails to *carry forward* what L11-C was.

**Finding R5-4 [V].** The freeze also *added* a scope restriction — "in A2 or A3" —
that the readiness version did not have. So the frozen text is simultaneously
**narrower in scope** (A2/A3 only) and **weaker in content** (no metric, no pooled
floor) than its declared source.

---

## 3. What L11-C is meant to protect against

**[V]** `work/L10_6_MILESTONE_SIGNOFF.md:252–254`:

> **Cross-signature compositional generalization is weak.** Pooled 0.5611 with a
> seed that reaches **0.0** on one task; the spread across tasks (0.0–1.0) suggests
> task-order dependence rather than a general capability.

**[V]** `work/L10_3_CONTEXT_CONTRIBUTION.md:104` — the L10 mixed-cue condition
reports **pooled accuracy 0.5611** against **pooled routing 0.5019**, with a
per-cell spread of 0.0–1.0.

**[I]** L11-C exists to prevent exactly that shape: **a pooled or averaged number
that looks respectable while one cell has collapsed to zero.** The motivating
statistic is an **accuracy** statistic (0.5611 accuracy, 0.0–1.0 per cell), not a
routing statistic. Routing has its own floors: L11-A (0.90 on A2) and L11-G.

**Finding R5-5 [I].** The criterion's purpose is stated against an *accuracy*
collapse. This is the strongest available evidence about intent, and it is
independent of which reading makes the criterion easier to pass.

---

## 4. The two candidate readings and their redundancy structure

### Reading 1 — `Comp` (routing)

| Cell | Implied by another criterion? |
|---|---|
| A2 `Comp(t) ≥ 0.50` | **yes** — L11-A requires `Comp(A2,t) ≥ 0.90` on every task and seed **[V]**, which strictly implies ≥ 0.50 |
| A3 `Comp(t) ≥ 0.50` | **no** — no criterion covers A3 |

**Net contribution of Reading 1: a 0.50 routing floor on A3 only.**

### Reading 2 — `MixAcc` (accuracy)

| Cell | Implied by another criterion? |
|---|---|
| A2 `MixAcc(t) ≥ 0.50` | **yes, given L11-A and L11-D hold** — see the identity below |
| A3 `MixAcc(t) ≥ 0.50` | **no** — nothing else constrains A3's end-to-end result |

**Derivation [I, from the §6 definitions at protocol:101–108]:**

```
MixAcc(t) = Comp(t)·Read(t) + (1 − Comp(t))·WrongBankAcc(t)
```
with `Comp ≥ 0.90` (L11-A) and `Read ≥ 0.90` (L11-D) and `WrongBankAcc ≥ 0`:

```
MixAcc(t) ≥ 0.90 × 0.90 + 0.10 × 0 = 0.81 > 0.50
```

So **L11-C's A2 clause is mathematically implied by L11-A ∧ L11-D under both
readings**. The only place L11-C has independent force is **A3**, which no other
criterion covers.

### Which reading is stronger on A3?

| A3 outcome | Reading 1 (`Comp`) | Reading 2 (`MixAcc`) |
|---|---|---|
| `Comp = 1.00`, `Read = 0.00` (routes perfectly, reads nothing) | **PASS** (1.00 ≥ 0.50) | **FAIL** (0.00 < 0.50) |
| `Comp = 0.30`, `Read = 1.00`, `WrongBankAcc = 1.00` | FAIL (0.30 < 0.50) | PASS (1.00 ≥ 0.50) |
| `Comp = 0.45`, `Read = 0.95` | FAIL | PASS (≈0.53) |

**Finding R5-6 [I].** Reading 2 **strictly dominates** Reading 1 on the failure mode
the criterion was written to catch: a system that routes correctly and retrieves
nothing scores 1.0 on routing and 0.0 on accuracy. Reading 1 would pass it.
Reading 2 fails it. Reading 2 is the *stricter* choice, not the easier one.

**Finding R5-7 [I].** Because Reading 2 can pass a cell that Reading 1 fails
(row 2), it is **not** a superset. The two readings are genuinely different
predicates; there is no reading that is "both". This is why the choice must be
explicit and registered.

### Loopholes created by each reading

| Reading | Loophole | Severity |
|---|---|---|
| `Comp` | "routes perfectly, reads nothing" passes the only non-redundant cell | **high** — precisely the L10 failure shape, inverted |
| `MixAcc` | a uniformly mediocre model (0.55 accuracy everywhere) passes L11-C | **low** — but it must still clear L11-A, L11-B (gap ≥0.50 over null), L11-D |
| `MixAcc` | a cell at 0.51 passes; the criterion says nothing about proximity to 0.50 | inherited from the frozen threshold, **not introduced here** |

---

## 5. Proposed L11-C metric contract (complete)

**[P]** Everything in this section is a proposal. The frozen text is unchanged.

### 5.1 Identity

| Property | Value |
|---|---|
| Name | `L11-C` — **per-cell accuracy floor** |
| Metric | `MixAcc` |
| Scientific interpretation | no evaluated cell in the two composition arms may sit at or near a total collapse; a pooled or averaged figure may not be the only evidence that composition works |
| Status | clarification of an existing frozen criterion (**not** a new criterion) |

### 5.2 Formula

```
MixAcc(seed, task, arm) = (1 / n) Σ_r 1[ correct_r == 1 ]
    over rows r in cell (seed, task, arm)
    restricted to: record_status == OK, metric_eligibility ∋ ACC
    correct_r = 1[ choice_r == perm_task[ queried_r ] ]
n = number of such rows; expected n = 120
```

### 5.3 Unit of analysis

The cell `(seed, task, arm)` — **not** a pooled count. Matches protocol §6
("per-seed per-task values are primary … No metric is ever computed from a pooled
count") **[V, protocol:117]**.

### 5.4 Numerator and denominator

- Numerator: count of rows with `correct == 1`.
- Denominator: count of ACC-eligible, `record_status == OK` rows in that cell.
- Expected denominator: 120 = `n_ids` 6 × 20 pair trials (`makeLRTrials(cfg.lr, map, 0, 20, seed)`) **[V, harness:507]**.

### 5.5 Inclusion and exclusion

| Rule | Source |
|---|---|
| Arms **A2** (`CROSS21`) and **A3** (`CROSS31`) only | frozen text, "in A2 or A3" **[V]** |
| Rows with `record_status == INVALID` excluded and counted | schema v0.2 §2 **[A]** |
| `MISLEAD` rows can never enter (ACC ineligible) | v0.2 eligibility table **[A]**; not in A2/A3 anyway |
| `AMBIG11` rows can never enter (ACC ineligible — "no accuracy claim") | v0.2 table + spec §3 **[A]** |
| Diagnostic / re-derivation rows excluded (`record_class != ORDINARY`) | v0.2 invariant 15 **[A]** |
| An evaluation call delivering ≠ 120 trials invalidates the **whole call** | protocol §8(ii) **[V]** |

### 5.6 Aggregation

- Evaluated **per cell**, for every primary seed and every task.
- A single cell below threshold is a **failure**; there is no averaging that can
  rescue it.
- Reported alongside (never instead of) the per-seed pooled value.

### 5.7 Missing data

| Situation | Behaviour |
|---|---|
| cell not evaluable (missing rows, invalid call) | **INCONCLUSIVE**, never a pass (protocol §7) |
| `MixAcc` not applicable to the category | cannot arise: A2/A3 are ACC-eligible |
| any `NA` in a cell | cell is not evaluated; the count of such cells is reported |

### 5.8 Threshold and pass/fail (unchanged)

```
L11-C passes  iff  for every primary seed s, every task t, every arm a ∈ {A2, A3}:
                     MixAcc(s, t, a) >= 0.50
```

The **0.50 threshold is unchanged**. No threshold is proposed, altered, or
reinterpreted by this document. Per protocol §8, a failure is reported with its
number, per cell, and **no post-hoc threshold adjustment** is permitted.

### 5.9 Validity per arm

| Arm | Category | L11-C applicable? | Why |
|---|---|---|---|
| A2 | `CROSS21` | **yes** | ACC eligible **[A]** |
| A3 | `CROSS31` | **yes** | ACC eligible **[A]** |
| A4 | `AMBIG11` | **no** | "carries no accuracy claim" **[A]** |
| A6 | `MISLEAD` | **no** | structurally 0 **[A]** |
| A7 | `SHUFFLED` | **no** | not A2/A3; also reported separately as `ShufAcc` |
| A9 | `ORDERPERM` | **no** | not in the frozen text's scope (**[?]** whether intentional — see §7) |

### 5.10 Interaction with the other criteria

| Criterion | Relation to L11-C |
|---|---|
| **L11-A** (`Comp(A2) ≥ 0.90`) | implies L11-C's A2 clause (§4); measures routing, not accuracy |
| **L11-B** (`MixAcc(A2) − Null ≥ 0.50` on ≥2/3 tasks) | **different predicate**: a *gap* vs a measured null, not an absolute floor. A model can clear L11-C and fail L11-B (accuracy 0.60, null 0.55) or clear L11-B and fail L11-C (accuracy 0.55, null 0.00 — impossible here since Null ≥ 0, but in principle). **Not redundant.** |
| **L11-D** (`Read(A2) ≥ 0.90`) | retrieval *given* routing; L11-C is unconditional accuracy. Together with L11-A they bound L11-C's A2 clause (above). |
| **L11-E** | orthogonal (determinism) |
| **L11-F** | orthogonal (regression) |
| **L11-G** (`Comp(A2) − Comp(A9) ≥ −0.10`) | routing only, and only A2/A9. **L11-C is the only criterion that touches A3 at all.** |

### 5.11 Failure reporting

A failure prints: the cell `(seed, task, arm)`, `MixAcc`, `n`, the Wilson 95 %
interval, and the routing/retrieval decomposition (`Comp`, `Read`,
`WrongBankAcc`) so the failure can be attributed to routing or retrieval. The
threshold is not revisited after seeing the number.

---

## 6. Recommendation

**R5 recommendation: L11-C = `MixAcc`, per `(seed, task, arm ∈ {A2, A3})` cell,
threshold 0.50 unchanged.**

Grounds, and each is independent of any score (no L11 data exists — **[V]**):

1. **[A]** The only artifacts that name the metric name `MixAcc`, and they are the
   declared source of the frozen criterion.
2. **[A]** The freeze's own status note says the criteria are "unchanged from the
   readiness proposal except where marked"; L11-C was not marked. The omission is a
   regression, so naming `MixAcc` restores the declared intent rather than changing
   it.
3. **[I]** It is the **stricter** reading on the only non-redundant cell (A3), where
   the `Comp` reading would pass "routes perfectly, reads nothing".
4. **[I]** It matches the criterion's documented purpose — catching a per-cell
   accuracy collapse beneath a respectable pooled figure (0.5611 pooled, 0.0 cell).
5. **[I]** It introduces no new threshold, no new arm, and no new aggregation.

**Why not "both, conjoined"** (the L11.3 tentative suggestion): conjoining
`Comp(A3) ≥ 0.50` with `MixAcc(A3) ≥ 0.50` would add a routing floor that L11-A
already provides for A2 and that the monotonicity role of A3 does not obviously
require. It is a *new* requirement rather than a clarification, and this milestone
should not silently add requirements. It remains available to the owner as an
option (§7, option 4).

### R5b — the pooled clause (separate decision, not resolved here)

**[V]** "`MixAcc` pooled ≥ 0.75" appears **only** in the superseded readiness
proposal. It is absent from the protocol, the specification, the preregistration,
and the L11.1 instrumentation record.

**[?]** Its pooling contract is undefined in every document: pooled over tasks only?
over seeds? over the two arms A2 and A3? Consistent with protocol §6's ban on
pooled counts, the only permissible form is an *unweighted mean of per-task
values*, which yields **one value per seed per arm** — i.e. six values, not one.

**Recommendation:** treat the pooled clause as a **separate owner decision**. Do
not restore it as part of the L11-C clarification, because (a) it is a *new
threshold* that was never registered, and adding a threshold under the heading of
"clarification" is exactly the manoeuvre the safeguards exist to prevent; and
(b) its aggregation rule does not exist yet and would have to be invented. If the
owner wants it, it must be adopted explicitly, with the contract of §7-option 3
written down, and it is a class **A** (acceptance-criterion) change.

Since it is a **strengthening** that the freeze declared "unchanged", the honest
disposition is: **flagged, not adopted**. The owner may add it; this milestone will
not.

---

## 7. Status: is R5 resolved?

| Option | Description | Class | Recommendation |
|---|---|---|---|
| 1 | L11-C = `MixAcc`, cell clause, 0.50 | **A** (clarification of a frozen criterion) | **recommended** |
| 2 | L11-C = `Comp`(routing) | A | rejected — contradicts the criterion's purpose, passes "reads nothing" |
| 3 | 1 **plus** pooled ≥ 0.75 (per seed, per arm, unweighted task mean) | A, strengthening | available, needs explicit approval + written contract; **not** recommended for silent inclusion |
| 4 | 1 **plus** conjoined `Comp(A3) ≥ 0.50` | A, strengthening | available; adds a routing floor L11-A does not provide for A3 |
| 5 | Leave L11-C undefined | — | rejected — an officially frozen criterion that cannot be evaluated blocks any official run |

**R5 is *analytically* resolved** (the evidence establishes a unique best-supported
reading) but **procedurally open**: the change alters the meaning of a
preregistered acceptance criterion, so it requires a versioned amendment and
explicit owner approval. It is **not applied**, and until it is, **L11-C remains
BLOCKED for official use** and the protocol must not be described as unambiguous.

**R5b remains open** and is not resolvable from the repository.
