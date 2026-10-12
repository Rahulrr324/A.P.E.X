# G7 — Option 1 Owner Decision (Owner Decision Record)

**Date:** 2026-10-08
**Type:** Governance / specification decision artifact. **Not** an implementation task.
**Decision locked this turn:** **OPTION 1** — G7 certifies **same-configuration
benchmark-median reproducibility** only.
**Primary evidence:** frozen `stark/design/V009_phase1_M0_specification.md` (rev 1.1);
`stark/reports/g7-campaign-affinityfix/G7_METRIC_AUDIT_v1.md`;
`stark/reports/g7-campaign-affinityfix/G7_DECISION_MEMO.md`; the frequency
investigation documents cited in §3.
**Constraints honored:** §G unchanged; no G7 run; no change to frozen 30,
`evidence_manifest.json`, `records_sha256.txt`, G7 formulas/tolerances, grouping,
benchmark timing, production implementation, or v7/v8 evidence.

---

## 1. Owner Decision

**Option 1 is selected.** M0 G7 certifies:

> **same-configuration benchmark-median reproducibility.**

The frozen §G definition remains **authoritative**. The v7/v8 CPU-frequency
investigation is **diagnostic evidence** and is **not** part of the mathematical
definition of G7. G7 is **not** renamed or redefined.

**Exact scope of G7 (what it certifies):** that two or more **independent executions**
of the **same configuration** produce **benchmark medians** that agree pairwise within
±15% (±20% for memory-bandwidth benchmarks). It certifies **nothing about why** any
disagreement occurs, and **nothing about hardware CPU-frequency stability**.

---

## 2. What remains frozen

| Element | Status | Source |
|---|---|---|
| §G definition of G7 | **Frozen — authoritative, unchanged** | `design/V009_phase1_M0_specification.md` §G line 328 |
| ±15% (timing) / ±20% (memory bandwidth) tolerances | **Frozen — unchanged** | same, §G line 328 |
| Same-config grouping key (serialized `configuration` block) | **Frozen — unchanged** | §F lines 293–316; §G "same config" |
| ≥10 timed samples; ≥3 warmups (floor) | **Frozen — unchanged** | §B line 109 |
| Production implementation (`gates.cpp:748–895`, all-pairs `|Δmedian|/max·100`) | **Unchanged** | matches frozen definition (audit §2) |
| Benchmark timing semantics | **Unchanged** | — |

No threshold, formula, grouping rule, median definition, or timing semantic is altered
by this decision.

---

## 3. 5% Precondition Provenance

### 3.1 It is absent from the frozen contract

Searched the frozen/design documentation and the acceptance artifacts:

- `stark/design/V009_phase1_M0_specification.md` — **no** occurrence of "5%", no
  "`% Processor Performance`", no frequency/DVFS/turbo/power-state term, and no
  stability precondition. The only "stability" tokens are the B9 benchmark
  (`inference_stability`) and the `StabilityReport` struct — both unrelated to CPU
  frequency.
