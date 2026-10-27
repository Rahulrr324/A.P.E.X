# STARK-L10.6 — Milestone Sign-off and L11 Readiness Assessment

**Status:** verification and readiness only. **No experiment was run, no source
file was modified, no threshold or metric definition was touched, no frozen
evidence was regenerated or rewritten, and no L10 result was recomputed as a
*new* measurement.** Everything numeric below is either (a) read from committed
evidence, or (b) recomputed **from** that committed evidence by a script run in
this task — the two are labelled separately throughout.

**Bottom line.** L10 is **signed off as CLOSED**, with one retained historical
failure (L10-E), two criteria superseded and preserved (L10-F, L10-G), and one
unresolved single-trial anomaly that is bounded and demonstrably not
decision-relevant. L11 readiness verdict: **READY WITH PREREQUISITES**.
Milestone progress stays **≈57 %** — this task added no capability, so it cannot
move the number.

---

## A. Provenance (established before anything was read or written)

| Item | Verified value |
|---|---|
| Repository | `Rahulrr324/A.P.E.X` (private), origin `https://github.com/Rahulrr324/A.P.E.X.git` |
| Session start branch / commit | `validation/l10-5-milestone-closeout` @ `0155fdb4d4e8b2c2a0dd44781f9863a31e51adce` |
| Working tree at start | clean (`git status --porcelain` empty) |
| Local == remote at start | `git ls-remote origin` → `refs/heads/validation/l10-5-milestone-closeout` = `0155fdb…` |
| Acceptance specification | `stark/design/context_conditioned_memory_milestone.md` **v1.8**, sha256 `aafd00aad8c2b843410f2a88fdf3f64cbeb2c10c39f7470f43c5a2bafe33ffd1` — identical in the working tree **and** in `git show HEAD:` |
| Registered L10-K1 protocol | `work/l10_raw/official_evaluation_20261024/protocol/l10_4_official_evaluation_protocol.md` v1.1, sha256 `249d5074…`; registration commit `e32043c`; correction note `9b8f5af` |
| L10.5 decision record | `stark/reports/L10_5_OWNER_DECISION.md` |
| Ancestry | `aed9c30` (L10.4 official evaluation) and `082856c` (L10.3 decision record) both confirmed ancestors of `0155fdb` via `git merge-base --is-ancestor` |
| Validation branch used | **`validation/l10-6-signoff`**, created with `git checkout -b … 0155fdb…` |

**Pull-request state (unchanged, verified before the work and again at the end):**

| PR | Head | Base | State |
|---|---|---|---|
| #2 | `5f5a577…` | `main` | OPEN |
| #3 | `49cc6ba…` | `arena/c90f7329-a-p-e-x` | OPEN |
| #1 | — | — | MERGED (not touched) |

No existing PR head was moved. The validation branch is a fresh branch off the
verified L10.5 commit and is pushed only under its own name.

**Scope discipline at start.** Nothing was assumed from prior reports: branch,
HEAD, tree cleanliness, remote refs, PR heads, spec hash (twice, from two
sources), ancestry and protocol hash were each re-derived in this task before a
single file was opened.

---

## B. What this task did and did not execute

| Activity | Status |
|---|---|
| Full L10 evaluation re-run | **NOT executed** (prohibited) |
| Any new experiment (including the channel-slot diagnostic) | **NOT executed** (prohibited; a proposal exists, see §G.6) |
| Changes to C++, tests, evaluators, thresholds, seeds, task construction | **None** — `git diff` at the end touches only new `work/` files |
| Changes to frozen evidence (`work/l10_raw/**`) | **None** |
| Manifest hash "repair" | **None** — discrepancies explained, not fixed |
| Hash verification of evidence artifacts | **Executed** (read-only, no regeneration) |
| Recomputation of criteria from committed per-seed rows | **Executed** (this is derivation from stored evidence, not a new run) |
| Regression suite | **NOT re-executed in L10.6** — inherited from L10.4 and labelled as such (§J) |

---

