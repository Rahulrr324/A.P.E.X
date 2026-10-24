# STARK-L11.1 — Cross-Signature Compositional Generalization: Specification, Instrumentation, and Pre-Registration

**Status:** specification and instrumentation design. **No L11 experiment was run.**
**No learning algorithm was implemented. No source file, test, threshold, evaluator
or frozen artifact was modified.** The only changes are new documents under
`stark/design/` and `work/`, plus two read-only prototype scripts.

**Bottom line.** The L11 experiment is now specified, instrumented, pre-registered
and *not* run. In the course of designing it, one measurement inherited from L10
was re-derived from raw trial rows and found to mean something different from what
its label suggests: the published cross-signature accuracy of **0.5611 is a
routing statistic, not a composition statistic** (§C). That finding changes what
L11 must measure, and it is the most consequential result of this task.

**Progress estimate: ≈57 %, unchanged.** A specification adds no capability.

---

## A. Provenance (established before anything was written)

| Item | Verified value |
|---|---|
| Repository | `Rahulrr324/A.P.E.X`, origin `https://github.com/Rahulrr324/A.P.E.X.git` |
| Session start branch | `validation/l10-6-signoff` |
| Session start HEAD | `ba1cfb3ce7ac3b179846d70abf66fba42d99bcf5` |
| Working tree at start | clean; no untracked residue |
| Remote parity at start | `refs/heads/validation/l10-6-signoff` = `ba1cfb3…` — **the reported commit is reachable and matches** |
| L11.1 branch | **`validation/l11-1-specification`**, created from `ba1cfb3` |
| Final HEAD | `77d261a…` (protocol/docs commit); the seal commit follows and is recorded in §I.4 |
| L10 specification | v1.8, sha256 `aafd00aa…`, identical in the working tree and in `git show HEAD:` |
| L10.6 sign-off | reachable at `ba1cfb3`, message verified |
| PR #2 | OPEN, head `5f5a577…`, base `main` — untouched |
| PR #3 | OPEN, head `49cc6ba…`, base `arena/c90f7329-a-p-e-x` — untouched |
| PR #1 | MERGED (2026-10-22) — untouched |
| No new PR | confirmed |

**Workspace limitation (documented, not worked around):** the clone is **shallow**
(`.git/shallow` lists `563395f…` and `5f5a577…`). History before those graft points
is unavailable, so no claim in this report depends on ancestry older than them.
Everything cited was verified against files, objects or evidence present in this
clone.

**Stale local ref (recorded, deliberately not "fixed"):** local branch
`arena/86da64f9-a-p-e-x` sits at `5f5a577` while `refs/heads/arena/86da64f9-a-p-e-x`
on the remote is `49cc6ba`. The local ref is simply behind; no fetch was performed
on it and nothing was pushed to it. PR #3's head is unchanged.

**Evidence re-verified in this task:** L10.3 `context_contribution_20261024`
manifest **245/245** artifacts match; L10 v1.8 hash matches in tree and commit.
(Full-manifest verification of every L10 set was performed in L10.6 and is recorded
in `work/L10_6_MILESTONE_SIGNOFF.md`; it is inherited here, not re-derived.)

---

## B. Evidence classification used in this document

| Label | Meaning |
|---|---|
| **VERIFIED** | read directly from a file, a hash, or a git object in this task |
| **REPRODUCED** | recomputed in this task from committed raw rows, and matching the published value |
| **DERIVED** | a calculation from verified numbers that is new in this task |
| **DESIGN_ONLY** | specified here, not executed |
| **PROTOTYPE_ONLY** | small tooling executed in this task that is not an experiment and not an official result |
| **EXPLORATORY** | a previously unregistered diagnostic |
| **OFFICIAL_EVALUATION_NOT_RUN** | no official L11 measurement exists |
| **UNKNOWN / UNEXECUTED** | not determined, or not runnable here |

---

## C. The finding that reshaped the design

### C.1 What L10 reported

`work/L10_3_CONTEXT_CONTRIBUTION.md` reports, for "cross (ambiguous: features of two
tasks)", pooled accuracy **0.5611** and pooled routing **0.5019**, and describes the
system as "brittle to *contradictory* context", with "ambiguous mixed-feature cues
are partially handled (0.5611, and per-task 0.0–1.0)".

### C.2 What the raw rows say (REPRODUCED, this task)