- `stark/reports/m0_acceptance_matrix.json` and `stark/reports/M0_FINAL_ACCEPTANCE.md`
  — G7 clause quotes only the **±15%/±20% median** criterion; **no** frequency gate.
  (The `spread_pct` values in `reports/v2.2/evidence_manifest.json:127–129` are the
  **±15%** gate's spreads over benchmark medians, 19–60% — a different quantity.)

The 5% frequency-stability precondition appears **only** inside the
CPU-frequency investigation directory (`stark/reports/g7-campaign-affinityfix/`),
which postdates the frozen specification.

### 3.2 Exact source files, sections, lines, and original wording

**(a) First proposal — `reports/g7-campaign-affinityfix/CPU_FREQUENCY_CAUSE_INVESTIGATION.md`**

§9 "Minimal standards-compliant control proposal **(DO NOT IMPLEMENT YET)**"
(line 211). Original wording of the gate (lines 228–232):

> **Verification gate before any campaign (mandatory):** re-run the
> `diag_frequency_evidence` diagnostic under the chosen control and require the
> exec-window observed %perf spread across repeated gap+warm execs to fall below
> a threshold fixed in advance (proposal: **≤5 %**, i.e. comfortably under the 15 %
> G7 tolerance's measurement share). Only then is a G7 campaign justified.

Its stated role (§10, lines 242–245): "(1) decide/apply a control from §9, (2) re-run
the diagnostic and pass the ≤5 % stability gate, (3) then a G7 campaign is justified."

**(b) Fixed predeclaration — `reports/g7-campaign-affinityfix/gate_predeclaration.txt`**

Line 1: "**STABILITY-GATE PREDECLARATION (fixed BEFORE running the controlled
diagnostic)**". Lines 5–6: "Validate the **session-scoped High-performance power-scheme
control** proposed in CPU_FREQUENCY_CAUSE_INVESTIGATION.md section 9. This is a
**conditioning / stability validation ONLY. No G7 campaign is run in this task.**"

The gate itself, lines 35–41:

> **STABILITY GATE (fixed now; will NOT be adjusted after seeing results)**
> Gate statistic (primary): `spread_pct = (max - min) / max * 100` over ALL
> exec-window `observed_pct_perf_cpu0` values of the controlled run. This is exactly
> the frozen G7 pairwise formula `abs(x-y)/max(abs(x),abs(y))*100` evaluated on the
> extreme pair (min, max). Gate: `spread_pct <= 5.0 => PASS`.

Authorization clause, lines 70–71: "**A new G7 campaign is authorized ONLY on
classification A.**"

**(c) Carried forward — `reports/g7-campaign-affinityfix/highres_predeclaration.txt`**

Lines 78–81: "(**Carried forward from gate_predeclaration.txt:** the G7 stability gate
is and remains exec-window PDH % Processor Performance spread `= (max-min)/max*100
<= 5.0%`, fixed before the 2026-10-06 controlled run. That gate is NOT changed.)"

Line 187: "The **G7 authorization gate** itself remains the pre-existing `<=5.0%`
exec-window rule; this task does not re-run or alter it."

**(d) Result — `reports/g7-campaign-affinityfix/power_control_gate.txt`**

Line 37: "PRIMARY `(max-min)/max*100 = 6.8974 %` `[GATE <= 5.0 %]`"; line 40:
"GATE RESULT : **FAIL**"; line 66: "CLASSIFICATION: **B**".

### 3.3 Was it part of frozen M0, or introduced later?

**Introduced later.** Chronology and provenance:

1. The frozen M0 specification (rev 1.1) defines G7 as median reproducibility and
   contains no frequency requirement.
