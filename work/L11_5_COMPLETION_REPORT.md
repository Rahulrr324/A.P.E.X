# STARK-L11.5 — Completion Report

**Milestone:** Protocol Amendment and Implementation-Readiness Review
**Branch:** `validation/l11-5-amendment-readiness`, from verified L11.4 `effb56a`
**Nature:** documentation only · no source, harness, test, protocol or preregistration
change · no PR · no history rewrite · no force-push · no official run

---

## A. Provenance

| Item | Value |
|---|---|
| Origin | `https://github.com/Rahulrr324/A.P.E.X.git` **[V]** |
| HEAD at start | `arena/86da64f9-a-p-e-x` @ **local** `5f5a57717509623bd4c79460d50c05f7cbc605c3` |
| **Branch discrepancy** | **remote** `refs/heads/arena/86da64f9-a-p-e-x` = `49cc6ba18650c0d9614bb9e8918fe65453ec5a02` = **PR #3 head** **[V]** |
| Handling | **did not commit to that branch** — doing so would have advanced PR #3. Created `validation/l11-5-amendment-readiness` from the verified L11.4 commit instead, per repository convention |
| L11.4 commit | `effb56aa6cb861934eedbf38df2da054db309d5c`, parent `e8955dfd6d87fe9de84bfe1746901825270e182e` **[V]** |
| Ancestry | `effb56a → e8955df → deac50f → c547aab → 6a43974 → 77d261a`; `5f5a577` is also an ancestor **[V]** |
| Tree identity **before** branching | **6029 / 6029** files of the `effb56a` tree byte-identical on disk, **0 mismatches, 0 missing** — proving the 82 untracked files present in the re-provisioned workspace were committed artifacts, not stray residue **[V]** |
| Working tree after branching | **clean, 0 entries** **[V]** |
| PR #1 / #2 / #3 | MERGED `c32071e` / OPEN `5f5a577` / OPEN `49cc6ba` — **none touched** **[V]** |
| Protocol | `322078c8…` — **recomputed, equals the prereg record** **[V]** |
| Specification | `d9cd7dc4…` — equals prereg **[V]** |
| Schema v0.1 | `a8edd674…` — equals prereg **[V]** |
| Schema v0.2 | `1ce1525b…` — unchanged **[V]** |
| Preregistration | `57a8139d…`, `PROTOCOL_FROZEN_FOR_REVIEW / THRESHOLDS_PENDING_OWNER_RATIFICATION`, `ratification = PENDING_OWNER_DECISION` **[V]** |
| L11.2 audit | `5045c157…` **[V]** |
| Harness / affinity test | `697b5f8a…` / `9dab81ee…` — unchanged **[V]** |

---

## B. R4 — composition metrics and `AMBIG11`

**Status: OPEN.** Recommendation stated; not resolved.

**Verified afresh [V]:**
- **Protocol §4 contains no rule.** `grep -i majority` over the protocol hits only
  §1, §6, §11; `grep -i tie` hits only §6. The specification's claim that the rule "is
  declared in `l11_1_protocol.md` §4" is **false**.
- **Protocol §11 checks the writer's `intended_bank`** — a field **schema v0.2
  removes**.
- **`AMBIG11` is a 1:1 tie.** Under standard allocation (`task_bank = [0,1,2]`) the
  task-bank and rule-bank readings diverge on **0 % / 50 % / 100 %** of A4 trials for
  tasks 0/1/2 — **50 % overall** **[C]**. At n = 120 that is ~11 standard errors, and
  the divergence is **task-structured** with no order-permuted A4 control.
- **`AMBIG11` cannot enter the primary composition metric** — it is "tie-break
  compliance only; carries no accuracy claim", referenced by no criterion, and has no
  majority to compose.

**Recommendation [P]:** report `Comp_task(A4)` and `Comp_rule(A4)` separately and by
name; keep `Comp` on `CROSS21`/`CROSS31`/`ORDERPERM`. **Changes no criterion.**

**Not fully resolved by C-d:** R4b (tie-break wording), R4c (`Read` conditioning), F2
(`o` distribution), and the rule's absence from every ratified document remain open.

