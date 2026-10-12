# STARK Phase 1 (M0) — Final Report v2.4

**Date:** 2026-10-05
**Scope:** Final M0 blocker-resolution stage. Resolve, against the frozen
`design/V009_phase1_M0_specification.md` only, the three blockers v2.3 left standing:
G4 = FAIL, G7 = FAIL, historical completeness unresolved. No external archive was searched,
requested, extracted, restored or referenced. No historical record, raw sample, threshold,
grouping rule, prior report or fixture was modified. No M1/APEX work was started.

**Decision: M0 = FAIL (BLOCKED). M1 = LOCKED.**
One blocker was legitimately resolved (G4 — the frozen text never required what v2.1–v2.3
assumed). Two blockers are permanent under the frozen contract (G7-C; historical completeness
mandatory but uncertifiable), plus the immutable historical set's G1/G3 gaps. This is the
definitive v2.4 blocker report; per the stop condition, no v2.5+ stage follows.

---

## 1. The seven required questions

### Q1 — Can G4 pass under the frozen specification?

**Yes.** Determination: **Case B** (`reports/v2.4/g4_spec_interpretation.md`). The frozen G4
rule (§G:325) fails a baseline *only* when a **peak memory field is estimated**. It does not
require measured VRAM for the CPU workloads E1/E5 on a physically GPU-capable host running a
CUDA-less build: ground rule 1 and §A prescribe `null + reason` for GPU fields without a CUDA
runtime; E5 excludes CUDA *by definition*; §I says the CPU-only core "can be delivered and
gated without any GPU work"; §L.8 makes "G1–G8 pass on this machine (G3 skipped-branch allowed
if no CUDA)" the exit criterion — a literal "measured VRAM always" reading makes the spec's
own exit criterion unreachable. The competing §E shorthand ("peak RAM/VRAM (measured)") is
documented and rejected as a literal mandate for those reasons — resolution recorded, not
silent.

The gate was corrected accordingly (fail-closed preserved and in places strengthened):
measured RAM still mandatory; a VRAM *value* present while `vram_measured=false` still fails
as **estimated** (the frozen condition); a measurement claim without a numeric value fails;
VRAM unavailability must be a structured `{value:null, reason}` **corroborated** by the
record's own `hardware.cuda_available === false` (G3 provenance principle — free text alone is
never evidence) and **contradicts**-fail when `cuda_available=true`. Physical capability
(`gpu_present`) is informational only. Scope is now stricter: **every** PASSED baseline record
is validated, not just the latest E1/E5.

**Demonstrated:** G4 = PASS on the nine recovered records, the v21-candidate set, the fresh
v23-valid candidate, both formerly-"unknown-capability" fixtures and the cuda-off fixture;
G4 = FAIL only on the intentionally-invalid control `fixtures/controlled-invalid-g4` (its E1
genuinely has `ram_measured=false`). Verdict changes came **only** from the interpretation
correction — zero records, fixtures or samples were touched.

### Q2 — Can G7 pass under the frozen specification?

**No — not for M0's evidence. Classification: G7-C** (`reports/v2.4/g7_spec_interpretation.md`).

