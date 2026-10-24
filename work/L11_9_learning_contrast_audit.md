# STARK-L11.9 — Audit G: Learning Contrasts

**Question:** does any L11 contrast isolate *learning* from additive cue integration,
order, and the default routing?

**Answer: no contrast is measured. None has run. Two of the four cannot be instantiated
with the current code.** No effect-size threshold is invented anywhere below; every
contrast is marked **report-only** and **not an acceptance criterion**.

---

## 1. Contrast inventory

| contrast | hypothesis | held constant | status |
|---|---|---|---|
| **A2 vs A10** | learned weights beat an order-invariant default on CROSS21 | cue set, training data, seeds | **defined** (A10 exists in the spec **[V]**) · **not implemented** · **not authorized** · **not measured** |
| **A2 vs A9** | behaviour survives allocation-order permutation | everything except presentation order | **defined** · **not implemented** on 2:1 cues (**IMP-4**) · **not measured** |
| **CROSS21 vs CROSS31** | the effect scales with the feature-count ratio | training data, seeds | **defined** · **not implemented** (no 3:1 constructor) · **not measured** |
| **additive `bankScores()` vs learned composition** | the observed majority behaviour is or is not explained by summation alone | cue, weights | **not definable today** — there is no product/tensor/bilinear path in `ContextConditionedMemory` **[V]** |

---

## 2. What *is* verified about the arithmetic

`bankScores()` computes `sc[k] = Σ_{f∈cue} w[f][k]` **[V]**. For a cue with two features
from group *t* and one from group *o*, bank *t* wins **whenever the per-feature weights are
group-consistent** — i.e. whenever each feature carries more weight on its own group's bank
than on the others.

**Consequence, stated plainly:** a majority-signature result on CROSS21 is **exactly what
an additive router produces with no composition rule**. Observing it is consistent with
learning, and is equally consistent with the arithmetic of summation. **It is not evidence
for a learned composition rule, and L11.8 never claims it is.**

**What would be needed to make the distinction testable:** a model family that *can*
represent composition (a product or bilinear term), plus an arm with that term disabled.
**`CCBankMode` has four values only — `CC_LEARNED`, `CC_ORACLE`, `CC_FROZEN`,
`CC_UNIFORM_FALLBACK` — and none of them is a composition operator** **[V]**. The
architecture therefore **cannot** express the hypothesis the claim's distinctive prediction
requires, let alone test it.

---

## 3. Residual confounds, per contrast

| contrast | residual confounds | can they be removed by design? |
|---|---|---|
| A2 vs A10 | A10's default rule still sees the same additive weights | **partly** — but A10 shares the arithmetic, so a pass may reflect the router, not learning |
| A2 vs A9 | order affects only tie-breaking under uniform initialisation | **yes**, if A9 is built on the same 3-feature cue |
| CROSS21 vs CROSS31 | ratio and cue length co-vary | **only** with a matched-length control (e.g. 3:1 with a 4th neutral feature) |
| additive vs composition | no composition operator exists | **no** — requires a new model family |

---

## 4. The four statuses, per contrast (kept separate, as required)

| contrast | **defined** | **implemented** | **authorized** | **measured** |
|---|---|---|---|---|
| A2 vs A10 | yes | **no** | **no** | **no** |
| A2 vs A9 | yes | **no** (needs IMP-4) | **no** | **no** |
| CROSS21 vs CROSS31 | yes | **no** (needs IMP-4) | **no** | **no** |
| additive vs composition | **no** | **no** | **no** | **no** |

---

## 5. Report-only ≠ acceptance criterion

Every contrast above is **report-only**. **No threshold, no minimum effect size and no
significance level is proposed**, because none can be justified before the contrast is
measured — inventing one would manufacture a standard from nothing.

If the owner wishes any of these to become a criterion, the required sequence is:
*define an estimand → justify a threshold from prior data or a stated utility → compute
power → register*. **All four steps are absent.**

---

## 6. Recommendation

> **A2 must not be described as a test of learning; it tests whether the composite cue
> resolves as the additive router predicts.** A10 and A9 are report-only contrasts with a
> declared direction and no gate. If the project's scientific claim is that the system
> *learned a composition rule*, **an architecture that can express one must be built
> first** — which is a redesign, not an arm.

**Audit G-1:** the current architecture cannot distinguish the hypothesis from its null.
**Audit G-2:** no arm, no contrast and no threshold addresses this today.
**Consequence for the claim:** the L11 prose is correct to say "emergent from the additive
router". The risk is entirely downstream — a reader of a "PASS" result may infer learning.
**The ratification must therefore forbid the word "composition" in reporting.**

---

## 7. Authorization state (repeated because it is the point)

**No training has occurred. No arm exists. No contrast has been measured. 0 official arms,
0 official trials.** L11.9 adds nothing to this and cannot.
