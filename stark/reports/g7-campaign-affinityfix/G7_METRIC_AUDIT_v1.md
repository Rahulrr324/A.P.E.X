# G7 Metric — Formal Specification + Implementation Audit

**Date:** 2026-10-08
**Scope:** Read-only audit of the *existing* G7 metric and its relationship to the
v7/v8 frequency evidence. No experiment, no code/threshold/formula/timing change,
no frozen-record or G7-artifact change, no G7 run.
**Verdict (summary):** production implementation **matches** the frozen text exactly;
the frozen metric **cannot** establish the property it is being relied upon to
establish → **NOT AUTHORIZABLE — SPECIFICATION GAP**.

---

## 1. Frozen specification reference

Frozen authority: `stark/design/V009_phase1_M0_specification.md` (rev 1.1).

| Item | Location |
|---|---|
| G7 gate text | **§G, line 328** |
| Benchmark methodology (§B) | **line 109** |
| Record rules (§F, append-only) | **lines 293–316** |
| G7 test-mechanics description | **line 407** |

**§G line 328, verbatim:**

> G7 | Full re-run of the same suite with same config: every benchmark median within
> ±15% of the recorded median (memory bandwidth ±20%). Determinism check per rev-1.1:
> CPU FP32 deterministic-mode records must be `outputs_bit_identical == true`; GPU
> records evaluated per declared mode (`deterministic_mode_available == false` ⇒
> bit-identity not required). Tolerance is defined here once — later phases may not
> loosen it silently.

**§B line 109 (methodology):** "fixed workload sizes, fixed seeds, ≥3 warmup
iterations, ≥10 timed iterations (configurable), CPU thread count pinned … report
mean/median/p95 plus raw samples."

**§F lines 293–316 (records):** the per-record `configuration` block is
`{benchmark_id, workload params, thread count, affinity, batch_size, sequence_length}`;
raw samples always stored; **records are append-only on disk**.

### 1.1 Answers to the specification questions

