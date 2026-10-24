# STARK-L11.4 — Protocol Semantics Review (consolidated)

**Milestone:** STARK-L11.4 — Protocol Semantics Resolution and Schema v0.2 Review
**Branch:** `validation/l11-4-protocol-semantics` (from verified L11.3 state `e8955df`)
**Nature:** documentation only. No source, harness, protocol, preregistration or
test file was modified. No L11 evaluation was run. No arm was created. No trial
was generated.

**Labels:** **[V]** verified in source/file · **[A]** committed artifact · **[I]**
inferred · **[P]** proposed · **[?]** unknown/blocked.

---

## 0. One-paragraph result

R4 and R5 are **analytically resolved** — the evidence supports one definition each
— and both remain **procedurally open**, because resolving them changes the meaning
of a frozen metric (R4) and of a preregistered acceptance criterion (R5). A
decision-ready amendment is drafted and left unregistered. The v0.2 schema review
found **one high-severity impossibility** (an unreachable state described as real),
**two high-severity computational defects** (an unmasked margin; an unimplementable
rule helper), **one undefined token**, and several latent issues — all as *errata
proposals*, with the v0.2 file itself untouched. No criterion number moves under
R4; **L11-C moves under R5**, and that is the only acceptance-criterion change in
the milestone.

---

## 1. Provenance and Git state