## C. Governance audit — do the owner decisions match the spec, and did they change anything they shouldn't?

### C.1 The three decisions

`stark/reports/L10_5_OWNER_DECISION.md` §2 records three questions asked
**separately**, answered by `Rahulrr324` on 2026-10-24, each with **option 1**,
with an explicit statement that the agent has no approval authority. The
authoritative §13 entry (v1.8) records the same three answers:

| Decision | Question | Answer | Effect in the specification |
|---|---|---|---|
| **A** | L10-E disposition | retain the original failure, close as historical | one annotation row: "RETAINED AND CLOSED as a historical failure" |
| **B** | L10-F disposition | mark superseded and closed by L10-F2, preserve the failure | one annotation row: "SUPERSEDED AND CLOSED by L10-F2" |
| **C** | L10-G disposition | record the confounded result as superseded by L10-G2, preserve result and disclosure | one annotation row: "SUPERSEDED by L10-G2" |

Plus one milestone-closure status paragraph and the v1.8 revision entry. **Nothing
else.** The three answers are semantically identical to what the v1.8 text says;
no answer was widened, softened or reinterpreted on promotion.

### C.2 Did each decision change only the intended governance state?

- `git diff 082856c HEAD -- stark/design/context_conditioned_memory_milestone.md`
  = **+51 / −5**.
- **All five deletions are in the version header** (`**Version:** 1.7` and three
  narrative lines replaced by their v1.8 equivalents). No threshold, criterion
  text, seed list, metric definition or measured value was deleted anywhere.
- A per-ID checksum comparison of every original criterion row (L10-A … L10-J)
  between the **v1.6** text (`082856c`) and **v1.8** (`HEAD`) shows **all 11 rows
  byte-identical**. The additions are three `(status, added in v1.8)` rows, one
  closure paragraph, and the v1.8 revision entry.

**Conclusion: the change is purely additive apart from the version line, and the
frozen criteria are demonstrably intact.**

### C.3 Was any historical measurement rewritten?

No. L10-E is still recorded at **0.425926** against its unchanged **0.40**
threshold and still reads **FAILED**. L10-F is still recorded as **FAILED**. L10-G
is still recorded as a **PASS on a confounded arm**, with the confound disclosure
retained. L10-K1 is still an official **PASS** under an unmodified protocol with
untouched 0.40 / 0.25 / 0.50 thresholds. The v1.8 text says so explicitly
("What did not change"), and the numbers were independently re-derived in this
task (§E) — they match the published values exactly.

### C.4 Does "closure" mean the milestone passed?

No, and the specification is explicit about this. Closure is a **governance act**:
every criterion now has a final recorded outcome. It does **not** convert L10-E
to a pass, rescind the failure, assert that context is unnecessary, or hide the
one unexecuted test. Two criteria reached their final state by *supersession*,
which is a change of the governing requirement — never of the recorded result.
That distinction is preserved in the spec and is preserved here.

---

## D. Evidence integrity — manifests, checked not repaired

Manifests were verified by an independent script written in this task (64-hex
fields, two-space separator, path resolution against the repo root, deliverable
section handled separately from the evidence section). No file was regenerated:

| Evidence set | Entries verified | Discrepancies | Explanation |
|---|---|---|---|
| `spec_ratification_20261024/` (L10.2) | 275 | 1 | `stark/src/learning/l10_validation_harness.cpp` — manifest records the file as it stood at the **L10.2 commit** (`f501730f…`); the file was legitimately amended in later L10.3/L10.4 work |
| `control_validation_20261025/` (L10.1) | 275 | 1 | same file, manifest hash `afdf6c8b…`; matches the file at **that milestone's** commit |
| `context_contribution_20261024/` (L10.3) | 245 | 0 | L10.3 introduced no harness change |
| `official_evaluation_20261024/` (L10.4, evidence section) | 124 | 0 | — |
| `official_evaluation_20261024/` (L10.4, full manifest incl. spec deliverable) | 129 | 1 | spec entry records v1.7; the repository now carries **v1.8** — expected consequence of the later promotion |
| `closeout_20261024/` (L10.5) | 10 | 0 | — |

