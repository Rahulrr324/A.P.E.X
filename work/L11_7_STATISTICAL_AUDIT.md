# STARK-L11.7 — Statistical Validity Audit of the L11 Acceptance Contract

**Branch:** `validation/l11-7-statistical-audit` · **Base:** `1f566893` (verified L11.6)
**Nature:** documentation only · no source, harness, test, protocol or preregistration change
**Every number in this document is produced by `work/L11_7_power/stat_audit.py`; the
transcript is `work/L11_7_power/stat_audit_output.txt`.**

> **No figure here is a measurement of STARK.** Nothing in this milestone was executed.
> Power calculations are properties of the *design*, computed from the documented `n`.
> `NOT EXECUTED` applies to every trial, every arm, every test, every build.

Labels: **[V]** VERIFIED from a file · **[R]** REPORTED but not reproduced ·
**[D]** DERIVED (arithmetic, shown) · **[P]** PROPOSED · **[U]** UNRESOLVED ·
**[X]** NOT EXECUTED.

---

## 0. What the contract actually says (frozen text, quoted)

From `stark/design/l11_cross_signature_compositional_generalization.md` §6 **[V]**:

| ID | Criterion | Cells |
|---|---|---|
| L11-A | `Comp(A2, t) ≥ 0.90` on every task `t` and every seed | 3 × 3 = **9** |
| L11-B | `MixAcc(A2, t) − Null(t) ≥ 0.50` on at least two of three tasks, on every seed | 3 seeds × (2 of 3) |
| L11-C | no cell `(seed, task)` in A2 or A3 below **0.50** *(no metric named)* | 3 × 3 × 2 = **18** |
| L11-D | `Read(A2, t) ≥ 0.90` on every task and seed | **9** |
| L11-E | reruns byte-identical; checkpoint/resume exact | deterministic |
| L11-F | no new failures vs the L10 regression baseline | suite |
| L11-G | `Comp(A2) − Comp(A9) ≥ −0.10` on every seed | **3** |

Design constants **[V]**: `n = 120` trials per (task, cue category); 3 tasks; 3 primary
seeds (`123456789`, `218213831`, `171473193`); 6 identities, so per-identity chance is
`1/6`; `Null(t)` is a **measured** quantity, not a constant.

**No significance level, no test statistic, no power target, no multiplicity control
appears anywhere in the frozen criteria.** That absence is the subject of this audit.

---

## 1. L11-A — per-cell power, reconstructed

`P(pass) = P(X ≥ 108 | X ~ Bin(120, p))`, exact binomial **[D]**:

| true `p` | 0.80 | 0.85 | 0.875 | 0.88 | 0.90 | 0.92 | 0.93 | 0.95 | 0.97 |
|---|---|---|---|---|---|---|---|---|---|
| `P(pass)` | 0.0025 | **0.0746** | 0.2509 | 0.3059 | **0.5761** | 0.8367 | 0.9225 | **0.9928** | 0.9999 |

**L11.1's published triple reproduces exactly: 0.9928 / 0.5761 / 0.0746 [V].**

Wilson 95 % interval at an observed 108/120 is **(0.8333, 0.9419)**, half-width 0.0543 —
matching the specification's "≈5.4 pp" **[V]**. The specification's own caveat is
correct and should be retained: a pass is "consistent with ≥ 0.90 at n = 120", never
"≥ 0.90 established".

### 1.1 Four different questions that the word "pass" conflates

| Question | Form | Answer for 108/120 |
|---|---|---|
| **Minimum-performance demonstration** | does the observed rate clear a fixed line? | yes iff ≥ 108/120. **This is what the protocol says.** |
| **Test against a null** | `H0: p ≤ p0` vs `H1: p > p0` | 108/120 is a one-sided 5 % test of `H0: p ≤ 0.8430` **[D]** — *not* of `p ≤ 0.90`. Against `p0 = 0.90` its size is **0.5761**, i.e. it is not a 5 % test at all. |
| **Require every cell** | conjunction of 9 gates | §2 |
| **Estimate joint success probability** | `P(all 9 pass)` | §2 — needs a dependence assumption the protocol never states |

