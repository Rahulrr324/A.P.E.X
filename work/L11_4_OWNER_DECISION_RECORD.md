# STARK-L11.4 — Owner Decision Record

**Prepared:** 2026-10-24 · **Milestone:** STARK-L11.4 protocol semantics review
**Nature:** documentation only. Nothing below is ratified, applied, or registered.

R1, R2 and R3 are **tracked separately** from R4/R5, as required. R4/R5 are this
milestone's subject; R1/R2/R3 are inherited and **unchanged in status**.

---

## Part A — Inherited decisions (status unchanged)

| ID | Question | Status | This milestone's effect |
|---|---|---|---|
| **R1** | Ratify the L11 acceptance criteria and thresholds (L11-A … L11-G) | **NOT RATIFIED** — `PENDING_OWNER_DECISION` | **none.** L11.4 does not ratify, assume, or imply ratification. In fact R5 shows L11-C *cannot* be ratified as written |
| **R2** | `test_phase1_affinity` disposition (behaviour-preserving portability) | **approved in principle**; source edit **UNAPPLIED** | **none.** No file touched. The plan remains `work/L11_3_AFFINITY_PORT_PLAN.md`; the test remains UNEXECUTED (build failure) |
| **R3** | Authorise the instrumented harness change under C1–C7 | **conditionally approved in principle**; implementation **UNAPPLIED**; no source file modified | **indirect.** This milestone found that C4's verification procedure was wrong and that v0.2 as written specifies unreachable states. Acting on R3 before the v0.2.1 errata would produce a wrong implementation |

**Explicit non-inference:** R3's conditional recommendation is **not** a completed
authorisation, and this record does not treat it as one.

---

## Part B — This milestone's decisions

### R4 — `Comp` for `AMBIG11`

| Field | Content |
|---|---|
| Question | Is `Comp(AMBIG11)` task-bank routing, or compliance with the declared tie-break? |
| **Status** | **Resolved analytically; OPEN procedurally.** Requires ratification of amendment item A-1 |
| Evidence | Protocol §6 defines `Comp = routing` *and* prescribes a rule bank for `AMBIG11` (two definitions, one sentence apart). The audit calls `rule_bank` "the L11 Comp meaning". The specification assigns A4's role as "tie-break compliance". The two readings diverge on ≈50 % of `AMBIG11` trials, with a task-dependent pattern |
| **Recommendation** | **Report both, named**: `Comp_task(A4)` and `Comp_rule(A4)`; keep `Comp` restricted to `CROSS21/CROSS31/ORDERPERM` |
| Why | Changes **no criterion** (none references A4), keeps Q1 and Q2 separate, and refuses to repeal the declared tie-break |
| Rejected | Task-bank-only (penalises rule compliance); rule-bank-only (hides a routing failure); undefined (loses information at no saving); a stability metric (unimplementable — evaluation routing is a deterministic argmax) |
| Blocks | nothing by itself (no criterion uses A4); but the protocol cannot be called unambiguous until it is ratified |

### R4b — tie-break wording: "lowest group index" vs "lowest bank index"

| Field | Content |
|---|---|
| Question | Protocol §6 says "lowest-index of the two **groups**"; specification §2.1 and the preregistration say "lowest **bank** index" |
| **Status** | **Latent. No numeric effect under the frozen design.** Owner confirmation requested |
| Evidence | `AMBIG11` runs only in A4 (standard order); `ccAllocateNext` allocates 0,1,2 in presentation order, so `task_bank = [0,1,2]` and the two wordings coincide **exactly**. They diverge only under a permuted allocation, which `AMBIG11` never has |
| **Recommendation** | Pin to **lowest bank index** (matches the preregistration and the specification; the protocol is the outlier). Implementation may proceed under either wording **without effect** until an order-permuted `AMBIG11` arm exists |
| Note | This is the reason R4b must not be over-dramatised: it is a record-consistency defect, not a measurement defect |

### R4c — `Read` conditioning for `AMBIG11`

| Field | Content |
|---|---|
| Question | v0.2 marks `READ` eligible for `AMBIG11`, but `Read` is conditioned on `routing_correct` (task bank). A rule-following model is therefore excluded from the denominator on exactly the trials that matter |
| **Status** | **OPEN** (new in this milestone) |
| **Recommendation** | Record `Read_rule(A4) = mean(correct \| rule_compliant == 1)` **alongside** `Read`, courtesy of amendment item A-4. Do not replace `Read` |
| Cost | one extra reported number for one non-criterion arm |