**Why these are explained and not fixed.** A manifest is a statement about the
tree *at the moment the evidence was sealed*. Later amendments to a source file
are legitimate history; rewriting the recorded hash would destroy the only
evidence that the amendment happened and when. The definitive check was done
against git history rather than by trusting the explanation: for each milestone
commit, `git show <commit>:stark/src/learning/l10_validation_harness.cpp` was
hashed and compared to the manifest value — **each manifest matches its own
milestone**, confirming the files were amended afterwards and the manifests are
correct as sealed. The current working-tree hash (`697b5f8a…`) differs from all
manifests, as it must.

**Did the amendment change any measured number?** No. The L10.2 `R0` arm and the
L10.4 `K1` arm metrics and sealing CSVs were compared directly: for all three
masters, `metrics_*` and the sealing CSVs are **byte-identical (6/6)**. The
harness extension added output coverage, not behaviour.

---

## E. Independent recomputation vs read-only inspection

Every item below was recomputed **in this task** from the committed per-seed
rows, using the repository's own committed evaluator
(`analysis/l10_k1_evaluate.py`, sha256 `987a3ff3…`) or small independent scripts.
No model was executed. "Read-only" marks facts that were inspected, not derived.

### E.1 L10-K1 — reproduced: **PASS**

| Master seed | CAA pooled | CRA pooled | Clause (a) ≥0.40 | (b) ≥0.25 on ≥2/3 | (c) ≥0.50 |
|---|---|---|---|---|---|
| 123456789 | 0.5185 | 0.6667 | pass | pass | pass |
| 218213831 | 0.5917 | 0.6667 | pass | pass | pass |
| 171473193 | 0.6296 | 0.6667 | pass | pass | pass |
| **grand pooled CAA** | **0.5799** | — | — | — | — |

Matches the L10.4 published result exactly. The same script independently flags
the single deviating forced-bank cell discussed in §G — the evaluator and the
sign-off agree on where the anomaly is.

### E.2 L10-E — reproduced: **FAILED** (retained)

Context-off pooled **0.425926 > 0.40** → FAIL; shuffled-cue pooled **0.132407**
≤ 0.40. Per-task values recomputed from the K1 metrics CSVs match the report. The
criterion is arithmetically floored at ≈1/3 by the task draw (§13), which is why
L10-K1 exists — but that is an explanation of *why the criterion is weak*, not a
rescue of the result. It stays **FAILED**.

### E.3 L10-E2 — reproduced: **PASS**

Per-seed margins (correct-context − context-off / correct-context − shuffled):

| Seed | margins vs off | margins vs shuffled |
|---|---|---|
| 123456789 | 0.0000, 0.8333, 0.6667 | 0.7333, 0.8333, 0.7417 |
| 218213831 | 0.0000, 0.8333, 0.8333 | 0.8583, 0.9167, 0.9000 |
| 171473193 | 0.0000, 1.0000, 1.0000 | 1.0000, 0.9000, 0.9250 |

≥0.60 on two of three tasks under both comparisons on every seed → PASS. (The
first task sits at 0.0000 on all three seeds, which is a genuine structural
feature, not a measurement gap: the fallback bank's permutation coincides with
task 1.)

### E.4 Forced-bank cell structure — recomputed over all 27 cells

All nine diagonal cells (bank k / task k) are **exactly 1.000000** across
**1,080** trials — zero readout slips on the diagonal. The 18 off-diagonal cells
take only the values 0 (5 cells), 1/6 = 20/120 (10 cells), 1/3 = 40/120 (2 cells),
plus the single 1/120 outlier. The `agreement(perm_k, perm_t)/6` model fits 26 of
27 cells exactly.

### E.5 Cross-signature and capacity — read-only inspection of L10.3 evidence

