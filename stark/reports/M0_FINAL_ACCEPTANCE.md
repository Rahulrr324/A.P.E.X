# STARK Phase 1 (M0) — Final Acceptance Audit

**Date:** 2026-10-05
**Authority:** frozen `design/V009_phase1_M0_specification.md` (rev 1.1).
**Build/evidence state:** v2.4 (re-verified this audit, files untouched since).
**This is the final M0 acceptance report.** No later versioned M0 audit will be produced
unless a new factual contradiction is discovered.

---

## 0. Verdict — the eight plain questions

1. **Is M0 ACCEPTED?** **No.**
2. **Is it FAIL or BLOCKED?** **FAIL.** Every available evidence set definitively fails the
   mandatory gate G7; this is a decided, measured non-compliance — not an indeterminate one.
3. **What exact frozen requirement prevents acceptance?** **G7 (§G line 325):** *"Full re-run
   of the same suite with same config: every benchmark median within ±15% of the recorded
   median (memory bandwidth ±20%). … Tolerance is defined here once — later phases may not
   loosen it silently."* No evidence set in the project satisfies it — the historical nine
   permanently (16.13–48.04% vs 15%) and every fresh set attempted (v23-valid 47.55%;
   v2.1-diagnostics spreads 19–60%).
4. **Are the 15 missing records actually mandatory?** **No.** G8 (full analysis §1) is a
   current-run completeness/parseability gate over the records the reader can enumerate; the
   frozen specification contains no clause requiring recovery of any historical record, no
   reference to a 24-record dataset, and no requirement that the 15 removed records exist.
   Their absence is an **unresolved preservation limitation**, not a gate failure.
5. **Are G1/G3 historical failures actually acceptance blockers?** **No** (full analysis §2).
   The frozen acceptance scope is the current machine's verification run; G1/G3 are satisfied
   by legitimate current-machine records (PROFILE + structured no-CUDA attestations), which
   exist and pass. The historical set's missing PROFILE/E2/B4/B5 is a preservation gap, not a
   frozen acceptance requirement.
6. **Is G7 permanently blocking M0?** **Yes — G7-C.** The nine recovered records are
   immutable, append-only evidence that genuinely fails the frozen tolerance; the failure is
   permanent for them (§3). It is also not redeemed by any existing fresh evidence. The
   frozen contract does permit a *new* baseline as **new evidence** (§B: n≥10 configurable,
   warmup≥3, recorded affinity), but none exists in the project today, and a new baseline
   cannot retroactively pass the historical records (records are append-only, §F).
7. **Can M1 legitimately unlock?** **No, not while M0 = FAIL.** M1 unlock is gated on M0
   acceptance; M0 is not accepted; opening M1 before acceptance would violate the M0/M1
   boundary.
8. **What single concrete condition must be satisfied first?** **G7 must pass on the
   acceptance evidence.** Concretely: conduct a current-machine, same-configuration baseline
   campaign under the frozen methodology (≥2 independent runs per same-config group; n≥10
   timed iterations; ≥3 warmups; pinned/recorded affinity; zero tolerance changes) whose
   medians all fall within ±15% (±20% bandwidth), include the current-machine PROFILE and
   attested no-CUDA skip records (G1/G3), and run the production aggregator over that store
   to obtain **G1–G8 PASS**. That is the one and only gate currently unsatisfied by any
   available evidence.

---

## 1. G8 audit — exact text and the nine questions

**Verbatim frozen G8 (§G line 329):**

> G8 | `build/results/` contains a machine-readable record (JSON, `STARKP1 1`) for every
> executed benchmark/baseline and every profiler capture, parseable by the same reader used
> in tests.

