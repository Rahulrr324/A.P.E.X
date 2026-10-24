#!/usr/bin/env python3
"""Promote the authorised L10.5 patches to the authoritative v1.8."""
p = "stark/design/context_conditioned_memory_milestone.md"
s = open(p).read()

old = """**Version:** 1.7 (2026-10-24)
**Version history:** **v1.6 (frozen 2026-10-24, before the reported evaluation)**
is the version every L10 result was produced and reported under. **v1.7** makes
one addition — the criterion **L10-K1** in §8, ratified by the repository owner
on 2026-10-24 — and changes nothing else: no existing criterion, threshold,
metric, seed or historical result is altered (see §13)."""
new = """**Version:** 1.8 (2026-10-24)
**Version history:** **v1.6 (frozen 2026-10-24, before the reported evaluation)**
is the version every L10 result was produced and reported under. **v1.7** added
the criterion **L10-K1** in §8, ratified by the repository owner on 2026-10-24.
**v1.8** records the owner's milestone-closure decisions A, B and C
(2026-10-24): three annotation rows and a status line, no change to any criterion,
threshold, metric, seed or historical result (see §13)."""
assert old in s
s = s.replace(old, new)

old_e = "| L10-E | shuffled-cue mean accuracy ≤ 0.40 **and** context-off mean ≤ 0.40 (see §13: the context-off half is arithmetically floored at ≈0.33; reported as-is) |"
new_e = old_e + """
| L10-E (status, added in v1.8) | **RETAINED AND CLOSED as a historical failure** (owner decision A, 2026-10-24). The criterion, its 0.40 threshold, its metric and its measured FAILED result (context-off 0.425926, shuffled-cue 0.132407) are preserved exactly and are not withdrawn. Closure records that the outcome is final for the milestone; it does **not** convert the result to a PASS, does **not** rescind the failure, and does **not** assert that context is unnecessary. The context-off half is dominated by the random task draw (the fixed-point agreement of the fallback bank's permutation; expected 4/9; a perfect router passes the ≤ 0.40 bound with probability 0.1512 — see §13 and `work/L10_3_CONTEXT_CONTRIBUTION.md`), which is why the separate criterion L10-K1 now carries the context-contribution claim. |"""
assert old_e in s
s = s.replace(old_e, new_e)

old_f = "| L10-F | NO-SEAL mean forgetting > CCM mean forgetting |"
new_f = old_f + """
| L10-F (status, added in v1.8) | **SUPERSEDED AND CLOSED by L10-F2** (owner decision B, 2026-10-24). The original criterion and its FAILED result are preserved in full: under the v1.0 protocol (`commit_trials = 480`) no sealing opportunity arises, so the criterion was unsatisfiable **by construction** rather than unmet by the mechanism. The requirement is now carried by L10-F2 (owner ratification A-1, 2026-10-24; `SEAL-PAIR` with `commit_trials = 240`), which PASSED on all four pre-registered conditions on all three masters. Supersession does not delete or relabel the original failure. |"""
assert old_f in s
s = s.replace(old_f, new_f)

old_g = "| L10-G | K2-STRESS worse than CCM (forgetting or final average) |"
new_g = old_g + """
| L10-G (status, added in v1.8) | **SUPERSEDED by L10-G2** (owner decision C, 2026-10-24). The historical PASS was produced on a **confounded** arm: K2-STRESS simultaneously reused a bank and un-sealed the others (L10.1 diagnosis), so it could not isolate capacity. Both the original PASS and its confound disclosure are preserved. The capacity claim is now carried by L10-G2 (owner ratification A-3, 2026-10-24; capacity arm run with `--reuse-seal 0`, original decision rule unchanged), which PASSED (K2 final 0.6361 / forgetting 0.2713 vs CCM 1.0000 / 0.0000). Superseding a PASS here strengthens rather than weakens the record. |"""
assert old_g in s
s = s.replace(old_g, new_g)

old_p = """A "PASS" requires the run output that supports it. Failures are reported as
FAIL with their number."""
new_p = old_p + """

**Milestone closure status (v1.8).** L10 is **CLOSED** as of 2026-10-24, by owner
decisions A, B and C recorded in `stark/reports/L10_5_OWNER_DECISION.md`. Every
criterion has a final recorded outcome: L10-A/B/C/D/E2/K1/F2/G2/H satisfied,
**L10-E retained and closed as a historical failure**, **L10-F superseded and
closed by L10-F2**, **L10-G superseded by L10-G2**. Closure is a governance act:
it does not alter any measured value or any pass/fail outcome, and the superseded
criteria remain in this document permanently with their original results."""
assert old_p in s
s = s.replace(old_p, new_p)

s = s.rstrip("\n") + """

### v1.8 — owner-governed milestone closure

**Trigger.** Every L10 experiment had been run and every criterion had a recorded
outcome; what remained was governance. L10.5 put three closure decisions to the
repository owner **separately** (`stark/reports/L10_5_OWNER_DECISION.md`); the
proposed change set was published as
`stark/design/context_conditioned_memory_milestone_v1_8_proposal.md` and was not
in force until the answers existed.

**Decisions and answers.**
- **A — L10-E:** *retain the original failure and formally close the criterion as
  a historical result.*
- **B — L10-F:** *mark the original failure as superseded and closed by L10-F2,
  preserving the historical failure.*
- **C — L10-G:** *record the historical confounded result as superseded by
  L10-G2, preserving the original result and the confound disclosure.*

**What changed.** Three annotation rows (§8) and the milestone-closure status
line, plus this entry. Nothing else: no criterion text, threshold, metric, seed,
evaluation rule, measured value or pass/fail outcome was altered, and the v1.6
and v1.7 text is preserved verbatim. Verified by diff: the change is purely
additive apart from the version line.

**What did not change.** L10-E remains **FAILED at 0.425926** against its
unchanged 0.40 threshold. L10-F remains recorded as FAILED. L10-G remains
recorded as a PASS on a confounded arm. L10-K1 remains an official PASS under its
registered protocol (v1.1, sha256 `249d5074…`, registration commit `e32043c`,
evidence `work/l10_raw/official_evaluation_20261024/`), with its 0.40 / 0.25 /
0.50 thresholds untouched. No evidence was regenerated.

**Standing rule.** Any future change to §8 requires an owner decision and a new
version. Superseded and closed criteria stay in this document permanently with
their original results; they are annotated, never removed or rewritten.
"""
open(p, "w").write(s)
print("v1.8 written")
