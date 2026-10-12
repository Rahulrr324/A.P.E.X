# G7 Decision Memo — What Does M0/G7 Certify?

**Date:** 2026-10-08
**Type:** Governance / specification decision artifact. **Not** an implementation task.
**Primary evidence:** frozen `stark/design/V009_phase1_M0_specification.md` (rev 1.1)
and the completed audit `stark/reports/g7-campaign-affinityfix/G7_METRIC_AUDIT_v1.md`.
**Status:** no decision taken here. The single open item is a project-owner choice.

**Constraints honored:** §G unchanged; the 5% precondition unchanged; no gate renamed;
no G7 campaign run; no G7CAM record created/modified; no frozen/frequency evidence
altered; production code untouched.

---

## Required decision question

Does **M0/G7** intend to certify:

- **Option 1 — Benchmark reproducibility only** (the frozen ±15%/±20% rule is
  authoritative; frequency stability is a separate diagnostic/precondition and is not
  claimed to be proven by G7), or
- **Option 2 — Benchmark reproducibility + hardware-frequency stability** (in which
  case the current frozen specification does **not** fully encode that requirement and
  a **formal specification revision is required** before any implementation or
  acceptance-criteria change).

---

## Analysis (evidence only)

### 1. What §G actually says

§G, line 328, verbatim:

> **G7** | Full re-run of the same suite with same config: every benchmark median
> within ±15% of the recorded median (memory bandwidth ±20%). Determinism check per
> rev-1.1: CPU FP32 deterministic-mode records must be `outputs_bit_identical == true`;
> GPU records evaluated per declared mode (`deterministic_mode_available == false` ⇒
> bit-identity not required). Tolerance is defined here once — later phases may not
> loosen it silently.

It fixes exactly four things:

1. **Object of comparison:** "every benchmark **median**" — the per-run, stored median
   of the timed samples.
2. **Baseline:** "the **recorded** median" of runs with "same config".
3. **Tolerances:** **±15%** (timing), **±20%** (memory bandwidth). Fixed once.
4. **A determinism sub-clause** (`outputs_bit_identical`) for deterministic-mode
   records.

§B (line 109) supplies the measurement ground rules: fixed workload sizes/seeds,
≥3 warmups, ≥10 timed iterations, pinned affinity, report mean/median/p95 + raw
samples. §F fixes records as append-only.

The audit (§2) confirms the production implementation — `gates.cpp:748–895`
(all-pairs `|Δmedian|/max·100`, `allowed = bandwidth ? 20.0 : 15.0`), grouped by the
serialized `configuration` block, `≥10` samples, ≥2 independent `record_id`s — matches
these four elements. **Implementation = specification.**

### 2. What §G does NOT say

- **No frequency term.** No "frequency", "clock", "MHz", "DVFS", "turbo",
  "power state", or "hardware state" appears anywhere in §B, §F, or §G.
- **No within-execution requirement.** The frozen specification never mentions
  intra-execution variation, sample-level stability, or any temporal-stability clause.
- **No requirement to *control* the environment.** It does not require any power-scheme
  registration, any stability precondition, or any pre-campaign conditioning gate.
- **No "5%".** The value 5% appears nowhere in the frozen specification; the frozen
  tolerances are 15% and 20%.
- **No attribution.** Nothing in §G requires G7, on FAIL, to identify *why* medians
  diverged.

### 3. What the 5% precondition actually measures

`gate_predeclaration.txt`: `spread_pct = (max−min)/max·100` over the controlled run's
**exec-window `observed_pct_perf_cpu0`** values, gate `≤ 5.0%`. Those values are
**snapshot-interval averages** of the PDH counter `\Processor Information(0,0)\%
Processor Performance` — i.e. a **hardware clock-ratio** measurement, one scalar per
exec, spanning the whole session. Its stated purpose
(`CPU_FREQUENCY_CAUSE_INVESTIGATION.md` §9) is to confirm the machine's **frequency is
stable enough** to authorize a G7 campaign. It is a **project construct**; the
predeclaration itself notes it merely reuses the *shape* of the G7 pairwise formula
("exactly the frozen G7 pairwise formula … evaluated on the extreme pair (min,max)").

So:

| | Frozen G7 metric | The 5% precondition |
|---|---|---|
| **Quantity measured** | benchmark latency/throughput **median** (per run) | hardware **clock ratio** `%perf` (per exec snapshot) |
| **Object** | independent **runs** | **execs within one session** |
| **Threshold** | 15% / 20% | 5% |
| **Property** | benchmark-median reproducibility | hardware-frequency stability |
| **Source** | frozen §G | project predeclaration |
| **Current result** | FAIL (16–48% in every fresh campaign) | FAIL (6.8974% > 5%) |

### 4. Why the two metrics must not be conflated

1. **Different domains.** One is a *timing-reproducibility* statistic over runs; the
   other is a *clock-ratio* statistic over execs. A percentage of one quantity is not a
   percentage of the other.
