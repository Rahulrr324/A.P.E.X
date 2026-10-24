# STARK-L11.4 — C1–C7 Verification Matrix Update

**Supersedes nothing.** This is an *addendum* to
`work/L11_3_C1_C7_VERIFICATION_MATRIX.md` (sha256 `b1111703…`), which is left
byte-unchanged. The conditions below are quoted **verbatim** from
`work/L11_2_R3_AUTHORIZATION_AUDIT.md` §8 (commit `deac50f`), re-read from the file
in this milestone.

**Status vocabulary:** `SPEC` (specified) · `SPEC-ERRATUM` (specified, but the
specification of the verification contains an error) · `BLOCKED-ON-CODE` ·
`BLOCKED-ON-RUN` · `SATISFIED-NOW`.

---

## 1. Conditions and their L11.4 status

| ID | Verbatim (audit §8) | L11.3 status | **L11.4 status** | What changed |
|---|---|---|---|---|
| **C1** | *Separate writer only; `writeTrialCsv` and `writeTaskCsv` are not edited; legacy files must hash-match the disabled run* | BLOCKED-ON-CODE | **BLOCKED-ON-CODE** (unchanged) | Verified again: `writeTrialCsv` at 662, `writeTaskCsv` at 624, both untouched by any L11 milestone |
| **C2** | *Capture lives inside `evalTask`'s `if (rows)` block and before the restore at line 275; nothing is captured at any `runCCTrial` call site; the routing re-derivation block (505–521) emits no rows* | BLOCKED-ON-CODE | **BLOCKED-ON-CODE** (unchanged) | call-site inventory re-verified: 8 `dump_rows` call sites, 1 with `nullptr`, re-derivation block has 0 `push_back` |
| **C3** | *Update mass is captured per trial (no reuse of a stale `w0`); `advantage` uses a pre-call baseline snapshot at index 0* | BLOCKED-ON-CODE | **BLOCKED-ON-CODE, with a new caveat (D6/D7)** | "index 0" is correct only because `baseline_per_bank` defaults to `false`; the engine's index is `baseline_per_bank ? bank : 0` |
| **C4** | *Schema v0.2 first: add `task_bank`, `rule_bank`, `rule_compliant`, `presented[]`, `choice_matches_resolved_bank_map`; `routing_correct := selected == task_bank`; implement P7 against `rule_bank`* | SATISFIED (specification half) | **SPEC-ERRATUM** | C4's *requirement* stands; its *rationale* is factually wrong for `AMBIG11`, and the L11.3 verification assertion for P7 is wrong |
| **C5** | *Exactly one source file changes; no new RNG engine anywhere; no engine file touched* | BLOCKED-ON-CODE | **BLOCKED-ON-CODE** (unchanged) | — |
| **C6** | *The non-interference run must include checks 1–8 plus 7′, 9, 10, 11, 12, 13, 14 (§5) before any arm is implemented* | BLOCKED-ON-RUN | **BLOCKED-ON-RUN** (unchanged) | — |
| **C7** | *`ccSerialize` only at run start and task boundaries, never per trial* | BLOCKED-ON-CODE | **BLOCKED-ON-CODE** (unchanged) | — |

**No condition is satisfied.** C4 is the only one this milestone touches, and it
touches it by finding an error in the *verification*, not by satisfying it.

---

## 2. C4 — the erratum, precisely

### 2.1 C4's rationale contains a factual error

**[V]** `work/L11_2_R3_AUTHORIZATION_AUDIT.md:190–193`:

> "They coincide for `TRAIN`, `HOLDOUT`, `PARTIAL`, `CROSS21`, `CROSS31` and
> **`AMBIG11`** (by construction the majority group *is* the intended task's group),
> and they diverge for `MISLEAD` and `SHUFFLED` — which is exactly where the schema
> is silent."

**[V]** `AMBIG11` is "1 feature from `g(t)`, 1 from `g(o)`" (protocol §4). There is
no majority group; the case is a tie resolved by the declared tie-break, which
points at the **other** task's bank whenever `bank(g(o)) < bank(g(t))`. **The audit
is wrong about `AMBIG11`.**

**Effect on C4:** none on the requirement. The split is still necessary — and the
`AMBIG11` case makes it *more* necessary, because it is a third category (after
`MISLEAD` and `SHUFFLED`) where the two banks genuinely diverge, and the audit did
not know it. The audited *conclusion* is unchanged; the audited *reason* was
incomplete.

**Effect on the audit's own list of divergence categories:** it should read
`AMBIG11`, `MISLEAD`, `SHUFFLED` — not `MISLEAD`, `SHUFFLED`. This is recorded as a
**documentation erratum**, not a correction to the committed audit (which is frozen
and must not be edited).

### 2.2 C4's verification procedure (V4) is wrong

| L11.3 V4 | Corrected |
|---|---|
| "`git grep -n "intendedBankByRule"` must show that the function's argument list contains the cue **only** (no task index, no mapping), and that every caller assigns it to `rule_bank`." | "the signature must contain **no task index**; it **must** take the read-only group→bank map. Every caller assigns the result to `rule_bank`." |

**Why [V]:** cue ids are `int` in `[0, n_feat)`, group = `f / 4`. The map from
group to bank is `task_bank`, produced at run time by `ccAllocateNext`
(`ContextConditionedMemory.cpp:163–172`, `l10_validation_harness.cpp:381,404`).
Without it the helper cannot name a bank for a unique majority, let alone break a
tie by bank index. The L11.3 requirement as written was **unimplementable**.

**What V4 is actually protecting.** The purpose of "no task index" is to prevent
the rule from reading *which task is being evaluated* — that is the defect S1
vector. Reading the allocation map does not leak the evaluated task: the map is
shared by all tasks and is the same object `res.task_bank` used for `task_bank`
itself. The protection is preserved by banning the **task index**, not the map.

### 2.3 C4 remains the ordering constraint

C4 still must land **before** P7 is written (audit's own ordering), and it must
land **before** any arm is implemented (C6). Neither ordering is affected by this
erratum.

---

## 3. Newly verified supporting facts (no condition changes)

These were verified in this milestone and strengthen (or qualify) existing
conditions. They do **not** create new conditions, and this document does not
invent any.

| Fact | Where | Bearing |
|---|---|---|
| `CCResult::bank` is clamped to `[0,K)` — never `-1` | `ContextConditionedMemory.cpp:345` | C2/C3 bookkeeping; kills schema invariant 14 and protocol §8(i) as hard exclusions |
| evaluation routing is a **deterministic masked argmax** (no RNG) on non-learning trials | `ContextConditionedMemory.cpp:342` → `ccPreferredBank` | explains why check **6** (per-trial `selected_slot`) must be about the *slot* RNG, not the bank; the bank is deterministic |
| evaluation schedule is **all-pair** (120 multi-candidate) | `harness:507`; `RelevanceRouting.cpp:39–60` | `NA:SINGLE_CANDIDATE` cannot occur on evaluation rows |
| training stream is 480 single + 240 pair per task | `harness:338–342` | `NA:SINGLE_CANDIDATE` occurs on 2/3 of training rows; writer must handle it |
| `next_call` encodes `"<purpose>,<task>,<kind>"` and returns `-1` when rows are off | `harness:322–326` | C2's `record_class` classification is derivable from `call_id`, no guessing |
| the router update is gated by `learning_enabled && router_learning && mode == CC_LEARNED && forced_bank < 0` | `ContextConditionedMemory.cpp:483` | check 10's recomputation must use the same predicate (D7) |
| `advantage`'s baseline index is `baseline_per_bank ? bank : 0`; default `false`; harness never overrides | `ContextConditionedMemory.cpp:487`; `.h:69` | C3's "index 0" is correct today but is a default, not a contract (D6) |

---

## 4. What would make each condition satisfiable

| Condition | Needs |
|---|---|
| C4 | authorisation of the **v0.2.1 errata** (D1–D8) + the corrected P7 signature; still no code |
| C1, C2, C3, C5, C7 | an authorised, written patch (L11.3 §2 spec + §2.2/§2.4 of this document's errata) |
| C6 | an instrumented build; then the 13 checks |

Until the v0.2 errata are settled, a patch implementing v0.2 *as written* would
implement two unreachable invariants (D1), one wrong diagnostic (D2), an undefined
token (D3), and an unimplementable helper (D4). **That is the concrete cost of
skipping this review.**

---

## 5. Honest status

- C4: **SPEC-ERRATUM**. Not satisfied — its specification now has a known defect
  in its verification procedure.
- C1, C2, C3, C5, C7: **not verifiable**; no code exists.
- C6: **not runnable**.
- No condition is marked satisfied by documentation, and none is marked satisfied by
  this milestone.
