# STARK-L11.5 — R5: `L11-C` Metric, Threshold, and Authorization Classification

**Status:** analysis and recommendation only. **Nothing applied or registered.**
Documentation-only. No threshold is changed by this document.

Tags: **[V]** verified in file/source · **[A]** committed artifact · **[C]**
computed here (exact arithmetic) · **[I]** inferred · **[P]** proposed · **[?]**
unknown/blocked.

---

## 1. The criterion as it actually stands

**Frozen text [V]** — `stark/design/l11_cross_signature_compositional_generalization.md:145`:

> | **L11-C** | no cell `(seed, task)` in A2 or A3 below **0.50** |

**Registered text [V]** — `work/L11_1_PREREGISTRATION.json:55`:

> `"L11-C": "no (seed, task) cell in A2 or A3 below 0.50"`

**Instrumentation record [V]** — `work/L11_1_SPECIFICATION_AND_INSTRUMENTATION.json:127`
and `.md:252` carry the same string with no metric name.

**Verification [V]:** `git grep -n "L11-C"` over the whole repository returns 14
hits, none of which is an implementation. There is **no code, script, or function
that computes L11-C**. The criterion has never been evaluated.

---

## 2. The `MixAcc` formula and its inputs

**Protocol [V]** `l11_1_protocol.md:103`:

```
MixAcc = correct                   (on the composition arms)
correct = (1/n) Σ 1[choice == perm[queried]]
```

**Source the inputs come from [V]:**

| Input | Source | Line |
|---|---|---|
| `choice` | `CCResult::choice` | `ContextConditionedMemory.h:99` |
| `queried` | `CCResult::queried` = `s.presented[map.phi[s.ctx]]` | `ContextConditionedMemory.cpp:238` |
| `perm` | `tasks[task].map.perm` | harness `l10_validation_harness.cpp:247` |
| `correct` | `choice == perm[queried]` | harness `:247` |
| `n` | rows in the cell with `record_status == OK` and `ACC` eligible | schema v0.2 |

**Well-definedness of the formula [I]:**

| Condition | Holds? |
|---|---|
| defined for every A2/A3 trial | **yes** — every trial produces `choice`, `queried`, and a task mapping |
| denominator non-empty | **yes**, 120 = 6 identities × 20 pair trials (`makeLRTrials(cfg.lr, map, 0, 20, seed)` **[V]** harness `:507`) |
| denominator inflated by diagnostics | **not if `record_class` filtering is applied** — 8 `dump_rows` call sites share one row vector **[V]**; see C2 |
| undefined for any relevant arm | **no** — `ACC` is eligible for A0, A1, A2, A3, A5, A7, A8, A9 **[V]** v0.2 §5 |
| depends on a missing value | **no** — `correct` is always computable |

**Verdict: `MixAcc` is a total, unambiguous, always-computable function on A2/A3.**
Unlike `Read` (which can have an empty denominator), it needs no `NA` machinery.

---

## 3. Duplication and interaction with the other criteria

```
MixAcc = Comp·Read + (1 − Comp)·WrongBankAcc          [I, from §6 definitions]
```

### 3.1 Is L11-C implied by other criteria?

Assume L11-A holds (`Comp(A2,t) ≥ 0.90`) and L11-D holds (`Read(A2,t) ≥ 0.90`).
Then on A2, per cell:

```
MixAcc ≥ 0.90 × 0.90 + 0.10 × 0 = 0.81 > 0.50     [C]
```

**Finding R5-1 [I]/[C].** On **A2**, L11-C is implied by L11-A ∧ L11-D.

**But the criteria are conjunctive** — all must hold. Under conjunctive evaluation a
clause implied by other clauses **cannot change the overall verdict**. Therefore:

> **L11-C's entire decision-relevant content is its A3 (`CROSS31`) clause.**

**Finding R5-2 [V].** A3 is referenced by **no other criterion**:
`L11-A` → A2; `L11-B` → A2; `L11-D` → A2; `L11-G` → A2 and A9. L11-C is the only
criterion that constrains A3 at all.

