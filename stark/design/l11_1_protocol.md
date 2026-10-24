# STARK-L11 — Registered Experiment Protocol v0.1

**Protocol status:** text **FROZEN FOR REVIEW** (sha256 recorded in
`work/L11_1_PREREGISTRATION.json`). **Thresholds PENDING OWNER RATIFICATION.**
**No official measurement may be collected until the owner ratifies §7.**
**This protocol has NOT been executed.** `OFFICIAL_EVALUATION_NOT_RUN`.

**Subject specification:** `stark/design/l11_cross_signature_compositional_generalization.md`
v0.1 (draft).
**Trial record schema:** `stark/design/l11_trial_schema.md`.
**Predecessor (closed, unmodified):** `context_conditioned_memory_milestone.md` v1.8.

---

## 1. Purpose and claim

Establishes whether the CCM agent resolves cues composed of features from two or
more training signatures according to a pre-declared rule (R-majority), on every
task, seed and allocation order, while preserving retrieval from the resolved bank.

The protocol measures **composition and retrieval separately**. It never reports a
single pooled accuracy as the primary result.

## 2. What is executed

Existing binaries, no new learning mechanism:

- `stark/src/learning/l10_validation_harness.cpp` extended **only** by the
  trial-writer fields specified in `l11_trial_schema.md` §3 and the six new cue
  modes in §4 below (`CROSS21`, `CROSS31`, `AMBIG11`, `MISLEAD`, `ORDERPERM`,
  plus the `TRAIN`/`HOLDOUT`/`PARTIAL`/`OFF`/`SHUFFLED` modes that already exist).
  **No change** to `ContextConditionedMemory.cpp`, `RelevanceRouting.cpp`,
  `Network.cpp`, any configuration value, any threshold, or any L10 artifact.
- One driver invocation per (arm, seed), each writing its own output directory.

## 3. Configuration (fixed)

| Parameter | Value | Note |
|---|---|---|
| tasks / banks | 3 / 3 | L10 configuration |
| identities / responses | 6 / 6 | `makeLRMapping(master + kPiOffsets[t], 6, 2)` |
| features | 12 (4 per task, disjoint) | task `t` owns features `4t..4t+3` |
| trials per task | 120 singles + 240 pairs | unchanged from L10 |
| `commit_trials` | 480 | unchanged |
| `seal_superseded` | true | unchanged |
| `explore_eps` | 0.2 | unchanged |
| evaluation trials | 120 per (task, cue category) | 20 per identity, learning disabled |
| evaluation snapshot | serialized/restored around every call | measurement cannot perturb learning |

## 4. Cue constructions (exact)

`g(t)` denotes task `t`'s feature group `{4t, 4t+1, 4t+2, 4t+3}`.

| Category | Construction | Draw source |
|---|---|---|
| `TRAIN` | pair from the task's 4 training pairs | `rng_cue(seed ^ 0x5bd1e995)` — as L10 |
| `HOLDOUT` | pair from the task's 2 withheld pairs | same stream, index `pick & 1` — as L10 |
| `CROSS21` | 2 features from `g(t)`, 1 from `g(o)`, `o ≠ t` | `rng_cross(seed ^ 0x1f83d9ab)`, first draw selects `o`, remaining draws select within-group indices |
| `CROSS31` | 3 features from `g(t)`, 1 from `g(o)` | same stream, separate prefix |
| `AMBIG11` | 1 feature from `g(t)`, 1 from `g(o)` | same stream, separate prefix |
| `MISLEAD` | 2 features from `g(o)` only (the *wrong* group) | same stream, separate prefix |
| `PARTIAL` | one feature of a `TRAIN` pair, alternating | as L10 |
| `OFF` | empty cue | as L10 |
| `SHUFFLED` | `TRAIN` pair of another task | as L10 |
| `ORDERPERM` | identical construction to `CROSS21` | identical stream to `CROSS21` |

**Duplicate-feature rule:** within a `CROSS` cue the selected indices must be
distinct; a draw that repeats an index is redrawn from the same stream
(documented, deterministic, no rejection loop that can consume unbounded draws —
at most 4 redraws, then the trial is marked `cue_modified=1` and recorded).

**Count ratio:** `CROSS21` and `CROSS31` are **absent from training** — training
only ever presents 2-feature within-group pairs. The ratio is therefore novel, not
merely the combination.

**Order-permuted training (A9):** identical to the standard run except the
presentation order is `order = [2,1,0]` instead of `[0,1,2]`. Everything else,
including evaluation seeds and the RNG streams, is unchanged.

## 5. RNG stream separation (fixed)

| Stream | Seed | Consumers |
|---|---|---|
| task permutations π | `master + kPiOffsets[t]` | `makeLRMapping` |
| trial schedule | `master + 1000t` (+1 for the pair phase) | `makeLRTrials` |
| training cue index | `master + 6001 + t` | L10, unchanged |
| probe pool | `master + 6100 + t` | allocator |
| evaluation schedule | `evaluation seed = master + 9300` | `evalTask` |
| evaluation cue | `eval_seed ^ 0x5bd1e995` | as L10 |
| shuffled-cue draw | `master + 9500` | as L10 |
| **cross-family draw** | `master + 9600` | **new; used only by A2/A3/A4/A6/A9/A10** |

