# Phase 27 — Phase 26 Protocol Consistency Audit

**Status:** read-only design-review audit  
**Created artifacts:** only this report  
**Decision:** `READY FOR USER AUTHORIZATION`

---

## 0. Purpose

This audit reads the actual Phase 26 protocol, Phase 25 design, Phase 19 runner, Phase 19 validator, diagnostic source, and relevant Phase 23–24 evidence, and checks whether the Phase 26 protocol is internally consistent with the artifacts it claims to build on. It does not run any measurement, build, or modification. It checks arithmetic, semantics, ordering, affinity, cache policy, validation/stopping behavior, and evidence integrity.

---

## 1. Actual Git state and evidence state at audit time

### 1.1 Git state

Recorded directly from the repository at audit time:

- Branch: `main`
- HEAD: `acd85db110f06d7611bcee3b894fc93737a19ef6`
- Upstream: `origin/main` (`refs/heads/main`)
- Local vs upstream: local HEAD is at or ahead of upstream (`merge-base --is-ancestor HEAD origin/main` is true)
- `git status --porcelain`:

```
?? stark/nul
```

- Recent log top-4:

```
acd85db (HEAD -> main, origin/main, origin/HEAD) a
9795c35 w
d9911e8 w
50dd636 w
```

### 1.2 Interpretation

- The working tree is clean except for the pre-existing untracked `stark/nul`, preserved as required.
- HEAD moved again since Phase 26: Phase 26 recorded `9795c35…`; this audit reads `acd85db…`. Branch tips are recorded for provenance only; the frozen hashes remain the authoritative anchors.
- No commit in the inspected recent log corresponds to Phase 27 work; this audit is a new read-only artifact.

### 1.3 Evidence hashes re-checked before writing this audit

- Phase 26 protocol: `1343ad6529b1…`
- Phase 25 design: `86d69ffa26a4…`
- Phase 19 runner: `21b51e4592b1…`
- Phase 19 validator: `6285cc12bd03…`
- Phase 23 report: `34045b5d6844…`
- Phase 24 audit: `e441c615e809…`
- Diagnostic source: `aeb31eb2…` — prefix OK
- CMake configuration: `575fe264…` — prefix OK
- Benchmark harness source: `1b37e95f…` — prefix OK
- Phase 19 plan: `1451f1cb…` — prefix OK
- Phase 22 report: `e6ea3fa1…` — prefix OK

In the terminology of the prior audits, the Phase 16 deliverable CSV and the historical frozen CSV remain missing on the audited paths, and the frozen executable `86ee9f3e…` remains evidenced on the `vs2019b` path.

---

## 2. Exact run topology: definitions and arithmetic

### 2.1 Definitions used by the protocol

The protocol should be read with these definitions, each tied to the actual implementation it claims to use:

- **One process launch:** one child process created by the Phase 19 runner's `launch_suspended()` and executed under one affinity context. For the pinned context, the runner creates the child `CREATE_SUSPENDED`, applies `SetProcessAffinityMask` while suspended, reads back the mask with `GetProcessAffinityMask`, verifies it before resuming, resumes, and later reads the mask again after resume and at exit.
- **One macro-replicate:** one entry from the diagnostic's `build_schedule()` in `bm_b7_diagnostic.cpp`. Each schedule entry produces two macro-replicates inside one process launch: one `MINIMAL` and one `INSTRUMENTED`, executed sequentially and process-locally. The order of the two within the launch is determined per entry by `entry.minimal_first`.
- **One measured iteration:** one call of either `minimal_op()` or `instrumented_op()` inside a `run_replicate()` measured loop, bracketed by the independent outer timer `tA/tB` in `run_replicate()`.
- **One run (protocol sense):** one process launch containing `macro_replicates_per_condition` schedule entries, therefore `2 * macro_replicates_per_condition` macro-replicates, each with `measurement_count` measured iterations.

### 2.2 Arithmetic for the protocol's chosen parameters

The protocol sets:

- `measurement_count = 50`
- `macro_replicates_per_condition = 8`

Therefore, per process launch:

- schedule entries = 8
- macro-replicates total = 8 MINIMAL + 8 INSTRUMENTED = 16
- measured iterations total = 16 * 50 = 800

