# STARK-L10.4 — Acceptance Specification Update and the Official L10-K1 Evaluation

**Milestone status:** complete. The acceptance specification is now internally
consistent (v1.7), the official L10-K1 evaluation has run under a frozen
protocol, been recomputed independently, passed the full regression battery, and
produced a mechanical disposition.

**Headline**

| Criterion | Governing version | Status | Number |
|---|---|---|---|
| **L10-E** (context, retained) | v1.6 → v1.7 **unchanged** | **FAILED** (historical, retained) | context-off 0.425926 > 0.40; shuffled 0.132407 |
| **L10-K1** (context contribution, new) | **v1.7** (owner Option B) | **PASS** | CAA_pooled 0.5185 / 0.5917 / 0.6296; CRA_pooled 0.6667 on every seed |
| L10-A/B/C/D/F2/G2/H | as recorded | PASS (unchanged) | — |
| L10-F | v1.6 | FAILED (historical, unsatisfiable as written) | retained |
| L10-I / L10-J | v1.6 | no new failures / reported honestly | 26/26 regression targets exit 0 |

Passing L10-K1 does **not** change L10-E. Both are reported side by side.

---

## A. Provenance

Verified against the live repository and GitHub before any change.

| Item | Value |
|---|---|
| Repository | `Rahulrr324/A.P.E.X` (private, `main` @ `563395f1…`) |
| Starting branch | `validation/l10-3-context-contribution` |
| Starting commit | **`082856cd0ae3d3fce32a81ea60791d7ffd24274f`** — matches the remote ref exactly |
| L10.4 branch | `validation/l10-4-official-evaluation`, created from `082856c` |
| Registration commit | `e32043c` (spec v1.7 + protocol v1.0), correction `6e355ce`… see §C |
| Evaluation-protocol v1.1 commit | `6e355ce` (scored-cell clarification, before the disposition) |
| PR #2 / PR #3 | OPEN, unmerged, heads `5f5a577…` / `49cc6ba…` — untouched |
| New PRs | **none** |

**Provenance check actually performed.** The workspace arrived with the L10
files present but uncommitted (the sandbox had been re-provisioned onto
`arena/86da64f9-a-p-e-x` @ `5f5a577`). Rather than trust the summary, every one
of the **881** working-tree paths was hashed and compared against the same path
in commit `082856c`: **879 identical, 0 differing**, 2 present-but-untracked
build artifacts not in that commit. The residue was stashed (verified identical,
nothing lost), the branch was created from the verified remote commit, and the
tree then compared clean. The L10.3 owner decision, report, protocol and the
245-entry evidence manifest were all verified in place before any work began.

## B. Specification

**`stark/design/context_conditioned_memory_milestone.md` → v1.7.**
sha256 `a323378c680ebda8f6e23921b6fc95b8ad1ac2e6e37e81f04cdaa57fe5134bd5`.

The change is exactly what the owner ratified and nothing more:

- **one row added to §8**, `L10-K1`, plus a paragraph beneath the table stating
  the relationship between the two criteria;
- a §13 entry recording the trigger, the decision, the exact scope of the change,
  and the standing rule that §8 changes require an owner decision and a new
  version;
- a header note distinguishing **v1.6** (the version every L10 result was
  produced under) from **v1.7** (adds L10-K1 only).

**L10-E, verbatim and unchanged:**

> `L10-E | shuffled-cue mean accuracy ≤ 0.40 and context-off mean ≤ 0.40 (see §13: the context-off half is arithmetically floored at ≈0.33; reported as-is)`

**L10-E remains historically FAILED, measured pooled context-off 0.425926** —
re-measured identically in this milestone's official run; the metrics CSV is
byte-identical to the L10.2 evidence.

**L10-K1, as ratified (Option B, 2026-10-24):**

> On **every** primary seed: (a) `CAA_pooled ≥ 0.40`; (b) `CAA(t) ≥ 0.25` for at
> least two of the three tasks; (c) `CRA_pooled ≥ 0.50`; where
> `CAA(t) = acc_correct(t) − acc_null(t)`, `acc_null(t) = (1/K) Σ_k A(k,t)` is
> the accuracy of a context-ignoring policy measured by forcing each bank with
> the cue removed, `CRA(t) = R_correct(t) − 1/K`, and `R_correct(t)` is the
> fraction of correct-cue trials whose selected bank is the task's bank.

