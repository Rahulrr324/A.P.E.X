# STARK-L11.7 — L11-C and `MixAcc`: diagnostic audit and alternatives

**Nature:** analysis only. **No threshold is changed. Nothing is ratified.**

Labels: **[V]** verified · **[D]** derived · **[P]** proposed · **[U]** unresolved · **[X]** not executed.

---

## 1. The formula, verified

Protocol §6 **[V]**:

    MixAcc = correct = (1/n) Σ 1[choice == perm[queried]]
    Comp   = (1/n) Σ 1[selected_bank == task_bank]
    Read   = mean(correct | routing == 1)

Since every trial is either routed or not,

    **MixAcc = Comp · Read + (1 − Comp) · WrongBankAcc**     [D]

with `WrongBankAcc = mean(correct | routing == 0)`. This identity is exact and is the
key to everything below: `MixAcc ≥ 0.50` is a **weighted average of a routing gate and
a retrieval gate, with the weights set by the model's own routing rate.**

`MixAcc` is also exactly the number L10.3 published as **0.5611** for the cross cue.
**L11-C's threshold is a floor on the very quantity L11 exists to replace.**

---

## 2. Diagnostic table **[D]**

`WrongBankAcc = 0.132` where the L10.3 measured value applies, `1/6` where a raw chance
comparison is wanted.

| # | Model behaviour | Comp | Read | Wrong | **MixAcc** | vs 0.50 |
|---|---|---|---|---|---|---|
| 1 | perfect routing, perfect retrieval | 1.000 | 1.000 | 0.167 | **1.000** | PASS |
| 2 | **perfect routing, retrieval fails entirely** | 1.000 | 0.000 | 0.167 | **0.000** | **FAIL** |
| 3 | routing fails entirely, conditional retrieval perfect | 0.000 | 1.000 | 0.167 | **0.167** | FAIL |
| 4 | chance routing and chance retrieval | 0.333 | 0.167 | 0.167 | **0.167** | FAIL |
| 5 | **routing 0.50 uniform, retrieval perfect** | 0.500 | 1.000 | 0.132 | **0.566** | **PASS** |
| 6 | L10.3 pooled (routing 0.5019, Read 1.0) | 0.502 | 1.000 | 0.132 | **0.568** | PASS |
| 7 | L10.3 task 0 (routing 0.0, Read undefined) | 0.000 | n/a | 0.132 | **0.132** | FAIL |
| 8 | structurally undefined: `Comp = 0` in a cell | 0.000 | **UNDEFINED** | — | 0.132 | FAIL |
| 9 | empty call (`n = 0`) | — | — | — | **INVALID** | not computable |

### 2.1 Three properties, assessed

| Property | Verdict |
|---|---|
| **Bounded** | **Yes.** `MixAcc ∈ [0,1]` always, with a floor of `WrongBankAcc ≥ 1/6` under random permutations. It is a genuine proportion. |
| **Interpretable** | **Partly.** It is plain accuracy on composition cues — the most readable of the three metrics. But it is a *composite*: rows 2 and 5 have the same `MixAcc` (0.000 vs 0.566 are different, but note row 3 and row 4 are **exactly equal** and denote opposite failures: no routing at all vs chance everywhere). |
| **Comparable across cells** | **Yes, and better than `Read`.** Its denominator is always 120, so it has no varying-`n` problem. This is a real virtue `Read` lacks. |

### 2.2 Cells with different numbers of eligible retrieval opportunities

`MixAcc` is **immune** — it always uses all valid rows. `Read` is **not**: its `n` is
`120 × Comp`, which in the measured L10.3 configuration was 0, 60 and 120 in the three
cells. So on this specific axis `MixAcc` is the more robust statistic — but it buys that
robustness precisely by **not distinguishing routing from retrieval**.

---

## 3. The non-monotonicity, explained exactly

Because `MixAcc = Comp·Read + (1−Comp)·WrongBankAcc`, the derivative with respect to
`Comp` is `Read − WrongBankAcc`:

- **If `Read > WrongBankAcc`** (normal), raising `Comp` **raises** `MixAcc`.
- **If `Read < WrongBankAcc`** — the model does *better* on the wrong bank than on the
  right one — raising `Comp` **lowers** `MixAcc`.

So a change in model behaviour that **improves routing can lower the metric**, and the
criterion will punish it. Concretely:

| change in behaviour | effect on `MixAcc` | effect on the science |
|---|---|---|
| routing improves from 0.50 → 0.90, retrieval unchanged at 0.50, `Wrong = 0.60` | 0.55 → **0.51** | better model, worse score |
| retrieval improves from 0.00 → 0.60 at `Comp = 1` | 0.17 → 0.60 | good |
| routing improves 0.50 → 1.00 with `Read = 1.0`, `Wrong = 0.13` | 0.566 → 1.000 | good |
| a cell's `WrongBankAcc` rises from 0.13 to 0.40 (wrong-bank leakage) | `MixAcc` **rises** | **leakage rewarded** |

**The last row is the dangerous one.** `MixAcc` can be raised by making the model answer
correctly *without* resolving the signature — i.e. by leaky retrieval. That is the exact
failure mode L11 exists to detect, and `MixAcc` rewards it.

