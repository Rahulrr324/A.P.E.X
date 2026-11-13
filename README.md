# APEX — Adaptive Personal Executive eXocortex

APEX is the intended **whole cognitive and executive system**, not a new name for
one model or the neural engine. Historical STARK names and milestone IDs are
preserved for provenance.

## What runs today

- C++17 neural research under `stark/`: adaptive-threshold cells, synapses, sparse
  networks, plasticity, learning and contextual-memory experiments, with CMake/CTest
  regression tests in that tree.
- Preserved Phase-1 hardware/measurement programs and append-only experimental record
  files, kept as historical evidence.
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
  bytes, approval, or any goal's status. One recorded, user-approved adaptation can move which candidate
  leads that comparison, and the answer states the decision the same rule would have taken without it,
  with the rule, version and evidence named; retiring the adaptation restores the unadapted decision.
  A completed evaluation of a prediction the user recorded can also become such an adaptation, but only
  after the user inspects and approves a bounded candidate derived from it; the decision then says
  whether the evidence behind the ordering was feedback-derived, prediction-derived, both, or rejected.
  `apex prediction longitudinal` describes repeated, alternating or directional recorded outcomes for one
  capability with a closed vocabulary and no causal claim; a directional pattern may become a candidate,
  but only the user's approval lets it reach the same disclosed comparison. `apex adaptation effectiveness`
  traces each approved rule through the comparisons it actually changed to the plans that ran, what their
  execution and verification recorded, and the assessments that followed, then classifies what the records
  show - separating approval from application, application from success, and success from cause. It never
  estimates an unexecuted baseline, claims a cause, changes a rule, retires an adaptation, or runs anything.
  Execution success is never reported as real-world success, and none of this grants permission.
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

The historical `record_inspector` binary and the Python validation harness named in older
revisions were developed on research branches and are not present in this checkout. No command
below asks you to install, download, or build them.

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

## Cognitive and executive architecture

[`apex_app/ARCHITECTURE.md`](apex_app/ARCHITECTURE.md) is the consolidated map of the implemented
cognitive runtime, the executive system, the evidence stores, and the authority boundary. It states
which guarantees are enforced by code, which are established by tests, and which remain descriptive
or unimplemented. The short version:

- request interpretation, retrieval, claims, contradiction handling, deliberation, grounded response
  construction, and model-output validation are deterministic and read-only;
- model output is a typed proposal, never approval;
- the action registry is the only authorization owner; every task step is authorized again when it
  runs;
- the independent verifier, not the executor, decides whether a result is verified;
- audit finalization is a separate, fallible step, and a failed append cannot become a success;
- missing records are unknown, not success; an uncertain effect is never replayed;
- diagnostics and executive handoffs record observations and always say `authorizes: false`.

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

Research drivers and production CLIs are explicit targets in `stark/CMakeLists.txt`
(for example `profiler_cli` and `run_baseline`). The historical
`STARK_BUILD_RESEARCH_DRIVERS` / `STARK_BUILD_DIAGNOSTICS` option flags are not present in
this checkout's CMake configuration, so no command here relies on them. Building a research
program does not execute it.

## Developer checks in this checkout

`apex_app/` is validated with its built-in test runner (Node.js 22 or later, no install step):

```sh
cd apex_app
npm test
```