Thresholds were carried over unchanged: 0.40 / 0.25 / 0.50. None was chosen,
adjusted or revisited after seeing any result.

## C. Registration

| Item | Value |
|---|---|
| Protocol | `stark/design/l10_4_official_evaluation_protocol.md` |
| v1.0 sha256 (registered) | `fa8ea868ea30bce5642052a74060f5802918dfe8fcc035e8b5133fb1d53c8c6f` |
| v1.1 sha256 (scored-cell clarification) | `249d507495bedb4a68b6be5eee26f968c89b3db92584dcd700d2712d9a7fb790` |
| Registration commit | `e32043c` |
| Correction commit | `9b8f5af` — commit `e32043c`'s *message* quotes a stale protocol hash; the error is preserved and superseded rather than rewritten, and the correct hashes are stated there, here, and in the manifest |
| Evaluator binary | sha256 `6a69967a3148795159feb4aabcf6feca36bc663ed78d58bd232d5075ff3274a9`, rebuilt from the registration commit |
| First official primary-seed measurement | **after** `e32043c` — no L10-K1 primary-seed run existed at registration |

**Registration preceded the measurements.** The only thing executed before it
was the regression battery as a smoke check (26/26 exit 0, no primary-seed
harness run). The battery was then re-run after registration as the official
record, with identical results.

**Post-registration change, fully declared.** Protocol v1.1 (§16) fixes *which*
correct-cue evaluation is the scored cell, because the harness evaluates each
task with its correct cue at acquisition and again at each later retention step
(rows 360/240/120 for tasks 0/1/2). It was written **after** the run and
**before** the disposition — the path protocol §11 requires — and it changes
nothing measurable: every correct-cue call in the run scores 1.0000, so the
pooled reading and the final-call reading produce an identical vector. Both were
computed (§D) and give the same CAA to four decimals. No new registration was
needed because no threshold, formula, seed, arm or inclusion rule changed.

## D. Official results

Run: `work/l10_raw/official_evaluation_20261024/K1`, three primary seeds, all
conditions, 120 trials per (seed, task, condition) cell. The independent checker
(`analysis/l10_k1_evaluate.py`) reports `valid=True` with zero problems.

**Per seed and task**

| Seed | Task | acc_correct | acc_null (= mean of forced banks) | **CAA** | R_correct | **CRA** |
|---|---|---|---|---|---|---|
| 123456789 | 0 | 1.0000 | 0.5000 | 0.5000 | 1.0000 | 0.6667 |
| 123456789 | 1 | 1.0000 | 0.4444 | 0.5556 | 1.0000 | 0.6667 |
| 123456789 | 2 | 1.0000 | 0.5000 | 0.5000 | 1.0000 | 0.6667 |
| 218213831 | 0 | 1.0000 | 0.4444 | 0.5556 | 1.0000 | 0.6667 |
| 218213831 | 1 | 1.0000 | 0.3917 | 0.6083 | 1.0000 | 0.6667 |
| 218213831 | 2 | 1.0000 | 0.3889 | 0.6111 | 1.0000 | 0.6667 |
| 171473193 | 0 | 1.0000 | 0.3333 | 0.6667 | 1.0000 | 0.6667 |
| 171473193 | 1 | 1.0000 | 0.3889 | 0.6111 | 1.0000 | 0.6667 |
| 171473193 | 2 | 1.0000 | 0.3889 | 0.6111 | 1.0000 | 0.6667 |

**Criterion checks, applied mechanically**

| Seed | CAA_pooled | (a) ≥ 0.40 | tasks with CAA(t) ≥ 0.25 | (b) ≥ 2 | CRA_pooled | (c) ≥ 0.50 | Seed |
|---|---|---|---|---|---|---|---|
| 123456789 | 0.5185 | ✅ | 3 of 3 | ✅ | 0.6667 | ✅ | PASS |
| 218213831 | 0.5917 | ✅ | 3 of 3 | ✅ | 0.6667 | ✅ | PASS |
| 171473193 | 0.6296 | ✅ | 3 of 3 | ✅ | 0.6667 | ✅ | PASS |

**Pooled (descriptive only, not the basis of the disposition):** grand CAA
**0.5799**, grand CRA **0.6667** (= the ceiling 1 − 1/K).

### Final official disposition: **L10-K1 = PASS**

