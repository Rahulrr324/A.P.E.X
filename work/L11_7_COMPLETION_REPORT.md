# STARK-L11.7 — Completion Report: Statistical Validity Audit and Acceptance-Contract Redesign

**Branch:** `validation/l11-7-statistical-audit`
**Base:** `1f566893d89163171cf0cfd73199c33d21849798` (verified L11.6), parent
`d09c6c41872faeb1b26233c4e8050f649fbe352f`
**Nature:** documentation only · **Recorded:** 2026-10-24

---

## 1. Provenance verification

| Check | Result |
|---|---|
| `origin` | `https://github.com/Rahulrr324/A.P.E.X.git` **[V]** |
| L11.6 commit | `1f566893d89163171cf0cfd73199c33d21849798` — local, remote (`validation/l11-6-owner-package`), and PR-free **[V]** |
| L11.6 parent | `d09c6c41872faeb1b26233c4e8050f649fbe352f` **[V]** |
| Ancestry | `1f566893 → d09c6c4 → effb56a → e8955df → … → 5f5a577`, all confirmed ancestors **[V]** |
| Working tree at start | clean, 0 entries **[V]** |
| L11.6 deliverables | all 10 `work/L11_6_*` files present; 9 hashes recomputed and matched their L11.6 records **[V]** |
| PR #1 / #2 / #3 | MERGED `c32071e` / OPEN `5f5a577` / OPEN `49cc6ba` — **unchanged** **[V]** |
| Remote heads | `main 563395f`, `arena/86da64f9 49cc6ba`, `arena/c90f7329 5f5a577`, `validation/l11-5 d09c6c4`, `validation/l11-6 1f566893` **[V]** |

**No discrepancy.** The claimed commit, parent, ancestry, branch and files all verified
from Git, not from the completion report.

Frozen artifacts (recomputed this milestone, all byte-identical) **[V]**:

| Artifact | sha256 |
|---|---|
| `l11_1_protocol.md` | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` |
| `l11_cross_signature_…md` | `d9cd7dc4024e407317a083001aff40bd287cad0f301f777cdfc5082afc3ae542` |
| `l11_trial_schema.md` v0.1 | `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917` |
| `l11_trial_schema_v0_2.md` | `1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8` |
| `L11_1_PREREGISTRATION.json` | `57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b` |
| `L11_2_R3_AUTHORIZATION_AUDIT.md` | `5045c1576cd207e42cc58638163b3a1c74f73fcea1fbfadeef978e290fcf1015` |
| `l10_validation_harness.cpp` | `697b5f8a23eed90324ae600fd868628dc257cd8ca0b0a3b5f509a1f42df1ffc7` |
| `test_phase1_affinity.cpp` | `9dab81ee7c0b825f96b3a4dc8d33859c8cb84814ec1efa9a65bc6a7250a76561` |
| `L11_5_AMENDMENT_DRAFT.md` | `883312d9da9efba144257455ead9d26dcaa340baceed2c1f3ad74e89fed881bf` |
| `L11_6_CANDIDATE_AMENDMENT.md` | `07a0cd4c5187327560e10b5b798d96d77b5b7077370f8c82ff938ec543d77511` |

Preregistration parses; `criteria_candidate.ratification = PENDING_OWNER_DECISION` **[V]**.

---

## 2. What was reproduced, and what was not

| L11.6 claim | L11.7 verdict |
|---|---|
| L11-A per-cell power 0.5761 at 0.90 | **reproduced exactly** **[D]** |
| Joint power 0.00699 over 9 cells | **reproduced arithmetically** — but **[D, conditional on independence]**; Fréchet range [0, 0.5761]; 0.075–0.387 at copula ρ = 0.3–0.9 |
| L11-C 18-cell joint 1.3 × 10⁻⁵ at 0.50 | **reproduced** **[D]** |
| `MixAcc` never authorised | **confirmed** **[V]** |
| 0.50 threshold has no derivation | **confirmed** **[V]** |
| L11-B power `P(≥2 of 3) = 0.500` at 0.90 | **NOT REPRODUCED AS A DESIGN CHARACTERISTIC** — the arithmetic was right but it assumed `Null = 0.40`; the null is measured and runs 0.333–0.500. With measured values the joint is **9 × 10⁻⁸** **[D]** |
| `MixAcc = Comp·Read + (1−Comp)·Wrong` | **verified** **[D]** |

---

## 3. Headline findings

1. **L11-B is near-infeasible, not merely underpowered.** `Null(t)` is a measured
   quantity with expectation 4/9 (one forced cell answers perfectly), so "0.50 above the
   null" means `MixAcc` of 0.833–1.000, and on two measured cells it means **exactly
   1.000**. At a true `MixAcc` of 0.95 the criterion passes with probability 2.6 × 10⁻³.
2. **The contract's operating point is ~0.94–0.99, not 0.90.** A model at a true 0.94
   per cell is needed for 80 % joint power under independence.
3. **The joint-power figure depends entirely on an assumption the protocol never
   makes.** 0.00699 is one point in [0, 0.5761].
4. **No criterion has a stated test, α, power target or multiplicity rule.** No
   familywise error rate is defined anywhere, so none may be quoted.
5. **Pseudoreplication.** The trial is the reported unit but the model run is the
   experimental unit; independent replication is `n = 3` seeds.
6. **L11-G is nearly non-binding** (fails with probability < 10⁻⁴ at zero effect), while
   L11-B almost never passes. One gate cannot be failed; another cannot be passed.
7. **L11-C's 0.50 floor requires 10 % of the headroom** above a context-ignoring policy,
   and L10.3's published 0.5611 **would pass it**; only the failure's task structure
   saves it.
8. **L11-D conditions on a random denominator** that is itself the L11-A statistic, and
   is undefined when `Comp = 0`.

---

## 4. Files added

| # | Path | Contents |
|---|---|---|
| 1 | `work/L11_7_STATISTICAL_AUDIT.md` | A / joint / four cases / B / G / D / whole contract / candidate designs |
| 2 | `work/L11_7_L11C_ANALYSIS.md` | formula, 9-scenario diagnostic table, non-monotonicity, headroom, alternatives C0–C5 |
| 3 | `work/L11_7_CANDIDATE_REDESIGN.md` | per-criterion defined/undefined, candidate tests B1–B4 / G1–G3 / D0–D3, candidate matrix, migration table, readiness |
| 4 | `work/L11_7_OWNER_DECISION_REGISTER.md` | R1–R6, F1, F2, F4, R2, C1–C7 carried forward + **S1–S4 new** |
| 5 | `work/L11_7_COMPLETION_REPORT.md` | this file |
| 6 | `work/L11_7_MANIFEST.md` | hashes |
| 7 | `work/L11_7_power/stat_audit.py` | the reproducible calculation, stdlib only |
| 8 | `work/L11_7_power/stat_audit_output.txt` | its full transcript |

---

## 5. Change control

| Requirement | Result |
|---|---|
| Documentation only | **yes** — `git diff --cached --stat 1f566893 -- stark/ tests/` empty |
| No model / harness / instrumentation change | **yes** — harness `697b5f8a…` unchanged |
| No arms, no trials | **yes** — 0 arms, 0 trials |
| No threshold altered or applied | **yes** — 0.90 / 0.50 / 0.75 / −0.10 all quoted, none changed |
| Frozen artifacts byte-identical | **yes** — 10 recomputed, 10 matched |
| No PR created or modified | **yes** — PR #2 `5f5a577`, PR #3 `49cc6ba` |
| No merge / force-push / history rewrite | **yes** |
| No unverified test claims | **yes** — nothing labelled passing; C6 remains 0/13 executed |
| No APEX progress from paperwork | **yes** — ≈ 57 %, unchanged |

---

## 6. Tests and experiments **not** run

- No build, no compile, no link. **No test executed** (including the 26 inherited).
- **No L11 arm, no L11 trial, no diagnostic run.**
- No re-measurement of `Null(t)`; the L10.4 values are cited as **[V]** for L10, **[U]**
  for whether L11 reproduces them.
- No simulation study of the copula model beyond the deterministic quadrature reported.
- No run of the existing `test_phase1_affinity`, which still cannot build.
- Every power figure is arithmetic on the documented `n`; **none is a simulation of
  STARK**.

---

## 7. Final status

| Question | Answer |
|---|---|
| Protocol ratified? | **No** — `DRAFT_NOT_RATIFIED` / `PENDING_OWNER_DECISION` |
| Protocol scientifically complete? | **No** — three of seven criteria have no stated test; one is near-infeasible |
| Implementation authorised? | **No** — C1–C7 at 0/7 |
| Official evaluation authorised? | **No** |
| Official L11 arms / trials | **0 / 0** |
| Frozen-artifact integrity | **intact** — 10/10 byte-identical |
| APEX progress | **≈ 57 %, unchanged** |
