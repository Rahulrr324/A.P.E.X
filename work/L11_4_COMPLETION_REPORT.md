# STARK-L11.4 — Completion Report

**Milestone:** Protocol Semantics Resolution and Schema v0.2 Review
**Branch:** `validation/l11-4-protocol-semantics`, from verified L11.3 state
`e8955dfd6d87fe9de84bfe1746901825270e182e`
**Nature:** documentation only · **no source, harness, test, protocol or
preregistration change** · no PR · no history rewrite

---

## Part 1 — Provenance and Git state

| Item | Verified value |
|---|---|
| Origin | `https://github.com/Rahulrr324/A.P.E.X.git` |
| Start branch / HEAD | `validation/l11-3-schema-v0-2` @ `e8955df…`, **tree clean** |
| L11.3 exists locally **and** remotely | yes (`git ls-remote` → `e8955df…`) |
| Ancestry | `e8955df → deac50f (audit) → c547aab → 6a43974 (L11.1) → 77d261a` — all confirmed ancestors |
| PR #1 / #2 / #3 | MERGED `c32071e` / OPEN `5f5a577` / OPEN `49cc6ba` — **none modified** |
| Protocol | `322078c8…` — **equals the prereg's recorded hash** (recomputed) |
| Schema v0.1 | `a8edd674…` — equals prereg record |
| Specification | `d9cd7dc4…` — equals prereg record |
| Schema v0.2 proposal | `1ce1525b…` — unchanged |
| Preregistration | `57a8139d…`, `PROTOCOL_FROZEN_FOR_REVIEW / THRESHOLDS_PENDING_OWNER_RATIFICATION` |
| L11.3 scope intact | **yes** — no source/test/protocol/prereg delta between `deac50f` and `e8955df` |
| Untracked residue relied on | **none** — the tree was clean; every fact is read from committed files |

**Discrepancy reported, not worked around:** the session's tracked branch name
`arena/86da64f9-a-p-e-x` resolves on the remote to `49cc6ba…`, the **head of
PR #3**. Committing there would modify PR #3. A dedicated `validation/*` branch is
the only option that honours both "use a dedicated validation branch" and "do not
modify PR #2 or PR #3", and it matches the workflow used by every L10.x and L11.x
milestone.

---

## Part 2 — R4: competing definitions and recommendation

**Status: analytically resolved, procedurally open.**

Six candidate definitions were evaluated on all ten dimensions required by the
mission (formula, unit, numerator/denominator, inclusion, missingness, arm
validity, cross-task/seed comparability, hidden order or denominator advantage,
preservation of the routing/retrieval distinction, scientific reading).

**Root cause [V]:** specification §2.1 claims the rule "is declared in
`l11_1_protocol.md` **§4**" — but §4 is the cue-construction table and contains no
rule. The rule lives partly in the specification and partly in one sentence of
protocol §6, and the two disagree.

**Two findings about the record:**
- **[V]** The L11.2 audit is **factually wrong** about `AMBIG11`: it is a 1:1 tie
  with no majority group, so `task_bank` and `rule_bank` do not coincide by
  construction. C4's requirement is unaffected; its rationale is.
- **[V/I]** The candidate definitions diverge on **≈50 %** of `AMBIG11` trials
  (0 % / 50 % / 100 % for tasks 0/1/2) — and the divergence is *structurally
  task-dependent*, with no order-permuted `AMBIG11` arm to control it.

**Recommendation [P]:** report **both** `Comp_task(A4)` and `Comp_rule(A4)`, named
distinctly; restrict `Comp` to `CROSS21/CROSS31/ORDERPERM`.

**Why:** it changes **no criterion** (no criterion references A4 **[V]**), keeps
task-correct routing and rule compliance separate, and does not silently repeal the
declared tie-break — which task-bank-only scoring would do.

**Rejected:** rule-only (hides a routing failure); undefined (loses information for
no saving); a stability-under-ambiguity metric (**[V]** unimplementable — evaluation
routing is a deterministic masked argmax, so repeats always agree).

**R4b [V]** pin the tie-break to "lowest **bank** index". Under the frozen design it
coincides exactly with the protocol's "lowest group index" wording
(`task_bank = [0,1,2]` in A4), so **no recorded number changes**.