Cross-signature (mixed-feature / novel-cue) accuracy, `KC_cross/`:
per-seed **[0.2583, 0.6333, 1.0000], [0.1333, 0.5417, 1.0000], [0.0000, 0.4833,
1.0000]**; pooled **0.5611**; minimum **0.0000**. Hold-out (single signature)
**0.99815**. Capacity (exploratory, `GEN/`): T4K4 0.9993, T5K5 0.9989, T8K8
0.9920 with zero forgetting; the only capacity failure in the record is
K=2/T=3 (L10-G2: final 0.6361, forgetting 0.2713 vs CCM 1.0000 / 0.0000).

These are *inspected* numbers, not recomputed criteria — they belong to L10.3
exploratory arms and carry no criterion status.

---

## F. What L10 established, and what it did not

### Established (on recorded evidence)

1. **Context-selective allocation works at this scale.** With a correct cue the
   system routes to the right memory bank on every task (CRA pooled 0.6667 =
   forced-bank ceiling), and this survives three independent master seeds and the
   four exploratory seeds.
2. **Context contributes measurably against a measured null.** L10-K1 PASS with
   grand pooled CAA 0.5799, i.e. the correct cue beats a context-ignoring forced-bank
   policy by a wide margin — this is the criterion that now carries the
   context-contribution claim, and it is a *separate* criterion from L10-E.
3. **Forgetting is effectively absent under the tested regime** (CCM mean
   forgetting ≤0.10, final average ≥0.85), and **sealing is load-bearing**: L10-F2
   PASSED on all four pre-registered conditions with `commit_trials = 240`, while
   the original F could not test sealing at all (`commit_trials = 480` → no sealing
   opportunity, unsatisfiable by construction).
4. **Capacity, not routing, is the binding constraint.** With bank scarcity
   (K=2, T=3) the system degrades hard (0.6361 / 0.2713). With adequate banks it
   is at ceiling regardless of task/feature count.
5. **Determinism, persistence, checkpoint resume are exact** (L10-H), and the
   whole L10 evidence chain is hash-auditable and reproducible from committed
   artifacts.

### Not established (and must not be read into the above)

1. **L10-E is a historical FAILURE and stays one.** 0.425926 > 0.40. L10-K1's
   PASS **does not convert it**, does not rescind it, and does not license the
   claim "context is necessary" as a general statement. The correct reading is
   narrower: context *contributes against a measured null*.
2. **Context selects a bank; it does not modulate retrieval within a bank.** Every
   mechanism in this milestone routes at the bank level. Within-bank selection,
   feature-level attention and cue-composition effects are **unmeasured** here.
3. **Cross-signature compositional generalization is weak.** Pooled 0.5611 with a
   seed that reaches **0.0** on one task; the spread across tasks (0.0–1.0)
   suggests task-order dependence rather than a general capability.
4. **Toy scale ≠ general compositional intelligence.** K≤6 banks, binary
   features, 120-trial cells. Nothing here extrapolates to open-ended reasoning.
5. **`test_phase1_affinity` is UNEXECUTED** — it cannot build on this platform
   (`DWORD_PTR` is Windows-only). It is neither passed nor failed, and it is
   excluded from any "all tests pass" statement.
6. **One forced-bank trial is unexplained** (§G).

---

## G. The L10.4 one-trial anomaly — investigated, bounded, **UNRESOLVED**

### G.1 The fact

In the forced-bank sweep with the cue removed, cell `(seed 218213831, task 1,
forced bank 2)` records accuracy **0.008333 = 1/120** where the analytic model
requires **0.000000**: the permutations of task 1 and bank 2 have no fixed point,
so a context-ignoring readout under a correct channel selection should never
agree with the task's mapping. It happened once in 120 trials.

### G.2 What is known directly (from source and raw records)

- It is the **only** deviation among 27 cells; the model
  `agreement(perm_k, perm_t)/6` fits the other 26 exactly.
- Diagonal cells are perfect: 1,080 trials, zero slips.
- Hold-out combined slip rate is 2/1,080 = 0.00185, so a rare per-trial
  mis-selection or mis-read is a **normal** feature of this system, not
  evidence of a design fault.
