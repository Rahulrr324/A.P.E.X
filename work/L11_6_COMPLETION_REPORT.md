# STARK-L11.6 — Completion Report: Owner Decision Package and Protocol Candidate

**Branch:** `validation/l11-6-owner-package`
**Base:** `d09c6c41872faeb1b26233c4e8050f649fbe352f` (verified L11.5), parent
`effb56aa6cb861934eedbf38df2da054db309d5c`
**Nature:** documentation only
**Recorded:** 2026-10-24

---

## 1. Provenance verification

The reported L11.5 state was **present and intact**, and this was established from the
repository rather than accepted.

The workspace was, once again, provisioned onto the **L9 checkout** (`5f5a577`, 95
status entries). So the L11.5 branch was fetched from origin first, and the tree was
proven against disk **before** any work started:

| Check | Result |
|---|---|
| `origin` URL | `https://github.com/Rahulrr324/A.P.E.X.git` |
| `git ls-remote` for L11.5 | `d09c6c41872faeb1b26233c4e8050f649fbe352f` — **exists remotely** |
| `d09c6c4` parent | `effb56aa6cb861934eedbf38df2da054db309d5c` |
| Ancestry chain | `d09c6c4 → effb56a → e8955df → deac50f → c547aab → 6a43974 → 77d261a` — **all confirmed ancestors** |
| Tree size | 6041 files |
| **Byte-identity of worktree vs `d09c6c4`** | **6041 / 6041 match, 0 mismatch, 0 missing** |
| `git checkout -f -b validation/l11-6-owner-package d09c6c4` | clean |
| Post-branch status | **0 entries** |

**No discrepancy.** Nothing was reconstructed or invented; nothing needed to be.