---

## Part 3 — R5: metric contract and recommendation

**Status: analytically resolved, procedurally open. Blocks every official run.**

**Evidence chain [V/A]:**
1. All four frozen artifacts omit the metric.
2. The readiness proposal at `ba1cfb3` (**verified ancestor of the freeze**) names
   **`MixAcc`** and adds a pooled clause.
3. L11.1's own note says the criteria are "unchanged from the readiness proposal
   **except where marked**" and marks only L11-G → the metric was **lost in
   drafting**, not removed by decision.
4. The motivating statistic (pooled 0.5611 with a 0.0 cell) is an **accuracy**
   statistic.

**Non-redundancy [I]:** `MixAcc = Comp·Read + (1−Comp)·WrongBankAcc`, so with
L11-A (0.90) and L11-D (0.90) the A2 clause is implied (`≥ 0.81`). The only
independent force is **A3**, uncovered by any other criterion — and there the
routing reading *passes* "routes perfectly, reads nothing" while the accuracy
reading fails it.

**Recommendation [P]:** `L11-C := MixAcc`, per `(seed, task, arm ∈ {A2, A3})` cell,
threshold **0.50 unchanged**.

**Stated honestly:** the two readings are **different predicates, not ordered
ones**; this is a **redefinition**, not a strengthening, and it is **not** justified
by any score (no L11 data exists — five of eleven arms are unimplemented).

**R5b:** "pooled ≥ 0.75" exists only in the superseded proposal and has no defined
pooling contract. **Declined in this draft**; separate owner decision.

---

## Part 4 — Schema v0.2 consistency

**The eight concepts remain properly separated** — task bank, rule bank, selected
bank, task correctness, rule compliance, retrieval correctness, missing measurement
and structural inapplicability each have their own field. The core property v0.1
lacked survives review.

Nine errata, all as **proposals** (v0.2 unmodified):

| # | Sev | Finding |
|---|---|---|
| D1 | high | `selected_bank = -1` is **unreachable** (`bank<0 → 0` clamp); v0.2 calls it real; invariant 14 vacuous; protocol §8(i) inert |
| D2 | high | `bank_score_margin` must be **candidate-masked**; needs `NA:LT2_CANDIDATES` |
| D3 | med | invariant 10 uses an undefined `X` token; source uses `-1` placeholders |
| D4 | high | **P7 cannot be computed from the cue alone** — needs the group→bank map; L11.3's V4 assertion is wrong |
| D5 | med | `Read(AMBIG11)` is task-conditioned → R4c |
| D6 | med | `advantage` baseline index is `baseline_per_bank ? bank : 0`; "0" is a default, not a contract |
| D7 | low | the router-update predicate also requires `forced_bank < 0` |
| D8 | low | invariant 20 excludes the legitimate `per_bank_off` sweep |
| D9 | none | `update_mass = NM` on evaluation rows — **verified consistent** |

**No runtime behaviour is claimed.** Every item is static source reading; no binary
was built and no row was produced.

---

## Part 5 — C1–C7 status

| ID | Status |
|---|---|
| C1 | **BLOCKED-ON-CODE** |
| C2 | **BLOCKED-ON-CODE** |
| C3 | **BLOCKED-ON-CODE** (+ caveats D6/D7) |
| **C4** | **SPEC-ERRATUM** — requirement stands, rationale and verification procedure corrected |
| C5 | **BLOCKED-ON-CODE** |
| C6 | **BLOCKED-ON-RUN** |
| C7 | **BLOCKED-ON-CODE** |

**No condition is satisfied.** The only movement is that C4's specification is now
known to contain an error; acting on R3 before the v0.2.1 errata would implement two
unreachable invariants, one wrong diagnostic, one undefined token and one
unimplementable helper.

---

## Part 6 — Protocol and preregistration impact

| Proposal | Class | Criterion affected |
|---|---|---|
| R4 (two named A4 metrics) | metric-definition | **none** |
| R4b (tie-break wording) | metric-definition (documentary) | none; **zero numeric effect** |
| R4c (`Read_rule(A4)`) | metric-definition | none |
| **R5** | **acceptance-criterion** | **L11-C only** |
| R5b | acceptance-criterion | would be L11-C; **declined** |
| D1–D8 | serialization / instrumentation | none |

