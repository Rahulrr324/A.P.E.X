# CPU Frequency / Power-State Cause Investigation — Final Report

**Date:** 2026-10-06
**Scope:** Determine whether the claimed "uncontrolled CPU frequency/power state"
cause of the G7 failure is demonstrated by evidence. Read-only against all
existing records; no G7 campaign rerun; no benchmark, formula, tolerance,
grouping, sample, warmup, affinity, or frozen-record changes.

**Classification: A — CPU frequency/power state is directly demonstrated as the
dominant cause** (scope and limitation in §8).

---

## 1. Exact files inspected

Measurement/timing implementation (read-only):
- `src/phase1/bench/BenchmarkHarness.cpp` — `Clock` (= `std::chrono::steady_clock`),
  warmup loop, measurement loop, clock-sanity check, peak-memory sampling
- `src/phase1/bench/BenchmarkHarness.h` — contract comment "steady_clock wall
  timing (never clock())"
- `src/phase1/bench/TinyDenseModel.cpp` — `forward()`, `gelu()`,
  `serialize/deserializeWeights`, deterministic init
- `src/phase1/campaign/G7Campaign.cpp` — per-benchmark op code, per-exec
  affinity call, 30 s inter-run delay
- Build flags from `build-v24-release/build.ninja`: `-O3 -DNDEBUG -std=gnu++17`
  (no LTO, no `-march`, no `-ffast-math` — identical for campaign binaries)

Data (read-only):
- all 30 records in `build/g7-campaign-affinityfix/`
- frozen 30 via `reports/g7-campaign/verify_frozen30.py`

New diagnostic/analysis artifacts (this investigation):
- `tests/diag_frequency_evidence.cpp` (new) + CMake target `diag_frequency_evidence`
  (CMakeLists.txt: additive target only)
- `reports/g7-campaign-affinityfix/frequency_evidence.json` (raw telemetry),
  `frequency_evidence.log` (DIAG_EXIT=0)
- `reports/g7-campaign-affinityfix/analyze_existing_records.py` → `existing_records_analysis.txt`
- `reports/g7-campaign-affinityfix/analyze_frequency_evidence.py` → `frequency_correlation.txt`
- `reports/g7-campaign-affinityfix/records_sha256.txt` (30 SHA-256 baseline)
- `build/diag_freq_weights.bin` (diagnostic B7 blob; new file)

## 2. Exact measurement path for B6 / B7 / B9

Common (`run_benchmark`, unchanged): `validate()` → **10 warmup calls of `op()`
(all identical; no first-measurement special case)** → 50 × `{t0 =
steady_clock::now(); op(); t1 = steady_clock::now(); sec = duration; monotonic
sanity check; push_back}`. `steady_clock` on Windows = QueryPerformanceCounter.
One `op()` call per sample; no allocation, I/O, or syscalls inside the timed
region except what `op()` itself does.

- **B6**: `op = model.forward()` — 2-layer MLP (262,912 MACs + GELU/`std::exp`)
  on preallocated member vectors; no per-call allocation, no hidden state.
- **B9**: `op = model.forward()` + copy/compare against a reference output
  (bit-identical check) — same structure plus compare cost.
- **B7**: `op = ifstream open/read of a weight blob + deserializeWeights`
  (memcpy into preallocated arrays); OS file cache warms during the 10 warmups
  (`mode=warm_cache`); one buffer allocation per iteration (steady-state allocator).

Anti-distortion properties: `op()` writes model state consumed later (B9
compares outputs; records embed results), so the work is not elidable; `op()`
lives in another TU with **no LTO**, so no cross-TU inlining/elimination;
`NDEBUG` only disables asserts. All three are throughput-bound loops ⇒ time ∝
1/clock for fixed work. First-after-idle treatment: **none** — every exec gets
identical warmup+measurement; the 30 s gap exists only between independent runs.

## 3. Exact telemetry collected (new diagnostic, 10 production execs, DIAG_EXIT=0)

Provenance classes kept strictly separate:

