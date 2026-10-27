# STARK-L11.3 — Proposed Owner Decisions (R4–R7)

**Prepared:** 2026-10-24, STARK-L11.3 schema-preparation milestone.
**Predecessor:** `work/L11_2_OWNER_DECISION_PROPOSED.md` (R1–R3).
**This document does not change any decision already recorded.** It adds the two
questions that surfaced while implementing the v0.2 schema, plus two procedural
confirmations. Nothing here is ratified; nothing here is applied.

---

## Standing status of R1–R3 (unchanged by this milestone)

| ID | Question | Current status |
|---|---|---|
| **R1** | Ratify L11 acceptance criteria and thresholds | **NOT RATIFIED** — `PENDING_OWNER_DECISION`. This milestone does not ratify it and must not be read as ratifying it. |
| **R2** | Disposition of `test_phase1_affinity` | **Approved in principle** for a behavior-preserving portability change; the source edit remains **UNAPPLIED** until scope + validation procedure are documented. |
| **R3** | Authorize the instrumented harness change | **Conditionally approved in principle**, subject to C1–C7. Implementation remains **UNAPPLIED**. |

This milestone discharges the *documentation* precondition of R2
(`work/L11_3_AFFINITY_PORT_PLAN.md`) and the *specification half* of C4
(`stark/design/l11_trial_schema_v0_2.md`). Neither action implements anything.

---

## Decision R4 — `Comp` for `AMBIG11`: task bank or rule bank?

**Why it is being asked.** Protocol §6 defines `Comp = routing` (the bank that owns
task `t`), then immediately adds *"For `AMBIG11` the prescribed bank is the
lowest-index of the two groups"*. Those are different banks whenever the
`AMBIG11` task is not the lowest-index group. v0.2 can record both
(`task_bank`, `rule_bank`), but it cannot decide which one the reported `AMBIG11`
`Comp` is. **This is a pre-existing defect in the frozen text**, not a change
introduced here.

**Options**

| # | Option | Consequence |
|---|---|---|
| 1 | `AMBIG11` `Comp` = `rule_compliant` (lowest-index tie-break) | honours the §6 tie-break sentence; `AMBIG11` measures "did you follow the declared tie-break", which is a different concept from `CROSS21`'s `Comp` |
| 2 | `AMBIG11` `Comp` = `routing_correct` (task bank) | keeps `Comp` uniform in meaning across categories; the tie-break sentence becomes descriptive of the rule, not of the metric |
| 3 | Report **both**, named distinctly (`Comp_task`, `Comp_rule`), decide nothing | no criterion changes; adds one reported column; honest but slightly noisier |
| 4 | Do not report `Comp` for `AMBIG11` at all | A4 becomes a pure control; no criterion references it, so nothing is lost |

**Recommendation: option 3.** It is the only option that resolves the ambiguity
without choosing a scientific position the owner has not taken, and no criterion
references A4 — so reporting both cannot alter any pass/fail. Option 2 would be a
silent redefinition; option 1 quietly changes what "Comp" means between
categories; option 4 discards information for no benefit.

**Explicitly not in scope:** changing any threshold. **Blocking:** publishing a
single `AMBIG11` `Comp` number under either reading.

---

## Decision R5 — L11-C: below 0.50 **on which metric**?

**Why it is being asked.** `L11-C` reads: *"no cell `(seed, task)` in A2 or A3
below 0.50"*. It does not name the metric. `Comp` (routing) and `MixAcc`
(accuracy) can straddle 0.50 — a model can follow the rule and still mis-retrieve.
As written, one and the same run can satisfy `L11-C` under one reading and fail it
under the other. **This is a defect in a preregistered acceptance criterion.**

**Options**

| # | Option | Consequence |
|---|---|---|
| 1 | `Comp` (routing) | tests the composition claim; retrieval failure stops being a floor-test failure |
| 2 | `MixAcc` (accuracy) | strictest; conflates composition and retrieval into one floor |
| 3 | **Both** — the cell must clear 0.50 on `Comp` **and** on `MixAcc` | strictly stronger than either reading; cannot pass a run that fails under either |
| 4 | Leave as-is | an unimplementable criterion; must not be used in an official run |

**Recommendation: option 3**, i.e. make the criterion the conjunction. It is the
conservative reading: it requires a run to clear both interpretations, so it can
never be accused of having picked the easier one after the fact. It is also the
only option that can be stated without resolving the ambiguity on the owner's
behalf — and note that "both" is *satisfied by* the intersection of the two
readings, so it does not weaken `L11-C`.

Because option 3 **changes a preregistered criterion** (it makes it strictly
stronger), it requires a **versioned amendment** (protocol v0.1 → v0.2) with a
re-recorded protocol hash, not a schema revision. It is therefore **not applied
here** and **not applied by this milestone under any option**.

**Blocking:** any official run, under any reading, until R5 is answered.

---

## Decision R6 — Record the v0.2 schema hash in the preregistration

**Why it is being asked.** The preregistration currently pins schema v0.1
(`a8edd674…`). If v0.2 is adopted, the preregistration must pin v0.2's hash, or the
recorded artifact and the registered schema will disagree — precisely the
`e32043c` stale-hash class of defect the audit already flagged.

**Proposed action:** amend `work/L11_1_PREREGISTRATION.json` to add
`schema_sha256_v0_2` **and** the human-readable note *`schema_v0_1_retained: true`*,
leaving every existing key untouched (no overwriting of the v0.1 record).

**Recommendation: approve at the same time as adopting v0.2.** Cheap, additive,
and it closes the stale-hash hazard. Not done here: modifying the preregistration
is not authorized in this milestone.

---

## Decision R7 — Sequence the next gate

**Question:** what happens after this milestone?

| # | Option | Consequence |
|---|---|---|
| 1 | Apply the implementation patch, then run checks 1–8 + 7′ + 9–14 | the audit's C6 ordering; slowest, safest |
| 2 | Apply the affinity port first (R2), then the patch | unblocks a currently-unbuildable test first; two independent changes to review |
| 3 | STOP: resolve R4 and R5 first, then re-ask | the schema is settled before any binary exists |

**Recommendation: option 3, then option 2, then option 1.** Rationale: R4/R5 are
questions about *what will be measured*; building instrumentation before they are
answered risks rework and, worse, risks a run whose criteria are still undefined.
The affinity port is independent and can proceed in parallel once R4/R5 are queued.

---

## Summary of what remains unauthorized

- No official L11 evaluation. **Zero official arms, zero official trials.**
- No source, harness, or affinity-test modification.
- No PR, no merge, no history rewrite.
- R1 not ratified; C1–C7 not satisfied (only C4's specification half).
