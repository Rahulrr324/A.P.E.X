# STARK-L11.9 — Audit A: Reconstruction of the Scientific Claim

**Branch:** `validation/l11-9-independent-audit` · **Base:** `ad595ab1` (verified L11.8)
**Nature:** documentation and statistical audit only · **nothing here is authorization**

Sources read directly: `work/L11_8_SCIENTIFIC_CLAIM.md`, `work/L11_8_ACCEPTANCE_MATRIX.md`,
`work/L11_8_CANDIDATE_AMENDMENT.md`, and the source files named below.

Labels: **[V]** verified from a file or the source · **[D]** derived, reproducible with
`work/L11_9_claim_audit.py` · **[P]** proposal under audit · **[U]** unresolved · **[X]** not executed.

---

## 1. The claim, reconstructed

| Field | Content | Status |
|---|---|---|
| **Intended behaviour** | a cue spanning two distinct training signatures, in a 2:1 or 3:1 ratio absent from training, is answered from the signature owning the most cue features, with the answer taken from **that signature's own mapping** | **[P]** (L11.8 AC-1) |
| **Tested task population** | **three fixed tasks** (indices 0,1,2), constructed by the same generator with different permutations; **no sampling frame exists** | **[V]** — `L11_8_SCIENTIFIC_CLAIM.md` §6 |
| **Trial-level outcome** | `correct = 1[choice == perm_task[queried]]`; routing outcome `1[selected_bank == task_bank]` | **[V]** protocol §6, schema v0.2 field 33 / 25 |
| **Experimental unit** | the **training run (seed)**; 3 primary seeds | **[V]** prereg `<seeds.primary>`; L11.8 §6 |
| **Training-run replication** | **n = 3**; 120 trials per cell measure one checkpoint, they do not replicate the procedure | **[V]** |
| **Allocation-order condition** | `Comp(A2) − Comp(A9) ≥ −0.10`, A9 identical except presentation order `[2,1,0]` | **[V]** protocol §4; spec §5 |
| **Retrieval-from-own-mapping condition** | `Read = mean(correct | routing == 1) ≥ 0.90` | **[V]** protocol §6 |
| **What the additive `bankScores()` explains without a learned composition rule** | `sc[k] = Σ_{f∈cue} w[f][k]`, so a cue with two features from group *t* and one from group *o* scores bank *t* higher **whenever the per-feature weights are group-consistent** — majority behaviour follows from summation alone | **[V]** `ContextConditionedMemory.cpp` `bankScores()` |
| **Evidence required for a learning-specific claim** | a matched contrast against a control that has the *same cue* but *no learned routing* (A10), plus evidence that the effect is not the arithmetic consequence of summation (e.g. the A2/A3 ordering) | **[P]** / **[U]** — see `learning_contrast_audit.md` |

---

## 2. The three levels, kept apart

| Level | What it would establish | Current support |
|---|---|---|
| **L1 — observing majority-signature behaviour** | the resolved bank correlates with the feature-count majority | **not observed** — no arm has ever run **[X]**; A2's cue constructor does not exist (§4) |
| **L2 — observing order invariance** | the behaviour survives a change of allocation order | **not observed** — A9 has never run **[X]** |
| **L3 — establishing that learning is necessary** | the behaviour requires the learned router, rather than the additive arithmetic or a default tie-break | **no evidence, and no criterion attempts it** **[V]** |

**The L11.8 claim asserts L1 and L2 and carefully does *not* assert L3** — it states that
R-majority is "emergent from the additive router" and that the claim is about "additive cue
integration, not symbolic composition" **[V]**. **That is honest and is preserved here
without strengthening.** The audit's only addition is to state the consequence plainly:
*a complete pass would not be evidence that the system learned a composition rule.*

---

## 3. Claim-versus-predicate consistency

The L11.8 primary claim reads: *"… in every task, on at least two of the three runs"*,
covering **both** the routing clause and the retrieval clause **[V]**.

The L11.8 candidate contract applies that aggregation to the routing clause **only**:

| Clause | Claim's aggregation | Candidate contract's aggregation |
|---|---|---|
| routing (`Comp`) | ≥ 2 of 3 runs per task | **2 of 3** (AC-2) |
| retrieval (`Read`) | ≥ 2 of 3 runs per task | **all 9 cells** (AC-5 kept the frozen per-cell gate) |

