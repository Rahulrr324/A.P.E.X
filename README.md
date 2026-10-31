# APEX — Adaptive Personal Executive eXocortex

APEX is the intended **whole cognitive and executive system**, not a new name for
one model or the neural engine. Historical STARK names and milestone IDs are
preserved for provenance.

## What runs today

- C++17 neural research: adaptive-threshold cells, synapses, sparse networks,
  plasticity, learning and contextual-memory experiments, with regression tests.
- Phase-1 hardware/measurement programs and append-only experimental record files.
- Read-only `record_inspector` for bounded structural inspection of those files.
- Dependency-free developer validation tooling with isolated test state, full
  command/exit logs and explicit CMake versus direct-compiler results.
- The runnable **APEX Local Alpha** application in [`apex_app/`](apex_app/README.md):
  a Node.js CLI with a Cognitive Controller, personal memory, an explicit knowledge
  store, independent verification, audit records, crash recovery, and a bounded task
  planner. It answers deterministic requests with no model and sends everything else to
  a local model backend **you** configure; without one it reports `model_unavailable`
  and generates nothing. Its model-path tests use local stand-in servers, and the only
  real-model observations are the dated ones recorded in its README (the most recent
  bounded local run is dated 2026-10-31).

**APEX Local Alpha is a vertical slice, not the whole system.** There is still no World
Model, no general-purpose planner, no persistent learning, no voice, no UI, and no
implemented neural–cognitive bridge. `stark/` remains separate experimental research;
`apex_app/` does not import it. Do not read a passing test suite or a milestone number
as evidence that the broader APEX vision is complete.

The recorded states remain **G7 FAIL / M0 FAIL (NOT ACCEPTED) / M1 LOCKED**.
`stark/reports/M0_FINAL_REPORT_v2.4.md` §Q7 explicitly forbids starting M1 before
M0 acceptance. A development exception needs an explicit owner decision; a passing
build does not unlock it. This repository's records are not being rewritten.

## Build and test (CMake >= 3.15, C++17)

```sh
cmake -S stark -B /tmp/apex-build -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/apex-build --config Release --parallel 2
(cd /tmp/apex-build && ctest -C Release --output-on-failure)
```

Windows users should choose a native build path instead of `/tmp`. The generated
binaries may be under `Release/` for multi-configuration generators. GNU runtime
link flags are no longer passed to MSVC. Windows validation is **not claimed**
until actually executed.

Research drivers and diagnostics are excluded from the default `ALL` build, but
retain their historical target names. Include them with
`-DSTARK_BUILD_RESEARCH_DRIVERS=ON -DSTARK_BUILD_DIAGNOSTICS=ON`, or explicitly
build an individual target. Building a research program does not execute it.

## Reproducible developer check (Python >= 3.10)

```sh
# Output must be a NEW directory outside this repository.
python3 tools/validate.py --output /tmp/apex-check-001
# Without CMake, explicitly request compiler-level checks (not CTest):
python3 tools/validate.py --engine compiler --output /tmp/apex-check-002
```

Missing tools produce BLOCKED/nonzero results, not an automatic substitution.
No dependencies, language models or datasets are downloaded. Details and the
sanitizer matrix: [tools/README.md](tools/README.md).

## Read-only record inspection

```sh
/tmp/apex-build/record_inspector /path/to/experimental-records
```

This prints a JSON summary of structural validity, IDs and recorded outcomes.
Exit 0 means structurally valid input, **not accepted experiments**; 1 means some
records could not be parsed; 2 means usage, IO or resource-budget failure. It does
not change a record, run a benchmark, or evaluate an acceptance gate.

Record writing now refuses duplicate/path-like IDs. Restarting `profiler_cli`
no longer deterministically reuses the same two IDs. See
[storage safety](docs/RECORD_STORAGE_SAFETY.md) before using a new filesystem.

## Historical evidence

`stark/design/`, `stark/reports/` and `work/` contain frozen protocols, historical
outputs and acceptance records. Do not overwrite or clean them. Existing tracked
binaries are intentionally retained; `.gitignore` only prevents new build output
from entering the index. Never use this repository as the data directory for a
future personal assistant without a separately reviewed storage design.

Build details: [docs/BUILD_AND_TEST.md](docs/BUILD_AND_TEST.md).
Current concrete work/remaining restrictions: [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).
