# Session-Scoped Power-Scheme Control — Stability-Gate Validation Report

**Date:** 2026-10-06
**Scope:** Validate ONLY whether the §9 control proposal from
`CPU_FREQUENCY_CAUSE_INVESTIGATION.md` (temporary High-performance scheme +
mandatory ≤5 % exec-window `% Processor Performance` gate) produces a
sufficiently stable measurement environment. **No G7 campaign was run.**
No benchmark, timing, sample-count, warmup, affinity, G7-formula, G7-tolerance
or grouping change was made.

**Final classification: B — CONTROL INSUFFICIENT.**

---

## 0. Predeclaration and pre-flight (all before any scheme change)

| Time (IST) | Event | Artifact |
|---|---|---|
| 19:24:42 | Gate + formulas + decision rules written **before** the run | `gate_predeclaration.txt` |
| 19:25:09 | Read-only query of the active scheme (pre-change snapshot) | `power_scheme_before.json` |
| 19:25:31 → 19:28:03 | Guarded session: apply → diagnostic → restore | `power_scheme_session.json`, `frequency_evidence_hp.log` |
| 19:28:51 | Independent re-query proving restoration | `power_scheme_after_restore.json` |
| 19:29:52 | Gate computation (script executes the predeclared formulas) | `power_control_gate.txt` |

Pre-flight integrity: frozen 30 verified (`verify_frozen30.py` exit 0),
campaign 30 SHA-256 matched `records_sha256.txt` (30/30).

**Predeclared gate (verbatim, will not be adjusted):** exec-window observed
performance = `execs[].pdh_after.observed_pct_perf_cpu0`;
**spread = (max − min)/max × 100 over ALL exec-window values; PASS iff ≤ 5.0 %**
(the frozen G7 pairwise formula on the extreme pair). Secondary (non-gating):
spread/mean, spread/min, CV. Material in-exec ramp: >5.0 % within-window
first10→last10 timing drift **or** >5.0 % bracketing `%perf` change.

## 1. Control implementation

New target `power_scheme_control` (`tests/power_scheme_control.cpp`, CMake
addition only): documented `PowerGetActiveScheme` / `PowerSetActiveScheme` /
`PowerReadFriendlyName` from powrprof.dll. No registry writes, no MSR, no BIOS,
no clock forcing, no thermal changes, no undocumented APIs. `status` is
read-only; `run` snapshots the original scheme, applies HP, runs a child
command, then **always restores** (normal path, child failure path, and a
`SetConsoleCtrlHandler` path for Ctrl+C/console close), re-queries, and proves
the restored GUID equals the original.

## 2. Required results (16 items)

1. **Original active scheme:** `DFE97760-471C-4D01-BD06-B8B04C50ECD8`,
   friendly name **empty/none** (queried from the OS at 2026-10-06T13:55:09Z,
   not assumed) — `power_scheme_before.json`.
2. **Requested High Performance GUID:** `8C5E7FDA-E8BF-4A96-9A85-A6E23A8C635C`.
3. **Apply result:** `PowerSetActiveScheme` return `0` (ERROR_SUCCESS) at
   13:55:31.729Z.
4. **Active scheme after apply:** `8C5E7FDA-E8BF-4A96-9A85-A6E23A8C635C`
   (confirmed by the parent's re-query **and** by the child diagnostic's own
   `static.power_scheme` query inside `frequency_evidence_hp.json`).
5. **Diagnostic sample count:** **10 production execs** — B6 ×6 (1 warm,
   3 post-30 s-gap, 2 back-to-back), B9 ×2 (gap/warm), B7 ×2 (gap/warm);
   warmup 10, n=50, thread 1, batch 1, seq 0, FP32, verified CPU-0 affinity
   on 10/10 execs; 1,357 background timeline samples @100 ms. Same structure,
   same unmodified binary, as the previous investigation.
