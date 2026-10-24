# STARK-L11.8 — S2: Normalized Gain Against a Measured Null

**Nature:** analysis only. **No threshold adopted.** **[P]** for every candidate.

---

## 1. The formula, and why it is the right shape

    NormalizedGain  NG = (MixAcc − Null) / (1 − Null)

`Null` is measured (protocol §6: OFF trials with each bank forced in turn, three forced
cells averaged equally) **[V]**. Because one forced cell is the **aligned** bank,
`E[Null] = (1 + 1/6 + 1/6)/3 = 4/9 = 0.4444` **[D]** — the null is not a chance floor,
it is chance *plus a certainty*.

`NG` is the **fraction of attainable headroom** the model closes: 0 = behaves exactly like
a context-ignoring policy, 1 = perfect, negative = worse than ignoring the cue.

The frozen criterion is `MixAcc − Null ≥ 0.50`, a **raw** difference. Rewriting each as a
floor on `MixAcc`:

| Rule | Implied `MixAcc` floor | Slope in `Null` |
|---|---|---|
| frozen raw | `MixAcc ≥ Null + 0.50` | **1.00** |
| normalized (τ = 0.75) | `MixAcc ≥ 0.75 + 0.25 · Null` | **0.25** |

---

## 2. Behaviour at the required values of `Null` **[D]**

| `Null` | `NG ≥ 0.75` needs `MixAcc` | headroom used by NG rule | `MixAcc` needed by frozen raw rule | headroom used by raw rule |
|---|---|---|---|---|
| 0.0000 | 0.7500 | 75 % | 0.5000 | 50 % |
| 0.0500 | 0.7625 | 75 % | 0.5500 | 53 % |
| 1/6 = 0.1667 | 0.7917 | 75 % | 0.6667 | 60 % |
| 0.2500 | 0.8125 | 75 % | 0.7500 | 67 % |
| 1/3 = 0.3333 | 0.8333 | 75 % | 0.8333 | 75 % |
| **4/9 = 0.4444** | **0.8611** | 75 % | **0.9444** | **90 %** |
| 0.5000 | 0.8750 | 75 % | **1.0000** | **100 %** |
| 0.6000 | 0.9000 | 75 % | 1.1000 — **impossible** | — |
| 0.7500 | 0.9375 | 75 % | 1.2500 — impossible | — |
| 0.9000 | 0.9750 | 75 % | 1.4000 — impossible | — |
| **1.0000** | **0/0 — UNDEFINED** | — | 1.5000 — impossible | — |

### 2.1 Each case examined

- **`Null = 0`** — NG reduces to `MixAcc ≥ 0.75`. Well-behaved, but note that this would be
  **weaker than L11-A's 0.90**, so on such a cell L11-B would not bind. A `Null` of 0 is
  structurally impossible here (the aligned forced cell is 1.0), so this is a hypothetical.
- **`Null` near 0** — stable; `dNG/dNull = −(1−NG)/(1−Null) ≈ −(1−NG)`, bounded.
- **`Null = 0.50`** — the measured value on two cells **[V]**. Frozen rule demands
  `MixAcc = 1.0000`, i.e. 120/120. NG demands 0.8750. **This single row is the entire
  L11-B pathology.**
- **`Null` near 1** — the denominator collapses; the requirement runs to 1.000 and beyond,
  and the estimator's variance explodes. **A validity domain is required.**
- **`Null = 1`** — 0/0. Must be a **structural NA**, never a pass, never a fail.
- **Missing / structurally undefined** — `Null` needs all three forced cells. If any is
  absent, `Null` is undefined, so `NG` is undefined, so the criterion is
  **INCOMPUTABLE** — not a fail. The frozen text says nothing about this **[U]**.
- **Noisy / seed-dependent `Null`** — §3.

---

## 3. Sensitivity to `Null` estimation error **[D]**

`Null` is estimated from 3 × 120 forced trials, so its standard error is
`sd(Null) = sqrt(Σ_k p_k(1−p_k)/120)/3`. For the protocol's own shape
`(1, 1/6, 1/6)`: **sd(Null) = 0.0160**. Meanwhile `sd(MixAcc) = sqrt(0.9·0.1/120) = 0.0274`.

| `Null` shape | `E[Null]` | `sd(MixAcc)` | `sd(Null)` | amplification `1/(1−Null)` | `sd(NG)` |
|---|---|---|---|---|---|
| (0,0,0) | 0.0000 | 0.0274 | 0.0000 | 1.000 | 0.0274 |
| (1/6,1/6,1/6) | 0.1667 | 0.0274 | 0.0196 | 1.200 | 0.0330 |
| **(1, 1/6, 1/6)** | **0.4444** | 0.0274 | 0.0160 | **1.800** | **0.0496** |
| (0.5, 1/6, 1/6) | 0.2778 | 0.0274 | 0.0221 | 1.385 | 0.0382 |

**The normalized criterion nearly doubles the noise of the underlying proportion** (sd
0.0274 → 0.0496 at the real null shape). That is the price of removing the nuisance
parameter from the threshold. Two consequences the owner must accept:

1. `NG` is a **noisier statistic than `MixAcc`**, so a threshold on it should be further
   from 1 than a naive reading suggests.
2. **`Null` must be reported with its own uncertainty**, and the criterion should be
   applied to a *joint* confidence statement, not to a point ratio (candidate below).

---

## 4. Exact pass probabilities for `NG ≥ 0.75` **[D]**