| Class | Source | Result |
|---|---|---|
| 1. nominal/base | registry `~MHz` | **2496 MHz** |
| 1. nominal/base | CPUID brand | `12th Gen Intel(R) Core(TM) i5-12450H` |
| 1. nominal/base | NT `ProcessorInformation.MaxMhz` | **2000 MHz** (OS nominal basis) |
| 2. OS-requested state | NT `CurrentMhz`/`MhzLimit` | constant 2000/2000 — **nominal only, NOT used as frequency evidence** |
| 2. OS policy | `PowerGetActiveScheme` | GUID `DFE97760-471C-4D01-BD06-B8B04C50ECD8`, friendly name **empty** (custom/OEM scheme, not a standard Microsoft GUID) |
| 3. observed/effective | PDH `% Processor Performance` (CPU0, `_Total`) | hardware-derived effective-clock ratio vs nominal — **primary observed metric** |
| 3. observed/effective | PDH `Processor Frequency` (MHz) | constant 2000 → nominal-stuck, not usable |
| 3. observed/effective | PDH `% Processor Utility` (CPU0) | collected |
| 3. observed/effective | thermal zone counters | **UNAVAILABLE on this machine** (no thermal telemetry) |
| 4. inferred | from benchmark timing | computed only in analysis, always labeled |

Per exec (B6 ×6 = 1 warm + 3 post-30 s-gap + 2 back-to-back; B9 ×2 gap/warm;
B7 ×2 gap/warm): exec-window PDH reading (snapshot-query interval
`[collect_before → collect_after]` ≈ the exec itself), bracketing readings,
NT snapshots, thread times, timing structure (first10/last10/spikes/CV),
`after_idle_gap` flag, and production affinity verification
(**verified_single_cpu=true, raw mask 0x1, effective=[0] on all 10**).
Background sampler: 1,364 samples @100 ms. Campaign parity: same binary, same
pin, same warmup=10/n=50/thread=1/batch=1/seq=0/FP32 configs, same 30 s gaps.

## 4. Direct frequency/power-state evidence

- **Session spectrum (observed):** `% Processor Performance` for CPU0 ranges
  **39.8 % → 205.2 %** of nominal across the session (≈0.8–4.1 GHz effective of
  2000 MHz nominal). The core's frequency state swings enormously on this machine.
- **Exec-window observed frequency (observed), by exec:**

| exec | bench | gap | median µs | exec-window obs %perf | ≈MHz |
|---|---|---|---|---|---|
| 0 | B6 | no | 179.45 | **158.1** | ~3163 |
| 1 | B6 | **GAP** | 249.50 | **102.2** | ~2044 |
| 2 | B6 | **GAP** | 322.30 | **110.9** | ~2217 |
| 3 | B6 | **GAP** | 311.50 | **87.0** | ~1740 |
| 4 | B6 | no | 212.35 | **138.2** | ~2765 |
| 5 | B6 | no | 232.50 | **141.7** | ~2835 |
| 6 | B9 | **GAP** | 211.75 | 126.3 | ~2526 |
| 7 | B9 | no | 190.55 | 154.8 | ~3096 |
| 8 | B7 | **GAP** | 3250.30 | 139.6 | ~2791 |
| 9 | B7 | no | 3318.55 | 142.7 | ~2854 |

- **Gap vs warm (observed):** post-gap exec-window %perf mean **113.2 %**
  (range 87.0–139.6) vs warm/back-to-back mean **147.1 %** (range 138.2–158.1),
  n=5 each — post-idle execs measurably run at lower clock.
- Idle-tail observed %perf 66–91 % → the core sits at a reduced state during
  the 30 s gap (direct), so the first exec after a gap starts from reduced state.
- Negative control: B7 gap vs warm show **equal** exec-window %perf (139.6 vs
  142.7) and equal medians (3250 vs 3319 µs) — the metric tracks timing, not
  the gap label itself.
- Limitation stated: `GetThreadTimes` CPU-utilization values were erratic
  (0 %/130 % — Windows coarse CPU-time updates) and were **not** used as evidence.

## 5. Correlation between telemetry and timing clusters

- **B6 association (observed vs measured):** Pearson **r(median, exec-window
  %perf) = −0.848** (n=6). Products `median × %perf` are near-constant
  (25.5k–35.7k, mean 29.8k, **cv 11.7 %**) while raw medians spread **1.80×** —
  i.e. the timing spread collapses onto clock variation as `t ∝ 1/f`.
- `low median ↔ high clock / high median ↔ low clock`, exactly:
  179.45 µs ↔ 158.1 %; 212–233 µs ↔ 138–142 %; 249–322 µs ↔ 87–111 %.
- **Mapping to the existing campaign (labeled INFERENCE — the original 30 were
  never telemetered):** calibrating `t × %perf ≈ 29.8k` from the diagnostic gives
  181 µs → ~165 %, ~221 µs → ~135 %, 337–360 µs → ~83–88 % — all three land
  inside observed diagnostic states (158 / 138–142 / 87–111). Ratio checks:
  181/221 = 0.819 vs 130/158 = 0.823; 181/360 = 0.503 vs 87/158 = 0.551.
