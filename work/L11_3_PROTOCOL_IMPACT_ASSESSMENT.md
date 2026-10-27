# STARK-L11.3 — Protocol and Preregistration Impact Assessment

**Scope:** every one of the v0.2 changes, classified against the frozen protocol
v0.1 (sha256 `322078c8…`) and the preregistration (`57a8139d…`,
`PENDING_OWNER_DECISION`, `official_evaluation_run = False`).
**Neither file is modified.** This document classifies; the owner decides.

---

## 1. The five change classes

| Class | Meaning | Owner action needed |
|---|---|---|
| **S — serialization-only** | extra columns; no existing field redefined, no number changes | none; recorded for traceability |
| **I — instrumentation-only** | where a measurement is captured, not what it means | none, but requires the C1–C3 tests |
| **M — metric-definition** | a metric's denominator or aggregation changes | **explicit owner sign-off** |
| **A — acceptance-criterion** | a criterion's pass/fail condition changes | **owner amendment — none proposed here** |
| **X — experimental-design** | new arms, cue modes, cells | **not proposed in this milestone** |

---

## 2. Change-by-change classification

| # | Change | Class | Reaches a preregistered metric? | Effect on criterion values |
|---|---|---|---|---|
| 1 | `schema_version` | S | no | none |
| 2 | `schema_sha256` | S | no | none |
| 3 | `record_class` (`ORDINARY`/`DIAGNOSTIC`) | I | **yes** — separates diagnostic rows | none, if diagnostics were already excluded |
| 4 | `record_status` (`OK`/`INVALID`/`MISSING`) | I | yes — makes exclusion auditable | none |
| 5 | `call_purpose` (`task_eval`/`reconstruction`/`null_k`) | I | yes | none |
| 6 | `task_bank` (new) | S | **yes** — `routing` is defined against it | none (it formalises §6's `first_feature_group(bank) == t`) |
| 7 | `rule_bank` (new) | M | yes — `Comp` now computed against it | **none** — see §3 |
| 8 | `rule_compliant` (new) | M | yes | **none** — see §3 |
| 9 | `forced_bank` (new) | S | yes — `Null(t)` needs it | **none** — same construction |
| 10 | `presented_ids` (new) | S | no | none |
| 11 | `intended_slot`, `selected_slot`, `queried`, `choice` | S/I | **yes** — `Read` depends on `routing` | none |
| 12 | `choice_matches_resolved_bank_map` (new) | S | no — reported, not a criterion | none |
| 13 | `metric_eligibility` (new) | M | **yes** | **none on A/B/D/E/G**; changes what may be reported for A4/A5/A6/A10 |
| 14 | `update_mass_*` split into three | I | no | none |
| 15 | `advantage` pre-call baseline | I | no | none |
| 16 | `NA` / `NM` / `MISSING` / `INVALID` tokens | M | yes | none on observed cells; removes implicit zeros |
| 17 | removal of `intended_bank` | M | yes — it is what made S1 possible | none; it was ambiguous, not referenced |
| 18 | P7 rule defined from the cue only | **X-adjacent** | yes | none — it is a driver helper, not new behaviour |

**Tally:** 8 serialization-only, 5 instrumentation-only, 4 metric-definition,
**0 acceptance-criterion**, **0 experimental-design**.

Class **A is empty by construction**: this milestone proposes no change to L11-A …
L11-G. Class **X is empty**: no new cue mode, arm, seed, or cell is added.

---

## 3. The load-bearing claim: `Comp` does not move

Protocol §6: `Comp = routing` on `CROSS21`/`CROSS31`/`ORDERPERM`, and
`routing = 1[first_feature_group(bank) == t]` — the task's bank.

v0.2: `Comp = mean(rule_compliant)` on those three categories, and
`rule_compliant = 1[selected_bank == rule_bank]`.

For those three categories the cue's majority feature group belongs to the task's
own bank (protocol §4: the composition cues are built from the task's own
signatures), hence `rule_bank == task_bank` row-for-row, hence

```
rule_compliant ≡ routing_correct ≡ 1[selected_bank == task_bank]
```

**Therefore `Comp(A2)`, `Comp(A9)`, and `L11-G = Comp(A2) − Comp(A9)` are
bit-for-bit unchanged.** The validator enforces the equivalence as test T16 and it
is the reason `AMBIG11` is carved out separately (§5, A1) instead of being folded
into `Comp`.

---

## 4. Metrics whose meaning is clarified, and which are therefore BLOCKED

These are **not** changes made by this milestone. They are defects already present
in the frozen text, surfaced by having to implement it.

| ID | Preregistered item | Defect | Disposition |
|---|---|---|---|
| **A1** | `Comp` for `AMBIG11` | §6 defines `Comp = routing` (task bank) and then says the prescribed bank is the lowest-index group (rule bank). For `AMBIG11` these differ whenever the task is not lowest-index. | **BLOCKED for `AMBIG11` reporting.** No criterion references A4, so no criterion is blocked. Owner must choose a reading before an A4 number is published. |
| **A2** | **L11-C** | "no cell `(seed, task)` in A2 or A3 below 0.50" — **metric unnamed**. `Comp` and `MixAcc` can straddle 0.50. | **L11-C BLOCKED.** Owner clarification required before any official run. |
| A3 | `Read` on `MISLEAD` | Would be `0` by construction (no routed trial). | Closed by v0.2 (S2): `NA:STRUCT_ZERO`, and `MAPCHECK` replaces it. Class **M**; requires sign-off, but it affects no criterion. |
| A4 | `Null(t)` | Requires `forced_bank`, absent from v0.1. | Closed by v0.2 (G1). Class S; identical construction. |
| A5 | `SHUFFLED` "routing" | v0.1 had one bank field; a misled model could be scored routing-correct. | Closed by v0.2 (S1). Class **M**; affects `ShufAcc` reporting only, not a criterion. |

**Blocking rule applied:** any preregistered metric whose meaning changes for
official reporting is marked BLOCKED pending owner review, whether or not a
criterion references it. L11-C (A2) is the only *criterion* in that set, and it is
blocked because its metric is unnamed — not because this milestone changed it.

---

## 5. Schema revision vs versioned amendment

The distinction matters for the frozen record:

| Path | What it would mean | Used here? |
|---|---|---|
| **Schema revision** (v0.1 → v0.2) | the *recording format* changes; the protocol's metrics, thresholds and criteria are untouched | **yes — this is the only mechanism this milestone uses** |
| **Versioned amendment** (protocol v0.1 → v0.2) | the *experiment's* definitions change; requires re-recorded protocol hash, re-recorded preregistration, and owner ratification | **no — not proposed** |

Consequence: `stark/design/l11_1_protocol.md` and
`work/L11_1_PREREGISTRATION.json` are **byte-unchanged** (`322078c8…` /
`57a8139d…`). Only a new schema document is added. Because a schema change does
alter what the artifact contains, the **preregistration must record the v0.2
schema hash** before any official run — an owner step, listed as R6 in
`work/L11_3_OWNER_DECISION_PROPOSED.md`.

---

## 6. What must be true before an official run

Ordered, each blocking the next:

1. Owner ratifies **R1** (protocol/thresholds, still `PENDING_OWNER_DECISION`).
2. Owner resolves **R4 (A1, `AMBIG11`)** and **R5 (A2, L11-C)**.
3. Owner authorizes the v0.2 schema and its hash is re-recorded in the prereg
   (**R6**).
4. Owner authorizes the implementation patch; it is applied by a later, separate
   milestone — **not this one**.
5. Checks 1–8 **plus** 7′, 9–14 pass on `A_on` vs `A_off`.
6. Only then may arms be implemented (C6 ordering).

**None of these has happened.** Official L11 evaluation has not run; zero official
arms, zero official trials.

---

## 7. Summary

- 0 acceptance-criterion changes, 0 experimental-design changes.
- 4 metric-definition changes — all confined to `MISLEAD`, `SHUFFLED`, `AMBIG11`
  and the missingness layer; **none touches a criterion's arithmetic**.
- 1 criterion (**L11-C**) and 1 reported metric (`AMBIG11` `Comp`) are **blocked
  pending owner clarification** of defects that pre-exist this milestone.
- The frozen protocol and preregistration are untouched and verified byte-identical.
