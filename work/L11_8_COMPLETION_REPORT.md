# STARK-L11.8 — Completion Report: Scientific Claim and Acceptance-Contract Redesign

**Branch:** `validation/l11-8-claim-redesign`
**Base:** `cf79201aa6db1b10cdaf6f92689a57f6b2702b11` (verified L11.7), parent
`1f566893d89163171cf0cfd73199c33d21849798`
**Nature:** documentation only · **Recorded:** 2026-10-24

---

## 1. Provenance verification

| Check | Result |
|---|---|
| L11.7 commit `cf79201a…` | local **and** remote (`validation/l11-7-statistical-audit`) **[V]** |
| Parent | `1f566893…` (L11.6) **[V]** |
| Ancestry | `cf79201a → 1f566893 → d09c6c4 → effb56a → e8955df → … → 5f5a577` — all ancestors **[V]** |
| Working tree at start | clean, 0 entries **[V]** |
| L11.7 deliverables | 8 files present; `stat_audit.py` re-run and its transcript **reproduces byte-for-byte** **[V]** |
| L11.7 calculations re-derived | 0.5761, 0.5761⁹ = 6.987 × 10⁻³, 0.9928, 0.5363, 0.1564, 4/9, 10.0 %, 82.0 % — all independently recomputed and matched **[D]** |
| PR #1 / #2 / #3 | MERGED `c32071e` / OPEN `5f5a577` / OPEN `49cc6ba` — **unchanged** **[V]** |

Frozen artifacts, recomputed this milestone — **11/11 byte-identical** **[V]**:
protocol `322078c8…` · specification `d9cd7dc4…` · schema v0.1 `a8edd674…` · schema v0.2
`1ce1525b…` · preregistration `57a8139d…` (`PENDING_OWNER_DECISION`) · L11.2 audit
`5045c157…` · harness `697b5f8a…` · affinity test `9dab81ee…` · L11.5 draft `883312d9…` ·
L11.6 candidate `07a0cd4c…` · L11.7 script `74d128b7…`.

---

## 2. New source-level facts established this milestone

Static inspection of `stark/src/learning/ContextConditionedMemory.cpp` and
`l10_validation_harness.cpp` **[V]**:

1. **Routing is cue-additive.** `bankScores(agent, cue)` computes
   `sc[k] = Σ_{f ∈ cue} w_router[f][k]`. **R-majority is emergent from additivity**, not from
   a majority detector. The claim must say so.
2. **Task-index routing is structurally excluded** in the learned path: `task_bank` never
   selects the bank; `CC_ORACLE` (which does) is a diagnostic mode only.
3. **No exploration at evaluation**: the ε-mixture is applied only when
   `learning_enabled`, so `Comp` is not capped by exploration.
4. **No criterion uses A10.** The zero-weight-router control exists and is unused — the
   contract contains **no contrast that isolates learning**.
5. **No criterion uses A3.** The additive model's ordering prediction (3:1 ≥ 2:1) is
   untested.

(4) and (5) are the largest scientific gaps found in this milestone.

---

## 3. Findings