The C++ research tree is validated with CMake/CTest using the commands above. The Python
validation harness described in historical tooling commits is not present in this checkout,
so no command here invokes it. Current working agreements for the shared checkout are in
[`DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md).

## Historical record tooling

The `record_inspector` binary and its storage-safety document named in older revisions are not
built or present on `main`. Historical record files remain preserved under `stark/` and `work/`;
they are evidence, not input to a current benchmark. Record writing in the research tree refuses
duplicate or path-like IDs (see the target's own source and tests), but this README does not ask
you to run it.

## Running the assistant

```sh
cd apex_app
node bin/apex.js help
node bin/apex.js status
```

There is no dependency install and nothing is downloaded. Without a model endpoint the
application answers deterministic requests and reports `model_unavailable` for model-shaped
requests; it does not fabricate an answer. Commands, data location, and the optional endpoint you
configure are documented in the [application README](apex_app/README.md).

## Historical evidence

`stark/design/`, `stark/reports/` and `work/` contain frozen protocols, historical
outputs and acceptance records. Do not overwrite or clean them. Existing tracked
binaries are intentionally retained; `.gitignore` only prevents new build output
from entering the index. Never use this repository as the data directory for a
future personal assistant without a separately reviewed storage design.

C++ build details: `stark/CMakeLists.txt` and `stark/CTestTestfile.cmake`.
Implemented application capabilities, tests, and limitations:
[`apex_app/README.md`](apex_app/README.md).
Consolidated architecture and authority boundary:
[`apex_app/ARCHITECTURE.md`](apex_app/ARCHITECTURE.md).

## Next recommended milestone

Batch AP implemented the bounded form of the application roadmap's stage-6 recommendation: one recorded,
eligible, user-approved adaptation changes exactly one later, disclosed decision - which candidate leads a
comparison of approaches that already passed every gate - reversibly and with an audit record, and no
component gained authority ([details](apex_app/README.md#batch-ap-one-disclosed-reversible-decision-from-recorded-evidence-as-implemented)).
Batch AP-02 then extended that same one decision to a completed evaluation of a prediction the user
recorded: the evaluation can become a bounded, typed candidate, the user must inspect and approve it
through the existing decision record, and only then can it re-order the same comparison, with the decision
naming whether the evidence was feedback- or prediction-derived
([details](apex_app/README.md#batch-ap-02-one-evaluated-prediction-one-approved-candidate-one-disclosed-influence-as-implemented);
tests: `tests/prediction-adaptation-learning.test.js`, 21 cases). Batch AP-03 then described repeated
recorded outcomes rather than single ones: a closed eight-kind pattern analysis over one capability's
bounded history, kept separate from calibration and from approval, from which a directional pattern may
become an unapproved candidate citing its observations
([details](apex_app/README.md#batch-ap-03-repeated-recorded-outcomes-described-and-never-assumed-as-implemented);
tests: `tests/longitudinal-outcome-analysis.test.js`, 29 cases). Batch AP-04 then made the lifecycle
auditable end to end: a read-only trace from an approved rule through the decision it influenced, the
plan recorded from that decision, its execution and verification, and the outcome evidence recorded
afterwards, classified into a closed vocabulary that keeps approval, application, execution, assessment
and cause apart and never manufactures an unexecuted baseline
([details](apex_app/README.md#batch-ap-04-adaptation-effectiveness-and-outcome-verification-as-implemented);
tests: `tests/adaptation-effectiveness.test.js`, 20 cases). Batch AP-05 then made the lifecycle
governable rather than only readable: a user-origin review can be opened against the exact evidence
the report held at that moment, inspected and reconciled later so every added, withdrawn, superseded,
stale, conflicting, missing or unreadable item is named, and decided with `keep_active`, `dismiss` or
`retire` - where `retire` reuses the existing `adaptation.retire` authority, a changed digest is a
difference rather than a verdict, and neither the read nor a model can approve, change a rule,
increase influence, or execute anything
([details](apex_app/README.md#batch-ap-05-adaptation-governance-evidence-reconciliation-and-controlled-lifecycle-decisions-as-implemented);
tests: `tests/adaptation-governance.test.js`, 41 cases). It needs no model and no new store.
Batch AP-06 then made the evidence those reports assemble provable rather than assumed: every report
that reads several append-only stores now certifies that no contributing file moved while it read,
names what it found in one closed ten-state vocabulary, and refuses a combination of records that did
not exist at one instant instead of reporting it; `evidence.integrity` exposes the cross-store check,
the effectiveness read now discloses when its 20-rule window clipped a stored rule, and a consistent
window is documented as a proof of quiescence rather than a transaction
([details](apex_app/README.md#batch-ap-06-evidence-fabric-scalability-and-cross-store-integrity-as-implemented);
tests: `tests/evidence-fabric.test.js`, 51 cases). It needs no model and adds no store.
Batch AP-07 then made the consistency consumer-wide and the window content-based: every consumer that
combines several stores into one answer - cognitive retrieval, world-state construction, the
prediction longitudinal read, plan candidate and outcome reads, goal assessment, and the existing
effectiveness and governance reports - now reads its contributing stores inside one content-certified
window and reports the outcome through one nine-state read contract, or states why it could not; the
window's identity now carries a SHA-256 of each file's bytes, so a same-size, same-mtime rewrite is a
detected change; a longitudinal pattern is withheld when its read was truncated or moved; and an
assessment whose evidence moved is refused as an execution failure rather than recorded
([details](apex_app/README.md#batch-ap-07-evidence-snapshot-integrity-and-consumer-wide-consistency-as-implemented);
tests: `tests/evidence-read-contract.test.js` and `tests/ap07-consistency.test.js`, 45 cases). It needs
no model, adds no store, and no verdict authorizes an action. This does not make every read in APEX
windowed: health reads and single-store lists remain atomic per store, and a window is still a proof
of quiescence, not a transaction.
What remains is the wider clause: an expectation verdict changing subsequent behaviour without a
user-approved candidate, or changing more than the one disclosed ordering, and any claim of prediction
accuracy or causation. The runtime keeps that wider clause open; this is a recommendation only, and no
part of it is implemented.
