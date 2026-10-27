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

Windows 11: the code uses only `node:` built-ins and `path.join`, so it should run
under Node 22 for Windows. **This has not been tested on Windows.** Treat Windows
as unverified until someone runs `npm test` there.

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
- `operations.jsonl`: one audit record per operation (append-only).

Both are plain JSON Lines files you can read and back up. The application never
deletes or rewrites them.

## Commands

| Command | What it does |
|---|---|
| `status` | Application identity, memory and operation counts, model status. Makes no model call. |
| `ask <request>` | Runs the full Cognitive Controller workflow for a request and records it. |
| `ask --save-answer <request>` | As `ask`, and also stores a model answer as a `model_conclusion`. Only with this explicit flag. |
| `history [--limit N]` | Lists recent operation records. |
| `help`, `version` | Usage and version. |

Request forms recognised without a model:

- `remember that <fact>` / `remember <fact>`: store a user fact (a write action).
- `recall <query>`, `search memory for <query>`, `what do you know about <query>`: keyword search.
- `list memory` / `show memory`: most recent records.
- `calc <expression>`, `calculate ...`, or `what is 2+3*4?`: plain arithmetic (`+ - * /`, parentheses).
- `status`: application status.

Anything else goes to the model path. With no model configured, APEX says so and
**generates nothing**.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Verified success, or a model answer was produced (reported as unverified). |
| 1 | Not completed: denied, rejected, failed, not verified, no model, or the store is unavailable. |
| 2 | Usage or configuration error. |
| 3 | The operation ran, but its audit record could not be written. The output says so. |

## Optional: a local model

No model is bundled, downloaded, or required. To use one, run a local server that
exposes an OpenAI-compatible `/v1/chat/completions` endpoint (for example Ollama or
the llama.cpp server), then:

```bash
APEX_MODEL_URL=http://127.0.0.1:11434 APEX_MODEL_NAME=<your-model> node bin/apex.js status
APEX_MODEL_URL=http://127.0.0.1:11434 APEX_MODEL_NAME=<your-model> node bin/apex.js ask what is the capital of France?
```

- Only loopback hosts (`127.0.0.1`, `localhost`, `::1`) are accepted by default. A
  remote host needs `APEX_ALLOW_REMOTE_MODEL=1`. URLs with credentials are refused.
- `APEX_MODEL_TIMEOUT_MS` sets the call timeout (default 30000).
- **Not tested against a real model in this milestone.** The adapter is covered by
  tests against a local stub server, which imitates the endpoint's shape. Real
  model behaviour is UNVERIFIED.

## Architecture (as implemented)

```
bin/apex.js           entry point
src/cli.js            command line; maps results to exit codes
src/app.js            composition root (wires the components)
src/config.js         environment-variable configuration
src/controller/
  controller.js       Cognitive Controller: the workflow and the final status rule
  router.js           deterministic capability table (action pattern -> action)
  proposals.js        parser for model output; proposals are untrusted requests
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
src/operations/
  operation-log.js    audit records
src/model/
  gateway.js          Model Gateway: replaceable backend; NoBackend; OpenAI-compatible adapter
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
| `memory.save_conclusion` | **write** | user | `content`, `operationId`, `backend` | record exists; hash matches; provenance is `model` / `model_conclusion` |
| `calc.evaluate` | read | user, model | `expression` (digits, `+ - * / ( )`, max 200 chars) | a different algorithm (shunting-yard) gives the same value |

### Outcomes

Each action step and each operation has one status:

| Status | Meaning |
|---|---|
| `success_verified` | The action ran and the verifier confirmed the postcondition. **The only status that means success.** |
| `execution_failed` | The action or model call failed. Verification was not run. |
| `verification_failed` | The action ran, but the verifier found the postcondition does not hold. Never reported as success. |
| `verification_unavailable` | No verifier exists, or the verifier could not read its evidence. For a model answer, this is the honest status: a model conclusion has no independent check. |
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

This runs 63 tests across five files with the built-in runner. They use only temporary
directories under the OS temp folder (`apex-test-*`) and remove them afterwards.
Tests never read or write `~/.apex`, and CLI tests point `HOME`/`USERPROFILE` at the
temp directory too.

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

Other critical paths: store unavailable (`memory.test.js`, `cli.test.js` exit codes),
damaged data lines (`memory.test.js`), tampered content detection, configuration
validation (`gateway.test.js`), and the verifier-independence check
(`actions.test.js`).

## Known limitations

- **Retrieval is keyword overlap**, not semantic search. It finds records that share
  words with the request (with a trivial plural stem), so paraphrases can be missed.
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
  audit log is not redacted except for memory-write payloads.
- **Windows:** not tested (see Requirements). The test script uses an explicit file
  list so it does not depend on shell globbing.
- Node 22 is the only verified runtime.

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