### 3.2 Is L11-C redundant with L11-B?

| | L11-B | L11-C (A2 clause) |
|---|---|---|
| Predicate | `MixAcc(A2,t) − Null(t) ≥ 0.50` on ≥2 of 3 tasks | `MixAcc(A2,t) ≥ 0.50` on **all** cells |
| What it tests | accuracy exceeds a **measured** context-ignoring null | accuracy clears an absolute floor |
| Implied by A∧D? | **no** — requires `Null(t) ≤ 0.31`; L10 measured `Null ≈ 0.4259` **[V]** `L10_1_CONTROL_VALIDATION.md:222` | yes |
| Independent bite | **yes** (context necessity) | only on A3 |

**Verdict: not redundant, and not the same predicate.** L11-B has the independent
bite on A2; L11-C has it on A3. Neither subsumes the other.

### 3.3 Behaviour when routing succeeds but retrieval fails

| Cell state | `Comp` | `Read` | `MixAcc` | `Comp`-reading of L11-C | `MixAcc`-reading of L11-C |
|---|---|---|---|---|---|
| routes perfectly, reads nothing | 1.00 | 0.00 | **0.00** | **PASS** (1.00 ≥ 0.50) | **FAIL** (0.00 < 0.50) |
| partial routing, perfect retrieval | 0.45 | 1.00 | 0.45+… | FAIL | depends on wrong-bank rate |
| routes to wrong bank, wrong-bank read is perfect | 0.00 | n/a | ≈1.00 if `WrongBankAcc`=1 | FAIL | **PASS** |
| everything mediocre | 0.55 | 0.55 | ≈0.55 | PASS | PASS |

**Finding R5-3 [I].** The two readings are **different predicates, not ordered
ones**: the `Comp` reading passes a "routing-only system that has lost its
retrieval", which is the exact inverse of the L10 failure shape the criterion was
written to catch; the `MixAcc` reading passes a system that ignores routing and
answers entirely from the wrong bank's map at high accuracy. Neither dominates.

---

## 4. Is a per-cell threshold of 0.50 defensible?

### 4.1 Where the number comes from

| Artifact | Contains 0.50? | Justification given |
|---|---|---|
| `work/L11_READINESS_ASSESSMENT.md:254` | **yes** — "no seed/task cell below 0.50" | **none**; the only gloss is "(the clause that would have caught L10.3's 0.0 cell)" |
| protocol v0.1, specification, preregistration | yes, carried forward | **none** |
| `work/L11_1_PREREGISTRATION.json` `statistical_character` | **L11-A only** | the exact-binomial analysis was performed **only for L11-A**; nothing for L11-C **[V]** |

**Finding R5-4 [V].** The 0.50 threshold has **no documented statistical
derivation and no stated justification**. Its only rationale in the record is
functional: it is the level that would have caught L10.3's 0.0 cell.

### 4.2 What can be said about 0.50 without inventing a justification

Two independent, checkable frames — both **[C]**, computed in this milestone:

**(a) Against the L10-measured context-ignoring floor.** L10.1 established that the
empirical floor is **0.4259**, not 1/6 = 0.167 and not 1/3 = 0.333, because the
permutation structure imposes its own floor **[V]** `L10_1_CONTROL_VALIDATION.md:222`.
A cell at exactly that floor has

```
P(pass L11-C | true = 0.4259, n = 120) = 0.061        [C, exact binomial]
```

so the criterion rejects a floor-level cell **94 % of the time**. That is a real,
defensible job — and it is the job the readiness proposal actually assigned to it.

**(b) At the threshold itself the test is weak.** With n = 120:

| true MixAcc | P(pass) |
|---|---|
| 0.167 (naive chance) | 0.0000 |
| 0.333 (routing chance) | 0.0001 |
| **0.4259 (measured L10 floor)** | **0.0612** |
| **0.50 (the threshold)** | **0.5363** |
| 0.55 | 0.8833 |
| 0.60 | 0.9895 |
| 0.70 | 1.0000 |