**This is the central ambiguity.** "≥ 0.90 on every task and every seed" is a
*screening gate*, and it is a perfectly respectable one: it is nearly silent about a
model at 0.85 (7.5 % pass) and nearly certain for a model at 0.95 (99.3 %). But it is
**not** a hypothesis test at any stated level, and its 42.4 % failure rate at exactly
0.90 is not a "false failure" — a model sitting exactly on the bar is precisely the case
the bar cannot resolve at n = 120.

### 1.2 The non-inferiority reading — the most defensible one available

108/120 is exactly a one-sided 5 % test of `H0: p ≤ 0.8430` **[D]**. Read that way, the
frozen threshold is **a non-inferiority gate with a ~5.7 pp margin below 0.90**, and the
ratio `0.8430/0.90` is fixed by `n` and the threshold, not chosen.

This reading has a consequence the owner should see: **the gate demonstrates
"better than 0.843", not "at least 0.90".** The specification already says this in
words; the arithmetic confirms it.

---

## 2. Joint power — and why the number 0.00699 is conditional

L11.6 reported a joint power of **0.00699** and called the "coin flip at 0.90" not a
coin flip. **The arithmetic reproduces exactly: 0.5761⁹ = 6.987 × 10⁻³ [V].**
But that number is the product of nine marginals, and a product of marginals is the
joint probability **only under independence**.

For an intersection of nine events each of probability `q`, the only distribution-free
statement is the Fréchet pair

    max(0, 9q − 8) ≤ P(all) ≤ q

At `q = 0.5761` that is **[0, 0.5761]**. Independence (0.0070) is one point *inside* a
range whose upper end is 82× larger. Under an equicorrelated Gaussian copula **[D]**:

| `q(0.90)` | ρ=0 | ρ=0.3 | ρ=0.6 | ρ=0.9 | ρ=1 |
|---|---|---|---|---|---|
| 0.5761 | 0.0070 | 0.0748 | 0.1931 | 0.3872 | 0.5761 |

**Which assumption is right?** The nine cells are not exchangeable. They are three
training runs × three fixed tasks. Cells sharing a task share task difficulty; cells
sharing a seed share a trained network. Both are *positive* dependence, and positive
dependence in an intersection **raises** the joint probability. Therefore:

> **0.00699 is a lower bound among the "cells are conditionally independent" family, and
> a severe understatement under any plausible within-seed correlation. It is not a
> bound in general (the Fréchet lower bound is 0), and it is not implied by the
> protocol, which says nothing about dependence.**

The scientifically honest statement is: **the joint probability of a complete L11-A
pass at a true uniform 0.90 lies somewhere in [0, 0.58], with 0.007 the value under
independence and ~0.19–0.39 under moderate-to-strong positive correlation.** L11.6's
0.00699 should be re-read as **[D, conditional]**, not as a design fact.

### 2.1 Required per-cell accuracy for a stated joint power (independence) **[D]**

| desired joint power | required per-cell `q` | required true `p` |
|---|---|---|
| 0.50 | 0.9259 | **0.9305** |
| 0.80 | 0.9755 | **0.9412** |
| 0.90 | 0.9884 | 0.9468 |
| 0.95 | 0.9943 | 0.9514 |

**The contract as written requires a true per-cell accuracy near 0.94 to be passed 80 %
of the time.** That is the price of a nine-fold conjunction at n = 120. Nothing in the
frozen artifacts acknowledges it.

---

## 3. The four required cases

| Case | Assumption | Joint `P(pass)` |
|---|---|---|
| **1. All cells exactly at target** (p = 0.90) | independence | **0.0070** |
| | Fréchet bounds | **[0, 0.5761]** |
| | comonotone | 0.5761 |
| **2. Some at target, some worse** (6 at 0.95, 3 at 0.88) | independence | **0.0274** |
| | comonotone (bounded by worst cell) | 0.3059 |
| **3. Correlated** (all marginals 0.90, copula ρ) | ρ = 0.3 / 0.6 / 0.9 | 0.0748 / 0.1931 / 0.3872 |
| **4. Genuine performance above target** | 0.95 / 0.97 / 0.99 | **0.9371** / 0.9994 / 1.0000 |

