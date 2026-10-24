# STARK-L11.6 — Owner Decision Package

**Milestone:** STARK-L11.6 · **Branch:** `validation/l11-6-owner-package`
**Base:** `d09c6c41872faeb1b26233c4e8050f649fbe352f` (L11.5), working tree clean
**Nature:** documentation only · no source, harness, test, protocol or preregistration
change · no PR · no official run

> **No proposed decision in this package is authorized by appearing in it.**
> The register records recommendations. Authorization exists only in an owner's
> words — and none has been given.

---

## 0. What this package is

Nine owner decisions and one this milestone raised, each with evidence, competing
interpretations, a recommendation and the exact sentence that would ratify it. Plus a
candidate amendment that is **unregistered and has no official hash**.

**Three acceptance-criterion changes** are proposed (A-5 L11-C metric, A-8 L11-B/L11-G
tests, A-9 joint-power reporting). Everything else is clarification.

---

## 1. Provenance (verified, not assumed)

The workspace was re-provisioned onto the **L9 checkout** again (`5f5a577`, 95 status
entries). Rather than trust the reported state, the L11.5 head was fetched from origin
and its tree proven against disk **before** branching.

| Item | Value |
|---|---|
| Origin | `https://github.com/Rahulrr324/A.P.E.X.git` **[V]** |
| L11.5 commit | `d09c6c41872faeb1b26233c4e8050f649fbe352f`, parent `effb56aa6cb861934eedbf38df2da054db309d5c` **[V]** |
| Exists locally **and** remotely | **yes** (`git ls-remote` → `d09c6c4… refs/heads/validation/l11-5-amendment-readiness`) **[V]** |
| Ancestry | `d09c6c4 → effb56a → e8955df → deac50f → c547aab → 6a43974 → 77d261a`; all confirmed ancestors **[V]** |
| **Tree identity before branching** | **6041 / 6041** files of the `d09c6c4` tree byte-identical on disk, **0 mismatch, 0 missing** **[V]** |
| Working tree after branching | clean, **0 entries** **[V]** |
| Protocol | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` — **equals the prereg record** (recomputed) **[V]** |
| Specification | `d9cd7dc4024e407317a083001aff40bd287cad0f301f777cdfc5082afc3ae542` — equals prereg **[V]** |
| Schema v0.1 | `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917` — equals prereg **[V]** |
| Schema v0.2 proposal | `1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8` **[V]** |
| Preregistration | `57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b`; `ratification = PENDING_OWNER_DECISION` **[V]** |
| L11.5 amendment draft | `883312d9da9efba144257455ead9d26dcaa340baceed2c1f3ad74e89fed881bf` — **unchanged, not withdrawn** **[V]** |
| L11.2 audit | `5045c1576cd207e42cc58638163b3a1c74f73fcea1fbfadeef978e290fcf1015` **[V]** |
| Harness / affinity test | `697b5f8a…` / `9dab81ee…` — unchanged **[V]** |
| PR #1 / #2 / #3 | MERGED `c32071e` / OPEN `5f5a577` / OPEN `49cc6ba` — **none modified** **[V]** |
| Branch discrepancy | local `arena/86da64f9-a-p-e-x` = `5f5a577` (PR #2 head); **remote** = `49cc6ba` (**PR #3 head**) **[V]** |

**No discrepancy from the reported L11.5 state.** The reported commit, parent and
ancestry all exist exactly as stated.

**Branch handling:** the session's branch name resolves remotely to PR #3's head, so
committing to it would advance PR #3 — prohibited. Work is on
`validation/l11-6-owner-package`, consistent with every prior L11 milestone.

---

## 2. The ten decisions

Full detail: `work/L11_6_DECISION_REGISTER.md`.

| ID | Question | Recommendation **[P]** | Changes a criterion? | Blocks |
|---|---|---|---|---|
| **R1** | ratify L11-A…G? | ratify **with the conjunction acknowledged** | withholds/grants | any official run |
| **R4** | what does A4 report? | `Comp_task(A4)` + `Comp_rule(A4)`, named | no | unambiguity |
| **R4b** | tie-break convention | **lowest bank index** | no | A4 |
| **R4c** | `Read_rule(A4)` status | **diagnostic**, non-criterion | no | nothing |
| **R5** | L11-C metric | **`MixAcc`, per cell, 0.50 unchanged** | **YES** | **every run** |
| **R5b** | pooled ≥ 0.75? | **defer**; contract supplied if adopted | yes if adopted | nothing today |
| **R6** | hash recording | **additive**, retain v0.1 | no | provenance |
| **F1** | `MISLEAD` vs `SHUFFLED` | distinguish by `o`-selection, or merge | no | A6/A7 |
| **F2** | `o` distribution | **uniform over the other two** (candidate) | no | all cross-family arms |
| **F4** *(new)* | §5 stream seeds | **correct the table to the code** | no | L11-E |

**Every row: approval = none. No authorization exists.**

---

## 3. R5 — L11-C, and the plain answer about the threshold

Full analysis: `work/L11_6_R5_L11C_DECISION.md`.

| Question | Answer |
|---|---|
| Was `MixAcc` ever authorized? | **No.** No L11 criterion has ever been ratified; `ratification = PENDING_OWNER_DECISION` **[V]** |
| Restore or new criterion? | **Restoration in content, new decision in authority.** The readiness proposal names `MixAcc` and the freeze declared L11-C "unchanged … except where marked" (only L11-G was marked) — but the source was an unratified proposal. **Operative classification: a new acceptance-criterion decision.** The repository cannot sharpen this, because no ratification record exists. |
| Is the threshold justified? | **No — stated plainly: the 0.50 threshold has no derivation anywhere in the record.** Its only recorded rationale is functional ("the clause that would have caught L10.3's 0.0 cell"). |
| What *is* defensible about 0.50? | It rejects the **L10-measured floor of 0.4259** with probability 0.94 (P(pass \| floor) = 0.061) **[C]**. At exactly 0.50 the test is a coin flip (P = 0.536) **[C]**. It is a collapse detector, not a capability threshold. |
| Routing succeeds, retrieval fails? | `Comp` reading **passes** (`Comp=1.00 → PASS`) while `MixAcc` **fails** (`0.00 → FAIL`). The `Comp` reading passes exactly the failure L11-C exists to catch **[C]**. |
| Scope/aggregation specified? | **No.** The metric, the numerator/denominator, the cell count, the missing-cell policy and the statistical rule are all absent **[V]** |
| Is it monotone? | **No** — a cell with `Comp(A3)=0.30, WrongBankAcc=1.00` fails the routing reading and passes the `MixAcc` reading **[C]** |

**New structural result [C]:** on A2, `MixAcc ≥ Comp·Read ≥ 0.81` follows from L11-A ∧
L11-D, and the criteria are conjunctive — so **L11-C's only decision-relevant content
is its `CROSS31` clause**.

**New multiplicity result [C]:** if "every cell" means 18 cells (3 seeds × 3 tasks × 2
arms), a criterion that reads like a 0.50 floor has joint power **1.3 × 10⁻⁵ at a true
0.50** and **0.107 at a true 0.55**. It is in practice a ~0.55–0.60 requirement.

---

## 4. R4 / R4b / R4c — and the conjunction finding on R1

Full detail: `work/L11_6_R4_AMBIG11_DECISION.md` and §6 below.

- **`AMBIG11` cannot enter the primary composition metric** — it is a 1:1 tie with no
  majority, the design designates it "tie-break compliance only; carries no accuracy
  claim", no criterion references it, and the two readings diverge 0/50/100 % by task
  with no order-permuted A4 control.
- **`Comp_task(A4)` and `Comp_rule(A4)`** are specified in full (unit, numerator,
  denominator, missingness, status).
- **R4b** is stated with its inputs, its output, and its prohibition (never read the
  evaluated task's index; the allocation map *is* required).
- **R4c**: `Read_rule(A4)` is a **diagnostic**, not acceptance-relevant.

**Unresolved after those three:** F1, F2, and the fact that **the rule is not stated in
any ratified document** (`§4` contains no rule — verified by grep).

---

## 5. F1 / F2 — experimental semantics

Full detail: `work/L11_6_F1_F2_SEMANTICS.md`.

**F1.** `MISLEAD` ("2 features from `g(o)`") and `SHUFFLED` ("`TRAIN` pair of another
task") **denote the same cue set**, and the code implements one mode. Under all six of
the mission's comparison fields they are **indistinguishable today**; only the *wording*
of their causal questions differs. **Reported as an unresolved design decision — not
resolved by invention.** Recommended option if a distinction is wanted: differentiate by
`o`-selection (deterministic nearest wrong group vs uniform other task); fallback:
merge them and accept 10 arms.

**F2.** Candidate only: `o` uniform over the other two tasks, one draw per trial from
the arm's cross-family stream, **shared across all cross-family arms**, matching the
existing `CM_CROSS` procedure. Not adopted. **Blocks specification on F4** — the
protocol's `master + 9600` does not exist in the code.

---

## 6. The acceptance matrix — and the biggest new finding

Full matrix: `work/L11_6_ACCEPTANCE_MATRIX.md`.

All seven thresholds are **verbatim in frozen artifacts**. Almost every *definition*
needed to compute them is not:

| Finding | Evidence |
|---|---|
| **M1 — every criterion is a conjunction, and the documented statistics describe one cell** | L11-A "on every task and every seed" = 9 cells. Per-cell P(pass \| true 0.90) = 0.5761 (as documented); **joint = 0.00699**; at 0.95 joint = 0.937. **The "coin flip at 0.90" is not a coin flip.** **[C]** |
| **M2 — L11-C names no metric and states no cell count** | cell count 9 vs 18 changes joint power by orders of magnitude **[C]** |
| **M3 — L11-B and L11-G specify no test** | "≥ 0.50" and "≥ −0.10" are bare comparisons, with no paired/unpaired or exact/approximate rule **[V]** |
| **M4 — L11-D's denominator is random and its exclusion rule is inert** | `Read` conditions on routing; the sole §8(i) exclusion requires `selected_bank = -1`, which cannot occur **[V]** |
| **M5 — L11-F depends on a test that cannot build** | `test_phase1_affinity`, `DWORD_PTR` undeclared **[V]** |

**The acceptance contract is not ratified and is not ready to be ratified as written.**

---

## 7. Candidate amendment

`work/L11_6_CANDIDATE_AMENDMENT.md` — **CANDIDATE, UNREGISTERED, NO OFFICIAL HASH.**

- 10 items: A-1 … A-9 drafted; **A-10 (F1/F2) deliberately not drafted** (class X).
- Source sections, before/after, exact text, artifact compatibility and migration
  table, acceptance-criterion-vs-clarification split, and the pre-implementation
  conditions.
- **Three acceptance-criterion changes:** A-5 (L11-C metric), A-8 (L11-B/L11-G tests),
  A-9 (joint-power reporting).
- The frozen v0.1 protocol, preregistration and schema v0.1 are **byte-identical to
  their registered hashes** and this package does not touch them.

---

## 8. C1–C7 readiness

`work/L11_6_C1_C7_STATUS.md`: **0 satisfied**, 1 satisfied at specification level (C4,
with an erratum), 5 blocked pending implementation, 1 blocked pending a runtime test.
**A documentation correction does not prove implementation readiness.**

---

## 9. Final gate

| Question | Answer |
|---|---|
| Is implementation authorized? | **No.** R3 is conditionally approved in principle and **unapplied**; C1–C7 are 0/7 |
| Is official evaluation authorized? | **No.** R1 unratified, R5 open, arms absent |
| Did any official L11 trial occur? | **No. Zero official arms. Zero official trials.** |
| Are the frozen artifacts unchanged? | **Yes** — byte-identical to their registered hashes |
| Overall APEX progress | **≈ 57 %, unchanged** |

---

## 10. Decisions requiring explicit owner approval

1. **R5** — `L11-C := MixAcc` per cell (18 cells), 0.50 unchanged. *Blocks every run.*
2. **R1** — ratify L11-A…G **with A-8 (B/G tests), A-9 (joint power) and the conjunction disclosed**.
3. **R4** — two named A4 metrics.
4. **R4b** — tie-break = lowest **bank** index.
5. **R4c** — `Read_rule(A4)` is a diagnostic.
6. **R5b** — pooled 0.75: adopt-with-contract, or reject.
7. **F1** — `MISLEAD` vs `SHUFFLED`.
8. **F2** — the `o` distribution.
9. **F4** — correct protocol §5 to the implemented stream seeds.
10. **R6** — record the adopted hashes additively.

**Ten sentences. Nothing in this repository can supply them.**
