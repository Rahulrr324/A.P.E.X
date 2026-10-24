# STARK-L11.3 — Completion Report

**Milestone:** L11.3 — prepare and validate L11 trial-schema v0.2 corrections
before instrumentation.
**Branch:** `validation/l11-3-schema-v0-2`, derived from verified audit commit
`deac50f2bec14bf858ac3fb1fe38e28f9566c699`.
**Nature of the work:** documentation only. **No source, harness, or affinity-test
file was modified.**

---

## Part 1 — Provenance and authorization verification

| Item | Verified value | Method |
|---|---|---|
| Repository | `https://github.com/Rahulrr324/A.P.E.X.git` | `git remote -v` |
| Audit commit (base) | `deac50f2bec14bf858ac3fb1fe38e28f9566c699` | `git rev-parse` (full SHA) |
| Its parent | `c547aab658cb1852b68bad2626e5a076346ec766` | `git rev-parse deac50f^` |
| Grandparent | `6a43974` (L11.1 specification) | `git merge-base --is-ancestor` → YES |
| Prior readiness | `c547aab` confirmed ancestor of `deac50f` | YES |
| Working tree at branch creation | clean, 0 status entries | `git status --porcelain` |
| Tree identity | **6005 / 6005** files of the `deac50f` tree byte-identical on disk, 0 mismatches | full-tree blob-hash comparison |
| Audit reproducibility | **14 / 14** residue blob comparisons reproduced against `c547aab` | `git cat-file` vs `sha256sum` |
| `stark/` delta `c547aab → deac50f` | empty | `git diff --stat` |
| PR #1 | MERGED (pre-existing) | `gh pr list` |
| PR #2 | OPEN, head `5f5a577…`, base `main` — **untouched** | `gh pr view` |
| PR #3 | OPEN, head `49cc6ba…`, base `arena/c90f7329` — **untouched** | `gh pr view` |
| Protocol | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` — unchanged | `sha256sum` |
| Schema v0.1 | `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917` — unchanged | `sha256sum` |
| Preregistration | `57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b`; status `PENDING_OWNER_DECISION`; `official_evaluation_run = false` | `sha256sum` + JSON parse |
| Harness | `697b5f8a…` — unchanged | `sha256sum` |
| Affinity test | `9dab81ee…` — unchanged | `sha256sum` |

**C1–C7 were read verbatim** from `work/L11_2_R3_AUTHORIZATION_AUDIT.md` §8 (the
"seven conditions" table). They were not reconstructed from memory and were not
inferred. All seven were located and were unambiguous. They are quoted verbatim in
`work/L11_3_C1_C7_VERIFICATION_MATRIX.md` §1.

**Authority recorded separately and honestly:**
- **R1 — NOT RATIFIED.** Nothing in this milestone ratifies it.
- **R2 — approved in principle** (behavior-preserving portability change);
  the affinity-test edit is **UNAPPLIED**, now that scope + validation procedure
  are documented in `work/L11_3_AFFINITY_PORT_PLAN.md`.
- **R3 — conditionally approved in principle** subject to C1–C7; the
  implementation remains **UNAPPLIED** and is specified but not written.

---

## Part 2 — Schema corrections (A)–(F)

| Req | Correction | Where | Status |
|---|---|---|---|
| **A** | `task_bank` / `rule_bank` / `selected_bank` are three separate fields; `routing_correct := selected == task_bank`; `rule_compliant := selected == rule_bank`. A misled model is `rule_compliant = 1, routing_correct = 0` — **never** "routing correct". Model behaviour and task-driver ground truth are distinct columns. | schema §3 fields 21/22/24/25/26; metrics §1–2 | done, validator-enforced |
| **B** | `Read` defined per category with `OBSERVED` / `NA:STRUCT_ZERO` / `NA:NO_DENOM` / `NA:NOT_ROUTED`. `MISLEAD` is structurally `NA`, never `0`. Aggregation and acceptance effects documented (`NA` propagates; never imputed; `L11-D` fails loudly instead of silently). | metrics §2.4, §3, §4 | done, validator-enforced |
| **C** | `presented_ids` + `intended_slot` + `selected_slot` + `queried` + `choice` reconstruct the retrieval path; `selected_slot` keeps the `-1` meaning as `NA:SINGLE_CANDIDATE` (never a structural zero, never a written `-1`). | schema fields 28–34 | done |
| **D** | Hidden-trial duplication: ordinary vs diagnostic separation **demonstrated from the actual control flow** — eight `dump_rows` call sites, six of which are diagnostics (`holdout`, `context_off`, `shuffled`, `partial_cue`, `context_off_uniform`, `cross_novel`), and `per_bank_off` passes `nullptr`. Existing diagnostics are **kept**, tagged `record_class = DIAGNOSTIC`. | `L11_3_IMPLEMENTATION_PATCH_SPEC.md` §1 | done |
| **E** | `w0` captured per trial, unconditionally under the flag (`if (l11_enabled \|\| measure \|\| maybe_opp)`), no stale reuse across pair trials; masses tied to trial, bank and pathway; `advantage` from a pre-call baseline at index 0. | patch spec §2.4 | done |
| **F** | Five explicit statuses: `observed`, `not applicable` (`NA`), `not measured` (`NM`), `missing unexpectedly` (`MISSING`), `invalid` (`INVALID`). No silent zero; no undocumented `-1.0`; `MISSING`/`INVALID` set `record_status = INVALID` and exclude the row from every metric while counting it. | schema §2, §4–6; provenance doc §2–3 | done |

The corrections are **executable**, not just prose:
`python3 work/l11_3_prototype/schema_v0_2_check.py --selftest` → **32/32 PASS**,
exit 0, with 20 negative controls.

---

## Part 3 — Protocol and preregistration impact classification

Full detail: `work/L11_3_PROTOCOL_IMPACT_ASSESSMENT.md`.

| Class | Count | Reaches a criterion? |
|---|---|---|
| Serialization-only | 8 | no |
| Instrumentation-only | 5 | no |
| Metric-definition | 4 | **none changes a criterion's arithmetic** |
| Acceptance-criterion | **0** | — |
| Experimental-design | **0** | — |

**Load-bearing result:** for `CROSS21`/`CROSS31`/`ORDERPERM`,
`rule_bank == task_bank` row-for-row, so `rule_compliant ≡ routing_correct`, so
`Comp`, `L11-A`, `L11-G` are **numerically unchanged**. Only the control
categories (`MISLEAD`, `SHUFFLED`, `AMBIG11`) change recorded semantics — and no
criterion references them.

**Blocked preregistered items** (defects that pre-exist this milestone, surfaced
by implementing the schema):
- **L11-C — BLOCKED**: the criterion does not name its metric (`Comp` vs `MixAcc`
  can straddle 0.50). → owner decision **R5**.
- **`Comp` for `AMBIG11` — BLOCKED for reporting**: protocol §6 defines it as the
  task bank and then as the lowest-index rule bank. → owner decision **R4**.

Mechanism used: **schema revision v0.1 → v0.2 only**. No versioned protocol
amendment is proposed. Consequence: the protocol and preregistration are
byte-unchanged, and R5 (if adopted) would require an amendment, which is why it is
not applied.

---

## Part 4 — Non-interference and regression test plan

`work/L11_3_NON_INTERFERENCE_AND_REGRESSION_PLAN.md` — 20 tests (T1–T20), each
with *what it proves* and *what it does not prove*, covering: hidden-trial
duplication, `w0` staleness, misrouting bank identity, structural-zero `Read`,
retrieval-path reconstruction, silent-zero statuses, routing/retrieval semantics,
and C5/C6/C7.

All existing checks are preserved (1–8) and the audit's additions are included
(7′, 9–14). Check **7′** is the one that converts a vacuous legacy hash match into
a real per-trial projection equality; check **9** (non-degenerate arm) is what
stops the whole battery from being a tautology; check **14** tests the *new*
artifact's determinism, which no existing check does.

**Honest status: T10 is EXECUTED (32/32). Every other test is UNEXECUTED** —
there is no instrumented binary to run them against.

---

## Part 5 — `test_phase1_affinity` port plan (unapplied)

`work/L11_3_AFFINITY_PORT_PLAN.md`.

- Test state today: **UNEXECUTED — build failure** (`DWORD_PTR has not been
  declared`, 6 errors at lines 138/140/150/160/172/186, recorded in
  `work/l10_raw/independent_validation_20261024/regression/test_phase1_affinity_build_failure.txt`).
- Diagnosis from source: `windows.h` is already `#ifdef`-guarded; the
  mask-enumeration block (lines 132–200) is not. One missing guard.
