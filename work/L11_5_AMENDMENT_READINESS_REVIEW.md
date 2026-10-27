# STARK-L11.5 — Protocol Amendment and Implementation-Readiness Review (consolidated)

**Milestone:** STARK-L11.5
**Branch:** `validation/l11-5-amendment-readiness`, from verified L11.4 `effb56a`
**Nature:** documentation only · **no source, harness, test, protocol or
preregistration change** · no PR · no history rewrite · no official run

**Tags:** **[V]** verified in file/source · **[A]** committed artifact · **[C]**
computed here by exact arithmetic · **[I]** inferred · **[P]** proposed · **[?]**
unknown/blocked.

---

## 0. Result in one paragraph

R4 and R5 are analysed to the point where further documentation cannot advance them.
R5's classification is sharper than L11.4's: because **no L11 criterion has ever been
authorized**, "clarifying an already-authorized metric" is structurally unavailable,
and L11-C sits at the boundary of *restoring a documented definition* (its content)
and *a new owner decision* (its authority) — the operative classification is the
latter. R5 also has a decisive structural fact: **L11-C's only decision-relevant
content is its `CROSS31` clause**, because the `CROSS21` clause is implied by L11-A ∧
L11-D and the criteria are conjunctive. The schema audit confirms all nine L11.4
findings (none disproved; two understated) and is static only. The arm inventory finds
something L11.4 understated: **not five but eleven arms are unaddressable**, because
the harness has no arm-selection mechanism at all, and `MISLEAD`/`SHUFFLED` are the
same cue construction. **No condition is satisfied; nothing is ratified; the protocol
is not unambiguous.**

---

## 1. Provenance

