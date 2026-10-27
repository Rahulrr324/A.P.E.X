# STARK-L11.3 — Deliverable Manifest

**Branch:** `validation/l11-3-schema-v0-2`
**Base (verified audit commit):** `deac50f2bec14bf858ac3fb1fe38e28f9566c699`
**Milestone nature:** documentation only — no source, harness, or test file changed.
**Recorded:** 2026-10-24.

---

## 1. New files added by this milestone (12)

| # | Path | sha256 | Lines | Role |
|---|---|---|---|---|
| 1 | `stark/design/l11_trial_schema_v0_2.md` | `1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8` | 222 | proposed schema v0.2, 47 fields |
| 2 | `work/L11_3_SCHEMA_CHANGELOG.md` | `cadb1ece196e4f75e97ff85ad85912547b82f7caebe0a65f50227d1f5d8f53b0` | 170 | v0.1→v0.2 field diff; S1/S2/S3 closures; gaps G1/G2 |
| 3 | `work/L11_3_FIELD_PROVENANCE_AND_MISSINGNESS.md` | `30c9d3b249443ac94ab9ea8995c56c24172f1a60e7137c4692edc0e9a359c5e8` | 121 | per-field source + missingness table |
| 4 | `work/L11_3_ROUTING_RETRIEVAL_METRICS.md` | `6eb122bd5a848503487aebc6324c091586b942a28a03bef1bfdeaa2719d76265` | 212 | routing/retrieval metric definitions |
| 5 | `work/L11_3_C1_C7_VERIFICATION_MATRIX.md` | `b111170344f5752f4c1d99ac988c9c997576e650a7aea366b92169742c44c77b` | 194 | C1–C7 verbatim + verification procedure |
| 6 | `work/L11_3_NON_INTERFERENCE_AND_REGRESSION_PLAN.md` | `d1e896ec158b1a21b16577c0923ced17ebf5b6ac1fde01bc71c09250b1560e94` | 187 | T1–T20 test plan, all UNEXECUTED |
| 7 | `work/L11_3_PROTOCOL_IMPACT_ASSESSMENT.md` | `f5e603679cbf1b6767a6b3f5577cd40ef1f1d2851ed649e6159eccdf90f19193` | 139 | change classification; 0 criterion changes |
| 8 | `work/L11_3_IMPLEMENTATION_PATCH_SPEC.md` | `2a991c4ad62e5a1e4533cc6ef2e55a528739b07aef7d0d661405f22be810d84d` | 209 | patch **specification**, unapplied |
| 9 | `work/L11_3_AFFINITY_PORT_PLAN.md` | `50a19f87b4785026de49d4eb5f1d000c77b4ff333b99e2182c07567e0134d81e` | 180 | affinity port plan, unapplied |
| 10 | `work/L11_3_OWNER_DECISION_PROPOSED.md` | `4bd736188f2db6f2b80e41b9f49ed4a45f9d8c32526aae20cd843bbccfd2a1e0` | 127 | owner decisions R4–R7 |
| 11 | `work/L11_3_COMPLETION_REPORT.md` | `2499af1f392a2020708dad13d079d316c0d2f15d5a54ffe659f9d9adeaeb8291` | 245 | 12-part completion report |
| 12 | `work/l11_3_prototype/schema_v0_2_check.py` | `b7914d2f701e963441dcc4a30c5ec79c7a3875a12e2db1e6c91281cd073f9c41` | 465 | executable spec + validator |

`work/L11_3_MANIFEST.md` (this file) is excluded from its own hash list.

---

## 2. Frozen files — verified byte-identical, NOT modified

| Path | sha256 | Expected | Match |
|---|---|---|---|
| `stark/design/l11_1_protocol.md` | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` | prereg record | ✅ |
| `stark/design/l11_trial_schema.md` (v0.1) | `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917` | prereg record | ✅ |
| `work/L11_1_PREREGISTRATION.json` | `57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b` | `PENDING_OWNER_DECISION`, `official_evaluation_run=false` | ✅ |
| `stark/src/learning/l10_validation_harness.cpp` | `697b5f8a23eed90324ae600fd868628dc257cd8ca0b0a3b5f509a1f42df1ffc7` | unchanged | ✅ |
| `stark/tests/test_phase1_affinity.cpp` | `9dab81ee7c0b825f96b3a4dc8d33859c8cb84814ec1efa9a65bc6a7250a76561` | unchanged | ✅ |
| `work/L11_2_R3_AUTHORIZATION_AUDIT.md` | unchanged (C1–C7 source) | — | ✅ |

**`git status --porcelain` at end of milestone: exactly the 12 untracked files
above, and zero modified tracked files.**

---

## 3. Executed evidence

| Command | Result |
|---|---|
| `python3 work/l11_3_prototype/schema_v0_2_check.py --selftest` | **32/32 passed, exit 0** |
| `git diff --name-only deac50f -- stark/` (before commit) | empty |
| `sha256sum` of the six frozen files | all match §2 |

Everything else in the milestone is **specification, not execution**. No
instrumented binary was built; no L11 arm was implemented; no L11 trial was run.

---

## 4. Known residue and its disposition

The sandbox carried **53 untracked residue paths** that overlapped the `deac50f`
tree. Disposition: identity was proven first (6005/6005 blob hashes match), and
only then was the branch created with `--force`. Those paths are byte-identical to
the committed tree, so they introduce **no diff**. The lesson is recorded in the
completion report Part 10: never use `-f` before proving identity.

---

## 5. Verification instructions for a reviewer

```
git log --oneline -3                       # expect deac50f at the base
git status --porcelain                     # expect only the 12 new files
sha256sum stark/design/l11_trial_schema_v0_2.md \
          work/l11_3_prototype/schema_v0_2_check.py \
          work/L11_3_*.md                  # compare against §1
python3 work/l11_3_prototype/schema_v0_2_check.py --selftest   # expect 32/32
sha256sum stark/design/l11_1_protocol.md work/L11_1_PREREGISTRATION.json  # §2
```

A reviewer who finds any modified tracked file has found a defect in this
milestone: this milestone adds documents only.

---

## 6. Status

**Official L11 evaluation: NOT RUN. Zero official arms. Zero official trials.**
APEX progress **≈57 %**, unchanged. `test_phase1_affinity`: **UNEXECUTED**
(build failure). R1: **NOT RATIFIED**.