**Implementation trace (production):** `aggregate.cpp` obtains records via
`RecordStore::loadAll()`, which globs `*.json` in the supplied store directory; every found
record must `parse_ok` and pass `validate()`, otherwise it is reported invalid (and in
`--strict` forces exit 1). Gate evaluation then runs G1–G7 over the valid records. G8's
mechanization is: (a) no present record may be unparseable/invalid/greater-lost; (b)
append-only store rejects schema mismatch with round-trip and parseability preserved
(`test_phase1_records.cpp`, 54 assertions); (c) every executed output in the store exists.
The implementation **cannot enumerate records that are not in the store** — completeness is
defined over the store it is given.

**Answers:**

1. **Does G8 require recovery of every historical record that once existed?** **No.** The
   text contains no recovery, archive, or history language; it addresses the `build/results/`
   store.
2. **Does G8 require a record for every benchmark execution represented by the current
   evidence?** **Yes**, in scope: every execution represented in the acceptance store must
   have its record present and parseable (that is exactly what the reader can verify).
3. **Does G8 require all 24 previously observed records to be present?** **No.** The frozen
   specification never references 24, 15, or any historical dataset; the in-project
   `RECOVERY_MANIFEST.json` attests 9 records; v2.0 found no artifact establishing 24.
4. **Is there any frozen requirement explicitly stating the 15 must be recovered?** **No.**
   No sentence in V009 mentions recovery or the missing records.
5. **Can completeness be established from the surviving nine plus project metadata?**
   Completeness of the **current verification store**: yes — every present record parses
   (controlled-valid exits 0, all 7 gates PASS, 0 invalid; v24 sha list 95/95). Completeness
   of the **historical archive**: cannot be certified from the nine plus metadata — but G8
   does not require it.
6. **Does G8 evaluate completeness of the current M0 verification run, or preservation of the
   entire historical archive?** It evaluates the **current verification run's store**
   (`build/results/` per the text; enforced by `loadAll`/`validate`/`strict` in the current
   run; §L.8 exit criterion anchors acceptance to "this machine"). It is a no-lost-records /
   parseability gate, not an archive-preservation audit.
7. **Exact G8 PASS condition:** every record for the executions represented in the
   acceptance store exists as parseable, schema-valid `STARKP1 1` JSON readable by the same
   reader, and append-only integrity holds.
8. **Exact G8 FAIL condition:** an execution represented in the store produced no record, or
   any present record is unparseable/invalid/rejected by the reader (strict mode exit 1),
   or the append-only store accepts/repairs a mismatched write.
9. **Is "15 missing" an actual frozen-requirement violation, or a preservation
   limitation?** A **preservation limitation**, not a frozen-requirement violation. It was
   treated conservatively as a blocker in v2.4 (§Blocker 3, G8 "every executed" reading
   taken universally); this audit corrects that reading: with the verbatim text and the
   production implementation, G8 scopes to the current verification store and no clause
   requires the 15. **The v2.4 completeness-blocker conclusion is hereby superseded.**

**G8 verdict: SATISFIED (current-run scope).**

## 2. G1/G3 acceptance scope

Frozen anchors: §L.8 exit criterion "aggregate.cpp reports G1–G8 pass **on this machine**";
§K integration "run_baseline --baseline E1 end-to-end produces a parseable record passing
G1+G4+G5+G8"; G1's text is about `collectStatic()` returning a complete profile; G3's text
selects its branch by the machine's CUDA availability. Acceptance is therefore **run-scoped
to the current machine's verification records**, not to the recovered archive.

- **Option B (current-machine legitimate evidence) is the frozen semantics.** G1 is
  satisfied by the genuine PROFILE record; G3 by the attested no-CUDA skip records —
  demonstrated PASS on v23-valid / v23-attested.
- **Option A (evidence must come from the historical nine) is not in the frozen text.**
  Nothing requires the historical set itself to carry gate evidence; the nine's missing
  PROFILE/E2/B4/B5 are preservation facts, and a new record cannot be "written into" an
  immutable historical record — but no such backfill is required.
- **Option C (both) is not in the frozen text** as a distinct requirement; preservation is
  satisfied separately (nine are byte-identical), and gate evidence is current-run.

**G1/G3 verdict: SATISFIED for M0 acceptance (current-machine evidence). Not blockers.**

