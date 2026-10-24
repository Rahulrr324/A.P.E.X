# STARK-L11.5 — C1–C7 Reconciliation and Readiness Gates

The seven conditions are reproduced **verbatim** from
`work/L11_2_R3_AUTHORIZATION_AUDIT.md` §8 ("The seven conditions" table, lines
450–458), read from the committed file in this milestone. They are not paraphrased
and not weakened.

**Audit file sha256:** `5045c1576cd207e42cc58638163b3a1c74f73fcea1fbfadeef978e290fcf1015`.

---

## 1. The conditions, verbatim

| # | Condition (audit §8, verbatim) |
|---|---|
| **C1** | "Separate writer only; `writeTrialCsv` and `writeTaskCsv` are not edited; legacy files must hash-match the disabled run" |
| **C2** | "Capture lives inside `evalTask`'s `if (rows)` block and **before** the restore at line 275; nothing is captured at any `runCCTrial` call site; the routing re-derivation block (505–521) emits no rows" |
| **C3** | "Update mass is captured per trial (no reuse of a stale `w0`); `advantage` uses a pre-call baseline snapshot at index 0" |
| **C4** | "**Schema v0.2 first:** add `task_bank`, `rule_bank`, `rule_compliant`, `presented[]`, `choice_matches_resolved_bank_map`; define `routing_correct := selected == task_bank`; implement P7 against `rule_bank`" |
| **C5** | "Exactly one source file changes; no new RNG engine anywhere; no engine file touched" |
| **C6** | "The non-interference run must include checks 1–8 **plus** 7′, 9, 10, 11, 12, 13, 14 (§5) before any arm is implemented" |
| **C7** | "`ccSerialize` only at run start and task boundaries, never per trial" |

---

## 2. Classification key

| Label | Meaning |
|---|---|
| **SAT-VERIFIED** | satisfied by evidence that has actually been produced and captured |
| **SAT-SPEC** | satisfied at specification level only — a document exists, no code does |
| **BLK-IMPL** | blocked pending implementation |
| **BLK-RUN** | blocked pending a runtime test |
| **BLK-OWNER** | blocked pending an owner decision |
| **UNRESOLVED** | cannot be classified with the available evidence |

---

## 3. Status per condition

| ID | Status | Basis | What remains |
|---|---|---|---|
| **C1** | **BLK-IMPL** | `writeTrialCsv` (`:662`) and `writeTaskCsv` (`:624`) are untouched in every L11 commit **[V]**; no separate writer exists | implement `writeL11Csv`; then compare legacy file hashes with the flag off |
| **C2** | **BLK-IMPL** | anchors re-verified: `if (rows)` ends `:272`, restore `:274`, re-derivation block has **zero** `push_back`, 8 `dump_rows` sites one of which passes `nullptr` (`:592`) **[V]** | implement capture; then assert 120 rows/call |
| **C3** | **BLK-IMPL** (+ latent D6/D7) | `w0` refreshed only under `measure \|\| maybe_opp` (`:429`) **[V]**; baseline index is `baseline_per_bank ? bank : 0` (`ContextConditionedMemory.cpp:487`) **[V]** | implement; then test 10 (recompute mass and advantage) |
| **C4** | **SAT-SPEC (requirement)** + **ERRATUM (rationale and verification)** | schema v0.2 exists (`1ce1525b…`) with all five fields and both derivations; but the audit's rationale is wrong for `AMBIG11` and the L11.3 V4 assertion is wrong (D4) | **do not act on C4 until the v0.2.1 errata and R4/R5 are decided** |
| **C5** | **BLK-IMPL** | no patch exists; the file count is an *estimate* (L11.3 §4), not a measurement | implement; then `git diff --stat` must show one file and the RNG grep must be empty |
| **C6** | **BLK-RUN** | no instrumented binary exists; none of checks 1–8, 7′, 9–14 has ever been executed | all 13 checks |
| **C7** | **BLK-IMPL** | `ccSerialize` currently called at `evalTask` entry only when `read_only` (`:173`), plus the re-derivation snapshot (`:504`) and the round-trip probes (`:601–603`, `:829–838`) **[V]** | implement; then review + timing |

**No condition is satisfied.** C4's specification half is *written down*, but L11.5
found that the specification itself contains an error (D4) and that its rationale is
factually wrong (R4-5). **A documentation correction does not prove implementation
readiness**, and nothing here claims it does.

---

## 4. Re-assessment of C4

### 4.1 What C4 requires, and whether that requirement still stands

