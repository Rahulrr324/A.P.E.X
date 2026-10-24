# STARK-L10 — Proposed Acceptance Specification v1.8 (PROPOSAL — NOT IN FORCE)

**Status:** **AUTHORISED AND PROMOTED on 2026-10-24.**
This file is retained as the reviewable change set that was put to the owner. All
three decisions (A, B, C) were answered **option 1** and the authorised patches
were applied to the authoritative
`stark/design/context_conditioned_memory_milestone.md`, which is now **v1.8**
(sha256 `aafd00aad8c2b843410f2a88fdf3f64cbeb2c10c39f7470f43c5a2bafe33ffd1`,
promoted from v1.7 `a323378c…`). Nothing in this document is normative: the
authoritative text is the milestone document.

**Why it was not in force when published.** The specification's §13 (v1.7 entry)
requires that any change to §8 be made "with an owner decision, in a new
version". The agent may draft that text but may not promote it. It was promoted
only after the owner answered the three questions in
`stark/reports/L10_5_OWNER_DECISION.md` §2 (2026-10-24).

**How to use this document.** Each decision has a self-contained patch. Apply
exactly the patches the owner authorises, in the owner's words, and nothing else.
If a decision is deferred, its patch is omitted and the corresponding criterion
keeps its current v1.7 recording verbatim.

| Patch | Decision | Subject | Default if not authorised |
|---|---|---|---|
| **P-A** | A | L10-E closure annotation | omitted; L10-E stays as recorded in v1.7 |
| **P-B** | B | L10-F supersession note | omitted; L10-F stays as recorded in v1.7 |
| **P-C** | C | L10-G supersession note | omitted; L10-G stays as recorded in v1.7 |
| **P-H** | all | header + §8 status line + §13 v1.8 entry | applies only when at least one of A/B/C is authorised |

---

## 1. What v1.8 would preserve (unchanged in every combination)

- Every criterion **text**, **threshold** and **metric**: L10-A, L10-B, L10-C,
  L10-D, L10-E, L10-E2, L10-F, L10-G, L10-H, L10-I, L10-J, L10-K1.
- Every **measured value and pass/fail outcome**, including
  L10-E **FAILED at 0.425926 / 0.132407** and L10-F **FAILED (zero sealing
  opportunities)**. Nothing is relabelled, no number is touched.
- The **official L10-K1 PASS** and its registered provenance: protocol v1.1
  sha256 `249d5074…`, registration commit `e32043c`, evidence
  `work/l10_raw/official_evaluation_20261024/`, owner authorisation Option B
  (2026-10-24).
- The v1.6 and v1.7 text. v1.8 is **appended**, never substituted, in the same
  way v1.7 was.
- Seeds, evaluation semantics, task distribution, and every historical artifact.

## 2. Proposed §8 additions (conditional on the owner's answers)

### Patch P-A — Decision A (L10-E), if authorised

Add one annotation row immediately after the `L10-E` row. The `L10-E` row itself
is **not edited**:

```
| L10-E (status, added in v1.8) | **RETAINED AND CLOSED as a historical failure** (owner decision A, <date>). The criterion, its 0.40 threshold, its metric and its measured FAILED result (context-off 0.425926, shuffled-cue 0.132407) are preserved exactly and are not withdrawn. Closure records that the outcome is final for the milestone; it does not convert the result to a PASS, does not rescind the failure, and does not assert that context is unnecessary. The context-off half is dominated by the random task draw (fixed-point agreement of the fallback bank's permutation; expected 4/9; a perfect router passes the ≤ 0.40 bound with probability 0.1512 — see §13 and `work/L10_3_CONTEXT_CONTRIBUTION.md`), which is why the separate criterion L10-K1 now carries the context-contribution claim. |
```

### Patch P-B — Decision B (L10-F), if authorised

Add one annotation row immediately after the `L10-F` row:

```
| L10-F (status, added in v1.8) | **SUPERSEDED AND CLOSED by L10-F2** (owner decision B, <date>). The original criterion and its FAILED result are preserved in full: under the v1.0 protocol (`commit_trials = 480`) no sealing opportunity arises, so the criterion was unsatisfiable by construction rather than unmet by the mechanism. The requirement is now carried by L10-F2 (owner ratification A-1, 2026-10-24; `SEAL-PAIR` with `commit_trials = 240`), which PASSED on all four pre-registered conditions on all three masters. Supersession does not delete or relabel the original failure. |
```

