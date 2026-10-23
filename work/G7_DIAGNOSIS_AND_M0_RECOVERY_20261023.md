# A.P.E.X — G7 Diagnosis and M0 Recovery Report (2026-10-23)

All findings below are from read-only analysis of committed evidence and source.
No new measurements were run; no frozen artifact was modified; E3 was not
executed; no signature was fabricated.

## 1. Verified current state

| Item | Verified fact |
|---|---|
| Branch / PR | `arena/c90f7329-a-p-e-x`, PR #2 OPEN, head `59d50a4cdf91c11981c7d0370ef9000593cfa821` == `git ls-remote` tip; `main` = `563395f1…` unmoved |
| History | `59d50a4` (Round-2 evidence) → `affecc4` (Round-1 record) → `460f295` (E3 patch + §5 rulings) → `f250d73` (addendum) → `563395f1` |
| Round-1 record | unchanged vs `affecc4` (0-line diff) |
| Round-2 store | 43 records at `build/results/`, `STORE_MANIFEST.sha256` 43/43; archive `MANIFEST.sha256` 41/41 |
| Addendum | §5 rulings recorded (Q&A 2026-10-22), **signature block blank — unsigned** |
| Status | M0 = FAIL, M1 = LOCKED |

## 2. Root-cause findings

### 2.1 Facts (verified from raw samples and source)

**F1 — Both G7 failures are sustained speed-plateau shifts, not spikes.**
Per-sample data (committed raw `samples` arrays):
- Round-2 outlier `P1-E5-B7-67375`: n=10, min 4090.6 / med 4184.5 / max 4315.0 µs, sd 60.8 — the **entire distribution** sits +30% above every peer (peers: 3044–3688 µs). A median shift of 25% with sd ≈ 61 means ≥ half the measurement window ran on a slower plateau — impossible from a few scheduler blips.
- PASS-1 B7 records show **slow→fast decay within the record** (`P1-E1-B7-63147`: head 3566→4262 µs, tail 3102–3207 µs, sd 440; `P1-E5-B7-72185`: 3688→3162 µs), while PASS-2 `P1-E1-B7-63770` is flat (3044–3209, sd 55). The host's speed state varies at ~record-timescale (~50–100 ms windows).
- B9 near-miss (13.02%) is the same phenomenon touching compute once: `P1-E1-B9-63147` sd 167.6, max 841 µs vs med 338 (peers med 294–298).
- Round-1's outlier was the same plateau effect in the **fast** direction (one invocation −16…−23% across B6/B7/B9).

**F2 — B7 amplifies plateau effects by construction.** `bench_model_load_time`
(`stark/src/phase1/bench/BenchmarkHarness.cpp` L298–315): each timed sample =
`std::ifstream` open + full 1,051,664-byte read (`istreambuf_iterator`) +
`deserializeWeights`. Blob write is outside timing (L301–306). The op is
memory-bandwidth/IO-bound; compute micro-ops (B6, `model.forward()`,
L289–293) stayed within 5.73% in the same windows. Declared
`workload_params.mode = "warm_cache"` (L310) is asserted, never verified.

**F3 — Evaluator is correct and consistent with the frozen contract.**
`stark/src/phase1/gates.cpp`: groups = `r.configuration.dump()` string
equality (L831–834); record_id dedup (L837–844); deviation =
`symmetric_rel_diff_pct` = |a−b|/max(|a|,|b|)·100 (L33–47); all-pairs, no
reference selection (L866–875); allowed 20% for B3/B5 else 15% (L864). No
grouping, comparison, or reference-selection defect.

**F4 — One genuine metadata inconsistency (not causal).** B9 declares
`workload_params {"repeats":"200"}` and the file comment says "200 repeats"
(BenchmarkHarness.cpp L327–330), but the executed measurement is
`warmup_count=3` + `measurement_count=10` = **13** `model.forward()` calls
(`run_benchmark` L88–113; `run_baseline.cpp` `make_cfg` L256–258). Declared ≠
executed. No gate consumes `repeats`; determinism compares the actual ops.

**F5 — Run configuration is identical across rounds and the feasibility
pair** (warmup 3 / measurement 10 for E1/E5/B6/B7/B9, 30 for B1/B2/B3;
`--threads` 1 vs 2 are separate configuration groups). No comparability defect.

### 2.2 Hypotheses (plausible, unconfirmed)

- **H1 (primary): host co-tenant / memory-bandwidth contention** on the shared
  container creates ±10–30% speed plateaus; B7 (bandwidth-bound) and B9
  (burst-sensitive) cross the frozen ±15% band while B6 does not.
- **H2: CPU frequency/governor states** (turbo ramp) — the within-record
  slow→fast decay shape is consistent with ramping.
- H1/H2 are indistinguishable without scheduler/frequency telemetry.

### 2.3 What is NOT the cause (ruled out by evidence)
Evaluator arithmetic/grouping; record-writing/overwrite; config or
sample-count mismatch; threshold definitions; the E5 program path itself
(same invocation produced normal B6/B9 records 70 ms from the slow B7 window).

## 3. Smallest decisive diagnostic

**Completed now (no authorization needed):** the sample-level plateau analysis
in §2 — this already localizes the failure to host speed-state variance hitting
a bandwidth-bound benchmark.

**Proposed next (requires new owner authorization — instrumentation scope):**
one paired instrumented diagnostic (~15 min, **separate store
`build/diag-g7-20261023/`, labeled DIAGNOSTIC, never acceptance evidence**):
two all-core passes (E1/E5/B1/B2/B3, identical workload/config/affinity) with
(a) per-sample wall timestamps written alongside each sample, (b) scheduler +
CPU-frequency telemetry sampled at 10 ms (`perf sched record` or
`/proc/stat` + `scaling_cur_freq` polling), (c) run-log affinity attestation.
Outcome use: if plateau windows correlate with co-tenant/frequency events →
H1/H2 confirmed (host); if not → measurement-path sensitivity is the residual
factor (B7 methodology).

