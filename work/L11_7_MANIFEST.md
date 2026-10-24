# STARK-L11.7 — Deliverable Manifest

**Branch:** `validation/l11-7-statistical-audit`
**Derived from:** `1f566893d89163171cf0cfd73199c33d21849798` (verified L11.6; local, remote and parent all verified)
**Milestone nature:** documentation only
**Recorded:** 2026-10-24

`work/L11_7_MANIFEST.md` (this file) is excluded from its own hash list.

---

## 1. Files added (8)

| # | Path | sha256 |
|---|---|---|
| 1 | `work/L11_7_STATISTICAL_AUDIT.md` | `a229ea8978fcc408362beff7473e559a729fdf486cfb47f2fb55a272c6223b5b` |
| 2 | `work/L11_7_L11C_ANALYSIS.md` | `8c1f5b0fd2d319d109d96235622c79db5e2e1d29a13b302c851ce569f8382fa9` |
| 3 | `work/L11_7_CANDIDATE_REDESIGN.md` | `e45893cfee4105f6666c64524f22bb6b4cd95edd3c3588ffc7314da95073e4e6` |
| 4 | `work/L11_7_OWNER_DECISION_REGISTER.md` | `8d76ae173cb7ef04681ebddea28e5a0dd63d7babe2f1ee6778587e68adf230e0` |
| 5 | `work/L11_7_COMPLETION_REPORT.md` | `4341983c8f5e8ac7fb0787c656effbcffafaf483f18169241bec7725d3d539df` |
| 6 | `work/L11_7_power/stat_audit.py` | `74d128b740a25ef8f48a43fcdabf94e1a57c986d7c539a51804078f02b29cbdf` |
| 7 | `work/L11_7_power/stat_audit_output.txt` | `7bf143cb9b82f47c5d89d7ae020c019a61f2f959708bba6181d591c26c107605` |
| 8 | `work/L11_7_MANIFEST.md` | (this file) |

1,418 lines across files 1–6.

**File 3 carries `CANDIDATE — NOT REGISTERED — NOT AUTHORIZED` at the top and must never
be cited as a protocol.** No threshold value in this milestone is changed or applied.

---

## 2. Frozen artifacts verified unchanged

| Path | sha256 | Record |
|---|---|---|
| `stark/design/l11_1_protocol.md` | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` | prereg — match |
| `stark/design/l11_cross_signature_compositional_generalization.md` | `d9cd7dc4024e407317a083001aff40bd287cad0f301f777cdfc5082afc3ae542` | prereg — match |
| `stark/design/l11_trial_schema.md` | `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917` | prereg — match |
| `stark/design/l11_trial_schema_v0_2.md` | `1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8` | L11.3/5 — match |
| `work/L11_1_PREREGISTRATION.json` | `57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b` | L11.1 — match |
| `work/L11_2_R3_AUTHORIZATION_AUDIT.md` | `5045c1576cd207e42cc58638163b3a1c74f73fcea1fbfadeef978e290fcf1015` | L11.2 — match |
| `stark/src/learning/l10_validation_harness.cpp` | `697b5f8a23eed90324ae600fd868628dc257cd8ca0b0a3b5f509a1f42df1ffc7` | L11.2 — match |
| `stark/tests/test_phase1_affinity.cpp` | `9dab81ee7c0b825f96b3a4dc8d33859c8cb84814ec1efa9a65bc6a7250a76561` | L11.3 — match |
| `work/L11_5_AMENDMENT_DRAFT.md` | `883312d9da9efba144257455ead9d26dcaa340baceed2c1f3ad74e89fed881bf` | L11.5 — match |
| `work/L11_5_AMENDMENT_READINESS_REVIEW.md` | `6179eca1e0f0fdd8ea7c59c41dbe0b6af2689367a6c33536129aebfaca1bd33e` | L11.5 — match |
| `work/L11_6_CANDIDATE_AMENDMENT.md` | `07a0cd4c5187327560e10b5b798d96d77b5b7077370f8c82ff938ec543d77511` | L11.6 — match |

**11 artifacts, 11 matches, 0 changes.** No file outside `work/L11_7_*` was created,
modified or deleted.

---

## 3. Checks executed

| Check | Result |
|---|---|
| Branch point | `git checkout -b validation/l11-7-statistical-audit 1f566893` — clean |
| Ancestry walk | `1f566893 → d09c6c4 → effb56a → e8955df → … → 5f5a577` — all ancestors |
| Frozen hashes | 11/11 match |
| Preregistration JSON | parses; `ratification = PENDING_OWNER_DECISION` |
| L11.6 deliverable hashes | 9 recomputed, all match the L11.6 manifest |
| Documentation-only scope | `git diff --stat 1f566893 -- stark/ tests/` → empty |
| PR heads | #2 `5f5a577`, #3 `49cc6ba` — unchanged |
| Statistical script | `python3 work/L11_7_power/stat_audit.py` → 200 lines of output, deterministic, stdlib only |
| Reproduced L11.1 triple | 0.9928 / 0.5761 / 0.0746 — exact |
| Reproduced L11.6 joint | 6.987e-03 — exact (conditional on independence) |

---

## 4. Checks **not** executed

| Check | Why |
|---|---|
| Any build / compile / link | no source changed |
| Any test, including the 26 inherited | out of scope; `test_phase1_affinity` cannot build |
| Any L11 arm, trial or diagnostic run | **prohibited** |
| Re-measurement of `Null(t)` | requires a run; L10.4 values cited as **[V]** for L10, **[U]** for L11 |
| Monte-Carlo simulation of the copula model | deterministic quadrature used instead; no simulation performed |

**Nothing in this milestone is runtime verification of STARK.**

---

## 5. Reviewer checklist

1. Confirm no frozen artifact hash changed and no threshold value was altered.
2. Confirm the candidate redesign is marked `NOT REGISTERED — NOT AUTHORIZED`.
3. Confirm the joint-power figure is presented as **conditional on independence**, with
   the Fréchet range [0, 0.5761], and not as a design fact.
4. Confirm L11-B's near-infeasibility rests on **measured** `Null(t)` values quoted from
   L10.4, and that the reproduction uncertainty is marked **[U]**.
5. Confirm the four new decisions S1–S4 are proposals, and that S4 (the claim itself) is
   flagged as a scientific-claim change.
6. Confirm no `AMBIG11` metric became a criterion, no `MISLEAD`/`SHUFFLED` distinction was
   invented, and no `o` distribution was selected.
7. Confirm F4 was re-verified against the implementation in this milestone.
8. Confirm C1–C7 remain 0/7 and the protocol is still unratified.
9. Confirm 0 arms and 0 trials, and that no result is labelled PASS or FAIL.

---

## 6. Status

**Protocol: not frozen, not scientifically complete, not ratified.
Implementation: not authorised. Official evaluation: not authorised.
Official arms: 0. Official trials: 0.
Frozen-artifact integrity: intact. APEX progress ≈ 57 %, unchanged.**

**Thirteen owner decisions are outstanding. Nothing in this package is approval.**
