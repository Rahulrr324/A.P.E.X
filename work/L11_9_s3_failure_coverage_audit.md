# STARK-L11.9 — Audit D: S3 Failure Coverage, Independently Verified

**Arithmetic reproducible:** section *AUDIT D* of `work/L11_9_claim_audit.py`.

Separate columns are kept throughout, as required: **raw metric value** · **acceptance
decision** · **scientific interpretation**.

---

## 1. The criterion under audit

| element | frozen / proposed |
|---|---|
| metric | `MixAcc = Comp·Read + (1−Comp)·WrongBankAcc` **[V]** |
| frozen scope | "no cell `(seed, task)` in A2 or A3 below 0.50" — metric unnamed, 18 cells **[V]** |
| proposed scope (AC-4) | `CROSS31` (A3) only, 9 cells; `MixAcc` on A2 reported, not gating **[P]** |
| threshold | 0.50, unchanged **[V]** |

---

## 2. Coverage table, recomputed **[D]**

| # | scenario | `Comp` | `Read` | **`MixAcc`** | **A verdict** | **D verdict** | **C verdict** | interpretation |
|---|---|---|---|---|---|---|---|---|
| 1 | routing collapse on one task | 0.00 | 0.00 | **0.1320** | FAIL | **UNDEF** | FAIL | the historic L10.3 failure |
| 2 | uniform wrong routing | 0.50 | 1.00 | **0.5660** | FAIL | PASS | **PASS** | C misses a routing failure |
| 3 | retrieval collapse | 0.99 | 0.00 | **0.0017** | PASS | FAIL | FAIL | C agrees with D |
| 4 | leakage at same `Comp`, `Read` | 0.90 | 1.00 | **0.9600** | PASS | PASS | **PASS** | leakage *raises* MixAcc |
| 5 | on target | 0.90 | 1.00 | **0.9167** | PASS | PASS | PASS | — |

---

## 3. Does C add information beyond A and D? — **no, provably** **[D]**

> **Theorem (checked analytically and on a grid).** If `Comp ≥ 0.90` and `Read ≥ 0.90`
> then `MixAcc = Comp·Read + (1−Comp)·Wrong ≥ 0.90·0.90 + 0.10·0 = 0.81 > 0.50`.
> Therefore **C@0.50 can never reject a cell that A and D both accept.**

Checks `D.1` (no scenario violates it) and `D.2` (grid over `Wrong`) both **PASS**.

**Audit finding S3-1:** on A2, L11-C is **logically redundant** given A and D. It is not
merely weak; it carries **zero decision content** on that arm. This is a proof, not an
empirical observation, and it is stronger than L11.8's statement.

---

## 4. Can C pass failures that A rejects? — **yes** **[D]**

| failure | A | C | comment |
|---|---|---|---|
| uniform wrong routing (`Comp = 0.50`, `Read = 1.0`) | FAIL | **PASS** (0.5660) | the criterion's own rationale (a routing collapse) is invisible when the collapse is spread evenly |
| wrong-bank leakage (`Wrong` 1/6 → 0.60 at fixed `Comp`, `Read`) | PASS | **PASS**, with `MixAcc` rising 0.9167 → 0.9600 | **the metric improves as the failure worsens** |

**Audit finding S3-2:** `MixAcc` is strictly increasing in `WrongBankAcc` at fixed `Comp`
and `Read` (check `D.3`). Any gate built on `MixAcc` rewards leakage. The criterion cannot
be described as measuring the target capability.

---

## 5. Is C decision-relevant on A3? — **provisionally yes, not established** **[U]**

The argument for keeping C on A3 is coverage: **no other criterion addresses `CROSS31`**
(L11-A, B, D, G all reference A2; L11-G compares A2 to A9). Therefore, *if* A3 is run, C is
the only gate on it.

**But the conclusion is provisional, and the audit labels it so, because:**

1. **A3's cue does not exist** — `CROSS31` is a 4-feature cue and the harness emits at most
   2 features (`CM_CROSS` = 1:1) **[V]**. Nothing about A3 has been implemented.
2. **The failure space on A3 has never been characterised.** The five scenarios above are
   constructed from the A2 mechanism; none was derived from a measurement of a 3:1 arm.
3. **A `MixAcc ≥ 0.50` floor on A3 tests nothing about 3:1-specific behaviour** — it is the
   same absolute floor, and it would be passed by the same leakage mode.

**Audit finding S3-3:** "restricting C to A3 preserves coverage" is **provisionally true
and evidentially thin**. It is true *relative to the other criteria*; it is not evidence
that C measures anything. **The accurate statement is: restricting C to A3 removes
redundancy (proved) without removing a unique gate (true by enumeration of the criteria),
while adding no demonstrated measurement value (unproven).**

---

## 6. The historic-failure trap, stated explicitly

L11-C rejects L10.3's state only because the failure was **task-structured** — one cell at
0.132. Had the same 0.50 routing rate been spread evenly across tasks, `MixAcc = 0.566`
would have **passed** a 0.50 floor **[D]**.

**Audit finding S3-4 (preserved from L11.8 and re-verified):** *rejecting one known failure
case is not evidence that a metric measures the target capability.* The metric is retained
on A3 for **coverage**, not for validity, and the ratified text must say so.

---

## 7. Missing-data behaviour (unchanged, still unresolved in the frozen text)

| situation | frozen | proposed |
|---|---|---|
| `Comp = 0` ⇒ `Read` has no denominator | **unhandled** **[U]** | NOT ESTIMABLE ⇒ INCONCLUSIVE |
| `n_elig < 30` | unhandled | NOT ESTIMABLE ⇒ INCONCLUSIVE |
| `n = 0` | whole call INVALID **[V]** | retained |
| INCONCLUSIVE cells | no rule | **never a pass, never silently dropped** |

---

## 8. Audit D verdict

| Question | Verdict |
|---|---|
| Detects task-structured routing collapse? | **yes** (0.132 < 0.50) — but A also fails it |
| Can pass while routing is uniformly wrong? | **yes** (0.566) **[D]** |
| Improves when wrong-bank leakage increases? | **yes** (0.9167 → 0.9600) **[D]** |
| Adds information beyond A and D on A2? | **no — proved** (A ∧ D ⇒ MixAcc ≥ 0.81) |
| Decision-relevant on A3? | **provisionally**, pending A3's implementation and characterisation |
| Is the recommendation (restrict to A3) supported? | **yes for redundancy removal**; **not** as evidence of measurement validity |
