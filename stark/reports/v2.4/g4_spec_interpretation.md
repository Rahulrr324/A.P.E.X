# v2.4 — G4 Specification Interpretation (Case Determination)

**Date:** 2026-10-05
**Frozen source:** `design/V009_phase1_M0_specification.md` (rev 1.1), gate G4 at §G line 325,
benchmark B8 at §B, ground rules, §A profiler rules, §E baselines, §I dependency order, §L.8
exit criterion.
**Determination: CASE B — the frozen G4 specification does NOT require measured VRAM for the
E1/E5 workloads on a physically GPU-capable host running a CUDA-less build. The stricter
"GPU-capable host ⇒ measured VRAM" rule (and the "capability Unknown ⇒ G4 FAIL" rule) used by
v2.1–v2.3 were interpretations layered on top of the frozen text and are corrected here.**
The competing reading (§E's shorthand "peak RAM/VRAM (measured)") is documented below with the
reasons it is rejected as a literal mandate — the ambiguity is resolved by the spec's own
internally consistent clauses, not chosen silently.

---

## 1. The exact frozen text

**G4 (§G):**

> Every baseline record's peak RAM/VRAM comes from process/device queries (B8), with
> `measured: true`; any estimated field is flagged and gate G4 fails if a *peak memory* field
> is estimated.

**B8 (§B):** Peak working set (Windows `GetProcessMemoryInfo`) / peak VRAM delta
(`cudaMemGetInfo` before/after), during B6/B7 and stress ladder.

**Ground rule 1:** "If a quantity cannot be obtained, the field is `null` with the reason
recorded — never a guess or a web-table constant."

**§A (profiler):** GPU fields (`gpu_model`, `vram_total_bytes`, …) are obtained
"**via CUDA runtime if built with it, else null + reason**".

**§E:** "Each baseline record must contain: … peak RAM/VRAM (measured) …" — and E5 is
"E1–E3 forced to CPU-only build/run (**CUDA excluded**) … **always**".

**§I:** "Steps 1–7 form the CPU-only core and **can be delivered and gated without any GPU
work**; step 8 is strictly additive and skippable on a CPU-only machine."

**§L.8 (exit criterion):** "aggregate.cpp reports G1–G8 pass **on this machine**
(G3 skipped-branch allowed if no CUDA)."

## 2. Trace — the required questions

### 2.1 What workloads does G4 apply to?

Baseline records (§E experiments E1–E5). The production gate (unchanged in v2.4) requires
**E1 and E5 present and PASSED** — the two baselines that are "always" required (E1 CPU FP32,
E5 CPU-only equivalent). v2.4 additionally validates the peak block of **every PASSED baseline
record** (the frozen wording is "Every baseline record's peak RAM/VRAM …"), not only the latest
E1/E5 — a strictness correction, not a relaxation. Both workloads are **CPU workloads**
(TINY-DENSE-2L FP32 forward on CPU; E5 excludes CUDA by definition). Neither workload performs
GPU execution on this build.

### 2.2 What hardware evidence is mandatory?

- **RAM:** `ram_measured = true` with a positive, finite numeric `ram_peak_bytes`, from the
  B8 process query. Mandatory for every checked record — RAM is always obtainable on Windows
  (`GetProcessMemoryInfo`), so no unavailability excuse exists.
- **VRAM:** either a measured numeric value with `vram_measured = true`, or a structured
  unavailability `{value: null, reason: <non-empty>}` with `vram_measured = false` that is
  **corroborated by the record's own embedded hardware snapshot**
  (`hardware.cuda_available === false` — the G3 provenance principle applied to VRAM).
- An embedded hardware snapshot is required for that corroboration (§F mandates that every
  record embeds `hardware`).

### 2.3 When is RAM evidence sufficient?

Exactly when `ram_measured == true` and `ram_peak_bytes` is a positive finite number. There is
no RAM-unavailability path in practice: B8's process query needs no CUDA, no driver, no GPU.
A non-measured or estimated RAM peak always fails G4 (frozen fail condition).

### 2.4 When is VRAM evidence mandatory?

When the record's own snapshot shows the designated device query was available:
`hardware.cuda_available === true` ⇒ `cudaMemGetInfo` existed at run time ⇒ a measured,
positive, finite `vram_peak_bytes` with `vram_measured = true` is mandatory (an unavailability
claim then **contradicts** the record and FAILs).
Conversely, `hardware.cuda_available === false` ⇒ the designated query path (§A/B8: CUDA
runtime) did not exist ⇒ the spec's own prescribed representation is null + reason, and G4
must not demand a measurement the spec itself says cannot be taken.
A value that the record *claims* as measured (`vram_measured = true`) must always be a positive
finite number — capability does not change that.

### 2.5 What constitutes valid VRAM provenance?

Two and only two shapes:

1. **Measured:** `vram_measured = true` + `vram_peak_bytes` = positive finite number.
   The flag is the schema's provenance assertion (§F `measured_vs_estimated` flags).
2. **Unavailable:** `vram_measured = false` + `vram_peak_bytes = {value: null,
   reason: <non-empty string>}` + `hardware.cuda_available === false` (machine-checkable
   corroboration of the claim).

Anything else fails closed: free-form reason text without embedded capability evidence is
**not** sufficient (G3 principle, v2.3); a value present while `vram_measured = false` is an
**estimated peak** — the frozen G4 fail condition; a `vram_measured = true` claim without a
numeric value is malformed and fails; `cuda_available = true` + unavailability is a
contradiction and fails.

### 2.6 What does `cuda_available = false` mean?

It is the result of the CUDA Runtime probe (`cudaGetDeviceCount`) recorded in the record's
embedded snapshot: *the CUDA runtime could not be queried in this build/run*. It is:

- **not** evidence that the machine lacks a GPU (v2.1/v2.3 lesson — physical presence is a
  separate question, answered by `gpu_present`);
- **not** a reason to fail a gate by itself;
- **is** the machine-checkable basis for a VRAM-unavailability claim: the spec's designated
  VRAM measurement (§A/B8) is the CUDA runtime, and this flag says it was absent.

### 2.7 How does `gpu_present` interact with G4?

**It does not — under the frozen text.** Frozen G4 never mentions physical GPU presence;
`gpu_present` is not even part of the frozen `StaticHardwareProfile` schema (it was added in
v2.x for G3's fail-closed capability detection). In v2.4:

- `gpu_present` creates **no measurement obligation** at G4 (removing the v2.1 rule);
- `gpu_present` **cannot excuse a contradiction** (with `cuda_available = true`, a measured
  VRAM value is still mandatory; with `cuda_available = false`, unavailability is still
  acceptable regardless of `gpu_present` being true/false/unknown);
- it is computed and reported **informationally** in the G4 success detail
  ("physical capability gpu/cpu/unknown — informational, not a G4 criterion").

### 2.8 How is unavailable VRAM represented?

`vram_measured = false` and `vram_peak_bytes = {value: null, reason: "unavailable: …"}` —
exactly the representation ground rule 1 and §A prescribe. It is **never**:

- zero (unknown is never represented as zero);
- a numeric value (that would be an estimate → frozen fail condition);
- `vram_measured = true` (unavailable is never represented as measured);
- bare free text without the corroborating embedded probe result.

### 2.9 Is the old interpretation actually required by the frozen specification?

**No.** The frozen G4 states exactly one fail condition for values: *a peak memory field that
is estimated*. The v2.1–v2.3 rules —

- R1: "GPU-capable host ⇒ measured VRAM required" (v2.1, retained through v2.3);
- R2: "capability Unknown ⇒ G4 fails closed" (v2.2/v2.3, post-GPU-detection);

— appear nowhere in the frozen text. v2.2 itself recorded this: *"The frozen G4 text
(V009:325) … does not literally mandate measured VRAM on a GPU-capable host with no CUDA. The
v2.1 rule … is a stricter, fail-closed interpretation layered on the spec."*

## 3. The competing reading and why it is rejected

The only text that can be read as mandating measured VRAM for *every* baseline is §E's summary
phrase "**peak RAM/VRAM (measured)**". Taken as a literal, unconditional mandate it makes the
specification self-contradictory:

1. **E5 is unsatisfiable on ANY build.** E5 is defined as "CPU-only build/run (**CUDA
   excluded**)" and is required "**always**". B8's only VRAM mechanism is `cudaMemGetInfo`.
   A literal mandate would require E5 — which excludes CUDA by definition — to carry measured
   VRAM. No build can satisfy that; the spec cannot intend an impossible requirement for its
   mandatory baseline.
2. **It contradicts §A.** §A explicitly prescribes GPU fields = "null + reason" for non-CUDA
   builds. A gate that fails records for carrying exactly the prescribed representation
   would make §A and G4 mutually unsatisfiable.
3. **It contradicts §I.** "Steps 1–7 … can be **gated** without any GPU work" — i.e., gates
   must be passable on the CPU-only core.
4. **It contradicts the §L.8 exit criterion.** "aggregate reports G1–G8 pass **on this
   machine** (G3 skipped-branch allowed if no CUDA)" — this machine has no CUDA, and no
   non-CUDA VRAM query exists in the spec; the literal reading makes the spec's own exit
   criterion unreachable.
5. **G4's own fail condition is precise.** The gate fails a peak field when it is
   *estimated* — a null + reason field is not estimated; that is the entire distinction the
   sentence draws.

Reading (i) — "§E (measured) means: whatever peak values the record carries must be measured,
never modeled/estimated; unobtainable ⇒ ground rule 1 null+reason" — is consistent with all
five clauses above. That reading is adopted (Case B, not Case C): the ambiguity is resolved
by the spec's own convergent text, and the resolution is recorded here rather than applied
silently. Had the clauses conflicted instead of converged, this would be a Case C
(however, note that even under the strict reading the M0 verdict would not change: G7,
G1/G3 and completeness remain FAIL independently — see `blocker_resolution.md`).

**Case A was therefore not reached:** no new VRAM measurement path (DXGI/NVAPI/etc.) is
required or introduced. Adding one would be an unnecessary dependency the frozen spec does not
ask for — the frozen contract for a CUDA-less build is null + reason.

## 4. What the corrected gate still fails on (fail-closed preserved)

The correction removes an *added measurement requirement*; it does not weaken evidence
integrity. `check_peak_memory()` still FAILs on:

| State | Verdict | Why |
|---|---|---|
| `peak_memory` missing / not an object | FAIL | no evidence |
| `ram_measured != true` or RAM not positive finite | FAIL | RAM always obtainable (B8) |
| `vram_measured = true` but value missing / non-numeric / ≤0 / non-finite | FAIL | measured claim without a value |
| numeric VRAM value present while `vram_measured = false` (top-level or nested) | FAIL | **estimated peak — the frozen G4 fail condition** |
| unavailability object with missing/empty/non-string reason, or non-null value | FAIL | malformed / unmeasured value |
| unavailability without embedded `hardware.cuda_available` boolean | FAIL | free-form text alone is not evidence (G3 principle) |
| unavailability with `hardware.cuda_available = true` | FAIL | contradiction: the device query existed |
| hardware snapshot absent | FAIL | §F requires it; claim uncorroborated |
| E1 or E5 missing / latest not PASSED | FAIL | rev 1.4 contract; §E "always" |

States are distinguished exactly as required: physical GPU present (`gpu_present` true/false/
unknown — informational), CUDA available (`cuda_available` probe), VRAM measurable
(`vram_measured = true` + value), VRAM unavailable (`value: null` + reason + corroborating
probe), provenance (flags + embedded snapshot).

## 5. Verdict changes (v2.3 → v2.4), same inputs, same records

| Evidence | v2.3 G4 | v2.4 G4 | Reason for the change |
|---|---|---|---|
| nine recovered (`aggregator_input`) | FAIL (`capability unknown … refusing to classify`) | **PASS** | capability is not a G4 criterion (R2 removed); RAM measured + corroborated VRAM unavailability satisfy frozen G4 |
| v2.3 fresh candidate (`v23-valid`) | FAIL (`GPU-capable … vram_measured is false`) | **PASS** | R1 removed; `gpu_present=true` creates no G4 obligation |
| v21-candidate (`v21_evidence`) | FAIL | **PASS** | same |
| `fixtures/v21/controlled-gpu-cuda-off` | FAIL | **PASS** | R1 removed (fixture README expectation superseded; fixture data untouched) |
| `fixtures/v21/controlled-unknown-capability` | FAIL | **PASS** | R2 removed (README expectation superseded; fixture data untouched) |
| `fixtures/v21/controlled-gpu-vram-measured` | PASS | PASS | unchanged |
| `fixtures/controlled-invalid-g4` | FAIL | **FAIL** | unchanged — its E1 record genuinely has `ram_measured=false` (still the frozen fail condition) |

No record, fixture, sample, threshold or grouping rule was modified to obtain any of these
verdicts; only the gate interpretation was corrected to the frozen text, and the corrected
gate is *stricter* in scope (every PASSED baseline record validated) and in integrity
(uncorroborated/contradictory unavailability now fails) than the gate it replaces.

## 6. Determination summary

**Case B.** G4 can legitimately pass under the frozen specification — and does, on every
evidence set whose baseline records honestly follow the spec's own prescribed representations.
The v2.1–v2.3 stricter rules are withdrawn as interpretive layers, documented here, with the
withdrawal verifiable in `src/phase1/gates.cpp` (`check_peak_memory`, rev 1.6 in `gates.h`)
and `tests/test_phase1_gates.cpp` (G4 block, +10 deterministic state cases, 437 assertions).