This arithmetic matches the protocol's stated "800 measured iterations per run." The protocol's decomposition of 16 macro-replicates into 8 per condition is internally consistent with `macro_replicates_per_condition = 8`.

### 2.3 Process launches, CSVs, and artifact directories

The protocol specifies **two affinity contexts**, Context A unpinned and Context B pinned. If both are executed under the chosen per-run parameters, a faithful execution plan needs **two process launches**:

- Launch 1: Context A, 8 schedule entries, 16 macro-replicates, 800 measured iterations.
- Launch 2: Context B, 8 schedule entries, 16 macro-replicates, 800 measured iterations.

The protocol says "two affinity contexts" but does not state in §6 whether a single process launch can cover both. It cannot, because a single process launch is created under one affinity mask. So the consistent reading is that Context A and Context B are two separate process launches.

Thus the minimum consistent topology for **one state context** is:

- 2 process launches
- 2 host-captured `paired_samples.csv` files, one per launch
- 2 `ops/` directories, one per launch
- and, if each launch gets its own run directory under the protocol's isolated root, 2 run directories.

If the protocol also intends a state-context contrast, for example warm vs attempted-cold, the topology multiplies by the number of state contexts actually executed. The protocol's §6.5 specifies two state contexts as a possibility, but does not fix the exact executed set. This audit records that as an open protocol parameter: the protocol fixes the per-launch topology precisely, but does not fix the final cross-product of affinity contexts × state contexts × repeated runs.

### 2.4 Where the "800" comes from, line by line

- `macro_replicates_per_condition = 8` → 8 minimal macro-replicates + 8 instrumented macro-replicates.
- Each macro-replicate is one `run_replicate()` call with `measurement_count = 50` iterations.
- So one instrumented macro-replicate contributes 50 instrumented iterations; one minimal macro-replicate contributes 50 minimal iterations.
- 8 minimal macro-replicates → 400 minimal iterations.
- 8 instrumented macro-replicates → 400 instrumented iterations.
- 400 + 400 = 800 measured iterations per launch.

This is a clean match. No arithmetic contradiction was found in the protocol's stated numbers.

---

## 3. Counterbalancing and order/condition separability

### 3.1 What the protocol claims

The protocol claims a counterbalanced alternating schedule extended to 8 replicates:

- even replicate indices run MINIMAL first, then INSTRUMENTED;
- odd replicate indices run INSTRUMENTED first, then MINIMAL;
- executed order recorded verbatim per replicate.

### 3.2 What the source actually provides

The diagnostic source in `bm_b7_diagnostic.cpp` contains `build_schedule()` and uses it in `run_bm_b7_diagnostic()`:

```text
const auto schedule = build_schedule(proto.macro_replicates);
for (const auto& entry : schedule) {
    const Mode first =
        entry.minimal_first ? Mode::MINIMAL : Mode::INSTRUMENTED;
    const Mode second =
        entry.minimal_first ? Mode::INSTRUMENTED : Mode::MINIMAL;
```

and `build_schedule()` is described in the source as:

```text
/// Counterbalanced: even replicate indices run MINIMAL first, odd indices run
/// INSTRUMENTED first, so with the default (even) macro-replicate count each
/// condition appears equally often in each execution position.
```

The source therefore implements **exactly** the protocol's claimed counterbalancing rule, and it does so generically for any `macro_replicates` value, including 8.

### 3.3 One important clarification the protocol should make explicit

The existing `build_schedule()` counterbalance is over **replicate index within one launch**, not over condition across launches. That means:

- Within one process launch, the first/second position is balanced across MINIMAL and INSTRUMENTED.
- The protocol's two affinity contexts are separate launches, so affinity is not counterbalanced with first/second position inside a single launch; affinity is a between-launch factor.

This is not a contradiction in the protocol; it is a scope clarification. The protocol's §6.3 describes within-launch order counterbalancing correctly, but it should not be read as implying that affinity context is itself counterbalanced with order inside a launch.

### 3.4 Can the analysis distinguish condition effects from order effects?

Yes, with the recorded executed order and the replicated structure. Because:

- the first/second position is balanced across the two conditions within a launch,
- each macro-replicate is separately timed and recorded,
- and each launch's executed order is recorded verbatim,

