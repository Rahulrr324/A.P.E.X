# STARK-L11.2 — Proposed Owner Decision Record

> **STATUS: PROPOSED. NOT APPROVED. NOTHING HERE IS IN FORCE.**
>
> Every field marked `PENDING` must be completed by the repository owner
> (`Rahulrr324`). No decision below has been made, inferred, or recorded on the
> owner's behalf. The agent has no approval authority.
>
> This file exists so that the owner has three separate, unambiguous decisions to
> answer — the same procedure used for L10.5 (A/B/C) and L10.2 (A-1/A-3).

**Prepared:** 2026-10-24 by the STARK-L11.2 R3 audit.
**Evidence:** `work/L11_2_R3_AUTHORIZATION_AUDIT.md` (+ `.json`).
**Repository state at preparation:** branch `validation/l11-2-r3-audit`, parent
commit `c547aab658cb1852b68bad2626e5a076346ec766`.

---

## Decision R1 — Ratify the L11 acceptance criteria (L11-A … L11-G)

| Field | Value |
|---|---|
| Question | Do you ratify the seven candidate criteria recorded in `stark/design/l11_cross_signature_compositional_generalization.md` §6 and `work/L11_1_PREREGISTRATION.json`, unchanged, as the frozen acceptance criteria for L11? |
| Options | **1.** Ratify all seven as written. **2.** Ratify with amendments (specify which, and note that any amendment must be published before any evidence exists). **3.** Do not ratify yet. |
| Default if unanswered | **Not ratified.** The criteria remain candidate thresholds; no official run may be scored against them. |
| Consequence of approving | L11-A…G become frozen and may not be changed in response to a result; any later change needs a new versioned specification with a fresh owner decision. |
| Consequence of not approving | L11.3 (implementation) may still proceed; L11's official evaluation may not. |
| **Owner answer** | **PENDING** |
| **Date** | **PENDING** |

Note carried into this decision: at n = 120 the L11-A pass condition is 108/120;
`P(pass | true = 0.90) ≈ 0.576`, so a pass is *consistent with* ≥ 0.90 and is not
proof of it. Ratifying L11-A ratifies that qualification too.

---

## Decision R2 — Disposition of `test_phase1_affinity`

| Field | Value |
|---|---|
| Question | How should the Win32-dependent affinity test be treated in the Linux validation gate? |
| Options | **1.** Port it: guard Case C (`GetProcessAffinityMask`) with `#ifdef _WIN32` and use a portable pointer-width mask type, so Cases A/B run on Linux and Case C reports `SKIPPED (Win32-only)`. **2.** Declare it permanently Windows-only and exclude it from the Linux gate in writing. **3.** Leave it as it is (neither ported nor formally excluded). |
| Default if unanswered | **Status remains UNKNOWN / UNEXECUTED.** It is neither a pass nor a failure and is excluded from every "all tests pass" statement. No port is applied. |
| Consequence of approving option 1 | The portable mask-enumeration regression starts running on Linux; the machine-specific half stays honestly skipped. |
| Consequence of approving option 2 | The gap is documented rather than closed; the Win32 path remains unverified everywhere. |
| Evidence | 44 assertions; 10 `DWORD_PTR` uses; Case C calls the live API unguarded. Verified by compiling the unmodified file and a patched `/tmp` copy — a type alias alone is insufficient. |
| **Owner answer** | **PENDING** |
| **Date** | **PENDING** |

---

## Decision R3 — Authorize the instrumented harness change

| Field | Value |
|---|---|
| Question | Do you authorize the additive, default-off instrumentation described in `work/L11_2_PREPARED_DIFF.md`, to be implemented under conditions C1–C7 of `work/L11_2_R3_AUTHORIZATION_AUDIT.md` §8? |
| Options | **1.** Approve R3 with conditions C1–C7 (audit recommendation). **2.** Approve R3 unconditionally. **3.** Approve only the schema correction C4 first, and re-ask R3 after it. **4.** Do not approve R3 yet. |
| Default if unanswered | **Not authorized.** No source or harness file may be modified; the L11.2 report's readiness package stays as-is. |
| Scope if approved | One file: `stark/src/learning/l10_validation_harness.cpp`. No engine change, no test change, no threshold change, no protocol change, no L10 artifact touched. |
| Explicitly **not** included | An official L11 evaluation. Approving R3 authorizes *instrumentation only*. Zero official trials remain zero. |
| Condition summary | **C1** separate writer, legacy writer untouched · **C2** capture inside `evalTask`'s `if (rows)` block before the restore, never at `runCCTrial` call sites · **C3** per-trial mass, pre-call baseline snapshot · **C4** schema v0.2 first (fix `intended_bank`/`routing_correct` conflation, `Read` for MISLEAD, add `presented[]`) · **C5** one file, no new RNG, no engine file · **C6** the extended non-interference test before any arm · **C7** `ccSerialize` at boundaries only |
| **Owner answer** | **PENDING** |
| **Date** | **PENDING** |

### Why C4 is not optional

The L11.1 schema defines `intended_bank` as "the bank prescribed by the declared
rule" and `routing_correct = (selected_bank == intended_bank)`. Under R-majority,
a `SHUFFLED` cue has a well-defined prescription — the **wrong** bank — so a
literal implementation records `routing_correct = 1` for a system that was
successfully misled, contradicting the published L10.3 `shuffled` routing of
0.0000. The same field is also needed in its L10 sense ("the bank that owns the
evaluated task"). One field cannot carry both meanings, and the error would be
silent.

Applying C4 changes **no threshold, no criterion and no measured value**. It
requires re-freezing the schema as v0.2 and re-recording its hash in the
pre-registration — a documented version change, which is the only permitted route.

---

## What approving these decisions does **not** authorize

- Running the official L11 evaluation.
- Creating, merging or modifying any pull request.
- Changing any L10 criterion, threshold, result or frozen artifact.
- Implementing the six missing L11 cue categories.
- Claiming that compositional generalization has been demonstrated.

## Recording

Answers should be recorded here (or in an equivalent owner-authored file) with the
owner's identity and the date, before any consequence is acted upon. Until then
this document is a **proposal**.