| Item | Value |
|---|---|
| Origin | `https://github.com/Rahulrr324/A.P.E.X.git` **[V]** |
| Session branch at start | `arena/86da64f9-a-p-e-x` @ `5f5a577…` locally, clean-except-residue |
| **Branch discrepancy** | local `arena/86da64f9-a-p-e-x` = `5f5a57717509623bd4c79460d50c05f7cbc605c3` (**PR #2 head**); **remote** `refs/heads/arena/86da64f9-a-p-e-x` = `49cc6ba18650c0d9614bb9e8918fe65453ec5a02` (**PR #3 head**) **[V]** |
| Consequence | committing and pushing to that name would advance **PR #3**. Prohibited. A dedicated validation branch is the only path that satisfies both the mission and the "do not modify PR #2/#3" rule |
| L11.4 commit | `effb56aa6cb861934eedbf38df2da054db309d5c`, parent `e8955df…`, exists locally and remotely **[V]** |
| Ancestry | `effb56a → e8955df → deac50f → c547aab → 6a43974 → 77d261a`; all confirmed ancestors; `5f5a577` is also an ancestor **[V]** |
| Tree identity before branching | **6029 / 6029** files of the `effb56a` tree byte-identical on disk, 0 mismatches, 0 missing **[V]** |
| Working tree after branching | clean, 0 entries **[V]** |
| PR #1 / #2 / #3 | MERGED `c32071e` / OPEN `5f5a577` / OPEN `49cc6ba` — **none modified** **[V]** |
| Protocol | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` — **equals the prereg record** (recomputed) **[V]** |
| Specification | `d9cd7dc4024e407317a083001aff40bd287cad0f301f777cdfc5082afc3ae542` — equals prereg **[V]** |
| Schema v0.1 | `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917` — equals prereg **[V]** |
| Schema v0.2 proposal | `1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8` **[V]** |
| Preregistration | `57a8139d…`, `PROTOCOL_FROZEN_FOR_REVIEW / THRESHOLDS_PENDING_OWNER_RATIFICATION`, `criteria_candidate.ratification = PENDING_OWNER_DECISION` **[V]** |
| L11.2 audit | `5045c1576cd207e42cc58638163b3a1c74f73fcea1fbfadeef978e290fcf1015` **[V]** |
| Harness | `697b5f8a…` — unchanged **[V]** |
| Affinity test | `9dab81ee…` — unchanged **[V]** |

---

## 2. R4 — summary

Full table: `work/L11_5_R4_DECISION_TABLE.md`.

**Verified afresh [V]:**
- Protocol **§4 contains no rule** — `grep -i majority` and `grep -i tie` over the
  protocol hit only §1, §6 and §11. The specification's claim that the rule "is
  declared in `l11_1_protocol.md` §4" is **false**.
- Protocol **§11 references `intended_bank`**, a field **schema v0.2 removes**.
- `AMBIG11` is a **1:1 tie**: task-bank and rule-bank definitions diverge on
  **0 % / 50 % / 100 %** of its trials for tasks 0/1/2 (**50 % overall**) **[C]** —
  with n = 120 that is ~11 standard errors, and it is **task-structured**, with no
  order-permuted `AMBIG11` control.
- `AMBIG11` may **not** enter the primary composition metric: it is designated
  "tie-break compliance only; carries no accuracy claim", no criterion references it,
  and there is no majority to compose.

**Recommendation [P]:** report `Comp_task(A4)` and `Comp_rule(A4)` separately and by
name; keep `Comp` on `CROSS21`/`CROSS31`/`ORDERPERM`. It changes no criterion.

**Does it fully resolve the ambiguity? No.** Three items stay open: the tie-break
wording (**R4b**), `Read` conditioning (**R4c**), and the unspecified `o` distribution
(finding F2). Plus the rule is absent from every ratified document (amendment A-3).

**Status: R4 open, R4b open, R4c open.** Not resolved by having a recommendation.

---

## 3. R5 — summary

Full analysis: `work/L11_5_R5_METRIC_AND_THRESHOLD.md`.

**Verified afresh [V]:** the frozen and registered text omit the metric; the
readiness proposal (`ba1cfb3`, a verified ancestor of the freeze) names `MixAcc`; the
freeze declares the criteria "unchanged … except where marked" and marks only L11-G;
`git grep L11-C` finds no implementation anywhere.

**Two new results this milestone [C]:**

1. **`MixAcc ≥ 0.81` on A2 follows from L11-A ∧ L11-D.** Since the criteria are
   conjunctive, L11-C's **A2 clause cannot change any verdict**. Its entire
   decision-relevant content is the **A3 (`CROSS31`) clause**, which no other
   criterion touches.
2. **The 0.50 threshold has no derivation and is statistically weak at its own
   value.** At n = 120: `P(pass | true = 0.4259 — the L10-measured floor) = 0.061`;
   `P(pass | true = 0.50) = 0.536`; Wilson 95 % half-width ≈ 0.088. It is a genuine
   collapse-detector against the floor and a coin flip at the threshold — the same
   character L11.1 documented for L11-A. A pass must read "consistent with ≥ 0.50 at
   n = 120".

**Authorization classification — the central question:**
- **No L11 criterion has ever been authorized** (`PENDING_OWNER_DECISION`), so
  category 1 ("clarifying an already-authorized metric") is **structurally
  unavailable**.
- The evidence supports category **2 in content** (a documented definition the freeze
  declared unchanged) but **not category 2 in authority** (the document being restored
  was an unratified proposal).
- **Operative classification: category 3** — a new owner decision, with category-2
  evidence as its justification. **The repository cannot sharpen this distinction,
  because the only document that could — a ratification record — does not exist.** The
  limitation is stated explicitly.
- The **0.50 threshold** is category 3 **without ambiguity**: never authorized, never
  derived.

**Status: R5 open, R5b open (not adopted).**

---

## 4. Schema audit — summary

Full matrix: `work/L11_5_SCHEMA_AUDIT_MATRIX.md`. **Static inspection only; no binary
built, no run performed, no runtime behaviour claimed.**

| ID | Verified | Correction proposed | Runtime test needed |
|---|---|---|---|
| D1 `selected_bank = -1` unreachable | **confirmed** (`bank<0 → 0`, `CCM.cpp:345`) | always ≥ 0; `-1` is `INVALID`; protocol §8(i) is **inert** | yes |
| D2 margin unmasked | **confirmed** (`candidateMask`, default `route_over_allocated_only=true`) | mask it; add `NA:LT2_CANDIDATES` | yes |
| D3 `X` token undefined | **confirmed and understated** — also a type defect (`semi` of ints) and an undefined indexing semantic | `NA:UNUSED_CHANNEL`; retype; fix invariants 10–11 | no |
| D4 P7 needs the map | **confirmed** (`ccAllocateNext`; group = `f/4`) | take the read-only group→bank map; rewrite V4 | yes, later |
| D5 `Read(A4)` task-conditioned | **confirmed** | add `Read_rule(A4)` (R4c) | no |
| D6 baseline index config-dependent | **confirmed** (`baseline_per_bank ? bank : 0`; default false; harness never sets it) | record `baseline_index` | yes |
| D7 router predicate narrower | **confirmed** (also requires `forced_bank < 0`) | state the predicate literally | yes |
| D8 invariant 20 vs `per_bank_off` | **confirmed** (`:592`, `call_id = -1`, `forced_bank = kb`) | widen to `{forced_bank, per_bank_off}` | no |
| D9 `update_mass = NM` on eval rows | **confirmed consistent** | none | — |

**No L11.4 finding was disproved. Two were understated.**

---

## 5. Arm inventory — summary

Full inventory: `work/L11_5_ARM_IMPLEMENTATION_INVENTORY.md`.

**The decisive finding [V]: `spec.eval_cue` is initialised to `CM_TRAIN` at
`l10_validation_harness.cpp:153` and is never assigned anywhere, and there is no
`--eval-cue` flag.** The primary and retention evaluations are therefore hard-wired to
`TRAIN`. **No L11 arm is selectable.**

| Arms | Status |
|---|---|
| A0 `TRAIN`, A1 `HOLDOUT`, A5 `PARTIAL`, A7 `SHUFFLED`, A8 `OFF` | cue construction **exists** as a fixed diagnostic (A1 and A7 with `want_routing=false`) |
| A4 `AMBIG11` | **partial** — `CM_CROSS` is a 1+1 cue, i.e. the `AMBIG11` construction, under a different stream and with no rule machinery |
| A6 `MISLEAD` | **partial** — `CM_SHUFFLED` **is** the `MISLEAD` construction (finding F1) |
| A2 `CROSS21`, A3 `CROSS31`, A9, A10 | **cue absent**; A9's `--order` and A10's `--bank-mode frozen` mechanisms exist but have no `CROSS21` cue to evaluate |

**Two newly discovered ambiguities:**
- **F1 [V]: `MISLEAD` and `SHUFFLED` are the same cue construction.** "2 features from
  `g(o)`" *is* "a `TRAIN` pair of another task". The code implements one mode.
- **F2 [V]: the `o` sampling distribution is unspecified** in every category; it
  determines the expected `AMBIG11` divergence.

**Missing arm implementation is kept separate from missing instrumentation:** the C6
battery can validate instrumentation on existing conditions, but **no criterion can be
evaluated until the arms exist**, and the arms are class **X** — never authorized.

---

## 6. C1–C7 — summary

Full reconciliation: `work/L11_5_C1_C7_RECONCILIATION.md`, conditions quoted verbatim
from the audit §8.

| ID | Status |
|---|---|
| C1, C2, C3, C5, C7 | **BLK-IMPL** |
| C4 | **SAT-SPEC + ERRATUM** — requirement stands; rationale wrong for `AMBIG11`; V4 assertion wrong |
| C6 | **BLK-RUN** |

**No condition is satisfied.** A documentation correction does not prove
implementation readiness, and this milestone does not claim it does.

---

## 7. Amendment package

`work/L11_5_AMENDMENT_DRAFT.md` — marked **UNREGISTERED — PENDING OWNER DECISION**,
containing exact proposed text, a before/after comparison of every affected
definition, and a compatibility analysis against the protocol, preregistration, schema
v0.2 and all prior reports.

Items A-1 … A-6 are drafted. **A-7 (the `o` distribution and the
`MISLEAD`/`SHUFFLED` distinction) is listed but deliberately not drafted**, because it
is an experimental-design change that is not authorized; its absence is stated so it
is not mistaken for an oversight.

**Exactly one item changes an acceptance criterion: A-5 (L11-C).** Every other item is
metric-definition, serialization, or instrumentation.

---

## 8. Decisions

| ID | Status |
|---|---|
| **R1** | **NOT RATIFIED** |
| R2 | approved in principle · **unapplied** · test UNEXECUTED (build failure) |
| R3 | conditionally approved in principle · **unapplied** · prerequisite now includes the v0.2.1 errata |
| **R4** | open · analysed · recommendation stated |
| **R4b** | open · zero numeric effect today |
| **R4c** | open |
| **R5** | open · **blocks every official run** |
| **R5b** | open · **not adopted** |
| **R6** | open · record v0.2 **and** v0.2.1 hashes |
| **F1** | unresolved · `MISLEAD` ≡ `SHUFFLED` |
| **F2** | unresolved · `o` distribution |
| **F3** | unresolved · protocol §11 references the removed `intended_bank` |

Approval, work and authority are tracked separately in
`work/L11_5_DECISION_REGISTER.md`.

---

## 9. Final gate

| Question | Answer |
|---|---|
| Is the protocol frozen? | **Yes, at v0.1 (`322078c8…`) — and it is ambiguous.** |
| Is the instrumentation implemented? | **No.** No `--emit-l11`, no separate writer, no v0.2 row capture. |
| Do all required arms exist? | **No.** 0 of 11 are selectable; 3 cue constructions are absent; 2 more are underspecified. |
| Is official evaluation authorized? | **No.** R1 unratified, R5 open, C1–C7 unsatisfied, arms absent. |
| Did any official L11 run occur? | **No. Zero official arms. Zero official trials.** |
| Are the frozen artifacts unchanged? | **Yes — protocol, preregistration, specification, schema v0.1 all byte-identical to their registered hashes.** |
| Overall APEX progress | **≈ 57 %, unchanged.** |

---

## 10. Owner decisions needed next

1. **R5** — ratify `L11-C := MixAcc`, per cell, 0.50 unchanged (or choose another
   option). *Blocks every official run.*
2. **R4** — ratify the two-named-metric reporting for A4.
3. **R4b** — pin the tie-break to the bank index.
4. **R4c** — add `Read_rule(A4)`.
5. **R5b** — adopt-with-contract or reject the pooled clause.
6. **F1 / F2** — how `MISLEAD` differs from `SHUFFLED`, and the `o` distribution.
7. **R6** — re-record the v0.2 protocol and v0.2.1 schema hashes when adopted.
8. **R1** — ratify the criteria and thresholds (cannot be discharged by 1–7).

Nothing in this repository can move any of these. Eight sentences close the protocol;
everything else is downstream.