Wilson 95 % half-width at p = 0.50 is **≈ 0.088** **[C]**.

**Finding R5-5 [C]/[I].** L11-C at n = 120 is a **discriminating test against the
measured floor (0.426)** and a **coin flip at exactly 0.50** — precisely the
character L11.1 documented for L11-A at 0.90 (`P(pass | 0.90) = 0.5761`). A pass
must therefore be phrased as "**consistent with ≥ 0.50 at n = 120**", never as
"≥ 0.50 established". This mirrors the existing L11-A reporting rule and requires
no new decision — but it must be written into the amendment, because the frozen
text says nothing about intervals for L11-C.

**What I will not do:** I will not invent a derivation showing 0.50 is "the right
number". The evidence does not contain one, and manufacturing one would be exactly
the post-hoc rationalisation the safeguards forbid. **0.50 is defensible only as a
collapse-detector at the L10-measured floor, and that is what the amendment should
say.**

---

## 5. Authorization classification — the central R5 question

The mission requires classifying the change as one of:

1. clarifying an already-authorized metric,
2. restoring an omitted but demonstrably authorized definition,
3. changing an acceptance criterion through a new decision.

### 5.1 Was *any* L11 criterion authorized?

| Check | Result |
|---|---|
| prereg `criteria_candidate.ratification` | **`PENDING_OWNER_DECISION`** **[V]** |
| prereg `status` | `PROTOCOL_FROZEN_FOR_REVIEW / THRESHOLDS_PENDING_OWNER_RATIFICATION` **[V]** |
| protocol §7 | "**Status: PENDING OWNER RATIFICATION.** … it does not itself authorise an official run." **[V]** |
| `owner_decisions_required` | R1 = "L11 thresholds L11-A..L11-G … `blocking: true`" **[V]** |

**Finding R5-6 [V].** **No L11 acceptance criterion has ever been authorized.**
Category 1 — "clarifying an already-authorized metric" — is therefore
**structurally unavailable**: there is no authorized metric to clarify.

### 5.2 Was the `MixAcc` definition itself "demonstrably authorized"?

| Evidence | Supports |
|---|---|
| `L11_READINESS_ASSESSMENT.md:245` heading: "E.8 Fixed pass/fail (**proposed; requires owner ratification before the run**)" **[V]** | the readiness proposal is **explicitly a proposal**, not an authorization |
| `L11_SPECIFICATION_AND_INSTRUMENTATION.md:250` "Candidate criteria (**unchanged from the readiness proposal except where marked**)" and marks only L11-G **[V]** | the *content* of L11-C was intended to carry the readiness wording |
| `git merge-base --is-ancestor ba1cfb3 77d261a` → **true** **[V]** | the readiness proposal precedes and is an ancestor of the freeze |
| frozen and registered text: no metric name **[V]** | the name was lost, not decided away |

**Finding R5-7 [I].** The evidence supports category **2 in substance** — the
`MixAcc` name is a *restoration of a documented definition* that the freeze itself
declared unchanged — but it does **not** support category 2 in *authority*, because
the document being restored was a proposal that was never ratified.

### 5.3 Determination

> **The evidence places L11-C at the boundary between categories 2 and 3, and it
> cannot be assigned conclusively to either.**
>
> - **In content** it is category 2: restoring a definition that is documented,
>   pre-dates the freeze, and was declared "unchanged" by the freeze's own status
>   note.
> - **In authority** it is category 3: since no criterion is authorized, adopting
>   the definition is a **new decision** by the owner, and this milestone may not
>   make it.
>
> **The operative classification for process purposes is category 3** — an owner
> decision is required — **with category-2 evidence as its justification.** The
> limitation is stated explicitly: the repository cannot make the distinction
> sharper, because the only document that could (a ratification record) does not
> exist.

