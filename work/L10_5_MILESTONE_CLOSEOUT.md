# STARK-L10.5 — Owner-Governed Milestone Closure

**Status:** documentation and governance only. **No experiment was run, no
threshold changed, no result relabelled, no evidence regenerated.**

**Bottom line: L10 is formally CLOSED.** The three closure decisions were put to
the repository owner separately on 2026-10-24 and all three were answered
(**option 1** for each). The authorised text has been promoted to the
authoritative acceptance specification **v1.8**
(sha256 `aafd00aad8c2b843410f2a88fdf3f64cbeb2c10c39f7470f43c5a2bafe33ffd1`).
Closure changed no measured value and no pass/fail outcome: L10-E is still
**FAILED**, L10-F is still recorded **FAILED**, L10-G is still recorded as a PASS
on a confounded arm, and L10-K1 is still an official **PASS**.

---

## A. Provenance

| Item | Value |
|---|---|
| Repository | `Rahulrr324/A.P.E.X` (private) |
| Starting branch | `validation/l10-4-official-evaluation` |
| Starting commit | **`aed9c304cdadf6b855d682bf5dfbbc811eab8dcf`** — local HEAD and remote ref verified identical before any change; working tree clean |
| L10.5 branch | `validation/l10-5-milestone-closeout`, created from `aed9c30` |
| PR #2 | OPEN, unmerged, head `5f5a57717509623bd4c79460d50c05f7cbc605c3` — untouched |
| PR #3 | OPEN, unmerged, head `49cc6ba18650c0d9614bb9e8918fe65453ec5a02` — untouched |
| New PRs | none |
| `main` | `563395f1ca7742ecb65bcef6134212f5bb66c3d8` (unchanged) |

**Documents read before drafting:** the authoritative specification
(`context_conditioned_memory_milestone.md` v1.7, including §8 and the §13
revision log), the L10.4 protocol and report, the L10.2 and L10.3 owner decision
records, the L10.1 control-validation report (for the L10-G confound), the L10.2
ratification report, and the L10.4 evidence manifest.

**Governance rule verified in the repository itself.** The §13 v1.7 entry of the
acceptance specification states: *"Any future change to §8 must be recorded the
same way, with an owner decision, in a new version — never edited in place."*
The §8 scope table carries no delegation clause. The established mechanism is an
**Owner Decision Record** under `stark/reports/` (`G7_OPTION1_OWNER_DECISION.md`,
`L10_2_OWNER_DECISION.md`, `L10_3_ACCEPTANCE_DECISION.md`). Closure is therefore
an owner act, and this milestone does not perform it.

## B. Verified technical disposition

All figures below were re-derived from the committed artifacts for this report —
not copied from earlier prose.

### L10-E — **FAILED** (unchanged)

| Field | Value |
|---|---|
| Criterion (v1.6, unchanged) | `shuffled-cue mean accuracy ≤ 0.40` **and** `context-off mean ≤ 0.40` |
| Measured, re-derived from `K1/metrics_*.csv` (9 rows) | shuffled **0.132407** (≤ 0.40 ✓), context-off **0.425926** (> 0.40 ✗) |
| Status | **FAILED** — the second conjunct governs |
| Threshold history | never altered since v1.6; A-2 (the amendment that would have redefined it) was **declined** by the owner on 2026-10-24 |

**What the context-off statistic actually measures.** With the cue withheld, the
router's score vector is exactly zero, the strict-argmax tie-break selects the
lowest allocated bank (bank 0 on every seed), and the scored accuracy reduces to
the **fixed-point agreement between bank 0's random permutation and each task's
permutation**. Derived analytically and confirmed to zero deviation on all nine
cells; expected pooled value 4/9 = 0.4444, attainable range [1/3, 1], and a
**perfect** router passes ≤ 0.40 with probability **0.1512**
(`work/L10_3_CONTEXT_CONTRIBUTION.md` §4–§5).

**Two claims that must not be made, and are not made here:** that this failure
shows context is unnecessary (it does not — L10-K1 and L10-E2 show the opposite),
and that the model passed the original criterion (it did not).

### L10-K1 — **PASS** (official, registered)