The new stream is additive: it is instantiated only when a cross-family category
is requested, so every L10 arm reproduces bit-for-bit (asserted in the
paired on/off test, §10).

## 6. Metrics (exact definitions)

Per (seed, task, category), with `n` = number of valid trials:

- `routing = (1/n) Σ 1[first_feature_group(bank) == t]`
  — i.e. the selected bank is the bank that owns task `t`.
- `correct = (1/n) Σ 1[choice == perm[queried]]`
- `Comp = routing` on `CROSS21` / `CROSS31` / `ORDERPERM` — this is the
  R-majority compliance rate. For `AMBIG11` the prescribed bank is the
  **lowest-index** of the two groups (declared tie-break).
- `MixAcc = correct` on the composition arms.
- `Read = mean(correct | routing == 1)` — retrieval given correct resolution.
- `Null(t) = mean(correct)` over `OFF` trials with each bank forced in turn
  (three forced cells averaged equally) — the measured context-ignoring null,
  identical in construction to L10-K1's `acc_null`.
- `ShufAcc = correct` on `SHUFFLED`.
- Derived, reported but not criteria:
  `CompInflation = Comp(A2) − Comp(A9)`;
  `WrongBankAcc = mean(correct | routing == 0)`.

**Aggregation:** per-seed per-task values are primary. A pooled value is the
unweighted mean over the three tasks, reported alongside. No metric is ever
computed from a pooled count.

## 7. Acceptance criteria

As specified in the specification §6: L11-A … L11-G.
**Status: PENDING OWNER RATIFICATION.** Until ratified, this protocol authorises
data collection only if the owner explicitly directs it; it does not itself
authorise an official run.

## 8. Validity and missing-data rules

A trial is **invalid** and excluded from every metric only if:
(i) `selected_bank == -1` (no allocatable bank) — counted as a routing failure in
`routing` but excluded from `Read`;
(ii) the evaluation call delivered fewer than 120 trials — the **whole call** is
invalid and reported as such, never partially aggregated;
(iii) a required non-nullable field is empty or malformed (schema rejection).

Rules that are never permitted: imputing a missing accuracy as 0; dropping a
deviating trial; excluding a bank, task or seed after seeing results; switching
between "pooled" and "per-cell" reporting after the fact.

## 9. Determinism and checkpoint/resume

- Two full reruns of the same (arm, seed) must produce **byte-identical** trial
  CSVs (uncompressed CSV, `\n` line endings, fixed field order; gzip only with
  `-n`, never with a timestamp).
- Every row carries `run_id` and `protocol_sha256`; a mismatch between the protocol
  hash in the row and the registered hash invalidates the run.
- Checkpoint at the end of every task step; resume must reproduce the subsequent
  trial stream byte-identically from the checkpoint onward.

## 10. Non-interference (instrumentation-on/off)

Two runs of the same (arm, seed), one with `--emit-schema l11`, one without, must
produce:
(a) **identical per-trial rows** for the 17 L10 columns (byte comparison after
column projection), and
(b) identical aggregate metrics.
Requirement (a) is the real test: matching aggregates alone is explicitly
**not** accepted as evidence, because L10.6 showed a single deviating trial can be
invisible in aggregates. If (a) fails, the instrumentation is non-conforming and
the milestone stops.

## 11. Exactness checks (cheap, because the task space is enumerable)

- `agreement(perm_a, perm_b)` for all 9 bank/task pairs is computed and printed at
  run start; the wrong-bank chance floor per task is `agreement/6`.
- All 27 forced-bank cells are enumerated (as in L10.4) and each is compared with
  the analytic `agreement/6` model; deviations are reported individually.
- R-majority predictions for every distinct `CROSS21`/`CROSS31` cue are enumerated
  and checked against the writer's `intended_bank` field before any run is scored
  (a unit test, not a measurement).

## 12. Runtime and resources

Single-threaded, no GPU. L10 measured a full 3-master evaluation in the low
minutes per arm; L11 adds 11 arms × 7 seeds ≈ 77 driver invocations, dominated by
training (2,160 learning trials per run). Estimated wall clock: < 60 min on the
reference Linux container, peak RSS < 300 MB, artifact volume < 200 MB before
compression. These are estimates, not measurements, and are re-checked on the
first arm before a full sweep.

## 13. Artifact manifest format

`MANIFEST.md` per evidence directory: one line per file,
`<64-hex sha256><two spaces><path relative to repo root>`, evidence files first,
then a `## Deliverables` section. Byte-identical in format to the L10 manifests so
the existing verifier applies unchanged.

## 14. Execution status

**NOT EXECUTED.** No arm of this protocol has been run at the time of writing.
STARK-L11.1 delivered the text, the schema, the prototype tooling and the
validation plan only.