the analysis can separate:

- condition effects: MINIMAL vs INSTRUMENTED means/medians/overheads,
- order effects: first-position vs second-position position effects within a launch,
- and residual launch-level effects.

What the protocol does **not** provide is full counterbalancing across affinity contexts within a single launch, because affinity is a between-launch factor. That is fine as long as it is stated; it just means affinity effects and order effects are not fully crossed inside one launch.

**Audit conclusion on counterbalancing:** the protocol's description matches the source, and order/condition separability is achievable. The only correction is that affinity context is between-launch, not within-launch.

---

## 4. Timing semantics: mapping proposed components to source

### 4.1 Existing instrumented boundaries in source

`instrumented_op()` in the diagnostic source is:

```text
void instrumented_op(const std::string& path, TinyDenseModel& loader,
                     ComponentTimings& t) {
    const auto t0 = Clock::now();
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open weight blob");
    const auto t1 = Clock::now();
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)),
                               std::istreambuf_iterator<char>());
    const auto t2 = Clock::now();
    loader.deserializeWeights(bytes);
    const auto t3 = Clock::now();
    t.open_sec = duration(t1 - t0);
    t.read_sec = duration(t2 - t1);
    t.deser_sec = duration(t3 - t2);
    t.residual_sec = 0.0;
}
```

and in `run_replicate()`, the outer total is:

```text
const auto tA = Clock::now();
if (mode == Mode::INSTRUMENTED)
    instrumented_op(blob_path, loader, comp);
else
    minimal_op(blob_path, loader);
const auto tB = Clock::now();
total_sec = duration(tB - tA);
```

So the existing buckets are:

- `open_sec` = `t1 - t0`, which includes `ifstream` construction and the open-failure check.
- `read_sec` = `t2 - t1`, which is the iterator fill.
- `deser_sec` = `t3 - t2`, which is `deserializeWeights(bytes)`.
- `residual_sec` = `total_sec - (open_sec + read_sec + deser_sec)`, filled after the call.

### 4.2 Mapping the protocol's proposed finer components

The protocol proposes:

1. `open_pre_stream_sec`
2. `open_post_check_sec`
3. `read_traversal_sec`
4. `deser_call_sec`
5. `instrument_clock_overhead_sec`

Maps to source:

- `open_pre_stream_sec` should map to a clock read before `std::ifstream f(...)` construction and a clock read after construction but before the `if (!f)` check.
- `open_post_check_sec` should map to after the `if (!f)` check to just before `t1`/iterator fill.
- Together, `open_pre_stream_sec + open_post_check_sec` must equal the existing `open_sec` semantics.
- `read_traversal_sec` should equal the existing `read_sec` in this protocol — the iterator fill between `t1` and `t2`.
- `deser_call_sec` should equal the existing `deser_sec` — `deserializeWeights(bytes)` between `t2` and `t3`.
- `instrument_clock_overhead_sec` is the new descriptive estimate of the extra clock-read cost of the finer instrumentation.

This mapping is consistent with the source. No proposed component is unattached.

### 4.3 Additive ownership and total preservation

The protocol states that all new components are additive and that:

```text
residual_sec = total_sec - (open_sec + read_sec + deser_sec)
```

must remain true for the existing grain.

For the finer decomposition, the protocol must preserve:

```text
open_pre_stream_sec + open_post_check_sec == open_sec
read_traversal_sec == read_sec
deser_call_sec == deser_sec
```

and therefore:

```text
open_pre_stream_sec + open_post_check_sec + read_traversal_sec + deser_call_sec + residual_sec
== open_sec + read_sec + deser_sec + residual_sec
== total_sec
```

This is the exact additive ownership rule the audit requires. The protocol states it, and the source supports it. The only requirement for a faithful implementation is that any added clock reads for the finer buckets must not disturb this identity; if they do, the identity must be re-derived explicitly and recorded.

### 4.4 Preservation of frozen calibration formulas and thresholds

The existing validator hard-codes:

- `EXPECTED_REPLICATES = 6`
- `EXPECTED_MEASUREMENTS = 50`
- `EXPECTED_ROWS = 300`
- header `["replicate", "iteration", "minimal_sec", "instrumented_sec", "signed_overhead_pct"]`
- frozen formulas:
  - `signed_overhead_pct = 100*(instrumented_sec - minimal_sec)/minimal_sec`
  - `mean_overhead_pct = 100*(fmean(instr) - fmean(min))/fmean(min)`
  - `worst_case_overhead_pct = max over aligned pairs of 100*(instr-min)/min` (signed, unclamped)
  - `median_deviation_pct = 100*|median(instr) - median(min)|/median(min)`
- frozen thresholds: mean `2.0`, worst `10.0`, median deviation `2.0`

The protocol does not modify these in the existing validator. It acknowledges that for an 8-replicate protocol the existing `EXPECTED_REPLICATES = 6` and `EXPECTED_ROWS = 300` would not match the new grain. This is an important correctness point: the protocol cannot claim the existing validator runs verbatim on the new 8×50 grain without either a documented constant change or a separate validator profile. The protocol's §10.1 and §11.1 hint at this, but the audit finds it worth stating bluntly: **the existing validator constants are tied to the existing 6×50 grain, not the proposed 8×50 grain.**

That is not a flaw in the protocol; it is a required implementation note. If a future run uses 8 replicates, the frozen-grain validator profile used for that run must reflect 8 replicates and 400 rows per condition, and that change must be recorded as part of the run manifest.

The frozen formulas and thresholds themselves are preserved by the protocol. The protocol does not redefine them.

---

## 5. Instrumentation overhead: exact comparison

### 5.1 The exact comparison the protocol implies

The protocol specifies three reference points:

- minimal condition
- existing instrumented condition
- finer instrumented condition

The exact overhead comparison the audit requires is:

- **Existing instrumentation overhead** = effect of existing instrumented condition vs minimal condition. This is already what the existing calibration measures.
- **Finer instrumentation overhead** = effect of finer instrumented condition vs existing instrumented condition, holding the operation constant.

The protocol's §5.1 says finer instrumentation must report its additional clock cost relative to the existing instrumented condition. That is the correct comparison.

### 5.2 Why this matters

A common mistake would be to compare finer instrumented vs minimal and call that the "finer instrumentation overhead." That conflates two things: existing instrumentation overhead plus finer instrumentation overhead. The audit requires the cleaner two-step comparison:

1. existing instrumented vs minimal → existing overhead
2. finer instrumented vs existing instrumented → additional overhead of the finer instrumentation

If the protocol's finer grain is implemented, the analysis must report both steps explicitly, because only the second step isolates the marginal cost of the extra clock reads.

### 5.3 Semantic-preserving requirement

The protocol correctly requires that the finer instrumented total still bracket the same operation and that the existing calibration still compare the existing grain. The audit agrees: as long as the finer grain is layered as an additive descriptive extension and does not change the existing outer total bracketing, the existing calibration semantics are preserved.

The audit's explicit requirement, restated sharply: **do not let the finer grain redefine the existing instrumented total.** If the finer grain changes the existing instrumented total, that change is itself evidence and must be reported, not absorbed silently.

---

## 6. Affinity contexts: verification against the runner

### 6.1 Context definitions

The protocol defines:

- Context A — unpinned: system mask.
- Context B — pinned: mask `0x1`, logical CPU 0.

The runner defines:

```text
PIN_MASK_DEFAULT = 0x1
```

and in `launch_suspended()`:

- if `mask is not None`, it applies `SetProcessAffinityMask(child, mask)` while the child is suspended,
- then reads back `pre_p` with `GetProcessAffinityMask`,
- then verifies `pre_p == expected`, fail-closed with `RuntimeError` if not,
- sets `affinity_verified_before_resume = True`,
- resumes the thread,
- reads `post_p` after resume and sets `affinity_drifted` if `post_p != pre_p`,
- later reads `post2_p` at exit and records `mask_observed_at_exit`.

The protocol's Context B is therefore consistent with the runner's existing enforcement primitive: pinned to `0x1`, verified before resume, drift-checked after resume and at exit.

### 6.2 Context A

Context A is the runner's unpinned path, where `mask is None` and the runner sets `expected = pre_s` (the system mask) and verifies the child's observed mask equals the system mask. The protocol's "system mask" wording matches that behavior.

