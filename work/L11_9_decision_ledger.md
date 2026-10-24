# STARK-L11.9 — Audit F: Decision Ledger, Deduplicated by Meaning

**Count arithmetic reproducible:** section *AUDIT F* of `work/L11_9_claim_audit.py`.

**No entry in this ledger records an approval. Every status below is one of
`UNRESOLVED`, `PROPOSED` or `NOT EXECUTED`. There is no `APPROVED` status, by construction.**

---

## 1. Six explicitly defined counts (the required reconciliation)

| # | count | definition | value |
|---|---|---|---|
| 1 | **scientific-claim decisions** | a choice about what the study claims | **2** |
| 2 | **statistical-contract decisions** | a choice of rule, threshold or error semantics | **5** |
| 3 | **metric-semantics decisions** | a choice about what a number means or where it applies | **10** |
| 4 | **implementation / schema decisions** | a choice of encoding or mechanism; **the answer is determined by the evidence, so these do not need the owner's value judgment** | **5** |
| 5 | **protocol-registration decisions** | a step that changes what is registered | **2** |
| 6 | **experimental-authorization decisions** | a step that permits execution | **2** |

**Canonical distinct owner-facing decisions = 26**, of which **17 are value judgments
(1+2+3)**, **5 are engineering (4)**, and **4 are authorization steps (5+6)**.

**A seventh count, kept separate on purpose:**

| # | count | definition | value |
|---|---|---|---|
| 7 | **implementation/runtime conditions** | preconditions that must *hold* before a run; **not decisions and not approvable items** | **7** (C1–C7) |

### 1.1 Reconciliation of L11.8's stated "17"

| quantity | value |
|---|---|
| L11.8's own **statements** | "17 decisions" (readiness report) |
| L11.8's **queue enumeration** | **19** |
| L11.8's **register** (queue plus AC-5, AC-6, AC-7) | **22** |
| register minus one true duplicate (R5 → S3/AC-4) | **21** |
| **audit value-judgment count** | **17** |
| **audit canonical count** (all six categories) | **26** |

**Finding DL-1:** the number **17 does not match any set L11.8 enumerates**. Its queue is
19, its register is 22. The audited value-judgment count also happens to be 17, but **the
sets differ** — L11.8 counted implementation items and omitted AC-5/AC-6/AC-7 from its
stated figure. **The coincidence is not a repair.** This is an internal inconsistency of
L11.8, documented here and **not repaired there** (L11.8 is a historical artifact).

**Finding DL-2:** **C1–C7 are not decisions.** They are runtime conditions measured on the
built binary. They appear in L11.8's queue as though they were approvable items, which
would let a reader believe they can be "approved". They cannot — they can only be
*measured*.

---

## 2. Ledger

Columns: **ID** · **category** · **question** · **status** · **evidence** ·
**recommendation (not adopted)** · **if approved** · **if rejected** · **depends on** ·
**blocks registration** · **blocks implementation** · **needs new evidence** ·
**owner choice or engineering detail**.

### 2.1 Scientific claim (value judgments)

| ID | question | status | evidence | recommendation | if approved | if rejected | depends on | blocks reg. | blocks impl. | new evidence | kind |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **CLM-1 (S4)** | per-task primary, or pooled? | **UNRESOLVED** | `s4_estimand_audit.md`: pooling licenses a task at 0.72–0.75 | per-task primary; pooled reported | the claim becomes "each of three fixed tasks" | the claim becomes "the battery average"; one task may fail | none | **yes** | **yes** | no | **owner** |
| **CLM-2 (U3)** | does the retrieval clause aggregate 2-of-3 or all-9? | **UNRESOLVED** | **CA-1**: claim says 2-of-3 for both clauses; AC-2 does 2-of-3, AC-5 does all-9 | adopt one rule for both; prefer 2-of-3 for consistency with the claim | the claim and the predicates agree | the claim wording must exclude the retrieval clause | CLM-1 | **yes** | yes | no | **owner** |

### 2.2 Statistical contract (value judgments)