**Finding CA-1 (mismatch between the stated claim and the acceptance predicates)** **[D]**:

| scenario | `pD` per cell | D all-9 | D 2-of-3 | complete, D all-9 | complete, D 2-of-3 |
|---|---|---|---|---|---|
| on target (Comp .90, Read 1.00) | 1.0000 | 1.0000 | 1.0000 | 0.2298 | 0.2298 |
| good (Comp .95, Read 1.00) | 1.0000 | 1.0000 | 1.0000 | 0.9995 | 0.9995 |
| retrieval drop (Comp .90, Read .90) | 0.4788 | 0.0013 | 0.1027 | 0.0000 | 0.0000 |

D's own contribution changes by **79×** between the two aggregations on the retrieval-drop
scenario; the complete-contract total is unchanged there only because the B clause dominates.
**Either the claim's wording must exclude the retrieval clause from the 2-of-3 rule, or
AC-5 must adopt the same aggregation.** This is a genuine inconsistency inside the L11.8
package and is carried as owner decision **MET-12**.

**Finding CA-2 (the claim's robustness concession is not in the predicates' text):** the
claim says "at least two of the three runs", but the L11.8 acceptance matrix's L11-A row
still reads "every task reached 0.90 on ≥ 2 of 3 runs" under PASS while the *frozen* text
remains "every task and every seed". **No frozen file was changed** — correct — but the
claim and the frozen criterion now differ, and only an owner ratification can reconcile them.

---

## 4. A verified implementation finding that bears directly on the claim

**The primary arm's cue does not exist in the code.** **[V]**

`l10_validation_harness.cpp` has one cross-family constructor, `CM_CROSS`:

```cpp
const int b = 4 * task;            // this task's group base
const int b2 = 4 * ot;             // another group's base
cue = {b + (pick_pair(rng_shuf) % 4), b2 + (pick_pair(rng_shuf) % 4)};
```

That is **two features, one from each of two groups — a 1:1 cue**. The frozen construction
table defines 2:1 as `CROSS21` (**three** features) and 3:1 as `CROSS31` (**four**
features). Every other mode emits 0, 1 or 2 features
(`TRAIN` 2, `HOLDOUT` 2, `OFF` 0, `OFF_UNIFORM` 0, `PARTIAL` 1, `SHUFFLED` 2,
`CROSS` 2) **[V]**.

Therefore:

| Item | Consequence |
|---|---|
| `CROSS21` (A2, the primary arm) | **no cue constructor exists** |
| `CROSS31` (A3) | **no cue constructor exists** |
| `AMBIG11` (A4) | the 1:1 *ratio* is what `CM_CROSS` emits, but no AMBIG11 category, rule-bank designation or metric is wired |
| `git grep -c "AMBIG11\|CROSS21\|CROSS31" -- stark/src` | **0** **[V]** |

**So the audit's earlier milestones' phrase "arms not implemented" understates the position:
the measurement instrument itself cannot emit the cue the primary claim is about.** A
cross-family constructor for 3- and 4-feature cues is a **precondition** that appears
nowhere in C1–C7. It is registered here as **IMP-5**.

---

## 5. What the claim does **not** support (unchanged from L11.8, re-verified)

- No inference to a task population — three fixed tasks **[V]**.
- No claim that learning is necessary — no learning contrast is measured **[V]**.
- No "≥ 0.90 established" phrasing — at n = 120 the Wilson half-width at 108/120 is
  **0.0543** **[D]**.
- No claim about ratios, signature counts or tasks outside the battery.

---

## 6. Audit A verdict

| Question | Verdict |
|---|---|
| Is the claim defined? | **yes**, and it is appropriately modest **[P]** |
| Is the claim internally coherent? | **yes**, at the level of prose |
| Do the acceptance predicates match the claim? | **no** — CA-1 (two different aggregation rules) |
| Is the claim testable with the current code? | **no** — the 2:1 and 3:1 cue constructors do not exist **[V]** |
| Is the claim tested? | **no** — 0 arms, 0 trials **[X]** |
| Is population-level generalization claimed? | **no**, correctly **[V]** |