**0 experimental-design changes · 1 acceptance-criterion change.**

A **versioned amendment** is required (v0.1 → v0.2), not a schema revision: the
protocol is frozen *by hash*, so a new document is drafted alongside v0.1, which
stays byte-identical. Amendment items A-1 … A-6 are drafted in
`work/L11_4_PROPOSED_AMENDMENT.md` and **left unregistered**.

**The protocol must not be described as frozen and unambiguous.**

---

## Part 7 — Deliverables and hashes

See `work/L11_4_MANIFEST.md` for the authoritative hash table.

| # | Path |
|---|---|
| 1 | `work/L11_4_PROTOCOL_SEMANTICS_REVIEW.md` |
| 2 | `work/L11_4_PROTOCOL_SEMANTICS_REVIEW.json` |
| 3 | `work/L11_4_R4_COMPETING_DEFINITIONS.md` |
| 4 | `work/L11_4_R5_METRIC_CONTRACT.md` |
| 5 | `work/L11_4_SCHEMA_V0_2_CONSISTENCY_REVIEW.md` |
| 6 | `work/L11_4_C1_C7_MATRIX_UPDATE.md` |
| 7 | `work/L11_4_PROTOCOL_IMPACT_ASSESSMENT.md` |
| 8 | `work/L11_4_PROPOSED_AMENDMENT.md` |
| 9 | `work/L11_4_OWNER_DECISION_RECORD.md` |
| 10 | `work/L11_4_COMPLETION_REPORT.md` |
| 11 | `work/L11_4_MANIFEST.md` |

Every conclusion in them is labelled **[V]** directly verified, **[A]** committed
artifact, **[I]** inferred, **[P]** proposed, or **[?]** unknown/blocked.

---

## Part 8 — R1–R5 decision status

| ID | Status | Blocks |
|---|---|---|
| **R1** | **NOT RATIFIED** | any official run |
| R2 | approved in principle · **unapplied** | affinity test remains UNEXECUTED |
| R3 | conditionally approved in principle · **unapplied** | implementation; now also needs the v0.2.1 errata |
| **R4** | analytically resolved · **procedurally open** | protocol unambiguity |
| R4b | open (latent, zero effect) | nothing today |
| R4c | open | completeness of A4 reporting |
| **R5** | analytically resolved · **procedurally open** | **every official run** |
| R5b | open (declined for now) | nothing |
| R6 | open | preregistration completeness |

R1, R2 and R3 are tracked separately from R4/R5 and are **unchanged**. R3's
conditional recommendation is **not** treated as a completed authorisation.

---

## Part 9 — Remaining blockers

1. **R5 ratification** — blocks every official run.
2. **R4/R4b/R4c ratification** — blocks calling the protocol unambiguous.
3. **R5b decision** — blocks nothing today.
4. **R6 hash re-record** (schema v0.2.1) — blocks preregistration completeness.
5. **R1 ratification.**
6. **Arm implementation** — five of eleven arms do not exist
   (`CROSS21`, `CROSS31`, `AMBIG11`, `MISLEAD`, `ORDERPERM`); class **X**, never
   authorised, not proposed here.
7. **Implementation under C1–C7**, then the C6 battery.

Items 1–5 are owner decisions. Items 6–7 are authorised work. **No further
document can move 1–5.**

---

## Part 10 — Official L11 status

**Official L11 evaluation not run. Zero official arms. Zero official trials. No
model or harness implementation changes.**

Verified this milestone: the `CueMode` enum contains only `TRAIN`, `HOLDOUT`, `OFF`,
`SHUFFLED`, `CROSS`, `PARTIAL`, `OFF_UNIFORM`. **No `AMBIG11`, `CROSS21`,
`CROSS31`, `MISLEAD` or `ORDERPERM` mode exists**, so no L11 arm can be evaluated
even with a ratified protocol.

---

## Part 11 — Overall APEX progress

**≈ 57 %, unchanged.**

This milestone sharpens the *definition of a measurement* for a capability that has
not been demonstrated. Pinning down what a criterion means is necessary work; it is
not evidence of compositional generalization, and nothing here supports a capability
claim.