Enumerated exactly: `X ~ Bin(120, MixAcc)` and the three forced cells, with
`NG ≥ 0.75 ⟺ X ≥ 90 + S/12` where `S` is the sum of the three forced-bank counts.

| true `MixAcc` | null shape `(1, 1/6, 1/6)` | `(1/6,1/6,1/6)` | `(0.5,1/6,1/6)` |
|---|---|---|---|
| 0.85 | **0.3816** | 0.9577 | 0.8256 |
| 0.90 | **0.9164** | 0.9998 | 0.9963 |
| 0.95 | 0.9999 | 1.0000 | 1.0000 |

**This is the decisive contrast with the frozen rule.** Under the frozen criterion the
per-cell pass probability at `MixAcc = 0.90` on the `Null = 0.50` cells is ~10⁻⁶ (it needs
120/120); under the normalized criterion it is **0.38–0.92**. The normalized rule is
**satisfiable**, and it is still demanding.

---

## 5. Is 0.75 justified?

**Honest answer: it has a precedent, not a derivation.**

- It is **75 % of attainable headroom**, a construction the record already uses: L10-K1's
  CAA threshold was justified as **72 % of headroom** and described as "deliberately far
  above the null and below the ceiling" **[V]**.
- It is **not** derived from any L11 measurement, simulation or theory **[V]**.
- It produces a floor of `MixAcc ≥ 0.8611` on the protocol's actual null, which sits just
  below L11-A's 0.90 — so L11-B binds only on cells where the composition is measurably
  better than a context-ignoring policy but the routing gate is already the stronger
  constraint. That redundancy should be acknowledged, not hidden.

**Verdict: 0.75 is a defensible choice with a stated rationale (headroom fraction,
matching the L10-K1 precedent) — and it is still a choice.** It must be ratified as such,
never presented as derived.

---

## 6. Alternatives compared **[P]**

| ID | Candidate | Strength | Weakness | Recommended? |
|---|---|---|---|---|
| **N0** | frozen: `MixAcc − Null ≥ 0.50` | simple | slope 1 in a measured nuisance; **infeasible at Null = 0.50** | no |
| **N1** | report `MixAcc` and `Null` separately, **no gate** | no invented threshold; fully transparent | no criterion at all — the scientific claim loses its "beats a null" content | **as reporting: yes** |
| **N2** | pre-specified absolute minimum gain, e.g. `MixAcc − Null ≥ 0.40` | simple; slope 1 but smaller | still a raw difference; at `Null = 0.50` needs 0.90 — workable but arbitrary | possible |
| **N3** | **normalized gain with an explicit domain and validity policy** | slope 0.25; constant meaning; removes the nuisance | noisier (sd 0.0496); undefined at `Null = 1` | **yes, as the gate** |
| **N4** | run-level matched contrast, `MixAcc(A2) vs MixAcc(A10)` | paired on the same cues; isolates *learning* | tests a **different claim** (learned vs default), not "beats a null" | as a **separate** criterion (§8 of the claim doc) |

### 6.1 Candidate specification for N3 **[P]**

```
Metric:  NG(t) = (MixAcc(A2,t) − Null(t)) / (1 − Null(t))
Domain:  defined iff all three forced-bank cells for (seed, task) are present,
         each with n = 120, and Null(t) < 1.
Validity: if Null(t) > 0.75 (headroom < 0.25) the cell is reported NOT INTERPRETABLE
          and the criterion is INCONCLUSIVE for that cell.  Never imputed.
Missing: any missing forced cell -> INCOMPUTABLE, never a pass, never a fail.
Decision: NG(t) ≥ 0.75 on at least two of the three tasks, on every seed,
          with Null(t) reported with its standard error beside every value.
Reporting: MixAcc(t), Null(t) ± se, NG(t) and its approximate se all printed;
          the joint power at a true NG of 0.75 printed with the result.
```
The `Null ≤ 0.75` guard is not cosmetic: at `Null = 0.9` the required `MixAcc` is 0.975 and
the estimator's sd exceeds the headroom, so the criterion would be decided by noise.

---

## 7. The smallest set of criteria that carries the claim **[P]**

The scientific claim (claim doc §4) is: *resolves to the majority owner, retrieves from
it, every task, robust to one run.* Mapped to the smallest sufficient set:

| # | Criterion | Carries |
|---|---|---|
| 1 | **A** — `Comp(CROSS21) ≥ 0.90`, every task, 2 of 3 seeds | the routing claim |
| 2 | **B** — `NG ≥ 0.75`, ≥ 2 of 3 tasks, every seed | routing beats a context-ignoring policy |
| 3 | **D** — `Read ≥ 0.90` with `n_elig ≥ 30` | the retrieval guard |
| 4 | **G** — `Comp(A2) − Comp(A9) ≥ −0.10` (paired) | order invariance |

plus deterministic **E** (reruns) and suite-level **F** (regressions).

**Removed:** L11-C as a separate 0.50 floor (redundant with A ∧ D on A2, vacuous — see the
S3 document).
**Reported but not gating:** pooled battery accuracy, `MixAcc`, `Null`, `Read` denominator,
`AMBIG11`, `A2`/`A10`, `A2`/`A3`.

**Net effect: 5 statistical predicates replaced by 4, all of which are load-bearing.**

---

## 8. Status

**`NG ≥ 0.75` is PROPOSED. It is not adopted, not registered, and not applied. The frozen
`MixAcc − Null ≥ 0.50` remains the operative text — and remains near-infeasible.**
