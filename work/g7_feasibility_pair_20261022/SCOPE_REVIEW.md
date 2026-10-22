# APEX M0 — G7 Evidence Handoff & Read-Only Acceptance-Scope Audit

Date: 2026-10-22 (Asia/Calcutta) · Review type: read-only (no benchmarks, no
source changes, no frozen-logic changes, no M0/M1 status change)

## 0. Evidence branch and commit

- **Requested:** a dedicated new evidence branch. **Deviation (platform
  constraint, disclosed):** this Arena session is pinned to branch
  `arena/ae9d3c5a-a-p-e-x` and cannot create or push any other branch. The
  evidence package is therefore published as **dedicated, self-contained
  commit(s) on `arena/ae9d3c5a-a-p-e-x`** (PR #1), with all prior history
  preserved (no rewrites). The two session commits are separable from upstream
  `main` by cherry-pick if a standalone evidence branch is wanted later.
- Pre-handoff commit (evidence payload, incl. store/records/logs/REPORT):
  `6d98b2e` ("G7 reproducibility feasibility pair: pre-registered two-pass
  campaign, G1-G7 PASS").
- **Evidence-package commit SHA:** `e41247e9370fc8330ffc9d16f18b949241f40c73`
  ("Evidence package: manifest, reproducibility instructions, read-only
  acceptance-scope audit") — the commit that introduces this file on
  `arena/ae9d3c5a-a-p-e-x`. The follow-up SHA-recording commit (this edit) is
  reported in PR #1 and the handoff message.
- Package contents + hashes: `MANIFEST.md`, `MANIFEST.sha256`.
  Reproduction: `REPRODUCE.md`. Feasibility result: `REPORT.md`.
  Pre-registration: `PREREGISTRATION.md` (written before any build/run).

---

## 1. Acceptance-scope audit — the eight questions

Convention: **[SPEC]** = frozen specification text (`stark/design/V009_phase1_M0_specification.md`
= V009) or the current acceptance report (`stark/reports/M0_FINAL_ACCEPTANCE.md`
= ACC). **[IMPL]** = production code behavior. **[INF]** = inference, labeled.
No question is resolved in favor of a pass where the record is silent.

### Q1. Is Linux Xeon an authorized acceptance machine?

- [SPEC] V009 L111–113 names hardware only for workload sizing: "Sizes chosen to
  complete in seconds on an i5-12450H / RTX 2050." V009 G2 (L323) requires "a
  second independent run **on the same machine**" — machine-relative, not
  machine-fixed. Record schema (V009 L299–307) embeds a live
  `StaticHardwareProfile` "at run time — never referenced by name only". The
  implementation exit criteria (V009 L483–484) say "`aggregate.cpp` reports
  G1–G8 pass **on this machine**".
- [SPEC] ACC Q5 (L28–31): "The frozen acceptance scope is **the current
  machine's** verification run"; ACC Q8 (L38–45) requires "a **current-machine**,
  same-configuration baseline campaign … include the **current-machine** PROFILE".
- [IMPL] G1 (gates.cpp L476–511) validates whichever machine's profile the
  record embeds; no machine allowlist exists anywhere in the gate code.
- **Verdict: UNDETERMINED.** No frozen text authorizes or forbids a specific
  machine, OS, or CPU. "The current machine" (ACC) is never defined as either
  the original Windows/MSVC box or any later host. Accepting the Linux Xeon
  sandbox as the acceptance machine is a **scope decision reserved to the M0
  acceptance authority**; it cannot be inferred from the documents. [INF] The
  historical evidence (archive_recovery) was produced on Windows/MSVC; the spec
  references an i5-12450H/RTX 2050 target; this sandbox differs from both.

### Q2. Are single-thread-only results sufficient?

- [SPEC] V009 L111: "CPU thread count pinned (**single-thread AND all-core
  variants**)" — explicit: the suite includes both variants.
- [SPEC] ACC Q8 (L40–42): "pinned/**recorded** affinity".
- [IMPL] The pair ran one variant only (`--threads 1`, single-thread). The
  all-core variant was not run (pre-registered as out of scope for feasibility).
  [IMPL] `thread_count` is policy metadata, not an OS guarantee
  (BenchmarkHarness.h L60–64: "thread_count remains a policy field; it is NOT an
  OS affinity guarantee"); `run_baseline` never populates affinity anywhere —
  `make_benchmark_record`'s configuration block (BenchmarkHarness.cpp L251–262)
  sets benchmark_id/warmup_count/measurement_count/thread_count/batch_size/
  sequence_length/workload_params and **no `affinity` key**, although the frozen
  schema requires `configuration: {…, thread count, affinity, …}` (V009 L302).
  `apply_campaign_affinity` exists (BenchmarkHarness.cpp L128) but is called
  only by `campaign/G7Campaign.cpp` (L169/218/271) — the G7CAM path that this
  task forbids. OS pinning was external (`taskset -c 0`, logged in runs.log).
- **Verdict: NOT SUFFICIENT (explicit).** All-core variant missing against
  V009 L111's AND. Separately, "recorded affinity" is unsatisfied at record
  level (schema field absent from produced records) — a production-path gap,
  not a run error.

### Q3. Is excluding E3 permitted?

- [SPEC] V009 §E table L282–286: E3 INT8 — "**CPU path always**"; E4 —
  "**optional** … otherwise `status: not_attempted`". E5 (L286) = "E1–E3 forced
  to CPU-only build/run … always".
- [SPEC] V009 §8 implementation prompt L479–480: "**Do not implement E2/E3/E4
  or any GPU benchmark unless CUDA is present; record them as
  skipped/not_attempted otherwise.**" §I L363–364 also lists E2/E3/E4 under
  "optional CUDA build path".
- [SPEC] The frozen text **contradicts itself** on E3 ("CPU path always" vs
  "do not implement unless CUDA"). ACC is silent on E3.
- [IMPL] This package ran no E3 and recorded **no E3 disposition record at all**
  (E2 and E4 have disposition records; E3 has none). Pre-registered rationale:
  no G1–G8 gate requires an E3 record, and the project's own gold set
  (`stark/reports/v2.3/evidence/v23-valid/`) omits E3. [IMPL] Note: an E3 record
  would carry `benchmark_id:"B6"` with an identical configuration block and
  join the B6 G7 group (make_benchmark_record keys groups purely by
  configuration; gates.cpp L748–766).
- **Verdict: EXCLUDING E3 EXECUTION is defensible under V009 L479 (no CUDA
  here), but EXCLUDING AN E3 DISPOSITION RECORD is a gap** — L479–480 requires
  "record them as skipped/not_attempted otherwise", which the package does not
  satisfy for E3 (it does for E2/E4). The table/prompt contradiction itself is
  an unresolved scope decision. Not interpreted in favor of a pass.

### Q4. Required baseline for B1/B2/B3 — can first-pass results serve as the recorded baseline?

- [SPEC] G7 (V009 L328): "Full re-run of the same suite with same config: every
  benchmark median within ±15% of **the recorded median** …". The text presupposes
  a recorded median but does not prescribe when it must have been recorded, nor
  a registration procedure. [SPEC] ACC §3 (L128–140): "A **new baseline is
  permitted** by the frozen mechanics (§B: n≥10 configurable, ≥3 warmup,
  pinned/recorded affinity) **as new evidence**; §F keeps records append-only, so
  it is a supplement, never a replacement". ACC Q8 (L38–45) asks for a campaign
  "whose medians all fall within ±15% (±20% bandwidth)".
- [IMPL] G7 (gates.cpp L772–897) has no external baseline table: it groups
  same-configuration PASSED records (kind benchmark/baseline) and requires
  ≥2 distinct record_ids per group, then all-pairs symmetric |a−b|/max ≤ 15%
  (20% for B3/B5, L863–864). A two-run group therefore compares run 1's stored
  median against run 2's — first-pass-as-baseline is the implementation's only
  mechanism. B1/B2/B3/B6/B7/B9 have no prior recorded baselines anywhere in the
  repo (verified across all 616 STARKP1 records; the historical nine cover only
  B6/B7/B9 and permanently fail G7-C per ACC L31–37).
- **Verdict: PERMITTED for G7 as implemented, and sanctioned as "new evidence"
  by ACC §3 — but only for the evaluated store.** Residual risk: G7's "full
  **re-run**" wording could be read to require the baseline pass to be formally
  designated before the re-run; this pair was pre-registered (PREREGISTRATION.md)
  before any run, which satisfies process-intent but is not a frozen-text
  requirement. If the authority requires previously-established baselines, B1/
  B2/B3 have none and would need a designated baseline run first.

### Q5. Does G7 compare the correct records/configurations, and does the pair satisfy the actual implementation?

- [IMPL] Traced through call sites: `aggregate.cpp` L88 `evaluate_gates(records)`
  → gates.cpp G7 block (L772–897). Record filter: `status == PASSED`,
  `kind ∈ {benchmark, baseline}`, non-empty `configuration.benchmark_id`
  (L790–799); evidence checks: ≥10 finite raw samples, stored median vs
  recomputed median within `G7_MEDIAN_TOLERANCE_PCT = 0.001` **%** (L25 — the
  internal integrity rule, NOT the G7 tolerance; `verify_median_consistency`
  L68–97); grouping key = full `configuration` JSON dump (not experiment_id);
  independence = distinct `record_id` (L831–838); all-pairs symmetric rel-diff
  with `allowed = bandwidth ? 20.0 : 15.0` for `bench ∈ {B3,B5}` (L863–864).
- [IMPL] The pair satisfies this implementation: 6 groups (B1×2, B2×2, B3×2,
  B6×4, B7×4, B9×4), worst all-pairs 11.62% (B9) < 15%; B3 median-time pair
  1.70% < 20%; determinism triple: `outputs_bit_identical=true` on all 8
  CPU-FP32 deterministic-mode B6/B9 records (G7 rev-1.1 clause, V009 L328);
  aggregator exit 0 plain and `--strict` (logs/aggregate_output.txt).
- [SPEC vs IMPL — divergences, none changeable (tolerances frozen)]:
  (a) Spec says "memory bandwidth ±20%" — a bandwidth quantity; implementation
  applies 20% to the **timed median** of B3 and also grants it to B5 (PCIe),
  while `measured_memory_bandwidth_gbps` is never gated. (b) G7 requires "every
  benchmark median" — but the evaluator only checks groups that exist
  (`any_group` ≥1, L887–890); a store missing benchmarks passes G7. Suite
  completeness is not enforced by any gate (G8's record rule is manual, Q6).
  (c) G2's spec clause "median latency within ±15% of the median of a second
  independent run" (V009 L323) is **not implemented in G2** (gates.cpp L513–555
  checks only presence/distinctness/≥10 samples); the ±15% lives in G7 groups.
- **Verdict: YES for the implementation as written (verified); the pair passes
  it. The spec/implementation divergences (a)–(c) are unresolved interpretation
  items, not defects of this run.**

### Q6. Exact G8 requirement — manual inventory vs production-enforced PASS

- [SPEC] G8 (V009 L329): "`build/results/` contains a machine-readable record
  (JSON, `STARKP1 1`) for every executed benchmark/baseline and every profiler
  capture, **parseable by the same reader used in tests**." [SPEC] §K L406 maps
  G8 to `test_phase1_records.cpp` ("serialize→deserialize round-trip preserves
  all fields bit-exact; schema_version enforced; append-only store rejects
  schema mismatch"). [SPEC] §8 exit criteria L483–484: "all Phase-1 tests pass
  … and `aggregate.cpp` reports **G1–G8** pass".
- [IMPL] `gates.cpp` emits exactly seven gates (labels at L477, 514, 557, 616,
  673, 711, 773 = G1–G7). **There is no G8 gate.** `aggregate.cpp`'s own header
  (L3–11) says "evaluates gates G1-G7". Production `aggregate` therefore cannot
  report G8 PASS; its "INVALID RECORDS" section only evidences parseability.
- [IMPL] Package placement: the 24 records are in
  `build/results-g7pair-20261022/`, **not literally `build/results/`** (V009
  L329). The fresh store was a deliberate, pre-registered choice: the default
  `build/results/` holds historical records, and `RecordStore::append`
  (ExperimentRecord.cpp L683–701) removes+renames — the fixed-id records
  (`P1-PROFILE-24-0`, `P1-TELEMETRY-24-1`, `P1-E2-skip`, `P1-B4-skip`,
  `P1-B5-skip`, `P1-E4-notattempted`) would have been **overwritten**
  (profiler_cli.cpp L16–21 generates deterministic ids).
- **Verdict: G8 is UNDETERMINED for acceptance.** Manual inventory of the new
  store passes (24/24 records present for every executed benchmark/baseline and
  the profiler captures; same `ExperimentRecord` reader parses all; 0 invalid).
  But: (1) no production-enforced G8 PASS exists anywhere (§8's "aggregate
  reports G1–G8" exit criterion is unmet by the production code itself);
  (2) literal `build/results/` placement is unmet; (3) the §K G8 test
  (`test_phase1_records` round-trip) was not executed in this campaign.
  Not interpreted in favor of a pass.

### Q7. Does exit 0 establish G1–G7 PASS, and what evidence establishes G8?

- [IMPL] Yes, for the evaluated store: `aggregate.cpp` L88 evaluates gates with
  the production seam, L97–105 returns 0 iff `all_gates_pass()` (and, with
  `--strict`, no invalid records). Logged: both invocations printed
  `G1..G7 [PASS]` and `OVERALL: PASS (0 gate(s) failed)`, exit 0. This is the
  same `evaluate_gates()` the tests call (gates.cpp header L3–6).
- Caveats that bound the claim: the PASS is (i) for these 24 records only;
  (ii) produced by the shimmed Linux build (portability adaptations recorded in
  `build_shim/PORTABILITY_DIFF.txt`; no gate/threshold/source change under
  `stark/src/`); (iii) subject to Q5(b): G7 does not enforce suite completeness.
- **G8 requires, per [SPEC] V009 L329 + §K L406:** (1) one record per executed
  benchmark/baseline and per profiler capture — satisfied by manual inventory of
  the new store; (2) placement in `build/results/` — unmet (see Q6);
  (3) parseability "by the same reader used in tests" — supported by
  aggregate's loadAll/validate (0 invalid) but the referenced **tests
  (`test_phase1_records` round-trip, schema enforcement) were not run**; the
  §8 exit criterion "all Phase-1 tests pass" is likewise unevidenced here.
- **Verdict: exit 0 = G1–G7 PASS (bounded, verified). G8 = manual inventory
  only; production-enforced G8 does not exist.**

### Q8. Which requirements remain unsatisfied for formal M0 acceptance?

1. **Machine scope** (Q1): authority must designate the acceptance machine.
2. **All-core variant** (Q2): explicitly required by V009 L111; not run.
3. **Recorded affinity** (Q2/Q4): `configuration.affinity` absent from records
   (V009 L302; ACC Q8 "pinned/recorded affinity") — production-path gap.
4. **E3 disposition record** (Q3): required by V009 L479–480
   ("record them as skipped/not_attempted otherwise") but absent; E3
   execution scope itself is spec-contradictory and needs a ruling.
5. **Acceptance-store composition** (Q5/Q4): ACC §3 L128–131 — "the historical
   nine are in scope **if they are in the acceptance store** — and they fail
   permanently (G7-C)". Whether the acceptance store is (a) this current-machine
   set alone, (b) merged with historical records (then G7 stays FAIL forever),
   or (c) something else, is undecided and decisive.
6. **G8 formalization** (Q6/Q7): literal `build/results/` placement;
   `test_phase1_records` (and the full §K suite + §M audit) executed;
   production `aggregate` reporting G1–G8 (§8 L483–484) — code gap in the
   production evaluator itself, not in the run.
7. **"Independent runs" definition** (ACC Q8 L39): this pair = two process
   invocations in one session; whether acceptance requires separate
   sessions/days is unspecified.
8. **Spec/implementation tolerances** (Q5): B3/B5 20% applied to time medians,
   B5 included, bandwidth value ungated; G2's ±15% clause not in G2's
   implementation. Thresholds are frozen — these are documentation/ruling
   items, not change items.

---

## 2. G1–G8 pass/fail/undetermined matrix (this evidence package)

| Gate | Spec anchor | Verdict for this package | Basis |
|---|---|---|---|
| G1 | L322 | **PASS** | PROFILE record PASSED; aggregator G1 PASS (logs/aggregate_output.txt). Scope: profile of the sandbox machine (see Q1) |
| G2 | L323 | **PASS (as implemented)** | E1+E5 present, distinct, ≥10 samples; the ±15% clause is enforced via G7 groups (satisfied). Implementation of G2 itself omits the ±15% clause (Q5c) |
| G3 | L324 | **PASS** | No-CUDA branch; E2/B4/B5 SKIPPED with structured attestations validated by gates.cpp `validate_no_cuda_skip` |
| G4 | L325 | **PASS** | Every PASSED baseline's peak block validated (RAM measured via getrusage; VRAM unavailability corroborated by `hardware.cuda_available=false`) |
| G5 | L326 | **PASS** | All accounting records pass component/identity checks |
| G6 | L327 | **PASS** | Synthetic over-budget self-test deterministic and correct |
| G7 | L328 | **PASS for the evaluated store; UNDETERMINED for acceptance scope** | Aggregator exit 0; worst all-pairs 11.62%/15%; determinism clause satisfied. Scope items Q1/Q2/Q4/Q5 unresolved; suite completeness not enforced by G7 itself |
| G8 | L329 | **UNDETERMINED** | Manual inventory passes (24/24, 0 invalid, same reader); no production evaluator exists; `build/results/` literal placement unmet; §K G8 test not run |

**Overall: M0 is NOT accepted by this report.** Nothing here changes M0 (FAIL)
or M1 (LOCKED). Per Q5(b)/Q6, a bare "aggregate exit 0" is not by itself a
complete G1–G8 acceptance proof.

## 3. Unresolved acceptance-scope decisions (for the authority)

D1. Acceptance machine: Linux Xeon sandbox vs original Windows machine vs "any
    machine with a valid PROFILE". (Q1)
D2. Suite configuration scope: single-thread only, or §B's "single-thread AND
    all-core variants" both. (Q2)
D3. E3: execution required or not (spec self-contradiction), and the mandatory
    disposition record. (Q3)
D4. Acceptance-store composition: current-machine set alone vs including the
    historical nine (which fail G7-C permanently). (Q4/Q5)
D5. G8 evidence procedure: which store path, which tests (§K suite, §M audit),
    and whether the production evaluator must be taught to report G8. (Q6/Q7)
D6. "Independent runs" formal definition. (Q8.7)
D7. Disposition of the B3/B5 tolerance semantics (time-median vs bandwidth) —
    note/rule only; thresholds frozen. (Q5)
D8. Disposition of `configuration.affinity` absence in the production path.
    (Q2)

## 4. Single next action required for formal M0 acceptance

**Submit this evidence package and obtain a binding acceptance-scope ruling from
the M0 acceptance authority on D1–D8.** Every remaining work item (all-core
variant, E3 disposition, store composition, G8 test evidence, possibly a
re-run on a designated machine) is downstream of that ruling; running anything
before it risks repeating measurements under a scope that gets rejected. Per
this task's stopping rule, no further benchmarks are run and no M0/M1 status is
changed.

---

## 5. Verified vs inferred

Verified by command output in this session: aggregator outputs and exit codes,
record contents/counts, medians and all-pairs deviations, determinism triples,
raw-sample integrity, file hashes (MANIFEST.sha256), git state, exact spec/
source/acceptance line citations above. Inferred (labeled [INF] inline):
machine-authority intent; MSVC's historical overload choice; cache-warmth
equivalence of the B7 blob across passes; any reading of "the current machine"
that favors one host over another.