6. **Exec-window `% Processor Performance` (CPU0):**
   min **203.256**, max **218.314**, mean **214.318**, median **217.944**,
   stdev 5.917 (sample), **CV 2.761 %**.
7. **Exec-window spread:** **primary (max−min)/max = 6.8974 %** → **over the
   5 % gate**. Secondary: /mean = 7.0260 %, /min = 7.4084 %. (Pre-control
   baseline on the same metric: 44.9768 %.)
8. **Post-gap vs warm:** post-gap mean **215.957** (n=5, 209.552–218.314) vs
   warm mean **212.680** (n=5, 203.256–218.237) → **−3.277 pp**, i.e. post-gap
   is no longer penalized (1.52 % relative, sign flipped vs baseline).
   Pre-control baseline was 113.2 (gap) vs 147.1 (warm) = 22.9 % penalty.
   The idle-gap frequency penalty is essentially eliminated by the control.
9. **In-execution ramps:** 6/10 execs flagged by the predeclared criterion.
   (a) Within-window timing drift first10→last10: max **5.125 %** (B7 exec#8);
   B6/B9 all ≤ 0.153 % — inside-window timing for B6/B9 is essentially flat.
   (b) Bracketing `%perf` change before→after: max **16.724 %** — all four
   post-gap execs rose from ~187–197 % (idle interval) to ~216–218 % (exec
   interval), plus both B7 execs (5.8 %, 6.4 %). So a wake/load ramp still
   crosses the start of every post-gap execution.
10. **Stability-gate result:** **FAIL** — 6.8974 % > 5.0 %, and material
    ramps present (6/10). Criterion not adjusted after seeing results.
11. **Restoration result:** `PowerSetActiveScheme` return `0`, re-query
    `matches_original = true`, session result `"OK"`, wrapper exit 0.
12. **Active scheme after restoration:**
    `DFE97760-471C-4D01-BD06-B8B04C50ECD8` — proven twice: in-session re-query
    and an independent later `power_scheme_control status` invocation at
    13:58:51Z (`power_scheme_after_restore.json`, exit 0).
13. **No G7 campaign run:** confirmed — `g7_campaign.exe` was never invoked
    (binary mtime still 17:46); 0 `G7CAM-*.json` files newer than 17:51;
    60 total G7CAM files under `build/` = 30 frozen + 30 campaign, none new;
    campaign records still 30 with mtimes 17:48–17:50 only.
14. **Frozen 30 unchanged:** `verify_frozen30.py` exit 0 both before and
    after (30/30 SHA, manifest count 30, `evidence_manifest.json` unchanged).
    Campaign 30 byte-identical to `records_sha256.txt` after the session
    (30/30 match, no missing/extra/mismatch).
15. **Final classification: B — CONTROL INSUFFICIENT.**
16. **New G7 campaign authorized? NO.** The predeclared ≤5 % gate failed;
    per the task rules G7 must not be run until the gate passes.

## 3. Per-exec table (controlled run)

| exec | bench | gap | median µs | %perf before | **%perf exec-window** | first10→last10 drift | bracket Δ |
|---|---|---|---|---|---|---|---|
| 0 | B6 | no | 139.60 | 202.855 | **203.256** | 0.14 % | 0.20 % |
| 1 | B6 | yes | 129.90 | 194.192 | **217.863** | 0.04 % | **12.19 %** |
| 2 | B6 | yes | 129.95 | 193.671 | **216.030** | 0.08 % | **11.55 %** |
| 3 | B6 | yes | 129.90 | 187.035 | **218.314** | 0.04 % | **16.72 %** |
| 4 | B6 | no | 130.35 | 218.147 | **218.237** | 0.87 % | 0.04 % |
| 5 | B6 | no | 129.90 | 218.269 | **218.235** | 0.65 % | 0.02 % |
| 6 | B9 | yes | 130.30 | 192.687 | **218.026** | 0.15 % | **13.15 %** |
| 7 | B9 | no | 130.30 | 218.208 | **218.232** | 0.08 % | 0.01 % |
| 8 | B7 | yes | 2105.70 | 197.013 | **209.552** | **5.13 %** | **6.37 %** |
| 9 | B7 | no | 2128.95 | 218.139 | **205.440** | 3.00 % | **5.82 %** |

Timing context (medians, µs): B6 129.90–139.60 (timing spread 6.95 %) vs
baseline 179.45–322.30 (1.80×); B9 130.30 vs baseline 190.55–211.75;
B7 2105.70–2128.95 (1.09 %) vs baseline 3250.30–3318.55.

## 4. Why the gate failed (exploratory, NON-GATING decomposition)

- **Session-first exec is one outlier:** exec#0 (first measured exec of the
  session) sat at 203.256 % while everything after plateaued at 216–218 %.