- The trial path is: 3 eligibility gates → 4 cue window → 5 sample window
  (candidate set driven from the **active** bank) → 6 interference → 7 decision
  window (spike-count majority over the target bank, tie-break by earliest spike
  then a seeded draw) → 9 REINFORCE. Any of steps 4–7 is noise-sensitive.
- The generator has `explore_eps = 0.2`; exploration perturbs routing, and the
  forced-bank arm deliberately drives the *wrong* bank, so the trial is being
  asked a question the architecture was never trained to answer.

### G.3 What mechanism could explain it — and what was ruled out

- **Ruled out as the sole explanation: "channel-attention mis-selection" as a
  systematic effect.** Under cue-off, the readout is driven by interference and
  background input, and the decision window resolves by spike-count posterior.
  A systematic mis-selection would have produced many more than one match; the
  observed pattern is a single extra spike-count win.
- **Modal explanation (supported by the cell-value histogram):** the readout
  settles on `P = agreement/6` per trial, and **one** trial under thermal noise
  won the count comparison it should have lost. That is exactly a 1/120
  excursion, and it is consistent with the 2/1,080 slip rate elsewhere.
- **Alternative not yet excluded:** a tie-break or eligibility edge case on a
  near-tie (`posterior ∝ exp(β·Δcount)` is near-uniform at Δcount ≈ 0), or an
  off-by-one in the interference window for one trial.

### G.4 What is missing

**Per-trial records for the forced-bank sweep.** The harness writes only
`ctxperbank_*.csv` with one aggregate accuracy per (task, bank)
(`writePerBankCtxCsv` → `master, task, bank, acc_cue_off`), and
`runStream` passes `rows = nullptr`. The deviating trial therefore **cannot be
inspected at trial granularity**, and no amount of re-reading the stored
aggregates can separate "spike-noise win" from "tie-break edge case". That is the
single missing observable.

### G.5 Does it affect any acceptance decision? **No — quantitatively.**

- Setting the cell to zero moves that seed's CAA_pooled by **0.000926**
  (0.591667 → 0.592592), against a margin of **0.1917** to the 0.40 floor.
- Reversing L10-K1 clause (a) would take ≈**69** such trials; clause (b) ≈**30**
  on a single task; clause (c) **20** routing misses **per task**.
- The observed rate is 1 in 3,240 forced-bank trials. No threshold, no pass/fail
  and no reported number is within reach of it.
- It cannot touch L10-E: that failure is a *pooled context-off/correct-context*
  comparison, and removing a wrong-bank match would if anything *lower* the
  forced-bank arm — moving it further from passing, not toward it.

### G.6 Would a new experiment help? Yes, but it was not authorised — proposal written

A focused diagnostic *would* resolve the attribution. It was **not run** (that
was prohibited, and this task has no authority to run it). A separately written
protocol is filed at:

> **`work/L10_6_PROPOSED_channel_slot_diagnostic.md`** — **PROPOSED / NOT
> EXECUTED.**

It proposes an opt-in, default-off instrumentation flag adding `sel_slot`,
`intended_slot`, `retrieved_id` and `counts_top2` to forced-bank trial rows, with
no threshold, mechanism or seed change, and explicitly *no* pass/fail criterion.
It is registered nowhere, authorises nothing, and is kept entirely separate from
the L11 proposal in `work/L11_READINESS_ASSESSMENT.md`. **The anomaly remains
unresolved**, and is carried forward as a known limitation rather than a defect
or a resolved question.

---

## H. Limitations of this sign-off

1. **Every number here is derived from evidence sealed by earlier tasks.** No
   model was executed in L10.6. Where a criterion was "recomputed", the
   computation re-reads committed per-seed rows — it verifies arithmetic and
   consistency, **not** that the model still behaves that way today.
2. **The regression suite was not re-run** (§J). Its status is inherited.
3. **Trial-granular behaviour of the forced-bank arm is unobservable** with the
   current harness (§G.4).