### 6.3 Historical-equivalence caution

The protocol states it does not claim equivalence with historical in-process affinity. The audit agrees and reinforces:

- the runner applies affinity externally to a child process after `CreateProcessW(..., CREATE_SUSPENDED)`,
- the historical campaign's affinity was an in-process method under a different toolchain,
- so Context B is a current external whole-process mask, not a verified reproduction of the historical mechanism.

This is an honest distinction and should remain explicit in any future analysis.

### 6.4 One runner behavior worth noting for the protocol

The runner's precondition check requires:

- the wrapper itself not be pinned (`self_p != self_s` fails),
- and the requested mask to be inside the system mask.

So if the protocol is executed on a machine where the wrapper is itself constrained, the pinned context could be blocked at precondition time. That is a real environment dependence and should be part of any execution checklist, not assumed away.

---

## 7. Cache-state policy

### 7.1 Warm-cache as the primary baseline

The protocol's default posture is warm-cache, which matches the diagnostic source's own stated posture and the existing runner behavior. The audit agrees this is the correct primary baseline and that no cache flush is performed under it.

### 7.2 Attempted-cold requirements

The protocol requires that an attempted-cold contrast be:

- concretely described,
- pre- and post-captured with snapshots,
- and labeled attempted/unverified if no verifiable difference is captured.

The audit finds this consistent with the diagnostic source's honesty rule: no claim of cache-state control unless control is actually shown.

### 7.3 What "controlled" would require

If a future execution wants to claim cache state was controlled rather than merely warm, it would need evidence of a verifiable state difference between contexts, captured per run, not an intent statement. The protocol's language already points that direction; the audit endorses it and requires that any "controlled" label be backed by captured evidence.

---

## 8. Validation and stopping rules

### 8.1 Incomplete runs

If a process launch produces an invalid or incomplete result — for example an invalid replicate, missing CSV, or missing stdout — the protocol should record that run as failed/incomplete and not promote it to evidence. The protocol's §11.3 says as much. The audit agrees.

### 8.2 Missing stdout

If `stdout.txt` is missing or unreadable, the existing validator would miss the stdout cross-checks and record `stdout_available` false. The audit finds that behavior acceptable as a recorded gap, not a silent failure.

### 8.3 Invalid samples

If any sample is non-finite, non-positive, or violates the per-row formula, the existing validator marks those as failed checks. The protocol should not allow such a CSV to be treated as a valid frozen-grain artifact. The audit agrees.

### 8.4 Failed launches

If `launch_suspended()` raises, the runner's `do_run()` returns without producing the run artifacts. The protocol should treat that as a failed launch and record it, not retry silently into an existing directory. The protocol's failure handling is consistent with that.

### 8.5 Existing output directories

The runner's `do_run()` requires the host directory to be previously absent and fails closed otherwise. The protocol explicitly lists "target host-capture directory confirmed absent" as a precondition. The audit endorses that as the correct no-overwrite behavior.

### 8.6 No silent retries or overwrites

The audit's explicit requirement: no silent retry loops that overwrite an existing host directory or CSV. The runner's existing behavior supports this for the host directory; the protocol must ensure any wrapper around it keeps the same discipline.

---

## 9. Evidence integrity

### 9.1 Git and porcelain

At audit time:

- `main`, HEAD `acd85db…`, upstream `origin/main`, local at-or-ahead.
- `git status --porcelain`: only `?? stark/nul`.

### 9.2 Protected hashes

Re-checked before writing this audit:

- Diagnostic source `aeb31eb2…` — OK
- CMake `575fe264…` — OK
- Benchmark harness `1b37e95f…` — OK
- Phase 19 plan `1451f1cb…` — OK
- Phase 22 report `e6ea3fa1…` — OK
- Phase 23 report present
- Phase 24 audit present
- Phase 25 design present
- Phase 26 protocol present
- Phase 19 runner present
- Phase 19 validator present

No protected source/config/report artifact was found modified.

### 9.3 Missing artifacts and discrepancies

The same inherited gaps remain:

- Phase 16 deliverable CSV missing on the audited path.
- Historical frozen CSV missing on the audited path.
- Phase 16 stdout artifact absent, so the validator's stdout cross-checks cannot be re-exercised from the workspace.
- Frozen executable evidenced on the `vs2019b` path, not on the `vsc-direct` path.

No new discrepancy was introduced by the protocol. The only substantive issues are the inherited gaps and the protocol-level open parameter on the final cross-product of affinity contexts × state contexts × repeated runs.

---

## 10. Evidence integrity, M0/M1/G7, and constraint compliance

### 10.1 Git and porcelain

At audit time:

- `main`, HEAD `acd85db110f06d7611bcee3b894fc93737a19ef6`, upstream `origin/main`, local at-or-ahead.
- `git status --porcelain`: only `?? stark/nul`.

No staged changes were present; `git diff --stat --cached` returned clean.

### 10.2 Protected hashes re-checked before writing this audit

- Diagnostic source `aeb31eb2…` — OK
- CMake `575fe264…` — OK
- Benchmark harness `1b37e95f…` — OK
- Phase 19 plan `1451f1cb…` — OK
- Phase 22 report `e6ea3fa1…` — OK
- Phase 23 report present: `34045b5d6844…`
- Phase 24 audit present: `e441c615e809…`
- Phase 25 design present: `86d69ffa26a4…`
- Phase 26 protocol present: `1343ad6529b1…`
- Phase 19 runner present: `21b51e4592b1…`
- Phase 19 validator present: `6285cc12bd03…`

All present protected source/config/report artifacts were intact. No protected artifact was modified by this audit.

### 10.3 M0 and M1 under this audit

- M0 remains **FAIL**. This audit did not run any measurement and did not produce any new calibration evidence that could change the existing calibration outcomes.
- M1 remains **LOCKED**. This audit did not unlock it and did not change any classification logic or M0 state.

### 10.4 G7 and execution authorization

- No G7 campaign was run and no G7CAM record was created.
- This audit did not build, execute, or time the diagnostic, and it did not authorize any of those actions.
- This audit did not stage, commit, push, reset, clean, or discard any file.

### 10.5 Missing artifacts and discrepancies

The same inherited gaps remain and are recorded as gaps, not reconstructed:

- Phase 16 deliverable CSV missing on the audited path.
- Historical frozen CSV missing on the audited path.
- Phase 16 stdout artifact absent, so the validator's stdout cross-checks cannot be re-exercised from the workspace.
- Frozen executable evidenced on the `vs2019b` path, not on the `vsc-direct` path.

No new discrepancy was introduced by the protocol under audit.


1. **Topology arithmetic is consistent.** 50 × 8 × 2 = 800 measured iterations per launch; 16 macro-replicates per launch; 2 launches minimum for the two affinity contexts.
2. **Counterbalancing matches the source.** The diagnostic's `build_schedule()` implements the exact even/odd first-position rule the protocol cites, generically for 8 replicates. Affinity context is between-launch, not within-launch; that should be stated rather than implied.
3. **Timing semantics are mappable and additive.** The proposed finer components map cleanly onto `open_sec`, `read_sec`, `deser_sec`, and `residual_sec`, with explicit additive identities that preserve the existing total.
4. **Frozen calibration is preserved in intent, with one implementation caveat.** The formulas and thresholds are unchanged, but the existing validator constants are tied to the 6×50 grain; an 8×50 run needs a documented validator profile change or a separate profile.
5. **Instrumentation-overhead comparison is correctly specified as finer-vs-existing, not finer-vs-minimal.**
6. **Affinity contexts match the runner**, including verification-before-resume and drift checks, with an explicit no-claim of historical in-process equivalence.
7. **Cache policy is correct:** warm-cache baseline, attempted-cold only with captured evidence.
8. **Validation/stopping rules are consistent** with the runner and validator, including no-overwrite precondition behavior.
9. **Evidence integrity holds** for the present protected artifacts; inherited gaps remain as gaps.

---

## 11. Findings summary

## 12. Decision

The Phase 26 protocol is consistent with the actual source, runner, validator, and prior evidence, with the clarifications and caveats above. It is a sound design-review package, not an authorization to execute.

**Decision:** `READY FOR USER AUTHORIZATION`

This is a design-review decision only. It does not authorize building, executing, measuring, or modifying anything.