| Question | Answer (frozen text) |
|---|---|
| Exact definition of the 5% metric | **The frozen spec contains no 5% metric.** Frozen G7 tolerance is **±15%** (timing), **±20%** (memory bandwidth). The *5%* value exists only in the project's own predeclaration (§1.2). |
| Exact numerator / denominator | G7: `|median_i − median_j| / max(|median_i|, |median_j|) × 100` (production `symmetric_rel_diff_pct`, `gates.cpp:36–43`). |
| Compares executions/samples/medians/means? | **Per-run benchmark MEDIANS** (the stored median of the run's timed samples; GB/s for bandwidth benches). Not samples, not means. |
| Grouping key | **Serialized `configuration` block** (benchmark_id + workload params + thread count + affinity + batch_size + sequence_length) — i.e. "same config". |
| Required sample count | **≥10** timed samples per record (§B; enforced `gates.cpp:49,825`). |
| Warmup requirement | **≥3** (floor, configurable; §B). Recorded in the record, **not re-checked by the gate**. |
| Tolerance | **15%** timing / **20%** B3+B5 bandwidth. Fixed once ("later phases may not loosen it"). |
| CPU-frequency stability explicitly required? | **NO.** No frequency, clock, DVFS, turbo, or power-state term appears anywhere in §B/§F/§G. |
| Within-execution frequency variation mentioned? | **NO.** The phrase/concept does not appear in the frozen spec. It appears first in the project's diagnostic predeclarations. |
| Does G7 represent benchmark reproducibility, hardware-frequency stability, or both? | **Benchmark reproducibility only** — reproducibility of the *measured benchmark median* between independent same-config runs. |

**1.2 The "5% metric" is a project predeclaration, not the frozen spec.**
`stark/reports/g7-campaign-affinityfix/gate_predeclaration.txt`:
`spread_pct = (max−min)/max·100` over **all exec-window `observed_pct_perf_cpu0`
values** of the controlled run, gate `≤ 5.0%`. It states it is "exactly the frozen
G7 pairwise formula … evaluated on the extreme pair (min,max)" — i.e. the project
reused the G7 **formula shape** on a **different quantity** (PDH `% Processor
Performance`, a hardware clock ratio). Its purpose (`CPU_FREQUENCY_CAUSE_INVESTIGATION.md`
§9) is to confirm the machine's **frequency is stable enough** before authorizing a
G7 campaign. The predeclaration also fixes authorization: "A new G7 campaign is
authorized ONLY on classification A." This 5% gate is **not described by, required
by, or derived from any frozen clause.**

---

## 2. Production implementation reference

Trace (all read-only):

| Stage | Production code |
|---|---|
| Record loading | `src/phase1/aggregate.cpp:44–70` — `RecordStore::loadAll()` globs `*.json`; `parse_ok` + `record.validate()`; malformed/invalid records are excluded from gate input (and fail `--strict`). |
| Grouping | `src/phase1/gates.cpp:787–835` — key `r.configuration.dump()`; admitted only if `status == PASSED` **and** `kind ∈ {benchmark, baseline}` **and** `benchmark_id_of(r)` non-empty (`gates.cpp:179–185`). |
| Statistic | Stored `r.statistics.median`, **independently re-verified** against `recompute_median(st.samples)` within `G7_MEDIAN_TOLERANCE_PCT = 0.001%` (`gates.cpp:25, 75–97, 812`). Median convention: linear interpolation, `pos = 0.5·(n−1)` (`gates.cpp:57–66`). |
| Pairwise comparison | `gates.cpp:864–878` — **all-pairs**, `symmetric_rel_diff_pct(median_i, median_j)`, `allowed = bandwidth ? 20.0 : 15.0` (bandwidth = `bench == "B3" \|\| bench == "B5"`). |
| G7 decision | PASS iff every same-config group has **≥2 independent records** (distinct `record_id`, dedup `gates.cpp:840–846`) with valid medians, and **every pair** is within tolerance; a single over-tolerance pair, a sub-10-sample record, a non-finite median, or "no group" all force FAIL (`gates.cpp:856, 868–878, 885`). PASS is only ever assigned false; failures accumulate. |
| Acceptance aggregator | `src/phase1/aggregate.cpp:89,100` — `evaluate_gates(records)` → `all_gates_pass(gates)`; **exit 1** when any gate fails. |

### 2.1 Match to the frozen specification

**EXACT on every element that the campaign investigation touches:**

| Frozen element | Production | Match |
|---|---|---|
| "same config" | serialized `configuration` block | ✓ |
| "every benchmark median" | per-record stored median (verified vs raw samples) | ✓ |
| "within ±15%" | `allowed = 15.0` (all-pairs) | ✓ |
| "memory bandwidth ±20%" | `allowed = 20.0` for B3/B5 | ✓ |
| "≥10 timed iterations" | `samples.size() < 10` → FAIL | ✓ |
| "warmup ≥3" | recorded in `configuration`; not gate-checked | ✓ (floor) |
| append-only records | `RecordStore` (§F) | ✓ |

Minor scope note (not a mismatch): §G G7 bundles the **determinism** sub-clause
(`outputs_bit_identical`). The numeric G7 block in `gates.cpp` implements the
**median-reproducibility** clause only; the determinism triple is serialized per
record (`ExperimentRecord.cpp:437–446`) and exercised by `test_phase1_reproducibility.cpp`
(frozen §K/test table, line 407). This is a separation of mechanization, not a
contradiction of the median criterion this audit concerns.

**No implementation defect violating the gate's own contract was found.**

---

## 3. Relationship to the v7/v8 evidence

Evaluating the four pre-declared possibilities against the exact frozen wording and
the production implementation:

**A. Does the observed intra-execution frequency variation directly violate a frozen
G7 requirement? — NO.** Frozen G7 has no frequency requirement and no
within-execution requirement. It compares *per-run medians between independent runs*.
Genuine within-exec frequency variation is invisible to that comparison unless it
moves a *median across runs* — and even then G7 attributes nothing to frequency.
There is no frozen clause for the variation to violate.

**B. Is the variation real but is the frozen G7 metric intentionally measuring a
different property? — YES.** v7/v8 consistently find *real* within-exec variation
(v8: 6/16 B execs with 5.65–17.12% in-exec spread; 5/16 exceeding the 6.8974% value
*inside a single ~7 ms exec*; counter adequate, pins verified, 0 PDH failures). The
frozen G7 metric measures **benchmark-median reproducibility** — a different property
from *hardware-frequency stability*. Both statements can be true simultaneously; they
are not in tension.

**C. Is the frozen metric being used as a proxy for a property it cannot establish?
— YES, and this is the operative finding.** The project's authorization chain rests
on a **≤5% exec-window `%perf` stability gate** whose formula is the frozen G7
formula. The property that gate is required to establish is **CPU-frequency
stability**, but the frozen G7 metric/definition measures **benchmark-median
reproducibility** and contains no frequency clause. A metric that observes only the
*net* reproducibility of a timing statistic cannot establish *which* environmental
factor produced that reproducibility: a G7 PASS is compatible with substantial
within-exec frequency variation (any clock-insensitive workload, or one whose
variation cancels in the median, passes), so **G7 (and its 5%-on-`%perf` derivative)
cannot establish frequency stability**; conversely G7 FAIL does not, by itself,
identify frequency as the cause. The requirement being enforced (stable frequency)
is therefore being routed through a metric that cannot establish it.

**D. Does the evidence create an unresolved specification conflict? — NO (textually).**
§G/§B/§F are mutually consistent; the frozen median gate is well-defined. The
conflict is not *within* the frozen text but **between the frozen metric and the
project-added 5% precondition** — a scope/label conflation, resolved by this audit
(§7), not an unresolved textual contradiction. D does not apply.

---

## 4. Specifically: what 6.8974% is, and why it is not comparable to the v8 in-exec figures

**6.8974%** (`power_control_gate.txt`) = `(max−min)/max·100` over the **10
exec-window** values `execs[].pdh_after.observed_pct_perf_cpu0` of the controlled
High-Performance run (`min 203.256`, `max 218.314`).

- **Population:** **10 exec-level scalars**, one per exec, spanning the whole session.
- **Unit of observation:** a **snapshot-interval average** of PDH `% Processor
  Performance` (the `collect_before → collect_after` interval bracketing the exec).
- **Time support:** the entire 10-exec session (~minutes).
- **What it measures:** **between-exec** dispersion of interval-averaged clock ratio.

**The v8 in-exec figures (5.65–17.12%)** = `(max−min)/max·100` over the **exec-only**
PDH samples whose QPC timestamps fall inside the 50-iteration span of **one** exec
(n = 7–23 samples).

- **Population:** individual **instantaneous PDH samples** within one exec.
- **Unit of observation:** instantaneous counter reading.
- **Time support:** ~7 ms (a single exec).
- **What it measures:** **within-exec** dispersion.

**They are not the same statistical quantity.** They differ in *population*
(10 exec-level snapshot averages vs per-sample instants clustered in one exec), in
*aggregation* (interval average vs instantaneous), and in *time support* (whole
session vs one ~7 ms window). Both are printed as `(max−min)/max·100` in percent, but
a percentage of one quantity is not comparable to a percentage of another. The
v3 predeclaration states this explicitly: the exec-window metric "is NOT an
exec-only measurement … captures frequency variation that exists at the snapshot
instants but NOT during the exec itself"
(`highres_analysis.txt` §"THE 6.8974% EXEC-WINDOW SPREAD").

**Therefore the statement "five of sixteen B executions exceed 6.8974% internally"
is a frame/unit mismatch.** It is *not* that "the new number is larger"; the two
numbers measure different things, so neither confirms nor refutes the other. The
comparable quantity to 6.8974% would be a between-exec dispersion of the *same*
exec-window metric recomputed across the v8 B execs; the comparable quantity to the
v8 numbers would be an exec-only spread. No frozen or predeclared rule licenses
substituting one for the other.

---

## 5. Interpretation of the v7/v8 intra-exec findings

Real and unconfounded for what they measure: within-execution CPU clock ratio
genuinely varies 5.65–17.12% inside single ~7 ms executions, on directly-observed,
pin-verified, PDH-adequate instrumentation with 0 failures. This is evidence about
**hardware-frequency behavior**, and it is the *cause* the diagnosis attributes the
campaign's G7 reproducibility failures to. It is **not** evidence that the *frozen
G7 median criterion* was mis-specified or mis-implemented — that criterion remains
exactly as frozen, and its numeric outcomes are unchanged.

---

## 6. Specification / implementation consistency verdict

- **Implementation vs frozen spec:** **CONSISTENT.** Every element G7 evaluates
  (same-config grouping, per-record median, ±15/±20 bands, ≥10 samples, all-pairs)
  matches §G/§B exactly.
- **Labeling vs frozen spec:** **INCONSISTENT.** The project's *"5% G7 gate"* is a
  **project predeclaration** on a **different quantity** (`%perf`) with a **different
  threshold** (5% vs 15%). Neither the 5% threshold nor the frequency-stability
  requirement it encodes appears in the frozen specification.

---

## 7. Final authorization category

## NOT AUTHORIZABLE — SPECIFICATION GAP

**Why this category and not another:**

- **Not IMPLEMENTATION MISMATCH:** §2 traces the production G7 to the frozen §G text
  element-for-element; no divergence was found.
- **Not EVIDENCE GAP:** the metric is not merely under-evidenced; the evidence is
  complete and the finding is decidable. What is missing is not more measurements but
  a **specification** of the requirement being demanded. Additional runs cannot make a
  benchmark-median gate establish frequency stability.
- **SPECIFICATION GAP:** the project's G7 authorization precondition is **CPU-frequency
  stability**, and it is being established through the **frozen G7 formula** applied to
  a proxy quantity (exec-window `%perf`). The frozen G7 metric is a
  **benchmark-median reproducibility** gate with **no frequency-stability clause**, so
  it **cannot establish the requirement it is being relied upon to establish** — a
  G7 PASS would not prove frequency stability, and G7 FAIL does not isolate it.

**Exact reason G7 remains blocked:** the authorization rule in force
(`gate_predeclaration.txt`) requires classification **A** (control validated:
`spread_pct ≤ 5.0%` and no material in-exec ramp). The controlled run produced
`spread_pct = 6.8974%` → **classification B** (`power_control_gate.txt`), so a new G7
campaign is **not authorized**. Independently, even were the 5% gate met, the frozen
G7 metric would still only certify *benchmark-median reproducibility*, which the v7/v8
evidence shows is confounded by an environmental factor (CPU frequency/power state)
that the frozen metric neither measures nor requires to be controlled. The 5% threshold,
the 15%/20% tolerance, the formulas, the grouping, the median definition, and the
benchmark timing are **all unchanged**; nothing in this audit loosens or reinterprets a
failed measurement into an authorization.

---

## 8. Deliverable index (the 9 required items)

1. **Frozen spec reference** — §1 (`design/V009_phase1_M0_specification.md` §G:328, §B:109, §F:293–316).
2. **Production implementation reference** — §2 (`gates.cpp:748–895`, `:25`, `:49`, `:75–97`, `:179–185`; `aggregate.cpp:44–70,89,100`).
3. **Exact metric definition** — §1.1 (median reproducibility, `|Δmedian|/max·100 ≤ 15/20%`); the "5%" is a project predeclaration (§1.2), not frozen.
4. **Relationship to CPU-frequency stability** — §1.1 (not required, not mentioned) and §3C (the frozen metric cannot establish it).
5. **Interpretation of 6.8974%** — §4 (between-exec spread of 10 snapshot-interval-averaged `%perf` values).
6. **Interpretation of v7/v8 intra-exec findings** — §3B, §4, §5 (real within-exec variation; a different quantity, not comparable to 6.8974%).
7. **Spec/implementation consistency verdict** — §6 (implementation consistent; the "5% G7 gate" label is not the frozen metric).
8. **Final authorization category** — §7: **NOT AUTHORIZABLE — SPECIFICATION GAP**.
9. **Exact next action** — §9.

---

## 9. Exact next action, if any

**No experiment is authorized by this audit.** The single decision that remains is a
**specification question for the project owner**, not a measurement:

> Does the M0 acceptance contract intend G7 to certify **benchmark-median
> reproducibility** (as frozen, §G:328) or **hardware CPU-frequency stability**?
> These are different properties. The frozen metric can certify the former and
> **cannot** certify the latter; the ≤5% exec-window `%perf` gate is a separate,
> non-frozen construct that measures the latter. Until that intent is resolved,
> G7 stays un-authorized, M0 stays **FAIL**, and M1 stays **LOCKED**.

This audit performed **no** G7 run, created/modified **no** G7CAM record, changed
**no** threshold/formula/grouping/median/timing, and altered **no** frozen or v7/v8
artifact.