Reconstructing per-trial from
`work/l10_raw/context_contribution_20261024/KC_cross/trials_ctxnovel_*_KX.csv.gz`,
`eval_kind == 4`:

| Seed | Task | routing | accuracy | acc \| resolved bank | acc \| wrong bank |
|---|---|---|---|---|---|
| 123456789 | 0 | **0.0000** | 0.2583 | — (0 trials) | 0.2583 |
| 123456789 | 1 | 0.5750 | 0.6333 | **1.0000** | 0.1373 |
| 123456789 | 2 | **1.0000** | 1.0000 | **1.0000** | — |
| 218213831 | 0 | **0.0000** | 0.1333 | — | 0.1333 |
| 218213831 | 1 | 0.5417 | 0.5417 | **1.0000** | 0.0000 |
| 218213831 | 2 | **1.0000** | 1.0000 | **1.0000** | — |
| 171473193 | 0 | **0.0000** | 0.0000 | — | 0.0000 |
| 171473193 | 1 | 0.4000 | 0.4833 | **1.0000** | 0.1389 |
| 171473193 | 2 | **1.0000** | 1.0000 | **1.0000** | — |

Pooled: accuracy 0.6306 / 0.5583 / 0.4944 → **mean 0.5611**; routing
0.5250 / 0.5139 / 0.4667 → **mean 0.5019**. Both reproduce the published values
(max |Δ| < 5e-7 per cell; prototypes in `work/l11_1_prototype/`).

### C.3 The three facts this exposes (DERIVED)

1. **Retrieval is perfect once the bank is resolved.** `accuracy | resolved bank =
   1.0000` in all six cells that have resolved trials, on all three seeds. There is
   no retrieval deficiency anywhere in this arm.
2. **The entire 0.5611 is bank selection.** `0.5611 ≈ 0.5019 × 1.0 + 0.4981 ×
   0.132`, where 0.132 is the measured wrong-bank floor (L10's shuffled-cue arm).
   Cross-signature "accuracy" is a routing rate in disguise.
3. **The routing rate is a deterministic function of task position, not of the
   cue.** 0.0000 for task 0, ≈0.50 for task 1, **1.0000 for task 2 — identical on
   all three seeds.** A capability that "works" with probability 1 or 0 depending
   on which bank index a task happened to receive is not a context capability; it
   is the router's weight mass ordering, set by allocation and training recency.

### C.4 Why this is not a contradiction of L10

L10.3 and L10.4 reported the routing rate honestly (0.5019), and L10.6 recorded
"per-task 0.0–1.0, task-order dependent". Nothing in L10 was misreported. What
L11.1 adds is the **decomposition** (accuracy is routing × perfect retrieval) and
the **invariance across seeds**, which together show that the 1:1 mixed cue has no
principled answer to give: it is an exact tie, so "0.5611" measures an arbitrary
tie-break. That matters because L11's predecessor design (the L10.6 readiness
proposal) proposed "cross-signature compositional generalization" with a threshold
of 0.75 on precisely this number. **0.75 on a quantity whose ceiling is set by
allocation order would have been a meaningless criterion** — it could be passed or
failed by reordering tasks.

### C.5 Consequences adopted in the protocol

1. Composition is measured with **unbalanced** mixtures (`CROSS21`, `CROSS31`),
   where a majority exists and the declared rule predicts a unique bank.
2. The 1:1 case is retained as `AMBIG11` but demoted to a **tie-break compliance**
   check with no accuracy claim.
3. Routing and retrieval are **always reported separately** (`Comp`, `Read`), and a
   pooled number may never appear without its per-cell breakdown.
4. A new **order-permuted control arm (A9)** reverses the task presentation order.
   Rule-following must survive it; if it does not, the result is classified
   `SHORTCUT`, not a pass.
5. The primary comparison is against the **measured null**, never an absolute floor.

---

## D. Scientific definition and cue categories

Full text: `stark/design/l11_cross_signature_compositional_generalization.md` v0.1
(**DRAFT / NOT RATIFIED**). Summary:

> **Cross-signature compositional generalization** = given a cue built from features
> of two or more training signatures, in a **feature-count ratio absent from
> training**, resolve it to the bank prescribed by the **pre-declared R-majority
> rule** — on every task, every seed, and **independently of allocation order** —
> and retrieve correctly from that bank.