**Verified consequence [D]:** L10.3's published 0.5611 **would pass** a 0.50 floor. The
only reason L11-C rejects the L10.3 state is that the failure is *task-structured* —
`Comp` = 0 for task 0, so `MixAcc` = 0.132 there. **If the same 0.50 routing rate had
been spread evenly across tasks, L11-C would have passed the failure it was written to
catch.**

---

## 4. Threshold justification — the honest accounting

| quantity | value | source |
|---|---|---|
| measured context-ignoring null `E[Null] = 4/9` | **0.4444** | protocol §6 + L10.4 **[V]** |
| per-identity chance | 0.1667 | 6 identities **[V]** |
| L11-C floor | 0.5000 | frozen **[V]** |
| headroom above the context-ignoring null | 0.5556 | **[D]** |
| **fraction of headroom the 0.50 floor consumes** | **10.0 %** | **[D]** |
| L11-A's 0.90 consumes | 82.0 % | **[D]** |

**A floor at 0.50 requires the model to beat a context-ignoring policy by only one tenth
of the available range.** It is 0.0556 above a policy that ignores the cue entirely.

The repository contains **no derivation of 0.50** [V]. The L11.6 finding stands: the only
recorded rationale is functional ("the clause that would have caught L10.3's 0.0 cell"),
and that cell was 0.132 — i.e. the criterion was sized to catch a *catastrophe*, not a
*shortfall*.

---

## 5. Statistical character of `MixAcc ≥ 0.50` **[D]**

| true `MixAcc` | per-cell `P(≥60/120)` | joint over 18 cells | joint over 9 |
|---|---|---|---|
| 0.45 | 0.1564 | 3.2 × 10⁻¹⁵ | 5.6 × 10⁻⁸ |
| **0.50** | **0.5363** | **1.3 × 10⁻⁵** | 3.7 × 10⁻³ |
| 0.55 | 0.8833 | 0.107 | 0.327 |
| 0.60 | 0.9895 | **0.828** | 0.909 |

Read as eighteen conjunctive cells, a criterion that *looks* like a 0.50 floor is
effectively a **0.57–0.58 requirement**. This reproduces L11.6 and stands as [D].

---

## 6. Alternatives **[P]** — none adopted

| ID | Definition | Scientific purpose | Threshold justification | Decision rule | Effect on joint acceptance |
|---|---|---|---|---|---|
| **C0** | status quo: `MixAcc ≥ 0.50` on 18 cells | a floor on composition accuracy | **none exists**; 10 % of headroom | per-cell gate, no α | dominant term is `Comp`; near-vacuous given A |
| **C1** | **drop L11-C** | route and retrieval are already gated separately by A and D | — | — | removes 18 predicates; **no loss of coverage** given A ∧ D |
| **C2** | restrict to the **A3/`CROSS31`** cells only (9 cells) | A3 has no other criterion; this is C's only non-redundant content | inherits the undeclared 0.50 | per-cell gate | shrinks the conjunction by 9 |
| **C3** | headroom-normalised: `(MixAcc − Null)/(1 − Null) ≥ τ` | makes τ comparable across cells and immune to the nuisance baseline | τ ∈ [0,1] has a natural meaning (fraction of attainable improvement) | per-cell gate on a standardised effect | comparable; **new metric definition**, needs a name and schema support |
| **C4** | raise the absolute floor, e.g. 0.75 | 55 % of headroom | would need a derivation | — | **requires changing a frozen number — not permitted in this milestone** |
| **C5** | `Comp ≥ 0.90` **and** `Read ≥ 0.90` explicitly (i.e. A and D, stated as the routing/retrieval gates) | separates the two failure modes; each gate interpretable | already frozen (A and D) | separate gates | already present; C adds nothing |

### 6.1 Recommendation **[P]**

**C5, plus C2 as a retained residual gate.** That is:

- routing is gated by L11-A (0.90) and order-invariance by L11-G;
- retrieval is gated by L11-D (0.90) **with its denominator reported**;
- `MixAcc` is **reported** on every arm as the headline composition number — the number
  L10.3 published — but is **not** an acceptance criterion on A2;
- a single residual floor is retained **on A3 only** (the arm nothing else gates).

**Why not simply "choose the metric with the best pass probability"?** Because that is
not the question. `MixAcc` is not *wrong* — it is the honest headline number, and it is
the most robust of the three against varying denominators. What is wrong is using it as
a **gate**, because (i) it cannot separate routing from retrieval, (ii) it rewards
wrong-bank leakage, (iii) its floor is 10 % of headroom and sits 0.056 above a
context-ignoring policy, and (iv) it is redundant with A ∧ D on the primary arm.

**The one place it is not redundant — A3 — is the one place it should be kept.**

---

## 7. Ownership

| item | status |
|---|---|
| `MixAcc` ever authorised | **no** [V] |
| 0.50 threshold derivation | **does not exist** [V] |
| R5 (L11-C metric decision) | **open**, carried forward |
| R5b (pooled ≥ 0.75) | **open**, deferred, and not touched here |
| C1–C5 above | **[P] — proposals only** |
