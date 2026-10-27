# L10.2 — Owner Decision (Owner Decision Record)

**Date:** 2026-10-24
**Type:** Governance / specification decision artifact. **Not** an implementation task.
**Authority:** repository owner (`Rahulrr324`). The frozen L10 criteria
(`stark/design/context_conditioned_memory_milestone.md` §8) contain no delegation
clause, so no agent, tool or report may amend them.
**Decision requested on:** the three amendments proposed in
`stark/design/l10_2_protocol_v1_1.md` §2 (A-1 sealing protocol, A-2 context
criterion, A-3 control separation).
**Question put to the owner:** which of A-1 / A-2 / A-3 are ratified as official
changes to the acceptance specification?
**Answer received:** **A-1 and A-3 — ratify; A-2 — not ratified.**
(Selected option "Ratify A-1 and A-3 only".)

---

## 1. What this decision changes

| Amendment | Scope | Decision | Effective text |
|---|---|---|---|
| **A-1** | L10-F sealing ablation | **RATIFIED** | **L10-F2** — sealing is evaluated in `SEAL-PAIR`, a protocol identical to v1.0 except `commit_trials = 240`, with matched arms differing only in `cfg.seal_superseded`; four conditions (§2 of the protocol) must hold on each of the three frozen masters |
| **A-2** | L10-E context criterion | **NOT RATIFIED** | none — L10-E remains exactly `shuffled-cue ≤ 0.40 AND context-off ≤ 0.40` |
| **A-3** | control separation | **RATIFIED** | **L10-G2** (capacity arm with `--reuse-seal 0`, original decision rule unchanged), plus informational records **L10-R1** (FROZEN-ROUTER decomposition) and **L10-S1** (sealing stress), both without criteria |

## 2. What this decision does **not** change

| Element | Status |
|---|---|
| L10-E (v1.0): `context-off mean ≤ 0.40` | **Frozen, still governing.** Measured `0.425926` ⇒ **FAILED**. Not redefined, not lowered, not superseded |
| L10-E2 (v1.0 supplement) | Unchanged |
| L10-A, L10-B, L10-C, L10-D, L10-H, L10-I, L10-J | Unchanged |
| L10-G decision rule ("K2 worse than CCM") | Text unchanged; only the *arm* is de-confounded |
| Frozen L10 results (H1) | Immutable |
| L10.1 diagnostics (H2) | Immutable |
| Any threshold in `context_conditioned_memory_milestone.md` §8 | Unchanged; that document is not edited by L10.2 |

**A-2 was declined.** Consequently every context diagnostic produced in L10.2
(E3a excess-over-floor, E3b margins, E3c per-bank diagonal) is a **provisional
diagnostic**, labelled as such in every artifact, and cannot alter L10-E's
disposition. No run in this milestone may be described as re-accepting L10-E.

## 3. Rationale recorded by the requester (not an approval claim)

The amendments were proposed *after* the L10 failures were investigated, i.e. they
are **post-hoc** with respect to those failures. That is precisely why they were
submitted for owner ratification instead of being applied by the agent. The
protocol (`l10_2_protocol_v1_1.md` §2) states each incompatibility from code and
measurement, and fixes every threshold before the registered run:
the 0.10 band is L10-A's own forgetting band; the 0.10 margin matches it; the
0.02 excess bound and the 0.99 diagonal bound are derived from the analytic floor
and from measured 1.000, and are therefore loose rather than tuned.

## 4. Provenance of this record

- Protocol hash at registration: commit `2fa3100`, sha256
  `e753d3fbd9ffa81c7a757cdcdbf71c6bd2d2e104d685d2901e14f593134c6cd5`.
- The only post-registration change before the run was the **v1.1.1 editorial**
  correction of the artifact directory name (wrong date label). No arm, metric,
  threshold, seed or decision rule was touched; the change is logged in the
  protocol's §10 and was made before any registered run existed.
- This record is written by the agent and quotes the owner's selection verbatim.
  It does not extend, infer or generalise that decision beyond the three
  amendments above.
