# STARK-L11.5 — Deliverable Manifest

**Branch:** `validation/l11-5-amendment-readiness`
**Derived from:** `effb56aa6cb861934eedbf38df2da054db309d5c` (verified L11.4 state,
verified local **and** remote)
**Milestone nature:** documentation only
**Recorded:** 2026-10-24

`work/L11_5_MANIFEST.md` (this file) is excluded from its own hash list.

---

## 1. Files added by this milestone (12)

| # | Path | sha256 |
|---|---|---|
| 1 | `work/L11_5_AMENDMENT_READINESS_REVIEW.md` | `6179eca1e0f0fdd8ea7c59c41dbe0b6af2689367a6c33536129aebfaca1bd33e` |
| 2 | `work/L11_5_AMENDMENT_READINESS_REVIEW.json` | `1c9a90135f505af1a66fd20ecace619080a7b7567ec0b9fb696e0415bd276f2b` |
| 3 | `work/L11_5_R4_DECISION_TABLE.md` | `1b199a0e16dbb2fe32f2e758b6753b13c24799820416f1e3f78eb0e8f2db09fc` |
| 4 | `work/L11_5_R5_METRIC_AND_THRESHOLD.md` | `f4197d8417256e6546d0d10fea5e59b175c45f0e486f2b165fa564b3ceea8b3a` |
| 5 | `work/L11_5_SCHEMA_AUDIT_MATRIX.md` | `920733a0ef802dcfd9b6abf8d110c3e85f676facbd2ad671239323353d5cac06` |
| 6 | `work/L11_5_ARM_IMPLEMENTATION_INVENTORY.md` | `750d9673bbfd9fa64cf61febdff29c432167d387b78fe5c743a142478c523e9b` |
| 7 | `work/L11_5_C1_C7_RECONCILIATION.md` | `e3c200c160e6b0a7595ed790ec7603f60cfe9e59432aba377a7771d053d2e0a7` |
| 8 | `work/L11_5_DECISION_REGISTER.md` | `1e01ead0ed8cd21ddc15758891c5643f630f6329eae7b23169205c152ae41aa2` |
| 9 | `work/L11_5_AMENDMENT_DRAFT.md` | `883312d9da9efba144257455ead9d26dcaa340baceed2c1f3ad74e89fed881bf` |
| 10 | `work/L11_5_READINESS_MATRIX.md` | `97ca82c2cdc01c88b96a16325973d1c0ef11075cd1c718b5754139ab3366d92f` |
| 11 | `work/L11_5_COMPLETION_REPORT.md` | `c47ff104c3052f98e71ea057d34ceabe897dff000bef57808baf83d4c66798ae` |
| 12 | `work/L11_5_MANIFEST.md` | (this file) |

2,574 lines of new material across the 12 files.

**File 9 is the amendment draft and carries the banner
`UNREGISTERED — PENDING OWNER DECISION` at the top. It must never be cited as a
protocol.**

---

## 2. Files verified **unchanged** (byte-identical to their records)

| Path | sha256 | Record |
|---|---|---|
| `stark/design/l11_1_protocol.md` | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` | == prereg ✅ |
| `stark/design/l11_trial_schema.md` (v0.1) | `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917` | == prereg ✅ |
| `stark/design/l11_cross_signature_compositional_generalization.md` | `d9cd7dc4024e407317a083001aff40bd287cad0f301f777cdfc5082afc3ae542` | == prereg ✅ |
| `work/L11_1_PREREGISTRATION.json` | `57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b` | unchanged ✅ |
| `stark/design/l11_trial_schema_v0_2.md` | `1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8` | unchanged ✅ |
| `work/L11_2_R3_AUTHORIZATION_AUDIT.md` | `5045c1576cd207e42cc58638163b3a1c74f73fcea1fbfadeef978e290fcf1015` | unchanged ✅ |
| `stark/src/learning/l10_validation_harness.cpp` | `697b5f8a23eed90324ae600fd868628dc257cd8ca0b0a3b5f509a1f42df1ffc7` | unchanged ✅ |
| `stark/tests/test_phase1_affinity.cpp` | `9dab81ee7c0b825f96b3a4dc8d33859c8cb84814ec1efa9a65bc6a7250a76561` | unchanged ✅ |
| every L11.4 / L11.3 / L11.2 / L11.1 / L10 artifact | — | **not written to** |

---

## 3. Executed checks

| Check | Result |
|---|---|
| Tree identity vs `effb56a` **before** branching | **6029 / 6029 match, 0 mismatch, 0 missing** |
| `git status --porcelain` after branching | **0 entries** |
| `git merge-base --is-ancestor` (6 commits) | all YES |
| prereg hash == protocol file hash | **True** |
| prereg spec hash == spec file hash | **True** |
| prereg schema hash == v0.1 file hash | **True** |
| `git grep AMBIG11` / `CROSS21` over `stark/src/` | **no matches** |
| `CueMode` enum | **7 values** |
| CLI flags enumerated | **17, none selects an evaluation cue** |
| `spec.eval_cue` assignments | **only the declaration at `:153`** |
| exact-binomial L11-C statistics at n = 120 | computed and recorded |
| JSON validity of the review artifact | **valid, 31 keys** |

## 4. Checks **not** executed

Compilation (no implementation authorized) · harness execution · any L11 arm or trial ·
runtime verification of D1/D2/D4/D5/D6/D7 · the C6 battery (13 checks) · the protocol
§11 R-majority unit test (never executed; cannot run until `CROSS21`/`CROSS31` exist) ·
`test_phase1_affinity` (**UNEXECUTED — build failure**, `DWORD_PTR` undeclared).

**No test result is claimed beyond those listed in §3.**

---

## 5. Reviewer checklist

```
git log --oneline -3                              # effb56a immediately below the L11.5 commit
git status --porcelain                            # only the 12 new files
sha256sum work/L11_5_*.md work/L11_5_*.json       # compare against §1
sha256sum stark/design/l11_1_protocol.md work/L11_1_PREREGISTRATION.json   # compare §2
python3 -c "import json;json.load(open('work/L11_5_AMENDMENT_READINESS_REVIEW.json'))"
git grep -c AMBIG11 -- stark/src/                 # expect no output
git branch -a --contains 49cc6ba                  # PR #3 head must be unreachable from this branch
```

A reviewer who finds a modified tracked file has found a defect in this milestone:
L11.5 adds documents and nothing else.

---

## 6. Status

**Official L11 evaluation not run. Zero official arms. Zero official trials. No model
or harness implementation changes.** R1 **NOT RATIFIED**. R4/R4b/R4c/R5/R5b/R6 open.
F1/F2/F3 unresolved. **The protocol is frozen at v0.1 and is ambiguous.** APEX
progress **≈ 57 %**, unchanged.