Ten categories with distinct causal readings: `TRAIN` (ceiling), `HOLDOUT`
(interpolation control), `CROSS21`/`CROSS31` (capability, monotonicity),
`AMBIG11` (tie-break only), `PARTIAL` (degraded), `MISLEAD` (rule under
contradiction), `OFF` (measured null), `SHUFFLED` (contradictory), `ORDERPERM`
(shortcut control).

**What the design inspects before trusting the split** (VERIFIED in source):

- Features are **disjoint per task**: task `t` owns `4t..4t+3` of the 12 features
  (`makeVTask`, `l10_validation_harness.cpp`). Training pairs are
  `{b+0,b+1}, {b+0,b+2}, {b+0,b+3}, {b+1,b+2}`; withheld pairs `{b+1,b+3}, {b+2,b+3}`.
- Training always presents a **2-feature within-group** pair (`runStream`), so a
  2:1 or 3:1 cross cue is genuinely novel in **count ratio** as well as composition.
- The router is a linear score `score[k] = Σ_{f∈cue} W[f][k]` with a softmax
  (`bankScores`, `ContextConditionedMemory.cpp`), and `W` is updated only for
  features present in the cue. There is **no shared structure across signatures** —
  which is exactly why "composition" here can only mean *rule-governed conflict
  resolution*, not recombination of shared semantics. The specification states this
  limitation explicitly rather than dressing a tie-break up as composition.

---

## E. Instrumentation design

Full text: `stark/design/l11_trial_schema.md` v0.1.

### E.1 The gap, measured not asserted

The L10 trial CSV has 17 columns. The L11 schema requires **35 fields**; the
existing record satisfies **13 (37.1 %)** after renaming
(`master, task, phase, trial, eval_call, eval_kind, selected_bank,
routing_correct, queried, choice, correct, reward, active_bank`). Missing, with the
consequence:

| Missing | Cost already paid in L10 |
|---|---|
| `selected_slot` | the L10.4 anomaly is unattributable — **the value already exists in memory** (`CCResult::sel_slot`) and is simply never written |
| `cue_features`, `cue_category` | a mixed cue is indistinguishable from a correct one per trial |
| `intended_bank` | no record of what a declared rule *prescribes* |
| `bank_score_margin` | a near-tie cannot be told from a decisive wrong choice |
| `update_mass_*` | per-trial credit cannot be reconstructed |
| `run_id`, `protocol_sha256`, `model_hash` | provenance lives only in directory names |

### E.2 Design decisions

- 35 fields, one row per trial, deterministic field order, `\n` endings, `;`-joined
  cue features (CSV-safe), quoted `bank_state`.
- **Explicit absence**: empty field = not measured; `0` is a measurement. Nine
  fields are nullable by design (`intended_bank`, `routing_correct`,
  `bank_score_margin`, `intended_slot`, `selected_slot`, `update_mass_*`,
  `advantage`, `router_update_l1`, `checkpoint_id`, `resume_from_trial`).
- **No model dumps**: state identity is a hash; update mass is two scalars.
- **Additive only**: append fields, consume no extra RNG draw, touch no clamp,
  weight update, reward or scoring path. The writer's only new work is arithmetic
  on data it already has.

### E.3 Prototype evidence (PROTOTYPE_ONLY)

| Check | Result |
|---|---|
| Executable schema + validator, 17 cases | **17/17 PASS** (`schema_check.py --selftest`) |
| Negative controls (missing field, bad type, unsorted/duplicate cue, bad enum, `routing_correct` inconsistent with banks, `OFF` with features, `CROSS21` with one feature, boolean out of range) | all rejected with a named reason |
| Nullable acceptance (explicit absence) | accepted once, and the initial over-strict rule was **corrected after the test failed** — recorded rather than hidden |
| Metric reconstruction from rows only | reproduces the published L10.3 aggregate on **3/3 seeds**, pooled 0.5611 and routing 0.5019 |
| Coverage audit | 13/35 (37.1 %) |

The prototype is deliberately Python and read-only over existing CSVs: it proves
the *schema* is sufficient and the *metrics* are reconstructable. It does **not**
prove the C++ writer works; that is test T7 in the validation plan, and it is not
claimed.

### E.4 Non-interference: standard raised

