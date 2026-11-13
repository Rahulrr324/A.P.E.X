# APEX Local Alpha

APEX (Adaptive Personal Executive eXocortex) is the whole personal cognitive system.
**Local Alpha** is the first runnable vertical slice of it. It is a small, honest
implementation of one workflow:

    request -> an allowed deterministic action, or: retrieve memory and knowledge
            -> a model -> authorize -> execute -> verify independently
            -> record -> restart -> still there

It is not the whole of APEX. It has a persistent, append-only
[World Model](#batch-ai-world-model-entity-memory-and-evidence-graph-as-implemented) of entities,
facts, relationships, events, observations, and evidence the user records, and a separate read-only
[projection](#world-state-the-read-only-epistemic-projection) of what memory and knowledge already
store. It has no general-purpose planner (only
the bounded task planner described below), no persistent learning, no voice and no UI,
and its model path depends entirely on a backend you configure yourself. The C++
spiking-neuron research under `stark/` is a separate experiment, not a runtime this
application uses.

The application is in `apex_app/`, separate from the experimental C++ neural
research under `stark/`. Nothing here depends on that research. Historical STARK
identifiers are preserved there and are not used by this application.

The consolidated description of the cognitive runtime, the executive system, the evidence stores,
and the authority boundary is [`ARCHITECTURE.md`](ARCHITECTURE.md). It states which guarantees are
enforced by code, which are established by tests, and which remain descriptive or unimplemented.

## Capability status

This section states what is implemented, by which evidence, and what is not. It is
deliberately narrower than the APEX vision. Every claim below is supported by the
source in `apex_app/` and the tests named in [Tests](#tests); nothing here is inferred
from a milestone number or a passing build.

| Category | Status | Evidence |
|---|---|---|
| Runnable application | Implemented: the CLI in `bin/apex.js` / `src/cli.js`, the controller pipeline, memory, knowledge, audit, tasks, diagnostics. | `npm test` and the walkthrough in the [Commands](#commands) table. |
| Deterministic capabilities (no model) | Implemented and independently verified: `remember`, `recall`, `list memory`, `memory correct`, `memory health`, `calc`, `status`, `knowledge add/retract/resolve/history/health/list/search/show`, `audit health`, `task plan/run/resume/approve/retry/cancel`, `queue`, `repair locks`, `diagnose`, `experience timeline/trends/patterns/compare`, `prediction record/list/show/history/evaluate/invalidate/summary/health`. | `actions.test.js`, `memory.test.js`, `knowledge.test.js`, `knowledge-lifecycle.test.js`, `knowledge-health.test.js`, `knowledge-resolution.test.js`, `store-health.test.js`, `tasks.test.js`, `cli-workflow.test.js`, `experience-*.test.js`, `prediction-*.test.js`. A model is never consulted for these. |
| Filesystem inspection | Implemented only when `APEX_FILESYSTEM_ROOT` is set: bounded, read-only, single-root listing and reading. | `filesystem.test.js`, `tasks-filesystem.test.js`. |
| Model gateway protocol handling | Implemented and **stub-tested**: request/response shapes, failure classification, retries, timeouts, and model-name mismatch against local stand-in servers that copy the documented OpenAI-compatible and Ollama shapes. | `gateway.test.js`, `model-workflow.test.js`. Stub tests prove protocol handling, not answer quality, and no test in `npm test` runs a real model. |
| Real-model behaviour | **Observed outside the automated suite**: Qwen3-4B GGUF served by Ollama 0.35.0 on one Windows machine. One bounded request on 2026-10-31 completed through APEX in about 105 s; a bounded four-request benchmark the same day recorded 37.7-53.1 s per request, with 3.0-3.8 backend-reported tokens/s. Every answer was reported as unverified. Measurements and limits are in [Optional: a model endpoint you configure](#optional-a-model-endpoint-you-configure). | A dated historical observation, not an active setup instruction; no automated regression test. |
| Epistemic world-state projection | Implemented as a bounded, read-only projection of what the stores hold: beliefs classified by provenance (`user_asserted` vs `unverified_model`), knowledge conflicts and recorded user decisions, heuristic memory disagreements, missing evidence, and explicit unknowns. It is a view derived at read time, not a world model: it persists nothing, calls no model, and decides nothing. A model-path answer also receives a bounded, counts-only view of it, so the model is told what the stores hold beyond the records retrieval happened to show. | `world-state.test.js`, `world-context.test.js`, `src/world/world-state.js`, the `world` command, and [World state](#world-state-the-read-only-epistemic-projection). Measured read cost is in [Benchmarks](#benchmarks). |
| Prediction ledger and outcome evaluation | Implemented as an append-only record of expectations **the user states**, with a lifecycle and verdicts derived at read time from recorded outcomes: `prediction record/list/show/history/evaluate/invalidate/summary/health`. It is not a predictor: nothing estimates a future outcome, no record carries a confidence or probability, no prediction authorizes an action or an adaptation, and a model cannot write one. An expired horizon is not a wrong prediction, and a rate below 20 recorded evaluations is withheld rather than printed. | `prediction-store.test.js`, `prediction-lifecycle.test.js`, `prediction-integration.test.js`, `prediction-context.test.js`, `prediction-adversarial.test.js`, `prediction-concurrency.test.js` (128 tests, real child processes). See [Batch AE](#batch-ae-prediction-ledger-hypothesis-lifecycle-and-outcome-evaluation-as-implemented); measured read cost is in [Benchmarks](#benchmarks). |
| Goal and executive plan system | Implemented as two append-only stores (`goals.jsonl`, `plans.jsonl`) and a user-origin command surface: `goal add/revise/list/show/update/evidence/complete/link`, `plan add/list/show/validate/history/compare/revise/approve/start/reconcile/cancel/supersede`, `recover`, and the read-only `work`/`next`. A plan is a draft until approved; approval is bound to a content hash and version; live validation re-reads the registry, goal revision, dependencies, evidence references, and recorded outcomes; activation revalidates and creates an ordinary task; every step is authorized again when it runs. A goal is completed only against evidence that names a live `success_verified` audit operation. It is not an autonomous planner: nothing here invents a goal, starts a plan, or grants permission. | `goal-system.test.js`, `executive-control.test.js` (scenarios A, B, C, E, F, G; 13 tests), `executive-cli.test.js` (4 real CLI tests), `executive-interruption.test.js` (scenario D: a real child process killed inside a plan step, 1 test), `executive-continuation.test.js` (7 tests), `executive-reliability.test.js` (8 tests, real child processes). See [Batch AG](#batch-ag-goals-executive-plans-and-the-control-loop-as-implemented) and [Batch AH](#batch-ah-executive-reliability-live-validity-proposals-and-continuation-as-implemented). |
| Executive proposal layer | Implemented as an append-only `proposals.jsonl` store plus a user-only decision surface: `propose`, `proposal list/show/accept/reject/invalidate`. A configured model may produce a structured proposal of one of five kinds; it is stored as model-origin with its evidence references, assumptions, unknowns, risk, invalidation conditions, and live validation result. It cannot create, complete, approve, activate, execute, or change any record until a separate user-origin acceptance revalidates it and applies it through the ordinary goal or plan store. `advice` applies nothing, and a proposal is never a user record. | `executive-continuation.test.js`, `executive-reliability.test.js`, `capability-inventory.test.js`. No proposal test calls a real model: responses are deterministic synthetic text. See [Batch AH](#batch-ah-executive-reliability-live-validity-proposals-and-continuation-as-implemented). |
| `stark/` research tree | Experimental C++17 neural research, built and tested separately from this app. Not a runtime dependency and not imported by `apex_app`. | The root `README.md` describes its build and historical gate state. |
| Neural integration | **Proposed, not implemented.** Only the boundary document at the end of this README exists; no sidecar, process, wire format, or dependency is added. | Nothing to run. The proposal states what would have to be built. |
| World Model, entity memory and evidence graph | Implemented as an append-only `world-model.jsonl` of user-origin records: stable entity ids with aliases and lifecycle, subject-predicate-object facts with typed values, relationships with directionality and inverse reads, events that keep happened-at, learned-at, and stored-at apart, evidence references to existing stores (never copies), retraction and supersession as later records, conservative contradiction detection that keeps both sides, deterministic identity candidates, and explicit user confirm/reject/merge/unmerge. Reads reduce the log at read time; nothing is overwritten, and a model cannot write a record. | `world-model-core.test.js` (17 tests), `world-model-scenarios.test.js` (15 end-to-end scenarios A-O, including real CLI runs and real child processes). See [Batch AI](#batch-ai-world-model-entity-memory-and-evidence-graph-as-implemented); measured cost is in [Benchmarks](#benchmarks). |
| Integrated cognitive reasoning layer | Implemented as a deterministic, read-only coordinator in `src/cognition/` over the stores APEX already has: request understanding and intent classification, bounded evidence retrieval with provenance and empty/unavailable/damaged distinctions, claim extraction with symmetric contradictions, a thirteen-step deliberation, qualitative uncertainty, clarification before any model call, a bounded grounding brief, and validation of model-authored structures. No stage calls a model, writes a store, grants authorization, or invents an answer. The model receives the brief as data and its reply is parsed as untrusted input; a citation it did not retrieve, a claim of execution, or a forged structure is rejected whole. | `cognition-understanding.test.js` (18 tests), `cognition-reasoning.test.js` (24 tests), `cognition-scenarios.test.js` (15 end-to-end scenarios A-O through the real controller with a synthetic capture backend). See [Batch AJ](#batch-aj-integrated-cognitive-reasoning-deliberation-and-grounded-responses-as-implemented); measured cost is in [Benchmarks](#benchmarks). |
| Executive bridge: action orchestration and verified execution | Implemented as a deterministic, model-free interpretation layer in `src/executive/` inside `controller.handle()`: a user's own words are mapped to registered actions, a bounded preview names every step and its risk before anything runs, approval is bound to a content hash and version, the authorized run executes through the existing `TaskRunner`, and the answer reports progress, failure boundary, recovery class, and continuation from records. It adds no store, no registry, no second authorization rule, and no second runner. No stage calls a model: the map from words to actions is vocabulary plus the action registry, and a request the mapping cannot resolve is clarified rather than guessed. It is not a general-purpose planner: it maps a bounded request over registered actions, keeps unknowns visible, and refuses what it cannot ground. | `executive-bridge.test.js` (21 tests), `executive-acceptance.test.js` (K-01 to K-25), `executive-adversarial.test.js` (J-01 to J-11) - 57 tests, every one with a stub or no backend, so none is evidence about a real model. See [Batch AK](#batch-ak-the-executive-bridge---safe-action-orchestration-and-verified-execution-as-implemented); measured cost is in [Benchmarks](#benchmarks). |
| Adaptive planning, outcome evaluation and goal progression | Implemented as four read paths and one recorded reading over the stores Batch AG to AK already own: the candidate approaches a recorded goal supports (`plan.candidates`), a revision of a plan that stopped being viable (`plan.replan`), what a plan's execution established and left open as seven separate questions (`plan.outcome`), and the assessment derived from those records as the one write (`plan.assess`). Every step a candidate names is a registered action, every candidate is a draft on screen until the user records and approves it, the comparison is a disclosed gate-then-Pareto rule with no score, weight, or probability, and no candidate, comparison, or verdict changes a goal's status or grants permission. Batch AM added four things over the same records: the blockers, prerequisites and limits a goal actually has, and which of them are allowed to exclude a candidate (`plan-constraints.test.js`); one disclosed influence of an approved adaptation on selection, which cannot override a gate, a constraint, an approval or a permission (`plan-guidance.test.js`); two more ranked dimensions in the comparison - whether a step's own action can re-check it, and what the plan records say happened the last time that capability ran - with the reason each remaining dimension stays disclosed printed beside it (`plan-dimensions.test.js`); and the continuation pair - `plan.continuation` reads the nine states of a partially executed run from its own records, `plan.continue` takes up only the steps proven never to have started (`plan-continuation.test.js`, with real child processes stopped at eight interruption boundaries); and that reading is now answered where a user looks - continuation readiness grew a seventh state, `ready to continue`, read only from that derivation, and `work`/`next` rank the interrupted run as one `continue-plan` candidate instead of two task and plan entries (`executive-readiness.test.js`). Batch AP then made that one ordering influence auditable at the decision level: every comparison now carries `adaptationDecision`, a counterfactual computed by the same dominance rule over the same candidate bytes with only `approved_adaptation_fit` removed, disclosing which candidate led before and after, the exact rule id/version/hash and evidence ids, every record considered with its ledger state and why, an explicit declined reason when nothing applied, and `authorizes: false` (`adaptation-decision.test.js`, 23 cases). Batch AP-02 then let a second evidence kind reach that same one influence: a completed, current evaluation of a user-recorded prediction can be derived as a bounded, typed candidate, stays inert until the user approves it through the same `adaptation.decide` record, and is disclosed through `sources.predictionEvidence`; stale, withdrawn or unreadable prediction lineage withdraws its effect on read (`prediction-adaptation-learning.test.js`, 21 cases). Batch AP-03 then described repeated recorded outcomes instead of single ones: a closed eight-kind pattern analysis over one capability's bounded history, with chronological ordering, deduplicated citations, exclusions by kind, and calibration kept separate with its 20-evaluation floor; a directional pattern may become an unapproved candidate citing up to 20 observations, and only the user's explicit approval can let it reach the same dimension (`longitudinal-outcome-analysis.test.js`, 29 cases). It adds no parallel learning system, no new decision dimension, and no authority. | `plan-generation.test.js`, `plan-candidates.test.js`, `plan-evaluation.test.js`, `plan-assessment.test.js`, `plan-learning.test.js`, `plan-adversarial.test.js` (15 adversarial cases), `plan-scenarios.test.js` (the 30 numbered end-to-end scenarios), `plan-cli.test.js` (9 scenarios through the real `node bin/apex.js`), `plan-constraints.test.js`, `plan-guidance.test.js`, `plan-dimensions.test.js`, `plan-continuation.test.js`, `learning-read-equivalence.test.js`, `goal-evidence-consistency.test.js`, `executive-readiness.test.js`, `adversarial-batch-am.test.js` (the 16 adversarial cases I-01 to I-16), `plan-scenarios-am.test.js` (the 30 Batch AM acceptance scenarios, 31 tests), `adaptation-decision.test.js` (23 cases), `prediction-adaptation-learning.test.js` (21 cases), `longitudinal-outcome-analysis.test.js` (29 cases) - and `goal-provenance.test.js`, `goal-assessment.test.js`. See [Batch AL](#batch-al-adaptive-planning-outcome-evaluation-and-goal-progression-as-implemented); measured cost is in [Benchmarks](#benchmarks). |
| Cognitive runtime contract, gateway boundary and continuation reliability | Implemented as an explicit, tested boundary over the request path that already exists. `src/cognition/contract.js` states the ten stages of one request, which component owns each, what each stage did, two invariants (no step executed without an allow decision, and none without an authorization record), and a fixed authority block in which `action_registry` owns authorization; the audit copy carries counts and fixed labels, never the request, evidence, model text or reasoning. `src/model/gateway.js` classifies every reply as `valid`, `empty`, `refused`, `unavailable`, `malformed`, `context_limit` or `cancelled`, records provenance with `verified:false`, and keeps caller cancellation distinct from timeout. Grounded claims carry one of six evidence states derived from the cited records (the weakest cited record wins), and a model-declared `supported` may rest only on `directly_supported`. A model proposal is a typed value (`mp:N`, `authority:'none'`) with only `action` and `input`; any authority-shaped or unknown root key rejects the line whole. The continuation path re-reads plan, task and validity inside the task lock, reports nine states from its own records, and never replays a step whose effect cannot be established. `src/cognition/trace.js` records bounded counts, fixed labels, refusals, validation and an explicit `authorizes:false`. No store, registry, planner, controller, runner or authorization rule is added. | `cognition-contract.test.js` (11 tests), `cognition-evidence-states.test.js` (5), `cognition-trace.test.js` (9), `proposal-boundary-an.test.js` (3), `continuation-cross-process-an.test.js` (3, real child processes stopped at the eight interruption boundaries), `integration-runtime-an.test.js` (15 end-to-end and adversarial tests through the assembled app). See [Batch AN](#batch-an-cognitive-runtime-contracts-executive-integration-and-continuation-reliability-as-implemented); measured cost is in [Benchmarks](#benchmarks). |
| General planner, persistent learning, voice, UI | **Not implemented.** The task planner is bounded and explicit, and the Batch AG plan layer records and validates plans the user authored; neither invents goals or acts on its own. Operation logs are not learning. | The scope paragraphs in this README, [Batch AG](#batch-ag-goals-executive-plans-and-the-control-loop-as-implemented), and [Future learning interface](#future-learning-interface-not-implemented). |

The model path depends entirely on a backend you configure yourself. Without one,
APEX answers deterministic requests and reports `model_unavailable` for everything
else; it never fabricates an answer.

### Historical record: the controlled real-model run of 2026-10-31

This is a dated observation of one run, **not a setup instruction**. It was made on
2026-10-31 against a Qwen3-4B GGUF that an Ollama server was serving on one Windows
machine at that time: one bounded `ask` completed in about 105 s and was reported as unverified.
The conditions below are what that check required; they are not a guarantee
that it reproduces on other hardware or with other prompts, and nothing here asks you to
install, download, or start anything. For what APEX does with an endpoint you have already
configured, see [Optional: a model endpoint you configure](#optional-a-model-endpoint-you-configure).

1. An endpoint was already running, chosen and operated by the user. APEX neither
   downloads a model nor starts a server, and does not recommend one.
2. That endpoint already served the model named in `APEX_MODEL_NAME`; APEX reports
   `MODEL_NOT_FOUND` and names the setting to correct if it serves something else.
3. `APEX_MODEL_PROVIDER`, `APEX_MODEL_URL`, and `APEX_MODEL_NAME` point at that endpoint
   on loopback; raise `APEX_MODEL_TIMEOUT_MS` above the default 30 s if a cold start
   must succeed, and keep `APEX_MODEL_MAX_TOKENS` small for a bounded run.
4. `node bin/apex.js diagnose --model` first. It lists models only and runs no
   inference; an HTTP 200 with an error body, non-JSON body, or empty model list is
   reported as unavailable, not healthy.
5. One or two bounded `ask` requests, then `history`, to confirm the answer is shown as
   unverified, the configured model is the one recorded, and an operation record was
   written. A complete answer proves the path end to end; it does not prove answer
   quality.

## Requirements

- **Node.js 22 or later.** Verified on Node 22.22.3 (Linux). Node is the only runtime.
- **No npm install step, no dependencies.** `npm test` uses the built-in test runner.
- Nothing is downloaded at startup, and no network access is needed unless you
  configure a model endpoint.

Verified on Node 22 (Linux) and Node 26.4.0 (Windows 11); see Tests below for the
platform-specific skips.

## Setup and run

```bash
cd apex_app
node bin/apex.js status          # or: npm run status
node bin/apex.js help
```

PowerShell (Windows), from the `apex_app` folder:

```powershell
node bin\apex.js status
node bin\apex.js ask remember that the project codename is Lighthouse
node bin\apex.js ask recall codename
```

### Data location

Data goes to `~/.apex/local-alpha/` by default (`%USERPROFILE%\.apex\local-alpha` on
Windows). To use another location:

```bash
APEX_DATA_DIR=/path/to/dir node bin/apex.js status
```

- `memory.jsonl`: personal memory records (append-only). `memory.jsonl.lock` exists only
  while a process is writing a memory.
- `knowledge.jsonl`: explicit entity relationships and evidence (append-only).
  `knowledge.jsonl.lock` exists only while a process is writing a claim.
- `operations.jsonl`: one audit record per operation (append-only).
- `conversation.jsonl`: conversation turns with origin (append-only).
- `tasks.jsonl`: task events, replayed to get task state (append-only). `tasks.jsonl.lock`
  exists only while a process is changing a task.
- `task-summary-queue.json`: task summaries waiting to be reissued (replaced atomically).
- `session.json`: the current session id (replaced atomically). If it cannot be read,
  a request still runs and is verified, but the command prints a `Session:` notice on
  stderr saying the request ran without conversation continuity, and no turn is stored
  for it.

There is no `init` command: the data directory and its files are created on first use,
by the command that needs them. A mistyped command creates nothing. These are plain
JSON Lines files you can read and back up. The application never deletes or rewrites
the append-only ones.

### How a run decides where its data lives

There is one rule, and it is worth stating exactly because it is the difference between
a run touching your store and a run touching nothing.

1. **`APEX_DATA_DIR` wins.** Its value is trimmed and resolved to an absolute path. A
   relative value is resolved against the working directory of the process, so the same
   command can land in different places depending on where it was run from.
2. **An unset or blank value means the home default:** `~/.apex/local-alpha`
   (`%USERPROFILE%\.apex\local-alpha` on Windows). A variable set to empty or whitespace
   is treated as unset, which is the one way a run reaches a real user directory without
   being told to. Nothing else in the application reads the home directory.
3. **There is no CLI override and no config file.** A `--data-dir` flag is an unknown
   option and the command exits 2. Environment is the only mechanism, which is also why
   a child process inherits a run's data directory only through the environment its
   parent gave it.
4. **Nothing is created at startup.** The directory is made lazily, by the first write
   that needs it - a store append, a session pointer, a queue save, a writer lock - so
   `status`, `diagnose`, the health commands, `world`, `history`, `queue` and
   `repair locks` create no files at all, and a run that is refused before it can write
   leaves the directory untouched.
5. **A path is not validated in normal operation.** An unwritable or nonsensical
   `APEX_DATA_DIR` is accepted at startup and surfaces as an I/O failure at the write
   that needed it, which the CLI reports rather than hides: exit 3 when the audit record
   itself could not be written, exit 1 when the requested action did not complete.

So APEX can touch a real user data directory in exactly two situations: `APEX_DATA_DIR`
is set to it, or `APEX_DATA_DIR` is unset or blank and the run falls back to the home
default. When a run is on the fallback and is not isolated, it says so once on stderr -
`Data: this run uses the default data directory (…); APEX_DATA_DIR is not set` - and
`status` and `diagnose` label the line they print.

**Isolated execution** closes the second situation for anything that must not reach your
store. `APEX_DATA_ISOLATED=1` means: refuse to start unless `APEX_DATA_DIR` names a
directory inside the OS temporary directory and is not that directory's own root. The
check runs in `loadConfig` and again in `createApp`, so a test or benchmark that builds
an app programmatically fails at construction instead of writing. A value that is
neither `1` nor `0` (surrounding whitespace tolerated, since padding can never turn a
`1` into a normal run) is a startup error, not a silent return to normal operation; the
same is true of `APEX_DATA_ISOLATED=1` with no `APEX_DATA_DIR`, because a test that
redirects `HOME` would otherwise put the *default* directory inside the temporary root
and pass a containment check alone. `APEX_DATA_ISOLATED` unset or `0` is normal user
operation, and a persistent store of your own choosing outside the temporary directory
stays available. The test harness sets `APEX_DATA_ISOLATED=1` for every CLI invocation
through `tests/helpers.js` `cleanEnv()`, and the benchmark children are given their data
directory explicitly. `tests/data-dir-isolation.test.js` pins each of these behaviours against
real child processes and a pinned synthetic home.

### Configuration and preflight

Configuration comes only from environment variables; there is no config file.
Invalid or out-of-range values are rejected before any store is opened: the command
exits 2, names the setting, and reports that no data was read or changed.

| Variable | Accepted values | Default |
|---|---|---|
| `APEX_DATA_DIR` | any directory path | `~/.apex/local-alpha` |
| `APEX_DATA_ISOLATED` | `1` (require a data directory inside the OS temporary directory) or `0` | unset - normal user operation |
| `APEX_MODEL_URL` | loopback `http(s)` URL; remote only with `APEX_ALLOW_REMOTE_MODEL=1` | none (no model) |
| `APEX_MODEL_PROVIDER` | `openai`, `ollama` | `openai` |
| `APEX_MODEL_NAME` | model name; Ollama requires it when a URL is set | `local` (OpenAI-compatible only) |
| `APEX_MODEL_TIMEOUT_MS` | 100-600000 | 30000 |
| `APEX_MODEL_MAX_TOKENS` | 1-8192 | 512 |
| `APEX_MODEL_RETRIES` | 0-3 | 1 |
| `APEX_CONTEXT_TURNS` | 0-50 | 6 |
| `APEX_FILESYSTEM_ROOT` | absolute directory; filesystem inspection is off when unset | none |
| `APEX_FILESYSTEM_MAX_READ_BYTES` | 4096-10485760 | 1048576 |
| `APEX_EXPERIENCE_CAPTURE` | `off`, `verified-success` | `off` |

Both filesystem settings are validated on every run, whether or not
`APEX_FILESYSTEM_ROOT` is set, so a mistyped limit is named at startup instead of
lying dormant until the capability is switched on.

`APEX_EXPERIENCE_CAPTURE` is the one switch for automatic experience capture; see
[Batch AA: automatic experience capture](#batch-aa-automatic-experience-capture-as-implemented).
When it is unset or
`off`, an experience exists only because you recorded it, exactly as in earlier
batches. An unrecognized value is refused at startup with exit 2 before any store is
opened, so a misspelling cannot silently change what APEX writes.

`node bin/apex.js diagnose` is the read-only preflight. It prints the effective
settings above (with credential-like text redacted), the state of every store,
confirmed defects and suspicions, and recovery guidance. It does not create a
session, write or repair a store, run a task, or contact the model.
`diagnose --model` (or `status --model`) adds a connectivity check against
`/api/tags` or `/v1/models`; it never runs inference. An HTTP 200 alone is not
enough: a 200 error body, a non-JSON body, or a model list with no model is reported
as unavailable, the same way the completion path refuses it. Without `--model`, model
availability is reported as "not checked", not as healthy. A probe result says
"model list only - no inference was run", so "available" is never read as proof that
a completion works. The task line counts completed tasks, verified steps, and
uncertain steps separately. The report also states that remote (Git) synchronization
was not checked, because APEX neither inspects nor modifies a remote. A missing session
pointer is valid on a fresh install; if conversation turns are already stored,
diagnostics reports it as a suspicion, because a new session will not replay them.
Tests assert that `status` and `diagnose` leave every file in the data directory
byte-for-byte and mtime-for-mtime unchanged (`diagnostics.test.js`).

What Batch AF added to that report, and what its tests now pin (`security-end-to-end.test.js`,
`corruption-recovery-boundaries.test.js`, `audit-secret-redaction.test.js`):

- **A damaged log is reported as an incomplete inspection, never as a clean one.** `diagnose` prints
  `Audit: corrupt (N readable operation(s), M corrupt line(s), K inconsistent record(s))` and names the
  line and what it looks like (`final line without a newline: consistent with an interrupted append; the
  bytes are preserved and new records start on a new line`), then states that `no supported repair
  command exists`. `audit health` says `damaged - M corrupt line(s); inspection incomplete`, warns that
  `corrupt lines could change every count`, and discloses that the check `writes no audit record and
  displays no request or output body`. `status` prints the count with its gap:
  `Operation records: N (corrupt lines skipped: M)`.
- **A stored credential is exposure, not damage.** `audit health` and `diagnose` count records whose
  text still looks like a password, key or token, name them by operation id, print no value, and give
  the only remediation that still exists (`rotate it where it was issued`) alongside `APEX does not
  rewrite or delete operations.jsonl`. Such a log still reads as `Audit: ok` on the damage axis; the
  command exits 1 because there is something to act on.
- **Evidence that cannot be read is labelled, not assumed.** `history` prints that the list is
  incomplete because some records cannot be read, adds `A missing record does not prove an action did
  not execute`, and exits 0 - a partial read is still a read. `diagnose` states that `matching operation
  identifiers do not prove exactly-once execution` and that task step links `were checked only against
  readable audit records`.
- **A blocked store says what is blocked.** Damage in `memory.jsonl` is reported as `memory reads,
  search, and corrections are blocked`, with `Preserve memory.jsonl and repair the damaged line outside
  APEX`, while an unaffected store keeps working and is still reported as healthy.

Every line above is a *report*: none of them deletes, rewrites, re-masks or reorders anything, and the
suites re-hash the directory afterwards to prove it.

## Commands

| Command | What it does |
|---|---|
| `status [--model]` | Application identity, memory and operation counts, model status. `--model` probes the endpoint but never runs inference. |
| `diagnose [--model]` | Read-only preflight: effective configuration, store state, integrity findings, and recovery guidance. `--model` adds a connectivity probe only. |
| `chat` | Interactive conversation. Reads one message per line from the terminal (or stdin); `/new` starts a new session, `/exit` ends. Memory and history persist across runs. |
| `ask <request>` | Runs the full Cognitive Controller workflow for a request and records it. |
| `ask --save-answer <request>` | As `ask`, and also stores a model answer as a `model_conclusion`. Only with this explicit flag. |
| `memory correct --resolve <full-record-id> <replacement claim...>` | Explicitly corrects one selected claim. Appends a user-confirmed record and preserves the original. |
| `memory health` | Read-only record, provenance, correction, and corruption summary for persistent memory. Exact counts, bounded samples, and a note when inspection is incomplete. Content and secrets are not printed. Never calls a model, writes no audit record, and repairs nothing. Exit 0 only when the store was fully inspected and nothing requires attention. |
| `world [--limit N]` | Read-only epistemic projection of the stores: beliefs separated by provenance, knowledge conflicts and recorded user decisions, heuristic memory disagreements, missing evidence, and explicit unknowns. `N` is 1-50 beliefs shown (default 20). Derived at read time: it persists nothing, repairs nothing, never calls a model, and writes no audit record. Private memory is marked and never reaches the model path. A bounded, counts-only view of the same projection is derived automatically for every model-path answer; `world` itself calls no model and writes nothing. Exit 0 only when both stores were fully inspected and nothing contradicts itself; exit 1 is a report, not a failure of the read. See [World state](#world-state-the-read-only-epistemic-projection). |
| `experience timeline\|trends\|patterns` `[--since <date>] [--until <date>] [--days N] [--capability <name>] [--limit N]` | Read-only temporal views of recorded experiences: ordered events in a window, per-capability outcome trends, and detected outcome patterns. Derived at read time from the experience log; reads no audit file, calls no model, and changes no store - the command's own operation record is the only audit entry, as for every command. A malformed date is rejected before the read (`input_rejected`, exit 1); a window whose start is after its end is refused by the engine (exit 1). See [Batch AC](#batch-ac-temporal-experience-and-outcome-tracking-as-implemented). |
| `experience compare [--a-since <date>] [--a-until <date>] [--b-since <date>] [--b-until <date>] [--days N] [--capability <name>]` | Read-only comparison of two time windows: counts, outcome classes, success rate over completed attempts, feedback, and per-capability changes. With no window A given, A is the same-length period immediately before B. A difference means the records differ, not that anything caused anything. |
| `adaptation eligibility [--capability <name>] [--limit N]` | Read-only: which recorded predictions carry a completed, current evaluation that could become a candidate adaptation, and the closed state that makes each other prediction inert. Derives nothing, approves nothing, applies nothing; the only audit entry is the command's own operation record. See [Batch AP-02](#batch-ap-02-one-evaluated-prediction-one-approved-candidate-one-disclosed-influence-as-implemented). |
| `adaptation effectiveness [--adaptation <id>] [--limit N]` | Read-only: traces each approved rule through the comparisons it changed, the plan recorded from that decision, its execution and verification, and the outcome evidence recorded afterwards, then classifies what the records show and states which comparisons are unavailable. It never estimates an unadapted baseline, claims a cause, approves or changes a rule, retires an adaptation, or executes a task. See [Batch AP-04](#batch-ap-04-adaptation-effectiveness-and-outcome-verification-as-implemented). |
| `adaptation reviews [--limit N]` | Read-only: which adaptations need governance attention, the current recommendation, and the derived state of each current review. Nothing is approved, changed, or retired. See [Batch AP-05](#batch-ap-05-adaptation-governance-evidence-reconciliation-and-controlled-lifecycle-decisions-as-implemented). |
| `adaptation review show\|reconcile <id>` | Read-only: one review or adaptation's evidence digest, the live reconciliation against current stores with every added, withdrawn, superseded, stale, conflicting, missing, or unreadable item named, and the review history. A changed digest is a difference, not a verdict. |
| `adaptation review open <id> [--reason <text>]`, `adaptation review keep\|dismiss\|retire <review-id> [--reason <text>]` | User-origin only: open one review against the exact evidence now recorded, then record `keep_active`, `dismiss`, or `retire`. A decision is refused if the evidence changed after the review was opened; `retire` reuses the existing `adaptation.retire` authority rather than adding a second retirement mechanism. |
| `evidence integrity` | Read-only: opens one cross-store read window over every configured evidence store, inspects each file's identity before and after, runs the store's own health check where one exists, and reports one integrity state from the closed vocabulary (`valid`, `valid_bounded`, `missing`, `stale`, `conflicting`, `broken_reference`, `damaged_store`, `truncated_history`, `concurrent_modification`, `unverifiable`). A changed file is reported as a statement about the read, never as a verdict on the evidence; nothing is repaired, rewritten, or authorized. A consistent window is not a transaction. See [Batch AP-06](#batch-ap-06-evidence-fabric-scalability-and-cross-store-integrity-as-implemented). |
| `prediction record --capability <name> --expect success\|failure\|blocked --subject <text> (--expires <date> \| --in-days N) [--supports <id,...>] [--contradicts <id,...>] [--feedback <id,...>] [--pattern <kind,...>] [--replaces <id,...>]` | Records one expectation **you** hold about a later outcome of a named capability, with an explicit horizon and the recorded events it is based on. User origin only: a model proposal naming this command is denied. Cited ids must resolve in the experience log and must predate the moment of recording; nothing is written when they do not. The record stores no confidence and can store no state or verdict. See [Batch AE](#batch-ae-prediction-ledger-hypothesis-lifecycle-and-outcome-evaluation-as-implemented). |
| `prediction list [--limit N] [--capability <name>] [--status <name>]`, `prediction show <id>`, `prediction history <id>`, `prediction summary [--capability <name>]` | Read-only views of the ledger: standing expectations and their derived state, one expectation with its evidence lineage, every record that names one expectation (oldest first), and the aggregate counts with each rate's denominator named and its exclusions counted. Derived at read time; calls no model; the only audit entry is the command's own operation record. |
| `prediction evaluate <id>` | Compares one expectation with the outcomes recorded inside its horizon and stores the verdict **only** when those records establish one. Otherwise it reports `insufficient_evidence`, `outcome_unavailable`, `expired`, `invalidated`, `superseded`, `already_evaluated`, or `evidence_unavailable` and writes nothing. A verdict already stored is never rewritten. User origin only. |
| `prediction invalidate <id> --reason <text>` | Withdraws one expectation, keeping its reason and provenance in the log. The expectation is not deleted and stays auditable. User origin only. |
| `prediction health` | Read-only ledger report: kind counts, standing versus superseded expectations, corrupt lines, and anomalies (a replacement that names nothing, a replacement circle, a reused record id), each with bounded samples. Never calls a model, writes no audit record, repairs nothing. Exit 0 only when the ledger was fully inspected and nothing requires attention. |
| `prediction longitudinal [--capability <name>] [--limit N]` | Read-only, bounded analysis of how recorded outcomes for one scope are ordered: a closed pattern (`repeated_success`, `repeated_failure`, `alternating_outcomes`, `consistent_improvement`, `consistent_regression`, `mixed_outcomes`, `insufficient_evidence`, `conflicting_evidence`), chronological counts, excluded records with their kinds, and calibration reported separately with its 20-evaluation floor intact. Derives, approves and applies nothing; a repeated association is not a cause and not a forecast. See [Batch AP-03](#batch-ap-03-repeated-recorded-outcomes-described-and-never-assumed-as-implemented). |
| `goal add [--criterion <text>]... [--priority N] [--deadline <iso>] [--depends-on <id>]... <request>` | Records a goal with at least one success criterion. The goal starts `proposed`; nothing runs, and the goal grants no permission. User origin only. |
| `goal list [--limit N]`, `goal show <id>` | Read-only views of open and closed goals, and of one goal with its criteria, evidence, history, and linked plans/tasks. |
| `goal assess <id>` | Read-only check of what the goal claims about its own evidence: each recorded support is re-opened in the audit log, and each knowledge record it established is re-checked for retraction or supersession. Reports a proof as standing, withdrawn, unsupported by the audit log, contradicted, or not checkable, and lists only the questions APEX cannot answer for the user. On a completed goal it also answers whether the recorded completion still holds, and `goal show` prints the same finding (`NOT SETTLED` / `Not re-checked` / `Re-checked`) beside the snapshot it was granted on. Writes no record, links nothing, completes nothing, reopens nothing, and exits 1 when a finding or an unreadable store means the goal's own claims do not hold. |
| `goal update <id> <status> [--reason <text>] [--by <goal-id>]` | Moves a goal through its lifecycle (`accepted`, `active`, `blocked`, `failed`, `cancelled`, `abandoned`, `superseded`, `completed`). Stopping states need a reason; `superseded` names a live replacement. User origin only. |
| `goal revise <id> --criterion <text>... --reason <text> [--request <text>] [--priority N] [--deadline <iso>]` | Records a new version of a proposed, accepted, active, or blocked goal. The revision increments the goal revision, resets criterion evidence, and invalidates an approval bound to the older revision until the plan is revised and approved again. User origin only. |
| `goal evidence <id> --criterion <c1> --kind supports\|contradicts [--operation <audit-id>] [--detail <text>] [--reopen]` | Records evidence for one criterion. Supporting evidence must name a live `success_verified` operation. Contradicting evidence on a completed goal requires `--reopen`, which returns it to `blocked` and preserves the history. User origin only. |
| `goal complete <id> [--reason <text>]` | Completes a goal only when every criterion is satisfied by evidence that the audit log still confirms. A task result completes no goal by itself - not a plan run, not a `plan continue`, not a reconcile. User origin only. |
| `goal link <id> (--plan <id> \| --task <id>)` | Records a reference from a goal to a plan or task. The link does not authorize execution. |
| `plan add --outcome <text> --step <json>... [--goal <id>] [--precondition <text>]... [--assertion <json>]... [--estimate N] [--reason <text>]` | Records an executive plan as a draft: ordered steps with dependencies, expected results, verification requirements, risk, preconditions, and classified assertions. Nothing runs. User origin only. |
| `plan list [--limit N]`, `plan show <id>`, `plan validate <id>` | Read-only views: the plan log, one plan with its steps and outcomes, and a validation of a stored plan against the live registry and the live goal, task, and audit state (`validate` exits 1 when it would not pass). |
| `plan history <id>`, `plan compare <id> [--from N] [--to N]` | Read-only views of every recorded plan version with its reason, and of the differences between two recorded versions. Comparing runs nothing and changes no approval. |
| `plan candidates <goal-id> [--work <text>] [--cannot-use <action,action>] [--json]`, `plan replan <plan-id> [--reason <text>] [--cannot-use <action,action>] [--json]` | Read-only: the approaches a recorded goal currently supports, and the revised approaches a plan that stopped being viable would be answered by. Each generates candidates whose steps name registered actions only, gates them, compares them under the disclosed rule, and prints what each approach settles, leaves, risks, and can be undone by. `--cannot-use` excludes registered actions from the offering, `--json` prints the read's own data instead of its bounded answer. Nothing is recorded, approved, or started; `plan.replan` leaves the plan it answers byte-identical, and a revision needs its own approval. Exit 1 when the read could not be verified. |
| `plan outcome <plan-id> [--json]` | Read-only: what a plan's recorded execution established and what it left open, as seven separate questions with the operation each answer cites, and a verdict read from the records - `failed`, `uncertain`, `blocked`, `partial`, `awaiting_confirmation`, or `successful`. A verified step is reported as a fact about the audit log, never as real-world success. Records nothing. |
| `plan assess <plan-id>` | Records that derived verdict as one assessment event against the plan version it was read from. The verdict is re-derived, never accepted as input, and a second recording of the same version is refused. The plan's version, status, content hash, timestamp and approval are unchanged; no goal is completed or reopened; nothing is authorized. |
| `plan revise <id> --outcome <text> --step <json>... --reason <text>` | Replaces a draft or blocked plan with a new version. The revision clears any approval and must be approved again. |
| `plan approve <id>` | Validates the plan against the live registry and records an approval bound to the exact content hash and version. Approval permits starting the plan; it authorizes no step by itself. |
| `plan start <id>` (alias `plan activate <id>`) | Re-validates the approved plan, re-checks its goal and steps, creates an ordinary task, and runs it. Every step is authorized separately. |
| `plan reconcile <id>` | Read-only with respect to execution: copies terminal task-step outcomes onto the plan, re-checks completed outcomes against the audit log, and is a no-op on a second call. It never runs a step. |
| `plan continuation <id>` | Read-only: the nine-state reading of the run this plan activated - not started, running, verified successful, verified failed, blocked, outcome uncertain, awaiting external confirmation, safe to continue, requires user intervention. Each step names the record its state was read from, the re-reads a continuation must pass (plan bytes, approval binding, step structure, live registry, recorded constraints, plan status, task ownership), what stands in the way, and the command that would act on it. Writes nothing except its own audit line; refuses a plan that was never activated. Exit 1 when the reading could not be verified. |
| `plan continue <id>` | Takes up the steps the records prove never started, after re-reading everything the derivation reads and under the existing task lock. Replays nothing whose effect cannot be established, reuses the ordinary per-step authorization, audit and finalization contracts, and refuses outright when a moved approval, a revised plan, a refused capability or a recorded constraint stands in the way. The answer carries the before and after readings and which steps ran. Exit 1 when the run it continued did not complete. |
| `plan cancel <id> --reason <text>`, `plan supersede <id> --by <plan-id> --reason <text>` | Closes a plan record. A task already created from it is not cancelled by these commands. |
| `recover` | Read-only recovery inspection across goals, plans, and tasks: interrupted work, uncertain steps, records that contradict each other (a missing goal, a stale goal revision, an active plan whose goal closed, a missing activation task, a completed task with unrecorded plan outcomes), resumable items, matters needing the user, and closed work. Never resumes, retries, approves, reconciles, or cancels. Exit 1 when anything needs attention. |
| `work [--limit N]`, `next` | Read-only, deterministic ranking of the next work from goals, plans, tasks, recovery state, and execution evidence. `next` prints the single top recommendation and why. Neither executes anything, invents a priority, or treats a recommendation as permission. |
| `propose [--kind goal_create\|goal_clarify\|plan_create\|plan_revise\|advice] [--goal <id>] [--plan <id>] <request>` | Asks a configured model for a structured proposal. The model-origin proposal is stored in `proposals.jsonl` with its evidence references, assumptions, unknowns, risk, invalidation conditions, and live validation result. Nothing is applied, approved, activated, or executed, and a proposal is not a user-origin record. |
| `proposal list [--limit N]`, `proposal show <id>` | Read-only views of stored proposals, their decisions, and their live staleness assessment. |
| `proposal accept <id> [--reason <text>]`, `proposal reject <id> --reason <text>`, `proposal invalidate <id> --reason <text>` | Records your decision on one proposal. Acceptance is a separate user-origin action that applies only a `goal_create`, `goal_clarify`, `plan_create`, or `plan_revise` proposal, only after live revalidation; it never approves or starts a plan and never changes an existing goal's provenance. Rejection and invalidation change nothing else. |
| `new` | Starts a new conversation session. Memory is kept; earlier turns are no longer sent to the model. |
| `history [--limit N]` | Lists recent operation records. |
| `task plan <goal>` | Plans a multi-step task and stores it. Runs nothing. See [Tasks](#tasks). |
| `task list`, `task show <id>` | Lists tasks, or shows one with its steps, status, and progress. An id may be shortened to 4 or more characters. |
| `task explain <id> [view]` | What the records say about one task: `status` (default), `finished`, `steps`, `pending`, `why`, `approval`, `recovery`. Prints the recorded status and, separately, whether each recorded step result has an operation record of its own. Read-only: no model is asked and nothing runs. See [Tasks](#tasks). |
| `task run <id>` | Runs a pending task step by step. Stops at the first failed or uncertain step, and pauses before a write that needs approval. |
| `task approve <id>` | Approves a model-proposed plan. `task approve <id> --step <stepId>` approves one write step that is waiting for it. |
| `task resume <id>` | Continues a paused task. A completed step is never run again. |
| `task retry <id> <stepId>` | Retries one failed or uncertain step, only if it is read-only. |
| `task cancel <id>` | Cancels a task that has not finished. Steps that have not run are cancelled. |
| `queue` | Read-only view of the task-summary retry queue: what is owed, its state, and whether the queue file or its lock needs attention. |
| `repair locks` | Inspects the task, queue, memory and knowledge write locks and removes only abandoned takeover tokens whose number no live process owns. It never takes a lock, never deletes a lock claim, and refuses while any holder or takeover number is live. A dead claim is taken over by the next normal run. A claim whose number has been recycled by an unrelated process looks live and is refused; resolving that needs the manual check described under Known limitations. |
| `knowledge add --subject <s> --relationship <r> --object <o> [--evidence <e>] [--supersedes <id[,id...]>]` | Stores an explicit relationship triple. User origin only. Optional `--supersedes` retires named conflicting records as historical, without deleting them. |
| `knowledge retract <id> [--reason <text>]` | Marks an existing active claim as retracted without supplying a replacement. The original claim, evidence, and provenance are preserved. User origin only. |
| `knowledge resolve <target-id> --choose <claim-id> [--reason <text>]` | Records an explicit user decision among a live conflict group. Every named claim must be active and conflicting; the choice must be one of them. The event names the whole group, the chosen claim, and an optional reason. No claim is deleted, merged, or rewritten, and the status stays `conflicting`. A repeated identical decision is refused; a changed decision is a new event that supersedes the earlier decision for that same group. User origin only; a model proposal cannot appear in a plan. |
| `knowledge history <id>` | Read-only lifecycle view: state, retraction and resolution events, direct and chained supersession links, and an explicit note when the evidence is incomplete or ambiguous. Never calls a model. |
| `knowledge health` | Read-only store-wide summary: claim counts by lifecycle state, live and resolved conflict groups, lifecycle-event counts (retractions and resolutions), corrupt lines, bounded chain components, and detected anomalies. Never calls a model, writes no audit record, and repairs nothing. Exit 0 only when the store was fully inspected with no anomaly, ambiguity, or unresolved conflict. |
| `audit health` | Read-only operation-log summary: readable record count, outcome counts, corrupt lines, and structural anomalies. Integrity is explicitly parse-only: there is no hash chain, signature, or external anchor, so a clean parse does not prove authenticity. It prints no request or output body, never calls a model, writes no audit record, and repairs nothing. Exit 0 only when the log was fully inspected and nothing requires attention. |
| `knowledge list [--limit N]` | Lists recent knowledge records with provenance and status, including historical (superseded and retracted) records. |
| `knowledge search <query>` | Searches knowledge triples by keyword. |
| `knowledge show <id>` | Shows a knowledge record in full with provenance and conflict details. |
| `help`, `version` | Usage and version. |

Request forms recognised without a model:

- `remember that <fact>` / `remember <fact>`: store a user fact (a write action).
- `recall <query>`, `search memory for <query>`, `what do you know about <query>`: memory search. Matches words, common word forms (`codenames` finds `codename`), and close misspellings (`lighthose` finds `Lighthouse`).
- `list memory` / `show memory`: most recent records.
- `memory correct --resolve <full-record-id> <replacement claim...>`: explicitly resolve
  the conflict with one identified record. Get the full UUID from `list memory`; the
  replacement must be a conflicting claim. The correction is a new append-only record.
- `calc <expression>`, `calculate ...`, or `what is 2+3*4?`: plain arithmetic (`+ - * /`, parentheses).
- `status`: application status.
- `what conflicts do you have`, `which contradictions are stored`, `what is currently
  unresolved`, `what do you believe`: the read-only
  [world-state projection](#world-state-the-read-only-epistemic-projection). No model is
  asked. A question about a topic (`what do you believe about X`) is not matched here and
  stays on the model path.

A request of two or more parts separated by `;` or `then`, where every part is one of
the forms above, runs as a task (see [Tasks](#tasks)). For example:
`calc (2+3)*4; calc 10/2`.

Anything else goes to the model path. With no model configured, APEX says so,
shows any relevant memory it found (without summarising it), and **generates nothing**.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Verified success, or a model answer was produced (reported as unverified) with no proposed action blocked. For the read-only health commands (`memory health`, `knowledge health`, `audit health`), 0 means the store was fully inspected and nothing requires attention. |
| 1 | Not completed: denied, rejected, failed, not verified, no model, the store is unavailable, or a model answer whose proposed action was denied/failed. For a health command, 1 means damage, an unreadable store, an incomplete inspection, a detected anomaly, or (for knowledge) an unresolved conflict. A health check that exits 1 still changed nothing. |
| 2 | Usage or configuration error. |
| 3 | The operation ran, but its audit record could not be written. The output says so. |

Health exit codes are a report, not a success claim. `0` says only that the readable
records were consistent and complete for this inspection; it does not assert that any
stored content is true, and it does not detect deliberate editing that leaves valid
JSON behind.

Error lines are presentation, not evidence: each is bounded to one line and
credential-like text in it is redacted. An operation's audit record keeps the
original error message.

## Optional: a model endpoint you configure

APEX does not install, download, start, or recommend a model server, and no model is
bundled or required.
Every sentence below describes what APEX does **with an endpoint you have already chosen
and configured yourself**; none of them is an instruction to install or run a server. Two
protocols are supported; the choice is made in the Model Gateway
(`src/model/gateway.js`), and nothing else in APEX knows about either one.

| Endpoint protocol | `APEX_MODEL_PROVIDER` | `APEX_MODEL_URL` example | Endpoints used |
|---|---|---|---|
| Ollama's native API (`/api/tags`, `/api/chat`) | `ollama` | `http://127.0.0.1:11434` | `/api/tags`, `/api/chat` |
| An OpenAI-compatible chat API (for example a `/v1` compatibility layer) | `openai` (default) | `http://127.0.0.1:8080` | `/v1/models`, `/v1/chat/completions` |

The table maps a protocol to the provider value that speaks it. It is not a recommendation
of any product, and APEX never starts, downloads, or probes for a server on its own.

```bash
# An endpoint you have configured, speaking Ollama's native API.
# APEX_MODEL_NAME must name a model that endpoint already serves.
APEX_MODEL_PROVIDER=ollama APEX_MODEL_URL=http://127.0.0.1:11434 APEX_MODEL_NAME=<model> node bin/apex.js chat

# An endpoint you have configured, speaking the OpenAI-compatible chat API.
APEX_MODEL_URL=http://127.0.0.1:8080 node bin/apex.js chat
```

- Only loopback hosts (`127.0.0.1`, `localhost`, `::1`) are accepted by default. A
  remote host needs `APEX_ALLOW_REMOTE_MODEL=1`. URLs with credentials are refused.
- `APEX_MODEL_NAME` is sent with each request. For Ollama it is required; if the named
  model is not served by that endpoint, APEX reports `MODEL_NOT_FOUND` and names the
  setting to correct (`APEX_MODEL_NAME`). It does not tell you to download anything.
- Temperature is 0. Answers are capped by `APEX_MODEL_MAX_TOKENS` (default 512); a cut-off answer
  is shown with a notice that it was truncated. On a slow machine a long answer can
  exceed `APEX_MODEL_TIMEOUT_MS` (default 30000) and is reported as `TIMEOUT`. Lower
  `APEX_MODEL_MAX_TOKENS` (for example to 256) or raise the timeout. In a protocol run
  on a 2-CPU sandbox against a random-weight test model, the default 512-token answer did
  not finish within 120 s, and a 24-token answer did.
- A first request after the model was unloaded can exceed the default 30 s even when the
  server is working: that is a slow start, not a model failure. APEX does not raise the
  limit by itself, does not resend a timed-out request, and does not warm up the model
  behind your back. For a first run, set `APEX_MODEL_TIMEOUT_MS` (100-600000) high enough
  for the load, or send one small request deliberately and wait for it. The timeout
  message names the limit and says the model may still be loading; it is not evidence
  that the model or a later answer is wrong.
- On a terminal, `ask`, `chat` and `task plan` print one line such as
  `Waiting for the model (up to 30 s; no partial output is shown)...` immediately before
  the call. The transport is not streaming, so no progress bar, partial answer, or token
  count is shown, and redirected or piped output does not get the line.
- When the server reports at least 1 s of model load time, a produced answer is followed
  by a display-only note giving the figure. The exact `model.timings` counters
  (including `loadMs`) are in the operation record; a value the server did not report is
  absent rather than zero.
- Measured on 2026-10-29, against a Qwen3-4B GGUF an endpoint was serving on Windows at
  that time, with a 200-token
  budget, and a short prompt: the first request after the model was unloaded took
  48.4 s total (19.8 s loading, 1.3 s prompt evaluation, 26.7 s generating 128 tokens);
  the same request with the model already loaded took 25.1 s total (0.03 s loading,
  0.9 s prompt evaluation, 23.3 s generating 113 tokens). Both completed
  (`done_reason: "stop"`) and were reported as unverified answers. These are
  machine-specific observations, not guarantees. The default 30 s timeout covers the
  warm request here but not a cold start; raise `APEX_MODEL_TIMEOUT_MS` if cold starts
  must succeed. A timeout aborts the HTTP request and records a failure; a late reply
  is not stored, and a timeout is not retried. APEX cannot stop computation already
  running inside the model server.
- Failures are named, never turned into an answer: `UNREACHABLE`, `TIMEOUT` (never
  retried), `INTERRUPTED` (connection dropped mid-answer), `MODEL_NOT_FOUND`,
  `CONTEXT_TOO_LARGE`, `EMPTY_RESPONSE`, `MALFORMED_RESPONSE`, `HTTP_ERROR`. Only
  unreachable and interrupted calls are retried, up to `APEX_MODEL_RETRIES` times.
  A retry resends the same prompt and only the final reply is used: one model request,
  however often it is retried, can authorize at most the proposals in that one reply, and
  every proposal still passes the registry's authorization. `INTERRUPTED` means no reply
  was read, so nothing from the dropped attempt is acted on. An ambiguous 200 body
  (malformed JSON or an unusable shape) is not retried: the server did answer, so a
  repeat could duplicate work and still prove nothing. There is no caller-supplied
  cancellation signal; the only bound on a call is the timeout, which aborts the HTTP
  request. A body is parsed regardless of its content-type header, because some servers
  mislabel JSON, while a non-JSON body is `MALFORMED_RESPONSE` whatever its label. If the
  response names a model other than the configured one, the result records the model that
  actually answered; it does not substitute the configured name.
- The response size limit (1,000,000 characters) is enforced while the body is read, not
  after it is buffered: an oversized reply is rejected when it crosses the limit, the read
  is cancelled, and the connection is closed. An oversized error body is still reported as
  `HTTP_ERROR` for its status, with the body omitted rather than read.
- Control characters in model output (including terminal escape codes) are removed
  before the text is shown, stored, or logged.

**Reasoning text in answers (a dated finding: confirmed on 2026-10-29 and 2026-10-31 with a
Qwen3 GGUF served by Ollama 0.35.0).** APEX does
not send a `think` flag: it uses the provider default so that a thinking model puts
reasoning in `message.thinking` and the final answer in `message.content`. Only
`message.content` is shown, stored, or audited; reasoning is never treated as an
answer. Sending `think: false` was not reliable in that run: the
`hf.co/Qwen/Qwen3-4B-GGUF:Q5_K_M` template unconditionally opens a think block and
ignores the flag, so the reasoning arrived inside `message.content` with a literal
`</think>` marker and was displayed as the answer. Sending `think: true` instead is
rejected by models without thinking support. APEX does not strip markers or reasoning
text from `message.content` (the same text can be legitimate content), so a provider
that genuinely mixes reasoning into content is passed through unchanged.

Reasoning tokens count toward `APEX_MODEL_MAX_TOKENS`. If the budget is exhausted
before any final answer is produced, `message.content` is empty and APEX reports
`EMPTY_RESPONSE`; no partial reasoning is shown as an answer, and no model turn is
stored. The message describes only what the server reported: reasoning present with
`done_reason: "length"` names both and suggests raising `APEX_MODEL_MAX_TOKENS` or
using a model that can skip thinking; `done_reason: "length"` with no reasoning names
the token limit; empty content with no such report stays "endpoint returned an empty
answer" rather than guessing a cause. Retrying the same request unchanged is not
suggested as a fix. Observed on
2026-10-29 with a 256-token budget: one request produced the answer `391` after 251
generated tokens; another produced only reasoning and no answer, which is reported as
that failure rather than as text.

Measured on 2026-10-29 after switching to the provider default: a warm two-turn run
through APEX took 35.4 s and 41.5 s (APEX overhead 26-46 ms), both
`done_reason: "stop"` with clean final answers and no reasoning in the display or the
stored turns. A cold direct request took 63.6 s including 16.4 s of model loading,
0.5 s of prompt evaluation, and 46.7 s generating 251 tokens (about 5.4 tokens/s).

Measured on 2026-10-31 through the application path (same model and server, 300 s
timeout, 1200-token budget, no retries, temperature 0, one short factual prompt
repeated) with `benchmarks/run-model-benchmark.mjs`:

- readiness/list check: 81 ms; it lists models and runs no inference;
- four requests: 53.1 s (server cold; about 23 s of that was model load), then
  37.7 s, 43.1 s and 38.7 s;
- backend-reported generation: 101, 131, 131 and 112 tokens at 3.0-3.6 tokens/s;
  prompt evaluation took 1.2-2.0 s;
- APEX overhead beyond the server's own reported total: 0.22-0.33 s per request
  (0.6-0.8%);
- all four answers were reported as unverified, with no action proposed or executed.

Generation is 95-96% of warm request time, so the model, not the application, is the
bottleneck. A separate request with a 96-token budget produced only reasoning and was
reported as `EMPTY_RESPONSE` after 28.8 s: on this template the budget is consumed by
reasoning before an answer, so a very low cap is not a way to force a concise answer.
The earlier 2026-10-31 request (about 105 s) is not pooled with these samples because
it was the first cold start of that server and ran with different prior conditions.
These are four observations on one machine, not a reliable benchmark.

Operation records now include the backend's own counters as `model.usage`
(`promptTokens`, `completionTokens`) and `model.timings` (`totalMs`, `loadMs`,
`promptEvalMs`, `evalMs`) when the server reports them. Values are bounded numbers;
an absent value is absent, never zero or estimated.

**Verification status.** The automated tests use local stand-in servers that copy the
documented request and response shapes of both protocols. They check protocol
handling and failure classification only. They say nothing about answer quality, and
no test in this repository runs a real model. A bounded manual run against a real
server was performed on 2026-10-31 and is reported above; it is not an automated
regression test.

**Interpreting `verification_unavailable`.** A model answer is reported with this
outcome because APEX has no independent check for a claim a model makes. The request
completed and the answer was produced and stored; the status says only that APEX
cannot confirm it. It is not a timeout, an empty answer, or a provider failure, and
the command exits 0 unless a proposed action was denied, failed, or could not be
verified. Fluency is not evidence of correctness either: an unverified answer should
be treated as a model assertion, not as an established fact.

## Optional: bounded filesystem inspection

APEX can look at one directory you explicitly authorise. It cannot write, rename,
delete, or execute anything, and there is no default: with no root configured the
capability is not registered at all.

```bash
# Absolute path required. A relative value, a drive root, or a UNC path is refused.
APEX_FILESYSTEM_ROOT=E:\Projects\thing node bin/apex.js ask list .
APEX_FILESYSTEM_ROOT=/home/you/project node bin/apex.js ask read README.md

APEX_FILESYSTEM_ROOT=/home/you/project APEX_FILESYSTEM_MAX_READ_BYTES=65536 node bin/apex.js chat
```

| Action | Permission | Origins | Input | Independent verification |
|---|---|---|---|---|
| `filesystem.list` | read | user only | `path` (relative), `limit` (1-1000, default 200) | a second listing of the same directory must return the same names, types, count, and truncation flag |
| `filesystem.read` | read | user only | `path` (relative), `maxBytes` (1 to the configured cap) | a second read must match the reported size, SHA-256, and text |

Requests that look like paths are routed to these actions, for example `list .`,
`list src/`, `read README.md`, `cat notes/todo.txt`. Requests that do not look like
paths (for example `list services`) still go to the model, so ordinary questions are
not turned into directory reads.

How the boundary is enforced:

- The root is resolved and validated once, at startup, and captured by the action
  definitions. No request, model proposal, or task step can widen it, and a request
  that includes `root` or `authorizedRoot` is rejected as an unexpected field.
- Paths are relative. Absolute paths, UNC paths, drive-letter paths, and any `..`
  component are refused before any filesystem call.
- The path is resolved (`realpath`), then the resolved target is compared against the
  resolved root. Comparison is case-insensitive on Windows and macOS, case-sensitive
  elsewhere, and boundary-exact, so `/data/allowed-2` is not inside `/data/allowed`.
- A symbolic link or reparse point is never followed: a link whose target is outside
  the root is refused by containment, and a link inside the root is refused outright
  (`SYMLINK_REFUSED`).
- Reads are limited to regular files. Anything larger than the configured maximum is
  refused (`FILE_TOO_LARGE`), and content that is not valid UTF-8 text or that contains
  binary control characters is refused (`FILE_NOT_TEXT`) instead of being returned
  garbled.
- A read re-checks the size after opening, so a file that grows mid-read cannot exceed
  the limit. If the file or directory changes between the action and verification, the
  result is `verification_failed`, not success.
- Listings are one level deep (never recursive), capped by `limit`, sorted by name, and
  report `total` and `truncated` so a large directory is visible as truncated rather
  than silently shortened.
- Reported paths are the relative path you asked for; the absolute root is not copied
  into the audit record of a listing or read.

## How a request is answered

1. The request is validated (length, control characters, credential-like text).
2. Deterministic requests (`remember`, `recall`, `calc`, `status`, `list memory`) are
   routed to actions. They are authorized, executed, and independently verified, with
   or without a model. A model never executes them. Such a request reads exactly what
   the action names; nothing else is searched, so an unrelated store problem cannot
   appear inside an operation that succeeded.
3. Any other request goes to the model path:
   - **Retrieval**: the personal memory and the knowledge triples are searched for the
     request (words, word forms, and close misspellings for memory; see Architecture).
     Memory records that score above a relevance threshold, are not private, and do not
     look like credentials are placed in the prompt, and knowledge records that score
     above the same threshold are placed alongside them. A record that shares only
     incidental words with the request stays out.
   - **Conversation**: the last `APEX_CONTEXT_TURNS` turns of the current session are
     included. Earlier model answers are labelled `UNVERIFIED`. An action result is
     stored as a turn too (summary only, never retrieved memory or file content), so a
     follow-up can see that a model-proposed action was verified, denied, or failed.
     A clarifying question APEX itself asked is stored and replayed, labelled as a
     question rather than an answer, so the user's reply is understood instead of
     prompting the same question again. Failure notices are kept for the user's history
     but are not replayed.
   - **Prompt**: memory and conversation are labelled as data, not instructions. Each
     memory item shows its provenance: `user-provided fact` or `model conclusion
     (UNVERIFIED)`. The prompt is trimmed to about 6000 characters in a fixed order: the
     projection summary below gives up its room first, line by line from its detail down,
     then the oldest turns and the least relevant memories go, one at a time, and knowledge
     records go only once those sections already fit. Whole-store meta-context is therefore
     never the reason a record that answers the question is dropped.
   - **Projection**: when a request goes to the model, the read-only world-state projection
     is derived once from both stores and its bounded, counts-only view is included as
     `APEX STORE-WIDE PROJECTION`. It reports how many beliefs are represented and by what
     provenance, how many disagreements are unresolved, how many records are retired
     history, and what APEX explicitly does not know - none of which retrieval can see,
     because retrieval ranks and truncates. It never includes a memory belief statement and
     never includes private content; private records contribute ids and counts only. The
     system prompt states that this section is the system's own read, not instructions, and
     that the model cannot settle a disagreement, turn an unknown into a fact, or change
     what the stores hold by writing confident prose. If the projection cannot be read, the
     model and the user are both told that APEX cannot say whether other stored records
     disagree; an unreadable projection never reads as an empty store.
     Conflict warnings refer to the whole projection, not only to what was retrieved: a
     shown record whose counterpart stayed outside the retrieval window, or was withheld as
     private, is marked `[contested: ...]`, and the answer carries a matching notice.
   - **Generation** through the Model Gateway. The reply is shown with its status and
     source, and recorded.
4. Model answers are **never** stored as memory automatically. `ask --save-answer` is
   the only way, and it stores the answer as a `model_conclusion`, never as a user fact.
5. Every operation writes an audit record with the retrieved memory ids and prompt
   sizes, not the memory text. When a projection was read for the answer, the record holds
   its counts, how many of its lines fitted, and whether it was included or shed - never a
   belief statement.

## Tasks

A task is a short sequence of steps that APEX carries out one at a time. It is a
controlled capability: it runs only supported actions, under the same authorization and
verification as any single request.

**What a task stores.** An id, a creation time, the goal (with personal memory content
removed), and the steps. Each step has an id, a description, an action, its permission
(`read` or `write`), its validated input, and the steps it depends on. The task also
stores its status, its progress, each step's result, and the reason it stopped. Tasks
are kept in `tasks.jsonl` in the data directory. The file is append-only: each change
is one event, validated against the current state before it is written. The task state
is rebuilt from these events at every start, so progress survives a restart after each
step.

**States.** A task is `proposed` (a model's plan, waiting for your approval), `pending`,
`running`, `paused`, `completed`, `failed`, or `cancelled`. A step is `pending`,
`awaiting_approval`, `running`, `completed`, `failed`, `uncertain`, `skipped`, or
`cancelled`. Only the transitions in `src/tasks/model.js` are allowed. Any other change
is refused and is not written.

**Planning.**
- *From your request.* Each part must be a supported request (the table above). Each
  input is validated. The plan is checked before it is stored and is shown with its
  steps. `task plan` stores the plan and runs nothing; you run it with `task run`. A
  multi-part request in `ask` or `chat` is planned and run at once, as one task.
- *From a model (optional).* The model is asked for a JSON object `{"steps": [...]}`
  with at most 8 steps. Its reply is parsed strictly. A reply with extra fields, unknown
  actions, actions that are not plannable, bad or cyclic dependencies, or a private
  memory write is rejected, and nothing is stored. A model-proposed `memory.add` is
  also rejected: task approval must not relabel model-authored text as a user fact.
  A valid reply is stored as a `proposed` task. It does not run until you run
  `task approve <id>`.

**Running.** Each step goes through the controller's normal action path: authorization,
execution, then verification. The step is recorded as `running` before it executes.
A failed step, or one whose result cannot be verified, stops the task. The steps that
depend on it are skipped. A write step proposed by a model stops the task at
`awaiting_approval`. You approve that one step with `task approve <id> --step <stepId>`,
and the approval applies to that step's exact input only. Nothing is retried
automatically. An authorization denial, an execution error (including a timeout
reported by the action), and a verifier rejection all stop the task as a failure:
none is reported as an execution that succeeded, and a refused resume records no new
task events. There is no controller-imposed per-step deadline for the built-in
deterministic actions, so a genuinely hung action would keep the run and its lock
alive until the process ends; a lost process is then recovered as an interruption.

**Interruptions.** If the process stops while a step is running, the next start
resolves that step from its own `task.step` audit record. A record of `success_verified`
makes the step `completed` and names the audit record it came from; a record of a
failure makes it `failed` with that status; a step that executed but was never
independently verified stays `uncertain`. If the audit record is missing, belongs to a
different step, or the log cannot be read, the outcome stays unknown. In every case the
step is not run again. A read-only uncertain step can be retried on request. A write
step cannot be; cancel the task instead. A real lost process, not a fixture, is what
`tests/process-recovery.test.js` checks: it terminates a running child between the `running`
event and the step's result, then starts a separate process on the same data directory and
shows the recovered state, the audit records, the summary turn, and the follow-up answer, with
no step that had already run executing a second time.

**Audit and memory.** Every step writes its own operation record (capability
`task.step`), with the task id and step id. Planning, approval, retry, and cancel also
write records. Task events never write to long-term memory. Plans, responses, and
intermediate results are not saved as memory. A private memory write (`remember
privately`) is refused inside a task and is handled as a single request, so its content
never reaches `tasks.jsonl`.

**Model authority.** A model can only propose a plan. It cannot approve anything, write
task state, or change memory. Its read steps run as the model origin. A write step runs
only after you approve it, and then runs as you. Model-proposed `memory.add` steps are
not accepted because the task display intentionally omits the content being stored.

**What history keeps.** A task run writes one conversation turn of its own, origin
`apex_task`, built only from the replayed task state and the step audit records: the task
id, its verdict (`completed`, `partially completed, then failed`, `stopped on a step
whose outcome is uncertain`, `interrupted partway through`, `paused for your approval`,
`cancelled`), the step counts, and which steps are unresolved. It is capped at 480
characters and copies in no step output, memory content, file content, or model text. A
task whose state is already stated in the session is not stated again, so repeated resume
attempts write no stack of summaries. Only the system can create such a turn: it needs
the task id and the state signature, and a model that writes the same opening line is
stored as model text and replayed as `APEX (model, UNVERIFIED)`.

**Asking about a task afterwards.** A follow-up is answered from the task log, never from a
model. What makes a request such a question is decided by question *classes*, not by a list of
sentences APEX recognises: status, which steps succeeded, what is still pending, whether it
finished, why it stopped, whether anything needs your approval, and whether it can be resumed
(`src/controller/task-context.js`). A request becomes a task question only when it carries one
of those classes *and* something that points at a task: a whole task id, a short id after the
word "task" (`did task 1f3a finish?`), a task or step word, or a short bare follow-up
("did it finish yet?", "what do I need to approve?") that names no other thing it could refer
to. An instruction ("resume that task", "mark it complete") and a goal ("explain the task of
organizing my downloads") are never answered as questions about a record, so a passing mention
of the word "task" does not turn a request into one.
Which task is meant is then decided by the records: an id you named is looked up in the task
log, and an id that matches nothing is refused rather than guessed at; otherwise it is the task
this conversation holds a result for. More than one candidate means APEX asks which one, unless
you asked for the latest task by name - and the answer states the id it chose. A task the
conversation recorded but the log no longer holds, a log that cannot be read, and a history that
cannot be checked are each reported as what they are, and nothing is run either way. The answer
never claims more than the records establish: an uncertain step is named as unresolved, a held
step as awaiting your approval rather than as stopped, a step whose `task.step` record could not
be written as evidence APEX cannot show, and an approval or recovery question only describes the
state - it approves nothing and resumes nothing.

**Explaining a task without a conversation.** `node bin/apex.js task explain <id> [view]` prints
those same views for one task named by id, straight from the records: the task log gives the
recorded status and step outcomes, and a final `Evidence:` line states whether every step the log
records as verified has an operation record of its own. Recorded status and independently
supported verification are printed apart, so a completion the audit cannot show is never presented
as a checked one. The command asks no model, writes no audit record, and runs, resumes, retries,
and approves nothing - a held write step is described as held. A missing `task.step` record and an
operation log that cannot be read are both reported as no independent support rather than as
success, and steps are named by id only: no audit line, step output, or memory content is copied
into the display. Exit 0 means the task is recorded as complete *and* each verified step has its
own record; a task that is incomplete, held, failed, cancelled, or unsupported by its own evidence
exits 1; an unknown id or a malformed view exits 2.

**The model workflow, tested with a controlled endpoint.** `tests/model-workflow.test.js` drives
the whole path - reply, proposal parsing, authorization, approval, execution, verification, audit,
conversation, plan follow-up, and recovery - with the *model* supplied by a deterministic fixture
(an OpenAI-compatible stub server on a loopback port, or a fixed plan JSON gateway) and every other
component being the real implementation, the real CLI included. It covers a proposal that runs and
is audited as the action that ran, a proposal for a user-only action being denied before execution,
a malformed proposal line being refused and replayed as a refusal, a model plan taken through
approve → run → verify → explain → follow-up, a model claim of work it never did staying unverified
model text with nothing stored, and the endpoint being unreachable, unparseable, empty, or slow.
Two classifications decide what each case must report: a reply that is not a plan is a *rejected
plan*, while a reply that never arrived or arrived empty is a *backend failure* - there was no plan
to check; and `task retry` records the decision to try again, it does not execute the step. These
tests say nothing about what a real model replies, how long it takes, or how often it obeys a
format, and they claim no inference latency. Genuine inference against a configured local backend
is reported separately, in the Batch D report.

**When history cannot be written.** A task-result turn the conversation store refuses is
disclosed on the spot, and its text is kept in `task-summary-queue.json` as an intent to
offer it again. The next task write - a later run, a cancel, or a follow-up question about
a task - delivers what that queue holds for the current session: the task log is read to
check that the state the intent describes is still the recorded state, history is checked
so the same state is never written twice, and the intent is dropped only once the turn is
confirmed written. A reissue never runs a step and never audits a new one. A state the task
has moved on from is dropped rather than written, so history holds what the task log records
now. Where the task log or the history cannot be read, nothing is written and the intent
stays owed.

**One failure, one record.** A reissue attempt can fail in the same turn that writes a new
task's own summary. The two outcomes are disclosed separately: a notice about an earlier
queued result never says this turn's result was lost, and a current summary that could not
be queued is not described as queued because an older intent is still owed. The reissue
failure and this turn's own failure are recorded under different subjects on the operation
record, so the display is derived from the same facts the audit holds.

**Limits.**
- Free-text planning recognises only the request forms above and the `;` and `then`
  separators. Anything else needs a model to propose a plan.
- Ordinary `remember` content is part of a step's input, so it is kept in `tasks.jsonl`
  as well as in memory. Private content is not.
- Steps run one after another, in dependency order. There is no parallelism and no time
  limit on a step.
- A lock file (`tasks.jsonl.lock`) stops two processes from running tasks at once. A
  second process is refused, not queued. A lock left by a process that is no longer
  running is removed by exactly one elected taker.
- Every task read replays the whole task log. That is fine at this scale; it is not a
  design for many tasks. A task follow-up also checks the operation log for every step the
  task log records as verified: that scan stops as soon as each step's own record has been
  found, and reads to the end when one is missing, because a truncated scan cannot
  establish that a record is absent. The read is bounded in work, not in evidence.
- A task follow-up resolves its referent from this session's conversation and the task log.
  A run that was interrupted before it wrote any summary therefore leaves nothing the session
  holds, so a follow-up asks which task and points at `task list` rather than choosing the
  task the log still shows as running; `task explain <id>` still answers about it, because it
  takes the id. A bare follow-up is treated as one only while it stays
  short and names nothing else; a long paraphrase goes to the model path instead.
- A task-result turn that cannot be saved is disclosed and queued for reissue (see "When
  history cannot be written"); the task is never run again to make up for it. The queue is
  bounded: 32 intents in total, 4 offered per write, and an intent that would exceed the cap
  is refused and disclosed rather than displacing an older one. Intents for a session that
  `apex new` replaced are never delivered. Each queue update holds
  `task-summary-queue.json.lock` and waits a bounded time (2 s) for another update to
  finish; if it still cannot read or take ownership of the lock it is refused as "in
  use" with nothing changed, so a concurrent update can defer an intent but cannot
  silently lose or overwrite one. The whole file is written as a staged write plus an
  atomic rename, and the queue is a work list, not evidence: dropping an intent never rewrites
  task or audit history. `queue` shows what is owed and whether the queue or its lock
  needs attention. There is no repair command for a damaged queue: a queue file that
  cannot be parsed is reported by `queue` and `diagnose`, fails closed, and reissues
  nothing until an operator resolves it. `repair locks` addresses only lock files, not
  queue contents.
- Model planning has been tested only with test doubles and stub servers. No real model
  was used to plan a task. See the Mission 003 report for what was and was not run.

## Architecture (as implemented)


```
bin/apex.js           entry point
src/cli.js            command line; maps results to exit codes
src/app.js            composition root (wires the components)
src/config.js         environment-variable configuration
src/errors.js         error types with stable codes
src/identity.js       application identity and version
src/outcomes.js       the outcome status values (see Outcomes below)
src/diagnostics.js    read-only state of every subsystem, for status and diagnose
src/util.js           shared helpers: truncation, redaction of content fields, rounding
src/controller/
  controller.js       Cognitive Controller: the workflow and the final status rule
  context.js          prompt construction: labelled memory, turns, the bounded counts-only world-state view, size budget, system prompt
  router.js           deterministic capability table (action pattern -> action)
  task-context.js     which question class a follow-up is, and which recorded task it points at
  proposals.js        parser for model output; proposals are untrusted requests
  task-runner.js      runs a task's steps through the controller's action path; owns task transitions
src/tasks/
  model.js            task and step states, allowed transitions, dependency checks, event reducer
  store.js            tasks.jsonl: validated appends, replay, and the single-process lock
  planner.js          deterministic plans and strict model-plan checks; nothing here runs an action
  format.js           plain-text rendering of tasks, shared by replies and the CLI
  summary.js          the bounded task-result turn and the state signature that dedupes it
  summary-queue.js    task-summary-queue.json: summaries history refused, waiting to be reissued
src/goals/
  model.js            goal states, legal transitions, evidence rules, duplicate detection, and the append-only reducer
  store.js            goals.jsonl: validated appends under the goal write lock, short-id resolution, and the audit re-check completion requires
  format.js           plain-text rendering of goals, criteria, evidence and history
src/plans/
  model.js            plan states, content validation, the content hash approval is bound to, and the append-only reducer
  store.js            plans.jsonl: draft, revision, approval, activation and outcome events under the plan write lock
  continuation.js     the eight interruption boundaries, the nine continuation states read from plan, task and audit records, and the refusal to replay a step whose effect cannot be established; writes nothing and grants nothing
  format.js           plain-text rendering of plans, steps, assertions, risk and outcomes
src/executive/
  vocabulary.js       the bridge's fixed labels: request modes, execution states with the record that proves each, side-effect classes, failure boundaries, recovery classes, status questions, output bounds
  mapping.js          the deterministic half: which executive request this is, which registered capability carries each part, the plan content within the plan model's own bounds, and what the registry and policy say about each step before the user sees it
  preview.js          the bounded view the user approves, built from the stored plan plus the live registry's answers, and the content hash the approval binds to
  status.js           progress communication: the portfolio questions answered from goal, plan, task and continuation records, each state naming its record
  recovery.js         what an interrupted or partial run's records prove, and what may legitimately happen to each step; writes nothing and grants nothing
src/actions/
  registry.js         action registry and the authorization policy
  origins.js          request origins: user | model
  executor.js         input validation + action body; reports what happened only
  calc.js             arithmetic: recursive-descent executor, shunting-yard verifier
  builtin.js          the built-in actions (input schema, permission, verify)
  knowledge-actions.js the knowledge actions: add, retract, resolve, list, search
  experience-actions.js the experience, feedback and adaptation actions
  prediction-actions.js the prediction ledger actions: three user-only writes and four reads, each with an independent re-read verify
  goal-actions.js     five user-origin goal writes: add, update, evidence, complete, link
  plan-actions.js     five user-origin plan writes: add, revise, approve, cancel, supersede
  world-actions.js    the user-only `world.state` read: projection, audit-minimal result, independent re-read verify
src/verify/
  verifier.js         separate verifier: decides whether a postcondition holds
src/memory/
  jsonl-store.js      append-only JSON Lines with fsync and damage tolerance, plus an optional per-process derived parse snapshot
  memory-store.js     personal memory: validation, provenance, content hash, retrieval, one-read `projectionRead`
  conversation-store.js  conversation turns with origin; credential-like text is never stored
src/knowledge/
  knowledge-store.js  triples, validation, conflict detection, lifecycle events (retraction, resolution), store-wide health, one-read `projectionRead`
src/experience/
  experience-store.js append-only `experiences.jsonl`: audited events, user feedback, adaptation records and their lifecycle; `evidenceSnapshot` / `evidenceIndex` for a horizon read
  derivation.js       the deterministic adaptation derivation: repeated user corrections in one capability scope yield one candidate rule, carrying the user's own words; approves nothing
  capture.js          the bounded automatic capture on the finalization path: an operation APEX proved may be recorded as an experience, and nothing else
  temporal.js         the read-time temporal engine: ordering, windows, outcome classes, detected patterns; imports no store
src/prediction/
  prediction-store.js  append-only `predictions.jsonl` with its own write lock: validated appends, citation resolution against the experience log, list/show/history/calibration/prompt/health reads
  prediction-engine.js the record validator, the lifecycle and lineage derivation, the evaluation rule, calibration counts, and the bounded audit and prompt shapes; no state is stored
src/world/
  world-state.js      read-only epistemic projection of what memory and knowledge already hold, with a separate bounded temporal section and an `Expectations` section that never joins the beliefs; owns no state, writes nothing, one authoritative read per store; `worldPromptLines` renders the counts-only view a model prompt may carry
src/cognition/
  vocabulary.js       the fixed stage labels: intents, evidence sources and statuses, claim kinds, uncertainty categories, decision kinds, disclosures, and the numeric bounds every stage shares
  request.js          request understanding: intent, referents, time range, ambiguity, unsupported capability, missing-information codes; a description that grants nothing
  evidence.js         bounded retrieval across the stores, reduced to one evidence shape carrying provenance, validity, status and relationships, with omissions reported as omissions
  claims.js           claim extraction, duplicate reduction, and a contradiction map that keeps both sides
  deliberation.js     thirteen ordered deterministic steps from question to decision and disclosures
  response.js         grounding-brief bounds, structured-response and plain-answer validation, disclosure wording, and the notice that corrects a model action claim
  protocol.js         extraction, size bound, parse and whole-structure rejection of the optional `COGNITION` line
  trace.js            bounded audit trace: stage names, counts, evidence ids, refusal codes, validation results and the execution-boundary decision; never chain-of-thought, request text, stored content or model text; every audit states authorizes:false
  contract.js         the ten-stage cognitive runtime contract: what each stage did, bounded counts and fixed labels, the invariants that no step executed without an allow decision or without an authorization record, and the fixed authority block (action_registry owns authorization); the audit shape carries no request, evidence, model or reasoning text
  engine.js           runs the stages in order, exposes per-stage timings, and validates model output against the analysis that produced the prompt
src/filesystem/
  path.js             absolute path validation: no traversal, no drive root, no UNC
  actions.js          bounded, read-only listing and reading
src/session.js        conversation session id (persists until `new`)
src/security/
  secrets.js          credential-like text detection (five pattern families), the bounded persistence
                      mask over values, field names and keys, and the print-side redaction the readers
                      use (no dependencies)
src/operations/
  operation-log.js    audit records: the one write boundary every record passes through, where the mask
                      runs, `output` is minimized, and an unfilterable body becomes a marked shell
src/model/
  gateway.js          Model Gateway: replaceable backend; NoBackend; OpenAI-compatible and Ollama adapters
```

**Separation of concerns.** The executor runs an action and reports the raw
result. The verifier, a different component, reads the store or recomputes the
value by a different method and decides the outcome. The controller combines these
and applies the status rule. The model is one backend behind the gateway. It never
holds identity, memory, control, or persistence.

### Authorization

- Every action declares `permission` (`read` or `write`) and `origins` (who may
  request it).
- `write` actions are offered only to the `user` origin. The registry refuses to
  register a write action for `model`.
- A model proposal is one line: `PROPOSE_ACTION` followed by a single JSON object
  `{"action": "<registered name>", "input": { <that action's named parameters> }}`.
  `action` must be a string and `input` must be an object — `{}` for an action that
  takes no parameters, never a bare string or number. A proposal that violates this is
  rejected before it is authorized: the audit step records `input_rejected`, names the
  field that was wrong and its JSON type (never the value it carried), and reports
  `not_run` for both execution and verification. `action` must also match the registered
  action-name grammar (lowercase letters and digits, separated by `.` or `_`); anything
  else is malformed before it is quoted. Names and keys that APEX quotes back in a
  refusal, and step ids and descriptions in a rejected plan, are rendered on one line
  without control characters, so model text cannot add a line that imitates an APEX
  record such as a verified step result.
- A proposal is only a request. It goes through the same policy as a user request.
  Model output is never executed as code. At most three proposal lines are considered
  per reply; the prompt states this limit, and the user is told when extra lines were
  ignored.
- Unknown actions and unknown origins are denied.

### Actions

| Action | Permission | Origins | Input | Verification (independent check) |
|---|---|---|---|---|
| `app.status` | read | user, model | none | identity and memory count agree with a fresh store read |
| `memory.search` | read | user, model | `query`, `limit` | returned ids equal a fresh store search; each record's content matches the store |
| `memory.list` | read | user, model | `limit` | count equals the store count (up to limit); newest-first; content matches |
| `memory.add` | **write** | user | `content` | record exists by id; content SHA-256 matches; provenance is `user` / `user_fact` |
| `memory.correct` | **write** | user | full `targetId`, replacement `content`, explicit `resolve` | correction record, user-confirmed provenance, exact target link, and preserved target are re-read |
| `memory.save_conclusion` | **write** | user | `content`, `operationId`, `backend` | record exists; hash matches; provenance is `model` / `model_conclusion` |
| `calc.evaluate` | read | user, model | `expression` (digits, `+ - * / ( )`, max 200 chars) | a different algorithm (shunting-yard) gives the same value |
| `filesystem.list` | read | user | `path`, `limit` | a second listing matches names, types, count, and truncation flag |
| `filesystem.read` | read | user | `path`, `maxBytes` | a second read matches size, SHA-256, and text |

`filesystem.*` actions are registered only when `APEX_FILESYSTEM_ROOT` is set. They are
not offered to the model origin, so a model proposal cannot trigger a file read.

### Outcomes

Each action step and each operation has one status:

| Status | Meaning |
|---|---|
| `success_verified` | The action ran and the verifier confirmed the postcondition. **The only status that means success.** |
| `execution_failed` | The action or model call failed. Verification was not run. |
| `verification_failed` | The action ran, but the verifier found the postcondition does not hold. Never reported as success. |
| `verification_unavailable` | No verifier exists, or the verifier could not read its evidence. For a model answer, this is the honest status: a model conclusion has no independent check. |
| `audit_integrity_failed` | The task/action result is preserved, but a required task-step audit record could not be persisted. The overall operation is not successful. |
| `action_denied` | Authorization refused it. The action did not run. |
| `input_rejected` | Input failed validation. Nothing ran. |
| `model_unavailable` | No backend configured. No answer was generated. |

### Audit records

Each operation writes one line to `operations.jsonl`. Fields: `id`, `requestedAt`,
`finishedAt`, `origin`, `request`, `capability`, `retrieval` (record ids and scores
only), `backend`, `model`, `steps` (each with authorization, execution,
verification, outcome, summary), `status`, `output`, `errors`.

Redaction: memory content is not copied into the audit log. A `remember` request is
logged as `remember [content omitted: N chars]`, and action results show
`[omitted N chars]` in place of content. Model answers are stored (truncated) in
`output`, so **a model answer can repeat memory content**. That is a known
limitation.

Separately from that minimization, every audit record passes through whole-record
masking at `OperationLog.append`: any string that looks like a password, key or token
is replaced with `[omitted: contained a password, key, or token]` wherever it sits -
in a value, in a field name, in an object key, at any nesting the walk reaches - and
the record is marked `secretsMasked: true`. The walk is bounded (depth 8, 4,000 nodes);
a record that reaches the bound says so with `auditMaskBoundReached: true` instead of
stopping quietly, and a record whose body cannot be filtered at all is written as a
bounded metadata shell marked `auditMinimizationFailed: true`. A record minimized this
way is not verbatim evidence, and the mask is a pattern heuristic, not a guarantee.
Records written before Batch AF are left exactly as they are and reported by `audit
health` and `diagnose`; nothing rewrites history.

Two consequences of that composition are worth stating plainly, because they are what a reader finds
on disk (`tests/security-end-to-end.test.js`): the **conversation turn keeps the same masked form as
the audit `request`** - a stored fact leaves `remember [content omitted: N chars]` in
`conversation.jsonl` as its user turn, so the sentence survives only as the extracted content in
`memory.jsonl`, and a refused credential leaves the omission marker in both files; and a refused
`task plan` keeps `request: null` rather than a masked copy of the goal, because the goal is only
assigned to the record after the check that rejected it. The consolidated statement of what the
redaction covers, what it does not, and what a damaged or historical log holds is in
[Batch AF: what stops a credential, what survives damage, and what none of it claims](#batch-af-what-stops-a-credential-what-survives-damage-and-what-none-of-it-claims).

## Tests

```bash
cd apex_app
npm test
```

`npm test` runs every test file listed in `package.json` with the built-in runner and
prints the current test, pass, fail, and skip counts for your platform. Those counts
change as tests are added, so the command output is authoritative. On Windows 11 with
Node 26.4.0, two tests are skipped (POSIX permission bits; control characters are
invalid in Windows file names). On Linux with Node 22, one Windows-only separator test
is skipped. The suite uses only temporary directories under the OS temp folder
(`apex-test-*`) and removes them afterwards. Tests never read or write `~/.apex`, and
CLI tests point `HOME`/`USERPROFILE` at the temp directory too.

A bounded manual smoke test against an Ollama endpoint that was configured on that
machine at the time was run on 2026-10-31
(one request, about 105 s). A bounded four-request benchmark with a documented
procedure (`benchmarks/run-model-benchmark.mjs`, using the ordinary application path)
was run the same day. Neither is part of this suite; both are reported separately.
`benchmarks/run-world-state-benchmark.mjs` is also outside the suite; it needs no model
and measures the projection's read cost against synthetic fixtures, or the write path with
`--writes` ([Benchmarks](#benchmarks)).
`benchmarks/run-experience-benchmark.mjs` is outside the suite for the same reason and also
needs no model: it measures the experience store's reads, writes, context contribution, and
cost against the memory and knowledge stores at matched record counts
([Benchmarks](#benchmarks)).
`benchmarks/run-prediction-benchmark.mjs` is outside the suite for the same reason and needs no
model: it measures the prediction ledger's reads against both axes (ledger size and experience-log
size), its writes in parts, real child-process contention on the prediction lock, and the context
contribution of the bounded expectation section ([Batch AE](#batch-ae-prediction-ledger-hypothesis-lifecycle-and-outcome-evaluation-as-implemented)).
`benchmarks/run-cognition-benchmark.mjs` is outside the suite too and needs no model and no endpoint:
it measures the cognition stage timings across three store sizes, the brief's contribution to a real
prompt, and the structured-response validator, using the applied `createApp` path
([Benchmarks](#benchmarks)).
`benchmarks/run-executive-bridge-benchmark.mjs` is outside the suite for the same reason and needs no
model: it measures the executive bridge - request-to-preview, the approval write and its read-back,
multi-step orchestration through the existing task runner, the status and recovery reads, and one
verified write at five depths - against fixtures of 1 to 150 real executive bundles, and prints the
records each measured call appended
([Executive bridge](#batch-ak-the-executive-bridge-safe-action-orchestration-and-verified-execution-as-implemented)).
`benchmarks/run-planning-benchmark.mjs` is outside the suite for the same reason and needs no model and
no endpoint: it measures the nine Batch AL planning paths at three store sizes, attributes what one
audited planning read spends on each store read, adds the Batch AM constraint and real-child recovery
phases, and adds the Batch AN `ranking` phase over a fourth fixture - a large project with many active
plans and tasks - where one `work`/`next` report is timed stage by stage and the pre-AN per-plan goal
replay is measured against the one-snapshot read, as Batch AN reports in
[Benchmarks](#benchmarks).
`benchmarks/run-cognitive-runtime-benchmark.mjs` is outside the suite for the same reason and needs no
model: it measures one grounded request at five evidence contexts, the proposal paths (permitted,
duplicated, denied, malformed, cancelled, retried), handoff build and live validation at 1-8 steps, the
plan add/approve/activate path and the continuation report, and the diagnostics recorder itself. It
uses an in-process fixture backend and writes only into temporary directories
([Benchmarks](#benchmarks)).

| Acceptance test | Where |
|---|---|
| 1. Starts without a configured model | `cli.test.js` "starts and reports status with no model" |
| 2. Memory item stored and retrieved | `memory.test.js` "stores a user fact and retrieves it" |
| 3. Relevant memory retrieved for a later request | `controller.test.js` "memory is retrieved for a subsequent request" |
| 4. Memory survives restart | `memory.test.js` "survives a restart"; `cli.test.js` "survive a restart: a second process" |
| 5. Allowed deterministic action executes and is verified | `controller.test.js` "a permitted deterministic action"; `cli.test.js` "verified calculation" |
| 6. Unauthorized action denied | `actions.test.js` "authorization policy"; `controller.test.js` "model proposal to write memory is DENIED" |
| 7. Failed action not reported verified | `controller.test.js` "a failed action (division by zero)"; `actions.test.js` "execution error" |
| 8. Verification failure recorded correctly | `controller.test.js` "a verification failure is recorded as verification_failed" |
| 9. Unavailable model handled honestly | `controller.test.js` "no model configured"; `gateway.test.js` (timeout, HTTP error, unreachable, malformed) |
| 10. Operation produces an auditable record | `controller.test.js` "every operation produces an auditable record" |
| 11. Invalid input rejected safely | `controller.test.js` "invalid requests are rejected"; `actions.test.js` "invalid expressions"; `memory.test.js` "invalid content" |
| 12. End-to-end workflow with restart | `controller.test.js` "end to end across a simulated restart" |
| 13. Task created, persisted, and inspected | `tasks.test.js` "creation and persistence"; "command line" |
| 14. Task validation: cycles, unknown actions, malformed model plans | `tasks.test.js` "planning and validation"; "model-proposed plans" |
| 15. Task runs with existing actions; failure stops it; no re-execution | `tasks.test.js` "execution" |
| 16. Cancel and safe resume | `tasks.test.js` "cancel"; "interrupted running step" |
| 17. Bounded read-only filesystem inspection | `filesystem.test.js` (listing, reading, bounds, traversal, absolute and UNC paths, links, model origin, audit failure) |
| 18. Filesystem steps in controlled tasks | `tasks-filesystem.test.js` (plan, run, verify, model-plan rejection, traversal step, changed file, audit gaps, restart and retry, CLI exit codes) |
| 19. A task explained from the records, with no model and no run | `tasks.test.js` "command line" (every view, incomplete work, missing `task.step` records, an unreadable operation log, malformed arguments) and "task explain as the CLI reads it" (a held write step stays held) |
| 20. A real process lost mid-step, recovered by a second one | `process-recovery.test.js` (terminate at the `running` event, stale task lock replaced, no step re-run, uncertain write never retried, recovery summary, follow-up answered from the records, recovery idempotent) |
| 21. The full model workflow, reply to record, with every APEX component real | `model-workflow.test.js` (proposal executed and audited, user-only proposal denied, malformed proposal refused and replayed, plan → approve → run → verify → explain → follow-up, model claim of undone work stays unverified, endpoint unreachable/invalid/empty/slow; the model itself is a stub, so no real-model behaviour or latency is claimed) |
| 22. Batch D as one story across the four stores | `acceptance-batch-d.test.js` (model plan with a held write step told identically by task log, audit log and history; a refused summary disclosed, owed once, reissued without re-executing; follow-up referent resolved or clarified; a real child process killed mid-write recovered, with repeated recovery changing nothing; missing and unreadable evidence never reported as verification; registry, plan and proposal write limits for the model origin) |
| 23. A clean install, and a bad setting or a broken store | `readiness-batch-e.test.js` (initialization in an isolated directory leaves an existing `~/.apex` byte-identical; a deterministic action runs with no model; an unreachable endpoint is a failure, not an answer; a denied model proposal runs nothing; a killed process is never reported as success; history and audit agree; diagnostics report damage without writing); `config-failures.test.js` (eleven invalid settings refused before any store is opened; a storage failure reported as storage, a model failure as a model failure, each with its own exit code) |
| 24. A request that lost its session is disclosed | `session-degradation.test.js` (`ask`, `chat` and `task run` print the notice while the outcome and exit code stay truthful; the audit record names `stage: session`; nothing is stored without a session; a conversation failure is not described as a session failure) |
| 25. Two processes cannot both hold the task lock | `lock-contention.test.js` (six real processes racing a stale lock: exactly one enters; a live holder is never displaced; a holder removes only its own claim; repeated recovery; an unreadable lock is refused and preserved; a release between the failed link and the read is a free lock; an abandoned takeover token is superseded; a live takeover refuses a second taker; a read takes no lock; three concurrent runs of one task record each step once) |
| 26. A real process that exits inside a lock takeover is recovered explicitly | `lock-recovery.test.js` (a takeover token whose holder is gone is removed by `repair locks` while the claim and every live holder are left untouched; recovery is bounded and refuses when it cannot prove the holder is dead) |
| 27. Deferred task summaries are visible and bounded | `queue-observability.test.js` (the `queue` view reports owed intents, corruption, a full queue, and lock state; a corrupt queue fails closed and reissues nothing) |
| 28. Credential-like text is minimized at the persistence boundary | `audit-minimization.test.js` (a model answer's key or password is replaced in the audit output and the record marked `outputMinimized`; a credential-like request is not copied; history keeps no part of it) |
| 29. Recovery and diagnostic messages say what is known and what is safe | `diagnostics-usability.test.js` (damage, missing evidence, locks, queues, uncertain results, and model failures each get specific guidance; no failed command suggests repeating a possible side effect) |
| 30. Model configuration is a validated contract | `model-config-contract.test.js` (invalid providers, names, ranges, remote endpoints, and Ollama without a name are refused before any store opens; health reads listings only) |
| 31. The documented CLI workflow works without a model | `cli-workflow.test.js` (help maps every command and exit code; the walkthrough from remember to task explain to knowledge search to diagnose runs in an isolated directory; a denied model proposal and an unusable data directory are reported truthfully) |
| 32. A failure never claims more than the pipeline established | `failure-semantics.test.js` (rejected input versus denied action; verification failed versus unavailable; a write that failed after it started; an audit failure after a side effect; an unusable data path) |
| 33. Persistent stores recover without inventing evidence | `store-recovery-acceptance.test.js` (a real interrupted child; a damaged step audit line preserved and disclosed; a corrupt summary queue failing closed; `repair locks` leaving queue bytes unchanged; a partial task-log write reconciled without re-execution) |
| 34. Retrieval stays exact, bounded, and provenance-preserving at scale | `retrieval-contract.test.js` (4,000 records searched in under 5 s; ambiguous ids refused; conflicting triples kept with both ids and provenance; malformed writes refused; damage in one store does not block an unrelated deterministic request) |
| 35. Capability statements match the evidence | `capability-truthfulness.test.js` (README categories for implemented, deterministic, stub-tested, real-model-tested, `stark/`, and proposed work; root README corrected; help and diagnostics never call a listing probe inference, and an unprobed model is "not checked") |
| 36. Batch I as one story | `acceptance-batch-i.test.js` (14 scenarios: deterministic workflow, missing model in listing, denied proposal, corrupt storage, audit failure, interrupted task, explicit lock recovery, concurrent queue updates, credential minimization, uncertain outcome, read-only diagnostics, knowledge conflict and provenance in model context, CLI usage errors, listing-only model reporting) |
| 37. What APEX currently holds as belief, stated without a model and without writing | `world-state.test.js` (empty stores; user-asserted beliefs kept apart from unverified model conclusions; missing evidence as an explicit unknown; an unresolved knowledge conflict and a heuristic memory disagreement both reported and neither changed by being read; a recorded decision reported as a decision; superseded and retracted records as history, not belief; private memory marked and the projection refused to model origin; audit carries ids and counts, never belief text; a damaged store contributes no beliefs and is disclosed; a bounded window and reproducible output; three reads and a rejected read byte-identical with zero model calls; restart persistence; routed questions answered from the projection while "what do you believe about X" stays on the model path; mid-read store change fails verification; legacy records without `updateMode` still classify; CLI exit codes and usage errors) |
| 38. The read optimization does not weaken the projection | `world-state-performance.test.js` (a cold read and a warm read return the same records, the same damage and the same projection; a same-length external rewrite, a replaced file, and a deleted file are all detected, so invalidation is not a size or mtime guess; corrupt lines and an unreadable store are re-reported instead of masked by an earlier healthy read; the verifying read is a real re-read, and a write landing between the executed read and the verifying read fails verification; a caller mutating the records it was handed cannot poison the snapshot or reclassify a belief; neither read adjacent to this instance's own append consults or rewrites the snapshot, and a write still sees a record another process wrote; a store over the cap is never snapshotted; stores that never opt in report the snapshot disabled; projection reads never write a byte) |
| 39. The incremental write state never outranks the log | `incremental-write-state.test.js` (a write loop and a full lifecycle sequence - conflict, supersession, retraction, resolution - produce exactly the records, conflicts and projections a fresh replay of the authoritative bytes produces; a reuse is proven by one read of the file and by the file's own hash, so an external append, a same-length rewrite, a truncation and a replaced file each force a fresh validated read; a write that accepted no bytes, a partial write, an invalid record and a damaged store leave the state behind the file rather than ahead of it; a store over the cap and a store that never opts in track nothing; two real child processes appending to one store keep every line and every decision visible; two instances of one store interleaving corrections both land their replacements and each instance's next write read equals the replay) |

| 40. Two processes cannot each decide one store's next state | `store-write-concurrency.test.js` (18 scenarios, all with real child processes and assertions on the authoritative records and lifecycle states rather than exit codes: distinct memory and knowledge adds, one conflict group, corrections, supersessions, retractions and resolutions raced two at a time so exactly one decision is recorded and the loser returns a truthful refusal; a live holder is waited for within its budget, an expired budget refuses with the store byte-identical, and the default budget is disclosed so a stuck holder cannot hang a command; a process killed while holding the claim is taken over by the next write, an unreadable claim is reported as in use by an unknown process and never removed, and recovery of sixteen abandoned tokens removes tokens only; an append that writes nothing and a claim that cannot be removed are both refused with the store left parseable; a corrupt store is discovered under the claim and refused; a warm instance cannot decide from state another process has already changed; five writers per store together, three repeated stress rounds, and read-only commands that take no lock and never disturb a live holder; plus `diagnose` and `repair locks` for both new lock files, and the authorization review - an unauthorized request is refused before any coordination, a model-proposed plan cannot reach the write lock, private content stays out of the audit on a coordinated write, and post-append ownership loss (`LOCK_LOST`, the record exists) stays distinguishable from a pre-write refusal (`LOCKED`, nothing was written)) |

| 41. What the model is told about the whole store, not only what retrieval showed | `world-context.test.js` (16 scenarios through the assembled application with a recording test double: a clean store adds no section; an unverified model conclusion and an evidence-less claim reach the model as their own disclosures; a private counterpart marks the record that was shown while its content stays out of the prompt; a conflicting record outside the retrieval boundary, and a disagreement larger than the prompt's knowledge cap, are both reported by the projection; a recorded user decision is stated as a decision and not as an open conflict; superseded and retracted records are counted as history; a damaged store is disclosed as damage and an unreadable projection is disclosed as unavailable without blocking the answer; the system prompt states the section's boundary; deterministic requests touch neither the model nor the projection; reading the projection writes nothing to either store; a model cannot obtain the projection or erase the disclosure with confident prose; and a tight budget sheds retrieved records before trimming the summary, then drops the summary before stored knowledge while the user-facing notice stays) |

| 42. The whole route, checked against the bytes it leaves behind | `security-end-to-end.test.js` (15 tests in 6 scenarios, every one driving the real `main()` from `src/cli.js` in a temporary data directory and reading the files back with `fs`: all four synthetic credential shapes refused on the memory route and byte-searched in **every** file under the directory including subdirectories; the knowledge, prediction and task routes refusing the same shape while `operations.jsonl` is the only file created; a stored fact told identically by `memory.jsonl`, `operations.jsonl` and both `conversation.jsonl` turns; a two-step plan told identically by `tasks.jsonl` transitions and its `task.plan`/`task.step`/`task.run` records; usage errors exiting 2 with zero bytes changed against store-validated rejections exiting 1 with their own record; a request rejected before any capability is chosen; the same text refused from a model origin and stored from a user origin; a torn audit line preserved, reported, never echoed, and unable to close the log; a damaged fact store blocking that store alone; experience capture armed through `APEX_EXPERIENCE_CAPTURE` alone, where a refusal creates no `experiences.jsonl` at all and the next verified success captures one; the twelve reads that write nothing and the three that record themselves). It configures no model in any case, so it is not evidence about model behaviour) |
| 43. Damage is reported, never repaired, and never presented as an empty store | `corruption-recovery-boundaries.test.js` (8 tests: every persistent store in one directory damaged at once, then each user-facing surface asked what it says about each store, then the directory re-hashed to prove that reading, diagnosing, refusing and running lock recovery changed no byte of evidence) |
| 44. Lock ownership and recovery, budget by budget | `lock-ownership-and-recovery.test.js` (17 tests across all six lock namespaces: every shape a corrupt claim can have, each protocol's measured wait next to its exported budget, a foreign live pid refused on liveness and later taken over, the two release paths that report lost ownership only after the record is durable, a staging file another process left behind, and recovery held simultaneously over every namespace) |
| 45. A failed audit append cannot leave a verified-success claim standing | `append-audit-failure-semantics.test.js` (15 tests over the six-stage order - side effect, audit append, finalization, capture, prediction evaluation, disclosure - including `recorded: false`, the `audit_integrity_failed` downgrade, capture refused for want of a record, and the duplicate side effect a retry produces because nothing rolls the write back) |
| 46. Every completion path finalizes the same way | `finalization-path-audit.test.js` (11 tests on the paths Batch AB and AF-15 left unwalked: prediction operations verified and still never captured; an error-bearing success refusing automatic capture while the manual path works; the duplicate-finalization guard on all four controller-audited paths; and what each path returns compared field by field with what `operations.jsonl` holds) |
| 47. A reply never authorizes itself (AF-20) | `model-self-authorization.test.js` (17 tests, each against a fixed stub reply and the real parser, planner, registry, executor, verifiers, four belief stores and audit log - so nothing here is evidence about what a real model would say: a response proposing the three prediction writes is denied at every step and stores nothing; an adaptation cannot approve itself and the candidate stays a candidate; none of the twenty-eight write actions runs at model origin while the identical input writes at user origin; a plan whose steps are user-only writes is rejected, a plan reporting its own status or verdict is refused as malformed, a plan naming a nonexistent action is refused; a write step in a model-origin plan waits for the user and no reply approves it; provenance cannot be forged - a supplied `origin`/`updateMode` is refused before the store opens, each store derives its own, a store refuses a non-user origin even for a caller that skipped the registry, an experience can only cite an operation really in the audit log, and a model-origin write cannot be registered at all; verification is computed, never claimed - no shape of reply produces a `success_verified` operation, a reply cannot name the request it answers or the session it belongs to, and a reply whose proposals were all denied captures no experience) |
| 48. A plan is valid only against the state it names (AH) | `executive-continuation.test.js` (7 tests: live validity after capability, goal-revision, dependency, and evidence-reference change; approval version and content-hash binding; goal revision staleness; proposal creation, assessment, and user decision; a stale proposal is refused and a fresh one is required; advice applies nothing; continuation ranking is deterministic and executes nothing) |
| 49. The executive layer survives concurrency, a crash, and damaged records (AH) | `executive-reliability.test.js` (8 tests, real child processes and the real CLI: five concurrent goal creations; serialized concurrent goal transitions; an approval/revision race; a child killed after task creation before activation, adopted once on restart; damaged goal logs reported by `recover` and `work` without changing a byte; goal-revision drift reported as inconsistent; every executive write denied at model origin; plan metadata cannot inject an unregistered capability) |
| 48. Prediction, evaluation and adaptation stay separate authorities (AF-21) | `prediction-adaptation-boundary.test.js` (14 tests asserted against the persisted files rather than a rendered string: recording an expectation appends to the prediction ledger and nothing else, cannot cite an experience that does not exist, and is reported as standing on nothing until an outcome is recorded; a matched verdict changes no experience, no adaptation and no authorization and grants the model no permission it did not already lack; a contradicted verdict leaves every earlier record byte-identical; a second evaluation of one expectation is refused and rewrites nothing, and evaluating a superseded expectation records nothing; a replacement retires the earlier expectation without removing it and a withdrawal keeps the expectation and its reason; neither a matched nor a contradicted verdict moves an adaptation candidate, deriving again does not approve what it already derived, an unapproved candidate is never retrieved as a rule in effect, and only an explicit user decision makes a rule active) |
| 49. A goal and its plan are records, and a completed plan completes no goal | `goal-system.test.js` (10 tests: lifecycle and illegal transitions, normalized duplicates, dependency ordering, audit-backed evidence, reopening a completed goal, stopping reasons, model-origin denial, credential refusal, damaged-log truthfulness, append-only byte preservation); `executive-control.test.js` A, B, C, E (goal-linked plan runs and completes only the plan; an unavailable capability cannot be approved or started; a partial run reconciles without replay; contradicting evidence blocks goal completion without rewriting the plan) |
| 50. Executive authorization survives a hostile origin and a richer configuration | `executive-control.test.js` F (a model origin cannot create, approve, start, or reconcile a plan; a forged activation event is rejected by replay; activation re-checks the live registry, so an approval from a richer configuration does not carry over; approval is bound to exact content, and a write plan needs more than an approval) |
| 51. Executive context and recovery are bounded, labelled, and read-only | `executive-control.test.js` G (assertion classification; the executive prompt section is gated, capped at eight lines, labelled intent rather than evidence; a tight budget drops it and announces the loss; the real request path receives the recorded state), the recovery test (every store keeps its exact bytes), `executive-cli.test.js` (4 real CLI lifecycle tests), and `executive-interruption.test.js` D (a real child process killed inside a plan step is reported uncertain, never re-run, and reconcile blocks the plan at the user's explicit command) |
| 52. Integrated cognitive reasoning runs through the real request path and invents no evidence (AJ) | `cognition-understanding.test.js` (18 tests: intent and referent classification, evidence identity, claim labelling, contradiction symmetry, uncertainty categories, clarification before any model call, and the brief's bounded content); `cognition-reasoning.test.js` (24 tests: deliberation over supported, partial, conflicting historical and unknown evidence, inference and assumption kept distinct from support, recommendations, no confidence percentages, and deterministic trace steps); `cognition-scenarios.test.js` (15 end-to-end scenarios A-O through `controller.handle` with a capturing backend: grounded answer, unsupported question, contradiction, clarification, bounded retrieval, prompt size, trace, and audit; the backend is a stub, so no claim is made about a real model's behaviour) |
| 53. A user's own words reach a verified run, and nothing on that path grants itself permission (AK) | `executive-bridge.test.js` (21 tests: prepare → approve → run as three recorded acts on one audit chain; every preview field read from the stored plan and the live registry; the printed content hash is the stored hash and the approval records it; mapping takes only what it can carry and leaves the router's own answers, single-task questions and model-origin requests alone; status runs nothing and prints only states a record supports; a failed step is failed, an uncheckable one uncertain, never done; verified outcomes reach the existing learning path and nothing else does); `executive-acceptance.test.js` (the 25 numbered scenarios K-01…K-25, asserted against the persisted files: an empty portfolio reported as empty, the nine questions answered from the records, a failed run that stops its dependants and promises no retry, an uncertain step never replayed, an unapproved plan that cannot start and writes nothing, a plan that ran refused a second run, an unmappable request refused, an approval naming no plan asked about, a twin draft left a draft, a credential-carrying request not taken as an act, and the same lifecycle reachable from the CLI); `executive-adversarial.test.js` (11 tests J-01…J-11: a model that claims it ran and approved a plan changes no record, a non-identifier reference asks instead of approving, `approve and start` approves and stops, three persuasion prefixes leave the store byte-identical, a non-user origin cannot approve through the bridge, a stored instruction claiming authority authorizes nothing, an unregistered destructive capability records no plan, a plan cannot contain its own approval or its own start, and the action-claim correction is shown to the user without becoming model text). Every one uses a stub or no backend, so none is evidence about a real model |

Running one suite, which is what most review work needs:

```bash
cd apex_app
node --test tests/security-end-to-end.test.js
node --test tests/audit-secret-redaction.test.js tests/data-dir-isolation.test.js
node --test tests/model-self-authorization.test.js tests/prediction-adaptation-boundary.test.js
node --test tests/longitudinal-outcome-analysis.test.js
node --test tests/adaptation-effectiveness.test.js
node --test tests/adaptation-governance.test.js
node --test tests/cognition-understanding.test.js tests/cognition-reasoning.test.js \
  tests/cognition-scenarios.test.js
node --test tests/corruption-recovery-boundaries.test.js tests/lock-ownership-and-recovery.test.js \
  tests/append-audit-failure-semantics.test.js tests/cross-process-stress.test.js
node --test tests/executive-bridge.test.js tests/executive-acceptance.test.js \
  tests/executive-adversarial.test.js
```

The first two lines are the Batch AF security suites that run in-process plus spawn CLI children; the
third is the authorization-boundary pair, which is stub-backed and needs no endpoint; the fourth is the
cognition set, whose model-path scenarios use a capturing stub backend and so make no claim about a
real model; the fifth is the integrity set, and of those `tests/cross-process-stress.test.js` and
`tests/lock-ownership-and-recovery.test.js` spawn the most real processes and are the slowest and most
timing-sensitive - run them alone if a shared machine makes one flaky; the sixth is the Batch AK
executive bridge set, which builds every application with `NoBackend` and asserts against the
persisted plan, task, audit and memory files.

On Windows, redirect to a file rather than piping the runner into `grep` or `tee`: the test runner
writes as it goes and a closed pipe makes it fail with `EPIPE` for a reason that has nothing to do with
the code under test (`node --test tests/cli.test.js > run.txt 2>&1`). Concurrency and cross-process
suites spawn real `node` children and are timing-sensitive on a loaded machine; if one fails, re-run it
alone before attributing anything, and never judge a store or authorization change from a single run of
`npm test`.

What a green run does not mean: `npm test` runs no model, so a pass says nothing about model answers or
latency; the suites assert against temporary directories they create and remove, so a pass says nothing
about a store you already have; and a pass is not a security property - see
[Batch AF: what stops a credential, what survives damage, and what none of it claims](#batch-af-what-stops-a-credential-what-survives-damage-and-what-none-of-it-claims).

Other critical paths: store unavailable (`memory.test.js`, `cli.test.js` exit codes),
damaged data lines (`memory.test.js`), tampered content detection, configuration
validation (`gateway.test.js`), the verifier-independence check (`actions.test.js`), and
the adversarial phrasings a task follow-up is resolved from (`task-resolution.test.js`:
explicit and indirect references, ambiguous and false ones, approval and recovery
questions that must change nothing).

## Known limitations

- **Retrieval is lightweight lexical matching, not semantic search.** It matches words,
  simple word forms, and close misspellings (character-trigram similarity), all local.
  It does not understand meaning: a true paraphrase that shares no word forms with the
  stored record will be missed. Retrieval quality is not measured beyond these tests.
  Misspelling tolerance is bounded, not exhaustive: a query term is compared with a
  stored word only when the two share at least one trigram, because comparing every
  term with every stored word let a request at the controller's own 4,000-character
  limit take about 32 seconds against 1,000 memories. That request now completes in
  tens of milliseconds and a term that shares no trigram could not have reached the
  similarity threshold anyway, so results are unchanged (`growth-limits.test.js`).
- **Contradiction detection is deliberately narrow and heuristic.** It compares simple
  “subject is value” / “subject called value” clauses with the same normalized subject.
  It can miss paraphrases, negation, or complex temporal/contextual relationships, and
  different values may still be compatible in context. A longer value that merely
  elaborates the shorter one is not flagged. Warnings preserve claims; they do not
  determine which claim is true. Exact duplicate retrieval hits collapse to the newest
  matching record, while distinct contents remain separate. Conflict comparison is
  bounded by subject: each retrieved record's clause is parsed once and compared only
  with retrieved records that share its normalized subject, not with every other record.
  A broad query over a 3,000-record store fell from about 27 seconds to about 0.06
  seconds on the development machine (`growth-limits.test.js` guards against a return to
  all-pairs parsing). Retrieval still reads and scores the entire store, so its remaining
  cost grows linearly with the number of records. A claim supplied by the user and a
  model conclusion that disagree are both kept and both reported unresolved; provenance
  is preserved but never used to decide which claim is true. A record that fails its own
  integrity check (a bad content or triple hash, an unknown status, forged provenance)
  is counted as damage, not skipped: every read and write that needs the whole store
  fails closed, while a record addressed directly by id remains readable.
- **Correction resolves only its explicitly selected pair.** The new record links to the
  selected old record, which remains visible as `superseded` when no other conflict
  remains. Conflicts with any other claims stay unresolved; superseded history is not
  sent as an active fact in model context.
- **A recorded resolution is a decision, not a finding.** `knowledge resolve` records
  which claim a user chose to treat as the answer; it does not make that claim true and
  does not delete or rewrite the alternatives. It governs only the exact live conflict
  group it names, and it stops governing if that group's membership changes (a claim is
  added, retracted, or superseded) or a later decision for the same claims is recorded.
  There is no automatic conflict resolution, and nothing derived from model output can
  choose. An absent or ambiguous group is refused rather than guessed.
- **Health reports structural integrity, not truth, and not tamper evidence.** The
  three health commands parse stored records and report what that parse establishes.
  `memory health` cannot show a record is factually true; `knowledge health` cannot
  show a claim is true and treats a resolution as a decision; `audit health` is
  parse-only, because the append-only JSONL log has no hash chain, signature, or
  external anchor, so a clean parse does not prove the log is authentic or unedited.
  A store that is unavailable or partly corrupt yields an explicitly incomplete
  inspection. None of the three repairs anything or writes an audit record.
- **The world-state projection is bounded and re-reads everything it describes.** It
  represents at most 100 records per store (`MAX_WORLD_RECORD_LIMIT`), shows 20 beliefs
  (1-50 with `--limit`), and lists at most 8 members of a conflict group. A contradiction
  outside that window is real but unreported, so the projection states its own window in
  `Projection:` and refuses to call the picture complete when a store was not fully
  inspected. Memory contradictions are heuristic subject groups derived from the same
  clause patterns retrieval uses, not records the store marks as conflicting: the grouping
  can miss paraphrases and cannot tell whether two values are genuinely incompatible, and
  memory has no user-decision mechanism, so a memory group is always reported unresolved.
  Knowledge conflicts are read from the store's own conflict records. The audit record
  keeps ids, counts, and group membership only - never belief text.
- **What the model receives is a summary of that projection, not the projection.** The prompt view
  lists at most 3 disagreement groups, 4 explicit unknowns, and 3 members of a group, with each
  line truncated; when the context budget is tight it gives up its room line by line *before* any
  retrieved record does, and once no line is left it is replaced by one notice line saying it was
  omitted to stay within budget - but only while that notice itself still fits, so the notice can
  never be the reason a record that answers the question is dropped. It contributes counts, record
  ids and stated gaps only - no belief statement and no private wording - and it is derived on the
  model path alone: with no model configured, stored records are still shown directly and no
  projection is built, and if either store is absent the view is not produced at all, because it
  describes both together.
- **The temporal view describes recorded order, not causes.** `experience timeline`, `trends`,
  `patterns` and `compare` derive everything from the append-only experience log at read time;
  nothing is indexed, persisted, repaired, or approved. A window is at most 3,650 days and every
  query re-reads the whole log, so its cost still grows with the store rather than with the window
  (measured below). Events are ordered by `finishedAt`, then `requestedAt`, then `createdAt`; equal
  timestamps keep their append-only log order; a record with no usable timestamp is listed as
  undated and never placed in a window. A detected pattern is a description of the order in which
  outcomes were recorded - never a claim that one event caused another, never a prediction, and
  never an adaptation: no pattern can create or alter a behaviour rule, which still requires the
  user's corrective feedback and explicit approval. A damaged or unreadable log is reported as
  unavailable rather than as an empty history.
- **The model receives at most a six-line temporal summary, and only when the request asks about
  time.** Counts, window bounds, at most four capability groups and four named patterns, each line
  truncated, with a fixed statement that the summary is order rather than cause. It is offered only
  for a request whose words (or a represented capability name) are about time, outcomes, or
  recurring behaviour, so an ordinary request does not pay for it; it is derived on the model path
  alone, is dropped line by line before any retrieved record when the budget is tight, and its
  omission is stated rather than silent. It writes nothing and can never turn a pattern into a
  stored fact or a rule.
- **The prediction ledger records expectations; it does not predict.** `prediction record` stores what
  you said you expect, and `prediction evaluate` compares it with outcomes the experience log already
  holds. Nothing estimates a future outcome, and nothing evaluates on its own: a verdict exists only
  after the user runs the evaluation for that one expectation. No record carries a confidence,
  probability, or score in this build - `confidence` is the explicit `null` that says no value is
  available, a caller that supplies one is refused, and a number that appears in a stored line is
  reported as damage because no method here could have produced it. Calibration therefore has nothing
  to calibrate against, and a match rate is printed only over at least 20 recorded evaluations, always
  with its denominator named and every excluded kind counted. An expectation whose horizon has passed
  with no outcome evidence is **expired**, which is not a wrong prediction and never enters a rate.
  Capability scope is exact-name, so an expectation about a capability that is later renamed is not
  matched to the renamed records; and the ledger is append-only, so every aggregate read re-reads all
  of it. See [Batch AE](#batch-ae-prediction-ledger-hypothesis-lifecycle-and-outcome-evaluation-as-implemented).
- **An aggregate prediction read still costs one horizon slice per standing expectation, on top of one
  whole-file read of the experience log.** Batch AE-08 removed the repeated read itself: an aggregate
  projection now takes one snapshot of `experiences.jsonl` per operation and slices every horizon out
  of it, so 178 standing expectations cost one file read, hash, validation pass and lifecycle
  derivation instead of 178 (`prediction list` on a 200-record ledger over 1,000 events: 3,931.39 ms
  before, 1,449.04 ms after; the same read on 5,000 events: 4,661.22 ms before, 1,591.93 ms after).
  What remains is measured: about 7.8 ms per standing expectation for the window slice and pattern
  detection, and one whole-file read that grows with the log (8.80 ms at 100 events, 317.54 ms at
  5,000). No persisted index is added, and no horizon read is silently bounded, because a count that
  omits part of the log is a false number rather than a cheap one. The stated threshold for revisiting
  that is in [Batch AE - Measured](#batch-ae-prediction-ledger-hypothesis-lifecycle-and-outcome-evaluation-as-implemented).
- **A credential-shaped value that a command refused used to reach the audit log.** Batch AF-01
  reproduced the three cases this section reported as unrepaired - `experience record --subject`,
  `feedback record --guidance`, `adaptation approve --reason` - and Batch AF-02..AF-07 closed them
  at the one place every audit record passes through: `OperationLog.append` masks the whole record
  before it is written, recursively over values, field names and object keys, so a field no command
  declared cannot bypass it. The three cases are now tested end to end through the real CLI
  (`tests/audit-secret-redaction.test.js`), along with the task log, the readers that print an old
  log, and the disclosure that a log written before the mask still holds its values.
  What remains is a boundary, not a gap: the mask is a heuristic over patterns, redaction happens
  at the persistence and print boundaries rather than inside a caller that asked for the record,
  and **historical `operations.jsonl` lines are never rewritten** - `audit health` and `diagnose`
  report them as a finding. Treat `operations.jsonl` as containing what was typed until Batch AF,
  and delete the file only knowing that history is lost.
- **The user-only guarantee for `memory.add` is enforced in the registry, not in the store.**
  `KnowledgeStore`, `ExperienceStore` and `PredictionStore` each refuse a non-user origin inside the
  store, and `MemoryStore.correct()` does too, but `MemoryStore.add()` validates content, kind,
  sensitivity and provenance and then writes. Nothing currently reachable can drive it that way -
  `memory.add` declares `origins: [user]`, `authorize()` denies every other origin, a model plan is
  refused the action at `checkSteps()`, and `tests/security-end-to-end.test.js` measures the refusal
  against the store's bytes - but a future caller that reached the store directly would write a
  `user_fact` no user authorized. Stated here rather than changed silently, because the fix is a
  contract change to a store a dozen suites call without naming an origin. See
  [Authorization boundaries](#authorization-boundaries).
- **A green `npm test` is not a security property and not exactly-once execution.** The Batch AF
  suites are deterministic tests against temporary directories on one platform; they pin behaviour and
  disclosure wording, they run no model, and they do not constitute an audit. The consolidated
  statement of what is protected, what is disclosed and what remains unclaimed is
  [Batch AF: what stops a credential, what survives damage, and what none of it claims](#batch-af-what-stops-a-credential-what-survives-damage-and-what-none-of-it-claims).

- **Read cost grows with the whole store, not with the window.** Each read loads every
  record and runs the integrity scan before it takes its 100-record projection. Batch U
  removed duplicate reads and made an unchanged repeat read skip parsing, so at 20,000
  memories the projection build went from 270.4 ms (the previous read pattern, re-measured
  in the same process) to 57.1 ms warm - but a cold read still cost 253.5 ms and a read
  after a write 143.6 ms, so the cost is still proportional to the store. A persisted,
  incrementally maintained index was assessed again in Batch V against current measurements and
  rejected - it would still require reading and hashing every byte of the store, so it cannot deliver a
  read that does not grow with total records. See
  [V-07: the read path after the write changes](#v-07-the-read-path-after-the-write-changes).
- **Every write still re-reads the store it is about to append to, so write cost grows with the store -
  but it no longer re-parses it.** `KnowledgeStore.add` inspects the whole store before appending,
  because conflict and lifecycle state is deliberately computed store-wide and a damaged store must be
  refused rather than compared against an incomplete record set; `MemoryStore.add` does the same to
  refuse a damaged store. Batch V replaced the parse-and-validate half of that inspection with an
  incrementally maintained, hash-proven validated record state (`src/memory/jsonl-store.js`,
  `loadForAppend()`), which is why 1,000 appends onto 2,000 memories measured 27.0 s against the 44.4 s
  the same store took with that state disabled in the same run, and seeding 1,000 claims 15.9 s against
  24.2 s. What is left is real:
  every write reads and SHA-256s the entire file, so a write is **not** constant time, a freshly
  constructed instance still pays the whole-store derivation (and pays a small retention cost on top of
  it), and a CLI that performs one write per process pays that cold case. The full numbers, including
  the regression for the cold case, are in
  [Batch V: incremental write state](#batch-v-incremental-write-state-as-implemented). A batched write
  API is still not the fix and is not planned just to make a benchmark look better.
- **Coordinated writes are per store file, and a bounded wait ends in a refusal, not a queue.** The
  memory and knowledge write paths now take `memory.jsonl.lock` and `knowledge.jsonl.lock` around the
  whole read-decide-append section, so two processes can no longer each record a correction of the same
  target: one writes and the other is refused with `LOCKED` and reports that nothing was written. What
  that does not provide: a refused writer is not queued, so the caller decides whether to retry - a
  `LOCKED` refusal is always safe to retry because no bytes were written, while a `LOCK_LOST` result is
  **not**, because the record is already on disk; the two locks are independent, so a command that
  writes both stores does not hold them as one unit; and an operation spanning stores plus the audit
  record plus the conversation turn is still not a transaction. Whether a dead holder's claim can be
  taken over is judged from the recorded process number alone, exactly as for the task lock, so a
  recycled number makes the claim look live and both the write and `repair locks` refuse until an
  operator resolves it by hand. A coordinated write is still not constant time - it re-reads and hashes
  the whole store inside the section. The semantics, the timeout budget, the recovery limits and the
  measured overhead are in
  [Batch W: cross-process write coordination](#batch-w-cross-process-write-coordination-as-implemented).
- **The task lock serializes task changes, not every command.** `task plan`, `run`,
  `resume`, `approve`, `retry` and `cancel` take `tasks.jsonl.lock`; reads (`status`,
  `diagnose`, `task list/show/explain`, `history`) take no lock. Since Batch W the memory and
  knowledge write paths take a lock of their own and the audit and conversation logs stay
  single-line appends with no lock of their own. On the tested platform (Windows 11,
  NTFS), real concurrent processes appending to the same store kept every line intact,
  in per-writer order, and a reader polling during the writes never saw a partial line
  (`storage-concurrency.test.js`). An append now repeats a short write until the record
  is complete and fails rather than reporting a write that accepted no bytes. This is
  still not a multi-file transaction: an operation that spans stores (a step, its audit
  record, its conversation turn) can be partly recorded if the process dies between
  writes, and each record states only what it is. The session pointer is created
  exclusively, so concurrent first requests share one session instead of orphaning each
  other's turns; `apex new` still replaces it deliberately. The summary retry queue
  runs each update under its own lock file, so concurrent updates no longer lose an
  intent. A stale lock (task or queue) is taken over only when no process owns the
  recorded number, and the right to remove it is elected first with create-once token
  files: only the
  elected taker re-reads and removes the exact claim it validated, so a fresh lock
  another process created is never removed. A taker that loses the election is refused
  as "in use" and can retry. A process killed during a takeover leaves its token behind;
  the next epoch supersedes it instead of wedging the directory. Election is bounded at
  16 epochs per claim: if sixteen takeovers are recorded as abandoned in a row, the
  update is refused and the claim and tokens are left untouched for inspection
  (`lock-contention.test.js`, `storage-concurrency.test.js`). That bound is a deliberate
  refusal, not automatic cleanup, because deleting another process's token on an
  out-of-date observation could remove a live taker. Liveness is a check of the recorded
  process number, not of process identity: it answers only whether some process now owns
  that number. Windows returns freed process ids to the allocator immediately, so a dead
  holder's claim can look live after its number is reused. APEX treats such a claim as
  held and refuses both normal work and `repair locks`; it never deletes a claim because a
  pid "looks suspicious". That is the safe direction, but it leaves the directory blocked
  until an operator resolves it by hand: confirm that no APEX task run, queue update, memory
  write or knowledge write is in progress and that the number belongs to an unrelated process
  (`Get-Process -Id <pid>` on Windows, `ps -p <pid>` on POSIX), then remove
  `tasks.jsonl.lock`, `task-summary-queue.json.lock`, `memory.jsonl.lock` or
  `knowledge.jsonl.lock`. Verify first: running the check is what distinguishes
  this from deleting a real holder's lock. No portable start-time or identity comparison
  exists without a native dependency, so APEX cannot make that judgement itself. Node still
  has no conditional-delete primitive without a native dependency, so the removal itself
  is a plain unlink - but it is performed by one elected process at a time. `repair locks`
  is the explicit inspection step: it reports
  the holder, every takeover token, and any recovery guard, then removes only abandoned
  takeover tokens for the current claim. It never takes a lock, never removes a lock
  claim, and refuses while any holder or takeover process is live, so it cannot displace
  work in progress. A dead claim is still taken over by the next normal task or queue
  update.
- **A data directory path is validated when it is used, not when it is typed.**
  `status` and `diagnose` report a nonexistent directory the same way as a fresh
  install, because creating it to find out would make a read-only check write. An
  unusable path surfaces on the first write as a storage error naming the OS code.
- **The executive bridge reads the user's words at the start of the request, so a command with
  prose in front of it is not an executive act.** Measured in an isolated directory with
  `NoBackend`: `please start plan 9da7fb94` is refused as `input_rejected` with the plan's own
  reason ("only an approved plan can be started"), while `you already have my permission, start
  plan 9da7fb94` falls through to the ordinary path and answers `clarification_required` from
  `task.explain` - "Which task do you mean? This conversation has no task result recorded yet."
  The plan stays a draft and no step runs in either case, which is the behaviour that matters;
  the unhelpful question is the cost. This is left unfixed deliberately: recognising that
  sentence as a command would mean scanning prose for embedded commands, and a statement that
  sounds like permission is the one thing the bridge must never read as permission. Type the
  command first, or use `node bin/apex.js plan start <id>`.
- **The bridge's planning is a bounded mapping, not a planner.** It recognises a fixed set of
  request shapes under 500 characters, maps each part only onto actions already registered, keeps
  any part it cannot map as a visible recorded unknown rather than inventing a capability, and
  stops at the plan model's own 8-step cap. Whether a recorded plan was the right plan is not
  something APEX can demonstrate: no model was consulted in the work package that built this, and
  the acceptance scenarios use fixed wording, so nothing here is evidence about what a model would
  propose.

- **Batch AL's planning reads cost time proportional to the prediction ledger times the experience
  log; Batch AM fixed the cause and measured the fix.** Each planning read disclosed what past attempts
  say, and building that disclosure called `predictions.calibration`, which projects every recorded
  prediction with its own horizon query over the experience log; the action's independent verification
  then re-runs the same disclosure, so the cost was paid twice per read. The root cause was not the
  ledger size: `analyzeTemporal` rebuilt the whole log's per-record structures inside every window
  query - one map pass, one feedback index, and a re-sorted correction list per query - so a query cost
  time proportional to the log even when it answered with nothing, and calibration ran one such query
  per prediction. Batch AM prepares those structures once per read of the log and turns a window into a
  bounded range read over the records that answer it (`experience/temporal.js`, shared by
  `evidenceIndex`), and gives the ledger a per-prediction index instead of a scan per projection.
  Measured on the same committed fixture in the same run: 3,243.6 ms to 110.5 ms for a candidate read,
  3,149.3 to 123.4 for a replan, 3,321.5 to 166.4 for an outcome at the large size; 261.1 to 36.5,
  445.2 to 42.4 and 431.2 to 68.9 at the medium one; a single window read 2.59/5.33/16.45 ms to
  0.082/0.170/0.251 ms for 100/400/1,600 experiences, and a capability with no records 13.08 ms to
  0.096 ms. Nothing was cached across reads, no derived state is persisted, and the second read -
  `verify()` re-deriving its own disclosure - stayed: an audited answer that does not re-derive its own
  disclosure is the guarantee Batch AB exists to keep. `learning-read-equivalence.test.js` compares the
  optimized answer against a record-by-record reference for every window and capability, and against the
  pre-fix implementation's own output, so the speed is not a difference in what is reported. What is
  left: an unscoped window read (`capability: null`) is still super-linear - 1.375/34.0/551.8 ms at
  100/400/1,600 experiences, about twice better than before - because pattern detection legitimately
  receives the whole window's correction list; it is not on the calibration or planning path.
- **Batch AL's candidates are generated from a bounded strategy set, and its learning is disclosed,
  not applied.** Three strategies, capped at three drafts per goal; no learned weighting, no score, and
  no candidate invented from a capability the registry does not hold. Batch AM closed the blocker half
  of that sentence: a blocker or an unmet prerequisite the user recorded on the goal now gates -
  `plans/constraints.js` classifies each record, `constraints_satisfied` is a hard gate in the
  comparison, a confirmed blocker naming a capability is refused at generation, and approval and
  activation re-read the same records (`plan-constraints.test.js`). The learning half is closed too: an
  approved adaptation moves a ranking only where the user recorded a shape for it, and the record that
  did it is named (`plan-guidance.test.js`). Whether a recorded plan
  was the better plan is demonstrated only against the synthetic fixtures in `plan-scenarios.test.js`,
  with fixed wording and no model consulted, so nothing here is evidence about what a real model would
  propose.

## Knowledge System

The Knowledge System introduces a minimal, persistent, inspectable foundation for
explicit entity relationships, built alongside personal memory:

- **Entity relationship triples:** Each record stores an explicit triple:
  `subject --[relationship]--> object`, together with optional `evidence`,
  canonical hash (`tripleHash`), timestamp, and explicit provenance.
- **Write authority:** Knowledge writes (`knowledge add` / `knowledge.add`,
  `knowledge retract` / `knowledge.retract`, and `knowledge resolve` /
  `knowledge.resolve`) require explicit user origin. Model
  proposals cannot write, retract, or resolve knowledge, and none of these actions can
  appear in a model-generated plan.
- **Conflict handling:** When a new relationship contradicts an existing one (same
  subject and relationship, different object), the conflict is detected and both
  records are preserved and marked `conflicting`. Contradictions are never silently
  discarded or overwritten.
- **Explicit supersession:** A user can resolve a conflict by adding the replacement
  with `--supersedes <id>`. The named records must be live, must share the new
  record's subject and relationship, and must state a different object; unrelated or
  duplicate records are refused. Resolved records stay in the append-only log as
  historical entries, are reported as `superseded`, and no longer enter retrieval or
  count as live conflicts. Model output cannot set supersession; the write remains
  user-origin only.
- **Explicit retraction:** `knowledge retract <id> [--reason <text>]` marks an active
  claim as no longer active without supplying a replacement. It appends a lifecycle
  event (`kind: retraction`) naming the record, the optional reason, its timestamp,
  and user-origin provenance; the original claim line is never rewritten, moved, or
  deleted. Retraction refuses a missing or ambiguous id, an already superseded record,
  and an already retracted record, so one claim cannot enter two terminal states by
  this path. A retracted record leaves keyword retrieval and live conflict detection,
  stays visible in `list` and `show`, and cannot be superseded later. A fresh
  assertion of the same triple is a new record; it does not revive the old one.
  Retraction is user-origin only and cannot be planned or authorized from model
  output.
- **Explicit resolution of conflicting claims:** `knowledge resolve <target-id>
  --choose <claim-id> [--reason <text>]` records a user decision without claiming the
  chosen claim is true. The event names every claim in the live conflict group, the
  chosen claim, the optional reason, timestamp, and user-origin provenance; no claim
  is edited, merged, or deleted. It applies only when every named claim exists and is
  active, all share the same normalized subject and relationship with at least two
  distinct objects, and the live group is exactly the named set. The chosen claim must
  belong to that group. A missing, retracted, superseded, unrelated, or ambiguous
  target is refused, as is a choice outside the group. Resolution does not change a
  claim's status away from `conflicting`; instead, a `resolution` lifecycle event
  records that the conflict now has a user decision. All alternatives stay inspectable
  and `knowledge list`, `show`, `history`, and the model context label the decision as a
  decision, not verified truth. Resolving an already-resolved group with the identical
  decision is refused (nothing changes), while a different choice is a new event; the
  latest applicable decision for the same claim set governs, and earlier events remain
  in history. If the live group changes afterwards (a claim is added, retracted, or
  superseded), the earlier decision no longer governs and `knowledge health` counts the
  group as an unresolved conflict again until a new decision is recorded. Model output
  cannot resolve a conflict, and `knowledge.resolve` is never plannable.
- **Lifecycle history:** `knowledge history <id>` is a read-only view of what the
  stored records establish: the original claim and provenance, active/superseded/
  retracted/ambiguous state, the retraction event and reason, resolution events naming
  this claim, the records it replaced and the records that replaced it, and the bounded
  connected chain. It reports
  missing links, multiple successors, multiple retraction events, records that are
  both retracted and superseded, cycles, and truncation as explicit limitations; it
  never infers a missing link or claims the chain is complete when it is not. It
  calls no model and writes nothing.
- **Store-wide health:** `knowledge health` derives a bounded summary from the stored
  records at read time; there is no persisted copy that could go stale. The counting
  rules are explicit:
  - a retraction event is a lifecycle event and is never counted as a claim;
  - a supersession link is a property of a claim, so it never inflates the claim count;
  - every claim is in exactly one state: active, superseded, retracted, or ambiguous;
    a record that is both retracted and superseded, or has more than one retraction
    event, is ambiguous and is never counted as active;
  - a conflict group contains only active claims with the same normalized subject and
    relationship and at least two distinct objects; superseded and retracted records
    are not live conflicts;
  - a conflict group with a currently governing user resolution is reported separately
    as a resolved group: it is still counted among conflict groups and still holds
    claims in `conflicting` status, but it is not counted as attention. If the group's
    membership later changes, it returns to being an unresolved conflict;
  - lifecycle events (retractions and resolutions) are counted, never inflated into
    claim counts;
  - corrupt lines are counted separately and are never treated as valid historical
    records;
  - a supersession chain longer than the 20-record history view bound is reported as a
    view limit, not as damage.
  The command also reports detected anomalies: missing link targets, multiple
  successors, cycles, multiple retraction events, contradictory terminal states,
  stored `superseded` status without a successor, links across different subjects or
  relationships, links that state the same triple, retraction events whose target is
  absent, and resolution events that name a missing claim, name claims that do not
  form one live conflict group, or repeat a claim id or chosen object. A resolution
  that merely cannot govern the current store because a newer decision overruled it or
  because the group changed afterwards is ordinary history, not damage: it is reported
  as overruled or historical and the lifecycle view stays complete. If the log is
  corrupt or unreadable, every count covers readable records
  only and the summary says that completeness cannot be established. Health reporting
  is read-only: it never repairs, deletes, supersedes, retracts, or resolves anything,
  writes no audit record, and calls no model. It describes the integrity and lifecycle
  state of stored claims; it does not establish that any claim is true, and an
  incomplete inspection cannot guarantee that the rest of the store is healthy.
- **Memory health:** `memory health` reports the record count, kinds (user facts and
  model conclusions), private records, corrections and the claims they replaced,
  provenance/update-mode counts, corrupt-line count with bounded samples, and detected
  anomalies (duplicate ids, a record that replaces itself, a replacement target that
  does not exist, a claim replaced more than once). It never prints memory content or
  secret-like values, never calls a model, writes no audit record, and repairs
  nothing. A record proves only that it parsed and its stored content hash matches; it
  does not prove the content is true. It is a separate inspection from `knowledge
  health` and `audit health`: one damaged store does not change another's counts.
- **Audit health:** `audit health` reports the readable operation-record count, outcome
  counts, corrupt-line count with bounded samples, and structural anomalies (duplicate
  ids, missing or invalid `requestedAt`, invalid `finishedAt`). Its integrity statement
  is explicitly **parse-only**: `operations.jsonl` is append-only JSONL with no hash
  chain, signature, or external anchor, so a clean parse proves structure, not
  authenticity, and deliberate editing that leaves valid JSON is not detected. It
  prints no `request` or `output` body; it never calls a model, writes no audit record,
  and repairs nothing.
- **Healthy, empty, unavailable, and incomplete are different answers.** An empty
  store is healthy and reported as empty. An unreadable store (permissions, a
  directory where a file is expected, an I/O error) is reported as unavailable, never
  as empty. A store with corrupt lines is reported as damaged and its inspection as
  incomplete: counts cover readable records only, so an incomplete inspection cannot
  guarantee that the rest of the store is healthy. All three health commands exit 1
  for any of the latter conditions and change nothing.
- **Three different answers:** Supersession says "this claim was replaced by a newer
  conflicting claim"; retraction says "this claim is no longer active and no
  replacement is asserted"; explicit resolution says "the user decided to treat one
  claim as chosen, while every alternative is preserved"; independent verification says
  "the write APEX reports is the write the store actually holds". Verification and
  resolution are not claims that the content is true, and none of these changes the
  preserved original.
- **Bounded retrieval into model context:** When answering a request on the model path,
  the controller retrieves up to 3 relevant knowledge records by searching the triple
  and evidence. Question words and other low-signal words are ignored, so a question
  does not retrieve a record merely because both contain "what" or "is", and terms are
  weighted by how rare they are in the store, so a distinctive name outranks an
  incidental common word. Records below the relevance threshold stay out of the prompt.
  Injected
  records explicitly state their provenance (`user-supplied fact`
  or `unconfirmed claim`) and conflict status. An unresolved conflict says
  `[CONFLICTING: another record disagrees; treat as unresolved]`. A conflict with a user
  decision is labelled as such instead: the chosen claim says
  `[CONFLICT: user decision selected this claim; a recorded decision, not verified truth; other claims are preserved]`
  and each alternative says
  `[CONFLICT: user decision selected another claim; this claim remains stored as an alternative]`.
  The model still sees every alternative, and no label presents a decision as verified
  truth. `knowledge search` keeps its broad matching, because there you asked what
  matches.
- **Auditability:** Every write operation is recorded in `operations.jsonl` and
  independently verified against the store log.
- **Corrections are never inferred from `remember`.** Repeating `remember` records
  another user fact and leaves conflicting claims unresolved. Use the explicit
  `memory correct` command to select one conflicting record. Corrections are limited to
  one selected record per operation and to the detector's narrow clause patterns;
  previous records remain append-only and continue to be inspectable.
- **Corrupt JSONL logs fail closed and are never rewritten.** `status` and `diagnose`
  report the corrupt-line count and line numbers, and records are not deleted,
  skipped silently, or truncated to make a file parse. `diagnose` reports knowledge
  claims and lifecycle events as separate counts and states lifecycle consistency
  separately, so a valid historical record is not miscounted as damage. Memory, knowledge, and task
  reads and writes are refused while corrupt lines exist, so damage cannot be buried
  under a fresh write that would otherwise be reported as stored. Conversation replay
  is blocked and task state is refused; the audit log still lists its readable records
  and names the skipped lines. Audit damage is not proof of absence: when a step's
  operation record cannot be found and the log also holds damaged lines, `task explain`
  and task follow-ups say the absence could not be established instead of reporting that
  the step has no record. Repair is not automatic: no supported command deletes
  or rewrites a damaged line. A partial final line left by a crash is preserved as a
  damaged line, and the next append starts on a new line instead of merging into it.
  `diagnose` marks that last case explicitly - "final line without a newline: consistent
  with an interrupted append" - so trailing crash residue is distinguishable from
  damage in the middle of a file. The distinction is reporting only: the bytes are
  still preserved, and the store still fails closed until an operator resolves it.
- **A failed write is not proof that nothing was written.** If the bytes reached the
  file but the fsync did not complete, the record may already be readable; APEX says so
  in the error instead of implying the store is unchanged and never removes data to
  make the failure look clean. Callers should inspect the store before retrying.
- **A task step that ran is never reported as an execution that failed.** If the task
  log refuses the write that records a step result, the run reports which step had
  already returned which outcome and whether its own audit record was written, instead
  of calling it a failed execution. The step is not run again: the next `task run`
  resolves it from that audit record (or leaves it uncertain when no record matches),
  and nothing is repeated.
- **Answer quality depends entirely on the model you run.** APEX checks the protocol,
  not the truth of what a model says. Model answers are shown as unverified.
- **Routing is a fixed pattern table.** Requests outside the table go to the model
  path. Without a model they get `model_unavailable`.
- **Verification of `memory.search` / `memory.list`** re-reads the same store with
  the same code, so it catches inconsistency and tampering, not a shared bug in that
  store logic.
- **A model conclusion is never verified.** It is reported as `verification_unavailable`.
- **Concurrency:** append-only JSON Lines stores were exercised with real concurrent
  processes and kept every record intact (see Known limitations above and
  `storage-concurrency.test.js`). They are still not multi-file transactions: an
  operation spanning stores can be partly recorded if the process dies between
  writes, and a failed write may have landed. Task state changes are serialized by
  `tasks.jsonl.lock`; concurrent task runs are refused rather than queued.
- **Single-user, local only.** No authentication, encryption, or sync. Anyone with
  read access to the data directory can read the memory.
- **Audit content:** the `request` and model `output` fields contain your text. Memory-write
  payloads are not stored. Credential-like text is masked across the whole record before it is
  written - values, field names and object keys alike - so a credential carried in a command that
  was refused is stored as `[omitted: contained a password, key, or token]` rather than verbatim; a
  filtered `output` is marked `outputMinimized: true` and a mask anywhere marks `secretsMasked: true`,
  so the stored text is not mistaken for verbatim evidence. Detection is heuristic and the walk is
  bounded, so a differently formatted or deeply carried secret can still be stored, and the audit
  records written before Batch AF keep whatever they were given: `audit health` and `diagnose` report
  those as a finding rather than rewriting them. The audit
  records memory ids and prompt sizes, not the memory text sent to the model. A model's own
  answer is recorded as output, and it could repeat memory.
- **Conversation history** is replayed as summaries and text, limited to
  `APEX_CONTEXT_TURNS` turns. There is no summarisation of older history. If a turn
  cannot be saved, the answer is still shown with a notice that the exchange was not
  fully saved and a later turn may not see it.
- **Context size:** a request that exceeds the model's context window is reported as
  `CONTEXT_TOO_LARGE`; APEX does not know a model's window in advance.
- **Filesystem inspection is read-only and single-root.** One directory, no recursion,
  no follow-symlink, no globbing, no search. Symlinks are refused even when they point
  inside the root, which is stricter than necessary but easy to reason about.
- **Filesystem verification re-reads the same path with the same code.** It catches a
  changed file, a changed directory, a fabricated result, and a path that has escaped
  the root, but not a bug shared by both reads. A file that changes and changes back
  between the two reads is not detected.
- **Windows:** the full suite for this batch was run on Windows 11 with Node
  26.4.0, in an isolated temporary directory: 928 tests, 926 passed, 0 failed, 2
  skipped (POSIX permission bits are not enforced here; this filesystem rejects control
  characters in file names). The permission-denied path is therefore untested here, and
  earlier milestones were validated on Linux. The test script uses an explicit file
  list so it does not depend on shell globbing.
- **One test is load-sensitive.** At the start of this batch the baseline run reported a
  single failure in `lock-contention.test.js` ("real processes racing a stale lock"),
  which spawns several child processes and asserts a timing-dependent outcome. The test
  was not weakened: the same file passed 13/13 in three separate isolated re-runs and
  passed inside the final full-suite run above. Under a concurrently busy machine it can
  still be the first thing to fail, so treat a failure there as a result to re-run and
  investigate, not as permission to relax the assertion.
- Node 22 is the documented runtime; Node 26.4.0 was used for the runs above.

## World state: the read-only epistemic projection

`src/world/world-state.js` implements the first cognitive capability that goes beyond
"answer a prompt": APEX can describe, on demand and without a model, what it currently
holds as belief, who recorded it, what contradicts what, which contradictions a user has
decided, and what it cannot establish.

```
node bin/apex.js world
node bin/apex.js world --limit 5
node bin/apex.js ask "what conflicts do you have"
```

### What it is

A projection, computed at read time from the two persistent stores. It owns no state and
introduces no new file or schema: `memory.jsonl` and `knowledge.jsonl` remain the only
authoritative records, and nothing is written, repaired, or reinterpreted by a read.

The output separates four things that a normal assistant tends to blend together:

- **User-asserted beliefs** - records whose provenance says a user asked for them to be
  stored, plus active knowledge triples.
- **Unverified model conclusions** - `model_conclusion` memory records and claims stored
  from a model proposal. They are listed in their own section and are never merged into
  the user-asserted list. A stored model conclusion is evidence that the user approved
  keeping it, not evidence that it is true.
- **Contradictions** - live knowledge conflict groups (unresolved, or resolved by a
  recorded user decision), plus heuristic memory groups where the same subject is asserted
  with different values. A resolution reads as "a decision, not verified truth".
- **Unknowns** - unresolved groups with no decision, claims with no recorded evidence,
  model conclusions that nothing verified, a store that is unavailable or damaged, and
  what the bounded projection window left out.

### Guarantees and boundaries

- The action `world.state` accepts **user origin only**. It is not in the model's list of
  readable actions, so a model cannot ask for a projection that may surface private
  memory. A model-origin request is denied before anything runs.
- The same projection is derived automatically for every model-path answer, but only as a
  **bounded, counts-only view**: disagreement groups by record id and count, explicit
  unknowns by the gap they state, retired records as history counts, and private memory
  contributing neither content nor statement. That view is built by the system, not
  requested by the model, and it does not widen what the model may read: `world.state`
  stays user-origin only, and the full read that names private wording stays in the
  terminal.
- Private memory appears in the user's own read, explicitly marked
  `[private: never sent to a model]`, and never enters a prompt.
- The audited result of a routed `world.state` operation holds counts, record ids, and
  bounded group membership. No belief statement or memory content is copied into the audit
  record or into conversation history; the full display exists only in the terminal output.
- Independent verification re-reads both stores and compares the derived shape. If the
  stores changed between the two reads, the operation reports the mismatch instead of
  claiming a verified read.
- An unavailable or damaged store makes the projection **incomplete**, not empty: the read
  reports which store could not be inspected, keeps representing the store that can be
  read, and exits 1. `world` never reports success for a partial inspection.

### What it does not do

- The `world` command **is not the World Model.** It re-reads memory and knowledge records that
  already exist. The [World Model](#batch-ai-world-model-entity-memory-and-evidence-graph-as-implemented)
  is a separate append-only store in `world-model.jsonl` that records the entities, facts,
  relationships, events, and evidence the user asserts; `world` neither reads nor writes it.
- It resolves nothing, chooses nothing, and converts no inference into a fact.
- Memory contradiction detection is the same narrow heuristic the memory store already uses
  ("subject is/are value" clauses), so it can miss contradictions and can group records a
  user considers compatible. It is labelled as heuristic in the output.
- At most the most recent 100 records per store are represented; the rest are counted and
  announced as outside the window. At most 50 beliefs, 5 contradiction groups, 8 listed
  members per group, and 8 unknowns are shown.
- Records never written to memory or knowledge are invisible to it.

### How the read path is made fast, and what that does not buy

Batch U measured the projection's read path before changing it, and found two costs, not one:
a projection performed **four** whole-file read-parse-validate passes (`memory.health()` +
`memory.list()` + `knowledge.health()` + `knowledge.list()`, so an executed-and-verified read
performed eight), and each pass parsed every line and recomputed each record's SHA-256. Both
stores were therefore read twice per projection from two different moments of the same file.

Only two interventions were made, both inside the existing architecture:

- **One authoritative read per store per projection.** `projectionRead()` on each store
  returns the store-wide integrity summary and the bounded record window from one snapshot of
  one file. A projection can no longer combine a summary of one file state with records from
  another. This is also a correctness improvement, and it is what most of the saving came from.
- **An optional derived parse snapshot, owned by `JsonlStore`.** It is per store instance,
  per process, in memory only, and holds the parsed and validated records of **one exact byte
  sequence**, keyed by the SHA-256 of those bytes.

What the snapshot guarantees, and what it is never allowed to become:

- It is a performance aid, not a source of truth. Nothing is persisted, no new file or schema
  exists, and no other component reads it. It is dropped implicitly the moment the bytes
  differ: an append, a truncation, a same-length rewrite, a replaced file, or a file written
  by another process all miss it and are parsed and validated again by the same rules.
- Every read still reads the file from disk. A hit skips parsing, not I/O, and hands out
  freshly copied records, so a caller cannot mutate the snapshot.
- There is one parser. Cached and uncached reads get their records and their damage from the
  same function, so a hit cannot apply weaker integrity rules than a cold read. A store with
  corrupt lines reports them again on the next read; a healthy earlier read cannot mask them.
- Neither read around one of this instance's own appends reads or writes *this* snapshot. The read a
  write performs to inspect the store is served by the separate incremental validated state Batch V
  added ([Batch V: incremental write state](#batch-v-incremental-write-state-as-implemented)); it
  consults neither structure and is accounted in `appendStateStats`, never in `parseCacheStats`, so each
  read of a process is charged exactly once. The read immediately after an append still skips the
  snapshot, because the bytes just changed. When Batch U made this rule, both of those reads still
  parsed and validated the file as it actually is and the saving was dropping a hash and a copy of every
  record on bytes about to be superseded; Batch V removed the whole-store parse and validation from the
  first of them as well. The write path still refuses a damaged store and still sees a record another
  process added, because the state it reuses is proven against the file's own bytes rather than assumed.
  Without this rule the snapshot made every write slower than it was before Batch U, by an amount that
  grew with the store.
- No store that does not opt in is affected: tasks, conversation turns, and the audit log keep
  `parseCacheBytes: 0` and behave exactly as before.
- Independent verification is untouched: `verify` performs its own read of both stores and
  rebuilds the projection instead of comparing a cached object with itself, and it is measured
  separately rather than folded into the read number.

What it does not buy: a cold read and the read that follows a write still parse and validate
the whole store, so **read cost is still not independent of total store size**. A warm read
remains proportional to the store too, because the snapshot hands out a copy of every record
even though the projection represents at most 100. The snapshot also retains a second copy of
a cached store's records in process memory, bounded by 32 MiB per store. Constant-time reads
would need a persisted, incrementally maintained index - a storage redesign this batch
deliberately did not attempt, and which Batch V re-measured and rejected for the same reason
(see [V-07](#v-07-the-read-path-after-the-write-changes)). Batch V did remove
whole-store parsing from the write path, which is a different structure serving different reads;
a write still reads and hashes the whole file.

### Benchmarks

`benchmarks/run-world-state-benchmark.mjs` measures the read path with synthetic fixtures
in a temporary directory. It runs no model, downloads nothing, and verifies that repeated
reads leave every store file byte-identical. It is not part of `npm test`. Batch V extended the same
script rather than adding a framework: `--writes` measures the write path (the parts of one append at
each store size, the derived-state operations on the same fixtures, cumulative append workloads run
twice on one seed with the incremental state on and off, the store-layer work timed inside a single
public write, and the cost of a write refused by a damaged store) and `--full` adds the 1,000-append
workloads. See `benchmarks/README.md` for the invocation, the columns, and the interpretation limits.

`benchmarks/run-cognition-benchmark.mjs` measures the Batch AJ layer with no model and no endpoint: the
cognition stage timings at three memory/knowledge sizes, the grounding brief's contribution to a real
prompt at a fixed budget, and the structured-response validator against accepted, invented-citation and
malformed replies. Its measured values are in
[Batch AJ](#batch-aj-integrated-cognitive-reasoning-deliberation-and-grounded-responses-as-implemented)
and its invocation in `benchmarks/README.md`.

Observed on one Windows 11 machine (Node 26.4.0, 12 logical CPUs, 24 GiB reported memory,
warm page cache, one 100-record window of memory sharing a single clause subject). The four
"current" columns come from **one run per fixture, in one process, 7 timed samples**, so they
are comparable to each other; the model is not involved and `npm test` does not run this. That
run is the one whose write overhead is described below: the rule that removed that overhead
changes only the two reads a write performs around its own append, not these unchanged-store
read phases, and the whole matrix was re-run after the change (reported below).

| Fixture | Batch T read pattern, re-run in the same process | one authoritative read per store, snapshot off | warm repeat read | first read of a fresh process (cold) | `execute` + `verify` | RSS after reads |
|---|---|---|---|---|---|---|
| 200 + 200 | 10.4 ms | 5.7 ms | 5.0 ms | 26.6 ms | 8.3 ms | 57 MiB |
| 2,000 + 2,000 | 66.7 ms | 38.1 ms | 22.4 ms | 80.4 ms | 47.0 ms | 158 MiB |
| 20,000 + 2,000 | 270.4 ms | 142.5 ms | 57.1 ms | 253.5 ms | 102.5 ms | 276 MiB |
| 40,000 + 2,000 | 507.6 ms | 288.9 ms | 100.6 ms | 395.6 ms | 179.1 ms | 267 MiB |

Against Batch T's own recorded figures (projection build 10.8 / 141.6 / 545.5 ms and
`execute` + `verify` 20.4 / 275.6 / 1212.2 ms at 200 / 2,000 / 20,000) the executed-and-verified
read at 20,000 memories went from 1212.2 ms to 102.5 ms. Those two numbers were not measured
side by side, and re-running the old strategy inside the later processes cost 270.4 ms rather
than the 545.5 ms Batch T recorded, so Batch T's table was taken while the machine was busier:
**the trustworthy comparison is column-by-column within one run** - 4.7x faster at 20,000
memories and 5.0x at 40,000, warm, with the projection byte-identical apart from its timestamp
in every case. Repeating all four fixtures later the same day, after the write-path rule below
and with other work on the machine, gave 10.1 / 142.4 / 583.4 / 1010.3 ms for the old pattern and
4.3 / 40.5 / 100.9 / 188.4 ms warm - every absolute value larger, and the warm-vs-old-pattern
factor **larger rather than smaller** (2.4x / 3.5x / 5.8x / 5.4x against the table's 2.1x / 3.0x /
4.7x / 5.0x), because load multiplies the pass that re-reads the same files four times. Absolute
milliseconds here move by up to 2x with system load; the direction of the comparison held in both
runs, and under load the measured saving was larger, not smaller.

The cost the snapshot adds to writes is measured rather than assumed. In the first matrix every
memory `add()` with the snapshot enabled cost 11.9 ms more at 20,000 records and 54.7 ms more at
40,000 than the same write with it disabled, because the read a write performs in order to
inspect the store hashed and copied the whole file for bytes it was about to change. Making that
read declare that an append follows removed it: the same A/B then measured -11.7 ms and -8.3 ms,
i.e. no detectable overhead, and `KnowledgeStore.add` -17.7 ms and -2.6 ms.

Cost grows with total records all the same: a cold read and the read after a write still load,
parse and integrity-scan both stores before taking the fixed 100-record window, and even a warm
read copies every record it holds. The rendered projection stayed near 3.5 KB at every size.

Fixture generation itself is a separate, honest finding and is reported as a write cost, not a
read cost: appending 2,000 claims one at a time through `KnowledgeStore.add` took 26.0 s in one
run and 56.5 s in another on the same fixture (Batch T recorded about 59 s), because every
append re-reads the whole store. That seeding still costs 59.3 s in the current read-mode run
because `writeKnowledgeFixture` deliberately constructs its store with `parseCacheBytes: 0`, which
switches off both derived structures - the read snapshot, to keep the read phases clean, and with it
the incremental write state Batch V added. So this number is the pre-Batch-V cost kept for
comparability, not what a seeding process pays today: with one live store instance and the derived
state enabled, the same kind of workload measured 15.9 s against 24.2 s in the write-path run. The
write-path behaviour and its remaining limits are documented in
[Batch V: incremental write state](#batch-v-incremental-write-state-as-implemented) and under
[Known limitations](#known-limitations).

**Batch X: the cost of reading the projection for the model.** Batch X put a bounded, counts-only
view of this projection into every model-path prompt, so the cost was measured before and after the
change, on one machine (Windows 11, Node 26.4.0, 12 logical CPUs, 24 GiB), in three sequential
rounds and never overlapped. "Before" is a copy of `apex_app` restored from commit `d9cd504`, the
commit that predates Batch X; "after" is the working tree. Both ran the same probe against the same
seeded fixture (154 memory records, 58,532 B; 125 knowledge claims, 53,112 B; 40 unresolved
disagreement groups, 9 memory groups carrying different values, 5 explicit unknowns), with one cold
and 25 warm model requests plus 20 `calc` and 10 `status` requests per round. The "model" is an
in-process test double that records the prompt and resolves immediately, so the figures are APEX's
own context assembly, store reads, writes and verification - not inference, and nothing here
demonstrates real model reasoning.

| Measure (median of the three rounds) | before | after |
|---|---|---|
| memory store reads per model request | 1.77 | 2.77 |
| knowledge store reads per model request | 1.00 | 2.00 |
| parse-snapshot hits / misses over the run (memory) | 45 / 1 | 71 / 1 |
| parse-snapshot hits / misses over the run (knowledge) | 25 / 1 | 51 / 1 |
| warm model request | 69.0 ms | 84.5 ms |
| cold model request (fresh process) | 168.6 ms | 209.6 ms |
| warm `calc` request | 49.5 ms | 48.4 ms |
| prompt for the fixture query | 644 chars | 2,368 chars |

Each added read is one more read-and-hash of a file the request already read, and the parse behind
it is served by the existing derived snapshot: the added reads produced 26 more snapshot hits on
each store and **no additional miss**, so no second whole-store parse was introduced, and no index
or cache was added because the measurement showed none was needed. Warm latency rose by roughly
11-16 ms on this fixture, which is the projection build itself (13.4-16.4 ms called directly, 100
times, on the same stores); cold rose by roughly 40 ms, dominated by the first parse of both files.
The deterministic path is unchanged: `calc` and `status` performed zero projection reads and
recorded `prompt: null` in both builds, and their medians moved inside the noise.

Context size grew by the projection block only - 1,722 chars for 12 lines at its **bounded
maximum** (3 disagreement groups, 4 explicit unknowns, the counts and completeness lines; an
estimate of roughly 430 tokens at four characters per token), against a 6,000-character budget, and
**0 chars** for a store with nothing to disclose. The block gives up its room line by line before
any retrieved record does, so the records that answer the question are shed last. Measured on the
context-budget fixture (12 retrieved records, a 7-line summary), in a fresh process and a fresh copy
of the stores per budget: 2,000 chars keeps 4 summary lines and all 12 records, 1,700 keeps 2 lines
and all 12, 1,600 keeps the leading counts line alone and all 12, 1,500 replaces the whole summary
with its one-line omission notice and still keeps all 12, 1,400 carries neither block nor notice and
keeps all 12 - and only at 1,200 does a record go, one at a time after that as the budget tightens
further.
Shedding records first was tried against this fixture and displaced the user's own fact in an
existing budget case (the knowledge-suite prompt-budget test), which is the regression the current
order fixes.

These are single-machine figures with the same caveat as every table above: absolute milliseconds
move with system load, so the round-by-round spread (before warm 67.6-80.0 ms, after 80.1-86.2 ms)
is smaller than the difference it should be read against. The fixture is deliberately a stress case
for disclosure - 40 conflict groups is far more disagreement than a normal store holds - so the size
figure is a ceiling, not a typical request. The probe itself was a temporary script outside the
repository and is not part of `npm test`.

**Batch AI: the persistent World Model.** `benchmarks/run-world-model-benchmark.mjs --repeats 3`
measures the World Model store with synthetic logs that the store's own validator accepted while
the fixture was produced. It runs no model, downloads nothing, and is not part of `npm test`. It
has five phases: `reads` (nine read paths at 100, 250, 500, 1,000, and 2,000 entities), `analysis`
(related, conflicts, identity candidates, history, changes, prior-belief state, and context
assembly), `writes` (append, lock, entity, fact, relationship, event, retraction, and the same
operations through the action layer), `contention` (1, 2, and 4 real child processes writing
through the store), and `context` (what the prompt section adds and which requests pay).

Measured on one Windows 11 machine (Node v24.18.0, 12 logical CPUs, warm page cache), three
repeats per cell, medians in milliseconds. Each read is one call on a fresh store instance, so it
pays the whole load, validation, and reduction a real reader pays.

| Entities | Record lines | Bytes | load | status | list | show | find | facts | attributes | relationships | events |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 562 | 249,430 | 14.4 | 15.0 | 12.8 | 15.4 | 12.1 | 12.8 | 13.7 | 14.2 | 13.4 |
| 250 | 1,406 | 624,309 | 33.0 | 31.0 | 30.5 | 32.1 | 27.4 | 32.3 | 31.6 | 31.8 | 32.4 |
| 500 | 2,810 | 1,247,992 | 56.1 | 64.6 | 59.5 | 69.2 | 58.1 | 62.3 | 61.3 | 71.3 | 65.6 |
| 1,000 | 5,619 | 2,495,785 | 212.7 | 241.0 | 203.5 | 242.4 | 210.9 | 236.1 | 227.0 | 228.7 | 240.2 |
| 2,000 | 11,239 | 4,993,059 | 436.6 | 481.2 | 420.7 | 502.1 | 428.4 | 468.6 | 477.2 | 462.5 | 496.7 |

| Entities | related | conflicts | identity | history | changes | state-at | context build |
|---|---|---|---|---|---|---|---|
| 100 | 23.5 | 23.7 | 30.9 | 26.7 | 32.2 | 29.1 | 6.0 |
| 250 | 51.9 | 53.4 | 66.7 | 54.7 | 69.5 | 63.7 | 7.6 |
| 500 | 100.3 | 102.1 | 129.9 | 112.4 | 143.3 | 127.9 | 20.9 |
| 1,000 | 228.3 | 243.3 | 255.1 | 229.5 | 313.9 | 279.3 | 27.4 |
| 2,000 | 440.3 | 451.6 | 504.9 | 427.9 | 577.6 | 532.7 | 65.3 |

Writes at 1,000 entities (5,619 lines; median / min / max ms):

| Operation | Median | Min | Max |
|---|---|---|---|
| append (store layer) | 18.1 | 13.5 | 30.2 |
| lock acquisition | 25.0 | 24.7 | 27.4 |
| create entity | 337.2 | 316.5 | 385.5 |
| assert fact | 342.2 | 333.8 | 355.3 |
| assert relationship | 356.9 | 346.7 | 392.0 |
| record event | 338.0 | 324.0 | 377.8 |
| retract statement | 341.1 | 340.1 | 349.2 |
| create entity (action layer) | 563.2 | 555.2 | 613.9 |
| assert fact (action layer) | 600.5 | 591.6 | 604.2 |

A public write re-reads and revalidates the whole log inside the lock, which is why a one-line
append costs hundreds of milliseconds at this size: the cost is the integrity check and the
reduction, not the append. Several writers on one log stay correct: with 1 / 2 / 4 real child
processes the benchmark accepted 3/3, 6/6, and 12/12 writes in 0.54 s, 0.92 s, and 1.82 s
respectively, created exactly as many new entities as accepted attempts on every row, and left 0
refusals, 0 corrupt lines, and 0 lock residue.

The context section is bounded independently of log size: a named entity produced 9 lines and
1,163 characters (13 further entries omitted by the local budget), an overview request 8 lines and
615 characters naming 33 disagreement groups, and an unrelated request 0 lines. On the benchmark's
6,000-character prompt budget the named section adds 1,632 characters (27.2%); the overview form
adds 1,084 characters on its base, and the unavailable notice adds 171. `store.state()` on the
2,000-entity fixture took 223.6 ms median (220.4-232.9), and `buildWorldModelContext` on the
already-reduced state 24.5 ms - the section itself performs no store read.

**Decision: no derived index was added.** Read cost grows roughly linearly with record count, and
a write pays the same whole-log validation and reduction by design. An index built from the same
records could remove part of the read reduction, but it would not remove the validation that
makes a write safe, and it would introduce a second structure that can disagree with the log - the
failure this store's design avoids. At the measured scale (2,000 entities and 11,239 records:
about 0.42-0.50 s per read and 0.34-0.60 s per write) that trade was not justified. If a workload
grows well beyond this, the decision should be revisited with measurements on that workload, not
with a guess.

## Authoritative state and derived state

Batch V changes how fast the stores are written, so it needs a written line between the data
and any aid built from that data. This is that line. It was written before the implementation and
each item states whether the structure is **in place** or **not implemented**; the Batch V section
below records what was actually built against it, and what the measurements decided.

### Authoritative state

Everything that decides what APEX believes, and nothing here is reconstructible from anything
else in this list:

- The append-only `memory.jsonl` and `knowledge.jsonl` records, in file order. A record's bytes
  are the record; there is no other copy of it.
- Provenance and evidence inside those records (`origin`, `updateMode`, `operationId`, `context`,
  `replaces`, `supersedes` references, `evidence`).
- Lifecycle events, which are records too: knowledge retraction events and resolution events.
  They are appended, never rewritten, and they are the only account of what the user decided.
- The record hashes (`contentSha256`, `tripleHash`) and the schema validation rules that recompute
  them on every read.
- The other append-only stores with their own contracts: tasks, operations, conversation turns,
  and the audit log.
- Authorization and verification evidence produced by the ECP pipeline.

### Derived state

Anything a reader can rebuild from the authoritative records by applying published rules. It may
be a performance aid or an index; it is never evidence:

- The per-instance parse snapshot in `JsonlStore` - the parsed and validated records of one exact
  byte sequence, keyed by their SHA-256. **In place.** It serves reads.
- Incremental validated state used by a write, so an ordinary append does not re-parse and
  re-validate the whole store. **In place** (Batch V); see *Batch V: incremental write state* below.
- Knowledge groupings and indexes: the conflict index keyed by subject and relationship, the
  supersession map, the resolution applicability index, the lifecycle split into claims and
  events. All are rebuilt from the record list on every read and every write. An incrementally
  maintained version is **not implemented**: measured, see V-06 below.
- Memory groupings: the replacement map (`replacedBy`), the record status it implies, and the
  heuristic clause-subject conflict groups. Same rule - derived from the read window, never
  stored, and likewise not indexed.
- The world-state projection itself: a bounded, read-only view of the two stores, rebuilt from
  disk on every read and verified by an independent read.

**The governing rule.** Derived state must never be the reason a claim is reported as true,
authorized, verified, complete, or healthy. Every one of those decisions is taken from records that
were parsed and validated from the file's own bytes in the current operation. A derived structure
may decide *where to look* and *what not to rebuild*; it may not decide *what is the case*. In
particular a model-originated value can never write, refresh, or repair derived state: only a
user-origin operation can cause a write, and derived state changes only as a consequence of a
write that already happened.

### The guarantees an incremental structure must satisfy

These are the conditions Batch V may not trade away for speed. Each is testable, and V-08 tests
them.

1. **Update after an append.** Derived state advances only after the append has been reported
   written, and only with the bytes that append actually wrote. The order is: read → validate →
   build the record → append → fsync → advance derived state. Nothing before the fsync may leave
   derived state ahead of the file.
2. **Failed, partial, or interrupted writes.** A write that throws - refused validation, a refused
   damaged store, an identifier collision, a partial write, an fsync that did not confirm - leaves
   derived state untouched or, where the bytes may have changed, invalidates it. An invalidated
   structure is not an error: the next read re-parses and re-validates and rebuilds it. A derived
   structure can only ever be *behind* the file, never ahead of it.
3. **Process restarts.** Derived state is per process and per store instance. A restart rebuilds
   it from the file. Nothing is persisted into a new file, so there is no on-disk structure that
   can outlive the records it describes and no migration or version to get wrong. (This is why
   Batch V did not add a persistent index: see the read-path section.)
4. **External writes.** The bytes on disk are re-read on every operation, and the structure
   carries the SHA-256 of the exact byte sequence it was built from. A byte-for-byte identical
   file is the only input that may reuse it. An append by another process, a truncation, a
   same-length rewrite, or a replaced file all fail that test and are parsed and validated again
   by the same rules - so an external change can never be answered from stale derived state.
5. **Concurrent writers.** Batch W put a per-store claim around the whole read-derive-append
   section (`src/memory/writer-lock.js`), so the memory and knowledge public write paths are
   coordinated across processes the way the task and queue stores already were; concurrent appends
   stay line-safe on their own too - `JsonlStore` writes one complete line, fsyncs it, and repairs an
   unterminated tail. A writer that cannot prove a claim is its own is refused instead of deciding
   from a view it cannot verify. Derived state is still not what makes this safe: it is invalidated
   by any byte change, so a write that finds foreign bytes under its own claim re-derives the whole
   store before it decides. What remains true is that coordination is per store file, reads take no
   lock, and an operation that spans two stores is not a transaction.
6. **Corruption and incomplete history.** A derived structure built from a store that contains
   corrupt lines, an unterminated tail, an unresolvable supersession reference, or a lifecycle
   event pointing at a missing claim must not report a complete or healthy state. Damage found on
   a validated read invalidates the structure; the refusal to write or to claim health comes from
   the re-validated records, not from the structure's own confidence. A structure that cannot be
   validated against the current bytes is dropped, not repaired by guesswork.
7. **Invalidation and rebuild.** Mismatch, damage, a store larger than the cap, or a write that
   failed at an unknown point → discard and rebuild from a full validated read. Rebuild is the
   ordinary cold read, it is bounded by the same caps as the structure it replaces, and it is the
   only path that can repopulate. There is no partial repair, no merge, and no "trust the index
   because it was written by us".

[Known limitations](#known-limitations), the read-path section above, and
`benchmarks/README.md` state what Batch V actually achieved against this contract, with the
measurements.

## Batch V: incremental write state (as implemented)

Batch V aimed at the write path, which V-02 measured as the store's real scaling problem: every
ordinary append re-read, re-parsed and re-validated the whole file before appending, so the *n*th
write cost what the whole store costs and seeding a store through the public API was O(n²).

**What was built.** `JsonlStore` owns one more derived structure, per instance and in memory only: the
**incrementally maintained validated records** behind the read a write performs (`loadForAppend()`),
alongside the existing read snapshot (`load()`). It holds the parsed and validated record list of one
exact byte sequence, the SHA-256 of that sequence, and the live hash state that sequence produced. The
rules it had to satisfy are in [Authoritative state and derived state](#authoritative-state-and-derived-state);
what the implementation does:

- A write read is a **reuse** only on proof: the file's bytes must hash to the key of the sequence the
  retained records were validated from, at a matching byte length. One hashing pass per write read
  yields both the digest that proves the reuse and the live state the next append advances.
- Anything else is a **re-derivation**: the whole file is parsed and validated by the same
  `parseLines()` and the same `validateRecord()` rules a cold read uses, and the state is rebuilt from
  that result. No partial repair, no merge, no "trust the state because we wrote it".
- The state advances only after a confirmed append: `append()` fsyncs, and only then adds the record it
  just wrote to the retained list and rolls the key forward over the exact bytes written. A write that
  throws, accepted no bytes, wrote a partial line, raced another process's bytes, or produced a record
  that fails the current integrity rules drops the state instead of advancing it, so derived state can
  be behind the file but never ahead of it.
- A store with corrupt lines retains nothing. Damage found on a re-derivation clears the state, so no
  retained record list ever represents a damaged file, and the corrupt lines the parser reports reach
  the caller unchanged. The refusal itself is unchanged: both stores read `corrupt` from this same call
  and refuse on it.
- Records are handed out deep-frozen, in a fresh array per call, so a caller cannot turn a shared
  record into something else. Nothing is persisted - no new file, no schema change, no version, no
  on-disk structure that could outlive the records it describes.
- Retention is bounded by the same 32 MiB cap as the read snapshot, and the cap is consulted *before*
  anything is compared, so a store this instance grew from empty cannot track more bytes than the cap.
  A store over the cap re-derives every write read, which is exactly the pre-Batch-V behaviour.
  `parseCacheBytes: 0` (tasks, conversation turns, the audit log) tracks nothing and is untouched.

**What it costs.** Retaining validated records means deep-freezing them and keeping a live hash state,
and a freshly constructed instance pays that on its first write read *before* receiving any benefit.
Measured as the write read a fresh instance performs minus the validated read it replaced (run 4, 7
samples): **+4.04 ms at 2,000 memory records, +23.14 ms at 40,000, +6.43 ms at 2,000 knowledge
claims**, and -1.64 ms at 200 claims (fsync noise at that size, not a saving). Every write after the
first is cheaper by the whole cost of parsing and validating the store again.

**What it buys**, measured in one run under matching conditions - the same store class with the derived
write state enabled and with `parseCacheBytes: 0`, which is what a write cost before Batch V:

| Cumulative workload (one live store instance) | incremental | revalidate (pre-Batch-V behaviour) | ratio |
|---|---|---|---|
| memory: 100 appends onto 200 | 1,488 ms | 2,155 ms | 1.45x |
| memory: 1,000 appends onto 200 | 16,727 ms | 23,541 ms | 1.41x |
| memory: 100 appends onto 2,000 | 1,687 ms | 3,517 ms | 2.08x |
| memory: 1,000 appends onto 2,000 | 27,035 ms | 44,425 ms | 1.64x |
| knowledge: 100 appends onto 200 | 1,408 ms | 1,879 ms | 1.34x |
| knowledge: 1,000 appends onto 200 | 15,945 ms | 24,211 ms | 1.52x |

Individual writes at 40,000 memory records: **101.79 ms warm** (57.53 ms incremental write read +
35.50 ms fsynced append + 8.77 ms store-layer work) against the **583.31 ms validated read** it
replaces, and **654.92 ms cold** for a freshly constructed instance. At 2,000 records: 6.85 ms warm,
19.25 ms cold, 10.38 ms to validate the store. Knowledge at 2,000 claims: 22.63 ms warm, 64.56 ms cold,
30.99 ms validated read. The gap between the cold and warm columns is the re-derivation a restart pays:
553.13 ms at 40,000 memory records, 41.93 ms at 2,000 claims. Run 4 ended at 174.3 MiB RSS / 35.6 MiB
heap used.

Comparisons across runs are historical, not matching conditions. The pre-Batch-V baseline run measured
one public write at 40,000 records as 556.56 ms and 1,000 appends onto 2,000 as 44,434 ms, against
654.92 ms cold / 101.79 ms warm and 27,035 ms in run 4. Absolute milliseconds on this machine move by up
to 2x with system load, which is why the in-run pairs above are the evidence - and why the cold column
is reported as a real regression for one specific case rather than smoothed away. That said, the two runs
do agree where it matters: the baseline's 44,434 ms for 1,000 appends onto 2,000 and run 4's in-run
revalidate figure for the same workload, 44,425 ms, are within 0.02% of each other, so the revalidate
column is a fair stand-in for what a write cost before Batch V.

**Who pays the cold case today.** Every production call site performs one write per store instance per
command (`src/actions/builtin.js`, `src/actions/knowledge-actions.js`) and the CLI is one process per
command, so a single-write command pays the retention cost and gains nothing yet. The win belongs to any
process that writes the same store more than once: seeding and importing, a future long-lived session,
and the test and benchmark loops. That is the honest scope of Batch V - it is not a speed-up of one
`apex remember`.

**What did not change.** A write still reads and hashes the whole store, so writes are **not** constant
time and their cost still grows with total records. The memory and knowledge write path had no
lock and no in-process mutex (a pre-existing boundary); Batch V added none, and derived state is
invalidated by a foreign byte change rather than hiding it. Batch W later put a per-store claim around
that section, which is described in [Batch W](#batch-w-cross-process-write-coordination-as-implemented)
and measured in `benchmarks --lock`; the sentence below is what was true at the end of Batch V.
Damaged-store refusal is unchanged and still
timed: 23.61 ms, rejected 5 of 5 samples (memory) and 7.83 ms, rejected 5 of 5 (knowledge), each leaving
the store byte-identical. Two suites pin the contract: `tests/incremental-write-state.test.js` (18
tests: reuse proof, foreign writes, partial and failed appends, corrupt stores, the cap, real concurrent
child processes, and derived state compared against a fresh replay of the authoritative records every
time) and `tests/world-state-performance.test.js` (26 tests, including that every read is accounted
exactly once across the two structures).

### V-06: conflict and lifecycle indexing - decided by measurement, not implemented

The benchmark now times the store-layer work *inside* one public write instead of subtracting three
independent medians. At 40,000 memory records one `MemoryStore.add()` measured 68.21 ms whole, of which
its write read was 52.69 ms and its append 9.89 ms, leaving **3.40 ms** (min 2.29, max 4.84) for the
conflict scan, the lifecycle rebuild, the record construction and the integrity checks - the whole
body of work an incremental conflict/lifecycle index could remove. At 2,000 knowledge claims one
`KnowledgeStore.add()` measured 20.38 ms whole, write read 4.70 ms, append 10.08 ms, store layer
**5.81 ms** (min 4.40, max 11.57). Each write performed exactly 1 read and 1 append, and the write read
was proven a reuse. Batch V had already removed the re-parse and re-validate, so that residual figure
is the entire prize an incremental conflict/lifecycle index could contest: 5% of a warm memory write,
and at most 29% of a knowledge write - where the append itself (an fsynced 10.08 ms) is the largest
part, the spread between samples (4.40 to 11.57 ms) is wider than the median difference it would have
to beat, and some of the store-layer work is record construction and the two SHA-256 computations a
record needs whoever computes the grouping. An index that touches conflict grouping, supersession,
retraction and resolution applicability would add a second representation of lifecycle truth for less
than that. It is **not implemented**. Semantics were not touched: no
conflict definition changed, no retired claim was revived, heuristic memory subject grouping is still
reported as heuristic and unresolved, and the existing structures are still rebuilt from the authoritative
record list on every read. The remaining store-layer work stays where it is - derivable, verifiable, and
never authoritative.

### V-07: the read path after the write changes

Re-measured with the read-mode benchmark (2,000 memory records + 2,000 claims, 7 samples): cold first
read of a projection 159.8 ms, warm repeat read median 79.1 ms, the same read with the snapshot switched
off 75.5 ms (so warm-vs-off is -3.6 ms - noise at this fixture, as it was in Batch U), the Batch T read
pattern 141.1 ms, `execute` median 38.1 ms, independent `verify` 35.0 ms with 7 of 7 verifications
passing. The write change did not regress reads and improved the read that follows a write: a projection
built after a memory append cost 65.1 ms median with derived state on against 72.1 ms with it off, and
the append itself 30.4 ms against 41.6 ms; after a knowledge append the build was 78.6 ms against 73.6 ms
while the append itself was 28.1 ms against 51.1 ms.

A persisted derived index was considered and **rejected on measurement**. A snapshot file keyed by the
whole-file SHA-256 could cut a cold read at 40,000 records from the 583.31 ms parse-and-validate toward
the 105.60 ms read-and-hash - but only that far, because reading the store would still require reading
and hashing every byte of it. It cannot make read cost independent of store size, so no constant-time
read claim would be available from it, and at the sizes a personal install reaches it would buy tens of
milliseconds per command in exchange for a new on-disk artifact that can disagree with the log it
describes, plus its version contract, mismatch detection and rebuild path. The current safe projection -
rebuilt from disk, verified by an independent read - is kept. The next architectural dependency, when
read cost actually matters, is one of two named changes rather than a cache: **per-segment integrity**, so
a read re-validates only the segments whose bytes changed, or **serving `load()` from the validated write
state**, which is cheaper still but hands callers frozen shared records instead of copies and therefore
changes a published read contract. Both are storage-behaviour changes with their own tests; neither is a
reason to persist derived state today.

## Batch W: cross-process write coordination (as implemented)

Batch W removed the lost-decision defect: two processes writing the same store could each read the
whole log, each derive a decision from what they saw, and each append, so both "succeeded" while one
logical outcome was wrong - two replacements of the same claim, two retractions of one target, a
resolution recorded twice, or a claim stored as `supported` beside the claim that contradicts it.
Locking only the append would not have fixed it, because the decision was taken *before* the append,
from a view that was already stale by the time it was written. The section that has to be exclusive is
the whole sequence: read the authoritative bytes, derive, append, confirm the append.

**What was built.** `src/memory/writer-lock.js` is a per-store mutual-exclusion claim, one lock file
next to each store it protects - `memory.jsonl.lock` and `knowledge.jsonl.lock` - and both stores hold
it across that entire sequence:

- The claim is **created once and never rewritten**. The body (`pid`, a per-acquisition nonce, a
  timestamp) is written to a private staged name, checked byte for byte, and published with a hard
  link, which succeeds only if the lock name is still free. A competing process therefore cannot
  observe the lock name without its bytes and misreport the holder as unknown. Filesystems without
  hard links fall back to an exclusive create: still create-once, and a racer that briefly finds the
  name before its body is complete treats that as *in use*, never as free. The staged write is not
  fsynced on purpose - the protocol relies on mutual exclusion at publication, not on lock durability,
  and a holder that dies leaves a claim the next writer takes over.
- The store's read happens **inside** the section. `MemoryStore.add`/`correct`
  (`src/memory/memory-store.js:362`, `:391`) and `KnowledgeStore.add`/`retract`/`resolve`
  (`src/knowledge/knowledge-store.js:267`, `:338`, `:396`) call `loadForAppend()` from within
  `writeLock.run()`, so no derived decision can come from a view taken before coordination was
  obtained. The five public mutation paths are all of them; there is no sixth writer.
- **The wait is bounded and its expiry is a refusal.** Default `10000` ms
  (`WRITE_LOCK_WAIT_MS`), polled from 10 ms and doubling to a 250 ms ceiling. The budget is derived
  from the measured cost of one whole-store write rather than chosen to feel short, and it is a store
  option (`lockWaitMs`), not an environment variable or a CLI flag. A writer that expires reports
  `LOCKED`, names the holding process, says `nothing was written`, and exits 1; the CLI note for that
  result says a retry after the holder finishes is safe. The budget is a floor, not a promise: the
  last poll can run past it by one retry interval, and an expiry is not proof that a holder is stuck -
  with ten writers running on one machine while the whole test suite ran in parallel, one ordinary
  write waited 10,553 ms and was refused while its nine peers were all still writing. Failures of the
  filesystem itself (the store's directory, the staged claim body, a takeover token) are reported as
  `STORE_UNAVAILABLE`, the same code a failed store read uses, because that is an environment problem
  to fix and not contention to wait out; calling it `LOCKED` would tell the operator to look for a
  lock that does not exist.
- **Release proves ownership first.** The claim is removed only while its bytes are still exactly the
  body this process wrote. Absent, replaced or unreadable at release means another process may have
  been inside the same section, and that is raised as `LOCK_LOST` - which, because release runs after
  the append, always describes a failure *after* an authoritative side effect, and its message says
  the record was written and must not be repeated. `LOCKED` and `LOCK_LOST` are therefore never
  conflated: the audit record and the CLI notes distinguish a refusal that changed nothing from a
  result whose data is already stored.
- **A claim this process proved as its own but could not delete is not a lost write.** Windows can
  refuse an unlink while another process's poll still holds the file open, so removal is retried a
  bounded three times; a claim that survives is remembered as this instance's own orphan, stays
  visible through `state()`, and is reclaimed byte-exactly by this instance's next acquisition instead
  of locking the process out of its own store forever.
- **A claim left by an exited process is taken over by exactly one process,** through the election the
  task lock already uses (`src/tasks/lock-recovery.js`): create-once tokens named after the claim's
  digest and an epoch, compare-before-remove, at most `TAKEOVER_EPOCHS = 16` epochs. A taker that loses
  the election is refused. A process killed mid-takeover leaves tokens that the next epoch supersedes;
  after the sixteenth abandoned attempt a write is refused and says to run `apex repair locks`, which
  removes tokens and never a claim.
- **Uncertainty fails closed.** A claim whose holder cannot be identified is reported as in use by
  process `unknown` and is never removed, live-or-not. Liveness is a check of the recorded process
  number, not of process identity: Windows returns a freed pid to the allocator immediately, so a
  recycled number makes a dead holder's claim look live. That direction is deliberate - it refuses the
  write rather than risking two owners - and it means such a claim blocks both writes and
  `repair locks` until an operator checks the process by hand, exactly as the task lock does.
- **Reads stay lock-free** (`world state`, `memory list/search/health`, `knowledge health/history`,
  `diagnose`, `queue`) and take no claim, so coordination cannot slow or block a reader. The two
  stores coordinate independently: a command that writes both acquires and releases each claim in turn,
  which is not a multi-file transaction and is not described as one.

**What did not change.** Authorization is still checked *before* any lock is sought, so a lock is never
a source of permission: an unauthorized request is refused with no claim created, and a model-proposed
plan or action cannot reach the write lock at all (`store-write-concurrency.test.js`, W-07 group). A
coordinated write still reads, hashes and fsyncs the whole store, so writes are **not** constant time
and their cost still grows with total records; coordination adds work to that path rather than
removing any of it (measured below). The Batch V incremental state is still a disposable optimization:
it is advanced only after a confirmed append and re-derives when the bytes under it change, including
when another process wrote while this instance held a warm store. No persistent index was added - the
Batch V read-path assessment (V-07) still stands - and nothing about record content, conflict
definition, retraction, supersession, resolution semantics, redaction or the audit trail changed. The
task and queue locks are unchanged; they simply have two neighbours now, and `diagnose` and
`repair locks` report all four.

**What it costs, measured against the same tree without coordination.** Batch W adds no lock-free mode
to the store, so the "before" column is a separate `--writes` run against a copy of `HEAD` taken before
coordination, followed immediately by the same run against the current tree - one machine, one process
at a time, no overlap, 7 samples per measurement, every sample on a fresh copy of the same fixture. The
phase that attributes cost honestly is the one that times the write read and the append *inside* the same
public write, because the remainder is then one number from one sample rather than medians subtracted
across distributions:

| One public write, timed whole inside one call | before Batch W | Batch W | store-layer remainder (read + append excluded) |
|---|---|---|---|
| memory at 40,000 records | 187.54 ms | 237.32 ms | 4.19 ms → 58.58 ms |
| knowledge at 2,000 claims | 35.27 ms | 86.25 ms | 11.97 ms → 59.58 ms |

That is the coordination cost as the write itself experiences it: **+49.78 ms and +50.98 ms** per write,
which is what the claim's six NTFS metadata operations cost on this platform. The same overhead appears
as the warm-write column of the size matrix (median of 7, ms):

| Warm public write | before | Batch W | | Warm public write | before | Batch W |
|---|---|---|---|---|---|---|
| memory 200 | 13.31 | 18.67 | | memory 20,000 | 99.94 | 125.03 |
| memory 2,000 | 14.03 | 19.50 | | memory 40,000 | 247.49 | 323.32 |
| knowledge 200 | 30.45 | 69.00 | | knowledge 2,000 | 80.89 | 136.88 |

and it accumulates exactly that way in the workloads that write repeatedly through one instance: 1,000
memory appends onto a 2,000-record store went from 48,231 ms to 87,095 ms (36.70 → 71.08 ms per append),
1,000 knowledge appends onto 200 claims from 49,263 ms to 99,722 ms (40.50 → 82.74 ms per append), and
seeding 200 claims through the store's own write path from 9,786 ms to 18,730 ms. A damaged store is
still refused on every sample and still leaves the store byte-identical, but the refusal now also pays
for the claim: 51.80 → 72.22 ms for a memory write onto a 2,000-record unterminated store, 7.95 → 49.87
ms for a knowledge write onto 200 claims. The whole `--writes` suite (which is itself thousands of
coordinated writes) went from 880.9 s to 1,456.9 s of wall time; process footprint did not move
(106.5 MiB / 34.9 MiB before, 107.5 MiB / 35.6 MiB after).

Two honest caveats about those columns. Absolute milliseconds on this machine move by up to 2x with
system load, and the two runs did not have identical page-cache state - the second run's whole-store
reads were *faster* (the validated read at 40,000 records measured 927.87 ms against 1,078.37 ms, and
read+hash 126.08 ms against 178.15 ms), so a warm-write delta is an upper bound on nothing and a cold
write can even come out negative (the 40,000-record cold write measured 1,121.93 ms after against
1,374.81 ms before, which is the read environment, not a speed-up from the lock). The in-call table is
the number to quote, because both sides of it are computed inside one call on one sample.

What the overhead buys is the elimination of a class of wrong results: the same race that before Batch W
let two processes each record a replacement of one claim now records exactly one and refuses the other
with an explanation. `Correctness takes priority over throughput` was the instruction for this milestone
and it is the reason the overhead was accepted rather than optimized away. The cost is not free and is
not presented as free: one append issued as its own process (the shape the CLI actually has) measured
483-567 ms of wall time, of which the coordinated write inside it measured 41-110 ms, so coordination is
a fraction of a real command's cost, while a bulk import through the public API pays it per record.

### W-08: races, waits and holds, measured

`node benchmarks/run-world-state-benchmark.mjs --lock --repeats 7` (305.4 s, node v26.4.0, win32 x64,
12 logical CPUs, 24 GiB reported, one machine, no model, temporary directory, nothing else running).
Footprint at the end: 74.1 MiB RSS / 14.7 MiB heap.

- **What the section alone costs.** `writeLock.run()` around a call that returns immediately, on a warm
  instance, median of 7: **47.82 ms** (memory at 200), **33.66 ms** (memory at 2,000), **40.33 ms**
  (knowledge at 200), **38.53 ms** (knowledge at 2,000). The store's own public write on that same
  instance measured 73.42 / 73.99 / 86.52 / 81.44 ms, so the section is 45.5-65.1 % of a write at these
  sizes - which is why the overhead is flat in milliseconds rather than proportional to the store. Every
  sample created and removed its claim: residue `none` in all four fixtures.
- **Concurrent writers, real processes.** 1, 2 and 4 child processes released from one start barrier, 4
  append attempts each, on a fresh copy of the fixture per configuration. Every attempt was accepted in
  every cell (`ok / sent` = 4/4, 8/8, 16/16), exit codes all 0, **0 corrupt lines**, no residue, and the
  distinct record ids in the store afterwards equalled seed + appended in all twelve cells (200-memory:
  204/208/216; 2,000-memory: 2,004/2,008/2,016; 200-claims: 204/208/216; 2,000-claims:
  2,004/2,008/2,016). Medians of the writers' own in-process timings: memory at 200 31 → 48 → 30 ms,
  memory at 2,000 34 → 105 → 79 ms, knowledge at 200 33 → 27 → 29 ms, knowledge at 2,000 30 → 38 → 116
  ms for 1, 2 and 4 writers. No writer was refused in a race, because a coordinated write is short; the
  wait appears as a longer attempt, not as a lost or duplicated decision. Throughput including process
  start-up was 4.7-10.0 writes/s. One command per process (the shape the CLI actually has) measured
  483-567 ms of wall time for one append, of which the writer's own coordinated write measured 41-110
  ms. Attributed waits (the difference from that cell's 1-writer median) came out both positive and
  negative - from +86 ms down to -6 ms - and a negative one is NTFS metadata noise, not a saving from
  contention; these are one race per configuration, so nothing here is a throughput specification.
- **Bounded waits end in a refusal that is true.** With a real holder process keeping the section:
  a 250 ms budget expired after a measured **375 ms** and a 1,000 ms budget after **1,186 ms** - the
  budget is a floor, not a promise, because the last poll can run one retry interval past it. Both
  refusals reported `cannot write memory.jsonl: it is in use by process <pid>; nothing was written`, both
  left the store **byte-identical** (69,490 bytes), both found the claim still held when they gave up,
  and neither left residue after the holder exited. With the configured default (10,000 ms) a contender
  instead waits and writes: against a 3,000 ms hold it waited 3,267 ms and against a 6,000 ms hold
  5,766 ms, and the store then held 201 of 201 expected records (the holder writes nothing; it only owns
  the section). The holder sleeps inside the section and performs no store work in it, so that wait is
  coordination alone - the worst a well-behaved writer can impose on another, where a real hold is one
  whole-store read plus one fsynced append.
- **A damaged store is still refused, and the claim still goes away.** A memory write onto a
  2,000-record store whose last line is unterminated was refused in 1,037.11 ms with `STORE_UNAVAILABLE`
  and the unchanged reason `memory store contains 1 corrupt line(s); refusing incomplete write`; a
  knowledge write onto 200 claims in 320.77 ms. For both, the run proves the authoritative read happened
  **while the claim was held**, that the store's bytes were unchanged afterwards (696,901 and 69,936
  bytes), and that no claim was left behind on the refusal path. The memory latency in this phase is
  noisy - an earlier run of this same configuration measured 128.23 ms - so it is reported as a single
  sample that establishes the behaviour, not the cost.
- **Derived state after another process wrote underneath.** One held instance writes once, two real
  processes then write while it is idle (4 of 4 attempts completed), and the instance writes again. The
  on-disk count reached 205 = 200 seeded + 1 by the instance + 4 external; the instance's next write read
  **205 records with the claim present during that read** and *saw everything the other processes wrote*;
  its derived counters went `trackedRecords 201 → 206`, `reuses 0`, `rebuilds 1 → 2` - the foreign bytes
  failed the hash proof, so the state re-derived rather than being repaired; and the retained records
  equalled a fresh replay of the file exactly. Residue: none.

**What none of this claims.** No measurement here says writes are constant time: every coordinated write
still reads, hashes and fsyncs the whole store, and the `--writes` matrix shows that cost at 200, 2,000,
20,000 and 40,000 records. No persistent index was added, because nothing measured here shows one is
needed - the overhead is per write, not per record, and the read-side numbers in V-07 still say a
persisted index could not make a read independent of store size either. Differences of a few
milliseconds, in either direction, are noise on this machine.

**Tests.** `tests/store-write-concurrency.test.js` drives real child processes through 18 scenarios -
distinct concurrent adds, one conflict group, and each of the decision-bearing paths (correct,
supersede, retract, resolve) raced two at a time so exactly one decision is recorded and the loser
returns a truthful refusal; a live holder waited out within budget; a killed holder's claim taken over;
an expired budget refusing with the store byte-identical; the default budget disclosed so a stuck
holder cannot hang a command; an unreadable claim reported as `unknown` and never removed; recovery of
sixteen abandoned tokens removing tokens only; an append that wrote nothing; a claim that could not be
removed; a corrupt store discovered under the claim; a warm instance that cannot decide from state
another process changed; five writers per store at once; three repeated stress rounds; and read-only
commands that neither take a lock nor disturb a holder. Every assertion is about the authoritative
records and lifecycle states on disk, not about exit codes. `tests/incremental-write-state.test.js`
keeps the derived-state contract pinned across the same interleavings.

Two points about those tests are part of the record, not footnotes. The ten-writer and stress scenarios
give their writers an explicit 60,000 ms budget instead of the 10,000 ms default, because their question
is whether simultaneous writers can lose, duplicate or corrupt a record, and a write that gave up waiting
under the machine's own load would have answered a different question: in a full-suite run one ordinary
write measured a 10,553 ms wait and was refused with `LOCKED` while its nine peers were still writing,
which is correct behaviour and no data loss. The default budget is still pinned by the scenarios that
assert it (the expired refusal and the disclosed-wait cases). The pre-existing `tests/lock-contention.test.js`
also asserted that exactly one of six racers acquires a stale task lock and that the trace holds eight
lines; under a loaded machine a late racer legitimately takes a lock its holder has already released, so
it now asserts the invariants directly - never two processes inside, exactly one taker per stale claim,
one report per racer, no claim left behind - which detects a breach as before and stops reporting a
normal late process as one.

**CLI smoke, no model.** 36 commands through `node bin/apex.js` against one fresh isolated
`APEX_DATA_DIR` with no backend configured (win32, node v26.4.0): memory store, correct, health and
`world`, `knowledge add` ×3 including a conflict group and a supersession, `resolve`, `retract`,
`history`, `show`, `list`, `search`, `health`, then `history`, `audit health`, `queue`, `diagnose`,
`repair locks`, `status --model`, and two usage-error commands. Every write path completed with
`success_verified`, `repair locks` reported all four locks as absent before and after, `diagnose` stayed
"local subsystems healthy; no model configured", and **no `*.lock` file remained**. The four non-zero
exits are all truthful refusals rather than failures of coordination: `knowledge health` exits 1 while a
conflict group is unresolved and 0 after the recorded resolution, `knowledge retract` of a claim that was
already superseded is refused ("historical records are not retracted"), and the two malformed commands
exit 2. `memory correct` of a day-name change ("Tuesday 02:00" to "Wednesday 02:00") is refused by the
pre-existing memory contradiction rule (`DATE_WORDS`, `src/memory/memory-store.js:254`), which treats a
date-word value as schedule detail rather than conflict - unchanged by this batch and documented here
because the smoke run found it.

## Batch Z: experience, feedback, and controlled adaptation (as implemented)

One append-only JSONL log, `<dataDir>/experiences.jsonl`, carries five record kinds - `experience`,
`feedback`, `adaptation`, `adaptation_decision`, `adaptation_retirement` - and every read of it
recomputes the adaptation lifecycle from the whole log rather than trusting a stored status. That
recomputation is what makes a corrected experience unable to leave a stale rule in effect, and its
cost is measured below rather than presented as free.

Commands (all writes are refused unless the origin is the user; `experience health` exits 1 whenever
the store reports attention or an evidence mismatch):

```bash
apex experience record <operation-id> --subject <text> [--replaces <id[,id...]>]
apex experience list|show <experience-or-operation-id>|health
apex feedback record <experience-or-operation-id> --assessment <kind> [--guidance <text>] [--reason <text>] [--supersedes <id[,id...]>]
apex adaptation derive|list|approve <adaptation-id>|reject <adaptation-id>|retire <adaptation-id>
```

An adaptation moves through five states - experience, feedback, candidate, approved, in effect - and
only the user's recorded decision moves it from candidate to approved; a retirement excludes it. The
model path is the only reader: `controller.js` `#adaptationsFor` calls `activeAdaptations()` for a
request that would build a model prompt, and a deterministic request performs no experience read at
all (measured: 0 calls for `calc 2+2`, 1 for a free-form ask). Approved rules enter the prompt as
data with the explicit label that they are neither instructions nor authorization, and they are
trimmed after memory and turns but before knowledge.

**How it differs from memory and knowledge, measured.** Memory stores what the user says is the
case; knowledge stores explicit subject-relationship-object claims and their retractions; the
experience store stores what APEX did, what the user thought of the result, and - only through a
recorded user decision - what APEX should do differently. The consequence is a store with more
per-record structure (each experience carries a canonical subset of its audit record, each
adaptation a support list) and a read that derives rather than looks up. At 807 matched records in
one run (`node benchmarks/run-experience-benchmark.mjs`, node v26.4.0, win32, 5 samples, medians):

| Store | bytes | one raw append | store write | full read | read + derived state |
|---|---|---|---|---|---|
| memory | 294,445 | 5.69 ms | 21.24 ms | 8.58 ms | 10.06 ms |
| knowledge | 295,250 | 5.40 ms | 28.97 ms | 7.47 ms | 23.31 ms |
| experience | 487,232 | 4.58 ms | 46.24 ms | 19.69 ms | 23.75 ms |

Growth with store size follows the same shape as the other two stores - a read is a whole-file read
and a write is a whole-file read plus an append - and it is real: from 47 to 807 records the cold
read went 2.02 → 22.69 ms, the warm read 0.88 → 5.35 ms, an `evidenceCheck()` 1.98 → 3.61 ms, a
bounded `list()` 1.17 → 3.33 ms, retrieval 1.05 → 2.98 ms, and `health()` 1.25 → 3.40 ms. Writes grow
faster because a write reads the whole store before appending it: the store-level append went
17.36 → 39.37 ms, feedback 21.81 → 49.05 ms, an approval 25.01 → 65.75 ms, a retirement
27.76 → 65.23 ms, and the end-to-end controller call (audit record plus independent re-check)
27.52 → 80.12 ms. A repeat `deriveAdaptations()` over a store whose candidates already exist is the
expensive read-write hybrid: 11.31 → 32.10 ms, dominated by the write coordination it must perform
even when it appends nothing.

Context cost is bounded and does not grow with the store: one approved rule adds 770 characters to a
prompt, the default window of three adds 1,362 (of a 6,000-character budget), the note that further
rules were cut brings that to 1,507, and the disclosure that the store could not be read costs 193
characters. The longest single rule line in the fixture is 302 characters; retrieval returns at most
10 (default window 3). On the request path, a free-form ask at 807 records cost 26.19 ms against
17.79 ms for the same ask against an empty store - the one extra whole-store read - while `calc 2+2`
cost 18.53 ms with 0 experience reads (17.95 ms on an empty store; the difference is noise).

What this batch does not claim: no inference was run or simulated in any measurement above, so
nothing here shows that an approved rule improves an answer - only what carrying it costs. One
adaptation may cite at most 20 evidence records, and a group whose support is larger is reported as
skipped rather than truncated, so a single preference restated across a very large store yields no
candidate until the user scopes it. `npm test` covers the semantics;
`benchmarks/run-experience-benchmark.mjs` is outside the suite and no test depends on it.

## Batch AA: automatic experience capture (as implemented)

Batch AA adds one thing to the Batch Z store: a second, narrow way for an **experience** record to
be written. Everything else about that store is unchanged - the support threshold for a candidate,
the retirement rules, the approval requirement, and the fact that feedback is only ever the user's
own record.

One environment setting controls it, validated at startup like every other APEX setting:

| Setting | Values | Default |
|---|---|---|
| `APEX_EXPERIENCE_CAPTURE` | `off`, `verified-success` | `off` |

Unset or `off`, an experience exists only because the user asked for it, exactly as in Batch Z. A
value that is neither of those is refused before any store is opened (exit 2, the setting named), so
a misspelling cannot quietly change what APEX writes. There is no second switch, no per-capability
list, and no framework around it.

**When a record is written.** The decision is made from the finished audit record alone, in
`src/experience/capture.js` `autoCaptureDecision()`, and the write is attempted only **after** the
audit append succeeded. Batch AA made that attempt from the three controller methods that ended an
operation at the time (`handle()`, `correctMemory()`, and `#finishCommandOp()`); Batch AB replaced
that repeated tail with one function, `finalizeOperation()` in `src/controller/finalization.js`,
called by all four controller completion paths - including `#finishTaskOp()` - and by the
`TaskRunner` for none of its step records. A task operation is outside the subset, so its capture is
refused by eligibility rather than skipped silently. Every guard must hold, in this order:
the mode is `verified-success`; an operation record exists and was written to the audit log; it has a
stable id; its origin is `user`; its status is `SUCCESS_VERIFIED`; it carries no errors; its
capability is in the capture subset; it has at least one step; and **every** step independently stands
(`authorization.decision === allow`, `execution.status === ok`, `verification.outcome ===
SUCCESS_VERIFIED`); the account of the event can be built, contains no control characters and no
secret-shaped text. Anything else is not captured, and the reason is always stated: `denied`,
`failed`, `uncertain side effect`, `verification unavailable`, `audit evidence missing or unwritten`,
`out-of-subset capability`, `secret in the account`. A read (`calc`, `recall`, `knowledge search`,
`status`, `world`, `diagnose`) is never captured, a model-origin operation is never captured, model
conclusions are never captured, and the experience/feedback/adaptation commands are excluded so the
log cannot fill itself with its own bookkeeping.

**What a captured record is.** `capture: 'automatic'` maps to the fixed provenance origin
`system_observed`; the user's own `experience record` maps to `explicit` → `user_recorded`. The two
are never conflated on a read: `captureOf()` derives the route from provenance, `experience list` and
`experience show` name it per record, `status` and `experience health` print "N recorded by you, M
captured automatically", and a record whose provenance names no route is reported as
"capture provenance no writer produces" instead of being re-labelled. A captured experience carries
no assessment - not `correct`, not `useful`, nothing. Silence is still not approval: a candidate can
only be derived from corrective **feedback**, which only the user writes, so any number of captures
produces zero candidates until feedback is recorded and `adaptation derive` is run. `verify` re-reads
the appended record against the audit record before the notice calls it captured; a write that does
not read back is reported as appended-but-mismatched, never as a success.

**One operation, one experience - and one operation, one notice.** A second claim for an operation id
already in the log is refused inside the write lock with `EXPERIENCE_EXISTS`, and the notice says
nothing was duplicated. If the experience store is damaged, unreadable, or fails mid-append, the
operation keeps its own outcome, exit code and audit record; the notice states the refusal and points
at `experience record <id>` for the explicit retry. APEX never re-runs the original operation to
repair a capture, and never claims exactly-once execution: what it guarantees is that a second
capture attempt for the same audit record writes nothing, which is what the concurrency and
process-interruption tests demonstrate with real child processes.

**No conversation copying.** The subject line is built from `capability` plus the audit step
summaries, which the action layer already minimizes to identifiers, counts, and expressions - never
from the request text or the displayed answer. Over `MAX_SUBJECT_CHARS` it degrades to a content-free
`<capability>: N verified step(s)` rather than a truncation that could cut an id in half.

**Measured.** `tests/experience-capture.test.js` - 29 tests in 7 suites, registered in `npm test` -
covers each case named above with deterministic synthetic fixtures, real child processes for the
concurrency and interrupted-holder cases, and stand-in stores for the failure paths; it contacts no
model and starts no service. `node benchmarks/run-experience-benchmark.mjs`, capture phase, 2026-11-01,
node v26.4.0 on win32, 5 repeats, medians, one fresh fixture copy per sample. A is an eligible verified
`memory.add` with the setting unset; B is the same request with it armed; `B - A` is therefore the
capture. No model, endpoint, or service was involved in any figure below - every application in the
run is built with `NoBackend`.

| Store (records) | A eligible | B eligible | B - A | the append | a refused duplicate | two writers at once | damaged store | unreadable store |
|---|---|---|---|---|---|---|---|---|
| 47 | 93.07 ms | 193.16 ms | 100.09 ms | 60.48 ms | 34.51 ms | 132.48 ms | 129.76 ms | 144.99 ms |
| 207 | 121.22 ms | 214.42 ms | 93.20 ms | 79.13 ms | 43.65 ms | 130.36 ms | 147.44 ms | 150.02 ms |
| 807 | 109.79 ms | 251.30 ms | 141.51 ms | 91.87 ms | 34.37 ms | 220.72 ms | 177.45 ms | 148.57 ms |

What the numbers say, and what they do not:

- The added latency on an eligible operation is **the existing experience write, done
  automatically**: this run's `append` column (60.48 → 91.87 ms) is the same work the writes phase
  measures for a user-requested record (55.79 → 93.28 ms), and `B - A` is that append plus the
  read-back that `verify` performs. It grows with the store because a Batch Z write is a whole-store
  read followed by an append; capture inherits that, it does not add a second scan.
- Arming the setting costs nothing to a request that is not in the subset: `calc 2+2` on the largest
  fixture measured 51.27 ms unset against 44.33 ms armed, with 0 experience reads per request either
  way (the difference is noise, and the decision is made before any store is opened).
- Duplicate detection is a refusal inside the lock (34.37-43.65 ms), and two writers on one store pay
  coordination, not corruption: 220.72 ms at 807 records against 91.87 ms for one append.
- The failure paths are not cheaper than the success path: a store with one corrupt line (177.45 ms)
  and a store that cannot be opened at all (148.57 ms) both still cost a read of the audit record and
  a refusal, and in both cases the operation itself finished verified and its audit record was
  unchanged.
- Store growth is one record per eligible verified operation: at a few arithmetic steps from the
  measured fixture bytes, 47 records occupied 27,972 bytes and 807 records 487,232 bytes (about 600
  bytes per record in this fixture), so a month of daily verified writes produces hundreds of
  records, not hundreds of thousands.
- **No index was added.** The added cost above is the same whole-store read the explicit command
  already pays, so capture does not demonstrate a need the pre-existing write path does not already
  have; the Batch V decision - no persisted index at personal-install sizes - stands unchanged.

What this batch does not claim: the capture point was tested against real child processes, killed
holders and shared stores, but only on one machine (Windows 11, x64), and no measurement here
involved a model, so nothing here shows that a captured experience improves a later answer - only
what carrying and refusing it costs. No local inference server of any kind was installed,
downloaded, started, invoked, or recommended at any point in this batch, and no model was used in
any test or measurement; §8 removed the remaining active guidance that pointed a reader toward one,
while the `openai` and `ollama` provider contracts, the loopback-only default, and every dated
historical measurement were kept exactly as they were.

## Batch AB: one completion contract for every operation (as implemented)

Batch AB adds no capability. It makes the ending of an operation a single, testable contract, so a
later action cannot accidentally finish without an audit record, treat an unwritten audit record as
a success, or attempt an experience before the event it claims to describe exists.

### The capability inventory, reconciled

The Batch AA report said the capture subset held nine capabilities. The source did not: the subset
is `AUTO_CAPTURE_CAPABILITIES` in `src/experience/capture.js`, and it has exactly five entries. No
capability was added to reach nine; the report's number was simply wrong. The exact inventory is
below, and `tests/finalization-contract.test.js` (AB-1) derives it from the registry and the two
data tables, so a new action fails the suite until it is deliberately classified.

| Capability | Operation path | Outcome classification | Audit recorded | Experience capture eligible |
|---|---|---|---|---|
| `memory.add` | `handle()` → deterministic route → `runAction` → `finalizeOperation` | the step's own outcome; only `SUCCESS_VERIFIED` when the action verifier re-read the stored record | yes, exactly one record | yes, when user-origin, `SUCCESS_VERIFIED`, no errors, and every step independently stands |
| `memory.correct` | `correctMemory()` → `runAction` → `finalizeOperation` | same | yes | yes, under the same guards |
| `knowledge.add` | `knowledge add` → controller → `runAction` → `#finishCommandOp` → `finalizeOperation` | same | yes | yes, under the same guards |
| `knowledge.retract` | `knowledge retract` → `#finishCommandOp` | same | yes | yes, under the same guards |
| `knowledge.resolve` | `knowledge resolve` → `#finishCommandOp` | same | yes | yes, under the same guards; needs a conflicting pair to reach a verified success |

The other 27 capability names are refused by data, in six categories: read (10), model-words (2),
self-bookkeeping (5), task (7), filesystem (2), no-action (1). With a configured filesystem root the
registry holds 23 actions; the 9 non-registry names (`model.answer`, `none`, the seven `task.*`
commands, and the runner's `task.step`) bring the classified total to 32. Every one is either in the
five-row table above or carries a category and a one-line reason in `CAPTURE_EXCLUDED_CAPABILITIES`.
A capability in neither is refused by `autoCaptureDecision()` but the coverage test fails first.

### The finalization order

`finalizeOperation(op, { append, capture, onAuditFailure })` is the one tail every controller
completion path runs. The order is fixed by which evidence each step needs:

1. **outcome finalized** (caller) - status, decision, output and `finishedAt` are already set; only
   the caller knows what its step did.
2. **side effect established** (caller) - the final outcome already says whether something may have
   changed. Nothing is upgraded here, ever.
3. **audit appended** - the record is written to `operations.jsonl`.
4. **audit recording established** - success is taken from the append itself, never assumed.
5. **capture attempted** - only when the append succeeded, and the decision is told `recorded`.
6. **capture verified** - the store reads the new record back against the audit record.
7. **disclosure produced** (caller) - a notice states capture, refusal or failure without changing
   the operation's outcome.
8. **operation result returned** (caller) - the original status, output and exit code.

The helper never writes `status`, `decision`, `output`, or `errors`. An append failure is reported
to the caller, which decides what it means: the command, correction and task paths turn it into
`AUDIT_INTEGRITY_FAILED` when something may have changed; an audited read keeps its own outcome
because nothing could have changed. A capture that throws becomes a notice, never an operation
failure. Finalizing the same record object twice is refused before the second append, so a retry in
one call path cannot duplicate the audit line. The mark is non-enumerable, so it never reaches the
JSONL file or a caller's deep comparison.

### Five completion paths

| Path | Entry | Audit writer | Capture |
|---|---|---|---|
| request | `CognitiveController.handle` | controller | attempted |
| memory correction | `CognitiveController.correctMemory` | controller | attempted |
| command | `CognitiveController#finishCommandOp` | controller | attempted |
| task operation | `CognitiveController#finishTaskOp` | controller | attempted, then refused by eligibility for `task.*` |
| task step | `TaskRunner#audit` | task runner | not attempted; `task.step` is outside the subset |

The five declarations are frozen in `OPERATION_COMPLETION_PATHS`; AB-1 checks the ids, entries,
audit writers and capture stances. AB-2 drives one operation through every path and asserts exactly
seven audit records with unique ids and exactly three experiences (the eligible writes); it also
asserts that capture only ran after the audit record could be read from disk, and that
`knowledge.resolve` captures through a real conflicting pair.

### Failure semantics

| What failed | Operation outcome | Audit record | Experience | Disclosure |
|---|---|---|---|---|
| audit append for a write that may have changed something | `AUDIT_INTEGRITY_FAILED` | absent | none attempted | the result states it may have happened and the audit trail does not contain it; the CLI prints `Audit: NOT RECORDED` and says not to repeat the request |
| audit append for a read that changed nothing | unchanged (normally `SUCCESS_VERIFIED`) | absent | none (reads are never captured) | same `Audit: NOT RECORDED` line; the read result itself still stands |
| experience append after a verified audit | unchanged | present | absent | "not captured (...)", with the operation and its audit record unchanged; `experience record <id>` is the explicit retry |
| experience read-back disagrees | unchanged | present | appended, kept for inspection | "appended ... but it does not match the audit record"; `experience health` names the damage |
| capture refused as ineligible | unchanged | present | none | silent; nothing was asked for and nothing was tried |
| a second finalization of the same record | unchanged | still one record | unchanged | refused: "already finalized; a second audit record would duplicate it" |

In every row the operation is never executed a second time to repair a bookkeeping step, and no
claim of exactly-once execution is made. What is guaranteed is narrower and testable: a second
capture for one audit record writes nothing, and a capture failure cannot falsify an operation's
success.

### Interruption and restart

`tests/finalization-interruption.test.js` starts a real child for each boundary, stops it with exit
status 9 at that point, then inspects the directory with new processes (`status`, `audit health`,
`experience health`) and a fresh application instance.

| Boundary | Durable state after the stop | What a restart reports | Recovery |
|---|---|---|---|
| before the audit append | the side effect is in its own store; no audit record | `status` shows the memory record and 0 operations; `audit health` says the log is empty | none automatic; the event has no id, so it can never be referenced. Do not repeat the request |
| during the audit append | half an audit line, no newline; side effect present | `audit health` exits 1 with `damaged - 1 corrupt line(s)` and `(final line without a newline)`; `status` counts it as skipped | operator inspection only; APEX neither repairs nor invents the record |
| after the audit, before capture | complete audit record; no experience | `experience health` shows 0 record(s) and an empty evidence check | `experience record <operation-id> --subject ...` creates an explicit, user-attributed record; the original write is not re-run |
| during the experience append | complete audit record; half an experience line | `experience health` exits 1 as damaged; reads and writes refuse the incomplete store | preserve the line for inspection; no automatic reconstruction and no silent dropping |
| after the experience append, before its read-back | both records complete | the record re-verifies against the audit log in the restarting process | none needed; the missing read-back changed nothing durable |
| after the read-back, before disclosure | identical to the previous row | same | none; the process died before it returned a result, so nothing was displayed as a success |

The control case runs the same operation without interruption and leaves exactly one audit record
and one experience. No restart appends anything: the after-audit test compares file sizes before and
after building a new application and reading both stores.

### Outcomes, in this context

| Outcome | What it means here |
|---|---|
| `success_verified` | the action's own verifier re-read the postcondition; the only outcome that can be captured |
| `execution_failed` | the action did not complete; never captured |
| `verification_failed` | the action ran but its postcondition was not confirmed; never captured |
| `verification_unavailable` | the action ran but no independent confirmation was possible; never captured |
| `audit_integrity_failed` | something may have changed but the audit append did not succeed; never captured, never reported as success |
| `action_denied` | authorization refused before execution; nothing ran |
| `input_rejected` | the request was refused before any action; nothing ran |
| `clarification_required` | the request lacked information; nothing ran |
| `model_unavailable` | no inference backend answered; no action ran |
| `plan_created` | a deterministic task plan was stored |
| `plan_proposed` | a model plan was stored and waits for the user's approval; it is not permission |
| `plan_rejected` | a plan failed validation; nothing was stored |
| `task_paused` | the task stopped for an explicit user decision |
| `task_cancelled` | the task was cancelled by the user |

### Control and boundaries

`APEX_EXPERIENCE_CAPTURE` remains the only switch, validated at startup and **off by default**
(`off` / `verified-success`). An automatic experience is evidence that a verified event happened;
it is not feedback, not an assessment, and not a behaviour rule. Only the user's own corrective
feedback supports a candidate, and only the user's approval puts a rule in effect. Capture never
grants permission: the audit record keeps the operation's real `origin`, a model-origin operation is
never captured, a captured record cannot authorize any later action, and the Executive Control Plane
remains the sole authorization authority.

### Measured

`node benchmarks/run-experience-benchmark.mjs --phase finalize`, 2026-11-01, node v26.4.0 on win32,
5 repeats, medians, one fresh fixture copy per sample, all applications built with `NoBackend`. The
record finalized in every sample is a real verified `memory.add` produced through the controller.

| Store (records) | audit only | `finalizeOperation` (capture off) | finalize + capture + read-back | second finalization refused | damaged audit log | unreadable audit log |
|---|---|---|---|---|---|---|
| 47 | 12.62 ms | 12.38 ms | 74.09 ms | 0.10 ms | 71.58 ms | 10.79 ms |
| 207 | 14.87 ms | 10.92 ms | 90.24 ms | 0.11 ms | 88.93 ms | 9.47 ms |
| 807 | 13.14 ms | 13.91 ms | 181.40 ms | 0.10 ms | 147.34 ms | 9.12 ms |

What these numbers say, and what they do not:

- The shared helper costs nothing measurable when capture is off: `finalize off` and `audit only`
  are the same append within noise. The contract adds no extra store read - it only sequences the
  reads and writes the path already performed.
- The armed column is the existing experience write plus its read-back, so it grows with the store
  exactly as the Batch AA `B - A` column does (53.04 / 77.84 / 150.12 ms in this run's capture
  phase). Finalization did not add a second scan.
- Refusing a duplicate finalization is ~0.1 ms: the check is a non-enumerable mark on the record,
  not a read of the log.
- A damaged audit log costs a counted corrupt line and a full scan to the target (71.58-147.34 ms),
  and an unreadable one fails the append fast (9.12-10.79 ms) while the operation still ends as it
  would have without capture. Neither path repairs or rewrites evidence.
- Damaged and unreadable **experience** stores were measured in the capture phase of the same
  benchmark (169.04/136.80/175.48 ms and 139.37/131.04/139.14 ms): the capture refuses, the
  operation keeps its outcome, and its audit record is unchanged.

What this batch does not claim: measurements are from one machine (Windows 11, x64), on synthetic
stores, with no model inference anywhere in the run. Nothing here shows that a captured experience
improves a later answer; it shows what recording and refusing one costs, and that neither can change
what the operation was reported to have done. No local inference server of any kind was installed,
downloaded, started, invoked, or recommended in this batch.

## Batch AC: temporal experience and outcome tracking (as implemented)

Batch AC reads the Batch Z-AB experience log as *history*: what happened, in what order, what the
user said afterwards, and whether the recorded outcome changed. Everything is a deterministic
derivation at read time from the append-only log (`<dataDir>/experiences.jsonl`); no new record kind
is written, no index is persisted, and the read-only commands cannot repair, approve, or rewrite
anything. The engine is `src/experience/temporal.js`; it imports no store, so a temporal read cannot
start a write.

Batch AD hardened that engine without adding a record kind or changing the commands: every pattern
now separates supporting, contradicting, and excluded evidence with full counts behind bounded id
lists; replaced experiences and superseded feedback are excluded from pattern evidence and their
exclusion is stated; `insufficient_evidence` carries the query's capability scope; success rate is
computed over completed attempts only; a zone-less timestamp is read as UTC so one stored text has
one instant on every machine; and the tests below include adversarial histories as well as the
ordinary ones. No predictive stage was added by either of those batches; Batch AE, below, is the
batch that adds an expectation ledger, and it adds it as a separate store.

### What a query distinguishes

| Level | What it is | Its evidence |
|---|---|---|
| Observed event | One audited operation that ended with an outcome, placed at the time the record carries. | The experience record and, through it, the audit record it names. |
| Recorded outcome | The outcome class the audit record reports: success, failure, blocked, other, or unknown. | The stored outcome; nothing is re-classified from prose. |
| Explicit user feedback | The user's own assessment of one event, current or corrected. | Feedback records only. Silence is never an assessment. |
| Later correction | Feedback the user superseded with a newer record, or an experience a later record replaced. | Supersession and replacement links; the corrected record stays readable and is counted as corrected. |
| Subsequent related experience | Other events for the same capability, ordered by time. | Capability equality, not similarity of text. |
| Current adaptation state | Whether a recorded behaviour rule is in effect now. | Read from the store; a pattern never changes it. |

These are **historical observations**. A **detected pattern** is a deterministic statement about the
order of those observations. There is no **hypothesis** stage in the implementation: nothing combines
patterns into a candidate belief about the user or the world. Batch AC added no prediction stage, and
Batch AD did not add one either: what is described here estimates nothing about a future outcome and
holds no record of one. (Batch AE, below, is the batch that adds an expectation ledger - a separate
append-only log, a separate record kind, and a reader that cannot present an expectation as something
that happened. Nothing in this section changed: the temporal engine reads `experiences.jsonl` only and
still cannot see a prediction.) A pattern is never presented as a prediction.

### Commands

```bash
apex experience timeline [--since <date>] [--until <date>] [--days N] [--capability <name>] [--limit N]
apex experience trends   [--since <date>] [--until <date>] [--days N] [--capability <name>] [--limit N]
apex experience patterns [--since <date>] [--until <date>] [--days N] [--capability <name>] [--limit N]
apex experience compare  [--a-since <date>] [--a-until <date>] [--b-since <date>] [--b-until <date>] [--days N] [--capability <name>]
```

- `timeline` lists dated events newest first with outcome, capture route, feedback counts, and
  correction state, plus any undated records outside every window.
- `trends` groups by capability: totals per outcome class, success rate over completed attempts
  (success or failure; refused, other, and unknown outcomes are counted but are not attempts, so
  they neither raise nor lower the rate), first and last occurrence, an early/late trend, and
  whether the first and last outcome class differ.
- `patterns` names the detected patterns with supporting, contradicting, and excluded counts, the
  bounded ids behind each count, the threshold each one had to meet, and what it does not establish.
- `compare` reports two windows side by side: counts, outcome classes, success rate over completed
  attempts, feedback, and the largest per-capability changes. With no window A given, A is the
  same-length period immediately before B, so the default comparison is "the period before" against
  "now".

`--since` and `--until` accept an ISO 8601 timestamp or `YYYY-MM-DD`; a date is read in UTC so the
result does not depend on the machine's time zone, and a date-only `until` includes that whole UTC
day. Both bounds are inclusive. `--days` is 1-3,650 and fills only a bound you did not give; an
explicit bound always wins, so "the last 7 days" and "since Monday" cannot quietly disagree about
one end. The default window is 30 days. A malformed date is refused before the read starts
(`input_rejected`), and a window whose start is after its end is refused by the engine - both exit 1
and neither changes a store. As with every command, the attempt itself is the one audit record a
user-issued command appends; the read adds nothing else.

Ordering is by `finishedAt`, then `requestedAt`, then `createdAt`. Equal timestamps keep their
append-only log position, so a restart re-derives the same order. A record with no usable timestamp
is listed as undated and is never placed in a window. Output is bounded (50 events, 20 capability
groups, 20 patterns, 20 evidence ids per pattern) and says when it is showing a subset.

### Pattern rules

Each candidate applies its own threshold; `minEvents` (default 3, configurable 2-20 inside the
engine) is stated in the output. A capability is never inferred from similar wording: patterns are
computed within one capability name. Only **current** dated events are used: an experience a later
record replaced stays in the timeline and counts, but it is not evidence for any pattern, and the
number left out is stated. Current feedback on a replaced experience, and feedback a later feedback
record superseded, are likewise not counted; both exclusions are disclosed with counts.

The outcome classes are fixed, not inferred from prose. **Success** is `success_verified`.
**Failure** is `execution_failed`, `verification_failed`, `verification_unavailable`,
`audit_integrity_failed`, `model_unavailable`, or `task_cancelled`. **Blocked** is `action_denied`,
`input_rejected`, `clarification_required`, or `plan_rejected`: a refusal is not a failed attempt.
Any other recorded outcome is **other**, and a missing or empty outcome is **unknown**.

Every pattern reports three disjoint buckets. **Supporting** events are the ones the rule is stated
over. **Contradicting** events genuinely count against it (a later failure after a correction).
**Excluded** events were evaluated but neither support nor refute the rule (outside the named run,
recorded before it, refused, or unclassified); they are disclosed with a reason instead of being
silently dropped. `supporting + contradicting + excluded = evaluated`, and each bucket's full count
is reported even when its displayed id list is cut at 20 (`supportTruncated`, `counterTruncated`,
`excludedTruncated`). Counter-evidence is never hidden by the display bound.

| Kind | Rule (supporting) | Contradicting | Excluded |
|---|---|---|---|
| `repeated_failure` | The `minEvents` most recent current dated events for the capability in the window all record failure. | None; a run by definition contains no other outcome. | Every other event in the window, with the reason that it is older than the named run. |
| `repeated_success` | The same, for success. | None. | Same. |
| `alternating_outcomes` | At least 4 consecutive current dated success/failure events with no two adjacent classes equal. | None; an interruption breaks the run rather than refuting it. | Events outside the trailing alternating run, including blocked, other, or unknown outcomes. |
| `regression_after_success` | The most recent current dated event is a failure and every earlier one in the window is a success, with at least `minEvents - 1` successes. | None inside the run. | None: any other outcome would have blocked the pattern. |
| `improvement_after_correction` | One current, in-window corrective feedback record on a record that still stands, plus at least one later success in the same capability. The assessed event (when it is in this window) is counted once. | Later failures. | Events recorded before or at the correction, and later events with a refused or unclassified outcome (a refusal is not a failed attempt). |
| `recurring_corrections` | At least 2 current corrective feedback records in the same capability and window, each assessing a record that still stands. The supporting experiences are the assessed records inside the window; when they are outside it, the pattern says the evidence is the feedback alone. | None: the feedback records are assessments, and a differing assessment does not refute their existence. | Experiences in the group not assessed by a current in-window corrective record; feedback on a replaced experience and feedback corrected by a later record are counted as excluded and stated. |
| `insufficient_evidence` | Fewer than `minEvents` current dated events in the capability window (replaced records do not count). It states what is missing, not that outcomes are stable. | Not applicable. | Not applicable. |

Every pattern carries `causal: false` and `adaptation: false`, counts supporting, contradicting, and
excluded evidence separately, separates automatic captures from records the user made, and names its
own limitations in the output. Nothing in this module can create, approve, retire, or modify an
adaptation: that path is still `adaptation derive` from the user's corrective feedback plus an
explicit user decision, unchanged from Batch Z.

A window with contradictory feedback and mixed outcomes therefore reports the disagreement instead
of choosing a side; a window with too few current events says so; and a corrupt or unreadable log
makes the whole query unavailable rather than yielding an empty but confident history. A pattern is
not evidence that it is reliable because it was detected: the counts and the stated limits are the
whole claim it makes.

### World state and model context

`world` (and the world-state projection built for a model-path answer) now carries a bounded
`temporal` section: event counts, success/failure, capture split, at most three detected patterns,
the window bounds, and the same non-causal limitation. When the experience log cannot be read the
section says `available: false`, the projection stops calling itself complete, and the world command
exits 1. The `world.state` action's audit record keeps counts and pattern kinds only - no window
instants, no evidence ids, and no user text - because the window moves with "now" and would make an
independent re-read disagree with the first by milliseconds.

The model context receives at most six short lines (counts, at most four capability groups, at most
four patterns, and one fixed statement that this describes recorded order only). It is built only
when the request is about time, outcomes, or a represented capability, so an ordinary question does
not pay for it; if the experience store is unreadable and the request was about time, the prompt says
the summary is unavailable instead of implying there is no history. Within the context budget it
gives up its room first - before the world projection and before any retrieved record - and when all
of it is gone the prompt states that it was omitted rather than silently dropping it.

### Measured

`node benchmarks/run-experience-benchmark.mjs --phase temporal`, 2026-11-01, node v26.4.0 on win32,
5 repeats, medians. The fixture now writes records directly in the store's validated shape rather
than driving one real request per event: a temporal query only reads the log, and every read
validates all of those records, so the fixture exercises the same reader a real log would. Seeding
through the request path cost ~two minutes per thousand events and measured the writer, not the
reader. One event in ten is a blocked outcome, one in nine carries corrective feedback, and the
events are spread evenly across the 29 days ending an hour before the benchmark clock, so every
event is inside the default window and the last seven days are a genuine subset.

| Events | bytes | read + validate | derive | timeline (cold) | timeline (warm) | 7-day window | compare | filter (engine) | analysis (engine) | summary (engine) |
|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 76,708 | 2.79 ms | 0.50 ms | 5.19 ms | 2.39 ms | 4.28 ms | 3.47 ms | 0.50 ms | 0.55 ms | 0.04 ms |
| 1,000 | 766,668 | 22.08 ms | 5.27 ms | 34.90 ms | 10.56 ms | 29.50 ms | 33.25 ms | 4.64 ms | 4.03 ms | 0.08 ms |
| 5,000 | 3,841,024 | 248.34 ms | 37.46 ms | 309.58 ms | 100.48 ms | 297.25 ms | 322.22 ms | 32.34 ms | 41.48 ms | 0.01 ms |
| 10,000 | 7,684,268 | 511.63 ms | 109.90 ms | 685.73 ms | 238.66 ms | 653.21 ms | 721.72 ms | 76.05 ms | 82.40 ms | 0.02 ms |

- The bottleneck is the whole-file read, hash, parse, and per-record validation: at 10,000 events it
  is 512 ms of a 686 ms cold timeline query. Lifecycle derivation adds 110 ms; ordering, filtering,
  and pattern detection add 82 ms; the bounded summary costs effectively nothing.
- A narrow window filters the same derived records; it does not read less of the file, so it saves
  only the per-event engine work, not the read. That is why the 7-day column tracks the full query.
- Going from 100 to 10,000 events (100x) multiplied the read by ~184x and the engine analysis by
  ~150x: slightly super-linear, consistent with parse/allocation pressure, but the absolute cost of
  a full query is still under a second at 10,000 events on this machine.
- **Indexing/archival threshold, stated in advance.** No persisted index is added now. The evidence
  says a second source of truth would still have to read and validate every byte, which is the
  dominant cost. Revisit that decision only when either (a) a typical store approaches 10,000 events
  and a cold timeline query exceeds ~1 second, or (b) the store exceeds ~50,000 events. In either
  case prefer time-based archival (a closed month's records moved to a read-only segment) over an
  in-memory index, because every query is already windowed and only needs the records inside it.
  These are thresholds for a future measurement, not an implementation claim.
- Context contribution does not grow with the store: the summary added 588 characters (4 lines) to a
  314-character base prompt on the 10,000-event fixture, about 10% of the 6,000-character budget,
  and the unreadable-store disclosure cost 142 characters. The summary is capped at four capability
  groups and four patterns, and gives up its room before any retrieved memory.
- No index is persisted and none was added.

What this batch does not claim: the numbers are from one machine on synthetic stores, no inference
was run or simulated, and nothing here shows that a temporal summary improves a model answer - only
what carrying it costs and that it cannot change what was recorded. No local inference server of any
kind was installed, downloaded, started, invoked, or recommended.

`tests/experience-temporal.test.js` (33 tests) covers ordering, equal/missing/invalid timestamps,
time-zone normalization, window boundaries, supersession and retraction, repeated success/failure,
alternation, regression and improvement, thresholds, contradictory evidence, automatic vs explicit
capture, corrupt storage, large stores, bounded output, and the audit shapes.
`tests/experience-temporal-adversarial.test.js` (33 tests) covers adversarial histories: outcome
orders that only look like patterns, contradictory and superseded feedback, replaced experiences,
duplicate operation ids, equal timestamps, malformed and zone-less timestamps, inclusive and
DST-day boundaries, adjacent comparison windows, capability scoping, evidence truncated past the
display bound with full counts retained, and the constructed model prompt's disclosures.
`tests/experience-temporal-integration.test.js` (14 tests) drives the four commands through the
assembled application, proves the read paths write nothing, checks restart stability and
verification against a concurrent append, and covers the world-state and prompt integration. All
three are part of `npm test`.

## Batch AE: prediction ledger, hypothesis lifecycle and outcome evaluation (as implemented)

Batch AE gives APEX somewhere to write down what the user expects to happen, keep the recorded
events that expectation was based on, and compare it later against the outcomes the experience log
actually holds. It is infrastructure, not a predictor: nothing in this batch estimates a future
outcome, nothing decides what should be expected, and no stored value expresses how likely anything
is. An expectation is entered by the user, judged only by a deterministic reader, and never allowed
to turn into any of the records that sit beside it.

The point is to keep three questions separately answerable: **what happened** (the experience log),
**what did I expect would happen** (`predictions.jsonl`), and **what evidence established the actual
outcome** (an evaluation record naming the experience it decided from). No read merges them, and no
record of one kind can be produced by a read of another.

### What is kept apart

| Kind of information | Where it lives | Who can write it | What it must never be read as |
|---|---|---|---|
| Observation | `experiences.jsonl` (Batch Z-AB) | the capture path and the user | an expectation |
| Explicit user feedback | `experiences.jsonl`, feedback records | the user, about one named event | an outcome of anything else |
| Derived pattern | no store: derived at read time by `src/experience/temporal.js` | nobody; it is a read | a cause, an adaptation, or a prediction |
| Hypothesis (a candidate belief derived from patterns) | **not implemented** | — | — |
| Prediction | `predictions.jsonl`, record kind `prediction` | **user origin only** | an observation, a verified outcome, or an authorization |
| Evaluation | `predictions.jsonl`, record kind `prediction_evaluation` | user origin, and only as a verdict the records support | a re-write of the experience it cites |
| Withdrawal | `predictions.jsonl`, record kind `prediction_invalidation` | the user | a deletion; the expectation stays in the log |

**Prediction versus observation.** The prediction ledger is a different file with its own record
kinds, and the experience store's kind list does not contain a prediction. A temporal query, a
`world` belief, and retrieval all read `experiences.jsonl` and therefore cannot see a prediction at
all; a prediction read cannot write an experience. Nothing converts an expectation into an event,
and an expectation's own reader states that it is "an expectation about a later event, not evidence
that anything happened".

**Prediction versus temporal pattern.** A pattern is derived from outcomes already recorded; a
prediction is stated before any outcome exists. A prediction may *cite* pattern kinds, and the
citation is read as a description of the order of past records - never as support for the future. The
reader recomputes which cited kinds the current log still detects and which it no longer does, so a
prediction cannot keep a pattern alive by asserting it.

**Prediction versus adaptation.** No prediction, evaluation, or withdrawal can create, approve,
retire, or modify a behaviour rule. That path is unchanged from Batch Z: `adaptation derive` from the
user's corrective feedback plus an explicit user decision. Each stored record carries
`no_authorization` - "grants no permission, approval, or adaptation to anything" - in its own
limitation list.

**There is still no hypothesis stage,** and this batch does not add one: nothing combines detected
patterns into a candidate belief about the user or the world. The lifecycle implemented here is the
lifecycle of an expectation the user states; the word "hypothesis" in the batch title names that
lifecycle's owner (a person who formed the expectation), not a new record type.

### Storage decision

Predictions live in their own append-only log, `<dataDir>/predictions.jsonl`, with a `WriterLock` on
`predictions.jsonl.lock` - the same `JsonlStore` + lock protocol as every other persistent store
(Batch W). Three reasons decided this, in order of weight:

1. **The separation has to be physical.** `ExperienceStore` validates a *closed* kind list. Appending
   prediction kinds there would require every reader of that log - retrieval, the temporal engine,
   the world-state projection, health inspection, and the write path's own re-validation - to grow a
   "skip prediction records" clause. One clause missed in a future batch silently turns an
   expectation into an event, which is exactly the failure this batch exists to prevent. A separate
   file makes "a prediction is not an observation" a fact about the bytes rather than a convention
   about a field.
2. **The lifecycle semantics differ in kind.** An experience is immutable evidence about something
   that already happened; a prediction is a statement about something that has not, and it can be
   withdrawn, replaced, or judged. Sharing one log would mean one validator, one health report and
   one set of anomaly rules governing both.
3. **Cost isolation.** A prediction read opens the experience log only for the horizons it needs. The
   two logs grow on different axes (see [Measured](#measured)), and keeping them in separate files
   keeps a large ledger from slowing every ordinary experience query.

The alternative - an `experiences.jsonl` kind plus reader clauses - was rejected for reason 1. Nothing
else changed: no existing store, schema, or command lost or gained a field.

### The record, and why it carries no confidence

Every `prediction` record the store writes:

| Field | Rule |
|---|---|
| `schema`, `kind`, `id` | `1`, `prediction`, a fresh UUID; a repeated id in the log is damage and every read and write refuses the ledger. |
| `createdAt` | the store's clock, at record time. |
| `capability` | a real capability name (the same scopable form every other store accepts, 1-64 characters, no control characters). Free text, blank, and `none` are refused, because an unscoped expectation cannot be evaluated against anything. |
| `expectation` | one of `success`, `failure`, `blocked` - the three outcome classes the experience log can establish. There is no `improved` or `succeeded_eventually` for a reader to guess at. |
| `subject` | the user's own words, 1-300 characters. Never copied into the audit record and never sent to a model. |
| `expiresAt` | an explicit horizon, 1 ms to 366 days after `createdAt`. No default horizon: a command that gives none is refused. |
| `confidence` | **always `null`**, with `confidenceReason`: "this build records no confidence: no defensible method exists for supplying one, so none is invented". A caller that supplies one is refused with an error naming the field; a number that appears in a stored record is reported as damage, because no method in this build could have produced it. |
| `evidence` | `supportingExperienceIds`, `contradictingExperienceIds`, `feedbackIds` (20 ids each at most) and `patternKinds`. Also a place `confidence`, `probability` and `score` are refused rather than dropped. |
| `evidenceBasis` | `cited` or `none_cited`, derived from the citation lists and then checked, so a record cannot claim support it does not name. |
| `limitations` | recomputed from the record's own canonical fields by every reader. Storing them means the statement travels with the record; deriving them means the author cannot choose a weaker one: `expectation_not_observation`, `confidence_unavailable`, `no_cited_evidence`, `pattern_kinds_descriptive`, `expiry_not_failure`, `no_authorization`. |
| `provenance` | per kind: `user_recorded` / `user_confirmed` for a prediction, `user_retirement` / `user_confirmed` for a withdrawal, `user_authorized_derivation` / `user_confirmed` for an evaluation, plus the operation id and a bounded (200-character) context. Not supplyable by a caller. |
| `replaces` | up to 10 predictions this one retires. Optional; the replaced records stay readable. |

`probability`, `score`, `weight`, `likelihood`, `certainty`, `status`, `evaluation`, `outcome` and
`outcomeIds` are refused on write and counted as damage on read. The last four because a reader
derives them: a record that stored a state could disagree with the ledger it was read from.

### Lifecycle

State is **never stored**. `resolveStatus` derives it at read time from the records that exist, in
this precedence order - the first rule that holds is the state a reader reports:

| State | Precise rule | What it does not mean |
|---|---|---|
| `invalidated` | a `prediction_invalidation` record names this prediction. | deletion: the expectation, its evidence and its reason all stay in the log, and `prediction history` lists the withdrawal. |
| `superseded` | this expectation is named by another's `replaces`, or is inside a replacement circle. | wrongness. Its verdict, if one was recorded, stays with the record and is still readable. |
| `evaluated` | a `prediction_evaluation` record names it and it has not been superseded. | that anything is verified about the world; it means the ledger holds a verdict computed from records. |
| `awaiting_evaluation` | outcome evidence that could settle it exists inside the horizon, and no evaluation record was written. | a pending failure. It is an unrecorded judgement. |
| `expired` | the horizon passed with nothing inside it that establishes an outcome. | **a wrong prediction.** Expiry is never counted as contradicted and never as matched. |
| `recorded` | still inside its horizon with nothing establishing it. | anything at all about the future. |

`superseded` outranks `evaluated` on purpose: the two derived fields about one record must not
disagree, and a state that counted toward `evaluated` while no denominator includes it would
overstate how much of the ledger was scored. A prediction whose horizon has not started yet is
`recorded` with an explicit "its horizon has not started yet" reason.

Replacement is auditable in both directions (`replaces` forward, `supersededBy` from the reader) and
has one disclosed edge case: a cycle of `replaces` links retires every member and leaves none
standing, so the ledger **names the circle** instead of choosing a winner, and reports it as an
anomaly. Likewise a `replaces` that names a prediction never written is a dangling reference: it is
reported, and `live` / `superseded` are counted over the records that exist rather than by subtracting
the retirement set.

### Evidence lineage

Four kinds of evidence, kept in four places, because conflating them is the classic way a prediction
becomes unfalsifiable:

| Lineage | Where it comes from | Guarantee |
|---|---|---|
| Available at creation | the ids the user cited in the command, stored in the record. | validated against the real records at write time; see below. |
| Added after the prediction | derived at read time from experience records dated after `createdAt` and inside the horizon, split into supporting / contradicting / excluded with reasons. | carries the note "derived at read time from records dated after the prediction; never stored as original support", and cannot be written: the record's own evidence lists are fixed when it is appended. No retrospective leakage. |
| Contradictory | two lists: the ids the user cited as contradicting, and the in-horizon records whose outcome class differs from the expectation. | never merged into the supporting list; both counts are reported. |
| Outcome evidence | the evaluation record's `outcomeExperienceIds` and its single `decidingExperienceId`. | present only when an evaluation was recorded; otherwise the reader states the window it would have judged and what is missing. |

Citation validation is the reason a prediction cannot be built on an event nothing can confirm. Each
cited id must resolve in the experience log - exact UUID, or the id prefix a read prints (a prefix
that matches two records is refused, not chosen). A cited record dated *after* the moment the
expectation is being recorded is refused: what had not happened yet cannot be what it was based on.
A citation that does not resolve is a refusal, not a dropped field. And an unavailable evidence read
is reported as unavailable: `evidence_unavailable` (the store could not be read) is a different
statement from `outcome_unavailable` (nothing recorded establishes it either way), and neither is
reported as "no evidence exists".

### Evaluation

One rule, stated in every output: *"the latest live experience dated inside the horizon establishes
the outcome; only a success, failure, or blocked outcome establishes anything"*. Only an outcome the
experience log already holds can settle an expectation; nothing is inferred from prose, and a missing
event is never a failed prediction.

| Decision | Writes a verdict? | Reason |
|---|---|---|
| `matched` | yes | the deciding experience's outcome class is the one expected. |
| `contradicted` | yes | it is not. |
| `already_evaluated` | no | a verdict exists; a second would duplicate it. |
| `invalidated` | no | the user withdrew the expectation, so it is not scored. |
| `superseded` | no | it judges a statement the user no longer holds. |
| `insufficient_evidence` | no | live records fall inside the horizon, but every one carries an outcome that establishes nothing (`other`, `unknown`). |
| `expired` | no | the horizon passed with no establishing record. Expiry, not wrongness. |
| `outcome_unavailable` | no | nothing inside the horizon has established an outcome yet (or the horizon has not started). |
| `evidence_unavailable` | no | the experience log could not be read - a statement about the store. |

A recorded evaluation is never rewritten. If a fresh read would decide differently, the projection
sets `evaluationStale` and names both readings: the stored verdict stands and the difference is
disclosed. Superseded experiences, undated records, and unclassified outcomes are excluded from the
decision **by name and count**, so a rate can always be reconstructed from what was left out.

Every aggregate rate states its denominator and its exclusions. The denominator is verbatim
`recorded evaluations whose prediction the user has not withdrawn (matched + contradicted)`, and the
named exclusions are `expired`, `awaiting_evaluation`, `recorded`, `invalidated`, `superseded`,
`insufficient_evidence`, `outcome_unavailable`, `evidence_unavailable` - each with its count and
reason. Below `MIN_CALIBRATION_EVALUATIONS = 20` evaluations **no ratio is printed at all**, per
capability as well as overall: the counts are reported and the rate is withheld with the reason
("only 4 evaluation(s), below the 20 needed to state a rate"). Reliability is labelled
`no_evaluations`, `insufficient_sample`, or `counts_only` accordingly. Calibration against confidence
is reported as impossible here, not deferred: `confidence.available: false`,
`predictionsWithConfidence: 0`, because no prediction carries a value to calibrate.

Examples, all from the test fixtures: a `success` expectation on `calc.evaluate` with a later
`success_verified` experience inside the horizon → `matched`, deciding id named. The same expectation
with a `verification_failed` experience → `contradicted`. With only `model_unavailable` records →
`insufficient_evidence`, nothing written. With nothing at all and the horizon passed → `expired`,
which never enters a denominator. With the horizon not yet started → `outcome_unavailable`.

### Authorization and audit

- The three writes (`prediction.record`, `prediction.evaluate`, `prediction.invalidate`) declare
  `permission: 'write'` and `origins: [ORIGIN_USER]`. The registry refuses to register a write action
  for the model origin, so a `PROPOSE_ACTION` naming any of them is denied before it is validated: no
  ordinary model response can create, evaluate, or withdraw a durable prediction, and no model can
  change a prediction's own authorization status - there is no such field to change.
- The four reads (`prediction.list`, `prediction.show`, `prediction.history`, `prediction.summary`)
  accept user and model origins and call no model.
- Creating a prediction is an explicitly authorized operation: it arrives as a user command naming the
  capability, the expectation, the subject and the horizon, with provenance the caller cannot supply.
  Nothing in the router, the capture path, or the controller can append a prediction record as a
  side effect of any other request.
- Verification follows the existing contract: each write's `verify` re-reads the ledger
  independently and compares the minimized projection - id, capability, expectation, subject,
  horizon, citation counts, derived state - and refuses to report success if the read disagrees. The
  record's `confidence` must be `null` in the re-read, a just-recorded prediction must not already
  carry a verdict or a withdrawal, and a refusal (`insufficient_evidence` and friends) verifies as
  "no evaluation recorded, as the evidence requires".
- The audit record carries ids, enums, counts and timestamps only. Subject and reason are user words
  and stay out of `operations.jsonl`, as they do for experiences, feedback, and adaptations.
- Every prediction operation goes through the controller's existing finalization path
  (Batch AB), so the outcome the user sees, the audit record, and the experience capture are decided
  from the same result. A usage or authorization refusal appends no ledger line and no audit step it
  did not earn; a damaged ledger is reported as damaged rather than as empty, and the repair command
  is not offered for it (`prediction health` is the read that names the damage).
- Audit-input minimization was fixed on this surface, and the fix is a demonstration of a defect:
  a credential-like value that a prediction action *refused* was previously copied verbatim into
  `operations.jsonl`, because the audit-input masker masked only a knowledge-only field map.
  `controller.js` now walks the action input's string leaves (`AUDIT_TEXT_FIELDS`, bounded depth 8)
  and replaces credential-like text with `[omitted: contained a password, key, or token]` before the
  input is logged. See `tests/prediction-adversarial.test.js` ("a refused credential-like value").

### Commands

```bash
apex prediction record --capability <name> --expect success|failure|blocked --subject <text> (--expires <iso> | --in-days N)
                        [--supports <id[,id...]>] [--contradicts <id[,...]>] [--feedback <id[,...]>] [--pattern <kind[,...]>] [--replaces <id[,...]>]
apex prediction list   [--limit N] [--capability <name>] [--status <name>]
apex prediction show <prediction-id> | history <prediction-id> | evaluate <prediction-id>
apex prediction invalidate <prediction-id> --reason <text>
apex prediction summary [--capability <name>] [--limit N]
apex prediction health
```

- `record` needs a horizon: `--expires` (ISO instant or `YYYY-MM-DD`, read in UTC) or `--in-days`
  (1-366). An unresolvable or future-dated citation, a made-up capability, a supplied confidence, and
  an expectation outside the three classes are all refused before anything is appended (`input_rejected`,
  exit 1, nothing written).
- `list` is bounded (1-50, default 20), filters by exact capability and by derived status, and says
  when it shows a subset.
- `show` prints the expectation, its cited evidence, what the log holds now, the verdict if one is
  recorded, and the reason it carries no confidence. An id may be shortened the way every other APEX
  id is; a prefix that matches more than one expectation is refused with the number of matches and
  the instruction to use a longer prefix, never resolved by choosing one.
- `history` lists, oldest first, every record that names that one expectation: the prediction, the
  withdrawals and verdicts describing it, and the expectations that replaced it. Nothing is rewritten.
- `evaluate` is the only path that stores a verdict, and it stores one only when the records establish
  an outcome; otherwise it reports the decision and writes nothing.
- `invalidate` keeps the expectation and records the user's reason with it.
- `summary` is the aggregate view: state counts, matched/contradicted with the denominator named,
  exclusions counted, the per-capability groups (at most 20), and the limits.
- `prediction health` is a controller read, not a registry action: it parses the ledger, reports kind
  counts, standing versus superseded expectations, corrupt lines, and anomalies (dangling references,
  replacement circles, a reused record id) with bounded samples. It writes no audit record, calls no
  model, repairs nothing, and exits 0 only when the ledger was fully inspected and nothing requires
  attention. Exit 1 is a report, not a failed read.
- `repair locks` now covers `predictions.jsonl.lock`, and `diagnose` / `status` report the ledger
  (expectations recorded, standing, evaluated) with an explicit note that no confidence is stored in
  any of them.

### Actions

| Action | Permission | Origins | Input | Verification (independent check) |
|---|---|---|---|---|
| `prediction.record` | **write** | user | `capability`, `expectation`, `subject`, `expiresAt`, evidence id lists, `replaces` | an independent ledger re-read agrees about the stored record and every citation; the stored confidence is `null`; a just-recorded expectation carries no verdict and no withdrawal |
| `prediction.evaluate` | **write** | user | `prediction` (id or prefix) | a recorded verdict is present, equal to the one the write reported, and decided from outcome records the ledger can name; a refusal is confirmed by an independent read that finds no verdict |
| `prediction.invalidate` | **write** | user | `prediction`, `reason` | a withdrawal record names the expectation with the exact reason and user retirement provenance, the reader resolves it as withdrawn, and the expectation itself is still in the log |
| `prediction.list` | read | user, model | `limit`, `capability`, `status` | a fresh list gives the same ids, order, counts, and truncation flag |
| `prediction.show` | read | user, model | `prediction` | a fresh detail read gives the same projection, including the derived state |
| `prediction.history` | read | user, model | `prediction` | a fresh history read gives the same records in the same append order |
| `prediction.summary` | read | user, model | `capability`, `limit` | an independent read produces the same counts and the same rate, or the same withheld rate with the same reason |

`prediction health` is deliberately absent from this table: it is a controller read like the other
health reports, not something an origin may request.

### World state and model context

`world` carries an **`Expectations` section of its own**, separate from beliefs, from the
observation-derived parts of the projection, and from the temporal section. A prediction never enters
the observation or belief side: the section states that these are recorded expectations about later
outcomes, lists at most `MAX_PREDICTION_PROMPT_ITEMS = 4` standing items by capability, status and
horizon, and gives the rest as counts. If the ledger cannot be read, the projection adds an explicit
unknown saying so and stops calling itself complete (`complete` now requires a readable prediction
ledger) - it is never reported as an empty history.

The model prompt receives the same bounded view and nothing more:
`predictionPromptShape` / `predictionPromptLines` allow at most 5 lines, each truncated at 320
characters, and each line is capability, expectation class, horizon, lifecycle state, and citation
counts. **No subject text, no reason text, no verdict wording, never the whole ledger.** The first
line states the boundary: these are expectations, not observations; nothing here reports that anything
happened; none of it authorizes an action or approves an adaptation; no prediction in this build
carries a confidence value. An empty ledger contributes no section at all rather than a line
announcing that nothing is expected.

The block is gated on the user's own words, not on capability names: it is built only when the request
mentions a prediction, an expectation, a horizon or a deadline, or a word in the same family
(`predict`, `expect`, `anticipat`, `forecast`, `horizon`, `deadline`, `due`, `soon`, `tomorrow`,
`later`, `next`, `likely`, `chance`, `estimat`). An unrelated answer carries no expectation, because a
line of prose next to recalled records is exactly how "the user expects X" would come to be treated as
"X happened". Within the context budget the section gives up its room line by line before any
retrieved record does, and when nothing of it is left, the per-section omission notice replaces it -
stated rather than silent.

### Measured

`node benchmarks/run-prediction-benchmark.mjs`, 2026-11-01, node v26.4.0 on win32 x64 (12 logical
CPUs, 24 GiB reported memory), 5 repeats, medians, clock fixed at `2026-11-01T10:00:00.000Z`.
Synthetic fixtures, `NoBackend` everywhere: no model was configured, contacted, or simulated in any
phase. "before" is the read path as AE-06 left it; "after" is the same script after AE-08, both on
this machine. `list` is the aggregate read that opens every standing horizon; `summary` and `prompt`
behave the same way.

| predictions / events | `list` before | `list` after | one `horizon` read (after) | `summary` (after) | `prompt` (after) |
|---|---|---|---|---|---|
| 10 / 1,000 | 131.64 ms | 82.16 ms | 33.39 ms | 75.79 ms | 86.57 ms |
| 50 / 1,000 | 1,086.95 ms | 437.68 ms | 58.56 ms | 407.09 ms | 409.84 ms |
| 100 / 1,000 | 2,068.30 ms | 768.79 ms | 63.14 ms | 723.79 ms | 740.57 ms |
| 200 / 1,000 (178 standing) | 3,931.39 ms | 1,449.04 ms | 62.22 ms | 1,375.88 ms | 1,216.00 ms |
| 50 / 100 | 346.22 ms | 50.48 ms | 8.80 ms | 49.41 ms | 50.61 ms |
| 50 / 5,000 | 4,661.22 ms | 1,591.93 ms | 317.54 ms | 1,684.97 ms | 1,718.91 ms |

What changed, and why: the ledger read used to open the experience log once per standing expectation.
The whole-file read, the hash, the per-record validation and the lifecycle derivation - about one
`horizon` column each - were therefore repeated 178 times on a 200-expectation ledger. An aggregate
read now takes **one snapshot of the experience log per operation** and slices every horizon out of
it, so those four steps happen once. The snapshot is read-scoped and never retained: `list()`,
`calibration()`, `promptView()` and `world()` are unaffected by a write that lands after they return,
and a read that names one expectation still opens exactly one horizon and takes no snapshot at all.
A single-horizon read (`show`, `history`) is unchanged at ~75 ms, as are the ledger-only reads
(`load`, `project`, `status`, `health`), which never open a window.

Rejected alternatives: bounding or caching the horizon reads themselves, which would silently change
the counts published in `summary` and calibration - a count that omits part of the log is a false
number, not a cheaper one; and a persisted or cross-operation cache, which Batch V measured and
rejected for the same reason it does not remove the whole-file read.

- **Truthfulness improved with the speed.** Before, 178 horizons described 178 different instants of
  the experience log, so one read could report an event as inside one expectation's horizon and
  outside another's because the file changed mid-operation. Now every horizon in one projection
  describes the same instant. The regression tests prove the shared and per-horizon paths return
  byte-identical projections and identical calibration.
- **Residual cost, stated in numbers.** After the change, the cost that still grows per standing
  expectation is the window slice plus pattern detection over the shared log: about 7.8 ms per
  expectation at 200 predictions / 1,000 events (`list` 1,449 ms minus one 62 ms `horizon`, over 178
  standing). The cost that grows with the log is one whole-file read plus validation: 8.80 ms at 100
  events, 317.54 ms at 5,000.
- **Threshold, stated before it is reached.** No persisted index is added now. Revisit that decision
  only when (a) a real ledger approaches 200 standing expectations *and* an aggregate prediction read
  exceeds ~2 s on this machine, or (b) the experience log approaches 5,000 events, at which point the
  single shared read - not the per-expectation slice - is the dominant term. The two changes that
  could actually move the ceiling are the same ones named in
  [V-07: the read path after the write changes](#v-07-the-read-path-after-the-write-changes): a store
  that can be read without hashing every byte, or time-partitioned experience segments. Either is a
  storage-behaviour change with its own tests, not something to attempt from a read optimization.
- Writes, before → after (50 expectations in 62 records over 1,000 events): append 20.60 → 17.93 ms,
  uncontended lock section 40.96 → 36.50 ms, `record` (no citation) 60.39 → 63.06 ms, `record` citing
  three events 155.12 → 174.96 ms, `record` through the authorized action 172.11 → 173.40 ms,
  `evaluate` with a verdict 148.87 → 143.39 ms, `evaluate` that writes nothing 113.00 → 100.68 ms,
  `invalidate` 74.76 → 58.06 ms. The two that moved most are cross-store citation validation (an
  extra bounded read of the experience log) and a write-path re-projection; both grew with the
  snapshot change and are within the spread of individual repeats. No write is constant time: each
  re-reads and hashes the whole ledger inside its lock, exactly as memory and knowledge do.
- Contention, real child processes appending from a shared start: 1 / 2 / 4 concurrent writers, 5 / 10
  / 20 attempts, **all accepted** (5/5, 10/10, 20/20), ledger totals 18 / 23 / 33 records for 13
  seeded, every id distinct, attempt medians 14 / 13 / 13 ms, 0 refusals, 0 corrupt lines, 0 partial
  residue, and **0 records carrying a confidence value** on every row.
- Context contribution does not grow with the ledger: on a 243-record / 178-standing fixture the
  section is 4 lines and 913 characters, naming 4 of 178 expectations (the bound) and counting the
  rest. It added 1,017 characters to a 299-character base prompt - 17.0% of the 6,000-character
  budget. An unreadable ledger costs one 200-character sentence that says the ledger could not be
  read. The same section attached to a request whose words did not make it prediction-shaped added
  **exactly 0 characters** to a 271-character base, measured on the same request. `promptView()` on
  the 243-line ledger measured 1,235.92 ms median (1194.13 min, 1435.55 max) after the change against
  4,051.27 ms before; the same call on a 13-line ledger is 112.39 ms, so the section's *size* is fixed
  while its read cost is not.

What this batch does not claim: no predictive intelligence is implemented, and nothing measured here
shows that a recorded expectation improves a later answer - only what recording, judging, and
refusing one costs. Every number is from one machine on synthetic stores. Nothing in this batch
installed, downloaded, started, invoked, or recommended a local inference server of any kind; no model
ran in any phase, and no test in `npm test` runs one. A prediction is an expectation, and this build
cannot produce a probability for it.

### Tests

Six files, 128 tests, all registered in `npm test`:
`tests/prediction-store.test.js` (33) - the record and its field rules, the refusal of a
caller-supplied confidence, citation resolution against the real log, bounded lists, the read-only
`status` and `health` views, restart, and the AE-8 block that pins the shared experience snapshot (one
snapshot per aggregate read, byte-identical projections and counts against the per-horizon path, no
snapshot for a read that names one expectation, and a snapshot that cannot be taken costing the old
read rather than losing a horizon);
`tests/prediction-lifecycle.test.js` (25) - every state and its precedence, expiry versus a wrong
prediction, a verdict that is never rewritten, replacement and withdrawal, excluded evidence counted
by reason, per-capability denominators, the sample floor that withholds a rate, and the limitation
codes a reader recomputes;
`tests/prediction-integration.test.js` (18) - the seven commands through the assembled application and
the real CLI, the audit shape, the model-origin refusal at both the registry and the store, a
prediction that never becomes an experience even with automatic capture on, and the operational
surface (`status`, `diagnose`, `repair locks`);
`tests/prediction-context.test.js` (13) - the word gate, the bounds, the whole ledger never injected,
an expectation kept out of the sections that describe what happened and out of the belief list, the
unavailable-ledger disclosure on both surfaces, and the budget order;
`tests/prediction-adversarial.test.js` (21) - forged and hand-edited ledgers, every field a writer may
not supply, a reused record id, a replacement ring, a dangling replacement, a second contrary verdict,
an outcome from the wrong capability, horizon edges at one millisecond, expectation-shaped prose and a
model plan naming a prediction command, a credential-shaped subject that reaches neither ledger nor
audit log, and an audit append that fails after the line was written;
`tests/prediction-concurrency.test.js` (18) - real child processes racing record, replace, evaluate and
withdraw on one ledger, a live holder, a writer killed holding the lock and one killed between appends,
an unreadable claim, a corrupt line, a reused id, a reader running alongside writers, reads that take
no lock, and the lock's `diagnose` / `repair locks` recovery. `tests/fixtures/prediction-writer-child.mjs`
is the child process the concurrency suite runs.

## Batch AF: cross-store integrity audit (as measured)

AF-14 inspected every persistent file the application owns, AF-15 tested what happens when an append
or an audit write fails, and AF-18 ran several real processes against all of them at once. This section
is the inventory those three produced: who owns each file, what may write to it, how a line is
validated, and what coordination protects it. It is a description of the code as it is, not a claim
that the design is gap-free - the bypasses are listed, because a list without them would read as one.

### The nine files, and what each one is owned by

| File | Owner module | What may write it | Coordination | Per-line validation |
| --- | --- | --- | --- | --- |
| `memory.jsonl` | `src/memory/memory-store.js` | `memory.add`, `memory.correct`, `memory.save_conclusion` | `WriterLock`, waits up to 10 000 ms | `validateMemoryRecord`; `contentSha256` is recomputed by the independent verifier and on read-back |
| `knowledge.jsonl` | `src/knowledge/knowledge-store.js` | `knowledge.add`, `knowledge.retract`, `knowledge.resolve` | `WriterLock`, 10 000 ms | `validateKnowledgeRecord` (claim, retraction and resolution kinds each have their own shape) |
| `experiences.jsonl` | `src/experience/experience-store.js` | `experience.record`, `feedback.record`, `adaptation.derive/decide/retire`, and bounded automatic capture | `WriterLock`, 10 000 ms | `validateExperienceRecord`; every read recomputes the record's evidence hash against `operations.jsonl` |
| `predictions.jsonl` | `src/prediction/prediction-store.js` | `prediction.record`, `prediction.evaluate`, `prediction.invalidate` | `WriterLock`, 10 000 ms | `validatePredictionRecord`; citations are re-resolved against `experiences.jsonl` on read |
| `tasks.jsonl` | `src/tasks/store.js` | a task transition: created, step result, approval, completion, interruption | its own protocol (see below) | `validateEventShape`. It is an event log: the current task is reconstructed by reads, never stored as one line |
| `task-summary-queue.json` | `src/tasks/summary-queue.js` | a writer whose conversation append failed, and the reader that later delivers it | its own lock, 2 000 ms wait | JSON, not JSONL; holds only unsaved turn summaries - never task state or audit evidence |
| `conversation.jsonl` | `src/memory/conversation-store.js` | each completed request turn and delivered task summary | none: an unlocked append | `validateTurn`, and no parse cache, so a reader reparses the log it bounds |
| `operations.jsonl` | `src/operations/operation-log.js` | `finalizeOperation`, once per operation, whatever the outcome was | none: an unlocked append | `validateOperation`, secret-redacted, and no parse cache |
| `session.json` | `src/session.js` | first use (create-once) and `apex new` (atomic replace) | none needed for one small file, replaced atomically | a readable file without a `sessionId` is corrupt, not fresh; corrupt is never treated as missing |

Four of these keep a parse cache and three do not, which is a read-cost difference only: every write
path still reads the whole authoritative log under its lock before appending.

The write boundary is the same for all nine. A store's mutating method is reached only through a named
controller command, which runs the action through the registry, so the origin check, the authorization
decision, the independent verifier and the audit append are one path. A model origin cannot reach any
of these writes: the write actions declare `origins: [ORIGIN_USER]`, and the record-of-experience and
record-of-prediction actions are additionally `plannable: false`, so a plan cannot name them at all.
Nothing in the application writes outside `APEX_DATA_DIR`, and the filesystem actions are read-only
inspection of a root that only the composition root selects.

### Three coordination protocols, six lock namespaces

1. **`WriterLock`** (`src/memory/writer-lock.js`) protects `memory`, `knowledge`, `experiences` and
   `predictions`. A claim is published create-once (a hard link of a synced temp file, falling back to
   an exclusive create), the whole read-modify-append runs inside it, and a writer that cannot take it
   within `WRITE_LOCK_WAIT_MS` (10 000 ms, 10 ms backoff capped at 250 ms) is refused with code
   `LOCKED` and a message that ends "nothing was written" - true, because the claim is taken before any
   byte of the record is written. A claim whose `pid` is dead is taken over through an election with
   `TAKEOVER_EPOCHS` (16) abandoned attempts before the store tells the user to run `apex repair locks`.
2. **The task lock** (`src/tasks/store.js`) does not wait. It makes three publication attempts and then
   refuses with "tasks are in use by process N; try again when it finishes", because a queued task run
   would be a second process stepping through the same plan. Recovery reuses the same
   `src/tasks/lock-recovery.js` election as the writer lock, and reports an unparseable holder through
   `identifiedPid`, so a damaged claim is named as unknown instead of inventing a pid.
3. **The summary-queue lock** (`src/tasks/summary-queue.js`) waits 2 000 ms. Its release is asymmetric
   with the other two on purpose: the deferred summary stays in the file until a later request delivers
   it, whereas a lock and its tokens are always removed by the process that made them.

`apex repair locks` is the one deliberate exception to "only a store writes a store": it may remove
abandoned takeover tokens, and it never removes a claim or a record. It inspects read-only first, and a
recovery that decides to act publishes its own exclusive `*.lock.recover` guard (pid, nonce, timestamp)
so two recoverers cannot run at once - the guard is removed by the process that made it, and a second
recovery either refuses while that pid is live or tells the operator to inspect the unfinished guard
file. The AF-18 residue assertion counts such a file: it treats anything in the data directory that is
not one of the nine stores as left behind.

### Paths that bypass a store or writer-lock contract, named plainly

- **The audit log has no lock and no unique index.** `operations.jsonl` accepts an append from any
  process. A line is not torn, because an append is one write of a complete newline-terminated record,
  and AF-18 measured 30-plus concurrent audit lines across four processes with no unparseable line and
  no repeated identifier - but nothing stops two processes writing the same content twice, and nothing
  reorders a line that arrives late.
- **`conversation.jsonl`** is the same unlocked append, for the same reason: a turn is one record that
  no decision depends on.
- **A store append happens before its audit append.** AF-15 observed this from inside a failing audit
  append: the record is on disk and the audit line is not. The disclosure is the contract -
  `finalizeOperation` returns `{recorded, recordError, captureNotice}`, the CLI prints
  `Audit: NOT RECORDED (...)` with exit code 3, and no code path rewrites a `success_verified` status
  to hide the gap. What the store cannot do is undo the write, so the same request retried runs the
  action again: there is no exactly-once execution here, and AF-15 measured a duplicate side effect
  rather than assuming one.
- **`session.json` replacement is last-write-wins.** Creating the first session is create-once and the
  loser adopts the winner's id, but `apex new` renames over the file. Two concurrent `apex new` calls
  leave one pointer and two ids; history is never lost, only which conversation is current.
- **Reads take no lock.** A reader can observe a store between two appends, so read paths bound what
  they read and describe what they saw - they do not claim a snapshot consistent with a write that is
  still in flight.

### What the AF-18 multi-process runs showed

`tests/cross-process-stress.test.js` (5 tests in 4 suites) and its fixture
`tests/fixtures/cross-store-writer-child.mjs` run the production controller from separate `node`
processes released together by a file barrier, then read the files back. Measured in that suite:
four processes writing all five stores produce exactly the records they reported, with no repeated
identifier in any store, no unparseable or unterminated line, and no lock, token or temp file left
behind; eight processes correcting one claim produce exactly one replacement, because the loser re-reads
under the lock and is refused with "that claim was already corrected"; a live holder makes three
concurrent requests refuse, each printing the holder's pid and "nothing was written" with a non-zero
exit while the store gains no record, and the next process after the holder is killed recovers the
abandoned claim and writes. Task-lock contention is real and visible: a plan that is stored may be
followed by a run refusal that names the holder, which is why the fixture reports a line for every
label it was asked to attempt.

The suite does not show that a lost audit record is impossible, and it is not a benchmark. It pins the
structural guarantees - presence, uniqueness, parseability, and an honest disclosure when either fails.

## Batch AF: capability authorization inventory (as registered)

AF-19 asked for every registered action, with what each one is allowed to do. Two things are uniform
across the whole set, so they are stated once instead of per row:

- **Audit.** Every route that can end an operation writes one `operations.jsonl` line whatever its
  outcome - `finalizeOperation` is called on success, on a denial, on an input rejection, and on an
  unrouted request. Measured in this batch: a request that ran nothing and a request whose model was
  unavailable each still produced their audit line and their conversation turn.
- **Verification.** All 90 registered actions declare both `validate()` and `verify()` - 92 with a
  filesystem root - so the
  independent verifier runs on every one - including the reads, which are verified against a fresh
  re-read rather than trusted from the first result. Registration refuses an action that omits either.

"Cognitive state" below means persistent state the application records: the belief stores
(`memory.jsonl`, `knowledge.jsonl`, `experiences.jsonl`, `predictions.jsonl`) and, since Batch AG,
the executive stores `goals.jsonl` and `plans.jsonl`. The executive records are intentions, not
beliefs - a goal or a plan says what the user asked for and what was proposed, never what is true.
The task log, the conversation log and the audit log record what happened; changing them is not a
change of belief. **Class** is the registry's own `permission`.
**Origins** is the registry's `origins` list. **Plan-time** is what a plan may contain, measured through
`checkSteps()` and the planning prompt, which now consult one predicate. **"nothing (measured)"** means
the action ran to `success_verified` in an isolated data directory and no store file changed size.

| Capability | Origins | Class | Plan-time | What it writes | Auto-capture | Cognitive state |
| --- | --- | --- | --- | --- | --- | --- |
| `memory.add` | user | write | refused in a model plan, allowed in a user plan | `memory.jsonl` | yes | yes |
| `memory.correct` | user | write | never in a plan | `memory.jsonl` | yes | yes |
| `memory.save_conclusion` | user | write | never in a plan | `memory.jsonl` (a `model_conclusion`) | no (model-words) | yes |
| `memory.list`, `memory.search` | user + model | read | offered to both | nothing (measured) | no (read) | no |
| `knowledge.add` | user | write | never in a plan | `knowledge.jsonl` | yes | yes |
| `knowledge.retract` | user | write | never in a plan | `knowledge.jsonl` | yes | yes |
| `knowledge.resolve` | user | write | never in a plan | `knowledge.jsonl` | yes | yes |
| `knowledge.list`, `knowledge.search` | user + model | read | offered to both | nothing (measured) | no (read) | no |
| `experience.record` | user | write | never in a plan | `experiences.jsonl` | no (self-bookkeeping) | yes |
| `feedback.record` | user | write | never in a plan | `experiences.jsonl` | no (self-bookkeeping) | yes |
| `adaptation.derive` | user | write | never in a plan | `experiences.jsonl`, or nothing when no group qualifies | no (self-bookkeeping) | yes |
| `adaptation.decide` | user | write | never in a plan | `experiences.jsonl` (one decision line) | no (self-bookkeeping) | yes |
| `adaptation.retire` | user | write | never in a plan | `experiences.jsonl` | no (self-bookkeeping) | yes |
| `adaptation.guide` | user | write | never in a plan | `experiences.jsonl` (one guidance line) | no (self-bookkeeping) | yes |
| `adaptation.list` | user + model | read | offered to both | nothing (measured) | no (read) | no |
| `adaptation.eligibility` | user + model | read | never in a plan | nothing (measured) | no (read) | no |
| `adaptation.effectiveness` | user + model | read | never in a plan | nothing (measured) | no (read) | no |
| `adaptation.reviews`, `adaptation.review.inspect`, `adaptation.review.reconcile` | user + model | read | never in a plan | nothing (measured) | no (read) | no |
| `adaptation.review.open` | user | write | never in a plan | `experiences.jsonl` (one review line) | no (self-bookkeeping) | yes |
| `adaptation.review.decide` | user | write | never in a plan | `experiences.jsonl` (one decision line; a retirement also appends the existing retirement line) | no (self-bookkeeping) | yes |
| `evidence.integrity` | user + model | read | never in a plan | nothing (measured) | no (read) | no |
| `experience.list`, `experience.show`, `experience.timeline`, `experience.trends`, `experience.patterns`, `experience.compare` | user + model | read | offered to both | nothing (measured) | no (read) | no |
| `prediction.record` | user | write | never in a plan | `predictions.jsonl` | no (expectation) | yes |
| `prediction.evaluate` | user | write | never in a plan | `predictions.jsonl`, or nothing when no outcome has resolved yet (measured: verified, nothing written) | no (expectation) | yes |
| `prediction.invalidate` | user | write | never in a plan | `predictions.jsonl` | no (expectation) | yes |
| `prediction.list`, `prediction.show`, `prediction.history`, `prediction.summary` | user + model | read | offered to both | nothing (measured) | no (read) | no |
| `prediction.longitudinal` | user + model | read | never in a plan | nothing (measured) | no (read) | no |
| `app.status` | user + model | read | offered to both | nothing (measured) | no (read) | no |
| `calc.evaluate` | user + model | read | offered to both | nothing (measured) | no (read) | no |
| `world.state` | user | read | never offered to a model plan | nothing (measured) | no (read) | no |
| `world.entity.add`, `world.entity.alias`, `world.entity.retire`, `world.entity.merge`, `world.entity.unmerge`, `world.identity.decide`, `world.fact.add`, `world.relationship.add`, `world.event.add`, `world.statement.retract`, `world.statement.supersede` | user | write | never in a plan | `world-model.jsonl` (append-only; each record names its evidence) | no (world-model) | yes |
| `world.entity.list`, `world.entity.show`, `world.entity.find`, `world.facts`, `world.attributes`, `world.relationships`, `world.events`, `world.conflicts`, `world.related`, `world.history`, `world.statement.history`, `world.identity.candidates`, `world.identity.decision`, `world.pair`, `world.evidence`, `world.changes`, `world.state_at`, `world.inspect`, `world.status` | user | read | never offered to a model plan | nothing (measured) | no (read) | no |
| `filesystem.list`, `filesystem.read` | user | read | never offered to a model plan | nothing (measured) | no (filesystem) | no |
| `goal.add`, `goal.revise`, `goal.confirm`, `goal.update`, `goal.evidence`, `goal.complete`, `goal.link` | user | write | never in a plan | `goals.jsonl` (and `operations.jsonl`; a revision resets criterion evidence, completion re-checks the audit log) | no (executive) | yes |
| `goal.list`, `goal.show` | user | read | - | nothing (measured) | no (read) | no |
| `proposal.create` | user request; the proposal itself is model-origin | not a registered action | its proposals are checked step by step | `proposals.jsonl` + `operations.jsonl` | no (executive) | no (a suggestion, not a belief) |
| `proposal.accept`, `proposal.reject`, `proposal.invalidate` | user | write | never in a plan | `proposals.jsonl`; acceptance may also write `goals.jsonl` or `plans.jsonl` through the ordinary store operation | no (executive) | yes |
| `plan.add`, `plan.revise`, `plan.approve`, `plan.cancel`, `plan.supersede` | user | write | never in a plan | `plans.jsonl` (linking also updates `goals.jsonl`) | no (executive) | yes |
| `plan.list`, `plan.show`, `plan.validate` | user | read | - | nothing (measured) | no (read) | no |
| `plan.candidates`, `plan.replan` | user + model | read | offered to both | nothing (measured) | no (read) | no |
| `plan.outcome` | user + model | read | offered to both | nothing (measured) | no (read) | no |
| `plan.assess` | user | write | never in a plan | `plans.jsonl` (one `plan_assessment` event; the plan record's own bytes, status, approval and timestamp are unchanged) | no (executive) | yes |
| `plan.activate`, `plan.reconcile` | user | not a registered action | - | `plans.jsonl`, `tasks.jsonl`, `operations.jsonl` when a plan is activated | no (executive) | through the created task only |
| `plan.continuation` | user | not a registered action | - | `operations.jsonl` (its own audit line); the plan, task, goal and belief stores are unchanged, measured byte for byte | no (read) | no |
| `plan.continue` | user | not a registered action | - | `tasks.jsonl` per step it takes up, each step's own store, `plans.jsonl`, `operations.jsonl` | no (executive) | through the steps it takes up only |
| `recover` | user | not a registered action | - | `operations.jsonl` + a conversation turn; reads the stores and changes nothing | no (read) | no |
| `model.answer` | user request; anything it proposes runs as `model` | not a registered action | its proposals are checked step by step | `conversation.jsonl` + `operations.jsonl` | no (model-words) | no |
| `task.plan` | user | not a registered action | - | `tasks.jsonl` + `operations.jsonl` | no (task) | no |
| `task.run` | user | not a registered action | - | `tasks.jsonl` per step, each step's own store, a conversation summary, `operations.jsonl` | no (task) | through its steps only |
| `task.approve` | user | not a registered action | - | `tasks.jsonl` (one transition) | no (task) | no |
| `task.retry`, `task.cancel` | user | not a registered action | - | `tasks.jsonl` | no (task) | no |
| `task.explain` | user | not a registered action | - | `operations.jsonl` + a conversation turn | no (task) | no |
| `task.step` | the origin the step runs under | audit label, not an action | - | one audit line per step | no (task) | no |
| `executive.status` | user | not a registered action | - | `operations.jsonl` + a conversation turn; reads the goal, plan, task and continuation records and changes nothing | no (read) | no |
| `executive.prepare`, `executive.approve` | user | not a registered action | - | `plans.jsonl` through one verified `plan.add` / `plan.approve` step, plus `operations.jsonl` and a conversation turn | no (executive) | yes |
| `executive.execute` | user | not a registered action | - | whatever the plan's own steps write, each under its own operation record; this outer record carries no step of its own | no (task) | through the created task only |
| `executive.clarify` | user | not a registered action | - | `operations.jsonl` + the question it produced | no (no-action) | no |
| `none` | either | a request that routed to no action | - | `operations.jsonl` (+ the turn it produced) | no (no-action) | no |

`filesystem.list` and `filesystem.read` appear in the registry only when `APEX_FILESYSTEM_ROOT` is
configured; there is no default root, and a model proposal cannot supply one, so the count is 90
registered actions by default and 92 with a root. Batch AG added ten user-origin write actions
(`goal.*` and `plan.*`); Batch AH added four more (`goal.revise` and the three `proposal.*` decision
actions); Batch AI added thirty World Model actions (eleven writes and nineteen reads); Batch AL added
two more user-origin writes (`goal.confirm`, the user's own decision about a success criterion APEX
inferred, and `plan.assess`, which records the outcome assessment APEX derives from its own records) and
three reads (`plan.candidates`, `plan.replan`, `plan.outcome`: the candidate set a goal supports, the
comparison of it, and what a plan's execution established and left open - all read-only, and none of
them recording or approving anything). No World Model write is
plannable and every World Model read is user-origin, so the planning prompt offers exactly 20 reads to
a model origin and 43 actions to a user origin with a root configured (41 without one).

### The inconsistencies this found, and what became of them

- **Fixed: the planning prompt offered an action the plan checker always refused.** `memory.add` is the
  one write action left plannable, and `checkSteps()` refuses it for a model origin because its content
  would then be stored as a user fact the user never authored - the same reason `knowledge.add` is
  unplannable. But the prompt built its own list from a copy of those rules, so it still printed
  `- memory.add (write)`, and a model that used the action it was shown had its whole plan rejected
  ("nothing was stored"). Both sides now call one `planRefusal()` predicate, so the prompt is exactly
  the set of actions that could survive a check: measured, 17 read actions for a model origin and 21 for
  a user origin. `tests/capability-inventory.test.js` pins both sets and re-derives the offer rule from
  `checkSteps()` rather than from the prompt.
- **Kept, and named: `memory.add` is the only write action that may be plannable.** Making it
  `plannable: false` would be the tidier inventory, but the plan-time refusal it replaced is pinned by
  three suites in its own words, and the per-step approval machinery it exercises (`task approve --step`,
  `AWAITING_APPROVAL`) is reachable only through a plannable write action. The asymmetry is therefore
  deliberate and is asserted as such: the inventory test requires every write action to be either
  unplannable or refused for a model origin, so no write can enter a model's plan at all.
- **Not a defect, but easy to misread:** `adaptation.derive` and `prediction.evaluate` can end a
  `success_verified` operation having written nothing, and say so in the step summary ("nothing written").
  A verified operation is not the same as a changed store.
- **Cosmetic:** `memory.save_conclusion` is the only action with no `inputHint`. It cannot reach a plan
  at all, and the prompt renders `Input: {}` only for the actions it offers, so nothing is misdescribed -
  but the inventory test now requires a hint for every action that *is* offered, which is the case that
  matters.

## Batch AF: what stops a credential, what survives damage, and what none of it claims

Batch AF was not a capability batch. The question throughout was what is allowed to reach the disk,
what APEX says when a write is refused, and what a reader may claim about bytes it could not parse.
Every statement below names the test file that measured it, and each of those files asserts against
files on disk in a temporary data directory - not against a mock's record of a call. Nothing here is a
security audit, and no sentence below should be read as a claim that APEX is secure: the credential
rules are a pattern heuristic over common formats, and the evidence behind the isolation, concurrency
and integrity statements is a deterministic test suite on one platform (Windows 11, NTFS, the Node
version reported by `npm test`), not an adversarial review.

### Secret redaction: where credential-shaped text is stopped

Detection lives in one module, `src/security/secrets.js` - five pattern families (private-key headers,
cloud access keys, `sk-` API tokens, bearer tokens, `password: x` assignments) plus a field-name rule -
and every writer and printer calls that one rule set. In the order the route meets them:

1. **Refusal, before the store is opened.** A field that is about to be persisted is checked with
   `containsSecret()`, and a match rejects the input: `memory.add`, `knowledge.add` (any of subject,
   relationship, object), `prediction.record` (subject), `experience.record` (subject),
   `feedback.record` (guidance) and `adaptation approve` (its reason, audited under the capability
   `adaptation.approve`) all refuse with
   `status: input_rejected` (`plan_rejected` for a task goal), exit 1, a disclosure that names the
   field, and the value itself nowhere in the output. Measured end to end through the real CLI in
   `tests/audit-secret-redaction.test.js` (the three leaks Batch AF-01 reproduced) and
   `tests/security-end-to-end.test.js` (all four shapes on the memory route, then the knowledge,
   prediction and task routes in one directory: three refusals, three audit records, and
   `operations.jsonl` the *only* file any of them created).
2. **The audit `request` field.** A request holding a credential is recorded as
   `[request omitted: contained a password, key, or token]`; a benign memory write is recorded as
   `remember [content omitted: N chars]`, so the audit keeps the shape of the sentence rather than its
   personal payload; a memory write mixed with other requests is recorded as an omission with a length;
   a refused `task plan` keeps `request: null`, because the goal is only assigned after the check that
   rejected it (all four measured in `tests/security-end-to-end.test.js`).
3. **The whole record, at the one write boundary.** `OperationLog.append` masks recursively over values,
   field names and object keys before anything is serialized, so a field no command declared cannot
   bypass it. A string leaf that matches a pattern, or whose field name alone reads like a credential,
   becomes `[omitted: contained a password, key, or token]` and the record carries
   `secretsMasked: true`. The walk is bounded (depth 8, 4,000 nodes, circular references detected) and
   a bound that stopped the walk is recorded as `auditMaskBoundReached: true` instead of failing
   quietly; a body that cannot be filtered at all is written as a bounded metadata shell marked
   `auditMinimizationFailed: true`, which keeps the linkage (task id, step id, capability, counts) so
   the event remains findable. `tests/audit-secret-redaction.test.js` pins all of this, including that
   masking an already-masked record changes nothing and that ordinary text - `mapping`, `monkey`, a
   sentence containing the word `key` - is left byte-for-byte readable.
4. **`output` keeps its prose.** The model-answer field has its own rule: the matched substring is
   removed and the record is marked `outputMinimized: true`, rather than the whole answer being
   dropped. A private-key header loses its entire body, because the value-level rule replaces the whole
   string - a match does not bound a value.
5. **The task log is behind the same boundary.** A model-proposed step input carrying a credential is
   masked before `tasks.jsonl` is written; a clean plan is written unchanged.
6. **Readers do not reprint what they find.** `history`, `diagnose` and the health commands redact a
   credential-shaped value they read out of an existing log, and rewrite nothing while doing it.

**Where redaction stops - the documented boundary, not a gap to be closed quietly.** A request is still
answered, so its text - including a credential the user typed - is sent to whatever endpoint the user
configured, and the model's answer is still shown in the terminal. Detection protects what is
persisted and what diagnostics print. `tests/audit-secret-redaction.test.js` measures this directly:
one request reaches the stub endpoint carrying the typed text, while the audit line on disk holds
`[request omitted` and not the value. Redaction is also not an access control: a caller inside the
process that asks a store for a record gets the record, and anyone who can read `operations.jsonl`
sees its bytes.

### Historical audit records: what they hold, and what will never happen to them

Records written before Batch AF are left exactly as they are. Nothing rewrites, re-masks, reorders or
deletes `operations.jsonl`, because an audit log whose earlier lines can be edited by the program that
writes it is not evidence. So: **treat a `operations.jsonl` written before Batch AF as containing what
was typed**, including any credential-shaped value, until you have decided otherwise yourself.

What APEX does instead is report it, without echoing it (`tests/audit-secret-redaction.test.js`):
- `audit health` exits 1 with the log still described as `ok - fully inspected` and `Corrupt lines: 0`,
  because a stored credential is exposure, not parse damage; it counts
  `Credential-shaped: N record(s)`, names the operations by id, and states that APEX will
  `never rewrite` them.
- `diagnose` exits 1, keeps `Audit: ok`, prints `Audit credential exposure` with
  `1 operation record(s) hold text that looks like a password, key, or token`, and gives the only
  remediation that still exists - rotate the credential where it was issued - alongside
  `APEX does not rewrite or delete operations.jsonl`.
- A new append into such a log is masked and the historical line stays byte-identical; `health()`
  counts only the old line, because a record the boundary masked is not counted as exposed.
- Deleting the file is a user decision, and the cost of it is stated in the same place: the history it
  holds is lost.

### Data-directory safety

See [How a run decides where its data lives](#how-a-run-decides-where-its-data-lives) for the rule and
the isolation flag. Batch AF measured the consequences that rule is for, in
`tests/data-dir-isolation.test.js` (real child processes, a pinned synthetic home) and
`tests/security-end-to-end.test.js` (byte-level before/after snapshots of the whole directory):

- A usage or configuration error exits 2 and changes **no byte** in the data directory - not even a
  `session.json` or a lock file. A mistyped command creates nothing.
- Twelve read-only commands left the directory byte-identical, printed nothing on stderr and exited 0:
  `memory health`, `knowledge health`, `knowledge show`, `knowledge history`, `experience health`,
  `prediction health`, `audit health`, `world`, `history`, `status`, `diagnose`, `task show`. Three
  reads are *not* in that class, because they are operations: `experience list`, `knowledge list`,
  `prediction list` - each adds exactly one `success_verified` record, changes `operations.jsonl` and
  nothing else, and says so in its own output (`Audit: recorded in operations.jsonl`).
- A refused operation creates only an audit record. A refused credential-shaped write does not even
  create the store it refused to write.
- Isolation is enforced at two places (`loadConfig` and `createApp`) so a programmatic caller cannot
  reach a real home directory by omission, and the harness sets `APEX_DATA_ISOLATED=1` for every CLI
  invocation through `tests/helpers.js` `cleanEnv()`, which also strips every `APEX_*` variable so an
  inherited environment cannot redirect a test's writes.

### Store corruption behaviour

The rule Batch AF-17 pinned across every persistent file at once (`tests/corruption-recovery-boundaries.test.js`)
is that **a damaged store is never presented as an empty store**, and that recovery is always explicit:
no command deletes, rewrites, moves or repairs evidence it could not read. What that means in practice,
measured in `tests/security-end-to-end.test.js` against a deliberately torn line:

- Damage is preserved, byte for byte. Every reader was run over the damaged log and the file was
  re-read afterwards: unchanged, in all cases.
- A reader reports the gap rather than inventing around it. `history` exits 0 - a partial read is still
  a read - and prints `(1 corrupt audit line(s) skipped)`, `cannot be read, so this list is incomplete`
  and `A missing record does not prove an action did not execute`. `audit health`, `status` and
  `diagnose` exit 1: inspection of a damaged store cannot yield a clean bill.
- Nothing echoes the damaged bytes. The torn fragment in the fixture contains a credential-shaped
  string; no reader printed it on stdout or stderr, and the only copy on disk stayed the one the test
  wrote.
- An unterminated final line is named as what it is: `line 2: invalid JSON (final line without a
  newline: consistent with an interrupted append; the bytes are preserved and new records start on a
  new line)`. That is not only wording - the append path checks the last byte and starts on a fresh
  line, so a later operation is written, readable, and does not merge into the damage: three physical
  lines, two readable records, the damaged one still unusable.
- An unreadable record cannot become evidence. Referencing its operation id for an experience is
  refused: `is not in the audit log; an experience can only reference an event that was actually
  recorded`.
- Damage is confined to the file it landed in. A torn `memory.jsonl` makes memory *writes* refuse
  (`execution_failed`, `memory store contains 1 corrupt line(s); refusing incomplete write`, `Nothing in
  that store was changed`, the damaged bytes untouched) while an unrelated `knowledge add` still
  succeeds on the same data directory.
- There is no repair command, and the diagnostics say so: `no supported repair command exists. Preserve
  operations.jsonl`, and for a fact store `Preserve memory.jsonl and repair the damaged line outside
  APEX`. `repair locks` touches lock artifacts only, never a store's records.
- Links that depend on unreadable evidence are labelled as partial: `task step -> operation links were
  checked only against readable audit records`.

### Concurrency boundaries

The inventory of the three protocols, six lock namespaces and the unlocked append paths is in
[Batch AF: cross-store integrity audit](#batch-af-cross-store-integrity-audit-as-measured);
[Batch W](#batch-w-cross-process-write-coordination-as-implemented) holds the measured overhead.
Batch AF's contribution was to pin what those boundaries *do not* promise, with real child processes in
`tests/lock-ownership-and-recovery.test.js` (17 tests), `tests/cross-process-stress.test.js` and
`tests/append-audit-failure-semantics.test.js` (15 tests):

- A coordinated write is not queued. `LOCKED` means the wait budget expired and **nothing was written**,
  so it is always safe to retry; `LOCK_LOST` means the record is already on disk and ownership was lost
  on release, so it is **not** safe to retry. The two are different outcomes with different words, and
  the suites pin both.
- Two locks are not one transaction. A command that writes two stores holds the claims independently,
  and an operation spanning a store append, an audit append and a conversation turn can be partly
  recorded if the process dies between writes.
- The budgets themselves are pinned so a later change cannot quietly loosen a timeout or an ownership
  check to make a test pass: the exported wait per protocol, the task lock's bounded publication
  attempts, the 16 takeover epochs, the recovery guard, and the behaviour of a corrupt claim (reported
  as held by an unknown process, never removed).
- Liveness is a check of a recorded process number, not of process identity. A recycled number makes a
  dead holder's claim look live; APEX then refuses both the write and `repair locks`, and leaves the
  directory blocked until an operator resolves it by hand. That is the safe direction, and it is a real
  operational limit, not a solved problem.

### Authorization boundaries

`src/actions/registry.js` is the only place permission is decided, and Batch AF re-measured its shape
through the real CLI (`tests/security-end-to-end.test.js`): a write action presented to the registry
with any origin other than `user` is denied - `UNKNOWN_ORIGIN`, `UNKNOWN_ACTION`,
`ORIGIN_NOT_PERMITTED`, or `WRITE_REQUIRES_USER_APPROVAL` - and a denied step records
`{ decision: 'deny', reason }` with `execution: { status: 'not_run' }`, so the audit says plainly that
nothing ran. The same text on the same store is allowed for a user origin: measured, `remember that the
vault code is 4411` from a model origin is refused with nothing stored and no experience captured, while
the identical request through `apex ask` stores the fact. A refusal is still an audited operation
(`recorded: true`, `decision: refuse_or_block`), because "nothing happened" is a fact worth a record.

The boundary was then attacked rather than only described. `tests/model-self-authorization.test.js`
(AF-20, 17 tests) drives eight attempt families through the real parser, planner, registry, executor,
verifiers, four belief stores and audit log, each against a fixed stub reply: a reply proposing the
user-only writes, a plan that smuggles them as steps, a plan that reports its own status or verdict, an
action that does not exist, a write step that tries to approve itself, an input carrying its own
`provenance`, a proposal carrying its own `authorization`, and a reply that asserts it was verified.
Every one is refused, and none of them is evidence about a real model - the replies are test doubles, and
the suite says so in its own header. `tests/prediction-adaptation-boundary.test.js` (AF-21, 14 tests)
pins the adjacent question: an expectation records nothing outside the prediction ledger, a verdict on
records grants no permission, and no matched or contradicted outcome moves an adaptation candidate - only
an explicit user decision does. Both assert against the files that end up on disk, because a rendered
string can be reworded and an append-only log cannot.

Two asymmetries are named rather than smoothed over:

- **`MemoryStore.add()` does not re-check the operation origin.** `KnowledgeStore.add/retract/resolve`,
  `ExperienceStore` and `PredictionStore` all refuse a non-user origin inside the store, and
  `MemoryStore.correct()` does too, but `add()` (`src/memory/memory-store.js`) validates content, kind,
  sensitivity and provenance and then writes. Today that is safe by construction: `memory.add` declares
  `origins: [user]`, `authorize()` denies anything else, a model plan is refused the action at
  `checkSteps()`, and `tests/security-end-to-end.test.js` measures the refusal. It is still the one
  write path whose user-only guarantee lives in the registry instead of the store, so a future caller
  that reached the store directly would write a `user_fact` nobody user-authorized. Batch AF documents
  this rather than silently adding a check at the end of a hardening batch, because the fix is a
  contract change to a store that a dozen existing suites drive without naming an origin - it should
  land with a test that names it.
- **A plan is a proposal, and its record claims nothing about execution.** `task.plan` is written with
  `decision: propose_action` and `steps: []`; each step gets its own `task.step` record under the origin
  the step ran on, and `task.run` closes the operation. Measured in `tests/security-end-to-end.test.js`:
  a two-step plan (a calculation and a memory write) produced exactly `['task.plan', 'task.step',
  'task.step', 'task.run']`, the step records matched one-to-one against the transitions in
  `tasks.jsonl` by `operationId` and outcome, and `memory.jsonl` gained its record only when the run
  executed the write - planning alone stored nothing. A `task run` naming something that matches no task
  is refused as `input_rejected` ("no task matches"), which is a refusal, not a silent no-op.

### What none of this claims

- **Not exactly-once execution.** The store append happens before the audit append, an audit failure
  never rolls the write back, and a retried request runs the action again. `tests/append-audit-failure-semantics.test.js`
  measured a duplicate side effect rather than assuming one away; the disclosure is the contract
  (`Audit: NOT RECORDED (...)`, exit 3), and `diagnose` states that `matching operation identifiers do
  not prove exactly-once execution`.
- **Not "content stays out of the log".** A model answer is stored in `output` (truncated, and masked
  where it matches a pattern), and it can repeat memory content. That is a known limitation, not a new
  one.
- **Not a guarantee against an unusual credential format.** Five pattern families plus a field-name
  rule, bounded depth and node count. `tests/audit-secret-redaction.test.js` pins what the mask catches
  and what it lets through as readable text.
- **Not real-model evidence.** No test in `npm test` runs a real model, and nothing in Batch AF was
  measured against one: the credential boundary at the model call was exercised against a local stub
  that records what it received. The dated real-model observations in
  [Capability status](#capability-status) predate this batch and are not evidence about it.

## Batch AI: World Model, entity memory and evidence graph (as implemented)

Batch AI adds a persistent World Model: an append-only record of the entities the user has
described, the facts, relationships, and events they have asserted about those entities, the
evidence each assertion cites, and the identity decisions they have taken. It is a separate store
from the read-only `world` projection. `world` derives a counts-first view from memory, knowledge,
experience, prediction, and task records at read time and persists nothing; the World Model keeps
its own log, `world-model.jsonl`, and the projection neither reads nor writes it.

The subsystem lives in `src/world/`:

| File | Responsibility |
|---|---|
| `vocabulary.js` | controlled names: entity categories and statuses, fact predicates with cardinality, relationship types with inverse names and symmetry, evidence relations and source types, statement statuses |
| `model.js` | record schema (`schema: 1`), validation of every record type, the pure reducer, canonical ids, normalisation, interval and status helpers |
| `store.js` | the append-only log, evidence validation through supplied adapters, `WriterLock` coordination, reduction at read time, fail-closed reads, `inspect` and lock recovery |
| `query.js` | bounded read projections: entity lists and views, facts, attributes, relationships, events, evidence, history, as-of and prior-belief state, changes, related traversal, statement checks |
| `conflicts.js` | conservative contradiction groups for single-valued predicates and relationships, and statement status |
| `resolution.js` | deterministic identity candidates, exclusion of rejected pairs, and the reasons a pair is listed |
| `context.js` | the bounded, relevance-gated section included in a model-path prompt |
| `format.js` | line-oriented rendering for the CLI and actions |

There is no graph database, no external service, no new dependency, and no second memory or
knowledge implementation. Evidence points at records in the stores that already exist.

### The log is the whole truth

Every write appends one JSON object with `schema: 1`, an `eventId`, a `type`, `at` (stored
time), and `origin: "user"`. The eleven record types are `entity_created`,
`entity_alias_added`, `entity_retired`, `entity_merged`, `entity_merge_undone`, `fact_asserted`,
`relationship_asserted`, `event_recorded`, `statement_retracted`, `statement_superseded`, and
`identity_decision`. `validateWorldRecord` checks shape, bounds, timestamps, references, and
vocabulary on the way in; the reducer applies the same validation again and records a problem
instead of guessing when a line cannot be applied.

Reads reduce the log at read time. There is no cached mutable state file to drift from the log
and no in-place edit: a retraction, a supersession, a merge, and an unmerge are later records.
`world inspect` reports the line count, the corrupt lines, and the records the reducer could not
apply. A normal read of a log containing either is refused with a `StoreError` that names the
count - the application reports an incomplete world rather than an empty one. Writes take the
same `WriterLock` protocol as the other stores (`world lock` reports it, `repair locks` includes
it), and an append re-reads and revalidates the log inside the lock before adding its line.

### Identity is a record, not a guess

An entity has a stable id chosen by the user or generated, a category from the controlled list,
a name, up to 16 aliases, up to 8 external identifiers, an optional description, an observed-at
time, evidence, and a lifecycle status: `active`, `merged`, or `retired`. A name shared by two
entities is reported as ambiguous by `world.entity.show`; a lookup returns every match and never
resolves by position. `world.entity.find` matches a normalized exact name or alias and says which
one matched.

A merge is an explicit `world.entity.merge` that names source and survivor, a reason, and
evidence. It is refused unless the pair has a recorded identity confirmation or a shared trusted
external identifier - a similar name is never a merge basis. The source becomes `merged` and
resolves to the survivor for reads; the merge record, both entity records, and every historical
reference remain stored. `world.entity.unmerge` appends a compensating record, and the original
merge stays visible in history. A retired entity stays readable, and `goal.link` refuses to add a
new link to one; no statement it already holds is rewritten or removed. No read rewrites an id,
and no merge deletes a record.

### Facts, attributes, relationships, and events

A fact is a subject entity, a predicate, and an object that is either an entity reference or a
typed scalar (`string`, `number`, `boolean`, or `datetime`) with an optional unit and language.
It can carry a validity interval (`validFrom`, `validUntil`), an observation time, a stated
confidence (`value` plus `basis`, stored only when supplied), superseded fact ids, and 1-8
evidence references. A missing `validFrom` means validity is unknown; it is never treated as
current. Predicates in the controlled vocabulary declare `single` or `multi` cardinality; an
unknown predicate is accepted as multi-valued and is never used on its own to declare a
contradiction. `world.attributes` is the current-value view over the same facts.

A relationship is a directed or symmetric edge between two entities, with an optional property
map, validity, and evidence. An entity cannot point at itself. A known relationship type declares
its inverse (`employed_by`/`employs`, `located_in`/`contains`, and so on); the inverse is
presented by a query and never stored a second time, so reading either endpoint shows the edge
once per direction and no duplicate record exists to disagree with itself.

An event keeps three times apart: `occurredAt` is when it happened, `observedAt` is when it was
learned, and the record's `at` is when it was stored. A late event is accepted and sorted by
`occurredAt`; a null `occurredAt` is unknown, not now. An event names up to 16 participants,
affected entities, properties, and evidence, and is subject to the same retraction and
supersession records as facts and relationships.

### Evidence is a reference, not a copy

Every assertion requires at least one evidence reference: a relation (`supports`, `contradicts`,
`qualifies`, `supersedes`, `retracts`), a source type (`user`, `memory`, `knowledge`,
`experience`, `task`, `operation`, `prediction`), a source id, and an optional note. The store
resolves the id through an adapter supplied by the composition root and requires that the record
exists, is current, and matches the classification the caller states. A missing adapter is a
configuration error and a lookup failure is a store error; neither is ever read as "no evidence".
A `user` reference must name the user, not another record. A prediction is an expectation, so it
can only qualify context; it cannot be cited as evidence for or against a fact. Model output has
no source type and therefore cannot be cited as a world-model record. Because the reference is an
id into the existing store, retracting or superseding the cited record is visible to later reads
without copying its text into the world model.

### Time

`parseInstant` normalises every stored instant: a date-only value is midnight UTC, and a
date-time must carry an explicit `Z` or `±hh:mm` zone. A local-time string is refused rather than
parsed differently on two machines, so a stored instant does not depend on the reader's time zone.
Three questions are kept separate:

- **What was valid then** - `asOf` filters facts and relationships by their validity interval.
- **What did APEX know then** - `world.state_at` replays only records whose stored `at` is at or
  before the cutoff. A later retraction, supersession, or merge is absent, which is the point.
- **What changed** - `world.changes` reports statements that became valid, stopped being valid,
  were recorded, were withdrawn, or were merged inside a window; a statement whose interval
  merely surrounds the window is not a change. Events report occurrence and learning separately.

`world.history` and `world.statement.history` show the records behind one entity or one
statement in stored order.

### Contradictions are disclosed, never resolved

Contradiction detection is deliberately conservative. A group exists only when two assertions
with a `single`-valued fact predicate (`has_status`, `has_name`, `located_in`, `manufactured_by`,
`owned_by`, `date_of_birth`) or relationship type (`employed_by`, `located_in`, `manufactured_by`,
`owned_by`) have different values and their valid-time intervals overlap. Both sides require a
known `validFrom`; a missing interval cannot establish an overlap. Both sides stay in the store
and in the view, no source is ranked, and no side is selected. `world.conflicts` names each group;
the context section states that the disagreement is unresolved.

Statement status is computed from records in a fixed precedence: missing, retracted, superseded,
validity unknown, conflicting, historical, contested, supported. `supported` is not "true" - it
means the statement is recorded, current, valid at the queried instant, and not in a recorded
disagreement.

### Identity candidates require a decision

`world.identity.candidates` compares one active entity with every other active entity and lists
matches with a kind (`external_id`, `user_confirmed`, `shared_name`, `similar_name`), an ordered
`score`, and the reasons for each entry. Names are normalised, generic words (`inc`, `ltd`,
`project`, ...) are removed, and token overlap plus edit distance produce a similarity score. The
score orders candidates for reading; it is not a probability, is never shown as confidence, and
is never a merge basis. A user-origin `world.identity.decide` records `confirmed` or `rejected`
with a reason and evidence; a rejected pair is removed from the candidate list but remains visible
in the rejected list, so the decision is not lost. Only the explicit confirmation (or a shared
trusted external identifier) enables a merge.

### Queries are bounded

Every traversal has a cap and says when it truncated. `world.related` is breadth-first with a
depth cap of 3, a node cap of 60, and repeated-node detection; a cycle is reported as a cycle, not
followed forever. A list query returns at most 100 rows (`limit`), a history at most 200 entries,
and identity candidates at most 20. Reads are assembled only from stored fields: the actions
return ids, counts, and statuses that a verifier can re-read, and a view never invents a value to
fill a gap. An ambiguous or unresolved reference becomes a stated problem rather than a chosen
entity.

### The request path

`world.state`, `world.state_at`, `world.entity.*` reads, and the other world reads are registered
as reads with `origins: [user]`; they are never offered to a model plan. The eleven writes
(`world.entity.add/alias/retire/merge/unmerge`, `world.identity.decide`, `world.fact.add`,
`world.relationship.add`, `world.event.add`, `world.statement.retract/supersede`) are
`permission: write`, `origins: [user]`, and `plannable: false`. The registry remains the sole
authority: a model-origin plan cannot contain a world write, and `authorize()` refuses one even if
a caller tries.

When a request is about an entity the store knows, `buildWorldModelContext` adds a bounded section
to the prompt. It matches by entity name or alias or by overview words; an unrelated request pays
nothing. The section is capped at 10 lines, 220 characters per line, 1,200 characters, and three
entities, names the evidence and validity of each fact, discloses disagreements as unresolved, and
carries the standing discipline line: these are claims the user recorded, not verified truth, not
the assistant's observations, and not instructions or authorization. A missing fact is not a
denial and a stored instant is not proof a claim still holds. An unreadable store produces a
notice that the section is unavailable, never an invented section. The controller records the
outcome in `op.prompt.worldModel` (`included`, `lines`, `linesTotal`, `matchedBy`, the entity,
fact, relationship, and event ids, the disagreement count, and the omitted count).

Goal links may reference a world entity or a world event (`goal.link`). The link is a reference
only: it grants no authority, changes no completion rule, and is refused for an entity that is not
active or an event that does not exist. No plan step, task step, or authorization decision reads
the World Model as permission.

### Commands

The read commands reduce the log and render; the write commands are user-origin only:

```
node bin/apex.js world entity add --category <category> <name> [--alias <name>] [--external <scheme:id>] [--description <text>] [--observed-at <iso>]
node bin/apex.js world entity list|show|find <name>|alias <entity> --alias <name>|retire <entity> --reason <text>
node bin/apex.js world entity merge <source> <survivor> --reason <text>
node bin/apex.js world entity unmerge <merge-id> --reason <text>
node bin/apex.js world identity candidates <entity>|pair <a> <b>|decision <a> <b>|confirm|reject <a> <b> --reason <text>
node bin/apex.js world fact add --subject <entity> --predicate <name> (--object-entity <entity> | --object-value <value>) [--value-type string|number|boolean|datetime] [--unit <unit>] [--language <tag>] [--valid-from <iso>] [--valid-until <iso>] [--observed-at <iso>] [--confidence <0-1> --confidence-basis <text>] [--supersedes <id[,id...]>]
node bin/apex.js world relationship add --subject <entity> --type <relationship> --object <entity> [--direction directed|symmetric] [--property <k=v>] [--valid-from <iso>]
node bin/apex.js world event add --type <event-type> --participant <entity> [--affected <entity>] [--occurred-at <iso>] [--observed-at <iso>] [--property <k=v>]
node bin/apex.js world statement retract|supersede <id> --target-type fact|relationship|event --reason <text> [--by <replacement-id>]
node bin/apex.js world fact list <entity>|attribute list <entity>|relationship list <entity>|event list <entity>
node bin/apex.js world history <entity>|related <entity>|evidence <entity>|conflicts [<entity>]|statement history <id> --target-type fact|relationship|event
node bin/apex.js world changes --from <iso> --to <iso>|state-at --at <iso>|inspect|health|lock
```

Every write takes evidence; `world fact add` and `world event add` accept the object as an entity
or a typed value, and `world statement retract|supersede` appends a later record rather than
changing the target.

### What Batch AI does not claim

- **Not truth maintenance.** A supported statement is recorded, current, valid, and undisputed in
  the store; it is not verified against the world. No source is ranked and no disagreement is
  auto-resolved.
- **Not automatic entity resolution.** Candidates are deterministic and explainable, but nothing
  merges, retires, or confirms without an explicit user-origin record.
- **Not a derived index.** Reads reduce the whole log, and writes revalidate it inside the lock.
  Measured cost is reported in [Benchmarks](#benchmarks); the measurements did not justify a
  persisted index at the tested sizes, and none was added.
- **Not real-model evidence.** No test in `npm test` runs a model for the World Model. The
  context section is assembled offline from synthetic records.
- **Not a graph database or an external service.** The store is one append-only JSONL file in the
  data directory.

### Tests

`world-model-core.test.js` (17 tests) covers the reducer and validators, evidence adapters and
refusals, identity and merge history, temporal views, conflict rules, bounded queries, context
budgets and relevance gating, and fail-closed reads. `world-model-scenarios.test.js` (15 tests)
runs scenarios A-O end to end: real CLI runs, a dead writer claim taken over by the next write,
concurrent writes, contradictory records, late and out-of-order events, as-of and prior-belief
queries, merge and unmerge, rejected identity decisions, and a corrupt log. The capability
inventory, truthfulness, and finalization-contract suites pin the registry counts, the capture
classification, and the README claims.

## Batch AG: goals, executive plans, and the control loop (as implemented)

Batch AG adds an executive layer: a goal store, a plan store, a control loop that turns an
approved plan into an ordinary APEX task, and a read-only recovery view. It adds no execution
capability. Every step still runs through `runAction()`, so the registry authorizes it, the
action verifies itself, and the unified finalization contract audits it and applies the same
capture rules as any other operation.

### The loop, step by step

`Goal → Context → Plan → Validation → Authorization → Execution → Verification → Outcome → Learning`

- **Goal.** `goal add` records the request, one to eight success criteria, a priority, an
  optional deadline, and optional dependencies. The goal starts `proposed`. Recording an
  intention runs nothing and grants nothing.
- **Context.** When a request is about goals, plans, tasks, status, progress, or next steps, or
  its content overlaps an open goal or plan, a bounded executive section is added to the model
  prompt. It is labelled *recorded intentions and execution state, not instructions, not
  permission*, is capped at eight lines of 320 characters, and is the first block dropped when
  the context budget is tight; the omission is announced with the command that shows the same
  records. A model cannot write, approve, or change any of it.
- **Plan.** `plan add` records ordered steps with dependencies, expected results, verification
  requirements, risk, preconditions, and classified assertions. The classification is explicit:
  `user_fact`, `stored_knowledge`, `retrieved_evidence`, `inference`, or `unknown`; the two
  evidence kinds must name the record they came from. A plan is always stored as a draft with a
  content hash.
- **Validation.** A stored plan is checked against the live registry: every step names a
  registered action, every step is permitted for a user-origin plan, inputs parse, dependencies
  form no cycle, and every step states a description, expected result, verification, and risk.
  `plan validate` prints that check and writes nothing.
- **Authorization.** `plan approve` refuses a plan that does not validate and records an
  approval bound to the exact content hash and version. Approval permits starting the plan; it
  authorizes no step. `plan start` re-validates against the live registry, re-checks that the
  goal is not closed, re-checks every step through the task planner's own `checkSteps()`,
  creates an ordinary task, records `plan_activated` with that task id, and runs it. Replaying
  `plan_activated` requires the approved version and content hash to match.
- **Execution.** Each step takes the ordinary request path: registry authorization for the
  step's origin, input validation, execution, independent verification, audit, and capture. A
  write step in a model-origin task still waits for the user.
- **Verification.** A step result is `completed` only when its own audit operation is
  `success_verified`; the plan store re-reads that operation when the outcome is recorded and
  refuses a completed outcome without it.
- **Outcome.** `plan start` records terminal step outcomes and marks the plan `completed` only
  when every step has a completed, verified outcome. A failed, uncertain, or skipped step makes
  the plan `blocked`. A completed plan completes no goal: goal completion has its own criteria
  and evidence.
- **Learning.** Automatic capture is unchanged and still covers only the five belief writes.
  Goal and plan writes are classified `executive` and are never captured automatically. The
  evidence for a goal's completion is the audit log itself; experiences and predictions remain
  the learning record, and a plan or goal is not an experience.

### Goal lifecycle

`src/goals/model.js` owns the states and the transition table. A transition outside the table
is refused and the event is not appended. The path is `proposed → accepted → active → blocked →
completed`, with `failed`, `cancelled`, `abandoned`, and `superseded` as stopping states. A
completed goal is reopened only by contradicting evidence that states `reopen`, and it returns
to `blocked` with its whole history intact. Every stopping state needs a recorded reason, and
`superseded` must name a live replacement goal. A goal becomes `active` only when all of its
dependencies are completed. Recording a second open goal with the same normalized request is
refused as a duplicate.

Completion is checked twice. The reducer refuses `completed` unless every criterion is
satisfied by supporting evidence; the store re-reads each cited operation before appending and
refuses anything that is not a live `success_verified` record with no errors. The completed
goal keeps a criterion-to-operation snapshot, and `goal complete` verifies that snapshot again
after the fact.

Batch AM added the other half of that rule: a completion is a claim about records that can move
afterwards, so `goal show` and `goal assess` re-open the snapshot's own operations and knowledge
claims and report what they find now. A goal whose proof has been retracted, superseded, contradicted,
or cannot be checked is printed as `NOT SETTLED` with the criterion, the verdict and the operation it
was granted on - never as settled, and never as unproven when the records simply could not be read
(`Not re-checked` says that instead). Nothing reopens a goal by itself: APEX appends no transition,
changes no byte of `goals.jsonl`, and names the user's own command - `goal evidence <id> --criterion
c1 --kind contradicts --reopen`. Recording contradicting evidence on a closed goal is refused unless
`--reopen` is stated, and new supporting evidence cannot be added to a closed goal at all, so a
withdrawn proof is not papered over. A goal that is no longer completed has no completion to check,
and its earlier completion record stays in the status history.

### Plan lifecycle

`draft → approved → active → completed`, with `failed`, `blocked`, `cancelled`, and
`superseded`. A revision is a new version with a required reason; it starts as a draft, inherits
no approval, and must be approved again. Activation is a separate event that names the task it
created, so a plan cannot claim to have run without a task record. Plan outcomes are accepted
only for steps the task log records as terminal, and a completed outcome is re-checked against
the audit log. The plan store never rewrites an existing final outcome; reconciling twice is a
truthful no-op.

### The authorization invariant, in three parts

The batch's operating rule has three separate clauses, each enforced at a different layer:

1. **A plan is not permission to execute.** Approval records that the user accepted these exact
   steps. Starting the plan still validates it against the live registry, and every step is
   authorized again when the task runs it.
2. **A model suggestion is not permission to execute.** All ten goal and plan write actions are
   `origins: ['user']` and `plannable: false`. A model-origin plan cannot contain them, a reply
   that proposes them is denied step by step, and the registry refuses the origin before their
   input is read.
3. **A goal is not blanket permission.** A link is a stored reference (`goal link`); it changes
   no authorization. Goal criteria are evidence, not capabilities, and `goal complete` runs
   nothing and completes no task.

### Recovery and reconciliation

`recover` is read-only. It reads the goal, plan, and task logs; reports interrupted, uncertain,
resumable, and blocked work; names the command that would resolve each item; and exits 1 when
anything needs attention. It never resumes, retries, approves, reconciles, or cancels.

`task resume` never re-runs a step whose outcome is uncertain. The step is resolved from its own
audit record; with no record it stays uncertain. A step interrupted after it started but before
its audit line keeps the operation id allocated before execution, which is how a reader can see
that no audit record exists for it. `plan reconcile` is the explicit, separately authorized
command that copies terminal task outcomes onto the plan. It records only outcomes the plan does
not already hold and never executes a step.

Batch AM added the run-level reading and the one command that acts on it. `plan continuation <id>`
derives, for every step, which of nine states its own records put it in - not started, running,
verified successful, verified failed, blocked, outcome uncertain, awaiting external confirmation,
safe to continue, requires user intervention - and cites the record each state came from. A step
with no operation link is proven not to have started; a step recorded as running while a live
process holds the task lock is running, not interrupted; a step recorded as running with an
allocated id and no audit record for it is outcome uncertain, and is never called failed because
the process stopped. `plan continue <id>` re-reads the plan bytes, the approval that binds them,
the step structure, the live registry, the goal's recorded constraints, the plan status and the
task's ownership, and only then takes up the steps proven never to have begun, under the existing
task lock, per-step authorization and finalization contracts. A materially revised plan or an
approval that no longer binds these bytes needs a fresh approval, not a retry of the command.

Eight interruption boundaries are tested with real child processes that stop themselves at each
one and leave their bytes behind (`tests/plan-continuation.test.js`,
`tests/fixtures/continuation-child.mjs`). Three of them - lost during execution, after execution
but before verification, and after verification but before the audit append - leave byte-identical
records: a step the task log holds as running, its effect in the side-effect file, and no operation
record. APEX cannot tell those three apart and does not pretend to; all three read as outcome
uncertain and none is ever produced a second time.

**One defect the adversarial pass found, and fixed rather than documented.** `plan continue` would take
up the untouched steps of a *cancelled* plan. The derivation re-read the plan bytes, the approval, the
step structure, the registry, the constraints and the task's ownership, and every one of those passed
for a closed record: a cancelled plan's steps really were never started, and its approval really did
bind them. What was missing was the plan's own status, so a command that resumes work resumed work the
user had ended. The reading now re-reads `plan_open` as one of its checks, names the status it found,
and refuses; the steps stay described as untouched, because that is what the records prove, and
`continue.safe` is false beside it. `tests/adversarial-batch-am.test.js` (I-09) pins it from the real
bytes a stopped process left behind, and the suite's other fifteen cases are the batch's adversarial
list: injected prose inside an adaptation record, a hand-appended approval line (which reads as damage,
never as a decision), retired and stale and contradictory guidance, assumed and sentence-shaped
blockers, a retracted blocker's evidence, a model reply claiming it recorded guidance, a registry that
moved mid-interruption, replays and concurrent continuations, an outcome citing an operation the audit
log does not hold, and damaged prediction and experience logs.

Batch AM also put that reading where a user looks for it. Continuation readiness was six states;
it is now seven, and the seventh, `ready to continue`, is the difference between a run that never
began and a run that stopped with steps its own records prove were never started
(`src/executive/vocabulary.js`, `src/executive/readiness.js`). It is read from the continuation
derivation and from nothing else: a plan status and a task status cannot show that a step never
started, so where no derivation was read, no continuation is claimed and the older states stand.
The state is refused - not downgraded silently - while a live process holds the task lock, while a
step still waits for the user's own confirmation, while a dependency holds no verified success, and
wherever the derivation itself refuses. The same reading reaches the ranking: `work` and `next`
print a `continue-plan` candidate whose command is `plan continue <id>`, above the work that has
never started and below the records that settle what is unknown, and the run is placed once - the
`task resume` candidate for the same task is listed as excluded, with the reason, because the plan
command is the one that re-reads the approval, the registry and the constraints before anything
runs. Both are reads: they write nothing, take no step, start no process, and the command they
print is the user's to give. `tests/executive-readiness.test.js` (27 tests) pins the seven states
and the record each is read from, the refusals above, the one-place ranking, the deterministic
order, and a real interrupted run read by a second process through to the command that takes it up.

The batch's thirty acceptance scenarios are pinned by `tests/plan-scenarios-am.test.js` (31 tests: the
thirty numbered cases plus one cross-store consistency check), and they read the shipped implementation
end to end - the goal, plan, task, experience, prediction and audit stores and their transitions, the
registry and its origin authorization, each actions own validator and independent verifier, candidate
generation, the gate-and-dimension comparison, the constraint and guidance ledgers, the outcome
assessment, the continuation derivation, the ranking engine, the task lock and the finalization contract.
Every run a scenario interrupts is interrupted by a real child process
(`tests/fixtures/continuation-child.mjs`), and every run a scenario resumes is resumed by a second
process reading the bytes the first left. No scenario contacts a model: the gateway is the no-backend
one, or a programmatic stub whose reply is fixed text, and all goal, plan, criterion and history wording
is synthetic. Two of the answers the scenarios found are worth stating rather than smoothing over:

- `plan reconcile` records the outcomes the task log has *settled*. A write step the interruption froze
  mid-execution is recorded as running, which is not settled, so reconcile refuses it
  (`input_rejected: no terminal step outcome`) and the plan stays active; the step is `outcome uncertain`
  in the continuation reading, which refuses to replay it and names a new plan as the way forward. That
  is the refusal-by-default rule holding at the boundary a real crash produces, and scenario 18 pins it.
- A revised plan needs a fresh approval, and after the user gives one, activating it is still refused
  when the task log holds an earlier task for that plan in a status that says it may have run
  (`a task <id> already exists for this plan in status failed; it may have run, so a second task is not
  created`). The moved bytes are taken up by a plan the user records again, not by a second task beside
  effects the log cannot tell apart. Scenario 20 pins the refusal and the effect count it protects.

Scenario 30 is the regression question itself, and the answer at the end of this batch: `npm test` (123
test files, the two above included) ran **2,196 tests, 2,194 passed, 0 failed, 2 skipped** in 387.7 s on
Windows 11, Node v26.4.0, in isolated temporary data directories. The two skips are the POSIX-only checks
this filesystem cannot perform, and they were skipped in the prior batches runs too. Before Batch AM the
same script reported 1,929 tests, 1,927 passed, 0 failed and the same 2 skips; the added tests are this
batch's suites plus the fixtures they use to stop real processes. No test in that list runs a model: the
gateway in every one of them is either the no-backend one or a programmatic stub whose reply is fixed
text.

### Failure semantics

- Input a validator rejects is `input_rejected`. A refusal inside execution - an illegal
  transition, a duplicate goal, unmet completion evidence, an approval whose content hash no
  longer matches - is `execution failed`, and the CLI exits 1.
- A plan naming an unavailable capability is stored as a draft whose validation fails. Approval
  and start refuse it, and the draft remains readable.
- A damaged goal or plan log is reported as damaged or degraded by `recover`, and no writer
  appends onto a corrupt log. A damaged log is never presented as empty.
- A blocked plan can be reconciled after the obstacle is resolved; the new terminal outcome is
  recorded and the plan may then complete.

### What the AG tests establish

`tests/goal-system.test.js` (10 tests) covers the goal lifecycle, illegal transitions,
normalized duplicates, dependency ordering, audit-backed evidence, reopening, stopping reasons,
model-origin denial, credential refusal, damaged-log truthfulness, and byte-level append-only
preservation. `tests/executive-control.test.js` (13 tests) covers scenarios A (a goal-linked
plan runs and completes the plan, not the goal), B (an unavailable capability cannot be
approved or started), C (a partial run and a truthful no-op reconcile), E (contradicting
evidence blocks goal completion without rewriting the completed plan), F (model-origin attacks,
a forged activation event, a richer-configuration approval, and content-hash binding), and G
(assertion classification, bounded executive context, budget omission, and real-path context
assembly), plus a byte-for-byte read-only recovery check. `tests/executive-interruption.test.js`
covers scenario D with a real child process killed inside a plan step: the uncertain step is
never re-run, the plan is blocked by reconcile at the user's explicit command, and every store
is unchanged by the read-only recovery inspection. `tests/executive-cli.test.js` (4 tests)
drives the real CLI through the goal and plan lifecycles, an unavailable-capability draft, and
usage errors.

**Limitations.** These are deterministic tests on one platform; no model was consulted, and no
sentence here is evidence about model reasoning. The executive layer plans only what the user
authored: it does not generate goals, choose plans, or act autonomously. A goal's completion
evidence is the audit log, which is parse-checked but not cryptographically anchored. The plan
content hash binds an approval to content; it is not a signature and does not prove who
approved.

## Batch AH: executive reliability, live validity, proposals, and continuation (as implemented)

Batch AH extends the Batch AG executive layer without adding a new execution capability. It
adds goal revision, a model-origin proposal store, live plan validation, plan version history,
a deterministic continuation engine, cross-store inconsistency reporting in `recover`, and
evidence-based adoption of an orphan task after an interrupted activation. Every step still
runs through the ordinary action registry, verifier, audit record, and capture rules.

### Goal revision and approval binding

`goal revise` records a new version of an open goal. It increments the goal revision, replaces
the success criteria, resets criterion evidence (the old events stay in the log and stop
counting), and preserves the previous request, criteria, and reason as history. A plan records
the goal revision it was written for; a later goal revision makes that plan's approval stale.
The plan must be revised and approved again, and `plan start` refuses the old approval rather
than silently reusing it.

### Live plan validity

`assessPlanValidity()` re-reads the state a plan names and reports every current reason it
cannot proceed. The checks are:

- **Status and approval.** For activation, the plan must be `approved`, the approval must name
  the current version, and its content hash must match the current steps.
- **Capabilities.** Each step must name a registered action whose current input validator
  accepts the step input, and the step must be permitted for a user-origin plan.
- **Goal.** The goal must still exist, must not be terminal, must be at the recorded revision,
  and every goal dependency must be complete. A missing goal is reported as unknown, never as
  permission to continue.
- **Evidence references.** Every `stored_knowledge` or `retrieved_evidence` assertion must still
  resolve in the store it names. An unreadable store is reported as unreadable, not as absent.
- **Recorded outcomes.** A completed step's cited operation must still exist in the audit log
  and still be `success_verified`. A plan that already records completed steps is refused for
  activation, so an in-process replay does not run work twice.

The check is read-only. `plan validate` prints it; approval and activation call it again.

### Plan version history and comparison

Every revision is a new stored version with a required reason. `plan history <id>` lists each
version and its reason; `plan compare <id> [--from N] [--to N]` reports structural differences
between two versions. Neither command changes an approval, a step outcome, or a plan status.

### Proposal layer

`propose` asks a configured gateway for a structured proposal. The five kinds are
`goal_create`, `goal_clarify`, `plan_create`, `plan_revise`, and `advice`. Each stored proposal
carries a schema version, content hash, related goal or plan and base revision/version,
evidence references, assumptions, unknowns, invalidation conditions, risk, creation time, a
TTL, the live validation result at creation, and a separate decision event. The statuses a
reader can see are `pending`, `accepted`, `rejected`, `invalidated`, and the derived `expired`,
`invalid`, and `stale`.

A proposal is always model-origin. It is never a user-origin record and never permission:
generating it stores nothing except the proposal and its audit operation. The model cannot
create, complete, approve, activate, or execute a goal or plan, and cannot accept its own
proposal. `proposal accept` is a user-origin registry action; it re-assesses the proposal
against live state and then applies a `goal_create`, `goal_clarify`, `plan_create`, or
`plan_revise` through the ordinary goal or plan store. A created goal is still `proposed`; a
created or revised plan is still a draft with no approval. `advice` acceptance records only
that the advice was read. Every accept decision and its effect are separately audited.

### Continuation engine

`src/continuation/engine.js` is a pure ranking over the records. Candidates include an
interrupted task, an uncertain step, a proposed task or write step waiting for approval, a
plan ready to start, a stale approval that needs revalidation, a draft needing review, a
blocked goal or plan, a completed task whose outcomes are not yet reconciled to its plan, and
an accepted or active goal with no open plan. Each candidate carries the recorded priority
(1 is most urgent, and a missing priority is never invented), a recorded deadline when one
exists, risk, dependencies, readiness, the reasons it was included, and the conditions that
block it. Excluded records carry their exclusion reason. The sort is deterministic. `work`
prints the ranked list and `next` prints the top recommendation; both execute nothing, and
the top recommendation is explicitly not permission.

### Recovery, reconciliation, and consistency

`recover` now reports a separate **Inconsistent records** section: a plan naming a goal that
cannot be read, an approved or active plan whose goal revision moved, an active plan whose
goal is terminal, an active plan whose activation task cannot be read, an approved plan with a
task created before any activation record, and a completed task with plan step outcomes that
were never recorded. The report names the resolving command and states that it repairs
nothing. `reconcile` remains an explicit, separately authorized action that copies terminal
task outcomes only.

`plan start` now handles the crash window between task creation and the activation record.
Before creating a task it reads the task log. If exactly one non-cancelled task names the
plan, its steps are byte-equal to the plan's checked steps, and none of its steps has started,
that task is adopted and run once. If a task may have run, or more than one exists, activation
refuses with an inconsistent-task error and creates nothing. A damaged task log also refuses
activation, because it cannot establish whether a task already exists.

### Concurrency and failure evidence

`tests/executive-reliability.test.js` uses real child processes and the real CLI:

- five concurrent `goal add` processes produce five distinct goals, requests, events, and
  operation ids;
- two concurrent `goal update accepted` processes are serialized, exactly one transition to
  `accepted` is recorded, and the final state is valid;
- an approval and a concurrent revision cannot leave an approval bound to older content;
- a child process killed after task creation but before the activation record leaves a
  recoverable orphan, and `plan start` adopts it without creating a second task;
- a corrupt goal log is reported by `recover` and `work` as unreadable, never as empty, and
  both commands leave every store byte-identical;
- model-origin attempts at every executive write are denied, proposal actions are not
  plannable, and an unregistered capability stays a draft that cannot be approved or started.

### What the AH tests establish

`tests/executive-continuation.test.js` (7 tests) covers live validity, approval binding, goal
revision staleness, proposal creation and decisions, stale proposal refusal, advice that
applies nothing, and continuation ranking. `tests/executive-reliability.test.js` (8 tests)
covers the concurrency, crash-adoption, damaged-store, inconsistency, and model-origin cases
above. `tests/capability-inventory.test.js` pins the registry, capture classification, and
README inventory against the live application.

**Limitations.** These are deterministic tests on one platform; no model was consulted, and no
sentence here is evidence about model reasoning. Proposal generation requires a configured
gateway and is tested only with deterministic synthetic responses. The proposal validator
checks structure and re-checks live state; it is not a proof that a proposal is wise, complete,
or optimally ordered. The continuation ranking is a fixed, evidence-weighted heuristic, not a
planner or a scheduler, and it never executes. Plan history and validity are derived from the
append-only logs at read time; there is no separate index. Cross-store consistency is detected
and reported, not repaired automatically.

## Batch AJ: integrated cognitive reasoning, deliberation and grounded responses (as implemented)

Batch AJ adds one layer that reads the stores APEX already has and decides what the records
support, what they do not, and what must be disclosed. It is deterministic and read-only. It
does not add a store, a model, a planner, or a permission path, and it does not turn a model
answer into a verified fact.

**Where it lives.** `src/cognition/` contains one module per stage:

| Module | Responsibility |
|---|---|
| `vocabulary.js` | Fixed labels: schema version, intents, evidence sources, source status, claim kinds, uncertainty categories, decision kinds, missing-information codes, disclosures, and the numeric bounds shared by every stage. |
| `request.js` | Request understanding: intent classification, entity/goal/plan/task references, time range, ambiguity detection, unsupported-capability detection, and missing-information codes. Intent describes the request and never grants authorization. |
| `evidence.js` | Bounded retrieval from memory, knowledge, experience/feedback, adaptations, temporal summary, prediction ledger, World Model, goals/plans/tasks, conversation turns, and the request itself; reduces each record to one evidence shape carrying provenance, validity, status, and relationships. Per-source and total bounds are counted, and an omitted record is reported as omitted. |
| `claims.js` | Claim extraction from evidence, claim kinds, material/non-material separation, duplicate reduction, and a contradiction map that records both sides of a disagreement. |
| `deliberation.js` | Thirteen ordered deterministic steps: question, subquestions, scope, supporting and contradicting claims, interpretations, assumptions, uncertainty, clarification, conclusion, recommendation, validation, decision, disclosures. |
| `response.js` | Grounding-brief construction under line and character bounds, structured-response schema validation, plain-answer validation, and disclosure wording. |
| `protocol.js` | Extraction, size bound, JSON parse, and whole-structure rejection for an optional `COGNITION` line in model output. |
| `trace.js` | Bounded audit trace: stage names, counts, evidence ids, conflicts, refusal codes, validation results, and the execution-boundary decision derived from the step records (proposals, allow/deny counts, execution and verification, refusal reasons, duration). It never records chain-of-thought, request text, stored content, or model text, and every audit carries `authorizes: false` with the action registry named as the authorization owner. |
| `engine.js` | Runs the stages in order, exposes per-stage timings, and validates model output against the analysis that produced the prompt. |

**What a request can mean.** The classifier distinguishes a general question, a stored-information
question, a World Model question, a historical question, a comparison, an explanation, goal
creation, goal progress, planning, plan review, next step, task execution, clarification,
feedback, an unsupported capability, and an ambiguous request. Classification is a description,
not permission: every analysis result and every structured model response carries no authority,
and every action still passes the action registry and authorization layer.

**Evidence and claims.** Retrieval is bounded per source and in total. Every evidence item keeps
the record id it came from, the source, the claim text, observation and validity times, provenance,
status, and any supporting or contradicting links. Three outcomes are kept distinct: a source
that was read and had nothing, a source that could not be read (unavailable), and a source that
failed integrity checks (damaged). Only the first supports "nothing is recorded". Claims are
labelled supported, contradicted, historical, unknown, inferred, assumed, expectation, or
observation as appropriate; a derived view is never labelled an observation.

**Contradictions are symmetric.** A stored disagreement is never resolved by recency, source rank,
repetition, or model preference. Every side is kept, each side is cited, and the conclusion is
`conflicting` with a disclosure. The World Model's conflict groups are reused rather than
recomputed by a text heuristic.

**Uncertainty is qualitative, not a score.** The categories are unknown, unverifiable, conflicting,
outdated, weakly supported, inferred, assumed, supported but incomplete, and strongly supported
(the last only when two independent source subsystems record compatible claims about the same
subject). There is no confidence percentage anywhere, and a prediction's ledger status is never
treated as factual confidence.

**Clarification and assumptions.** An ambiguous reference, a missing topic, a goal without a
success criterion, or an unsupported capability is decided deterministically. A needed
clarification is returned before the model is called, so no model can answer past an ambiguity
and imply it resolved one. Assumptions are named where a conclusion depends on them; nothing is
invented to fill a gap.

**The model protocol.** The model's prose is still the answer and remains unverified. It may append
one line beginning with `COGNITION` carrying a JSON object with a decision, a short answer,
bounded claims, uncertainty, disclosures, missing information, and optionally a recommendation.
That line is parsed as untrusted input and validated against this request's evidence ids and
deterministic analysis. At most one line is accepted; a second, malformed, oversized, non-object,
unknown-kind, over-certain, or invented-citation structure is rejected whole and the fact of the
rejection is disclosed. Validation never executes the recommendation, never writes a record, never
approves a plan or adaptation, and never marks evidence verified. The model cannot authorize an
action, create an authoritative record, or claim that one of its suggestions ran.

**Executive integration.** Goal, plan, task, and World Model records are read when the request is
about them, with blockers, plan validity, the next eligible step, missing criteria, and the
proposal pathway stated. A recommendation is just a recommendation: it is reported as unexecuted,
it carries no permission, and any resulting action still needs the existing approval and
authorization workflow. Task execution requests are classified and routed, not run, by this layer.

**Context budgeting.** The grounding brief is a derived section in the model prompt. It gives up
its room before any retrieved record, after the World Model and executive sections. When the
budget empties it, the prompt says it was omitted, rather than leaving silence. Recalled memory
trimmed by the same budget now carries its own note inside the memory section; an emptied memory
section says how many records were omitted instead of saying none were found. Each derived
section that is emptied has its own notice, and notices are dropped before records when they
cannot all fit.

**Retrieved content is data.** Instruction-like text inside memory, knowledge, World Model
records, or conversation turns is not followed. The prompt labels each section as data, and the
analysis, the validation, and the authorization layer never treat a record as a rule. A stored
instruction cannot cause a write, an approval, or a task run.

**Scenarios A-O.** `tests/cognition-scenarios.test.js` drives the ordinary controller path with a
synthetic capture backend (no inference) and pins fifteen behaviours: a cited stored fact is
accepted and shown as unverified; a stored disagreement stays unresolved; a historical as-of
question reports outdated currency; an ambiguous entity asks before any model call; a comparison
links both referents; a next-step question reads goals and runs nothing; a structured
recommendation is marked unexecuted; a proposed plan is denied before validation; a malformed or
over-reaching structure never reaches the user as JSON; an authoritative claim and a proposed
write change no store; an unreadable knowledge store is disclosed and the answer proceeds; a
large request is bounded with the omission stated; repeated experiences are described as recorded
order, not cause; the trace keeps evidence ids but no stored or model content; and a deterministic
action still verifies while a model answer creates no stored record.

**Measured** (Node v26.4.0, Windows x64, 12 logical CPUs, `--repeats 5`, synthetic fixtures written
through the stores' own validated paths; model-free, no network):

| Measurement | 20 records | 200 records | 800 records |
|---|---|---|---|
| World state read + conflict derivation | 0.92 ms | 0.78 ms | 1.38 ms |
| Analysis total (standalone, re-reads memory and knowledge) | 9.12 ms | 37.06 ms | 325.15 ms |
| Request understanding | 0.27 ms | 0.26 ms | 0.16 ms |
| Retrieval and evidence normalization | 7.98 ms | 36.01 ms | 324.48 ms |
| Claim extraction | 0.20 ms | 0.15 ms | 0.17 ms |
| Deliberation | 0.22 ms | 0.15 ms | 0.11 ms |
| Grounding brief | 0.10 ms | 0.05 ms | 0.04 ms |

The analysis is bounded at 36 evidence records (6 per source), so its own stages do not grow with
the store; the growth shown is the memory and knowledge search inside retrieval. On the controller
path those two records sets are passed in as seeds, so the analysis does not read them a second
time. Prompt assembly with the brief measured 0.58 ms median at 800 memory and 800 knowledge
records; in an 8000-character measurement budget the brief added 741 characters (11 lines of 19,
1335 characters total, 8 omitted), while at the default 6000-character budget it was trimmed
first; in that fixture the remaining room was spent on records, so the brief's own omission
notice did not fit either - the records it would have described were still present, and the
operation record still carries the analysis. That is the designed order: a notice is attached
only where it does not displace a record that answers the question. Model-output validation
measured 0.12 ms for an accepted structure, 0.08 ms for an
invented citation, and 0.02 ms for malformed JSON. These are single-machine observations, not a
latency target. `benchmarks/run-cognition-benchmark.mjs` reproduces them.

**What this does not claim.** It is not human-like reasoning, general intelligence, consciousness,
autonomous learning, or a complete neural architecture. The conclusions are bounded rule
application over stored records; the prose answer is still generated by whatever model the user
configured, and validation checks grounding and structure, not truth or wisdom. The layer cannot
prove that a statement is true, only that it is supported, contradicted, outdated, inferred, or
unknown with respect to the records it read. There is no chain-of-thought capture and no attempt
to model one. The roadmap's stage 4 is advanced on the request path, not closed: explicit
confidence on stored beliefs, retrieval that is cheaper than a full store scan, and contradiction
handling beyond the World Model's own conflict semantics remain open.

## Batch AK: the executive bridge - safe action orchestration and verified execution (as implemented)

APEX already owned every part of an executive act: a router, an action registry, an authorization
policy, a plan store, a task runner that authorizes and verifies each step, an audit log, and a
continuation engine. What it had no way to do was start from a user's own sentence: nothing read
"prepare a plan to remember that X" and produced a plan record whose approval the user could see
before any of it ran. Batch AK is that bridge - request → understanding → proposal → validation →
user authorization → execution → verification → audit → outcome - and it is a real integration of the
systems that already existed, not a parallel one. It adds **no store, no registry, no second
authorization rule, and no second runner**: every write it makes is one registered action executed on
an operation and re-read by that action's own verifier, every run is the same `planActivate` path
`node bin/apex.js plan start` takes, and every status line is read from a goal, plan, task, or
continuation record.

**Where it lives.** `src/executive/` holds one module per responsibility, and the controller holds the
bridge itself as one private section of `handle()`:

| Module | Responsibility |
|---|---|
| `vocabulary.js` | The fixed labels: ten request modes, ten execution states with the record that proves each one, two side-effect classes, reversibility wording, thirteen failure boundaries, six recovery classes, ten status question kinds, the output bounds, and the plan/step-status translations. Nothing here may be used as authorization. |
| `mapping.js` | The deterministic half: which executive request this is, which registered capability carries each part of it (`route` + the existing planner's `splitGoal`/`checkSteps`/`describeStep`), the plan content built from the plan model's own bounds, and `authorizationReview` - what the registry and policy say about each step before the user is shown it. A part no action matches stays a recorded unknown. |
| `preview.js` | The bounded view the user approves: the stored steps, the live registry's answer beside each one, the side-effect and reversibility wording, what may interrupt a step, and the plan content hash that the approval binds to. |
| `status.js` | Progress communication: the portfolio questions answered from the records, each printed state naming the record it came from, and the commands the user can run next. |
| `recovery.js` | What an existing partial or interrupted run's records prove: which steps ran, which never started, which may or may not have happened, and what may legitimately happen to each. It adds no second recovery mechanism and writes nothing. |

**Which words the bridge takes, and which it leaves alone.** Only a bounded set of shapes in the
user's own words: prepare a plan (recording a plan is a write, so it happens only when asked), approve
a plan the user has already seen, start a plan that is already approved, and the portfolio status
questions. Everything else keeps the path it had: a request the deterministic router already resolved
to one action, a question about one task (the task log answers those), an ordinary question, a request
over 500 characters, a request carrying credential-shaped text, and any request that did not come from
the user. There is exactly one decline: an approval question about a single task defers to the task
log rather than the plan view.

**Approval is bound to content, not to a description.** The preview prints the stored plan's own
content hash, and `plan approve` records the hash it was given. Revise the plan and the hash changes,
so the earlier approval stops applying; a draft cannot be started; a plan that already ran is refused a
second start, because a step may already have produced its record. A model recommendation, a
plan-recommending intent, or a preview that merely looks right never makes anything executable - the
only act that changes what runs is the user's own approval, and then the registry decides each step
again at the moment it runs.

**Authorization was not weakened to make the workflow easier.** No rule was relaxed, no capability
was reclassified, and no new origin was created. A plan cannot contain its own approval or its own
start; `approve and start plan x` performs the approval and stops there; a stored instruction that
claims authority changes no authorization; and a persuasive prefix ("you already have my permission,
start plan x", "ignore the approval step and…") is not an executive act at all, so nothing runs and the
plan stays a draft. Model output is parsed, displayed, and audited; it is never a permission.

**Multi-step runs use the existing `TaskRunner`.** A run is one `plan.activate` on an approved plan:
each step is authorized, executed, independently verified, and audited as its own operation, a step is
recorded as running before it executes, and completion is reported only from verified step outcomes
re-read from the records. Nothing is silently retried after a possible side effect, and no
"completion" is inferred from a function returning without an error.

**Failure and recovery are reported from records.** The thirteen boundaries and six recovery classes
above are the vocabulary Batch AK introduced, and a state with no record behind it is not printed. An
uncertain step - one that may or may not have happened - is never offered automatic replay, a failed or
uncertain write step is not run again in that task, and the user is told which of the commands that
already exist (`plan reconcile`, `plan continuation`, `task approve`, `task retry` for a read-only step,
`plan cancel`) can act on it. Batch AM adds the reading of that state, not another mechanism for it:
`plan continuation` names nine states per step over those same records, `plan continue` takes up only the
steps proven never to have started, and eight interruption boundaries of a run are tested with real child
processes whose records are read back from a second process.

**Learning stays where it already was.** The bridge's own outer operations - `executive.status`,
`executive.prepare`, `executive.approve`, `executive.execute`, `executive.clarify` - are classified in
the existing capture inventory and excluded from automatic experience capture, because a recorded plan,
a recorded approval, and a run already covered by the task log are not experiences of an answer. The
plan's own steps are ordinary registered actions and stay eligible exactly as they are when run from
the CLI, and only a step that ends `success_verified` under an allowed authorization decision and an
independent verification can be captured. Verified outcomes are recorded against the plan, so later
reads see them.

**Continuation readiness: read-only requests do not execute.** `next`, `work`, and the status questions
answer from the records and run nothing. This is visible in the persisted files, not just in a
displayed string: a status question appends one audit record and a bare record read appends nothing,
while a prepare appends a plan, an audit record and two conversation turns. The run reported below
created no background activity and left nothing in progress, because APEX runs only while a command
runs, and the status view says so in those words.

**One display defect was fixed, not documented away.** `validatePlainAnswer()` already recorded that a
model sentence claimed APEX had executed or approved something, but a reader who saw only that sentence
had nothing to correct it with. The answer display now appends a notice naming what the request actually
ran, read from the operation's own step records, and states where authorization lives. The notice is
APEX's own line and is never written into the model's turn or its stored history.

**Tests.** 57 tests in three suites, all registered in `npm test` and all model-free (a stub backend
where a model reply is needed, so nothing here is evidence about a real model):

| Suite | Count | What it pins |
|---|---|---|
| `tests/executive-bridge.test.js` | 21 | Three recorded acts with one audit chain; every preview field read from the stored plan and the live registry; the printed hash is the stored hash and the approval records it; mapping takes only what it can carry and leaves the router's answers, single-task questions and model-origin requests alone; status runs nothing and prints only vocabulary states a record supports; a failed step is failed and an uncheckable one uncertain, never done; outcomes reach the existing learning path and only verified ones. |
| `tests/executive-acceptance.test.js` | 25 | The numbered end-to-end scenarios K-01 … K-25: an empty portfolio reported as empty; prepare → preview → approve → run → outcome with the records each leaves; the nine questions answered from those records; a failed step stopping its dependants with no retry promise; an uncertain step never replayed; an unapproved plan refused with nothing written; a plan that ran refused a second run; an unmappable request refused and recording nothing; a partly mappable request keeping its unknown part visible; an approval naming no plan asked about rather than guessed; a twin draft staying a draft; a credential-carrying request not taken as an act; the same lifecycle reachable from the CLI writing the same records; and capture behaviour. |
| `tests/executive-adversarial.test.js` | 11 | J-01 … J-11: a model claiming it ran and approved a plan changes no record; a plan reference that is not an identifier asks instead of approving, and a full-length identifier approves without starting; `approve and start` approves and stops; three persuasion prefixes execute nothing and leave the store byte-identical; a non-user origin cannot approve through the bridge; a stored instruction claiming authority changes no authorization; an unregistered destructive capability records no plan and deletes nothing; a plan cannot contain its own approval or start; a credential persists nothing; and the action-claim correction appears where the user reads it without becoming model text. |

**Measured** (`benchmarks/run-executive-bridge-benchmark.mjs --repeats 5 --rows 1,10,50,150 --phase
all`; Node v26.4.0, Windows x64, 12 logical CPUs, `NoBackend`, no network, no inference; the growth
axis is historical executive records, not plan length, because the recorded plan cap is 8 steps):

| 1 / 10 / 50 / 150 bundles | 1 | 10 | 50 | 150 | 1→150 |
|---|---|---|---|---|---|
| request → preview | 115.69 ms | 117.21 ms | 155.16 ms | 248.78 ms | 2.15x |
| live plan validity read | 4.82 ms | 4.97 ms | 13.49 ms | 25.15 ms | 5.21x |
| the bridge's own computation | 0.44 ms | 0.58 ms | 0.36 ms | 0.35 ms | 0.1-0.5% of a request |
| approval write / approval answer | 67.22 / 97.61 ms | 60.82 / 112.81 ms | 87.70 / 162.66 ms | 108.79 / 199.55 ms | 1.62x / 2.04x |
| 8-step plan run (8/8 `success_verified`) | 1200.69 ms | 1234.42 ms | 1434.40 ms | 1822.48 ms | 1.52x |
| per step / marginal cost of a step | 150.09 / 114.77 ms | 154.30 / 109.94 ms | 179.30 / 126.68 ms | 227.81 / 165.73 ms | - |
| status answer / its record read | 32.23 / 12.40 ms | 32.95 / 15.32 ms | 49.53 / 25.48 ms | 71.07 / 45.86 ms | 2.20x / 3.70x |
| recovery sweep / reconcile | 16.38 / 35.71 ms | 16.46 / 36.31 ms | 23.86 / 64.46 ms | 43.24 / 96.77 ms | 2.64x / 2.71x |
| one verified write, request form (capture off / armed) | 129.56 / 155.62 ms | 103.03 / 187.07 ms | 139.17 / 214.49 ms | 106.07 / 192.10 ms | - |

Fifteen times more executive history (2,400 record lines, 1.67 MiB) buys 1.5-2.2x on the request paths
and 1.01-1.08x on a single write, while the bridge's own computation stays under a millisecond: a fixed
per-operation cost - the coordinated write and the whole-store validated read Batch V already measured -
dominates, not bridge logic. **So no derived index and no cache was added for this path**, consistent
with the measured V-06 and V-07 decisions; the lines to re-measure, the thresholds for revisiting that,
and the full interpretation limits are in
[Benchmarks: Executive bridge benchmark](benchmarks/README.md#executive-bridge-benchmark). The capture
columns run A/B/A on copies of the same bytes in one run: `armed - off` was 26.06-86.03 ms across rows
against a same-condition drift of -7.63 to +34.86 ms, and the armed request appended exactly one extra
`experiences.jsonl` record. The worst measured case is a whole 8-step plan: 1.82 s median, 2.33 s at the
end of the min-max spread.

**What this does not claim.** No model was consulted anywhere in this work package, so nothing here is
evidence that a model would propose a good plan, or that the plans APEX recorded were the right ones:
the bridge measures what it costs to carry out what was asked, not whether it was worth asking. A
verified step means the action ran under an allowed authorization decision and the store read back the
record the action claims to have written - it is not proof that the intended change happened in the
outside world, and APEX has no capability that deletes, overwrites, or reaches outside its own stores,
so no preview in this build can honestly show a destructive step. The bridge is not a general-purpose
planner: it recognizes a fixed set of phrasings, refuses what it cannot map, and stops at the recorded
8-step bound, so the statement in the root README that APEX has no general-purpose planner still
stands. It is not autonomous, not self-learning, and not generally intelligent, and the learning path
it feeds is the existing bounded experience capture rather than a model that improves itself. One
behaviour is left as a documented limitation instead of a fix, in
[Known limitations](#known-limitations): with a persuasive prefix in front of the command, the request
is not an executive act at all and the ordinary path answers it - which can produce an unhelpful
question ("Which task do you mean?") while the plan stays an unstarted draft. Making that phrasing work
would mean scanning prose for embedded commands, and a statement that sounds like permission is exactly
what the bridge must never read as one.

## Batch AL: adaptive planning, outcome evaluation and goal progression (as implemented)

Batch AK made a user's own sentence become a plan and a run. Batch AL is the part that decides
*which plan is appropriate, why it is appropriate, whether it worked, what evidence supports that,
and what the next attempt should know* - without letting any of that become permission. It adds **no
store, no registry, no planner, no second authorization rule and no second runner**: the candidate set
is generated from the goal record and the live action registry, the comparison is a disclosed rule over
what each candidate already records, the outcome verdict is derived from the audit operations the plan's
own steps cite, and every write is one registered action on an audited operation that its own verifier
re-reads.

### What is implemented

- **Goal decomposition with provenance** (`src/goals/model.js`, `goal.confirm`). Each success criterion
  carries a `basis`: `user_stated` or `system_inferred`, plus a `requirement` of `required`, `suggested`,
  or `declined`. An inferred criterion is never required: only `goal confirm`, a user-origin action, turns
  what APEX inferred into what the user demands, and a goal whose request is too vague to name a
  capability for any criterion is answered with the question that resolves it rather than with invented
  criteria.
- **Candidate generation** (`src/plans/candidates.js`, `plan.candidates`). Up to three approaches per
  goal (`required_only`, `all_open_criteria`, `read_before_write`), each with ordered steps that name a
  registered action and nothing else, its dependencies, expected result, verification, risk, reversibility,
  precondition strings, classified assertions, and the criterion it settles. Effort is reported as
  unavailable whenever the audit log holds no per-action duration, rather than estimated. An approach the
  capabilities cannot carry is reported as skipped with the reason; a goal with no open criterion
  generates nothing.
- **Evaluation and selection** (`src/plans/evaluation.js`, `src/plans/outcomes.js`, `src/executive/selection.js`).
  Six hard gates first - a candidate that fails one is excluded and says which - then eight ranked
  dimensions compared as recorded: `criterion_coverage`, `uncertainty`, `step_risk`, `reversibility`,
  `resource_requirements`, `verification_quality`, `recorded_outcome_history`, `approved_adaptation_fit`.
  Six more are reported beside them and never ranked, and each says in its own band why it stays there:
  what the approach settles is already counted, an assertion's kind is a self-claim, a wrong dependency
  structure or a refused capability is a gate rather than a drawback, asking for evidence is not a
  quantity, and a record that stops work has already stopped it at the gate. Batch AM added
  `verification_quality` (how many steps name an action that carries no independent verifier of its own,
  read from the live registry rather than from the candidate's claim) and `recorded_outcome_history` (how
  many of the capabilities this approach uses appear in the plan records as failed or uncertain, read from
  `src/plans/outcomes.js` and bounded, with the bound disclosed). Both are counts of records: neither is a
  rate, and "what happened once" is never written as what will happen now. A dimension whose records were
  not read reports that and separates nothing, because an unread store is not a clean one. Leading is
  Pareto: at least as good on every dimension and strictly better on one. Where nothing separates, the
  trade-off *is* the answer and no draft is recorded. No score, weight, or probability is computed
  anywhere, because no record supports one.
- **Outcome evaluation** (`src/plans/assessment.js`, `plan.outcome`, `plan.assess`). Seven separate
  questions - step outcomes, expected outputs, verifier verdicts, criteria settled, evidence state,
  durability, and what only confirmation outside APEX can settle - each answered from records and cited to
  the operation it came from; findings with no operation behind them are dropped and disclosed as dropped.
  The verdict takes the first rule the records satisfy. `plan.assess` records that derived verdict as one
  event; it accepts no verdict as input, refuses to record the same version twice, and leaves the plan's
  bytes, timestamp and approval untouched.
- **Goal progression and replanning.** Progress is derived from criterion evidence, never from task
  completion, and `goal complete` refuses a goal whose own proof has since been retracted or contradicted
  (`goal-assessment.test.js`, `goal-provenance.test.js`). Batch AM added the read side of the same rule:
  `goal show` and `goal assess` re-check the completion snapshot, so a goal is not reported as settled
  once its proof has been withdrawn (`goal-evidence-consistency.test.js`) - and nothing that runs a plan,
  including `plan continue` and `plan reconcile`, completes or reopens a goal by itself. A revision
  regenerates candidates against the plan that failed, keeps the earlier plan and its approval in the log,
  names the actions that run refused, and requires fresh validation and fresh approval.
- **Outcome-aware learning** (`src/executive/learning.js`). Each planning read discloses what the records
  of past attempts say - an approved adaptation, a recorded expectation, an assessment against another
  plan for the same goal - and states in the same answer that this disclosure changed no gate, no ranked
  dimension, no score and no candidate digest. Adaptations are derived from repeated feedback, become
  active only through `adaptation approve`, and conflicting evidence is preserved rather than averaged.
- **The user-facing surface.** `plan.candidates`, `plan.replan` and `plan.outcome` are audited reads that
  record nothing outside their own operation; `plan.assess` is the one write. All four are
  `node bin/apex.js` commands (`plan-cli.test.js`), including the `--json` view the outcome answer's own
  bound names, so a hint in an APEX answer is a command the terminal takes.

### Where the shipped behaviour differs from the brief, stated as the records support it

- A recorded blocker and an unmet prerequisite now gate, and Batch AM says which records are allowed to:
  a blocker the user stated in their own words on the goal, or one naming a record a read found current,
  excludes the candidates that walk into it (`constraints_satisfied`), and a blocker naming a capability
  is refused by the generation itself. What APEX inferred, what the user assumed, what a memory line
  says, and what an operation ended with are reported as suspected; a blocker resting on a retracted or
  unresolvable record, or recorded on a goal that has since closed, is reported as historical. Neither
  class gates anything, and every exclusion names its record, the steps it stops, the reason, and what
  would clear it. Approval and activation re-read the same records (`plan-constraints.test.js`).
- Approved adaptations are disclosed, and Batch AM made one thing follow from them: a *shape the user
  recorded* on an approved, active rule (`adaptation guide`, held as an `adaptation_guidance` record) is
  checked against each candidate's own steps as the ranked dimension `approved_adaptation_fit`, and the
  record that moved an approach is named by its id beside the position it moved. `influencesSelection`
  is now a fact about the read rather than a flat absence: it is `true` only when such a record is in
  scope, and the rule text itself is still only printed, never parsed. An approved rule with no shape, an
  unapproved, rejected, retired, contradicted or out-of-scope one, and anything a model would have said
  are inert. Recorded guidance cannot bypass a gate, a constraint, the capability refusal, or approval
  (`plan-guidance.test.js`).
- The runner cannot leave a `partial` verdict behind in one process, because a failed step stops the task;
  `partial` is reachable only across a resume, and the suite says so rather than manufacturing it.
- No confidence value is stored or computed anywhere, and a match rate is withheld until enough scored
  evaluations exist; a prediction whose horizon passed is `expired`, never `wrong`.
- Progress derivation refuses to rewrite a user's criterion text: a criterion is satisfied or not from
  evidence, and only `goal confirm` or `goal revise` changes what it asks.

### Measured

`benchmarks/run-planning-benchmark.mjs` (no backend of any kind, synthetic fixtures, three store sizes)
reports the nine paths. At the largest fixture - 2,021 memories, 2,000 knowledge claims, 155 goal events,
235 plan events, 147 task lines, 401 operations, 800 predictions, 400 experiences, about 2.2 MB of JSONL -
goal decomposition, plan validation, goal-progress derivation and continuation ranking sit between 27 and
49 ms, the pure generator and evaluator stay under 2 ms, and the three audited planning reads took
**270-350 ms** at the median of three samples. The control that separates the code from the disclosure:
with the same goals, plans, tasks and audit log but the prediction and experience ledgers emptied, those
three reads are 161-248 ms and the three learning reads 10.3 ms. So the reads are now within about 60 ms
of their own floor rather than 3 s above it.

Batch AM measured the same script against a copy of the tree taken from `HEAD` (`5a3d494`, the Batch AL
commit) extracted with `git archive`, which is the shipped code before this batch and not a switched-off
mode. Same fixture contents, same machine, nothing else running: the three reads were **3.42-3.59 s**,
the learning trio 1,528 ms and `predictions.calibration` alone 1,518 ms - a **10.3x / 11.4x / 13.0x**
improvement on the reads and **24.6x** on the calibration. Those Before figures at the largest size are a
single sample: the three-sample run of the same command finished but its scratch output path was reused
before either file was read, so only the single-sample figures survive. The medium-size column is three
samples on both sides (435.0 / 300.6 / 270.4 ms before against 183.4 / 112.3 / 108.6 after, calibration
119.1 ms against 26.0), and the AL-era figures committed in
[`benchmarks/README.md`](benchmarks/README.md) for the same large fixture (3,321.5 / 3,149.3 / 3,243.6 ms,
calibration 1,492.9 ms) agree with the single Before sample to within about 8-10%. Absolute timings on
this machine vary up to 2x between runs of an identical fixture, so the ratios above are read together
with that spread, not against it.

Two costs the batch added, also measured rather than asserted (both in
[`benchmarks/README.md`](benchmarks/README.md)). A goals recorded constraints, grown through `goal revise`
to the stores own cap of 48 items across six lists, costs the constraint ledger **1.5 ms** at that size
against 0.0 ms for none, and moves the audited planning read by less than the noise. And the recovery
paths over a run a real child process left behind - the continuation reading, the ranking that now reads
it, the readiness question and the resume itself - are **97 ms / 224 ms / 259 ms / 692 ms** at the largest
size. The ranking is the column this batch made heavier: with no interrupted run on the fixture it is
41.6 ms, and with an active plan per task it is 223.6 ms, because each such plan now gets its own
continuation reading before it can be placed. That is a read the user pays when asking what is next, and
nothing in it runs in the background.

Batch AN measured that ranking cost and removed its cause. The `ranking` phase adds a fourth fixture - a
large project with many active plans and tasks: 885 goal events, 645 plan events, 327 task lines, 401
audit records and 40 interrupted runs among 80 activated plans (about 3.6 MB of JSONL). One `work`/`next`
report there reads each store once (`goals.get` 0), and takes **220 ms** end to end; the same report on
S / M / L is **3.3 / 20.3 / 37.6 ms**. The pre-AN shape replayed the whole goal log twice per interrupted
plan (once for the reading's constraint ledger, once inside live validity). Measured in the same run, one
such replay per plan already costs **5.45 s** and live validity through the store **5.51 s**, against
**6.9 ms** through one shared snapshot, with identical `ok` and problem lines on every plan. The report
now takes one goal snapshot per ranking read and answers every plan from it; a damaged or unreadable goal
log still refuses every continuation rather than reading a partial state. That equivalence and the
fail-closed behaviour are pinned in `executive-continuation.test.js` (one inspect, zero store `get`, the
same ranked candidates; a corrupt goal line yields no `continue-plan` candidate).

## Batch AN: cognitive runtime contracts, executive integration and continuation reliability (as implemented)

Batch AJ gave one request a cognitive reading, Batch AK turned a user's words into an authorized run,
and Batches AL and AM made planning and recovery read from records. Batch AN is the part that writes
the boundary down and tests it end to end: which component owns each stage of a request, what the
gateway says came back, what a claim's evidence actually supports, what a model proposal is allowed to
carry, what survives a real process death, and what a trace may contain. It adds **no store, no
registry, no planner, no controller, no runner and no authorization rule**: every stage below either
reads records the existing path already writes or narrows what may cross a boundary that already
existed.

### What is implemented

- **The ten-stage contract** (`src/cognition/contract.js`). One request is described as `user_request`,
  `cognitive_interpretation`, `retrieved_evidence`, `grounded_claims`, `proposed_response`,
  `proposed_actions`, `executive_authorization`, `actual_execution`, `verification` and
  `learning_and_outcome`, in that order, each with an owner (`user`, `cognitive`, `model`, `executive`)
  and one of five statuses (`ran`, `skipped`, `not_reached`, `unavailable`, `failed`). The contract is a
  reading, not a coordinator: it does not move a request, and it cannot carry one past stage 6. Every
  contract carries the same authority block verbatim - cognitive output grants no authorization,
  `action_registry` owns authorization, the cognitive layer performs no execution, authorization cannot
  be skipped, verification is independent, and model output is untrusted - and `buildContract` checks
  two invariants from the records: no step may execute without an allow decision, and none may execute
  without an authorization record at all. The audit copy keeps the schema, request id, stages, authority
  and check results; it drops request text, evidence text, model text and reasoning. On every request the
  controller assembles, stage 10 is recorded `not_reached`: the contract is built before finalization
  writes the operation record, so learning is stated as not yet reached rather than guessed.
- **A gateway boundary that says what came back** (`src/model/gateway.js`). Every reply is classified
  as `valid`, `empty`, `refused`, `unavailable`, `malformed`, `context_limit` or `cancelled`. Provenance
  records request id, backend, provider and model with `verified:false`, because APEX has no way to
  attest that a reply came from the model it asked. A caller's cancellation signal becomes `ABORTED`,
  distinct from `TIMEOUT`, and automatic retry remains limited to `UNREACHABLE` and `INTERRUPTED`; a
  refusal, an empty reply or a malformed one is never retried into a different outcome.
- **Evidence states a model cannot overwrite** (`src/cognition/vocabulary.js`, `claims.js`,
  `response.js`). A claim carries one of six states - `directly_supported`, `partially_supported`,
  `conflicting`, `unverified`, `unsupported`, `temporally_stale` - derived from the records it cites.
  The weakest cited record wins, so one contested citation makes the whole claim contested; a model's
  claim of `supported` is accepted only when every citation is `directly_supported`. Each claim kind
  has a fixed set of states it may hold, and the grounding brief prints the deterministic counts beside
  the records. Retrieval also stopped treating a summary of nothing as evidence: an empty world store
  and a temporal summary with zero outcomes and no supported pattern now contribute no claim, so an
  empty store answers `unknown` with the disclosure `no_evidence_found` instead of reading as support.
- **A typed proposal boundary** (`src/controller/proposals.js`). A model reply may propose only
  `action` and `input`. The parsed value is stored as `model_action_proposal`, with an id (`mp:N`),
  `origin:'model'`, `trusted:false` and `authority:'none'`. Any authority-shaped root key
  (`authorization`, `authorized`, `verified`, `executed` and the like) or any unknown root key rejects
  the line whole. A proposal reaches execution only by the existing route: a bounded preview names every
  step and its risk, a user-origin approval is bound to the plan's content hash and version, the run
  goes through the existing `TaskRunner`, and the independent verifier decides whether the step is
  verified. When a proposal is not executed, the answer says so rather than being silent.
- **Cross-process continuation** (`src/plans/continuation.js`). The reading names one of eight
  interruption boundaries and one of nine states from the plan, task and audit records it re-reads
  inside the task lock. A command's own lock is reported as held by this command rather than as another
  process mid-run, and a continuation whose `continue.safe` is false is refused rather than attempted.
  A step whose effect cannot be established is never produced a second time, and duplicate or
  concurrent continuations take the run up once.
- **A bounded cognitive trace** (`src/cognition/trace.js`). The trace holds stages, evidence ids,
  refusals, boundary, disclosures, validation and decision, with `authorizes:false` at the top level.
  `executionBoundary` states one of `not_reached`, `no_proposals`, `malformed_only`, `all_denied`,
  `partially_executed`, `all_executed`, with proposal, authorization, execution and verification counts
  and the refusal reasons; `attachBoundary` adds it to an existing audit record. Every free-text field
  is filtered against a fixed label pattern, so prose and reasoning cannot enter the trace even if a
  caller supplies it. A trace is evidence about what happened; it is not a permission and nothing reads
  it as one.
- **Deterministic integration and adversarial coverage.** `integration-runtime-an.test.js` drives the
  assembled application through the whole path - request, interpretation, retrieval, claims, answer or
  proposal, authorization, execution, verification, audit and learning - and covers empty evidence,
  conflicting evidence, stale evidence, malformed cognitive output, model-origin authorization
  attempts, fabricated tool results, unsupported claims, an unavailable backend, interrupted
  processing, duplicate requests, invalidated approvals, concurrent operations, audit failures and
  recovery after process termination. `continuation-cross-process-an.test.js` uses real child
  processes stopped at the eight interruption boundaries, and `proposal-boundary-an.test.js` pins the
  typed-proposal refusal on the assembled path. No test contacts a model: every backend is the
  no-backend one or a programmatic stub whose reply is fixed text.

### Where the shipped behaviour differs from the brief, stated as the records support it

- The contract records stage 10 as `not_reached` on every request today. It could report a learning
  stage only by reading a finalization record that does not exist yet at the time it is built, and
  reporting it from a guess would be exactly the kind of claim this batch removes.
- The contract does not enforce the boundary; the existing executive path already does. The contract's
  contribution is that the boundary is now stated per request, checked for two invariants, and exposed
  to tests - not that it adds a second enforcement point.
- The trace is deliberately not a reasoning log. Free text is dropped, which makes it safe to persist
  but means a debugging reader sees counts, ids and fixed labels rather than explanations. That is the
  trade this batch chose: a trace that cannot leak private reasoning is more useful than one that can.
- Continuation reports what the records prove. A write interrupted mid-execution is `outcome
  uncertain`, not a success and not a retry, and the way forward is a new plan rather than a replay.
- All model-backed tests in this batch use a stub or no backend. They establish what APEX does with a
  reply of a given shape; they are not evidence about a real model's reasoning or reliability.

### Measured

The continuation performance work is in [Benchmarks](#benchmarks) and repeated at the end of the
[Batch AL](#batch-al-adaptive-planning-outcome-evaluation-and-goal-progression-as-implemented)
section: on the XL fixture (885 goal events, 645 plan events, 327 task lines, 401 audit records, 40
interrupted runs among 80 activated plans, about 3.6 MB of JSONL), one `work`/`next` report takes
**220 ms** and reads the goal log once, against a pre-AN shape that replayed it twice per interrupted
plan at **5.45 s** per replay. The six new suites hold **46 tests** (11 + 5 + 9 + 3 + 3 + 15). The full
`npm test` run that closed this batch (129 test files, the six above included) ran **2,249 tests, 2,247
passed, 0 failed, 2 skipped** in 422.3 s on Windows 11, Node v26.4.0, in isolated temporary data
directories. The two skips are the POSIX-only checks this filesystem cannot perform. Before Batch AN the
same script reported 2,196 tests; the added tests are this batch's suites plus seven tests added to
existing suites. The run needed two test-harness corrections first, both in tests rather than in the
application: a digest tamper that was a no-op when the hash already began with `f`, and a refusal
assertion that did not accept the second process's legitimate `nothing was taken up` wording. Each was
reproduced by repetition, fixed at the assertion, and the affected suites then passed 20/20 and 12/12
before the clean full run above. No test in that list runs a model: the gateway in every one of them is
either the no-backend one or a programmatic stub whose reply is fixed text.

## Batch AO: the executive handoff boundary (as implemented)

A cognitive answer is text about what the records support. It is not a request to act, and it is not
permission. The crossing from intent into execution happens in exactly three places: a model proposal
that reaches the action registry, a plan activation, and a task run. Each crossing is stated as one
bounded handoff record (`src/executive/handoff.js`) attached to the operation that performed it. A
handoff record **authorizes nothing**: every record and every validation result says
`authorizes: false`, and the fields below are identities, hashes, and recorded outcomes, never the
request text, action payload, model prose, or private reasoning.

### Who owns each transition

| Transition | Owning component | Record that establishes it |
| --- | --- | --- |
| The model proposes an action | Controller (typed proposal parse), then the action registry | The executed step's `authorization`, `execution`, and `verification`, plus its handoff |
| The plan is approved | The user, through `plan approve`; the plan store records it | `plan.approval = { at, version, contentHash, validation }` |
| The plan is activated | The controller, on an approved and still-valid plan | `plan.activation` and the `plan.activate` operation's handoff |
| A step runs | The task runner, through the controller's action path | One `task.step` operation per executed step, linked from the task record |
| A result is verified | The independent verifier, not the executing action | The step's `verification.outcome`, then the task and handoff state |
| The operation is finalized | The operation log's single finalization contract | Whether the operation line was appended; the handoff itself keeps `finalization.recorded: null` |

### What counts as approval

A user-created task is authorized to run by the user's own creation act (`task.createdAt`); a
model-proposed task is authorized only after the user approves it (`task.approvedAt`). A plan is
authorized for activation only by an approval whose `version` and `contentHash` still equal the live
plan's version and content hash. The handoff names that scope (`task_creation`, `task_approval`, or
`plan_approval`), its time, and the hash it binds. A model cannot create, approve, activate, or
complete any of these, and a plan approval does not authorize individual steps: the registry decides
each step again when it runs.

### A stale approval

A revision increments the plan version and clears `plan.approval`, `plan.activation`, and the recorded
step outcomes; the reducer refuses a revision of an approved plan at all. Replaying such a revision
through the log applies the same rule. Activation re-reads the live plan and rechecks the approval
hash, so an approval kept from an older version cannot activate new bytes. A handoff built before the
revision then fails reference validation on version, hash, or the now-missing approval.

### Uncertain execution and no replay

A step whose action ran but whose verification could not confirm the result is `uncertain` in the task
log and `uncertain` in the handoff, never a success. A step whose own audit record is missing is
reported as unrecordable/unknown, not as a failure and not as a success. Later attempts read these
records and refuse to re-run the step; recovery of an interrupted run is explicit (`task continue`,
`plan reconcile`) and executes no work in the background. The handoff's `evidence.refs` are the
`task.step` operation ids that actually exist, bounded to eight with an honest total.

### Diagnostics

A handoff can be validated structurally (`validateHandoff`) and against live records
(`validateHandoffReferences`); both fail closed and return `authorizes: false`. The record is bounded
to eleven common keys plus the keys for its kind, ids capped at 80 characters, evidence at eight refs,
executed steps at 32, and problems at eight. It carries no request, input, or model text, so a
diagnostic view can be shown without exposing a payload or private reasoning. Its tests use fixed
stub replies and temporary data directories only; no test in this package contacts a model.

## Batch AO (package G): request diagnostics and the performance they measured

Every request now carries a bounded diagnostics record on its operation line, built by
`src/cognition/runtime-diagnostics.js` from a per-request `SpanRecorder` and the lifecycle that
already ran. It states what this process did: which named stages were reached, each stage's outcome
and monotonic duration, the counts and validation results it produced, a flat cognitive summary, the
executive handoff counts, cancellation, a failure category, and whether a transport retry happened.
It never stores the request, prompt, evidence text, model reply, action payload, or private
reasoning, and it does not capture a chain of thought.

### The stage record

The record fixes sixteen stage ids, so a caller cannot grow it by inventing one: request
interpretation, evidence retrieval, claim extraction, contradiction detection, deliberation, grounded
response, model call, model-output validation, proposal validation, handoff preparation, plan
validation, authorization, execution, verification, task execution, and finalization preparation.
Each entry has:

| Field | Meaning |
| --- | --- |
| `outcome` | `ran`, `failed`, `skipped`, `unavailable`, or `not_reached`. A stage the path did not enter is `not_reached`; a stage the path deliberately skipped is `skipped` |
| `durationMs` | Monotonic elapsed milliseconds, rounded to three decimals, or `null` when no duration was measured |
| `counts` | At most ten integer counters produced by that stage, never text |

`null` is not zero. A skipped stage, a stage whose clock threw, and a stage entered but never ended
all report `null`, while a stage that ran and produced no items reports `0`. If the same stage is
ended twice, the worst outcome wins in the order `failed` > `unavailable` > `skipped` > `ran`.
`contradiction detection` is labelled as overlapping `claim extraction` because it runs inside that
stage; its duration is part of the extraction duration, not a second cost. `task execution` overlaps
the authorization, execution, and verification of the steps it runs.

### The record, and what it cannot do

The record is bounded: at most twenty stages, ten count keys per stage, a 60-character token rule
for status labels, a 100-character request id, a day-clamped total duration, and a fixed
key set `schema, requestId, available, status, totalMs, measuredStages, stages, cognitive, executive,
cancellation, failure, retries, clock, bounds, authorizes`. Its observed size is about 3.3 KB per
answer (3,297-3,335 bytes over 50 replies in the benchmark below).

Two failure behaviours matter. A clock that throws, or returns a value that moves backwards, does
not lose the stage: the outcome is kept, the duration is `null`, and `clock.fault` says the clock
failed. If building the record throws at all, the record becomes `available: false`, names
`error: 'diagnostics_unavailable'`, and still says `authorizes: false`; the operation's own status,
answer, and audit line are untouched. The record is built only after every stage that decides the
outcome has finished, and it is attached to the operation line that is then appended, so it cannot
change an outcome or a verification result.

`authorizes` is always `false`. Nothing in the lifecycle, action registry, executor, verifier, plan
store, or task store reads a diagnostics record to decide anything; it is an observation attached to
a record that was already decided. Cancellation and a timeout are distinguishable without reading
prose: a cancelled request reports `failure.category: 'cancellation'` with code
`request_cancelled`, while a backend timeout reports `failure.category: 'execution'` with the
gateway's own code and stage. A retry count is `{ available: false, count: null }` unless the
transport actually reported attempts; it is never inferred as zero.

What the record cannot establish: it does not verify an answer, it does not score a claim, it does
not prove a stage's work was correct, and it says nothing about a model's own latency when the model
is a local fixture. It is a description of this process's execution, not a security audit and not
an evaluation of answer quality.

### Measured: two avoidable bottlenecks

Both changes were selected from benchmark evidence, and both were checked for behaviour
equivalence before being kept. The comparison trees were identical apart from the two source files:
the controlled baseline was HEAD plus this package's instrumentation, and the after tree was the
working tree. Each was run with the same script, the same fixtures, nine repetitions, sequentially,
with no test or benchmark running alongside.

**Memory conflict pairing.** `MemoryStore.search` paired every same-subject record with every other
one to record `conflictsWith` ids, but only the returned window exposes those ids. At 2,000
same-subject records that was about two million comparisons for pairs no caller could read. The
search now skips a pair when neither record is in the returned window; window records still receive
every partner, in the same ranked order. The saving appears in the whole-request table below, not in
the stage table, because this search runs in `handle` before `analyzeRequest` starts its own
instrumented retrieval.

**Plan-activation handoff hashing.** `buildPlanActivationHandoff` computed `planContentHash(plan)`
twice - once for the record's plan identity and once inside `approvalBindsPlan`. It now hashes the
live bytes once and binds the approval to that same value. The record is byte-identical for the same
plan; a changed plan, a moved version, or a tampered approval hash still produces `approval: null`,
`decision: 'deny'`, and `APPROVAL_NOT_BOUND_TO_PLAN`, and live reference validation still re-hashes
the live plan.

### Measured: one grounded question at five evidence contexts

Fixture: one question, `what is the status of the lighthouse project?`, answered by a deterministic
in-process backend, at 0, 20, 200, 800, and 2,000 seeded records. Median of 9 samples per row. The
request total is the record's own `totalMs` (sum of measured work), and wall is the caller-observed
time.

| records | request total before | after | wall before | after |
| --- | --- | --- | --- | --- |
| 0 | 22.4 ms | 20.3 ms | 30.9 ms | 27.5 ms |
| 20 | 26.4 ms | 22.3 ms | 34.3 ms | 28.9 ms |
| 200 | 138.9 ms | 112.2 ms | 153.1 ms | 127.0 ms |
| 800 | 769.6 ms | 320.0 ms | 781.3 ms | 331.6 ms |
| 2,000 | 3,129.3 ms | 652.4 ms | 3,141.9 ms | 667.1 ms |

The other stage medians barely moved - for example, the instrumented evidence-retrieval span at
2,000 records read 10.7 ms before and 9.1 ms after - which is the expected shape when the removed
work happened outside that span. The 800- and 2,000-record rows are the ones the conflict-pairing
change addresses; the small rows are dominated by fixed request cost.

### Measured: handoff build and check, isolated

A dedicated microbenchmark built a real approved plan, registered a read-only action, activated the
plan once, then ran seven timed rounds of repeated `buildPlanActivationHandoff` plus a prepared-phase
structural check, after 200 warm-up builds. Median microseconds per build-and-check:

| plan steps | before | after |
| --- | --- | --- |
| 1 | 38.0 us | 24.9 us |
| 2 | 47.2 us | 29.4 us |
| 4 | 72.6 us | 41.7 us |
| 8 | 118.2 us | 66.4 us |

A second run of the same probe at 8 steps measured 145.7 us before and 63.7 us after; that spread
between runs of one size is why the before/after pairs above were each taken inside one run and are
not compared across runs. In the end-to-end executive phase the handoff span is a fraction of a
millisecond inside a 387-651 ms plan activation, so its improvement does not move that row; the row
is reported unchanged. Reference validation against a step-operation history of 0, 100, and 1,000
extra entries read 0.12, 0.10, and 0.31 ms in the same harness and is not claimed to improve.

### Measured: diagnostics overhead

One request-shaped workload of sixteen stages with eight measured, repeated 20,000 times per sample
over five samples, cost a median 20.7 us per workload in isolation (20.0 us min, 23.1 us max; the
same harness read 21.9 us in the control run, so the two figures are one measurement repeated, not a
change). The record itself is about 3.3 KB. `heapUsed` moved from 22.3 to 22.9 MiB over 100 further
requests without forcing garbage collection, which is an observation, not a leak measurement.

### Interpreted correctly

These are synthetic fixtures. They say what this process costs to run these paths; they do not
measure a real model's latency, token rate, or answer quality, and no inference was run. p95 is not
reported because nine samples cannot support it. Absolute timings on this machine varied up to about
2x between runs of an identical fixture, so only comparisons taken inside one controlled run are
treated as findings. The full request path, the plan-activation path, and the diagnostics record were
also compared between the uninstrumented HEAD tree and the instrumented working tree over nine
scenarios - grounded answer with an executed proposal, memory write, clarification, timeout,
cancellation, denied proposal, contradiction, two-step plan run, and a failed step. After replacing
ids, hashes, timestamps, durations, and the diagnostics record itself, the two normalized outputs
were byte-identical, including the persisted audit lines, the task and plan records, claim counts,
evidence states, authorization decisions, and verification outcomes.

The package's three new suites hold 34 tests (`runtime-diagnostics-ao.test.js` 22,
`memory-conflict-window-ao.test.js` 6, `handoff-hash-binding-ao.test.js` 6). The full `npm test` run
that closed this package (the 137 files named in `package.json`, those three included) ran **2,348
tests, 2,346 passed, 0 failed, 2 skipped** in 447.7 s on Windows 11, Node v26.4.0, in isolated
temporary data directories. The two skips are the POSIX-only filesystem checks this environment
cannot perform. No test in that run contacts a model or opens a socket: every gateway is the
no-backend one or a programmatic stub with a fixed reply.

## Batch AO (package H): adversarial integration, cross-process reliability, and end-to-end acceptance

This package asked one question of the integrated runtime: does it behave consistently and safely
when its inputs are invalid, its evidence is corrupted or withdrawn, its processes stop, and two
writers act at once? The evidence is the tests below, not a design change. No authorization,
evidence, locking, audit, or verification rule was relaxed to make a case pass, and no acceptance
path was added beside the real controller, stores, registries, or task runner. Every case writes only
into a fresh temporary data directory.

### What this package adds

Two suites, eight tests, and one real child fixture:

| File | Tests | What it drives |
| --- | --- | --- |
| `tests/acceptance-ao09.test.js` | 7 | The real controller, proposal log, task runner, action registry, and evaluation harness in one process, with fixed synthetic replies |
| `tests/cross-process-ao09.test.js` | 1 | A real child process killed while it holds the proposal store's write claim |
| `tests/fixtures/proposal-after-create-child.mjs` | - | Writes one synthetic proposal, holds the real claim, prints READY, then waits to be killed |

The package also closes one observed gap in the request path. A model answer is produced after the
analysis, and a record the analysis cited can be corrected, retracted, or become unreadable during
that gap. `recheckEvidence` (`src/cognition/evidence.js`) re-reads only the memory and knowledge
records the recorded claims cite, using the stores' bounded `getMany`, and `#recheckAnswerEvidence`
(`src/controller/controller.js`) reports the result as `op.cognition.evidenceRecheck`. That record
is read-only: it says `authorizes: false`, names the analysis and response phases separately, and
never rewrites the recorded lineage. A support the current stores can no longer establish is counted
as weakened, an unreadable record weakens the claim to unverified rather than proving it false, and
the answer carries a display-only notice when the count is above zero. The request outcome and every
stored claim lineage are unchanged by the re-check.

The acceptance work also found one defect in the new bounded re-read: `MemoryStore.getMany` returned
the replaced record's own id in `replacedBy` where `memoryWindow` names the successor that retired
it. Nothing read that field yet, so no observed behavior changed, but the returned shape contradicted
the store's own annotation contract. It was fixed at the store boundary, and the memory-correction
case now asserts that the successor is named. No assertion or expected outcome was loosened to make
any case pass.

### Scenarios A-R, each with the test that exercises it

"Expected" means both the returned behavior and the persisted state the test reads back.

| ID | Condition injected | Verified behaviour and persisted state | Test | Kind |
| --- | --- | --- | --- | --- |
| A | A response-only request; a fixed reply with no proposal | The turn is recorded unverified; no proposal, plan, task, handoff, or execution record is written | `handoff-integrity-ao.test.js` C2; `integration-runtime-an.test.js` main path | Synthetic reply |
| B | One memory record and one knowledge record answer the question | The answer cites both ids, lineage is recorded, and nothing runs | `cognition-scenarios.test.js` A; `integration-runtime-an.test.js` | Synthetic reply, real stores |
| C | Two contradictory records | Both stay evidence, the disagreement is disclosed unresolved, and the model cannot mark either supported | `cognition-scenarios.test.js` B; `integration-runtime-an.test.js` conflicting evidence | Synthetic reply, real stores |
| D | Retrieval returns nothing usable | The answer states that no evidence was found and does not fill the gap from the model; a clarification is asked where the question is ambiguous | `integration-runtime-an.test.js` empty evidence; `cognition-reasoning.test.js` clarification | Synthetic reply, real stores |
| E | A model proposes a write or a task it may not run | The registry denies the write, or the task waits at `awaiting_approval`; no capability executes | `handoff-integrity-ao.test.js` A2, B9; `model-self-authorization.test.js` | Synthetic reply |
| F | The user accepts a valid proposal, and later approves a model task | The acceptance is recorded through the ordinary store action; an approved task runs through the registry's own authorization for each step | `acceptance-ao09.test.js` test 1; `executive-acceptance.test.js` K-04, K-05 | Real controller and stores |
| G | An approved plan runs | Each step has its own `task.step` operation and an independent verification result; the task and plan say verified | `executive-acceptance.test.js` K-05, K-06; `executive-bridge.test.js` | Synthetic actions, real stores |
| H | A step throws during execution | The failure is reported as failed, dependants do not run, and no success or verified outcome is claimed | `executive-acceptance.test.js` K-13, K-14; `failure-semantics.test.js` | Synthetic actions |
| I | The user cancels after approval but before execution | No crossing opens, no step runs, and the refusal writes no execution record | `handoff-integrity-ao.test.js` B8; `cognition-lifecycle.test.js` cancellation before send | In-process and real child |
| J | A step is in flight when the task is cancelled | The in-flight step becomes uncertain, never verified, and is not replayed | `task-lifecycle.test.js` interrupted-task cancellation; `plan-continuation.test.js` real-child boundaries | Real child |
| K | The same proposal arrives twice and two runs are attempted at once | One effect and one verified handoff; the second crossing is denied and executes nothing | `handoff-integrity-ao.test.js` B1, B4; `integration-runtime-an.test.js` duplicates/concurrent; `executive-reliability.test.js` D | In-process and real child |
| L | The backend corrects or retracts a cited record inside `complete()` | `evidenceRecheck.available` is true and `authorizes` false; both phases are weakened; the recorded lineage is still `directly_supported`; a notice is printed; the operation stays `verification_unavailable`; no proposal is written | `acceptance-ao09.test.js` tests 4 and 5 | Synthetic reply, real stores |
| M | The plan is revised after approval | The revision clears the approval; activation is refused and names the stale binding | `plan-adversarial.test.js` modified-after-approval; `plan-continuation.test.js` materially revised plan | Real controller and stores |
| N | A real process is killed, then a fresh process reads and continues | The interrupted step is uncertain, the fresh process re-runs nothing, and explicit continuation records the uncertainty rather than the step | `plan-continuation.test.js` eight real-child boundaries; `process-recovery.test.js` | Real child |
| O | A JSONL store is corrupted or truncated | Reads refuse to present damage as empty, writes refuse to extend it, the bytes stay, and status names the damage | `storage-integrity.test.js`; `corruption-recovery-boundaries.test.js`; `acceptance-batch-i.test.js` #4 | Real files |
| P | The audit append fails after a possible effect | The success is downgraded, exit status is 3, `recorded:false` is disclosed, and no experience is invented | `append-audit-failure-semantics.test.js`; `acceptance-batch-i.test.js` #5 | Fault injection |
| Q | Model output carries authority-shaped fields, a claimed approval, or a claimed verification | The fields are dropped or refused; a model-origin decision is `ACTION_DENIED`; a declared permission cannot bypass the registry; a claimed verification is corrected; no record is written | `model-self-authorization.test.js`; `proposal-boundary-an.test.js`; `plan-adversarial.test.js`; `acceptance-ao09.test.js` tests 1 and 7 | Synthetic reply |
| R | A recovery request names an operation whose effect is uncertain | The recovery reads the records, refuses to replay the uncertain write, and produces no second effect | `plan-continuation.test.js` interrupted write; `adversarial-batch-am.test.js` I-12; `executive-interruption.test.js` D | Real child and in-process |

### Adversarial boundaries beyond the A-R walkthrough

| Boundary | What is injected | What the tests establish | Suites |
| --- | --- | --- | --- |
| Cognitive lifecycle | Invalid transitions, skipped stages, a failed or unavailable stage, false success | No failed, skipped, cancelled, or unavailable stage is reported as success; a stage the path did not enter is `not_reached` | `cognition-lifecycle`, `cognition-artifacts`, `cognition-trace`, `runtime-diagnostics-ao` |
| Gateway | Unavailable, timeout, malformed, empty, over-long, reasoning-only, refusal | Each becomes its own outcome with no invented answer and no execution | `gateway`, `gateway-resilience`, `runtime-states`, `integration-runtime-an` |
| Duplicate and late work | Duplicate request, duplicate proposal, delayed reply, replay | One effect; a late reply is discarded; a decided, expired, or invalidated proposal cannot be accepted again | `handoff-integrity-ao` B1, `integration-runtime-an`, `acceptance-ao09` tests 1-2 |
| Evidence integrity | Unsupported claim, model-declared support, forged reference, another request's record, duplicate id, missing/corrupt/stale/conflicting record, retraction after the claim | Support is derived from the stores; a forged or foreign reference is rejected; a duplicate id counts once; a retracted record stops counting; absence is not disproof | `cognition-evidence-states`, `cognition-lineage`, `integration-runtime-an`, `plan-adversarial`, `acceptance-ao09` tests 3-5 |
| Executive authority | Execute from a response, self-approval, forged or reused approval, post-approval edit, operation-id reuse, replay of expired/denied/superseded work, registry bypass, direct runner use, audit failure reported as success | The registry authorizes, the controller executes, the TaskRunner records each step, the independent verifier confirms it, and the audit/finalization line is written; no cognitive artifact, proposal, diagnostic, or handoff grants authority | `model-self-authorization`, `proposal-boundary-an`, `handoff-integrity-ao` A1-A7, `plan-adversarial`, `append-audit-failure-semantics`, `acceptance-ao09` tests 1, 2, 7 |
| Diagnostics and evaluation | Clock failure, unmeasured duration, skipped stage, recording failure, repeated evaluation | Timing is `null` not zero; the record is bounded and text-free; a recording failure cannot upgrade an outcome; evaluation is deterministic, non-mutating, and has no composite score | `runtime-diagnostics-ao`, `cognition-evaluation`, `acceptance-ao09` test 6 |

### Cross-process interruption, with real child processes

The table names what a fresh process finds, not what a fixture claims a process would have found.
Each child writes through the real store and is terminated (or stops itself) at its boundary; the
parent then reads the bytes with a separate process.

| Boundary | Real child fixture | State a fresh process finds | Recovery allowed |
| --- | --- | --- | --- |
| Before or inside persistence | `partial-write-child.mjs`, `finalization-child.mjs` | The fragment or the complete record that reached disk; damage is named, never read as empty | Explicit; the uncertain write is not replayed |
| During cognitive processing / before send | `cancelled-request-child.mjs` | A cancelled request with no answer and no execution | New request only |
| After proposal creation, holding the store claim | `proposal-after-create-child.mjs` (new) | One `proposal_created`, no decision, one abandoned claim; the next write takes it over | The user's explicit decision; a replay is refused |
| During execution / after an uncertain effect | `interrupted-run-child.mjs`, `continuation-child.mjs`, `executive-interruption-child.mjs` | The step is `running` or `uncertain`; the effect file is the only evidence of the effect | Explicit continuation; the uncertain step is never re-run |
| During verification / before finalization / during the audit append | `continuation-child.mjs` (five boundaries), `finalization-child.mjs` (six boundaries) | No record claims the step, or the torn line is residue; neither absence nor damage is treated as success | Explicit; the read names what is unknown |
| During continuation / two continuations at once | `continuation-cross-process-an`, `plan-continuation` children | One process takes up the work; the other reports none; no step repeats | Explicit; no background recovery |

No background recovery starts in any of these cases. A refused or impossible continuation executes
nothing and writes nothing, and every accepted recovery is caller-initiated.

Two boundaries in the package's list are not exercised with a killed child: "after approval, before
plan activation" and "inside authorization". Their critical sections are in-process and leave no
persisted intermediate state to kill, so their refusal behavior is tested with the real controller
and stores in-process, and the post-interruption record reading is covered by the persisted-event
tests above. This is a limit of the evidence, stated rather than implied.

### Concurrency and store integrity

The existing suites already cover lock ownership loss, stale and recycled holders, malformed and
truncated JSONL, append failures, readback mismatch, cross-store inconsistency, damaged diagnostics,
and partial finalization: `storage-concurrency`, `store-write-concurrency`, `cross-process-stress`,
`lock-contention`, `lock-recovery`, `lock-ownership-and-recovery`, `prediction-concurrency`,
`experience-concurrency`, `executive-reliability`, and `continuation-cross-process-an`. This package
re-reads those rules rather than relaxing them: the child's abandoned proposal claim is resolved
through the ordinary takeover election, and the parent's acceptance is the write that proves it.
A decision is never stolen from a live holder, and an uncertain effect is never silently replayed.

### What these tests do not establish

- No test in this package runs a model. Every reply is a fixed string or a deterministic in-process
  fixture; no endpoint is contacted, no inference is run, and no local model server is used.
- The results are behavior of this code on this platform in temporary directories. They do not
  establish real-world truth, answer quality, or that a real model reasons correctly.
- In-process fault injection is not the same as a killed process. The boundaries without a real
  child are named above.
- A refused proposal decision surfaces as `EXECUTION_FAILED` because the acceptance action throws
  during `execute()`. The tests assert the refusal and the unchanged log, not a particular label;
  a refused decision is never a success.
- The cognitive evaluation harness has no handoff scenario. Handoff has its own suites
  (`handoff-integrity-ao`, `handoff-hash-binding-ao`, `executive-acceptance`), so no evaluation
  dimension was invented for this package.
- Two POSIX-only filesystem checks remain skipped on this Windows machine.

### Measured: package H against the AO-08 tree

The controlled baseline is the committed HEAD tree extracted with `git archive` (it has no
`recheckEvidence`), and the after tree is this working tree. Each was run with the same benchmark
script, the same in-process fixture, nine repetitions, sequentially, with no test or benchmark
running alongside. The benchmark writes only into fresh temporary directories. Median figures:

| Path | AO-08 HEAD | Package H |
| --- | --- | --- |
| Answer request total, 0 records | 25.7 ms | 20.3 ms |
| Answer request total, 20 records | 26.0 ms | 27.0 ms |
| Answer request total, 200 records | 111.5 ms | 110.1 ms |
| Answer request total, 800 records | 278.8 ms | 298.0 ms |
| Answer request total, 2,000 records | 743.0 ms | 726.2 ms |
| Permitted read proposal (wall) | 90.3 ms | 81.2 ms |
| Duplicated/denied/malformed proposal (wall) | 97.0 / 85.5 / 83.3 ms | 87.3 / 80.8 / 76.8 ms |
| Handoff build + check, 1/2/4/8 steps | 0.108 / 0.068 / 0.080 / 0.101 ms | 0.100 / 0.058 / 0.077 / 0.116 ms |
| Plan activate, 1/8 steps | 371.7 / 694.4 ms | 336.3 / 727.8 ms |
| Continuation report (`work`/`next`) | 9.8 ms | 10.6 ms |
| Diagnostics workload, 16 stages | 21.5 us | 22.8 us |
| Diagnostics record size | 3,334 bytes | 3,334 bytes |

The answer path includes the new read-only re-check because the fixture reply does carry recorded
lineage. The differences are mixed in sign and mostly within the run-to-run spread this machine
shows: for context, the committed AO-08 README reports a 652 ms median at 2,000 records, while the
same HEAD tree measured 743 ms in this session's control run. No repeatable regression is shown on
any listed path, and no cache, index, or schema change was introduced by this package. The added
re-check reads at most 128 cited ids through one store load per source and runs only when an answer
has recorded lineage; a request without one pays nothing.

The full `npm test` run that closed this package (the 139 files named in `package.json`, both new
suites included) ran **2,356 tests, 2,354 passed, 0 failed, 2 skipped** in 490.9 s on Windows 11,
Node v26.4.0, in isolated temporary data directories. The two skips are the POSIX-only checks this
filesystem cannot perform. No test in that run contacts a model or opens a socket: every gateway is
the no-backend one or a programmatic stub with a fixed reply.

## Batch AO (package I): consolidation, documentation audit and release readiness

This package did not add a runtime capability. It consolidated what AO-01 to AO-09 built, checked
the documentation against the code, corrected statements that no longer matched `main`, and ran the
final regression.

### What was produced

- [`ARCHITECTURE.md`](ARCHITECTURE.md): one consolidated architecture document covering the cognitive
  runtime, the executive system, the evidence and memory stores, diagnostics and evaluation, the
  authority/trust-boundary map, the capability matrix with the six required statuses, the acceptance
  and risk register, measured performance, and the known gaps between documentation and code.
- The root `README.md` was reconciled with the code. It now points at the architecture document, the
  application README, and `DEVELOPMENT_WORKFLOW.md`.

### Documentation defects corrected

The root README linked to files that are not present on `main`: `docs/BUILD_AND_TEST.md`,
`docs/IMPLEMENTATION_STATUS.md`, `docs/RECORD_STORAGE_SAFETY.md`, and `tools/README.md`. It also
described `record_inspector`, `tools/validate.py`, and the `STARK_BUILD_RESEARCH_DRIVERS` /
`STARK_BUILD_DIAGNOSTICS` CMake options as if they were available here. Git history shows those
documents and tools were developed on research branches that were never merged into `main`, so the
commands could not run. The root README now says that plainly and names the checks that do exist:
CMake/CTest for the C++ tree and `npm test` for the application. No historical file was deleted or
rewritten to make the links true.

The application README's recorded full-suite duration was also corrected to the final measured run
below; the test and file counts were already accurate.

### What this package did not change

No application source, test, authorization rule, evidence rule, lock, audit rule, or verification
rule was changed by AO-10. `stark/` was not modified. No test runs a model or contacts an endpoint.
The only edits are the new architecture document, the two READMEs, and the recorded measurements.

### Final regression

The complete `npm test` run (139 files) after the documentation changes ran **2,356 tests, 2,354
passed, 0 failed, 2 skipped** in 483.7 s on Windows 11, Node v26.4.0, in isolated
temporary data directories. The two skips are the POSIX-only filesystem checks this environment
cannot perform.

### Recommended next milestone

Close the one open arrow in the roadmap's stage 6 rather than add more scaffolding: make one recorded
outcome or prediction verdict change exactly one later, disclosed decision (for example, the order of
plan candidates), reversibly and with an audit record, without granting any component new authority.
It is measurable by a before/after comparison over stored records, a reversal test, and an
adversarial test showing the verdict cannot approve, start, or carry a plan. It needs no model and no
new store. Nothing in this checkout implements it yet.

*After this package, Batch AP implemented the bounded form of that recommendation for one signal: an
approved adaptation record whose shape the user recorded. Batch AP-02 then extended it to a second
signal — a completed evaluation of a user-recorded prediction — under a separate user approval. The
paragraph above describes the AO-10 state and is left as written; what actually exists now is stated in
[Batch AP](#batch-ap-one-disclosed-reversible-decision-from-recorded-evidence-as-implemented) and
[Batch AP-02](#batch-ap-02-one-evaluated-prediction-one-approved-candidate-one-disclosed-influence-as-implemented).*

## Batch AP: one disclosed, reversible decision from recorded evidence (as implemented)

This package implements the recommendation the previous one left open, in the narrowest form the existing
records support: **one eligible, user-approved record changes exactly one later decision - which candidate
leads the comparison a goal's approaches are offered in - and the answer states the decision the same rule
would have taken without it.** It adds no store, no action, no registry entry, no planner, and no
authorization rule.

### The decision point

`plan.candidates` and `plan.replan` already compare the approaches a recorded goal supports under a
disclosed gate-then-Pareto rule (`src/plans/evaluation.js`). Batch AM had already let an approved adaptation
with a recorded shape contribute the `approved_adaptation_fit` dimension, so a user's recorded preference
could order the candidates. What was missing was the decision itself being visible: a reader could see the
dimension and still not see what it did. Batch AP computes, in the same call, the same rule over the same
candidate bytes with only that one dimension removed (`frontUnder` over `RANKED_DIMENSIONS` minus
`approved_adaptation_fit`) and reports both results together as `adaptationDecision`:

- `before` / `after`: the front and the single leading candidate each rule produced, so "no single leading
  candidate" and "two candidates still lead" are stated rather than implied;
- `outcome`: `declined`, `changed`, or `applied_not_changed` - applying and changing nothing is a distinct
  answer from not applying at all;
- `rules`: the id, capability, version (which recorded statement of the shape was in force), content hash,
  and the supporting experience/feedback ids of every record that applied, deduplicated and bounded at 20
  ids per kind with a `truncated` flag;
- `considered`: every record the ledger read, with its state and why - including the ineligible ones, so a
  reader can see what was excluded and not only what was used;
- `declinedReason`: the ledger's own reason when nothing applied (no record read, no record in scope, a
  candidate record the user has not approved, an inert state, or two approved records that disagree);
- `digest`, `authorizes: false`, and a one-line note naming what the influence cannot do.

The counterfactual is not a second ranking system: it is the same `dominance` function with one name
removed from the list. `plan-actions.js` prints the block after the guidance ledger for both reads. Nothing
in the block is written to a store; `plans.list()` stays empty unless the user separately records a plan,
and `recorded`, `approved` and `executable` remain `false`.

### Eligibility: what may move it

Only a record that is all of these can change the ordering, and each exclusion is reported with its state
rather than silently dropped:

- **user-origin** - feedback, an adaptation decision, a shape, and a retirement are user-only actions; a
  model-origin call is denied by the registry before any body runs (`ORIGIN_NOT_PERMITTED`), and the test
  asserts the learning log gains no record;
- **approved** - a candidate the user never approved, or one the user rejected, is inert (`candidate`,
  `rejected`);
- **active and intact** - a retired rule, an ambiguous retirement log, or a rule whose supporting evidence
  no longer stands is inert (`retired`, `ambiguous`, `stale`);
- **relevant** - the rule's capability scope must prefix a capability the candidate steps actually name; a
  scope no step uses is `out_of_scope`;
- **shaped** - the record must carry a shape the user recorded (`order`, `avoid`, `prefer`, `maxSteps`); an
  approved record with no shape is `unshaped` and asks nothing;
- **consistent** - two approved records for an overlapping scope that ask for opposite things withhold the
  ordering and are both printed with their ids; neither is chosen;
- **well-formed** - an unknown order, a non-list `avoid`/`prefer`, or a step bound outside 1..8 is refused
  as void, never interpreted.

A prediction verdict is **not** a signal here on its own. `prediction evaluate` writes a verdict about a
capability over a horizon, and nothing reads it until a user-approved prediction-derived candidate exists
(Batch AP-02, below); the tests record an expired prediction and an evaluation-awaiting prediction and
assert that neither moves the ordering. Model-origin evidence is excluded for the same reason. Duplicate
citations cannot amplify a rule: the feedback derivation requires two *distinct* supporting experiences,
the prediction path cites exactly one prediction and one evaluation and skips a repeated derivation, and
the decision's evidence lists are deduplicated.

### What cannot change

The tests compare the before, with, and after-reversal reads field by field. Applying a rule changes no
candidate byte, no candidate digest, no gate outcome, no ranked dimension other than
`approved_adaptation_fit`, no constraint, no approval, no goal status, and no capability definition. A rule
cannot readmit work a hard constraint excluded, cannot approve or start a plan, cannot produce an
authorization, and cannot alter a verification result. Selection still refuses a comparison whose leader's
bytes no longer match the digests the comparison was bound to, so an influenced ordering can never carry
different plan bytes into approval.

### Reversal

`adaptation.retire` is the same user-only record it was before. After it, the adaptation's history, its
shape, its support and the retirement reason remain readable (`adaptationDetail`), the decision returns to
the one the work's own records produce, and the test asserts it equals the baseline read taken before any
learning record existed. No executed or approved plan is rewritten; reversal is prospective.

### Tests and measured cost

`tests/adaptation-decision.test.js` (23 cases, registered in `npm test`) covers the eligibility layers, the
bounded-influence assertions, and the real-store/controller/audit path, including a before → with →
after-reversal end-to-end run, a model-origin denial, unapproved/expired/awaiting predictions, an unknown
rule representation, a stale-guidance verification refusal, and an audit-append failure that is reported as
unrecorded rather than successful. Together with the Batch AM suites it is the focused regression for the
path.

The benchmark is `benchmarks/run-adaptation-decision-benchmark.mjs`; it imports the real pre-AP module from
`git archive` and the current one, warms both, then measures interleaved on identical fixtures. At 4 / 10 /
20 candidates the comparison cost 0.144 / 0.261 / 0.849 ms before and 0.180 / 0.268 / 1.258 ms after (added
0.036 / 0.007 / 0.408 ms), with the disclosure render at 0.002-0.010 ms and every other field identical
between the two builds. **No cache, index, or persisted state was added**: the counterfactual is a second
O(n²) pass over at most the bounded candidate set, and at those sizes it is not worth one.

The complete `npm test` run after Batch AP (140 files, both new suites included) ran **2,379 tests, 2,377
passed, 0 failed, 2 skipped** in 489.1 s on Windows 11, Node v26.4.0, in isolated temporary data
directories. The two skips are the POSIX-only checks this filesystem cannot perform. No test in that run
contacts a model or opens a socket.

### What this does not claim

It does not implement a fitted weight, a learned ranking recomputed from results, or a causal claim that an
approach is better because a record preferred it. It moves an ordering among candidates that already passed
every gate, and reports that it did so. By itself it did not let a prediction verdict reach that ordering;
the separate, bounded pathway below does. Stages 5 and 6 of the roadmap below remain open on their wider
clauses.

## Batch AP-02: one evaluated prediction, one approved candidate, one disclosed influence (as implemented)

This package extends the same single decision to a second kind of recorded evidence: **a completed,
current evaluation of a prediction the user recorded can be derived as one bounded adaptation candidate;
the user inspects and approves it explicitly; only then can it re-order approaches in a comparison, through
the same `approved_adaptation_fit` dimension.** It adds one pure derivation module
(`src/experience/prediction-derivation.js`), one read action (`adaptation.eligibility`), a prediction
branch inside `adaptation.derive` and the experience store, and a per-rule provenance field in the
existing disclosure. It adds no store, no action that writes, no planner, no registry entry, no
authorization rule, no new decision dimension, and no parallel learning system. A prediction, an
evaluation, and an approval remain three different records.

### Five transitions, five different facts

| Transition | Established by | What it means | What it does not mean |
|---|---|---|---|
| **Recorded** | `prediction record` | The user stated an expectation, a capability, a horizon, and the evidence it rested on; user origin only | It is not an observation, a verdict, or a rule; no model can write it |
| **Evaluated** | `prediction evaluate` | A deterministic comparison of the expectation with outcomes inside its horizon stored a verdict | It approves nothing, derives nothing, and changes no other record |
| **Eligible** | `adaptation eligibility` (read-only) | This evaluation is complete, current, user-origin, and its lineage and outcome records still stand, so a candidate *could* rest on it | Nothing is derived or approved; an eligible prediction is only a candidate for the user's consideration |
| **Approved** | `adaptation derive`, then `adaptation approve` | The user inspected the bounded candidate and recorded an approval through the existing decision action | Approval is not inferred from a successful evaluation, and it grants no permission |
| **Influencing** | `plan candidates` / `plan replan` | The approved, active, shaped record contributes only `approved_adaptation_fit`, and the decision says so | It cannot change candidate bytes, steps, gates, criteria, approvals, authorization, execution or verification |

```bash
apex prediction record --capability memory.add --expect success --in-days 7 --subject "the next note write succeeds"
# ... the outcome is later recorded, then:
apex prediction evaluate <prediction-id>
apex adaptation eligibility --capability memory.add    # what could become a candidate, and why the rest cannot
apex adaptation derive                                 # appends an unapproved candidate; never active
apex adaptation list                                   # state: candidate, approved, rejected, retired, ambiguous
apex adaptation approve <adaptation-id> --reason "I agree with the recorded outcome"
apex plan candidates <goal-id>                         # the disclosure names the prediction/evaluation it used
apex adaptation retire <adaptation-id> --reason "no longer applicable"
```

### Eligibility: what may become a candidate

`predictionEligibility` judges one evaluated projection against a closed set of states, and every state
other than `eligible` is inert and carries its reason:

- `not_evaluated` — no evaluation is recorded, or the ledger reports the expectation awaiting or otherwise
  not evaluated; **an expired horizon is not an incorrect prediction** and never becomes eligible;
- `invalidated` — the user withdrew the expectation;
- `superseded` — a later expectation replaced it;
- `evaluation_missing` / `evaluation_stale` — no stored verdict, or a fresh read would settle it
  differently;
- `evidence_unavailable` / `unresolved_citation` — the experience log cannot be read, or a cited record
  does not resolve;
- `outcome_evidence_not_current` — the evaluation cites no outcome experience, names no deciding outcome
  class, or cites a record that a later record corrected;
- `not_scopable` / `provenance_not_user` — the scope is not a capability name, or the record is not the
  user's own expectation;
- `evaluation_changed` / `prediction_store_unavailable` — the store's currentness read found the ledger
  disagrees with the record that was approved.

Conflicting or stale evidence fails closed. A model-origin record cannot be recorded, evaluated, derived,
or decided. Duplicate citations and repeated derivation cannot amplify one prediction: a proposal is built
per projection, its support names exactly one prediction and one evaluation, `minSupport` is 1 for this
method, and a second derivation skips a prediction that already has a candidate.

### The candidate and the typed rule

The proposal is a typed object, not text to be interpreted: `type: 'evaluated_prediction'`,
`dimension: 'approved_adaptation_fit'`, `guidance: { order, avoid, prefer, maxSteps }`, `verdicts`,
`limitations`, and `evidenceDigest`. The mapping is the closed `OUTCOME_PROPOSAL_FIELD`: a recorded
`success` proposes `prefer` for the capability; `failure` and `blocked` propose `avoid`. The verdict word
is not the rule — a contradicted verdict still follows the recorded outcome class, and the mapping is
printed so a reader can disagree with it. The prediction's own subject text is display-only and is never
parsed. An unknown type, an unknown field, or a malformed shape is refused; no arbitrary text can become
an executable rule.

### Approval is explicit and user-controlled

`adaptation derive` only appends an unapproved candidate, and its independent verification re-reads the
record and refuses if the candidate is active, if its provenance is not deterministic derivation, or if it
does not cite exactly one current prediction and one evaluation. `adaptation approve` is the existing
user-origin decision and the only approval; it verifies that the decision did not change the candidate's
rule or scope. `adaptation eligibility` derives, approves and applies nothing. A successful evaluation is
never treated as consent.

### What the comparison discloses

The `adaptationDecision` block keeps its schema (`apex.adaptation-decision.v1`) and `authorizes: false`.
Each applied rule now names its `source` and `method`, and `sources.predictionEvidence` distinguishes
`none` (no prediction record was considered), `both` (feedback- and prediction-derived rules both applied),
`prediction_derived` (only a prediction-derived rule applied), and `prediction_rejected` (prediction
evidence was considered and could not be used, naming each rejected record and its state). A feedback-only
decision is `none` with a non-empty `feedbackDerived` list. The counterfactual still removes only
`approved_adaptation_fit`; there is no new dimension. Applying a prediction-derived rule changes no
candidate byte, gate, step, goal criterion, approval, authorization, verification or task record, and a
combined outcome never counts one prediction twice.

### Reversal and lineage

`adaptation retire` works identically for a prediction-derived record: the candidate, the decision, the
proposal and the prediction/evaluation ids remain readable, and the next comparison returns the unadapted
order. If the prediction is invalidated, superseded, re-evaluated or becomes unreadable after approval, the
store's currentness check forces the record inactive with `prediction_store_unavailable` or
`evaluation_changed`; the approval is preserved, its effect is withdrawn, and a future read reports the
record inert until the user explicitly reconciles it. No historical evaluation or audit line is rewritten,
no already-approved plan changes, and no executed task is altered.

### Tests and measured cost

`tests/prediction-adaptation-learning.test.js` (21 cases, registered in `npm test`) covers the eligibility
matrix, awaiting/expired/invalidated/superseded/conflicting evidence, stale and unreadable lineages,
model-origin refusal, duplicate non-amplification, approval separation, typed-rule refusal, the five
disclosure distinctions, the real-store/controller/audit end-to-end run (record → evaluate → inspect →
derive → approve → compare → retire → restored baseline), and an audit-append failure reported as
unrecorded rather than successful.

`benchmarks/run-prediction-adaptation-benchmark.mjs` compares the AP-01 decision path with the
prediction-informed path on identical fixtures. At 4 / 10 / 20 candidates the combined ledger + comparison
median was 0.201 / 0.262 / 0.687 ms under AP-01 and 0.166 / 0.261 / 0.678 ms with prediction-derived rows —
differences within run-to-run spread — with identical candidate bytes, gates and binding throughout. The
eligibility rule costs about 2.6–4.5 µs per evaluated projection with no caching. The measurement excludes
the store's per-read currentness check; AP-03 later made that check one batched ledger read per read
instead of one per cited prediction, and its cost is included in the AP-03 complete-request measurement
below. See
[`benchmarks/README.md`](benchmarks/README.md#prediction-informed-adaptation-benchmark-batch-ap-02).

The complete `npm test` run after Batch AP-02 (141 files, the new suite included) ran **2,400 tests, 2,398
passed, 0 failed, 2 skipped** in 232.6 s on Windows 11, Node v26.4.0, in isolated temporary data
directories. The two skips are the same POSIX-only checks the earlier runs skip. Two pre-existing
assertions were aligned rather than loosened: the health-stat shape now states the AP-02 counters, and
the feedback-only derivation keeps its exact AP-01 sentence while a prediction-derived candidate gets the
accurate one. No test in that run contacts a model or opens a socket.

### What this does not claim

It does not claim APEX predicts accurately, that a verdict is a probability, that the recorded outcome
caused the later result, or that an approved prediction-derived rule improves work. It does not claim a
fitted weight, a learned ranking recomputed from results, or autonomy: every step from evidence to an
applied rule needs a user action. It claims only that one completed evaluation can become a bounded
candidate, that only the user's approval makes it evidence, and that the resulting ordering influence is
disclosed, bounded, auditable and reversible. Stages 5 and 6 of the roadmap below remain open on their
wider clauses.

## Batch AP-03: repeated recorded outcomes, described and never assumed (as implemented)

This package extends the single decision from one evaluated prediction to a bounded sequence of them. It
answers one narrow question — **in one capability's recorded history, is the order of recorded outcomes
repeated, alternating, turning, or not enough to say?** — and nothing more. It adds one pure analysis
module (`src/prediction/longitudinal.js`), one read action (`prediction.longitudinal`), a longitudinal
branch in `adaptation.derive` and the experience store, a `sources.longitudinalDerived` distinction in the
existing disclosure, and one batched ledger read (`predictions.details`) used by the currentness check. It
adds no store, no new prediction or experience file, no planner, no new permission or origin, no
authorization rule, no new decision dimension, and no parallel learning system. An evaluation, an aggregation, an approval, and
an applied rule remain four different facts.

### Read-only analysis, closed vocabulary

`analyzeLongitudinal` reads stored predictions and their recorded evaluations and projects a scoped report
(schema `apex.longitudinal.v1`). It writes nothing: no record is repaired, promoted, annotated, or approved.
The vocabulary is a closed set of eight kinds, with no free-form text parsing:

| Kind | What the recorded order shows | Proposes a direction? |
|---|---|---|
| `repeated_success` | every scored outcome in the scope is a success | yes — `prefer` |
| `repeated_failure` | every scored outcome is a failure | yes — `avoid` |
| `alternating_outcomes` | successes and failures alternate in recorded order | yes |
| `consistent_improvement` / `consistent_regression` | a directional sequence turns one way | yes |
| `mixed_outcomes` | successes and failures without one direction | no |
| `insufficient_evidence` | fewer than the two observations a repetition needs | no |
| `conflicting_evidence` | the evidence disagrees or cannot be reconciled | no |

`MIN_REPEATED_OBSERVATIONS = 2` and `MIN_SEQUENCE_OBSERVATIONS = 3` are definitions of "repeated" and "a
sequence", not accuracy thresholds: two observations can repeat, and three are needed before an order can
alternate or turn. The report repeats the note that it "makes no causal claim, states no confidence, and
approves nothing".

### Grouping, dedupe and exclusions

A group is one capability name; a parent name never absorbs a child capability's records, and unrelated
capabilities are never merged into one pattern. Observations are ordered chronologically by recorded
outcome time, deduplicated by prediction id and evaluation id, and each observation names its own
prediction, evaluation and evidence ids — a citation cannot count twice. Records withdrawn, replaced,
expired, stale, unreadable, non-user, or outside a capability scope are **excluded by kind**, each with its
wording, and the report prints up to 20 exclusions per group and says when it truncated. A missing record is
never read as a failure: absence is an exclusion with a reason, and an unreadable store is a refusal, not an
empty history.

### Calibration is separate and keeps its floor

The existing derivation is reused verbatim, with its **minimum of 20 scored evaluations** intact. The
report states recorded, evaluated, eligible-scored and excluded counts; below the floor, calibration is
explicitly `unavailable` with the reason `below 20`, and is never read as a good or poor rate. Calibration
is not authorization.

### Bounds, truncation and refusal

The derivation reads at most 20 predictions (`MAX_LONGITUDINAL_PREDICTIONS`). When the scope holds more,
the read is partial, the report says so, and **no pattern is derived from it**: a rule is refused rather
than inferred from a prefix of the history. Groups are bounded at 20, observations and exclusions shown per
group at 20, and support refs per rule at 20; the report names the bound it hit.

### A pattern may become a candidate; it never approves one

`adaptation.derive` turns a directional pattern into a candidate with `method: 'repeated_outcome_pattern'`,
an explicit `type: 'repeated_outcome_pattern'` proposal, and the cited prediction/evaluation ids in
`support` (bounded at 20). The rule is the recorded pattern's direction mapped through a closed mapping and
printed in the record so a reader can disagree with it; the predictions' subject text is display-only and
never parsed. A scope is answered by its pattern, not also by each member: a prediction covered by the
longitudinal candidate is not additionally turned into its own single-evaluation candidate.
`adaptation.approve` remains the only approval and remains user-origin only; its independent verification
re-reads the candidate and refuses one whose citations no longer resolve. A repeated pattern is never
automatically promoted to an executable rule.

```bash
apex prediction longitudinal --capability memory.add   # read-only: patterns, counts, exclusions, calibration
apex adaptation derive                                 # a directional pattern may become an unapproved candidate
apex adaptation approve <adaptation-id> --reason "I agree with the recorded sequence"
apex plan candidates <goal-id>                         # disclosure names the longitudinal basis and its citations
apex adaptation retire <adaptation-id> --reason "no longer applicable"
```

### Influence, currentness and reversal

An approved longitudinal candidate feeds only `approved_adaptation_fit`, exactly as AP-01/AP-02. The
decision block gains `sources.longitudinalDerived` beside `sources.singleEvaluationDerived` and
`sources.predictionEvidence`, and each applied rule carries `basis` (`repeated_feedback`, `single_evaluation`,
or `longitudinal_pattern`), so a reader can tell a single observation from a supported sequence. The
counterfactual, candidate bytes, gates and ranked dimensions are unchanged; there is no new dimension and no
new authorization pathway. Every adaptation read re-judges each cited prediction against the live ledger via
`predictions.details`, which reads and projects the log once for all references; nothing is retained between
checks, so a re-evaluation, invalidation, or a later outcome inside a cited horizon makes the record
ineligible until reconciled. The approval stands, its effect is withheld, and on reconciliation the unadapted
decision returns without any record being rewritten. `adaptation.retire` remains the reversal and restores
the unadapted ordering.

### Tests and measured cost

`tests/longitudinal-outcome-analysis.test.js` (29 cases in 6 suites, registered in `npm test`) covers the
vocabulary and eligibility matrix, calibration at 19 vs 20, duplicate evaluations and citations, exclusion
kinds (expiry is not failure, missing is not failure), mixed and alternating groups, unrelated capabilities,
conflicting and damaged-store evidence, model-origin ineligibility, that aggregation can neither approve nor
activate, that only an approved adaptation moves the dimension, re-evaluation/invalidation removing
influence, retirement restoring the baseline, refusal to bypass plan approval/authorization/execution/
verification, concurrent changes not leaving stale influence, and a deterministic end-to-end run through real
stores, the controller and the audit log. It also asserts the batched currentness read returns exactly what
one read per citation returned.

`benchmarks/run-longitudinal-benchmark.mjs` measures the pure analysis as the recorded history grows and the
**complete** production request path. On this machine the pure analysis took a median 0.21 / 0.40 / 2.74 /
2.73 ms at 20 / 100 / 500 / 1,000 evaluations (one capability, one group per 25 records capped at 20 groups).
With one evaluated capability, the complete request cost a median 27.7 / 68.0 / 72.5 ms at 8 / 14 / 19
recorded evaluations with no rule; the AP-03 rule moved it by a median +1.2 / +5.8 / +7.1 ms (AP-02 by
+0.5 / +19.1 / +2.3 ms) on the identical store. Those figures include the batched currentness read and
machine noise and are observations of one machine at one time, not a specification; partial sub-timings are
printed separately and are not the request cost. See
[`benchmarks/README.md`](benchmarks/README.md#longitudinal-outcome-benchmark-batch-ap-03).

### What this does not claim

A repeated association in recorded order is not a cause, not a probability, not a confidence, and not a
forecast. The analysis does not say a capability will succeed, does not fit a weight, does not compute an
accuracy, and does not approve, activate, or execute anything. It claims only that a bounded, scoped,
deduplicated sequence of recorded outcomes can be described and shown, that a directional one can become a
candidate, and that only the user's explicit approval lets it reorder one disclosed comparison. Stages 5 and
6 of the roadmap below remain open on their wider clauses.

## Batch AP-04: adaptation effectiveness and outcome verification (as implemented)

This package asks whether the decisions an approved record was actually part of were followed by
better, worse, or unchanged **recorded** outcomes — and refuses to answer more than the records
support. It adds one pure read module (`src/plans/effectiveness.js`), one read action
(`adaptation.effectiveness`), a controller method, and a CLI command. It adds no store, no new record
type, no planner, no permission or origin, no decision dimension, and no execution path. Approval,
application, execution, assessment and cause remain five different facts.

### What the read traces

For each approved adaptation the read follows records that already exist: the rule, version and hash
→ the decision disclosure recorded in the `plan.candidates` operation → the candidate and plan
identity that disclosure named → the plan's activation, step operations and audit records → the
per-step verification outcomes → the plan assessment and its outcome evidence. Ids and content hashes
are the join keys; nothing is invented and nothing is rewritten. A use whose decision cannot be
established is excluded with its reason, never inferred from eligibility.

The read is one closed classification per adaptation:

| State | What the records show |
|---|---|
| `not_approved` | a candidate exists and no decision was recorded |
| `approved_never_applied` | approved, but no comparison recorded it as applied |
| `applied_outcome_pending` | applied and executed, no assessment yet |
| `applied_successful` | an assessment established success |
| `applied_partially_successful` | an assessment established a partial outcome |
| `applied_failed` | an assessment recorded a failure |
| `applied_blocked_or_uncertain` | the outcome was blocked or uncertain, never converted to failure |
| `applied_awaiting_confirmation` | the plan's assessment awaits user confirmation |
| `applied_insufficient_evidence` | no assessment, a cancelled plan, or a missing record |
| `applied_conflicting_evidence` | assessments that disagree are preserved, not averaged |
| `applied_mixed_outcomes` | uses under the current version divide between success and failure |
| `applied_not_changed` | the rule applied but did not change the comparison |
| `applied_unattributed` | the use cannot be attributed to the rule with the available records |
| `applied_to_earlier_version` | every use is tied to a superseded rule version |
| `retired_before_evaluation` | the record was retired before an outcome could be read |
| `ineligible_support_invalid` | the record's support no longer stands |

### The comparison is a disclosure, not a baseline trial

For each use the report states which candidate led before and after the rule, whether selection
changed, whether execution followed, what verification reported, and whether a comparable unadapted
outcome exists. The unadapted decision was disclosed but **not executed**, so its outcome is reported
`unavailable` and is never estimated. No baseline plan is created or run, and no probability,
confidence, significance test, or causal explanation is produced. A small sample stays explicitly
`insufficient_evidence`.

```bash
apex adaptation effectiveness                       # every adaptation, newest 20 within the bound
apex adaptation effectiveness --adaptation <id>    # one record, its uses and counterfactuals
```

### Review, not optimization

The report may recommend review and may name `consider_retirement`, but it cannot retire. Retirement
remains `adaptation.retire`, rule changes remain `adaptation.guide`, and the read cannot approve,
execute, retry, or change a plan, goal, or task. Every report carries `authorizes: false`; the
display says the read approves nothing, changes no rule, retires no adaptation, and executes no task.
The independent verification re-runs the whole analysis and compares its digest, so a change between
the two reads (an approval, a guidance change, a retirement, a new plan or assessment, a differently
linked use) is reported as a failed verification instead of a stale report.

### Bounds and failure behavior

At most 20 adaptations (`MAX_EFFECTIVENESS_ADAPTATIONS`), at most 100 uses in total
(`MAX_EFFECTIVENESS_USES`), 20 kept uses per adaptation with 10 displayed samples and the true counts
still reported, and at most 20,000 audit records scanned (`MAX_AUDIT_SCAN`); the report names the
bound it hit. A damaged or unreadable store raises the same `StoreError` as the other reads — a
refusal, not an empty history.

### Tests and measured cost

`tests/adaptation-effectiveness.test.js` (20 cases, registered in `npm test`) covers the lifecycle
states and the distinctions above, lineage and version attribution, conflicting and insufficient
evidence, damaged stores, bounded reads, counterfactual limits, that approval is never treated as
application or success, that a record cannot retire itself, that retirement happens only through the
existing operation, and a deterministic end-to-end run (approve → influenced decision → separate plan
approval → execution → verification → outcome → assessment → review → optional retirement → baseline
decision restored).

`benchmarks/run-effectiveness-benchmark.mjs` measures the **complete verified request** as the number
of linked uses (4 / 12 / 24) and stored adaptations (1 / 8 / 20 / 21) grows, plus concurrent reads
beside writes, with the store and audit reads printed separately and labelled partial. On this machine
the complete request took a median 52.3 / 146.7 / 318.4 ms at 4 / 12 / 24 linked uses - about 13 / 12
/ 13 ms per use, with the pure analysis at 27.5 / 71.4 / 167.6 ms - and 316.4 / 320.4 / 337.9 ms at 1
/ 8 / 20 stored adaptations. At 21 stored records the oldest target falls outside the newest-20 window
and its uses are not read, which the report says. A read issued beside a write verified the write and
refused itself (`verification_failed`), because the concurrent append changed the evidence between its
two reads; that refusal is reported, not hidden. See
[`benchmarks/README.md`](benchmarks/README.md#adaptation-effectiveness-benchmark-batch-ap-04) for the
tables and their limits; the figures are observations of one machine at one time, not a specification.

### What this does not claim

No proven causality, no guaranteed improvement, no autonomous rule optimization, and no automatic
retirement. An association between an approved rule and a later assessed outcome can have many other
causes, including the user's own choices, and the report says so. Stages 5 and 6 of the roadmap below
remain open on their wider clauses.

## Batch AP-05: adaptation governance, evidence reconciliation and controlled lifecycle decisions (as implemented)

AP-04 made the lifecycle readable. AP-05 makes it answerable: when the effectiveness report says an
approved record needs attention, the user can open a **governance review** against the exact evidence
the stores hold at that moment, inspect it later, be told truthfully what changed since, and record
one of three lifecycle decisions. It adds two record kinds to the existing experience store
(`adaptation_review`, `adaptation_review_decision`), one canonical evidence module
(`src/experience/review.js`), one pure analysis module (`src/plans/governance.js`), five actions, a
controller surface and four CLI commands. It adds no store, no new authority, no planner, no decision
dimension, no execution path, and no second retirement mechanism.

### What a review cites

A review is a bounded, canonical snapshot of the report that recommended it, in schema
`apex.review-evidence.v1`: the adaptation id and capability; the rule text, hash, version and shape;
the adaptation's decision state, active/retired flags, support state, source and conflict ids; the
report's availability, state, summary, recommendation, recommendation reason and observations; the
supporting, missing and superseded experience and feedback ids; up to 20 prediction references and
one pattern reference; up to 20 uses with their recorded outcome; up to 20 plan references and 20 goal
references; and the read bounds. Field order and bounds are fixed in one function, so two bundles can be compared by SHA-256
digest without a normalisation step. The report digest is recorded separately because it covers the
whole report - including how many audit records were read - and can move while every item the review
cites stays identical.

```bash
apex adaptation reviews                                    # which adaptations need attention
apex adaptation review show <adaptation-id|review-id>     # one review, its evidence and history
apex adaptation review reconcile <adaptation-id>          # what changed against the live stores
apex adaptation review open <adaptation-id> --reason "text" # open on the evidence now recorded
apex adaptation review keep|dismiss|retire <review-id>    # record the user's own decision
```

### Nine reader states, three decisions

The reader state is **derived on every read**, never stored: stored records are only the review and the
user's decision, because a status field written beside the evidence would be a second, editable copy of
what the log already says.

| Derived state | What the records show |
|---|---|
| `no_review_required` | no recommendation and no open review |
| `review_recommended` | the live report recommends review or consideration of retirement |
| `review_opened` | a current review exists, its evidence still matches, and no decision was recorded |
| `review_awaiting_evidence` | the review was opened before the report could classify an evaluated use of the current version |
| `review_evidence_changed` | the evidence the review cited no longer matches the live stores |
| `review_completed` | the user recorded `keep_active` (or retired the adaptation, which is the retire decision's own effect) |
| `review_dismissed` | the user dismissed the recommendation and left the adaptation unchanged |
| `review_decision_superseded` | a later review of the same adaptation supersedes this one |
| `review_unavailable` | the evidence cannot be read at all, so the state cannot be derived |

The three decisions are `keep_active`, `dismiss` and `retire`. All are user-origin writes; model output
cannot open a review or record a decision, and the store refuses a non-user origin independently of the
registry. A decision is refused if the evidence changed after the review was opened - the user must
reconcile first. `retire` appends the existing `adaptation_retirement` record through the existing
`adaptation.retire` authority and then records the decision citing the pre-retirement evidence digest;
a retired adaptation cannot be used or reviewed again. Decisions are append-only, are never rewritten,
and a completed review keeps its initiator, evidence digest, decision and currentness; a later change
moves the live reader state, not the historical record.

### Reconciliation names differences, not verdicts

The reconciler re-derives the bundle from the live stores and compares it item by item. The change
vocabulary is closed and ordered: `unchanged`, `added`, `stale`, `conflicting`, `withdrawn`,
`superseded`, `missing`, `unreadable`. The distinctions are the message:

- `added` is not an improvement, and `withdrawn`, `superseded` or `missing` are not a failure.
- A rule **version** change is `stale`; a rule **hash** change at the same version is `conflicting`,
  because the recorded rule and its stated version now disagree.
- Conflicting evidence stays conflicting; it is never averaged into a verdict.
- An item whose read was truncated is `unreadable`, never `withdrawn` - evidence that could not be read
  is not evidence of absence.
- A moved report digest alone is not an evidence change.

A changed digest therefore never means better or worse; it means the review must be reconciled before
it can be decided again.

### Bounds and failure behavior

At most 20 adaptation rows per list read (`MAX_GOVERNANCE_ADAPTATIONS`, the same bound as AP-04), at
most 20 evidence references per list, at most 20 reviews read per adaptation history, and at most 40
change entries per reconciliation. A damaged experience or plan store raises `StoreError` rather than
reporting an empty history; a missing plan store yields `review_unavailable` with its reason and a
`null` reconciliation, never an empty bundle that would look like settled evidence. An audit-append
failure after a decision is disclosed, and the decision the store already recorded is not erased.

### Tests and measured cost

`tests/adaptation-governance.test.js` (41 cases in 8 suites, registered in `npm test`) covers the nine
states and three decisions, the evidence bundle and its identity, reconciliation precedence and each
change kind, stale/conflicting/missing/unreadable evidence, model-origin refusal at both the registry
and the store, concurrent open/retire/reconcile, restart persistence, audit-append failure, damaged
and missing stores, and two deterministic end-to-end paths (report → open → inspect → reconcile →
decide → audit → fresh report) - one keeping the rule active and one retiring it.

```bash
node --test tests/adaptation-governance.test.js
APEX_DATA_ISOLATED=1 node benchmarks/run-governance-benchmark.mjs
```

`benchmarks/run-governance-benchmark.mjs` measures the **complete production path** for list, open,
inspect, reconcile and decide at 4 / 12 / 24 linked uses and at 1 / 8 / 20 / 21 stored adaptations,
plus concurrent reads beside writes. On this machine (Node v26.4.0, win32 x64), with medians over five
cycles:

| Complete request | 4 uses | 12 uses | 24 uses |
|---|---|---|---|
| list | 166.3 ms | 474.2 ms | 996.0 ms |
| open | 151.7 ms | 445.1 ms | 640.1 ms |
| inspect | 338.7 ms | 667.0 ms | 1,231.2 ms |
| reconcile | 240.9 ms | 632.5 ms | 1,160.7 ms |
| decide `keep_active` | 163.9 ms | 345.8 ms | 608.5 ms |

The list request took 967.8 / 997.4 / 1,049.9 ms at 1 / 8 / 20 stored adaptations on the same 24-use
history. At 21 stored
adaptations the target falls outside the newest-20 window and is not reported, which the report says;
that row completes faster because it performs far less lineage work, not because execution improved.
The store and builder reads are printed separately and labelled partial. A read issued beside a write
and four reads issued beside each other both verified; the timings are wall-clock observations, not
throughput claims. See
[`benchmarks/README.md`](benchmarks/README.md#adaptation-governance-benchmark-batch-ap-05) for the
tables and their limits; the figures are observations of one machine at one time, not a specification.

### What this does not claim

Opening a review approves nothing, changes no rule, increases no influence, and executes nothing. A
recommendation is never a decision. The read has no write path, and the write actions cannot approve an
adaptation, change guidance, or run a plan - those remain `adaptation.decide`, `adaptation.guide`,
`adaptation.retire` and the existing execution path. Reconciliation reports a difference, not a causal
finding, a quality judgment, or real-world truth. Stages 5 and 6 of the roadmap below remain open on
their wider clauses.

## Batch AP-06: evidence fabric scalability and cross-store integrity (as implemented)

AP-03, AP-04 and AP-05 each built a report that reads several append-only stores one after another:
longitudinal outcomes, adaptation effectiveness, review governance. Each read was internally
consistent, but a record appended between two of them could make the combined report describe a
combination of states that never existed at one instant. AP-06 adds the shared machinery those reports
now use, plus one read-only action. It adds no store, no write path and no new authority:
`src/evidence/snapshot.js` certifies a read window, `src/evidence/integrity.js` names what a read
found in one closed vocabulary, and `evidence.integrity` exposes the cross-store check.

### A certified window is not a transaction

Every evidence store is a JSON Lines file that is only ever appended to, so its byte size and
modification time move on every append and cannot move on a read. The snapshot records each
contributing file's identity - existence, byte size, modification time - before the first store read
and again after the last. If nothing moved, no append happened inside the window, so every read
observed bytes that were already present when it began, and the combination existed at one moment. If
an identity moved, the read is reported as `concurrent_modification`: a statement about the read, not
about the evidence.

- A retry is bounded and visible: at most three attempts (`DEFAULT_SNAPSHOT_ATTEMPTS`,
  `MAX_SNAPSHOT_ATTEMPTS`), only for `concurrent_modification`, never for `unverifiable`, and a store
  read that throws propagates unchanged because a failed read is not a concurrent write.
- The window holds no lock and cannot stop a writer; it proves quiescence, it does not impose it.
- A store that exists but cannot be inspected makes the window `unverifiable`, which refuses
  consistency rather than claiming an empty one.
- A same-size rewrite that also preserves modification time is outside what a `stat` can see. The
  stores' own content validation and hashing remain the authority there; this module does not replace
  them.
- Within one operation each label is read once (`snapshot.read(label, fn)`), so two reports assembled
  in the same window cannot disagree because one of them read the store twice.

### One closed vocabulary for what was found

`INTEGRITY_STATES` is ordered from least to most severe. A report with several findings is described
by its worst one, and an unknown state is a programming error rather than a new word.

| State | What it says | Typical source |
|---|---|---|
| `valid` | the records read support the answer, with nothing disclosed | all checks pass |
| `valid_bounded` | evidence, with a limit the report states | a bounded list, a reference outside the window, a bounded health history |
| `missing` | a record the answer expected is not stored | no configured store; absent requested record |
| `stale` | a recorded version no longer describes the record | a rule version behind the live rule |
| `conflicting` | two records disagree, or one identity appears twice | duplicate ids; a hash that moved at the same version |
| `broken_reference` | an answer cites an id that is not there | a plan id with no plan |
| `damaged_store` | lines that could not be parsed were found | a truncated or corrupt JSONL tail |
| `truncated_history` | a store's own history is bounded | a health check that reports truncation |
| `concurrent_modification` | a contributing file moved during the read | a write landing inside the window |
| `unverifiable` | a store could not be inspected, so neither consistency nor content can be claimed | an unreadable path; a failed health check |

The distinctions are deliberate: a missing record is a gap, `valid_bounded` is still evidence,
`out_of_window` and `unread` are limits rather than negative facts, and a bounded read is never
`truncated_history` because nothing was lost. Findings are disclosed up to `MAX_INTEGRITY_FINDINGS`
(50) with untrimmed counts beside them; the digest covers the state, the untrimmed counts and the
disclosed findings. Every report carries `authorizes: false`. Nothing in this module repairs,
back-fills or deletes a record: a finding is a statement about the records as they read, and rewriting
them to make the finding disappear would destroy the evidence it describes.

### The `evidence.integrity` read

`evidence.integrity` opens one window over every evidence store this build has configured (at most
`MAX_SNAPSHOT_STORES` = 32), runs each store's own health check where one exists, and records the
others by identity alone - the absence of a health check is not evidence of damage. Health summaries
do not agree on field names, so `corruptLines` and `corrupt` are both normalised to a count, and the
knowledge store's `claims` plus `lifecycleEvents` are both counted as records. A report is
`available` only when the window is consistent and no health check was `unverifiable`; damage stays
available because it is a finding about records that were actually read. The action is a read: its
verification opens a second window and compares `available`, then the digest, and explains a
difference instead of averaging it away. Nothing is repaired, rewritten or authorized.

### Which consumers read through a window

| Consumer | Window covers | On a write inside the window |
|---|---|---|
| `adaptation.effectiveness` | experience, plans, operations, goals, knowledge, memory | refused: `available:false`, `state`, `attempts`, no rows and `totals:null` |
| `adaptation.reviews` (list) | the same stores plus predictions | refused the same way; a refused report states no rows rather than a partial answer |
| `adaptation.review.open`, `.inspect`, `.reconcile`, `.decide` | the evidence each stage re-derives | `StoreError`; no bundle or decision is recorded from a combination that never coexisted |
| `evidence.integrity` | every configured evidence store | refused with `state` and `attempts`; no partial rows |
| cognitive retrieval, world state, prediction projection, plan candidate evaluation | their own per-store reads (unchanged by AP-06) | each source already reports `unavailable` or `damaged`; none of them claims cross-store consistency |

The last row is the honest boundary: AP-06 certifies the reports that assemble a cross-store answer
and leaves the request path's per-store reads as they were, because those readers already disclose an
unavailable or damaged source per source and refusing a user's question over a background append
would be worse than the disclosure. The window wraps the same store methods those readers use; there
is no second evidence store, index or cache, and nothing is persisted between operations.

### Bounded reads now say when they clipped the adaptation window

Designing the benchmark exposed one real defect: `adaptation.effectiveness` asked the experience
store for exactly 20 adaptations, so a store holding 21 or more was silently clipped and the report
looked exactly like one that held 20. The read now asks for one row past the window and reports
`integrity.truncated: true` with `truncatedSources: ['adaptations']` when the extra row exists; the
state becomes `valid_bounded` and the totals still say 20 read. A window that holds every stored rule
stays `valid` with `truncated: false`. `tests/evidence-fabric.test.js` pins both sides.

### Cross-process, interruption and concurrency

Real child processes write into the same directory while a parent reads. A child that stops mid-line
leaves a truncated tail that is reported as `damaged_store`, never replayed, repaired or counted as
a record. A write landing inside every governance attempt is refused explicitly after
`MAX_SNAPSHOT_ATTEMPTS` with `reason` matching "did not exist at one instant", `adaptations: []` and
`totals: null`; when the writer stops inside the budget the same read is certified and the attempt
count is reported. Two writes in successive attempts retire at most two windows, which is why three
attempts are sufficient and the budget never grows with the store. Four `evidence.integrity` reads
issued at once each verify, because each action's audit line lands after its own second window.

### What a window costs

`benchmarks/run-evidence-benchmark.mjs` measures the complete production paths at 100 / 1,000 / 4,000
synthetic memory records over nine stores (146 / 1,046 / 4,046 records). On this machine (Node
v26.4.0, win32 x64), medians of five repeats, one benchmark at a time:

| Complete request | 100 records | 1,000 records | 4,000 records |
|---|---|---|---|
| `evidence.integrity` | 20.9 ms | 23.6 ms | 33.5 ms |
| `adaptation.effectiveness` | 31.5 ms | 39.4 ms | 57.5 ms |
| `adaptation.reviews` | 34.9 ms | 41.0 ms | 56.9 ms |
| cognitive retrieval (partial; measured directly) | 13.0 ms | 21.3 ms | 58.1 ms |

Re-running the same effectiveness read on identical bytes with and without a window moved it by
-0.1 / +0.6 / +1.0 ms: the window is one `stat` pair per store, not per record, so growth appears in
parsing and retrieval, not in certification. At 20 stored adaptations the complete read took 33.2 ms
and reported `valid`; at 21 it took 32.7 ms and reported `valid_bounded` with the truncated source
named. A complete read issued beside concurrent writes refused truthfully while both writes verified.
No cache or index was added: the measurements put the growth in store parsing and lineage, and the
window itself is cheaper than the noise on the smallest fixture. The figures are wall-clock
observations of one machine at one time, not a specification. See
[`benchmarks/README.md`](benchmarks/README.md#evidence-fabric-benchmark-batch-ap-06).

### Tests

`tests/evidence-fabric.test.js` (51 cases in 7 suites, registered in `npm test`) covers the window
states and their boundaries, bounded retry, the closed vocabulary and severity order, reference
mapping, duplicate identities, the cross-store report, the action and its second-window verification,
governance and effectiveness reading through one window, the adaptation-window truncation disclosure,
real child writers and truncation, and concurrent mixed reads.

```bash
node --test tests/evidence-fabric.test.js
APEX_DATA_ISOLATED=1 node benchmarks/run-evidence-benchmark.mjs
```

### What this does not claim

A consistent window is not a distributed transaction: APEX still has no cross-store commit, no
two-phase protocol and no lock around a multi-store read. A valid digest proves the bytes read are the
bytes described, never that the records are true, permitted or complete. `evidence.integrity`
authorizes nothing, and `authorizes: false` is present on every report it produces. The request
path's cognitive retrieval, world state and prediction projection remain per-store atomic as
described above; AP-06 did not make them window-certified, and none of them claims otherwise. The
`stat`-based window cannot detect a same-size, same-mtime rewrite, and a store whose health check is
missing is described by identity only. The benchmark is deterministic and model-free, and says
nothing about inference latency.

## Roadmap toward persistent cognition (dependency-ordered)


This is a plan, not a status report. **No stage below is closed.** Five of the eight hold
a partial implementation and the notes name both the clause each batch advanced and the
remainder that keeps the stage open: stage 2's read-only projection, stage 3's
event-with-time clause for the experience log (Batches AC and AD), stage 4's
contradiction-surfacing clause (Batch X), stage 5's feedback-to-surface path (Batches Z,
AA and AB), and stage 6's expectation ledger, outcome capture and classification (Batch
AE). Each stage names the dependency it satisfies and the evidence that would demonstrate
completion, so a later batch cannot claim progress by adding vocabulary.

1. **Foundational infrastructure (done, keep).** Append-only stores, provenance,
   authorization, independent verification, audit, recovery, health inspection.
   *Dependency for everything else.* Acceptance: the existing suites stay green; no later
   stage may weaken them.
2. **Persistent cognitive state (partly done).** Memory, knowledge, task state, and
   conversation are durable and separately owned; the read-only projection derived from
   them is implemented. Batch U made one unchanged repeat read cheap with a bounded
   per-process derived parse snapshot, and proved that no read mutates any store. Batch V
   made an ordinary write cheap in the same way - a hash-proven, incrementally maintained
   validated record state, in memory and per instance - but it changed the write path only.
   Neither batch closed this stage: cold reads and the read after a write still parse and
   validate the whole store, and every write still reads and hashes it, so the projection's
   cost still grows with total records. Acceptance for closing the stage remains a projection
   whose cost does not grow linearly with total records. Batch V re-examined the obvious means
   - a persisted, incrementally maintained index owned by the store that produced it - and
   rejected it on measurement, because reading the store through such an index still requires
   reading and hashing every byte of it; the two changes that could actually move the ceiling
   are named in
   [V-07: the read path after the write changes](#v-07-the-read-path-after-the-write-changes).
   Either is a storage-behaviour change with its own tests, deliberately not attempted as part
   of a read or write optimization.
3. **Structured entity, event, and world state.** Entities with identity beyond an exact
   triple, events with time and participants, and state that changes over time. Depends on
   2 because a schema needs an owner and a migration story. Acceptance: records that
   answer "what was true on <date>, and which record says so", with old values preserved
   and labelled as history, plus retrieval that distinguishes current from expired.
   Batch AC advanced the event-with-time clause for audited operations only: the experience
   log can now be asked what happened between two instants, in what order, and with which
   recorded outcome, and corrections stay labelled as history. Batch AD hardened that same
   view without extending it - adversarial histories, evidence lineage, query correctness
   under concurrent writers, and truthfulness of what the temporal summary claims. Entities,
   participants, arbitrary event kinds, and a schema owned by anything other than the
   experience log are still not implemented; the temporal view is a derivation, not a new
   store.
4. **Retrieval, evidence, uncertainty, and contradiction handling.** Evidence-linked belief
   records with explicit confidence, provenance-aware retrieval, and contradiction handling
   that is not a text heuristic. Depends on 3 (a claim must name what it is about).
   Acceptance: a stored belief can be traced to the records supporting and contradicting
   it, an inference stays labelled as an inference through retrieval, and a conflicting
   record is surfaced rather than silently preferred. Batch X advanced the third clause of
   that acceptance and only that clause: a conflict retrieval never showed - because the
   counterpart was ranked out, withheld as private, or outside the prompt cap - is now
   surfaced to the model as a bounded, counts-only view of the whole store, alongside the
   explicit unknowns and the completeness of the read. Batch AE did not add the confidence
   clause either: every prediction record carries `confidence: null` by design, because no
   defensible method for supplying one exists in this build. Entity-linked evidence traces,
   and non-heuristic contradiction detection still depend on stage 3 and are not implemented.
5. **Learning and adaptation.** Updates driven by user feedback and verified outcomes,
   under the existing trust boundary: model output cannot authorize a write, and no
   inference is promoted to a fact without evidence. Depends on 4. Acceptance: a bounded
   feedback record changes what APEX surfaces, does not change what it claims is verified,
   survives a restart, and is reversible and auditable.
   Batch Z advanced the feedback half of that acceptance: a user-recorded feedback comment
   can become an adaptation candidate, only the user's recorded decision approves it, an
   approved rule changes what enters a model-shaped prompt (labelled there as neither an
   instruction nor authorization), every read recomputes the lifecycle so a corrected
   experience cannot leave a stale rule in effect, and a retirement is itself a record. Batch
   AA added one bounded automatic path for the *experience* record only, behind one validated
   setting that defaults to off. Batch AB made the ending of every operation - audit record,
   experience capture, completion - one testable contract instead of four lookalike tails. Batch
   AL put a recorded outcome in front of the next selection, and Batch AM widened what that means:
   a plans own recorded outcomes and whether each steps own action can re-check it are two of the
   ranked dimensions of the next comparison (`plan-dimensions.test.js`), and an approved adaptation
   with a recorded shape can order the candidates that same goal is offered - while a gate, a
   recorded constraint, an approval and an authorization decision stay outside its reach
   (`plan-guidance.test.js`, `tests/plan-scenarios-am.test.js` scenarios 8, 11 and 12). So an
   outcome does change what APEX surfaces next, and still changes nothing it claims is verified:
   no shape, verdict or feedback record can approve, start, carry or supersede a plan, and the
   adversarial pass pinned that from the bytes a stored imperative cannot change
   (`tests/adversarial-batch-am.test.js` I-01 to I-05, I-08, I-14). Retirement, reversal and audit
   are the same records as before. The stage stays open because a surfaced difference is still not
   a learned change of *behaviour* in the sense the acceptance line means: no dimension weight is
   fitted, no ranking is recomputed from results, and the two dimensions Batch AM added are
   disclosures the user reads, not signals a component optimises against. See stage 6.
   Batch AP did not change that assessment. It made the one influence Batch AM had already built legible as
   a decision: the same comparison now reports the order the work alone produced, the order the approved
   record produced, the rule id/version/hash and evidence behind it, every record considered with its state,
   and `authorizes: false` (`adaptation-decision.test.js`). That is disclosure of an existing bounded
   influence, not a new learned change of behaviour: no weight is fitted, no ranking is recomputed from
   results, and a prediction verdict still reaches no decision without a user-approved candidate derived
   from it (Batch AP-02, below). Batch AP-04 made the outcomes of those decisions traceable and Batch AP-05
   gave the result a user-controlled review lifecycle; neither changes behaviour by itself. A review records
   a question and a user's decision about an existing rule, and approves, orders and executes nothing.
6. **Executive control and outcome evaluation.** Expectations recorded before an action,
   outcomes compared against them, and the controller using that difference to decide the
   next step. Depends on 1 and 5. Acceptance: an operation records an expectation, an
   outcome, and a classification of the difference, and a wrong expectation changes
   subsequent behaviour without granting any component new authority.
   Batch AE implemented the first three clauses of that acceptance, and did not implement the
   fourth. An expectation is now a durable record naming a capability and a horizon, made
   before its outcome is established and kept separate from the events that establish it; the
   outcome is the recorded experience inside that horizon; the classification is a stored
   verdict of `matched` or `contradicted`, or a named decision recording that no verdict was
   written - the outcome is unavailable, the evidence establishes nothing, the horizon has
   expired, the expectation was withdrawn or superseded, an evaluation already exists, or the
   experience log could not be read. **What is not implemented: a wrong expectation changes
   no subsequent behaviour.** No planner, controller, gateway, adapter, or adaptation read
   consumes a verdict, and no component gained authority from this batch - the ledger is read
   only to answer a prediction-shaped question, to fill a bounded, separately labelled context
   section, and to fill the `Expectations` section of the read-only world projection. Two
   further honest deviations from this stage's wording: the expectation is not bound to one
   operation (it describes a capability over a horizon, and its provenance names the operation
   that recorded it), and an outcome is never classified automatically - the user runs
   `prediction evaluate`, which judges against records that already exist and writes nothing
   when the evidence does not establish anything.
   Batch AG advanced the *executive* half of this stage's title and none of its expectation
   clause: a goal and an executive plan are durable records, an approved plan is re-validated
   against the live registry and run as an ordinary task, and terminal task outcomes are
   recorded against the plan. The loop is `Goal → Context → Plan → Validation → Authorization
   → Execution → Verification → Outcome → Learning`, but the last arrow is still only the
   existing capture path - no unapproved prediction verdict and no plan outcome changes a
   later plan, a plan is never inferred from a goal, and a completed plan completes no goal.
   Batch AP-02 added one bounded exception: a user-approved candidate derived from a completed
   evaluation can re-order approaches in a comparison; it still changes no plan, goal or task.
   Batch AK added the front of that loop rather than its learning clause: a user's own sentence
   is mapped onto registered actions, previewed, approved against a content hash, run through
   the existing `TaskRunner`, and reported from its records - the
   `Context → Plan → Validation → Authorization → Execution → Verification → Outcome` span.
   The stage stays open for exactly the reasons the previous paragraph names: no prediction
   verdict is consumed by anything, a plan is still never inferred from a stored goal record,
   and completing a plan completes no goal without the user's own evidence-backed act.
   Batch AM advanced three more clauses of this stage's title and none of its expectation clause.
   The loop now runs past *execution* in both directions: a run a process left partway is read as
   nine states from its own records (`plan.continuation`), and only the steps those records prove
   never started may be taken up (`plan.continue`), while a write whose effect cannot be established
   is refused and named (`tests/plan-continuation.test.js`, `tests/adversarial-batch-am.test.js`
   I-09 to I-16). What the next comparison is allowed to consider is now decided by recorded
   constraints rather than by prose (`plan-constraints.test.js`), and the answer the user gets about
   *what is next* distinguishes a plan ready to run from a run ready to be taken up again
   (`executive-readiness.test.js`). A recorded outcome still changes no expectation, a raw prediction
   verdict is still read by no planner, controller or gateway, and the two ranked dimensions Batch AL
   and AM put on the comparison remain disclosures the user reads: no weight is fitted and no
   ranking is recomputed from results. The stage remains open on the same fourth clause.
   Batch AP implements one reading of that clause and not the clause itself. A recorded, eligible,
   user-approved adaptation now changes exactly one later decision - which candidate leads a comparison of
   approaches that already passed every gate - and the answer states the decision it would have taken
   without it, reversibly and with an audit trail (`adaptation-decision.test.js`). Batch AP-02 extends the
   same reading to a completed evaluation of an expectation, still only after the user approves the
   derived candidate; a wrong expectation alone changes nothing, and no unapproved verdict is read by any
   planner, controller or gateway. What keeps this stage open is unchanged: the signal is a user-approved
   adaptation, not the expectation verdict itself; no component gained authority; and the wider
   "wrong expectation changes subsequent behaviour" clause is not implemented.
7. **Neural-runtime integration.** Only through the contract described in
   [Neural integration boundary](#neural-integration-boundary-proposal-not-implemented):
   proposals in, authority out. Depends on 6, because a proposer needs an evaluation
   channel to be measured at all. Acceptance: a real runtime answers a real request through
   the boundary, is classified as a proposer in the audit record, and cannot write to any
   store.
8. **Resource-aware local operation.** Latency and memory budgets that adapt to this
   machine rather than assuming a server. Depends on 2 (indexed reads) and on measurements
   like the benchmark above. Acceptance: documented, repeated local measurements and a
   degradation path that states what was skipped instead of silently timing out.

Decisions deliberately left reversible: the projection stays a read-time derivation, so a
later indexed store can replace it without touching memory or knowledge schemas; memory
contradiction reporting stays heuristic and labelled, so a real entity model can supersede
it; `world.state` stays user-origin-only, so a future model-facing view can be introduced
as a separate, content-free action rather than by widening this one. Batch X took the second
option in the form this note reserved: the model-facing view is a system-generated,
counts-only section built inside prompt assembly for the request at hand, not a new action the
model can call, and `world.state` was not widened.

## Future learning interface (not implemented)

Operation records carry the request, the selected capability, the authorization
decision, execution and verification outcomes, and the retrieval references. That is
the outcome data a later learning component would consume. Storing logs is still not
learning: no weight is fitted, no ranking is recomputed from results, and no general
learning loop exists. The one bounded exception is the approved-adaptation path: a rule
the user derived from their own corrections, approved, and shaped can move which
candidate leads a comparison of approaches that already passed every gate, and since
Batch AP that influence is stated before and after and reversible (see
[Batch AP](#batch-ap-one-disclosed-reversible-decision-from-recorded-evidence-as-implemented)).
Batch AP-02 extends that exception to a completed evaluation of an expectation, but only through a
user-approved candidate derived from it. It changes nothing else, and an unapproved prediction verdict
still drives no decision.

## Neural integration boundary (proposal, not implemented)

`stark/` is a C++17/CMake research tree of simulation binaries and tests. It has no
long-running service, no stable wire format, and its demos write human-readable text to
stdout. Nothing in `apex_app` imports it, and this proposal does not add a sidecar, a
process, or a dependency. It defines the smallest interface APEX would implement if a
standalone neural runtime existed, so that the runtime can propose without ever gaining
authority. No part of it is built or tested against a trained model.

**Review basis.** APEX already has the boundary it needs on the model side
(`src/model/gateway.js`): a backend returns text or a classified failure, the controller
wraps the result in its own provenance, and proposals are checked by the planner and
registry before anything runs. The neural interface below is the same shape with one
difference: it accepts only structured proposals, never free-form actions, and it is
expected to be absent.

### 1. Request and response schema

Transport is one JSON object per line. APEX sends:

```
{"schema":"apex.neural.request/1","requestId":"<uuid>","kind":"propose",
 "input":{"text":"<user text or bounded task goal>"},
 "limits":{"maxProposals":8,"maxPlanSteps":8,"maxOutputChars":8000},
 "deadlineMs":5000}
```

The runtime replies once:

```
{"schema":"apex.neural.response/1","requestId":"<same uuid>",
 "status":"ok"|"unavailable"|"error",
 "proposals":[{"kind":"knowledge_claim"|"memory_claim"|"plan",
   "confidence":0.0,"payload":{...}}],
 "runtime":{"name":"stark-...", "version":"x.y.z", "modelId":"..."},
 "error":{"code":"...","message":"..."}}
```

`knowledge_claim.payload` is `{subject, relationship, object, evidence?}`.
`memory_claim.payload` is `{content}` (never `private`). `plan.payload` is
`{steps:[{id,description,action,input,depends_on}]}`, exactly the shape
`parseModelPlan()` already validates. Unknown top-level fields are rejected; unknown
proposal kinds are ignored and counted, never guessed into an action. `confidence` is
advisory data and has no authorization meaning.

### 2. Protocol and process boundary

Either a spawned child process speaking newline-delimited JSON on stdin/stdout, or a
loopback HTTP endpoint with the same bodies. APEX owns the lifecycle: one request at a
time, no inherited stdin, a clean environment with no secrets, and no access to the
APEX data directory by contract. A child is killed on deadline or cancellation; an HTTP
connection is aborted. The runtime cannot call back into APEX, open stores, or invoke
actions; its only output is the response line. stderr is captured as bounded,
secret-redacted diagnostic text.

### 3. Version compatibility

APEX sends `apex.neural.request/1`. A runtime that answers with another
`schema` value is refused as `UNSUPPORTED_VERSION`; it is never parsed leniently.
Additive optional fields are allowed within the same major version. A response missing a
required field, carrying a different `requestId`, or containing more proposals than the
request limit is `MALFORMED_RESPONSE`. The runtime version is recorded with each
proposal so later changes can be attributed.

### 4. Message size limits

The request body is capped at 64 KiB and response at 1 MiB, matching the gateway's
existing `MAX_RESPONSE_CHARS` bound. At most 8 proposals and 8 plan steps are accepted
(the planner's `MAX_STEPS`), proposal text is bounded, and a larger response is
`RESPONSE_TOO_LARGE`, not truncated into something that might parse differently.
Reading stops at the cap, so an unbounded stream cannot exhaust memory.

### 5. Timeouts and cancellation

Each request carries a deadline (default 5,000 ms, hard maximum 30,000 ms). Exceeding it
is `TIMEOUT`; killing the child is not proof that it produced no side effect outside
APEX, so a request is never replayed automatically. Cancellation closes the input and
terminates the process (or aborts the HTTP request); an interrupted request is
`INTERRUPTED`, and only a request that produced no completed response may be retried by
the caller. APEX never retries an ambiguous response, matching the gateway's rule that
only failures with no answer are retryable.

### 6. Resource limits

One in-flight request, bounded input and output, and a deadline cover the interface
itself. On platforms that support it the child is placed in a job object or rlimit with
a memory and CPU cap; without one, the deadline and output cap are the enforced limits
and diagnostics say so. APEX does not trust runtime-reported usage figures for policy;
they are recorded as claims, not measurements.

### 7. Error and unavailable-runtime behavior

`unavailable` and transport failures map to the existing gateway outcomes
(`UNREACHABLE`, `TIMEOUT`, `INTERRUPTED`, `MALFORMED_RESPONSE`, `EMPTY_RESPONSE`,
`RESPONSE_TOO_LARGE`, `UNSUPPORTED_VERSION`). A failure is reported as a failure, never
as an empty successful answer, and never as a reason to execute anything. With no
runtime configured, the path behaves exactly as it does today: the model is unavailable
and the request is answered honestly or refused.

### 8. Provenance and trust classification

A neural result is `model_proposed` at most. APEX derives the provenance itself
(`origin: "model_output"`, `backend: "neural-runtime"`, runtime name and version), and a
runtime cannot supply `user_supplied` or `user_confirmed`; such a field is ignored or
rejects the response. Model-proposed knowledge and memory writes remain refused, as they
are today; a proposal only becomes stored information after an explicit user-origin
command. Plan proposals enter `checkSteps()` with the `model` origin, so write steps wait
for approval and user-only actions are refused.

### 9. Logging and diagnostic behavior

The operation record stores the request id, kind, sizes, latency, runtime version,
outcome code, and proposal counts - not the raw prompt or response. Stderr is bounded and
redacted with the same secret rules as other diagnostic text. `status` and `diagnose`
report the runtime as not configured, unavailable, listed/version-visible, or
inference-tested; a process that merely responds is reported as reachable, never as
healthy, and no diagnostic check starts or mutates the runtime.

### 10. Proposing without authorizing

There are exactly three accepted proposal kinds, and each lands on an existing,
unchanged gate: `knowledge_claim` and `memory_claim` are shown to the user and can only
be stored by a user-origin command; `plan` is stored as an unapproved proposal and runs
only through the existing approve-then-execute path. The runtime cannot approve, retry,
cancel, write a store, change policy, or select an unlisted action. Its output is data in
the same trust class as model text today.

### 11. Testing without a trained neural model

A protocol conformance stub (a small executable or Node script that speaks the frames
above) exercises the interface: valid proposal, version mismatch, missing and extra
fields, oversized request and response, wrong `requestId`, malformed JSON, empty body,
timeout, cancellation, duplicate response, `unavailable`, and a proposal that the
registry or planner must refuse. End-to-end tests then prove the gates: a proposed
knowledge write is denied, a proposed plan needs approval, and a failed runtime changes
nothing. This requires no training and does not run any `stark/` binary.


This is a bounded implementation under the Local Alpha mission. It does not declare
M0 accepted, change G7, M0, or M1 gate states, or claim M1 is unlocked. It is not
full APEX completion and is not published or merged. The status documents elsewhere
in the repository (for example `docs/IMPLEMENTATION_STATUS.md`) were not changed.
