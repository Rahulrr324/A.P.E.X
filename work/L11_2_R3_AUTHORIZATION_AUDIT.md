# STARK-L11.2 — R3 Authorization Audit

**Status: READ-ONLY AUDIT. Advisory only.**
No patch was applied, no source file was modified, no `--emit-l11` was
implemented, no L11 arm was run, and R1, R2 and R3 remain **unauthorized**.

**Question answered:** is `work/L11_2_PREPARED_DIFF.md` safe, minimal and
scientifically appropriate enough to present for explicit R3 authorization?

**Answer:** the *mechanism* is safe. The *semantics it would encode* are not yet
correct. Recommendation: **approve R3 with explicit conditions** — seven of them,
listed in §8, with the default ordering being one document-only correction commit
before any code is written.

---

## 1. Provenance and repository state

### 1.1 What the workspace actually is (important)

The checkout was **re-provisioned** since the L11.2 report was written. This is
the failure mode already recorded in project memory, so it was checked before
anything else was read:

| Fact | Value | Classification |
|---|---|---|
| Current branch | `arena/86da64f9-a-p-e-x` | VERIFIED |
| Current HEAD | `5f5a57717509623bd4c79460d50c05f7cbc605c3` — the **L9** commit, *not* the reported starting commit | VERIFIED |
| Working tree | 1 modified tracked file (`stark/CMakeLists.txt`) + 54 untracked entries | VERIFIED |
| Is the residue authentic? | **Yes.** Every one of the 14 files committed at `c547aab` was hash-compared by git blob: **14/14 identical**. The "modified" `CMakeLists.txt` is byte-identical to the commit (`da737d0a…`); it only *appears* modified because the checkout is 5,000 commits of work behind. | VERIFIED |
| Local refs for the validation branches | absent | VERIFIED |
| Action taken | fetched the two validation branches into **remote-tracking refs only** (`refs/remotes/origin/...`). No local branch was moved, no working tree file changed, no ref mutated except those two new remote-tracking refs. | VERIFIED |

**This is not a discrepancy in the L11.2 report.** The report described the
repository correctly; the sandbox was rebuilt at an older commit afterward.

### 1.2 Reported SHAs, checked

| Claim | Verified value | Classification |
|---|---|---|
| Starting commit `6a43974…` | `6a43974433a0396f756536817f88421eb86edf8c` = remote `validation/l11-1-specification` | VERIFIED |
| Readiness branch HEAD `c547aab…` | `c547aab658cb1852b68bad2626e5a076346ec766` = remote `validation/l11-2-instrumentation-readiness` | VERIFIED |
| Branch parent | `c547aab^` = `6a43974`; `git merge-base --is-ancestor` confirms ancestry | VERIFIED |
| L11.1 seal commit | `77d261aa83ddbf3aac1abc800c7c5c89741a86c7`; recorded as `frozen_at_commit` in the pre-registration | VERIFIED |
| Remote parity | local FETCH_HEAD refs equal remote `ls-remote` for both branches | VERIFIED |
| Shallow boundary | `.git/shallow` = `563395f…` and `5f5a577…`; history older than these is absent and no claim here depends on it | VERIFIED |

### 1.3 Has anything changed since L11.1?

```
git diff --stat 6a43974 c547aab -- stark/        -> empty
git diff --name-only 6a43974 c547aab | grep -v ^work/  -> empty
git diff --name-only 6a43974 c547aab -- work/l10_raw   -> empty
```

**No source, test, protocol, frozen L10 evidence or threshold changed.** The only
change between the L11.1 seal and the L11.2 head is 14 new documentation/evidence
files under `work/`. VERIFIED.

### 1.4 Hashes

