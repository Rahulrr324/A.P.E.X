# G3 Integrity Audit — v2.3

**Scope:** Close the v2.2 weakness that G3 accepted arbitrary `SKIPPED` /
`NOT_ATTEMPTED` records whenever CUDA was unavailable.

## 1. Problem (v2.2 finding)

The old no-CUDA branch accepted a skip when:
- the record existed,
- `status` ∈ {SKIPPED, NOT_ATTEMPTED}, and
- `status_reason` was non-empty.

The v2.2 audit (`reports/v2.2/tests/test_v22_g3_semantics.cpp`, 10 checks / 0
failures against the v2.1 library) demonstrated that `"x"`, `"because"` and
`"lorem ipsum"` all PASSed, that a self-contradictory `cuda_available=true`
PASSed, and that the branch therefore proved only "a JSON string exists".

## 2. Fix

Smallest explicit, provenance-bearing representation compatible with the existing
schema: one new optional record field `skip_attestation` (object). No prose
parsing, no new dependency, no schema-version bump.

New production validator `validate_no_cuda_skip()` (`src/phase1/gates.cpp`)
requires, for each of E2/B4/B5:

| Field | Required value |
|---|---|
| `schema` | `"STARKP1 skip-attestation 1"` |
| `reason_code` | `"cuda_unavailable"` |
| `capability_state` | `"cuda_unavailable"` |
| `execution_availability` | `"not_available"` |
| `capability_source` | non-empty string |
| `producer` | non-empty string |
| `cuda_available` | boolean `false` |

Plus: `status_reason` non-empty; `hardware.cuda_available` not `true` (record's
own snapshot must not contradict the skip). Anything else fails closed.

## 3. Failure taxonomy (what the gate now distinguishes)

| Class | Example | Result |
|---|---|---|
| legitimate environment/build limitation | valid attestation, `cuda_available=false` | **PASS** |
| arbitrary/fabricated skip | `"x"`, `"because"`, `"lorem ipsum"`, unknown `reason_code` | **FAIL** |
| contradictory capability evidence | attestation or hardware `cuda_available=true`; `capability_state=cuda_available` | **FAIL** |
| missing evidence | no attestation; missing `capability_source`/`producer`; missing/typed-wrong fields | **FAIL** |
| missing E2/B4/B5 | record absent | **FAIL** |
| malformed record | `skip_attestation` non-object | **FAIL** (record invalid) |

## 4. Regression tests (12 required cases)

All in `tests/test_phase1_gates.cpp` (v2.3 block), driven through the production
seam `evaluate_gates_with_cuda()` so both branches are deterministic:

1. Valid recognized no-CUDA skip → PASS ✔
2. Missing E2 → FAIL ✔
3. Missing B4 → FAIL ✔
4. Missing B5 → FAIL ✔
5. Empty reason / missing provenance → FAIL ✔
6. Arbitrary `"x"` → FAIL ✔
7. `"lorem ipsum"` → FAIL ✔
8. Contradictory `cuda_available=true` (attestation and hardware variants) → FAIL ✔
9. GPU physically present + CUDA unavailable → frozen G3 rule (structured skip
   accepted; not reclassified as CPU-only) ✔
10. CUDA-present branch with skipped E2/B4/B5 → FAIL ✔
11. CUDA-present branch with all PASSED → PASS ✔
12. Malformed capability metadata → FAIL closed (never throws out of
    `evaluate_gates`) ✔

Assertion total: 340 → **417** (+77).

## 5. Independent re-run of the v2.2 weakness probe

`reports/v2.2/tests/test_v22_g3_semantics.cpp` recompiled against the v2.3
library (`reports/v2.3/tests/test_v22_g3_semantics_vs_v23.exe`):

```
v2.2 G3 semantics test: 10 checks, 5 failures
[1] three valid SKIPPED records      -> FAIL | E2 skipped without structured skip attestation
[2] NOT_ATTEMPTED accepted           -> FAIL | E2 skipped without structured skip attestation
[6] arbitrary fabricated reasons     -> FAIL | E2 skipped without structured skip attestation
[7] contradictory capability evidence-> FAIL | E2 skipped without structured skip attestation
```

The 5 failures are precisely the v2.2 test's *weak-behaviour* assertions
(`CHECK(p)` for cases 1/2/6/7). Their failure under v2.3 is the proof that the
weakness is closed. (Cases 3/4/5/8 still behave as the v2.2 test expected.)

## 6. Aggregator verdicts (Release)

| Evidence set | exit | G3 |
|---|---|---|
| `../archive_recovery/aggregator_input` (nine recovered) | 1 | FAIL — `E2 record missing entirely` |
| `../archive_recovery/v21_evidence` (pre-v2.3) | 1 | FAIL — no structured attestation |
| `reports/v2.3/evidence/v23-valid` (fresh, attested) | 1 (G4/G7) | **PASS** |
| `reports/v2.3/evidence/v23-attested` | 1 (G4/G7) | **PASS** |
| `reports/v2.3/evidence/v23-fabricated` | 1 | FAIL |
| `reports/v2.3/evidence/v23-contradictory` | 1 | FAIL |
| `reports/v2.3/evidence/v23-missing-e2` | 1 | FAIL |
| `reports/v2.3/evidence/v23-malformed` | 1 (+1 invalid) | FAIL |

## 7. Backward compatibility

- Pre-v2.3 records parse unchanged; `skip_attestation` is absent → null.
- They are **not** trusted as valid skip evidence: G3 fails closed on them.
- No historical record was modified; the nine recovered records still load with
  **0 invalid records**.

## 8. Remaining G3 caveat

The CUDA-present branch cannot execute on this CUDA-disabled build. It is verified
by the deterministic seam `evaluate_gates_with_cuda()` (source-level), never by
faking CUDA runtime availability. The nine recovered records never contained
E2/B4/B5 skip records, so G3 FAILs on that set for a missing-evidence reason —
which is the correct, fail-closed outcome.