**R4b [C]:** the two tie-break wordings have **zero numeric effect today**.
**R4c [V]:** `Read(A4)` is conditioned on *task* routing, so rule-following trials
leave its denominator.

---

## C. R5 — `L11-C`

**Status: OPEN. Blocks every official run.**

**Verified afresh [V]:** the frozen and registered text omit the metric; the readiness
proposal (`ba1cfb3`, a verified ancestor of the freeze) names `MixAcc`; the freeze
declares the criteria "unchanged … except where marked" and marks only L11-G;
`git grep L11-C` finds **no implementation anywhere**.

**Two new results [C]:**
1. **L11-C's only decision-relevant content is its `CROSS31` clause.** On A2,
   `MixAcc ≥ Comp·Read ≥ 0.81` follows from L11-A ∧ L11-D, and the criteria are
   conjunctive — so the A2 clause cannot change a verdict. A3 is touched by no other
   criterion.
2. **The 0.50 threshold has no derivation in the record and is statistically weak at
   its own value.** At n = 120: `P(pass | 0.4259 — the L10-measured floor) = 0.061`;
   `P(pass | 0.50) = 0.536`; Wilson 95 % half-width ≈ 0.088.

**Authorization classification:**
- **No L11 criterion has ever been authorized** → category 1 ("clarifying an
  already-authorized metric") is **structurally unavailable**.
- Category **2 in content** (a documented definition the freeze declared unchanged),
  **not category 2 in authority** (the source was an unratified proposal).
- **Operative classification: category 3** — a new owner decision, justified by
  category-2 evidence. **The repository cannot sharpen this distinction**, because the
  only document that could — a ratification record — does not exist. Stated as a
  limitation, not resolved.
- The **0.50 threshold is category 3 unambiguously**.

**Recommendation [P]:** `L11-C := MixAcc`, per `(seed, task, arm ∈ {A2, A3})` cell,
**threshold 0.50 unchanged**. **Not monotone**; not justified by any score.

**R5b:** "pooled ≥ 0.75" — kept separate, **not adopted**.

---

## D. Schema audit — D1–D9

**Static source inspection only. No binary built, no run, no runtime behaviour
claimed.** Full matrix: `work/L11_5_SCHEMA_AUDIT_MATRIX.md`.

| ID | Verified | Severity | Runtime test needed |
|---|---|---|---|
| D1 `selected_bank = -1` unreachable (`bank<0 → 0`, `CCM.cpp:345`) | **CONFIRMED** | high | yes |
| D2 margin must be candidate-masked (`ccPreferredBank`/`candidateMask`) | **CONFIRMED** | high | yes |
| D3 `X` token undefined — **also a type defect and an indexing gap** | **CONFIRMED, understated** | medium | no |
| D4 P7 needs the group→bank map; V4 assertion invalid | **CONFIRMED** | high | yes, later |
| D5 `Read(A4)` task-conditioned | **CONFIRMED** | medium | no |
| D6 baseline index config-dependent | **CONFIRMED** | medium | yes |
| D7 router predicate narrower (also needs `forced_bank < 0`) | **CONFIRMED** | low | yes |
| D8 invariant 20 excludes `per_bank_off` | **CONFIRMED** | low | no |
| D9 `update_mass = NM` on eval rows | **CONFIRMED CONSISTENT** | none | — |

**0 disproved. 2 understated (D1, D3).**

---

## E. Arm inventory

Full inventory: `work/L11_5_ARM_IMPLEMENTATION_INVENTORY.md`.

**Decisive finding [V]: `spec.eval_cue` is hard-wired to `CM_TRAIN`** (declared at
`:153`, never assigned) and there is **no `--eval-cue` or `--arm` flag**. **0 of 11
arms are selectable.**

| Arm | Status |
|---|---|
| A0, A1, A5, A7, A8 | cue construction exists as a fixed post-stream diagnostic |
| A4 `AMBIG11` | **partial** — `CM_CROSS` is the 1+1 construction under a different stream |
| A6 `MISLEAD` | **partial** — `CM_SHUFFLED` **is** the same construction |
| A2, A3, A9, A10 | **cue absent** (A9's `--order` and A10's `--bank-mode frozen` exist but have no `CROSS21` cue) |

**Two new ambiguities:** **F1** `MISLEAD` and `SHUFFLED` are constructionally
identical; **F2** the `o` sampling distribution is unspecified anywhere.

**Missing arm implementation is separated from missing instrumentation:** the C6
battery can validate instrumentation on existing conditions, but **no criterion can be
evaluated until the arms exist**, and the arms are class **X** — never authorized.

---

## F. C1–C7

Quoted verbatim from audit §8. Full reconciliation:
`work/L11_5_C1_C7_RECONCILIATION.md`.

| C1 | C2 | C3 | C4 | C5 | C6 | C7 |
|---|---|---|---|---|---|---|
| BLK-IMPL | BLK-IMPL | BLK-IMPL | **SAT-SPEC + ERRATUM** | BLK-IMPL | BLK-RUN | BLK-IMPL |

**No condition is satisfied.** C4 is written down but contains a known error (D4) and
a factually wrong rationale (`AMBIG11`). **A documentation correction does not prove
implementation readiness.**

---

## G. Decision register

Full register: `work/L11_5_DECISION_REGISTER.md` — approval, work and authority
tracked separately.

| ID | Approval | Work | Authority | Blocks |
|---|---|---|---|---|
| **R1** | **NOT RATIFIED** | drafted (L11-C not evaluable) | none | any official run |
| R2 | approved in principle | **unapplied** | n/a | L11-F gate |
| R3 | conditionally approved in principle | **unapplied** | none | instrumentation |
| R4 | none | analysed | none | unambiguity |
| R4b | none | analysed | none | nothing today |
| R4c | none | analysed | none | A4 reporting completeness |
| **R5** | none | analysed | none | **every official run** |
| R5b | none | analysed, declined | none | nothing today |
| R6 | none | specified | none | prereg completeness |
| F1, F2, F3 | none | identified | none | A4/A6/A7 implementation; §11 correctness |

---

## H. Change and validation record

### H.1 Files created (12)

See `work/L11_5_MANIFEST.md` for the authoritative hash table.

1. `work/L11_5_AMENDMENT_READINESS_REVIEW.md`
2. `work/L11_5_AMENDMENT_READINESS_REVIEW.json`
3. `work/L11_5_R4_DECISION_TABLE.md`
4. `work/L11_5_R5_METRIC_AND_THRESHOLD.md`
5. `work/L11_5_SCHEMA_AUDIT_MATRIX.md`
6. `work/L11_5_ARM_IMPLEMENTATION_INVENTORY.md`
7. `work/L11_5_C1_C7_RECONCILIATION.md`
8. `work/L11_5_DECISION_REGISTER.md`
9. `work/L11_5_AMENDMENT_DRAFT.md` — **UNREGISTERED — PENDING OWNER DECISION**
10. `work/L11_5_READINESS_MATRIX.md`
11. `work/L11_5_COMPLETION_REPORT.md`
12. `work/L11_5_MANIFEST.md`

**No source, test, harness, protocol or preregistration file was modified.**

### H.2 Checks actually performed

| Check | Result |
|---|---|
| `git status --porcelain` at start | 83 entries (residue + 1 modified `CMakeLists.txt` from the L9 checkout) |
| Full-tree identity vs `effb56a` **before** branching | **6029/6029 match, 0 mismatch** |
| `git checkout -f -b` after identity proof | clean, **0 entries** |
| `git merge-base --is-ancestor` for 6 commits | all **YES** |
| `sha256sum` of protocol / spec / schema v0.1 / schema v0.2 / prereg / audit / harness / affinity test | all match their records |
| prereg hash == protocol file hash (recomputed) | **True** |
| `git ls-remote` for the 13 remote heads | matches expectations |
| `gh pr list --state all` | #1 MERGED, #2 `5f5a577`, #3 `49cc6ba` — unchanged |
| `grep -i majority` / `-i tie` over the protocol | confirms §4 has no rule |
| `git grep AMBIG11` / `CROSS21` over `stark/src/` | **no matches** |
| `CueMode` enum enumeration | **7 values** |
| CLI flag enumeration | **17 flags, none selects an evaluation cue** |
| `spec.eval_cue` assignment search | only the declaration at `:153` |
| `grep route_over_allocated_only` / `baseline_per_bank` in the harness | no matches (defaults apply) |
| exact-binomial computation for L11-C at n = 120 | **[C]** values in §C |
| JSON parse of the review artifact | **valid, 31 top-level keys** |

### H.3 Checks **not** performed, and why

| Not run | Why |
|---|---|
| Any compilation | no implementation is authorized; nothing to build |
| Any harness execution | would violate "no official L11 runs" |
| Any L11 arm or trial | the arms do not exist and are not authorized |
| Any runtime verification of D1/D2/D4/D5/D6/D7 | requires an instrumented binary |
| C6 battery (checks 1–8, 7′, 9–14) | requires an instrumented binary |
| Protocol §11 R-majority unit test | cannot run until `CROSS21`/`CROSS31` exist; **never executed** |
| `test_phase1_affinity` | **build failure** (`DWORD_PTR` undeclared) — UNEXECUTED, not passed |
| L11.3 Python validator re-run | not needed; its 32/32 result is recorded and is a property test of the validator, not of any writer |

### H.4 Deviations and judgement calls

1. **Did not commit to `arena/86da64f9-a-p-e-x`.** Its remote head is PR #3's head;
   committing would have modified PR #3. Deviation from the session branch, required
   by the mission's own prohibition, and consistent with every prior L11 milestone.
2. **Used `git checkout -f`**, but only **after** proving 6029/6029 tree identity. The
   `-f` discarded one working-tree modification (`stark/CMakeLists.txt`) that was
   **byte-identical to the target commit's version**, so nothing was lost.
3. **Declined to draft amendment item A-7.** It is a class-X experimental-design
   change; drafting a specific `o` distribution would prejudge an owner decision.
4. **Declined to invent a justification for the 0.50 threshold.** None exists in the
   record; the document says so and offers only what is computable.
5. **Did not edit the L11.2 audit** even though it contains a factual error
   (`AMBIG11`). It is frozen; the correction lives in this milestone's documents.

---

## I. Final gate

| Question | Answer |
|---|---|
| Is the protocol frozen? | **Yes — at v0.1 (`322078c8…`). It is frozen and it is ambiguous.** |
| Is the instrumentation implemented? | **No.** No `--emit-l11`, no separate writer, no v0.2 row capture. |
| Do all required arms exist? | **No.** 0 of 11 selectable; 3 cue constructions absent; 2 underspecified. |
| Is official evaluation authorized? | **No.** R1 unratified, R5 open, C1–C7 0/7, arms absent. |
| Did any official L11 run occur? | **No. Zero official arms. Zero official trials.** |
| Are the frozen artifacts unchanged? | **Yes** — protocol, preregistration, specification and schema v0.1 are byte-identical to their registered hashes. |
| Overall APEX progress | **≈ 57 %, unchanged.** |

**Official L11 evaluation not run. Zero official arms. Zero official trials. No model
or harness implementation changes.**

Progress is not increased: this milestone sharpened the *definition* of a measurement
for a capability that has never been demonstrated. Pinning down what a criterion means
is necessary work; it is not evidence of composition, and no capability claim follows
from it.

---

## Owner decisions needed next

1. **R5** — ratify `L11-C := MixAcc`, per cell, 0.50 unchanged (or choose another
   option). *Blocks every official run.*
2. **R4** — ratify two-named-metric reporting for A4.
3. **R4b** — pin the tie-break to the bank index.
4. **R4c** — add `Read_rule(A4)`.
5. **R5b** — adopt-with-contract or reject the pooled clause.
6. **F1 / F2** — how `MISLEAD` differs from `SHUFFLED`; the `o` distribution.
7. **R6** — re-record the v0.2 protocol and v0.2.1 schema hashes when adopted.
8. **R1** — ratify the criteria and thresholds; cannot be discharged by 1–7.

Six sentences close the protocol. Everything else is downstream of them.
