# STARK-L11.2 R3 Audit — Evidence Manifest

Prepared 2026-10-24 on branch `validation/l11-2-r3-audit`, parent commit
`c547aab658cb1852b68bad2626e5a076346ec766`.

Format: `<64-hex sha256>` + two spaces + path relative to the repository root.

**Read-only audit.** No source, test, protocol, pre-registration, threshold or
frozen artifact was modified. No patch was applied. No L11 arm was run.

## Artifacts

5045c1576cd207e42cc58638163b3a1c74f73fcea1fbfadeef978e290fcf1015  work/L11_2_R3_AUTHORIZATION_AUDIT.md
511750e6a08521fcaa1f927c95cf2c1dab4a9174e4da6d6b799e018ba1f00a6e  work/L11_2_R3_AUTHORIZATION_AUDIT.json
ec4d8060b03b2e3d16c76b8a7eba1e032e42003c5f8cb22f483e343b7c718715  work/L11_2_OWNER_DECISION_PROPOSED.md
f80a7ad5b6844a9213fbf64414246183b931d9d9d4e02b98bd3fe71fa84cb896  work/L11_2_AUDIT_EVIDENCE/determinism_reverified.txt
4eb388307b2cbe08a23bbe9bbd1279c950f77275a4764b5d978a19e37e13ab39  work/L11_2_AUDIT_EVIDENCE/observer_nonperturbation_probe.cpp
b6d6f7a8a76bce15317698f45365f9bcb9c8cc4b2f94b31cf4f0a36e9cec1efb  work/L11_2_AUDIT_EVIDENCE/observer_nonperturbation_output.txt
830cfaf24313690e23ea31611ac3f9d0481194978f5d7a166dfe3d8f715e8690  work/L11_2_AUDIT_EVIDENCE/overhead_probe.cpp
df6a831ea500b8f04196142870ed37238b17807efcb5e6781a73d30ef9c61544  work/L11_2_AUDIT_EVIDENCE/overhead_output.txt
a67ba4f070f84379612f9518f03345d15f0d51ba6968175410b00db8889eae90  work/L11_2_AUDIT_EVIDENCE/verify_nondegenerate_reconstruction.py
8d8bac6560670643988523bd97b7bdbebdee5bac0b2b8640ec413731c808dc4b  work/L11_2_AUDIT_EVIDENCE/r7_non_degenerate_reconstruction.json

## Classification

- `work/L11_2_R3_AUTHORIZATION_AUDIT.md` — DESCRIPTIVE (read-only audit report)
- `work/L11_2_R3_AUTHORIZATION_AUDIT.json` — DESCRIPTIVE (machine-readable audit)
- `work/L11_2_OWNER_DECISION_PROPOSED.md` — PROPOSED (owner decision record, NOT APPROVED)
- `work/L11_2_AUDIT_EVIDENCE/determinism_reverified.txt` — EVIDENCE (independent 18/18 re-verification)
- `work/L11_2_AUDIT_EVIDENCE/observer_nonperturbation_probe.cpp` — PROTOTYPE_ONLY (observer probe source)
- `work/L11_2_AUDIT_EVIDENCE/observer_nonperturbation_output.txt` — EVIDENCE (observer probe output)
- `work/L11_2_AUDIT_EVIDENCE/overhead_probe.cpp` — PROTOTYPE_ONLY (timing probe source)
- `work/L11_2_AUDIT_EVIDENCE/overhead_output.txt` — EVIDENCE (timing measurements)
- `work/L11_2_AUDIT_EVIDENCE/verify_nondegenerate_reconstruction.py` — AUDIT TOOLING (verification script, not a repair)
- `work/L11_2_AUDIT_EVIDENCE/r7_non_degenerate_reconstruction.json` — EVIDENCE (non-degenerate reconstruction, 6/6 match)

## Explicit non-deliverables

- No `trials11_*.csv`: implementation remains unauthorized.
- No official L11 evidence: zero arms were run.
- No change under `stark/src/**`, `stark/tests/**`, `stark/design/**` or `work/l10_raw/**`.
- This manifest does not list itself.