| Item | Value | How |
|---|---|---|
| Origin | `https://github.com/Rahulrr324/A.P.E.X.git` | `git remote -v` |
| Branch at start | `validation/l11-3-schema-v0-2` @ `e8955dfd6d87fe9de84bfe1746901825270e182e`, tree clean (0 entries) | `git status --porcelain` |
| L11.3 state exists locally **and** remotely | `git ls-remote` → `e8955df… refs/heads/validation/l11-3-schema-v0-2` | **[V]** |
| Parent chain | `e8955df → deac50f (audit) → c547aab → 6a43974 (L11.1) → 77d261a` | **[V]** |
| PR #2 | OPEN, head `5f5a57717509623bd4c79460d50c05f7cbc605c3`, base `main` | **[V]**, unmodified |
| PR #3 | OPEN, head `49cc6ba18650c0d9614bb9e8918fe65453ec5a02`, base `arena/c90f7329-a-p-e-x` | **[V]**, unmodified |
| Protocol | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` | **[V]** |
| Preregistration | `57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b`, `PROTOCOL_FROZEN_FOR_REVIEW / THRESHOLDS_PENDING_OWNER_RATIFICATION` | **[V]** |
| Schema v0.1 | `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917` | **[V]** |
| Schema v0.2 (proposal) | `1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8` | **[V]** |
| Specification | `d9cd7dc4024e407317a083001aff40bd287cad0f301f777cdfc5082afc3ae542` | **[V]** |
| L11.3 completion report | `2499af1f392a2020708dad13d079d316c0d2f15d5a54ffe659f9d9adeaeb8291` | **[V]** |
| **prereg protocol hash == protocol file hash?** | **YES** (`322078c8…` on both sides, recomputed with sha256) | **[V]** |
| prereg spec hash == spec file? | YES (`d9cd7dc4…`) | **[V]** |
| prereg schema hash == v0.1 file? | YES (`a8edd674…`) | **[V]** |
| L11.3 documentation-only scope intact? | **YES** — no source, test, protocol or prereg diff between `deac50f` and `e8955df` | **[V]** |
| Untracked residue relied upon? | none — the tree was clean at start; every fact below is read from committed files | **[V]** |

### 1.1 Branch-selection discrepancy (reported, not worked around silently)

The session's tracked branch name is `arena/86da64f9-a-p-e-x`. **[V]** on the remote,
`refs/heads/arena/86da64f9-a-p-e-x` = `49cc6ba…`, which is the **head of PR #3**;
locally the same name sits at `5f5a577…`, the **head of PR #2**. Committing to
either would modify PR #2 or PR #3, which this mission forbids. A dedicated
`validation/*` branch is therefore the **only** path that satisfies both the
mission's "dedicated validation branch" requirement and its "do not modify PR #2 or
PR #3" requirement — and it matches the established workflow (every L10.x and L11.x
milestone lives on a `validation/*` branch). Recorded here rather than resolved
silently.

---

## 2. R4 — `Comp` for `AMBIG11`

Full analysis: `work/L11_4_R4_COMPETING_DEFINITIONS.md`.
Summary here.

### 2.1 The competing definitions, and the shared root cause

| Where | Says | Computes |
|---|---|---|
| protocol §6 line 104 | `Comp = routing` on `CROSS21/CROSS31/ORDERPERM` — "this is the R-majority compliance rate" | task bank |
| protocol §6 lines 105–106 | "For `AMBIG11` the prescribed bank is the lowest-index of the two groups" | rule bank |
| spec §2.1 line 63 | "ties broken by the lowest **bank** index" | rule bank |
| prereg `declared_rule` | "ties broken by lowest **bank** index"; applies to `AMBIG11 (tie-break clause)` | rule bank |
| audit line 198 | `rule_bank` … "(**L11 Comp meaning**)" | rule bank |
| spec §3 line 80 / §5 line 126 | A4 = "tie-break compliance only; carries no accuracy claim" | rule bank |

**Root cause [V]:** spec §2.1 says the rule "is declared in
`stark/design/l11_1_protocol.md` **§4**" — but §4 is the cue-construction table and
contains **no rule**. The rule text is split across a specification document and one
sentence of §6, and the two do not agree. The dangling cross-reference is the
structural cause of R4.

### 2.2 Two findings about the existing record

- **[V] The audit is factually wrong about `AMBIG11`.** Audit lines 190–193 claim
  `task_bank` and `rule_bank` coincide "for … `AMBIG11` (by construction the
  majority group *is* the intended task's group)". `AMBIG11` is a **1:1 tie**; there
  is no majority. They coincide only when the evaluated task's bank happens to be
  the lower-indexed of the two. C4's *requirement* (split the field) is unaffected —
  the error makes the split *more* necessary, not less — but the audit's list of
  divergent categories should read `AMBIG11`, `MISLEAD`, `SHUFFLED`.
- **[V] The two readings are not close.** With `o` uniform over the two other tasks,
  the definitions diverge on **0 % / 50 % / 100 %** of `AMBIG11` trials for tasks
  0 / 1 / 2 — **≈50 % overall**, and the divergence is *structurally
  task-dependent*. `AMBIG11` has no order-permuted counterpart arm to control that
  dependence, unlike `CROSS21` which has A9 and criterion L11-G.

### 2.3 Recommendation

**[P] Report both, named separately:** `Comp_task(A4)` and `Comp_rule(A4)`; keep
`Comp` restricted to `CROSS21 / CROSS31 / ORDERPERM`.

- Changes **no criterion** — no criterion references A4 **[V]**.
- Keeps task-correct routing (Q1) and rule compliance (Q2) distinct.
- Refuses to repeal the declared tie-break, which task-bank-only scoring would do.
- Rejected alternatives: rule-only (hides a routing failure), undefined (loses
  information for no saving), and a stability-under-ambiguity metric — **[V]**
  unimplementable, because evaluation routing is a deterministic masked argmax
  (`ccPreferredBank`), so repeated identical cues always return the same bank.

**[P] R4b:** pin the tie-break to "lowest **bank** index" (matches the prereg and
the spec; the protocol is the outlier). **[V] No numeric effect today** — A4 runs in
standard order where `task_bank = [0,1,2]`, so the two wordings coincide exactly.

---

## 3. R5 — L11-C

Full analysis + contract: `work/L11_4_R5_METRIC_CONTRACT.md`.

### 3.1 The chain of evidence

1. **[V]** The frozen text (protocol, spec, prereg, L11.1 instrumentation record —
   all four) says "no cell `(seed, task)` in A2 or A3 below 0.50" and **never names
   a metric**.
2. **[A]** `work/L11_READINESS_ASSESSMENT.md:254` (commit `ba1cfb3`, an ancestor of
   the freeze `77d261a` **[V]**) states L11-C as "`MixAcc` pooled ≥ 0.75 **and** no
   seed/task cell below 0.50 (the clause that would have caught L10.3's 0.0 cell)".
3. **[V]** `work/L11_1_SPECIFICATION_AND_INSTRUMENTATION.md:250–253` says the
   criteria are "unchanged from the readiness proposal **except where marked**" and
   marks only **L11-G**. → the metric name was lost in drafting, not removed by
   decision.
4. **[V]** The motivating evidence is an **accuracy** statistic: L10.6 sign-off
   line 252 — "pooled 0.5611 with a seed that reaches **0.0** on one task; spread
   0.0–1.0"; L10.3 table line 104 — pooled accuracy 0.5611, pooled routing 0.5019.

### 3.2 Non-redundancy (the decisive argument)

```
MixAcc = Comp·Read + (1 − Comp)·WrongBankAcc
```
**[I]** With `Comp ≥ 0.90` (L11-A) and `Read ≥ 0.90` (L11-D), `MixAcc ≥ 0.81 > 0.50`
— so L11-C's **A2** clause is implied by other criteria under **both** readings.
The only independent force is **A3**, covered by nothing else.

| A3 outcome | `Comp` reading | `MixAcc` reading |
|---|---|---|
| `Comp = 1.00, Read = 0.00` (routes perfectly, reads nothing) | **PASS** | **FAIL** |

### 3.3 Recommendation

**[P] `L11-C := MixAcc`, per `(seed, task, arm ∈ {A2, A3})` cell, threshold 0.50
unchanged.**

Stated honestly: the two readings are **different predicates, not ordered ones**,
so this is a **redefinition**, not a strengthening. It is chosen on evidence of
intent and on non-redundancy — **not** on any score (no L11 data exists; the
`AMBIG11`/`CROSS31` paths are unimplemented **[V]**).

**R5b:** the "pooled ≥ 0.75" clause appears only in the superseded readiness
proposal and its pooling contract is undefined everywhere. **Not adopted here**;
flagged for a separate decision.

---

## 4. Schema v0.2 consistency review

Full review: `work/L11_4_SCHEMA_V0_2_CONSISTENCY_REVIEW.md`.
**The eight concepts are properly separated** — task bank, rule bank, selected bank,
task correctness, rule compliance, retrieval correctness, missingness and
structural inapplicability each have their own field. That core property survives.

Errata found (proposals only; v0.2 unmodified):

| # | Finding | Severity |
|---|---|---|
| D1 | `selected_bank = -1` is **unreachable** — `runCCTrial` clamps `bank < 0 → 0` [V, `ContextConditionedMemory.cpp:345`]. v0.2 calls it "a real state"; invariant 14 is vacuous; protocol §8(i) is an **inert** validity rule | **high** |
| D2 | `bank_score_margin` is defined over all banks, but the router scores only candidate-masked banks [V, `ccPreferredBank`/`candidateMask`]; needs `NA:LT2_CANDIDATES` | **high** |
| D3 | `presented_ids` relies on an `X` token that **v0.2 never defines**, while the source uses `-1` placeholders | medium |
| D4 | **P7 cannot be computed from the cue alone** — a group index is not a bank index; the map `task_bank` is required. L11.3's V4 assertion ("cue only, no mapping") is therefore **wrong** and would force a wrong implementation | **high** |
| D5 | `Read(AMBIG11)` is conditioned on *task* routing, so rule-following trials are excluded from the denominator → R4c | medium |
| D6 | `advantage`'s baseline index is `baseline_per_bank ? bank : 0`; "index 0" is correct only by default [V] | medium |
| D7 | the router-update predicate is narrower than "unless the router updated": `forced_bank >= 0` suppresses it even on learning trials | low |
| D8 | invariant 20 excludes the legitimate `per_bank_off` forced sweep | low |
| D9 | `update_mass_* = NM` on evaluation rows — **verified consistent** | none |

**Verified-consistent highlights:** `sel_slot = -1` ⇔ single-candidate **[V]**;
`NA:SINGLE_CANDIDATE` cannot occur on evaluation rows (all-pair schedule, 6×20)
**[V]** but does occur on 480 of 720 training rows per task **[V]**; the
re-derivation block emits no rows **[V]**; `record_class` is derivable from
`call_id` because `next_call` encodes purpose **[V]**.

**No runtime behaviour is claimed.** Everything in §4 is static source reading; no
binary was built and no row was produced.

---

## 5. C1–C7 status

Full matrix: `work/L11_4_C1_C7_MATRIX_UPDATE.md`.

| ID | Status |
|---|---|
| C1, C2, C5, C7 | **BLOCKED-ON-CODE** (unchanged) |
| C3 | **BLOCKED-ON-CODE**, with new caveats D6/D7 |
| **C4** | **SPEC-ERRATUM** — requirement stands; rationale wrong for `AMBIG11`; verification assertion V4 wrong |
| C6 | **BLOCKED-ON-RUN** |

**No condition is satisfied.** The only change from L11.3 is that C4's
specification is now known to contain an error. Acting on R3 before the v0.2.1
errata would implement two unreachable invariants, one wrong diagnostic, one
undefined token and one unimplementable helper.

---

## 6. Protocol and preregistration impact

Full assessment: `work/L11_4_PROTOCOL_IMPACT_ASSESSMENT.md`.
Draft amendment: `work/L11_4_PROPOSED_AMENDMENT.md`.

| Proposal | Class | Criterion affected |
|---|---|---|
| R4 (two named A4 metrics) | M | **none** |
| R4b (tie-break wording) | M (documentary) | none; **zero numeric effect** [V] |
| R4c (`Read_rule(A4)`) | M | none |
| **R5 (`L11-C := MixAcc`)** | **A** | **L11-C only** |
| R5b (pooled clause) | A | would be L11-C; **declined for now** |
| D1–D8 schema errata | S / I | none |

**0 experimental-design changes. 1 acceptance-criterion change.**
Because a definition changes, a **versioned amendment** is required, not a schema
revision: the protocol is frozen *by hash*, so any textual change yields a new
document, and v0.1 remains byte-identical alongside it. **The protocol must not be
described as frozen and unambiguous.**

---

## 7. Deliverables

| # | Path |
|---|---|
| 1 | `work/L11_4_PROTOCOL_SEMANTICS_REVIEW.md` (this file) |
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

No file from L11.1, L11.2, L11.3, L10 or the design tree was modified.

---

## 8. Decision status

R1 **NOT RATIFIED** · R2 approved in principle, **unapplied** · R3 conditionally
approved in principle, **unapplied** · **R4** analytically resolved, procedurally
open · **R4b/R4c** open · **R5** analytically resolved, procedurally open ·
**R5b** open (not adopted) · **R6** open.

## 9. Remaining blockers, in order

1. R5 ratification — blocks **every** official run.
2. R4/R4b/R4c ratification — blocks calling the protocol unambiguous.
3. R5b decision — blocks nothing today.
4. R6 hash re-record (schema v0.2.1) — blocks preregistration completeness.
5. R1 ratification — blocks any official run.
6. Implementation under C1–C7 — blocked on all of the above.

## 10. Official L11 status

**Official L11 evaluation not run. Zero official arms. Zero official trials.
No `AMBIG11`, `CROSS21`, `CROSS31`, `MISLEAD`, `ORDERPERM` mode exists in the source
(`git grep` returns nothing), so no L11 trial can be generated at all.**

**[V]** The complete `CueMode` enum in `l10_validation_harness.cpp:83–85` is:

```
CM_TRAIN, CM_HOLDOUT, CM_OFF, CM_SHUFFLED, CM_CROSS, CM_PARTIAL, CM_OFF_UNIFORM
```

| L11 arm | Cue | Implemented today? |
|---|---|---|
| A0 `TRAIN` | `CM_TRAIN` | **yes** |
| A1 `HOLDOUT` | `CM_HOLDOUT` | **yes** |
| A2 `CROSS21` | — | **no** (`CM_CROSS` is the legacy L10 two-task cue, not `CROSS21`) |
| A3 `CROSS31` | — | **no** |
| A4 `AMBIG11` | — | **no** |
| A5 `PARTIAL` | `CM_PARTIAL` | yes (legacy) |
| A6 `MISLEAD` | — | **no** |
| A7 `SHUFFLED` | `CM_SHUFFLED` | yes (legacy) |
| A8 `OFF` | `CM_OFF`, `CM_OFF_UNIFORM` | yes (legacy) |
| A9 `ORDERPERM` | needs `CROSS21` | **no** (blocked on A2) |
| A10 frozen router | `--bank-mode frozen` | yes (mechanism exists) |

**Five of the eleven arms do not exist in the code.** Even a ratified protocol and a
ratified L11-C could not produce an official number today; the arm implementation
(class **X**, experimental-design) has never been authorised and is not proposed
here. This is a separate blocker from R4/R5 and must not be conflated with them.

## 11. Progress

**APEX ≈ 57 %, unchanged.** This milestone improves the *definition of a
measurement* for a capability that has not been demonstrated. It is not a
capability, and no capability claim follows from it.
