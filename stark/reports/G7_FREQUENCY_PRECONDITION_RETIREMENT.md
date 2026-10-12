# G7 — Frequency-Precondition Retirement (Owner Decision Record)

**Date:** 2026-10-08
**Type:** Governance / specification decision artifact. **Not** an implementation task.
**Decision:** The project owner **RETIRES** the 5% frequency-stability precondition as a
mandatory campaign-authorization gate for the frozen M0 G7 campaign.
**Predecessors:** [G7_OPTION1_OWNER_DECISION.md](G7_OPTION1_OWNER_DECISION.md) (Option 1 locked),
[g7-campaign-affinityfix/G7_METRIC_AUDIT_v1.md](g7-campaign-affinityfix/G7_METRIC_AUDIT_v1.md),
[g7-campaign-affinityfix/G7_DECISION_MEMO.md](g7-campaign-affinityfix/G7_DECISION_MEMO.md).
**Constraints honored:** frozen M0 specification, G7, ±15%/±20% tolerances, production
code, benchmark binaries, frozen 30, `evidence_manifest.json`, `records_sha256.txt`, G7
formulas/thresholds, grouping, benchmark timing, and the historical frequency
investigation are all unchanged; no G7 run occurred.

---

## 1. Preserved distinction (frozen metric vs. experimental precondition)

Recorded explicitly, and not to be conflated:

| | Frozen M0 G7 | 5% precondition |
|---|---|---|
| **What it is** | Same-configuration **benchmark-median reproducibility** | A `% Processor Performance` **frequency-stability** criterion |
| **Tolerances** | **±15%** (normal) / **±20%** (memory bandwidth) — **unchanged** | 5.0% `(max−min)/max·100` over exec-window `%perf` |
| **Source** | `design/V009_phase1_M0_specification.md` §G line 328 (rev 1.1) | `g7-campaign-affinityfix/` investigation (post-dates the frozen contract) |
| **Contractual standing** | **M0 acceptance criterion** | **Experimental campaign precondition** — introduced *after* the frozen M0 contract |

- **Frozen G7 = same-configuration benchmark-median reproducibility.** The ±15%/±20%
  rule remains **unchanged** and authoritative.
- **The 5% `% Processor Performance` criterion was an experimental campaign
  precondition introduced after the frozen M0 contract.** It is therefore **NOT an M0
  acceptance criterion** and **NOT a permanent prerequisite** for executing G7.

**The existing precondition documents are retained as historical evidence and are not
deleted or rewritten:**

- `reports/g7-campaign-affinityfix/gate_predeclaration.txt`
- `reports/g7-campaign-affinityfix/highres_predeclaration.txt`
- `reports/g7-campaign-affinityfix/highres_v5_predeclaration.txt`,
  `..._v6_predeclaration_addendum.txt`, `..._v7_predeclaration_addendum.txt`
- `reports/g7-campaign-affinityfix/power_control_gate.txt`
- `reports/g7-campaign-affinityfix/CPU_FREQUENCY_CAUSE_INVESTIGATION.md`

---

## 2. Owner decision

> **The project owner retires the 5% frequency-stability precondition as a mandatory
> authorization gate for the frozen M0 G7 campaign.**

This retirement:

- **does not alter §G** of the frozen M0 specification;
- **does not alter any frozen threshold** (±15% / ±20% remain in force);
- **does not alter production code** (`gates.cpp`, `aggregate.cpp`, benchmark
  binaries — untouched);
- **does not invalidate v7/v8** — their measurements stand as recorded;
- **does not claim that CPU frequency is stable**;
- **does not claim that frequency variation is irrelevant**;
- **only removes a later experimental precondition that was never part of the frozen
  M0 acceptance contract.**

Rationale (from the Option 1 decision and the metric audit): the precondition measures
a different quantity (per-exec clock ratio) than the frozen G7 metric (per-run
benchmark median) and can neither pass nor block M0 acceptance; retaining it as a *G7*
gate conflicted with the G7 scope fixed by Option 1. Retiring the **gate role** is not
the same as denying the **finding** (§3) or deleting the **evidence** (§1).

---

## 3. Diagnostic conclusion preserved

**v7/v8 established genuine within-execution CPU-frequency variation.** That finding is
**preserved, not erased**, and is explicitly **not** retired by this decision.

- v8: 6/16 B-side execs show 5.65–17.12% in-exec `%perf` spread; 5/16 exceed the
  historical 6.8974% value *inside a single ~7 ms exec*, on pin-verified, PDH-adequate
  instrumentation with 0 failures.
- This remains **useful diagnostic evidence** for future reproducibility analysis and
  stays available at
  `reports/g7-campaign-affinityfix/highres_v8_analysis.txt` and
  `reports/g7-campaign-affinityfix/highres_frequency_v8.json` (and the v7 artifacts).

This decision retires only the **mandatory-gate role** of the 5% criterion. The
underlying diagnostic conclusion and all source evidence remain intact and citable.

---

## 4. G7 authorization after retirement

> **The 5% experimental precondition no longer blocks execution of the frozen G7
> campaign.**

However:

> **This document does NOT authorize or execute G7 itself.**

- The **frozen G7 acceptance criteria remain fully binding** (§G: same-config grouping,
  per-record median, ±15%/±20%, ≥10 samples, all-pairs, ≥2 independent repeats).
- Therefore a **future G7 run can only PASS if the actual frozen §G criteria pass.**
- Retirement of the precondition does **not** pre-judge that outcome: the frozen median
  criterion currently **fails** on every available evidence set (historical nine
  16.13–48.04%; every fresh campaign 19–60%) for the frequency/power-state reason the
  investigation documents. A run remains a genuine test.

---

## 5. No code changes

This turn creates **only** this decision artifact. The following are **unchanged**:

`V009_phase1_M0_specification.md`, `gates.cpp`, `aggregate.cpp`, benchmark binaries,
frozen 30 records, `evidence_manifest.json`, `records_sha256.txt`, G7 formulas, G7
thresholds, grouping semantics, benchmark timing semantics.

---

## 6. Integrity (after writing this memo)

All checks run at the stated exit codes:

- Frozen 30: **30/30 SHA match** — `verify_freeze30_end.py` → `END-OF-TURN INTEGRITY: PASS`, **exit 0**.
- `evidence_manifest.json`: **unchanged** — within the same PASS check, **exit 0**.
- Production binaries: **5/5 unchanged** (SHA-256 vs `work/scripts/prod_bin_hashes_before.txt`) — **exit 0**.
- G7CAM records: **none created or modified** — 30 files, all mtimes `2026-10-06` — **exit 0**.
- Power scheme: **unchanged** — independent `cmd powercfg /getactivescheme` → `dfe97760-471c-4d01-bd06-b8b04c50ecd8 (Performance Mode)`, **exit 0**.
- **No G7 campaign was run.**

---

## 7. Final status

**G7 campaign authorization status (frozen contract):**

G7 CAMPAIGN NOW ELIGIBLE UNDER FROZEN M0 CONTRACT

**Execution status (unchanged by this decision):**

G7 CAMPAIGN NOT EXECUTED BY THIS DECISION

**M0 acceptance status:** M0 remains **FAIL**. M0 passes only when the actual frozen G7
evidence passes; no claim of M0 PASS is made or implied.