Remote heads at the end of the milestone: `main 563395f`, `arena/86da64f9 49cc6ba`
(PR #3), `arena/c90f7329 5f5a577` (PR #2), `validation/l11-5 … d09c6c4`. PR #1 MERGED
(`c32071e`), PR #2 OPEN, PR #3 OPEN — **none created, modified or merged**.

The session branch resolves remotely to PR #3's head. Committing there would advance a
PR under an explicit prohibition, so work is on `validation/l11-6-owner-package`, as in
every prior L11 milestone.

**Committed vs residue:** every file this milestone reads is tracked at `d09c6c4`. The
only untracked material is the ten `work/L11_6_*` files written here.

---

## 2. Deliverables

| # | File | Contents |
|---|---|---|
| 1 | `work/L11_6_DECISION_REGISTER.md` | R1, R4, R4b, R4c, R5, R5b, R6, F1, F2, **F4** — each with question, frozen wording, evidence, interpretations, recommendation, scientific and implementation consequence, criterion-change flag, exact approval sentence, dependents |
| 2 | `work/L11_6_R5_L11C_DECISION.md` | the five required R5 questions answered separately; the three candidate definitions; the authorization and restoration analysis; the threshold finding; per-reading behaviour table; scope and aggregation gaps |
| 3 | `work/L11_6_R4_AMBIG11_DECISION.md` | three bank identities re-verified; `Comp_task(A4)` / `Comp_rule(A4)` / `Read_rule(A4)`; four reasons to exclude A4 from primary composition; divergence table; R4b inputs and prohibitions; R4c status options |
| 4 | `work/L11_6_F1_F2_SEMANTICS.md` | F1 seven-field comparison and four options; F2 candidate distribution spec |
| 5 | `work/L11_6_ACCEPTANCE_MATRIX.md` | L11-A…G in one table with threshold provenance; statistical-character section; findings M1–M5 |
| 6 | `work/L11_6_CANDIDATE_AMENDMENT.md` | **CANDIDATE — UNREGISTERED**; A-1…A-10; before/after; exact text; compatibility table; criterion-change vs clarification split; preconditions |
| 7 | `work/L11_6_C1_C7_STATUS.md` | C1–C7 quoted verbatim with per-condition status |
| 8 | `work/L11_6_OWNER_DECISION_PACKAGE.md` | the executive package: ten decisions, ten sentences |
| 9 | `work/L11_6_COMPLETION_REPORT.md` | this file |
| 10 | `work/L11_6_MANIFEST.md` | hashes |

---

## 3. R5 — L11-C, answered directly

The mission required the threshold to be evaluated **without assuming it is correct**,
and required a plain statement if the justification is absent. It is absent.

| Required distinction | Answer |
|---|---|
| Was `MixAcc` ever authorized? | **No.** No L11 criterion has been ratified; the preregistration says `PENDING_OWNER_DECISION` |
| Restores an intended definition, or creates one? | **Restores in content, creates in authority.** The readiness proposal names `MixAcc` and the freeze marked only L11-G as changed — but that source was an unratified proposal. A proposal cannot ratify itself. **Operative classification: a new acceptance-criterion decision.** The record cannot be sharpened further, because no ratification act exists anywhere in it. |
| Is the threshold evidence-backed? | **No. The 0.50 has no derivation in the protocol, the specification, the preregistration, the audit, or the readiness review.** Its only recorded rationale is functional: it is the clause that would have caught L10.3's 0.0 cell. |
| Behaviour when routing succeeds and retrieval fails? | The `Comp` reading **passes** (`Comp = 1.00` → PASS) while the `MixAcc` reading **fails** (`0.00` → FAIL). The routing reading passes precisely the failure L11-C exists to catch. |
| Scope and aggregation fully specified? | **No.** The metric is unnamed, the numerator and denominator are unstated, the cell count is unstated (9 vs 18), the missing-cell policy is absent, and the statistical rule is absent. |

**What is genuinely defensible about 0.50** is narrower than the draft implies: at the
L10-measured retrieval floor of 0.4259, `P(pass) = 0.061` — it rejects the observed
broken state 94 % of the time. At exactly 0.50 the test is a coin flip (`P = 0.536`).
It is a **collapse detector**, not a capability threshold.

**New structure found:** `MixAcc = Comp·Read + (1−Comp)·WrongBankAcc`. On A2,
`MixAcc ≥ Comp·Read ≥ 0.81` follows from L11-A ∧ L11-D, and the criteria are
conjunctive — so L11-C's only decision-relevant content is its `CROSS31` clause.

**New multiplicity found:** read as 18 cells, a criterion that looks like a 0.50 floor
has joint power **1.3 × 10⁻⁵ at a true 0.50** and **0.107 at a true 0.55**. It is, in
effect, a ~0.55–0.60 requirement — and that is nowhere stated.

**R5b** is kept **separate** and not adopted. A pooled ≥ 0.75 across 360 trials has no
population definition, no aggregation formula beyond a raw pooled mean, no missing-cell
policy, and no justification for 0.75.

---

## 4. R4 / R4b / R4c — resolved as far as evidence allows

- **Three bank identities re-verified from the definitions:** `task_bank` (which task
  the cue came from), `rule_bank` (derived from `f / 4` via the allocation map), and the
  selected bank (the runtime choice). On `CROSS21`/`CROSS31`/`ORDERPERM` the first two
  coincide, **so no existing criterion number changes**. On `AMBIG11` they do not.
- **Proposed:** `Comp_task(A4) = 1[B_sel == B_task]`,
  `Comp_rule(A4) = 1[B_sel == B_rule]`, `Read_rule(A4) = mean(correct | rule_compliant)`
  — the last as a **diagnostic, not a criterion**.
- **A4 is excluded from primary composition** for four reasons: (i) it is a 1:1 tie with
  no majority, so a "correct" selection is only meaningful relative to a chosen
  convention; (ii) both readings score **50 % by construction** under any indifferent
  policy — the metric has no natural floor of 0; (iii) the design designates it
  "tie-break compliance only; carries no accuracy claim"; (iv) **no criterion references
  it**, so including it would silently widen a frozen metric.
- **R4b** states the rule (majority group → its bank; ties → lowest bank index), its
  inputs (the cue, `f/4`, and the **read-only** group→bank map), its effect (zero today
  under `task_bank = [0,1,2]`), and its prohibition (**never** read the evaluated task's
  index). No tie-break is inferred by implication.
- **Unresolved and stated as such:** the rule is **not written in §4** (verified by
  grep), `AMBIG11` has **never been implemented**, and no `AMBIG11` number has ever
  existed.

---

## 5. F1 — reported unresolved, not invented

`MISLEAD` ("2 features from `g(o)`") and `SHUFFLED` ("`TRAIN` pair of another task")
**denote the same cue set**: a `TRAIN` pair of another task *is* two features from that
task's group. Compared across all seven required fields — cue construction, intended
bank, rule-designated bank, permitted transformations, expected behaviour, control
interpretation, implemented mode — they are **indistinguishable today**, and the code
implements one mode for both.

Only their *wording* differs, and the difference is about which wrong answer the cue
forces — which is a property of `o`, not of the cue set.

**Reported as an unresolved design decision.** Four options are laid out; the
recommendation is to distinguish by `o`-selection (deterministic nearest wrong group vs
uniform other task), with merging as the fallback. **No distinction is asserted to
exist.**

**F2** is a candidate only: `o` uniform over the other two tasks, one draw per trial
from the arm's own cross-family stream, shared across cross-family arms. Not adopted.

**F4 (new).** The protocol's §5 stream table is wrong in three of seven rows —
documented `master + 9500` / `master + 9600` / `master + 9300`, implemented
`master + 9100 + t` / `master + 9400 + t` / `master + 5001 + t`. Verified by reading
both files. This is a precondition for L11-E and for making C6 check 14 meaningful.

---

## 6. R1 — the acceptance matrix

All seven thresholds are **verbatim in frozen artifacts**. Almost every definition
needed to compute them is not.

| | Criterion | Status of the specification |
|---|---|---|
| L11-A | `Comp(CROSS21) ≥ 0.90` × 3 tasks × 3 seeds = 9 cells | metric FZ, statistics only single-cell |
| L11-B | `MixAcc(A2,t) − Null(t) ≥ 0.50` on ≥ 2 of 3 tasks | **no test stated** |
| L11-C | "no cell below 0.50" | **metric unnamed, cell count unstated** |
| L11-D | `Read ≥ 0.90` | denominator random; exclusion rule inert |
| L11-E | `WrongBankAcc ≤ 0.10` | not computed by any code; depends on F4 |
| L11-F | no new test failures | depends on a test that cannot build |
| L11-G | `Comp(A2) − Comp(A9) ≥ −0.10` | **no test stated** |

| Finding | Statement |
|---|---|
| **M1** | Every criterion is a **conjunction**, and the documented statistics describe one cell. L11-A's per-cell power at a true 0.90 is 0.5761 as documented — but the **joint** power over 9 cells is **0.00699**. The "coin flip at 0.90" is not a coin flip. |
| **M2** | L11-C names no metric and no cell count. |
| **M3** | L11-B and L11-G specify **no test** at all — no paired/unpaired rule, no exact/approximate rule. |
| **M4** | L11-D's denominator is random, and the sole exclusion rule requires a state that cannot occur. |
| **M5** | L11-F depends on `test_phase1_affinity`, which cannot build (`DWORD_PTR` undeclared). |

**The contract is not ratified and is not ready to be ratified as written.**

---

## 7. The candidate amendment

`work/L11_6_CANDIDATE_AMENDMENT.md` carries `CANDIDATE — NOT REGISTERED — NOT
AUTHORIZED` at the top, states that its hashes are not protocol hashes, and requires a
new committed file with a post-edit hash if adopted.

Ten items: A-1 … A-9 drafted, **A-10 (F1/F2) deliberately left undrafted** — drafting a
distribution would prejudge a decision the owner has not made.

**Three items change acceptance criteria:**

- **A-5** — L11-C's metric becomes `MixAcc`, over 18 cells, with the missing-cell and
  reporting rules stated. The predicate changes **non-monotonically**.
- **A-8** — L11-B and L11-G acquire stated tests (independent proportions, exact
  intervals, lower bound). *New in this candidate.*
- **A-9** — L11-A/D must report joint power beside per-cell power. *New in this
  candidate.*

Everything else — the `Comp` restriction, the tie-break wording, the §4.1 rule, the
`Read_rule(A4)` diagnostic, the §11 field name, the §5 seed table — is clarification
with **zero numeric effect** on any existing criterion.

---

## 8. Change control

| Requirement | Status |
|---|---|
| Documentation only | **Yes** — `git diff --cached --stat d09c6c4 -- stark/ tests/` empty after staging |
| No model, harness or instrumentation change | **Yes** — harness `697b5f8a…` unchanged |
| No arms implemented | **Yes** — zero arms |
| No trials run | **Yes** — zero official trials |
| No threshold changed or applied | **Yes** — every candidate marked unregistered |
| No PR created or modified | **Yes** — PR #2 `5f5a577`, PR #3 `49cc6ba`, unchanged |
| No merge, force-push or history rewrite | **Yes** |
| No unverified test claims | **Yes** — nothing asserted as passing; C6 explicitly 0/13 executed |
| No APEX progress from paperwork | **Yes** — ≈ 57 %, **unchanged** |
| No approved status without owner authorization | **Yes** — every decision's approval field reads "none" |
| Frozen artifacts preserved | **Yes** — see the manifest |

**C1–C7: 0 of 7 satisfied** (5 blocked pending implementation, 1 blocked pending a
runtime test, 1 satisfied at specification level only, and that one carries an erratum).
**A documentation correction does not prove implementation readiness.**

---

## 9. What remains true and unwelcome

1. **The L11 protocol cannot be executed as written.** Three criteria are not
   computable from their own text.
2. **The L11-C threshold has no derivation.** It can be defended as a collapse detector
   and nothing more.
3. **`AMBIG11` is undesigned.** It has never been implemented, the rule it presumes is
   not in the protocol, and the two readings diverge 0/50/100 % by task.
4. **Two designed modes are textually distinct and operationally identical.**
5. **The documented power of L11-A is wrong by two orders of magnitude** when the
   criterion is read as written (per-cell 0.576 → joint 0.007).
6. **The protocol's stream table disagrees with the code in three of seven rows.**
7. **The preregistration is still `PENDING_OWNER_DECISION`.**

None of this is a reason to weaken a criterion. It is a reason to say that the
acceptance contract is unfinished.

---

## 10. Verification executed

- `git rev-parse`, `git ls-remote`, ancestry walk, 6041-file byte-identity check.
- Ten frozen hashes recomputed; all match their records.
- Preregistration JSON parsed; `ratification = PENDING_OWNER_DECISION`.
- `gh pr list`; remote head list (`main`, both arena branches, L11.5).
- Source reads: protocol §§3, 4, 5, 6, 7, 8, 9, 11; specification §§2.1, 3, 6; schema
  v0.2; the audit's C1–C7 verbatim; harness stream constants, `CueMode`, `eval_cue`,
  the cue switch, `evalTask`; `ContextConditionedMemory` clamp/allocation/margin.
- Exact binomial, Wilson and normal-approximation computations at the documented `n`.
- **Not executed:** any build, any test, any compile, any run. Nothing here is runtime
  verification, and nothing is labelled as such.

---

## 11. Decisions requiring explicit owner approval

1. **R5** — `L11-C := MixAcc` per cell, 18 cells, 0.50 unchanged. *Blocks every run.*
2. **R1** — ratify L11-A…G, **including A-8 (B/G tests), A-9 (joint power) and the
   conjunction disclosed**.
3. **R4** — two named A4 metrics.
4. **R4b** — tie-break = lowest **bank** index.
5. **R4c** — `Read_rule(A4)` is a diagnostic.
6. **R5b** — pooled 0.75: adopt-with-contract, or reject.
7. **F1** — `MISLEAD` vs `SHUFFLED`.
8. **F2** — the `o` distribution.
9. **F4** — correct protocol §5 to the implemented stream seeds.
10. **R6** — record the adopted hashes additively.

**Ten sentences are required and none of them exists in this repository.**

Implementation is **not authorized**. Official evaluation is **not authorized**.
Overall APEX progress: **≈ 57 %, unchanged**.
