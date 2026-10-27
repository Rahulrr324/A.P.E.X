# STARK-L11.9 — Audit J: Owner Decision Sheet

> ## ⚠ THIS SHEET AUTHORISES NOTHING
>
> Approving every item below would **still** leave the project unable to run L11: the
> criterion code does not exist, no cross-family cue constructor for 3- and 4-feature cues
> exists, the protocol is unregistered, and no official arm has ever been authorized.
>
> **A passing audit is not permission.** Audit L11.9 passed its own checks; that fact
> grants no authority to implement, register, train, or evaluate anything.

Format for every item: **ID · question · recommended default · evidence and limitations ·
what approval authorizes · what approval does not authorize.**

---

## 1. Scientific claim

### CLM-1 · Is the primary estimand per-task or pooled?
- **Recommended default:** **per-task** (`min_t θ_t`), pooled reported as descriptive.
- **Evidence and limitations:** three fixed tasks, no sampling frame; pooling licenses a
  task at **0.72/1.00/1.00 → θ̄ = 0.907** (`s4_estimand_audit.md` §3). The frozen spec
  already says pooled is reported "never instead of" per-cell. Limitations: three renders
  are not a sample; nothing here estimates seed variation.
- **Approval authorizes:** the claim becomes "each of three fixed tasks".
- **Approval does not authorize:** any population inference, any claim about a fourth task,
  any pooling-away of a weak task.

### CLM-2 · Does the retrieval clause aggregate 2-of-3 or all-9?
- **Recommended default:** **2-of-3, same as the routing clause**.
- **Evidence and limitations:** **CA-1** — the L11.8 claim says 2-of-3 for both clauses;
  AC-2 does 2-of-3, AC-5 does all-9. D's contribution differs by **79×** between them
  (`claim_audit.md` §3). Limitations: the frozen text says "every cell".
- **Approval authorizes:** one consistent aggregation.
- **Approval does not authorize:** mixing rules, or a claim whose wording and predicates
  disagree.

---

## 2. Statistical contract

### STC-1 · Replace D0 (all 9 cells) with D3 (≥2 of 3 per task)?
- **Recommended default:** **adopt D3**, and print the catastrophic-run concession beside it.
- **Evidence and limitations:** power at true 0.90 rises **0.0070 → 0.2306**; D3 is
  dependence-robust (spread 0.039 vs 0.569). **Limitation, disclosed:** with run accuracies
  `(0.95, 0.95, 0.20)` D3 still passes **95.8 %** of studies (`s1_aggregation_audit.md` §6).
- **Approval authorizes:** superseding the frozen per-cell requirement.
- **Approval does not authorize:** any claim that D3 detects a catastrophic run.

### STC-2 · Normalized gain with threshold 0.75 and margin 0.10?
- **Recommended default:** **adopt**, labelled a **precedent** from L10-K1, never "derived".
- **Evidence and limitations:** algebra verified over 6000 grid points, 0 disagreements;
  `P(pass | MixAcc = 0.90) = 0.9164` reproduced exactly. **Limitation:** 0.75 is not derived
  from theory or simulation; the probability is conditional on a fixed true null shape.
- **Approval authorizes:** `NG` replaces the raw delta in L11-B.
- **Approval does not authorize:** calling the threshold calibrated or the probability
  unconditional.

### STC-3 · `Null` ceiling of 0.75?
- **Recommended default:** **keep it**, and move it into the acceptance matrix.
- **Evidence and limitations:** at `Null = 0.99` the required `MixAcc` is 0.9975, below
  estimator resolution; the guard is currently only in the candidate spec.
- **Approval authorizes:** high-`Null` checkpoints become INCONCLUSIVE.
- **Approval does not authorize:** treating INCONCLUSIVE as a pass.

### STC-4 · Resolve CA-1 (claim/predicate mismatch)?
- **Recommended default:** **resolve via CLM-2**.
- **Approval authorizes:** aligned text.
- **Approval does not authorize:** leaving the claim prose unchanged while predicates differ.

### STC-5 · Name the official test statistic (3-seed mean)?
- **Recommended default:** **name it explicitly** in the ratification.
- **Evidence and limitations:** L11-A has been redefined several times; an unnamed statistic
  invites redefinition after results are seen.
- **Approval authorizes:** one fixed statistic.
- **Approval does not authorize:** post hoc selection among statistics.

---

## 3. Metric semantics

### MET-1 · Restrict L11-C to A3?
- **Recommended default:** **yes**, and state that validity is unproven.
- **Evidence and limitations:** **proved** that `Comp ∧ Read ≥ 0.90 ⇒ MixAcc ≥ 0.81 > 0.50`,
  so C is redundant on A2. On A3 it is the **only** gate. Limitations: A3 is unbuilt, so the
  "only gate" claim is relative to criteria, not evidential.