Reading of case 2: because the criterion is a conjunction, **three cells at 0.88 destroy
the design** — a model that is 0.95 on six cells has a 2.7 % chance of a complete pass.
The contract is governed entirely by its worst cell, which is a defensible *scientific*
choice ("no task may be neglected") but a catastrophic *statistical* one at this `n`.

Case 4 is the mitigating fact: **at 0.95 the contract is passed 94 % of the time.** So
the contract is not "impossible"; it is a **high-bar design that demands roughly 0.95,
not 0.90**, and its nominal threshold does not describe its operating point.

---

## 4. L11-B — the most serious defect found in this milestone

### 4.1 What `Null(t)` is

Protocol §6 **[V]**:

> `Null(t) = mean(correct)` over `OFF` trials with each bank forced in turn
> (three forced cells averaged equally) — the measured context-ignoring null.

One of the three forced cells is the **task's own bank**, which answers perfectly on an
empty cue. Hence

    E[Null(t)] = (1 + 1/6 + 1/6)/3 = 4/9 = 0.4444

**not 1/6.** The null is not a chance floor; it is a chance floor *plus a certainty*.

### 4.2 Measured values **[V]**

`work/L10_4_OFFICIAL_EVALUATION.md` lines 117–124, same three primary seeds, same
forced-bank construction, 120 trials per cell:

| seed | `Null(0)` | `Null(1)` | `Null(2)` |
|---|---|---|---|
| 123456789 | **0.5000** | 0.4444 | **0.5000** |
| 218213831 | 0.4444 | 0.3917 | 0.3889 |
| 171473193 | 0.3333 | 0.3889 | 0.3889 |

Pooled 0.425926. **[U]** whether the L11 A8 arm will reproduce these exactly; the
matched configuration suggests it will, but that is a prediction, not a measurement.

### 4.3 What the criterion therefore requires

`MixAcc(A2,t) ≥ Null(t) + 0.50`, per cell **[D]**:

| seed | required MixAcc (t0/t1/t2) | required count /120 |
|---|---|---|
| 123456789 | **1.0000 / 0.9444 / 1.0000** | **120 / 114 / 120** |
| 218213831 | 0.9444 / 0.8917 / 0.8889 | 114 / 108 / 107 |
| 171473193 | 0.8333 / 0.8889 / 0.8889 | 100 / 107 / 107 |

Expressed as an implied routing requirement (with `Read = 1.0` and the L10.3-measured
`WrongBankAcc = 0.132`, since `MixAcc = Comp·Read + (1−Comp)·WrongBankAcc`):

| required MixAcc | implied `Comp` |
|---|---|
| 1.0000 | **1.0000 — requires 120/120** |
| 0.9444 | 0.9359 |
| 0.8917 | 0.8752 |
| 0.8333 | 0.8079 |

**On seed `123456789`, two of the three tasks have `Null = 0.5000`, so the criterion
demands `MixAcc = 1.0000` — a perfect 120/120 — and the "two of three tasks" rule still
requires one of them to deliver it.** There is no headroom: the maximum attainable
difference on those cells is exactly `1 − 0.5000 = 0.50`, which is exactly the threshold.

### 4.4 Headroom, stated as a fraction

| cell | headroom `1 − Null` | threshold 0.50 consumes |
|---|---|---|
| `Null = 0.5000` | 0.5000 | **100 %** |
| `Null = 0.4444` | 0.5556 | 90 % |
| `Null = 0.3889` | 0.6111 | 82 % |
| `Null = 0.3333` | 0.6667 | 75 % |

Compare L10-K1's CAA threshold, which was justified in the record as **72 % of the
headroom** and was described as "deliberately far above the null and below the ceiling"
**[V]**. L11-B's threshold is **75–100 % of the headroom**, and the frozen record gives
**no justification for it at all**.