L10 accepted aggregate equality as evidence of non-interference. **L11.1 rejects
that standard explicitly**: L10.6 showed a single deviating trial can be invisible
in an aggregate. The protocol therefore requires a paired on/off run compared
**per trial** across the 17 projected columns (protocol §10), plus the aggregate
check as a secondary condition. This is DESIGN_ONLY; it has not been executed.

### E.5 Checkpoint / resume and determinism

Byte-identical reruns (uncompressed CSV, `gzip -n` if compressed), `run_id` +
`protocol_sha256` in every row, checkpoint at each task boundary, resume verified
by byte comparison of the post-resume rows. DESIGN_ONLY.

---

## F. Acceptance protocol and pre-registration

- Protocol: `stark/design/l11_1_protocol.md` v0.1, sha256
  **`322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32`**.
- Pre-registration record: `work/L11_1_PREREGISTRATION.json` (protocol hash,
  declared rule, seeds, arms, thresholds, invalid-data rules, execution state).
- **Status: text frozen for review; thresholds PENDING OWNER RATIFICATION.**
  Freezing the hash prevents silent edits; it does not authorise the run.

**Candidate criteria** (unchanged from the readiness proposal except where marked):
L11-A `Comp ≥ 0.90` every task/seed; L11-B `MixAcc − Null ≥ 0.50` on ≥2/3 tasks;
L11-C no cell < 0.50; L11-D `Read ≥ 0.90`; L11-E byte-identical reruns + resume;
L11-F no new regression failures; **L11-G (new, DERIVED from §C)**
`Comp(A2) − Comp(A9) ≥ −0.10` on every seed.

**Threshold validity check performed (DERIVED, exact binomial):** with n = 120
trials/cell the L11-A pass condition is 108/120;
`P(pass | true 0.95) = 0.9928`, `P(pass | true 0.90) = 0.5761`,
`P(pass | true 0.85) = 0.0746`; 95 % Wilson half-width at 0.90 is 5.4 pp. The
threshold is a **discriminating** test against 0.85 (92.5 % rejection) but a coin
flip against exactly 0.90 — so a pass must be worded "consistent with ≥0.90 at
n = 120", never "≥0.90 established". n = 120 is kept rather than raised so the
evaluation convention stays comparable with L10; intervals are mandatory in
reporting.

**Explicit statement: no official L11 evaluation was run.** Zero arms, zero seeds,
zero trials.

---

## G. Validation plan and `test_phase1_affinity`

Full text: `work/L11_1_VALIDATION_PLAN.md` (T1–T14).

**Executed in this task:** T1 (17/17 schema self-tests), T2 (13 negative controls,
all reject), T3 (missing ≠ zero), T4 (reconstruction, 3/3 seeds), T5 (0.5611
reproduced), T6 (coverage 13/35).
**Designed, not executed:** T7 writer round-trip, T8 per-trial non-interference,
T9 determinism, T10 checkpoint/resume, T11 R-majority unit test, T12 negative
controls, T13 positive controls, T14 full regression.

### `test_phase1_affinity` — diagnosis (VERIFIED by compiling)

- 44 `CHECK` assertions. Compiling with `-Isrc/phase1` on Linux fails at
  `DWORD_PTR` (10 uses, lines 138–192) — confirming the reported cause.
- **A type alias alone is insufficient.** Patching a copy in `/tmp` with
  `using DWORD_PTR = std::uintptr_t;` advances the compile and then fails on
  `BOOL` / `GetProcessAffinityMask(GetCurrentProcess(), …)`, i.e. Case C genuinely
  calls the Win32 API outside any platform guard. **The repository file was not
  modified.**
- The library header (`src/phase1/common/HardwareAffinity.h`) already guards itself
  with `#ifdef _WIN32`; the portability defect is in the test only.
- Cases A and B (the deterministic 64-bit mask-enumeration regression) are pure
  arithmetic and portable; Case C (live-API agreement, 3 direct `CHECK`s plus a
  per-CPU loop) is Windows-only.

**Disposition: UNKNOWN / UNEXECUTED.** Not a pass, not a failure, excluded from
any "all tests pass" statement. Two legitimate resolutions are put to the owner in
§H (R2); the recommended default is to guard Case C with `#ifdef _WIN32` and report
`SKIPPED (Win32-only)`, so the portable regression runs on Linux. Until then
nothing is changed.

---

## H. Governance — decisions that genuinely need the owner