2. **Non-implication both ways.** A G7 **PASS** is compatible with large within-exec
   frequency variation (a clock-insensitive workload, or one whose variation cancels in
   the median, passes) — so G7 PASS does **not** prove frequency stability. Conversely a
   G7 **FAIL** does not, by itself, isolate frequency as the cause.
3. **Unit/frame mismatch in the evidence chain.** The audit §4 shows the historical
   **6.8974%** is a *between-exec* spread of interval-averaged clock ratio, whereas the
   v7/v8 **5.65–17.12%** figures are *within-exec* spreads of instantaneous samples.
   These are different statistical quantities; neither confirms nor refutes the other.
4. **Labeling hazard.** The project calls the 5% `%perf` gate "the G7 gate / the 5% G7
   gate", while the frozen G7 is the ±15%/±20% median gate. Sharing a name and a formula
   shape does **not** make them the same requirement, and treating them as one is exactly
   how a reproducibility gate gets mistaken for a frequency-stability oracle (audit §3C).

### 5. What M0 acceptance means under Option 1

- §G remains authoritative **as written**: ±15% (±20%) benchmark-median reproducibility
  across same-config runs, all-pairs, ≥10 samples, append-only records.
- The 5% `%perf` spread and the v7/v8 frequency findings are **diagnostics**, not
  acceptance criteria. They may **explain** a G7 FAIL; they may not be substituted for
  it, and they cannot independently pass or fail an acceptance gate.
- M0 acceptance reduces to the frozen §L.8 exit criterion: **G1–G8 PASS on this
  machine.** Today that is **not** met: G7 fails on every available evidence set
  (historical nine and every fresh campaign), and no frozen clause is changed.
- The frequency diagnosis becomes *supporting context* for why the benchmark is not
  reproducible on this machine — but the **decision to fix the environment** (or not)
  is a project choice **outside** the frozen G7 gate, which never required it.

### 6. What would have to change under Option 2

Option 2 asserts G7 must certify **both** reproducibility *and* hardware-frequency
stability. Because §G does not encode a frequency requirement, Option 2 **cannot** be
implemented by tuning existing code or by reading the current text more strictly. It
requires, in order:

1. A **formal specification revision** that adds an explicit frequency-stability
   requirement (quantity, statistic, threshold, measurement path, and pass/fail
   semantics) to the frozen acceptance contract — i.e. a **new/next revision** of
   `V009_phase1_M0_specification.md`, not a silent edit (the current text forbids later
   phases from loosening tolerances and fixes G7's meaning where it stands).
2. Re-derivation of the **acceptance criteria and matrix** (`m0_acceptance_matrix.json`,
   `M0_FINAL_ACCEPTANCE.md`) against the revised contract, including how a frequency
   clause relates to the existing 5% precondition (which is currently only a
   predeclaration).
3. Only **then**, implementation work and any parameter (e.g. the 5% value) — because
   changing implementation or the precondition *before* the spec revision would invert
   the governance order and is explicitly out of scope here.

Until (1)–(3) occur, Option 2 is **not an executable state**: the acceptance gate would
be enforcing a requirement that the frozen contract does not contain.

### 7. Does either option permit G7 to run immediately?

- **Option 1:** G7 is *definitionally* runnable at any time — it is the frozen metric and
  the production implementation matches it. But running it now does not reach
  acceptance: it **FAILS** on every available evidence set for a demonstrated
  environmental reason. The authorization ruled currently in force
  (`gate_predeclaration.txt`: campaign authorized only on classification A) is **not**
  met — the controlled run gave classification B (6.8974% > 5%). Under Option 1 the 5%
  precondition is a *diagnostic/authorization* convention, not an acceptance gate; the
  project owner may decide what, if anything, it should gate.
- **Option 2:** G7 **cannot** legitimately run to acceptance, because the acceptance
  requirement (frequency stability) is not yet encoded in the frozen spec — a spec
  revision must precede it.

**Neither option makes a G7 run produce ACCEPTANCE today.** Nothing in this memo
authorizes running G7.

---

PROJECT-OWNER DECISION REQUIRED

| Decision | Meaning | Code/spec change now? | G7 authorized now? |
|---|---|---|---|
| **Option 1** | G7 certifies **same-config benchmark-median reproducibility** only; ±15%/±20% §G is authoritative; frequency stability is a separate diagnostic/precondition and is **not** claimed proven by G7. | **No** code change; **no** spec change (§G already is this). | Metric is runnable, but a run **FAILS** today and the 5% authorization precondition is unmet — so **not authorized now** without an owner ruling on the precondition's role. |
| **Option 2** | G7 is intended to certify **reproducibility + hardware-frequency stability**. | **Yes — spec revision first** (add the frequency requirement to the frozen contract, then update acceptance criteria, then implementation/parameters, in that order). | **No** — a spec revision must precede any run/acceptance; the requirement is not yet encoded. |

No option is selected on the project owner's behalf.