2. The CPU-frequency investigation (`CPU_FREQUENCY_CAUSE_INVESTIGATION.md`, 2026-10-06)
   proposed a ≤5% stability check as an **unimplemented proposal** (§9 "DO NOT
   IMPLEMENT YET").
3. `gate_predeclaration.txt` fixed that proposal as a **predeclared, session-scoped
   stability gate**, explicitly labelled a "conditioning / stability validation ONLY"
   whose sole function is to decide whether it is "safe to run a G7 campaign."
4. `highres_predeclaration.txt` carried the same gate forward unchanged.
5. It never entered `design/V009_phase1_M0_specification.md`, the acceptance matrix, or
   the production implementation.

---

## 4. Status Classification

## EXPERIMENTAL CAMPAIGN PRECONDITION

Chosen from exactly one of the three permitted categories, on repository evidence:

- **Not MANDATORY M0 REQUIREMENT.** It is absent from the frozen contract and the
  acceptance matrix (§3.1); M0 acceptance is defined by §G–§L alone. It cannot be a
  mandatory M0 acceptance requirement that was "added to the M0 contract," because it
  was never added to the contract.
- **Not AMBIGUOUS.** Its origin, wording, purpose, and scope are explicit and
  internally consistent across four documents (§3.2): it is a predeclared
  **campaign-authorization** condition, not an acceptance criterion.
- **It is an EXPERIMENTAL CAMPAIGN PRECONDITION.** It was introduced by the frequency
  investigation, fixed in a predeclaration, and its declared role is to decide whether
  a G7 campaign may be run (`gate_predeclaration.txt:70–71`). It is a project-internal
  authorization gate, not part of frozen M0.

This classification is made from provenance, not from which outcome would make G7
easier: the same evidence that makes it a precondition also means it has **no** effect
on M0 acceptance.

### 4.1 Do NOT simply delete it

The 5% precondition is **not** retired by this memo. Retiring it is itself a
governance decision that requires **explicit owner sign-off**, because it changes the
project's stated campaign-authorization rule. It is left in place.

**Evidence supporting retirement (for the owner's consideration, not acted on):**

1. **Category mismatch.** It measures a different quantity (per-exec `% Processor
   Performance` clock ratio) from frozen G7 (per-run benchmark median); its own
   predeclaration concedes it merely reuses the G7 *formula shape* on a different
   quantity (`gate_predeclaration.txt:36–40`).
2. **Not an acceptance criterion.** It is absent from the frozen contract and the
   acceptance matrix (§3.1), so it can neither pass nor block M0 acceptance.
3. **Option 1 consistency.** Under the decision locked in §1, frequency stability is a
   **separate diagnostic**, not something G7 certifies — so retaining it as a *G7*
   authorization precondition conflicts with the G7 scope now fixed.
4. **The 6.8974% "failure" is itself largely a sampling-window artifact.** The audit
   (§4) and `highres_analysis.txt` establish that the exec-window metric is
   snapshot-bracketed, not exec-only; the residual is substantially between-exec
   boundary variation, while the actual within-exec frequency variation is the distinct
   v7/v8 finding.

**Counter-consideration (against unilateral retirement):** the investigation used the
5% check as a *conservative* safety gate to avoid running an expensive campaign under
unstable conditions; retiring it removes that conservatism and should be an explicit,
recorded choice.

---

## 5. Consequence

Under the selected status (EXPERIMENTAL CAMPAIGN PRECONDITION), the 5% precondition
governs **campaign authorization only** — never M0 acceptance.

- **M0 acceptance is unaffected by the 5% precondition.** Acceptance is governed solely
  by frozen §G–§L. M0 remains **FAIL** because **frozen G7 fails** on every available
  evidence set (historical nine 16.13–48.04%; every fresh campaign 19–60%), independent
  of the 5% gate.
- **G7 campaign authorization** is currently **blocked by the precondition as written**:
  the controlled run failed it (`6.8974% > 5.0%`, classification B), and
  `gate_predeclaration.txt:70–71` authorizes a campaign "ONLY on classification A."
  The threshold is **not** changed.

**Before a G7 campaign can be authorized, exactly one explicit owner decision is
required** — the precondition must be either **kept as-is** or **explicitly retired**;
it may not be silently ignored or deleted:

1. **Keep it (status quo):** G7 campaign stays **blocked** until the `%perf` gate passes
   at the unchanged 5.0% threshold. Nothing to change; G7 still does not run (and would
   still FAIL the frozen median criterion for the demonstrated environmental reason).
2. **Retire it (explicit sign-off required):** on retirement, campaign authorization
   falls back to the **frozen contract**, which contains **no** such precondition.
   Retiring it does **not** authorize a run by itself and does **not** change M0's
   status: a G7 campaign run today would still **FAIL** the frozen ±15%/±20% median
   criterion on the current machine, for the frequency/power-state reason the
   investigation documents. Retirement should be recorded with the rationale and the
   supporting evidence listed in §4.1.

**Either way, this memo does not authorize running G7, does not alter any acceptance
criterion, and does not change frozen §G.**

---

## 6. Integrity (after writing this memo)

- Frozen 30: **30/30 SHA match** (`verify_freeze30_end.py` → `END-OF-TURN INTEGRITY: PASS`, exit 0).
- `evidence_manifest.json`: **unchanged**.
- G7CAM records: **none created or modified** (30 files, mtimes 2026-10-06 only).
- Production binaries: **unchanged**.
- Power scheme: **unchanged / restored** (`DFE97760-471C-4D01-BD06-B8B04C50ECD8`).
- No G7 campaign was run; no acceptance criterion was changed.
