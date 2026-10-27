# STARK-L11.9 — Audit C: S2 Normalized Gain, Independently Verified

**All arithmetic reproducible:** section *AUDIT C* of `work/L11_9_claim_audit.py`.

```
NG = (MixAcc − Null) / (1 − Null)      rule: NG ≥ 0.75
MixAcc = Comp·Read + (1 − Comp)·WrongBankAcc       (exact identity)
```

---

## 1. The algebra, verified

**Claim under audit:** for `Null < 1`, `NG ≥ 0.75 ⟺ MixAcc ≥ 0.75 + 0.25·Null`.

**Proof.** `(m − n)/(1 − n) ≥ 0.75`. Since `1 − n > 0`, multiply through:
`m − n ≥ 0.75(1 − n)` ⟹ `m ≥ 0.75 + 0.25n`. ∎

**Machine check [D]:** a grid over `Null ∈ [0, 0.99)` in steps of 0.001 × six values of
`MixAcc` — **zero disagreements**. Check `C.1` passes.

**Consequence:** the criterion is equivalent to a floor on `MixAcc` whose slope in the
nuisance parameter is **0.25**, versus **1.00** for the frozen raw-difference rule. Every
statement about the rule can therefore be audited in either form.

---

## 2. Edge cases, each classified **[D]**

| `Null` | required `MixAcc` | status | evaluable? |
|---|---|---|---|
| `0` | 0.7500 | well-defined; **weaker than L11-A's 0.90**, so B would not bind | yes |
| near 0 (`1e-6`) | 0.7500 | stable; derivative `−(1−NG)/(1−Null)` is bounded | yes |
| `1/6` (pure chance, 6 identities) | 0.7917 | well-defined | yes |
| `0.5` (two measured L10.4 cells) | 0.8750 | well-defined; the frozen rule would demand **1.0000** here | yes |
| near one (`0.99`) | 0.9975 | headroom 1 %; estimator sd exceeds the headroom | **technically evaluable, not interpretable** |
| `1` | — | **0/0, UNDEFINED**; excluded from every integral (mass ≈ 1.75 × 10⁻¹⁸⁷) | **no** |
| `> 1` | — | impossible for a proportion ⇒ **INVALID measurement** | no |
| missing forced cell | — | `Null` undefined ⇒ `NG` **INCOMPUTABLE**; never a pass, never a fail | no |
| NaN / ±inf | — | **INVALID**; never a pass | no |
| `Null` from a small number of cells or a different experimental unit | — | not covered by the frozen definition; the protocol fixes three forced cells per (seed, task) | **[U]** |

**Audit finding S2-1:** the `Null` domain is **open at 1 and unbounded above**, and the
proposed text handles both, but **the headroom guard (`Null ≤ 0.75`) only appears in
L11.8 §6.1's candidate specification, not in the acceptance matrix.** It must be in the
ratified text or the criterion is decidable by noise at high `Null`. Carried as **MET-13**.

---

## 3. Pass probabilities, recomputed exactly **[D]**

Enumerating `X ~ Bin(120, MixAcc)` against the exact distribution of the forced-bank sum
`S` (three cells, shape `(1, 1/6, 1/6)`), with the exact rule `12x ≥ 1080 + S`:

| quantity | audit value | L11.8 value | verdict |
|---|---|---|---|
| `P(NG ≥ 0.75 \| true MixAcc = 0.90)` | **0.916360** | 0.9164 | **reproduced** (check C.3) |
| mean `NG` at that point | 0.819849 | — | new |
| exact `sd(NG)` | **0.049634** | 0.0496 (delta method) | **reproduced** (check C.4) |

---

## 4. A new finding: the rule is **boundary-sensitive** **[D]**

At `Null = 1/3` and `MixAcc = 100/120` the criterion holds with **exact equality**
(`(100/120 − 1/3)/(2/3) = 0.75`). Enumerating exactly, there are **20 such states** with
combined probability mass **0.0035**.

| evaluation method | `P(pass \| MixAcc = 0.90)` |
|---|---|
| exact integer rule `12x ≥ 1080 + S` | **0.916360** |
| naive floating-point `(x/120 − nv)/(1 − nv) ≥ 0.75` | **0.914292** |

**Difference: 0.0021.** Floating point silently drops the exact-tie states, which must
**pass** under the stated `≥`.

**Audit finding S2-2 (new, and it affects implementation):** the criterion must be
specified and implemented in **exact/reasoned arithmetic** (`12·X ≥ 1080 + S` for
`n = 120`), or the `≥` convention will be violated on 0.35 % of the sample space. This is
the first L11 acceptance rule found to be *implementation-sensitive at a tie*, and it
belongs in the schema/implementation notes (C-series), not only in prose.

---

## 5. Is the probability conditional on a fixed `Null`?

**Yes, in a specific and limited sense.** **[D]**

- The calculation **integrates over the sampling noise of `Null`** — it enumerates the three
  forced-bank binomials, so the measurement error of the null is accounted for. This is
  stronger than treating `Null` as known.
- It **does not** account for **model-to-model variation of the true null**. Each seed
  produces a different checkpoint, hence a different true `Null(t)`. The calculation fixes
  the true null shape at `(1, 1/6, 1/6)`.
- The test is therefore conditionally calibrated, and the conditional is:
  *given a checkpoint whose true forced-bank accuracies are `(1, 1/6, 1/6)`*.

**Audit finding S2-3:** the report must state this conditional explicitly. The L10.4
measurements show the true null ranging **0.3333–0.5000** across the nine cells **[V]**; the
probability at `MixAcc = 0.90` varies correspondingly, and the frozen figure does not
screen that.

---

## 6. Threshold provenance — precedent, **not** derivation

| question | answer |
|---|---|
| Is 0.75 derived from L11 evidence, theory or simulation? | **no** **[V]** |
| Is there a precedent in the record? | **yes** — L10-K1 justified its CAA threshold as **72 % of headroom** and called it "deliberately far above the null and below the ceiling" **[V]** |
| Is 0.75 "statistically derived"? | **no.** It is an **analogy to a precedent**. |

**Audit finding S2-4:** L11.8 already makes this distinction; Audit C confirms it is
correct and that it must survive into the ratified text. **A precedent-anchored threshold
is a defensible owner choice; calling it calibrated would be false.**

---

## 7. Audit C verdict

| Check | Result |
|---|---|
| Algebra `NG ≥ 0.75 ⟺ MixAcc ≥ 0.75 + 0.25 Null` | **verified** (0 disagreements on a 6000-point grid) |
| Edge cases classified | **verified**, with one gap: the headroom guard is missing from the matrix (**MET-13**) |
| `P = 0.9164` at `MixAcc = 0.90` | **reproduced exactly** (0.916360) |
| `sd(NG) = 0.0496` | **reproduced** (0.049634 exact vs 0.0496 delta) |
| Conditional-on-fixed-null caveat | **confirmed and must be stated** |
| Threshold 0.75 | **precedent, not derivation** — confirmed |
| Boundary/tie behaviour | **new defect found**: float implementation under-counts by 0.0021 |