| Artifact | SHA-256 | Note |
|---|---|---|
| `stark/design/l11_1_protocol.md` | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` | identical in the working tree **and** at `c547aab`; **matches** the value recorded in the pre-registration → VERIFIED |
| `work/L11_1_PREREGISTRATION.json` | `57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b` | unchanged |
| `stark/design/l11_trial_schema.md` | `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917` | matches the prereg's recorded schema hash; **this is the document §5 finds defective** |
| `stark/design/context_conditioned_memory_milestone.md` (L10 v1.8) | `aafd00aad8c2b843410f2a88fdf3f64cbeb2c10c39f7470f43c5a2bafe33ffd1` | unchanged |
| `stark/src/learning/l10_validation_harness.cpp` | `697b5f8a23eed90324ae600fd868628dc257cd8ca0b0a3b5f509a1f42df1ffc7` | unmodified |

Pre-registration still reads `"ratification": "PENDING_OWNER_DECISION"` and
`"official_evaluation_run": false`. Confirmed by reading the JSON.

### 1.5 Pull requests

| PR | Head | Base | State |
|---|---|---|---|
| #2 | `5f5a57717509623bd4c79460d50c05f7cbc605c3` | `main` | OPEN, untouched |
| #3 | `49cc6ba18650c0d9614bb9e8918fe65453ec5a02` | `arena/c90f7329-a-p-e-x` | OPEN, untouched |
| #1 | — | `main` | MERGED 2026-10-22 |

No PR was created, merged or edited. VERIFIED.

---

## 2. Exact prepared-patch scope

`work/L11_2_PREPARED_DIFF.md` proposes eight parts, all in one file. Each was
traced to the current source. Line numbers refer to
`stark/src/learning/l10_validation_harness.cpp` (854 lines).

| Part | Target (actual location) | Existing behaviour | Proposed behaviour | Additive? | Default-off? | Can it affect execution? |
|---|---|---|---|---|---|---|
| **P1** | `struct StreamSpec`, lines 143–162 | 17 configuration fields | + `emit_l11`, `run_id`, `protocol_sha` | yes | yes (`false`) | no — read-only config, passed by `const&` |
| **P2** | `struct TrialRow` 106–117 / `StreamResult` 124–142 | 17-field `TrialRow`, `rows` vector | + `TrialRow11` type and a **separate** `rows11` vector | yes | yes (empty unless enabled) | memory only; not consumed by any existing code |
| **P3** | `evalTask` trial loop, 243–275 | records a `TrialRow` inside `if (rows)` at 263–274 | additional capture of the same trial's observation surface | yes | yes | **only if placed correctly** — see R3-1, R3-2 |
| **P4** | training loop, 421–487 | `w0` captured at 429 only on `measure \|\| maybe_opp`; trial at 441; `w1` at 461 | per-trial capture of mass/advantage/router L1 | yes | yes | **only if placed correctly** — see R3-3, R3-4 |
| **P5** | new `writeTrial11Csv`, beside `writeTrialCsv` 662–672 | legacy writer unchanged | separate `trials11_<tag>.csv` | yes | yes | no — `writeTrialCsv` not edited |
| **P6** | `main` arg loop, 701–729 | 16 flags | + `--emit-l11`, `--run-id`, `--protocol-sha`, `--dump-state` | yes | yes | only through validation failure paths — R3-5 |
| **P7** | new `intendedBankByRule(cue, …)` | none | R-majority over disjoint 4-feature groups | yes | n/a (called only when enabled) | no behavioural effect; **semantically ambiguous — §5, S1** |
| **P8** | run start + task boundaries | none | `ccSerialize(ag)` dump for external hashing | yes | yes | no engine effect; cost if done per trial — R3-6 |

**Is it minimal?** Yes, under one condition: it must stay inside this file.
The audit confirms that is achievable — every datum is reachable from the existing
public API (§4 of the L11.2 report, re-verified here by probe).

**Is "harness-only" enough to call it safe?** No, and the audit does not. Being in
the harness bounds the *blast radius*; it does not prove runtime non-interference,
which is why §7 exists.

---

## 3. Behaviour-preservation risk assessment

Thirteen categories, each with the evidence behind its classification.
Three classifications are used, and only those.

| # | Risk area | Classification | Evidence |
|---|---|---|---|
| 1 | **RNG state / consumption** | **Demonstrably absent** | `runCCTrial` contains **zero** RNG engines (`grep -c mt19937 → 0`); every random draw is pre-computed in the harness before the call and passed in the schedule. The observation APIs (`ccSerialize`, `ccBankWeights`, `ccRouterWeights`) contain no RNG. Conditional on the implementer adding none — that is condition C5. |
| 2 | Trial ordering / sampling / selection | **Demonstrably absent** | Selection is a pure function of `s.mech_u` and the weights. Empirical: 240-trial probe, observed vs unobserved → `choice_diffs=0 bank_diffs=0 queried_diffs=0`. |
| 3 | Routing / retrieval decisions | **Demonstrably absent** | Same probe: `bank_diffs=0`, and the final state is byte-identical (28,537 bytes). |
| 4 | Reward / advantage / baseline | **Potential risk with a test** | The *reward* is returned by the engine and untouched. The *recorded advantage* is at risk: `agent.reward_baseline[bi]` is updated **in place** inside `runCCTrial` (ContextConditionedMemory.cpp:490), so reading it after the call records the next trial's baseline. A pre-call snapshot is mandatory (S7). Test: recompute the advantage independently from task-boundary dumps. |
| 5 | Eligibility / plasticity | **Demonstrably absent** | Probe shows the full serialized state (which includes per-synapse weights and eligibility state) identical after 240 trials with observers on. |
| 6 | Parameter / model state | **Demonstrably absent** | Same evidence; `final_state_equal=1`. |
| 7 | Checkpoint / resume | **Potential risk with a test** | The patch does not exist. `--dump-state` must be written outside the `--stage save/load` files (`state_out` at 615–620) and must not reorder the existing snapshot/deserialize sequence. Otherwise a resume run could adopt an instrumented state file. Test: T10 (resume byte-equality) — currently not implemented. |
| 8 | Floating-point evaluation order | **Potential risk with a test** | No `-ffast-math`, no `-march`, no `-O3` override in `CMakeLists.txt`; strict IEEE is the default. But source inspection **cannot** prove that adding code to the caller leaves the callee's generated code identical under `-O2`. The per-trial byte comparison is the only acceptable evidence. Classified potential, deliberately not "absent". |
| 9 | Exception / error paths | **Unresolved from source inspection** | The CLI validation path (P6) does not exist yet. Requirement: fail closed (non-zero exit) and write **no** partial artifacts. A malformed `--protocol-sha` must not leave a half-written `trials11_*.csv`. Not auditable until written — condition C6. |
| 10 | Legacy CSV columns / filenames / row order / serialization | **Demonstrably absent by construction** | P5 writes a separate file and `writeTrialCsv` (662–672) is not edited. This is the single strongest design choice in the patch. Verification is a file-hash comparison, which is cheap and decisive. |
| 11 | Timing-dependent behaviour | **Demonstrably absent** | No `<thread>`, no `time()`, no `chrono`, no `clock()` anywhere in the harness. Only *performance* changes: measured ~0.13 ms/trial plain vs ~1.22 ms/trial with per-trial `ccSerialize` (≈9×). See R3-6. |
| 12 | Threading / process behaviour | **Demonstrably absent** | Single-threaded, single process, no shared state. |
| 13 | Memory growth | **Demonstrably absent as a risk** | `rows11` is O(trials) ≈ 4,000 rows × ~200 B ≈ 1 MB per run. Legacy `rows` already does the same. |

**Two source-level hazards that the prepared design does not currently call out** —
these are the highest-value findings of the code trace:

- **R3-1 (capture site).** `evalTask` is the right place, but the *routing
  re-derivation block* at lines 505–521 executes the model **120 more times per
  task** with `rows = nullptr`. An implementation that captures at the
  `runCCTrial` call sites instead of inside `evalTask` would record those hidden
  trials and silently corrupt every accuracy metric. The capture must be inside
  the `if (rows)` block at 263–274 and nowhere else.
- **R3-2 (restore ordering).** `evalTask` restores the snapshot at line 275. Any
  capture after that line would record the *restored* state, not the trial's, and
  the "post-trial state" column would be silently wrong.
- **R3-3 (stale `w0` reuse).** The prepared text says the existing `w0` "can be
  reused". It cannot, in general: `w0` is refreshed only when
  `measure || maybe_opp` (line 429), and `measure` is false on pair trials. Reusing
  `w0` on a trial where it was not refreshed in that iteration yields a
  plausible-looking but **wrong** update mass. Mass must be captured per trial.
- **R3-4 (advantage timing).** Same class as risk #4, stated separately because
  it is a one-line placement error with a silent failure mode.

None of these are fatal to the design; all are silent-corruption hazards, which is
why they become explicit conditions rather than open questions.

---

## 4. Trial-schema semantic audit

Each item the mission asked to verify, checked against the actual API and the
actual L11.1 schema text.

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | `sel_slot` recorded with documented meaning and correct `-1` handling | **PASS** | `sel_slot` is the **sampled** channel (`sampled = (s.mech_u < a[0]) ? 0 : 1`), not the argmax; it is `-1` on **single-candidate** trials only, where it means "not applicable". The schema marks `selected_slot` nullable. Correct — provided `-1` is written as empty, never as `-1` or `0`. |
| 2 | `queried` not confused with `presented[]` | **PASS, with a required addition** | `queried = s.presented[map.phi[s.ctx]]` — the identity at the **intended** slot. The identity actually attended is `presented[selected_slot]`. The 35-field schema has **no `presented[]`**, so that identity is unrecoverable. The L11.2 report already proposed adding it; the audit confirms it is **required**, not optional (finding S3). |
| 3 | `reward_baseline` captured pre-call | **PASS in the prepared text** | The prepared P4 explicitly snapshots before the call. Confirmed necessary: the update is in-place at `ContextConditionedMemory.cpp:490`. Confirmed `baseline_per_bank=false` is the effective default (header line 69) and `runStream` never overrides it, so index 0 is the only one used. |
| 4 | Legacy `-1.0` sentinel becomes explicit missing status | **PASS on the tooling side, defect confirmed in the legacy format** | `writeTaskCsv` (624–653) emits `-1.0` for `holdout/context_off/shuffled/cross_novel/unintended_*` when the arm produced nothing. The L11 reconstruction reports this as `NOT_MEASURED_in_harness` and never averages it (verified). The L11 record must not inherit the sentinel. |
| 5 | Missing / inapplicable values cannot silently become zero | **PASS** | The schema's `have_*`-style nullable design plus the validator's rule "empty non-nullable field ⇒ reject" enforces it. Verified: 17/17 self-tests include the case `reward=""` → rejected. |
| 6 | Routing and retrieval independently reconstructible | **PASS — newly demonstrated on non-degenerate data** | See §6.3. On the R7 arm (routing 0.0, accuracy 0.1667/0.3333) the reconstruction matches the harness's own `routing` and `acquisition` columns in all 6 acquisition cells. This is the first non-degenerate evidence; the previously reported checks were all on saturated (1.0) arms. |
| 7 | Update mass not attributed without evidence | **PASS** | `ccBankWeights` covers `[bank][id][resp]` only; the router lives in separate `cue→R` synapses. The existing L10.1 `measure` block already splits mass into `(bank, queried)` / rest-of-bank / other-banks, so the attribution the patch proposes is the same one the project already uses. |
| 8 | Trial keys unique and complete | **PASS, with a constraint** | Eval rows use `tr.idx = rows->size()` — a **global** row ordinal; training rows use `i` per task. `(task, call, trial)` is therefore unique. Constraint: the new writer must mirror the legacy ordinal exactly, or the two files cannot be cross-checked (this is what makes check 7′ in §7 possible). |
| 9 | Schema can represent all control conditions without inventing data | **FAIL — see S1 and S2** | Two of the ten categories cannot be represented correctly by the current schema. |

### S1 — `intended_bank` conflates two different quantities (schema defect)

The schema (line 65) defines `intended_bank` as *"bank prescribed by the declared
rule; null when the rule is undefined (e.g. `SHUFFLED`)"*, and line 67 defines
`routing_correct = (selected_bank == intended_bank)`.

Under R-majority the rule is **not** undefined for `SHUFFLED`: the cue is a
`TRAIN` pair taken from another task, so every feature belongs to one other group
and the rule prescribes **that other task's bank**. An implementation following
the schema literally would therefore record `routing_correct = 1` for a system
that was successfully misled — the exact opposite of the L10.3 published
`shuffled` routing of **0.0000**, and of the intended meaning of
"contradictory context".

The same field also has to mean "the bank that owns the evaluated task" (the L10
meaning that `Comp`, `Read` and the L10 baseline all rest on). **One field cannot
carry both.** They coincide for `TRAIN`, `HOLDOUT`, `PARTIAL`, `CROSS21`,
`CROSS31` and `AMBIG11` (by construction the majority group *is* the intended
task's group), and they diverge for `MISLEAD` and `SHUFFLED` — which is exactly
where the schema is silent.

**Proposed correction (documented, not applied):** split the field.

```
task_bank       int    bank that owns the evaluated task        (L10 meaning)
rule_bank       int    R-majority prediction for this cue       (L11 Comp meaning)
routing_correct  := (selected_bank == task_bank)       -- preserves L10 semantics
rule_compliant   := (selected_bank == rule_bank)       -- carries Comp
```

This changes **no threshold**, **no criterion**, and **no measured value**. It
replaces one ambiguous boolean with two unambiguous ones. It requires re-freezing
the schema as v0.2 and re-recording its hash in the pre-registration — a documented
version change, which is the only permitted route.

### S2 — `Read` is undefined for `MISLEAD` (schema defect)

`Read = mean(correct | routing_correct == 1)`. For `MISLEAD` the cue carries only
the wrong group's features, so following the rule leads to a bank that does not
hold the evaluated task's mapping; `correct` is 0 **by construction**. Yet the L11
specification (§3) asks `MISLEAD` to answer *"does the rule hold when following it
yields the wrong answer?"* and *"whether the resolved bank retrieves its own
mapping"*. The second question needs the resolved bank's **own** permutation, which
the record does not carry.

**Proposed correction:** add `choice_matches_resolved_bank_map` (1/0), computed
driver-side from the resolved bank's task permutation. This makes `MISLEAD`
answerable without inventing data.

### S3 — `presented[]` absent (confirmed)

See §4 item 2. Required; not optional.

### S4–S6 — items checked that are **not** defects

- `sel_slot = -1` handling is already correct in the schema.
- The legacy `-1.0` sentinel is a defect of the *legacy* format; the L11 schema
  forbids it and the tooling honours that.
- Trial-key uniqueness holds under the documented constraint.

### S7 — Cross-document consistency

The schema, the specification, the protocol and the prototype scripts were read
together. Two further mismatches exist, both minor:

- The schema's `Null` metric is defined as the mean of three forced-bank cells;
  the protocol defines `Null(t)` the same way. **Consistent.**
- `work/l11_2_prototype/recompute_metrics.py` requires a `calls_*.csv` sidecar,
  which older artifacts (e.g. the R7 arm) do not have. That is a **tooling
  limitation**, not a schema defect; recorded here and worked around for the audit
  with a separate evidence script rather than by editing the tool.

---

## 5. Non-interference protocol adequacy

The eight proposed checks were audited against the question *"could this pass
while hiding a meaningful behavioural difference?"*

| Check | Adequate on its own? | Assessment |
|---|---|---|
| 1 identical inputs and targets | yes | compares `queried`, `task`, `trial` |
| 2 identical trial order | yes | row order |
| 3 identical predictions and routing | yes | `choice`, `bank`, `bank_is_task_bank` |
| 4 identical state transitions / updates | yes | `writable`, `active`, `reward`, `forced`, `opp`, plus `metrics_*.csv` |
| 5 identical final state | yes | `ccSerialize` dump at run end |
| 6 RNG behaviour where measurable | partly | `sel_slot` per trial is a good proxy; add a per-task-boundary state hash to localise divergence |
| 7 legacy artifact compatibility | **weak as written** | with a separate writer this is *vacuous*: the legacy files are produced by code that was never edited, so they will always match. It proves the build didn't change, nothing more. |
| 8 per-trial byte comparison + attribution | yes, and it is the load-bearing one | must be the primary evidence |

**Four ways the test could pass while a real difference is hidden:**

1. **Vacuous legacy comparison (check 7).** Fixed by the addition below.
2. **A saturated arm.** The default frozen arm yields accuracy 1.0 and routing 1.0
   in every cell (confirmed: the fresh audit run is all-1.0000). Structural
   differences are invisible in aggregates there — per-trial comparison still
   catches them, but the arm gives no power. R7 (routing 0.0, accuracy 0.1667) is
   the available non-degenerate configuration.
3. **Unexercised branches.** If only training rows are compared, an eval-path
   difference survives. Both paths, and the per-bank sweep, must be in scope.
4. **A recording bug passing a behaviour-only test.** If `advantage` or update
   mass is captured at the wrong instant, the model is unchanged (so every
   behaviour check passes) but the records are wrong. Behaviour tests cannot catch
   this; only independent recomputation can.

**Narrowly justified additions (proposed, not silently adopted):**

- **7′ — projection equality against the legacy artifact.** With the separate-file
  design, project the new records onto the 17 legacy columns and require them to
  equal `trials_*.csv` **row for row**. That converts the vacuous check into a real
  per-trial comparison between two independently produced artifacts.
- **9 — non-degenerate arm.** Run the comparison on at least one arm with
  routing < 1 and accuracy < 1 (R7-style, or K2/T3 stress).
- **10 — record-correctness test.** Recompute `advantage`, `update_mass_*` and
  `router_update_l1` from state dumps and require agreement with the recorded
  values.
- **11 — zero-file test.** `--emit-l11 0` must produce **no** `trials11_*.csv`.
- **12 — fail-closed test.** Missing or malformed `--protocol-sha` ⇒ non-zero exit,
  no partial artifacts.
- **13 — boundary state hashes.** `ccSerialize` hash at each task boundary, not
  only at the end.
- **14 — new-file determinism.** Two runs ⇒ byte-identical `trials11_*.csv`.

These are additions to coverage. **No acceptance criterion is relaxed or altered**,
and none of L11-A…G is affected.

**On the 18/18 result:** the two byte-identical runs of the *unmodified* harness are
**baseline determinism evidence only**. They show the disabled side is stable, so a
future difference can be attributed to the instrumentation rather than to noise.
They are **not** evidence that instrumentation is non-invasive, and this audit does
not use them that way.

---

## 6. Independent verification of the reported tooling claims

Every claim was re-executed in this audit against the committed artifacts. Nothing
was taken on trust.

| Claim | Re-executed | Result | Classification |
|---|---|---|---|
| Schema validator 17/17 | yes | **17/17 PASS**, exit 0 | VERIFIED |
| 13 negative controls reject | yes (counted from output) | 13 negative + 4 positive = 17; every negative rejected with a named reason | VERIFIED |
| Coverage 13/35 (37.1 %) | yes | `coverage 0.37142857142857144`, 13 present, 22 missing | VERIFIED |
| Fresh-run reconstruction matches | yes (own build in `/tmp/audit`) | 6 calls × 120 rows, no ragged sizes, `published_comparison.match = true` | VERIFIED |
| L10.3 cross arm reproduces 0.5611 / 0.5019 | yes, from committed evidence | 0.6306 / 0.5583 / 0.4944 → mean **0.5611**; routing mean **0.5019**; `pub_match = true` × 3 | REPRODUCED |
| `-1.0` sentinel reported as not-measured | yes | `NOT_MEASURED_in_harness`, never averaged | VERIFIED |
| Duplicate trial key fails explicitly | yes | `RECONSTRUCTION_FAILED … duplicate trial key (0, 0, 720)`, exit 2 | VERIFIED |
| Empty selection fails explicitly | yes | `RECONSTRUCTION_FAILED … no rows selected`, exit 2 | VERIFIED |
| Protocol hash matches preregistration | yes | `322078c8…` = recorded value | VERIFIED |
| Legacy determinism 18/18 | **independently rebuilt and re-run** | **18/18 byte-identical** | VERIFIED |
| Prepared patch matches the described anchors | yes | line numbers verified; no anchor drifted | VERIFIED |

### 6.1 New evidence produced by this audit

**(a) Observer non-perturbation** — the central feasibility question.

Two identical agents driven through the same 240-trial learning stream; the
observed arm calls `ccSerialize` + `ccBankWeights` + `ccRouterWeights` after every
trial:

```
choice_diffs=0  bank_diffs=0  queried_diffs=0  reward_diffs=0
final_state_bytes=28537  final_state_equal=1
VERDICT=OBSERVERS_NON_PERTURBING
```

This is direct evidence that the *observation surface* does not perturb the
trajectory. It is **not** evidence about the writer, the file I/O, or the
correctness of capture placement — those are untested because the patch does not
exist.

**(b) Observation overhead** (timing only, not semantics):

| Mode | ms/trial |
|---|---|
| plain | 0.13 |
| + `ccSerialize` only | 1.20 – 1.53 |
| + `ccBankWeights` + `ccRouterWeights` | 0.13 (within noise) |
| + all three | 1.22 – 1.42 |

`ccSerialize` is the entire cost (~28 KB string rebuilt per trial). Serialising
only at run start and task boundaries — which P8 already specifies — keeps the
overhead negligible. Serialising per trial would cost ≈ 2.5 s per 2,160-trial run,
which is tolerable but pointless.

**(c) Non-degenerate reconstruction** — see §6.3.

### 6.2 One defect found in this audit's own first attempt (recorded, not hidden)

The first run of the audit's verification script used a `1e-9` tolerance and
reported two false mismatches (`0.166667` reconstructed vs `0.166667` published,
differing by 3.3e-7). The harness writes aggregates with **fixed 6-decimal
precision**, so the only defensible tolerance is `1e-6`. The script was corrected
and the correction is documented in the code comment. Nothing in the audited code
was at fault.

### 6.3 Routing / retrieval separability on non-degenerate data

New in this audit. The R7 arm (`work/l10_raw/spec_ratification_20261024/R7/`) has
routing 0.0 with accuracy 0.1667–0.3333 — the case where bank selection fails but
retrieval from the wrong bank still succeeds by chance.

| Seed | Acquisition cell | Reconstructed routing / accuracy | Published routing / acquisition | Match |
|---|---|---|---|---|
| 123456789 | task 1 | 0.0000 / 0.1667 | 0.0000 / 0.1667 | **yes** |
| 218213831 | task 1 | 0.0000 / 0.1667 | 0.0000 / 0.1667 | **yes** |
| 171473193 | task 1 | 0.0000 / 0.0000 | 0.0000 / 0.0000 | **yes** |
| all three | task 0 | 1.0000 / 1.0000 | 1.0000 / 1.0000 | **yes** |

6/6 acquisition cells match. This is the first evidence that the two metrics are
separable **and** reconstructible in a regime where they disagree — the regime the
whole L11 design depends on. (The R7 directory has no `calls_*.csv`, so the
audit used a separate verification script;
`work/l11_2_prototype/recompute_metrics.py` was **not** modified.)

### 6.4 Claimed but not re-executed

- The **26/26 L10.4 regression battery**: **inherited, not rerun**. No source
  changed between L11.1 and L11.2, so it cannot have moved — but that is an
  expectation, and this audit makes no pass claim.
- `test_phase1_affinity`: **UNKNOWN / UNEXECUTED**. R2 is unresolved, so no port
  was applied and nothing was simulated. Its 44 assertions remain unverified on
  this platform.

---

## 7. Unresolved defects and uncertainties

| ID | Item | Severity | Status |
|---|---|---|---|
| **S1** | `intended_bank` conflates *task bank* and *rule bank*; `SHUFFLED` and `MISLEAD` are mis-representable | **High — semantic** | open; correction specified, not applied |
| **S2** | `Read` undefined for `MISLEAD`; `choice_matches_resolved_bank_map` missing | **High — semantic** | open; correction specified |
| **S3** | `presented[]` missing; the attended identity is unrecoverable | Medium | open; correction specified |
| **R3-1** | Capture must be inside `evalTask`'s `if (rows)` block, never at `runCCTrial` call sites (the routing re-derivation pass would be recorded) | **High — silent corruption** | open; becomes condition C2 |
| **R3-2** | Capture must precede the snapshot restore at line 275 | Medium | open; condition C2 |
| **R3-3** | Stale `w0` reuse yields wrong update mass on pair trials | **High — silent corruption** | open; condition C3 |
| **R3-4** | `baseline_per_bank=false`, index 0, updated in place at line 490; a post-call read is wrong | Medium | open; condition C3 |
| **R3-5** | Error paths unauditable until written | Medium | open; condition C6 |
| **R3-6** | Per-trial `ccSerialize` costs ≈9×; boundary-only serialisation recommended | Low | open; condition C7 |
| **R3-7** | `recompute_metrics.py` requires a `calls_*.csv` sidecar; older artifacts lack it | Low — tooling | open; recorded, not repaired |
| **U1** | Six L11 cue categories still do not exist, so instrumentation alone cannot produce a result | Scope, not defect | unchanged from L11.2 |
| **U2** | Non-interference remains **unproven**; only the observer surface and the disabled side are evidenced | — | unchanged |
| **U3** | Shallow clone: history before `563395f`/`5f5a577` unavailable | — | documented |
| **U4** | L10.4 one-trial anomaly still unresolved | — | unchanged |

**Can the patch be audited conclusively?** The *design* can be, and has been. The
*implementation* cannot, because it does not exist. Everything in §3 classified
"potential risk with a test" or "unresolved from source inspection" is waiting on
code that has not been written.

---

## 8. Recommendation

# APPROVE R3 WITH EXPLICIT CONDITIONS

**Why not an unqualified approval.** The mechanism is sound: one file,
ADDITIVE, DEFAULT-OFF, a separate output artifact, no engine change, no new RNG,
deterministically buildable and byte-stable at baseline, with every required datum
reachable from the existing public API and empirically shown non-perturbing on the
observation surface. That is a genuinely low-risk change and it is the right next
step.

**Why not "do not approve yet".** Blocking the code on a documentation defect would
be disproportionate: the two semantic defects are in the *schema*, not in the
mechanism, and they are fully specified above.

**Why conditions are nonetheless mandatory.** P7 encodes the ambiguous semantic
directly. Writing `intendedBankByRule` before S1 is resolved would bake a wrong
field into the artifact that every later L11 result is derived from, and the
failure would be silent — the worst possible outcome for a measurement milestone.

### The seven conditions

| # | Condition | Why | How it is checked |
|---|---|---|---|
| **C1** | Separate writer only; `writeTrialCsv` and `writeTaskCsv` are not edited; legacy files must hash-match the disabled run | keeps check 7 meaningful and makes non-interference cheap to verify | file sha256 comparison |
| **C2** | Capture lives inside `evalTask`'s `if (rows)` block and **before** the restore at line 275; nothing is captured at any `runCCTrial` call site; the routing re-derivation block (505–521) emits no rows | R3-1, R3-2 | row-count assertion per call; review |
| **C3** | Update mass is captured per trial (no reuse of a stale `w0`); `advantage` uses a pre-call baseline snapshot at index 0 | R3-3, R3-4 | record-correctness test 10 |
| **C4** | **Schema v0.2 first:** add `task_bank`, `rule_bank`, `rule_compliant`, `presented[]`, `choice_matches_resolved_bank_map`; define `routing_correct := selected == task_bank`; implement P7 against `rule_bank` | S1, S2, S3 | schema diff + re-frozen hash |
| **C5** | Exactly one source file changes; no new RNG engine anywhere; no engine file touched | risk 1, 2, 5, 6 | `git diff --stat` must show one file |
| **C6** | The non-interference run must include checks 1–8 **plus** 7′, 9, 10, 11, 12, 13, 14 (§5) before any arm is implemented | closes the four hiding paths | test record |
| **C7** | `ccSerialize` only at run start and task boundaries, never per trial | R3-6 | code review + timing |

### Recommended ordering (default, not a decision for the owner)

1. A **documentation-only commit** applying C4 (schema v0.2 + re-recorded hashes).
   No code. This is the conservative path and the one the audit recommends.
2. Then the implementation under C1–C3, C5, C7.
3. Then the C6 non-interference test, **before** implementing any of the six cue
   categories.
4. R1 (criteria) and R2 (affinity) remain **separate** decisions and are not
   implied by R3.
5. Only after all of the above: a separate authorized preflight review, then an
   official run.

**R3 does not authorize an official L11 evaluation, and this audit does not
recommend one.**

---

## 9. Statement of authority

This audit is **advisory**. It records findings and a recommendation. **It does not
grant R3 authorization, and it does not ratify R1 or R2.** No decision below is
marked approved; the accompanying record
(`work/L11_2_OWNER_DECISION_PROPOSED.md`) is a proposal for the owner to fill in.

---

## 10. APEX overall progress

**≈57 %, unchanged.** An audit improves the rigour of future measurement; it does
not make the system more capable. Nothing here demonstrates compositional
generalization, and no result in this document may be cited as evidence of a
cognitive capability. The figure remains a rough engineering estimate.
