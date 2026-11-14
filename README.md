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
Batch AP-08 then made a response say how far it may be trusted: every request now reports a fourteen-stage
contract whose statuses keep a stage that never ran apart from one that ran with no result, grades each
claim in a structured reply against the record it cites, and caps model prose at `factually_supported`
- the fifth rung, `verified`, is unreachable by construction, because checking a citation is not
verifying the sentence; an answer with no output, an unsupported claim, a rejected structure or a
partially attributed citation degrades deterministically and says which; the audits that carry this are
bounded and contain no request, record or reply text; and a grounded answer still carries no execution
authority, with a model proposal revalidated against the live registry, a plan approval bound to its
content hash, and a denied crossing written to the operations log
([details](apex_app/README.md#batch-ap-08-grounded-response-integrity-and-the-model-output-trust-boundary-as-implemented);
tests: `tests/cognition-response-integrity.test.js`, 42 cases). It needs no model and adds no store.
Batch AP-09 then checked what a claim means, not only which words it shares: every factual claim that
cites records is compared with them on eight bounded dimensions - polarity, quantities and units,
dates and ordering, entities, relationships, quantifiers and certainty, and added causal or
transformative content - and receives exactly one outcome from a closed list of thirteen, applied
under a documented precedence; a detected conflict is never downgraded, an ambiguous or unchecked
claim is never support, an unavailable read stays unavailable, a partial reading stays partial, and
no confidence score exists; contradictions between the factual claims of one response are reported
separately; and `factually_supported` now additionally requires semantically consistent wording and
no contradiction, while `verified` remains unreachable. The wording is compared lexically and
structurally, not by natural-language understanding or entailment, so a paraphrase or implication
outside the rules is reported as insufficient evidence or not checked rather than guessed
([details](apex_app/README.md#batch-ap-09-semantic-grounding-claim-consistency-and-adversarial-response-verification-as-implemented);
tests: `tests/semantic-consistency.test.js` and `tests/semantic-acceptance.test.js`, 106 cases). It
needs no model, adds no store and grants no authority.

Batch AP-10 then fixed a measured retrieval defect and made omission visible: a query term occurring
in no record was weighted by `log(2n + 2)`, so its weight grew with the store and pushed a record
matching two of three terms below the fixed 0.2 prompt-relevance floor between 1,000 and 4,000
records - the record was still retrieved and ranked first, and the floor silently discarded it. The
absent-term weight is now capped at a value calibrated on a measured interval, reproducing the previous
weighting exactly below the cap and changing nothing when every query term occurs in the store; no
threshold was lowered. Normalization is shared by both stores, keeps negations, numbers, dates and
identifiers distinct, and never fuzzily matches one identifier to another. What the context budget
removes is now counted and disclosed, a collapsed duplicate triple is disclosed, and a disagreement
survives the budget even when the record that disagrees is trimmed. Each request now carries one
bounded retrieval report over eleven ordered states, per source: what was searched, what came back,
what was excluded and why, and whether completeness is established - a missing result is never
reported as a missing fact. Citation completeness is assessed against the same evidence snapshot, so a
citation to a record outside it, a relevant retrieved record left uncited, or a claim leaning on one
side of an unresolved disagreement is disclosed rather than passed; a response that makes no claims
has no citation behaviour to assess and is not flagged. A deterministic evaluation
framework reports precision, recall, reciprocal rank, coverage and citation completeness per query
class, with no single overall accuracy number. Retrieval remains bounded lexical token overlap: it is
not semantic understanding, a long query still dilutes its own exact match below the prompt floor, and
a missing result is never treated as a missing fact
([details](apex_app/README.md#batch-ap-10-evidence-retrieval-quality-relevance-calibration-and-citation-completeness-as-implemented);
tests: `tests/retrieval-scoring.test.js`, `tests/retrieval-context-budget.test.js`,
`tests/retrieval-quality.test.js`, `tests/retrieval-report.test.js`,
`tests/citation-completeness.test.js`, `tests/retrieval-adversarial.test.js`,
`tests/retrieval-snapshot.test.js`, `tests/retrieval-acceptance.test.js`). It needs no model, adds no
store, no index and no cache, and grants no authority.

What remains is the wider clause: an expectation verdict changing subsequent behaviour without a
user-approved candidate, or changing more than the one disclosed ordering, and any claim of prediction
accuracy or causation. The runtime keeps that wider clause open; this is a recommendation only, and no
part of it is implemented.

Batch AP-11 (Runtime Performance, Cognitive Efficiency & End-to-End Latency Optimization) first
corrected the measurement it was asked to optimize. The AP-10 benchmark shared one corpus across phases
and only ever grew it, so after the retrieval phase reached 10,000 records every later `context` and
`request` row - labelled 20, 200, 1,000, 4,000 and 10,000 - measured that same 10,000-record store. The
five request medians agreed because they were five measurements of one corpus, and the conclusion drawn
from them, that latency is flat across store sizes, was invalid. Those rows are marked superseded with
the historical figures preserved; each row now rebuilds an isolated corpus of exactly the stated size,
verifies the persisted record counts before measuring, and a regression test proves the reported count
is the count the request read.

With the measurement corrected, the request path was traced and attributed per leaf method rather than
assumed. The dominant cost was the knowledge store rebuilding its supersession, conflict and resolution
indexes over every claim, and its store-wide health summary, on each of the several reads one request
makes of the same snapshot. Duplicate lexical search, the executive list/load pairs and the traced
cognition stages were each ruled out by measurement. AP-11 reuses that derived state under the SHA-256
of the exact bytes the read certified - the same digest the AP-07 parse snapshot already compares - with
one in-memory entry per store, replaced on any content change and dropped whenever a read cannot
certify one. A damaged or interrupted store certifies nothing and is never answered from an entry built
before the damage. The indexes still cover every claim, so a conflict partner outside the returned
window is still named; no persistence schema, record semantics, authorization rule, audit field or
provenance link changed, and no disk index or cross-process cache was added
([details](apex_app/README.md#batch-ap-11-runtime-performance-cognitive-efficiency-and-end-to-end-latency-optimization-as-implemented);
tests: `tests/knowledge-lifecycle-reuse.test.js`, `tests/benchmark-corpus-size.test.js`). Measured on
the corrected harness, the reuse removes a repeated construction per unchanged snapshot, but the
end-to-end effect is modest: -0.6% at 1,000 records and -7.6% at 4,000 on one paired corpus, and within
run-to-run drift at 10,000 (3.51 s before, 3.53 s after), because most of a request is whole-store
reading and per-record tokenizing outside the derived state. Small stores are well inside the sub-300 ms
target, 1,000 is inside 500 ms warm but not cold, and 10,000 remains above 1 s: that limit is reported
as the measured lower bound rather than closed with a fragile shortcut. It needs no
model and grants no authority. What remains open is the wider clause above; AP-11 implements none of it.

AP-12 then removed the costs AP-11 had left: a snapshot read deep-copied every record and nested field,
every memory search re-tokenized the whole store and rebuilt its fuzzy index, every knowledge search
re-tokenized the active pool again, and conflict-window annotation re-normalised and re-sorted a whole
group once per record. A snapshot hit now returns the snapshot's frozen records in a new list, so a
caller can reorder its list but cannot edit the shared record; retrieval corpora and the AP-11
lifecycle entry are keyed by the same certified SHA-256, so a corpus can only describe the bytes the
read returned, and a read that certifies nothing never reuses or retains one. The pre-AP-12 tree and the
current tree were run through the same driver over identical count-verified corpora, alternating order,
ratios computed within a round: warm request time fell to 0.95x at 20 records, 0.80x at 200, 0.58x at
1,000, 0.45x at 4,000 (2.20x) and 0.44x at 10,000 (2.27x), with every row meeting its engineering
target and both sides returning the same trust, retrieval-completeness and verification states. Scoring,
ranking, bounds, conflict partners, provenance, audit and authorization are unchanged
([details](apex_app/README.md#batch-ap-12-request-scoped-read-optimization-scalable-retrieval-and-end-to-end-latency-reduction-as-implemented);
tests: `tests/request-scoped-reads.test.js`). No inference was run or configured for this work.