### Patch P-C — Decision C (L10-G), if authorised

Add one annotation row immediately after the `L10-G` row:

```
| L10-G (status, added in v1.8) | **SUPERSEDED by L10-G2** (owner decision C, <date>). The historical PASS was produced on a confounded arm: K2-STRESS simultaneously reused a bank and un-sealed the others (L10.1 diagnosis), so it could not isolate capacity. Both the original PASS and its confound disclosure are preserved. The capacity claim is now carried by L10-G2 (owner ratification A-3, 2026-10-24; capacity arm run with `--reuse-seal 0`, original decision rule unchanged), which PASSED (K2 final 0.6361 / forgetting 0.2713 vs CCM 1.0000 / 0.0000). Superseding a PASS here strengthens rather than weakens the record. |
```

## 3. Proposed §8 milestone-status line (Patch P-H)

Insert immediately after the paragraph that ends *"Failures are reported as FAIL
with their number."* (or after the v1.7 relationship paragraph, whichever the
owner prefers — the semantics are identical):

```
**Milestone closure status (v1.8).** L10 is **<CLOSED | OPEN>** as of <date>.
<CLOSED: every criterion has a final recorded outcome — L10-A/B/C/D/E2/K1/F2/G2/H
satisfied, L10-E retained and closed as a historical failure, L10-F superseded
and closed by L10-F2, L10-G superseded by L10-G2. |
OPEN: the following closure decisions remain unauthorised: <list>.>
The closure status does not alter any measured value or any pass/fail outcome.
```

## 4. Proposed §13 revision-log entry (Patch P-H)

Append to §13, in the same style as the v1.7 entry:

```
### v1.8 — owner-governed milestone closure

**Trigger.** Every L10 experiment has been run and every criterion has a recorded
outcome; what remained was governance. L10.5 put three closure decisions to the
repository owner separately (`stark/reports/L10_5_OWNER_DECISION.md`).

**Decisions and answers (verbatim).** A (L10-E): <answer>. B (L10-F): <answer>.
C (L10-G): <answer>.

**What changed.** <Only the annotation rows and the status line for the decisions
actually authorised.> Nothing else: no criterion text, threshold, metric, seed,
evaluation rule, measured value or pass/fail outcome was altered, and the v1.6 and
v1.7 text is preserved verbatim.

**What did not change.** L10-E remains FAILED at 0.425926 against its unchanged
0.40 threshold. L10-F remains recorded as FAILED. L10-G remains recorded as a PASS
on a confounded arm. L10-K1 remains an official PASS under its registered
protocol. The 0.40 / 0.25 / 0.50 thresholds of L10-K1 are untouched.

**Standing rule.** Any future change to §8 requires an owner decision and a new
version. Superseded and closed criteria stay in the document permanently with
their original results; they are annotated, never removed or rewritten.
```

## 5. What this proposal explicitly does **not** do

- It does not close L10. Only the owner can; until then L10 is **OPEN**.
- It does not change any threshold (0.40 / 0.25 / 0.50 or any other).
- It does not change L10-E's or L10-F's pass/fail status, or L10-G's confounded
  PASS, or L10-K1's official PASS.
- It does not authorise L11, or any new experiment.
- It does not modify `stark/design/context_conditioned_memory_milestone.md`,
  which stays at v1.7 until an authorisation exists.

## 6. Promotion procedure (to be executed only after authorisation)

1. Owner answers A, B, C separately in `stark/reports/L10_5_OWNER_DECISION.md` §2.
2. Apply exactly the authorised patches to a copy of the authoritative document.
3. Set its header to **v1.8** with the approval authority (owner, date, decision
   IDs) recorded inline; keep the v1.6/v1.7 history notes.
4. Verify by diff that only the authorised rows, the status line and the §13
   entry changed, and that no threshold or outcome line appears in the diff as a
   deletion.
5. Commit the authoritative v1.8 with the decision record, publish, and only then
   update `work/L10_5_MILESTONE_CLOSEOUT.md`/`.json` from OPEN to CLOSED.