| # | Finding | Evidence |
|---|---|---|
| 1 | **The frozen contract rejects a model with 0.99 accuracy 40 % of the time** (complete-pass probability 0.598); at 0.95 it passes 0.87 % of the time | **[D]** |
| 2 | The candidate contract passes a 0.99 model with probability 1.000, a 0.95 model 0.9995, and rejects every failure model at ≈ 0 | **[D]** |
| 3 | `NG` has **slope 0.25** in the measured null versus **1.00** for the frozen raw difference, and consumes exactly 75 % of headroom on every cell | **[D]** |
| 4 | At the protocol's own null (`Null = 0.4444`) the frozen rule demands `MixAcc = 0.9444`; at `Null = 0.50` it demands **1.0000** | **[D]** |
| 5 | `NG` is **noisier** than `MixAcc` (sd 0.0496 vs 0.0274 at the real null) — the price of removing the nuisance parameter | **[D]** |
| 6 | D3 is the most dependence-robust aggregation (spread 0.039 vs D0's 0.569) and dominates D4 on both claim strength and power | **[D]** |
| 7 | `MixAcc` and `NG` are both **raised** by wrong-bank leakage (0.9167 → 0.9600; NG 0.850 → 0.928), so neither can be the primary gate | **[D]** |
| 8 | Restricting L11-C to A3 loses **no** coverage: on A2 every mode it could catch is caught by A or D | **[D]** |
| 9 | The claim cannot be a population claim: 3 fixed tasks, 3 runs; the method-level sample size is **3** | **[V]** |

---

## 4. Files added

| # | Path | Contents |
|---|---|---|
| 1 | `work/L11_8_SCIENTIFIC_CLAIM.md` | Q1–Q6, unit of generalization, artefact discriminators, estimand, P1–P4 comparison |
| 2 | `work/L11_8_S1_AGGREGATION.md` | four aggregation rules, power, failure models, dependence, ESS, recommendation |
| 3 | `work/L11_8_S2_NORMALIZED_GAIN.md` | formula, behaviour at every required null value, sensitivity, exact pass probabilities, 0.75 evaluated, N0–N4 |
| 4 | `work/L11_8_S3_FAILURE_COVERAGE.md` | the historic failure, coverage matrix, X0–X2 scopes, non-monotonicity, missing-data policy |
| 5 | `work/L11_8_S4_PER_TASK_VS_POOLED.md` | both estimands, the L10.3 evidence, power trade, what pooled permits |
| 6 | `work/L11_8_ACCEPTANCE_MATRIX.md` | complete A–G matrix, thresholds-vs-tests, false-pass/false-fail table |
| 7 | `work/L11_8_CANDIDATE_AMENDMENT.md` | `L11-AC-v0.3-candidate`, **NOT REGISTERED — NOT AUTHORIZED**, AC-1…AC-9, migration and compatibility |
| 8 | `work/L11_8_OWNER_DECISION_REGISTER.md` | 17 decisions partitioned by claim / metric / implementation / registration |
| 9 | `work/L11_8_READINESS_REPORT.md` | 24-gate table, the two gaps arithmetic cannot close, ratification order |
| 10 | `work/L11_8_COMPLETION_REPORT.md` | this file |
| 11 | `work/L11_8_MANIFEST.md` | hashes |
| 12 | `work/L11_8_power/claim_audit.py` | reproducible arithmetic, stdlib only |
| 13 | `work/L11_8_power/claim_audit_output.txt` | full transcript |

---

## 5. Change control

| Requirement | Result |
|---|---|
| Documentation only | **yes** — `git diff --cached --stat cf79201a -- stark/ tests/` empty |
| No model / harness / instrumentation change | **yes** — harness `697b5f8a…` |
| No official arms or trials | **yes** — 0 / 0 |
| No frozen protocol or preregistration change | **yes** — 11/11 hashes match |
| No threshold applied to an official artifact | **yes** — every proposal marked |
| No PR created or modified | **yes** |
| No merge, force-push, history rewrite | **yes** |
| No unexecuted test claimed as passed | **yes** — C6 remains 0/13 executed |

---

## 6. Not executed

No build, no compile, no test, no arm, no trial, no diagnostic run, no simulation of STARK.
Every number is exact binomial arithmetic or a fixed quadrature on documented inputs.
`A10` and `A3` have **never been run**, which is why U1 and U2 carry no threshold.

---

## 7. Status

| Question | Answer |
|---|---|
| Scientific claim defined? | **proposed, not ratified** (S4 open) |
| Candidate contract internally coherent? | **yes, within its stated assumptions** |
| Protocol authorised? | **no** |
| Implementation authorised? | **no** — C1–C7 at 0/7 |
| Official evaluation authorised? | **no** |
| Official arms / trials | **0 / 0** |
| Frozen artifacts unchanged? | **yes** — 11/11 |
| APEX progress | **≈ 57 %, unchanged** |