- Plan: keep lines 28–130 byte-identical; re-express the shift regression with
  `mask_t` = `DWORD_PTR` on Windows, `std::uint64_t` elsewhere; guard Case C
  (`GetProcessAffinityMask`) as Windows-only. **Zero assertions removed.**
- No fake Win32: no stub `DWORD_PTR`, no `#define` shim. On POSIX the
  honest-unsupported path is asserted as unsupported, not skipped.
- Regression battery named: `test_phase1_affinity`,
  `test_production_affinity_evidence`, `test_windows_affinity_diag` (Windows-only,
  reported as skipped, never passed), `test_phase1_records`,
  `test_phase1_reproducibility`, L10.1 determinism, `ctest -R phase1`.
- **Status: UNAPPLIED.** File sha256 `9dab81ee…` unchanged.

---

## Part 6 — Deliverables

| # | Deliverable | Path | sha256 |
|---|---|---|---|
| 1 | Schema v0.2 (47 fields) | `stark/design/l11_trial_schema_v0_2.md` | `1ce1525b…` |
| 2 | Change log v0.1→v0.2 | `work/L11_3_SCHEMA_CHANGELOG.md` | `cadb1ece…` |
| 3 | Field provenance + missingness | `work/L11_3_FIELD_PROVENANCE_AND_MISSINGNESS.md` | `30c9d3b2…` |
| 4 | Routing/retrieval metric definitions | `work/L11_3_ROUTING_RETRIEVAL_METRICS.md` | `6eb122bd…` |
| 5 | C1–C7 verification matrix | `work/L11_3_C1_C7_VERIFICATION_MATRIX.md` | `b1111703…` |
| 6 | Non-interference + regression plan | `work/L11_3_NON_INTERFERENCE_AND_REGRESSION_PLAN.md` | `d1e896ec…` |
| 7 | Protocol/prereg impact assessment | `work/L11_3_PROTOCOL_IMPACT_ASSESSMENT.md` | `f5e60367…` |
| 8 | Implementation patch **spec** (unapplied) | `work/L11_3_IMPLEMENTATION_PATCH_SPEC.md` | `2a991c4a…` |
| 9 | Affinity port plan (unapplied) | `work/L11_3_AFFINITY_PORT_PLAN.md` | `50a19f87…` |
| 10 | Owner decision record (R4–R7) | `work/L11_3_OWNER_DECISION_PROPOSED.md` | `4bd73618…` |
| 11 | Executable validator | `work/l11_3_prototype/schema_v0_2_check.py` | `b7914d2f…` |
| — | This report | `work/L11_3_COMPLETION_REPORT.md` | see manifest |
| — | Manifest | `work/L11_3_MANIFEST.md` | self-referential; excluded from its own hash list |

