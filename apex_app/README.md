# APEX Local Alpha

APEX (Adaptive Personal Executive eXocortex) is the whole personal cognitive system.
**Local Alpha** is the first runnable vertical slice of it. It is a small, honest
implementation of one workflow:

    request -> retrieve persistent memory -> choose an allowed action (or a model)
            -> authorize -> execute -> verify independently -> record -> restart -> still there

It is not the whole of APEX. It has no world model, planner, voice or UI, and its
model path depends entirely on a backend you configure yourself.

The application is in `apex_app/`, separate from the experimental C++ neural
research under `stark/`. Nothing here depends on that research. Historical STARK
identifiers are preserved there and are not used by this application.

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

Both are plain JSON Lines files you can read and back up. The application never
deletes or rewrites them.

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

`node bin/apex.js diagnose` is the read-only preflight. It prints the effective
settings above (with credential-like text redacted), the state of every store,
confirmed defects and suspicions, and recovery guidance. It does not create a
session, write or repair a store, run a task, or contact the model.
`diagnose --model` (or `status --model`) adds a connectivity check against
`/api/tags` or `/v1/models`; it never runs inference. Without `--model`, model
availability is reported as "not checked", not as healthy.

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
| `task run <id>` | Runs a pending task step by step. Stops at the first failed or uncertain step, and pauses before a write that needs approval. |
| `task approve <id>` | Approves a model-proposed plan. `task approve <id> --step <stepId>` approves one write step that is waiting for it. |
| `task resume <id>` | Continues a paused task. A completed step is never run again. |
| `task retry <id> <stepId>` | Retries one failed or uncertain step, only if it is read-only. |
| `task cancel <id>` | Cancels a task that has not finished. Steps that have not run are cancelled. |
| `knowledge add --subject <s> --relationship <r> --object <o> [--evidence <e>]` | Stores an explicit relationship triple. User origin only. |
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
| 0 | Verified success, or a model answer was produced (reported as unverified). |
| 1 | Not completed: denied, rejected, failed, not verified, no model, or the store is unavailable. |
| 2 | Usage or configuration error. |
| 3 | The operation ran, but its audit record could not be written. The output says so. |

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
`EMPTY_RESPONSE` with a message that the budget was likely spent on reasoning and
suggests raising `APEX_MODEL_MAX_TOKENS` or using a model that can skip thinking. No
partial reasoning is shown as an answer, and no model turn is stored. Observed on
2026-10-29 with a 256-token budget: one request produced the answer `391` after 251
generated tokens; another produced only reasoning and no answer, which is reported as
that failure rather than as text.

Measured on 2026-10-29 after switching to the provider default: a warm two-turn run
through APEX took 35.4 s and 41.5 s (APEX overhead 26-46 ms), both
`done_reason: "stop"` with clean final answers and no reasoning in the display or the
stored turns. A cold direct request took 63.6 s including 16.4 s of model loading,
0.5 s of prompt evaluation, and 46.7 s generating 251 tokens (about 5.4 tokens/s).

**Verification status.** The automated tests use local stand-in servers that copy the
documented request and response shapes of both protocols. They check protocol
handling and failure classification only. They say nothing about answer quality, and
no test in this repository runs a real model. See the report that accompanies this
milestone for what was and was not run against a real server.

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
   or without a model. A model never executes them.
3. Any other request goes to the model path:
   - **Retrieval**: the personal memory is searched for the request (words, word
     forms, and close misspellings; see Architecture). Only records that score above
     a threshold, are not private, and do not look like credentials are placed in the
     prompt.
   - **Conversation**: the last `APEX_CONTEXT_TURNS` turns of the current session are
     included. Earlier model answers are labelled `UNVERIFIED`.
   - **Prompt**: memory and conversation are labelled as data, not instructions. Each
     memory item shows its provenance: `user-provided fact` or `model conclusion
     (UNVERIFIED)`. Memory and conversation are trimmed to fit about 6000 characters in
     total: the oldest turns and the least relevant memories go first, one at a time.
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
automatically.

**Interruptions.** If the process stops while a step is running, the next start finds
that step's outcome unknown. It is marked `uncertain`, never `completed`, and it is
not run again. A read-only uncertain step can be retried on request. A write step
cannot be; cancel the task instead.

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

**Limits.**
- Free-text planning recognises only the request forms above and the `;` and `then`
  separators. Anything else needs a model to propose a plan.
- Ordinary `remember` content is part of a step's input, so it is kept in `tasks.jsonl`
  as well as in memory. Private content is not.
- Steps run one after another, in dependency order. There is no parallelism and no time
  limit on a step.
- A lock file (`tasks.jsonl.lock`) stops two processes from running tasks at once. A
  second process is refused, not queued. A lock left by a process that is no longer
  running is removed.
- Every task read replays the whole task log. That is fine at this scale; it is not a
  design for many tasks.
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
src/util.js           shared helpers: truncation, redaction of content fields, rounding
src/controller/
  controller.js       Cognitive Controller: the workflow and the final status rule
  context.js          prompt construction: labelled memory, turns, size budget, system prompt
  router.js           deterministic capability table (action pattern -> action)
  proposals.js        parser for model output; proposals are untrusted requests
  task-runner.js      runs a task's steps through the controller's action path; owns task transitions