**Finding R5-8 [V]/[I].** The threshold "0.50" is **category 3 without ambiguity**:
it was never authorized, it has no derivation, and any adoption of it is a new
decision. The same is true of R5b's "pooled ≥ 0.75".

---

## 6. Alternatives, and why they are worse or better

| Alternative | Faithfulness to the stated objective | Verdict |
|---|---|---|
| **`MixAcc` per cell, 0.50** | matches the motivating statistic (accuracy collapse beneath a pooled figure) and is the stricter reading on the only non-redundant cell (A3) | **RECOMMENDED** |
| `Comp` per cell, 0.50 | passes "routes perfectly, reads nothing" on A3 | rejected |
| `MixAcc` pooled only (no cell clause) | a global mean can hide a 0.0 cell — the very failure the criterion exists to prevent | rejected |
| Both `Comp` and `MixAcc` conjoined | adds a routing floor on A3 that no criterion asks for; that is a **new requirement**, not a clarification | available to the owner, not recommended here |
| `MixAcc` with a higher threshold | changes a threshold with no new evidence | rejected — threshold changes need explicit ratification and there is no evidence for a different number |
| Leave L11-C undefined | an officially frozen criterion that cannot be evaluated blocks any official run | rejected |

---

## 7. Proposed metric contract (unchanged from L11.4, restated for completeness)

| Property | Value |
|---|---|
| Name | L11-C — per-cell accuracy floor |
| Metric | `MixAcc` |
| Formula | `(1/n) Σ 1[choice == perm_task[queried]]` |
| Unit | cell `(seed, task, arm)` |
| Numerator / denominator | correct rows / ACC-eligible `record_status == OK` rows |
| Arms | A2 (`CROSS21`), A3 (`CROSS31`) — **unchanged from the frozen text** |
| Aggregation | per cell only; never pooled; never a pooled count (protocol §6) |
| Missing data | `n = 0` or a short call ⇒ **INCONCLUSIVE**, never a pass (protocol §7) |
| Threshold | **0.50, unchanged** |
| Valid for `AMBIG11`/`MISLEAD`/`SHUFFLED`? | **no** — `ACC` ineligible for those categories in v0.2 §5; and A4/A6/A7 are not A2/A3 |
| Interaction | implied on A2 by L11-A ∧ L11-D; sole constraint on A3; distinct from L11-B's gap-vs-null predicate |
| Failure reporting | cell, `MixAcc`, `n`, Wilson 95 % interval, and the `Comp`/`Read`/`WrongBankAcc` decomposition; threshold not revisited |
| Statistical phrasing | "consistent with ≥ 0.50 at n = 120", never "≥ 0.50 established" **[C]** |

---

## 8. R5b — kept strictly separate

| Aspect | Finding |
|---|---|
| Where "pooled ≥ 0.75" appears | **only** `work/L11_READINESS_ASSESSMENT.md:254` and its JSON twin **[V]** |
| Present in protocol / specification / preregistration / instrumentation record? | **no** **[V]** |
| Pooling contract defined anywhere? | **no** — "pooled" is never defined for L11-C **[V]** |
| Consistent form available | unweighted mean of the three per-task values, per seed, per arm (protocol §6 forbids pooled counts) |
| Status | **OPEN — not adopted in this milestone.** Separate owner decision. |
| Why separate | it introduces a threshold that was never registered; folding it into a "clarification" is the exact manoeuvre the safeguards forbid |

---

## 9. Decision status

| Item | Status |
|---|---|
| **R5** (metric) | **Open.** Analysed; category 2-in-content / 3-in-authority; owner ratification required. |
| **R5** (threshold 0.50) | **Open.** Category 3 — never authorized, no derivation. Unchanged by this document. |
| **R5b** (pooled 0.75) | **Open.** Not adopted; separate decision. |

**The protocol is not unambiguous, and L11-C is not authorized.** No amendment is
registered. See `work/L11_5_AMENDMENT_DRAFT.md` (UNREGISTERED — PENDING OWNER
DECISION).