- The ±15% tolerance is immutable ("defined here once — later phases may not loosen it
  silently"); grouping, samples, medians and records are append-only and untouched. The v2.4
  G7 output over the historical set is numerically identical to v2.2/v2.3 (16.13 / 18.38 /
  21.26 / 27.65 / 28.18 / 48.04 %).
- The nine recovered records are immutable historical evidence and **genuinely fail** — the
  three same-config runs of each historical group disagree mutually beyond 15%, so the failure
  holds under any comparison convention. No legitimate action can repair this.
- No fresh evidence set passes either: v23-valid B6 47.55%; v2.1 diagnostics B6/B7/B9 spreads
  19–60% (independently reproduced v2.2, re-run in v2.4).
- The spec permits future improvements (n≥10 configurable, warmup≥3, recorded affinity), but
  any such run is a **new baseline / new evidence** — never a retroactive pass (§F
  append-only). Running one would not change M0's outcome, so none was run.
- Not G7-A (no implementation defect found — medians consistent, grouping faithful,
  tolerance per spec), not G7-B (environment levers cannot touch immutable records; no
  campaign has ever passed), not G7-D (no conflicting frozen text; the one wording
  under-determination is moot because historical runs disagree internally).

### Q3 — Are the nine recovered records sufficient for M0?

**No.** Over the nine-record historical set (v2.4 binaries, Debug ≡ Release):

| Gate | Verdict |
|---|---|
| G1 | **FAIL** — no PROFILE record exists in the historical data (immutable; only *new* records can supply G1 evidence) |
| G2 | PASS |
| G3 | **FAIL** — the nine never contained E2/B4/B5 skip records; nothing exists to attest (immutable) |
| G4 | **PASS** (corrected to frozen text this stage) |
| G5 | PASS |
| G6 | PASS |
| G7 | **FAIL** — permanent (G7-C) |

Three gates fail over the nine; two of those failures are structural properties of the
immutable set and one is the permanent measurement-reproducibility gap. The nine are valuable,
byte-verified historical evidence — but not sufficient for M0.

### Q4 — Are the 15 missing historical records mandatory?

**Yes — mandatory, and uncertifiable from this project → the blocker stays explicit**
(`reports/v2.4/blocker_resolution.md` §Blocker 3). The frozen spec's only completeness gate,
**G8**, requires a record "for **every executed** benchmark/baseline and every profiler
capture", and G1–G8 pass is the mandatory exit criterion (§L.8). Earlier project evidence
establishes 24 records were previously observed (v1.8 spec text "24 historical JSON records";
carried through v2.1–v2.3 as a reviewer-supplied observation); 9 recovered, **15 absent**.
They cannot be recovered from the current project (v2.0 exhaustive inventory found none; no
external search is permitted and none was performed). The competing run-scoped reading of G8
(covering only the acceptance run's own outputs, which is what `aggregate.cpp` can mechanically
enumerate) is recorded for the acceptance authority but **not adopted unilaterally** — that
would waive a hard gate on an interpretive preference. Under either reading the M0 verdict
does not change; under the plain reading completeness remains an open blocker. No recovery
and no completeness claim is made.

### Q5 — What exact blockers remain?

1. **G7 = FAIL (G7-C, permanent).** Immutable historical same-config groups genuinely exceed
   the frozen ±15% tolerance; all fresh sets tried also fail. No legitimate remedy exists;
   a future improved benchmark would be a new baseline, not a pass.
2. **G1 = FAIL over the historical set** (no PROFILE record — unrepairable within immutable
   evidence; covered only by *new* candidate records).
3. **G3 = FAIL over the historical set** (E2/B4/B5 skip records never existed — unrepairable
   within immutable evidence; candidate sets with v2.3-structured attestations pass G3 as new
   evidence).
4. **Historical completeness uncertifiable** (mandatory per G8; 15 of 24 observed records
   missing and unrecoverable here).

G4 is **no longer a blocker** (closed this stage, Case B).

### Q6 — Is M0 ACCEPTED, FAIL, or BLOCKED?

**FAIL (BLOCKED).** Mandatory acceptance (all of G1–G8 over the acceptance evidence, with
certifiable historical completeness) is not satisfied: G7 fails permanently, G1/G3 fail over
the immutable historical set, and completeness cannot be certified. Every gate that could be
legitimately satisfied has been brought to PASS without altering any evidence; the remaining
failures are honest properties of the evidence, not correctable defects.

### Q7 — Should M1 remain locked?

**Yes — M1 remains LOCKED.** M0 is not accepted; the frozen contract forbids starting M1
until explicit M0 acceptance. No M1/APEX work was begun in v2.4.

---

## 2. What changed in v2.4 (source)

| File | Change |
|---|---|
| `src/phase1/gates.cpp` | `check_peak_memory()` corrected to frozen G4 (Case B); G4 block validates **every** PASSED baseline record; capability informational only (914 lines) |
| `src/phase1/gates.h` | rev 1.6 semantics documentation for the corrected G4 |
| `tests/test_phase1_gates.cpp` | 3 superseded expectations corrected + 10 new deterministic state cases (1,964 lines) |
| `CMakeLists.txt` | **UNCHANGED** (`cf8c7ad6…`, identical to v2.0–v2.3) |
| `ExperimentRecord.*`, `HardwareProfiler.*`, `run_baseline.cpp` | **UNCHANGED from v2.3** (SHA-256 re-verified identical) |
| fixtures, records, G7 thresholds/grouping | **UNCHANGED** |

Source SHA-256 (v2.4):

```
c4ff3a91d51090427a5ed1bbbefe40796c88f57adc7714e4eb7fc67b21a0ef4b  src/phase1/gates.cpp
f6dcb36f1072c501028bbff1f487ebb994629e6c2eabb607cd49c9cf5490d277  src/phase1/gates.h
431a19c244924aba3f4f209805f3d39904913439e397ea6530671f18e90428d6  tests/test_phase1_gates.cpp
c732f16d4c827f75606f19ac3ade957cb7663a7aa39620116643197180d1a9b1  src/phase1/common/ExperimentRecord.h   (unchanged vs v2.3)
7a068d693d03cc426c180c8ab174b83d6c8c19c08c6611f060b025e19b9e6fdc  src/phase1/common/ExperimentRecord.cpp (unchanged vs v2.3)
2f7972a81f36a44cec3e9342443e93424a2683c7e42feef9540bb2d2ae9326cf6  src/phase1/common/HardwareProfiler.h   (unchanged vs v2.3)
e20fa39aabcf1563599cb47994175de96bcceac537c3e6f07d27c056eaedc61a  src/phase1/common/HardwareProfiler.cpp (unchanged vs v2.3)
5f7701e5b7aebc4ba1ca21e4e14479441d8a78531ca83993730c26cb209d87ef  src/phase1/baselines/run_baseline.cpp  (unchanged vs v2.3)
cf8c7ad6c53c05b4e8180e063cdf9fa639f75fe8a752fa685883dc4f1d56e056  CMakeLists.txt                          (unchanged vs v2.0)
```

## 3. Fresh build & test results (v2.4)

Fresh builds `build-v24-debug/` and `build-v24-release/` (WinLibs GCC 16.1.0, C++17,
CMake 4.4.1 / Ninja, same configuration as v2.3):

| Config | Configure | Build | Warnings | Errors | Build steps |
|---|---|---|---|---|---|
| Debug | exit 0 | exit 0 | 0 | 0 | 103/103 |
| Release | exit 0 | exit 0 | 0 | 0 | 103/103 |

CTest (6 registered Phase-1 suites), both configs: **6/6 passed, exit 0** (verified with
pipefail).

Assertion counts (identical Debug/Release):

| Suite | v2.3 | v2.4 |
|---|---|---|
| test_phase1_profiler | 35 | 35 |
| test_phase1_accounting | 67 | 67 |
| test_phase1_budget | 55 | 55 |
| test_phase1_records | 54 | 54 |
| test_phase1_reproducibility | 37 | 37 |
| test_phase1_gates | 417 | **437** (+20: 10 new G4 state cases, ×2 checks each) |

## 4. Full G2–G7 evaluation (v2.4 binaries)

14 evidence sets × Debug + Release = 28 logs in `reports/v2.4/aggregator/`;
**every Debug/Release pair byte-identical**; every run exit code consistent.

| Evidence set | G1 | G2 | G3 | G4 | G5 | G6 | G7 | Overall |
|---|---|---|---|---|---|---|---|---|
| historical nine (`aggregator_input`) | **FAIL** | PASS | **FAIL** | **PASS** | PASS | PASS | **FAIL** | FAIL (3) |
| v21-candidate (`v21_evidence`) | PASS | PASS | **FAIL** | **PASS** | PASS | PASS | **FAIL** | FAIL (2) |
| v21-diagnostics (fresh, 36 rec.) | **FAIL** | PASS | **FAIL** | **PASS** | PASS | PASS | **FAIL** | FAIL (3) |
| v23-valid (fresh candidate) | PASS | PASS | PASS | **PASS** | PASS | PASS | **FAIL** | FAIL (1) |
| v23-attested | PASS | PASS | PASS | PASS | PASS | PASS | **FAIL** | FAIL (1) |
| v23-fabricated / contradictory / missing-e2 / malformed | PASS | PASS | **FAIL** | PASS | PASS | PASS | **FAIL** | FAIL (2) |
| fixtures/v21/controlled-gpu-cuda-off | PASS | PASS | **FAIL** | **PASS** | PASS | PASS | PASS | FAIL (1) |
| fixtures/v21/controlled-unknown-capability | PASS | PASS | **FAIL** | **PASS** | PASS | PASS | PASS | FAIL (1) |
| fixtures/v21/controlled-gpu-vram-measured | PASS | PASS | **FAIL** | PASS | PASS | PASS | PASS | FAIL (1) |
| fixtures/controlled-invalid-g4 (negative control) | PASS | PASS | PASS | **FAIL** | PASS | PASS | PASS | FAIL (1) |
| fixtures/controlled-valid (positive control) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** (0) |

Notes: the three v21 fixtures' G3 failures are their pre-v2.3 skips (no structured attestation)
— unchanged from v2.3; their **G4 verdicts flipped to PASS** under the Case B correction.
G3's verdicts on all five v23 sets are byte-identical to v2.3's (G3 semantics untouched).
G7 numbers on the historical sets are identical to v2.2/v2.3 (untouched).

## 5. Integrity & preservation verification

- `sha256sum -c reports/sha256sums_v23.txt` → **140 OK, exactly 3 FAILED**: `gates.cpp`,
  `gates.h`, `test_phase1_gates.cpp` — the three intentional v2.4 source edits. All other 140
  v2.3-era artifacts byte-identical (evidence sets, logs, fixtures, manifest, other sources).
- `sha256sum -c reports/sha256sums_v22.txt` → 241 OK, 5 FAILED — the identical five
  intentional source edits documented by v2.3 (no new failures).
- `sha256sum -c reports/sha256sums_v21.txt` → 101 OK, 5 FAILED — same documented set.
- `sha256sum -c reports/sha256sums_v20.txt` → 41 OK, 5 FAILED — same documented set.
- **Nine recovered records byte-identical: 9/9** match the v2.0 inventory hashes in
  `archive_recovery/aggregator_input/` **and 9/9** in `original_historical_records/`.
- No file outside `src/phase1/gates.{cpp,h}`, `tests/test_phase1_gates.cpp`, the new
  `reports/v2.4/` directory, `reports/M0_FINAL_REPORT_v2.4.md`,
  `reports/sha256sums_v24.txt` and the new `build-v24-{debug,release}/` build trees was
  created or modified.
- `reports/sha256sums_v24.txt` (LF newlines) contains 95 entries — the v2.4 report, every
  `reports/v2.4/` artifact (except the manifest itself, self-reference), the three edited
  sources, unchanged source anchors, CMakeLists.txt, the four prior checksum lists, the
  evaluated fixtures and the nine recovered records — and re-verifies with
  `sha256sum -c` **exit 0, 95/95 OK** (run after all v2.4 artifacts were final).

## 6. Evidence classification

- **Historical (frozen, untouched):** `../archive_recovery/{aggregator_input,
  original_historical_records,v21_evidence,v21_diagnostics}/`.
- **New v2.4 artifacts:** `reports/v2.4/{g4_spec_interpretation.md,
  g7_spec_interpretation.md, blocker_resolution.md, evidence_manifest.json,
  make_v24_manifest.py, aggregator/*.log}`, `reports/M0_FINAL_REPORT_v2.4.md`,
  `reports/sha256sums_v24.txt`, `build-v24-{debug,release}/`.
- **Preserved unchanged:** v2.0/v2.1/v2.2/v2.3 reports, evidence, manifests, checksum lists,
  all fixtures, all raw samples, G7 thresholds/grouping.

## 7. Stop condition

M0 **cannot** legitimately pass under the frozen contract: G7 fails permanently over the
immutable historical evidence (and over every fresh set tried), G1/G3 are structurally absent
from the immutable set, and mandatory G8 completeness is uncertifiable (15 records missing,
no recovery possible or claimed). Per the stage definition, this report is the **definitive
blocker report**. **M0 = FAIL (BLOCKED); M1 = LOCKED. No v2.5, no M1, no APEX work.**