## 3. G7 scope and a possible new baseline

- G7 applies to **same-configuration "recorded" medians** in the evaluated store; the frozen
  text contains no historical carve-out, so the historical nine are in scope if they are in
  the acceptance store — and they fail permanently (G7-C). This failure is not changed.
- A **new baseline is permitted** by the frozen mechanics (§B: n≥10 configurable, ≥3 warmup,
  pinned/recorded affinity) **as new evidence**; §F keeps records append-only, so it is a
  supplement, never a replacement, and cannot retroactively pass the historical nine.
- **No such baseline currently exists:** every fresh campaign in the project fails G7
  (v23-valid B6 47.55%; v21-diagnostics spreads 19–60%). G7 fails under every evidence scope
  available, so the scope question does not change the verdict.
- Per the constraints, **no new benchmark campaign was run** — the contract question is
  answered by the text, and the existing evidence already determines G7 = FAIL.

## 4. Separation of the three concepts

1. **Historical preservation** — what survived: the **nine** recovered records + raw samples,
   byte-identical to v2.0; v2.0–v2.4 reports/manifests/checksum lists preserved; 15 records
   are an honest, documented loss. Preservation is complete as to what exists.
2. **Current verification** — what can be legitimately executed now: fresh Debug/Release
   builds (0 warnings), 6/6 CTest both, 437 gate assertions, G1–G6 satisfied, G7 **failed**
   on every current evidence set, G8 satisfied as a store gate; Debug ≡ Release byte-
   identical on all 28 aggregator runs.
3. **M0 acceptance** — what the frozen spec requires: **G1–G8 PASS on this machine** (§L.8).
   Precisely one mandatory gate is unsatisfied: **G7**. The other historical gaps (missing
   PROFILE, missing E2/B4/B5, 15 missing records) are preservation limitations, **not**
   frozen acceptance criteria — a historical preservation limitation is not a gate failure
   unless the frozen acceptance criteria explicitly make it one, and none do.

## 5. Verification performed this audit (minimal, no new evidence generated)

- Builds: `build-v24-{debug,release}` present; `ninja` "no work to do" (exit 0).
- Tests: CTest **6/6 passed, exit 0**, both configs (pipefail-preserved).
- Gates: historical-nine exit 1 (G1/G3/G7 FAIL, G2/G4/G5/G6 PASS); v23-valid exit 1 (G7
  only); controlled-valid **exit 0, all gates PASS**; 437 gate assertions; every
  Debug/Release pair byte-identical.
- Integrity: `sha256sum -c sha256sums_v24.txt` **95/95 OK**; v23 list 140 OK / 3 FAILED
  (only the documented v2.4 source edits); v22 241/5, v21 101/5, v20 41/5 — all failures
  are the previously documented intentional source edits; nine recovered records **9/9**
  byte-identical in both archive locations.

## 6. Acceptance matrix

See `reports/m0_acceptance_matrix.json`. Of 16 mandatory rows: **14 satisfied, 2 not
satisfied** — G7 (and the gate-level reproducibility it composes). Every FAIL row cites the
exact clause: **§G G7**. No row is "probably required"; nothing is blocked by indeterminacy.

## 7. Decision (decision rule applied)

- Every mandatory frozen requirement satisfied? **No → not ACCEPTED.**
- At least one mandatory requirement definitively unsatisfied? **Yes (G7) → M0 = FAIL.**
- The unsatisfaction is fully determined by measurement on every available evidence set —
  not indeterminate → not BLOCKED.

```
M0 = FAIL
M1 = LOCKED (cannot unlock until M0 is accepted; the single gating condition is G7 PASS on
the current-machine acceptance evidence — see Q8)
```

No acceptance is manufactured, and no failure is manufactured from missing historical
artifacts: G1/G3/G8 and the 15 missing records are **not** the blocking conditions. The
definitive, measured blocker is **G7**, permanent over the immutable historical records and
unsatisfied by every current evidence set. **No further versioned M0 audit follows.**