- **B7 (file-I/O bench) is the other:** 209.552 / 205.440 %. Excluding
  exec#0 only → spread 5.8971 % (still >5 %); excluding exec#0 and B7 →
  1.046 %; B6 post-gap execs alone → 1.046 %; B6 warm execs 4–5 → 0.001 %.
  Neither exclusion is gating — the predeclared rule uses ALL values.
- **Residual ramps are at exec boundaries, not inside the timed region:**
  every post-gap exec starts while the core's pre-exec interval is still at
  187–197 % and reaches the 216–218 % plateau during the exec — the wake ramp
  persists even under High performance; only its magnitude shrank (baseline
  gap penalty 22.9 % → 1.5 %, but per-exec boundary jump up to 16.7 %).
- Under the control the machine is in a single tight band ~216–218 % of
  nominal for B6/B9 (vs 87–158 % baseline), i.e. the control is a large
  improvement but does not by itself reach the predeclared ≤5 % bar.

## 5. Verification performed

- `ninja power_scheme_control` → exit 0; full `ninja -k 0` builds every
  target except `run_baseline`, which fails to compile with a **pre-existing**
  overload ambiguity in `src/phase1/baselines/run_baseline.cpp` (source mtime
  2026-10-05, header `BenchmarkHarness.h` mtime 17:45 — both predate this
  task; this task added no declarations to it).
- `ctest --output-on-failure` → **7/7 passed**, exit 0.
- `analyze_power_control.py` → exit 0, wrote `power_control_gate.txt`.
- Artifacts added (nothing pre-existing overwritten): `gate_predeclaration.txt`,
  `power_scheme_before.json`, `power_scheme_session.json`,
  `power_scheme_after_restore.json`, `frequency_evidence_hp.json`,
  `frequency_evidence_hp.log`, `power_control_gate.txt`,
  `analyze_power_control.py`, this report; source `tests/power_scheme_control.cpp`;
  CMake: one additive `power_scheme_control` target.

## 6. Alternatives to investigate before any G7 campaign (required for B)

1. **Declared pre-measurement conditioning load** (§9 optional supplement):
   ~200–500 ms sustained compute on the pinned CPU before each run's warmup,
   so every exec starts from the loaded-clock plateau instead of the
   187–197 % wake state; declared in the frozen campaign design, outside the
   timed region.
2. **Session warm-up discard:** run-and-discard a fixed number of untimed
   execs after applying HP, so the low session-first state (203.3 %) is
   consumed before measurement starts.
3. **Per-bench treatment of B7's I/O execs** (205–210 % vs 216–218 % for the
   compute benches) — either its own conditioning step or a bench-specific
   gate, declared in advance.
4. **Reduce/structure the wake transition** within the constraints of the
   frozen 30 s inter-run gap (the gap itself cannot be removed — frozen).

Re-run the same diagnostic + the same unchanged ≤5 % gate after each
candidate control; only a PASS authorizes a G7 campaign.

## 7. M0 / M1 status

- **M0: FAIL** (unchanged; no G7 evidence produced in this task)
- **M1: LOCKED** (unchanged)