| ID | question | status | evidence | recommendation | if approved | if rejected | depends on | blocks reg. | blocks impl. | new evidence | kind |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **STC-1 (S1)** | replace D0 (all 9 cells) with D3 (≥2 of 3 per task)? | **UNRESOLVED** | power 0.0070 → 0.2306 at true 0.90 **[D]** | adopt D3, with the 95.8 % catastrophic-run concession printed beside it | the frozen 0.90-per-cell requirement is superseded | the study remains underpowered at 0.90 | — | **yes** | **yes** | no | **owner** |
| **STC-2 (S2/AC-3)** | normalized gain with 0.75, 0.10 margin? | **UNRESOLVED** | `s2_normalized_gain_audit.md`: algebra verified; 0.75 is an L10-K1 **precedent**, not a derivation | adopt, and label it a precedent | `MixAcc` replaces the raw delta in L11-B | L11-B keeps the frozen rule requiring `MixAcc = 1.00` at `Null = 0.5` | CLM-1 | **yes** | **yes** | no | **owner** |
| **STC-3 (AC-7)** | `Null` ceiling 0.75? | **PROPOSED** | at `Null = 0.99` required `MixAcc = 0.9975`, below estimator resolution **[D]** | keep the guard, and state it in the matrix | high-`Null` checkpoints become INCONCLUSIVE | the criterion is decidable by noise at high `Null` | STC-2 | **yes** | yes | no | **owner** (threshold) |
| **STC-4 (CA-1)** | fix the aggregation mismatch | **UNRESOLVED** | `claim_audit.md` §3, 79× difference in D's own contribution | see CLM-2 | predicates match the claim | claim text must change | — | **yes** | yes | no | **owner** |
| **STC-5 (R5b)** | official test statistic: 3-seed mean? | **UNRESOLVED** | L11-A has been redefined several times; the statistic must be named once | name it explicitly in the ratification | the test is exactly specified | the test stays ambiguous | STC-1, CLM-1 | **yes** | no | no | **owner** |

### 2.3 Metric semantics (value judgments)

| ID | question | status | evidence | recommendation | if approved | if rejected | depends on | blocks reg. | blocks impl. | new evidence | kind |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **MET-1 (S3/AC-4)** | restrict L11-C to A3? | **UNRESOLVED** | `s3_failure_coverage_audit.md` §3: **proved** that A ∧ D ⇒ `MixAcc ≥ 0.81` | restrict to A3, and state that validity is unproven | L11-C becomes a supplementary A3 check, not a primary gate | L11-C remains a redundant primary gate on A2 | CLM-1 | **yes** | yes | no | **owner** |
| **MET-2 (AC-5)** | keep the 108/120 per-cell floor? | **UNRESOLVED** | 0.90 × 120 = 108 exactly; no margin **[D]** | adopt the explicit `Read ≥ 0.90` mean with a missing-data rule | retrieval is tested with margin and a defined denominator | the retrieval test stays marginless | CLM-2 | **yes** | **yes** | no | **owner** |
| **MET-3 (AC-6)** | `Comp > 0` and `n_elig ≥ 30` guards? | **PROPOSED** | `Read` has no denominator at `Comp = 0` **[V]** | adopt; INCONCLUSIVE, never a pass | ill-defined cells become inconclusive | division by zero or a silent pass | MET-2 | **yes** | **yes** | no | **engineering** (mechanism) + owner (consequence) |
| **MET-4 (R4)** | what is the **primary** endpoint? | **UNRESOLVED** | `Comp`, `Read`, `MixAcc`, `NG`, `Mis` all exist **[V]** | one primary endpoint, the rest secondary, named once | the study has one confirmatory test | multiplicity becomes undefined | — | **yes** | no | no | **owner** |
| **MET-5 (R4b)** | multiplicity: one primary / all co-primary / hierarchical? | **UNRESOLVED** | the spec names five per-cell metrics | one primary endpoint (MET-4) | one test, no adjustment | co-primary ⇒ a disclosed correction ratio | MET-4 | **yes** | no | no | **owner** |
| **MET-6 (R4c)** | are sub-0.25-direction ratios confirmatory? | **UNRESOLVED** | A10/A11/A13 are sub-design **[V]** | report-only | they stay exploratory | they become confirmatory without power | MET-5 | **yes** | no | no | **owner** |
| **MET-7 (F1)** | `Read` denominator: `R = 1` cells or all cells? | **PROPOSED** | two different numbers result **[D]** | **all cells, with `Comp = 0` INCONCLUSIVE** | one denominator, continuous in `Comp` | conditioning on `R = 1` returns 0.90 at `Comp = 0` | MET-2/3 | **yes** | **yes** | no | **engineering** (mechanism) |
| **MET-8 (F2)** | report `Comp` by chance-corrected gain in A4? | **PROPOSED** | integer ties make `Comp` uninformative in A4 **[V]** | report it; exploratory | A4's tie behaviour becomes visible | A4's headline number stays misleading | — | no | yes | no | **engineering** (mechanism) |
| **MET-9 (U1)** | "signature" = task, or K1–K4 group? | **UNRESOLVED** | the protocol uses *signature* for the 4-feature group; the claim's "three signatures" reads as tasks **[V]** | task, stated explicitly | the claim reads unambiguously | readers may think four signatures exist | — | **yes** | **yes** | no | **owner** (semantics) |
| **MET-10 (U2)** | `Mis` semantics: "beyond chance" or "any non-own-bank"? | **UNRESOLVED** | the two definitions differ **[V]** | state the exact definition | `Mis` is reproducible | `Mis` is ambiguous | MET-9 | **yes** | yes | no | **owner** (semantics) |