No patch file was produced. Deliverable 8 is a **specification** of a patch, not a
patch — because an applyable diff would invite applying it.

---

## Part 7 — Git state and safeguards

- Dedicated branch `validation/l11-3-schema-v0-2` from the **verified** audit
  commit `deac50f` (verified by full SHA, parent chain, and 6005/6005 tree
  identity before the branch was forced into place).
- **No PR created.** PRs #2 and #3 remain at `5f5a577…` and `49cc6ba…`.
- No history rewrite, no force-push, no reset/clean.
- No overwriting of: protocol v0.1, schema v0.1, preregistration, L10 evidence,
  any threshold.
- Push limited to this branch and only to the documents listed in Part 6.

---

## Part 8 — What was explicitly NOT done

- `--emit-l11` was **not implemented**; no code path was added.
- Model source, harness implementation, and affinity-test source: **unchanged**
  (hashes in Part 1).
- Frozen protocol, preregistration, thresholds: **unchanged**.
- No official L11 evaluation; **no arm implemented; no trial executed**.
- No metric was silently redefined: every change that could alter interpretation
  is escalated as an owner decision (R4, R5).
- No criterion was relaxed. `L11-C` was **blocked**, not reinterpreted.
- No capability claim is made.

---

## Part 9 — Status ledger (no green-by-assumption)

| Item | Status |
|---|---|
| Schema v0.2 | **PROPOSED**, not adopted |
| Validator | **32/32 PASS**, exit 0 (executed) |
| C4 (specification half) | **SATISFIED** |
| C4 (implementation half) | not started |
| C1, C2, C3, C5, C7 | **not verifiable** — no code exists; BLOCKED-ON-CODE |
| C6 | **BLOCKED-ON-RUN** |
| `test_phase1_affinity` | **UNEXECUTED** (build failure) — not passed |
| T1–T9, T11–T20 | **UNEXECUTED** |
| L11-A … L11-G | **not evaluated** |
| R1 | **NOT RATIFIED** |
| R4, R5, R6, R7 | open, awaiting owner |
| Official L11 evaluation | **NOT RUN — zero official arms, zero official trials** |

---

## Part 10 — Residual risks

1. **The `Comp` equivalence rests on a protocol property** (`rule_bank ==
   task_bank` on the three composition categories). It is verified at the schema
   level and asserted by the driver's construction, but it is **not yet verified
   on real rows** (T16 is unexecuted).
2. **The patch's "one modified line" claim is an estimate**, not a measurement.
3. **`AMBIG11` and L11-C remain undefined**, so even a fully instrumented build
   could not produce an official result today.
4. **The affinity test cannot currently run**, so its assertions are unproven on
   this platform.
5. **The dead-end lesson retained:** `git checkout -f` was safe only *after* tree
   identity was proven; it must never be used before that check.

---

## Part 11 — Recommended next gate

See `work/L11_3_OWNER_DECISION_PROPOSED.md` R7: resolve **R4** and **R5** first
(they define what will be measured), then the affinity port (R2, independent),
then the harness patch under C1–C7.

---

## Part 12 — Status statement

**Official L11 evaluation: NOT RUN. Zero official arms. Zero official trials.**

No new capability is claimed. The schema corrections change *how the experiment
would record what it does*; they do not change what APEX can do, and they have not
been exercised against a real instrumented run. C4 is satisfied only in
specification; C1–C3 and C5–C7 remain blocked on code and on a run. `L11-C` and
`AMBIG11`'s `Comp` are blocked on owner clarification of defects that predate this
milestone.

**APEX progress: ≈57 %, unchanged.** Specification and audit work is not a new
cognitive capability, and building a better instrument for a capability nobody has
yet demonstrated does not advance the capability itself.
