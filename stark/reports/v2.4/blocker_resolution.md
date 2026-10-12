# v2.4 — Blocker Resolution

**Date:** 2026-10-05
**Scope:** resolve the three remaining M0 blockers identified by v2.3 —
(1) G4 = FAIL, (2) G7 = FAIL, (3) historical completeness unresolved — against the frozen
`design/V009_phase1_M0_specification.md` only. No external archive was searched, requested,
extracted or referenced. No historical evidence, raw sample, threshold, grouping rule or
prior report was modified. No M1/APEX work was started.

---

## Blocker 1 — G4 = FAIL → **RESOLVED (Case B: interpretation corrected; G4 now PASSES)**

**Determination: Case B.** The frozen G4 text (§G line 325) fails a baseline *only* when a
peak memory field is **estimated**. It does not require measured VRAM for the CPU workloads
E1/E5 on a GPU-capable host running a CUDA-less build — that rule (and the "capability
Unknown ⇒ FAIL" rule) were v2.1–v2.3 interpretations layered on the spec, as v2.2 itself
documented. Full reasoning, including the rejected competing reading (§E's "peak RAM/VRAM
(measured)" shorthand) and why the literal reading is self-contradictory (E5 excludes CUDA by
definition; §A prescribes null+reason; §I and §L.8 require gates to be passable without CUDA),
is in `g4_spec_interpretation.md`.

**What changed (minimum correction, fail-closed preserved):**

- `src/phase1/gates.cpp` — `check_peak_memory()` rewritten to the frozen contract; the G4
  block now validates **every PASSED baseline record** ("Every baseline record's peak
  RAM/VRAM …"), not just the latest E1/E5. Physical capability (`gpu_present`) is computed
  but informational only.
- `src/phase1/gates.h` — rev 1.6 documents the corrected semantics.
- `tests/test_phase1_gates.cpp` — three superseded expectations corrected (documented
  flips), **+10 deterministic state cases** (estimated raw/nested peak, missing unavailability,
  unmeasured RAM, empty-hardware+measured, full GPU path, CPU-declared+cuda contradiction,
  GPU+measured, stale-record iteration, multi-record pass) → 437 assertions, 0 failures,
  Debug = Release.
- Untouched: `ExperimentRecord.*`, `HardwareProfiler.*`, `run_baseline.cpp`, `CMakeLists.txt`
  (SHA-256 identical to v2.3/v2.0 respectively), all fixtures, all records.

**Fail-closed states still FAIL:** unmeasured/estimated RAM; a VRAM value present while
`vram_measured=false` (the frozen fail condition); measured claim without a numeric value;
malformed/empty-reason unavailability; unavailability uncorroborated by the embedded
`hardware.cuda_available` boolean (G3 provenance principle — free text alone is never
evidence); unavailability contradicted by `cuda_available=true`; E1/E5 missing or not PASSED.

**Verified verdicts (v2.4 binaries, Debug ≡ Release byte-identical logs):**

| Evidence set | G4 v2.3 | G4 v2.4 |
|---|---|---|
| nine recovered | FAIL (capability unknown) | **PASS** |
| v21-candidate (`v21_evidence`) | FAIL | **PASS** |
| v23-valid (fresh candidate) | FAIL (GPU-capable, vram not measured) | **PASS** |
| `fixtures/v21/controlled-gpu-cuda-off` | FAIL | **PASS** |
| `fixtures/v21/controlled-unknown-capability` | FAIL | **PASS** |
| `fixtures/v21/controlled-gpu-vram-measured` | PASS | PASS |
| `fixtures/controlled-invalid-g4` (negative control) | FAIL | **FAIL** (E1 `ram_measured=false` — frozen fail condition, unchanged) |
| `fixtures/controlled-valid` (all-gates control) | PASS | PASS (all 7 gates, exit 0) |

No record or fixture was edited to move any verdict. **G4 is no longer an M0 blocker.**

---

## Blocker 2 — G7 = FAIL → **NOT RESOLVABLE: classified G7-C (permanent historical failure)**

Full analysis and the eight required answers are in `g7_spec_interpretation.md`. Summary:

1. **±15% tolerance: immutable** ("defined here once — later phases may not loosen it
   silently"). Unchanged in v2.4.
2. **n=10: a floor, not fixed** (§B "≥10 … configurable") — but existing records' n is frozen
   with them; higher-n runs form new configuration groups.
3. **Benchmark methodology: immutable** as to workload (fixed sizes/seeds).
4. **Warmup: floor ≥3**, more allowed, recorded in configuration.
5. **Affinity: allowed** (a recorded §F configuration field, §B pins thread count);
   power-state controls are unaddressed by V009 (permitted but unauditable).
6. **Fresh baseline: allowed as new append-only evidence only** — never a replacement.
7. **G7 evaluates the recorded same-config groups — historical records included** (no
   carve-out exists in the frozen text). The nine fail *internally*, so any comparison
   convention yields FAIL.
8. **Future measurements cannot replace current records** (§F append-only); a future passing
   benchmark is a new baseline, not a retroactive pass.

**Why not A:** no implementation defect found (medians consistent, grouping = "same config",
tolerance per spec — independently verified v2.2, reproduced v2.4).
**Why not B:** the spec's sampling/affinity levers only affect *future* records; every fresh
campaign to date also fails (v2.1 diagnostics spreads 19–60%; v23-valid B6 47.55%); an
environment campaign would be new evidence, not a repair of the historical failure — and is
deliberately not run (no unnecessary experiments).
**Why not D:** the frozen documents agree; the one textual under-determination (which
"recorded median" when a group holds several) is moot because the historical runs disagree
with each other under any convention.

**v2.4 G7 evidence (numbers byte-identical to v2.2/v2.3 — untouched):**

```
nine recovered / v21-candidate:
  B6  16.13%  (allowed 15.00%)  runs 1&3
  B7  18.38% / 21.26%          runs 1&3 / 2&3
  B9  27.65% / 28.18% / 48.04% runs 1&2 / 1&3 / 2&3
v23-valid (fresh):   B6 47.55%  runs 1&2
v21-diagnostics (fresh, 12 runs/bench): B6 pairs 32.41%–53.99%
```

**Conclusion:** G7 is a **permanent historical M0 blocker** (G7-C). No legitimate action can
make the immutable historical records pass; no alternative evidence set in the project passes
G7 either. **Blocker remains explicit.**

---

## Blocker 3 — Historical completeness → **MANDATORY; UNCERTIFIABLE → blocker remains explicit**

**Determination: the 15 missing historical records ARE mandatory for M0 acceptance.**

Reasoning, using only the current project:

1. The frozen spec's only completeness requirement is **G8**: *"build/results/ contains a
   machine-readable record (JSON, STARKP1 1) **for every executed benchmark/baseline and
   every profiler capture**…"* — an unqualified universal over executions, and G8 is part of
   the mandatory acceptance criterion (§L.8: "aggregate.cpp reports **G1–G8** pass on this
   machine").
2. Earlier project evidence establishes that **24 records were previously observed** (the
   v1.8 specification text stated the archive holds "24 historical JSON records"; the count is
   carried forward through v2.1–v2.3 as a reviewer-supplied external observation). **9**
   were recovered and verified (`RECOVERY_MANIFEST.json`, all SHA-256 matched); **15** are
   absent.
3. Under G8's plain text, records for those 15 executed benchmarks are required. They are not
   present anywhere in the project (v2.0 exhaustive inventory) and **cannot be recovered from
   the current project** — v2.4 forbids any external archive search, and none was performed.
   Completeness can be neither claimed nor fabricated.
4. Therefore G8 completeness **cannot be certified**; the completeness blocker cannot be
   closed at this stage. It is left explicit, exactly as required.

**Competing (run-scoped) reading — recorded, not adopted:** G8 could be read as covering only
the records produced *by the acceptance runs* (the ones `aggregate.cpp` can enumerate in
`build/results/`); mechanically, no gate detects absent historical records, and under that
reading the 15 would be useful-but-non-blocking preservation evidence. Two facts prevent
adopting this silently: (a) the plain text carries no "executed during acceptance" scoping;
(b) v2.0 already concluded "M0 cannot be declared accepted on an unverified subset" — waiving
a hard gate on an interpretive preference is precisely the silent reinterpretation this stage
is forbidden to perform. The choice belongs to the acceptance authority. **Either way the M0
verdict is unchanged**: even under the run-scoped reading, G7 (and the historical G1/G3 gaps)
still fail.

**What is NOT claimed:** no recovery, no completeness, no proof of the 24-record dataset
beyond the cited earlier evidence, no search of any archive.

---

## Additional historical-set gaps (not v2.3 "blockers", but they remain)

- **G1 over the nine recovered: FAIL** — no PROFILE record exists in the historical data.
  The immutable nine can never gain one; only *new* records can supply G1 evidence (as
  v2.1/v2.3 candidate sets do).
- **G3 over the nine recovered: FAIL** — the nine never contained E2/B4/B5 skip records, so
  there is nothing to attest; no structured attestation can be added to immutable records.
  Candidate sets with genuine, attested skip receipts pass G3 as new evidence.

These are permanent properties of the historical set, not repairable defects.

---

## Resolution summary

| Blocker | Outcome |
|---|---|
| G4 = FAIL | **CLOSED** — Case B determination; gate corrected to frozen text; G4 PASSes on all honest evidence; fail-closed integrity strengthened (corroboration/contradiction/estimated checks, every PASSED baseline validated) |
| G7 = FAIL | **NOT RESOLVABLE** — G7-C: immutable historical evidence genuinely and permanently fails ±15%; all fresh sets also fail; blocker explicit |
| Historical completeness | **MANDATORY + UNCERTIFIABLE** — G8 requires records for every executed benchmark; 15 missing and unrecoverable here; blocker explicit |
| G1/G3 over historical nine | permanent properties of the immutable set (covered only by *new* candidate evidence) |

**M0 = FAIL (BLOCKED). M1 = LOCKED.** This is the definitive v2.4 blocker report; no v2.5+
stage and no M1/APEX work follows from it.
