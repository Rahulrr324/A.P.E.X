# STARK-L11.8 — Deliverable Manifest

**Branch:** `validation/l11-8-claim-redesign`
**Derived from:** `cf79201aa6db1b10cdaf6f92689a57f6b2702b11` (verified L11.7; local, remote and parent verified)
**Milestone nature:** documentation only
**Recorded:** 2026-10-24

`work/L11_8_MANIFEST.md` (this file) is excluded from its own hash list.

---

## 1. Files added (13)

| # | Path | sha256 |
|---|---|---|
| 1 | `work/L11_8_SCIENTIFIC_CLAIM.md` | `b1db5a5fc31c0b17fac34c8b79419186b41cb1a38697f2bd52b6aba4eba20b39` |
| 2 | `work/L11_8_S1_AGGREGATION.md` | `6586877feef2a2cdf8e70291cea8bc2c94cb9e7c8300f9db0e134cf4c7117e4d` |
| 3 | `work/L11_8_S2_NORMALIZED_GAIN.md` | `3176faa66e08fdc76b8ea493cb34d89a38dc08af81f68cfcbf6fbe31e9912b00` |
| 4 | `work/L11_8_S3_FAILURE_COVERAGE.md` | `74083f70ceb8c0fa0f23f8683dd17c9f226a3b9ae54fd2d41c94dddd1adbf40b` |
| 5 | `work/L11_8_S4_PER_TASK_VS_POOLED.md` | `7ba0cf6174f7c4df60f3ccfba626f8f047d6dd21d4b9cd525a4bf8549404b419` |
| 6 | `work/L11_8_ACCEPTANCE_MATRIX.md` | `549d44b929d4d3153f9030efca517ff7a7124dfd0cd110c96740c61bfeb76849` |
| 7 | `work/L11_8_CANDIDATE_AMENDMENT.md` | `133bc9897fc04b9de3a8383305b3e8b67e3942afe5d3d9a140bd475d2fb4cacc` |
| 8 | `work/L11_8_OWNER_DECISION_REGISTER.md` | `d7baa096c4460e5bff87a38d2d4d40ddd5b74c45642e00f5475a74c244c9b95b` |
| 9 | `work/L11_8_READINESS_REPORT.md` | `953afd239b226de8ffd947d68ae544adfcbc648070405e54d5dcfb3c0fa0d6de` |
| 10 | `work/L11_8_COMPLETION_REPORT.md` | `8a5208e043214b5ce10c1a32345ed12f1bf6b34eb5c04a6f4a960a2d514ad2c7` |
| 11 | `work/L11_8_power/claim_audit.py` | `7db00eaf6eb8a0193d232ca3f33e7b0a967df0f4e1187f31d13afce7bb01016c` |
| 12 | `work/L11_8_power/claim_audit_output.txt` | `2092b47f2c4cf8d66876cebc5c82a5d12039a1c50c31a3f0fe2261317e531206` |
| 13 | `work/L11_8_MANIFEST.md` | (this file) |

**File 7 carries `NOT REGISTERED — NOT AUTHORIZED` at the top and is not a protocol.**

---

## 2. Frozen artifacts verified unchanged (11)

| Path | sha256 | Record |
|---|---|---|
| `stark/design/l11_1_protocol.md` | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` | prereg — match |
| `stark/design/l11_cross_signature_compositional_generalization.md` | `d9cd7dc4024e407317a083001aff40bd287cad0f301f777cdfc5082afc3ae542` | prereg — match |
| `stark/design/l11_trial_schema.md` | `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917` | prereg — match |
| `stark/design/l11_trial_schema_v0_2.md` | `1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8` | match |
| `work/L11_1_PREREGISTRATION.json` | `57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b` | match |
| `work/L11_2_R3_AUTHORIZATION_AUDIT.md` | `5045c1576cd207e42cc58638163b3a1c74f73fcea1fbfadeef978e290fcf1015` | match |
| `stark/src/learning/l10_validation_harness.cpp` | `697b5f8a23eed90324ae600fd868628dc257cd8ca0b0a3b5f509a1f42df1ffc7` | match |
| `stark/tests/test_phase1_affinity.cpp` | `9dab81ee7c0b825f96b3a4dc8d33859c8cb84814ec1efa9a65bc6a7250a76561` | match |
| `work/L11_5_AMENDMENT_DRAFT.md` | `883312d9da9efba144257455ead9d26dcaa340baceed2c1f3ad74e89fed881bf` | match |
| `work/L11_6_CANDIDATE_AMENDMENT.md` | `07a0cd4c5187327560e10b5b798d96d77b5b7077370f8c82ff938ec543d77511` | match |
| `work/L11_7_power/stat_audit.py` | `74d128b740a25ef8f48a43fcdabf94e1a57c986d7c539a51804078f02b29cbdf` | match |

**11 artifacts, 11 matches, 0 changes.**

---

## 3. Checks executed

| Check | Result |
|---|---|
| Branch point | `git checkout -b validation/l11-8-claim-redesign cf79201a` — clean |
| Ancestry | all six earlier commits confirmed ancestors |
| Frozen hashes | 11/11 match |
| L11.7 script re-run | transcript **byte-identical** to the recorded output |
| L11.7 key figures re-derived independently | 0.5761 · 6.987e-03 · 0.9928 · 0.5363 · 1.349e-05 · 4/9 · 10.0 % · 82.0 % — all match |
| New script | `python3 work/L11_8_power/claim_audit.py` runs deterministically, stdlib only |
| Documentation-only scope | `git diff --stat cf79201a -- stark/ tests/` → empty |
| PR heads | #2 `5f5a577`, #3 `49cc6ba` — unchanged |

---

## 4. Checks **not** executed

No build, compile, link, test, arm, trial or diagnostic run. No simulation of STARK.
`A3` and `A10` have never been run; that is why U1/U2 carry no threshold. **Nothing in this
milestone is runtime verification.**

---

## 5. Reviewer checklist

1. Confirm the candidate amendment is marked `NOT REGISTERED — NOT AUTHORIZED`.
2. Confirm no frozen threshold was changed and all 11 hashes match.
3. Confirm the claim is proposed (S4 open) and that no population inference is asserted.
4. Confirm the AC-3 normalized gain is presented with its domain, its validity policy and
   its noise cost (sd 0.0496).
5. Confirm AC-4 keeps 0.50 only on A3 and labels it a collapse detector.
6. Confirm U1 and U2 are marked **UNRESOLVED with no proposed threshold**.
7. Confirm the scenario table's independence assumption is stated, not hidden.
8. Confirm 0 arms, 0 trials, C1–C7 at 0/7.

---

## 6. Status

**Claim: proposed. Contract: proposed. Protocol: not ratified. Implementation: not
authorised (C1–C7 0/7). Evaluation: not authorised. Arms/trials: 0/0. Frozen artifacts:
intact. APEX ≈ 57 %, unchanged.**

**Seventeen owner decisions outstanding. Nothing in this package is approval.**