| C4 element | Still required? | Note |
|---|---|---|
| `task_bank` field | **yes** | unchanged |
| `rule_bank` field | **yes** | and now *more* necessary: it diverges on A4 as well as A6/A7 |
| `rule_compliant` field | **yes** | unchanged |
| `presented[]` field | **yes** | with the `NA:UNUSED_CHANNEL` correction (D3) |
| `choice_matches_resolved_bank_map` | **yes** | unchanged |
| `routing_correct := selected == task_bank` | **yes** | unchanged |
| "implement P7 against `rule_bank`" | **yes** | but P7's signature must take the group→bank map (D4) |

### 4.2 What C4's *rationale* got wrong

**[V]** Audit lines 190–193 assert that `task_bank` and `rule_bank` "coincide for
`TRAIN`, `HOLDOUT`, `PARTIAL`, `CROSS21`, `CROSS31` **and `AMBIG11`** (by
construction the majority group *is* the intended task's group), and they diverge for
`MISLEAD` and `SHUFFLED`".

`AMBIG11` is a **1:1 tie** (protocol §4) — there is no majority group. They diverge
there too **[V]**. The correct list of divergent categories is
**`AMBIG11`, `MISLEAD`, `SHUFFLED`**.

**Effect on C4:** none on the requirement — the split is *more* necessary than the
audit knew, not less. The audit's *conclusion* is sound; its *reason* is incomplete.
The audit file is frozen and **must not be edited**; the correction lives here and in
the L11.4 review.

### 4.3 What C4's *verification* got wrong

L11.3's V4 assertion required the rule helper's signature to contain "the cue only
(no task index, no mapping)". **This is impossible** (D4): a group index is not a
bank index, so the group→bank map is required to name any bank at all. The property
that actually prevents defect S1 is **the absence of the task index**, not the absence
of the map.

### 4.4 Ordering consequence

C4's specification half is written, but the following must precede any implementation
that acts on it:

1. R4 / R4b / R4c ratified (they determine what `rule_bank` and `rule_compliant`
   are used for);
2. the v0.2.1 errata settled (D1–D8);
3. R5 ratified (it determines whether `MixAcc` is even the reported metric);
4. the schema hash re-recorded (R6).

**C4 is not "done".** It is *written*, with known errors, pending decisions.

---

## 5. Readiness gates, in dependency order

| # | Gate | Type | Status |
|---|---|---|---|
| G1 | R4, R4b, R4c ratified | **owner** | open |
| G2 | R5 ratified; R5b decided | **owner** | open |
| G3 | v0.2.1 errata D1–D8 adopted | owner + documentation | open |
| G4 | schema hash re-recorded (R6) | owner + documentation | open |
| G5 | R1 (thresholds) ratified | **owner** | open — **not ratified** |
| G6 | R2 affinity port applied | authorized work | open, independent |
| G7 | R3 implementation authorized *and* the C1–C7 patch written | authorized work | open |
| G8 | C6 battery passes (13 checks) | run | open |
| G9 | arm implementation (`CROSS21`, `CROSS31`, `AMBIG11`, `MISLEAD` vs `SHUFFLED`, arm selector) | **class X, not authorized** | open |
| G10 | protocol §11 rule unit test passes | run | open — never executed |
| G11 | preflight review, then official run | owner | open |

**G9 is the gate most often overlooked:** C6 says the non-interference battery runs
"before any arm is implemented", which means instrumentation can be validated first —
but no L11 criterion can be *evaluated* until the arms exist, and the arms are an
experimental-design change that has never been authorized.

---

## 6. What would change each status (and what would not)

| Action | Changes | Does **not** change |
|---|---|---|
| Writing more documentation | nothing in this table | any status |
| Writing the patch | C1, C2, C3, C5, C7 → BLK-RUN | C4, C6, G1–G5 |
| Running the C6 battery | C6 → SAT-VERIFIED (if it passes) | G1–G5, G9 |
| Ratifying R4/R5 | G1, G2 | C1–C7 implementation status |
| Implementing the arms | G9 | any condition until C6 passes first |

---

## 7. Honest statement

- **No condition is satisfied.**
- **C4 is satisfied at specification level only**, and that specification has a known
  error.
- The word "readiness" in this milestone's title refers to *assessing* readiness, not
  to *having* it. The repository is **not** implementation-ready: four owner
  decisions, one schema errata pass, one hash re-record, one patch, one battery and
  one arm-implementation package stand in the way.