### 4.5 Power of L11-B under the measured nulls **[D]**

`P(≥2 of 3 tasks)` per seed, at a uniform true `MixAcc`, then joint over three seeds:

| true MixAcc | seed 123456789 | seed 218213831 | seed 171473193 | **joint** |
|---|---|---|---|---|
| 0.90 | 0.00000 | 0.4140 | 0.8988 | **9.2 × 10⁻⁸** |
| 0.93 | 0.00009 | 0.9133 | 0.9983 | 7.8 × 10⁻⁵ |
| 0.95 | 0.00257 | 0.9961 | 1.0000 | **2.6 × 10⁻³** |
| 0.97 | 0.04751 | 1.0000 | 1.0000 | 4.8 × 10⁻² |
| 0.99 | 0.50904 | 1.0000 | 1.0000 | **0.509** |

**L11-B is, in effect, a requirement for ~0.99 accuracy.** A model achieving 0.95
everywhere passes L11-B with probability 0.26 %.

### 4.6 Reconciliation with L11.6

L11.6 computed L11-B's power using an assumed null of 0.40 and reported
`P(≥2 of 3) = 0.500` at `MixAcc = 0.90` **[R]**. The arithmetic was correct; **the input
was wrong**, because the null is measured and measured values run 0.33–0.50, not 0.40
uniform. With the measured values the same calculation gives **0.00000 / 0.4140 /
0.8988** and a joint of **9 × 10⁻⁸**. **L11.6's characterisation of L11-B as
"underpowered" understates the finding: with measured nulls it is effectively
infeasible.**

### 4.7 Sensitivity — the criterion's strictness is a nuisance parameter

| hypothetical `Null(t)` for all cells | required MixAcc | implied `Comp` at `Read=1` | character |
|---|---|---|---|
| 0.3333 (the mathematical minimum) | 0.8333 | 0.808 | **weaker than L11-A** — near-vacuous |
| 0.4444 (the expectation) | 0.9444 | 0.936 | stricter than L11-A |
| 0.5000 (two measured cells) | 1.0000 | 1.000 | **unsatisfiable in practice** |

The protocol fixes neither the value nor a bound on `Null(t)`, yet the criterion's entire
meaning depends on it. **A threshold on a raw difference with a measured baseline has no
constant meaning.** This is the defect, independent of any particular number.

### 4.8 Can L11-B be evaluated from the schema? **[V]**

Yes — the fields exist: `call_purpose = forced_bank`, `forced_bank`, `correct`,
`metric_eligibility`, `task_bank`. Three gaps remain **[U]**:
(i) the number of trials per forced cell is not stated (L10 used 120 each);
(ii) no field groups a set of forced cells into one `Null(t)` measurement;
(iii) `metric_eligibility` (`ACC;ROUTE;RULE;READ;MAPCHECK`) has no stated semantics for
whether a row may carry several tags at once.

---

## 5. L11-G — a paired comparison specified as if it were unpaired

A2 and A9 are **matched pairs**: identical evaluation seed, identical RNG streams,
identical 360 evaluation cues; only training order differs **[V]**. The two `Comp`
values are therefore measured on the *same cue instances*, and the correct test is
paired (McNemar), with

    var(d) = (ψ − δ²)/n,   ψ = P(discordant),  δ = Comp(A2) − Comp(A9)

At `δ = 0`, `P(fail)` **[D]**:

| ψ | paired sd | `P(fail | δ=0)` | unpaired sd | `P(fail | δ=0)` |
|---|---|---|---|---|---|
| 0.02 | 0.0129 | 4.7 × 10⁻¹⁵ | 0.0387 | 4.9 × 10⁻³ |
| 0.05 | 0.0204 | 4.8 × 10⁻⁷ | 0.0387 | 4.9 × 10⁻³ |
| 0.10 | 0.0289 | 2.7 × 10⁻⁴ | 0.0387 | 4.9 × 10⁻³ |
| 0.20 | 0.0408 | 7.2 × 10⁻³ | 0.0387 | 4.9 × 10⁻³ |