It follows mechanically from the frozen rule: all three clauses hold on all
three registered seeds. The strict per-seed reading was fixed in the protocol
before the run precisely so that the reading could not be selected afterwards;
the grand-pooled reading agrees, and is reported anyway.

**Alternative reading, for completeness.** Using `acc_correct` pooled over *all*
correct-cue evaluations (v1.1 §16) instead of the final call: CAA per seed
0.5185 / 0.5917 / 0.6296 — **identical**, because every correct-cue call scores
1.0000. The disposition is the same under both readings.

**Independent recomputation.** Two separately written checkers, sharing no code
with the harness and not reading its aggregate columns, were run on the official
artifacts:

| Checker | Purpose | Result |
|---|---|---|
| `analysis/l10_k1_evaluate.py` (this milestone) | recompute CAA/CRA from per-trial rows + forced-bank sweep, apply the rule | CAA 0.5185/0.5917/0.6296, CRA 0.6667 → **PASS** |
| `work/l10_raw/context_contribution_20261024/analysis/recompute.py` (L10.3, different implementation) | cross-check | identical to four decimals |

**Retained L10-E, re-measured in the same run:** context-off 0.425926 (=
analytic floor, excess 0), shuffled-cue 0.132407 → **FAILED**, unchanged.

**Exploratory seeds (1, 2, 7, 42) — no criterion, reported separately:**
CAA 0.5556 / 0.4019 / 0.5537 / 0.5926, pooled 0.5259; CRA 0.6667 on all four;
the checker returns `L10-K1 = NOT APPLICABLE` for that run.

**Exploratory L10.3 numbers remain exploratory** and are labelled as such
everywhere; they are not the source of this disposition, although they match it.

## E. Reproducibility

| Check | Result |
|---|---|
| Determinism — two full runs into separate directories | **15/15 artifacts byte-identical** (compared before archiving; after gzip the three trial archives differ only in the gzip header, and their decompressed content is bit-identical, verified by `md5sum`); the checker produces byte-identical output for both runs |
| Non-perturbation — official run vs the L10.2 R0 evidence | `metrics_*.csv` **and** `sealing_*.csv` byte-identical for all three seeds, so the added diagnostic conditions change no registered number |
| Production driver re-run (`context_conditioned_memory_loop`) | reproduces L10-E 0.425926 / 0.132407 and L10-A/H PASS; `persistence_state_all=true`, `persistence_choices_all=true` |
| Save/load — checkpoint handover | `--mode restart --stage 0` then `--stage 1` in a **separate process**, all three seeds: final retention 1.000000 and bank map 0/1/2 identical to the uninterrupted run |
| Binary reproducibility | rebuild from the registration commit yields the same sha256 as the L10.3 binary |
| Manifest | every artifact hashed; verified after writing (see §G) |

**One protocol-implementation discrepancy, resolved and recorded.** Protocol
§8.4 expected `save_reload_state` / `save_reload_choices` in the metrics row;
the *harness* does not emit them (the production driver does). Rather than
change the evaluator after registration, save/load is evidenced two ways that
are strictly stronger than the flag: the separate-process checkpoint handover
above, and the production driver's `persistence_state_all/choices_all = true`.
No code was changed to make the documents agree.

## F. Regressions

Run from the documented working directory `stark/`, compiler
`g++ 12.2.0`, `-O2 -std=c++17`, battery preserved as a file in the evidence
directory (`regression/battery.sh`, so the suite is reproducible from the
evidence rather than from `/tmp`):

| Target | Exit | Assertions |
|---|---|---|
| test_context_conditioned_memory | 0 | **330** |
| test_l10_structural_audit | 0 | **357** |
| test_l10_1_sealing | 0 | **276** |
| test_phase1_gates | 0 | **437**, 0 failures |
| test_phase1_profiler / accounting / budget / records / reproducibility | 0 | 34 / 67 / 55 / 72 / 37 |
| remaining 17 targets (neuron, params, synapse, integration, network, stdp, homeostasis, three_factor, serialization, learning_loop, delayed_reward, sequential_context, associative_memory, eligibility_gating, learned_relevance, n_way_learned_relevance, n_way_learned_relevance_loop_L8) | 0 | — |

**26 targets built, 26 exit 0, 0 build failures, 0 test failures.**
`test_phase1_affinity` is **UNEXECUTED / UNKNOWN** — it does not build on Linux
(`DWORD_PTR` is Win32-only). It is not reported as passed and was not fixed.
No unrelated test or gate was modified.