- **Structural corroboration in the original 30 (observed):** many runs occupy
  multiple timing bands *within* the same 50-sample window (e.g. record
  `G7CAM-B6-E1-63692176`: 41/50 samples >250 µs + 5 <200 µs, first10 389.8 µs →
  last10 199.45 µs) — mid-run state transitions, the same ramp signature the
  diagnostic shows under observed low frequency (exec#1 406.9→227.3 µs,
  exec#2 361.5→178.9 µs).

## 6. Analysis of the B6 idle-gap outliers (verified from timestamps)

Exactly four post-gap execs exist (all B6-E1, dt = 30.0 s each):

| record | median | cluster | within-window shape |
|---|---|---|---|
| run2 B6-E1 (`…63692176`) | 360.20 µs | C_slow | **50/50 samples >250 µs**, CV 6.30 % — whole window at slow state |
| run3 B6-E1 (`…20855871`) | 219.60 µs | B_mid | mixed bands |
| run4 B6-E1 (`…61571712`) | 221.45 µs | B_mid | 49/50 in 200–250 band |
| run5 B6-E1 (`…49559376`) | 337.00 µs | C_slow | 41/50 >250 µs, CV **127.5 %**, first10 389.8 → last10 199.45 — transition **during** measurement |

- **Both C_slow outliers are post-gap (4/4 post-gap ∋ both outliers); zero
  within-run execs are C_slow. But only 2/4 post-gap execs became outliers** —
  post-idle is necessary in this data, not sufficient (wake frequency varies).
- Diagnostic replication: post-gap B6 execs measured at observed 87–111 %
  (≈1.7–2.2 GHz) with first10 ≫ last10 recovery ramps — same mechanism.
- Outlier classification: **frequency/power-state wake-from-idle transition**:
  - not cache: 10 warmups precede measurement, yet the ramp persists through it;
    record `…63692176` is elevated for all 50 samples (not first-touch shaped);
  - not page faults: faults give isolated huge single samples (seen in B7:
    first sample 4944.8 µs vs median 3249 µs); record `…63692176` has **no**
    sample <250 µs;
  - not wake-latency alone: latency affects the first samples only; both warm
    and slow execs run the identical 10-iteration warmup first;
  - not benchmark init: model construction happens before timing and is
    deterministic-identical for fast and slow execs;
  - not timer: observed quantization ≈100 ns, monotonic, harness sanity-checked;
  - scheduling: possibly contributes to the mixed tail of `…49559376` (spikes
    present) but cannot produce the tight-CV all-slow window of `…63692176`,
    and observed clock was low during the diagnostic's post-gap execs.

## 7. Alternative causes considered (read-only)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Cache warm/cold | **Rejected** | 10 identical warmups precede every measurement; ramps persist through measurement; slow windows are uniformly slow (all 50) |
| First-run effects | **Rejected as driver** | process-start exec was the *fastest* (179.45 µs @158 %); only *post-idle* firsts are slow — and observed clock explains them |
| Allocation / page faults | **Rejected as driver** | no per-iter alloc in B6/B9; faults appear as isolated spikes (B7 4944 µs first sample), not whole-population shifts |
| Thermal throttling | **Rejected as dominant** | post-idle execs are *slower* (cooling during idle should speed up); heavy B7 got faster late in the sequence; **no thermal counters available on this machine — direct thermal telemetry missing (limitation)** |
| OS scheduling/interference despite affinity | **Rejected as dominant** | affinity verified CPU0 all execs (and 30/30 campaign); preemption signature = isolated spikes (0–18/50, band gap only 1.2–1.8×); observed clock co-moves with timing; the campaign ran *without* the diagnostic's sampler and showed the same clusters. `GetThreadTimes` metric unusable (limitation, not used) |
| Timer behavior | **Rejected** | QPC/steady_clock, ~100 ns quantization, monotonic sanity in harness |
| Benchmark initialization | **Rejected** | init before timing, deterministic-identical models |
| Measurement overhead | **Rejected** | 2 clock reads (~tens of ns) vs 180 µs+ ops; constant across execs |
| Compiler/runtime | **Rejected** | same binary produced both fast and slow values |
| **Power-management transitions** | **SUPPORTED (direct)** | 39.8–205.2 % session spectrum; gap-vs-warm exec-window %perf 113.2 % vs 147.1 %; r = −0.848; in-exec ramps at low observed clock; custom OEM power scheme active |
| Windows background activity | **Partially — not the campaign cause** | diagnostic sampler shares CPU0 (100 ms, sub-ms), but the campaign had no sampler and showed identical clusters; residual co-runners would appear as spikes |

## 8. Final classification: **A**

CPU frequency/power state is **directly demonstrated as the dominant cause**:
observed hardware-derived clock (PDH `% Processor Performance`) varies ~1.8×
across campaign-matched execs, inversely tracks median time (r = −0.848,
`t×%perf` cv 11.7 % vs timing spread 1.80×), is systematically lower for
post-idle execs (113.2 % vs 147.1 %), and the session spectrum (39.8–205.2 %)
dwarfs the G7 failure margin (failures 15.5–50.2 % require ≥15 %). Every tested
alternative fails against the observed structure.

**Scope/limitation stated plainly:** per-run frequency telemetry for the
original 30 records does not exist (it was never captured during the campaign,
and cannot be reconstructed). The demonstration is by direct measurement under
campaign-matched conditions (same binary, pin, configs, machine, 30 s gaps)
plus structural corroboration on the originals (post-gap exclusivity of both
C_slow outliers, mixed within-window bands = the same mid-run transitions seen
under observed low clock). No temperature telemetry was available, so thermal
vs DVFS-policy as the *driver* of low states cannot be separated — both are
"frequency/power state" and neither changes the classification; the post-idle
*slowdown* specifically argues against thermal.

## 9. Minimal standards-compliant control proposal (DO NOT IMPLEMENT YET)

**Primary (minimal):** session-scoped power-policy control around the campaign:
`PowerSetActiveScheme(NULL, &guid)` → switch the active scheme to the
documented Windows **High performance** GUID
(`8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c`) at campaign start, and
`PowerSetActiveScheme` back to the recorded original
(`DFE97760-471C-4D01-BD06-B8B04C50ECD8`) at campaign end, with start/end
recorded in provenance.
- **Scope:** machine-wide *only while the campaign window is active*; restored
  afterward; nothing permanent.
- **Tradeoffs:** higher power/heat/fan noise during the window; behavior on AC
  vs battery differs (campaign must run on AC); it raises the frequency floor
  but does not guarantee a fixed clock — turbo may still vary with temperature.
- Explicitly **not** proposed: MSR writes, BIOS changes, fixed-clock overrides,
  disabling turbo/thermal protections, permanent machine-wide policy changes.

**Verification gate before any campaign (mandatory):** re-run the
`diag_frequency_evidence` diagnostic under the chosen control and require the
exec-window observed %perf spread across repeated gap+warm execs to fall below
a threshold fixed in advance (proposal: ≤5 %, i.e. comfortably under the 15 %
G7 tolerance's measurement share). Only then is a G7 campaign justified.

**Optional supplement** (only if the gate still fails): a declared,
unmeasured conditioning load (~200–500 ms sustained compute on the pinned CPU)
before each run's warmup so every exec starts from the same loaded-clock state;
it must be declared in the campaign design frozen before measurement; it does
not touch the timed region or benchmark code.

## 10. Is another G7 campaign justified?

**Not yet.** Observed frequency still varies ~1.8× (≫15 %), so another campaign
under current conditions would predictably FAIL for the same demonstrated
reason. Sequence: (1) decide/apply a control from §9, (2) re-run the
diagnostic and pass the ≤5 % stability gate, (3) then a G7 campaign is
justified. No campaign was run in this task.

## 11. Existing records unchanged

- **Frozen 30:** `verify_frozen30.py` → `PASSED` (30/30 SHA, manifest count 30,
  manifest hash `7a8dd9de…fc5a` unchanged), exit 0, re-run after this task.
- **Campaign 30 (`build/g7-campaign-affinityfix`):** all 30 mtimes are
  `2026-10-06 17:48–17:50` (campaign window only; this investigation ran later);
  SHA-256 of all 30 recorded in `records_sha256.txt`. No tool in this task
  opened them for writing (analysis scripts use read-only `json.loads`; the
  diagnostic writes only `frequency_evidence.json` and `diag_freq_weights.bin`).
- G7 formula/tolerance/grouping/benchmark/samples/warmup/affinity: **untouched**
  (only CMake target addition + new diagnostic/analysis files).

## 12. M0 / M1 status

- **M0: FAIL** (G7 still failing on the existing evidence; unchanged by this task)
- **M1: LOCKED** (no M1 work performed)