- **Approval authorizes:** C as a supplementary A3 check.
- **Approval does not authorize:** describing C as validating the metric.

### MET-2 · Replacement retrieval rule?
- **Recommended default:** **mean `Read ≥ 0.90` with a missing-data rule**.
- **Evidence and limitations:** the frozen 108/120 floor is exactly 0.90 × 120, leaving no
  margin; `Read` is undefined at `Comp = 0`.
- **Approval authorizes:** a retrieval test with a defined denominator.
- **Approval does not authorize:** ignoring ineligible cells.

### MET-3 · `Comp > 0` and `n_elig ≥ 30` guards?
- **Recommended default:** **adopt**; INCONCLUSIVE, never a pass. *(Engineering mechanism;
  the owner's only role is accepting the consequence.)*
- **Approval authorizes:** ill-defined cells report INCONCLUSIVE.

### MET-4 · What is the **primary** endpoint?
- **Recommended default:** **`Comp` under D3** is primary; `Read`, `MixAcc`, `NG`, `Mis`
  secondary.
- **Evidence and limitations:** five per-cell metrics coexist; without a primary, no
  confirmatory test exists.
- **Approval authorizes:** one confirmatory test.
- **Approval does not authorize:** reporting five endpoints as if each were confirmatory.

### MET-5 · Multiplicity policy?
- **Recommended default:** **one primary endpoint ⇒ no correction**; all others labelled
  secondary.
- **Approval authorizes:** an unambiguous error interpretation.
- **Approval does not authorize:** **any claim of familywise control** — the audit found none
  in the package and proposes none.

### MET-6 · Are sub-0.25-direction ratios confirmatory?
- **Recommended default:** **no — report-only**.
- **Evidence and limitations:** A10/A11/A13 are sub-design; no power computation exists.

### MET-7 · `Read` denominator: `R = 1` cells or all cells?
- **Recommended default:** **all cells, with `Comp = 0` INCONCLUSIVE**.
- *(Engineering mechanism; the owner accepts the consequence.)*

### MET-8 · Report `Comp` by chance-corrected gain in A4?
- **Recommended default:** **yes**, exploratory only; integer ties make raw `Comp`
  uninformative in A4.

### MET-9 · "Signature" = task, or K1–K4 group?
- **Recommended default:** **task**, stated explicitly.
- **Evidence and limitations:** the protocol uses *signature* for the 4-feature group; the
  claim's "three signatures" reads as tasks.

### MET-10 · `Mis` semantics?
- **Recommended default:** **"any non-own-bank selection"**, stated exactly; the
  "beyond chance" reading is a different quantity.

---

## 4. Implementation and schema — **not owner questions**

These five have answers determined by evidence. **The owner is not asked to decide them.**

| ID | item | status |
|---|---|---|
| IMP-1 | `status` field, two layers (validity / endpoint) | PROPOSED |
| IMP-2 | named audit arm `A14` | PROPOSED |
| IMP-3 | `unitId` / `constructionId` / `cellId` | PROPOSED |
| **IMP-4** | **cross-family cue constructor for 3- and 4-feature cues** | **NOT EXECUTED — the instrument cannot emit the primary claim's cue** |
| IMP-5 | `Null` integral helper mirroring `stat_audit.py` | PROPOSED |

**IMP-4 is a blocker, not a decision.** Until it exists, no authorization can produce a
measurable A2 or A3.

---

## 5. Protocol registration

| ID | step | status |
|---|---|---|
| REG-1 | register `L11-AC-v0.3` (supersedes v0.2) | **NOT EXECUTED** |
| REG-2 | register the L11 blocker sequence | **NOT EXECUTED** |

**Registration authorizes nothing.** It records what has been decided, and **must not
happen before** the decisions above are resolved.

---

## 6. Experimental authorization

| ID | step | status |
|---|---|---|
| EXP-1 | authorize implementation of C1–C7 | **NOT EXECUTED** |
| EXP-2 | authorize official evaluation | **NOT EXECUTED** |

**Both are locked. Neither is requested by this audit.** Order: **IMP-4 → EXP-1 → C1–C7
measured 7/7 → REG → EXP-2.** No step skips another.

---

## 7. Reading rule for this sheet

> Approving items 1–3 makes the **contract** coherent.
> It does not create the **code**, does not register the **protocol**, and does not
> authorize a single **trial**.
>
> **The 26 items reduce to four gates: build the cue constructor, authorize implementation,
> measure C1–C7, authorize evaluation — and the first is not a decision at all.**
