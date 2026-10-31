# APEX Local Alpha

APEX (Adaptive Personal Executive eXocortex) is the whole personal cognitive system.
**Local Alpha** is the first runnable vertical slice of it. It is a small, honest
implementation of one workflow:

    request -> an allowed deterministic action, or: retrieve memory and knowledge
            -> a model -> authorize -> execute -> verify independently
            -> record -> restart -> still there

It is not the whole of APEX. It has no world model, no general-purpose planner (only
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
| Deterministic capabilities (no model) | Implemented and independently verified: `remember`, `recall`, `list memory`, `memory correct`, `calc`, `status`, `knowledge add/list/search/show`, `task plan/run/resume/approve/retry/cancel`, `queue`, `repair locks`, `diagnose`. | `actions.test.js`, `memory.test.js`, `knowledge.test.js`, `tasks.test.js`, `cli-workflow.test.js`. A model is never consulted for these. |
| Filesystem inspection | Implemented only when `APEX_FILESYSTEM_ROOT` is set: bounded, read-only, single-root listing and reading. | `filesystem.test.js`, `tasks-filesystem.test.js`. |
| Model gateway protocol handling | Implemented and **stub-tested**: request/response shapes, failure classification, retries, timeouts, and model-name mismatch against local stand-in servers that copy the documented OpenAI-compatible and Ollama shapes. | `gateway.test.js`, `model-workflow.test.js`. Stub tests prove protocol handling, not answer quality, and no test in `npm test` runs a real model. |
| Real-model behaviour | **Observed outside the automated suite**: Qwen3-4B GGUF served by Ollama 0.35.0 on one Windows machine. One bounded request on 2026-10-31 completed through APEX in about 105 s; a bounded four-request benchmark the same day recorded 37.7-53.1 s per request, with 3.0-3.8 backend-reported tokens/s. Every answer was reported as unverified. Measurements and limits are in [Optional: a local model](#optional-a-local-model). | Manual, dated observations only; no automated regression test. |
| `stark/` research tree | Experimental C++17 neural research, built and tested separately from this app. Not a runtime dependency and not imported by `apex_app`. | The root `README.md` describes its build and historical gate state. |
| Neural integration | **Proposed, not implemented.** Only the boundary document at the end of this README exists; no sidecar, process, wire format, or dependency is added. | Nothing to run. The proposal states what would have to be built. |
| World model, general planner, persistent learning, voice, UI | **Not implemented.** The task planner is bounded and explicit; operation logs are not learning. | The scope paragraphs in this README and [Future learning interface](#future-learning-interface-not-implemented). |

The model path depends entirely on a backend you configure yourself. Without one,
APEX answers deterministic requests and reports `model_unavailable` for everything
else; it never fabricates an answer.

### Controlled real-model smoke test

This was run once, on 2026-10-31, against Qwen3-4B GGUF on a local Ollama server:
one bounded `ask` completed in about 105 s and was reported as unverified. The
prerequisites below are what that check required; they are not a guarantee that it
reproduces on other hardware or with other prompts.

1. A local model server is installed and running by the operator (Ollama or an
   OpenAI-compatible `llama-server`). APEX neither downloads a model nor starts a
   server.
2. A model is already installed and named (for Ollama, `ollama pull <model>` is done by
   the operator; APEX reports `MODEL_NOT_FOUND` if it is missing).
3. `APEX_MODEL_PROVIDER`, `APEX_MODEL_URL`, and `APEX_MODEL_NAME` point at that server
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

- `memory.jsonl`: personal memory records (append-only).
- `knowledge.jsonl`: explicit entity relationships and evidence (append-only).
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

Both filesystem settings are validated on every run, whether or not
`APEX_FILESYSTEM_ROOT` is set, so a mistyped limit is named at startup instead of
lying dormant until the capability is switched on.

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
| `repair locks` | Inspects the task and queue locks and removes only abandoned takeover tokens whose number no live process owns. It never takes a lock, never deletes a lock claim, and refuses while any holder or takeover number is live. A dead claim is taken over by the next normal run. A claim whose number has been recycled by an unrelated process looks live and is refused; resolving that needs the manual check described under Known limitations. |
| `knowledge add --subject <s> --relationship <r> --object <o> [--evidence <e>] [--supersedes <id[,id...]>]` | Stores an explicit relationship triple. User origin only. Optional `--supersedes` retires named conflicting records as historical, without deleting them. |
| `knowledge list [--limit N]` | Lists recent knowledge records with provenance and status. |
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

A request of two or more parts separated by `;` or `then`, where every part is one of
the forms above, runs as a task (see [Tasks](#tasks)). For example:
`calc (2+3)*4; calc 10/2`.

Anything else goes to the model path. With no model configured, APEX says so,
shows any relevant memory it found (without summarising it), and **generates nothing**.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Verified success, or a model answer was produced (reported as unverified) with no proposed action blocked. |
| 1 | Not completed: denied, rejected, failed, not verified, no model, the store is unavailable, or a model answer whose proposed action was denied/failed. |
| 2 | Usage or configuration error. |
| 3 | The operation ran, but its audit record could not be written. The output says so. |

Error lines are presentation, not evidence: each is bounded to one line and
credential-like text in it is redacted. An operation's audit record keeps the
original error message.

## Optional: a local model

No model is bundled, downloaded, or required. APEX talks to a model server you run
yourself, on this machine. Two protocols are supported; the choice is made in the
Model Gateway (`src/model/gateway.js`), and nothing else in APEX knows about either one.

| Server | `APEX_MODEL_PROVIDER` | `APEX_MODEL_URL` example | Endpoints used |
|---|---|---|---|
| Ollama (native API) | `ollama` | `http://127.0.0.1:11434` | `/api/tags`, `/api/chat` |
| llama.cpp `llama-server`, or any OpenAI-compatible local server | `openai` (default) | `http://127.0.0.1:8080` | `/v1/models`, `/v1/chat/completions` |

```bash
# Ollama (after you have pulled the model yourself: ollama pull <model>)
APEX_MODEL_PROVIDER=ollama APEX_MODEL_URL=http://127.0.0.1:11434 APEX_MODEL_NAME=<model> node bin/apex.js chat

# llama.cpp
APEX_MODEL_URL=http://127.0.0.1:8080 node bin/apex.js chat
```

- Only loopback hosts (`127.0.0.1`, `localhost`, `::1`) are accepted by default. A
  remote host needs `APEX_ALLOW_REMOTE_MODEL=1`. URLs with credentials are refused.
- `APEX_MODEL_NAME` is sent with each request. For Ollama it is required; if the named
  model is not installed, APEX reports `MODEL_NOT_FOUND` and the command to run.
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
- Measured on 2026-10-29 with the installed Qwen3-4B GGUF on Windows, a 200-token
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

**Reasoning text in answers (confirmed with Qwen3 GGUF on Ollama 0.35.0).** APEX does
not send a `think` flag: it uses the provider default so that a thinking model puts
reasoning in `message.thinking` and the final answer in `message.content`. Only
`message.content` is shown, stored, or audited; reasoning is never treated as an
answer. Sending `think: false` was not reliable: the installed
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
     (UNVERIFIED)`. Memory and conversation are trimmed to fit about 6000 characters in
     total: the oldest turns and the least relevant memories go first, one at a time,
     and knowledge records go only once those two sections already fit.
     Conflict warnings only refer to other eligible memories retained in that prompt.
   - **Generation** through the Model Gateway. The reply is shown with its status and
     source, and recorded.
4. Model answers are **never** stored as memory automatically. `ask --save-answer` is
   the only way, and it stores the answer as a `model_conclusion`, never as a user fact.
5. Every operation writes an audit record with the retrieved memory ids and prompt
   sizes, not the memory text.

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
  context.js          prompt construction: labelled memory, turns, size budget, system prompt
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
src/verify/
  verifier.js         separate verifier: decides whether a postcondition holds
src/memory/
  jsonl-store.js      append-only JSON Lines with fsync and damage tolerance
  memory-store.js     personal memory: validation, provenance, content hash, retrieval
  conversation-store.js  conversation turns with origin; credential-like text is never stored
src/knowledge/
  knowledge-store.js  entity relationship triples: validation, hashing, conflict detection
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

A bounded manual smoke test against the installed Ollama model was run on 2026-10-31
(one request, about 105 s). A bounded four-request benchmark with a documented
procedure (`benchmarks/run-model-benchmark.mjs`, using the ordinary application path)
was run the same day. Neither is part of this suite; both are reported separately.

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
- **The task lock serializes task changes, not every command.** `task plan`, `run`,
  `resume`, `approve`, `retry` and `cancel` take `tasks.jsonl.lock`; reads (`status`,
  `diagnose`, `task list/show/explain`, `history`) take no lock, and the other stores
  are append-only without a lock of their own. On the tested platform (Windows 11,
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
  until an operator resolves it by hand: confirm that no APEX task run or queue update is
  in progress and that the number belongs to an unrelated process (`Get-Process -Id <pid>`
  on Windows, `ps -p <pid>` on POSIX), then remove `tasks.jsonl.lock` or
  `task-summary-queue.json.lock`. Verify first: running the check is what distinguishes
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
- **Write authority:** Knowledge writes (`knowledge add` / `knowledge.add`) require
  explicit user origin. Model proposals cannot write knowledge.
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
- **Bounded retrieval into model context:** When answering a request on the model path,
  the controller retrieves up to 3 relevant knowledge records by searching the triple
  and evidence. Question words and other low-signal words are ignored, so a question
  does not retrieve a record merely because both contain "what" or "is", and terms are
  weighted by how rare they are in the store, so a distinctive name outranks an
  incidental common word. Records below the relevance threshold stay out of the prompt.
  Injected
  records explicitly state their provenance (`user-supplied fact`
  or `unconfirmed claim`) and conflict status (`[CONFLICTING: another record disagrees]`).
  `knowledge search` keeps its broad matching, because there you asked what matches.
- **Auditability:** Every write operation is recorded in `operations.jsonl` and
  independently verified against the store log.
- **Corrections are never inferred from `remember`.** Repeating `remember` records
  another user fact and leaves conflicting claims unresolved. Use the explicit
  `memory correct` command to select one conflicting record. Corrections are limited to
  one selected record per operation and to the detector's narrow clause patterns;
  previous records remain append-only and continue to be inspectable.
- **Corrupt JSONL logs fail closed and are never rewritten.** `status` and `diagnose`
  report the corrupt-line count and line numbers, and records are not deleted,
  skipped silently, or truncated to make a file parse. Memory, knowledge, and task
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
  26.4.0, in an isolated temporary directory: 760 tests, 758 passed, 0 failed, 2
  skipped (POSIX permission bits are not enforced here; this filesystem rejects control
  characters in file names). The permission-denied path is therefore untested here, and
  earlier milestones were validated on Linux. The test script uses an explicit file
  list so it does not depend on shell globbing.
- Node 22 is the documented runtime; Node 26.4.0 was used for the runs above.

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
