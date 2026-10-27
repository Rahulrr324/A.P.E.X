# STARK-L11.6 — C1–C7 Readiness Status

Conditions quoted **verbatim** from `work/L11_2_R3_AUTHORIZATION_AUDIT.md` §8
("The seven conditions"), read from the committed file in this milestone.
Audit sha256 `5045c1576cd207e42cc58638163b3a1c74f73fcea1fbfadeef978e290fcf1015`.

| # | Condition (verbatim) | Status | Evidence | What remains |
|---|---|---|---|---|
| **C1** | "Separate writer only; `writeTrialCsv` and `writeTaskCsv` are not edited; legacy files must hash-match the disabled run" | **BLOCKED-PENDING-IMPLEMENTATION** | `writeTrialCsv` at `harness:662` and `writeTaskCsv` at `:624` are untouched in every L11 commit **[V]**; no separate writer exists **[V]** | write `writeL11Csv`; then hash-compare legacy files with the flag off |
| **C2** | "Capture lives inside `evalTask`'s `if (rows)` block and **before** the restore at line 275; nothing is captured at any `runCCTrial` call site; the routing re-derivation block (505–521) emits no rows" | **BLOCKED-PENDING-IMPLEMENTATION** | anchors re-verified: `if (rows)` ends `:272`, restore `:274`, re-derivation block contains **zero** `push_back`, 8 `dump_rows` call sites of which one passes `nullptr` (`:592`) **[V]** | implement capture; assert 120 rows/call |
| **C3** | "Update mass is captured per trial (no reuse of a stale `w0`); `advantage` uses a pre-call baseline snapshot at index 0" | **BLOCKED-PENDING-IMPLEMENTATION** (with two latent caveats) | `w0` refreshed only under `measure \|\| maybe_opp` (`:429`) **[V]**; the engine's baseline index is `baseline_per_bank ? bank : 0` (`CCM.cpp:487`), default `false`, never overridden by the harness **[V]** — so "index 0" is correct *by default*, not by contract | implement; then recompute mass and `advantage` from boundary dumps |
| **C4** | "**Schema v0.2 first:** add `task_bank`, `rule_bank`, `rule_compliant`, `presented[]`, `choice_matches_resolved_bank_map`; define `routing_correct := selected == task_bank`; implement P7 against `rule_bank`" | **SATISFIED AT SPECIFICATION LEVEL ONLY — and the specification has known errors** | schema v0.2 exists with all five fields and both derivations **[A]**; but P7 as specified ("cue only") is **not implementable** — a group index is not a bank index and the group→bank map is required **[V]**; and the audit's rationale is wrong about `AMBIG11` **[V]** | adopt v0.2.1 errata D1–D8; correct the P7 signature; then implement |
| **C5** | "Exactly one source file changes; no new RNG engine anywhere; no engine file touched" | **BLOCKED-PENDING-IMPLEMENTATION** | no patch exists; the "one modified line" claim is an **estimate**, not a measurement **[A]** | implement; `git diff --stat` must show one file and the RNG grep must be empty |
| **C6** | "The non-interference run must include checks 1–8 **plus** 7′, 9, 10, 11, 12, 13, 14 (§5) before any arm is implemented" | **BLOCKED-PENDING-RUNTIME-TEST** | no instrumented binary exists; **none** of the 13 checks has ever been executed **[V]** | all 13 checks |
| **C7** | "`ccSerialize` only at run start and task boundaries, never per trial" | **BLOCKED-PENDING-IMPLEMENTATION** | current calls: `evalTask` entry when `read_only` (`:173`), the re-derivation snapshot (`:504`), the round-trip probes (`:601–603`, `:829–838`) **[V]** | implement; review + timing |

---

## Classification summary

| Class | Count | Conditions |
|---|---|---|
| satisfied by verified evidence | **0** | — |
| satisfied at specification level only | **1** | C4 (and it carries an erratum) |
| blocked pending implementation | **5** | C1, C2, C3, C5, C7 |
| blocked pending runtime test | **1** | C6 |
| blocked pending owner decision | **5** *(indirect — see below)* | all of them, via R1/R4/R5 |
| unresolved | **0** | — |

**A documentation correction does not prove implementation readiness.** C4's
requirement is written down; the file that writes it down contains an unimplementable
helper specification and an incorrect rationale. Neither is a reason to believe the
implementation is closer than it is.

---

## Additional prerequisite this milestone raises

| Finding | Effect on C1–C7 |
|---|---|
| **F4 — protocol §5's stream seeds disagree with the code** (`9500` vs `9100 + t`; `9600` vs `9400 + t`; `9300` mislabels the argument slot) | **C6 check 14** ("new file byte-identical across two runs") cannot be interpreted until the stream table is corrected; **L11-E** depends on it |
| **D4 — P7 needs the group→bank map** | C4 cannot be implemented as written |
| **D1 — `selected_bank = -1` unreachable** | protocol §8(i), which C2/C3 bookkeeping would rely on, is **inert** |
| **D2 — the margin must be candidate-masked** | a v0.2 writer implemented literally would emit a wrong diagnostic |

---

## Honest statement

**No condition is satisfied.** The only change since L11.5 is that this milestone
verified the chain from "frozen criteria" to "implementable instructions" and found
three further defects on that path (F4, and re-confirmation of D1/D4). The
implementation is **no closer to start** than it was; it is, however, **better
specified**.