### R5 — L11-C metric

| Field | Content |
|---|---|
| Question | "no cell `(seed, task)` in A2 or A3 below 0.50" — below 0.50 **on what**? |
| **Status** | **Resolved analytically; OPEN procedurally.** Requires ratification of amendment item A-5 |
| Evidence | (i) the frozen text omits the metric; (ii) a committed predecessor artifact (`L11_READINESS_ASSESSMENT.md:254`) names `MixAcc`; (iii) the freeze's own note says the criteria are "unchanged from the readiness proposal **except where marked**", and L11-C is not marked → the omission is a drafting regression; (iv) the motivating statistic (pooled 0.5611 with a 0.0 cell) is an **accuracy** statistic |
| Non-redundancy | Under **both** readings the A2 clause is implied by L11-A ∧ L11-D (`MixAcc ≥ 0.81`). The only independent force is **A3**, which no other criterion covers. On A3 the `Comp` reading passes "routes perfectly, reads nothing"; the `MixAcc` reading fails it |
| **Recommendation** | **`L11-C := MixAcc`, per `(seed, task, arm ∈ {A2, A3})` cell, threshold 0.50 unchanged** |
| Not justified by | any observed score — **no L11 data exists**; the arm is unimplemented |
| Honest caveat | the two readings are **different predicates, not ordered ones**; calling the change "only stricter" would be false |
| Blocks | **every official run.** A registered criterion whose metric is unnamed cannot be evaluated |

### R5b — the "pooled ≥ 0.75" clause

| Field | Content |
|---|---|
| Status | **OPEN. Not adopted here.** |
| Facts | appears only in the superseded readiness proposal; absent from protocol, specification, preregistration, and the L11.1 instrumentation record; its pooling contract is undefined everywhere |
| **Recommendation** | **Do not fold it into the L11-C clarification.** Decide it separately, and if adopted, use the written contract in `L11_4_PROPOSED_AMENDMENT.md` §5 (unweighted per-task mean, per seed, per arm) |
| Why | adding an unregistered threshold under the heading of a clarification is the manoeuvre the safeguards exist to prevent |

### R6 (carried from L11.3) — record the adopted schema hash

| Field | Content |
|---|---|
| Status | **OPEN** |
| Update | the schema to record is now **v0.2.1** (v0.2 + the L11.4 errata D1–D8), not v0.2 |
| Recommendation | record `schema_sha256_v0_2_1` in the preregistration on adoption; retain the v0.1 record untouched |

### R7 (sequencing, restated)

| Field | Content |
|---|---|
| Recommendation | **(1)** ratify R4/R4b/R4c/R5/R5b → **(2)** commit protocol v0.2 + schema v0.2.1 and re-record all hashes → **(3)** ratify R1 (thresholds) → **(4)** the affinity port (R2), which is independent → **(5)** implement under C1–C7, then the C6 battery |
| Why | L11.4 has finished the *analysis* half of R4/R5. What remains is a ratification, which cannot be substituted by more analysis. Instrumentation written before ratification would hard-code definitions that are still contested |

---

## Decision status board

| ID | Status | Blocking what |
|---|---|---|
| R1 | **NOT RATIFIED** | any official run |
| R2 | approved in principle · **unapplied** | affinity test remains UNEXECUTED |
| R3 | conditionally approved in principle · **unapplied** | instrumentation cannot start; prerequisite now includes the v0.2.1 errata |
| R4 | **analytically resolved · procedurally open** | protocol unambiguity |
| R4b | open (latent, zero effect) | nothing today |
| R4c | open | completeness of A4 reporting |
| R5 | **analytically resolved · procedurally open** | **every official run** |
| R5b | open | nothing (declined for now) |
| R6 | open | preregistration completeness |
| R7 | recommendation only | sequencing |

**One-line summary for the owner:** the analysis is finished; four ratifications
(R4/R4b/R4c/R5), one decision (R5b) and one hash re-record (R6) stand between this
repository and an official L11 run. None of them can be supplied by another
document.