## G. Manifest

`work/l10_raw/official_evaluation_20261024/MANIFEST.md` lists every artifact with
its sha256 (`protocol/`, `K1/`, `K1b/`, `KX/`, `perm/`, `restart/`, `regression/`,
`analysis/`, `production/`) plus a second section covering the deliverables and
the changed sources, together with the protocol hashes, the binary hash and the
seed list. The manifest is re-verified after writing; the verification result is
stated in the commit message and in the JSON deliverable. Historical evidence
directories were not modified.

## H. Limitations

**Unresolved anomaly (carried, not resolved).** One forced-bank cell —
`(218213831, task 1, bank 2)` — measures 0.008333 where the permutation model
predicts 0.0: exactly **one trial in 120**.

- *Is it relevant to L10-K1?* Only through `acc_null` of that seed: it moves
  `acc_null(218213831,1)` by 0.00093 and that seed's CAA by ≈0.0003, against a
  0.25 per-task margin — **not decision-relevant**.
- *Can existing evidence resolve it?* No. The trial rows do not record which
  channel slot was selected, so the mis-selection hypothesis cannot be confirmed
  or refuted from them. Adding that field would have changed the artifact schema
  mid-evaluation, which this protocol deliberately forbids (§14).
- *What is the evidence for the hypothesis?* Consistent but indirect: the same
  kind of cell-level deviation appears in the exploratory run at 3 cells out of
  36, sized 1–2 trials, and those deviations come in **offsetting pairs across
  banks of the same task** (seed 2, task 2: bank 0 +2 trials, bank 2 −2 trials),
  which is what a per-trial channel/attention error redistributing the answer
  looks like. Across all 63 cells examined, 4 deviate, never by more than 2
  trials.
- *Follow-up:* a **separately registered** diagnostic that emits a per-trial
  channel-slot field. Proposed, not started.

**Other standing limitations**

1. Context in CCM v1.6 **selects a memory bank**; it does not modulate retrieval
   within a bank. With the cue removed every bank still answers its own task
   perfectly (forced-bank diagonal 1.0000). L10-K1 measures the selection channel,
   which is the capability the architecture claims.
2. **Cross-signature generalization is weak**: mixed-feature cues reach 0.5611
   pooled but range 0.0–1.0 per task.
3. **Misleading cues are destructive**: shuffled-cue accuracy 0.1324.
4. **Finite, toy-scale task family**: 3 tasks, 3 banks, 6 identities, 12 features,
   permutations drawn per seed. The null and the ceilings are specific to this
   family; the formulas generalize, the constants do not.
5. `acc_null` is measured and inherits ~0.2 % readout noise.
6. The criterion is behavioural: it shows a performance advantage, not a causal
   intervention on an internal variable.
7. **Passing L10-K1 does not establish general compositional intelligence,
   autonomous cognition, or any capability beyond the tested protocol** — and it
   does not make L10-E pass.

## I. Project status and next milestone

**Completion estimate: ~55 % (up from ~50 %).** The increase is small and
deliberate: the acceptance specification is now internally consistent, one
criterion is officially satisfied on registered evidence, and the retained
failure is explained exactly rather than approximately. No new cognitive
mechanism was added, so the milestone's contribution is measurement quality, not
capability.

**Is L10 complete under the revised specification?** Nearly, but not yet, and it
should not be declared complete by assertion:

- Every criterion with a reachable definition is now decided: L10-A/B/C/D/E2/F2/
  G2/H/I/J pass or are reported; **L10-E fails and will always fail** on this
  architecture (its context-off half is a lottery on the task draw); **L10-F
  fails historically** and is unsatisfiable as written, superseded by L10-F2.
- What remains is clerical-but-governance-relevant: L10-E and L10-F have no
  owner-recorded *closure* disposition (they are retained, not retired). That is
  the owner's call, not the agent's.

**Recommended next milestone: L10.5 — close out L10 and record the two retained
failures.** A short governance milestone with no new experiments: put L10-E and
L10-F to the owner as retained-and-closed (with L10-E2/L10-K1 and L10-F2 as the
operative criteria), update §8 accordingly in a v1.8 with an owner decision, and
publish the milestone summary. Optionally fold in the follow-up registration for
the channel-slot diagnostic described in §H.

**L11 should not start before that**, for the same reason L10.4 was needed:
a milestone that inherits an ambiguous acceptance record reproduces the ambiguity.
