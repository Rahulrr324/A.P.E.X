# STARK-L10.4 — Acceptance Decision Record

**Type:** governance / acceptance-recording artifact
**Date:** 2026-10-24
**Decision owner:** repository owner (`Rahulrr324`)
**Status:** **COMPLETE — no new owner decision was required for this milestone.**
The milestone executed a decision the owner had already made.

---

## 1. What this record decides, and what it does not

L10.4 has no open question for the owner. The owner decided the disposition of
L10-E in L10.3 — **Option B**: *retain L10-E unchanged, add L10-K1 as a separate
criterion* (`stark/reports/L10_3_ACCEPTANCE_DECISION.md` §5, 2026-10-24). L10.4
implements that decision end to end:

1. transcribes the ratified L10-K1 text into the acceptance specification
   (`stark/design/context_conditioned_memory_milestone.md` **v1.7**, §8);
2. registers a fresh evaluation protocol and fixes its hash before measuring;
3. runs the official evaluation on the three primary seeds;
4. recomputes every statistic independently and mechanically applies the
   registered rule;
5. records the disposition and the retained failure side by side.

No threshold, metric, seed or historical result was changed in the process. The
agent approved nothing.

## 2. Acceptance state after this milestone

| Criterion | Version that governs it | Status | Evidence |
|---|---|---|---|
| L10-A | v1.6 | PASS (historical) | `work/l10_raw/final_run/report_raw.json` |
| L10-B | v1.6 | PASS (historical) | same |
| L10-C | v1.6 | PASS (historical) | same |
| L10-D | v1.6 | PASS (historical) | same |
| **L10-E** | v1.6, **retained unchanged** | **FAILED** — shuffled 0.132407 / context-off **0.425926** vs ≤ 0.40 | retained; re-measured identically in `work/l10_raw/official_evaluation_20261024/K1` |
| L10-E2 | v1.6 | PASS (historical supplement) | unchanged |
| L10-E3a/b/c | v1.6, provisional diagnostics | reported, no criterion | `work/L10_2_SPECIFICATION_RATIFICATION.md` |
| L10-F | v1.6 | FAILED (historical; unsatisfiable as written) | retained |
| **L10-F2** | v1.1 (owner A-1) | PASS | `work/L10_2_SPECIFICATION_RATIFICATION.md` |
| L10-G | v1.6 | PASS (historical, confounded arm) | retained |
| **L10-G2** | v1.1 (owner A-3) | PASS | `work/L10_2_SPECIFICATION_RATIFICATION.md` |
| L10-H | v1.6 | PASS | `work/l10_raw/final_run/report_raw.json` |
| L10-I | v1.6 | no new failures (regression battery, 26/26 exit 0) | `work/l10_raw/official_evaluation_20261024/regression/` |
| L10-J | v1.6 | reported honestly | this milestone |
| **L10-K1** | **v1.7 (owner Option B)** | **PASS** — all three clauses on all three primary seeds | `work/L10_4_OFFICIAL_EVALUATION.md` §D |

**The two context criteria are reported side by side and are not interchangeable.**
L10-E failed and stays failed; L10-K1 passed on its own registered evidence.
Neither result alters the other.

## 3. Approval record for this milestone

| Field | Value |
|---|---|
| New owner decision required? | **No** — the owner decided in L10.3 (Option B) |
| Decision relied on | `stark/reports/L10_3_ACCEPTANCE_DECISION.md` §5, Option B, 2026-10-24 |
| Ratified criterion text | L10-K1 as quoted in that record and in v1.7 §8 |
| Agent authority | none; the agent transcribed, registered, measured and recorded |
| Change to any threshold | **none** (`0.40`, `0.25`, `0.50` are the ratified values, fixed in the protocol hash before the run) |
| Change to any historical result | **none** |
| Newly authorised criteria | **L10-K1** (evaluated here) |

If the owner wishes to record anything further, the correct mechanism is a new
owner decision record; nothing here requires one.

## 4. What the pass does and does not mean

**It means:** on the frozen CCM configuration, over three primary seeds, the
availability of informative context improves task accuracy by 0.5185 / 0.5917 /
0.6296 over a *measured* context-ignoring policy, and improves bank selection by
0.6667 — its theoretical ceiling — on every seed, with every registered clause
satisfied. This is a real, reproducible, adversarially-checked capability.

**It does not mean:** that L10-E passed; that the system understands context in
any general sense; that it works beyond 3 tasks / 3 banks / 6 identities /
12 features; that misleading cues are harmless (they are destructive: 0.1324);
that cross-signature generalization is solved (0.5611, 0.0–1.0 per task); or that
anything resembling compositional intelligence has been demonstrated.

## 5. Standing constraint carried forward

Any future change to §8 — including the removal of the now-permanently-failed
L10-E — requires an owner decision and a new version, recorded the same way.
The failure may be *annotated* as retained-and-superseded, never rewritten, and
never converted to a pass.
