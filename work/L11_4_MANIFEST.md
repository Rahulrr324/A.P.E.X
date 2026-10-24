# STARK-L11.4 — Deliverable Manifest

**Branch:** `validation/l11-4-protocol-semantics`
**Derived from:** `e8955dfd6d87fe9de84bfe1746901825270e182e` (verified L11.3 state,
verified local **and** remote)
**Milestone nature:** documentation only
**Recorded:** 2026-10-24

`work/L11_4_MANIFEST.md` (this file) is excluded from its own hash list.

---

## 1. Files added by this milestone (11)

| # | Path | sha256 | Lines |
|---|---|---|---|
| 1 | `work/L11_4_PROTOCOL_SEMANTICS_REVIEW.md` | `b2f5fe68aa873a220afbacca51c68cfb6bfb458eb08d5749ad773b22873496a9` | — |
| 2 | `work/L11_4_PROTOCOL_SEMANTICS_REVIEW.json` | `bc76465dd16006f0b03a2a6ec760b375d8faf41f921f4a4b00f1db0069279b5e` | — |
| 3 | `work/L11_4_R4_COMPETING_DEFINITIONS.md` | `3e6c0e0436d01982d9586b6541283fa9fb1a2113413a80e39210baf5e131e884` | — |
| 4 | `work/L11_4_R5_METRIC_CONTRACT.md` | `b857787ca02189c15bc9b38f59fd463f46a23e44bb8b1027cd6aa40e2779064e` | — |
| 5 | `work/L11_4_SCHEMA_V0_2_CONSISTENCY_REVIEW.md` | `8c6c3511b4e5a3aac8376984b7ec1f07fdd482d3fe2c90b7c55ba078b3490491` | — |
| 6 | `work/L11_4_C1_C7_MATRIX_UPDATE.md` | `1812aadd6f6f218fabf7e91a9a41c0970ce14b00d7925fe92a3de84d5081f658` | — |
| 7 | `work/L11_4_PROTOCOL_IMPACT_ASSESSMENT.md` | `cd93f005c043bb0a6d0492889cc4ac8c3ca54690a2f348e6e29e9d76c9faebe5` | — |
| 8 | `work/L11_4_PROPOSED_AMENDMENT.md` | `83db4e02763f5277ac311268dc8da3e1885498549864f51fa926f15d627ceedd` | — |
| 9 | `work/L11_4_OWNER_DECISION_RECORD.md` | `1ac26aeb0298f91a4c7c092fdfd7624cb338707660824bcc1a7f12bf1bf9ae8f` | — |
| 10 | `work/L11_4_COMPLETION_REPORT.md` | `91918fa6cf353cae3a6ce6558bb028af5efd184fecf04bcbd13b2c86e8fc6bf4` | — |
| 11 | `work/L11_4_MANIFEST.md` | (this file) | — |

Total 2,167 lines of new material across the 11 files.

---

## 2. Files verified **unchanged** (byte-identical, no modification)

| Path | sha256 | Expected |
|---|---|---|
| `stark/design/l11_1_protocol.md` | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` | == prereg record ✅ |
| `stark/design/l11_trial_schema.md` (v0.1) | `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917` | == prereg record ✅ |
| `stark/design/l11_trial_schema_v0_2.md` (proposal) | `1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8` | unchanged ✅ |
| `stark/design/l11_cross_signature_compositional_generalization.md` | `d9cd7dc4024e407317a083001aff40bd287cad0f301f777cdfc5082afc3ae542` | == prereg record ✅ |
| `work/L11_1_PREREGISTRATION.json` | `57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b` | unchanged ✅ |
| `stark/src/learning/l10_validation_harness.cpp` | `697b5f8a23eed90324ae600fd868628dc257cd8ca0b0a3b5f509a1f42df1ffc7` | unchanged ✅ |
| `stark/tests/test_phase1_affinity.cpp` | `9dab81ee7c0b825f96b3a4dc8d33859c8cb84814ec1efa9a65bc6a7250a76561` | unchanged ✅ |
| every L11.3 / L11.2 / L11.1 / L10 artifact | — | **not written to** |

---

## 3. Executed evidence

| Check | Result |
|---|---|
| `git status --porcelain` at start | **0 entries** (clean) |
| `git ls-remote` for `validation/l11-3-schema-v0-2` | `e8955df…` — matches local |
| prereg protocol hash == protocol file hash | **True** (`322078c8…`) |
| `git merge-base --is-ancestor ba1cfb3 77d261a` | **True** (readiness proposal precedes the freeze) |
| `git grep AMBIG11 -- stark/src/` | **no matches** |
| `git grep CROSS21 -- stark/src/` | **no matches** |
| `CueMode` enum members | 7 (`TRAIN, HOLDOUT, OFF, SHUFFLED, CROSS, PARTIAL, OFF_UNIFORM`) |
| `work/L11_4_PROTOCOL_SEMANTICS_REVIEW.json` parses | **yes**, 23 top-level keys |

Everything else in the milestone is **analysis of committed text and static source
reading**. No binary was built; no harness was run; no L11 trial was generated.

---

## 4. What a reviewer should check

```
git log --oneline -3                 # expect e8955df immediately below the L11.4 commit
git status --porcelain               # expect only the 11 new files
sha256sum work/L11_4_*.md work/L11_4_*.json    # compare against §1
sha256sum stark/design/l11_1_protocol.md work/L11_1_PREREGISTRATION.json   # compare §2
python3 -c "import json;json.load(open('work/L11_4_PROTOCOL_SEMANTICS_REVIEW.json'))"
git grep -c AMBIG11 -- stark/src/    # expect no output
```

A reviewer who finds a modified tracked file has found a defect in this milestone:
L11.4 adds documents and nothing else.

---

## 5. Status

**Official L11 evaluation not run. Zero official arms. Zero official trials. No
model or harness implementation changes.** R1 **NOT RATIFIED**. R4 and R5
analytically resolved, procedurally open. APEX progress **≈57 %**, unchanged.