| Seed | CAA_pooled (≥ 0.40) | CRA_pooled (≥ 0.50) | tasks with CAA(t) ≥ 0.25 | Seed |
|---|---|---|---|---|
| 123456789 | 0.5185 ✓ | 0.6667 ✓ | 3 of 3 ✓ | PASS |
| 218213831 | 0.5917 ✓ | 0.6667 ✓ | 3 of 3 ✓ | PASS |
| 171473193 | 0.6296 ✓ | 0.6667 ✓ | 3 of 3 ✓ | PASS |

Grand pooled (descriptive): CAA 0.5799, CRA 0.6667 (= the 1−1/K ceiling).
Evidence: `work/l10_raw/official_evaluation_20261024/` (manifest 129/129 verified),
`work/L10_4_OFFICIAL_EVALUATION.json`, protocol v1.1 sha256 `249d5074…`,
registration commit `e32043c`, owner authority Option B (2026-10-24).
Recomputed independently by two separately written checkers.

**L10-E2** (v1.6 supplement), re-derived from the same artifacts: PASS on all
three seeds (correct−context-off ≥ 0.60 on 2 of 3 tasks each; correct−shuffled
≥ 0.60 on 3 of 3 tasks each).

### L10-F versus L10-F2

| | L10-F (v1.6, historical) | L10-F2 (v1.1, ratified A-1) |
|---|---|---|
| Rule | NO-SEAL mean forgetting **>** CCM mean forgetting | SEAL-PAIR at `commit_trials = 240`: opportunities > 0, sealed forgetting ≤ 0.10, unsealed ≥ sealed + 0.10, \|ΔW\| into sealed banks = 0 |
| Result | **FAILED** — 0 sealing opportunities on every seed; NO-SEAL field-for-field identical to CCM | **PASS** on all four conditions, all three masters |
| Numbers | — (untestable as written) | sealed 0.0000 vs unsealed 0.4509 pooled; 185 opportunities / 185 blocked / 184 executed; \|ΔW\| into sealed = 0.000 |
| Status | retained, **no owner closure decision yet** | official PASS |

This is a criterion that failed **by construction**, not a mechanism failure: at
`commit_trials = 480` the sealing predicate is never exercised.

### L10-G versus L10-G2

| | L10-G (v1.6, historical) | L10-G2 (v1.1, ratified A-3) |
|---|---|---|
| Rule | K2-STRESS worse than CCM (forgetting or final average) | same rule, arm run with `--reuse-seal 0` |
| Arm | **confounded**: K2-STRESS reuses a bank **and** un-seals the others — two interventions in one arm (L10.1 diagnosis) | capacity only |
| Result | **PASS** (on the confounded arm) | **PASS** — K2 final 0.6361 / forgetting 0.2713 vs CCM 1.0000 / 0.0000 |
| Status | retained with its confound disclosure, **no owner supersession recorded yet** | official PASS |

Note the direction: the historical outcome here is a *pass*. Superseding it is a
strengthening — the original pass could not isolate capacity; the replacement can.

### Other criteria (unchanged by this milestone)

L10-A, L10-B, L10-C, L10-D, L10-H: PASS (historical, v1.6).
L10-I: no new failures (26/26 regression targets exit 0, L10.4).
L10-J: failures and limitations reported honestly.
`test_phase1_affinity`: **UNEXECUTED / UNKNOWN** (Win32-only `DWORD_PTR`).

## C. Owner decisions

Recorded **separately** in `stark/reports/L10_5_OWNER_DECISION.md`. No answer to
one decision implies an answer to another, and none has been assumed.

| ID | Subject | Options put | Recommendation | Answer | Status |
|---|---|---|---|---|---|
| **A** | L10-E | (1) retain the failure and formally close the criterion as historical; (2) leave unresolved; (3) other | **1** | **option 1** | **APPROVED** |
| **B** | L10-F | (1) mark superseded and closed by L10-F2, preserving the failure; (2) leave unresolved; (3) other | **1** | **option 1** | **APPROVED** |
| **C** | L10-G | (1) record the historical confounded PASS as superseded by L10-G2, preserving both; (2) leave both as-is; (3) other | **1** | **option 1** | **APPROVED** |