**L11-G is nearly non-binding**: the 0.10 slack is 2.5–7.7 paired standard deviations.
At `δ = −0.10` exactly it passes 50 % of the time, so it is a 50 %-power test at its own
margin and almost never rejects at zero effect. It is the mirror image of L11-B: one
criterion cannot be passed, another cannot be failed.

Three seeds with "on every seed" and no multiplicity control mean the family error rate
is at most `3 ×` the per-seed rate — a bound that is never stated.

---

## 6. L11-D — a conditional mean whose denominator is the L11-A statistic

`Read = mean(correct | routing == 1)` **[V]**. The denominator is `120 × Comp`, so the
sample size is a random variable determined by *another criterion*. **[D]**:

| `Comp` | `n_elig` | k for ≥ 0.90 | `P(pass | Read=0.90)` | `P(pass | Read=0.95)` |
|---|---|---|---|---|---|
| 0.05 | 6 | 6 | 0.531 | 0.735 |
| 0.10 | 12 | 11 | 0.659 | 0.882 |
| 0.50 | 60 | 54 | 0.606 | 0.970 |
| 0.90 | 108 | 98 | 0.479 | 0.980 |
| 0.95 | 114 | 103 | 0.529 | 0.988 |
| 0.00 | 0 | — | **UNDEFINED** | — |

Two defects: (i) at `Comp = 0` the metric is **undefined**, and the protocol's §8(i)
exclusion cannot rescue it because the exclusion key (`selected_bank == -1`) is
unreachable — the L11.6 finding D1 stands **[V]**; (ii) conditioning on a random
denominator makes `Read` non-comparable across cells: `Read = 1.00` on 3 eligible trials
is reported in the same format as `Read = 0.92` on 114.

The fix that costs nothing: **report `Read` with its denominator**, and treat any cell
with `n_elig < 30` as NOT ESTIMABLE rather than as a pass.

---

## 7. Whole-contract analysis

### 7.1 Size of the conjunction

| criterion | predicates |
|---|---|
| L11-A | 9 |
| L11-B | 3 seeds × (≥2 of 3) |
| L11-C | 18 |
| L11-D | 9 |
| L11-E | deterministic |
| L11-F | suite-level |
| L11-G | 3 |

**No α, no correction, no aggregation rule.** The protocol never says what a test is,
so **no familywise error rate is defined, and none may be quoted.** Anyone reporting
"the L11 contract has a 5 % error rate" would be inventing it.

### 7.2 False-pass under failure scenarios **[D]**

| failure scenario | A | B | C | D | contract |
|---|---|---|---|---|---|
| context-ignoring router, fixed bank | FAIL (0/1.0/0 by task) | FAIL | FAIL (2 cells 0.13) | undefined | **rejected** |
| uniform wrong routing, 0.50 everywhere, retrieval fine | FAIL | FAIL | **PASS** (0.566 > 0.50) | PASS | **rejected by A/B only** |
| perfect routing, retrieval collapse | PASS | FAIL | FAIL | FAIL | **rejected** |
| 0.85 uniform | FAIL (7.5 %/cell) | FAIL | marginal | marginal | **rejected** |

**The contract never falsely passes a broken model** — its false-pass probability is
negligible in every scenario examined. The `0.50` floor of L11-C *alone* would pass the
"uniform 0.50 routing" failure; only L11-A and L11-B stop it. **L11-C is not the
load-bearing criterion, and its 0.50 is far below the failure it was written to catch.**

### 7.3 False-fail under plausible successful models **[D]**

| model | A | B (measured nulls) | C | D | complete pass |
|---|---|---|---|---|---|
| Comp = Read = 0.95 uniform | 0.937 | **0.0026** | 1.000 | 0.980⁹ | **≈ 2 × 10⁻³** |
| Comp = Read = 0.99 uniform | 1.000 | **0.509** | 1.000 | 1.000 | **≈ 0.51** |
| Comp = 0.90 uniform | 0.007 | ~0 | 0.004 | 0.48⁹ | **≈ 0** |

