# STARK-L11.2 — Instrumentation Implementation and Verification

**Status: IMPLEMENTATION BLOCKED BY AN UNRESOLVED AUTHORIZATION GATE.**
This milestone therefore delivered **read-only audit, feasibility verification and
an implementation-readiness package** — not an implementation.
**No source file, no harness file, no test and no build configuration was
modified.** No official L11 evaluation was run. Zero L11 trials were executed.

**Filename note.** The requested deliverable name is `L11_2_INSTRUMENTATION_
IMPLEMENTATION.md`. The name is kept for continuity, but the contents are an
implementation-*readiness* report, because §2 of the mission forbids implementing
instrumentation without authorization R3, and R3 is not recorded anywhere in the
repository.

---

## 1. Provenance and Git state

| Item | Value | Classification |
|---|---|---|
| Repository | `Rahulrr324/A.P.E.X` | VERIFIED (`git remote -v`) |
| Start branch | `validation/l11-1-specification` | VERIFIED |
| Start HEAD | `6a43974433a0396f756536817f88421eb86edf8c` | VERIFIED |
| Start working tree | clean (0 entries in `git status --porcelain`) | VERIFIED |
| Local == remote at start | remote `refs/heads/validation/l11-1-specification` = `6a43974…` | VERIFIED |
| L11.1 protocol hash | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` — matches the committed file (`sha256sum` of `stark/design/l11_1_protocol.md`) | VERIFIED |
| L11.1 preregistration | `work/L11_1_PREREGISTRATION.json` records the same hash and `frozen_at_commit = 77d261a…` | VERIFIED |
| PR #2 | OPEN, head `5f5a577…`, base `main` | VERIFIED (`gh pr list`) |
| PR #3 | OPEN, head `49cc6ba…`, base `arena/c90f7329-a-p-e-x` | VERIFIED |
| PR #1 | MERGED 2026-10-22 | VERIFIED |
| Clone depth | **shallow**, graft points `563395f…` and `5f5a577…` (`.git/shallow`) | VERIFIED |

**Shallow-clone limitation:** history before the two graft points is unavailable in
this workspace. No claim below depends on older history; every L10/L11 fact cited
was checked against files or objects present in this clone.

**Work branch:** `validation/l11-2-instrumentation-readiness`, created from
`6a43974` (the verified L11.1 seal). Because the implementation gate is closed,
the branch name says *readiness*, not *implementation*. Final state is reported in
§7.6 after the push.

---

## 2. Authorization decisions and scope

The mission defines three gates. Each was checked against the repository, not
against the mission text or any prior recommendation.

| Gate | Required for | Recorded in repository? | Evidence | Status |
|---|---|---|---|---|
| **R1** ratify L11-A…G | declaring acceptance criteria in force | **No** | `work/L11_1_PREREGISTRATION.json` says `"ratification": "PENDING_OWNER_DECISION"`; no file under `stark/reports/` was added after L10.5; `git log ba1cfb3..HEAD` contains only L11.1 documentation commits | **UNRESOLVED** |
| **R2** `test_phase1_affinity` port or Windows-only | applying the port | **No** | same; the L11.1 report only *proposes* the port | **UNRESOLVED** |
| **R3** authorise harness instrumentation | any source/harness change | **No** | `work/L11_1_SPECIFICATION_AND_INSTRUMENTATION.json` §governance lists R3 as `"blocking": true`; nothing authorises it. The absence of a prohibition is not an authorization (L10 precedent: owner decisions were asked separately and recorded) | **UNRESOLVED** |

**Consequence applied:** no source or harness file was touched. R1's thresholds
are **not** declared ratified and their values were not altered. R2's port was
diagnosed but **not applied**. Per §2 of the mission, no authorization was
inferred from the existence of the L11.1 branch, the pre-registration file, or any
previous recommendation.

**Exact decision needed to proceed with implementation:** an explicit owner
statement authorising R3 — the additive, default-off instrumentation described in
§3 and `work/L11_2_PREPARED_DIFF.md`, confined to
`stark/src/learning/l10_validation_harness.cpp` plus one CLI flag set, with
`ContextConditionedMemory.cpp` unchanged. R1 and R2 are needed for the *official
run* and for the regression gate, but they do not block writing instrumentation.

---

## 3. Source changes

**None.** `git status --porcelain` on the source tree is empty; `git diff` against
`6a43974` shows only new files under `work/`.

What exists instead is a **prepared, unapplied change description**:
`work/L11_2_PREPARED_DIFF.md`. It specifies the exact additions (≈180 lines, one
file), each with its anchor in the current source, and deliberately contains **no
engine changes**. Summary of the prepared change:

| # | Change | Anchor | Risk |
|---|---|---|---|
| P1 | `StreamSpec`: `bool emit_l11=false; std::string run_id, protocol_sha;` | struct at line ~145 | none (default-off) |
| P2 | `struct TrialRow11` + `std::vector<TrialRow11> rows11` in `StreamResult` | lines ~117–143 | memory only, populated only when enabled |
| P3 | capture block inside `evalTask`'s trial loop | `evalTask`, after `runCCTrial` | reads existing locals |
| P4 | capture block inside the training loop | `runStream`, after `runCCTrial` | reuses `w0`/`w1` copies the L10.1 telemetry already makes |
| P5 | `writeTrial11Csv(...)` → **separate file** `trials11_<tag>.csv` | new function | never touches the legacy writer |
| P6 | CLI: `--emit-l11`, `--run-id`, `--protocol-sha` (validated 64-hex) | `main`, arg loop at ~line 705 | aborts on malformed hash |
| P7 | `int intendedBankByRule(cue, n_tasks)` — R-majority, driver-side | new function | sees only the cue; no task identity, no leakage |
| P8 | `--dump-state <path>` writing `ccSerialize(ag)` at run start and after each task step | new | hashing is done **outside** C++, so no crypto code is added |

**Design decision worth recording:** instrumentation writes a **new file** rather
than appending columns to `trials_*.csv`. That makes the non-interference claim
stronger and cheaper to verify — the legacy artifact is not merely equal, it is
untouched — and it means `writeTrialCsv` needs no change at all.

---

## 4. Instrumentation coverage (audit result)

The L11.1 schema has 35 fields. Each was traced to the **actual execution path**
(`runCCTrial` → `CCResult` → `evalTask`/training loop → writers), not to the
schema's assumptions. Full matrix in
`work/L11_2_FIELD_PROVENANCE.md`; summary:

| Availability | Count | Fields |
|---|---|---|
| **Direct** from `CCResult` | 6 | `selected_bank`, `selected_slot`, `queried`, `choice`, `plastic_write`, `reward` |
| **Direct** from harness state/arguments | 11 | `arm`, `master`, `task`, `phase`, `trial`, `eval_call`, `eval_kind`, `cue_features`, `intended_slot`, `active_bank`, `bank_state` |
| **Derived** by the driver | 9 | `cue_id`, `cue_category`, `cue_modified`, `held_out`, `intended_bank`, `routing_correct`, `correct`, `scoring_window`, `advantage` |
| **Via existing public API** (`ccRouterWeights`, `ccBankWeights`) | 5 | `bank_score_margin`, `update_mass_intended`, `update_mass_other`, `router_update_l1`, plus `model_hash` input |
| **Operator-supplied** (must not be invented) | 3 | `run_id`, `protocol_sha256`, `checkpoint_id`/`resume_from_trial` (driver-level) |
| **Requires a change this milestone must not make** | 1 | the six new `cue_category` values (`CROSS21`, `CROSS31`, `AMBIG11`, `MISLEAD`, `ORDERPERM`, and `PARTIAL` reuse) — **these arms do not exist in the harness** |

### 4.1 Facts established by reading the source (VERIFIED)

1. **`CCResult.sel_slot` is set unconditionally** (`out.sel_slot = sel;` before
   bank selection), but `sel` is initialised to `-1` and only assigned in the
   **multi-candidate** branch. On single-candidate trials it is `-1`, which means
   **"not applicable", not "missing"**. Under the L11 schema it must be written as
   an explicit absence, never as `-1` or `0`.
2. `sel_slot` is the **sampled** channel (`sampled = (s.mech_u < a[0]) ? 0 : 1`),
   not the argmax — so even with learning disabled the attention selection is
   stochastic per trial. Recording it is meaningful; recording only the argmax
   would not be.
3. `queried` is the identity at the **intended** slot,
   `s.presented[map.phi[s.ctx]]` — *not* the identity at the selected slot. The
   record therefore also needs `presented[]` and `selected_slot` to reconstruct
   what was actually attended. `lr.presented` is available to the driver.
4. **`intended_bank` must be computed driver-side.** The engine receives the cue
   and must never see the task index (non-leakage is a stated L10 property), so the
   R-majority prediction belongs in the harness, computed from the cue alone.
5. **Score margin needs no new accessor**: `score[k] = Σ_{f∈cue} W[f][k]` is
   reproducible from `ccRouterWeights(agent)` (`bankScores` is private, the weights
   are public). Verified by probe (§4.2).
6. **Update mass needs no new accessor**: `ccBankWeights(agent)` returns
   `[bank][id][resp]`, and the harness already snapshots it before/after a trial in
   the L10.1 sealing telemetry.
7. **`advantage` requires a pre-trial baseline snapshot.** The baseline is updated
   *inside* `runCCTrial`, so reading `ag.reward_baseline` afterwards gives the wrong
   value. The harness must copy it before the call. Default
   `baseline_per_bank = false` ⇒ index 0 is the only one used.
8. **No SHA-256 implementation exists in the C++ sources.** Rather than add ~60
   lines of unvetted crypto, the prepared design dumps `ccSerialize(ag)` to a file
   at run start and lets the runner hash it.
9. **The legacy aggregate CSVs use `-1.0` as a "not measured" sentinel**
   (observed: `cross_novel = -1.000000` for a run with no cross arm). This is the
   anti-pattern the L11 schema forbids; L11 records must use explicit absence.

### 4.2 Feasibility probe (executed, read-only, PROTOTYPE_ONLY)

A 90-line probe (`work/L11_2_EVIDENCE/feasibility_probe.cpp`) was compiled **in
`/tmp`** against a copy of `stark/src` and run once. The repository was not modified.

```
serialize_len=25638 state_fingerprint=7465c02006d13411
bank_state_size=3 reward_baseline_size=3 active_bank=-1
router_weights=12x3 score=[0.000 0.000 0.000] preferred=0
bank_weights=3x6x6
result: queried=3 choice=2 bank=1 sel_slot=0 plastic_write=0 reward=-1.000000 a0=0.5000 a1=0.5000
intended_slot=1 presented_size=2 ctx=1
update_mass: bank=0.000000 queried=0.000000 router_l1=1.333333 baseline=-0.020000
state_changed=1
```

**What this establishes:** every field in the "direct / derived / public API" rows
of §4 is reachable from a translation unit that includes only the existing public
headers — therefore the instrumentation can be **harness-only** and
`ContextConditionedMemory.cpp` need not change at all. The probe's single trial
also shows the interesting case in miniature: `sel_slot = 0` while
`intended_slot = 1`, i.e. the attention selected the wrong channel, and the router
still updated (`router_l1 = 1.33`) while the bank was not writable
(`plastic_write = 0`). Those are exactly the distinctions L10's record could not make.

**What it does not establish:** that the prepared writer reproduces the legacy
output, that per-trial non-interference holds, or that any L11 arm exists. Those
are the blocked tests (§5, §7).

---

## 5. Per-trial non-interference — measured half only

The mission requires a per-trial byte comparison between instrumentation-disabled
and instrumentation-enabled runs. **The enabled half does not exist** (no
authorization), so the comparison **cannot be reported as passing**. What was done:

### 5.1 The disabled side is now measured, not assumed

The **unmodified** harness was built in `/tmp` (`g++ -O2 -std=c++17 -Isrc`, no
`cmake` in this container) and run twice, into two separate directories, on the
default arm with the three primary seeds:

**18/18 output files byte-identical across two independent runs** —
`trials_*.csv`, `metrics_*.csv`, `calls_*.csv` for both `ccm` and `seql9` arms
(`work/L11_2_EVIDENCE/determinism_legacy.txt`).

This gives the non-interference test a *trustworthy* reference: the disabled
output is deterministic, so any difference found later is attributable to the
instrumentation rather than to run-to-run noise.

### 5.2 What the blocked comparison must check (specified, not executed)

| # | Comparison | Artifact | Expected |
|---|---|---|---|
| 1 | trial ordering | `trials_*.csv` row order | identical |
| 2 | inputs/targets | `queried`, `task`, `trial` columns | identical |
| 3 | predictions/routing | `choice`, `bank`, `bank_is_task_bank` | identical |
| 4 | parameter updates / state transitions | `writable`, `active`, `reward`, `forced`, `opp` + `metrics_*.csv` | identical |
| 5 | final model state | `ccSerialize` dump at run end | identical bytes |
| 6 | RNG consumption | trial count and every seeded draw already inside the rows; additionally the `mech_u`-derived `sel_slot` must match | identical |
| 7 | legacy artifacts | all 18 files above | **byte-identical (untouched, not merely equal)** |
| 8 | instrumentation records | `trials11_*.csv` | reconstructable independently (§6) |

Requirement 7 is stronger than L11.1 specified and is achievable because the
prepared design writes a **separate** file.

**Status: BLOCKED.** It cannot be claimed, and this report does not claim it, that
the instrumentation is non-invasive.

---

## 6. Metric reconstruction (executed)

The L11.1 prototype grouped trial rows by `task` only. Reconstructing a **fresh**
harness run exposed that as insufficient: `eval_kind = 0` evaluates each task in
several calls (`acquisition`, `retention@step1`, `retention@step2`), so per-task
row counts were 360/240/120 instead of 120 each. A call-aware v2 tool was written
(`work/l11_2_prototype/recompute_metrics.py`) rather than reusing the flawed one.

| Check | Command | Result | Classification |
|---|---|---|---|
| Fresh run, multi-call category | `recompute_metrics.py trials_ccm_123456789.csv --calls calls_ccm_123456789.csv --eval-kind 0 --metrics metrics_ccm_123456789.csv` | 6 calls, 120 rows each, no ragged sizes, `published_comparison.match = true` | EXECUTED |
| Legacy `-1.0` sentinel | same, `--metrics-column cross_novel` | reported `NOT_MEASURED_in_harness`, **not compared against −1** | EXECUTED |
| Negative: duplicate `(task,call,trial)` | synthetic file | `{"status":"RECONSTRUCTION_FAILED","reason":"duplicate trial key (0, 0, 720)"}`, exit 2 | EXECUTED |
| Negative: empty selection | `--eval-kind 99` | `RECONSTRUCTION_FAILED`, `no rows selected`, exit 2 | EXECUTED |
| L10.3 cross arm, call-aware | 3 primary seeds | pooled **0.6306 / 0.5583 / 0.4944 → 0.5611**; routing **0.5019**; `published_match = true` on all three | REPRODUCED |

The L11.1 finding is **unaffected** by the grouping defect: the `eval_kind = 4` arm
has exactly one call per task (verified: calls 11, 17, 23), so its per-task means
were already correct. The defect was in the tool's generality, not in the result —
and it was found by independent verification rather than assumed absent.

Traceability: every number above is reproducible from a named file plus a named
command; the scripts take the trial file, the call table and the metric column as
explicit arguments, so no metric is silently computed from a default.

---

## 7. Tests executed and not executed

### 7.1 Executed in L11.2

| # | Test | Command | Outcome |
|---|---|---|---|
| E1 | Baseline build of the unmodified harness | `g++ -O2 -std=c++17 -Isrc` on 6 TUs, link | **BUILD OK**, runs 3 seeds in ≈8 s |
| E2 | Legacy determinism | two runs, 18 files, `cmp` | **18/18 identical** |
| E3 | Feasibility probe | compile + run in `/tmp` | all 35-field sources reachable (§4.2) |
| E4 | Reconstruction, fresh run | `recompute_metrics.py` | `match = true` |
| E5 | Reconstruction, L10.3 cross arm | 3 seeds | 0.5611 / 0.5019 reproduced |
| E6 | Sentinel handling | `--metrics-column cross_novel` | `NOT_MEASURED` reported, not averaged |
| E7 | Negative: duplicate key | synthetic | explicit failure, exit 2 |
| E8 | Negative: empty selection | `--eval-kind 99` | explicit failure, exit 2 |
| E9 | L11.1 protocol hash match | `sha256sum` vs preregistration | **match** |

Two defects were found **in the new tooling** during this milestone and fixed in
place (gz input support; per-task grouping). Both are recorded rather than hidden.

### 7.2 Inherited, **not** rerun

The 26/26 L10.4 regression battery. Not rerun in L11.2: no source changed, so
nothing could have moved it, but **no claim is made that it passes today**. It
must be rerun in the milestone where instrumentation is actually compiled into the
harness.

### 7.3 Blocked by the gate

Per-trial non-interference (T8 in the L11.1 plan), writer round-trip (T7),
determinism of the instrumented binary (T9), checkpoint/resume (T10), R-majority
unit test (T11).

### 7.4 Blocked by environment

None new. The build works with explicit `g++`; no `cmake` is available, which is
already recorded in L10.6/L11.1.

### 7.5 Not implemented (and required before an official run)

- The six new cue categories (`CROSS21`, `CROSS31`, `AMBIG11`, `MISLEAD`,
  `ORDERPERM`) — the arms themselves. Instrumentation without arms produces
  correctly-shaped records for arms that do not exist.
- The `--order` control arm's reversed presentation order (exists as a mode, but
  not wired to a composition evaluation).

### 7.6 `test_phase1_affinity`

**Status: UNKNOWN / UNEXECUTED** — unchanged, and not simulated. R2 is unresolved,
so no port was applied. The diagnosis from L11.1 stands and was re-confirmed only
by reading: 44 assertions; 10 `DWORD_PTR` uses; Case C calls the live Win32 API
unguarded. It is neither a pass nor a failure and is excluded from every
"all tests pass" statement.

### 7.7 Failed tests

None. (E7/E8 are negative tests whose *pass* condition is an explicit failure.)

---

## 8. Frozen-artifact and protocol integrity

| Item | State | Classification |
|---|---|---|
| L11.1 protocol `stark/design/l11_1_protocol.md` | unmodified; sha256 still `322078c8…` | VERIFIED |
| L11.1 preregistration | unmodified | VERIFIED |
| L11.1 specification / schema / validation plan | unmodified | VERIFIED |
| Thresholds L11-A…G | **unchanged and still unratified** (R1 unresolved) | VERIFIED |
| Mixture ratios, task order, null construction, sample sizes, tie-break | unchanged; nothing was tuned | VERIFIED |
| L10 evidence `work/l10_raw/**` | untouched; read only. L11.2 re-read the L10.3 cross arm for reconstruction and modified nothing | VERIFIED |
| L10 criteria / v1.8 specification | untouched; hash `aafd00aa…` unchanged | VERIFIED |
| Frozen L10 results, including failures and confounds | preserved; none re-run, none relabelled | VERIFIED |

**Protocol defects found:** none in the protocol itself. Two **engineering** defects
were found in the *tooling* (§6) and one **gap** in the schema's practical
coverage (§4, the missing cue categories). If, at implementation time, the schema
must change (for example `model_hash` being produced by an external hash step
rather than in C++), it will be submitted as a documented change with rationale and
impact, and the protocol hash will be re-frozen — not silently edited.

**L11-A statistical qualification (preserved):** a pass at 108/120 is consistent
with a true rate ≥0.90, but is not proof of it (`P(pass | 0.90) ≈ 0.576`).

---

## 9. Official L11 evaluation status

**NOT RUN.** Zero arms, zero seeds, zero official trials. The only executions in
this milestone were (a) the **unmodified** harness's default arm on the three
primary seeds, twice, to establish legacy determinism, and (b) one single-trial
API probe. Neither is an L11 arm, neither produced an L11 metric, and neither is
labelled as a result. No performance claim of any kind is made here.

---

## 10. Remaining blockers

| # | Blocker | Blocks | Owner action |
|---|---|---|---|
| B1 | **R3 not authorized** | any implementation | authorise the prepared change (`work/L11_2_PREPARED_DIFF.md`) |
| B2 | **R1 not ratified** | declaring L11-A…G in force; official run | ratify or amend thresholds |
| B3 | **R2 unresolved** | the regression gate's completeness | choose port vs permanent Windows-only exclusion |
| B4 | **L11 arms unimplemented** | any official measurement | separate authorized change adding the six cue categories |
| B5 | **Non-interference unproven** | accepting instrumentation as non-invasive | blocked on B1 |
| B6 | L10.4 26/26 battery not rerun on the instrumented binary | regression claim | runs after B1 |
| B7 | L10.4 one-trial anomaly still unresolved | clean interpretation of the forced-bank null | separate authorized diagnostic (`work/L10_6_PROPOSED_channel_slot_diagnostic.md`, still PROPOSED / NOT EXECUTED) |

---

## 11. APEX overall progress

**≈57 %, unchanged.** Instrumentation improves observability; it does not make the
system more capable. Nothing in this milestone demonstrates compositional
generalization, and no result here may be cited as evidence of a cognitive
capability. The progress figure remains a rough engineering estimate, not a
measurement.

**Recommended next step (conditional on §10):** once R3 is granted, implement the
prepared change behind `--emit-l11` and run the per-trial non-interference test
(§5.2) *before* any arm is implemented. If that passes, request R1 and R2, then a
separate, explicitly authorized **preflight review** before any official L11 run.