Each was asked and answered **separately**; no answer was inferred from another,
and the agent approved none of them. The agent did not treat the A-1/A-3
ratifications (which ratified *protocols*), the L10.3 Option B decision (which
ratified a *criterion text*), or any earlier engineering recommendation as
authority for a closure — it asked.

## D. Specification

| Item | Value |
|---|---|
| Previous authoritative version | v1.7, sha256 `a323378c680ebda8f6e23921b6fc95b8ad1ac2e6e37e81f04cdaa57fe5134bd5` (unchanged until the answers existed) |
| **Current authoritative version** | **v1.8**, sha256 `aafd00aad8c2b843410f2a88fdf3f64cbeb2c10c39f7470f43c5a2bafe33ffd1` |
| Change set (reviewable) | `stark/design/context_conditioned_memory_milestone_v1_8_proposal.md` — the text that was put to the owner, retained as the applied record |
| Approval authority | owner decisions A, B, C, 2026-10-24 (`stark/reports/L10_5_OWNER_DECISION.md` §2) |
| Diff shape | **+51 / −5**: the five deletions are the old version header block; everything else is addition. All three annotation rows sit *beneath* the untouched criterion rows |

The change set is deliberately structured as one self-contained patch per
decision (**P-A**, **P-B**, **P-C**) plus a status line and a §13 entry
(**P-H**). Each patch adds an *annotation row* beneath the existing criterion row
and never edits it — so the authoritative v1.8 contains the v1.7 text verbatim
plus three annotations. Had any decision been deferred, its patch would simply
have been omitted.

**Preserved in every combination:** all criterion texts, thresholds and metrics;
all measured values and pass/fail outcomes (L10-E FAILED 0.425926, L10-F FAILED,
L10-G confounded PASS, L10-K1 official PASS); the v1.6 and v1.7 text; seeds,
evaluation semantics, task distribution and every historical artifact.

## E. Evidence integrity

| Manifest | Entries | Problems |
|---|---|---|
| `work/l10_raw/official_evaluation_20261024/MANIFEST.md` (L10.4) | 129 | **0 at its own commit**; currently **124/124 evidence artifacts verify**, with one deliberate difference explained below |
| `work/l10_raw/context_contribution_20261024/MANIFEST.md` (L10.3) | 245 | **0** |
| `work/l10_raw/spec_ratification_20261024/MANIFEST.md` (L10.2) | 200 | 1 — `stark/src/learning/l10_validation_harness.cpp` |

**The one L10.4 difference is this milestone's own authorised change.** The L10.4
manifest hashes the acceptance specification as part of its *deliverables* section
(not its evidence section): it recorded v1.7 `a323378c…`, and L10.5 has now
promoted that file to v1.8 `aafd00aa…` under the owner's decisions A/B/C. All
**124/124** L10.4 **evidence artifacts** still verify byte-for-byte. The L10.4
manifest was deliberately **not** rewritten — editing a historical manifest to
match a later change is exactly what the evidence rules forbid; the supersession is
recorded here and in the v1.8 §13 entry instead.

The single L10.2 difference is the **expected, declared** one: that manifest hashes
the harness source as it stood at the end of L10.2, and the file was extended
additively in L10.3 (a new evaluation mode, reachable only via
`--ctx-contribution`). It was not silently changed: L10.3 recorded the extension,
re-verified byte-identical reproduction of the frozen L10.2 artifacts, and this
milestone changes no source file at all.

**Historical evidence was not overwritten.** `git status` for
`work/l10_raw/context_contribution_20261024/`,
`work/l10_raw/spec_ratification_20261024/`,
`work/l10_raw/control_validation_20261025/` and `work/l10_raw/final_run/` is
empty on this branch. No experiment was rerun "to refresh hashes", and no evidence
directory was regenerated.

## F. Tests

**No tests were run in L10.5, and none was needed.** This milestone changes only
Markdown and JSON deliverables — no `.cpp`, no `.h`, no build file, no test, no
evaluator. `git diff --stat aed9c30..HEAD` contains no source file, so the L10.4
regression results remain valid for this tree unchanged.