**The contract's operating point is ~0.99, not 0.90 or 0.95.** A model that meets every
frozen threshold in expectation is rejected essentially always. That is the
false-fail analysis, and it is the strongest argument in this document for redesign.

### 7.4 Does a complete pass support the intended claim?

The intended claim is *"the system resolves a cue whose features come from two
signatures, in an unseen count ratio, to the R-majority bank, independently of
allocation order, and retrieves correctly."* A complete pass would support
"consistent with" every clause at n = 120 per cell — **but only if the contract can in
principle be passed.** A contract with an ~0.5 % pass rate for a genuinely good model
does not measure capability; it measures luck, and a failure carries almost no
information.

**That is the finding: as written, L11's conjunction has high specificity and
catastrophically low sensitivity. It cannot distinguish a good model from an excellent
one, and a FAIL is almost uninformative.**

---

## 8. Candidate designs and their trade-offs **[P]**

All keep the frozen per-cell threshold 108/120 and change only the **aggregation rule**.

| Design | claim supported | P(pass) at 0.90 | at 0.93 | at 0.95 |
|---|---|---|---|---|
| **D0** all 9 cells (status quo, independence) | every task, every seed | 0.0070 | 0.484 | 0.937 |
| **D0′** all 9 (comonotone) | same | 0.576 | 0.923 | 0.993 |
| **D1** ≥ 7 of 9 cells | "at most two cells below bar" | **0.189** | 0.973 | 1.000 |
| **D2** ≥ 8 of 9 cells | "at most one cell below bar" | 0.053 | 0.850 | 0.998 |
| **D3** every task passes on ≥ 2 of 3 seeds | "every task, robust to one bad run" | **0.231** | 0.950 | 0.9995 |

D3 mirrors the k-of-n structure L11-B already uses, so it adds no new concept; it
raises power at 0.90 by 33× relative to D0 while still requiring every task.

### 8.1 A pre-specified global statistic (a *different* claim) **[D]**

Pooled 1080 trials, `H0: p ≤ 0.90`, one-sided:

| α | threshold | power at 0.92 | at 0.95 |
|---|---|---|---|
| 0.05 | ≥ 989/1080 (0.9157) | 0.720 | 1.000 |
| 0.01 | ≥ 995/1080 (0.9213) | 0.466 | 1.000 |

This is a genuine, honest 5 % test — but it supports **"the pooled composition rate
exceeds 0.90"**, *not* "every task exceeds 0.90". The specification explicitly forbids
pooled substitution for exactly this reason. **The trade is real and must be made by the
owner, not by arithmetic.**

### 8.2 Familywise control of the 9-cell conjunction — the honest cost **[D]**

Bonferroni at α = 0.05/9 requires **≥ 117/120** per cell; joint power at a true 0.95 is
**2.7 × 10⁻⁸**, at 0.97 **2.5 × 10⁻³**, at 0.99 **0.739**.

**Any claim of a 5 %-level all-cells test at n = 120 is unattainable.** The choice is
between a high-bar screening gate with no error-rate claim (D0–D3) and a weaker but
honest claim from a global statistic (§8.1). There is no third option at this `n`.

### 8.3 What a higher `n` would buy **[D]**

At the same 0.90 threshold and a 5 %-level one-sided test of `p ≤ 0.90`, the required `k`
scales as `n(0.90 + 1.645·0.30/√n)`. At `n = 120` that is 117/120; at `n = 480`, 445/480
= 0.927; at `n = 1080`, 989/1080 = 0.916. **Multiplicity control costs ~2.5 pp at
n = 120 and ~1 pp at n ≈ 1000.** The design's problem is `n` and cell count, not the
threshold.

---

## 9. What this audit does not establish

- It does not measure STARK. **[X]**
- It does not choose a design; §8 is **[P]**.
- It does not resolve R5, R4, R4b, R4c, R5b, F1, F2, F4, R1 or R6.
- It does not claim the contract is invalid *as a screening gate*; it claims the
  contract is **underspecified as a statistical procedure** and **miscalibrated as a
  capability test**.
- It does not change a single frozen number.
