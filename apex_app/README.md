# APEX Local Alpha

APEX (Adaptive Personal Executive eXocortex) is the whole personal cognitive system.
**Local Alpha** is the first runnable vertical slice of it. It is a small, honest
implementation of one workflow:

    request -> an allowed deterministic action, or: retrieve memory and knowledge
            -> a model -> authorize -> execute -> verify independently
            -> record -> restart -> still there

It is not the whole of APEX. It has no world model (it has a read-only
[projection](#world-state-the-read-only-epistemic-projection) of what memory and knowledge
already store), no general-purpose planner (only
the bounded task planner described below), no persistent learning, no voice and no UI,
and its model path depends entirely on a backend you configure yourself. The C++
spiking-neuron research under `stark/` is a separate experiment, not a runtime this
application uses.

The application is in `apex_app/`, separate from the experimental C++ neural
research under `stark/`. Nothing here depends on that research. Historical STARK
identifiers are preserved there and are not used by this application.

## Capability status

This section states what is implemented, by which evidence, and what is not. It is
deliberately narrower than the APEX vision. Every claim below is supported by the
source in `apex_app/` and the tests named in [Tests](#tests); nothing here is inferred
from a milestone number or a passing build.

| Category | Status | Evidence |
|---|---|---|
| Runnable application | Implemented: the CLI in `bin/apex.js` / `src/cli.js`, the controller pipeline, memory, knowledge, audit, tasks, diagnostics. | `npm test` and the walkthrough in the [Commands](#commands) table. |
| Deterministic capabilities (no model) | Implemented and independently verified: `remember`, `recall`, `list memory`, `memory correct`, `memory health`, `calc`, `status`, `knowledge add/retract/resolve/history/health/list/search/show`, `audit health`, `task plan/run/resume/approve/retry/cancel`, `queue`, `repair locks`, `diagnose`. | `actions.test.js`, `memory.test.js`, `knowledge.test.js`, `knowledge-lifecycle.test.js`, `knowledge-health.test.js`, `knowledge-resolution.test.js`, `store-health.test.js`, `tasks.test.js`, `cli-workflow.test.js`. A model is never consulted for these. |
| Filesystem inspection | Implemented only when `APEX_FILESYSTEM_ROOT` is set: bounded, read-only, single-root listing and reading. | `filesystem.test.js`, `tasks-filesystem.test.js`. |
| Model gateway protocol handling | Implemented and **stub-tested**: request/response shapes, failure classification, retries, timeouts, and model-name mismatch against local stand-in servers that copy the documented OpenAI-compatible and Ollama shapes. | `gateway.test.js`, `model-workflow.test.js`. Stub tests prove protocol handling, not answer quality, and no test in `npm test` runs a real model. |
| Real-model behaviour | **Observed outside the automated suite**: Qwen3-4B GGUF served by Ollama 0.35.0 on one Windows machine. One bounded request on 2026-10-31 completed through APEX in about 105 s; a bounded four-request benchmark the same day recorded 37.7-53.1 s per request, with 3.0-3.8 backend-reported tokens/s. Every answer was reported as unverified. Measurements and limits are in [Optional: a model endpoint you configure](#optional-a-model-endpoint-you-configure). | A dated historical observation, not an active setup instruction; no automated regression test. |
| Epistemic world-state projection | Implemented as a bounded, read-only projection of what the stores hold: beliefs classified by provenance (`user_asserted` vs `unverified_model`), knowledge conflicts and recorded user decisions, heuristic memory disagreements, missing evidence, and explicit unknowns. It is a view derived at read time, not a world model: it persists nothing, calls no model, and decides nothing. A model-path answer also receives a bounded, counts-only view of it, so the model is told what the stores hold beyond the records retrieval happened to show. | `world-state.test.js`, `world-context.test.js`, `src/world/world-state.js`, the `world` command, and [World state](#world-state-the-read-only-epistemic-projection). Measured read cost is in [Benchmarks](#benchmarks). |
| `stark/` research tree | Experimental C++17 neural research, built and tested separately from this app. Not a runtime dependency and not imported by `apex_app`. | The root `README.md` describes its build and historical gate state. |
| Neural integration | **Proposed, not implemented.** Only the boundary document at the end of this README exists; no sidecar, process, wire format, or dependency is added. | Nothing to run. The proposal states what would have to be built. |
| World model, general planner, persistent learning, voice, UI | **Not implemented.** A world model would hold entities, events, time, and causal state of its own; the projection above only re-reads memory and knowledge and reports what they already contain. The task planner is bounded and explicit; operation logs are not learning. | The scope paragraphs in this README, [World state](#world-state-the-read-only-epistemic-projection), and [Future learning interface](#future-learning-interface-not-implemented). |

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

### Configuration and preflight

Configuration comes only from environment variables; there is no config file.
Invalid or out-of-range values are rejected before any store is opened: the command
exits 2, names the setting, and reports that no data was read or changed.

| Variable | Accepted values | Default |
|---|---|---|
| `APEX_DATA_DIR` | any directory path | `~/.apex/local-alpha` |
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
src/actions/
  registry.js         action registry and the authorization policy
  origins.js          request origins: user | model
  executor.js         input validation + action body; reports what happened only
  calc.js             arithmetic: recursive-descent executor, shunting-yard verifier
  builtin.js          the built-in actions (input schema, permission, verify)
  world-actions.js    the user-only `world.state` read: projection, audit-minimal result, independent re-read verify
src/verify/
  verifier.js         separate verifier: decides whether a postcondition holds
src/memory/
  jsonl-store.js      append-only JSON Lines with fsync and damage tolerance, plus an optional per-process derived parse snapshot
  memory-store.js     personal memory: validation, provenance, content hash, retrieval, one-read `projectionRead`
  conversation-store.js  conversation turns with origin; credential-like text is never stored
src/knowledge/
  knowledge-store.js  triples, validation, conflict detection, lifecycle events (retraction, resolution), store-wide health, one-read `projectionRead`
src/world/
  world-state.js      read-only epistemic projection of what memory and knowledge already hold; owns no state, writes nothing, one authoritative read per store; `worldPromptLines` renders the counts-only view a model prompt may carry
src/filesystem/
  path.js             absolute path validation: no traversal, no drive root, no UNC
  actions.js          bounded, read-only listing and reading
src/session.js        conversation session id (persists until `new`)
src/security/
  secrets.js          credential-like text detection and redaction (no dependencies)
src/operations/
  operation-log.js    audit records
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
  payloads and credential-like requests are not stored, and a credential-like substring in a
  model answer is replaced with `[redacted-secret]` before the record is written; that record
  is marked `outputMinimized: true` so the stored text is not mistaken for verbatim evidence.
  Detection is heuristic, so a differently formatted secret can still be stored. The audit
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

- It is **not a world model.** There are no entities, events, time intervals, or causal
  links of its own; it re-reads records that already exist.
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
ordinary ones. No predictive stage was added.

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
patterns into a candidate belief about the user or the world. There is no **prediction** stage
either: APEX does not estimate a future outcome, and no record of a predicted outcome exists. If a
future batch added one, it would have to be a separate record carrying prediction time, the expected
outcome, its support, its uncertainty and, later, the actual result - and it could never be stored as,
or later read back as, a historical observation. A prediction is not implemented, and a pattern is
never presented as one.

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

## Roadmap toward persistent cognition (dependency-ordered)


This is a plan, not a status report. Nothing below is implemented except stage 2's
projection. Each stage names the dependency it satisfies and the evidence that would
demonstrate completion, so a later batch cannot claim progress by adding vocabulary.

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
   recorded outcome, and corrections stay labelled as history. Entities, participants,
   arbitrary event kinds, and a schema owned by anything other than the experience log are
   still not implemented; the temporal view is a derivation, not a new store.
4. **Retrieval, evidence, uncertainty, and contradiction handling.** Evidence-linked belief
   records with explicit confidence, provenance-aware retrieval, and contradiction handling
   that is not a text heuristic. Depends on 3 (a claim must name what it is about).
   Acceptance: a stored belief can be traced to the records supporting and contradicting
   it, an inference stays labelled as an inference through retrieval, and a conflicting
   record is surfaced rather than silently preferred. Batch X advanced the third clause of
   that acceptance and only that clause: a conflict retrieval never showed - because the
   counterpart was ranked out, withheld as private, or outside the prompt cap - is now
   surfaced to the model as a bounded, counts-only view of the whole store, alongside the
   explicit unknowns and the completeness of the read. Confidence values, entity-linked
   evidence traces, and non-heuristic contradiction detection still depend on stage 3 and
   are not implemented.
5. **Learning and adaptation.** Updates driven by user feedback and verified outcomes,
   under the existing trust boundary: model output cannot authorize a write, and no
   inference is promoted to a fact without evidence. Depends on 4. Acceptance: a bounded
   feedback record changes what APEX surfaces, does not change what it claims is verified,
   survives a restart, and is reversible and auditable.
6. **Executive control and outcome evaluation.** Expectations recorded before an action,
   outcomes compared against them, and the controller using that difference to decide the
   next step. Depends on 1 and 5. Acceptance: an operation records an expectation, an
   outcome, and a classification of the difference, and a wrong expectation changes
   subsequent behaviour without granting any component new authority.
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
the outcome data a later learning component would consume. **This milestone does
not learn.** Storing logs is not learning, and nothing here adjusts behaviour from
past outcomes.

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
