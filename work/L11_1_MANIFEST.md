# STARK-L11.1 — Artifact Manifest

Generated 2026-10-24 on branch `validation/l11-1-specification` (parent commit `ba1cfb3ce7ac3b179846d70abf66fba42d99bcf5`).

Format: `<64-hex sha256>` + two spaces + path relative to the repository root.

Every artifact below is **new** in L11.1. No pre-existing file was modified,
deleted or renamed. No official L11 evaluation was run; nothing here is a result.

## Artifacts

d9cd7dc4024e407317a083001aff40bd287cad0f301f777cdfc5082afc3ae542  stark/design/l11_cross_signature_compositional_generalization.md
322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32  stark/design/l11_1_protocol.md
a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917  stark/design/l11_trial_schema.md
04ca341429146b848e9086abc3d52aee240731a3b56070a586945489866f2fa7  work/L11_1_VALIDATION_PLAN.md
57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b  work/L11_1_PREREGISTRATION.json
1b30f5e344e41540361964c6a669daa5411c25374943f84c81ebd5648bdaea25  work/L11_1_SPECIFICATION_AND_INSTRUMENTATION.md
2efe8ab1909c99cd4ee91662f024cdc72982de67137ae00443d020e086c4ae8f  work/L11_1_SPECIFICATION_AND_INSTRUMENTATION.json
59837a45d3c8a36da5203dca214a44aba9f72e67ab6ceba3692ff823ccf039b8  work/l11_1_prototype/schema_check.py
8db838160f2e5633398bb3cc5489326203fe586fb77086b19ad0b74d81411000  work/l11_1_prototype/recompute_from_trials.py

## Classification

- `stark/design/l11_cross_signature_compositional_generalization.md` — DESIGN_ONLY (specification v0.1 DRAFT, not ratified)
- `stark/design/l11_1_protocol.md` — DESIGN_ONLY (protocol v0.1, text frozen, thresholds pending ratification)
- `stark/design/l11_trial_schema.md` — DESIGN_ONLY (trial schema v0.1)
- `work/L11_1_VALIDATION_PLAN.md` — DESIGN_ONLY (validation plan T1-T14)
- `work/L11_1_PREREGISTRATION.json` — DESCRIPTIVE (pre-registration record)
- `work/L11_1_SPECIFICATION_AND_INSTRUMENTATION.md` — DESCRIPTIVE (milestone report)
- `work/L11_1_SPECIFICATION_AND_INSTRUMENTATION.json` — DESCRIPTIVE (milestone report, machine-readable)
- `work/l11_1_prototype/schema_check.py` — PROTOTYPE_ONLY (executable schema + validator + coverage audit)
- `work/l11_1_prototype/recompute_from_trials.py` — PROTOTYPE_ONLY (metric reconstruction from trial rows)

## Explicit non-deliverables

- No evidence directory was created: there is no evidence, because no arm was run.
- No manifest covers `work/l10_raw/**`: those are frozen L10 artifacts, untouched.
- This manifest does not list itself (a file cannot contain its own hash).