| ID | Decision | Recommended default | Why it cannot be assumed |
|---|---|---|---|
| **R1** | Ratify L11 thresholds L11-A … L11-G | ratify as written | thresholds must be fixed before evidence; an agent cannot ratify its own criteria (L10 precedent: A/B/C were asked separately) |
| **R2** | `test_phase1_affinity` disposition | port: guard Case C, portable mask type | modifying an unrelated test is a maintainer decision; the alternative (permanent Windows-only exclusion) is equally defensible and must be written down |
| **R3** | Authorise the additive, default-off instrumentation change to `l10_validation_harness.cpp` | authorise as specified | it is the only source change L11 needs, and L11.1 is a design milestone with no mandate to touch code |

Nothing else requires a decision. With R1–R3 answered, L11.2 is a mechanical
implementation of the protocol above.

---

## I. Changes, tests, limitations

### I.1 Files created (all new; nothing modified or deleted)

| File | Classification |
|---|---|
| `stark/design/l11_cross_signature_compositional_generalization.md` | DESIGN_ONLY (v0.1 draft) |
| `stark/design/l11_1_protocol.md` | DESIGN_ONLY, **frozen hash** |
| `stark/design/l11_trial_schema.md` | DESIGN_ONLY |
| `work/L11_1_VALIDATION_PLAN.md` | DESIGN_ONLY |
| `work/L11_1_PREREGISTRATION.json` | DESCRIPTIVE (hashes, thresholds pending) |
| `work/L11_1_MANIFEST.md` | DESCRIPTIVE |
| `work/l11_1_prototype/schema_check.py` | PROTOTYPE_ONLY |
| `work/l11_1_prototype/recompute_from_trials.py` | PROTOTYPE_ONLY |

### I.2 Tests actually executed

| Command | Result |
|---|---|
| `python3 work/l11_1_prototype/schema_check.py --selftest` | 17/17 PASS, exit 0 |
| `python3 work/l11_1_prototype/schema_check.py --coverage <L10.3 trials>` | 13/35 fields, 37.1 % |
| `python3 work/l11_1_prototype/recompute_from_trials.py <L10.3 trials> --eval-kind 4 --metrics …` ×3 seeds | `match = true` on all three; pooled 0.5611 / 0.5019 |
| `g++ -fsyntax-only` of the affinity test (unpatched) | fails at `DWORD_PTR` — expected, documented |
| `g++ -fsyntax-only` of a `/tmp`-patched copy | advances past `DWORD_PTR`, fails at `BOOL` / Win32 call — the evidence behind R2 |
| manifest verification of L10.3 evidence | 245/245 |

### I.3 Tests **not** run (and not claimed)

The L11 test set T7–T14; the full L10 regression battery (26/26 is **inherited**
from L10.4 and was not re-executed — no source changed in L11.1, so that is an
expectation, not a measurement); `test_phase1_affinity` (unexecuted); any L11 arm;
any model training.

### I.4 Git

Branch `validation/l11-1-specification` from `ba1cfb3`. Two commits:
`77d261aa83ddbf3aac1abc800c7c5c89741a86c7` (all artifacts; the protocol text is
frozen there), then a seal commit that fills the commit fields in
`work/L11_1_PREREGISTRATION.json`, this report and the manifest — the protocol
hash `322078c8…` is identical in both. Pushed to `origin` under the same branch
name; local == remote and tree clean verified after the push; PR #2 and #3
untouched; **no new PR**.

### I.5 Limitations of this milestone

1. It defines a capability; it **demonstrates nothing** about the system.
2. The definition is scoped to a two-signature toy cue space; it cannot distinguish
   R-majority from any other rule that predicts the same resolutions in that space
   (stated in the specification §4).
3. The `held_out` seeds 7 and 42 are held out from **L11 design**, not from all
   prior exposure (they were L10.4 auxiliary seeds) — disclosed in the protocol.
4. Instrumentation feasibility is proven in Python over existing CSVs, **not** in
   the C++ writer.
5. The non-interference standard is specified but not executed; until it is, the
   claim "instrumentation does not perturb the experiment" is unproven.
6. The unratified thresholds could still change; they are marked PENDING
   everywhere, and no result exists that they could bias.
7. `test_phase1_affinity` remains UNEXECUTED.

---

## J. Progress

**≈57 %, unchanged.** A specification, a schema and a reproduction of an existing
number are not new cognitive capability. The estimate moves only when a capability
is demonstrated by a controlled experiment, which has not happened.