### 2.4 Implementation / schema (engineering — **do not ask the owner**)

| ID | question | answer determined by evidence | status | if approved |
|---|---|---|---|---|
| **IMP-1 (F4)** | add a `status` field with two layers (validity, endpoint) | yes — required to represent INVALID vs INCONCLUSIVE | **PROPOSED** | the schema can express both |
| **IMP-2 (R2)** | add a named audit arm `A14` | yes — the spec already says "a named arm must exist" **[V]** | **PROPOSED** | arms can be enumerated |
| **IMP-3 (U4)** | add `unitId` / `constructionId` / `cellId` | yes — rerun provenance is not representable today **[V]** | **PROPOSED** | provenance is representable |
| **IMP-4** | **implement a cross-family cue constructor for 3- and 4-feature cues** | **yes — `CM_CROSS` emits only 1:1; `CROSS21`/`CROSS31` have no constructor** **[V]** | **NOT EXECUTED** | **A2 and A3 become measurable at all** |
| **IMP-5** | implement a `Null` integral helper mirroring `L11_7_power/stat_audit.py` | yes — the contract depends on it | **PROPOSED** | `Null` is computed the same way the audit does |

**IMP-4 is the largest discovery of this audit and is engineering, not a value judgment:**
without it the primary and secondary arms cannot produce a cue, so *no amount of
authorization makes the experiment runnable.*

### 2.5 Protocol registration and experimental authorization

| ID | question | status | blocks |
|---|---|---|---|
| **REG-1 (R1)** | register `L11-AC-v0.3`? | **NOT EXECUTED** | supersedes `L11-AC-v0.2` |
| **REG-2 (R6)** | register the L11 blocker sequence? | **NOT EXECUTED** | the study becomes discoverable |
| **EXP-1** | authorize implementation of C1–C7? | **NOT EXECUTED** | nothing may be built |
| **EXP-2** | authorize official evaluation? | **NOT EXECUTED** | nothing may run |

---

## 3. Dependence structure

```
CLM-1 (per-task)  ─┬─> STC-2 (NG) ─> STC-3 (Null ceiling) ─> MET-7 (Read denominator)
                   ├─> STC-5 (statistic) ─> MET-5 (multiplicity) ─> MET-6 (report-only arms)
                   └─> MET-1 (C on A3)
CLM-2 (aggregation) ─> MET-2 (Read rule) ─> MET-3 (guards)
MET-4 (primary endpoint) ─> MET-5 ─> MET-6
MET-9 (signature) ─> MET-10 (Mis)

IMP-4 (cue constructor) ──> EXP-1 ──> everything measurable
REG-1, REG-2 ──> after all owner decisions
EXP-2 ──> after REG and after C1–C7 measured
```

**Finding DL-3:** IMP-4 sits **before** EXP-1 in the dependency order and before every
criterion. **This is a change in what "blocked on authorization" means**: the package is
not only unauthorized, it is also **not buildable in its current form**.

---

## 4. What the ledger does not say

- It does **not** say any decision is approved.
- It does **not** say the contract is correct; four of its own numbers earn **PROPOSED**
  status and one (the aggregation) is **contradictory**.
- It does **not** merge the six counts into one number, and the seventh (C1–C7) is not a
  decision at all.