**Requested approval wording (owner):**
> "I authorize one G7 diagnostic instrumentation run as specified in
> `work/G7_DIAGNOSIS_AND_M0_RECOVERY_20261023.md` §3: per-sample timestamps and
> scheduler/CPU-frequency telemetry around one paired all-core campaign, stored
> in `build/diag-g7-20261023/` as DIAGNOSTIC evidence only. This does not alter
> the frozen acceptance contract, thresholds, or historical evidence, and does
> not count as an acceptance campaign."

**If authorization is missing: stop here.** (It is missing as of this report —
the two acceptance-round authorizations do not cover new instrumentation.)

## 4. Fastest legitimate M0 recovery — decision tree

| Finding | Required action |
|---|---|
| **Measurement-path defect** (B7's IO+deserialize mixing judged unacceptable by spec authority) | Spec authority issues a **formal G7 scope revision** (e.g., B7 methodology change as an authorized code change + campaign re-run). Tolerances must not change. Both failed rounds stay preserved. |
| **Host instability confirmed** (telemetry correlates plateaus) | **Change the acceptance machine** (below) — fastest legitimate path. This shared container has now failed G7 twice on the same class. |
| **Inconclusive** | No third identical round. Owner chooses: (a) machine change, or (b) a contract-compliant higher-sample campaign (e.g., `measurement_count=30`, still ≥10 — configuration floor, not a threshold change; needs owner authorization; median becomes less window-sensitive), or (c) the §3 diagnostic first. |
| **Different acceptance machine — recommended primary** | Yes. |

**Minimum machine requirements:** x86-64; ≥2 logical cores (all-core variant);
≥4 GB RAM (suite cap 1.5 GB host workload); **dedicated** during campaigns
(no co-tenant load); fixed `performance` governor; Linux ≥5.x or Windows/MSVC
native; CPU-affinity pinning available.

**Re-run procedure (identical contract):** per `work/g7_feasibility_pair_20261022/REPRODUCE.md`
— env set ONCE (`profiler_cli`, `E2`, `E4`), all-core pair (2 identical passes
of E1/E5/B1/B2/B3 with pinned affinity), `E3 --disposition` (never execute E3),
`aggregate` + `--strict`, five §K tests, §M audit, manual G8 checklist, signed
acceptance record. Historical evidence and both failed-round reports remain
untouched.

**M0 PASS conditions (unchanged, U9):** G1–G8 over the designated store under
the frozen criteria + §K/§M pass + the signed final acceptance record. The
addendum's §5 signature must be supplied by the owner (blank today). M1
unlocks only at M0 ACCEPTED.

## 5. Prioritized A.P.E.X implementation roadmap (from code inspection)

**Verified present:** Phase-1 M0 implementation complete (`stark/src/phase1/`:
harness, record store, gates G1–G7, baselines, tests 5/5 passing — acceptance
pending the G7 issue only); SNN core primitives `stark/src/neural/`
(`NeuralCell`, `Synapse`, `Network`) with tests (`test_neuron/network/synapse/
homeostasis/params/integration`); `stark/src/experiment/` (`Experiment`,
`Recorder`); design decisions in `stark/design/` (V008.1 architecture gate,
learning/serialization/homeostasis decision docs).
**Verified absent (grep + directory survey):** neural runtime loop,
learning/plasticity integration, persistent memory/consolidation, world
model/predictive processing, cognitive controller / executive control /
global workspace, adaptive attention, local UI/offline integration.

Dependency-aware order (shortest vertical slice first):

1. **Close M0** (§4) — the foundation is only "verified" once acceptance flips.
2. **Vertical slice — "perceive → predict → act → consolidate" on one toy
   environment**: wire `NeuralCell`/`Synapse`/`Network` + learning rules
   (per `learning_decision.md`) into a runtime loop that adapts within-episode
   and logs via `Recorder`. This single slice demonstrates genuine end-to-end
   cognitive behavior and forces the runtime + plasticity interfaces into
   existence.
3. **Persistent memory + consolidation**: serialize network + experience
   traces (per `serialization_decision.md`), offline consolidation pass
   (replay/merge), recall API. Depends on 2.
4. **World model + predictive processing**: predictive loop over memory traces;
   prediction error drives learning (depends on 3).
5. **Cognitive Controller + Executive Control + global workspace**: policy
   arbitration over reactive/planning modes (depends on 2–4).
6. **Adaptive attention + internal-state monitoring** (depends on 5).
7. **Local UI + offline integration** (depends on 3–6).
8. **End-to-end tests on the target laptop** (the acceptance machine class
   from §4) — full regression + M1 deliverables per the U10 scope statement.

## 6. Acceptance criteria and commands for the next authorized action

- **If the §3 diagnostic is authorized:** commands exactly as in §3; success =
  telemetry/schedule logs + per-sample timestamps complete; output = H1/H2
  confirmed or measurement-path residual; store labeled DIAGNOSTIC.
- **If a new acceptance machine is designated:** campaign procedure as in §4;
  acceptance = production evaluator G1–G8 PASS over that machine's designated
  store + §K (5/5) + §M + manual G8 + owner-signed acceptance record.
- **If the §3 approval is granted verbatim**, no other scope changes.

## 7. Status discipline

M0 remains **FAIL**; M1 remains **LOCKED**; the addendum remains **unsigned**;
nothing in this report constitutes acceptance. Facts §2.1 and hypotheses §2.2
are separated deliberately; no causation is claimed beyond the sample-level
plateau fact.