src/tasks/
  model.js            task and step states, allowed transitions, dependency checks, event reducer
  store.js            tasks.jsonl: validated appends, replay, and the single-process lock
  planner.js          deterministic plans and strict model-plan checks; nothing here runs an action
  format.js           plain-text rendering of tasks, shared by replies and the CLI
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
- A model proposal (`PROPOSE_ACTION {"action": ..., "input": {...}}`) is only a
  request. It goes through the same policy as a user request. Model output is
  never executed as code.
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

A bounded manual smoke test against the installed Ollama model was run outside this
suite; it is not an automated regression test and is reported separately.

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

Other critical paths: store unavailable (`memory.test.js`, `cli.test.js` exit codes),
damaged data lines (`memory.test.js`), tampered content detection, configuration
validation (`gateway.test.js`), and the verifier-independence check
(`actions.test.js`).

## Known limitations

- **Retrieval is lightweight lexical matching, not semantic search.** It matches words,
  simple word forms, and close misspellings (character-trigram similarity), all local.
  It does not understand meaning: a true paraphrase that shares no word forms with the
  stored record will be missed. Retrieval quality is not measured beyond these tests.
- **Contradiction detection is deliberately narrow and heuristic.** It compares simple
  “subject is value” / “subject called value” clauses with the same normalized subject.
  It can miss paraphrases, negation, or complex temporal/contextual relationships, and
  different values may still be compatible in context. A longer value that merely
  elaborates the shorter one is not flagged. Warnings preserve claims; they do not
  determine which claim is true. Exact duplicate retrieval hits collapse to the newest
  matching record, while distinct contents remain separate.
- **Correction resolves only its explicitly selected pair.** The new record links to the
  selected old record, which remains visible as `superseded` when no other conflict
  remains. Conflicts with any other claims stay unresolved; superseded history is not
  sent as an active fact in model context.

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
- **Bounded retrieval into model context:** When answering requests, the controller
  retrieves up to 3 relevant knowledge records via keyword search over the triple
  and evidence. Injected records explicitly state their provenance (`user-supplied fact`
  or `unconfirmed claim`) and conflict status (`[CONFLICTING: another record disagrees]`).
- **Auditability:** Every write operation is recorded in `operations.jsonl` and
  independently verified against the store log.
- **Corrections are never inferred from `remember`.** Repeating `remember` records
  another user fact and leaves conflicting claims unresolved. Use the explicit
  `memory correct` command to select one conflicting record. Corrections are limited to
  one selected record per operation and to the detector's narrow clause patterns;
  previous records remain append-only and continue to be inspectable.
- **Corrupt memory logs fail closed for search and list.** `status` still reports the
  corrupt-line count, and records are not deleted or rewritten. Repair is not automatic.
- **Answer quality depends entirely on the model you run.** APEX checks the protocol,
  not the truth of what a model says. Model answers are shown as unverified.
- **Routing is a fixed pattern table.** Requests outside the table go to the model
  path. Without a model they get `model_unavailable`.
- **Verification of `memory.search` / `memory.list`** re-reads the same store with
  the same code, so it catches inconsistency and tampering, not a shared bug in that
  store logic.
- **A model conclusion is never verified.** It is reported as `verification_unavailable`.
- **Concurrency:** writes are append-only with fsync, but two processes writing at the
  same instant are not coordinated. Run one `ask` at a time.
- **Single-user, local only.** No authentication, encryption, or sync. Anyone with
  read access to the data directory can read the memory.
- **Audit content:** the `request` and model `output` fields contain your text. The
  audit log is not redacted except for memory-write payloads and credential-like
  requests. The audit records memory ids and prompt sizes, not the memory text sent to
  the model. A model's own answer is recorded as output, and it could repeat memory.
- **Conversation history** is replayed as summaries and text, limited to
  `APEX_CONTEXT_TURNS` turns. There is no summarisation of older history.
- **Context size:** a request that exceeds the model's context window is reported as
  `CONTEXT_TOO_LARGE`; APEX does not know a model's window in advance.
- **Filesystem inspection is read-only and single-root.** One directory, no recursion,
  no follow-symlink, no globbing, no search. Symlinks are refused even when they point
  inside the root, which is stricter than necessary but easy to reason about.
- **Filesystem verification re-reads the same path with the same code.** It catches a
  changed file, a changed directory, a fabricated result, and a path that has escaped
  the root, but not a bug shared by both reads. A file that changes and changes back
  between the two reads is not detected.
- **Windows:** the full suite for this milestone was run on Windows 11 with Node
  26.4.0 (164 pass, 0 fail, 1 skipped: POSIX permission bits). The permission-denied
  path is therefore untested here, and earlier milestones were validated on Linux. The
  test script uses an explicit file list so it does not depend on shell globbing.
- Node 22 is the documented runtime; Node 26.4.0 was used for the runs above.

## Future learning interface (not implemented)

Operation records carry the request, the selected capability, the authorization
decision, execution and verification outcomes, and the retrieval references. That is
the outcome data a later learning component would consume. **This milestone does
not learn.** Storing logs is not learning, and nothing here adjusts behaviour from
past outcomes.

## Governance

This is a bounded implementation under the Local Alpha mission. It does not declare
M0 accepted, change G7, M0, or M1 gate states, or claim M1 is unlocked. It is not
full APEX completion and is not published or merged. The status documents elsewhere
in the repository (for example `docs/IMPLEMENTATION_STATUS.md`) were not changed.
