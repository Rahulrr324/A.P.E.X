# STARK-L11.6 — Deliverable Manifest

**Branch:** `validation/l11-6-owner-package`
**Derived from:** `d09c6c41872faeb1b26233c4e8050f649fbe352f` (verified L11.5 state,
verified local **and** remote, tree byte-identical to disk before branching)
**Milestone nature:** documentation only
**Recorded:** 2026-10-24

`work/L11_6_MANIFEST.md` (this file) is excluded from its own hash list.

---

## 1. Files added by this milestone (10)

| # | Path | sha256 |
|---|---|---|
| 1 | `work/L11_6_DECISION_REGISTER.md` | `3c0d56591ea0594fa15cbc604d24610b370f9093473aee5a59a3c06d08703bf9` |
| 2 | `work/L11_6_R5_L11C_DECISION.md` | `9f0dfd486b74f6c0051d1a2adea645499d2c54719a395b182be0469be0d8efa3` |
| 3 | `work/L11_6_R4_AMBIG11_DECISION.md` | `05f5b5a07aacbb72232f95b048f4ef173057133889f334c7167d5f3a952f071e` |
| 4 | `work/L11_6_F1_F2_SEMANTICS.md` | `2e30fb4e3e3f7dfe510120869e00786d5dff3717ce8a16daf6a3a37ec7fe0011` |
| 5 | `work/L11_6_ACCEPTANCE_MATRIX.md` | `0e031da1284c6fca87a505d3e6dbe739b09789bb6c18ba50ae35fe73c36e9cdd` |
| 6 | `work/L11_6_CANDIDATE_AMENDMENT.md` | `07a0cd4c5187327560e10b5b798d96d77b5b7077370f8c82ff938ec543d77511` |
| 7 | `work/L11_6_C1_C7_STATUS.md` | `3f8b68e1c9f36e6157edaff474965dce822ce3590e2fd366bed782b3b98e4a46` |
| 8 | `work/L11_6_OWNER_DECISION_PACKAGE.md` | `806890d8ca8441d133ab6418cbd91a0db4c8f182218ca484e63212cd7206f15f` |
| 9 | `work/L11_6_COMPLETION_REPORT.md` | `285c3ba9ef55542f6910140de025f768f84f77cd70cd82a5388f1384486f011f` |
| 10 | `work/L11_6_MANIFEST.md` | (this file) |

1,606 lines across files 1–9; 1,720 insertions across the ten files in the commit.

**File 6 is the candidate amendment. It carries the banner
`CANDIDATE — NOT REGISTERED — NOT AUTHORIZED` at the top, and its hash is not a
protocol hash. It must never be cited as a protocol.**

---

## 2. Files verified **unchanged** (byte-identical to their records)

| Path | sha256 | Record |
|---|---|---|
| `stark/design/l11_1_protocol.md` | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` | prereg `protocol_sha256` — **match** |
| `stark/design/l11_cross_signature_compositional_generalization.md` | `d9cd7dc4024e407317a083001aff40bd287cad0f301f777cdfc5082afc3ae542` | prereg `spec_sha256` — **match** |
| `stark/design/l11_trial_schema.md` (v0.1) | `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917` | prereg `schema_sha256` — **match** |
| `stark/design/l11_trial_schema_v0_2.md` | `1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8` | proposal; L11.5 record — **match** |
| `work/L11_1_PREREGISTRATION.json` | `57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b` | L11.1 record — **match** |
| `work/L11_2_R3_AUTHORIZATION_AUDIT.md` | `5045c1576cd207e42cc58638163b3a1c74f73fcea1fbfadeef978e290fcf1015` | L11.2 record — **match** |
| `stark/src/learning/l10_validation_harness.cpp` | `697b5f8a23eed90324ae600fd868628dc257cd8ca0b0a3b5f509a1f42df1ffc7` | L11.2 record — **match** |
| `stark/tests/test_phase1_affinity.cpp` | `9dab81ee7c0b825f96b3a4dc8d33859c8cb84814ec1efa9a65bc6a7250a76561` | L11.3 record — **match** |
| `work/L11_5_AMENDMENT_DRAFT.md` | `883312d9da9efba144257455ead9d26dcaa340baceed2c1f3ad74e89fed881bf` | L11.5 record — **match, not withdrawn** |
| `work/L11_5_AMENDMENT_READINESS_REVIEW.md` | `6179eca1e0f0fdd8ea7c59c41dbe0b6af2689367a6c33536129aebfaca1bd33e` | L11.5 record — **match** |

**11 frozen artifacts, 11 matches, 0 changes.** No file outside `work/L11_6_*` was
created, modified or deleted by this milestone.

---

## 3. Checks executed

| Check | Result |
|---|---|
| Branch point | `git checkout -f -b validation/l11-6-owner-package d09c6c4` — clean |
| Ancestry `d09c6c4 → effb56a → e8955df → deac50f → c547aab → 6a43974 → 77d261a` | all confirmed |
| Tree byte-identity, 6041 files | 6041 match, 0 mismatch, 0 missing |
| Frozen hashes recomputed | 11/11 match |
| Preregistration JSON parse | valid; `criteria_candidate.ratification = PENDING_OWNER_DECISION` |
| Documentation-only scope | `git diff --cached --stat d09c6c4 -- stark/ tests/` → **empty** |
| PR #1 / #2 / #3 heads | MERGED `c32071e` / OPEN `5f5a577` / OPEN `49cc6ba` — unchanged |
| Remote heads | `main 563395f`, `arena/86da64f9 49cc6ba`, `arena/c90f7329 5f5a577`, `validation/l11-5 d09c6c4` |
| Working tree after commit | 0 dirty entries |
| Commit contents | exactly the 10 `work/L11_6_*` files |

---

## 4. Checks **not** executed

| Check | Why |
|---|---|
| Any build | none required; no source changed |
| Any test | none required; no code changed |
| Any L11 trial | **prohibited** — no arms exist, no evaluation authorized |
| Instrumentation verification | no instrumented binary exists |
| Runtime verification of any claim | **none performed; none claimed** |

**Nothing in this milestone is runtime verification.** All findings are static
inspection and arithmetic on the documented `n`.

---

## 5. Reviewer checklist

1. Confirm the candidate amendment is marked `NOT REGISTERED — NOT AUTHORIZED` and that
   its hash is not recorded as a protocol hash anywhere.
2. Confirm three items — and only three — are classed as acceptance-criterion changes
   (A-5, A-8, A-9), and that A-10 is left undrafted.
3. Confirm no threshold value was altered; 0.50 and 0.75 appear only as quotations.
4. Confirm R4, R4b and R4c are answered separately, and R5b separately from R5.
5. Confirm `MixAcc`'s authorization status is stated as **never authorized**, and the
   0.50 threshold as **underived**.
6. Confirm F1 is reported as an unresolved design decision, with no distinction
   invented.
7. Confirm the acceptance matrix distinguishes frozen thresholds from proposed and
   unresolved values — and calls none of the criteria ratified.
8. Confirm C1–C7 is 0/7 satisfied.
9. Confirm the frozen artifacts listed in §2 are unchanged.
10. Confirm no PR was created or modified, and no branch other than
    `validation/l11-6-owner-package` was written.

---

## 6. Status

**Implementation: not authorized. Official evaluation: not authorized.
Official arms: 0. Official trials: 0. Overall APEX progress ≈ 57 %, unchanged.**

**Ten owner decisions are outstanding. Nothing in this package is approval.**