| Result | Provenance |
|---|---|
| 26 targets, all exit 0; CCM 330, structural audit 357, L10.1 sealing 276, Phase-1 gates 437 assertions; 0 failures | **existing verified result from L10.4** (`work/l10_raw/official_evaluation_20261024/regression/battery_summary.txt`) — not re-executed here |
| `test_phase1_affinity` — UNEXECUTED / UNKNOWN (Win32-only `DWORD_PTR`) | existing, unchanged |
| L10-E 0.425926 / 0.132407; L10-K1 PASS; L10-E2 PASS | **re-derived in this milestone from committed artifacts** (read-only, no run) |

## G. Final milestone status

**L10 is formally CLOSED**, by owner decisions A, B and C of 2026-10-24, and the
acceptance specification is at v1.8. Closure followed the owner's answers — it was
not claimed because the experiments were finished. The order matters and is
preserved in the record: the experiments finished in L10.4, the decisions were
drafted in L10.5, the owner answered, and only then was the specification promoted.

| Layer | State |
|---|---|
| Owner-approved decisions in force | A-1 → L10-F2 protocol; A-3 → L10-G2 + informational L10-R1/L10-S1 (both L10.2, 2026-10-24); Option B → L10-K1 added to §8 as v1.7 (L10.3, 2026-10-24); **A/B/C closure decisions → v1.8 (L10.5, 2026-10-24)** |
| Decided in L10.5 | A → L10-E retained and closed as a historical failure; B → L10-F superseded and closed by L10-F2; C → L10-G superseded by L10-G2 (all owner-approved 2026-10-24, recorded separately) |
| Historical experimental results | L10-E FAILED 0.425926; L10-F FAILED (0 opportunities); L10-G PASS (confounded arm); L10-A/B/C/D/E2/H PASS |
| Current official criterion statuses | **L10-E FAILED**, L10-F FAILED (retained), L10-G PASS (confounded, retained), **L10-K1 PASS**, L10-F2 PASS, L10-G2 PASS, L10-A/B/C/D/E2/H PASS, L10-I no new failures, L10-J satisfied |
| Formal milestone-closure status | **CLOSED** (2026-10-24) |
| Acceptance specification | **v1.8 authoritative** (sha256 `aafd00aad8c2b843410f2a88fdf3f64cbeb2c10c39f7470f43c5a2bafe33ffd1`) |

**Completion estimate: ~57 % (from ~55 %).** The increase is small and covers one
thing only: the milestone is now formally closed with a consistent acceptance
record, which removes a standing governance debt. No capability was added and no
measured outcome changed, so a larger increment would be inflation.

**The promotion step is complete**, inside this milestone: the authorised patches
were applied, the header now carries the approval authority, and a diff check
confirms nothing but the version header was deleted. L10.6 is therefore reduced to
sign-off rather than promotion.

**Recommended next milestone: L10.6 — L10 sign-off and the L11 readiness
assessment.** Scope: verify the v1.8 document against the decision record, confirm
the evidence manifests still verify, publish a short milestone summary that points
at what the milestone did and did not establish, and scope what an L11 pre-requisite
would actually be. Optionally fold in the separately registered channel-slot
diagnostic proposed in L10.4 §H, which is the only outstanding measurement gap left
in the record.

**L10 is now closed, so L11 is no longer blocked by an ambiguous acceptance
record** — but it should still start from a sign-off milestone, not directly,
because the v1.8 annotations have not yet been re-read end to end by a successor.

## H. Deliverables

| Path | Contents |
|---|---|
| `work/L10_5_MILESTONE_CLOSEOUT.md` | this report |
| `work/L10_5_MILESTONE_CLOSEOUT.json` | machine-readable state, `null` where undetermined, `pending` where unauthorised |
| `stark/reports/L10_5_OWNER_DECISION.md` | the three decisions, recorded separately, all PENDING |
| `stark/design/context_conditioned_memory_milestone_v1_8_proposal.md` | proposed v1.8 as a conditional change set; explicitly not in force |

**Measurement status: none.** This milestone produced no measurements, so it has
no experimental evidence directory. What exists is
`work/l10_raw/closeout_20261024/`, which holds only the derivation script used to
re-read the L10.4 artifacts and a manifest of this milestone's own documents; it
is deliberately not modelled on an experimental run.
