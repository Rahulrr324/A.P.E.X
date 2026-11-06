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
  planner. It can also state, from the records alone and with no model, what it currently
  holds as belief and what contradicts what: `apex world` is a **read-only projection**
  of the memory and knowledge stores, not the persistent World Model. The World Model is a
  separate append-only store (`world-model.jsonl`) of entities, facts, relationships, events,
  and evidence the user records; neither projection nor model output can write it. A deterministic
  cognition layer reads those records, labels claims and contradictions, classifies uncertainty,
  asks a clarifying question before any model call, and validates any structured model response
  against the evidence it was actually given; it adds no model, no store, and no authorization.
  Adaptive planning sits on top of the same records: `apex plan candidates <goal-id>` generates the
  approaches a recorded goal supports, gates and compares them under a disclosed rule with no score or
  probability, and prints them as drafts - every step names an action the registry already holds, and
  recording or approving one is a separate user act. `apex plan outcome <plan-id>` then answers seven
  separate questions about what a run established and what it left open, citing the audit operation
  behind each, and `apex plan assess <plan-id>` records that derived verdict without changing the plan's
  bytes, approval, or any goal's status. Execution success is never reported as real-world success, and
  none of this grants permission.
  It answers
  deterministic requests with no model and sends
  everything else to a local model backend **you** configure; without one it reports
  `model_unavailable` and generates nothing. Its model-path tests use local stand-in
  servers, and the only real-model observations are the dated ones recorded in its README
  (the most recent bounded local run is dated 2026-10-31).

**APEX Local Alpha is a vertical slice, not the whole system.** It has a persistent World
Model, but there is still no general-purpose planner, no persistent learning, no voice, no UI,
and no implemented neural–cognitive bridge. `stark/` remains separate experimental research;
`apex_app/` does not import it. Do not read a passing test suite or a milestone number
as evidence that the broader APEX vision is complete.

**Security and integrity posture.** `apex_app/` states in writing what its credential masking covers,
what it deliberately does not cover, what a damaged store does, and what its lock protocols refuse to
promise:
[Batch AF: what stops a credential, what survives damage, and what none of it claims](apex_app/README.md#batch-af-what-stops-a-credential-what-survives-damage-and-what-none-of-it-claims).
Two statements from that section hold everywhere in this repository: the masking is a pattern heuristic
over what APEX **persists and prints**, so it does not protect the request that leaves for a model
endpoint you configured, and no passing test suite is evidence that anything is secure or that an action
ran exactly once. Model output remains untrusted input, and it is never authorization. Historical
`operations.jsonl` lines are never rewritten: read them as holding what was typed, and treat their
repair as an operator decision made outside the application.

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
