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

**There is no personal APEX assistant application yet.** No conversational model,
personal-memory service, Cognitive Controller, World Model, Planner, UI or neural–
cognitive bridge is represented as implemented by these developer tools.

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