4. **`test_context_conditioned_memory.cpp` is thin** — 2 assertions for the whole
   CCM subsystem. Structural coverage of cross-signature behaviour lives in
   `test_l10_structural_audit.cpp`; behavioural coverage does not.
5. **Cross-signature and capacity numbers are exploratory**, not criteria, and
   their per-seed spread is large enough that a single seed should not be quoted
   alone.
6. This document **cannot authorise** anything. It records findings and a
   recommended next milestone; it does not approve an L11 protocol.

---

## I. Formal disposition

| Criterion | Final state | Basis |
|---|---|---|
| L10-A | **satisfied** | recomputed / recorded |
| L10-B | **satisfied** | recorded |
| L10-C | **satisfied** | recorded |
| L10-D | **satisfied** | recorded |
| **L10-E** | **FAILED — retained, closed as historical failure** | independently reproduced (0.425926 > 0.40) |
| L10-E2 | **satisfied** | independently reproduced |
| L10-K1 | **PASS** (official, v1.1 protocol) | independently reproduced |
| L10-F | **FAILED — superseded and closed by L10-F2** | reproduced from record; dissatisfaction by construction |
| L10-F2 | **satisfied** | recorded (owner ratification A-1) |
| L10-G | **PASS on a confounded arm — superseded by L10-G2** | recorded, confound preserved |
| L10-G2 | **satisfied** | recorded (owner ratification A-3) |
| L10-H | **satisfied** | recorded |
| L10-I | **satisfied on the L9 baseline** | inherited; **not re-executed** |
| L10-J | **satisfied** | this document + v1.8 record |

**Milestone disposition: L10 CLOSED (2026-10-24).** Closed means *every criterion
has a final, recorded, non-provisional outcome and the governing specification is
frozen at v1.8 with owner decisions on record*. It does **not** mean L10 passed,
and it does **not** close the anomaly.

---

## J. Regression status — executed vs inherited vs unknown

| Category | Status |
|---|---|
| **Executed in this task** | hash verification of all evidence manifests; recomputation of L10-K1, L10-E, L10-E2, 27-cell structure, cross-signature and capacity aggregates from committed rows; `git`-history harness-hash cross-check; byte-identity comparison of L10.2 `R0` vs L10.4 `K1` |
| **Inherited (previously verified, not re-run in L10.6)** | 26/26 regression battery from L10.4, including `test_l10_1_sealing` (276 assertions), `n_way_learned_relevance_loop_L8` (verdict PASS), `test_phase1_profiler` (34), `test_phase1_accounting` (67), `test_phase1_budget` (55), `test_phase1_records` (72), `test_phase1_reproducibility` (37), `test_phase1_gates` (437) |
| **Unknown / unexecuted** | `test_phase1_affinity` — cannot build on this platform (`DWORD_PTR`); **not** a pass and **not** a new failure |

No claim in this document should be read as "the suite passed in L10.6". It was
run in L10.4; L10.6 did not change any source file, so the inherited status is
expected to hold — expectation, not measurement.

---

## K. Deliverables, integrity and progress

| File | Purpose |
|---|---|
| `work/L10_6_MILESTONE_SIGNOFF.md` / `.json` | this sign-off |
| `work/L11_READINESS_ASSESSMENT.md` / `.json` | L11 readiness verdict and one concrete L11 proposal |
| `work/L10_6_PROPOSED_channel_slot_diagnostic.md` | **PROPOSED / NOT EXECUTED** diagnostic protocol for the anomaly |

**Files changed in this task:** new `work/` files only. No change to
`stark/src/**`, `stark/tests/**`, `stark/CMakeLists.txt`,
`stark/design/**` or `work/l10_raw/**`. No threshold, metric, seed or criterion
modified. No frozen evidence overwritten.

**Progress estimate: ≈57 %, unchanged.** Documentation, governance verification
and readiness assessment add no capability, so they cannot move the milestone
number.

**Recommended next milestone:** **STARK-L11 — Cross-Signature Compositional
Generalization.** Rationale and full pre-registered protocol outline in
`work/L11_READINESS_ASSESSMENT.md`, §E.
